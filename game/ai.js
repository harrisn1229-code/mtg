// ai.js — the computer opponent for Binder "play vs AI" (SPEC §3).
//
//   decide(game, request, opts = {}) -> answer      opts.difficulty: "easy" | "normal" | "hard"
//   mood(game, playerIdx) -> "winning" | "losing" | "even"
//
// Rules this module keeps:
//   * Never calls game.rng() and never mutates game state (only pure engine queries: matches/find/amount/evalCond/
//     targetCandidates/canBlock/planPayment/validate). Randomness comes from a private PRNG seeded from stable inputs.
//   * Reads only public information plus its own hand (never the opponent's hand or any library order). Search/scry
//     requests show it cards the rules let it see.
//   * Always returns a legal answer: every answer is checked with game.validate() and replaced by game.defaultAnswer()
//     if anything goes wrong.
// The engine attaches non-enumerable `_hint` objects to some requests (target index + effects, modes, may-effects…);
// the AI uses them to tell harmful from beneficial choices. Everything degrades gracefully without hints.

import { m1CastScore, m1SpecialScore, m1Choose, m1Confirm, m1Number } from "./ai-m1.js";
import { parseManaCost, costCmc, manaAvailable } from "./engine.js";

const LEVEL = { easy: 0, normal: 1, hard: 2 };
const STEP_IDX = { untap: 0, upkeep: 1, draw: 2, main1: 3, beginCombat: 4, declareAttackers: 5, declareBlockers: 6, combatDamage: 7, endCombat: 8, main2: 9, end: 10, cleanup: 11 };
const MEMO = new WeakMap();
const isPid = (id) => typeof id === "string" && /^P\d+$/.test(id);
const pidx = (id) => +id.slice(1);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : v == null || v === "*" || isNaN(+v) ? 0 : +v);
const asArr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

