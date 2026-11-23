// engine-m2.js — creature / combat / counter keyword mechanics (library batch m2). Mixed into Game by engine.js.
// Vehicles + crew, goad, suspect, myriad, mobilize, squad, devour, riot, ravenous, fabricate, living weapon, partner with, monstrosity,
// enlist / exert, extra combat phases, station, energy, rad counters, populate, discover, manifest / cloak, coin flips ...
// Hooks into the other engine files are one-liners that call the m2* methods below (search "m2" in engine*.js).
import { OPS } from "./engine-effects.js";
import { parseManaCost, costToString } from "./engine-util.js";
import { GRANTABLE, kwSynth } from "./kw-synth.js";

const isPid = (id) => typeof id === "string" && /^P\d+$/.test(id);
const pid = (i) => "P" + i;
const asArr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

const WARRIOR = { name: "Warrior", types: ["creature"], subtypes: ["warrior"], colors: ["R"], power: 1, toughness: 1 };
const GERM = { name: "Phyrexian Germ", types: ["creature"], subtypes: ["phyrexian", "germ"], colors: ["B"], power: 0, toughness: 0 };
const SERVO = { name: "Servo", types: ["artifact", "creature"], subtypes: ["servo"], colors: [], power: 1, toughness: 1 };

export const m2Methods = {
  // ================================================================ refresh hook (called from _refreshOnce, after keyword/ability layers)
  m2Refresh(bf, act) {
    const st = this.state;
    for (const o of bf) {
      const c = o.c;
      if (o.goads && o.goads.length) c.goaded = o.goads.map((g) => g.by);
      if (o.faceDown && o.cloaked && !c.keywords.ward) c.keywords.ward = "{2}";
      // keywords granted by statics/effects that carry abilities of their own (myriad, exalted, fabricate, ...)
      const base = this.faceDef(o).keywords || {};
      let extra = null;
      for (const k of GRANTABLE) {
        const v = c.keywords[k];
        if (v == null || v === false || (k in base && base[k] != null && base[k] !== false)) continue;
        const add = kwSynth({ [k]: v }, { grant: true });
        if (add.length) (extra ||= []).push(...add);
      }
      if (extra) c.abilities = [...c.abilities, ...extra];
    }
    for (const s of act) {
      const t = s.st.type;
      if (t !== "goaded" && t !== "cantAttackPlayer" && t !== "noReattack") continue;
      for (const o of bf) if (this._affects(s, o)) {
        if (t === "goaded") (o.c.goaded ||= []).push(s.you);
        else if (t === "cantAttackPlayer") (o.c.noAttackPlayers ||= []).push(s.st.who === "opponent" ? -1 : s.you);
        else o.c.noReattack = true;
      }
    }
  },

  /** Extra filter keys for matches(): goaded, suspected, parity, anyCounters, entered, crewed, monstrous, tokenCopy. */
  m2Matches(o, f, c) {
    if (f.goaded != null && !!(c.goaded && c.goaded.length) !== !!f.goaded) return false;
    if (f.parity && ((c.cmc | 0) % 2 === 0) !== (f.parity === "even")) return false;
    if (f.anyCounters != null) { const n = Object.entries(o.counters || {}).some(([k, v]) => k !== "loyalty" && v > 0); if (n !== !!f.anyCounters) return false; }
    if (f.enteredThisTurn != null && !!(o.enteredTurn === this.state.turn && o.zone === "battlefield") !== !!f.enteredThisTurn) return false;
    if (f.monstrous != null && !!o.monstrous !== !!f.monstrous) return false;
    if (f.exerted != null && !!o.exerted !== !!f.exerted) return false;
    return true;
  },

  // ================================================================ goad / suspect
  goad(o, by) {
    if (!o || o.zone !== "battlefield") return false;
    o.goads = (o.goads || []).filter((g) => g.by !== by);
    o.goads.push({ by, turn: this.state.turn });
    this.markDirty();
    this.log(`${o.c.name} is goaded by ${this.pname(by)}`);
    this.fireTrigger({ type: "goaded", obj: o, player: o.controller, by });
    return true;
  },
  /** Goads wear off at the start of their controller's next turn (called from the untap step). */
  m2TurnStart(a) {
    for (const id of this.state.battlefield) {
      const o = this.state.objects[id];
      if (o && o.goads && o.goads.length) { o.goads = o.goads.filter((g) => g.by !== a); this.markDirty(); }
    }
  },
  /** Exerted creatures skip their next untap. Returns true if `o` should not untap now. */
  m2NoUntap(o) {
    if (o.exerted) { o.exerted = false; return true; }
    return false;
  },
  /** Reset per-incarnation fields when a permanent leaves the battlefield. */
  m2Left(o) { o.goads = null; o.monstrous = false; o.exerted = false; o.cloaked = false; o.enlisted = null; o.attackedPlayers = null; o.squad = 0; },

  // ================================================================ combat hooks
  /** Defenders `o` may attack (statics: can't attack you / a player it already attacked / this extra combat's restriction). */
  m2Defenders(o, defenders) {
    const no = new Set([...(o.c.noAttackPlayers || [])]);
    const cur = this.state.curExtra;
    if (cur && cur.noAttackPlayer != null) no.add(cur.noAttackPlayer);
    const had = o.c.noReattack && o.attackedPlayers && o.attackedPlayers.turn === this.state.turn ? o.attackedPlayers.list : [];
    if (!no.size && !had.length) return defenders;
    return defenders.filter((d) => {
      const p = this.defenderPlayer(d);
      if (p == null) return true;
      if (no.has(p) || (no.has(-1) && p !== o.controller)) return false;
      if (isPid(d) && had.includes(p)) return false;
      return true;
    });
  },

  /** Goaded creatures (and creatures this combat must attack) attack if able, and a player other than their goaders if able. */
  m2FixAttacks(cands, attacks) {
    const st = this.state;
    const out = [...attacks];
    const must = new Set(st.curExtra?.mustAttack || []);
    for (const c of cands) {
      const o = st.objects[c.obj];
      const goaded = o.c.goaded && o.c.goaded.length ? o.c.goaded : null;
      let i = out.findIndex((x) => x.obj === c.obj);
      if (!goaded && !must.has(c.obj)) continue;
      const allowed = goaded ? c.defenders.filter((d) => isPid(d) && !goaded.includes(+d.slice(1))) : [];
      if (i < 0) { out.push({ obj: c.obj, defender: allowed[0] ?? c.defenders[0] }); continue; }
      if (goaded && allowed.length && !allowed.includes(out[i].defender)) out[i] = { ...out[i], defender: allowed[0] };
    }
    return out;
  },

  /** After attackers are declared and tapped, before "attacks" triggers: enlist, exert, attack bookkeeping. */
  *m2Declared$(list) {
    const st = this.state;
    for (const o of list) {
      const e = st.combat.attackers.find((x) => x.obj === o.id);
      if (!e) continue;
      if (o.atkTurn !== st.turn) { o.atkTurn = st.turn; o.atkN = 0; }
      o.atkN++;
      const dp = this.defenderPlayer(e.defender);
      if (dp != null && isPid(e.defender)) {
        if (!o.attackedPlayers || o.attackedPlayers.turn !== st.turn) o.attackedPlayers = { turn: st.turn, list: [] };
        if (!o.attackedPlayers.list.includes(dp)) o.attackedPlayers.list.push(dp);
      }
    }
    this.markDirty();
    for (const o of list) {
      if (o.zone !== "battlefield" || !st.combat) continue;
      const p = o.controller;
      if (this.hasKw(o, "enlist")) {
        const attackingIds = new Set(st.combat.attackers.map((a) => a.obj));
        const cands = st.battlefield.map((id) => st.objects[id]).filter((x) => x.controller === p && x.c.types.includes("creature") && !x.tapped && !attackingIds.has(x.id) && x.id !== o.id && (!x.sick || this.hasKw(x, "haste")));
        if (cands.length) {
          const ch = yield* this.chooseObjects$(p, cands, { prompt: `Enlist: tap a nonattacking creature to add its power to ${o.c.name}? (choose none to skip)`, min: 0, max: 1, reason: "enlist", source: o.id, hint: { kind: "enlist", attacker: o.id } });
          if (ch[0]) {
            const pw = Math.max(0, ch[0].c.power | 0);
            this.tap(ch[0]);
            o.enlisted = ch[0].id;
            if (pw) this.addEffect({ type: "pump", power: pw, toughness: 0, keywords: [] }, { source: o, you: p }, { objIds: [o.id], until: "endOfTurn", fixedPT: [pw, 0] });
            this.log(`${o.c.name} enlists ${ch[0].c.name} (+${pw}/+0)`);
            this.fireTrigger({ type: "enlists", obj: o, player: p, enlisted: ch[0] });
          }
        }
      }
      const ex = (o.c.abilities || []).find((a) => a.kind === "static" && a.effect && a.effect.type === "exertOnAttack");
      if (ex && o.exertedTurn !== st.turn) {
        if (yield* this.confirm$(p, `Exert ${o.c.name}? (it won't untap during your next untap step)`, o.id, { kind: "exert" })) {
          o.exerted = true; o.exertedTurn = st.turn;
          this.log(`${o.c.name} is exerted`);
          this.fireTrigger({ type: "exerted", obj: o, player: p });
        }
      }
    }
    this.markDirty();
    this.refresh();
  },

  /** Run additional combat phases queued by effects ("after this phase, there is an additional combat phase"). */
  *m2ExtraCombats$() {
    const st = this.state;
    while (!this.over && st.extraCombats > 0) {
      st.extraCombats--;
      st.curExtra = (st.extraQueue ||= []).shift() || {};
      yield* this.combatPhase$();
      st.curExtra = null;
    }
  },
  /** Start of a (possibly additional) combat phase. */
  m2BeginCombat() {
    const st = this.state;
    st.combatsThisTurn = (st.combatsThisTurn | 0) + 1;
    const cur = st.curExtra;
    if (cur && cur.untapAll) {
      for (const id of st.battlefield) { const o = st.objects[id]; if (o.controller === st.active && o.tapped && o.c.types.includes("creature")) this.untap(o); }
      this.log("All creatures untap at the beginning of the additional combat");
    }
  },

  // ================================================================ crew
  crewCands(p, src) {
    return this.state.battlefield.map((id) => this.state.objects[id]).filter((o) => o.controller === p && !o.tapped && o.id !== src?.id && o.c.types.includes("creature"));
  },
  crewOk(p, n, src) { return this.crewCands(p, src).reduce((s, o) => s + Math.max(0, o.c.power | 0), 0) >= n; },
  *payCrew$(p, n, src, ctx) {
    let total = 0;
    const crewed = [];
    let cands = this.crewCands(p, src);
    while (total < n && cands.length) {
      const need = n - total;
      const ch = yield* this.chooseObjects$(p, cands, { prompt: `Crew ${n}: tap untapped creatures with total power ${need} or more`, min: 1, max: cands.length, reason: "crew", source: src?.id, hint: { kind: "crew", need, vehicle: src?.id } });
      if (!ch.length) break;
      for (const o of ch) { total += Math.max(0, o.c.power | 0); crewed.push(this.snapshot(o)); this.tap(o); }
      cands = cands.filter((o) => !o.tapped);
    }
    ctx.crewed = crewed;
    return total >= n;
  },

  // ================================================================ cost hooks
  /** Mana string of a cost after `reduce` (ability cost reduction: {per:Amount, amount:-N, ifTargets?:cond}). */
  reducedMana(cost, src, p, ctx) {
    const r = cost.reduce;
    if (!r || !cost.mana) return cost.mana;
    const c = parseManaCost(cost.mana);
    const cctx = { source: src, you: p, quiet: true };
    let n = r.per != null ? this.amount(r.per, cctx) * -(r.amount ?? -1) : -(r.amount ?? -1);
    if (r.if) {
      const t = ctx && ctx._chosenTargets;
      if (!t) n = r.if.optimistic === false ? 0 : n; // not chosen yet: assume the cheaper cost for "can I afford it"
      else if (!this.evalCond(r.if.cond, { ...cctx, targets: t })) n = 0;
    }
    c.generic = Math.max(0, c.generic - n);
    return costToString(c);
  },
  energyOk(p, n) { return (this.state.players[p].counters.energy | 0) >= n; },

  // ================================================================ trigger / cond / amount hooks
  m2TriggerMatches(on, evt, s, ctrl, whoObj, whoPlayer) {
    switch (evt.type) {
      case "evolves": case "crewed": case "monstrous": case "goaded": case "exerted": case "enlists": case "suspected": case "turnedFaceUp2":
        if (!whoObj(on.who, evt.obj)) return false;
        if (on.filter && !this.matches(evt.obj, on.filter, { source: s, you: ctrl, event: evt }, "*")) return false;
        return true;
      case "coinWon": case "coinFlip": case "radMilled":
        return whoPlayer(on.who, evt.player);
      default: return false;
    }
  },
  m2Cond(t, C, ctx) {
    const st = this.state;
    switch (t) {
      case "_dethrone": { // defending player has the most life or is tied for most life
        const ev = ctx.event || {};
        const d = ev.defender ?? st.combat?.attackers.find((a) => a.obj === ctx.source?.id)?.defender;
        if (!isPid(d)) return false;
        const life = st.players[+d.slice(1)].life;
        return st.players.every((p) => p.lost || p.life <= life);
      }
      case "firstAttack": return !!ctx.source && ctx.source.atkTurn === st.turn && ctx.source.atkN === 1;
      case "firstCombat": return (st.combatsThisTurn | 0) <= 1;
      case "enlisted": return !!ctx.event?.obj?.enlisted;
      case "attached": return !!ctx.source?.attachedTo;
      case "notAttached": return !ctx.source?.attachedTo;
      case "mainPhase": return st.step === "main1" || st.step === "main2";
      case "duringCombat": return !!st.combat || ["beginCombat", "declareAttackers", "declareBlockers", "combatDamage", "endCombat"].includes(st.step);
      case "gameLost2": return st.players.filter((p) => p.lost).length >= 2;
      case "monstrous": return !!ctx.source?.monstrous;
      case "notMonstrous": return !ctx.source?.monstrous;
      case "exerted": return !!ctx.source?.exerted;
      case "bothTargetsYours": { // Wayta: the two targets are creatures you control
        const ids = (C.targets || ctx.targets || []).flat();
        return ids.length >= 2 && ids.every((id) => st.objects[id]?.controller === ctx.you);
      }
      case "oppDamaged": return this.opponentsOf(ctx.you).some((p) => st.players[p].damagedThisTurn);
      case "creatureDiedThisTurn": return !!st.creatureDied;
      case "castNoncreatureAtLeast": return (st.players[ctx.you].noncreatureCast | 0) >= (C.n | 0);
      case "secondSpell": return st.spellsThisTurn === 2 || (ctx.event && ctx.event.nth === 2);
      default: return undefined;
    }
  },
  m2Amount(A, ctx) {
    const st = this.state;
    if ("attackedOpponents" in A) {
      const you = ctx.source ? ctx.source.controller : ctx.you;
      const ds = new Set();
      for (const a of st.combat?.attackers || []) { const o = st.objects[a.obj]; if (o && o.controller === you) { const dp = this.defenderPlayer(a.defender); if (dp != null && dp !== you) ds.add(dp); } }
      return ds.size;
    }
    if ("sourceX" in A) return (ctx.source && (st.objects[ctx.source.id]?.x ?? ctx.source.x)) | 0;
    if ("tappedPower" in A) return (ctx.tappedOther || []).reduce((n, o) => n + Math.max(0, (o.c?.power | 0)), 0);
    if ("attackedTimes" in A) { const o = ctx.obj || ctx.source; return o && o.atkTurn === st.turn ? o.atkN | 0 : 0; }
    if ("commanderCmc" in A) { let m = 0; for (const id of st.players[ctx.you]?.commanders || []) { const o = st.objects[id]; if (o) m = Math.max(m, o.def.cmc | 0); } return m; }
    if ("cardTypesInGraveyards" in A) {
      const ts = new Set();
      for (const p of st.players) for (const id of p.graveyard) for (const t of st.objects[id].c.types) ts.add(t);
      return ts.size;
    }
    if ("totalCounters" in A) { let n = 0; for (const o of this.find(A.totalCounters, ctx)) for (const [k, v] of Object.entries(o.counters || {})) if (k !== "loyalty") n += v | 0; return n; }
    if ("castCount" in A) return st.players[ctx.you]?.castThisTurn | 0;
    return null;
  },

  // ================================================================ "as enters" hooks (riot, devour, bloodthirst-like grants)
  *m2Entry$(o, d, p, entry) {
    const kw = d.keywords || {};
    if (kw.devour) {
      const dv = kw.devour;
      const f = { controller: "you", other: true, ...(dv.filter || {}) };
      const cands = this.state.battlefield.map((id) => this.state.objects[id]).filter((x) => x.id !== o.id && x.controller === p && this.matches(x, f, { source: o, you: p }));
      if (cands.length) {
        const ch = yield* this.chooseObjects$(p, cands, { prompt: `Devour ${dv.label || ""} ${dv.n}: sacrifice any number as ${d.name} enters`.replace("  ", " "), min: 0, max: cands.length, reason: "sacrifice", source: o.id, hint: { kind: "devour", mult: dv.n, creature: o.id } });
        let n = 0;
        for (const x of ch) if (this.sacrifice(x)) n++;
        if (n) { entry.counters = { ...(entry.counters || {}), "+1/+1": ((entry.counters || {})["+1/+1"] | 0) + n * (dv.n | 0) }; this.log(`${d.name} devours ${n}`); }
      }
    }
    if (this.m2HasRiot(o, d, p)) {
      const ch = yield* this.choose$(p, { prompt: `Riot: ${d.name} enters with a +1/+1 counter or haste`, options: [{ id: "counter", label: "+1/+1 counter", type: "mode" }, { id: "haste", label: "Haste", type: "mode" }], min: 1, max: 1, reason: "mode", source: o.id, hint: { kind: "riot", obj: o.id } });
      if (ch[0]?.id === "haste") entry.haste = true; else entry.counters = { ...(entry.counters || {}), "+1/+1": ((entry.counters || {})["+1/+1"] | 0) + 1 };
    }
  },
  m2EntryDefault(o, d, p, entry) {
    if (this.m2HasRiot(o, d, p)) entry.counters = { ...(entry.counters || {}), "+1/+1": ((entry.counters || {})["+1/+1"] | 0) + 1 };
  },
  m2HasRiot(o, d, p) {
    if (!d || !(d.types || []).includes("creature")) return false;
    if (d.keywords && d.keywords.riot) return true;
    for (const s of this._statics || []) {
      if (s.st.type !== "pump" || !asArr(s.st.keywords).some((k) => k === "riot") || !s.src || s.src.zone !== "battlefield") continue;
      const aff = s.st.affects;
      if (aff && typeof aff === "object" && this.matches(o, aff, { source: s.src, you: s.you }, "*") && s.you === p) return true;
    }
    return false;
  },
  /** Applied from applyEntersReplacements: counters/haste chosen as it entered, "enters with N additional counters" grants. */
  m2ApplyEntry(o, entry) {
    o.enteredTurn = this.state.turn;
    if (entry && entry.counters) for (const [k, n] of Object.entries(entry.counters)) if (n) o.counters[k] = (o.counters[k] | 0) + n;
    if (entry && entry.haste) this.addEffect({ type: "pump", power: 0, toughness: 0, keywords: ["haste"] }, { source: o, you: o.controller }, { objIds: [o.id], until: null });
    for (const s of this._statics || []) {
      if (s.st.type !== "entersWithCountersFor" || !s.src || s.src.id === o.id) continue;
      const ctx = { source: s.src, you: s.you, quiet: true };
      if (!this.matches(o, s.st.affects, ctx, "*") || o.controller !== s.you) continue;
      if (s.st.cond && !this.evalCond(s.st.cond, ctx)) continue;
      o.counters[s.st.kind || "+1/+1"] = (o.counters[s.st.kind || "+1/+1"] | 0) + this.amount(s.st.amount ?? 1, ctx);
    }
  },

  // ================================================================ helpers
  /** Create token copies of `src` (squad, myriad ...). */
  copyTokens(p, src, n, opts = {}) { return this.createToken(p, { copyOf: src }, n, opts); },
  flipCoin(p) {
    const win = this.rng() < 0.5;
    this.log(`${this.pname(p)} flips a coin: ${win ? "wins" : "loses"} the flip`);
    return win;
  },
  m2Cast(p, fd) {
    const pl = this.state.players[p];
    pl.castThisTurn = (pl.castThisTurn | 0) + 1;
    if (!(fd.types || []).includes("creature")) pl.noncreatureCast = (pl.noncreatureCast | 0) + 1;
    this.markDirty();
  },
  /** Rad counters (CR 727): at the precombat main phase, mill that many; each nonland milled loses 1 life and removes a rad counter. */
  radTriggers() {
    const a = this.state.active, pl = this.state.players[a];
    if ((pl.counters.rad | 0) > 0) {
      this.pendInternal(null, a, { kind: "triggered", text: "Rad counters: mill cards equal to your rad counters; for each nonland card milled, lose 1 life and remove a rad counter.", run: function* (g) {
        const p = g.state.players[a];
        const n = p.counters.rad | 0;
        let hits = 0;
        for (let i = 0; i < n && p.library.length; i++) {
          const o = g.state.objects[p.library[p.library.length - 1]];
          g.moveObj(o, "graveyard");
          if (!o.def.types.includes("land")) hits++;
        }
        if (hits) { g.loseLife(a, hits); g.addPlayerCounters(a, "rad", -Math.min(hits, p.counters.rad | 0)); }
      } }, { type: "rad" });
    }
  },
};

