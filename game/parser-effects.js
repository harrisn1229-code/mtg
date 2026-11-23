// parser-effects.js — effect-clause grammar, amounts, costs, conditions, tokens, mana.
// Everything here throws `Fail` when it cannot map text to the IR with confidence.

import { Fail, fail, num, NUM_RE, COLORS, parseFilter, parseTargetPhrase, parseKeywordList, KEYWORD_SET, subtypeOf, manaSymbols } from "./parser-filters.js";

// ---------------------------------------------------------------------------------------------
// context

export function createCtx(o = {}) {
  return {
    targets: [], last: o.last ?? null, player: o.player ?? null, trig: o.trig ?? null,
    xAmount: null, mult: null, multUsed: false, hasPrev: false, carryWho: null, lastTarget: -1,
    parseAbility: o.parseAbility ?? null, allowManual: o.allowManual ?? true, partial: false, selfFromGraveyard: false,
    sacrificed: !!o.sacrificed, kicker: !!o.kicker, isSpell: !!o.isSpell, flags: {},
  };
}
const snap = (c) => ({ t: c.targets.length, last: c.last, player: c.player, x: c.xAmount, mult: c.mult, mu: c.multUsed, hp: c.hasPrev, cw: c.carryWho, lt: c.lastTarget, sg: c.selfFromGraveyard });
const restore = (c, s) => { c.targets.length = s.t; c.last = s.last; c.player = s.player; c.xAmount = s.x; c.mult = s.mult; c.multUsed = s.mu; c.hasPrev = s.hp; c.carryWho = s.cw; c.lastTarget = s.lt; c.selfFromGraveyard = s.sg; };
export function attempt(ctx, fn) {
  const s = snap(ctx);
  try { return fn(); } catch (e) { restore(ctx, s); throw e; }
}

// ---------------------------------------------------------------------------------------------
// string utils

export function maskQuotes(s) {
  const quotes = [];
  const masked = s.replace(/"[^"]*"/g, (q) => { quotes.push(q); return `\u0001${quotes.length - 1}\u0001`; });
  return { masked, unmask: (t) => t.replace(/\u0001(\d+)\u0001/g, (m, i) => quotes[+i]) };
}
export function splitTop(s, re) {
  const { masked, unmask } = maskQuotes(s);
  return masked.split(re).map((p) => unmask(p));
}
export function splitSentences(s) {
  const { masked, unmask } = maskQuotes(s);
  return masked.split(/(?<=\.)\s+(?=\S)/).map((p) => unmask(p).trim()).filter(Boolean);
}
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);

// ---------------------------------------------------------------------------------------------
// refs

const EVT_OBJ = { ref: "event", what: "object" };
const EVT_PLAYER = { ref: "event", what: "player" };

export function addTarget(text, ctx) {
  const { spec } = parseTargetPhrase(text);
  ctx.targets.push(spec);
  ctx.lastTarget = ctx.targets.length - 1;
  const r = { ref: "target", i: ctx.lastTarget };
  ctx.last = r;
  if (spec.what === "player" || spec.what === "opponent") ctx.player = r;
  return r;
}
export function targetSpecOf(ref, ctx) { return ref && ref.ref === "target" ? ctx.targets[ref.i] : null; }

const PRONOUN_OBJ = /^(?:it|him|her|them|that (?:creature|permanent|card|land|artifact|token|planeswalker|enchantment|spell)|they|those (?:creatures|permanents|cards|lands|artifacts|tokens)|the (?:creature|permanent)|each of them)$/i;

export function playerRef(text, ctx) {
  const t = text.trim().replace(/’/g, "'");
  let m;
  if (/^you$/i.test(t)) return "you";
  if (/^(?:each opponent|each of your opponents|your opponents|each other player|defending player|an opponent|the defending player)$/i.test(t)) return "opponent";
  if (/^each player$/i.test(t)) return "eachPlayer";
  if (/^(?:that player|the player|they|he or she)$/i.test(t)) {
    if (ctx.player) return ctx.player;
    if (/^they$/i.test(t)) return null;
    fail("that player without antecedent");
  }
  if (/^that spell's controller$/i.test(t) && ctx.trig && ctx.trig.spellCtrl) return { ref: "controllerOf", of: { ref: "event", what: "source" } };
  if ((m = t.match(/^(?:its|that (?:creature|permanent|spell|card|land|artifact|token)'s|the (?:creature|permanent)'s) (controller|owner)$/i))) {
    if (!ctx.last) fail("controller of nothing");
    return { ref: m[1].toLowerCase() === "controller" ? "controllerOf" : "ownerOf", of: ctx.last };
  }
  if (/^target (?:player|opponent)$/i.test(t) || /^up to one target (?:player|opponent)$/i.test(t)) return addTarget(t, ctx);
  return null;
}

/** parse an object phrase to a Ref. o.bare: allow bare plural noun phrase as "all"; o.choose: "a/an X" => choose ref */
export function objRef(text, ctx, o = {}) {
  const t = text.trim().replace(/’/g, "'").replace(/[.]$/, "");
  let m;
  if (t === "~") { return (ctx.last = "self"); }
  if (PRONOUN_OBJ.test(t)) {
    if (!ctx.last) fail("pronoun without antecedent: " + t);
    return ctx.last;
  }
  if (/^enchanted (?:creature|permanent|land|artifact)$/i.test(t)) return (ctx.last = "enchanted");
  if (/^equipped creature$/i.test(t)) return (ctx.last = "equipped");
  if (/^(?:up to (?:\w+) )?target /i.test(t) || /^(?:another|\w+) target /i.test(t) || /^any target$/i.test(t)) return addTarget(t, ctx);
  if ((m = t.match(/^(?:each|all|every) (.+)$/i))) {
    const f = parseFilter(m[1]);
    if (f._spell) fail("spell filter");
    ctx.last = { ref: "it" };
    return { ref: "all", filter: f };
  }
  if ((m = t.match(new RegExp(`^up to (${NUM_RE}) (.+)$`, "i")))) {
    if (!o.choose) fail("choose phrase not allowed here");
    const f = parseFilter(m[2]);
    ctx.last = { ref: "it" };
    return { ref: "choose", filter: f, min: 0, max: num(m[1]) };
  }
  if (o.choose && (m = t.match(new RegExp(`^(${NUM_RE}) (.+)$`, "i")))) {
    const n = num(m[1]);
    const f = parseFilter(m[2]);
    ctx.last = { ref: "it" };
    return { ref: "choose", filter: f, min: n, max: n };
  }
  if (o.bare) {
    const f = parseFilter(t);
    if (f._spell) fail("spell filter");
    ctx.last = { ref: "it" };
    return { ref: "all", filter: f };
  }
  fail("object phrase: " + text);
}

/** player or object ref */
export function anyRef(text, ctx, o = {}) {
  const p = playerRef(text, ctx);
  if (p) return p;
  return objRef(text, ctx, o);
}

// ---------------------------------------------------------------------------------------------
// amounts

function thatMuch(ctx) {
  if (ctx.hasPrev) return { prev: true };
  if (ctx.trig && ctx.trig.amount) return { event: "amount" };
  fail("that much without antecedent");
}

function possessiveRef(w, ctx) {
  w = w.toLowerCase().replace(/’/g, "'");
  if (w === "~'s" || w === "~") return "self";
  if (w === "its" || /^that (?:creature|permanent|card|artifact|token|spell)'s$/.test(w) || w === "his" || w === "her") {
    if (!ctx.last) fail("possessive without antecedent");
    return ctx.last;
  }
  if (/^(?:enchanted|equipped) creature's$/.test(w)) return w.startsWith("e") && w[1] === "n" ? "enchanted" : "equipped";
  return null;
}

export function countOf(text, ctx) {
  const t = text.trim().replace(/’/g, "'").replace(/[.]$/, "");
  let m;
  if (/^opponents?(?: you have)?$/i.test(t)) return { numOpponents: true };
  if (/^(?:other )?players?$/i.test(t)) fail("players count");
  if ((m = t.match(/^(?:\+1\/\+1|[a-z]+) counters? on (.+)$/i))) {
    const kind = t.match(/^(\+1\/\+1|-1\/-1|[a-z]+) counters?/i)[1].toLowerCase();
    const r = m[1] === "~" ? "self" : possessiveRef(m[1].replace(/^(it)$/i, "its"), ctx) || fail("counters on");
    return { countersOn: r, kind };
  }
  if (/^cards? in (?:your|their|that player's|target player's|target opponent's|each opponent's) hands?$/i.test(t)) {
    const w = t.match(/in (.+?) hands?$/i)[1].toLowerCase();
    if (w === "your") return { handSize: "you" };
    if (w === "their" || w === "that player's") return { handSize: ctx.player || fail("their hand") };
    if (/^target (?:opponent|player)'s$/.test(w)) return { handSize: addTarget(w.replace(/'s$/, ""), ctx) };
    fail("hand of " + w);
  }
  const f = parseFilter(t);
  if (f._spell) fail("spell count");
  return { count: f };
}

