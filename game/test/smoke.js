// smoke.js — hand-written CardDefs (IR) for engine tests + a random-legal-answer bot.
// Run directly:  node game/test/smoke.js [--games N] [--seed S] [--real]
//   --real  plays the real decks (helpers.allDecks() + overrides.compileCard) instead of the hand-built pool.
import { createGame } from "../engine.js";

const T = (who) => ({ ref: "target", i: who });
const land = (name, sub, extra = {}) => ({ name, cost: "", types: ["land"], supertypes: sub ? ["basic"] : [], subtypes: sub ? [sub] : [], ...extra });
const cre = (name, cost, p, t, extra = {}) => ({ name, cost, types: ["creature"], subtypes: extra.subtypes || ["bear"], power: p, toughness: t, colors: extra.colors || colorsOf(cost), ...extra });
const spell = (name, cost, type, sp, extra = {}) => ({ name, cost, types: [type], colors: extra.colors || colorsOf(cost), spell: sp, ...extra });
function colorsOf(cost) { return [...new Set((cost.match(/[WUBRG]/g) || []))]; }
const manaAb = (mana, extra = {}) => ({ kind: "activated", cost: { tap: true }, mana: true, effects: [{ op: "addMana", mana }], text: "{T}: Add mana.", ...extra });

export const DEFS = {};
const add = (d) => { DEFS[d.name] = d; return d; };
[
  land("Forest", "forest"), land("Mountain", "mountain"), land("Swamp", "swamp"), land("Island", "island"), land("Plains", "plains"),
  land("Rootbound Crag", null, { abilities: [manaAb({ anyOf: ["R", "G"], n: 1 })] }),
  land("Battlefield Forge", null, { abilities: [manaAb("{C}"), { kind: "activated", cost: { tap: true }, mana: true, effects: [{ op: "addMana", mana: { anyOf: ["R", "W"], n: 1 } }, { op: "damage", amount: 1, to: "you" }], text: "{T}: Add {R} or {W}. This land deals 1 damage to you." }] }),
  land("Command Tower", null, { abilities: [manaAb({ identity: 1 })] }),
  land("Tapland", null, { abilities: [manaAb("{B}"), { kind: "static", effect: { type: "entersTapped", affects: "self" } }] }),
  { name: "Sol Ring", cost: "{1}", types: ["artifact"], abilities: [manaAb("{C}{C}")] },
  { name: "Arcane Signet", cost: "{2}", types: ["artifact"], abilities: [manaAb({ identity: 1 })] },
  { name: "Boros Signet", cost: "{2}", types: ["artifact"], abilities: [{ kind: "activated", cost: { mana: "{1}", tap: true }, mana: true, effects: [{ op: "addMana", mana: "{R}{W}" }], text: "{1}, {T}: Add {R}{W}." }] },
  cre("Llanowar Elves", "{G}", 1, 1, { subtypes: ["elf", "druid"], abilities: [manaAb("{G}")] }),
  cre("Grizzly Bears", "{1}{G}", 2, 2),
  cre("Hill Giant", "{3}{R}", 3, 3, { subtypes: ["giant"] }),
  cre("Serra Angel", "{3}{W}{W}", 4, 4, { subtypes: ["angel"], keywords: { flying: true, vigilance: true } }),
  cre("Giant Spider", "{3}{G}", 2, 4, { subtypes: ["spider"], keywords: { reach: true } }),
  cre("Typhoid Rats", "{B}", 1, 1, { subtypes: ["rat"], keywords: { deathtouch: true } }),
  cre("Vampire Nighthawk", "{1}{B}{B}", 2, 3, { subtypes: ["vampire"], keywords: { flying: true, deathtouch: true, lifelink: true } }),
  cre("Goblin Guide", "{R}", 2, 2, { subtypes: ["goblin"], keywords: { haste: true } }),
  cre("Kraul Swarm", "{4}{G}", 5, 5, { subtypes: ["insect"], keywords: { trample: true } }),
  cre("White Knight", "{W}{W}", 2, 2, { subtypes: ["knight"], keywords: { "first strike": true, protection: ["black"] } }),
  cre("Fencing Ace", "{1}{W}", 1, 1, { subtypes: ["human"], keywords: { "double strike": true } }),
  cre("Goblin Heelcutter", "{3}{R}", 3, 2, { subtypes: ["goblin"], keywords: { menace: true } }),
  cre("Wall of Stone", "{1}{R}{R}", 0, 8, { subtypes: ["wall"], keywords: { defender: true } }),
  cre("Hexproof Bear", "{1}{G}", 2, 2, { keywords: { hexproof: true } }),
  cre("Warded Raptor", "{2}{G}{G}", 5, 3, { subtypes: ["dinosaur"], keywords: { ward: "{2}" } }),
  cre("Prowess Monk", "{1}{R}", 1, 2, { subtypes: ["monk"], keywords: { prowess: true } }),
  cre("Undying Bear", "{1}{B}", 2, 1, { keywords: { undying: true } }),
  cre("Indestructible Golem", "{4}", 3, 3, { colors: [], subtypes: ["golem"], keywords: { indestructible: true } }),
  cre("Blood Artist", "{1}{B}", 0, 1, { subtypes: ["vampire"], abilities: [{ kind: "triggered", on: { event: "dies", who: { types: ["creature"] } }, targets: [{ what: "player" }],
    effects: [{ op: "loseLife", who: T(0), amount: 1 }, { op: "gainLife", who: "you", amount: 1 }], text: "Whenever this creature or another creature dies, target player loses 1 life and you gain 1 life." }] }),
  cre("Flametongue Kavu", "{3}{R}", 4, 2, { subtypes: ["kavu"], abilities: [{ kind: "triggered", on: { event: "enters", who: "self" }, targets: [{ what: { types: ["creature"] } }],
    effects: [{ op: "damage", amount: 4, to: T(0) }], text: "When this creature enters, it deals 4 damage to target creature." }] }),
  cre("Carrier Thrall", "{1}{B}", 2, 1, { subtypes: ["vampire"], abilities: [{ kind: "triggered", on: { event: "dies", who: "self" }, effects: [{ op: "createToken", who: "you", token: "eldrazi scion", amount: 1 }], text: "When this dies, create a Scion." }] }),
  cre("Pitiless Plunderer", "{3}{B}", 1, 4, { subtypes: ["human"], abilities: [{ kind: "triggered", on: { event: "dies", who: { types: ["creature"], controller: "you", other: true } }, effects: [{ op: "createToken", who: "you", token: "treasure", amount: 1 }], text: "Whenever another creature you control dies, create a Treasure." }] }),
  cre("Viscera Seer", "{B}", 1, 1, { subtypes: ["vampire"], abilities: [{ kind: "activated", cost: { sac: { types: ["creature"] } }, effects: [{ op: "scry", amount: 1 }], text: "Sacrifice a creature: Scry 1." }] }),
  cre("Raging Attacker", "{2}{R}", 3, 1, { abilities: [{ kind: "triggered", on: { event: "attacks", who: "self" }, effects: [{ op: "damage", amount: 1, to: "opponent" }], text: "Whenever this attacks, it deals 1 damage to each opponent." }] }),
  cre("Drivnod, Carnage Dominus", "{3}{B}{B}", 8, 3, { supertypes: ["legendary"], subtypes: ["phyrexian", "horror"], abilities: [{ kind: "static", effect: { type: "doubleTriggers", event: "dies", filter: { types: ["creature"] } } }] }),
  cre("Glorious Anthem Lord", "{1}{W}{W}", 2, 2, { subtypes: ["human"], abilities: [{ kind: "static", effect: { type: "pump", affects: { types: ["creature"], controller: "you", other: true }, power: 1, toughness: 1 } }] }),
  cre("Goreclaw", "{3}{G}", 4, 3, { supertypes: ["legendary"], subtypes: ["bear"], abilities: [{ kind: "static", effect: { type: "costMod", who: "you", filter: { types: ["creature"], power: { op: ">=", n: 4 } }, amount: -2 } }] }),
  cre("Fleshbag Marauder", "{2}{B}", 3, 1, { subtypes: ["zombie"], abilities: [{ kind: "triggered", on: { event: "enters", who: "self" }, effects: [{ op: "sacrifice", who: "eachPlayer", filter: { types: ["creature"] }, amount: 1 }], text: "When this enters, each player sacrifices a creature." }] }),
  cre("Nazgul", "{2}{B}", 1, 2, { subtypes: ["wraith", "knight"], keywords: { deathtouch: true }, abilities: [{ kind: "triggered", on: { event: "enters", who: "self" }, effects: [{ op: "ringTempts", who: "you" }], text: "When this enters, the Ring tempts you." },
    { kind: "triggered", on: { event: "ringTempts", who: "you" }, effects: [{ op: "addCounters", what: { ref: "all", filter: { subtypes: ["wraith"], controller: "you" } }, kind: "+1/+1", amount: 1 }], text: "Whenever the Ring tempts you, put a +1/+1 counter on each Wraith you control." }] }),
  cre("Karmic Guide", "{3}{W}{W}", 2, 2, { subtypes: ["angel"], keywords: { flying: true }, abilities: [{ kind: "triggered", on: { event: "enters", who: "self" }, targets: [{ what: { types: ["creature"], zone: "graveyard", owner: "you" }, zone: "graveyard" }],
    effects: [{ op: "move", what: T(0), to: "battlefield", control: "you" }], text: "When this enters, return target creature card from your graveyard to the battlefield." }] }),
  cre("Bonecrusher Giant", "{2}{R}", 4, 3, { subtypes: ["giant"], layout: "adventure", faces: "ADV" }),
  cre("Weird Op Bear", "{1}{G}", 2, 2, { abilities: [{ kind: "triggered", on: { event: "enters", who: "self" }, effects: [{ op: "frobnicate", text: "Frobnicate everything." }], text: "When this enters, frobnicate." }] }),
  cre("Broken Trigger Bear", "{1}{G}", 2, 2, { abilities: [{ kind: "triggered", on: { event: "zorp" }, effects: [] }, { kind: "static", effect: { type: "warpReality" } }, { kind: "activated", cost: { tap: true }, effects: [{ op: "draw" }, null, { foo: 1 }, { op: "damage", to: { ref: "weird" } }], text: "{T}: weird stuff" }] }),
  spell("Lightning Bolt", "{R}", "instant", { targets: [{ what: "any" }], effects: [{ op: "damage", amount: 3, to: T(0) }] }),
  spell("Shock", "{R}", "instant", { targets: [{ what: "any" }], effects: [{ op: "damage", amount: 2, to: T(0) }] }),
  spell("Counterspell", "{U}{U}", "instant", { targets: [{ what: "spell", zone: "stack" }], effects: [{ op: "counter", what: T(0) }] }),
  spell("Mana Leak", "{1}{U}", "instant", { targets: [{ what: "spell", zone: "stack" }], effects: [{ op: "counter", what: T(0), unlessPay: "{3}" }] }),
  spell("Murder", "{1}{B}{B}", "instant", { targets: [{ what: { types: ["creature"] } }], effects: [{ op: "destroy", what: T(0) }] }),
  spell("Swords to Plowshares", "{W}", "instant", { targets: [{ what: { types: ["creature"] } }], effects: [{ op: "exile", what: T(0) }, { op: "gainLife", who: { ref: "controllerOf", of: T(0) }, amount: { powerOf: { ref: "it" } } }] }),
  spell("Wrath of God", "{2}{W}{W}", "sorcery", { effects: [{ op: "destroy", what: { ref: "all", filter: { types: ["creature"] } } }] }),
  spell("Diabolic Edict", "{1}{B}", "instant", { targets: [{ what: "player" }], effects: [{ op: "sacrifice", who: T(0), filter: { types: ["creature"] }, amount: 1 }] }),
  spell("Demonic Tutor", "{1}{B}", "sorcery", { effects: [{ op: "search", who: "you", filter: {}, min: 0, max: 1, to: "hand" }] }),
  spell("Rampant Growth", "{1}{G}", "sorcery", { effects: [{ op: "search", who: "you", filter: { types: ["land"], supertypes: ["basic"] }, min: 0, max: 1, to: "battlefield", tapped: true }] }),
  spell("Reanimate", "{B}", "sorcery", { targets: [{ what: { types: ["creature"], zone: "graveyard" }, zone: "graveyard" }], effects: [{ op: "move", what: T(0), to: "battlefield", control: "you" }, { op: "loseLife", who: "you", amount: { cmcOf: { ref: "it" } } }] }),
  spell("Giant Growth", "{G}", "instant", { targets: [{ what: { types: ["creature"] } }], effects: [{ op: "pump", what: T(0), power: 3, toughness: 3 }] }),
  spell("Boros Charm", "{R}{W}", "instant", { modes: { min: 1, max: 1, modes: [
    { text: "4 damage to target player or planeswalker", targets: [{ what: { anyOf: [{ player: true }, { types: ["planeswalker"] }] } }], effects: [{ op: "damage", amount: 4, to: T(0) }] },
    { text: "Permanents you control gain indestructible until end of turn", effects: [{ op: "pump", what: { ref: "all", filter: { controller: "you", types: ["permanent"] } }, keywords: ["indestructible"] }] },
    { text: "Target creature gains double strike until end of turn", targets: [{ what: { types: ["creature"] } }], effects: [{ op: "pump", what: T(0), keywords: ["double strike"] }] }] }, effects: [] }),
  spell("Blaze", "{X}{R}", "sorcery", { targets: [{ what: "any" }], effects: [{ op: "damage", amount: "x", to: T(0) }] }),
  spell("Think Twice", "{1}{U}", "instant", { effects: [{ op: "draw", who: "you", amount: 1 }] }, { keywords: { flashback: "{2}{U}" } }),
  spell("Burst Lightning", "{R}", "instant", { targets: [{ what: "any" }], effects: [{ op: "if", cond: { type: "kicked" }, then: [{ op: "damage", amount: 4, to: T(0) }], else: [{ op: "damage", amount: 2, to: T(0) }] }] }, { keywords: { kicker: "{4}" } }),
  spell("Mizzium Mortars", "{1}{R}", "sorcery", { targets: [{ what: { types: ["creature"], controller: "opponent" } }], effects: [{ op: "damage", amount: 4, to: T(0) }] }, { keywords: { overload: "{3}{R}{R}{R}" } }),
  spell("Village Rites", "{B}", "instant", { effects: [{ op: "draw", who: "you", amount: 2 }] }, { additionalCost: { sac: { types: ["creature"] }, sacCount: 1 } }),
  spell("Fling", "{1}{R}", "instant", { targets: [{ what: "any" }], effects: [{ op: "damage", amount: { sacrificed: "power" }, to: T(0) }] }, { additionalCost: { sac: { types: ["creature"] }, sacCount: 1 } }),
  spell("Deadly Dispute", "{1}{B}", "instant", { effects: [{ op: "draw", who: "you", amount: 2 }, { op: "createToken", who: "you", token: "treasure", amount: 1 }] }, { additionalCost: { sac: { anyOf: [{ types: ["creature"] }, { types: ["artifact"] }] }, sacCount: 1 } }),
  spell("Birthday Escape", "{U}", "sorcery", { effects: [{ op: "draw", who: "you", amount: 1 }, { op: "ringTempts", who: "you" }] }),
  spell("Mystery Spell", "{1}", "sorcery", { effects: [{ op: "teleport" }, { op: "draw", who: "you", amount: 1 }] }),
  spell("Big Mystery", "{1}", "sorcery", null),
  { name: "Glorious Anthem", cost: "{1}{W}{W}", types: ["enchantment"], colors: ["W"], abilities: [{ kind: "static", effect: { type: "pump", affects: { types: ["creature"], controller: "you" }, power: 1, toughness: 1 } }] },
  { name: "Rancor", cost: "{G}", types: ["enchantment"], subtypes: ["aura"], colors: ["G"], enchant: { types: ["creature"] }, abilities: [{ kind: "static", effect: { type: "pump", affects: "enchanted", power: 2, toughness: 0, keywords: ["trample"] } }] },
  { name: "Bonesplitter", cost: "{1}", types: ["artifact"], subtypes: ["equipment"], keywords: { equip: "{1}" }, abilities: [{ kind: "static", effect: { type: "pump", affects: "equipped", power: 2, toughness: 0 } }] },
  { name: "Treasure Maker", cost: "{2}", types: ["artifact"], abilities: [{ kind: "activated", cost: { mana: "{1}", tap: true }, effects: [{ op: "createToken", who: "you", token: "treasure", amount: 1 }], text: "{1}, {T}: Create a Treasure." }] },
  { name: "Goblin Bombardment", cost: "{1}{R}", types: ["enchantment"], colors: ["R"], abilities: [{ kind: "activated", cost: { sac: { types: ["creature"] } }, targets: [{ what: "any" }], effects: [{ op: "damage", amount: 1, to: T(0) }], text: "Sacrifice a creature: 1 damage to any target." }] },
  { name: "Call of the Ring", cost: "{1}{B}", types: ["enchantment"], colors: ["B"], abilities: [{ kind: "triggered", on: { event: "beginStep", step: "upkeep", whose: "you" }, effects: [{ op: "ringTempts", who: "you" }], text: "At the beginning of your upkeep, the Ring tempts you." }] },
  { name: "Test Walker", cost: "{2}{R}{R}", types: ["planeswalker"], supertypes: ["legendary"], subtypes: ["chandra"], colors: ["R"], loyalty: 3, abilities: [
    { kind: "activated", loyalty: true, sorcery: true, limit: "turn", cost: { loyalty: 1 }, effects: [{ op: "damage", amount: 2, to: "opponent" }], text: "+1: 2 damage to each opponent." },
    { kind: "activated", loyalty: true, sorcery: true, limit: "turn", cost: { loyalty: -3 }, targets: [{ what: { types: ["creature"] } }], effects: [{ op: "damage", amount: 5, to: T(0) }], text: "−3: 5 damage to target creature." }] },
].forEach(add);
DEFS["Bonecrusher Giant"].faces = [DEFS["Bonecrusher Giant"], spell("Stomp", "{1}{R}", "instant", { targets: [{ what: "any" }], effects: [{ op: "damage", amount: 2, to: T(0) }] })];
DEFS["Cyclonic Rift"] = undefined; delete DEFS["Cyclonic Rift"];
add(land("Shock Foundry", null, { subtypes: ["mountain", "plains"], abilities: [{ kind: "static", effect: { type: "entersTapped", affects: "self", unlessPay: { life: 2 } } }] }));
add(cre("Crasher", "{2}{R}{R}{G}", 6, 6, { subtypes: ["dinosaur"], keywords: { trample: true }, abilities: [{ kind: "triggered", on: { event: "dealsCombatDamage", batch: true, who: { controller: "you", keywords: ["trample"] }, to: "player" },
  effects: [{ op: "createToken", who: "you", token: { name: "Dinosaur Beast", types: ["creature"], subtypes: ["dinosaur"], colors: ["G"], power: { event: "amount" }, toughness: { event: "amount" }, keywords: { trample: true } }, amount: 1 }], text: "batch" }] }));
