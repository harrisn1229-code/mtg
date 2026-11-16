# Binder — Play vs AI: build spec

Binder (`../index.html`) is a single-file MTG collection/deck app (vanilla JS, no build step, GitHub Pages, offline PWA).
This folder adds an Arena-style **play your decks against an AI** feature. Everything here is plain ES modules that run
unbundled in the browser and in Node 22 (`game/package.json` sets `"type":"module"`). No dependencies, no build.

The user's decks are 100-card **Commander** decks (1v1 vs AI: 40 life, command zone, commander tax, 21 commander damage).
Other formats (60 cards, 20 life, no commander) must also work. Card pool reference: `test/deck-cards.txt`
(all 270 unique cards in his four decks — name, cost, type, P/T, oracle text). New decks get added often, so behaviour
comes from **parsing oracle text**, with hand-written overrides only where the parser can't cope.

## Files and owners

| File | What | Rules |
|---|---|---|
| `engine.js` | Rules engine: state, turn structure, stack, combat, IR executor | Pure logic. No DOM, no `Date`, no `Math.random` (seeded RNG only). Deterministic. |
| `parser.js` | `compileCard(cardData) -> CardDef` from oracle text | Pure. Data out only (no functions in output). |
| `overrides.js` (+ `overrides-*.js`) | Per-card patches keyed by card name; may contain generator scripts | |
| `decks.js` | `buildDeck(appState, deckId)` → game deck from the app's stored deck | Pure. |
| `ai.js` | `decide(game, request, opts) -> answer` | Pure, deterministic given `game.rng`. Must not read hidden info. |
| `ui.js`, `game.css` | Lobby + board UI, animation, sound, persistence | Browser only. |
| `test/*.test.js` | `node --test game/test/` | |

Card data shape (from the app / `data/seed.json` `cards[set:cn]`): `{name, mana_cost, cmc, type_line, oracle_text, colors,
color_identity, pt:"2/3"?, loyalty?, img (Scryfall "normal" jpg url), faces?:[{name, mana_cost, type_line, oracle_text, pt?, img?}], flavor_name?}`.
Scryfall image sizes: replace `/normal/` in `img` with `/small/`, `/large/`, `/art_crop/`.

## 1. Engine API (contract for UI and AI)

```js
import { createGame } from "./engine.js";
const game = createGame({
  players: [ { name, deck: { commanders: [CardData], cards: [CardData] }, ai: false }, { ... ai: true } ],
  options: { startingLife: 40, commander: true, seed: 12345, firstPlayer: null /*random*/, handSize: 7, freeMulligan: true },
  compile,   // (cardData) => CardDef   — pass compileCard from overrides.js (which wraps parser.js)
});
game.start();            // runs until the first decision
game.request             // pending DecisionRequest, or null when game.over
game.respond(answer)     // validates (throws Error, state untouched, on an illegal answer), then runs to the next decision
game.state               // see §2. Treat as read-only outside the engine.
game.drainEvents()       // -> Event[] since last drain (§4)
game.over, game.winner   // winner: player index or null (draw)
game.concede(playerIdx)
game.answers             // every answer given so far, in order (for save/replay)
game.rng()               // seeded float in [0,1)
```

**Determinism is a hard requirement**: same decks + seed + same answers ⇒ same game. The UI saves `{setup, seed, answers}` and
resumes/undoes by replaying. Iterate arrays, never rely on object key order of mutable maps for anything rules-relevant.

Internally the engine is a generator-based state machine: any code that may need a decision is a `function*` and decisions
are `const ans = yield request;`. `respond()` calls `gen.next(answer)`. **Every call to a generator function must be
`yield* fn(...)`** — a bare call silently does nothing. Name every generator function with a trailing `$`
(`resolveEffect$`, `choose$`) and include a test that greps the engine/override sources for `\w+\$\(` calls not preceded by `yield* `.

## 2. State (read by UI and AI)

