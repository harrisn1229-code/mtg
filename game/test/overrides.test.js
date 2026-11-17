// overrides.test.js — scenario tests for the hand-written overrides (game/overrides-1.js, overrides-2.js).
// Scenarios are built from REAL cards (helpers.cardByName) compiled through overrides.compileCard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGame } from "../engine.js";
import { compileCard, OVERRIDES } from "../overrides.js";
import { cardByName, allDecks } from "./helpers.js";
import { randomAnswer, makeRnd } from "./smoke.js";

// ------------------------------------------------------------------ scenario helpers
const filler = (name) => Array.from({ length: 30 }, () => cardByName(name));
function setup({ p0 = {}, p1 = {}, life = 40, seed = 1, commander = false, cmd0, cmd1, first = 0 } = {}) {
  const g = createGame({
    players: [
      { name: "Nate", deck: { commanders: cmd0 ? [cardByName(cmd0)] : [], cards: filler(p0.land || "Forest") } },
      { name: "AI", ai: true, deck: { commanders: cmd1 ? [cardByName(cmd1)] : [], cards: filler(p1.land || "Island") } },
    ],
    options: { seed, firstPlayer: first, commander, startingLife: life, handSize: 0 }, compile: compileCard,
  });
  g.start();
  for (const [p, spec] of [[0, p0], [1, p1]]) {
    for (const n of spec.library || []) place(g, p, "library", n);
    for (const n of spec.battlefield || []) place(g, p, "battlefield", n);
    for (const n of spec.hand || []) place(g, p, "hand", n);
    for (const n of spec.graveyard || []) place(g, p, "graveyard", n);
    for (const n of spec.exile || []) place(g, p, "exile", n);
  }
  g.drainEvents();
  return g;
}
function place(g, p, zone, name, opts = {}) {
  const c = cardByName(name);
  const o = g.newObj(c, g.compileCard(c), p, "library");
  g.moveObj(o, zone, { controller: p, quiet: true, tapped: !!opts.tapped });
  if (zone === "battlefield") o.sick = !!opts.sick;
  g.state.pendingTriggers.length = 0;
  g.refreshRequest();
  return o;
}
const byName = (g, name, zone = "battlefield", p) => Object.values(g.state.objects).filter((o) => o.c?.name === name && o.zone === zone && (p == null || o.owner === p));
const one = (g, name, zone, p) => { const l = byName(g, name, zone, p); assert.ok(l.length, `no ${name} in ${zone}`); return l[0]; };
const mana = (g, p, s) => { g.addMana(p, s); g.refreshRequest(); };
function act(g, label) {
  const r = g.request;
  assert.equal(r.kind, "priority", `expected priority, got ${r.kind}: ${r.prompt}`);
  const i = r.actions.findIndex((a) => a.label.includes(label));
  assert.ok(i >= 0, `no action "${label}" in [${r.actions.map((a) => a.label).join(" | ")}]`);
  g.respond({ type: "act", index: i });
}
const hasAction = (g, label) => g.request.kind === "priority" && g.request.actions.some((a) => a.label.includes(label));
/** answer a choose request by option label substrings / ids (in order of the given labels) */
function choose(g, ...labels) {
  const r = g.request;
  assert.equal(r.kind, "choose", `expected choose, got ${r.kind}: ${r.prompt}`);
  const idx = labels.map((l) => { const i = r.options.findIndex((o) => o.label.includes(l) || o.id === l); assert.ok(i >= 0, `no option ${l} in [${r.options.map((o) => o.label).join(" | ")}]`); return i; });
  g.respond({ chosen: idx });
}
const chooseNone = (g) => { assert.equal(g.request.kind, "choose", g.request.prompt); g.respond({ chosen: [] }); };
const confirm = (g, yes) => { assert.equal(g.request.kind, "confirm", `expected confirm, got ${g.request.kind}: ${g.request.prompt}`); g.respond({ yes }); };
const number = (g, value) => { assert.equal(g.request.kind, "number", `expected number, got ${g.request.kind}: ${g.request.prompt}`); g.respond({ value }); };
function resolveAll(g, max = 80) {
  while (max-- > 0 && !g.over && g.request.kind === "priority" && g.state.stack.length) g.respond({ type: "pass" });
}
/** state-based actions / triggers created by out-of-band state edits (g.destroy(...) in a test) happen at the next checkpoint: pass once */
function kick(g) { if (g.request.kind === "priority") g.respond({ type: "pass" }); }
/** pass priority until the stack empties or a non-priority request (choice made during resolution) appears */
function resolveUntilAsk(g, max = 80) {
  while (max-- > 0 && !g.over && g.request.kind === "priority" && g.state.stack.length) g.respond({ type: "pass" });
  return g.request;
}
function until(g, pred, max = 4000) {
  while (max-- > 0 && !g.over && !pred(g.request, g.state)) { const r = g.request; g.respond(r.kind === "priority" ? { type: "pass" } : g.defaultAnswer(r)); }
  assert.ok(max > 0 || g.over, "until() ran out");
}
const atStep = (step, p = 0) => (r, st) => r && r.kind === "priority" && st.step === step && r.player === p && st.stack.length === 0;
const toMain = (g) => until(g, atStep("main1"));
const texts = (g) => g.drainEvents().map((e) => e.text);
const life = (g, p) => g.state.players[p].life;
const zoneNames = (g, p, zone) => g.state.players[p][zone].map((id) => g.state.objects[id].c.name);
/** the pending request must not be an engine error and the game must be healthy */
const healthy = (g) => { assert.equal(g.error, null, g.error && g.error.stack); };
/** all manual events since last drain that name the card */
const manualFor = (evs, name) => evs.filter((e) => e.t === "manual" && (e.text || "").startsWith(name));

// ------------------------------------------------------------------ every override compiles
test("every override compiles for its real card and has sane shape", () => {
  const names = Object.keys(OVERRIDES);
  assert.ok(names.length >= 40, `only ${names.length} overrides`);
  for (const name of names) {
    const card = cardByName(name);
    const def = compileCard(card);
    assert.ok(Array.isArray(def.unparsed), name);
    assert.ok(def.name && def.types, name);
    for (const ab of def.abilities || []) {
      assert.ok(ab && typeof ab === "object" && ["static", "triggered", "activated"].includes(ab.kind), `${name}: bad ability kind`);
      if (ab.kind === "triggered") assert.ok(ab.on && ab.on.event, `${name}: trigger without event`);
      if (ab.run != null) assert.equal(typeof ab.run, "function", name);
    }
    if (def.spell?.run != null) assert.equal(typeof def.spell.run, "function", name);
    for (const f of def.faces || []) assert.ok(f && f.name, name);
  }
});

