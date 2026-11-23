// engine-actions.js — legal-action enumeration, casting, activation, costs, targeting, manual tools. Mixed into Game.
import { parseManaCost, costToString, costCmc, addCosts, normalizeDef, tokenDef, FACE_DOWN_DEF } from "./engine-util.js";
import { MUTATE_TARGET } from "./engine-ext.js";
import { describeCost, describeFilter } from "./engine-effects.js";
import { hasType } from "./engine-chars.js";

const isPid = (id) => typeof id === "string" && /^P\d+$/.test(id);
const pid = (i) => "P" + i;
const PERM = ["artifact", "battle", "creature", "enchantment", "land", "planeswalker"];
const isPerm = (d) => d.types.some((t) => PERM.includes(t));

/** "Spend mana as though it were mana of any color" ("color": colorless still can't pay a colored symbol) / "of any type" (colored symbols become generic). */
function spendAsCost(c, how) {
  const out = { ...c, hybrid: [...(c.hybrid || [])] };
  for (const k of ["W", "U", "B", "R", "G"]) {
    for (let i = 0; i < (out[k] | 0); i++) { if (how === "type") out.generic += 1; else out.hybrid.push(["W", "U", "B", "R", "G"]); }
    out[k] = 0;
  }
  if (how === "type") { out.generic += out.C | 0; out.C = 0; out.generic += out.hybrid.length; out.hybrid = []; }
  return out;
}

