// engine-m3.js — library batch m3: player resources, designations and keyword actions (see SPEC-NOTES "Library automation: m3").
//   energy counters · voting · ascend / city's blessing · investigate · discover · manifest / cloak / disguise ·
//   dredge · descend / per-turn statistics · crimes · stun counters · "if you would get {E} / proliferate / create a Clue, Food or Treasure" replacements.
// Everything is installed onto Game.prototype by installM3(Game) (called once from engine.js): new methods are mixed in, a few existing ones are
// wrapped (fireTrigger, mill, draw cards, sba, untap, createToken, runEffect$, amount, evalCond, canPayCost, payCost$, playerLoses, afterTargeting).
// Every generator ends in `$` and is called with `yield*`. Deterministic (g.rng only).
import { cap, TOKENS, FACE_DOWN_WARD_DEF } from "./engine-util.js";

const isPid = (id) => typeof id === "string" && /^P\d+$/.test(id);
const pid = (i) => "P" + i;
const PERM_TYPES = ["artifact", "battle", "creature", "enchantment", "land", "planeswalker"];
const isPermC = (c) => !!c && (c.types || []).some((t) => PERM_TYPES.includes(t));
const cmpOp = (a, op, b) => (op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : op === "==" ? a === b : a >= b);

/** Events handled by m3TriggerMatches (the base triggerMatches returns false for them). */
export const M3_EVENTS = new Set(["getEnergy", "payEnergy", "investigate", "surveil", "explores", "votesFinished", "crime", "discover", "proliferate", "attackBatch"]);
const M3_CONDS = new Set(["blessing", "descended", "entered", "died", "stat", "hasCounters"]);

