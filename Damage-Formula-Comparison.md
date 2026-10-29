# Damage formula comparison

wfcalc (this repo) compared with three public calculators, 2026-10-29.

| Site | What was read | How sure |
|---|---|---|
| **wfcalc** | `src/engine/` (damage.ts, enemy.ts, hit.ts, dot.ts, simulate.ts) and `docs/formulas.md` | exact |
| **underframe.site** | `static/script.js` (50k lines, readable) and `/api/data`. The hit maths, armour, statuses and DoT run in a compiled WebAssembly module (`dps_calculator.wasm`, C++) | JS part exact; WASM part **not checked** (see below) |
| **void-forge.org** | Next.js bundles of `/damage-simulator` and `/weapon-builder` (minified, pretty-printed) | exact for what is listed |
| **warframe-damage.com** | `min.js?v4.01` (minified, pretty-printed) | exact for what is listed |

Underframe's WASM was not run: running downloaded site code was blocked by the session's permission check. Its
input fields (`affectedByArmor`, `heatInheritFactionPercent`, `statusCaps`, `critical-tier-capacity`...) show
which mechanics it has, not their numbers. "UF: ?" below means the number lives in the WASM.

How each one runs: wfcalc = expected values plus a 10 ms step simulation. Void-forge = expected values in a
step simulation. Warframe-damage.com = Monte-Carlo (random rolls per shot). Underframe = Monte-Carlo
simulation in WASM, with a seeded "luck averaged" mode.

## Discrepancies

`=` means the same as wfcalc.

### Weapon side

| # | Topic | wfcalc | Underframe | Void-forge | warframe-damage.com |
|---|---|---|---|---|---|
| 1 | Damage quantization | each type rounded to 1/32 of modded base damage, after element combination | = (`DAMAGE_QUANTIZATION_DIVISOR = 32`) | = (`a / 32` of modded base) | **1/16** steps, and the step size also includes faction bonus and final multipliers (`setQuantize`: `scale = base × mods × faction / 16`) |
| 2 | Base crit multiplier quantization | none | rounds base crit multiplier to steps of 32/4095 (`quantizeBaseCriticalMultiplier`) | has the same 32/4095 rounding helper | none |
| 3 | Crit math | expected value `1 + CC × (CD − 1)`, tiers by expectation | random tiers in the simulation | expected value, same as wfcalc | random tier per hit: `1 + tier × (CD − 1)` |
| 4 | Random rolls | none (expected values) | seeded RNG | none | `isProc(a, 100)` draws `floor(random × 101)`, so a roll of a% succeeds with a/101 odds (about 1% low), and chances are rounded to whole percent first |
| 5 | Headshot base multiplier | 3x, 1.5x for Murmur **and Techrot** | from the enemy preset (`headshotMultiplier`) | 3x, 1.5x for Murmur only (Techrot is mapped to Corpus, so 3x) | 3x for every faction |
| 6 | Crit headshot (doubled crit multiplier, `2 × CD − 1`) | everywhere except Corpus, Murmur, Techrot | ? | **only** Grineer (and Kuva, Scaldra), Anarchs, Infested, Sentient. Orokin/Corrupted, Narmer, Zariman get no crit headshot | every faction; only weapons flagged `no_headshot_mult` are excluded |
| 7 | Madurai ×1.3 (focus) | not modelled | ? | not seen | applied twice to physical types (`r × (physical ? r : 1)` → ×1.69) |

### Enemy side

| # | Topic | wfcalc | Underframe | Void-forge | warframe-damage.com |
|---|---|---|---|---|---|
| 8 | Armour DR ≤ 2700 | `0.9 × √(armor/2700)` | ? | = | `√(3 × armor) / 100`, which is the same formula |
| 9 | Armour DR > 2700 | `armor / (armor + 300)` | ? | = | no branch: armour is clamped to 2700, so DR never goes past 90% |
| 10 | Minimum 1 damage per type against armour | yes | ? | **no** | yes (armour layer only) |
| 11 | Faction modifier table | wiki Damage 3.0 table (docs/formulas.md §4) | ? (in WASM) | = | **Sentient** also gets Magnetic +50%; **Scaldra** gets Toxin −50% instead of Gas −50% |
| 12 | Techrot health curve | `1 + 0.02q^2.12` → `1 + 15.0998q^0.7` | = | = | `1 + 0.015q^2.1` → `1 + 13.64q^0.72` (30.5·√5/5) |
| 13 | Techrot shield curve | `… → 1 + 3.5q^0.76` | = | = | `1 + 3.4106q^0.76` |
| 14 | Shield curve for Sentient / Murmur / neutral | `1 + 1.6q^0.75` | = | = | `1 + 2q^0.75` |
| 15 | Orokin shields/health | Corrupted curve (`2q^0.75` shields, `10.7332q^0.685` health) | = | only if the faction is spelled "Corrupted"/"Anarch"; "Orokin" falls to the default curve | = |
| 16 | Eximus health/shields | raise the base (`max(1.1·base, k·(base+900)·step)`), then the faction curve | = | = | multiplies by a step factor × a **neutral** curve (`0.015q^2`, `10.73q^0.5`) for every faction, and also scales **armour** for Eximus |
| 17 | Overguard smoothstep | t from `q = level − 1`, 45..50 | = | t from the **level**, not `level − 1` (one level off) | between q 45 and 50 returns the high curve only; above 50 the blend is computed on an already-transformed value (bug) |
| 18 | Steel Path | health and shields ×2.5 | = | = | = (floors the base first) |
| 19 | Stat rounding | none (binary32 like the game) | rounds health/shields, truncates armour | none | rounds health, shields and armour |

