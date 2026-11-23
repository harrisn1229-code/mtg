// lib-ov/m4.js — overrides for deck-library cards, batch m4 (planeswalkers, Sagas, Classes, Level up, Cases).
// Keyed by exact card name. Same format and conventions as overrides-1.js; import helpers with
//   import { H } from "../overrides-1.js";
// Engine support lives in engine-m4.js (see SPEC-NOTES.md "Library automation: m4").
import { H } from "../overrides-1.js";

const { out, T } = H;

// ------------------------------------------------------------------------------------------------ helpers
/** A Saga chapter ability: "I, II — …". `body` = { targets?, effects? | run?, modes?, optional? }. */
const chapter = (chapters, text, body) => ({ kind: "triggered", on: { event: "chapter", who: "self", chapters }, ...body, text });
/** def.abilities with every chapter ability touching one of `chapters` removed, then `abs` added. */
function withChapters(def, abs) {
  const nums = new Set(abs.flatMap((a) => a.on.chapters));
  const keep = (def.abilities || []).filter((a) => !(a.kind === "triggered" && a.on?.event === "chapter" && a.on.chapters.some((n) => nums.has(n))));
  const all = [...keep, ...abs];
  // keep chapter abilities in chapter order after the non-chapter ones
  const nonCh = all.filter((a) => !(a.kind === "triggered" && a.on?.event === "chapter"));
  const ch = all.filter((a) => a.kind === "triggered" && a.on?.event === "chapter").sort((a, b) => a.on.chapters[0] - b.on.chapters[0]);
  return [...nonCh, ...ch];
}
/** Patch for a Saga: replace the listed chapters; everything else the parser produced stays. */
const saga = (...abs) => ({ patch: (def) => out(def, { abilities: withChapters(def, abs) }) });
/** A loyalty ability. */
const loyalty = (n, text, body) => ({ kind: "activated", loyalty: true, sorcery: true, limit: "turn", cost: { loyalty: n }, ...body, text });
/** def.abilities with the loyalty abilities whose text starts with `prefix` (e.g. "-2") removed, then `abs` added in printed order. */
function withLoyalty(def, abs) {
  const key = (a) => (a.text || "").replace(/^\[?([+\-−]?\d+|[+\-−]?X)\]?:.*$/s, "$1").replace("−", "-").toLowerCase();
  const keys = new Set(abs.map(key));
  const keep = (def.abilities || []).filter((a) => !(a.kind === "activated" && a.loyalty && keys.has(key(a))));
  return [...keep, ...abs];
}
/** Patch for a planeswalker. Abilities are matched by their loyalty cost text ("+1", "-2", "0", "-X"). Two abilities with the same cost (Garruk, Apex Predator) are all replaced. */
const walker = (...abs) => ({ patch: (def) => out(def, { abilities: withLoyalty(def, abs) }) });
const plus = (def, ...abs) => [...(def.abilities || []), ...abs];
const SAGA_ONLY = (def) => out(def, {});

const tok = (name, types, subtypes, colors, power, toughness, keywords) => ({ name, types, subtypes, colors, power, toughness, ...(keywords ? { keywords } : {}) });
/** Chosen-by-you opponent-neutral choose: first of `objs` by AI/human via chooseObjects$. */
const SAGA_SRC = (ctx) => ctx.source;
const you = (ctx) => ctx.you;
const opps = (g, ctx) => g.opponentsOf(ctx.you);

/** Exile "up to one target" permanent of each player until the Saga leaves the battlefield (both players' targets were chosen as it went on the stack). */
function* exileUntilLeaves$(g, ctx) {
  const src = ctx.source ? g.obj(ctx.source.id) : null;
  for (const grp of ctx.targets || []) for (const id of grp || []) {
    const o = g.obj(id);
    if (!o || o.zone !== "battlefield") continue;
    if (!src || src.zone !== "battlefield" || src.ts !== ctx.source.ts) { continue; } // the Saga is already gone: the duration is over, nothing is exiled (CR 610.3c-ish)
    yield* g.runEffects$([{ op: "exile", what: id, until: "sourceLeaves" }], ctx);
  }
}
/** Target specs "for each player: up to one other target …" (1v1: you and the opponent). */
const perPlayerSpecs = (base) => [
  { what: { ...base, controller: "you" }, min: 0, max: 1 },
  { what: { ...base, controller: "opponent" }, min: 0, max: 1 },
];