```
state = {
  turn, active /*player idx*/, step, priority /*player idx|null*/,
  players: [{ idx, id:"P0", name, ai, life, poison, mana:{W,U,B,R,G,C}, landsPlayed, landsPerTurn,
              library:[objId] /*top = last*/, hand:[], graveyard:[], exile:[], command:[],
              commanders:[objId], commanderCasts:{[objId]:n}, commanderDamage:{[commanderObjId]:n} /*taken from*/,
              ring:{ level:0..4, bearer:objId|null }, lost:false, drewFromEmpty:false, counters:{} }],
  battlefield: [objId],            // entry order
  stack: [objId],                  // top = last
  objects: { [id]: Obj },
  combat: null | { attackers:[{ obj, defender /*"P1" or planeswalker objId*/, blockers:[objId], blocked }] },
}
step ∈ untap, upkeep, draw, main1, beginCombat, declareAttackers, declareBlockers, combatDamage, endCombat, main2, end, cleanup

Obj = { id:"o17", owner, controller, zone:"library|hand|battlefield|graveyard|exile|command|stack",
        tapped, sick, counters:{"+1/+1":2,"loyalty":3,...}, damage, attachedTo, attachments:[],
        token, isCommander, face /*index for DFC/adventure*/, kicked, x,
        // stack items: spell objects are the card itself in zone "stack"; abilities are pseudo-objects
        isAbility, sourceId, targets:[id], text,
        def,            // CardDef (not serialisable; fine)
        c: { name, types:[], subtypes:[], supertypes:[], colors:[], power, toughness, loyalty, keywords:{}, cost, cmc, text, img, unparsed:[] }
}
```
`obj.c` is the *computed* characteristic set (after counters, static effects, until-end-of-turn effects, control changes);
the engine refreshes it after every state change. Types/keywords are lowercase (`"creature"`, `"flying"`). Players are
targeted by id `"P0"`/`"P1"`; everything else by obj id.

## 3. Decision requests and answers

Every request: `{ kind, player /*idx*/, prompt /*short human text*/, source? /*objId giving context*/ }` plus:

| kind | extra fields | answer |
|---|---|---|
| `mulligan` | `mulligans` (taken so far), `free` | `{ keep: bool }` (London mulligan; bottoming comes as a `choose`) |
| `priority` | `actions: Action[]` | `{ type:"pass" }` or `{ type:"act", index }` |
| `choose` | `options: Option[]`, `min`, `max`, `reason`, `ordered?` | `{ chosen: [optionIndex,...] }` |
| `confirm` | — | `{ yes: bool }` |
| `number` | `min`, `max` | `{ value }` |
| `attackers` | `candidates: [{ obj, defenders:[id] }]` | `{ attacks: [{ obj, defender }] }` (may be empty) |
| `blockers` | `attackers:[objId]`, `candidates: [{ obj, canBlock:[attackerObjId] }]` | `{ blocks: [{ obj, attacker }] }` (engine rejects illegal sets, e.g. lone blocker on menace) |

`Action = { type:"land"|"cast"|"activate"|"special", obj, label, cost? /*display string*/, zone, ability? /*index*/, mana? /*true = mana ability*/, variant? /*"flashback"|"adventure"|"kicked"|"cycle"|"commander"|"overload"|"face1"…*/ }`
Only *currently legal and affordable* actions are listed (timing, costs payable from pool + untapped sources, has legal targets).
`Option = { id? /*objId or "P0"*/, label, type:"object"|"player"|"card"|"mode"|"color"|"text" }`;
`reason ∈ target, sacrifice, discard, search, mode, order, bottom, scry, return, exile, pay, generic`.

Targets, modes, X (`number`) and optional costs are requested *after* the player picks a cast/activate action, as a short
sequence of requests; the spell goes on the stack only when all succeed. **Mana payment is automatic**: the engine pays
from the floating pool first and then auto-taps with a solver that keeps the most flexible sources untapped; manual tapping
is still possible because mana abilities appear as `priority` actions (pool empties at end of each step).
Trigger ordering, damage assignment order and trample assignment are automatic. A commander changing zones asks its owner
a `confirm` (“Return X to the command zone?”).