// ------------------------------------------------------------------ commanders
test("Drivnod: creature deaths trigger abilities twice; indestructible counter ability works", () => {
  const g = setup({ commander: true, p0: { battlefield: ["Drivnod, Carnage Dominus", "Blood Artist", "Carrion Feeder"] } });
  toMain(g);
  g.sacrifice(one(g, "Carrion Feeder"));
  g.refreshRequest();
  // Blood Artist triggers twice for Carrion Feeder dying (and Drivnod's cardinality: "creature dying")
  const trig = g.state.pendingTriggers.length;
  assert.equal(trig, 2, "Blood Artist trigger doubled");
  g.state.pendingTriggers.length = 0;
  // ability: {B/P}{B/P}, exile three creature cards from your graveyard: indestructible counter
  for (const n of ["Gravecrawler", "Nested Shambler", "Carrier Thrall"]) place(g, 0, "graveyard", n);
  mana(g, 0, "{B}{B}");
  act(g, "Drivnod, Carnage Dominus: {B/P}{B/P}");
  if (g.request.kind === "choose") choose(g, "Gravecrawler", "Nested Shambler", "Carrier Thrall");
  resolveAll(g);
  const dr = one(g, "Drivnod, Carnage Dominus");
  assert.equal(dr.counters.indestructible, 1);
  assert.ok(g.hasKw(dr, "indestructible"));
  assert.equal(zoneNames(g, 0, "exile").filter((n) => ["Gravecrawler", "Nested Shambler", "Carrier Thrall"].includes(n)).length, 3);
  healthy(g);
});

test("Zilortha (Godzilla commander): lethal-by-power line is flagged (engine lacks the hook); card is a 7/3 trampler", () => {
  const def = compileCard(cardByName("Zilortha, Strength Incarnate"));
  assert.deepEqual(def.unparsed, ["Lethal damage dealt to creatures you control is determined by their power rather than their toughness."]);
  assert.equal(def.keywords.trample, true);
});

test("Lord of the Nazgûl: instant/sorcery cast makes a 3/3 menace Wraith; nine Wraiths become 9/9; Wraiths have protection from Ring-bearers", () => {
  const g = setup({ commander: true, p0: { hand: ["Dreadful as the Storm"], battlefield: ["Lord of the Nazgûl", "Nazgûl", "Nazgûl", "Nazgûl", "Nazgûl", "Nazgûl", "Nazgûl", "Ringwraiths"] }, p1: { battlefield: ["Carrion Feeder"] } });
  toMain(g);
  // 8 wraiths now (Lord + 6 Nazgûl + Ringwraiths); one more via the trigger = 9
  mana(g, 0, "{2}{U}");
  act(g, "Cast Dreadful as the Storm");
  choose(g, "Carrion Feeder");
  resolveAll(g);
  const wraithTokens = byName(g, "Wraith");
  assert.equal(wraithTokens.length, 1);
  assert.ok(g.hasKw(wraithTokens[0], "menace"));
  const wraiths = g.state.battlefield.map((id) => g.state.objects[id]).filter((o) => o.controller === 0 && o.c.subtypes.includes("wraith"));
  assert.equal(wraiths.length, 9);
  for (const w of wraiths) assert.equal(w.c.power, 9, `${w.c.name} is 9/9`);
  // protection from Ring-bearers
  const feeder = one(g, "Carrion Feeder");
  g.state.players[1].ring.bearer = feeder.id; g.markDirty(); g.refresh();
  assert.ok(g.isRingBearer(feeder));
  assert.equal(g.protectedFrom(wraiths[0], feeder), true);
  assert.equal(g.protectedFrom(one(g, "Lord of the Nazgûl"), feeder), true);
  healthy(g);
});

test("Brion Stoutarm: sac another creature, damage = its power to a player, lifelink gains", () => {
  const g = setup({ commander: true, p0: { battlefield: ["Brion Stoutarm", "Pitiless Plunderer"] } });
  toMain(g);
  mana(g, 0, "{R}");
  act(g, "Brion Stoutarm");
  choose(g, "AI");
  if (g.request.kind === "choose") choose(g, "Pitiless Plunderer");
  resolveAll(g);
  assert.equal(life(g, 1), 39, "1 power -> 1 damage");
  assert.equal(life(g, 0), 41, "lifelink");
  assert.equal(byName(g, "Pitiless Plunderer").length, 0);
  healthy(g);
});

// ------------------------------------------------------------------ A–L
test("Anger of the Gods: 3 damage to each creature, dying ones are exiled instead", () => {
  const g = setup({ p0: { hand: ["Anger of the Gods"], battlefield: ["Carrion Feeder", "Elder Gargaroth"] }, p1: { battlefield: ["Midnight Reaper"] } });
  toMain(g);
  mana(g, 0, "{1}{R}{R}");
  act(g, "Cast Anger of the Gods");
  resolveAll(g);
  assert.deepEqual(zoneNames(g, 0, "graveyard"), ["Anger of the Gods"], "nothing hit the graveyard");
  assert.deepEqual(zoneNames(g, 0, "exile"), ["Carrion Feeder"]);
  assert.deepEqual(zoneNames(g, 1, "exile"), ["Midnight Reaper"]);
  assert.equal(one(g, "Elder Gargaroth").damage, 3);
  healthy(g);
});

test("Arcane Denial: counters, then both players draw at the next upkeep (victim up to two)", () => {
  const g = setup({ p0: { hand: ["Lightning Helix"], battlefield: ["Mountain", "Plains"] }, p1: { hand: ["Arcane Denial"], battlefield: ["Island", "Island"] } });
  toMain(g);
  act(g, "Cast Lightning Helix");
  choose(g, "AI");
  g.respond({ type: "pass" });
  act(g, "Cast Arcane Denial");
  resolveAll(g);
  assert.ok(zoneNames(g, 0, "graveyard").includes("Lightning Helix"));
  const h0 = g.state.players[0].hand.length, h1 = g.state.players[1].hand.length;
  // next upkeep is the AI's turn 2: its delayed trigger (controlled by AI) resolves
  until(g, (r) => r.kind === "number" || r.kind === "choose" && false);
  assert.match(g.request.prompt, /draw up to two/i);
  assert.equal(g.request.player, 0, "the countered spell's controller decides");
  number(g, 2);
  resolveAll(g);
  assert.equal(g.state.players[0].hand.length - h0, 2);
  // the AI draws 1 for its normal draw step + 1 from Arcane Denial (hand had 0 after casting)
  assert.ok(g.state.players[1].hand.length - h1 >= 1);
  healthy(g);
});

test("Archfiend of Depravity: opponent keeps two creatures at its own end step, sacrificing the rest", () => {
  const g = setup({ p0: { battlefield: ["Archfiend of Depravity"] }, p1: { battlefield: ["Carrion Feeder", "Gravecrawler", "Nested Shambler", "Carrier Thrall"] } });
  until(g, (r, st) => st.turn === 2 && st.step === "end" && st.stack.length > 0 && r.kind === "priority");
  g.respond({ type: "pass" });
  g.respond({ type: "pass" });
  const r = g.request;
  assert.equal(r.kind, "choose");
  assert.equal(r.player, 1);
  assert.equal(r.min, 2); assert.equal(r.max, 4);
  choose(g, "Carrion Feeder", "Gravecrawler");
  assert.deepEqual(byName(g, "Carrion Feeder").length + byName(g, "Gravecrawler").length, 0);
  assert.equal(byName(g, "Nested Shambler").length + byName(g, "Carrier Thrall").length, 2);
  healthy(g);
});

