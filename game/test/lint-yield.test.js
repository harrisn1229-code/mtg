// Every call to a `$`-suffixed generator must be delegated with `yield*` (SPEC §1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("..", import.meta.url));
const files = readdirSync(dir).filter((f) => /^(engine|overrides)(-[\w-]+)?\.js$/.test(f));

export function findBareCalls(src) {
  const out = [];
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    if (/lint-allow/.test(line)) return;
    const code = line.replace(/\/\/.*$/, "").replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
    const re = /([\w$.]*?)\b(\w+\$)\s*\(/g;
    let m;
    while ((m = re.exec(code))) {
      const before = code.slice(0, m.index);
      if (/(function\s*\*?\s*|\*\s*|async\s+)$/.test(before)) continue; // definition
      if (/yield\*\s*$/.test(before)) continue;
      out.push(`${i + 1}: ${line.trim()}`);
    }
  });
  return out;
}

test("lint: no bare calls to $-generators", () => {
  assert.ok(files.includes("engine.js"));
  const bad = [];
  for (const f of files) for (const b of findBareCalls(readFileSync(dir + f, "utf8"))) bad.push(`${f}:${b}`);
  assert.deepEqual(bad, []);
});

test("lint self-check", () => {
  assert.equal(findBareCalls("const x = yield* this.foo$(a);").length, 0);
  assert.equal(findBareCalls("*foo$(a) {").length, 0);
  assert.equal(findBareCalls("function* bar$(g) {").length, 0);
  assert.equal(findBareCalls("this.foo$(a);").length, 1);
  assert.equal(findBareCalls("g.choose$(p, {});").length, 1);
});

test("browser safety: engine/parser/AI/UI modules never touch Node-only globals unguarded", () => {
  const all = readdirSync(dir).filter((f) => /\.js$/.test(f));
  const bad = [];
  for (const f of all) {
    const src = readFileSync(dir + f, "utf8");
    src.split("\n").forEach((line, i) => {
      if (/\b(process|require|Buffer|__dirname)\b/.test(line.replace(/\/\/.*$/, "").replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""')) && !/typeof (process|require|Buffer)/.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, []);
});
