// parser.js — oracle text -> CardDef (SPEC §5). Pure, deterministic, JSON-serialisable output.
//   compileCard(cardData) -> CardDef
//   analyzeCard(cardData) -> { def, lines, parsed, partial:[...], unparsed:[...] }   (used by test/coverage.js)
// Anything not understood goes to def.unparsed (raw line) — never a guess. Extensions beyond SPEC §5 are listed in SPEC-NOTES.md.

import { Fail, fail, num, NUM_RE, COLORS, BASIC_LAND_TYPES, parseFilter, parseKeywordList, cmcOfCost, colorsOfCost, subtypeOf, KEYWORD_SET } from "./parser-filters.js";
import { createCtx, parseEffects, parseCost, parseCond, splitTop, splitSentences, attempt, countOf, expr, maskQuotes } from "./parser-effects.js";

const EVT_OBJ = { ref: "event", what: "object" };
const EVT_PLAYER = { ref: "event", what: "player" };
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------------------------------------
// text normalisation

function normChars(s) {
  return String(s ?? "").replace(/[−–]/g, "-").replace(/[’‘]/g, "'").replace(/ /g, " ");
}
function stripReminder(line) {
  let prev;
  let s = line;
  do { prev = s; s = s.replace(/\s*\([^()]*\)/g, ""); } while (s !== prev);
  return s.replace(/\s+/g, " ").trim();
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function selfNames(name, isBasic) {
  if (isBasic) return [];
  const out = new Set();
  out.add(name);
  const first = name.split(",")[0].trim();
  if (first && first !== name) out.add(first);
  return [...out].sort((a, b) => b.length - a.length);
}
function selfify(text, names) {
  let s = text;
  for (const n of names) s = s.replace(new RegExp(`(?<![\\w'-])${esc(n)}(?![\\w-]|'s\\b(?<=never))`, "g"), "~");
  s = s.replace(/\b(?:this|This) (creature|artifact|enchantment|land|permanent|spell|card|token|Aura|aura|Equipment|equipment|Saga|planeswalker|Vehicle|vehicle|instant|sorcery|battle|Siege|Class|Food)\b/g, "~");
  return s;
}

// ---------------------------------------------------------------------------------------------
// keyword lines

const SIMPLE_KW = new Set(["flying", "first strike", "double strike", "deathtouch", "defender", "haste", "hexproof", "indestructible", "lifelink", "menace", "reach",
  "trample", "vigilance", "flash", "fear", "intimidate", "skulk", "shadow", "infect", "wither", "persist", "undying", "changeling", "devoid", "prowess", "shroud",
  "horsemanship", "exploit", "delve", "partner", "split second", "cascade", "storm", "convoke", "rebound", "myriad", "evolve", "riot", "dethrone", "afterlife 1", "increment"]);
const IGNORED_KW = new Set(["partner"]);
// accepted but inert in the engine unless it implements them
const KW_ACCEPT = new Set([...KEYWORD_SET, "exploit", "delve", "partner", "increment"]);
const UNSUPPORTED_KW_RE = /^(?:disguise|hideaway|storm|cascade|convoke|affinity|bestow|crew|saddle|banding|phasing|ninjutsu|suspend|madness|buyback|surge|emerge|prototype|read ahead|level up|boast|foretell|daybound|nightbound|ravenous|casualty|squad|offspring|more than meets|living weapon|rebound|soulbond|fabricate|dash|evoke|unearth|embalm|eternalize|miracle|replicate|retrace|jump-start|aftermath|multikicker|entwine|escalate|champion|fading|vanishing|cumulative upkeep|devour|modular|sunburst|graft|bloodthirst|haunt|amplify|hexproof from|protection from (?!(?:white|blue|black|red|green)))/i;

function kwItem(item, kws) {
  const t = item.trim().replace(/[.]$/, "");
  const lt = t.toLowerCase();
  let m;
  if (SIMPLE_KW.has(lt) && KW_ACCEPT.has(lt)) { kws[lt] = true; return true; }
  if ((m = t.match(/^ward (\{[^}]+\}(?:\{[^}]+\})*|\d+)$/i))) { kws.ward = /^\d+$/.test(m[1]) ? `{${m[1]}}` : m[1]; return true; }
  if ((m = t.match(/^protection from (white|blue|black|red|green)((?: and from (?:white|blue|black|red|green))*)$/i))) {
    const list = [m[1].toLowerCase(), ...[...m[2].matchAll(/from (\w+)/gi)].map((x) => x[1].toLowerCase())];
    kws.protection = [...new Set([...(kws.protection || []), ...list])];
    return true;
  }
  if ((m = t.match(/^(equip|cycling|flashback|kicker|echo|overload) ((?:\{[^}]+\})+)$/i))) { kws[m[1].toLowerCase()] = m[2]; return true; }
  if ((m = t.match(/^(annihilator|toxic) (\d+)$/i))) { kws[m[1].toLowerCase()] = +m[2]; return true; }
  if ((m = t.match(/^escape-((?:\{[^}]+\})+), exile (\w+) other cards? from your graveyard$/i))) { kws.escape = m[1]; kws.escapeExile = num(m[2]); return true; }
  if ((m = t.match(/^(mutate|morph|megamorph|spectacle|unearth) ((?:\{[^}]+\})+)$/i))) { kws[m[1].toLowerCase()] = m[2]; return true; }
  if ((m = t.match(/^afterlife (\d+)$/i))) { kws.afterlife = +m[1]; return true; }
  if ((m = t.match(/^(plains|island|swamp|mountain|forest)walk$/i))) { kws[m[1].toLowerCase() + "walk"] = true; return true; }
  if ((m = t.match(/^(basic land|plains|island|swamp|mountain|forest)cycling ((?:\{[^}]+\})+)$/i)) || (m = t.match(/^(basic land)cycling ((?:\{[^}]+\})+)$/i))) {
    const w = m[1].toLowerCase();
    kws.typecycling = { cost: m[2], filter: w === "basic land" ? { supertypes: ["basic"], types: ["land"] } : { subtypes: [w] }, text: m[1] };
    return true;
  }
  if ((m = t.match(/^flashback\s*[—-]\s*((?:\{[^}]+\})+), (.+)$/i))) { // "Flashback—{1}{U}, Pay 3 life."
    let add;
    try { add = parseCost(m[2]); } catch (e) { if (e instanceof Fail) return false; throw e; }
    kws.flashback = { cost: m[1], add };
    return true;
  }
  if (/^cascade$/i.test(t)) { kws.cascade = true; return true; }
  if ((m = t.match(/^craft with (.+?) ((?:\{[^}]+\})+)$/i))) {
    let w = m[1].trim(), n = 1;
    const mm = w.match(new RegExp(`^(${NUM_RE}) (?:or more )?(.+)$`, "i"));
    if (mm && !/^an?$/i.test(mm[1])) { n = num(mm[1]); w = mm[2]; }
    else if (mm) w = mm[2];
    let f;
    try { f = parseFilter(w.replace(/s$/, "")); } catch (e) { if (e instanceof Fail) return false; throw e; }
    delete f.controller; delete f.zone;
    kws.craft = { cost: m[2], with: f, n, text: m[1].trim() };
    return true;
  }
  return false;
}
function tryKeywordLine(L) {
  const first = L.split(/,\s*|\s+/)[0].toLowerCase();
  const items = splitTop(L, /,\s+/);
  const kws = {};
  // looks like a keyword line only if the first item is (or begins like) a keyword
  const startsKw = items.length && (SIMPLE_KW.has(items[0].trim().toLowerCase()) || /^(?:ward|protection from|equip|cycling|flashback|kicker|echo|overload|annihilator|toxic|escape-|mutate|morph|megamorph|spectacle|craft with|afterlife|unearth|cascade|basic landcycling|(?:plains|island|swamp|mountain|forest)(?:walk|cycling))\b/i.test(items[0]) || UNSUPPORTED_KW_RE.test(items[0].trim()));
  if (/^flashback\s*[—-]/i.test(L)) { const kws2 = {}; return kwItem(L, kws2) ? { kws: kws2 } : { unparsed: true }; }
  if (!startsKw) return null;
  for (const it of items) {
    if (!kwItem(it, kws)) {
      if (/^escape-/i.test(it.trim())) return null;
      return { unparsed: true };
    }
  }
  return { kws };
}

