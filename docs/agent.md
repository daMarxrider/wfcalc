# Driving wfcalc from an agent

`wfcalc` is an offline Warframe damage calculator. It answers two different questions, and
confusing them is the main way to get a bad answer:

- **"How good is this build?"** → `calc` (and `compare`). Exact, deterministic.
- **"What build should I use?"** → `search`. It optimises with the same engine.

Everything runs locally against a snapshot of WFCD and the WARFRAME Wiki. No network, no
account, no rate limit. Invoke it as `wfcalc` if it is on `PATH`, otherwise `./bin/wfcalc`.

The operating manual for an agent is [`skills/wfcalc/SKILL.md`](../skills/wfcalc/SKILL.md).
This file is the deeper contract: flags, fields and the reasoning behind the numbers.

## Token discipline

The CLI exists so an agent does not need an MCP server or a JSON schema round-trip for every
question. The cheapest answer that is still correct wins:

1. **`--brief`** for `calc`, `search` and `ability`: one line, plus the mod list for search.
2. **Default text** when the player needs the breakdown (elements, status ticks, per-type).
3. **`--brief=answer`** when the context is already known (repeated calculations): it drops
   burst/sustained/armour and the search assumptions and keeps DPS, TTK and the mods.
4. **`--json` only when you must parse a field** that `--brief` does not expose.
   Never fetch JSON and paste it into the answer.
5. **One process for many builds.** `wfcalc batch builds.jsonl` prices a JSONL of calculations
   in one start, with a line per record; a bad record does not stop the others.
6. **One question per invocation.** `wfcalc weapons soma` is cheaper than filtering the whole
   catalogue in your head. Use `--top 1` unless alternatives were requested.

## The three rules

1. **Quote the assumptions that came with the numbers.** Search prints `assumptions` and
   `notes` (also in `--brief`). A build without capacity, Forma and target level is not an answer.
2. **`partial: true` means lower bound, not value.** At least one line of that mod is not
   modelled. Say so instead of presenting the number as exact.
3. **Never estimate when you can run the tool.** The engine is deterministic and fast.

## Commands

| Command | Answers |
|---|---|
| `search <weapon>` | Which mods make the best build for a target |
| `calc <weapon> --mod ...` | Damage of a build you already have |
| `compare <weapon> --vs A,B` | Same weapon under several mod sets |
| `batch <file\|->` | A JSONL of calculations, one line each (also stdin) |
| `mods <weapon> [query]` | Which mods fit, with effects and conditions |
| `ability <name>` | Damage and armour strip of one ability |
| `weapons [query]`, `enemies [query]`, `arcanes`, `buffs`, `abilities`, `rivens`, `incarnon <weapon>` | The pieces to build with |

`search` is the only command that *chooses*. The rest evaluate or enumerate.

## Recipe: the best build for a weapon

```sh
wfcalc search "Soma Prime" --enemy Bombard --level 150 --top 1 --brief
```

Flags:

