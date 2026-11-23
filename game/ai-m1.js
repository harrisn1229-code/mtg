// ai-m1.js — AI decisions for the m1 casting / cost mechanics (see engine-m1.js). Pure helpers taking the Brain; deterministic.
import { parseManaCost, costCmc } from "./engine-util.js";

const num = (v) => (typeof v === "number" ? v : v == null || isNaN(+v) ? 0 : +v);
const cs = (x) => (typeof x === "string" ? x : x && typeof x === "object" ? x.cost || x.mana || "" : "");

/** Score for non-standard cast variants. Returns undefined when `a` isn't one of ours (caller continues), null to skip, or a score object. */
export function m1CastScore(b, a, i, o, fd) {
  const v = a.variant;
  if (!["dash", "evoke", "blitz", "emerge", "harmonize", "retrace", "jumpstart", "aftermath", "foretold", "plotted", "miracle", "madness", "suspend"].includes(v)) return undefined;
  const acts = b.req.actions || [];
  const hard = acts.some((x) => x.type === "cast" && x.obj === a.obj && !x.variant);
  const base = b.actionScore({ a: { ...a, variant: undefined }, i });
  if (!base) return null;
  let s = base.score;
  if (["dash", "evoke", "blitz"].includes(v) && hard) return null; // always hard-cast when we can
  if (v === "evoke") {
    // the body is sacrificed at once: keep only the enters-the-battlefield value (a rough 45% of the permanent score)
    s = s * 0.45;
  } else if (v === "dash") {
    // haste hit now, and the creature is safe from sorcery-speed removal: worth it when it can connect
    const opp = b.ctrlBf(b.opp).filter((x) => b.isCre(x));
    s = s * 0.75 + (opp.length === 0 ? 8 : 0);
  } else if (v === "blitz") s = s * 0.7 + 6; // card draw when it dies + haste
  else if (["retrace", "jumpstart", "aftermath", "plotted", "foretold", "madness", "miracle", "suspend"].includes(v)) s = s + 6 - (v === "jumpstart" || v === "retrace" ? 4 : 0);
  return { a, i, score: s, intent: base.intent };
}

/** "m1:<name>" special actions. */
export function m1SpecialScore(b, a, i) {
  const o = b.O(a.obj);
  if (!o) return null;
  const name = a.variant.slice(3);
  const st = b.st;
  const myTurn = b.myTurn();
  const main = b.isMain() && myTurn;
  const spare = b.manaNow() - costCmc(parseManaCost(String(a.cost || "").replace(/ \{E\}/, "")));
  const d = o.def;
  const cmc = num(d.cmc);
  switch (name) {
    case "foretell": {
      // foretell with spare mana, late in the turn, cards that are expensive now and cheaper later
      const fc = costCmc(parseManaCost(cs(b.g.m1Kws(o, b.p, d).foretell)));
      if (!main || st.step !== "main2" && spare < 2) return null;
      if (fc >= cmc && cmc <= 2) return null;
      if (b.manaNow() - 2 < 0) return null;
      return { a, i, score: 6 + (cmc - fc) * 2 };
    }
    case "plot": {
      if (!main) return null;
      if (cmc <= 2 && b.manaNow() >= cmc + 1 && !b.me.hand.length) return null;
      return { a, i, score: 9 + cmc * 1.2 };
    }
    case "suspend": {
      const sus = b.g.m1Kws(o, b.p, d).suspend;
      if (!main) return null;
      return { a, i, score: 8 + cmc * 1.5 - (num(sus && sus.n) > 4 ? 2 : 0) };
    }
    case "ninjutsu": {
      const un = b.g.m1Unblocked(b.p);
      if (!un.length) return null;
      const ninja = b.objValue ? b.cValue({ power: num(d.power), toughness: num(d.toughness), keywords: d.keywords || {}, abilities: d.abilities || [] }) : 0;
      const worst = Math.min(...un.map((x) => b.objValue(x)));
      const gain = ninja + 6 - worst;
      if (gain <= 0) return null;
      return { a, i, score: 30 + gain };
    }
    case "embalm": case "eternalize": case "encore": case "unearth": {
      if (!main) return null;
      const body = b.cValue({ power: name === "eternalize" ? 4 : num(d.power), toughness: name === "eternalize" ? 4 : num(d.toughness), keywords: d.keywords || {}, abilities: d.abilities || [] });
      let v = body * (name === "encore" ? 0.8 : name === "unearth" ? 0.7 : 1) + 4;
      if (name === "encore") v *= Math.max(1, b.opps.length);
      return v > 6 ? { a, i, score: v } : null;
    }
    default: return null;
  }
}