// ---------------------------------------------------------------------------------------------
// ability-line parsers (activated / triggered / static)

function findActivationColon(L) {
  const { masked, unmask } = maskQuotes(L);
  const i = masked.indexOf(": ");
  if (i < 0) return null;
  return [unmask(masked.slice(0, i)), unmask(masked.slice(i + 2))];
}

const EFFECT_EXTRACT_ACTIVATE_ONLY = /\s*Activate(?: this ability)? only (as a sorcery|during your turn|once each turn|as an instant|if (.+?)|any time you could cast a sorcery)\.?$/i;

function hasAddMana(effects) {
  return effects.some((e) => e.op === "addMana" || (e.op === "if" && (hasAddMana(e.then || []) || hasAddMana(e.else || []))));
}
const MANA_RIDER_OPS = new Set(["addMana", "damage", "loseLife", "if", "addCounters", "gainLife"]);

function parseActivated(L, text, mkCtx) {
  const sp = findActivationColon(L);
  if (!sp) return null;
  const [costTxt, effTxt0] = sp;
  if (/^(?:when|whenever|at) /i.test(costTxt)) return null;
  // loyalty
  let m;
  let cost;
  let loyalty = null;
  if ((m = costTxt.match(/^([+-]\d+|0|[+-]x)$/i))) {
    loyalty = m[1].toLowerCase() === "x" ? "x" : m[1];
    cost = { loyalty: /^[+-]x$/i.test(m[1]) ? "-x" : +m[1] };
  } else {
    try { cost = parseCost(costTxt); } catch (e) { if (e instanceof Fail) return null; throw e; }
  }
  // mana riders: spend restrictions and "when that mana is spent …" bonuses are attached to the addMana effects
  let restrict = null, onSpend = null;
  let effTxt = effTxt0.replace(/\s*Spend this mana only ([^.]*)\.?/i, (all, r) => { restrict = parseSpendRestriction(r); return ""; });
  effTxt = effTxt.replace(/\s*When that mana is spent to cast (.+?), ([^.]*)\.?$/i, (all, f, eff) => { onSpend = { spell: spendSpellFilter(f), effects: parseEffects(eff, mkCtx({})), text: "When that mana is spent to cast " + f + ", " + eff + "." }; return ""; }).trim();
  const ab = { kind: "activated", cost };
  let am = effTxt.match(EFFECT_EXTRACT_ACTIVATE_ONLY);
  let cond = null;
  while (am) {
    const w = am[1].toLowerCase();
    effTxt = effTxt.slice(0, am.index).trim();
    if (w === "as a sorcery" || w === "any time you could cast a sorcery") ab.sorcery = true;
    else if (w === "once each turn") ab.limit = "turn";
    else if (w === "during your turn") cond = { type: "yourTurn" };
    else if (w.startsWith("if ")) cond = parseCond(am[2], {});
    am = effTxt.match(EFFECT_EXTRACT_ACTIVATE_ONLY);
  }
  if (loyalty != null) { ab.loyalty = true; ab.sorcery = true; ab.limit = "turn"; }
  const ctx = mkCtx({ last: "self" });
  if (cost.sac || cost.sacSelf) ctx.sacrificed = !!cost.sac;
  const effects = parseEffects(effTxt, ctx);
  if (restrict || onSpend) {
    const adds = effects.filter((e) => e.op === "addMana");
    if (!adds.length) fail("mana rider without mana");
    for (const e of adds) { if (restrict) e.restrict = restrict; if (onSpend) e.onSpend = onSpend; }
  }
  if (ctx.targets.length) ab.targets = ctx.targets;
  ab.effects = effects;
  if (cond) ab.condition = cond;
  if (cost.exileSelf || ctx.selfFromGraveyard) ab.zone = "graveyard";
  if (hasAddMana(effects) && !ctx.targets.length && !loyalty && effects.every((e) => MANA_RIDER_OPS.has(e.op))) ab.mana = true;
  ab.text = text;
  return { ability: ab, partial: ctx.partial };
}

/** "to cast a creature spell of the chosen type or activate an ability of a creature source of the chosen type" */
function parseSpendRestriction(r) {
  const t = r.trim().replace(/[.]$/, "");
  const m = t.match(/^to cast (.+?)(?: or (?:to )?activate an ability of (.+))?$/i);
  if (!m || !/spells?(?: of the chosen type| that shares a creature type with your commander)?$/i.test(m[1])) fail("spend restriction: " + r);
  const out = { spell: spendSpellFilter(m[1]), text: "Spend this mana only " + t + "." };
  if (m[2]) {
    let a = m[2].trim().replace(/^(?:an?|one) /i, "");
    const chosen = / of the chosen type$/i.test(a);
    a = a.replace(/ of the chosen type$/i, "");
    if (!/ source$/i.test(a)) fail("spend restriction source: " + r);
    const f = parseFilter(a.replace(/ source$/i, ""));
    delete f._spell;
    if (chosen) f.chosenType = true;
    out.ability = f;
  }
  return out;
}
function spendSpellFilter(txt) {
  let t = txt.trim().replace(/^(?:an?|one) /i, "");
  let chosen = false, shares = false;
  if (/ of the chosen type$/i.test(t)) { chosen = true; t = t.replace(/ of the chosen type$/i, ""); }
  if (/ that shares a creature type with your commander$/i.test(t)) { shares = true; t = t.replace(/ that shares a creature type with your commander$/i, ""); }
  t = t.replace(/ spells?$/i, "");
  const f = parseFilter(t);
  delete f._spell;
  if (chosen) f.chosenType = true;
  if (shares) f.sharesTypeWithCommander = true;
  return f;
}

// ----- triggers

const CMP_VERBS = "enters(?: the battlefield)?|dies|leaves the battlefield|attacks|blocks";
const OR_ANOTHER_VERBS = "enters(?: the battlefield)?(?: from your graveyard)?|dies|leaves the battlefield|attacks|blocks";
function subjectFilter(t, ev) {
  // returns "self" | "equipped" | "enchanted" | Filter
  t = t.trim();
  if (t === "~") return "self";
  if (/^equipped creature$/i.test(t)) return "equipped";
  if (/^enchanted (?:creature|land|permanent)$/i.test(t)) return "enchanted";
  let other = false;
  let s = t;
  s = s.replace(/^(?:one or more|a|an|each|any)\s+/i, "");
  const f = parseFilter(s);
  if (f._spell) fail("spell subject");
  return f;
}

