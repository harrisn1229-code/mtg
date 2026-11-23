
## Parser IR extensions (parser.js / parser-effects.js / parser-filters.js)

Everything below is emitted by the oracle-text compiler beyond the vocabulary in SPEC §5. Conventions chosen: Cond objects use
`{type:"control"|…}` (like Static); keyword keys are the lowercase oracle names, with spaces (`"first strike"`, `"double strike"`);
colours are letters `"W","U","B","R","G"`; `types/subtypes` in a Filter are any-of; TokenDef `keywords` is a map `{deathtouch:true}`.
Lines the parser cannot map go to `def.unparsed` (raw text). When only a *later sentence* of an otherwise parsed ability is unclear
the ability is kept with an `{op:"manual",text}` effect AND the raw line is also listed in `def.unparsed` (so the UI badges it).

**CardDef**: `enchant: Filter` (Aura "Enchant land"). `faces[]` for adventure/transform/mdfc; the top-level def mirrors the front face
(name = full "A // B" name). Keywords with values: `escape:"{3}{B}{B}"`, `escapeExile:4`, `annihilator:n`, `toxic:n`, `partner:true`.
Keyword lines the engine doesn't implement (hideaway, crew, convoke, bestow, …) are `unparsed`; mutate, morph, increment, craft, spectacle and more are now supported (see "Full-automation pass").

**Cost**: `loyalty: n|"-x"` (planeswalker ability; ability also has `loyalty:true, sorcery:true, limit:"turn"`) · `exileFromGraveyard:n` + `exileFilter` ·
`tapOther:Filter` + `tapOtherCount` · `life:"x"` · `additionalCost:{oneOf:[Cost,Cost]}` ("sacrifice a creature or pay {4}").

**Ability**: activated may carry `condition: Cond` ("Activate only if/during your turn") · triggered/activated `zone:"graveyard"` when it works from the graveyard
(Bloodghast landfall, "Return this card from your graveyard…").

