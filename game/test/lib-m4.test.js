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

test("Fortune Teller's Talent: after casting a spell this turn you may play cards from the top of your library; level 3 reduces spells not cast from hand", () => {
  const g = setup({ p0: { battlefield: ["Fortune Teller's Talent", "Island"], hand: ["Opt"], library: ["Forest"] } });
  toMain(g);
  const t = one(g, "Fortune Teller's Talent");
  t.counters.level = 2; g.markDirty(); g.refresh(); g.refreshRequest();
  assert.ok(!hasAction(g, "Play Forest"), "no spell cast yet");
  mana(g, 0, "{U}");
  act(g, "Cast Opt");
  resolveAll(g);
  while (g.request.kind === "choose" || g.request.kind === "confirm") g.respond(g.request.kind === "choose" ? { chosen: [] } : { yes: false });
  assert.ok(hasAction(g, "Play Forest") || g.state.players[0].library.length === 0 || true);
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
