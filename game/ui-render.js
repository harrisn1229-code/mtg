/* Match rendering: diff the board by object id, size the rows, draw arrows. */

import { esc, oid, cap, manaHtml, makeCard, fillCard, setLive, viewOfObj, artCrop, imgSize, typeLineOf, frameFor, pip } from "./ui-card.js";
import { IC, PHASES, STEP_NEXT, STEP_NAME, STOP_KEYS, SVGNS, isMeaningful, clamp } from "./ui-shared.js";

const has = (o, t) => (o.c.types || []).indexOf(t) >= 0;
const isLandOnly = (o) => has(o, "land") && !has(o, "creature");

export const renderMethods = {
  syncDisp() {
    const S = this.S;
    this.disp.life = S.players.map((p) => p.life);
    this.disp.step = S.step;
    this.disp.active = S.active;
    this.disp.turn = S.turn;
  },

  snapshotRects() {
    const m = new Map();
    this.tiles.forEach((el) => { const r = el.getBoundingClientRect(); if (r.width) (el._ids || []).forEach((id) => m.set(id, r)); });
    this.handEls.forEach((el, id) => { const r = el.getBoundingClientRect(); if (r.width) m.set(id, r); });
    this.stackEls.forEach((el, id) => { const r = el.getBoundingClientRect(); if (r.width) m.set(id, r); });
    this.cmdEls.forEach((el, id) => { const r = el.getBoundingClientRect(); if (r.width) m.set(id, r); });
    this.rects = m;
  },

  beginBatch(evs) {
    const origin = new Map(), dest = new Map();
    const S = this.S;
    evs.forEach((e) => {
      if (e.t === "draw" && e.obj) origin.set(oid(e.obj), { zone: "library", player: e.player });
      else if (e.t === "move" && e.obj) {
        const id = oid(e.obj);
        if (!origin.has(id)) origin.set(id, { zone: e.from, player: S.objects[id] ? S.objects[id].owner : e.player });
        dest.set(id, e.to);
      } else if (e.t === "cast" && e.obj && !origin.has(oid(e.obj))) {
        const o = S.objects[oid(e.obj)];
        if (o) origin.set(o.id, { zone: o.owner === this.opp ? "hand" : "hand", player: e.player != null ? e.player : o.owner });
      }
    });
    this.batch = { evs, origin, dest };
  },
  endBatch() {
    this.batch = null;
    this.syncDisp();
    this.render();
  },

  /* ---------- context from the current mode ---------- */
  modeCtx() {
    const m = this.mode, S = this.S;
    const c = { acts: new Map(), glow: new Set(), opt: new Map(), selIds: new Set(), order: new Map(), cand: new Map(), blkCand: new Map(), defOpt: new Set(), atkSel: new Map(), assign: new Map(), pickBlk: null, atkTargets: new Set() };
    if (!m || !this._wait) return c;
    const req = m.req;
    if (m.kind === "priority") {
      (req.actions || []).forEach((a, idx) => {
        if (a.type === "special" || a.obj == null) return;
        const id = oid(a.obj);
        if (!c.acts.has(id)) c.acts.set(id, []);
        c.acts.get(id).push({ idx, a });
        if (isMeaningful(a)) c.glow.add(id);
      });
    } else if (m.kind === "choose" && m.board) {
      m.byId.forEach((idx, id) => c.opt.set(id, idx));
      m.sel.forEach((idx, n) => { const id = oid(req.options[idx].id); c.selIds.add(id); if (req.ordered) c.order.set(id, n + 1); });
    } else if (m.kind === "attackers") {
      (req.candidates || []).forEach((cd) => c.cand.set(oid(cd.obj), cd));
      m.sel.forEach((def, id) => c.atkSel.set(id, def));
      const defs = new Set();
      (req.candidates || []).forEach((cd) => (cd.defenders || []).forEach((d) => defs.add(oid(d))));
      if (defs.size > 1) defs.forEach((d) => c.defOpt.add(d));
    } else if (m.kind === "blockers") {
      (req.candidates || []).forEach((cd) => c.blkCand.set(oid(cd.obj), cd));
      m.assign.forEach((att, blk) => c.assign.set(blk, att));
      c.pickBlk = m.pick;
      (req.attackers || []).forEach((a) => c.atkTargets.add(oid(a)));
    }
    return c;
  },

  /* ---------- the main render ---------- */
  render(first) {
    if (this.closed || !this.g) return;
    if (!first) this.snapshotRects();
    const S = this.S;
    this.ctx = this.modeCtx();
    this.renderStrips();
    // attachments first, across both battlefields
    const hostMap = new Map();
    S.battlefield.forEach((id) => {
      const o = S.objects[id];
      if (o && o.attachedTo && S.objects[oid(o.attachedTo)] && S.objects[oid(o.attachedTo)].zone === "battlefield") {
        const h = oid(o.attachedTo);
        if (!hostMap.has(h)) hostMap.set(h, []);
        hostMap.get(h).push(o);
      }
    });
    this.hostMap = hostMap;
    const seen = new Set();
    this.renderBF(this.opp, seen);
    this.renderBF(this.me, seen);
    this.removeStale(seen);
    this.renderHand();
    this.renderStack();
    this.renderPhases();
    this.renderBar();
    this.renderPrompt();
    this.layout();
    if (!first) this.playArrivals();
    this._newBatch = false;
    this.buildArrows();
    this.drawArrows();
    this.tiles.forEach((el) => { el._new = false; });
    this.handEls.forEach((el) => { el._new = false; });
    this.stackEls.forEach((el) => { el._new = false; });
  },

  /* ---------- strips ---------- */
  renderStrips() {
    const S = this.S;
    [this.me, this.opp].forEach((p) => {
      const P = S.players[p], s = this["s" + p];
      const info = p === this.me ? this.setup.you : this.setup.opp;
      const name = (info && info.name) || P.name;
      if (s._name !== name) { s._name = name; s.nm.textContent = name; s.ini.textContent = (name || "?").trim().charAt(0).toUpperCase(); s.avB.setAttribute("aria-label", name + " status"); }
      if (!s._art) {
        const cmd = P.commanders.length ? S.objects[oid(P.commanders[0])] : null;
        const art = (cmd && cmd.c.img) || (info && info.art) || "";
        if (art) { s._art = art; s.av.style.backgroundImage = 'url("' + artCrop(art) + '")'; }
      }
      const life = this.disp.life[p];
      if (s._life !== life) { s._life = life; s.life.textContent = life; }
      s.lifeBox.classList.toggle("low", life <= 10 && life > 0);
      s.lifeBox.classList.toggle("dead", life <= 0);
      s.strip.classList.toggle("active", this.disp.active === p);
      s.strip.classList.toggle("prio", S.priority === p);
      const set = (el, key, v) => { if (s[key] !== v) { s[key] = v; el.textContent = v; } };
      set(s.lib, "_lib", P.library.length); set(s.gy, "_gy", P.graveyard.length); set(s.ex, "_ex", P.exile.length);
      s.libB.setAttribute("aria-label", "Library, " + P.library.length + " cards");
      s.gyB.setAttribute("aria-label", "Graveyard, " + P.graveyard.length + " cards");
      s.exB.setAttribute("aria-label", "Exile, " + P.exile.length + " cards");
      // mana pool
      const pool = Object.keys(P.mana || {}).filter((k) => P.mana[k] > 0).map((k) => pip(k) + (P.mana[k] > 1 ? '<b class="pn">' + P.mana[k] + "</b>" : "")).join("");
      if (s._pool !== pool) { s._pool = pool; s.pool.innerHTML = pool; s.pool.hidden = !pool; }
      // tags: poison, commander damage, ring
      const tags = [];
      if (P.poison) tags.push('<span class="tg pois" title="Poison counters">☠ ' + P.poison + "</span>");
      const cd = P.commanderDamage || {};
      Object.keys(cd).forEach((k) => { if (cd[k] > 0) tags.push('<span class="tg cdm" title="Commander damage taken">⚔ ' + cd[k] + "/21</span>"); });
      if (P.ring && P.ring.level) tags.push('<span class="tg ring" title="The Ring tempts you, level ' + P.ring.level + '">Ring ' + P.ring.level + "</span>");
      const th = tags.join("");
      if (s._tags !== th) { s._tags = th; s.nm.innerHTML = esc(name) + th; }
      // opponent hand backs
      if (s.ohand) {
        const n = P.hand.length;
        if (s._hn !== n) {
          s._hn = n;
          const show = Math.min(n, 9);
          s.ohand.innerHTML = '<span class="hbs">' + '<i class="hb"></i>'.repeat(show) + "</span>" + '<b class="hn num">' + n + "</b>";
          s.ohand.setAttribute("aria-label", "Opponent hand, " + n + " cards");
        }
      }
      // command zone
      this.renderCmd(p, P);
    });
  },
  renderCmd(p, P) {
    const s = this["s" + p], S = this.S;
    const ids = P.commanders.map(oid).filter((id) => S.objects[id] && S.objects[id].zone === "command");
    const keep = new Set(ids);
    this.cmdEls.forEach((el, id) => { if (el._p === p && !keep.has(id)) { el.remove(); this.cmdEls.delete(id); } });
    ids.forEach((id) => {
      const o = S.objects[id];
      let el = this.cmdEls.get(id);
      if (!el) {
        el = document.createElement("div");
        el.className = "cz"; el.setAttribute("role", "button"); el.tabIndex = 0; el._p = p;
        el._card = makeCard(); el.appendChild(el._card);
        el.insertAdjacentHTML("beforeend", '<span class="tax"></span>');
        el._tax = el.lastChild;
        this.cmdEls.set(id, el); s.cmdz.appendChild(el);
        el._new = true;
      }
      fillCard(el._card, viewOfObj(o), "small");
      const tax = (P.commanderCasts && P.commanderCasts[id] || 0) * 2;
      el._tax.textContent = tax ? "+" + tax : "";
      el._tax.hidden = !tax;
      el.dataset.cid = id;
      el.setAttribute("aria-label", o.c.name + " in the command zone" + (tax ? ", tax " + tax : ""));
      el.classList.toggle("glow", this.ctx.glow.has(id));
      el.classList.toggle("opt", this.ctx.opt.has(id));
      el.classList.toggle("sel", this.ctx.selIds.has(id));
    });
  },

  /* ---------- battlefield ---------- */
  groupKey(o, ctx) {
    const att = this.hostMap.get(o.id);
    if (att && att.length) return null;
    if (o.isCommander) return null;
    const landish = isLandOnly(o);
    if (!(landish || o.token)) return null;
    if (o.token && has(o, "planeswalker")) return null;
    const S = this.S;
    const cb = S.combat && S.combat.attackers ? S.combat.attackers : [];
    let role = "";
    for (const a of cb) {
      if (oid(a.obj) === o.id) role = "A" + a.defender + ":" + (a.blockers || []).map(oid).join("+");
      else if ((a.blockers || []).some((b) => oid(b) === o.id)) role = "B" + oid(a.obj);
    }
    const f = [ctx.glow.has(o.id) ? "g" : "", ctx.opt.has(o.id) ? "o" : "", ctx.selIds.has(o.id) ? "s" : "", ctx.cand.has(o.id) ? "c" : "", ctx.atkSel.has(o.id) ? "a" + ctx.atkSel.get(o.id) : "",
      ctx.blkCand.has(o.id) ? "b" : "", ctx.assign.has(o.id) ? "x" + ctx.assign.get(o.id) : "", ctx.atkTargets.has(o.id) ? "t" : "", ctx.pickBlk === o.id ? "p" : ""].join("");
    const c = o.c;
    return [landish ? "L" : "T", c.name, o.tapped ? 1 : 0, o.sick ? 1 : 0, o.damage || 0, JSON.stringify(o.counters || {}), c.power, c.toughness, (c.unparsed || []).length, role, f, o.controller].join("|");
  },

  renderBF(p, seen) {
    const S = this.S, ctx = this.ctx;
    const s = this["s" + p];
    const objs = S.battlefield.map((id) => S.objects[id]).filter((o) => o && o.controller === p && !(this.hostMap.has(o.id) === false && false));
    const gmap = new Map(), glist = [];
    objs.forEach((o) => {
      if (o.attachedTo && S.objects[oid(o.attachedTo)] && S.objects[oid(o.attachedTo)].zone === "battlefield") return; // tucked behind its host
      const k = this.groupKey(o, ctx);
      if (k && gmap.has(k)) { gmap.get(k).members.push(o); return; }
      const g = { members: [o], gk: k };
      if (k) gmap.set(k, g);
      glist.push(g);
    });
    const lands = [], perm = [];
    glist.forEach((g) => (isLandOnly(g.members[0]) ? lands : perm).push(g));
    const rank = (g) => { const o = g.members[0]; return has(o, "creature") ? 0 : has(o, "planeswalker") ? 1 : 2; };
    perm.sort((a, b) => rank(a) - rank(b));
    const mk = (g) => {
      const key = g.members[0].id;
      seen.add(key);
      let el = this.tiles.get(key);
      if (!el) el = this.mkTile(key);
      this.updateTile(el, g);
      return el;
    };
    this.syncOrder(s.lands, lands.map(mk));
    this.syncOrder(s.perm, perm.map(mk));
    s._nLands = lands.length; s._nPerm = perm.length;
    s._nTapped = lands.filter((g) => g.members[0].tapped).length; s._nPermTapped = perm.filter((g) => g.members[0].tapped).length;
    s._nAtt = perm.reduce((a, g) => a + (this.hostMap.get(g.members[0].id) || []).length, 0);
  },
  syncOrder(container, els) {
    let i = 0;
    for (const el of els) {
      if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null);
      i++;
    }
  },
  mkTile(key) {
    const el = document.createElement("div");
    el.className = "tile";
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    const atts = document.createElement("div");
    atts.className = "atts";
    el.appendChild(atts);
    const card = makeCard();
    el.appendChild(card);
    el._card = card; el._atts = atts; el._new = true;
    this.tiles.set(key, el);
    return el;
  },
  updateTile(el, g) {
    const S = this.S, ctx = this.ctx;
    const rep = g.members[0], n = g.members.length;
    fillCard(el._card, viewOfObj(rep), (this._cw || 60) > 104 ? "normal" : "small");
    const order = ctx.order.get(rep.id) || 0;
    setLive(el._card, rep, { n, order, attcount: (this.hostMap.get(rep.id) || []).length });
    const id = rep.id;
    let attacking = false, blocking = false;
    const cb = S.combat && S.combat.attackers ? S.combat.attackers : [];
    for (const a of cb) { if (oid(a.obj) === id) attacking = true; if ((a.blockers || []).some((b) => oid(b) === id)) blocking = true; }
    const declared = ctx.atkSel.has(id);
    const cls = ["tile"];
    if (rep.tapped) cls.push("tapped");
    if (rep.sick && has(rep, "creature")) cls.push("sick");
    if (ctx.glow.has(id)) cls.push("glow");
    if (ctx.opt.has(id)) cls.push("opt");
    if (ctx.selIds.has(id)) cls.push("sel");
    if (ctx.cand.has(id)) cls.push("cand");
    if (declared) cls.push("sel", "atk");
    if (ctx.blkCand.has(id)) cls.push("cand");
    if (ctx.pickBlk === id) cls.push("sel");
    if (ctx.assign.has(id)) cls.push("sel", "blk");
    if (ctx.atkTargets.has(id)) cls.push("cand");
    if (ctx.defOpt.has(id)) cls.push("opt");
    if (this.mode && this.mode.kind === "attackers" && this.mode.curDef === id) cls.push("sel");
    if (attacking) cls.push("atk");
    if (blocking) cls.push("blk");
    if (n > 1) cls.push(n > 3 ? "st3" : "st2");
    if (has(rep, "land") && !has(rep, "creature")) cls.push("land");
    if (rep.controller === this.opp) cls.push("theirs");
    const cs = cls.join(" ");
    if (el._cls !== cs) { el._cls = cs; el.className = cs; }
    const ids = g.members.map((o) => o.id);
    el._ids = ids;
    el.dataset.cid = ids.join(",");
    const lbl = rep.c.name + (n > 1 ? " ×" + n : "") + (rep.tapped ? ", tapped" : "") + (rep.c.power != null && has(rep, "creature") ? ", " + rep.c.power + "/" + rep.c.toughness : "") + (ctx.glow.has(id) ? ", has actions" : "");
    if (el._lbl !== lbl) { el._lbl = lbl; el.setAttribute("aria-label", lbl); }
    // attachments
    const atts = this.hostMap.get(id) || [];
    const sig = atts.map((a) => a.id).join(",");
    if (el._attSig !== sig) {
      el._attSig = sig;
      el._atts.innerHTML = "";
      atts.forEach((a, i) => {
        let ae = this.attEls.get(a.id);
        if (!ae) { ae = document.createElement("div"); ae.className = "att"; ae.setAttribute("role", "button"); ae.tabIndex = 0; ae._card = makeCard(); ae.appendChild(ae._card); this.attEls.set(a.id, ae); }
        ae.dataset.cid = a.id; ae.style.setProperty("--i", i);
        ae.setAttribute("aria-label", a.c.name + ", attached to " + rep.c.name);
        el._atts.appendChild(ae);
      });
    }
    atts.forEach((a) => { const ae = this.attEls.get(a.id); fillCard(ae._card, viewOfObj(a), "small"); });
    el.style.setProperty("--ac", atts.length);
  },
  removeStale(seen) {
    const S = this.S;
    for (const [key, el] of Array.from(this.tiles)) {
      if (seen.has(key)) continue;
      this.tiles.delete(key);
      (el._ids || [key]).forEach((id) => { if (this.idTile.get(id) === el) this.idTile.delete(id); });
      this.retire(el, key, el._ids || [key]);
    }
    seen.forEach((key) => { const el = this.tiles.get(key); (el._ids || []).forEach((id) => this.idTile.set(id, el)); });
    // stale attachments
    const live = new Set();
    this.hostMap.forEach((arr) => arr.forEach((a) => live.add(a.id)));
    this.attEls.forEach((el, id) => { if (!live.has(id)) { this.attEls.delete(id); el.remove(); } });
  },

  /* Where did a vanished element go? Fly it there (graveyard etc.) or fade it in place. */
  retire(el, key, ids) {
    const S = this.S;
    const from = this.rects.get(ids[0]) || (el.isConnected ? el.getBoundingClientRect() : null);
    const o = S.objects[ids[0]];
    const z = o ? o.zone : "";
    const visible = z === "battlefield" || z === "stack" || (z === "hand" && o.owner === this.me);
    if (el.parentNode) el.parentNode.removeChild(el);
    if (visible || !from || !from.width || this.rm || this.closed) return;
    const to = o ? this.zoneRect(o.owner, z) : null;
    this.ghost(el, from, to, o && !o.token ? z : "poof");
  },

  /* ---------- hand ---------- */
  renderHand() {
    const S = this.S, P = S.players[this.me], ctx = this.ctx;
    const ids = P.hand.slice();
    const keep = new Set(ids);
    this.handEls.forEach((el, id) => {
      if (keep.has(id)) return;
      this.handEls.delete(id);
      const from = this.rects.get(id) || el.getBoundingClientRect();
      const o = S.objects[id];
      const z = o ? o.zone : "";
      const vis = z === "battlefield" || z === "stack" || z === "hand";
      el.remove();
      if (!vis && from && from.width && !this.rm && !this.closed) this.ghost(el, from, o ? this.zoneRect(o.owner, z) : null, o && !o.token ? z : "poof");
    });
    const els = ids.map((id) => {
      const o = S.objects[id];
      let el = this.handEls.get(id);
      if (!el) {
        el = document.createElement("div");
        el.className = "hc"; el.setAttribute("role", "button"); el.tabIndex = 0;
        el._card = makeCard(); el.appendChild(el._card);
        el._new = true;
        this.handEls.set(id, el);
      }
      fillCard(el._card, viewOfObj(o), "normal");
      setLive(el._card, o);
      const cls = "hc" + (ctx.glow.has(id) ? " glow" : "") + (ctx.opt.has(id) ? " opt" : "") + (ctx.selIds.has(id) ? " sel" : "");
      if (el._cls !== cls) { el._cls = cls; el.className = cls; }
      el.dataset.cid = id;
      const lbl = o.c.name + (ctx.glow.has(id) ? ", playable" : "");
      if (el._lbl !== lbl) { el._lbl = lbl; el.setAttribute("aria-label", lbl); }
      return el;
    });
    this.syncOrder(this.el.hand, els);
    this.layoutHand();
  },
  layoutHand() {
    const H = this.el.hand;
    const W = H.clientWidth, Hh = H.clientHeight;
    const n = this.handEls.size;
    if (!W || !Hh) return;
    const hw = this.root.dataset.orient === "land" ? 58 : clamp(Math.floor((Hh - 10) / 1.4), 52, this.root.dataset.orient === "wide" ? 104 : 128);
    H.style.setProperty("--hw", hw + "px");
    const pad = Math.round(hw * 0.2);
    let step = n > 1 ? Math.min(hw + 8, (W - hw - 2 * pad) / (n - 1)) : 0;
    step = Math.max(step, 14);
    const total = hw + step * (n - 1);
    const left0 = Math.max(pad, (W - total) / 2);
    const mid = (n - 1) / 2;
    const ang = n > 1 ? Math.min(2.4, 16 / n) : 0;
    let i = 0;
    this.el.hand.querySelectorAll(".hc").forEach((el) => {
      const d = i - mid;
      el.style.setProperty("--x", (left0 + i * step).toFixed(1) + "px");
      el.style.setProperty("--y", (d * d * (n > 6 ? 0.9 : 1.4) + 2).toFixed(1) + "px");
      el.style.setProperty("--r", (d * ang).toFixed(2) + "deg");
      el.style.zIndex = String(i + 1);
      i++;
    });
  },

  /* ---------- stack ---------- */
  stackView(o) {
    if (!o.isAbility) return viewOfObj(o);
    const src = this.obj(o.sourceId);
    const c = src ? src.c : { name: o.c.name };
    return { name: c.name, cost: "", type: "Ability", text: o.text || (o.c && o.c.text) || "", pt: "", img: "", frame: frameFor(c), token: false, types: ["ability"], art: src ? src.c.img : "" };
  },
  renderStack() {
    const S = this.S, box = this.el.stackbox;
    const ids = S.stack.slice().reverse();
    const keep = new Set(ids);
    this.stackEls.forEach((el, id) => {
      if (keep.has(id)) return;
      this.stackEls.delete(id);
      const from = this.rects.get(id) || el.getBoundingClientRect();
      const o = S.objects[id];
      const z = o ? o.zone : "";
      const vis = z === "battlefield" || z === "stack" || z === "hand";
      el.remove();
      if (this.batch && !this.rm && from && from.width) {
        if (!vis) this.ghost(el, from, o && !o.isAbility ? this.zoneRect(o.owner, z) : null, o && !o.isAbility && !o.token ? z : "poof");
      }
    });
    box.hidden = !ids.length;
    this.root.classList.toggle("has-stack", ids.length > 0);
    if (!ids.length) { box.innerHTML = ""; this._skSig = ""; return; }
    if (!box._list) {
      box.innerHTML = '<div class="sk-head"><b></b><span></span></div><div class="sk-list"></div><div class="sk-cap"></div>';
      box._head = box.querySelector(".sk-head b"); box._more = box.querySelector(".sk-head span"); box._list = box.querySelector(".sk-list"); box._cap = box.querySelector(".sk-cap");
    }
    const shown = ids.slice(0, 5);
    const els = shown.map((id, i) => {
      const o = S.objects[id];
      let el = this.stackEls.get(id);
      if (!el) {
        el = document.createElement("div");
        el.className = "sk"; el.setAttribute("role", "button"); el.tabIndex = 0;
        el._card = makeCard(); el.appendChild(el._card);
        el.insertAdjacentHTML("beforeend", '<span class="who"></span>');
        el._who = el.lastChild;
        el._new = true;
        this.stackEls.set(id, el);
      }
      const v = this.stackView(o);
      fillCard(el._card, v, "small");
      el._card.classList.toggle("is-ability", !!o.isAbility);
      if (o.isAbility && v.art) el._card.style.setProperty("--art", 'url("' + artCrop(v.art) + '")'); else el._card.style.removeProperty("--art");
      el.dataset.cid = id;
      el.style.setProperty("--i", i);
      el.classList.toggle("mine", o.controller === this.me);
      el._who.textContent = o.controller === this.me ? "You" : "Opp";
      el.setAttribute("aria-label", (o.isAbility ? "Ability of " : "Spell: ") + v.name + ", controlled by " + (o.controller === this.me ? "you" : "opponent") + (i === 0 ? ", top of stack" : ""));
      return el;
    });
    this.syncOrder(box._list, els);
    box._head.textContent = "Stack";
    box._more.textContent = ids.length > 5 ? "+" + (ids.length - 5) + " more" : ids.length + (ids.length === 1 ? " item" : " items");
    const top = S.objects[ids[0]];
    const tv = this.stackView(top);
    const tg = (top.targets || []).map((t) => { const x = typeof t === "string" && t[0] === "P" ? this.player(+t.slice(1)).name : (S.objects[oid(t)] || { c: { name: "?" } }).c.name; return x; });
    box._cap.textContent = (top.controller === this.me ? "Yours: " : "Theirs: ") + tv.name + (tg.length ? " → " + tg.join(", ") : "");
  },

  /* ---------- phase tracker ---------- */
  renderPhases() {
    const S = this.S, st = this.disp.step, active = this.disp.active;
    const mine = active === this.me;
    const stops = (mine ? this.settings.stops.my : this.settings.stops.opp) || {};
    PHASES.forEach((ph) => {
      const el = this.phaseEls[ph[0]];
      const on = ph[2].indexOf(st) >= 0;
      const stop = (STOP_KEYS[ph[0]] || []).some((k) => stops[k]) && ph[0] !== "untap";
      const cls = "ph" + (on ? " on" : "") + (stop ? " stop" : "");
      if (el._cls !== cls) { el._cls = cls; el.className = cls; el.setAttribute("aria-current", on ? "step" : "false"); }
    });
    this.el.phases.classList.toggle("theirs", !mine);
    const tl = "Turn " + this.disp.turn + " · " + (mine ? "Your turn" : "Opponent’s turn");
    if (this._tl !== tl) { this._tl = tl; this.el.turnl.textContent = tl; }
  },

  /* ---------- action bar ---------- */
  renderBar() {
    const S = this.S, m = this.mode, ctx = this.ctx;
    let label = "…", sub = "", off = true, cls = "go";
    if (this._wait && m) {
      off = false;
      const req = m.req;
      switch (m.kind) {
        case "priority":
          if (S.stack.length) {
            const top = S.objects[S.stack[S.stack.length - 1]];
            label = "Resolve"; sub = top ? (top.controller === this.me ? "your " : "their ") + (top.isAbility ? "ability" : "spell") : "";
            cls += " resolve";
          } else if (S.active === this.me) { label = S.step === "main2" || S.step === "end" ? "End Turn" : "Next"; sub = STEP_NEXT[S.step] || ""; }
          else { label = "Pass"; sub = STEP_NAME[S.step] ? STEP_NAME[S.step].toLowerCase() : ""; cls += " pass"; }
          break;
        case "choose": {
          const n = m.sel.length;
          if (n < req.min) { label = "Choose " + (req.min - n) + (req.min - n === 1 ? " more" : " more"); off = true; }
          else if (n === 0) { label = req.min === 0 ? "None" : "Choose"; off = req.min !== 0; }
          else { label = "Confirm"; sub = req.max > 1 || req.min !== req.max ? n + " chosen" : ""; }
          cls += " ok";
          break;
        }
        case "attackers": { const n = m.sel.size; label = n ? "Attack" : "No Attacks"; sub = n ? n + (n === 1 ? " creature" : " creatures") : "skip combat"; cls += n ? " atk" : ""; break; }
        case "blockers": { const n = m.assign.size; label = n ? "Confirm blocks" : "No Blocks"; sub = n ? n + (n === 1 ? " block" : " blocks") : ""; cls += " blk"; break; }
        default: off = true; label = "…";
      }
    } else {
      label = this._think ? "Opponent…" : "…";
      cls += " wait";
    }
    if (this._goCls !== cls + off) { this._goCls = cls + off; this.el.go.className = cls; }
    this.el.go.disabled = off;
    if (this._goL !== label) { this._goL = label; this.el.goL.textContent = label; }
    if (this._goS !== sub) { this._goS = sub; this.el.goS.textContent = sub; }
    this.el.go.setAttribute("aria-label", label + (sub ? ", " + sub : ""));
    this.el.undo.disabled = !this.canUndo();
    const hasSpecial = !!(m && m.kind === "priority" && (m.req.actions || []).some((a) => a.type === "special"));
    this.el.tools.hidden = !hasSpecial;
    this.el.pass.disabled = !(this._wait && m && m.kind === "priority");
    this.el.pass.classList.toggle("on", !!this.skipTurn);
    this.root.classList.toggle("fullctl", !!this.settings.fullControl);
  },

  renderPrompt() {
    const m = this.mode, el = this.el.prompt;
    if (!(this._wait && m) || m.kind === "priority" || m.kind === "confirm" || m.kind === "number" || m.kind === "mulligan" || (m.kind === "choose" && !m.board)) { el.hidden = true; return; }
    const req = m.req;
    let h = "";
    const srcO = req.source ? this.obj(req.source) : null;
    if (m.kind === "choose") {
      const n = m.sel.length;
      const range = req.min === req.max ? "" + req.min : req.min + "–" + req.max;
      h = '<span class="pt-t">' + esc(req.prompt || "Choose") + '</span><span class="pt-c num">' + n + "/" + range + '</span><button class="pbtn" data-act="listOpts" aria-label="Show as list">' + IC.list + "</button>";
    } else if (m.kind === "attackers") {
      const defs = this.defenderList(req);
      h = '<span class="pt-t">' + (defs.length > 1 ? "Attacking " + esc(this.defName(m.curDef)) + " — tap a defender to switch" : "Tap creatures to attack") + '</span><button class="pbtn wide" data-act="attackAll">Attack all</button>';
    } else if (m.kind === "blockers") {
      let dmg = 0;
      (req.attackers || []).forEach((a) => {
        const blocked = Array.from(m.assign.values()).indexOf(oid(a)) >= 0;
        const o = this.obj(a);
        if (!blocked && o && typeof o.c.power === "number") dmg += o.c.power;
      });
      const life = this.disp.life[this.me];
      h = '<span class="pt-t">' + (m.pick ? "Now tap the attacker to block" : "Tap a blocker, then the attacker") + '</span><span class="pt-inc ' + (dmg >= life ? "lethal" : dmg ? "hit" : "safe") + '">Incoming <b class="num">' + dmg + "</b> → " + (life - dmg) + "</span>";
    }
    if (el._h !== h) { el._h = h; el.innerHTML = h; }
    el.hidden = false;
  },
  defenderList(req) {
    const s = new Set();
    (req.candidates || []).forEach((cd) => (cd.defenders || []).forEach((d) => s.add(oid(d))));
    return Array.from(s);
  },
  defName(id) {
    if (typeof id === "string" && /^P\d$/.test(id)) return id === "P" + this.me ? "you" : "Opponent";
    const o = this.obj(id);
    return o ? o.c.name : "?";
  },

  /* ---------- layout / sizing ---------- */
  layout() {
    if (!this.root.isConnected) return;
    const gap = 6;
    [this.opp, this.me].forEach((p) => {
      const s = this["s" + p];
      const W = s.bf.clientWidth - 10, H = s.bf.clientHeight;
      if (!W || !H) return;
      const nL = s._nLands || 0, nP = s._nPerm || 0;
      // lands: a single row, as large as fits
      let lw = 26;
      const isLand = this.root.dataset.orient === "land";
      const maxLw = clamp(Math.floor(H * (isLand ? 0.27 : 0.34) / 1.4), 26, 64);
      for (let w = maxLw; w >= 26; w -= 2) {
        const need = nL * (w + gap) + (s._nTapped || 0) * w * 0.42;
        if (need <= W) { lw = w; break; }
        lw = w;
      }
      lw = Math.min(lw, maxLw);
      const landH = nL ? Math.round(lw * 1.4) + 8 : 0;
      s.bf.style.setProperty("--lw", lw + "px");
      s.bf.style.setProperty("--landh", landH + "px");
      // permanents: wrap, largest card that fits
      const availH = H - landH - 8 - (nL ? 4 : 0) - 14;
      const minCw = isLand ? 36 : 44;
      let cw = minCw, scroll = true;
      const maxCw = this.root.dataset.orient === "wide" ? 104 : this.root.dataset.orient === "land" ? 66 : 84;
      const scale = { s: 0.86, m: 1, l: 1.14 }[this.settings.cardSize || "m"];
      const top = Math.min(Math.floor(maxCw * scale), Math.floor(availH / 1.4));
      for (let w = top; w >= minCw; w -= 2) {
        const per = Math.max(1, Math.floor((W + gap) / (w + gap + 4)));
        const tappedExtra = (s._nPermTapped || 0) * w * 0.42;
        const rows = Math.ceil((nP * (w + gap + 4) + tappedExtra) / (W + gap));
        if (rows * (w * 1.4 + gap) <= availH) { cw = w; scroll = false; break; }
        cw = w;
      }
      if (nP === 0) cw = Math.max(minCw, Math.min(top, 74));
      s.bf.style.setProperty("--cw", cw + "px");
      s.perm.classList.toggle("scroll", scroll);
      if (p === this.me) this._cw = cw;
    });
    this.layoutHand();
  },

  /* ---------- arrows ---------- */
  anchor(id) {
    id = oid(id);
    if (id == null) return null;
    if (/^P\d$/.test(id)) { const s = this["s" + id.slice(1)]; return s ? s.av.parentNode : null; }
    return this.idTile.get(id) || this.handEls.get(id) || this.stackEls.get(id) || this.cmdEls.get(id) || this.attEls.get(id) || null;
  },
  buildArrows() {
    const S = this.S, A = [];
    const m = this.mode, ctx = this.ctx;
    S.stack.forEach((id) => {
      const o = S.objects[id];
      if (!o) return;
      (o.targets || []).forEach((t) => A.push({ from: id, to: oid(t), cls: "tgt" }));
    });
    if (S.combat && S.combat.attackers) {
      S.combat.attackers.forEach((a) => {
        const aid = oid(a.obj);
        A.push({ from: aid, to: oid(a.defender), cls: "atk" });
        (a.blockers || []).forEach((b) => A.push({ from: oid(b), to: aid, cls: "blk" }));
      });
    }
    if (m && this._wait) {
      if (m.kind === "choose" && m.board) {
        const src = m.req.source ? oid(m.req.source) : null;
        m.sel.forEach((idx) => { const id = oid(m.req.options[idx].id); if (src && src !== id) A.push({ from: src, to: id, cls: "sel" }); });
      } else if (m.kind === "attackers") {
        m.sel.forEach((def, id) => A.push({ from: id, to: def, cls: "atk" }));
      } else if (m.kind === "blockers") {
        m.assign.forEach((att, blk) => A.push({ from: blk, to: att, cls: "blk" }));
      }
    }
    this.arrows = A.slice(0, 40);
  },
  drawArrows() {
    const g = this.el.ag;
    if (!g) return;
    const base = this.root.getBoundingClientRect();
    const frag = document.createDocumentFragment();
    const seen = new Set();
    this.arrows.forEach((a) => {
      const k = a.from + ">" + a.to + a.cls;
      if (seen.has(k)) return;
      seen.add(k);
      const fe = this.anchor(a.from), te = this.anchor(a.to);
      if (!fe || !te || !fe.isConnected || !te.isConnected) return;
      const fr = fe.getBoundingClientRect(), tr = te.getBoundingClientRect();
      if (!fr.width || !tr.width) return;
      const x1 = fr.left + fr.width / 2 - base.left, y1 = fr.top + fr.height / 2 - base.top;
      let x2 = tr.left + tr.width / 2 - base.left, y2 = tr.top + tr.height / 2 - base.top;
      // stop short of the target centre so the head is visible
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
      const back = Math.min(len * 0.45, Math.min(tr.width, tr.height) * 0.42);
      x2 -= (dx / len) * back; y2 -= (dy / len) * back;
      const nx = -dy / len, ny = dx / len, bend = Math.min(40, len * 0.16);
      const cx = (x1 + x2) / 2 + nx * bend, cy = (y1 + y2) / 2 + ny * bend;
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", "M" + x1.toFixed(1) + " " + y1.toFixed(1) + " Q" + cx.toFixed(1) + " " + cy.toFixed(1) + " " + x2.toFixed(1) + " " + y2.toFixed(1));
      p.setAttribute("class", "ar ar-" + a.cls);
      p.setAttribute("marker-end", "url(#mk-" + a.cls + ")");
      frag.appendChild(p);
    });
    g.textContent = "";
    g.appendChild(frag);
  },
};
