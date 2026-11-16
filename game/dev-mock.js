/* DEV ONLY. A fake engine/AI/decks backend with a hand-authored board and a scripted game, so the UI can be
   developed and screenshotted before the real engine exists. It satisfies the SPEC section 1 API.
   Not shipped (not in sw.js SHELL). Scene is chosen with ?scene=... */

let SEED = null;
export async function loadSeed(url) {
  SEED = await (await fetch(url || "../data/seed.json")).json();
  const app = { state: { cards: SEED.cards, decks: SEED.decks, collection: {}, wishlist: {}, binders: [], meta: {} } };
  return app;
}

/* ---------- decks (the real decks.js contract) ---------- */
function nameIndex(cards) {
  const m = new Map();
  Object.keys(cards).forEach((k) => { const c = cards[k]; if (!m.has(c.name.toLowerCase())) m.set(c.name.toLowerCase(), c); });
  return m;
}
function deckCards(state, d) {
  const byName = nameIndex(state.cards);
  const out = { commanders: [], cards: [], missing: [] };
  d.entries.forEach((e) => {
    const c = e.set ? state.cards[e.set + ":" + e.cn] : byName.get(String(e.name || "").toLowerCase());
    if (!c) { out.missing.push(e.name || e.set + ":" + e.cn); return; }
    const isCmd = /^commanders?$/i.test(e.section || "");
    for (let i = 0; i < (e.qty || 1); i++) (isCmd ? out.commanders : out.cards).push(c);
  });
  return out;
}
export function listDecks(state) {
  return state.decks.map((d) => {
    const b = deckCards(state, d);
    const id = new Set();
    b.commanders.forEach((c) => (c.color_identity || []).forEach((x) => id.add(x)));
    const n = b.cards.length + b.commanders.length;
    const playable = d.format === "commander" ? n >= 95 : b.cards.length >= 40;
    return {
      id: d.id, name: d.name, format: d.format, commander: d.commander, count: n, playable,
      missing: b.missing, identity: Array.from(id), art: b.commanders[0] ? b.commanders[0].img : "",
      reason: playable ? "" : "Needs more cards",
    };
  });
}
export function buildDeck(state, id) {
  const d = state.decks.find((x) => x.id === id);
  const b = deckCards(state, d);
  const idn = new Set();
  b.commanders.forEach((c) => (c.color_identity || []).forEach((x) => idn.add(x)));
  return {
    id: d.id, name: d.name, isCommander: d.format === "commander", startingLife: d.format === "commander" ? 40 : 20,
    commanders: b.commanders, cards: b.cards, missing: b.missing, identity: Array.from(idn), art: b.commanders[0] ? b.commanders[0].img : "",
  };
}
export function coverage(card) {
  const t = card.oracle_text || "";
  const bad = /Ring tempts|mutate|day|night/i.test(t);
  return { full: !bad, unparsed: bad ? [t.split("\n").find((l) => /Ring tempts|mutate|day|night/i.test(l)) || t.split("\n")[0]] : [] };
}
export const compile = () => ({});

