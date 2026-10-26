# wfcalc

Offline damage calculator for WARFRAME. Builds a weapon with mods, a riven later,
and asks what it actually does to a real enemy at a real level.

Not a DPS leaderboard: it uses the game's own formulas (documented on the official
wiki) and the game's own data export, so the numbers answer the question
"is this build better than that one, and why".

Runs on Node ≥ 23 with **no runtime dependencies** — the TypeScript sources are
executed directly through Node's type stripping.

## warframe-dmg-optimizer

This repository is a fork of [asphyksia/wfcalc](https://github.com/asphyksia/wfcalc) (GPL-3.0),
chosen as the base after comparing the public Warframe damage calculators on GitHub: it was the
only one combining a permissive-to-fork licence, wiki-sourced formulas, an automated test suite
and in-game calibration. On top of it this fork adds:

- **`wfcalc bruteforce`** — an exhaustive build search: every feasible mod combination for one
  weapon against one enemy, at any level, with or without **Steel Path**, with **fixed mods**
  the search must keep. Warframe buffs (`--buff`, `--strength`) and Incarnon evolutions
  (`--incarnon`) are inputs, not searched. Parallel across cores; pruned by capacity, Forma and
  incompatible mods; one evaluation per distinct elemental pairing rather than per slot order.
- **`--steel-path`** on every command: enemy health and shields ×2.5 (armour unchanged).
- **DE Public Export**: `npm run public-export` downloads `ExportWeapons` from DE's official
  endpoint (with a built-in LZMA decoder for the index) and checks or updates every weapon's stat
  block against it.
- Formula fixes found while checking wfcalc against the wiki (see `docs/formulas.md`): elemental
  combination order (innate elements last; a repeated element keeps its first slot), 1/32 damage
  quantization, Eximus base health/shield increase, Techrot and Anarch scaling curves, and
  category-wide mods (Hunter Munitions) that the search never considered.

```sh
# Best build for a Soma Prime against a level 200 Steel Path Heavy Gunner, keeping two mods
./bin/wfcalc bruteforce "Soma Prime" --enemy "Heavy Gunner" --level 200 --steel-path \
    --fixed "Serration,Hunter Munitions" --buff roar --strength 150
```

## Install

Node ≥ 23 and nothing else (no runtime dependencies). The snapshot ships with the repo, so
a clone works without downloading the game data:

```sh
git clone https://github.com/asphyksia/wfcalc.git
cd wfcalc
./bin/wfcalc calc "Torid" --mod Serration --enemy Bombard --level 150
./bin/wfcalc serve            # UI at http://127.0.0.1:7777
```

`npm run update` refreshes the data from WFCD and the wiki (~12 MB); `npm run sync` only does
it when an upstream changed. `npm install` is only needed for `npm run check` (TypeScript).

## For agents

The calculator is designed to be driven headless by an AI agent through the CLI, not through
an MCP server: one process per question, compact text, and `--brief` for a one-line answer.
JSON exists (`--json`) for the cases where a field must be parsed, but it is the expensive
output, not the default.

The operating manual is [`skills/wfcalc/SKILL.md`](skills/wfcalc/SKILL.md); the detailed contract
(flags, fields, assumptions, limits) is [`docs/agent.md`](docs/agent.md). Copy `skills/wfcalc/`
into your agent's skills directory to install it.

```sh
wfcalc search "Soma Prime" --enemy Bombard --level 150 --top 1 --brief
wfcalc calc "Soma Prime" --mod Serration --strip-from Avalanche --strength 200 --enemy Bombard --level 150 --brief
wfcalc ability Miasma --strength 200 --enemy Bombard --level 150 --brief
wfcalc calc "Soma Prime" --mod Serration --enemy Bombard --level 150 --brief=answer  # answer only
wfcalc batch builds.jsonl --brief=answer                                           # one process, one line each
```

`batch` reads JSONL (the same fields as `POST /api/calc`, plus `label` and `ability`); a bad
record is reported on its own line and does not stop the rest. `npm run eval` runs ten pinned
agent cases (best build, strip, melee Incarnon, errors, batch) and fails if an answer moves.

## Quick start

```sh
wfcalc calc "Kuva Bramma" --mod Serration --mod "Split Chamber" --mod "Vital Sense" \
       --mod Hellfire --mod "Cryo Rounds" --enemy Bombard --level 150
```

```
build  —  Kuva Bramma (Bow) vs Bombard lv150
──────────────────────────────────────────────────────────────────────────────
  damage/shot   7,612.92  ×1.90 multishot  ×2.27 crit avg
  crit           35.0% ×4.62   status 21.0%   fire rate 0.67/s
  elements     impact 6.5%, blast 93.5%
  dps          burst 21,860.8   sustained 15,614.8   avg hit 32,791.1
  target       hp 118,480.2  shields 0  armor 2,700   -> 27.4 shots, 57.51s
```

Interactive UI: `wfcalc serve` → <http://127.0.0.1:7777>. Tabs: **Build** (mods, target,
armour strip from Corrosive Projections / Shattering Impact / an ability), **Find** (the best
eight-slot build for a target, with its Forma), **Abilities** (damage per cast), Compare and
Saved.

