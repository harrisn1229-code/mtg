// engine-ext.js — the "full-automation" mechanics, mixed into the Game prototype (methods use `this`):
//   * "as this enters" replacement choices (enter as a copy — CR 707.9, choose a creature type / mode, shockland life payment,
//     reveal-lands) made BEFORE the permanent enters, through normal requests  -> enter$, entryChoices$
//   * commander replacement for hand/library (CR 903.9b)                       -> zoneMove$
//   * mutate / merged permanents (CR 702.140, 730)                             -> resolveMutate$, mergeInto, splitPile
//   * morph / face-down permanents (CR 702.37, 708)                            -> turnFaceUp$, faceUpCost
//   * phasing (CR 702.26)                                                      -> phaseOut, phaseIn
//   * spend-restricted and tracked mana (Secluded Courtyard, Path of Ancestry) -> restrictOk, onSpendMatches, fireOnSpend
//   * copying an activated/triggered ability on the stack (CR 707.10)          -> copyAbility$
//   * "divided as you choose" (CR 601.2d)                                      -> chooseDivision$
//   * craft (CR 702.167)                                                       -> craftCands
//   * triggered mana abilities (CR 605.1b, Wolfwillow Haven)                   -> extraManaUnits, runManaTriggers$
//   * "any colour a land an opponent controls could produce" (Fellwar Stone)   -> landColors
// Every generator ends in `$` and is called with `yield*`.
import { normalizeDef, CREATURE_TYPES, FACE_DOWN_DEF, cap, parseManaCost, MANA_KEYS } from "./engine-util.js";

const isPid = (id) => typeof id === "string" && /^P\d+$/.test(id);
const pid = (i) => "P" + i;
const ALL5 = ["W", "U", "B", "R", "G"];
export const MUTATE_TARGET = { what: { types: ["creature"], notSubtypes: ["human"], owner: "you" }, text: "non-Human creature you own" };

