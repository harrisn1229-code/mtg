// engine-m4.js — library batch m4 mechanics, mixed into the Game prototype (see SPEC-NOTES.md "Library automation: m4"):
//   * Sagas (lore counters, chapter triggers, sacrifice after the last chapter)      -> sagaChapters, finalChapter, sagaDone
//   * emblems (permanent statics/triggers that live outside every zone)             -> createEmblem
//   * the monarch, rad counters, per-step turn-based actions                         -> becomeMonarch, m4StepStart
//   * temporary triggered abilities ("until your next turn, whenever …")             -> addTempTrigger
// Every generator ends in `$` and is called with `yield*`.
import { normalizeDef } from "./engine-util.js";

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
            if (n) { g.loseLife(ctx.you, n); g.addPlayerCounters(ctx.you, "rad", -n); }
          } }, null);
      }
    }
    if (name === "end" && st.monarch === a) {
      this.pendInternal(null, a, { kind: "triggered", text: "The monarch: at the beginning of your end step, draw a card.", run: function* (g, ctx) { yield* g.drawCards$(ctx.you, 1); } }, null);
    }
  },

  // ================================================================ temporary triggers
  /** "Until <your next turn | end of turn>, whenever <on>, <run>" — a persistent delayed trigger that expires with the effect clock. */
  addTempTrigger(on, run, ctx, until = "yourNextTurn") {
    this.addDelayed(on, null, ctx, false, run);
    const d = this.state.delayed[this.state.delayed.length - 1];
    d.until = until;
    return d;
  },
};
