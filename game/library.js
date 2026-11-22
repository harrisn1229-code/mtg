// library.js — the deck library: official Commander precons the AI can play and you can try.
// data/library.json holds { decks, cards } in the same shape as the app's own decks and cards,
// so the game can use them through buildDeck/listDecks with a merged state. Nothing here is
// stored on the device; the app's own decks and collection are never touched.

let libP = null;

export function loadLibrary() {
  if (!libP) {
    const url = new URL("../data/library.json", import.meta.url).href;
    libP = fetch(url).then((r) => {
      if (!r.ok) throw new Error("library " + r.status);
      return r.json();
    }).then((lib) => {
      (lib.decks || []).forEach((d) => { d.library = true; });
      return lib;
    }).catch((e) => { libP = null; throw e; });
  }
  return libP;
}

export const isLibraryId = (id) => /^lib-/.test(String(id || ""));

// The app's state plus the library: your decks first, library decks after; your own card data wins.
export function mergedState(appState, lib) {
  if (!lib) return appState;
  return {
    decks: (appState.decks || []).concat(lib.decks || []),
    cards: Object.assign({}, lib.cards || {}, appState.cards || {}),
  };
}

const fold = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

// Names of every card in the collection (any printing).
export function ownedNames(appState) {
  const out = new Set();
  const cards = appState.cards || {};
  Object.values(appState.collection || {}).forEach((e) => {
    if (!e || !(e.qty > 0)) return;
    const c = cards[e.set + ":" + e.cn];
    if (c && c.name) out.add(fold(c.name));
  });
  return out;
}

// How many of a library deck's cards (by copies, basics excluded) are already in the collection.
export function ownedCount(deck, lib, owned) {
  let have = 0, total = 0;
  (deck.entries || []).forEach((e) => {
    const c = lib.cards[e.set + ":" + e.cn];
    if (!c || /\bBasic\b/.test(c.type_line || "")) return;
    total += e.qty;
    if (owned.has(fold(c.name))) have += e.qty;
  });
  return { have, total };
}