add(cre("Commander Bear", "{1}{G}{G}", 3, 3, { supertypes: ["legendary"], identity: ["G", "R"] }));
add(cre("Commander Dragon", "{2}{R}{R}", 5, 5, { supertypes: ["legendary"], subtypes: ["dragon"], keywords: { flying: true, haste: true } }));

/** Card data objects (one per name, so defs are cached). */
const CARDS = {};
export function card(name) {
  if (!DEFS[name]) throw new Error("no test def " + name);
  return (CARDS[name] ||= { name, mana_cost: DEFS[name].cost || "", type_line: DEFS[name].types.join(" "), oracle_text: "", colors: DEFS[name].colors || [], color_identity: DEFS[name].identity || DEFS[name].colors || [] });
}
export const compile = (c) => DEFS[c.name] || null;

const POOL_60 = {
  RG: ["Mountain", "Forest", "Rootbound Crag", "Llanowar Elves", "Grizzly Bears", "Hill Giant", "Goblin Guide", "Kraul Swarm", "Giant Spider", "Prowess Monk", "Flametongue Kavu",
    "Lightning Bolt", "Shock", "Giant Growth", "Blaze", "Burst Lightning", "Mizzium Mortars", "Fling", "Rampant Growth", "Raging Attacker", "Bonecrusher Giant", "Rancor", "Bonesplitter", "Goblin Bombardment", "Test Walker", "Sol Ring", "Warded Raptor", "Goreclaw", "Weird Op Bear", "Wall of Stone"],
  WB: ["Plains", "Swamp", "Battlefield Forge", "Tapland", "Serra Angel", "White Knight", "Fencing Ace", "Typhoid Rats", "Vampire Nighthawk", "Blood Artist", "Carrier Thrall", "Pitiless Plunderer", "Viscera Seer",
    "Murder", "Swords to Plowshares", "Wrath of God", "Diabolic Edict", "Demonic Tutor", "Reanimate", "Village Rites", "Deadly Dispute", "Glorious Anthem", "Boros Charm", "Karmic Guide", "Fleshbag Marauder",
    "Drivnod, Carnage Dominus", "Nazgul", "Call of the Ring", "Undying Bear", "Indestructible Golem", "Glorious Anthem Lord", "Treasure Maker", "Mystery Spell", "Broken Trigger Bear", "Boros Signet"],
  UX: ["Island", "Counterspell", "Mana Leak", "Think Twice", "Birthday Escape", "Hexproof Bear", "Big Mystery", "Arcane Signet", "Command Tower"],
};

