// engine-util.js — pure helpers shared by the rules engine: RNG, mana-cost parsing/arithmetic,
// comparison, def normalisation, predefined tokens, fallback card compiler. No state.

export const STEPS = ["untap", "upkeep", "draw", "main1", "beginCombat", "declareAttackers", "declareBlockers",
  "combatDamage", "endCombat", "main2", "end", "cleanup"];
export const COLORS = ["W", "U", "B", "R", "G"];
export const MANA_KEYS = ["W", "U", "B", "R", "G", "C"];
export const COLOR_NAME = { W: "white", U: "blue", B: "black", R: "red", G: "green", C: "colorless" };
const NAME_TO_LETTER = { white: "W", blue: "U", black: "B", red: "R", green: "G", colorless: "C", w: "W", u: "U", b: "B", r: "R", g: "G", c: "C" };
export const PERMANENT_TYPES = ["artifact", "battle", "creature", "enchantment", "land", "planeswalker"];
export const BASIC_LAND_MANA = { plains: "W", island: "U", swamp: "B", mountain: "R", forest: "G" };

/** mulberry32 seeded PRNG; returns float in [0,1). State lives in the closure (deterministic per seed). */
export function makeRng(seed) {
  let a = (Number(seed) >>> 0) || 0x9e3779b9;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function colorLetter(c) {
  if (c == null) return null;
  const s = String(c);
  if (s.length === 1 && "WUBRGC".includes(s.toUpperCase())) return s.toUpperCase();
  return NAME_TO_LETTER[s.toLowerCase()] || null;
}

export function cmp(a, op, b) {
  a = Number(a) || 0; b = Number(b) || 0;
  switch (op) {
    case "<=": return a <= b;
    case ">=": return a >= b;
    case "<": return a < b;
    case ">": return a > b;
    case "!=": return a !== b;
    default: return a === b; // "==", "="
  }
}

/** Parsed mana cost. */
export function emptyCost() {
  return { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, hybrid: [], phyrexian: [], x: 0, snow: 0 };
}

/**
 * parseManaCost("{2}{B}{B/P}{R/G}{2/W}{X}") -> { generic, W,U,B,R,G,C, hybrid:[["R","G"],["2","W"]], phyrexian:["B"], x, snow }
 * Accepts an already-parsed cost (returned as a copy) and tolerates junk (ignored).
 */
export function parseManaCost(str) {
  const r = emptyCost();
  if (str && typeof str === "object") return addCosts(r, str);
  if (typeof str === "number") { r.generic = Math.max(0, str | 0); return r; }
  if (!str || typeof str !== "string") return r;
  const re = /\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(str))) {
    const s = m[1].toUpperCase().trim();
    if (/^\d+$/.test(s)) r.generic += +s;
    else if (s === "X" || s === "Y" || s === "Z") r.x++;
    else if (s.length === 1 && "WUBRGC".includes(s)) r[s]++;
    else if (s === "S") r.snow++;
    else if (s.includes("/")) {
      const parts = s.split("/").filter(Boolean);
      if (parts.includes("P")) {
        const cols = parts.filter((p) => p !== "P");
        if (cols.length === 1 && "WUBRGC".includes(cols[0])) r.phyrexian.push(cols[0]);
        else if (cols.length > 1) r.hybrid.push(cols);
      } else if (parts.length >= 2) r.hybrid.push(parts);
    }
  }
  return r;
}

export function addCosts(a, b) {
  const r = { ...emptyCost(), ...a, hybrid: [...(a.hybrid || [])], phyrexian: [...(a.phyrexian || [])] };
  if (!b) return r;
  if (typeof b === "string") b = parseManaCost(b);
  r.generic += b.generic || 0;
  for (const k of MANA_KEYS) r[k] += b[k] || 0;
  r.hybrid.push(...(b.hybrid || []));
  r.phyrexian.push(...(b.phyrexian || []));
  r.x += b.x || 0;
  r.snow += b.snow || 0;
  return r;
}

export function costCmc(c) {
  if (!c) return 0;
  if (typeof c === "string") c = parseManaCost(c);
  let n = c.generic + c.snow;
  for (const k of MANA_KEYS) n += c[k];
  for (const h of c.hybrid) n += h.some((x) => /^\d+$/.test(x)) ? Math.max(...h.filter((x) => /^\d+$/.test(x)).map(Number)) : 1;
  n += c.phyrexian.length;
  return n;
}

export function costIsEmpty(c) {
  return costCmc(c) === 0 && !c.x;
}

