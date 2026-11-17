// node --test game/test/parser.test.js — focused assertions on the oracle-text compiler.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileCard, analyzeCard } from "../parser.js";
import { compileCard as compileOv, coverage, OVERRIDES, applyOverride } from "../overrides.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(fs.readFileSync(path.join(here, "../../data/seed.json"), "utf8"));
const fxp = path.join(here, "fixtures-cards.json");
const fx = fs.existsSync(fxp) ? JSON.parse(fs.readFileSync(fxp, "utf8")) : [];
const pool = [...Object.values(seed.cards), ...(Array.isArray(fx) ? fx : Object.values(fx))];
const card = (name) => {
  const c = pool.find((x) => x.name === name) || pool.find((x) => x.name.startsWith(name));
  assert.ok(c, "card not in test data: " + name);
  return c;
};
const def = (n) => compileCard(card(n));
const eff = (d) => d.spell.effects;

test("plain data: JSON round-trips and contains no functions (all cards)", () => {
  for (const c of pool) {
    const d = compileCard(c);
    assert.deepEqual(JSON.parse(JSON.stringify(d)), d, c.name);
    assert.ok(Array.isArray(d.unparsed));
  }
});

test("Sol Ring: mana ability", () => {
  const d = def("Sol Ring");
  assert.deepEqual(d.abilities[0], { kind: "activated", cost: { tap: true }, effects: [{ op: "addMana", mana: "{C}{C}" }], mana: true, text: "{T}: Add {C}{C}." });
  assert.equal(d.unparsed.length, 0);
});

test("basic lands and typed duals get intrinsic mana abilities", () => {
  assert.equal(def("Forest").abilities[0].effects[0].mana, "{G}");
  const sf = def("Sacred Foundry");
  assert.equal(sf.abilities.filter((a) => a.mana).length, 2);
  assert.deepEqual(sf.abilities.find((a) => a.kind === "static").effect, { type: "entersTapped", affects: "self", unlessPay: { life: 2 } });
});

test("Swords to Plowshares", () => {
  const d = def("Swords to Plowshares");
  assert.deepEqual(d.spell.targets, [{ what: { types: ["creature"] } }]);
  assert.deepEqual(eff(d)[0], { op: "exile", what: { ref: "target", i: 0 } });
  assert.deepEqual(eff(d)[1], { op: "gainLife", who: { ref: "controllerOf", of: { ref: "target", i: 0 } }, amount: { powerOf: { ref: "target", i: 0 } } });
});

test("Lightning Helix / Counterspell / Abrade (modes)", () => {
  const h = def("Lightning Helix");
  assert.deepEqual(eff(h).map((e) => e.op), ["damage", "gainLife"]);
  assert.equal(h.spell.targets[0].what, "any");
  assert.deepEqual(def("Counterspell").spell.targets[0], { what: "spell", zone: "stack" });
  const a = def("Abrade");
  assert.equal(a.spell.modes.min, 1);
  assert.equal(a.spell.modes.modes.length, 2);
  assert.equal(a.spell.modes.modes[1].effects[0].op, "destroy");
});

test("Blood Artist: 'this or another' emits two triggered abilities", () => {
  const d = def("Blood Artist");
  assert.equal(d.abilities.length, 2);
  assert.equal(d.abilities[0].on.who, "self");
  assert.deepEqual(d.abilities[1].on.who, { other: true, types: ["creature"] });
  assert.deepEqual(d.abilities[0].effects.map((e) => e.op), ["loseLife", "gainLife"]);
  assert.equal(d.abilities[0].targets.length, 1);
});

test("Bitter Reunion: may + if you do", () => {
  const e = def("Bitter Reunion").abilities[0].effects[0];
  assert.deepEqual(e, { op: "may", cost: { discard: 1 }, effects: [{ op: "draw", who: "you", amount: 2 }] });
});

test("Costs: Brion Stoutarm sac another + sacrificed power", () => {
  const a = def("Brion Stoutarm").abilities[0];
  assert.deepEqual(a.cost, { mana: "{R}", tap: true, sac: { other: true, types: ["creature"] } });
  assert.deepEqual(a.effects[0].amount, { sacrificed: "power" });
});

test("Tokens: Bastion of Remembrance, Carrier Thrall (quoted ability), Treasure", () => {
  const b = def("Bastion of Remembrance").abilities[0].effects[0];
  assert.deepEqual(b.token, { name: "Human Soldier", types: ["creature"], subtypes: ["human", "soldier"], colors: ["W"], power: 1, toughness: 1 });
  const c = def("Carrier Thrall").abilities[0].effects[0].token;
  assert.equal(c.abilities[0].kind, "activated");
  assert.equal(c.abilities[0].mana, true);
  assert.equal(eff(def("An Offer You Can't Refuse"))[1].token, "treasure");
});

test("Search: Rampant Growth / Farseek / Cultivate", () => {
  assert.deepEqual(eff(def("Rampant Growth"))[0], { op: "search", who: "you", filter: { supertypes: ["basic"], types: ["land"] }, min: 0, max: 1, to: "battlefield", tapped: true });
  assert.deepEqual(eff(def("Farseek"))[0].filter.subtypes, ["plains", "island", "swamp", "mountain"]);
  assert.equal(eff(def("Cultivate")).length, 2);
});

test("Keywords: Hulking Raptor ward, Karmic Guide, Skullclamp equip", () => {
  assert.equal(def("Hulking Raptor").keywords.ward, "{2}");
  const k = def("Karmic Guide");
  assert.deepEqual(k.keywords.protection, ["black"]);
  assert.equal(k.keywords.echo, "{3}{W}{W}");
  assert.equal(def("Skullclamp").keywords.equip, "{1}");
});

