// lib-ov/m3.js — overrides for deck-library cards, batch m3 (see SPEC-NOTES.md "Library automation: m3").
// Keyed by exact card name. Same format and conventions as overrides-1.js.
// Monarch and rad-counter cards belong to batch m4 and are not touched here.
import { H } from "../overrides-1.js";

const { out, plus, T } = H;
const ALL5 = ["W", "U", "B", "R", "G"];
const pid = (i) => "P" + i;
const isPid = (id) => typeof id === "string" && /^P\d+$/.test(id);
const EVT_OBJ = { ref: "event", what: "object" };
const OUTLAW = ["assassin", "mercenary", "pirate", "rogue", "warlock"];

/** Clear the unparsed lines containing any of `clear`, add abilities (and optional def patch). */
const fix = (clear, abilities = [], extra = {}) => ({
  patch(def) {
    const rest = (def.unparsed || []).filter((l) => !clear.some((s) => l.includes(s)));
    return out(def, { ...extra, abilities: [...(def.abilities || []), ...(typeof abilities === "function" ? abilities(def) : abilities)] }, rest);
  },
});
const trig = (on, effects, text, extra = {}) => ({ kind: "triggered", on, effects, text, ...extra });
const trigRun = (on, run, text, extra = {}) => ({ kind: "triggered", on, run, text, ...extra });
const actv = (cost, effects, text, extra = {}) => ({ kind: "activated", cost, effects, text, ...extra });
const actRun = (cost, run, text, extra = {}) => ({ kind: "activated", cost, run, text, ...extra });
const stat = (effect, text, extra = {}) => ({ kind: "static", effect, text, ...extra });
const SELF_ENTERS = { event: "enters", who: "self" };
const HERO = { name: "Hero", types: ["creature"], subtypes: ["hero"], colors: [], power: 1, toughness: 1 };
const treasureMana = { kind: "activated", cost: { tap: true, sacSelf: true }, mana: true, effects: [{ op: "addMana", mana: { any: 2 } }], text: "{T}, Sacrifice this artifact: Add two mana of any one color." };

/** Job select: When this Equipment enters, create a 1/1 colorless Hero creature token, then attach this to it. */
const jobSelect = trig(SELF_ENTERS, [{ op: "createToken", token: HERO, amount: 1 }, { op: "attach", what: "self", to: { ref: "it" } }], "Job select (When this Equipment enters, create a 1/1 colorless Hero creature token, then attach this to it.)");

const lastVote = (g) => g.state._lastVote;
const objVal = (g, o) => (o.c.power | 0) + (o.c.toughness | 0) + (o.c.cmc | 0);

