# Weapon-side damage mechanics: where the four calculators disagree

All wiki quotes come from raw wikitext (`?action=raw`), fetched 2026-10-29. Last edits of the pages used: Damage/Calculation 2026-08-31, Critical Hit 2026-09-02, Enemy Body Parts 2026-10-26, Focus/Madurai 2026-08-26 (checked through the MediaWiki API). The wiki is community-maintained. DE does not publish these internals, so "the game does X" means "the wiki says X, based on community tests".

Calculators: wfcalc (our repo), Underframe (UF), Void-forge (VF), warframe-damage.com (WD).

## 1. Damage quantization: divisor and what goes into the step

### Takeaway
The current rule: round each physical and elemental type to the nearest multiple of (modded base damage / 32), where combined elements are rounded as one sum. Then apply faction, damage-type and other multipliers to the rounded values. /32 replaced /16 with Update 40 (The Vallis Undermind, October 2025). WD's /16 is the old rule and is wrong today. **Verdict: wfcalc, UF and VF are right; WD is outdated.** Putting faction and final multipliers into the step size is *mathematically harmless*, because they scale the value and the step by the same factor. The divisor is the only real error. Confidence: high for /32 being what the wiki says now; medium for the exact date of the change (see Gaps).

### Cited Findings
- "physical and elemental damages round to the nearest multiple of 1/32nd of their attack's base damage, before being multiplied further." Scale = Modded Base Damage / 32; Quantized(x) = sign(x) × ⌊|x|×32 + 0.5⌋ / 32 with x = type value / modded base damage — [Damage/Calculation#Quantization](https://wiki.warframe.com/w/Damage/Calculation?action=raw)
- What goes into the step: "Elemental and Physical bonuses do not affect the scale." "Damage mods such as Hornet Strike, Faction Damage Bonus such as Bane of Grineer, and any other multipliers only multiply final quantized values and do not affect the scale or damage composition." "Applying Serration (+Damage), Bane of Grineer (+Faction) or any other non-elemental bonus multiplies both the base value of rounding numerator and Scale of rounding denominator, and therefore is a simple multiplier to any quantized total." — [Damage/Calculation](https://wiki.warframe.com/w/Damage/Calculation?action=raw)
- Combined elements are rounded as one sum. "Elements formed by a sum of mods and bonuses quantize their sum alone… (180% Viral, or 180% Radiation), each rounded to the nearest 1/32 of base damage". The steps are: get the scale, quantize physical and elemental, add, then "Apply all other multipliers such as Damage Type Modifier" — [Damage/Calculation](https://wiki.warframe.com/w/Damage/Calculation?action=raw)
- Worked example on the wiki: Nagantaka Prime, base 173, S = 173/32 = 5.40625. 1.73 Impact rounds to 0, and Cold+Toxin is rounded once as Viral (259.5) — [Damage/Calculation](https://wiki.warframe.com/w/Damage/Calculation?action=raw)
- History: wiki revision 2706703 (2025-11-12, user ArbitraryMary) has the edit summary "U40 changed damage quantization be be 1/32 instead of 1/16". It changed "1/16th" to "1/32nd". Before that edit the page (and the Theroxenes 2018 tests it cites) said 1/16 — [Damage/Calculation history (API)](https://wiki.warframe.com/api.php?action=query&prop=revisions&titles=Damage/Calculation&rvprop=ids|timestamp|user|comment&rvlimit=200&format=json); [diff](https://wiki.warframe.com/api.php?action=compare&fromrev=2656202&torev=2706703&format=json)
- Update 40 is "The Vallis Undermind". Hotfix 40.0.1 came out in mid-October 2025 — [Update 40 (wiki)](https://wiki.warframe.com/w/Update_40); [warframe.com patch notes 40.0.1](https://www.warframe.com/patch-notes/pc/40-0-1)
- The DoT tick exception: "Damage-over-time tick damage is not subject to the 1/32 damage-type quantization… A proc is calculated from the attack's modded base damage rather than from the sum of its quantized damage-type values." — [Damage/Calculation#Damage Over Time](https://wiki.warframe.com/w/Damage/Calculation?action=raw)
- Two edge cases. Hitscan does not quantize against Object health (Nullifier bubbles, Tornado), but projectiles do. Very small Impact portions round to 0 (Galatine 2.5% Impact never procs Shattering Impact) — [Damage/Calculation Trivia](https://wiki.warframe.com/w/Damage/Calculation?action=raw)

### Inferences
- WD folds faction and final multipliers into both the numerator and the step. That cancels out, because round(k·v / (k·B/16))·(k·B/16) = k·round(v/(B/16))·(B/16). Its only real deviation is /16. It would matter only if WD folded in something *additive* or something that changes the type mix, such as an element or a damage-type modifier per type. Check the WD code for that.
- /16 vs /32 matters most for small portions of a type. Under /16, anything below 1/32 of base rounds to 0, and residual physical types or small Riven elements are off by up to ±1/32 of base per type. Under /32 the error is up to ±1/64 of base per type.

### Gaps
- I found no DE patch note that mentions the change from 1/16 to 1/32. The searches turned up nothing in U40 coverage. The only source for "U40" is the wiki editor's edit summary, and that edit adds no new test or citation. The exact version is therefore medium confidence. That /32 is current is supported by later, more detailed edits (2025-12 Nagantaka worked table by Cephalon Scientia; 2026-07 "exact signed 1/32" formula by Wxihuann1225).

## 2. Quantization of the base critical multiplier (32/4095 steps)

### Takeaway
This is a real, documented mechanic. Before mods, the base critical damage multiplier is stored as a 12-bit code over the range 0–32: Code = ⌊clamp(x,0,32)·4095/32 + 0.5⌋, value = Code·32/4095, computed in float32. It applies after effects that add to the base value (e.g. the Incarnon perk Critical Parallel, +0.4), and before % mods. **Verdict: UF and VF are right; wfcalc and WD leave it out.** The effect is tiny: at most ±0.0039 on the base multiplier, i.e. ≤0.26% on crit damage for common bases, usually 0.02–0.17%. Confidence: high that the wiki documents it. The magnitude is computed exactly from the formula.

### Cited Findings
- "The base critical damage multiplier of a weapon is quantized. This applies before mods, but after certain effects that are additive to the base value. Before encoding, the base critical damage multiplier x is clamped to the range from 0 to 32." Code(x) = ⌊clamp(x,0,32) × 4095/32 + 0.5⌋, Quantized Base CDM = Code × 32/4095. "adjacent decoded values differ by 32/4095. The calculation uses 32-bit floating-point arithmetic." — [Critical Hit#Quantization](https://wiki.warframe.com/w/Critical_Hit?action=raw)
- Wiki example: Code(1.6+0.4) = ⌊2.0 × 4095/32 + 0.5⌋ = 256, then 256 × (32/4095) × (1 + Vital Sense 120%) — [Critical Hit](https://wiki.warframe.com/w/Critical_Hit?action=raw)
- Sources the wiki cites: BaeckerSkins, "Accurate eidolon damage…" (Reddit, 2022-01-15), and an Imgur album "showing quantized critical multiplier in the logs" (added 2023-12-03 by Hydroxylate). The exact 12-bit formula was written in 2026-07-29 (rev 2795870, "Use exact 12-bit critical damage quantization formula") — [Reddit source](https://www.reddit.com/r/Warframe/comments/s4tmbf/accurate_eidolon_damage_and_a_convenient/); [Critical Hit history (API)](https://wiki.warframe.com/api.php?action=query&prop=revisions&titles=Critical_Hit&rvprop=ids|timestamp|user|comment&rvlimit=300&format=json)
- Damage/Calculation also says critical DoTs "should apply the critical multiplier quantization described on Critical Hit" — [Damage/Calculation#Damage Over Time](https://wiki.warframe.com/w/Damage/Calculation?action=raw)
- Effect size, computed with the formula above (not a cited fact):

| Base CD | Code | Quantized | Rel. error |
|---|---|---|---|
| 1.5 | 192 | 1.500366 | +0.024% |
| 1.6 | 205 | 1.601954 | +0.122% |
| 1.8 | 230 | 1.797314 | −0.149% |
| 2.0 | 256 | 2.000488 | +0.024% |
| 2.2 | 282 | 2.203663 | +0.167% |
| 2.4 | 307 | 2.399023 | −0.041% |
| 3.0 | 384 | 3.000733 | +0.024% |

  Example: CD 2.2 with +220% at tier 3 gives a multiplier of 19.155 vs 19.120 (+0.18%).

### Inferences
- The quantization goes on the *base* value (plus additive-to-base effects such as Critical Parallel), not on the modded total. A calculator that rounds the modded total would be wrong. UF's and VF's formula round(cd·4095/32)·32/4095 matches, provided `cd` there is the base value.
- Leaving it out (wfcalc) is a precision issue, not a ranking issue. Builds are compared on the same base CD, so the order of builds never changes.
- The quantity is a weapon property, so the only ranking effect would come from comparing weapons whose base CDs fall on opposite sides of their rounding. That is below 0.3%.

### Gaps
- I did not open the Imgur log evidence. The wiki is the only source used here.

## 3. Crit tiers: expected multiplier 1 + CC×(CD−1) above 100%

### Takeaway
Confirmed. Tier multiplier = 1 + Tier × (CD − 1). CC above 100% guarantees tier ⌊CC⌋ and gives a chance of frac(CC) for the next tier. The expected value is therefore linear: 1 + CC×(CD−1) at any CC. **Verdict: all four agree; correct.** Confidence: high.

### Cited Findings
- "Critical Tier Multiplier = 1 + Critical Tier × (Total Critical Damage Multiplier − 1)" — [Critical Hit#Critical Tiers](https://wiki.warframe.com/w/Critical_Hit?action=raw)
- "When a weapon achieves a critical chance higher than 100%, every attack will crit but it also gains a chance to deal an even stronger crit." The tier table: 100–200% gives all hits yellow plus a chance of orange, and so on. Tiers keep rising past red, shown with up to three "!" — [Critical Hit](https://wiki.warframe.com/w/Critical_Hit?action=raw)
- "Average Damage Multiplier = 1 + Total Critical Chance × (Total Critical Damage Multiplier − 1)" (stated for non-headshot hits) — [Critical Hit](https://wiki.warframe.com/w/Critical_Hit?action=raw)
- Bug: past a tier multiplier of about 255 the damage number shown overflows to about −2.1 billion. Only the display is affected — [Critical Hit#Bugs](https://wiki.warframe.com/w/Critical_Hit?action=raw)

### Inferences
- Linearity: E = 1 + [⌊CC⌋ + frac(CC)]·(CD−1) = 1 + CC·(CD−1). On headcrits the same linearity holds with (2·CD−1) in place of (CD−1).
- The Vigilante set adds a +1 tier chance (5% per mod, up to 30%), which shifts the expected value by p·(CD−1) — [Critical Hit](https://wiki.warframe.com/w/Critical_Hit?action=raw)

### Gaps
- None.

## 4. WD's roll of floor(random × 101)

### Takeaway
This is a code bug, not a game mechanic. `Math.floor(Math.random()*101)` yields 0–100, i.e. 101 equally likely outcomes. A test like `roll < CC*100` then succeeds with probability CC·100/101, about 1% too low (e.g. 25% CC hits 24.75% of the time, and 100% CC fails 1 time in 101 if the test is `<`). It also quantizes chances to whole percent. **Verdict: WD is wrong. Using `Math.random() < p` is correct.** Confidence: high (arithmetic; no source needed).

### Cited Findings
- None needed: this is a reading of WD's code, as stated in the comparison file.

### Inferences
- In expectation the bias makes WD's simulated averages slightly lower for crit and status. A test with `<=` is biased differently, giving (k+1)/101. Check which comparison WD uses.

### Gaps
- I did not inspect WD's source in this pass.

## 5. Base multiplier for headshots / weak points

### Takeaway
3.0× for headshots on Grineer, Corpus, Infested, Sentient, Anarchs, Narmer and Corrupted. The Murmur and Techrot are *not* uniform. The wiki says "the usual multiplier is closer to 1.5x", but the values per unit range from 1× to 4.5×. **Verdict: 3× default is right (all). For the Murmur, 1.5× is the right default. For Techrot, wfcalc's 1.5× matches the wiki's stated "usual" value, but neither 1.5× (wfcalc) nor 3× (VF, WD) is right for every unit. The correct approach is per-unit values.** Confidence: high for 3× and for the wiki's statement on Murmur and Techrot; medium on which single default suits Techrot best.

### Cited Findings
- "Typical multiplier for headshots against Grineer, Corpus, Infested, Sentient, Anarchs, Narmer, and Orokin/Corrupted variants is 3.0x. For The Murmur and Techrot, the usual multiplier is closer to 1.5x." — [Enemy Body Parts#Weak Point Hits](https://wiki.warframe.com/w/Enemy_Body_Parts?action=raw)
- The 3× base dates from U32: "Increased the base damage multiplier on headshots from 2x to 3x." Since U32, radial damage no longer headshots — [Enemy Body Parts#Patch History](https://wiki.warframe.com/w/Enemy_Body_Parts?action=raw)
- Murmur table: Rogue Necramechs 1.5× (Arcocanid head, Culverin canisters, Bonewidow/Voidrig backs). Hollow Vein head 1.5×. Gruzzling face 2×. The Fragmented head 2×. Whispers' heads 1×. Severed Warden arms 1× — [Enemy Body Parts#Murmur](https://wiki.warframe.com/w/Enemy_Body_Parts?action=raw)
- Techrot table: Obsolyte head 3×. Legacyte head 3× and CRT monitor 3×. Matmas head 1.875× and balloon sacs 1.5×. Skuzzi monitor 4.5× and speakers 1×. Volatile Galliflex propane 1.5×. Babau 1×. Scaart head 1×. Galliflex monitors 1× (not a headshot). Miasmite has no weak point — [Enemy Body Parts#Techrot](https://wiki.warframe.com/w/Enemy_Body_Parts?action=raw)
- Scaldra humanoids: head 3× (except Dedicant and Screamer), backpacks 1.5× — [Enemy Body Parts#Scaldra](https://wiki.warframe.com/w/Enemy_Body_Parts?action=raw)
- Other exceptions: Zariman Thrax 3×, Void Angel 3×, Ethereal Void Angel 2×. Bipedal Corpus drones (MOAs) have a 1× head and a 2× "fanny pack". Archon shards 4.5× — [Enemy Body Parts](https://wiki.warframe.com/w/Enemy_Body_Parts?action=raw)
- How mods stack on the multiplier: "weak point damage" bonuses (Acuity) are additive to the weak-point multiplier, at a 1.5× rate if the part is also a head. "Headshot multiplier" bonuses (Deadhead, Target Acquired, sniper zoom) multiply. Example: (3 + 1.5·(3.5+0.75))·(1+0.3+0.4) = 15.94× — [Enemy Body Parts](https://wiki.warframe.com/w/Enemy_Body_Parts?action=raw)
- Weapons with a 1× default headshot multiplier (e.g. Arca Plasmor) ignore Acuity-type bonuses but are affected by Deadhead-type bonuses — [Enemy Body Parts#Notes](https://wiki.warframe.com/w/Enemy_Body_Parts?action=raw)

### Inferences
- If a calculator keeps one number per faction, 1.5× is the closest match to the wiki for both Murmur and Techrot. For Techrot the spread is wide enough (1×–4.5×) that per-unit data would be better.
- VF's and WD's 3× for Techrot is correct only for Obsolyte and Legacyte heads.

### Gaps
- The wiki tables come from community tests, and some are flagged as unclear (e.g. Skuzzi tail "1.4x sometimes"). U44 changed MOA and Bursa rear hitboxes into weak points that are not headshots, so the tables may still be shifting.

## 6. Critical headshot (crit multiplier doubled): which enemies are excluded

### Takeaway
The headcrit flag is per hitbox, not per faction. Per the wiki it applies reliably to Grineer heads (including Corrupted, Narmer and Anarch variants of Grineer), Dax Anarchs, Scaldra, and most Infested and Sentients. It excludes all Corpus humanoids and ground units, most of the Murmur, and much of Techrot. **Verdict: wfcalc's exclusions (Corpus, Murmur, Techrot) match the wiki at faction level. VF is too strict: it also excludes Orokin/Corrupted, Narmer and Zariman, but Corrupted Grineer, Narmer Grineer, Archons (3× on the shard) and Thrax *do* headcrit. On Corrupted, VF is right only for Corrupted Corpus units. WD is too permissive.** Confidence: high on the wording; medium on faction-level simplifications, because exceptions exist inside every faction.

### Cited Findings
- Exact wording: "The critical headshot, or "headcrit", flag activates the critical headshot bonus. This is applied more narrowly and literally than the headshot flag. As a result, many enemies cannot be headcrit. Although it activates reliably on the heads of Grineer (along with Orokin/Corrupted/Narmer/Anarchs variants of Grineer), Dax Anarchs, Scaldra and most Infested and Sentient foes, it excludes the heads of all Corpus humanoids and ground units, most of the The Murmur, and much of Techrot." — [Enemy Body Parts#Critical Headshots](https://wiki.warframe.com/w/Enemy_Body_Parts?action=raw)
- "Corpus humanoids do not receive headcrits, instead only taking the normal 3.0x headshot damage even after their helmets are removed. If a weapon defaults to a 1x headshot multiplier it will not benefit from the critical bonus, this is true even if the headshot multiplier is raised." Also: the bonus "is specific to heads and not generalized to all special body parts" (the MOA fanny pack gets 3× but no headcrit). The Jordas Golem engines are 1× but do headcrit — [Critical Hit#Critical Headshots](https://wiki.warframe.com/w/Critical_Hit?action=raw)
- Formula: Headshot Crit Tier Multi = Headshot Multi × (1 + Critical Tier × (2 × Total CDM − 1)) — [Critical Hit](https://wiki.warframe.com/w/Critical_Hit?action=raw). Enemy Body Parts words it as "Applies a 2x multiplier to the weapon's base critical multiplier", but the Critical Hit formula doubles the *total* CDM. Unit-specific values replace 2×: Juggernaut 4×, Ropalolyst head 0.2×, Archon shards 3×, Lumbering Fragment 3×, Whispers 1.5×, Demolisher Necramechs 1.25× — [Enemy Body Parts](https://wiki.warframe.com/w/Enemy_Body_Parts?action=raw)
- Corpus exceptions: "Airborne Corpus units like Ospreys and Raptors have a 3x headshot multiplier and headcrit applies to them." — [Enemy Body Parts#Corpus](https://wiki.warframe.com/w/Enemy_Body_Parts?action=raw)
- Variants: "Stats apply to all variants unless stated otherwise, including Corrupted and Narmer versions." The table key is "* No critical headshot bonus" — [Enemy Body Parts](https://wiki.warframe.com/w/Enemy_Body_Parts?action=raw)
- Zariman: Thrax Legatus and Centurion have a 3× head that headcrits. Void Angel (3×) and Ethereal Void Angel (2×) are marked "*", no headcrit — [Enemy Body Parts#Zariman](https://wiki.warframe.com/w/Enemy_Body_Parts?action=raw)
- Narmer: Archons have a 3× head, and the Archon shard (4.5×) "Applies the critical headshot bonus at a value of 3x" — [Enemy Body Parts#Narmer](https://wiki.warframe.com/w/Enemy_Body_Parts?action=raw)
- Infested and Sentient exceptions marked "*": Thrasher left shoulder, Undying Flyer head, Aerolyst, Brachiolyst, Spectralyst. Infested Ospreys have no head — [Enemy Body Parts](https://wiki.warframe.com/w/Enemy_Body_Parts?action=raw)
- Scaldra: humanoid heads headcrit, backpacks do not ("*") but promote the crit tier. Dedicant and Screamer upper bodies give the headcrit bonus without being a weak point — [Enemy Body Parts#Scaldra](https://wiki.warframe.com/w/Enemy_Body_Parts?action=raw)
- Techrot: only some parts headcrit. Legacyte head and Volatile Galliflex propane are marked "*". The Matmas sac pouch is a bodyshot that applies headcrit — [Enemy Body Parts#Techrot](https://wiki.warframe.com/w/Enemy_Body_Parts?action=raw)

### Inferences
- At faction level, the closest match to the wiki is: headcrit allowed for Grineer (all variants, including Kuva, Corrupted Grineer and Narmer Grineer), Scaldra, Anarchs, Infested, Sentient, Narmer/Archons, and Zariman Thrax. Not allowed for Corpus ground and humanoid units (Corrupted Corpus included), Murmur, Techrot, and Zariman Void Angels. wfcalc's model matches if "Orokin/Corrupted" is handled through the base faction of the unit.
- WD applying headcrit to everyone overstates headshot damage against Corpus by (1 + T(2CD−1))/(1 + T(CD−1)). That is about ×1.8 at CD 4, T=1.

### Gaps
- No patch note from DE lists which enemies get headcrits. All of this comes from wiki tests.

## 7. Madurai (Phoenix Talons, +30% physical damage)

### Takeaway
Phoenix Talons is *not* a ×1.3 on physical damage, and certainly not ×1.3 applied twice. Per the wiki it adds a flat bonus of 0.3 × the weapon's total base damage (physical *and* elemental base). This bonus is split across the base physical types by their weight among physical types only, and added after physical mods. **Verdict: WD's double ×1.3 is wrong. A calculator should model it as an addition to physical types worth 30% of base damage.** Confidence: medium-high. The wiki gives a worked example, but I found no independent in-game test.

### Cited Findings
- Node text: "Physical Damage and Operator Damage increased by 5 / 10 / 20 / 30%" (passive, applies to Warframe weapons) — [Focus/Madurai](https://wiki.warframe.com/w/Focus/Madurai?action=raw)
- Mechanics: "Physical Damage bonus is calculated by multiplying all of the weapon's base damage (including physical and elemental damage types) by 0.3, and subsequently multiplying the result by the respective base physical damage type weighting amongst all base physical damage types present (does not include base elemental damage) then added as a flat bonus after physical mods." — [Focus/Madurai](https://wiki.warframe.com/w/Focus/Madurai?action=raw)
- Example: Dual Ichor (19 I / 11 P / 45 S / 47 Toxin, total 122). Impact = 19 + 122·0.3·0.254, Puncture = 11 + 122·0.3·0.146, Slash = 45 + 122·0.3·0.6, and Toxin is unchanged. "Other physical damage increases (e.g., Jagged Edge) or decreases (e.g., Riven Mods) affect the weighting… It does not change any other factor of the calculation." — [Focus/Madurai](https://wiki.warframe.com/w/Focus/Madurai?action=raw)
- Scope: "Does not work on Warframe abilities but does work on Exalted Weapons. Works on Necramechs." — [Focus/Madurai](https://wiki.warframe.com/w/Focus/Madurai?action=raw)

### Inferences
- For a weapon with only physical damage and no physical mods, this matches ×1.3 on each physical type. With physical mods it is smaller than ×1.3 per type, because the bonus is added rather than multiplied after the mods. With base elemental damage, the physical types gain more than 30% of themselves, because elemental base counts in the 0.3 × total. WD's ×1.3 twice (≈×1.69) overstates it in every case.
- The bonus goes into the physical type values, so it is rounded together with them in the 1/32 step (point 1).

### Gaps
- The wiki does not say whether "base damage" here includes base damage mods (Serration), i.e. whether the flat bonus scales with Serration. The example uses unmodded base. If the bonus is added in the per-type stage before the base damage multiplier, it would scale with Serration. Not confirmed.
- I found no independent forum or Reddit test.