The engine always issues `priority` requests, even when the only option is passing; UI/AI decide about auto-passing.

## 4. Events (for animation + game log)

`{ t, text /*one readable line for the log*/, ...}` with `t` ∈
`turn{player,n}` `step{step}` `draw{player,obj}` `move{obj,from,to,player}` `cast{obj,player,targets}` `ability{obj /*stack item*/,source,player,targets,trigger?}`
`resolve{obj}` `countered{obj}` `damage{source,target,amount,combat}` `life{player,delta,life}` `tap{obj}` `untap{obj}`
`attack{obj,defender}` `block{obj,attacker}` `dies{obj}` `token{obj,player}` `counters{obj,kind,delta}` `mana{player,added}`
`shuffle{player}` `reveal{objs,player}` `ring{player,level,bearer}` `manual{source,text}` `lose{player,reason}` `win{player,reason}`.
`manual` = an effect/ability the engine couldn't automate (text shown so the human can resolve it by hand, see §8).

## 5. CardDef and the ability IR (contract between parser, overrides and engine)

```
CardDef = {
  name, cost:"{2}{B}", cmc, colors, identity, supertypes:["legendary"], types:["creature"], subtypes:["vampire"],
  power, toughness /*number or "*"*/, loyalty, img, text,
  keywords: { flying:true, ward:"{2}", protection:["black"], equip:"{1}", cycling:"{2}", flashback:"{4}{B}", kicker:"{5}", ... },
  abilities: [Ability],      // permanents' abilities; also static abilities of spells (cost reduction)
  spell: null | { targets?:[TargetSpec], effects:[Effect], modes?: ModeSet },   // instants/sorceries (and adventure halves)
  additionalCost: Cost|null,
  faces: null | [CardDef],   // adventure: [creature, adventureSpell]; transform/MDFC: [front, back]; layout:"adventure"|"transform"|"mdfc"
  layout,
  unparsed: [string],        // oracle lines the parser could not compile — shown to the player with a ⚠ badge
}
Ability =
  { kind:"static",    effect: Static, condition?: Cond, text }
  { kind:"triggered", on: Trigger, condition?: Cond /*intervening if*/, optional?: bool, targets?:[TargetSpec], effects:[Effect], modes?, text }
  { kind:"activated", cost: Cost, targets?:[TargetSpec], effects:[Effect], sorcery?: bool, mana?: bool, limit?: "turn", zone?: "graveyard"|"hand", text }
  // overrides only: any ability or spell may instead carry  run: function*(g, ctx){...}  (see §7) in place of effects.
Cost = { mana?:"{1}{B}", tap?, untap?, sacSelf?, sac?: Filter, sacCount?, discard?: n|Filter, discardSelf?, life?: n, removeCounters?: {kind,n}, exileSelf?, exileFromGraveyard?: n, tapOther?: Filter, x? }
TargetSpec = { what: Filter | "player" | "opponent" | "any" /*creature, planeswalker or player*/ | "spell" , min?:1, max?:1, spellFilter?: Filter, zone?: "graveyard"|"stack" }
ModeSet = { min, max, modes: [{ text, targets?, effects }] }
```

**Filter** (all present keys must match): `{ types?:[…any of…], notTypes?, subtypes?, supertypes?, controller?: "you"|"opponent"|"any",
owner?, other?: true /*not the source*/, token?: bool, colors?, notColors?, cmc?: {op,n}, power?: {op,n}, toughness?: {op,n},
tapped?: bool, attacking?, blocking?, keywords?:[…], notKeywords?, name?, zone? /*default battlefield*/, anyOf?: [Filter], isCommander?, self?: true }`.
`op ∈ "<=", ">=", "==", "<", ">"`; `n` may be an Amount.

