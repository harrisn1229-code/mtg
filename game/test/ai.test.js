// ai.test.js — targeted AI scenarios + legality/determinism sweeps over real-deck positions + a reduced simulation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGame } from "../engine.js";
import { decide, mood } from "../ai.js";
import { compileCard } from "../overrides.js";
import { card, compile, randomAnswer, makeRnd } from "./smoke.js";
import { allDecks } from "./helpers.js";
import { runSim } from "./sim.js";

function setup({ p0 = {}, p1 = {}, life0 = 20, life1 = 20, first = 0 } = {}) {
  const lib = (names) => (names || Array(40).fill("Forest")).map(card);
  const g = createGame({
    players: [{ name: "AI0", ai: true, deck: { commanders: [], cards: lib(p0.library) } }, { name: "AI1", ai: true, deck: { commanders: [], cards: lib(p1.library) } }],
    options: { seed: 3, firstPlayer: first, commander: false, handSize: 0 }, compile,
  });
  g.start();
  g.state.players[0].life = life0; g.state.players[1].life = life1;
  for (const [p, spec] of [[0, p0], [1, p1]]) {
    for (const n of spec.battlefield || []) place(g, p, "battlefield", n);
    for (const n of spec.hand || []) place(g, p, "hand", n);
  }
  g.drainEvents();
  return g;
}
function place(g, p, zone, name) {
  const c = card(name);
  const o = g.newObj(c, g.compileCard(c), p, "library");
  g.moveObj(o, zone, { controller: p, quiet: true });
  if (zone === "battlefield") o.sick = false;
  g.state.pendingTriggers.length = 0;
  g.refreshRequest();
  return o;
}
/** Let the AI answer every request until pred holds. */
function aiUntil(g, pred, opts = {}, max = 3000) {
  while (max-- > 0 && !g.over && !pred(g.request, g.state)) g.respond(decide(g, g.request, opts));
  assert.ok(max > 0 || g.over, "aiUntil ran out");
}

test("AI takes lethal: swings with everything when the opponent can't survive", () => {
  const g = setup({ p0: { battlefield: ["Hill Giant", "Hill Giant", "Grizzly Bears"] }, p1: { battlefield: ["Grizzly Bears"] }, life1: 5 });
  aiUntil(g, (r) => r.kind === "attackers" && r.player === 0);
  const a = decide(g, g.request, { difficulty: "normal" });
  assert.equal(a.attacks.length, 3, "all-in: 3+3+2 with one blocker still deals >= 5");
  g.respond(a);
  aiUntil(g, (r, st) => g.over || st.step === "main2");
  assert.ok(g.over && g.winner === 0, "AI0 won by combat");
});

test("AI doesn't suicide a small creature into a bigger untapped blocker", () => {
  const g = setup({ p0: { battlefield: ["Grizzly Bears"] }, p1: { battlefield: ["Hill Giant"] }, life1: 20 });
  aiUntil(g, (r) => r.kind === "attackers" && r.player === 0);
  for (const difficulty of ["normal", "hard"]) assert.equal(decide(g, g.request, { difficulty }).attacks.length, 0, difficulty);
});

test("AI blocks to survive (and doesn't chump when it's safe)", () => {
  // AI1 at 6 life faces 5/5 trample + 3/3; Wall of Stone 0/8 must block the trampler
  const g = setup({ p0: { battlefield: ["Kraul Swarm", "Hill Giant"] }, p1: { battlefield: ["Wall of Stone"] }, life1: 6 });
  aiUntil(g, (r) => r.kind === "attackers" && r.player === 0);
  g.respond({ attacks: g.request.candidates.map((c) => ({ obj: c.obj, defender: "P1" })) });
  aiUntil(g, (r) => r.kind === "blockers" && r.player === 1);
  const b = decide(g, g.request, { difficulty: "normal" });
  assert.equal(b.blocks.length, 1);
  assert.equal(g.state.objects[b.blocks[0].attacker].c.name, "Kraul Swarm");
  g.respond(b);
  aiUntil(g, (r, st) => g.over || st.step === "main2");
  assert.ok(!g.over && g.state.players[1].life > 0, "survived");

  const h = setup({ p0: { battlefield: ["Grizzly Bears"] }, p1: { battlefield: ["Llanowar Elves"] }, life1: 20 });
  aiUntil(h, (r) => r.kind === "attackers" && r.player === 0);
  h.respond({ attacks: [{ obj: h.request.candidates[0].obj, defender: "P1" }] });
  aiUntil(h, (r) => r.kind === "blockers");
  assert.equal(decide(h, h.request, { difficulty: "normal" }).blocks.length, 0, "no chump at 20 life");
});

