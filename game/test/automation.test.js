// automation.test.js — scenario tests for the "full-automation pass" mechanics (SPEC-NOTES.md): mutate, morph, craft,
// spectacle + impulse play, increment, triggered mana abilities, enters-as-copy, activate-as-haste, ability copies,
// phasing, spend-restricted / tracked mana, zone-change triggers, divided damage, "can't be prevented", entry choices,
// commander replacement for hand/library, costly mana sources.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setup, place, byName, one, card, mana, act, hasAction, choose, chooseNone, confirm, number, resolveAll, kick, resolveUntilAsk,
  until, atStep, toMain, texts, life, zoneNames, healthy, compileCard, cardByName,
} from "./scenario.js";
import { decide } from "../ai.js";

// ------------------------------------------------------------------ mutate
test("Mutate: Gemrazer over a non-Human creature — same permanent, top card's characteristics, all abilities, mutate trigger", () => {
  const g = setup({ p0: { hand: ["Gemrazer"], battlefield: ["Llanowar Elves"] }, p1: { battlefield: ["Sol Ring"] } });
  const elves = one(g, "Llanowar Elves");
  elves.counters["+1/+1"] = 1; elves.tapped = true; g.markDirty(); g.refreshRequest();
  toMain(g);
  elves.tapped = true; g.markDirty(); g.refreshRequest(); // stays tapped through the untap step only in our setup
  mana(g, 0, "{1}{G}{G}");
  act(g, "Cast Gemrazer for its mutate cost");
  assert.equal(g.state.stack.length, 1);
  resolveUntilAsk(g);
  assert.equal(g.request.reason, "mutate");
  choose(g, "Over");
  // "Whenever this creature mutates, destroy target artifact or enchantment an opponent controls" (Sol Ring auto-targeted)
  resolveAll(g);
  const m = g.obj(elves.id);
  assert.equal(m.zone, "battlefield", "the merged permanent is the same object");
  assert.equal(m.c.name, "Gemrazer");
  assert.equal(m.c.power, 5, "4/4 + the +1/+1 counter it kept");
  assert.equal(m.tapped, true, "keeps tapped status");
  assert.ok(g.hasKw(m, "trample") && g.hasKw(m, "reach"));
  assert.ok(m.c.abilities.some((a) => a.mana), "has the Elves' mana ability from under it");
  assert.equal(m.pile.length, 2);
  assert.equal(byName(g, "Sol Ring").length, 0, "mutate trigger destroyed the artifact");
  assert.equal(byName(g, "Gemrazer", "battlefield").length, 1, "only one permanent");
  healthy(g);
});

test("Mutate under: keeps the host's name/P/T; when it dies every card of the pile goes to the graveyard", () => {
  const g = setup({ p0: { hand: ["Everquill Phoenix"], battlefield: ["Zilortha, Strength Incarnate"] } });
  toMain(g);
  const z = one(g, "Zilortha, Strength Incarnate");
  mana(g, 0, "{3}{R}");
  act(g, "Cast Everquill Phoenix for its mutate cost");
  resolveUntilAsk(g);
  choose(g, "Under");
  resolveAll(g); // Feather token from the mutate trigger
  assert.equal(z.c.name, "Zilortha, Strength Incarnate");
  assert.ok(g.hasKw(z, "flying"), "gains Phoenix's flying");
  assert.equal(z.c.power, 7);
  const feather = one(g, "Feather");
  assert.ok(feather.c.types.includes("artifact") && feather.c.colors.includes("R"));
  g.destroy(z);
  kick(g);
  assert.deepEqual(zoneNames(g, 0, "graveyard").sort(), ["Everquill Phoenix", "Zilortha, Strength Incarnate"]);
  // Feather: {1}, Sacrifice: return target Phoenix card from your graveyard to the battlefield tapped
  until(g, atStep("main1"));
  mana(g, 0, "{1}");
  act(g, "Feather");
  resolveAll(g);
  const ph = one(g, "Everquill Phoenix");
  assert.equal(ph.tapped, true);
  healthy(g);
});

