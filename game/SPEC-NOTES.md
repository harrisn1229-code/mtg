
## Parser IR extensions (parser.js / parser-effects.js / parser-filters.js)

Everything below is emitted by the oracle-text compiler beyond the vocabulary in SPEC §5. Conventions chosen: Cond objects use
`{type:"control"|…}` (like Static); keyword keys are the lowercase oracle names, with spaces (`"first strike"`, `"double strike"`);
colours are letters `"W","U","B","R","G"`; `types/subtypes` in a Filter are any-of; TokenDef `keywords` is a map `{deathtouch:true}`.
Lines the parser cannot map go to `def.unparsed` (raw text). When only a *later sentence* of an otherwise parsed ability is unclear
the ability is kept with an `{op:"manual",text}` effect AND the raw line is also listed in `def.unparsed` (so the UI badges it).

**CardDef**: `enchant: Filter` (Aura "Enchant land"). `faces[]` for adventure/transform/mdfc; the top-level def mirrors the front face
(name = full "A // B" name). Keywords with values: `escape:"{3}{B}{B}"`, `escapeExile:4`, `annihilator:n`, `toxic:n`, `partner:true`.
Unsupported keyword lines (mutate, morph, hideaway, increment, craft, spectacle, crew, …) are `unparsed`.

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
- Mana abilities: autopay uses only `{T}`-cost abilities (optionally with `{N}` generic input, life, or sacrifice-self on non-creatures like Treasure). Sacrifice-a-creature mana (Scion, Ashnod's Altar) and coloured-input filters are manual-only actions.

**Not implemented / simplified**: damage assignment order & trample assignment automatic; "divided as you choose" split evenly; copy effects only via `createToken.copyOf`/`copySpell`; no phasing/day-night/mutate/morph/hideaway (cards cast normally); commander return to command zone is asked as the SBA (903.9a) for graveyard/exile and also (simplified) for hand/library; no "can block additional creatures"; combat damage to a removed planeswalker is lost.
- (engine, later) Parser extensions now consumed: trigger `who:"equipped"|"enchanted"`, `cast{orCopy}` (copies fire `cast` with `copy:true`), `dealsCombatDamage{batch:true}` (one event per damaged player per damage step; `{event:"amount"}` = total from matching sources), `{sum,of}`, `until` with Ref `affects`, `addMana{color,n}`, `keywords.escapeExile`, `ModeSet.maxIf`, Amount-valued token P/T.
  `entersTapped.unlessPay` is approximated: the land enters tapped and a trigger asks "pay X to untap it?" (same outcome for shocklands).
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
