import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import fs from "fs";
const img = fs.readFileSync("/home/claude/mtg/game/test/browser/card.jpg");
// Usage: node audit.mjs <deck indices, e.g. 0,1> [ms]   — plays real matches, AI answering for you, and hit-tests every prompt
//        node audit.mjs scenarios [shotDir]           — sets up positions through window.__mtgMatch to show the new prompts
//                                                        (mutate over/under, face-down + turn face up, divided damage, creature-type
//                                                        picker, restricted mana, sacrifice-for-mana, phasing, tools sheet, old save)
const SCEN = process.argv[2] === "scenarios";
const decks = SCEN ? [] : process.argv[2] ? process.argv[2].split(",") : [null];
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const bad = new Map(); const kinds = new Map(); let shots = 0;
if (SCEN) await scenarios(process.argv[3] || "/tmp/mtg-shots");
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
console.log(SCEN ? "scenarios checked:" : "request kinds seen:", [...kinds].map(([k, n]) => k + "×" + n).join(", "));
console.log("problems:", bad.size); for (const [k, n] of [...bad].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(" ", n + "×", k);
await b.close();

// ------------------------------------------------------------------------------------------------ scenario mode
/** In-page hit test of the visible dialog / board buttons (same rules as the match audit). Returns problem strings. */
function hitTest(tag) {
  const out = [];
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && getComputedStyle(e).visibility !== "hidden" && !e.disabled; };
  const wraps = [...document.querySelectorAll(".msheet-wrap.in")].filter((w) => !w.classList.contains("peek"));
  const top = wraps[wraps.length - 1];
  const btns = top ? [...top.querySelectorAll("button, [role=button]")].filter(vis) : [...document.querySelectorAll(".mp .pbtn, .mp [data-act=attackAll], .mp .go")].filter(vis);
  for (const bt of btns) {
    const r = bt.getBoundingClientRect(); const x = Math.min(innerWidth - 2, Math.max(2, r.left + r.width / 2)), y = Math.min(innerHeight - 2, Math.max(2, r.top + r.height / 2));
    if (r.top + r.height / 2 > innerHeight || r.top + r.height / 2 < 0) continue;
    const hit = document.elementFromPoint(x, y);
    if (hit && !(bt.contains(hit) || hit.contains(bt) && hit.closest("button,[role=button]") === bt)) { const blocker = hit.closest("button,[role=button]") || hit; if (!bt.contains(blocker)) out.push(`${tag}: <${bt.className}> "${(bt.textContent || "").trim().slice(0, 30)}" covered by <${blocker.className}>`); }
  }
  for (const c of document.querySelectorAll(".mp .card")) { const par = c.parentElement; if (par && getComputedStyle(par).position === "static" && getComputedStyle(c).position === "absolute") out.push(`${tag}: .card in unpositioned <${par.className}>`); }
  if (top) { const sh = top.querySelector(".msheet").getBoundingClientRect(); if (sh.height < 90 || sh.bottom > innerHeight + 2 || sh.top < -2) out.push(`${tag}: sheet rect ${Math.round(sh.top)}..${Math.round(sh.bottom)}`); }
  return out;
}