test("Balor: attack trigger lets you choose a mode targeting the opponent (draw 3 / discard 3 at random)", () => {
  const g = setup({ p0: { battlefield: ["Balor"] }, p1: { hand: ["Island", "Forest", "Swamp"] } });
  toMain(g);
  until(g, (r) => r.kind === "attackers");
  g.respond({ attacks: [{ obj: one(g, "Balor").id, defender: "P1" }] });
  if (g.request.kind === "choose" && /mode/i.test(g.request.prompt)) choose(g, "draws three");
  if (g.request.kind === "choose") choose(g, "AI");
  resolveAll(g);
  assert.equal(g.state.players[1].hand.length, 3, "drew 3 then discarded 3 at random");
  assert.equal(g.state.players[1].graveyard.length, 3);
  healthy(g);
});

test("Bojuka Bog: enters tapped, exiles target player's graveyard", () => {
  const g = setup({ p0: { hand: ["Bojuka Bog"] }, p1: { graveyard: ["Carrion Feeder", "Gravecrawler"] } });
  toMain(g);
  act(g, "Play Bojuka Bog");
  choose(g, "AI");
  resolveAll(g);
  assert.equal(g.state.players[1].graveyard.length, 0);
  assert.equal(g.state.players[1].exile.length, 2);
  assert.ok(one(g, "Bojuka Bog").tapped);
  healthy(g);
});

test("Chandra's Ignition: target creature deals damage equal to its power to each other creature and each opponent", () => {
  const g = setup({ p0: { hand: ["Chandra's Ignition"], battlefield: ["Elder Gargaroth", "Carrion Feeder"] }, p1: { battlefield: ["Gravecrawler", "Nested Shambler"] } });
  toMain(g);
  mana(g, 0, "{3}{R}{R}");
  act(g, "Cast Chandra's Ignition");
  choose(g, "Elder Gargaroth");
  resolveAll(g);
  assert.equal(life(g, 1), 34);
  assert.equal(life(g, 0), 40, "caster not damaged");
  assert.equal(byName(g, "Elder Gargaroth").length, 1);
  assert.equal(byName(g, "Carrion Feeder").length + byName(g, "Gravecrawler").length + byName(g, "Nested Shambler").length, 0);
  healthy(g);
});

test("Chaos Warp: owner shuffles the permanent away, then reveals top; permanent cards enter", () => {
  const g = setup({ p0: { hand: ["Chaos Warp"] }, p1: { battlefield: ["Ripjaw Raptor"], library: ["Island"] } });
  toMain(g);
  mana(g, 0, "{2}{R}");
  act(g, "Cast Chaos Warp");
  if (g.request.kind === "choose") choose(g, "Ripjaw Raptor");
  resolveAll(g);
  // the Raptor is in the library (or came back as the revealed top card); the library grew by one then lost the revealed card if it's a permanent
  const t = texts(g);
  assert.ok(t.some((x) => /reveals/.test(x)), t.join("\n"));
  const lib = g.state.players[1].library.length;
  const bf = g.state.battlefield.filter((id) => g.state.objects[id].owner === 1).length;
  assert.equal(lib + bf + g.state.players[1].hand.length + g.state.players[1].graveyard.length, 32, "no cards lost");
  assert.ok(bf <= 1 && bf >= 0);
  healthy(g);
});

test("Crippling Fear: creatures not of the chosen type get -3/-3 (changelings and the chosen type are safe)", () => {
  const g = setup({ p0: { hand: ["Crippling Fear"], battlefield: ["Pawn of Ulamog", "Mirror Entity"] }, p1: { battlefield: ["Carrion Feeder", "Dread Presence"] } });
  toMain(g);
  mana(g, 0, "{2}{B}{B}");
  act(g, "Cast Crippling Fear");
  resolveUntilAsk(g);
  choose(g, "Vampire");
  resolveAll(g);
  assert.equal(byName(g, "Pawn of Ulamog").length, 1, "Vampire survives");
  assert.equal(byName(g, "Mirror Entity").length, 1, "changeling survives");
  assert.equal(byName(g, "Carrion Feeder").length, 0);
  assert.equal(byName(g, "Dread Presence").length, 0, "3/3 nightmare shrinks to 0/0 and dies");
});

test("Dig Through Time: two of the top seven to hand, rest to the bottom", () => {
  const g = setup({ p0: { hand: ["Dig Through Time"], library: ["Swamp", "Plains", "Mountain", "Opt", "Brainstorm", "Preordain", "Consider"] } });
  toMain(g);
  mana(g, 0, "{U}{U}{U}{U}{U}{U}{U}{U}");
  act(g, "Cast Dig Through Time");
  resolveUntilAsk(g);
  assert.equal(g.request.kind, "choose");
  assert.equal(g.request.min, 2); assert.equal(g.request.max, 2);
  choose(g, "Consider", "Preordain");
  resolveAll(g);
  assert.ok(zoneNames(g, 0, "hand").includes("Consider") && zoneNames(g, 0, "hand").includes("Preordain"));
  const lib = g.state.players[0].library.map((id) => g.state.objects[id].c.name);
  assert.deepEqual(lib.slice(0, 5).sort(), ["Brainstorm", "Mountain", "Opt", "Plains", "Swamp"], "the five others went to the bottom");
  healthy(g);
});

test("Dreadful as the Storm: base 5/5 until end of turn (counters still add), Ring tempts you", () => {
  const g = setup({ p0: { hand: ["Dreadful as the Storm"], battlefield: ["Carrion Feeder"] } });
  toMain(g);
  const f = one(g, "Carrion Feeder");
  g.addCounters(f, "+1/+1", 1);
  mana(g, 0, "{2}{U}");
  act(g, "Cast Dreadful as the Storm");
  resolveUntilAsk(g);
  resolveAll(g);
  assert.equal(f.c.power, 6); assert.equal(f.c.toughness, 6);
  assert.equal(g.state.players[0].ring.level, 1);
  until(g, (r, st) => st.turn === 2);
  assert.equal(f.c.power, 2, "wears off");
  healthy(g);
});

test("Drown in Ichor: -4/-4 and proliferate", () => {
  const g = setup({ p0: { hand: ["Drown in Ichor"], battlefield: ["Carrion Feeder", "Ripjaw Raptor"] }, p1: { battlefield: ["Dread Presence"] } });
  toMain(g);
  const rr = one(g, "Ripjaw Raptor");
  g.addCounters(rr, "+1/+1", 1);
  mana(g, 0, "{1}{B}");
  act(g, "Cast Drown in Ichor");
  choose(g, "Dread Presence");
  resolveUntilAsk(g);
  assert.match(g.request.prompt, /Proliferate/);
  choose(g, "Ripjaw Raptor");
  resolveAll(g);
  assert.equal(byName(g, "Dread Presence").length, 0, "3/3 got -4/-4");
  assert.equal(rr.counters["+1/+1"], 2);
  healthy(g);
});

test("Elrond: scry on each creature entering; the second resolution in a turn tempts you", () => {
  const g = setup({ p0: { hand: ["Carrion Feeder", "Gravecrawler"], battlefield: ["Elrond, Lord of Rivendell"] } });
  toMain(g);
  mana(g, 0, "{B}{B}");
  act(g, "Cast Carrion Feeder");
  resolveUntilAsk(g);
  chooseNone(g); // scry 1: keep on top
  resolveAll(g);
  assert.equal(g.state.players[0].ring.level, 0);
  act(g, "Cast Gravecrawler");
  resolveUntilAsk(g);
  chooseNone(g);
  resolveUntilAsk(g);
  resolveAll(g);
  assert.equal(g.state.players[0].ring.level, 1, "second resolution tempts");
  healthy(g);
});

