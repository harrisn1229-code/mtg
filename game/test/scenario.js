// scenario.js — helpers for scenario tests built from REAL cards (helpers.cardByName) compiled through overrides.compileCard.
import assert from "node:assert/strict";
import { createGame } from "../engine.js";
import { compileCard } from "../overrides.js";
import { cardByName } from "./helpers.js";

export const filler = (name, n = 30) => Array.from({ length: n }, () => cardByName(name));
export function setup({ p0 = {}, p1 = {}, life = 40, seed = 1, commander = false, cmd0, cmd1, first = 0, ai1 = true } = {}) {
  const g = createGame({
    players: [
      { name: "Nate", deck: { commanders: cmd0 ? [cardByName(cmd0)] : [], cards: filler(p0.land || "Forest") } },
      { name: "AI", ai: ai1, deck: { commanders: cmd1 ? [cardByName(cmd1)] : [], cards: filler(p1.land || "Island") } },
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
export function place(g, p, zone, name, opts = {}) {
  const c = cardByName(name);
  const o = g.newObj(c, g.compileCard(c), p, "library");
  g.moveObj(o, zone, { controller: p, quiet: true, tapped: !!opts.tapped });
  if (zone === "battlefield") o.sick = !!opts.sick;
  g.state.pendingTriggers.length = 0;
  g.refreshRequest();
  return o;
}
export const byName = (g, name, zone = "battlefield", p) => Object.values(g.state.objects).filter((o) => o.c?.name === name && o.zone === zone && (p == null || o.owner === p));
export const one = (g, name, zone, p) => { const l = byName(g, name, zone, p); assert.ok(l.length, `no ${name} in ${zone}`); return l[0]; };
export const card = (g, name, zone) => { const l = Object.values(g.state.objects).filter((o) => o.def?.name === name && (zone == null || o.zone === zone)); assert.ok(l.length, `no card ${name}${zone ? " in " + zone : ""}`); return l[0]; };
export const mana = (g, p, s) => { g.addMana(p, s); g.refreshRequest(); };
export function act(g, label) {
  const r = g.request;
  assert.equal(r.kind, "priority", `expected priority, got ${r.kind}: ${r.prompt}`);
  const i = r.actions.findIndex((a) => a.label.includes(label));
  assert.ok(i >= 0, `no action "${label}" in [${r.actions.map((a) => a.label).join(" | ")}]`);
  g.respond({ type: "act", index: i });
}
export const hasAction = (g, label) => g.request.kind === "priority" && g.request.actions.some((a) => a.label.includes(label));
export function choose(g, ...labels) {
  const r = g.request;
  assert.equal(r.kind, "choose", `expected choose, got ${r.kind}: ${r.prompt}`);
  const idx = labels.map((l) => { const i = r.options.findIndex((o) => o.label.includes(l) || o.id === l); assert.ok(i >= 0, `no option ${l} in [${r.options.map((o) => o.label).join(" | ")}]`); return i; });
  g.respond({ chosen: idx });
}
export const chooseNone = (g) => { assert.equal(g.request.kind, "choose", g.request.prompt); g.respond({ chosen: [] }); };
export const confirm = (g, yes) => { assert.equal(g.request.kind, "confirm", `expected confirm, got ${g.request.kind}: ${g.request.prompt}`); g.respond({ yes }); };
export const number = (g, value) => { assert.equal(g.request.kind, "number", `expected number, got ${g.request.kind}: ${g.request.prompt}`); g.respond({ value }); };
export function resolveAll(g, max = 80) { while (max-- > 0 && !g.over && g.request.kind === "priority" && g.state.stack.length) g.respond({ type: "pass" }); }
export function kick(g) { if (g.request.kind === "priority") g.respond({ type: "pass" }); }
export function resolveUntilAsk(g, max = 80) { while (max-- > 0 && !g.over && g.request.kind === "priority" && g.state.stack.length) g.respond({ type: "pass" }); return g.request; }
export function until(g, pred, max = 4000) {
  while (max-- > 0 && !g.over && !pred(g.request, g.state)) { const r = g.request; g.respond(r.kind === "priority" ? { type: "pass" } : g.defaultAnswer(r)); }
  assert.ok(max > 0 || g.over, "until() ran out");
}
export const atStep = (step, p = 0) => (r, st) => r && r.kind === "priority" && st.step === step && r.player === p && st.stack.length === 0;
export const toMain = (g) => until(g, atStep("main1"));
export const texts = (g) => g.drainEvents().map((e) => e.text);
export const life = (g, p) => g.state.players[p].life;
export const zoneNames = (g, p, zone) => g.state.players[p][zone].map((id) => g.state.objects[id].c.name);
export const healthy = (g) => { assert.equal(g.error, null, g.error && g.error.stack); };
export { cardByName, compileCard, createGame };
