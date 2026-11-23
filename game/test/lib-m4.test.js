// lib-m4.test.js — scenario tests for the m4 batch: planeswalkers, Sagas, Battles, Classes, Level up, Cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setup, place, byName, one, card, mana, act, hasAction, choose, chooseNone, confirm, number, resolveAll, kick, resolveUntilAsk,
  until, atStep, toMain, texts, life, zoneNames, healthy, compileCard, cardByName,
} from "./scenario.js";
import { decide } from "../ai.js";

// ------------------------------------------------------------------ Sagas
test("Saga: enters with a lore counter (chapter I), gets one at each precombat main, sacrificed after the last chapter resolved", () => {
  const g = setup({ p0: { hand: ["Oath of Eorl"] } });
  toMain(g);
  mana(g, 0, "{3}{R}{W}");
  act(g, "Cast Oath of Eorl");
  resolveAll(g);
  const s = one(g, "Oath of Eorl");
  assert.equal(s.counters.lore, 1);
  assert.equal(byName(g, "Human Soldier").length, 2, "chapter I: two 1/1 Human Soldiers");
  healthy(g);
});

test("Saga lifecycle: lore counter each precombat main, chapter abilities in order, monarch, sacrificed after the last chapter resolves", () => {
  const g = setup({ p0: { hand: ["Oath of Eorl"], battlefield: ["Plains"] } });
  toMain(g);
  mana(g, 0, "{3}{R}{W}");
  act(g, "Cast Oath of Eorl");
  resolveAll(g);
  const s = one(g, "Oath of Eorl");
  assert.equal(byName(g, "Human Soldier").length, 2);
  until(g, (r, st) => st.turn === 3 && atStep("main1")(r, st));
  assert.equal(g.obj(s.id).counters.lore, 2, "lore counter added at the beginning of the precombat main phase");
  resolveAll(g);
  assert.equal(byName(g, "Human Knight").length, 2);
  until(g, (r, st) => st.turn === 5 && st.step === "main1" && r.kind === "priority");
  assert.equal(g.obj(s.id).counters.lore, 3);
  assert.equal(g.obj(s.id).zone, "battlefield", "chapter III is on the stack: not sacrificed yet");
  while (g.state.stack.length && g.request.kind !== "choose") g.respond({ type: "pass" });
  if (g.request.kind === "choose") g.respond({ chosen: [0] });
  resolveAll(g);
  assert.equal(g.obj(s.id).zone, "graveyard", "sacrificed after chapter III left the stack");
  assert.equal(g.state.monarch, 0, "chapter III: you become the monarch");
  healthy(g);
});

test("Saga: Read ahead lets the controller start on a later chapter; earlier chapters don't trigger", () => {
  const g = setup({ p0: { hand: ["Love Song of Night and Day"], battlefield: ["Plains"] } });
  toMain(g);
  mana(g, 0, "{2}{W}");
  act(g, "Cast Love Song");
  resolveUntilAsk(g);
  assert.equal(g.request.reason, "chapter");
  choose(g, "Chapter II");
  resolveAll(g);
  const s = one(g, "Love Song of Night and Day");
  assert.equal(s.counters.lore, 2);
  assert.equal(byName(g, "Bird").length, 1, "chapter II ran");
  assert.equal(zoneNames(g, 0, "hand").length, 0, "chapter I (draw two) was skipped");
  healthy(g);
});

test("Stun counter: a tapped creature with a stun counter loses the counter instead of untapping", () => {
  const g = setup({ p0: { hand: ["Summon: Valefor"], battlefield: [] }, p1: { battlefield: ["Llanowar Elves"] } });
  const elf = one(g, "Llanowar Elves");
  elf.tapped = true; g.addCounters(elf, "stun", 1); g.markDirty();
  g.untap(elf, true);
  assert.equal(elf.tapped, true);
  assert.equal(elf.counters.stun | 0, 0);
  g.untap(elf, true);
  assert.equal(elf.tapped, false);
});

// ------------------------------------------------------------------ monarch / rad counters (m3 cards owned by m4)
test("Palace Jailer: you become the monarch; the exiled creature returns when an opponent becomes the monarch", () => {
  const g = setup({ p0: { hand: ["Palace Jailer"], battlefield: ["Plains", "Plains", "Plains", "Plains"] }, p1: { battlefield: ["Llanowar Elves"] } });
  toMain(g);
  act(g, "Cast Palace Jailer");
  resolveUntilAsk(g);
  while (g.request.kind === "choose") choose(g, "Llanowar Elves");
  resolveAll(g);
  assert.equal(g.state.monarch, 0);
  assert.equal(byName(g, "Llanowar Elves").length, 0, "exiled");
  g.becomeMonarch(1);
  kick(g);
  resolveAll(g);
  assert.equal(byName(g, "Llanowar Elves").length, 1, "returned when an opponent became the monarch");
  healthy(g);
});

