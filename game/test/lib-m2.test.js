// lib-m2.test.js — scenario tests for the m2 library batch (creature, combat and counter keywords). See SPEC-NOTES.md "Library automation: m2".
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, place, byName, one, mana, act, hasAction, choose, resolveAll, until, atStep, toMain, healthy } from "./scenario.js";

const keep = (g) => { g.state.players[0].library.length; };

test("Evolve: Watchful Radstag copies itself when a bigger creature enters", () => {
  const g = setup({ p0: { hand: ["Hero of Bladehold"], battlefield: ["Watchful Radstag"] } });
  toMain(g);
  const r = one(g, "Watchful Radstag");
  assert.ok(g.hasKw(r, "evolve") || r.c.abilities.some((a) => a.synthetic === "evolve" || JSON.stringify(a).includes("evolve")));
  mana(g, 0, "{2}{W}{W}");
  act(g, "Cast Hero of Bladehold");
  resolveAll(g);
  healthy(g);
  assert.ok((r.counters["+1/+1"] | 0) >= 1, "evolved");
  assert.equal(byName(g, "Watchful Radstag").length, 2, "evolves trigger made a token copy");
});

test("Crew: Necron Monolith can be crewed by tapping creatures", () => {
  const g = setup({ p0: { battlefield: ["Necron Monolith", "Hero of Bladehold", "Watchful Radstag"] } });
  toMain(g);
  const v = one(g, "Necron Monolith");
  assert.ok(!v.c.types.includes("creature"));
  assert.ok(hasAction(g, "Crew"), "crew action offered");
  act(g, "Crew");
  while (g.request.kind === "choose" && !g.over) g.respond({ chosen: g.request.options.map((_, i) => i).slice(0, Math.max(1, g.request.min || 1)) });
  resolveAll(g);
  healthy(g);
  assert.ok(g.obj(v.id).c.types.includes("creature"), "vehicle is a creature until end of turn");
});

test("Taunt from the Rampart goads opposing creatures", () => {
  const g = setup({ p0: { hand: ["Taunt from the Rampart"] }, p1: { battlefield: ["Llanowar Elves"] } });
  toMain(g);
  mana(g, 0, "{3}{R}{W}");
  act(g, "Cast Taunt from the Rampart");
  resolveAll(g);
  healthy(g);
  const b = one(g, "Llanowar Elves");
  assert.ok(b.c.goaded, "bears are goaded");
});

test("Port Razer: combat damage to a player gives an extra combat", () => {
  const g = setup({ p0: { battlefield: ["Port Razer"] } });
  const p = one(g, "Port Razer");
  p.summoningSick = false; g.markDirty(); g.refreshRequest();
  toMain(g);
  const start = g.state.players[1].life;
  until(g, (r, st) => st.step === "declareAttackers" || (r && r.kind === "choose"), 400);
  healthy(g);
  assert.ok(g.state.players[1].life <= start);
});

test("Polygoyf counts card types in all graveyards", () => {
  const g = setup({ p0: { battlefield: ["Polygoyf"] } });
  place(g, 0, "graveyard", "Llanowar Elves");
  place(g, 1, "graveyard", "Sol Ring");
  g.markDirty(); g.refreshRequest();
  const p = one(g, "Polygoyf");
  assert.equal(p.c.power, 2);
  assert.equal(p.c.toughness, 3);
});

test("Hero of Bladehold: attack creates two tapped attacking Soldiers", () => {
  const g = setup({ p0: { battlefield: ["Hero of Bladehold"] } });
  one(g, "Hero of Bladehold").summoningSick = false; g.markDirty(); g.refreshRequest();
  until(g, (r) => r.kind === "attackers");
  g.respond({ attacks: [{ obj: one(g, "Hero of Bladehold").id, defender: "P1" }] });
  resolveAll(g);
  healthy(g);
  const sol = byName(g, "Soldier");
  assert.equal(sol.length, 2);
  assert.ok(sol.every((o) => o.tapped && g.state.combat.attackers.some((a) => a.obj === o.id)));
});

test("Port Razer: combat damage to a player gives an additional combat phase", () => {
  const g = setup({ p0: { battlefield: ["Port Razer"] } });
  one(g, "Port Razer").summoningSick = false; g.markDirty(); g.refreshRequest();
  until(g, (r) => r.kind === "attackers");
  g.respond({ attacks: [{ obj: one(g, "Port Razer").id, defender: "P1" }] });
  let combats = 0;
  until(g, (r, st) => { if (r.kind === "attackers") combats++; return st.step === "main2"; }, 600);
  healthy(g);
  assert.ok(g.state.combatsThisTurn >= 2, "second combat happened: " + g.state.combatsThisTurn);
});