// ====================================================================== ops (effect IR)
const ops = {
  *_fire$(e, ctx) { this.fireTrigger({ type: e.event, obj: ctx.source && (this.state.objects[ctx.source.id] || ctx.source), player: ctx.you, ...(e.extra || {}) }); },

  *_crew$(e, ctx) {
    const o = ctx.source && this.state.objects[ctx.source.id];
    if (!o || o.zone !== "battlefield") return;
    this.addEffect({ type: "asType", addTypes: ["creature"] }, ctx, { objIds: [o.id], until: "endOfTurn" });
    this.log(`${o.c.name} becomes an artifact creature until end of turn`);
    this.markDirty(); this.refresh();
    this.fireTrigger({ type: "crewed", obj: o, player: ctx.you, crew: ctx.crewed || [] });
  },

  *goad$(e, ctx) {
    const ids = yield* this.refs$(e.what ?? { ref: "target", i: 0 }, ctx);
    const out = [];
    for (const o of this.objsOf(ids)) if (o.zone === "battlefield" && this.goad(o, ctx.you)) out.push(o.id);
    ctx.it = out; ctx.prev = out.length;
  },
  *ungoad$(e, ctx) {
    const objs = this.objsOf(yield* this.refs$(e.what ?? "self", ctx));
    for (const o of objs) if (o.goads && o.goads.length) { o.goads = null; this.log(`${o.c.name} is no longer goaded`); }
    this.markDirty();
  },
  *_myriad$(e, ctx) {
    const src = ctx.source && this.state.objects[ctx.source.id];
    const st = this.state;
    const ent = src && st.combat && st.combat.attackers.find((a) => a.obj === src.id);
    if (!src || src.zone !== "battlefield" || !ent) return;
    const dp = this.defenderPlayer(ent.defender);
    const p = ctx.you;
    const made = [];
    for (let round = 0; round < (e.n || 1); round++) {
      for (const q of this.apnap(this.opponentsOf(p))) {
        if (q === dp) continue;
        const opts = [{ id: pid(q), label: `Attack ${this.pname(q)}`, type: "player" }];
        for (const id of st.battlefield) { const x = st.objects[id]; if (x.controller === q && x.c.types.includes("planeswalker")) opts.push({ id: x.id, label: `Attack ${x.c.name}`, type: "object" }); }
        const ch = yield* this.choose$(p, { prompt: `Myriad: create a token copy of ${src.c.name} attacking ${this.pname(q)} (or choose none)`, options: opts, min: 0, max: 1, reason: "myriad", source: src.id, hint: { kind: "myriad", player: q } });
        if (!ch.length) continue;
        const toks = this.createToken(p, { copyOf: src }, 1, { tapped: true, source: src });
        for (const t of toks) { if (t.zone === "battlefield") { st.combat.attackers.push({ obj: t.id, defender: ch[0].id, blockers: [], blocked: false }); made.push(t.id); } }
      }
    }
    if (made.length) this.addDelayed({ event: "beginStep", step: "endCombat", whose: "each" }, [{ op: "exile", what: { ref: "all", filter: { zone: "battlefield" } }, _ids: made }], { ...ctx, source: src }, true,
      function* (g) { for (const id of made) { const t = g.state.objects[id]; if (t && t.zone === "battlefield") g.moveObj(t, "exile", { quiet: true }); } });
  },

  *_mobilize$(e, ctx) {
    const src = ctx.source && this.state.objects[ctx.source.id];
    if (!src) return;
    const n = this.amount(e.amount ?? 1, { ...ctx, source: src });
    if (n <= 0) return;
    const toks = this.createToken(ctx.you, WARRIOR, n, { tapped: true, attacking: true, source: src });
    const ids = toks.map((t) => t.id);
    this.addDelayed({ event: "beginStep", step: "end", whose: "each" }, [{ op: "_sacrificeObjs", ids }], { ...ctx, source: src }, true);
    ctx.it = ids; ctx.prev = ids.length;
  },

  *_livingWeapon$(e, ctx) {
    const src = ctx.source && this.state.objects[ctx.source.id];
    if (!src || src.zone !== "battlefield") return;
    const [germ] = this.createToken(ctx.you, GERM, 1, { source: src });
    if (germ) this.attach(src, germ);
    this.markDirty(); this.refresh();
  },

  *_fabricate$(e, ctx) {
    const src = ctx.source && this.state.objects[ctx.source.id];
    const n = e.n || 1;
    const opts = [];
    if (src && src.zone === "battlefield") opts.push({ id: "counters", label: `Put ${n} +1/+1 counter${n > 1 ? "s" : ""} on ${src.c.name}`, type: "mode" });
    opts.push({ id: "servos", label: `Create ${n} 1/1 Servo artifact creature token${n > 1 ? "s" : ""}`, type: "mode" });
    const ch = yield* this.choose$(ctx.you, { prompt: `Fabricate ${n}`, options: opts, min: 1, max: 1, reason: "mode", source: src?.id, hint: { kind: "fabricate", n, obj: src?.id } });
    if (ch[0]?.id === "counters") this.addCounters(src, "+1/+1", n);
    else this.createToken(ctx.you, SERVO, n, { source: src });
  },

  *_squad$(e, ctx) {
    const src = ctx.source && this.state.objects[ctx.source.id];
    if (!src) return;
    const n = src.squad | 0;
    src.squad = 0;
    if (n <= 0) return;
    const toks = this.createToken(ctx.you, { copyOf: src }, n, { source: src });
    this.log(`Squad: ${n} token cop${n === 1 ? "y" : "ies"} of ${src.c.name}`);
    ctx.it = toks.map((t) => t.id); ctx.prev = toks.length;
  },

  *_partnerWith$(e, ctx) {
    const p = ctx.you, pl = this.state.players[p];
    const cands = pl.library.map((id) => this.state.objects[id]).filter((o) => o.def.name === e.name);
    if (cands.length) {
      const ch = yield* this.chooseObjects$(p, cands, { prompt: `Partner with ${e.name}: put it into your hand?`, min: 0, max: 1, reason: "search", source: ctx.source?.id, hint: { kind: "partnerWith" } });
      if (ch[0]) { this.emit({ t: "reveal", objs: [ch[0].id], player: p, text: `${this.pname(p)} reveals ${ch[0].c.name}` }); yield* this.zoneMove$(ch[0], "hand", {}); }
    }
    this.shuffle(p);
  },

  *_monstrosity$(e, ctx) {
    const o = ctx.source && this.state.objects[ctx.source.id];
    if (!o || o.zone !== "battlefield" || o.monstrous) return;
    const n = this.amount(e.amount ?? 1, { ...ctx, source: o });
    o.monstrous = true;
    if (n > 0) this.addCounters(o, "+1/+1", n);
    this.log(`${o.c.name} becomes monstrous`);
    this.markDirty(); this.refresh();
    this.fireTrigger({ type: "monstrous", obj: o, player: ctx.you, x: n });
  },

  *extraCombat$(e, ctx) {
    const st = this.state;
    st.extraCombats++;
    (st.extraQueue ||= []);
    while (st.extraQueue.length < st.extraCombats - 1) st.extraQueue.push({});
    st.extraQueue.push({ untapAll: !!e.untapAll, mustAttack: e.mustAttack || null, noAttackPlayer: e.noAttackPlayer ?? null });
    this.log("There is an additional combat phase");
  },

  /** Untap objects (default: all creatures you control / all attacking creatures) — thin wrapper so one effect can do it with a filter. */
  *_untapAll$(e, ctx) {
    for (const o of this.find(e.filter, ctx)) this.untap(o);
  },

  *populate$(e, ctx) {
    const toks = this.find({ types: ["creature"], token: true, controller: "you" }, ctx);
    if (!toks.length) return;
    const ch = yield* this.chooseObjects$(ctx.you, toks, { prompt: "Populate: choose a creature token you control", min: 1, max: 1, reason: "copy", source: ctx.source?.id, hint: { kind: "populate" } });
    if (ch[0]) { const made = this.createToken(ctx.you, { copyOf: ch[0] }, 1, { source: ctx.source }); ctx.it = made.map((t) => t.id); }
  },

  *_discover$(e, ctx) { // exile from the top until a nonland card with mana value <= X; cast it free or put it into hand; the rest go to the bottom randomly
    const p = ctx.you, pl = this.state.players[p];
    const x = this.amount(e.amount, ctx);
    const ex = [];
    let hit = null;
    while (pl.library.length) {
      const o = this.state.objects[pl.library[pl.library.length - 1]];
      this.moveObj(o, "exile");
      ex.push(o);
      if (!o.def.types.includes("land") && (o.def.cmc | 0) <= x) { hit = o; break; }
    }
    if (hit) {
      const cast = (e.mayCast !== false) && (yield* this.confirm$(p, `Discover ${x}: cast ${hit.c.name} without paying its mana cost? (otherwise put it into your hand)`, hit.id, { kind: "may", effects: [] }));
      if (!cast || !(yield* this.castFree$(p, hit, {}))) { if (hit.zone === "exile") this.moveObj(hit, "hand"); }
    }
    const rest = ex.filter((o) => o.zone === "exile");
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    for (const o of rest) this.moveObj(o, "library", { position: "bottom", quiet: true });
  },

  *manifest$(e, ctx) { // manifest / cloak the top card of your library
    const p = ctx.you, pl = this.state.players[p];
    const cloak = e.cloak === true;
    const out = [];
    for (let i = 0; i < (this.amount(e.amount ?? 1, ctx)); i++) {
      if (!pl.library.length) break;
      const o = this.state.objects[pl.library[pl.library.length - 1]];
      o.faceDown = true; o.manifestUp = true; o.cloaked = cloak;
      this.moveObj(o, "battlefield", { controller: p, keepFaceDown: true, quiet: true, entry: { done: true, chosen: {} } });
      if (o.zone === "battlefield") { out.push(o.id); this.emit({ t: "move", obj: o.id, from: "library", to: "battlefield", player: p, text: `${this.pname(p)} ${cloak ? "cloaks" : "manifests"} the top card of their library` }); }
    }
    ctx.it = out;
  },

  *flipCoin$(e, ctx) {
    const p = ctx.you;
    const win = this.flipCoin(p);
    ctx.coinWon = win;
    if (win) this.fireTrigger({ type: "coinWon", player: p });
  },

  *chooseParity$(e, ctx) { // "choose odd or even. Creatures with mana value of that quality can't block this turn."
    const ch = yield* this.choose$(ctx.you, { prompt: "Choose odd or even", options: [{ id: "odd", label: "Odd", type: "mode" }, { id: "even", label: "Even", type: "mode" }], min: 1, max: 1, reason: "mode", source: ctx.source?.id, hint: { kind: "parity" } });
    const par = ch[0]?.id || "even";
    this.addEffect({ type: "cantBlock", affects: { types: ["creature"], controller: "opponent", parity: par } }, ctx, { until: "endOfTurn" });
    this.log(`Creatures with ${par} mana value can't block this turn`);
  },

  *unattach$(e, ctx) {
    const o = this.objsOf(yield* this.refs$(e.what ?? "self", ctx))[0];
    if (o && o.attachedTo) { const h = this.state.objects[o.attachedTo]; if (h) h.attachments = h.attachments.filter((x) => x !== o.id); o.attachedTo = null; this.markDirty(); }
  },

  *_removeFromCombat$(e, ctx) {
    const st = this.state;
    if (!st.combat) return;
    const objs = this.find({ types: ["creature"], attacking: true }, ctx);
    for (const o of objs) { st.combat.attackers = st.combat.attackers.filter((a) => a.obj !== o.id); this.untap(o); }
    ctx.it = objs.map((o) => o.id);
    this.log(`${objs.length} attacking creature${objs.length === 1 ? " is" : "s are"} removed from combat`);
    this.markDirty();
  },
};
Object.assign(OPS, ops);

export { WARRIOR, GERM, SERVO, cap, num };
