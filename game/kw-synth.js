// kw-synth.js — abilities synthesised from creature/combat keywords (library batch m2). Pure data, no engine imports
// (engine-chars.js imports this; engine-m2.js holds the ops/hooks these abilities use).
//   kwSynth(kw, {grant})  -> [Ability]   kw = a keyword map ({crew:2, evolve:true, ...}); grant:true also covers keywords that engine-chars
//                                          already synthesises for printed keywords (annihilator, prowess) so they work when granted.
//   GRANTABLE             -> keyword keys that give abilities when granted by a static/effect ("creatures you control have myriad")
const EVT_OBJ = { ref: "event", what: "object" };
const num = (v) => (typeof v === "number" ? v : v == null || isNaN(+v) ? 0 : +v);
const self = { event: "attacks", who: "self" };

export const GRANTABLE = new Set(["evolve", "exalted", "battle cry", "mentor", "myriad", "training", "melee", "dethrone", "afflict", "mobilize", "fabricate", "annihilator", "prowess", "persist", "undying", "riot-trigger"]);

export function kwSynth(kw, opts = {}) {
  const out = [];
  if (!kw) return out;
  const ab = (synthetic, on, effects, extra = {}) => out.push({ kind: "triggered", synthetic, on, effects, ...extra });
  if (kw.crew != null && kw.crew !== false)
    out.push({ kind: "activated", synthetic: "crew", cost: { crew: num(kw.crew) || 1 }, effects: [{ op: "_crew" }], text: `Crew ${num(kw.crew) || 1}` });
  if (kw.evolve)
    ab("evolve", { event: "enters", who: { types: ["creature"], controller: "you", other: true } }, [{ op: "addCounters", what: "self", kind: "+1/+1", amount: 1 }, { op: "_fire", event: "evolves" }], {
      condition: { type: "or", any: [{ type: "compare", a: { powerOf: EVT_OBJ }, op: ">", b: { powerOf: "self" } }, { type: "compare", a: { toughnessOf: EVT_OBJ }, op: ">", b: { toughnessOf: "self" } }] },
      text: "Evolve" });
  if (kw.exalted)
    ab("exalted", { event: "attacks", who: { types: ["creature"], controller: "you" }, alone: true }, [{ op: "pump", what: EVT_OBJ, power: 1, toughness: 1, until: "endOfTurn" }], { text: "Exalted" });
  if (kw["battle cry"])
    ab("battle cry", self, [{ op: "pump", what: { ref: "all", filter: { types: ["creature"], attacking: true, other: true, controller: "you" } }, power: 1, toughness: 0, until: "endOfTurn" }], { text: "Battle cry" });
  if (kw.mentor)
    ab("mentor", self, [{ op: "addCounters", what: { ref: "target", i: 0 }, kind: "+1/+1", amount: 1 }], {
      targets: [{ what: { types: ["creature"], attacking: true, controller: "you", other: true, power: { op: "<", n: { powerOf: "self" } } } }], text: "Mentor" });
  if (kw.myriad)
    ab("myriad", self, [{ op: "_myriad", n: kw.myriad === 2 ? 2 : 1 }], { text: kw.myriad === 2 ? "Myriad, myriad" : "Myriad" });
  if (kw.training)
    ab("training", self, [{ op: "addCounters", what: "self", kind: "+1/+1", amount: 1 }], {
      condition: { type: "count", filter: { types: ["creature"], attacking: true, other: true, power: { op: ">", n: { powerOf: "self" } } }, op: ">=", n: 1 }, text: "Training" });
  if (kw.melee)
    ab("melee", self, [{ op: "pump", what: "self", power: { attackedOpponents: true }, toughness: { attackedOpponents: true }, until: "endOfTurn" }], { text: "Melee" });
  if (kw.dethrone)
    ab("dethrone", self, [{ op: "addCounters", what: "self", kind: "+1/+1", amount: 1 }], { condition: { type: "_dethrone" }, text: "Dethrone" });
  if (kw.afflict != null && kw.afflict !== false)
    ab("afflict", { event: "becomesBlocked", who: "self" }, [{ op: "loseLife", who: { ref: "defendingPlayer" }, amount: num(kw.afflict) || 1 }], { text: `Afflict ${num(kw.afflict) || 1}` });
  if (kw.mobilize != null && kw.mobilize !== false)
    ab("mobilize", self, [{ op: "_mobilize", amount: kw.mobilize === true ? 1 : kw.mobilize }], { text: "Mobilize" });
  if (kw["living weapon"])
    ab("living weapon", { event: "enters", who: "self" }, [{ op: "_livingWeapon" }], { text: "Living weapon" });
  if (kw.fabricate != null && kw.fabricate !== false)
    ab("fabricate", { event: "enters", who: "self" }, [{ op: "_fabricate", n: num(kw.fabricate) || 1 }], { text: `Fabricate ${num(kw.fabricate) || 1}` });
  if (kw.squad)
    ab("squad", { event: "enters", who: "self" }, [{ op: "_squad" }], { text: "Squad" });
  if (kw.partnerWith)
    ab("partnerWith", { event: "enters", who: "self" }, [{ op: "_partnerWith", name: kw.partnerWith }], { text: `Partner with ${kw.partnerWith}` });
  if (kw.ravenous) {
    out.push({ kind: "static", synthetic: "ravenous", effect: { type: "entersWithCounters", kind: "+1/+1", amount: "x" }, text: "Ravenous" });
    ab("ravenous", { event: "enters", who: "self" }, [{ op: "draw", who: "you", amount: 1 }], { condition: { type: "compare", a: { sourceX: true }, op: ">=", b: 5 }, text: "Ravenous" });
  }
  if (kw.undaunted)
    out.push({ kind: "static", synthetic: "undaunted", effect: { type: "selfCostMod", per: { numOpponents: true }, amount: -1 }, text: "Undaunted" });
  if (kw.station)
    out.push({ kind: "activated", synthetic: "station", sorcery: true, cost: { tapOther: { types: ["creature"], controller: "you", other: true }, tapOtherCount: 1 },
      effects: [{ op: "addCounters", what: "self", kind: "charge", amount: { tappedPower: true } }], text: "Station" });
  if (opts.grant) {
    if (kw.annihilator) ab("annihilator", self, [{ op: "sacrifice", who: { ref: "event", what: "player" }, filter: { types: ["permanent"] }, amount: num(kw.annihilator) || 1 }], { text: `Annihilator ${kw.annihilator}` });
    if (kw.prowess) ab("prowess", { event: "cast", who: "you", filter: { notTypes: ["creature"] } }, [{ op: "pump", what: "self", power: 1, toughness: 1, until: "endOfTurn" }], { text: "Prowess" });
    if (kw.undying) ab("undying", { event: "dies", who: "self" }, [{ op: "_returnWithCounter", kind: "+1/+1", unless: "+1/+1" }], { text: "Undying" });
    if (kw.persist) ab("persist", { event: "dies", who: "self" }, [{ op: "_returnWithCounter", kind: "-1/-1", unless: "-1/-1" }], { text: "Persist" });
  }
  return out;
}
