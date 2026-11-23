// engine-chars.js — computed characteristics (simplified layer system), filter matching, ability lists.
// Mixed into the Game prototype (methods use `this`).
import { cmp, colorLetter, PERMANENT_TYPES, BASIC_LAND_MANA, parseManaCost, FACE_DOWN_DEF, FACE_DOWN_WARD_DEF, CREATURE_TYPES } from "./engine-util.js";
import { kwSynth } from "./kw-synth.js";

const EMPTY_C = { name: "?", types: [], subtypes: [], supertypes: [], colors: [], keywords: {}, abilities: [], power: 0, toughness: 0, cmc: 0 };
const LAND_SUBS = new Set(["plains", "island", "swamp", "mountain", "forest", "desert", "gate", "lair", "locus", "cave", "sphere", "mine", "tower", "power-plant", "urza's", "town"]);
const NONCREATURE_SUBS = new Set(["treasure", "food", "clue", "blood", "map", "equipment", "vehicle", "aura", "saga", "curse", "shrine", "gold", "powerstone", "incubator", "junk", "shard", "fortification", "arcane", "trap", "adventure", "lesson", "spacecraft"]);
const SYNTH = new WeakMap();

export function hasType(c, t) {
  if (!c || !t) return false;
  t = String(t).toLowerCase();
  if (t === "permanent") return c.types.some((x) => PERMANENT_TYPES.includes(x));
  if (t === "card" || t === "spell" || t === "any" || t === "object") return true;
  if (t === "nonland") return !c.types.includes("land");
  if (t === "noncreature") return !c.types.includes("creature");
  return c.types.includes(t);
}
export function hasSub(c, s) {
  s = String(s).toLowerCase();
  if (c.subtypes.includes(s)) return true;
  return !!c.allCreatureTypes && !LAND_SUBS.has(s) && !NONCREATURE_SUBS.has(s);
}
const num = (v) => (typeof v === "number" ? v : v == null || v === "*" || isNaN(+v) ? 0 : +v);