/* ---------- state helpers ---------- */
function rngOf(seed) { let a = seed >>> 0 || 1; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const OTHER = (p) => 1 - p;

export function createGame(cfg) {
  const scene = (cfg.options && cfg.options.scene) || globalThis.__MOCK_SCENE__ || "full";
  const rng = rngOf(cfg.options.seed || 7);
  let nid = 0;
  const objects = {};
  const events = [];
  const answers = [];
  const players = cfg.players.map((p, i) => ({
    idx: i, id: "P" + i, name: p.name || (i ? "Opponent" : "You"), ai: !!p.ai, life: cfg.options.startingLife || 40, poison: 0,
    mana: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }, landsPlayed: 0, landsPerTurn: 1, library: [], hand: [], graveyard: [], exile: [], command: [],
    commanders: [], commanderCasts: {}, commanderDamage: {}, ring: { level: 0, bearer: null }, lost: false, drewFromEmpty: false, counters: {},
    _deck: p.deck,
  }));
  const state = { turn: 1, active: 0, step: "main1", priority: null, players, battlefield: [], stack: [], objects, combat: null };
  const game = { state, request: null, over: false, winner: null, answers, started: false };
  const emit = (e) => { events.push(e); };

  function mk(card, owner, zone, extra) {
    const id = "o" + ++nid;
    const tl = card.type_line || "";
    const sides = tl.split("—");
    const words = sides[0].trim().split(/\s+/).filter(Boolean).map((x) => x.toLowerCase());
    const sup = words.filter((w) => ["legendary", "basic", "snow", "world"].indexOf(w) >= 0);
    const types = words.filter((w) => sup.indexOf(w) < 0);
    const subtypes = (sides[1] || "").trim().split(/\s+/).filter(Boolean).map((x) => x.toLowerCase());
    let pw = null, th = null;
    if (card.pt) { const [a, b] = card.pt.split("/"); pw = isNaN(+a) ? a : +a; th = isNaN(+b) ? b : +b; }
    const o = {
      id, owner, controller: owner, zone, tapped: false, sick: false, counters: {}, damage: 0, attachedTo: null, attachments: [], token: !!card.token,
      isCommander: false, face: 0, def: { power: pw, toughness: th },
      c: {
        name: card.name, types, subtypes, supertypes: sup, colors: card.colors || [], power: pw, toughness: th, loyalty: card.loyalty ? +card.loyalty : null,
        keywords: {}, cost: card.mana_cost || "", cmc: card.cmc || 0, text: card.oracle_text || "", img: card.img || "", unparsed: card.unparsed || [],
      },
    };
    Object.assign(o, extra || {});
    objects[id] = o;
    place(o, zone);
    return o;
  }
  function place(o, zone) {
    o.zone = zone;
    const P = players[o.owner];
    if (zone === "battlefield") state.battlefield.push(o.id);
    else if (zone === "stack") state.stack.push(o.id);
    else P[zone].push(o.id);
  }
  function unplace(o) {
    const rm = (a) => { const i = a.indexOf(o.id); if (i >= 0) a.splice(i, 1); };
    rm(state.battlefield); rm(state.stack);
    ["library", "hand", "graveyard", "exile", "command"].forEach((z) => rm(players[o.owner][z]));
  }
  function move(o, to, text) {
    const from = o.zone;
    unplace(o); o.tapped = false; o.damage = 0;
    place(o, to);
    if (to === "battlefield") o.sick = (o.c.types.indexOf("creature") >= 0);
    emit({ t: "move", obj: o.id, from, to, player: o.owner, text: text || o.c.name + " moves from " + from + " to " + to + "." });
  }
  const isLand = (o) => o.c.types.indexOf("land") >= 0;
  const isCre = (o) => o.c.types.indexOf("creature") >= 0;
  const bf = (p) => state.battlefield.map((i) => objects[i]).filter((o) => o.controller === p);

  /* ----- decks -> cards ----- */
  const decks = players.map((p) => p._deck);
  const poolOf = (d) => {
    const all = d.cards.slice();
    return {
      lands: all.filter((c) => /Land/.test(c.type_line || "")),
      cres: all.filter((c) => /Creature/.test(c.type_line || "")),
      other: all.filter((c) => !/Land|Creature/.test(c.type_line || "")),
    };
  };
  const token = (name, pt, colors, extra) => Object.assign({ name, type_line: "Token Creature — " + name, pt, colors: colors || [], token: true, oracle_text: "", mana_cost: "" }, extra || {});

  function setup() {
    const big = scene !== "full" && scene !== "mulligan";
    players.forEach((P, pi) => {
      const pool = poolOf(decks[pi]);
      const lib = [];
      // library
      const rest = pool.lands.concat(pool.cres, pool.other);
      const rng2 = rngOf(100 + pi);
      rest.sort(() => rng2() - 0.5);
      rest.slice(0, 60).forEach((c) => lib.push(mk(c, pi, "library")));
      (decks[pi].commanders || []).forEach((c) => { const o = mk(c, pi, "command", { isCommander: true }); P.commanders.push(o.id); P.commanderCasts[o.id] = pi === 0 && big ? 1 : 0; });
      if (!big) {
        // opening hand
        const hand = [], nl = pool.lands.slice(0, 3), nc = pool.cres.slice(0, 2), no = pool.other.slice(0, 2);
        nl.concat(nc, no).forEach((c) => hand.push(mk(c, pi, "hand")));
        return;
      }
      // big board
      const lands = pool.lands.length ? pool.lands : [{ name: "Swamp", type_line: "Basic Land — Swamp", colors: [] }];
      const nLands = pi === 0 ? 10 : 9;
      const landList = [];
      for (let i = 0; i < nLands; i++) landList.push(lands[i % Math.min(lands.length, 4) === 0 ? 0 : i % lands.length]);
      const bfl = landList.map((c, i) => mk(c, pi, "battlefield", { tapped: pi === 0 ? i % 5 === 1 : i % 4 === 2 }));
      const cres = pool.cres.slice(0, 7);
      const made = cres.map((c, i) => mk(c, pi, "battlefield", { sick: i === cres.length - 1 }));
      if (made[1]) { made[1].counters = { "+1/+1": 2 }; made[1].c.power += 2; made[1].c.toughness += 2; }
      if (made[2]) { made[2].damage = 1; }
      if (made[3]) { made[3].tapped = true; }
      if (made[4]) { made[4].c.unparsed = ["Whenever the Ring tempts you, ..."]; }
      // tokens
      const tk = pi === 0 ? token("Zombie", "2/2", ["B"]) : token("Dinosaur", "3/3", ["G"]);
      for (let i = 0; i < 3; i++) mk(tk, pi, "battlefield", { sick: i === 2 });
      mk(token("Treasure", null, [], { type_line: "Token Artifact — Treasure", oracle_text: "{T}, Sacrifice this artifact: Add one mana of any color." }), pi, "battlefield");
      // a non-creature permanent and an attached aura
      const art = pool.other.find((c) => /Artifact|Enchantment/.test(c.type_line || ""));
      if (art) mk(art, pi, "battlefield");
      const eq = pool.other.find((c) => /Aura|Equipment/.test(c.type_line || ""));
      if (eq && made[0]) { const a = mk(eq, pi, "battlefield", { attachedTo: made[0].id }); made[0].attachments.push(a.id); }
      // hand, graveyard, exile
      const hand = pool.cres.slice(7, 10).concat(pool.other.slice(0, 3), pool.lands.slice(5, 6));
      hand.slice(0, pi === 0 ? 7 : 5).forEach((c) => mk(c, pi, "hand"));
      pool.other.slice(3, 8).forEach((c) => mk(c, pi, "graveyard"));
      pool.cres.slice(10, 12).forEach((c) => mk(c, pi, "exile"));
      P.landsPlayed = 0;
    });
    state.turn = big ? 7 : 1;
    game._sceneInit = big;
  }
  setup();

  /* ----- actions ----- */
  function untapped(p) { return bf(p).filter((o) => isLand(o) && !o.tapped); }
  function actionsFor(p, step) {
    const P = players[p];
    const acts = [];
    const sorcery = state.active === p && (step === "main1" || step === "main2") && !state.stack.length;
    P.hand.map((i) => objects[i]).forEach((o) => {
      if (isLand(o)) { if (sorcery && P.landsPlayed < P.landsPerTurn) acts.push({ type: "land", obj: o.id, label: "Play " + o.c.name, zone: "hand" }); return; }
      const inst = o.c.types.indexOf("instant") >= 0;
      if ((sorcery || inst) && untapped(p).length >= Math.min(o.c.cmc, 99) && o.c.cmc <= untapped(p).length)
        acts.push({ type: "cast", obj: o.id, label: "Cast " + o.c.name, cost: o.c.cost, zone: "hand" });
    });
    P.commanders.map((i) => objects[i]).filter((o) => o.zone === "command").forEach((o) => {
      const tax = (P.commanderCasts[o.id] || 0) * 2;
      if (sorcery && untapped(p).length >= o.c.cmc + tax) acts.push({ type: "cast", obj: o.id, label: "Cast " + o.c.name, cost: o.c.cost + (tax ? "{" + tax + "}" : ""), zone: "command", variant: "commander" });
    });
    bf(p).forEach((o) => {
      if (isLand(o) && !o.tapped) acts.push({ type: "activate", obj: o.id, label: "{T}: Add mana", mana: true, zone: "battlefield", ability: 0 });
      if (isCre(o) && !o.tapped && /\{T\}/.test(o.c.text) && !/Add/.test(o.c.text) && !o.sick) acts.push({ type: "activate", obj: o.id, label: "Activate: " + (o.c.text.split("\n").find((l) => /\{T\}/.test(l)) || "{T}").slice(0, 60), zone: "battlefield", ability: 1 });
    });
    if (p === 0) {
      acts.push({ type: "special", obj: null, label: "Adjust life", zone: "any" });
      acts.push({ type: "special", obj: null, label: "Draw a card", zone: "any" });
    }
    return acts;
  }
  function pay(p, n) { untapped(p).slice(0, n).forEach((o) => { o.tapped = true; emit({ t: "tap", obj: o.id, text: o.c.name + " taps for mana." }); }); }

  function* doAction$(p, a) {
    const o = objects[a.obj];
    if (a.type === "special") {
      if (a.label === "Adjust life") {
        const v = yield { kind: "number", player: p, prompt: "Adjust your life total by:", min: -20, max: 20 };
        players[p].life += v.value; emit({ t: "life", player: p, delta: v.value, life: players[p].life, text: "You adjust your life by " + v.value + "." });
      } else drawCards(p, 1);
      return;
    }
    if (a.type === "land") { players[p].landsPlayed++; move(o, "battlefield", players[p].name + " plays " + o.c.name + "."); return; }
    if (a.type === "activate") {
      if (a.mana) { o.tapped = true; emit({ t: "tap", obj: o.id, text: o.c.name + " taps." }); emit({ t: "mana", player: p, added: "{B}", text: "Added {B}." }); return; }
      o.tapped = true; emit({ t: "tap", obj: o.id, text: o.c.name + " taps." });
      const st = mk({ name: o.c.name + " (ability)", type_line: "Ability", oracle_text: a.label.replace("Activate: ", ""), img: "" }, p, "stack", { isAbility: true, sourceId: o.id, targets: [], text: a.label });
      emit({ t: "ability", obj: st.id, source: o.id, player: p, targets: [], text: o.c.name + " activates an ability." });
      return;
    }
    // cast
    const isInstant = o.c.types.indexOf("instant") >= 0 || o.c.types.indexOf("sorcery") >= 0;
    let targets = [];
    if (isInstant) {
      const opts = state.battlefield.map((i) => objects[i]).filter((x) => isCre(x)).map((x) => ({ id: x.id, label: x.c.name, type: "object" }));
      const r = yield { kind: "choose", player: p, prompt: "Choose a target for " + o.c.name, options: opts, min: 1, max: 1, reason: "target", source: o.id };
      targets = r.chosen.map((i) => opts[i].id);
    }
    const cost = (a.variant === "commander" ? o.c.cmc + (players[p].commanderCasts[o.id] || 0) * 2 : o.c.cmc);
    pay(p, Math.min(cost, untapped(p).length));
    if (a.variant === "commander") players[p].commanderCasts[o.id] = (players[p].commanderCasts[o.id] || 0) + 1;
    unplace(o); place(o, "stack"); o.targets = targets;
    emit({ t: "cast", obj: o.id, player: p, targets, text: players[p].name + " casts " + o.c.name + "." });
  }
  function drawCards(p, n) {
    for (let i = 0; i < n; i++) {
      const id = players[p].library[players[p].library.length - 1];
      if (!id) return;
      const o = objects[id]; unplace(o); place(o, "hand");
      emit({ t: "draw", player: p, obj: id, text: players[p].name + " draws a card." });
    }
  }
  function dealDamage(src, targetId, n, combat) {
    emit({ t: "damage", source: src ? src.id : null, target: targetId, amount: n, combat: !!combat, text: (src ? src.c.name : "Something") + " deals " + n + " damage to " + (objects[targetId] ? objects[targetId].c.name : players[+targetId.slice(1)].name) + "." });
    if (objects[targetId]) {
      const t = objects[targetId]; t.damage += n;
      if (t.damage >= t.c.toughness) die(t);
    } else {
      const pl = players[+targetId.slice(1)]; pl.life -= n;
      emit({ t: "life", player: pl.idx, delta: -n, life: pl.life, text: pl.name + " goes to " + pl.life + " life." });
    }
  }
  function die(o) { emit({ t: "dies", obj: o.id, text: o.c.name + " dies." }); if (o.token) { unplace(o); o.zone = "gone"; } else move(o, "graveyard"); }
  function resolveTop() {
    const o = objects[state.stack[state.stack.length - 1]];
    emit({ t: "resolve", obj: o.id, text: o.c.name + " resolves." });
    if (o.isAbility) { unplace(o); o.zone = "gone"; const s = objects[o.sourceId]; if (s) { drawCards(o.controller, 1); } return; }
    if (o.c.types.indexOf("instant") >= 0 || o.c.types.indexOf("sorcery") >= 0) {
      (o.targets || []).forEach((t) => { if (objects[t] && objects[t].zone === "battlefield") dealDamage(o, t, 3); });
      move(o, "graveyard", o.c.name + " is put into the graveyard.");
    } else {
      move(o, "battlefield", o.c.name + " enters the battlefield.");
      if (isCre(o)) o.sick = true;
    }
  }
  function checkWin() {
    players.forEach((P) => {
      if (P.life <= 0 && !game.over) {
        game.over = true; game.winner = OTHER(P.idx);
        emit({ t: "lose", player: P.idx, reason: "life", text: P.name + " has 0 life." });
        emit({ t: "win", player: OTHER(P.idx), reason: "life", text: players[OTHER(P.idx)].name + " wins the game." });
      }
    });
  }

  /* ----- the scripted game ----- */
  function pr(p, step, extra) { state.priority = p; return Object.assign({ kind: "priority", player: p, prompt: "You have priority", actions: actionsFor(p, step) }, extra || {}); }
  function* priority$(step) {
    let passes = 0, cur = state.active;
    while (passes < 2) {
      state.step = step;
      const ans = yield pr(cur, step);
      if (ans.type === "pass") { passes++; cur = OTHER(cur); }
      else { passes = 0; const a = actionsFor(cur, step)[ans.index]; yield* doAction$(cur, a); }
      checkWin(); if (game.over) return;
    }
    if (state.stack.length) { resolveTop(); checkWin(); if (!game.over) yield* priority$(step); }
  }
  function* combat$() {
    const A = state.active, D = OTHER(A);
    state.step = "beginCombat"; emit({ t: "step", step: "beginCombat", text: "Beginning of combat" });
    yield* priority$("beginCombat"); if (game.over) return;
    const cands = bf(A).filter((o) => isCre(o) && !o.tapped && !o.sick);
    state.step = "declareAttackers"; emit({ t: "step", step: "declareAttackers", text: "Declare attackers" });
    const r = cands.length ? yield { kind: "attackers", player: A, prompt: "Declare attackers", candidates: cands.map((o) => ({ obj: o.id, defenders: ["P" + D] })) } : { attacks: [] };
    if (!r.attacks.length) { state.combat = null; return; }
    state.combat = { attackers: r.attacks.map((a) => ({ obj: a.obj, defender: a.defender, blockers: [], blocked: false })) };
    r.attacks.forEach((a) => { const o = objects[a.obj]; o.tapped = true; emit({ t: "attack", obj: o.id, defender: a.defender, text: o.c.name + " attacks." }); });
    yield* priority$("declareAttackers"); if (game.over) return;
    state.step = "declareBlockers"; emit({ t: "step", step: "declareBlockers", text: "Declare blockers" });
    const blk = bf(D).filter((o) => isCre(o) && !o.tapped);
    const br = blk.length ? yield { kind: "blockers", player: D, prompt: "Declare blockers", attackers: state.combat.attackers.map((a) => a.obj), candidates: blk.map((o) => ({ obj: o.id, canBlock: state.combat.attackers.map((a) => a.obj) })) } : { blocks: [] };
    br.blocks.forEach((b) => { const a = state.combat.attackers.find((x) => x.obj === b.attacker); a.blockers.push(b.obj); a.blocked = true; emit({ t: "block", obj: b.obj, attacker: b.attacker, text: objects[b.obj].c.name + " blocks " + objects[b.attacker].c.name + "." }); });
    yield* priority$("declareBlockers"); if (game.over) return;
    state.step = "combatDamage"; emit({ t: "step", step: "combatDamage", text: "Combat damage" });
    state.combat.attackers.forEach((a) => {
      const at = objects[a.obj]; if (!at || at.zone !== "battlefield") return;
      if (a.blocked && a.blockers.length) { a.blockers.forEach((b) => { const bo = objects[b]; if (bo && bo.zone === "battlefield") { dealDamage(at, bo.id, at.c.power, true); dealDamage(bo, at.id, bo.c.power, true); } }); }
      else dealDamage(at, a.defender, at.c.power, true);
    });
    checkWin(); if (game.over) return;
    state.combat = null;
    state.step = "endCombat"; emit({ t: "step", step: "endCombat", text: "End of combat" });
  }
  function* turn$() {
    const A = state.active;
    emit({ t: "turn", player: A, n: state.turn, text: "Turn " + state.turn + " — " + players[A].name });
    state.step = "untap"; emit({ t: "step", step: "untap", text: "Untap" });
    bf(A).forEach((o) => { if (o.tapped) { o.tapped = false; emit({ t: "untap", obj: o.id, text: o.c.name + " untaps." }); } o.sick = false; });
    players[A].landsPlayed = 0;
    state.step = "upkeep"; emit({ t: "step", step: "upkeep", text: "Upkeep" });
    yield* priority$("upkeep"); if (game.over) return;
    state.step = "draw"; emit({ t: "step", step: "draw", text: "Draw" });
    drawCards(A, 1);
    yield* priority$("draw"); if (game.over) return;
    state.step = "main1"; emit({ t: "step", step: "main1", text: "Main phase 1" });
    yield* priority$("main1"); if (game.over) return;
    yield* combat$(); if (game.over) return;
    state.step = "main2"; emit({ t: "step", step: "main2", text: "Main phase 2" });
    yield* priority$("main2"); if (game.over) return;
    state.step = "end"; emit({ t: "step", step: "end", text: "End step" });
    yield* priority$("end"); if (game.over) return;
    state.step = "cleanup";
    Object.keys(objects).forEach((k) => { objects[k].damage = 0; });
    players.forEach((P) => { P.mana = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }; });
  }
  function* script$() {
    if (scene === "mulligan" || scene === "full") {
      let m = 0;
      while (m < 2) {
        const r = yield { kind: "mulligan", player: 0, prompt: "Keep this hand?", mulligans: m, free: m === 0 };
        if (r.keep) break; m++;
      }
      state.turn = 1; state.active = 0;
    }
    if (scene === "attack") { state.active = 0; state.step = "declareAttackers"; yield* combat$(); }
    else if (scene === "block") {
      state.active = 1;
      const att = bf(1).filter((o) => isCre(o) && !o.tapped).slice(0, 4);
      att.forEach((o) => { o.tapped = true; });
      state.step = "declareBlockers";
      state.combat = { attackers: att.map((o, i) => ({ obj: o.id, defender: "P0", blockers: [], blocked: false })) };
      const blk = bf(0).filter((o) => isCre(o) && !o.tapped);
      const br = yield { kind: "blockers", player: 0, prompt: "Declare blockers", attackers: att.map((o) => o.id), candidates: blk.map((o) => ({ obj: o.id, canBlock: att.map((a) => a.id) })) };
      br.blocks.forEach((b) => { const a = state.combat.attackers.find((x) => x.obj === b.attacker); a.blockers.push(b.obj); a.blocked = true; emit({ t: "block", obj: b.obj, attacker: b.attacker, text: "block" }); });
      state.combat.attackers.forEach((a) => { const at = objects[a.obj]; if (a.blocked) { dealDamage(at, a.blockers[0], at.c.power, true); } else dealDamage(at, "P0", at.c.power, true); });
      state.combat = null; checkWin();
    } else if (scene === "stack") {
      state.active = 1; state.step = "main1";
      const c = players[1].hand.map((i) => objects[i]).find((o) => !isLand(o));
      const tgt = bf(0).find((o) => isCre(o));
      unplace(c); c.c.types = ["instant"]; c.c.cmc = 2; place(c, "stack"); c.targets = [tgt.id];
      // a second item (ability) beneath
      const ab = mk({ name: "Ability", type_line: "Ability", oracle_text: "Draw a card.", img: "" }, 1, "stack", { isAbility: true, sourceId: bf(1)[0].id, targets: [], text: "Draw a card." });
      state.stack.splice(0, 0, state.stack.pop());
      emit({ t: "cast", obj: c.id, player: 1, targets: [tgt.id], text: "Opponent casts " + c.c.name + "." });
      yield* priority$("main1");
    } else if (scene === "target") {
      const o = players[0].hand.map((i) => objects[i]).find((x) => !isLand(x));
      yield* doAction$(0, { type: "cast", obj: o.id, label: "Cast", zone: "hand" });
      yield* priority$("main1");
    } else if (scene === "picker") {
      const opts = players[0].library.slice(-14).map((i) => ({ id: i, label: objects[i].c.name, type: "card" }));
      yield { kind: "choose", player: 0, prompt: "Search your library for a creature card", options: opts, min: 0, max: 1, reason: "search" };
    } else if (scene === "modes") {
      yield { kind: "choose", player: 0, prompt: "Choose one —", options: [{ label: "Abrade deals 3 damage to target creature.", type: "mode" }, { label: "Destroy target artifact.", type: "mode" }], min: 1, max: 1, reason: "mode" };
    } else if (scene === "colors") {
      yield { kind: "choose", player: 0, prompt: "Choose a colour", options: ["W", "U", "B", "R", "G"].map((c) => ({ label: { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green" }[c], id: c, type: "color" })), min: 1, max: 1, reason: "generic" };
    } else if (scene === "number") {
      yield { kind: "number", player: 0, prompt: "Choose a value for X", min: 0, max: 7 };
    } else if (scene === "confirm") {
      yield { kind: "confirm", player: 0, prompt: "Return Drivnod, Carnage Dominus to the command zone?", source: players[0].commanders[0] };
    } else if (scene === "over") {
      players[1].life = 0; checkWin();
      return;
    }
    // the main loop
    if (scene === "mulligan" || scene === "full") { /* start of turn 1 */ }
    while (!game.over) {
      yield* turn$();
      if (game.over) break;
      state.active = OTHER(state.active); state.turn++;
    }
  }

  /* ----- driver ----- */
  let gen = null;
  function advance(v) {
    let r;
    for (;;) {
      r = v === undefined && !game.started ? gen.next() : gen.next(v);
      if (r.done) { game.request = null; if (!game.over) { game.over = true; } return; }
      game.request = r.value; return;
    }
  }
  game.start = function () {
    game.started = true;
    emit({ t: "turn", player: state.active, n: state.turn, text: "The game begins." });
    gen = script$();
    advance();
  };
  function validate(req, a) {
    const bad = (m) => { throw new Error(m); };
    if (!a || typeof a !== "object") bad("Answer must be an object");
    if (req.kind === "priority") { if (a.type === "act") { if (!(a.index >= 0 && a.index < req.actions.length)) bad("No such action"); } else if (a.type !== "pass") bad("Bad priority answer"); }
    else if (req.kind === "choose") {
      if (!Array.isArray(a.chosen)) bad("chosen[] required");
      if (a.chosen.length < req.min || a.chosen.length > req.max) bad("Choose between " + req.min + " and " + req.max);
    } else if (req.kind === "confirm") { if (typeof a.yes !== "boolean") bad("yes required"); }
    else if (req.kind === "number") { if (!(a.value >= req.min && a.value <= req.max)) bad("Out of range"); }
    else if (req.kind === "mulligan") { if (typeof a.keep !== "boolean") bad("keep required"); }
    else if (req.kind === "blockers") {
      const used = new Set();
      a.blocks.forEach((b) => { if (used.has(b.obj)) bad("Creature blocks twice"); used.add(b.obj); });
    }
  }
  game.respond = function (a) {
    if (!game.request) throw new Error("Game over");
    validate(game.request, a);
    answers.push(a);
    advance(a);
  };
  game.drainEvents = () => events.splice(0, events.length);
  game.concede = (p) => { if (game.over) return; game.over = true; game.winner = OTHER(p); game.request = null; emit({ t: "lose", player: p, reason: "concede", text: players[p].name + " concedes." }); emit({ t: "win", player: OTHER(p), reason: "concede", text: players[OTHER(p)].name + " wins the game." }); };
  game.rng = rng;
  return game;
}

/* The mock AI: pass, block the first attacker with the first blocker, attack with everything, play first land/creature. */
export function decide(game, req /* , opts */) {
  switch (req.kind) {
    case "priority": {
      const i = req.actions.findIndex((a) => a.type === "land" || (a.type === "cast" && !game.state.stack.length));
      return i >= 0 ? { type: "act", index: i } : { type: "pass" };
    }
    case "choose": return { chosen: req.options.slice(0, Math.max(req.min, 1)).map((_, i) => i).slice(0, req.max) };
    case "confirm": return { yes: true };
    case "number": return { value: req.min };
    case "mulligan": return { keep: true };
    case "attackers": return { attacks: req.candidates.slice(0, 3).map((c) => ({ obj: c.obj, defender: c.defenders[0] })) };
    case "blockers": return { blocks: req.candidates.slice(0, 1).map((c) => ({ obj: c.obj, attacker: req.attackers[0] })) };
    default: return {};
  }
}

export const backend = { createGame, compile, coverage, decide, buildDeck, listDecks };
