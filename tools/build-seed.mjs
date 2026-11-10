#!/usr/bin/env node
/* Builds data/seed.json — the collection, decks and card data the app loads on first launch.

   Usage:  node tools/build-seed.mjs /path/to/vault

   Reads from the vault:
     Machine/Cards/collection.json                              owned cards + wishlist
     00 Human/40 Resources/Magic the Gathering/Decks/*.md       ```mtg-deck blocks
     00 Human/70 Context/MTG Config.md                          price tier boundaries
   Card data comes from the Scryfall API (https://scryfall.com/docs/api). No dependencies. */

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const vault = process.argv[2] || process.env.MTG_VAULT;
if (!vault) { console.error("Usage: node tools/build-seed.mjs /path/to/vault"); process.exit(1); }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "seed.json");
const API = "https://api.scryfall.com";
const HEADERS = { "User-Agent": "mtg-seed-builder/1.0", "Accept": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  // Scryfall asks for under 10 requests a second, and far fewer on /cards/search.
  const pace = path.startsWith("/cards/search") ? 600 : 120;
  for (let attempt = 0; ; attempt++) {
    await sleep(pace);
    const res = await fetch(API + path, { ...opts, headers: { ...HEADERS, ...(opts.headers || {}) } });
    if (res.status === 404) return null;
    if (res.status === 429 && attempt < 6) { await sleep(2000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`Scryfall ${res.status} for ${path}`);
    return res.json();
  }
}

/* Keep only what the app renders. */
function trim(c) {
  const face0 = (c.card_faces && c.card_faces[0]) || {};
  const img = (u) => (u && u.normal ? u.normal.split("?")[0] : null);
  const out = {
    id: c.id,
    oracle_id: c.oracle_id || face0.oracle_id || null,
    name: c.name,
    set: c.set,
    set_name: c.set_name,
    cn: c.collector_number,
    rarity: c.rarity,
    released: c.released_at,
    mana_cost: c.mana_cost ?? face0.mana_cost ?? "",
    cmc: c.cmc ?? 0,
    type_line: c.type_line ?? face0.type_line ?? "",
    oracle_text: c.oracle_text ?? "",
    colors: c.colors ?? face0.colors ?? [],
    color_identity: c.color_identity ?? [],
    legal_commander: (c.legalities && c.legalities.commander) || "not_legal",
    img: img(c.image_uris) || img(face0.image_uris),
    finishes: c.finishes || [],
    prices: {
      usd: c.prices?.usd ?? null,
      usd_foil: c.prices?.usd_foil ?? null,
      usd_etched: c.prices?.usd_etched ?? null,
    },
  };
  if (c.power != null) out.pt = `${c.power}/${c.toughness}`;
  if (c.loyalty != null) out.loyalty = c.loyalty;
  if (c.flavor_name) out.flavor_name = c.flavor_name;
  if (c.game_changer) out.game_changer = true;
  if (c.card_faces && c.card_faces.length > 1) {
    out.faces = c.card_faces.map((f) => ({
      name: f.name,
      mana_cost: f.mana_cost || "",
      type_line: f.type_line || "",
      oracle_text: f.oracle_text || "",
      pt: f.power != null ? `${f.power}/${f.toughness}` : undefined,
      img: img(f.image_uris) || undefined,
    }));
  }
  return out;
}

/* ---------- vault readers ---------- */

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const fm = {};
  if (!m) return fm;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

const LINE = /^\s*(\d+)\s+(.+?)(?:\s+\(([a-z0-9]{3,5})\)\s*(\S+))?(?:\s+\*(F|E)\*)?\s*$/i;

function parseDeckBlock(block) {
  const entries = [];
  let section = "Main";
  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) { section = line.replace(/^#+\s*/, "") || "Main"; continue; }
    const m = line.match(LINE);
    if (!m) continue;
    const e = { qty: Number(m[1]), name: m[2].trim(), section };
    if (m[3]) { e.set = m[3].toLowerCase(); e.cn = m[4]; }
    e.finish = m[5] ? (m[5].toUpperCase() === "E" ? "etched" : "foil") : "nonfoil";
    entries.push(e);
  }
  return entries;
}

async function readDecks() {
  const dir = join(vault, "00 Human", "40 Resources", "Magic the Gathering", "Decks");
  const decks = [];
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".md")).sort()) {
    const text = await readFile(join(dir, file), "utf8");
    const block = text.match(/```mtg-deck\n([\s\S]*?)\n```/);
    if (!block) continue;
    const fm = frontmatter(text);
    const name = basename(file, ".md");
    decks.push({
      id: name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      name,
      format: /commander|edh/i.test(fm.format || "") ? "commander" : "other",
      commander: fm.commander || null,
      archetype: fm.archetype || null,
      bracket: fm.bracket ? Number(fm.bracket) : null,
      created: fm.created || null,
      updated: fm.updated || null,
      entries: parseDeckBlock(block[1]),
    });
  }
  return decks;
}

