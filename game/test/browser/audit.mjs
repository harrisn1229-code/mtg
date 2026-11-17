import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import fs from "fs";
const img = fs.readFileSync("/home/claude/mtg/game/test/browser/card.jpg");
const decks = process.argv[2] ? process.argv[2].split(",") : [null];
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const bad = new Map(); const kinds = new Map(); let shots = 0;
for (const deckIdx of decks) {
  const ctx = await b.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  await p.route(/scryfall\.io/, (r) => r.fulfill({ status: 200, contentType: "image/jpeg", body: img }));
  p.on("pageerror", (e) => bad.set("PAGEERR " + e.message, 1));
  await p.addInitScript(() => { try { localStorage.setItem("mtg:game:debug", "true"); } catch (e) {} });
  await p.goto("http://localhost:8766/#/play", { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-lb="play"]', { timeout: 20000 });
  if (deckIdx != null) { const ds = await p.$$('[data-lb="you"]'); if (ds[+deckIdx]) await ds[+deckIdx].click(); await p.waitForTimeout(200); }
  await p.click('[data-lb="play"]');
  await p.waitForFunction(() => window.__mtgMatch && window.__mtgMatch.g, null, { timeout: 20000 });
  const t0 = Date.now(); let lastKey = "", since = 0;
  while (Date.now() - t0 < +(process.argv[3] || 100000)) {
    const st = await p.evaluate(() => { const m = window.__mtgMatch, g = m.g; if (g.over) return { over: true }; const i = document.querySelector('[data-act="introSkip"]'); if (i) i.click(); const w = !!(m._wait && m.req && m.req.player === m.me); return { w, key: w ? g.answers.length + ":" + m.req.kind : "" }; });
    if (st.over) break;
    if (!st.w) { await p.waitForTimeout(80); continue; }
    if (st.key !== lastKey) { lastKey = st.key; since = Date.now(); }
    if (Date.now() - since < 520) { await p.waitForTimeout(80); continue; }
    const res = await p.evaluate(async () => {
      const m = window.__mtgMatch, g = m.g, req = m.req, out = [];
      const tag = req.kind + (req.reason ? ":" + req.reason : "");
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && getComputedStyle(e).visibility !== "hidden" && !e.disabled; };
      const wraps = [...document.querySelectorAll(".msheet-wrap.in")].filter((w) => !w.classList.contains("peek"));
      const top = wraps[wraps.length - 1];
      const scope = top || document.querySelector(".mp");
      const btns = top ? [...scope.querySelectorAll("button, [role=button]")].filter(vis) : [...document.querySelectorAll(".mp .pbtn, .mp [data-act=attackAll]")].filter(vis);
      for (const bt of btns) {
        const r = bt.getBoundingClientRect(); const x = Math.min(innerWidth - 2, Math.max(2, r.left + r.width / 2)), y = Math.min(innerHeight - 2, Math.max(2, r.top + r.height / 2));
        if (r.top + r.height / 2 > innerHeight || r.top + r.height / 2 < 0 || r.left + r.width / 2 < 0 || r.left + r.width / 2 > innerWidth) continue; // scrolled out: reachable by scrolling
        const hit = document.elementFromPoint(x, y);
        if (hit && !(bt.contains(hit) || hit.contains(bt) && hit.closest("button,[role=button]") === bt)) { const blocker = hit.closest("button,[role=button]") || hit; if (!bt.contains(blocker)) out.push(`${tag}: <${bt.className || bt.dataset.act}> "${(bt.getAttribute("aria-label") || bt.textContent || "").trim().slice(0, 30)}" covered by <${blocker.className}>`); }
      }
      for (const c of document.querySelectorAll(".mp .card")) { const par = c.parentElement; if (par && getComputedStyle(par).position === "static" && getComputedStyle(c).position === "absolute") out.push(`${tag}: .card in unpositioned <${par.className}>`); }
      if (top) { const s = top.querySelector(".msheet").getBoundingClientRect(); if (s.height < 90 || s.bottom > innerHeight + 2 || s.top < -2) out.push(`${tag}: sheet rect ${Math.round(s.top)}..${Math.round(s.bottom)} <${top.querySelector(".msheet").className}>`); }
      const { decide } = await import("/game/ai.js");
      const ans = decide(g, req, { difficulty: "normal" });
      m.closeDialogSheets && m.closeDialogSheets(); m.closeAllSheets && m.closeAllSheets();
      m.submit(ans);
      return { tag, out, hasSheet: !!top };
    });
    kinds.set(res.tag + (res.hasSheet ? " [sheet]" : ""), (kinds.get(res.tag + (res.hasSheet ? " [sheet]" : "")) || 0) + 1);
    for (const o of res.out) { if (!bad.has(o) && shots < 6) { /* first sight */ } bad.set(o, (bad.get(o) || 0) + 1); }
  }
  await ctx.close();
}
console.log("request kinds seen:", [...kinds].map(([k, n]) => k + "×" + n).join(", "));
console.log("problems:", bad.size); for (const [k, n] of [...bad].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(" ", n + "×", k);
await b.close();
