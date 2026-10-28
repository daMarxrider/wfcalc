# Data notes

Hard-won details about the upstream data. Read this before touching
`tools/build-data.ts`; every item here was a bug that cost time.

## Sources and authority

| Source | Use for | Notes |
|---|---|---|
| `wiki.warframe.com/w/Module:Mods/data?action=raw` | Master mod list, descriptions, internal upgrade axes | 1550 mods |
| `wiki.warframe.com/api.php` (category members) | Which mods are Exilus-only | 74 members. `action=raw` cannot list categories; the API is at the site root, **not** under `/w`. It sends no ETag but does send `Last-Modified`. |
| `wiki.warframe.com/w/Module:DamageTypes/data` | Damage 3.0 faction modifier table (`Types`) and pool categories (`Health`) | ±50 per faction health class; the Damage 2.0 matrix is deprecated as of U36 |
| `wiki.warframe.com/w/Module:Warframes/data` | Warframe base stats + abilities | Not used yet (phase 2) |
| `wiki.warframe.com/w/Damage/Calculation`, `Armor`, `Enemy_Level_Scaling`, `Riven_Mods` | Formulas | Kept verbatim in `data/raw/` for reference |
| `WFCD/warframe-items` JSON | Per-rank mod numbers, weapon stats, enemies, arcanes | Public repo, MIT-licensed tooling |

The Fandom wiki (`warframe.fandom.com`) is **frozen since 2025-06** and sits behind
Cloudflare. Do not use it.

## Traps found so far

1. **WFCD has duplicate mod names.** "Serration" appears twice: the real one and the
   flawed/beginner variant (`.../Beginner/WeaponDamageAmountModBeginner`, 4 ranks,
   +40%). Picking by name silently gives wrong numbers. The pipeline therefore uses
   the wiki as the master list and joins WFCD by `InternalName` == `uniqueName`.

2. **WFCD line breaks are literal `\n`**, not newlines: `"On Kill:\n+30% Multishot..."`.
   `cleanStatText` converts them. Without this, every Galvanized mod parses as one
   unparseable line.

3. **Multipliers start with `x`**: `x1.3 Damage to Grineer`. A number regex anchored on
   `^[+-]?\d` misses them entirely.

4. **`attacks[]` is not a decomposition.** It mixes parts of one shot (Kuva Bramma:
   "Charged Shot" impact + "Radial Attack" blast) with genuinely different modes
   (Soma Prime: normal + Incarnon). Summing them is wrong; the arsenal `damage` block
   already includes the parts of the main shot. 124 of 197 primaries have a mismatch
   if you sum `attacks`. The engine therefore treats the top-level stat block as the
   canonical mode and `attacks` as selectable alternatives.

5. **Shotgun `damage.total` is per pellet**, and `multishot` is the pellet count
   (Strun Wraith: 40 damage per pellet × 10). Status chance in the dataset is already
   per pellet.

6. **`attacks[].crit_chance` is a percentage** (35) while `criticalChance` is a
   fraction (0.35).

7. **WFCD enemy `resistances[].affectors[].modifier` values are not used at all.**
   Only `resistances[].type` and `.amount` are trustworthy (they say which pools exist);
   what a damage type does to an enemy comes from the wiki's faction table and the enemy's
   `healthClass`.

8. **Wiki Lua modules are data followed by real code inside a long comment.** The
   parser stops at the first non-`local`/`return` statement and then looks for a
   trailing `return <name>`. `--[= =[` (with a space) is *not* a valid long-bracket
   opener, so code after it is live Lua on the wiki — never execute those modules.

9. **Node runs TypeScript with type stripping only.** No parameter properties, no
   enums, no namespaces, no emit. `erasableSyntaxOnly` in `tsconfig.json` enforces it.
   `import` paths must keep the `.ts` extension.

10. **Mod text needs to be split before parsing**: on newlines, on ` and ` followed by a
    number, and on "+X% Critical Chance and Damage".

11. **Ability pages have two layouts.** Abilities use `{{AbilityU10.x | strength = 10 / 15 / 25 / 50 % }}`;
    augments (Shock Trooper, Freeze Force...) use an `emodtable` whose **column order differs per
    mod** (Freeze Force lists Range before Damage). Column headers must be read; positions cannot
    be trusted.