/** "equal to"/"where X is" expression */
export function expr(text, ctx) {
  const t = text.trim().replace(/’/g, "'").replace(/[.]$/, "");
  let m;
  if ((m = t.match(/^the number of (.+)$/i))) return countOf(m[1], ctx);
  if ((m = t.match(/^(?:the )?(?:total )?(power|toughness|mana value)(?: and toughness)? of (.+)$/i)) && /^(?:power|toughness|mana value)$/i.test(m[1]) && !/^total/i.test(t) && !/^(?:target|that|this|the sacrificed)/i.test(m[2]) === false) {
    /* "the power of target creature" is rare; fall through */
  }
  if ((m = t.match(/^(its|~'s|that (?:creature|permanent|card|artifact|token|spell)'s|the sacrificed (?:creature|permanent|artifact|land)'s|(?:enchanted|equipped) creature's|this creature's) (power|toughness|mana value)$/i))) {
    const kind = m[2].toLowerCase();
    if (/^the sacrificed/i.test(m[1])) { ctx.flags.usesSacrificed = true; return { sacrificed: kind === "mana value" ? "cmc" : kind }; }
    const r = possessiveRef(m[1], ctx) || fail("possessive");
    return kind === "power" ? { powerOf: r } : kind === "toughness" ? { toughnessOf: r } : { cmcOf: r };
  }
  if ((m = t.match(/^(?:the )?(greatest|total) (power|toughness|mana value) (?:among|of) (.+)$/i))) {
    const f = parseFilter(m[3]);
    const k = m[2].toLowerCase() === "mana value" ? "cmc" : m[2].toLowerCase();
    return m[1].toLowerCase() === "greatest" ? { greatest: k, of: f } : { sum: k, of: f };
  }
  if ((m = t.match(/^your devotion to (white|blue|black|red|green)$/i))) return { devotion: [COLORS[m[1].toLowerCase()]] };
  if (/^(?:the )?(?:life lost this way|damage dealt this way|the amount of life lost this way)$/i.test(t)) return { prev: true };
  if (/^(?:that much|the amount of damage dealt)$/i.test(t)) return thatMuch(ctx);
  if (/^the amount of damage (?:those|that) creatures? dealt to that player$/i.test(t)) { if (ctx.trig && ctx.trig.amount) return { event: "amount" }; fail("amount"); }
  if (/^your life total$/i.test(t)) return { lifeOf: "you" };
  if ((m = t.match(/^(\d+)$/))) return +m[1];
  fail("expression: " + text);
}

export function amt(text, ctx) {
  const t = text.trim().toLowerCase().replace(/[.]$/, "");
  const n = num(t);
  if (n === "x") return ctx.xAmount ?? "x";
  if (n != null) return n;
  if (t === "that much" || t === "that many") return thatMuch(ctx);
  fail("amount: " + text);
}
function mulAmt(n, ctx) {
  if (ctx.mult) {
    ctx.multUsed = true;
    return n === 1 ? ctx.mult : { mul: [n, ctx.mult] };
  }
  return n;
}
function signedAmt(sign, tok, ctx) {
  const t = tok.toLowerCase();
  let a;
  if (t === "x") a = ctx.xAmount ?? "x";
  else a = +t;
  if (sign === "-") return typeof a === "number" ? (a === 0 ? 0 : -a) : { mul: [-1, a] };
  return a;
}

// ---------------------------------------------------------------------------------------------
// costs

export function splitCostParts(text) {
  return splitTop(text, /,\s+/).map((s) => s.trim()).filter(Boolean);
}

export function parseCost(text) {
  const cost = {};
  const parts = splitCostParts(text.trim().replace(/[.]$/, ""));
  if (!parts.length) fail("empty cost");
  for (const p of parts) {
    let m;
    if (/^(?:\{E\})+$/.test(p)) cost.energy = (cost.energy || 0) + p.length / 3; // energy counters
    else if (/^(?:\{[^}]+\})+$/.test(p) && p !== "{T}" && p !== "{Q}") {
      cost.mana = (cost.mana || "") + p;
      if (/\{X\}/i.test(p)) cost.x = true;
    } else if (p === "{T}") cost.tap = true;
    else if (p === "{Q}") cost.untap = true;
    else if (/^\{T\}(?:\{[^}]+\})+$/.test(p) || /^(?:\{[^}]+\})+\{T\}$/.test(p)) fail("glued cost");
    else if ((m = p.match(/^sacrifice (.+)$/i))) {
      const w = m[1].trim();
      if (/^(?:~|this (?:creature|artifact|enchantment|land|permanent|token|aura|equipment|vehicle))$/i.test(w)) cost.sacSelf = true;
      else {
        const mm = w.match(new RegExp(`^(${NUM_RE}) (.+)$`, "i"));
        let n = 1, noun = w;
        if (mm && num(mm[1]) !== 1 && !/^an?$/i.test(mm[1])) { n = num(mm[1]); noun = mm[2]; }
        else if (mm) noun = mm[2];
        const f = parseFilter(noun);
        if (f._spell) fail("sac spell");
        if (f.controller === "you") delete f.controller;
        cost.sac = f;
        if (n !== 1) cost.sacCount = n;
      }
    } else if ((m = p.match(/^discard (.+)$/i))) {
      const w = m[1].trim();
      if (/^(?:~|this card)$/i.test(w)) cost.discardSelf = true;
      else if (/^(?:a|one) card$/i.test(w)) cost.discard = 1;
      else if ((m = w.match(new RegExp(`^(${NUM_RE}) cards?$`, "i")))) cost.discard = num(m[1]);
      else if ((m = w.match(/^an? (.+) card$/i))) cost.discard = parseFilter(m[1] + " card");
      else fail("discard cost");
    } else if ((m = p.match(/^pay (\d+|x) life$/i))) cost.life = num(m[1]);
    else if ((m = p.match(/^pay ((?:\{E\})+)$/i))) cost.energy = (cost.energy || 0) + m[1].length / 3;
    else if ((m = p.match(/^pay ((?:\{[^}]+\})+)$/i))) cost.mana = (cost.mana || "") + m[1];
    else if ((m = p.match(/^exile (.+?) from your graveyard$/i))) {
      const w = m[1].trim();
      if (/^(?:~|this card)$/i.test(w)) cost.exileSelf = true;
      else {
        const mm = w.match(new RegExp(`^(${NUM_RE}) (?:other )?(.+?)s?$`, "i"));
        if (!mm) fail("exile cost");
        cost.exileFromGraveyard = num(mm[1]);
        const nf = mm[2].replace(/\bcards?$/i, "card");
        if (!/^cards?$/i.test(nf)) cost.exileFilter = parseFilter(nf.replace(/ card$/, " card"), { zone: "graveyard" });
      }
    } else if ((m = p.match(/^remove (a|an|\w+|x) ([^ ]+) counters? from (?:~|this \w+)$/i))) cost.removeCounters = { kind: m[2].toLowerCase(), n: num(m[1]) ?? fail("rc") };
    else if ((m = p.match(new RegExp(`^tap (${NUM_RE}|an|a) untapped (.+?)(?: you control)?$`, "i")))) {
      cost.tapOther = parseFilter(m[2].replace(/s$/, "") + " you control");
      const n = num(m[1]);
      if (n !== 1) cost.tapOtherCount = n;
    } else fail("cost part: " + p);
  }
  return cost;
}

// ---------------------------------------------------------------------------------------------
// conditions

