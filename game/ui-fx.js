/* Event playback: animations, floaters, banner, toasts, log, emotes. */

import { esc, oid, viewOfObj, fillCard, makeCard, setLive } from "./ui-card.js";
import { IC } from "./ui-shared.js";

const EMOTES = ["Hello!", "Nice!", "Thinking…", "Good game"];
export { EMOTES };

export const fxMethods = {
  clearFxLayer() { this.el.fx.textContent = ""; this.el.toasts.textContent = ""; },

  /* ---------- geometry helpers ---------- */
  relRect(r) {
    const b = this.root.getBoundingClientRect();
    return { left: r.left - b.left, top: r.top - b.top, width: r.width, height: r.height };
  },
  zoneRect(p, z) {
    const s = this["s" + p];
    const sm = (el, w, h) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left + r.width / 2 - w / 2, top: r.top + r.height / 2 - h / 2, width: w, height: h }; };
    switch (z) {
      case "library": return sm(s.libB, 30, 42);
      case "graveyard": return sm(s.gyB, 30, 42);
      case "exile": return sm(s.exB, 30, 42);
      case "command": return sm(s.cmdz, 30, 42);
      case "hand": return p === this.me ? sm(this.el.hand, 50, 70) : sm(s.ohand || s.strip, 30, 42);
      case "stack": return sm(this.el.stackbox.hidden ? this.el.go : this.el.stackbox, 50, 70);
      default: return sm(s.bf, 50, 70);
    }
  },
  originRect(og) { return og ? this.zoneRect(og.player, og.zone) : null; },

  /* A detached copy flying from one rect to another (or fading in place). */
  ghost(el, from, to, mode) {
    if (this.rm || !from) return;
    const c = el.cloneNode(true);
    const r = this.relRect(from);
    c.classList.add("ghost");
    c.removeAttribute("id");
    c.style.cssText = "position:absolute;left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px;margin:0;translate:none;rotate:none;transform:none;--cw:" + r.width + "px;--lw:" + r.width + "px;--hw:" + r.width + "px;pointer-events:none;z-index:80";
    this.el.fx.appendChild(c);
    const dur = 520 * this.spd();
    let kf;
    if (to && mode !== "poof" && mode !== "hand") {
      const t = this.relRect(to);
      const dx = t.left + t.width / 2 - (r.left + r.width / 2), dy = t.top + t.height / 2 - (r.top + r.height / 2);
      const sc = Math.max(0.18, t.width / r.width);
      kf = [
        { transform: "translate(0,0) scale(1)", opacity: 1, filter: "none" },
        { transform: "translate(0,0) scale(1.06) rotate(-3deg)", opacity: 1, filter: "grayscale(.6) brightness(.85)", offset: 0.22 },
        { transform: "translate(" + dx + "px," + dy + "px) scale(" + sc + ")", opacity: 0.1, filter: "grayscale(1) brightness(.6)" },
      ];
    } else {
      kf = [
        { transform: "scale(1)", opacity: 1, filter: "none" },
        { transform: "scale(1.12)", opacity: 0.8, filter: "brightness(1.6) saturate(.4)", offset: 0.3 },
        { transform: "scale(.7)", opacity: 0, filter: "blur(3px) grayscale(1)" },
      ];
    }
    const a = c.animate(kf, { duration: Math.max(60, dur), easing: "cubic-bezier(.4,.1,.3,1)", fill: "forwards" });
    const done = () => c.remove();
    a.onfinish = done; a.oncancel = done;
    setTimeout(done, Math.max(400, dur) + 400);
  },

  flip(el, from) {
    if (this.rm || !from || !el.animate) return;
    const to = el.getBoundingClientRect();
    if (!to.width || !from.width) return;
    const dx = from.left - to.left, dy = from.top - to.top, sx = from.width / to.width;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2 && Math.abs(sx - 1) < 0.04) return;
    el.classList.add("flying");
    const a = el.animate([{ transform: "translate(" + dx + "px," + dy + "px) scale(" + sx + ")", transformOrigin: "0 0" }, { transform: "none", transformOrigin: "0 0" }],
      { duration: Math.max(80, 340 * this.spd()), easing: "cubic-bezier(.2,.8,.2,1)" });
    const done = () => el.classList.remove("flying");
    a.onfinish = done; a.oncancel = done;
  },
  pop(el) {
    if (this.rm || !el.animate) return;
    el.animate([{ transform: "scale(.5)", opacity: 0, filter: "brightness(2)" }, { transform: "scale(1.08)", opacity: 1, filter: "brightness(1.4)", offset: 0.6 }, { transform: "scale(1)", opacity: 1, filter: "none" }],
      { duration: Math.max(80, 380 * this.spd()), easing: "cubic-bezier(.2,.9,.3,1.2)" });
  },

  playArrivals() {
    if (this.rm || this.closed) return;
    const batch = this.batch;
    const known = (ids) => { for (const id of ids) { const r = this.rects.get(id); if (r) return r; } return null; };
    this.tiles.forEach((el) => {
      const ids = el._ids || [];
      let from = known(ids);
      if (!from && el._new && batch) { for (const id of ids) { const og = batch.origin.get(id); if (og) { from = this.originRect(og); break; } } }
      if (from) this.flip(el, from);
      else if (el._new && batch) this.pop(el);
    });
    this.handEls.forEach((el, id) => {
      if (!el._new) return;
      let from = this.rects.get(id);
      if (!from && batch) from = this.originRect(batch.origin.get(id));
      if (from) this.flip(el._card, from); else if (batch) this.pop(el._card);
    });
    this.stackEls.forEach((el, id) => {
      if (!el._new) return;
      const o = this.obj(id);
      let from = this.rects.get(id) || (o && o.sourceId && this.rects.get(oid(o.sourceId)));
      if (!from && batch && o) from = this.originRect(batch.origin.get(id)) || (o.controller === this.opp ? this.zoneRect(this.opp, "hand") : null);
      if (from) this.flip(el, from); else if (batch) this.pop(el);
    });
    this.cmdEls.forEach((el, id) => { if (el._new && batch) { const og = batch.origin.get(id); const from = this.rects.get(id) || (og && this.originRect(og)); if (from) this.flip(el, from); } });
  },

  /* ---------- floaters ---------- */
  centerOf(target) {
    const el = typeof target === "string" || (target && target.id !== undefined && !target.nodeType) ? this.anchor(target) : target;
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    const b = this.root.getBoundingClientRect();
    if (!r.width) return null;
    return { x: r.left + r.width / 2 - b.left, y: r.top + r.height * 0.35 - b.top };
  },
  floatText(target, text, cls) {
    if (this.rm) return;
    const c = this.centerOf(target);
    if (!c) return;
    const f = document.createElement("div");
    f.className = "flt " + (cls || "");
    f.textContent = text;
    f.style.left = c.x + "px"; f.style.top = c.y + "px";
    this.el.fx.appendChild(f);
    const a = f.animate([{ transform: "translate(-50%,0) scale(.6)", opacity: 0 }, { transform: "translate(-50%,-14px) scale(1.15)", opacity: 1, offset: 0.2 }, { transform: "translate(-50%,-46px) scale(1)", opacity: 0 }],
      { duration: Math.max(200, 1100 * this.spd()), easing: "ease-out" });
    a.onfinish = () => f.remove();
    setTimeout(() => f.remove(), 2200);
  },
  shake(target) {
    if (this.rm) return;
    const el = typeof target === "string" ? this.anchor(target) : target;
    if (!el || !el.animate) return;
    el.animate([{ transform: "translateX(0)" }, { transform: "translateX(-4px)" }, { transform: "translateX(4px)" }, { transform: "translateX(-3px)" }, { transform: "translateX(0)" }], { duration: 300 });
    el.classList.add("hit");
    setTimeout(() => el.classList.remove("hit"), 420);
  },

  banner(text, cls) {
    const b = this.el.banner;
    if (this.rm) { return Promise.resolve(); }
    b.hidden = false;
    b.className = "banner " + (cls || "");
    b.innerHTML = "<span>" + esc(text) + "</span>";
    b.getAnimations && b.getAnimations().forEach((a) => a.cancel());
    const a = b.animate([{ opacity: 0, transform: "translate(-50%,-50%) scale(.9)" }, { opacity: 1, transform: "translate(-50%,-50%) scale(1)", offset: 0.15 }, { opacity: 1, transform: "translate(-50%,-50%) scale(1)", offset: 0.75 }, { opacity: 0, transform: "translate(-50%,-50%) scale(1.04)" }],
      { duration: Math.max(200, 1100 * this.spd()) });
    a.onfinish = () => { b.hidden = true; };
    return this.sleep(750);
  },

  toast(text, o) {
    o = o || {};
    const t = document.createElement("div");
    t.className = "toast" + (o.warn ? " warn" : "");
    const s = document.createElement("span");
    s.textContent = text;
    t.appendChild(s);
    if (o.action) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "ta"; b.textContent = o.action.label;
      b.addEventListener("click", () => { t.remove(); o.action.fn(); });
      t.appendChild(b);
    }
    this.el.toasts.appendChild(t);
    while (this.el.toasts.children.length > 3) this.el.toasts.firstChild.remove();
    setTimeout(() => t.remove(), o.ms || (o.action ? 6500 : 3200));
  },

  /* ---------- log ---------- */
  logPush(e) {
    if (!e.text) return;
    const line = { text: e.text, t: e.t, turn: this.disp.turn, p: e.player };
    this.logLines.push(line);
    if (this.logLines.length > 700) this.logLines.shift();
    this.logAppend(this.el.logBody, line);
    if (this._logSheet) this.logAppend(this._logSheet, line);
  },
  logAppend(box, line) {
    if (!box) return;
    const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    const d = document.createElement("div");
    d.className = "ll ll-" + line.t + (line.p === this.me ? " me" : line.p === this.opp ? " opp" : "");
    d.textContent = line.text;
    box.appendChild(d);
    while (box.children.length > 400) box.firstChild.remove();
    if (atEnd) box.scrollTop = box.scrollHeight;
  },

  /* ---------- emotes ---------- */
  emote(p, text) {
    const s = this["s" + p];
    if (!s) return;
    const old = s.strip.querySelector(".emo");
    if (old) old.remove();
    const b = document.createElement("div");
    b.className = "emo " + (p === this.me ? "me" : "opp");
    b.textContent = text;
    s.strip.appendChild(b);
    this.sound.play("emote");
    setTimeout(() => b.remove(), 2400);
  },
  emoteAI(text) {
    if (this._aiEmoteAt && Date.now() - this._aiEmoteAt < 20000) return;
    this._aiEmoteAt = Date.now();
    setTimeout(() => { if (!this.closed) this.emote(this.opp, text); }, 500 + Math.random() * 600);
  },

  /* ---------- playback ---------- */
  async playEvents(evs) {
    const ep = this.epoch;
    this.skipFx = false;
    this._budget = evs.length > 36 ? 0.45 : 1;
    this._atkSound = false;
    for (const e of evs) {
      if (ep !== this.epoch || this.closed) return;
      if (e.text) this.logPush(e);
      await this.playEvent(e, ep);
    }
    this.syncDisp();
    this.renderPhases();
    this.renderStrips();
  },
  nap(ms) { return this.sleep(ms * (this._budget || 1)); },

  async playEvent(e) {
    const me = this.me;
    const S = this.S;
    switch (e.t) {
      case "turn": {
        this.disp.active = e.player; this.disp.turn = e.n;
        this.skipTurn = false; this.seenStack.clear();
        this.renderPhases(); this.renderStrips();
        if (e.n >= 1) {
          this.sound.play("turn");
          await this.banner(e.player === me ? "Your turn" : "Opponent’s turn", e.player === me ? "mine" : "theirs");
        }
        return;
      }
      case "step": { this.disp.step = e.step; this.renderPhases(); await this.nap(this.disp.active === me ? 30 : 60); return; }
      case "draw": {
        this.tally.drawn += e.player === me ? 1 : 0;
        this.sound.play("draw");
        if (e.player !== me && !this.rm) this.flyBack(this.zoneRect(e.player, "library"), this.zoneRect(e.player, "hand"));
        await this.nap(150);
        return;
      }
      case "cast": {
        if (e.player === me) this.tally.spells++;
        this.sound.play("cast");
        const o = this.obj(e.obj);
        const el = o && this.stackEls.get(o.id);
        if (el) el.classList.add("pulse");
        setTimeout(() => el && el.classList.remove("pulse"), 900);
        if (e.player === this.opp && o && o.c.cmc >= 6) this.emoteAI("Thinking…");
        if (e.player === me && o && (o.isCommander || o.c.cmc >= 7)) this.emoteAI("Nice!");
        this.drawArrows();
        await this.nap(420);
        return;
      }
      case "ability": { this.sound.play("cast"); this.drawArrows(); await this.nap(280); return; }
      case "resolve": { this.sound.play("resolve"); await this.nap(160); return; }
      case "countered": { this.sound.play("die"); await this.nap(260); return; }
      case "move": {
        const id = oid(e.obj), o = S.objects[id];
        if (e.to === "battlefield" && o) { this.sound.play(o.c.types.indexOf("land") >= 0 ? "land" : "play"); await this.nap(130); }
        else if (e.to === "graveyard" && e.from === "hand" && e.player !== undefined) await this.nap(60);
        return;
      }
      case "dies": {
        const o = this.obj(e.obj);
        if (o && o.controller === me) this.tally.myDeaths++; else this.tally.oppDeaths++;
        this.sound.play("die");
        await this.nap(240);
        return;
      }
      case "damage": {
        const t = oid(e.target);
        const amt = e.amount || 0;
        if (amt > 0) {
          const el = this.anchor(t);
          this.floatText(el, "−" + amt, "dmg");
          this.shake(el);
          this.sound.play("damage");
          const tp = typeof t === "string" && /^P\d$/.test(t) ? +t.slice(1) : -1;
          if (tp === me) { this.tally.dmgTaken += amt; this.sound.buzz(Math.min(120, 20 + amt * 8)); }
          else if (tp === this.opp) this.tally.dmgDealt += amt;
          await this.nap(190);
        }
        return;
      }
      case "life": {
        this.disp.life[e.player] = e.life;
        const s = this["s" + e.player];
        this.renderStrips();
        if (!this.rm) { s.lifeBox.classList.remove("bump"); void s.lifeBox.offsetWidth; s.lifeBox.classList.add("bump"); }
        if (e.delta) {
          this.floatText(s.lifeBox, (e.delta > 0 ? "+" : "−") + Math.abs(e.delta), e.delta > 0 ? "gain" : "loss");
          this.sound.play(e.delta > 0 ? "lifegain" : "lifeloss");
          if (e.player === me && e.delta <= -8) this.emoteAI("Nice!");
        }
        await this.nap(170);
        return;
      }
      case "attack": {
        const el = this.anchor(e.obj);
        if (el && el.animate && !this.rm) el.animate([{ scale: "1" }, { scale: "1.14" }, { scale: "1" }], { duration: 380, easing: "ease-out" });
        if (!this._atkSound) { this._atkSound = true; this.sound.play("attack"); }
        await this.nap(130);
        return;
      }
      case "block": { await this.nap(110); return; }
      case "token": { this.sound.play("play"); await this.nap(160); return; }
      case "counters": {
        const el = this.anchor(e.obj);
        if (el && e.delta) this.floatText(el, (e.delta > 0 ? "+" : "−") + Math.abs(e.delta) + " " + (e.kind || ""), e.delta > 0 ? "gain" : "loss");
        await this.nap(120);
        return;
      }
      case "tap": case "untap": return;
      case "manual": {
        this.toast(e.text || "Resolve this effect by hand.", { action: { label: "Manual tools", fn: () => this.openTools() }, ms: 8000 });
        await this.nap(300);
        return;
      }
      case "reveal": { this.showReveal(e); await this.nap(1100); return; }
      case "ring": { if (e.player === me) this.toast("The Ring tempts you (level " + e.level + ")"); await this.nap(200); return; }
      case "win": case "lose": { this.lastEnd = e.t === "win" || !this.lastEnd ? e : this.lastEnd; return; }
      default: return;
    }
  },

  flyBack(from, to) {
    if (this.rm || !from || !to) return;
    const f = this.relRect(from), t = this.relRect(to);
    const c = document.createElement("div");
    c.className = "ghost back";
    c.style.cssText = "position:absolute;left:" + f.left + "px;top:" + f.top + "px;width:30px;height:42px;z-index:70";
    this.el.fx.appendChild(c);
    const a = c.animate([{ transform: "translate(0,0) scale(1)", opacity: 1 }, { transform: "translate(" + (t.left + t.width / 2 - f.left - 15) + "px," + (t.top + t.height / 2 - f.top - 21) + "px) scale(.8)", opacity: 0.2 }],
      { duration: Math.max(80, 420 * this.spd()), easing: "ease-in-out" });
    a.onfinish = () => c.remove();
    setTimeout(() => c.remove(), 1500);
  },

  showReveal(e) {
    const ids = (e.objs || []).map(oid).filter((id) => this.obj(id));
    if (!ids.length) return;
    const box = document.createElement("div");
    box.className = "reveal";
    box.innerHTML = '<div class="rv-t">' + esc(e.text || "Revealed") + '</div><div class="rv-c"></div>';
    const row = box.querySelector(".rv-c");
    ids.slice(0, 8).forEach((id) => { const c = makeCard(); fillCard(c, viewOfObj(this.obj(id)), "small"); row.appendChild(c); });
    this.el.fx.appendChild(box);
    setTimeout(() => box.remove(), Math.max(900, 2200 * this.spd()));
  },
};
