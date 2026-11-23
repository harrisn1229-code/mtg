// engine-m4.js — library batch m4 mechanics, mixed into the Game prototype (see SPEC-NOTES.md "Library automation: m4"):
//   * Sagas (lore counters, chapter triggers, sacrifice after the last chapter)      -> sagaChapters, finalChapter, sagaDone
//   * emblems (permanent statics/triggers that live outside every zone)             -> createEmblem
//   * the monarch, rad counters, per-step turn-based actions                         -> becomeMonarch, m4StepStart
//   * temporary triggered abilities ("until your next turn, whenever …")             -> addTempTrigger
// Every generator ends in `$` and is called with `yield*`.
import { normalizeDef, parseManaCost } from "./engine-util.js";

const isPid = (id) => typeof id === "string" && /^P\d+$/.test(id);

export const m4Methods = {
  // ================================================================ Sagas
  /** Chapter abilities `from`..`to` of a Saga trigger as lore counters are put on it (CR 714.2b). */
  sagaChapters(o, from, to) {
    if (!o || o.zone !== "battlefield" || !o.c.subtypes.includes("saga")) return;
    for (let n = from; n <= to; n++) this.fireTrigger({ type: "chapter", obj: o, n, player: o.controller });
  },
  /** Highest chapter number of a Saga (0 if it has no chapter abilities). */
  finalChapter(o) {
    let m = 0;
    for (const ab of o.c?.abilities || []) if (ab.kind === "triggered" && ab.on?.event === "chapter") for (const n of ab.on.chapters || []) m = Math.max(m, n);
    return m;
  },
  /** CR 714.4: a Saga with lore counters >= its final chapter that is not the source of a chapter ability waiting for/on the stack is sacrificed. */
  sagaDone(o) {
    const fin = this.finalChapter(o);
    if (!fin || (o.counters.lore | 0) < fin) return false;
    if (this.state.pendingTriggers.some((t) => t.sourceId === o.id && t.ab?.on?.event === "chapter")) return false;
    return !this.state.stack.some((id) => { const a = this.state.objects[id]; return a && a.isAbility && a.sourceId === o.id && a.ab?.on?.event === "chapter"; });
  },

  // ================================================================ emblems
  /** Give player `p` an emblem. `abilities` are static / triggered abilities (triggered ones function from the emblem). */
  createEmblem(p, { name = "Emblem", text = "", abilities = [] } = {}) {
    const st = this.state;
    const def = normalizeDef({
      name, cost: "", cmc: 0, types: ["emblem"], supertypes: [], subtypes: [], colors: [], text,
      abilities: abilities.map((a) => (a.kind === "triggered" ? { ...a, zone: "emblem" } : a)),
    });
    const o = this.newObj(null, def, p, "emblem");
    (st.emblems ||= []).push(o.id);
    this.markDirty();
    this.emit({ t: "emblem", obj: o.id, player: p, text: `${this.pname(p)} gets an emblem: ${text || name}` });
    this.refresh();
    return o;
  },
  emblemsOf(p) { return (this.state.emblems || []).map((id) => this.state.objects[id]).filter((o) => o && (p == null || o.owner === p)); },

  // ================================================================ the monarch (CR 724)
  becomeMonarch(p) {
    const st = this.state;
    if (st.monarch === p) return;
    st.monarch = p;
    this.emit({ t: "monarch", player: p, text: `${this.pname(p)} becomes the monarch` });
    this.markDirty();
    this.fireTrigger({ type: "becameMonarch", player: p });
  },
  /** A creature dealt combat damage to the monarch: its controller becomes the monarch (a trigger). */
  monarchHit(src, p) {
    const st = this.state;
    if (st.monarch !== p || !src || !src.c || !src.c.types.includes("creature")) return;
    const who = src.controller ?? src.owner;
    if (who === p) return;
    this.pendInternal(src, who, { kind: "triggered", text: "The monarch was dealt combat damage: you become the monarch.", run: function* (g, ctx) { g.becomeMonarch(ctx.you); } }, null);
  },

  // ================================================================ per-step turn-based actions
  /** Called by beginStep$ right after the step starts (before "at the beginning of …" triggers). */
  m4StepStart(name) {
    const st = this.state, a = st.active, pl = st.players[a];
    if (name === "main1" && st.mainIndex === 0) {
      // CR 714.3b: each Saga its controller controls gets a lore counter
      for (const id of [...st.battlefield]) {
        const o = st.objects[id];
        if (o && o.zone === "battlefield" && o.controller === a && o.c.subtypes.includes("saga") && this.finalChapter(o)) this.addCounters(o, "lore", 1);
      }
      // rad counters (CR 727): at the beginning of your precombat main phase, mill that many cards; each nonland one costs 1 life and a rad counter
      if (pl && (pl.counters.rad | 0) > 0) {
        this.pendInternal(null, a, { kind: "triggered", text: "Rad counters: mill cards equal to the number of rad counters; for each nonland card milled this way, lose 1 life and remove a rad counter.",
          run: function* (g, ctx) {
            const me = g.state.players[ctx.you];
            const milled = g.mill(ctx.you, me.counters.rad | 0);
            const n = milled.filter((o) => !o.def.types.includes("land")).length;
            if (n) {
              if (g._statics.some((s) => s.st.type === "radGain" && s.you === ctx.you)) g.gainLife(ctx.you, n); // Strong, the Brutish Thespian
              else g.loseLife(ctx.you, n);
              g.addPlayerCounters(ctx.you, "rad", -n);
            }
          } }, null);
      }
    }
    if (name === "end" && st.monarch === a) {
      this.pendInternal(null, a, { kind: "triggered", text: "The monarch: at the beginning of your end step, draw a card.", run: function* (g, ctx) { yield* g.drawCards$(ctx.you, 1); } }, null);
    }
  },

  // ================================================================ temporary triggers
  /** "Until <your next turn | end of turn>, whenever <on>, <run>" — a persistent delayed trigger that expires with the effect clock. */
  addTempTrigger(on, run, ctx, until = "yourNextTurn", opts = {}) {
    this.addDelayed(on, null, ctx, false, run);
    const d = this.state.delayed[this.state.delayed.length - 1];
    if (until === "endOfPlayerTurn") d.untilEndOfTurnOf = opts.player; // "until the end of <that player>'s next turn"
    else d.until = until;
    return d;
  },

  // ================================================================ casting from a script
  /** Cast `o` (exile/graveyard/hand) now, paying its mana cost normally; `opts.spendAs` = "color" | "type" ("spend mana as though …"). True if it went on the stack. */
  *castPaid$(p, o, opts = {}) {
    if (!o || o.zone === "gone" || o.zone === "stack" || !o.def || o.def.types.includes("land")) return false;
    const v = { variant: "normal", face: 0, ...(opts.spendAs ? { spendAs: opts.spendAs } : {}) };
    let cost;
    try { cost = this.spellCost(p, o, v); } catch { return false; }
    if (!cost || (!cost.x && !this.canPayMana(p, { ...cost, x: 0 }))) return false;
    yield* this.cast$(p, { type: "cast", obj: o.id, objRef: o, _v: v });
    return o.zone === "stack";
  },

  // ================================================================ attack costs ("can't attack you unless …pays {2} for each")
  /** Filter the declared attacks by the attack-tax statics ({type:"attackTax", amount}) protecting a player: the attacker pays
   *  `amount` generic per taxed creature; creatures it can't pay for are dropped (it chooses which). Returns the attacks that remain. */
  *attackTax$(a, attacks) {
    const st = this.state;
    const taxes = this._statics.filter((s) => s.st.type === "attackTax");
    if (!taxes.length || !attacks.length) return attacks;
    const per = (at) => taxes.reduce((n, s) => n + (at.defender === "P" + s.you && s.you !== a ? (+s.st.amount || 0) : 0), 0);
    const taxed = attacks.filter((at) => per(at) > 0);
    if (!taxed.length) return attacks;
    const total = (list) => list.reduce((n, at) => n + per(at), 0);
    const can = (n) => n <= 0 || this.canPayMana(a, { ...this.parseCost(`{${n}}`), x: 0 });
    let keep = [...taxed];
    if (!can(total(keep))) {
      let max = 0;
      while (max < keep.length && can(total(keep.slice(0, max + 1)))) max++;
      const drop = keep.length - max;
      const objs = keep.map((at) => st.objects[at.obj]);
      const dropped = drop > 0 ? yield* this.chooseObjects$(a, objs, { prompt: `You can't pay the attack cost for every creature — choose ${drop} that won't attack`, min: drop, max: drop, reason: "generic" }) : [];
      keep = keep.filter((at) => !dropped.some((o) => o.id === at.obj));
    }
    const n = total(keep);
    if (n > 0) { this.log(`${this.pname(a)} pays {${n}} to attack`); yield* this.payMana$(a, { ...this.parseCost(`{${n}}`), x: 0 }); }
    return attacks.filter((at) => per(at) <= 0 || keep.includes(at));
  },
  parseCost(str) { return parseManaCost(str); },

  // ================================================================ "milled" events
  /** Fire the mill triggers for `cards` just milled from p's library: one `milled` per card, then one batch `milledCards` (CR 701.17). Batched across players inside mill$ ops. */
  milledEvents(p, cards) {
    if (this._millBatch) { this._millBatch.push({ p, cards }); return; }
    this.fireMilled([{ p, cards }]);
  },
  fireMilled(groups) {
    for (const { p, cards } of groups) for (const o of cards) this.fireTrigger({ type: "milled", obj: o, player: p });
    const all = groups.flatMap((g2) => g2.cards);
    if (!all.length) return;
    this.fireTrigger({ type: "milledCards", objs: all, nonland: all.filter((o) => !o.def.types.includes("land")).length, player: groups[0].p });
  },

  // ================================================================ activation cost modifiers
  /** The cost of activating `ab` of `o` for player p after modifiers: `cost.costReduce:{amount}` (Mariposa Military Base, Crown of Gondor with `cond`)
   *  and statics {type:"activateCostMod", filter, amount, firstPerTurn} (Tezzeret: the first activated ability of an artifact each turn). */
  effCost(o, ab, p) {
    const cost = ab.cost || {};
    let delta = 0;
    const ctx = { source: o, you: p, quiet: true };
    if (cost.costReduce && cost.mana && (!cost.costReduce.cond || this.evalCond(cost.costReduce.cond, ctx))) delta -= this.amount(cost.costReduce.amount, ctx);
    for (const s of this._statics) {
      if (s.st.type !== "activateCostMod" || s.you !== p || o.zone !== "battlefield") continue;
      if (s.st.filter && !this.matches(o, s.st.filter, { source: s.src, you: s.you }, "*")) continue;
      if (s.st.firstPerTurn) { const t = this.state.actTally; if (t && t.turn === this.state.turn && (t[p + ":" + (s.st.key || "")] | 0) > 0) continue; }
      delta += this.amount(s.st.amount ?? -1, { source: s.src, you: s.you });
    }
    if (!delta || !cost.mana) return cost;
    const c = parseManaCost(cost.mana);
    c.generic = Math.max(0, c.generic + delta);
    return { ...cost, mana: costToStringLocal(c) };
  },
  /** Remember that p activated an ability of `o` (Tezzeret's "first … each turn"). */
  noteActivation(p, o) {
    const st = this.state;
    if (!st.actTally || st.actTally.turn !== st.turn) st.actTally = { turn: st.turn };
    for (const s of this._statics) if (s.st.type === "activateCostMod" && s.st.firstPerTurn && s.you === p && (!s.st.filter || this.matches(o, s.st.filter, { source: s.src, you: s.you }, "*"))) st.actTally[p + ":" + (s.st.key || "")] = (st.actTally[p + ":" + (s.st.key || "")] | 0) + 1;
  },
};

function costToStringLocal(c) {
  let s = "";
  if (c.generic) s += `{${c.generic}}`;
  if (c.x) s += "{X}".repeat(c.x);
  for (const k of ["W", "U", "B", "R", "G", "C"]) s += `{${k}}`.repeat(c[k] | 0);
  for (const h of c.hybrid || []) s += `{${h.join("/")}}`;
  for (const ph of c.phyrexian || []) s += `{${ph}/P}`;
  return s || "{0}";
}
