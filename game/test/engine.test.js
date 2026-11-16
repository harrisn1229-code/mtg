import { test } from "node:test";
import assert from "node:assert/strict";
import { createGame, parseManaCost, canPay, STEPS, costToString, spellCostFor } from "../engine.js";
import { card, compile, runGame, hand60Game, cmdGame, randomAnswer, makeRnd } from "./smoke.js";

// ------------------------------------------------------------------ scenario helpers
function setup({ p0 = {}, p1 = {}, commander = false, life, seed = 1, cmd0, cmd1, handSize = 0, first = 0 } = {}) {
  const lib = (names) => (names || Array(40).fill("Forest")).map(card);
  const g = createGame({
    players: [{ name: "Nate", deck: { commanders: cmd0 ? [card(cmd0)] : [], cards: lib(p0.library) } },
      { name: "AI", ai: true, deck: { commanders: cmd1 ? [card(cmd1)] : [], cards: lib(p1.library) } }],
    options: { seed, firstPlayer: first, commander, startingLife: life, handSize }, compile,
  });
  g.start();
  for (const [p, spec] of [[0, p0], [1, p1]]) {
    for (const n of spec.battlefield || []) place(g, p, "battlefield", n);
    for (const n of spec.hand || []) place(g, p, "hand", n);
    for (const n of spec.graveyard || []) place(g, p, "graveyard", n);
  }
  g.drainEvents();
  return g;
}
function place(g, p, zone, name, opts = {}) {
  const c = card(name);
  const o = g.newObj(c, g.compileCard(c), p, "library");
  g.moveObj(o, zone, { controller: p, quiet: true, tapped: !!opts.tapped });
  if (zone === "battlefield") o.sick = !!opts.sick;
  g.state.pendingTriggers.length = 0;
  g.refreshRequest();
  return o;
}
const byName = (g, name, zone = "battlefield", p) => Object.values(g.state.objects).filter((o) => o.c?.name === name && o.zone === zone && (p == null || o.owner === p));
const one = (g, name, zone, p) => { const l = byName(g, name, zone, p); assert.ok(l.length, `no ${name} in ${zone}`); return l[0]; };
function act(g, label) {
  const r = g.request;
  assert.equal(r.kind, "priority", `expected priority, got ${r.kind}: ${r.prompt}`);
  const i = r.actions.findIndex((a) => a.label.includes(label));
  assert.ok(i >= 0, `no action "${label}" in [${r.actions.map((a) => a.label).join(" | ")}]`);
  g.respond({ type: "act", index: i });
}
const hasAction = (g, label) => g.request.kind === "priority" && g.request.actions.some((a) => a.label.includes(label));
function choose(g, ...labels) {
  const r = g.request;
  assert.equal(r.kind, "choose", `expected choose, got ${r.kind}: ${r.prompt}`);
  const idx = labels.map((l) => { const i = r.options.findIndex((o, j) => (o.label.includes(l) || o.id === l)); assert.ok(i >= 0, `no option ${l} in ${r.options.map((o) => o.label)}`); return i; });
  g.respond({ chosen: idx });
}
/** Pass priority (only) until the stack is empty. */
function resolveAll(g, max = 50) {
  while (max-- > 0 && !g.over && g.request.kind === "priority" && g.state.stack.length) g.respond({ type: "pass" });
}
/** Answer pass/defaults until pred(request) holds. */
function until(g, pred, max = 2000) {
  while (max-- > 0 && !g.over && !pred(g.request, g.state)) { const r = g.request; g.respond(r.kind === "priority" ? { type: "pass" } : g.defaultAnswer(r)); }
  assert.ok(max > 0 || g.over, "until() ran out");
}
const atStep = (step, p = 0) => (r, st) => r && r.kind === "priority" && st.step === step && r.player === p && st.stack.length === 0;
const texts = (g) => g.drainEvents().map((e) => e.text);
const snap = (g) => JSON.stringify(g.state, (k, v) => (k === "def" || k === "copyDef" || k === "card" || k === "sourceSnap" || k === "ab" || k === "ctx" ? undefined : v));