test("Mutate: if the target is illegal on resolution the spell just enters as a creature", () => {
  const g = setup({ p0: { hand: ["Gemrazer"], battlefield: ["Llanowar Elves"] } });
  toMain(g);
  mana(g, 0, "{1}{G}{G}");
  act(g, "Cast Gemrazer for its mutate cost");
  g.destroy(one(g, "Llanowar Elves"));
  resolveAll(g);
  const gz = one(g, "Gemrazer");
  assert.ok(!gz.pile, "not merged");
  assert.equal(gz.c.power, 4);
  healthy(g);
});

test("Mutate: Humans and creatures you don't own are not legal targets", () => {
  const g = setup({ p0: { hand: ["Gemrazer"], battlefield: ["Archmage Emeritus"] }, p1: { battlefield: ["Llanowar Elves"] } });
  toMain(g);
  mana(g, 0, "{1}{G}{G}");
  assert.ok(!hasAction(g, "mutate cost"), "no non-Human creature you own");
  healthy(g);
});

// ------------------------------------------------------------------ morph
test("Morph: cast face down for {3}; hidden 2/2; turn face up any time for its morph cost; revealed when it leaves", () => {
  const g = setup({ p0: { hand: ["Grim Haruspex"], battlefield: ["Carrion Feeder"] } });
  toMain(g);
  mana(g, 0, "{3}");
  act(g, "Cast Grim Haruspex face down");
  const ev = texts(g);
  assert.ok(ev.some((t) => /face-down creature spell/.test(t)) && !ev.some((t) => /Grim Haruspex/.test(t)), "the cast does not reveal the card");
  resolveAll(g);
  const h = card(g, "Grim Haruspex", "battlefield");
  assert.equal(h.faceDown, true);
  assert.equal(h.c.name, "Face-down creature");
  assert.equal(h.c.power, 2); assert.equal(h.c.toughness, 2);
  assert.deepEqual(h.c.colors, []); assert.equal(h.c.abilities.length, 0); assert.equal(h.c.cmc, 0);
  // face down: Haruspex's death trigger doesn't exist
  g.destroy(one(g, "Carrion Feeder"));
  assert.equal(g.state.pendingTriggers.length, 0, "no ability while face down");
  g.refreshRequest();
  // turn face up: special action, no stack
  mana(g, 0, "{B}");
  act(g, "Turn face up (morph {B})");
  assert.equal(g.state.stack.length, 0, "turning face up doesn't use the stack");
  assert.equal(h.faceDown, false);
  assert.equal(h.c.name, "Grim Haruspex");
  assert.equal(h.c.power, 3);
  assert.equal(h.sick, true, "same permanent (still summoning sick)");
  healthy(g);
});

test("Morph: a face-down creature that dies is revealed; the AI-facing state never shows the opponent's identity", () => {
  const g = setup({ p1: { hand: ["Grim Haruspex"], land: "Swamp" } , first: 1 });
  until(g, atStep("main1", 1));
  mana(g, 1, "{3}");
  act(g, "Cast Grim Haruspex face down");
  resolveAll(g);
  const h = card(g, "Grim Haruspex", "battlefield");
  assert.equal(h.c.name, "Face-down creature");
  assert.equal(g.faceDef(h).name, "Face-down creature");
  assert.equal(g.copiableDef(h).power, 2);
  g.drainEvents();
  g.destroy(h);
  const ev = g.drainEvents();
  assert.ok(ev.some((e) => e.t === "reveal" && /Grim Haruspex/.test(e.text)), "revealed as it leaves the battlefield");
  assert.equal(h.faceDown, false);
  healthy(g);
});