export const m3Methods = {
  // ================================================================ per-turn statistics
  /** Per-player statistics for the current turn (lazily reset). */
  tstat(p) {
    const pl = this.state.players[p];
    if (!pl) return { turn: -1, drew: 0, surveilled: 0, investigated: 0, energyPaid: 0, descended: false, entered: [], crimes: 0, scried: 0 };
    if (!pl._ts || pl._ts.turn !== this.state.turn) pl._ts = { turn: this.state.turn, drew: 0, surveilled: 0, investigated: 0, energyPaid: 0, descended: false, entered: [], crimes: 0, scried: 0 };
    return pl._ts;
  },
  diedThisTurn() { const st = this.state; return (st._died && st._died.turn === st.turn) ? st._died.list : []; },
  /** Permanents put into a graveyard from the battlefield this turn (gravestorm). */
  permsToGraveThisTurn() { const st = this.state; return st._togy && st._togy.turn === st.turn ? st._togy.n : 0; },

  // ================================================================ energy
  /** "You get {E}×n" (replacement effects of Aether Refinery / Izzet Generatorium apply). Returns the amount actually received. */
  getEnergy(p, n, src) {
    n = Math.floor(n);
    const pl = this.state.players[p];
    if (!pl || pl.lost || !(n > 0)) return 0;
    for (const s of this._statics) if (s.st.type === "energyMod" && s.you === p && s.st.add) n += s.st.add;
    for (const s of this._statics) if (s.st.type === "energyMod" && s.you === p && s.st.mul) n *= s.st.mul;
    this.addPlayerCounters(p, "energy", n);
    this.fireTrigger({ type: "getEnergy", player: p, amount: n, source: src || null });
    return n;
  },
  /** Pay (remove) energy as a cost or effect. Returns false (and does nothing) when the player doesn't have enough. */
  payEnergy(p, n) {
    n = Math.floor(n);
    const pl = this.state.players[p];
    if (!pl || n < 0 || (pl.counters.energy | 0) < n) return false;
    if (n === 0) return true;
    this.addPlayerCounters(p, "energy", -n);
    this.tstat(p).energyPaid += n;
    this.fireTrigger({ type: "payEnergy", player: p, amount: n });
    return true;
  },

  // ================================================================ investigate
  /** Investigate once for player p: a Clue token + the `investigate` event (nth = how many times this turn). Returns the Clue (or null). */
  investigate(p, src) {
    const made = this.createToken(p, "clue", 1, { source: src || null });
    const ts = this.tstat(p);
    ts.investigated++;
    this.fireTrigger({ type: "investigate", player: p, nth: ts.investigated, obj: made[0] || null });
    return made[0] || null;
  },

  // ================================================================ voting
  /**
   * Each player votes (starting with `you`, in turn order). o = {source: Obj, you, prompt, options:[{id,label,type?}], score?(voter, optionId) -> number (AI), secret?, extra?(voter) -> n}.
   * Returns { byVoter:{p:[ids]}, tally:{id:n}, winners:[ids] (most votes, ties = several), winner: id|null (null on a tie), order:[players] } and fires `votesFinished`.
   */
  *vote$(o) {
    const you = o.you ?? this.state.active;
    const order = [];
    let p = you;
    for (let i = 0; i < this.state.players.length; i++) { if (!this.state.players[p].lost) order.push(p); p = this.nextPlayer(p); }
    const byVoter = {}, tally = {};
    for (const op of o.options) tally[op.id] = 0;
    for (const v of order) {
      byVoter[v] = [];
      const n = 1 + (o.extra ? o.extra(v) | 0 : 0);
      for (let k = 0; k < n; k++) {
        const score = o.score ? (id) => o.score(v, id) : () => 0;
        const ch = yield* this.choose$(v, { prompt: o.prompt || "Vote", options: o.options, min: 1, max: 1, reason: "vote", source: o.source?.id, hint: { kind: "vote", score, secret: !!o.secret } });
        const id = ch[0]?.id;
        if (id == null) continue;
        byVoter[v].push(id); tally[id]++;
      }
    }
    const max = Math.max(0, ...Object.values(tally));
    const winners = o.options.filter((op) => tally[op.id] === max && max > 0).map((op) => op.id);
    const lab = (id) => o.options.find((x) => x.id === id)?.label || id;
    this.emit({ t: "vote", text: `Votes${o.secret ? " (revealed)" : ""}: ` + order.map((v) => `${this.pname(v)} → ${byVoter[v].map(lab).join(", ")}`).join("; ") });
    const res = { byVoter, tally, winners, winner: winners.length === 1 ? winners[0] : null, order, max };
    this.state._lastVote = res;
    this.fireTrigger({ type: "votesFinished", player: you, byVoter, order, source: o.source || null });
    return res;
  },

  // ================================================================ discover
  /** Discover N (CR 701.57). Returns the discovered card (cast or put into hand) or null. */
  *discover$(p, n, src) {
    const pl = this.state.players[p];
    const exiled = [];
    let hit = null;
    while (pl.library.length) {
      const top = this.state.objects[pl.library[pl.library.length - 1]];
      this.moveObj(top, "exile", { quiet: true });
      exiled.push(top);
      if (!top.c.types.includes("land") && (top.c.cmc | 0) <= n) { hit = top; break; }
    }
    this.emit({ t: "reveal", objs: exiled.map((o) => o.id), player: p, text: `${pl.name} discovers ${n}: exiles ${exiled.map((o) => o.c.name).join(", ") || "nothing"}` });
    if (hit) {
      let cast = false;
      if (yield* this.confirm$(p, `Discover: cast ${hit.c.name} without paying its mana cost? (No: put it into your hand)`, src?.id, { kind: "discover", card: hit.id })) cast = yield* this.castFree$(p, hit, {});
      if (!cast && hit.zone === "exile") this.moveObj(hit, "hand");
    }
    const rest = exiled.filter((o) => o !== hit && o.zone === "exile");
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    for (const o of rest) this.moveObj(o, "library", { position: "bottom", quiet: true });
    this.fireTrigger({ type: "discover", player: p, obj: hit, amount: n });
    return hit;
  },

  // ================================================================ manifest / cloak (face-down permanents)
  /**
   * Manifest (or cloak) `n` cards: the top card(s) of `owner`'s library (or `cards`), face down as 2/2 creatures under `p`'s control.
   * A manifested/cloaked creature card can be turned face up for its mana cost. Cloaked permanents have ward {2}.
   */
  *manifest$(p, n, o = {}) {
    const out = [];
    for (let i = 0; i < n; i++) {
      let card;
      if (o.cards) card = o.cards[i];
      else { const lib = this.state.players[o.owner ?? p].library; card = lib.length ? this.state.objects[lib[lib.length - 1]] : null; }
      if (!card) break;
      card.faceDown = true;
      card.faceDownWard = !!o.cloak;
      card.fuCost = card.def.types.includes("creature") && card.def.cost ? card.def.cost : null;
      this.emit({ t: "log", text: `${this.pname(p)} ${o.cloak ? "cloaks" : "manifests"} ${o.cards ? "a card from their hand" : "the top card of " + this.pname(o.owner ?? p) + "'s library"}` });
      yield* this.enter$(card, { controller: p, keepFaceDown: true, quiet: true });
      if (card.zone === "battlefield") out.push(card);
      else card.faceDown = false;
    }
    return out;
  },

  // ================================================================ misc helpers
  /** Number of additional times a creature explores (Topography Tracker). */
  exploreTimes(o) { return 1 + this._statics.filter((s) => s.st.type === "exploreTwice" && s.you === o.controller).length; },
  /** Extra cards looked at when `p` surveils (Enhanced Surveillance). */
  surveilExtra(p) { let n = 0; for (const s of this._statics) if (s.st.type === "surveilExtra" && s.you === p) n += s.st.n | 0; return n; },
  /** Permanents `p` controls (for ascend). */
  permCount(p) { return this.state.battlefield.reduce((n, id) => n + (this.state.objects[id].controller === p ? 1 : 0), 0); },
  m3Sba() {
    const st = this.state;
    for (const pl of st.players) {
      if (pl.blessing || pl.lost) continue;
      const asc = st.battlefield.some((id) => { const o = st.objects[id]; return o.controller === pl.idx && o.c?.keywords?.ascend; });
      if (asc && this.permCount(pl.idx) >= 10) { pl.blessing = true; this.markDirty(); this.emit({ t: "log", text: `${pl.name} gets the city's blessing` }); }
    }
  },
  /** Crime (CR 700.13): a spell/ability that targets an opponent, anything an opponent controls, or cards in an opponent's graveyard. */
  m3Crime(o) {
    if (!o || !o.targets || !o.targets.length) return;
    const p = o.controller;
    const st = this.state;
    const crime = o.targets.some((id) => {
      if (isPid(id)) return +id.slice(1) !== p;
      const t = st.objects[id];
      if (!t) return false;
      if (t.zone === "graveyard") return t.owner !== p;
      return t.controller !== p;
    });
    if (!crime) return;
    this.tstat(p).crimes++;
    this.fireTrigger({ type: "crime", player: p, source: o });
  },
  /** Condition types added by m3. */
  m3Cond(C, ctx) {
    const st = this.state;
    const you = ctx.you;
    switch (C.type) {
      case "blessing": return !!st.players[you]?.blessing;
      case "descended": return !!this.tstat(you).descended;
      case "stat": { const ps = C.who === "opponent" ? this.opponentsOf(you) : C.who === "each" ? this.alivePlayers(true) : [you]; return ps.some((p) => cmpOp(this.tstat(p)[C.key] | 0, C.op || ">=", this.amount(C.n ?? 1, ctx))); }
      case "entered": { // permanents that entered under `who`'s control this turn matching filter
        const ps = C.who === "opponent" ? this.opponentsOf(you) : C.who === "each" ? this.alivePlayers(true) : [you];
        let n = 0;
        for (const p of ps) for (const e of this.tstat(p).entered) if (!C.filter || this.matches(e, C.filter, ctx, "*")) n++;
        return cmpOp(n, C.op || ">=", this.amount(C.n ?? 1, ctx));
      }
      case "died": {
        let n = 0;
        for (const e of this.diedThisTurn()) if (!C.filter || this.matches(e, C.filter, ctx, "*")) n++;
        return cmpOp(n, C.op || ">=", this.amount(C.n ?? 1, ctx));
      }
      case "hasCounters": { const ids = this.refsSync(C.what ?? "self", ctx); return ids.some((id) => { const o = st.objects[id]; return o && Object.values(o.counters || {}).some((v) => v > 0); }); }
      default: return false;
    }
  },
  /** Amount types added by m3. Returns undefined when A isn't one of them. */
  m3Amount(A, ctx) {
    if ("energyPaidThisTurn" in A) return this.tstat(ctx.you).energyPaid | 0;
    if ("surveilledThisTurn" in A) return this.tstat(ctx.you).surveilled | 0;
    if ("enteredThisTurn" in A) { let n = 0; for (const e of this.tstat(ctx.you).entered) if (!A.enteredThisTurn || this.matches(e, A.enteredThisTurn, ctx, "*")) n++; return n; }
    if ("diedThisTurn" in A) { let n = 0; for (const e of this.diedThisTurn()) if (!A.diedThisTurn || this.matches(e, A.diedThisTurn, ctx, "*")) n++; return n; }
    if ("permsToGraveThisTurn" in A) return this.permsToGraveThisTurn();
    if ("greatestCountOf" in A) { let m = 0; for (const p of this.alivePlayers(true)) m = Math.max(m, this.find(A.greatestCountOf, { ...ctx, you: p }).filter((o) => o.controller === p).length); return m; }
    return undefined;
  },
  /** "does this trigger match" for the m3 event types. */
  m3TriggerMatches(on, evt, s, ctrl) {
    const ctx = { source: s, you: ctrl, event: evt };
    const who = on.who ?? "each";
    const whoP = (w, p) => (w === "each" || w === "any" || w == null ? true : p == null ? false : w === "you" ? p === ctrl : w === "opponent" ? p !== ctrl : false);
    switch (evt.type) {
      case "getEnergy": case "payEnergy": case "investigate": case "surveil": case "discover": case "crime": case "votesFinished": case "proliferate":
        if (!whoP(who, evt.player)) return false;
        if (on.nth && evt.nth !== on.nth) return false;
        if (on.yourTurn && this.state.active !== ctrl) return false;
        return true;
      case "attackBatch": {
        if (!whoP(who, evt.player)) return false;
        if (on.atPlayer && !evt.atPlayers.some((q) => q !== evt.player)) return false;
        const n = (on.filter ? evt.objs.filter((o) => this.matches(o, on.filter, ctx, "*")) : evt.objs).length;
        return n >= (on.n || 1);
      }
      case "explores": {
        const w = on.who ?? "self";
        const o = evt.obj;
        if (w === "self") { if (o.id !== s.id) return false; }
        else if (w === "you") { if (o.controller !== ctrl) return false; }
        else if (typeof w === "object") { if (!this.matches(o, w, ctx, "*")) return false; }
        if (on.land != null && !!evt.land !== !!on.land) return false;
        return true;
      }
      default: return false;
    }
  },
};

