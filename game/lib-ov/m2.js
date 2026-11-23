// lib-ov/m2.js — overrides for deck-library cards, batch m2 (creature, combat and counter keywords; see SPEC-NOTES.md "Library automation: m2").
// Keyword lines (crew, evolve, myriad, squad, ...) are compiled by the parser + engine-m2.js / kw-synth.js; the entries below cover the
// remaining oracle lines. Keyed by exact card name. Format/conventions: header of ../overrides-1.js.
import { H } from "../overrides-1.js";

const { out, T } = H;
const EVT = { ref: "event", what: "object" };
const ENTERS = { event: "enters", who: "self" };
const ATTACKS = { event: "attacks", who: "self" };
const BEGIN_COMBAT = { event: "beginStep", step: "beginCombat", whose: "you" };
const MINE = { types: ["creature"], controller: "you" };
const OPP_CREATURE = { types: ["creature"], controller: "opponent" };
const ALL_MY_CREATURES = { ref: "all", filter: MINE };
const ATTACKING_MINE = { ref: "all", filter: { types: ["creature"], attacking: true, controller: "you" } };
const trig = (on, effects, text, extra = {}) => ({ kind: "triggered", on, effects, text, ...extra });
const stat = (effect, text, extra = {}) => ({ kind: "static", effect, text, ...extra });
const isManual = (a) => JSON.stringify(a.effects || []).includes('"manual"');
/** def with extra abilities; parser abilities that carry a `manual` effect (an unparsed sentence) are dropped; `keep` = unparsed lines left. */
const fix = (def, add = [], o = {}) => out(def, { abilities: [...def.abilities.filter(o.drop || ((a) => !isManual(a))), ...add], ...(o.set || {}) }, o.keep || []);
const energy = (n) => ({ op: "addCounters", what: "you", kind: "energy", amount: n });
const attackDeclared = { event: "attackDeclared", who: "you" };
const SOLDIER = { name: "Soldier", types: ["creature"], subtypes: ["soldier"], colors: ["W"], power: 1, toughness: 1 };
const JUNK = { name: "Junk", types: ["artifact"], subtypes: ["junk"], colors: [], abilities: [{ kind: "activated", cost: { tap: true, sacSelf: true }, sorcery: true, effects: [{ op: "exileTop", who: "you", amount: 1 }], text: "{T}, Sacrifice this artifact: Exile the top card of your library. You may play that card this turn. Activate only as a sorcery." }] };
const spacecraft = (n) => ({ type: "counters", what: "self", kind: "charge", op: ">=", n });
const untapMine = { op: "untap", what: ALL_MY_CREATURES };
const untapAttackers = { op: "untap", what: ATTACKING_MINE };

/** Spacecraft: creature (with printed P/T) once it has `n` charge counters. */
const becomesCreatureAt = (n) => stat({ type: "asType", affects: "self", addTypes: ["creature"] }, `${n}+ | It's an artifact creature.`, { condition: spacecraft(n) });
const grantAt = (n, keywords) => stat({ type: "pump", affects: "self", power: 0, toughness: 0, keywords }, `${n}+ | ${keywords.join(", ")}`, { condition: spacecraft(n) });