function hash(...xs) {
  let h = 2166136261;
  for (const x of xs) { const s = String(x); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } h ^= 0x9e; h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function prng(seed) {
  let a = seed >>> 0 || 1;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function memoOf(game) {
  let m = MEMO.get(game);
  if (!m) { m = { turn: -1, counts: new Map(), banned: new Set(), last: null, intent: null }; MEMO.set(game, m); }
  return m;
}

// ================================================================================================ public API

export function decide(game, request, opts = {}) {
  const req = request || game.request;
  if (!req) return null;
  let ans = null;
  try {
    ans = new Brain(game, req, opts).answer();
    if (ans && typeof game.validate === "function") game.validate(req, ans);
  } catch (e) {
    if (opts.debug) console.error("[ai]", req.kind, e);
    ans = null;
  }
  if (!ans) ans = typeof game.defaultAnswer === "function" ? game.defaultAnswer(req) : fallback(req);
  return ans;
}

export function mood(game, playerIdx) {
  try {
    const b = new Brain(game, { kind: "none", player: playerIdx }, {});
    const s = b.boardScore(playerIdx) - Math.max(...b.opps.map((q) => b.boardScore(q)), 0);
    if (b.me.lost) return "losing";
    if (s > 70) return "winning";
    if (s < -70) return "losing";
    return "even";
  } catch { return "even"; }
}

function fallback(req) {
  switch (req.kind) {
    case "mulligan": return { keep: true };
    case "priority": return { type: "pass" };
    case "choose": return { chosen: Array.from({ length: req.min }, (_, i) => i) };
    case "confirm": return { yes: false };
    case "number": return { value: req.min };
    case "attackers": return { attacks: [] };
    case "blockers": return { blocks: [] };
    default: return {};
  }
}

// ================================================================================================ the brain

export class Brain {
  constructor(game, req, opts) {
    this.g = game;
    this.st = game.state;
    this.req = req;
    this.p = req.player;
    this.level = LEVEL[opts.difficulty] ?? 1;
    this.me = this.st.players[this.p];
    this.opps = this.st.players.filter((q) => q.idx !== this.p && !q.lost).map((q) => q.idx);
    this.opp = this.opps.length ? this.opps.reduce((a, b) => (this.st.players[b].life < this.st.players[a].life ? b : a)) : (this.p + 1) % this.st.players.length;
    this.rng = prng(hash((game.answers || []).length, this.st.turn, this.p, STEP_IDX[this.st.step] ?? 0, this.st.stack.length, "binder-ai"));
    this.memo = memoOf(game);
    if (this.memo.turn !== this.st.turn) { this.memo.turn = this.st.turn; this.memo.counts = new Map(); this.memo.banned = new Set(); this.memo.last = null; }
    this._val = new Map();
  }

  answer() {
    const r = this.req;
    switch (r.kind) {
      case "mulligan": return this.mulligan();
      case "priority": return this.priority();
      case "choose": return this.choose();
      case "confirm": return { yes: this.confirm() };
      case "number": return { value: this.number() };
      case "attackers": return this.attackers();
      case "blockers": return this.blockers();
      default: return null;
    }
  }

  // ---------------------------------------------------------------------------------------------- basic queries
  O(id) { return this.st.objects[id]; }
  get bf() { return (this._bf ||= this.st.battlefield.map((id) => this.st.objects[id]).filter(Boolean)); }
  ctrlBf(p) { return this.bf.filter((o) => o.controller === p); }
  isCre(o) { return !!o && !!o.c && o.c.types.includes("creature"); }
  isLand(o) { return !!o && !!o.c && o.c.types.includes("land"); }
  kw(o, k) { return this.g.hasKw(o, k); }
  hand(p = this.p) { return this.st.players[p].hand.map((id) => this.O(id)).filter(Boolean); }
  landCount(p = this.p) { return this.ctrlBf(p).filter((o) => this.isLand(o)).length; }
  myTurn() { return this.st.active === this.p; }
  isMain() { return this.st.step === "main1" || this.st.step === "main2"; }
  manaNow(p = this.p) { try { return manaAvailable(this.g, p); } catch { return 0; } }
  roll(pct) { return this.rng() < pct; }
  faceDef(o) { try { return this.g.faceDef(o); } catch { return o.def; } }

  lifeW(p) { const l = this.st.players[p]?.life ?? 20; return 1 + 24 / Math.max(1, l); }
  dmgW(p, n) { const l = this.st.players[p]?.life ?? 20; return 1.2 + 30 / Math.max(1, l) + (n >= l ? 2000 : 0); }

  // ---------------------------------------------------------------------------------------------- valuation
  cValue(c) {
    const pw = Math.max(0, num(c.power)), t = Math.max(0, num(c.toughness));
    const k = (x) => !!c.keywords && c.keywords[x] != null && c.keywords[x] !== false;
    let v = 16 + pw * 11 + t * 7;
    if (k("flying")) v += pw * 6 + 4;
    if (k("trample")) v += pw * 2;
    if (k("deathtouch")) v += pw > 0 ? 16 : 6;
    if (k("lifelink")) v += pw * 4;
    if (k("first strike")) v += pw * 4 + 2;
    if (k("double strike")) v += pw * 10 + 4;
    if (k("menace")) v += pw * 3;
    if (k("vigilance")) v += pw * 2 + t;
    if (k("haste")) v += 2;
    if (k("hexproof")) v += 14;
    if (k("shroud")) v += 10;
    if (k("indestructible")) v += 28;
    if (k("reach")) v += 3;
    if (k("ward")) v += 8;
    if (k("infect")) v += pw * 9;
    if (k("toxic")) v += 8;
    if (k("annihilator")) v += 40;
    if (k("undying") || k("persist")) v += 14;
    if (k("defender") || c.cantAttack) v -= pw * 9 + 4;
    if (c.cantBlock) v -= 4;
    for (const ab of c.abilities || []) {
      if (!ab || ab.synthetic === "intrinsic" || ab.synthetic === "prowess") continue;
      if (ab.kind === "static") v += 10;
      else if (ab.kind === "triggered") v += 9;
      else if (ab.kind === "activated") v += ab.mana ? 6 : 7;
    }
    return Math.max(1, v);
  }

  /** Value of an object wherever it is (permanent, spell on the stack, card in a hidden-from-nobody zone). */
  /** A permanent we only control until end of turn (Threaten effects): worth almost nothing to keep. */
  borrowed(o) {
    return !!o && o.zone === "battlefield" && o.controller !== o.owner && (this.st.controlEffects || []).some((ce) => ce.objId === o.id && ce.until && ce.controller === o.controller);
  }
  objValue(o) {
    if (!o) return 0;
    const hit = this._val.get(o.id);
    if (hit != null) return hit;
    let v;
    if (o.zone === "battlefield" && this.borrowed(o) && o.controller === this.p) v = 1 + num(o.c.power) * 0.01;
    else if (o.zone === "battlefield") v = this.permValue(o);
    else if (o.zone === "stack") v = this.stackValue(o);
    else v = this.cardValue(o);
    this._val.set(o.id, v);
    return v;
  }

  permValue(o) {
    const c = o.c;
    let v;
    if (c.types.includes("creature")) {
      v = this.cValue(c);
      if (o.isCommander) v += 30;
      if (o.token) v -= 4;
      v += (o.attachments || []).length * 8;
      const pl = this.st.players[o.controller];
      if (pl && pl.ring && pl.ring.bearer === o.id) v += 6 + pl.ring.level * 4;
    } else if (c.types.includes("planeswalker")) {
      v = 55 + (o.counters?.loyalty | 0) * 10 + (c.abilities || []).length * 4;
    } else if (c.types.includes("land")) {
      v = 12;
      for (const ab of c.abilities || []) if (ab.kind === "activated" && !ab.mana) v += 8;
    } else {
      const sub = c.subtypes || [];
      if (o.token && sub.includes("treasure")) v = 13;
      else if (o.token && sub.includes("clue")) v = 14;
      else if (o.token && sub.includes("food")) v = 7;
      else if (o.token && sub.includes("blood")) v = 5;
      else if (o.token && sub.includes("map")) v = 9;
      else {
        v = 20;
        for (const ab of c.abilities || []) v += ab.kind === "activated" && ab.mana ? 10 + 10 * Math.max(1, safe(() => this.g.manaUnits(o, ab, o.controller).length) || 1) : 9;
        if (sub.includes("equipment") && o.attachedTo) v += 10;
        if (sub.includes("aura") && o.attachedTo) {
          const h = this.O(o.attachedTo);
          if (h && h.controller !== o.controller) v = 8; // a "pacifism" on someone else's creature: removing it helps them
        }
      }
    }
    if (o.isCommander) v += 10;
    return v;
  }

  /** Value of a card not on the battlefield (hand, graveyard, library seen via search). */
  cardValue(o) {
    const d = o.def || {};
    const types = d.types || [];
    if (types.includes("land") && !(d.layout === "mdfc")) {
      const have = this.landCount(o.owner) + (o.owner === this.p ? this.hand(o.owner).filter((x) => x.def?.types?.includes("land")).length : 1); // never peek at the opponent's hand
      return have < 6 ? 46 - have * 3 : 12;
    }
    let v = 22 + Math.min(num(d.cmc), 8) * 5;
    if (types.includes("creature")) v = Math.max(v, this.cValue(o.c || { power: d.power, toughness: d.toughness, keywords: d.keywords, abilities: d.abilities }) * 0.9);
    if (types.includes("planeswalker")) v += 25;
    const lands = this.landCount(o.owner);
    if (num(d.cmc) > lands + 3) v *= 0.65;
    if (o.isCommander) v += 20;
    return v;
  }

  /** How much a stack object is worth to its controller (for counter decisions). */
  stackValue(o) {
    if (!o) return 0;
    if (o.isAbility) {
      const ab = o.ab || {};
      if (!ab.effects) return 10;
      const src = o.sourceId ? this.O(o.sourceId) : null;
      return Math.max(0, this.evalEffects(ab.effects, { p: o.controller, src: src || o, targets: o._targets || [], x: o.ctx?.x | 0, event: o.ctx?.event }));
    }
    const d = this.faceDef(o);
    if ((d.types || []).some((t) => ["creature", "artifact", "enchantment", "planeswalker", "battle", "land"].includes(t))) {
      return this.permSpellValue(o, d, { p: o.controller, onStack: true });
    }
    let v = this.evalEffects(d.spell?.effects || [], { p: o.controller, src: o, targets: o._targets || [], x: o.x | 0, kicked: o.kicked });
    if (o._modes && d.spell?.modes) for (let i = 0; i < o._modes.length; i++) {
      const m = d.spell.modes.modes[o._modes[i]];
      if (m) v += this.evalEffects(m.effects || [], { p: o.controller, src: o, targets: (o._modeTargets || [])[i] || [], x: o.x | 0 });
    }
    return Math.max(0, v);
  }

  boardScore(p) {
    const pl = this.st.players[p];
    let s = 0;
    for (const o of this.ctrlBf(p)) s += this.isLand(o) ? 6 : this.objValue(o);
    s += pl.hand.length * 14 + Math.min(pl.life, 60) * 2.2 - pl.poison * 6;
    return s;
  }

  // ---------------------------------------------------------------------------------------------- effect evaluation
  ectx(E) { return { source: E.src, you: E.p, targets: E.targets || [], x: E.x | 0, kicked: !!E.kicked, it: E.it || [], quiet: true, sacrificed: E.sacrificed || [], event: E.event || null }; }
  ids(ref, E) {
    if (ref && typeof ref === "object" && !Array.isArray(ref) && ref.ref === "choose") {
      // non-targeted choice on resolution: assume the chooser picks what's best for them
      try {
        const chooser = ref.chooser ? this.playersOfIds(this.g.refsSync(ref.chooser, this.ectx(E))) : [E.p];
        const out = [];
        for (const c of chooser) {
          const objs = this.g.find(ref.filter ?? {}, { source: E.src, you: c });
          const n = Math.max(1, this.amt(ref.min ?? 1, E));
          out.push(...objs.sort((a, b) => this.objValue(a) - this.objValue(b)).slice(0, n).map((o) => o.id));
        }
        return out;
      } catch { return []; }
    }
    try { return this.g.refsSync(ref, this.ectx(E)) || []; } catch { return []; }
  }
  playersOfIds(ids) {
    const out = [];
    for (const id of ids) { const q = isPid(id) ? pidx(id) : this.O(id)?.controller; if (q != null && !out.includes(q)) out.push(q); }
    return out;
  }
  amt(A, E) { try { const n = this.g.amount(A, this.ectx(E)); return Number.isFinite(n) ? n : 0; } catch { return 0; } }

  evalEffects(list, E, depth = 0) {
    if (!list || depth > 6) return 0;
    let v = 0;
    const E2 = { ...E, it: E.it || [] };
    for (const e of asArr(list)) {
      try { v += this.evalEffect(e, E2, depth); } catch { /* ignore */ }
      // track "it" and pending pumps for later clauses (e.g. "+0/+10, then it fights …")
      try {
        if (e && e.op === "pump") {
          const pw = this.amt(e.power ?? 0, E2), tg = this.amt(e.toughness ?? 0, E2);
          const mods = { ...(E2.mods || {}) };
          for (const id of this.ids(e.what ?? { ref: "target", i: 0 }, E2)) { const m = mods[id] || { pw: 0, tg: 0 }; mods[id] = { pw: m.pw + pw, tg: m.tg + tg }; }
          E2.mods = mods;
        }
        if (e && e.op === "createToken") E2.it = [];
        else if (e && (e.what != null || e.to != null) && ["destroy", "exile", "bounce", "move", "pump", "tap", "untap", "gainControl", "damage"].includes(e.op)) E2.it = this.ids(e.op === "damage" ? e.to : e.what, E2);
      } catch { /* ignore */ }
    }
    return v;
  }

  removalValue(o, kind, E) {
    if (!o) return 0;
    const mine = (o.zone === "battlefield" || o.zone === "stack" ? o.controller : o.owner) === E.p;
    if (o.zone !== "battlefield") {
      if (o.zone === "graveyard") return mine ? -3 : 3;
      return 0;
    }
    let v = this.objValue(o);
    if (kind === "destroy" && this.kw(o, "indestructible")) v = 0;
    else if (kind === "bounce") v = o.token ? v : v * 0.4;
    else if (kind === "temp") v *= 0.15;
    else if (kind === "exile") v *= 1.08;
    if (o.isCommander && kind !== "temp") v *= 0.75;
    return mine ? -v : v;
  }

  /** Power/toughness of a battlefield object including pumps applied earlier in the effect list being evaluated. */
  pt(o, E) {
    const m = (E && E.mods && E.mods[o.id]) || { pw: 0, tg: 0 };
    return { pw: num(o.c.power) + m.pw, tg: num(o.c.toughness) + m.tg };
  }
  dmgValue(id, n, E, srcObj) {
    if (isPid(id)) {
      const q = pidx(id);
      return q === E.p ? -n * this.lifeW(q) : n * this.dmgW(q, n);
    }
    const o = this.O(id);
    if (!o || o.zone !== "battlefield") return 0;
    const mine = o.controller === E.p;
    let v = 0;
    if (this.isCre(o)) {
      const rem = this.pt(o, E).tg - (o.damage | 0);
      const dt = srcObj && srcObj.c && this.kw(srcObj, "deathtouch");
      const kills = (n >= rem || dt) && !this.kw(o, "indestructible");
      v = kills ? this.objValue(o) : this.objValue(o) * 0.04 * Math.min(n, rem);
    } else if (o.c.types.includes("planeswalker")) {
      const loy = o.counters?.loyalty | 0;
      v = n >= loy ? this.objValue(o) : this.objValue(o) * 0.6 * n / Math.max(1, loy);
    }
    return mine ? -v : v;
  }

  tokenValue(tok, E) {
    if (typeof tok === "string") return { treasure: 13, food: 6, clue: 13, blood: 5, map: 9, "eldrazi spawn": 7, "eldrazi scion": 9, spawn: 7, scion: 9 }[tok.toLowerCase()] ?? 20;
    if (!tok || typeof tok !== "object") return 15;
    const types = tok.types || ["creature"];
    if (!types.includes("creature")) return 12;
    const kws = Array.isArray(tok.keywords) ? Object.fromEntries(tok.keywords.map((k) => [k, true])) : tok.keywords || {};
    return this.cValue({ power: this.amt(tok.power ?? 1, E), toughness: this.amt(tok.toughness ?? 1, E), keywords: kws, abilities: tok.abilities || [] }) * 0.9;
  }

  evalEffect(e, E, depth) {
    if (!e || typeof e !== "object") return 0;
    const p = E.p;
    const objsOf = (ref) => this.ids(ref, E).filter((id) => !isPid(id)).map((id) => this.O(id)).filter(Boolean);
    const plOf = (ref) => this.playersOfIds(this.ids(ref, E));
    const T0 = { ref: "target", i: 0 };
    switch (e.op) {
      case "damage": {
        const n = this.amt(e.amount, E);
        if (n <= 0) return 0;
        let src = E.src;
        if (e.from != null) { const f = objsOf(e.from)[0]; if (!f) return 0; src = f; }
        let v = 0;
        const to = this.ids(e.to ?? T0, E);
        const per = e.divided && to.length > 1 ? Math.max(1, Math.floor(n / to.length)) : n;
        for (const id of to) v += this.dmgValue(id, per, E, src);
        return v;
      }
      case "destroy": return objsOf(e.what ?? T0).reduce((s, o) => s + this.removalValue(o, "destroy", E), 0);
      case "exile": return objsOf(e.what ?? T0).reduce((s, o) => s + this.removalValue(o, e.until ? "temp" : "exile", E), 0);
      case "bounce": return objsOf(e.what ?? T0).reduce((s, o) => s + this.removalValue(o, "bounce", E), 0);
      case "sacrificeIt": return objsOf(e.what ?? "self").reduce((s, o) => s + this.removalValue(o, "sac", E), 0);
      case "sacrifice": {
        const n = Math.max(1, this.amt(e.amount ?? 1, E));
        let v = 0;
        for (const q of plOf(e.who ?? "you")) {
          let c = [];
          try { c = this.g.find(e.filter ?? { types: ["creature"] }, { source: E.src, you: q }).filter((o) => o.controller === q && o.zone === "battlefield"); } catch { c = []; }
          c = c.filter((o) => !(E.src && o.id === E.src.id && E.onStack === false));
          const loss = c.map((o) => this.objValue(o)).sort((a, b) => a - b).slice(0, n).reduce((a, b) => a + b, 0);
          v += q === p ? -loss * 0.85 : loss * 0.9;
        }
        return v;
      }
      case "draw": {
        const n = Math.max(0, this.amt(e.amount ?? 1, E));
        let v = 0;
        for (const q of plOf(e.who ?? "you")) {
          const lib = this.st.players[q].library.length;
          if (q === p) v += lib <= n + 2 ? -n * 40 : n * 21;
          else v -= lib <= n ? -500 : n * 18;
        }
        return v;
      }
      case "discard": {
        let v = 0;
        for (const q of plOf(e.who ?? "you")) {
          const h = this.st.players[q].hand.length;
          const n = e.amount === "all" || e.amount === "hand" ? h : Math.min(h, this.amt(e.amount ?? 1, E));
          v += q === p ? -n * 11 : n * 13;
        }
        return v;
      }
      case "mill": {
        const n = this.amt(e.amount ?? 1, E);
        let v = 0;
        for (const q of plOf(e.who ?? "you")) { const lib = this.st.players[q].library.length; v += q === p ? (lib < n + 5 ? -n * 20 : -n * 0.3) : (lib <= n ? 400 : n * 0.8); }
        return v;
      }
      case "gainLife": { const n = this.amt(e.amount, E); return plOf(e.who ?? "you").reduce((s, q) => s + (q === p ? n * this.lifeW(q) * 0.7 : -n * 0.8), 0); }
      case "loseLife": { const n = this.amt(e.amount, E); return plOf(e.who ?? "you").reduce((s, q) => s + (q === p ? -n * this.lifeW(q) : n * this.dmgW(q, n)), 0); }
      case "createToken": {
        const n = Math.max(0, this.amt(e.amount ?? 1, E));
        let tv;
        if (e.copyOf != null) {
          const src = objsOf(e.copyOf)[0];
          tv = src ? this.objValue(src) * 0.9 : 0;
          // a copy of a legendary permanent we already control just dies to the legend rule
          if (src && !e.nonLegendary && (src.c.supertypes || []).includes("legendary")) return plOf(e.who ?? "you").reduce((s, q) => s + (this.ctrlBf(q).some((x) => x.c.name === src.c.name) ? 0 : q === p ? tv : -tv), 0);
        }
        else tv = this.tokenValue(e.token, E);
        return plOf(e.who ?? "you").reduce((s, q) => s + (q === p ? n * tv : -n * tv), 0);
      }
      case "addCounters": {
        const n = this.amt(e.amount ?? 1, E);
        const kind = e.kind || "+1/+1";
        let v = 0;
        for (const id of this.ids(e.what ?? "self", E)) {
          if (isPid(id)) { const q = pidx(id); const bad = kind === "poison" ? 18 * n : 3 * n; v += q === p ? -bad : bad; continue; }
          const o = this.O(id);
          if (!o || o.zone !== "battlefield") continue;
          const mine = o.controller === p;
          let w;
          if (kind === "-1/-1") { const rem = num(o.c.toughness) - (o.damage | 0); w = -(n >= rem ? this.objValue(o) : n * 9); }
          else if (kind === "+1/+1") w = this.isCre(o) ? n * 13 : 1;
          else if (kind === "loyalty") w = n * 8;
          else w = n * 3;
          v += mine ? w : -w;
        }
        return v;
      }
      case "removeCounters": return 0;
      case "pump": {
        const pw = this.amt(e.power ?? 0, E), tg = this.amt(e.toughness ?? 0, E);
        const lasting = e.until && e.until !== "endOfTurn";
        let v = 0;
        for (const o of objsOf(e.what ?? T0)) {
          if (o.zone !== "battlefield" || !this.isCre(o)) continue;
          const mine = o.controller === p;
          const rem = num(o.c.toughness) - (o.damage | 0);
          let w;
          if (tg < 0 && rem + tg <= 0 && !this.kw(o, "indestructible")) w = -this.objValue(o);
          else w = lasting ? (pw * 10 + tg * 6 + asArr(e.keywords).length * 8) : (pw + tg) * 0.6 + asArr(e.keywords).length * 0.8;
          v += mine ? w : -w;
        }
        return v;
      }
      case "gainControl": return objsOf(e.what ?? T0).reduce((s, o) => s + (o.controller === p ? 0 : this.objValue(o) * (e.until ? (this.isCre(o) && !o.tapped && this.myTurnFor(p) ? 0.25 + num(o.c.power) * 0.02 : 0.05) : 1.9)), 0);
      case "tap": return objsOf(e.what ?? T0).reduce((s, o) => s + (o.controller === p ? -2 : this.isCre(o) && !o.tapped ? 4 : 1), 0);
      case "untap": return objsOf(e.what ?? T0).reduce((s, o) => s + (o.controller === p ? (o.tapped ? 2 : 0) : -1), 0);
      case "fight": case "bite": {
        const a = objsOf(e.a ?? T0)[0];
        const bs = objsOf(e.b ?? { ref: "target", i: 1 });
        if (!a || !bs.length || !this.isCre(a)) return 0;
        let v = 0;
        for (const b of bs) {
          if (!this.isCre(b)) { if (isPid(b?.id)) continue; continue; }
          const pa = Math.max(0, this.pt(a, E).pw);
          v += this.dmgValue(b.id, pa, E, a);
          if (e.op === "fight") v += this.dmgValue(a.id, Math.max(0, this.pt(b, E).pw), E, b);
        }
        if (e.op === "bite") for (const id of this.ids(e.b ?? { ref: "target", i: 1 }, E)) if (isPid(id)) v += this.dmgValue(id, Math.max(0, this.pt(a, E).pw), E, a);
        return v;
      }
      case "search": {
        if (!plOf(e.who ?? "you").includes(p)) return 0;
        const n = Math.max(1, this.amt(e.max ?? 1, E));
        const f = e.filter || {};
        const isLandSearch = (f.types || []).includes("land") || (f.supertypes || []).includes("basic") || (f.subtypes || []).some((s) => ["plains", "island", "swamp", "mountain", "forest"].includes(s));
        const to = asArr(e.to || "hand");
        if (isLandSearch) return n * (to.includes("battlefield") ? (this.landCount(p) < 8 ? 26 : 8) : this.landCount(p) < 6 ? 16 : 6);
        return n * 27;
      }
      case "scry": case "surveil": return 2.5 * this.amt(e.amount ?? 1, E);
      case "counter": return objsOf(e.what ?? T0).filter((o) => o.zone === "stack").reduce((s, o) => s + (o.controller === p ? -this.stackValue(o) : this.stackValue(o)), 0);
      case "copySpell": return objsOf(e.what ?? T0).filter((o) => o.zone === "stack").reduce((s, o) => s + (o.controller === p ? this.stackValue(o) * 0.9 : this.stackValue(o) * 0.5), 0);
      case "move": {
        const to = e.to || "graveyard";
        let v = 0;
        for (const o of objsOf(e.what ?? T0)) {
          if (o.zone === "battlefield") {
            const kind = to === "hand" ? "bounce" : to === "library" ? "exile" : to === "battlefield" ? "temp" : to === "exile" ? "exile" : "destroy";
            v += this.removalValue(o, kind, E);
          } else if (o.zone === "graveyard" || o.zone === "exile") {
            const mine = o.owner === p;
            const gain = to === "battlefield" ? ((o.def?.types || []).some((t) => ["creature", "artifact", "enchantment", "planeswalker"].includes(t)) ? this.cValue(o.c) : 10)
              : to === "hand" ? this.cardValue(o) * 0.8 : to === "library" ? 2 : to === "exile" ? 3 : 0;
            const controlled = to === "battlefield" && (e.control === "you" || (e.control == null && mine) || mine);
            v += controlled ? gain : (to === "battlefield" ? -gain : mine ? gain * 0.5 : -gain * 0.3);
          }
        }
        return v;
      }
      case "ringTempts": return plOf(e.who ?? "you").reduce((s, q) => s + (q === p ? (this.ctrlBf(p).some((o) => this.isCre(o)) ? 15 : 7) : -10), 0);
      case "amass": return this.amt(e.amount ?? 1, E) * 12;
      case "explore": return 14;
      case "proliferate": return 8;
      case "exileTop": return plOf(e.who ?? "you").includes(p) ? this.amt(e.amount ?? 1, E) * 12 : 0;
      case "lookTop": return this.amt(e.take ?? 1, E) * 19 + 2;
      case "extraTurn": return plOf(e.who ?? "you").reduce((s, q) => s + (q === p ? 180 : -180), 0);
      case "extraCombat": return 55;
      case "win": return plOf(e.who ?? "you").includes(p) ? 100000 : -100000;
      case "lose": return plOf(e.who ?? "you").reduce((s, q) => s + (q === p ? -100000 : 100000), 0);
      case "if": {
        let c = false;
        try { c = this.g.evalCond(e.cond, this.ectx(E)); } catch { c = false; }
        return this.evalEffects(c ? e.then : e.else || [], E, depth + 1);
      }
      case "may": {
        const v = this.evalEffects(e.effects || [], E, depth + 1);
        const who = e.who ? plOf(e.who) : [p];
        const chooser = who[0] ?? p;
        if (chooser !== p) return v < 0 ? v : 0;
        const cost = e.cost ? this.costPenalty(e.cost, E.src, E) : 0;
        const els = e.else ? this.evalEffects(e.else, E, depth + 1) : 0;
        return Math.max(v - cost, els, 0);
      }
      case "modes": {
        const vals = asArr(e.modes).map((m) => this.evalEffects(m.effects || [], { ...E, targets: this.bestTargetsFor(m.targets || [], m.effects || [], E).targets }, depth + 1)).sort((a, b) => b - a);
        const min = e.min ?? 1, max = e.max ?? min;
        let v = 0;
        for (let i = 0; i < Math.min(max, vals.length); i++) if (i < min || vals[i] > 0) v += vals[i];
        return v;
      }
      case "forEach": {
        let v = 0;
        for (const id of this.ids(e.over ?? e.what, E).slice(0, 12)) v += this.evalEffects(e.effects || [], { ...E, it: [id] }, depth + 1);
        return v;
      }
      case "delayed": return 0.5 * this.evalEffects(e.effects || [], E, depth + 1);
      case "until": {
        const s = e.static || {};
        let ids = [];
        if (s.affects && typeof s.affects === "object" && s.affects.ref) ids = this.ids(s.affects, E);
        else if (s.affects && typeof s.affects === "object") { try { ids = this.g.find(s.affects, { source: E.src, you: p }).map((o) => o.id); } catch { ids = []; } }
        else if (s.affects === "self" || s.affects == null) ids = E.src ? [E.src.id] : [];
        let v = 0;
        if (s.type === "lifeCantChange" || s.type === "playerProtection") return this.threatened(p) ? 140 : -4; // Teferi's Protection: save it for lethal
        if (s.type === "cantPrevent") return 0;
        for (const id of ids) {
          const o = this.O(id);
          if (!o || o.zone !== "battlefield") continue;
          const mine = o.controller === p;
          let w = 0;
          if (s.type === "cantBlock") w = mine ? 0 : 5;
          else if (s.type === "cantAttack") w = mine ? -3 : 3;
          else if (s.type === "cantBeBlocked") w = mine ? 6 : -6;
          else if (s.type === "pump") w = mine ? (this.amt(s.power ?? 0, E) + this.amt(s.toughness ?? 0, E)) * 0.6 + asArr(s.keywords).length : 0;
          else w = 1;
          v += w;
        }
        return v;
      }
      case "animate": return 3;
      case "transform": return 5;
      case "attach": return 0;
      case "copyAbility": {
        let v = 0;
        for (const id of this.ids(e.what ?? { ref: "event", what: "ability" }, E)) { const a = this.O(id); if (a && a.zone === "stack") v += (a.controller === p ? 0.9 : -0.9) * this.stackValue(a); }
        return v;
      }
      case "phaseOut": {
        const mine = objsOf(e.what ?? "self").filter((o) => o.controller === p);
        const tot = mine.reduce((n, o) => n + (this.isLand(o) ? 6 : this.objValue(o)), 0);
        return this.threatened(p) ? tot * 0.25 : -tot * 0.15;
      }
      case "_craftReturn": {
        const src = E.src;
        const back = src?.def?.faces?.[1];
        return back ? this.permSpellValue(src, back, { p }) + (src.zone === "battlefield" ? this.objValue(src) : 0) : 0; // the card itself comes back
      }
      default: return 0;
    }
  }
  myTurnFor(p) { return this.st.active === p && (this.st.step === "main1" || this.st.step === "beginCombat"); }
  /** Is player p facing lethal (or near-lethal) damage this turn from the creatures attacking them / able to? */
  threatened(p) {
    const pl = this.st.players[p];
    if (!pl) return false;
    const cb = this.st.combat;
    let inc = 0;
    if (cb && cb.attackers.length) {
      for (const a of cb.attackers) { if (this.g.defenderPlayer(a.defender) !== p) continue; const o = this.O(a.obj); if (o && !(a.blockers || []).length) inc += Math.max(0, num(o.c.power)) * (this.kw(o, "double strike") ? 2 : 1); }
    } else if (this.st.active !== p) {
      for (const o of this.bf) if (o.controller === this.st.active && this.isCre(o) && !o.tapped && !this.kw(o, "defender")) inc += Math.max(0, num(o.c.power));
    }
    return inc >= pl.life || (pl.life <= 6 && inc >= pl.life - 1);
  }

  /** Rough price of paying a Cost (non-mana parts weigh most; mana is cheap but not free). */
  costPenalty(cost, src, E = {}) {
    if (!cost) return 0;
    if (typeof cost === "string") cost = { mana: cost };
    let v = 0;
    if (cost.mana) v += costCmc(parseManaCost(cost.mana)) * 2;
    if (cost.life != null) v += (cost.life === "x" ? 3 : num(cost.life)) * this.lifeW(this.p);
    if (cost.sacSelf && src && src.zone === "battlefield") v += this.objValue(src);
    if (cost.sac) {
      const n = num(cost.sacCount ?? 1) || 1;
      let c = [];
      try { c = this.g.costSacCands(this.p, cost.sac, src); } catch { c = []; }
      const vals = c.map((o) => this.objValue(o) - num(o.c?.power) * 0.5).map((v) => Math.max(0, v)).sort((a, b) => a - b);
      v += vals.length >= n ? vals.slice(0, n).reduce((a, b) => a + b, 0) : 999;
    }
    if (cost.discard) v += 12 * (typeof cost.discard === "number" ? cost.discard : 1);
    if (cost.discardSelf && src) v += 6;
    if (cost.exileFromGraveyard) v += 2 * num(cost.exileFromGraveyard);
    if (cost.tapOther) v += 4 * (num(cost.tapOtherCount ?? 1) || 1);
    if (cost.removeCounters) v += 6;
    if (cost.exileSelf && src && src.zone === "battlefield") v += this.objValue(src);
    if (cost.craftWith) {
      let c = [];
      try { c = this.g.craftCands(this.p, cost.craftWith, src); } catch { c = []; }
      const vals = c.map((o) => (o.zone === "battlefield" ? this.objValue(o) : this.cardValue(o) * 0.25)).sort((a, b) => a - b);
      v += vals.length ? vals[0] : 999;
    }
    if (Array.isArray(cost.oneOf)) v += Math.min(...cost.oneOf.map((c) => this.costPenalty(c, src, E)));
    return v;
  }

  // ---------------------------------------------------------------------------------------------- targets
  /** Which way an effect list points at target index i: "harm" | "benefit" | null. */
  simpleRole(effects, i) {
    let harm = 0, ben = 0;
    const isT = (r) => {
      if (r == null) return false;
      if (r === "target") return i === 0;
      if (Array.isArray(r)) return r.some(isT);
      return typeof r === "object" && r.ref === "target" && (r.i | 0) === i;
    };
    const walk = (list) => {
      for (const e of asArr(list)) {
        if (!e || typeof e !== "object") continue;
        switch (e.op) {
          case "damage": if (isT(e.to)) harm++; if (isT(e.from)) ben++; break;
          case "destroy": case "exile": case "bounce": case "sacrificeIt": case "tap": case "gainControl": case "counter": case "removeCounters":
            if (isT(e.what)) { if (e.op === "exile" && e.until) ben += 0; else harm++; } break;
          case "discard": case "mill": case "loseLife": case "sacrifice": case "lose": if (isT(e.who)) harm++; break;
          case "draw": case "gainLife": case "search": case "scry": case "ringTempts": case "addMana": case "extraTurn": if (isT(e.who)) ben++; break;
          case "pump": if (isT(e.what)) { const pw = typeof e.power === "number" ? e.power : 0, tg = typeof e.toughness === "number" ? e.toughness : 0; if (pw + tg < 0 || tg < 0) harm++; else ben++; } break;
          case "addCounters": if (isT(e.what)) { if (e.kind === "-1/-1") harm++; else ben++; } break;
          case "untap": case "copySpell": case "animate": case "explore": case "transform": if (isT(e.what)) ben++; break;
          case "attach": if (isT(e.to)) ben++; break;
          case "fight": case "bite": if (isT(e.a)) ben++; if (isT(e.b)) harm++; break;
          case "createToken": if (isT(e.copyOf)) ben++; break;
          case "move": if (isT(e.what)) { if (e.to === "battlefield" || e.to === "hand") ben++; else harm++; } break;
          case "until": { const s = e.static || {}; if (isT(s.affects)) { if (s.type === "cantBlock" || s.type === "cantAttack") harm++; else ben++; } break; }
          case "_aura": break;
          case "_mutate": if (i === 0) ben++; break;
          default: break;
        }
        if (e.then) walk(e.then);
        if (e.else) walk(e.else);
        if (e.effects) walk(e.effects);
      }
    };
    walk(effects);
    if (harm > ben) return "harm";
    if (ben > harm) return "benefit";
    return null;
  }

  auraRole(fd) {
    let harm = 0, ben = 0;
    for (const ab of fd.abilities || []) {
      const s = ab.effect;
      if (ab.kind !== "static" || !s) { if (ab.kind === "triggered" || ab.kind === "activated") ben += 0.5; continue; }
      if (s.affects !== "enchanted" && s.affects !== "attached") continue;
      if (s.type === "pump") { const t = num(s.power) + num(s.toughness); if (t < 0) harm += 2; else ben += 1 + asArr(s.keywords).length; }
      else if (s.type === "cantAttack" || s.type === "cantBlock" || s.type === "doesntUntap") harm += 2;
      else ben += 1;
    }
    return harm > ben ? "harm" : "benefit";
  }

  candValueForRole(id, role, E) {
    if (isPid(id)) { const q = pidx(id); const mine = q === E.p; return role === "harm" ? (mine ? -100 : 30) : role === "benefit" ? (mine ? 30 : -30) : (mine ? -1 : 1); }
    const o = this.O(id);
    if (!o) return -999;
    const ctrl = o.zone === "battlefield" || o.zone === "stack" ? o.controller : o.owner;
    const mine = ctrl === E.p;
    const v = this.objValue(o);
    if (role === "harm") return mine ? -v : v;
    if (role === "benefit") return mine ? v : -v;
    return mine ? -v * 0.2 : v * 0.2;
  }

  /** Best targets for a list of specs: { targets:[[ids]], value }. `fixed` = indices already chosen. */
  bestTargetsFor(specs, effects, E, opts = {}) {
    const targets = [];
    const roles = [];
    const isAura = asArr(effects).some((e) => e && e.op === "_aura");
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i] || {};
      let cands = [];
      try { cands = this.g.targetCandidates(spec, E.src, E.p, this.ectx(E)); } catch { cands = []; }
      const role = isAura ? this.auraRole(opts.fd || E.src?.def || {}) : this.simpleRole(effects, i) || this.filterRole(spec);
      roles.push(role);
      const min = spec.min == null ? 1 : this.amt(spec.min, E);
      const max = Math.min(spec.max == null ? Math.max(1, min) : this.amt(spec.max, E), cands.length);
      const scored = cands.map((id) => ({ id, s: this.candValueForRole(id, role, E) })).sort((a, b) => b.s - a.s);
      const pick = scored.filter((x, k) => k < max && (k < min || x.s > 0)).map((x) => x.id);
      targets.push(pick);
    }
    if (isAura) {
      const role = roles[0];
      const t = targets[0]?.[0];
      let v = 0;
      if (t) { const o = this.O(t); const mine = o && o.controller === E.p; v = role === "harm" ? (mine ? -this.objValue(o) : this.objValue(o) * 0.7) : (mine ? 12 + this.objValue(o) * 0.25 : -this.objValue(o)); }
      return { targets, value: v, roles };
    }
    // refine each spec by simulation with the others fixed
    if (!opts.noRefine && effects && asArr(effects).length) {
      for (let i = 0; i < specs.length; i++) {
        const spec = specs[i] || {};
        let cands = [];
        try { cands = this.g.targetCandidates(spec, E.src, E.p, this.ectx(E)); } catch { cands = []; }
        if (cands.length < 2 && targets[i].length === Math.min(1, cands.length)) continue;
        const min = spec.min == null ? 1 : this.amt(spec.min, E);
        const max = Math.min(spec.max == null ? Math.max(1, min) : this.amt(spec.max, E), cands.length);
        const base = this.evalEffects(effects, { ...E, targets: targets.map((t, k) => (k === i ? [] : t)) });
        const scored = cands.slice(0, 40).map((id) => ({ id, s: this.evalEffects(effects, { ...E, targets: targets.map((t, k) => (k === i ? [id] : t)) }) - base + this.candValueForRole(id, roles[i], E) * 0.01 }))
          .sort((a, b) => b.s - a.s);
        targets[i] = scored.filter((x, k) => k < max && (k < min || x.s > 0.5)).map((x) => x.id);
      }
    }
    const value = this.evalEffects(effects, { ...E, targets });
    return { targets, value, roles };
  }
  filterRole(spec) {
    const w = spec?.what;
    if (w && typeof w === "object") {
      if (w.controller === "you") return "benefit";
      if (w.controller === "opponent") return "harm";
    }
    if (w === "opponent") return "harm";
    return null;
  }

  // ---------------------------------------------------------------------------------------------- mulligan
  mulligan() {
    const hand = this.hand();
    const n = hand.length;
    const lands = hand.filter((o) => o.def?.types?.includes("land")).length;
    const ramp = hand.filter((o) => !o.def?.types?.includes("land") && num(o.def?.cmc) <= 2 && (o.c?.abilities || []).some((a) => a.mana)).length;
    const m = this.req.mulligans | 0;
    if (m >= 2 || n <= 5) return { keep: true };
    const eff = lands + Math.min(ramp, 1);
    if (this.level === 0) return { keep: lands >= 1 && lands <= 6 };
    if (m === 0) {
      const strict = this.req.free;
      if (eff >= 3 && lands <= 5) return { keep: true };
      if (eff === 2 && lands >= 2 && !strict) return { keep: true };
      if (eff === 2 && lands >= 2) return { keep: hand.filter((o) => num(o.def?.cmc) <= 3 && !o.def?.types?.includes("land")).length >= 2 };
      return { keep: false };
    }
    return { keep: lands >= 2 && lands <= 5 };
  }

  // ---------------------------------------------------------------------------------------------- priority
  fingerprint() {
    const st = this.st;
    let s = `${st.stack.length}|${st.battlefield.length}|${this.me.hand.length}|${this.me.graveyard.length}|${this.me.life}`;
    for (const k of ["W", "U", "B", "R", "G", "C"]) s += this.me.mana[k] | 0;
    let tapped = 0;
    for (const o of this.ctrlBf(this.p)) if (o.tapped) tapped++;
    return s + "|" + tapped;
  }
  actKey(a) { return `${a.type}|${a.obj}|${a.ability ?? ""}|${a.variant ?? ""}`; }

  priority() {
    const req = this.req;
    const st = this.st;
    this.memo.intent = null;
    const acts = [];
    req.actions.forEach((a, i) => { if (a.type !== "special" && !a.mana) acts.push({ a, i }); });
    if (!acts.length) return { type: "pass" };
    const fp = this.fingerprint();
    const stepKey = `${st.turn}|${st.step}|${st.stack.length}`;
    const last = this.memo.last;
    if (last && last.fp === fp && last.step === stepKey) this.memo.banned.add(stepKey + "|" + last.key); // the action did nothing: don't retry it this step
    const usable = acts.filter(({ a }) => !this.memo.banned.has(stepKey + "|" + this.actKey(a)));
    if (!usable.length) return { type: "pass" };

    let best = null;
    const consider = (cand) => { if (cand && cand.score > (best?.score ?? -Infinity)) best = cand; };
    if (st.stack.length) {
      const top = this.O(st.stack[st.stack.length - 1]);
      if (!top || top.controller === this.p) return { type: "pass" };
      if (this.level === 0 && !this.roll(0.3)) return { type: "pass" };
      for (const x of usable) consider(this.respondScore(x, top));
    } else {
      for (const x of usable) consider(this.actionScore(x));
      const trick = this.combatTrick(usable);
      if (trick) consider(trick);
    }
    const threshold = 4;
    if (!best || best.score <= threshold) { this.memo.last = null; return { type: "pass" }; }
    if (this.level === 0 && this.roll(0.08)) { this.memo.last = null; return { type: "pass" }; }
    const key = this.actKey(best.a);
    this.memo.counts.set(key, (this.memo.counts.get(key) || 0) + 1);
    this.memo.last = { key, fp, step: stepKey };
    this.memo.intent = best.intent ? { src: best.a.obj, ...best.intent } : null;
    return { type: "act", index: best.i };
  }

  /** Def + face for a cast action. */
  castDef(a) {
    const o = this.O(a.obj);
    if (!o) return null;
    const d = o.def;
    let fd = d;
    if ((a.variant === "adventure" || a.variant === "face1") && d.faces && d.faces[1]) fd = d.faces[1];
    return { o, fd };
  }
  isPermDef(fd) { return (fd.types || []).some((t) => ["creature", "artifact", "enchantment", "planeswalker", "battle"].includes(t)); }
  instantSpeed(fd) { return (fd.types || []).includes("instant") || !!fd.keywords?.flash; }

  /** Value of casting a permanent spell (for E.p). */
  permSpellValue(o, fd, E0 = {}) {
    const p = E0.p ?? this.p;
    const types = fd.types || [];
    let v = 0;
    const copyAb = (fd.abilities || []).find((a) => a.kind === "static" && a.effect?.type === "asEntersCopy");
    if (copyAb) { // "enter as a copy of …": worth the best thing it can copy
      let best = -60;
      try { for (const x of this.g.copyCandidates({ id: null }, copyAb.effect, p)) best = Math.max(best, this.objValue(x) + 8); } catch { /* */ }
      return best;
    }
    if (types.includes("creature")) {
      let pw = fd.power, tg = fd.toughness;
      const sp = (fd.abilities || []).find((a) => a.kind === "static" && a.effect && (a.effect.type === "setPT" || a.effect.type === "setBasePT"));
      if (sp) { pw = this.amt(sp.effect.power, { p, src: o }); tg = this.amt(sp.effect.toughness, { p, src: o }); }
      const ewc = (fd.abilities || []).filter((a) => a.kind === "static" && a.effect?.type === "entersWithCounters" && (a.effect.kind || "+1/+1") === "+1/+1").reduce((t, a) => t + this.amt(a.effect.amount ?? 1, { p, src: o, x: o.x | 0 }), 0);
      if (!sp && num(tg) + ewc <= 0) return -60; // would die on arrival (e.g. a 0/0 whose "enters as a copy" isn't automated)
      v = this.cValue({ power: num(pw) + ewc, toughness: Math.max(1, num(tg) + ewc), keywords: fd.keywords || {}, abilities: fd.abilities || [] });
    } else if (types.includes("planeswalker")) v = 60 + num(fd.loyalty) * 9;
    else if (types.includes("land")) v = 10;
    else {
      v = 18;
      const sub = fd.subtypes || [];
      if (sub.includes("equipment")) v += this.ctrlBf(p).some((x) => this.isCre(x)) ? 18 : 2;
    }
    for (const ab of fd.abilities || []) {
      if (!ab) continue;
      if (ab.kind === "activated" && ab.mana) v += this.landCount(p) < 7 ? 22 : 8;
      else if (ab.kind === "triggered" && ab.on && (ab.on.event === "enters") && (ab.on.who === "self" || ab.on.who == null)) {
        const E = { p, src: o, x: o.x | 0 };
        const bt = this.bestTargetsFor(ab.targets || [], ab.effects || [], E);
        let ev = bt.value;
        if (ab.modes && ab.modes.modes) ev += Math.max(0, ...ab.modes.modes.map((m) => this.bestTargetsFor(m.targets || [], m.effects || [], E).value));
        v += ab.optional ? Math.max(0, ev) : ev;
      } else if (ab.kind === "triggered" && ab.on && ab.on.event === "beginStep" && !ab.condition) { // recurring value (upkeep drains etc.)
        v += Math.max(0, this.evalEffects(ab.effects || [], { p, src: o })) * 2.5;
      } else if (ab.kind === "static" && ab.effect) {
        const s = ab.effect;
        if (s.type === "pump" && s.affects && typeof s.affects === "object") {
          let n = 0;
          try { n = this.g.find(s.affects, { source: o, you: p }).filter((x) => x.controller === p).length; } catch { n = 0; }
          v += n * (num(s.power) + num(s.toughness)) * 5 + 4;
        } else if (s.type === "entersTapped") v -= 2;
        else if (s.type === "doubleTriggers" || s.type === "damageMod") v += 22;
        else if (s.type === "costMod") v += num(s.amount) < 0 ? 12 : 4;
        else v += 6;
      }
    }
    // legend rule: don't cast a second copy of a legendary permanent we already control
    if ((fd.supertypes || []).includes("legendary") && this.ctrlBf(p).some((x) => x.c.name === fd.name)) v -= 1000;
    return v;
  }

  /** Score a priority action with an empty stack. Returns {a, i, score, intent} or null. */
  actionScore({ a, i }) {
    const st = this.st;
    const myTurn = this.myTurn();
    const main = this.isMain() && myTurn;
    const step = st.step;
    const L = this.level;
    const noise = L === 0 ? 0.6 + this.rng() * 0.8 : 1;
    const key = this.actKey(a);
    const used = this.memo.counts.get(key) || 0;

    if (a.type === "land") {
      if (!main) return null;
      return { a, i, score: 1000 + this.landScore(a) };
    }
    if (a.type === "cast") {
      const cd = this.castDef(a);
      if (!cd) return null;
      const { o, fd } = cd;
      { const m1r = m1CastScore(this, a, i, o, fd); if (m1r !== undefined) return m1r; }
      if (a.variant === "mutate") return this.mutateScore(a, i, o, fd);
      if (a.variant === "morph") {
        if (!main) return null;
        const v = this.cValue({ power: 2, toughness: 2, keywords: {}, abilities: [] }) + 6 - (a.sacForMana ? 200 : 0);
        return v > 0 ? { a, i, score: v * 0.7 * noise } : null; // usually below casting it face up
      }
      if (/lifeCantChange|playerProtection/.test(JSON.stringify(fd.spell?.effects || []))) { // Teferi's Protection: only when facing lethal
        if (!this.threatened(this.p)) return null;
        return { a, i, score: 500 };
      }
      const inst = this.instantSpeed(fd);
      const perm = this.isPermDef(fd) && a.variant !== "adventure";
      const cmc = num(fd.cmc);
      let score, intent = null;
      if (perm) {
        const isAura = (fd.subtypes || []).includes("aura");
        score = this.permSpellValue(o, fd);
        if (isAura) {
          const E = { p: this.p, src: o };
          const spec = this.g.targetSpecsFor(o, fd, a.variant || "normal");
          const bt = this.bestTargetsFor(spec, [{ op: "_aura" }], E, { fd });
          score = 10 + bt.value;
          intent = { targets: bt.targets };
        }
        if (a.variant === "commander") score += 22 - (this.me.commanderCasts[o.id] | 0) * 6;
        const addC = fd.additionalCost || (a.variant === "adventure" || a.variant === "face1" ? null : o.def.additionalCost);
        if (addC) score -= this.costPenalty({ ...addC, mana: null }, o);
        if (!myTurn && !(step === "end" || (step === "declareAttackers" && this.st.combat))) {
          // flash permanents: best at the opponent's end step, or as a surprise blocker
          if (L >= 1) return null;
          score *= 0.3;
        }
        if (myTurn && !this.isMain()) return null;
        score += cmc * 2.5;
      } else {
        const E = { p: this.p, src: o, kicked: a.variant === "kicked", x: 0 };
        const cost = this.g.spellCost ? safe(() => this.g.spellCost(this.p, o, { variant: a.variant || "normal", face: a.variant === "adventure" || a.variant === "face1" ? 1 : 0 })) : null;
        if (cost && cost.x) E.x = Math.max(0, Math.floor((this.manaNow() - costCmc(cost)) / cost.x));
        const sp = fd.spell || {};
        let specs = sp.targets || [];
        let effects = sp.effects || [];
        if (a.variant === "overload") { specs = []; effects = overloadEffects(effects, sp.targets || []); }
        const bt = this.bestTargetsFor(specs, effects, E);
        score = bt.value;
        intent = { targets: bt.targets, x: E.x };
        if (sp.modes && sp.modes.modes) {
          const mv = this.bestModes(sp.modes, E);
          score += mv.value;
          intent.modes = mv.modes;
          intent.modeTargets = mv.targets;
        }
        if (a.variant === "adventure") score += 12;
        const addC = fd.additionalCost || (a.variant === "adventure" || a.variant === "face1" ? null : o.def.additionalCost);
        if (addC) { const pen = this.costPenalty({ ...addC, mana: null }, o); score -= pen; intent.sacPenalty = pen; }
        // reactive-only spells are held for responses
        const reactive = hasOp(effects, "counter") || (sp.modes?.modes || []).every((m) => hasOp(m.effects, "counter")) && sp.modes;
        if (reactive) return null;
        const category = spellCategory(effects, sp.modes);
        if (category === "pump") return null; // combat tricks are handled by combatTrick()
        if (!inst && !main) return null;
        if (inst) {
          const combatStep = step === "declareAttackers" || step === "declareBlockers";
          if (myTurn) {
            if (!main) return null; // never on our own upkeep/draw/combat/end (tricks are handled by combatTrick)
            // normal/hard hold instants for the opponent's turn (mana stays open), except a big removal pre-combat
            if (L >= 1 && !(category === "removal" && score >= 50 && step === "main1")) return null;
          } else if (!(step === "end" || (combatStep && category === "removal" && this.st.combat))) {
            if (L >= 1) return null;
            score *= 0.4;
          }
        }
        score -= cmc * 1.5; // card cost
        score += Math.min(cmc, 6);
      }
      if (a.sacForMana) score -= this.sacForManaPenalty(a.sacForMana);
      if (score <= 0) return null;
      return { a, i, score: score * noise, intent };
    }
    if (a.type === "activate" && typeof a.variant === "string" && a.variant.startsWith("m1:")) return m1SpecialScore(this, a, i);
    if (a.type === "activate" && a.variant === "faceUp") {
      const o = this.O(a.obj);
      if (!o || !o.faceDown) return null;
      const up = this.permSpellValue(o, o.def, { p: this.p }) - this.cValue({ power: 2, toughness: 2, keywords: {}, abilities: [] });
      if (up <= 0) return null;
      if (!(main || (!myTurn && step === "end") || (step === "declareBlockers"))) return null;
      return { a, i, score: 20 + up * 0.5 };
    }
    if (a.type === "activate") {
      const o = this.O(a.obj);
      if (!o) return null;
      const ab = o.c.abilities?.[a.ability];
      if (!ab) return null;
      const cap = ab.cost?.sac || ab.cost?.sacSelf ? 2 : ab.loyalty ? 1 : 3;
      if (used >= cap && a.variant !== "equip") return null;
      if (a.variant === "equip") return this.equipScore(a, i, o);
      if (a.variant === "cycle") return this.cycleScore(a, i, o);
      if (ab.synthetic === "crew") { // m2: crew a Vehicle on my turn before attackers (main 1 / beginning of combat), once
        if (!myTurn || !(step === "main1" || step === "beginCombat") || this.isCre(o) || o.sick || o.tapped) return null;
        if (num(o.def?.power) <= 0) return null;
        return { a, i, score: 24 + num(o.def?.power) * 2 };
      }
      const E = { p: this.p, src: o, x: 0 };
      let sacVictim = null;
      if (ab.cost?.sac) {
        const cands = safe(() => this.g.costSacCands(this.p, ab.cost.sac, o)) || [];
        sacVictim = cands.map((c) => ({ c, v: this.objValue(c) - num(c.c.power) * 0.5 })).sort((x, y) => x.v - y.v)[0]?.c || null;
        if (sacVictim) E.sacrificed = [sacVictim];
      }
      if (/\{X\}/i.test(ab.cost?.mana || "")) E.x = Math.max(0, this.manaNow() - costCmc(parseManaCost(ab.cost.mana)) - (ab.cost.tap && this.isLand(o) ? 1 : 0));
      if (ab.cost?.loyalty === "-x") E.x = Math.max(0, (o.counters?.loyalty | 0) - 1);
      const bt = this.bestTargetsFor(ab.targets || [], ab.effects || [], E);
      let v = bt.value;
      const intent = { targets: bt.targets, x: E.x };
      if (sacVictim) intent.sac = [sacVictim.id];
      if (ab.modes && ab.modes.modes) { const mv = this.bestModes(ab.modes, E); v += mv.value; intent.modes = mv.modes; intent.modeTargets = mv.targets; }
      if (spellCategory(ab.effects || [], ab.modes) === "pump") return null; // tricks only in combat
      if (ab.loyalty || ab.cost?.loyalty != null) {
        const n = typeof ab.cost.loyalty === "number" ? ab.cost.loyalty : -(E.x | 0);
        const loy = o.counters?.loyalty | 0;
        v += n * 5;
        if (loy + n <= 0) v -= this.objValue(o) * 0.7;
        if (!main) return null;
        return v > 0 ? { a, i, score: (v + 30) * noise, intent } : null;
      }
      v -= this.costPenalty({ ...ab.cost, mana: null }, o, E);
      const manaCost = costCmc(parseManaCost(ab.cost?.mana || ""));
      v -= manaCost * 1.2;
      // creatures that tap for an ability shouldn't do so before combat when they could attack
      if (ab.cost?.tap && this.isCre(o) && myTurn && (step === "main1" || step === "beginCombat") && !o.sick) v *= 0.3;
      // spend spare mana on abilities late: main 2, or the opponent's end step
      if (!ab.sorcery) {
        if (myTurn && !main) return null;
        if (myTurn && step === "main1") v *= 0.5;
        if (!myTurn && step !== "end" && L >= 1) return null;
      }
      if (v <= 0) return null;
      return { a, i, score: v * 0.8 * noise, intent };
    }
    return null;
  }

  /** Penalty for spending n creatures through sacrifice-for-mana sources. */
  sacForManaPenalty(n) {
    const vals = this.ctrlBf(this.p).filter((o) => this.isCre(o)).map((o) => this.objValue(o)).sort((a, b) => a - b);
    return vals.slice(0, n).reduce((x, y) => x + y, 0) + 10 * n;
  }
  /** Characteristics value of a merged permanent: top card's stats, keywords/abilities of both. */
  mergedValue(topDef, topC, under) {
    const kw = { ...(under.keywords || {}), ...(topC.keywords || {}) };
    return this.cValue({ power: topC.power, toughness: topC.toughness, keywords: kw, abilities: [...(topC.abilities || []), ...(under.abilities || [])] });
  }
  mutateScore(a, i, o, fd) {
    if (!this.isMain() || !this.myTurn()) return null;
    let hosts = [];
    try { hosts = this.g.targetCandidates({ what: { types: ["creature"], notSubtypes: ["human"], owner: "you" } }, o, this.p, { source: o, you: this.p }).map((id) => this.O(id)).filter(Boolean); } catch { hosts = []; }
    const sc = { power: num(fd.power), toughness: num(fd.toughness), keywords: fd.keywords || {}, abilities: fd.abilities || [] };
    let best = null;
    for (const h of hosts) {
      if (h.controller !== this.p) continue;
      const base = this.cValue(h.c);
      const over = this.mergedValue(fd, sc, h.c), under = this.mergedValue(h.def, h.c, sc);
      const gain = Math.max(over, under) - base;
      if (!best || gain > best.gain) best = { h, gain };
    }
    if (!best) return null;
    const trig = (fd.abilities || []).find((x) => x.kind === "triggered" && x.on?.event === "mutates");
    let tv = 0;
    if (trig) tv = Math.max(0, this.bestTargetsFor(trig.targets || [], trig.effects || [], { p: this.p, src: best.h }).value);
    const score = best.gain * 0.8 + tv + num(fd.cmc) * 1.5 - (a.sacForMana ? this.sacForManaPenalty(a.sacForMana) : 0);
    if (score <= 4) return null;
    return { a, i, score, intent: { targets: [[best.h.id]] } };
  }

  bestModes(ms, E) {
    const modes = ms.modes || [];
    const scored = modes.map((m, k) => { const bt = this.bestTargetsFor(m.targets || [], m.effects || [], E); return { k, v: bt.value, t: bt.targets }; });
    let mx = ms.max ?? ms.min ?? 1;
    if (ms.maxIf && ms.maxIf.cond) { try { if (this.g.evalCond(ms.maxIf.cond, this.ectx(E))) mx = Math.max(mx, ms.maxIf.max | 0); } catch { /* */ } }
    const min = ms.min ?? 1;
    const sorted = [...scored].sort((a, b) => b.v - a.v);
    const pick = sorted.filter((x, k) => k < mx && (k < min || x.v > 0));
    return { value: pick.reduce((s, x) => s + x.v, 0), modes: pick.map((x) => x.k), targets: Object.fromEntries(pick.map((x) => [x.k, x.t])) };
  }

  landScore(a) {
    const o = this.O(a.obj);
    if (!o) return 0;
    let d = o.def;
    if (a.variant === "face1" && d.faces?.[1]) d = d.faces[1];
    let s = 0;
    if (a.variant === "face1") s -= 25; // prefer real lands; MDFC lands only when needed
    const tapped = (d.abilities || []).some((ab) => ab.kind === "static" && ab.effect?.type === "entersTapped" && (ab.effect.affects == null || ab.effect.affects === "self") && !ab.effect.unlessPay
      && !(ab.effect.unless && safe(() => this.g.evalCond(ab.effect.unless, { source: o, you: this.p, quiet: true }))));
    const avail = this.manaNow();
    const wantNow = this.hand().some((h) => h.id !== o.id && !h.def?.types?.includes("land") && num(h.def?.cmc) === avail + 1);
    if (tapped) s += wantNow ? -10 : 8;
    // colours we lack
    const have = new Set();
    for (const src of safe(() => this.g.manaSources(this.p)) || []) for (const op of src.opts) for (const u of op.units) for (const c of u) have.add(c);
    const gives = landColors(d, this.g.identityOf ? safe(() => this.g.identityOf(this.p)) || [] : []);
    const need = new Set();
    for (const h of this.hand()) { const c = parseManaCost(h.def?.cost || ""); for (const k of ["W", "U", "B", "R", "G"]) if (c[k]) need.add(k); }
    for (const c of gives) if (need.has(c) && !have.has(c)) s += 6;
    if (!gives.length) s -= 3;
    return s;
  }

  equipScore(a, i, o) {
    const mine = this.ctrlBf(this.p).filter((c) => this.isCre(c) && c.id !== o.id);
    if (!mine.length) return null;
    const ab = o.c.abilities[a.ability];
    let cands = [];
    try { cands = this.g.targetCandidates(ab.targets?.[0] || {}, o, this.p, { source: o, you: this.p }); } catch { cands = []; }
    const scored = cands.map((id) => this.O(id)).filter(Boolean).map((c) => ({ c, s: this.attackPotential(c) })).sort((x, y) => y.s - x.s);
    if (!scored.length) return null;
    const best = scored[0];
    const host = o.attachedTo ? this.O(o.attachedTo) : null;
    if (host && host.controller === this.p && (host.id === best.c.id || this.attackPotential(host) + 15 >= best.s)) return null;
    if (!this.isMain() || !this.myTurn()) return null;
    if (this.st.step === "main2" && host) return null;
    return { a, i, score: 25 + best.s * 0.2, intent: { targets: [[best.c.id]] } };
  }
  attackPotential(c) { return num(c.c.power) * 10 + num(c.c.toughness) * 3 + (this.kw(c, "flying") ? 15 : 0) + (this.kw(c, "trample") ? 5 : 0) + (c.isCommander ? 10 : 0) - (this.kw(c, "defender") ? 50 : 0); }

  cycleScore(a, i, o) {
    const lands = this.landCount();
    const d = o.def;
    const isLand = d.types?.includes("land");
    let v = 0;
    if (isLand && lands + this.hand().filter((h) => h.def?.types?.includes("land")).length >= 7) v = 12;
    else if (!isLand && num(d.cmc) > lands + 4) v = 10;
    if (!v) return null;
    if (this.myTurn() && this.st.step === "main1") v *= 0.5;
    return { a, i, score: v };
  }

  /** Response to an opponent's spell/ability on top of the stack. */
  respondScore({ a, i }, top) {
    const L = this.level;
    const threat = this.stackValue(top);
    const tgtMine = (top.targets || []).filter((id) => !isPid(id) && this.O(id)?.controller === this.p && this.O(id)?.zone === "battlefield");
    const harmed = [];
    if (tgtMine.length) {
      const eff = top.isAbility ? top.ab?.effects || [] : this.faceDef(top).spell?.effects || [];
      const specs = top._targets || [];
      for (const id of tgtMine) {
        const k = specs.findIndex((g) => g.includes(id));
        if (k >= 0 && this.simpleRole(eff, k) === "harm") harmed.push(this.O(id));
        if (k < 0 && top._modeTargets) harmed.push(this.O(id));
      }
    }
    if (a.type === "cast") {
      const cd = this.castDef(a);
      if (!cd) return null;
      const { o, fd } = cd;
      const sp = fd.spell || {};
      const E = { p: this.p, src: o };
      // counterspells
      const counters = hasOp(sp.effects, "counter") || (sp.modes?.modes || []).some((m) => hasOp(m.effects, "counter"));
      if (counters) {
        const need = L === 2 ? 38 : L === 1 ? 50 : 70;
        if (threat < need) return null;
        let cands = [];
        try { cands = (sp.targets || []).length ? this.g.targetCandidates(sp.targets[0], o, this.p, this.ectx(E)) : []; } catch { cands = []; }
        if (sp.targets?.length && !cands.includes(top.id)) {
          if (!sp.modes) return null;
        }
        const intent = { targets: [[top.id]] };
        if (sp.modes) {
          const k = sp.modes.modes.findIndex((m) => hasOp(m.effects, "counter"));
          if (k >= 0) { intent.modes = [k]; intent.modeTargets = { [k]: [[top.id]] }; }
        }
        return { a, i, score: threat - num(fd.cmc) * 2, intent };
      }
      // protect a creature that's being removed
      if (harmed.length && this.instantSpeed(fd)) {
        const best = harmed.sort((x, y) => this.objValue(y) - this.objValue(x))[0];
        const prot = protectsWith(sp, best, this);
        if (prot) return { a, i, score: this.objValue(best) * 0.8, intent: prot };
      }
      // hard: removal in response to the opponent's aura/equip/pump on their creature
      if (L === 2 && this.instantSpeed(fd) && top.controller !== this.p && !top.isAbility) {
        const td = this.faceDef(top);
        if ((td.subtypes || []).includes("aura") && top.targets?.length) {
          const host = this.O(top.targets[0]);
          if (host && host.controller !== this.p) {
            const bt = this.bestTargetsFor(sp.targets || [], sp.effects || [], E);
            if (bt.targets[0]?.[0] === host.id && bt.value > 20) return { a, i, score: bt.value + 15, intent: { targets: bt.targets } };
          }
        }
      }
      return null;
    }
    if (a.type === "activate") {
      const o = this.O(a.obj);
      const ab = o?.c?.abilities?.[a.ability];
      if (!ab) return null;
      // sacrifice in response to removal: get value from a creature that's leaving anyway
      if (harmed.length && ab.cost?.sac) {
        const victim = harmed.find((h) => safe(() => this.g.matches(h, ab.cost.sac, { source: o, you: this.p })));
        if (victim && victim.id !== o.id) {
          const E = { p: this.p, src: o, sacrificed: [victim] };
          const bt = this.bestTargetsFor(ab.targets || [], ab.effects || [], E);
          if (bt.value > -5) return { a, i, score: 20 + bt.value, intent: { targets: bt.targets, sac: [victim.id] } };
        }
      }
      if (harmed.length && ab.cost?.sacSelf && harmed.some((h) => h.id === o.id)) {
        const E = { p: this.p, src: o };
        const bt = this.bestTargetsFor(ab.targets || [], ab.effects || [], E);
        if (bt.value > 0) return { a, i, score: 15 + bt.value, intent: { targets: bt.targets } };
      }
      if (harmed.length && !ab.mana) {
        const best = harmed[0];
        const prot = protectsWith({ effects: ab.effects, targets: ab.targets }, best, this, o);
        if (prot) return { a, i, score: this.objValue(best) * 0.6, intent: prot };
      }
      return null;
    }
    return null;
  }

  /** Combat tricks: pump spells/abilities after blockers are declared (our creatures in combat). */
  combatTrick(usable) {
    const st = this.st;
    if (st.step !== "declareBlockers" || !st.combat || st.stack.length) return null;
    if (this.level === 0 && !this.roll(0.4)) return null;
    const cb = st.combat;
    const mineIn = [];
    for (const e of cb.attackers) {
      const a = this.O(e.obj);
      if (!a) continue;
      if (a.controller === this.p) mineIn.push({ me: a, foes: e.blockers.map((id) => this.O(id)).filter(Boolean), attacking: true, entry: e });
      else for (const bid of e.blockers) { const b = this.O(bid); if (b && b.controller === this.p) mineIn.push({ me: b, foes: [a], attacking: false, entry: e }); }
    }
    if (!mineIn.length) return null;
    const oppLife = this.st.players[this.opp].life;
    const unblockedDmg = cb.attackers.filter((e) => !e.blocked && this.O(e.obj)?.controller === this.p).reduce((s, e) => s + Math.max(0, num(this.O(e.obj).c.power)) * (this.kw(this.O(e.obj), "double strike") ? 2 : 1), 0);
    let best = null;
    for (const { a, i } of usable) {
      let fx = null, specs = [], src = this.O(a.obj), costV = 0;
      if (a.type === "cast") {
        const cd = this.castDef(a);
        if (!cd || !this.instantSpeed(cd.fd)) continue;
        fx = cd.fd.spell?.effects || [];
        specs = cd.fd.spell?.targets || [];
        costV = 20 + num(cd.fd.cmc) * 2;
      } else if (a.type === "activate") {
        const ab = src?.c?.abilities?.[a.ability];
        if (!ab || ab.mana || ab.sorcery || ab.loyalty) continue;
        if ((this.memo.counts.get(this.actKey(a)) || 0) >= 4) continue;
        fx = ab.effects || [];
        specs = ab.targets || [];
        costV = 4 + this.costPenalty({ ...ab.cost, mana: null }, src) + costCmc(parseManaCost(ab.cost?.mana || ""));
        if (ab.cost?.tap && src && mineIn.some((m) => m.me.id === src.id)) continue;
      } else continue;
      const pump = pumpOf(fx, this, { p: this.p, src });
      if (!pump) continue;
      const targetsSelf = pump.self;
      for (const m of mineIn) {
        if (targetsSelf && src.id !== m.me.id) continue;
        if (!targetsSelf) {
          let ok = false;
          try { ok = this.g.targetCandidates(specs[pump.index] || {}, src, this.p, { source: src, you: this.p }).includes(m.me.id); } catch { ok = false; }
          if (!ok) continue;
        }
        let gain = 0;
        const before = this.trickOutcome(m, null);
        const after = this.trickOutcome(m, pump);
        if (before.meDies && !after.meDies) gain += this.objValue(m.me);
        gain += (after.foesDead - before.foesDead);
        if (m.attacking && !m.entry.blocked) {
          const extra = pump.power * (this.kw(m.me, "double strike") ? 2 : 1);
          if (unblockedDmg < oppLife && unblockedDmg + extra >= oppLife) gain += 5000;
        }
        if (after.through > before.through && unblockedDmg + after.through - before.through >= oppLife) gain += 5000;
        const sc = gain - costV;
        if (gain > 0 && sc > 0 && (!best || sc > best.score)) best = { a, i, score: sc, intent: targetsSelf ? {} : { targets: specsWith(specs.length, pump.index, m.me.id) } };
      }
    }
    return best;
  }
  trickOutcome(m, pump) {
    const me = this.stats(m.me, pump);
    const foes = m.foes.map((f) => this.stats(f));
    if (m.attacking) {
      if (!foes.length) return { meDies: false, foesDead: 0, through: 0 };
      const r = fight(me, foes);
      return { meDies: r.attDies, foesDead: r.dead.reduce((s, id) => s + this.objValue(this.O(id)), 0), through: r.through };
    }
    const atk = foes[0];
    const others = m.entry.blockers.filter((id) => id !== m.me.id).map((id) => this.stats(this.O(id))).filter(Boolean);
    const r = fight(atk, [me, ...others]);
    return { meDies: r.dead.includes(me.id), foesDead: r.attDies ? this.objValue(m.foes[0]) : 0, through: 0 };
  }

  // ---------------------------------------------------------------------------------------------- combat model
  stats(o, pump = null) {
    if (!o) return null;
    const k = (x) => this.kw(o, x) || !!(pump && pump.keywords.includes(x));
    return {
      id: o.id, o, controller: o.controller,
      power: Math.max(0, num(o.c.power) + (pump ? pump.power : 0)),
      tough: (safe(() => this.g.lethalThreshold(o)) ?? num(o.c.toughness)) + (pump ? pump.toughness : 0) - (o.damage | 0),
      fs: k("first strike"), ds: k("double strike"), dt: k("deathtouch"), tr: k("trample"), ll: k("lifelink"),
      ind: k("indestructible"), menace: k("menace"), infect: k("infect"), cmdr: !!o.isCommander,
      value: this.lossValue(o),
    };
  }
  /** What losing this creature in combat really costs (commanders come back; undying/persist return). */
  lossValue(o) {
    let v = this.objValue(o);
    if (o.isCommander) v *= 0.6;
    if ((this.kw(o, "undying") && !(o.counters?.["+1/+1"] > 0)) || (this.kw(o, "persist") && !(o.counters?.["-1/-1"] > 0))) v *= 0.35;
    return v;
  }
  canBlock(b, a) { try { return this.g.canBlock(b, a); } catch { return false; } }
  /** Damage an attacker deals to the defending player if unblocked. */
  hitFor(s) { return s.power * (s.ds ? 2 : 1); }

  /**
   * Plan blocks for defender `d` against attackers [{o, defender}], with candidate blockers [{o, canBlock:Set}].
   * Returns { blocks:[{obj, attacker}], dmg, lost, killed }.
   */
  planBlocks(d, attackers, blockers, opts = {}) {
    const L = opts.level ?? this.level;
    const pl = this.st.players[d];
    const life = opts.life ?? pl.life;
    const A = attackers.map((x) => ({ ...this.stats(x.o, x.pump), defender: x.defender, toPlayer: isPid(x.defender) }));
    const free = new Map(blockers.map((b) => [b.o.id, { s: this.stats(b.o), can: b.can }]));
    const assign = new Map(A.map((a) => [a.id, []]));
    const can = (bid, aid) => free.get(bid)?.can.has(aid);
    const cheapest = (list) => list.sort((x, y) => x.s.value - y.s.value)[0];
    const order = [...A].sort((x, y) => (this.hitFor(y) * 3 + y.value) - (this.hitFor(x) * 3 + x.value));
    const tradeRatio = L === 2 ? 0.9 : L === 1 ? 1.0 : 1.3;
    // 1. good blocks: kill it and survive. 2. trades.
    for (const pass of ["good", "trade"]) {
      for (const a of order) {
        if (assign.get(a.id).length || a.menace) continue;
        const opts2 = [];
        for (const [bid, b] of free) {
          if (!can(bid, a.id)) continue;
          const r = fight(a, [b.s]);
          const bDies = r.dead.includes(bid);
          if (pass === "good" && r.attDies && !bDies) opts2.push(b);
          if (pass === "good" && !r.attDies && !bDies && a.toPlayer && L >= 1 && b.s.value < 200) { /* safe wall block handled later */ }
          if (pass === "trade" && r.attDies && bDies && a.value >= b.s.value * tradeRatio) opts2.push(b);
        }
        const b = cheapest(opts2);
        if (b) { assign.get(a.id).push(b.s.id); free.delete(b.s.id); }
      }
    }
    // 3. gang blocks on valuable attackers (normal/hard), menace attackers need two
    if (L >= 1) {
      for (const a of order) {
        if (assign.get(a.id).length) continue;
        const fb = [...free.values()].filter((b) => can(b.s.id, a.id));
        let bestPair = null;
        for (let x = 0; x < fb.length && x < 8; x++) for (let y = x + 1; y < fb.length && y < 8; y++) {
          const r = fight(a, [fb[x].s, fb[y].s]);
          if (!r.attDies) continue;
          const lost = r.dead.reduce((s, id) => s + (free.get(id)?.s.value || 0), 0);
          if (lost < a.value * (L === 2 ? 0.95 : 0.8) && (!bestPair || lost < bestPair.lost)) bestPair = { ids: [fb[x].s.id, fb[y].s.id], lost };
        }
        if (bestPair) { assign.get(a.id).push(...bestPair.ids); for (const id of bestPair.ids) free.delete(id); }
      }
    }
    // incoming damage given current blocks
    const incoming = () => {
      let dmg = 0, poison = 0;
      const cmd = {};
      for (const a of A) {
        if (!a.toPlayer) continue;
        const bl = assign.get(a.id);
        let through;
        if (!bl.length) through = this.hitFor(a);
        else if (a.tr) { const tough = bl.reduce((s, id) => s + Math.max(0, (this.st.objects[id] ? this.stats(this.st.objects[id]).tough : 0)), 0); through = Math.max(0, this.hitFor(a) - (a.dt ? bl.length : tough)); }
        else through = 0;
        if (a.infect) poison += through; else dmg += through;
        if (a.cmdr && through) cmd[a.id] = (pl.commanderDamage?.[a.id] | 0) + through;
      }
      return { dmg, poison, cmd };
    };
    const danger = () => {
      const { dmg, poison, cmd } = incoming();
      const lifeAfter = life - dmg;
      const margin = L === 0 ? 1 : L === 1 ? 3 : 5 + Math.min(10, this.oppPotential(d) * 0.3);
      return lifeAfter <= 0 || pl.poison + poison >= 10 || Object.values(cmd).some((n) => n >= 21) || lifeAfter < margin;
    };
    // 4. safe blocks: a blocker that survives soaks up the most damage it can (tramplers only push the excess through)
    if (L >= 1) {
      for (const [bid, b] of [...free].sort((x, y) => y[1].s.tough - x[1].s.tough)) {
        let best = null;
        for (const a of order) {
          if (assign.get(a.id).length || a.menace || !a.toPlayer || !can(bid, a.id)) continue;
          if (fight(a, [b.s]).dead.includes(bid)) continue;
          const saved = a.tr ? Math.min(this.hitFor(a), Math.max(0, b.s.tough)) : this.hitFor(a);
          if (saved > 0 && (!best || saved > best.saved)) best = { a, saved };
        }
        if (best) { assign.get(best.a.id).push(bid); free.delete(bid); }
      }
    }
    // 5. chump-block while in danger
    let guard = 0;
    while (danger() && free.size && guard++ < 20) {
      const un = order.filter((a) => a.toPlayer && !assign.get(a.id).length && (!a.tr || this.hitFor(a) > 0));
      let done = false;
      for (const a of un) {
        const fb = [...free.values()].filter((b) => can(b.s.id, a.id)).sort((x, y) => x.s.value - y.s.value);
        const need = a.menace ? 2 : 1;
        if (fb.length < need) continue;
        for (let k = 0; k < need; k++) { assign.get(a.id).push(fb[k].s.id); free.delete(fb[k].s.id); }
        done = true;
        break;
      }
      if (!done) break;
    }
    // planeswalker defence: block attackers on our planeswalkers when cheap
    if (L >= 1) for (const a of order) {
      if (a.toPlayer || assign.get(a.id).length || a.menace) continue;
      const opts2 = [...free.values()].filter((b) => can(b.s.id, a.id) && !fight(a, [b.s]).dead.includes(b.s.id));
      const b = cheapest(opts2);
      if (b) { assign.get(a.id).push(b.s.id); free.delete(b.s.id); }
    }
    // outcome
    const blocks = [];
    let lost = 0, killed = 0, dmgOut = 0, lifelink = 0;
    for (const a of A) {
      const bl = assign.get(a.id);
      for (const id of bl) blocks.push({ obj: id, attacker: a.id });
      if (bl.length) {
        const r = fight(a, bl.map((id) => this.stats(this.st.objects[id])));
        lost += r.dead.reduce((s, id) => s + this.lossValue(this.st.objects[id]), 0);
        if (r.attDies) killed += a.value;
        if (a.ll) lifelink += Math.min(a.power, 99);
      } else if (a.ll) lifelink += this.hitFor(a);
    }
    const inc = incoming();
    dmgOut = inc.dmg;
    return { blocks, dmg: dmgOut, poison: inc.poison, cmd: inc.cmd, lost, killed, lifelink, assign };
  }

  /** Total power the opponents of `d` could swing with next turn (rough). */
  oppPotential(d) {
    let n = 0;
    for (const o of this.bf) if (o.controller !== d && this.isCre(o) && !this.kw(o, "defender")) n += this.hitFor(this.stats(o));
    return n;
  }

  // ---------------------------------------------------------------------------------------------- blockers request
  blockers() {
    const req = this.req;
    const st = this.st;
    const cb = st.combat;
    const attackers = req.attackers.map((id) => {
      const e = cb?.attackers.find((x) => x.obj === id);
      return { o: this.O(id), defender: e ? e.defender : "P" + this.p };
    }).filter((x) => x.o);
    const blockers = req.candidates.map((c) => ({ o: this.O(c.obj), can: new Set(c.canBlock) })).filter((x) => x.o);
    let L = this.level;
    if (L === 0 && this.roll(0.25)) L = 1;
    const plan = this.planBlocks(this.p, attackers, blockers, { level: L });
    let blocks = plan.blocks;
    // easy: sometimes forget a non-essential block
    if (this.level === 0 && blocks.length > 1 && this.roll(0.3)) {
      const drop = blocks[Math.floor(this.rng() * blocks.length)];
      const att = this.O(drop.attacker);
      if (!(att && this.kw(att, "menace"))) blocks = blocks.filter((b) => b !== drop);
    }
    return { blocks: this.fixMenace(blocks) };
  }
  fixMenace(blocks) {
    const per = new Map();
    for (const b of blocks) per.set(b.attacker, (per.get(b.attacker) || 0) + 1);
    return blocks.filter((b) => { const a = this.O(b.attacker); return !(a && this.kw(a, "menace") && per.get(b.attacker) < 2); });
  }

  // ---------------------------------------------------------------------------------------------- attackers request
  attackers() {
    const req = this.req;
    const L = this.level;
    const cands = req.candidates.map((c) => ({ o: this.O(c.obj), defenders: c.defenders })).filter((c) => c.o);
    if (!cands.length) return { attacks: [] };
    const oppIdx = this.opp;
    const oppId = "P" + oppIdx;
    const def0 = (c) => (c.defenders.includes(oppId) ? oppId : c.defenders.find(isPid) || c.defenders[0]);
    const oppBlockers = this.bf.filter((o) => o.controller === oppIdx && this.isCre(o) && !o.tapped && !o.c.cantBlock);
    const evalSet = (set) => this.evalAttack(set, cands, oppBlockers, oppIdx, def0);

    let chosen;
    if (L === 0) {
      // easy: attack with everything that doesn't obviously die for nothing
      chosen = cands.filter((c) => {
        const s = this.stats(c.o);
        const killers = oppBlockers.filter((b) => this.canBlock(b, c.o) && fight(s, [this.stats(b)]).attDies && !fight(s, [this.stats(b)]).dead.includes(b.id));
        return !killers.length || this.roll(0.25);
      });
    } else {
      // candidate sets + greedy improvement
      const scoreOf = new Map();
      const sc = (set) => { const k = set.map((c) => c.o.id).sort().join(","); if (!scoreOf.has(k)) scoreOf.set(k, evalSet(set)); return scoreOf.get(k); };
      const all = [...cands];
      const safeOnes = cands.filter((c) => {
        const s = this.stats(c.o);
        return !oppBlockers.some((b) => this.canBlock(b, c.o) && fight(s, [this.stats(b)]).attDies);
      });
      let bestSet = [], bestScore = sc([]);
      for (const set of [all, safeOnes]) { const v = sc(set); if (v > bestScore) { bestScore = v; bestSet = set; } }
      // greedy add / remove
      const rounds = L === 2 ? 3 : 1;
      for (let r = 0; r < rounds; r++) {
        let improved = false;
        for (const c of cands) {
          const has = bestSet.includes(c);
          const set = has ? bestSet.filter((x) => x !== c) : [...bestSet, c];
          const v = sc(set);
          if (v > bestScore + 0.5) { bestScore = v; bestSet = set; improved = true; }
        }
        if (!improved) break;
      }
      chosen = bestSet;
    }
    // defenders: player by default; spare unblockable damage at planeswalkers when not going for lethal
    const attacks = chosen.map((c) => ({ obj: c.o.id, defender: def0(c) }));
    const pws = this.bf.filter((o) => o.controller === oppIdx && o.c.types.includes("planeswalker"));
    if (pws.length && L >= 1) {
      const plan = this.planBlocks(oppIdx, attacks.map((x) => ({ o: this.O(x.obj), defender: x.defender })), oppBlockers.map((b) => ({ o: b, can: new Set(chosen.filter((c) => this.canBlock(b, c.o)).map((c) => c.o.id)) })), { level: 1 });
      const lethal = plan.dmg >= this.st.players[oppIdx].life;
      if (!lethal) {
        for (const pw of pws.sort((x, y) => this.objValue(y) - this.objValue(x))) {
          let loy = pw.counters?.loyalty | 0;
          for (const at of attacks) {
            if (loy <= 0) break;
            const cand = cands.find((c) => c.o.id === at.obj);
            if (!cand || !cand.defenders.includes(pw.id) || plan.assign.get(at.obj)?.length) continue;
            const pwr = num(this.O(at.obj).c.power);
            if (pwr <= 0) continue;
            at.defender = pw.id;
            loy -= pwr;
          }
        }
      }
    }
    return { attacks };
  }

  /** Score of attacking with `set` (subset of candidates). */
  evalAttack(set, cands, oppBlockers, oppIdx, def0) {
    const L = this.level;
    const op = this.st.players[oppIdx];
    const attackers = set.map((c) => ({ o: c.o, defender: def0(c) }));
    const ids = new Set(set.map((c) => c.o.id));
    const blockers = oppBlockers.map((b) => ({ o: b, can: new Set(set.filter((c) => this.canBlock(b, c.o)).map((c) => c.o.id)) }));
    const plan = this.planBlocks(oppIdx, attackers, blockers, { level: Math.max(1, L) });
    let score = 0;
    const life = op.life;
    if (plan.dmg >= life || op.poison + plan.poison >= 10 || Object.values(plan.cmd).some((n) => n >= 21)) score += 100000;
    let dmgW = 1.5 + 40 / Math.max(1, life);
    if (L === 2) {
      // racing: when our clock is at least as fast as theirs, damage is worth more (and holding back worth less)
      const mine = this.ctrlBf(this.p).filter((o) => this.isCre(o) && !this.kw(o, "defender")).reduce((n, o) => n + this.hitFor(this.stats(o)), 0);
      const myClock = life / Math.max(1, mine), theirClock = this.me.life / Math.max(1, this.oppPotential(this.p));
      if (myClock <= theirClock) dmgW *= 1.6;
    }
    score += plan.dmg * dmgW;
    for (const [cid, n] of Object.entries(plan.cmd)) score += n * 2 * (1 + (op.commanderDamage?.[cid] | 0) / 10);
    score += plan.poison * 8;
    score += plan.lost * 1.0 - plan.killed * 1.05; // plan is from the defender's view: lost = their blockers, killed = our attackers
    score += plan.lifelink * this.lifeW(this.p) * 0.5;
    // crack-back: their creatures (that survive) swing at us next turn; our untapped creatures can block
    if (L >= 1 && score < 50000) {
      const lostIds = new Set();
      for (const a of set) { /* attackers that died in plan */ }
      const theirs = this.bf.filter((o) => o.controller === oppIdx && this.isCre(o) && !this.kw(o, "defender") && !o.c.cantAttack);
      const killedBlockers = new Set();
      for (const [aid, bl] of plan.assign) {
        if (!bl.length) continue;
        const r = fight(this.stats(this.O(aid)), bl.map((id) => this.stats(this.O(id))));
        for (const id of r.dead) killedBlockers.add(id);
        if (r.attDies) lostIds.add(aid);
      }
      const theirAtk = theirs.filter((o) => !killedBlockers.has(o.id)).map((o) => ({ o, defender: "P" + this.p }));
      const myDef = this.ctrlBf(this.p).filter((o) => this.isCre(o) && !this.borrowed(o) && !o.c.cantBlock && !lostIds.has(o.id) && (!ids.has(o.id) || this.kw(o, "vigilance")));
      if (theirAtk.length) {
        const back = this.planBlocks(this.p, theirAtk, myDef.map((b) => ({ o: b, can: new Set(theirAtk.filter((x) => this.canBlock(b, x.o)).map((x) => x.o.id)) })), { level: 1, life: this.me.life });
        const myLife = this.me.life;
        if (back.dmg >= myLife || this.me.poison + back.poison >= 10 || Object.values(back.cmd).some((n) => n >= 21)) score -= 20000;
        else score -= back.dmg * this.lifeW(this.p) * (L === 2 ? 0.9 : 0.6) + back.lost * 0.4;
      }
    }
    return score;
  }

  // ---------------------------------------------------------------------------------------------- choose
  choose() {
    const r = this.req;
    const opts = r.options;
    const n = opts.length;
    const hint = r._hint || {};
    const pickTop = (scores, min, max, thr = 0) => {
      const idx = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s || a.i - b.i);
      const out = idx.filter((x, k) => k < max && (k < min || x.s > thr)).map((x) => x.i);
      return { chosen: out };
    };
    const pickLow = (scores, min, max) => pickTop(scores.map((s) => -s), min, max, Infinity);
    const objOf = (opt) => (opt && opt.id && !isPid(opt.id) ? this.O(opt.id) : null);
    const intent = this.memo.intent && this.memo.intent.src === r.source ? this.memo.intent : null;
    { const m1a = m1Choose(this, r, hint); if (m1a) return m1a; }

    switch (r.reason) {
      case "target": {
        const idx = hint.index ?? 0;
        if (intent && intent.targets && intent.targets[idx]) {
          const want = intent.targets[idx];
          const ch = opts.map((o, i) => (want.includes(o.id) ? i : -1)).filter((i) => i >= 0).slice(0, r.max);
          if (ch.length >= r.min) { intent.targets[idx] = null; return { chosen: ch }; }
        }
        if (intent && intent.modeTargets) {
          for (const [k, t] of Object.entries(intent.modeTargets)) {
            const want = t && t[idx];
            if (!want) continue;
            const ch = opts.map((o, i) => (want.includes(o.id) ? i : -1)).filter((i) => i >= 0).slice(0, r.max);
            if (ch.length >= r.min) { t[idx] = null; return { chosen: ch }; }
          }
        }
        const src = r.source ? this.O(r.source) : null;
        const E = { p: this.p, src, x: src?.x | 0, targets: hint.chosen || [] };
        const effects = hint.effects || [];
        const isAura = effects.some((e) => e && e.op === "_aura");
        let role = isAura ? this.auraRole(this.faceDef(src || { def: {} }) || {}) : this.simpleRole(effects, idx) || this.filterRole(hint.spec);
        let scores;
        if (!isAura && effects.length && n <= 40) {
          const tg = [...(hint.chosen || [])];
          const base = this.evalEffects(effects, { ...E, targets: tg.map((t, k) => (k === idx ? [] : t)) });
          scores = opts.map((o) => { const t2 = [...tg]; t2[idx] = [o.id]; return this.evalEffects(effects, { ...E, targets: t2 }) - base + this.candValueForRole(o.id, role, E) * 0.01; });
          if (scores.every((s) => Math.abs(s) < 0.02)) scores = opts.map((o) => this.candValueForRole(o.id, role, E));
        } else scores = opts.map((o) => this.candValueForRole(o.id, role, E));
        if (this.level === 0) scores = scores.map((s) => s * (0.7 + this.rng() * 0.6));
        return pickTop(scores, r.min, r.max, 0.5);
      }
      case "crew": { // m2: tap the cheapest set of creatures reaching the crew number (summoning-sick / low value first)
        const need = hint.need | 0;
        const ranked = opts.map((o, i) => { const x = objOf(o); return { i, pw: num(x?.c?.power), v: x ? this.objValue(x) + (x.sick ? -50 : 0) : 0 }; }).sort((a, b) => a.v - b.v);
        const ch = []; let tot = 0;
        for (const c of ranked) { if (tot >= need) break; ch.push(c.i); tot += c.pw; }
        return { chosen: ch };
      }
      case "sacrifice": {
        if (intent && intent.sac) {
          const ch = opts.map((o, i) => (intent.sac.includes(o.id) ? i : -1)).filter((i) => i >= 0);
          if (ch.length >= r.min && ch.length <= r.max) return { chosen: ch };
        }
        const scores = opts.map((o) => { const x = objOf(o); if (!x) return 0; const v = this.objValue(x) - num(x.c?.power) * 0.5; return x.controller === this.p ? v : -v; });
        return pickLow(scores, r.min, r.max);
      }
      case "discard": {
        const scores = opts.map((o) => { const x = objOf(o); return x ? this.cardValue(x) : 0; });
        return pickLow(scores, r.min, r.max);
      }
      case "bottom": return this.chooseBottom(opts, r.min, r.max);
      case "scry": {
        const toGy = /graveyard/i.test(r.prompt);
        const scores = opts.map((o) => { const x = objOf(o); return x ? (this.wantOnTop(x) ? -1 : 1) : -1; });
        const ch = scores.map((s, i) => (s > 0 ? i : -1)).filter((i) => i >= 0).slice(0, r.max);
        void toGy;
        return { chosen: ch.length >= r.min ? ch : [...ch, ...opts.map((_, i) => i).filter((i) => !ch.includes(i))].slice(0, r.min) };
      }
      case "search": return this.chooseSearch(opts, r.min, r.max, hint);
      case "exile": {
        const scores = opts.map((o) => { const x = objOf(o); if (!x) return 0; const mine = x.owner === this.p; const v = this.cardValue(x); return mine ? -v : v; });
        return pickTop(scores, r.min, r.max, Infinity);
      }
      case "return": {
        const scores = opts.map((o) => { const x = objOf(o); return x ? this.objValue(x) * (x.owner === this.p ? 1 : -1) : 0; });
        return pickTop(scores, r.min, r.max, 0);
      }
      case "mode": {
        if (intent && intent.modes) {
          const ch = opts.map((o, i) => (intent.modes.includes(+String(o.id).slice(1)) ? i : -1)).filter((i) => i >= 0).slice(0, r.max);
          if (ch.length >= r.min) { intent.modes = null; return { chosen: ch }; }
        }
        const src = r.source ? this.O(r.source) : null;
        const modes = hint.modes || [];
        const E = { p: this.p, src, x: src?.x | 0 };
        const scores = opts.map((o) => { const m = modes[+String(o.id).slice(1)]; return m ? this.bestTargetsFor(m.targets || [], m.effects || [], E).value : 0; });
        return pickTop(scores, r.min, r.max, 0);
      }
      case "pay": {
        const scores = opts.map((o) => { const l = String(o.label || ""); return /sacrifice/i.test(l) ? -30 : /discard/i.test(l) ? -20 : /life/i.test(l) ? -8 : /\{/.test(l) ? -3 : -10; });
        if (/^Tap /i.test(r.prompt)) {
          const s2 = opts.map((o) => { const x = objOf(o); return x ? -(this.isCre(x) ? this.attackPotential(x) : 5) : 0; });
          return pickTop(s2, r.min, r.max, Infinity);
        }
        return pickTop(scores, r.min, r.max, Infinity);
      }
      case "order": {
        if (r.ordered && /on top/.test(r.prompt)) { // the last one chosen ends up on top: best card last
          const sc = opts.map((o, i) => { const x = objOf(o); return { i, v: x ? (this.wantOnTop(x) ? 100 : 0) + this.cardValue(x) : 0 }; }).sort((a, b) => a.v - b.v || a.i - b.i);
          return { chosen: sc.map((x) => x.i).slice(0, Math.max(r.min, Math.min(r.max, n))) };
        }
        return { chosen: opts.map((_, i) => i).slice(0, Math.max(r.min, Math.min(r.max, n))) };
      }
      case "mutate": {
        const host = this.O(hint.host), sp = this.O(hint.spell);
        if (!host || !sp) return { chosen: [0] };
        const sd = sp.def, sc = { power: num(sd.power), toughness: num(sd.toughness), keywords: sd.keywords || {}, abilities: sd.abilities || [] };
        const over = this.mergedValue(sd, sc, host.c), under = this.mergedValue(host.def, host.c, sc);
        const want = over >= under ? "over" : "under";
        const k = opts.findIndex((o) => o.id === want);
        return { chosen: [k >= 0 ? k : 0] };
      }
      default: return this.chooseGeneric(opts, r, hint);
    }
  }

  wantOnTop(o) {
    const d = o.def || {};
    const lands = this.landCount();
    const handLands = this.hand().filter((h) => h.def?.types?.includes("land")).length;
    if ((d.types || []).includes("land")) return lands + handLands < 6;
    if (num(d.cmc) > lands + handLands + 2 && lands < 7) return false;
    if (lands + handLands < 3 && num(d.cmc) >= 3) return false;
    return true;
  }

  chooseBottom(opts, min, max) {
    const cards = opts.map((o, i) => ({ i, x: this.O(o.id) })).filter((c) => c.x);
    const lands = cards.filter((c) => c.x.def?.types?.includes("land"));
    const spells = cards.filter((c) => !c.x.def?.types?.includes("land")).sort((a, b) => num(b.x.def?.cmc) - num(a.x.def?.cmc));
    const keepN = cards.length - min;
    const wantLands = Math.min(lands.length, Math.max(2, Math.round(keepN * 0.43)));
    const out = [];
    const extraLands = lands.slice(wantLands);
    for (const c of extraLands) if (out.length < min) out.push(c.i);
    for (const c of spells) if (out.length < min) out.push(c.i);
    for (const c of lands) if (out.length < min && !out.includes(c.i)) out.push(c.i);
    return { chosen: out.slice(0, Math.max(min, Math.min(max, out.length))) };
  }

  chooseSearch(opts, min, max, hint) {
    const objs = opts.map((o) => this.O(o.id));
    const lands = this.landCount();
    const handLands = this.hand().filter((h) => h.def?.types?.includes("land")).length;
    const allLands = objs.every((x) => x && x.def?.types?.includes("land"));
    const id = this.g.identityOf ? safe(() => this.g.identityOf(this.p)) || [] : [];
    const have = new Set();
    for (const s of safe(() => this.g.manaSources(this.p)) || []) for (const op of s.opts) for (const u of op.units) for (const c of u) have.add(c);
    const need = new Map();
    for (const h of this.hand()) { const c = parseManaCost(h.def?.cost || ""); for (const k of ["W", "U", "B", "R", "G"]) if (c[k]) need.set(k, (need.get(k) || 0) + c[k]); }
    const scores = objs.map((x) => {
      if (!x) return -1;
      const d = x.def || {};
      if (d.types?.includes("land")) {
        const cols = landColors(d, id);
        let s = 20;
        for (const c of cols) { if (!have.has(c)) s += 8; s += (need.get(c) || 0) * 1.5; }
        if ((d.supertypes || []).includes("basic")) s += 2;
        if (allLands) return s;
        return lands + handLands < 4 ? 60 + s : 5 + s * 0.2;
      }
      let s = this.cardValue(x);
      if (num(d.cmc) <= lands + 1) s += 15;
      return s;
    });
    void hint;
    // distinct names first when several (search for "two basic lands" etc.)
    return pickDistinct(scores, objs, min, max);
  }

  chooseGeneric(opts, r, hint) {
    const n = opts.length;
    const objOf = (opt) => (opt && opt.id && !isPid(opt.id) ? this.O(opt.id) : null);
    const pick = (scores, thr = 0) => {
      const idx = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s || a.i - b.i);
      return { chosen: idx.filter((x, k) => k < r.max && (k < r.min || x.s > thr)).map((x) => x.i) };
    };
    if (hint.kind === "keep") return pick(opts.map((o) => { const x = objOf(o); return x ? this.objValue(x) + Object.values(x.counters || {}).reduce((a, b) => a + b, 0) * 5 + (x.tapped ? 0 : 2) : 0; }), -Infinity);
    if (hint.kind === "ringBearer") {
      const cur = this.me.ring?.bearer;
      return pick(opts.map((o) => { const x = objOf(o); if (!x) return 0; let s = this.attackPotential(x) + (this.kw(x, "flying") || x.c.unblockable ? 20 : 0) + (x.id === cur ? 8 : 0); if (x.isCommander) s += 5; return s; }), -Infinity);
    }
    if (opts.every((o) => o.type === "color")) {
      const need = new Map();
      for (const h of this.hand()) { const c = parseManaCost(h.def?.cost || ""); for (const k of ["W", "U", "B", "R", "G"]) if (c[k]) need.set(k, (need.get(k) || 0) + c[k]); }
      return pick(opts.map((o) => need.get(o.id) || 0), -Infinity);
    }
    const effects = hint.effects || [];
    const eff = effects[0];
    if (eff && eff.op === "lookTop") return pick(opts.map((o) => { const x = objOf(o); return x ? this.cardValue(x) + (this.wantOnTop(x) ? 10 : 0) : 0; }), -Infinity);
    if (eff && eff.op === "proliferate" || /proliferate/i.test(r.prompt)) {
      return pick(opts.map((o) => {
        if (isPid(o.id)) { const q = pidx(o.id); return q === this.p ? -5 : 5; }
        const x = objOf(o); if (!x) return 0;
        const mine = x.controller === this.p;
        const bad = (x.counters?.["-1/-1"] | 0) > 0;
        return mine ? (bad ? -5 : 5) : (bad ? 5 : -5);
      }), 0);
    }
    if (eff && eff.op === "_exploit" || /exploit/i.test(r.prompt)) {
      // only exploit tokens or small creatures
      return pick(opts.map((o) => { const x = objOf(o); return x ? (x.token ? 10 - this.objValue(x) * 0.1 : -this.objValue(x)) : -1; }), 5);
    }
    // object choice on resolution: decide by the effect's direction
    const objs = opts.map(objOf);
    if (objs.some(Boolean)) {
      let role = null;
      if (eff) {
        const ref = hint.ref;
        role = roleOfChoose(eff, ref);
      }
      const scores = opts.map((o, i) => {
        const x = objs[i];
        if (!x) return isPid(o.id) ? (pidx(o.id) === this.p ? (role === "harm" ? -50 : 20) : (role === "harm" ? 20 : -20)) : 0;
        const ctrl = x.zone === "battlefield" || x.zone === "stack" ? x.controller : x.owner;
        const v = x.zone === "battlefield" ? this.objValue(x) : this.cardValue(x);
        const mine = ctrl === this.p;
        if (role === "harm") return mine ? -v : v;
        if (role === "benefit") return mine ? v : -v;
        return x.zone === "battlefield" ? (mine ? v * 0.5 : -v * 0.5) : v;
      });
      return pick(scores, r.min > 0 ? -Infinity : 0);
    }
    if (opts.every((o) => isPid(o.id))) return pick(opts.map((o) => (pidx(o.id) === this.p ? -1 : 1)), -Infinity);
    return { chosen: Array.from({ length: Math.max(r.min, Math.min(1, r.max, n)) }, (_, i) => i) };
  }

  // ---------------------------------------------------------------------------------------------- confirm / number
  confirm() {
    const r = this.req;
    const h = r._hint || {};
    const prompt = String(r.prompt || "");
    { const m1a = m1Confirm(this, r, h); if (m1a !== undefined) return m1a; }
    if (h.kind === "commander" || /command zone\?/i.test(prompt)) return true;
    if (h.kind === "payToKeep") return true;
    if (h.kind === "ward") { const o = this.O(h.obj); return !o || this.stackValue(o) > 15; }
    if (h.kind === "echo") { const o = r.source ? this.O(r.source) : null; return !!o && this.objValue(o) > 35; }
    if (h.kind === "explore") { const c = this.O(h.card); return !!c && !this.wantOnTop(c); }
    if (h.kind === "shock") { // pay life so the land enters untapped only when that mana is wanted now
      const want = this.myTurn() && this.isMain() && this.hand().some((x) => !x.def?.types?.includes("land") && num(x.def?.cmc) === this.manaNow() + 1);
      return want && this.me.life - num(h.life) > 12;
    }
    if (h.kind === "newTargets") return false;
    if (h.kind === "may") {
      const src = r.source ? this.O(r.source) : null;
      const E = { p: this.p, src };
      // shock lands etc.: "pay 2 life so it is untapped"
      if ((h.effects || []).length === 1 && h.effects[0].op === "untap" && h.effects[0].what === "self") {
        if (!h.cost) return true;
        const lifeCost = num(h.cost.life);
        const want = this.myTurn() && this.isMain() && this.hand().some((x) => !x.def?.types?.includes("land") && num(x.def?.cmc) === this.manaNow() + 1);
        return want && this.me.life - lifeCost > 12;
      }
      if (h.event) E.event = h.event;
      let v = this.evalEffects(h.effects || [], E);
      const els = h.else ? this.evalEffects(h.else, E) : 0;
      const cost = h.cost ? this.costPenalty(h.cost, src, E) : 0;
      if (!(h.effects || []).length) return !h.cost;
      if (v === 0 && !h.cost) return !(h.else && els > 0);
      return v - cost > els;
    }
    if (/^Pay /i.test(prompt)) return true;
    return false;
  }

  /** Split divided damage/counters: kill what can be killed (most valuable first), the rest to the best remaining target. */
  divideNumber(r, h) {
    const ids = h.ids || [], total = h.total | 0;
    const plan = {};
    let left = total;
    const need = (id) => {
      if (isPid(id) || h.op !== "damage") return Infinity;
      const o = this.O(id);
      if (!o || o.zone !== "battlefield") return Infinity;
      if (this.isCre(o)) return Math.max(1, num(o.c.toughness) - (o.damage | 0));
      if (o.c.types.includes("planeswalker")) return Math.max(1, o.counters?.loyalty | 0);
      return Infinity;
    };
    for (const id of ids) plan[id] = 1;
    left -= ids.length;
    const order = ids.filter((id) => !isPid(id)).map((id) => ({ id, v: this.objValue(this.O(id)) * (this.O(id)?.controller === this.p ? -1 : 1) })).sort((a, b) => b.v - a.v);
    for (const { id, v } of order) { if (v <= 0) continue; const extra = Math.max(0, need(id) - plan[id]); if (extra !== Infinity && extra <= left) { plan[id] += extra; left -= extra; } }
    if (left > 0) { const pl = ids.find((id) => isPid(id) && pidx(id) !== this.p) || order[0]?.id || ids[ids.length - 1]; plan[pl] += left; }
    const id = ids[h.index | 0];
    return Math.max(r.min, Math.min(r.max, plan[id] | 0));
  }

  number() {
    const r = this.req;
    const h = r._hint || {};
    const intent = this.memo.intent && this.memo.intent.src === r.source ? this.memo.intent : null;
    { const m1a = m1Number(this, r, h); if (m1a !== undefined) return m1a; }
    if (h.kind === "divide") return this.divideNumber(r, h);
    if (h.kind === "x") {
      if (h.loyalty) return Math.max(r.min, Math.min(r.max, r.max - 1));
      if (intent && intent.x != null && intent.x >= r.min && intent.x <= r.max && intent.x > 0) return intent.x;
      return r.max;
    }
    return Math.max(r.min, Math.min(r.max, 0));
  }
}

