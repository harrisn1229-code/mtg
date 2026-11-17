// overrides-1.js — hand-written per-card overrides, part 1 (cards A–L), keyed by exact card name.
// Each entry is either a CardDef fragment merged over the parsed def, or { patch(def) { ... } }.
// See SPEC.md section 7 and game/overrides.js for the merge rules.
//
// Conventions in this file (and overrides-2.js, which imports { H } from here):
//  * patch(def) always returns a NEW def whose `unparsed` is a NEW array (via `out()`), so overrides.js keeps exactly
//    the lines we leave there (an empty array = fully handled).
//  * Scripts are `function*(g, ctx)`; every call to a `$` generator is `yield* g.xxx$(...)`; no Math.random / Date
//    (use g.rng()).
//  * Engine-dependent extras are gated behind H.CAPS so nothing speculative runs against an engine that lacks it.
//    Flip a flag to true once the matching request under "Override agent: engine requests" in SPEC-NOTES.md is done.

/** Capabilities the engine does not have yet (see SPEC-NOTES.md "Override agent: engine requests"). */
const CAPS = {
  lethalByPower: true, // Zilortha: static {type:"lethalByPower"} honoured by SBA + combat damage assignment
  compareCond: true, // Cond {type:"compare", a:Amount, op, b:Amount} + Amounts {startingLife:true}, {lifeGainedThisTurn:Ref}
  castFree: true, // g.castFree$(p, obj, opts) provided by the engine (a local fallback is used otherwise)
  cantGainLife: true, // static {type:"cantGainLife", who:"opponent"}
};

/** New def with `patch` merged in and exactly `unparsed` lines left (default: none). */
const out = (def, patch = {}, unparsed = []) => ({ ...def, ...patch, unparsed: [...unparsed] });
/** def.abilities + extra abilities. */
const plus = (def, ...abs) => [...(def.abilities || []), ...abs];
/** def.spell merged with changes. */
const spellOf = (def, ch) => ({ ...(def.spell || {}), ...ch });
/** Lines of def.unparsed NOT containing any of the given substrings. */
const without = (def, ...subs) => (def.unparsed || []).filter((l) => !subs.some((s) => l.includes(s)));

const T = (i = 0) => ({ ref: "target", i });
const PERMANENT_TYPES = ["artifact", "battle", "creature", "enchantment", "land", "planeswalker"];
const isPermanentC = (c) => !!c && (c.types || []).some((t) => PERMANENT_TYPES.includes(t));
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const topCard = (g, p) => { const pl = g.state.players[p]; return pl.library.length ? g.state.objects[pl.library[pl.library.length - 1]] : null; };

/**
 * Cast `o` (a card in exile/hand) without paying its mana cost, now, during resolution of the current ability/spell.
 * Returns true if it was put on the stack. Uses the engine's g.castFree$ if it has one, else a local equivalent of cast$.
 */
function* castFree$(g, p, o) {
  if (typeof g.castFree$ === "function") return yield* g.castFree$(p, o, {});
  const st = g.state;
  const fd = o.def;
  if (!o || o.zone === "gone" || !fd || fd.types.includes("land") || fd.cost == null) return false;
  const ctx = { source: o, you: p, x: 0 };
  let modes = null, modeTargets = null;
  if (fd.spell?.modes) {
    const r = yield* g.chooseModes$(p, fd.spell.modes, o, ctx);
    if (!r) return false;
    modes = r.modes; modeTargets = r.modeTargets;
  }
  const specs = g.targetSpecsFor(o, fd, "free");
  let targets = [];
  if (specs.length) { const t = yield* g.chooseTargets$(p, specs, o, ctx); if (!t) return false; targets = t; }
  const add = fd.additionalCost;
  if (add) {
    if (!g.canPayCost(p, add, o, { ...ctx, x: 0 })) return false;
    if (!(yield* g.payCost$(p, add, ctx))) return false;
  }
  const pl = st.players[p];
  g.removeFromZone(o);
  o.zone = "stack";
  st.stack.push(o.id);
  o.controller = p;
  o.face = 0;
  o.castVariant = "free";
  o.x = 0; o.kicked = false;
  o.onAdventure = false; o.mayPlay = null; o.cmdPending = false;
  o._targets = targets; o._targetSpecs = specs; o._modes = modes; o._modeTargets = modeTargets;
  o._sacrificed = ctx.sacrificed || [];
  o.targets = [...targets.flat(), ...(modeTargets ? modeTargets.flat(2) : [])];
  o.ts = ++st.ts;
  o.c = g.baseC(o);
  g.markDirty();
  st.spellsThisTurn++;
  const tgt = o.targets.length ? ` targeting ${o.targets.map((id) => g.nameOf(id)).join(", ")}` : "";
  g.emit({ t: "cast", obj: o.id, player: p, targets: [...o.targets], from: "exile", variant: "free", text: `${pl.name} casts ${o.c.name} without paying its mana cost${tgt}` });
  g.fireTrigger({ type: "cast", obj: o, player: p });
  g.afterTargeting(o);
  return true;
}