test("AI removal hits the biggest threat; doesn't fire removal with only bad targets", () => {
  const g = setup({ p0: { hand: ["Murder"], battlefield: ["Swamp", "Swamp", "Swamp", "Grizzly Bears"] }, p1: { battlefield: ["Grizzly Bears", "Serra Angel"] } });
  aiUntil(g, (r) => r.kind === "choose" && /Murder/.test(r.prompt));
  const r = g.request;
  const a = decide(g, r, { difficulty: "normal" });
  assert.equal(r.options[a.chosen[0]].label.split(" ")[0], "Serra");

  const h = setup({ p0: { hand: ["Murder"], battlefield: ["Swamp", "Swamp", "Swamp", "Grizzly Bears"] }, p1: {} });
  aiUntil(h, (r, st) => st.turn === 4);
  assert.ok(h.state.players[0].hand.some((id) => h.state.objects[id].c.name === "Murder"), "Murder kept: only its own creature to kill");
});

test("AI counters a big spell but lets a small one resolve (normal)", () => {
  const g = setup({ p0: { hand: ["Counterspell"], battlefield: ["Island", "Island"] }, p1: { hand: ["Serra Angel", "Llanowar Elves"], battlefield: ["Plains", "Plains", "Plains", "Plains", "Plains", "Forest"] }, first: 1 });
  aiUntil(g, (r, st) => st.stack.length && r.kind === "priority" && r.player === 0);
  const top = g.state.objects[g.state.stack.at(-1)];
  const a = decide(g, g.request, { difficulty: "normal" });
  if (top.c.name === "Serra Angel") assert.equal(a.type, "act");
  else assert.equal(a.type, "pass");
});

test("decide() is pure: never calls game.rng, never mutates state, always legal — across real-deck positions", () => {
  const decks = allDecks();
  const kinds = new Set();
  let checked = 0;
  for (let gi = 0; gi < 4; gi++) {
    const g = createGame({ players: [{ name: "A", deck: decks[gi], ai: true }, { name: "B", deck: decks[(gi + 1) % 4], ai: true }], options: { seed: 50 + gi, commander: true, maxTurns: 40 }, compile: compileCard });
    g.start();
    const rnd = makeRnd(9 + gi);
    let rngCalls = 0;
    const realRng = g.rng;
    let n = 0;
    while (!g.over && g.request && n++ < 2500) {
      const req = g.request;
      kinds.add(req.kind);
      if (n % 3 === 0 || req.kind !== "priority") {
        const before = JSON.stringify(g.state, (k, v) => (["def", "copyDef", "card", "sourceSnap", "ab", "ctx", "lki", "c"].includes(k) ? undefined : v));
        g.rng = () => { rngCalls++; return realRng(); };
        for (const difficulty of ["easy", "normal", "hard"]) {
          const ans = decide(g, req, { difficulty });
          assert.doesNotThrow(() => g.validate(req, ans), `${difficulty} ${req.kind}: ${JSON.stringify(ans)}`);
          checked++;
        }
        g.rng = realRng;
        assert.equal(rngCalls, 0, "AI called game.rng");
        const after = JSON.stringify(g.state, (k, v) => (["def", "copyDef", "card", "sourceSnap", "ab", "ctx", "lki", "c"].includes(k) ? undefined : v));
        assert.equal(after, before, `AI mutated state on ${req.kind}`);
      }
      // drive the game with a mix of AI and random answers to reach odd positions
      let ans = rnd() < 0.5 ? decide(g, req, { difficulty: "normal" }) : randomAnswer(req, rnd);
      try { g.respond(ans); } catch { g.respond(g.defaultAnswer(req)); }
      g.drainEvents();
    }
    assert.equal(g.error, null);
    assert.ok(["winning", "losing", "even"].includes(mood(g, 0)));
  }
  for (const k of ["mulligan", "priority", "choose", "confirm", "attackers", "blockers"]) assert.ok(kinds.has(k), "saw " + k);
  assert.ok(checked > 300, "checked " + checked);
});

test("reduced simulation: every real-deck pairing finishes without crashes or stalls", () => {
  const r = runSim({ games: 1, seed: 4242, quiet: true });
  assert.equal(r.crashes.length, 0, r.crashes.map((c) => c.repro + " " + c.err).join("\n"));
  assert.equal(r.stalls.length, 0);
  assert.equal(r.games, 16);
  assert.ok(r.turns / r.games < 40, "games end in a sensible number of turns");
});