**Ref** (who/what an effect acts on): `"self"` (source object) · `"you"` (controller) · `"opponent"` (each opponent) · `"eachPlayer"` ·
`{ref:"target", i}` (i-th TargetSpec; all its chosen targets) · `{ref:"all", filter}` · `{ref:"choose", filter, min, max, chooser?: Ref}` (chosen on resolution, not targeted) ·
`{ref:"event", what:"object"|"player"|"source"}` (from the triggering event: “that creature”, “that player”) ·
`{ref:"it"}` (object(s) produced/affected by the previous effect in this list) · `{ref:"controllerOf", of: Ref}` · `{ref:"ownerOf", of}` · `"equipped"` / `"enchanted"`.

**Amount**: number · `"x"` · `{count: Filter}` · `{powerOf: Ref}` · `{toughnessOf: Ref}` · `{cmcOf: Ref}` · `{countersOn: Ref, kind}` ·
`{handSize: Ref}` · `{lifeOf: Ref}` · `{prev: true}` (number produced by the previous effect: damage dealt, cards drawn, life lost, objects moved) ·
`{sacrificed:"power"|"toughness"|"cmc"}` (of the permanent sacrificed as a cost) · `{mul:[A,B]}` · `{add:[A,B]}` · `{half: A, round:"up"|"down"}`.

**Trigger** `on`: `{ event, who?: Filter|"self"|"you"|"opponent"|"each", … }` with `event` ∈
`enters` (who: Filter/self) · `dies` · `leaves` · `attacks` (who; `alone?`) · `blocks` · `becomesBlocked` · `dealsCombatDamage` (`to:"player"|"any"`) · `dealsDamage` · `dealtDamage` (enrage) ·
`beginStep` (`step:"upkeep"|"draw"|"beginCombat"|"end"`, `whose:"you"|"opponent"|"each"`) · `cast` (`who`, `filter` on the spell) · `gainLife` · `loseLife` · `draw` · `discard` · `sacrifice` (`who`, `filter`) ·
`counterAdded` · `becomesTarget` · `tapped` · `ringTempts` · `ringBearerChosen` · `tokenCreated` · `cycled` · `landPlayed`.
Compound triggers (“attacks or dies”) are emitted as two abilities.

