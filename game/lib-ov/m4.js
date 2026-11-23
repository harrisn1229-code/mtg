// lib-ov/m4.js — overrides for deck-library cards, batch m4 (planeswalkers, Sagas, Classes, Level up, Cases).
// Keyed by exact card name. Same format and conventions as overrides-1.js; import helpers with
//   import { H } from "../overrides-1.js";
// Engine support lives in engine-m4.js (see SPEC-NOTES.md "Library automation: m4").
import { H } from "../overrides-1.js";

const { out, T } = H;

// ------------------------------------------------------------------------------------------------ helpers
/** A Saga chapter ability: "I, II — …". `body` = { targets?, effects? | run?, modes?, optional? }. */
const chapter = (chapters, text, body) => ({ kind: "triggered", on: { event: "chapter", who: "self", chapters }, ...body, text });
/** def.abilities with every chapter ability touching one of `chapters` removed, then `abs` added. */
function withChapters(def, abs) {
  const nums = new Set(abs.flatMap((a) => a.on.chapters));
  const keep = (def.abilities || []).filter((a) => !(a.kind === "triggered" && a.on?.event === "chapter" && a.on.chapters.some((n) => nums.has(n))));
  const all = [...keep, ...abs];
  // keep chapter abilities in chapter order after the non-chapter ones
  const nonCh = all.filter((a) => !(a.kind === "triggered" && a.on?.event === "chapter"));
  const ch = all.filter((a) => a.kind === "triggered" && a.on?.event === "chapter").sort((a, b) => a.on.chapters[0] - b.on.chapters[0]);
  return [...nonCh, ...ch];
}
/** Patch for a Saga: replace the listed chapters; everything else the parser produced stays. */
const saga = (...abs) => ({ patch: (def) => out(def, { abilities: withChapters(def, abs) }) });
/** A loyalty ability. */
const loyalty = (n, text, body) => ({ kind: "activated", loyalty: true, sorcery: true, limit: "turn", cost: { loyalty: n }, ...body, text });
/** def.abilities with the loyalty abilities whose text starts with `prefix` (e.g. "-2") removed, then `abs` added in printed order. */
function withLoyalty(def, abs) {
  const key = (a) => (a.text || "").replace(/^\[?([+\-−]?\d+|[+\-−]?X)\]?:.*$/s, "$1").replace("−", "-").toLowerCase();
  const keys = new Set(abs.map(key));
  const keep = (def.abilities || []).filter((a) => !(a.kind === "activated" && a.loyalty && keys.has(key(a))));
  return [...keep, ...abs];
}
/** Patch for a planeswalker. Abilities are matched by their loyalty cost text ("+1", "-2", "0", "-X"). Two abilities with the same cost (Garruk, Apex Predator) are all replaced. */
const walker = (...abs) => ({ patch: (def) => out(def, { abilities: withLoyalty(def, abs) }) });
const plus = (def, ...abs) => [...(def.abilities || []), ...abs];
const SAGA_ONLY = (def) => out(def, {});
/** Add abilities to whatever the parser produced (the card's other lines stay); every unparsed line is considered handled. */
const plusAbs = (...abs) => ({ patch: (def) => out(def, { abilities: [...(def.abilities || []), ...abs] }) });

const tok = (name, types, subtypes, colors, power, toughness, keywords) => ({ name, types, subtypes, colors, power, toughness, ...(keywords ? { keywords } : {}) });
/** Chosen-by-you opponent-neutral choose: first of `objs` by AI/human via chooseObjects$. */
const SAGA_SRC = (ctx) => ctx.source;
const you = (ctx) => ctx.you;
const opps = (g, ctx) => g.opponentsOf(ctx.you);

/** Exile "up to one target" permanent of each player until the Saga leaves the battlefield (both players' targets were chosen as it went on the stack). */
function* exileUntilLeaves$(g, ctx) {
  const src = ctx.source ? g.obj(ctx.source.id) : null;
  for (const grp of ctx.targets || []) for (const id of grp || []) {
    const o = g.obj(id);
    if (!o || o.zone !== "battlefield") continue;
    if (!src || src.zone !== "battlefield" || src.ts !== ctx.source.ts) { continue; } // the Saga is already gone: the duration is over, nothing is exiled (CR 610.3c-ish)
    yield* g.runEffects$([{ op: "exile", what: id, until: "sourceLeaves" }], ctx);
  }
}
/** Target specs "for each player: up to one other target …" (1v1: you and the opponent). */
const perPlayerSpecs = (base) => [
  { what: { ...base, controller: "you" }, min: 0, max: 1 },
  { what: { ...base, controller: "opponent" }, min: 0, max: 1 },
];

/** The cards `src` exiled with its "until it leaves" links (still in exile). */
const linkedCards = (g, src) => g.state.links.filter((l) => l.sourceId === src.id).map((l) => g.obj(l.objId)).filter((o) => o && o.zone === "exile");

// shared inline effects
const monarchEffect = { op: "becomeMonarch", text: "You become the monarch.", run: function* (g, ctx) { g.becomeMonarch(ctx.you); } };
const sagaLore = (g, ctx) => g.obj(ctx.source.id)?.counters?.lore | 0;