// ------------------------------------------------------------------ basics
test("parseManaCost / costToString", () => {
  const c = parseManaCost("{2}{B}{B/P}{R/G}{X}{C}");
  assert.equal(c.generic, 2); assert.equal(c.B, 1); assert.equal(c.C, 1); assert.equal(c.x, 1);
  assert.deepEqual(c.phyrexian, ["B"]); assert.deepEqual(c.hybrid, [["R", "G"]]);
  assert.equal(costToString(parseManaCost("{3}{W}{W}")), "{3}{W}{W}");
  assert.equal(STEPS[0], "untap"); assert.equal(STEPS.at(-1), "cleanup");
});

test("turn structure: steps in order, first player skips first draw only in 2p non-commander", () => {
  const g = createGame({ players: [{ name: "Nate", deck: { commanders: [], cards: Array(40).fill(card("Forest")) } }, { name: "AI", ai: true, deck: { commanders: [], cards: Array(40).fill(card("Forest")) } }],
    options: { seed: 1, firstPlayer: 0, handSize: 0 }, compile });
  g.start();
  until(g, (r, st) => st.turn === 2 && st.step === "main1");
  const ev = g.drainEvents();
  const steps = ev.filter((e) => e.t === "step").map((e) => e.step);
  const t1 = steps.slice(0, steps.indexOf("cleanup") + 1);
  assert.deepEqual(t1, ["untap", "upkeep", "draw", "main1", "beginCombat", "declareAttackers", "main2", "end", "cleanup"]);
  assert.equal(g.state.players[0].hand.length, 0, "P0 skipped draw");
  assert.equal(g.state.players[1].hand.length, 1, "P1 drew");
  assert.equal(g.state.active, 1);
  const c = setup({ commander: true });
  until(c, atStep("main1"));
  assert.equal(c.state.players[0].hand.length, 1, "commander: first player draws");
  assert.equal(c.state.players[0].life, 40);
});

test("priority requests always issued, even when only passing is possible", () => {
  const g = setup();
  assert.equal(g.request.kind, "priority");
  assert.equal(g.state.step, "upkeep");
});

test("stack: response with Counterspell counters Lightning Bolt", () => {
  const g = setup({ p0: { battlefield: ["Mountain"], hand: ["Lightning Bolt"] }, p1: { battlefield: ["Island", "Island"], hand: ["Counterspell"] } });
  act(g, "Cast Lightning Bolt");
  choose(g, "AI");
  assert.equal(g.state.stack.length, 1);
  g.respond({ type: "pass" }); // P0 passes, P1 gets priority
  assert.equal(g.request.player, 1);
  act(g, "Cast Counterspell"); // single legal target is chosen automatically
  resolveAll(g);
  assert.equal(g.state.players[1].life, 20);
  const t = texts(g);
  assert.ok(t.some((x) => /Lightning Bolt is countered/.test(x)), t.join("\n"));
  assert.ok(t.some((x) => /AI casts Counterspell targeting Lightning Bolt/.test(x)));
});

test("burn resolves; damage and life events have readable text", () => {
  const g = setup({ p0: { battlefield: ["Mountain"], hand: ["Lightning Bolt"] } });
  act(g, "Cast Lightning Bolt"); choose(g, "AI"); resolveAll(g);
  assert.equal(g.state.players[1].life, 17);
  const t = texts(g);
  assert.ok(t.includes("Nate casts Lightning Bolt targeting AI"));
  assert.ok(t.includes("Lightning Bolt deals 3 damage to AI"));
});

test("combat: flying/reach, deathtouch, lifelink, first strike, double strike, trample, menace", () => {
  const g = setup({
    p0: { battlefield: ["Vampire Nighthawk", "White Knight", "Fencing Ace", "Kraul Swarm", "Goblin Heelcutter"] },
    p1: { battlefield: ["Giant Spider", "Grizzly Bears", "Grizzly Bears"] },
  });
  until(g, (r) => r.kind === "attackers");
  g.respond({ attacks: g.request.candidates.map((c) => ({ obj: c.obj, defender: "P1" })) });
  until(g, (r) => r.kind === "blockers");
  const req = g.request;
  const id = (n) => one(g, n).id;
  const [b1, b2] = byName(g, "Grizzly Bears").map((o) => o.id);
  const nh = id("Vampire Nighthawk");
  assert.ok(!req.candidates.find((c) => c.obj === b1).canBlock.includes(nh), "bears can't block a flyer");
  assert.ok(req.candidates.find((c) => c.obj === id("Giant Spider")).canBlock.includes(nh), "reach can");
  const before = snap(g);
  assert.throws(() => g.respond({ blocks: [{ obj: b1, attacker: id("Goblin Heelcutter") }] }), /menace/);
  assert.equal(snap(g), before, "state untouched by illegal answer");
  g.respond({ blocks: [{ obj: id("Giant Spider"), attacker: nh }, { obj: b1, attacker: id("White Knight") }, { obj: b2, attacker: id("Kraul Swarm") }] });
  until(g, atStep("main2"));
  assert.equal(g.state.players[1].life, 20 - 2 - 3 - 3, "double strike 2 + menace 3 + trample 3");
  assert.equal(g.state.players[0].life, 22, "lifelink");
  assert.equal(byName(g, "Giant Spider").length, 0, "deathtouch kills spider");
  assert.equal(byName(g, "Grizzly Bears").length, 0);
  assert.equal(byName(g, "White Knight").length, 1, "first strike survives");
  assert.equal(one(g, "Vampire Nighthawk").damage, 2);
});

