// engine-effects.js — executor for the ability IR (SPEC §5): effects, refs, amounts, conditions.
// Mixed into Game. Every generator ends in `$` and is called with `yield*`.
import { cmp, colorLetter, parseManaCost, manaStringToPool, MANA_KEYS, tokenDef, cap } from "./engine-util.js";
import { hasType } from "./engine-chars.js";

const ALL5 = ["W", "U", "B", "R", "G"];
const isPid = (id) => typeof id === "string" && /^P\d+$/.test(id);
const pidx = (id) => +id.slice(1);
const pid = (i) => "P" + i;
const asArr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

export const effectMethods = {
  // ---------------------------------------------------------------- refs
  /** Resolve a Ref to ids ("P0" / obj ids). Sync; {ref:"choose"} is not handled here (see refs$). */
  refsSync(ref, ctx) {
    const st = this.state;
    if (ref == null) return [];
    if (Array.isArray(ref)) return ref.flatMap((r) => this.refsSync(r, ctx));
    if (typeof ref === "string") {
      switch (ref) {
        case "self": case "this": return ctx.source ? [ctx.source.id] : [];
        case "you": case "controller": return ctx.you != null ? [pid(ctx.you)] : [];
        case "opponent": case "opponents": case "eachOpponent": case "each opponent": return this.opponentsOf(ctx.you).map(pid);
        case "eachPlayer": case "each": case "players": case "all players": return this.alivePlayers(true).map(pid);
        case "equipped": case "enchanted": case "attached": { const s = ctx.source && st.objects[ctx.source.id]; return s && s.attachedTo ? [s.attachedTo] : []; }
        case "it": return [...(ctx.it || [])];
        case "target": return this.refsSync({ ref: "target", i: 0 }, ctx);
        case "activePlayer": return [pid(st.active)];
        case "defendingPlayer": return this.refsSync({ ref: "defendingPlayer" }, ctx);
        default:
          if (isPid(ref) || st.objects[ref]) return [ref];
          return [];
      }
    }
    if (typeof ref !== "object") return [];
    switch (ref.ref) {
      case "target": {
        const i = ref.i | 0;
        if (ctx.overload) {
          const spec = (ctx.overloadSpecs || ctx.targetSpecs || [])[i];
          if (spec) return this.overloadAll(spec, ctx);
        }
        return [...((ctx.targets || [])[i] || [])];
      }
      case "all": case "each": {
        const f = ref.filter ?? {};
        const out = [];
        if (f && typeof f === "object" && (f.player || (Array.isArray(f.anyOf) && f.anyOf.some((x) => x && x.player))))
          for (const p of this.alivePlayers(true)) if (this.matchesPlayer(p, f, ctx)) out.push(pid(p));
        for (const o of this.find(f, ctx)) out.push(o.id);
        return out;
      }
      case "event": {
        const ev = ctx.event || {};
        const w = ref.what || "object";
        if (w === "player") return ev.player != null ? [pid(ev.player)] : ev.obj ? [pid(ev.obj.controller)] : [];
        if (w === "source") return ev.source ? [ev.source.id] : [];
        if (w === "target") return ev.target ? [ev.target] : [];
        if (w === "controller") return ev.obj ? [pid(ev.obj.controller)] : [];
        if (w === "ability") return ev.ability ? [ev.ability] : [];
        return ev.obj ? [ev.obj.id] : ev.objs ? ev.objs.map((o) => o.id) : [];
      }
      case "it": return [...(ctx.it || [])];
      case "controllerOf": case "ownerOf": {
        const ids = this.refsSync(ref.of, ctx);
        const out = [];
        for (const id of ids) {
          if (isPid(id)) { out.push(id); continue; }
          const o = st.objects[id];
          const lk = ctx.event?.obj?.id === id ? ctx.event.obj : null;
          if (o) { const p = ref.ref === "ownerOf" ? o.owner : (o.zone === "battlefield" || o.zone === "stack" ? o.controller : lk ? lk.controller : (o.lki?.controller ?? o.controller)); if (!out.includes(pid(p))) out.push(pid(p)); }
        }
        return out;
      }
      case "defendingPlayer": {
        const ev = ctx.event;
        if (ev && ev.player != null && ev.type === "attacks") return [pid(ev.player)];
        const cb = st.combat;
        if (cb && ctx.source) { const a = cb.attackers.find((x) => x.obj === ctx.source.id); if (a) return [pid(this.defenderPlayer(a.defender))]; }
        return this.opponentsOf(ctx.you).slice(0, 1).map(pid);
      }
      case "self": return ctx.source ? [ctx.source.id] : [];
      case "you": return [pid(ctx.you)];
      case "sacrificed": return (ctx.sacrificed || []).map((o) => o.id);
      case "choose": return []; // only via refs$
      default: return [];
    }
  },

  /** Generator version supporting {ref:"choose"} (non-targeted choice on resolution). */
  *refs$(ref, ctx) {
    if (ref && typeof ref === "object" && !Array.isArray(ref) && ref.ref === "choose") {
      const chooserIds = ref.chooser ? this.refsSync(ref.chooser, ctx) : [pid(ctx.you)];
      const out = [];
      for (const cid of chooserIds) {
        const chooser = isPid(cid) ? pidx(cid) : this.state.objects[cid]?.controller ?? ctx.you;
        const cctx = { ...ctx, you: chooser };
        const objs = this.find(ref.filter ?? {}, ref.chooser ? cctx : ctx);
        const min = Math.min(this.amount(ref.min ?? 1, ctx), objs.length);
        const max = Math.min(this.amount(ref.max ?? ref.min ?? 1, ctx), objs.length);
        const picked = yield* this.chooseObjects$(chooser, objs, { prompt: ref.prompt || "Choose", min, max, reason: ref.reason || "generic", source: ctx.source?.id, hint: { kind: "choose", effects: this._curEffect ? [this._curEffect] : [], ref } });
        out.push(...picked.map((o) => o.id));
      }
      return out;
    }
    return this.refsSync(ref, ctx);
  },

  overloadAll(spec, ctx) {
    const what = spec.what ?? spec.filter;
    if (what === "any") return [...this.alivePlayers(true).filter((p) => p !== ctx.you).map(pid), ...this.find({ types: ["creature", "planeswalker"] }, ctx).map((o) => o.id)];
    if (what === "player" || what === "opponent") return this.opponentsOf(ctx.you).map(pid);
    return this.find(typeof what === "object" ? what : { types: [what] }, ctx).map((o) => o.id);
  },

  playersOf(ids) {
    const out = [];
    for (const id of ids) {
      let p = null;
      if (isPid(id)) p = pidx(id);
      else { const o = this.state.objects[id]; if (o) p = o.controller; }
      if (p != null && !out.includes(p) && this.state.players[p]) out.push(p);
    }
    return out;
  },
  objsOf(ids) {
    const out = [];
    for (const id of ids) if (!isPid(id)) { const o = this.state.objects[id]; if (o && !out.includes(o)) out.push(o); }
    return out;
  },
  /** Object or LKI for amount computations. */
  lkiOf(id, ctx) {
    const o = this.state.objects[id];
    if (!o) return null;
    if (o.zone === "battlefield" || o.zone === "stack") return o;
    if (ctx?.event?.obj?.id === id && ctx.event.obj.lki) return ctx.event.obj;
    return o.lki || o;
  },

  // ---------------------------------------------------------------- amounts
  amount(A, ctx = {}) {
    if (A == null) return 0;
    if (typeof A === "number") return Number.isFinite(A) ? A : 0;
    if (typeof A === "string") {
      if (/^-?\d+$/.test(A)) return +A;
      if (A.toLowerCase() === "x") return ctx.x | 0;
      return 0;
    }
    if (typeof A !== "object") return 0;
    const first = (r) => { const ids = this.refsSync(r, ctx); return ids.length ? this.lkiOf(ids[0], ctx) : null; };
    if ("count" in A) {
      const f = A.count;
      if (f && typeof f === "object" && f.player) return this.alivePlayers(true).filter((p) => this.matchesPlayer(p, f, ctx)).length;
      return this.find(f, ctx).length;
    }
    if ("powerOf" in A) { const ids = this.refsSync(A.powerOf, ctx); let s = 0; for (const id of ids) s += this.lkiOf(id, ctx)?.c?.power | 0; return s; }
    if ("toughnessOf" in A) return first(A.toughnessOf)?.c?.toughness | 0;
    if ("cmcOf" in A) return first(A.cmcOf)?.c?.cmc | 0;
    if ("countersOn" in A) { const o = first(A.countersOn); if (!o) { const ps = this.playersOf(this.refsSync(A.countersOn, ctx)); return ps.length ? this.state.players[ps[0]].counters[A.kind] | 0 : 0; } return (o.counters || o.lki?.counters || {})[A.kind || "+1/+1"] | 0; }
    if ("handSize" in A) { const ps = this.playersOf(this.refsSync(A.handSize, ctx)); return ps.reduce((n, p) => n + this.state.players[p].hand.length, 0); }
    if ("lifeOf" in A) { const ps = this.playersOf(this.refsSync(A.lifeOf, ctx)); return ps.length ? this.state.players[ps[0]].life : 0; }
    if ("prev" in A) return ctx.prev | 0;
    if ("sacrificed" in A) { let s = 0; for (const o of ctx.sacrificed || []) s += (A.sacrificed === "toughness" ? o.c.toughness : A.sacrificed === "cmc" ? o.c.cmc : o.c.power) | 0; return s; }
    if ("mul" in A) { const [a, b] = A.mul; return this.amount(a, ctx) * this.amount(b, ctx); }
    if ("add" in A) return asArr(A.add).reduce((n, a) => n + this.amount(a, ctx), 0);
    if ("sub" in A) { const [a, b] = A.sub; return this.amount(a, ctx) - this.amount(b, ctx); }
    if ("half" in A) { const v = this.amount(A.half, ctx) / 2; return A.round === "down" ? Math.floor(v) : Math.ceil(v); }
    if ("devotion" in A) {
      const cols = asArr(A.devotion).map(colorLetter);
      let n = 0;
      for (const id of this.state.battlefield) { const o = this.state.objects[id]; if (o.controller !== ctx.you) continue; const c = parseManaCost(o.c.cost || ""); for (const k of cols) n += c[k] | 0; for (const h of c.hybrid) if (h.some((x) => cols.includes(colorLetter(x)))) n++; for (const ph of c.phyrexian) if (cols.includes(ph)) n++; }
      return n;
    }
    if ("greatestPower" in A) { let m = 0; for (const o of this.find(A.greatestPower, ctx)) m = Math.max(m, o.c.power | 0); return m; }
    if ("totalPower" in A) { let m = 0; for (const o of this.find(A.totalPower, ctx)) m += Math.max(0, o.c.power | 0); return m; }
    if ("opponents" in A || "numOpponents" in A) return this.opponentsOf(ctx.you).length;
    if ("sum" in A) { let m = 0; for (const o of this.find(A.of ?? { types: ["creature"], controller: "you" }, ctx)) m += Math.max(0, (A.sum === "toughness" ? o.c.toughness : A.sum === "cmc" ? o.c.cmc : o.c.power) | 0); return m; }
    if ("greatest" in A) { let m = 0; for (const o of this.find(A.of ?? { types: ["creature"], controller: "you" }, ctx)) m = Math.max(m, (A.greatest === "toughness" ? o.c.toughness : A.greatest === "cmc" ? o.c.cmc : o.c.power) | 0); return m; }
    if ("event" in A) { const v = ctx.event ? ctx.event[A.event] : 0; return typeof v === "number" ? v : 0; }
    if ("x" in A) return ctx.x | 0;
    if ("startingLife" in A) return this.options.startingLife | 0;
    if ("lifeGainedThisTurn" in A) { const ps = this.playersOf(this.refsSync(A.lifeGainedThisTurn ?? "you", ctx)); return ps.reduce((n, p) => n + (this.state.players[p].lifeGainedThisTurn | 0), 0); }
    if ("lifeLostThisTurn" in A) { const ps = this.playersOf(this.refsSync(A.lifeLostThisTurn ?? "you", ctx)); return ps.reduce((n, p) => n + (this.state.players[p].lifeLostThisTurn | 0), 0); }
    if ("value" in A) return this.amount(A.value, ctx);
    return 0;
  },

  // ---------------------------------------------------------------- conditions
  evalCond(C, ctx = {}) {
    if (C == null || C === true) return true;
    if (C === false) return false;
    if (Array.isArray(C)) return C.every((c) => this.evalCond(c, ctx));
    const t = typeof C === "string" ? C : C.type ?? C.cond ?? C.kind ?? C.is;
    const P = (who) => { const ps = this.playersOf(this.refsSync(who ?? "you", ctx)); return ps; };
    switch (t) {
      case "control": {
        const n = this.find(C.filter ?? {}, { ...ctx }).filter((o) => o.controller === ctx.you || (C.filter && C.filter.controller)).length;
        return cmp(n, C.op || ">=", this.amount(C.n ?? 1, ctx));
      }
      case "count": return cmp(this.find(C.filter ?? {}, ctx).length, C.op || ">=", this.amount(C.n ?? 1, ctx));
      case "life": { const ps = P(C.who); return ps.some((p) => cmp(this.state.players[p].life, C.op || "<=", this.amount(C.n ?? 0, ctx))); }
      case "handSize": { const ps = P(C.who); return ps.some((p) => cmp(this.state.players[p].hand.length, C.op || ">=", this.amount(C.n ?? 0, ctx))); }
      case "yourTurn": return this.state.active === ctx.you;
      case "notYourTurn": case "opponentTurn": return this.state.active !== ctx.you;
      case "kicked": return !!ctx.kicked;
      case "counters": {
        const ids = this.refsSync(C.what ?? "self", ctx);
        const o = ids.length ? this.lkiOf(ids[0], ctx) : null;
        const n = o ? (o.counters || {})[C.kind || "+1/+1"] | 0 : 0;
        return cmp(n, C.op || ">=", this.amount(C.n ?? 1, ctx));
      }
      case "inZone": { const ids = this.refsSync(C.what ?? "self", ctx); return ids.some((id) => this.state.objects[id]?.zone === C.zone); }
      case "event": {
        const ev = ctx.event || {};
        if (C.filter) { const o = ev.obj; return !!o && this.matches(o, C.filter, ctx, "*"); }
        if (C.key) return ev[C.key] === C.value;
        return false;
      }
      case "did": return !!ctx.did;
      case "not": return !this.evalCond(C.c ?? C.cond ?? C.of, ctx);
      case "and": return asArr(C.all).every((c) => this.evalCond(c, ctx));
      case "or": return asArr(C.any).some((c) => this.evalCond(c, ctx));
      case "controlCommander": return this.state.battlefield.some((id) => { const o = this.state.objects[id]; return o.isCommander && o.controller === ctx.you; });
      case "opponentLostLife": return this.opponentsOf(ctx.you).some((p) => this.state.players[p].lifeLostThisTurn > 0);
      case "_echoDue": return !!ctx.source?.echoDue;
      case "opponents": return cmp(this.opponentsOf(ctx.you).length, C.op || ">=", this.amount(C.n ?? 1, ctx));
      case "matches": { const ids = this.refsSync(C.what ?? "it", ctx); return ids.some((id) => { const o = this.lkiOf(id, ctx) || this.state.objects[id]; return !!o && this.matches(o, C.filter, ctx, "*"); }); }
      case "sacrificed": return (ctx.sacrificed || []).some((o) => this.matches(o, C.filter, ctx, "*"));
      case "hasInHand": { const pl = this.state.players[ctx.you]; return !!pl && pl.hand.some((id) => id !== ctx.source?.id && this.matches(this.state.objects[id], C.filter, ctx, "*")); }
      case "ringBearer": return !!this.state.players[ctx.you]?.ring.bearer;
      case "compare": return cmp(this.amount(C.a, ctx), C.op || ">=", this.amount(C.b, ctx));
      case "resolvedCount": return cmp(ctx.resolvedCount | 0, C.op || "==", this.amount(C.n ?? 1, ctx));
      case "chosen": { const s = ctx.source && (this.state.objects[ctx.source.id] || ctx.source); return !!s && !!s.chosen && s.chosen[C.key || "mode"] === C.value; }
      default:
        if (!ctx.quiet) this.manualOnce(ctx.source, `Condition not automated (${t}); treated as false`);
        return false;
    }
  },

  manualOnce(src, text) {
    const k = (src?.id || "") + "|" + text;
    if (this._manualSeen.has(k)) return;
    this._manualSeen.add(k);
    this.manual(src, text);
  },

  // ---------------------------------------------------------------- executor
  *runEffects$(effects, ctx) {
    if (effects == null) return;
    if (!Array.isArray(effects)) effects = [effects];
    for (const e of effects) {
      if (this.over) return;
      yield* this.runEffect$(e, ctx);
      this.refresh();
    }
  },

  *runEffect$(e, ctx) {
    if (!e || typeof e !== "object") { this.manual(ctx.source, "Malformed effect skipped"); return; }
    if (typeof e.run === "function") { yield* e.run(this, ctx); return; }
    const fn = OPS[String(e.op) + "$"];
    if (!fn) { (ctx.manaAbility ? this.manualOnce : this.manual).call(this, ctx.source, e.text || `Not automated: ${e.op}`); return; }
    this.beginBatch();
    const prevEff = this._curEffect;
    this._curEffect = e;
    try {
      yield* fn.call(this, e, ctx);
    } catch (err) {
      if (err && err.engineFatal) throw err;
      this.manual(ctx.source, `${e.text || e.op}: could not be automated (${err && err.message})`);
    } finally { this._curEffect = prevEff; }
  },

  /** Players named by `who` (default you), APNAP ordered. */
  *whoPlayers$(who, ctx) {
    const ids = yield* this.refs$(who ?? "you", ctx);
    return this.apnap(this.playersOf(ids));
  },
};

