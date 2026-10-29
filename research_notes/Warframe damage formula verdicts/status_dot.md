# Status effects and damage over time: what the game does (late 2026)

I read every wiki page as raw wikitext (`?action=raw`), fetched on 2026-10-29. Revision metadata came from the wiki API. Calculators compared: wfcalc (our repo), Underframe (UF; its status code is compiled WASM, so its behaviour is unknown), Void-forge (VF) and warframe-damage.com (WD).

Version context: Update 36 (Jade Shadows) reworked Blast, Cold, Gas and Magnetic. Update 33.6 reworked Puncture. Update 27.2 made Slash hit shields and made Toxin bypass them. The current status table and patch history are in [Status_Effect](https://wiki.warframe.com/w/Status_Effect?action=raw).

## 20. DoT tick formula and the "+1"

### Takeaway
The wiki's Damage/Calculation page now includes a +1 in the tick formula. The +1 is added to the sum of damage seeds, before the status coefficient C and the other multipliers. Each seed already includes faction damage once. So wfcalc matches the current wiki and VF/WD do not. The +1 was added by one editor in July/Aug 2026, and the per-element pages still show formulas without it, so confidence is medium.

### Cited Findings
- The formula is `Unrounded Tick Damage = (Σ S_i + 1) × C × M`. The page says: "the temporary damage accumulator for each tick group starts at 1 rather than 0. The full-precision damage seeds are then added to this accumulator before the status coefficient and the remaining applicable multipliers are applied". C is "0.5 for Heat, Electricity, Toxin, and Gas or 0.35 for Slash". M is "the product of the remaining applicable modifiers, such as elemental, faction, and status-damage bonuses". The page also says the +1 "is therefore neither a final flat +1 damage bonus nor a bonus applied once per status stack." — [Damage/Calculation](https://wiki.warframe.com/w/Damage/Calculation?action=raw)
- Worked examples from the same page, quoted exactly:
  - Toxin: "(40 × 1.55 + 1) × 0.5 × 3.25 × 1.55 = 158.68, displayed as 159".
  - Heat (Supra Vandal with Thermite Rounds): "(40 + 1) × 0.5 × 1.6 = 32.8, displayed as 33".
  - Slash: "(40 × 1.55 + 1) × 0.35 × 1.55 = 34.18".
  - Gas: "(40 + 1) × 0.5 = 20.5". Electricity: "(40 + 1) × 0.5 × 2.5 = 51.25". — [Damage/Calculation](https://wiki.warframe.com/w/Damage/Calculation?action=raw)
- How the +1 combines across stacks. Heat stacks and Gas stacks merge into one tick, and so do Electricity pulses that land at the same time. The +1 is then counted once per merged tick. Example: Gas with 9 stacks, "(6 × 80.0195389 + 3 × 40 + 1) × 0.5 = 300.558594". Slash and Toxin stacks tick separately, so "each stack uses its own fixed value of 1". The page also says intermediate DoT maths uses binary32, ticks skip the 1/32 quantisation, and the display rounds with floor(x + 0.5). — [Damage/Calculation](https://wiki.warframe.com/w/Damage/Calculation?action=raw)
- Who added it. User Wxihuann1225 added it on 2026-07-29, with the edit summary "Document fixed +1 status-damage seed bias and examples". Later summaries say "Clarify +1 as the tick-group accumulator's initial value" (2026-07-30) and "Add verified Gas status tick example". Admin Cephalon Scientia edited the same section on 2026-08-24 and left the +1 in. The last edit was 2026-08-31. — [revision API](https://wiki.warframe.com/api.php?action=query&prop=revisions&titles=Damage/Calculation&rvprop=timestamp|user|comment|size&rvlimit=15)
- The per-element pages give formulas with no +1, for example Slash: "0.35 × Modded Base Damage × (1 + Faction) × (1 + Status Damage) × Additional Multipliers". The Heat, Toxin, Gas and Electricity pages read the same way, and so does the Bane example on the Damage_over_Time page. — [Slash](https://wiki.warframe.com/w/Damage/Slash_Damage?action=raw), [Heat](https://wiki.warframe.com/w/Damage/Heat_Damage?action=raw), [Damage_over_Time](https://wiki.warframe.com/w/Damage_over_Time?action=raw)
- Seed definition: "Modded Base Damage = Base Damage × (1 + Base Damage Bonuses) × (1 + Faction Damage Bonuses)". The page says this ignores elemental and physical mods. — [Heat](https://wiki.warframe.com/w/Damage/Heat_Damage?action=raw)

### Inferences
- wfcalc's formula `((seed × faction) + 1) × C × (1 + elemental) × statusDmg × faction` matches the Damage/Calculation formula exactly, including where the +1 goes. VF and WD match the older formulas on the per-element pages, which have no +1. UF is unknown.
- The +1 matters only for small seeds: about 2.5% at seed 40, and well under 0.1% at seeds above 1000. If wfcalc merges Heat or Gas stacks into one tick, it must add the +1 once per tick. For Slash and Toxin it must add it once per stack.

### Gaps
- No official DE source confirms the +1. The wiki edit summary says "verified", but no test method or video is linked.

## 21. Faction bonus applied twice to DoT

### Takeaway
Confirmed: faction damage applies once inside the seed and once more on the tick. All calculators are right. Confidence: high.

### Cited Findings
- "Due to the nature of Faction Damage Bonuses, they are applied once more during the calculation of damaging status effects, even though they already affect the initial hit." The example includes "(1 + Bane of Grineer 0.3)^2". — [Damage_over_Time](https://wiki.warframe.com/w/Damage_over_Time?action=raw)
- "Faction Damage is applied twice, making their effective bonus = (1 + Faction Damage bonus)^2 … +140.25% for the 55% Primed Faction Damage mods." The same wording appears on the Slash, Heat, Toxin, Gas and Electricity pages. — [Toxin](https://wiki.warframe.com/w/Damage/Toxin_Damage?action=raw)
- Heat exception: if the first Heat proc on a target has no faction mod, "Faction Damage Mods … will only apply once". — [Heat](https://wiki.warframe.com/w/Damage/Heat_Damage?action=raw)

### Inferences
- The +1 sits between the two faction factors: (seed × F + 1) × … × F.

### Gaps
- None.

## 22. Puncture (Weakened): duration and effect

### Takeaway
The current wiki gives a 10 s duration, so wfcalc is right and VF/WD's 6 s is outdated. The crit-chance part is right in all three: +5% flat crit chance per stack, up to 5 stacks (+25%), added after mods, and not applied to AoE or abilities. Confidence: medium-high. 10 s is stated in three places on the current wiki, but older and secondary sources say 6 s, and I did not find the patch that changed it.

### Cited Findings
- "The status effect of Puncture damage is Weakened. It lasts 10 seconds and stacks to a maximum of 5 times. Any stacks applied after the 5th will replace the oldest stack". Also: "5% increased Critical Chance per proc up to 25% at max stacks. This is a flat critical chance buff (like Arcane Avenger), but does not apply to Area of Effect damage or Warframe abilities." — [Puncture](https://wiki.warframe.com/w/Damage/Puncture_Damage?action=raw)
- The Status_Effect page says "Reduces any damage dealt by 40% for 10 seconds … This bonus is additive after mods". Its duration table lists "Weakened | 10 seconds". The other DoT statuses in that table are 6 s. — [Status_Effect](https://wiki.warframe.com/w/Status_Effect?action=raw)
- U33.6 patch note: "Increases Critical Chance threshold on enemy by 5% per Stack, to a maximum of 25% at 5 Stacks. This is additive after mods, not before. Does not apply to Abilities or AOE damage." The same patch cut max stacks from 10 to 5. U36 fixed "being able to apply 5 Puncture Stacks to VIP enemies with Overguard, instead of the intended 3". — [Puncture patch history](https://wiki.warframe.com/w/Damage/Puncture_Damage?action=raw)
- Conflicting sources say 6 s. These are the old fandom wiki, the 2020 "Mainline Review" dev-tracker post and older guides, as shown in search snippets. — [devtrackers 2020 review](https://v2.devtrackers.gg/warframe/p/997cad97-2020-s-first-mainline-review-revise-refresh-part-2), [fandom Perpetual Agony](https://warframe.fandom.com/wiki/Perpetual_Agony)

### Inferences
- The 6 s figure is probably the Update 27.2 value. The current wiki has said 10 s consistently on every page I checked.

### Gaps
- I found no patch note that changes Weakened from 6 s to 10 s. The in-game tooltip and the Update 33.6 notes do not state a duration.

## 23. Heat armour strip

### Takeaway
wfcalc and VF match the wiki. WD's flat 50% while any Heat is active is wrong. Confidence: high, though the rule rests on community tests linked from the wiki.

How the strip ramps up and down:
- Ramp-up: 15%, 30%, 40%, 50% at 0.5 s steps after the first proc, reaching 50% at 2 s.
- New procs do not speed up the ramp.
- Ramp-down: after Heat ends, the strip steps 50 → 40 → 30 → 15 → 0, one step every 1.5 s, so it is gone after 6 s.
- Status Duration scales the step time.
- The strip is multiplicative with other armour reduction.

### Cited Findings
- "Every 0.5 seconds after the initial proc, the enemy will have 15%, then 30%, 40%, and finally 50% of its armor stripped. It therefore takes 2 seconds to reach the maximum armor strip. Proccing more Heat status effects within this time frame will not speed up the armor stripping process. After the proc ends, the target will regain armor every 1.5 seconds for 6 seconds. The enemy's armor strip will decrease as follows: 50%, 40%, 30%, 15%, 0%." The tests behind this are linked as imgur albums V2Oc6hl and Zfkv66b. — [Heat](https://wiki.warframe.com/w/Damage/Heat_Damage?action=raw)
- "Status Duration mods will slow down the rate of armor strip … +100% Status Duration will make the amount armor strip ramp up every second … -50% … every 0.25 second". The strip is "multiplicative with other armor reduction sources". — [Heat](https://wiki.warframe.com/w/Damage/Heat_Damage?action=raw)
- Each new Heat proc refreshes the duration of every active Heat stack, and all stacks merge into one tick per second. — [Heat](https://wiki.warframe.com/w/Damage/Heat_Damage?action=raw)

### Inferences
- The wiki text does not say whether the decay steps also scale with Status Duration. Scaling them is the natural reading of "Ramp up and ramp down times for armor strip lengthened" in the Status_Effect duration table. — [Status_Effect](https://wiki.warframe.com/w/Status_Effect?action=raw)

### Gaps
- Test dates are not given for the imgur measurements.

## 24. Cold crit damage bonus

### Takeaway
The crit damage multiplier bonus is +0.10 at 1 stack, +0.05 for each further stack, and +0.50 at 9 stacks. At 10 stacks the enemy is Frozen for 3 s and the total bonus becomes +1.0, not +0.5 + 1.0. When Frozen ends, 3 stacks remain. The bonus is additive with crit-damage mods and applies before crit tier, but not to AoE. Bosses and enemies with Overguard cap at 4 stacks (+0.25).

wfcalc and VF are right, provided their freeze total is +1.0 rather than +1.5. WD is wrong at 1–9 stacks (0.05×n is too low by 0.05). WD's 10-stack value of 0.5 + 0.5 = 1.0 happens to be correct. Confidence: high.

### Cited Findings
- "The target receives +0.1x increased Critical Damage multiplier with 1 stack, and +0.05x per subsequent stack, adding up to +0.50x at 9 stacks. The increase is additive with Critical Damage mods, and applies before critical tier is calculated, but does not apply to Area of Effect damage." — [Cold](https://wiki.warframe.com/w/Damage/Cold_Damage?action=raw)
- "On the 10th stack, enemies become Frozen for 3 seconds, preventing all action, negating shield recharge, and increasing the Critical Damage Multiplier bonus to +1.0x. After the Frozen effects wears off, 3 Cold stacks will remain." The stack table runs +0.10, +0.15 … +0.50 for stacks 1–9, then "10 | Freeze | +1.0x". Also: "Bosses, as well as enemies with active Overguard, can receive a maximum of 4 Cold stacks." — [Cold](https://wiki.warframe.com/w/Damage/Cold_Damage?action=raw)
- Worked example: "1.6x × (1 + 110%) + 0.50x = 3.86x". — [Cold](https://wiki.warframe.com/w/Damage/Cold_Damage?action=raw)
- U36 patch note: "Cold now has a maximum cap of 10 stacks (was 9) … Frozen enemies … receive double Critical Damage". — [Status_Effect patch history](https://wiki.warframe.com/w/Status_Effect?action=raw)
- The Cold stack duration is 6 s, and each stack has its own timer. — [Cold](https://wiki.warframe.com/w/Damage/Cold_Damage?action=raw)

### Inferences
- "Double" in the patch note means double the 9-stack bonus: 0.5 → 1.0.

### Gaps
- None.

## 25. Slash bleed vs shields and armour

### Takeaway
Slash bleed ignores armour, because it deals Cinematic damage, but it does not bypass shields. Since Update 27.2 it damages shields first. VF is right. wfcalc and WD are wrong to apply it to health only. Confidence: high. Nothing I found has changed this since 27.2.

### Cited Findings
- U27.2 note: "Slash Status now does not bypass Shields and instead deals damage over time to Shields. Slash Status still bypasses Armor." — [Slash patch history](https://wiki.warframe.com/w/Damage/Slash_Damage?action=raw), also on [Shield](https://wiki.warframe.com/w/Shield?action=raw) and [Status_Effect](https://wiki.warframe.com/w/Status_Effect?action=raw)
- DE's original 27.2 text, quoted on the Shield page: "Slash Status Effects will now deal damage over time to Shields, Toxin damage remains as-is (bypassing Shields to directly affect enemy Health)." — [Shield](https://wiki.warframe.com/w/Shield?action=raw)
- "Each tick deals Cinematic damage". Also: "enemy armor will have no effect on slash proc damage … buffs/debuffs that increase/decrease enemy armor will also have no effect on slash proc damage." — [Slash](https://wiki.warframe.com/w/Damage/Slash_Damage?action=raw)
- Older community posts from 2018–2019 say bleed bypasses shields. That was the pre-27.2 behaviour and is now outdated. — [Steam discussion](https://steamcommunity.com/app/230410/discussions/0/1733213724901618866)

### Inferences
- Under the Damage 3.0 damage-type tables, bleed on shields takes the Cinematic modifier (neutral) and Magnetic's shield amplification. This is not stated explicitly.

### Gaps
- No page says whether Slash bleed against Overguard is armour-free or treated in some special way.

## 26. Toxin bypasses shields: exceptions

### Takeaway
Toxin, both direct damage and procs, skips normal shields but not Overguard. There are two named exceptions: Treasurers and Hounds. wfcalc's exception list matches the wiki. VF has no exceptions and is wrong for those enemies. Confidence: high.

### Cited Findings
- Toxin "ignores enemy and player Shields, but not Overguard." — [Toxin](https://wiki.warframe.com/w/Damage/Toxin_Damage?action=raw)
- "Some special enemies like Treasurer or Hounds cannot have their shields bypassed with Toxin damage however." — [Damage/Calculation](https://wiki.warframe.com/w/Damage/Calculation?action=raw)
- Treasurer: shields are "impenetrable by methods that would normally bypass shields (such as Toxin damage) … Toxin procs have no effect (dealing 0 damage) while their shields are up." Also "Toxin and True damage do not bypass the Treasurer's shields and deal no damage." — [Treasurer](https://wiki.warframe.com/w/Treasurer?action=raw)
- Hounds: "Their shields cannot be bypassed by Toxin damage or procs". — [Hound](https://wiki.warframe.com/w/Hound?action=raw)

### Inferences
- On a Treasurer, Toxin deals 0 damage while its shields are up, rather than being absorbed by the shield. A calculator should model it as zero, not as shield damage.

### Gaps
- I did not search every enemy page for further exceptions. "Some special enemies like" suggests the list may not be complete.

## 27. Tick timing: first tick and tick count over 6 s

### Takeaway
- Slash, Heat and Toxin: first tick 1 s after the proc, ticks at 1–6 s, 6 ticks.
- Electricity and Gas: first tick at the moment of the proc, ticks at 0–5 s, 6 ticks. Nothing ticks at 6 s.

All Slash, Heat, Toxin, Electricity and Gas DoTs therefore deal 6 ticks at base duration. Confidence: high.

### Cited Findings
- The Damage_over_Time table lists:
  - Slash, Heat and Toxin as "6-seconds | 1-second delay".
  - Electricity and Gas as "6-seconds | No delay, last tick deals no damage".
  - Blast as "1.5-seconds | 1.5-second delay".
- The tick grid there shows Slash, Heat and Toxin ticking at 1s–6s, and Electricity and Gas at 0s–5s. Blast fires once, drawn in the 2 s column. — [Damage_over_Time](https://wiki.warframe.com/w/Damage_over_Time?action=raw)
- Tick count formula: "Total Ticks = ⌊Tick Rate × (Duration − Delay Time)⌋ + 1". Status Duration mods lengthen the DoT and add ticks. — [Damage_over_Time](https://wiki.warframe.com/w/Damage_over_Time?action=raw)
- The per-element pages agree. Slash, Heat and Toxin show ✗ at 0s, ✓ at 1–6s and ✗ at 7s. Electricity and Gas show ✓ at 0–5s and ✗ at 6–7s. — [Slash](https://wiki.warframe.com/w/Damage/Slash_Damage?action=raw), [Gas](https://wiki.warframe.com/w/Damage/Gas_Damage?action=raw), [Electricity](https://wiki.warframe.com/w/Damage/Electricity_Damage?action=raw)
- Viral interaction: "Electricity and Gas procs created at the same time as Viral procs do have the damage of their first tick amplified, despite it occurring immediately." — [Viral](https://wiki.warframe.com/w/Damage/Viral_Damage?action=raw)

### Inferences
- Electricity and Gas do their damage 1 s earlier than the others, which matters for time-to-kill. Total damage at base duration is the same.

### Gaps
- None.

## 28. Gas stack cap

### Takeaway
Gas is capped at 10 stacks, and new stacks replace the oldest. WD is right. wfcalc and VF (uncapped) are wrong. Confidence: high.

### Cited Findings
- "Up to 10 instances of the effect can stack on the same target, with each instance having its own timer. Any instances after the 10th will replace the oldest instance." The radius grows "3-meter … +0.3 meters up to 6 meters in total after 10 stacks". The cloud keeps ticking on enemies in its radius after the host dies. — [Gas](https://wiki.warframe.com/w/Damage/Gas_Damage?action=raw)
- The Damage_over_Time table gives Gas "Max # Stacks: 10". Slash, Heat, Toxin and Electricity are "No limit". — [Damage_over_Time](https://wiki.warframe.com/w/Damage_over_Time?action=raw)
- The Status_Effect table says Gas "Stacks up to 10 times". — [Status_Effect](https://wiki.warframe.com/w/Status_Effect?action=raw)
- Gas ticks are merged: 9 stacks produce one damage number with a single +1. — [Damage/Calculation](https://wiki.warframe.com/w/Damage/Calculation?action=raw)
- Only literal Gas mods buff Gas DoT; Heat and Toxin mods do not. — [Gas](https://wiki.warframe.com/w/Damage/Gas_Damage?action=raw)

### Inferences
- None.

### Gaps
- None.

## Other statuses: Viral, Magnetic, Corrosive, Blast

### Takeaway
Viral, Magnetic and Corrosive are confirmed as stated in the brief. Blast's "30% after 1.5 s" is right for a single stack that expires on its own. It leaves out what happens at 10 stacks or on death, and the wiki pages disagree on parts of that. Confidence: high for Viral, Magnetic and Corrosive; medium for the Blast details.

### Cited Findings
- **Viral.** "+100% for 6 seconds. Subsequent procs add 25% … up to 325% in total after 10 stacks". Formula: Damage × [2 + 0.25 × (n − 1)]. It works on armoured health but not on shields or Overguard. It is applied when each DoT tick lands, not twice. — [Viral](https://wiki.warframe.com/w/Damage/Viral_Damage?action=raw)
- **Magnetic.** It amplifies damage to Shields and Overguard: "+100% … Subsequent procs add 25% … up to 325% … after 10 stacks", with a 6 s duration. It also reduces shield regeneration. When shields or Overguard break, it forces an Electricity proc worth "3% of the target's maximum Shields/Overguard per Magnetic status effect, to a maximum of 30%" over 6 s. Status damage mods and faction mods apply twice to that proc; Serration has no effect. — [Magnetic](https://wiki.warframe.com/w/Damage/Magnetic_Damage?action=raw)
- **Corrosive.** "degrades the armor … by 26% for 8 seconds. Subsequent procs further reduce armor by 6%, culminating in a total armor reduction of 80% at 10 stacks". Emerald Archon Shards add +2 max stacks (+3 if Tauforged), and 14 stacks remove all armour. It is multiplicative with Heat and Corrosive Projection. — [Corrosive](https://wiki.warframe.com/w/Damage/Corrosive_Damage?action=raw)
  - Corrosive lasts 8 s, not 6 s.
- **Blast, single stack.** "Deals 30% of base damage after 1.5 seconds" (Status_Effect). The Blast page formula is 0.3 × Modded Base Damage × (1 + Faction) × (1 + Status Damage) × additional multipliers, so faction counts twice here as well. Status Duration lengthens the 1.5 s fuse. — [Status_Effect](https://wiki.warframe.com/w/Status_Effect?action=raw), [Blast](https://wiki.warframe.com/w/Damage/Blast_Damage?action=raw)
- **Blast, detonation.** Reaching 10 stacks, or the enemy dying, detonates all stacks early. The target takes 10 × 30% = 300% at once. A 5 m AoE also deals "300% weapon base damage per stack (max 3000%) to surrounding enemies", and the initial target is not hit by the AoE. Blast is not a DoT, so it has no +1. Stacks cap at 4 on bosses and Eximus. — [Blast](https://wiki.warframe.com/w/Damage/Blast_Damage?action=raw), [Damage/Calculation](https://wiki.warframe.com/w/Damage/Calculation?action=raw)
- **Blast, where the pages disagree.**
  - Damage/Calculation gives an expiring stack as "max(1, 0.3 × H)", where H is "the damage H of the hit that applied it". It gives the detonation as one combined 5 m radial for "3 × (sum of the active stacks' H)", and says the stacks "are not settled individually". This suggests the target gets no separate 10 × 30%.
  - The Blast page instead bases damage on modded base damage and gives the target 10 hits of 30%. The two versions are not reconciled. — [Damage/Calculation](https://wiki.warframe.com/w/Damage/Calculation?action=raw) vs [Blast](https://wiki.warframe.com/w/Damage/Blast_Damage?action=raw)

### Inferences
- For single-target damage, 30% of the proc seed per stack that expires is the common ground between the pages. The early-detonation rules differ between pages and should be flagged as uncertain.

### Gaps
- I found no official DE number for Blast detonation damage. The U36 notes only say "over 100% of base-inflicted damage for a full (10 stack) explosion". — [Status_Effect patch history](https://wiki.warframe.com/w/Status_Effect?action=raw)