test("defender can't attack; summoning sick can't attack; haste can", () => {
  const g = setup({ p0: { battlefield: ["Wall of Stone"] } });
  place(g, 0, "battlefield", "Grizzly Bears", { sick: true });
  place(g, 0, "battlefield", "Goblin Guide", { sick: true });
  until(g, (r) => r.kind === "attackers");
  assert.deepEqual(g.request.candidates.map((c) => g.state.objects[c.obj].c.name), ["Goblin Guide"]);
});

test("SBA: lethal damage, 0 toughness via -X, legend rule, indestructible", () => {
  const g = setup({ p0: { battlefield: ["Mountain", "Mountain", "Indestructible Golem"], hand: ["Lightning Bolt", "Lightning Bolt"] } });
  place(g, 0, "battlefield", "Drivnod, Carnage Dominus");
  place(g, 0, "battlefield", "Drivnod, Carnage Dominus");
  g.respond({ type: "pass" });
  assert.equal(g.request.kind, "choose");
  assert.match(g.request.prompt, /Legend rule/);
  g.respond({ chosen: [0] });
  assert.equal(byName(g, "Drivnod, Carnage Dominus").length, 1);
  until(g, atStep("main1"));
  act(g, "Cast Lightning Bolt"); choose(g, "Indestructible Golem"); resolveAll(g);
  assert.equal(byName(g, "Indestructible Golem").length, 1);
});

test("commander: cast from command zone, tax, command-zone return, 21 commander damage", () => {
  const g = setup({ commander: true, cmd0: "Commander Bear", p0: { battlefield: ["Forest", "Forest", "Forest", "Forest", "Forest"] } });
  until(g, atStep("main1"));
  const a = g.request.actions.find((x) => x.label.includes("Commander Bear"));
  assert.equal(a.cost, "{1}{G}{G}");
  act(g, "Cast Commander Bear from the command zone");
  resolveAll(g);
  const bear = one(g, "Commander Bear");
  assert.ok(bear.isCommander);
  g.destroy(bear);
  g.refreshRequest();
  g.respond({ type: "pass" }); // checkpoint runs the commander SBA choice
  assert.equal(g.request.kind, "confirm");
  assert.match(g.request.prompt, /command zone/);
  g.respond({ yes: true });
  assert.equal(bear.zone, "command");
  until(g, atStep("main2"));
  assert.equal(costToString(spellCostFor(g, 0, bear.id, "commander")), "{3}{G}{G}", "tax +2");

  const h = setup({ commander: true, cmd0: "Commander Dragon" });
  const dragon = one(h, "Commander Dragon", "command");
  h.moveObj(dragon, "battlefield", { controller: 0 });
  dragon.sick = false;
  h.state.pendingTriggers.length = 0;
  h.state.players[1].commanderDamage[dragon.id] = 17;
  until(h, (r) => r.kind === "attackers");
  h.respond({ attacks: [{ obj: dragon.id, defender: "P1" }] });
  until(h, () => h.over);
  assert.equal(h.winner, 0);
  assert.equal(h.state.players[1].life, 35);
  assert.ok(h.state.players[1].lost);
});

