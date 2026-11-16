/* Input: taps, long-press, hand dragging, and the per-request interaction modes
   (priority, targeting/choose, declare attackers, declare blockers, dialogs). */

import { oid, esc } from "./ui-card.js";
import { STOP_KEYS, STEP_NAME, isMeaningful } from "./ui-shared.js";

export const inputMethods = {
  /* ---------- delegated clicks ---------- */
  onClick(e) {
    if (this._suppress && performance.now() < this._suppress) { e.preventDefault(); e.stopPropagation(); return; }
    const t = e.target;
    const a = t.closest("[data-act]");
    if (a && this.root.contains(a)) {
      const fn = this["act_" + a.dataset.act];
      if (fn) { this.sound.unlock(); fn.call(this, a, e); return; }
    }
    const c = t.closest("[data-cid]");
    if (c && this.root.contains(c)) {
      this.sound.unlock();
      this.skipFx = true;
      this.cardTap(c.dataset.cid.split(","), c);
    }
  },

  /* ---------- pointer: long-press to inspect, drag a hand card up to play ---------- */
  onPointerDown(e) {
    if (e.button && e.button !== 0) return;
    this.skipFx = true;
    const c = e.target.closest("[data-cid]");
    if (c && !e.target.closest(".mp-layer")) {
      const ids = c.dataset.cid.split(",");
      clearTimeout(this._lpT);
      this._lp = { x: e.clientX, y: e.clientY };
      this._lpT = setTimeout(() => {
        if (!this._lp) return;
        this._lp = null; this._suppress = performance.now() + 900;
        if (this._drag) { this._drag = null; }
        this.openZoom(ids);
      }, 520);
    }
    const hc = e.target.closest(".hc");
    if (hc) this._drag = { el: hc, x0: e.clientX, y0: e.clientY, started: false, id: hc.dataset.cid, pid: e.pointerId };
    if (!this._pm) {
      this._pm = (ev) => this.onPointerMove(ev);
      this._pu = (ev) => this.onPointerUp(ev);
      window.addEventListener("pointermove", this._pm, { passive: false });
      window.addEventListener("pointerup", this._pu);
      window.addEventListener("pointercancel", this._pu);
    }
  },
  onPointerMove(e) {
    if (this._lp && Math.hypot(e.clientX - this._lp.x, e.clientY - this._lp.y) > 9) { this._lp = null; clearTimeout(this._lpT); }
    const d = this._drag;
    if (!d) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.started) {
      if (-dy > 16 && -dy > Math.abs(dx) * 0.8) {
        d.started = true;
        this._lp = null; clearTimeout(this._lpT);
        d.el.classList.add("drag");
        this.root.classList.add("dragging");
        try { d.el.setPointerCapture(d.pid); } catch (err) { /* ignore */ }
      } else return;
    }
    e.preventDefault();
    d.el.style.translate = "calc(var(--x) + " + dx + "px) calc(var(--y) + " + dy + "px)";
    d.el.style.rotate = "0deg";
    const hand = this.el.hand.getBoundingClientRect();
    this.root.classList.toggle("dropready", e.clientY < hand.top - 20);
  },
  onPointerUp(e) {
    clearTimeout(this._lpT); this._lp = null;
    const d = this._drag;
    this._drag = null;
    if (!d) return;
    if (d.started) {
      const hand = this.el.hand.getBoundingClientRect();
      const drop = e.clientY < hand.top - 20;
      d.el.classList.remove("drag");
      d.el.style.translate = ""; d.el.style.rotate = "";
      this.root.classList.remove("dragging", "dropready");
      this._suppress = performance.now() + 400;
      if (drop && e.type !== "pointercancel") this.playFromHand([d.id]);
    }
  },
  playFromHand(ids) {
    const acts = this.actionsFor(ids).filter((x) => isMeaningful(x.a));
    if (acts.length === 1) { this.sound.play("click"); this.submit({ type: "act", index: acts[0].idx }); }
    else if (acts.length > 1) this.openZoom(ids);
    else { this.sound.play("error"); this.toast(this._wait && this.mode && this.mode.kind === "priority" ? "You can't play that right now." : "Wait for your priority.", { warn: true }); }
  },

  /* ---------- action lookup ---------- */
  actionsFor(ids) {
    const out = [], seen = new Set();
    if (!this._wait || !this.mode || this.mode.kind !== "priority" || !this.ctx) return out;
    ids.forEach((id) => (this.ctx.acts.get(id) || []).forEach((x) => {
      const k = x.a.type + "|" + x.a.label + "|" + (x.a.variant || "") + "|" + (x.a.ability == null ? "" : x.a.ability);
      if (!seen.has(k)) { seen.add(k); out.push(x); }
    }));
    return out;
  },

  /* ---------- tapping a card ---------- */
  cardTap(ids, el) {
    const m = this._wait ? this.mode : null, ctx = this.ctx || {};
    if (m) {
      if (m.kind === "choose" && m.board) {
        for (const id of ids) if (ctx.opt && ctx.opt.has(id)) { this.toggleOpt(ctx.opt.get(id), id); return; }
      } else if (m.kind === "attackers") {
        for (const id of ids) {
          if (ctx.defOpt && ctx.defOpt.has(id)) { m.curDef = id; this.render(); return; }
        }
        for (const id of ids) {
          if (ctx.cand && ctx.cand.has(id)) { this.toggleAttacker(ids); return; }
        }
      } else if (m.kind === "blockers") { if (this.blockTap(ids)) return; }
    }
    this.tapZoomOrQuick(ids);
  },
  tapZoomOrQuick(ids) {
    const now = performance.now(), key = ids[0];
    if (this._tap && this._tap.key === key && now - this._tap.t < 340) {
      clearTimeout(this._tap.timer); this._tap = null;
      const acts = this.actionsFor(ids).filter((x) => isMeaningful(x.a));
      if (acts.length === 1) { this.closeAllSheets(); this.sound.play("click"); this.submit({ type: "act", index: acts[0].idx }); return; }
      this.openZoom(ids);
      return;
    }
    if (this._tap) { clearTimeout(this._tap.timer); this._tap = null; }
    const canQuick = this.actionsFor(ids).filter((x) => isMeaningful(x.a)).length === 1;
    if (!canQuick) { this.openZoom(ids); return; }
    this._tap = { key, t: now, timer: setTimeout(() => { this._tap = null; this.openZoom(ids); }, 260) };
  },

  /* ---------- modes ---------- */
  onBoard(id) {
    if (/^P\d$/.test(id)) return true;
    const o = this.obj(id);
    if (!o) return false;
    if (o.zone === "battlefield" || o.zone === "stack") return true;
    if (o.zone === "hand" && o.owner === this.me) return true;
    if (o.zone === "command") return true;
    return false;
  },
  makeMode(req) {
    switch (req.kind) {
      case "priority": return { kind: "priority", req };
      case "choose": {
        const byId = new Map();
        let all = (req.options || []).length > 0;
        (req.options || []).forEach((op, i) => {
          const id = oid(op.id);
          if (id != null && (op.type === "object" || op.type === "player" || op.type == null) && this.onBoard(id)) byId.set(id, i); else all = false;
        });
        return { kind: "choose", req, sel: [], board: all && !req.listOnly, byId };
      }
      case "attackers": {
        const first = (req.candidates || []).length ? oid(req.candidates[0].defenders[0]) : null;
        const defs = this.defenderList(req);
        const pl = defs.find((d) => /^P\d$/.test(d)) || first;
        return { kind: "attackers", req, sel: new Map(), curDef: pl };
      }
      case "blockers": return { kind: "blockers", req, assign: new Map(), pick: null };
      default: return { kind: req.kind, req };
    }
  },
  enterMode() {
    const m = this.mode;
    if (!m) return;
    const req = m.req;
    this.closeDialogSheets();
    this.render();
    if (m.kind === "choose" && !m.board) this.openPicker(req);
    else if (m.kind === "confirm") this.openConfirm(req);
    else if (m.kind === "number") this.openNumber(req);
    else if (m.kind === "mulligan") this.openMulligan(req);
    else if (!["priority", "choose", "attackers", "blockers"].includes(m.kind)) {
      this.toast("Unsupported request: " + m.kind, { warn: true });
      this.submit(this.fallbackAnswer(req));
    }
    this.focusHint();
  },
  focusHint() {
    if (this.sheets.length) return;
    if (window.matchMedia && window.matchMedia('(pointer:fine)').matches) this.el.go.focus({ preventScroll: true });
  },

  /* choose: tap to toggle, min/max enforced */
  toggleOpt(idx, id) {
    const m = this.mode, req = m.req;
    const at = m.sel.indexOf(idx);
    if (at >= 0) {
      if (req.max === 1 && req.min === 1) { this.goAction(); return; }
      m.sel.splice(at, 1);
    } else {
      if (m.sel.length >= req.max) {
        if (req.max === 1) m.sel = [idx];
        else { this.toast("You can choose at most " + req.max + ".", { warn: true }); this.sound.play("error"); return; }
      } else m.sel.push(idx);
    }
    this.sound.play("click");
    this.render();
  },
  togglePickerIdx(idx) { // used by the picker sheet
    const m = this.mode, req = m.req;
    const at = m.sel.indexOf(idx);
    if (at >= 0) m.sel.splice(at, 1);
    else if (m.sel.length >= req.max) { if (req.max === 1) m.sel = [idx]; else { this.toast("You can choose at most " + req.max + ".", { warn: true }); return false; } }
    else m.sel.push(idx);
    return true;
  },

  /* attackers */
  toggleAttacker(ids) {
    const m = this.mode;
    if (m.sel.has(ids[0])) m.sel.delete(ids[ids.length - 1]);
    else {
      const id = ids.find((x) => !m.sel.has(x));
      if (id == null) return;
      m.sel.set(id, m.curDef);
    }
    this.sound.play("click");
    this.render();
  },
  act_attackAll() {
    const m = this.mode;
    if (!m || m.kind !== "attackers") return;
    const all = (m.req.candidates || []);
    const allOn = all.every((cd) => m.sel.has(oid(cd.obj)));
    if (allOn) m.sel.clear();
    else all.forEach((cd) => { const id = oid(cd.obj); if (!m.sel.has(id)) { const d = (cd.defenders || []).map(oid); m.sel.set(id, d.indexOf(m.curDef) >= 0 ? m.curDef : d[0]); } });
    this.sound.play("click");
    this.render();
  },

  /* blockers: tap a blocker, then the attacker it blocks */
  blockTap(ids) {
    const m = this.mode, ctx = this.ctx, req = m.req;
    const bid = ids.find((id) => ctx.blkCand.has(id));
    if (bid) {
      if (m.assign.has(bid) || (ids.length > 1 && ids.some((i) => m.assign.has(i)))) { const rm = ids.slice().reverse().find((i) => m.assign.has(i)); m.assign.delete(rm); m.pick = null; }
      else m.pick = m.pick === bid ? null : bid;
      this.sound.play("click");
      this.render();
      return true;
    }
    const aid = ids.find((id) => ctx.atkTargets.has(id));
    if (aid) {
      if (!m.pick) { this.toast("Tap one of your creatures first, then the attacker it should block.", { ms: 2600 }); return false; }
      const cd = ctx.blkCand.get(m.pick);
      if (cd && (cd.canBlock || []).map(oid).indexOf(aid) < 0) { this.sound.play("error"); this.toast("That creature can't block " + this.obj(aid).c.name + ".", { warn: true }); return true; }
      m.assign.set(m.pick, aid);
      m.pick = null;
      this.sound.play("click");
      this.render();
      return true;
    }
    return false;
  },

  /* ---------- the big button ---------- */
  goAction() {
    const m = this.mode;
    if (!this._wait || !m) return;
    const req = m.req;
    switch (m.kind) {
      case "priority": this.sound.play("click"); this.submit({ type: "pass" }); break;
      case "choose":
        if (m.sel.length < req.min) { this.toast("Choose " + req.min + (req.min === 1 ? " option." : " options."), { warn: true }); return; }
        this.sound.play("click");
        this.submit({ chosen: m.sel.slice() });
        break;
      case "attackers": {
        const attacks = [];
        m.sel.forEach((def, id) => {
          const cd = (req.candidates || []).find((c) => oid(c.obj) === id);
          if (!cd) return;
          const d = (cd.defenders || []).find((x) => oid(x) === def) || cd.defenders[0];
          attacks.push({ obj: cd.obj, defender: d });
        });
        this.sound.play("attack");
        this.submit({ attacks });
        break;
      }
      case "blockers": {
        const blocks = [];
        m.assign.forEach((att, blk) => {
          const cd = (req.candidates || []).find((c) => oid(c.obj) === blk);
          const ao = (req.attackers || []).find((a) => oid(a) === att);
          if (cd && ao != null) blocks.push({ obj: cd.obj, attacker: ao });
        });
        this.sound.play("click");
        this.submit({ blocks });
        break;
      }
      default: break;
    }
  },
  act_go() { this.goAction(); },
  act_passTurn() {
    if (!this._wait || !this.mode || this.mode.kind !== "priority") return;
    this.skipTurn = true;
    this.toast("Passing until something happens…", { ms: 1400 });
    this.goAction();
  },

  /* ---------- little buttons ---------- */
  act_menu() { this.openPause(); },
  act_log() { this.openLog(); },
  act_undo() { this.undo(); },
  act_emote() { this.openEmote(); },
  act_tools() { this.openTools(); },
  act_listOpts() { if (this.mode && this.mode.kind === "choose") this.openPicker(this.mode.req); },
  act_stop(el) {
    const ph = el.dataset.ph, keys = STOP_KEYS[ph];
    if (!keys) { this.toast("Nothing to stop at in the untap step."); return; }
    const side = this.disp.active === this.me ? "my" : "opp";
    const stops = this.settings.stops[side];
    const on = !keys.some((k) => stops[k]);
    keys.forEach((k) => { stops[k] = on; });
    this.saveSettings();
    this.renderPhases();
    this.toast((on ? "Stop added: " : "Stop removed: ") + el.textContent + (side === "my" ? " on your turn" : " on their turn"), { ms: 1800 });
  },
  saveSettings() { if (this.o.saveSettings) this.o.saveSettings(this.settings); else saveSettingsFallback(this.settings); },
  act_avatar(el) {
    const p = +el.dataset.p, id = "P" + p;
    const m = this._wait ? this.mode : null, ctx = this.ctx || {};
    if (m && m.kind === "choose" && m.board && ctx.opt.has(id)) { this.toggleOpt(ctx.opt.get(id), id); return; }
    if (m && m.kind === "attackers" && ctx.defOpt.has(id)) { m.curDef = id; this.render(); return; }
    this.openPlayer(p);
  },
  act_zone(el) {
    const p = +el.dataset.p, z = el.dataset.z;
    if (z === "library") { this.toast((p === this.me ? "Your" : "Opponent’s") + " library: " + this.player(p).library.length + " cards"); return; }
    this.openZone(p, z);
  },
};

import { saveSettings as saveSettingsFallback } from "./ui-store.js";