export default {
  // ================================================================================================ SAGAS
  "In the Darkness Bind Them": saga(chapter([4], "IV — For each opponent, gain control of up to one target creature that player controls until end of turn. Untap those creatures. They gain haste until end of turn. The Ring tempts you.", {
    targets: [{ what: { types: ["creature"], controller: "opponent" }, min: 0, max: 1 }],
    effects: [
      { op: "gainControl", what: T(0), until: "endOfTurn" },
      { op: "untap", what: T(0) },
      { op: "pump", what: T(0), power: 0, toughness: 0, keywords: ["haste"], until: "endOfTurn" },
      { op: "ringTempts", who: "you" },
    ],
  })),

  "Oath of Eorl": saga(chapter([3], "III — Put an indestructible counter on up to one target Human. You become the monarch.", {
    targets: [{ what: { types: ["creature"], subtypes: ["human"] }, min: 0, max: 1 }],
    effects: [{ op: "addCounters", what: T(0), kind: "indestructible", amount: 1 }, monarchEffect],
  })),

  "Vault 101: Birthday Party": saga(
    chapter([1], "I — Create a 1/1 white Human Soldier creature token and a Food token.", {
      effects: [{ op: "createToken", who: "you", token: tok("Human Soldier", ["creature"], ["human", "soldier"], ["W"], 1, 1), amount: 1 }, { op: "createToken", who: "you", token: "food", amount: 1 }],
    }),
    chapter([2, 3], "II, III — You may put an Aura or Equipment card from your hand or graveyard onto the battlefield. If an Equipment is put onto the battlefield this way, you may attach it to a creature you control.", {
      effects: [{
        op: "putAuraOrEquipment",
        run: function* (g, ctx) {
          const p = ctx.you, pl = g.state.players[p];
          const hostsFor = (a) => g.state.battlefield.map((id) => g.obj(id)).filter((h) => h && g.auraLegal(a, h));
          const cands = [...pl.hand, ...pl.graveyard].map((id) => g.obj(id)).filter((o) => o && (o.def.subtypes.includes("equipment") || (o.def.subtypes.includes("aura") && hostsFor(o).length)));
          if (!cands.length) return;
          const [c] = yield* g.chooseObjects$(p, cands, { prompt: "Vault 101: Birthday Party — put an Aura or Equipment card onto the battlefield (or none)", min: 0, max: 1, reason: "return", source: ctx.source?.id });
          if (!c) return;
          if (c.def.subtypes.includes("aura")) {
            const hosts = hostsFor(c);
            const [h] = yield* g.chooseObjects$(p, hosts, { prompt: `Attach ${c.c.name} to which permanent?`, min: 1, max: 1, reason: "target", source: ctx.source?.id });
            yield* g.moveTo$(c, "battlefield", { controller: p, attachTo: h?.id });
          } else {
            yield* g.moveTo$(c, "battlefield", { controller: p });
            const mine = g.find({ types: ["creature"], controller: "you" }, ctx);
            const eq = g.obj(c.id);
            if (eq && eq.zone === "battlefield" && mine.length) {
              const [h] = yield* g.chooseObjects$(p, mine, { prompt: `Attach ${eq.c.name} to a creature you control? (choose none to leave it unattached)`, min: 0, max: 1, reason: "target", source: ctx.source?.id });
              if (h) g.attach(eq, h);
            }
          }
        },
      }],
    })),

  "Vault 21: House Gambit": saga(chapter([3], "III — Reveal up to five nonland cards from your hand. For each of those cards that has the same mana value as another card revealed this way, create a Treasure token.", {
    effects: [{
      op: "revealForTreasure",
      run: function* (g, ctx) {
        const p = ctx.you;
        const hand = g.state.players[p].hand.map((id) => g.obj(id)).filter((o) => o && !o.def.types.includes("land"));
        if (!hand.length) return;
        const picked = yield* g.chooseObjects$(p, hand, { prompt: "Vault 21: House Gambit — reveal up to five nonland cards from your hand", min: 0, max: Math.min(5, hand.length), reason: "reveal", source: ctx.source?.id });
        if (!picked.length) return;
        g.emit({ t: "reveal", objs: picked.map((o) => o.id), player: p, text: `${g.state.players[p].name} reveals ${picked.map((o) => o.c.name).join(", ")}` });
        const n = picked.filter((o) => picked.some((q) => q !== o && (q.c.cmc | 0) === (o.c.cmc | 0))).length;
        if (n) g.createToken(p, "treasure", n);
      },
    }],
  })),

  "Vault 13: Dweller's Journey": saga(
    chapter([1], "I — For each player, exile up to one other target enchantment or creature that player controls until this Saga leaves the battlefield.", {
      targets: perPlayerSpecs({ types: ["enchantment", "creature"], other: true }),
      effects: [{ op: "exileUntilLeaves", run: exileUntilLeaves$ }],
    }),
    chapter([3], "III — Return two cards exiled with this Saga to the battlefield under their owners' control and put the rest on the bottom of their owners' libraries.", {
      effects: [{
        op: "returnTwo",
        run: function* (g, ctx) {
          const src = g.obj(ctx.source.id);
          const cards = linkedCards(g, src);
          if (!cards.length) return;
          const n = Math.min(2, cards.length);
          const back = yield* g.chooseObjects$(ctx.you, cards, { prompt: `Vault 13: Dweller's Journey — choose ${n} exiled card${n > 1 ? "s" : ""} to return to the battlefield`, min: n, max: n, reason: "return", source: src.id });
          const rest = cards.filter((c) => !back.includes(c));
          for (const c of back) yield* g.moveTo$(c, "battlefield", { controller: c.owner });
          for (const c of rest) yield* g.moveTo$(c, "library", { position: "bottom" });
        },
      }],
    })),

  "Vault 112: Sadistic Simulation": saga(
    chapter([1, 2], "I, II — Tap up to one target creature and put a stun counter on it. You get {E}{E}.", {
      targets: [{ what: { types: ["creature"] }, min: 0, max: 1 }],
      effects: [{ op: "tap", what: T(0) }, { op: "addCounters", what: T(0), kind: "stun", amount: 1 }, { op: "energy", run: function* (g, ctx) { g.addPlayerCounters(ctx.you, "energy", 2); } }],
    }),
    chapter([3], "III — Pay any amount of {E}. If you paid one or more {E} this way, shuffle your library, then exile that many cards from the top. You may play one of those cards without paying its mana cost.", {
      effects: [{
        op: "payEnergy",
        run: function* (g, ctx) {
          const p = ctx.you, pl = g.state.players[p];
          const have = pl.counters.energy | 0;
          if (have <= 0) return;
          const n = yield* g.number$(p, "Sadistic Simulation: pay how many {E}?", 0, have, ctx.source?.id);
          if (n <= 0) return;
          g.addPlayerCounters(p, "energy", -n);
          g.shuffle(p);
          const exiled = [];
          for (let i = 0; i < n && pl.library.length; i++) { const top = g.obj(pl.library[pl.library.length - 1]); g.moveObj(top, "exile"); exiled.push(top); }
          const playable = exiled.filter((o) => o.zone === "exile" && (o.def.types.includes("land") ? pl.landsPlayed < pl.landsPerTurn : true));
          if (!playable.length) return;
          const [c] = yield* g.chooseObjects$(p, playable, { prompt: "Sadistic Simulation — you may play one of the exiled cards without paying its mana cost", min: 0, max: 1, reason: "exile", source: ctx.source?.id });
          if (!c) return;
          if (c.def.types.includes("land")) { pl.landsPlayed++; yield* g.enter$(c, { controller: p }); g.fireTrigger({ type: "landPlayed", obj: c, player: p }); }
          else yield* g.castFree$(p, c, {});
        },
      }],
    })),

  "Vault 12: The Necropolis": saga(
    chapter([1], "I — Each player gets three rad counters.", { effects: [{ op: "rad", run: function* (g) { for (const q of g.state.players) if (!q.lost) g.addPlayerCounters(q.idx, "rad", 3); } }] }),
    chapter([2], "II — Create X 2/2 black Zombie Mutant creature tokens, where X is the total number of rad counters among players.", {
      effects: [{ op: "zombies", run: function* (g, ctx) { const x = g.state.players.reduce((n, q) => n + (q.counters.rad | 0), 0); if (x) g.createToken(ctx.you, tok("Zombie Mutant", ["creature"], ["zombie", "mutant"], ["B"], 2, 2), x); } }],
    }),
    chapter([3], "III — Put two +1/+1 counters on each creature you control that's a Zombie or Mutant.", {
      effects: [{ op: "addCounters", what: { ref: "all", filter: { types: ["creature"], controller: "you", subtypes: ["zombie", "mutant"] } }, kind: "+1/+1", amount: 2 }],
    })),

  "Vault 87: Forced Evolution": saga(
    chapter([1], "I — Gain control of target non-Mutant creature for as long as you control this Saga.", {
      targets: [{ what: { types: ["creature"], notSubtypes: ["mutant"] } }],
      effects: [{ op: "gainControl", what: T(0), until: "sourceControlled" }],
    }),
    chapter([2], "II — Put a +1/+1 counter on target creature you control. It becomes a Mutant in addition to its other types.", {
      targets: [{ what: { types: ["creature"], controller: "you" } }],
      effects: [{ op: "addCounters", what: T(0), kind: "+1/+1", amount: 1 }, {
        op: "becomeMutant",
        run: function* (g, ctx) { for (const id of ctx.targets?.[0] || []) { const o = g.obj(id); if (o && o.zone === "battlefield") g.addEffect({ type: "asType", addSubtypes: ["mutant"] }, ctx, { objIds: [o.id], until: "forever" }); } },
      }],
    })),

  "Vault 11: Voter's Dilemma": saga(
    chapter([1], "I — For each opponent, you create a 1/1 white Human Soldier creature token.", {
      effects: [{ op: "createToken", who: "you", token: tok("Human Soldier", ["creature"], ["human", "soldier"], ["W"], 1, 1), amount: { numOpponents: true } }],
    }),
    chapter([2, 3], "II, III — Each player secretly votes for up to one creature, then those votes are revealed. If no creature got votes, each player draws a card. Otherwise, destroy each creature with the most votes or tied for most votes.", {
      effects: [{
        op: "vote",
        run: function* (g, ctx) {
          const creatures = g.find({ types: ["creature"] }, ctx);
          const votes = new Map();
          const order = g.apnap(g.state.players.filter((q) => !q.lost).map((q) => q.idx));
          const first = order.indexOf(ctx.you);
          const ring = first > 0 ? [...order.slice(first), ...order.slice(0, first)] : order;
          for (const q of ring) {
            if (!creatures.length) break;
            const [v] = yield* g.chooseObjects$(q, creatures, { prompt: "Voter's Dilemma — vote for up to one creature", min: 0, max: 1, reason: "target", source: ctx.source?.id });
            if (v) votes.set(v, (votes.get(v) || 0) + 1);
          }
          if (!votes.size) { for (const q of ring) g.draw(q, 1); return; }
          const top = Math.max(...votes.values());
          g.log(`Votes: ${[...votes].map(([o, n]) => `${o.c.name} ${n}`).join(", ")}`);
          for (const [o, n] of votes) if (n === top) g.destroy(o);
        },
      }],
    })),

  // ---- Final Fantasy "Summon" Sagas
  "Summon: Kujata": saga(
    chapter([1], "I — Lightning — This creature deals 3 damage to each of up to two target creatures.", {
      targets: [{ what: { types: ["creature"] }, min: 0, max: 2 }],
      effects: [{ op: "damage", amount: 3, to: T(0) }],
    }),
    chapter([3], "III — Fire — Discard a card, then draw two cards. When you discard a card this way, this creature deals damage equal to that card's mana value to each opponent.", {
      effects: [{
        op: "fire",
        run: function* (g, ctx) {
          const p = ctx.you, src = ctx.source;
          let mv = null;
          const hand = g.state.players[p].hand.map((id) => g.obj(id));
          if (hand.length) {
            const [d] = yield* g.chooseObjects$(p, hand, { prompt: "Summon: Kujata — discard a card", min: 1, max: 1, reason: "discard", source: src?.id });
            if (d) { mv = d.def.cmc | 0; g.discardCard(d); }
          }
          yield* g.drawCards$(p, 2);
          if (mv != null) g.pendInternal(src, p, { kind: "triggered", text: "When you discard a card this way, this creature deals damage equal to that card's mana value to each opponent.",
            run: function* (g2, c2) { for (const q of g2.opponentsOf(c2.you)) g2.dealDamage(src, "P" + q, mv); } }, null);
        },
      }],
    })),

  "Summon: Ixion": saga(chapter([2, 3], "II, III — Put a +1/+1 counter on each of up to two target creatures you control. You gain 2 life.", {
    targets: [{ what: { types: ["creature"], controller: "you" }, min: 0, max: 2 }],
    effects: [{ op: "addCounters", what: T(0), kind: "+1/+1", amount: 1 }, { op: "gainLife", who: "you", amount: 2 }],
  })),

  "Summon: Yojimbo": saga(
    chapter([2, 3], "II, III — Until your next turn, creatures can't attack you unless their controller pays {2} for each of those creatures.", {
      effects: [{ op: "attackTax", run: function* (g, ctx) { g.addEffect({ type: "attackTax", amount: 2 }, ctx, { until: "yourNextTurn" }); } }],
    }),
    chapter([4], "IV — Create X Treasure tokens, where X is the number of opponents who control a creature with power 4 or greater.", {
      effects: [{ op: "treasures", run: function* (g, ctx) {
        const x = opps(g, ctx).filter((q) => g.find({ types: ["creature"], power: { op: ">=", n: 4 } }, ctx).some((o) => o.controller === q)).length;
        if (x) g.createToken(ctx.you, "treasure", x);
      } }],
    })),

  "Summon: Valefor": saga(chapter([1], "I — Sonic Wings — Each opponent chooses a creature with the greatest mana value among creatures they control. Return those creatures to their owners' hands.", {
    effects: [{ op: "sonicWings", run: function* (g, ctx) {
      const picked = [];
      for (const q of g.apnap(opps(g, ctx))) {
        const mine = g.find({ types: ["creature"] }, ctx).filter((o) => o.controller === q);
        if (!mine.length) continue;
        const top = Math.max(...mine.map((o) => o.c.cmc | 0));
        const [c] = yield* g.chooseObjects$(q, mine.filter((o) => (o.c.cmc | 0) === top), { prompt: "Sonic Wings — choose a creature with the greatest mana value you control", min: 1, max: 1, reason: "return", source: ctx.source?.id });
        if (c) picked.push(c);
      }
      for (const c of picked) g.bounce(c);
    } }],
  })),

  "Summon: Magus Sisters": saga(chapter([1, 2, 3], "I, II, III — Choose one at random — • Combine Powers! — Put three +1/+1 counters on target creature. • Defense! — Put a shield counter on target creature. You gain 3 life. • Fight! — This creature fights up to one target creature an opponent controls.", {
    effects: [],
    modes: { min: 1, max: 1, random: true, modes: [
      { text: "Combine Powers! — Put three +1/+1 counters on target creature.", targets: [{ what: { types: ["creature"] } }], effects: [{ op: "addCounters", what: T(0), kind: "+1/+1", amount: 3 }] },
      { text: "Defense! — Put a shield counter on target creature. You gain 3 life.", targets: [{ what: { types: ["creature"] } }], effects: [{ op: "addCounters", what: T(0), kind: "shield", amount: 1 }, { op: "gainLife", who: "you", amount: 3 }] },
      { text: "Fight! — This creature fights up to one target creature an opponent controls.", targets: [{ what: { types: ["creature"], controller: "opponent" }, min: 0, max: 1 }], effects: [{ op: "fight", a: "self", b: T(0) }] },
    ] },
  })),

  "Summon: Esper Valigarmanda": saga(
    chapter([1], "I — Exile an instant or sorcery card from each graveyard.", {
      effects: [{ op: "exileSpells", run: function* (g, ctx) {
        const src = g.obj(ctx.source.id);
        const ids = [];
        for (const q of g.state.players) {
          const cands = q.graveyard.map((id) => g.obj(id)).filter((o) => o && (o.def.types.includes("instant") || o.def.types.includes("sorcery")));
          if (!cands.length) continue;
          const [c] = yield* g.chooseObjects$(ctx.you, cands, { prompt: `Esper Valigarmanda — exile an instant or sorcery card from ${q.name}'s graveyard`, min: 1, max: 1, reason: "exile", source: src?.id });
          if (c && g.moveObj(c, "exile")) ids.push(c.id);
        }
        if (src) src.exiledWith = { ts: src.ts, ids: [...(src.exiledWith?.ts === src.ts ? src.exiledWith.ids : []), ...ids] };
      } }],
    }),
    chapter([2, 3, 4], "II, III, IV — Add {R} for each lore counter on this Saga. You may cast an instant or sorcery card exiled with this Saga, and mana of any type can be spent to cast that spell.", {
      effects: [{ op: "addMana", mana: { color: "R", n: { countersOn: "self", kind: "lore" } } }, { op: "castExiled", run: function* (g, ctx) {
        const src = g.obj(ctx.source.id);
        if (!src || src.exiledWith?.ts !== src.ts) return;
        const cands = src.exiledWith.ids.map((id) => g.obj(id)).filter((o) => o && o.zone === "exile");
        const ok = [];
        for (const o of cands) { try { const c = g.spellCost(ctx.you, o, { variant: "normal", face: 0, spendAs: "type" }); if (g.canPayMana(ctx.you, { ...c, x: 0 })) ok.push(o); } catch { /* not castable */ } }
        if (!ok.length) return;
        const [c] = yield* g.chooseObjects$(ctx.you, ok, { prompt: "Esper Valigarmanda — you may cast an exiled instant or sorcery card (any type of mana can pay)", min: 0, max: 1, reason: "exile", source: src.id });
        if (c) yield* g.castPaid$(ctx.you, c, { spendAs: "type" });
      } }],
    })),

  "Summon: Good King Mog XII": saga(chapter([2, 3], "II, III — Whenever you cast a noncreature spell this turn, create a token that's a copy of a non-Saga token you control.", {
    effects: [{ op: "mogTrigger", run: function* (g, ctx) {
      g.addTempTrigger({ event: "cast", who: "you", filter: { notTypes: ["creature"] } }, function* (g2, c2) {
        const toks = g2.find({ token: true, controller: "you", notSubtypes: ["saga"] }, c2);
        if (!toks.length) return;
        const [t] = yield* g2.chooseObjects$(c2.you, toks, { prompt: "Choose a non-Saga token you control to copy", min: 1, max: 1, reason: "generic", source: c2.source?.id });
        if (t) g2.createToken(c2.you, { copyOf: t }, 1);
      }, ctx, "endOfTurn");
    } }],
  })),

  // ---- other Sagas
  "The Mending of Dominaria": saga(
    chapter([1, 2], "I, II — Mill two cards, then you may return a creature card from your graveyard to your hand.", {
      effects: [{ op: "mill", who: "you", amount: 2 }, { op: "may", effects: [{ op: "move", what: { ref: "choose", filter: { zone: "graveyard", owner: "you", types: ["creature"] }, min: 1, max: 1, reason: "return", prompt: "Return a creature card from your graveyard to your hand" }, to: "hand" }] }],
    }),
    chapter([3], "III — Return all land cards from your graveyard to the battlefield, then shuffle your graveyard into your library.", {
      effects: [{ op: "move", what: { ref: "all", filter: { zone: "graveyard", owner: "you", types: ["land"] } }, to: "battlefield" }, {
        op: "shuffleGraveyard",
        run: function* (g, ctx) {
          const p = ctx.you;
          for (const id of [...g.state.players[p].graveyard]) { const o = g.obj(id); if (o) yield* g.moveTo$(o, "library", { position: "top", quiet: true }); }
          g.shuffle(p);
        },
      }],
    })),

  "King Narfi's Betrayal": saga(
    chapter([1], "I — Each player mills four cards. Then you may exile a creature or planeswalker card from each graveyard.", {
      effects: [{ op: "mill", who: "eachPlayer", amount: 4 }, { op: "exileFromYards", run: function* (g, ctx) {
        const src = g.obj(ctx.source.id);
        const ids = [];
        for (const q of g.state.players) {
          const cands = q.graveyard.map((id) => g.obj(id)).filter((o) => o && (o.def.types.includes("creature") || o.def.types.includes("planeswalker")));
          if (!cands.length) continue;
          const [c] = yield* g.chooseObjects$(ctx.you, cands, { prompt: `King Narfi's Betrayal — you may exile a creature or planeswalker card from ${q.name}'s graveyard`, min: 0, max: 1, reason: "exile", source: src?.id });
          if (c && g.moveObj(c, "exile")) ids.push(c.id);
        }
        if (src) src.exiledWith = { ts: src.ts, ids: [...(src.exiledWith?.ts === src.ts ? src.exiledWith.ids : []), ...ids] };
      } }],
    }),
    chapter([2, 3], "II, III — Until end of turn, you may cast spells from among cards exiled with this Saga, and you may spend mana as though it were mana of any color to cast those spells.", {
      effects: [{ op: "grantCast", run: function* (g, ctx) {
        const src = g.obj(ctx.source.id);
        if (!src || src.exiledWith?.ts !== src.ts) return;
        for (const id of src.exiledWith.ids) { const o = g.obj(id); if (o && o.zone === "exile") o.mayPlay = { player: ctx.you, untilTurn: g.state.turn, spendAs: "color" }; }
        g.markDirty();
      } }],
    })),

  "Battle at the Helvault": saga(
    chapter([1, 2], "I, II — For each player, exile up to one target non-Saga, nonland permanent that player controls until this Saga leaves the battlefield.", {
      targets: perPlayerSpecs({ notTypes: ["land"], notSubtypes: ["saga"] }),
      effects: [{ op: "exileUntilLeaves", run: exileUntilLeaves$ }],
    }),
    chapter([3], "III — Create Avacyn, a legendary 8/8 white Angel creature token with flying, vigilance, and indestructible.", {
      effects: [{ op: "createToken", who: "you", token: { ...tok("Avacyn", ["creature"], ["angel"], ["W"], 8, 8, { flying: true, vigilance: true, indestructible: true }), supertypes: ["legendary"] }, amount: 1 }],
    })),

  "Battle for Bretagard": saga(chapter([3], "III — Choose any number of artifact tokens and/or creature tokens you control with different names. For each of them, create a token that's a copy of it.", {
    effects: [{ op: "copyTokens", run: function* (g, ctx) {
      const all = g.find({ token: true, controller: "you", anyOf: [{ types: ["artifact"] }, { types: ["creature"] }] }, ctx);
      const byName = new Map();
      for (const o of all) if (!byName.has(o.c.name)) byName.set(o.c.name, o);
      const cands = [...byName.values()];
      if (!cands.length) return;
      const picked = yield* g.chooseObjects$(ctx.you, cands, { prompt: "Battle for Bretagard — choose any number of artifact/creature tokens with different names to copy", min: 0, max: cands.length, reason: "generic", source: ctx.source?.id });
      for (const t of picked) g.createToken(ctx.you, { copyOf: t }, 1);
    } }],
  })),

  "Love Song of Night and Day": saga(
    chapter([1], "I — You and target opponent each draw two cards.", {
      targets: [{ what: "opponent" }],
      effects: [{ op: "draw", who: "you", amount: 2 }, { op: "draw", who: T(0), amount: 2 }],
    }),
    chapter([3], "III — Put a +1/+1 counter on each of up to two target creatures.", {
      targets: [{ what: { types: ["creature"] }, min: 0, max: 2 }],
      effects: [{ op: "addCounters", what: T(0), kind: "+1/+1", amount: 1 }],
    })),

  "The Eldest Reborn": saga(chapter([3], "III — Put target creature or planeswalker card from a graveyard onto the battlefield under your control.", {
    targets: [{ what: { zone: "graveyard", types: ["creature", "planeswalker"] }, zone: "graveyard" }],
    effects: [{ op: "move", what: T(0), to: "battlefield", control: "you" }],
  })),

  "The Binding of the Titans": saga(chapter([2], "II — Exile up to two target cards from graveyards. For each creature card exiled this way, you gain 1 life.", {
    targets: [{ what: { zone: "graveyard" }, zone: "graveyard", min: 0, max: 2 }],
    effects: [{ op: "exileGain", run: function* (g, ctx) {
      let n = 0;
      for (const id of ctx.targets?.[0] || []) { const o = g.obj(id); if (o && o.zone === "graveyard") { const cre = o.def.types.includes("creature"); if (g.moveObj(o, "exile") && cre) n++; } }
      if (n) g.gainLife(ctx.you, n);
    } }],
  })),

  "The First Tyrannic War": saga(
    chapter([1], "I — You may put a creature card from your hand onto the battlefield. If its mana cost contains {X}, it enters with a number of +1/+1 counters on it equal to the number of lands you control.", {
      effects: [{ op: "putCreature", run: function* (g, ctx) {
        const p = ctx.you;
        const hand = g.state.players[p].hand.map((id) => g.obj(id)).filter((o) => o && o.def.types.includes("creature"));
        if (!hand.length) return;
        const [c] = yield* g.chooseObjects$(p, hand, { prompt: "The First Tyrannic War — you may put a creature card from your hand onto the battlefield", min: 0, max: 1, reason: "return", source: ctx.source?.id });
        if (!c) return;
        const lands = g.find({ types: ["land"], controller: "you" }, ctx).length;
        yield* g.moveTo$(c, "battlefield", { controller: p, ...(/\{X\}/i.test(c.def.cost || "") && lands ? { counters: { "+1/+1": lands } } : {}) });
      } }],
    }),
    chapter([2, 3], "II, III — Double the number of each kind of counter on target creature you control.", {
      targets: [{ what: { types: ["creature"], controller: "you" } }],
      effects: [{ op: "doubleCounters", run: function* (g, ctx) {
        const o = g.obj((ctx.targets?.[0] || [])[0]);
        if (!o || o.zone !== "battlefield") return;
        for (const [k, n] of Object.entries({ ...o.counters })) g.addCounters(o, k, n);
      } }],
    })),

  "The Horus Heresy": saga(
    chapter([1], "I — For each opponent, gain control of up to one target nonlegendary creature that player controls for as long as this Saga remains on the battlefield.", {
      targets: [{ what: { types: ["creature"], controller: "opponent", notSupertypes: ["legendary"] }, min: 0, max: 1 }],
      effects: [{ op: "gainControl", what: T(0), until: "sourceOnBattlefield" }],
    }),
    chapter([2], "II — Draw a card for each creature you control but don't own.", {
      effects: [{ op: "draw", who: "you", amount: { count: { types: ["creature"], controller: "you", owner: "opponent" } } }],
    }),
    chapter([3], "III — Starting with you, each player chooses a creature. Destroy each creature chosen this way.", {
      effects: [{ op: "chooseAndDestroy", run: function* (g, ctx) {
        const creatures = g.find({ types: ["creature"] }, ctx);
        const order = g.apnap(g.state.players.filter((q) => !q.lost).map((q) => q.idx));
        const i = order.indexOf(ctx.you);
        const ring = i > 0 ? [...order.slice(i), ...order.slice(0, i)] : order;
        const chosen = [];
        for (const q of ring) {
          if (!creatures.length) break;
          const [c] = yield* g.chooseObjects$(q, creatures, { prompt: "The Horus Heresy — choose a creature (it will be destroyed)", min: 1, max: 1, reason: "target", source: ctx.source?.id });
          if (c && !chosen.includes(c)) chosen.push(c);
        }
        for (const c of chosen) g.destroy(c);
      } }],
    })),

  "The War in Heaven": saga(chapter([3], "III — Choose up to three target creature cards with total mana value 8 or less in your graveyard. Return each of them to the battlefield with a necrodermis counter on it. They're artifacts in addition to their other types.", {
    targets: [{ what: { zone: "graveyard", owner: "you", types: ["creature"] }, zone: "graveyard", min: 0, max: 3, totalCmc: 8 }],
    effects: [{ op: "necrodermis", run: function* (g, ctx) {
      for (const id of ctx.targets?.[0] || []) {
        const o = g.obj(id);
        if (!o || o.zone !== "graveyard") continue;
        yield* g.moveTo$(o, "battlefield", { controller: ctx.you, counters: { necrodermis: 1 } });
        if (o.zone === "battlefield") g.addEffect({ type: "asType", addTypes: ["artifact"] }, ctx, { objIds: [o.id], until: "forever" });
      }
    } }],
  })),

  "Birth of the Imperium": saga(chapter([3], "III — Draw two cards for each opponent who controls fewer creatures than you.", {
    effects: [{ op: "drawFewer", run: function* (g, ctx) {
      const mine = g.find({ types: ["creature"], controller: "you" }, ctx).length;
      const n = opps(g, ctx).filter((q) => g.find({ types: ["creature"] }, ctx).filter((o) => o.controller === q).length < mine).length;
      if (n) yield* g.drawCards$(ctx.you, 2 * n);
    } }],
  })),

  "The Elder Dragon War": saga(chapter([2], "II — Discard any number of cards, then draw that many cards.", {
    effects: [{ op: "rummage", run: function* (g, ctx) {
      const hand = g.state.players[ctx.you].hand.map((id) => g.obj(id));
      if (!hand.length) return;
      const ch = yield* g.chooseObjects$(ctx.you, hand, { prompt: "The Elder Dragon War — discard any number of cards, then draw that many", min: 0, max: hand.length, reason: "discard", source: ctx.source?.id });
      for (const o of ch) g.discardCard(o);
      if (ch.length) yield* g.drawCards$(ctx.you, ch.length);
    } }],
  })),
  // ================================================================ monarch / rad counter cards (batch m3, owned by m4)
  "Champions of Minas Tirith": plusAbs({
    kind: "triggered", on: { event: "beginStep", step: "beginCombat", whose: "opponent" }, condition: { type: "monarch", who: "you" },
    text: "At the beginning of combat on each opponent's turn, if you're the monarch, that opponent may pay {X}, where X is the number of cards in their hand. If they don't, they can't attack you this combat.",
    effects: [{ op: "championsTax", run: function* (g, ctx) {
      const opp = g.state.active, n = g.state.players[opp].hand.length;
      let paid = n === 0;
      if (!paid) {
        const cost = { ...g.parseCost(`{${n}}`), x: 0 };
        if (g.canPayMana(opp, cost) && (yield* g.confirm$(opp, `Pay {${n}} so your creatures can attack ${g.pname(ctx.you)} this combat?`, ctx.source?.id, { kind: "tax", amount: n }))) { yield* g.payMana$(opp, cost); paid = true; }
      }
      if (paid) return;
      g.log(`${g.pname(opp)} can't attack ${g.pname(ctx.you)} this combat`);
      g.addEffect({ type: "cantAttackYou" }, ctx, { objIds: g.find({ types: ["creature"] }, ctx).filter((o) => o.controller === opp).map((o) => o.id), until: "endOfTurn" });
    } }],
  }),

  "Archivist of Gondor": plusAbs({
    kind: "triggered", on: { event: "dealsCombatDamage", who: { isCommander: true, controller: "you" }, to: "player" }, condition: { type: "monarch", who: "none" },
    text: "When your commander deals combat damage to a player, if there is no monarch, you become the monarch.", effects: [{ op: "becomeMonarch", who: "you" }],
  }),

  "Fealty to the Realm": plusAbs(
    { kind: "static", effect: { type: "monarchControls", affects: "enchanted" }, text: "The monarch controls enchanted creature." },
    { kind: "static", effect: { type: "mustAttack", affects: "enchanted" }, text: "Enchanted creature attacks each combat if able." },
    { kind: "static", effect: { type: "cantAttackYou", affects: "enchanted" }, text: "Enchanted creature can't attack you." }),

  "Éomer, King of Rohan": plusAbs({
    kind: "static", effect: { type: "entersWithCounters", kind: "+1/+1", amount: { count: { types: ["creature"], subtypes: ["human"], controller: "you", other: true } } },
    text: "Éomer enters with a +1/+1 counter on it for each other Human you control." }),

  "Forth Eorlingas!": { patch: (def) => out(def, { spell: { ...(def.spell || {}), effects: [...(def.spell?.effects || []), { op: "forthEorlingas", run: function* (g, ctx) {
    g.addTempTrigger({ event: "dealsCombatDamage", who: { types: ["creature"], controller: "you" }, to: "player", batch: true }, function* (g2, c2) { g2.becomeMonarch(c2.you); }, ctx, "endOfTurn");
  } }] } }) },

  "Crown of Gondor": plusAbs({
    kind: "activated", synthetic: "equip", sorcery: true, cost: { mana: "{4}", costReduce: { amount: 3, cond: { type: "monarch", who: "you" } } },
    targets: [{ what: { types: ["creature"], controller: "you", other: true } }], effects: [{ op: "attach", what: "self", to: { ref: "target", i: 0 } }],
    text: "Equip {4}. This ability costs {3} less to activate if you're the monarch." }),

  "Court of Ire": { patch: (def) => out(def, { abilities: def.abilities.map((a) => a.kind === "triggered" && a.on?.event === "beginStep" && a.on.step === "upkeep" ? {
    ...a, effects: [{ op: "courtOfIre", run: function* (g, ctx) {
      const t = ctx.targets?.[0]?.[0];
      if (t == null) return;
      g.dealDamage(ctx.source, t, g.state.monarch === ctx.you ? 7 : 2);
    } }] } : a) }) },

  "Palace Jailer": plusAbs({
    kind: "triggered", on: { event: "enters", who: "self" }, targets: [{ what: { types: ["creature"], controller: "opponent" } }],
    text: "When this creature enters, exile target creature an opponent controls until an opponent becomes the monarch.",
    effects: [{ op: "jailerExile", run: function* (g, ctx) {
      const id = ctx.targets?.[0]?.[0];
      const o = id && g.obj(id);
      if (!o || o.zone !== "battlefield") return;
      yield* g.runEffects$([{ op: "exile", what: id }], ctx);
      const x = g.obj(id);
      if (!x || x.zone !== "exile") return;
      const ts = x.ts;
      g.addDelayed({ event: "becameMonarch", who: "opponent" }, null, ctx, true, function* (g2) {
        const y = g2.obj(id);
        if (y && y.zone === "exile" && y.ts === ts) yield* g2.moveTo$(y, "battlefield", { controller: y.owner });
      });
    } }],
  }),

  "Regal Behemoth": plusAbs({
    kind: "triggered", on: { event: "tapped", who: { types: ["land"], controller: "you" }, forMana: true }, condition: { type: "monarch", who: "you" }, manaTrigger: true,
    text: "Whenever you tap a land for mana while you're the monarch, add an additional one mana of any color.", effects: [{ op: "addMana", mana: { any: 1 }, who: "you" }] }),

  "Azure Fleet Admiral": plusAbs({ kind: "static", effect: { type: "cantBeBlockedBy", affects: "self", byMonarch: true }, text: "This creature can't be blocked by creatures the monarch controls." }),

  "Regal Sliver": plusAbs({
    kind: "static", text: "Sliver creatures you control have \"When this creature enters, Slivers you control get +1/+1 until end of turn if you're the monarch. Otherwise, you become the monarch.\"",
    effect: { type: "pump", affects: { types: ["creature"], subtypes: ["sliver"], controller: "you" }, abilities: [{
      kind: "triggered", on: { event: "enters", who: "self" }, text: "When this creature enters, Slivers you control get +1/+1 until end of turn if you're the monarch. Otherwise, you become the monarch.",
      effects: [{ op: "regalSliver", run: function* (g, ctx) {
        if (g.state.monarch === ctx.you) g.addEffect({ type: "pump", power: 1, toughness: 1 }, ctx, { objIds: g.find({ types: ["creature"], subtypes: ["sliver"], controller: "you" }, ctx).map((o) => o.id), until: "endOfTurn" });
        else g.becomeMonarch(ctx.you);
      } }] }] } }),

  "Marchesa's Decree": plusAbs({
    kind: "triggered", on: { event: "attacks", who: { types: ["creature"] }, defending: "you" },
    text: "Whenever a creature attacks you or a planeswalker you control, that creature's controller loses 1 life.",
    effects: [{ op: "decree", run: function* (g, ctx) { const o = ctx.event?.obj; if (o) g.loseLife(o.controller, 1); } }] }),

  // ---- rad counters
  "The Wise Mothman": plusAbs({
    kind: "triggered", on: { event: "milledCards", who: "each", nonland: true }, targets: [{ what: { types: ["creature"] }, min: 0, max: { event: "amount" } }],
    text: "Whenever one or more nonland cards are milled, put a +1/+1 counter on each of up to X target creatures, where X is the number of nonland cards milled this way.",
    effects: [{ op: "addCounters", what: { ref: "target", i: 0 }, kind: "+1/+1", amount: 1 }] }),

  "The Master, Transcendent": plusAbs({
    kind: "activated", cost: { tap: true }, targets: [{ what: { zone: "graveyard", types: ["creature"], milledThisTurn: true }, zone: "graveyard" }],
    text: "{T}: Put target creature card in a graveyard that was milled this turn onto the battlefield under your control. It's a green Mutant with base power and toughness 3/3.",
    effects: [{ op: "masterReanimate", run: function* (g, ctx) {
      const o = g.obj(ctx.targets?.[0]?.[0]);
      if (!o || o.zone !== "graveyard") return;
      yield* g.moveTo$(o, "battlefield", { controller: ctx.you });
      if (o.zone === "battlefield") g.addEffect({ type: "asType", setSubtypes: ["mutant"], colors: ["G"], power: 3, toughness: 3 }, ctx, { objIds: [o.id], until: "forever" });
    } }] }),

  "Mirelurk Queen": plusAbs({
    kind: "triggered", on: { event: "milledCards", who: "each", nonland: true }, oncePerTurn: true,
    text: "Whenever one or more nonland cards are milled, draw a card, then put a +1/+1 counter on this creature. This ability triggers only once each turn.",
    effects: [{ op: "draw", who: "you", amount: 1 }, { op: "addCounters", what: "self", kind: "+1/+1", amount: 1 }] }),

  "Screeching Scorchbeast": plusAbs({
    kind: "triggered", on: { event: "milledCards", who: "each", nonland: true },
    text: "Whenever one or more nonland cards are milled, you may create that many 2/2 black Zombie Mutant creature tokens. Do this only once each turn.",
    effects: [{ op: "scorchbeast", run: function* (g, ctx) {
      const src = g.obj(ctx.source?.id);
      const n = ctx.event?.amount | 0;
      if (!src || !n || src.scorchTurn === g.state.turn) return;
      if (!(yield* g.confirm$(ctx.you, `Create ${n} 2/2 Zombie Mutant token${n > 1 ? "s" : ""}? (once each turn)`, ctx.source?.id, { kind: "may" }))) return;
      src.scorchTurn = g.state.turn;
      g.createToken(ctx.you, tok("Zombie Mutant", ["creature"], ["zombie", "mutant"], ["B"], 2, 2), n);
    } }] }),

  "Feral Ghoul": plusAbs({
    kind: "triggered", on: { event: "dies", who: "self" }, text: "When this creature dies, each opponent gets a number of rad counters equal to its power.",
    effects: [{ op: "getRadCounters", who: "opponent", amount: { powerOf: "self" } }] }),

  "Nuclear Fallout": { patch: (def) => out(def, { spell: { ...(def.spell || {}), effects: [{ op: "nuclearFallout", run: function* (g, ctx) {
    const x = ctx.x | 0;
    const ids = g.find({ types: ["creature"] }, ctx).map((o) => o.id);
    if (ids.length && x) g.addEffect({ type: "pump", power: -2 * x, toughness: -2 * x }, ctx, { objIds: ids, until: "endOfTurn" });
    for (const q of g.alivePlayers(true)) g.addPlayerCounters(q, "rad", x);
  } }] } }) },

  "Strong, the Brutish Thespian": plusAbs({ kind: "static", effect: { type: "radGain" }, text: "You gain life rather than lose life from radiation." }),

  "Bloatfly Swarm": plusAbs({ kind: "static", effect: { type: "damageToCounters", kind: "+1/+1", giveRad: true }, text: "If damage would be dealt to this creature while it has a +1/+1 counter on it, prevent that damage, remove that many +1/+1 counters from it, then give each player a rad counter for each +1/+1 counter removed this way." }),

  "Nightkin Ambusher": plusAbs({ kind: "static", effect: { type: "cantBeBlockedWhileDefenderHas", affects: "self", counter: "rad" }, text: "This creature can't be blocked as long as defending player has a rad counter." }),

  "Contaminated Drink": { patch: (def) => out(def, { spell: { ...(def.spell || {}), effects: [{ op: "contaminatedDrink", run: function* (g, ctx) {
    const x = ctx.x | 0;
    yield* g.drawCards$(ctx.you, x);
    g.addPlayerCounters(ctx.you, "rad", Math.ceil(x / 2));
  } }] } }) },

  "Glowing One": { patch: (def) => out(def, { abilities: [...def.abilities.filter((a) => !(a.kind === "triggered" && a.effects?.[0]?.op === "getRadCounters")), {
    kind: "triggered", on: { event: "dealsCombatDamage", who: "self", to: "player" }, text: "Whenever this creature deals combat damage to a player, they get four rad counters.",
    effects: [{ op: "getRadCounters", who: { ref: "event", what: "target" }, amount: 4 }] }, {
    kind: "triggered", on: { event: "milled", who: "each", nonland: true }, text: "Whenever a player mills a nonland card, you gain 1 life.", effects: [{ op: "gainLife", who: "you", amount: 1 }] }] }) },

  "Vexing Radgull": plusAbs({
    kind: "triggered", on: { event: "dealsCombatDamage", who: "self", to: "player" },
    text: "Whenever this creature deals combat damage to a player, that player gets two rad counters if they don't have any rad counters. Otherwise, proliferate.",
    effects: [{ op: "radgull", run: function* (g, ctx) {
      const t = ctx.event?.target;
      const p = typeof t === "string" && /^P\d+$/.test(t) ? +t.slice(1) : null;
      if (p == null) return;
      if ((g.state.players[p].counters.rad | 0) === 0) g.addPlayerCounters(p, "rad", 2);
      else yield* g.runEffects$([{ op: "proliferate" }], ctx);
    } }] }),

  "Infesting Radroach": { patch: (def) => out(def, { abilities: [...def.abilities, {
    kind: "triggered", on: { event: "dealsCombatDamage", who: "self", to: "player" }, text: "Whenever this creature deals combat damage to a player, they get that many rad counters.",
    effects: [{ op: "getRadCounters", who: { ref: "event", what: "target" }, amount: { event: "amount" } }] }, {
    kind: "triggered", zone: "graveyard", on: { event: "milled", who: "opponent", nonland: true }, text: "Whenever an opponent mills a nonland card, if this creature is in your graveyard, you may return it to your hand.",
    effects: [{ op: "radroachReturn", run: function* (g, ctx) {
      const o = g.obj(ctx.source?.id);
      if (!o || o.zone !== "graveyard" || o.owner !== ctx.you) return;
      if (yield* g.confirm$(ctx.you, `Return ${o.def.name} to your hand?`, o.id, { kind: "may" })) yield* g.moveTo$(o, "hand");
    } }] }] }) },

  "Tato Farmer": plusAbs({
    kind: "activated", cost: { tap: true }, targets: [{ what: { zone: "graveyard", types: ["land"], milledThisTurn: true }, zone: "graveyard" }],
    text: "{T}: Put target land card in a graveyard that was milled this turn onto the battlefield tapped under your control.",
    effects: [{ op: "tatoReanimate", run: function* (g, ctx) { const o = g.obj(ctx.targets?.[0]?.[0]); if (o && o.zone === "graveyard") yield* g.moveTo$(o, "battlefield", { controller: ctx.you, tapped: true }); } }] }),

  "Mariposa Military Base": { patch: (def) => out(def, { abilities: [{ kind: "static", effect: { type: "entersTapped", affects: "self", optionalTapped: { rad: 2 } }, text: "You may have this land enter tapped. If you do, you get two rad counters." },
    ...def.abilities.filter((a) => a.kind === "activated" && a.mana), {
    kind: "activated", cost: { mana: "{5}", tap: true, costReduce: { amount: { countersOn: "you", kind: "rad" } } }, text: "{5}, {T}: Draw a card. This ability costs {1} less to activate for each rad counter you have.",
    effects: [{ op: "draw", who: "you", amount: 1 }] }] }) },

  "Nuka-Nuke Launcher": plusAbs({
    kind: "triggered", on: { event: "attacks", who: "equipped" }, text: "Whenever equipped creature attacks, until the end of defending player's next turn, that player gets two rad counters whenever they cast a spell.",
    effects: [{ op: "nukaNuke", run: function* (g, ctx) {
      const dp = ctx.event?.player;
      if (dp == null) return;
      g.addTempTrigger({ event: "cast", who: "each" }, function* (g2, c2) { if (c2.event?.player === dp) g2.addPlayerCounters(dp, "rad", 2); }, ctx, "endOfPlayerTurn", { player: dp });
    } }] }),

  "Struggle for Project Purity": { patch: (def) => out(def, { abilities: [
    { kind: "static", effect: { type: "asEntersChoose", choice: "mode", options: [
      { id: "brotherhood", label: "Brotherhood — At the beginning of your upkeep, each opponent draws a card. You draw a card for each card drawn this way." },
      { id: "enclave", label: "Enclave — Whenever a player attacks you with one or more creatures, that player gets twice that many rad counters." }] }, text: "As this enchantment enters, choose Brotherhood or Enclave." },
    { kind: "triggered", on: { event: "beginStep", step: "upkeep", whose: "you" }, condition: { type: "chosen", key: "mode", value: "brotherhood" }, text: "Brotherhood — At the beginning of your upkeep, each opponent draws a card. You draw a card for each card drawn this way.",
      effects: [{ op: "brotherhood", run: function* (g, ctx) {
        let n = 0;
        for (const q of g.apnap(g.opponentsOf(ctx.you))) { const before = g.state.players[q].hand.length; yield* g.drawCards$(q, 1); if (g.state.players[q].hand.length > before) n++; }
        if (n) yield* g.drawCards$(ctx.you, n);
      } }] },
    { kind: "triggered", on: { event: "attackedPlayer", defending: "you" }, condition: { type: "chosen", key: "mode", value: "enclave" }, text: "Enclave — Whenever a player attacks you with one or more creatures, that player gets twice that many rad counters.",
      effects: [{ op: "enclave", run: function* (g, ctx) { const e = ctx.event; if (e) g.addPlayerCounters(e.attacker, "rad", 2 * (e.count | 0)); } }] },
  ] }) },

  "Harold and Bob, First Numens": { patch: (def) => {
    const dies = def.abilities.find((a) => a.kind === "triggered" && a.on?.event === "dies");
    return out(def, { abilities: [...def.abilities.filter((a) => a !== dies), {
      kind: "triggered", on: { event: "dies", who: "self" }, condition: dies?.condition,
      text: "When Harold and Bob dies, if it was a creature, return it to the battlefield. It's an Aura enchantment with enchant Forest you control and \"Enchanted Forest has '{T}: Add three mana of any one color. You get two rad counters.'\" Harold and Bob loses all other abilities.",
      effects: [{ op: "haroldAura", run: function* (g, ctx) {
        const o = g.obj(ctx.source?.id);
        if (!o || o.zone !== "graveyard") return;
        const forests = g.find({ types: ["land"], subtypes: ["forest"], controller: "you" }, ctx);
        if (!forests.length) return; // it can't enter as an Aura with nothing to enchant: it stays in the graveyard (CR 303.4g)
        const [f] = yield* g.chooseObjects$(ctx.you, forests, { prompt: "Harold and Bob returns as an Aura — enchant which Forest you control?", min: 1, max: 1, reason: "target", source: o.id });
        o.formDef = { ...o.def, types: ["enchantment"], subtypes: ["aura"], power: undefined, toughness: undefined, keywords: {}, unparsed: [], abilities: [{
          kind: "static", text: "Enchanted Forest has \"{T}: Add three mana of any one color. You get two rad counters.\"",
          effect: { type: "pump", affects: "enchanted", abilities: [{ kind: "activated", mana: true, cost: { tap: true }, text: "{T}: Add three mana of any one color. You get two rad counters.",
            effects: [{ op: "addMana", mana: { any: 3 } }, { op: "getRadCounters", who: "you", amount: 2 }] }] } }] };
        yield* g.moveTo$(o, "battlefield", { controller: ctx.you, attachTo: (f || forests[0]).id });
      } }] }] });
  } },

  "Survivor's Med Kit": { patch: (def) => out(def, { abilities: [{
    kind: "activated", cost: { mana: "{1}", tap: true }, text: "{1}, {T}: Choose one that hasn't been chosen — • Stimpak — Draw a card. • Fancy Lads Snack Cakes — Create a Food token. • RadAway — Target player loses all rad counters. Sacrifice this artifact.",
    effects: [{ op: "medKit", run: function* (g, ctx) {
      const o = g.obj(ctx.source?.id);
      if (!o || o.zone !== "battlefield") return;
      const used = (o.medModes ||= []);
      const left = [{ id: "stimpak", label: "Stimpak — Draw a card." }, { id: "snack", label: "Fancy Lads Snack Cakes — Create a Food token." }, { id: "radaway", label: "RadAway — Target player loses all rad counters. Sacrifice this artifact." }].filter((m) => !used.includes(m.id));
      if (!left.length) return;
      const [m] = left.length === 1 ? [left[0]] : yield* g.choose$(ctx.you, { prompt: "Survivor's Med Kit — choose one that hasn't been chosen", options: left.map((x) => ({ id: x.id, label: x.label, type: "mode" })), min: 1, max: 1, reason: "mode", source: o.id });
      used.push(m.id);
      if (m.id === "stimpak") yield* g.drawCards$(ctx.you, 1);
      else if (m.id === "snack") g.createToken(ctx.you, "food", 1);
      else {
        const opts = g.alivePlayers(true).map((q) => ({ id: "P" + q, label: g.pname(q) + (g.state.players[q].counters.rad ? ` (${g.state.players[q].counters.rad} rad)` : ""), type: "player" }));
        const [t] = yield* g.choose$(ctx.you, { prompt: "RadAway — target player loses all rad counters", options: opts, min: 1, max: 1, reason: "target", source: o.id });
        const q = +String(t?.id || "P" + ctx.you).slice(1);
        g.addPlayerCounters(q, "rad", -(g.state.players[q].counters.rad | 0));
        g.sacrifice(o);
      }
    } }] }] }) },

  "Locke, Treasure Hunter": { patch: (def) => out(def, { abilities: [...def.abilities,
    { kind: "static", effect: { type: "cantBeBlockedBy", affects: "self", greaterPower: true }, text: "Locke can't be blocked by creatures with greater power." },
    { kind: "triggered", on: { event: "attacks", who: "self" }, text: "Mug — Whenever Locke attacks, each player mills a card. If a land card was milled this way, create a Treasure token. Until end of turn, you may cast a spell from among those cards.",
      effects: [{ op: "mug", run: function* (g, ctx) {
        const cards = [];
        for (const q of g.apnap(g.alivePlayers(true))) cards.push(...g.mill(q, 1));
        if (cards.some((o) => o.def.types.includes("land"))) g.createToken(ctx.you, "treasure", 1);
        const spells = cards.filter((o) => o.zone === "graveyard" && !o.def.types.includes("land"));
        if (!spells.length) return;
        const ids = spells.map((o) => o.id);
        for (const o of spells) o.mayCastGy = { player: ctx.you, untilTurn: g.state.turn };
        g.addTempTrigger({ event: "cast", who: "you" }, function* (g2, c2) { if (ids.includes(c2.event?.obj?.id)) for (const id of ids) { const x = g2.obj(id); if (x) x.mayCastGy = null; } }, ctx, "endOfTurn"); // "a spell": only one of them
      } }] }] }) },

  "Cache Grab": { patch: (def) => out(def, { spell: { ...(def.spell || {}), effects: [{ op: "cacheGrab", run: function* (g, ctx) {
    const milled = g.mill(ctx.you, 4);
    const perms = milled.filter((o) => o.zone === "graveyard" && o.def.types.some((t) => ["artifact", "battle", "creature", "enchantment", "land", "planeswalker"].includes(t)));
    let picked = null;
    if (perms.length) {
      [picked] = yield* g.chooseObjects$(ctx.you, perms, { prompt: "Cache Grab — you may put a permanent card from among the milled cards into your hand", min: 0, max: 1, reason: "return", source: ctx.source?.id });
      if (picked) yield* g.moveTo$(picked, "hand");
    }
    const squirrel = g.find({ types: ["creature"], subtypes: ["squirrel"], controller: "you" }, ctx).length > 0 || (picked && picked.zone === "hand" && picked.def.subtypes.includes("squirrel"));
    if (squirrel) g.createToken(ctx.you, "food", 1);
  } }] } }) },
};