test("London mulligan: bottom N; first mulligan free in commander", () => {
  const g = createGame({ players: [{ name: "A", deck: { commanders: [], cards: Array(40).fill(card("Forest")) } }, { name: "B", deck: { commanders: [], cards: Array(40).fill(card("Forest")) } }], options: { seed: 2, firstPlayer: 0 }, compile });
  g.start();
  assert.equal(g.request.kind, "mulligan"); assert.equal(g.request.free, false);
  g.respond({ keep: false });
  assert.equal(g.request.kind, "mulligan"); assert.equal(g.request.mulligans, 1);
  g.respond({ keep: true });
  assert.equal(g.request.kind, "choose"); assert.equal(g.request.reason, "bottom"); assert.equal(g.request.min, 1);
  g.respond({ chosen: [0] });
  assert.equal(g.state.players[0].hand.length, 6);
  const c = createGame({ players: [{ name: "A", deck: { commanders: [], cards: Array(40).fill(card("Forest")) } }, { name: "B", deck: { commanders: [], cards: Array(40).fill(card("Forest")) } }], options: { seed: 2, firstPlayer: 0, commander: true }, compile });
  c.start();
  assert.equal(c.request.free, true);
  c.respond({ keep: false }); c.respond({ keep: true });
  assert.equal(c.state.players[0].hand.length, 7, "free mulligan");
});

test("auto-payment solver: colours, duals, sick dorks, Sol Ring, signets, identity, treasure last", () => {
  const g = setup({ p0: { battlefield: ["Rootbound Crag", "Forest", "Mountain"] } });
  assert.ok(canPay(g, 0, "{R}{G}{G}"));
  assert.ok(canPay(g, 0, "{R}{R}{G}"));
  assert.ok(!canPay(g, 0, "{R}{R}{R}"));
  assert.ok(!canPay(g, 0, "{4}"));
  const h = setup({ p0: { battlefield: ["Forest"] } });
  const elf = place(h, 0, "battlefield", "Llanowar Elves", { sick: true });
  assert.ok(!canPay(h, 0, "{G}{G}"), "summoning-sick dork not used");
  elf.sick = false;
  assert.ok(canPay(h, 0, "{G}{G}"));
  const s = setup({ p0: { battlefield: ["Sol Ring", "Forest", "Forest"] } });
  assert.ok(canPay(s, 0, "{4}")); assert.ok(!canPay(s, 0, "{5}"));
  const b = setup({ p0: { battlefield: ["Boros Signet", "Plains"] } });
  assert.ok(canPay(b, 0, "{R}{W}")); assert.ok(!canPay(b, 0, "{R}{W}{W}"));
  const c = setup({ commander: true, cmd0: "Commander Bear", p0: { battlefield: ["Command Tower"] } });
  assert.ok(canPay(c, 0, "{R}")); assert.ok(!canPay(c, 0, "{U}"));
  // treasure kept when a land suffices; pain land uses colourless for generic
  const t = setup({ p0: { battlefield: ["Forest", "Battlefield Forge", "Plains"], hand: ["Llanowar Elves", "Glorious Anthem"] } });
  t.createToken(0, "treasure", 1); t.refreshRequest();
  until(t, atStep("main1"));
  act(t, "Cast Llanowar Elves"); resolveAll(t);
  assert.equal(byName(t, "Treasure").length, 1, "treasure untouched");
  act(t, "Cast Glorious Anthem"); resolveAll(t); // {1}{W}{W}: Plains W, Forge must make W (pain), treasure generic... or Forge W
  assert.ok(t.state.players[0].life >= 19);
});

test("determinism: same seed + answers => identical event text; replay reproduces", () => {
  const play = (seed) => { const g = hand60Game(seed); const rnd = makeRnd(99); const log = []; g.start();
    while (!g.over) { const r = g.request; let a = randomAnswer(r, rnd); try { g.respond(a); } catch { g.respond(g.defaultAnswer(r)); } log.push(...g.drainEvents().map((e) => e.text)); }
    return { g, log }; };
  const A = play(5), B = play(5);
  assert.deepEqual(A.log, B.log);
  const C = hand60Game(5); C.start();
  const log = [...C.drainEvents().map((e) => e.text)];
  for (const a of A.g.answers) { C.respond(a); log.push(...C.drainEvents().map((e) => e.text)); }
  assert.deepEqual(log, A.log);
  assert.equal(C.winner, A.g.winner);
});

