---
name: wfcalc
description: Answer Warframe build questions with the offline wfcalc CLI — find the best build for a weapon, judge a build the player already has, or compare options against a specific enemy and level. Use for builds, mods, damage, DPS, time to kill, rivens, Incarnon or abilities.
---

# wfcalc

Offline Warframe damage calculator. It answers two different questions, and confusing them is
the main way to get a bad answer:

- **"How good is this build?"** → `calc` / `compare`. Evaluates, deterministic.
- **"What should I put on X?"** → `search`. Chooses using the same engine.

Everything runs locally against a snapshot of WFCD + the WARFRAME Wiki. No network, no account,
no rate limit. Invoke it as `wfcalc` if it is on `PATH`, otherwise `./bin/wfcalc` from a clone.

## Token rules (important)

The CLI is the interface: it is one process per question and its text is already compact.
Do **not** add an MCP layer or parse JSON just to re-print it.

1. **Use `--brief`** for calculation, search and ability. One line (plus mods for search).
   That is the token-cheap form and the one to reason from.
2. **Use the default text** when the player needs the breakdown (elements, status ticks,
   per-type damage). It is ~20 lines, not a JSON tree.
3. **`--json` only when you must parse a field** (e.g. a value is missing from `--brief`).
   It is the most expensive output; never fetch it and paste it into the answer.
4. **Ask one question per invocation.** Do not enumerate 622 weapons to find a name; use
   `wfcalc weapons <query>`.
5. `search` defaults to 3 builds: use `--top 1` unless the player asked for alternatives.
6. **Repeated calculations:** use `--brief=answer` (no burst/sustained/armour, no search
   assumptions) once you already know the context, or `wfcalc batch file.jsonl` to price many
   builds in one process. A bad batch record is reported on its line; the rest still run.

## Procedure

1. **Get the exact name.** Players say "Soma"; the snapshot has `Soma` and `Soma Prime`.
   If unsure: `wfcalc weapons soma`. For enemies: `wfcalc enemies bombard`.
2. **Fill only the context that changes the answer**: enemy and level (armour changes
   everything), Catalyst (`--capacity 60` vs `30`), Forma budget, mods they own or lack.
   If they said nothing: Bombard level 150, capacity 60, unlimited Forma — and say so.
3. **Evaluate or choose**: `calc` for their build, `search` for a recommendation.
4. **Report** the mods, capacity/Forma, DPS, TTK, and the assumptions. Short.
5. **Never invent a build or a number.** If you are about to estimate, run the tool.

## Commands

```sh
# recommendation
wfcalc search "Soma Prime" --enemy Bombard --level 150 --top 1 --brief
wfcalc search "Kuva Bramma" --objective dps --forma 0 --exclude "Primed Firestorm" --brief
wfcalc search "Torid" --incarnon auto --enemy Bombard --level 150 --brief
wfcalc search "Haalvu" --arcane auto --stacks onKill=12 --enemy Bombard --level 150 --brief

# judge an existing build
wfcalc calc "Soma Prime" --mod Serration --mod "Split Chamber" --enemy Bombard --level 150 --brief
wfcalc compare "Soma Prime" --vs "Serration,Stormbringer" --vs "Serration,Infected Clip" --brief

# armour strip (usually worth more than any single mod)
wfcalc calc "Soma Prime" --mod Serration --strip-from Avalanche --strength 200 --enemy Bombard --level 150 --brief
wfcalc calc "Soma Prime" --mod Serration --cp 2 --armor-strip 30 --enemy Bombard --level 150 --brief

# abilities: damage and strip
wfcalc abilities                                        # names, damage, strip
wfcalc ability Miasma --strength 200 --enemy Bombard --level 150 --brief
wfcalc ability Miasma --strength 200 --enemy Bombard --level 150 --targets 5 --brief
wfcalc calc "Soma Prime" --mod Serration --eximus --enemy Bombard --level 150 --brief
wfcalc calc "Rubico Prime" --mod Serration --enemy "Eidolon Teralyst" --level 30 --brief
wfcalc ability Avalanche --strength 200 --brief          # 100% armour strip

# pieces
wfcalc weapons soma          wfcalc mods "Soma Prime" multishot
wfcalc arcanes               wfcalc buffs               wfcalc rivens damage
wfcalc incarnon Torid        wfcalc enemies bombard

# many calculations, one process (JSONL: calc records, with "label" and optionally "ability")
wfcalc batch builds.jsonl --brief=answer
```

Useful flags: `--objective ttk|dps`, `--capacity 30|60`, `--forma N`, `--must "A,B"`,
`--exclude "A,B"`, `--arcane auto`, `--viral N`, `--corrosive N`, `--headshot`,
`--eximus` / `--overguard N`, `--attenuation archon|eidolon`, `--targets N` (abilities and the
Torid chain), `--status-types auto`, `--stacks onKill=5`,
`--frame Rhino --frame-mods Intensify --buff roar`, `--riven damage,multishot,-zoom`. `--mod "A,B"` and repeated `--mod` are equivalent.
Every command accepts `--json` (compact JSON) and `--brief` where it makes sense.

