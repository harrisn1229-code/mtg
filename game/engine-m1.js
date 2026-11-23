// engine-m1.js — casting / cost mechanics of the deck-library "m1" batch, mixed into the Game prototype (methods use `this`).
// See SPEC-NOTES.md "Library automation: m1". Everything here is additive: the engine files call these hooks at a few places
// (castVariants / spellCost / castCheck / cast$ / resolveSpell$ / moveObj / draw / discardCard / evalCond / amount).
//
//   per-cast record   o.m1 = { from, variant, kickCount, kickedWith:[bool], gift:null|{player,kind}, offspring, squad, replicate, buyback,
//                              convoked:[ids], improvised:n, colors:[...] /*distinct colours of mana spent*/, exileInstead, ... }
//   keywords          m1Kws(o, p, fd): the card's keywords as a spell — printed + `grantKw` statics (filter/zone/keyword/value)
//   variants          dash evoke blitz emerge harmonize retrace jumpstart aftermath foretold plotted miracle madness suspend(free)
//   special actions   foretell, plot, suspend, ninjutsu, embalm, eternalize, encore, unearth (energy / granted)  -> `activate` actions with variant "m1:<name>"
import { parseManaCost, costToString, costCmc, addCosts, MANA_KEYS } from "./engine-util.js";

const isPid = (id) => typeof id === "string" && /^P\d+$/.test(id);
const pid = (i) => "P" + i;
const cs = (x) => (typeof x === "string" ? x : x && typeof x === "object" ? x.cost || x.mana || "" : "");

/** variants whose spell is exiled (instead of going to the graveyard) when it resolves / is countered / fizzles */
export const M1_EXILE_VARIANTS = new Set(["jumpstart", "aftermath", "harmonize"]);

/** reduce a parsed mana cost by tapped helpers. items: [{cols:[...]}|{}] ; colourless-only ones pay generic. */
export function reduceByTaps(cost, items, { colored = true } = {}) {
  const c = { ...cost, hybrid: [...(cost.hybrid || [])] };
  for (const it of items) {
    let hit = false;
    if (colored && it.cols) for (const col of it.cols) if ((c[col] | 0) > 0) { c[col]--; hit = true; break; }
    if (!hit && c.generic > 0) c.generic--;
  }
  return c;
}
const hasManaAbility = (o) => (o.c?.abilities || []).some((a) => a.kind === "activated" && a.mana);