// ------------------------------------------------------------------ craft
test("Craft: Tithing Blade exiles itself and a creature card from your graveyard, returns transformed (Consuming Sepulcher)", () => {
  const g = setup({ p0: { battlefield: ["Tithing Blade // Consuming Sepulcher"], graveyard: ["Gravecrawler"] } });
  toMain(g);
  mana(g, 0, "{4}{B}");
  act(g, "Craft with creature");
  resolveAll(g);
  const s = one(g, "Consuming Sepulcher");
  assert.equal(s.face, 1);
  assert.ok(zoneNames(g, 0, "exile").includes("Gravecrawler"));
  until(g, (r, st) => st.turn === 3 && st.step === "upkeep" && st.stack.length === 0 && r.kind === "priority");
  assert.equal(life(g, 0), 41);
  assert.equal(life(g, 1), 39);
  healthy(g);
});

test("Craft: needs a creature you control or a creature card in your graveyard; sorcery speed only", () => {
  const g = setup({ p0: { battlefield: ["Tithing Blade // Consuming Sepulcher"] } });
  toMain(g);
  mana(g, 0, "{4}{B}");
  assert.ok(!hasAction(g, "Craft"), "nothing to craft with");
  place(g, 0, "battlefield", "Carrion Feeder");
  assert.ok(hasAction(g, "Craft"));
  act(g, "Craft");
  resolveAll(g);
  assert.ok(zoneNames(g, 0, "exile").includes("Carrion Feeder"));
  assert.equal(one(g, "Consuming Sepulcher").face, 1);
  healthy(g);
});

// ------------------------------------------------------------------ spectacle + impulse
test("Spectacle: Light Up the Stage costs {R} only after an opponent lost life; its cards are playable until the end of your next turn", () => {
  const g = setup({ p0: { hand: ["Light Up the Stage"], library: ["Mountain", "Opt"], land: "Mountain" } });
  toMain(g);
  mana(g, 0, "{R}");
  assert.ok(!hasAction(g, "spectacle"), "no opponent lost life yet");
  g.loseLife(1, 1); g.refreshRequest();
  act(g, "Cast Light Up the Stage for its spectacle cost");
  resolveAll(g);
  assert.deepEqual(zoneNames(g, 0, "exile").sort(), ["Mountain", "Opt"]);
  assert.ok(hasAction(g, "Play Mountain"), "lands can be played from exile");
  // opponent's turn, then our next turn: still playable; gone after it ends
  until(g, (r, st) => st.turn === 3 && atStep("main1")(r, st));
  assert.ok(hasAction(g, "Play Mountain"));
  until(g, (r, st) => st.turn === 4);
  const m = card(g, "Mountain", "exile");
  assert.equal(m.mayPlay, null, "permission ended with your next turn");
  healthy(g);
});

// ------------------------------------------------------------------ increment
test("Increment: Topiary Lecturer gets a counter when the mana spent on a spell exceeds its power or toughness", () => {
  const g = setup({ p0: { battlefield: ["Topiary Lecturer"], hand: ["Opt", "Arcane Signet", "Mind Stone"] } });
  toMain(g);
  const t = one(g, "Topiary Lecturer");
  mana(g, 0, "{U}");
  act(g, "Cast Opt"); resolveUntilAsk(g); chooseNone(g); resolveAll(g);
  assert.equal(t.counters["+1/+1"] | 0, 0, "1 mana is not greater than 1 power / 2 toughness");
  mana(g, 0, "{2}");
  act(g, "Cast Arcane Signet"); resolveAll(g);
  assert.equal(t.counters["+1/+1"], 1, "2 mana > 1 power");
  assert.equal(t.c.power, 2);
  mana(g, 0, "{2}");
  act(g, "Cast Mind Stone"); resolveAll(g);
  assert.equal(t.counters["+1/+1"], 1, "2 mana is not greater than 2/3");
  // {T}: add an amount of {G} equal to its power (it has been here since the turn began: not summoning sick)
  t.sick = false; g.refreshRequest();
  act(g, "Topiary Lecturer:");
  assert.equal(g.state.players[0].mana.G, 2);
  healthy(g);
});