/** Synthesised abilities from keywords (equip, cycling, prowess, ...) + intrinsic basic-land mana abilities. Cached per def. */
function synthAbilities(d) {
  let hit = SYNTH.get(d);
  if (hit) return hit;
  const out = [...d.abilities];
  const kw = d.keywords || {};
  const costStr = (v) => (typeof v === "string" ? v : typeof v === "object" && v ? v.cost || v.mana || "" : "{0}");
  if (kw.equip != null && kw.equip !== false)
    out.push({ kind: "activated", synthetic: "equip", sorcery: true, cost: { mana: costStr(kw.equip) === "" ? "{0}" : costStr(kw.equip) },
      targets: [{ what: { types: ["creature"], controller: "you", other: true } }],
      effects: [{ op: "attach", what: "self", to: { ref: "target", i: 0 } }], text: `Equip ${costStr(kw.equip)}` });
  if (kw.cycling != null && kw.cycling !== false)
    out.push({ kind: "activated", synthetic: "cycle", zone: "hand", cost: { mana: costStr(kw.cycling), discardSelf: true },
      effects: [{ op: "draw", who: "you", amount: 1 }], text: `Cycling ${costStr(kw.cycling)}` });
  if (kw.prowess)
    out.push({ kind: "triggered", synthetic: "prowess", on: { event: "cast", who: "you", filter: { notTypes: ["creature"] } },
      effects: [{ op: "pump", what: "self", power: 1, toughness: 1, until: "endOfTurn" }], text: "Prowess" });
  if (kw.undying)
    out.push({ kind: "triggered", synthetic: "undying", on: { event: "dies", who: "self" }, effects: [{ op: "_returnWithCounter", kind: "+1/+1", unless: "+1/+1" }], text: "Undying" });
  if (kw.persist)
    out.push({ kind: "triggered", synthetic: "persist", on: { event: "dies", who: "self" }, effects: [{ op: "_returnWithCounter", kind: "-1/-1", unless: "-1/-1" }], text: "Persist" });
  if (kw.exploit)
    out.push({ kind: "triggered", synthetic: "exploit", on: { event: "enters", who: "self" }, effects: [{ op: "_exploit" }], text: "Exploit" });
  if (kw.annihilator)
    out.push({ kind: "triggered", synthetic: "annihilator", on: { event: "attacks", who: "self" },
      effects: [{ op: "sacrifice", who: { ref: "event", what: "player" }, filter: { types: ["permanent"] }, amount: num(kw.annihilator) || 1 }], text: `Annihilator ${kw.annihilator}` });
  if (kw.echo)
    out.push({ kind: "triggered", synthetic: "echo", on: { event: "beginStep", step: "upkeep", whose: "you" }, condition: { type: "_echoDue" },
      effects: [{ op: "_echo", cost: costStr(kw.echo) }], text: `Echo ${costStr(kw.echo)}` });
  if (kw.storm)
    out.push({ kind: "triggered", synthetic: "storm", zone: "stack", on: { event: "cast", who: "self" }, effects: [{ op: "_storm" }], text: "Storm" });
  if (kw.afterlife) // "When this creature dies, create N 1/1 white and black Spirit creature tokens with flying."
    out.push({ kind: "triggered", synthetic: "afterlife", on: { event: "dies", who: "self" },
      effects: [{ op: "createToken", who: "you", amount: num(kw.afterlife) || 1, token: { name: "Spirit", types: ["creature"], subtypes: ["spirit"], colors: ["W", "B"], power: 1, toughness: 1, keywords: { flying: true } } }], text: `Afterlife ${kw.afterlife}` });
  if (kw.typecycling && typeof kw.typecycling === "object") // basic landcycling / <type>cycling: search for that card instead of drawing
    out.push({ kind: "activated", synthetic: "cycle", zone: "hand", cost: { mana: kw.typecycling.cost, discardSelf: true },
      effects: [{ op: "search", who: "you", filter: kw.typecycling.filter, min: 0, max: 1, to: "hand", reveal: true }], text: `${kw.typecycling.text}cycling ${kw.typecycling.cost}` });
  if (kw.unearth && typeof kw.unearth === "string") // "{cost}: Return this card from your graveyard to the battlefield. It gains haste. Exile it at the beginning of the next end step or if it would leave the battlefield. Unearth only as a sorcery."
    out.push({ kind: "activated", synthetic: "unearth", zone: "graveyard", sorcery: true, cost: { mana: costStr(kw.unearth) }, effects: [{ op: "_unearth" }], text: `Unearth ${costStr(kw.unearth)}` });
  if (kw.suspend && typeof kw.suspend === "object") // upkeep: remove a time counter; when the last is removed, cast it without paying its mana cost (CR 702.62)
    out.push({ kind: "triggered", synthetic: "suspend", zone: "exile", on: { event: "beginStep", step: "upkeep", whose: "you" }, condition: { type: "_suspended" }, effects: [{ op: "_suspendTick" }], text: `Suspend ${kw.suspend.n}` });
  if (kw.cascade)
    out.push({ kind: "triggered", synthetic: "cascade", zone: "stack", on: { event: "cast", who: "self" }, effects: [{ op: "_cascade" }], text: "Cascade" });
  if (kw.increment) // "Whenever you cast a spell, if the amount of mana you spent is greater than this creature's power or toughness, put a +1/+1 counter on this creature."
    out.push({ kind: "triggered", synthetic: "increment", on: { event: "cast", who: "you" },
      condition: { type: "or", any: [{ type: "compare", a: { event: "manaSpent" }, op: ">", b: { powerOf: "self" } }, { type: "compare", a: { event: "manaSpent" }, op: ">", b: { toughnessOf: "self" } }] },
      effects: [{ op: "addCounters", what: "self", kind: "+1/+1", amount: 1 }], text: "Increment" });
  if (kw.craft && typeof kw.craft === "object") // Craft with X {cost}: {cost}, exile this artifact, exile X you control / X card from your graveyard: return it transformed. Sorcery speed.
    out.push({ kind: "activated", synthetic: "craft", sorcery: true, cost: { mana: kw.craft.cost || "{0}", exileSelf: true, craftWith: kw.craft.with || { types: ["creature"] }, craftCount: kw.craft.n || 1 },
      effects: [{ op: "_craftReturn" }], text: `Craft with ${kw.craft.text || "a creature"} ${kw.craft.cost || ""}`.trim() });
  out.push(...kwSynth(kw)); // crew, evolve, exalted, myriad, ... (library batch m2)
  // intrinsic mana abilities of basic land types
  if (d.types.includes("land")) {
    const produced = new Set();
    for (const a of d.abilities) if (a.kind === "activated" && a.mana) for (const col of manaColorsOf(a.effects)) produced.add(col);
    for (const s of d.subtypes) {
      const col = BASIC_LAND_MANA[s];
      if (col && !produced.has(col)) {
        produced.add(col);
        out.push({ kind: "activated", synthetic: "intrinsic", cost: { tap: true }, mana: true, effects: [{ op: "addMana", mana: `{${col}}` }], text: `{T}: Add {${col}}.` });
      }
    }
  }
  SYNTH.set(d, out);
  return out;
}