/** The cards `src` exiled with its "until it leaves" links (still in exile). */
const linkedCards = (g, src) => g.state.links.filter((l) => l.sourceId === src.id).map((l) => g.obj(l.objId)).filter((o) => o && o.zone === "exile");

// shared inline effects
const monarchEffect = { op: "becomeMonarch", text: "You become the monarch.", run: function* (g, ctx) { g.becomeMonarch(ctx.you); } };
const sagaLore = (g, ctx) => g.obj(ctx.source.id)?.counters?.lore | 0;

export default {
  // ================================================================================================ SAGAS
  "In the Darkness Bind Them": saga(chapter([4], "IV — For each opponent, gain control of up to one target creature that player controls until end of turn. Untap those creatures. They gain haste until end of turn. The Ring tempts you.", {
    targets: [{ what: { types: ["creature"], controller: "opponent" }, min: 0, max: 1 }],
    effects: [
      { op: "gainControl", what: T(0), until: "endOfTurn" },
      { op: "untap", what: T(0) },
      { op: "pump", what: T(0), power: 0, toughness: 0, keywords: ["haste"], until: "endOfTurn" },
      { op: "ringTempts", who: "you" },
    ],
  })),

  "Oath of Eorl": saga(chapter([3], "III — Put an indestructible counter on up to one target Human. You become the monarch.", {
    targets: [{ what: { types: ["creature"], subtypes: ["human"] }, min: 0, max: 1 }],
    effects: [{ op: "addCounters", what: T(0), kind: "indestructible", amount: 1 }, monarchEffect],
  })),

  "Vault 101: Birthday Party": saga(
    chapter([1], "I — Create a 1/1 white Human Soldier creature token and a Food token.", {
      effects: [{ op: "createToken", who: "you", token: tok("Human Soldier", ["creature"], ["human", "soldier"], ["W"], 1, 1), amount: 1 }, { op: "createToken", who: "you", token: "food", amount: 1 }],
    }),
    chapter([2, 3], "II, III — You may put an Aura or Equipment card from your hand or graveyard onto the battlefield. If an Equipment is put onto the battlefield this way, you may attach it to a creature you control.", {
      effects: [{
        op: "putAuraOrEquipment",
        run: function* (g, ctx) {
          const p = ctx.you, pl = g.state.players[p];
          const hostsFor = (a) => g.state.battlefield.map((id) => g.obj(id)).filter((h) => h && g.auraLegal(a, h));
          const cands = [...pl.hand, ...pl.graveyard].map((id) => g.obj(id)).filter((o) => o && (o.def.subtypes.includes("equipment") || (o.def.subtypes.includes("aura") && hostsFor(o).length)));
          if (!cands.length) return;
          const [c] = yield* g.chooseObjects$(p, cands, { prompt: "Vault 101: Birthday Party — put an Aura or Equipment card onto the battlefield (or none)", min: 0, max: 1, reason: "return", source: ctx.source?.id });
          if (!c) return;
          if (c.def.subtypes.includes("aura")) {
            const hosts = hostsFor(c);
            const [h] = yield* g.chooseObjects$(p, hosts, { prompt: `Attach ${c.c.name} to which permanent?`, min: 1, max: 1, reason: "target", source: ctx.source?.id });
            yield* g.moveTo$(c, "battlefield", { controller: p, attachTo: h?.id });
          } else {
            yield* g.moveTo$(c, "battlefield", { controller: p });
            const mine = g.find({ types: ["creature"], controller: "you" }, ctx);
            const eq = g.obj(c.id);
            if (eq && eq.zone === "battlefield" && mine.length) {
              const [h] = yield* g.chooseObjects$(p, mine, { prompt: `Attach ${eq.c.name} to a creature you control? (choose none to leave it unattached)`, min: 0, max: 1, reason: "target", source: ctx.source?.id });
              if (h) g.attach(eq, h);
            }
          }
        },
      }],
    })),

  "Vault 21: House Gambit": saga(chapter([3], "III — Reveal up to five nonland cards from your hand. For each of those cards that has the same mana value as another card revealed this way, create a Treasure token.", {
    effects: [{
      op: "revealForTreasure",
      run: function* (g, ctx) {
        const p = ctx.you;
        const hand = g.state.players[p].hand.map((id) => g.obj(id)).filter((o) => o && !o.def.types.includes("land"));
        if (!hand.length) return;
        const picked = yield* g.chooseObjects$(p, hand, { prompt: "Vault 21: House Gambit — reveal up to five nonland cards from your hand", min: 0, max: Math.min(5, hand.length), reason: "reveal", source: ctx.source?.id });
        if (!picked.length) return;
        g.emit({ t: "reveal", objs: picked.map((o) => o.id), player: p, text: `${g.state.players[p].name} reveals ${picked.map((o) => o.c.name).join(", ")}` });
        const n = picked.filter((o) => picked.some((q) => q !== o && (q.c.cmc | 0) === (o.c.cmc | 0))).length;
        if (n) g.createToken(p, "treasure", n);
      },
    }],
  })),

  "Vault 13: Dweller's Journey": saga(
    chapter([1], "I — For each player, exile up to one other target enchantment or creature that player controls until this Saga leaves the battlefield.", {
      targets: perPlayerSpecs({ types: ["enchantment", "creature"], other: true }),
      effects: [{ op: "exileUntilLeaves", run: exileUntilLeaves$ }],
    }),
    chapter([3], "III — Return two cards exiled with this Saga to the battlefield under their owners' control and put the rest on the bottom of their owners' libraries.", {
      effects: [{
        op: "returnTwo",
        run: function* (g, ctx) {
          const src = g.obj(ctx.source.id);
          const cards = linkedCards(g, src);
          if (!cards.length) return;
          const n = Math.min(2, cards.length);
          const back = yield* g.chooseObjects$(ctx.you, cards, { prompt: `Vault 13: Dweller's Journey — choose ${n} exiled card${n > 1 ? "s" : ""} to return to the battlefield`, min: n, max: n, reason: "return", source: src.id });
          const rest = cards.filter((c) => !back.includes(c));
          for (const c of back) yield* g.moveTo$(c, "battlefield", { controller: c.owner });
          for (const c of rest) yield* g.moveTo$(c, "library", { position: "bottom" });
        },
      }],
    })),

  "Vault 112: Sadistic Simulation": saga(
    chapter([1, 2], "I, II — Tap up to one target creature and put a stun counter on it. You get {E}{E}.", {
      targets: [{ what: { types: ["creature"] }, min: 0, max: 1 }],
      effects: [{ op: "tap", what: T(0) }, { op: "addCounters", what: T(0), kind: "stun", amount: 1 }, { op: "energy", run: function* (g, ctx) { g.addPlayerCounters(ctx.you, "energy", 2); } }],
    }),
    chapter([3], "III — Pay any amount of {E}. If you paid one or more {E} this way, shuffle your library, then exile that many cards from the top. You may play one of those cards without paying its mana cost.", {
      effects: [{
        op: "payEnergy",
        run: function* (g, ctx) {
          const p = ctx.you, pl = g.state.players[p];
          const have = pl.counters.energy | 0;
          if (have <= 0) return;
          const n = yield* g.number$(p, "Sadistic Simulation: pay how many {E}?", 0, have, ctx.source?.id);
          if (n <= 0) return;
          g.addPlayerCounters(p, "energy", -n);
          g.shuffle(p);
          const exiled = [];
          for (let i = 0; i < n && pl.library.length; i++) { const top = g.obj(pl.library[pl.library.length - 1]); g.moveObj(top, "exile"); exiled.push(top); }
          const playable = exiled.filter((o) => o.zone === "exile" && (o.def.types.includes("land") ? pl.landsPlayed < pl.landsPerTurn : true));
          if (!playable.length) return;
          const [c] = yield* g.chooseObjects$(p, playable, { prompt: "Sadistic Simulation — you may play one of the exiled cards without paying its mana cost", min: 0, max: 1, reason: "exile", source: ctx.source?.id });
          if (!c) return;
          if (c.def.types.includes("land")) { pl.landsPlayed++; yield* g.enter$(c, { controller: p }); g.fireTrigger({ type: "landPlayed", obj: c, player: p }); }
          else yield* g.castFree$(p, c, {});
        },
      }],
    })),

  "Vault 12: The Necropolis": saga(
    chapter([1], "I — Each player gets three rad counters.", { effects: [{ op: "rad", run: function* (g) { for (const q of g.state.players) if (!q.lost) g.addPlayerCounters(q.idx, "rad", 3); } }] }),
    chapter([2], "II — Create X 2/2 black Zombie Mutant creature tokens, where X is the total number of rad counters among players.", {
      effects: [{ op: "zombies", run: function* (g, ctx) { const x = g.state.players.reduce((n, q) => n + (q.counters.rad | 0), 0); if (x) g.createToken(ctx.you, tok("Zombie Mutant", ["creature"], ["zombie", "mutant"], ["B"], 2, 2), x); } }],
    }),
    chapter([3], "III — Put two +1/+1 counters on each creature you control that's a Zombie or Mutant.", {
      effects: [{ op: "addCounters", what: { ref: "all", filter: { types: ["creature"], controller: "you", subtypes: ["zombie", "mutant"] } }, kind: "+1/+1", amount: 2 }],
    })),

  "Vault 87: Forced Evolution": saga(
    chapter([1], "I — Gain control of target non-Mutant creature for as long as you control this Saga.", {
      targets: [{ what: { types: ["creature"], notSubtypes: ["mutant"] } }],
      effects: [{ op: "gainControl", what: T(0), until: "sourceControlled" }],
    }),
    chapter([2], "II — Put a +1/+1 counter on target creature you control. It becomes a Mutant in addition to its other types.", {
      targets: [{ what: { types: ["creature"], controller: "you" } }],
      effects: [{ op: "addCounters", what: T(0), kind: "+1/+1", amount: 1 }, {
        op: "becomeMutant",
        run: function* (g, ctx) { for (const id of ctx.targets?.[0] || []) { const o = g.obj(id); if (o && o.zone === "battlefield") g.addEffect({ type: "asType", addSubtypes: ["mutant"] }, ctx, { objIds: [o.id], until: "forever" }); } },
      }],
    })),

  "Vault 11: Voter's Dilemma": saga(
    chapter([1], "I — For each opponent, you create a 1/1 white Human Soldier creature token.", {
      effects: [{ op: "createToken", who: "you", token: tok("Human Soldier", ["creature"], ["human", "soldier"], ["W"], 1, 1), amount: { numOpponents: true } }],
    }),
    chapter([2, 3], "II, III — Each player secretly votes for up to one creature, then those votes are revealed. If no creature got votes, each player draws a card. Otherwise, destroy each creature with the most votes or tied for most votes.", {
      effects: [{
        op: "vote",
        run: function* (g, ctx) {
          const creatures = g.find({ types: ["creature"] }, ctx);
          const votes = new Map();
          const order = g.apnap(g.state.players.filter((q) => !q.lost).map((q) => q.idx));
          const first = order.indexOf(ctx.you);
          const ring = first > 0 ? [...order.slice(first), ...order.slice(0, first)] : order;
          for (const q of ring) {
            if (!creatures.length) break;
            const [v] = yield* g.chooseObjects$(q, creatures, { prompt: "Voter's Dilemma — vote for up to one creature", min: 0, max: 1, reason: "target", source: ctx.source?.id });
            if (v) votes.set(v, (votes.get(v) || 0) + 1);
          }
          if (!votes.size) { for (const q of ring) g.draw(q, 1); return; }
          const top = Math.max(...votes.values());
          g.log(`Votes: ${[...votes].map(([o, n]) => `${o.c.name} ${n}`).join(", ")}`);
          for (const [o, n] of votes) if (n === top) g.destroy(o);
        },
      }],
    })),
};