12. **`Module:Ability/data` builds its per-frame index at runtime** (`table.insert(AbilityData["Warframe"]...)`),
    which a data-only parser cannot execute. Group the flat `Ability` table by its `Powersuit` field instead.

13. **"Stacks up to 240%" is a cap, not a stack count.** Divide by the per-stack value
    (`Melee Exposure`: 240 / 60 = 4 stacks). The parser does this when the cap is a percentage.

14. **Riven base values live in a wikitable with "<br>" and template noise**, and the label
    is what keys the attribute: `{{D|Heat}} Damage` must be expanded *before* stripping
    templates, otherwise "Cold Damage" and "Heat Damage" both collapse to "Damage" and the
    first one wins. Same for `{{Faction|Grineer}}` in "Damage vs. Grineer".

15. **The riven disposition multiplier is `omegaAttenuation`** in the WFCD export (0.5-1.55).
    The 1-5 star rating is only a display bucket; using it directly gives wrong stat values.

16. **Multi-tab ability pages repeat the `| strength =` parameter** (Wisp's Reservoirs has one
    per mote). Read every occurrence and keep the `<br>` separators, or the motes collapse
    into one unparseable stat.

17. **Incarnon trees are prose in a per-weapon table.** The rows alternate perk names (bolded,
    sometimes a bare percentage) with bullet lists; one bullet can hold several stats. Only
    "X Incarnon Genesis" pages exist, so incarnon-native weapons have no data.

18. **`Non-Critical hits deal +240% damage` breaks the "number first" assumption**: the number
    is in the middle of the sentence. Same for "Increase Base Damage by +51". Both need a
    "… by <number>" fallback before giving up on a line.

19. **Incarnon trees are also inherited by variants.** WFCD gives "Incarnon Form" attacks to
    Lex Prime, Strun Wraith and friends, but the wiki only has "Lex Incarnon Genesis".
    Strip the variant affixes (Prime/Wraith/Vandal/Prisma/Mk1/Telos/Rakta/Synoid/Dex) and copy
    the base weapon's tree.

20. **AoE falloff is in the export**: `attacks[].falloff = {start, end, reduction}`. The arsenal
    `damage` block already includes the radial hit at the centre, so applying falloff means
    subtracting that portion and adding it back scaled — not adding the radial on top.

21. **Arcanes scope their buff in the text**: "+90% Fire Rate to Primary Weapons". Without
    stripping that tail, every scoped arcane parses as unknown.

22. **Arcane crit bonuses are flat**, not multiplicative on the base stat. They are flagged
    with `op: 'flat'` in the pipeline (currently Arcane Avenger; extend the set as more
    are verified).

23. **The Kuva/Tenet elemental bonus is not in the export at all** — it is a player choice,
    so it has to be an input. 35 weapons depend on it for their elemental combination.

24. **Covenant's numbers live in two `strength` segments plus a `misc` parameter** (the 50%/200%
    caps). The caps are read from the page text and hardcoded in the registry; if they ever
    change, `wfcalc buffs` will not notice.

25. **Charge weapons ship `fireRate: 0`** (Lanka and friends); the real rate is
    `1 / max(charge_time)` from the attacks array. The validator caught this one — it was
    making Lanka's DPS zero.

26. **"Direct Damage" depends on the attack.** Galvanized Aptitude/Savvy/Shot parse to
    `directDamage`; the engine then adds it to Serration's bucket or multiplies, per the wiki's
    Condition Overload (Mechanic) table (`src/engine/overload.ts`). Overframe always multiplies.

27. **Overframe is reachable around Cloudflare**, which makes it an oracle: `/api/v1/builds/<id>`
    (no challenge) and `static.overframe.gg/_next/static/chunks/db/{mods,items}.<hash>.js`.
    The chunk hashes live in the webpack runtime, which the app HTML links, so nothing is
    hardcoded. `db/mods` holds mods *and* arcanes; `categories: ["mod"|"arcane"]` separates them.

