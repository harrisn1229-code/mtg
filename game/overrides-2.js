// overrides-2.js — hand-written per-card overrides, part 2 (cards M–Z), keyed by exact card name.
// See overrides-1.js for the conventions (H helpers, CAPS gating, patch() returning a new def with a new `unparsed` array).
import { H } from "./overrides-1.js";

const { CAPS, out, plus, spellOf, without, T, castFree$, empowerJace$ } = H;

const shuffled = (g, list) => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(g.rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const nameList = (l) => (l.length ? l.map((o) => o.c.name).join(", ") : "(none)");

/** Mosswort Bridge — Hideaway 4. */
function* hideaway$(g, ctx) {
  const p = ctx.you, pl = g.state.players[p];
  const src = g.obj(ctx.source?.id);
  const n = Math.min(4, pl.library.length);
  if (!n || !src) return;
  const top = pl.library.slice(-n).reverse().map((id) => g.state.objects[id]);
  const [pick] = yield* g.chooseObjects$(p, top, { prompt: "Hideaway: exile one of the top four cards face down (the rest go to the bottom in a random order)", min: 1, max: 1, reason: "exile", source: src.id });
  if (!pick) return;
  g.moveObj(pick, "exile", { quiet: true });
  pick.faceDown = true; // hidden information: UIs should not show the name of a face-down exiled card to the opponent
  src.hidden = pick.id;
  g.log(`${g.state.players[p].name} exiles a card face down (hideaway)`);
  for (const o of shuffled(g, top.filter((o) => o !== pick))) g.moveObj(o, "library", { position: "bottom", quiet: true });
}

export default {
  // ------------------------------------------------------------------------------------------------ M
  "Massacre Girl, Known Killer": {
    patch(def) {
      return out(def, { abilities: plus(def, {
        kind: "triggered", on: { event: "dies", who: { types: ["creature"], controller: "opponent" } },
        condition: { type: "event", filter: { toughness: { op: "<", n: 1 } } },
        effects: [{ op: "draw", who: "you", amount: 1 }],
        text: "Whenever a creature an opponent controls dies, if its toughness was less than 1, draw a card.",
      }) });
    },
  },

  "Mirror Entity": {
    patch(def) {
      return out(def, { abilities: plus(def, {
        kind: "activated", cost: { mana: "{X}" },
        text: "{X}: Until end of turn, creatures you control have base power and toughness X/X and gain all creature types.",
        run: function* (g, ctx) {
          const x = ctx.x | 0;
          const aff = { types: ["creature"], controller: "you" };
          g.addUntilEOT({ type: "setBasePT", affects: aff, power: x, toughness: x }, ctx);
          g.addUntilEOT({ type: "asType", affects: aff, allCreatureTypes: true }, ctx);
          g.log(`Creatures ${g.state.players[ctx.you].name} controls become ${x}/${x} until end of turn`);
        },
      }) });
    },
  },

  "Mosswort Bridge": {
    patch(def) {
      return out(def, { abilities: plus(def,
        { kind: "triggered", on: { event: "enters", who: "self" }, run: hideaway$,
          text: "Hideaway 4 (When this land enters, look at the top four cards of your library, exile one face down, then put the rest on the bottom in a random order.)" },
        { kind: "activated", cost: { mana: "{G}", tap: true },
          text: "{G}, {T}: You may play the exiled card without paying its mana cost if creatures you control have total power 10 or greater.",
          run: function* (g, ctx) {
            const src = g.obj(ctx.source?.id);
            const o = src && src.hidden ? g.obj(src.hidden) : null;
            if (!o || o.zone !== "exile") return;
            if (g.amount({ totalPower: { types: ["creature"], controller: "you" } }, ctx) < 10) { g.log("Mosswort Bridge: creatures you control have total power less than 10"); return; }
            if (!(yield* g.confirm$(ctx.you, `Mosswort Bridge: play ${o.c.name} without paying its mana cost?`, src.id))) return;
            o.faceDown = false;
            if (o.def.types.includes("land")) {
              const pl = g.state.players[ctx.you];
              if (pl.landsPlayed >= pl.landsPerTurn) { g.log("Mosswort Bridge: you can't play another land this turn"); o.faceDown = true; return; }
              pl.landsPlayed++;
              g.emit({ t: "move", obj: o.id, from: "exile", to: "battlefield", player: ctx.you, text: `${pl.name} plays ${o.c.name}` });
              g.moveObj(o, "battlefield", { controller: ctx.you, quiet: true });
              g.fireTrigger({ type: "landPlayed", obj: o, player: ctx.you });
              src.hidden = null;
            } else if (yield* castFree$(g, ctx.you, o)) src.hidden = null;
            else o.faceDown = true;
          } },
      ) });
    },
  },

  "Myriad Landscape": {
    patch(def) {
      return out(def, { abilities: plus(def, {
        kind: "activated", cost: { mana: "{2}", tap: true, sacSelf: true },
        text: "{2}, {T}, Sacrifice this land: Search your library for up to two basic land cards that share a land type, put them onto the battlefield tapped, then shuffle.",
        run: function* (g, ctx) {
          const p = ctx.you, pl = g.state.players[p];
          const basics = () => pl.library.map((id) => g.state.objects[id]).filter((o) => o.c.types.includes("land") && o.c.supertypes.includes("basic")).sort((a, b) => (a.c.name < b.c.name ? -1 : 1));
          const [first] = yield* g.chooseObjects$(p, basics(), { prompt: "Myriad Landscape: search for up to two basic lands that share a land type — choose the first", min: 0, max: 1, reason: "search", source: ctx.source?.id });
          const got = [];
          if (first) {
            got.push(first);
            const share = basics().filter((o) => o !== first && o.c.subtypes.some((s) => first.c.subtypes.includes(s)));
            const [second] = yield* g.chooseObjects$(p, share, { prompt: `Myriad Landscape: choose a second basic land that shares a land type with ${first.c.name}`, min: 0, max: 1, reason: "search", source: ctx.source?.id });
            if (second) got.push(second);
          }
          for (const o of got) g.moveObj(o, "battlefield", { controller: p, tapped: true });
          g.shuffle(p);
        },
      }) });
    },
  },

  // ------------------------------------------------------------------------------------------------ N
  "Nothic": {
    patch(def) {
      return out(def, { abilities: plus(def, {
        kind: "triggered", on: { event: "dies", who: "self" },
        text: "Weird Insight — When this creature dies, roll a d20. 1—9: You draw a card and you lose 1 life. 10—19: You draw two cards and you lose 2 life. 20: You draw seven cards and you lose 7 life.",
        run: function* (g, ctx) {
          const roll = 1 + Math.floor(g.rng() * 20);
          const n = roll === 20 ? 7 : roll >= 10 ? 2 : 1;
          g.log(`${g.state.players[ctx.you].name} rolls a ${roll} (d20) for Nothic's Weird Insight`);
          g.draw(ctx.you, n);
          g.loseLife(ctx.you, n);
        },
      }) });
    },
  },

  // ------------------------------------------------------------------------------------------------ O
  "Outpost Siege": {
    // "As this enters, choose Khans or Dragons" is done by an enters trigger that puts a khans/dragons counter on the
    // enchantment (the engine has no "as enters" choice); the matching ability only works with its marker counter.
    patch(def) {
      return out(def, { abilities: plus(def,
        { kind: "triggered", on: { event: "enters", who: "self" }, text: "As this enchantment enters, choose Khans or Dragons.",
          run: function* (g, ctx) {
            const src = g.obj(ctx.source?.id);
            if (!src || src.zone !== "battlefield") return;
            const [pick] = yield* g.choose$(ctx.you, { prompt: "Outpost Siege: choose Khans or Dragons", min: 1, max: 1, reason: "mode", source: src.id,
              options: [{ id: "khans", label: "Khans — At the beginning of your upkeep, exile the top card of your library. Until end of turn, you may play that card.", type: "mode" },
                { id: "dragons", label: "Dragons — Whenever a creature you control leaves the battlefield, this enchantment deals 1 damage to any target.", type: "mode" }] });
            g.addCounters(src, pick ? pick.id : "khans", 1);
          } },
        { kind: "triggered", on: { event: "beginStep", step: "upkeep", whose: "you" }, condition: { type: "counters", what: "self", kind: "khans", op: ">=", n: 1 },
          effects: [{ op: "exileTop", who: "you", amount: 1, until: "endOfTurn" }],
          text: "Khans — At the beginning of your upkeep, exile the top card of your library. Until end of turn, you may play that card." },
        { kind: "triggered", on: { event: "leaves", who: { types: ["creature"], controller: "you" } }, condition: { type: "counters", what: "self", kind: "dragons", op: ">=", n: 1 },
          targets: [{ what: "any" }], effects: [{ op: "damage", amount: 1, to: T(0) }],
          text: "Dragons — Whenever a creature you control leaves the battlefield, this enchantment deals 1 damage to any target." },
      ) });
    },
  },

  "Overwhelming Stampede": {
    patch(def) {
      return out(def, { spell: spellOf(def, { effects: [{ op: "pump", what: { ref: "all", filter: { types: ["creature"], controller: "you" } },
        power: { greatestPower: { types: ["creature"], controller: "you" } }, toughness: { greatestPower: { types: ["creature"], controller: "you" } }, keywords: ["trample"], until: "endOfTurn" }] }) });
    },
  },

  // ------------------------------------------------------------------------------------------------ P
  "Path of Ancestry": {
    // the colour-identity mana is exact; the "when that mana is spent ... scry 1" rider needs mana-spent tracking (not available)
    patch(def) {
      const abilities = def.abilities.map((ab) => (ab.kind === "activated" && (ab.effects || []).some((e) => e.op === "addMana") ? { ...ab, mana: true, effects: (ab.effects || []).filter((e) => e.op !== "manual") } : ab));
      return out(def, { abilities }, def.unparsed);
    },
  },

  "Pawn of Ulamog": {
    patch(def) {
      const effects = [{ op: "may", text: "Create a 0/1 Eldrazi Spawn token?", effects: [{ op: "createToken", who: "you", token: "eldrazi spawn", amount: 1 }] }];
      return out(def, { abilities: def.abilities.map((ab) => (ab.kind === "triggered" ? { ...ab, effects } : ab)) });
    },
  },

  "Plaguecrafter": {
    patch(def) {
      return out(def, { abilities: def.abilities.map((ab) => (ab.kind === "triggered" ? { ...ab, effects: [
        { op: "sacrifice", who: "eachPlayer", filter: { types: ["creature", "planeswalker"] }, amount: 1, ifCant: [{ op: "discard", who: "you", amount: 1 }] },
      ] } : ab)) });
    },
  },

  "Priest of Forgotten Gods": {
    patch(def) {
      return out(def, { abilities: plus(def, {
        kind: "activated", cost: { tap: true, sac: { types: ["creature"], other: true }, sacCount: 2 }, targets: [{ what: "player", min: 0, max: 4 }],
        effects: [
          { op: "loseLife", who: T(0), amount: 2 },
          { op: "sacrifice", who: T(0), filter: { types: ["creature"] }, amount: 1 },
          { op: "addMana", mana: "{B}{B}" },
          { op: "draw", who: "you", amount: 1 },
        ],
        text: "{T}, Sacrifice two other creatures: Any number of target players each lose 2 life and sacrifice a creature of their choice. You add {B}{B} and draw a card.",
      }) });
    },
  },

  "Purphoros, God of the Forge": {
    patch(def) {
      const line = "As long as your devotion to red is less than five, Purphoros isn't a creature.";
      if (!CAPS.compareCond) return out(def, {}, [line]);
      return out(def, { abilities: plus(def, { kind: "static", effect: { type: "asType", affects: "self", setTypes: ["enchantment"] },
        condition: { type: "compare", a: { devotion: ["R"] }, op: "<", b: 5 }, text: line }) });
    },
  },

  /** Pyrohemia — the parsed intervening-if used `control` (which only counts YOUR creatures); the card says no creatures on the battlefield at all. */
  "Pyrohemia": {
    patch(def) {
      return out(def, { abilities: (def.abilities || []).map((ab) => ab.kind === "triggered" && ab.on?.event === "beginStep"
        ? { ...ab, condition: { type: "count", filter: { types: ["creature"] }, op: "==", n: 0 } } : ab) });
    },
  },

  // ------------------------------------------------------------------------------------------------ R
  "Ram Through": {
    patch(def) {
      return out(def, { spell: spellOf(def, {
        effects: [],
        run: function* (g, ctx) {
          const a = g.obj((ctx.targets[0] || [])[0]), b = g.obj((ctx.targets[1] || [])[0]);
          if (!a || !b || a.zone !== "battlefield" || b.zone !== "battlefield") return;
          const power = Math.max(0, a.c.power | 0);
          if (!power) return;
          if (g.hasKw(a, "trample")) {
            const lethal = g.hasKw(a, "deathtouch") ? Math.min(1, Math.max(0, b.c.toughness - b.damage)) : Math.max(0, b.c.toughness - b.damage);
            const toCreature = Math.min(power, lethal), excess = power - toCreature;
            if (toCreature > 0) g.dealDamage(a, b.id, toCreature);
            if (excess > 0) g.dealDamage(a, "P" + b.controller, excess);
          } else g.dealDamage(a, b.id, power);
        },
      }) });
    },
  },

  "Resplendent Angel": {
    // The "if you gained 5 or more life this turn" check is made when the trigger resolves (no cond for it yet; see engine requests).
    patch(def) {
      return out(def, { abilities: plus(def, {
        kind: "triggered", on: { event: "beginStep", step: "end", whose: "each" },
        text: "At the beginning of each end step, if you gained 5 or more life this turn, create a 4/4 white Angel creature token with flying and vigilance.",
        run: function* (g, ctx) {
          if ((g.state.players[ctx.you].lifeGainedThisTurn | 0) < 5) return;
          g.createToken(ctx.you, { name: "Angel", types: ["creature"], subtypes: ["angel"], colors: ["W"], power: 4, toughness: 4, keywords: { flying: true, vigilance: true } }, 1, { source: ctx.source });
        },
      }) });
    },
  },

  "Rewrite Regrets": {
    patch(def) {
      return out(def, { spell: spellOf(def, { effects: [...def.spell.effects, { run: function* (g, ctx) { yield* empowerJace$(g, ctx, 2); } }] }) });
    },
  },

  "Righteous Valkyrie": {
    // 47 = 40 (Commander starting life) + 7. Exact for Commander games; see engine requests for a format-independent version.
    patch(def) {
      return out(def, { abilities: plus(def, {
        kind: "static", effect: { type: "pump", affects: { types: ["creature"], controller: "you" }, power: 2, toughness: 2 },
        condition: { type: "life", who: "you", op: ">=", n: 47 },
        text: "As long as you have at least 7 life more than your starting life total, creatures you control get +2/+2.",
      }) });
    },
  },

  // Rings of Brighthearth: needs an "ability activated" event + ability copying -> no override (stays flagged).

  "Ringsight": {
    patch(def) {
      return out(def, { spell: spellOf(def, { effects: [
        { op: "ringTempts", who: "you" },
        { run: function* (g, ctx) {
          const p = ctx.you, pl = g.state.players[p];
          const cols = new Set();
          for (const o of g.find({ types: ["creature"], supertypes: ["legendary"], controller: "you" }, ctx)) for (const c of o.c.colors) cols.add(c);
          if (cols.size) {
            const cands = pl.library.map((id) => g.state.objects[id]).filter((o) => o.c.colors.some((c) => cols.has(c))).sort((a, b) => (a.c.name < b.c.name ? -1 : a.c.name > b.c.name ? 1 : 0));
            const [pick] = yield* g.chooseObjects$(p, cands, { prompt: "Ringsight: search your library for a card that shares a color with a legendary creature you control", min: 0, max: 1, reason: "search", source: ctx.source?.id });
            if (pick) {
              g.emit({ t: "reveal", objs: [pick.id], player: p, text: `${pl.name} reveals ${pick.c.name}` });
              g.moveObj(pick, "hand");
            }
          } else g.log("Ringsight: no legendary creature with a color — nothing to find");
          g.shuffle(p);
        } },
      ] }) });
    },
  },

  "Rugged Prairie": {
    patch(def) {
      return out(def, { abilities: plus(def, {
        kind: "activated", mana: true, cost: { mana: "{R/W}", tap: true },
        text: "{R/W}, {T}: Add {R}{R}, {R}{W}, or {W}{W}.",
        run: function* (g, ctx) {
          let pick = ctx.manaChoice && ctx.manaChoice.length >= 2 ? ctx.manaChoice.slice(0, 2).sort().join("") : null;
          if (pick !== "RR" && pick !== "RW" && pick !== "WW") {
            const [c] = yield* g.choose$(ctx.you, { prompt: "Rugged Prairie: choose the mana to add", min: 1, max: 1, reason: "generic", source: ctx.source?.id,
              options: [{ id: "RR", label: "{R}{R}", type: "color" }, { id: "RW", label: "{R}{W}", type: "color" }, { id: "WW", label: "{W}{W}", type: "color" }] });
            pick = c ? c.id : "RW";
          }
          g.addMana(ctx.you, `{${pick[0]}}{${pick[1]}}`);
        },
      }) });
    },
  },

  "Ruthless Technomancer": {
    patch(def) {
      const xAbilities = [];
      for (let n = 1; n <= 10; n++) {
        xAbilities.push({
          kind: "activated", cost: { mana: "{2}{B}", sac: { types: ["artifact"] }, sacCount: n },
          targets: [{ what: { types: ["creature"], zone: "graveyard", owner: "you", power: { op: "<=", n } }, zone: "graveyard" }],
          effects: [{ op: "move", what: T(0), to: "battlefield", control: "you" }],
          text: `{2}{B}, Sacrifice ${n} artifact${n === 1 ? "" : "s"} (X = ${n}): Return target creature card with power ${n} or less from your graveyard to the battlefield.`,
        });
      }
      return out(def, { abilities: [
        { kind: "triggered", on: { event: "enters", who: "self" },
          text: "When this creature enters, you may sacrifice another creature you control. If you do, create a number of Treasure tokens equal to that creature's power.",
          run: function* (g, ctx) {
            const others = g.find({ types: ["creature"], controller: "you", other: true }, ctx);
            if (!others.length) return;
            const [o] = yield* g.chooseObjects$(ctx.you, others, { prompt: "Ruthless Technomancer: you may sacrifice another creature to create Treasure tokens equal to its power (choose none to decline)", min: 0, max: 1, reason: "sacrifice", source: ctx.source?.id });
            if (!o) return;
            const n = Math.max(0, o.c.power | 0);
            if (g.sacrifice(o) && n > 0) g.createToken(ctx.you, "treasure", n, { source: ctx.source });
          } },
        ...xAbilities,
      ] });
    },
  },

  // ------------------------------------------------------------------------------------------------ S
  "Sauron's Ransom": {
    patch(def) {
      return out(def, { spell: spellOf(def, {
        effects: [],
        run: function* (g, ctx) {
          const you = ctx.you, pl = g.state.players[you];
          const opps = g.opponentsOf(you);
          let opp = opps[0];
          if (opps.length > 1) {
            const [c] = yield* g.choose$(you, { prompt: "Sauron's Ransom: choose an opponent", options: opps.map((q) => ({ id: "P" + q, label: g.state.players[q].name, type: "player" })), min: 1, max: 1, reason: "generic", source: ctx.source?.id });
            if (c) opp = +c.id.slice(1);
          }
          const n = Math.min(4, pl.library.length);
          if (n && opp != null) {
            const cards = pl.library.slice(-n).reverse().map((id) => g.state.objects[id]);
            const up = yield* g.chooseObjects$(opp, cards, { prompt: `Sauron's Ransom: choose the cards for the FACE-UP pile (the other cards form the face-down pile)`, min: 0, max: cards.length, reason: "generic", source: ctx.source?.id });
            const down = cards.filter((o) => !up.includes(o));
            const [pick] = yield* g.choose$(you, { prompt: "Sauron's Ransom: choose a pile to put into your hand (the other goes to your graveyard)", min: 1, max: 1, reason: "generic", source: ctx.source?.id,
              options: [{ id: "up", label: `Face-up pile: ${nameList(up)}`, type: "text" }, { id: "down", label: `Face-down pile (${down.length} card${down.length === 1 ? "" : "s"}, hidden)`, type: "text" }] });
            const [toHand, toGy] = pick && pick.id === "down" ? [down, up] : [up, down];
            g.emit({ t: "reveal", objs: up.map((o) => o.id), player: you, text: `Face-up pile: ${nameList(up)}` });
            for (const o of toHand) yield* g.moveTo$(o, "hand", {});
            for (const o of toGy) yield* g.moveTo$(o, "graveyard", {});
          }
          yield* g.ringTempts$(you);
        },
      }) });
    },
  },

  "Secluded Courtyard": {
    // The restricted any-colour mana can't be enforced (no mana-spend restrictions in the engine), and offering it unrestricted
    // would be a cheat, so only the colourless ability is kept; both lines stay flagged.
    patch(def) {
      const abilities = def.abilities.filter((ab) => !(ab.kind === "activated" && (ab.effects || []).some((e) => e.op === "manual")));
      return out(def, { abilities }, def.unparsed);
    },
  },

  // Spark Double: needs an "enters as a copy" replacement effect -> no override (stays flagged).

  "Syr Konrad, the Grim": {
    // Only the "another creature dies" clause can be detected; the graveyard-movement clauses need a zone-change event.
    patch(def) {
      return out(def, { abilities: plus(def, {
        kind: "triggered", on: { event: "dies", who: { types: ["creature"], other: true } },
        effects: [{ op: "damage", amount: 1, to: "opponent" }],
        text: "Whenever another creature dies, Syr Konrad deals 1 damage to each opponent.",
      }) }, def.unparsed);
    },
  },

  // ------------------------------------------------------------------------------------------------ T
  "Teferi's Protection": {
    // Protection from everything + "life total can't change" are automated; phasing out your permanents is not (flagged).
    patch(def) {
      return out(def, { spell: spellOf(def, { effects: [
        { op: "until", until: "yourNextTurn", static: { type: "playerProtection", affects: "you" } },
        ...def.spell.effects,
      ] }) }, def.unparsed);
    },
  },

  "Territory Culler": {
    patch(def) {
      return out(def, { abilities: plus(def, {
        kind: "triggered", on: { event: "enters", who: { types: ["land"], controller: "you" } },
        text: "Landfall — Whenever a land you control enters, look at the top card of your library. If it's a creature card, you may reveal it and put it into your hand. If you don't put the card into your hand, you may put it into your graveyard.",
        run: function* (g, ctx) {
          const top = H.topCard(g, ctx.you);
          if (!top) return;
          if (top.c.types.includes("creature")) {
            if (yield* g.confirm$(ctx.you, `Territory Culler: reveal ${top.c.name} and put it into your hand?`, ctx.source?.id)) {
              g.emit({ t: "reveal", objs: [top.id], player: ctx.you, text: `${g.state.players[ctx.you].name} reveals ${top.c.name}` });
              g.moveObj(top, "hand");
              return;
            }
          }
          if (yield* g.confirm$(ctx.you, `Territory Culler: put ${top.c.name} (top card of your library) into your graveyard?`, ctx.source?.id)) g.moveObj(top, "graveyard");
        },
      }) });
    },
  },

  // Thousand-Year Elixir: needs "activate as though it had haste" -> no override (stays flagged).

  "Tibalt, Rakish Instigator": {
    patch(def) {
      const line = "Your opponents can't gain life.";
      if (!CAPS.cantGainLife) return out(def, {}, [line]);
      return out(def, { abilities: [{ kind: "static", effect: { type: "cantGainLife", who: "opponent" }, text: line }, ...def.abilities] });
    },
  },

  // Tithing Blade // Consuming Sepulcher (craft) and Topiary Lecturer (increment): not implemented -> stay flagged.

  // ------------------------------------------------------------------------------------------------ V
  "Villainous Wrath": {
    patch(def) {
      return out(def, { spell: spellOf(def, {
        targets: [{ what: "opponent" }], effects: [],
        run: function* (g, ctx) {
          const id = (ctx.targets[0] || [])[0];
          if (id) {
            const p = +id.slice(1);
            const n = g.find({ types: ["creature"] }, ctx).filter((o) => o.controller === p).length;
            g.loseLife(p, n);
          }
          yield* g.runEffects$([{ op: "destroy", what: { ref: "all", filter: { types: ["creature"] } } }], ctx);
        },
      }) });
    },
  },

  "Violent Echoes": {
    patch(def) {
      return out(def, { spell: spellOf(def, {
        effects: [],
        run: function* (g, ctx) {
          const t = g.obj((ctx.targets[0] || [])[0]);
          if (!t || t.zone !== "battlefield") return;
          const isPw = t.c.types.includes("planeswalker");
          const lethal = isPw ? Math.max(0, t.counters.loyalty | 0) : Math.max(0, (t.c.toughness | 0) - (t.damage | 0));
          const dealt = g.dealDamage(ctx.source, t.id, 6);
          const excess = Math.max(0, dealt - lethal);
          if (excess > 0) yield* empowerJace$(g, ctx, excess);
        },
      }) });
    },
  },

  // ------------------------------------------------------------------------------------------------ W
  "Witch-king of Angmar": {
    patch(def) {
      return out(def, { abilities: plus(def, {
        kind: "triggered", on: { event: "dealsCombatDamage", batch: true, who: { types: ["creature"], controller: "opponent" }, to: "you" },
        text: "Whenever one or more creatures deal combat damage to you, each opponent sacrifices a creature of their choice that dealt combat damage to you this turn. The Ring tempts you.",
        run: function* (g, ctx) {
          const src = g.obj(ctx.source?.id) || ctx.source;
          const turn = g.state.turn;
          if (!src.dealtToController || src.dealtToController.turn !== turn) src.dealtToController = { turn, ids: [] };
          for (const o of ctx.event?.objs || []) if (!src.dealtToController.ids.includes(o.id)) src.dealtToController.ids.push(o.id);
          for (const p of g.opponentsOf(ctx.you)) {
            const cands = src.dealtToController.ids.map((id) => g.obj(id)).filter((o) => o && o.zone === "battlefield" && o.controller === p && o.c.types.includes("creature"));
            if (!cands.length) continue;
            const [pick] = yield* g.chooseObjects$(p, cands, { prompt: "Witch-king of Angmar: sacrifice a creature that dealt combat damage to its controller's opponent this turn", min: 1, max: 1, reason: "sacrifice", source: src.id });
            if (pick) g.sacrifice(pick);
          }
          yield* g.ringTempts$(ctx.you);
        },
      }) });
    },
  },

  "Witch-king, Bringer of Ruin": {
    patch(def) {
      return out(def, { abilities: plus(def, {
        kind: "triggered", on: { event: "attacks", who: "self" },
        effects: [{ op: "sacrifice", who: { ref: "defendingPlayer" }, filter: { types: ["creature"] }, amount: 1, least: true }],
        text: "Whenever Witch-king attacks, defending player sacrifices a creature with the least power among creatures they control.",
      }) });
    },
  },

  "Woe Strider": {
    patch(def) {
      return out(def, { keywords: { ...def.keywords, escape: "{3}{B}{B}", escapeExile: 4, escapeCounters: 2 } });
    },
  },

  // Wolfwillow Haven: the extra mana is a *triggered mana ability* (resolves immediately); the engine would stack it -> stays flagged.

  "Wrathful Raptors": {
    patch(def) {
      return out(def, { abilities: plus(def, {
        kind: "triggered", on: { event: "dealtDamage", who: { subtypes: ["dinosaur"], controller: "you" } },
        targets: [{ what: { anyOf: [{ player: true }, { types: ["planeswalker"] }, { types: ["creature"], notSubtypes: ["dinosaur"] }] } }],
        effects: [{ op: "damage", from: { ref: "event", what: "object" }, amount: { event: "amount" }, to: T(0) }],
        text: "Whenever a Dinosaur you control is dealt damage, it deals that much damage to any target that isn't a Dinosaur.",
      }) });
    },
  },

  // ------------------------------------------------------------------------------------------------ Y Z
  "Yidaro, Wandering Monster": {
    patch(def) {
      return out(def, { abilities: plus(def, {
        kind: "triggered", zone: "graveyard", on: { event: "cycled", who: "self" },
        text: "When you cycle this card, shuffle it into your library from your graveyard. If you've cycled a card named Yidaro, Wandering Monster four or more times this game, put it onto the battlefield from your graveyard instead.",
        run: function* (g, ctx) {
          const o = g.obj(ctx.source?.id);
          if (!o) return;
          const pl = g.state.players[o.owner];
          pl.yidaroCycles = (pl.yidaroCycles | 0) + 1;
          if (o.zone !== "graveyard") return;
          if (pl.yidaroCycles >= 4) yield* g.moveTo$(o, "battlefield", { controller: o.owner });
          else yield* g.moveTo$(o, "library", { position: "shuffle" });
        },
      }) });
    },
  },

  "Zilortha, Strength Incarnate": {
    // Lethal-damage-by-power needs an SBA/combat hook (engine request). The static below is ignored until the engine supports it.
    patch(def) {
      const line = "Lethal damage dealt to creatures you control is determined by their power rather than their toughness.";
      if (!CAPS.lethalByPower) return out(def, {}, [line]);
      return out(def, { abilities: plus(def, { kind: "static", effect: { type: "lethalByPower", affects: { types: ["creature"], controller: "you" } }, text: line }) });
    },
  },
};
