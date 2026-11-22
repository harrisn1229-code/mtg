import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildDeck } from "../decks.js";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const fold = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

let cache = null;
function raw() {
  if (!cache) {
    const seed = JSON.parse(readFileSync(here("../../data/seed.json"), "utf8"));
    const fixtures = JSON.parse(readFileSync(here("./fixtures-cards.json"), "utf8"));
    cache = { seed, fixtures };
  }
  return cache;
}

// App-state-like object { decks, cards } with fixtures merged in under "set:cn". Fresh copy each call.
export function loadSeed() {
  const { seed, fixtures } = raw();
  const st = JSON.parse(JSON.stringify({ decks: seed.decks, cards: seed.cards }));
  for (const c of Object.values(fixtures)) {
    const k = c.set + ":" + c.cn;
    if (!st.cards[k]) st.cards[k] = JSON.parse(JSON.stringify(c));
  }
  return st;
}

export function allDecks() {
  const st = loadSeed();
  return st.decks.map((d) => buildDeck(st, d));
}

let nameMap = null;
export function cardByName(name) {
  if (!nameMap) {
    nameMap = new Map();
    for (const c of Object.values(loadSeed().cards)) {
      const keys = [fold(c.name)];
      if (c.name.indexOf(" // ") > 0) c.name.split(" // ").forEach((n) => keys.push(fold(n)));
      if (c.flavor_name) keys.push(fold(c.flavor_name));
      for (const k of keys) if (!nameMap.has(k)) nameMap.set(k, c);
    }
    // Deck-library cards (data/library.json) after the seed, so scenario tests can use any library card by name.
    for (const c of Object.values(loadLibrary().cards)) {
      const keys = [fold(c.name)];
      if (c.name.indexOf(" // ") > 0) c.name.split(" // ").forEach((n) => keys.push(fold(n)));
      for (const k of keys) if (!nameMap.has(k)) nameMap.set(k, c);
    }
  }
  const c = nameMap.get(fold(name));
  if (!c) throw new Error("card not found: " + name);
  return JSON.parse(JSON.stringify(c));
}

// ---------------------------------------------------------------- deck library (data/library.json)
let libCache = null;
export function loadLibrary() {
  if (!libCache) libCache = JSON.parse(readFileSync(here("../../data/library.json"), "utf8"));
  return libCache;
}
// Built game decks for the library ({ decks, cards } state), optionally only those whose name/id matches `filter`.
export function libraryDecks(filter) {
  const lib = loadLibrary();
  const st = { decks: lib.decks, cards: lib.cards };
  return lib.decks.filter((d) => !filter || filter(d)).map((d) => buildDeck(st, d));
}
// Batches of library card names to automate: { m1: [...], b01: [...], ... } (lib-ov/batches.json).
export function libraryBatches() {
  return JSON.parse(readFileSync(here("../lib-ov/batches.json"), "utf8"));
}