28. **`tools/calibrate.ts` found these real bugs**, all invisible to synthetic tests:
    fire modes with an empty export damage dict resolving to zero, compound conditions
    capping stacks, "Direct Damage" merged into the base bucket, status chance being clamped
    to 100%, and a non-integer magazine.

29. **Mod text sometimes changes the value by weapon class**: "(x2 for Bows)" doubles the
    stat on bows. The parser flags it (`doublesForBows`) and the engine applies the factor;
    stripping the parenthetical before reading it silently gave Nataruk 0.80 instead of 1.14.

30. **"Fire Rate cannot be modified"** (Cannonade mods) is a rule with no stat line. It is
    injected from the wiki description as a `fireRateLock` effect, and the engine then
    ignores every fire rate bonus including penalties.

31. **`data/weapon-overrides.json`** holds per-weapon corrections for fields the export gets
    wrong, each with its evidence: Nataruk's reload, Fulmin Prime's magazine, Felarx's
    per-shell reload, Grimoire's missing magazine, the Ceramic Dagger's two spectral daggers
    (`incarnonForm.multishot`). `modes` patches one fire mode; `incarnonForm` patches the
    transformed profile. Prefer a rule when the ratio is constant across weapons; use an
    override when it is one weapon's quirk.

32. **Open calibration mismatches** (79/120 builds match; these are the rest):
    - **Bows** (`Nataruk`): Overframe's reload is 0.15 s where the export says 0.05 s, and its
      fire rate is ~9% higher. Probably a nock/charge term we do not model.
    - **Per-shell shotguns** (`Felarx`): Overframe reports a full empty reload (6.5 s) where the
      export gives the per-shell time (3.7 s). Affects sustained DPS, not burst.
    - **Battery/tome weapons** (`Fulmin Prime` magazine 8 vs 80, `Grimoire`): the export's
      `magazineSize` is unreliable for these; Grimoire has no magazine field at all.
    - `Ocucor` multishot is 1.0 low and `Phantasma Prime` 1.1 high; both are weapons with
      special mechanics (tendrils, held beam). Needs a look at the export fields.
    - Assorted `fire rate` / `crit chance` deltas in the same ballpark.

33. **The wiki sends `Last-Modified` but no `ETag`.** `If-Modified-Since` returns 304;
    `If-None-Match` always returns 200. Change detection for the fetcher must use dates.

34. **Overframe is a mirror of the same export**, keyed by Lotus path, so it can be joined
    field by field against WFCD. That is the cheapest way to notice the export going stale
    (it already did for Acceltra's status and Fulmin's magazine). Keep it as the verifier,
    not the source: WFCD is git-versioned and diffable, their chunk is a webpack eval.

35. **Set bonuses come in two shapes** and the wiki documents both on the set page:
    "enhances the effects of the mods in this set" (Umbral, Sacrificial → amplify the mods'
    own effect values, and the wording is "both mods" rather than a mod name) and a
    per-pieces table (Vigilante, Gladiator, Hunter → their own effect).

