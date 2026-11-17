/* Binder: play your decks against an AI.
   Entry point loaded lazily by the app's #/play route.  mountLobby(screenEl, { app, deckId }) draws the
   lobby into the app shell; starting a match opens the full-screen overlay from ui-match.js. */

import { esc, pipsOfColors, cap, artCrop } from "./ui-card.js";
import { loadLobby, saveLobby, loadSave, clearSave, loadStats, loadHistory, loadSettings, saveSettings, lsGet, lsSet, lsDel } from "./ui-store.js";

/* ---------- backend loading (injectable so the dev harness can supply a mock) ---------- */
let loader = async () => {
  const [eng, ov, dk] = await Promise.all([import("./engine.js"), import("./overrides.js"), import("./decks.js")]);
  let ai = null;
  try { ai = await import("./ai.js"); } catch (e) { console.warn("ai.js unavailable; the opponent will only pass", e); }
  return { createGame: eng.createGame, compile: ov.compileCard, coverage: ov.coverage, buildDeck: dk.buildDeck, listDecks: dk.listDecks, decide: ai ? ai.decide : fallbackDecide, noAI: !ai };
};
export function configure(o) { if (o && o.loadBackend) { loader = o.loadBackend; backendP = null; } }
let backendP = null;
const backend = () => (backendP = backendP || loader().catch((e) => { backendP = null; throw e; }));

