/* The match: a full-screen overlay that renders any object satisfying the SPEC section 1 game API
   and drives it (human answers from the UI, AI answers from decide()).
   Rendering is diffed by object id: stable elements, FLIP moves, no full re-render per event. */

import { esc, oid, cap, manaHtml, textHtml, makeCard, fillCard, setLive, viewOfObj, viewOfData, artCrop, imgSize } from "./ui-card.js";
import { createSound } from "./ui-sound.js";
import { saveSettings, writeSave, clearSave, recordResult, DEFAULT_STOPS } from "./ui-store.js";
import { sheetMethods } from "./ui-sheets.js";

const CANCEL = Symbol("cancel");
const SVGNS = "http://www.w3.org/2000/svg";
const PHASES = [
  ["untap", "Untap", ["untap"]], ["upkeep", "Upkeep", ["upkeep"]], ["draw", "Draw", ["draw"]], ["main1", "Main 1", ["main1"]],
  ["combat", "Combat", ["beginCombat", "declareAttackers", "declareBlockers", "combatDamage", "endCombat"]],
  ["main2", "Main 2", ["main2"]], ["end", "End", ["end", "cleanup"]],
];
const STOP_KEYS = { upkeep: ["upkeep"], draw: ["draw"], main1: ["main1"], combat: ["beginCombat", "declareAttackers", "declareBlockers"], main2: ["main2"], end: ["end"] };
const STEP_NEXT = { main1: "to combat", beginCombat: "to attackers", declareAttackers: "to blockers", declareBlockers: "to damage", combatDamage: "to end of combat", endCombat: "to main 2", main2: "to end step", end: "to cleanup", upkeep: "to draw", draw: "to main 1" };
const SPEED = { slow: 1.7, normal: 1, fast: 0.4 };

const IC = {
  lib: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="3.5" width="12" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 7v12.5A1.5 1.5 0 0 0 5.5 21H15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  gy: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V10a6 6 0 0 1 12 0v11z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 8v6M9.5 10.5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  ex: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 4.5v15M4.5 12h15" stroke="currentColor" stroke-width="1.8" stroke-dasharray="2 3" stroke-linecap="round"/></svg>',
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  log: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14M5 10h14M5 15h9M5 20h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  undo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 4 12l5 5M4 12h10a6 6 0 0 1 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  emote: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M8.5 14.2c1.8 2 5.2 2 7 0M9 9.6v.6M15 9.6v.6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  skip: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6l8 6-8 6zM15 6l8 6-8 6z" fill="currentColor" transform="scale(.92) translate(1 1)"/></svg>',
  tools: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 6.5a4 4 0 0 0 4.9 4.9L21 13l-3 3-1.6-1.6M3 21l9-9 3 3-9 9z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  cmd: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.6 5.6 6 .8-4.4 4.2 1.1 6L12 16.7 6.7 19.6l1.1-6L3.4 9.4l6-.8z" fill="currentColor"/></svg>',
};
export { IC };

export const isMeaningful = (a) => a && !a.mana && a.type !== "special";
const lc = (x) => String(x || "").toLowerCase();

export class Match {
  constructor(o) {
    this.o = o;
    this.factory = o.factory;
    this.decideFn = o.decide;
    this.setup = o.setup;
    this.seed = o.seed;
    this.settings = o.settings;
    this.me = 0;
    this.opp = 1;
    this.epoch = 0;
    this.closed = false;
    this.tiles = new Map();      // group key -> tile element
    this.idTile = new Map();     // obj id -> tile element
    this.handEls = new Map();
    this.stackEls = new Map();
    this.cmdEls = new Map();
    this.attEls = new Map();
    this.rects = new Map();
    this.disp = { life: [0, 0], step: "main1", active: 0, turn: 1 };
    this.logLines = [];
    this.marks = [];
    this.who = [];
    this.arrows = [];
    this.mode = null;
    this.req = null;
    this.skipTurn = false;
    this.seenStack = new Set();
    this.sheets = [];
    this.tally = { dmgDealt: 0, dmgTaken: 0, myDeaths: 0, oppDeaths: 0, spells: 0, drawn: 0 };
    this.sound = createSound(() => this.settings);
    this.mqRM = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
    this.resultDone = false;
  }