// ================================================================================================ helpers

function safe(fn) { try { return fn(); } catch { return null; } }

/** Combat between one attacker and its blockers (stats objects). */
export function fight(a, bs) {
  const blk = bs.filter(Boolean).map((b) => ({ ...b, t: b.tough, dead: false, dtd: false }));
  let aT = a.tough, aDead = false, through = 0;
  const anyFs = a.fs || a.ds || blk.some((b) => b.fs || b.ds);
  const steps = anyFs ? [true, false] : [false];
  for (const first of steps) {
    const hits = (x) => (first ? x.fs || x.ds : !x.fs || x.ds);
    let dmgToA = 0, dtA = false;
    for (const b of blk) if (!b.dead && hits(b) && b.power > 0) { dmgToA += b.power; if (b.dt) dtA = true; }
    if (!aDead && hits(a) && a.power > 0) {
      let pw = a.power;
      const live = blk.filter((b) => !b.dead).sort((x, y) => x.t - y.t);
      if (!live.length) { if (a.tr || !blk.length) through += pw; }
      for (let i = 0; i < live.length && pw > 0; i++) {
        const b = live[i];
        const lethal = a.dt ? 1 : Math.max(1, b.t);
        const last = i === live.length - 1;
        const amt = last && !a.tr ? pw : Math.min(lethal, pw);
        b.t -= amt;
        if (a.dt && amt > 0) b.dtd = true;
        pw -= amt;
      }
      if (pw > 0 && a.tr && live.length) through += pw;
    }
    if (dmgToA > 0) { aT -= dmgToA; if ((aT <= 0 || dtA) && !a.ind) aDead = true; }
    for (const b of blk) if (!b.dead && (b.t <= 0 || b.dtd) && !b.ind) b.dead = true;
  }
  return { attDies: aDead, dead: blk.filter((b) => b.dead).map((b) => b.id), through };
}