test("illegal answers are rejected without state change", () => {
  const g = setup({ p0: { battlefield: ["Mountain"], hand: ["Lightning Bolt"] } });
  const s0 = snap(g);
  assert.throws(() => g.respond({ type: "act", index: 999 }));
  assert.throws(() => g.respond({ type: "bogus" }));
  assert.throws(() => g.respond(null));
  assert.equal(snap(g), s0);
  act(g, "Cast Lightning Bolt");
  const s1 = snap(g);
  assert.throws(() => g.respond({ chosen: [0, 1] }));
  assert.throws(() => g.respond({ chosen: [7] }));
  assert.throws(() => g.respond({ chosen: [] }));
  assert.equal(snap(g), s1);
  const n = setup({ p0: { battlefield: ["Mountain", "Mountain", "Mountain"], hand: ["Blaze"] } });
  until(n, atStep("main1"));
  act(n, "Cast Blaze");
  assert.equal(n.request.kind, "number"); assert.equal(n.request.max, 2);
  assert.throws(() => n.respond({ value: 3 }));
  assert.throws(() => n.respond({ value: 1.5 }));
  n.respond({ value: 2 }); choose(n, "AI"); resolveAll(n);
  assert.equal(n.state.players[1].life, 18);
});

test("unknown ops / malformed IR degrade to manual events and play continues", () => {
  const g = setup({ p0: { battlefield: ["Forest", "Forest", "Forest", "Forest"], hand: ["Weird Op Bear", "Mystery Spell", "Big Mystery"] } });
  until(g, atStep("main1"));
  act(g, "Cast Weird Op Bear"); resolveAll(g);
  act(g, "Cast Mystery Spell"); resolveAll(g);
  act(g, "Cast Big Mystery"); resolveAll(g);
  const ev = g.drainEvents();
  assert.ok(ev.some((e) => e.t === "manual" && /Frobnicate/.test(e.text)));
  assert.ok(ev.some((e) => e.t === "manual" && /teleport/.test(e.text)));
  assert.equal(g.state.players[0].hand.length, 1, "draw after the unknown op still happened");
  const h = setup({ p0: { battlefield: ["Broken Trigger Bear"] } });
  until(h, atStep("main1"));
  act(h, "Broken Trigger Bear"); resolveAll(h);
  assert.ok(h.drainEvents().some((e) => e.t === "manual"));
  until(h, (r, st) => st.turn === 3);
  assert.equal(h.error, null);
});

test("triggers: Blood Artist on death, doubled by Drivnod; board wipe sees all deaths", () => {
  const g = setup({ p0: { battlefield: ["Blood Artist", "Drivnod, Carnage Dominus", "Grizzly Bears", "Swamp", "Swamp", "Swamp"], hand: ["Murder"] } });
  act(g, "Cast Murder"); choose(g, "Grizzly Bears");
  g.respond({ type: "pass" }); g.respond({ type: "pass" });
  choose(g, "AI"); choose(g, "AI"); // two triggers (doubled), each targets
  resolveAll(g);
  assert.equal(g.state.players[1].life, 18);
  assert.equal(g.state.players[0].life, 22);
  const w = setup({ p0: { battlefield: ["Blood Artist", "Plains", "Plains", "Plains", "Plains"], hand: ["Wrath of God"] }, p1: { battlefield: ["Grizzly Bears", "Hill Giant"] } });
  until(w, atStep("main1"));
  act(w, "Cast Wrath of God"); resolveAll(w);
  let n = 0;
  while (w.request.kind === "choose" && w.request.reason === "target") { choose(w, "AI"); n++; }
  assert.equal(n, 3, "Blood Artist triggers for itself and both others");
  resolveAll(w);
  assert.equal(w.state.players[1].life, 17);
});

test("ETB targeted trigger (Flametongue Kavu), attack trigger, dies->token, sac outlet", () => {
  const g = setup({ p0: { battlefield: ["Mountain", "Mountain", "Mountain", "Mountain", "Raging Attacker", "Carrier Thrall", "Viscera Seer"], hand: ["Flametongue Kavu"] }, p1: { battlefield: ["Hill Giant"] } });
  until(g, atStep("main1"));
  act(g, "Cast Flametongue Kavu"); resolveAll(g);
  choose(g, "Hill Giant"); resolveAll(g);
  assert.equal(byName(g, "Hill Giant").length, 0);
  act(g, "Viscera Seer:");
  choose(g, "Carrier Thrall");
  resolveAll(g);
  if (g.request.kind === "choose") g.respond({ chosen: [] }); // scry
  resolveAll(g);
  assert.equal(byName(g, "Eldrazi Scion").length, 1, "dies trigger made a Scion");
  until(g, (r) => r.kind === "attackers");
  g.respond({ attacks: [{ obj: one(g, "Raging Attacker").id, defender: "P1" }] });
  until(g, atStep("main2"));
  assert.equal(g.state.players[1].life, 20 - 1 - 3);
});