function fallbackDecide(game, req) {
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

let cssP = null;
export function loadCss() {
  if (cssP) return cssP;
  cssP = new Promise((resolve) => {
    if (document.querySelector("link[data-mtg-game]")) return resolve();
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = new URL("./game.css", import.meta.url).href; l.setAttribute("data-mtg-game", "1");
    l.onload = () => resolve(); l.onerror = () => resolve();
    document.head.appendChild(l);
  });
  return cssP;
}

const TRIM_DROP = ["prices", "finishes", "set_name", "released", "rarity"];
const trim = (c) => { const o = {}; Object.keys(c).forEach((k) => { if (TRIM_DROP.indexOf(k) < 0) o[k] = c[k]; }); return o; };
const trimDeck = (d) => ({ commanders: d.commanders.map(trim), cards: d.cards.map(trim) });
const canPlay = (d) => d.count > 0 && (!d.missing || d.count >= 40);
const shortName = (d) => String(d.name || "").split(" — ")[0];
const ago = (ts) => {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return "just now"; if (m < 60) return m + " min ago";
  const h = Math.round(m / 60); if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
  const d = Math.round(h / 24); return d + (d === 1 ? " day ago" : " days ago");
};

/* ---------- game creation ---------- */
function makeFactory(be, snap) {
  return (setup, seed) => {
    const you = snap.you, opp = snap.opp;
    return be.createGame({
      players: [
        { name: (setup.you && setup.you.name) || "You", deck: { commanders: you.commanders, cards: you.cards }, ai: false },
        { name: (setup.opp && setup.opp.name) || "Opponent", deck: { commanders: opp.commanders, cards: opp.cards }, ai: true },
      ],
      options: { startingLife: setup.life, commander: !!setup.commander, seed, firstPlayer: setup.first, handSize: 7, freeMulligan: setup.freeMulligan !== false },
      compile: be.compile,
    });
  };
}

async function openMatch(ctx, o) {
  const { Match } = await import("./ui-match.js");
  const settings = loadSettings();
  const factory = makeFactory(ctx.be, o.snap);
  const m = new Match({
    factory, decide: ctx.be.decide, setup: o.setup, seed: o.seed, answers: o.answers || [], ev: o.ev, settings, saveSettings,
    onExit: (reason) => { ctx.onExit && ctx.onExit(reason); },
  });
  ctx.match = m;
  if (lsGet("debug", false)) window.__mtgMatch = m;
  await m.open(!!o.restoring);
  return m;
}

/* ============================ lobby ============================ */
export async function mountLobby(screen, opts) {
  opts = opts || {};
  const app = opts.app;
  const L = { screen, app, deckId: opts.deckId || "", be: null, decks: [], cov: new Map(), covToken: 0, open: false };
  screen._lobby = L;
  await loadCss();
  screen.innerHTML = topbar("Play", "Test your decks against the AI") + '<div class="page narrow lb"><div class="loading"><span class="spin"></span><p>Loading the game…</p></div></div>';
  try {
    L.be = await backend();
  } catch (e) {
    console.error(e);
    screen.innerHTML = topbar("Play", "") + '<div class="page narrow lb"><div class="empty"><b>The game couldn’t be loaded</b>' + esc(e && e.message ? e.message : "Check your connection and try again. The rest of Binder still works.") + '<br><button class="btn pri" data-lb="retry">Try again</button></div></div>';
    wire(screen);
    return L;
  }
  L.refresh = () => { try { L.decks = L.be.listDecks(app.state); } catch (e) { L.decks = []; } if (!L.open && L.pref) draw(L); };
  L.decks = [];
  L.refresh();
  const pref = loadLobby();
  L.pref = pref;
  if (opts.deckId && L.decks.some((d) => d.id === opts.deckId)) pref.deckId = opts.deckId;
  if (!L.decks.some((d) => d.id === pref.deckId && canPlay(d))) pref.deckId = (L.decks.find((d) => canPlay(d)) || {}).id || "";
  if (pref.oppId !== "random" && !L.decks.some((d) => d.id === pref.oppId && canPlay(d))) pref.oppId = "random";
  wire(screen);
  draw(L);
  return L;
}

function topbar(title, sub) {
  return '<header class="topbar"><div class="bar-in"><div class="bar-row"><h1 class="bar-title">' + esc(title) + (sub ? "<small>" + esc(sub) + "</small>" : "") + "</h1></div></div></header>";
}

function deckCard(d, app, selected, kind) {
  const full = (app.state.decks || []).find((x) => x.id === d.id) || {};
  const title = d.name || shortName(d);
  const sub = d.commander || full.archetype || cap(d.format || "");
  const miss = typeof d.missing === "number" ? d.missing : (d.missing || []).length;
  const why = !canPlay(d) ? (d.count === 0 ? "This deck is empty." : miss + " cards couldn’t be loaded (open the app online once to fetch them).") : (miss ? miss + " cards couldn’t be loaded (open the app online once to fetch them). You can still play." : "");
  return '<button class="dk' + (selected ? " on" : "") + (canPlay(d) ? "" : " off") + '" data-lb="' + kind + '" data-id="' + esc(d.id) + '" aria-pressed="' + selected + '"' + (canPlay(d) ? "" : " disabled") + ">" +
    '<span class="dk-art"' + (d.art ? ' style="background-image:url(&quot;' + esc(artCrop(d.art)) + '&quot;)"' : "") + "></span>" +
    '<span class="dk-in"><b>' + esc(title) + '</b><small>' + esc(sub) + '</small><span class="dk-m">' + pipsOfColors(d.identity) + '<span class="num">' + d.count + " cards</span></span>" + (why ? '<em class="dk-why">' + esc(why) + "</em>" : "") + "</span></button>";
}

function seg(key, label, opts, cur) {
  return '<div class="lb-row"><span class="lb-l">' + label + '</span><div class="seg" role="group" aria-label="' + label + '">' + opts.map((o) => '<button data-lb="set" data-k="' + key + '" data-v="' + o[0] + '" aria-pressed="' + (String(cur) === String(o[0])) + '">' + o[1] + "</button>").join("") + "</div></div>";
}

function draw(L) {
  const { screen, app, pref } = L;
  const playable = L.decks.filter((d) => canPlay(d));
  const save = loadSave();
  const you = L.decks.find((d) => d.id === pref.deckId);
  let h = topbar("Play", "Test your decks against the AI") + '<div class="page narrow lb">';
  if (save && save.setup && save.answers) {
    h += '<div class="lb-res"><div class="lb-res-t"><b>Match in progress</b><span>' + esc((save.setup.you || {}).name || "You") + " vs " + esc((save.setup.opp || {}).name || "Opponent") + "</span>" +
      '<small class="muted">Turn ' + (save.turn || "?") + (save.life ? " · life " + save.life[0] + " – " + save.life[1] : "") + " · " + ago(save.ts || Date.now()) + '</small></div><div class="lb-res-b"><button class="btn pri" data-lb="resume">Resume</button><button class="btn" data-lb="discard" aria-label="Discard saved match">Discard</button></div></div>';
  }
  if (L.be.noAI) h += '<div class="lb-warn">The AI module isn’t installed, so your opponent will only pass.</div>';
  h += '<div class="sect"><h2>Your deck</h2></div>';
  h += playable.length || L.decks.length ? '<div class="lb-decks">' + L.decks.map((d) => deckCard(d, app, d.id === pref.deckId, "you")).join("") + "</div>" : '<div class="empty"><b>No decks yet</b>Build a deck first, then come back to play it.<br><a class="btn pri" href="#/decks">Go to decks</a></div>';
  h += '<div class="sect"><h2>Opponent</h2></div><div class="chips scroll lb-opps"><button class="chip" data-lb="opp" data-id="random" aria-pressed="' + (pref.oppId === "random") + '">Random deck</button>' +
    playable.map((d) => '<button class="chip" data-lb="opp" data-id="' + esc(d.id) + '" aria-pressed="' + (pref.oppId === d.id) + '">' + esc(d.name || shortName(d)) + "</button>").join("") + "</div>";
  h += '<div class="sect"><h2>Rules</h2></div><div class="panel pad lb-opt">' +
    seg("difficulty", "Difficulty", [["easy", "Easy"], ["normal", "Normal"], ["hard", "Hard"]], pref.difficulty) +
    seg("life", "Starting life", [["auto", "Auto"], ["20", "20"], ["30", "30"], ["40", "40"]], pref.life) +
    seg("first", "Goes first", [["random", "Random"], ["you", "You"], ["ai", "AI"]], pref.first) +
    '<div class="lb-row"><span class="lb-l">Free first mulligan</span><button class="tg' + (pref.freeMulligan ? " on" : "") + '" role="switch" aria-checked="' + !!pref.freeMulligan + '" data-lb="mull" aria-label="Free first mulligan"><i></i></button></div></div>';
  h += '<details class="lb-cov" id="lbCov"' + (L._covOpen ? " open" : "") + '><summary>Cards that are only partly automated</summary><div class="lb-cov-b" id="lbCovB">' + covHtml(L, you) + "</div></details>";
  h += '<div class="lb-cta"><button class="btn pri block lb-play" data-lb="play"' + (you ? "" : " disabled") + '>' + (you ? "Play" : "Pick a deck") + "</button></div>";
  h += statsHtml(L);
  h += "</div>";
  screen.innerHTML = h;
  const det = screen.querySelector("#lbCov");
  if (det) det.addEventListener("toggle", () => { L._covOpen = det.open; });
  scheduleCov(L, you);
}

function covHtml(L, you) {
  if (!you) return '<p class="muted">Pick a deck to see which cards are only partly automated.</p>';
  const c = L.cov.get(you.id);
  if (!c) return '<p class="muted">Checking cards…</p>';
  if (!c.list.length) return '<p class="muted">Every card in this deck is fully automated.</p>';
  return '<p class="muted">These still work as cards, but some of their text is not played for you. Use the manual tools during a match to apply it.</p><ul class="lb-covl">' + c.list.map((x) => "<li><b>" + esc(x.name) + "</b><span>" + x.unparsed.map(esc).join("; ") + "</span></li>").join("") + "</ul>";
}
function scheduleCov(L, you) {
  if (!you || L.cov.has(you.id)) { updateCovSummary(L, you); return; }
  const token = ++L.covToken;
  const run = () => {
    if (token !== L.covToken) return;
    try {
      const b = L.be.buildDeck(L.app.state, you.id);
      const seen = new Set(), list = [];
      b.commanders.concat(b.cards).forEach((c) => {
        if (seen.has(c.name)) return; seen.add(c.name);
        let cov; try { cov = L.be.coverage(c); } catch (e) { cov = null; }
        if (cov && !cov.full && cov.unparsed && cov.unparsed.length) list.push({ name: c.name, unparsed: cov.unparsed });
      });
      L.cov.set(you.id, { list, total: seen.size });
    } catch (e) { L.cov.set(you.id, { list: [], total: 0 }); }
    const box = L.screen.querySelector("#lbCovB");
    if (box && L.pref.deckId === you.id) { box.innerHTML = covHtml(L, you); updateCovSummary(L, you); }
  };
  (window.requestIdleCallback || ((f) => setTimeout(f, 60)))(run);
}
function updateCovSummary(L, you) {
  const s = L.screen.querySelector("#lbCov summary");
  const c = you && L.cov.get(you.id);
  if (s && c) s.textContent = c.list.length ? c.list.length + " of " + c.total + " cards are only partly automated" : "All cards in this deck are fully automated";
}

function statsHtml(L) {
  const st = loadStats(), hist = loadHistory();
  const ids = Object.keys(st.decks);
  if (!ids.length && !hist.length) return '<div class="sect"><h2>Record</h2></div><div class="panel pad muted">Your wins and losses will show up here after your first match.</div>';
  let h = '<div class="sect"><h2>Record</h2></div><div class="panel">';
  ids.forEach((id) => { const d = st.decks[id]; h += '<div class="row"><div class="main"><b>' + esc(d.name ? shortName({ name: d.name }) : id) + '</b></div><span class="num lb-rec"><b class="w">' + d.w + '</b> – <b class="l">' + d.l + "</b>" + (d.d ? " – " + d.d : "") + "</span></div>"; });
  h += "</div>";
  if (hist.length) {
    h += '<div class="sect"><h2>Recent matches</h2></div><div class="panel">' + hist.slice(0, 6).map((m) => '<div class="row"><span class="badge ' + (m.result === "win" ? "ok" : m.result === "loss" ? "bad" : "") + '">' + (m.result === "win" ? "Won" : m.result === "loss" ? "Lost" : "Draw") + '</span><div class="main"><b>' + esc(shortName({ name: m.deck || "" })) + "</b> vs " + esc(shortName({ name: m.opp || "" })) + '<div class="muted" style="font-size:13px">' + (m.turns ? "Turn " + m.turns + " · " : "") + cap(m.difficulty || "") + " · " + ago(m.ts) + "</div></div></div>").join("") + "</div>";
  }
  return h;
}

/* ---------- lobby events ---------- */
function wire(screen) {
  if (screen._lbWired) return;
  screen._lbWired = true;
  screen.addEventListener("click", (e) => {
    const el = e.target.closest("[data-lb]");
    if (!el || !screen._lobby) return;
    const L = screen._lobby, a = el.dataset.lb;
    const pref = L.pref;
    if (a === "retry") { backendP = null; mountLobby(screen, { app: L.app, deckId: L.deckId }); return; }
    if (!pref) return;
    if (a === "you") { pref.deckId = el.dataset.id; saveLobby(pref); draw(L); }
    else if (a === "opp") { pref.oppId = el.dataset.id; saveLobby(pref); draw(L); }
    else if (a === "set") { pref[el.dataset.k] = el.dataset.v; saveLobby(pref); draw(L); }
    else if (a === "mull") { pref.freeMulligan = !pref.freeMulligan; saveLobby(pref); draw(L); }
    else if (a === "play") startNew(L, el);
    else if (a === "resume") resume(L, el);
    else if (a === "discard") { clearSave(); lsDel("snap"); draw(L); }
  });
}

async function startNew(L, btn) {
  const pref = L.pref;
  const you = L.decks.find((d) => d.id === pref.deckId);
  if (!you) return;
  btn.disabled = true;
  const old = btn.textContent;
  btn.innerHTML = '<span class="spin" style="width:16px;height:16px"></span> Shuffling up…';
  try {
    const be = L.be;
    const pool = L.decks.filter((d) => canPlay(d));
    let opp = pool.find((d) => d.id === pref.oppId);
    if (!opp) opp = pool[Math.floor(Math.random() * pool.length)] || you;
    const yb = be.buildDeck(L.app.state, you.id), ob = be.buildDeck(L.app.state, opp.id);
    const life = pref.life === "auto" ? yb.startingLife : +pref.life;
    const seed = (Date.now() % 2147483646) + 1;
    const setup = {
      deckId: you.id, oppDeckId: opp.id, difficulty: pref.difficulty, life, commander: !!yb.isCommander,
      first: pref.first === "you" ? 0 : pref.first === "ai" ? 1 : null, freeMulligan: !!pref.freeMulligan,
      you: { name: shortName(you), art: yb.art || you.art }, opp: { name: shortName(opp), art: ob.art || opp.art },
    };
    const snap = { you: trimDeck(yb), opp: trimDeck(ob) };
    lsSet("snap", snap);
    await launch(L, { setup, seed, snap, answers: [] });
  } catch (e) {
    console.error(e);
    btn.disabled = false; btn.textContent = old;
    alert("Couldn’t start the match: " + (e && e.message ? e.message : e));
  }
}

async function resume(L, btn) {
  const save = loadSave();
  if (!save) return;
  btn.disabled = true;
  try {
    let snap = lsGet("snap", null);
    if (!snap) {
      const yb = L.be.buildDeck(L.app.state, save.setup.deckId), ob = L.be.buildDeck(L.app.state, save.setup.oppDeckId);
      snap = { you: trimDeck(yb), opp: trimDeck(ob) };
    }
    await launch(L, { setup: save.setup, seed: save.seed, snap, answers: save.answers, ev: save.ev, restoring: true });
  } catch (e) {
    console.error(e);
    clearSave();
    btn.disabled = false;
    alert("That saved match couldn’t be restored (" + (e && e.message ? e.message : e) + "). It has been discarded.");
    draw(L);
  }
}

async function launch(L, o) {
  L.open = true;
  const ctx = {
    be: L.be,
    onExit: (reason) => {
      L.open = false;
      if (reason === "app") { location.hash = "#/decks"; return; }
      if (L.screen.isConnected && /^#\/play/.test(location.hash)) { L.refresh(); draw(L); }
    },
  };
  try { await openMatch(ctx, o); } catch (e) { L.open = false; throw e; }
}