test("Etali, Primal Storm: exiles top of each library; you may cast the spells free", () => {
  const g = setup({ p0: { battlefield: ["Etali, Primal Storm"], library: ["Lightning Helix"] }, p1: { library: ["Mountain"] } });
  toMain(g);
  until(g, (r) => r.kind === "attackers");
  g.respond({ attacks: [{ obj: one(g, "Etali, Primal Storm").id, defender: "P1" }] });
  resolveUntilAsk(g);
  assert.match(g.request.prompt, /Etali/);
  assert.equal(g.request.options.length, 1, "the Mountain can't be cast");
  choose(g, "Lightning Helix");
  choose(g, "AI");
  resolveAll(g);
  assert.equal(life(g, 1), 37);
  assert.equal(zoneNames(g, 1, "exile").includes("Mountain"), true);
  assert.ok(zoneNames(g, 0, "graveyard").includes("Lightning Helix"));
  healthy(g);
});

test("Fact or Fiction: opponent splits the top five, you take a pile", () => {
  const g = setup({ p0: { hand: ["Fact or Fiction"], library: ["Swamp", "Plains", "Mountain", "Opt", "Brainstorm"] } });
  toMain(g);
  mana(g, 0, "{3}{U}");
  act(g, "Cast Fact or Fiction");
  resolveUntilAsk(g);
  assert.equal(g.request.player, 1, "the opponent separates");
  choose(g, "Brainstorm");
  assert.equal(g.request.player, 0);
  choose(g, "Pile 2");
  resolveAll(g);
  assert.deepEqual(zoneNames(g, 0, "hand").sort(), ["Mountain", "Opt", "Plains", "Swamp"]);
  assert.deepEqual(zoneNames(g, 0, "graveyard").filter((n) => n !== "Fact or Fiction"), ["Brainstorm"]);
  healthy(g);
});

test("Fellwar Stone: adds a colour an opponent's land could produce", () => {
  const g = setup({ p0: { battlefield: ["Fellwar Stone"] }, p1: { battlefield: ["Mountain", "Rootbound Crag"] } });
  toMain(g);
  act(g, "Fellwar Stone");
  assert.equal(g.request.kind, "choose");
  assert.deepEqual(g.request.options.map((o) => o.id).sort(), ["G", "R"]);
  choose(g, "G");
  assert.equal(g.state.players[0].mana.G, 1);
  healthy(g);
});

test("Flow State: one card, or two if your graveyard has an instant and a sorcery", () => {
  let g = setup({ p0: { hand: ["Flow State"], library: ["Swamp", "Plains", "Mountain", "Opt"] } });
  toMain(g);
  mana(g, 0, "{1}{U}");
  act(g, "Cast Flow State");
  resolveUntilAsk(g);
  assert.equal(g.request.max, 1);
  choose(g, "Mountain");
  resolveAll(g);
  assert.ok(zoneNames(g, 0, "hand").includes("Mountain"));
  g = setup({ p0: { hand: ["Flow State"], graveyard: ["Opt", "Preordain"], library: ["Swamp", "Plains", "Mountain", "Island"] } });
  toMain(g);
  mana(g, 0, "{1}{U}");
  act(g, "Cast Flow State");
  resolveUntilAsk(g);
  assert.equal(g.request.max, 2); assert.equal(g.request.min, 2);
  choose(g, "Mountain", "Island");
  resolveAll(g);
  healthy(g);
});

test("Gandalf: sorceries have flash; Ring-bearer other than Gandalf draws a card", () => {
  const g = setup({ p0: { battlefield: ["Gandalf, Friend of the Shire", "Carrion Feeder"], hand: ["Birthday Escape", "Birthday Escape", "Drown in Ichor"] } });
  toMain(g);
  until(g, (r, st) => st.turn === 2 && r.kind === "priority" && r.player === 0 && st.stack.length === 0 && st.step === "upkeep");
  mana(g, 0, "{U}{U}");
  assert.ok(hasAction(g, "Cast Birthday Escape"), "sorcery castable on the opponent's turn");
  const h0 = g.state.players[0].hand.length;
  act(g, "Cast Birthday Escape");
  resolveUntilAsk(g);
  if (g.request.kind === "choose" && /Ring/i.test(g.request.prompt)) choose(g, "Carrion Feeder");
  resolveAll(g);
  assert.equal(g.state.players[0].hand.length, h0 - 1 + 1 + 1, "cast one, drew from Birthday Escape and from Gandalf");
  healthy(g);
});

test("Ghostly Flicker: blinks two permanents (Woe Strider re-triggers)", () => {
  const g = setup({ p0: { hand: ["Ghostly Flicker"], battlefield: ["Woe Strider", "Carrion Feeder", "Swamp"] } });
  toMain(g);
  mana(g, 0, "{2}{U}");
  act(g, "Cast Ghostly Flicker");
  choose(g, "Woe Strider", "Carrion Feeder");
  resolveAll(g);
  assert.equal(byName(g, "Woe Strider").length, 1);
  assert.equal(byName(g, "Carrion Feeder").length, 1);
  assert.equal(byName(g, "Goat").length, 1, "Woe Strider's enters trigger fired once");
  healthy(g);
});

test("God-Eternal Bontu: sacrifice any number of other permanents, draw that many; tucks itself third from the top", () => {
  const g = setup({ p0: { hand: ["God-Eternal Bontu"], battlefield: ["Carrion Feeder", "Gravecrawler", "Swamp"] } });
  toMain(g);
  mana(g, 0, "{3}{B}{B}");
  act(g, "Cast God-Eternal Bontu");
  resolveUntilAsk(g);
  const h0 = g.state.players[0].hand.length;
  choose(g, "Carrion Feeder", "Gravecrawler");
  assert.equal(g.state.players[0].hand.length - h0, 2);
  assert.equal(byName(g, "Carrion Feeder").length, 0);
  const b = one(g, "God-Eternal Bontu");
  g.destroy(b);
  kick(g);
  resolveUntilAsk(g);
  confirm(g, true);
  const lib = g.state.players[0].library;
  assert.equal(lib[lib.length - 3], b.id, "third from the top");
  healthy(g);
});

test("God-Eternal Oketra: exile from the battlefield also lets you tuck her", () => {
  const g = setup({ p0: { battlefield: ["God-Eternal Oketra"] } });
  toMain(g);
  const o = one(g, "God-Eternal Oketra");
  g.exile(o);
  kick(g);
  resolveUntilAsk(g);
  confirm(g, true);
  const lib = g.state.players[0].library;
  assert.equal(lib[lib.length - 3], o.id);
});

test("Inferno Titan: divided damage is fixed via mode choice on the trigger", () => {
  const g = setup({ p0: { hand: ["Inferno Titan"] }, p1: { battlefield: ["Gravecrawler", "Nested Shambler"] } });
  toMain(g);
  mana(g, 0, "{4}{R}{R}");
  act(g, "Cast Inferno Titan");
  resolveUntilAsk(g);
  choose(g, "2 damage to one target");
  choose(g, "Gravecrawler");
  choose(g, "AI");
  resolveAll(g);
  assert.equal(byName(g, "Gravecrawler").length, 0, "2 damage killed it");
  assert.equal(life(g, 1), 39);
  healthy(g);
});