  get S() { return this.g.state; }
  get rm() { return this.settings.reduceMotion || this.mqRM.matches; }
  obj(id) { return this.S.objects[oid(id)]; }
  player(i) { return this.S.players[i]; }
  spd() { return this.rm ? 0 : SPEED[this.settings.speed] != null ? SPEED[this.settings.speed] : 1; }

  /* ================= lifecycle ================= */
  async open(restoring) {
    this.buildDom();
    document.body.appendChild(this.root);
    document.documentElement.classList.add("mp-lock");
    this.bindGlobal();
    this.resize();
    this.root.classList.add("loading");
    this.setToast = null;
    try {
      this.g = this.factory(this.setup, this.seed);
      this.g.start();
      this.who = [];
      if (this.o.answers && this.o.answers.length) this.replay(this.o.answers.slice());
    } catch (e) {
      console.error(e);
      this.root.classList.remove("loading");
      this.fatal("The match could not be " + (restoring ? "restored" : "started") + ": " + (e && e.message ? e.message : e));
      return;
    }
    this.syncDisp();
    this.render(true);
    this.root.classList.remove("loading");
    if (!restoring) await this.intro();
    this.run();
  }

  /* Re-feed saved answers, noting who answered each one. Events are drained and discarded. */
  replay(answers) {
    for (const a of answers) {
      if (this.g.over || !this.g.request) break;
      const req = this.g.request;
      const before = this.g.answers.length;
      this.g.respond(a);
      this.who.push(req.player === this.me ? "h" : "a");
      const evs = this.g.drainEvents();
      if (req.player === this.me) this.marks.push({ i: before, locked: false });
      this.noteMarks(evs);
      evs.forEach((e) => { if (e.text) this.logPush(e); });
    }
    this.g.drainEvents();
  }

  fatal(msg) {
    this.sheetHtml('<h2>Something went wrong</h2><p class="msg">' + esc(msg) + '</p><div class="sh-actions"><button class="mbtn pri" data-act="quit">Back to lobby</button></div>', { modal: true, cls: "small" });
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    this.epoch++;
    if (this._wait) { const w = this._wait; this._wait = null; w.resolve(CANCEL); }
    this.unbindGlobal();
    document.documentElement.classList.remove("mp-lock");
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
    if (this.pushed) { this.pushed = false; this.ignorePop = true; try { history.back(); } catch (e) { /* ignore */ } }
    if (this.o.onExit) this.o.onExit(reason || "lobby", this);
  }

  /* ================= DOM ================= */
  stripHtml(p) {
    return '<header class="strip ' + (p === this.me ? "me" : "opp") + '" data-p="' + p + '">' +
      '<button class="av" data-act="avatar" data-p="' + p + '" aria-label="' + (p === this.me ? "Your" : "Opponent") + ' status"><span class="av-img"></span><span class="av-ini"></span></button>' +
      '<div class="life" data-p="' + p + '" aria-live="off"><b class="lv num"></b></div>' +
      '<div class="smeta"><div class="nm"></div><div class="zones">' +
      ["library", "graveyard", "exile"].map((z) => '<button class="zone z-' + z + '" data-act="zone" data-p="' + p + '" data-z="' + z + '" aria-label="' + cap(z) + '">' + (z === "library" ? IC.lib : z === "graveyard" ? IC.gy : IC.ex) + '<b class="num">0</b></button>').join("") +
      '</div><div class="pool"></div></div>' +
      (p === this.opp ? '<div class="ohand" aria-label="Opponent hand"></div>' : "") +
      '<div class="cmdz" data-p="' + p + '"></div></header>';
  }