async function scenarios(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await b.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.route(/scryfall\.io/, (r) => r.fulfill({ status: 200, contentType: "image/jpeg", body: img }));
  p.on("pageerror", (e) => bad.set("PAGEERR " + e.message, 1));
  // full control: the UI never auto-passes priority, so each scripted position stays put
  await p.addInitScript(() => { try { localStorage.setItem("mtg:game:debug", "true"); localStorage.setItem("mtg:game:settings", JSON.stringify({ fullControl: true, speed: "fast" })); } catch (e) {} });
  const shot = async (name) => { await p.waitForTimeout(450); await p.screenshot({ path: `${dir}/${name}.png` }); console.log("shot", `${dir}/${name}.png`); };
  const check = async (name) => { await p.waitForTimeout(350); const out = await p.evaluate(hitTest, name); for (const o of out) bad.set(o, (bad.get(o) || 0) + 1); kinds.set(name, 1); await shot(name); };
  // start a match with deck `d` and play (AI answering for you) until your first main phase with an empty stack
  const start = async (d) => {
    await p.evaluate(() => { try { if (window.__mtgMatch) window.__mtgMatch.close("lobby"); } catch (e) { /* */ } }).catch(() => {});
    await p.goto("http://localhost:8766/#/play", { waitUntil: "domcontentloaded" });
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForSelector('[data-lb="play"]', { timeout: 20000 });
    const ds = await p.$$('[data-lb="you"]'); if (ds[d]) await ds[d].click(); await p.waitForTimeout(200);
    await p.click('[data-lb="play"]');
    await p.waitForFunction(() => window.__mtgMatch && window.__mtgMatch.g, null, { timeout: 20000 });
    await toMyMain();
  };
  const toMyMain = async () => {
    for (let k = 0; k < 400; k++) {
      const st = await p.evaluate(async () => {
        const m = window.__mtgMatch, g = m.g, S = g.state;
        const i = document.querySelector('[data-act="introSkip"]'); if (i) i.click();
        if (g.over) return "over";
        if (!(m._wait && m.req && m.req.player === m.me)) return "wait";
        if (m.req.kind === "priority" && S.active === m.me && S.step === "main1" && !S.stack.length && S.turn >= 2) return "ok";
        const { decide } = await import("/game/ai.js");
        m.closeDialogSheets && m.closeDialogSheets(); m.closeAllSheets && m.closeAllSheets();
        m.submit(m.req.kind === "priority" ? { type: "pass" } : decide(g, m.req, {}));
        return "step";
      });
      if (st === "ok") return; if (st === "over") throw new Error("game over during setup");
      await p.waitForTimeout(st === "wait" ? 120 : 60);
    }
    throw new Error("never reached main phase");
  };
  // edit the position (in page): fn(g, me, opp, helpers)
  const setup = (fnSrc) => p.evaluate((src) => {
    const m = window.__mtgMatch, g = m.g, S = g.state, me = m.me, opp = 1 - me;
    const card = (name, who = me) => Object.values(S.objects).find((o) => o.def && o.def.name === name && o.owner === who && o.zone !== "battlefield" && !o.isAbility);
    const put = (name, zone, who = me) => { const o = typeof name === "string" ? card(name, who) : name; if (!o) throw new Error("no card " + name); g.moveObj(o, zone, { controller: who, quiet: true }); if (zone === "battlefield") o.sick = false; S.pendingTriggers.length = 0; return o; };
    const oppCreatures = (n) => Object.values(S.objects).filter((o) => o.owner === opp && o.zone === "library" && o.def.types.includes("creature") && !o.def.types.includes("land")).slice(0, n);
    // eslint-disable-next-line no-new-func
    new Function("g", "S", "me", "opp", "card", "put", "oppCreatures", src)(g, S, me, opp, card, put, oppCreatures);
    g.refreshRequest(); m.render();
  }, fnSrc);
  const act = (label) => p.evaluate((l) => { const m = window.__mtgMatch; if (!m.req || m.req.kind !== "priority") throw new Error("act " + l + ": pending " + (m.req ? m.req.kind + " " + m.req.prompt : "nothing")); const i = m.req.actions.findIndex((a) => a.label.includes(l)); if (i < 0) throw new Error("no action " + l + " in " + m.req.actions.map((a) => a.label).join(" | ")); m.closeAllSheets(); m.submit({ type: "act", index: i }); }, label);
  const answer = (ans) => p.evaluate((a) => { const m = window.__mtgMatch; m.closeDialogSheets(); m.closeAllSheets(); m.submit(a); }, ans);
  // pass priority (yours) until a non-priority request for you shows up, or until `until` is true
  const passUntilAsk = async (kind) => {
    for (let k = 0; k < 200; k++) {
      const r = await p.evaluate(() => { const m = window.__mtgMatch; if (!(m._wait && m.req && m.req.player === m.me)) return null; return { kind: m.req.kind, reason: m.req.reason, stack: m.g.state.stack.length }; });
      if (r && r.kind !== "priority" && (!kind || r.kind === kind || r.reason === kind)) return r;
      if (r && r.kind === "priority" && !r.stack && !kind) return r;
      if (r && r.kind === "priority") await answer({ type: "pass" });
      await p.waitForTimeout(120);
    }
    throw new Error("no request " + kind);
  };
  const zoomOn = async (sel) => { await p.tap(sel); await p.waitForTimeout(500); };
  const optIndex = (pred) => p.evaluate((src) => { const m = window.__mtgMatch; return m.req.options.findIndex(new Function("o", "return " + src)); }, pred);

  // 1. mutate: the cast variant in the zoom, the over/under prompt, the merged permanent's zoom
  await start(1);
  await setup(`put("Llanowar Elves", "battlefield"); const gz = put("Gemrazer", "hand"); for (const id of [...S.battlefield]) { const o = S.objects[id]; if (o.controller === me && o.c.types.includes("land")) o.tapped = true; } g.addMana(me, "{1}{G}{G}"); window.__gz = gz.id;`);
  await zoomOn('.hc[data-cid="' + (await p.evaluate(() => window.__gz)) + '"]');
  await check("1a-zoom-cast-variants-mutate");
  await p.tap('.zacts .mbtn:has-text("mutate")');
  await passUntilAsk("mutate");
  await check("1b-mutate-over-under");
  await answer({ chosen: [await optIndex('o.id === "over"')] });
  await passUntilAsk();
  await zoomOn('.tile[data-cid*="' + (await p.evaluate(() => window.__mtgMatch.g.state.objects[window.__gz].mergedInto)) + '"]');
  await check("1c-zoom-merged-pile");
  // 2. divided damage: Inferno Titan
  await p.evaluate(() => window.__mtgMatch.closeAllSheets());
  await setup(`for (const o of oppCreatures(2)) put(o, "battlefield", opp); const t = put("Inferno Titan", "hand"); g.addMana(me, "{4}{R}{R}");`);
  await act("Cast Inferno Titan");
  await passUntilAsk("target");
  await check("2a-divided-targets");
  await answer({ chosen: await p.evaluate(() => { const m = window.__mtgMatch; return m.req.options.map((o, i) => [o, i]).filter(([o]) => o.type === "object" && m.g.state.objects[o.id].controller !== m.me).slice(0, 2).map(([, i]) => i); }) });
  await passUntilAsk("number");
  await check("2b-divided-number");
  await answer({ value: await p.evaluate(() => window.__mtgMatch.req.min) });
  await passUntilAsk();
  await ctxClose();

  // 3. morph: cast face down, the face-down zoom with "Turn face up"
  await start(0);
  await setup(`const h = put("Grim Haruspex", "hand"); for (const id of [...S.battlefield]) { const o = S.objects[id]; if (o.controller === me && o.c.types.includes("land")) o.tapped = true; } g.addMana(me, "{C}{C}{C}"); window.__h = h.id;`);
  await act("face down");
  await passUntilAsk();
  await setup(`g.addMana(me, "{B}");`);
  await zoomOn('.tile[data-cid*="' + (await p.evaluate(() => window.__h)) + '"]');
  await check("3a-zoom-facedown-turn-face-up");
  await p.tap('.zacts .mbtn:has-text("Turn face up")');
  await p.waitForTimeout(400);
  await check("3b-turned-face-up");
  await ctxClose();

  // 4. Secluded Courtyard: the creature-type picker, restricted mana in the pool, Ashnod's Altar sacrifice-for-mana, tools sheet, phasing
  await start(3);
  await setup(`put("Secluded Courtyard", "hand");`);
  await act("Play Secluded Courtyard");
  await passUntilAsk("creatureType");
  await check("4a-creature-type-picker");
  const giant = await optIndex('o.id === "giant"');
  await p.fill(".pfilter", "gia").catch(() => {});
  await check("4b-creature-type-picker-filtered");
  await answer({ chosen: [giant] });
  await passUntilAsk();
  await act("Secluded Courtyard: {T}: Add one mana of any color");
  await passUntilAsk("choose");
  await answer({ chosen: [0] });
  await passUntilAsk();
  await check("4c-restricted-mana-in-pool");
  await setup(`S.players[me].manaX = []; put("Ashnod's Altar", "battlefield"); for (const c of Object.values(S.objects).filter((o) => o.owner === me && o.zone === "library" && o.def.types.includes("creature") && o.def.cmc <= 3).slice(0, 2)) put(c, "battlefield"); const tp = put("Teferi's Protection", "hand"); for (const id of [...S.battlefield]) { const o = S.objects[id]; if (o.controller === me && o.c.types.includes("land")) o.tapped = true; } g.addMana(me, "{W}"); window.__tp = tp.id;`);
  await zoomOn('.hc[data-cid="' + (await p.evaluate(() => window.__tp)) + '"]');
  await check("4d-zoom-sacrifices-for-mana");
  await p.tap('.zacts .mbtn');
  await passUntilAsk("sacrifice");
  await check("4e-sacrifice-for-mana-choice");
  await answer({ chosen: [0] });
  await passUntilAsk();
  await check("4f-phased-out");
  await p.tap('[data-act="tools"]').catch(async () => { await p.evaluate(() => window.__mtgMatch.openTools()); });
  await check("4g-tools-sheet");
  await ctxClose();

  // 5. an old saved match offers to discard it
  await p.evaluate(() => { try { window.__mtgMatch.close("lobby"); } catch (e) { /* */ } });
  await p.waitForTimeout(400);
  await p.evaluate(() => { localStorage.setItem("mtg:game:save", JSON.stringify({ setup: JSON.parse(localStorage.getItem("mtg:game:save") || "{}").setup || null, seed: 1, answers: [{ keep: true }], turn: 3, ts: Date.now(), v: 1 })); });
  await p.goto("http://localhost:8766/#/play", { waitUntil: "domcontentloaded" });
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1500);
  const res = await p.$('[data-lb="resume"]');
  if (res) { await res.tap(); await p.waitForTimeout(1500); await check("5-old-saved-match"); }
  else console.log("(no resume button: skipped the old-save check)");
  await ctx.close();

  async function ctxClose() { await p.evaluate(() => { const m = window.__mtgMatch; try { m.closeAllSheets(); } catch (e) { /* */ } }); }
}