### Status effects and DoT

| # | Topic | wfcalc | Underframe | Void-forge | warframe-damage.com |
|---|---|---|---|---|---|
| 20 | DoT tick seed | `((seed × faction) + 1) × C × (1 + element mods) × status dmg × faction` | ? | `seed × avg crit × status dmg × faction² × location` — **no +1** | `C × seed × faction × (1 + element mods) × faction` — **no +1** |
| 21 | Faction bonus applied twice to DoT | yes | ? | yes (`R(e) = f²`) | yes (`J × J`) |
| 22 | Puncture duration | 10 s | ? | 6 s | 6 s |
| 23 | Heat armour strip | ramps 15/30/40/50% per 0.5 s, decays 1.5 s per step | ? | = | flat 50% while any Heat proc is on the target |
| 24 | Cold crit bonus | +0.1, then +0.05 per stack, cap +0.5; freeze at 10 stacks +1.0 | ? | = | +0.05 per stack (+0.5 at 10), plus another +0.5 at exactly 10 stacks |
| 25 | Slash ticks vs shields | health only (Slash is True damage) | ? | Slash ticks hit **shields** first (`ignoreShields: false`) | health only |
| 26 | Toxin bypasses shields | yes, except the listed enemies (Treasurer, Hounds) | ? | every enemy, no exceptions | yes |
| 27 | Electricity/Gas first tick | one tick per second | ? | first tick at once, `ceil(duration)` ticks | Electricity first tick at once |
| 28 | Gas stacks | uncapped like other DoTs | ? | uncapped | capped at 10 |

### Where all four agree

Viral (+100%, +25% per stack, +325% cap), Magnetic (same curve on shields), Corrosive (−26%, −6% per stack,
−80% cap), armour clamp 200..2700 from level scaling, health/shield/armour curves for Grineer, Corpus,
Infested and Corrupted, the Eximus step table (except warframe-damage.com), Bane + Roar in one additive
faction bucket, Slash 0.35 and Heat/Toxin/Electricity/Gas 0.5 tick coefficients, Blast 0.3.

## Analysis: which site is right

Checked against wiki.warframe.com (raw wikitext, pages edited Jul–Oct 2026) and the patch notes the wiki quotes,
using the deep-research skill. Full report with quotes and URLs: `reports/Warframe damage formula verdicts.md`;
research notes: `research_notes/Warframe damage formula verdicts/`.

### Verdict per point