### From the phone or another device

The session shares Android's network stack, so the loopback address works from the phone's own
browser: open `http://127.0.0.1:7777`. To reach it from another device on the Wi-Fi, or from the
phone by IP, listen on all interfaces:

```sh
wfcalc serve --host 0.0.0.0    # prints every reachable address on startup
```

It has no authentication, so use it at home and stop it when you are done. To keep it running
after closing the terminal: `setsid wfcalc serve --host 0.0.0.0 >/tmp/wfcalc.log 2>&1 &`.

## Commands

| Command | What it does |
|---|---|
| `wfcalc search <weapon> [options]` | Find the best build for a target (greedy + local search) |
| `wfcalc bruteforce <weapon> [options]` | Try every mod combination for a target (exhaustive) |
| `wfcalc calc <weapon> [options]` | Full damage report |
| `wfcalc compare <weapon> --vs a,b --vs c,d` | Same build, different mod choices |
| `wfcalc weapons [query]` | Search the 622 weapons |
| `wfcalc mods <weapon> [query]` | Mods that fit that weapon |
| `wfcalc arcanes [query]` | Weapon arcanes |
| `wfcalc buffs` | Warframe buffs the calculator models |
| `wfcalc rivens [query]` | Riven attribute ids |
| `wfcalc incarnon <weapon>` | Incarnon evolution options for a weapon |
| `wfcalc enemies [query]` | Search the 479 enemies |
| `wfcalc serve [--port 7777]` | Local web UI + JSON API |
| `wfcalc update` | Re-download sources and rebuild the snapshot |

Every command takes `--json`. For driving the tool from an AI agent, see
[docs/agent.md](docs/agent.md) and the `wfcalc` skill. [docs/plan.md](docs/plan.md) records the
current state, the working method and what is left to do.

### Options