/** choose() requests from m1 hints. Returns an answer or null. */
export function m1Choose(b, r, hint) {
  const objOf = (opt) => (opt && opt.id && !/^P\d+$/.test(opt.id) ? b.O(opt.id) : null);
  if (hint.kind === "m1tap") {
    // tap the least valuable helpers, only as many as needed to afford the spell after the rest is paid by mana
    const cost = hint.cost || parseManaCost("");
    const need = Math.max(0, costCmc(cost) - Math.max(0, b.manaNow() - 0));
    const scored = r.options.map((opt, idx) => { const x = objOf(opt); return { idx, v: x ? (b.isCre(x) ? b.attackPotential(x) + (x.sick ? -40 : 0) : b.objValue(x) * 0.3) : 0 }; }).sort((p, q) => p.v - q.v || p.idx - q.idx);
    let k = need;
    if (hint.mode === "harmonize") k = Math.min(1, need > 0 ? 1 : 0);
    // sick creatures can't attack anyway: tapping them is free when it saves mana for other spells
    const free = scored.filter((s) => s.v < -20).length;
    k = Math.max(k, Math.min(free, costCmc(cost)));
    return { chosen: scored.slice(0, Math.min(k, r.max)).map((s) => s.idx).sort((p, q) => p - q) };
  }
  if (hint.kind === "m1emerge") {
    const scored = r.options.map((opt, idx) => { const x = objOf(opt); return { idx, v: x ? b.objValue(x) - num(x.c.cmc) * 4 : 0 }; }).sort((p, q) => p.v - q.v);
    return { chosen: [scored[0].idx] };
  }
  if (hint.kind === "m1ninjutsu") {
    const scored = r.options.map((opt, idx) => { const x = objOf(opt); return { idx, v: x ? b.objValue(x) : 0 }; }).sort((p, q) => p.v - q.v);
    return { chosen: [scored[0].idx] };
  }
  return null;
}

export function m1Confirm(b, r, h) {
  const src = r.source ? b.O(r.source) : null;
  switch (h.kind) {
    case "m1kicker": case "m1offspring": case "m1buyback": return b.manaNow() >= 0; // only offered when affordable; always worth it when spare mana
    case "m1demonstrate": return true;
    case "m1miracle": case "m1madness": return true;
    case "m1gift": {
      const g = String(h.gift || "");
      if (g === "card" || g === "treasure" || g === "food") return true;
      return b.me.life > 25 && g !== "extra turn" && g !== "octopus";
    }
    case "m1squad": return true;
    default: void src; return undefined;
  }
}

export function m1Number(b, r, h) {
  const src = r.source ? b.O(r.source) : null;
  switch (h.kind) {
    case "m1multikicker": {
      const d = src && src.def;
      let want = r.max;
      if (d && /creature cards? from your graveyard|from your graveyard to the battlefield/i.test(d.text || "")) want = b.st.players[b.p].graveyard.filter((id) => b.O(id)?.def?.types?.includes("creature")).length;
      else if (d && d.types.includes("artifact")) want = Math.min(r.max, 2);
      return Math.max(r.min, Math.min(r.max, want));
    }
    case "m1replicate": return Math.max(r.min, Math.min(r.max, 2));
    case "m1squad": return Math.max(r.min, Math.min(r.max, 2));
    default: return undefined;
  }
}