| Flag | Meaning |
|---|---|
| `--objective ttk\|dps` | Kill the target fastest (default) or maximise `totalDps` |
| `--enemy NAME --level N` | The target; armour changes the answer completely |
| `--capacity 30\|60` | 60 = with an Orokin Catalyst (default) |
| `--forma N` | Maximum Forma the search may spend |
| `--must "Serration,Split Chamber"` | Mods that must stay in the build |
| `--exclude "Primed X,Galvanized Y"` | Mods the player does not own |
| `--top N` | How many alternatives to return (default 3) |
| `--arcane auto` | Try the arcanes whose slot fits and keep the best build |
| `--incarnon auto` | Also choose the Incarnon evolutions |
| `--frame Rhino --frame-mods Intensify --buff roar` | Warframe buffs applied to the weapon |
| `--viral 10 --corrosive 0 --headshot` | Target debuffs and headshots |
| `--eximus` | Target is an Eximus: add its level-scaled Overguard (base 12) |
| `--overguard N` | Explicit Overguard amount instead of the Eximus formula |
| `--targets N` | Group report: ability targets, Torid chain links, or AoE weapon targets (radial share) |
| `--ability-distance N` | Distance from the cast point (Discharge's falloff) |
| `--attenuation archon\|eidolon` | Boss damage caps; Eidolons apply theirs automatically |
| `--mdpt N --mdps N` | Explicit caps per hit and per second (Archons use 460k/935k) |
| `--flat-dr 20 --status-dr 50` | Extra flat and status-only damage reduction, in percent |
| `--armor-strip 60` | Percent of the target's armour already removed |
| `--strip-from "Avalanche" --strength 200` | Take the strip from an ability you will cast |
| `--cp 2` | Corrosive Projection auras in the squad, 18% each |
| `--shattering-impact 30` | Melee hits that chipped the target's base armour, 6 each |

Percentage strips from abilities, `--armor-strip` and Corrosive Projection are **additive**:
Terrify at 60% plus one aura at 18% leaves 22% of the armour, not 33%. Shattering Impact works
on base armour, so its effect scales with the enemy's level. The effective armour after all of
it is returned as `armor`, so show it.

`conditionalMods` names the mods whose value depends on a condition; say which condition has to
be true (`--stacks onKill=12`, `--aiming`, ...) instead of presenting their upside as free. When
two mods score the same, the search prefers the one without an unmodelled accuracy penalty
(Serration over Heavy Caliber) and never trades real DPS for it.

A returned build is **legal by construction**: at most eight mods, within capacity, within the
Forma budget, no two mods of the same family, no Exilus mod in a standard slot, no trigger-locked
Cannonade mod on the wrong trigger.

`--objective dps` scores `totalDps`: the rate that removes the target's pools after armour and
including status procs (Overguard and shields included). Scoring direct damage alone makes
Weeping Wounds, slash and heat builds invisible (on a Nikana Prime, 33.6k real damage per second
scored the same as 17.9k). `totalDps` and `timeToKill` agree by construction:
`(overguard + shield + health) / totalDps == timeToKill`; on a target with neither Overguard nor
shields that is the familiar `health / totalDps == timeToKill`.

## Recipe: judge a build the player already has

```sh
wfcalc calc "Soma Prime" --mod Serration --mod "Split Chamber" ... --enemy Bombard --level 150 --brief
```

Read the brief line: burst, sustained, `total ... with status`, TTK, effective armour, capacity/
Forma and the equipped arcane. The full report adds an `arcane` and a `capacity` line, and the
JSON carries `arcanes`, `capacityUsed`, `capacity`, `formaNeeded` and `fits`.
Drop `--brief` when the player asks "why" — the text report shows the element split, status
ticks and per-type damage. With `--json`, read `sustainedDps`, `totalDps`, `timeToKill`,
`unsupportedMods` and `inactiveConditions`.

## Recipe: an ability and its strip

```sh
wfcalc ability "Rhino Stomp" --strength 200 --enemy Bombard --level 150 --brief
wfcalc ability Avalanche --strength 200 --brief
```

Ability damage is **flat**: no crit, no multishot, no status, ignores the weapon and its mods.
Against a level 150 Bombard most of it is lost to armour (Rhino Stomp: 160 of 1,600). Ticking
abilities are summed over their duration: Miasma's `totalDamage` is 900 at 100% strength;
Inferno's 26,000 at 200% is a direct hit plus fifteen seconds of ring fire.

**Armour strip is the point of most damage abilities.** `Avalanche` at 200% removes 100% of
armour (60% at 100%). Feed that to a weapon with `--strip-from`: a Soma Prime against a level
150 Bombard goes from 271s to kill to 41s. Prefer `--strip-from` over `--armor-strip` whenever
the player told you which frame they run.

`wfcalc abilities` lists the 23 damage/strip abilities with parsed numbers. That is a curated list,
not every ability in the game: the wiki has no machine-readable index of damage abilities.

## Recipe: many calculations in one process

```sh
cat builds.jsonl | wfcalc batch --brief=answer
```

Each line is a calculation record with the same fields as `POST /api/calc` (`weapon`, `mods`,
`arcanes`, `incarnon`, strip fields, `enemy`, `level`, `conditions`...), plus `label` and
optionally `ability`/`strength` for a cast instead of a weapon. Stackable conditions go in
`"conditions": {"onKill": 12}`, not as a top-level `stacks` field. Default output is the brief line per
record; `--json` gives compact JSONL with rounded values (`burstDps`, `sustainedDps`,
`damagePerShotHealth`, `totalDps`, `timeToKill`, `shotsToKill`, `armor`, `warnings`) or the
ability fields. The exit
code is 1 if any record failed, but every record is still processed and reported.

## Recipe: with a warframe

```sh
wfcalc search "Soma Prime" --frame Rhino --frame-mods Intensify --buff roar --enemy Bombard --level 150 --brief
```

Ability Strength comes from the frame mods and arcanes and is reported back in `assumptions`.
`wfcalc buffs` lists every buff modelled, with its ability and whether it is subsumable.

## What the calculator does not do

State these when they matter instead of guessing:

- **The stance slot is not searched; the quick search leaves the Exilus slot empty.** Brute force fills the Exilus slot with the Exilus mod that does most for the greedy builds (Vigilante Supplies counts through its set bonus); pin one with `--fixed` to choose.
- **Melee assumes a 12x combo** (220 hits), because Blood Rush and Weeping Wounds are worth
  nothing at 1x. Pass `--combo-hits 0` to score raw swings; the assumption is reported.
- **The Incarnon form is never assumed.** Evolutions (`--incarnon "EVO2:Name,EVO4:1"`) work on
  the untransformed weapon too, as in game; `form` in the same list switches to the transformed
  profile (alone it is the form with no perks, the way in for the five melee forms, whose attacks
  are the wiki's "Spectral Axe/Dagger/Blade"). `--incarnon auto` tries every combination of
  perks, with and without the form (exact: the largest tree has 18). Perks carry the wiki's
  per-variant values, conditions ("On Kill:", "With Critical Chance Below 50%:") and form scope
  ("for Incarnon Form", "does not apply to the Incarnon form"); "Increase Base X" raises the base
  stat before mods. Perks with no parsed stats are invisible; read the tree with
  `wfcalc incarnon <weapon>`. The form's AoE/explosion is a
  second hit on the same shot and **is** included at the blast centre; `--aoe-distance` applies
  its falloff. Direct-only multipliers (Condition Overload, Galvanized Aptitude) are scaled by
  the direct share so they do not inflate the radial hit. Spectral direct
  hits drop melee damage bonuses (Pressure Point, Arcane Fury, riven damage), the stance and the
  combo multiplier, while Condition Overload and every elemental/faction/crit/status bonus count.
- **Rivens must be spelled out**: `--riven damage,multishot,-zoom --riven-roll 1.05`.
- **Conditional mods default to inactive.** Galvanized stacks, on-kill effects and "while
  aiming" need `--stacks onKill=5` or similar; otherwise the build is scored lower than it
  plays. Say which conditions your answer assumes.
- **Status types** are counted per build by default (its own proc types, e.g. Tau + Viral = 2), plus `--extra-status-types N` from other sources; `--status-types N` fixes the total.
  and iterates the search until it is self-consistent. It is still an assumption: the target may
  carry more statuses from the squad.
- **One target by default, average damage.** No spread, no enemy AI; time to kill is a model of
  sustained fire including reloads. `--targets N` reports a group: abilities hit N enemies at full
  damage inside the radius; Torid's Incarnon chains to up to five at 75% per link; an AoE weapon
  gives the primary target the whole profile and the extras only the radial share at the same
  distance. All assume the same target profile. Discharge's distance falloff is modelled with
  `--ability-distance N` (linear to 50% at 20 m); other abilities have no documented falloff.
- **Ability statuses are modelled only where the wiki states them**: Inferno's and Fireball's
  guaranteed Heat, Thermal Sunder's Heat mode, Miasma's Viral (one stack, doubling health
  damage), Shuriken's Bleed and Spores' Corrosive ramp (~1.5/s, 10 stacks, 80% strip; the note
  says to price the weapon with `--corrosive 10`). Inferno's direct damage is split 1,250 Impact
  + 1,250 Heat; Fireball's 800 direct and 300 area are both Heat. Pass `--ability-mode heat` to
  cast Thermal Sunder's Hold version (1,500 Heat + proc). `target.statusPerCast`, `target.statusProcs` and `target.viralStacks`
  carry the detail. Shields are a separate phase in `castsToKill` (Toxin bypasses them), so the
  Corpus figure is no longer optimistic.
- **Overguard** is modelled for Eximus (`--eximus`) and custom amounts (`--overguard N`):
  a separate layer before shields/health, neutral except Void (+50%), no armour. Only direct
  damage is credited while it is up; status DoT and Magnetic's status amplification are not
  modelled. Ability `castsToKill` includes the casts needed to break it.
- **Damage attenuation**: `--attenuation archon` (MDPT 460k, MDPS 935k, 20% flat DR, 50% status
  DR) or `--mdpt/--mdps`; Eidolons apply 200%/100% of max health automatically. Per hit it uses
  the wiki's hyperbolic formula (`damage × MDPI / (damage × multishot + MDPI)`); the per-second
  exponential smoothing is not modelled, so sustained TTK is conservative.
  There are no published Lich/Sister caps in the data: pass your own. Eidolon joints and
  invulnerability phases, and Lich ranks, are not modelled.
- **Armour strip covers five abilities** (Avalanche, Terrify, Seeking Shuriken and Psychic Bolts
  as a percentage; Polarize as a flat drain), Corrosive Projection and Shattering Impact.
  Anything else that strips must be passed with `--armor-strip`. Psychic Bolts is 80% at 100%
  Ability Strength and caps at 125%; Nyx players often say "my 2 strips everything".
- **A meta is not a calculation.** If a mod is not in the snapshot, the tool cannot know it.

## Failure modes and exit codes

- Expected failures exit **2**; unexpected ones **1**. No stack trace unless `--debug`.
- With `--json`, errors are `{"error":{"code":"weapon_not_found","message":"...","suggestions":[]}}`
  on **stderr**. Text mode prints `error: ... (did you mean: ...?)`.
- Codes: `weapon_not_found`, `enemy_not_found`, `ability_not_found`, `duplicate_mod`, `invalid_argument`, `error`.
- A build carries **one copy of each mod**: `--mod Serration --mod Serration` is a `duplicate_mod`
  error, not a doubled bonus.
- `weapon not found: X` → fix the name with `wfcalc weapons <query>`; do not retry blindly.
- An empty `builds` array means no combination fits the capacity/Forma budget; relax `--forma`
  or raise `--capacity`.
- `warnings` such as `mod does not fit a ...` mean the payload contradicted the data.