/** A token Jace for "Empower Jace N": put N loyalty counters on a Jace token you control, creating it first if needed. */
const JACE_TOKEN = {
  name: "Jace", types: ["planeswalker"], subtypes: ["jace"], colors: ["U"],
  abilities: [
    { kind: "activated", loyalty: true, sorcery: true, limit: "turn", cost: { loyalty: -1 }, effects: [{ op: "surveil", amount: 1 }], text: "[−1]: Surveil 1." },
    { kind: "activated", loyalty: true, sorcery: true, limit: "turn", cost: { loyalty: -3 }, effects: [{ op: "draw", who: "you", amount: 1 }], text: "[−3]: Draw a card." },
  ],
};
function* empowerJace$(g, ctx, n) {
  if (!(n > 0)) return;
  let jace = g.find({ types: ["planeswalker"], subtypes: ["jace"], token: true, controller: "you" }, ctx)[0];
  if (!jace) jace = g.createToken(ctx.you, JACE_TOKEN, 1, { source: ctx.source })[0];
  if (jace) g.addCounters(jace, "loyalty", n);
}

/** God-Eternal triggers: "When X dies or is put into exile from the battlefield, you may put it into its owner's library third from the top." */
function* tuckThird$(g, ctx) {
  const o = g.obj(ctx.source?.id);
  if (!o || (o.zone !== "graveyard" && o.zone !== "exile")) return;
  const yes = yield* g.confirm$(ctx.you, `Put ${o.c.name} into its owner's library third from the top?`, o.id);
  if (yes) yield* g.moveTo$(o, "library", { position: 3 });
}
const godEternalTuck = (name, pron) => [
  { kind: "triggered", on: { event: "dies", who: "self" }, run: tuckThird$, text: `When ${name} dies, you may put ${pron} into its owner's library third from the top.` },
  { kind: "triggered", on: { event: "leaves", who: "self", to: "exile" }, run: tuckThird$, text: `When ${name} is put into exile from the battlefield, you may put ${pron} into its owner's library third from the top.` },
];

export const H = { CAPS, out, plus, spellOf, without, T, isPermanentC, cap, topCard, castFree$, empowerJace$, tuckThird$, godEternalTuck, PERMANENT_TYPES };