// ------------------------------------------------------------------ triggered mana ability
test("Wolfwillow Haven: the enchanted land makes an extra {G} (manually and in the automatic payer)", () => {
  const g = setup({ p0: { battlefield: ["Forest"], hand: ["Wolfwillow Haven", "Llanowar Elves"] }, p1: {} });
  toMain(g);
  const forest = one(g, "Forest");
  mana(g, 0, "{1}{G}");
  act(g, "Cast Wolfwillow Haven");
  resolveAll(g);
  assert.equal(one(g, "Wolfwillow Haven").attachedTo, forest.id);
  // a two-mana spell is affordable from one Forest now (Elves cost {G}; check the planner on {G}{G})
  assert.ok(g.canPayMana(0, { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 2, C: 0, hybrid: [], phyrexian: [], x: 0, snow: 0 }), "solver counts the triggered {G}");
  act(g, "Forest: {T}");
  assert.equal(g.state.players[0].mana.G, 2, "tapping it manually adds {G}{G}, no stack");
  assert.equal(g.state.stack.length, 0);
  healthy(g);
});

// ------------------------------------------------------------------ enters as a copy
test("Spark Double: enters as a copy of a creature you control with an extra +1/+1 counter, not legendary", () => {
  const g = setup({ p0: { hand: ["Spark Double"], battlefield: ["Zilortha, Strength Incarnate"] } });
  toMain(g);
  mana(g, 0, "{3}{U}");
  act(g, "Cast Spark Double");
  resolveUntilAsk(g);
  assert.equal(g.request.reason, "copy");
  choose(g, "Zilortha");
  resolveAll(g);
  const list = byName(g, "Zilortha, Strength Incarnate");
  assert.equal(list.length, 2, "no legend rule: the copy isn't legendary");
  const copy = list.find((o) => o.def.name === "Spark Double");
  assert.ok(!copy.c.supertypes.includes("legendary"));
  assert.equal(copy.c.power, 8); assert.equal(copy.c.toughness, 4);
  assert.ok(copy.c.abilities.some((a) => a.effect?.type === "lethalByPower"), "copied abilities");
  healthy(g);
});

test("Spark Double: copying a planeswalker adds a loyalty counter; choosing nothing leaves a 0/0 that dies", () => {
  const g = setup({ p0: { hand: ["Spark Double", "Spark Double"], battlefield: ["Tibalt, Rakish Instigator"] } });
  toMain(g);
  const tib = one(g, "Tibalt, Rakish Instigator");
  mana(g, 0, "{3}{U}");
  act(g, "Cast Spark Double");
  resolveUntilAsk(g);
  choose(g, "Tibalt");
  resolveAll(g);
  const copy = byName(g, "Tibalt, Rakish Instigator").find((o) => o !== tib);
  assert.equal(copy.counters.loyalty, (tib.def.loyalty | 0) + 1);
  mana(g, 0, "{3}{U}");
  act(g, "Cast Spark Double");
  resolveUntilAsk(g);
  chooseNone(g);
  resolveAll(g);
  assert.ok(zoneNames(g, 0, "graveyard").includes("Spark Double"), "0/0 dies");
  healthy(g);
});

// ------------------------------------------------------------------ activate as though it had haste
test("Thousand-Year Elixir: summoning-sick creatures can use {T} abilities (incl. mana abilities in the auto payer); untap target creature", () => {
  const g = setup({ p0: { battlefield: ["Thousand-Year Elixir"], hand: ["Llanowar Elves", "Mind Stone"] } });
  toMain(g);
  mana(g, 0, "{G}");
  act(g, "Cast Llanowar Elves");
  resolveAll(g);
  const e = one(g, "Llanowar Elves");
  assert.equal(e.sick, true);
  assert.ok(hasAction(g, "Llanowar Elves: {T}"), "mana ability usable while sick");
  mana(g, 0, "{1}");
  act(g, "Cast Mind Stone"); // {1} pool + Elves via the auto payer
  resolveAll(g);
  assert.equal(e.tapped, true);
  const elx = one(g, "Thousand-Year Elixir");
  mana(g, 0, "{1}");
  act(g, "Thousand-Year Elixir: {1}, {T}: Untap target creature");
  resolveAll(g);
  assert.equal(e.tapped, false);
  assert.equal(elx.tapped, true);
  healthy(g);
});