/** Colours (W..C, or "*" for any) an effect list can add. Static, conservative. */
export function manaColorsOf(effects) {
  const out = new Set();
  const walk = (list) => {
    for (const e of list || []) {
      if (!e || typeof e !== "object") continue;
      if (e.op === "addMana") {
        const m = e.mana;
        if (typeof m === "string") { const p = parseManaCost(m); for (const k of ["W", "U", "B", "R", "G", "C"]) if (p[k]) out.add(k); if (p.generic) out.add("C"); }
        else if (m && m.anyOf) for (const k of m.anyOf) out.add(colorLetter(k));
        else if (m && (m.any || m.identity)) out.add("*");
      }
      if (e.then) walk(e.then);
      if (e.else) walk(e.else);
    }
  };
  walk(effects);
  return [...out].filter(Boolean);
}

export const charMethods = {
  /** The CardDef currently describing obj (face-aware, copy-aware). */
  faceDef(o) {
    if (o.faceDown && (o.zone === "battlefield" || o.zone === "stack" || o.zone === "phased")) return o.faceDownWard ? FACE_DOWN_WARD_DEF : FACE_DOWN_DEF;
    if (o.mergeDef) return o.mergeDef;
    const d = o.copyDef || o.def;
    if (o.face && d.faces && d.faces[o.face]) return d.faces[o.face];
    return d;
  },
  /** Copiable values (CR 707.2): face-down 2/2, merged (mutate) values, a copy's copied values, or the current face. */
  copiableDef(o) {
    if (!o) return null;
    if (o.faceDown && (o.zone === "battlefield" || o.zone === "stack" || o.zone === "phased" || o.lki)) return o.faceDownWard ? FACE_DOWN_WARD_DEF : FACE_DOWN_DEF;
    if (o.mergeDef) return o.mergeDef;
    const d = o.copyDef || o.def;
    if (!o.copyDef && o.face && d.faces && d.faces[o.face]) return d.faces[o.face];
    return d;
  },

  baseAbilities(o) {
    if (o.isAbility) return [];
    return synthAbilities(this.faceDef(o));
  },

  /** Base characteristics (no continuous effects). */
  baseC(o) {
    if (o.isAbility) return o.c;
    const d = this.faceDef(o);
    const c = {
      name: d.name, types: [...d.types], subtypes: [...d.subtypes], supertypes: [...d.supertypes], colors: [...d.colors],
      power: d.power == null ? undefined : num(d.power), toughness: d.toughness == null ? undefined : num(d.toughness),
      loyalty: d.loyalty, keywords: { ...d.keywords }, cost: d.cost, cmc: d.cmc, text: d.text, img: d.img || o.img || null,
      unparsed: d.unparsed, abilities: this.baseAbilities(o), identity: d.identity,
    };
    if (c.keywords.changeling) c.allCreatureTypes = true;
    if (c.keywords.devoid) c.colors = [];
    if (o.zone === "stack" && o.x != null && d.cost && /\{X\}/i.test(d.cost)) c.cmc = d.cmc + o.x * (d.cost.match(/\{X\}/gi) || []).length;
    if (c.types.includes("planeswalker")) c.loyalty = o.zone === "battlefield" ? o.counters.loyalty | 0 : num(d.loyalty);
    return c;
  },

  markDirty() { this._dirty = true; },

  /** Recompute obj.c for battlefield + stack objects, player-level static flags, controllers.
   *  Statics whose amounts/conditions read power or toughness are re-evaluated until the P/T values are stable
   *  (no stale reads of the previous refresh). */
  refresh(force) {
    if (!this._dirty && !force) return;
    let before = this._ptDep ? this._ptSig() : null;
    this._refreshOnce();
    for (let pass = 0; pass < 3 && this._ptDep; pass++) {
      const now = this._ptSig();
      if (now === before) break;
      before = now;
      this._refreshOnce();
    }
  },
  _ptSig() {
    let s = "";
    for (const id of this.state.battlefield) { const o = this.state.objects[id]; if (o && o.c) s += o.c.power + "/" + o.c.toughness + ","; }
    return s;
  },
  _refreshOnce() {
    this._dirty = false;
    const st = this.state;
    const bf = [];
    for (const id of st.battlefield) { const o = st.objects[id]; if (o) bf.push(o); }
    // controllers (layer 2) first: control-changing effects in timestamp order
    for (const o of bf) {
      let ctl = o.baseController ?? o.owner;
      for (const ce of st.controlEffects) if (ce.objId === o.id) ctl = ce.controller;
      if (o.controller !== ctl) { o.controller = ctl; }
    }
    // gather statics
    const statics = [];
    for (const o of bf) {
      for (const ab of this.baseAbilities(o)) if (ab.kind === "static" && ab.effect && typeof ab.effect === "object") statics.push({ src: o, st: ab.effect, cond: ab.condition, ts: o.ts, you: o.controller, own: true });
      if (o.c && o.c.abilities !== this.baseAbilities(o)) // granted static abilities (e.g. by equipment)
        for (const ab of o.c.abilities) if (ab.kind === "static" && ab.effect && ab._granted) statics.push({ src: o, st: ab.effect, cond: ab.condition, ts: o.ts + 0.5, you: o.controller, own: true });
    }
    for (const e of st.effects) {
      const src = st.objects[e.sourceId] || e.sourceSnap || null;
      statics.push({ src, st: e.static, ts: e.ts, you: e.you, objIds: e.objIds, eff: e });
    }
    const act = [];
    for (const s of statics) {
      let ok = true;
      if (s.cond) { try { ok = this.evalCond(s.cond, { source: s.src, you: s.you, quiet: true }); } catch { ok = false; } }
      if (ok) act.push(s);
    }
    act.sort((a, b) => a.ts - b.ts);
    this._statics = act;
    this._ptDep = statics.some((s) => readsPT(s.st) || (s.cond && readsPT(s.cond)));

    // pass 1: base + type-changing
    const prevPow = new Map();
    for (const o of bf) {
      prevPow.set(o.id, o.c ? [o.c.power, o.c.toughness] : null);
      const c = this.baseC(o);
      const pp = prevPow.get(o.id);
      if (pp) { c.power = pp[0] ?? c.power; c.toughness = pp[1] ?? c.toughness; }
      o.c = c;
    }
    for (const pl of st.players) if (pl.ring.bearer) { const b = st.objects[pl.ring.bearer]; if (b && b.zone === "battlefield" && !b.c.supertypes.includes("legendary")) b.c.supertypes.push("legendary"); }
    for (const s of act) {
      if (s.st.type !== "asType") continue;
      for (const o of bf) if (this._affects(s, o)) {
        const c = o.c;
        if (s.st.setTypes) c.types = [...s.st.setTypes];
        if (s.st.setSubtypes) c.subtypes = s.st.setSubtypes.map((x) => String(x).toLowerCase());
        for (const t of s.st.addTypes || []) if (!c.types.includes(t)) c.types.push(String(t).toLowerCase());
        for (const t of s.st.addSubtypes || []) if (!c.subtypes.includes(t)) c.subtypes.push(String(t).toLowerCase());
        if (s.st.allCreatureTypes) c.allCreatureTypes = true;
        if (s.st.colors) c.colors = s.st.colors.map(colorLetter).filter(Boolean);
      }
    }
    // pass 2: abilities / keywords / rule flags
    for (const s of act) {
      const t = s.st.type;
      if (t === "pump" || t === "asType") {
        const kws = s.st.keywords, abs = s.st.abilities;
        if ((!kws || !kws.length) && (!abs || !abs.length) && !s.st.removeKeywords) continue;
        for (const o of bf) if (this._affects(s, o)) {
          for (const k of kws || []) addKw(o.c, k);
          for (const k of s.st.removeKeywords || []) delete o.c.keywords[String(k).toLowerCase()];
          if (abs && abs.length) {
            if (o.c.abilities === this.baseAbilities(o)) o.c.abilities = [...o.c.abilities];
            for (const a of abs) if (a && typeof a === "object") o.c.abilities.push({ ...a, _granted: true, _grantedBy: s.src?.id });
          }
        }
      } else if (t === "activateAsHaste") {
        for (const o of bf) if (this._affects(s, o)) o.c.activateAsHaste = true;
      } else if (t === "cantBlock" || t === "cantAttack" || t === "mustAttack" || t === "cantBeBlocked" || t === "cantBeCountered" || t === "mustBlock") {
        for (const o of bf) if (this._affects(s, o)) {
          if (t === "cantBeBlocked") (o.c.unblockable ||= []).push(s.st.exceptBy || null);
          else o.c[t] = true;
        }
      }
    }
    this.m2Refresh(bf, act); // goaded / suspected flags, granted keyword abilities (engine-m2.js)
    // pass 3: P/T. Every amount and "affects" filter is evaluated first, while all objects still carry their previous
    // complete P/T (refresh() iterates until stable), then the printed values are reset and the results applied.
    const setOps = [], pumpOps = [];
    for (const s of act) {
      const t = s.st.type;
      if (t === "setPT" || t === "setBasePT" || (t === "asType" && (s.st.power != null || s.st.toughness != null))) {
        for (const o of bf) if (this._affects(s, o)) {
          const ctx = { source: s.src || o, you: s.you };
          setOps.push([o, s.st.power != null ? this.amount(s.st.power, ctx) : null, s.st.toughness != null ? this.amount(s.st.toughness, ctx) : null]);
        }
      } else if (t === "pump" && (s.st.power || s.st.toughness)) {
        const fixed = s.eff && s.eff.fixedPT; // locked amounts for resolved effects
        for (const o of bf) if (this._affects(s, o)) {
          const ctx = { source: s.src || o, you: s.you, x: s.eff?.x, obj: o };
          pumpOps.push([o, fixed ? fixed[0] : this.amount(s.st.power || 0, ctx), fixed ? fixed[1] : this.amount(s.st.toughness || 0, ctx)]);
        }
      }
    }
    for (const o of bf) { const d = this.faceDef(o); o.c.power = num(d.power); o.c.toughness = num(d.toughness); }
    for (const [o, pw, tg] of setOps) { if (pw != null) o.c.power = pw; if (tg != null) o.c.toughness = tg; }
    for (const [o, pw, tg] of pumpOps) { o.c.power += pw; o.c.toughness += tg; }
    for (const o of bf) {
      const c = o.c;
      for (const k in o.counters) {
        const m = /^([+-]?\d+)\/([+-]?\d+)$/.exec(k);
        if (m) { c.power += +m[1] * o.counters[k]; c.toughness += +m[2] * o.counters[k]; }
        else if (k !== "loyalty" && o.counters[k] > 0 && KW_COUNTERS.has(k)) addKw(c, k);
      }
      if (c.types.includes("planeswalker")) c.loyalty = o.counters.loyalty | 0;
      if (!c.types.includes("creature") && o.def.power == null && !c._animated) { c.power = undefined; c.toughness = undefined; }
    }
    // stack objects
    for (const id of st.stack) { const o = st.objects[id]; if (o && !o.isAbility) o.c = this.baseC(o); }
    // player-level statics
    for (const pl of st.players) { pl.landsPerTurn = 1; pl.noMaxHand = false; pl.protection = false; pl.flashSorceries = false; pl.lifeLocked = false; }
    this._noPrevent = false;
    for (const s of act) {
      const t = s.st.type, p = st.players[s.you];
      if (t === "cantPrevent") { this._noPrevent = true; continue; }
      if (!p) continue;
      if (t === "extraLand") p.landsPerTurn += num(s.st.n ?? s.st.amount ?? 1) || 1;
      else if (t === "noMaxHand") p.noMaxHand = true;
      else if (t === "playerProtection") { p.protection = true; if (s.st.lifeLocked) p.lifeLocked = true; }
      else if (t === "lifeCantChange") p.lifeLocked = true;
      else if (t === "castAsFlash" || t === "flashSorceries") p.flashSorceries = true;
    }
  },

  _affects(s, o) {
    if (s.objIds) return s.objIds.includes(o.id);
    let a = s.st.affects;
    if (a == null) a = "self";
    if (a === "self") return !!s.src && s.src.id === o.id;
    if (a === "equipped" || a === "enchanted" || a === "attached") return !!s.src && s.src.attachedTo === o.id && s.src.zone === "battlefield";
    if (a === "you" || a === "opponent" || a === "each") return false;
    return this.matches(o, a, { source: s.src, you: s.you });
  },

  hasKw(o, k) {
    if (!o || !o.c) return false;
    const v = o.c.keywords[String(k).toLowerCase()];
    return v != null && v !== false;
  },
  kw(o, k) { return o?.c?.keywords?.[k]; },

  isCreature(o) { return !!o && o.zone === "battlefield" && o.c.types.includes("creature"); },

  /** Filter matching (SPEC §5). `o` may be an Obj, an obj id, or a player id "P0". */
  matches(o, f, ctx, defZone = "battlefield") {
    if (o == null) return false;
    if (typeof o === "string") {
      if (/^P\d+$/.test(o)) return this.matchesPlayer(+o.slice(1), f, ctx);
      o = this.state.objects[o];
      if (!o) return false;
    }
    if (typeof o === "number") return this.matchesPlayer(o, f, ctx);
    if (f == null || f === true) return true;
    if (typeof f === "string") return this._matchStr(o, f, ctx, defZone);
    if (Array.isArray(f)) return f.some((x) => this.matches(o, x, ctx, defZone));
    if (typeof f !== "object") return false;
    if (f.player === true) return false;
    const c = o.c || EMPTY_C;
    const z = f.zone ?? defZone;
    if (z && z !== "any" && z !== "*") { if (Array.isArray(z) ? !z.includes(o.zone) : o.zone !== z) return false; }
    const you = ctx ? ctx.you : undefined, src = ctx ? ctx.source : undefined;
    if (f.self && (!src || src.id !== o.id)) return false;
    if (f.other && src && src.id === o.id) return false;
    if (f.types && f.types.length && !f.types.some((t) => hasType(c, t))) return false;
    if (f.allTypes && !f.allTypes.every((t) => hasType(c, t))) return false;
    if (f.notTypes && f.notTypes.some((t) => hasType(c, t))) return false;
    if (f.subtypes && f.subtypes.length && !f.subtypes.some((s) => hasSub(c, s))) return false;
    if (f.notSubtypes && f.notSubtypes.some((s) => hasSub(c, s))) return false;
    if (f.supertypes && f.supertypes.length && !f.supertypes.every((s) => c.supertypes.includes(String(s).toLowerCase()))) return false;
    if (f.notSupertypes && f.notSupertypes.some((s) => c.supertypes.includes(String(s).toLowerCase()))) return false;
    if (f.controller && !relMatch(o.controller, f.controller, you, this)) return false;
    if (f.owner && !relMatch(o.owner, f.owner, you, this)) return false;
    if (f.token != null && !!o.token !== !!f.token) return false;
    if (f.nontoken && o.token) return false;
    if (f.colors && f.colors.length && !colorMatch(c.colors, f.colors)) return false;
    if (f.notColors && f.notColors.length && colorMatch(c.colors, f.notColors)) return false;
    if (f.cmc && typeof f.cmc === "object" && !cmp(c.cmc, f.cmc.op, this.amount(f.cmc.n, ctx))) return false;
    if (f.power && typeof f.power === "object" && !cmp(c.power, f.power.op, this.amount(f.power.n, ctx))) return false;
    if (f.toughness && typeof f.toughness === "object" && !cmp(c.toughness, f.toughness.op, this.amount(f.toughness.n, ctx))) return false;
    if (f.tapped != null && !!o.tapped !== !!f.tapped) return false;
    if (f.attacking != null && this.isAttacking(o) !== !!f.attacking) return false;
    if (f.blocking != null && this.isBlocking(o) !== !!f.blocking) return false;
    if (f.keywords && f.keywords.length && !f.keywords.every((k) => this.hasKw(o, k))) return false;
    if (f.notKeywords && f.notKeywords.some((k) => this.hasKw(o, k))) return false;
    if (f.name != null && (Array.isArray(f.name) ? !f.name.includes(c.name) : c.name !== f.name)) return false;
    if (f.isCommander != null && !!o.isCommander !== !!f.isCommander) return false;
    if (f.ringBearer != null && this.isRingBearer(o) !== !!f.ringBearer) return false;
    if (f.counters && typeof f.counters === "object" && !((o.counters?.[f.counters.kind] | 0) > 0)) return false;
    if (f.chosenType && !(src && src.chosen && src.chosen.creatureType && hasSub(c, src.chosen.creatureType))) return false;
    if (f.notChosenType && src && src.chosen && src.chosen.creatureType && hasSub(c, src.chosen.creatureType)) return false;
    if (f.sharesTypeWithCommander && !this.sharesTypeWithCommander(o, you)) return false;
    if (f.faceDown != null && !!o.faceDown !== !!f.faceDown) return false;
    if (!this.m2Matches(o, f, c)) return false;
    if (f.not && this.matches(o, f.not, ctx, "*")) return false;
    if (f.anyOf && Array.isArray(f.anyOf) && f.anyOf.length && !f.anyOf.some((x) => this.matches(o, x, ctx, "*"))) return false;
    return true;
  },

  _matchStr(o, f, ctx, defZone) {
    const s = f.toLowerCase();
    if (s === "self") return !!ctx?.source && ctx.source.id === o.id;
    if (s === "any") return o.zone === "battlefield" && (hasType(o.c, "creature") || hasType(o.c, "planeswalker"));
    if (s === "spell") return o.zone === "stack";
    if (s === "player" || s === "opponent" || s === "you") return false;
    if (defZone && defZone !== "*" && o.zone !== defZone) return false;
    return hasType(o.c, s);
  },

  matchesPlayer(p, f, ctx) {
    const you = ctx ? ctx.you : undefined;
    const pl = this.state.players[p];
    if (!pl) return false;
    if (f == null || f === true) return true;
    if (typeof f === "string") {
      const s = f.toLowerCase();
      if (s === "player" || s === "any" || s === "each" || s === "eachplayer") return true;
      if (s === "opponent") return p !== you;
      if (s === "you") return p === you;
      return false;
    }
    if (Array.isArray(f)) return f.some((x) => this.matchesPlayer(p, x, ctx));
    if (typeof f !== "object") return false;
    if (f.anyOf && Array.isArray(f.anyOf)) {
      const outer = { ...f }; delete outer.anyOf;
      if (Object.keys(outer).length && !this.matchesPlayer(p, { ...outer, player: true }, ctx)) return false;
      return f.anyOf.some((x) => this.matchesPlayer(p, x, ctx));
    }
    if (f.player !== true) return false;
    if (f.controller && !relMatch(p, f.controller, you, this)) return false;
    if (f.owner && !relMatch(p, f.owner, you, this)) return false;
    return true;
  },

  /** Creature types of an object's characteristics ("all" for changelings). */
  creatureTypesOf(c) {
    if (!c) return [];
    if (c.allCreatureTypes) return "all";
    return (c.subtypes || []).filter((t) => CREATURE_TYPE_SET.has(t));
  },
  /** Does `o` share a creature type with a commander of player p? */
  sharesTypeWithCommander(o, p) {
    const pl = this.state.players[p];
    if (!pl || !o || !o.c) return false;
    const mine = this.creatureTypesOf(o.c);
    if (mine !== "all" && !mine.length) return false;
    for (const id of pl.commanders) {
      const cm = this.state.objects[id];
      const theirs = this.creatureTypesOf(cm && cm.c);
      if (theirs !== "all" && !theirs.length) continue;
      if (mine === "all" || theirs === "all" || mine.some((t) => theirs.includes(t))) return true;
    }
    return false;
  },

  isAttacking(o) {
    const cb = this.state.combat;
    return !!cb && cb.attackers.some((a) => a.obj === o.id);
  },
  isBlocking(o) {
    const cb = this.state.combat;
    return !!cb && cb.attackers.some((a) => a.blockers.includes(o.id));
  },
  isRingBearer(o) {
    const p = this.state.players[o.controller];
    return !!p && p.ring.bearer === o.id && o.zone === "battlefield";
  },

  /** g.find(filter, ctx) -> Obj[] in any zone (filter.zone, default battlefield). */
  find(filter, ctx = {}) {
    const st = this.state;
    let zone = filter && typeof filter === "object" && !Array.isArray(filter) ? filter.zone : null;
    if (filter && typeof filter === "object" && !zone && Array.isArray(filter.anyOf)) {
      const zs = filter.anyOf.map((x) => x && x.zone).filter(Boolean);
      if (zs.length) zone = zs.length === 1 ? zs[0] : "any";
    }
    const ids = [];
    const zones = zone == null ? ["battlefield"] : zone === "any" || zone === "*" ? ["battlefield", "stack", "hand", "graveyard", "exile", "library", "command"] : Array.isArray(zone) ? zone : [zone];
    for (const z of zones) {
      if (z === "battlefield") ids.push(...st.battlefield);
      else if (z === "stack") ids.push(...st.stack);
      else for (const p of st.players) if (Array.isArray(p[z])) ids.push(...p[z]);
    }
    const out = [];
    for (const id of ids) { const o = st.objects[id]; if (o && this.matches(o, filter, ctx, "*")) out.push(o); }
    return out;
  },
};