  buildDom() {
    const r = (this.root = document.createElement("div"));
    r.className = "mp";
    r.setAttribute("role", "dialog");
    r.setAttribute("aria-label", "Match");
    r.dataset.size = this.settings.cardSize || "m";
    r.innerHTML =
      '<div class="mp-board">' +
      this.stripHtml(this.opp) +
      '<section class="bf opp-bf" data-p="1" aria-label="Opponent battlefield"><div class="row lands"></div><div class="row perm"></div></section>' +
      '<div class="mid"><div class="phases" role="group" aria-label="Turn phases"></div><div class="turnl"></div><div class="think" hidden><i></i><i></i><i></i><span>Opponent is thinking</span></div></div>' +
      '<section class="bf me-bf" data-p="0" aria-label="Your battlefield"><div class="row perm"></div><div class="row lands"></div></section>' +
      this.stripHtml(this.me) +
      '<div class="hand" aria-label="Your hand"></div>' +
      '<footer class="bar"><div class="rbs">' +
      '<button class="rb" data-act="menu" aria-label="Menu">' + IC.menu + '</button>' +
      '<button class="rb" data-act="log" aria-label="Game log">' + IC.log + '</button>' +
      '<button class="rb" data-act="undo" aria-label="Undo last action">' + IC.undo + '</button>' +
      '<button class="rb" data-act="emote" aria-label="Emote">' + IC.emote + '</button>' +
      '<button class="rb" data-act="tools" aria-label="Manual tools" hidden>' + IC.tools + '</button>' +
      '<button class="rb" data-act="passTurn" aria-label="Pass until end of turn">' + IC.skip + '</button>' +
      '</div><button class="go" data-act="go"><span class="go-l">Pass</span><small class="go-s"></small></button></footer>' +
      '</div>' +
      '<aside class="logpanel" aria-label="Game log"><div class="lp-head">Game log</div><div class="lp-body"></div></aside>' +
      '<div class="stackbox" hidden></div>' +
      '<svg class="arrows" aria-hidden="true"><defs>' +
      ["atk", "blk", "tgt", "sel"].map((c) => '<marker id="mk-' + c + '" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" class="ah ah-' + c + '"/></marker>').join("") +
      '</defs><g class="ag"></g></svg>' +
      '<div class="fx"></div><div class="prompt" hidden></div><div class="toasts" aria-live="polite"></div><div class="banner" hidden></div><div class="mp-layer"></div>';
    const q = (s) => r.querySelector(s);
    this.el = {
      board: q(".mp-board"), phases: q(".phases"), turnl: q(".turnl"), think: q(".think"), hand: q(".hand"), go: q(".go"), goL: q(".go-l"), goS: q(".go-s"),
      stackbox: q(".stackbox"), arrows: q(".arrows"), ag: q(".ag"), fx: q(".fx"), prompt: q(".prompt"), toasts: q(".toasts"), banner: q(".banner"), layer: q(".mp-layer"),
      undo: q('[data-act="undo"]'), tools: q('[data-act="tools"]'), logBody: q(".lp-body"), pass: q('[data-act="passTurn"]'),
    };
    [this.me, this.opp].forEach((p) => {
      const s = r.querySelector('.strip[data-p="' + p + '"]');
      const bf = r.querySelector('.bf[data-p="' + p + '"]');
      this["s" + p] = {
        strip: s, av: s.querySelector(".av-img"), ini: s.querySelector(".av-ini"), life: s.querySelector(".lv"), lifeBox: s.querySelector(".life"), nm: s.querySelector(".nm"),
        lib: s.querySelector(".z-library b"), gy: s.querySelector(".z-graveyard b"), ex: s.querySelector(".z-exile b"),
        libB: s.querySelector(".z-library"), gyB: s.querySelector(".z-graveyard"), exB: s.querySelector(".z-exile"),
        pool: s.querySelector(".pool"), ohand: s.querySelector(".ohand"), cmdz: s.querySelector(".cmdz"), avB: s.querySelector(".av"),
        bf, perm: bf.querySelector(".perm"), lands: bf.querySelector(".lands"),
      };
    });
    this.phaseEls = {};
    this.el.phases.innerHTML = PHASES.map((p) => '<button class="ph" data-act="stop" data-ph="' + p[0] + '" aria-label="' + p[1] + ' (tap to toggle a stop)"><span>' + p[1] + "</span></button>").join("");
    PHASES.forEach((p) => { this.phaseEls[p[0]] = this.el.phases.querySelector('[data-ph="' + p[0] + '"]'); });
  }