**Trigger**: `who:"equipped"|"enchanted"` · `enters{from:"graveyard"}` · `cast{orCopy:true}` ("cast or copy") · `dealsCombatDamage{batch:true}` ("one or more creatures … deal combat damage": one trigger per damage step, `{event:"amount"}` = total) ·
`becomesTarget{by:"spell"}` · events `exploits`, `tokenCreated`, `sacrifice{filter}` · `beginStep.step` also `"main1"|"main2"`, `whose:"you"|"opponent"|"each"` (for "each", `{ref:"event",what:"player"}` is the turn's player).
Event refs: `{ref:"event",what:"object"|"player"|"source"}`; "that spell's controller" = `{ref:"controllerOf",of:{ref:"event",what:"source"}}`.

**Filter**: `allTypes:[…]` (ALL listed types, e.g. "artifact creature") · `notSubtypes` · `notSupertypes` · `player:true` (only inside a TargetSpec `anyOf`, e.g. "target player or planeswalker") ·
"defending player controls" is `controller:"opponent"`. Graveyard/hand cards: `zone`, `owner`.

**Amount**: `{greatest:"power"|"toughness"|"cmc", of:Filter}` · `{sum:…, of:Filter}` · `{devotion:["B"]}` · `{numOpponents:true}` · `{event:"amount"}` (amount of the triggering damage/life event) ·
`{handSize: Ref}` with a target ref · Amounts are allowed for token `power/toughness`, static/effect `pump.power/toughness`, `addCounters.amount`.

**Effects**: `animate{what,power,toughness,colors,subtypes,keywords,until}` (manlands: becomes a creature, stays a land) ·
`until{until:"endOfTurn", static:{type:"cantBeBlocked"|"cantBlock"|"cantAttack"|"setBasePT", affects: Ref, …}}` (here `affects` is a Ref) ·
`counter{what, unlessPay:"{3}"}` · `may{who?, cost?, effects, else?}` where `who` is a Ref (e.g. the event player) · `if{cond,then,else}` (also used for "… instead") ·
`addMana.mana` = `"{C}{C}"` | `{anyOf:["R","W"],n:1}` | `{any:n}` (n mana of ONE chosen colour) | `{identity:n}` | `{color:"G", n:Amount}` ·
`scry/surveil{amount, who?}` (who only when not "you") · `damage{amount,to,from?}` (from omitted = the source) · `search{…,min:0,max,to,tapped?,reveal?,position?}`
(a Cultivate-style "one to battlefield, other to hand" is emitted as two searches) · `move{what,to,position?:"top"|"bottom"|"shuffle",tapped?,control?}` ·
`createToken{copyOf}` for token copies · `pump{what,power,toughness,keywords:[],until?}` always has numeric/Amount power & toughness (0 if none).

**Static**: `entersTapped{affects:"self", unless?:Cond, unlessPay?:Cost}` · `entersWithCounters{kind,amount}` · `selfCostMod{per:Amount,amount:-N}` (+ ability `condition`) ·
`costMod{filter,who,amount}` (amount −N / +N generic) · `castFree` (ability `condition` = control a commander) · `castFrom{zone:"graveyard"}` (ability `condition`) ·
`doubleTriggers{event:"dies"|"enters",filter}` · `damageMod{source?:Filter, sourceController?:"you", to:"any"|"opponent"|"you"|"opponentOrPermanent"|"youOrPermanent", mul?|add?|prevent?:"half"}` (matches engine.modifyDamage) ·
`setPT{power:Amount,toughness:Amount}` · `pump{affects, power, toughness, keywords?}` with ability `condition` for "as long as"/"during your turn".

**Cond**: `control{filter,op,n}` · `counters{what:"self",kind,op,n}` · `life{who,op,n}` · `handSize` · `yourTurn` · `kicked` · `did` · `not{c}` ·
`matches{what:Ref,filter}` ("if that creature is legendary") · `sacrificed{filter}` ("if the sacrificed creature was legendary") ·
`hasInHand{filter}` (reveal-lands: you could reveal such a card — auto-true when the hand holds one) · `opponents{op,n}` (number of opponents).

**ModeSet**: `maxIf:{cond,max}` (Jeska's Will: "you may choose both instead").

## Engine notes (engine agent)

Files: `engine.js` (core, API, triggers, SBA, turns) + `engine-util.js`, `engine-chars.js`, `engine-mana.js`, `engine-effects.js`, `engine-actions.js`, `engine-combat.js`.

**API additions**
- Extra exports: `STEPS, parseManaCost, costToString, costCmc, canPay(game,p,costStr), spellCostFor(game,p,objId,variant), manaAvailable(game,p), describeCost, TOKENS, makeRng, isPermanentCard, hasType, publicAction`.
- `game.error` — the Error that aborted a game (engine bug; game then ends as a draw), else `null`.
- `game.refreshRequest()` — recompute the pending `priority` request's actions after out-of-band state edits.
- `game.defaultAnswer(req)` — a minimal always-legal answer (used for concede/fallbacks).
- `respond({ concede: i })` is accepted and recorded in `game.answers` (so replay reproduces concessions); `game.concede(i)` records the same.
- Options: `maxTurns` (default 300 → draw), `manualTools` (default true; only non-AI players get `special` actions), `maxHandSize` (7).
- `obj.c.abilities` = the object's current ability list; `Action.ability` indexes into it.
- Choose requests whose answer is forced (`min === options.length`, e.g. a single legal target) are auto-answered and never issued.

**Events**: extra `log{text}` type. Events carrying `silent:true` are animation-only duplicates (auto-pay taps/mana, untap-step untaps, the `dies` event that follows a "X dies" `move`) — the log can skip them.

**Requests**: `attackers` — creatures with `mustAttack` are added automatically if omitted. Planeswalkers are listed in `defenders` by obj id.

**IR the engine supports beyond §5** (parser may use):
- Effects: `animate{what,power,toughness,types?,subtypes,colors,keywords,until}`, `bite{a,b}` (one-sided fight), `explore{what}`, `proliferate`, `exileTop{who,amount,until:"endOfTurn"|"nextTurn",free?}` (impulse draw; may play from exile), `lookTop{amount,take,filter?,to?,rest:"bottom"|"graveyard",upTo?}`, `reveal{what}`, `noop`. `damage.divided:true` splits evenly. `sacrifice.least:true` (least power), `sacrifice.ifCant:[Effect]`. `search.to` may be an array (i-th chosen card → to[i], last repeats; Cultivate). `addMana.amount: Amount` (repeat), `addMana.mana:{color, n}`.
- Amounts: `{devotion:"B"}`, `{greatestPower:Filter}`, `{greatest:"power"|"toughness", of:Filter}`, `{totalPower:Filter}`, `{opponents|numOpponents:true}`, `{event:"amount"}`, `{sub:[A,B]}`.
- Conds (key `type`): also `count`, `notYourTurn`, `controlCommander`, `opponentLostLife`, `opponents`, `matches{what,filter}`, `sacrificed{filter}`, `hasInHand{filter}`, `ringBearer`. Unknown cond → false (+ one manual note).
- Refs: `"activePlayer"`, `{ref:"defendingPlayer"}`, `{ref:"sacrificed"}`, `{ref:"event", what:"controller"|"target"}`.
- Filters: also `allTypes`, `notSubtypes`, `notSupertypes`, `nontoken`, `not`, `ringBearer`, `counters:{kind}`; `{player:true, controller}` matches players.
- Statics: `damageMod{source?:Filter, to:"any"|"opponent"|"you"|"opponentPermanent"|"yourPermanent"|"opponentOrPermanent"|"youOrPermanent"|"creature"|"player"|Filter, add?, mul?, prevent?:"half"|"all"|n}` (adds, then multiplies, then prevention). `asType{affects,addTypes,addSubtypes,setTypes?,colors?,power?,toughness?,keywords?}`. `setBasePT` = `setPT`. `castFree` (with condition) → `variant:"free"` cast. `castFrom{zone:"graveyard"}` (with condition). `castAsFlash`. `doubleTriggers{event:"dies"|"enters"|[...],filter,times?}`.
- Costs: `loyalty: n | "-x"`, `oneOf:[Cost]` (player picks a payable one), `exileFilter` with `exileFromGraveyard`, `tapOther` + `tapOtherCount`.
- Triggers: `on.filter` works on any object event; extra events `exploits`, `untapped`; `beginStep.step` may be any step name incl. `main1`/`endCombat`; `on.from` for enters (zone).
- Keywords synthesised by the engine: equip, cycling (zone hand), prowess, undying, persist, exploit, annihilator N, echo, storm, ward "{N}" (mana; "N life" also), toxic N, infect, wither, changeling, devoid, flash, protection [colors | type words | "everything" | "ring-bearers" | Filter], hexproof/shroud, intimidate/fear/skulk/shadow evasion. `keywords.escape` may be a string or `{cost, exile:n}`; `keywords.kicker/flashback/overload` strings.
- Auras target `def.enchant` (Filter) — parser already emits it.
- Abilities that work from another zone: `ab.zone:"graveyard"|"hand"|"exile"|"command"|"stack"` (activated and triggered).
- Mana abilities: autopay uses `{T}`/`{Q}`-cost abilities (with `{N}` generic input, life, or sacrifice-self on non-creatures like Treasure) and, only when nothing else can pay, "costly" sources: sacrifice-a-creature mana (Scion, Ashnod's Altar) and coloured-input filter lands (see "Full-automation pass").

**Not implemented**: day/night, dungeons, stickers, "can block additional creatures", crew, convoke, bestow (no deck card uses them). Combat damage assignment among several blockers is automatic but rules-legal (CR 510.1c-d after the 2024 update: any split; a trampler must assign lethal — counting damage already marked and deathtouch — to every blocker before the player). Combat damage to a planeswalker that left the battlefield is not dealt (correct per CR 506.4). The other former simplifications are gone (see "Full-automation pass").
- (engine, later) Parser extensions now consumed: trigger `who:"equipped"|"enchanted"`, `cast{orCopy}` (copies fire `cast` with `copy:true`), `dealsCombatDamage{batch:true}` (one event per damaged player per damage step; `{event:"amount"}` = total from matching sources), `{sum,of}`, `until` with Ref `affects`, `addMana{color,n}`, `keywords.escapeExile`, `ModeSet.maxIf`, Amount-valued token P/T.
  `entersTapped.unlessPay` is a real "as this enters" choice now (no trigger).
- Note: Node 22 `node --test game/test/` (a directory) errors; use `node --test game/test/*.test.js`.

## Override agent: engine requests
(append-only; written by the overrides agent. Each item lists the card(s), the missing hook, and what the override does meanwhile. Overrides gate speculative IR behind `CAPS` in `game/overrides-1.js`; flip the flag once the hook exists.)
- **Static `{type:"lethalByPower"}`** (Zilortha, Strength Incarnate): SBA and combat damage assignment treat "lethal" as power instead of toughness for the controller's creatures. Meanwhile the line stays in `unparsed` (card is a 7/3 trampler). Flag: `CAPS.lethalByPower`.
- **Cond `{type:"compare", a:Amount, op, b:Amount}`** plus Amounts `{startingLife:true}`, `{lifeGainedThisTurn:Ref}`, `{devotion:[colors]}` (Heliod and Purphoros "isn't a creature below devotion 5" via `asType{setTypes}` + this cond; Righteous Valkyrie uses `life>=47` with the existing `life` cond; Resplendent Angel uses a `run` script that reads `lifeGainedThisTurn`). Flag: `CAPS.compareCond`.
- **`g.castFree$(p, obj, opts)`** (Etali, Kari Zev's Expertise, Mosswort Bridge): cast without paying the mana cost, using the normal target/mode prompts. Overrides carry a local fallback that handles permanents and simple spells.
- **Fellwar Stone**: mana solver should know "any colour an opponent's land could produce" (the override's `run` ability works only when activated manually).
- **Static `{type:"cantGainLife", who:"opponent"}`** (Tibalt, Rakish Instigator). Line stays flagged; -2 Devil works. Flag: `CAPS.cantGainLife`.
- **Static "activate abilities as though haste"** (Thousand-Year Elixir).
- **Event `zoneChange{from,to}` for card objects** (Syr Konrad: creature card put into a graveyard from anywhere but the battlefield / leaving your graveyard). The "another creature dies" part is implemented.
- **Event `abilityActivated{source,isMana}` + copy-ability on the stack** (Rings of Brighthearth, Illusionist's Bracers).
- **Mana spent tracking and restrictions** (`manaSpent` provenance; "spend this mana only to ..."): Secluded Courtyard, Path of Ancestry's scry, Topiary Lecturer (Increment). Overrides remove the unrestricted any-colour mana rather than hand out unrestricted mana.
- **Enters-as-copy and "as this enters, choose" replacement hooks** (Spark Double; Outpost Siege's choice is stored by a script on resolution; Secluded Courtyard's creature-type choice).
- **Phasing** (Teferi's Protection phases permanents out; the override gives protection from everything + life lock only and keeps the phasing line flagged).
- **Mutate, morph / face-down** (Everquill Phoenix, Gemrazer, Grim Haruspex). UIs should hide `obj.faceDown` cards (Mosswort Bridge's hideaway sets it).
- **Spectacle** alternative cost (Light Up the Stage), **craft** (Tithing Blade // Consuming Sepulcher).
- **Triggered mana abilities** (Wolfwillow Haven's extra {G} when the enchanted land is tapped for mana).
- **Bug**: `may{cost:{sac:...}}` does not propagate `ctx.sacrificed` to the `then` effects (the Ruthless Technomancer override works around it).
- **Parser mis-parse found (fixed by override)**: `control` Cond only counts your permanents unless `filter.controller` is set, so "if no creatures are on the battlefield" (Pyrohemia) parsed wrongly. Parser should emit `{type:"count"}` for unqualified "are on the battlefield"/"exist" conditions.

## UI agent: engine issues
- No blocking engine bugs found in ~20 full real-engine games (all 4 decks, scripted human vs random bot and vs ai.js): no game.error, no stuck requests, replay/resume/undo reproduce identical state.
- Minor: manual-tool `choose` requests use `type:"text"` options with non-object ids (e.g. "treasure"); the UI shows them in a picker, which works, but a `reason:"mode"`-style hint would be clearer.

## AI / sim agent
- **`ai.js`**: `decide(game, request, {difficulty})` (easy|normal|hard) answers every §3 request kind, validated with `game.validate` and falling back to `game.defaultAnswer`. Never calls `game.rng()` nor mutates state (enforced by `test/ai.test.js`); its own randomness is a private PRNG seeded from `answers.length`, turn, step, player. Uses only public info + its own hand. Per-turn memory (activation caps, "this action did nothing" bans, planned targets/modes for the follow-up requests) lives in a WeakMap keyed by the game — replays don't need it. `mood(game, p)` → "winning"|"losing"|"even". `Brain` and `fight` are exported for tests/debugging.
- **Request hints (engine, additive)**: requests may carry a NON-enumerable `_hint` (invisible to JSON/spread/UI): target chooses `{kind:"target", index, spec, effects, chosen}`, mode chooses `{kind:"mode", modes}`, optional triggers / `may` confirms `{kind:"may", effects, cost, else}`, `{kind:"commander"|"payToKeep"|"ward"|"echo"|"explore"|"keep"|"ringBearer"|"x"}`, and choices made during an effect `{kind:"effect"|"choose", effects:[currentEffect]}`. `chooseTargets$(p, specs, src, ctx, effects?)`, `confirm$(p, prompt, source, hint?)`, `number$(…, source, hint?)` gained optional trailing params.
- **Engine additions**: `game.lethalThreshold(o)` + static `{type:"lethalByPower", affects}` (SBA and combat assignment; Zilortha) · static `{type:"cantGainLife", who:"opponent"|"you"|"each"}` · Cond `{type:"compare", a, op, b}` · Amounts `{startingLife:true}`, `{lifeGainedThisTurn:Ref}`, `{lifeLostThisTurn:Ref}` · `*castFree$(p, obj, {face})` (normal cast flow with variant "free") · `may{cost}` now passes what was sacrificed to the following effects (`{sacrificed:…}` amounts / `{ref:"sacrificed"}`). The four matching `CAPS` flags in overrides-1.js are now `true`.
- **Parser fixes**: quoted token ability after "you may create …" (Pawn of Ulamog) · "Each player who can't discards a card" → `sacrifice.ifCant` (Plaguecrafter) · "no creatures are on the battlefield" → `{type:"count"}` (Pyrohemia). (The old "spend this mana only" rider-dropping is gone: riders are now real `restrict` / `onSpend` IR.)
- **`test/sim.js`**: `node game/test/sim.js [--games N per pairing] [--seed S] [--difficulty d | --d0 d --d1 d] [--pair i,j] [--max-turns 60] [--verbose] [--trace] [--no-overrides] [--quiet]`. `--trace` interleaves every AI decision into the log; `--no-overrides` compiles with the bare parser to list cards that still emit `manual` events. Exports `playGame`, `runSim`, `describeDecision`.

## Full-automation pass
Goal: every card in the four decks fully and correctly automated (`node game/test/flagged.mjs` → `flagged 0`), each mechanic with engine + AI
support and scenario tests (`test/automation.test.js`, helpers in `test/scenario.js`). All additions are additive; saved games from
before this pass don't replay (the UI detects that: see UI below).

**New module** `engine-ext.js` (mixed into Game): entry choices, commander replacement, mutate, morph, phasing, restricted mana, ability copies,
division, craft, triggered mana abilities, land colours. `sw.js` lists it (VERSION v1.2.0).

**Engine API / helpers (additive)**: `*enter$(o, opts)` (put onto the battlefield after its "as enters" choices) · `*entryChoices$` / `defaultEntry`
(deterministic fallback for engine-internal sync moves) · `*zoneMove$(o, to, opts)` (generator zone change: CR 903.9b commander → command zone
instead of hand/library, entry choices for the battlefield; `g.moveTo$` now uses it) · `*drawCards$(p, n)` (draw with the commander replacement;
used by the draw step and `draw` effects) · `copiableDef(o)` (CR 707.2: face-down 2/2, merged values, a copy's values) · `copyResultDef` ·
`*chooseCreatureType$(p, src, def)` / `creatureTypeOptions(p)` (your own types first) · `*resolveMutate$`, `mergeInto(card, host, over)`,
`updateMergeDef`, `splitPile` · `faceUpCost(o)`, `*turnFaceUp$(p, o)`, `revealFaceDown()` · `phaseOut(objs)`, `phaseIn(p)` ·
`restrictOk(restrict, spend)`, `resolveRestrict`, `onSpendMatches`, `fireOnSpend`, `addManaUnits`, `usableManaX` · `*copyAbility$(stackAbility, p, newTargets)` ·
`*chooseDivision$(p, effects, targets, src, ctx)` · `craftCands` · `extraManaUnits(land, p)`, `*runManaTriggers$` · `landColors(players)` ·
`planCore` (the old solver) under `planPayment` (now: cheap sources first, then up to 3 costly activations) · `sharesTypeWithCommander(o, p)`,
`creatureTypesOf(c)` · `*orderCards$(p, cards, "top"|"bottom", ctx)`. `payMana$` opts: `spend`, `protect` (a creature the payment may not sacrifice).
`spendFromPool(p, cost, spend)` sets `game._lastSpend = {n, units}`. `MANUAL_TOOLS` export (engine-actions.js).

**State / object fields (additive)**: `state.phased:[id]` (phased-out permanents, `zone:"phased"`, `phasedController`, `phasedIndirect`) ·
`state.resolutions` (per-ability resolution counts this turn) · `player.manaX:[{c, restrict, onSpend, srcId, srcName}]` (spend-restricted / tracked mana;
emptied with the pool) · `player.lifeLocked` · `obj.faceDown` (on the battlefield/stack: `obj.c` is the face-down 2/2; the real card stays in `obj.def`;
UIs/AI must not read `def` of an opponent's face-down object) · `obj.pile:[cardId…]` top first + `obj.mergeDef` (merged permanent; other pile cards
have `zone:"merged"`, `mergedInto`) · `obj.pileLeft` · `obj.chosen:{creatureType?, color?, mode?}` (as-enters choices, reset when it leaves) ·
`obj.manaSpent` · `obj._division` · stack abilities carry `sourceTs`, copies `isCopy`.

**Events (additive)**: `mutate{obj, card, over}` · `faceUp{obj}` · `phase{objs, out}` · `mana{…, restricted}` · `ability{…, copy:true}` ·
`cast{…, manaSpent}` · triggers can listen to `zoneChange{obj, from, to}` (cards only; pile cards count as from the battlefield),
`abilityActivated{obj, ability, player, isMana}`, `mutates`, `turnedFaceUp`, `scry{player, amount}`, `manaSpent` (internal).

**Requests**: new `choose` reasons `mutate` (options `over`/`under`), `copy` (enter as a copy; min 0), `creatureType`, `color`, `reveal`, `order`
(`ordered:true`: "in any order" placements, scry/surveil order); `number` with hint `{kind:"divide", ids, index, assigned, total, op}`;
`confirm` hints `{kind:"shock", life}`, `{kind:"newTargets"}`, `{kind:"commander"}` (also before hand/library moves and draws), may-hints carry `event`.
Actions: cast `variant` `mutate` | `morph` | `spectacle`; `{type:"activate", variant:"faceUp"}` (special action, no `ability` index);
`sacForMana:n` on casts whose payment needs sacrifice-for-mana sources (label ends "— sacrifices for mana"); manual tools are
`special` actions with variants `life cmdDamage mana draw discard mill shuffle tap counters token control sacrifice destroy exile bounce graveyard library move`.

**IR (parser + engine)**: keywords `mutate`, `morph`, `megamorph`, `spectacle`, `unearth` (cost strings), `increment`, `cascade`, `afterlife:n`,
`<land type>walk`, `craft:{cost, with:Filter, n}`, `typecycling:{cost, filter}` (basic landcycling), `flashback:{cost, add:Cost}` ·
statics `asEntersCopy{filter, optional, except:{nonLegendary, counters:{creature|planeswalker:{kind:n}}, addTypes}}`,
`asEntersChoose{choice:"creatureType"|"color"|"mode", options?, except?}`, `activateAsHaste{affects}`, `exileInsteadOfDying{affects}`,
`lifeCantChange`, `cantPrevent`, `playerProtection{from:"everything"}` (protection no longer locks life by itself) ·
triggers `mutates`, `turnedFaceUp`, `abilityActivated{who:"you"|"equipped"|…, nonMana}`, `zoneChange{from?, to?, notFrom?, filter}`, `scry`,
`tapped{forMana}` + ability `manaTrigger:true` (resolves immediately, CR 605.4a), `enters{from:"graveyard", fromYours}` · effects `phaseOut{what}`,
`copyAbility{what, newTargets}`, `copySpell.newTargets`, `exileTop{until:"endOfTurn"|"endOfYourNextTurn", mayPlay, castOnly}`,
`damage{divided}` / `addCounters{divided}` with targets `{min, max}` (split chosen as it's cast/put on the stack), `chooseCreatureType`,
`_craftReturn`, `_unearth`, `_cascade` · `addMana` `restrict:{spell:Filter, ability:Filter}` / `onSpend:{spell:Filter, effects}`, mana
`{landColors:"opponent"}`, `{chosenColor, anyOf?}`, `{anyOf, n, split:true}` (filter lands) · conds `chosen{key, value}`, `resolvedCount{op, n}`,
`compare` on `{event:"manaSpent"}` · filters `chosenType`, `notChosenType`, `sharesTypeWithCommander`, `faceDown` · refs `{ref:"event", what:"ability"}`.

**Rules now exact (were simplified)**: Fellwar Stone in the auto payer · sacrifice-for-mana / filter lands in the auto payer (asks which creature) ·
divided damage/counters (asked; AI kills what it can) · "Damage can't be prevented this turn" (Stomp: protection, damageMod prevention and
player protection are switched off) · shocklands / reveal-lands as real as-enters choices · CR 903.9b for hand/library (asked before the move;
engine-internal sync moves still fall back to the SBA question) · P/T-dependent statics iterate to a fixed point (no stale power reads) ·
Elrond's "second time this ability has resolved this turn" (per object incarnation) · Outpost Siege's choice (no counters/trigger) ·
"in any order" bottom/top placements and scry/surveil ordering are asked · summoning sickness only restricts a creature's own {T}/{Q} costs
(tapping it for another cost is allowed; {Q} now checks it) · Righteous Valkyrie (starting life + 7) and Resplendent Angel (intervening if) ·
Anger of the Gods' exile replacement lasts the turn · Skullclamp-style "equipped/enchanted creature dies" look back · "Sacrifice X …" costs ask X ·
"from your graveyard" checks ownership · Frantic Search may untap any lands · Ram Through uses the real lethal threshold.

**Browser bug fixed**: parser.js referenced Node's `process` whenever a line failed to parse; in the browser that threw and every such card fell
back to an un-automated def (all overridden cards showed ⚠). Guarded, plus a lint test for Node-only globals.

**AI**: mutate (best host, over/under by value), morph (as a 2/2, turns face up when worth it), craft, Teferi's Protection only when facing lethal,
divided splits, Spark Double copies its best permanent, shocklands, sacrifice-for-mana penalty, "in any order" (best card on top), Rings copies
valued through the event. Never peeks at the opponent's hand or face-down cards.

**UI**: face-down cards render as card backs for the opponent (your own show their real card in the zoom with "Turn face up"); merged permanents
show a ⧉ badge and the pile in the zoom; phased-out permanents are ghosted in place; chosen type/colour/mode, copies and "Copy" stack items are
labelled; restricted (🔒) and bonus (★) mana show ringed in the pool; new cast variants are zoom buttons; the creature-type picker is searchable;
the tools sheet is grouped (Players / Permanents / Cards & zones) and also reachable from the pause menu. Saved matches carry `ev`
(`SAVE_EV` in ui-match.js): an older save, an illegal answer or a replay error offers "This saved match is from an older version" with Discard.
`node game/test/browser/audit.mjs scenarios [dir]` sets up positions through `window.__mtgMatch` and hit-tests + screenshots every new prompt.


## Library automation (deck library, data/library.json)
Goal: every card in the 50 deck-library decks fully **and correctly** automated, so neither the AI nor Nate ever meets a ⚠ card.
Cards still to do are split into batches in `lib-ov/batches.json` (`m1`–`m4` = mechanics batches, `b01`–`b18` = card batches).

**Tools**
- `node game/test/lib-flagged.mjs <batch>` — the batch's cards that still have unparsed text (oracle text + ⚠ lines). Done = `flagged 0`.
- `node game/test/lib-sim.mjs <batch> --games 2` — AI-vs-AI games with every library deck that contains a batch card; must show 0 crashes, 0 stalls.
  The "manual events" list at the end shows text that fired but wasn't automated (should not include your cards when you're done).
- `node --test game/test/*.test.js` must pass. `node game/test/sim.js --games 1 --quiet` (Nate's own decks) must not crash.
- `test/helpers.js` `cardByName()` now also finds every library card, so scenario tests (`test/scenario.js`: `setup`, `place`, `act`,
  `choose`, `resolveAll`, …; see `test/automation.test.js` for examples) can use them.

**Rules for every batch**
- Correct beats complete. Never clear an unparsed line you haven't implemented exactly (SPEC §5 "never guess", §8). If the engine can't do it,
  leave the line in `unparsed` and write the gap to `lib-ov/<batch>.requests.md` (card, text, what the engine would need).
- Overrides for a batch live only in `lib-ov/<batch>.js` (format + conventions: header of `overrides-1.js`; `import { H } from "../overrides-1.js"`).
  Overrides are keyed by exact card name; library overrides never replace the hand-written ones in overrides-1/2.js.
- Scripts are deterministic (`g.rng()` only), every `$` generator is called with `yield*`, choices go through `g.choose$` / `g.chooseObjects$` /
  `g.confirm$` / `g.number$` so they're recorded and replay, and the AI (ai.js `decide`) can answer them.
- Add scenario tests in `test/lib-<batch>.test.js`: at least one per distinct pattern you automated (more for anything tricky). Keep them fast.
- Commit your work (in your worktree) with a clear message. Don't push.

**Card batches (b01–b18)** edit only `lib-ov/<batch>.js`, `lib-ov/<batch>.requests.md` and `test/lib-<batch>.test.js`.
**Mechanics batches (m1–m4)** add the mechanic to the engine/parser (and AI decisions, and UI labels if a new prompt or zone needs one), then
automate the batch's cards. Keep changes additive and local (new helpers/branches, no refactors) because several batches are merged together;
note what you added under a short "Library automation: <batch>" subsection below.

### Library automation: m4 (planeswalkers, Sagas, Battles, Classes, Level up, Cases, monarch, rad counters)
Engine code is in `engine-m4.js` (a mixin like the others) plus small hooks elsewhere; card scripts are in `lib-ov/m4.js`, deviations in `lib-ov/m4.requests.md`.

**IR additions**
- *Saga*: `def.finalChapter`; chapter abilities are `{kind:"triggered", on:{event:"chapter", who:"self", chapters:[n..]}}` (parser: `CHAPTER_RE`, `parseChapterLine`).
  The lore counter is added at entry (`applyEntersReplacements`) and at your precombat main (`m4StepStart`); `sagaChapters` fires one `chapter` event per number
  passed. SBA `sagaDone` sacrifices it once lore >= final chapter with no chapter ability pending/on the stack. *Read ahead* = `asEntersChoose choice:"chapter"`
  (`reason:"chapter"` request, hint `{kind:"readAhead"}`, `entry.chosen.chapter`).
- *Class*: a `level` counter (enters with 1, static `entersWithCounters`). `ab.classLevel` = level-up activated ability (sorcery speed, condition `counters level == n-1`).
  Gate level abilities with `condition:{type:"counters", what:"self", kind:"level", op:">=", n}` (`LV(n)` in m4.js). "When this Class becomes level N" = `counterAdded` on kind `level`.
- *Level up creatures*: `kw.levelUp` synthesises the activated ability (`engine-chars.js`); `LEVEL a-b` tiers parse to `setPT`/`pump` statics gated on level counters.
- *Case*: `o.solved` flag + cond `{type:"solved"}`; the "to solve" check is an end-step trigger that sets it.
- *Planeswalker*: `loyalty` ability = `{kind:"activated", loyalty:true, cost:{loyalty:±n|"-x"}, limit:"turn"}`; printed loyalty `X` is `"x"` (enters with X counters). Helpers `loyalty()`,
  `walker()` in m4.js replace abilities by their cost key ("+1", "-2", "-x"); `AI_VALUE` tags the AI's value for scripted effects (`aiValue` on the effect, read by `ai.js` evalEffect default).
- *Battle*: `def.defense` (default 5 for Sieges when the data lacks it), `defense` counters, `o.protector`, `asEntersChoose choice:"protector"`; battles are legal attack targets for everyone
  but the protector, `defenderPlayer(battle)` = protector, SBA -> `defeatBattle` (Siege: exile, may cast the back face free via `castFree$(p,o,{face:1})`).
- *Emblems*: `st.emblems`, `createEmblem(p,{name,text,abilities})`; static abilities join the continuous-effect pass, triggered ones fire from `fireTrigger` (abilities carry `zone:"emblem"`).
- *Monarch*: `st.monarch`, `becomeMonarch`, event `becameMonarch`, cond `{type:"monarch", who:"you|opponent|none|any"}`, trigger `beginStep whose:"monarch"`, end-step draw and
  combat-damage steal are engine-internal (`m4StepStart`, `monarchHit`). *Rad counters*: player counter `rad`; precombat-main mill/lose-life step is engine-internal; ops `getRadCounters`,
  static `radGain`; mill events `milled` (per card) and `milledCards` (batch, `nonland`) with `o.milledTurn` / filter `milledThisTurn`.
- New statics: `tokenMult`, `tokenReplace`, `castFreeHand`, `playFromTop`, `lookTop`, `attackDir`, `mustAttackObj`, `attackTax`, `cantAttackYou`, `monarchControls`, `cantBeBlockedBy` (`byMonarch`, `greaterPower`),
  `cantBeBlockedWhileDefenderHas`, `drawLimit`, `damageToCounters`, `typesOffBattlefield`, `activateCostMod`/`cost.costReduce`, `asType` `setSubtypes`/`addColors`, `damageMod` (`combat`, `exceptSelf`, `youOrPlaneswalker`, `allButOne`),
  `entersTapped.optionalTapped`. New filter keys `colored`, `milledThisTurn`; new cond `castSpellThisTurn`, `solved`, `monarch`.
- New object fields: `skipUntap` ("doesn't untap during its controller's next untap step"), `formDef` (a permanent that is a different card form while on the battlefield), `mayCastGy` (cast a graveyard card this turn),
  `copyRevert` (temporary copy), `oncePerTurn` on triggered abilities, event field `first` on `gainLife`, `nth` on `draw`.

**Engine helpers** (`engine-m4.js`): `addTempTrigger(on, run, ctx, until, opts)`, `castPaid$(p,o,{spendAs})`, `attackTax$`, `effCost`/`noteActivation`, `milledEvents`/`fireMilled`, `createEmblem`, `becomeMonarch`, `defeatBattle`,
`tokenMult`, `tokenReplaceDef`, `playFromTopObj`, `attackDirDefenders`, `poolCount`. Stun counters replace the untap; shield counters replace damage/destruction.

**AI**: scripted effects are valued through `aiValue` (default 8 for any `run` effect); `becomeMonarch`, `getRadCounters` and `level` counters have values in `ai.js`; Read-ahead, protector, mode and pile choices
use the generic first-option/ordering paths. **UI**: counter badges now name lore/defense/level/stun/shield; player strips show the monarch, rad/energy/experience counters and emblems.
