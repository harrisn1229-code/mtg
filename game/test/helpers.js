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
  }
  const c = nameMap.get(fold(name));
  if (!c) throw new Error("card not found: " + name);
  return JSON.parse(JSON.stringify(c));
}
