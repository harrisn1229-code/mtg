// sim.js — AI-vs-AI simulation over the user's real Commander decks (SPEC §9).
//
//   node game/test/sim.js [--games N] [--seed S] [--difficulty easy|normal|hard] [--verbose]
//                         [--pair i,j] [--d0 lvl --d1 lvl] [--max-turns T] [--quiet]
//
// --games N     games per ordered deck pairing (default 2; 4 decks -> 16 pairings)
// --pair i,j    only that pairing (deck indices as listed in the report)
// --no-overrides  compile with the bare parser (shows which cards still need overrides via `manual` events)
// --verbose     print the full event log of the first game (or of the game given by --pair/--seed)
// Reports per-pairing wins, average turns, crashes (with seed + a command to reproduce), draws/timeouts,
// stalls (> 5000 requests in one turn), `manual` events by card/text, and AI decisions per second.
import { createGame } from "../engine.js";
import { decide } from "../ai.js";
import { compileCard } from "../overrides.js";
import { compileCard as parseOnly } from "../parser.js";
import { allDecks } from "./helpers.js";

export function playGame({ deckA, deckB, seed, d0 = "normal", d1 = "normal", maxTurns = 60, log = null, maxDecisions = 200000, trace = false, compile = compileCard }) {
  const game = createGame({
    players: [{ name: deckA.name.split(" — ")[0] + " (A)", deck: deckA, ai: true }, { name: deckB.name.split(" — ")[0] + " (B)", deck: deckB, ai: true }],
    options: { seed, commander: true, maxTurns },
    compile,
  });
  const res = { seed, winner: null, turns: 0, crash: null, stall: false, timeout: false, decisions: 0, aiMs: 0, manual: [], reason: null, illegal: 0 };
  const diff = [d0, d1];
  const sink = (evs) => {
    for (const e of evs) {
      if (e.t === "manual") res.manual.push(e.text);
      if (e.t === "lose" && !res.reason) res.reason = e.reason;
      if (e.t === "win" && !res.reason) res.reason = e.reason;
      if (log) log(e);
    }
  };
  try {
    game.start();
    sink(game.drainEvents());
    let turn = -1, perTurn = 0;
    while (!game.over && game.request) {
      const req = game.request;
      if (game.state.turn !== turn) { turn = game.state.turn; perTurn = 0; }
      if (++perTurn > 5000) { res.stall = true; break; }
      if (res.decisions >= maxDecisions) { res.stall = true; break; }
      const t0 = performance.now();
      const ans = decide(game, req, { difficulty: diff[req.player] });
      res.aiMs += performance.now() - t0;
      res.decisions++;
      if (log && trace) log({ t: "trace", text: describeDecision(game, req, ans) });
      try { game.respond(ans); }
      catch (e) {
        res.illegal++;
        if (res.illegal > 20) throw new Error(`AI keeps answering illegally: ${e.message}`);
        game.respond(game.defaultAnswer(req));
      }
      sink(game.drainEvents());
    }
  } catch (e) {
    res.crash = e;
  }
  if (game.error && !res.crash) res.crash = game.error;
  res.turns = game.state.turn;
  res.winner = game.winner;
  if (game.over && game.winner == null && /turn limit/.test(res.reason || "")) res.timeout = true;
  res.game = game;
  return res;
}

export function runSim({ games = 2, seed = 1, difficulty = "normal", d0, d1, pair = null, maxTurns = 60, verbose = false, quiet = false, decks = null, trace = false, noOverrides = false } = {}) {
  decks = decks || allDecks();
  const pairs = [];
  if (pair) pairs.push(pair);
  else for (let i = 0; i < decks.length; i++) for (let j = 0; j < decks.length; j++) pairs.push([i, j]);
  const out = { pairs: [], crashes: [], stalls: [], timeouts: [], manual: new Map(), decisions: 0, aiMs: 0, games: 0, turns: 0, byDeck: decks.map((d) => ({ name: d.name, games: 0, wins: 0, draws: 0 })), reasons: new Map() };
  let printed = false;
  for (const [i, j] of pairs) {
    const row = { i, j, games: 0, winsA: 0, winsB: 0, draws: 0, turns: 0 };
    for (let k = 0; k < games; k++) {
      const s = seed + k * 7919 + i * 131 + j * 17;
      const lines = [];
      const wantLog = verbose && !printed;
      const r = playGame({ deckA: decks[i], deckB: decks[j], seed: s, d0: d0 || difficulty, d1: d1 || difficulty, maxTurns, compile: noOverrides ? parseOnly : compileCard,
        trace, log: wantLog ? (e) => { if (!e.silent) { const l = fmtEvent(e); if (l != null) lines.push(l); } } : null });
      if (wantLog) { printed = true; console.log(lines.join("\n")); console.log("-".repeat(80)); }
      row.games++; out.games++;
      row.turns += r.turns; out.turns += r.turns;
      out.decisions += r.decisions; out.aiMs += r.aiMs;
      out.byDeck[i].games++; out.byDeck[j].games++;
      if (r.winner === 0) { row.winsA++; out.byDeck[i].wins++; }
      else if (r.winner === 1) { row.winsB++; out.byDeck[j].wins++; }
      else { row.draws++; out.byDeck[i].draws++; out.byDeck[j].draws++; }
      const reason = r.reason || (r.stall ? "stall" : "?");
      out.reasons.set(reason.replace(/\d+ combat damage from .*/, "21 commander damage"), (out.reasons.get(reason.replace(/\d+ combat damage from .*/, "21 commander damage")) || 0) + 1);
      const repro = `node game/test/sim.js --pair ${i},${j} --seed ${s} --games 1 --d0 ${d0 || difficulty} --d1 ${d1 || difficulty} --verbose`;
      if (r.crash) out.crashes.push({ i, j, seed: s, err: r.crash, repro });
      if (r.stall) out.stalls.push({ i, j, seed: s, turn: r.turns, repro });
      if (r.timeout) out.timeouts.push({ i, j, seed: s, repro });
      const seen = new Set();
      for (const t of r.manual) {
        const key = t.replace(/\(\d+\)/g, "").slice(0, 140);
        const m = out.manual.get(key) || { n: 0, games: 0 };
        m.n++;
        if (!seen.has(key)) { m.games++; seen.add(key); }
        out.manual.set(key, m);
      }
    }
    out.pairs.push(row);
  }
  if (!quiet) report(out, decks);
  return out;
}