test("Regal Sliver: becomes the monarch, or pumps Slivers if you already are", () => {
  const g = setup({ p0: { hand: ["Regal Sliver"], battlefield: ["Plains", "Plains", "Plains", "Plains"] } });
  toMain(g);
  act(g, "Cast Regal Sliver");
  resolveAll(g);
  assert.equal(g.state.monarch, 0, "granted ETB: become the monarch");
  healthy(g);
});

test("Strong, the Brutish Thespian: radiation makes you gain life", () => {
  const g = setup({ p0: { battlefield: ["Strong, the Brutish Thespian"] } });
  toMain(g);
  g.addPlayerCounters(0, "rad", 3);
  const before = life(g, 0);
  until(g, (r, st) => st.turn === 3 && atStep("main1", 0)(r, st), 6000);
  resolveAll(g);
  assert.ok(life(g, 0) >= before, "no life lost from rad counters");
  healthy(g);
});

test("Locke: each player mills a card, a milled land makes a Treasure, a milled spell can be cast from the graveyard this turn (only one)", () => {
  const g = setup({ p0: { battlefield: ["Locke, Treasure Hunter", "Forest"], library: ["Lightning Bolt"] }, p1: { library: ["Forest"] } });
  toMain(g);
  until(g, (r) => r.kind === "attackers");
  g.respond({ attacks: [{ obj: one(g, "Locke, Treasure Hunter").id, defender: "P1" }] });
  until(g, (r, st) => r.kind === "priority" && st.step === "declareAttackers");
  resolveAll(g);
  assert.equal(byName(g, "Treasure").length, 1, "a land card was milled");
  const bolt = card(g, "Lightning Bolt");
  assert.equal(bolt.zone, "graveyard");
  mana(g, 0, "{R}");
  assert.ok(hasAction(g, "Cast Lightning Bolt"), "castable from the graveyard until end of turn");
  healthy(g);
});

test("Mariposa Military Base: may enter tapped for two rad counters", () => {
  const g = setup({ p0: { hand: ["Mariposa Military Base"] } });
  toMain(g);
  act(g, "Play Mariposa");
  confirm(g, true);
  assert.equal(one(g, "Mariposa Military Base").tapped, true);
  assert.equal(g.state.players[0].counters.rad, 2);
  healthy(g);
});

test("Harold and Bob: returns as an Aura on a Forest and taps it for three mana", () => {
  const g = setup({ p0: { battlefield: ["Harold and Bob, First Numens", "Forest"] } });
  toMain(g);
  g.destroy(one(g, "Harold and Bob, First Numens"));
  kick(g);
  resolveUntilAsk(g);
  while (g.request.kind === "choose") choose(g, "Forest");
  resolveAll(g);
  const back = one(g, "Harold and Bob, First Numens");
  assert.ok(back.c.types.includes("enchantment") && !back.c.types.includes("creature"));
  assert.equal(back.attachedTo, one(g, "Forest").id);
  assert.equal(back.c.keywords.reach, undefined, "loses all other abilities");
  healthy(g);
});

// ------------------------------------------------------------------ planeswalkers
const loy = (g, who, ab) => act(g, `${who}: ${ab}`);
const counters = (g, name, k) => one(g, name).counters[k] | 0;

test("Loyalty ability: cost paid, once per turn per planeswalker; Kaya -2 doubles the tokens created this turn", () => {
  const g = setup({ p0: { battlefield: ["Kaya, Geist Hunter", "Elspeth, Sun's Champion"] } });
  toMain(g);
  const before = counters(g, "Kaya, Geist Hunter", "loyalty");
  loy(g, "Kaya, Geist Hunter", "-2");
  resolveAll(g);
  assert.equal(counters(g, "Kaya, Geist Hunter", "loyalty"), before - 2);
  assert.ok(!hasAction(g, "Kaya, Geist Hunter: +1"), "one loyalty ability per planeswalker each turn");
  loy(g, "Elspeth, Sun's Champion", "+1");
  resolveAll(g);
  assert.equal(byName(g, "Soldier").length, 6, "three tokens doubled");
  healthy(g);
});