function hasOp(effects, op) {
  for (const e of asArr(effects)) {
    if (!e || typeof e !== "object") continue;
    if (e.op === op) return true;
    if (hasOp(e.then, op) || hasOp(e.else, op) || hasOp(e.effects, op)) return true;
  }
  return false;
}

/** "pump" when every effect is an until-end-of-turn buff on a target / self. */
function spellCategory(effects, modes) {
  const list = asArr(effects).filter((e) => e && e.op !== "manual");
  if (!list.length && modes) return "modal";
  if (list.length && list.every((e) => (e.op === "pump" && (e.until == null || e.until === "endOfTurn") && (typeof e.power !== "number" || e.power >= 0) && (typeof e.toughness !== "number" || e.toughness >= 0)) || (e.op === "until" && e.static && e.static.type !== "cantBlock" && e.static.type !== "cantAttack"))) return "pump";
  if (list.some((e) => ["destroy", "exile", "damage", "bounce"].includes(e.op))) return "removal";
  return "other";
}

/** Pump info for a combat trick: { power, toughness, keywords, index, self } or null. */
function pumpOf(effects, brain, E) {
  for (const e of asArr(effects)) {
    if (!e || typeof e !== "object") continue;
    if (e.op === "pump" || (e.op === "addCounters" && (e.kind || "+1/+1") === "+1/+1")) {
      const what = e.what ?? { ref: "target", i: 0 };
      const self = what === "self";
      const idx = typeof what === "object" && what.ref === "target" ? what.i | 0 : 0;
      if (!self && !(typeof what === "object" && what.ref === "target")) continue;
      const pw = e.op === "pump" ? brain.amt(e.power ?? 0, E) : brain.amt(e.amount ?? 1, E);
      const tg = e.op === "pump" ? brain.amt(e.toughness ?? 0, E) : brain.amt(e.amount ?? 1, E);
      const kws = (e.op === "pump" ? asArr(e.keywords) : []).filter((k) => typeof k === "string").map((k) => k.toLowerCase());
      if (pw < 0 || tg < 0) continue;
      if (!pw && !tg && !kws.length) continue;
      return { power: pw, toughness: tg, keywords: kws, index: idx, self };
    }
  }
  return null;
}

