// node game/test/lib-sim.mjs [batch] [--games N] [--seed S] [--deck substring]
// AI-vs-AI games with deck-library decks. With a batch, only decks that contain one of the batch's cards play
// (each against a rotating opponent). Reports crashes (with a repro line), stalls, timeouts, and `manual` events by card.
import { libraryDecks, libraryBatches, loadLibrary } from "./helpers.js";
import { playGame } from "./sim.js";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const batch = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const games = +opt("--games", 1), seed0 = +opt("--seed", 1), deckSub = opt("--deck", null);
const lib = loadLibrary();
const names = batch ? new Set(libraryBatches()[batch] || []) : null;
const all = libraryDecks();
const has = (d) => d.cards.concat(d.commanders).some((c) => names.has(c.name));
const players = all.filter((d) => (!names || has(d)) && (!deckSub || d.name.toLowerCase().includes(deckSub.toLowerCase())));
let crashes = 0, stalls = 0, timeouts = 0, n = 0;
const manual = new Map();
const t0 = Date.now();
players.forEach((a, i) => {
  for (let k = 0; k < games; k++) {
    const b = all[(all.indexOf(a) * 7 + 3 + k * 11) % all.length];
    const seed = seed0 + i * 101 + k;
    const r = playGame({ deckA: a, deckB: b, seed, maxTurns: 40 });
    n++;
    if (r.crash) { crashes++; console.log(`CRASH ${a.name} vs ${b.name} seed ${seed}: ${String(r.crash.stack || r.crash).split("\n").slice(0, 4).join(" | ")}`); }
    if (r.stall) { stalls++; console.log(`STALL ${a.name} vs ${b.name} seed ${seed}`); }
    if (r.timeout) timeouts++;
    for (const m of r.manual) { const key = String(m).slice(0, 110); manual.set(key, (manual.get(key) || 0) + 1); }
  }
});
console.log(`\n${n} games, ${crashes} crashes, ${stalls} stalls, ${timeouts} timeouts, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (manual.size) { console.log("manual (not automated) events:"); [...manual].sort((x, y) => y[1] - x[1]).slice(0, 40).forEach(([t, c]) => console.log(`  ${c}× ${t}`)); }
if (crashes) process.exitCode = 1;