export default {
  "Monstrosity of the Lake": { patch: (def) => fix(def, [trig(ENTERS, [{ op: "may", cost: { mana: "{5}" }, effects: [
    { op: "tap", what: { ref: "all", filter: OPP_CREATURE } }, { op: "addCounters", what: { ref: "all", filter: OPP_CREATURE }, kind: "stun", amount: 1 }] }],
    "When this creature enters, you may pay {5}. If you do, tap all creatures your opponents control, then put a stun counter on each of those creatures.")]) },

  "Scourge of the Throne": { patch: (def) => fix(def, [trig(ATTACKS, [untapAttackers, { op: "extraCombat" }],
    "Whenever this creature attacks for the first time each turn, if it's attacking the player with the most life or tied for most life, untap all attacking creatures. After this phase, there is an additional combat phase.",
    { condition: { type: "and", all: [{ type: "firstAttack" }, { type: "_dethrone" }] } })]) },

  "Taunt from the Rampart": { patch: (def) => out(def, { spell: { ...def.spell, targets: [], effects: [
    { op: "goad", what: { ref: "all", filter: OPP_CREATURE } },
    { op: "until", until: "yourNextTurn", static: { type: "cantBlock", affects: { ref: "all", filter: OPP_CREATURE } } }] } }) },

  "Combat Celebrant": { patch: (def) => fix(def, [stat({ type: "exertOnAttack" }, "You may exert this creature as it attacks."),
    trig({ event: "exerted", who: "self" }, [{ op: "untap", what: { ref: "all", filter: { ...MINE, other: true } } }, { op: "extraCombat" }],
      "When you exert it, untap all other creatures you control and after this phase, there is an additional combat phase.")]) },

  "Frodo, Adventurous Hobbit": { patch: (def) => fix(def, [trig(ATTACKS, [], "Whenever Frodo attacks, if you gained 3 or more life this turn, the Ring tempts you. Then if Frodo is your Ring-bearer and the Ring has tempted you two or more times this game, draw a card.", {
    condition: { type: "compare", a: { lifeGainedThisTurn: "you" }, op: ">=", b: 3 },
    run: function* (g, ctx) {
      yield* g.ringTempts$(ctx.you);
      const pl = g.state.players[ctx.you];
      if (pl.ring.bearer === ctx.source.id && pl.ring.level >= 2) g.draw(ctx.you, 1);
    } })]) },

  "Sam, Loyal Attendant": { patch: (def) => fix(def, [stat({ type: "abilityCostMod", filter: { subtypes: ["food"] }, amount: -1 }, "Activated abilities of Foods you control cost {1} less to activate.")]) },

  "Feasting Hobbit": { patch: (def) => fix(def, [stat({ type: "cantBeBlocked", affects: "self", exceptBy: { types: ["creature"], power: { op: ">=", n: { powerOf: "self" } } } }, "Creatures with power less than this creature's power can't block it.")]) },

  "Merry, Warden of Isengard": { patch: (def) => fix(def, [trig({ event: "enters", who: { types: ["artifact"], controller: "you" } }, [],
    "Whenever one or more artifacts you control enter, create a 1/1 white Soldier creature token with lifelink. This ability triggers only once each turn.", {
      run: function* (g, ctx) {
        const s = g.state.objects[ctx.source.id];
        if (!s || s.merryTurn === g.state.turn) return;
        s.merryTurn = g.state.turn;
        g.createToken(ctx.you, { ...SOLDIER, keywords: { lifelink: true } }, 1, { source: s });
      } })]) },

  "Inscription of Abundance": { patch: (def) => out(def, { spell: { ...def.spell, targets: [], effects: [], modes: { min: 1, max: 1, maxIf: { cond: { type: "kicked" }, max: 3 }, modes: [
    { text: "Put two +1/+1 counters on target creature.", targets: [{ what: { types: ["creature"] } }], effects: [{ op: "addCounters", what: T(0), kind: "+1/+1", amount: 2 }] },
    { text: "Target player gains X life, where X is the greatest power among creatures they control.", targets: [{ what: "player" }], effects: [{ run: function* (g, ctx) {
      const id = (ctx.targets[0] || [])[0];
      if (!id) return;
      const p = +id.slice(1);
      let x = 0;
      for (const o of g.find({ types: ["creature"] }, ctx)) if (o.controller === p) x = Math.max(x, o.c.power | 0);
      if (x > 0) g.gainLife(p, x);
    } }] },
    { text: "Target creature you control fights target creature you don't control.", targets: [{ what: MINE }, { what: OPP_CREATURE }], effects: [{ op: "fight", a: T(0), b: T(1) }] },
  ] } } }) },

  "Grim Reaper's Sprint": { patch: (def) => fix(def, [
    stat({ type: "selfCostMod", per: 1, amount: -3 }, "Morbid — This spell costs {3} less to cast if a creature died this turn.", { condition: { type: "creatureDiedThisTurn" } }),
    trig(ENTERS, [untapMine, { op: "if", cond: { type: "mainPhase" }, then: [{ op: "extraCombat" }] }], "When this Aura enters, untap each creature you control. If it's your main phase, there is an additional combat phase after this phase.")]) },

  "Acquired Mutation": { patch: (def) => fix(def, [trig({ event: "attacks", who: "enchanted" }, [{ op: "addCounters", what: { ref: "defendingPlayer" }, kind: "rad", amount: 2 }], "Whenever enchanted creature attacks, defending player gets two rad counters.")]) },

  "The Prydwen, Steel Flagship": { patch: (def) => fix(def, [trig({ event: "enters", who: { types: ["artifact"], controller: "you", nontoken: true, other: true } }, [{ op: "createToken", who: "you", amount: 1, token: {
    name: "Human Knight", types: ["creature"], subtypes: ["human", "knight"], colors: ["W"], power: 2, toughness: 2,
    abilities: [stat({ type: "pump", affects: "self", power: 2, toughness: 2 }, "This token gets +2/+2 as long as an artifact entered the battlefield under your control this turn.", { condition: { type: "artifactEnteredThisTurn" } })] } }],
    "Whenever another nontoken artifact you control enters, create a 2/2 white Human Knight creature token with \"This token gets +2/+2 as long as an artifact entered the battlefield under your control this turn.\"")]) },

  "Assaultron Dominator": { patch: (def) => fix(def, [
    trig(ENTERS, [energy(2)], "When this creature enters, you get {E}{E}."),
    trig({ event: "attacks", who: { allTypes: ["artifact", "creature"], controller: "you" } }, [], "Whenever an artifact creature you control attacks, you may pay {E}. If you do, put your choice of a +1/+1, first strike, or trample counter on that creature.", { run: function* (g, ctx) {
      const o = ctx.event.obj && g.obj(ctx.event.obj.id);
      if (!o || o.zone !== "battlefield" || !g.energyOk(ctx.you, 1)) return;
      if (!(yield* g.confirm$(ctx.you, `Pay {E} to put a counter on ${o.c.name}?`, ctx.source.id, { kind: "may", effects: [{ op: "addCounters", what: "self", kind: "+1/+1", amount: 1 }] }))) return;
      g.addPlayerCounters(ctx.you, "energy", -1);
      const ch = yield* g.choose$(ctx.you, { prompt: "Choose a counter", options: [{ id: "+1/+1", label: "+1/+1 counter", type: "mode" }, { id: "first strike", label: "First strike counter", type: "mode" }, { id: "trample", label: "Trample counter", type: "mode" }], min: 1, max: 1, reason: "mode", source: ctx.source.id, hint: { kind: "counterKind", obj: o.id } });
      g.addCounters(o, ch[0]?.id || "+1/+1", 1);
    } })]) },

  "Red Death, Shipwrecker": { patch: (def) => fix(def, [{ kind: "activated", cost: { tap: true }, targets: [{ what: OPP_CREATURE }], text: "Alluring Eyes — {T}: Goad target creature an opponent controls. That player draws a card. You add {R}.",
    effects: [{ op: "goad", what: T(0) }, { op: "draw", who: { ref: "controllerOf", of: T(0) }, amount: 1 }, { op: "addMana", mana: "{R}" }] }]) },

  "Brotherhood Vertibird": { patch: (def) => fix(def, [stat({ type: "setPT", power: { count: { types: ["artifact"], controller: "you" } }, toughness: def.toughness }, "Brotherhood Vertibird's power is equal to the number of artifacts you control.")]) },

  "Watchful Radstag": { patch: (def) => fix(def, [trig({ event: "evolves", who: "self" }, [{ op: "createToken", who: "you", copyOf: "self" }], "Whenever this creature evolves, create a token that's a copy of it.")]) },

  "Alpha Deathclaw": { patch: (def) => fix(def, ["enters", "monstrous"].map((ev) => trig({ event: ev, who: "self" }, [{ op: "destroy", what: T(0) }], "When this creature enters or becomes monstrous, destroy target permanent.", { targets: [{ what: { types: ["permanent"] } }] }))) },

  "Aradesh, the Founder": { patch: (def) => fix(def, [trig({ event: "attacks", who: { types: ["creature"], controller: "you" } }, [
    { op: "pump", what: EVT, power: 0, toughness: 0, keywords: ["double strike"], until: "endOfTurn" },
    { op: "if", cond: { type: "compare", a: { powerOf: EVT }, op: ">=", b: 4 }, then: [{ op: "draw", who: "you", amount: 1 }] }],
    "Whenever a creature you control attacks, if it enlisted a creature this combat, the creature that attacked gains double strike until end of turn. If that creature's power is 4 or greater, draw a card.", { condition: { type: "enlisted" } })]) },

  "Thrill-Kill Disciple": { patch: (def) => fix(def, [trig({ event: "dies", who: "self" }, [{ op: "createToken", who: "you", token: JUNK, amount: 1 }], "When this creature dies, create a Junk token.")], { set: { keywords: { ...def.keywords, squad: { mana: "{1}", discard: 1 } } } }) },

  "Gary Clone": { patch: (def) => fix(def, [trig(ATTACKS, [{ op: "pump", what: { ref: "all", filter: { ...MINE, name: "Gary Clone" } }, power: 1, toughness: 0, until: "endOfTurn" }], "Whenever this creature attacks, each creature you control named Gary Clone gets +1/+0 until end of turn.")]) },

  "Tifa, Martial Artist": { patch: (def) => fix(def, [trig({ event: "dealsCombatDamage", who: { ...MINE, power: { op: ">=", n: 7 } }, to: "player", batch: true }, [untapMine, { op: "if", cond: { type: "firstCombat" }, then: [{ op: "extraCombat" }] }],
    "Whenever one or more creatures you control with power 7 or greater deal combat damage to a player, untap all creatures you control. If it's the first combat phase of your turn, there is an additional combat phase after this phase.")]) },

  "Cid, Freeflier Pilot": { patch: (def) => fix(def, [stat({ type: "costMod", filter: { anyOf: [{ subtypes: ["equipment"] }, { subtypes: ["vehicle"] }] }, who: "you", amount: -1 }, "Equipment and Vehicle spells you cast cost {1} less to cast.")]) },

  "Chocobo Knights": { patch: (def) => fix(def, [trig(attackDeclared, [{ op: "pump", what: { ref: "all", filter: { ...MINE, anyCounters: true } }, power: 0, toughness: 0, keywords: ["double strike"], until: "endOfTurn" }],
    "Whenever you attack, creatures you control with counters on them gain double strike until end of turn.")]) },

  "Maester Seymour": { patch: (def) => fix(def, [
    trig(BEGIN_COMBAT, [{ op: "addCounters", what: T(0), kind: "+1/+1", amount: { powerOf: "self" } }], "At the beginning of combat on your turn, put a number of +1/+1 counters equal to Maester Seymour's power on another target creature you control.", { targets: [{ what: { ...MINE, other: true } }] }),
    { kind: "activated", cost: { mana: "{3}{G}{G}" }, effects: [{ op: "_monstrosity", amount: { totalCounters: MINE } }], text: "{3}{G}{G}: Monstrosity X, where X is the number of counters among creatures you control." }]) },

  "Fathom Mage": { patch: (def) => fix(def, [trig({ event: "counterAdded", who: "self", kind: "+1/+1" }, [{ op: "draw", who: "you", amount: 1 }], "Whenever a +1/+1 counter is put on this creature, you may draw a card.", { optional: true })]) },

  "Setzer, Wandering Gambler": { patch: (def) => fix(def, [
    trig(ENTERS, [{ op: "createToken", who: "you", amount: 1, token: { name: "The Blackjack", supertypes: ["legendary"], types: ["artifact"], subtypes: ["vehicle"], colors: [], power: 3, toughness: 3, keywords: { flying: true, crew: 2 } } }], "When Setzer enters, create The Blackjack, a legendary 3/3 colorless Vehicle artifact token with flying and crew 2."),
    trig({ event: "dealsCombatDamage", who: { subtypes: ["vehicle"], controller: "you" }, to: "player" }, [{ op: "flipCoin" }], "Whenever a Vehicle you control deals combat damage to a player, flip a coin."),
    trig({ event: "coinWon", who: "you" }, [{ op: "createToken", who: "you", token: "treasure", amount: 2, tapped: true }], "Whenever you win a coin flip, create two tapped Treasure tokens.")]) },

  "Alisaie Leveilleur": { patch: (def) => fix(def, [stat({ type: "costMod", filter: {}, who: "you", amount: -2 }, "Dualcast — The second spell you cast each turn costs {2} less to cast.", { condition: { type: "compare", a: { castCount: true }, op: "==", b: 1 } })]) },
  "Alphinaud Leveilleur": { patch: (def) => fix(def, [trig({ event: "cast", who: "you" }, [{ op: "draw", who: "you", amount: 1 }], "Eukrasia — Whenever you cast your second spell each turn, draw a card.", { condition: { type: "compare", a: { castCount: true }, op: "==", b: 2 } })]) },

  "Eye of Nidhogg": { patch: (def) => fix(def, [
    stat({ type: "asType", affects: "enchanted", colors: ["B"], setSubtypes: ["dragon"], power: 4, toughness: 2, keywords: ["flying", "deathtouch"] }, "Enchanted creature is a black Dragon with base power and toughness 4/2, has flying and deathtouch"),
    stat({ type: "goaded", affects: "enchanted" }, "and is goaded.")]) },

  "Lyse Hext": { patch: (def) => fix(def, [stat({ type: "pump", affects: "self", power: 0, toughness: 0, keywords: ["double strike"] }, "As long as you've cast two or more noncreature spells this turn, Lyse Hext has double strike.", { condition: { type: "castNoncreatureAtLeast", n: 2 } })]) },

  "Protector of the Wastes": { patch: (def) => fix(def, ["enters", "monstrous"].map((ev) => trig({ event: ev, who: "self" }, [{ op: "exile", what: { ref: "target", i: 0 } }, { op: "exile", what: { ref: "target", i: 1 } }],
    "When this creature enters or becomes monstrous, exile up to two target artifacts and/or enchantments controlled by different players.",
    { targets: [{ what: { types: ["artifact", "enchantment"], controller: "you" }, min: 0, max: 1 }, { what: { types: ["artifact", "enchantment"], controller: "opponent" }, min: 0, max: 1 }] }))) },

  "Zurgo Stormrender": { patch: (def) => fix(def, [trig({ event: "leaves", who: { types: ["creature"], token: true, controller: "you" } }, [], "Whenever a creature token you control leaves the battlefield, draw a card if it was attacking. Otherwise, each opponent loses 1 life.", {
    run: function* (g, ctx) {
      if (ctx.event.obj && ctx.event.obj.attacking) g.draw(ctx.you, 1);
      else for (const q of g.opponentsOf(ctx.you)) g.loseLife(q, 1);
    } })]) },

  "Ironwill Forger": { patch: (def) => fix(def, [trig(BEGIN_COMBAT, [{ op: "pump", what: T(0), power: 0, toughness: 0, keywords: ["myriad"], until: "endOfTurn" }],
    "Lieutenant — At the beginning of combat on your turn, if you control your commander, target nonlegendary creature you control gains myriad until end of turn.",
    { condition: { type: "controlCommander" }, targets: [{ what: { ...MINE, notSupertypes: ["legendary"] } }] })]) },

  "Infantry Shield": { patch: (def) => fix(def, [stat({ type: "pump", affects: "equipped", power: 0, toughness: 0, keywords: ["menace", { mobilize: { powerOf: "self" } }] }, "Equipped creature has menace and mobilize X, where X is its power.")]) },

  "Hero of Bladehold": { patch: (def) => fix(def, [trig(ATTACKS, [{ op: "createToken", who: "you", token: SOLDIER, amount: 2, tapped: true, attacking: true }], "Whenever this creature attacks, create two 1/1 white Soldier creature tokens that are tapped and attacking.")]) },

  "Grenzo, Havoc Raiser": { patch: (def) => fix(def, [trig({ event: "dealsCombatDamage", who: { ...MINE }, to: "player" }, [], "Whenever a creature you control deals combat damage to a player, choose one — • Goad target creature that player controls. • Exile the top card of that player's library. Until end of turn, you may cast that card and you may spend mana as though it were mana of any color to cast that spell.", {
    modes: { min: 1, max: 1, modes: [
      { text: "Goad target creature that player controls.", targets: [{ what: OPP_CREATURE }], effects: [{ op: "goad", what: T(0) }] },
      { text: "Exile the top card of that player's library. Until end of turn, you may cast that card and you may spend mana as though it were mana of any color to cast that spell.", targets: [], effects: [{ run: function* (g, ctx) {
        const q = ctx.event.player != null && ctx.event.target && /^P\d+$/.test(ctx.event.target) ? +ctx.event.target.slice(1) : g.opponentsOf(ctx.you)[0];
        const pl = g.state.players[q];
        if (!pl || !pl.library.length) return;
        const o = g.state.objects[pl.library[pl.library.length - 1]];
        g.moveObj(o, "exile");
        o.mayPlay = { player: ctx.you, until: "endOfTurn", untilTurn: g.state.turn, turn: g.state.turn, free: false, anyColor: true };
      } }] }] } })]) },

  "Legion Warboss": { patch: (def) => fix(def, [trig(BEGIN_COMBAT, [
    { op: "createToken", who: "you", amount: 1, token: { name: "Goblin", types: ["creature"], subtypes: ["goblin"], colors: ["R"], power: 1, toughness: 1 } },
    { op: "pump", what: { ref: "it" }, power: 0, toughness: 0, keywords: ["haste"], until: "endOfTurn" },
    { op: "until", until: "endOfTurn", static: { type: "mustAttack", affects: { ref: "it" } } }],
    "At the beginning of combat on your turn, create a 1/1 red Goblin creature token. That token gains haste until end of turn and attacks this combat if able.")]) },

  "Skarrgan Hellkite": { patch: (def) => fix(def, [{ kind: "activated", cost: { mana: "{3}{R}" }, condition: { type: "counters", what: "self", kind: "+1/+1", op: ">=", n: 1 }, targets: [{ what: "any", min: 1, max: 2 }],
    effects: [{ op: "damage", amount: 2, to: T(0), divided: true }], text: "{3}{R}: This creature deals 2 damage divided as you choose among one or two targets. Activate only if this creature has a +1/+1 counter on it." }]) },

  "Stormbreath Dragon": { patch: (def) => fix(def, [trig({ event: "monstrous", who: "self" }, [], "When this creature becomes monstrous, it deals damage to each opponent equal to the number of cards in that player's hand.", { run: function* (g, ctx) {
    for (const q of g.opponentsOf(ctx.you)) g.dealDamage(ctx.source, "P" + q, g.state.players[q].hand.length);
  } })]) },

  "Vengeful Ancestor": { patch: (def) => fix(def, [trig({ event: "attacks", who: { types: ["creature"], goaded: true } }, [{ op: "damage", amount: 1, to: { ref: "controllerOf", of: EVT }, from: EVT }], "Whenever a goaded creature attacks, it deals 1 damage to its controller.")]) },

  "Frontier Siege": { patch: (def) => fix(def, [
    stat({ type: "asEntersChoose", choice: "mode", options: [{ id: "khans", label: "Khans" }, { id: "dragons", label: "Dragons" }] }, "As this enchantment enters, choose Khans or Dragons."),
    ...["main1", "main2"].map((step) => trig({ event: "beginStep", step, whose: "you" }, [{ op: "addMana", mana: "{G}{G}" }], "Khans — At the beginning of each of your main phases, add {G}{G}.", { condition: { type: "chosen", key: "mode", value: "khans" } })),
    trig({ event: "enters", who: { types: ["creature"], controller: "you", keywords: ["flying"] } }, [{ op: "fight", a: EVT, b: T(0) }], "Dragons — Whenever a creature you control with flying enters, you may have it fight target creature you don't control.",
      { optional: true, condition: { type: "chosen", key: "mode", value: "dragons" }, targets: [{ what: OPP_CREATURE }] })]) },

  "Bloodroot Apothecary": { patch: (def) => fix(def, [
    trig(ENTERS, [{ op: "createToken", who: "you", token: "treasure", amount: 1 }, { op: "createToken", who: T(0), token: "treasure", amount: 1 }], "When this creature enters, you and target opponent each create a Treasure token.", { targets: [{ what: "opponent" }] }),
    trig({ event: "sacrifice", who: "opponent", filter: { token: true, notTypes: ["creature"] } }, [{ op: "addCounters", what: { ref: "event", what: "player" }, kind: "poison", amount: 2 }], "Whenever an opponent sacrifices a noncreature token, that player gets two poison counters.")]) },

  "Illusionist's Gambit": { patch: (def) => out(def, { castRestrict: { type: "stepIs", step: "declareBlockers", opponentTurn: true }, spell: { ...def.spell, targets: [], effects: [{ run: function* (g, ctx) {
    const st = g.state;
    const ids = g.find({ types: ["creature"], attacking: true }, ctx).map((o) => o.id);
    yield* g.runEffects$([{ op: "_removeFromCombat" }], ctx);
    st.extraCombats++;
    (st.extraQueue ||= []);
    while (st.extraQueue.length < st.extraCombats - 1) st.extraQueue.push({});
    st.extraQueue.push({ mustAttack: ids, noAttackPlayer: ctx.you });
    g.log("There is an additional combat phase");
  } }] } }) },

  "Martial Impetus": { patch: (def) => fix(def, [trig({ event: "attacks", who: "enchanted" }, [{ op: "pump", what: { ref: "all", filter: { types: ["creature"], attacking: true, other: true, controller: "you" } }, power: 1, toughness: 1, until: "endOfTurn" }],
    "Whenever enchanted creature attacks, each other creature that's attacking one of your opponents gets +1/+1 until end of turn.")]) },

  "Pollywog Prodigy": { patch: (def) => fix(def, [trig({ event: "cast", who: "opponent", filter: { notTypes: ["creature"], cmc: { op: "<", n: { powerOf: "self" } } } }, [{ op: "draw", who: "you", amount: 1 }], "Whenever an opponent casts a noncreature spell with mana value less than this creature's power, draw a card.")]) },

  "Grothama, All-Devouring": { patch: (def) => fix(def, [
    stat({ type: "pump", affects: { types: ["creature"], other: true }, power: 0, toughness: 0, abilities: [trig(ATTACKS, [{ op: "fight", a: "self", b: { ref: "all", filter: { name: "Grothama, All-Devouring" } } }], "Whenever this creature attacks, you may have it fight Grothama, All-Devouring.", { optional: true })] }, "Other creatures have \"Whenever this creature attacks, you may have it fight Grothama, All-Devouring.\""),
    trig({ event: "leaves", who: "self" }, [], "When Grothama leaves the battlefield, each player draws cards equal to the amount of damage dealt to Grothama this turn by sources they controlled.", { run: function* (g, ctx) {
      const dm = ctx.event.obj && ctx.event.obj.dmgBy;
      if (!dm || dm.turn !== g.state.turn) return;
      for (const p of g.apnap(g.state.players.map((x) => x.idx))) if (dm[p] > 0) g.draw(p, dm[p]);
    } })]) },

  "Aggressive Biomancy": { patch: (def) => out(def, { spell: { ...def.spell, targets: [{ what: MINE }], effects: [{ run: function* (g, ctx) {
    const src = g.obj((ctx.targets[0] || [])[0]);
    if (!src || src.zone !== "battlefield" || !(ctx.x > 0)) return;
    const base = g.copiableDef(src);
    const extra = trig(ENTERS, [{ op: "fight", a: "self", b: T(0) }], "When this token enters, it fights up to one target creature you don't control.", { targets: [{ what: OPP_CREATURE, min: 0, max: 1 }] });
    const d2 = { ...base, abilities: [...base.abilities, extra], faces: null };
    g.createToken(ctx.you, { copyOf: { ...src, def: d2, copyDef: d2, faceDown: false, mergeDef: null } }, ctx.x, { source: ctx.source });
  } }] } }) },

  "Hydra Broodmaster": { patch: (def) => fix(def, [trig({ event: "monstrous", who: "self" }, [{ op: "createToken", who: "you", amount: { event: "x" }, token: { name: "Hydra", types: ["creature"], subtypes: ["hydra"], colors: ["G"], power: { event: "x" }, toughness: { event: "x" } } }],
    "When this creature becomes monstrous, create X X/X green Hydra creature tokens.")]) },

  "Polygoyf": { patch: (def) => fix(def, [stat({ type: "setPT", power: { cardTypesInGraveyards: true }, toughness: { add: [{ cardTypesInGraveyards: true }, 1] } }, "Polygoyf's power is equal to the number of card types among cards in all graveyards and its toughness is equal to that number plus 1.")]) },

  "Azlask, the Swelling Scourge": { patch: (def) => fix(def, [
    trig({ event: "dies", who: { types: ["creature"], controller: "you", colors: ["colorless"] } }, [{ op: "addCounters", what: "you", kind: "experience", amount: 1 }], "Whenever Azlask or another colorless creature you control dies, you get an experience counter."),
    { kind: "activated", cost: { mana: "{W}{U}{B}{R}{G}" }, text: "{W}{U}{B}{R}{G}: Creatures you control get +X/+X until end of turn, where X is the number of experience counters you have. Scions and Spawns you control gain indestructible and annihilator 1 until end of turn.", effects: [
      { op: "pump", what: ALL_MY_CREATURES, power: { countersOn: "you", kind: "experience" }, toughness: { countersOn: "you", kind: "experience" }, until: "endOfTurn" },
      { op: "pump", what: { ref: "all", filter: { ...MINE, subtypes: ["scion", "spawn"] } }, power: 0, toughness: 0, keywords: ["indestructible", { annihilator: 1 }], until: "endOfTurn" }] }]) },

  "Hideous Taskmaster": { patch: (def) => fix(def, [trig({ event: "cast", who: "self" }, [
    { op: "gainControl", what: T(0), until: "endOfTurn" }, { op: "untap", what: T(0) }, { op: "pump", what: T(0), power: 0, toughness: 0, keywords: ["trample", "haste", { annihilator: 1 }], until: "endOfTurn" }],
    "When you cast this spell, for each opponent, gain control of up to one target creature that player controls until end of turn. Untap those creatures. They gain trample, haste, and annihilator 1 until end of turn.",
    { zone: "stack", targets: [{ what: OPP_CREATURE, min: 0, max: 1 }] })]) },
  "Flayer of Loyalties": { patch: (def) => fix(def, [trig({ event: "cast", who: "self" }, [
    { op: "gainControl", what: T(0), until: "endOfTurn" }, { op: "untap", what: T(0) },
    { op: "until", until: "endOfTurn", static: { type: "setPT", power: 10, toughness: 10, affects: T(0) } },
    { op: "pump", what: T(0), power: 0, toughness: 0, keywords: ["trample", { annihilator: 2 }, "haste"], until: "endOfTurn" }],
    "When you cast this spell, gain control of target creature until end of turn. Untap that creature. Until end of turn, it has base power and toughness 10/10 and gains trample, annihilator 2, and haste.",
    { zone: "stack", targets: [{ what: { types: ["creature"] } }] })]) },

  "Twins of Discord": { patch: (def) => fix(def, [
    trig(attackDeclared, [{ op: "chooseParity" }], "Whenever you attack, choose odd or even. Creatures with mana value of that quality can't block this turn."),
    stat({ type: "entersWithCountersFor", affects: { types: ["creature"], colors: ["colorless"] }, kind: "+1/+1", amount: 2, cond: { type: "oppDamaged" } }, "Each other colorless creature you control has bloodthirst 2.")]) },

  "Cayth, Famed Mechanist": { patch: (def) => fix(def, [
    stat({ type: "pump", affects: { ...MINE, nontoken: true, other: true }, power: 0, toughness: 0, keywords: [{ fabricate: 1 }] }, "Other nontoken creatures you control have fabricate 1."),
    { kind: "activated", cost: { mana: "{2}", tap: true }, effects: [], text: "{2}, {T}: Choose one — • Populate. • Proliferate.", modes: { min: 1, max: 1, modes: [
      { text: "Populate.", targets: [], effects: [{ op: "populate" }] }, { text: "Proliferate.", targets: [], effects: [{ op: "proliferate" }] }] } }]) },

  "Razorfield Ripper": { patch: (def) => {
    const reconf = { oneOf: [{ mana: "{2}" }, { energy: 3 }] };
    const atk = (who) => trig({ event: "attacks", who }, [energy(1), { op: "pump", what: EVT, power: { countersOn: "you", kind: "energy" }, toughness: { countersOn: "you", kind: "energy" }, until: "endOfTurn" }],
      "Whenever this creature or equipped creature attacks, you get {E}, then it gets +X/+X until end of turn, where X is the amount of {E} you have.");
    return fix(def, [atk("self"), atk("equipped"),
      { kind: "activated", sorcery: true, cost: reconf, condition: { type: "notAttached" }, targets: [{ what: { ...MINE, other: true } }], effects: [{ op: "attach", what: "self", to: T(0) }], text: "Reconfigure—Pay {2} or {E}{E}{E}: Attach to target creature you control." },
      { kind: "activated", sorcery: true, cost: reconf, condition: { type: "attached" }, effects: [{ op: "unattach", what: "self" }], text: "Reconfigure—Pay {2} or {E}{E}{E}: Unattach from a creature." },
      stat({ type: "asType", affects: "self", setTypes: ["artifact"] }, "While attached, this isn't a creature.", { condition: { type: "attached" } })]);
  } },

  "Lightning Runner": { patch: (def) => fix(def, [trig(ATTACKS, [energy(2), { op: "may", cost: { energy: 8 }, effects: [untapMine, { op: "extraCombat" }] }],
    "Whenever this creature attacks, you get {E}{E}, then you may pay eight {E}. If you pay, untap all creatures you control, and after this phase, there is an additional combat phase.")]) },

  "Aethersphere Harvester": { patch: (def) => def },

  "Akroma's Will": { patch: (def) => out(def, { spell: { ...def.spell, targets: [], effects: [], modes: { min: 1, max: 1, maxIf: { cond: { type: "controlCommander" }, max: 2 }, modes: [
    { text: "Creatures you control gain flying, vigilance, and double strike until end of turn.", targets: [], effects: [{ op: "pump", what: ALL_MY_CREATURES, power: 0, toughness: 0, keywords: ["flying", "vigilance", "double strike"], until: "endOfTurn" }] },
    { text: "Creatures you control gain lifelink, indestructible, and protection from each color until end of turn.", targets: [], effects: [{ op: "pump", what: ALL_MY_CREATURES, power: 0, toughness: 0, keywords: ["lifelink", "indestructible", { protection: ["white", "blue", "black", "red", "green"] }], until: "endOfTurn" }] }] } } }) },

  "Bespoke Battlewagon": { patch: (def) => fix(def, [
    { kind: "activated", cost: { tap: true }, effects: [energy(2)], text: "{T}: You get {E}{E}." },
    { kind: "activated", cost: { energy: 4 }, effects: [{ op: "animate", what: "self", types: ["creature"], until: "endOfTurn" }], text: "Pay {E}{E}{E}{E}: This Vehicle becomes an artifact creature until end of turn." }]) },

  "Pteramander": { patch: (def) => fix(def, [{ kind: "activated", cost: { mana: "{7}{U}", reduce: { per: { count: { types: ["instant", "sorcery"], zone: "graveyard", owner: "you" } }, amount: -1 } },
    effects: [{ op: "if", cond: { type: "counters", what: "self", kind: "+1/+1", op: "==", n: 0 }, then: [{ op: "addCounters", what: "self", kind: "+1/+1", amount: 4 }] }],
    text: "{7}{U}: Adapt 4. This ability costs {1} less to activate for each instant and sorcery card in your graveyard." }]) },

  "Foreboding Steamboat": { patch: (def) => fix(def, [], { keep: def.unparsed }) },
  "Merchant of Truth": { patch: (def) => fix(def, [
    trig({ event: "dies", who: { types: ["creature"], controller: "you", nontoken: true } }, [{ op: "createToken", who: "you", token: "clue", amount: 1 }], "Whenever a nontoken creature you control dies, investigate."),
    stat({ type: "pump", affects: { subtypes: ["clue"], controller: "you" }, power: 0, toughness: 0, keywords: ["exalted"] }, "Clues you control have exalted.")], { drop: (a) => !isManual(a) }) },

  "Ransom Note": { patch: (def) => fix(def, [{ kind: "activated", cost: { mana: "{2}", sacSelf: true }, effects: [], text: "{2}, Sacrifice this artifact: Choose one — • Cloak the top card of your library. • Goad target creature. • Draw a card.", modes: { min: 1, max: 1, modes: [
    { text: "Cloak the top card of your library.", targets: [], effects: [{ op: "manifest", cloak: true }] },
    { text: "Goad target creature.", targets: [{ what: { types: ["creature"] } }], effects: [{ op: "goad", what: T(0) }] },
    { text: "Draw a card.", targets: [], effects: [{ op: "draw", who: "you", amount: 1 }] }] } }]) },

  "Serene Sleuth": { patch: (def) => fix(def, [
    trig(ENTERS, [{ op: "createToken", who: "you", token: "clue", amount: 1 }], "When this creature enters, investigate."),
    trig(BEGIN_COMBAT, [{ op: "createToken", who: "you", token: "clue", amount: { count: { ...MINE, goaded: true } } }, { op: "ungoad", what: ALL_MY_CREATURES }],
      "At the beginning of combat on your turn, investigate for each goaded creature you control. Then each creature you control is no longer goaded.")]) },

  "Neheb, the Eternal": { patch: (def) => fix(def, [trig({ event: "beginStep", step: "main2", whose: "you" }, [{ op: "addMana", mana: { color: "R", n: { lifeLostThisTurn: "opponent" } } }],
    "At the beginning of each of your postcombat main phases, add {R} for each 1 life your opponents have lost this turn.")]) },

  "Temur War Shaman": { patch: (def) => fix(def, [
    trig(ENTERS, [{ op: "manifest" }], "When this creature enters, manifest the top card of your library."),
    trig({ event: "turnedFaceUp", who: { types: ["creature"], controller: "you" } }, [{ op: "fight", a: EVT, b: T(0) }], "Whenever a permanent you control is turned face up, if it's a creature, you may have it fight target creature you don't control.", { optional: true, targets: [{ what: OPP_CREATURE }] })]) },

  "Immortal Obligation": { patch: (def) => out(def, { spell: { ...def.spell, targets: [{ what: { types: ["creature"], zone: "graveyard", owner: "opponent" }, zone: "graveyard" }], effects: [{ run: function* (g, ctx) {
    const o = g.obj((ctx.targets[0] || [])[0]);
    if (!o || o.zone !== "graveyard") return;
    yield* g.zoneMove$(o, "battlefield", { controller: o.owner });
    if (o.zone !== "battlefield") return;
    const duty = { type: "counters", what: "self", kind: "duty", op: ">=", n: 1 };
    g.addCounters(o, "duty", 1);
    const by = ctx.you;
    const abs = [
      stat({ type: "goaded", affects: "self", by }, "goaded", { condition: duty }),
      stat({ type: "cantAttackPlayer", affects: "self", who: "you", by }, "can't attack you or a permanent you control", { condition: duty }),
      stat({ type: "cantBlockControlledBy", affects: "self", by }, "can't block creatures you control", { condition: duty }),
    ];
    g.addEffect({ type: "pump", power: 0, toughness: 0, keywords: [], abilities: abs }, { ...ctx, source: o }, { objIds: [o.id], until: null });
    g.markDirty(); g.refresh();
  } }] } }) },

  "Havoc Eater": { patch: (def) => fix(def, [trig(ENTERS, [{ op: "goad", what: T(0) }, { op: "addCounters", what: "self", kind: "+1/+1", amount: { powerOf: { ref: "it" } } }],
    "When this creature enters, for each opponent, goad up to one target creature that opponent controls. Put X +1/+1 counters on this creature, where X is the total power of creatures goaded this way.", { targets: [{ what: OPP_CREATURE, min: 0, max: 1 }] })]) },

  "Take the Bait": { patch: (def) => out(def, { castRestrict: { type: "and", all: [{ type: "notYourTurn" }, { type: "duringCombat" }] }, spell: { ...def.spell, targets: [], effects: [
    { op: "until", until: "endOfTurn", static: { type: "damageMod", to: "youOrPermanent", prevent: "all", combatOnly: true } },
    { op: "untap", what: { ref: "all", filter: { types: ["creature"], attacking: true } } },
    { op: "goad", what: { ref: "all", filter: { types: ["creature"], attacking: true } } },
    { op: "extraCombat" }] } }) },

  "Duelist's Heritage": { patch: (def) => fix(def, [trig({ event: "attackDeclared", who: "each" }, [{ op: "pump", what: T(0), power: 0, toughness: 0, keywords: ["double strike"], until: "endOfTurn" }],
    "Whenever one or more creatures attack, you may have target attacking creature gain double strike until end of turn.", { optional: true, targets: [{ what: { types: ["creature"], attacking: true } }] })]) },

  "Agitator Ant": { patch: (def) => fix(def, [trig({ event: "beginStep", step: "end", whose: "you" }, [], "At the beginning of your end step, each player may put two +1/+1 counters on a creature they control. Goad each creature that had counters put on it this way.", { run: function* (g, ctx) {
    const hit = [];
    for (const p of g.apnap(g.state.players.filter((x) => !x.lost).map((x) => x.idx))) {
      const mine = g.find({ types: ["creature"] }, ctx).filter((o) => o.controller === p);
      if (!mine.length) continue;
      const ch = yield* g.chooseObjects$(p, mine, { prompt: "Agitator Ant: put two +1/+1 counters on a creature you control (it will be goaded)? Choose none to decline", min: 0, max: 1, reason: "generic", source: ctx.source.id, hint: { kind: "agitator" } });
      if (ch[0]) { g.addCounters(ch[0], "+1/+1", 2); hit.push(ch[0]); }
    }
    for (const o of hit) g.goad(o, ctx.you);
  } })]) },

  "Spectacular Showdown": { patch: (def) => out(def, { spell: { ...def.spell, targets: [{ what: { types: ["creature"] } }], effects: [{ op: "addCounters", what: T(0), kind: "double strike", amount: 1 }, { op: "goad", what: { ref: "it" } }] } }) },

  "Vow of Lightning": { patch: (def) => fix(def, [
    stat({ type: "pump", affects: "enchanted", power: 2, toughness: 2, keywords: ["first strike"] }, "Enchanted creature gets +2/+2, has first strike"),
    stat({ type: "cantAttackPlayer", affects: "enchanted", who: "you" }, "and can't attack you or planeswalkers you control.")]) },

  "Bloodthirsty Blade": { patch: (def) => fix(def, [{ kind: "activated", sorcery: true, cost: { mana: "{1}" }, targets: [{ what: OPP_CREATURE }], effects: [{ op: "attach", what: "self", to: T(0) }], text: "{1}: Attach this Equipment to target creature an opponent controls. Activate only as a sorcery." }]) },

  "Wayta, Trainer Prodigy": { patch: (def) => fix(def, [
    { kind: "activated", cost: { mana: "{2}{G}", tap: true, reduce: { amount: -2, if: { cond: { type: "bothTargetsYours" } } } }, targets: [{ what: MINE }, { what: { types: ["creature"] }, other: true }], effects: [{ op: "fight", a: T(0), b: T(1) }],
      text: "{2}{G}, {T}: Target creature you control fights another target creature. This ability costs {2} less to activate if it targets two creatures you control." },
    stat({ type: "doubleTriggers", event: "dealtDamage", filter: MINE }, "If a creature you control being dealt damage causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.")]) },

  "Dinosaur Egg": { patch: (def) => fix(def, [{ kind: "triggered", on: { event: "dies", who: "self" }, optional: true, effects: [{ op: "_discover", amount: { toughnessOf: { ref: "event", what: "object" } } }], text: "When this creature dies, you may discover X, where X is its toughness." }]) },

  "Scion of Calamity": { patch: (def) => fix(def, [trig({ event: "dealsCombatDamage", who: "self", to: "player" }, [{ op: "destroy", what: T(0) }], "Whenever this creature deals combat damage to a player, destroy target artifact or enchantment that player controls.", { targets: [{ what: { types: ["artifact", "enchantment"], controller: "opponent" } }] })]) },
  "Aberrant": { patch: (def) => fix(def, [trig({ event: "dealsCombatDamage", who: "self", to: "player" }, [{ op: "destroy", what: T(0) }], "Heavy Power Hammer — Whenever this creature deals combat damage to a player, destroy target artifact or enchantment that player controls.", { targets: [{ what: { types: ["artifact", "enchantment"], controller: "opponent" } }] })]) },

  "Rhythm of the Wild": { patch: (def) => fix(def, [stat({ type: "cantBeCountered", affects: { types: ["creature"], controller: "you" } }, "Creature spells you control can't be countered.")]) },

  "Tributary Instructor": { patch: (def) => fix(def, [trig({ event: "dies", who: { ...MINE, counters: { kind: "+1/+1" } } }, [{ op: "draw", who: "you", amount: 1 }], "Whenever a creature you control with a +1/+1 counter on it dies, draw a card.")]) },

  "Llanowar Reborn": { patch: (def) => fix(def, [
    stat({ type: "entersWithCounters", kind: "+1/+1", amount: 1 }, "Graft 1 (This land enters with a +1/+1 counter on it.)"),
    trig({ event: "enters", who: { types: ["creature"], other: true } }, [{ op: "removeCounters", what: "self", kind: "+1/+1", amount: 1 }, { op: "addCounters", what: EVT, kind: "+1/+1", amount: 1 }],
      "Whenever another creature enters, you may move a +1/+1 counter from this land onto it.", { optional: true, condition: { type: "counters", what: "self", kind: "+1/+1", op: ">=", n: 1 } })]) },

  "Port Razer": { patch: (def) => fix(def, [stat({ type: "noReattack", affects: "self" }, "This creature can't attack a player it has already attacked this turn."),
    trig({ event: "dealsCombatDamage", who: "self", to: "player" }, [untapMine, { op: "extraCombat" }], "Whenever this creature deals combat damage to a player, untap each creature you control. After this phase, there is an additional combat phase.")]) },
  "Bloodthirster": { patch: (def) => fix(def, [stat({ type: "noReattack", affects: "self" }, "This creature can't attack a player it has already attacked this turn."),
    trig({ event: "dealsCombatDamage", who: "self", to: "player" }, [{ op: "untap", what: "self" }, { op: "extraCombat" }], "Whenever this creature deals combat damage to a player, untap it. After this phase, there is an additional combat phase.")]) },

  "Taunting Sliver": { patch: (def) => fix(def, [stat({ type: "pump", affects: { subtypes: ["sliver"], controller: "you" }, power: 0, toughness: 0,
    abilities: [trig(ENTERS, [{ op: "goad", what: T(0) }], "When this creature enters, goad target creature an opponent controls.", { targets: [{ what: OPP_CREATURE }] })] }, "Sliver creatures you control have \"When this creature enters, goad target creature an opponent controls.\"")]) },
  "Lazotep Sliver": { patch: (def) => fix(def, [stat({ type: "pump", affects: { subtypes: ["sliver"], controller: "you" }, power: 0, toughness: 0, keywords: [{ afflict: 2 }] }, "Sliver creatures you control have afflict 2.")]) },

  "Ghoulish Impetus": { patch: (def) => fix(def, [
    stat({ type: "pump", affects: "enchanted", power: 1, toughness: 1, keywords: ["deathtouch"] }, "Enchanted creature gets +1/+1, has deathtouch"),
    stat({ type: "goaded", affects: "enchanted" }, "and is goaded."),
    trig({ event: "dies", who: "enchanted" }, [], "When enchanted creature dies, return this card to the battlefield at the beginning of the next end step.", { run: function* (g, ctx) {
      const id = ctx.source.id;
      g.addDelayed({ event: "beginStep", step: "end", whose: "each" }, null, ctx, true, function* (g2, c2) {
        const o = g2.obj(id);
        if (!o || o.zone !== "graveyard") return;
        const cands = g2.find({ types: ["creature"] }, c2);
        if (!cands.length) return;
        const ch = yield* g2.chooseObjects$(o.owner, cands, { prompt: "Ghoulish Impetus returns: choose a creature to enchant", min: 1, max: 1, reason: "target", source: id });
        if (ch[0]) yield* g2.zoneMove$(o, "battlefield", { controller: o.owner, attachTo: ch[0].id });
      });
    } })], { drop: (a) => !isManual(a) && !(a.on && a.on.event === "dies") }) },

  "Kaldra Compleat": { patch: (def) => fix(def, [stat({ type: "pump", affects: "equipped", power: 5, toughness: 5, keywords: ["first strike", "trample", "indestructible", "haste"],
    abilities: [trig({ event: "dealsCombatDamage", who: "self", to: "creature" }, [{ op: "exile", what: { ref: "event", what: "target" } }], "Whenever this creature deals combat damage to a creature, exile that creature.")] }, "Equipped creature gets +5/+5 and has first strike, trample, indestructible, haste, and \"Whenever this creature deals combat damage to a creature, exile that creature.\"")]) },

  "Exocrine": { patch: (def) => fix(def, [trig(ENTERS, [{ op: "damage", amount: "x", to: "eachPlayer" }, { op: "damage", amount: "x", to: { ref: "all", filter: { types: ["creature"], other: true } } }],
    "Bio-plasmic Barrage — When this creature enters, it deals X damage to each player and each other creature.")]) },
  "Broodlord": { patch: (def) => fix(def, [trig(ENTERS, [{ op: "addCounters", what: T(0), kind: "+1/+1", amount: "x", divided: true }],
    "Brood Telepathy — When this creature enters, distribute X +1/+1 counters among any number of other target creatures you control.", { targets: [{ what: { ...MINE, other: true }, min: 1, max: 20 }] })]) },
  "Tervigon": { patch: (def) => fix(def, [trig({ event: "dealsCombatDamage", who: "self", to: "player" }, [{ op: "createToken", who: "you", amount: { event: "amount" }, token: { name: "Tyranid", types: ["creature"], subtypes: ["tyranid"], colors: ["G"], power: 1, toughness: 1 } }],
    "Spawn Termagants — Whenever this creature deals combat damage to a player, create that many 1/1 green Tyranid creature tokens.")]) },
  "Tyrant Guard": { patch: (def) => fix(def, [{ kind: "activated", cost: { sacSelf: true }, effects: [{ op: "pump", what: { ref: "all", filter: { ...MINE, anyCounters: true } }, power: 0, toughness: 0, keywords: ["hexproof", "indestructible"], until: "endOfTurn" }],
    text: "Shieldwall — Sacrifice this creature: Creatures you control with counters on them gain hexproof and indestructible until end of turn." }]) },
  "Deathleaper, Terror Weapon": { patch: (def) => fix(def, [stat({ type: "pump", affects: { ...MINE, enteredThisTurn: true }, power: 0, toughness: 0, keywords: ["double strike"] }, "Flesh Hooks — Creatures you control that entered this turn have double strike.")]) },
  "Mawloc": { patch: (def) => fix(def, [trig(ENTERS, [{ op: "until", until: "endOfTurn", static: { type: "exileInsteadOfDying", affects: T(0) } }, { op: "fight", a: "self", b: T(0) }],
    "Terror from the Deep — When this creature enters, it fights up to one target creature an opponent controls. If that creature would die this turn, exile it instead.", { targets: [{ what: OPP_CREATURE, min: 0, max: 1 }] })]) },
  "Ravener": { patch: (def) => fix(def, [trig(ENTERS, [], "When this creature enters, target creature attacks target opponent this turn if able.", { targets: [{ what: { types: ["creature"] } }, { what: "opponent" }], run: function* (g, ctx) {
    const c = (ctx.targets[0] || [])[0], q = (ctx.targets[1] || [])[0];
    if (!c || !q) return;
    g.addEffect({ type: "mustAttackPlayer", player: +q.slice(1) }, ctx, { objIds: [c], until: "endOfTurn" });
    g.markDirty();
  } })]) },

  "Szarekh, the Silent King": { patch: (def) => fix(def, [trig(ATTACKS, [], "My Will Be Done — Whenever Szarekh attacks, mill three cards. You may put an artifact creature card or Vehicle card from among the cards milled this way into your hand.", { run: function* (g, ctx) {
    const pl = g.state.players[ctx.you];
    const milled = [];
    for (let i = 0; i < 3 && pl.library.length; i++) { const o = g.state.objects[pl.library[pl.library.length - 1]]; g.moveObj(o, "graveyard"); milled.push(o); }
    const cands = milled.filter((o) => o.zone === "graveyard" && ((o.def.types.includes("artifact") && o.def.types.includes("creature")) || o.def.subtypes.includes("vehicle")));
    if (!cands.length) return;
    const ch = yield* g.chooseObjects$(ctx.you, cands, { prompt: "Put an artifact creature card or Vehicle card into your hand?", min: 0, max: 1, reason: "return", source: ctx.source.id });
    if (ch[0]) g.moveObj(ch[0], "hand");
  } })]) },
  "Necron Monolith": { patch: (def) => fix(def, [trig(ATTACKS, [], "Eternity Gate — Whenever this Vehicle attacks, mill three cards. For each creature card milled this way, create a 2/2 black Necron Warrior artifact creature token.", { run: function* (g, ctx) {
    const pl = g.state.players[ctx.you];
    let n = 0;
    for (let i = 0; i < 3 && pl.library.length; i++) { const o = g.state.objects[pl.library[pl.library.length - 1]]; g.moveObj(o, "graveyard"); if (o.def.types.includes("creature")) n++; }
    if (n) g.createToken(ctx.you, { name: "Necron Warrior", types: ["artifact", "creature"], subtypes: ["necron", "warrior"], colors: ["B"], power: 2, toughness: 2 }, n, { source: ctx.source });
  } })]) },
  "Space Marine Devastator": { patch: (def) => fix(def, [trig(ENTERS, [{ op: "destroy", what: T(0) }], "Grav-cannon — When this creature enters, destroy up to one target artifact or enchantment.", { targets: [{ what: { types: ["artifact", "enchantment"] }, min: 0, max: 1 }] })]) },
  "Knight Paladin": { patch: (def) => fix(def, [trig(ENTERS, [{ op: "damage", amount: 4, to: "opponent" }], "Rapid-fire Battle Cannon — When this Vehicle enters, it deals 4 damage to each opponent.")]) },
  "Reaver Titan": { patch: (def) => fix(def, [], { set: { keywords: { ...def.keywords, protection: [{ cmc: { op: "<=", n: 3 } }] } } }) },

  "Ezuri's Predation": { patch: (def) => out(def, { spell: { ...def.spell, targets: [], effects: [{ run: function* (g, ctx) {
    const victims = g.find({ types: ["creature"], controller: "opponent" }, ctx);
    if (!victims.length) return;
    const beasts = g.createToken(ctx.you, { name: "Phyrexian Beast", types: ["creature"], subtypes: ["phyrexian", "beast"], colors: ["G"], power: 4, toughness: 4 }, victims.length, { source: ctx.source });
    let left = [...victims];
    for (const b of beasts) {
      left = left.filter((v) => v.zone === "battlefield");
      if (!left.length || b.zone !== "battlefield") break;
      const ch = yield* g.chooseObjects$(ctx.you, left, { prompt: "Choose a creature for this Beast token to fight", min: 1, max: 1, reason: "target", source: ctx.source.id, hint: { kind: "effect", effects: [{ op: "fight", a: { ref: "target", i: 0 }, b: { ref: "target", i: 1 } }] } });
      if (!ch[0]) continue;
      left = left.filter((v) => v.id !== ch[0].id);
      yield* g.runEffects$([{ op: "fight", a: T(0), b: T(1) }], { ...ctx, targets: [[b.id], [ch[0].id]] });
    }
  } }] } }) },
  "Tangleweave Armor": { patch: (def) => fix(def, [stat({ type: "pump", affects: "equipped", power: { commanderCmc: true }, toughness: { commanderCmc: true } }, "Equipped creature gets +X/+X, where X is the greatest mana value among your commanders.")]) },
  "Monstrous Onslaught": { patch: (def) => out(def, { spell: { ...def.spell, targets: [{ what: { types: ["creature"] }, min: 1, max: 20 }], effects: [{ op: "damage", amount: { greatest: "power", of: MINE }, to: T(0), divided: true }] } }) },
  "Hellkite Charger": { patch: (def) => fix(def, [trig(ATTACKS, [{ op: "may", cost: { mana: "{5}{R}{R}" }, effects: [untapAttackers, { op: "extraCombat" }] }], "Whenever this creature attacks, you may pay {5}{R}{R}. If you do, untap all attacking creatures and after this phase, there is an additional combat phase.")]) },

  "Hearthhull, the Worldseed": { patch: (def) => fix(def, [
    { kind: "activated", cost: { mana: "{1}", tap: true, sac: { types: ["land"] } }, condition: spacecraft(2), effects: [{ op: "draw", who: "you", amount: 2 }, { op: "extraLand" }], text: "2+ | {1}, {T}, Sacrifice a land: Draw two cards. You may play an additional land this turn." },
    grantAt(8, ["flying", "vigilance", "haste"]), becomesCreatureAt(8)]) },
  "Moraug, Fury of Akoum": { patch: (def) => fix(def, [
    stat({ type: "pump", affects: MINE, power: { attackedTimes: true }, toughness: 0 }, "Each creature you control gets +1/+0 for each time it has attacked this turn."),
    trig({ event: "enters", who: { types: ["land"], controller: "you" } }, [{ op: "extraCombat", untapAll: true }], "Landfall — Whenever a land you control enters, if it's your main phase, there's an additional combat phase after this phase. At the beginning of that combat, untap all creatures you control.", { condition: { type: "mainPhase" } })]) },
  "Inspirit, Flagship Vessel": { patch: (def) => fix(def, [
    trig(BEGIN_COMBAT, [], "1+ | At the beginning of combat on your turn, put your choice of a +1/+1 counter or two charge counters on up to one other target artifact.", { condition: spacecraft(1), targets: [{ what: { types: ["artifact"], other: true }, min: 0, max: 1 }], run: function* (g, ctx) {
      const t = g.obj((ctx.targets[0] || [])[0]);
      if (!t || t.zone !== "battlefield") return;
      const ch = yield* g.choose$(ctx.you, { prompt: `Put a +1/+1 counter or two charge counters on ${t.c.name}`, options: [{ id: "+1/+1", label: "A +1/+1 counter", type: "mode" }, { id: "charge", label: "Two charge counters", type: "mode" }], min: 1, max: 1, reason: "mode", source: ctx.source.id, hint: { kind: "counterKind", obj: t.id } });
      if (ch[0]?.id === "charge") g.addCounters(t, "charge", 2); else g.addCounters(t, "+1/+1", 1);
    } }),
    grantAt(8, ["flying"]), becomesCreatureAt(8)]) },
  "Uthros Research Craft": { patch: (def) => fix(def, [
    trig({ event: "cast", who: "you", filter: { types: ["artifact"] } }, [{ op: "draw", who: "you", amount: 1 }, { op: "addCounters", what: "self", kind: "charge", amount: 1 }], "3+ | Whenever you cast an artifact spell, draw a card. Put a charge counter on this Spacecraft.", { condition: spacecraft(3) }),
    grantAt(12, ["flying"]), becomesCreatureAt(12)]) },
  "Depthshaker Titan": { patch: (def) => fix(def, [trig(ENTERS, [], "When this creature enters, any number of target noncreature artifacts you control become 3/3 artifact creatures. Sacrifice them at the beginning of the next end step.", {
    targets: [{ what: { types: ["artifact"], notTypes: ["creature"], controller: "you" }, min: 0, max: 20 }], run: function* (g, ctx) {
      const ids = (ctx.targets[0] || []).filter((id) => g.obj(id)?.zone === "battlefield");
      if (!ids.length) return;
      g.addEffect({ type: "asType", addTypes: ["creature"], power: 3, toughness: 3 }, ctx, { objIds: ids, until: "never" });
      g.addDelayed({ event: "beginStep", step: "end", whose: "each" }, [{ op: "_sacrificeObjs", ids }], ctx, true);
      g.markDirty();
    } })]) },
  "Gavel of the Righteous": { patch: (def) => fix(def, [
    stat({ type: "pump", affects: "equipped", power: { countersOn: "self", kind: "charge" }, toughness: { countersOn: "self", kind: "charge" } }, "Equipped creature gets +1/+1 for each counter on this Equipment."),
    stat({ type: "pump", affects: "equipped", power: 0, toughness: 0, keywords: ["double strike"] }, "As long as this Equipment has four or more counters on it, equipped creature has double strike.", { condition: { type: "counters", what: "self", kind: "charge", op: ">=", n: 4 } }),
    { kind: "activated", synthetic: "equip", sorcery: true, cost: { oneOf: [{ mana: "{3}" }, { removeCounters: { kind: "charge", n: 1 } }] }, targets: [{ what: { ...MINE, other: true } }], effects: [{ op: "attach", what: "self", to: T(0) }], text: "Equip—Pay {3} or remove a counter from this Equipment." }]) },
};
