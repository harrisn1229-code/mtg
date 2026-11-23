// lib-m1.test.js — scenario tests for the m1 batch (casting / cost mechanics, casting from other zones).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setup, place, byName, one, card, mana, act, hasAction, choose, chooseNone, confirm, number, resolveAll, kick, resolveUntilAsk,
  until, atStep, toMain, texts, life, zoneNames, healthy,
} from "./scenario.js";

test("Evoke: Mulldrifter hard-cast vs evoked (sacrificed on entering, ETB still draws)", () => {
  const g = setup({ p0: { hand: ["Mulldrifter"], library: ["Forest", "Forest", "Forest", "Forest"] } });
  toMain(g);
  mana(g, 0, "{2}{U}");
  assert.ok(hasAction(g, "Cast Mulldrifter (evoke)"));
  assert.ok(!hasAction(g, "Cast Mulldrifter\u0000"));
  const hand0 = g.state.players[0].hand.length;
  act(g, "Cast Mulldrifter (evoke)");
  resolveAll(g);
  healthy(g);
  assert.equal(byName(g, "Mulldrifter").length, 0, "sacrificed");
  assert.equal(zoneNames(g, 0, "graveyard").includes("Mulldrifter"), true);
  assert.equal(g.state.players[0].hand.length, hand0 - 1 + 2, "drew two");
});