export const m1Methods = {
  // ================================================================ keywords as a spell (printed + grants)
  m1Kws(o, p, fd) {
    const d = fd || o.def;
    let out = d.keywords || {};
    if (!this._statics) return out;
    let view = null;
    for (const s of this._statics) {
      if (s.st.type !== "grantKw") continue;
      if (s.objIds) { if (!s.objIds.includes(o.id)) continue; }
      else {
        if (s.you !== p) continue;
        if (s.st.zone && s.st.zone !== o.zone) continue;
        if (s.st.filter) { view = view || this.spellView(o, d, p); if (!this.matches(view, s.st.filter, { source: s.src, you: s.you }, "*")) continue; }
      }
      if (s.st.zone && s.st.zone !== o.zone) continue;
      let val = s.st.value ?? true;
      if (val === "manaCost") val = d.cost || "";
      else if (val === "manaValue") val = `{${d.cmc | 0}}`;
      if (out === d.keywords) out = { ...out };
      if (out[s.st.keyword] == null || out[s.st.keyword] === false) out[s.st.keyword] = val;
    }
    return out;
  },

  // ================================================================ extra cast variants
  m1Variants(o, zone, p, d, out) {
    const kw = this.m1Kws(o, p, d);
    const castable = (fd) => fd && !fd.types.includes("land") && fd.cost != null;
    const st = this.state;
    if (zone === "hand" && castable(d)) {
      if (cs(kw.dash)) out.push({ variant: "dash", face: 0 });
      if (cs(kw.evoke)) out.push({ variant: "evoke", face: 0 });
      if (cs(kw.blitz)) out.push({ variant: "blitz", face: 0 });
      if (cs(kw.emerge)) out.push({ variant: "emerge", face: 0 });
    } else if (zone === "graveyard") {
      if (castable(d) && kw.retrace) out.push({ variant: "retrace", face: 0 });
      if (castable(d) && kw.jumpstart && (d.types.includes("instant") || d.types.includes("sorcery"))) out.push({ variant: "jumpstart", face: 0 });
      if (castable(d) && cs(kw.harmonize)) out.push({ variant: "harmonize", face: 0 });
      if (castable(d) && cs(kw.blitz) && kw.blitzFromGraveyard) out.push({ variant: "blitz", face: 0 });
      const f1 = d.layout === "mdfc" && d.faces && d.faces[1];
      if (f1 && f1.keywords?.aftermath && castable(f1)) out.push({ variant: "aftermath", face: 1 });
    } else if (zone === "exile") {
      if (o.owner === p && o.m1 && o.m1.foretold != null && o.m1.foretold < st.turn && cs(kw.foretell) && castable(d)) out.push({ variant: "foretold", face: 0 });
      if (o.owner === p && o.m1 && o.m1.plotted != null && o.m1.plotted < st.turn && castable(d)) out.push({ variant: "plotted", face: 0 });
    }
  },
  /** exile cards castable by their owner without a mayPlay permission */
  m1ExileCastable(o, p) { return !!(o && o.zone === "exile" && o.owner === p && o.m1 && ((o.m1.foretold != null && o.m1.foretold < this.state.turn) || (o.m1.plotted != null && o.m1.plotted < this.state.turn))); },
  /** a graveyard card with the aftermath half is not castable as its front half */
  m1NoGraveyardNormal(o, d) { return !!(d.faces && d.faces[1]?.keywords?.aftermath); },

  /** base cost string for the new variants (undefined = not mine) */
  m1BaseCost(p, o, v, fd) {
    const kw = this.m1Kws(o, p, o.def);
    switch (v.variant) {
      case "dash": return cs(kw.dash);
      case "evoke": return cs(kw.evoke);
      case "blitz": return cs(kw.blitz);
      case "emerge": return cs(kw.emerge);
      case "harmonize": return cs(kw.harmonize);
      case "foretold": return cs(kw.foretell);
      case "plotted": return "";
      case "miracle": return cs(kw.miracle);
      case "madness": return cs(kw.madness);
      case "suspend": return "";
      default: return undefined;
    }
  },
  /** cost mods: extra mana added to the printed/variant cost by flashback reductions etc. */
  m1CostTweak(p, o, v, c, fd) {
    // "Flashback {8}{W}{W}. This spell costs {X} less to cast this way, where X is the greatest mana value of a commander you own"
    if (v.variant === "flashback") {
      const fb = o.def.keywords?.flashback;
      if (fb && typeof fb === "object" && fb.reduceCommander) c.generic = Math.max(0, c.generic - this.m1CommanderMV(p));
    }
    // multikicker / kickers chosen on this cast (v.m1 carries the choices once known)
    if (v.m1extra) c = addCosts(c, v.m1extra);
    return c;
  },
  m1CommanderMV(p) {
    let m = 0;
    for (const id of [...this.state.players[p].command, ...this.state.battlefield]) { const o = this.state.objects[id]; if (o && o.isCommander && o.owner === p) m = Math.max(m, o.def.cmc | 0); }
    return m;
  },
  /** affinity + zone-restricted cost mods: returns delta to generic */
  m1CostDelta(p, o, v, fd) {
    let delta = 0;
    const kw = this.m1Kws(o, p, o.def);
    if (kw.affinity && kw.affinity.filter && v.variant !== "free") {
      const n = this.find({ ...kw.affinity.filter, controller: "you" }, { source: o, you: p }).length;
      delta -= n;
    }
    return delta;
  },
  /** non-mana additional cost implied by the variant */
  m1VariantAdd(o, v, fd) {
    const kw = this.m1Kws(o, o.owner, o.def);
    switch (v.variant) {
      case "retrace": return { discard: { types: ["land"] } };
      case "jumpstart": return { discard: 1 };
      case "blitz": return kw.blitz && typeof kw.blitz === "object" && kw.blitz.add ? kw.blitz.add : null;
      case "emerge": return null; // the sacrifice is made while paying (it reduces the cost)
      default: return null;
    }
  },
  m1MergeAdd(o, v, fd, add) {
    const x = this.m1VariantAdd(o, v, fd);
    if (!x) return add;
    return add ? { ...add, ...x } : x;
  },
  m1ExileLeaving(o) { return M1_EXILE_VARIANTS.has(o.castVariant) || !!(o.m1 && o.m1.exileInstead); },
  /** keyword-driven timing: plotted spells are cast at sorcery speed only */
  m1ForcesSorcery(v) { return v.variant === "plotted"; },

  // ================================================================ relief (upper bound) for enumeration
  /** The cost after the best-case taps/sacrifices — used by castCheck so convoke / improvise / emerge / harmonize spells are offered when payable. */
  m1Relief(p, o, v, fd, cost) {
    const kw = this.m1Kws(o, p, o.def);
    let c = cost;
    const st = this.state;
    const mine = st.battlefield.map((id) => st.objects[id]).filter((x) => x && x.controller === p);
    if (kw.convoke) {
      const cs2 = mine.filter((x) => !x.tapped && x.c.types.includes("creature") && !hasManaAbility(x));
      c = reduceByTaps(c, cs2.map((x) => ({ cols: x.c.colors })));
    }
    if (kw.improvise) {
      const as = mine.filter((x) => !x.tapped && x.c.types.includes("artifact") && !hasManaAbility(x));
      c = reduceByTaps(c, as.map(() => ({})), { colored: false });
    }
    if (v.variant === "emerge") {
      const best = Math.max(-1, ...mine.filter((x) => x.c.types.includes("creature")).map((x) => x.c.cmc | 0));
      if (best < 0) return null;
      c = { ...c, generic: Math.max(0, c.generic - best) };
    }
    if (v.variant === "harmonize") {
      const best = Math.max(0, ...mine.filter((x) => !x.tapped && x.c.types.includes("creature")).map((x) => x.c.power | 0));
      c = { ...c, generic: Math.max(0, c.generic - best) };
    }
    return c;
  },

  // ================================================================ choices while casting (after targets / X, before mana is paid)
  /** Returns { total, rec } or null when the cast was aborted. `total` is the parsed cost (X folded) still to be paid in mana. */
  *m1PrePay$(p, o, v, fd, ctx, total, spend) {
    const st = this.state;
    const kw = this.m1Kws(o, p, o.def);
    const rec = { from: o.zone, variant: v.variant, kickCount: 0, kickedWith: [], gift: null, offspring: false, squad: 0, replicate: 0, buyback: false, convoked: [], improvised: 0, exileInstead: false };
    let t = { ...total, hybrid: [...(total.hybrid || [])] };
    const ok = (c) => !!this.planPayment(p, { ...c, x: 0 }, { spend });
    const free = v.variant === "free" || v.variant === "plotted" || v.variant === "suspend";
    // --- optional additional costs (CR 601.2b) -------------------------------------------------------------
    if (!free) {
      if (cs(kw.multikicker)) {
        const unit = parseManaCost(cs(kw.multikicker));
        let max = 0, probe = t;
        while (max < 20) { const nxt = addCosts(probe, unit); if (!ok(nxt)) break; probe = nxt; max++; }
        const n = max ? yield* this.number$(p, `Multikicker ${cs(kw.multikicker)}: how many times?`, 0, max, o.id, { kind: "m1multikicker", unit: cs(kw.multikicker), max }) : 0;
        for (let i = 0; i < n; i++) t = addCosts(t, unit);
        rec.kickCount += n;
      }
      if (Array.isArray(kw.kickers)) {
        for (let i = 0; i < kw.kickers.length; i++) {
          const k = parseManaCost(kw.kickers[i]);
          const nxt = addCosts(t, k);
          let yes = false;
          if (ok(nxt)) yes = yield* this.confirm$(p, `Pay the ${kw.kickers[i]} kicker for ${fd.name}?`, o.id, { kind: "m1kicker", cost: kw.kickers[i], index: i });
          rec.kickedWith[i] = yes;
          if (yes) { t = nxt; rec.kickCount++; }
        }
      }
      if (cs(kw.buyback)) {
        const nxt = addCosts(t, parseManaCost(cs(kw.buyback)));
        if (ok(nxt) && (yield* this.confirm$(p, `Pay buyback ${cs(kw.buyback)} for ${fd.name}?`, o.id, { kind: "m1buyback" }))) { t = nxt; rec.buyback = true; }
      }
      if (cs(kw.replicate)) {
        const unit = parseManaCost(cs(kw.replicate));
        let max = 0, probe = t;
        while (max < 10) { const nxt = addCosts(probe, unit); if (!ok(nxt)) break; probe = nxt; max++; }
        const n = max ? yield* this.number$(p, `Replicate ${cs(kw.replicate)}: how many copies?`, 0, max, o.id, { kind: "m1replicate", max }) : 0;
        for (let i = 0; i < n; i++) t = addCosts(t, unit);
        rec.replicate = n;
      }
      if (cs(kw.offspring)) {
        const nxt = addCosts(t, parseManaCost(cs(kw.offspring)));
        if (ok(nxt) && (yield* this.confirm$(p, `Pay offspring ${cs(kw.offspring)} for ${fd.name}?`, o.id, { kind: "m1offspring" }))) { t = nxt; rec.offspring = true; }
      }
      if (kw.squad) {
        if (typeof kw.squad === "string") {
          const unit = parseManaCost(kw.squad);
          let max = 0, probe = t;
          while (max < 10) { const nxt = addCosts(probe, unit); if (!ok(nxt)) break; probe = nxt; max++; }
          const n = max ? yield* this.number$(p, `Squad ${kw.squad}: how many times?`, 0, max, o.id, { kind: "m1squad", max }) : 0;
          for (let i = 0; i < n; i++) t = addCosts(t, unit);
          rec.squad = n;
        } else if (kw.squad.exileFromGraveyard) {
          const need = kw.squad.exileFromGraveyard;
          const gy = st.players[p].graveyard.filter((id) => id !== o.id);
          if (gy.length >= need && (yield* this.confirm$(p, `Squad: exile ${need} cards from your graveyard to pay?`, o.id, { kind: "m1squad", exile: need }))) {
            const ch = yield* this.chooseObjects$(p, gy.map((id) => st.objects[id]), { prompt: `Squad: exile ${need} cards from your graveyard`, min: need, max: need, reason: "exile", source: o.id });
            for (const c of ch) this.moveObj(c, "exile");
            rec.squad = 1;
          }
        }
      }
      if (kw.gift) {
        const opps = this.opponentsOf(p);
        if (opps.length && (yield* this.confirm$(p, `Promise a gift (${kw.gift}) to an opponent?`, o.id, { kind: "m1gift", gift: kw.gift }))) {
          let who = opps[0];
          if (opps.length > 1) { const ch = yield* this.choose$(p, { prompt: "Choose the opponent who gets the gift", options: opps.map((q) => ({ id: pid(q), label: st.players[q].name, type: "player" })), min: 1, max: 1, reason: "generic" }); who = +ch[0].id.slice(1); }
          rec.gift = { player: who, kind: kw.gift };
        }
      }
    }
    // --- emerge / harmonize (they change the cost) -------------------------------------------------------
    if (v.variant === "emerge") {
      const cands = st.battlefield.map((id) => st.objects[id]).filter((x) => x && x.controller === p && x.c.types.includes("creature") && !!this.planPayment(p, { ...t, generic: Math.max(0, t.generic - (x.c.cmc | 0)), x: 0 }, { spend, exclude: new Set([x.id]) }));
      if (!cands.length) return null;
      const ch = yield* this.chooseObjects$(p, cands, { prompt: `Emerge: sacrifice a creature (reduces the cost by its mana value)`, min: 1, max: 1, reason: "sacrifice", source: o.id, hint: { kind: "m1emerge" } });
      if (!ch.length) return null;
      const victim = ch[0];
      ctx.sacrificed = ctx.sacrificed || [];
      ctx.sacrificed.push(this.snapshot(victim));
      t = { ...t, generic: Math.max(0, t.generic - (victim.c.cmc | 0)) };
      this.sacrifice(victim);
      rec.emerged = victim.id;
    }
    if (v.variant === "harmonize") {
      const cands = st.battlefield.map((id) => st.objects[id]).filter((x) => x && x.controller === p && !x.tapped && x.c.types.includes("creature") && (x.c.power | 0) > 0);
      if (cands.length) {
        const ch = yield* this.chooseObjects$(p, cands, { prompt: "Harmonize: you may tap an untapped creature you control to reduce the cost by its power", min: 0, max: 1, reason: "pay", source: o.id, hint: { kind: "m1tap", mode: "harmonize" } });
        if (ch.length) { t = { ...t, generic: Math.max(0, t.generic - (ch[0].c.power | 0)) }; this.tap(ch[0]); }
      }
    }
    // --- convoke / improvise (tap permanents to pay) ----------------------------------------------------------
    const tapPay = function* (g, mode, list, label, colored) {
      if (!list.length || costCmc(t) === 0) return;
      const ch = yield* g.chooseObjects$(p, list, { prompt: `${label}: tap ${mode === "convoke" ? "creatures" : "artifacts"} to help pay for ${fd.name}`, min: 0, max: Math.min(list.length, costCmc(t)), reason: "pay", source: o.id, hint: { kind: "m1tap", mode, cost: t, colored } });
      if (!ch.length) return;
      const t2 = reduceByTaps(t, ch.map((x) => ({ cols: x.c.colors })), { colored });
      // only tap what the reduction actually used, and only if the rest is payable
      const used = Math.min(ch.length, costCmc(t) - costCmc(t2) + 0);
      const take = ch.slice(0, Math.max(0, used));
      if (!take.length || !g.planPayment(p, { ...t2, x: 0 }, { spend, exclude: new Set(take.map((x) => x.id)) })) return;
      for (const x of take) g.tap(x);
      t = t2;
      if (mode === "convoke") rec.convoked.push(...take.map((x) => x.id)); else rec.improvised += take.length;
    };
    if (kw.convoke) yield* tapPay(this, "convoke", st.battlefield.map((id) => st.objects[id]).filter((x) => x && x.controller === p && !x.tapped && x.c.types.includes("creature")), "Convoke", true);
    if (kw.improvise) yield* tapPay(this, "improvise", st.battlefield.map((id) => st.objects[id]).filter((x) => x && x.controller === p && !x.tapped && x.c.types.includes("artifact")), "Improvise", false);
    return { total: t, rec };
  },

  /** after the spell is on the stack: store the record, bump per-turn counters */
  m1OnCast(o, p, rec, spent) {
    const colors = [];
    for (const u of spent.units || []) if (u && "WUBRG".includes(u.c) && !colors.includes(u.c)) colors.push(u.c);
    rec.colors = colors;
    rec.manaSpentUnits = (spent.units || []).map((u) => u.c);
    rec.castTurn = this.state.turn;
    rec.suspendCast = rec.variant === "suspend";
    o.m1 = rec;
    if (rec.kickCount > 0) o.kicked = true;
    const pl = this.state.players[p];
    pl.m1cast = pl.m1cast || [];
    pl.m1cast.push({ id: o.id, types: [...o.c.types], cmc: o.c.cmc | 0, name: o.c.name, from: rec.from });
  },
  /** triggers that happen as you cast: replicate copies, demonstrate, sunburst bookkeeping (counters come with the permanent entering) */
  m1AfterCast(o, p, rec) {
    const kw = this.m1Kws(o, p, this.faceDef(o));
    const self = this;
    if (rec.replicate > 0)
      this.pendInternal(o, p, { kind: "triggered", zone: "stack", text: `Replicate ${rec.replicate}`, run: function* (g, c) {
        const sp = g.state.objects[o.id];
        if (!sp || sp.zone !== "stack") return;
        for (let i = 0; i < rec.replicate; i++) yield* g.m1CopySpell$(sp, p, { newTargets: true });
      } }, { type: "cast", obj: o, player: p });
    if (kw.demonstrate)
      this.pendInternal(o, p, { kind: "triggered", zone: "stack", text: "Demonstrate", run: function* (g, c) {
        const sp = g.state.objects[o.id];
        if (!sp || sp.zone !== "stack") return;
        if (!(yield* g.confirm$(p, `Demonstrate: copy ${sp.c.name}? (an opponent will also get a copy)`, o.id, { kind: "m1demonstrate" }))) return;
        yield* g.m1CopySpell$(sp, p, { newTargets: true });
        const opps = g.opponentsOf(p);
        if (!opps.length) return;
        let q = opps[0];
        if (opps.length > 1) { const ch = yield* g.choose$(p, { prompt: "Choose an opponent to copy the spell", options: opps.map((x) => ({ id: pid(x), label: g.state.players[x].name, type: "player" })), min: 1, max: 1, reason: "generic" }); q = +ch[0].id.slice(1); }
        yield* g.m1CopySpell$(sp, q, { newTargets: true });
      } }, { type: "cast", obj: o, player: p });
    void self;
  },

  /** copy a spell on the stack for player `p`; with newTargets the copier may choose new targets */
  *m1CopySpell$(sp, p, { newTargets = true } = {}) {
    const c = this.copyStackObject(sp, p);
    c._targets = (sp._targets || []).map((g) => [...g]);
    c._modeTargets = sp._modeTargets ? sp._modeTargets.map((m) => (m || []).map((g) => [...g])) : null;
    c._modes = sp._modes ? [...sp._modes] : sp._modes;
    c.m1 = sp.m1 ? { ...sp.m1, isCopy: true, gift: sp.m1.gift } : null;
    if (newTargets && !sp.isAbility && (c._targets.some((g) => g.length) || (c._modeTargets || []).some((m) => m.some((g) => g.length)))) {
      const yes = yield* this.confirm$(p, `Choose new targets for the copy of ${sp.c.name}?`, sp.id, { kind: "newTargets", obj: c.id });
      if (yes) {
        const fd = this.faceDef(sp);
        const ctx = { source: sp, you: p, x: sp.x | 0 };
        if (c._targets.some((g) => g.length)) { const t = yield* this.chooseTargets$(p, c._targetSpecs || [], sp, ctx, fd.spell?.effects || []); if (t) c._targets = t; }
        if (c._modeTargets && fd.spell?.modes) {
          for (let i = 0; i < c._modeTargets.length; i++) {
            const m = fd.spell.modes.modes[c._modes[i]];
            if (m && m.targets?.length && c._modeTargets[i].some((g) => g.length)) { const t = yield* this.chooseTargets$(p, m.targets, sp, ctx, m.effects || []); if (t) c._modeTargets[i] = t; }
          }
        }
      }
    }
    c.targets = [...c._targets.flat(), ...(c._modeTargets ? c._modeTargets.flat(2) : [])];
    this.afterTargeting(c);
    this.markDirty();
    return c;
  },

  // ================================================================ after a permanent spell resolved (dash / evoke / blitz / offspring / squad / gift / suspend)
  *m1PostEnter$(o) {
    const rec = o.m1;
    if (!rec || o.zone !== "battlefield") return;
    const p = o.controller;
    const self = this;
    if (rec.variant === "dash" || rec.variant === "blitz" || rec.suspendCast) {
      this.addEffect({ type: "pump", power: 0, toughness: 0, keywords: ["haste"] }, { source: o, you: p }, { objIds: [o.id], until: null });
    }
    if (rec.variant === "dash") this.addDelayed({ event: "beginStep", step: "end", whose: "each" }, null, { source: o, you: p }, true, function* (g) { const x = g.state.objects[o.id]; if (x && x.zone === "battlefield" && x.m1 === rec) g.moveObj(x, "hand"); });
    if (rec.variant === "blitz") {
      this.addDelayed({ event: "beginStep", step: "end", whose: "each" }, null, { source: o, you: p }, true, function* (g) { const x = g.state.objects[o.id]; if (x && x.zone === "battlefield" && x.m1 === rec) g.sacrifice(x); });
      rec.blitzDraw = true;
    }
    if (rec.variant === "evoke")
      this.pendInternal(o, p, { kind: "triggered", text: "Evoke: sacrifice", effects: [{ op: "sacrificeIt", what: "self" }], run: function* (g) { const x = g.state.objects[o.id]; if (x && x.zone === "battlefield") g.sacrifice(x); } }, { type: "enters", obj: o });
    const copies = (rec.offspring ? 1 : 0) + (rec.squad | 0);
    if (copies > 0) {
      const mk = (label, n, pt) => this.pendInternal(o, p, { kind: "triggered", text: label, run: function* (g) {
        const x = g.state.objects[o.id] || o;
        for (let i = 0; i < n; i++) {
          const toks = g.createToken(p, { copyOf: x }, 1, { source: x, power: pt ? 1 : undefined, toughness: pt ? 1 : undefined });
          void toks;
        }
      } }, { type: "enters", obj: o });
      if (rec.offspring) mk("Offspring", 1, true);
      if (rec.squad) mk("Squad", rec.squad | 0, false);
    }
    if (rec.gift && o.def.types.includes("creature") !== undefined && rec.gift.permanent !== false) {
      this.pendInternal(o, p, { kind: "triggered", text: "Gift", run: function* (g) { yield* g.m1Gift$(rec.gift, p, o); } }, { type: "enters", obj: o });
      rec.giftGiven = true;
    }
    void self;
  },

  /** give the gift (CR 702.174): the chosen opponent gets it */
  *m1Gift$(gift, p, src) {
    if (!gift) return;
    const q = gift.player;
    const kind = String(gift.kind).toLowerCase();
    this.log(`${this.pname(p)} promised ${this.pname(q)} a gift (${kind})`);
    if (kind === "card") yield* this.drawCards$(q, 1);
    else if (kind === "extra turn") { this.state.extraTurns.push(q); this.log(`${this.pname(q)} will take an extra turn after this one`); }
    else if (kind === "octopus") this.createToken(q, { name: "Octopus", types: ["creature"], subtypes: ["octopus"], colors: ["U"], power: 8, toughness: 8 }, 1, { source: src });
    else if (kind === "treasure") this.createToken(q, "treasure", 1, { source: src });
    else if (kind === "food") this.createToken(q, "food", 1, { source: src });
    else if (kind === "tapped fish") this.createToken(q, { name: "Fish", types: ["creature"], subtypes: ["fish"], colors: ["U"], power: 1, toughness: 1 }, 1, { source: src, tapped: true });
    this.fireTrigger({ type: "giftGiven", player: p, to: q, obj: src });
  },
  /** called at the start of resolving an instant/sorcery: give the gift before the other effects */
  *m1GiftOnResolve$(o) {
    const g = o.m1 && o.m1.gift;
    if (g && !o.m1.giftGiven) { o.m1.giftGiven = true; yield* this.m1Gift$(g, o.controller, o); }
  },

  // ================================================================ per-turn bookkeeping hooks
  m1TurnReset() { for (const pl of this.state.players) { pl.m1draws = 0; pl.m1cast = []; } },
  m1OnDraw(p, o) {
    const pl = this.state.players[p];
    pl.m1draws = (pl.m1draws | 0) + 1;
    const nth = pl.m1draws;
    if (nth === 1 && o.owner === p) {
      const kw = this.m1Kws(o, p, o.def);
      if (cs(kw.miracle) && o.zone === "hand") {
        const self = this;
        this.pendInternal(o, p, { kind: "triggered", text: "Miracle", run: function* (g) {
          const x = g.state.objects[o.id];
          if (!x || x.zone !== "hand") return;
          const cost = parseManaCost(cs(kw.miracle));
          if (!g.planPayment(p, { ...cost, x: 0 }, {})) return;
          if (!(yield* g.confirm$(p, `Miracle: reveal ${x.c.name} and cast it for ${cs(kw.miracle)}?`, x.id, { kind: "m1miracle", obj: x.id }))) return;
          g.emit({ t: "reveal", objs: [x.id], player: p, text: `${g.pname(p)} reveals ${x.c.name} (miracle)` });
          yield* g.cast$(p, { type: "cast", obj: x.id, objRef: x, _v: { variant: "miracle", face: 0 } });
        } }, { type: "draw", obj: o, player: p });
        void self;
      }
    }
    return nth;
  },
  /** discard replacement for madness: returns true when the card was exiled instead (the trigger is queued) */
  m1OnDiscard(o) {
    const p = o.owner;
    const kw = this.m1Kws(o, p, o.def);
    if (!cs(kw.madness) || o.zone !== "hand") return false;
    this.moveObj(o, "exile", { quiet: true });
    this.emit({ t: "move", obj: o.id, from: "hand", to: "exile", player: p, text: `${this.pname(p)} discards ${o.c.name} (madness: exiled)` });
    this.pendInternal(o, p, { kind: "triggered", text: "Madness", run: function* (g) {
      const x = g.state.objects[o.id];
      if (!x || x.zone !== "exile") return;
      const cost = parseManaCost(cs(kw.madness));
      let cast = false;
      if (g.planPayment(p, { ...cost, x: 0 }, {}) && (yield* g.confirm$(p, `Madness: cast ${x.c.name} for ${cs(kw.madness)}?`, x.id, { kind: "m1madness" }))) {
        yield* g.cast$(p, { type: "cast", obj: x.id, objRef: x, _v: { variant: "madness", face: 0 } });
        cast = x.zone === "stack";
      }
      if (!cast && x.zone === "exile") g.moveObj(x, "graveyard");
    } }, { type: "discard", obj: o, player: p });
    this.fireTrigger({ type: "discard", player: p, obj: o });
    return true;
  },

  /** internal triggers keyed off events: exalted (printed or granted) */
  m1Triggers(evt) {
    if (evt.type === "attacks" && evt.alone && evt.obj) {
      const att = evt.obj;
      for (const id of this.state.battlefield) {
        const o = this.state.objects[id];
        if (!o || o.controller !== att.controller || !this.hasKw(o, "exalted")) continue;
        this.pendInternal(o, o.controller, { kind: "triggered", text: "Exalted", effects: [{ op: "pump", what: { ref: "event", what: "object" }, power: 1, toughness: 1, until: "endOfTurn" }] }, evt);
      }
    }
  },

  // ================================================================ conditions / amounts
  m1Cond(C, ctx) {
    const src = ctx.source ? this.state.objects[ctx.source.id] || ctx.source : null;
    const rec = (src && src.m1) || ctx.m1 || null;
    switch (C.type) {
      case "escaped": return !!src && src.castVariant === "escape";
      case "evoked": return !!rec && rec.variant === "evoke";
      case "giftPromised": return !!rec && !!rec.gift;
      case "castFromZone": return !!rec && rec.from === C.zone;
      case "castFromNotHand": return !!rec && rec.from !== "hand";
      case "wasCast": return !!rec && !!rec.castTurn;
      case "kickedWith": return !!rec && !!rec.kickedWith[C.i | 0];
      case "kickCount": { const n = rec ? rec.kickCount | 0 : 0; return C.op === "==" ? n === (C.n | 0) : n >= (C.n | 0); }
      case "castVariantIs": return !!src && src.castVariant === C.variant;
      case "spentColorlessAtLeast": return !!rec && (rec.manaSpentUnits || []).filter((c) => c === "C").length >= (C.n | 0);
      case "m1ninjutsu": return this.m1NinjutsuReady(ctx.you);
      case "_suspended": return !!src && src.zone === "exile" && !!src.m1 && !!src.m1.suspended && (src.counters.time | 0) > 0;
      case "firstDrawThisTurn": return (this.state.players[ctx.you]?.m1draws | 0) === 1;
      case "nthSpell": { const pl = this.state.players[ctx.you]; return (pl?.m1cast || []).length === (C.n | 0); }
      case "gainedLifeThisTurn": return (this.state.players[C.who === "opponent" ? this.opponentsOf(ctx.you)[0] : ctx.you]?.lifeGainedThisTurn | 0) > 0;
      case "castCountThisTurn": { const pl = this.state.players[ctx.you]; return (pl?.m1cast || []).length >= (C.n | 0); }
      default: return undefined;
    }
  },
  m1Amount(A, ctx) {
    const src = ctx.source ? this.state.objects[ctx.source.id] || ctx.source : null;
    const rec = (src && src.m1) || ctx.m1 || null;
    if ("timesKicked" in A) return rec ? rec.kickCount | 0 : 0;
    if ("convokedCount" in A) return rec ? (rec.convoked || []).length : 0;
    if ("spellsCastThisTurn" in A) { const pl = this.state.players[ctx.you]; const f = A.spellsCastThisTurn; return (pl?.m1cast || []).filter((s) => !f || !f.types || f.types.some((t) => s.types.includes(t))).length; }
    if ("commanderMV" in A) return this.m1CommanderMV(ctx.you);
    if ("distinctColorsSpent" in A) return rec ? (rec.colors || []).length : 0;
    return undefined;
  },
  // ================================================================ special actions: foretell, plot, suspend, ninjutsu, embalm, eternalize, encore, unearth
  m1NinjutsuReady(p) {
    const st = this.state;
    if (!st.combat || !["declareBlockers", "combatDamage", "firstStrikeDamage", "endCombat"].includes(st.step)) return false;
    return this.m1Unblocked(p).length > 0;
  },
  m1Unblocked(p) {
    const st = this.state;
    if (!st.combat) return [];
    return st.combat.attackers.filter((a) => !a.blocked && !(a.blockers || []).length).map((a) => st.objects[a.obj]).filter((o) => o && o.zone === "battlefield" && o.controller === p);
  },
  /** plot cost reduction statics ("Plotting cards from your hand costs {2} less") */
  m1PlotCost(p, o, base) {
    let c = parseManaCost(base);
    let delta = 0;
    for (const s of this._statics) if (s.st.type === "plotCostMod" && s.you === p) delta += this.amount(s.st.amount ?? -1, { source: s.src, you: s.you });
    c.generic = Math.max(0, c.generic + delta);
    return c;
  },
  m1Actions(p, sources, sorc, acts) {
    const st = this.state;
    const pl = st.players[p];
    if (!pl || pl.lost) return;
    const O = (id) => st.objects[id];
    const can = (c) => { try { return !!this.planPayment(p, { ...c, x: 0 }, { sources }); } catch { return false; } };
    const mine = st.active === p;
    for (const id of pl.hand) {
      const o = O(id);
      const kw = this.m1Kws(o, p, o.def);
      const d = o.def;
      const spellish = !d.types.includes("land");
      if (cs(kw.foretell) && mine && spellish) { const c = parseManaCost("{2}"); if (can(c)) acts.push({ type: "activate", obj: o.id, objRef: o, label: `Foretell ${d.name}`, cost: "{2}", zone: "hand", variant: "m1:foretell" }); }
      if (cs(kw.plot) && sorc && spellish) { const c = this.m1PlotCost(p, o, cs(kw.plot)); if (can(c)) acts.push({ type: "activate", obj: o.id, objRef: o, label: `Plot ${d.name}`, cost: costToString(c), zone: "hand", variant: "m1:plot" }); }
      if (kw.suspend && typeof kw.suspend === "object" && spellish) {
        const instantSpeed = d.types.includes("instant") || (kw.flash);
        if (instantSpeed || sorc) { const c = parseManaCost(kw.suspend.cost); if (can(c)) acts.push({ type: "activate", obj: o.id, objRef: o, label: `Suspend ${kw.suspend.n} — ${d.name}`, cost: kw.suspend.cost, zone: "hand", variant: "m1:suspend" }); }
      }
      if (cs(kw.ninjutsu) && this.m1NinjutsuReady(p)) { const c = parseManaCost(cs(kw.ninjutsu)); if (can(c)) acts.push({ type: "activate", obj: o.id, objRef: o, label: `Ninjutsu ${d.name}`, cost: cs(kw.ninjutsu), zone: "hand", variant: "m1:ninjutsu" }); }
    }
    if (sorc) for (const id of pl.graveyard) {
      const o = O(id);
      const kw = this.m1Kws(o, p, o.def);
      const d = o.def;
      for (const name of ["embalm", "eternalize", "encore"]) {
        if (!cs(kw[name])) continue;
        if (name === "embalm" && !d.types.includes("creature")) continue;
        const c = parseManaCost(cs(kw[name]));
        if (can(c)) acts.push({ type: "activate", obj: o.id, objRef: o, label: `${name[0].toUpperCase() + name.slice(1)} ${d.name}`, cost: cs(kw[name]), zone: "graveyard", variant: "m1:" + name });
      }
      // unearth: energy cost, or granted (the printed {cost} version is a synthesised ability)
      const un = kw.unearth;
      if (un && d.types.includes("creature") && (typeof un === "object" || !d.keywords?.unearth)) {
        const energy = typeof un === "object" ? un.energy | 0 : 0;
        const mana = typeof un === "string" ? un : un && un.cost ? un.cost : "";
        if ((pl.counters?.energy | 0) >= energy && can(parseManaCost(mana))) acts.push({ type: "activate", obj: o.id, objRef: o, label: `Unearth ${d.name}`, cost: energy ? `${energy} {E}` : mana, zone: "graveyard", variant: "m1:unearth" });
      }
    }
  },

  *m1Activate$(p, act) {
    const st = this.state;
    const o = act.objRef;
    const name = act.variant.slice(3);
    const pl = st.players[p];
    const kw = this.m1Kws(o, p, o.def);
    const pay = function* (g, c) { if (costCmc(c) === 0) return true; return yield* g.payMana$(p, { ...c, x: 0 }, {}); };
    if (name === "foretell" || name === "plot" || name === "suspend") {
      const c = name === "foretell" ? parseManaCost("{2}") : name === "plot" ? this.m1PlotCost(p, o, cs(kw.plot)) : parseManaCost(kw.suspend.cost);
      if (!(yield* pay(this, c))) return;
      this.moveObj(o, "exile", { quiet: true });
      if (name === "foretell") o.m1 = { foretold: st.turn };
      else if (name === "plot") o.m1 = { plotted: st.turn };
      else { o.m1 = { suspended: true }; o.counters = { ...o.counters, time: kw.suspend.n | 0 }; }
      this.emit({ t: "move", obj: o.id, from: "hand", to: "exile", player: p, text: `${pl.name} ${name === "foretell" ? "foretells a card" : name === "plot" ? `plots ${o.c.name}` : `suspends ${o.c.name} (${kw.suspend.n})`}` });
      this.markDirty();
      return;
    }
    if (name === "ninjutsu") {
      const un = this.m1Unblocked(p);
      if (!un.length) return;
      const c = parseManaCost(cs(kw.ninjutsu));
      if (!this.planPayment(p, { ...c, x: 0 }, {})) return;
      let ret = un[0];
      if (un.length > 1) { const ch = yield* this.chooseObjects$(p, un, { prompt: `Ninjutsu: return an unblocked attacker to your hand`, min: 1, max: 1, reason: "return", source: o.id, hint: { kind: "m1ninjutsu" } }); ret = ch[0]; }
      if (!(yield* pay(this, c))) return;
      const att = st.combat.attackers.find((a) => a.obj === ret.id);
      const defender = att ? att.defender : pid(this.opponentsOf(p)[0] ?? 0);
      this.moveObj(ret, "hand");
      const ab = { kind: "activated", text: `Ninjutsu ${cs(kw.ninjutsu)}`, effects: [], run: function* (g, ctx) {
        const x = g.state.objects[o.id];
        if (!x || x.zone !== "hand" || !g.state.combat) return;
        yield* g.enter$(x, { controller: p, tapped: true });
        if (x.zone !== "battlefield") return;
        x.sick = true;
        if (x.c.types.includes("creature")) g.state.combat.attackers.push({ obj: x.id, defender, blockers: [], blocked: false });
        g.emit({ t: "attack", obj: x.id, defender, text: `${x.c.name} enters tapped and attacking ${g.nameOf(defender)}` });
      } };
      const a = this.newAbilityObj(o, p, ab, { source: o, you: p, x: 0 }, { specs: [] });
      this.emit({ t: "ability", obj: a.id, source: o.id, player: p, targets: [], text: `${pl.name} activates ninjutsu (${o.c.name})` });
      return;
    }
    if (name === "embalm" || name === "eternalize" || name === "encore" || name === "unearth") {
      let energy = 0;
      let c;
      if (name === "unearth") { const un = kw.unearth; energy = typeof un === "object" ? un.energy | 0 : 0; c = parseManaCost(typeof un === "string" ? un : un && un.cost ? un.cost : ""); }
      else c = parseManaCost(cs(kw[name]));
      if (energy && (pl.counters?.energy | 0) < energy) return;
      if (!(yield* pay(this, c))) return;
      if (energy) this.addPlayerCounters(p, "energy", -energy);
      if (name !== "unearth") this.moveObj(o, "exile", { quiet: true });
      const self = this;
      const ab = { kind: "activated", text: name[0].toUpperCase() + name.slice(1), effects: [], run: function* (g, ctx) {
        if (name === "unearth") {
          const x = g.state.objects[o.id];
          if (!x || x.zone !== "graveyard") return;
          yield* g.enter$(x, { controller: p });
          if (x.zone !== "battlefield") return;
          g.addEffect({ type: "pump", power: 0, toughness: 0, keywords: ["haste"] }, { source: x, you: p }, { objIds: [x.id], until: null });
          g.addEffect({ type: "exileIfLeaves" }, { source: x, you: p }, { objIds: [x.id], until: null });
          g.addDelayed({ event: "beginStep", step: "end", whose: "each" }, [{ op: "exile", what: { ref: "it" } }], { source: x, you: p, it: [x.id] }, true);
          return;
        }
        if (name === "embalm" || name === "eternalize") {
          const def = g.copiableDef(o);
          const subs = [...new Set([...(def.subtypes || []), "zombie"])];
          g.createToken(p, { copyOf: o }, 1, { source: o, power: name === "eternalize" ? 4 : undefined, toughness: name === "eternalize" ? 4 : undefined, tokenOverride: { cost: "", cmc: 0, colors: [name === "embalm" ? "W" : "B"], subtypes: subs } });
          return;
        }
        // encore: for each opponent create a token copy that attacks that player this turn if able; sacrifice them at the next end step
        const made = [];
        for (const q of g.opponentsOf(p)) {
          const t = g.createToken(p, { copyOf: o }, 1, { source: o });
          for (const tk of t) {
            made.push(tk);
            g.addEffect({ type: "pump", power: 0, toughness: 0, keywords: ["haste"] }, { source: tk, you: p }, { objIds: [tk.id], until: null });
            g.addEffect({ type: "mustAttack", affects: "self", attackPlayer: pid(q) }, { source: tk, you: p }, { objIds: [tk.id], until: "endOfTurn" });
          }
        }
        if (made.length) g.addDelayed({ event: "beginStep", step: "end", whose: "each" }, null, { source: o, you: p }, true, function* (g2) { for (const tk of made) if (tk.zone === "battlefield") g2.sacrifice(tk); });
      } };
      void self;
      const a = this.newAbilityObj(o, p, ab, { source: o, you: p, x: 0 }, { specs: [] });
      this.emit({ t: "ability", obj: a.id, source: o.id, player: p, targets: [], text: `${pl.name} activates ${name} (${o.c.name})` });
      this.markDirty();
      return;
    }
  },

  /** `cost.m1` — extra cost parts: { energy:n } */
  m1CanPay(p, m1, src, ctx) {
    if (m1.energy && (this.state.players[p].counters?.energy | 0) < m1.energy) return false;
    return true;
  },
  *m1Pay$(p, m1, src, ctx) {
    if (m1.energy) this.addPlayerCounters(p, "energy", -m1.energy);
    return true;
  },

};

