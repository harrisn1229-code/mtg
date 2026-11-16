import test from "node:test";
import assert from "node:assert/strict";
import { allDecks, loadSeed, cardByName } from "./helpers.js";
import { buildDeck, listDecks } from "../decks.js";

test("all 4 decks build with zero missing, 1 commander, 99 library cards", () => {
  const decks = allDecks();
  assert.equal(decks.length, 4);
  for (const d of decks) {
    assert.deepEqual(d.missing, [], d.name + " missing");
    assert.equal(d.commanders.length, 1, d.name + " commanders");
    assert.equal(d.cards.length, 99, d.name + " library");
    assert.equal(d.isCommander, true);
    assert.equal(d.startingLife, 40);
    assert.ok(d.identity.length > 0);
    assert.ok(d.art && d.art.includes("/art_crop/") || d.art === null);
    for (const c of [...d.commanders, ...d.cards]) {
      assert.ok(c.name, "card has name");
      assert.ok(c.type_line, c.name + " has type_line");
    }
  }
});

test("listDecks reports playable decks and does not mutate state", () => {
  const st = loadSeed();
  const before = JSON.stringify(st);
  const list = listDecks(st);
  assert.equal(list.length, 4);
  for (const l of list) { assert.equal(l.playable, true); assert.equal(l.count, 100); assert.equal(l.missing, 0); }
  assert.equal(JSON.stringify(st), before);
  const d = buildDeck(st, st.decks[0].id);
  d.cards[0].name = "mutated";
  assert.equal(JSON.stringify(st), before);
});

test("cardByName resolves seed and fixture cards", () => {
  assert.equal(cardByName("lyra dawnbringer").name, "Lyra Dawnbringer");
  assert.equal(cardByName("Tibalt, Rakish Instigator").loyalty, "5");
});