export const actionMethods = {
  // ---------------------------------------------------------------- enumeration
  /** Internal action list for player p (each has objRef). Only legal + affordable actions. */
  legalActions(p) {
    const st = this.state;
    const pl = st.players[p];
    const acts = [];
    if (!pl || pl.lost || this.over) return acts;
    const sources = this.manaSources(p);
    const sorc = p === st.active && (st.step === "main1" || st.step === "main2") && st.stack.length === 0;
    const O = (id) => st.objects[id];
    // lands
    if (sorc && pl.landsPlayed < pl.landsPerTurn) {
      const cands = [...pl.hand.map((id) => [O(id), "hand"]), ...pl.exile.map((id) => [O(id), "exile"]).filter(([o]) => this.mayPlayFromExile(o, p))];
      for (const [o, zone] of cands) {
        const d0 = o.def;
        if (d0.types.includes("land")) acts.push({ type: "land", obj: o.id, objRef: o, label: `Play ${d0.name}`, zone });
        if (d0.layout === "mdfc" && d0.faces?.[1]?.types.includes("land") && !d0.types.includes("land"))
          acts.push({ type: "land", obj: o.id, objRef: o, label: `Play ${d0.faces[1].name}`, zone, variant: "face1" });
      }
    }
    // casts
    const castFrom = (o, zone) => {
      for (const v of this.castVariants(o, zone, p)) {
        try {
          const chk = this.castCheck(p, o, v, sources, sorc);
          if (chk) acts.push({ type: "cast", obj: o.id, objRef: o, label: chk.label + (chk.sac ? " — sacrifices for mana" : ""), cost: chk.costStr, zone, variant: v.variant !== "normal" ? v.variant : undefined, _v: v, sacForMana: chk.sac || undefined });
        } catch { /* never let a malformed card break enumeration */ }
      }
    };
    for (const id of pl.hand) castFrom(O(id), "hand");
    const ptop = this.playFromTopObj(p); // library m4: "you may play cards from the top of your library"
    if (ptop) {
      if (ptop.def.types.includes("land")) { if (sorc && pl.landsPlayed < pl.landsPerTurn) acts.push({ type: "land", obj: ptop.id, objRef: ptop, label: `Play ${ptop.def.name}`, zone: "library" }); }
      else castFrom(ptop, "library");
    }
    for (const id of pl.command) castFrom(O(id), "command");
    for (const q of st.players) for (const id of q.graveyard) { const go = O(id); if (q.idx === p || this.mayCastGy(go, p)) castFrom(go, "graveyard"); } // library m4: mayCastGy = "until end of turn, you may cast that card from the graveyard"
    for (const q of st.players) for (const id of q.exile) { const o = O(id); if ((o.owner === p && o.onAdventure) || this.mayPlayFromExile(o, p)) castFrom(o, "exile"); }
    // activated abilities
    const actFrom = (o) => {
      const abs = o.c.abilities || [];
      for (let i = 0; i < abs.length; i++) {
        const ab = abs[i];
        if (!ab || ab.kind !== "activated") continue;
        try {
          if (!this.canActivate(p, o, ab, i, sources, sorc)) continue;
          const name = o.c.name;
          let label;
          if (ab.synthetic === "cycle") label = `Cycle ${name}`;
          else if (ab.synthetic === "equip") label = `Equip ${name}`;
          else label = `${name}: ${shortText(ab.text || describeCost(ab.cost) + ": ability")}`;
          acts.push({ type: "activate", obj: o.id, objRef: o, label, cost: describeCost(ab.cost), zone: o.zone, ability: i, mana: ab.mana ? true : undefined, variant: ab.synthetic === "cycle" ? "cycle" : ab.synthetic === "equip" ? "equip" : undefined });
        } catch { /* skip */ }
      }
    };
    for (const id of st.battlefield) { const o = O(id); if (o.controller === p) actFrom(o); }
    // face-down permanents: turning one face up is a special action (CR 116.2b), any time you have priority
    for (const id of st.battlefield) {
      const o = O(id);
      if (o.controller !== p || !o.faceDown) continue;
      const fc = this.faceUpCost(o);
      if (fc == null) continue;
      try { if (this.planPayment(p, { ...parseManaCost(fc), x: 0 }, { sources })) acts.push({ type: "activate", obj: o.id, objRef: o, label: `Turn face up (${o.def.keywords?.megamorph != null ? "megamorph" : "morph"} ${fc})`, cost: fc, zone: "battlefield", variant: "faceUp" }); } catch { /* skip */ }
    }
    for (const id of pl.hand) { const o = O(id); if (o.c.abilities.some((a) => a.kind === "activated" && a.zone === "hand")) actFrom(o); }
    for (const id of pl.graveyard) { const o = O(id); if (o.c.abilities.some((a) => a.kind === "activated" && a.zone === "graveyard")) actFrom(o); }
    // manual tools (humans only) — a recorded safety net; see MANUAL_TOOLS
    if (!pl.ai && this.options.manualTools !== false)
      for (const [variant, label] of MANUAL_TOOLS) acts.push({ type: "special", obj: null, label: `Manual: ${label}`, zone: null, variant });
    return acts;
  },

  mayCastGy(o, p) { const m = o && o.zone === "graveyard" ? o.mayCastGy : null; return !!(m && m.player === p && this.state.turn <= m.untilTurn); },
  mayPlayFromExile(o, p) {
    const m = o && o.zone === "exile" ? o.mayPlay : null;
    return !!(m && m.player === p && (m.untilTurn == null || this.state.turn <= m.untilTurn));
  },
  /** Alternative-cost variants available wherever the card could be cast normally (CR 118.9). */
  altVariants(o, d, p) {
    const out = [];
    const kw = d.keywords || {};
    if (kw.mutate) out.push({ variant: "mutate", face: 0 });
    if (kw.morph != null || kw.megamorph != null) out.push({ variant: "morph", face: 0 });
    if (kw.spectacle && this.opponentsOf(p).some((q) => this.state.players[q].lifeLostThisTurn > 0)) out.push({ variant: "spectacle", face: 0 });
    return out;
  },

  /** Variants a card could be cast with from a zone: [{variant, face, costStr}] */
  castVariants(o, zone, p) {
    const d = o.def;
    const out = [];
    if (zone !== "command" && o.owner !== p && !this.mayPlayFromExile(o, p) && !this.mayCastGy(o, p)) return out;
    const castable = (fd) => fd && !fd.types.includes("land") && fd.cost != null && (fd.cost !== "" || (fd.types.length && !isPerm(fd) && false));
    const kw = d.keywords || {};
    const cs = (v) => (typeof v === "string" ? v : v && typeof v === "object" ? v.cost || v.mana || "" : null);
    if (zone === "hand") {
      if (castable(d)) {
        out.push({ variant: "normal", face: 0 });
        if (cs(kw.kicker)) out.push({ variant: "kicked", face: 0 });
        if (cs(kw.overload)) out.push({ variant: "overload", face: 0 });
        out.push(...this.altVariants(o, d, p));
      }
      if (this.hasStaticOn(d, "castFree", { source: o, you: p }) || (castable(d) && this.castsFreeFromHand(p))) out.push({ variant: "free", face: 0 });
      if (d.faces && d.faces[1]) {
        if (d.layout === "adventure" && castable(d.faces[1])) out.push({ variant: "adventure", face: 1 });
        else if (d.layout === "mdfc" && castable(d.faces[1])) out.push({ variant: "face1", face: 1 });
      }
    } else if (zone === "library") {
      if (castable(d) && this.playFromTopObj(p) === o) out.push({ variant: "normal", face: 0 }, ...this.altVariants(o, d, p));
    } else if (zone === "command") {
      if (o.isCommander && o.owner === p && castable(d)) out.push({ variant: "commander", face: 0 });
    } else if (zone === "graveyard") {
      if (cs(kw.flashback)) out.push({ variant: "flashback", face: 0 });
      if (cs(kw.escape)) out.push({ variant: "escape", face: 0 });
      if (castable(d) && this.mayCastGy(o, p)) out.push({ variant: "normal", face: 0 }, ...this.altVariants(o, d, p));
      else if (castable(d) && d.abilities.some((a) => a.kind === "static" && a.effect?.type === "castFrom" && a.effect.zone === "graveyard" && (!a.condition || this.evalCond(a.condition, { source: o, you: p, quiet: true }))))
        out.push({ variant: "normal", face: 0 }, ...this.altVariants(o, d, p));
    } else if (zone === "exile") {
      if (o.onAdventure && castable(d)) out.push({ variant: "normal", face: 0 });
      else if (this.mayPlayFromExile(o, p) && castable(d)) out.push({ variant: o.mayPlay.free ? "free" : "normal", face: 0, ...(o.mayPlay.spendAs ? { spendAs: o.mayPlay.spendAs } : {}) }, ...(o.mayPlay.free ? [] : this.altVariants(o, d, p)));
    }
    return out;
  },

  hasStaticOn(d, type, ctx) {
    return d.abilities.some((a) => a.kind === "static" && a.effect?.type === type && (!a.condition || this.evalCond(a.condition, { ...ctx, quiet: true })));
  },

  variantDef(o, v) {
    if (v && v.variant === "morph") return FACE_DOWN_DEF;
    const d = o.def;
    return v.face && d.faces && d.faces[v.face] ? d.faces[v.face] : d;
  },

  /** A characteristics view of a card as it would be cast (for cost-modifier filters). */
  spellView(o, fd, p) {
    if (fd === FACE_DOWN_DEF) { const save = o.faceDown; o.faceDown = true; const zone = o.zone; o.zone = "stack"; const c = this.baseC(o); o.faceDown = save; o.zone = zone; return { id: o.id, owner: o.owner, controller: p, zone: "stack", c, token: false, isCommander: o.isCommander, counters: {}, faceDown: true }; }
    const save = o.face;
    o.face = fd === o.def ? 0 : (o.def.faces || []).indexOf(fd);
    const c = this.baseC(o);
    o.face = save;
    return { id: o.id, owner: o.owner, controller: p, zone: "stack", c, token: false, isCommander: o.isCommander, counters: {} };
  },

  /** Total mana cost (parsed, X unresolved) for casting o with variant (string or {variant,face}). */
  spellCost(p, o, v) {
    if (typeof v === "string") v = { variant: v, face: v === "adventure" || v === "face1" ? 1 : 0 };
    const fd = this.variantDef(o, v);
    const kw = o.def.keywords || {};
    const cs = (x) => (typeof x === "string" ? x : x && typeof x === "object" ? x.cost || x.mana || "" : "");
    let base;
    switch (v.variant) {
      case "flashback": base = cs(kw.flashback); break;
      case "escape": base = cs(kw.escape); break;
      case "overload": base = cs(kw.overload); break;
      case "free": base = ""; break;
      case "mutate": base = cs(kw.mutate); break;
      case "morph": base = "{3}"; break;
      case "spectacle": base = cs(kw.spectacle); break;
      default: base = fd.cost || "";
    }
    let c = parseManaCost(base);
    if (v.variant === "kicked") c = addCosts(c, parseManaCost(cs(kw.kicker)));
    if (v.variant === "commander") c.generic += 2 * (this.state.players[p].commanderCasts[o.id] | 0);
    if (v.variant === "free") return c;
    // cost modifiers
    let delta = 0;
    const view = this.spellView(o, fd, p);
    for (const s of this._statics) {
      if (s.st.type !== "costMod") continue;
      const who = s.st.who || "you";
      if (who === "you" && s.you !== p) continue;
      if (who === "opponent" && s.you === p) continue;
      if (s.st.notFromHand && o.zone === "hand") continue; // "spells you cast from anywhere other than your hand"
      if (s.st.filter && !this.matches(view, s.st.filter, { source: s.src, you: s.you }, "*")) continue;
      delta += this.amount(s.st.amount ?? -1, { source: s.src, you: s.you });
    }
    for (const a of fd.abilities) {
      if (a.kind !== "static" || a.effect?.type !== "selfCostMod") continue;
      const ctx = { source: o, you: p, quiet: true };
      if (a.condition && !this.evalCond(a.condition, ctx)) continue;
      const per = a.effect.per != null ? this.amount(a.effect.per, ctx) : 1;
      delta += per * this.amount(a.effect.amount ?? -1, ctx);
    }
    if (delta) c.generic = Math.max(0, c.generic + delta);
    if (v.spendAs) c = spendAsCost(c, v.spendAs);
    return c;
  },

  targetSpecsFor(o, fd, variant) {
    if (variant === "overload" || variant === "morph") return [];
    if (variant === "mutate") return [MUTATE_TARGET];
    if (fd.subtypes.includes("aura")) {
      let what = fd.enchant || o.def.enchant || fd.keywords?.enchant;
      if (typeof what === "string") what = { types: [what.toLowerCase().replace(/s$/, "")] };
      if (!what) what = fd.spell?.targets?.[0]?.what || { types: ["creature"] };
      return [{ what }];
    }
    return (fd.spell && Array.isArray(fd.spell.targets)) ? fd.spell.targets : [];
  },

  /** Is casting castable now? Returns {label, costStr} or null. */
  castCheck(p, o, v, sources, sorc) {
    const fd = this.variantDef(o, v);
    const pl = this.state.players[p];
    const instant = fd.types.includes("instant") || this.hasKw({ c: { keywords: fd.keywords } }, "flash") || (pl.flashSorceries && fd.types.includes("sorcery"));
    if (!instant && !sorc) return null;
    const ctx = { source: o, you: p, quiet: true };
    if (fd.spell?.modes && v.variant !== "overload") {
      const ms = fd.spell.modes;
      const avail = (ms.modes || []).filter((m) => (m.targets || []).every((t) => this.targetCandidates(t, o, p, ctx).length >= this.specMin(t, ctx)));
      if (avail.length < Math.min(ms.min ?? 1, (ms.modes || []).length)) return null;
    }
    for (const t of this.targetSpecsFor(o, fd, v.variant)) if (this.targetCandidates(t, o, p, ctx).length < this.specMin(t, ctx)) return null;
    const add = v.variant === "morph" ? null : withFlashbackCost(o.def, v, (v.variant === "escape" ? escapeCost(o.def) : null) || fd.additionalCost || (v.face ? null : o.def.additionalCost));
    const spend = { kind: "spell", view: this.spellView(o, fd, p), player: p };
    if (add && !this.canPayCost(p, add, o, { ...ctx, x: 0 }, { noMana: false, extraSources: sources, spend })) return null;
    const cost = this.spellCost(p, o, v);
    const delve = o.def.keywords?.delve ? pl.graveyard.filter((id) => id !== o.id).length : 0;
    const plan = this.planPayment(p, { ...cost, x: 0 }, { sources, delve, spend });
    if (!plan) return null;
    const name = v.variant === "morph" ? o.def.name : fd.name;
    const suffix = { kicked: " (kicked)", overload: " (overload)", flashback: " (flashback)", escape: " (escape)", adventure: " (adventure)", commander: " from the command zone", free: " (without paying its mana cost)",
      mutate: " for its mutate cost", morph: " face down (morph)", spectacle: " for its spectacle cost" }[v.variant] || "";
    return { label: `Cast ${name}${suffix}`, costStr: costToString(cost), sac: plan.sacrifices || 0 };
  },

  specMin(t, ctx) { return t.min == null ? 1 : this.amount(t.min, ctx); },
  specMax(t, ctx) { return t.max == null ? Math.max(1, t.min == null ? 1 : this.amount(t.min, ctx)) : this.amount(t.max, ctx); },

  canActivate(p, o, ab, i, sources, sorc) {
    const st = this.state;
    const zone = ab.zone || "battlefield";
    if (o.zone !== zone) return false;
    if (zone === "battlefield" ? o.controller !== p : o.owner !== p) return false;
    if (ab.sorcery && !sorc) return false;
    const cost = this.effCost(o, ab, p);
    if (ab.limit === "turn" && o.activations && o.activations.turn === st.turn && (o.activations[i] | 0) >= 1) return false;
    if (cost.loyalty != null || ab.loyalty) {
      if (!sorc) return false;
      if (o.loyaltyUsed === st.turn) return false;
      const n = typeof cost.loyalty === "number" ? cost.loyalty : 0;
      if (n < 0 && (o.counters.loyalty | 0) < -n) return false;
    }
    const ctx = { source: o, you: p, quiet: true };
    if (ab.condition && !this.evalCond(ab.condition, ctx)) return false;
    if (ab.mana && !(ab.targets && ab.targets.length)) {
      // mana abilities: payable non-mana costs only (inputs checked below)
    }
    if (ab.modes && ab.modes.modes) {
      const avail = ab.modes.modes.filter((m) => (m.targets || []).every((t) => this.targetCandidates(t, o, p, ctx).length >= this.specMin(t, ctx)));
      if (avail.length < (ab.modes.min ?? 1)) return false;
    }
    for (const t of ab.targets || []) if (this.targetCandidates(t, o, p, ctx).length < this.specMin(t, ctx)) return false;
    return this.canPayCost(p, cost, o, ctx, { sources, spend: { kind: "ability", source: o, player: p } });
  },

  /** Can player p pay a Cost object (incl. mana) for source `src`? opts.noMana skips mana. */
  canPayCost(p, cost, src, ctx = {}, opts = {}) {
    if (!cost) return true;
    if (typeof cost === "string") cost = { mana: cost };
    const st = this.state;
    const pl = st.players[p];
    if (Array.isArray(cost.oneOf) && cost.oneOf.length) return cost.oneOf.some((c) => this.canPayCost(p, c, src, ctx, opts));
    if (cost.tap) { if (!src || src.zone !== "battlefield" || !this.tapReady(src, p)) return false; }
    if (cost.untap) { if (!src || src.zone !== "battlefield" || !this.tapReady(src, p, true)) return false; }
    if (cost.sacSelf && (!src || src.zone !== "battlefield")) return false;
    if (cost.sac) {
      const n = this.amount(cost.sacCount ?? 1, ctx);
      if (this.costSacCands(p, cost.sac, src).length < n) return false;
    }
    if (cost.discardSelf && (!src || src.zone !== "hand")) return false;
    if (cost.discard) {
      const hand = pl.hand.filter((id) => id !== src?.id).map((id) => st.objects[id]);
      if (typeof cost.discard === "object") { if (!hand.some((o) => this.matches(o, cost.discard, { source: src, you: p }, "*"))) return false; }
      else if (hand.length < this.amount(cost.discard, ctx)) return false;
    }
    if (cost.life != null && cost.life !== "x" && cost.life !== "X") { const n = this.amount(cost.life, ctx); if (pl.life < n || (n > 0 && pl.lifeLocked)) return false; }
    if (cost.craftWith && this.craftCands(p, cost.craftWith, src).length < this.amount(cost.craftCount ?? 1, ctx)) return false;
    if (cost.removeCounters) {
      const rc = cost.removeCounters;
      const n = rc.n === "x" || rc.n === "X" ? 0 : this.amount(rc.n ?? 1, ctx);
      if (!src || (src.counters[rc.kind || "+1/+1"] | 0) < n) return false;
    }
    if (cost.exileSelf && (!src || (src.zone !== "graveyard" && src.zone !== "battlefield" && src.zone !== "hand"))) return false;
    if (cost.exileFromGraveyard) {
      const n = this.amount(cost.exileFromGraveyard, ctx);
      if (this.gyExileCands(p, cost, src).length < n) return false;
    }
    if (cost.tapOther) {
      const n = this.amount(cost.tapOtherCount ?? 1, ctx);
      if (this.tapOtherCands(p, cost.tapOther, src).length < n) return false;
    }
    if (cost.loyalty != null && typeof cost.loyalty === "number" && cost.loyalty < 0 && (!src || (src.counters.loyalty | 0) < -cost.loyalty)) return false;
    if (cost.mana && !opts.noMana) {
      const c = parseManaCost(cost.mana);
      const x = c.x ? (ctx.x | 0) : 0;
      const total = { ...c, generic: c.generic + x * c.x, x: 0 };
      const exclude = cost.tap && src ? new Set([src.id]) : null;
      if (!this.planPayment(p, total, { sources: opts.sources || opts.extraSources, exclude, spend: opts.spend })) return false;
    }
    return true;
  },

  costSacCands(p, f, src) {
    return this.state.battlefield.map((id) => this.state.objects[id]).filter((o) => o.controller === p && o.id !== this._manaProtect && this.matches(o, f, { source: src, you: p }));
  },
  gyExileCands(p, cost, src) {
    const pl = this.state.players[p];
    return pl.graveyard.filter((id) => id !== src?.id).map((id) => this.state.objects[id]).filter((o) => !cost.exileFilter || this.matches(o, cost.exileFilter, { source: src, you: p }, "*"));
  },
  tapOtherCands(p, f, src) {
    // summoning sickness only restricts a creature's own {T}/{Q} abilities (CR 302.6), not tapping it for another cost
    return this.state.battlefield.map((id) => this.state.objects[id]).filter((o) => o.controller === p && !o.tapped && o.id !== src?.id && this.matches(o, f, { source: src, you: p }));
  },

  /** g.payCost$(p, cost, ctx) -> bool. opts: {skipMana, exclude}. Sets ctx.sacrificed. */
  *payCost$(p, cost, ctx = {}, opts = {}) {
    if (!cost) return true;
    if (typeof cost === "string") cost = { mana: cost };
    const src = ctx.source ? this.state.objects[ctx.source.id] || ctx.source : null;
    if (!this.canPayCost(p, cost, src, ctx, { noMana: !!opts.skipMana })) return false;
    const st = this.state;
    const pl = st.players[p];
    if (Array.isArray(cost.oneOf) && cost.oneOf.length) {
      const ok = cost.oneOf.map((c, i) => [c, i]).filter(([c]) => this.canPayCost(p, c, src, ctx, { noMana: !!opts.skipMana }));
      if (!ok.length) return false;
      let pick = ok[0][0];
      if (ok.length > 1) {
        const ch = yield* this.choose$(p, { prompt: "Choose how to pay the additional cost", options: ok.map(([c, i]) => ({ id: "c" + i, label: describeCost(c), type: "mode" })), min: 1, max: 1, reason: "pay", source: src?.id });
        pick = cost.oneOf[+ch[0].id.slice(1)];
      }
      const rest = { ...cost }; delete rest.oneOf;
      if (!(yield* this.payCost$(p, rest, ctx, opts))) return false;
      return yield* this.payCost$(p, pick, ctx, opts);
    }
    if (cost.mana && !opts.skipMana) {
      const c = parseManaCost(cost.mana);
      const x = c.x ? (ctx.x | 0) : 0;
      const total = { ...c, generic: c.generic + x * c.x, x: 0 };
      const exclude = cost.tap && src ? new Set([src.id]) : opts.exclude || null;
      if (!(yield* this.payMana$(p, total, { exclude, spend: opts.spend, protect: src?.id }))) return false;
    }
    ctx.sacrificed = ctx.sacrificed || [];
    if (cost.tap && src) this.tap(src);
    if (cost.untap && src) this.untap(src);
    if (cost.loyalty != null && src) {
      const n = cost.loyalty === "-x" || cost.loyalty === "-X" ? -(ctx.x | 0) : cost.loyalty === "+x" ? ctx.x | 0 : +cost.loyalty || 0;
      if (n) this.addCounters(src, "loyalty", n);
      src.loyaltyUsed = st.turn;
    }
    if (cost.life != null) { const n = cost.life === "x" || cost.life === "X" ? ctx.x | 0 : this.amount(cost.life, ctx); if (n > 0) this.loseLife(p, n, { cost: true }); }
    if (cost.removeCounters && src) { const rc = cost.removeCounters; const n = rc.n === "x" || rc.n === "X" ? ctx.x | 0 : this.amount(rc.n ?? 1, ctx); this.addCounters(src, rc.kind || "+1/+1", -n); }
    if (cost.tapOther) {
      const n = this.amount(cost.tapOtherCount ?? 1, ctx);
      const ch = yield* this.chooseObjects$(p, this.tapOtherCands(p, cost.tapOther, src), { prompt: `Tap ${n} untapped ${describeFilter(cost.tapOther)}`, min: n, max: n, reason: "pay", source: src?.id });
      for (const o of ch) this.tap(o);
    }
    if (cost.sacSelf && src && src.zone === "battlefield") { ctx.sacrificed.push(this.snapshot(src)); this.sacrifice(src); }
    if (cost.sac) {
      const n = this.amount(cost.sacCount ?? 1, ctx);
      const ch = yield* this.chooseObjects$(p, this.costSacCands(p, cost.sac, src), { prompt: `Sacrifice ${n === 1 ? "a" : n} ${describeFilter(cost.sac)}`, min: n, max: n, reason: "sacrifice", source: src?.id });
      const snaps = ch.map((o) => this.snapshot(o));
      ctx.sacrificed.push(...snaps);
      for (const o of ch) this.sacrifice(o);
    }
    if (cost.discardSelf && src && src.zone === "hand") this.discardCard(src);
    if (cost.discard) {
      const hand = pl.hand.filter((id) => id !== src?.id).map((id) => st.objects[id]);
      const cands = typeof cost.discard === "object" ? hand.filter((o) => this.matches(o, cost.discard, { source: src, you: p }, "*")) : hand;
      const n = typeof cost.discard === "object" ? 1 : this.amount(cost.discard, ctx);
      const ch = yield* this.chooseObjects$(p, cands, { prompt: `Discard ${n} card${n > 1 ? "s" : ""}`, min: n, max: n, reason: "discard", source: src?.id });
      for (const o of ch) this.discardCard(o);
    }
    if (cost.exileSelf && src && src.zone !== "exile" && src.zone !== "stack") this.moveObj(src, "exile");
    if (cost.craftWith) {
      const n = this.amount(cost.craftCount ?? 1, ctx);
      const ch = yield* this.chooseObjects$(p, this.craftCands(p, cost.craftWith, src), { prompt: `Craft: exile ${n === 1 ? "a" : n} ${describeFilter(cost.craftWith)} you control or ${n === 1 ? "a" : n} ${describeFilter(cost.craftWith)} card${n === 1 ? "" : "s"} from your graveyard`, min: n, max: n, reason: "exile", source: src?.id, hint: { kind: "craft" } });
      ctx.crafted = ch.map((o) => (o.zone === "battlefield" ? this.snapshot(o) : o));
      for (const o of ch) this.moveObj(o, "exile");
    }
    if (cost.exileFromGraveyard) {
      const n = this.amount(cost.exileFromGraveyard, ctx);
      const ch = yield* this.chooseObjects$(p, this.gyExileCands(p, cost, src), { prompt: `Exile ${n} card${n > 1 ? "s" : ""} from your graveyard`, min: n, max: n, reason: "exile", source: src?.id });
      for (const o of ch) this.moveObj(o, "exile");
    }
    return true;
  },

  // ---------------------------------------------------------------- targeting
  targetCandidates(spec, src, controller, ctx = {}) {
    const st = this.state;
    const what = spec?.what ?? spec?.filter ?? "any";
    const out = [];
    const mayPlayer = what === "player" || what === "opponent" || what === "any" || what === "you" ||
      (what && typeof what === "object" && (what.player || (Array.isArray(what.anyOf) && what.anyOf.some((x) => x && x.player))));
    if (mayPlayer) for (const p of st.players) if (!p.lost && this.isLegalTarget(pid(p.idx), spec, src, controller, ctx)) out.push(pid(p.idx));
    if (what === "player" || what === "opponent" || what === "you") return out;
    let zone = spec.zone || (what === "spell" ? "stack" : typeof what === "object" ? what.zone : null) || "battlefield";
    if (typeof what === "object" && Array.isArray(what.anyOf) && !spec.zone && !what.zone) { const z = what.anyOf.map((x) => x?.zone).find(Boolean); if (z) zone = z; }
    let ids;
    if (zone === "battlefield") ids = st.battlefield;
    else if (zone === "stack") ids = st.stack;
    else ids = st.players.flatMap((p) => p[zone] || []);
    for (const id of ids) if (this.isLegalTarget(id, spec, src, controller, ctx)) out.push(id);
    return out;
  },

  isLegalTarget(id, spec, src, controller, ctx = {}) {
    const st = this.state;
    const what = spec?.what ?? spec?.filter ?? "any";
    const mctx = { ...ctx, source: src, you: controller };
    if (isPid(id)) {
      const q = +id.slice(1), pl = st.players[q];
      if (!pl || pl.lost || pl.protection) return false;
      if (what === "player" || what === "any") return true;
      if (what === "opponent") return q !== controller;
      if (what === "you") return q === controller;
      if (what && typeof what === "object") return this.matchesPlayer(q, what, mctx);
      return false;
    }
    const o = st.objects[id];
    if (!o || o.zone === "gone") return false;
    if (what === "spell") {
      if (o.zone !== "stack" || (o.isAbility && !spec.ability) || (src && o.id === src.id)) return false;
      if (spec.spellFilter && !this.matches(o, spec.spellFilter, mctx, "*")) return false;
    } else if (what === "any") {
      if (o.zone !== "battlefield" || !(hasType(o.c, "creature") || hasType(o.c, "planeswalker"))) return false;
    } else {
      if (o.isAbility) return false;
      const zone = spec.zone || (typeof what === "object" ? what.zone : null) || "battlefield";
      const f = typeof what === "string" ? { types: [what] } : what;
      if (zone !== "any" && o.zone !== zone && !(Array.isArray(f.anyOf) && f.anyOf.some((x) => x?.zone === o.zone))) return false;
      if (!this.matches(o, f, mctx, "*")) return false;
    }
    if (o.zone === "battlefield") {
      if (this.hasKw(o, "shroud")) return false;
      if (this.hasKw(o, "hexproof") && o.controller !== controller) return false;
      if (src && this.protectedFrom(o, src)) return false;
    }
    return true;
  },

  /** Choose targets for each spec -> [[ids]...] or null if some spec can't be satisfied. */
  *chooseTargets$(p, specs, src, ctx = {}, effects = null) {
    const out = [];
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i] || {};
      const cands = this.targetCandidates(spec, src, p, ctx);
      const min = this.specMin(spec, ctx), max = Math.min(this.specMax(spec, ctx), cands.length);
      if (cands.length < min) return null;
      if (max <= 0) { out.push([]); continue; }
      if (spec.totalCmc != null) { // "…with total mana value N or less": pick one at a time among the cards that still fit
        const picked = [];
        let left = spec.totalCmc | 0;
        while (picked.length < max) {
          const fit = cands.filter((id) => !picked.includes(id) && ((this.state.objects[id]?.def?.cmc | 0) <= left));
          if (!fit.length) break;
          const options1 = fit.map((id) => ({ id, label: this.objLabel(this.state.objects[id], p), type: "object" }));
          const ch1 = yield* this.choose$(p, { prompt: `Choose target ${picked.length + 1} for ${src?.c?.name || "ability"} (total mana value ${left} or less; none to stop)`, options: options1, min: 0, max: 1, reason: "target", source: src?.id, hint: { kind: "target", index: i, spec, effects: effects || [], chosen: out.map((x) => [...x]) } });
          if (!ch1.length) break;
          picked.push(ch1[0].id);
          left -= this.state.objects[ch1[0].id]?.def?.cmc | 0;
        }
        out.push(picked);
        continue;
      }
      const options = cands.map((id) => ({ id, label: isPid(id) ? this.pname(+id.slice(1)) : this.objLabel(this.state.objects[id], p), type: isPid(id) ? "player" : "object" }));
      const ch = yield* this.choose$(p, { prompt: `Choose ${min === max ? (max === 1 ? "a target" : max + " targets") : min > 0 ? `${min}–${max} targets` : `up to ${max} target${max === 1 ? "" : "s"}`} for ${src?.c?.name || "ability"}${spec.text ? ` (${spec.text})` : ""}`, options, min, max, reason: "target", source: src?.id, hint: { kind: "target", index: i, spec, effects: effects || [], chosen: out.map((x) => [...x]) } });
      out.push(ch.map((c) => c.id));
    }
    return out;
  },

  *chooseModes$(p, ms, src, ctx = {}) {
    const modes = Array.isArray(ms.modes) ? ms.modes : [];
    const avail = [];
    modes.forEach((m, i) => { if ((m.targets || []).every((t) => this.targetCandidates(t, src, p, ctx).length >= this.specMin(t, ctx))) avail.push(i); });
    let mx = ms.max ?? ms.min ?? 1;
    if (ms.maxIf && ms.maxIf.cond && this.evalCond(ms.maxIf.cond, { ...ctx, source: src, you: p, quiet: true })) mx = Math.max(mx, ms.maxIf.max | 0);
    const min = Math.min(ms.min ?? 1, modes.length), max = Math.min(mx, avail.length);
    if (ms.random) { // "choose one at random": the engine's rng, before targets are chosen
      const i = Math.floor(this.rng() * modes.length);
      this.log(`${src?.c?.name || "Ability"}: random mode — ${modes[i].text || i + 1}`);
      const t = modes[i].targets?.length ? yield* this.chooseTargets$(p, modes[i].targets, src, ctx, modes[i].effects) : [];
      return t ? { modes: [i], modeTargets: [t] } : null;
    }
    if (avail.length < min || max <= 0) return null;
    const ch = yield* this.choose$(p, { prompt: `Choose ${min === max ? min : `${min}–${max}`} mode${max > 1 ? "s" : ""} for ${src?.c?.name || "spell"}`, options: avail.map((i) => ({ id: "m" + i, label: modes[i].text || `Mode ${i + 1}`, type: "mode" })), min, max, reason: "mode", source: src?.id, hint: { kind: "mode", modes } });
    const picked = ch.map((c) => +c.id.slice(1)).sort((a, b) => a - b);
    const modeTargets = [];
    for (const i of picked) {
      const t = modes[i].targets?.length ? yield* this.chooseTargets$(p, modes[i].targets, src, ctx, modes[i].effects) : [];
      modeTargets.push(t || []);
    }
    return { modes: picked, modeTargets };
  },

  // ---------------------------------------------------------------- performing actions
  *doAction$(p, act) {
    if (!act) return;
    if (act.type === "land") return yield* this.playLand$(p, act);
    if (act.type === "cast") return yield* this.cast$(p, act);
    if (act.type === "activate") return yield* this.activate$(p, act);
    if (act.type === "special") return yield* this.special$(p, act);
  },

  *playLand$(p, act) {
    const o = act.objRef;
    const pl = this.state.players[p];
    if (act.variant === "face1") o.face = 1;
    pl.landsPlayed++;
    const name = this.faceDef(o).name;
    this.emit({ t: "move", obj: o.id, from: o.zone, to: "battlefield", player: p, text: `${pl.name} plays ${name}` });
    yield* this.enter$(o, { controller: p, quiet: true });
    this.fireTrigger({ type: "landPlayed", obj: o, player: p });
  },

  *cast$(p, act) {
    const st = this.state;
    const o = act.objRef;
    const v = act._v || { variant: act.variant || "normal", face: 0 };
    const fd = this.variantDef(o, v);
    const pl = st.players[p];
    const ctx = { source: o, you: p, x: 0 };
    // modes
    let modes = null, modeTargets = null;
    if (fd.spell?.modes && v.variant !== "overload") {
      const r = yield* this.chooseModes$(p, fd.spell.modes, o, ctx);
      if (!r) return;
      modes = r.modes; modeTargets = r.modeTargets;
    }
    // X
    const cost = this.spellCost(p, o, v);
    const add0 = v.variant === "morph" ? null : withFlashbackCost(o.def, v, (v.variant === "escape" ? escapeCost(o.def) : null) || fd.additionalCost || (v.face ? null : o.def.additionalCost));
    const spend = { kind: "spell", view: this.spellView(o, fd, p), player: p };
    let x = 0;
    const delveN = o.def.keywords?.delve ? pl.graveyard.filter((id) => id !== o.id).length : 0;
    if (cost.x || (add0 && (add0.x || add0.life === "x" || add0.life === "X"))) {
      let max = cost.x ? this.maxX(p, cost, { delve: delveN }) : 0;
      if (!cost.x && add0) max = add0.life === "x" || add0.life === "X" ? pl.life : 20;
      if (max < 0) return;
      x = yield* this.number$(p, `Choose X for ${fd.name}`, 0, max, o.id, { kind: "x", effects: fd.spell?.effects || [] });
    }
    ctx.x = x;
    // targets
    const specs = this.targetSpecsFor(o, fd, v.variant);
    let targets = [];
    if (specs.length) { const t = yield* this.chooseTargets$(p, specs, o, ctx, fd.subtypes.includes("aura") ? [{ op: "_aura" }] : v.variant === "mutate" ? [{ op: "_mutate" }] : fd.spell?.effects || []); if (!t) return; targets = t; }
    const division = specs.length ? yield* this.chooseDivision$(p, fd.spell?.effects || [], targets, o, ctx) : {};
    // pay
    let total = { ...cost, generic: cost.generic + x * cost.x, x: 0 };
    if (delveN && total.generic > 0) {
      let need = 0;
      while (need < Math.min(delveN, total.generic) && !this.planPayment(p, { ...total, generic: total.generic - need })) need++;
      if (need > 0) {
        const gy = pl.graveyard.filter((id) => id !== o.id).map((id) => st.objects[id]);
        const ch = yield* this.chooseObjects$(p, gy, { prompt: `Delve: exile ${need} card${need > 1 ? "s" : ""} from your graveyard`, min: need, max: need, reason: "exile", source: o.id });
        for (const c of ch) this.moveObj(c, "exile");
        total = { ...total, generic: total.generic - ch.length };
      }
    }
    const excl = add0 && add0.sac ? new Set(st.battlefield.filter((id) => { const q = st.objects[id]; return q.controller === p && q.c.abilities.some((a) => a.mana && a.cost?.sacSelf); })) : null;
    let paid = yield* this.payMana$(p, total, { exclude: excl, spend });
    if (!paid && excl) paid = yield* this.payMana$(p, total, { spend });
    if (!paid) { this.log(`${pl.name} can't pay for ${fd.name}`); return; }
    const spent = { n: this._lastSpend?.n | 0, units: [...(this._lastSpend?.units || [])] };
    if (add0) {
      const addNoMana = { ...add0 };
      if (addNoMana.mana) { const ok = yield* this.payMana$(p, { ...parseManaCost(addNoMana.mana), x: 0 }, { spend }); if (!ok) { this.log(`Couldn't pay additional cost for ${fd.name}`); } else { spent.n += this._lastSpend.n | 0; spent.units.push(...this._lastSpend.units); } delete addNoMana.mana; }
      yield* this.payCost$(p, addNoMana, ctx, { skipMana: true });
    }
    // to the stack
    const from = o.zone;
    if (o.zone === "command") pl.commanderCasts[o.id] = (pl.commanderCasts[o.id] | 0) + 1;
    this.removeFromZone(o);
    o.zone = "stack";
    st.stack.push(o.id);
    o.controller = p;
    o.face = v.face || 0;
    o.castVariant = v.variant;
    o.x = x; o.kicked = v.variant === "kicked";
    o.onAdventure = false; o.mayPlay = null; o.cmdPending = false;
    o.faceDown = v.variant === "morph";
    o.manaSpent = spent.n;
    { const pl2 = st.players[p]; const tm = pl2.treasureMana | 0; if (tm > 0 && spent.n > 0) { o.treasureSpent = true; pl2.treasureMana = Math.max(0, tm - spent.n); } else o.treasureSpent = false; }
    o._division = division;
    o._targets = targets; o._targetSpecs = specs; o._modes = modes; o._modeTargets = modeTargets;
    o._sacrificed = ctx.sacrificed || [];
    o.targets = [...targets.flat(), ...(modeTargets ? modeTargets.flat(2) : [])];
    o.ts = ++st.ts;
    o.c = this.baseC(o);
    this.markDirty();
    st.spellsThisTurn++;
    { const pc = st.players[p]; pc.castsT = pc.castsT && pc.castsT.turn === st.turn ? { turn: st.turn, n: pc.castsT.n + 1 } : { turn: st.turn, n: 1 }; }
    const tgt = o.targets.length ? ` targeting ${o.targets.map((id) => this.nameOf(id)).join(", ")}` : "";
    this.emit({ t: "cast", obj: o.id, player: p, targets: [...o.targets], from, variant: v.variant, manaSpent: spent.n, text: `${pl.name} casts ${o.faceDown ? "a face-down creature spell" : o.c.name}${x ? ` (X=${x})` : ""}${v.variant === "kicked" ? " (kicked)" : v.variant === "mutate" ? " for its mutate cost" : v.variant === "spectacle" ? " for its spectacle cost" : ""}${tgt}` });
    this.fireTrigger({ type: "cast", obj: o, player: p, manaSpent: spent.n, treasure: o.treasureSpent ? 1 : 0 });
    this.afterTargeting(o);
    this.fireOnSpend(spent.units, spend, p);
  },

  *activate$(p, act) {
    const st = this.state;
    const o = act.objRef;
    if (act.variant === "faceUp") { yield* this.turnFaceUp$(p, o); return; }
    const ab = o.c.abilities[act.ability];
    if (!ab) return;
    if (ab.mana && !(ab.targets && ab.targets.length)) { yield* this.activateManaAbility$(p, o, act.ability, null, false); return; }
    const ctx = { source: o, you: p, x: 0 };
    let modes = null, modeTargets = null;
    if (ab.modes && ab.modes.modes) { const r = yield* this.chooseModes$(p, ab.modes, o, ctx); if (!r) return; modes = r.modes; modeTargets = r.modeTargets; }
    const cost = this.effCost(o, ab, p);
    const mc = parseManaCost(cost.mana || "");
    if (mc.x || cost.x || cost.loyalty === "-x" || cost.loyalty === "-X" || cost.removeCounters?.n === "x" || cost.sacCount === "x" || cost.sacCount === "X") {
      let max = 0;
      if (cost.sacCount === "x" || cost.sacCount === "X") max = this.costSacCands(p, cost.sac, o).length; // "Sacrifice X Treasures"
      else if (mc.x) max = this.maxX(p, { ...mc }, { exclude: cost.tap ? new Set([o.id]) : null });
      else if (cost.loyalty != null) max = o.counters.loyalty | 0;
      else if (cost.removeCounters) max = o.counters[cost.removeCounters.kind || "+1/+1"] | 0;
      else max = 20;
      if (max < 0) return;
      ctx.x = yield* this.number$(p, `Choose X for ${o.c.name}`, 0, max, o.id, { kind: "x", effects: ab.effects || [], loyalty: cost.loyalty != null });
    }
    let targets = [];
    if (ab.targets && ab.targets.length) { const t = yield* this.chooseTargets$(p, ab.targets, o, ctx, ab.effects); if (!t) return; targets = t; ctx.division = yield* this.chooseDivision$(p, ab.effects || [], targets, o, ctx); }
    const spend = { kind: "ability", source: o, player: p };
    if (!this.canPayCost(p, cost, o, ctx, { spend })) { this.log(`${this.pname(p)} can't pay for ${o.c.name}'s ability`); return; }
    const ok = yield* this.payCost$(p, cost, ctx, { spend });
    if (!ok) return;
    if (ab.limit === "turn") { if (!o.activations || o.activations.turn !== st.turn) o.activations = { turn: st.turn }; o.activations[act.ability] = (o.activations[act.ability] | 0) + 1; }
    this.noteActivation(p, o);
    if (ab.synthetic === "cycle") { this.log(`${this.pname(p)} cycles ${o.c.name}`); this.fireTrigger({ type: "cycled", obj: o, player: p }); }
    const a = this.newAbilityObj(o, p, ab, { ...ctx }, { targets, modes, modeTargets, specs: ab.targets || [] });
    const tgt = a.targets.length ? ` targeting ${a.targets.map((id) => this.nameOf(id)).join(", ")}` : "";
    this.emit({ t: "ability", obj: a.id, source: o.id, player: p, targets: a.targets, text: `${this.pname(p)} activates ${o.c.name}${ab.synthetic === "equip" ? " (equip)" : ""}${tgt}` });
    this.afterTargeting(a);
    this.fireTrigger({ type: "abilityActivated", obj: o, ability: a.id, player: p, isMana: false });
  },

  /** Activate a mana ability (no stack). auto=true when called from the payment solver (input mana already paid). */
  *activateManaAbility$(p, o, idx, colors, auto) {
    const ab = o.c.abilities[idx];
    if (!ab) return false;
    const cost = this.effCost(o, ab, p);
    this.noteActivation(p, o);
    const ctx = { source: o, you: p, manaChoice: colors || null, x: 0, manaAbility: true };
    if (!auto && cost.mana) {
      const c = parseManaCost(cost.mana);
      if (!(yield* this.payMana$(p, { ...c, x: 0 }, { exclude: new Set([o.id]), spend: { kind: "ability", source: o, player: p }, protect: o.id }))) return false;
    }
    this._manaTrig = [];
    const trBefore = o.c.subtypes.includes("treasure") ? this.poolCount(p) : -1; // Alchemist's Talent: remember how much of the pool came from a Treasure
    if (cost.tap) { if (o.tapped) return false; o.tapped = true; this.markDirty(); this.emit({ t: "tap", obj: o.id, mana: true, silent: !!auto, text: `${o.c.name} is tapped for mana` }); this.fireTrigger({ type: "tapped", obj: o, forMana: true, player: p }); }
    const rest = { ...cost }; delete rest.mana; delete rest.tap;
    if (Object.keys(rest).length) { if (!(yield* this.payCost$(p, rest, ctx, { skipMana: true }))) return false; }
    if (typeof ab.run === "function") yield* ab.run(this, ctx);
    else yield* this.runEffects$(ab.effects || [], ctx);
    yield* this.runManaTriggers$();
    if (trBefore >= 0) { const pl = this.state.players[p]; pl.treasureMana = (pl.treasureMana | 0) + Math.max(0, this.poolCount(p) - trBefore); }
    if (ab.limit === "turn") { if (!o.activations || o.activations.turn !== this.state.turn) o.activations = { turn: this.state.turn }; o.activations[idx] = (o.activations[idx] | 0) + 1; }
    return true;
  },

  // ---------------------------------------------------------------- manual tools (§8)
  /** Manual tools: every choice is a normal request, so tools are recorded in game.answers and replay deterministically. */
  *special$(p, act) {
    const st = this.state;
    const O = (id) => st.objects[id];
    const bf = () => st.battlefield.map(O).filter(Boolean);
    const players = () => st.players.filter((q) => !q.lost);
    const pickPlayer$ = function* (g, prompt) {
      const ch = yield* g.choose$(p, { prompt, options: players().map((q) => ({ id: q.id, label: q.idx === p ? `${q.name} (you)` : q.name, type: "player" })), min: 1, max: 1, reason: "generic" });
      return ch.length ? +ch[0].id.slice(1) : p;
    };
    const pickPerm$ = function* (g, prompt, list) {
      const ch = yield* g.chooseObjects$(p, list || bf(), { prompt, min: 1, max: 1, reason: "generic" });
      return ch[0] || null;
    };
    // cards whose identity this player may see: battlefield (face-down: only their own), graveyards, face-up exile, the stack, their hand/library/command zone
    const visible = () => {
      const out = bf().filter((o) => !o.faceDown || o.controller === p);
      for (const q of st.players) for (const id of [...q.graveyard, ...q.exile, ...q.command]) { const o = O(id); if (o && !(o.faceDown && q.idx !== p)) out.push(o); }
      for (const id of st.stack) { const o = O(id); if (o && !o.isAbility && !(o.faceDown && o.controller !== p)) out.push(o); }
      for (const id of st.players[p].hand) out.push(O(id));
      const lib = st.players[p].library.map(O).filter(Boolean).sort((a, b) => (a.c.name < b.c.name ? -1 : a.c.name > b.c.name ? 1 : 0));
      return [...out, ...lib];
    };
    const note = (t) => this.log(`(manual) ${this.pname(p)} ${t}`);
    switch (act.variant) {
      case "life": {
        const q = yield* pickPlayer$(this, "Adjust whose life total?");
        const d = yield* this.number$(p, `Change ${this.pname(q)}'s life by (negative = lose)`, -100, 100);
        if (d > 0) this.gainLife(q, d); else if (d < 0) this.loseLife(q, -d);
        return note(`adjusted ${this.pname(q)}'s life by ${d}`);
      }
      case "draw": { const q = yield* pickPlayer$(this, "Who draws?"); const n = yield* this.number$(p, "How many cards?", 1, 20); this.draw(q, n); return note(`made ${this.pname(q)} draw ${n}`); }
      case "discard": {
        const q = yield* pickPlayer$(this, "Who discards?");
        const hand = st.players[q].hand.map(O);
        if (!hand.length) return;
        if (q === p) { const ch = yield* this.chooseObjects$(p, hand, { prompt: "Discard which cards?", min: 1, max: hand.length, reason: "discard" }); for (const o of ch) this.discardCard(o); }
        else { const n = yield* this.number$(p, `Discard how many at random from ${this.pname(q)}'s hand?`, 1, hand.length); const pool = [...hand]; for (let i = 0; i < n && pool.length; i++) this.discardCard(pool.splice(Math.floor(this.rng() * pool.length), 1)[0]); }
        return note(`made ${this.pname(q)} discard`);
      }
      case "mill": { const q = yield* pickPlayer$(this, "Who mills?"); const n = yield* this.number$(p, "How many cards?", 1, 30); this.mill(q, n); return note(`milled ${n} from ${this.pname(q)}`); }
      case "tap": {
        const ch = yield* this.chooseObjects$(p, bf(), { prompt: "Tap or untap which permanents? (each one toggles)", min: 1, max: st.battlefield.length, reason: "generic" });
        for (const o of ch) { if (o.tapped) this.untap(o); else this.tap(o); }
        return;
      }
      case "counters": {
        const opts = [...bf().map((o) => ({ id: o.id, label: this.objLabel(o, p), type: "object" })), ...players().map((q) => ({ id: q.id, label: `${q.name} (player)`, type: "player" }))];
        const ch = yield* this.choose$(p, { prompt: "Put or remove counters on what?", options: opts, min: 1, max: 1, reason: "generic" });
        if (!ch.length) return;
        const isP = /^P\d+$/.test(ch[0].id);
        const o = isP ? null : O(ch[0].id);
        const have = isP ? Object.keys(st.players[+ch[0].id.slice(1)].counters || {}) : Object.keys(o.counters);
        const kinds = [...new Set([...(isP ? ["poison", "energy", "experience"] : ["+1/+1", "-1/-1", "loyalty"]), ...have, ...(isP ? [] : COUNTER_KINDS)])];
        const k = yield* this.choose$(p, { prompt: "Which kind of counter?", options: kinds.map((x) => ({ id: x, label: x, type: "text" })), min: 1, max: 1, reason: "generic" });
        const n = yield* this.number$(p, "How many? (negative = remove)", -30, 30);
        if (!k[0] || !n) return;
        if (isP) this.addPlayerCounters(+ch[0].id.slice(1), k[0].id, n); else this.addCounters(o, k[0].id, n);
        return note(`${n > 0 ? "added" : "removed"} ${Math.abs(n)} ${k[0].id} counter(s)`);
      }
      case "token": {
        const q = yield* pickPlayer$(this, "Who gets the token?");
        const list = [["treasure", "Treasure"], ["food", "Food"], ["clue", "Clue"], ["blood", "Blood"], ["map", "Map"], ["eldrazi spawn", "Eldrazi Spawn (0/1, sacrifice: add {C})"], ["eldrazi scion", "Eldrazi Scion (1/1, sacrifice: add {C})"], ["creature", "Creature token with any power/toughness…"]];
        const ch = yield* this.choose$(p, { prompt: "Create which token?", options: list.map(([id, label]) => ({ id, label, type: "text" })), min: 1, max: 1, reason: "generic" });
        if (!ch[0]) return;
        const n = yield* this.number$(p, "How many?", 1, 20);
        if (ch[0].id === "creature") {
          const pw = yield* this.number$(p, "Power", 0, 30), tg = yield* this.number$(p, "Toughness", 1, 30);
          const col = yield* this.choose$(p, { prompt: "Colour", options: ["C", "W", "U", "B", "R", "G"].map((c) => ({ id: c, label: { C: "Colorless", W: "White", U: "Blue", B: "Black", R: "Red", G: "Green" }[c], type: "color" })), min: 1, max: 1, reason: "generic" });
          const c = col[0]?.id || "C";
          this.createToken(q, { name: `${pw}/${tg} Creature`, types: ["creature"], subtypes: [], colors: c === "C" ? [] : [c], power: pw, toughness: tg }, n);
        } else this.createToken(q, ch[0].id, n);
        return note(`created ${n} token(s)`);
      }
      case "sacrifice": {
        const o = yield* pickPerm$(this, "Sacrifice which permanent? (its controller sacrifices it)");
        if (o) { this.sacrifice(o); note(`sacrificed ${o.c.name}`); }
        return;
      }
      case "destroy": { const o = yield* pickPerm$(this, "Destroy which permanent?"); if (o) { this.destroy(o); note(`destroyed ${o.c.name}`); } return; }
      case "exile": { const ch = yield* this.chooseObjects$(p, visible().filter((o) => o.zone !== "exile"), { prompt: "Exile which card?", min: 1, max: 1, reason: "generic" }); if (ch[0]) { yield* this.zoneMove$(ch[0], "exile", {}); note(`exiled ${ch[0].c.name}`); } return; }
      case "bounce": { const ch = yield* this.chooseObjects$(p, visible().filter((o) => o.zone !== "hand"), { prompt: "Return which card to its owner's hand?", min: 1, max: 1, reason: "generic" }); if (ch[0]) { yield* this.zoneMove$(ch[0], "hand", {}); note(`returned ${ch[0].c.name} to hand`); } return; }
      case "graveyard": { const ch = yield* this.chooseObjects$(p, visible().filter((o) => o.zone !== "graveyard"), { prompt: "Put which card into its owner's graveyard?", min: 1, max: 1, reason: "generic" }); if (ch[0]) { yield* this.zoneMove$(ch[0], "graveyard", {}); note(`put ${ch[0].c.name} into the graveyard`); } return; }
      case "library": {
        const ch = yield* this.chooseObjects$(p, visible().filter((o) => o.zone !== "library"), { prompt: "Put which card into its owner's library?", min: 1, max: 1, reason: "generic" });
        if (!ch[0]) return;
        const w = yield* this.choose$(p, { prompt: `Where in the library?`, options: [{ id: "top", label: "On top", type: "text" }, { id: "bottom", label: "On the bottom", type: "text" }, { id: "shuffle", label: "Shuffle it in", type: "text" }], min: 1, max: 1, reason: "generic" });
        yield* this.zoneMove$(ch[0], "library", { position: w[0]?.id || "top" });
        return note(`put ${ch[0].def?.name || "a card"} into a library (${w[0]?.id || "top"})`);
      }
      case "move": {
        const ch = yield* this.chooseObjects$(p, visible(), { prompt: "Move which card? (yours or your opponent's)", min: 1, max: 1, reason: "generic" });
        const o = ch[0];
        if (!o) return;
        const dests = [["hand", "Owner's hand"], ["battlefield", "Battlefield under your control"], ["battlefieldOwner", "Battlefield under its owner's control"], ["graveyard", "Owner's graveyard"], ["exile", "Exile"], ["libraryTop", "Top of owner's library"], ["libraryBottom", "Bottom of owner's library"], ["command", "Command zone"]]
          .filter(([z]) => z !== o.zone && (z !== "command" || o.isCommander) && !((z === "battlefield" || z === "battlefieldOwner") && (o.def.types.includes("instant") || o.def.types.includes("sorcery"))));
        const d = yield* this.choose$(p, { prompt: `Move ${o.c.name} to`, options: dests.map(([id, label]) => ({ id, label, type: "text" })), min: 1, max: 1, reason: "generic" });
        if (!d[0]) return;
        const z = d[0].id;
        if (o.zone === "stack") this.removeFromStack(o);
        if (z === "libraryTop" || z === "libraryBottom") yield* this.zoneMove$(o, "library", { position: z === "libraryBottom" ? "bottom" : "top" });
        else if (z === "battlefield" || z === "battlefieldOwner") yield* this.zoneMove$(o, "battlefield", { controller: z === "battlefield" ? p : o.owner });
        else yield* this.zoneMove$(o, z, {});
        return note(`moved ${o.def?.name || o.c.name} to ${z}`);
      }
      case "shuffle": { const q = yield* pickPlayer$(this, "Shuffle whose library?"); this.shuffle(q); return note(`shuffled ${this.pname(q)}'s library`); }
      case "control": {
        const o = yield* pickPerm$(this, "Change control of which permanent?");
        if (!o) return;
        const q = yield* pickPlayer$(this, `Who gains control of ${o.c.name}?`);
        this.gainControl(o, q, null, null);
        return note(`gave control of ${o.c.name} to ${this.pname(q)}`);
      }
      case "mana": {
        const col = yield* this.choose$(p, { prompt: "Add mana of which colour?", options: ["W", "U", "B", "R", "G", "C"].map((c) => ({ id: c, label: { C: "Colorless", W: "White", U: "Blue", B: "Black", R: "Red", G: "Green" }[c], type: "color" })), min: 1, max: 1, reason: "generic" });
        const n = yield* this.number$(p, "How much?", 1, 20);
        const add = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }; add[col[0]?.id || "C"] = n;
        this.addManaPool(p, add, null);
        return note(`added ${n} mana`);
      }
      case "cmdDamage": {
        const cmds = st.players.flatMap((q) => q.commanders.map(O)).filter(Boolean);
        if (!cmds.length) { this.log("There are no commanders in this game"); return; }
        const q = yield* pickPlayer$(this, "Whose commander-damage total?");
        const c = yield* this.chooseObjects$(p, cmds, { prompt: "Damage from which commander?", min: 1, max: 1, reason: "generic" });
        if (!c[0]) return;
        const pl = st.players[q], cur = pl.commanderDamage[c[0].id] | 0;
        const d = yield* this.number$(p, `Change it by (now ${cur}/21)`, -cur, 21);
        pl.commanderDamage[c[0].id] = Math.max(0, cur + d);
        return note(`set ${this.pname(q)}'s commander damage from ${c[0].c.name} to ${pl.commanderDamage[c[0].id]}`);
      }
      default: this.manual(null, `Unknown manual tool ${act.variant}`);
    }
  },
};

