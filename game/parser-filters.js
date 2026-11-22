// parser-filters.js — shared helpers for the oracle-text compiler:
// failure signalling, numbers, mana strings, noun-phrase -> Filter, "target ..." -> TargetSpec.
// Pure; no DOM; plain data out.

export class Fail extends Error {}
export const fail = (m) => { throw new Fail(m); };

const NUMW = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
/** "three" | "3" | "X" -> number | "x" | null */
export function num(s) {
  if (s == null) return null;
  s = String(s).toLowerCase().trim();
  if (/^\d+$/.test(s)) return +s;
  if (s === "x") return "x";
  return s in NUMW ? NUMW[s] : null;
}
export const NUM_RE = "(?:\\d+|x|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)";

export const COLORS = { white: "W", blue: "U", black: "B", red: "R", green: "G" };
export const COLOR_LETTERS = ["W", "U", "B", "R", "G"];
const TYPE_WORDS = { creature: "creature", artifact: "artifact", enchantment: "enchantment", land: "land", planeswalker: "planeswalker",
  instant: "instant", sorcery: "sorcery", battle: "battle", tribal: "tribal" };
const PERMANENT_TYPES = ["artifact", "battle", "creature", "enchantment", "land", "planeswalker"];
const SUPERTYPES = ["legendary", "basic", "snow", "world"];

const SUBTYPES = new Set(`advisor aetherborn alien ally angel antelope ape archer archon army artificer assassin assembly-worker atog aurochs avatar azra
badger barbarian bard basilisk bat bear beast beaver beeble beholder berserker bird blinkmoth boar bringer brushwagg camarid camel caribou carrier cat centaur
cephalid chimera citizen cleric clown cockatrice construct coward crab crocodile cyclops dauthi demigod demon deserter detective devil dinosaur djinn dog dragon
drake dreadnought drone druid dryad dwarf efreet egg elder eldrazi elemental elephant elf elk employee eye faerie ferret fish flagbearer fox fractal frog fungus
gargoyle germ giant gnome goat goblin god golem gorgon graveborn gremlin griffin hag halfling hamster harpy hellion hippo hippogriff homarid homunculus horror
horse human hydra hyena illusion imp incarnation inkling insect jackal jellyfish juggernaut kavu kirin kithkin knight kobold kor kraken lamia lammasu leech
leviathan lhurgoyf licid lizard manticore masticore mercenary merfolk metathran minion minotaur mole monger mongoose monk monkey moonfolk mouse mutant myr
mystic naga nautilus nephilim nightmare nightstalker ninja noble noggle nomad nymph octopus ogre ooze orb orc orgg otter ouphe ox oyster pangolin peasant pegasus
pentavite performer pest phelddagrif phoenix phyrexian pilot pincher pirate plant praetor primarch prism processor rabbit raccoon ranger rat rebel reflection
rhino rigger robot rogue sable salamander samurai sand saproling satyr scarecrow scion scorpion scout sculpture serf serpent servo shade shaman shapeshifter
shark sheep siren skeleton slith sliver slug snake soldier soltari spawn specter spellshaper sphinx spider spike spirit splinter sponge squid squirrel starfish
surrakar survivor tentacle tetravite thalakos thopter thrull tiefling treefolk trilobite triskelavite troll turtle unicorn vampire vedalken viashino volver wall
walrus warlock warrior weird werewolf whale wizard wolf wolverine wombat worm wraith wurm yeti zombie zubera
treasure food clue blood map gold powerstone incubator junk shard equipment vehicle aura saga curse shrine fortification contraption class case room attraction spacecraft planet
arcane trap adventure lesson siege
plains island swamp mountain forest desert gate lair locus cave sphere urza's mine power-plant tower town
jace chandra liliana nissa gideon ajani teferi garruk sorin elspeth` .split(/\s+/));

export const BASIC_LAND_TYPES = { plains: "W", island: "U", swamp: "B", mountain: "R", forest: "G" };