test("Without Thousand-Year Elixir a summoning-sick creature can't tap; {T} as another cost ignores sickness", () => {
  const g = setup({ p0: { hand: ["Llanowar Elves"] } });
  toMain(g);
  mana(g, 0, "{G}");
  act(g, "Cast Llanowar Elves");
  resolveAll(g);
  assert.ok(!hasAction(g, "Llanowar Elves: {T}"));
  healthy(g);
});

// ------------------------------------------------------------------ ability copies
test("Rings of Brighthearth: pay {2} to copy an activated ability; the copy may get new targets", () => {
  const g = setup({ p0: { battlefield: ["Rings of Brighthearth", "Thousand-Year Elixir", "Carrion Feeder", "Gravecrawler"] } });
  toMain(g);
  const a = one(g, "Carrion Feeder"), b = one(g, "Gravecrawler");
  a.tapped = true; b.tapped = true; g.markDirty(); g.refreshRequest();
  mana(g, 0, "{1}{2}");
  act(g, "Thousand-Year Elixir: {1}");
  choose(g, "Carrion Feeder");
  resolveUntilAsk(g); // Rings trigger resolves first
  confirm(g, true); // pay {2}
  confirm(g, true); // choose new targets
  choose(g, "Gravecrawler");
  resolveAll(g);
  assert.equal(a.tapped, false); assert.equal(b.tapped, false);
  healthy(g);
});

test("Illusionist's Bracers: abilities of the equipped creature are copied (not mana abilities)", () => {
  const g = setup({ p0: { battlefield: ["Illusionist's Bracers", "Brion Stoutarm", "Carrion Feeder", "Gravecrawler"] } });
  toMain(g);
  const br = one(g, "Brion Stoutarm");
  g.attach(one(g, "Illusionist's Bracers"), br);
  g.refreshRequest();
  mana(g, 0, "{R}");
  act(g, "Brion Stoutarm:");
  choose(g, "AI");
  choose(g, "Carrion Feeder");
  resolveUntilAsk(g); // Bracers trigger -> copy, may choose new targets
  confirm(g, false);
  resolveAll(g);
  assert.equal(life(g, 1), 38, "Brion's ability (1 power sacrificed) dealt damage twice");
  healthy(g);
});

// ------------------------------------------------------------------ phasing
test("Teferi's Protection: life can't change, protection from everything, your permanents phase out (no LTB/ETB) and phase in at your untap", () => {
  const g = setup({ p0: { hand: ["Teferi's Protection"], battlefield: ["Syr Konrad, the Grim", "Carrion Feeder", "Plains"] }, p1: { battlefield: ["Gravecrawler"] } });
  toMain(g);
  const k = one(g, "Syr Konrad, the Grim"), f = one(g, "Carrion Feeder");
  f.counters["+1/+1"] = 2; f.tapped = true; g.markDirty();
  mana(g, 0, "{2}{W}");
  act(g, "Cast Teferi's Protection");
  resolveAll(g);
  assert.equal(g.state.players[0].lifeLocked, true);
  assert.equal(g.state.players[0].protection, true);
  assert.equal(k.zone, "phased"); assert.equal(f.zone, "phased");
  assert.ok(!g.state.battlefield.includes(f.id));
  assert.equal(life(g, 1), 40, "phasing out isn't leaving: Syr Konrad didn't see anything die");
  assert.equal(g.dealDamage(one(g, "Gravecrawler"), "P0", 2), 0);
  assert.equal(g.gainLife(0, 3), 0); assert.equal(g.loseLife(0, 3), 0);
  assert.ok(zoneNames(g, 0, "exile").includes("Teferi's Protection"));
  assert.equal(g.targetCandidates({ what: { types: ["creature"] } }, null, 1, {}).includes(f.id), false, "can't be targeted");
  until(g, (r, st) => st.turn === 3 && st.step === "upkeep");
  assert.equal(f.zone, "battlefield", "phased in");
  assert.equal(f.counters["+1/+1"], 2, "kept its counters");
  assert.equal(f.tapped, false, "phased in before the untap step, then untapped");
  assert.equal(g.state.players[0].protection, false);
  assert.equal(g.state.players[0].lifeLocked, false);
  healthy(g);
});

