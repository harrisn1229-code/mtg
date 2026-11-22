// parser-m1.js — keyword lines for the casting / cost mechanics of the deck-library "m1" batch (SPEC-NOTES "Library automation: m1").
// kwItemM1(item, kws, parseCost, parseFilter) -> true when `item` (one comma-separated keyword item) was understood and written into `kws`.
const COST = "((?:\\{[^}]+\\})+)";
const FLAG = new Set(["convoke", "improvise", "storm", "sunburst", "retrace", "aftermath", "demonstrate", "cipher", "split second", "exalted"]);
const COST_KW = ["evoke", "dash", "miracle", "foretell", "plot", "encore", "ninjutsu", "madness", "replicate", "emerge", "embalm", "eternalize", "harmonize", "multikicker", "offspring", "buyback", "entwine", "bestow", "prototype"];

export function kwItemM1(t, kws, helpers = {}) {
  const lt = t.toLowerCase().trim();
  let m;
  if (FLAG.has(lt)) { kws[lt] = true; return true; }
  if (lt === "jump-start") { kws.jumpstart = true; return true; }
  if ((m = t.match(new RegExp(`^(${COST_KW.join("|")}) ${COST}$`, "i")))) { kws[m[1].toLowerCase()] = m[2]; return true; }
  if ((m = t.match(/^desertwalk$/i))) { kws.desertwalk = true; return true; }
  if ((m = t.match(/^squad ((?:\{[^}]+\})+)$/i))) { kws.squad = m[1]; return true; }
  if ((m = t.match(/^squad\s*[—-]\s*exile (\w+) cards? from your graveyard$/i))) { const n = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 }[m[1].toLowerCase()] || +m[1]; if (!n) return false; kws.squad = { exileFromGraveyard: n }; return true; }
  if ((m = t.match(new RegExp(`^suspend (\\d+)\\s*[—-]\\s*${COST}$`, "i")))) { kws.suspend = { n: +m[1], cost: m[2] }; return true; }
  if ((m = t.match(new RegExp(`^blitz\\s*[—-]\\s*${COST}(?:, (.+))?$`, "i")))) {
    let add = null;
    if (m[2]) { try { add = helpers.parseCost ? helpers.parseCost(m[2]) : null; } catch { return false; } if (!add) return false; }
    kws.blitz = add ? { cost: m[1], add } : m[1]; return true;
  }
  if ((m = t.match(/^unearth\s*[—-]\s*pay (\w+) \{E\}$/i))) { const n = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }[m[1].toLowerCase()] || +m[1]; if (!n) return false; kws.unearth = { energy: n }; return true; }
  if ((m = t.match(new RegExp(`^escape\\s*[—-]\\s*${COST}, exile (\\w+) other cards? from your graveyard$`, "i")))) {
    const n = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 }[m[2].toLowerCase()] || +m[2];
    if (!n) return false;
    kws.escape = m[1]; kws.escapeExile = n; return true;
  }
  if ((m = t.match(/^gift an? (card|extra turn|octopus|treasure|food|tapped fish)$/i))) { kws.gift = m[1].toLowerCase(); return true; }
  if ((m = t.match(/^kicker \{X\}\. X can't be 0$/i))) { kws.kicker = "{X}"; kws.kickerXMin1 = true; return true; }
  if ((m = t.match(new RegExp(`^kicker ${COST} and/or ${COST}$`, "i")))) { kws.kickers = [m[1], m[2]]; return true; }
  if ((m = t.match(/^affinity for (.+)$/i)) && helpers.parseFilter) {
    let w = m[1].trim();
    const art = /^artifacts$/i.test(w);
    let f;
    if (/^tokens$/i.test(w)) f = { token: true };
    else if (art) f = { types: ["artifact"] };
    else {
      try { f = helpers.parseFilter(w.replace(/s$/i, "")); } catch { return false; }
      if (!f) return false;
    }
    delete f.controller; delete f.zone;
    kws.affinity = { filter: f, text: w };
    return true;
  }
  return false;
}
/** keyword items that begin a keyword line (so tryKeywordLine looks at the whole line) */
export const M1_KW_START = /^(?:convoke|improvise|storm|sunburst|retrace|aftermath|jump-start|demonstrate|cipher|split second|exalted|desertwalk|evoke|dash|miracle|foretell|plot|encore|ninjutsu|madness|replicate|emerge|embalm|eternalize|harmonize|multikicker|offspring|buyback|entwine|squad|suspend|blitz|unearth|escape|gift an?|kicker|affinity for)\b/i;