/** [variant, label] of the manual tools, in the order the tools sheet groups them. */
export const MANUAL_TOOLS = [
  ["life", "adjust a life total"], ["cmdDamage", "change commander damage"], ["mana", "add mana of a chosen colour"],
  ["draw", "draw cards"], ["discard", "discard cards"], ["mill", "mill cards"], ["shuffle", "shuffle a library"],
  ["tap", "tap / untap permanents"], ["counters", "add / remove counters"], ["token", "create a token"], ["control", "change control of a permanent"],
  ["sacrifice", "sacrifice a permanent"], ["destroy", "destroy a permanent"], ["exile", "exile a card"], ["bounce", "return a card to its owner's hand"],
  ["graveyard", "put a card into a graveyard"], ["library", "put a card on top / bottom of a library"], ["move", "move a card between any two zones"],
];
const COUNTER_KINDS = ["charge", "time", "omen", "oil", "stun", "shield", "indestructible", "flying", "first strike", "deathtouch", "lifelink", "trample", "vigilance", "menace", "reach", "hexproof", "haste"];

/** Flashback costs with non-mana parts ("Flashback—{1}{U}, Pay 3 life.") add them to the spell's additional costs. */
function withFlashbackCost(d, v, add) {
  const fb = d.keywords?.flashback;
  if (v.variant !== "flashback" || !fb || typeof fb !== "object" || !fb.add) return add;
  return add ? { ...add, ...fb.add } : fb.add;
}
function escapeCost(d) {
  const e = d.keywords?.escape;
  if (e && d.keywords.escapeExile) return { exileFromGraveyard: d.keywords.escapeExile };
  if (!e || typeof e !== "object") return null;
  return e.exile ? { exileFromGraveyard: e.exile } : null;
}
function shortText(t) { t = String(t || "").replace(/\s+/g, " ").trim(); return t.length > 60 ? t.slice(0, 59) + "…" : t; }
export { normalizeDef, tokenDef, costCmc };