| Option | Meaning |
|---|---|
| `--mod NAME` / `--mod "A,B"` | Equip one or more mods, optionally under-levelled (`:R5`) |
| `--arcane NAME[:R5]` | Equip a weapon arcane (Primary Merciless, Melee Exposure...) |
| `--arcane auto` | (search) Let the search choose the arcane whose slot fits |
| `--capacity 30\|60` | Mod capacity for calc/search (60 = Orokin Catalyst, default) |
| `--buff roar,eclipse` | Activate Warframe buffs (see `wfcalc buffs`) |
| `--strength 284` | Caster's Ability Strength in percent (default 100) |
| `--frame-mods "Intensify,Blind Rage"` | Derive Ability Strength from Warframe mods |
| `--riven damage,multishot,-zoom` | Riven stats (`-` marks the malus) |
| `--riven-roll 1.05` / `--riven-rank 6` | Riven random roll (0.9-1.1) and rank |
| `--frame Rhino` | Validate that the frame can actually bring those buffs (Helminth) |
| `--frame-arcane "Arcane Avenger"` | Warframe arcanes (also feed Ability Strength) |
| `--element-bonus heat:60` | Kuva/Tenet elemental bonus (25-60%) |
| `--covenant-damage 4000` | Damage prevented, for Harrow's Covenant |
| `--viral 10`, `--corrosive 10` | Status stacks kept up on the target |
| `--incarnon "EVO2:0,EVO4:1"` | Incarnon evolutions per tier (see `wfcalc incarnon`) |
| `--incarnon form` | Transformed profile with no evolution perks |
| `--eximus` / `--overguard N` | Add level-scaled Eximus Overguard, or an explicit amount |
| `--targets N` | Group report: abilities hit N enemies at full damage; Torid chains; an AoE weapon adds the radial share for the extras |
| `--ability-distance N` | Distance from the cast point for abilities with falloff (Discharge) |
| `--attenuation archon\|eidolon` | Boss damage caps; Eidolons are automatic |
| `--mdpt N --mdps N` | Custom caps per hit / per second |
| `--flat-dr 20 --status-dr 50` | Extra flat and status-only damage reduction, percent |
| `--combo-hits 220` / `--heavy` | Melee combo counter and heavy attack |
| `--aoe-distance 4` | Distance to the blast centre for AoE weapons (falloff) |
| `--enemy NAME`, `--level N` | Target and level (default Bombard at 100) |
| `--steel-path` | Steel Path target: health and shields ×2.5. `--level` is the actual enemy level (node level + 100) |
| `--fixed "A,B:R3"` | (bruteforce) Mods always equipped; an Exilus mod goes in the Exilus slot |
| `--max-evals N` / `--pool N` | (bruteforce) Combination budget (default 2,000,000) / force a shortlist size |
| `--workers N` | (bruteforce) Threads, default every core |
| `--faction grineer` | Shorthand for a benchmark enemy of that faction |
| `--mode "Incarnon Form"` | Use an alternative fire mode |
| `--stacks onKill=5` | Activate a conditional effect with N stacks |
| `--status-types 4` / `auto` | Status types on the target; `auto` counts the build's own damage types |
| `--headshot` | Every hit is a weak-point hit |
| `--brief`, `--brief=answer` | One-line answer for agents (answer drops the context) |
| `--json` | Machine-readable output; use it only when you must parse a field |

## Keeping the data fresh

`npm run sync` is built to run weekly and to be cheap when nothing changed:

```sh
npm run sync-check   # report whether any upstream moved (touches nothing)
npm run sync         # fetch, rebuild, run invariants + coverage, sample the calibration
```

Change detection is per source: the WFCD export is checked through the GitHub API (last
commit on `data/json`), and every wiki page through `If-Modified-Since`, which the wiki
answers with a 304. A run where nothing moved downloads only page headers and does not
rebuild. Each run appends to [docs/sync-log.md](docs/sync-log.md) with what changed and how
the calibration moved, so a regression is traceable to a week.

Weekly timer:

```ini
# ~/.config/systemd/user/wfcalc-sync.service
[Service]
Type=oneshot
WorkingDirectory=%h/work/wfcalc
ExecStart=/usr/bin/node tools/sync.ts
```
```ini
# ~/.config/systemd/user/wfcalc-sync.timer
[Timer]
OnCalendar=weekly
Persistent=true
[Install]
WantedBy=timers.target
```

Or, with cron: `17 4 * * 1 cd ~/work/wfcalc && npm run sync >> sync.log 2>&1`.

### Drift detection

`npm run drift` joins our weapon data against a public mirror of the same game export, by Lotus
path, and compares the base stats as ratios (the export stores fire rate in ticks per minute, so
a flat comparison is meaningless). A field whose ratio is stable across weapons is a unit
difference; a weapon that deviates from that median got stale.