/** Effect ops added by m1 (merged into the executor's OPS table) */
export const m1Ops = {
  *_suspendTick$(e, ctx) {
    const o = ctx.source && this.state.objects[ctx.source.id];
    if (!o || o.zone !== "exile" || !o.m1 || !o.m1.suspended || !(o.counters.time | 0)) return;
    o.counters.time--;
    this.emit({ t: "counters", obj: o.id, kind: "time", delta: -1, text: `A time counter is removed from ${o.c.name} (${o.counters.time} left)` });
    this.fireTrigger({ type: "m1timeRemoved", obj: o, player: o.owner });
    if (o.counters.time > 0) return;
    const p = o.owner;
    o.counters = {};
    const d = o.def;
    if (d.types.includes("land")) return;
    const wasM1 = { ...o.m1, suspended: false };
    o.m1 = wasM1;
    yield* this.cast$(p, { type: "cast", obj: o.id, objRef: o, _v: { variant: "suspend", face: 0 } });
    if (o.zone === "stack") this.log(`${o.c.name} is cast from suspend`);
  },
  /** copySpell — superset of the original: filter on the copied spell, new targets, "then return it to its owner's hand", copy for each ... */
  *copySpell$(e, ctx) {
    const objs = this.objsOf(yield* this.refs$(e.what ?? { ref: "target", i: 0 }, ctx)).filter((o) => o.zone === "stack");
    const n = this.amount(e.amount ?? 1, ctx);
    for (const o of objs) for (let i = 0; i < n; i++) {
      if (e.newTargets && !o.isAbility) yield* this.m1CopySpell$(o, ctx.you, { newTargets: true });
      else this.copyStackObject(o, ctx.you);
    }
  },
};