test("activated abilities: Treasure maker, manual mana ability with colour choice, Goblin Bombardment", () => {
  const g = setup({ p0: { battlefield: ["Treasure Maker", "Mountain", "Goblin Bombardment", "Grizzly Bears"] } });
  act(g, "Treasure Maker:"); resolveAll(g);
  assert.equal(byName(g, "Treasure").length, 1);
  const r = g.request;
  const i = r.actions.findIndex((a) => a.mana && a.label.startsWith("Treasure"));
  assert.ok(i >= 0);
  g.respond({ type: "act", index: i });
  choose(g, "Blue");
  assert.equal(g.state.players[0].mana.U, 1);
  act(g, "Goblin Bombardment:"); choose(g, "AI"); resolveAll(g);
  assert.equal(g.state.players[1].life, 19);
  assert.equal(byName(g, "Grizzly Bears").length, 0);
});

test("auras, equipment, anthem, cost reducer", () => {
  const g = setup({ p0: { battlefield: ["Forest", "Forest", "Forest", "Forest", "Plains", "Plains", "Plains", "Grizzly Bears", "Goreclaw"], hand: ["Rancor", "Bonesplitter", "Glorious Anthem", "Kraul Swarm"] } });
  until(g, atStep("main1"));
  const k = g.request.actions.find((a) => a.label === "Cast Kraul Swarm");
  assert.equal(k.cost, "{2}{G}", "Goreclaw reduces by 2");
  act(g, "Cast Rancor"); choose(g, "Grizzly Bears"); resolveAll(g);
  const bears = one(g, "Grizzly Bears");
  assert.equal(bears.c.power, 4); assert.ok(bears.c.keywords.trample);
  act(g, "Cast Bonesplitter"); resolveAll(g);
  act(g, "Equip Bonesplitter"); choose(g, "Grizzly Bears"); resolveAll(g);
  assert.equal(bears.c.power, 6);
  act(g, "Cast Glorious Anthem"); resolveAll(g);
  assert.equal(bears.c.power, 7); assert.equal(bears.c.toughness, 3);
});

test("modal spell, X spell, flashback, kicker, overload, additional sacrifice cost", () => {
  const g = setup({ p0: { battlefield: ["Mountain", "Plains"], hand: ["Boros Charm"] } });
  act(g, "Cast Boros Charm"); choose(g, "4 damage"); choose(g, "AI"); resolveAll(g);
  assert.equal(g.state.players[1].life, 16);
  const f = setup({ p0: { battlefield: ["Island", "Island", "Island"], graveyard: ["Think Twice"] } });
  act(f, "Cast Think Twice (flashback)"); resolveAll(f);
  assert.equal(one(f, "Think Twice", "exile").zone, "exile");
  assert.equal(f.state.players[0].hand.length, 1);
  const k = setup({ p0: { battlefield: Array(5).fill("Mountain"), hand: ["Burst Lightning"] } });
  act(k, "Cast Burst Lightning (kicked)"); choose(k, "AI"); resolveAll(k);
  assert.equal(k.state.players[1].life, 16);
  const o = setup({ p0: { battlefield: Array(6).fill("Mountain"), hand: ["Mizzium Mortars"] }, p1: { battlefield: ["Grizzly Bears", "Hill Giant"] } });
  until(o, atStep("main1"));
  act(o, "Cast Mizzium Mortars (overload)"); resolveAll(o);
  assert.equal(byName(o, "Grizzly Bears").length + byName(o, "Hill Giant").length, 0);
  const s = setup({ p0: { battlefield: ["Mountain", "Mountain", "Kraul Swarm"], hand: ["Fling"] } });
  act(s, "Cast Fling"); choose(s, "AI"); resolveAll(s);
  assert.equal(s.state.players[1].life, 15);
  assert.equal(byName(s, "Kraul Swarm").length, 0);
});

