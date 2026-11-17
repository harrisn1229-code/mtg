# Binder

A Magic: The Gathering collection manager: collection and prices, decks, binders, a wishlist, CSV import/export, and play-testing your decks against an AI. One HTML file, installable, works offline.

Live: https://harrisn1229-code.github.io/mtg/

## Play vs AI

The Play tab runs your decks against an AI opponent with rules enforced (Commander: 40 life, command zone, tax, commander damage). It lives in `game/` as plain ES modules, loaded only when the tab opens:

- `engine*.js` rules engine, `parser*.js` turns oracle text into abilities, `overrides-*.js` hand-scripted cards, `ai.js` the opponent, `ui*.js` + `game.css` the board, `decks.js` the bridge to your stored decks.
- New decks work automatically; any card text the parser can't automate is flagged with a ⚠ on the card and can be resolved with the in-game manual tools.
- `game/SPEC.md` and `game/SPEC-NOTES.md` document the design. Tests: `node --test game/test/*.test.js`; AI-vs-AI simulation: `node game/test/sim.js --games 5`.
- Add new `game/` files to the list in `sw.js` so they work offline.

## Refreshing the published collection

`data/seed.json` is what a new device loads on first launch. Rebuild it from the vault, then commit and push:

    node tools/build-seed.mjs /path/to/vault

Bump `VERSION` in `sw.js` whenever any app file changes.

Card data and images come from [Scryfall](https://scryfall.com). Card scanning reads text with [Tesseract.js](https://github.com/naptha/tesseract.js), loaded from jsDelivr the first time you scan. Binder is unofficial Fan Content, not approved or endorsed by Wizards of the Coast.