// ------------------------------------------------------------------ ops
const OPS = {
  *damage$(e, ctx) {
    const n = this.amount(e.amount, ctx);
    let src = ctx.source;
    if (e.from != null) { const ids = yield* this.refs$(e.from, ctx); const o = ids.length ? this.lkiOf(ids[0], ctx) : null; if (o) src = o; else return; }
    const ids = yield* this.refs$(e.to ?? { ref: "target", i: 0 }, ctx);
    let total = 0;
    const div = e.divided && ctx.division && e.to && e.to.ref === "target" ? ctx.division[e.to.i | 0] : null;
    if (div) for (const id of ids) total += this.dealDamage(src, id, div[id] | 0); // CR 601.2d: the split was chosen on casting
    else if (e.divided && ids.length > 1) {
      const per = Math.floor(n / ids.length);
      let rem = n - per * ids.length;
      for (const id of ids) { total += this.dealDamage(src, id, per + (rem > 0 ? 1 : 0)); rem--; }
    } else for (const id of ids) total += this.dealDamage(src, id, n);
    ctx.it = ids; ctx.prev = total;
  },
  *draw$(e, ctx) {
    const ps = yield* this.whoPlayers$(e.who, ctx);
    const n = this.amount(e.amount ?? 1, ctx);
    let total = 0;
    for (const p of ps) total += this.draw(p, n);
    ctx.prev = total;
  },
  *discard$(e, ctx) {
    const ps = yield* this.whoPlayers$(e.who, ctx);
    const out = [];
    for (const p of ps) {
      const pl = this.state.players[p];
      let n = e.amount === "all" || e.amount === "hand" ? pl.hand.length : this.amount(e.amount ?? 1, ctx);
      n = Math.min(n, pl.hand.length);
      if (n <= 0) continue;
      let cards = pl.hand.map((id) => this.state.objects[id]);
      if (e.filter) cards = cards.filter((o) => this.matches(o, e.filter, ctx, "*"));
      let picked;
      if (e.random) { picked = []; const pool = [...cards]; for (let i = 0; i < n && pool.length; i++) picked.push(pool.splice(Math.floor(this.rng() * pool.length), 1)[0]); }
      else picked = yield* this.chooseObjects$(p, cards, { prompt: `Discard ${n} card${n > 1 ? "s" : ""}`, min: Math.min(n, cards.length), max: Math.min(n, cards.length), reason: "discard", source: ctx.source?.id });
      for (const o of picked) { this.discardCard(o); out.push(o.id); }
    }
    ctx.it = out; ctx.prev = out.length;
  },
  *mill$(e, ctx) {
    const ps = yield* this.whoPlayers$(e.who, ctx);
    const out = [];
    for (const p of ps) out.push(...this.mill(p, this.amount(e.amount ?? 1, ctx)).map((o) => o.id));
    ctx.it = out; ctx.prev = out.length;
  },
  *gainLife$(e, ctx) {
    const ps = yield* this.whoPlayers$(e.who, ctx);
    const n = this.amount(e.amount, ctx);
    let t = 0;
    for (const p of ps) t += this.gainLife(p, n);
    ctx.prev = t;
  },
  *loseLife$(e, ctx) {
    const ps = yield* this.whoPlayers$(e.who, ctx);
    const n = this.amount(e.amount, ctx);
    let t = 0;
    for (const p of ps) t += this.loseLife(p, n);
    ctx.prev = t;
  },
  *setLife$(e, ctx) {
    const ps = yield* this.whoPlayers$(e.who, ctx);
    const n = this.amount(e.amount, ctx);
    for (const p of ps) { const d = n - this.state.players[p].life; if (d > 0) this.gainLife(p, d); else if (d < 0) this.loseLife(p, -d); }
  },
  *destroy$(e, ctx) {
    const objs = this.objsOf(yield* this.refs$(e.what ?? { ref: "target", i: 0 }, ctx));
    const out = [];
    for (const o of objs) if (this.destroy(o)) out.push(o.id);
    ctx.it = out; ctx.prev = out.length;
  },
  *exile$(e, ctx) {
    const objs = this.objsOf(yield* this.refs$(e.what ?? { ref: "target", i: 0 }, ctx));
    const out = [];
    for (const o of objs) {
      const wasBf = o.zone === "battlefield";
      if (o.zone === "stack") this.removeFromStack(o);
      if (this.moveObj(o, "exile")) out.push(o.id);
      if (e.until && wasBf && ctx.source) {
        if (e.until === "sourceLeaves") this.state.links.push({ sourceId: ctx.source.id, objId: o.id, ts: this.state.ts });
        else this.addDelayed({ event: "beginStep", step: e.until === "endOfTurn" ? "end" : "end", whose: "each" }, [{ op: "move", what: { ref: "it" }, to: "battlefield" }], { ...ctx, it: [o.id] }, true);
      }
    }
    ctx.it = out; ctx.prev = out.length;
  },
  *bounce$(e, ctx) {
    const objs = this.objsOf(yield* this.refs$(e.what ?? { ref: "target", i: 0 }, ctx));
    const out = [];
    for (const o of objs) { if (yield* this.zoneMove$(o, "hand", {})) out.push(o.id); }
    ctx.it = out; ctx.prev = out.length;
  },
  *sacrifice$(e, ctx) {
    const ps = yield* this.whoPlayers$(e.who ?? "you", ctx);
    const out = [];
    const picks = [];
    for (const p of ps) {
      const f = e.filter ?? { types: ["creature"] };
      const fctx = { ...ctx, you: p };
      let cands = this.find(f, fctx).filter((o) => o.controller === p && o.zone === "battlefield");
      if (e.least) { const m = Math.min(...cands.map((o) => o.c.power | 0)); cands = cands.filter((o) => (o.c.power | 0) === m); }
      const n = Math.min(this.amount(e.amount ?? 1, ctx), cands.length);
      if (n <= 0) { if (e.ifCant) yield* this.runEffects$(e.ifCant, { ...ctx, you: p }); continue; }
      const picked = yield* this.chooseObjects$(p, cands, { prompt: `Sacrifice ${n === 1 ? "a" : n} ${describeFilter(f)}`, min: n, max: n, reason: "sacrifice", source: ctx.source?.id });
      picks.push(...picked);
    }
    for (const o of picks) if (this.sacrifice(o)) out.push(o.id);
    ctx.it = out; ctx.prev = out.length;
  },
  *sacrificeIt$(e, ctx) {
    const objs = this.objsOf(yield* this.refs$(e.what ?? "self", ctx));
    const out = [];
    for (const o of objs) if (o.zone === "battlefield" && this.sacrifice(o)) out.push(o.id);
    ctx.it = out; ctx.prev = out.length;
  },
  *move$(e, ctx) {
    const objs = this.objsOf(yield* this.refs$(e.what ?? { ref: "target", i: 0 }, ctx));
    const out = [];
    const to = e.to || "graveyard";
    for (const o of objs) {
      const opts = { position: e.position, tapped: !!e.tapped };
      if (to === "battlefield") opts.controller = e.control === "you" ? ctx.you : e.control === "owner" || e.control == null ? o.owner : ctx.you;
      if (e.counters) opts.counters = e.counters;
      const from = o.zone, pileLeft = o.pileLeft;
      if (yield* this.zoneMove$(o, to, opts)) out.push(o.id);
      // the other cards of an exiled merged permanent come back with it, as separate permanents
      if (to === "battlefield" && from === "exile" && pileLeft) for (const id of pileLeft) { const c = this.state.objects[id]; if (c && c.zone === "exile" && (yield* this.zoneMove$(c, to, { ...opts }))) out.push(c.id); }
    }
    ctx.it = out; ctx.prev = out.length;
  },
  *search$(e, ctx) {
    const ps = yield* this.whoPlayers$(e.who ?? "you", ctx);
    const out = [];
    for (const p of ps) {
      const pl = this.state.players[p];
      const f = e.filter ?? {};
      const fctx = { ...ctx, you: p };
      const cands = pl.library.map((id) => this.state.objects[id]).filter((o) => this.matches(o, typeof f === "object" && !Array.isArray(f) ? { ...f, zone: "library", owner: undefined } : f, fctx, "library"));
      const max = Math.min(this.amount(e.max ?? 1, ctx), cands.length);
      const min = Math.min(this.amount(e.min ?? 0, ctx), max);
      // present in a stable but non-revealing order (by name)
      cands.sort((a, b) => (a.c.name < b.c.name ? -1 : a.c.name > b.c.name ? 1 : 0));
      const picked = max > 0 ? yield* this.chooseObjects$(p, cands, { prompt: `Search your library for ${describeFilter(f)}`, min, max, reason: "search", source: ctx.source?.id }) : [];
      const tos = asArr(e.to || "hand");
      if (e.reveal && picked.length) this.emit({ t: "reveal", objs: picked.map((o) => o.id), player: p, text: `${this.pname(p)} reveals ${picked.map((o) => o.c.name).join(", ")}` });
      for (let i = 0; i < picked.length; i++) {
        const o = picked[i];
        const to = tos[Math.min(i, tos.length - 1)];
        const opts = { tapped: !!(Array.isArray(e.tapped) ? e.tapped[Math.min(i, e.tapped.length - 1)] : e.tapped) };
        if (to === "battlefield") opts.controller = p;
        if (to === "library") opts.position = e.position || "top";
        yield* this.zoneMove$(o, to, opts);
        out.push(o.id);
      }
      if (e.shuffle !== false) this.shuffle(p);
    }
    ctx.it = out; ctx.prev = out.length;
  },
  *scry$(e, ctx) {
    const ps = yield* this.whoPlayers$(e.who ?? "you", ctx);
    for (const p of ps) {
      const pl = this.state.players[p];
      const n = Math.min(this.amount(e.amount ?? 1, ctx), pl.library.length);
      if (n <= 0) continue;
      const top = pl.library.slice(-n).reverse().map((id) => this.state.objects[id]);
      const bottom = yield* this.chooseObjects$(p, top, { prompt: `Scry ${n}: choose cards to put on the bottom`, min: 0, max: n, reason: "scry", source: ctx.source?.id });
      for (const o of bottom) { pl.library.splice(pl.library.indexOf(o.id), 1); pl.library.unshift(o.id); }
      this.log(`${this.pname(p)} scries ${n}${bottom.length ? ` (${bottom.length} to the bottom)` : ""}`);
    }
  },
  *surveil$(e, ctx) {
    const ps = yield* this.whoPlayers$(e.who ?? "you", ctx);
    for (const p of ps) {
      const pl = this.state.players[p];
      const n = Math.min(this.amount(e.amount ?? 1, ctx), pl.library.length);
      if (n <= 0) continue;
      const top = pl.library.slice(-n).reverse().map((id) => this.state.objects[id]);
      const gy = yield* this.chooseObjects$(p, top, { prompt: `Surveil ${n}: choose cards to put into your graveyard`, min: 0, max: n, reason: "scry", source: ctx.source?.id });
      for (const o of gy) this.moveObj(o, "graveyard");
      this.log(`${this.pname(p)} surveils ${n}${gy.length ? ` (${gy.length} to the graveyard)` : ""}`);
    }
  },
  *shuffle$(e, ctx) { for (const p of yield* this.whoPlayers$(e.who ?? "you", ctx)) this.shuffle(p); },
  *counter$(e, ctx) {
    const objs = this.objsOf(yield* this.refs$(e.what ?? { ref: "target", i: 0 }, ctx)).filter((o) => o.zone === "stack");
    const out = [];
    for (const o of objs) {
      if (e.unlessPay) {
        const cost = typeof e.unlessPay === "object" && !e.unlessPay.generic && e.unlessPay.mana ? e.unlessPay.mana : e.unlessPay;
        const pc = typeof cost === "string" ? parseManaCost(cost) : parseManaCost(costFromAmount(this.amount(cost, ctx)));
        if (this.canPayMana(o.controller, pc)) {
          const yes = yield* this.confirm$(o.controller, `Pay ${typeof cost === "string" ? cost : `{${this.amount(cost, ctx)}}`} to keep ${o.c.name} from being countered?`, ctx.source?.id, { kind: "payToKeep", obj: o.id });
          if (yes && (yield* this.payMana$(o.controller, pc))) { this.log(`${this.pname(o.controller)} pays to keep ${o.c.name}`); continue; }
        }
      }
      if (this.counterObj(o, ctx.source)) out.push(o.id);
    }
    ctx.it = out; ctx.prev = out.length;
  },
  *createToken$(e, ctx) {
    const ps = yield* this.whoPlayers$(e.who ?? "you", ctx);
    const n = this.amount(e.amount ?? 1, ctx);
    const out = [];
    let copyFrom = null;
    if (e.copyOf != null) { const ids = yield* this.refs$(e.copyOf, ctx); copyFrom = ids.length ? this.lkiOf(ids[0], ctx) : null; if (!copyFrom) return; }
    let tok = e.token;
    if (tok && typeof tok === "object" && ((tok.power != null && typeof tok.power !== "number") || (tok.toughness != null && typeof tok.toughness !== "number")))
      tok = { ...tok, power: this.amount(tok.power, ctx), toughness: this.amount(tok.toughness, ctx) };
    for (const p of ps) {
      const made = this.createToken(p, copyFrom ? { copyOf: copyFrom } : tok, n, { tapped: e.tapped, attacking: e.attacking, source: ctx.source, ctx, nonLegendary: e.nonLegendary, power: e.power != null ? this.amount(e.power, ctx) : undefined, toughness: e.toughness != null ? this.amount(e.toughness, ctx) : undefined });
      out.push(...made.map((o) => o.id));
    }
    ctx.it = out; ctx.prev = out.length;
  },
  *addCounters$(e, ctx) {
    const ids = yield* this.refs$(e.what ?? "self", ctx);
    const n = this.amount(e.amount ?? 1, ctx);
    const div = e.divided && ctx.division && e.what && e.what.ref === "target" ? ctx.division[e.what.i | 0] : null;
    for (const id of ids) {
      if (div) { const o = this.state.objects[id]; if (o && o.zone === "battlefield") this.addCounters(o, e.kind || "+1/+1", div[id] | 0); continue; }
      if (isPid(id)) this.addPlayerCounters(pidx(id), e.kind || "poison", n);
      else { const o = this.state.objects[id]; if (o && o.zone === "battlefield") this.addCounters(o, e.kind || "+1/+1", n); }
    }
    ctx.it = ids; ctx.prev = n;
  },
  *removeCounters$(e, ctx) {
    const ids = yield* this.refs$(e.what ?? "self", ctx);
    let t = 0;
    for (const id of ids) {
      const o = this.state.objects[id];
      if (!o) continue;
      const kind = e.kind || Object.keys(o.counters)[0];
      if (!kind) continue;
      const n = e.amount === "all" ? o.counters[kind] | 0 : this.amount(e.amount ?? 1, ctx);
      t += this.addCounters(o, kind, -n);
    }
    ctx.prev = -t;
  },
  *pump$(e, ctx) {
    const objs = this.objsOf(yield* this.refs$(e.what ?? { ref: "target", i: 0 }, ctx)).filter((o) => o.zone === "battlefield");
    if (!objs.length) return;
    const pw = this.amount(e.power ?? 0, ctx), tg = this.amount(e.toughness ?? 0, ctx);
    const kws = asArr(e.keywords).filter((k) => k != null);
    this.addEffect({ type: "pump", power: pw, toughness: tg, keywords: kws, abilities: e.abilities }, ctx, { objIds: objs.map((o) => o.id), until: e.until || "endOfTurn", fixedPT: [pw, tg] });
    if (pw || tg || kws.length) this.log(`${objs.map((o) => o.c.name).join(", ")} ${pw || tg ? `get${objs.length === 1 ? "s" : ""} ${sgn(pw)}/${sgn(tg)}` : ""}${kws.length ? `${pw || tg ? " and" : ""} gain${objs.length === 1 ? "s" : ""} ${kws.map(kwName).join(", ")}` : ""}${(e.until || "endOfTurn") === "endOfTurn" ? " until end of turn" : ""}`);
    ctx.it = objs.map((o) => o.id);
  },
  *gainControl$(e, ctx) {
    const objs = this.objsOf(yield* this.refs$(e.what ?? { ref: "target", i: 0 }, ctx)).filter((o) => o.zone === "battlefield");
    for (const o of objs) this.gainControl(o, ctx.you, e.until || null, ctx.source);
    ctx.it = objs.map((o) => o.id);
  },
  *tap$(e, ctx) { const objs = this.objsOf(yield* this.refs$(e.what ?? { ref: "target", i: 0 }, ctx)); for (const o of objs) this.tap(o); ctx.it = objs.map((o) => o.id); },
  *untap$(e, ctx) { const objs = this.objsOf(yield* this.refs$(e.what ?? { ref: "target", i: 0 }, ctx)); for (const o of objs) this.untap(o); ctx.it = objs.map((o) => o.id); },
  *fight$(e, ctx) {
    const a = this.objsOf(yield* this.refs$(e.a ?? { ref: "target", i: 0 }, ctx))[0];
    const b = this.objsOf(yield* this.refs$(e.b ?? { ref: "target", i: 1 }, ctx))[0];
    if (!a || !b || a === b || !this.isCreature(a) || !this.isCreature(b)) return;
    const pa = Math.max(0, a.c.power | 0), pb = Math.max(0, b.c.power | 0);
    this.log(`${a.c.name} fights ${b.c.name}`);
    this.dealDamage(a, b.id, pa);
    this.dealDamage(b, a.id, pb);
  },
  *bite$(e, ctx) { // one-sided fight: a deals damage equal to its power to b
    const a = this.objsOf(yield* this.refs$(e.a ?? { ref: "target", i: 0 }, ctx))[0];
    const bIds = yield* this.refs$(e.b ?? { ref: "target", i: 1 }, ctx);
    if (!a || !this.isCreature(a)) return;
    for (const id of bIds) this.dealDamage(a, id, Math.max(0, a.c.power | 0));
  },
  *attach$(e, ctx) {
    const what = this.objsOf(yield* this.refs$(e.what ?? "self", ctx));
    const to = this.objsOf(yield* this.refs$(e.to ?? { ref: "target", i: 0 }, ctx))[0];
    if (!to || to.zone !== "battlefield") return;
    for (const o of what) if (o.zone === "battlefield" && o !== to) this.attach(o, to);
  },
  *addMana$(e, ctx) {
    const auto = !!ctx.manaChoice;
    const ps = yield* this.whoPlayers$(e.who ?? "you", ctx);
    let times = e.amount != null ? Math.max(0, this.amount(e.amount, ctx)) : 1;
    const m = e.mana;
    for (const p of ps) {
      const add = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
      for (let t = 0; t < times; t++) {
        if (typeof m === "string") { const q = manaStringToPool(m); for (const k of MANA_KEYS) add[k] += q[k]; }
        else if (m && typeof m === "object") {
          let cols, n;
          if (m.anyOf) { cols = m.anyOf.map(colorLetter).filter(Boolean); n = this.amount(m.n ?? 1, ctx); }
          else if (m.identity != null) { cols = this.identityOf(p); if (!cols.length) cols = ["C"]; n = this.amount(m.identity, ctx) || 1; }
          else if (m.any != null) { cols = ALL5; n = this.amount(m.any, ctx) || 1; }
          else if (m.color) { cols = [colorLetter(m.color)]; n = this.amount(m.n ?? 1, ctx); }
          else if (m.landColors) {
            cols = ALL5.filter((c) => this.landColors(m.landColors === "opponent" ? this.opponentsOf(p) : m.landColors === "you" ? [p] : this.alivePlayers()).has(c));
            n = this.amount(m.n ?? 1, ctx);
            if (!cols.length) { this.log(`${ctx.source?.c?.name || "That"} can't produce mana: no land ${m.landColors === "opponent" ? "an opponent controls " : ""}could produce a color`); continue; }
          }
          else continue;
          if (m.split && cols.length > 1 && n > 1) { // "{R}{R}, {R}{W}, or {W}{W}": each unit is chosen separately
            for (let i = 0; i < n; i++) {
              let c = ctx.manaChoice && ctx.manaChoice[i] && cols.includes(ctx.manaChoice[i]) ? ctx.manaChoice[i] : null;
              if (!c) { const ch = yield* this.choose$(p, { prompt: `Choose a color of mana (${i + 1} of ${n})`, options: cols.map((x) => ({ id: x, label: cap(colorNameOf(x)), type: "color" })), min: 1, max: 1, reason: "generic", source: ctx.source?.id }); c = ch[0]?.id || cols[0]; }
              add[c]++;
            }
            continue;
          }
          let col = ctx.manaChoice && ctx.manaChoice.find((c) => cols.includes(c));
          if (!col) {
            if (cols.length === 1) col = cols[0];
            else {
              const ch = yield* this.choose$(p, { prompt: "Choose a color of mana", options: cols.map((c) => ({ id: c, label: c === "C" ? "Colorless" : cap(colorNameOf(c)), type: "color" })), min: 1, max: 1, reason: "generic", source: ctx.source?.id });
              col = ch[0]?.id || cols[0];
            }
          }
          if (m.split && ctx.manaChoice) { for (let i = 0; i < n; i++) add[ctx.manaChoice[i] && cols.includes(ctx.manaChoice[i]) ? ctx.manaChoice[i] : col]++; }
          else add[col] += n;
        }
      }
      if (e.restrict || e.onSpend) {
        const cols = [];
        for (const k of MANA_KEYS) for (let i = 0; i < add[k]; i++) cols.push(k);
        this.addManaUnits(p, cols, { restrict: this.resolveRestrict(e.restrict, ctx.source && (this.state.objects[ctx.source.id] || ctx.source)), onSpend: e.onSpend || null }, ctx.source, auto);
      } else this.addManaPool(p, add, ctx.source, auto);
    }
  },
  *ringTempts$(e, ctx) { for (const p of yield* this.whoPlayers$(e.who ?? "you", ctx)) yield* this.ringTempts$(p); },
  *amass$(e, ctx) {
    const p = ctx.you;
    const n = this.amount(e.amount ?? 1, ctx);
    const sub = String(e.subtype || "orc").toLowerCase();
    let army = this.find({ subtypes: ["army"], controller: "you" }, ctx)[0];
    if (!army) army = this.createToken(p, { name: `${cap(sub)} Army`, types: ["creature"], subtypes: [sub, "army"], colors: ctx.source?.c?.colors || ["B"], power: 0, toughness: 0 }, 1, { source: ctx.source })[0];
    if (!army) return;
    if (!army.c.subtypes.includes(sub)) this.addEffect({ type: "asType", addSubtypes: [sub] }, ctx, { objIds: [army.id], until: null });
    this.addCounters(army, "+1/+1", n);
    ctx.it = [army.id];
  },
  *copySpell$(e, ctx) {
    const objs = this.objsOf(yield* this.refs$(e.what ?? { ref: "target", i: 0 }, ctx)).filter((o) => o.zone === "stack");
    const n = this.amount(e.amount ?? 1, ctx);
    for (const o of objs) for (let i = 0; i < n; i++) this.copyStackObject(o, ctx.you);
  },
  *transform$(e, ctx) {
    const objs = this.objsOf(yield* this.refs$(e.what ?? "self", ctx));
    for (const o of objs) {
      const d = o.copyDef || o.def;
      if (!d.faces || d.faces.length < 2) continue;
      o.face = o.face ? 0 : 1;
      this.markDirty(); this.refresh();
      this.log(`${o.c.name} transforms`);
    }
  },
  *extraTurn$(e, ctx) { for (const p of yield* this.whoPlayers$(e.who ?? "you", ctx)) { this.state.extraTurns.push(p); this.log(`${this.pname(p)} will take an extra turn`); } },
  *extraCombat$(e, ctx) { this.state.extraCombats++; this.log("There is an additional combat phase"); },
  *win$(e, ctx) { for (const p of yield* this.whoPlayers$(e.who ?? "you", ctx)) { for (const q of this.opponentsOf(p)) this.playerLoses(q, `${ctx.source?.c?.name || "An effect"}`); } },
  *lose$(e, ctx) { for (const p of yield* this.whoPlayers$(e.who ?? "you", ctx)) this.playerLoses(p, `${ctx.source?.c?.name || "An effect"}`); },
  *if$(e, ctx) {
    if (this.evalCond(e.cond, ctx)) yield* this.runEffects$(e.then, ctx);
    else if (e.else) yield* this.runEffects$(e.else, ctx);
  },
  *may$(e, ctx) {
    const ps = e.who ? yield* this.whoPlayers$(e.who, ctx) : [ctx.you];
    const p = ps[0] ?? ctx.you;
    let yes = false;
    const costOk = !e.cost || this.canPayCost(p, e.cost, ctx.source, ctx);
    if (costOk) {
      const label = e.text || e.prompt || (e.cost ? `Pay ${describeCost(e.cost)}?` : `${ctx.source?.c?.name || "Effect"}: do it?`);
      yes = yield* this.confirm$(p, label, ctx.source?.id, { kind: "may", effects: e.effects || [], cost: e.cost || null, else: e.else || null, who: p });
      if (yes && e.cost) {
        const pctx = { ...ctx, you: p, sacrificed: [] };
        yes = yield* this.payCost$(p, e.cost, pctx);
        if (yes && pctx.sacrificed.length) ctx.sacrificed = [...(ctx.sacrificed || []), ...pctx.sacrificed]; // "you may sacrifice X. If you do, …" refers back to X
      }
    }
    ctx.did = yes;
    if (yes) yield* this.runEffects$(e.effects, p === ctx.you ? ctx : { ...ctx, you: p });
    else if (e.else) yield* this.runEffects$(e.else, ctx);
    ctx.did = yes;
  },
  *modes$(e, ctx) {
    const modes = asArr(e.modes);
    if (!modes.length) return;
    const opts = modes.map((m, i) => ({ id: "m" + i, label: m.text || `Mode ${i + 1}`, type: "mode" }));
    const min = Math.min(e.min ?? 1, modes.length), max = Math.min(e.max ?? min, modes.length);
    const ch = yield* this.choose$(ctx.you, { prompt: "Choose mode", options: opts, min, max, reason: "mode", source: ctx.source?.id, hint: { kind: "mode", modes } });
    for (const c of ch) {
      const m = modes[+c.id.slice(1)];
      let targets = [];
      if (m.targets && m.targets.length) {
        const t = yield* this.chooseTargets$(ctx.you, m.targets, ctx.source, { ...ctx }, m.effects);
        if (!t) continue;
        targets = t;
      }
      yield* this.runEffects$(m.effects, { ...ctx, targets, targetSpecs: m.targets || [] });
    }
  },
  *forEach$(e, ctx) {
    const ids = yield* this.refs$(e.over ?? e.what, ctx);
    for (const id of ids) {
      const sub = { ...ctx, it: [id], each: id };
      if (isPid(id)) sub.eachPlayer = pidx(id);
      yield* this.runEffects$(e.effects, sub);
      if (this.over) return;
    }
  },
  *delayed$(e, ctx) { this.addDelayed(e.at, e.effects, ctx, e.once !== false); },
  *until$(e, ctx) {
    const st = e.static || {};
    let objIds = null;
    const a = st.affects;
    if (a && typeof a === "object" && a.ref) objIds = yield* this.refs$(a, ctx);
    else if (a && a !== "self" && typeof a === "object") objIds = this.find(a, ctx).map((o) => o.id);
    else if (a === "self" || a == null) objIds = ctx.source ? [ctx.source.id] : [];
    else if (a === "it") objIds = [...(ctx.it || [])];
    if (a === "you" || a === "opponent") objIds = null;
    const fixed = st.type === "pump" ? [this.amount(st.power ?? 0, ctx), this.amount(st.toughness ?? 0, ctx)] : null;
    this.addEffect(st, ctx, { objIds, until: e.until || "endOfTurn", fixedPT: fixed });
  },
  *animate$(e, ctx) {
    const objs = this.objsOf(yield* this.refs$(e.what ?? "self", ctx)).filter((o) => o.zone === "battlefield");
    if (!objs.length) return;
    this.addEffect({ type: "asType", addTypes: e.types || ["creature"], addSubtypes: e.subtypes || [], colors: e.colors, power: e.power, toughness: e.toughness, keywords: asArr(e.keywords) }, ctx, { objIds: objs.map((o) => o.id), until: e.until || "endOfTurn" });
    this.log(`${objs.map((o) => o.c.name).join(", ")} become${objs.length === 1 ? "s" : ""} ${e.power != null ? `a ${e.power}/${e.toughness} ` : ""}creature${(e.until || "endOfTurn") === "endOfTurn" ? " until end of turn" : ""}`);
    ctx.it = objs.map((o) => o.id);
  },
  *manual$(e, ctx) { if (ctx.manaAbility) this.manualOnce(ctx.source, e.text || "Resolve manually"); else this.manual(ctx.source, e.text || "Resolve manually"); },
  *noop$() {},
  *reveal$(e, ctx) {
    const objs = this.objsOf(yield* this.refs$(e.what ?? "it", ctx));
    if (objs.length) this.emit({ t: "reveal", objs: objs.map((o) => o.id), player: ctx.you, text: `${this.pname(ctx.you)} reveals ${objs.map((o) => o.c.name).join(", ")}` });
  },
  *explore$(e, ctx) {
    const objs = this.objsOf(yield* this.refs$(e.what ?? "self", ctx));
    for (const o of objs) {
      const p = o.controller;
      const pl = this.state.players[p];
      if (!pl.library.length) { if (o.zone === "battlefield") this.addCounters(o, "+1/+1", 1); continue; }
      const top = this.state.objects[pl.library[pl.library.length - 1]];
      this.emit({ t: "reveal", objs: [top.id], player: p, text: `${o.c.name} explores: ${this.pname(p)} reveals ${top.c.name}` });
      if (top.c.types.includes("land")) this.moveObj(top, "hand");
      else {
        if (o.zone === "battlefield") this.addCounters(o, "+1/+1", 1);
        const gy = yield* this.confirm$(p, `Put ${top.c.name} into your graveyard?`, o.id, { kind: "explore", card: top.id });
        if (gy) this.moveObj(top, "graveyard");
      }
    }
  },
  *proliferate$(e, ctx) {
    const cands = [];
    const p = ctx.you;
    for (const id of this.state.battlefield) { const o = this.state.objects[id]; if (Object.keys(o.counters).some((k) => o.counters[k] > 0)) cands.push(o); }
    const opts = cands.map((o) => ({ id: o.id, label: `${o.c.name} (${this.pname(o.controller)})`, type: "object" }));
    for (const q of this.state.players) if (Object.keys(q.counters).some((k) => q.counters[k] > 0)) opts.push({ id: pid(q.idx), label: q.name, type: "player" });
    if (!opts.length) return;
    const ch = yield* this.choose$(p, { prompt: "Proliferate: choose permanents and/or players", options: opts, min: 0, max: opts.length, reason: "generic", source: ctx.source?.id });
    for (const c of ch) {
      if (isPid(c.id)) { const q = this.state.players[pidx(c.id)]; for (const k of Object.keys(q.counters)) if (q.counters[k] > 0) this.addPlayerCounters(q.idx, k, 1); }
      else { const o = this.state.objects[c.id]; for (const k of Object.keys(o.counters)) if (o.counters[k] > 0) this.addCounters(o, k, 1); }
    }
  },
  *exileTop$(e, ctx) { // impulse: exile top N; may play them until (endOfTurn | nextTurn)
    const ps = yield* this.whoPlayers$(e.who ?? "you", ctx);
    const out = [];
    for (const p of ps) {
      const pl = this.state.players[p];
      const n = Math.min(this.amount(e.amount ?? 1, ctx), pl.library.length);
      for (let i = 0; i < n; i++) {
        const o = this.state.objects[pl.library[pl.library.length - 1]];
        this.moveObj(o, "exile");
        if (e.mayPlay !== false) o.mayPlay = e.until === "nextTurn" || e.until === "yourNextTurn" || e.until === "endOfYourNextTurn"
          ? { player: ctx.you, until: "endOfYourNextTurn", turn: this.state.turn, free: !!e.free } // "until the end of your next turn"
          : { player: ctx.you, until: "endOfTurn", untilTurn: this.state.turn, turn: this.state.turn, free: !!e.free };
        out.push(o.id);
      }
    }
    ctx.it = out; ctx.prev = out.length;
  },
  *lookTop$(e, ctx) { // dig: look at top N, put `take` into hand (filter optional), rest to `rest` (bottom|graveyard)
    const p = ctx.you, pl = this.state.players[p];
    const n = Math.min(this.amount(e.amount ?? 1, ctx), pl.library.length);
    if (n <= 0) return;
    const top = pl.library.slice(-n).reverse().map((id) => this.state.objects[id]);
    const cands = e.filter ? top.filter((o) => this.matches(o, e.filter, ctx, "*")) : top;
    const take = Math.min(this.amount(e.take ?? 1, ctx), cands.length);
    const picked = yield* this.chooseObjects$(p, cands, { prompt: `Choose ${take} card${take === 1 ? "" : "s"} to put into your hand`, min: e.upTo ? 0 : take, max: take, reason: "generic", source: ctx.source?.id });
    for (const o of picked) this.moveObj(o, e.to || "hand");
    for (const o of top) if (!picked.includes(o)) this.moveObj(o, e.rest === "graveyard" ? "graveyard" : "library", { position: "bottom" });
    ctx.it = picked.map((o) => o.id); ctx.prev = picked.length;
  },
  *goad$(e, ctx) { this.manual(ctx.source, "Goad (not automated)"); },

  // ---- internal ops used by synthesized abilities
  *_returnWithCounter$(e, ctx) {
    const o = ctx.source && this.state.objects[ctx.source.id];
    const lk = ctx.event?.obj;
    if (!o || o.zone !== "graveyard" || o.token) return;
    if (lk && ((lk.counters || {})[e.unless] | 0) > 0) return;
    yield* this.enter$(o, { controller: o.owner, counters: { [e.kind]: 1 } });
  },
  *phaseOut$(e, ctx) {
    const objs = this.objsOf(yield* this.refs$(e.what ?? "self", ctx)).filter((o) => o.zone === "battlefield");
    ctx.it = this.phaseOut(objs); ctx.prev = ctx.it.length;
  },
  *copyAbility$(e, ctx) {
    const ids = yield* this.refs$(e.what ?? { ref: "event", what: "ability" }, ctx);
    const out = [];
    for (const id of ids) { const a = this.state.objects[id]; const c = a && a.zone === "stack" && a.isAbility ? yield* this.copyAbility$(a, ctx.you, e.newTargets !== false) : null; if (c) out.push(c.id); }
    if (!out.length) this.log("There is no ability on the stack to copy");
    ctx.it = out; ctx.prev = out.length;
  },
  *_craftReturn$(e, ctx) { // "Return this card transformed under its owner's control" (craft)
    const o = ctx.source && this.state.objects[ctx.source.id];
    if (!o || o.zone !== "exile") return;
    const d = o.def;
    o.face = d.faces && d.faces[1] ? 1 : 0;
    yield* this.enter$(o, { controller: o.owner });
    if (o.zone === "battlefield") this.log(`${o.c.name} returns transformed`);
    ctx.it = [o.id];
  },
  *_exploit$(e, ctx) {
    const p = ctx.you;
    const cands = this.find({ types: ["creature"], controller: "you" }, ctx);
    const ch = yield* this.chooseObjects$(p, cands, { prompt: "Exploit: you may sacrifice a creature", min: 0, max: 1, reason: "sacrifice", source: ctx.source?.id });
    if (ch.length) { const lk = this.snapshot(ch[0]); if (this.sacrifice(ch[0])) this.fireTrigger({ type: "exploits", obj: ctx.source, player: p, exploited: lk }); }
  },
  *_echo$(e, ctx) {
    const o = ctx.source && this.state.objects[ctx.source.id];
    if (!o || o.zone !== "battlefield") return;
    o.echoDue = false;
    const cost = parseManaCost(e.cost);
    if (this.canPayMana(o.controller, cost) && (yield* this.confirm$(o.controller, `Pay echo ${e.cost} for ${o.c.name}?`, o.id, { kind: "echo" })) && (yield* this.payMana$(o.controller, cost))) return;
    this.sacrifice(o);
  },
  *_storm$(e, ctx) {
    const o = ctx.source && this.state.objects[ctx.source.id];
    const n = Math.max(0, (this.state.spellsThisTurn | 0) - 1);
    if (!o || o.zone !== "stack") return;
    for (let i = 0; i < n; i++) this.copyStackObject(o, ctx.you);
    if (n) this.log(`Storm: ${n} cop${n === 1 ? "y" : "ies"} of ${o.c.name}`);
  },
  *_ward$(e, ctx) {
    const target = this.state.objects[e.stackObj];
    if (!target || target.zone !== "stack") return;
    const p = target.controller;
    const cost = String(e.cost || "{0}");
    if (/life/i.test(cost)) { const n = +(cost.match(/\d+/) || [0])[0]; if (this.state.players[p].life > n && (yield* this.confirm$(p, `Pay ${n} life for ward?`, ctx.source?.id, { kind: "ward", obj: target.id }))) { this.loseLife(p, n); return; } }
    else {
      const pc = parseManaCost(cost);
      if (this.canPayMana(p, pc) && (yield* this.confirm$(p, `Pay ward ${cost} for ${ctx.source?.c?.name}?`, ctx.source?.id, { kind: "ward", obj: target.id })) && (yield* this.payMana$(p, pc))) return;
    }
    this.counterObj(target, ctx.source);
  },
  *_mutate$() {},
  *_sacrificeObjs$(e, ctx) {
    for (const id of e.ids || []) { const o = this.state.objects[id]; if (o && o.zone === "battlefield") this.sacrifice(o); }
  },
};