const IRREG = { elves: "elf", wolves: "wolf", dwarves: "dwarf", werewolves: "werewolf", thieves: "thief", mice: "mouse", men: "man", sphinxes: "sphinx", foxes: "fox",
  octopuses: "octopus", leeches: "leech", wolverines: "wolverine", "assembly-workers": "assembly-worker", fungi: "fungus", djinns: "djinn", efreets: "efreet", goblins: "goblin", knights: "knight", ouphes: "ouphe" };

/** singularise a (lowercase) word; returns the singular if it is a known subtype, else null */
export function subtypeOf(w) {
  w = w.toLowerCase();
  if (SUBTYPES.has(w)) return w;
  if (IRREG[w] && SUBTYPES.has(IRREG[w])) return IRREG[w];
  const cands = [w.replace(/s$/, ""), w.replace(/es$/, ""), w.replace(/ies$/, "y"), w.replace(/ves$/, "f"), w.replace(/ves$/, "fe")];
  for (const c of cands) if (c !== w && SUBTYPES.has(c)) return c;
  return null;
}
const NOT_SUBTYPE_CAPS = new Set(["ring", "ring-bearer", "ring-bearers", "jace", "x", "i", "ii", "iii", "iv"]);

export const KEYWORD_LIST = ["flying", "first strike", "double strike", "deathtouch", "defender", "haste", "hexproof", "indestructible", "lifelink", "menace",
  "reach", "trample", "vigilance", "flash", "fear", "intimidate", "skulk", "shadow", "infect", "wither", "persist", "undying", "changeling", "devoid", "prowess",
  "shroud", "horsemanship"];
export const KEYWORD_SET = new Set(KEYWORD_LIST);

