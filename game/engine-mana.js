// engine-mana.js — mana sources, automatic payment solver, pool spending. Mixed into Game.
import { COLORS, MANA_KEYS, parseManaCost, colorLetter, poolTotal, costCmc } from "./engine-util.js";

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
            } else if (m && m.identity) {
              const ids = this.identityOf(p);
              for (let i = 0; i < (this.amount(m.identity, ctx) || 1); i++) units.push(ids.length ? ids : ["C"]);
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

  /** Is the non-mana part of an activated ability's cost basically payable (tap/sick/limit)? */
  tapReady(o, p) {
    if (o.tapped) return false;
    if (o.c.types.includes("creature") && o.sick && !this.hasKw(o, "haste")) return false;
    return true;
  },

  /**
   * Auto-pay mana sources for player p: [{obj, opts:[{abIndex, units, input, penalty}], flex, penalty}].
   * Only {T}-based abilities (optionally with sacrifice-self on non-creatures, mana input, or life) are used.
   */
  manaSources(p, exclude) {
    const out = [];
    const st = this.state;
    for (const id of st.battlefield) {
      const o = st.objects[id];
      if (!o || o.controller !== p || o.tapped) continue;
      if (exclude && exclude.has(id)) continue;
      const abs = o.c.abilities;
      let opts = null;
      for (let i = 0; i < abs.length; i++) {
        const ab = abs[i];
        if (ab.kind !== "activated" || !ab.mana) continue;
        const cost = ab.cost || {};
        if (!cost.tap) continue;
        if (cost.sac || cost.discard || cost.removeCounters || cost.exileSelf || cost.tapOther || cost.untap) continue;
        if (cost.sacSelf && o.c.types.includes("creature")) continue;
        if (ab.condition && !this.evalCond(ab.condition, { source: o, you: p, quiet: true })) continue;
        if (!this.tapReady(o, p)) break;
        const units = this.manaUnits(o, ab, p);
        if (!units.length) continue;
        let input = null;
        if (cost.mana) {
          input = parseManaCost(cost.mana);
          if (MANA_KEYS.some((k) => input[k]) || input.hybrid.length || input.phyrexian.length || input.x) continue; // coloured input: manual only
        }
        let penalty = 0;
        if (cost.sacSelf) penalty += 3;
        if (cost.life) penalty += 1;
        if ((ab.effects || []).some((e) => e && (e.op === "damage" || e.op === "loseLife"))) penalty += 1;
        if (o.c.types.includes("creature")) penalty += 0.2;
        (opts ||= []).push({ abIndex: i, units, input: input ? input.generic : 0, penalty });
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

  /**
   * Plan a payment of parsed cost `cost` (X already folded into generic) for player p.
   * Returns { steps:[{obj, abIndex, colors:[...] }], fromPool:true } or null if unaffordable.
   * opts: { exclude:Set<objId>, sources, delve:n (graveyard cards usable for generic), lifeOk }
   */
  planPayment(p, cost, opts = {}) {
    const pl = this.state.players[p];
    const pool = { ...pl.mana };
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
    let life = opts.lifeOk === false ? 0 : pl.life;
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
    if (!slots.length && generic <= 0) return { steps: [], life: 0 };
    const sources = opts.sources ? opts.sources.filter((s) => !(opts.exclude && opts.exclude.has(s.obj.id)) && !s.obj.tapped) : this.manaSources(p, opts.exclude);
    if (!sources.length && !slots.some((s) => s.alt || s.life)) return null;
    // order slots: fewest providers first
    const providers = (sl) => sources.reduce((n, s) => n + (s.opts.some((o) => o.units.some((u) => u.some((c) => sl.cols.includes(c)))) ? 1 : 0), 0);
    const slotOrder = slots.map((s) => ({ s, n: providers(s) })).sort((a, b) => a.n - b.n).map((x) => x.s);
    const used = new Array(sources.length).fill(null); // chosen option index per source
    const choice = []; // [{si, oi, colors:[]}]
    let budget = NODE_BUDGET;
    let lifePaid = 0;
    let extraGeneric = 0;
    const leftovers = []; // [{si, cols}]

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
        const r = dfs(i + 1);
        if (r) return r;
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
    return { steps, life: lifePaid };
  },

  canPayMana(p, cost, opts) { return !!this.planPayment(p, cost, opts); },

  /** Max X affordable for a parsed cost containing X. */
  maxX(p, cost, opts = {}) {
    if (!cost.x) return 0;
    const sources = opts.sources || this.manaSources(p, opts.exclude);
    let pot = poolTotal(this.state.players[p].mana) + (opts.delve || 0);
    for (const s of sources) pot += Math.max(...s.opts.map((o) => o.units.length - o.input));
    let hi = Math.floor((pot - costCmc(cost)) / cost.x);
    for (let x = Math.min(hi, 40); x >= 0; x--) {
      const c = { ...cost, generic: cost.generic + x * cost.x, x: 0 };
      if (this.planPayment(p, c, { ...opts, sources })) return x;
    }
    return -1;
  },

  /** Spend a parsed cost from the pool (no X). Returns false (pool untouched) if not possible. */
  spendFromPool(p, cost) {
    const pl = this.state.players[p];
    const pool = { ...pl.mana };
    let lifeCost = 0;
    for (const k of MANA_KEYS) { if (pool[k] < (cost[k] | 0)) return false; pool[k] -= cost[k] | 0; }
    for (const ph of cost.phyrexian || []) {
      if (pool[ph] > 0) pool[ph]--;
      else lifeCost += 2;
    }
    let generic = (cost.generic | 0) + (cost.snow | 0);
    for (const h of cost.hybrid || []) {
      const cols = h.map(colorLetter).filter(Boolean);
      let best = null;
      for (const c of cols) if (pool[c] > 0 && (best == null || pool[c] > pool[best])) best = c;
      if (best) pool[best]--;
      else { const gen = h.find((x) => /^\d+$/.test(x)); if (gen) generic += +gen; else return false; }
    }
    while (generic > 0) {
      let best = null;
      if (pool.C > 0) best = "C";
      else for (const c of COLORS) if (pool[c] > 0 && (best == null || pool[c] > pool[best])) best = c;
      if (!best) return false;
      pool[best]--; generic--;
    }
    if (lifeCost && pl.life < lifeCost) return false;
    pl.mana = pool;
    if (lifeCost) this.loseLife(p, lifeCost, { cost: true });
    this.markDirty();
    return true;
  },

  /** Execute a payment plan, then spend `cost` from the pool. Generator (mana abilities run through the IR executor). */
  *executePlan$(p, plan, cost) {
    const steps = [...plan.steps].sort((a, b) => (a.input > 0) - (b.input > 0));
    for (const s of steps) {
      if (s.input > 0) {
        if (!this.spendFromPool(p, { ...parseManaCost(""), generic: s.input })) continue;
      }
      yield* this.activateManaAbility$(p, s.obj, s.abIndex, s.colors, true);
    }
    if (plan.life) {
      // phyrexian life is handled inside spendFromPool when the colour is missing
    }
    return this.spendFromPool(p, cost);
  },

  /** Pay a parsed mana cost (X folded) automatically. Returns bool; state untouched on failure. */
  *payMana$(p, cost, opts = {}) {
    if (costCmc(cost) === 0) return true;
    const plan = this.planPayment(p, cost, opts);
    if (!plan) return false;
    return yield* this.executePlan$(p, plan, cost);
  },
};

function bestNet(s) {
  let m = 0;
  for (const o of s.opts) m = Math.max(m, o.units.length - o.input);
  return m;
}