test("Statics: Torbran/Fiendish Duo damageMod, Drivnod doubleTriggers, Goreclaw costMod, Blasphemous Act", () => {
  assert.deepEqual(def("Fiendish Duo").abilities[0].effect, { type: "damageMod", to: "opponent", mul: 2 });
  assert.equal(def("Torbran, Thane of Red Fell").abilities[0].effect.add, 2);
  assert.deepEqual(def("Drivnod, Carnage Dominus").abilities[0].effect, { type: "doubleTriggers", event: "dies", filter: { types: ["creature"] } });
  assert.deepEqual(def("Goreclaw").abilities[0].effect, { type: "costMod", filter: { power: { op: ">=", n: 4 }, types: ["creature"] }, who: "you", amount: -2 });
  assert.deepEqual(def("Blasphemous Act").abilities[0].effect, { type: "selfCostMod", per: { count: { types: ["creature"] } }, amount: -1 });
});

test("Lands: enters tapped unless, pain land, Command Tower", () => {
  const c = def("Castle Locthwain");
  assert.equal(c.abilities[0].effect.type, "entersTapped");
  assert.equal(c.abilities[0].effect.unless.type, "control");
  assert.deepEqual(def("Command Tower").abilities[0].effects[0].mana, { identity: 1 });
  const p = def("Battlefield Forge").abilities[1];
  assert.deepEqual(p.effects[0].mana, { anyOf: ["R", "W"], n: 1 });
  assert.deepEqual(p.effects[1], { op: "damage", amount: 1, to: "you" });
});

test("Adventure and transform layouts", () => {
  const b = def("Bonecrusher Giant");
  assert.equal(b.layout, "adventure");
  assert.equal(b.faces.length, 2);
  assert.deepEqual(b.faces[1].spell.targets, [{ what: "any" }]);
  assert.deepEqual(b.faces[1].spell.effects[0], { op: "until", until: "endOfTurn", static: { type: "cantPrevent", affects: "you" } });
  assert.equal(b.faces[1].spell.effects[1].amount, 2);
  const w = def("Westvale Abbey");
  assert.equal(w.layout, "transform");
  assert.equal(w.faces[1].keywords.lifelink, true);
});

test("Conditionals: instead, kicker, Ilysian Caryatid", () => {
  const n = eff(def("Nasty End"))[0];
  assert.equal(n.op, "if");
  assert.equal(n.then[0].amount, 3);
  assert.equal(n.else[0].amount, 2);
  const r = eff(def("Rite of Replication"))[0];
  assert.deepEqual(r.cond, { type: "kicked" });
  assert.equal(r.then[0].amount, 5);
  assert.equal(def("Ilysian Caryatid").abilities[0].effects[0].op, "if");
});

test("Never guess: unsupported text lands in unparsed", () => {
  assert.ok(def("Mosswort Bridge").unparsed.length >= 1);
  assert.ok(compileCard({ name: "Banding Guy", mana_cost: "{W}", type_line: "Creature — Human", pt: "1/1", oracle_text: "Banding" }).unparsed.includes("Banding"));
  assert.ok(def("Witch-king, Bringer of Ruin").unparsed.length === 1);
});

test("overrides: fragment and patch forms clear unparsed", () => {
  const base = def("Mosswort Bridge");
  assert.ok(base.unparsed.length);
  const a = applyOverride(base, { abilities: [] });
  assert.deepEqual(a.unparsed, []);
  const b = applyOverride(base, { patch(d) { d.keywords.x = true; return d; } });
  assert.deepEqual(b.unparsed, []);
  const c = applyOverride(base, { abilities: [], keepUnparsed: true });
  assert.deepEqual(c.unparsed, base.unparsed);
  assert.ok(typeof OVERRIDES === "object");
  assert.equal(coverage(card("Sol Ring")).full, true);
  assert.equal(compileOv(card("Sol Ring")).name, "Sol Ring");
});

// ---- AI / sim agent regressions
test("parser: quoted token ability after 'you may create' (Pawn of Ulamog)", () => {
  const d = compileCard(card("Pawn of Ulamog"));
  assert.deepEqual(d.unparsed, []);
  const tok = JSON.stringify(d.abilities);
  assert.ok(!tok.includes('"manual"'));
  assert.ok(d.abilities.every((a) => a.effects.some((e) => e.op === "createToken" && e.token.abilities?.[0]?.mana)));
});
test("parser: 'Each player who can't discards a card' becomes sacrifice.ifCant (Plaguecrafter)", () => {
  const e = compileCard(card("Plaguecrafter")).abilities[0].effects;
  assert.equal(e.length, 1);
  assert.deepEqual(e[0].ifCant, [{ op: "discard", who: "you", amount: 1 }]);
});
test("parser: mana spend riders are dropped and the ability stays a mana ability (Path of Ancestry, Secluded Courtyard)", () => {
  for (const n of ["Path of Ancestry", "Secluded Courtyard"]) {
    const d = compileCard(card(n));
    const m = d.abilities.filter((a) => a.kind === "activated");
    assert.ok(m.every((a) => a.mana && a.effects.every((e) => e.op === "addMana")), n);
  }
});
test("parser: 'no creatures are on the battlefield' counts every controller (Pyrohemia)", () => {
  const d = compileCard(card("Pyrohemia"));
  assert.ok(JSON.stringify(d.abilities).includes('"type":"count"'));
});