/** One-line summary of an AI decision (for --trace). */
export function describeDecision(game, req, ans) {
  const nm = (id) => (id && /^P\d$/.test(id) ? game.state.players[+id.slice(1)].name : game.state.objects[id]?.c?.name || id);
  const who = `P${req.player}`;
  switch (req.kind) {
    case "priority": return ans.type === "pass" ? null : `${who} act: ${req.actions[ans.index]?.label}`;
    case "choose": return `${who} choose(${req.reason}) "${req.prompt}" -> [${ans.chosen.map((i) => req.options[i]?.label).join(", ")}] of ${req.options.length}`;
    case "confirm": return `${who} confirm "${req.prompt}" -> ${ans.yes}`;
    case "number": return `${who} number "${req.prompt}" -> ${ans.value}`;
    case "attackers": return `${who} attacks: ${ans.attacks.map((a) => `${nm(a.obj)}->${nm(a.defender)}`).join(", ") || "none"} (of ${req.candidates.length})`;
    case "blockers": return `${who} blocks: ${ans.blocks.map((b) => `${nm(b.obj)}->${nm(b.attacker)}`).join(", ") || "none"} (of ${req.candidates.length})`;
    case "mulligan": return `${who} mulligan keep=${ans.keep}`;
    default: return null;
  }
}

function fmtEvent(e) {
  if (e.t === "trace") return e.text ? `      > ${e.text}` : null;
  if (e.t === "turn") return `\n=== ${e.text} ===`;
  if (e.t === "step") return `  -- ${e.text}`;
  return `    ${e.t === "manual" ? "[MANUAL] " : ""}${e.text}`;
}

function report(out, decks) {
  const short = (n) => n.split(" — ")[0].slice(0, 22);
  console.log(`\nDecks: ${decks.map((d, i) => `${i}=${short(d.name)}`).join("  ")}`);
  console.log("\nPairing (A vs B)                                 games  A-wins  B-wins  draws  avgTurns");
  for (const r of out.pairs) {
    console.log(`${`${r.i}:${short(decks[r.i].name)} vs ${r.j}:${short(decks[r.j].name)}`.padEnd(49)}${String(r.games).padStart(5)}${String(r.winsA).padStart(8)}${String(r.winsB).padStart(8)}${String(r.draws).padStart(7)}${(r.turns / Math.max(1, r.games)).toFixed(1).padStart(10)}`);
  }
  console.log("\nPer deck: " + out.byDeck.map((d) => `${short(d.name)} ${d.wins}/${d.games} (${Math.round((100 * d.wins) / Math.max(1, d.games))}%)`).join(" | "));
  console.log(`Games ${out.games}, avg turns ${(out.turns / Math.max(1, out.games)).toFixed(1)}, decisions ${out.decisions}, ${(out.decisions / Math.max(1, out.aiMs / 1000)).toFixed(0)} decisions/sec (AI time ${(out.aiMs / Math.max(1, out.decisions)).toFixed(2)} ms/decision)`);
  console.log("End reasons: " + [...out.reasons].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(", "));
  console.log(`Crashes: ${out.crashes.length}  Stalls: ${out.stalls.length}  Timeouts (turn cap): ${out.timeouts.length}`);
  for (const c of out.crashes.slice(0, 10)) console.log(`  CRASH ${c.i} vs ${c.j} seed ${c.seed}: ${c.err && (c.err.stack || c.err.message || c.err).toString().split("\n").slice(0, 4).join(" | ")}\n    repro: ${c.repro}`);
  for (const c of out.stalls.slice(0, 5)) console.log(`  STALL ${c.i} vs ${c.j} seed ${c.seed} turn ${c.turn}\n    repro: ${c.repro}`);
  for (const c of out.timeouts.slice(0, 5)) console.log(`  TIMEOUT ${c.i} vs ${c.j} seed ${c.seed}\n    repro: ${c.repro}`);
  const man = [...out.manual].sort((a, b) => b[1].games - a[1].games || b[1].n - a[1].n);
  console.log(`\nTop manual events (games fired / total) — ${man.length} distinct:`);
  for (const [k, v] of man.slice(0, 30)) console.log(`  ${String(v.games).padStart(4)} / ${String(v.n).padStart(4)}  ${k}`);
}

function argv(name, def) {
  const a = process.argv.slice(2);
  const i = a.indexOf(name);
  return i >= 0 && i + 1 < a.length ? a[i + 1] : def;
}

if (typeof process !== "undefined" && process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const pair = argv("--pair", null);
  runSim({
    games: +argv("--games", 2), seed: +argv("--seed", 1), difficulty: argv("--difficulty", "normal"),
    d0: argv("--d0", null), d1: argv("--d1", null), maxTurns: +argv("--max-turns", 60),
    pair: pair ? pair.split(",").map(Number) : null, verbose: process.argv.includes("--verbose") || process.argv.includes("--trace"), trace: process.argv.includes("--trace"), quiet: process.argv.includes("--quiet"), noOverrides: process.argv.includes("--no-overrides"),
  });
}