export function costToString(c, x) {
  if (!c) return "";
  if (typeof c === "string") return c;
  let s = "";
  for (let i = 0; i < c.x; i++) s += x != null ? "" : "{X}";
  const gen = c.generic + c.snow + (x != null ? x * c.x : 0);
  if (gen || (!s && costCmc(c) === 0)) s += `{${gen}}`;
  for (const h of c.hybrid) s += `{${h.join("/")}}`;
  for (const p of c.phyrexian) s += `{${p}/P}`;
  for (const k of MANA_KEYS) for (let i = 0; i < c[k]; i++) s += `{${k}}`;
  return s;
}

/** Mana-string like "{R}{R}{C}" -> counts {W,U,B,R,G,C} (generic digits become C). */
export function manaStringToPool(str) {
  const p = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  const c = parseManaCost(str);
  for (const k of MANA_KEYS) p[k] += c[k];
  p.C += c.generic;
  return p;
}

export function poolTotal(p) {
  return (p.W | 0) + (p.U | 0) + (p.B | 0) + (p.R | 0) + (p.G | 0) + (p.C | 0);
}

export function poolToString(p) {
  let s = "";
  for (const k of MANA_KEYS) for (let i = 0; i < (p[k] | 0); i++) s += `{${k}}`;
  return s;
}

// ------------------------------------------------------------------------------------------
// Def normalisation

const NORM = new WeakMap();
const asArr = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const lc = (v) => asArr(v).filter((x) => typeof x === "string").map((x) => x.toLowerCase());

/** Returns a normalised (never mutated) copy of a CardDef with all array/object fields present. */
export function normalizeDef(def, card) {
  if (!def || typeof def !== "object") def = fallbackDef(card || {});
  const hit = NORM.get(def);
  if (hit) return hit;
  const d = { ...def };
  d.name = String(d.name ?? card?.name ?? "Card");
  d.types = lc(d.types);
  d.subtypes = lc(d.subtypes);
  d.supertypes = lc(d.supertypes);
  d.colors = asArr(d.colors).map(colorLetter).filter((x) => x && x !== "C");
  d.identity = asArr(d.identity ?? card?.color_identity ?? d.colors).map(colorLetter).filter((x) => x && x !== "C");
  d.keywords = d.keywords && typeof d.keywords === "object" && !Array.isArray(d.keywords) ? { ...d.keywords } : {};
  if (Array.isArray(def.keywords)) for (const k of def.keywords) if (typeof k === "string") d.keywords[k.toLowerCase()] = true;
  d.abilities = asArr(d.abilities).filter((a) => a && typeof a === "object");
  d.unparsed = asArr(d.unparsed).filter((x) => typeof x === "string");
  d.cost = typeof d.cost === "string" ? d.cost : d.cost == null ? card?.mana_cost ?? "" : String(d.cost);
  d.cmc = typeof d.cmc === "number" ? d.cmc : costCmc(d.cost);
  d.text = d.text ?? card?.oracle_text ?? "";
  d.img = d.img ?? card?.img ?? null;
  if (d.spell && typeof d.spell !== "object") d.spell = null;
  if (d.spell) {
    d.spell = { ...d.spell, effects: asArr(d.spell.effects), targets: asArr(d.spell.targets) };
  }
  if (d.faces && Array.isArray(d.faces) && d.faces.length) {
    d.faces = d.faces.map((f, i) => {
      if (i === 0 && f === def) return d;
      const nf = normalizeDef({ img: d.img, ...f }, null);
      return nf;
    });
  } else d.faces = null;
  NORM.set(def, d);
  NORM.set(d, d);
  return d;
}

/** Minimal def built from raw card data when no compiler is available / the compiler throws. */
export function fallbackDef(card) {
  const tl = parseTypeLine(card.type_line || "");
  const [p, t] = String(card.pt || "").split("/");
  const def = {
    name: card.name || "Card", cost: card.mana_cost || "", cmc: card.cmc ?? costCmc(card.mana_cost || ""),
    colors: card.colors || [], identity: card.color_identity || [],
    supertypes: tl.supertypes, types: tl.types, subtypes: tl.subtypes,
    power: p == null || p === "" ? undefined : isNaN(+p) ? "*" : +p,
    toughness: t == null || t === "" ? undefined : isNaN(+t) ? "*" : +t,
    loyalty: card.loyalty != null ? +card.loyalty : undefined,
    img: card.img || null, text: card.oracle_text || "",
    keywords: {}, abilities: [], spell: null, additionalCost: null, faces: null, layout: null,
    unparsed: String(card.oracle_text || "").split("\n").filter((l) => l.trim()),
  };
  if (Array.isArray(card.faces) && card.faces.length > 1) {
    const isAdv = /adventure/i.test(card.type_line || "");
    def.layout = isAdv ? "adventure" : "transform";
    def.faces = card.faces.map((f) => fallbackDef({ ...f, colors: card.colors, color_identity: card.color_identity, img: f.img || card.img }));
    Object.assign(def, { ...def.faces[0], faces: def.faces, layout: def.layout, identity: def.identity });
  }
  return def;
}