/** Build a deck of `size` cards from a colour pool (deterministic given rng). */
export function buildDeck(key, size, rng, extra = []) {
  const pool = [...POOL_60[key], ...extra];
  const lands = pool.filter((n) => DEFS[n].types.includes("land") && DEFS[n].supertypes?.includes("basic"));
  const others = pool.filter((n) => !lands.includes(n));
  const out = [];
  const nl = Math.round(size * 0.4);
  for (let i = 0; i < nl; i++) out.push(card(lands[i % lands.length]));
  while (out.length < size) out.push(card(others[Math.floor(rng() * others.length)]));
  return out;
}

/** Random legal answer for any request (uses its own rng so it doesn't disturb the game's). */
export function randomAnswer(req, rnd) {
  const pick = (n) => Math.floor(rnd() * n);
  switch (req.kind) {
    case "mulligan": return { keep: req.mulligans >= 1 || rnd() < 0.8 };
    case "priority": {
      const acts = req.actions.map((a, i) => [a, i]).filter(([a]) => a.type !== "special");
      if (!acts.length || rnd() < 0.35) return { type: "pass" };
      const nonMana = acts.filter(([a]) => !a.mana);
      const list = nonMana.length && rnd() < 0.9 ? nonMana : acts;
      return { type: "act", index: list[pick(list.length)][1] };
    }
    case "choose": {
      const n = req.min + pick(req.max - req.min + 1);
      const idx = req.options.map((_, i) => i);
      for (let i = idx.length - 1; i > 0; i--) { const j = pick(i + 1); [idx[i], idx[j]] = [idx[j], idx[i]]; }
      return { chosen: idx.slice(0, n) };
    }
    case "confirm": return { yes: rnd() < 0.5 };
    case "number": return { value: req.min + pick(req.max - req.min + 1) };
    case "attackers": return { attacks: req.candidates.filter(() => rnd() < 0.7).map((c) => ({ obj: c.obj, defender: c.defenders[pick(c.defenders.length)] })) };
    case "blockers": {
      const blocks = [];
      const per = {};
      for (const c of req.candidates) if (rnd() < 0.5) { const a = c.canBlock[pick(c.canBlock.length)]; blocks.push({ obj: c.obj, attacker: a }); per[a] = (per[a] || 0) + 1; }
      return { blocks };
    }
  }
  return {};
}