`calc` now reports the **capacity/Forma** of the exact mod list and the **arcane** it assumed;
`search --arcane auto` tries the arcanes whose slot fits and reports the winner. The arcane is
part of the build: do not omit it from the answer.

## Reading the numbers

- **burst** DPS: while the magazine lasts. **sustained**: reloads included, direct damage only.
  **total**: the rate that removes the target's pools (Overguard, shields, health), after armour
  and **including status procs**. It agrees with TTK: `pools / totalDps == timeToKill`; on a
  target with no Overguard or shields that is `health / totalDps`.
- **ttk** is the model's sustained fire, not a stopwatch. Quote shots too when they ask.
- **armour** is the effective armour *after* every strip. Show it when strip is involved.
- A weapon can have huge burst and modest total: the target's armour and faction health class decide.
- Status is most of the damage on slash/heat builds; do not read `sustained` as "real DPS".

## What must travel with the answer

- **Target** (enemy + level) and objective.
- **Capacity and Forma** (`59/60 cap · 3F` in `calc` and `search`), the **arcane**, and the
  **conditional mods** (`conditional Galvanized Chamber, ...` means those need `--stacks`).
- **Assumptions**: max ranks, Catalyst, combo (melee assumes 12x / 220 hits), active conditions,
  Ability Strength. `--brief` prints them after the builds.
- **`partial` mods / warnings**: those numbers are a **lower bound**. Say so.
- **Incarnon**: it is never assumed. If the weapon has a form, say so and offer
  `--incarnon auto`. Perks work untransformed too; `form` in `--incarnon` switches to the
  transformed profile. Perks, their conditions and form scope, and the form's AoE/explosion at
  the blast centre are modelled (`--aoe-distance` applies the explosion's falloff).
- **Inactive conditions**: Galvanized/on-kill/"while aiming" effects are off unless
  `--stacks`/`--aiming` is passed. A build that relies on them is scored lower than it plays.

## Do not

- Do not use `--json` as the default. Do not paste raw JSON into a player-facing answer.
- Do not put an Exilus mod in a standard slot or a Cannonade mod on an automatic weapon.
- Do not add percentage strips yourself: pass `--strip-from` and `--cp` together, they are
  additive (Terrify 60% + one Corrosive Projection leaves 22% of the armour).
- Do not quote a single hit for a ticking ability: use its total per cast (Miasma 900 direct,
  1,800 after its own Viral proc; Inferno ~26k at 200%). `statusPerCast` is called out
  separately when the ability applies Heat, Viral or Bleed. Shields are left out of
  `castsToKill` now includes shields (Toxin bypasses them), so the Corpus figure is no longer
  optimistic.
- Do not claim endgame certainty. Not modelled: the exponential smoothing of boss damage
  attenuation and Lich/Sister cap values (pass `--mdpt/--mdps`), Eidolon joints and boss
  invulnerability phases, status DoT/Magnetic amplification on **Overguard**, multi-target/AoE,
  stance modifiers, companions/Archwing/Necramech. `--targets N` covers Torid's chain and an AoE
  weapon's radial share; `--ability-distance N` covers Discharge's falloff. Ability statuses are modelled only for
  Inferno and Fireball (Heat), Thermal Sunder's Heat mode, Miasma (Viral), Shuriken (Bleed) and
  Spores' Corrosive ramp (price the weapon with `--corrosive 10`). Melee and secondary
  builds have no external calibration yet. Eximus Overguard and the Archon/Eidolon caps *are*
  modelled.
- Do not present a search result as a measurement; it is the best build under the model.
- Do not forget the arcane: `calc`/`search` echo it now, and it can be a 3x multiplier.

## Errors

Expected failures exit **2**, unexpected ones **1**, and there is no stack trace by default.
With `--json` the error is `{"error":{"code":"weapon_not_found","message":"...","suggestions":[]}}`
on stderr. Fix the name; do not retry blindly. `--debug` adds the stack when you need it.

Typical codes: `weapon_not_found`, `enemy_not_found`, `ability_not_found`, `invalid_argument`.
An empty search result means no mod combination fits the capacity/Forma budget: relax `--forma`
or raise `--capacity`.

## Examples

```sh
$ wfcalc search "Soma Prime" --enemy Bombard --level 150 --top 1 --brief
Soma Prime vs Bombard 150 · 1 of 787 builds
1. 11.94s · 9,922.6 dps · 2F · 60/60 cap
   Primed Cryo Rounds R10, Heavy Caliber R10, Split Chamber R5, ...
assumptions: All mods at max rank, 60 capacity (Orokin Catalyst) · ...
notes: The Exilus and stance slots are not searched; ...

$ wfcalc calc "Soma Prime" --mod Serration --strip-from Avalanche --strength 200 \
    --enemy Bombard --level 150 --brief
Soma Prime vs Bombard 150 · burst ... · total ... dps with status · ttk 40.9s (...) · armour 0
```

Answer with the mod list, the TTK/DPS, capacity/Forma, and one sentence on assumptions. If the
player runs a frame with a strip (Avalanche, Terrify, Seeking Shuriken, Polarize), price the
weapon again with `--strip-from`: it usually matters far more than the next mod.