// ------------------------------------------------------------------ restricted / tracked mana
test("Secluded Courtyard: choose a creature type as it enters; its coloured mana pays only for creature spells / creature abilities of that type", () => {
  const g = setup({ p0: { hand: ["Secluded Courtyard", "Carrion Feeder", "Opt"] } });
  toMain(g);
  act(g, "Play Secluded Courtyard");
  assert.equal(g.request.reason, "creatureType");
  choose(g, "zombie");
  const c = one(g, "Secluded Courtyard");
  assert.deepEqual(c.chosen, { creatureType: "zombie" });
  assert.ok(hasAction(g, "Cast Carrion Feeder"), "{B} for a Zombie creature spell");
  assert.ok(!hasAction(g, "Cast Opt"), "can't make {U} for a non-creature spell");
  act(g, "Secluded Courtyard: {T}: Add one mana of any color");
  choose(g, "U");
  assert.equal(g.state.players[0].manaX.length, 1, "restricted mana is tracked separately");
  assert.ok(!hasAction(g, "Cast Opt"), "restricted {U} can't pay for Opt");
  healthy(g);
});

test("Path of Ancestry: mana spent on a creature spell sharing a type with your commander triggers scry 1", () => {
  const g = setup({ p0: { battlefield: ["Path of Ancestry"], hand: ["Pawn of Ulamog"] }, cmd0: "Lord of the Nazgûl", commander: true });
  toMain(g);
  const path = one(g, "Path of Ancestry"); path.tapped = false; g.refreshRequest();
  // Pawn of Ulamog is a Vampire Shaman: no shared type with a Wraith Noble -> no scry
  mana(g, 0, "{B}{B}");
  act(g, "Cast Pawn of Ulamog");
  assert.equal(g.state.stack.length, 1, "no scry trigger");
  resolveAll(g);
  healthy(g);
  const g2 = setup({ p0: { battlefield: ["Path of Ancestry"], hand: ["Witch-king of Angmar"] }, cmd0: "Lord of the Nazgûl", commander: true });
  toMain(g2);
  one(g2, "Path of Ancestry").tapped = false;
  mana(g2, 0, "{3}{B}");
  act(g2, "Cast Witch-king of Angmar"); // a Wraith Noble: shares a type
  assert.equal(g2.state.stack.length, 2, "scry trigger above the spell");
  healthy(g2);
});

// ------------------------------------------------------------------ zone-change triggers
test("Syr Konrad: another creature dies, a creature card goes to a graveyard from elsewhere, a creature card leaves your graveyard", () => {
  const g = setup({ p0: { battlefield: ["Syr Konrad, the Grim", "Carrion Feeder"], library: ["Island", "Gravecrawler"], graveyard: ["Elder Gargaroth"] }, p1: { library: ["Llanowar Elves"] } });
  toMain(g);
  mana(g, 0, "{1}{B}");
  act(g, "Syr Konrad, the Grim: {1}{B}"); // each player mills: Gravecrawler (creature card) and Llanowar Elves
  resolveAll(g);
  assert.equal(life(g, 1), 38, "two creature cards put into graveyards from libraries");
  g.sacrifice(one(g, "Carrion Feeder"));
  g.moveObj(card(g, "Elder Gargaroth", "graveyard"), "exile");
  kick(g); resolveAll(g);
  assert.equal(life(g, 1), 36, "another creature died; a creature card left your graveyard");
  healthy(g);
});

