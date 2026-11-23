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