const SUPERS = new Set(["legendary", "basic", "snow", "world", "ongoing", "elite"]);
const TYPES = new Set(["creature", "artifact", "enchantment", "land", "planeswalker", "instant", "sorcery", "battle", "tribal", "kindred", "conspiracy"]);
export function parseTypeLine(tl) {
  const out = { supertypes: [], types: [], subtypes: [] };
  const first = String(tl).split("//")[0];
  const [left, right] = first.split(/\s+[—-]\s+/);
  for (const w of (left || "").toLowerCase().split(/\s+/).filter(Boolean)) {
    if (SUPERS.has(w)) out.supertypes.push(w);
    else if (TYPES.has(w)) out.types.push(w);
  }
  if (right) out.subtypes = right.toLowerCase().split(/\s+/).filter(Boolean);
  return out;
}

// ------------------------------------------------------------------------------------------
// Predefined tokens

const manaAb = (cost, mana, text) => ({ kind: "activated", cost, mana: true, effects: [{ op: "addMana", mana }], text });
export const TOKENS = {
  treasure: { name: "Treasure", types: ["artifact"], subtypes: ["treasure"], colors: [],
    abilities: [manaAb({ tap: true, sacSelf: true }, { any: 1 }, "{T}, Sacrifice this token: Add one mana of any color.")] },
  food: { name: "Food", types: ["artifact"], subtypes: ["food"], colors: [],
    abilities: [{ kind: "activated", cost: { mana: "{2}", tap: true, sacSelf: true }, effects: [{ op: "gainLife", who: "you", amount: 3 }], text: "{2}, {T}, Sacrifice this token: You gain 3 life." }] },
  clue: { name: "Clue", types: ["artifact"], subtypes: ["clue"], colors: [],
    abilities: [{ kind: "activated", cost: { mana: "{2}", sacSelf: true }, effects: [{ op: "draw", who: "you", amount: 1 }], text: "{2}, Sacrifice this token: Draw a card." }] },
  blood: { name: "Blood", types: ["artifact"], subtypes: ["blood"], colors: [],
    abilities: [{ kind: "activated", cost: { mana: "{1}", tap: true, discard: 1, sacSelf: true }, effects: [{ op: "draw", who: "you", amount: 1 }], text: "{1}, {T}, Discard a card, Sacrifice this token: Draw a card." }] },
  map: { name: "Map", types: ["artifact"], subtypes: ["map"], colors: [],
    abilities: [{ kind: "activated", cost: { mana: "{1}", tap: true, sacSelf: true }, sorcery: true, targets: [{ what: { types: ["creature"], controller: "you" } }],
      effects: [{ op: "explore", what: { ref: "target", i: 0 } }], text: "{1}, {T}, Sacrifice this token: Target creature you control explores. Activate only as a sorcery." }] },
  "eldrazi scion": { name: "Eldrazi Scion", types: ["creature"], subtypes: ["eldrazi", "scion"], colors: [], power: 1, toughness: 1,
    abilities: [manaAb({ sacSelf: true }, "{C}", "Sacrifice this token: Add {C}.")] },
  "eldrazi spawn": { name: "Eldrazi Spawn", types: ["creature"], subtypes: ["eldrazi", "spawn"], colors: [], power: 0, toughness: 1,
    abilities: [manaAb({ sacSelf: true }, "{C}", "Sacrifice this token: Add {C}.")] },
};
TOKENS.scion = TOKENS["eldrazi scion"];
TOKENS.spawn = TOKENS["eldrazi spawn"];

/** Turn a TokenDef (or predefined name) into a CardDef. */
export function tokenDef(t) {
  if (typeof t === "string") {
    const k = t.toLowerCase().replace(/ token$/, "");
    if (TOKENS[k]) t = TOKENS[k];
    else t = { name: t, types: ["creature"], subtypes: [], colors: [], power: 1, toughness: 1 };
  }
  if (!t || typeof t !== "object") t = { name: "Token", types: ["creature"], power: 1, toughness: 1 };
  const kw = Array.isArray(t.keywords) ? Object.fromEntries(t.keywords.map((k) => [String(k).toLowerCase(), true])) : t.keywords || {};
  return normalizeDef({
    name: t.name || [...(t.subtypes || [])].map(cap).join(" ") || "Token", cost: "", cmc: 0,
    colors: t.colors || [], types: t.types || ["creature"], subtypes: t.subtypes || [], supertypes: t.supertypes || [],
    power: t.power, toughness: t.toughness, keywords: kw, abilities: t.abilities || [], img: t.img || null,
    text: t.text || "", unparsed: [],
  });
}
export const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

/** Hash for loop detection. */
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