function specsWith(n, idx, id) {
  const out = [];
  for (let i = 0; i < Math.max(n, idx + 1); i++) out.push(i === idx ? [id] : null);
  return out;
}

/** Can this spell/ability save `victim`? Returns an intent or null. */
function protectsWith(sp, victim, brain, srcObj) {
  const kwsSave = ["hexproof", "indestructible", "shroud", "protection"];
  const scan = (effects, specs, mode) => {
    for (const e of asArr(effects)) {
      if (!e || typeof e !== "object") continue;
      if (e.op === "pump") {
        const kws = asArr(e.keywords).map((k) => (typeof k === "string" ? k.toLowerCase() : Object.keys(k || {})[0] || ""));
        if (!kws.some((k) => kwsSave.some((s) => k.startsWith(s)))) continue;
        const what = e.what;
        if (what === "self" && srcObj && srcObj.id === victim.id) return {};
        if (what && typeof what === "object" && what.ref === "target") {
          const i = what.i | 0;
          let ok = false;
          try { ok = brain.g.targetCandidates((specs || [])[i] || {}, srcObj || victim, brain.p, { source: srcObj || victim, you: brain.p }).includes(victim.id); } catch { ok = false; }
          if (ok) return mode == null ? { targets: specsWith((specs || []).length, i, victim.id) } : { modes: [mode], modeTargets: { [mode]: specsWith((specs || []).length, i, victim.id) } };
        }
        if (what && typeof what === "object" && what.ref === "all") {
          try { if (brain.g.matches(victim, what.filter || {}, { source: srcObj || victim, you: brain.p })) return mode == null ? {} : { modes: [mode] }; } catch { /* */ }
        }
      }
    }
    return null;
  };
  const r = scan(sp.effects, sp.targets, null);
  if (r) return r;
  for (const [k, m] of (sp.modes?.modes || []).entries()) { const x = scan(m.effects, m.targets, k); if (x) return x; }
  return null;
}