test("adventure: cast Stomp, card goes on an adventure, then cast the creature from exile", () => {
  const g = setup({ p0: { battlefield: Array(5).fill("Mountain"), hand: ["Bonecrusher Giant"] } });
  until(g, atStep("main1"));
  act(g, "Cast Stomp (adventure)"); choose(g, "AI"); resolveAll(g);
  assert.equal(g.state.players[1].life, 18);
  const o = one(g, "Bonecrusher Giant", "exile");
  assert.ok(o.onAdventure);
  act(g, "Cast Bonecrusher Giant"); resolveAll(g);
  assert.equal(one(g, "Bonecrusher Giant").c.power, 4);
});

test("planeswalker: loyalty abilities once per turn, can be attacked", () => {
  const g = setup({ p0: { battlefield: ["Test Walker"] }, p1: { battlefield: ["Goblin Guide"] } });
  const w = one(g, "Test Walker");
  w.counters.loyalty = 3; g.refreshRequest();
  until(g, atStep("main1"));
  act(g, "Test Walker: +1"); resolveAll(g);
  assert.equal(w.counters.loyalty, 4);
  assert.equal(g.state.players[1].life, 18);
  assert.ok(!hasAction(g, "Test Walker:"), "only one loyalty ability per turn");
  until(g, (r) => r.kind === "attackers" && r.player === 1);
  assert.ok(g.request.candidates[0].defenders.includes(w.id));
  g.respond({ attacks: [{ obj: g.request.candidates[0].obj, defender: w.id }] });
  until(g, (r, st) => st.step === "main2");
  assert.equal(w.counters.loyalty, 2);
});

test("the Ring tempts you: level, bearer, legendary, Nazgul counters, menace-like evasion", () => {
  const g = setup({ p0: { battlefield: ["Island", "Swamp", "Swamp", "Swamp", "Grizzly Bears"], hand: ["Birthday Escape", "Nazgul"] } });
  until(g, atStep("main1"));
  act(g, "Cast Birthday Escape"); resolveAll(g);
  const pl = g.state.players[0];
  assert.equal(pl.ring.level, 1);
  const bears = one(g, "Grizzly Bears");
  assert.equal(pl.ring.bearer, bears.id);
  assert.ok(bears.c.supertypes.includes("legendary"));
  act(g, "Cast Nazgul"); resolveAll(g);
  choose(g, "Nazgul"); // choose ring-bearer
  resolveAll(g);
  assert.equal(pl.ring.level, 2);
  assert.equal(one(g, "Nazgul").counters["+1/+1"], 1);
  assert.ok(g.drainEvents().some((e) => e.t === "ring" && /level 2/.test(e.text)));
});

test("edict, tutor, reanimation, undying, ward, hexproof, Mana Leak", () => {
  const e = setup({ p0: { battlefield: ["Swamp", "Swamp"], hand: ["Diabolic Edict"] }, p1: { battlefield: ["Grizzly Bears", "Hill Giant"] } });
  act(e, "Cast Diabolic Edict"); choose(e, "AI"); resolveAll(e);
  assert.equal(e.request.kind, "choose"); assert.equal(e.request.player, 1); assert.equal(e.request.reason, "sacrifice");
  choose(e, "Hill Giant");
  assert.equal(byName(e, "Hill Giant").length, 0);

  const t = setup({ p0: { battlefield: ["Swamp", "Swamp"], hand: ["Demonic Tutor"], library: [...Array(10).fill("Forest"), "Serra Angel"] } });
  until(t, atStep("main1"));
  act(t, "Cast Demonic Tutor"); resolveAll(t);
  choose(t, "Serra Angel");
  assert.equal(one(t, "Serra Angel", "hand").zone, "hand");

  const r = setup({ p0: { battlefield: ["Swamp"], hand: ["Reanimate"], graveyard: ["Serra Angel"] } });
  until(r, atStep("main1"));
  act(r, "Cast Reanimate"); resolveAll(r);
  assert.equal(byName(r, "Serra Angel").length, 1);
  assert.equal(r.state.players[0].life, 15);

  const u = setup({ p0: { battlefield: ["Swamp", "Swamp", "Swamp", "Undying Bear"], hand: ["Murder"] } });
  act(u, "Cast Murder"); resolveAll(u); // single legal target is auto-chosen
  const ub = one(u, "Undying Bear");
  assert.equal(ub.counters["+1/+1"], 1); assert.equal(ub.c.power, 3);

  const w = setup({ p0: { battlefield: ["Mountain"], hand: ["Lightning Bolt"] }, p1: { battlefield: ["Warded Raptor", "Hexproof Bear"] } });
  act(w, "Cast Lightning Bolt");
  assert.ok(!w.request.options.some((o) => o.label.includes("Hexproof Bear")), "hexproof can't be targeted");
  choose(w, "Warded Raptor");
  resolveAll(w); // ward trigger resolves; P0 can't pay {2} -> bolt countered
  assert.equal(byName(w, "Warded Raptor").length, 1);
  assert.ok(w.drainEvents().some((e) => /Lightning Bolt is countered/.test(e.text)));

  const m = setup({ p0: { battlefield: ["Mountain", "Mountain", "Mountain", "Mountain"], hand: ["Lightning Bolt"] }, p1: { battlefield: ["Island", "Island"], hand: ["Mana Leak"] } });
  act(m, "Cast Lightning Bolt"); choose(m, "AI"); m.respond({ type: "pass" });
  act(m, "Cast Mana Leak");
  resolveAll(m);
  assert.equal(m.request.kind, "confirm"); assert.equal(m.request.player, 0);
  m.respond({ yes: true });
  resolveAll(m);
  assert.equal(m.state.players[1].life, 17);
});