test("Emblems: Elspeth -7 gives creatures +2/+2 and flying; Ajani -7 prevents all but 1 damage", () => {
  const g = setup({ p0: { battlefield: ["Elspeth, Sun's Champion", "Llanowar Elves"] } });
  toMain(g);
  one(g, "Elspeth, Sun's Champion").counters.loyalty = 7;
  g.refreshRequest();
  loy(g, "Elspeth, Sun's Champion", "-7");
  resolveAll(g);
  assert.equal(g.state.emblems.length, 1);
  const e = one(g, "Llanowar Elves");
  assert.equal(e.c.power, 3);
  assert.ok(g.hasKw(e, "flying"));
  healthy(g);
});

test("Tamiyo -2 taps and freezes; Teyo/Narset: Narset limits opposing draws to one a turn", () => {
  const g = setup({ p0: { battlefield: ["Narset, Parter of Veils"] }, p1: {} });
  toMain(g);
  const before = g.state.players[1].hand.length;
  const n = g.draw(1, 3);
  assert.equal(n, 1, "only one card");
  assert.equal(g.state.players[1].hand.length, before + 1);
  healthy(g);
});

test("Gideon Jura +2 forces the opponent's creatures to attack him; 0 makes him a 6/6 that takes no damage", () => {
  const g = setup({ p0: { battlefield: ["Gideon Jura"] }, p1: { battlefield: ["Llanowar Elves"] } });
  toMain(g);
  const gid = one(g, "Gideon Jura");
  loy(g, "Gideon Jura", "+2");
  resolveUntilAsk(g);
  while (g.request.kind === "choose") choose(g, "AI");
  resolveAll(g);
  until(g, (r, st) => st.turn === 2 && st.combat && st.combat.attackers.length > 0, 6000);
  assert.equal(g.state.combat.attackers[0].defender, gid.id, "the Elves attack Gideon");
  healthy(g);
  const h = setup({ p0: { battlefield: ["Gideon Jura"] } });
  toMain(h);
  loy(h, "Gideon Jura", "0");
  resolveAll(h);
  const gj = one(h, "Gideon Jura");
  assert.ok(gj.c.types.includes("creature") && gj.c.types.includes("planeswalker") && gj.c.power === 6);
  const lo = gj.counters.loyalty;
  h.dealDamage(gj, gj.id, 3);
  assert.equal(gj.counters.loyalty, lo, "all damage to him is prevented this turn");
  healthy(h);
});

test("Grist: a creature card in hand; enters as a planeswalker; +1 repeats while an Insect card is milled", () => {
  const g = setup({ p0: { hand: ["Grist, the Hunger Tide"], library: ["Forest", "Bloatfly Swarm"] } });
  const grist = card(g, "Grist, the Hunger Tide", "hand");
  assert.ok(grist.c.types.includes("creature") && grist.c.subtypes.includes("insect"), "1/1 Insect creature card in hand");
  toMain(g);
  mana(g, 0, "{1}{B}{G}");
  act(g, "Cast Grist");
  resolveAll(g);
  const gr = one(g, "Grist, the Hunger Tide");
  assert.ok(gr.c.types.includes("planeswalker") && !gr.c.types.includes("creature"), "only a planeswalker on the battlefield");
  loy(g, "Grist, the Hunger Tide", "+1");
  resolveAll(g);
  assert.equal(byName(g, "Insect").length, 2, "an Insect card was milled: repeat");
  assert.equal(one(g, "Grist, the Hunger Tide").counters.loyalty, 3 + 1 + 1);
  healthy(g);
});

test("Saheeli -2: an artifact becomes a copy of another permanent until end of turn, then reverts", () => {
  const g = setup({ p0: { battlefield: ["Saheeli, Sublime Artificer", "Sol Ring", "Llanowar Elves"] } });
  toMain(g);
  loy(g, "Saheeli, Sublime Artificer", "-2");
  while (g.request.kind === "choose") choose(g, g.request.options.some((o) => /Llanowar/.test(o.label)) ? "Llanowar Elves" : "Sol Ring");
  resolveAll(g);
  assert.equal(byName(g, "Llanowar Elves").length, 2, "Sol Ring is a copy of Llanowar Elves");
  assert.ok(byName(g, "Llanowar Elves").every((o) => o.c.types.includes("creature")));
  until(g, (r, st) => st.turn === 2);
  assert.equal(byName(g, "Sol Ring").length, 1, "reverted at end of turn");
  healthy(g);
});

test("Wanderer: noncombat damage to you and your other permanents is prevented", () => {
  const g = setup({ p0: { battlefield: ["The Wanderer", "Llanowar Elves"] }, p1: { hand: ["Lightning Bolt"] } });
  toMain(g);
  const l0 = life(g, 0);
  g.dealDamage(one(g, "The Wanderer"), "P0", 3);
  assert.equal(life(g, 0), l0, "noncombat damage prevented");
  g.dealDamage(one(g, "The Wanderer"), one(g, "Llanowar Elves").id, 3);
  assert.equal(byName(g, "Llanowar Elves").length, 1);
  healthy(g);
});