// ---------------------------------------------------------------------------------------------
// mana helpers
export function manaSymbols(s) { return (s.match(/\{[^}]+\}/g) || []); }
export function cmcOfCost(cost) {
  let n = 0;
  for (const sym of manaSymbols(cost || "")) {
    const v = sym.slice(1, -1);
    if (/^\d+$/.test(v)) n += +v;
    else if (v === "X") n += 0;
    else if (/^2\//.test(v)) n += 2;
    else n += 1;
  }
  return n;
}
export function colorsOfCost(cost) {
  const out = [];
  for (const sym of manaSymbols(cost || "")) for (const c of COLOR_LETTERS) if (new RegExp(`(^|[{/])${c}([}/]|$)`).test(sym) && !out.includes(c)) out.push(c);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Filters

/** compare phrase: "4 or greater" -> {op:">=",n:4} */
function cmpOf(nTxt, dir) {
  const n = num(nTxt);
  if (n == null) fail("cmp number " + nTxt);
  if (dir === "greater" || dir === "more") return { op: ">=", n };
  return { op: "<=", n };
}

/**
 * Parse a noun phrase into a Filter. Throws Fail if any word is unrecognised.
 * opts: { zone } default zone when the phrase says "card(s)" without a zone.
 * Returns the Filter; extra info on non-enumerable property `_plural`? no: keep pure data.
 */
export function parseFilter(text, opts = {}) {
  { // "creatures that aren't of the chosen type" / "creatures of the chosen type"
    const mm = String(text).match(/^(.*?)\s+(?:that (?:aren't|are not)|not) of the chosen type$/i) || String(text).match(/^(.*?)\s+of the chosen type$/i);
    if (mm) { const f = parseFilter(mm[1], opts); if (/aren't|are not|not of/i.test(text)) f.notChosenType = true; else f.chosenType = true; return f; }
  }
  let s = " " + text.trim().replace(/[.]+$/, "") + " ";
  s = s.replace(/’/g, "'");
  const f = {};

  // "that/who ..." relative clauses we understand
  s = s.replace(/\s+(?:that's|that is|that are|which are|that're) (attacking|blocking|tapped|untapped)\b/gi, (m, w) => { applyState(f, w.toLowerCase()); return " "; });
  s = s.replace(/\s+(?:that|which|who) (?:has|have) (flying|first strike|double strike|deathtouch|haste|hexproof|indestructible|lifelink|menace|reach|trample|vigilance|shroud|defender)\b/gi,
    (m, k) => { (f.keywords ||= []).push(k.toLowerCase()); return " "; });

  // controller / owner
  let m;
  const ctrl = /\s+(you control|you don't control|an opponent controls|your opponents control|opponents control|each opponent controls|defending player controls|you own|you don't own|an opponent owns|your opponents own)\b/i;
  if ((m = s.match(ctrl))) {
    const w = m[1].toLowerCase();
    if (/own/.test(w)) f.owner = /^you own/.test(w) ? "you" : "opponent";
    else f.controller = w === "you control" ? "you" : "opponent";
    s = s.replace(ctrl, " ");
  }
  // zone
  const zre = /\s+(?:in|from|on) (your|a|an opponent's|their|its owner's|target player's|each player's|each opponent's|that player's|an|the) (graveyard|hand|library|battlefield)\b/i;
  if ((m = s.match(zre))) {
    const who = m[1].toLowerCase();
    const zone = m[2].toLowerCase();
    if (zone !== "battlefield") {
      f.zone = zone;
      if (who === "your") f.owner = "you";
      else if (who === "an opponent's") f.owner = "opponent";
      else if (who === "a" || who === "an") { /* any graveyard */ }
      else fail("zone owner " + who);
    }
    s = s.replace(zre, " ");
  }
  // "with ..." clauses
  s = s.replace(/\s+with (power|toughness|mana value|converted mana cost) (\d+|x) or (greater|less|more|fewer)\b/gi, (mm, k, n, d) => {
    const key = /mana|converted/i.test(k) ? "cmc" : k.toLowerCase();
    f[key] = cmpOf(n, d === "fewer" ? "less" : d.toLowerCase());
    return " ";
  });
  s = s.replace(/\s+with (power|toughness|mana value|converted mana cost) (\d+|x)\b/gi, (mm, k, n) => {
    const key = /mana|converted/i.test(k) ? "cmc" : k.toLowerCase();
    f[key] = { op: "==", n: num(n) };
    return " ";
  });
  s = s.replace(/\s+with (flying|first strike|double strike|deathtouch|haste|hexproof|indestructible|lifelink|menace|reach|trample|vigilance|shroud|defender)\b/gi, (mm, k) => { (f.keywords ||= []).push(k.toLowerCase()); return " "; });
  s = s.replace(/\s+without (flying|first strike|double strike|deathtouch|haste|hexproof|indestructible|lifelink|menace|reach|trample|vigilance|shroud|defender)\b/gi, (mm, k) => { (f.notKeywords ||= []).push(k.toLowerCase()); return " "; });
  s = s.replace(/\s+named ([A-Z][^,]*?)(?=\s+(?:or|and)\s|$)/g, (mm, n) => { f.name = n.trim(); return " "; });

  s = s.trim();
  if (!s) fail("empty filter");
  // leading determiners
  s = s.replace(/^(?:a|an|the|each|every|all|any|one|those|these)\s+/i, "");
  s = s.replace(/^(?:other|another)\s+/i, () => { f.other = true; return ""; });

  // split into alternative groups
  const toks = s.replace(/,/g, " , ").split(/\s+/).filter(Boolean);
  const groups = [];
  let cur = newGroup();
  const pushGroup = () => { if (cur.any) groups.push(cur); cur = newGroup(); };
  for (let i = 0; i < toks.length; i++) {
    const wOrig = toks[i];
    const w = wOrig.toLowerCase();
    if (w === "and") fail("'and' in filter (ambiguous)");
    if (w === "," || w === "or" || w === "and/or") { pushGroup(); continue; }
    if (w === "a" || w === "an" || w === "the") continue;
    cur.any = true;
    if (w === "another" || w === "other") { f.other = true; continue; }
    let mm2;
    if ((mm2 = w.match(/^non-?(.+)$/))) {
      const x = mm2[1];
      if (COLORS[x]) (cur.f.notColors ||= []).push(COLORS[x]);
      else if (TYPE_WORDS[x.replace(/s$/, "")]) (cur.f.notTypes ||= []).push(TYPE_WORDS[x.replace(/s$/, "")]);
      else if (SUPERTYPES.includes(x)) (cur.f.notSupertypes ||= []).push(x);
      else if (x === "token") cur.f.token = false;
      else if (subtypeOf(x)) (cur.f.notSubtypes ||= []).push(subtypeOf(x));
      else fail("non-" + x);
      continue;
    }
    if (COLORS[w]) { (cur.f.colors ||= []).push(COLORS[w]); continue; }
    if (w === "colorless") { (cur.f.colors ||= []).push("colorless"); continue; }
    const tw = TYPE_WORDS[w] || TYPE_WORDS[w.replace(/s$/, "")] || (w === "sorceries" ? "sorcery" : null);
    if (tw) { (cur.types ||= []).push(tw); continue; }
    if (w === "permanent" || w === "permanents") { cur.permanent = true; continue; }
    if (w === "card" || w === "cards") { cur.card = true; continue; }
    if (w === "spell" || w === "spells") { cur.spell = true; continue; }
    if (w === "token" || w === "tokens") { cur.f.token = true; continue; }
    if (SUPERTYPES.includes(w)) { (cur.f.supertypes ||= []).push(w); continue; }
    if (w === "attacking" || w === "blocking" || w === "tapped" || w === "untapped") { applyState(cur.f, w); continue; }
    const st = subtypeOf(w);
    if (st) { (cur.f.subtypes ||= []).push(st); continue; }
    if (/^[A-Z]/.test(wOrig) && !NOT_SUBTYPE_CAPS.has(w) && !/[~{}0-9]/.test(wOrig) && i > -1) {
      // unknown capitalised word: treat as a (singularised) creature/land/artifact subtype
      (cur.f.subtypes ||= []).push(w.replace(/(?<=[a-z])s$/, ""));
      continue;
    }
    fail("filter word '" + wOrig + "' in '" + text + "'");
  }
  pushGroup();
  if (!groups.length) {
    // phrase was only modifiers, e.g. "attacking" - treat as any permanent
    groups.push(newGroup());
  }
  const built = groups.map((g) => {
    const o = { ...g.f };
    if (g.types) { if (g.types.length === 1) o.types = g.types; else { o.allTypes = g.types; } }
    if (g.permanent && !g.types && (f.zone || opts.zone) && (f.zone || opts.zone) !== "battlefield") o.types = [...PERMANENT_TYPES];
    if (g.spell) o._spell = true;
    return o;
  });
  let core;
  if (built.length === 1) core = built[0];
  else {
    const keys = built.map((b) => Object.keys(b).sort().join(","));
    if (built.every((b) => Object.keys(b).every((k) => k === "subtypes" || k === "supertypes")) && built.some((b) => b.supertypes)) {
      core = { supertypes: [...new Set(built.flatMap((b) => b.supertypes || []))], subtypes: [...new Set(built.flatMap((b) => b.subtypes || []))] };
    } else if (keys.every((k) => k === "types")) core = { types: [...new Set(built.flatMap((b) => b.types))] };
    else if (keys.every((k) => k === "subtypes")) core = { subtypes: [...new Set(built.flatMap((b) => b.subtypes))] };
    else core = { anyOf: built };
  }
  delete core._spell;
  const out = { ...f, ...core };
  if (built.some((b) => b._spell)) out._spell = true; // flagged for callers handling spells
  if (!out._spell) delete out._spell;
  if (out.zone === undefined && opts.zone && opts.zone !== "battlefield") out.zone = opts.zone;
  return out;
}
function newGroup() { return { f: {}, any: false }; }
function applyState(f, w) {
  if (w === "attacking") f.attacking = true;
  else if (w === "blocking") f.blocking = true;
  else if (w === "tapped") f.tapped = true;
  else if (w === "untapped") f.tapped = false;
}

/** true if the filter is a pure "any permanent/creature" style and holds nothing but listed keys */
export function filterKeys(f) { return Object.keys(f); }

/**
 * Parse a "target ..." noun phrase (without the leading quantity) into a TargetSpec.
 * `text` begins at the quantity or at "target": "target creature you control", "up to two target creatures", "any target".
 * Returns { spec, plural } or throws.
 */
export function parseTargetPhrase(text) {
  let s = text.trim().replace(/[.]+$/, "").replace(/’/g, "'");
  let min = 1, max = 1;
  let m;
  if (/^any target$/i.test(s)) return { spec: { what: "any" } };
  if ((m = s.match(new RegExp(`^up to (${NUM_RE}) other target (.+)$`, "i")))) { min = 0; max = num(m[1]); s = "target other " + m[2]; }
  else if ((m = s.match(new RegExp(`^up to (${NUM_RE}) target (.+)$`, "i")))) { min = 0; max = num(m[1]); s = "target " + m[2]; }
  else if ((m = s.match(new RegExp(`^(${NUM_RE}) target (.+)$`, "i"))) && num(m[1]) > 1) { min = max = num(m[1]); s = "target " + m[2]; }
  else if (/^any number of target /i.test(s)) fail("any number of targets");
  else if (/^another target /i.test(s)) s = s.replace(/^another target /i, "target other ");
  if (!/^target /i.test(s)) fail("not a target phrase: " + text);
  s = s.replace(/^target\s+/i, "");
  const spec = {};
  const withCount = (o) => { if (min !== 1) o.min = min; if (max !== 1) o.max = max; return o; };

  if (/^(?:player|opponent)s?$/i.test(s)) { spec.what = /^opponent/i.test(s) ? "opponent" : "player"; return { spec: withCount(spec) }; }
  if ((m = s.match(/^(?:player|opponent) or planeswalker$/i))) {
    spec.what = { anyOf: [{ player: true, ...(/^opponent/i.test(s) ? { controller: "opponent" } : {}) }, { types: ["planeswalker"] }] };
    return { spec: withCount(spec) };
  }
  if ((m = s.match(/^creature or planeswalker$/i))) { spec.what = { types: ["creature", "planeswalker"] }; return { spec: withCount(spec) }; }
  if (/^spell(?:s)?(?: or ability)?$/i.test(s)) { if (/ability/i.test(s)) fail("spell or ability"); spec.what = "spell"; spec.zone = "stack"; return { spec: withCount(spec) }; }
  if ((m = s.match(/^(.+?) spell$/i))) {
    const sf = parseFilter(m[1].replace(/\bspells?$/i, ""));
    spec.what = "spell"; spec.spellFilter = clean(sf); spec.zone = "stack";
    return { spec: withCount(spec) };
  }
  if (/^(?:activated|triggered) ability$/i.test(s)) fail("ability target");
  const f = parseFilter(s);
  if (f._spell) fail("spell filter");
  spec.what = f;
  if (f.zone === "graveyard" || f.zone === "stack") spec.zone = f.zone;
  return { spec: withCount(spec) };
}
function clean(f) { const o = { ...f }; delete o._spell; return o; }

/** Parse a plural/each noun phrase for "all/each" refs: "each creature you control" (determiner stripped by caller or not) */
export function parseAllFilter(text, opts) {
  const f = parseFilter(text.replace(/^(?:each|all|every)\s+/i, ""), opts);
  delete f._spell;
  return f;
}

// ---------------------------------------------------------------------------------------------
// keyword lists inside "gains X and Y" / "have flying, first strike and trample"
export function parseKeywordList(text) {
  const s = text.trim().replace(/[.]+$/, "").toLowerCase();
  const parts = s.split(/\s*,\s*(?:and\s+)?|\s+and\s+/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) fail("no keywords");
  const out = [];
  for (const p of parts) {
    if (!KEYWORD_SET.has(p)) fail("keyword " + p);
    out.push(p);
  }
  return out;
}