test("Jeska's Will: with a commander you may choose both modes", () => {
  const g = setup({ commander: true, cmd0: "Brion Stoutarm", p0: { hand: ["Jeska's Will"], library: ["Swamp", "Plains", "Mountain"] }, p1: { hand: ["Island", "Island", "Island"] } });
  const cmd = g.state.objects[g.state.players[0].commanders[0]];
  g.moveObj(cmd, "battlefield", { controller: 0, quiet: true });
  toMain(g);
  mana(g, 0, "{2}{R}");
  act(g, "Cast Jeska's Will");
  assert.equal(g.request.max, 2);
  choose(g, "Add {R}", "Exile the top three");
  resolveAll(g); // (the lone opponent is chosen automatically)
  assert.equal(g.state.players[0].mana.R, 3);
  assert.equal(g.state.players[0].exile.length, 3);
  assert.ok(g.state.players[0].exile.every((id) => g.state.objects[id].mayPlay));
  healthy(g);
});

test("Kari Zev's Expertise: steal a creature and cast a cheap spell free", () => {
  const g = setup({ p0: { hand: ["Kari Zev's Expertise", "Lightning Helix", "Elder Gargaroth"] }, p1: { battlefield: ["Gravecrawler"] } });
  toMain(g);
  mana(g, 0, "{1}{R}{R}");
  act(g, "Cast Kari Zev's Expertise");
  if (g.request.kind === "choose") choose(g, "Gravecrawler");
  resolveUntilAsk(g);
  assert.equal(g.request.options.length, 1, "only the cmc<=2 spell");
  choose(g, "Lightning Helix");
  choose(g, "AI");
  resolveAll(g);
  assert.equal(life(g, 1), 37);
  assert.equal(one(g, "Gravecrawler").controller, 0);
  healthy(g);
});

// ------------------------------------------------------------------ M–Z
test("Massacre Girl: draws only when the dying opponent creature's toughness was < 1", () => {
  const g = setup({ p0: { battlefield: ["Massacre Girl, Known Killer"] }, p1: { battlefield: ["Carrion Feeder", "Gravecrawler"] } });
  toMain(g);
  const h = g.state.players[0].hand.length;
  g.dealDamage(one(g, "Gravecrawler"), one(g, "Carrion Feeder").id, 2); // (the opponent's own source: no wither) toughness 1 when it died -> no draw
  g.addCounters(one(g, "Gravecrawler"), "-1/-1", 2); // toughness 0 -> draw
  kick(g);
  resolveAll(g);
  assert.equal(g.state.players[0].hand.length - h, 1);
  healthy(g);
});

test("Mirror Entity: X sets base P/T of your creatures and gives all creature types until end of turn", () => {
  const g = setup({ p0: { battlefield: ["Mirror Entity", "Carrion Feeder"] } });
  toMain(g);
  mana(g, 0, "{C}{C}{C}");
  act(g, "Mirror Entity");
  number(g, 3);
  resolveAll(g);
  const f = one(g, "Carrion Feeder");
  assert.equal(f.c.power, 3); assert.equal(f.c.toughness, 3);
  assert.ok(f.c.allCreatureTypes);
  assert.equal(one(g, "Mirror Entity").c.power, 3);
  until(g, (r, st) => st.turn === 2);
  assert.equal(f.c.power, 1);
  healthy(g);
});

test("Mosswort Bridge: hideaway, then play the hidden card free once creatures have total power 10", () => {
  const g = setup({ p0: { hand: ["Mosswort Bridge"], library: ["Swamp", "Plains", "Mountain", "Elder Gargaroth"] } });
  toMain(g);
  act(g, "Play Mosswort Bridge");
  resolveUntilAsk(g);
  choose(g, "Elder Gargaroth");
  resolveAll(g);
  const bridge = one(g, "Mosswort Bridge");
  const hidden = g.obj(bridge.hidden);
  assert.equal(hidden.zone, "exile"); assert.equal(hidden.faceDown, true);
  assert.equal(g.state.players[0].library.length, 33, "one card hidden, the other three went back to the bottom");
  place(g, 0, "battlefield", "Titanoth Rex");
  g.untap(bridge);
  mana(g, 0, "{G}");
  act(g, "Mosswort Bridge: {G}, {T}");
  resolveUntilAsk(g);
  confirm(g, true);
  resolveAll(g);
  assert.equal(byName(g, "Elder Gargaroth").length, 1);
  healthy(g);
});

test("Myriad Landscape: fetches two basics sharing a land type, tapped", () => {
  const g = setup({ p0: { battlefield: ["Myriad Landscape"], library: ["Swamp", "Forest", "Forest"] } });
  toMain(g);
  g.untap(one(g, "Myriad Landscape"));
  mana(g, 0, "{C}{C}");
  act(g, "Myriad Landscape: {2}");
  resolveUntilAsk(g);
  choose(g, "Forest");
  assert.ok(g.request.options.every((o) => /Forest/.test(o.label)), "second must share the type");
  choose(g, "Forest");
  resolveAll(g);
  assert.equal(byName(g, "Forest").filter((o) => o.tapped).length, 2);
  assert.equal(byName(g, "Myriad Landscape").length, 0, "sacrificed");
  healthy(g);
});

test("Nothic: d20 roll draws and loses the same amount (1, 2 or 7)", () => {
  const g = setup({ p0: { battlefield: ["Nothic"] } });
  toMain(g);
  const h = g.state.players[0].hand.length;
  g.destroy(one(g, "Nothic"));
  kick(g);
  resolveAll(g);
  const n = g.state.players[0].hand.length - h;
  assert.ok([1, 2, 7].includes(n), "drew " + n);
  assert.equal(40 - life(g, 0), n);
  healthy(g);
});

test("Outpost Siege: Khans exiles a playable card each upkeep; Dragons pings when a creature leaves", () => {
  let g = setup({ p0: { hand: ["Outpost Siege"], library: ["Swamp", "Plains"] } });
  toMain(g);
  mana(g, 0, "{3}{R}");
  act(g, "Cast Outpost Siege");
  resolveUntilAsk(g);
  choose(g, "Khans");
  resolveAll(g);
  assert.equal(one(g, "Outpost Siege").counters.khans, 1);
  until(g, (r, st) => st.turn === 3 && st.step === "upkeep" && st.stack.length > 0);
  resolveAll(g);
  assert.equal(g.state.players[0].exile.length, 1);
  assert.ok(g.obj(g.state.players[0].exile[0]).mayPlay);
  g = setup({ p0: { hand: ["Outpost Siege"], battlefield: ["Carrion Feeder"] } });
  toMain(g);
  mana(g, 0, "{3}{R}");
  act(g, "Cast Outpost Siege");
  resolveUntilAsk(g);
  choose(g, "Dragons");
  resolveAll(g);
  g.sacrifice(one(g, "Carrion Feeder"));
  kick(g);
  choose(g, "AI");
  resolveAll(g);
  assert.equal(life(g, 1), 39);
  healthy(g);
});