export default {
  // ================================================================ The Hosts of Mordor
  "Saruman, the White Hand": fix(["amass Orcs X", "Goblins and Orcs"], [
    trig({ event: "cast", who: "you", filter: { notTypes: ["creature"] } }, [{ op: "amass", amount: { cmcOf: EVT_OBJ }, subtype: "orc" }], "Whenever you cast a noncreature spell, amass Orcs X, where X is that spell's mana value."),
    stat({ type: "pump", affects: { types: ["creature"], subtypes: ["goblin", "orc"], controller: "you" }, power: 0, toughness: 0, keywords: [{ ward: "{2}" }] }, "Goblins and Orcs you control have ward {2}."),
  ]),
  "Cavern-Hoard Dragon": fix(["costs {X} less", "Whenever this creature deals combat damage"], [
    stat({ type: "selfCostMod", per: { greatestCountOf: { types: ["artifact"] } }, amount: -1 }, "This spell costs {X} less to cast, where X is the greatest number of artifacts an opponent controls."),
    trigRun({ event: "dealsCombatDamage", who: "self", to: "player" }, function* (g, ctx) {
      const t = ctx.event.target;
      if (!isPid(t)) return;
      const n = g.find({ types: ["artifact"] }, ctx).filter((o) => o.controller === +t.slice(1)).length;
      if (n) g.createToken(ctx.you, "treasure", n, { source: ctx.source });
    }, "Whenever this creature deals combat damage to a player, you create a Treasure token for each artifact that player controls."),
  ]),
  "Moria Scavenger": fix(["Discard a card: Draw a card"], [
    actRun({ tap: true, discard: 1 }, function* (g, ctx) {
      g.draw(ctx.you, 1);
      if ((ctx.discarded || []).some((o) => o.c.types.includes("creature"))) yield* g.runEffects$([{ op: "amass", amount: 1, subtype: "orc" }], ctx);
    }, "{T}, Discard a card: Draw a card. If the discarded card was a creature card, amass Orcs 1."),
  ]),
  "Voracious Fell Beast": fix(["each opponent sacrifices a creature of their choice"], [
    trigRun(SELF_ENTERS, function* (g, ctx) {
      let n = 0;
      for (const q of g.opponentsOf(ctx.you)) {
        const cands = g.find({ types: ["creature"] }, ctx).filter((o) => o.controller === q);
        if (!cands.length) continue;
        const [c] = yield* g.chooseObjects$(q, cands, { prompt: "Sacrifice a creature", min: 1, max: 1, reason: "sacrifice", source: ctx.source?.id });
        if (c && g.sacrifice(c) !== false) n++;
      }
      if (n) g.createToken(ctx.you, "food", n, { source: ctx.source });
    }, "When this creature enters, each opponent sacrifices a creature of their choice. Create a Food token for each creature sacrificed this way."),
  ]),
  "Grishnákh, Brash Instigator": fix(["amass Orcs 2. When you do"], [
    trigRun(SELF_ENTERS, function* (g, ctx) {
      yield* g.runEffects$([{ op: "amass", amount: 2, subtype: "orc" }], ctx);
      const army = g.obj((ctx.it || [])[0]);
      if (!army) return;
      const pw = army.c.power | 0;
      const spec = { what: { types: ["creature"], notSupertypes: ["legendary"], controller: "opponent" } };
      const cands = g.find(spec.what, ctx).filter((o) => (o.c.power | 0) <= pw && g.isLegalTarget(o.id, spec, ctx.source, ctx.you, ctx));
      if (!cands.length) return;
      const [t] = yield* g.chooseObjects$(ctx.you, cands, { prompt: "Gain control of target nonlegendary creature (power ≤ the Army's)", min: 1, max: 1, reason: "target", source: ctx.source?.id });
      if (!t) return;
      g.gainControl(t, ctx.you, "endOfTurn", ctx.source);
      g.untap(t);
      g.pumpUntilEOT(t, { power: 0, toughness: 0, keywords: ["haste"] });
    }, "When Grishnákh enters, amass Orcs 2. When you do, until end of turn, gain control of target nonlegendary creature an opponent controls with power less than or equal to the amassed Army's power. Untap that creature. It gains haste until end of turn."),
  ]),
  "The Mouth of Sauron": fix(["target player mills three cards"], [
    trigRun(SELF_ENTERS, function* (g, ctx) {
      const [t] = ctx.targets[0] || [];
      if (!t) return;
      const p = +t.slice(1);
      g.mill(p, 3);
      const n = g.state.players[p].graveyard.filter((id) => { const c = g.obj(id).c; return c.types.includes("instant") || c.types.includes("sorcery"); }).length;
      yield* g.runEffects$([{ op: "amass", amount: n, subtype: "orc" }], ctx);
    }, "When The Mouth of Sauron enters, target player mills three cards. Then amass Orcs X, where X is the number of instant and sorcery cards in that player's graveyard.", { targets: [{ what: "player" }] }),
  ]),

  // ================================================================ Food and Fellowship
  "Field-Tested Frying Pan": fix(["create a Food token, then create a 1/1", "Equipped creature has"], [
    trig(SELF_ENTERS, [{ op: "createToken", token: "food", amount: 1 }, { op: "createToken", token: { name: "Halfling", types: ["creature"], subtypes: ["halfling"], colors: ["W"], power: 1, toughness: 1 }, amount: 1 }, { op: "attach", what: "self", to: { ref: "it" } }], "When this Equipment enters, create a Food token, then create a 1/1 white Halfling creature token and attach this Equipment to it."),
    stat({ type: "pump", affects: "equipped", power: 0, toughness: 0, abilities: [trig({ event: "gainLife", who: "you" }, [{ op: "pump", what: "self", power: { event: "amount" }, toughness: { event: "amount" }, keywords: [], until: "endOfTurn" }], "Whenever you gain life, this creature gets +X/+X until end of turn, where X is the amount of life you gained.")] }, "Equipped creature has \"Whenever you gain life, this creature gets +X/+X until end of turn, where X is the amount of life you gained.\""),
  ]),
  "Motivated Pony": fix(["attacking creatures get +1/+1"], [
    trig({ event: "attacks", who: "self" }, [
      { op: "pump", what: { ref: "all", filter: { attacking: true } }, power: 1, toughness: 1, keywords: [], until: "endOfTurn" },
      { op: "if", cond: { type: "entered", who: "you", filter: { subtypes: ["food"] } }, then: [{ op: "untap", what: { ref: "all", filter: { attacking: true } } }, { op: "pump", what: { ref: "all", filter: { attacking: true } }, power: 2, toughness: 2, keywords: [], until: "endOfTurn" }] },
    ], "Whenever this creature attacks, attacking creatures get +1/+1 until end of turn. If a Food entered the battlefield under your control this turn, untap those creatures and they get an additional +2/+2 until end of turn."),
  ]),
  "Tireless Provisioner": fix(["create a Food token or a Treasure token"], [
    trigRun({ event: "enters", who: { types: ["land"], controller: "you" } }, function* (g, ctx) {
      const [c] = yield* g.choose$(ctx.you, { prompt: "Create a Food token or a Treasure token?", options: [{ id: "treasure", label: "Treasure", type: "text" }, { id: "food", label: "Food", type: "text" }], min: 1, max: 1, reason: "mode", source: ctx.source?.id });
      g.createToken(ctx.you, c.id, 1, { source: ctx.source });
    }, "Landfall — Whenever a land you control enters, create a Food token or a Treasure token."),
  ]),
  "Farmer Cotton": fix(["create X 1/1 white Halfling"], [
    trigRun(SELF_ENTERS, function* (g, ctx) {
      const x = g.obj(ctx.source.id)?.x | 0;
      g.createToken(ctx.you, { name: "Halfling", types: ["creature"], subtypes: ["halfling"], colors: ["W"], power: 1, toughness: 1 }, x, { source: ctx.source });
      g.createToken(ctx.you, "food", x, { source: ctx.source });
    }, "When this creature enters, create X 1/1 white Halfling creature tokens and X Food tokens."),
  ]),

  // ================================================================ Elven Council (voting)
  "Galadriel, Elven-Queen": fix(["Will of the council"], [
    trigRun({ event: "beginStep", step: "beginCombat", whose: "you" }, function* (g, ctx) {
      const r = yield* g.vote$({ source: ctx.source, you: ctx.you, prompt: "Vote: dominion or guidance", options: [{ id: "dominion", label: "Dominion", type: "text" }, { id: "guidance", label: "Guidance", type: "text" }], score: (v, id) => (v === ctx.you ? (id === "dominion" ? 2 : 1) : (id === "guidance" ? 2 : 1)) });
      if (r.winner === "dominion") {
        yield* g.ringTempts$(ctx.you);
        const b = g.obj(g.state.players[ctx.you].ring.bearer);
        if (b) g.addCounters(b, "+1/+1", 1);
      } else g.draw(ctx.you, 1);
    }, "Will of the council — At the beginning of combat on your turn, if another Elf entered the battlefield under your control this turn, starting with you, each player votes for dominion or guidance. If dominion gets more votes, the Ring tempts you, then you put a +1/+1 counter on your Ring-bearer. If guidance gets more votes or the vote is tied, draw a card.",
      { condition: { type: "entered", who: "you", filter: { subtypes: ["elf"], other: true } } }),
  ]),
  "Trap the Trespassers": fix(["Secret council"], [], {
    spell: { effects: [], run: function* (g, ctx) {
      const cands = g.find({ types: ["creature"] }, ctx).filter((o) => o.controller !== ctx.you);
      if (!cands.length) return;
      const r = yield* g.vote$({ source: ctx.source, you: ctx.you, secret: true, prompt: "Secretly vote for a creature you don't control", options: cands.map((o) => ({ id: o.id, label: g.objLabel(o, ctx.you), type: "object" })), score: (v, id) => { const o = g.obj(id); const w = objVal(g, o); return v === ctx.you ? w : -w; } });
      for (const o of cands) { const n = r.tally[o.id] | 0; if (n > 0) { g.addCounters(o, "stun", n); g.tap(o); } }
    } },
  }),
  "Círdan the Shipwright": fix(["Secret council"], () => {
    const run = function* (g, ctx) {
      const opts = g.state.players.filter((p) => !p.lost).map((p) => ({ id: pid(p.idx), label: p.name, type: "player" }));
      const r = yield* g.vote$({ source: ctx.source, you: ctx.you, secret: true, prompt: "Secretly vote for a player", options: opts, score: (v, id) => (id === pid(v) ? 2 : 0) });
      for (const q of r.order) g.draw(q, r.tally[pid(q)] | 0);
      for (const q of r.order) {
        if (r.tally[pid(q)]) continue;
        const cands = g.state.players[q].hand.map((id) => g.obj(id)).filter((o) => o.def.types.some((t) => ["artifact", "creature", "enchantment", "land", "planeswalker", "battle"].includes(t)));
        if (!cands.length) continue;
        const [c] = yield* g.chooseObjects$(q, cands, { prompt: "You received no votes: you may put a permanent card from your hand onto the battlefield", min: 0, max: 1, reason: "generic", source: ctx.source?.id });
        if (c) yield* g.enter$(c, { controller: q });
      }
    };
    const text = "Secret council — Whenever Círdan enters or attacks, each player secretly votes for a player, then those votes are revealed. Each player draws a card for each vote they received. Each player who received no votes may put a permanent card from their hand onto the battlefield.";
    return [trigRun(SELF_ENTERS, run, text), trigRun({ event: "attacks", who: "self" }, run, text)];
  }),
  "Erestor of the Council": fix(["Whenever players finish voting"], [
    trigRun({ event: "votesFinished", who: "each" }, function* (g, ctx) {
      const bv = ctx.event.byVoter;
      const mine = new Set(bv[ctx.you] || []);
      let diff = 0;
      for (const q of g.opponentsOf(ctx.you)) {
        const theirs = bv[q] || [];
        if (theirs.some((id) => mine.has(id))) g.createToken(q, "treasure", 1, { source: ctx.source });
        if (theirs.some((id) => !mine.has(id))) diff++;
      }
      if (diff) yield* g.runEffects$([{ op: "scry", amount: diff }], ctx);
      g.draw(ctx.you, 1);
    }, "Whenever players finish voting, each opponent who voted for a choice you voted for creates a Treasure token. You scry X, where X is the number of opponents who voted for a choice you didn't vote for. Draw a card."),
  ]),
  "Model of Unity": fix(["Whenever players finish voting"], [
    trigRun({ event: "votesFinished", who: "each" }, function* (g, ctx) {
      const bv = ctx.event.byVoter;
      const mine = new Set(bv[ctx.you] || []);
      const ps = [ctx.you, ...g.opponentsOf(ctx.you).filter((q) => (bv[q] || []).some((id) => mine.has(id)))];
      for (const q of ps) if (yield* g.confirm$(q, "Model of Unity: scry 2?", ctx.source?.id)) yield* g.runEffects$([{ op: "scry", amount: 2 }], { ...ctx, you: q });
    }, "Whenever players finish voting, you and each opponent who voted for a choice you voted for may scry 2."),
  ]),
  "Plea for Power": fix(["Will of the council"], [], {
    spell: { effects: [], run: function* (g, ctx) {
      const r = yield* g.vote$({ source: ctx.source, you: ctx.you, prompt: "Vote: time or knowledge", options: [{ id: "time", label: "Time (extra turn)", type: "text" }, { id: "knowledge", label: "Knowledge (draw three)", type: "text" }], score: (v, id) => (v === ctx.you ? (id === "time" ? 2 : 1) : (id === "knowledge" ? 2 : 1)) });
      if (r.winner === "time") yield* g.runEffects$([{ op: "extraTurn" }], ctx); else g.draw(ctx.you, 3);
    } },
  }),
  "Sail into the West": fix(["Will of the council"], [], {
    spell: { effects: [], run: function* (g, ctx) {
      const r = yield* g.vote$({ source: ctx.source, you: ctx.you, prompt: "Vote: return or embark", options: [{ id: "return", label: "Return (cards from graveyard)", type: "text" }, { id: "embark", label: "Embark (discard hand, draw seven)", type: "text" }], score: (v, id) => (id === "embark" ? 2 : 1) });
      if (r.winner === "return") {
        for (const q of r.order) {
          const gy = g.state.players[q].graveyard.map((id) => g.obj(id));
          const ch = yield* g.chooseObjects$(q, gy, { prompt: "Return up to two cards from your graveyard to your hand", min: 0, max: 2, reason: "return", source: ctx.source?.id });
          for (const o of ch) g.moveObj(o, "hand");
        }
        ctx.source.exileOnResolve = true;
        g.addEffect({ type: "exileInsteadOfDying" }, ctx, { objIds: [], until: "endOfTurn" });
        const s = g.obj(ctx.source.id);
        if (s) s._exileAfter = true;
      } else {
        for (const q of r.order) {
          if (!(yield* g.confirm$(q, "Discard your hand and draw seven cards?", ctx.source?.id))) continue;
          for (const id of [...g.state.players[q].hand]) g.discardCard(g.obj(id));
          g.draw(q, 7);
        }
      }
    } },
  }),
  "Celeborn the Wise": fix(["Whenever you scry"], [
    trig({ event: "scry", who: "you" }, [{ op: "pump", what: "self", power: { event: "amount" }, toughness: { event: "amount" }, keywords: [], until: "endOfTurn" }], "Whenever you scry, Celeborn gets +1/+1 until end of turn for each card looked at while scrying this way."),
  ]),
  "Elven Farsight": fix(["Scry 3, then you may reveal"], [], {
    spell: { effects: [], run: function* (g, ctx) {
      yield* g.runEffects$([{ op: "scry", amount: 3 }], ctx);
      const pl = g.state.players[ctx.you];
      const top = pl.library.length ? g.obj(pl.library[pl.library.length - 1]) : null;
      if (!top) return;
      if (!(yield* g.confirm$(ctx.you, "Reveal the top card of your library?", ctx.source?.id))) return;
      g.emit({ t: "reveal", objs: [top.id], player: ctx.you, text: `${pl.name} reveals ${top.c.name}` });
      if (top.c.types.includes("creature")) g.draw(ctx.you, 1);
    } },
  }),
  "Sticky Fingers": fix(["Enchanted creature has menace"], [
    stat({ type: "pump", affects: "enchanted", power: 0, toughness: 0, keywords: ["menace"], abilities: [trig({ event: "dealsCombatDamage", who: "self", to: "player" }, [{ op: "createToken", token: "treasure", amount: 1 }], "Whenever this creature deals combat damage to a player, create a Treasure token.")] }, "Enchanted creature has menace and \"Whenever this creature deals combat damage to a player, create a Treasure token.\""),
  ]),

  // ================================================================ energy
  "Liberty Prime, Recharged": fix(["sacrifice it unless you pay"], () => {
    const run = function* (g, ctx) {
      const pl = g.state.players[ctx.you];
      if ((pl.counters.energy | 0) >= 2 && (yield* g.confirm$(ctx.you, "Pay {E}{E} to keep Liberty Prime?", ctx.source?.id, { kind: "payToKeep" }))) { g.payEnergy(ctx.you, 2); return; }
      const o = g.obj(ctx.source.id);
      if (o) g.sacrifice(o);
    };
    const text = "Whenever Liberty Prime attacks or blocks, sacrifice it unless you pay {E}{E}.";
    return [trigRun({ event: "attacks", who: "self" }, run, text), trigRun({ event: "blocks", who: "self" }, run, text)];
  }),
  "Sentry Bot": fix(["costs {1} less to cast for each creature attacking you", "you get {E} for each creature attacking you"], [
    stat({ type: "selfCostMod", per: { count: { types: ["creature"], attacking: true, controller: "opponent" } }, amount: -1 }, "This spell costs {1} less to cast for each creature attacking you."),
    trig(SELF_ENTERS, [{ op: "energy", amount: { count: { types: ["creature"], attacking: true, controller: "opponent" } } }], "When this creature enters, you get {E} for each creature attacking you."),
  ]),
  "The Motherlode, Excavator": fix(["choose target opponent. You get an amount", "you may pay {E}{E}{E}{E}"], [
    trigRun(SELF_ENTERS, function* (g, ctx) {
      const [t] = ctx.targets[0] || [];
      if (!t) return;
      const n = g.find({ types: ["land"], notSupertypes: ["basic"] }, ctx).filter((o) => o.controller === +t.slice(1)).length;
      g.getEnergy(ctx.you, n, ctx.source);
    }, "When The Motherlode enters, choose target opponent. You get an amount of {E} equal to the number of nonbasic lands that player controls.", { targets: [{ what: "opponent" }] }),
    trigRun({ event: "attacks", who: "self" }, function* (g, ctx) {
      if ((g.state.players[ctx.you].counters.energy | 0) < 4) return;
      if (!(yield* g.confirm$(ctx.you, "Pay {E}{E}{E}{E}? (destroy a nonbasic land; their creatures without flying can't block)", ctx.source?.id, { kind: "payToKeep" }))) return;
      g.payEnergy(ctx.you, 4);
      const def = ctx.event.player;
      const spec = { what: { types: ["land"], notSupertypes: ["basic"], controller: "opponent" } };
      const cands = g.find(spec.what, ctx).filter((o) => (def == null || o.controller === def) && g.isLegalTarget(o.id, spec, ctx.source, ctx.you, ctx));
      if (cands.length) { const [l] = yield* g.chooseObjects$(ctx.you, cands, { prompt: "Destroy target nonbasic land", min: 1, max: 1, reason: "target", source: ctx.source?.id }); if (l) g.destroy(l); }
      g.addUntilEOT({ type: "cantBlock", affects: { types: ["creature"], controller: "opponent", notKeywords: ["flying"] } }, ctx);
    }, "Whenever The Motherlode attacks, you may pay {E}{E}{E}{E}. When you do, destroy target nonbasic land defending player controls, and creatures that player controls without flying can't block this turn."),
  ]),
  "Synth Eradicator": fix(["exile the top card of your library. You may get"], [
    trigRun({ event: "attacks", who: "self" }, function* (g, ctx) {
      yield* g.runEffects$([{ op: "exileTop", who: "you", amount: 1, mayPlay: false }], ctx);
      const o = g.obj((ctx.it || [])[0]);
      if (yield* g.confirm$(ctx.you, "Get {E}{E}? (If not, you may play the exiled card this turn)", ctx.source?.id)) g.getEnergy(ctx.you, 2, ctx.source);
      else if (o && o.zone === "exile") o.mayPlay = { player: ctx.you, until: "endOfTurn", untilTurn: g.state.turn, turn: g.state.turn, free: false };
    }, "Whenever this creature attacks, exile the top card of your library. You may get {E}{E}. If you don't, you may play that card this turn."),
  ]),
  "Electrosiphon": fix(["Counter target spell. You get"], [], {
    spell: { targets: [{ what: "spell", zone: "stack" }], effects: [{ op: "counter", what: T(0) }, { op: "energy", amount: { cmcOf: T(0) } }] },
  }),
  "Rex, Cyber-Hound": fix(["they mill two cards and you get"], [
    trigRun({ event: "dealsCombatDamage", who: "self", to: "player" }, function* (g, ctx) {
      const t = ctx.event.target;
      if (isPid(t)) g.mill(+t.slice(1), 2);
      g.getEnergy(ctx.you, 2, ctx.source);
    }, "Whenever Rex deals combat damage to a player, they mill two cards and you get {E}{E}."),
  ], { keepUnparsed: true }),
  "T-45 Power Armor": fix(["Equipped creature gets +3/+3", "At the beginning of your upkeep, you may pay {E}"], [
    stat({ type: "pump", affects: "equipped", power: 3, toughness: 3, keywords: ["doesn't untap"] }, "Equipped creature gets +3/+3 and doesn't untap during its controller's untap step."),
    trigRun({ event: "beginStep", step: "upkeep", whose: "you" }, function* (g, ctx) {
      const eq = g.obj(g.obj(ctx.source.id)?.attachedTo);
      if (!eq || (g.state.players[ctx.you].counters.energy | 0) < 1) return;
      if (!(yield* g.confirm$(ctx.you, "Pay {E}: untap equipped creature and put a menace, trample, or lifelink counter on it?", ctx.source?.id, { kind: "payToKeep" }))) return;
      g.payEnergy(ctx.you, 1);
      g.untap(eq);
      const [c] = yield* g.choose$(ctx.you, { prompt: "Choose a counter", options: ["menace", "trample", "lifelink"].map((k) => ({ id: k, label: k, type: "text" })), min: 1, max: 1, reason: "mode", source: ctx.source?.id });
      g.addCounters(eq, c.id, 1);
    }, "At the beginning of your upkeep, you may pay {E}. If you do, untap equipped creature, then put your choice of a menace, trample, or lifelink counter on it."),
  ]),
  "HELIOS One": fix(["Pay X {E}, Sacrifice this land"], [
    actv({ mana: "{3}", tap: true, sacSelf: true, energy: "x", x: true }, [{ op: "destroy", what: T(0) }], "{3}, {T}, Pay X {E}, Sacrifice this land: Destroy target nonland permanent with mana value X. Activate only as a sorcery.",
      { sorcery: true, targets: [{ what: { notTypes: ["land"], types: ["artifact", "creature", "enchantment", "planeswalker", "battle"], cmc: { op: "==", n: "x" } } }] }),
  ]),
  "Robobrain War Mind": fix(["power is equal to the number of cards in your hand"], [
    stat({ type: "setPT", power: { handSize: "you" }, toughness: 3 }, "Robobrain War Mind's power is equal to the number of cards in your hand."),
  ]),
  "Behemoth of Vault 0": fix(["When this creature dies, you may pay an amount"], [
    trigRun({ event: "dies", who: "self" }, function* (g, ctx) {
      const [t] = ctx.targets[0] || [];
      const o = g.obj(t);
      if (!o || o.zone !== "battlefield") return;
      const n = o.c.cmc | 0;
      if ((g.state.players[ctx.you].counters.energy | 0) < n) return;
      if (!(yield* g.confirm$(ctx.you, `Pay ${n} {E} to destroy ${o.c.name}?`, ctx.source?.id, { kind: "payToKeep" }))) return;
      g.payEnergy(ctx.you, n);
      g.destroy(o);
    }, "When this creature dies, you may pay an amount of {E} equal to target nonland permanent's mana value. When you do, destroy that permanent.", { targets: [{ what: { notTypes: ["land"], types: ["artifact", "creature", "enchantment", "planeswalker", "battle"] } }] }),
  ]),
  "Localized Destruction": fix(["You get {E}, then you may pay one or more"], [], {
    spell: { effects: [], run: function* (g, ctx) {
      g.getEnergy(ctx.you, 1, ctx.source);
      const have = g.state.players[ctx.you].counters.energy | 0;
      if (!have) return;
      const n = yield* g.number$(ctx.you, "Pay how much {E}? (0 to decline) Creatures you control with that power gain indestructible", 0, have, ctx.source?.id, { kind: "x" });
      if (n < 1) return;
      g.payEnergy(ctx.you, n);
      const objs = g.find({ types: ["creature"], controller: "you", power: { op: "==", n } }, ctx);
      g.addEffect({ type: "pump", affects: "self", power: 0, toughness: 0, keywords: ["indestructible"] }, ctx, { objIds: objs.map((o) => o.id), until: "endOfTurn" });
    } },
  }),
  "Aether Refinery": fix(["If you would get one or more {E}", "You get {E}, then you may pay one or more"], [
    stat({ type: "energyMod", mul: 2 }, "If you would get one or more {E}, you get twice that many {E} instead."),
    actRun({ tap: true }, function* (g, ctx) {
      g.getEnergy(ctx.you, 1, ctx.source);
      const have = g.state.players[ctx.you].counters.energy | 0;
      if (!have) return;
      const n = yield* g.number$(ctx.you, "Pay how much {E}? (0 to decline) Create an X/X Aetherborn", 0, have, ctx.source?.id, { kind: "x" });
      if (n < 1) return;
      g.payEnergy(ctx.you, n);
      g.createToken(ctx.you, { name: "Aetherborn", types: ["creature"], subtypes: ["aetherborn"], colors: ["B"], power: n, toughness: n }, 1, { source: ctx.source });
    }, "{T}: You get {E}, then you may pay one or more {E}. If you do, create an X/X black Aetherborn creature token, where X is the amount of {E} paid this way."),
  ]),
  "Izzet Generatorium": fix(["If you would get one or more {E}"], [stat({ type: "energyMod", add: 1 }, "If you would get one or more {E}, you get that many plus one {E} instead.")]),
  "Gonti's Aether Heart": fix(["Pay eight {E}, Exile"], [
    actv({ energy: 8, exileSelf: true }, [{ op: "extraTurn" }], "Pay eight {E}, Exile Gonti's Aether Heart: Take an extra turn after this one."),
  ]),
  "Aethergeode Miner": fix(["Pay {E}{E}: Exile this creature"], [
    actv({ energy: 2 }, [{ op: "exile", what: "self" }, { op: "move", what: "self", to: "battlefield" }], "Pay {E}{E}: Exile this creature, then return it to the battlefield under its owner's control."),
  ]),
  "Aethersquall Ancient": fix(["Pay eight {E}: Return all other creatures"], [
    actv({ energy: 8 }, [{ op: "bounce", what: { ref: "all", filter: { types: ["creature"], other: true } } }], "Pay eight {E}: Return all other creatures to their owners' hands. Activate only as a sorcery.", { sorcery: true }),
  ]),
  "Goldspan Dragon": fix(["create a Treasure token", "Treasures you control have"], [
    trig({ event: "attacks", who: "self" }, [{ op: "createToken", token: "treasure", amount: 1 }], "Whenever this creature attacks, create a Treasure token."),
    trig({ event: "becomesTarget", who: "self", by: "spell" }, [{ op: "createToken", token: "treasure", amount: 1 }], "Whenever this creature becomes the target of a spell, create a Treasure token."),
    stat({ type: "pump", affects: { subtypes: ["treasure"], controller: "you" }, power: 0, toughness: 0, abilities: [treasureMana] }, "Treasures you control have \"{T}, Sacrifice this artifact: Add two mana of any one color.\""),
  ]),
  "Confiscation Coup": fix(["Choose target artifact or creature"], [], {
    spell: { targets: [{ what: { types: ["artifact", "creature"] } }], effects: [], run: function* (g, ctx) {
      g.getEnergy(ctx.you, 4, ctx.source);
      const o = g.obj((ctx.targets[0] || [])[0]);
      if (!o || o.zone !== "battlefield") return;
      const n = o.c.cmc | 0;
      if ((g.state.players[ctx.you].counters.energy | 0) < n) return;
      if (!(yield* g.confirm$(ctx.you, `Pay ${n} {E} to gain control of ${o.c.name}?`, ctx.source?.id, { kind: "payToKeep" }))) return;
      g.payEnergy(ctx.you, n);
      g.gainControl(o, ctx.you, null, ctx.source);
    } },
  }),

  // ================================================================ Hail, Caesar
  "Sierra, Nuka's Biggest Fan": fix(["The Nuka-Cola Challenge"], [
    trig({ event: "dealsCombatDamage", who: { types: ["creature"], controller: "you" }, to: "player", batch: true }, [{ op: "addCounters", what: "self", kind: "quest", amount: 1 }, { op: "createToken", token: "food", amount: 1 }], "The Nuka-Cola Challenge — Whenever one or more creatures you control deal combat damage to a player, put a quest counter on Sierra and create a Food token."),
  ]),
  "White Glove Gourmand": fix(["if another Human died under your control"], [
    trig({ event: "beginStep", step: "end", whose: "you" }, [{ op: "createToken", token: "food", amount: 1 }], "At the beginning of your end step, if another Human died under your control this turn, create a Food token.", { condition: { type: "died", filter: { subtypes: ["human"], other: true, controller: "you" } } }),
  ]),
  "Cloud, Ex-SOLDIER": fix(["attach up to one target Equipment", "draw a card for each equipped attacking creature"], [
    trig(SELF_ENTERS, [{ op: "attach", what: T(0), to: "self" }], "When Cloud enters, attach up to one target Equipment you control to it.", { targets: [{ what: { subtypes: ["equipment"], controller: "you" }, min: 0, max: 1 }] }),
    trigRun({ event: "attacks", who: "self" }, function* (g, ctx) {
      const n = g.find({ types: ["creature"], controller: "you", attacking: true }, ctx).filter((o) => (o.attachments || []).some((id) => g.obj(id)?.c.subtypes.includes("equipment"))).length;
      if (n) g.draw(ctx.you, n);
      if ((g.obj(ctx.source.id)?.c.power | 0) >= 7) g.createToken(ctx.you, "treasure", 2, { source: ctx.source });
    }, "Whenever Cloud attacks, draw a card for each equipped attacking creature you control. Then if Cloud has power 7 or greater, create two Treasure tokens."),
  ]),
  "Path of Discovery": fix(["it explores"], [
    trig({ event: "enters", who: { types: ["creature"], controller: "you" } }, [{ op: "explore", what: EVT_OBJ }], "Whenever a creature you control enters, it explores."),
  ]),
  "Grateful Apparition": fix(["deals combat damage to a player or planeswalker"], [
    trigRun({ event: "dealsCombatDamage", who: "self", to: "any" }, function* (g, ctx) {
      const t = ctx.event.target;
      if (!isPid(t) && !g.obj(t)?.c.types.includes("planeswalker")) return;
      yield* g.runEffects$([{ op: "proliferate" }], ctx);
    }, "Whenever this creature deals combat damage to a player or planeswalker, proliferate."),
  ]),
  "Champions from Beyond": fix(["Full Party"], [
    trig({ event: "attackBatch", who: "you", n: 8 }, [{ op: "pump", what: { ref: "all", filter: { types: ["creature"], controller: "you", attacking: true } }, power: 4, toughness: 4, keywords: [], until: "endOfTurn" }], "Full Party — Whenever you attack with eight or more creatures, those creatures get +4/+4 until end of turn."),
  ]),

  // ================================================================ Job select equipment
  "Dancer's Chakrams": fix(["Job select", "Equipped creature gets +2/+2"], [
    jobSelect,
    stat({ type: "pump", affects: "equipped", power: 2, toughness: 2, keywords: ["lifelink"], abilities: [stat({ type: "pump", affects: { isCommander: true, controller: "you", other: true }, power: 2, toughness: 2, keywords: ["lifelink"] }, "Other commanders you control get +2/+2 and have lifelink.")] }, "Equipped creature gets +2/+2, has lifelink and \"Other commanders you control get +2/+2 and have lifelink,\""),
    stat({ type: "asType", affects: "equipped", addSubtypes: ["performer"] }, "and is a Performer in addition to its other types."),
  ]),
  "Astrologian's Planisphere": fix(["Job select", "Equipped creature is a Wizard"], [
    jobSelect,
    stat({ type: "asType", affects: "equipped", addSubtypes: ["wizard"] }, "Equipped creature is a Wizard in addition to its other types"),
    stat({ type: "pump", affects: "equipped", power: 0, toughness: 0, abilities: [
      trig({ event: "cast", who: "you", filter: { notTypes: ["creature"] } }, [{ op: "addCounters", what: "self", kind: "+1/+1", amount: 1 }], "Whenever you cast a noncreature spell, put a +1/+1 counter on this creature."),
      trig({ event: "draw", who: "you", nth: 3 }, [{ op: "addCounters", what: "self", kind: "+1/+1", amount: 1 }], "Whenever you draw your third card each turn, put a +1/+1 counter on this creature."),
    ] }, "and has \"Whenever you cast a noncreature spell and whenever you draw your third card each turn, put a +1/+1 counter on this creature.\""),
  ]),
  "Reaper's Scythe": fix(["Job select", "put a soul counter", "Equipped creature gets +1/+1 for each soul"], [
    jobSelect,
    trigRun({ event: "beginStep", step: "end", whose: "you" }, function* (g, ctx) {
      const n = g.state.players.filter((p) => !p.lost && p.lifeLostThisTurn > 0).length;
      const o = g.obj(ctx.source.id);
      if (n && o) g.addCounters(o, "soul", n);
    }, "At the beginning of your end step, put a soul counter on this Equipment for each player who lost life this turn."),
    stat({ type: "pump", affects: "equipped", power: { countersOn: "self", kind: "soul" }, toughness: { countersOn: "self", kind: "soul" } }, "Equipped creature gets +1/+1 for each soul counter on this Equipment"),
    stat({ type: "asType", affects: "equipped", addSubtypes: ["assassin"] }, "and is an Assassin in addition to its other types."),
  ]),
  "Sage's Nouliths": fix(["Job select", "Equipped creature gets +1/+0"], [
    jobSelect,
    stat({ type: "pump", affects: "equipped", power: 1, toughness: 0, abilities: [
      trig({ event: "attacks", who: "self" }, [{ op: "untap", what: T(0) }], "Whenever this creature attacks, untap target attacking creature.", { targets: [{ what: { types: ["creature"], attacking: true } }] }),
    ] }, "Equipped creature gets +1/+0, has \"Whenever this creature attacks, untap target attacking creature,\""),
    stat({ type: "asType", affects: "equipped", addSubtypes: ["cleric"] }, "and is a Cleric in addition to its other types."),
  ]),

  // ================================================================ misc treasure / food
  "Prismari Command": {
    patch(def) {
      return out(def, { spell: { modes: { min: 2, max: 2, modes: [
        { text: "Prismari Command deals 2 damage to any target.", targets: [{ what: "any" }], effects: [{ op: "damage", amount: 2, to: T(0) }] },
        { text: "Target player draws two cards, then discards two cards.", targets: [{ what: "player" }], effects: [{ op: "draw", who: T(0), amount: 2 }, { op: "discard", who: T(0), amount: 2 }] },
        { text: "Target player creates a Treasure token.", targets: [{ what: "player" }], effects: [{ op: "createToken", who: T(0), token: "treasure", amount: 1 }] },
        { text: "Destroy target artifact.", targets: [{ what: { types: ["artifact"] } }], effects: [{ op: "destroy", what: T(0) }] },
      ] }, effects: [] } }, []);
    },
  },
  "Teval's Judgment": fix(["Whenever one or more cards leave your graveyard"], [
    trigRun({ event: "zoneChange", from: "graveyard", filter: { owner: "you" } }, function* (g, ctx) {
      const src = g.obj(ctx.source.id);
      if (!src) return;
      if (!src._tj || src._tj.turn !== g.state.turn) src._tj = { turn: g.state.turn, used: [] };
      const all = [["draw", "Draw a card"], ["treasure", "Create a Treasure token"], ["zombie", "Create a 2/2 black Zombie Druid creature token"]];
      const opts = all.filter(([id]) => !src._tj.used.includes(id)).map(([id, label]) => ({ id, label, type: "mode" }));
      if (!opts.length) return;
      const [c] = yield* g.choose$(ctx.you, { prompt: "Choose one that hasn't been chosen this turn", options: opts, min: 1, max: 1, reason: "mode", source: src.id });
      src._tj.used.push(c.id);
      if (c.id === "draw") g.draw(ctx.you, 1);
      else if (c.id === "treasure") g.createToken(ctx.you, "treasure", 1, { source: src });
      else g.createToken(ctx.you, { name: "Zombie Druid", types: ["creature"], subtypes: ["zombie", "druid"], colors: ["B"], power: 2, toughness: 2 }, 1, { source: src });
    }, "Whenever one or more cards leave your graveyard, choose one that hasn't been chosen this turn — Draw a card; create a Treasure token; create a 2/2 black Zombie Druid creature token."),
  ]),
  "Gadrak, the Crown-Scourge": fix(["can't attack unless", "create a Treasure token for each nontoken creature"], [
    stat({ type: "cantAttack", affects: "self" }, "Gadrak can't attack unless you control four or more artifacts.", { condition: { type: "control", filter: { types: ["artifact"], controller: "you" }, op: "<", n: 4 } }),
    trig({ event: "beginStep", step: "end", whose: "you" }, [{ op: "createToken", token: "treasure", amount: { diedThisTurn: { types: ["creature"], nontoken: true } } }], "At the beginning of your end step, create a Treasure token for each nontoken creature that died this turn."),
  ]),
  "Academy Manufactor": fix(["If you would create a Clue"], [stat({ type: "createAllPredef" }, "If you would create a Clue, Food, or Treasure token, instead create one of each.")]),
  "Bootleggers' Stash": fix(["Lands you control have"], [
    stat({ type: "pump", affects: { types: ["land"], controller: "you" }, power: 0, toughness: 0, abilities: [actv({ tap: true }, [{ op: "createToken", token: "treasure", amount: 1 }], "{T}: Create a Treasure token.")] }, "Lands you control have \"{T}: Create a Treasure token.\""),
  ]),
  "The Reaver Cleaver": fix(["Equipped creature gets +1/+1 and has trample"], [
    stat({ type: "pump", affects: "equipped", power: 1, toughness: 1, keywords: ["trample"], abilities: [
      trigRun({ event: "dealsCombatDamage", who: "self", to: "any" }, function* (g, ctx) {
        const t = ctx.event.target;
        if (!isPid(t) && !g.obj(t)?.c.types.includes("planeswalker")) return;
        g.createToken(ctx.you, "treasure", ctx.event.amount | 0, { source: ctx.source });
      }, "Whenever this creature deals combat damage to a player or planeswalker, create that many Treasure tokens."),
    ] }, "Equipped creature gets +1/+1 and has trample and \"Whenever this creature deals combat damage to a player or planeswalker, create that many Treasure tokens.\""),
  ]),
  "Ziatora, the Incinerator": fix(["you may sacrifice another creature"], [
    trigRun({ event: "beginStep", step: "end", whose: "you" }, function* (g, ctx) {
      const cands = g.find({ types: ["creature"], controller: "you", other: true }, ctx);
      if (!cands.length) return;
      const [s] = yield* g.chooseObjects$(ctx.you, cands, { prompt: "You may sacrifice another creature (Ziatora deals damage equal to its power; create three Treasures)", min: 0, max: 1, reason: "sacrifice", source: ctx.source?.id });
      if (!s) return;
      const pw = Math.max(0, s.c.power | 0);
      g.sacrifice(s);
      g.createToken(ctx.you, "treasure", 3, { source: ctx.source });
      const ts = yield* g.chooseTargets$(ctx.you, [{ what: "any" }], ctx.source, ctx);
      const id = ts && ts[0] && ts[0][0];
      if (id) g.dealDamage(g.obj(ctx.source.id) || ctx.source, id, pw);
    }, "At the beginning of your end step, you may sacrifice another creature. When you do, Ziatora deals damage equal to that creature's power to any target and you create three Treasure tokens."),
  ]),
  "Ugin's Insight": fix(["Scry X, where X is the greatest"], [], {
    spell: { effects: [{ op: "scry", amount: { greatest: "cmc", of: { controller: "you" } } }, { op: "draw", who: "you", amount: 3 }] },
  }),
  "Olivia, Opulent Outlaw": fix(["one or more outlaws you control deal combat damage"], [
    trig({ event: "dealsCombatDamage", who: { types: ["creature"], subtypes: OUTLAW, controller: "you" }, to: "player", batch: true }, [{ op: "createToken", token: "treasure", amount: 1 }], "Whenever one or more outlaws you control deal combat damage to a player, create a Treasure token."),
  ]),
  "Vihaan, Goldwaker": fix(["Other outlaws you control have vigilance", "Treasures you control become 3/3"], [
    stat({ type: "pump", affects: { types: ["creature"], subtypes: OUTLAW, controller: "you", other: true }, power: 0, toughness: 0, keywords: ["vigilance", "haste"] }, "Other outlaws you control have vigilance and haste."),
    trig({ event: "beginStep", step: "beginCombat", whose: "you" }, [{ op: "may", effects: [{ op: "animate", what: { ref: "all", filter: { subtypes: ["treasure"], controller: "you" } }, power: 3, toughness: 3, types: ["creature"], subtypes: ["construct", "assassin"], colors: [], keywords: [], until: "endOfTurn" }] }], "At the beginning of combat on your turn, you may have Treasures you control become 3/3 Construct Assassin artifact creatures in addition to their other types until end of turn."),
  ]),
  "Council's Judgment": fix(["Will of the council"], [], {
    spell: { effects: [], run: function* (g, ctx) {
      const cands = g.find({ notTypes: ["land"], types: ["artifact", "creature", "enchantment", "planeswalker", "battle"] }, ctx).filter((o) => o.controller !== ctx.you && g.isLegalTarget === undefined ? true : true);
      const legal = cands.filter((o) => !g.hasKw(o, "hexproof") || o.controller === ctx.you);
      if (!legal.length) return;
      const r = yield* g.vote$({ source: ctx.source, you: ctx.you, prompt: "Vote for a nonland permanent you (the caster) don't control", options: legal.map((o) => ({ id: o.id, label: g.objLabel(o, ctx.you), type: "object" })), score: (v, id) => { const o = g.obj(id); const w = objVal(g, o); return o.controller === v ? -w : w; } });
      for (const id of r.winners) { const o = g.obj(id); if (o && o.zone === "battlefield") g.exile(o); }
    } },
  }),
  "Misfortune Teller": fix(["exile target card from a graveyard"], () => {
    const run = function* (g, ctx) {
      const o = g.obj((ctx.targets[0] || [])[0]);
      if (!o || o.zone !== "graveyard") return;
      const isC = o.c.types.includes("creature"), isL = o.c.types.includes("land");
      g.exile(o);
      if (isC) g.createToken(ctx.you, { name: "Rogue", types: ["creature"], subtypes: ["rogue"], colors: ["B"], power: 2, toughness: 2 }, 1, { source: ctx.source });
      else if (isL) g.createToken(ctx.you, "treasure", 1, { source: ctx.source });
      else g.gainLife(ctx.you, 3);
    };
    const text = "Whenever this creature enters or deals combat damage to a player, exile target card from a graveyard. If it was a creature card, create a 2/2 black Rogue creature token. If it was a land card, create a Treasure token. Otherwise, you gain 3 life.";
    const targets = [{ what: { zone: "graveyard" } }];
    return [trigRun(SELF_ENTERS, run, text, { targets }), trigRun({ event: "dealsCombatDamage", who: "self", to: "player" }, run, text, { targets })];
  }),
  "Seize the Spotlight": fix(["Each opponent chooses fame or fortune"], [], {
    spell: { effects: [], run: function* (g, ctx) {
      for (const q of g.opponentsOf(ctx.you)) {
        const [c] = yield* g.choose$(q, { prompt: "Choose fame or fortune", options: [{ id: "fame", label: "Fame (they gain control of one of your creatures this turn)", type: "text" }, { id: "fortune", label: "Fortune (they draw a card and create a Treasure)", type: "text" }], min: 1, max: 1, reason: "mode", source: ctx.source?.id, hint: { kind: "fameFortune" } });
        if (c.id === "fame") {
          const cands = g.find({ types: ["creature"] }, ctx).filter((o) => o.controller === q);
          const [t] = yield* g.chooseObjects$(ctx.you, cands, { prompt: "Gain control of a creature that player controls until end of turn", min: cands.length ? 1 : 0, max: 1, reason: "target", source: ctx.source?.id });
          if (t) { g.gainControl(t, ctx.you, "endOfTurn", ctx.source); g.untap(t); g.pumpUntilEOT(t, { power: 0, toughness: 0, keywords: ["haste"] }); }
        } else { g.draw(ctx.you, 1); g.createToken(ctx.you, "treasure", 1, { source: ctx.source }); }
      }
    } },
  }),
  "Bandit's Haul": fix(["Whenever you commit a crime"], [
    trigRun({ event: "crime", who: "you" }, function* (g, ctx) {
      const s = g.obj(ctx.source.id);
      if (!s || s._haulTurn === g.state.turn) return;
      s._haulTurn = g.state.turn;
      g.addCounters(s, "loot", 1);
    }, "Whenever you commit a crime, put a loot counter on this artifact. This ability triggers only once each turn."),
  ]),
  "Patrolling Peacemaker": fix(["commits a crime"], [
    trig({ event: "crime", who: "opponent" }, [{ op: "proliferate" }], "Whenever an opponent commits a crime, proliferate."),
  ]),
  "Thieving Amalgam": fix(["you manifest the top card", "but don't own dies"], [
    trigRun({ event: "beginStep", step: "upkeep", whose: "opponent" }, function* (g, ctx) {
      yield* g.manifest$(ctx.you, 1, { owner: ctx.event.player });
    }, "At the beginning of each opponent's upkeep, you manifest the top card of that player's library."),
    trig({ event: "dies", who: { types: ["creature"], controller: "you", owner: "opponent" } }, [{ op: "loseLife", who: { ref: "ownerOf", of: EVT_OBJ }, amount: 2 }, { op: "gainLife", who: "you", amount: 2 }], "Whenever a creature you control but don't own dies, its owner loses 2 life and you gain 2 life."),
  ]),
  "Copy Catchers": fix(["Whenever you surveil"], [
    trig({ event: "surveil", who: "you" }, [{ op: "may", cost: { mana: "{1}{U}" }, effects: [{ op: "createToken", copyOf: "self", amount: 1 }] }], "Whenever you surveil, you may pay {1}{U}. If you do, create a token that's a copy of this creature."),
  ]),
  "Unshakable Tail": fix(["surveil 1", "creature cards are put into your graveyard from your library"], [
    trig(SELF_ENTERS, [{ op: "surveil", amount: 1 }], "When this creature enters, surveil 1."),
    trig({ event: "beginStep", step: "upkeep", whose: "you" }, [{ op: "surveil", amount: 1 }], "At the beginning of your upkeep, surveil 1."),
    trig({ event: "zoneChange", from: "library", to: "graveyard", filter: { types: ["creature"], owner: "you" } }, [{ op: "investigate", amount: 1 }], "Whenever one or more creature cards are put into your graveyard from your library, investigate.", { once: true }),
  ]),
  "Dream Eater": fix(["surveil 4. When you do"], [
    trigRun(SELF_ENTERS, function* (g, ctx) {
      yield* g.runEffects$([{ op: "surveil", amount: 4 }], ctx);
      const spec = { what: { notTypes: ["land"], types: ["artifact", "creature", "enchantment", "planeswalker", "battle"], controller: "opponent" } };
      const cands = g.find(spec.what, ctx).filter((o) => g.isLegalTarget(o.id, spec, ctx.source, ctx.you, ctx));
      if (!cands.length) return;
      const [t] = yield* g.chooseObjects$(ctx.you, cands, { prompt: "You may return target nonland permanent an opponent controls to its owner's hand", min: 0, max: 1, reason: "return", source: ctx.source?.id });
      if (t) g.bounce(t);
    }, "When this creature enters, surveil 4. When you do, you may return target nonland permanent an opponent controls to its owner's hand."),
  ]),
  "Twilight Prophet": fix(["reveal the top card of your library and put it into your hand"], [
    trigRun({ event: "beginStep", step: "upkeep", whose: "you" }, function* (g, ctx) {
      const pl = g.state.players[ctx.you];
      const top = pl.library.length ? g.obj(pl.library[pl.library.length - 1]) : null;
      if (!top) return;
      const x = top.c.cmc | 0;
      g.emit({ t: "reveal", objs: [top.id], player: ctx.you, text: `${pl.name} reveals ${top.c.name}` });
      g.moveObj(top, "hand");
      for (const q of g.opponentsOf(ctx.you)) g.loseLife(q, x);
      g.gainLife(ctx.you, x);
    }, "At the beginning of your upkeep, if you have the city's blessing, reveal the top card of your library and put it into your hand. Each opponent loses X life and you gain X life, where X is that card's mana value.", { condition: { type: "blessing" } }),
  ]),
  "Enhanced Surveillance": fix(["additional two cards each time you surveil", "Exile this enchantment: Shuffle"], [
    stat({ type: "surveilExtra", n: 2 }, "You may look at an additional two cards each time you surveil."),
    actRun({ exileSelf: true }, function* (g, ctx) {
      for (const id of [...g.state.players[ctx.you].graveyard]) g.moveObj(g.obj(id), "library", { position: "top", quiet: true });
      g.shuffle(ctx.you);
    }, "Exile this enchantment: Shuffle your graveyard into your library."),
  ]),
  "Dimir Spybug": fix(["Whenever you surveil"], [trig({ event: "surveil", who: "you" }, [{ op: "addCounters", what: "self", kind: "+1/+1", amount: 1 }], "Whenever you surveil, put a +1/+1 counter on this creature.")]),
  "Whispering Snitch": fix(["for the first time each turn"], [trig({ event: "surveil", who: "you", nth: 1 }, [{ op: "damage", amount: 1, to: "opponent" }, { op: "gainLife", who: "you", amount: 1 }], "Whenever you surveil for the first time each turn, this creature deals 1 damage to each opponent and you gain 1 life.")]),
  "Disinformation Campaign": fix(["Whenever you surveil"], [trig({ event: "surveil", who: "you" }, [{ op: "bounce", what: "self" }], "Whenever you surveil, return this enchantment to its owner's hand.")]),
  "Morska, Undersea Sleuth": fix(["investigate", "second card each turn"], [
    trig({ event: "beginStep", step: "upkeep", whose: "you" }, [{ op: "investigate", amount: 1 }], "At the beginning of your upkeep, investigate."),
    trig({ event: "draw", who: "you", nth: 2 }, [{ op: "addCounters", what: "self", kind: "+1/+1", amount: 2 }], "Whenever you draw your second card each turn, put two +1/+1 counters on Morska."),
  ]),
  "Detective of the Month": fix(["city's blessing, Detectives", "second card each turn"], [
    stat({ type: "cantBeBlocked", affects: { types: ["creature"], subtypes: ["detective"], controller: "you" } }, "As long as you have the city's blessing, Detectives you control can't be blocked.", { condition: { type: "blessing" } }),
    trig({ event: "draw", who: "you", nth: 2 }, [{ op: "createToken", token: { name: "Detective", types: ["creature"], subtypes: ["detective"], colors: ["W", "U"], power: 2, toughness: 2 }, amount: 1 }], "Whenever you draw your second card each turn, create a 2/2 white and blue Detective creature token."),
  ]),
  "Ethereal Investigator": fix(["investigate X times", "second card each turn"], [
    trig(SELF_ENTERS, [{ op: "investigate", amount: { numOpponents: true } }], "When this creature enters, investigate X times, where X is the number of opponents you have."),
    trig({ event: "draw", who: "you", nth: 2 }, [{ op: "createToken", token: { name: "Spirit", types: ["creature"], subtypes: ["spirit"], colors: ["W"], power: 1, toughness: 1, keywords: ["flying"] }, amount: 1 }], "Whenever you draw your second card each turn, create a 1/1 white Spirit creature token with flying."),
  ]),
  "Erdwal Illuminator": fix(["investigate for the first time"], [trig({ event: "investigate", who: "you", nth: 1 }, [{ op: "investigate", amount: 1 }], "Whenever you investigate for the first time each turn, investigate an additional time.")]),
  "Follow the Bodies": fix(["Gravestorm", "Investigate"], [
    trigRun({ event: "cast", who: "self" }, function* (g, ctx) {
      const n = Math.max(0, g.permsToGraveThisTurn());
      for (let i = 0; i < n; i++) yield* g.runEffects$([{ op: "copySpell", what: EVT_OBJ }], ctx);
    }, "Gravestorm (When you cast this spell, copy it for each permanent put into a graveyard this turn.)", { zone: "stack" }),
  ], { spell: { effects: [{ op: "investigate", amount: 1 }] } }),
  "Search the Premises": fix(["attacks you or a planeswalker you control"], [
    trigRun({ event: "attacks", who: { types: ["creature"], controller: "opponent" } }, function* (g, ctx) {
      if (ctx.event.player !== ctx.you) return;
      g.investigate(ctx.you, ctx.source);
    }, "Whenever a creature attacks you or a planeswalker you control, investigate."),
  ]),
  "Killer Service": fix(["create a number of Food tokens", "you may pay {2} and sacrifice a token"], [
    trig(SELF_ENTERS, [{ op: "createToken", token: "food", amount: { numOpponents: true } }], "When this enchantment enters, create a number of Food tokens equal to the number of opponents you have."),
    trigRun({ event: "beginStep", step: "end", whose: "you" }, function* (g, ctx) {
      const toks = g.find({ token: true, controller: "you" }, ctx);
      if (!toks.length || !g.canPayMana(ctx.you, { generic: 2 })) return;
      if (!(yield* g.confirm$(ctx.you, "Pay {2} and sacrifice a token to create a 4/4 Rhino Warrior?", ctx.source?.id, { kind: "payToKeep" }))) return;
      if (!(yield* g.payCost$(ctx.you, { mana: "{2}" }, ctx))) return;
      const [t] = yield* g.chooseObjects$(ctx.you, toks, { prompt: "Sacrifice a token", min: 1, max: 1, reason: "sacrifice", source: ctx.source?.id });
      if (t) g.sacrifice(t);
      g.createToken(ctx.you, { name: "Rhino Warrior", types: ["creature"], subtypes: ["rhino", "warrior"], colors: ["G"], power: 4, toughness: 4 }, 1, { source: ctx.source });
    }, "At the beginning of your end step, you may pay {2} and sacrifice a token. If you do, create a 4/4 green Rhino Warrior creature token."),
  ]),
  "Ulvenwald Mysteries": fix(["nontoken creature you control dies"], [trig({ event: "dies", who: { types: ["creature"], controller: "you", token: false } }, [{ op: "investigate", amount: 1 }], "Whenever a nontoken creature you control dies, investigate.")]),
  "Magnifying Glass": fix(["{4}, {T}: Investigate"], [actv({ mana: "{4}", tap: true }, [{ op: "investigate", amount: 1 }], "{4}, {T}: Investigate.")]),
  "Confirm Suspicions": fix(["Investigate three times"], [], { spell: { effects: [{ op: "investigate", amount: 3 }] } }),
  "Inquisitor Greyfax": fix(["Hunt for Heresy"], [actv({ mana: "{1}", tap: true }, [{ op: "tap", what: T(0) }, { op: "investigate", amount: 1 }], "Hunt for Heresy — {1}, {T}: Tap target creature an opponent controls. Investigate.", { targets: [{ what: { types: ["creature"], controller: "opponent" } }] })]),
  "Sophia, Dogged Detective": fix(["create Tiny", "Whenever a Dog you control"], [
    trig(SELF_ENTERS, [{ op: "createToken", token: { name: "Tiny", types: ["creature"], subtypes: ["dog", "detective"], supertypes: ["legendary"], colors: ["G"], power: 2, toughness: 2, keywords: ["trample"] }, amount: 1 }], "When Sophia enters, create Tiny, a legendary 2/2 green Dog Detective creature token with trample."),
    trig({ event: "dealsCombatDamage", who: { types: ["creature"], subtypes: ["dog"], controller: "you" }, to: "player" }, [{ op: "createToken", token: "food", amount: 1 }, { op: "investigate", amount: 1 }], "Whenever a Dog you control deals combat damage to a player, create a Food token, then investigate."),
  ]),
  "Armed with Proof": fix(["investigate twice", "Clues you control are Equipment"], [
    trig(SELF_ENTERS, [{ op: "investigate", amount: 2 }], "When this enchantment enters, investigate twice."),
    stat({ type: "asType", affects: { subtypes: ["clue"], controller: "you" }, addTypes: [], addSubtypes: ["equipment"] }, "Clues you control are Equipment in addition to their other types"),
    stat({ type: "pump", affects: { subtypes: ["clue"], controller: "you" }, power: 0, toughness: 0, abilities: [
      stat({ type: "pump", affects: "equipped", power: 2, toughness: 0 }, "Equipped creature gets +2/+0."),
      actv({ mana: "{2}" }, [{ op: "attach", what: "self", to: T(0) }], "Equip {2}", { sorcery: true, targets: [{ what: { types: ["creature"], controller: "you" } }] }),
    ] }, "and have \"Equipped creature gets +2/+0\" and equip {2}."),
  ]),
  "Gemcutter Buccaneer": fix(["Treasures you control are Equipment"], [
    stat({ type: "asType", affects: { subtypes: ["treasure"], controller: "you" }, addSubtypes: ["equipment"] }, "Treasures you control are Equipment in addition to their other types"),
    stat({ type: "pump", affects: { subtypes: ["treasure"], controller: "you" }, power: 0, toughness: 0, abilities: [
      stat({ type: "pump", affects: "equipped", power: 2, toughness: 0 }, "Equipped creature gets +2/+0."),
      actv({ mana: "{1}" }, [{ op: "attach", what: "self", to: T(0) }], "Equip Pirate {1}", { sorcery: true, targets: [{ what: { types: ["creature"], subtypes: ["pirate"], controller: "you" } }] }),
      actv({ mana: "{3}" }, [{ op: "attach", what: "self", to: T(0) }], "Equip {3}", { sorcery: true, targets: [{ what: { types: ["creature"], controller: "you" } }] }),
    ] }, "and have \"Equipped creature gets +2/+0,\" equip Pirate {1}, and equip {3}."),
  ]),

  // ================================================================ face-down
  "Reality Shift": fix(["Exile target creature. Its controller manifests"], [], {
    spell: { targets: [{ what: { types: ["creature"] } }], effects: [], run: function* (g, ctx) {
      const o = g.obj((ctx.targets[0] || [])[0]);
      if (!o || o.zone !== "battlefield") return;
      const ctl = o.controller;
      g.exile(o);
      yield* g.manifest$(ctl, 1, { owner: ctl });
    } },
  }),
  "Unexplained Absence": fix(["For each player, exile up to one target"], [], {
    spell: { targets: [{ what: { notTypes: ["land"], types: ["artifact", "creature", "enchantment", "planeswalker", "battle"], controller: "you" }, min: 0, max: 1 }, { what: { notTypes: ["land"], types: ["artifact", "creature", "enchantment", "planeswalker", "battle"], controller: "opponent" }, min: 0, max: 1 }], effects: [], run: function* (g, ctx) {
      const ctls = [];
      for (const t of ctx.targets) for (const id of t || []) { const o = g.obj(id); if (o && o.zone === "battlefield") { ctls.push(o.controller); g.exile(o); } }
      for (const c of ctls) yield* g.manifest$(c, 1, { owner: c, cloak: true });
    } },
  }),
  "Veiled Ascension": fix(["put a flying counter on each face-down", "Face-down creatures you control enter", "cloak the top card"], [
    trigRun(SELF_ENTERS, function* (g, ctx) { for (const o of g.find({ types: ["creature"], controller: "you", faceDown: true }, ctx)) g.addCounters(o, "flying", 1); }, "When this enchantment enters, put a flying counter on each face-down creature you control."),
    stat({ type: "faceDownCounter", kind: "flying" }, "Face-down creatures you control enter with a flying counter on them."),
    trigRun({ event: "beginStep", step: "upkeep", whose: "you" }, function* (g, ctx) {
      if (yield* g.confirm$(ctx.you, "Cloak the top card of your library?", ctx.source?.id)) yield* g.manifest$(ctx.you, 1, { owner: ctx.you, cloak: true });
    }, "At the beginning of your upkeep, you may cloak the top card of your library."),
  ]),
  "Experiment Twelve": fix(["is turned face up, put +1/+1 counters"], [
    trig({ event: "turnedFaceUp", who: { types: ["creature"], controller: "you" } }, [{ op: "addCounters", what: EVT_OBJ, kind: "+1/+1", amount: { powerOf: EVT_OBJ } }], "Whenever this creature or another creature you control is turned face up, put +1/+1 counters on that creature equal to its power."),
  ]),
  "Printlifter Ooze": fix(["is turned face up, create a 0/0"], [
    trigRun({ event: "turnedFaceUp", who: { types: ["creature"], controller: "you" } }, function* (g, ctx) {
      const n = g.find({ types: ["creature"], controller: "you", other: true }, ctx).length;
      const [t] = g.createToken(ctx.you, { name: "Ooze", types: ["creature"], subtypes: ["ooze"], colors: ["G"], power: 0, toughness: 0, keywords: ["trample"] }, 1, { source: ctx.source });
      if (t) g.addCounters(t, "+1/+1", n);
    }, "Whenever this creature or another creature you control is turned face up, create a 0/0 green Ooze creature token with trample. The token enters with X +1/+1 counters on it, where X is the number of other creatures you control."),
  ]),
  "True Identity": fix(["is turned face up, scry 1"], [
    trigRun({ event: "turnedFaceUp", who: { controller: "you" } }, function* (g, ctx) {
      const s = g.obj(ctx.source.id);
      if (!s || s._tiTurn === g.state.turn) return;
      s._tiTurn = g.state.turn;
      yield* g.runEffects$([{ op: "scry", amount: 1 }], ctx);
      g.draw(ctx.you, 1);
    }, "Whenever this enchantment or another permanent you control is turned face up, scry 1, then draw a card. This ability triggers only once each turn."),
  ]),
  "Ugin's Mastery": fix(["colorless creature spell, manifest", "total power 6 or greater"], [
    trig({ event: "cast", who: "you", filter: { types: ["creature"], colors: ["colorless"] } }, [{ op: "manifest", amount: 1 }], "Whenever you cast a colorless creature spell, manifest the top card of your library."),
    trigRun({ event: "attackBatch", who: "you", n: 1 }, function* (g, ctx) {
      const total = (ctx.event.objs || []).reduce((n, o) => n + Math.max(0, o.c.power | 0), 0);
      if (total < 6) return;
      const cands = g.find({ types: ["creature"], controller: "you", faceDown: true }, ctx);
      if (!cands.length) return;
      const [c] = yield* g.chooseObjects$(ctx.you, cands, { prompt: "You may turn a face-down creature you control face up", min: 0, max: 1, reason: "generic", source: ctx.source?.id });
      if (!c) return;
      c.faceDown = false; g.markDirty(); g.refresh();
      g.emit({ t: "faceUp", obj: c.id, player: ctx.you, text: `${c.c.name} is turned face up` });
      g.fireTrigger({ type: "turnedFaceUp", obj: c, player: ctx.you });
    }, "Whenever you attack with creatures with total power 6 or greater, you may turn a face-down creature you control face up."),
  ]),
  "Mastery of the Unseen": fix(["is turned face up, you gain 1 life", "Manifest the top card"], [
    trig({ event: "turnedFaceUp", who: { controller: "you" } }, [{ op: "gainLife", who: "you", amount: { count: { types: ["creature"], controller: "you" } } }], "Whenever a permanent you control is turned face up, you gain 1 life for each creature you control."),
    actv({ mana: "{3}{W}" }, [{ op: "manifest", amount: 1 }], "{3}{W}: Manifest the top card of your library."),
  ]),
  "Whisperwood Elemental": fix(["manifest the top card of your library.", "Sacrifice this creature: Until end of turn"], [
    trig({ event: "beginStep", step: "end", whose: "you" }, [{ op: "manifest", amount: 1 }], "At the beginning of your end step, manifest the top card of your library."),
    actRun({ sacSelf: true }, function* (g, ctx) {
      const objs = g.find({ types: ["creature"], controller: "you", faceDown: false, token: false }, ctx);
      g.addEffect({ type: "pump", affects: "self", power: 0, toughness: 0, abilities: [trig({ event: "dies", who: "self" }, [{ op: "manifest", amount: 1 }], "When this creature dies, manifest the top card of your library.")] }, ctx, { objIds: objs.map((o) => o.id), until: "endOfTurn" });
    }, "Sacrifice this creature: Until end of turn, face-up nontoken creatures you control gain \"When this creature dies, manifest the top card of your library.\""),
  ]),
  "Scroll of Fate": fix(["Manifest a card from your hand"], [
    actRun({ tap: true }, function* (g, ctx) {
      const hand = g.state.players[ctx.you].hand.map((id) => g.obj(id));
      if (!hand.length) return;
      const [c] = yield* g.chooseObjects$(ctx.you, hand, { prompt: "Manifest a card from your hand", min: 1, max: 1, reason: "generic", source: ctx.source?.id });
      if (c) yield* g.manifest$(ctx.you, 1, { cards: [c] });
    }, "{T}: Manifest a card from your hand."),
  ]),
  "Nervous Gardener": fix(["turned face up, search your library"], [
    trig({ event: "turnedFaceUp", who: "self" }, [{ op: "search", who: "you", filter: { types: ["land"], subtypes: ["plains", "island", "swamp", "mountain", "forest"] }, min: 0, max: 1, to: "hand", reveal: true }, { op: "shuffle", who: "you" }], "When this creature is turned face up, search your library for a land card with a basic land type, reveal it, put it into your hand, then shuffle."),
  ]),

  // ================================================================ voting / misc
  "Mob Verdict": fix(["Secret council"], [], {
    spell: { effects: [], run: function* (g, ctx) {
      const opts = g.state.players.filter((p) => !p.lost).map((p) => ({ id: pid(p.idx), label: p.name, type: "player" }));
      const r = yield* g.vote$({ source: ctx.source, you: ctx.you, secret: true, prompt: "Secretly vote for another player", options: opts.filter((o) => true), score: (v, id) => (id === pid(v) ? -10 : v === ctx.you ? 1 : 0) });
      for (const q of g.opponentsOf(ctx.you)) {
        const n = r.tally[pid(q)] | 0;
        for (let i = 0; i < n; i++) {
          g.dealDamage(ctx.source, pid(q), 2);
          for (const o of g.find({ types: ["creature"] }, ctx).filter((c) => c.controller === q)) g.dealDamage(ctx.source, o.id, 2);
        }
      }
      const mine = r.tally[pid(ctx.you)] | 0;
      if (mine) g.draw(ctx.you, mine);
    } },
  }),
  "Selvala's Stampede": fix(["Council's dilemma"], [], {
    spell: { effects: [], run: function* (g, ctx) {
      const r = yield* g.vote$({ source: ctx.source, you: ctx.you, prompt: "Vote: wild or free", options: [{ id: "wild", label: "Wild (reveal until a creature, put it onto the battlefield)", type: "text" }, { id: "free", label: "Free (put a permanent card from hand onto the battlefield)", type: "text" }], score: (v, id) => (v === ctx.you ? (id === "wild" ? 2 : 1) : (id === "free" ? 2 : 1)) });
      const pl = g.state.players[ctx.you];
      const revealed = [];
      for (let i = 0; i < (r.tally.wild | 0); i++) {
        let hit = null;
        while (pl.library.length) {
          const top = g.obj(pl.library[pl.library.length - 1]);
          g.moveObj(top, "exile", { quiet: true }); revealed.push(top);
          if (top.def.types.includes("creature")) { hit = top; break; }
        }
        if (hit) yield* g.enter$(hit, { controller: ctx.you });
      }
      for (const o of revealed) if (o.zone === "exile") g.moveObj(o, "library", { position: "top", quiet: true });
      if (revealed.length) g.shuffle(ctx.you);
      for (let i = 0; i < (r.tally.free | 0); i++) {
        const cands = pl.hand.map((id) => g.obj(id)).filter((o) => o.def.types.some((t) => ["artifact", "creature", "enchantment", "land", "planeswalker", "battle"].includes(t)));
        if (!cands.length) break;
        const [c] = yield* g.chooseObjects$(ctx.you, cands, { prompt: "You may put a permanent card from your hand onto the battlefield", min: 0, max: 1, reason: "generic", source: ctx.source?.id });
        if (c) yield* g.enter$(c, { controller: ctx.you });
      }
    } },
  }),
  "Smuggler's Share": fix(["At the beginning of each end step, draw a card for each opponent"], [
    trigRun({ event: "beginStep", step: "end", whose: "each" }, function* (g, ctx) {
      let d = 0, t = 0;
      for (const q of g.opponentsOf(ctx.you)) {
        if (g.tstat(q).drew >= 2) d++;
        if (g.tstat(q).entered.filter((e) => e.c.types.includes("land")).length >= 2) t++;
      }
      if (d) g.draw(ctx.you, d);
      if (t) g.createToken(ctx.you, "treasure", t, { source: ctx.source });
    }, "At the beginning of each end step, draw a card for each opponent who drew two or more cards this turn, then create a Treasure token for each opponent who had two or more lands enter the battlefield under their control this turn."),
  ]),
  "Pantlaza, Sun-Favored": fix(["you may discover X"], [
    trigRun({ event: "enters", who: { types: ["creature"], subtypes: ["dinosaur"], controller: "you" } }, function* (g, ctx) {
      const s = g.obj(ctx.source.id);
      const o = g.obj(ctx.event.obj.id);
      if (!s || !o || s._pzTurn === g.state.turn) return;
      if (!(yield* g.confirm$(ctx.you, `Discover ${o.c.toughness | 0}?`, ctx.source?.id, { kind: "discoverMay" }))) return;
      s._pzTurn = g.state.turn;
      yield* g.discover$(ctx.you, o.c.toughness | 0, ctx.source);
    }, "Whenever Pantlaza or another Dinosaur you control enters, you may discover X, where X is that creature's toughness. Do this only once each turn."),
  ]),
  "Wayward Swordtooth": fix(["Ascend", "can't attack or block unless"], [
    stat({ type: "cantAttack", affects: "self" }, "This creature can't attack unless you have the city's blessing.", { condition: { type: "not", c: { type: "blessing" } } }),
    stat({ type: "cantBlock", affects: "self" }, "This creature can't block unless you have the city's blessing.", { condition: { type: "not", c: { type: "blessing" } } }),
  ], { keywords: undefined }),
  "Arch of Orazca": fix(["{5}, {T}: Draw a card"], [
    actv({ mana: "{5}", tap: true }, [{ op: "draw", who: "you", amount: 1 }], "{5}, {T}: Draw a card. Activate only if you have the city's blessing.", { condition: { type: "blessing" } }),
  ]),
  "Timestream Navigator": fix(["{2}{U}{U}, {T}, Put this creature"], [
    actv({ mana: "{2}{U}{U}", tap: true }, [{ op: "move", what: "self", to: "library", position: "bottom" }, { op: "extraTurn" }], "{2}{U}{U}, {T}, Put this creature on the bottom of its owner's library: Take an extra turn after this one. Activate only if you have the city's blessing.", { condition: { type: "blessing" } }),
  ]),
  "Hakbal of the Surging Soul": fix(["each Merfolk creature you control explores", "put a land card from your hand onto the battlefield"], [
    trig({ event: "beginStep", step: "beginCombat", whose: "you" }, [{ op: "explore", what: { ref: "all", filter: { types: ["creature"], subtypes: ["merfolk"], controller: "you" } } }], "At the beginning of combat on your turn, each Merfolk creature you control explores."),
    trigRun({ event: "attacks", who: "self" }, function* (g, ctx) {
      const lands = g.state.players[ctx.you].hand.map((id) => g.obj(id)).filter((o) => o.def.types.includes("land"));
      if (lands.length && (yield* g.confirm$(ctx.you, "Put a land card from your hand onto the battlefield? (If not, draw a card)", ctx.source?.id))) {
        const [l] = yield* g.chooseObjects$(ctx.you, lands, { prompt: "Choose a land card", min: 1, max: 1, reason: "generic", source: ctx.source?.id });
        if (l) { yield* g.enter$(l, { controller: ctx.you }); return; }
      }
      g.draw(ctx.you, 1);
    }, "Whenever Hakbal attacks, you may put a land card from your hand onto the battlefield. If you don't, draw a card."),
  ]),
  "Topography Tracker": fix(["would explore"], [stat({ type: "exploreTwice" }, "If a creature you control would explore, instead it explores, then it explores again.")]),
  "Merfolk Cave-Diver": fix(["explores, this creature gets +1/+0"], [
    trig({ event: "explores", who: { types: ["creature"], controller: "you" } }, [{ op: "pump", what: "self", power: 1, toughness: 0, keywords: [], until: "endOfTurn" }, { op: "until", until: "endOfTurn", static: { type: "cantBeBlocked", affects: "self" } }], "Whenever a creature you control explores, this creature gets +1/+0 until end of turn and can't be blocked this turn."),
  ]),
  "Nicanzil, Current Conductor": fix(["explores a land card", "explores a nonland card"], [
    trigRun({ event: "explores", who: { types: ["creature"], controller: "you" }, land: true }, function* (g, ctx) {
      const lands = g.state.players[ctx.you].hand.map((id) => g.obj(id)).filter((o) => o.def.types.includes("land"));
      if (!lands.length) return;
      const [l] = yield* g.chooseObjects$(ctx.you, lands, { prompt: "You may put a land card from your hand onto the battlefield tapped", min: 0, max: 1, reason: "generic", source: ctx.source?.id });
      if (l) yield* g.enter$(l, { controller: ctx.you, tapped: true });
    }, "Whenever a creature you control explores a land card, you may put a land card from your hand onto the battlefield tapped."),
    trig({ event: "explores", who: { types: ["creature"], controller: "you" }, land: false }, [{ op: "addCounters", what: "self", kind: "+1/+1", amount: 1 }], "Whenever a creature you control explores a nonland card, put a +1/+1 counter on Nicanzil."),
  ]),
  "Radiant Destiny": fix(["Ascend", "Creatures you control of the chosen type"], [
    stat({ type: "pump", affects: { types: ["creature"], controller: "you", chosenType: true }, power: 1, toughness: 1 }, "Creatures you control of the chosen type get +1/+1."),
    stat({ type: "pump", affects: { types: ["creature"], controller: "you", chosenType: true }, power: 0, toughness: 0, keywords: ["vigilance"] }, "As long as you have the city's blessing, they also have vigilance.", { condition: { type: "blessing" } }),
  ]),
  "Glass-Cast Heart": fix(["create a Blood token", "thirteen Blood tokens"], [
    trig({ event: "attackBatch", who: "you", n: 1, filter: { types: ["creature"], subtypes: ["vampire"] } }, [{ op: "createToken", token: "blood", amount: 1 }], "Whenever one or more Vampires you control attack, create a Blood token."),
    actv({ mana: "{B}{B}", tap: true, sacSelf: true, sac: { subtypes: ["blood"] }, sacCount: 13 }, [{ op: "loseLife", who: "opponent", amount: 13 }, { op: "gainLife", who: "you", amount: 13 }], "{B}{B}, {T}, Sacrifice this artifact and thirteen Blood tokens: Each opponent loses 13 life and you gain 13 life."),
  ]),
  "Enterprising Scallywag": fix(["if you descended this turn"], [
    trig({ event: "beginStep", step: "end", whose: "you" }, [{ op: "createToken", token: "treasure", amount: 1 }], "At the beginning of your end step, if you descended this turn, create a Treasure token.", { condition: { type: "descended" } }),
  ]),
  "Blood Money": fix(["Destroy all creatures. For each nontoken"], [], {
    spell: { effects: [], run: function* (g, ctx) {
      let n = 0;
      for (const o of g.find({ types: ["creature"] }, ctx)) { const tok = o.token; if (g.destroy(o) && !tok) n++; }
      if (n) g.createToken(ctx.you, "treasure", n, { tapped: true, source: ctx.source });
    } },
  }),
  "Dreadhorde Invasion": fix(["you lose 1 life and amass Zombies 1"], [
    trig({ event: "beginStep", step: "upkeep", whose: "you" }, [{ op: "loseLife", who: "you", amount: 1 }, { op: "amass", amount: 1, subtype: "zombie" }], "At the beginning of your upkeep, you lose 1 life and amass Zombies 1."),
  ]),
  "Mazemind Tome": fix(["Put a page counter", "four or more page counters"], [
    actv({ tap: true }, [{ op: "addCounters", what: "self", kind: "page", amount: 1 }, { op: "scry", amount: 1 }], "{T}, Put a page counter on this artifact: Scry 1."),
    actv({ mana: "{2}", tap: true }, [{ op: "addCounters", what: "self", kind: "page", amount: 1 }, { op: "draw", who: "you", amount: 1 }], "{2}, {T}, Put a page counter on this artifact: Draw a card."),
    trig({ event: "counterAdded", who: "self", kind: "page" }, [{ op: "exile", what: "self" }, { op: "gainLife", who: "you", amount: 4 }], "When there are four or more page counters on this artifact, exile it. If you do, you gain 4 life.", { condition: { type: "counters", what: "self", kind: "page", op: ">=", n: 4 } }),
  ]),
  "The Golden Throne": fix(["Arcane Life-support", "A Thousand Souls Die Every Day"], [
    stat({ type: "loseGameReplace" }, "Arcane Life-support — If you would lose the game, instead exile The Golden Throne and your life total becomes 1."),
    { kind: "activated", cost: { tap: true, sac: { types: ["creature"] } }, mana: true, effects: [{ op: "addMana", mana: { anyOf: ALL5, n: 3, split: true } }], text: "A Thousand Souls Die Every Day — {T}, Sacrifice a creature: Add three mana in any combination of colors." },
  ]),
  "Conversion Apparatus": fix(["Pay {E}{E}{E}: Add three mana"], [
    { kind: "activated", cost: { tap: true, energy: 3 }, mana: true, effects: [{ op: "addMana", mana: { anyOf: ALL5, n: 3, split: true } }], text: "{T}, Pay {E}{E}{E}: Add three mana in any combination of colors." },
  ]),
  "Hit the Mother Lode": fix(["Discover 10"], [], {
    spell: { effects: [], run: function* (g, ctx) {
      const hit = yield* g.discover$(ctx.you, 10, ctx.source);
      const d = 10 - (hit ? hit.c.cmc | 0 : 10);
      if (hit && d > 0) g.createToken(ctx.you, "treasure", d, { tapped: true, source: ctx.source });
    } },
  }),
  "Long-Range Sensor": fix(["Whenever you attack a player", "Discover 4"], [
    trig({ event: "attackBatch", who: "you", n: 1, atPlayer: true }, [{ op: "addCounters", what: "self", kind: "charge", amount: 1 }], "Whenever you attack a player, put a charge counter on this artifact."),
    actv({ mana: "{1}", removeCounters: { kind: "charge", n: 2 } }, [{ op: "discover", amount: 4 }], "{1}, Remove two charge counters from this artifact: Discover 4. Activate only as a sorcery.", { sorcery: true }),
  ]),
  "Hidden Cataract": fix(["Discover 4"], [actv({ mana: "{4}{U}", tap: true, sacSelf: true }, [{ op: "discover", amount: 4 }], "{4}{U}, {T}, Sacrifice this land: Discover 4. Activate only as a sorcery.", { sorcery: true })]),
  "Hidden Nursery": fix(["Discover 4"], [actv({ mana: "{4}{G}", tap: true, sacSelf: true }, [{ op: "discover", amount: 4 }], "{4}{G}, {T}, Sacrifice this land: Discover 4. Activate only as a sorcery.", { sorcery: true })]),
  "Experimental Augury": fix(["Look at the top three cards"], [], {
    spell: { effects: [{ op: "lookTop", amount: 3, take: 1, rest: "bottom" }, { op: "proliferate" }] },
  }),
  "Tekuthal, Inquiry Dominus": fix(["proliferate twice"], [stat({ type: "proliferateTwice" }, "If you would proliferate, proliferate twice instead.")]),
  "Chrome Host Seedshark": fix(["incubate X"], [
    trigRun({ event: "cast", who: "you", filter: { notTypes: ["creature"] } }, function* (g, ctx) {
      const x = ctx.event.obj.c.cmc | 0;
      const [t] = g.createToken(ctx.you, {
        name: "Incubator", types: ["artifact"], subtypes: ["incubator"], colors: [],
        abilities: [{ kind: "activated", cost: { mana: "{2}" }, text: "{2}: Transform this token.", run: function* (g2, c2) {
          const o = g2.obj(c2.source.id);
          if (!o || o.zone !== "battlefield") return;
          g2.addEffect({ type: "asType", setTypes: ["artifact", "creature"], addSubtypes: ["phyrexian"], power: 0, toughness: 0, keywords: {} }, c2, { objIds: [o.id], until: null });
          o.name2 = "Phyrexian"; g2.markDirty();
        } }],
      }, 1, { source: ctx.source });
      if (t && x > 0) g.addCounters(t, "+1/+1", x);
    }, "Whenever you cast a noncreature spell, incubate X, where X is that spell's mana value."),
  ]),
  "Alibou, Ancient Witness": fix(["deals X damage to any target and you scry X"], [
    trigRun({ event: "attackBatch", who: "you", n: 1, filter: { types: ["artifact", "creature"], allTypes: ["artifact", "creature"] } }, function* (g, ctx) {
      const x = g.find({ types: ["artifact"], controller: "you", tapped: true }, ctx).length;
      const ts = yield* g.chooseTargets$(ctx.you, [{ what: "any" }], ctx.source, ctx);
      const id = ts && ts[0] && ts[0][0];
      if (id && x > 0) g.dealDamage(g.obj(ctx.source.id) || ctx.source, id, x);
      if (x > 0) yield* g.runEffects$([{ op: "scry", amount: x }], ctx);
    }, "Whenever one or more artifact creatures you control attack, Alibou deals X damage to any target and you scry X, where X is the number of tapped artifacts you control."),
  ]),
  "Tataru Taru": fix(["you draw a card and target opponent may draw", "Scions' Secretary"], [
    trigRun(SELF_ENTERS, function* (g, ctx) {
      g.draw(ctx.you, 1);
      const [t] = ctx.targets[0] || [];
      if (t && (yield* g.confirm$(+t.slice(1), "Draw a card?", ctx.source?.id))) g.draw(+t.slice(1), 1);
    }, "When Tataru Taru enters, you draw a card and target opponent may draw a card.", { targets: [{ what: "opponent" }] }),
    trigRun({ event: "draw", who: "opponent" }, function* (g, ctx) {
      const s = g.obj(ctx.source.id);
      if (!s || g.state.active === ctx.event.player || s._ttTurn === g.state.turn) return;
      s._ttTurn = g.state.turn;
      g.createToken(ctx.you, "treasure", 1, { tapped: true, source: s });
    }, "Scions' Secretary — Whenever an opponent draws a card, if it isn't that player's turn, create a tapped Treasure token. This ability triggers only once each turn."),
  ]),
  "Cache Grab": fix(["Mill four cards"], [], {
    spell: { effects: [], run: function* (g, ctx) {
      const milled = g.mill(ctx.you, 4);
      const perms = milled.filter((o) => o.zone === "graveyard" && o.def.types.some((t) => ["artifact", "creature", "enchantment", "land", "planeswalker", "battle"].includes(t)));
      let ret = null;
      if (perms.length) { const [c] = yield* g.chooseObjects$(ctx.you, perms, { prompt: "You may put a permanent card from among the milled cards into your hand", min: 0, max: 1, reason: "return", source: ctx.source?.id }); if (c) { g.moveObj(c, "hand"); ret = c; } }
      const sq = g.find({ types: ["creature"], subtypes: ["squirrel"], controller: "you" }, ctx).length > 0 || (ret && ret.c.subtypes.includes("squirrel"));
      if (sq) g.createToken(ctx.you, "food", 1, { source: ctx.source });
    } },
  }),
  "Rose Room Treasurer": fix(["Alliance"], [
    trigRun({ event: "enters", who: { types: ["creature"], controller: "you", other: true } }, function* (g, ctx) {
      const s = g.obj(ctx.source.id);
      if (!s) return;
      if (!s._rr || s._rr.turn !== g.state.turn) s._rr = { turn: g.state.turn, n: 0 };
      s._rr.n++;
      if (s._rr.n <= 2) { g.createToken(ctx.you, "treasure", 1, { source: s }); return; }
      const mx = g.manaAvailable ? g.manaAvailable(ctx.you) : 0;
      if (mx < 1) return;
      const x = yield* g.number$(ctx.you, "Pay {X} (0 to decline): Rose Room Treasurer deals X damage to any target", 0, mx, s.id, { kind: "x" });
      if (x < 1) return;
      if (!(yield* g.payMana$(ctx.you, { generic: x, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, x: 0, hybrid: [], phyrexian: [] }))) return;
      const ts = yield* g.chooseTargets$(ctx.you, [{ what: "any" }], s, ctx);
      const id = ts && ts[0] && ts[0][0];
      if (id) g.dealDamage(s, id, x);
    }, "Alliance — Whenever another creature you control enters, create a Treasure token if this is the first or second time this ability has resolved this turn. Otherwise, you may pay {X}. When you do, this creature deals X damage to any target."),
  ]),
  "Sarkhan, Dragon Ascendant": fix(["you may behold a Dragon", "Whenever a Dragon you control enters"], [
    trigRun(SELF_ENTERS, function* (g, ctx) {
      const onBf = g.find({ types: ["creature"], subtypes: ["dragon"], controller: "you" }, ctx);
      const inHand = g.state.players[ctx.you].hand.map((id) => g.obj(id)).filter((o) => o.def.types.includes("creature") && o.def.subtypes.includes("dragon"));
      if (!onBf.length && !inHand.length) return;
      if (!(yield* g.confirm$(ctx.you, "Behold a Dragon? (choose a Dragon you control or reveal one from your hand) — create a Treasure", ctx.source?.id))) return;
      if (!onBf.length || (inHand.length && (yield* g.confirm$(ctx.you, "Reveal a Dragon card from your hand instead of choosing one you control?", ctx.source?.id)))) {
        const [c] = yield* g.chooseObjects$(ctx.you, inHand, { prompt: "Reveal a Dragon card", min: 1, max: 1, reason: "generic", source: ctx.source?.id });
        if (c) g.emit({ t: "reveal", objs: [c.id], player: ctx.you, text: `${g.pname(ctx.you)} reveals ${c.c.name}` });
      }
      g.createToken(ctx.you, "treasure", 1, { source: ctx.source });
    }, "When Sarkhan enters, you may behold a Dragon. If you do, create a Treasure token."),
    trigRun({ event: "enters", who: { types: ["creature"], subtypes: ["dragon"], controller: "you" } }, function* (g, ctx) {
      const s = g.obj(ctx.source.id);
      if (!s) return;
      g.addCounters(s, "+1/+1", 1);
      g.addEffect({ type: "asType", addSubtypes: ["dragon"], keywords: { flying: true } }, ctx, { objIds: [s.id], until: "endOfTurn" });
    }, "Whenever a Dragon you control enters, put a +1/+1 counter on Sarkhan. Until end of turn, Sarkhan becomes a Dragon in addition to his other types and gains flying."),
  ]),
  "Francisco, Fowl Marauder": fix(["Whenever one or more Pirates you control deal damage"], [
    trig({ event: "dealsDamage", who: { types: ["creature"], subtypes: ["pirate"], controller: "you" }, to: "player", batch: true }, [{ op: "explore", what: "self" }], "Whenever one or more Pirates you control deal damage to a player, Francisco explores."),
  ]),
  "Malcolm, Keen-Eyed Navigator": fix(["Whenever one or more Pirates you control deal damage"], [
    trigRun({ event: "dealsDamage", who: { types: ["creature"], subtypes: ["pirate"], controller: "you" }, to: "player", batch: true }, function* (g, ctx) {
      const hit = new Set((ctx.event.targets || [ctx.event.target]).filter((t) => isPid(t) && +t.slice(1) !== ctx.you));
      if (hit.size) g.createToken(ctx.you, "treasure", hit.size, { source: ctx.source });
    }, "Whenever one or more Pirates you control deal damage to your opponents, you create a Treasure token for each opponent dealt damage."),
  ]),
};
