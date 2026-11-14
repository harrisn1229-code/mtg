# Binder

A Magic: The Gathering collection manager: collection and prices, decks, binders, a wishlist, and CSV import/export. One HTML file, installable, works offline.

Live: https://harrisn1229-code.github.io/mtg/

## Refreshing the published collection

`data/seed.json` is what a new device loads on first launch. Rebuild it from the vault, then commit and push:

    node tools/build-seed.mjs /path/to/vault

Bump `VERSION` in `sw.js` whenever any app file changes.

Card data and images come from [Scryfall](https://scryfall.com). Card scanning reads text with [Tesseract.js](https://github.com/naptha/tesseract.js), loaded from jsDelivr the first time you scan. Binder is unofficial Fan Content, not approved or endorsed by Wizards of the Coast.