// ------------------------------------------------------------------ auto payer: costly sources, land colours, filters
test("Fellwar Stone: the automatic payer uses it for a colour an opponent's land could produce", () => {
  const g = setup({ p0: { battlefield: ["Fellwar Stone"], hand: ["Llanowar Elves", "Opt"] }, p1: { battlefield: ["Forest"] } });
  toMain(g);
  assert.ok(hasAction(g, "Cast Llanowar Elves"));
  assert.ok(!hasAction(g, "Cast Opt"), "opponent has no Island");
  act(g, "Cast Llanowar Elves");
  resolveAll(g);
  assert.equal(one(g, "Fellwar Stone").tapped, true);
  healthy(g);
});

test("Ashnod's Altar: used for mana only when nothing else can pay, asking which creature to sacrifice", () => {
  const g = setup({ p0: { battlefield: ["Ashnod's Altar", "Carrion Feeder", "Gravecrawler", "Forest"], hand: ["Mind Stone", "Arcane Signet"] } });
  toMain(g);
  const a = g.request.actions.find((x) => x.label.includes("Cast Mind Stone"));
  assert.ok(a && /sacrifices for mana/.test(a.label) && a.sacForMana, "flagged");
  mana(g, 0, "{1}");
  assert.ok(!g.request.actions.find((x) => x.label.includes("Cast Mind Stone")).sacForMana, "pool + Forest pay it without a sacrifice");
  act(g, "Cast Mind Stone");
  resolveAll(g);
  assert.equal(byName(g, "Carrion Feeder").length + byName(g, "Gravecrawler").length, 2, "no creature was sacrificed");
  act(g, "Cast Arcane Signet");
  assert.equal(g.request.kind, "choose");
  assert.equal(g.request.reason, "sacrifice");
  choose(g, "Gravecrawler");
  resolveAll(g);
  assert.equal(byName(g, "Arcane Signet").length, 1);
  assert.ok(zoneNames(g, 0, "graveyard").includes("Gravecrawler"));
  healthy(g);
});

test("Rugged Prairie: a filter land pays coloured costs through the automatic payer", () => {
  const g = setup({ p0: { battlefield: ["Rugged Prairie", "Mountain"], hand: ["Gisela, Blade of Goldnight"] } });
  toMain(g);
  mana(g, 0, "{4}{W}");
  act(g, "Cast Gisela"); // {4}{R}{W}{W}: the Mountain pays the Prairie's {R/W}, the Prairie makes {R}{W}, the pool pays the rest
  resolveAll(g);
  assert.equal(byName(g, "Gisela, Blade of Goldnight").length, 1);
  healthy(g);
});

// ------------------------------------------------------------------ divided damage
test("Inferno Titan: 3 damage divided as you choose among one, two or three targets (chosen as the trigger is put on the stack)", () => {
  const g = setup({ p0: { hand: ["Inferno Titan"] }, p1: { battlefield: ["Gravecrawler", "Carrion Feeder"] } });
  toMain(g);
  mana(g, 0, "{4}{R}{R}");
  act(g, "Cast Inferno Titan");
  resolveUntilAsk(g);
  choose(g, "Gravecrawler", "AI");
  assert.equal(g.request.kind, "number");
  assert.equal(g.request.min, 1); assert.equal(g.request.max, 2);
  number(g, 1); // 1 to Gravecrawler, the rest (2) to the player
  resolveAll(g);
  assert.equal(byName(g, "Gravecrawler").length, 0);
  assert.equal(life(g, 1), 38);
  healthy(g);
});

