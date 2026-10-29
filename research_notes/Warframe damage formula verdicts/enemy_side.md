# Enemy-side mechanics: armour, faction modifiers, level scaling, Eximus, Overguard, Steel Path

Sources were read as raw wikitext (`?action=raw`) on 2026-10-29, plus the wiki's own enemy-infobox Lua module and its level-slider gadget (the wiki's working calculator). Revision timestamps of the key pages:
- Enemy_Level_Scaling: last edited 2026-07-29 (Wxihuann1225, "Clarify that the 200–2700 armor clamp applies to level-scaled initial armor").
- Armor: the >2700 branch was added 2026-07-29 ("Clarify the original and simplified enemy armor DR formulas and the >2700 fallback").
- Damage/Overview_Table: last edited 2026-10-01.
- Module:Enemies/infobox: last edited 2026-10-08. MediaWiki:Gadget-enemyinfoboxslider.js: last edited 2026-10-07.

The same editor also added exact binary32 evaluation-order details to Enemy_Level_Scaling, which suggests the information was datamined or reverse-engineered rather than guessed. This is an inference, not stated on the page.

Official patch-note text is quoted below from the wiki's Patch History sections, which reproduce DE's notes. I did not fetch forums.warframe.com directly.

## Points 8/9: Armour damage reduction above 2700

### Takeaway
The current wiki says: DR = 0.9·sqrt(armor/2700) up to 2700, and **armor/(armor+300) above 2700**. That matches wfcalc and Void-forge. WD's flat clamp to 2700 is wrong under this source. Both formulas give exactly 90% at 2700, so the curve has no jump there. Confidence: **medium**. It is one recent wiki edit (July 2026) with no patch note behind it, but the editor's other work looks datamined.