**Effect** `{ op, … }`:
`damage{amount,to,from?}` · `draw{who,amount}` · `discard{who,amount,random?}` · `mill{who,amount}` · `gainLife{who,amount}` · `loseLife{who,amount}` · `setLife` ·
`destroy{what}` · `exile{what,until?:"sourceLeaves"|"endOfTurn"}` · `bounce{what}` · `sacrifice{who,filter,amount}` (affected player chooses) · `sacrificeIt{what}` ·
`move{what,to:"hand"|"battlefield"|"graveyard"|"library"|"exile",position?:"top"|"bottom"|"shuffle",tapped?,control?:"you"}` (graveyard recursion, reanimation, tuck) ·
`search{who,filter,min,max,to,tapped?,reveal?}` (then shuffle) · `scry{amount}` · `surveil{amount}` · `shuffle{who}` ·
`counter{what,unlessPay?}` · `createToken{who,token:TokenDef|"treasure"|"food"|"clue"|"blood"|"map",amount,tapped?,attacking?,copyOf?:Ref}` ·
`addCounters{what,kind,amount}` · `removeCounters` · `pump{what,power,toughness,keywords:[],until:"endOfTurn"}` · `gainControl{what,until?}` ·
`tap{what}` · `untap{what}` · `fight{a,b}` · `attach{what,to}` · `addMana{mana:"{C}{C}"|{any:n}|{anyOf:["R","W"],n}|{identity:n},who?}` ·
`ringTempts{who}` · `amass{amount,subtype}` · `copySpell{what}` · `transform{what}` · `extraTurn` · `extraCombat` · `win{who}` · `lose{who}` ·
`if{cond,then:[Effect],else?:[Effect]}` · `may{who?,cost?:Cost,effects:[Effect],else?:[Effect]}` (“you may [pay…]. If you do, …”) · `modes{…ModeSet}` ·
`forEach{over:Ref,effects}` · `delayed{at:Trigger,effects,once:true}` · `until{until:"endOfTurn"|"yourNextTurn",static:Static}` · `manual{text}` (can't automate; engine emits a `manual` event and carries on).
`TokenDef = { name, types, subtypes, colors, power, toughness, keywords?, abilities? }`.
Rule of thumb for multi-sentence text: one Effect per clause, in order; later clauses refer back with `{ref:"it"}` / `{prev:true}`.

**Static** `{ type, … }`: `pump{affects:Filter|"self"|"equipped"|"enchanted",power?,toughness?,keywords?:[],abilities?:[Ability]}` ·
`setPT{power:Amount,toughness:Amount}` (characteristic-defining) · `cantBlock{affects}` · `cantAttack` · `mustAttack` · `cantBeBlocked{affects,exceptBy?:Filter}` · `cantBeCountered` ·
`costMod{filter /*spells*/,who:"you"|"opponent",amount:-1}` · `selfCostMod{per:Amount,amount:-1}` · `entersTapped{affects:"self"|Filter,unless?:Cond}` ·
`entersWithCounters{kind,amount}` · `noMaxHand` · `extraLand{n}` · `doubleTriggers{event:"dies"|"enters",filter}` · `damageMod{…}` · `asType{affects,addTypes,addSubtypes}` · `playerProtection` · `custom{id}`.

**Cond**: `control{filter,op,n}` · `life{who,op,n}` · `handSize{who,op,n}` · `yourTurn` · `kicked` · `counters{what,kind,op,n}` · `inZone{what,zone}` ·
`event{…}` (property of the triggering event) · `did` (the previous optional/cost happened) · `not{c}` · `and{all}` · `or{any}`.

Anything the parser can't express: put the raw line in `unparsed` (and emit `manual{text}` where a concrete effect slot is unparseable
inside an otherwise parsed ability). **Never guess** — a wrong automation is worse than a `manual`. Unknown `op`/`type`/`event` values must not crash the engine: treat as `manual`.

## 6. Rules scope (engine)

