// engine-combat.js — combat phase: attackers, blockers, first-strike/regular damage, end of combat. Mixed into Game.
const isPid = (id) => typeof id === "string" && /^P\d+$/.test(id);
const pid = (i) => "P" + i;

export const combatMethods = {
  defenderPlayer(def) {
    if (isPid(def)) return +def.slice(1);
    const o = this.state.objects[def];
    return o ? o.controller : null;
  },

  *combatPhase$() {
    const st = this.state;
    yield* this.beginStep$("beginCombat");
    if (this.over) return;
    yield* this.step$("declareAttackers");
    st.combat = { attackers: [] };
    yield* this.declareAttackers$();
    if (this.over) return;
    if (!st.combat || !st.combat.attackers.length) { st.combat = null; this.emptyPools(); return; }
    yield* this.priorityRound$();
    this.emptyPools();
    if (this.over) return;
    yield* this.step$("declareBlockers");
    yield* this.declareBlockers$();
    if (this.over) return;
    yield* this.priorityRound$();
    this.emptyPools();
    if (this.over) return;
    yield* this.combatDamage$();
    if (this.over) return;
    yield* this.beginStep$("endCombat");
    this.expireEffects("endOfCombat");
    st.combat = null;
    this.markDirty();
  },

  attackCandidates(a) {
    const st = this.state;
    const defenders = [];
    for (const q of this.opponentsOf(a)) {
      defenders.push(pid(q));
      for (const id of st.battlefield) { const o = st.objects[id]; if (o.controller === q && o.c.types.includes("planeswalker")) defenders.push(o.id); }
    }
    const out = [];
    if (!defenders.length) return out;
    for (const id of st.battlefield) {
      const o = st.objects[id];
      if (o.controller !== a || !o.c.types.includes("creature") || o.tapped) continue;
      if (o.sick && !this.hasKw(o, "haste")) continue;
      if (this.hasKw(o, "defender") || o.c.cantAttack) continue;
      out.push({ obj: o.id, defenders: [...defenders] });
    }
    return out;
  },

  *declareAttackers$() {
    const st = this.state;
    const a = st.active;
    const cands = this.attackCandidates(a);
    if (!cands.length) return;
    const ans = yield { kind: "attackers", player: a, prompt: "Declare attackers", candidates: cands };
    let attacks = [...ans.attacks];
    for (const c of cands) {
      const o = st.objects[c.obj];
      if (o.c.mustAttack && !attacks.some((x) => x.obj === c.obj)) attacks.push({ obj: c.obj, defender: c.defenders[0] });
    }
    attacks = yield* this.attackTax$(a, attacks); // library m4: "can't attack you unless … pays"
    const list = [];
    for (const at of attacks) {
      const o = st.objects[at.obj];
      if (!o || o.zone !== "battlefield") continue;
      if (!this.hasKw(o, "vigilance")) { o.tapped = true; this.markDirty(); }
      st.combat.attackers.push({ obj: o.id, defender: at.defender, blockers: [], blocked: false });
      this.emit({ t: "attack", obj: o.id, defender: at.defender, text: `${o.c.name} attacks ${this.nameOf(at.defender)}` });
      list.push(o);
    }
    this.refresh();
    for (const o of list) {
      const e = st.combat.attackers.find((x) => x.obj === o.id);
      this.fireTrigger({ type: "attacks", obj: o, defender: e.defender, player: this.defenderPlayer(e.defender), alone: list.length === 1 });
    }
  },

  canBlock(b, a) {
    if (this.hasKw(a, "flying") && !this.hasKw(b, "flying") && !this.hasKw(b, "reach")) return false;
    if (this.hasKw(a, "shadow") && !this.hasKw(b, "shadow")) return false;
    for (const ex of a.c.unblockable || []) {
      if (ex == null) return false;
      if (!this.matches(b, ex, { source: a, you: a.controller })) return false;
    }
    if (this.protectedFrom(a, b)) return false;
    for (const t of ["plains", "island", "swamp", "mountain", "forest"]) // landwalk
      if (this.hasKw(a, t + "walk") && this.state.battlefield.some((id) => { const l = this.state.objects[id]; return l.controller === b.controller && l.c.types.includes("land") && l.c.subtypes.includes(t); })) return false;
    const art = b.c.types.includes("artifact");
    if (this.hasKw(a, "intimidate") && !art && !b.c.colors.some((c) => a.c.colors.includes(c))) return false;
    if (this.hasKw(a, "fear") && !art && !b.c.colors.includes("B")) return false;
    if (this.hasKw(a, "skulk") && (b.c.power | 0) > (a.c.power | 0)) return false;
    const pl = this.state.players[a.controller];
    if (pl && pl.ring.bearer === a.id && pl.ring.level >= 1 && (b.c.power | 0) > (a.c.power | 0)) return false;
    return true;
  },

  *declareBlockers$() {
    const st = this.state;
    const cb = st.combat;
    const defPlayers = this.apnap([...new Set(cb.attackers.map((e) => this.defenderPlayer(e.defender)).filter((x) => x != null))]);
    for (const dp of defPlayers) {
      if (this.over) return;
      const vs = cb.attackers.filter((e) => this.defenderPlayer(e.defender) === dp).map((e) => st.objects[e.obj]).filter(Boolean);
      const cands = [];
      for (const id of st.battlefield) {
        const b = st.objects[id];
        if (b.controller !== dp || !b.c.types.includes("creature") || b.tapped || b.c.cantBlock) continue;
        const canBlock = vs.filter((a) => this.canBlock(b, a)).map((a) => a.id);
        if (canBlock.length) cands.push({ obj: b.id, canBlock });
      }
      if (!cands.length) continue;
      const ans = yield { kind: "blockers", player: dp, prompt: "Declare blockers", attackers: vs.map((a) => a.id), candidates: cands };
      for (const bl of ans.blocks) {
        const e = cb.attackers.find((x) => x.obj === bl.attacker);
        const b = st.objects[bl.obj];
        if (!e || !b) continue;
        e.blockers.push(b.id);
        this.emit({ t: "block", obj: b.id, attacker: e.obj, text: `${b.c.name} blocks ${this.nameOf(e.obj)}` });
      }
    }
    for (const e of cb.attackers) {
      if (!e.blockers.length) continue;
      e.blocked = true;
      for (const bid of e.blockers) this.fireTrigger({ type: "blocks", obj: st.objects[bid], attacker: e.obj, player: st.objects[bid].controller });
      this.fireTrigger({ type: "becomesBlocked", obj: st.objects[e.obj], blockers: [...e.blockers], player: st.objects[e.obj].controller });
    }
  },

  *combatDamage$() {
    const st = this.state;
    const cb = st.combat;
    const all = [...cb.attackers.map((e) => e.obj), ...cb.attackers.flatMap((e) => e.blockers)].map((id) => st.objects[id]).filter(Boolean);
    const fsAny = all.some((o) => this.hasKw(o, "first strike") || this.hasKw(o, "double strike"));
    cb.dealtFirst = new Set();
    if (fsAny) {
      yield* this.step$("combatDamage");
      this.dealCombatDamage(true);
      yield* this.priorityRound$();
      this.emptyPools();
      if (this.over || !st.combat) return;
    }
    yield* this.step$("combatDamage");
    this.dealCombatDamage(false);
    yield* this.priorityRound$();
    this.emptyPools();
  },

  dealCombatDamage(first) {
    const st = this.state;
    const cb = st.combat;
    if (!cb) return;
    const fs = (o) => this.hasKw(o, "first strike") || this.hasKw(o, "double strike");
    const ds = (o) => this.hasKw(o, "double strike");
    const participates = (o) => {
      if (!o || o.zone !== "battlefield" || !o.c.types.includes("creature")) return false;
      if (first) return fs(o);
      return ds(o) || !cb.dealtFirst.has(o.id);
    };
    const assigns = [];
    for (const e of cb.attackers) {
      const a = st.objects[e.obj];
      if (!participates(a)) continue;
      if (first) cb.dealtFirst.add(a.id);
      let power = Math.max(0, a.c.power | 0);
      if (!power) continue;
      const trample = this.hasKw(a, "trample");
      if (e.blocked) {
        const bl = e.blockers.map((id) => st.objects[id]).filter((b) => b && b.zone === "battlefield");
        if (!bl.length) { if (trample) assigns.push([a, e.defender, power]); continue; }
        const dt = this.hasKw(a, "deathtouch");
        bl.sort((x, y) => (this.lethalThreshold(x) - x.damage) - (this.lethalThreshold(y) - y.damage));
        for (let i = 0; i < bl.length && power > 0; i++) {
          const b = bl[i];
          const lethal = dt ? 1 : Math.max(1, this.lethalThreshold(b) - b.damage);
          const last = i === bl.length - 1;
          const amt = last && !trample ? power : Math.min(lethal, power);
          assigns.push([a, b.id, amt]);
          power -= amt;
        }
        if (power > 0 && trample) assigns.push([a, e.defender, power]);
      } else assigns.push([a, e.defender, power]);
    }
    for (const e of cb.attackers) for (const bid of e.blockers) {
      const b = st.objects[bid];
      if (!participates(b)) continue;
      if (first) cb.dealtFirst.add(b.id);
      const a = st.objects[e.obj];
      const pw = Math.max(0, b.c.power | 0);
      if (pw && a && a.zone === "battlefield") assigns.push([b, a.id, pw]);
    }
    this.beginBatch();
    const batches = new Map();
    for (const [src, tgt, n] of assigns) {
      if (!isPid(tgt)) { const t = st.objects[tgt]; if (!t || t.zone !== "battlefield") continue; }
      const dealt = this.dealDamage(src, tgt, n, { combat: true });
      if (dealt > 0 && isPid(tgt)) { if (!batches.has(tgt)) batches.set(tgt, []); batches.get(tgt).push({ source: src, amount: dealt }); }
    }
    for (const [tgt, parts] of batches) this.fireTrigger({ type: "dealsCombatDamage", batch: true, parts, target: tgt, amount: parts.reduce((n, p) => n + p.amount, 0), player: +tgt.slice(1), combat: true });
    this.markDirty();
  },
};