// ------------------------------------------------------------------ prevention
test("Stomp: damage can't be prevented this turn (Gisela's prevention and protection are switched off)", () => {
  const g = setup({ p0: { hand: ["Bonecrusher Giant"] }, p1: { battlefield: ["Gisela, Blade of Goldnight"] } });
  toMain(g);
  assert.equal(g.dealDamage(one(g, "Gisela, Blade of Goldnight"), "P1", 4), 2, "Gisela prevents half to her controller");
  mana(g, 0, "{1}{R}");
  act(g, "Cast Stomp");
  choose(g, "AI");
  resolveAll(g);
  assert.equal(life(g, 1), 36, "2 from Stomp, unprevented (after the earlier 2)");
  assert.equal(g.dealDamage(one(g, "Gisela, Blade of Goldnight"), "P1", 4), 4, "nothing is prevented for the rest of the turn");
  until(g, (r, st) => st.turn === 2);
  healthy(g);
});

// ------------------------------------------------------------------ "as enters" choices
test("Sacred Foundry: the 2-life payment is made as it enters (no trigger); declining enters tapped", () => {
  const g = setup({ p0: { hand: ["Sacred Foundry", "Sacred Foundry"] } });
  toMain(g);
  act(g, "Play Sacred Foundry");
  assert.equal(g.request.kind, "confirm");
  confirm(g, false);
  assert.equal(g.state.stack.length, 0, "no trigger on the stack");
  assert.equal(byName(g, "Sacred Foundry")[0].tapped, true);
  healthy(g);
});

test("Outpost Siege: Khans or Dragons is chosen as it enters (no counters, no trigger)", () => {
  const g = setup({ p0: { hand: ["Outpost Siege"], library: ["Opt", "Mountain"] } });
  toMain(g);
  mana(g, 0, "{3}{R}");
  act(g, "Cast Outpost Siege");
  resolveUntilAsk(g);
  choose(g, "Khans");
  resolveAll(g);
  const s = one(g, "Outpost Siege");
  assert.deepEqual(s.chosen, { mode: "khans" });
  assert.deepEqual(s.counters, {});
  until(g, (r, st) => st.turn === 3 && st.step === "upkeep" && st.stack.length === 0 && r.kind === "priority");
  assert.equal(g.state.players[0].exile.length, 1);
  healthy(g);
});

// ------------------------------------------------------------------ commander replacement (CR 903.9b)
test("Commander bounced to hand: the owner chooses the command zone instead, before it would reach the hand", () => {
  const g = setup({ p0: { hand: ["An Offer You Can't Refuse"] }, cmd1: "Brion Stoutarm", commander: true });
  const b = g.obj(g.state.players[1].commanders[0]);
  g.moveObj(b, "battlefield", { controller: 1 }); g.state.pendingTriggers.length = 0; g.refreshRequest();
  toMain(g);
  g.drainEvents();
  g.state.pendingTriggers.length = 0;
  const cmd = b;
  // "return to hand" through the generator path asks first
  const it = g.zoneMove$(cmd, "hand", {});
  let r = it.next();
  assert.equal(r.value.kind, "confirm");
  assert.match(r.value.prompt, /command zone instead/);
  r = it.next({ yes: true });
  assert.equal(cmd.zone, "command");
  assert.equal(cmd.cmdPending, false);
  healthy(g);
});

test("Elrond: the second resolution of his ability in a turn tempts you", () => {
  const g = setup({ p0: { hand: ["Carrion Feeder", "Gravecrawler"], battlefield: ["Elrond, Lord of Rivendell"] } });
  toMain(g);
  mana(g, 0, "{B}{B}");
  act(g, "Cast Carrion Feeder"); resolveUntilAsk(g); chooseNone(g); resolveAll(g);
  assert.equal(g.state.players[0].ring.level, 0);
  act(g, "Cast Gravecrawler"); resolveUntilAsk(g); chooseNone(g); resolveUntilAsk(g); resolveAll(g);
  assert.equal(g.state.players[0].ring.level, 1);
  healthy(g);
});
