// engine.js — Binder "play vs AI" rules engine. Pure ES module, zero deps, deterministic (seeded RNG only).
//
// Public API (SPEC §1):  createGame({players, options, compile}) -> game
//   game.start() / game.request / game.respond(answer) / game.state / game.drainEvents() / game.over / game.winner
//   game.concede(i) / game.answers / game.rng()   — plus the §7 script API (g.obj, g.find, g.choose$, ...).
//   game.error: the Error that aborted the game (engine bug), else null. game.legalActions(p): Action[] (internal form).
//
// Helper exports for AI/UI:
//   STEPS                       ordered step names
//   parseManaCost(str)          "{2}{B}{R/G}{B/P}{X}" -> {generic,W,U,B,R,G,C,hybrid:[[..]],phyrexian:[..],x,snow}
//   costToString(parsed)        inverse of parseManaCost (display)
//   costCmc(parsedOrStr)        mana value of a cost
//   canPay(game, p, costStr)    can player p pay this mana cost now (pool + untapped sources)?
//   spellCostFor(game, p, objId, variant?) -> parsed cost incl. tax/reductions (or null)
//   manaAvailable(game, p)      upper bound of mana p could make right now (pool + sources)
//   describeCost(cost)          Cost object -> short text
//   TOKENS                      predefined token defs (treasure, food, clue, blood, map, eldrazi scion/spawn)
//   makeRng(seed)               the engine's PRNG
//   isPermanentCard(def), hasType(c, type)
//
// Extra event type beyond §4: `log{text}` (plain log line, e.g. from g.log or scry/surveil summaries).
// respond() also accepts { concede: playerIdx } (recorded in answers so replays reproduce it).

import { STEPS, makeRng, parseManaCost, costToString, costCmc, normalizeDef, fallbackDef, tokenDef, TOKENS, poolTotal, poolToString, PERMANENT_TYPES, cap, hashStr } from "./engine-util.js";
import { charMethods, hasType } from "./engine-chars.js";
import { manaMethods } from "./engine-mana.js";
import { effectMethods, describeCost } from "./engine-effects.js";
import { actionMethods } from "./engine-actions.js";
import { combatMethods } from "./engine-combat.js";
import { extMethods } from "./engine-ext.js";
import { m4Methods } from "./engine-m4.js";

export { STEPS, parseManaCost, costToString, costCmc, TOKENS, makeRng, describeCost, hasType };

const isPid = (id) => typeof id === "string" && /^P\d+$/.test(id);
const pid = (i) => "P" + i;
const ZONES = ["library", "hand", "graveyard", "exile", "command"];
const SELF_EVENTS = new Set(["dies", "leaves", "cycled", "discard", "cast", "sacrifice", "exploits"]);
const LOOKBACK_EVENTS = new Set(["dies", "leaves", "sacrifice"]);
const PLAYER_STATICS = new Set(["playerProtection", "lifeCantChange", "cantPrevent", "cantGainLife", "noMaxHand", "extraLand", "castAsFlash"]);
const MAX_SBA_LOOPS = 300, MAX_TRIGGER_ROUNDS = 400, MAX_RESOLVES_NO_ACTION = 2500, MAX_REQUESTS_PER_TURN = 20000;

export function isPermanentCard(def) { return !!def && (def.types || []).some((t) => PERMANENT_TYPES.includes(t)); }

export function createGame(setup) { return new Game(setup); }

export function canPay(game, p, costStr) {
  try { const c = parseManaCost(costStr); return game.canPayMana(p, { ...c, x: 0 }); } catch { return false; }
}
export function spellCostFor(game, p, objId, variant) {
  const o = game.state.objects[objId];
  if (!o) return null;
  try { return game.spellCost(p, o, variant || "normal"); } catch { return null; }
}
export function manaAvailable(game, p) {
  let n = poolTotal(game.state.players[p].mana) + (game.state.players[p].manaX || []).length;
  for (const s of game.manaSources(p)) n += Math.max(0, ...s.opts.map((o) => o.net ?? o.units.length - o.input));
  return n;
}