| # | What the game does | Right | Wrong | Confidence |
|---|---|---|---|---|
| 1 | Each type rounds to modded base / 32 (U40 changed it from /16) | wfcalc, UF, VF | WD (old /16 rule) | high |
| 2 | Base crit multiplier is stored in 32/4095 steps (at most ±0.0039, e.g. 2.2 → 2.2037) | UF, VF | wfcalc, WD | high |
| 3 | Average `1 + CC × (CD − 1)` at any crit chance | all | — | high |
| 4 | WD's `floor(random × 101)` is a code bug, every chance ~1% low | — | WD | high |
| 5 | Heads 3x; Murmur and Techrot "closer to 1.5x", per unit 1x–4.5x | wfcalc closest | VF, WD (3x on Techrot) | medium |
| 6 | Crit headshot is per body part: Grineer incl. Corrupted/Narmer/Kuva, Scaldra, Anarchs, most Infested and Sentient, Zariman Thrax; excludes Corpus ground units, most Murmur, much of Techrot | wfcalc | VF (also excludes Orokin, Narmer, Zariman), WD (allows all) | high |
| 7 | Madurai adds 30% of total base damage, split over physical types | — | WD (×1.3 twice) | medium-high |
| 8/9 | DR `0.9√(a/2700)`, above 2700 `a/(a+300)` | wfcalc, VF | WD | medium |
| 10 | At least 1 damage per type when armour reduces it | wfcalc, WD | VF | high |
| 11 | Sentient: Cold+, Radiation+, Corrosive−; Scaldra: Impact+, Corrosive+, Gas− | wfcalc, VF | WD | high |
| 12/13 | Techrot `0.02q^2.12 → 15.0998q^0.7`, shields `3.5q^0.76` | wfcalc, UF, VF | WD | medium-high |
| 14 | Sentient/default shields `1.6q^0.75` | wfcalc, UF, VF | WD | medium-high |
| 15 | Orokin/Corrupted curves as wfcalc has them | wfcalc, UF | VF ("Orokin" spelling misses the curve) | high |
| 16 | Eximus raises the base, then the unit's faction curve; no general Eximus armour formula | wfcalc, UF, VF | WD | high (armour medium) |
| 17 | Overguard blend uses q = level − 1 | wfcalc, UF | VF, WD | medium-high |
| 18/19 | Steel Path ×2.5 health and shields; armour not multiplied since **Update 36** (not 29.10); stats are 32-bit floats, not rounded | wfcalc (values) | UF, WD (round), wfcalc docs (wrong update number) | high / medium |
| 20 | DoT tick `(Σ seeds + 1) × C × M`, faction inside each seed | wfcalc | VF, WD (no +1) | medium (one 2026-07 wiki edit) |
| 21 | Faction counts twice on DoT | wfcalc, VF, WD | — | high |
| 22 | Puncture lasts 10 s, +5% crit per stack to +25% | wfcalc | VF, WD (6 s, old value) | medium-high |
| 23 | Heat strip ramps 15/30/40/50% per 0.5 s, falls a step every 1.5 s | wfcalc, VF | WD | high |
| 24 | Cold +0.10, +0.05 per stack to +0.50; Frozen at 10 = +1.0 total; bosses/Overguard cap at 4 | wfcalc, VF | WD | high |
| 25 | Slash bleed ignores armour but **hits shields** (U27.2) | VF | **wfcalc**, WD | high |
| 26 | Toxin skips shields except Treasurer and Hounds | wfcalc | VF | high |
| 27 | Slash/Heat/Toxin tick at 1–6 s, Electricity/Gas at 0–5 s, 6 ticks each | VF | wfcalc (all from 1 s) | high |
| 28 | Gas caps at 10 stacks, oldest replaced | WD | **wfcalc**, VF | high |

Underframe's armour, faction table, status and DoT maths are in compiled WASM that was not run, so it is
unknown on 8–11 and 20–28.

### Scorecard

All 28 points counted one by one; a mechanic a site does not model (Madurai) counts as wrong.

| Site | Right | Wrong | Unknown | Verdict |
|---|---|---|---|---|
| **wfcalc** | 23 | 5 (2, 7, 25, 27, 28) | 0 | most correct overall |
| **Void-forge** | 18 | 10 (5, 6, 7, 10, 15, 17, 20, 22, 26, 28) | 0 | second; same enemy model as wfcalc |
| **Underframe** | 12 | 1 (19, stat rounding, under one point) | 15 (in WASM) | no real error where readable; cannot be ranked until the WASM is checked |
| **warframe-damage.com** | 8 (+1 partial) | 19 | 0 | least correct: old /16 quantization, old Puncture, wrong faction and Techrot tables, flat Heat strip, biased RNG |

**Answer: wfcalc's code is the most correct of the four, with Void-forge next.** No site is right everywhere.
Void-forge is the only one that gets Slash-on-shields and the Electricity/Gas tick timing right, and
warframe-damage.com is the only one that caps Gas.

### Fixes wfcalc needs

1. **Slash ticks hit shields first** (#25): bleed bypasses armour, not shields. Affects TTK on shielded targets.
2. **Gas cap 10 stacks**, oldest replaced (#28).
3. **Electricity/Gas tick at 0 s** (#27), so their first tick lands at once in the simulation.
4. **Base crit multiplier quantization** to 32/4095 steps (#2): tiny (<0.2%), no ranking changes; cheap to add.
5. **DoT +1 for merged ticks** (#20): `dot.ts` gives every proc its own +1; Heat, Gas and Electricity pulses
   that land together get one +1 per tick (Slash and Toxin stay per stack). Small over-count.
6. **Madurai Phoenix Talons** (#7): not modelled; it adds 0.3 × total base damage as physical, after physical mods.
7. **Treasurer**: Toxin deals 0 while its shields are up.
8. **Docs**: Steel Path armour stopped scaling in Update 36, not 29.10 (`docs/formulas.md` §2, `enemy.ts`).
9. Optional: per-unit headshot values for Techrot and Murmur (wiki: 1x to 4.5x).

Weak evidence: the DoT +1 and the armour branch above 2700 rest on one editor's July 2026 wiki edits
without a DE statement. Both favour wfcalc, so check them in game before treating them as settled.

To check (outside the 28): the wiki's Murmur/Sentient/neutral health curve (`0.015q^2 → 10.7332q^0.5`) matches
wfcalc; Anarchs health is grouped differently on different wiki pages; the Techrot low-level shield exponent is
1.76 in the article and 1.75 in the wiki module.
