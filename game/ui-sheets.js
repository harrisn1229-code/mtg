/* Sheets and dialogs of the match: zoom, pickers, confirm/number, mulligan, pause/settings, log, zones,
   manual tools, emotes, intro and game over. Mixed into Match.prototype. */

import { esc, oid, cap, manaHtml, textHtml, cardFromObj, makeCard, fillCard, viewOfObj, viewOfData, typeLineOf, artCrop, pip } from "./ui-card.js";
import { IC, STEP_NAME, isMeaningful } from "./ui-shared.js";
import { EMOTES } from "./ui-fx.js";

const SETTING_STEPS = [["upkeep", "Upkeep"], ["draw", "Draw"], ["main1", "Main 1"], ["beginCombat", "Begin combat"], ["declareAttackers", "Attackers"], ["declareBlockers", "Blockers"], ["combatDamage", "Damage"], ["endCombat", "End combat"], ["main2", "Main 2"], ["end", "End step"]];

export const sheetMethods = {
  /* ---------- sheet infrastructure ---------- */
  sheetHtml(html, o) {
    o = o || {};
    const wrap = document.createElement("div");
    wrap.className = "msheet-wrap" + (o.full ? " full" : "");
    wrap.innerHTML = '<div class="mscrim"' + (o.dialog || o.modal ? "" : ' data-act="sheetClose"') + '></div><div class="msheet ' + (o.cls || "") + '" role="dialog" aria-modal="true" aria-label="' + esc(o.label || "Dialog") + '">' +
      (o.dialog || o.modal || o.noX ? "" : '<button class="sx" data-act="sheetClose" aria-label="Close">' + IC.close + "</button>") + '<div class="msb">' + html + "</div></div>";
    this.el.layer.appendChild(wrap);
    const rec = { wrap, dialog: !!o.dialog, modal: !!o.modal, onClose: o.onClose, opener: document.activeElement };
    this.sheets.push(rec);
    this.root.classList.add("sheeted");
    requestAnimationFrame(() => wrap.classList.add("in"));
    const f = wrap.querySelector("[autofocus], .mbtn.pri, button:not(.sx)");
    if (f && !o.noFocus && window.matchMedia && window.matchMedia('(pointer:fine)').matches) try { f.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    rec.body = wrap.querySelector(".msb");
    return rec;
  },
  removeSheet(rec) {
    const i = this.sheets.indexOf(rec);
    if (i >= 0) this.sheets.splice(i, 1);
    rec.wrap.classList.remove("in");
    setTimeout(() => rec.wrap.remove(), this.rm ? 0 : 200);
    if (rec.onClose) rec.onClose();
    if (!this.sheets.length) { this.root.classList.remove("sheeted"); try { if (rec.opener && rec.opener.isConnected) rec.opener.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  },
  closeTopSheet() {
    const rec = this.sheets[this.sheets.length - 1];
    if (!rec || rec.dialog || rec.modal) return false;
    this.removeSheet(rec);
    return true;
  },
  closeAllSheets() { this.sheets.slice().forEach((r) => { if (!r.modal) this.removeSheet(r); }); },
  closeDialogSheets() { this.sheets.slice().forEach((r) => { if (r.dialog) this.removeSheet(r); }); },
  act_sheetClose() { this.closeTopSheet(); },
  act_close() { this.closeTopSheet(); },

  /* ---------- zoom ---------- */
  openZoom(ids) {
    const o = this.obj(ids[0]);
    if (!o || !o.c) return;
    if (o.zone === "library" || (o.zone === "hand" && o.owner !== this.me)) return; // never reveal hidden cards
    this.closeZoomOnly();
    let c = o.c;
    let v = o.isAbility ? this.stackView(o) : viewOfObj(o);
    const fdMine = o.faceDown && (o.zone === "exile" ? o.owner : o.controller) === this.me;
    if (fdMine && o.card) { v = viewOfData(o.card); c = { ...c, text: o.card.oracle_text || "", keywords: {}, unparsed: [] }; } // you may look at your own face-down cards (CR 708.6)
    const acts = this.actionsFor(ids);
    const m = this._wait ? this.mode : null;
    const optIdx = m && m.kind === "choose" && m.board ? ids.map((id) => (this.ctx.opt.has(id) ? this.ctx.opt.get(id) : null)).find((x) => x != null) : null;
    const chips = [];
    if (o.tapped) chips.push("Tapped");
    if (o.sick && (c.types || []).indexOf("creature") >= 0) chips.push("Summoning sick");
    if (o.token) chips.push("Token");
    if (o.faceDown) chips.push(fdMine ? (o.zone === "exile" ? "Exiled face down — only you can see it" : "Face down — your opponent sees a nameless 2/2") : "Face down — hidden");
    if (o.zone === "phased") chips.push("Phased out — treated as though it doesn't exist; phases in at its controller's untap step");
    if (o.chosen && o.chosen.creatureType) chips.push("Chosen type: " + cap(o.chosen.creatureType));
    if (o.chosen && o.chosen.mode) chips.push("Chosen: " + cap(o.chosen.mode));
    if (o.chosen && o.chosen.color) chips.push("Chosen color: " + o.chosen.color);
    if (o.copyDef && o.copyDef._copyOf && !o.token) chips.push(o.def.name + " — a copy of " + o.copyDef._copyOf);
    if (o.isCopy) chips.push("Copy");
    if (o.isCommander) { const P = this.player(o.owner); const tax = (P.commanderCasts[o.id] || 0) * 2; chips.push("Commander" + (tax ? " · tax {" + tax + "}" : "")); }
    if (o.damage) chips.push(o.damage + " damage");
    Object.keys(o.counters || {}).forEach((k) => { if (o.counters[k]) chips.push(o.counters[k] + " × " + k + " counter"); });
    if (o.attachedTo && this.obj(o.attachedTo)) chips.push("Attached to " + this.obj(o.attachedTo).c.name);
    if (ids.length > 1) chips.push(ids.length + " identical — showing one");
    const kw = Object.keys(c.keywords || {}).filter((k) => c.keywords[k]);
    const owner = o.controller === this.me ? "You control" : "Opponent controls";
    const html =
      '<div class="zoom"><div class="zc"></div><div class="zi"><h2>' + esc(v.name) + '</h2><div class="zcost">' + manaHtml(v.cost) + '</div><div class="ztype">' + esc(v.type) + (v.pt ? " · " + esc(c.power + "/" + c.toughness) : "") + "</div>" +
      (c.text ? '<div class="ztext">' + textHtml(c.text) + "</div>" : o.isAbility ? '<div class="ztext">' + textHtml(o.text || "") + "</div>" : "") +
      (kw.length ? '<div class="zkw">' + kw.map((k) => '<span>' + esc(k) + "</span>").join("") + "</div>" : "") +
      (chips.length ? '<div class="zchips">' + chips.map((t) => "<span>" + textHtml(t).replace(/<\/?p>/g, "") + "</span>").join("") + "</div>" : "") +
      (o.pile && o.pile.length > 1 ? '<div class="zpile"><b>Mutated — cards in this permanent, top first</b>' + o.pile.map((id, k) => { const x = this.obj(id); return "<span>" + (k === 0 ? "▲ " : "· ") + esc(x ? x.def.name : "?") + (x && x.def.power != null ? " (" + x.def.power + "/" + x.def.toughness + ")" : "") + (k > 0 && x && x.def.text ? ' — <i class="zpt">' + textHtml(String(x.def.text).replace(/\([^)]*\)/g, "").trim()).replace(/<\/?p>/g, " ") + "</i>" : "") + "</span>"; }).join("") + "</div>" : "") +
      (c.unparsed && c.unparsed.length ? '<div class="znote warn"><b>⚠ Partly automated.</b> The engine skips this text; use manual tools if it applies:<ul>' + c.unparsed.map((u) => "<li>" + esc(u) + "</li>").join("") + "</ul></div>" : "") +
      '<div class="zown">' + owner + " this" + (o.zone ? " · " + esc(o.zone) : "") + "</div></div>" +
      '<div class="zacts">' +
      (optIdx != null ? '<button class="mbtn pri" data-act="zoomSelect" data-i="' + optIdx + '">' + (m.sel.indexOf(optIdx) >= 0 ? "Deselect" : "Select") + "</button>" : "") +
      acts.map((x) => '<button class="mbtn ' + (isMeaningful(x.a) ? "pri" : "") + '" data-act="zoomAct" data-i="' + x.idx + '"><span>' + esc(x.a.label) + "</span>" + (x.a.cost ? manaHtml(x.a.cost) : "") + "</button>").join("") +
      (!acts.length && optIdx == null && this._wait && m && m.kind === "priority" ? '<p class="zmuted">Nothing to do with this right now.</p>' : "") +
      "</div></div>";
    const rec = this.sheetHtml(html, { cls: "zoomsheet", label: v.name });
    this._zoomRec = rec;
    const slot = rec.body.querySelector(".zc");
    const card = makeCard();
    fillCard(card, v, "large");
    if (!o.isAbility) setLiveSafe(card, o);
    slot.appendChild(card);
  },
  closeZoomOnly() { if (this._zoomRec && this.sheets.indexOf(this._zoomRec) >= 0) this.removeSheet(this._zoomRec); this._zoomRec = null; },
  act_zoomAct(el) {
    const i = +el.dataset.i;
    if (!this._wait || !this.mode || this.mode.kind !== "priority") return;
    this.closeAllSheets();
    this.sound.play("click");
    this.submit({ type: "act", index: i });
  },
  act_zoomSelect(el) {
    const i = +el.dataset.i, m = this.mode;
    if (!m || m.kind !== "choose") return;
    this.closeTopSheet();
    this.toggleOpt(i, oid(m.req.options[i].id));
  },

  /* ---------- picker (search, graveyard, modes, colours, text) ---------- */
  openPicker(req) {
    const m = this.mode;
    if (!m || m.req !== req) return;
    this.closeDialogSheets();
    const S = this.S;
    const items = (req.options || []).map((op, i) => {
      const o = op.id != null ? S.objects[oid(op.id)] : null;
      const sel = m.sel.indexOf(i) >= 0;
      if (o && o.c && (op.type === "card" || op.type === "object")) return '<button class="pk card' + (sel ? " sel" : "") + '" data-act="pickToggle" data-i="' + i + '" aria-pressed="' + sel + '" aria-label="' + esc(op.label || o.c.name) + '"><span class="slot" data-oid="' + o.id + '"></span><span class="pl">' + esc(op.label || o.c.name) + '</span><i class="ord"></i></button>';
      if (op.type === "color") return '<button class="pk color' + (sel ? " sel" : "") + '" data-act="pickToggle" data-i="' + i + '" aria-pressed="' + sel + '">' + pip(String(op.id || op.label || "C").charAt(0)) + '<span class="pl">' + esc(op.label) + "</span></button>";
      return '<button class="pk text' + (sel ? " sel" : "") + '" data-act="pickToggle" data-i="' + i + '" aria-pressed="' + sel + '"><span class="pl">' + textHtml(op.label).replace(/<\/?p>/g, "") + "</span></button>";
    }).join("");
    const range = req.min === req.max ? "" + req.min : req.min + "–" + req.max;
    const html = '<h2>' + esc(req.prompt || "Choose") + '</h2><p class="sub">' + (req.reason ? ({ creatureType: "Creature type", copy: "Copy", mutate: "Mutate", reveal: "Reveal", order: "Order", scry: "Scry", pay: "Pay", color: "Color" }[req.reason] || cap(req.reason)) + " · " : "") + 'Choose <b class="num">' + range + '</b></p>' +
      ((req.options || []).length > 14 ? '<input class="pfilter" type="search" placeholder="Filter by name" aria-label="Filter options">' : "") +
      '<div class="pgrid">' + items + '</div><div class="sh-actions"><button class="mbtn peekbtn" data-act="pickPeek">View board</button><button class="mbtn pri" data-act="pickGo"></button></div>';
    const rec = this.sheetHtml(html, { cls: "picker", dialog: true, label: req.prompt || "Choose" });
    this._pickRec = rec;
    rec.body.querySelectorAll(".slot").forEach((s) => { const o = S.objects[s.dataset.oid]; const c = cardFromObj(o, "small"); s.appendChild(c); });
    const f = rec.body.querySelector(".pfilter");
    if (f) f.addEventListener("input", () => { const q = f.value.toLowerCase(); rec.body.querySelectorAll(".pk").forEach((b) => { b.hidden = q && b.textContent.toLowerCase().indexOf(q) < 0; }); });
    this.pickerSync();
  },
  pickerSync() {
    const rec = this._pickRec, m = this.mode;
    if (!rec || !m || m.kind !== "choose") return;
    rec.body.querySelectorAll(".pk").forEach((b) => {
      const i = +b.dataset.i, at = m.sel.indexOf(i);
      b.classList.toggle("sel", at >= 0);
      b.setAttribute("aria-pressed", at >= 0);
      const ord = b.querySelector(".ord");
      if (ord) ord.textContent = at >= 0 && (m.req.ordered || m.req.max > 1) ? at + 1 : "";
    });
    const go = rec.body.querySelector(".pickGo, [data-act=pickGo]");
    const n = m.sel.length, req = m.req;
    go.textContent = n < req.min ? "Choose " + (req.min - n) + " more" : n === 0 ? "Skip" : "Confirm" + (n > 1 ? " (" + n + ")" : "");
    go.disabled = n < req.min;
  },
  act_pickToggle(el) {
    const m = this.mode;
    if (!m || m.kind !== "choose") return;
    if (this.togglePickerIdx(+el.dataset.i)) { this.sound.play("click"); this.pickerSync(); this.render(); }
  },
  act_pickGo() {
    const m = this.mode;
    if (!m || m.kind !== "choose" || m.sel.length < m.req.min) return;
    this.closeDialogSheets();
    this.goAction();
  },
  act_pickPeek() {
    const rec = this._pickRec;
    if (!rec) return;
    rec.wrap.classList.toggle("peek");
    const b = rec.wrap.querySelector(".peekbtn");
    b.textContent = rec.wrap.classList.contains("peek") ? "Back to choices" : "View board";
  },

  /* ---------- confirm / number ---------- */
  openConfirm(req) {
    const src = req.source ? this.obj(req.source) : null;
    const html = '<h2>' + esc(req.prompt || "Are you sure?") + "</h2>" + (src && src.c ? '<p class="sub">' + esc(src.c.name) + '</p><div class="cfsrc"></div>' : "") + '<div class="sh-actions"><button class="mbtn" data-act="cfNo">No</button><button class="mbtn pri" data-act="cfYes">Yes</button></div>';
    const rec = this.sheetHtml(html, { cls: "small", dialog: true, label: req.prompt });
    if (src && src.c) { const s = rec.body.querySelector(".cfsrc"); s.appendChild(cardFromObj(src, "small")); }
  },
  act_cfYes() { if (this.mode && this.mode.kind === "confirm") { this.closeDialogSheets(); this.sound.play("click"); this.submit({ yes: true }); } },
  act_cfNo() { if (this.mode && this.mode.kind === "confirm") { this.closeDialogSheets(); this.sound.play("click"); this.submit({ yes: false }); } },

  openNumber(req) {
    const min = req.min | 0, max = req.max | 0;
    let v = clampN(this._lastNum != null && this._lastNum >= min && this._lastNum <= max ? this._lastNum : Math.max(min, Math.min(max, min < 0 ? 0 : min)), min, max);
    const html = '<h2>' + esc(req.prompt || "Choose a number") + '</h2><div class="nstep"><button class="mbtn round" data-act="numDec" aria-label="Decrease">' + IC.minus + '</button><output class="nval num" aria-live="polite">' + v + '</output><button class="mbtn round" data-act="numInc" aria-label="Increase">' + IC.plus + '</button></div>' +
      '<input class="nrange" type="range" min="' + min + '" max="' + max + '" value="' + v + '" aria-label="Value"><div class="nlim"><span>' + min + "</span><span>" + max + '</span></div><div class="sh-actions"><button class="mbtn pri" data-act="numGo">Confirm</button></div>';
    const rec = this.sheetHtml(html, { cls: "small", dialog: true, label: req.prompt });
    const out = rec.body.querySelector(".nval"), rng = rec.body.querySelector(".nrange");
    const set = (x) => { v = clampN(x, min, max); out.textContent = v; rng.value = v; this._numV = v; };
    this._numV = v; this._numSet = set;
    rng.addEventListener("input", () => set(+rng.value));
  },
  act_numDec() { if (this._numSet) this._numSet(this._numV - 1); },
  act_numInc() { if (this._numSet) this._numSet(this._numV + 1); },
  act_numGo() { if (this.mode && this.mode.kind === "number") { this._lastNum = this._numV; this.closeDialogSheets(); this.submit({ value: this._numV }); } },

  /* ---------- mulligan ---------- */
  openMulligan(req) {
    const P = this.player(this.me);
    const n = req.mulligans || 0;
    const html = '<h2>' + (n ? "New hand" : "Your opening hand") + '</h2><p class="sub">' + (n ? "You have mulliganed " + n + (n === 1 ? " time" : " times") + ". Keeping means putting " + n + (n === 1 ? " card" : " cards") + " on the bottom of your library." : "Seven cards. Keep them, or shuffle and draw a new hand.") + (req.free ? ' The first mulligan is free.' : "") + '</p><div class="mhand"></div>' +
      '<div class="sh-actions"><button class="mbtn" data-act="mullNo">Mulligan</button><button class="mbtn pri" data-act="mullKeep">Keep hand</button></div>';
    const rec = this.sheetHtml(html, { cls: "mull", dialog: true, full: true, label: "Mulligan" });
    const row = rec.body.querySelector(".mhand");
    P.hand.forEach((id) => { const o = this.obj(id); const w = document.createElement("div"); w.className = "mc"; w.appendChild(cardFromObj(o, "normal")); row.appendChild(w); });
  },
  act_mullKeep() { if (this.mode && this.mode.kind === "mulligan") { this.closeDialogSheets(); this.submit({ keep: true }); } },
  act_mullNo() { if (this.mode && this.mode.kind === "mulligan") { this.closeDialogSheets(); this.submit({ keep: false }); } },

  /* ---------- pause / settings ---------- */

  /* ---------- watchdog fallback: a plain list that can answer ANY pending request ---------- */
  openFallback(req) {
    req = req || (this._wait && this._wait.req);
    if (!req || this.closed) return;
    this.closeDialogSheets();
    const nm = (id) => { const o = id != null && typeof id !== "object" ? this.S.objects[oid(id)] : id && id.c ? id : null; return o && o.c ? o.c.name : /^P\d$/.test(String(id)) ? (this.S.players[+String(id)[1]] || {}).name || String(id) : String(oid(id)); };
    const sel = new Set(), blocks = {};
    let value = req.min || 0, body = "", chk = null;
    const A = (act, label, cls, extra) => '<button class="mbtn ' + (cls || "") + '" data-fb="' + act + '"' + (extra || "") + ">" + esc(label) + "</button>";
    switch (req.kind) {
      case "priority":
        body = (req.actions || []).map((a, i) => A("act", (a.label || a.type) + (a.cost ? " (" + a.cost + ")" : ""), a.mana ? "" : "pri", ' data-i="' + i + '"')).join("") + A("pass", "Pass priority");
        break;
      case "choose":
        body = '<p class="sub">Choose ' + (req.min === req.max ? req.min : req.min + "–" + req.max) + "</p>" + (req.options || []).map((o, i) => A("tog", o.label || nm(o.id), "", ' data-i="' + i + '" aria-pressed="false"')).join("") + A("done", "Confirm", "pri", " disabled");
        chk = () => sel.size >= req.min && sel.size <= req.max;
        break;
      case "attackers":
        body = (req.candidates || []).map((c, i) => A("tog", "Attack with " + nm(c.obj), "", ' data-i="' + i + '" aria-pressed="false"')).join("") + A("done", "Declare attackers", "pri");
        break;
      case "blockers":
        body = (req.candidates || []).map((c, i) => '<label class="fbrow">' + esc(nm(c.obj)) + ' blocks <select data-fbsel="' + i + '"><option value="">nothing</option>' + (c.canBlock || []).map((a) => '<option value="' + esc(String(oid(a))) + '">' + esc(nm(a)) + "</option>").join("") + "</select></label>").join("") + A("done", "Declare blockers", "pri");
        break;
      case "confirm": body = A("yes", "Yes", "pri") + A("no", "No"); break;
      case "mulligan": body = A("keep", "Keep this hand", "pri") + A("mull", "Mulligan"); break;
      case "number": body = '<input class="fbnum" type="number" inputmode="numeric" min="' + req.min + '" max="' + req.max + '" value="' + value + '" aria-label="Number">' + A("done", "Confirm", "pri"); break;
      default: body = A("dflt", "Continue", "pri");
    }
    const rec = this.sheetHtml('<h2>' + esc(req.prompt || "Your decision") + '</h2><div class="fblist">' + body + "</div>", { cls: "picker fallback", dialog: true, label: "Decision" });
    const done = (ans) => { this.closeDialogSheets(); this.submit(ans); };
    const sync = () => { const b = rec.body.querySelector('[data-fb="done"]'); if (b && chk) b.disabled = !chk(); rec.body.querySelectorAll('[data-fb="tog"]').forEach((t) => { const on = sel.has(+t.dataset.i); t.classList.toggle("sel", on); t.setAttribute("aria-pressed", on); }); };
    rec.body.addEventListener("click", (e) => {
      const b = e.target.closest("[data-fb]"); if (!b) return;
      const k = b.dataset.fb, i = +b.dataset.i;
      if (k === "act") done({ type: "act", index: i });
      else if (k === "pass") done({ type: "pass" });
      else if (k === "tog") { if (sel.has(i)) sel.delete(i); else sel.add(i); sync(); }
      else if (k === "yes" || k === "no") done({ yes: k === "yes" });
      else if (k === "keep" || k === "mull") done({ keep: k === "keep" });
      else if (k === "dflt") done(this.fallbackAnswer(req));
      else if (k === "done") {
        if (req.kind === "choose") done({ chosen: [...sel] });
        else if (req.kind === "attackers") done({ attacks: [...sel].map((j) => ({ obj: req.candidates[j].obj, defender: req.candidates[j].defenders[0] })) });
        else if (req.kind === "blockers") done({ blocks: (req.candidates || []).map((c, j) => blocks[j] ? { obj: c.obj, attacker: (c.canBlock || []).find((a) => String(oid(a)) === blocks[j]) } : null).filter(Boolean) });
        else if (req.kind === "number") { const v = +rec.body.querySelector(".fbnum").value; done({ value: Math.max(req.min, Math.min(req.max, isNaN(v) ? req.min : v)) }); }
      }
    });
    rec.body.addEventListener("change", (e) => { const s2 = e.target.closest("[data-fbsel]"); if (s2) blocks[+s2.dataset.fbsel] = s2.value; });
    sync();
  },
  /* True when the human can currently see and act on the pending request. */
  presentable() {
    if (this.sheets.length) return true;
    const m = this.mode;
    if (!m) return false;
    const go = this.el.go;
    return !!(go && !go.hidden && go.offsetParent !== null);
  },
  startWatchdog(req) {
    clearTimeout(this._wd);
    const tick = () => {
      if (this.closed || !this._wait || this._wait.req !== req) return;
      if (!this.presentable()) { console.warn("watchdog: request not presentable", req.kind, req.reason); this.openFallback(req); }
      this._wd = setTimeout(tick, 2500);
    };
    this._wd = setTimeout(tick, 1500);
  },
  openPause() {
    if (this._pauseRec && this.sheets.indexOf(this._pauseRec) >= 0) { this.removeSheet(this._pauseRec); return; }
    const over = this.g.over;
    const html = '<h2>Paused</h2><div class="pmenu">' +
      '<button class="mbtn pri" data-act="close">Resume</button>' +
      '<button class="mbtn" data-act="openSettings">Settings</button>' +
      (!over ? '<button class="mbtn" data-act="pauseUndo"' + (this.canUndo() ? "" : " disabled") + ">Undo last action</button>" : "") +
      (!over && this._wait ? '<button class="mbtn" data-act="pauseFallback">Show options as a list</button>' : "") +
      '<button class="mbtn" data-act="pauseLog">Game log</button>' + (!over && this._wait && this.mode && this.mode.kind === "priority" ? '<button class="mbtn" data-act="pauseTools">Manual tools</button>' : "") + '<button class="mbtn" data-act="pauseEmote">Emote</button>' +
      (!over ? '<button class="mbtn danger" data-act="askConcede">Concede</button><button class="mbtn danger" data-act="askRestart">Restart match</button>' : "") +
      '<button class="mbtn" data-act="quit">Quit to lobby</button></div><p class="sub">Your match is saved automatically.</p>';
    this._pauseRec = this.sheetHtml(html, { cls: "small", label: "Paused" });
  },
  act_pauseFallback() { this.closeAllSheets(); this.openFallback(); },
  act_pauseUndo() { this.closeAllSheets(); this.undo(); },
  act_pauseEmote() { this.closeAllSheets(); this.openEmote(); },
  act_pauseLog() { this.closeAllSheets(); this.openLog(); },
  act_pauseTools() { this.closeAllSheets(); this.openTools(); },
  act_quit() { this.close("lobby"); },
  act_askConcede() {
    const rec = this.sheetHtml('<h2>Concede this match?</h2><p class="sub">You will lose and the result is recorded.</p><div class="sh-actions"><button class="mbtn" data-act="close">Keep playing</button><button class="mbtn pri danger-fill" data-act="doConcede">Concede</button></div>', { cls: "small", label: "Concede" });
    this._confirmRec = rec;
  },
  act_doConcede() { this.concedeNow(); },
  act_askRestart() {
    this.sheetHtml('<h2>Restart the match?</h2><p class="sub">The current game is abandoned (no result is recorded) and a new one starts with a fresh shuffle.</p><div class="sh-actions"><button class="mbtn" data-act="close">Cancel</button><button class="mbtn pri" data-act="doRestart">Restart</button></div>', { cls: "small", label: "Restart" });
  },
  act_doRestart() { this.closeAllSheets(); this.restart(); },

  openSettings() {
    this.closeAllSheets();
    const rec = this.sheetHtml("", { cls: "settings", label: "Settings" });
    this._setRec = rec;
    rec.onClose = () => { this._setRec = null; this.render(); };
    this.drawSettings();
  },
  act_openSettings() { this.openSettings(); },
  drawSettings() {
    const rec = this._setRec;
    if (!rec) return;
    const s = this.settings;
    const sw = (k, label, desc) => '<div class="srow"><div><b>' + label + "</b>" + (desc ? "<small>" + desc + "</small>" : "") + '</div><button class="tgl' + (s[k] ? " on" : "") + '" role="switch" aria-checked="' + !!s[k] + '" aria-label="' + label + '" data-act="setTgl" data-k="' + k + '"><i></i></button></div>';
    const seg = (k, label, opts) => '<div class="srow col"><b>' + label + '</b><div class="segm" role="group" aria-label="' + label + '">' + opts.map((o) => '<button data-act="setVal" data-k="' + k + '" data-v="' + o[0] + '" aria-pressed="' + (s[k] === o[0]) + '">' + o[1] + "</button>").join("") + "</div></div>";
    const stops = SETTING_STEPS.map(([k, l]) => '<tr><th scope="row">' + l + '</th><td><input type="checkbox" data-act="setStop" data-side="my" data-k="' + k + '"' + (s.stops.my[k] ? " checked" : "") + ' aria-label="Stop at ' + l + ' on my turn"></td><td><input type="checkbox" data-act="setStop" data-side="opp" data-k="' + k + '"' + (s.stops.opp[k] ? " checked" : "") + ' aria-label="Stop at ' + l + ' on opponent turn"></td></tr>').join("");
    rec.body.innerHTML = "<h2>Settings</h2>" +
      sw("sound", "Sound effects") +
      '<div class="srow col"><b>Volume</b><input class="vol" type="range" min="0" max="100" value="' + Math.round((s.volume == null ? 0.6 : s.volume) * 100) + '" aria-label="Volume"></div>' +
      sw("haptics", "Vibration", "Small buzzes on damage, where the device supports it") +
      seg("speed", "Animation speed", [["slow", "Slow"], ["normal", "Normal"], ["fast", "Fast"]]) +
      sw("reduceMotion", "Reduce motion", "Skips flights and floating numbers") +
      seg("cardSize", "Card size", [["s", "Small"], ["m", "Medium"], ["l", "Large"]]) +
      sw("fullControl", "Full control", "Stop at every priority, even with nothing to do") +
      sw("holdOwn", "Stop on my own spells", "Get priority to respond after you cast") +
      '<div class="srow col"><b>Stops</b><small>Pause at these steps when you could act. Your main phases always stop when you have a play.</small>' +
      '<table class="stops"><thead><tr><th></th><th>My turn</th><th>Their turn</th></tr></thead><tbody>' + stops + '</tbody></table></div><div class="sh-actions"><button class="mbtn pri" data-act="close">Done</button></div>';
    const vol = rec.body.querySelector(".vol");
    vol.addEventListener("input", () => { s.volume = +vol.value / 100; this.saveSettings(); });
    vol.addEventListener("change", () => this.sound.play("resolve"));
    rec.body.querySelectorAll('input[type="checkbox"]').forEach((cb) => cb.addEventListener("change", () => { s.stops[cb.dataset.side][cb.dataset.k] = cb.checked; this.saveSettings(); this.renderPhases(); }));
  },
  act_setTgl(el) {
    const k = el.dataset.k; this.settings[k] = !this.settings[k]; this.saveSettings();
    if (k === "sound" && this.settings.sound) { this.sound.unlock(); this.sound.play("resolve"); }
    this.drawSettings(); this.renderBar();
  },
  act_setVal(el) {
    const k = el.dataset.k; this.settings[k] = el.dataset.v; this.saveSettings();
    if (k === "cardSize") { this.root.dataset.size = el.dataset.v; this.layout(); }
    this.drawSettings();
  },
  act_setStop() { /* handled by change listeners */ },

  /* ---------- log / zones / tools / emotes / player ---------- */
  openLog() {
    const rec = this.sheetHtml('<h2>Game log</h2><div class="logsheet" tabindex="0"></div>', { cls: "tall", label: "Game log" });
    const box = rec.body.querySelector(".logsheet");
    this.logLines.forEach((l) => this.logAppend(box, l));
    box.scrollTop = box.scrollHeight;
    this._logSheet = box;
    rec.onClose = () => { this._logSheet = null; };
  },
  openZone(p, z) {
    const P = this.player(p);
    const ids = P[z].slice().reverse();
    const title = (p === this.me ? "Your " : "Opponent’s ") + z;
    const rec = this.sheetHtml("<h2>" + esc(title) + '</h2><p class="sub">' + ids.length + (ids.length === 1 ? " card" : " cards") + (z === "graveyard" ? ", most recent first" : "") + '</p><div class="zgrid"></div>', { cls: "tall", label: title });
    const grid = rec.body.querySelector(".zgrid");
    if (!ids.length) grid.innerHTML = '<p class="zmuted">Empty.</p>';
    ids.forEach((id) => {
      const o = this.obj(id); if (!o || !o.c) return;
      const w = document.createElement("div");
      w.className = "zg"; w.dataset.cid = id; w.setAttribute("role", "button"); w.tabIndex = 0; w.setAttribute("aria-label", o.c.name);
      const glow = this.ctx && this.ctx.glow.has(id);
      if (glow) w.classList.add("glow");
      w.appendChild(cardFromObj(o, "small"));
      grid.appendChild(w);
    });
  },
  openTools() {
    const m = this.mode;
    const acts = m && m.kind === "priority" && this._wait ? (m.req.actions || []).map((a, i) => ({ a, i })).filter((x) => x.a.type === "special") : [];
    const GROUPS = [["Players", ["life", "cmdDamage", "mana", "draw", "discard", "mill", "shuffle"]], ["Permanents", ["tap", "counters", "token", "control", "sacrifice", "destroy"]], ["Cards & zones", ["exile", "bounce", "graveyard", "library", "move"]]];
    const by = new Map(acts.map((x) => [x.a.variant, x]));
    const used = new Set();
    const btn = (x) => { used.add(x.a.variant); return '<button class="mbtn tool" data-act="toolGo" data-i="' + x.i + '">' + esc(cap(String(x.a.label).replace(/^Manual:\s*/, ""))) + "</button>"; };
    let body = "";
    GROUPS.forEach(([title, vs]) => {
      const list = vs.map((v) => by.get(v)).filter(Boolean);
      if (list.length) body += '<h3 class="tgh">' + esc(title) + '</h3><div class="tgrid">' + list.map(btn).join("") + "</div>";
    });
    const rest = acts.filter((x) => !used.has(x.a.variant));
    if (rest.length) body += '<h3 class="tgh">Other</h3><div class="tgrid">' + rest.map(btn).join("") + "</div>";
    const html = "<h2>Manual tools</h2>" + (acts.length ? '<p class="sub">A safety net: every card in your decks is automated, but you can still fix anything by hand. Each tool is recorded, so undo and resume still work.</p>' + body : '<p class="sub">Manual tools are available whenever you have priority.</p>');
    this.sheetHtml(html, { cls: "tall tools", label: "Manual tools" });
  },
  act_toolGo(el) { this.closeAllSheets(); this.submit({ type: "act", index: +el.dataset.i }); },
  openEmote() {
    const html = '<h2>Emote</h2><div class="emotes">' + EMOTES.map((t, i) => '<button class="mbtn" data-act="emoteGo" data-i="' + i + '">' + esc(t) + "</button>").join("") + "</div>";
    this.sheetHtml(html, { cls: "small", label: "Emote" });
  },
  act_emoteGo(el) {
    const t = EMOTES[+el.dataset.i];
    this.closeAllSheets();
    this.emote(this.me, t);
    if (Math.random() < 0.5) this.emoteAI(t === "Hello!" ? "Hello!" : t === "Good game" ? "Good game" : "Nice!");
  },
  openPlayer(p) {
    const P = this.player(p), info = p === this.me ? this.setup.you : this.setup.opp;
    const cd = P.commanderDamage || {};
    const rows = [["Life", this.disp.life[p]], ["Library", P.library.length], ["Hand", P.hand.length], ["Graveyard", P.graveyard.length], ["Exile", P.exile.length]];
    if (P.poison) rows.push(["Poison", P.poison + " / 10"]);
    Object.keys(cd).forEach((k) => { if (cd[k]) rows.push(["Commander damage taken", cd[k] + " / 21"]); });
    if (P.ring && P.ring.level) rows.push(["Ring level", P.ring.level]);
    this.sheetHtml("<h2>" + esc((info && info.name) || P.name) + '</h2><dl class="pstat">' + rows.map((r) => "<dt>" + esc(r[0]) + "</dt><dd class=\"num\">" + esc(r[1]) + "</dd>").join("") + "</dl>", { cls: "small", label: "Player" });
  },

  /* ---------- intro & game over ---------- */
  intro() {
    return new Promise((resolve) => {
      const S = this.S;
      const mk = (p) => { const info = p === this.me ? this.setup.you : this.setup.opp; const cmd = S.players[p].commanders.length ? this.obj(S.players[p].commanders[0]) : null; return { name: (info && info.name) || S.players[p].name, art: (cmd && cmd.c.img) || (info && info.art) || "", cmd: cmd ? cmd.c.name : "" }; };
      const a = mk(this.me), b = mk(this.opp);
      const first = S.active === this.me ? "You go first" : "Opponent goes first";
      const side = (x, cls) => '<div class="ivs ' + cls + '"><div class="ia" style="' + (x.art ? "background-image:url(&quot;" + esc(artCrop(x.art)) + "&quot;)" : "") + '"><span>' + esc((x.cmd || x.name).charAt(0)) + '</span></div><b>' + esc(x.cmd || x.name) + "</b><small>" + esc(x.name) + "</small></div>";
      const rec = this.sheetHtml('<div class="intro">' + side(b, "opp") + '<div class="vs">VS</div>' + side(a, "me") + '<div class="coin"><i></i><span>' + first + '</span></div><button class="mbtn" data-act="introSkip">Tap to begin</button></div>', { cls: "introsheet", modal: true, full: true, label: "Match start", noFocus: true });
      let done = false;
      const fin = () => { if (done) return; done = true; this._introFin = null; rec.modal = false; this.removeSheet(rec); resolve(); };
      this._introFin = fin;
      setTimeout(fin, this.rm ? 600 : 3000 * this.spd() + 400);
    });
  },
  act_introSkip() { if (this._introFin) this._introFin(); },

  showOver(result, ev) {
    this.overDone = true;
    const T = this.tally, S = this.S;
    const head = result === "win" ? "Victory" : result === "loss" ? "Defeat" : "Draw";
    const why = this.reasonText(ev);
    const stat = (k, v) => '<div class="st"><b class="num">' + v + "</b><span>" + k + "</span></div>";
    const html = '<div class="over ' + result + '"><div class="ov-h">' + head + '</div><p class="ov-r">' + (why ? esc(cap(why)) : "") + "</p>" +
      '<div class="stats">' + stat("Turns", S.turn) + stat("Your life", S.players[this.me].life) + stat("Their life", S.players[this.opp].life) + stat("Damage dealt", T.dmgDealt) + stat("Damage taken", T.dmgTaken) + stat("Spells cast", T.spells) + "</div>" +
      '<div class="sh-actions col"><button class="mbtn pri" data-act="rematch">Rematch</button><button class="mbtn" data-act="lobby">Change decks</button><button class="mbtn" data-act="app">Back to app</button></div></div>';
    this.sheetHtml(html, { cls: "oversheet", modal: true, full: true, label: head, noFocus: false });
  },
  act_rematch() { this.sheets.slice().forEach((r) => { r.modal = false; this.removeSheet(r); }); this.restart(); },
  act_lobby() { this.close("lobby"); },
  act_app() { this.close("app"); },
};

function clampN(v, a, b) { return Math.max(a, Math.min(b, v)); }
import { setLive } from "./ui-card.js";
function setLiveSafe(card, o) { try { setLive(card, o); } catch (e) { /* ignore */ } }