export class Game {
  constructor(setup = {}) {
    const { players = [], options = {}, compile } = setup;
    this.setup = setup;
    const hasCmd = players.some((p) => p?.deck?.commanders?.length);
    this.options = {
      commander: options.commander ?? hasCmd,
      handSize: 7, freeMulligan: true, firstPlayer: null, seed: 1, maxTurns: 300, manualTools: true, maxHandSize: 7,
      ...options,
    };
    if (this.options.startingLife == null) this.options.startingLife = this.options.commander ? 40 : 20;
    this.rng = makeRng(this.options.seed);
    this.compileFn = typeof compile === "function" ? compile : null;
    this._defCache = new Map();
    this._events = [];
    this._manualSeen = new Set();
    this._batchLeft = [];
    this._dirty = true;
    this._statics = [];
    this.answers = [];
    this.request = null;
    this.over = false;
    this.winner = null;
    this.error = null;
    this._gen = null;
    this.state = {
      turn: 0, active: 0, step: "untap", priority: null,
      players: [], battlefield: [], stack: [], objects: {}, combat: null,
      effects: [], controlEffects: [], delayed: [], links: [], pendingTriggers: [],
      extraTurns: [], extraCombats: 0, spellsThisTurn: 0, ts: 0, nextId: 1, requestsThisTurn: 0, phased: [], resolutions: {},
    };
    this._manaTrig = [];
    const st = this.state;
    players.forEach((pd, i) => {
      st.players.push({
        idx: i, id: pid(i), name: pd?.name || `Player ${i + 1}`, ai: !!pd?.ai, life: this.options.startingLife, poison: 0,
        mana: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }, manaX: [], landsPlayed: 0, landsPerTurn: 1,
        library: [], hand: [], graveyard: [], exile: [], command: [], commanders: [], commanderCasts: {}, commanderDamage: {},
        ring: { level: 0, bearer: null }, lost: false, drewFromEmpty: false, counters: {}, lifeLostThisTurn: 0, lifeGainedThisTurn: 0,
        noMaxHand: false, protection: false, flashSorceries: false, lifeLocked: false,
      });
    });
    players.forEach((pd, i) => {
      const deck = pd?.deck || {};
      for (const card of deck.commanders || []) {
        if (!card) continue;
        const o = this.newObj(card, this.compileCard(card), i, "command");
        o.isCommander = true;
        st.players[i].command.push(o.id);
        st.players[i].commanders.push(o.id);
        st.players[i].commanderCasts[o.id] = 0;
      }
      for (const card of deck.cards || []) {
        if (!card) continue;
        const o = this.newObj(card, this.compileCard(card), i, "library");
        st.players[i].library.push(o.id);
      }
    });
  }

  // ================================================================ setup helpers
  compileCard(card) {
    if (this._defCache.has(card)) return this._defCache.get(card);
    let def = null;
    if (card && card.__def) def = card.__def;
    else if (this.compileFn) { try { def = this.compileFn(card); } catch { def = null; } }
    if (!def) def = fallbackDef(card || {});
    let nd;
    try { nd = normalizeDef(def, card); } catch { nd = normalizeDef(fallbackDef(card || {}), card); }
    this._defCache.set(card, nd);
    return nd;
  }

  newObj(card, def, owner, zone) {
    const id = "o" + this.state.nextId++;
    const o = {
      id, owner, controller: owner, baseController: owner, zone, tapped: false, sick: false, counters: {}, damage: 0,
      attachedTo: null, attachments: [], token: false, isCommander: false, face: 0, kicked: false, x: null,
      isAbility: false, sourceId: null, targets: [], text: def.text, def, card: card || null, img: card?.img || def.img || null,
      ts: ++this.state.ts, c: null,
    };
    this.state.objects[id] = o;
    o.c = this.baseC(o);
    return o;
  }

  // ================================================================ public API
  start() {
    if (this._gen) return;
    this._gen = this.main$(); // lint-allow: creates the root generator
    this._advance(undefined);
  }

  respond(answer) {
    if (this.over) throw new Error("Game is over");
    const req = this.request;
    if (!req) throw new Error("No pending request");
    if (answer && typeof answer === "object" && answer.concede != null) {
      const i = answer.concede;
      if (!Number.isInteger(i) || !this.state.players[i]) throw new Error("Bad concede index");
      this.answers.push({ concede: i });
      this._concede(i);
      return;
    }
    this.validate(req, answer);
    this.answers.push(answer);
    this.state.requestsThisTurn++;
    this.request = null;
    this._advance(answer);
  }

  concede(i) {
    if (this.over || !this.state.players[i]) return;
    this.answers.push({ concede: i });
    this._concede(i);
  }
  _concede(i) {
    this.playerLoses(i, "conceded");
    if (this.over) { this.request = null; return; }
    // multiplayer: if the pending request belongs to the conceded player, answer it with a minimal default
    const req = this.request;
    if (req && req.player === i) { const a = this.defaultAnswer(req); this.request = null; this._advance(a); }
  }

  /** Recompute the pending priority request's actions (e.g. after test setup or out-of-band state edits). */
  refreshRequest() {
    const r = this.request;
    if (!r || r.kind !== "priority") return;
    this.markDirty(); this.refresh();
    const acts = this.legalActions(r.player);
    r.actions = acts.map(publicAction);
    r._i.actions = acts;
  }

  drainEvents() { const e = this._events; this._events = []; return e; }

  _advance(ans) {
    let r;
    try {
      r = this._gen.next(ans);
    } catch (err) {
      this.error = err;
      this.emit({ t: "manual", source: null, text: `Engine error: ${err && err.message}. The game was ended.` });
      if (!this.over) this.endGame(null, "engine error");
      this.request = null;
      return;
    }
    if (this.over || r.done) { this.request = null; if (!this.over) this.endGame(null, "game ended"); return; }
    this.refresh();
    this.request = r.value;
  }

  defaultAnswer(req) {
    switch (req.kind) {
      case "mulligan": return { keep: true };
      case "priority": return { type: "pass" };
      case "choose": return { chosen: Array.from({ length: req.min }, (_, i) => i) };
      case "confirm": return { yes: false };
      case "number": return { value: req.min };
      case "attackers": return { attacks: [] };
      case "blockers": return { blocks: [] };
      default: return {};
    }
  }

  /** Validate an answer against a request; throws (without touching state) if illegal. */
  validate(req, a) {
    const bad = (m) => { throw new Error(`Illegal answer to ${req.kind}: ${m}`); };
    if (!a || typeof a !== "object") bad("answer must be an object");
    switch (req.kind) {
      case "mulligan": if (typeof a.keep !== "boolean") bad("keep must be boolean"); return;
      case "priority":
        if (a.type === "pass") return;
        if (a.type !== "act") bad("type must be pass|act");
        if (!Number.isInteger(a.index) || a.index < 0 || a.index >= req.actions.length) bad("index out of range");
        return;
      case "choose": {
        if (!Array.isArray(a.chosen)) bad("chosen must be an array");
        const seen = new Set();
        for (const i of a.chosen) { if (!Number.isInteger(i) || i < 0 || i >= req.options.length) bad("option index out of range"); if (seen.has(i)) bad("duplicate option"); seen.add(i); }
        if (a.chosen.length < req.min || a.chosen.length > req.max) bad(`choose between ${req.min} and ${req.max}`);
        return;
      }
      case "confirm": if (typeof a.yes !== "boolean") bad("yes must be boolean"); return;
      case "number": if (!Number.isInteger(a.value) || a.value < req.min || a.value > req.max) bad(`value must be an integer in [${req.min}, ${req.max}]`); return;
      case "attackers": {
        if (!Array.isArray(a.attacks)) bad("attacks must be an array");
        const seen = new Set();
        for (const at of a.attacks) {
          if (!at || typeof at !== "object") bad("bad attack entry");
          const cand = req.candidates.find((c) => c.obj === at.obj);
          if (!cand) bad(`${at.obj} can't attack`);
          if (!cand.defenders.includes(at.defender)) bad(`${at.obj} can't attack ${at.defender}`);
          if (seen.has(at.obj)) bad("duplicate attacker");
          seen.add(at.obj);
        }
        return;
      }
      case "blockers": {
        if (!Array.isArray(a.blocks)) bad("blocks must be an array");
        const seen = new Set();
        const per = new Map();
        for (const b of a.blocks) {
          if (!b || typeof b !== "object") bad("bad block entry");
          const cand = req.candidates.find((c) => c.obj === b.obj);
          if (!cand) bad(`${b.obj} can't block`);
          if (!cand.canBlock.includes(b.attacker)) bad(`${b.obj} can't block ${b.attacker}`);
          if (seen.has(b.obj)) bad("a creature can block only one attacker");
          seen.add(b.obj);
          per.set(b.attacker, (per.get(b.attacker) || 0) + 1);
        }
        for (const [att, n] of per) {
          const o = this.state.objects[att];
          if (o && this.hasKw(o, "menace") && n < 2) bad(`${o.c.name} has menace and can't be blocked except by two or more creatures`);
        }
        return;
      }
      default: bad("unknown request kind");
    }
  }

  /** Build a request; internal data is attached non-enumerably. */
  mkReq(req, internal) {
    if (internal) Object.defineProperty(req, "_i", { value: internal, enumerable: false, writable: true, configurable: true });
    return req;
  }

  // ================================================================ events / log
  emit(e) {
    if (!e || typeof e !== "object") return;
    if (e.text == null) e.text = e.t || "";
    this._events.push(e);
  }
  log(text) { this.emit({ t: "log", text: String(text) }); }
  manual(src, text) {
    const s = src && typeof src === "object" ? src : src ? this.state.objects[src] : null;
    this.emit({ t: "manual", source: s?.id ?? null, text: `${s?.c?.name ? s.c.name + ": " : ""}${text}` });
  }
  pname(p) { return this.state.players[p]?.name ?? `Player ${p}`; }
  nameOf(id) {
    if (isPid(id)) return this.pname(+id.slice(1));
    const o = this.state.objects[id];
    return o?.c?.name || o?.lki?.c?.name || "?";
  }

  // ================================================================ script API basics (§7)
  obj(id) { return this.state.objects[id] || null; }
  player(idx) { return this.state.players[idx] || null; }
  alivePlayers(all) { return this.state.players.filter((p) => !p.lost).map((p) => p.idx); }
  opponentsOf(idx) { return this.state.players.filter((p) => p.idx !== idx && !p.lost).map((p) => p.idx); }
  nextPlayer(p) {
    const n = this.state.players.length;
    for (let i = 1; i <= n; i++) { const q = (p + i) % n; if (!this.state.players[q].lost) return q; }
    return p;
  }
  /** Order players APNAP (active first). */
  apnap(ps) {
    const n = this.state.players.length, a = this.state.active;
    return [...ps].sort((x, y) => ((x - a + n) % n) - ((y - a + n) % n));
  }

  *choose$(p, o = {}) {
    const options = Array.isArray(o.options) ? o.options : [];
    if (!options.length || this.over) return [];
    let min = Math.max(0, Math.min(o.min ?? 1, options.length));
    let max = Math.max(min, Math.min(o.max ?? Math.max(min, 1), options.length));
    if (max === 0) return [];
    if (min === options.length && !o.ordered) return [...options];
    const req = { kind: "choose", player: p, prompt: o.prompt || "Choose", options, min, max, reason: o.reason || "generic" };
    if (o.ordered) req.ordered = true;
    if (o.source) req.source = o.source;
    setHint(req, o.hint || (this._curEffect ? { kind: "effect", effects: [this._curEffect] } : null));
    const ans = yield req;
    return ans.chosen.map((i) => options[i]);
  }
  *chooseObjects$(p, objs, o = {}) {
    const list = (objs || []).filter(Boolean);
    const options = list.map((x) => ({ id: x.id, label: this.objLabel(x, p), type: x.zone === "battlefield" || x.zone === "stack" ? "object" : "card" }));
    const ch = yield* this.choose$(p, { ...o, options });
    return ch.map((c) => list.find((x) => x.id === c.id)).filter(Boolean);
  }
  objLabel(x, viewer) {
    const name = x.c?.name || "?";
    if (x.zone === "battlefield") {
      const pt = x.c.types.includes("creature") ? ` ${x.c.power}/${x.c.toughness}` : "";
      return `${name}${pt}${x.controller !== viewer ? ` (${this.pname(x.controller)})` : ""}${x.tapped ? " [tapped]" : ""}`;
    }
    if (x.zone === "stack") return `${name} (on the stack)`;
    if (x.zone === "graveyard" && x.owner !== viewer) return `${name} (${this.pname(x.owner)}'s graveyard)`;
    return name;
  }
  *confirm$(p, prompt, source, hint) {
    if (this.over) return false;
    const req = { kind: "confirm", player: p, prompt: String(prompt || "Confirm?") };
    if (source) req.source = source;
    setHint(req, hint);
    const ans = yield req;
    return ans.yes;
  }
  *number$(p, prompt, min, max, source, hint) {
    min = Math.floor(min) || 0; max = Math.max(min, Math.floor(max) || 0);
    if (min === max || this.over) return min;
    const req = { kind: "number", player: p, prompt: String(prompt || "Choose a number"), min, max };
    if (source) req.source = source;
    setHint(req, hint);
    const ans = yield req;
    return ans.value;
  }

  // ================================================================ zones
  removeFromZone(o) {
    const st = this.state;
    const z = o.zone;
    const rm = (arr) => { const i = arr.indexOf(o.id); if (i >= 0) arr.splice(i, 1); };
    if (z === "battlefield") rm(st.battlefield);
    else if (z === "stack") rm(st.stack);
    else if (z === "phased") rm(st.phased);
    else if (ZONES.includes(z)) for (const p of st.players) rm(p[z]);
  }
  removeFromStack(o) {
    const i = this.state.stack.indexOf(o.id);
    if (i >= 0) this.state.stack.splice(i, 1);
  }

  snapshot(o) {
    return {
      id: o.id, owner: o.owner, controller: o.controller, zone: "battlefield", c: o.c, counters: { ...o.counters }, token: o.token,
      isCommander: o.isCommander, tapped: o.tapped, damage: o.damage, def: o.def, face: o.face, attachedTo: o.attachedTo, lki: true, ts: o.ts,
      copyDef: o.copyDef || null, mergeDef: o.mergeDef || null, faceDown: !!o.faceDown, pile: o.pile ? [...o.pile] : null, chosen: o.chosen || null,
    };
  }

  beginBatch() { this._batchLeft = []; }

  /** Core zone change. opts: {controller, tapped, position, counters, quiet, attachTo, cause, entry, cmdAsked}. Returns true if moved.
   *  Generator callers should prefer the enter / zoneMove generators (engine-ext.js), which make "as enters" and commander choices first. */
  moveObj(o, to, opts = {}) {
    const st = this.state;
    if (!o || o.zone === "gone" || o.isAbility) return false;
    const from = o.zone;
    if (from === to && to !== "library" && to !== "battlefield") return false;
    if (from === "battlefield" && to === "graveyard" && o.c?.types.includes("creature") && (st.effects.some((e) => e.static?.type === "exileInsteadOfDying" && e.objIds && e.objIds.includes(o.id)) ||
        this._statics.some((s) => s.st.type === "exileInsteadOfDying" && !s.objIds && s.st.affects && this.matches(o, s.st.affects, { source: s.src, you: s.you })))) {
      this.log(`${o.c.name} is exiled instead of dying`);
      to = "exile";
    }
    if (from === "battlefield" && to !== "exile" && st.effects.some((e) => e.static?.type === "exileIfLeaves" && e.objIds && e.objIds.includes(o.id))) { this.log(`${o.c.name} is exiled instead`); to = "exile"; } // unearth
    const preC = o.c;
    this.removeFromZone(o);
    let lki = null;
    const returning = [];
    let wasFaceDown = false;
    if (from === "battlefield" || from === "phased") {
      lki = this.snapshot(o);
      lki.attachments = [...(o.attachments || [])];
      o.lki = lki;
      this._batchLeft.push(lki);
      if (o.attachedTo) { const h = st.objects[o.attachedTo]; if (h) h.attachments = h.attachments.filter((x) => x !== o.id); o.attachedTo = null; }
      for (const aid of o.attachments) { const a = st.objects[aid]; if (a) a.attachedTo = null; }
      o.attachments = [];
      st.controlEffects = st.controlEffects.filter((ce) => ce.objId !== o.id);
      for (const e of st.effects) if (e.objIds && e.objIds.includes(o.id)) e.objIds = e.objIds.filter((x) => x !== o.id);
      st.effects = st.effects.filter((e) => !(e.objIds && e.objIds.length === 0 && !PLAYER_STATICS.has(e.static?.type)) && !(e.until === "sourceLeaves" && e.sourceId === o.id));
      for (const pl of st.players) if (pl.ring.bearer === o.id) pl.ring.bearer = null;
      if (st.combat) {
        st.combat.attackers = st.combat.attackers.filter((a) => a.obj !== o.id);
        for (const a of st.combat.attackers) a.blockers = a.blockers.filter((b) => b !== o.id);
      }
      for (let i = st.links.length - 1; i >= 0; i--) if (st.links[i].sourceId === o.id) { returning.push(st.links[i].objId); st.links.splice(i, 1); }
      o.tapped = false; o.damage = 0; o.deathtouched = false; o.counters = {}; o.sick = false; o.echoDue = false;
      o.controller = o.owner; o.baseController = o.owner; o.loyaltyUsed = null; o.activations = null;
      if (o.pile && o.pile.length > 1) o._leftPile = o.pile.filter((id) => id !== o.id);
      o.pile = null; o.mergeDef = null; o.chosen = null; o.phasedIndirect = false; o.phasedController = null;
      if (!o.token) o.copyDef = null;
    }
    if (o.faceDown && !(from === "stack" && to === "battlefield") && !(from === "exile" && to === "exile")) {
      if (from === "battlefield" || from === "stack" || from === "phased") wasFaceDown = true;
      o.faceDown = false;
    }
    if (from === "stack") { o.castVariant = o.castVariant || null; }
    o.zone = to;
    if (o.token && (from === "battlefield" || from === "phased") && to !== "battlefield") {
      o.zone = "gone";
    } else if (o.isCopy && to !== "stack") {
      o.zone = "gone";
    } else if (to === "battlefield") {
      st.battlefield.push(o.id);
      o.controller = opts.controller ?? o.owner;
      o.baseController = o.controller;
      o.tapped = !!opts.tapped;
      o.sick = true;
      o.damage = 0;
      o.ts = ++st.ts;
      if (from !== "stack") { o.kicked = false; o.x = null; }
      const entry = opts.entry || this.defaultEntry(o, opts);
      if (entry.copy && entry.copy.def) o.copyDef = entry.copy.def;
      o.chosen = entry.chosen && Object.keys(entry.chosen).length ? { ...entry.chosen } : null;
      o.c = this.baseC(o);
      this.markDirty();
      this.refresh();
      this.applyEntersReplacements(o, opts, entry);
    } else if (to === "stack") {
      st.stack.push(o.id);
    } else if (ZONES.includes(to)) {
      const pl = st.players[o.owner];
      o.controller = o.owner;
      if (to === "library") {
        const pos = opts.position || "top";
        if (pos === "bottom") pl.library.unshift(o.id);
        else if (typeof pos === "number") pl.library.splice(Math.max(0, pl.library.length - pos + 1), 0, o.id);
        else pl.library.push(o.id);
        if (pos === "shuffle") this.shuffle(o.owner, true);
      } else pl[to].push(o.id);
      if (!opts.keepFace) o.face = 0;
      if (to !== "exile") o.onAdventure = false;
      o.mayPlay = null;
      o.x = null; o.kicked = false; o.targets = []; o.castVariant = null;
      o.c = this.baseC(o);
      if (o.isCommander && to !== "command" && !opts.cmdAsked) o.cmdPending = true;
    } else {
      o.zone = "gone";
    }
    if (to !== "command" && o.isCommander && from === "command") o.cmdPending = false;
    if (to === "command") o.cmdPending = false;
    this.markDirty();
    const name = (lki || o).c?.name || o.c?.name;
    if (!opts.quiet) {
      const who = this.pname(o.owner);
      let text;
      if (from === "battlefield" && to === "graveyard") text = lki.c.types.includes("creature") ? `${name} dies` : `${name} is put into ${who}'s graveyard`;
      else if (to === "battlefield") text = `${name} enters the battlefield${o.tapped ? " tapped" : ""}${o.controller !== o.owner ? ` under ${this.pname(o.controller)}'s control` : ""}`;
      else if (to === "graveyard") text = `${name} is put into ${who}'s graveyard`;
      else if (to === "exile") text = `${name} is exiled`;
      else if (to === "hand") text = from === "library" ? `${who} puts a card into their hand` : `${name} is returned to ${who}'s hand`;
      else if (to === "library") text = `${name} is put into ${who}'s library${opts.position === "bottom" ? " (bottom)" : opts.position === "shuffle" ? "" : " (top)"}`;
      else if (to === "command") text = `${name} goes to the command zone`;
      else if (to === "stack") text = `${name} is put on the stack`;
      else text = `${name} leaves the battlefield`;
      if (o.token && to !== "battlefield") text = `${name} (token) ${to === "graveyard" ? (lki?.c.types.includes("creature") ? "dies" : "is put into the graveyard") : "leaves the battlefield"}`;
      this.emit({ t: "move", obj: o.id, from, to, player: o.owner, text });
    }
    if (wasFaceDown) this.emit({ t: "reveal", objs: [o.id], player: o.owner, text: `(The face-down card was ${o.def?.name || "?"})` });
    if (from === "battlefield" || from === "phased") {
      if (to === "graveyard" && lki.c.types.includes("creature")) { this.emit({ t: "dies", obj: o.id, text: `${name} died` , silent: true }); this.fireTrigger({ type: "dies", obj: lki, player: lki.controller }); }
      this.fireTrigger({ type: "leaves", obj: lki, to, player: lki.controller });
    }
    if (to === "battlefield" && o.zone === "battlefield") {
      if (opts.attachTo) { const h = st.objects[opts.attachTo]; if (h && h.zone === "battlefield") this.attach(o, h, true); }
      this.fireTrigger({ type: "enters", obj: o, from, player: o.controller });
    }
    // a card (not a token, not a copy of a spell) changed zones: "a creature card is put into a graveyard from anywhere",
    // "a card leaves your graveyard" (Syr Konrad). Pile cards of a merged permanent come from the battlefield.
    if (!o.token && !o.isCopy && o.def) {
      const f = from === "merged" || from === "phased" ? "battlefield" : from;
      const lc = f === "graveyard" ? preC : o.c;
      this.fireTrigger({ type: "zoneChange", obj: { id: o.id, owner: o.owner, controller: o.owner, zone: f === "graveyard" ? "graveyard" : o.zone, c: lc || o.c, token: false, def: o.def, lki: true }, from: f, to: o.zone === "gone" ? to : o.zone, player: o.owner });
    }
    if (o._leftPile) this.splitPile(o, to, opts);
    for (const rid of returning) { const r = st.objects[rid]; if (r && r.zone === "exile") this.moveObj(r, "battlefield", { controller: r.owner }); }
    return true;
  }

  applyEntersReplacements(o, opts, entry) {
    const d = this.faceDef(o);
    const ctx = { source: o, you: o.controller, quiet: true };
    if (o.c.types.includes("planeswalker")) o.counters.loyalty = (o.counters.loyalty | 0) + (d.loyalty === "x" ? o.x | 0 : +d.loyalty || 0); // printed loyalty X = the X paid
    if (opts.counters) for (const [k, n] of Object.entries(opts.counters)) o.counters[k] = (o.counters[k] | 0) + (n | 0);
    if (entry && entry.copy) { // "except it enters with an additional +1/+1 counter if it's a creature / loyalty counter if it's a planeswalker"
      const ex = entry.copy.except || {};
      const add = (m) => { for (const [k, n] of Object.entries(m || {})) o.counters[k] = (o.counters[k] | 0) + (n | 0); };
      if (o.c.types.includes("creature")) add(ex.counters?.creature);
      if (o.c.types.includes("planeswalker")) add(ex.counters?.planeswalker);
      this.log(`${this.pname(o.controller)}'s ${o.def.name} enters as a copy of ${entry.copy.def?._copyOf || "a permanent"}`);
    }
    for (const ab of this.baseAbilities(o)) {
      if (ab.kind !== "static" || !ab.effect) continue;
      const e = ab.effect;
      if (e.type === "entersTapped" && (e.affects == null || e.affects === "self")) {
        let tapped;
        if (e.unlessPay) tapped = !(entry && entry.untapped);
        else if (e.unless && e.unless.type === "hasInHand" && entry && entry.done && !entry.fallback) tapped = !entry.untapped;
        else if (e.unless) { let unless = false; try { unless = this.evalCond(e.unless, ctx); } catch { unless = false; } tapped = !unless; }
        else tapped = true;
        if (tapped) o.tapped = true;
      } else if (e.type === "entersWithCounters" && (e.affects == null || e.affects === "self")) {
        const n = this.amount(e.amount ?? 1, { ...ctx, x: o.x | 0, kicked: o.kicked });
        if (n > 0) o.counters[e.kind || "+1/+1"] = (o.counters[e.kind || "+1/+1"] | 0) + n;
      }
    }
    // other permanents' "X enter tapped" statics
    for (const s of this._statics) {
      if (s.st.type === "entersTapped" && s.src && s.src.id !== o.id && s.st.affects && s.st.affects !== "self" && this.matches(o, s.st.affects, { source: s.src, you: s.you })) o.tapped = true;
    }
    if (this.keywordOf(o, "echo")) o.echoDue = true;
    this.markDirty();
    this.refresh();
    // Sagas: "as this Saga enters, add a lore counter" (Read ahead: the chosen chapter; only that chapter's ability triggers)
    if (o.c.subtypes.includes("saga") && this.finalChapter(o)) {
      const n = Math.max(1, Math.min(this.finalChapter(o), (entry && entry.chosen && entry.chosen.chapter) | 0 || 1));
      o.counters.lore = (o.counters.lore | 0) + n;
      this.emit({ t: "counters", obj: o.id, kind: "lore", delta: n, text: `${n} lore counter${n > 1 ? "s" : ""} put on ${o.c.name}` });
      this.markDirty();
      this.refresh();
      this.sagaChapters(o, n, n);
    }
  }
  keywordOf(o, k) { const v = o.c?.keywords?.[k]; return v == null || v === false ? null : v; }

  shuffle(p, quiet) {
    const lib = this.state.players[p].library;
    for (let i = lib.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); const t = lib[i]; lib[i] = lib[j]; lib[j] = t; }
    if (!quiet) this.emit({ t: "shuffle", player: p, text: `${this.pname(p)} shuffles their library` });
  }

  // ================================================================ basic actions (also §7 API)
  draw(p, n = 1) {
    const pl = this.state.players[p];
    if (!pl || pl.lost) return 0;
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (!pl.library.length) { pl.drewFromEmpty = true; break; }
      const o = this.state.objects[pl.library[pl.library.length - 1]];
      this.moveObj(o, "hand", { quiet: true });
      this.emit({ t: "draw", player: p, obj: o.id, text: `${pl.name} draws a card` });
      this.fireTrigger({ type: "draw", player: p, obj: o });
      k++;
    }
    return k;
  }
  /** Draw with the commander replacement (CR 903.9b): a commander that would be drawn may go to the command zone instead. */
  *drawCards$(p, n = 1) {
    const pl = this.state.players[p];
    if (!pl || pl.lost) return 0;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const top = pl.library.length ? this.state.objects[pl.library[pl.library.length - 1]] : null;
      if (top && top.isCommander) {
        if (yield* this.confirm$(p, `Put ${top.c.name} into the command zone instead of drawing it?`, top.id, { kind: "commander" })) { this.moveObj(top, "command"); continue; }
      }
      const got = this.draw(p, 1);
      if (top && top.isCommander && top.zone === "hand") top.cmdPending = false; // already declined
      if (!got) break;
      k += got;
    }
    return k;
  }
  mill(p, n = 1) {
    const pl = this.state.players[p];
    const out = [];
    for (let i = 0; i < n && pl.library.length; i++) {
      const o = this.state.objects[pl.library[pl.library.length - 1]];
      this.moveObj(o, "graveyard", { quiet: true });
      o.milledTurn = this.state.turn;
      out.push(o);
    }
    if (out.length) {
      this.log(`${pl.name} mills ${out.map((o) => o.c.name).join(", ")}`);
      this.milledEvents(p, out);
    }
    return out;
  }
  discardCard(o) {
    const p = o.owner;
    this.moveObj(o, "graveyard", { quiet: true });
    this.emit({ t: "move", obj: o.id, from: "hand", to: "graveyard", player: p, text: `${this.pname(p)} discards ${o.c.name}` });
    this.fireTrigger({ type: "discard", player: p, obj: o });
  }
  gainLife(p, n) {
    const pl = this.state.players[p];
    n = Math.floor(n);
    if (!pl || pl.lost || !(n > 0)) return 0;
    if (pl.lifeLocked) { this.log(`${pl.name}'s life total can't change`); return 0; }
    if (this._statics.some((s) => s.st.type === "cantGainLife" && ((s.st.who ?? "opponent") === "opponent" ? s.you !== p : s.st.who === "you" ? s.you === p : true))) { this.log(`${pl.name} can't gain life`); return 0; }
    pl.life += n;
    pl.lifeGainedThisTurn += n;
    this.emit({ t: "life", player: p, delta: n, life: pl.life, text: `${pl.name} gains ${n} life (${pl.life})` });
    this.fireTrigger({ type: "gainLife", player: p, amount: n });
    return n;
  }
  loseLife(p, n, opts = {}) {
    const pl = this.state.players[p];
    n = Math.floor(n);
    if (!pl || pl.lost || !(n > 0)) return 0;
    if (pl.lifeLocked) { if (!opts.silent) this.log(`${pl.name}'s life total can't change`); return 0; }
    pl.life -= n;
    pl.lifeLostThisTurn += n;
    if (!opts.silent) this.emit({ t: "life", player: p, delta: -n, life: pl.life, text: `${pl.name} ${opts.cost ? "pays" : "loses"} ${n} life (${pl.life})` });
    this.fireTrigger({ type: "loseLife", player: p, amount: n });
    return n;
  }
  destroy(o) {
    if (!o || o.zone !== "battlefield") return false;
    if (this.hasKw(o, "indestructible")) { this.log(`${o.c.name} is indestructible`); return false; }
    if (o.counters.shield > 0) { this.addCounters(o, "shield", -1); this.log(`${o.c.name}: a shield counter is removed instead of being destroyed`); return false; }
    return this.moveObj(o, "graveyard", { cause: "destroy" });
  }
  exile(o) { if (!o) return false; if (o.zone === "stack") this.removeFromStack(o); return this.moveObj(o, "exile"); }
  bounce(o) { if (!o) return false; if (o.zone === "stack") this.removeFromStack(o); return this.moveObj(o, "hand"); }
  sacrifice(o) {
    if (!o || o.zone !== "battlefield") return false;
    const lk = this.snapshot(o);
    this.log(`${this.pname(o.controller)} sacrifices ${o.c.name}`);
    this.moveObj(o, "graveyard", { cause: "sacrifice" });
    this.fireTrigger({ type: "sacrifice", obj: lk, player: lk.controller });
    return true;
  }
  *moveTo$(o, zone, opts = {}) {
    if (!o) return false;
    return yield* this.zoneMove$(o, zone, opts);
  }
  addCounters(o, kind, n) {
    if (!o || !n || (o.zone !== "battlefield" && !o.isAbility)) return 0;
    kind = String(kind);
    const cur = o.counters[kind] | 0;
    const nv = Math.max(0, cur + n);
    const d = nv - cur;
    if (!d) return 0;
    if (nv) o.counters[kind] = nv; else delete o.counters[kind];
    this.markDirty();
    this.emit({ t: "counters", obj: o.id, kind, delta: d, text: d > 0 ? `${d} ${kind} counter${d > 1 ? "s" : ""} put on ${o.c.name}` : `${-d} ${kind} counter${d < -1 ? "s" : ""} removed from ${o.c.name}` });
    if (d > 0) this.fireTrigger({ type: "counterAdded", obj: o, kind, amount: d, player: o.controller });
    if (d > 0 && kind === "lore") this.sagaChapters(o, nv - d + 1, nv);
    return d;
  }
  addPlayerCounters(p, kind, n) {
    const pl = this.state.players[p];
    if (!pl || !n) return 0;
    if (kind === "poison") { pl.poison = Math.max(0, pl.poison + n); pl.counters.poison = pl.poison; }
    else pl.counters[kind] = Math.max(0, (pl.counters[kind] | 0) + n);
    this.emit({ t: "counters", obj: pid(p), kind, delta: n, text: `${pl.name} ${n > 0 ? "gets" : "loses"} ${Math.abs(n)} ${kind} counter${Math.abs(n) > 1 ? "s" : ""}` });
    return n;
  }
  tap(o, forMana) {
    if (!o || o.zone !== "battlefield" || o.tapped) return false;
    o.tapped = true;
    this.markDirty();
    this.emit({ t: "tap", obj: o.id, text: `${o.c.name} becomes tapped`, mana: !!forMana });
    this.fireTrigger({ type: "tapped", obj: o, forMana: !!forMana, player: o.controller });
    return true;
  }
  untap(o, silent) {
    if (!o || o.zone !== "battlefield" || !o.tapped) return false;
    if (o.counters.stun > 0) { this.addCounters(o, "stun", -1); this.log(`${o.c.name} doesn't untap (a stun counter is removed instead)`); return false; } // CR 122.1g
    o.tapped = false;
    this.markDirty();
    this.emit({ t: "untap", obj: o.id, text: `${o.c.name} untaps`, ...(silent ? { silent: true } : {}) });
    return true;
  }
  addManaPool(p, add, src, silent) {
    const pl = this.state.players[p];
    let any = false;
    for (const k of ["W", "U", "B", "R", "G", "C"]) if (add[k]) { pl.mana[k] += add[k]; any = true; }
    if (any) this.emit({ t: "mana", player: p, added: poolToString(add), text: `${pl.name} adds ${poolToString(add)}${src?.c?.name ? ` (${src.c.name})` : ""}`, ...(silent ? { silent: true } : {}) });
  }
  addMana(p, str) { const q = parseManaCost(str); this.addManaPool(p, { W: q.W, U: q.U, B: q.B, R: q.R, G: q.G, C: q.C + q.generic }); }

  createToken(p, t, n = 1, opts = {}) {
    const out = [];
    let def;
    if (t && typeof t === "object" && t.copyOf) {
      const src = t.copyOf;
      def = this.copiableDef(src);
      if (opts.nonLegendary) def = normalizeDef({ ...def, supertypes: def.supertypes.filter((s) => s !== "legendary"), faces: null });
    } else def = tokenDef(t);
    if (opts.power != null || opts.toughness != null) def = normalizeDef({ ...def, power: opts.power ?? def.power, toughness: opts.toughness ?? def.toughness, faces: null });
    for (let i = 0; i < n; i++) {
      const o = this.newObj(null, def, p, "none");
      o.token = true;
      o.img = def.img || null;
      if (t && t.copyOf) o.copyDef = def;
      this.moveObj(o, "battlefield", { controller: p, tapped: !!opts.tapped, quiet: true });
      this.emit({ t: "token", obj: o.id, player: p, text: `${this.pname(p)} creates ${o.c.types.includes("creature") && o.c.power != null ? `a ${o.c.power}/${o.c.toughness} ` : "a "}${o.c.name} token${opts.tapped ? " (tapped)" : ""}` });
      this.fireTrigger({ type: "tokenCreated", obj: o, player: p });
      if (opts.attacking && this.state.combat && o.c.types.includes("creature")) {
        let def2 = null;
        const srcAtt = opts.source && this.state.combat.attackers.find((a) => a.obj === opts.source.id);
        if (srcAtt) def2 = srcAtt.defender; else def2 = pid(this.opponentsOf(p)[0] ?? 0);
        this.state.combat.attackers.push({ obj: o.id, defender: def2, blockers: [], blocked: false });
      }
      out.push(o);
    }
    return out;
  }
  attach(o, host, quiet) {
    if (!o || !host) return;
    if (o.attachedTo) { const h = this.state.objects[o.attachedTo]; if (h) h.attachments = h.attachments.filter((x) => x !== o.id); }
    o.attachedTo = host.id;
    if (!host.attachments.includes(o.id)) host.attachments.push(o.id);
    o.attachTs = ++this.state.ts;
    this.markDirty();
    if (!quiet) this.log(`${o.c.name} is attached to ${host.c.name}`);
  }
  gainControl(o, p, until, src) {
    if (!o || o.zone !== "battlefield") return;
    this.state.controlEffects.push({ objId: o.id, controller: p, until: until || null, ts: ++this.state.ts, sourceId: src?.id, you: p });
    o.sick = true;
    this.markDirty();
    this.refresh();
    this.log(`${this.pname(p)} gains control of ${o.c.name}${until === "endOfTurn" ? " until end of turn" : ""}`);
  }
  pumpUntilEOT(o, { power = 0, toughness = 0, keywords = [] } = {}) {
    if (!o) return;
    this.addEffect({ type: "pump", power, toughness, keywords }, { source: o, you: o.controller }, { objIds: [o.id], until: "endOfTurn", fixedPT: [power, toughness] });
  }
  addUntilEOT(stat, ctx = {}) {
    let objIds = null;
    if (stat && stat.affects && typeof stat.affects === "object") objIds = this.find(stat.affects, ctx).map((o) => o.id);
    else if (stat && (stat.affects === "self" || stat.affects == null) && ctx.source) objIds = [ctx.source.id];
    this.addEffect(stat, ctx, { objIds, until: "endOfTurn" });
  }
  addEffect(stat, ctx, { objIds = null, until = "endOfTurn", fixedPT = null } = {}) {
    if (!stat || typeof stat !== "object") return;
    this.state.effects.push({ id: "e" + this.state.ts, ts: ++this.state.ts, static: stat, sourceId: ctx?.source?.id ?? null, sourceSnap: ctx?.source || null,
      you: ctx?.you ?? 0, objIds, until, fixedPT, x: ctx?.x, startTurn: this.state.turn });
    this.markDirty();
  }
  delayed(trigger, fn, ctx = {}) { this.addDelayed(trigger, null, ctx, true, fn); }
  addDelayed(at, effects, ctx = {}, once = true, fn = null) {
    this.state.delayed.push({ id: "d" + ++this.state.ts, at, effects, fn, ctx: { ...ctx }, controller: ctx.you ?? 0, once, turn: this.state.turn, step: this.state.step });
  }

  // ================================================================ damage
  dealDamage(src, targetId, n, opts = {}) {
    n = Math.floor(Number(n) || 0);
    if (n <= 0 || src == null) return 0;
    if (typeof src === "string") src = this.state.objects[src];
    if (!src) return 0;
    const st = this.state;
    const srcCtrl = src.controller ?? src.owner ?? 0;
    n = this.modifyDamage(src, targetId, n, !!opts.combat);
    if (n <= 0) return 0;
    const srcName = src.c?.name || "Something";
    if (isPid(targetId)) {
      const p = +targetId.slice(1);
      const pl = st.players[p];
      if (!pl || pl.lost) return 0;
      if (pl.protection && !this._noPrevent) { this.log(`Damage to ${pl.name} is prevented (protection)`); return 0; }
      if (this.hasKw(src, "infect")) {
        this.emit({ t: "damage", source: src.id, target: targetId, amount: n, combat: !!opts.combat, text: `${srcName} deals ${n} damage to ${pl.name}` });
        this.addPlayerCounters(p, "poison", n);
      } else {
        this.emit({ t: "damage", source: src.id, target: targetId, amount: n, combat: !!opts.combat, text: `${srcName} deals ${n} damage to ${pl.name}` });
        if (pl.lifeLocked) this.log(`${pl.name}'s life total can't change`);
        else {
          pl.life -= n;
          pl.lifeLostThisTurn += n;
          this.emit({ t: "life", player: p, delta: -n, life: pl.life, text: `${pl.name} loses ${n} life (${pl.life})` });
          this.fireTrigger({ type: "loseLife", player: p, amount: n });
        }
      }
      if (opts.combat) {
        if (src.isCommander) pl.commanderDamage[src.id] = (pl.commanderDamage[src.id] | 0) + n;
        this.monarchHit(src, p);
        const tox = this.keywordOf(src, "toxic");
        if (tox) this.addPlayerCounters(p, "poison", +tox || 1);
      }
    } else {
      const o = st.objects[targetId];
      if (!o || o.zone !== "battlefield") return 0;
      if (this.protectedFrom(o, src) && !this._noPrevent) { this.log(`Damage to ${o.c.name} is prevented (protection)`); return 0; }
      const dtc = this._statics.find((s) => s.st.type === "damageToCounters" && s.src && s.src.id === o.id && (o.counters[s.st.kind || "+1/+1"] | 0) > 0);
      if (dtc) { // Bloatfly Swarm: prevent the damage, remove that many counters, each player gets a rad counter for each removed
        const k = dtc.st.kind || "+1/+1", m = Math.min(n, o.counters[k] | 0);
        this.log(`${o.c.name}: damage is prevented; ${m} ${k} counter${m > 1 ? "s" : ""} removed instead`);
        this.addCounters(o, k, -m);
        if (dtc.st.giveRad) for (const q of st.players) if (!q.lost) this.addPlayerCounters(q.idx, "rad", m);
        return 0;
      }
      if (o.counters.shield > 0) { this.addCounters(o, "shield", -1); this.log(`${o.c.name}: a shield counter is removed instead of damage being dealt`); return 0; } // CR 122.1c
      this.emit({ t: "damage", source: src.id, target: targetId, amount: n, combat: !!opts.combat, text: `${srcName} deals ${n} damage to ${o.c.name}` });
      const isCre = o.c.types.includes("creature");
      if (o.c.types.includes("planeswalker")) this.addCounters(o, "loyalty", -n);
      if (isCre) {
        if (this.hasKw(src, "wither") || this.hasKw(src, "infect")) this.addCounters(o, "-1/-1", n);
        else o.damage += n;
        if (this.hasKw(src, "deathtouch")) o.deathtouched = true;
      }
      this.markDirty();
      this.fireTrigger({ type: "dealtDamage", obj: o, source: src, amount: n, combat: !!opts.combat, player: o.controller });
    }
    this.fireTrigger({ type: "dealsDamage", obj: src, source: src, target: targetId, amount: n, combat: !!opts.combat, player: srcCtrl });
    if (opts.combat) this.fireTrigger({ type: "dealsCombatDamage", obj: src, source: src, target: targetId, amount: n, combat: true, player: srcCtrl });
    if (this.hasKw(src, "lifelink")) this.gainLife(srcCtrl, n);
    return n;
  }

  modifyDamage(src, targetId, n, combat) {
    const mods = this._statics.filter((s) => s.st.type === "damageMod");
    if (!mods.length) return n;
    const tgtPlayer = isPid(targetId) ? +targetId.slice(1) : null;
    const tgtObj = tgtPlayer == null ? this.state.objects[targetId] : null;
    const applies = (s) => {
      const ctx = { source: s.src, you: s.you };
      if (s.st.source && !this.matches(src, s.st.source, ctx, "*")) return false;
      if (s.st.sourceController === "you" && (src.controller ?? src.owner) !== s.you) return false;
      if (s.st.combat != null && combat != null && !!s.st.combat !== !!combat) return false; // combat:false = noncombat damage only
      if (s.st.exceptSelf && tgtObj && s.src && tgtObj.id === s.src.id) return false;
      const to = s.st.to ?? "any";
      const opp = (p) => p != null && p !== s.you;
      switch (to) {
        case "any": return true;
        case "opponent": return opp(tgtPlayer);
        case "you": return tgtPlayer === s.you;
        case "opponentPermanent": return !!tgtObj && opp(tgtObj.controller);
        case "yourPermanent": return !!tgtObj && tgtObj.controller === s.you;
        case "opponentOrPermanent": return opp(tgtPlayer) || (!!tgtObj && opp(tgtObj.controller));
        case "youOrPermanent": return tgtPlayer === s.you || (!!tgtObj && tgtObj.controller === s.you);
        case "youOrPlaneswalker": return tgtPlayer === s.you || (!!tgtObj && tgtObj.controller === s.you && tgtObj.c.types.includes("planeswalker"));
        case "creature": return !!tgtObj && tgtObj.c.types.includes("creature");
        case "player": return tgtPlayer != null;
        default: return typeof to === "object" ? this.matches(targetId, to, ctx) : false;
      }
    };
    const act = mods.filter(applies);
    for (const s of act) if (s.st.add) n += +s.st.add || 0;
    for (const s of act) if (s.st.mul) n *= +s.st.mul || 1;
    if (!this._noPrevent) for (const s of act) if (s.st.prevent === "half") n -= Math.ceil(n / 2); else if (s.st.prevent === "all") n = 0; else if (s.st.prevent === "allButOne") n = Math.min(n, 1); else if (typeof s.st.prevent === "number") n -= s.st.prevent;
    return Math.max(0, Math.floor(n));
  }

  protectedFrom(o, src) {
    const prot = this.keywordOf(o, "protection");
    if (!prot || !src) return false;
    const list = Array.isArray(prot) ? prot : [prot];
    const sc = src.c || {};
    for (const p of list) {
      if (p == null) continue;
      if (typeof p === "object") { if (this.matches(src, p, { source: o, you: o.controller }, "*")) return true; continue; }
      const s = String(p).toLowerCase();
      if (s === "everything" || s === "all" || s === "true") return true;
      const col = { white: "W", blue: "U", black: "B", red: "R", green: "G", w: "W", u: "U", b: "B", r: "R", g: "G" }[s];
      if (col) { if ((sc.colors || []).includes(col)) return true; continue; }
      if (s === "multicolored" && (sc.colors || []).length > 1) return true;
      if (s === "monocolored" && (sc.colors || []).length === 1) return true;
      if (s === "ring-bearers" || s === "ring-bearer") { if (src.zone === "battlefield" && this.isRingBearer(src)) return true; continue; }
      const t = s.replace(/s$/, "");
      if ((sc.types || []).includes(t) || (sc.subtypes || []).includes(t)) return true;
    }
    return false;
  }

  // ================================================================ triggers
  fireTrigger(evt) {
    if (this.over || !evt) return;
    const st = this.state;
    const seen = new Set();
    const consider = (s, abs, ctrl, zone) => {
      for (const ab of abs) {
        if (!ab || ab.kind !== "triggered" || !ab.on) continue;
        const abZone = ab.zone || "battlefield";
        const isSelf = evt.obj && evt.obj.id === s.id;
        if (abZone !== zone && !(isSelf && SELF_EVENTS.has(evt.type) && ab.on.who === "self")) continue;
        let ok = false;
        this._evtOverride = null;
        try { ok = this.triggerMatches(ab.on, evt, s, ctrl); } catch { ok = false; }
        if (!ok) { this._evtOverride = null; continue; }
        const ctx = { source: s, you: ctrl, event: evt, quiet: true };
        if (ab.condition) { let c = false; try { c = this.evalCond(ab.condition, { ...ctx, event: this._evtOverride || evt }); } catch { c = false; } if (!c) { this._evtOverride = null; continue; } }
        const times = 1 + this.triggerDoubling(evt, ctrl);
        const ev2 = this._evtOverride || evt;
        this._evtOverride = null;
        // triggered mana abilities resolve immediately after the mana ability that triggered them (CR 605.4a)
        if (ab.manaTrigger) { if (evt.forMana) for (let i = 0; i < times; i++) this._manaTrig.push({ source: s, ab, controller: ctrl, event: ev2 }); continue; }
        for (let i = 0; i < times; i++) st.pendingTriggers.push({ sourceId: s.id, source: s, ab, controller: ctrl, event: ev2 });
      }
    };
    for (const id of st.battlefield) {
      const o = st.objects[id];
      if (!o || seen.has(id)) continue;
      seen.add(id);
      consider(o, o.c.abilities, o.controller, "battlefield");
    }
    if (LOOKBACK_EVENTS.has(evt.type)) for (const lk of this._batchLeft) {
      if (seen.has(lk.id)) continue;
      seen.add(lk.id);
      consider(lk, lk.c.abilities || [], lk.controller, "battlefield");
    }
    // abilities that function from other zones (graveyard/hand/exile/command/stack) and self-referential leave triggers
    if (evt.obj && !seen.has(evt.obj.id) && SELF_EVENTS.has(evt.type)) {
      const o = evt.obj;
      seen.add(o.id);
      const real = st.objects[o.id];
      if (evt.obj.lki) consider(evt.obj, evt.obj.c.abilities || [], evt.obj.controller, "battlefield");
      else if (real) consider(real, real.c?.abilities || this.baseAbilities(real), real.controller, real.zone);
    }
    for (const p of st.players) for (const z of ["graveyard", "hand", "exile", "command"]) for (const id of p[z]) {
      if (seen.has(id)) continue;
      const o = st.objects[id];
      const abs = this.baseAbilities(o);
      if (!abs.some((a) => a.kind === "triggered" && a.zone === z)) continue;
      seen.add(id);
      consider(o, abs.filter((a) => a.zone === z), o.owner, z);
    }
    for (const id of st.stack) {
      const o = st.objects[id];
      if (!o || o.isAbility || seen.has(id)) continue;
      const abs = this.baseAbilities(o).filter((a) => a.kind === "triggered" && a.zone === "stack");
      if (abs.length) { seen.add(id); consider(o, abs, o.controller, "stack"); }
    }
    if (st.emblems) for (const id of st.emblems) { const o = st.objects[id]; if (o && !seen.has(id)) { seen.add(id); consider(o, o.c.abilities || [], o.owner, "emblem"); } }
    // internal ring triggers
    this.ringTriggers(evt);
    // delayed triggers
    for (let i = 0; i < st.delayed.length; i++) {
      const d = st.delayed[i];
      let ok = false;
      try { ok = this.triggerMatches(d.at, evt, d.ctx.source || { id: "_", controller: d.controller, c: { abilities: [] } }, d.controller, d); } catch { ok = false; }
      if (!ok) continue;
      st.pendingTriggers.push({ sourceId: d.ctx.source?.id ?? null, source: d.ctx.source || null, controller: d.controller, event: evt, delayed: d,
        ab: { kind: "triggered", effects: d.effects, run: d.fn ? (g, ctx) => d.fn(g, ctx) : null, text: d.text || "Delayed trigger" } });
      if (d.once) { st.delayed.splice(i, 1); i--; }
    }
  }

  triggerDoubling(evt, ctrl) {
    let n = 0;
    for (const s of this._statics) {
      if (s.st.type !== "doubleTriggers" || s.you !== ctrl) continue;
      const evts = [].concat(s.st.event || "dies");
      if (!evts.includes(evt.type)) continue;
      if (s.st.filter && !(evt.obj && this.matches(evt.obj, s.st.filter, { source: s.src, you: s.you }, "*"))) continue;
      n += s.st.times || 1;
    }
    return n;
  }

  triggerMatches(on, evt, s, ctrl, delayed) {
    if (!on || typeof on !== "object") return false;
    let ev = on.event;
    if (ev === "etb" || ev === "entersBattlefield") ev = "enters";
    if (ev !== evt.type) return false;
    const ctx = { source: s, you: ctrl, event: evt };
    const whoObj = (who, o) => {
      if (who == null || who === "any" || who === "each") return true;
      if (!o) return false;
      if (who === "self") return o.id === s.id;
      if (who === "you") return o.controller === ctrl;
      if (who === "opponent") return o.controller !== ctrl;
      if (who === "other" || who === "another") return o.id !== s.id;
      if (who === "equipped" || who === "enchanted" || who === "attached") return (!!s.attachedTo && o.id === s.attachedTo) || (!!o.lki && (o.attachments || []).includes(s.id)); // leaves-the-battlefield look-back

      if (typeof who === "object") return this.matches(o, who, ctx, "*");
      if (typeof who === "string") return this.matches(o, who, ctx, "*");
      return false;
    };
    const whoPlayer = (who, p) => {
      if (who == null || who === "each" || who === "any" || who === "eachPlayer") return true;
      if (p == null) return false;
      if (who === "you") return p === ctrl;
      if (who === "opponent") return p !== ctrl;
      if (who === "self") return evt.obj ? evt.obj.id === s.id : false;
      if (typeof who === "object") return who.player ? this.matchesPlayer(p, who, ctx) : evt.obj ? this.matches(evt.obj, who, ctx, "*") : false;
      return false;
    };
    switch (evt.type) {
      case "enters":
        if (!whoObj(on.who, evt.obj)) return false;
        if (on.from && evt.from !== on.from) return false;
        if (on.fromYours && evt.obj && evt.obj.owner !== ctrl) return false;
        if (on.filter && !this.matches(evt.obj, on.filter, ctx, "*")) return false;
        return true;
      case "dies": case "leaves": case "attacks": case "blocks": case "becomesBlocked": case "dealtDamage": case "counterAdded": case "becomesTarget": case "tapped": case "tokenCreated": case "cycled": case "landPlayed": case "exploits": case "untapped":
        if (!whoObj(on.who, evt.obj)) return false;
        if (on.filter && !this.matches(evt.obj, on.filter, ctx, "*")) return false;
        if (evt.type === "attacks" && on.alone && !evt.alone) return false;
        if (evt.type === "attacks" && on.defending === "you" && evt.player !== ctrl) return false; // "attacks you or a planeswalker you control"
        if (evt.type === "leaves" && on.to && on.to !== evt.to) return false;
        if (evt.type === "counterAdded" && on.kind && on.kind !== evt.kind) return false;
        if (evt.type === "tapped" && on.forMana != null && !!on.forMana !== !!evt.forMana) return false;
        if (evt.type === "becomesTarget" && on.by) { const by = evt.by; if (on.by === "spell" && (!by || by.isAbility)) return false; if (on.by === "opponent" && by && by.controller === ctrl) return false; }
        if (evt.type === "dealtDamage" && on.combat != null && !!on.combat !== !!evt.combat) return false;
        return true;
      case "sacrifice":
        if (on.who === "you" || on.who === "opponent" || on.who === "each") { if (!whoPlayer(on.who, evt.player)) return false; }
        else if (!whoObj(on.who, evt.obj)) return false;
        if (on.filter && !this.matches(evt.obj, on.filter, ctx, "*")) return false;
        return true;
      case "dealsDamage": case "dealsCombatDamage": {
        if (!!on.batch !== !!evt.batch) return false;
        if (evt.batch) {
          const parts = evt.parts.filter((pt) => whoObj(on.who, pt.source));
          if (!parts.length) return false;
          this._evtOverride = { ...evt, amount: parts.reduce((n, pt) => n + pt.amount, 0), objs: parts.map((pt) => pt.source), source: parts[0].source, obj: parts[0].source };
        } else if (!whoObj(on.who, evt.source)) return false;
        const to = on.to || "any";
        const tp = isPid(evt.target) ? +evt.target.slice(1) : null;
        if (to === "player" && tp == null) return false;
        if (to === "opponent" && (tp == null || tp === ctrl)) return false;
        if (to === "you" && tp !== ctrl) return false;
        if (to === "creature" && (tp != null || !this.state.objects[evt.target]?.c.types.includes("creature"))) return false;
        if (on.combat != null && !!on.combat !== !!evt.combat) return false;
        return true;
      }
      case "beginStep": {
        const step = on.step === "precombatMain" || on.step === "firstMain" ? "main1" : on.step === "endStep" ? "end" : on.step;
        if (step && step !== evt.step) return false;
        if (on.first && evt.step === "main1" && evt.mainIndex > 0) return false;
        const w = on.whose ?? on.who ?? "each";
        if (w === "monarch") return this.state.monarch != null && evt.player === this.state.monarch;
        if (delayed && delayed.turn === this.state.turn && delayed.step === evt.step) return false;
        if (delayed && on.next === "turn" && delayed.turn === this.state.turn) return false;
        return whoPlayer(w, evt.player);
      }
      case "cast":
        if (evt.copy && !on.orCopy) return false;
        if (on.who === "self") { if (!evt.obj || evt.obj.id !== s.id) return false; }
        else if (!whoPlayer(on.who, evt.player)) return false;
        if (on.filter && !this.matches(evt.obj, on.filter, ctx, "*")) return false;
        return true;
      case "zoneChange":
        if (on.from && evt.from !== on.from) return false;
        if (on.to && evt.to !== on.to) return false;
        if (on.notFrom && evt.from === on.notFrom) return false;
        if (on.filter && !this.matches(evt.obj, on.filter, ctx, "*")) return false;
        return true;
      case "abilityActivated":
        if (on.nonMana && evt.isMana) return false;
        if (on.who == null || on.who === "you" || on.who === "opponent" || on.who === "each") { if (!whoPlayer(on.who ?? "each", evt.player)) return false; }
        else if (!whoObj(on.who, evt.obj)) return false;
        if (on.filter && !this.matches(evt.obj, on.filter, ctx, "*")) return false;
        return true;
      case "becameMonarch": return whoPlayer(on.who, evt.player);
      case "milledCards": // batch: "whenever one or more nonland cards are milled"
        if (!whoPlayer(on.who ?? "each", evt.player)) return false;
        if (on.nonland && !evt.nonland) return false;
        this._evtOverride = { ...evt, amount: on.nonland ? evt.nonland : evt.objs.length };
        return true;
      case "milled": // per card: "whenever a player mills a nonland card"
        if (!whoPlayer(on.who ?? "each", evt.player)) return false;
        if (on.nonland && evt.obj.def.types.includes("land")) return false;
        return true;
      case "chapter":
        if (!whoObj(on.who ?? "self", evt.obj)) return false;
        return !on.chapters || on.chapters.includes(evt.n);
      case "mutates": case "turnedFaceUp":
        return whoObj(on.who ?? "self", evt.obj);
      case "gainLife": case "loseLife": case "draw": case "discard": case "ringTempts": case "ringBearerChosen": case "scry":
        if (!whoPlayer(on.who, evt.player)) return false;
        if (on.filter && evt.obj && !this.matches(evt.obj, on.filter, ctx, "*")) return false;
        if (evt.type === "draw" && on.nth && evt.nth !== on.nth) return false;
        return true;
      default:
        return false;
    }
  }

  /** Push an engine-synthesised trigger. */
  pendInternal(source, controller, ab, event) {
    this.state.pendingTriggers.push({ sourceId: source?.id ?? null, source, ab, controller, event: event || null });
  }

  *putTriggersOnStack$() {
    const st = this.state;
    let rounds = 0;
    while (st.pendingTriggers.length && !this.over) {
      if (++rounds > MAX_TRIGGER_ROUNDS) { this.drawGame("trigger loop"); return; }
      const list = st.pendingTriggers.splice(0);
      const order = this.apnap(this.state.players.map((p) => p.idx));
      for (const p of order) for (const t of list) if (t.controller === p) yield* this.putTriggerOnStack$(t);
      for (const t of list) if (!this.state.players[t.controller]) yield* this.putTriggerOnStack$({ ...t, controller: st.active });
    }
  }

  *putTriggerOnStack$(t) {
    const st = this.state;
    const ab = t.ab;
    const real = t.sourceId ? st.objects[t.sourceId] : null;
    const source = real || t.source;
    const srcName = source?.c?.name || t.source?.c?.name || "Delayed trigger";
    const ctx = { ...(t.delayed ? t.delayed.ctx : {}), source, you: t.controller, event: t.event, x: t.delayed?.ctx?.x ?? 0, it: t.delayed?.ctx?.it || [], trigger: true };
    let targets = [], modes = null, modeTargets = null;
    if (ab.modes && Array.isArray(ab.modes.modes)) {
      const r = yield* this.chooseModes$(t.controller, ab.modes, source, ctx);
      if (!r) { this.log(`${srcName}'s ability has no legal mode and is removed`); return; }
      modes = r.modes; modeTargets = r.modeTargets;
    }
    if (ab.targets && ab.targets.length) {
      const r = yield* this.chooseTargets$(t.controller, ab.targets, source, ctx, ab.effects);
      if (!r) { this.log(`${srcName}'s triggered ability has no legal targets`); return; }
      targets = r;
      ctx.division = yield* this.chooseDivision$(t.controller, ab.effects || [], targets, source, ctx);
    }
    const a = this.newAbilityObj(source, t.controller, ab, ctx, { trigger: true, targets, modes, modeTargets, specs: ab.targets || [] });
    const tgtText = a.targets.length ? ` targeting ${a.targets.map((id) => this.nameOf(id)).join(", ")}` : "";
    this.emit({ t: "ability", obj: a.id, source: source?.id ?? null, player: t.controller, targets: a.targets, trigger: true, text: `${srcName} triggers${tgtText}${ab.text ? ` — ${shorten(ab.text)}` : ""}` });
    this.afterTargeting(a);
  }

  newAbilityObj(source, controller, ab, ctx, { trigger = false, targets = [], modes = null, modeTargets = null, specs = [] } = {}) {
    const st = this.state;
    const id = "o" + st.nextId++;
    const srcName = source?.c?.name || "Ability";
    const a = {
      id, owner: controller, controller, zone: "stack", isAbility: true, sourceId: source?.id ?? null, sourceTs: source?.ts ?? null, trigger, ab, ctx,
      _targets: targets, _targetSpecs: specs, _modes: modes, _modeTargets: modeTargets,
      targets: [...targets.flat(), ...(modeTargets ? modeTargets.flat(2) : [])], text: ab.text || "", counters: {}, attachments: [], ts: ++st.ts,
      c: { name: `${srcName} ${trigger ? "trigger" : "ability"}`, types: [], subtypes: [], supertypes: [], colors: source?.c?.colors || [], keywords: {}, abilities: [], text: ab.text || "", img: source?.c?.img || null, cmc: 0, unparsed: [] },
    };
    st.objects[id] = a;
    st.stack.push(id);
    this.markDirty();
    return a;
  }

  // ================================================================ state-based actions
  *sba$() {
    const st = this.state;
    for (let loop = 0; loop < MAX_SBA_LOOPS; loop++) {
      if (this.over) return;
      this.refresh();
      this.beginBatch();
      let acted = false;
      for (const pl of st.players) {
        if (pl.lost) continue;
        if (pl.life <= 0) this.playerLoses(pl.idx, "life total reached 0");
        else if (pl.poison >= 10) this.playerLoses(pl.idx, "ten poison counters");
        else if (pl.drewFromEmpty) this.playerLoses(pl.idx, "drew from an empty library");
        else if (this.options.commander) for (const [cid, n] of Object.entries(pl.commanderDamage)) if (n >= 21) { this.playerLoses(pl.idx, `21 combat damage from ${this.nameOf(cid)}`); break; }
      }
      if (this.over) return;
      const toGy = [], toDestroy = [], toSac = [];
      for (const id of st.battlefield) {
        const o = st.objects[id];
        const c = o.c;
        if (c.types.includes("creature")) {
          if (c.toughness <= 0) { toGy.push(o); continue; }
          if ((o.damage >= this.lethalThreshold(o) || (o.deathtouched && o.damage > 0)) && !this.hasKw(o, "indestructible")) { toDestroy.push(o); continue; }
        }
        if (c.types.includes("planeswalker") && (o.counters.loyalty | 0) <= 0) { toGy.push(o); continue; }
        if (c.subtypes.includes("saga") && this.sagaDone(o)) { toSac.push(o); continue; }
        if (o.counters["+1/+1"] && o.counters["-1/-1"]) { const m = Math.min(o.counters["+1/+1"], o.counters["-1/-1"]); o.counters["+1/+1"] -= m; o.counters["-1/-1"] -= m; if (!o.counters["+1/+1"]) delete o.counters["+1/+1"]; if (!o.counters["-1/-1"]) delete o.counters["-1/-1"]; acted = true; this.markDirty(); }
        const isAura = c.subtypes.includes("aura");
        if (isAura) {
          const h = o.attachedTo && st.objects[o.attachedTo];
          if (!h || h.zone !== "battlefield" || !this.auraLegal(o, h)) { toGy.push(o); continue; }
        } else if (o.attachedTo) {
          const h = st.objects[o.attachedTo];
          if (!h || h.zone !== "battlefield" || (c.subtypes.includes("equipment") && (!h.c.types.includes("creature") || this.protectedFrom(h, o))) || c.types.includes("creature")) {
            if (h) h.attachments = h.attachments.filter((x) => x !== o.id);
            o.attachedTo = null; acted = true; this.markDirty();
          }
        }
      }
      for (const o of toGy) { if (o.zone === "battlefield") { this.moveObj(o, "graveyard"); acted = true; } }
      for (const o of toDestroy) { if (o.zone === "battlefield") { this.moveObj(o, "graveyard", { cause: "destroy" }); acted = true; } }
      for (const o of toSac) { if (o.zone === "battlefield" && this.sacrifice(o)) acted = true; }
      // legend rule
      const groups = new Map();
      for (const id of st.battlefield) {
        const o = st.objects[id];
        if (!o.c.supertypes.includes("legendary")) continue;
        const k = o.controller + "|" + o.c.name;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(o);
      }
      for (const [, list] of groups) {
        if (list.length < 2) continue;
        const p = list[0].controller;
        const keep = yield* this.chooseObjects$(p, list, { prompt: `Legend rule: choose the ${list[0].c.name} to keep`, min: 1, max: 1, reason: "generic", hint: { kind: "keep" } });
        for (const o of list) if (o !== keep[0] && o.zone === "battlefield") this.moveObj(o, "graveyard");
        acted = true;
      }
      // commander zone replacement (903.9a)
      for (const pl of st.players) for (const cid of pl.commanders) {
        const o = st.objects[cid];
        if (!o || !o.cmdPending) continue;
        o.cmdPending = false;
        if (!["graveyard", "exile", "hand", "library"].includes(o.zone)) continue;
        const yes = yield* this.confirm$(o.owner, `Return ${o.c.name} to the command zone?`, o.id, { kind: "commander" });
        if (yes) { this.moveObj(o, "command"); acted = true; }
      }
      // ring-bearer validity
      for (const pl of st.players) if (pl.ring.bearer) { const b = st.objects[pl.ring.bearer]; if (b && b.zone === "phased") continue; if (!b || b.zone !== "battlefield" || b.controller !== pl.idx || !b.c.types.includes("creature")) { pl.ring.bearer = null; this.markDirty(); } }
      if (!acted) return;
    }
    this.drawGame("state-based action loop");
  }

  /** Damage that is lethal for a creature: its toughness, or its power under a `lethalByPower` static (Zilortha). */
  lethalThreshold(o) {
    const c = o.c;
    for (const s of this._statics) if (s.st.type === "lethalByPower" && (!s.st.affects || this.matches(o, s.st.affects, { source: s.src, you: s.you }))) return Math.max(0, c.power | 0);
    return c.toughness;
  }

  /** §7 helper: cast `o` without paying its mana cost (normal mode/target/additional-cost prompts). Returns true if it went on the stack. */
  *castFree$(p, o, opts = {}) {
    if (!o || o.zone === "gone" || o.zone === "stack" || !o.def || o.def.types.includes("land")) return false;
    yield* this.cast$(p, { type: "cast", obj: o.id, objRef: o, _v: { variant: "free", face: opts.face | 0 } });
    return o.zone === "stack";
  }

  auraLegal(aura, host) {
    if (this.protectedFrom(host, aura)) return false;
    const d = this.faceDef(aura);
    let what = null;
    const ench = d.keywords?.enchant;
    if (ench && typeof ench === "object") what = ench;
    else if (typeof ench === "string") what = { types: [ench.toLowerCase().replace(/s$/, "")] };
    if (!what) { const t = d.spell?.targets?.[0]; if (t && typeof t.what === "object") what = { ...t.what }; }
    if (!what) return true;
    const w = { ...what };
    delete w.controller; // control may change after attaching
    return this.matches(host, w, { source: aura, you: aura.controller }, "*");
  }

  playerLoses(p, reason) {
    const pl = this.state.players[p];
    if (!pl || pl.lost) return;
    pl.lost = true;
    this.emit({ t: "lose", player: p, reason, text: `${pl.name} loses the game (${reason})` });
    // remove their objects (multiplayer cleanup)
    const alive = this.alivePlayers();
    if (alive.length <= 1) this.endGame(alive.length ? alive[0] : null, alive.length ? "last player standing" : "all players lost");
    else {
      for (const id of [...this.state.battlefield]) { const o = this.state.objects[id]; if (o.owner === p) this.moveObj(o, "exile", { quiet: true }); else if (o.controller === p) { this.state.controlEffects = this.state.controlEffects.filter((c) => c.objId !== id); o.baseController = o.owner; } }
      this.state.stack = this.state.stack.filter((id) => this.state.objects[id].controller !== p);
      this.markDirty();
    }
  }
  endGame(winner, reason) {
    if (this.over) return;
    try { this.revealFaceDown(); } catch { /* never block the end of the game */ }
    this.over = true;
    this.winner = winner;
    this.request = null;
    if (winner != null) this.emit({ t: "win", player: winner, reason, text: `${this.pname(winner)} wins the game` });
    else this.emit({ t: "win", player: null, reason, text: `The game is a draw (${reason})` });
  }
  drawGame(reason) {
    for (const p of this.state.players) if (!p.lost) p.lost = false;
    this.endGame(null, reason);
  }

  // ================================================================ priority & stack
  *checkpoint$() {
    let guard = 0;
    while (!this.over) {
      yield* this.sba$();
      if (this.over) return;
      if (!this.state.pendingTriggers.length) return;
      yield* this.putTriggersOnStack$();
      if (++guard > MAX_TRIGGER_ROUNDS) { this.drawGame("trigger loop"); return; }
    }
  }

  *priorityRound$() {
    const st = this.state;
    let p = st.active, passes = 0, resolves = 0;
    while (!this.over) {
      yield* this.checkpoint$();
      if (this.over) return;
      if (st.players[p].lost) { p = this.nextPlayer(p); continue; }
      if (st.requestsThisTurn > MAX_REQUESTS_PER_TURN) { this.drawGame("turn did not end"); return; }
      st.priority = p;
      this.refresh();
      const acts = this.legalActions(p);
      const req = this.mkReq({ kind: "priority", player: p, prompt: st.stack.length ? `Respond to ${this.nameOf(st.stack[st.stack.length - 1])}?` : `${cap(stepLabel(st.step))} — your move`, actions: acts.map(publicAction) }, { actions: acts });
      const ans = yield req;
      if (this.over) return;
      if (ans.type === "pass") {
        passes++;
        if (passes >= this.alivePlayers().length) {
          if (!st.stack.length) { st.priority = null; return; }
          yield* this.resolveTop$();
          passes = 0;
          p = st.active;
          if (++resolves > MAX_RESOLVES_NO_ACTION) { this.drawGame("endless loop on the stack"); return; }
          continue;
        }
        p = this.nextPlayer(p);
      } else {
        const act = (req._i ? req._i.actions : acts)[ans.index];
        try { yield* this.doAction$(p, act); }
        catch (err) { if (err && err.engineFatal) throw err; this.manual(act?.objRef, `Action failed: ${err && err.message}`); }
        passes = 0;
        if (!act.mana) resolves = 0;
      }
    }
  }

  *resolveTop$() {
    const st = this.state;
    const id = st.stack[st.stack.length - 1];
    const o = st.objects[id];
    if (!o) { st.stack.pop(); return; }
    this.beginBatch();
    try {
      if (o.isAbility) yield* this.resolveAbility$(o);
      else yield* this.resolveSpell$(o);
    } catch (err) {
      if (err && err.engineFatal) throw err;
      this.manual(o, `could not be resolved automatically (${err && err.message})`);
      if (o.zone === "stack") { this.removeFromStack(o); if (o.isAbility || o.isCopy) o.zone = "gone"; else this.moveObj(o, "graveyard"); }
    }
    this.refresh();
  }

  *resolveAbility$(a) {
    this.removeFromStack(a);
    a.zone = "gone";
    const ab = a.ab || {};
    const ctx = { ...a.ctx, targets: a._targets, targetSpecs: a._targetSpecs, it: a.ctx?.it || [], prev: 0, abilityObj: a };
    const src = a.sourceId ? this.state.objects[a.sourceId] : null;
    if (src) ctx.source = src; // live object (may be in another zone now)
    const name = a.c.name;
    if (!this.pruneTargets(a, ctx)) { this.emit({ t: "countered", obj: a.id, text: `${name} is removed (all targets illegal)` }); return; }
    if (ab.condition && a.trigger) { let ok = false; try { ok = this.evalCond(ab.condition, ctx); } catch { ok = false; } if (!ok) { this.log(`${name}: condition no longer true`); return; } }
    if (ab.optional) {
      const yes = yield* this.confirm$(a.controller, `${a.c.name.replace(/ (trigger|ability)$/, "")}: ${ab.text ? shorten(ab.text, 90) : "use this ability"}?`, a.sourceId, { kind: "may", effects: ab.effects || [] });
      if (!yes) return;
    }
    this.emit({ t: "resolve", obj: a.id, text: `${name} resolves` });
    if (usesResolvedCount(ab)) { // "if this is the second time this ability has resolved this turn" (per object, per ability)
      const st = this.state, key = `${a.sourceId}:${a.sourceTs}:${ab.text || ""}`;
      st.resolutions ||= {};
      if (!st.resolutions[key] || st.resolutions[key].turn !== st.turn) st.resolutions[key] = { turn: st.turn, n: 0 };
      ctx.resolvedCount = ++st.resolutions[key].n;
    }
    if (typeof ab.run === "function") { yield* ab.run(this, ctx); return; }
    yield* this.runEffects$(ab.effects || [], ctx);
    if (a._modes) for (let i = 0; i < a._modes.length; i++) {
      const m = ab.modes.modes[a._modes[i]];
      if (!m) continue;
      yield* this.runEffects$(m.effects || [], { ...ctx, targets: a._modeTargets[i] || [], targetSpecs: m.targets || [] });
    }
  }

  *resolveSpell$(o) {
    if (o.castVariant === "mutate") { yield* this.resolveMutate$(o); return; }
    const d = this.faceDef(o);
    const ctx = this.spellCtx(o);
    if (!this.pruneTargets(o, ctx)) {
      this.removeFromStack(o);
      this.emit({ t: "countered", obj: o.id, text: `${o.c.name} fizzles (all targets illegal)` });
      this.moveObj(o, o.castVariant === "flashback" || o.castVariant === "escape" ? "exile" : "graveyard", { quiet: true });
      return;
    }
    this.emit({ t: "resolve", obj: o.id, text: `${o.c.name} resolves` });
    if (isPermanentCard(d)) {
      this.removeFromStack(o);
      const isAura = d.subtypes.includes("aura");
      const attachTo = isAura ? ctx.targets?.[0]?.[0] : null;
      if (o.isCopy) { o.isCopy = false; o.token = true; }
      yield* this.enter$(o, { controller: o.controller, attachTo, keepCast: true, counters: o.castVariant === "escape" && d.keywords?.escapeCounters ? { "+1/+1": d.keywords.escapeCounters } : undefined });
      return;
    }
    const spell = d.spell || {};
    if (typeof spell.run === "function") yield* spell.run(this, ctx);
    else {
      yield* this.runEffects$(spell.effects || [], ctx);
      if (o._modes && spell.modes) for (let i = 0; i < o._modes.length; i++) {
        const m = spell.modes.modes[o._modes[i]];
        if (!m) continue;
        yield* this.runEffects$(m.effects || [], { ...ctx, targets: o._modeTargets[i] || [], targetSpecs: m.targets || [] });
        if (this.over) return;
      }
    }
    if (o.zone === "stack") {
      this.removeFromStack(o);
      if (o.isCopy) { o.zone = "gone"; return; }
      const exileIt = o.castVariant === "flashback" || o.castVariant === "escape" || d.keywords?.exileOnResolve;
      if (o.castVariant === "adventure") { this.moveObj(o, "exile", { quiet: true }); o.onAdventure = true; this.log(`${o.c.name} goes on an adventure`); }
      else this.moveObj(o, exileIt ? "exile" : "graveyard", { quiet: true });
    }
  }

  spellCtx(o) {
    return {
      source: o, you: o.controller, targets: o._targets || [], targetSpecs: o._targetSpecs || [], x: o.x | 0, kicked: !!o.kicked,
      modes: o._modes || [], sacrificed: o._sacrificed || [], overload: o.castVariant === "overload", overloadSpecs: this.faceDef(o).spell?.targets || [], it: [], prev: 0, event: null,
      division: o._division || null, manaSpent: o.manaSpent | 0,
    };
  }

  counterObj(o, by) {
    if (!o || o.zone !== "stack") return false;
    if (!o.isAbility) {
      const d = this.faceDef(o);
      if (d.keywords?.cantBeCountered || d.abilities.some((a) => a.kind === "static" && a.effect?.type === "cantBeCountered" && (a.effect.affects == null || a.effect.affects === "self"))) { this.log(`${o.c.name} can't be countered`); return false; }
      if (this._statics.some((s) => s.st.type === "cantBeCountered" && s.st.affects && s.st.affects !== "self" && this.matches(o, s.st.affects, { source: s.src, you: s.you }, "*"))) { this.log(`${o.c.name} can't be countered`); return false; }
    }
    this.removeFromStack(o);
    this.emit({ t: "countered", obj: o.id, text: `${o.c.name} is countered${by?.c?.name ? ` by ${by.c.name}` : ""}` });
    if (o.isAbility || o.isCopy) o.zone = "gone";
    else this.moveObj(o, o.castVariant === "flashback" || o.castVariant === "escape" ? "exile" : "graveyard", { quiet: true });
    return true;
  }

  copyStackObject(o, controller) {
    const st = this.state;
    const id = "o" + st.nextId++;
    const c = { ...o, id, controller, owner: controller, isCopy: true, ts: ++st.ts, counters: {}, attachments: [], ctx: o.ctx ? { ...o.ctx, you: controller } : o.ctx };
    st.objects[id] = c;
    st.stack.push(id);
    this.emit({ t: "cast", obj: id, player: controller, targets: c.targets, copy: true, text: `${this.pname(controller)} copies ${o.c.name}` });
    if (!o.isAbility) this.fireTrigger({ type: "cast", obj: c, player: controller, copy: true });
    this.markDirty();
    return c;
  }

  /** Remove now-illegal targets. Returns false if the object had targets and none remain legal. */
  pruneTargets(o, ctx) {
    let had = 0, left = 0;
    const src = o.isAbility ? (o.sourceId ? this.state.objects[o.sourceId] : null) || o : o;
    const prune = (groups, specs) => groups.map((g, i) => {
      had += g.length;
      const spec = specs[i] || {};
      const keep = g.filter((id) => this.isLegalTarget(id, spec, src, o.controller, { ...ctx, source: src }, true));
      left += keep.length;
      return keep;
    });
    if (o._targets && o._targets.length) { ctx.targets = prune(o._targets, o._targetSpecs || []); }
    if (o._modeTargets) {
      const modesDef = o.isAbility ? o.ab?.modes?.modes : this.faceDef(o).spell?.modes?.modes;
      o._modeTargets = o._modeTargets.map((g, i) => prune(g, modesDef?.[o._modes[i]]?.targets || []));
    }
    return !(had > 0 && left === 0);
  }

  /** After a spell/ability is put on the stack: becomesTarget triggers + ward. */
  afterTargeting(stackObj) {
    const ids = [...new Set(stackObj.targets || [])];
    for (const id of ids) {
      if (isPid(id)) continue;
      const t = this.state.objects[id];
      if (!t || t.zone !== "battlefield") continue;
      this.fireTrigger({ type: "becomesTarget", obj: t, by: stackObj, player: t.controller });
      const ward = this.keywordOf(t, "ward");
      if (ward && stackObj.controller !== t.controller) {
        this.pendInternal(t, t.controller, { kind: "triggered", text: `Ward ${typeof ward === "string" ? ward : ""}`, effects: [{ op: "_ward", stackObj: stackObj.id, cost: typeof ward === "string" ? ward : "{0}" }] }, { type: "becomesTarget", obj: t });
      }
    }
  }

  // ================================================================ the Ring
  *ringTempts$(p) {
    const st = this.state;
    const pl = st.players[p];
    if (!pl || pl.lost) return;
    pl.ring.level = Math.min(4, pl.ring.level + 1);
    const cands = st.battlefield.map((id) => st.objects[id]).filter((o) => o.controller === p && o.c.types.includes("creature"));
    let bearer = null;
    if (cands.length) {
      const ch = yield* this.chooseObjects$(p, cands, { prompt: "The Ring tempts you — choose your Ring-bearer", min: 1, max: 1, reason: "generic", hint: { kind: "ringBearer" } });
      bearer = ch[0] || null;
    }
    pl.ring.bearer = bearer ? bearer.id : null;
    pl.ringTempted = (pl.ringTempted | 0) + 1;
    this.markDirty();
    this.refresh();
    this.emit({ t: "ring", player: p, level: pl.ring.level, bearer: pl.ring.bearer, text: `The Ring tempts ${pl.name} (level ${pl.ring.level})${bearer ? ` — ${bearer.c.name} is the Ring-bearer` : ""}` });
    this.fireTrigger({ type: "ringTempts", player: p, obj: bearer });
    if (bearer) this.fireTrigger({ type: "ringBearerChosen", player: p, obj: bearer });
  }

  ringTriggers(evt) {
    const st = this.state;
    if (evt.type === "attacks") {
      const o = evt.obj, pl = st.players[o.controller];
      if (pl && pl.ring.bearer === o.id && pl.ring.level >= 2)
        this.pendInternal(o, o.controller, { kind: "triggered", text: "Ring-bearer attacks: draw a card, then discard a card", effects: [{ op: "draw", who: "you", amount: 1 }, { op: "discard", who: "you", amount: 1 }] }, evt);
    } else if (evt.type === "becomesBlocked") {
      const o = evt.obj, pl = st.players[o.controller];
      if (pl && pl.ring.bearer === o.id && pl.ring.level >= 3 && st.combat) {
        const ids = [...(evt.blockers || [])];
        this.pendInternal(o, o.controller, { kind: "triggered", text: "Ring-bearer blocked: blockers are sacrificed at end of combat",
          effects: [{ op: "delayed", at: { event: "beginStep", step: "endCombat", whose: "each" }, effects: [{ op: "_sacrificeObjs", ids }] }] }, evt);
      }
    } else if (evt.type === "dealsCombatDamage" && isPid(evt.target)) {
      const o = evt.source, pl = o && st.players[o.controller];
      if (pl && pl.ring.bearer === o.id && pl.ring.level >= 4)
        this.pendInternal(o, o.controller, { kind: "triggered", text: "Ring-bearer dealt combat damage: each opponent loses 3 life", effects: [{ op: "loseLife", who: "opponent", amount: 3 }] }, evt);
    }
  }

  // ================================================================ turn structure
  *main$() {
    const st = this.state;
    const n = st.players.length;
    if (!n) { this.endGame(null, "no players"); return; }
    const fp = this.options.firstPlayer;
    st.active = Number.isInteger(fp) && fp >= 0 && fp < n ? fp : Math.floor(this.rng() * n);
    this.firstPlayer = st.active;
    for (const pl of st.players) this.shuffle(pl.idx, true);
    yield* this.mulligans$();
    let first = true;
    while (!this.over) {
      if (!first) {
        if (st.extraTurns.length) st.active = st.extraTurns.shift();
        else st.active = this.nextPlayer(st.active);
      }
      first = false;
      yield* this.turn$();
      if (!this.over && this.options.maxTurns && st.turn >= this.options.maxTurns) this.drawGame(`turn limit (${this.options.maxTurns}) reached`);
    }
  }

  *mulligans$() {
    const st = this.state;
    const hs = this.options.handSize;
    const order = this.apnap(st.players.map((p) => p.idx));
    for (const p of order) this.drawQuiet(p, hs);
    for (const p of order) {
      const pl = st.players[p];
      let m = 0;
      while (m < hs) {
        const free = !!(this.options.commander && this.options.freeMulligan && m === 0);
        const ans = yield { kind: "mulligan", player: p, prompt: m ? `Keep this hand? (mulligans so far: ${m})` : "Keep your opening hand?", mulligans: m, free };
        if (ans.keep) break;
        m++;
        for (const id of [...pl.hand]) this.moveObj(st.objects[id], "library", { quiet: true });
        this.shuffle(p, true);
        this.drawQuiet(p, hs);
        this.log(`${pl.name} mulligans`);
      }
      const bottom = Math.max(0, m - (this.options.commander && this.options.freeMulligan ? 1 : 0));
      if (bottom > 0 && pl.hand.length) {
        const n = Math.min(bottom, pl.hand.length);
        const ch = yield* this.chooseObjects$(p, pl.hand.map((id) => st.objects[id]), { prompt: `Put ${n} card${n > 1 ? "s" : ""} on the bottom of your library`, min: n, max: n, reason: "bottom" });
        for (const o of ch) this.moveObj(o, "library", { position: "bottom", quiet: true });
      }
      this.log(`${pl.name} keeps ${pl.hand.length} card${pl.hand.length === 1 ? "" : "s"}`);
    }
  }
  drawQuiet(p, n) {
    const pl = this.state.players[p];
    for (let i = 0; i < n && pl.library.length; i++) this.moveObj(this.state.objects[pl.library[pl.library.length - 1]], "hand", { quiet: true });
  }

  *step$(name) {
    const st = this.state;
    st.step = name;
    st.priority = null;
    this.emit({ t: "step", step: name, text: stepLabel(name) });
  }
  emptyPools() { for (const pl of this.state.players) { pl.mana = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }; pl.manaX = []; } }

  *turn$() {
    const st = this.state;
    const a = st.active;
    const pl = st.players[a];
    st.turn++;
    st.requestsThisTurn = 0;
    st.spellsThisTurn = 0;
    st.extraCombats = 0;
    st.mainIndex = 0;
    for (const q of st.players) { q.landsPlayed = 0; q.lifeLostThisTurn = 0; q.lifeGainedThisTurn = 0; }
    this.emit({ t: "turn", player: a, n: st.turn, text: `Turn ${st.turn} — ${pl.name}` });
    // untap
    yield* this.step$("untap");
    this.expireEffects("yourNextTurn", a);
    this.phaseIn(a);
    for (const id of st.battlefield) { const o = st.objects[id]; if (o.controller === a) { o.sick = false; if (o.tapped && !this.hasKw(o, "doesn't untap") && !o.c.doesntUntap) this.untap(o, true); } }
    this.markDirty();
    this.refresh();
    // upkeep
    yield* this.beginStep$("upkeep");
    if (this.over) return;
    // draw
    yield* this.step$("draw");
    const skipDraw = st.turn === 1 && !this.options.commander && st.players.length === 2;
    if (!skipDraw) yield* this.drawCards$(a, 1);
    this.fireTrigger({ type: "beginStep", step: "draw", player: a });
    yield* this.priorityRound$();
    this.emptyPools();
    if (this.over) return;
    // main 1
    yield* this.beginStep$("main1");
    if (this.over) return;
    // combat (+ extra combats)
    yield* this.combatPhase$();
    while (!this.over && st.extraCombats > 0) { st.extraCombats--; yield* this.combatPhase$(); }
    if (this.over) return;
    st.mainIndex = 1;
    yield* this.beginStep$("main2");
    if (this.over) return;
    yield* this.beginStep$("end");
    if (this.over) return;
    // cleanup
    yield* this.cleanup$();
  }

  *beginStep$(name) {
    yield* this.step$(name);
    this.m4StepStart(name); // Sagas get a lore counter, rad counters, the monarch (engine-m4.js)
    this.fireTrigger({ type: "beginStep", step: name, player: this.state.active, mainIndex: this.state.mainIndex });
    yield* this.priorityRound$();
    this.emptyPools();
  }

  *cleanup$() {
    const st = this.state;
    for (let round = 0; round < 5 && !this.over; round++) {
      yield* this.step$("cleanup");
      const a = st.active, pl = st.players[a];
      const max = pl.noMaxHand ? Infinity : this.options.maxHandSize;
      if (pl.hand.length > max) {
        const n = pl.hand.length - max;
        const ch = yield* this.chooseObjects$(a, pl.hand.map((id) => st.objects[id]), { prompt: `Discard ${n} card${n > 1 ? "s" : ""} (hand size)`, min: n, max: n, reason: "discard" });
        for (const o of ch) this.discardCard(o);
      }
      for (const id of st.battlefield) { const o = st.objects[id]; o.damage = 0; o.deathtouched = false; }
      this.expireEffects("endOfTurn");
      this.expireMayPlay();
      this.markDirty();
      this.refresh();
      this.emptyPools();
      if (!st.pendingTriggers.length) break;
      yield* this.priorityRound$();
    }
  }

  /** "You may play that card this turn / until the end of your next turn" permissions end in the cleanup step. */
  expireMayPlay() {
    const st = this.state;
    for (const q of st.players) for (const id of q.exile) {
      const o = st.objects[id];
      const m = o && o.mayPlay;
      if (!m) continue;
      if (m.until === "endOfYourNextTurn" ? st.turn > m.turn && st.active === m.player : st.turn >= (m.untilTurn ?? m.turn)) o.mayPlay = null;
    }
  }

  expireEffects(kind, player) {
    const st = this.state;
    const keep = (e) => !(e.until === kind && (player == null || e.you === player));
    st.effects = st.effects.filter(keep);
    if (st.delayed.some((d) => d.until || d.untilEndOfTurnOf != null)) {
      st.delayed = st.delayed.filter((d) => !(d.until === kind && (player == null || d.controller === player)));
      if (kind === "yourNextTurn") for (const d of st.delayed) if (d.untilEndOfTurnOf === player && d.armedTurn == null) d.armedTurn = st.turn; // that player's turn has begun
      if (kind === "endOfTurn") st.delayed = st.delayed.filter((d) => d.armedTurn !== st.turn);
    }
    const before = st.controlEffects.length;
    st.controlEffects = st.controlEffects.filter(keep);
    if (before !== st.controlEffects.length) for (const id of st.battlefield) st.objects[id].sick = st.objects[id].sick; // controller recomputed in refresh
    this.markDirty();
  }
}

