// decks.js — turn the app's stored decks into game decks. Pure; no deps; browser + Node.
// Mirrors index.html helpers: fold, nameKeys, isCmdSection, deckCommanders, deckIdentity, getCard.
// The app has no sideboard/maybeboard notion (sections are free-form), so every non-commander entry is library.

const fold = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
const isCmdSection = (s) => /^commanders?$/i.test(String(s || "").trim());

function nameKeys(c) {
  const out = [fold(c.name)];
  if (String(c.name).indexOf(" // ") > 0) String(c.name).split(" // ").forEach((n) => out.push(fold(n)));
  if (c.flavor_name) out.push(fold(c.flavor_name));
  return out;
}

function nameIndex(cards) {
  const m = new Map();
  for (const k of Object.keys(cards || {})) {
    const c = cards[k];
    if (!c || !c.name) continue;
    for (const n of nameKeys(c)) if (!m.has(n)) m.set(n, c);
  }
  return m;
}

// Resolve an entry to CardData (or null). Prefers set:cn; falls back to folded name.
function resolveEntry(e, cards, byName) {
  if (e.set && e.cn != null) {
    const c = cards[e.set + ":" + e.cn];
    if (c) return c;
  }
  const n = e.name || (e.set ? null : null);
  if (n) return byName.get(fold(n)) || null;
  return null;
}

const entryLabel = (e) => e.name || (e.set ? e.set + ":" + e.cn : "?");
const pickDeck = (appState, deckOrId) =>
  deckOrId && typeof deckOrId === "object" ? deckOrId : (appState.decks || []).find((d) => d.id === deckOrId) || null;

function artOf(c) {
  const img = c && (c.img || (c.faces && c.faces[0] && c.faces[0].img));
  return img ? String(img).replace("/normal/", "/art_crop/") : null;
}

function startingLifeFor(format, isCommander) {
  const f = String(format || "").toLowerCase();
  if (f === "brawl") return 25;
  if (isCommander) return 40;
  return 20;
}

export function buildDeck(appState, deckOrId) {
  const d = pickDeck(appState, deckOrId);
  if (!d) throw new Error("deck not found: " + (deckOrId && deckOrId.id || deckOrId));
  const cards = appState.cards || {};
  const byName = nameIndex(cards);
  const missing = [];
  const resolved = (d.entries || []).map((e) => ({ e, c: resolveEntry(e, cards, byName) }));

  // Commanders: explicit Commander section first.
  let commanders = [];
  let cmdEntry = null; // entry used when identified via d.commander (one copy removed from library)
  for (const r of resolved) if (r.c && isCmdSection(r.e.section)) commanders.push(r.c);
  if (!commanders.length && d.commander) {
    const n = fold(d.commander);
    const r = resolved.find((x) => x.c && nameKeys(x.c).indexOf(n) >= 0);
    if (r) { commanders.push(r.c); cmdEntry = r.e; }
  }

  const library = [];
  for (const r of resolved) {
    const qty = Math.max(0, r.e.qty | 0);
    if (!r.c) { if (qty > 0) missing.push(entryLabel(r.e)); continue; }
    if (isCmdSection(r.e.section)) continue;
    let n = qty;
    if (cmdEntry === r.e) n = Math.max(0, n - 1);
    for (let i = 0; i < n; i++) library.push({ ...r.c });
  }

  const format = String(d.format || "").toLowerCase();
  const isCommander = format === "commander" || format === "brawl" || commanders.length > 0;
  const idSet = new Set();
  const idSource = commanders.length ? commanders : resolved.map((r) => r.c).filter(Boolean);
  idSource.forEach((c) => (c.color_identity || []).forEach((x) => idSet.add(x)));

  const first = commanders[0] || library[0] || null;
  return {
    id: d.id,
    name: d.name,
    format: d.format,
    isCommander,
    startingLife: startingLifeFor(format, isCommander),
    commanders: commanders.map((c) => ({ ...c })),
    cards: library,
    missing,
    identity: Array.from(idSet),
    art: artOf(first),
  };
}

export function listDecks(appState) {
  return (appState.decks || []).map((d) => {
    let b;
    try { b = buildDeck(appState, d); } catch (e) { b = null; }
    if (!b) return { id: d.id, name: d.name, format: d.format, commander: d.commander || null, count: 0, playable: false, missing: 0, identity: [], art: null };
    const count = b.cards.length + b.commanders.length;
    return {
      id: b.id,
      name: b.name,
      format: b.format,
      commander: b.commanders.length ? b.commanders.map((c) => c.name).join(" / ") : (d.commander || null),
      count,
      playable: b.missing.length === 0 && b.cards.length > 0,
      missing: b.missing.length,
      identity: b.identity,
      art: b.art,
    };
  });
}