test("Overwhelming Stampede: +X/+X and trample, X = greatest power", () => {
  const g = setup({ p0: { hand: ["Overwhelming Stampede"], battlefield: ["Titanoth Rex", "Carrion Feeder"] } });
  toMain(g);
  mana(g, 0, "{3}{G}{G}");
  act(g, "Cast Overwhelming Stampede");
  resolveAll(g);
  const f = one(g, "Carrion Feeder");
  assert.equal(f.c.power, 12); assert.equal(f.c.toughness, 12);
  assert.ok(g.hasKw(f, "trample"));
  assert.equal(one(g, "Titanoth Rex").c.power, 22);
});

test("Pawn of Ulamog: may create an Eldrazi Spawn with a sacrifice-for-mana ability", () => {
  const g = setup({ p0: { battlefield: ["Pawn of Ulamog", "Carrion Feeder"] } });
  toMain(g);
  g.sacrifice(one(g, "Carrion Feeder"));
  kick(g);
  resolveUntilAsk(g);
  confirm(g, true);
  resolveAll(g);
  const spawn = one(g, "Eldrazi Spawn");
  assert.equal(spawn.c.power, 0); assert.equal(spawn.c.toughness, 1);
  assert.ok(spawn.c.abilities.some((a) => a.mana && a.cost.sacSelf));
  healthy(g);
});

test("Plaguecrafter: each player sacrifices a creature/planeswalker; a player who can't discards a card", () => {
  const g = setup({ p0: { hand: ["Plaguecrafter"], battlefield: ["Carrion Feeder"] }, p1: { hand: ["Island", "Forest"] } });
  toMain(g);
  mana(g, 0, "{2}{B}");
  act(g, "Cast Plaguecrafter");
  resolveUntilAsk(g);
  choose(g, "Carrion Feeder");
  assert.equal(g.request.player, 1);
  assert.match(g.request.prompt, /Discard/i);
  choose(g, "Forest");
  resolveAll(g);
  assert.equal(byName(g, "Plaguecrafter").length, 1);
  assert.equal(g.state.players[1].hand.length, 1);
  assert.ok(zoneNames(g, 1, "graveyard").includes("Forest"));
  healthy(g);
});

test("Priest of Forgotten Gods: sac two others; chosen player loses 2 and sacrifices; you get BB and a card", () => {
  const g = setup({ p0: { battlefield: ["Priest of Forgotten Gods", "Carrion Feeder", "Gravecrawler"] }, p1: { battlefield: ["Nested Shambler"] } });
  toMain(g);
  const h = g.state.players[0].hand.length;
  act(g, "Priest of Forgotten Gods");
  choose(g, "AI");
  resolveAll(g);
  assert.equal(life(g, 1), 38);
  assert.equal(byName(g, "Nested Shambler").length, 0);
  assert.equal(byName(g, "Carrion Feeder").length + byName(g, "Gravecrawler").length, 0);
  assert.equal(g.state.players[0].mana.B, 2);
  assert.equal(g.state.players[0].hand.length - h, 1);
  healthy(g);
});

test("Ram Through: trample sends the excess to the controller; no trample = no excess", () => {
  let g = setup({ p0: { hand: ["Ram Through"], battlefield: ["Elder Gargaroth"] }, p1: { battlefield: ["Gravecrawler"] } });
  toMain(g);
  mana(g, 0, "{1}{G}");
  act(g, "Cast Ram Through");
  resolveAll(g);
  assert.equal(byName(g, "Gravecrawler").length, 0);
  assert.equal(life(g, 1), 40 - 5, "6 power - 1 lethal = 5 excess");
  g = setup({ p0: { hand: ["Ram Through"], battlefield: ["Ripjaw Raptor"] }, p1: { battlefield: ["Dread Presence"] } });
  toMain(g);
  mana(g, 0, "{1}{G}");
  act(g, "Cast Ram Through");
  resolveAll(g);
  assert.equal(byName(g, "Dread Presence").length, 0);
  assert.equal(life(g, 1), 40);
});

test("Resplendent Angel: makes a 4/4 flier at end step only if you gained 5+ life that turn", () => {
  const g = setup({ p0: { battlefield: ["Resplendent Angel"] } });
  toMain(g);
  g.gainLife(0, 5);
  until(g, (r, st) => st.step === "end" && st.stack.length > 0);
  resolveAll(g);
  assert.equal(byName(g, "Angel").length, 1);
  assert.equal(one(g, "Angel").c.power, 4);
  until(g, (r, st) => st.turn === 2 && st.step === "end" && st.stack.length > 0);
  resolveAll(g);
  assert.equal(byName(g, "Angel").length, 1, "no new angel when nothing was gained");
  healthy(g);
});

test("Rewrite Regrets / Violent Echoes: Empower Jace makes (then grows) a Jace token", () => {
  const g = setup({ p0: { hand: ["Violent Echoes", "Rewrite Regrets"], graveyard: ["Carrion Feeder"] }, p1: { battlefield: ["Gravecrawler"] } });
  toMain(g);
  mana(g, 0, "{2}{R}{R}");
  act(g, "Cast Violent Echoes");
  resolveAll(g);
  const jace = one(g, "Jace");
  assert.equal(jace.counters.loyalty, 5, "6 damage to a 2/1 -> 5 excess");
  assert.ok(jace.c.abilities.length === 2);
  mana(g, 0, "{3}{B}");
  act(g, "Cast Rewrite Regrets");
  resolveAll(g);
  assert.equal(byName(g, "Jace").length, 1, "same token");
  assert.equal(jace.counters.loyalty, 7);
  assert.equal(byName(g, "Carrion Feeder").length, 1);
  healthy(g);
});

test("Righteous Valkyrie: +2/+2 only at 47+ life (Commander)", () => {
  const g = setup({ p0: { battlefield: ["Righteous Valkyrie", "Carrion Feeder"] } });
  toMain(g);
  assert.equal(one(g, "Carrion Feeder").c.power, 1);
  g.state.players[0].life = 47; g.markDirty(); g.refresh();
  assert.equal(one(g, "Carrion Feeder").c.power, 3);
});

test("Ringsight: the Ring tempts you, then tutor a card sharing a colour with a legendary creature you control", () => {
  const g = setup({ p0: { hand: ["Ringsight"], battlefield: ["Gollum, Patient Plotter"], library: ["Elvish Mystic", "Carrion Feeder", "Island"] } });
  toMain(g);
  mana(g, 0, "{1}{U}{B}");
  act(g, "Cast Ringsight");
  resolveUntilAsk(g);
  assert.equal(g.request.kind, "choose");
  assert.deepEqual(g.request.options.map((o) => o.label), ["Carrion Feeder"]);
  choose(g, "Carrion Feeder");
  resolveAll(g);
  assert.ok(zoneNames(g, 0, "hand").includes("Carrion Feeder"));
  assert.equal(g.state.players[0].ring.level, 1);
  healthy(g);
});

test("Rugged Prairie: pay {R/W} + tap for RR, RW or WW", () => {
  const g = setup({ p0: { battlefield: ["Rugged Prairie"] } });
  toMain(g);
  mana(g, 0, "{R}");
  act(g, "Rugged Prairie: {R/W}");
  choose(g, "{W}{W}");
  assert.equal(g.state.players[0].mana.W, 2);
  assert.equal(g.state.players[0].mana.R, 0);
  healthy(g);
});