export const extMethods = {
  // ================================================================ entering the battlefield
  /** Put `o` onto the battlefield after making its "as this enters" choices (generator). */
  *enter$(o, opts = {}) {
    if (!o || o.zone === "gone") return false;
    if (o.zone === "stack") this.removeFromStack(o);
    const entry = opts.entry || (yield* this.entryChoices$(o, opts));
    return this.moveObj(o, "battlefield", { ...opts, entry });
  },

  /** The "as enters" statics of a def (copy first, then the rest). */
  entryStatics(d) {
    return (d?.abilities || []).filter((a) => a && a.kind === "static" && a.effect && (a.effect.type === "asEntersCopy" || a.effect.type === "asEntersChoose" ||
      (a.effect.type === "entersTapped" && (a.effect.affects == null || a.effect.affects === "self") && (a.effect.unlessPay || a.effect.unless?.type === "hasInHand"))));
  },

  /** Ask the replacement-effect choices a permanent makes as it enters. Returns an `entry` record for moveObj. */
  *entryChoices$(o, opts = {}) {
    const p = opts.controller ?? o.owner;
    const entry = { done: true, chosen: {} };
    if (o.faceDown || opts.faceDown) return entry;
    let d = this.faceDef(o);
    const ctx = { source: o, you: p, quiet: true };
    const copyAb = this.entryStatics(d).find((a) => a.effect.type === "asEntersCopy");
    if (copyAb) {
      const e = copyAb.effect;
      const cands = this.copyCandidates(o, e, p);
      if (cands.length) {
        const ch = yield* this.chooseObjects$(p, cands, { prompt: `${d.name}: enter as a copy of which permanent? (choose none to enter as ${d.name} itself)`, min: e.optional === false ? 1 : 0, max: 1, reason: "copy", source: o.id, hint: { kind: "copy", except: e.except || {} } });
        if (ch[0]) { const cd = this.copyResultDef(ch[0], e.except || {}); entry.copy = { id: ch[0].id, def: cd, except: e.except || {} }; d = cd; }
      }
    }
    for (const ab of this.entryStatics(d)) {
      const e = ab.effect;
      if (e.type === "asEntersChoose") {
        if (e.choice === "creatureType") entry.chosen.creatureType = yield* this.chooseCreatureType$(p, o, d);
        else if (e.choice === "color") {
          const ch = yield* this.choose$(p, { prompt: `${d.name}: choose a color`, options: ALL5.filter((c) => c !== e.except).map((c) => ({ id: c, label: cap({ W: "white", U: "blue", B: "black", R: "red", G: "green" }[c]), type: "color" })), min: 1, max: 1, reason: "color", source: o.id, hint: { kind: "chooseColor" } });
          entry.chosen.color = ch[0]?.id || "W";
        } else if (e.choice === "mode") {
          const opts2 = (e.options || []).map((m) => ({ id: m.id, label: m.label || m.id, type: "mode" }));
          const ch = yield* this.choose$(p, { prompt: `${d.name}: choose ${opts2.map((x) => x.id).map(cap).join(" or ")}`, options: opts2, min: 1, max: 1, reason: "mode", source: o.id, hint: { kind: "entryMode", options: e.options } });
          entry.chosen.mode = ch[0]?.id || opts2[0]?.id;
        }
      } else if (e.type === "entersTapped") {
        if (e.unlessPay) {
          const life = +(e.unlessPay.life || 0);
          const pl = this.state.players[p];
          const can = !pl.lifeLocked && pl.life >= life && (!e.unlessPay.mana || this.canPayMana(p, parseManaCost(e.unlessPay.mana)));
          if (can && (yield* this.confirm$(p, `${d.name}: pay ${life ? life + " life" : e.unlessPay.mana} so it enters untapped?`, o.id, { kind: "shock", life, cost: e.unlessPay }))) {
            if (life) this.loseLife(p, life, { cost: true });
            if (e.unlessPay.mana) yield* this.payMana$(p, parseManaCost(e.unlessPay.mana));
            entry.untapped = true;
          } else entry.tapped = true;
        } else if (e.unless?.type === "hasInHand") {
          const hand = this.state.players[p].hand.map((id) => this.state.objects[id]).filter((h) => h && h.id !== o.id && this.matches(h, e.unless.filter, ctx, "*"));
          const ch = hand.length ? yield* this.chooseObjects$(p, hand, { prompt: `${d.name}: reveal a card so it enters untapped? (choose none and it enters tapped)`, min: 0, max: 1, reason: "reveal", source: o.id, hint: { kind: "reveal" } }) : [];
          if (ch[0]) { this.emit({ t: "reveal", objs: [ch[0].id], player: p, text: `${this.pname(p)} reveals ${ch[0].c.name}` }); entry.untapped = true; } else entry.tapped = true;
        }
      }
    }
    yield* this.m2Entry$(o, d, p, entry); // riot, devour (engine-m2.js)
    return entry;
  },

  /** Deterministic answers for a permanent that enters through a path that can't ask (rare engine-internal moves). */
  defaultEntry(o, opts = {}) {
    const p = opts.controller ?? o.owner;
    const entry = { done: true, chosen: {}, fallback: true };
    if (o.faceDown) return entry;
    let d = this.faceDef(o);
    const copyAb = this.entryStatics(d).find((a) => a.effect.type === "asEntersCopy");
    if (copyAb) {
      const cands = this.copyCandidates(o, copyAb.effect, p).sort((a, b) => (b.c.cmc | 0) - (a.c.cmc | 0));
      if (cands[0]) { const cd = this.copyResultDef(cands[0], copyAb.effect.except || {}); entry.copy = { id: cands[0].id, def: cd, except: copyAb.effect.except || {} }; d = cd; }
    }
    for (const ab of this.entryStatics(d)) {
      const e = ab.effect;
      if (e.type === "asEntersChoose") {
        if (e.choice === "creatureType") entry.chosen.creatureType = this.creatureTypeOptions(p)[0];
        else if (e.choice === "color") entry.chosen.color = ALL5.find((c) => c !== e.except);
        else if (e.choice === "mode") entry.chosen.mode = e.options?.[0]?.id;
      } else if (e.type === "entersTapped") entry.tapped = !(e.unless && this.evalCond(e.unless, { source: o, you: p, quiet: true }));
    }
    this.m2EntryDefault(o, d, p, entry);
    return entry;
  },

  copyCandidates(o, e, p) {
    const f = e.filter || { types: ["creature"], controller: "you" };
    return this.state.battlefield.map((id) => this.state.objects[id]).filter((x) => x && x.id !== o.id && this.matches(x, f, { source: o, you: p }));
  },
  /** The def a permanent has when it becomes a copy of `src` with exceptions (CR 707.9b). */
  copyResultDef(src, except = {}) {
    const base = this.copiableDef(src);
    const nd = { ...base, faces: null, layout: "normal" };
    if (except.nonLegendary) nd.supertypes = (base.supertypes || []).filter((s) => s !== "legendary");
    if (except.addTypes) nd.types = [...new Set([...(base.types || []), ...except.addTypes])];
    const out = normalizeDef(nd);
    out._copyOf = base.name;
    return out;
  },

  // ---------------------------------------------------------------- choose a creature type
  /** Creature types offered for player p: types of the cards they own first (most common first), then all others A–Z. */
  creatureTypeOptions(p) {
    const n = new Map();
    for (const o of Object.values(this.state.objects)) {
      if (!o || o.isAbility || o.owner !== p || !o.def) continue;
      for (const t of (o.def.subtypes || [])) if (CREATURE_TYPES.includes(t)) n.set(t, (n.get(t) || 0) + ((o.def.types || []).includes("creature") ? 1 : 0.2));
    }
    const own = [...n.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map((x) => x[0]);
    const rest = CREATURE_TYPES.filter((t) => !n.has(t)).sort();
    return own.length ? [...own, ...rest] : ["human", ...rest.filter((t) => t !== "human")];
  },
  *chooseCreatureType$(p, o, d) {
    const list = this.creatureTypeOptions(p);
    const options = list.map((t) => ({ id: t, label: t.split("-").map(cap).join("-"), type: "text" }));
    const ch = yield* this.choose$(p, { prompt: `${d?.name || o?.c?.name || "Choose"}: choose a creature type`, options, min: 1, max: 1, reason: "creatureType", source: o?.id, hint: { kind: "creatureType" } });
    const t = ch[0]?.id || list[0];
    this.log(`${this.pname(p)} chooses ${t.split("-").map(cap).join("-")}`);
    return t;
  },

  // ================================================================ zone moves that are replacement-aware
  /** Generator zone change used by effects: commander → command zone replacement for hand/library (CR 903.9b),
   *  "as enters" choices for the battlefield. Returns true if the object moved. */
  *zoneMove$(o, to, opts = {}) {
    if (!o || o.zone === "gone" || o.isAbility) return false;
    if (o.isCommander && !o.token && (to === "hand" || to === "library") && o.zone !== "command") {
      const yes = yield* this.confirm$(o.owner, `Put ${o.c.name} into the command zone instead of ${to === "hand" ? "your hand" : "your library"}?`, o.id, { kind: "commander" });
      if (o.zone === "stack") this.removeFromStack(o);
      if (yes) return this.moveObj(o, "command", opts);
      opts = { ...opts, cmdAsked: true };
    }
    if (o.zone === "stack") this.removeFromStack(o);
    if (to === "battlefield") return yield* this.enter$(o, opts);
    return this.moveObj(o, to, opts);
  },

  // ================================================================ mutate
  /** Resolve a spell cast for its mutate cost (CR 702.140b). */
  *resolveMutate$(o) {
    const ctx = this.spellCtx(o);
    const legal = this.pruneTargets(o, ctx);
    const host = legal ? this.state.objects[(ctx.targets[0] || [])[0]] : null;
    this.emit({ t: "resolve", obj: o.id, text: `${o.c.name} resolves` });
    this.removeFromStack(o);
    if (!host || host.zone !== "battlefield") {
      this.log(`${o.c.name}'s mutate target is gone — it enters the battlefield as a creature`);
      o.castVariant = null;
      return yield* this.enter$(o, { controller: o.controller });
    }
    const d = this.faceDef(o);
    const ch = yield* this.choose$(o.controller, {
      prompt: `Mutate: put ${d.name} over or under ${host.c.name}?`, min: 1, max: 1, reason: "mutate", source: o.id,
      options: [
        { id: "over", label: `Over — it becomes ${d.name} (${d.power}/${d.toughness}) with ${host.c.name}'s abilities too`, type: "mode" },
        { id: "under", label: `Under — it stays ${host.c.name} and gains ${d.name}'s abilities`, type: "mode" },
      ],
      hint: { kind: "mutate", host: host.id, spell: o.id },
    });
    this.mergeInto(o, host, (ch[0]?.id || "over") === "over");
    return true;
  },

  /** Merge card `o` (a resolving mutating spell) with permanent `host`, over or under it. The host stays the same object. */
  mergeInto(o, host, over) {
    this.removeFromZone(o);
    o.zone = "merged"; o.mergedInto = host.id; o.castVariant = null; o.targets = []; o._targets = null; o.controller = host.controller;
    if (!host.pile) host.pile = [host.id];
    if (over) host.pile.unshift(o.id); else host.pile.push(o.id);
    this.updateMergeDef(host);
    this.markDirty(); this.refresh();
    this.emit({ t: "mutate", obj: host.id, card: o.id, over, text: `${o.def.name} mutates ${over ? "onto" : "under"} ${host.lastName || "a creature"} — it is now ${host.c.name}` });
    this.fireTrigger({ type: "mutates", obj: host, card: o, player: host.controller });
  },

  /** Characteristics of a merged permanent: the top card's, plus every ability of every card in the pile (CR 730.2). */
  updateMergeDef(host) {
    host.lastName = host.c?.name;
    if (!host.pile || host.pile.length < 2) { host.mergeDef = null; return; }
    const raw = (x) => { const d = x.copyDef || x.def; return x.face && d.faces && d.faces[x.face] ? d.faces[x.face] : d; };
    const defs = host.pile.map((id) => (id === host.id ? raw(host) : raw(this.state.objects[id])));
    const top = defs[0];
    const keywords = {};
    for (const d of [...defs].reverse()) Object.assign(keywords, d.keywords || {});
    const abilities = defs.flatMap((d) => d.abilities || []);
    const md = normalizeDef({ ...top, keywords, abilities, faces: null, layout: "normal" });
    md._merged = defs.map((d) => d.name);
    host.mergeDef = md;
  },

  /** When a merged permanent leaves the battlefield, every card of the pile goes to that zone (CR 730.4). */
  splitPile(host, to, opts = {}) {
    const others = (host._leftPile || []).map((id) => this.state.objects[id]).filter((x) => x && x.zone === "merged");
    host._leftPile = null;
    const moved = [];
    for (const c of others) {
      c.mergedInto = null;
      const dest = to === "battlefield" || to === "stack" || to === "gone" ? "graveyard" : to;
      this.moveObj(c, dest, { position: opts.position, quiet: false });
      moved.push(c.id);
    }
    host.pileLeft = moved;
    return moved;
  },

  // ================================================================ morph / face-down
  faceUpCost(o) {
    if (!o || !o.faceDown) return null;
    const kw = o.def?.keywords || {};
    if (o.manifestUp && (o.def?.types || []).includes("creature") && o.def.cost) return o.def.cost; // manifested / cloaked creature card (m2)
    const v = kw.morph ?? kw.megamorph ?? kw.disguise ?? o.fuCost; // manifested / cloaked creature cards turn up for their mana cost
    if (v == null || v === false) return null;
    return typeof v === "string" ? v : v.cost || "{0}";
  },
  /** Special action (CR 116.2b): turn a face-down permanent you control face up by paying its morph cost. */
  *turnFaceUp$(p, o) {
    const cost = this.faceUpCost(o);
    if (!o || o.zone !== "battlefield" || o.controller !== p || cost == null) return false;
    const pc = parseManaCost(cost);
    if (!(yield* this.payMana$(p, { ...pc, x: 0 }))) { this.log(`${this.pname(p)} can't pay to turn that creature face up`); return false; }
    o.faceDown = false;
    if (o.def?.keywords?.megamorph != null) o.counters["+1/+1"] = (o.counters["+1/+1"] | 0) + 1;
    this.markDirty(); this.refresh();
    this.emit({ t: "reveal", objs: [o.id], player: p, text: `${this.pname(p)} turns a face-down creature face up: it's ${o.c.name}` });
    this.emit({ t: "faceUp", obj: o.id, player: p, text: `${o.c.name} is turned face up` });
    this.fireTrigger({ type: "turnedFaceUp", obj: o, player: p });
    return true;
  },
  /** Reveal every face-down permanent/spell (game end, CR 708.9). */
  revealFaceDown() {
    const ids = [...this.state.battlefield, ...this.state.stack, ...(this.state.phased || [])].filter((id) => this.state.objects[id]?.faceDown);
    if (ids.length) this.emit({ t: "reveal", objs: ids, player: null, text: `Face-down cards revealed: ${ids.map((id) => this.state.objects[id].def.name).join(", ")}` });
  },

  // ================================================================ phasing
  /** Phase out permanents (and, indirectly, everything attached to them). They're treated as though they don't exist. */
  phaseOut(objs) {
    const st = this.state;
    const all = [];
    const add = (o, indirect) => {
      if (!o || o.zone !== "battlefield" || all.some((x) => x.o === o)) return;
      all.push({ o, indirect });
      for (const aid of o.attachments || []) add(st.objects[aid], true);
    };
    for (const o of objs) add(o, false);
    for (const { o, indirect } of all) {
      const i = st.battlefield.indexOf(o.id);
      if (i >= 0) st.battlefield.splice(i, 1);
      (st.phased ||= []).push(o.id);
      o.zone = "phased"; o.phasedIndirect = indirect; o.phasedController = o.controller;
      if (st.combat) {
        st.combat.attackers = st.combat.attackers.filter((a) => a.obj !== o.id);
        for (const a of st.combat.attackers) a.blockers = a.blockers.filter((b) => b !== o.id);
      }
    }
    if (all.length) this.emit({ t: "phase", objs: all.map((x) => x.o.id), out: true, text: `${all.length} permanent${all.length === 1 ? "" : "s"} phase out (${all.map((x) => x.o.c.name).join(", ")})` });
    this.markDirty(); this.refresh();
    return all.map((x) => x.o.id);
  },
  /** Untap step (CR 502.1): permanents that phased out under player p's control phase in (with what phased out with them). */
  phaseIn(p) {
    const st = this.state;
    if (!st.phased || !st.phased.length) return [];
    const back = [];
    const add = (o) => {
      if (!o || o.zone !== "phased" || back.includes(o)) return;
      back.push(o);
      for (const aid of o.attachments || []) { const a = st.objects[aid]; if (a && a.phasedIndirect) add(a); }
    };
    for (const id of [...st.phased]) { const o = st.objects[id]; if (o && !o.phasedIndirect && o.phasedController === p) add(o); }
    for (const o of back) {
      st.phased.splice(st.phased.indexOf(o.id), 1);
      st.battlefield.push(o.id);
      o.zone = "battlefield"; o.phasedIndirect = false; o.phasedController = null;
    }
    if (back.length) this.emit({ t: "phase", objs: back.map((o) => o.id), out: false, text: `${back.map((o) => o.c.name).join(", ")} phase${back.length === 1 ? "s" : ""} in` });
    this.markDirty(); this.refresh();
    return back;
  },

  // ================================================================ spend-restricted / tracked mana
  /** Resolve a restriction from an addMana effect for a source (fills in "the chosen type"). */
  resolveRestrict(r, src) {
    if (!r) return null;
    const t = src?.chosen?.creatureType || "__none__";
    const fix = (f) => { if (!f || typeof f !== "object") return f; const g = { ...f }; if (g.chosenType) { delete g.chosenType; g.subtypes = [t]; } return g; };
    return { spell: fix(r.spell) || null, ability: fix(r.ability) || null, text: r.text || null };
  },
  /** May a unit with restriction r be spent in context `spend` ({kind:"spell", view} | {kind:"ability", source} | null)? */
  restrictOk(r, spend) {
    if (!r) return true;
    if (!spend) return false;
    const ctx = { you: spend.player, source: spend.view || spend.source };
    if (spend.kind === "spell") return !!r.spell && this.matches(spend.view, r.spell, ctx, "*");
    if (spend.kind === "ability") return !!r.ability && !!spend.source && this.matches(spend.source, r.ability, ctx, "*");
    return false;
  },
  onSpendMatches(u, spend, p) {
    if (!u || !u.onSpend || !spend || spend.kind !== "spell") return false;
    return this.matches(spend.view, u.onSpend.spell || {}, { you: p, source: spend.view }, "*");
  },
  /** "When that mana is spent to cast …" triggers (Path of Ancestry). */
  fireOnSpend(units, spend, p) {
    for (const u of units || []) {
      if (!this.onSpendMatches(u, spend, p)) continue;
      const src = this.state.objects[u.srcId] || null;
      this.pendInternal(src || { id: u.srcId, c: { name: u.srcName || "Mana", abilities: [] }, controller: p }, p, { kind: "triggered", text: u.onSpend.text || `When that mana is spent: ${u.srcName}`, effects: u.onSpend.effects || [] }, { type: "manaSpent", player: p });
    }
  },
  /** Add special mana units to p's pool. */
  addManaUnits(p, cols, meta, src, silent) {
    const pl = this.state.players[p];
    pl.manaX ||= [];
    for (const c of cols) pl.manaX.push({ c, restrict: meta.restrict || null, onSpend: meta.onSpend || null, srcId: src?.id ?? null, srcName: src?.c?.name || null });
    if (cols.length) this.emit({ t: "mana", player: p, added: cols.map((c) => `{${c}}`).join(""), restricted: !!meta.restrict, text: `${pl.name} adds ${cols.map((c) => `{${c}}`).join("")}${src?.c?.name ? ` (${src.c.name})` : ""}${meta.restrict ? " — spend only as restricted" : ""}`, ...(silent ? { silent: true } : {}) });
  },

  // ================================================================ copying abilities
  /** Copy an activated/triggered ability on the stack for player p (CR 707.10); optionally choose new targets. */
  *copyAbility$(a, p, newTargets) {
    if (!a || a.zone !== "stack" || !a.isAbility) return null;
    const c = this.copyStackObject(a, p);
    c._targets = (a._targets || []).map((g) => [...g]);
    c._modeTargets = a._modeTargets ? a._modeTargets.map((m) => (m || []).map((g) => [...g])) : null;
    c.ctx = { ...(a.ctx || {}), you: p };
    c.c = { ...a.c, name: a.c.name.replace(/ \(copy\)$/, "") + " (copy)" };
    if (newTargets && c._targets.some((g) => g.length)) {
      const src = (a.sourceId && this.state.objects[a.sourceId]) || a.ctx?.source || null;
      const yes = yield* this.confirm$(p, `Choose new targets for the copy of ${a.c.name}?`, a.sourceId, { kind: "newTargets", obj: c.id });
      if (yes) {
        const t = yield* this.chooseTargets$(p, c._targetSpecs || [], src, c.ctx, c.ab?.effects || []);
        if (t) c._targets = t;
      }
    }
    c.targets = [...c._targets.flat(), ...(c._modeTargets ? c._modeTargets.flat(2) : [])];
    this.emit({ t: "ability", obj: c.id, source: a.sourceId, player: p, targets: c.targets, copy: true, text: `${this.pname(p)} copies ${a.c.name}${c.targets.length ? ` targeting ${c.targets.map((id) => this.nameOf(id)).join(", ")}` : ""}` });
    this.afterTargeting(c);
    return c;
  },

  // ================================================================ divided damage / counters
  /** Ask how a "divided as you choose" amount is split among its targets (as the spell/ability is put on the stack). */
  *chooseDivision$(p, effects, targets, src, ctx) {
    const out = {};
    const walk = (list) => { const r = []; for (const e of list || []) { if (!e || typeof e !== "object") continue; if (e.divided) r.push(e); if (e.then) r.push(...walk(e.then)); if (e.else) r.push(...walk(e.else)); if (e.effects) r.push(...walk(e.effects)); } return r; };
    for (const e of walk(effects)) {
      const ref = e.op === "damage" ? e.to : e.what;
      if (!ref || typeof ref !== "object" || ref.ref !== "target") continue;
      const i = ref.i | 0;
      const ids = (targets[i] || []).filter(Boolean);
      if (!ids.length || out[i]) continue;
      const total = Math.max(0, this.amount(e.amount, ctx) | 0);
      const what = e.op === "damage" ? "damage" : `${e.kind || "+1/+1"} counters`;
      const map = {};
      let left = total;
      for (let k = 0; k < ids.length; k++) {
        const rest = ids.length - k - 1;
        let n;
        if (k === ids.length - 1) n = left;
        else n = yield* this.number$(p, `Divide ${total} ${what}: how much to ${this.nameOf(ids[k])}? (${left} left; ${rest === 1 ? "the other target needs" : `each of the other ${rest} targets needs`} at least 1)`, Math.min(1, left), Math.max(Math.min(1, left), left - rest), src?.id,
          { kind: "divide", op: e.op, ids: [...ids], index: k, assigned: { ...map }, total, effect: e });
        map[ids[k]] = n; left -= n;
      }
      out[i] = map;
      this.log(`${this.pname(p)} divides ${total} ${what}: ${ids.map((id) => `${map[id]} to ${this.nameOf(id)}`).join(", ")}`);
    }
    return out;
  },

  // ================================================================ craft
  craftCands(p, f, src) {
    const st = this.state;
    const bf = st.battlefield.map((id) => st.objects[id]).filter((o) => o && o.controller === p && o.id !== src?.id && this.matches(o, f, { source: src, you: p }));
    const gy = st.players[p].graveyard.map((id) => st.objects[id]).filter((o) => o && o.id !== src?.id && this.matches(o, { ...f, zone: "graveyard" }, { source: src, you: p }, "*"));
    return [...bf, ...gy];
  },

  // ================================================================ mana: triggered mana abilities, land colours
  /** Extra mana units triggered mana abilities would add when `o` is tapped for mana by p (Wolfwillow Haven). */
  extraManaUnits(o, p) {
    const units = [];
    for (const id of this.state.battlefield) {
      const s = this.state.objects[id];
      if (!s || !s.c) continue;
      for (const ab of s.c.abilities || []) {
        if (!ab || ab.kind !== "triggered" || !ab.manaTrigger || ab.on?.event !== "tapped") continue;
        let ok = false;
        try { ok = this.triggerMatches(ab.on, { type: "tapped", obj: o, forMana: true, player: p }, s, s.controller); } catch { ok = false; }
        if (ok) units.push(...this.manaUnits(s, ab, p));
      }
    }
    return units;
  },
  *runManaTriggers$() {
    const list = (this._manaTrig || []).splice(0);
    for (const t of list) {
      const ctx = { source: t.source, you: t.controller, event: t.event, manaAbility: true, x: 0 };
      if (typeof t.ab.run === "function") yield* t.ab.run(this, ctx);
      else yield* this.runEffects$(t.ab.effects || [], ctx);
    }
  },
  /** Colours (W..G) the lands controlled by `players` could produce (CR 106.7). */
  landColors(players) {
    const out = new Set();
    if ((this._landColorDepth | 0) > 1) return out;
    this._landColorDepth = (this._landColorDepth | 0) + 1;
    try {
      for (const id of this.state.battlefield) {
        const o = this.state.objects[id];
        if (!o || !players.includes(o.controller) || !o.c.types.includes("land")) continue;
        for (const ab of o.c.abilities || []) {
          if (ab.kind !== "activated" || !ab.mana) continue;
          if (this._landColorDepth > 1 && JSON.stringify(ab.effects || []).includes("landColors")) continue;
          for (const u of this.manaUnits(o, ab, o.controller)) for (const c of u) if (ALL5.includes(c)) out.add(c);
        }
      }
    } finally { this._landColorDepth--; }
    return out;
  },
};

export { FACE_DOWN_DEF, MANA_KEYS, isPid, pid };