export function describeFilter(f) {
  if (!f) return "card";
  if (typeof f === "string") return f;
  if (Array.isArray(f)) return f.map(describeFilter).join(" or ");
  const parts = [];
  if (f.supertypes) parts.push(...f.supertypes);
  if (f.subtypes) parts.push(f.subtypes.map(cap).join(" or "));
  if (f.types) parts.push(f.types.join(" or "));
  if (f.anyOf) parts.push(f.anyOf.map(describeFilter).join(" or "));
  if (!parts.length) parts.push(f.zone === "library" ? "card" : "permanent");
  return parts.join(" ");
}
export function describeCost(c) {
  if (!c) return "";
  if (typeof c === "string") return c;
  const parts = [];
  if (c.mana) parts.push(c.mana);
  if (c.tap) parts.push("{T}");
  if (c.life) parts.push(`${c.life} life`);
  if (c.sacSelf) parts.push("sacrifice this");
  if (c.sac) parts.push(`sacrifice ${c.sacCount || 1} ${describeFilter(c.sac)}`);
  if (c.discard) parts.push(`discard ${typeof c.discard === "number" ? c.discard : 1}`);
  if (c.discardSelf) parts.push("discard this");
  if (c.loyalty != null) parts.push(`${c.loyalty > 0 ? "+" : ""}${c.loyalty} loyalty`);
  return parts.join(", ") || "{0}";
}
function costFromAmount(n) { return `{${Math.max(0, n | 0)}}`; }
const sgn = (n) => (n >= 0 ? "+" + n : String(n));
const kwName = (k) => (typeof k === "string" ? k : Object.keys(k || {}).join(", "));
function colorNameOf(c) { return { W: "white", U: "blue", B: "black", R: "red", G: "green", C: "colorless" }[c] || c; }
export { hasType };
