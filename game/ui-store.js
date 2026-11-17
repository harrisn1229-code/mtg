/* localStorage only, every key prefixed `mtg:game:`. The app's IndexedDB data is never touched. */

const P = "mtg:game:";
export function lsGet(key, fallback) {
  try { const v = localStorage.getItem(P + key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
}
export function lsSet(key, value) {
  try { localStorage.setItem(P + key, JSON.stringify(value, jsonReplacer)); return true; } catch (e) { return false; }
}
export function lsDel(key) { try { localStorage.removeItem(P + key); } catch (e) { /* ignore */ } }

/* Answers may echo engine objects back (candidate.obj); store only their ids. */
function jsonReplacer(k, v) {
  if (v && typeof v === "object" && !Array.isArray(v) && typeof v.id === "string" && (v.c || v.zone)) return v.id;
  return v;
}

export const DEFAULT_STOPS = {
  my: { upkeep: false, draw: false, main1: true, beginCombat: false, declareAttackers: false, declareBlockers: false, combatDamage: false, endCombat: false, main2: true, end: false },
  opp: { upkeep: false, draw: false, main1: false, beginCombat: false, declareAttackers: true, declareBlockers: false, combatDamage: false, endCombat: false, main2: false, end: false },
};
export const DEFAULT_SETTINGS = {
  sound: true, volume: 0.6, haptics: true, speed: "normal", fullControl: false, holdOwn: false,
  cardSize: "m", reduceMotion: false, stops: DEFAULT_STOPS,
};
export function loadSettings() {
  const s = Object.assign({}, DEFAULT_SETTINGS, lsGet("settings", {}));
  s.stops = {
    my: Object.assign({}, DEFAULT_STOPS.my, (s.stops || {}).my),
    opp: Object.assign({}, DEFAULT_STOPS.opp, (s.stops || {}).opp),
  };
  return s;
}
export const saveSettings = (s) => lsSet("settings", s);

export const DEFAULT_LOBBY = { deckId: "", oppId: "random", difficulty: "normal", life: "auto", first: "random", freeMulligan: true };
export const loadLobby = () => Object.assign({}, DEFAULT_LOBBY, lsGet("lobby", {}));
export const saveLobby = (l) => lsSet("lobby", l);

export const loadSave = () => lsGet("save", null);
export const writeSave = (m) => lsSet("save", m);
export const clearSave = () => { lsDel("save"); };

export function loadStats() { return lsGet("stats", { decks: {} }); }
export function recordResult(r) {
  const st = loadStats();
  const d = (st.decks[r.deckId] = st.decks[r.deckId] || { w: 0, l: 0, d: 0, name: r.deckName });
  d.name = r.deckName || d.name;
  if (r.result === "win") d.w++; else if (r.result === "loss") d.l++; else d.d++;
  lsSet("stats", st);
  const hist = lsGet("history", []);
  hist.unshift({ ts: Date.now(), deckId: r.deckId, deck: r.deckName, opp: r.oppName, result: r.result, turns: r.turns, reason: r.reason, difficulty: r.difficulty });
  lsSet("history", hist.slice(0, 40));
}
export const loadHistory = () => lsGet("history", []);