export function parseCond(text, ctx = {}) {
  const t = text.trim().replace(/’/g, "'").replace(/[.]$/, "");
  let m;
  if (/^you do$/i.test(t)) return { type: "did" };
  if (/^(?:you don't|the player doesn't|that player doesn't|they don't)$/i.test(t)) return { type: "not", c: { type: "did" } };
  if (/^it's your turn$/i.test(t) || /^it is your turn$/i.test(t)) return { type: "yourTurn" };
  if (/^it's not your turn$/i.test(t)) return { type: "not", c: { type: "yourTurn" } };
  if (/^(?:~|this spell|it) was kicked$/i.test(t)) return { type: "kicked" };
  if ((m = t.match(/^you control a commander$/i))) return { type: "control", filter: { isCommander: true, controller: "you" }, op: ">=", n: 1 };
  if ((m = t.match(/^you control no (.+)$/i)) || (m = t.match(/^you don't control (?:an? |any )?(.+)$/i))) return { type: "control", filter: parseFilter(m[1].replace(/\byou control\b/, "") + " you control"), op: "==", n: 0 };
  if ((m = t.match(new RegExp(`^you control (${NUM_RE}) or (more|fewer) (.+)$`, "i")))) {
    return { type: "control", filter: parseFilter(m[3] + (/\byou control\b/.test(m[3]) ? "" : " you control")), op: m[2].toLowerCase() === "more" ? ">=" : "<=", n: num(m[1]) };
  }
  if ((m = t.match(new RegExp(`^you control (${NUM_RE}) or (more|fewer) other (.+)$`, "i")))) {
    return { type: "control", filter: parseFilter("other " + m[3] + " you control"), op: m[2].toLowerCase() === "more" ? ">=" : "<=", n: num(m[1]) };
  }
  if ((m = t.match(/^you control (?:an? |one or more )?(.+)$/i))) {
    return { type: "control", filter: parseFilter(m[1].replace(/\byou control\b/, "") + " you control"), op: ">=", n: 1 };
  }
  if ((m = t.match(new RegExp(`^you control (${NUM_RE}) or fewer other (.+)$`, "i")))) return { type: "control", filter: parseFilter("other " + m[2] + " you control"), op: "<=", n: num(m[1]) };
  if ((m = t.match(/^no (.+?) are on the battlefield$/i))) return { type: "count", filter: parseFilter(m[1]), op: "==", n: 0 }; // any controller
  if ((m = t.match(/^there are (\w+) or more (.+?) counters on (?:~|this \w+)$/i))) return { type: "counters", what: "self", kind: m[2].toLowerCase(), op: ">=", n: num(m[1]) };
  if ((m = t.match(/^(an opponent|you) ha(?:s|ve) (\w+) or (less|more|fewer|greater) life$/i))) return { type: "life", who: /^you$/i.test(m[1]) ? "you" : "opponent", op: /more|greater/i.test(m[3]) ? ">=" : "<=", n: num(m[2]) };
  if ((m = t.match(/^you have (\w+) or more opponents$/i))) return { type: "opponents", op: ">=", n: num(m[1]) };
  if ((m = t.match(/^you have (\w+) or (more|fewer) cards in hand$/i))) return { type: "handSize", who: "you", op: m[2].toLowerCase() === "more" ? ">=" : "<=", n: num(m[1]) };
  if ((m = t.match(/^(?:that creature|it|that permanent|that card) (?:is|was) (?:an? )?(.+)$/i)) || (m = t.match(/^it's (?:an? )?(.+)$/i))) {
    if (!ctx.last) fail("matches without antecedent");
    const f = parseFilter(m[1]);
    return { type: "matches", what: ctx.last, filter: f };
  }
  if ((m = t.match(/^the sacrificed (?:creature|permanent|artifact) was (?:an? )?(.+)$/i))) { if (ctx.flags) ctx.flags.usesSacrificed = true; return { type: "sacrificed", filter: parseFilter(m[1]) }; }
  if ((m = t.match(/^you reveal an? (.+?) card from your hand$/i))) return { type: "hasInHand", filter: parseFilter(m[1] + " card") };
  if ((m = t.match(/^this is the (first|second|third|fourth|fifth) time this ability has resolved this turn$/i))) return { type: "resolvedCount", op: "==", n: { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 }[m[1].toLowerCase()] };
  if (/^it isn't a mana ability$/i.test(t)) return { type: "event", key: "isMana", value: false };
  if ((m = t.match(new RegExp(`^at least (${NUM_RE}) mana was spent to cast (?:it|that spell)$`, "i")))) return { type: "compare", a: { event: "manaSpent" }, op: ">=", b: num(m[1]) };
  fail("condition: " + text);
}

// ---------------------------------------------------------------------------------------------
// mana

export function parseManaBody(body, ctx) {
  const t = body.trim().replace(/[.]$/, "").replace(/^an additional /i, "").replace(/^additional /i, "");
  let m;
  if ((m = t.match(/^one mana of any color that a land (an opponent|you) controls? could produce$/i))) return { landColors: /opponent/i.test(m[1]) ? "opponent" : "you", n: 1 };
  if (/^one mana of the chosen color$/i.test(t)) return { chosenColor: true, n: 1 };
  if ((m = t.match(/^\{([WUBRG])\} or one mana of the chosen color$/i))) return { anyOf: [m[1]], chosenColor: true, n: 1 };
  if ((m = t.match(/^\{([WUBRG])\}\{([WUBRG])\}, \{([WUBRG])\}\{([WUBRG])\},? or \{([WUBRG])\}\{([WUBRG])\}$/))) { // filter lands: every pair of two colours = two units of either colour
    const cols = [...new Set(m.slice(1, 7))];
    const pairs = new Set([m[1] + m[2], m[3] + m[4], m[5] + m[6]].map((x) => x.split("").sort().join("")));
    if (cols.length === 2 && pairs.size === 3) return { anyOf: cols, n: 2, split: true };
  }
  if (/^(?:\{[WUBRGC]\})+$/.test(t)) return t;
  if ((m = t.match(/^((?:\{[WUBRG]\})(?: or \{[WUBRG]\})+)$/))) return { anyOf: [...m[1].matchAll(/\{([WUBRG])\}/g)].map((x) => x[1]), n: 1 };
  if ((m = t.match(/^((?:\{[WUBRG]\}, )+\{[WUBRG]\},? or \{[WUBRG]\})$/))) return { anyOf: [...m[1].matchAll(/\{([WUBRG])\}/g)].map((x) => x[1]), n: 1 };
  if ((m = t.match(new RegExp(`^(${NUM_RE}) mana of any (?:one )?color$`, "i")))) { const n = num(m[1]); if (n === "x") fail("x any"); return { any: n }; }
  if ((m = t.match(new RegExp(`^(${NUM_RE}) mana of any (?:one )?color in your commander's color identity$`, "i")))) return { identity: num(m[1]) };
  if ((m = t.match(/^an amount of \{([WUBRGC])\} equal to (.+)$/i))) return { color: m[1], n: expr(m[2], ctx) };
  if ((m = t.match(/^\{([WUBRGC])\} for each (.+)$/))) return { color: m[1], n: countOf(m[2], ctx) };
  fail("mana: " + body);
}

// ---------------------------------------------------------------------------------------------
// tokens

const PREDEF = { treasure: "treasure", food: "food", clue: "clue", blood: "blood", map: "map" };
const TOKEN_TYPES = new Set(["creature", "artifact", "enchantment", "land"]);

function parseTokenKeywordsAndAbilities(restText, ctx, tok) {
  // restText: ' with deathtouch', ' with flying and haste', ' with "...."', ' with trample'
  let r = restText.trim();
  if (!r) return;
  const m = r.match(/^with (.+)$/i);
  if (!m) fail("token rest: " + r);
  r = m[1];
  const { masked, unmask } = maskQuotes(r);
  const parts = masked.split(/\s+and\s+(?=\u0001|\w)/i);
  for (let p of parts) {
    p = p.trim();
    if (/^\u0001\d+\u0001$/.test(p)) {
      const q = unmask(p).slice(1, -1);
      if (!ctx.parseAbility) fail("no ability parser");
      (tok.abilities ||= []).push(...ctx.parseAbility(q));
    } else {
      for (const k of parseKeywordList(unmask(p))) { if (typeof k === "object") Object.assign((tok.keywords ||= {}), k); else (tok.keywords ||= {})[k] = true; }
    }
  }
}

/** returns an Effect[] for "create ..." (text after "create ") */
export function parseCreate(text, ctx, who) {
  let t = text.trim().replace(/[.]$/, "");
  let m;
  // copy
  if ((m = t.match(new RegExp(`^(${NUM_RE}) (tapped )?tokens? that's a copy of (.+)$`, "i")))) {
    const n = amt(m[1], ctx);
    const src = objRef(m[3], ctx);
    const e = { op: "createToken", who, amount: mulAmt(n, ctx), copyOf: src };
    if (m[2]) e.tapped = true;
    return [e];
  }
  // several tokens joined by "and"
  const parts = splitTop(t, /\s+and\s+(?=(?:an?|one|two|three|four|five|six|seven|eight|nine|ten|x|\d+)\s+(?:tapped\s+)?(?:\d+|x)\/)/i);
  const out = [];
  for (const p of parts) out.push(parseOneToken(p, ctx, who));
  return out;
}
function parseOneToken(p, ctx, who) {
  let m;
  p = p.trim();
  const { masked, unmask } = maskQuotes(p);
  let q = masked;
  let amountExpr = null;
  if ((m = q.match(/^(.*?)\s+equal to (.+)$/i))) { q = m[1]; amountExpr = expr(unmask(m[2]), ctx); }
  // predefined
  if ((m = q.match(new RegExp(`^(${NUM_RE}) (tapped )?(treasure|food|clue|blood|map) tokens?$`, "i")))) {
    const n = amt(m[1], ctx);
    const e = { op: "createToken", who, token: PREDEF[m[3].toLowerCase()], amount: mulAmt(n, ctx) };
    if (m[2]) e.tapped = true;
    return e;
  }
  m = q.match(/^(a number of|\w+) (tapped )?(?:(\w+)\/(\w+) )?(.+?) tokens?(?: named ([A-Z][\w' -]*?))?(?: (with .+))?$/i);
  if (!m) fail("token: " + p);
  let n;
  if (/^a number of$/i.test(m[1])) { if (!amountExpr) fail("a number of w/o expr"); n = amountExpr; }
  else n = amt(m[1], ctx);
  if (!m[3] && !(m[5])) fail("token without P/T");
  const noPT = !m[3];
  const pw = noPT ? undefined : /^x$/i.test(m[3]) ? ctx.xAmount ?? "x" : /^\d+$/.test(m[3]) ? +m[3] : fail("token power");
  const tg = noPT ? undefined : /^x$/i.test(m[4]) ? ctx.xAmount ?? "x" : /^\d+$/.test(m[4]) ? +m[4] : fail("token toughness");
  const words = m[5].split(/\s+/).filter(Boolean);
  const colors = [], types = [], subtypes = [], nameParts = [];
  let colorless = false;
  for (const w of words) {
    const lw = w.toLowerCase();
    if (lw === "and") continue;
    if (COLORS[lw]) colors.push(COLORS[lw]);
    else if (lw === "colorless") colorless = true;
    else if (TOKEN_TYPES.has(lw)) types.push(lw);
    else if (/^[A-Z]/.test(w) || subtypeOf(lw)) { subtypes.push(subtypeOf(lw) || lw); nameParts.push(w); }
    else fail("token word " + w);
  }
  if (!types.includes("creature") && !types.length) fail("token types");
  if (noPT && types.includes("creature")) fail("creature token without P/T: " + p);
  const tok = { name: m[6] ? m[6].trim() : nameParts.join(" "), types, subtypes, colors };
  if (!noPT) { tok.power = pw; tok.toughness = tg; }
  if (!tok.name) fail("token name");
  if (m[7]) parseTokenKeywordsAndAbilities(unmask(m[7]), ctx, tok);
  const e = { op: "createToken", who, token: tok, amount: mulAmt(n, ctx) };
  if (m[2]) e.tapped = true;
  ctx.last = { ref: "it" };
  return e;
}

// ---------------------------------------------------------------------------------------------
// effect sentence parser

const SUBJ_RES = [
  /^(you)\b/i,
  /^(each opponent|each of your opponents|your opponents|each other player|defending player|the defending player)\b/i,
  /^(each player)\b/i,
  /^(target (?:player|opponent))\b/i,
  /^(that player|the player|they)\b/i,
  /^(its (?:controller|owner)|that (?:creature|permanent|spell|card|land|artifact|token)'s (?:controller|owner))\b/i,
];
const VERB3 = { draws: "draw", discards: "discard", loses: "lose", gains: "gain", mills: "mill", sacrifices: "sacrifice", creates: "create", scries: "scry", surveils: "surveil",
  reveals: "reveal", searches: "search", puts: "put", exiles: "exile", returns: "return", adds: "add", chooses: "choose", shuffles: "shuffle", untaps: "untap", taps: "tap", pays: "pay", looks: "look", controls: "control", deals: "deal", may: "may" };

function splitSubject(c, ctx) {
  for (const re of SUBJ_RES) {
    const m = c.match(re);
    if (m) {
      const rest = c.slice(m[0].length).trim();
      if (!rest) return null;
      return { subj: m[1], rest };
    }
  }
  return null;
}
function normVerb(rest) {
  const m = rest.match(/^(\w+)\b(.*)$/s);
  if (!m) return rest;
  const v = VERB3[m[1].toLowerCase()];
  return v ? v + m[2] : rest;
}

function stripOfChoice(s) { return s.replace(/\s+of (?:their|your|his or her|its controller's|that player's) choice$/i, ""); }

export function parseEffects(text, ctx) {
  const sents = splitSentences(text.replace(/\s*\n\s*/g, " "));
  const out = [];
  let lastGroup = [];
  for (let i = 0; i < sents.length; i++) {
    let s = sents[i].replace(/[.]$/, "").trim();
    if (!s) continue;
    try {
      // "It has "..."" / "They have "..."" attaching to the previous token
      let m = s.match(/^(?:it|they) (?:has|have) ("[^"]+")$/i);
      const lastTok = (() => {
        let e = out[out.length - 1];
        if (e && e.op === "may" && Array.isArray(e.effects)) e = e.effects[e.effects.length - 1]; // "you may create … It has …"
        return e && e.op === "createToken" && e.token && typeof e.token === "object" ? e : null;
      })();
      if (m && lastTok) {
        if (!ctx.parseAbility) fail("no parseAbility");
        const tk = lastTok.token;
        (tk.abilities ||= []).push(...ctx.parseAbility(m[1].slice(1, -1)));
        continue;
      }
      if (/^damage can't be prevented this turn$/i.test(s)) { const e = { op: "until", until: "endOfTurn", static: { type: "cantPrevent", affects: "you" } }; out.push(e); lastGroup = [e]; continue; }
      // "Until your next turn, your life total can't change and you gain protection from everything." (Teferi's Protection)
      if ((m = s.match(/^until your next turn, (.+)$/i)) && /life total can't change|protection from everything/i.test(m[1])) {
        const parts = splitTop(m[1], /\s+and\s+/i);
        const effs = parts.map((pt) => {
          if (/^your life total can't change$/i.test(pt.trim())) return { op: "until", until: "yourNextTurn", static: { type: "lifeCantChange", affects: "you" } };
          if (/^you gain protection from everything$/i.test(pt.trim())) return { op: "until", until: "yourNextTurn", static: { type: "playerProtection", affects: "you", from: "everything" } };
          return fail("until your next turn: " + pt);
        });
        out.push(...effs); lastGroup = effs; continue;
      }
      // phasing
      if ((m = s.match(/^(.+?) phases? out$/i))) {
        const t = m[1].trim();
        const what = /^all /i.test(t) ? { ref: "all", filter: parseFilter(t.replace(/^all /i, "")) } : objRef(t, ctx);
        const e = { op: "phaseOut", what };
        out.push(e); lastGroup = [e]; continue;
      }
      // "You may choose new targets for the copy." after a copy effect
      if (/^you may choose new targets for (?:the|that) cop(?:y|ies)$/i.test(s) && out.length) {
        let last = out[out.length - 1];
        if (last.op === "may" && Array.isArray(last.effects) && last.effects.length) last = last.effects[last.effects.length - 1];
        if (last.op === "copyAbility" || last.op === "copySpell") { last.newTargets = true; continue; }
      }
      // impulse: "Until the end of your next turn, you may play those cards." / "You may play that card this turn." after exiling the top of your library
      if (((m = s.match(/^(until the end of your next turn|until end of turn|until end of your next turn), you may (play|cast) (?:those cards|that card|them|it|the exiled cards?)$/i)) ||
          (m = s.match(/^you may (play|cast) (?:those cards|that card|them|it|the exiled cards?) (this turn|until end of turn|until the end of your next turn)$/i))) && out.length && out[out.length - 1].op === "exileTop") {
        const when = /next turn/i.test(m[1] + " " + (m[2] || "")) ? "endOfYourNextTurn" : "endOfTurn";
        const e = out[out.length - 1];
        e.mayPlay = true; e.until = when;
        if (/cast/i.test(m[0].replace(/^until[^,]*, /i, "").slice(0, 12))) e.castOnly = true;
        continue;
      }
      // "Each player who can't discards a card." after an edict (Plaguecrafter)
      if (/^each player who can't (?:sacrifices? .*?)?discards (?:a|one) card$/i.test(s) && out.length && out[out.length - 1].op === "sacrifice") {
        out[out.length - 1].ifCant = [{ op: "discard", who: "you", amount: 1 }];
        continue;
      }
      // instead
      if ((m = s.match(/^if (.+?), (.+) instead$/i)) || (m = s.match(/^(.+) instead if (.+)$/i) && null)) {
        if (!lastGroup.length) fail("instead without antecedent");
        const cond = parseCond(m[1], ctx);
        let thenE;
        let mm;
        if ((mm = m[2].match(new RegExp(`^create (${NUM_RE}) of those tokens$`, "i"))) && lastGroup.length === 1 && lastGroup[0].op === "createToken") {
          thenE = [{ ...JSON.parse(JSON.stringify(lastGroup[0])), amount: amt(mm[1], ctx) }];
        } else thenE = attempt(ctx, () => parseClauses(m[2], ctx));
        const base = out.splice(out.length - lastGroup.length, lastGroup.length);
        const e = { op: "if", cond, then: thenE, else: base };
        out.push(e);
        lastGroup = [e];
        continue;
      }
      // may ... [if you do ...] [if you don't ...]
      let effs;
      if (/^(?:you |that player |the player |its controller |its owner |target (?:player|opponent) |each (?:player|opponent) )?may\b/i.test(s) && !/^you may (?:choose|look)/i.test(s)) {
        const r = parseMay(s, sents, i, ctx);
        effs = r.effects;
        i = r.next;
      } else {
        effs = parseClauses(s, ctx);
      }
      out.push(...effs);
      lastGroup = effs;
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      if (ctx.allowManual && out.length && !/^if\b/i.test(s) === false || (ctx.allowManual && out.length)) {
        const mt = { op: "manual", text: s + "." };
        out.push(mt);
        lastGroup = [mt];
        ctx.partial = true;
        ctx.failNotes = (ctx.failNotes || []).concat(e.message);
        continue;
      }
      throw e;
    }
  }
  return out;
}

function parseMay(s, sents, i, ctx) {
  // who
  const m = s.match(/^(?:(you|that player|the player|its controller|its owner|target player|target opponent|each player|each opponent) )?may (.+)$/i);
  if (!m) fail("may");
  let who = "you";
  if (m[1] && !/^you$/i.test(m[1])) who = playerRef(m[1], ctx) || fail("may who");
  const body = m[2].replace(/[.]$/, "");
  let next = i;
  // look for "if you do" / "if you don't" follow-ups
  const thenSents = [];
  const elseSents = [];
  const ifDo = /^if (?:you|that player|the player|they) do\b,? ?(.*)$/i;
  const ifNot = /^if (?:you|that player|the player|they) (?:don't|doesn't),? ?(.*)$/i;
  let j = i + 1;
  let mm;
  if (j < sents.length && (mm = sents[j].replace(/[.]$/, "").match(ifDo)) && mm[1]) { thenSents.push(mm[1]); j++; }
  if (j < sents.length && (mm = sents[j].replace(/[.]$/, "").match(ifNot)) && mm[1]) { elseSents.push(mm[1]); j++; }
  next = j - 1;
  let cost = null;
  try { cost = /^(?:pay|discard|sacrifice|exile|remove)\b/i.test(body) ? parseCost(body.replace(/^pay (\d+) life$/i, "pay $1 life")) : null; } catch (e) { if (!(e instanceof Fail)) throw e; }
  if (cost && cost.sac) { if (cost.sac.controller) delete cost.sac.controller; }
  const e = { op: "may" };
  if (who !== "you") e.who = who;
  if (cost && (thenSents.length || elseSents.length)) {
    e.cost = cost;
    ctx.player = who !== "you" ? who : ctx.player;
    e.effects = thenSents.length ? parseEffectsInline(thenSents.join(". "), ctx) : [];
    if (elseSents.length) e.else = parseEffectsInline(elseSents.join(". "), ctx);
    return { effects: [e], next };
  }
  if (cost && !thenSents.length) {
    // "you may pay {2}" with nothing following: express as cost with no effects only for Smothering Tithe style (needs else)
    fail("optional cost with no consequence");
  }
  const inner = attempt(ctx, () => parseClauses(body, ctx));
  e.effects = inner;
  if (thenSents.length) e.effects = inner.concat(parseEffectsInline(thenSents.join(". "), ctx));
  if (elseSents.length) e.else = parseEffectsInline(elseSents.join(". "), ctx);
  return { effects: [e], next };
}
function parseEffectsInline(text, ctx) {
  const saved = ctx.allowManual;
  ctx.allowManual = false;
  try { return parseEffects(text, ctx); } finally { ctx.allowManual = saved; }
}

/** parse one sentence (possibly several clauses) into effects */
export function parseClauses(s, ctx) {
  s = s.trim().replace(/[.]$/, "").replace(/^then,?\s+/i, "");
  // where X is ...
  let m = s.match(/^(.*?),? where x is (.+)$/i);
  if (m) {
    const xa = expr(m[2], ctx);
    const saved = ctx.xAmount;
    ctx.xAmount = xa;
    try { return parseClauses(m[1], ctx); } finally { ctx.xAmount = saved; }
  }
  // whole clause first
  try { return attempt(ctx, () => parseClause(s, ctx)); } catch (e) { if (!(e instanceof Fail)) throw e; var firstErr = e; }
  // ", then " / " then "
  let parts = splitTop(s, /,?\s+then\s+/i);
  if (parts.length > 1) {
    return attempt(ctx, () => {
      const out = [];
      for (const p of parts) out.push(...parseClauses(p, ctx));
      return out;
    });
  }
  // " and " + verb / subject
  const AND_RE = /,?\s+and\s+(?=(?:you |it |that player |that creature |they |each opponent |each player |target (?:player|opponent) )?(?:draw|discard|lose|gain|create|put|sacrifice|return|exile|destroy|scry|surveil|mill|untap|tap|add|deal|shuffle|search|gets?|gains?|attach|fights?|loses|draws|discards|creates|puts|exiles)\b)/i;
  parts = splitTop(s, AND_RE);
  if (parts.length > 1) {
    return attempt(ctx, () => {
      const out = [];
      let who = null;
      for (let k = 0; k < parts.length; k++) {
        const p = parts[k];
        const sub = splitSubject(p, ctx);
        const saved = ctx.carryWho;
        if (k > 0 && !sub && who) ctx.carryWho = who;
        const effs = parseClauses(p, ctx);
        ctx.carryWho = saved;
        if (k === 0 && sub) {
          const sj = sub.subj.toLowerCase();
          who = sj === "you" ? "you" : /^each (?:opponent|of your opponents)|^your opponents|^each other player|defending player/.test(sj) ? "opponent" : sj === "each player" ? "eachPlayer" : ctx.player;
        }
        out.push(...effs);
      }
      return out;
    });
  }
  throw firstErr;
}

function parseClause(c, ctx) {
  c = c.trim().replace(/^then,?\s+/i, "").replace(/[.]$/, "");
  let m;
  if (/^it's still an? \w+$/i.test(c)) return [];
  if ((m = c.match(/^until end of turn, (.+)$/i)) && !/ becomes /i.test(c)) return parseClause(m[1] + " until end of turn", ctx);
  if ((m = c.match(/^until end of turn, ~ becomes an? (\d+)\/(\d+) ([a-z ]+?)(?:creature)(?: with (.+))?$/i))) {
    const words = m[3].trim().split(/\s+/).filter((w) => w && w !== "and");
    const colors = [], subtypes = [];
    for (const w of words) { if (COLORS[w.toLowerCase()]) colors.push(COLORS[w.toLowerCase()]); else subtypes.push(w.toLowerCase()); }
    return [{ op: "animate", what: "self", power: +m[1], toughness: +m[2], colors, subtypes, keywords: m[4] ? parseKeywordList(m[4]) : [], until: "endOfTurn" }];
  }
  // ---- conditional prefix: "If COND, EFFECT"
  if (/^if /i.test(c)) {
    const body = c.slice(3);
    const commas = [];
    for (let i = 0; i < body.length; i++) if (body[i] === "," && body[i + 1] === " ") commas.push(i);
    for (const ci of commas) {
      let cond;
      const snapC = snap(ctx);
      try { cond = parseCond(body.slice(0, ci), ctx); } catch (e) { if (!(e instanceof Fail)) throw e; restore(ctx, snapC); continue; }
      const rest = body.slice(ci + 2);
      const then = parseClauses(rest, ctx);
      return [{ op: "if", cond, then }];
    }
    fail("conditional");
  }
  // ---- trailing condition: "EFFECT if COND"
  if ((m = c.match(/^(.+?),? if ((?:you|it|that|this|~|there|an opponent|no)\b.*)$/i)) && !/^(?:you may|sacrifice)/i.test(c)) {
    let cond;
    const snapC = snap(ctx);
    try { cond = parseCond(m[2], ctx); } catch (e) { if (!(e instanceof Fail)) throw e; restore(ctx, snapC); cond = null; }
    if (cond) {
      const then = parseClauses(m[1], ctx);
      return [{ op: "if", cond, then }];
    }
  }
  // ---- "for each ..." suffix
  if ((m = c.match(/^(.*\S)\s+for each (.+)$/i)) && !/^search\b/i.test(c)) {
    const savedMult = ctx.mult, savedUsed = ctx.multUsed;
    ctx.mult = countOf(m[2], ctx);
    ctx.multUsed = false;
    try {
      const r = parseClause(m[1], ctx);
      if (!ctx.multUsed) fail("for each not consumed");
      return r;
    } finally { ctx.mult = savedMult; ctx.multUsed = savedUsed; }
  }

  // ---- object-subject rules
  const o = objectSubjectRules(c, ctx);
  if (o) return o;

  // ---- player subject / imperative
  const sub = splitSubject(c, ctx);
  let who, rest;
  if (sub) {
    who = /^target /i.test(sub.subj) ? playerRef(sub.subj, ctx) : playerRef(sub.subj, ctx);
    if (!who) fail("subject " + sub.subj);
    rest = normVerb(sub.rest);
    if (/^(?:its|that)/i.test(sub.subj) === false && !/^(?:you|each opponent|each player|each of your opponents|your opponents|each other player|defending player|the defending player)$/i.test(sub.subj)) ctx.player = who;
  } else {
    who = ctx.carryWho || "you";
    rest = c;
  }
  const r = playerRules(who, rest, ctx, !!sub);
  if (r) return r;
  if (!sub || who === "you") {
    const r2 = imperativeRules(rest, ctx);
    if (r2) return r2;
  }
  fail("no rule for clause: " + c);
}

// ---------------------------------------------------------------------------------------------
// object-subject rules ("X deals", "X gets", "X gains", "X fights", ...)

function damageToList(text, ctx) {
  const t = text.trim();
  const parts = splitTop(t, /\s+and\s+(?=each |target |that |you\b|any target|up to)/i);
  const out = [];
  for (const p of parts) {
    const pp = p.trim().replace(/,$/, "");
    out.push(anyRef(pp, ctx, {}));
  }
  return out;
}
function damageEffects(from, amount, tos, ctx) {
  ctx.hasPrev = true;
  return tos.map((to) => {
    const e = { op: "damage", amount, to };
    if (from !== "self") e.from = from;
    return e;
  });
}

function objectSubjectRules(c, ctx) {
  let m;
  // --- damage
  if (/ damage divided as you choose/i.test(c)) {
    const dm = c.match(/^(.+?) deals? (\d+|x) damage divided as you choose among (one or two|one, two, or three|any number of|up to (\w+)) targets$/i);
    if (!dm) fail("divided damage");
    const from = /^(?:it|~)$/i.test(dm[1].trim()) ? (dm[1].trim() === "~" ? "self" : ctx.last || "self") : objRef(dm[1], ctx);
    const amount = amt(dm[2], ctx);
    const max = /three/i.test(dm[3]) ? 3 : /^one or two$/i.test(dm[3]) ? 2 : dm[4] ? num(dm[4]) : typeof amount === "number" ? amount : 20;
    ctx.targets.push({ what: "any", min: 1, max, text: "you'll divide the damage among them" });
    const r = { ref: "target", i: ctx.targets.length - 1 };
    const e = { op: "damage", amount, to: r, divided: true };
    if (from !== "self") e.from = from;
    ctx.hasPrev = true;
    return [e];
    }
  if ((m = c.match(/^(.+?) deals? (\d+|x|that much|twice that much) damage to (.+)$/i)) || (m = c.match(/^(.+?) deals? damage equal to (.+?) to (.+)$/i))) {
    const isEq = /deals? damage equal to/i.test(c) && !/^\d/.test(m[2]);
    const srcText = m[1];
    if (/^(?:it|~|that creature|that permanent|enchanted creature|equipped creature)$/i.test(srcText) || /^(?:up to \w+ )?target /i.test(srcText) || /^(?:each|all) /i.test(srcText)) {
      const from = objRef(srcText, ctx);
      if (typeof from === "object" && from.ref === "all") fail("each source");
      let amount;
      if (isEq) amount = expr(m[2], ctx);
      else if (/^twice that much$/i.test(m[2])) fail("twice");
      else amount = amt(m[2], ctx);
      if (!isEq && typeof amount !== "object") amount = mulAmt(amount, ctx);
      const toText = m[3];
      if (/^itself$/i.test(toText)) return damageEffects(from, amount, [from], ctx);
      const savedLast = ctx.last;
      const tos = damageToList(toText, ctx);
      // "each other creature" with a non-self source is ambiguous
      if (tos.some((t) => t && t.ref === "all" && t.filter.other) && from !== "self") fail("each other with foreign source");
      if (from !== "self") ctx.last = from === ctx.last ? from : ctx.last;
      return damageEffects(from, amount, tos, ctx);
    }
  }
  if ((m = c.match(/^(.+?) deals? damage to itself equal to its power$/i))) {
    const from = objRef(m[1], ctx);
    return damageEffects(from, { powerOf: from }, [from], ctx);
  }
  // --- fight
  if ((m = c.match(/^(.+?) fights? (.+)$/i)) && !/^(?:you|each)\b/i.test(c)) {
    const a = objRef(m[1], ctx);
    const b = objRef(m[2], ctx);
    return [{ op: "fight", a, b }];
  }
  if ((m = c.match(/^(.+?) (?:each )?gets? (.+?) until end of turn and can't be blocked this turn$/i))) {
    const a = objectSubjectRules(`${m[1]} gets ${m[2]} until end of turn`, ctx);
    if (!a) fail("pump+unblockable");
    const what = a[0].what;
    return [...a, { op: "until", until: "endOfTurn", static: { type: "cantBeBlocked", affects: what } }];
  }
  // --- gets +N/+N (and gains ...) until end of turn
  if ((m = c.match(/^(.+?) (?:each )?gets? ([+-])(\d+|x)\/([+-])(\d+|x)(?: and (?:gains?|has|have) (.+?))?(?: until end of turn| this turn)?$/i)) && !/^(?:you|each opponent|each player)$/i.test(m[1])) {
    const until = /until end of turn|this turn/i.test(c);
    if (!until) fail("pump without duration");
    return pumpEffect(m[1], m, ctx, until);
  }
  // --- gains keywords until end of turn
  if ((m = c.match(/^(.+?) (?:also )?(?:gains?|has|have) (.+?) until end of turn$/i)) && !/^(?:you|each opponent|each player|that player)$/i.test(m[1]) && !/\bgain control\b/i.test(c)) {
    const what = objRef(m[1], ctx, { bare: true });
    let kws;
    try { kws = parseKeywordList(m[2]); } catch (e) { if (e instanceof Fail) fail("granted ability: " + m[2]); throw e; }
    return [{ op: "pump", what, power: 0, toughness: 0, keywords: kws, until: "endOfTurn" }];
  }
  // --- until end of turn, X have base power and toughness / gain all types (Mirror Entity) etc: unsupported
  // --- can't be blocked this turn
  if ((m = c.match(/^(.+?) can't (be blocked|block|attack|be blocked except by .+) this turn$/i))) {
    const what = objRef(m[1], ctx, { bare: true });
    const kind = m[2].toLowerCase();
    if (kind === "be blocked") return [{ op: "until", until: "endOfTurn", static: { type: "cantBeBlocked", affects: what } }];
    if (kind === "block") return [{ op: "until", until: "endOfTurn", static: { type: "cantBlock", affects: what } }];
    if (kind === "attack") return [{ op: "until", until: "endOfTurn", static: { type: "cantAttack", affects: what } }];
    fail("cant be blocked except");
  }
  // --- base power and toughness
  if ((m = c.match(/^(.+?) has base power and toughness (\d+)\/(\d+) until end of turn$/i))) {
    const what = objRef(m[1], ctx);
    return [{ op: "until", until: "endOfTurn", static: { type: "setBasePT", affects: what, power: +m[2], toughness: +m[3] } }];
  }
  return null;
}

function pumpEffect(whatText, m, ctx, until) {
  const what = objRef(whatText, ctx, { bare: true });
  const mult = ctx.mult;
  let power = signedAmt(m[2], m[3], ctx);
  let toughness = signedAmt(m[4], m[5], ctx);
  let kws = [];
  const eff = [];
  let cantBeBlocked = false;
  if (m[6]) {
    let kt = m[6];
    if (/\band can't be blocked$/i.test(kt)) { cantBeBlocked = true; kt = kt.replace(/\s+and can't be blocked$/i, ""); }
    if (kt) {
      try { kws = parseKeywordList(kt); } catch (e) { if (e instanceof Fail) fail("granted ability: " + kt); throw e; }
    }
  }
  if (mult) {
    // "gets +1/+1 for each X": scale
    ctx.multUsed = true;
    const scale = (v) => (v === 0 ? 0 : { mul: [v, mult] });
    power = scale(power); toughness = scale(toughness);
  }
  const e = { op: "pump", what, power, toughness, keywords: kws };
  if (until) e.until = "endOfTurn";
  eff.push(e);
  if (cantBeBlocked) eff.push({ op: "until", until: "endOfTurn", static: { type: "cantBeBlocked", affects: what } });
  return eff;
}

// ---------------------------------------------------------------------------------------------
// player-subject rules

function mayHaveWho(e, who) { if (who !== "you") e.who = who; return e; }

function playerRules(who, c, ctx, hadSubject) {
  let m;
  const wh = (e) => (who === "you" ? e : { ...e, who });
  const withWho = (e) => { e.who = who; return e; };

  // draw
  if ((m = c.match(/^draw (.+?)(?: cards?)?$/i)) || false) {
    let body = c.replace(/^draw /i, "");
    let n;
    if ((m = body.match(/^cards? equal to (.+)$/i))) n = expr(m[1], ctx);
    else if ((m = body.match(/^(.+?) cards?$/i))) n = mulAmt(amt(m[1], ctx), ctx);
    else fail("draw amount");
    ctx.hasPrev = true;
    return [{ op: "draw", who, amount: n }];
  }
  // discard
  if ((m = c.match(/^discard (.+)$/i)) && !/^discard a card:/i.test(c)) {
    let body = m[1];
    let random = false;
    if (/ at random$/i.test(body)) { random = true; body = body.replace(/ at random$/i, ""); }
    if (!/^(?:an? |one |two |three |four |five |x |\d+ )?cards?$/i.test(body.trim())) fail("discard object");
    const n = amt(body.replace(/\s*cards?$/i, "").trim() || "a", ctx);
    const e = { op: "discard", who, amount: mulAmt(n, ctx) };
    if (random) e.random = true;
    ctx.hasPrev = true;
    return [e];
  }
  // lose / gain life
  if ((m = c.match(/^(lose|gain) life equal to (.+)$/i))) {
    const n = expr(m[2], ctx);
    ctx.hasPrev = true;
    return [{ op: m[1].toLowerCase() === "lose" ? "loseLife" : "gainLife", who, amount: n }];
  }
  if ((m = c.match(/^(lose|gain) (.+?) life$/i))) {
    const n = mulAmt(amt(m[2], ctx), ctx);
    ctx.hasPrev = true;
    return [{ op: m[1].toLowerCase() === "lose" ? "loseLife" : "gainLife", who, amount: n }];
  }
  if ((m = c.match(/^lose the game$/i))) return [{ op: "lose", who }];
  if ((m = c.match(/^win the game$/i))) return [{ op: "win", who }];
  // mill
  if ((m = c.match(/^mill (.+?) cards?$/i))) {
    ctx.hasPrev = true;
    return [{ op: "mill", who, amount: mulAmt(amt(m[1], ctx), ctx) }];
  }
  // scry / surveil
  if ((m = c.match(/^(scry|surveil) (\d+|x)$/i))) {
    const e = { op: m[1].toLowerCase(), amount: mulAmt(amt(m[2], ctx), ctx) };
    return [who === "you" ? e : { ...e, who }];
  }
  // shuffle
  if (/^shuffle your library$/i.test(c)) return [{ op: "shuffle", who: "you" }];
  // sacrifice
  if ((m = c.match(/^sacrifice (.+)$/i))) {
    const body = stripOfChoice(m[1].trim());
    if (/^(?:~|this (?:creature|artifact|enchantment|land|permanent|aura|token))$/i.test(body)) return [{ op: "sacrificeIt", what: "self" }];
    if (/^(?:it|that creature|that permanent|that token)$/i.test(body)) return [{ op: "sacrificeIt", what: ctx.last || fail("sac it") }];
    if (/with the least|any number|the rest/i.test(body)) fail("sacrifice complex");
    let n = 1, noun = body;
    const mm = body.match(new RegExp(`^(${NUM_RE}) (.+)$`, "i"));
    if (mm) { n = num(mm[1]); noun = mm[2]; }
    const f = parseFilter(noun);
    if (f._spell) fail("sac spell");
    if (f.controller) delete f.controller;
    return [{ op: "sacrifice", who, filter: f, amount: n }];
  }
  // create
  if ((m = c.match(/^create (.+)$/i))) {
    const r = parseCreate(m[1], ctx, who);
    return r;
  }
  // search
  if (/^search /i.test(c)) return searchRule(who, c, ctx);
  // add mana
  if ((m = c.match(/^add (.+)$/i))) {
    const body = m[1];
    let mana;
    if (ctx.mult && /^\{[WUBRGC]\}$/.test(body.trim())) { mana = { color: body.trim()[1], n: ctx.mult }; ctx.multUsed = true; }
    else mana = parseManaBody(body, ctx);
    const e = { op: "addMana", mana };
    return [who === "you" ? e : { ...e, who }];
  }
  // ring tempts
  if (/^the ring tempts you$/i.test(c)) return [{ op: "ringTempts", who: "you" }];
  // may (handled earlier mostly)
  // surveil etc done. choose
  return null;
}

function searchRule(who, c, ctx) {
  let m;
  const OWN = "your|their|its controller's|that player's|target player's|target opponent's|an opponent's";
  const LIB = `(?:${OWN}) library`;
  // Cultivate-style split
  if ((m = c.match(new RegExp(`^search ${LIB} for up to two (.+?) cards?,? reveal those cards,? put one onto the battlefield tapped and the other into your hand,? then shuffle$`, "i")))) {
    const f = parseFilter(m[1]);
    return [
      { op: "search", who, filter: f, min: 0, max: 1, to: "battlefield", tapped: true, reveal: true },
      { op: "search", who, filter: f, min: 0, max: 1, to: "hand", reveal: true },
    ];
  }
  m = c.match(new RegExp(`^search (${OWN}) library for (up to (\\w+) |(\\w+) )?(.+?)(, reveal (?:it|that card|those cards|them))?(?:,| and) put (?:it|that card|them|those cards) (onto the battlefield( tapped)?|into (?:your|their|its owner's) hand|into (?:your|their|its owner's) graveyard|on top of (?:your|their) library)(?:,? then shuffle| and shuffle)?$`, "i"));
  if (!m) fail("search");
  const owner = m[1].toLowerCase();
  let searcher = who;
  if (owner !== "your" && who === "you" && /^(?:their|its controller's|that player's)$/.test(owner)) searcher = ctx.player || ctx.last && { ref: "controllerOf", of: ctx.last } || fail("search who");
  const max = m[3] ? num(m[3]) : m[4] ? num(m[4]) : 1;
  if (max == null) fail("search count");
  let noun = m[5].trim();
  noun = noun.replace(/\s+cards?$/i, "");
  if (/share|that/i.test(noun)) fail("search constraint");
  let filter;
  if (!noun || /^card$/i.test(noun)) filter = {};
  else filter = parseFilter(noun);
  const destTxt = m[7].toLowerCase();
  const e = { op: "search", who: searcher, filter, min: 0, max };
  if (destTxt.startsWith("onto")) { e.to = "battlefield"; if (m[8]) e.tapped = true; }
  else if (/hand$/.test(destTxt)) e.to = "hand";
  else if (/graveyard$/.test(destTxt)) e.to = "graveyard";
  else { e.to = "library"; e.position = "top"; }
  if (m[6]) e.reveal = true;
  ctx.last = { ref: "it" };
  return [e];
}

// ---------------------------------------------------------------------------------------------
// imperatives on objects

function imperativeRules(c, ctx) {
  let m;
  // destroy
  if ((m = c.match(/^destroy (.+)$/i))) {
    const what = objRef(m[1], ctx);
    return [{ op: "destroy", what }];
  }
  // impulse exile from the top of a library (the next sentence may grant "you may play those cards")
  if ((m = c.match(new RegExp(`^exile the top (${NUM_RE} cards?|card) of (your|each player's|target player's|that player's) library$`, "i")))) {
    const n = /^card$/i.test(m[1]) ? 1 : num(m[1].split(" ")[0]);
    const who = /^your$/i.test(m[2]) ? "you" : /^each player's$/i.test(m[2]) ? "eachPlayer" : /^target/i.test(m[2]) ? addTarget(m[2].replace(/'s$/, ""), ctx) : ctx.player || fail("whose library");
    ctx.last = { ref: "it" };
    return [{ op: "exileTop", who, amount: n, mayPlay: false }];
  }
  if (/^copy (?:that|this|the triggering) ability$/i.test(c)) return [{ op: "copyAbility", what: { ref: "event", what: "ability" } }];
  if (/^proliferate$/i.test(c)) return [{ op: "proliferate" }];
  // library batch m2: goad / monstrosity / populate / flip a coin
  if ((m = c.match(/^goad (.+)$/i)) && !/ (?:that|each) (?:had|has)\b/i.test(c)) return [{ op: "goad", what: objRef(m[1], ctx) }];
  if ((m = c.match(/^monstrosity (\d+|x)$/i))) return [{ op: "_monstrosity", amount: /^x$/i.test(m[1]) ? "x" : +m[1] }];
  if (/^populate$/i.test(c)) return [{ op: "populate" }];
  if ((m = c.match(/^you get ((?:\{E\})+)$/i))) return [{ op: "addCounters", what: "you", kind: "energy", amount: m[1].length / 3 }];
  if (/^flip a coin$/i.test(c)) return [{ op: "flipCoin" }];
  if ((m = c.match(/^adapt (\d+)$/i))) return [{ op: "if", cond: { type: "counters", what: "self", kind: "+1/+1", op: "==", n: 0 }, then: [{ op: "addCounters", what: "self", kind: "+1/+1", amount: +m[1] }] }];
  if (/^choose a creature type$/i.test(c)) return [{ op: "chooseCreatureType" }];
  // exile
  if ((m = c.match(/^exile (.+?)(?: until (~|this \w+) leaves the battlefield)?$/i))) {
    if (/^the top/i.test(m[1]) || /graveyard$/i.test(m[1]) && /^target player's/i.test(m[1])) fail("exile library/graveyard");
    const what = objRef(m[1], ctx);
    const e = { op: "exile", what };
    if (m[2]) e.until = "sourceLeaves";
    return [e];
  }
  // counter
  if ((m = c.match(/^counter (.+?)(?: unless (?:its controller|that player|they) pays? ((?:\{[^}]+\})+))?$/i))) {
    const what = objRef(m[1], ctx);
    const e = { op: "counter", what };
    if (m[2]) e.unlessPay = m[2];
    return [e];
  }
  // return
  if ((m = c.match(/^return (.+?) to (the battlefield|(?:its owner's|their owner's|your|their|that player's|its controller's) hand)(?: (tapped))?(?: under your control)?$/i))) {
    let noun = m[1].replace(/ from (?:your|a|their) graveyard$/i, (x) => { return " from your graveyard"; });
    const toHand = !/battlefield/i.test(m[2]);
    const fromGy = / from (?:your|a) graveyard$/i.test(noun) || /(?:^|\s)from (?:your|a|their) graveyard/i.test(m[1]);
    let what;
    if (/^(?:~|this card)(?: from your graveyard)?$/i.test(noun.trim())) { what = "self"; if (/graveyard/i.test(noun)) ctx.selfFromGraveyard = true; }
    else if (/^up to /i.test(noun) && !/^up to \w+ target /i.test(noun)) {
      let nn = noun.replace(/ from (?:your|a) graveyard$/i, "");
      what = objRef(nn, ctx, { choose: true });
      what.filter.zone = "graveyard"; what.filter.owner = "you";
    } else what = objRef(noun, ctx, { choose: true });
    if (what && what.ref === "choose" && fromGy) { what.filter.zone = "graveyard"; if (!what.filter.owner) what.filter.owner = "you"; }
    const spec = targetSpecOf(what, ctx);
    const inGy = fromGy || (spec && spec.zone === "graveyard") || (what && what.filter && what.filter.zone === "graveyard");
    if (!toHand) {
      if (!inGy && what !== "self") fail("return to battlefield from non-graveyard");
      const e = { op: "move", what, to: "battlefield" };
      if (m[3]) e.tapped = true;
      if (/under your control/i.test(c)) e.control = "you";
      ctx.last = typeof what === "object" && what.ref === "choose" ? { ref: "it" } : what;
      return [e];
    }
    if (inGy || what === "self" && ctx.selfFromGraveyard) { ctx.last = what && what.ref === "choose" ? { ref: "it" } : what; return [{ op: "move", what, to: "hand" }]; }
    return [{ op: "bounce", what }];
  }
  // put it on the bottom of library
  if ((m = c.match(/^put (it|~|that card|this card) (?:on|into) the (bottom|top) of (?:its owner's|your|their) library$/i))) {
    const what = m[1] === "~" || /this card/i.test(m[1]) ? "self" : ctx.last || fail("put it");
    return [{ op: "move", what, to: "library", position: m[2].toLowerCase() }];
  }
  if ((m = c.match(/^shuffle (~|this card|it) into its owner's library$/i))) return [{ op: "move", what: /~|this card/i.test(m[1]) ? "self" : ctx.last || fail("shuffle it"), to: "library", position: "shuffle" }];
  // put counters
  if ((m = c.match(/^put (\w+) (\+1\/\+1|-1\/-1|[a-z][\w-]*) counters? on (.+)$/i))) {
    const n = mulAmt(amt(m[1], ctx), ctx);
    const kind = m[2].toLowerCase();
    const what = objRef(m[3], ctx, { bare: false, choose: true });
    return [{ op: "addCounters", what, kind, amount: n }];
  }
  // untap / tap
  if ((m = c.match(/^(untap|tap) (.+)$/i))) {
    let t = m[2];
    let what;
    if (/^up to (\w+) (.+)$/i.test(t) && !/target/i.test(t)) {
      const mm = t.match(/^up to (\w+) (.+)$/i);
      const f = parseFilter(mm[2]);
      what = { ref: "choose", filter: f, min: 0, max: num(mm[1]) };
      ctx.last = { ref: "it" };
    } else if (/^(?:him|her)$/i.test(t)) what = ctx.last || "self";
    else what = objRef(t, ctx, { bare: false });
    return [{ op: m[1].toLowerCase(), what }];
  }
  // gain control
  if ((m = c.match(/^gain control of (.+?)( until end of turn)?$/i))) {
    const what = objRef(m[1], ctx);
    const e = { op: "gainControl", what };
    if (m[2]) e.until = "endOfTurn";
    return [e];
  }
  // transform
  if ((m = c.match(/^transform (~|it|this \w+)$/i))) return [{ op: "transform", what: "self" }];
  // amass
  if ((m = c.match(/^amass (\w+) (\d+)$/i))) {
    const st = subtypeOf(m[1]) || fail("amass type");
    return [{ op: "amass", amount: +m[2], subtype: st }];
  }
  // proliferate etc -> let caller manualise
  if ((m = c.match(/^extra turn$/i))) return [{ op: "extraTurn" }];
  // brainstorm: put N cards from your hand on top of your library in any order
  if ((m = c.match(new RegExp(`^put (${NUM_RE}) cards? from your hand on top of your library in any order$`, "i")))) {
    const n = num(m[1]);
    return [{ op: "move", what: { ref: "choose", filter: { zone: "hand", owner: "you" }, min: n, max: n, ordered: true, prompt: `Put ${n} cards from your hand on top of your library — choose them in order (the last one chosen ends up on top)` }, to: "library", position: "top" }];
  }
  return null;
}
