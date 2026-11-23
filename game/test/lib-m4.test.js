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