Must have: full turn structure and priority with a real stack (instants/flash/abilities in response, both players); mana pool; lands (one per turn, extraLand);
casting with cost reduction/increase, X, additional costs, kicker, flashback, cycling, adventure (cast half → exile → cast creature), equip, auras, overload, delve, MDFC/transform faces;
commander rules (command zone, +{2} tax per prior cast, zone-change replacement choice, 21 combat damage from one commander = loss);
combat: attackers (summoning sickness, vigilance, defender, haste, must/can't attack), blockers (flying, reach, menace, can't block, can't be blocked, protection, intimidate/fear/skulk-style evasion via `cantBeBlocked.exceptBy`),
first/double strike damage steps, trample, deathtouch, lifelink, indestructible, planeswalkers (loyalty abilities, attackable);
state-based actions (0 life, 0 toughness, lethal damage, deathtouch, legend rule, +1/+1 vs -1/-1, aura/equipment legality, token cleanup, draw from empty library, 10 poison);
hexproof, shroud, ward (counter unless paid), protection (DEBT), menace, changeling, devoid, undying, persist, exploit, echo, flash, infect/toxic, prowess, annihilator if cheap to add;
triggers with APNAP ordering, intervening-if, `doubleTriggers` (Drivnod-style), delayed triggers, until-end-of-turn effects, cleanup (discard to hand size, damage wears off);
tokens incl. predefined Treasure/Food/Clue/Blood/Map/Eldrazi Scion/Spawn; token copies; counters of any kind;
London mulligan (first one free in Commander if `freeMulligan`); the player going first skips their first draw only in 2-player non-commander games (Commander: everyone draws).
**The Ring tempts you** (many cards in the pool): per-player Ring level 1–4, choose a creature as Ring-bearer (legendary; can't be blocked by greater power; attacks → draw then discard; blocked-by creature sacrificed at end of combat; deals combat damage to player → each opponent loses 3), fires `ringTempts` / `ringBearerChosen` triggers.
Layer system may be simplified (copy → control → type → abilities → P/T set → P/T modify incl. counters), timestamps for ordering.
Not required (treat as plain castable permanents/spells, flag the line as `unparsed`): mutate, morph, hideaway, banding, phasing, day/night, dungeons, stickers.

## 7. Script API for overrides (`run: function*(g, ctx)`)

`ctx = { source /*Obj*/, you /*player idx*/, targets /*[[id…] per TargetSpec]*/, x, event /*trigger event*/, kicked, modes /*chosen indices*/, sacrificed /*[Obj snapshot]*/ }`.
The engine exposes these stable helpers on `g` (generators end in `$`, call with `yield*`):
`g.obj(id)`, `g.player(idx)`, `g.opponentsOf(idx)`, `g.find(filter, ctx)` → Obj[] (any zone via `filter.zone`), `g.matches(obj, filter, ctx)`, `g.amount(A, ctx)`,
`g.dealDamage(sourceObj, targetId, n)`, `g.draw(p, n)`, `g.gainLife(p, n)`, `g.loseLife(p, n)`, `g.destroy(obj)`, `g.exile(obj)`, `g.bounce(obj)`, `g.sacrifice(obj)`,
`g.moveTo$(obj, zone, opts)`, `g.createToken(p, tokenDefOrName, n, opts)` → Obj[], `g.addCounters(obj, kind, n)`, `g.tap(obj)`, `g.untap(obj)`, `g.addMana(p, "{R}{R}")`,
`g.pumpUntilEOT(obj, {power, toughness, keywords})`, `g.addUntilEOT(static, ctx)`, `g.delayed(trigger, fn$, ctx)`, `g.ringTempts$(p)`, `g.log(text)`, `g.emit(event)`,
`yield* g.choose$(p, {prompt, options, min, max, reason})` → chosen Option[], `yield* g.chooseObjects$(p, objs, {prompt, min, max, reason})` → Obj[],
`yield* g.confirm$(p, prompt)` → bool, `yield* g.number$(p, prompt, min, max)`, `yield* g.runEffects$(effects, ctx)` (execute IR from a script), `yield* g.payCost$(p, cost, ctx)` → bool.

`overrides.js` exports `compileCard(cardData)`: `parser.compileCard(cardData)` then applies `OVERRIDES[name]` (a full replacement def fragment, or
`{ patch(def){…} }`). An override clears the matching entries from `unparsed`. It also exports `coverage(cardData)` → `{ full: bool, unparsed: [...] }` for the UI badge.

## 8. Honesty about unsupported text

Cards with `unparsed` lines still work as cards (types, P/T, keywords, parsed abilities). The UI badges them (⚠ “partly automated”), and
when a `manual` event fires it shows the text. The human has a **manual tools** menu (adjust life, add/remove counters, draw, create a token,
move a card between zones, tap/untap) exposed via `priority` actions of `type:"special"` so they are recorded in `game.answers` and replay deterministically.
The AI never uses manual tools; its `manual` effects are simply skipped (and logged).

## 9. Testing conventions

`node --test game/test/` must pass. `test/helpers.js` (owned by the decks agent) loads `../../data/seed.json` + `test/fixtures-cards.json`
and exports `loadSeed()`, `allDecks()` → built decks, `cardByName(name)`. Engine tests should build small scenario games from named cards or hand-written CardDefs.
Simulation: `node game/test/sim.js [--games N] [--seed S]` plays AI-vs-AI across all deck pairings and reports crashes (with seed + answers to reproduce),
games exceeding 60 turns, and stalls (same request answered > 5000 times).