function parseWhenText(text) {
  let t = text.trim().replace(/’/g, "'");
  let m;
  const info = { subject: "self" };
  const one = (trig, extra) => ({ triggers: [trig], info: { ...info, ...extra } });
  if (/^the ring tempts you$/i.test(t)) return one({ event: "ringTempts", who: "you" }, { subject: "player" });
  if (/^you choose a creature as your ring-bearer$/i.test(t)) return one({ event: "ringBearerChosen", who: "you" }, { subject: "object" });
  if (/^you cycle (?:~|this card)$/i.test(t)) return one({ event: "cycled", who: "self" }, { subject: "self" });
  if (/^~ mutates$/i.test(t)) return one({ event: "mutates", who: "self" }, { subject: "self" });
  if (/^~ is turned face up$/i.test(t)) return one({ event: "turnedFaceUp", who: "self" }, { subject: "self" });
  if (/^you activate an ability$/i.test(t)) return one({ event: "abilityActivated", who: "you" }, { subject: "player" });
  if (/^you scry$/i.test(t)) return one({ event: "scry", who: "you" }, { subject: "player", amount: true });
  if ((m = t.match(/^an ability of (equipped creature|enchanted creature|~) is activated$/i))) return one({ event: "abilityActivated", who: /equipped/i.test(m[1]) ? "equipped" : /enchanted/i.test(m[1]) ? "enchanted" : "self" }, { subject: "object" });
  if ((m = t.match(/^(enchanted land|~|.+?) is tapped for mana$/i))) return one({ event: "tapped", who: subjectFilter(m[1]), forMana: true }, { subject: "object" });
  if ((m = t.match(/^(?:a|an) (.+?) card is put into a graveyard from anywhere other than the battlefield$/i))) {
    const f = parseFilter(m[1] + " card"); delete f.zone;
    return one({ event: "zoneChange", to: "graveyard", notFrom: "battlefield", filter: f }, { subject: "object" });
  }
  if ((m = t.match(/^(?:a|an) (.+?) card leaves your graveyard$/i))) {
    const f = parseFilter(m[1] + " card"); delete f.zone;
    return one({ event: "zoneChange", from: "graveyard", filter: { ...f, owner: "you" } }, { subject: "object" });
  }
  // "A, or B, or C" (Syr Konrad): one trigger per condition, same ability text
  if (/, or /i.test(t)) {
    const parts = t.split(/,? or (?=(?:an? |another |~ |one or more ))/i).map((x) => x.replace(/,$/, "").trim()).filter(Boolean);
    if (parts.length > 1) {
      const trigs = [];
      for (const pt of parts) trigs.push(...parseWhenText(pt).triggers);
      return { triggers: trigs, info: { subject: "object" } };
    }
  }
  if ((m = t.match(/^you cast (?:or copy )?(?:an? )?(.+?) spell$/i)) || /^you cast (?:or copy )?a spell$/i.test(t)) {
    const orCopy = /cast or copy/i.test(t);
    const tr = { event: "cast", who: "you" };
    if (m) { const f = parseFilter(m[1]); delete f._spell; if (Object.keys(f).length) tr.filter = f; }
    if (orCopy) tr.orCopy = true;
    return one(tr, { subject: "cast" });
  }
  if ((m = t.match(/^(an opponent|a player|each opponent) casts (?:an? )?(.+?) spell$/i)) || (m = t.match(/^(an opponent|a player|each opponent) casts a spell$/i))) {
    const tr = { event: "cast", who: /player/i.test(m[1]) ? "each" : "opponent" };
    if (m[2]) { const f = parseFilter(m[2]); delete f._spell; if (Object.keys(f).length) tr.filter = f; }
    return one(tr, { subject: "cast" });
  }
  if ((m = t.match(/^(you|an opponent|a player) draws? (?:a|your \w+) cards?$/i)) && !/your \w+ card/.test(t)) {
    const w = /^you$/i.test(m[1]) ? "you" : /opponent/i.test(m[1]) ? "opponent" : "each";
    return one({ event: "draw", who: w }, { subject: "player" });
  }
  if ((m = t.match(/^(you|an opponent|a player) (gain|lose)s? life$/i))) {
    const w = /^you$/i.test(m[1]) ? "you" : /opponent/i.test(m[1]) ? "opponent" : "each";
    return one({ event: m[2].toLowerCase() === "gain" ? "gainLife" : "loseLife", who: w }, { subject: "player", amount: true });
  }
  if ((m = t.match(/^you create or sacrifice an? token$/i))) {
    return { triggers: [{ event: "tokenCreated", who: "you" }, { event: "sacrifice", who: "you", filter: { token: true } }], info: { subject: "player" } };
  }
  if ((m = t.match(/^you sacrifice an? (.+)$/i))) {
    const f = parseFilter(m[1]);
    return one({ event: "sacrifice", who: "you", filter: f }, { subject: "object" });
  }
  if ((m = t.match(/^you (?:create|put) an? (.+?) tokens?$/i)) && false) return null;
  if (/^~ exploits a creature$/i.test(t)) return one({ event: "exploits", who: "self" }, { subject: "self" });
  if ((m = t.match(/^~ becomes the target of a spell$/i))) return one({ event: "becomesTarget", who: "self", by: "spell" }, { subject: "self", spellCtrl: true });
  if ((m = t.match(/^one or more (.+?) deal combat damage to (a player|you|an opponent)$/i))) {
    const f = parseFilter(m[1]);
    return one({ event: "dealsCombatDamage", who: f, to: "player", batch: true }, { subject: "object", amount: true, playerEvt: true });
  }
  // compound verbs: "<subj> attacks or dies"
  let cm = t.match(new RegExp(`^(.+?) (${CMP_VERBS}|becomes blocked)((?: or (?:${CMP_VERBS}|becomes blocked))+)$`, "i"));
  if (cm) {
    const verbs = [cm[2], ...cm[3].split(/ or /i).filter(Boolean)];
    const trigs = [];
    let inf = info;
    for (const v of verbs) { const r = parseWhenText(`${cm[1]} ${v}`); trigs.push(...r.triggers); inf = r.info; }
    return { triggers: trigs, info: inf };
  }
  // "~ or another creature you control dies"
  cm = t.match(new RegExp(`^(~|.+?) or (another .+?) (${OR_ANOTHER_VERBS})$`, "i"));
  if (cm) {
    const a = parseWhenText(`${cm[1]} ${cm[3]}`);
    const b = parseWhenText(`${cm[2]} ${cm[3]}`);
    return { triggers: [...a.triggers, ...b.triggers], info: { subject: "object" } };
  }
  // subject + verb
  const VERBS = [
    [/^(.+?) enters(?: the battlefield)?(?: under (your|an opponent's) control)?(?: from your graveyard)?$/i, (m2) => {
      const who = subjectFilter(m2[1]);
      const tr = { event: "enters", who: typeof who === "object" && m2[2] ? { ...who, controller: /your/i.test(m2[2]) ? "you" : "opponent" } : who };
      if (/from your graveyard$/i.test(t)) { tr.from = "graveyard"; tr.fromYours = true; }
      return tr;
    }],
    [/^(.+?) (?:dies|die)$/i, (m2) => ({ event: "dies", who: subjectFilter(m2[1]) })],
    [/^(.+?) is put into a graveyard from the battlefield$/i, (m2) => ({ event: "dies", who: subjectFilter(m2[1]) })],
    [/^(.+?) leaves the battlefield$/i, (m2) => ({ event: "leaves", who: subjectFilter(m2[1]) })],
    [/^(.+?) attacks alone$/i, (m2) => ({ event: "attacks", who: subjectFilter(m2[1]), alone: true })],
    [/^(.+?) attacks$/i, (m2) => ({ event: "attacks", who: subjectFilter(m2[1]) })],
    [/^(.+?) blocks(?: a creature)?$/i, (m2) => ({ event: "blocks", who: subjectFilter(m2[1]) })],
    [/^(.+?) becomes blocked$/i, (m2) => ({ event: "becomesBlocked", who: subjectFilter(m2[1]) })],
    [/^(.+?) deals combat damage to a player$/i, (m2) => ({ event: "dealsCombatDamage", who: subjectFilter(m2[1]), to: "player" })],
    [/^(.+?) is dealt damage$/i, (m2) => ({ event: "dealtDamage", who: subjectFilter(m2[1]) })],
    [/^(.+?) becomes tapped$/i, (m2) => ({ event: "tapped", who: subjectFilter(m2[1]) })],
  ];
  for (const [re, fn] of VERBS) {
    const mm = t.match(re);
    if (!mm) continue;
    const trig = fn(mm);
    const subj = trig.who;
    const subjKind = subj === "self" ? "self" : "object";
    const amount = trig.event === "dealtDamage" || trig.event === "dealsCombatDamage";
    return { triggers: [trig], info: { subject: subjKind, amount, playerEvt: trig.event === "dealsCombatDamage" } };
  }
  fail("trigger: " + text);
}

function parseBeginText(text) {
  let t = text.trim().replace(/’/g, "'");
  let m;
  const mk = (step, whose, extra) => ({ triggers: [{ event: "beginStep", step, whose }], info: { subject: whose === "you" ? "none" : "turnPlayer", ...extra } });
  if ((m = t.match(/^(?:the )?(?:(your|each opponent's|each player's|each|the) )?(upkeep|draw step|end step|combat on your turn|beginning of combat|first main phase|precombat main phase|postcombat main phase|second main phase|main phase)$/i)) ||
    (m = t.match(/^(your|each opponent's|each player's|each|the) (upkeep|draw step|end step)$/i))) {
    const who = (m[1] || "each").toLowerCase();
    const whose = who === "your" ? "you" : who === "each opponent's" ? "opponent" : "each";
    const st = m[2].toLowerCase();
    const step = st === "upkeep" ? "upkeep" : st === "draw step" ? "draw" : st === "end step" ? "end" : /first main|precombat main/.test(st) ? "main1" : /postcombat|second main/.test(st) ? "main2" : "beginCombat";
    if (st === "main phase") fail("main phase");
    if (/combat on your turn/.test(st)) return mk("beginCombat", "you");
    return mk(step, whose);
  }
  if ((m = t.match(/^combat on your turn$/i))) return mk("beginCombat", "you");
  if ((m = t.match(/^each combat$/i))) return mk("beginCombat", "each");
  if ((m = t.match(/^the end step$/i))) return mk("end", "each");
  fail("begin step: " + text);
}

function splitTriggerComma(body) {
  const out = [];
  const { masked, unmask } = maskQuotes(body);
  for (let i = 0; i < masked.length; i++) if (masked[i] === "," && masked[i + 1] === " ") out.push([unmask(masked.slice(0, i)), unmask(masked.slice(i + 2))]);
  return out;
}

function parseTriggered(L, text, mkCtx) {
  const m = L.match(/^(when|whenever|at)\s+(.+)$/is);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const body = m[2];
  const splits = splitTriggerComma(body);
  let lastErr = new Fail("no trigger comma");
  for (const [trigTxt, effTxt0] of splits) {
    let tr;
    try {
      if (kind === "at") {
        const mm = trigTxt.match(/^the beginning of (.+)$/i);
        if (!mm) fail("at ...");
        tr = parseBeginText(mm[1]);
      } else tr = parseWhenText(trigTxt);
    } catch (e) { if (!(e instanceof Fail)) throw e; lastErr = e; continue; }
    // trigger parsed; now the effect
    let effTxt = effTxt0;
    let cond = null;
    const ctxInfo = tr.info;
    const ctx = mkCtx({});
    ctx.trig = { amount: !!ctxInfo.amount, spellCtrl: !!ctxInfo.spellCtrl };
    if (ctxInfo.subject === "self" || ctxInfo.subject === "none") ctx.last = "self";
    else if (ctxInfo.subject === "object") ctx.last = EVT_OBJ;
    else if (ctxInfo.subject === "cast") { ctx.last = EVT_OBJ; ctx.player = EVT_PLAYER; }
    if (ctxInfo.subject === "player" || ctxInfo.subject === "turnPlayer" || ctxInfo.playerEvt) ctx.player = EVT_PLAYER;
    if (ctxInfo.spellCtrl) ctx.spellCtrl = true;
    // intervening if
    const im = effTxt.match(/^if (.+?)$/is);
    if (im) {
      const cs = splitTriggerComma(im[1]);
      for (const [ct, rest] of cs) {
        try { cond = parseCond(ct, ctx); effTxt = rest; break; } catch (e) { if (!(e instanceof Fail)) throw e; cond = null; }
      }
    }
    let ab;
    try {
      ab = buildTriggeredBody(effTxt, ctx);
    } catch (e) { if (!(e instanceof Fail)) throw e; lastErr = e; continue; }
    const abilities = tr.triggers.map((on) => {
      const a = { kind: "triggered", on: clone(on), ...clone(ab.body) };
      if (cond) a.condition = clone(cond);
      if (on.event === "tapped" && on.forMana && !a.targets && (a.effects || []).length && a.effects.every((e) => e.op === "addMana")) a.manaTrigger = true; // CR 605.1b
      if (on.event === "abilityActivated" && cond && cond.type === "event" && cond.key === "isMana") { delete a.condition; a.on.nonMana = true; }
      a.text = text;
      return a;
    });
    for (const a of abilities) if (ctx.selfFromGraveyard) a.zone = "graveyard";
    return { abilities, partial: ctx.partial };
  }
  throw lastErr;
}

function buildTriggeredBody(effTxt, ctx) {
  const body = {};
  const mm = effTxt.match(/^choose (one|two|one or more|any number)\s*(?:—|-)\s*\n(.*)$/is);
  if (mm) {
    const ms = parseModeBlock(mm[1], mm[2], ctx);
    body.effects = [];
    body.modes = ms;
    return { body };
  }
  let t = effTxt.trim();
  // single "you may ..." sentence => optional
  const effects = parseEffects(t, ctx);
  if (ctx.targets.length) body.targets = ctx.targets;
  if (effects.length === 1 && effects[0].op === "may" && !effects[0].cost && !effects[0].else && !effects[0].who) {
    body.optional = true;
    body.effects = effects[0].effects;
  } else body.effects = effects;
  return { body };
}

function parseModeBlock(countWord, bullets, ctx0, mkCtx) {
  const lines = bullets.split(/\n/).map((l) => l.replace(/^•\s*/, "").replace(/^[A-Z][A-Za-z' ]{1,28} — /, "").trim()).filter(Boolean);
  const cw = countWord.toLowerCase();
  const modes = [];
  for (const l of lines) {
    const ctx = createCtx({ last: ctx0.last, player: ctx0.player, trig: ctx0.trig, parseAbility: ctx0.parseAbility, sacrificed: ctx0.sacrificed, isSpell: ctx0.isSpell });
    const effects = parseEffects(l, ctx);
    const mode = { text: l.replace(/~/g, ctx0.cardName || "~") };
    if (ctx.targets.length) mode.targets = ctx.targets;
    mode.effects = effects;
    modes.push(mode);
  }
  const n = modes.length;
  if (cw === "one") return { min: 1, max: 1, modes };
  if (cw === "two") return { min: 2, max: 2, modes };
  if (cw === "one or more") return { min: 1, max: n, modes };
  return { min: 0, max: n, modes };
}

// ----- statics

function manaGeneric(sym) {
  const m = sym.match(/^\{(\d+)\}$/);
  return m ? +m[1] : null;
}

function wrapCond(L, ab) { return ab; }

function parseStaticLine(L, text, def, mkCtx) {
  let m;
  const st = (effect, condition) => {
    const a = { kind: "static", effect };
    if (condition) a.condition = condition;
    a.text = text;
    return a;
  };
  let condition = null;
  let s = L.replace(/[.]$/, "");
  // leading / trailing conditions
  if ((m = s.match(/^during your turn, (.+)$/i))) { condition = { type: "yourTurn" }; s = m[1]; }
  else if ((m = s.match(/^as long as (.+?), (.+)$/i))) { condition = parseCond(m[1], {}); s = m[2]; }
  else if ((m = s.match(/^(.+?) as long as (.+)$/i)) && (!/^you may/i.test(s) || /^you may cast ~ from your graveyard as long as/i.test(s))) { condition = parseCond(m[2], {}); s = m[1]; }

  if (/^~ enters (?:the battlefield )?tapped$/i.test(s)) return [st({ type: "entersTapped", affects: "self" }, condition)];
  if ((m = s.match(/^~ enters (?:the battlefield )?tapped unless (.+)$/i))) return [st({ type: "entersTapped", affects: "self", unless: parseCond(m[1], {}) }, condition)];
  if ((m = s.match(/^as ~ enters, you may reveal an? (.+?) card from your hand\. if you don't, (?:~|it) enters tapped$/i))) {
    return [st({ type: "entersTapped", affects: "self", unless: { type: "hasInHand", filter: parseFilter(m[1] + " card") } })];
  }
  if ((m = s.match(/^as ~ enters, you may pay (\d+) life\. if you don't, (?:~|it) enters tapped$/i))) {
    return [st({ type: "entersTapped", affects: "self", unlessPay: { life: +m[1] } })];
  }
  if ((m = s.match(new RegExp(`^~ enters with (${NUM_RE}) ([^ ]+) counters? on it$`, "i")))) {
    return [st({ type: "entersWithCounters", kind: m[2].toLowerCase(), amount: num(m[1]) }, condition)];
  }
  if (/^~ can't block$/i.test(s)) return [st({ type: "cantBlock", affects: "self" }, condition)];
  if (/^~ can't attack$/i.test(s)) return [st({ type: "cantAttack", affects: "self" }, condition)];
  if (/^~ can't attack or block$/i.test(s)) return [st({ type: "cantAttack", affects: "self" }, condition), st({ type: "cantBlock", affects: "self" }, condition)];
  if (/^~ can't be blocked$/i.test(s)) return [st({ type: "cantBeBlocked", affects: "self" }, condition)];
  if ((m = s.match(/^~ can't be blocked except by (.+)$/i))) return [st({ type: "cantBeBlocked", affects: "self", exceptBy: parseFilter(m[1]) }, condition)];
  if (/^~ can't be countered$/i.test(s)) return [st({ type: "cantBeCountered" }, condition)];
  if (/^~ attacks each (?:combat|turn) if able$/i.test(s)) return [st({ type: "mustAttack", affects: "self" }, condition)];
  if (/^you have no maximum hand size$/i.test(s)) return [st({ type: "noMaxHand" })];
  if ((m = s.match(/^you may activate abilities of (.+?) as though (?:those creatures|they|it) had haste$/i))) { const f = parseFilter(m[1]); delete f._spell; return [st({ type: "activateAsHaste", affects: f }, condition)]; }
  if (/^as ~ enters(?: the battlefield)?, choose a creature type$/i.test(s)) return [st({ type: "asEntersChoose", choice: "creatureType" })];
  if ((m = s.match(/^as ~ enters(?: the battlefield)?, choose a color(?: other than (white|blue|black|red|green))?$/i))) return [st({ type: "asEntersChoose", choice: "color", ...(m[1] ? { except: COLORS[m[1].toLowerCase()] } : {}) })];
  if ((m = s.match(/^~ enters (?:the battlefield )?tapped\. as it enters, choose a color(?: other than (white|blue|black|red|green))?$/i))) return [st({ type: "entersTapped", affects: "self" }), st({ type: "asEntersChoose", choice: "color", ...(m[1] ? { except: COLORS[m[1].toLowerCase()] } : {}) })];
  if ((m = s.match(/^if (?:a|an) (.+?) would die, exile it instead$/i))) { const f = parseFilter(m[1]); delete f._spell; return [st({ type: "exileInsteadOfDying", affects: f }, condition)]; }
  if ((m = s.match(/^you may have ~ enter(?: the battlefield)? as a copy of (?:an? |any )?(.+?)(?:, except (.+))?$/i))) {
    const f = parseFilter(m[1]); delete f._spell;
    const except = {};
    if (m[2]) for (const part of m[2].split(/,\s*(?:and\s+)?(?=it )|\s+and\s+(?=it )/i).map((x) => x.trim()).filter(Boolean)) {
      let mm;
      if (/^it isn't legendary$/i.test(part)) except.nonLegendary = true;
      else if ((mm = part.match(/^it enters with an additional (\+1\/\+1|loyalty) counter on it if it's an? (creature|planeswalker)$/i))) ((except.counters ||= {})[mm[2].toLowerCase()] ||= {})[mm[1].toLowerCase()] = 1;
      else if ((mm = part.match(/^it's an? (\w+) in addition to its other types$/i))) (except.addTypes ||= []).push(mm[1].toLowerCase());
      else fail("copy exception: " + part);
    }
    return [st({ type: "asEntersCopy", filter: f, optional: true, except })];
  }
  if ((m = s.match(/^you may play an additional land on each of your turns$/i))) return [st({ type: "extraLand", n: 1 })];
  // cost modification
  if ((m = s.match(/^~ costs ((?:\{\d+\})) less to cast for each (.+)$/i))) {
    return [st({ type: "selfCostMod", per: countOf(m[2], { flags: {}, last: null }), amount: -manaGeneric(m[1]) }, condition)];
  }
  if ((m = s.match(/^~ costs \{x\} less to cast, where x is (.+)$/i))) {
    return [st({ type: "selfCostMod", per: expr(m[1], { flags: {}, last: null }), amount: -1 }, condition)];
  }
  if ((m = s.match(/^~ costs (\{\d+\}) less to cast(?: if (.+))?$/i))) {
    const c = m[2] ? parseCond(m[2], {}) : condition;
    return [st({ type: "selfCostMod", per: 1, amount: -manaGeneric(m[1]) }, c)];
  }
  if ((m = s.match(/^(.+?) spells you cast(?: with (.+?))? cost (\{\d+\}) (less|more) to cast$/i))) {
    const f = parseFilter(m[1] + (m[2] ? " with " + m[2] : ""));
    delete f._spell;
    const n = manaGeneric(m[3]);
    return [st({ type: "costMod", filter: f, who: "you", amount: m[4].toLowerCase() === "less" ? -n : n }, condition)];
  }
  if ((m = s.match(/^spells (?:you|your opponents) cast cost (\{\d+\}) (less|more) to cast$/i))) {
    const n = manaGeneric(m[1]);
    return [st({ type: "costMod", filter: {}, who: /your opponents/i.test(s) ? "opponent" : "you", amount: m[2].toLowerCase() === "less" ? -n : n }, condition)];
  }
  if ((m = s.match(/^if you control a commander, you may cast ~ without paying its mana cost$/i))) {
    return [st({ type: "castFree" }, { type: "control", filter: { isCommander: true, controller: "you" }, op: ">=", n: 1 })];
  }
  if ((m = s.match(/^you may cast ~ from your graveyard$/i)) && condition) return [st({ type: "castFrom", zone: "graveyard" }, condition)];
  // doubling triggers
  if (/^if a creature dying causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time$/i.test(s)) {
    return [st({ type: "doubleTriggers", event: "dies", filter: { types: ["creature"] } })];
  }
  if ((m = s.match(/^if an? (.+?) entering the battlefield causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time$/i))) {
    return [st({ type: "doubleTriggers", event: "enters", filter: parseFilter(m[1]) })];
  }
  // damage modification (shape matches engine.modifyDamage: source Filter, sourceController, to string, mul/add/prevent)
  if ((m = s.match(/^if an? ([a-z ]*?)source( you control)? would deal damage to (.+?), (?:it|that source) deals (double|triple|that much damage plus (\d+))(?: (?:that damage|damage))?(?: to (?:that player|that permanent|that player or permanent|that permanent or player))? instead$/i))) {
    const e = { type: "damageMod", to: damageVictims(m[3]) };
    if (m[1].trim()) { const f = parseFilter(m[1].trim() + " permanent"); delete f.types; e.source = f; }
    if (m[2]) e.sourceController = "you";
    if (/double/i.test(m[4])) e.mul = 2; else if (/triple/i.test(m[4])) e.mul = 3; else e.add = +m[5];
    return [st(e)];
  }
  if ((m = s.match(/^if a source would deal damage to (.+?), prevent half that damage, rounded (up|down)$/i)) && m[2].toLowerCase() === "up") {
    return [st({ type: "damageMod", to: damageVictims(m[1]), prevent: "half" })];
  }
  // characteristic-defining
  if ((m = s.match(/^~'s power and toughness are each equal to (.+)$/i))) {
    const a = expr(m[1], { flags: {}, last: null });
    return [st({ type: "setPT", power: a, toughness: a })];
  }
  // pump / keyword grants
  const subjRe = /^(~|equipped creature|enchanted creature|enchanted land|.+? you control|.+?)\s+/;
  if ((m = s.match(/^(.+?) (gets?|has|have|gains?) (.+)$/i))) {
    const affects = staticAffects(m[1]);
    if (affects) {
      const rest = m[3];
      let pm = rest.match(/^([+-]\d+)\/([+-]\d+)(?: and (?:has|have|gains?) (.+?))?(?: for each (.+))?$/i);
      if (/^gets?$/i.test(m[2]) && pm) {
        let power = +pm[1], toughness = +pm[2];
        if (pm[4]) { const per = countOf(pm[4], { flags: {}, last: null }); power = power === 0 ? 0 : { mul: [power, per] }; toughness = toughness === 0 ? 0 : { mul: [toughness, per] }; }
        const e = { type: "pump", affects, power, toughness };
        if (pm[3]) e.keywords = parseKeywordList(pm[3]);
        return [st(e, condition)];
      }
      if (/^(?:has|have|gains?)$/i.test(m[2])) {
        const kws = parseKeywordList(rest);
        return [st({ type: "pump", affects, power: 0, toughness: 0, keywords: kws }, condition)];
      }
    }
  }
  fail("static: " + L);
}

function damageVictims(txt) {
  const t = txt.trim().toLowerCase();
  if (t === "an opponent") return "opponent";
  if (t === "an opponent or a permanent an opponent controls") return "opponentOrPermanent";
  if (t === "you or a permanent you control") return "youOrPermanent";
  if (t === "a permanent or player" || t === "a player or permanent") return "any";
  fail("damage victims: " + txt);
}

function staticAffects(t) {
  t = t.trim();
  if (t === "~") return "self";
  if (/^equipped creature$/i.test(t)) return "equipped";
  if (/^enchanted (?:creature|land)$/i.test(t)) return "enchanted";
  if (/^(?:it|that creature)$/i.test(t)) return null;
  try {
    const f = parseFilter(t);
    if (f._spell) return null;
    return f;
  } catch (e) { if (e instanceof Fail) return null; throw e; }
}

// ---------------------------------------------------------------------------------------------
// card compile

const TYPE_ORDER = ["artifact", "battle", "creature", "enchantment", "instant", "land", "planeswalker", "sorcery", "tribal", "kindred"];
const SUPERTYPE_WORDS = ["legendary", "basic", "snow", "world", "ongoing"];

function splitTypeLine(tl) {
  const first = String(tl || "").split("//")[0];
  const [left, right] = first.split("—");
  const words = left.trim().split(/\s+/).filter(Boolean).map((w) => w.toLowerCase());
  return {
    supertypes: words.filter((w) => SUPERTYPE_WORDS.includes(w)),
    types: words.filter((w) => !SUPERTYPE_WORDS.includes(w)),
    subtypes: right ? right.trim().split(/\s+/).filter(Boolean).map((w) => w.toLowerCase()) : [],
  };
}
function ptOf(v) {
  if (v == null || v === "") return null;
  if (/^-?\d+$/.test(String(v))) return +v;
  return "*";
}

function groupLines(raw) {
  const lines = String(raw || "").split("\n").map((l) => stripReminder(normChars(l)).replace(/^\[([+-]?(?:\d+|x))\]:\s*/i, "$1: "));
  const groups = [];
  for (const l of lines) {
    if (!l) continue;
    if (groups.length && (/^•/.test(l) || /^\d+(?:-\d+)?\s*\|/.test(l) || /^\d+-\d+ \|/.test(l))) { groups[groups.length - 1] += "\n" + l; continue; }
    groups.push(l);
  }
  return groups;
}

const ABILITY_WORD_RE = /^([A-Z][A-Za-z' ]{1,28}?) — (.+)$/s;
const LABEL_BLACKLIST = /^(?:choose|escape|craft|spectacle|kicker)/i;
function stripAbilityWord(L) {
  const m = L.match(ABILITY_WORD_RE);
  if (m && !LABEL_BLACKLIST.test(m[1]) && !/^[+-]?\d/.test(m[1]) && !/^(?:Choose|When|Whenever|At)\b/.test(m[1])) return m[2];
  return L;
}

function mkCtxFactory(def, extra = {}) {
  const f = (o = {}) => { const c = createCtx({ ...o, parseAbility: parseQuotedAbility, isSpell: extra.isSpell, sacrificed: extra.sacrificed || o.sacrificed }); c.cardName = def ? def.name : undefined; return c; };
  return f;
}

/** parse the text of a quoted token/ability: "Sacrifice this token: Add {C}." */
function parseQuotedAbility(q) {
  const L = selfify(normChars(q), []).replace(/[.]$/, "");
  const r = parseAbilityLine(L, q, null, mkCtxFactory(null));
  if (!r) fail("quoted ability");
  if (r.partial) fail("partial quoted ability");
  return r.abilities;
}

/** shared: activated / triggered / static for a single line. Returns {abilities, partial} or null */
function parseAbilityLine(L, text, def, mkCtx, o = {}) {
  const act = parseActivated(L, text, mkCtx);
  if (act) return { abilities: [act.ability], partial: act.partial };
  if (/^(?:when|whenever|at)\s/i.test(L)) {
    const t = parseTriggered(L, text, mkCtx);
    return { abilities: t.abilities, partial: t.partial };
  }
  // keyword-grant lines inside quotes ("Flying")
  const kl = tryKeywordLine(L);
  if (kl && kl.kws) return { abilities: [{ kind: "static", effect: { type: "pump", affects: "self", power: 0, toughness: 0, keywords: Object.keys(kl.kws) }, text }], partial: false };
  const s = parseStaticLine(L, text, def, mkCtx);
  return { abilities: s, partial: false };
}

const ROMANS = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
const CHAPTER_RE = /^((?:I|II|III|IV|V|VI|VII|VIII|IX|X)(?:, (?:I|II|III|IV|V|VI|VII|VIII|IX|X))*) — (.+)$/s;
/** Saga chapter line "I, II — effect" -> triggered abilities on the `chapter` event (fired as lore counters are added). */
function parseChapterLine(nums, body, text, mkCtx) {
  const chapters = nums.split(", ").map((x) => ROMANS[x]);
  const ctx = mkCtx({});
  ctx.last = "self";
  let eff = body;
  const lm = eff.match(/^([A-Z][A-Za-z']+(?: [A-Z][A-Za-z']+){0,2}) — (?!\n)(.+)$/s); // Summon: "Lightning — This creature deals ..."
  if (lm && !/^choose\b/i.test(lm[1])) eff = lm[2];
  const { body: b } = buildTriggeredBody(eff, ctx);
  return { abilities: [{ kind: "triggered", on: { event: "chapter", who: "self", chapters }, ...clone(b), text }], partial: ctx.partial };
}

function compileFace(d, o = {}) {
  const name = d.name || "";
  const tl = splitTypeLine(d.type_line);
  const cost = d.mana_cost || "";
  const def = {
    name, cost, cmc: d.cmc != null && !o.cmcFromCost ? d.cmc : cmcOfCost(cost),
    colors: Array.isArray(d.colors) ? [...d.colors] : colorsOfCost(cost),
    identity: Array.isArray(d.color_identity) ? [...d.color_identity] : [],
    supertypes: tl.supertypes, types: tl.types, subtypes: tl.subtypes,
    power: null, toughness: null, loyalty: null,
    img: d.img || null, text: d.oracle_text || "",
    keywords: {}, abilities: [], spell: null, additionalCost: null, faces: null, layout: "normal", unparsed: [],
  };
  const pt = d.pt ? String(d.pt).split("/") : null;
  if (pt && pt.length === 2) { def.power = ptOf(pt[0]); def.toughness = ptOf(pt[1]); }
  else if (d.power != null && d.toughness != null) { def.power = ptOf(d.power); def.toughness = ptOf(d.toughness); }
  if (d.loyalty != null && d.loyalty !== "") def.loyalty = /^\d+$/.test(String(d.loyalty)) ? +d.loyalty : /^x$/i.test(String(d.loyalty)) ? "x" : "*";

  const isSpellCard = def.types.includes("instant") || def.types.includes("sorcery");
  const isBasic = def.supertypes.includes("basic");
  const names = selfNames(name, isBasic);
  const groups = groupLines(d.oracle_text);
  const stats = { lines: 0, parsed: 0, partial: [], unparsed: [] };

  const mkCtx = mkCtxFactory(def, { isSpell: isSpellCard });
  const spellCtx = mkCtx({});
  spellCtx.cardName = name;
  let spellEffects = [];
  let spellModes = null;
  let spellLinesParsed = 0;
  const isSaga = def.subtypes.includes("saga"), isClass = def.subtypes.includes("class");
  let gate = null, gateKind = null, gateLevel = 0; // condition gating the abilities of the lines that follow (Class level / Level up tier)

  for (const g of groups) {
    const raw = g;
    const text = raw;
    let L = selfify(raw, names);
    if (/^a deck can have/i.test(L)) continue;
    stats.lines++;
    const bad = (why) => { def.unparsed.push(raw); stats.unparsed.push(raw); };
    try {
      let m;
      if (/^~ can be your commander$/i.test(L)) { stats.parsed++; continue; } // deck-building permission only
      // Sagas (chapter abilities, read ahead), Classes (level-up lines + gated abilities), Level up creatures (LEVEL blocks)
      if (isSaga && /^read ahead$/i.test(L.replace(/[.]$/, ""))) { def.keywords.readAhead = true; stats.parsed++; continue; }
      if (isSaga && (m = L.match(CHAPTER_RE))) {
        const r = parseChapterLine(m[1], m[2], text, mkCtx);
        def.abilities.push(...r.abilities);
        if (r.partial) { stats.partial.push(raw); def.unparsed.push(raw); } else stats.parsed++;
        continue;
      }
      if ((m = L.match(/^level up (\{[^:]+\})$/i))) { def.keywords.levelUp = m[1]; stats.parsed++; continue; }
      if (def.types.includes("creature") && (m = L.match(/^level (\d+)(?:-(\d+)|\+)$/i))) {
        gate = { type: "and", all: [{ type: "counters", what: "self", kind: "level", op: ">=", n: +m[1] }, ...(m[2] ? [{ type: "counters", what: "self", kind: "level", op: "<=", n: +m[2] }] : [])] };
        gateKind = "level"; stats.parsed++; continue;
      }
      if (gateKind === "level" && (m = L.match(/^(\d+)\/(\d+)$/))) {
        def.abilities.push({ kind: "static", effect: { type: "setPT", affects: "self", power: +m[1], toughness: +m[2] }, condition: gate, text: L });
        stats.parsed++; continue;
      }
      if (isClass && (m = L.match(/^(\{.+\}): level (\d+)$/i))) {
        const lv = +m[2];
        def.abilities.push({ kind: "activated", cost: parseCost(m[1]), sorcery: true, classLevel: lv, condition: { type: "counters", what: "self", kind: "level", op: "==", n: lv - 1 }, effects: [{ op: "addCounters", what: "self", kind: "level", amount: 1 }], text: raw });
        gate = { type: "counters", what: "self", kind: "level", op: ">=", n: lv }; gateKind = "class"; gateLevel = lv;
        stats.parsed++; continue;
      }
      if (isClass && (m = L.match(/^when ~ becomes level (\d+), (.+)$/i))) {
        const ctxL = mkCtx({}); ctxL.last = "self";
        const { body } = buildTriggeredBody(m[2], ctxL);
        def.abilities.push({ kind: "triggered", on: { event: "counterAdded", who: "self", kind: "level" }, condition: { type: "counters", what: "self", kind: "level", op: "==", n: +m[1] }, ...body, text });
        if (ctxL.partial) { stats.partial.push(raw); def.unparsed.push(raw); } else stats.parsed++;
        continue;
      }
      // 1. keyword line
      const kl = tryKeywordLine(L.replace(/[.]$/, ""));
      if (kl) {
        if (kl.unparsed) { bad(); continue; }
        if (gate && kl.kws) { // keywords granted only at a Class level / Level up tier
          def.abilities.push({ kind: "static", effect: { type: "pump", affects: "self", power: 0, toughness: 0, keywords: Object.keys(kl.kws) }, condition: gate, text });
          stats.parsed++; continue;
        }
        for (const [k, v] of Object.entries(kl.kws)) {
          if (k === "protection") def.keywords.protection = [...new Set([...(def.keywords.protection || []), ...v])];
          else def.keywords[k] = v;
        }
        stats.parsed++;
        continue;
      }
      // enchant
      if ((m = L.match(/^enchant (.+)$/i)) && def.subtypes.includes("aura")) {
        def.enchant = parseFilter(m[1]);
        stats.parsed++;
        continue;
      }
      // additional cost
      if ((m = L.match(/^as an additional cost to cast (?:this spell|~), (.+?)\.?$/i))) {
        def.additionalCost = parseAdditionalCost(m[1]);
        spellCtx.sacrificed = !!(def.additionalCost.sac || (def.additionalCost.oneOf || []).some((c) => c.sac));
        stats.parsed++;
        continue;
      }
      // "As ~ enters, choose A or B." + "• A — ability" bullets (Sieges): a choice made as it enters, each ability conditional on it
      if ((m = L.match(/^as ~ enters(?: the battlefield)?, choose (\w+) or (\w+)\.?\s*\n(.+)$/is))) {
        const ids = [m[1].toLowerCase(), m[2].toLowerCase()];
        const bullets = m[3].split("\n").map((x) => x.replace(/^•\s*/, "").trim()).filter(Boolean);
        const abs = [];
        const options = [];
        for (const b of bullets) {
          const bm = b.match(/^(\w+) — (.+)$/);
          if (!bm || !ids.includes(bm[1].toLowerCase())) fail("choice bullet");
          const r = parseAbilityLine(bm[2], text.split("\n").find((x) => x.includes(bm[2].slice(0, 20))) || bm[2], def, mkCtx);
          if (r.partial) fail("partial choice bullet");
          const cond = { type: "chosen", key: "mode", value: bm[1].toLowerCase() };
          for (const a of r.abilities) { a.condition = a.condition ? { type: "and", all: [cond, a.condition] } : cond; a.text = bm[1] + " — " + bm[2].replace(/~/g, name); abs.push(a); }
          options.push({ id: bm[1].toLowerCase(), label: bm[1] + " — " + bm[2].replace(/~/g, name) });
        }
        def.abilities.push({ kind: "static", effect: { type: "asEntersChoose", choice: "mode", options }, text: `As ${name} enters, choose ${m[1]} or ${m[2]}.` }, ...abs);
        stats.parsed++;
        continue;
      }
      // strip ability-word label
      L = stripAbilityWord(L);
      const textNoLabel = stripAbilityWord(text);

      // spell cards: static-looking cost lines first
      const staticFirst = /^(?:~ costs|~ can't be countered|if you control a commander, you may cast)/i.test(L);
      if (isSpellCard && !staticFirst && !/^(?:when|whenever|at)\s/i.test(L) && !findActivationColon(L)) {
        // spell text
        let mm = L.match(/^choose (one|two|one or more|any number)\s*(?:—|-)\s*\n(.*)$/is);
        if (mm) {
          const ms = parseModeBlock(mm[1], mm[2], spellCtx);
          if (spellModes || spellEffects.length) fail("modes mixed");
          spellModes = ms;
        } else if ((mm = L.match(/^choose one\. if you control a commander as you cast this spell, you may choose both instead\.\s*\n(.*)$/is))) {
          const ms = parseModeBlock("one", mm[1], spellCtx);
          ms.maxIf = { cond: { type: "control", filter: { isCommander: true, controller: "you" }, op: ">=", n: 1 }, max: 2 };
          spellModes = ms;
        } else {
          spellCtx.priorEffects = spellEffects.length;
          const savedAllow = spellCtx.allowManual;
          spellCtx.allowManual = spellEffects.length > 0 || spellModes != null;
          const effs = parseEffects(L, spellCtx);
          spellCtx.allowManual = savedAllow;
          spellEffects.push(...effs);
          if (spellCtx.partial) { stats.partial.push(raw); def.unparsed.push(raw); spellCtx.partial = false; continue; }
        }
        stats.parsed++;
        continue;
      }
      // abilities
      const r = parseAbilityLine(L, textNoLabel, def, mkCtx);
      if (gate) for (const a of r.abilities) { a.condition = a.condition ? { type: "and", all: [gate, a.condition] } : gate; if (gateLevel) a.level = gateLevel; }
      def.abilities.push(...r.abilities);
      if (r.partial) { stats.partial.push(raw); def.unparsed.push(raw); } else stats.parsed++;
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      bad(e.message);
      if (typeof process !== "undefined" && process.env && process.env.PARSER_DEBUG) console.error(`[${name}] ${raw.replace(/\n/g, " / ")} -> ${e.message}`);
    }
  }
  if (isSaga) {
    const ch = def.abilities.filter((a) => a.on && a.on.event === "chapter").flatMap((a) => a.on.chapters);
    if (ch.length) {
      def.finalChapter = Math.max(...ch);
      if (def.keywords.readAhead) def.abilities.unshift({ kind: "static", effect: { type: "asEntersChoose", choice: "chapter", max: def.finalChapter }, text: "Read ahead" });
    }
  }
  if (isClass) def.abilities.unshift({ kind: "static", effect: { type: "entersWithCounters", kind: "level", amount: 1 }, text: "Level 1" });
  // finish spell
  if (isSpellCard) {
    if (spellModes) def.spell = { effects: spellEffects, modes: spellModes };
    else def.spell = { effects: spellEffects };
    if (spellCtx.targets.length) def.spell.targets = spellCtx.targets;
  }
  // intrinsic mana abilities of basic land types
  if (def.types.includes("land")) {
    for (const st of def.subtypes) {
      const c = BASIC_LAND_TYPES[st];
      if (!c) continue;
      const mana = `{${c}}`;
      const has = def.abilities.some((a) => a.kind === "activated" && a.mana && a.effects.some((e) => e.op === "addMana" && e.mana === mana));
      if (!has) def.abilities.unshift({ kind: "activated", cost: { tap: true }, effects: [{ op: "addMana", mana }], mana: true, text: `{T}: Add ${mana}.` });
    }
  }
  def._stats = stats;
  return def;
}

function parseAdditionalCost(txt) {
  const t = txt.replace(/[.]$/, "");
  // "discard a card or pay 3 life" / "sacrifice a creature or pay {4}"
  const alts = splitTop(t, /\s+or\s+(?=(?:pay|discard|sacrifice)\b)/i);
  if (alts.length > 1) return { oneOf: alts.map((a) => parseCost(a)) };
  const m = t.match(/^pay x life$/i);
  if (m) return { life: "x" };
  return parseCost(t);
}

export function compileCard(card) {
  return analyzeCard(card).def;
}

export function analyzeCard(card) {
  const faces = Array.isArray(card.faces) ? card.faces.filter(Boolean) : null;
  if (faces && faces.length >= 2) {
    const adventure = /adventure/i.test(faces[1].type_line || "");
    const frontText = faces[0].oracle_text || "";
    const backHasCost = !!(faces[1].mana_cost && faces[1].mana_cost.trim());
    const layout = adventure ? "adventure" : /transform|craft|disturb|daybound|more than meets/i.test(frontText) ? "transform"
      : (backHasCost || /\bland\b/i.test(faces[1].type_line || "") && !/\bland\b/i.test(faces[0].type_line || "")) ? "mdfc" : "transform";
    const defs = [], statsAll = [];
    faces.forEach((f, i) => {
      const fd = {
        name: f.name, mana_cost: f.mana_cost || "", type_line: f.type_line, oracle_text: f.oracle_text || "", pt: f.pt, loyalty: f.loyalty,
        img: f.img || card.img, colors: Array.isArray(f.colors) ? f.colors : i === 0 ? card.colors : (f.mana_cost ? undefined : card.colors),
        color_identity: card.color_identity, cmc: i === 0 ? card.cmc : (layout === "transform" ? card.cmc : undefined),
      };
      const d = compileFace(fd, { cmcFromCost: i > 0 && layout !== "transform" });
      defs.push(d);
    });
    const front = defs[0];
    const top = clone({ ...front, faces: null });
    top.name = card.name || front.name;
    top.cmc = card.cmc != null ? card.cmc : front.cmc;
    top.colors = Array.isArray(card.colors) ? [...card.colors] : top.colors;
    top.identity = Array.isArray(card.color_identity) ? [...card.color_identity] : top.identity;
    top.img = card.img || top.img;
    top.text = faces.map((f) => f.oracle_text || "").join("\n//\n");
    top.layout = layout;
    const stripped = defs.map((d) => { const x = clone(d); delete x._stats; return x; });
    top.faces = stripped;
    top.unparsed = [...new Set(defs.flatMap((d) => d.unparsed))];
    const stats = defs.reduce((a, d) => ({ lines: a.lines + d._stats.lines, parsed: a.parsed + d._stats.parsed, partial: [...a.partial, ...d._stats.partial], unparsed: [...a.unparsed, ...d._stats.unparsed] }), { lines: 0, parsed: 0, partial: [], unparsed: [] });
    delete top._stats;
    return { def: top, ...stats };
  }
  const d = compileFace({ ...card, colors: card.colors, color_identity: card.color_identity });
  const stats = d._stats;
  delete d._stats;
  return { def: d, ...stats };
}