// mixins
Object.assign(Game.prototype, charMethods, manaMethods, effectMethods, actionMethods, combatMethods, extMethods);
Object.assign(Game.prototype, m4Methods); // library batch m4: Sagas, Classes, Battles, emblems, ...

export function publicAction(a) {
  const o = { type: a.type, obj: a.obj, label: a.label, zone: a.zone };
  if (a.cost != null) o.cost = a.cost;
  if (a.ability != null) o.ability = a.ability;
  if (a.mana) o.mana = true;
  if (a.variant) o.variant = a.variant;
  if (a.sacForMana) o.sacForMana = a.sacForMana;
  return o;
}

function stepLabel(s) {
  return { untap: "Untap step", upkeep: "Upkeep", draw: "Draw step", main1: "Main phase 1", beginCombat: "Beginning of combat", declareAttackers: "Declare attackers",
    declareBlockers: "Declare blockers", combatDamage: "Combat damage", firstStrikeDamage: "First-strike damage", endCombat: "End of combat", main2: "Main phase 2", end: "End step", cleanup: "Cleanup" }[s] || s;
}
/** Attach AI context to a request as a non-enumerable `_hint` (invisible to JSON / the UI). */
function setHint(req, hint) {
  if (hint) Object.defineProperty(req, "_hint", { value: hint, enumerable: false, writable: true, configurable: true });
}
const RC = new WeakMap();
function usesResolvedCount(ab) {
  if (!ab || typeof ab !== "object") return false;
  let v = RC.get(ab);
  if (v == null) { try { v = JSON.stringify(ab.effects || []).includes('"resolvedCount"'); } catch { v = false; } RC.set(ab, v); }
  return v;
}
function shorten(t, n = 70) { t = String(t || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; }
export { shorten, stepLabel };
