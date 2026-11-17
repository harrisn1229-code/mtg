import { allDecks } from "/home/claude/mtg/game/test/helpers.js";
import { compileCard, coverage } from "/home/claude/mtg/game/overrides.js";
const seen = new Map();
for (const d of allDecks()) for (const c of [...d.commanders, ...d.cards]) { if (seen.has(c.name)) { seen.get(c.name).decks.add(d.name.split(" ")[0]); continue; } const cov = coverage(c); seen.set(c.name, { cov, decks: new Set([d.name.split(" ")[0]]) }); }
let n = 0; for (const [name, v] of seen) if (!v.cov.full) { n++; console.log(`${name} [${[...v.decks].join(",")}]\n${v.cov.unparsed.map((l) => "    " + l).join("\n")}`); }
console.log("flagged", n, "of", seen.size);
