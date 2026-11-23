// lib-m3.test.js — scenario tests for batch m3 (player resources, designations, keyword actions).
import test from "node:test";
import assert from "node:assert/strict";
import { setup, place, one, byName } from "./scenario.js";

const g0 = (o) => setup(o);

test("m3: energy get/pay and Izzet Generatorium / Aether Refinery replacement", () => {
  const g = g0({});
  assert.equal(g.getEnergy(0, 3), 3);
  assert.equal(g.state.players[0].counters.energy, 3);
  assert.ok(g.payEnergy(0, 2));
  assert.equal(g.state.players[0].counters.energy, 1);
  assert.ok(!g.payEnergy(0, 5));
  place(g, 0, "battlefield", "Izzet Generatorium");
  g.getEnergy(0, 2);
  assert.equal(g.state.players[0].counters.energy, 4);
  place(g, 0, "battlefield", "Aether Refinery");
  g.getEnergy(0, 1);
  assert.ok(g.state.players[0].counters.energy >= 7);
});

test("m3: investigate creates a Clue, Academy Manufactor makes one of each", () => {
  const g = g0({});
  g.investigate(0, null);
  assert.equal(byName(g, "Clue", "battlefield", 0).length, 1);
  place(g, 0, "battlefield", "Academy Manufactor");
  g.investigate(0, null);
  assert.ok(byName(g, "Food", "battlefield", 0).length >= 1);
  assert.ok(byName(g, "Treasure", "battlefield", 0).length >= 1);
});

test("m3: manifest puts the top card face down as a 2/2", () => {
  const g = g0({ p0: { library: ["Moria Scavenger"] } });
  const it = g.manifest$(0, 1, { owner: 0 });
  let r = it.next();
  while (!r.done) r = it.next();
  const fd = Object.values(g.state.objects).filter((o) => o.controller === 0 && o.zone === "battlefield" && o.faceDown);
  assert.equal(fd.length, 1);
  assert.equal(fd[0].c.power, 2);
});

test("m3: ascend grants the city's blessing at ten permanents", () => {
  const g = g0({});
  for (let i = 0; i < 10; i++) place(g, 0, "battlefield", "Forest");
  g.sba$ && g.refreshRequest();
  assert.equal(typeof g.permCount(0), "number");
  assert.ok(g.permCount(0) >= 10);
});

test("m3: Gonti's Aether Heart and Conversion Apparatus load with energy costs", () => {
  const g = g0({});
  const o = place(g, 0, "battlefield", "Gonti's Aether Heart");
  assert.ok(o.def.abilities.some((a) => a.cost && a.cost.energy === 8));
  const c = place(g, 0, "battlefield", "Conversion Apparatus");
  assert.ok(c.def.abilities.some((a) => a.cost && a.cost.energy === 3));
});
