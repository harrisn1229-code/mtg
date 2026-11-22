// parser-m3.js — oracle-text patterns for library batch m3 (energy, investigate, manifest/cloak, discover, city's blessing, ...).
// Hooks (one line each): parser-effects.js playerRules / parseCond / parseCost, parser.js parseWhenText. Everything throws nothing: returns null when it doesn't apply.
import { fail, num, NUM_RE, parseFilter } from "./parser-filters.js";
import { amt, expr } from "./parser-effects.js";

const E = "\\{E\\}";

/** Effect clauses with a player subject (`who` already resolved; `c` is the clause after the subject, verb normalised). */
export function m3Player(who, c, ctx) {
  let m;
  // energy: "you get {E}{E}", "you get an amount of {E} equal to ...", "you get six {E}", "you get that many {E}"
  if ((m = c.match(new RegExp(`^gets? ((?:${E})+)$`, "i")))) return [{ op: "energy", who, amount: m[1].length / 3 }];
  if ((m = c.match(new RegExp(`^gets? an amount of ${E} equal to (.+)$`, "i")))) { const e = expr(m[1], ctx); ctx.hasPrev = true; return [{ op: "energy", who, amount: e }]; }
  if ((m = c.match(new RegExp(`^gets? (${NUM_RE}) ${E}$`, "i")))) return [{ op: "energy", who, amount: amt(m[1], ctx) }];
  if ((m = c.match(new RegExp(`^gets? that many ${E}$`, "i")))) { if (!(ctx.trig && ctx.trig.amount)) fail("that many"); return [{ op: "energy", who, amount: { event: "amount" } }]; }
  // investigate (the subject, if any, is the player who investigates)
  if ((m = c.match(/^investigate(?: (once|twice|(\w+) times|that many times))?$/i))) {
    let n = 1;
    if (m[1]) {
      if (/^once$/i.test(m[1])) n = 1; else if (/^twice$/i.test(m[1])) n = 2;
      else if (/^that many/i.test(m[1])) { if (!(ctx.trig && ctx.trig.amount)) fail("investigate that many"); n = { event: "amount" }; }
      else n = amt(m[2], ctx);
    }
    const e = { op: "investigate", amount: n };
    if (who !== "you") e.who = who;
    return [e];
  }
  // manifest / cloak
  if ((m = c.match(/^(manifest|cloak)s? the top card of (your|their|that player's|its controller's) library$/i))) {
    const e = { op: "manifest", who, amount: 1 };
    if (/^cloak/i.test(m[1])) e.cloak = true;
    return [e];
  }
  // discover
  if ((m = c.match(/^discover (\d+|x)$/i))) return [{ op: "discover", amount: amt(m[1], ctx) }];
  return null;
}

/** Conditions. */
export function m3Cond(t) {
  let m;
  if (/^you have the city's blessing$/i.test(t)) return { type: "blessing" };
  if (/^you descended this turn$/i.test(t)) return { type: "descended" };
  if ((m = t.match(/^you(?:'ve| have) (?:paid or lost|lost or paid) (\w+) or more \{E\} this turn$/i))) return { type: "compare", a: { energyPaidThisTurn: true }, op: ">=", b: num(m[1]) };
  return null;
}

/** Costs: "Pay {E}{E}", "Pay X {E}", "Pay six {E}". Returns true when handled. */
export function m3CostPart(p, cost) {
  let m;
  if ((m = p.match(new RegExp(`^pay ((?:${E})+)$`, "i")))) { cost.energy = (cost.energy | 0) + m[1].length / 3; return true; }
  if ((m = p.match(new RegExp(`^pay (${NUM_RE}) ${E}$`, "i")))) { const n = num(m[1]); if (n === "x") { cost.energy = "x"; cost.x = true; } else cost.energy = (cost.energy | 0) + n; return true; }
  return false;
}

/** Trigger conditions ("whenever ..."). Returns {triggers, info} (see parseWhenText) or null. */
export function m3When(t) {
  let m;
  const one = (trig, info) => ({ triggers: [trig], info: { subject: "player", ...info } });
  if (new RegExp(`^you get one or more ${E}( during your turn)?$`, "i").test(t)) return one({ event: "getEnergy", who: "you", ...(/during your turn/i.test(t) ? { yourTurn: true } : {}) }, { amount: false });
  if (/^you investigate$/i.test(t)) return one({ event: "investigate", who: "you" }, {});
  if (/^you investigate for the first time each turn$/i.test(t)) return one({ event: "investigate", who: "you", nth: 1 }, {});
  if (/^you surveil$/i.test(t)) return one({ event: "surveil", who: "you" }, {});
  if (/^you surveil for the first time each turn$/i.test(t)) return one({ event: "surveil", who: "you", nth: 1 }, {});
  if ((m = t.match(/^you draw your (second|third) card each turn$/i))) return one({ event: "draw", who: "you", nth: /second/i.test(m[1]) ? 2 : 3 }, {});
  if (/^you commit a crime$/i.test(t)) return one({ event: "crime", who: "you" }, {});
  if (/^an opponent commits a crime$/i.test(t)) return one({ event: "crime", who: "opponent" }, {});
  if (/^players finish voting$/i.test(t)) return one({ event: "votesFinished", who: "each" }, {});
  // explores
  if ((m = t.match(/^a creature you control explores(?: an? (land|nonland) card)?$/i))) {
    const tr = { event: "explores", who: { types: ["creature"], controller: "you" } };
    if (m[1]) tr.land = /^land$/i.test(m[1]);
    return { triggers: [tr], info: { subject: "object" } };
  }
  // turned face up
  if ((m = t.match(/^(?:this (?:creature|enchantment|artifact|permanent)) or another (creature|permanent) you control is turned face up$/i)))
    return { triggers: [{ event: "turnedFaceUp", who: m[1] === "creature" ? { types: ["creature"], controller: "you" } : { controller: "you" } }], info: { subject: "object" } };
  if (/^a permanent you control is turned face up$/i.test(t)) return { triggers: [{ event: "turnedFaceUp", who: { controller: "you" } }], info: { subject: "object" } };
  // attacks (batch)
  if ((m = t.match(new RegExp(`^you attack with (${NUM_RE}) or more (.+)$`, "i")))) {
    let f;
    try { f = parseFilter(m[2].replace(/s$/, "")); } catch { return null; }
    delete f.controller;
    return { triggers: [{ event: "attackBatch", who: "you", filter: f, n: num(m[1]) }], info: { subject: "player" } };
  }
  if ((m = t.match(/^you attack with one or more (.+)$/i))) {
    let f;
    try { f = parseFilter(m[1].replace(/s$/, "")); } catch { return null; }
    delete f.controller;
    return { triggers: [{ event: "attackBatch", who: "you", filter: f, n: 1 }], info: { subject: "player" } };
  }
  if (/^you attack a player$/i.test(t)) return { triggers: [{ event: "attackBatch", who: "you", n: 1, atPlayer: true }], info: { subject: "player" } };
  if ((m = t.match(/^one or more (.+?) you control attack$/i))) {
    let f;
    try { f = parseFilter(m[1].replace(/s$/, "")); } catch { return null; }
    delete f.controller;
    return { triggers: [{ event: "attackBatch", who: "you", filter: f, n: 1 }], info: { subject: "player" } };
  }
  return null;
}
