// overrides.js — compileCard() = parser.compileCard() + per-card overrides (SPEC section 7).
//
// OVERRIDES[name] is either
//   * a CardDef fragment: keys present replace the parsed def's keys (abilities / spell / keywords replace wholesale), or
//   * { patch(def) { ...mutate def or return a new def... } }.
// Either way `unparsed` is cleared, unless the override sets `unparsed` itself or passes `keepUnparsed: true`.
// Overrides are looked up by the card's full name, then by its front-face name.
import { compileCard as parseCard } from "./parser.js";
import ov1 from "./overrides-1.js";
import ov2 from "./overrides-2.js";

export const OVERRIDES = { ...ov1, ...ov2 };

function lookup(name) {
  if (name in OVERRIDES) return OVERRIDES[name];
  const front = String(name).split(" // ")[0];
  return front in OVERRIDES ? OVERRIDES[front] : null;
}

export function applyOverride(def, ov) {
  if (!ov) return def;
  let out;
  if (typeof ov.patch === "function") {
    out = ov.patch(def) || def;
  } else {
    const { keepUnparsed, ...frag } = ov;
    out = { ...def };
    for (const [k, v] of Object.entries(frag)) out[k] = v; // abilities/spell/keywords/... replace wholesale
    if (keepUnparsed) out.unparsed = def.unparsed;
  }
  const setsUnparsed = typeof ov.patch === "function" ? false : "unparsed" in ov;
  if (!setsUnparsed && !ov.keepUnparsed) {
    if (!(typeof ov.patch === "function" && out.unparsed !== def.unparsed)) out.unparsed = [];
  }
  return out;
}

export function compileCard(cardData) {
  const def = parseCard(cardData);
  const ov = lookup(def.name) || lookup(cardData.name);
  if (!ov) return def;
  const out = applyOverride(def, ov);
  // keep face defs consistent for per-face overrides
  return out;
}

export function coverage(cardData) {
  const def = compileCard(cardData);
  return { full: def.unparsed.length === 0, unparsed: [...def.unparsed] };
}