It is a signal, not a verdict: some raw fields sit at their default (Acceltra's
`criticalHitDamageMultiplier` is 2 in the export while the game and the mirror's engine use 2.8),
so crit/status divergences need arbitration. Magazine size and reload have no such defaults and
are the reliable class — that is how the Fulmin family's factor-of-10 error turned up.
`npm run sync` runs it on every update.

### Why not use the external database as the primary source?

Because it is a *mirror of the same game export*, keyed by the same Lotus paths, and its value
here is different: it is the oracle. It renders the live game, so when our export and the mirror
disagree (Acceltra's status chance, Fulmin's magazine) the export is the stale one. So:

| Source | Role |
|---|---|
| WFCD `warframe-items` | primary data — structured, git-versioned, diffable |
| WARFRAME Wiki raw modules | primary data — mod list, formulas, sets, abilities |
| External public build database (API + static mirror) | verifier — calibration and drift; provenance in `docs/data-notes.md` |

Using it as the primary source would mean adopting a webpack chunk with its own schema as the
foundation, and losing the per-commit diffability of a git repository. Making it the verifier
gets the accuracy benefit without the coupling. The learned id map is rebuilt on every sync.

## Data

Everything comes from two upstreams, rebuilt into `data/snapshot.json` (1.7 MB):

- **WARFRAME Wiki** (`wiki.warframe.com`): the authoritative mod list with in-game
  upgrade axes (`Module:Mods/data`), the damage-type modifier matrix
  (`Module:DamageTypes/data`), and the formulas (`Damage/Calculation`, `Armor`,
  `Enemy_Level_Scaling`, `Riven_Mods`).
- **WFCD/warframe-items** (game export): per-rank mod numbers, weapon stat blocks,
  enemy health pools, arcanes.
- **DE Public Export** (`origin.warframe.com/PublicExport`, the game's official data API):
  weapon stat blocks, checked and applied by `npm run public-export`. Corrections in
  `data/weapon-overrides.json` win over it, and riven dispositions are kept from WFCD because
  the export now carries a placeholder (1.2) for every weapon.

`wfcalc update` refreshes all three. Raw files land in `data/raw/`, the digest in
`data/snapshot.json`. Nothing talks to the network at calculation time.

## What it does model

- Arsenal damage formula: base damage, physical (IPS) mods, elemental mods and their
  **combination order**, multishot, crit chance/damage, status chance.
- Faction damage mods and **Roar**, applied multiplicatively against the matching faction.
- Weapon arcanes (Primary Merciless, Melee Exposure, Cascadia Flare...) with their stacks.
- **Kuva/Tenet elemental bonus**: the player-chosen element, baked in as innate damage
  (which is what really decides the elemental combination on those 35 weapons).
- **Warframe arcanes**: Arcane Avenger (flat crit chance), Arcane Acceleration, Arcane Rage,
  Molt Augmented (which feeds Ability Strength and therefore every buff).
- **Helminth awareness**: a buff from another frame is flagged when it is not subsumable.
- **Crit spread**: expected crits per shot and the chance of at least one, which matters
  for shotguns where the average hides a wide range.
- **Warframe buffs**: Roar, Eclipse, Vex Armor, Xata's Whisper, Toxic Lash, Nourish, the
  elemental augments (Shock Trooper, Freeze Force, Fireball Frenzy, Smite Infusion,
  Venom Dose), Warcry, Accelerant, Sonar and Resupply — scaled by Ability Strength.
- Conditional mods (on-kill, aiming, weak-point) with stacks.
- Enemy level scaling (the current two-curve smoothstep for health/shields, the
  single armor curve, the 200–2700 armor clamp).
- Damage 3.0 faction health classes (Grineer, Corpus, Kuva Grineer, Orokin, ...) with the
  wiki's ±50% table, armor damage reduction, Toxin shield bypass.
- **Rivens** with real values: wiki base table × the weapon's own disposition × the
  bonus/malus weights × an optional roll.
- **Incarnon evolutions**: per-weapon perk trees scraped from the wiki, with the parsed
  stat bonuses applied (flat base damage included). Variants (Prime/Wraith/Vandal...)
  inherit the tree of their base weapon, which is how the game works. The five melee
  forms (Ack & Brunt, Ceramic Dagger, Hate, Okina, Okina Prime) use the wiki's Spectral
  attack as their profile, and drop melee damage bonuses as the game does.
- **AoE falloff**: the game's own `{start, end, reduction}` per attack, so a Bramma at
  4 m from the blast does what it does in game.
- **Melee combo**: the 2x-12x multiplier ladder, combo-scaling mods (Blood Rush,
  Weeping Wounds) and heavy attacks — normal attacks are deliberately *not* multiplied.
- **Damage over time** from status procs (Slash, Heat, Toxin, Electricity, Gas, Blast)
  including the faction double-dip, plus **Viral** and **Corrosive** stacks on the target.
- Forced procs (Hunter Munitions, Internal Bleeding) and Status Damage mods.
- Per-type damage breakdown, status proc distribution, shots to kill and time to kill,
  with status damage counted into the kill time.

## What it does not model yet

- Elemental Ward and Provoke do not buff weapon damage, so they are intentionally absent.
- **Damage attenuation** for bosses: `--attenuation archon` (MDPT 460k, MDPS 935k, 20% flat DR,
  50% status DR) or `--mdpt/--mdps` for a known custom value; Eidolons apply their
  health-relative caps automatically. Per hit it uses the wiki's hyperbolic formula
  (`damage × MDPI / (damage × multishot + MDPI)`); the per-second exponential smoothing is not
  modelled, so sustained TTK is still conservative.
- Umbral set bonuses, Archon Shards and Helminth invigorations for Ability Strength.
- **Stances**: stance damage multipliers are per-combo-hit execution, not a build
  property, and the wiki keeps them in prose. Out of scope by design.
- Punch-through multi-hits: punch-through changes how many *targets* one shot hits, not
  the damage a single target takes, so it does not enter a single-target TTK.
- Per-pellet status variance (damage uses expectations; crit spread is reported).
- Incarnon perks that are mechanics rather than stats (they are stored as text, not applied).
- 15 of the 74 weapons with an Incarnon form have no evolution table; with variant
  inheritance 59 are covered, and the remainder look like export noise.
- **2% of weapon-relevant mods** (9 of 596) still have a line the model does not use, mostly
  conditionals without a toggle (Strain Infection's crit damage per Cyst) and stance prose.
  They are reported as `unsupportedMods` and the result is flagged as a lower bound rather than
  silently wrong. `npm run coverage` prints the current state.

## How do we know it is right?

Testing every damage combination in game is impossible, so the model is checked in
layers. `npm run validate` is the machine-checkable part and exits non-zero on failure:

1. **Invariants over the whole dataset** (622 weapons, 479 enemies): damage is linear in
   base damage, adding a net-positive mod never lowers the average shot, enabling a
   conditional never lowers it either, armour DR hits exactly 1x at 0 armour and 0.1x at
   2700, shares sum to 1, enemy health never drops with level, armour never exceeds the
   2700 clamp, and no NaN or negative damage anywhere.
2. **Cross-path consistency**: the per-damage-type breakdown must add up to the same
   total the aggregate path computes.
3. **Golden values from the wiki**: the worked examples with explicit numbers
   (Serration's 18 -> 45, the five DoT tick examples, the armour curves, the combo
   ladder) are asserted to the decimal in `tests/`. The DoT ticks match the wiki's own
   arithmetic, e.g. `((40 x 1.55) + 1) x 0.5 x 3.25 x 1.55 = 158.68`.
4. **In-game calibration**: a short list of screenshots worth taking, in
   [docs/calibration.md](docs/calibration.md). Fifteen cases that each isolate one layer
   beat thousands of combinations, because the layers compose.

The validator has already earned its keep: it caught a charge weapon whose export
`fireRate` is 0 (Lanka), which made its DPS zero.

## Calibration against public builds

A public build database is reachable through its JSON API and static host. That is enough to
validate against real builds without making it a data source:

```sh
node tools/fetch-oracle-db.ts        # learn the external mod/item ids (no hardcoded hashes)
npm run calibrate:refresh               # fetch a local battery of public builds
node tools/calibrate.ts                 # compare the pinned battery, offline
node tools/calibrate.ts --build <id>    # one build's stat-by-stat detail
```

`tools/calibrate.ts` resolves every mod and arcane from the learned ids, computes the build with
wfcalc and diffs it against the external modifier block (`WEAPON_CRIT_CHANCE`,
`WEAPON_FIRE_ITERATIONS`, ...). The battery is **local and gitignored**
(`data/calibration-builds.json`); only the aggregate result is committed in
[docs/calibration-results.md](docs/calibration-results.md). `calibrate:refresh` is the only
network step.

Latest battery: **35/35** unique public builds, including **8 melee and 5 secondary** weapons.
`tests/calibration.test.ts` runs locally when the battery is present and skips in a fresh clone
or CI, because the battery is not shipped. `npm run audit` adds the *why*: mismatch rate per
weapon category, per field, and mods over-represented in failures. Its last sweep found every
failure concentrated in four weapons, one field each. The remaining mismatches are grouped by
signature; the open ones are listed in [docs/data-notes.md](docs/data-notes.md).

## Reviewing the UI without a desktop

Chromium is available on Arch Linux ARM (`pacman -S chromium`), so the layout can be
screenshotted headlessly instead of guessed at:

```sh
wfcalc serve --host 0.0.0.0 &
npm run shot                        # phone viewport, empty state
npm run shot -- --build haalvu      # with a realistic build loaded
npm run shot -- --width 1280 --height 900 --out /tmp/desktop.png
```

## Development

```sh
npm run update     # refresh data
npm test           # engine and CLI contract tests
npm run eval       # pinned answers for the questions an agent gets
npm run check      # tsc --noEmit
npm run coverage   # how much of the mod dataset is understood
npm run validate   # invariants + cross-checks over the whole dataset
npm run calibrate  # local pinned build battery, offline (refresh first)
```

Layout:

```
tools/fetch.ts      download upstream sources into data/raw/
tools/parse-lua.ts  parser for the wiki's Lua data modules
tools/build-data.ts normalise everything into data/snapshot.json
src/mods/parse.ts   mod text -> typed effects (the long-tail part)
src/engine/         build resolution, buffs, enemy scaling, damage
tools/fetch-abilities.ts  ability/augment numbers from the wiki infoboxes
tools/fetch-incarnon.ts   Incarnon evolution trees per weapon
src/cli.ts          CLI
src/server.ts       local API + static web UI
src/web/            the UI (vanilla JS, no build step)
docs/formulas.md    every formula and where it comes from
docs/api.md         the JSON API, for scripts and the web UI
skills/wfcalc/      agent skill: the CLI operating manual
docs/agent.md       agent contract: fields, assumptions, failure modes
```

Formulas and their sources: [docs/formulas.md](docs/formulas.md).
JSON API: [docs/api.md](docs/api.md).
Contributors and beta review records: [CONTRIBUTORS.md](CONTRIBUTORS.md) and
[docs/reviews/](docs/reviews/README.md).

## Status and known limitations

Usable now for comparing ranged weapon builds, mods, rivens, Incarnon and abilities against a
concrete enemy. Calibration against 35 pinned public builds (seven arsenal stats each) matches
35/35 locally; the battery is not shipped. It does **not** model:

- **Ability statuses** are modelled for the abilities whose wiki page states them: Inferno's
  guaranteed Heat, Miasma's Viral and Shuriken's Bleed. Other abilities' status effects are not.
- **Overguard** is modelled for Eximus (`--eximus`) and for a known amount (`--overguard N`):
  base 12, wiki level scaling, Void +50%, no armour. Only direct damage is credited while it is
  up (status DoT and Magnetic's status amplification are not modelled).
- **Ability shields**: a cast now removes shields before health, using the shield type's damage
  modifiers (Toxin bypasses them as usual). Overguard, shield and health casts are counted
  separately, so the total is conservative by at most two casts.
- **Incarnon second hits** (`Incarnon Form AoE`, the melee Spectral explosion) are part of the
  shot at the blast centre; `--aoe-distance` applies their falloff. Direct-only multipliers
  (Condition Overload, Galvanized Aptitude) scale by the direct share, so the explosion is not
  inflated by them.
- **Ability multi-target**: `--targets N` reports one cast across N enemies at full damage.
- **Torid chain**: the Incarnon beam chains to up to five nearby enemies at 75% per link;
  `--targets N` reports the group total (same target profile assumed). An AoE weapon adds the
  radial share for the extra targets at the same distance; a weapon with no chain or radial
  warns.
- **Ability statuses**: Inferno (Heat), Fireball (Heat), Thermal Sunder's Heat mode, Miasma
  (Viral), Shuriken (Bleed) and Spores' Corrosive ramp (1.5 procs/s, 10 stacks, 80% strip;
  price the weapon with `--corrosive 10`). Inferno's direct hit is split into the wiki's 1,250
  Impact + 1,250 Heat. Use `--ability-mode heat` for Thermal Sunder's Hold cast.
- **Damage attenuation**: per-hit attenuation uses the wiki's hyperbolic formula for
  Archons/Eidolons and explicit `--mdpt/--mdps`; the per-second exponential smoothing is not
  modelled, and Liches/Sisters have no published cap values (pass your own). Eidolon
  joints/invulnerability phases and Lich ranks are also not modelled.
- **Ability distance falloff**: Discharge falls linearly to 50% at max range; use
  `--ability-distance N`. Other abilities have no documented distance falloff.
- Stance modifiers, companions, Archwing and Necramech.

`docs/plan.md` keeps the full list, the evidence for each gap, and the order to close them.

## Data sources and licensing

The **code** is licensed under the GNU General Public License v3.0 only: see [LICENSE](LICENSE).
You can use, study, share and sell it; if you distribute a modified version, it must stay under
the GPL and you must offer its source.

The **data** has its own terms and they are not all compatible with commercial use:

- [WFCD/warframe-items](https://github.com/WFCD/warframe-items): MIT. Weapon, mod, enemy and
  arcane numbers, and the game-export text.
- DE Public Export: Digital Extremes' public data files, fetched on demand; not redistributed
  beyond the numbers already in the snapshot.
- [wiki.warframe.com](https://wiki.warframe.com): **CC BY-NC-SA 3.0**. Mod descriptions, Incarnon
  evolution trees, ability numbers and the formulas quoted in `docs/formulas.md` are derived
  from it. NC means non-commercial: a paid product built on this snapshot needs permission or a
  data source without that restriction. If you redistribute the snapshot, keep the attribution
  and share-alike terms.
- External public builds are queried for calibration only. The battery is local and gitignored;
  no build IDs, titles or pages are shipped.
- Warframe artwork, names and marks belong to Digital Extremes. No artwork is redistributed in
  this repository: the server fetches mod cards and images on demand and caches them locally
  (`data/cards/` and `data/img/`, both gitignored; card frames are CSS-only). If you plan to charge for an app
  around this, read Digital Extremes' fan content and EULA terms first.

Not legal advice, but the practical reading: GPLv3 does not stop you from monetising. The wiki's
non-commercial data licence and Digital Extremes' IP are the parts to clear before selling.