const CREATURE_TYPE_SET = new Set(CREATURE_TYPES);
const PT_DEP = new WeakMap();
const PT_RE = /"(?:powerOf|toughnessOf|greatestPower|totalPower|sum|greatest)"|"(?:power|toughness)":\{"op"/;
/** Does a static / condition read power or toughness of objects (so its result can depend on other statics)? */
function readsPT(x) {
  if (!x || typeof x !== "object") return false;
  let v = PT_DEP.get(x);
  if (v == null) { let j = ""; try { j = JSON.stringify(x); } catch { j = ""; } v = PT_RE.test(j); PT_DEP.set(x, v); }
  return v;
}

const KW_COUNTERS = new Set(["flying", "first strike", "double strike", "deathtouch", "hexproof", "indestructible", "lifelink", "menace", "reach", "trample", "vigilance", "haste", "shroud"]);

function addKw(c, k) {
  if (k == null) return;
  if (typeof k === "object") {
    for (const [kk, vv] of Object.entries(k)) {
      const key = kk.toLowerCase();
      if (key === "protection" && c.keywords.protection) c.keywords.protection = [...[].concat(c.keywords.protection), ...[].concat(vv)];
      else c.keywords[key] = vv;
    }
    return;
  }
  const key = String(k).toLowerCase();
  if (key === "changeling") c.allCreatureTypes = true;
  if (c.keywords[key] == null || c.keywords[key] === false) c.keywords[key] = true;
}

function relMatch(pidx, rel, you, g) {
  if (rel == null || rel === "any" || rel === "each") return true;
  if (typeof rel === "number") return pidx === rel;
  if (rel === "you") return pidx === you;
  if (rel === "opponent" || rel === "opponents" || rel === "notYou") return pidx != null && pidx !== you;
  if (typeof rel === "string" && /^P\d+$/.test(rel)) return pidx === +rel.slice(1);
  return true;
}

function colorMatch(objColors, want) {
  for (const w of want) {
    const s = String(w).toLowerCase();
    if (s === "colorless") { if (!objColors.length) return true; continue; }
    if (s === "multicolored") { if (objColors.length > 1) return true; continue; }
    if (s === "monocolored") { if (objColors.length === 1) return true; continue; }
    const l = colorLetter(w);
    if (l && objColors.includes(l)) return true;
  }
  return false;
}