### Cited Findings
- "For enemies using the standard NPC armor calculation, damage reduction is calculated as follows when Net Armor is no greater than 2,700: Enemy DR = 90% · sqrt(Net Armor / 2700)" — [Armor (raw)](https://wiki.warframe.com/w/Armor?action=raw)
- "Enemy level scaling normally clamps an enemy's initial armor to between 200 and 2,700. Armor removal can still reduce current armor below 200. If an enemy's Net Armor exceeds 2,700 under an exceptional condition, damage reduction instead uses: Net Armor / (Net Armor + 300)" — [Armor (raw)](https://wiki.warframe.com/w/Armor?action=raw)
- U36 patch note: "Armor has a maximum cap of 2700 Armor (90% Damage Reduction). Armor has a minimum cap of 200 Armor." — [Armor, Patch History (raw)](https://wiki.warframe.com/w/Armor?action=raw)
- "Enemy armor produced by level scaling is hard capped at 2,700 … This minimum cap is only for the initial value of their armor" — [Enemy Level Scaling (raw)](https://wiki.warframe.com/w/Enemy_Level_Scaling?action=raw)
- Wiki revision history: the >2700 branch was added 2026-07-29 by Wxihuann1225, edit summary "Clarify the original and simplified enemy armor DR formulas and the >2700 fallback" — [Armor history API](https://wiki.warframe.com/api.php?action=query&prop=revisions&titles=Armor&rvlimit=40)
- The wiki's own level slider applies `Math.min(armor, 2700)` and `Math.max(armor, 200)` after level scaling, then DR = sqrt(3·armor)/100. That is algebraically the same as 0.9·sqrt(a/2700). The slider has no buff path above 2700. — [Gadget-enemyinfoboxslider.js](https://wiki.warframe.com/w/MediaWiki:Gadget-enemyinfoboxslider.js?action=raw)

### Inferences
- The 2700 cap applies to *level-scaled initial* armour. Buffs applied afterwards can push Net Armor above 2700, and the a/(a+300) fallback then applies. So a calculator that clamps to 2700 (WD) under-reports DR only in buffed cases. A calculator that applies a/(a+300) (wfcalc, Void-forge) matches the wiki.
- The shape is continuous: at a=2700, a/(a+300) = 0.9 = 0.9·sqrt(1).

### Gaps
- No official DE statement on armour above 2700 after U36 was found. Which in-game buffs actually push armour past 2700 is not listed.

## Point 10: Minimum damage per type against armour

### Takeaway
Each damage type has a floor of 1 damage when armour reduces it. This applies only to armour DR. **wfcalc and WD are right. Void-forge (no floor) is wrong.** Confidence: **high**. The statement is explicit and has a worked example.

### Cited Findings
- "When damage is reduced from armor, each damage type has a minimum damage of 1. E.g. a Braton will always do a minimum of 3 damage against an armored target regardless of how high their armor value is, as it has 3 different damage types. Non-Armor sources of damage reduction do not have such a behavior." — [Armor (raw)](https://wiki.warframe.com/w/Armor?action=raw)

### Inferences
- The floor is per damage type, after armour, and only when armour is what reduced the damage. It should not be applied after faction resistance or other DR sources.

### Gaps
- The wiki does not say whether the floor applies before or after the faction ×0.5 resistance on the same type. That ordering is not documented.

## Point 11: Faction damage-type modifier table (Damage 3.0)

### Takeaway
As of U36, each "+" is ×1.5 and each "−" is ×0.5. The wiki's current overview table matches wfcalc and Void-forge for Sentient (Cold+, Radiation+, Corrosive−, **no Magnetic+**) and Scaldra (Impact+, Corrosive+, **Gas−**, not Toxin−). **WD is wrong on both points.** Confidence: **high**. The overview table, Module:DamageTypes/data and each faction's sub-page all agree.

### Cited Findings
- "As of Update 36, Vulnerable + = x1.5 and Resistant − = x0.5 incoming damage multiplier." — [Damage/Overview Table (raw)](https://wiki.warframe.com/w/Damage/Overview_Table?action=raw)
- Full table, parsed from the overview table and cross-checked against the per-damage-type Positives/Negatives lists in [Module:DamageTypes/data (raw)](https://wiki.warframe.com/w/Module:DamageTypes/data?action=raw):

| Faction | ×1.5 (vulnerable) | ×0.5 (resistant) |
|---|---|---|
| Grineer | Impact, Corrosive | — |
| Kuva Grineer | Impact, Corrosive | Heat |
| Corpus | Puncture, Magnetic | — |
| Corpus Amalgam | Electricity, Magnetic | Blast |
| Infested | Slash, Heat | — |
| Infested Deimos | Blast, Gas | Viral |
| Orokin (Corrupted) | Puncture, Viral | Radiation |
| Sentient | Cold, Radiation | Corrosive |
| Narmer | Slash, Toxin | Magnetic |
| The Murmur | Electricity, Radiation | Viral |
| Zariman | Void | — |
| Scaldra | Impact, Corrosive | Gas |
| Techrot | Magnetic, Gas | Cold |
| Anarchs | Impact, Electricity | Radiation |

- Module extract, for example: `Corrosive … Negatives = { "Sentient", "Tenno Shield" }, Positives = { "Grineer", "Kuva Grineer", "Scaldra" }`; `Gas … Negatives = { "Tenno Shield", "Scaldra" }, Positives = { "Infested Deimos", "Techrot" }`; `Magnetic … Negatives = { "Narmer", "Tenno Shield" }, Positives = { "Corpus", "Corpus Amalgam", "Techrot" }`; `Toxin … Positives = { "Narmer" }`, with no Scaldra entry. — [Module:DamageTypes/data](https://wiki.warframe.com/w/Module:DamageTypes/data?action=raw)
- "Sentient receive increased damage from Cold and Radiation, but resist Corrosive." — [Damage/Sentient (raw)](https://wiki.warframe.com/w/Damage/Sentient?action=raw)
- "Scaldra receive increased damage from Impact and Corrosive, but resist Gas." (Introduced U38) — [Damage/Scaldra (raw)](https://wiki.warframe.com/w/Damage/Scaldra?action=raw)
- "Techrot receive increased damage from Magnetic and Gas, but resist Cold." — [Damage/Techrot (raw)](https://wiki.warframe.com/w/Damage/Techrot?action=raw)
- "Anarchs receive increased damage from Impact and Electricity, but resist Radiation." (Introduced U41) — [Damage/Anarchs (raw)](https://wiki.warframe.com/w/Damage/Anarchs?action=raw)
- U36 patch note: "Sentient: Vulnerable to Cold and Radiation, Resistant to Corrosive … Narmer: Vulnerable to Slash and Toxin, Resistant to Magnetic … Zariman: Vulnerable to Void … The Murmur: Vulnerable to Electric and Radiation, Resistant to Viral" — [Damage, Patch History (raw)](https://wiki.warframe.com/w/Damage?action=raw)

### Inferences
- wfcalc should also hold the other 12 rows exactly as in the table above (Kuva Heat−, Amalgam Blast−, Deimos Viral−, Orokin Radiation−, Narmer Magnetic−, Murmur Viral−, Techrot Cold−, Anarchs Radiation−). This should be checked against the repo's table.
- Sentient adaptive resistance is a separate mechanic and is not part of this table.

### Gaps
- Module:DamageTypes/data still contains the deprecated Damage 2.0 health-type entries, marked "Depreciated health/armor types as of U36". They must not be confused with the current faction lists.

## Points 12/13: Techrot health and shield scaling

### Takeaway
The wiki gives Techrot health 1+0.02q^2.12 → 1+15.0998q^0.7 and shields 1+0.02q^1.76 → 1+3.5q^0.76. **wfcalc, Underframe and Void-forge match. WD does not.** Confidence: **medium-high**. The Enemy_Level_Scaling page and the infobox module agree on the high-level curves, and both were edited in 2026. WD's numbers are plausibly pre-buff values: hotfix 38.0.8 raised Techrot health. This is an inference.

### Cited Findings
- "The formula by which Techrot health scales is as follows: f1 = 1 + 0.02(x − Base Level)^2.12 … f2 = 1 + 15.0998(x − Base Level)^0.7" — [Enemy Level Scaling (raw)](https://wiki.warframe.com/w/Enemy_Level_Scaling?action=raw)
- "The formula by which Techrot shields scale is as follows: f1 = 1 + 0.02(x − Base Level)^1.76 … f2 = 1 + 3.5(x − Base Level)^0.76" — [Enemy Level Scaling (raw)](https://wiki.warframe.com/w/Enemy_Level_Scaling?action=raw)
- Module: `["Techrot"] = { f1_coef = 0.02, f1_expo = 2.12, f2_coef = 15.0998, f2_expo = 0.7 }` (health); shields `{ f1_coef = 0.0200, f1_expo = 1.75, f2_coef = 3.5, f2_expo = 0.76 }`. The shield f1 exponent here is 1.75, while the page says 1.76: a minor internal inconsistency. — [Module:Enemies/infobox](https://wiki.warframe.com/w/Module:Enemies/infobox?action=raw)
- Hotfix 38.0.8: "Increased the overall damage and Health of the Techrot faction. In their previous state, the Techrot was easy to mow down in the Steel Path. So we brought them up closer to the Infested and Scaldra factions" — [Techrot (raw)](https://wiki.warframe.com/w/Techrot?action=raw)
- Health and shield transitions use L=70, U=80 on q = Current Level − Base Level. — [Enemy Level Scaling (raw)](https://wiki.warframe.com/w/Enemy_Level_Scaling?action=raw)

### Inferences
- WD's 0.015q^2.1 → 13.64q^0.72 health curve and 3.4106 shield coefficient may predate 38.0.8 or come from another source. Not verified.

### Gaps
- No source found for WD's numbers. The low-level shield exponent for Techrot is either 1.76 (article) or 1.75 (module); the effect is tiny.

## Point 14: Shield curve for Sentient, Murmur and unaffiliated enemies

### Takeaway
The wiki's article and module give 1+0.02q^1.75 → **1+1.6q^0.75** for "Grineer and Sentient". The module also uses 1.6 as the **default** for every faction without its own entry, which includes Murmur, unaffiliated, Scaldra, Narmer and Zariman. **wfcalc, Underframe and Void-forge (1.6) match the wiki. WD's 2q^0.75 matches the wiki's Corrupted/Anarchs curve, not Sentient's.** Confidence: **medium-high** for Sentient (explicit). **Medium** for Murmur and unaffiliated, which follow only from the module default; the article lists no Murmur shield tab.

### Cited Findings
- "The formula by which Grineer and Sentient shields scale is as follows: f1 = 1 + 0.02(x − Base Level)^1.75 … f2 = 1 + 1.6(x − Base Level)^0.75" — [Enemy Level Scaling (raw)](https://wiki.warframe.com/w/Enemy_Level_Scaling?action=raw)
- Module `shield_vals`: `["Default"] = { f1_coef = 0.0200, f1_expo = 1.75, f2_coef = 1.6000, f2_expo = 0.75 }`, and a metatable `__index` that returns the same values for any faction not listed. Listed overrides: Corpus (2.0, 0.76), Corrupted (2.0, 0.75), Techrot (3.5, 0.76), Anarchs (2.0, 0.75). — [Module:Enemies/infobox](https://wiki.warframe.com/w/Module:Enemies/infobox?action=raw)
- "Anarchs, Corrupted: f1 = 1 + 0.02(x − Base Level)^1.75 … f2 = 1 + 2(x − Base Level)^0.75" — [Enemy Level Scaling (raw)](https://wiki.warframe.com/w/Enemy_Level_Scaling?action=raw)

### Inferences
- In the module, the shield table keys Orokin enemies as "Corrupted" but the health table keys them as "Orokin". Depending on the enemy's FactionScaling value, the wiki's own slider may give Orokin enemies the 1.6 default shields. The article is unambiguous that Corrupted shields use 2q^0.75.
- Related, not asked: Murmur, Sentient and unaffiliated *health* on the wiki is 1+0.015q^2 → 1+10.7332q^0.5 (module Default). This may be worth checking in wfcalc.

### Gaps
- There is no explicit wiki text for Murmur shields.

## Point 15: Orokin/Corrupted health and shield curves

### Takeaway
Health is 1+0.015q^2.1 → 1+10.7332q^0.685, and shields are 1+0.02q^1.75 → 1+2q^0.75. **wfcalc matches.** Confidence: **high** for health, where the article and module agree. **Medium-high** for shields, given the module key issue under point 14.

### Cited Findings
- "The formula by which Corrupted health scales is as follows: f1 = 1 + 0.015(x − Base Level)^2.1 … f2 = 1 + 10.7332(x − Base Level)^0.685" (tab "Anarchs, Corrupted") — [Enemy Level Scaling (raw)](https://wiki.warframe.com/w/Enemy_Level_Scaling?action=raw)
- Module `health_vals["Orokin"] = { 0.0150, 2.10, 10.7332, 0.685 }`, with Anarchs set to the same values. — [Module:Enemies/infobox](https://wiki.warframe.com/w/Module:Enemies/infobox?action=raw)
- Corrupted shields: f2 = 1 + 2(x − Base Level)^0.75. — [Enemy Level Scaling (raw)](https://wiki.warframe.com/w/Enemy_Level_Scaling?action=raw)

### Inferences
- The article is inconsistent about Anarchs health. The tab header says "Anarchs, Corrupted", but the text of the next tab says "Murmur, Sentient, Anarchs, and Unaffiliated". The module puts Anarchs with Orokin (2.1 / 0.685).

### Gaps
- Anarchs health scaling is ambiguous on the wiki. The module is more likely to be what the wiki computes.

## Point 16: Eximus health, shields and armour

### Takeaway
The wiki says Eximus **raise the base value**, then apply **their own faction's** curve:
- Health = max(1.1·base, k·(base+900)·step(q)), with k=0.25 if the unit has shields or armour, else 0.375.
- Shields = max(1.1·base, base·step(q)).
- step(q) = 1 (q≤15), 1+0.025(q−15) (≤25), 1.25+0.125(q−25) (≤35), 2.5+(2/15)(q−35) (≤50), 4.5+0.03(q−50) (≤100), 6 (>100), with q = level − base level.

**wfcalc, Underframe and Void-forge match the wiki. WD's "step × neutral curve for every faction" does not.**

On armour, the current wiki gives **no Eximus armour scaling formula**. Its calculator changes Eximus armour only where a specific enemy's data has an explicit EximusArmor base override, for example Entropic Eximus base armour 50. Confidence: **high** for health and shields. **Medium** for armour: the U31.5 dev notes did say Eximus armour would scale differently, but no formula was ever published, and the U36 2700 cap limits the effect at high level.

### Cited Findings
- "Eximus units use the health scaling of their respective factions, but have an additional, separate base health increase. This base health increase is dependent on level." The piecewise formulas follow, with 0.25 "For Eximus units with Shields or Armor" and 0.375 "with No Shields or Armor". — [Enemy Level Scaling (raw)](https://wiki.warframe.com/w/Enemy_Level_Scaling?action=raw)
- "Eximus units use the Shield scaling of their respective factions, but have an additional, separate base Shield increase … Base Shield × 1.1 (x ≤ 15) … max(Base Shield × 1.1, Base Shield × 6) (x > 100)" — [Enemy Level Scaling (raw)](https://wiki.warframe.com/w/Enemy_Level_Scaling?action=raw)
- Wiki slider: `let eximus_health_coef = (base_shield > 0 || base_armor > 0) ? 0.25 : 0.375; let lvl_diff = curr_lvl - this.base_lvl_v; … base_health = Math.max(base_health * 1.1, eximus_health_coef * (base_health + 900) * …)`. The faction health_multi curve is then applied to the raised base. Armour gets no Eximus scaling, only `if (this.eximus_armor_v !== 0) base_armor = this.eximus_armor_v;` (a per-enemy override). — [Gadget-enemyinfoboxslider.js](https://wiki.warframe.com/w/MediaWiki:Gadget-enemyinfoboxslider.js?action=raw)
- "All Entropic Eximus units have a base Armor value of 50, regardless of the standard value for the enemy." — [Eximus (raw)](https://wiki.warframe.com/w/Eximus?action=raw)
- U31.5 dev notes: "Armor will also have a similar method of scaling, by boosting low-armored enemies more than high-armored enemies … For enemies without Armor, they will get additional Health and Shields outside of the regular Eximus scaling to compensate." — [Eximus, Patch History (raw)](https://wiki.warframe.com/w/Eximus?action=raw)
- An image caption on the scaling page, "Showing scaling of Eximus health, shields, and armor between level 1-200", hints that an armour curve existed at some point, but no formula is given. — [Enemy Level Scaling (raw)](https://wiki.warframe.com/w/Enemy_Level_Scaling?action=raw)

### Inferences
- WD's Eximus armour scaling may be based on the U31.5 intent, but there is no published formula and the current wiki does not model it. With a 2700 cap, any such scaling would only matter at low and mid levels.

### Gaps
- No datamined Eximus armour formula was found. In-game behaviour for Eximus armour is unverified.

## Point 17: Eximus Overguard blend variable

### Takeaway
Base Overguard is 12, with curves 1+0.0015q^4 → 1+260q^0.9 and a smoothstep between L=45 and U=50. The article states explicitly that **q = Current Level − 1**, ignoring the enemy's own base level. **wfcalc and Underframe match. Void-forge (q = level) is off by one level.** Confidence: **medium-high**. The article text is explicit, but the wiki's own slider uses level − *base level*, which equals level − 1 only for base-level-1 enemies.

### Cited Findings
- "Overguard ignores the enemy's individual base level and instead uses q = Current Level − 1." — [Enemy Level Scaling (raw)](https://wiki.warframe.com/w/Enemy_Level_Scaling?action=raw)
- "Overguard uses L=45 and U=50 … Let q be the applicable level input defined above. t = clamp(f32(f32(q−L)/f32(U−L)),0,1)" — [Enemy Level Scaling (raw)](https://wiki.warframe.com/w/Enemy_Level_Scaling?action=raw)
- "f1(x) = 1 + 0.0015(x − 1)^4 … f2(x) = 1 + 260(x − 1)^0.9 … All Eximus units have a base Overguard of 12." — [Enemy Level Scaling (raw)](https://wiki.warframe.com/w/Enemy_Level_Scaling?action=raw)
- Wiki slider: `overguard_f1 = coef * Math.pow(curr_lvl - this.base_lvl_v, …)`, with `trans(45, 50, curr_lvl)` computing `(curr_lvl - this.base_lvl_v - start)/(end-start)`, so the slider uses level − base level. — [Gadget-enemyinfoboxslider.js](https://wiki.warframe.com/w/MediaWiki:Gadget-enemyinfoboxslider.js?action=raw)
- "Overguard will scale by level but will be the same amount across all Eximus enemy types." — [Overguard (raw)](https://wiki.warframe.com/w/Overguard?action=raw)

### Inferences
- "The same amount across all Eximus types" supports q = level − 1, which is independent of base level, over level − base level. The slider is probably simplified. Using q = level (Void-forge) is supported by neither.

### Gaps
- No direct DE confirmation was found.

## Points 18/19: Steel Path multipliers and rounding of scaled stats

### Takeaway
Steel Path: +100 levels, and health and shields ×2.5. **Armour is not multiplied**, but the change came in **Update 36**, not U29.10. U36 also fixed shields, which had been effectively ×6.25. The ×2.5 is applied to the base (and after the Eximus base raise) before the level curve, which is the same result multiplicatively.

Rounding: the wiki says the scaled stat is stored as **binary32 float, f32(f32(base) × f32(multiplier))**. It is not rounded or truncated to an integer. Only affinity is floored. The wiki slider's 0.01 rounding and its `Math.floor` on armour are display choices. Confidence: **high** for SP multipliers and the U36 armour change. **Medium** for "no integer rounding", which rests on the wiki's f32 statement alone.

### Cited Findings
- "All enemies have their level increased by 100, and gain an additional +150% (to a total of 250%, or 2.5x) bonus to health and shields." — [The Steel Path (raw)](https://wiki.warframe.com/w/The_Steel_Path?action=raw)
- U36 patch history on The Steel Path: "Steel Path no longer increases Armor values. Steel Path Shields are now multiplied by 2.5x, in place of the previous 6.25x. Steel Path Shields were doubly-applying the multiplier unintentionally." — [The Steel Path (raw)](https://wiki.warframe.com/w/The_Steel_Path?action=raw)
- Older behaviour: the Simulacrum note said "When enabled, enemies will have an additional +250% Health, Armor, and Shields", showing that armour was multiplied before U36. — [The Steel Path (raw)](https://wiki.warframe.com/w/The_Steel_Path?action=raw)
- Exception, still current: "In the Undercroft, enemies have the default Steel Path modifiers of +100 enemy level, 250% Health, Shield and Armor." The source of this line was not checked against U36 and may be stale. — [The Steel Path (raw)](https://wiki.warframe.com/w/The_Steel_Path?action=raw)
- "Current Value = f32(f32(Base Value) × f32(Multiplier)) … f32(z) means that z is evaluated and stored as an IEEE 754 binary32 value." — [Enemy Level Scaling (raw)](https://wiki.warframe.com/w/Enemy_Level_Scaling?action=raw)
- "The base affinity multiplied by the Affinity Multiplier value is also rounded down to a whole number" (affinity only). — [Enemy Level Scaling (raw)](https://wiki.warframe.com/w/Enemy_Level_Scaling?action=raw)
- Wiki slider: SP `base_health * 2.5; base_shield * 2.5` comes after the Eximus raise; armour is untouched; `health = Math.round(base_health*health_multi*100)/100`; `armor = Math.floor(base_armor*armor_multi)`, then clamped to 200–2700. — [Gadget-enemyinfoboxslider.js](https://wiki.warframe.com/w/MediaWiki:Gadget-enemyinfoboxslider.js?action=raw)
- Some enemies also have a per-enemy additive "SteelPathHealthBonus" / "SteelPathShieldBonus" on their base before ×2.5 (module fields). — [Module:Enemies/infobox](https://wiki.warframe.com/w/Module:Enemies/infobox?action=raw)

### Inferences
- A calculator that truncates scaled health, shields or armour to integers differs from the wiki's f32 model by less than 1 point, which is negligible. Flooring armour would only matter at the 200 and 2700 boundaries.
- The "since 29.10" premise is incorrect: armour stopped being multiplied in U36.

### Gaps
- No primary DE statement on integer rounding exists. The Undercroft armour exception is unverified for 2026.