36. **The raw export leaves some fields at their default.** `criticalHitDamageMultiplier` is
    2 for a whole family of weapons regardless of their real value (Acceltra is 2.8 in game
    and in Overframe's engine), and `criticalHitChance` can be 0. So `tools/drift.ts` is a
    signal: magazine size and reload are trustworthy, crit/status need arbitration against
    the wiki or an Overframe oracle.

37. **Overframe's item mirror is keyed by Lotus path and every weapon has 1-3 behaviours**,
    so a stat has several candidate values; compare against the closest rather than the
    first, or multi-mode weapons look like drift.

38. **Full audit sweep (250 public builds, `npm run audit`)**: 222 match, 28 fail, and the
    failures are **exactly four weapons** — Phantasma Prime (multishot), Ocucor (multishot),
    Tenet Arca Plasmor (fire rate), Acceltra (status chance) — seven builds each, one field
    each. No other weapon in the sample ever diverges. Melee: 0/56 failing. Over 201 arcane
    slots appear in the sample and none is implicated.

39. **Acceltra is resolved, and the answer is that we are right.** Its oracle status chance is
    `1 - (1 - 0.06)^1.9 = 0.1109157`, matching Overframe's 0.1109157 to eight decimals: they
    report the probability of at least one proc **per shot** for that weapon. A sweep over 120
    builds with multishot > 1 shows the oracle is per-projectile in 112 of them, so this is an
    Overframe-side inconsistency for that weapon, not a definition we should adopt.

40. **Phantasma Prime: the two data sources disagree on the base.** WFCD says multishot 6, and
    Overframe's own raw mirror says the beam behaviour has `fireIterations: 5`. Their oracle
    (11.5) matches neither 6 x 2.1 nor 5 x 2.1, so something else is in play too. Ocucor's
    oracle is exactly +1.0 over ours while its raw mirror agrees with WFCD. Both need the
    in-game arsenal to arbitrate.

41. Those four are not formula errors: in each, the oracle differs from *both* our data and
    Overframe's own raw mirror by a suspiciously round amount (Ocucor is exactly +1.0
    multishot), which smells like a per-weapon special mechanic rather than a mapping bug.
    They are left unreconciled on purpose: forcing an override would hide the cause.

40. **Overframe build pages do not contain rivens** (0 riven slots in 250 builds), so riven
    support cannot be validated this way and rests on the unit tests against the wiki table.

42. **In-game verification (docs/verified-in-game.md)** settled the last ambiguities: Ocucor and
    Phantasma Prime match the arsenal exactly on multishot, crit and status, so the oracle — not
    our data — was wrong. Their fields are listed in `data/oracle-exceptions.json` with the
    evidence and skipped by calibrate/audit. It also surfaced a real bug: fire modes inherited
    the weapon's multishot, so Phantasma's alt-fire had 6 projectiles instead of 1.

43. **The game truncates damage per damage type before summing.** Unmodded Soma Prime vs a
    level 27 Drekar Elite Lancer: our per-type 1.00 / 3.09 / 4.60 truncate to 1+3+4 = 8,
    matching the game exactly, where rounding the total would have shown 9.

## Coverage

`npm run coverage` prints the current state (83% of weapon-relevant mods fully
parsed). The remainder is mostly pure utility and is listed in
`docs/unmatched-mods.txt`, which is regenerated by `npm run update`. When adding
rules, always re-run coverage and check that the number went up and nothing that
previously parsed broke (`npm test` covers the important cases).

## To verify in game when possible

- Armour-type modifiers acting on the armour value (see docs/formulas.md §4).
- Whether level-scaled armour should be clamped to 200..2700 *before* applying
  damage-type modifiers (currently: after scaling, before modifiers).
- Eximus units: they are separate rows in the dataset, with inflated pools.

## Refresh order

`npm run update` runs, in order: the fetchers (`fetch.ts` for WFCD + wiki pages,
`fetch-abilities.ts`, `fetch-damage-abilities.ts`, `fetch-incarnon.ts`, `fetch-sets.ts`), then
`npm run rebuild`: `build-data.ts` (snapshot from `data/raw/`) followed by `npm run patch`, the
tools that write what build-data does not build: `public-export.ts` (DE's weapon stats),
`fetch-compression.ts`, `fetch-snipers.ts` and `fetch-forced-procs.ts` (guaranteed procs).
`tools/sync.ts` runs the same patch list after its rebuild. Running `build-data.ts` on its own
leaves those sections out, so always follow it with `npm run patch`.

`build-data.ts` reads `data/raw/ability-stats.json` and `data/raw/set-bonuses.json`, so running it
alone after a fresh checkout fails (or loses the set bonuses) until those fetchers ran once. The
riven tables come from the wiki's per-class tabs through `tools/lib/riven-stats.ts`, the same
parser `npm run riven-stats` uses; Helminth flags come from Module:Warframes/data (`Subsumed`).

After a game update, `node tools/survey-weapon-traits.ts --force --new` re-reads every weapon page
and lists only the weapons whose trait text is new or changed since the last review
(`data/weapon-trait-review.json`); read them, update `src/engine/traits.ts` / `ammo.ts`, then
record the review with `--reviewed`.