test("Ruthless Technomancer: sacrifice for Treasures; X-artifact reanimation with 'X can't be 0' built in", () => {
  const g = setup({ p0: { hand: ["Ruthless Technomancer"], battlefield: ["Dread Presence"], graveyard: ["Gravecrawler", "Elder Gargaroth"] } });
  toMain(g);
  mana(g, 0, "{3}{B}");
  act(g, "Cast Ruthless Technomancer");
  resolveUntilAsk(g);
  choose(g, "Dread Presence");
  resolveAll(g);
  assert.equal(byName(g, "Treasure").length, 3);
  assert.ok(!hasAction(g, "(X = 0)"));
  mana(g, 0, "{B}{B}{B}");
  assert.ok(hasAction(g, "Sacrifice 2 artifacts"));
  act(g, "(X = 2)");
  assert.equal(g.request.kind, "choose");
  g.respond({ chosen: [0, 1] }); // two of the three Treasures (the only legal target, Gravecrawler, was auto-chosen)
  resolveAll(g);
  assert.equal(byName(g, "Gravecrawler").length, 1);
  assert.equal(byName(g, "Treasure").length, 1);
  healthy(g);
});

test("Sauron's Ransom: opponent splits the top four into face-down/face-up piles, you pick one, Ring tempts you", () => {
  const g = setup({ p0: { hand: ["Sauron's Ransom"], battlefield: ["Carrion Feeder"], library: ["Swamp", "Plains", "Mountain", "Opt"] } });
  toMain(g);
  mana(g, 0, "{1}{U}{B}");
  act(g, "Cast Sauron's Ransom");
  resolveUntilAsk(g);
  assert.equal(g.request.player, 1);
  choose(g, "Opt", "Mountain");
  assert.equal(g.request.player, 0);
  assert.ok(g.request.options.some((o) => /hidden/.test(o.label)), "face-down pile contents are not shown");
  choose(g, "Face-up");
  resolveAll(g);
  assert.deepEqual(zoneNames(g, 0, "hand").sort(), ["Mountain", "Opt"]);
  assert.equal(g.state.players[0].ring.level, 1);
});

test("Secluded Courtyard / Path of Ancestry: no unrestricted mana is offered; leftovers stay flagged", () => {
  const c = compileCard(cardByName("Secluded Courtyard"));
  assert.equal(c.abilities.filter((a) => a.kind === "activated").length, 1);
  assert.ok(c.unparsed.length >= 1);
  const p = compileCard(cardByName("Path of Ancestry"));
  assert.ok(!JSON.stringify(p.abilities).includes('"manual"'));
  assert.equal(p.unparsed.length, 1);
});

test("Syr Konrad: another creature dying pings each opponent", () => {
  const g = setup({ p0: { battlefield: ["Syr Konrad, the Grim", "Carrion Feeder"] } });
  toMain(g);
  g.sacrifice(one(g, "Carrion Feeder"));
  kick(g);
  resolveAll(g);
  assert.equal(life(g, 1), 39);
});

test("Teferi's Protection: protection from everything, life total can't change, until your next turn", () => {
  const g = setup({ p0: { hand: ["Teferi's Protection"] }, p1: { battlefield: ["Gravecrawler"] } });
  toMain(g);
  mana(g, 0, "{2}{W}");
  act(g, "Cast Teferi's Protection");
  resolveAll(g);
  assert.equal(g.state.players[0].protection, true);
  assert.equal(g.dealDamage(one(g, "Gravecrawler"), "P0", 2), 0);
  assert.equal(g.gainLife(0, 3), 0);
  assert.ok(zoneNames(g, 0, "exile").includes("Teferi's Protection"));
  until(g, (r, st) => st.turn === 3 && st.step === "upkeep");
  assert.equal(g.state.players[0].protection, false);
  assert.deepEqual(compileCard(cardByName("Teferi's Protection")).unparsed.length, 1, "phasing is still flagged");
});

test("Territory Culler: landfall look at the top card", () => {
  const g = setup({ p0: { hand: ["Forest", "Forest"], battlefield: ["Territory Culler"], library: ["Island", "Carrion Feeder"] } });
  toMain(g);
  act(g, "Play Forest");
  resolveUntilAsk(g);
  confirm(g, true);
  resolveAll(g);
  assert.ok(zoneNames(g, 0, "hand").includes("Carrion Feeder"));
  healthy(g);
});

test("Villainous Wrath: target opponent loses life equal to their creatures, then all creatures die", () => {
  const g = setup({ p0: { hand: ["Villainous Wrath"], battlefield: ["Carrion Feeder"] }, p1: { battlefield: ["Gravecrawler", "Ripjaw Raptor", "Dread Presence"] } });
  toMain(g);
  mana(g, 0, "{3}{B}{B}");
  act(g, "Cast Villainous Wrath");
  resolveAll(g);
  assert.equal(life(g, 1), 37);
  assert.equal(g.state.battlefield.filter((id) => g.state.objects[id].c.types.includes("creature")).length, 0);
  healthy(g);
});

test("Witch-king of Angmar: the opponent sacrifices a creature that hit you; the Ring tempts you", () => {
  const g = setup({ p0: { battlefield: ["Witch-king of Angmar"] }, p1: { battlefield: ["Gravecrawler", "Nested Shambler"] } });
  until(g, (r) => r.kind === "attackers" && r.player === 1);
  g.respond({ attacks: [{ obj: one(g, "Gravecrawler").id, defender: "P0" }] });
  until(g, (r, st) => st.stack.length > 0 && r.kind === "priority");
  resolveUntilAsk(g);
  assert.equal(life(g, 0), 38);
  assert.equal(byName(g, "Gravecrawler").length, 0, "the creature that dealt damage was sacrificed");
  assert.equal(byName(g, "Nested Shambler").length, 1);
  assert.equal(g.state.players[0].ring.level, 1);
  healthy(g);
});

test("Witch-king, Bringer of Ruin: defending player sacrifices their least-power creature", () => {
  const g = setup({ p0: { battlefield: ["Witch-king, Bringer of Ruin"] }, p1: { battlefield: ["Ripjaw Raptor", "Gravecrawler"] } });
  toMain(g);
  until(g, (r) => r.kind === "attackers");
  g.respond({ attacks: [{ obj: one(g, "Witch-king, Bringer of Ruin").id, defender: "P1" }] });
  resolveUntilAsk(g);
  resolveAll(g);
  assert.equal(byName(g, "Gravecrawler").length, 0);
  assert.equal(byName(g, "Ripjaw Raptor").length, 1);
  healthy(g);
});

test("Woe Strider: escape from the graveyard with two +1/+1 counters", () => {
  const g = setup({ p0: { graveyard: ["Woe Strider", "Swamp", "Swamp", "Swamp", "Swamp"] } });
  toMain(g);
  mana(g, 0, "{3}{B}{B}");
  act(g, "Cast Woe Strider (escape)");
  resolveUntilAsk(g);
  if (g.request.kind === "choose") chooseNone(g);
  resolveAll(g);
  const w = one(g, "Woe Strider");
  assert.equal(w.counters["+1/+1"], 2);
  assert.equal(w.c.power, 5);
  healthy(g);
});