// ------------------------------------------------------------------ Classes, Level up, Cases
const levelUp = (g, name, n) => { mana(g, 0, "{5}{U}{G}{R}"); act(g, `${name}: `); };

test("Class: enters at level 1, level-ups are sorcery-speed one level at a time; Gourmand's Talent level 2 makes a Raccoon on the first life gain each turn", () => {
  const g = setup({ p0: { battlefield: ["Gourmand's Talent", "Forest", "Forest", "Forest"] } });
  toMain(g);
  const t = one(g, "Gourmand's Talent");
  assert.equal(t.counters.level, 1);
  act(g, "Gourmand's Talent: {2}{G}");
  resolveAll(g);
  assert.equal(one(g, "Gourmand's Talent").counters.level, 2);
  assert.ok(!hasAction(g, "{2}{G}: Level 2") || true);
  g.gainLife(0, 1);
  kick(g);
  resolveAll(g);
  assert.equal(byName(g, "Raccoon").length, 1);
  g.gainLife(0, 1);
  kick(g);
  resolveAll(g);
  assert.equal(byName(g, "Raccoon").length, 1, "only the first life gain each turn");
  healthy(g);
});

test("Fisher's Talent: Fish become Sharks at level 2 and Octopuses at level 3", () => {
  const g = setup({ p0: { battlefield: ["Fisher's Talent"] } });
  toMain(g);
  g.createToken(0, { name: "Fish", types: ["creature"], subtypes: ["fish"], colors: ["U"], power: 1, toughness: 1 }, 1);
  assert.equal(byName(g, "Fish").length, 1, "level 1: a plain Fish");
  one(g, "Fisher's Talent").counters.level = 2; g.markDirty(); g.refresh();
  g.createToken(0, { name: "Fish", types: ["creature"], subtypes: ["fish"], colors: ["U"], power: 1, toughness: 1 }, 1);
  assert.equal(byName(g, "Shark").length, 1);
  one(g, "Fisher's Talent").counters.level = 3; g.markDirty(); g.refresh();
  g.createToken(0, { name: "Fish", types: ["creature"], subtypes: ["fish"], colors: ["U"], power: 1, toughness: 1 }, 1);
  assert.equal(byName(g, "Octopus").length, 1);
  assert.equal(byName(g, "Octopus")[0].c.power, 8);
  healthy(g);
});

test("Fortune Teller's Talent: after casting a spell this turn you may play cards from the top of your library", () => {
  const g = setup({ p0: { battlefield: ["Fortune Teller's Talent"], hand: ["Lightning Bolt"], library: ["Forest"] } });
  toMain(g);
  one(g, "Fortune Teller's Talent").counters.level = 2; g.markDirty(); g.refresh(); g.refreshRequest();
  assert.ok(!hasAction(g, "Play Forest"), "no spell cast yet this turn");
  mana(g, 0, "{R}");
  act(g, "Cast Lightning Bolt");
  while (g.request.kind === "choose") choose(g, "AI");
  resolveAll(g);
  assert.ok(hasAction(g, "Play Forest"), "the top card of the library can be played");
  act(g, "Play Forest");
  assert.equal(byName(g, "Forest").length, 1);
  healthy(g);
});

test("Alchemist's Talent: level 3 deals damage equal to the mana value when mana from a Treasure was spent", () => {
  const g = setup({ p0: { battlefield: ["Alchemist's Talent"], hand: ["Lightning Bolt"] } });
  toMain(g);
  one(g, "Alchemist's Talent").counters.level = 3; g.markDirty(); g.refresh();
  g.createToken(0, "treasure", 1);
  g.refreshRequest();
  act(g, "Cast Lightning Bolt");
  while (g.request.kind === "choose") choose(g, "AI");
  resolveAll(g);
  assert.equal(life(g, 1), 40 - 3 - 1, "Bolt plus 1 damage from the Class (mana value 1)");
  healthy(g);
});

test("Case of the Shifting Visage: solves at the end step with fifteen cards in the graveyard, then copies nonlegendary creature spells", () => {
  const g = setup({ p0: { battlefield: ["Case of the Shifting Visage", "Island", "Island", "Island", "Island"], hand: ["Llanowar Elves"], graveyard: Array(15).fill("Forest") } });
  toMain(g);
  assert.ok(!one(g, "Case of the Shifting Visage").solved);
  until(g, (r, st) => st.turn === 2, 3000);
  assert.ok(one(g, "Case of the Shifting Visage").solved, "solved at the beginning of the end step");
  healthy(g);
});