/** Overload: turn "target" refs into "each matching". */
function overloadEffects(effects, specs) {
  const fix = (v) => {
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === "object") {
      if (v.ref === "target") { const s = specs[v.i | 0]; const w = s?.what; return { ref: "all", filter: typeof w === "object" ? w : w === "any" ? { types: ["creature", "planeswalker"] } : { types: [String(w || "creature")] } }; }
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = fix(x);
      return o;
    }
    return v;
  };
  return fix(effects);
}

function roleOfChoose(e, ref) {
  if (!e) return null;
  const isC = (r) => r && typeof r === "object" && (r === ref || r.ref === "choose");
  switch (e.op) {
    case "destroy": case "exile": case "bounce": case "sacrificeIt": case "tap": case "damage": return isC(e.what) || isC(e.to) ? "harm" : null;
    case "pump": case "addCounters": case "untap": case "attach": case "createToken": return "benefit";
    case "move": return e.to === "battlefield" || e.to === "hand" ? "benefit" : "harm";
    default: return null;
  }
}

function landColors(d, identity) {
  const out = new Set();
  const basic = { plains: "W", island: "U", swamp: "B", mountain: "R", forest: "G" };
  for (const s of d.subtypes || []) if (basic[s]) out.add(basic[s]);
  const walk = (list) => {
    for (const e of asArr(list)) {
      if (!e || typeof e !== "object") continue;
      if (e.op === "addMana") {
        const m = e.mana;
        if (typeof m === "string") { const c = parseManaCost(m); for (const k of ["W", "U", "B", "R", "G"]) if (c[k]) out.add(k); }
        else if (m && m.anyOf) for (const k of m.anyOf) out.add(String(k).toUpperCase()[0]);
        else if (m && (m.any || m.identity)) for (const k of identity.length ? identity : ["W", "U", "B", "R", "G"]) out.add(k);
        else if (m && m.color) out.add(String(m.color).toUpperCase()[0]);
      }
      if (e.then) walk(e.then);
      if (e.else) walk(e.else);
    }
  };
  for (const ab of d.abilities || []) if (ab.kind === "activated") walk(ab.effects);
  // fetch-style lands ("search for a basic land") count as any of our colours
  if (!out.size && (d.abilities || []).some((ab) => hasOp(ab.effects, "search"))) for (const k of identity) out.add(k);
  return [...out];
}

function pickDistinct(scores, objs, min, max) {
  const idx = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s || a.i - b.i);
  const out = [];
  const names = new Set();
  for (const x of idx) { if (out.length >= max) break; const nm = objs[x.i]?.c?.name; if (names.has(nm)) continue; if (out.length >= min && x.s <= 0) continue; out.push(x.i); names.add(nm); }
  for (const x of idx) { if (out.length >= Math.max(min, Math.min(max, out.length))) break; if (!out.includes(x.i) && (out.length < min || x.s > 0)) out.push(x.i); }
  for (const x of idx) { if (out.length >= max) break; if (!out.includes(x.i) && x.s > 0) out.push(x.i); }
  return { chosen: out.slice(0, max) };
}