export function makeRnd(seed) {
  let a = seed >>> 0 || 1;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Drive a game to completion with the random bot. Illegal (e.g. menace) answers are retried with a fallback. */
export function runGame(game, botSeed, maxAnswers = 60000) {
  const rnd = makeRnd(botSeed);
  game.start();
  let n = 0;
  while (!game.over && n < maxAnswers) {
    const req = game.request;
    if (!req) break;
    let a = randomAnswer(req, rnd);
    try { game.respond(a); }
    catch (e) {
      if (game.error) throw game.error;
      a = game.defaultAnswer(req);
      game.respond(a);
    }
    n++;
    game.drainEvents();
  }
  return n;
}

export function hand60Game(seed, keys = ["RG", "WB"], opts = {}) {
  const rnd = makeRnd(seed * 7 + 1);
  return createGame({
    players: [{ name: "Nate", deck: { commanders: [], cards: buildDeck(keys[0], 60, rnd) }, ai: false }, { name: "AI", deck: { commanders: [], cards: buildDeck(keys[1], 60, rnd) }, ai: true }],
    options: { seed, commander: false, ...opts }, compile,
  });
}
export function cmdGame(seed, opts = {}) {
  const rnd = makeRnd(seed * 13 + 5);
  return createGame({
    players: [{ name: "Nate", deck: { commanders: [card("Commander Bear")], cards: buildDeck("RG", 99, rnd, ["Command Tower", "Arcane Signet"]) }, ai: false },
      { name: "AI", deck: { commanders: [card("Commander Dragon")], cards: buildDeck("WB", 99, rnd, ["Counterspell", "Island", "Mana Leak"]) }, ai: true }],
    options: { seed, commander: true, ...opts }, compile,
  });
}

async function cli() {
  const args = process.argv.slice(2);
  const N = +(args[args.indexOf("--games") + 1] || 0) || 100;
  const S = +(args[args.indexOf("--seed") + 1] || 0) || 1;
  const real = args.includes("--real");
  let make = (i) => (i % 2 ? cmdGame(S + i) : hand60Game(S + i));
  if (real) {
    const helpers = await import("./helpers.js");
    const { compileCard } = await import("../overrides.js");
    const decks = helpers.allDecks();
    make = (i) => {
      const a = decks[i % decks.length], b = decks[(i + 1 + Math.floor(i / decks.length)) % decks.length];
      return createGame({ players: [{ name: "Nate", deck: a, ai: false }, { name: "AI", deck: b, ai: true }], options: { seed: S + i, commander: true }, compile: compileCard });
    };
  }
  const t0 = performance.now();
  const res = { done: 0, draws: 0, errors: 0, turns: 0, manual: 0 };
  for (let i = 0; i < N; i++) {
    const g = make(i);
    try { runGame(g, S + i); } catch (e) { res.errors++; console.log("CRASH game", i, e.stack); continue; }
    if (g.error) { res.errors++; console.log("ENGINE ERROR game", i, g.error.stack); }
    if (!g.over) console.log("game", i, "did not finish");
    res.done += g.over ? 1 : 0; res.draws += g.over && g.winner == null ? 1 : 0; res.turns += g.state.turn;
  }
  const ms = performance.now() - t0;
  console.log({ ...res, avgTurns: (res.turns / N).toFixed(1), msPerGame: (ms / N).toFixed(1) });
}
if (typeof process !== "undefined" && process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) cli();