  /* ================= global bindings ================= */
  bindGlobal() {
    this.onResize = () => this.resize();
    window.addEventListener("resize", this.onResize);
    window.addEventListener("orientationchange", this.onResize);
    this.ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => this.resize()) : null;
    if (this.ro) this.ro.observe(this.root);
    this.onKey = (e) => this.keydown(e);
    document.addEventListener("keydown", this.onKey, true);
    this.onPop = () => {
      if (this.ignorePop) { this.ignorePop = false; return; }
      if (this.closed) return;
      try { history.pushState({ mtgGame: 1 }, "", location.href); } catch (e) { /* ignore */ }
      if (!this.sheets.length) this.openPause(); else this.closeTopSheet();
    };
    try { history.pushState({ mtgGame: 1 }, "", location.href); this.pushed = true; } catch (e) { this.pushed = false; }
    window.addEventListener("popstate", this.onPop);
    this.root.addEventListener("click", (e) => this.onClick(e));
    this.root.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.root.addEventListener("contextmenu", (e) => { const c = e.target.closest("[data-cid]"); if (c) { e.preventDefault(); this.openZoom(c.dataset.cid.split(",")); } });
    this.onVis = () => { if (document.visibilityState === "hidden") this.persist(); };
    document.addEventListener("visibilitychange", this.onVis);
    // first gesture unlocks audio
    this.root.addEventListener("pointerdown", () => this.sound.unlock(), { once: true });
  }
  unbindGlobal() {
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("orientationchange", this.onResize);
    window.removeEventListener("popstate", this.onPop);
    document.removeEventListener("keydown", this.onKey, true);
    document.removeEventListener("visibilitychange", this.onVis);
    if (this.ro) this.ro.disconnect();
  }

  keydown(e) {
    if (this.closed) return;
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      if (this.sheets.length) { this.closeTopSheet(); return; }
      if (this.mode && this.mode.kind === "choose" && this.mode.req.min === 0) { this.goAction(); return; }
      this.openPause();
      return;
    }
    if (inField) return;
    if (e.key === " " || e.key === "Enter") {
      const t = e.target;
      if (t && t.closest && t.closest("button, a, [role=button]") && t.closest(".mp") && e.key === "Enter") return;
      if (t && t.closest && t.closest(".mp-layer")) return;
      if (this.sheets.length) return;
      e.preventDefault();
      this.goAction();
    } else if (e.key === "z" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.undo(); }
  }

  resize() {
    if (this.closed) return;
    const w = window.innerWidth, h = window.innerHeight;
    const orient = w >= 1000 && h >= 620 ? "wide" : w > h * 1.15 && h < 600 ? "land" : "port";
    this.root.dataset.orient = orient;
    this.layout();
    this.drawArrows();
  }

  /* ================= pump ================= */
  sleep(ms) {
    const t = ms * this.spd();
    if (t <= 4 || this.skipFx) return Promise.resolve();
    return new Promise((r) => setTimeout(r, t));
  }
  tick() { return new Promise((r) => setTimeout(r, 0)); }

  async run() {
    if (this.running) return;
    this.running = true;
    const ep = this.epoch;
    let spin = 0;
    try {
      while (ep === this.epoch && !this.closed) {
        await this.flush();
        if (ep !== this.epoch) return;
        const g = this.g;
        if (g.over || !g.request) { await this.finish(); return; }
        const req = g.request;
        this.req = req;
        if (req.player !== this.me) { await this.aiStep(req, ep); if (++spin % 25 === 0) await this.tick(); continue; }
        const auto = this.skipAutoOnce ? null : this.autoAnswer(req);
        this.skipAutoOnce = false;
        if (auto) { await this.autoStep(auto, req, ep); if (++spin % 25 === 0) await this.tick(); continue; }
        this.setThinking(false);
        const ans = await this.askHuman(req);
        if (ep !== this.epoch || ans === CANCEL) return;
        this.applyHuman(ans, req);
      }
    } catch (err) {
      console.error(err);
      if (!this.closed) this.fatal("The game hit an error: " + (err && err.message ? err.message : err));
    } finally {
      if (ep === this.epoch) this.running = false;
    }
  }

  restartPump() {
    this.epoch++;
    this.running = false;
    if (this._wait) { const w = this._wait; this._wait = null; w.resolve(CANCEL); }
    this.run();
  }

  async flush() {
    const g = this.g;
    const evs = g.drainEvents();
    if (evs.length) {
      this.noteMarks(evs);
      this.beginBatch(evs);
      this.render();
      await this.playEvents(evs);
      this.endBatch();
    } else {
      this.syncDisp();
      this.render();
    }
  }

  /* ----- AI ----- */
  async aiStep(req, ep) {
    this.setThinking(true);
    this.mode = null;
    let ans;
    const t0 = performance.now();
    await this.tick();
    try { ans = this.decideFn(this.g, req, { difficulty: this.setup.difficulty || "normal" }); } catch (e) { console.error("AI decide failed", e); ans = null; }
    const took = performance.now() - t0;
    const isPass = req.kind === "priority" && ans && ans.type === "pass";
    const base = req.kind === "priority" ? (isPass ? 90 : 520) : req.kind === "attackers" ? 700 : req.kind === "blockers" ? 450 : 260;
    await this.sleep(Math.max(0, base - took));
    if (ep !== this.epoch || this.closed) return;
    if (ans == null || !this.tryRespond(ans)) {
      const fb = this.fallbackAnswer(req);
      if (!this.tryRespond(fb)) {
        this.setThinking(false);
        this.fatal("The AI gave an answer the engine rejected (" + req.kind + "). You can quit to the lobby and start a new match.");
        this.epoch++; // stop the pump
        return;
      }
    }
    this.who.push("a");
  }
  tryRespond(ans) {
    try { this.g.respond(ans); return true; } catch (e) { console.warn("respond rejected", e && e.message, ans); return false; }
  }
  fallbackAnswer(req) {
    switch (req.kind) {
      case "priority": return { type: "pass" };
      case "choose": return { chosen: req.options.slice(0, req.min).map((_, i) => i) };
      case "confirm": return { yes: false };
      case "number": return { value: req.min };
      case "mulligan": return { keep: true };
      case "attackers": return { attacks: [] };
      case "blockers": return { blocks: [] };
      default: return {};
    }
  }
  setThinking(on) {
    if (this._think === on) return;
    this._think = on;
    this.el.think.hidden = !on;
    this.root.classList.toggle("thinking", on);
  }

  /* ----- auto-pass ----- */
  autoAnswer(req) {
    if (req.kind === "attackers" && !(req.candidates || []).length) return { attacks: [] };
    if (req.kind === "blockers" && !(req.candidates || []).length) return { blocks: [] };
    if (req.kind !== "priority") return null;
    const S = this.S, st = this.settings;
    const meaningful = (req.actions || []).some(isMeaningful);
    const pass = { type: "pass" };
    if (st.fullControl) return null;
    const topId = S.stack.length ? S.stack[S.stack.length - 1] : null;
    const top = topId ? this.obj(topId) : null;
    if (this.skipTurn) {
      if (top && top.controller !== this.me && !this.seenStack.has(top.id) && meaningful) { this.seenStack.add(top.id); this.skipTurn = false; return null; }
      return pass;
    }
    if (!meaningful) return pass;
    if (top) {
      if (top.controller !== this.me) return null;
      return st.holdOwn ? null : pass;
    }
    const mine = S.active === this.me;
    const stops = (mine ? st.stops.my : st.stops.opp) || {};
    if (stops[S.step]) {
      if (!mine && S.step === "declareAttackers" && !(S.combat && S.combat.attackers && S.combat.attackers.length)) return pass;
      return null;
    }
    return pass;
  }
  async autoStep(ans, req, ep) {
    const stackBusy = this.S.stack.length > 0;
    this.setThinking(false);
    this.mode = null;
    await this.sleep(stackBusy ? 520 : 70);
    if (ep !== this.epoch || this.closed) return;
    if (!this.tryRespond(ans)) { this.skipAutoOnce = true; return; }
    this.who.push("a");
  }

  /* ----- human ----- */
  askHuman(req) {
    this.mode = this.makeMode(req);
    return new Promise((resolve) => {
      this._wait = { resolve, req };
      this.skipFx = false;
      this.enterMode();
    });
  }
  submit(ans) {
    const w = this._wait;
    if (!w) return;
    this._wait = null;
    w.resolve(ans);
  }
  applyHuman(ans, req) {
    const before = this.g.answers.length;
    try {
      this.g.respond(ans);
    } catch (e) {
      this.sound.play("error");
      this.toast((e && e.message) || "That isn't allowed.", { warn: true });
      return false;
    }
    this.who.push("h");
    this.marks.push({ i: before, locked: false });
    this.mode = null;
    this.persist();
    return true;
  }
  persist() {
    if (this.g && !this.g.over) {
      writeSave({ setup: this.setup, seed: this.seed, answers: this.g.answers.slice(), turn: this.S.turn, ts: Date.now(), life: [this.S.players[0].life, this.S.players[1].life], v: 1 });
    }
  }
  noteMarks(evs) {
    const top = this.marks[this.marks.length - 1];
    if (!top) return;
    for (const e of evs) if ((e.t === "draw" && e.player === this.me) || e.t === "reveal" || (e.t === "shuffle" && e.player === this.me)) { top.locked = true; break; }
  }

  /* ================= undo / restart ================= */
  canUndo() {
    if (!this.g || this.g.over || !this.marks.length) return false;
    const top = this.marks[this.marks.length - 1];
    return !top.locked && !!this._wait;
  }
  undo() {
    if (!this.canUndo()) { this.toast("Can't undo: cards were drawn or revealed.", { warn: true }); return; }
    const top = this.marks[this.marks.length - 1];
    const keep = this.g.answers.slice(0, top.i);
    this.rebuild(keep, this.marks.slice(0, -1).map((m) => ({ i: m.i, locked: m.locked })));
  }
  rebuild(answers, marksKeep) {
    this.epoch++;
    this.running = false;
    if (this._wait) { const w = this._wait; this._wait = null; w.resolve(CANCEL); }
    this.closeAllSheets();
    this.mode = null;
    try {
      this.g = this.factory(this.setup, this.seed);
      this.g.start();
      this.marks = []; this.who = [];
      this.replay(answers);
      if (marksKeep) { /* replay recomputes marks, which are authoritative */ }
    } catch (e) { console.error(e); this.fatal("Could not rewind: " + e.message); return; }
    this.skipAutoOnce = true;
    this.skipTurn = false;
    this.clearFxLayer();
    this.syncDisp();
    this.render(true);
    this.persist();
    this.run();
  }
  restart(seed) {
    this.seed = seed != null ? seed : (Date.now() % 2147483647);
    this.setup = Object.assign({}, this.setup);
    this.resultDone = false;
    this.logLines = []; this.el.logBody.innerHTML = "";
    this.tally = { dmgDealt: 0, dmgTaken: 0, myDeaths: 0, oppDeaths: 0, spells: 0, drawn: 0 };
    clearSave();
    this.rebuild([], []);
  }
  concedeNow() {
    this.closeAllSheets();
    try { this.g.concede(this.me); } catch (e) { console.error(e); }
    this.mode = null;
    if (this._wait) { const w = this._wait; this._wait = null; w.resolve({ type: "pass" }); this.epoch++; this.running = false; }
    this.run();
  }

  /* ================= game over ================= */
  async finish() {
    if (this.resultDone) return;
    this.resultDone = true;
    this.setThinking(false);
    this.mode = null;
    this.el.prompt.hidden = true;
    const g = this.g;
    const win = g.winner === this.me, draw = g.winner == null;
    const reasonEv = this.lastEnd || {};
    const result = win ? "win" : draw ? "draw" : "loss";
    clearSave();
    recordResult({ deckId: this.setup.deckId, deckName: this.setup.you && this.setup.you.name, oppName: this.setup.opp && this.setup.opp.name, result, turns: this.S.turn, reason: reasonEv.reason || "", difficulty: this.setup.difficulty });
    this.sound.play(win ? "win" : "lose");
    this.sound.buzz(win ? [40, 60, 40] : 120);
    if (!this.overDone) this.emoteAI(win ? "Good game" : "Nice!");
    await this.sleep(700);
    this.showOver(result, reasonEv);
    this.render();
  }
  reasonText(ev) {
    if (!ev) return "";
    const map = { life: "life total reached 0", concede: "conceded", decked: "drew from an empty library", poison: "ten poison counters", commander: "21 commander damage" };
    return map[ev.reason] || ev.reason || ev.text || "";
  }
}

Object.assign(Match.prototype, sheetMethods);
import { renderMethods } from "./ui-render.js";
Object.assign(Match.prototype, renderMethods);
import { fxMethods } from "./ui-fx.js";
Object.assign(Match.prototype, fxMethods);
import { inputMethods } from "./ui-input.js";
Object.assign(Match.prototype, inputMethods);