// ---------------------------------------------------------------------------------------------------- ops (executor `op` values)

export const M3_OPS = {
  *investigate$(e, ctx) {
    const ps = yield* this.whoPlayers$(e.who ?? "you", ctx);
    const n = this.amount(e.amount ?? 1, ctx);
    const out = [];
    for (const p of ps) for (let i = 0; i < n; i++) { const c = this.investigate(p, ctx.source); if (c) out.push(c.id); }
    ctx.it = out; ctx.prev = out.length;
  },
  *energy$(e, ctx) {
    const ps = yield* this.whoPlayers$(e.who ?? "you", ctx);
    const n = this.amount(e.amount ?? 1, ctx);
    let t = 0;
    for (const p of ps) t += this.getEnergy(p, n, ctx.source);
    ctx.prev = t;
  },
  *payEnergy$(e, ctx) { // pay energy as part of an effect (no choice): ctx.did says whether it was paid
    const n = this.amount(e.amount ?? 1, ctx);
    ctx.did = this.payEnergy(ctx.you, n);
    ctx.prev = ctx.did ? n : 0;
  },
  *manifest$(e, ctx) {
    const ps = yield* this.whoPlayers$(e.who ?? "you", ctx);
    const n = this.amount(e.amount ?? 1, ctx);
    const out = [];
    for (const p of ps) out.push(...(yield* this.manifest$(p, n, { cloak: !!e.cloak, owner: p })).map((o) => o.id));
    ctx.it = out; ctx.prev = out.length;
  },
  *discover$(e, ctx) {
    const n = this.amount(e.amount ?? 1, ctx);
    const hit = yield* this.discover$(ctx.you, n, ctx.source);
    ctx.it = hit ? [hit.id] : []; ctx.prev = hit ? (hit.c.cmc | 0) : 0; ctx.discovered = hit;
  },
};