test("prowess and pump until end of turn wear off at cleanup", () => {
  const g = setup({ p0: { battlefield: ["Prowess Monk", "Mountain", "Forest"], hand: ["Shock", "Giant Growth"] } });
  act(g, "Cast Shock"); choose(g, "AI"); resolveAll(g);
  const m = one(g, "Prowess Monk");
  assert.equal(m.c.power, 2);
  act(g, "Cast Giant Growth"); resolveAll(g);
  assert.equal(m.c.power, 6);
  until(g, (r, st) => st.turn === 2);
  assert.equal(m.c.power, 1);
});

test("parser IR extensions: entersTapped.unlessPay, batched combat-damage trigger with {event:amount}", () => {
  const g = setup({ p0: { hand: ["Shock Foundry"], battlefield: ["Crasher", "Kraul Swarm"] } });
  until(g, atStep("main1"));
  act(g, "Play Shock Foundry");
  resolveAll(g);
  assert.equal(g.request.kind, "confirm");
  g.respond({ yes: true });
  assert.equal(one(g, "Shock Foundry").tapped, false);
  assert.equal(g.state.players[0].life, 18);
  until(g, (r) => r.kind === "attackers");
  g.respond({ attacks: g.request.candidates.map((c) => ({ obj: c.obj, defender: "P1" })) });
  until(g, atStep("main2"));
  const tok = byName(g, "Dinosaur Beast");
  assert.equal(tok.length, 1, "one trigger for the whole damage step");
  assert.equal(tok[0].c.power, 11);
});

test("concede ends the game and is recorded", () => {
  const g = setup();
  g.concede(0);
  assert.ok(g.over); assert.equal(g.winner, 1); assert.equal(g.request, null);
  assert.deepEqual(g.answers.at(-1), { concede: 0 });
});

test("random bot: hundreds of full games (60-card and commander) end without throwing", () => {
  const t0 = performance.now();
  let n = 0, cmdMs = 0;
  for (let i = 0; i < 300; i++) {
    const isCmd = i % 3 === 0;
    const g = isCmd ? cmdGame(1000 + i) : hand60Game(1000 + i, i % 2 ? ["RG", "WB"] : ["WB", "RG"]);
    const s = performance.now();
    runGame(g, i);
    if (isCmd) cmdMs += performance.now() - s;
    assert.ok(g.over, `game ${i} did not end`);
    assert.equal(g.error, null, `game ${i}: ${g.error && g.error.stack}`);
    n++;
  }
  const ms = performance.now() - t0;
  assert.equal(n, 300);
  assert.ok(cmdMs / 100 < 1000, `commander games too slow: ${(cmdMs / 100).toFixed(0)}ms`);
  console.log(`  300 games in ${ms.toFixed(0)}ms; commander avg ${(cmdMs / 100).toFixed(1)}ms`);
});