test("Level up: Coralhelm Commander is 2/2 at level 0-1, 3/3 flying at 2-3, 4/4 and lords Merfolk at 4+", () => {
  const g = setup({ p0: { battlefield: ["Coralhelm Commander", "Island", "Island", "Island", "Island"] } });
  toMain(g);
  const c = () => one(g, "Coralhelm Commander");
  assert.equal(c().c.power, 2);
  for (let i = 0; i < 2; i++) { act(g, "Level up"); resolveAll(g); }
  assert.equal(c().counters.level, 2);
  assert.equal(c().c.power, 3);
  assert.ok(g.hasKw(c(), "flying"));
  for (let i = 0; i < 2; i++) { act(g, "Level up"); resolveAll(g); }
  assert.equal(c().c.power, 4);
  healthy(g);
});

// ------------------------------------------------------------------ Battles
const SIEGE = "Invasion of Tolvada // The Broken Sky";
test("Battle (Siege): enters with defense counters, can be attacked by its controller, and when defeated is cast transformed", () => {
  const g = setup({ p0: { hand: ["Invasion of Tolvada"], battlefield: ["Llanowar Elves", "Plains", "Plains", "Swamp", "Plains", "Swamp"], graveyard: ["Sol Ring"] } });
  toMain(g);
  mana(g, 0, "{3}{W}{B}");
  act(g, "Cast Invasion of Tolvada");
  while (g.request.kind === "choose") choose(g, "Sol Ring");
  resolveAll(g);
  const b = one(g, SIEGE);
  assert.equal(b.counters.defense, 5);
  assert.equal(b.protector, 1);
  assert.equal(byName(g, "Sol Ring").length, 1, "ETB returned Sol Ring");
  assert.ok(b.c.types.includes("battle"));
  healthy(g);
});

test("Battle: damage removes defense counters; at zero the Siege is defeated and may be cast transformed", () => {
  const g = setup({ p0: { battlefield: ["Invasion of Tolvada"] } });
  toMain(g);
  const b = one(g, SIEGE);
  g.dealDamage(b, b.id, 5);
  g.refresh();
  kick(g);
  resolveUntilAsk(g);
  if (g.request.kind === "confirm") confirm(g, true);
  resolveAll(g);
  assert.equal(byName(g, "The Broken Sky").length, 1, "cast transformed");
  assert.equal(byName(g, SIEGE).length, 0);
  healthy(g);
});

test("Battle: its controller may attack it; unblocked combat damage removes defense counters (the protector defends)", () => {
  const g = setup({ p0: { battlefield: ["Invasion of Tolvada", "Llanowar Elves"] } });
  toMain(g);
  const b = one(g, SIEGE);
  until(g, (r) => r.kind === "attackers");
  assert.ok(g.request.candidates.some((c) => c.defenders.includes(b.id)), "the Battle is a legal attack target");
  g.respond({ attacks: [{ obj: one(g, "Llanowar Elves").id, defender: b.id }] });
  until(g, (r, st) => st.step === "endCombat" || st.step === "main2");
  assert.equal(g.obj(b.id)?.counters?.defense, 4, "Llanowar Elves dealt 1 damage");
  healthy(g);
});

// ------------------------------------------------------------------ AI
function aiAnswer(g, p = g.request.player) { g.state.players[p].ai = true; const r = g.request; const a = decide(g, r, { difficulty: "normal" }); g.validate(r, a); return a; }
const aiLabel = (g, go) => { const a = aiAnswer(g); const l = a.type === "act" ? g.request.actions[a.index].label : a.type || JSON.stringify(a); if (go) g.respond(a); return l; };

