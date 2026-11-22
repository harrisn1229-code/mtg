// node game/test/lib-flagged.mjs [batch] [--all] [--short]
// Lists deck-library cards that are not fully automated (unparsed text left), with their oracle text and unparsed lines.
//   batch     only cards assigned to that batch in lib-ov/batches.json (e.g. b07, m2)
//   --all     every library card, not just the unautomated ones (prints a summary only)
//   --short   names + unparsed lines only
import { loadLibrary, libraryBatches } from "./helpers.js";
import { coverage } from "../overrides.js";

const args = process.argv.slice(2);
const batch = args.find((a) => !a.startsWith("--"));
const short = args.includes("--short");
const lib = loadLibrary();
const names = batch ? new Set(libraryBatches()[batch] || []) : null;
if (batch && !names.size) { console.error("unknown batch " + batch); process.exit(1); }
const decksOf = new Map();
for (const d of lib.decks) for (const e of d.entries) { const n = lib.cards[e.set + ":" + e.cn].name; if (!decksOf.has(n)) decksOf.set(n, new Set()); decksOf.get(n).add(d.name); }
const seen = new Map();
for (const c of Object.values(lib.cards)) {
  if (seen.has(c.name) || (names && !names.has(c.name))) continue;
  let cov; try { cov = coverage(c); } catch (e) { cov = { full: false, unparsed: ["COMPILE ERROR: " + e.message] }; }
  seen.set(c.name, { c, cov });
}
let bad = 0;
for (const [name, { c, cov }] of seen) {
  if (cov.full) continue;
  bad++;
  if (args.includes("--all")) continue;
  console.log(`\n## ${name}  ${c.mana_cost || ""}  — ${c.type_line}  [${[...(decksOf.get(name) || [])].join(", ")}]`);
  if (!short) {
    const text = c.faces ? c.faces.map((f) => `(${f.name}) ${f.mana_cost || ""} ${f.type_line}\n${f.oracle_text}`).join("\n//\n") : c.oracle_text;
    console.log(text.split("\n").map((l) => "    | " + l).join("\n"));
  }
  console.log(cov.unparsed.map((l) => "    ⚠ " + l).join("\n"));
}
console.log(`\nflagged ${bad} of ${seen.size}${batch ? " in batch " + batch : " library cards"}`);