async function readTiers() {
  try {
    const fm = frontmatter(await readFile(join(vault, "00 Human", "70 Context", "MTG Config.md"), "utf8"));
    return [Number(fm.tier_budget_max) || 2, Number(fm.tier_mid_max) || 10, Number(fm.tier_high_max) || 40];
  } catch { return [2, 10, 40]; }
}

/* ---------- Scryfall lookups ---------- */

const cards = {};            // "<set>:<cn>" -> trimmed card
const pk = (set, cn) => `${set}:${cn}`;

async function fetchPrintings(ids) {
  const want = [...new Set(ids)].filter((k) => !cards[k]);
  for (let i = 0; i < want.length; i += 75) {
    const chunk = want.slice(i, i + 75);
    const body = { identifiers: chunk.map((k) => { const [set, ...rest] = k.split(":"); return { set, collector_number: rest.join(":") }; }) };
    const res = await api("/cards/collection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    for (const c of res.data) cards[pk(c.set, c.collector_number)] = trim(c);
    for (const nf of res.not_found || []) console.warn("  not found:", JSON.stringify(nf));
    process.stdout.write(`  printings ${Math.min(i + 75, want.length)}/${want.length}\r`);
  }
  if (want.length) process.stdout.write("\n");
}

const byName = {};           // lowercased name -> "<set>:<cn>"
const nameKey = (n) => n.toLowerCase();

/* Name-only rows: one batched lookup, which returns Scryfall's default printing. */
async function fetchNames(names) {
  const want = [...new Set(names.map(nameKey))].filter((n) => !byName[n]);
  for (let i = 0; i < want.length; i += 75) {
    const chunk = want.slice(i, i + 75);
    const res = await api("/cards/collection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifiers: chunk.map((name) => ({ name })) }) });
    for (const c of res.data) {
      const k = pk(c.set, c.collector_number);
      cards[k] = cards[k] || trim(c);
      byName[nameKey(c.name)] = k;
      if (c.card_faces) byName[nameKey(c.card_faces[0].name)] = k;
      if (c.flavor_name) byName[nameKey(c.flavor_name)] = k;
    }
    for (const nf of res.not_found || []) console.warn("  not found:", JSON.stringify(nf));
  }
}

/* The cheapest paper printing, used as a price floor for owned cards whose printing is unknown. */
async function cheapestByName(name) {
  const q = encodeURIComponent(`!"${name}" game:paper`);
  const res = await api(`/cards/search?q=${q}&unique=prints&order=usd&dir=asc`);
  const pick = res && res.data && (res.data.find((c) => c.prices && c.prices.usd) || res.data[0]);
  if (!pick) return null;
  const k = pk(pick.set, pick.collector_number);
  cards[k] = cards[k] || trim(pick);
  return k;
}

/* ---------- build ---------- */

const raw = JSON.parse(await readFile(join(vault, "Machine", "Cards", "collection.json"), "utf8"));
const decks = await readDecks();
const tiers = await readTiers();

console.log(`Collection: ${Object.keys(raw.cards).length} entries · decks: ${decks.length}`);

const ids = [];
for (const v of Object.values(raw.cards)) if (v.set && v.cn) ids.push(pk(v.set, v.cn));
for (const v of Object.values(raw.wishlist || {})) if (v.set && v.cn) ids.push(pk(v.set, v.cn));
for (const d of decks) for (const e of d.entries) if (e.set && e.cn) ids.push(pk(e.set, e.cn));
await fetchPrintings(ids);

function priceFor(card, finish) {
  if (!card) return null;
  const p = card.prices;
  return (finish === "foil" ? p.usd_foil : finish === "etched" ? p.usd_etched : p.usd) ?? p.usd ?? p.usd_foil ?? p.usd_etched ?? null;
}

// A name-only row uses a printing already in the collection when there is one.
const known = (v) => v.set && v.cn && cards[pk(v.set, v.cn)];
for (const v of Object.values(raw.cards)) if (known(v)) byName[nameKey(cards[pk(v.set, v.cn)].name)] ??= pk(v.set, v.cn);
const loose = [];
for (const v of Object.values(raw.wishlist || {})) if (!known(v)) loose.push(v.name);
for (const d of decks) for (const e of d.entries) if (!known(e)) loose.push(e.name);
await fetchNames(loose);
for (const v of Object.values(raw.cards)) {
  if (known(v)) continue;
  const k = await cheapestByName(v.name);
  if (k) byName[nameKey(v.name)] = k; else await fetchNames([v.name]);
}

async function resolveEntry(v) {
  if (known(v)) return { set: v.set, cn: v.cn, inferred: false };
  const k = byName[nameKey(v.name)];
  if (!k) { console.warn("  could not resolve:", v.name); return null; }
  return { set: cards[k].set, cn: cards[k].cn, inferred: true };
}

const collection = {};
for (const v of Object.values(raw.cards)) {
  const r = await resolveEntry(v);
  if (!r) continue;
  const finish = v.finish || "nonfoil";
  const key = `${r.set}:${r.cn}:${finish}`;
  const card = cards[pk(r.set, r.cn)];
  if (collection[key]) { collection[key].qty += v.qty; continue; }
  collection[key] = { set: r.set, cn: r.cn, finish, qty: v.qty, added: v.added || raw.updated };
  if (r.inferred || v.needs_printing) collection[key].printing_inferred = true;
  if (priceFor(card, finish) == null && v.price_usd) collection[key].price_usd = v.price_usd;
}

const wishlist = {};
for (const v of Object.values(raw.wishlist || {})) {
  const r = await resolveEntry(v);
  if (!r) continue;
  const finish = v.finish || "nonfoil";
  wishlist[`${r.set}:${r.cn}:${finish}`] = { set: r.set, cn: r.cn, finish, qty: v.qty, added: v.added || raw.updated };
}

for (const d of decks) {
  const out = [];
  for (const e of d.entries) {
    const r = await resolveEntry(e);
    if (!r) { console.warn(`  [${d.name}] dropped: ${e.name}`); continue; }
    const row = { set: r.set, cn: r.cn, finish: e.finish, qty: e.qty, section: e.section };
    if (r.inferred) row.printing_inferred = true;
    out.push(row);
  }
  d.entries = out;
  d.count = out.reduce((n, e) => n + e.qty, 0);
}

const now = new Date();
const today = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-"); // local date
const seed = {
  app: "mtg",
  seedVersion: today,
  pricedAt: today,
  config: { tiers },
  collection,
  wishlist,
  decks,
  cards,
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(seed));

const total = Object.values(collection).reduce((n, v) => n + v.qty, 0);
const value = Object.values(collection).reduce((n, v) => n + v.qty * Number(priceFor(cards[pk(v.set, v.cn)], v.finish) ?? v.price_usd ?? 0), 0);
console.log(`Wrote ${OUT}`);
console.log(`  ${Object.keys(collection).length} printings · ${total} cards · $${value.toFixed(2)} · ${Object.keys(cards).length} card records`);
for (const d of decks) console.log(`  deck: ${d.name} — ${d.count} cards`);
