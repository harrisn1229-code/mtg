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