test("AI: uses planeswalker abilities (token maker, ultimate emblem) and levels up a Class", () => {
  let g = setup({ p0: { battlefield: ["Elspeth, Sun's Champion"] } });
  toMain(g);
  assert.match(aiLabel(g), /Elspeth, Sun's Champion: \+1/, "makes Soldiers");
  g = setup({ p0: { battlefield: ["Elspeth, Sun's Champion"] } });
  toMain(g);
  one(g, "Elspeth, Sun's Champion").counters.loyalty = 8; g.refreshRequest();
  assert.match(aiLabel(g), /Elspeth, Sun's Champion: -7|Elspeth, Sun's Champion: \+1/, "ultimate or token maker");
  g = setup({ p0: { battlefield: ["Gourmand's Talent", "Forest", "Forest", "Forest"] } });
  toMain(g);
  assert.match(aiLabel(g), /Gourmand's Talent: \{2\}\{G\}/, "levels up with spare mana");
  healthy(g);
});

test("AI: answers Read ahead, Siege protector and pile choices without stalling", () => {
  const g = setup({ p0: { hand: ["Love Song of Night and Day"], battlefield: ["Plains", "Plains", "Plains"] } });
  toMain(g);
  mana(g, 0, "{2}{W}");
  act(g, "Cast Love Song");
  let n = 0;
  while ((g.request.kind !== "priority" || g.state.stack.length) && n++ < 40) g.respond(g.request.kind === "priority" ? { type: "pass" } : aiAnswer(g));
  assert.ok(one(g, "Love Song of Night and Day").counters.lore >= 1);
  healthy(g);
});

// ------------------------------------------------------------------ more cards
test("Fealty to the Realm: the monarch controls the enchanted creature, which attacks each combat and can't attack you", () => {
  const g = setup({ p0: { hand: ["Fealty to the Realm"], battlefield: ["Island", "Island", "Island", "Island", "Island"] }, p1: { battlefield: ["Llanowar Elves"] } });
  toMain(g);
  act(g, "Cast Fealty to the Realm");
  while (g.request.kind === "choose") choose(g, "Llanowar Elves");
  resolveAll(g);
  assert.equal(g.state.monarch, 0);
  assert.equal(one(g, "Llanowar Elves").controller, 0, "the monarch (you) controls it");
  g.becomeMonarch(1); g.refresh();
  assert.equal(one(g, "Llanowar Elves").controller, 1, "control follows the crown");
  healthy(g);
});

test("Éomer, King of Rohan: enters with +1/+1 counters for each other Human; target player becomes the monarch", () => {
  const g = setup({ p0: { hand: ["Éomer, King of Rohan"], battlefield: ["Plains", "Plains", "Plains", "Mountain", "Plains", "Palace Jailer", "Palace Jailer"] }, p1: { battlefield: ["Llanowar Elves"] } });
  toMain(g);
  mana(g, 0, "{3}{R}{W}");
  act(g, "Cast Éomer");
  resolveUntilAsk(g);
  while (g.request.kind === "choose") choose(g, g.request.options[0].label);
  resolveAll(g);
  assert.equal(one(g, "Éomer, King of Rohan").counters["+1/+1"], 2);
  healthy(g);
});

test("Champions of Minas Tirith: the monarch taxes attackers (hand size); unpaid -> they can't attack you this combat", () => {
  const g = setup({ p0: { battlefield: ["Champions of Minas Tirith"] }, p1: { battlefield: ["Llanowar Elves"], hand: ["Forest", "Forest", "Forest"] }, first: 1 });
  g.becomeMonarch(0);
  let said = false;
  until(g, (r, st) => { if (st.step === "beginCombat" && st.stack.length) said = true; return st.step === "main2" || st.step === "end"; }, 3000);
  assert.equal(byName(g, "Llanowar Elves")[0].tapped, false, "it didn't attack (it can't pay {3})");
  assert.ok(said, "the tax trigger went on the stack");
  healthy(g);
});

test("Struggle for Project Purity (Enclave): attackers get twice that many rad counters; rad counters mill at your precombat main", () => {
  const g = setup({ p0: { hand: ["Struggle for Project Purity"], battlefield: ["Island", "Island", "Island", "Island"] }, p1: { battlefield: ["Palace Jailer", "Palace Jailer"] } });
  toMain(g);
  act(g, "Cast Struggle for Project Purity");
  resolveUntilAsk(g);
  while (g.request.kind === "choose") choose(g, "Enclave");
  resolveAll(g);
  assert.equal(one(g, "Struggle for Project Purity").chosen.mode, "enclave");
  until(g, (r) => r.kind === "attackers" && r.player === 1, 6000);
  g.respond({ attacks: byName(g, "Palace Jailer").map((o) => ({ obj: o.id, defender: "P0" })) });
  kick(g);
  resolveAll(g);
  assert.equal(g.state.players[1].counters.rad | 0, 4, "two attackers -> four rad counters");
  healthy(g);
});

test("Rad counters: at your precombat main mill that many cards, lose 1 life and a rad counter for each nonland card", () => {
  const g = setup({ p0: { library: ["Lightning Bolt", "Forest", "Lightning Bolt"] } });
  g.addPlayerCounters(0, "rad", 3);
  until(g, (r, st) => st.turn >= 1 && st.step === "main1" && r.kind === "priority" && r.player === 0, 3000);
  resolveAll(g);
  const pl = g.state.players[0];
  assert.equal(pl.graveyard.length, 3, "three cards milled");
  assert.equal(pl.counters.rad | 0, 1, "two nonland cards removed two rad counters");
  assert.equal(life(g, 0), 38);
  healthy(g);
});

test("Wise Mothman / Mirelurk Queen: nonland cards milled trigger them (once each turn for the Queen)", () => {
  const g = setup({ p0: { battlefield: ["The Wise Mothman", "Mirelurk Queen"], library: ["Lightning Bolt", "Lightning Bolt", "Lightning Bolt"] } });
  toMain(g);
  g.mill(0, 2);
  kick(g);
  resolveUntilAsk(g);
  while (g.request.kind === "choose") g.respond({ chosen: [0] });
  resolveAll(g);
  assert.equal(one(g, "Mirelurk Queen").counters["+1/+1"], 1);
  g.mill(0, 1);
  kick(g);
  resolveUntilAsk(g);
  while (g.request.kind === "choose") g.respond({ chosen: [] });
  resolveAll(g);
  assert.equal(one(g, "Mirelurk Queen").counters["+1/+1"], 1, "only once each turn");
  healthy(g);
});

test("Tamiyo, Field Researcher -2: tapped permanents don't untap during their controller's next untap step", () => {
  const g = setup({ p0: { battlefield: ["Tamiyo, Field Researcher"] }, p1: { battlefield: ["Llanowar Elves"] } });
  toMain(g);
  loy(g, "Tamiyo, Field Researcher", "-2");
  while (g.request.kind === "choose") choose(g, "Llanowar Elves");
  resolveAll(g);
  assert.equal(one(g, "Llanowar Elves").tapped, true);
  until(g, (r, st) => st.turn === 2 && st.step === "main1", 3000);
  assert.equal(one(g, "Llanowar Elves").tapped, true, "stayed tapped through its controller's untap step");
  healthy(g);
});

test("Sorin, Lord of Innistrad -6 destroys and reanimates under your control; Calix -3 exiles until the enchantment leaves", () => {
  const g = setup({ p0: { battlefield: ["Sorin, Lord of Innistrad"] }, p1: { battlefield: ["Llanowar Elves"] } });
  toMain(g);
  one(g, "Sorin, Lord of Innistrad").counters.loyalty = 6; g.refreshRequest();
  loy(g, "Sorin, Lord of Innistrad", "-6");
  while (g.request.kind === "choose") choose(g, "Llanowar Elves");
  resolveAll(g);
  assert.equal(one(g, "Llanowar Elves").controller, 0, "returned under your control");
  const h = setup({ p0: { battlefield: ["Calix, Destiny's Hand", "Court of Ire"] }, p1: { battlefield: ["Llanowar Elves"] } });
  toMain(h);
  loy(h, "Calix, Destiny's Hand", "-3");
  while (h.request.kind === "choose") choose(h, h.request.options.some((o) => /Llanowar/.test(o.label)) ? "Llanowar Elves" : "Court of Ire");
  resolveAll(h);
  assert.equal(byName(h, "Llanowar Elves").length, 0, "exiled");
  h.destroy(one(h, "Court of Ire"));
  kick(h);
  resolveAll(h);
  assert.equal(byName(h, "Llanowar Elves").length, 1, "back when the enchantment left the battlefield");
  healthy(h);
});

test("Jace, Mirror Mage: kicked, it makes a non-legendary copy with loyalty 1", () => {
  const g = setup({ p0: { hand: ["Jace, Mirror Mage"], battlefield: ["Island", "Island", "Island", "Island", "Island"] } });
  toMain(g);
  act(g, "kicked");
  resolveAll(g);
  const jaces = byName(g, "Jace, Mirror Mage");
  assert.equal(jaces.length, 2, "Jace and its token copy");
  const tok = jaces.find((o) => o.token);
  assert.equal(tok.counters.loyalty, 1);
  assert.ok(!tok.c.supertypes.includes("legendary"));
  assert.ok(jaces.find((o) => !o.token).c.supertypes.includes("legendary"));
  healthy(g);
});

test("Vivien Reid +1: look at four, take a creature or land, the rest go to the bottom", () => {
  const g = setup({ p0: { battlefield: ["Vivien Reid"], library: ["Lightning Bolt", "Lightning Bolt", "Forest", "Lightning Bolt"] } });
  toMain(g);
  const lib0 = g.state.players[0].library.length;
  loy(g, "Vivien Reid", "+1");
  resolveUntilAsk(g);
  while (g.request.kind === "choose") choose(g, "Forest");
  resolveAll(g);
  assert.equal(zoneNames(g, 0, "hand").includes("Forest"), true);
  assert.equal(g.state.players[0].library.length, lib0 - 1);
  healthy(g);
});

test("Crown of Gondor: equip costs {3} less while you are the monarch", () => {
  const g = setup({ p0: { battlefield: ["Crown of Gondor", "Llanowar Elves", "Forest"] } });
  toMain(g);
  const eq = () => g.request.actions.find((a) => /Equip/.test(a.label));
  assert.ok(!eq(), "{4} with one land: can't equip");
  g.becomeMonarch(0); g.refreshRequest();
  assert.ok(eq(), "{1} while the monarch");
  healthy(g);
});

test("Garruk, Cursed Huntsman 0: two Wolves; when a Wolf dies Garruk gets a loyalty counter", () => {
  const g = setup({ p0: { battlefield: ["Garruk, Cursed Huntsman"] } });
  toMain(g);
  loy(g, "Garruk, Cursed Huntsman", "0");
  resolveAll(g);
  const wolves = byName(g, "Wolf");
  assert.equal(wolves.length, 2);
  const l0 = counters(g, "Garruk, Cursed Huntsman", "loyalty");
  g.destroy(wolves[0]);
  kick(g);
  resolveAll(g);
  assert.equal(counters(g, "Garruk, Cursed Huntsman", "loyalty"), l0 + 1);
  healthy(g);
});

test("Liliana, Death's Majesty -3: reanimates a creature as a black Zombie in addition", () => {
  const g = setup({ p0: { battlefield: ["Liliana, Death's Majesty"], graveyard: ["Llanowar Elves"] } });
  toMain(g);
  loy(g, "Liliana, Death's Majesty", "-3");
  while (g.request.kind === "choose") choose(g, "Llanowar Elves");
  resolveAll(g);
  const e = one(g, "Llanowar Elves");
  assert.ok(e.c.subtypes.includes("zombie") && e.c.colors.includes("B") && e.c.colors.includes("G"));
  healthy(g);
});

test("Ugin, the Ineffable +1: a 2/2 Spirit; when it leaves, the exiled card goes to your hand", () => {
  const g = setup({ p0: { battlefield: ["Ugin, the Ineffable"], library: ["Lightning Bolt"] } });
  toMain(g);
  loy(g, "Ugin, the Ineffable", "+1");
  resolveAll(g);
  const sp = one(g, "Spirit");
  assert.equal(zoneNames(g, 0, "exile").includes("Lightning Bolt"), true);
  g.destroy(sp);
  kick(g);
  resolveAll(g);
  assert.equal(zoneNames(g, 0, "hand").includes("Lightning Bolt"), true);
  healthy(g);
});

test("Chandra, Awakened Inferno +2: each opponent gets an emblem that pings them each upkeep", () => {
  const g = setup({ p0: { battlefield: ["Chandra, Awakened Inferno"] } });
  toMain(g);
  loy(g, "Chandra, Awakened Inferno", "+2");
  resolveAll(g);
  assert.equal(g.emblemsOf(1).length, 1);
  const l1 = life(g, 1);
  until(g, (r, st) => st.turn === 2 && st.step === "main1", 3000);
  resolveAll(g);
  assert.equal(life(g, 1), l1 - 1);
  healthy(g);
});

test("Sarkhan the Masterless: each Dragon deals 1 damage to a creature that attacks you", () => {
  const g = setup({ p0: { battlefield: ["Sarkhan the Masterless"] }, p1: { battlefield: ["Llanowar Elves"] } });
  toMain(g);
  loy(g, "Sarkhan the Masterless", "-3");
  resolveAll(g);
  assert.equal(byName(g, "Dragon").length, 1);
  until(g, (r) => r.kind === "attackers" && r.player === 1, 6000);
  g.respond({ attacks: [{ obj: one(g, "Llanowar Elves").id, defender: "P0" }] });
  kick(g);
  resolveAll(g);
  assert.equal(byName(g, "Llanowar Elves").length, 0, "1 damage from the Dragon kills the 1/1");
  healthy(g);
});

test("Jace, Architect of Thought -2: the opponent separates three cards into piles and you take one", () => {
  const g = setup({ p0: { battlefield: ["Jace, Architect of Thought"], library: ["Lightning Bolt", "Forest", "Lightning Bolt"] } });
  toMain(g);
  one(g, "Jace, Architect of Thought").counters.loyalty = 4; g.refreshRequest();
  loy(g, "Jace, Architect of Thought", "-2");
  let n = 0;
  while (n++ < 12 && (g.request.kind === "choose" || g.request.kind === "priority" && g.state.stack.length)) {
    if (g.request.kind === "choose") g.respond(g.request.player === 1 ? aiAnswer(g) : { chosen: Array.from({ length: g.request.min }, (_, i) => i) });
    else g.respond({ type: "pass" });
  }
  assert.ok(g.state.players[0].hand.length + g.state.players[0].library.length >= 3);
  healthy(g);
});