test("Wrathful Raptors: a damaged Dinosaur you control deals that much damage to a non-Dinosaur", () => {
  const g = setup({ p0: { battlefield: ["Wrathful Raptors"] }, p1: { battlefield: ["Gravecrawler", "Ripjaw Raptor"] } });
  toMain(g);
  g.dealDamage(one(g, "Gravecrawler"), one(g, "Wrathful Raptors").id, 3);
  kick(g);
  const opts = g.request.options.map((o) => o.label).join("|");
  assert.ok(!/Ripjaw|Wrathful/.test(opts), "Dinosaurs are not legal targets: " + opts);
  choose(g, "Gravecrawler");
  resolveAll(g);
  assert.equal(byName(g, "Gravecrawler").length, 0);
  healthy(g);
});

test("Yidaro: cycling shuffles it back; the fourth cycle puts it onto the battlefield", () => {
  const g = setup({ p0: { hand: ["Yidaro, Wandering Monster"] } });
  toMain(g);
  mana(g, 0, "{1}{R}");
  act(g, "Cycle Yidaro");
  resolveAll(g);
  assert.equal(byName(g, "Yidaro, Wandering Monster", "library").length, 1, "shuffled into the library");
  const y = one(g, "Yidaro, Wandering Monster", "library");
  g.state.players[0].yidaroCycles = 3;
  g.moveObj(y, "hand", { quiet: true });
  g.refreshRequest();
  mana(g, 0, "{1}{R}");
  act(g, "Cycle Yidaro");
  resolveAll(g);
  assert.equal(byName(g, "Yidaro, Wandering Monster").length, 1, "on the battlefield");
  healthy(g);
});

// ------------------------------------------------------------------ spot-checks of fully parsed deck cards (compiled IR compared with oracle text)
test("Pyrohemia: survives the end step while ANY creature is on the battlefield; sacrificed when none are", () => {
  const g = setup({ p0: { battlefield: ["Pyrohemia"] }, p1: { battlefield: ["Carrion Feeder"] } });
  const atEnd = (r, st) => r && r.kind === "priority" && st.step === "end" && r.player === 0;
  until(g, atEnd);
  resolveAll(g);
  assert.equal(byName(g, "Pyrohemia").length, 1, "an opponent's creature keeps it alive");
  g.destroy(one(g, "Carrion Feeder"));
  kick(g);
  until(g, (r, st) => r && r.kind === "priority" && st.step === "end" && st.active === 1 && r.player === 0 && st.turn > 2 || !byName(g, "Pyrohemia").length);
  resolveAll(g);
  assert.equal(byName(g, "Pyrohemia").length, 0, "no creatures: sacrificed");
  healthy(g);
});

test("Smothering Tithe: an opponent that doesn't pay {2} for a draw gives you a Treasure", () => {
  const g = setup({ p0: { battlefield: ["Smothering Tithe"] }, p1: { library: ["Island", "Island"] } });
  toMain(g);
  g.draw(1, 1);
  g.refreshRequest();
  assert.equal(g.state.pendingTriggers.length, 1, "Smothering Tithe triggers on the opponent's draw");
  kick(g);
  let guard = 12;
  while (guard-- > 0 && !g.over && (g.request.kind !== "priority" || g.state.stack.length)) {
    if (g.request.kind === "confirm") confirm(g, false);
    else if (g.request.kind === "priority") g.respond({ type: "pass" });
    else g.respond(g.defaultAnswer(g.request));
  }
  assert.equal(byName(g, "Treasure", "battlefield", 0).length, 1, "declined payment -> Treasure for the Tithe's controller");
  healthy(g);
});

test("Nasty End / Bitter Triumph: additional costs are enforced; Nasty End draws 3 for a legendary sacrifice", () => {
  const g = setup({ p0: { hand: ["Nasty End", "Bitter Triumph"], battlefield: ["Drivnod, Carnage Dominus", "Carrion Feeder"], library: ["Swamp", "Swamp", "Swamp", "Swamp", "Swamp", "Swamp"] }, p1: { battlefield: ["Gravecrawler"] } });
  toMain(g);
  mana(g, 0, "{1}{B}");
  act(g, "Cast Nasty End");
  choose(g, "Drivnod");
  resolveAll(g);
  assert.equal(zoneNames(g, 0, "hand").filter((n) => n === "Swamp").length, 3, "legendary sacrifice: three cards");
  mana(g, 0, "{1}{B}");
  const l0 = life(g, 0);
  act(g, "Cast Bitter Triumph");
  const seen = [];
  let guard = 8;
  while (g.request.kind !== "priority" && guard-- > 0) {
    const r = g.request;
    seen.push(r.kind + ": " + (r.options || []).map((o) => o.label).join(" | "));
    if (r.kind === "choose" && r.options.some((o) => /Gravecrawler/.test(o.label))) choose(g, "Gravecrawler");
    else if (r.kind === "choose" && r.options.some((o) => /life/i.test(o.label))) choose(g, r.options.find((o) => /life/i.test(o.label)).label);
    else g.respond(g.defaultAnswer(r));
  }
  assert.ok(seen.some((s) => /life/i.test(s)), "the discard-or-3-life additional cost is offered: " + seen.join(" // "));
  resolveAll(g);
  assert.equal(byName(g, "Gravecrawler").length, 0, "target destroyed");
  assert.equal(life(g, 0), l0 - 3, "paid 3 life");
  healthy(g);
});

test("Revel in Riches: ten Treasures at your upkeep wins the game; nine do not", () => {
  const g = setup({ p0: { battlefield: ["Revel in Riches"] } });
  const mk = (n) => { for (let i = 0; i < n; i++) g.createToken(0, "treasure"); };
  mk(9);
  toMain(g);
  g.state.step = "main1"; // already at main1 of turn 1; push to P0's next upkeep
  until(g, (r, st) => r && r.kind === "priority" && st.step === "upkeep" && st.active === 0 && st.turn > 1);
  resolveAll(g);
  assert.ok(!g.over, "nine Treasures: no win");
  mk(1);
  until(g, (r, st) => g.over || (r && r.kind === "priority" && st.step === "upkeep" && st.active === 0 && st.turn > 3));
  resolveAll(g);
  assert.ok(g.over && g.winner === 0, "ten Treasures: win");
  healthy(g);
});

// ------------------------------------------------------------------ real decks still play with the overrides in place
test("real decks: random-play games run clean, with no engine errors and no manual events for overridden cards", () => {
  const decks = allDecks();
  const names = new Set(Object.keys(OVERRIDES));
  const bad = [];
  const games = 14;
  for (let i = 0; i < games; i++) {
    const a = decks[i % decks.length], b = decks[(i + 1 + Math.floor(i / decks.length)) % decks.length];
    const g = createGame({ players: [{ name: "Nate", deck: a, ai: false }, { name: "AI", deck: b, ai: true }], options: { seed: 500 + i, commander: true }, compile: compileCard });
    g.start();
    const rnd = makeRnd(900 + i);
    for (let n = 0; !g.over && g.request && n < 40000; n++) {
      const req = g.request;
      try { g.respond(randomAnswer(req, rnd)); } catch (e) { if (g.error) break; g.respond(g.defaultAnswer(req)); }
      for (const e of g.drainEvents()) if (e.t === "manual" && [...names].some((nm) => (e.text || "").startsWith(nm))) bad.push(`game ${i}: ${e.text}`);
    }
    assert.equal(g.error, null, `game ${i}: ${g.error && g.error.stack}`);
  }
  assert.deepEqual(bad, []);
});