// ---------------------------------------------------------------------------------------------------- installation
export function installM3(Game) {
  const P = Game.prototype;
  Object.assign(P, m3Methods);
  const wrap = (name, make) => { const orig = P[name]; P[name] = make(orig); };

  // ---- trigger events: statistics before, internal triggers after
  wrap("fireTrigger", (orig) => function (evt) {
    if (evt && !this.over) this.m3Pre(evt);
    orig.call(this, evt);
    if (evt && !this.over) this.m3Post(evt);
  });
  P.m3Pre = function (evt) {
    const st = this.state;
    switch (evt.type) {
      case "draw": if (evt.player != null && evt.nth == null) evt.nth = ++this.tstat(evt.player).drew; break;
      case "scry": if (evt.player != null) this.tstat(evt.player).scried += 1; break;
      case "enters": {
        const o = evt.obj;
        if (o) {
          this.tstat(o.controller).entered.push({ id: o.id, owner: o.owner, controller: o.controller, zone: "battlefield", token: !!o.token, c: o.c });
          if (o.faceDown && st.players[o.controller] && this._statics.some((s) => s.st.type === "faceDownCounter" && s.you === o.controller)) {
            for (const s of this._statics) if (s.st.type === "faceDownCounter" && s.you === o.controller) this.addCounters(o, s.st.kind || "flying", 1);
          }
        }
        break;
      }
      case "dies": {
        const o = evt.obj;
        if (o) { if (!st._died || st._died.turn !== st.turn) st._died = { turn: st.turn, list: [] }; st._died.list.push({ id: o.id, owner: o.owner, controller: o.controller, zone: "graveyard", token: !!o.token, c: o.c }); }
        break;
      }
      case "leaves": if (evt.to === "graveyard") { if (!st._togy || st._togy.turn !== st.turn) st._togy = { turn: st.turn, n: 0 }; st._togy.n++; } break;
      case "zoneChange": if (evt.to === "graveyard" && evt.obj && !evt.obj.token && isPermC(evt.obj.c)) this.tstat(evt.obj.owner).descended = true; break;
      default:
    }
  };
  P.m3Post = function (evt) {
    const st = this.state;
    if (evt.type === "attacks" && st.combat && evt.obj) {
      const mine = st.combat.attackers.map((a) => ({ a, o: st.objects[a.obj] })).filter((x) => x.o && x.o.controller === evt.obj.controller);
      if (mine.length && mine[mine.length - 1].o.id === evt.obj.id)
        this.fireTrigger({ type: "attackBatch", player: evt.obj.controller, objs: mine.map((x) => x.o), atPlayers: mine.filter((x) => isPid(x.a.defender)).map((x) => +x.a.defender.slice(1)) });
    }
  };

  // ---- the trigger matcher: m3 events
  wrap("triggerMatches", (orig) => function (on, evt, s, ctrl, delayed) {
    if (on && M3_EVENTS.has(evt.type) && on.event === evt.type) return this.m3TriggerMatches(on, evt, s, ctrl);
    return orig.call(this, on, evt, s, ctrl, delayed);
  });

  // ---- dredge: instead of drawing, mill N and return the dredge card
  wrap("drawCards$", (orig) => function* (p, n = 1) {
    let k = 0;
    for (let i = 0; i < n; i++) {
      const pl = this.state.players[p];
      if (!pl || pl.lost) break;
      const cands = pl.graveyard.map((id) => this.state.objects[id]).filter((o) => o && o.def?.keywords?.dredge != null && pl.library.length >= (o.def.keywords.dredge | 0));
      if (cands.length) {
        const options = [{ id: "draw", label: "Draw a card", type: "text" }, ...cands.map((o) => ({ id: o.id, label: `Dredge ${o.def.keywords.dredge}: ${o.c.name}`, type: "card" }))];
        const ch = yield* this.choose$(p, { prompt: "Dredge instead of drawing a card?", options, min: 1, max: 1, reason: "dredge", hint: { kind: "dredge" } });
        if (ch[0] && ch[0].id !== "draw") {
          const d = this.state.objects[ch[0].id];
          this.mill(p, d.def.keywords.dredge | 0);
          this.moveObj(d, "hand");
          this.log(`${pl.name} dredges ${d.c.name}`);
          k++;
          continue;
        }
      }
      k += yield* orig.call(this, p, 1);
    }
    return k;
  });

  // ---- ascend: the city's blessing is checked with state-based actions
  wrap("sba$", (orig) => function* () { this.m3Sba(); return yield* orig.call(this); });

  // ---- stun counters: instead of untapping, remove a stun counter
  wrap("untap", (orig) => function (o, silent) {
    if (o && o.zone === "battlefield" && o.tapped && (o.counters.stun | 0) > 0) { this.addCounters(o, "stun", -1); return false; }
    return orig.call(this, o, silent);
  });

  // ---- Academy Manufactor: "If you would create a Clue, Food, or Treasure token, instead create one of each"
  wrap("createToken", (orig) => function (p, t, n = 1, opts = {}) {
    const key = typeof t === "string" ? t.toLowerCase().replace(/ token$/, "") : null;
    if ((key === "clue" || key === "food" || key === "treasure") && !this._inManu && this._statics.some((s) => s.st.type === "createAllPredef" && s.you === p)) {
      this._inManu = true;
      try { const out = []; for (const k of ["clue", "food", "treasure"]) out.push(...orig.call(this, p, k, n, opts)); return out; } finally { this._inManu = false; }
    }
    return orig.call(this, p, t, n, opts);
  });

  // ---- cost: energy ("Pay {E}{E}", "Pay X {E}")
  wrap("canPayCost", (orig) => function (p, cost, src, ctx = {}, opts = {}) {
    if (cost && typeof cost === "object" && cost.energy != null) {
      const n = cost.energy === "x" ? (ctx.x | 0) : this.amount(cost.energy, ctx);
      if ((this.state.players[p]?.counters.energy | 0) < n) return false;
    }
    return orig.call(this, p, cost, src, ctx, opts);
  });
  wrap("payCost$", (orig) => function* (p, cost, ctx = {}, opts = {}) {
    if (!(yield* orig.call(this, p, cost, ctx, opts))) return false;
    if (cost && typeof cost === "object" && cost.energy != null) {
      const n = cost.energy === "x" ? (ctx.x | 0) : this.amount(cost.energy, ctx);
      this.payEnergy(p, n);
      ctx.energyPaid = n;
    }
    return true;
  });

  // ---- effects: m3 ops + replacement effects for existing ops
  wrap("runEffect$", (orig) => function* (e, ctx) {
    if (e && typeof e === "object" && !e.run) {
      const k = String(e.op) + "$";
      const fn = M3_OPS[k];
      if (fn) {
        this.beginBatch();
        const prevEff = this._curEffect;
        this._curEffect = e;
        try { yield* fn.call(this, e, ctx); }
        catch (err) { if (err && err.engineFatal) throw err; this.manual(ctx.source, `${e.text || e.op}: could not be automated (${err && err.message})`); }
        finally { this._curEffect = prevEff; }
        return;
      }
      if (e.op === "proliferate") { // Tekuthal: "If you would proliferate, proliferate twice instead"
        let times = e.times | 0 || 1;
        for (const s of this._statics) if (s.st.type === "proliferateTwice" && s.you === ctx.you) times *= 2;
        for (let i = 0; i < times; i++) yield* orig.call(this, { ...e, times: 1 }, ctx);
        if (times > 0) this.fireTrigger({ type: "proliferate", player: ctx.you });
        return;
      }
      if (e.op === "surveil") { // Enhanced Surveillance: look at additional cards; events for "whenever you surveil"
        const ps = yield* this.whoPlayers$(e.who ?? "you", ctx);
        const base = this.amount(e.amount ?? 1, ctx);
        for (const p of ps) {
          if (base <= 0) continue;
          const extra = this.surveilExtra(p);
          yield* orig.call(this, { ...e, who: pid(p), amount: base + extra }, ctx);
          this.tstat(p).surveilled++;
          this.fireTrigger({ type: "surveil", player: p, nth: this.tstat(p).surveilled, amount: base });
        }
        return;
      }
    }
    return yield* orig.call(this, e, ctx);
  });

  wrap("amount", (orig) => function (A, ctx = {}) {
    if (A && typeof A === "object") { const r = this.m3Amount(A, ctx); if (r !== undefined) return r; }
    return orig.call(this, A, ctx);
  });
  wrap("evalCond", (orig) => function (C, ctx = {}) {
    if (C && typeof C === "object" && M3_CONDS.has(C.type)) return this.m3Cond(C, ctx);
    return orig.call(this, C, ctx);
  });

  // ---- Golden Throne: "If you would lose the game, instead exile this and your life total becomes 1"
  wrap("playerLoses", (orig) => function (p, reason) {
    const pl = this.state.players[p];
    if (pl && !pl.lost && !/conced/i.test(String(reason))) {
      const gt = this.state.battlefield.map((id) => this.state.objects[id]).find((o) => o.controller === p && (o.c.abilities || []).some((a) => a.kind === "static" && a.effect?.type === "loseGameReplace"));
      if (gt) {
        this.moveObj(gt, "exile");
        pl.life = 1; pl.drewFromEmpty = false;
        this.emit({ t: "life", player: p, delta: 0, life: 1, text: `${gt.c.name}: ${pl.name} would lose the game — instead it is exiled and their life total becomes 1` });
        this.markDirty();
        return;
      }
    }
    return orig.call(this, p, reason);
  });

  // ---- crimes
  wrap("afterTargeting", (orig) => function (o) { const r = orig.call(this, o); this.m3Crime(o); return r; });
}