export default {
  // ------------------------------------------------------------------------------------------------ A
  "Anger of the Gods": {
    patch(def) {
      return out(def, { spell: spellOf(def, {
        effects: [],
        run: function* (g, ctx) {
          const hit = [];
          for (const o of g.find({ types: ["creature"] }, ctx)) if (g.dealDamage(ctx.source, o.id, 3) > 0) hit.push(o);
          // "If a creature dealt damage this way would die this turn, exile it instead." — a replacement effect for the rest of the turn
          if (hit.length) g.addEffect({ type: "exileInsteadOfDying" }, ctx, { objIds: hit.map((o) => o.id), until: "endOfTurn" });
          g.markDirty(); g.refresh();
        },
      }) });
    },
  },

  "Arcane Denial": {
    patch(def) {
      return out(def, { spell: spellOf(def, {
        targets: [{ what: "spell", zone: "stack" }],
        effects: [],
        run: function* (g, ctx) {
          const tgt = g.obj((ctx.targets[0] || [])[0]);
          const victim = tgt ? tgt.controller : null;
          yield* g.runEffects$([{ op: "counter", what: T(0) }], ctx);
          const you = ctx.you;
          // Both draws happen "at the beginning of the next turn's upkeep".
          g.delayed({ event: "beginStep", step: "upkeep", whose: "each" }, function* (g2) {
            if (victim != null && !g2.state.players[victim].lost) {
              const n = yield* g2.number$(victim, "Arcane Denial: draw up to two cards", 0, 2, ctx.source?.id);
              if (n > 0) g2.draw(victim, n);
            }
            g2.draw(you, 1);
          }, ctx);
        },
      }) });
    },
  },

  "Archfiend of Depravity": {
    patch(def) {
      return out(def, { abilities: plus(def, {
        kind: "triggered", on: { event: "beginStep", step: "end", whose: "opponent" },
        text: "At the beginning of each opponent's end step, that player chooses up to two creatures they control, then sacrifices the rest.",
        run: function* (g, ctx) {
          const p = ctx.event?.player;
          if (p == null) return;
          const mine = g.find({ types: ["creature"] }, ctx).filter((o) => o.controller === p);
          if (mine.length <= 2) return;
          // choosing which (at most two) creatures to keep == choosing which of the others to sacrifice
          const gone = yield* g.chooseObjects$(p, mine, { prompt: `Archfiend of Depravity: choose creatures to sacrifice (you keep at most two — sacrifice at least ${mine.length - 2})`, min: mine.length - 2, max: mine.length, reason: "sacrifice", source: ctx.source?.id });
          for (const o of gone) g.sacrifice(o);
        },
      }) });
    },
  },

  // ------------------------------------------------------------------------------------------------ B
  "Balor": {
    patch(def) {
      // 1v1: "each mode must target a different player" leaves exactly one mode (one opponent to target).
      const modes = {
        min: 1, max: 1,
        modes: [
          { text: "Target opponent draws three cards, then discards three cards at random.", targets: [{ what: "opponent" }],
            effects: [{ op: "draw", who: T(0), amount: 3 }, { op: "discard", who: T(0), amount: 3, random: true }] },
          { text: "Target opponent sacrifices a nontoken artifact of their choice.", targets: [{ what: "opponent" }],
            effects: [{ op: "sacrifice", who: T(0), filter: { types: ["artifact"], token: false }, amount: 1 }] },
          { text: "This creature deals damage to target opponent equal to the number of cards in their hand.", targets: [{ what: "opponent" }],
            effects: [{ op: "damage", amount: { handSize: T(0) }, to: T(0) }] },
        ],
      };
      const text = "Whenever this creature attacks or dies, choose one or more. Each mode must target a different player.";
      return out(def, { abilities: plus(def,
        { kind: "triggered", on: { event: "attacks", who: "self" }, modes, effects: [], text },
        { kind: "triggered", on: { event: "dies", who: "self" }, modes, effects: [], text },
      ) });
    },
  },

  "Bojuka Bog": {
    patch(def) {
      return out(def, { abilities: plus(def, {
        kind: "triggered", on: { event: "enters", who: "self" }, targets: [{ what: "player" }], text: "When this land enters, exile target player's graveyard.",
        run: function* (g, ctx) {
          const id = (ctx.targets[0] || [])[0];
          if (!id) return;
          const cards = g.find({ zone: "graveyard", owner: id }, ctx);
          for (const o of cards) g.exile(o);
          g.log(`${g.nameOf(id)}'s graveyard is exiled (${cards.length} card${cards.length === 1 ? "" : "s"})`);
        },
      }) });
    },
  },

  // ------------------------------------------------------------------------------------------------ C
  "Chandra's Ignition": {
    patch(def) {
      return out(def, { spell: spellOf(def, {
        targets: [{ what: { types: ["creature"], controller: "you" } }], effects: [],
        run: function* (g, ctx) {
          const src = g.obj((ctx.targets[0] || [])[0]);
          if (!src || src.zone !== "battlefield") return;
          const n = Math.max(0, src.c.power | 0);
          const victims = g.find({ types: ["creature"] }, ctx).filter((o) => o.id !== src.id);
          for (const o of victims) g.dealDamage(src, o.id, n);
          for (const p of g.opponentsOf(ctx.you)) g.dealDamage(src, "P" + p, n);
        },
      }) });
    },
  },

  "Chaos Warp": {
    patch(def) {
      return out(def, { spell: spellOf(def, {
        targets: [{ what: { types: ["permanent"] } }], effects: [],
        run: function* (g, ctx) {
          const o = g.obj((ctx.targets[0] || [])[0]);
          if (!o || o.zone !== "battlefield") return;
          const owner = o.owner;
          yield* g.moveTo$(o, "library", { position: "shuffle" });
          const top = topCard(g, owner);
          if (!top) return;
          g.emit({ t: "reveal", objs: [top.id], player: owner, text: `${g.state.players[owner].name} reveals ${top.c.name}` });
          if (isPermanentC(top.c)) yield* g.moveTo$(top, "battlefield", { controller: owner });
        },
      }) });
    },
  },

  "Crippling Fear": {
    patch(def) {
      return out(def, { spell: spellOf(def, {
        effects: [],
        run: function* (g, ctx) {
          const type = yield* g.chooseCreatureType$(ctx.you, ctx.source, ctx.source?.def);
          yield* g.runEffects$([{ op: "pump", what: { ref: "all", filter: { types: ["creature"], notSubtypes: [type] } }, power: -3, toughness: -3 }], ctx);
        },
      }) });
    },
  },

  // ------------------------------------------------------------------------------------------------ D
  "Dig Through Time": {
    patch(def) {
      return out(def, { spell: spellOf(def, { effects: [{ op: "lookTop", amount: 7, take: 2, rest: "bottom" }] }) }); // the bottom order is asked (any order)
    },
  },

  "Dreadful as the Storm": {
    patch(def) {
      return out(def, { spell: spellOf(def, {
        targets: [{ what: { types: ["creature"] } }],
        effects: [
          { op: "until", until: "endOfTurn", static: { type: "setBasePT", affects: T(0), power: 5, toughness: 5 } },
          { op: "ringTempts", who: "you" },
        ],
      }) });
    },
  },

  "Drown in Ichor": {
    patch(def) {
      return out(def, { spell: spellOf(def, {
        targets: [{ what: { types: ["creature"] } }],
        effects: [{ op: "pump", what: T(0), power: -4, toughness: -4 }, { op: "proliferate" }],
      }) });
    },
  },

  // ------------------------------------------------------------------------------------------------ E
  "Etali, Primal Storm": {
    patch(def) {
      return out(def, { abilities: plus(def, {
        kind: "triggered", on: { event: "attacks", who: "self" },
        text: "Whenever Etali attacks, exile the top card of each player's library, then you may cast any number of spells from among those cards without paying their mana costs.",
        run: function* (g, ctx) {
          const exiled = [];
          for (const p of g.apnap(g.state.players.filter((q) => !q.lost).map((q) => q.idx))) {
            const top = topCard(g, p);
            if (top && g.moveObj(top, "exile")) exiled.push(top);
          }
          let pool = exiled.filter((o) => o.zone === "exile" && !o.def.types.includes("land") && o.def.cost != null);
          while (pool.length && !g.over) {
            const [pick] = yield* g.chooseObjects$(ctx.you, pool, { prompt: "Etali: cast one of these exiled spells without paying its mana cost? (choose none to stop)", min: 0, max: 1, reason: "generic", source: ctx.source?.id });
            if (!pick) break;
            pool = pool.filter((o) => o !== pick);
            yield* castFree$(g, ctx.you, pick);
          }
        },
      }) });
    },
  },


  // ------------------------------------------------------------------------------------------------ F
  "Fact or Fiction": {
    patch(def) {
      return out(def, { spell: spellOf(def, {
        effects: [],
        run: function* (g, ctx) {
          const you = ctx.you;
          const pl = g.state.players[you];
          const n = Math.min(5, pl.library.length);
          if (!n) return;
          const cards = pl.library.slice(-n).reverse().map((id) => g.state.objects[id]);
          g.emit({ t: "reveal", objs: cards.map((o) => o.id), player: you, text: `${pl.name} reveals ${cards.map((o) => o.c.name).join(", ")}` });
          const opp = g.opponentsOf(you)[0];
          const sep = opp == null ? you : opp;
          const pile1 = yield* g.chooseObjects$(sep, cards, { prompt: "Fact or Fiction: choose the cards for pile 1 (the rest form pile 2)", min: 0, max: cards.length, reason: "generic", source: ctx.source?.id });
          const pile2 = cards.filter((o) => !pile1.includes(o));
          const list = (l) => (l.length ? l.map((o) => o.c.name).join(", ") : "(empty)");
          const [pick] = yield* g.choose$(you, { prompt: "Fact or Fiction: choose a pile to put into your hand (the other goes to your graveyard)", min: 1, max: 1, reason: "generic", source: ctx.source?.id,
            options: [{ id: "p1", label: `Pile 1: ${list(pile1)}`, type: "text" }, { id: "p2", label: `Pile 2: ${list(pile2)}`, type: "text" }] });
          const [toHand, toGy] = pick && pick.id === "p2" ? [pile2, pile1] : [pile1, pile2];
          for (const o of toHand) yield* g.moveTo$(o, "hand", {});
          for (const o of toGy) yield* g.moveTo$(o, "graveyard", {});
        },
      }) });
    },
  },

  "Flow State": {
    patch(def) {
      const both = { type: "and", all: [
        { type: "count", filter: { types: ["instant"], zone: "graveyard", owner: "you" }, op: ">=", n: 1 },
        { type: "count", filter: { types: ["sorcery"], zone: "graveyard", owner: "you" }, op: ">=", n: 1 },
      ] };
      return out(def, { spell: spellOf(def, { effects: [{ op: "if", cond: both,
        then: [{ op: "lookTop", amount: 3, take: 2, rest: "bottom" }],
        else: [{ op: "lookTop", amount: 3, take: 1, rest: "bottom" }] }] }) });
    },
  },

  // ------------------------------------------------------------------------------------------------ G
  "Gandalf, Friend of the Shire": {
    patch(def) {
      return out(def, { abilities: plus(def,
        { kind: "static", effect: { type: "castAsFlash" }, text: "You may cast sorcery spells as though they had flash." },
        { kind: "triggered", on: { event: "ringTempts", who: "you" }, condition: { type: "event", filter: { other: true, types: ["creature"] } },
          effects: [{ op: "draw", who: "you", amount: 1 }], text: "Whenever the Ring tempts you, if you chose a creature other than Gandalf as your Ring-bearer, draw a card." },
      ) });
    },
  },

  "Ghostly Flicker": {
    patch(def) {
      return out(def, { spell: spellOf(def, {
        targets: [{ what: { types: ["artifact", "creature", "land"], controller: "you" }, min: 2, max: 2 }],
        effects: [],
        run: function* (g, ctx) {
          const objs = (ctx.targets[0] || []).map((id) => g.obj(id)).filter((o) => o && o.zone === "battlefield");
          const gone = [];
          for (const o of objs) if (yield* g.moveTo$(o, "exile", {})) gone.push(o);
          for (const o of gone) if (o.zone === "exile") yield* g.moveTo$(o, "battlefield", { controller: ctx.you });
        },
      }) });
    },
  },

  "God-Eternal Bontu": {
    patch(def) {
      return out(def, { abilities: plus(def,
        { kind: "triggered", on: { event: "enters", who: "self" }, text: "When God-Eternal Bontu enters, sacrifice any number of other permanents, then draw that many cards.",
          run: function* (g, ctx) {
            const others = g.find({ types: ["permanent"], controller: "you", other: true }, ctx);
            if (!others.length) return;
            const picked = yield* g.chooseObjects$(ctx.you, others, { prompt: "God-Eternal Bontu: sacrifice any number of other permanents, then draw that many cards", min: 0, max: others.length, reason: "sacrifice", source: ctx.source?.id });
            let n = 0;
            for (const o of picked) if (g.sacrifice(o)) n++;
            if (n) g.draw(ctx.you, n);
          } },
        ...godEternalTuck("God-Eternal Bontu", "her"),
      ) });
    },
  },

  "God-Eternal Oketra": {
    patch(def) { return out(def, { abilities: plus(def, ...godEternalTuck("God-Eternal Oketra", "it")) }); },
  },


  // ------------------------------------------------------------------------------------------------ H
  "Heliod, Sun-Crowned": {
    patch(def) {
      const line = "As long as your devotion to white is less than five, Heliod isn't a creature.";
      if (!CAPS.compareCond) return out(def, {}, [line]);
      return out(def, { abilities: plus(def, { kind: "static", effect: { type: "asType", affects: "self", setTypes: ["enchantment"] },
        condition: { type: "compare", a: { devotion: ["W"] }, op: "<", b: 5 }, text: line }) });
    },
  },

  // ------------------------------------------------------------------------------------------------ I

  // ------------------------------------------------------------------------------------------------ J
  "Jeska's Will": {
    patch(def) {
      return out(def, { spell: spellOf(def, {
        effects: [],
        modes: {
          min: 1, max: 1, maxIf: { cond: { type: "controlCommander" }, max: 2 },
          modes: [
            { text: "Add {R} for each card in target opponent's hand.", targets: [{ what: "opponent" }],
              effects: [{ op: "addMana", mana: { color: "R", n: { handSize: T(0) } } }] },
            { text: "Exile the top three cards of your library. You may play them this turn.", effects: [{ op: "exileTop", who: "you", amount: 3, until: "endOfTurn" }] },
          ],
        },
      }) });
    },
  },

  // ------------------------------------------------------------------------------------------------ K
  "Kari Zev's Expertise": {
    patch(def) {
      return out(def, { spell: spellOf(def, { effects: [...def.spell.effects, {
        run: function* (g, ctx) {
          const pl = g.state.players[ctx.you];
          const cands = pl.hand.map((id) => g.state.objects[id]).filter((o) => !o.def.types.includes("land") && o.def.cost != null && o.c.cmc <= 2 && o.id !== ctx.source?.id);
          if (!cands.length) return;
          const [pick] = yield* g.chooseObjects$(ctx.you, cands, { prompt: "Kari Zev's Expertise: you may cast a spell with mana value 2 or less from your hand without paying its mana cost", min: 0, max: 1, reason: "generic", source: ctx.source?.id });
          if (pick) yield* castFree$(g, ctx.you, pick);
        },
      }] }) });
    },
  },

  // ------------------------------------------------------------------------------------------------ L
  "Lord of the Nazgûl": {
    patch(def) {
      return out(def, { abilities: [
        { kind: "static", effect: { type: "pump", affects: { subtypes: ["wraith"], controller: "you" }, power: 0, toughness: 0, keywords: [{ protection: ["ring-bearers"] }] },
          text: "Wraiths you control have protection from Ring-bearers." },
        { kind: "triggered", on: { event: "cast", who: "you", filter: { types: ["instant", "sorcery"] } },
          text: "Whenever you cast an instant or sorcery spell, create a 3/3 black Wraith creature token with menace. Then if you control nine or more Wraiths, Wraiths you control have base power and toughness 9/9 until end of turn.",
          effects: [
            { op: "createToken", who: "you", amount: 1, token: { name: "Wraith", types: ["creature"], subtypes: ["wraith"], colors: ["B"], power: 3, toughness: 3, keywords: { menace: true } } },
            { op: "if", cond: { type: "control", filter: { subtypes: ["wraith"], controller: "you" }, op: ">=", n: 9 },
              then: [{ op: "until", until: "endOfTurn", static: { type: "setBasePT", affects: { ref: "all", filter: { subtypes: ["wraith"], controller: "you" } }, power: 9, toughness: 9 } }] },
          ] },
      ] });
    },
  },
};
