// engine-mana.js — mana sources, automatic payment solver, pool spending. Mixed into Game.
import { COLORS, MANA_KEYS, parseManaCost, colorLetter, poolTotal, costCmc, addCosts } from "./engine-util.js";

const ALL5 = ["W", "U", "B", "R", "G"];
const NODE_BUDGET = 4000;

export const manaMethods = {
  /** Colours of the player's commanders' identity (for "identity" mana); [] in non-commander games. */
  identityOf(p) {
    const pl = this.state.players[p];
    const out = new Set();
    for (const id of pl.commanders) { const o = this.state.objects[id]; for (const c of o?.def?.identity || []) out.add(c); }
    return ALL5.filter((c) => out.has(c));
  },

  /** Units (array of allowed-colour arrays) an addMana effect list would produce right now. */
  manaUnits(o, ab, p) {
    const units = [];
    const ctx = { source: o, you: p, quiet: true };
    const walk = (list) => {
      for (const e of list || []) {
        if (!e || typeof e !== "object") continue;
        if (e.op === "addMana") {
          let times = 1;
          if (e.amount != null) times = Math.max(0, this.amount(e.amount, ctx) | 0);
          const m = e.mana;
          for (let t = 0; t < times; t++) {
            if (typeof m === "string") {
              const c = parseManaCost(m);
              for (const k of MANA_KEYS) for (let i = 0; i < c[k]; i++) units.push([k]);
              for (let i = 0; i < c.generic; i++) units.push(["C"]);
            } else if (m && m.anyOf) {
              const cols = m.anyOf.map(colorLetter).filter(Boolean);
              for (let i = 0; i < (m.n || 1); i++) units.push(cols);
            } else if (m && m.any) {
              for (let i = 0; i < (this.amount(m.any, ctx) || 1); i++) units.push(ALL5);
            } else if (m && m.color) {
              const col = colorLetter(m.color);
              for (let i = 0; i < (this.amount(m.n ?? 1, ctx) || 0); i++) units.push([col || "C"]);
            } else if (m && m.identity) {
              const ids = this.identityOf(p);
              for (let i = 0; i < (this.amount(m.identity, ctx) || 1); i++) units.push(ids.length ? ids : ["C"]);
            } else if (m && m.landColors) {
              const cols = [...this.landColors(m.landColors === "opponent" ? this.opponentsOf(p) : m.landColors === "you" ? [p] : this.alivePlayers())];
              if (cols.length) for (let i = 0; i < (m.n || 1); i++) units.push(ALL5.filter((c) => cols.includes(c)));
            }
          }
        } else if (e.op === "if") {
          let ok = false;
          try { ok = this.evalCond(e.cond, ctx); } catch { ok = false; }
          walk(ok ? e.then : e.else);
        }
      }
    };
    walk(ab.effects);
    return units;
  },

  /** Is the non-mana part of an activated ability's cost basically payable (tap/sick/limit)? `untapCost` checks {Q}. */
  tapReady(o, p, untapCost) {
    if (untapCost ? !o.tapped : o.tapped) return false;
    if (o.c.types.includes("creature") && o.sick && !this.hasKw(o, "haste") && !o.c.activateAsHaste) return false;
    return true;
  },
  /** The spend restriction of a mana ability (resolved for its source), or null. */
  manaRestrictOf(o, ab) {
    for (const e of ab.effects || []) if (e && e.op === "addMana" && e.restrict) return this.resolveRestrict(e.restrict, o);
    return null;
  },

  /**
   * Auto-pay mana sources for player p: [{obj, opts:[{abIndex, units, input, inputCost, net, penalty, costly, restrict, sac}], flex, penalty}].
   * "Costly" options (sacrifice a creature, coloured mana input) are used only when nothing else can pay (planPayment).
   * Scripted (`run`) mana abilities stay manual actions.
   */
  manaSources(p, exclude) {
    const out = [];
    const st = this.state;
    for (const id of st.battlefield) {
      const o = st.objects[id];
      if (!o || o.controller !== p) continue;
      if (exclude && exclude.has(id)) continue;
      const abs = o.c.abilities;
      let opts = null, extra = null;
      for (let i = 0; i < abs.length; i++) {
        const ab = abs[i];
        if (ab.kind !== "activated" || !ab.mana) continue;
        if (typeof ab.run === "function") continue;
        const cost = ab.cost || {};
        if (cost.discard || cost.removeCounters || cost.exileSelf || cost.tapOther || cost.exileFromGraveyard || cost.loyalty != null) continue;
        if (!cost.tap && !cost.untap && !cost.sacSelf && !cost.sac) continue;
        if ((cost.tap || cost.untap) && !this.tapReady(o, p, !!cost.untap)) continue;
        if (ab.limit === "turn" && o.activations && o.activations.turn === st.turn && (o.activations[i] | 0) >= 1) continue;
        if (ab.condition && !this.evalCond(ab.condition, { source: o, you: p, quiet: true })) continue;
        let units = this.manaUnits(o, ab, p);
        if (!units.length) continue;
        if (cost.tap) { if (!extra) extra = this.extraManaUnits(o, p); if (extra.length) units = [...units, ...extra]; }
        let input = 0, inputCost = null, costly = false;
        if (cost.mana) {
          const ic = parseManaCost(cost.mana);
          if (ic.x) continue;
          if (MANA_KEYS.some((k) => ic[k]) || ic.hybrid.length || ic.phyrexian.length) { costly = true; inputCost = ic; } // coloured input (filter lands)
          else input = ic.generic;
        }
        let penalty = 0;
        if (cost.sacSelf) penalty += 3;
        if (cost.sacSelf && o.c.types.includes("creature")) { costly = true; penalty += 4; }
        if (cost.sac) { costly = true; penalty += 6; }
        if (cost.life) penalty += 1;
        if ((ab.effects || []).some((e) => e && (e.op === "damage" || e.op === "loseLife"))) penalty += 1;
        if (o.c.types.includes("creature")) penalty += 0.2;
        const restrict = this.manaRestrictOf(o, ab);
        if (restrict) penalty -= 0.1;
        const net = units.length - input - (inputCost ? costCmc(inputCost) : 0);
        (opts ||= []).push({ abIndex: i, units, input, inputCost, net, penalty, costly, restrict, sac: cost.sac || null, sacSelf: !!cost.sacSelf, sacCount: cost.sac ? cost.sacCount || 1 : 0, repeatable: !cost.tap && !cost.untap && !cost.sacSelf });
      }
      if (!opts) continue;
      const cols = new Set();
      for (const op of opts) for (const u of op.units) for (const c of u) cols.add(c);
      opts.sort((a, b) => a.penalty - b.penalty || b.units.length - a.units.length);
      out.push({ obj: o, opts, flex: cols.size, penalty: Math.min(...opts.map((x) => x.penalty)) });
    }
    out.sort((a, b) => a.penalty - b.penalty || a.flex - b.flex || (a.obj.ts - b.obj.ts));
    return out;
  },

  /** Special pool units (Secluded Courtyard / Path of Ancestry mana) usable in a spend context. */
  usableManaX(p, spend) {
    return (this.state.players[p].manaX || []).filter((u) => this.restrictOk(u.restrict, spend));
  },

  /**
   * Plan a payment of parsed cost `cost` (X already folded into generic) for player p.
   * Returns { steps:[{obj, abIndex, colors, input, inputCost}], life, sacrifices } or null if unaffordable.
   * opts: { exclude:Set<objId>, sources, delve:n, lifeOk, spend: spend context, noCostly }
   */
  planPayment(p, cost, opts = {}) {
    let all = opts.sources ? opts.sources.filter((s) => !(opts.exclude && opts.exclude.has(s.obj.id)) && s.obj.zone === "battlefield" && !(s.obj.tapped && !s.opts.some((o) => o.sac || o.repeatable))) : this.manaSources(p, opts.exclude);
    if (all.some((s) => s.opts.some((o) => o.restrict))) all = all.map((s) => ({ ...s, opts: s.opts.filter((o) => !o.restrict || this.restrictOk(o.restrict, opts.spend)) })).filter((s) => s.opts.length);
    const cheap = all.some((s) => s.opts.some((o) => o.costly)) ? all.map((s) => ({ ...s, opts: s.opts.filter((o) => !o.costly) })).filter((s) => s.opts.length) : all;
    const r = this.planCore(p, cost, { ...opts, sources: cheap });
    if (r || opts.noCostly || cheap === all) return r;
    // nothing cheap pays it: allow sacrifice-for-mana / filter sources, fewest activations first (max 3)
    const costly = [];
    for (const s of all) for (const o of s.opts) if (o.costly) costly.push({ s, o });
    if (!costly.length) return null;
    const pl = this.state.players[p];
    let upper = poolTotal(pl.mana) + this.usableManaX(p, opts.spend).length + (opts.delve || 0);
    for (const s of cheap) upper += Math.max(0, ...s.opts.map((o) => o.units.length - o.input));
    const need = costCmc(cost);
    const sacCands = this.state.battlefield.map((id) => this.state.objects[id]).filter((o) => o.controller === p && o.c.types.includes("creature") && o.id !== this._manaProtect && !(opts.exclude && opts.exclude.has(o.id)));
    costly.sort((a, b) => a.o.penalty - b.o.penalty);
    const combos = [];
    const rec = (start, picked, gain) => {
      if (picked.length && upper + gain >= need) combos.push([...picked]);
      if (picked.length >= 3 || combos.length > 60) return;
      for (let k = start; k < costly.length; k++) {
        const c = costly[k];
        if (!c.o.repeatable && picked.includes(c)) continue;
        if (!c.o.repeatable && picked.some((x) => x.s === c.s)) continue; // one tap per source
        picked.push(c); rec(c.o.repeatable ? k : k + 1, picked, gain + c.o.net); picked.pop();
      }
    };
    rec(0, [], 0);
    combos.sort((a, b) => a.length - b.length || a.reduce((n, c) => n + c.o.penalty, 0) - b.reduce((n, c) => n + c.o.penalty, 0));
    for (const combo of combos) {
      let sac = 0, sacSelfCre = new Set();
      for (const c of combo) { sac += c.o.sacCount; if (c.o.sacSelf && c.s.obj.c.types.includes("creature")) sacSelfCre.add(c.s.obj.id); }
      if (sac > sacCands.filter((o) => !sacSelfCre.has(o.id) && !combo.some((c) => c.s.obj.id === o.id && !c.o.repeatable)).length) continue;
      let total = cost;
      const seed = [], offs = [];
      for (const c of combo) { if (c.o.inputCost) total = addCosts(total, c.o.inputCost); else if (c.o.input) total = { ...total, generic: total.generic + c.o.input }; offs.push(seed.length); for (const u of c.o.units) seed.push(u); }
      const used = new Set(combo.filter((c) => !c.o.repeatable).map((c) => c.s.obj.id));
      const rest = cheap.filter((s) => !used.has(s.obj.id) && !(sacSelfCre.has(s.obj.id)));
      const plan = this.planCore(p, total, { ...opts, sources: rest, seed });
      if (!plan) continue;
      plan.costly = combo.map((c, k) => ({ obj: c.s.obj, abIndex: c.o.abIndex, colors: c.o.units.map((u, j) => (plan.seedColors || [])[offs[k] + j] || u[0]), inputCost: c.o.inputCost, input: c.o.input }));
      plan.sacrifices = sac + sacSelfCre.size;
      return plan;
    }
    return null;
  },

  planCore(p, cost, opts = {}) {
    const pl = this.state.players[p];
    const pool = { ...pl.mana };
    for (const u of this.usableManaX(p, opts.spend)) pool[u.c] = (pool[u.c] | 0) + 1;
    const need = { W: cost.W | 0, U: cost.U | 0, B: cost.B | 0, R: cost.R | 0, G: cost.G | 0, C: cost.C | 0 };
    let generic = (cost.generic | 0) + (cost.snow | 0);
    for (const k of MANA_KEYS) { const u = Math.min(pool[k], need[k]); pool[k] -= u; need[k] -= u; }
    const slots = [];
    for (const k of MANA_KEYS) for (let i = 0; i < need[k]; i++) slots.push({ cols: [k] });
    for (const h of cost.hybrid || []) {
      const cols = h.map((x) => colorLetter(x)).filter(Boolean);
      const gen = h.find((x) => /^\d+$/.test(x));
      const pc = cols.find((c) => pool[c] > 0);
      if (pc) { pool[pc]--; continue; }
      slots.push({ cols, alt: gen ? +gen : 0 });
    }
    let life = opts.lifeOk === false || pl.lifeLocked ? 0 : pl.life;
    for (const ph of cost.phyrexian || []) {
      if (pool[ph] > 0) { pool[ph]--; continue; }
      slots.push({ cols: [ph], life: 2 });
    }
    // pool pays generic
    let poolLeft = poolTotal(pool);
    const fromPoolGeneric = Math.min(poolLeft, generic);
    generic -= fromPoolGeneric;
    poolLeft -= fromPoolGeneric;
    if (opts.delve) generic -= Math.min(opts.delve, generic);
    const seed = (opts.seed || []).map((cols, k) => ({ si: -1, cols, seed: k }));
    const seedUse = new Map(); // seed index -> colour it paid
    if (!slots.length && generic - seed.length <= 0) return { steps: [], life: 0, sacrifices: 0, seedColors: seed.map((sd) => sd.cols[0]) };
    const sources = (opts.sources || this.manaSources(p, opts.exclude)).filter((s) => !(opts.exclude && opts.exclude.has(s.obj.id)));
    if (!sources.length && !seed.length && !slots.some((s) => s.alt || s.life)) return null;    // order slots: fewest providers first
    const providers = (sl) => sources.reduce((n, s) => n + (s.opts.some((o) => o.units.some((u) => u.some((c) => sl.cols.includes(c)))) ? 1 : 0), 0);
    const slotOrder = slots.map((s) => ({ s, n: providers(s) })).sort((a, b) => a.n - b.n).map((x) => x.s);
    const used = new Array(sources.length).fill(null); // chosen option index per source
    const choice = []; // [{si, oi, colors:[]}]
    let budget = NODE_BUDGET;
    let lifePaid = 0;
    let extraGeneric = 0;
    const leftovers = [...seed]; // [{si, cols}] — seed: units from costly activations planned around this payment

    const finishGeneric = () => {
      let g = generic + extraGeneric;
      // inputs of used sources
      for (const ch of choice) g += sources[ch.si].opts[ch.oi].input;
      g -= leftovers.length;
      const extra = [];
      if (g <= 0) return extra;
      const cand = [];
      for (let si = 0; si < sources.length; si++) if (used[si] == null) cand.push(si);
      // prefer non-penalty, colourless/least flexible, more units
      cand.sort((a, b) => sources[a].penalty - sources[b].penalty || sources[a].flex - sources[b].flex || bestNet(sources[b]) - bestNet(sources[a]));
      for (const si of cand) {
        if (g <= 0) break;
        const s = sources[si];
        let best = -1, bestScore = -1e9;
        for (let oi = 0; oi < s.opts.length; oi++) {
          const o = s.opts[oi];
          const net = o.units.length - o.input;
          if (net <= 0) continue;
          const score = Math.min(net, g) * 10 - o.penalty * 5 - Math.max(0, net - g);
          if (score > bestScore) { bestScore = score; best = oi; }
        }
        if (best < 0) continue;
        const o = s.opts[best];
        g -= o.units.length - o.input;
        extra.push({ si, oi: best, colors: o.units.map((u) => u[0]) });
      }
      return g <= 0 ? extra : null;
    };

    const dfs = (i) => {
      if (--budget < 0) return null;
      if (i === slotOrder.length) return finishGeneric();
      const sl = slotOrder[i];
      // leftover unit from a multi-unit source already chosen
      for (let li = 0; li < leftovers.length; li++) {
        const lu = leftovers[li];
        const col = lu.cols.find((c) => sl.cols.includes(c));
        if (!col) continue;
        leftovers.splice(li, 1);
        if (lu.seed != null) seedUse.set(lu.seed, col);
        const r = dfs(i + 1);
        if (r) return r;
        if (lu.seed != null) seedUse.delete(lu.seed);
        leftovers.splice(li, 0, lu);
      }
      for (let si = 0; si < sources.length; si++) {
        if (used[si] != null) continue;
        const s = sources[si];
        for (let oi = 0; oi < s.opts.length; oi++) {
          const o = s.opts[oi];
          const ui = o.units.findIndex((u) => u.some((c) => sl.cols.includes(c)));
          if (ui < 0) continue;
          const col = o.units[ui].find((c) => sl.cols.includes(c));
          used[si] = oi;
          const colors = o.units.map((u, k) => (k === ui ? col : u.includes(col) ? col : u[0]));
          const ch = { si, oi, colors };
          choice.push(ch);
          const added = [];
          for (let k = 0; k < o.units.length; k++) if (k !== ui) { const lu = { si, cols: o.units[k].includes(col) ? [col, ...o.units[k]] : o.units[k] }; leftovers.push(lu); added.push(lu); }
          const r = dfs(i + 1);
          if (r) return r;
          for (const lu of added) leftovers.splice(leftovers.indexOf(lu), 1);
          choice.pop();
          used[si] = null;
          break; // one option per source per slot is enough (options sorted by penalty)
        }
      }
      if (sl.alt) { extraGeneric += sl.alt; const r = dfs(i + 1); if (r) return r; extraGeneric -= sl.alt; }
      if (sl.life && life - lifePaid > sl.life) { lifePaid += sl.life; const r = dfs(i + 1); if (r) return r; lifePaid -= sl.life; }
      return null;
    };
    const extra = dfs(0);
    if (!extra) return null;
    const steps = [];
    for (const ch of [...choice, ...extra]) {
      const s = sources[ch.si];
      steps.push({ obj: s.obj, abIndex: s.opts[ch.oi].abIndex, colors: ch.colors, input: s.opts[ch.oi].input });
    }
    return { steps, life: lifePaid, sacrifices: 0, seedColors: seed.map((sd) => seedUse.get(sd.seed) || sd.cols[0]) };
  },

  canPayMana(p, cost, opts) { return !!this.planPayment(p, cost, opts); },

  /** Max X affordable for a parsed cost containing X. */
  maxX(p, cost, opts = {}) {
    if (!cost.x) return 0;
    const sources = opts.sources || this.manaSources(p, opts.exclude);
    let pot = poolTotal(this.state.players[p].mana) + (opts.delve || 0);
    for (const s of sources) pot += Math.max(...s.opts.map((o) => o.net ?? o.units.length - o.input));
    pot += this.usableManaX(p, opts.spend).length;
    let hi = Math.floor((pot - costCmc(cost)) / cost.x);
    for (let x = Math.min(hi, 40); x >= 0; x--) {
      const c = { ...cost, generic: cost.generic + x * cost.x, x: 0 };
      if (this.planPayment(p, c, { ...opts, sources })) return x;
    }
    return -1;
  },

  /** Spend a parsed cost from the pool (no X) in spend context `spend`. Returns false (pool untouched) if not possible.
   *  Restricted mana is spent first when allowed; tracked units whose "when spent" bonus applies are preferred.
   *  Sets this._lastSpend = { n: mana spent, units } (for Increment and "when that mana is spent" triggers). */
  spendFromPool(p, cost, spend) {
    const pl = this.state.players[p];
    const pool = { ...pl.mana };
    const xs = (pl.manaX || []).map((u, i) => ({ u, i })).filter((x) => this.restrictOk(x.u.restrict, spend));
    const prio = (x) => (x.u.restrict ? 0 : x.u.onSpend && this.onSpendMatches(x.u, spend, p) ? 1 : 3);
    xs.sort((a, b) => prio(a) - prio(b) || a.i - b.i);
    const usedX = new Set(), spent = [];
    const freeX = (col, maxPrio) => xs.find((x) => !usedX.has(x.i) && (col == null || x.u.c === col) && prio(x) <= maxPrio);
    const takeX = (x) => { usedX.add(x.i); spent.push(x.u); return true; };
    const count = (col) => pool[col] + xs.filter((x) => !usedX.has(x.i) && x.u.c === col).length;
    const take = (col) => {
      let x = freeX(col, 1);
      if (x) return takeX(x);
      if (pool[col] > 0) { pool[col]--; spent.push({ c: col }); return true; }
      x = freeX(col, 9);
      return x ? takeX(x) : false;
    };
    for (const k of MANA_KEYS) for (let n = 0; n < (cost[k] | 0); n++) if (!take(k)) return false;
    let lifeCost = 0;
    for (const ph of cost.phyrexian || []) { if (count(ph) > 0) take(ph); else lifeCost += 2; }
    let generic = (cost.generic | 0) + (cost.snow | 0);
    for (const h of cost.hybrid || []) {
      const cols = h.map(colorLetter).filter(Boolean);
      let best = null;
      for (const c of cols) if (count(c) > 0 && (best == null || count(c) > count(best))) best = c;
      if (best) take(best);
      else { const gen = h.find((x) => /^\d+$/.test(x)); if (gen) generic += +gen; else return false; }
    }
    while (generic > 0) {
      let x = freeX(null, 1);
      if (x) { takeX(x); generic--; continue; }
      let best = null;
      if (pool.C > 0) best = "C";
      else for (const c of COLORS) if (pool[c] > 0 && (best == null || pool[c] > pool[best])) best = c;
      if (best) { pool[best]--; spent.push({ c: best }); generic--; continue; }
      x = freeX(null, 9);
      if (x) { takeX(x); generic--; continue; }
      return false;
    }
    if (lifeCost && (pl.life < lifeCost || pl.lifeLocked)) return false;
    pl.mana = pool;
    if (usedX.size) pl.manaX = pl.manaX.filter((_, i) => !usedX.has(i));
    if (lifeCost) this.loseLife(p, lifeCost, { cost: true });
    this._lastSpend = { n: spent.length, units: spent };
    this.markDirty();
    return true;
  },

  /** Execute a payment plan, then spend `cost` from the pool. Generator (mana abilities run through the IR executor). */
  *executePlan$(p, plan, cost, spend) {
    const steps = [...plan.steps].sort((a, b) => (a.input > 0) - (b.input > 0));
    for (const s of steps) {
      if (s.input > 0) {
        if (!this.spendFromPool(p, { ...parseManaCost(""), generic: s.input }, { kind: "ability", source: s.obj, player: p })) continue;
      }
      yield* this.activateManaAbility$(p, s.obj, s.abIndex, s.colors, true);
    }
    for (const s of plan.costly || []) { // sacrifice / filter sources (their input is paid from the pool first)
      if (s.inputCost && !this.spendFromPool(p, s.inputCost, { kind: "ability", source: s.obj, player: p })) continue;
      if (!s.inputCost && s.input && !this.spendFromPool(p, { ...parseManaCost(""), generic: s.input }, { kind: "ability", source: s.obj, player: p })) continue;
      if (s.obj.zone !== "battlefield") continue;
      yield* this.activateManaAbility$(p, s.obj, s.abIndex, s.colors, true);
    }
    return this.spendFromPool(p, cost, spend);
  },

  /** Pay a parsed mana cost (X folded) automatically. Returns bool; state untouched on failure. */
  *payMana$(p, cost, opts = {}) {
    this._lastSpend = { n: 0, units: [] };
    if (costCmc(cost) === 0) return true;
    const plan = this.planPayment(p, cost, opts);
    if (!plan) return false;
    const prev = this._manaProtect;
    this._manaProtect = opts.protect || null;
    try { return yield* this.executePlan$(p, plan, cost, opts.spend || null); }
    finally { this._manaProtect = prev; }
  },
};

function bestNet(s) {
  let m = 0;
  for (const o of s.opts) m = Math.max(m, o.units.length - o.input);
  return m;
}
