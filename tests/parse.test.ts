/**
 * Mod text parser (src/mods/parse.ts), one claim per test.
 *
 * Inputs are card lines as WFCD and the wiki write them; expected values are read off the card
 * by hand (a "+165%" line is 1.65, a "x1.3" line is +0.3 on top of 1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanStatText,
  isNoise,
  isOutOfScope,
  mapTarget,
  parseModEffects,
  readConditionHeader,
  readNumber,
  splitStatLines,
} from '../src/mods/parse.ts';

/** Parses one card (top rank only) and returns its effects. */
const effectsOf = (...lines: string[]) => parseModEffects([lines]).effects;

// ------------------------------------------------------------------ cleanStatText

test('cleanStatText strips colour tags: "+90% <DT_FIRE_COLOR>Heat" is "+90% Heat"', () => {
  assert.equal(cleanStatText('+90% <DT_FIRE_COLOR>Heat'), '+90% Heat');
});

test('cleanStatText turns a literal backslash-n into a line break', () => {
  assert.equal(cleanStatText('On Kill:\\n+30% Multishot'), 'On Kill:\n+30% Multishot');
});

test('cleanStatText turns non-breaking spaces and runs of spaces into one space', () => {
  assert.equal(cleanStatText('+165%   Damage'), '+165% Damage');
});

test('cleanStatText normalises Windows line endings', () => {
  assert.equal(cleanStatText('On Kill:\r\n+30% Multishot'), 'On Kill:\n+30% Multishot');
});

// ------------------------------------------------------------------ readNumber

test('readNumber reads a percentage: "+165% Damage" is 165 %', () => {
  assert.deepEqual(readNumber('+165% Damage'), { value: 165, unit: '%', rest: 'Damage' });
});

test('readNumber reads a negative percentage: "-55% Accuracy" is -55 %', () => {
  assert.deepEqual(readNumber('-55% Accuracy'), { value: -55, unit: '%', rest: 'Accuracy' });
});

test('readNumber reads a leading multiplier: "x1.55 Damage to Grineer" is 1.55 x', () => {
  assert.deepEqual(readNumber('x1.55 Damage to Grineer'), { value: 1.55, unit: 'x', rest: 'Damage to Grineer' });
});

test('readNumber reads a flat value without a unit: "+1.2 Punch Through"', () => {
  assert.deepEqual(readNumber('+1.2 Punch Through'), { value: 1.2, unit: null, rest: 'Punch Through' });
});

test('readNumber treats seconds as a unit, not a multiplier: "12s Combo Duration" is flat 12', () => {
  assert.deepEqual(readNumber('12s Combo Duration'), { value: 12, unit: null, rest: 'Combo Duration' });
});

test('readNumber treats metres as a unit: "6m Enemy Radar" is flat 6', () => {
  assert.deepEqual(readNumber('6m Enemy Radar'), { value: 6, unit: null, rest: 'Enemy Radar' });
});

test('readNumber accepts a decimal comma: "+2,5% Damage" is 2.5', () => {
  assert.equal(readNumber('+2,5% Damage')?.value, 2.5);
});

test('readNumber returns null for a line without a leading number', () => {
  assert.equal(readNumber('Enemies killed explode'), null);
});

test('readNumber returns null for a bare number with nothing after it', () => {
  assert.equal(readNumber('+165%'), null);
});

// ------------------------------------------------------------------ readConditionHeader

test('condition header: "On Kill:" is onKill', () => {
  assert.equal(readConditionHeader('On Kill:')?.key, 'onKill');
});

test('condition header: "On Melee Kill:" and "On Ability Kill:" count as onKill', () => {
  assert.deepEqual([readConditionHeader('On Melee Kill:')?.key, readConditionHeader('On Ability Kill:')?.key], ['onKill', 'onKill']);
});

test('condition header: "On Headshot Kill:" is the weak-point kill condition', () => {
  assert.equal(readConditionHeader('On Headshot Kill:')?.key, 'onWeakPointKill');
});

test('condition header: "On Weak Point Hit:" and "On Headshot:" are onWeakPointHit', () => {
  assert.deepEqual([readConditionHeader('On Weak Point Hit:')?.key, readConditionHeader('On Headshot:')?.key], ['onWeakPointHit', 'onWeakPointHit']);
});

test('condition header: "On Reload From Empty:" is not the plain onReload condition', () => {
  assert.equal(readConditionHeader('On Reload From Empty:')?.key, 'onReloadEmpty');
});

test('condition header: "When Aiming:" and "While Aiming:" are both aiming', () => {
  assert.deepEqual([readConditionHeader('When Aiming:')?.key, readConditionHeader('While Aiming:')?.key], ['aiming', 'aiming']);
});

test('condition header: "When Sliding:", "While Airborne:" and "On Block:" map to sliding, airborne, blocking', () => {
  assert.deepEqual(
    [readConditionHeader('When Sliding:')?.key, readConditionHeader('While Airborne:')?.key, readConditionHeader('On Block:')?.key],
    ['sliding', 'airborne', 'blocking'],
  );
});

test('condition header: an unknown header keeps a snake_case key instead of being dropped', () => {
  assert.equal(readConditionHeader('On Low Health:')?.key, 'on_low_health');
});

test('condition header: a stat line without a trailing colon is not a header', () => {
  assert.equal(readConditionHeader('+30% Multishot'), null);
});

// ------------------------------------------------------------------ mapTarget

test('mapTarget: "Damage" is the base damage bucket (Serration)', () => {
  assert.equal(mapTarget('Damage')?.target, 'baseDamage');
});

test('mapTarget: "Melee Damage" is base damage too (Pressure Point)', () => {
  assert.equal(mapTarget('Melee Damage')?.target, 'baseDamage');
});

test('mapTarget: "Direct Damage" is its own bucket, not base damage (Galvanized Aptitude)', () => {
  assert.equal(mapTarget('Direct Damage')?.target, 'directDamage');
});

test('mapTarget: "Damage to Grineer" is faction damage, not base damage', () => {
  assert.deepEqual(mapTarget('Damage to Grineer'), { target: 'factionDamage', faction: 'grineer', op: 'add' });
});

test('mapTarget: "Damage to Corrupted" is the Orokin faction', () => {
  assert.equal(mapTarget('Damage to Corrupted')?.faction, 'orokin');
});

test('mapTarget: "Damage to Sentients" is the Sentient faction (plural)', () => {
  assert.equal(mapTarget('Damage to Sentients')?.faction, 'sentient');
});

test('mapTarget: a bare element name is that element ("Heat")', () => {
  assert.deepEqual(mapTarget('Heat'), { target: 'element', element: 'heat', op: 'add' });
});

test('mapTarget: old element spellings map to the current types (Fire, Freeze, Poison, Electric)', () => {
  assert.deepEqual(
    ['Fire', 'Freeze', 'Poison', 'Electric'].map((name) => mapTarget(name)?.element),
    ['heat', 'cold', 'toxin', 'electricity'],
  );
});

test('mapTarget: "Toxin Damage" is the element, not base damage', () => {
  assert.equal(mapTarget('Toxin Damage')?.element, 'toxin');
});

test('mapTarget: a physical type is an element-target too ("Impact")', () => {
  assert.equal(mapTarget('Impact')?.element, 'impact');
});

test('mapTarget: "Critical Chance" and "Critical Damage" are separate targets', () => {
  assert.deepEqual([mapTarget('Critical Chance')?.target, mapTarget('Critical Damage')?.target], ['critChance', 'critDamage']);
});

test('mapTarget: "Attack Speed" is fire rate (melee wording)', () => {
  assert.equal(mapTarget('Attack Speed')?.target, 'fireRate');
});

test('mapTarget: "Ammo Maximum" and "Ammo Capacity" are both ammoMax', () => {
  assert.deepEqual([mapTarget('Ammo Maximum')?.target, mapTarget('Ammo Capacity')?.target], ['ammoMax', 'ammoMax']);
});

test('mapTarget: headshot multiplier, weak-point damage and weak-point crit chance are three targets', () => {
  assert.deepEqual(
    [mapTarget('Headshot Multiplier')?.target, mapTarget('Weak Point Damage')?.target, mapTarget('Weak Point Critical Chance')?.target],
    ['headshotMultiplier', 'weakPointDamage', 'weakPointCritChance'],
  );
});

test('mapTarget: "Damage on first shot in Magazine" is base damage (Primed Chamber)', () => {
  assert.equal(mapTarget('Damage on first shot in Magazine')?.target, 'baseDamage');
});

test('mapTarget: an unnamed "chance to apply on Critical" is a forced Slash proc (Hunter Munitions)', () => {
  assert.deepEqual(mapTarget('chance to apply on Critical'), { target: 'forcedProc', element: 'slash', op: 'add' });
});

test('mapTarget: "chance to apply a Heat Status Effect" is a forced Heat proc', () => {
  assert.equal(mapTarget('chance to apply a Heat Status Effect')?.element, 'heat');
});

test('mapTarget: "of Damage converted into Toxin" is a conversion to Toxin', () => {
  assert.deepEqual(mapTarget('of Damage converted into Toxin'), { target: 'convertedDamage', op: 'convert', convertsTo: 'toxin' });
});

test('mapTarget: the claw augment line converts physical damage to Slash', () => {
  assert.deepEqual(
    mapTarget('Convert all base Physical Damage to Slash Damage'),
    { target: 'convertedPhysical', op: 'convert', convertsTo: 'slash' },
  );
});

test('mapTarget: "Non-Critical damage" is the Cull the Weak bucket', () => {
  assert.equal(mapTarget('Non-Critical damage')?.target, 'nonCritDamage');
});

test('mapTarget: an unknown stat returns null so the mod is flagged partial', () => {
  assert.equal(mapTarget('Shield Gating Duration'), null);
});

// ------------------------------------------------------------------ splitStatLines

test('splitStatLines splits a packed WFCD stat at its line breaks', () => {
  assert.deepEqual(splitStatLines(['On Kill:\n+30% Multishot for 20s. Stacks up to 5x.']), ['On Kill:', '+30% Multishot for 20s. Stacks up to 5x.']);
});

test('splitStatLines splits an inline arcane condition into a header and its stat', () => {
  assert.deepEqual(splitStatLines(['On Weak Point Hit: Gain +300% Damage']), ['On Weak Point Hit:', '+300% Damage']);
});

test('splitStatLines splits "A and B" and gives the shared duration tail to both halves (Primary Blight)', () => {
  assert.deepEqual(
    splitStatLines(['+40% Weapon Recoil and +40% Accuracy for 12s. Stacks up to 40x.']),
    ['+40% Weapon Recoil for 12s. Stacks up to 40x.', '+40% Accuracy for 12s. Stacks up to 40x.'],
  );
});

test('splitStatLines reads "Critical Chance and Damage" as two stats', () => {
  assert.deepEqual(splitStatLines(['+25% Critical Chance and Damage']), ['+25% Critical Chance', '+25% Critical Damage']);
});

test('splitStatLines moves the number first in "Non-Critical hits deal +240% damage"', () => {
  assert.deepEqual(splitStatLines(['Non-Critical hits deal +240% damage']), ['+240% Non-Critical damage']);
});

test('splitStatLines drops the arcane "Gain" verb', () => {
  assert.deepEqual(splitStatLines(['Gain +60% Corrosive Damage']), ['+60% Corrosive Damage']);
});

test('splitStatLines drops the proc chance in front of an arcane buff ("21% chance for")', () => {
  assert.deepEqual(splitStatLines(['21% chance for +45% Critical Chance']), ['+45% Critical Chance']);
});

test('splitStatLines drops empty lines', () => {
  assert.deepEqual(splitStatLines(['+165% Damage\n\n', '']), ['+165% Damage']);
});

// ------------------------------------------------------------------ noise and out of scope

test('a stat that changes damage is neither noise nor out of scope', () => {
  assert.deepEqual([isNoise('+165% Damage'), isOutOfScope('+165% Damage')], [false, false]);
});

test('a slide-attack crit line is out of scope, not noise (Maiming Strike)', () => {
  assert.deepEqual([isNoise('+150% Critical Chance for Slide Attack'), isOutOfScope('+150% Critical Chance for Slide Attack')], [false, true]);
});

test('Internal Bleeding\'s Impact line is an Impact-to-Slash proc chance, not noise', () => {
  assert.deepEqual(
    effectsOf('<DT_IMPACT_COLOR>Impact Status Effects have 35% chance to apply a <DT_SLASH_COLOR>Slash Status Effect (x2 when Fire Rate is below 2.5)'),
    [{ target: 'impactProc', element: 'slash', op: 'add', value: 0.35, raw: '35% Impact procs add a Slash proc' }],
  );
});

test('Magnetic Welt\'s Impact line is an Impact-to-Magnetic proc chance', () => {
  assert.equal(effectsOf('Impact Status Effects have 35% chance to apply a Magnetic Status Effect')[0].element, 'magnetic');
});

test('an on-kill explosion line is noise (Combustion Beam)', () => {
  assert.equal(isNoise('Enemies killed explode, dealing 600 Damage shortly after death.'), true);
});

test('a movement-speed line is out of scope', () => {
  assert.equal(isOutOfScope('+15% Movement Speed'), true);
});

// ------------------------------------------------------------------ parseModEffects

test('parseModEffects: "+165% Damage" is base damage 1.65', () => {
  assert.deepEqual(effectsOf('+165% Damage'), [{ target: 'baseDamage', op: 'add', value: 1.65, raw: '+165% Damage' }]);
});

test('parseModEffects: a multiplier line is the bonus above 1 ("x1.3" is +0.3)', () => {
  const [bane] = effectsOf('x1.3 Damage to Grineer');
  assert.ok(Math.abs(bane.value - 0.3) < 1e-12, String(bane.value));
});

test('parseModEffects: a negative stat keeps its sign (Heavy Caliber accuracy)', () => {
  assert.equal(effectsOf('+165% Damage', '-55% Accuracy')[1].value, -0.55);
});

test('parseModEffects: a flat stat is marked flat and keeps its unit value (+1.2 Punch Through)', () => {
  assert.deepEqual(effectsOf('+1.2 Punch Through')[0], { target: 'punchThrough', op: 'add', value: 1.2, raw: '+1.2 Punch Through', flat: true });
});

test('parseModEffects: the header condition and its stack cap reach the effect below it', () => {
  const [, onKill] = effectsOf('+80% Multishot', 'On Kill:', '+30% Multishot for 20s. Stacks up to 5x.');
  assert.deepEqual([onKill.condition, onKill.maxStacks, onKill.value], ['onKill', 5, 0.3]);
});

test('parseModEffects: a line before the header stays unconditional', () => {
  const [passive] = effectsOf('+80% Multishot', 'On Kill:', '+30% Multishot for 20s. Stacks up to 5x.');
  assert.equal(passive.condition, undefined);
});

test('parseModEffects: a header plus an inline "when Aiming" gates on both (Bladed Rounds)', () => {
  const [bladed] = effectsOf('On Kill:', '+120% Critical Damage when Aiming for 9s');
  assert.equal(bladed.condition, 'onKill+aiming');
});

test('parseModEffects: an inline "when Aiming" without a header is the aiming condition', () => {
  assert.equal(effectsOf('+60% Critical Chance when Aiming')[0].condition, 'aiming');
});

test('parseModEffects: an inline "when Sliding" is the sliding condition', () => {
  assert.equal(effectsOf('+20% Accuracy when Sliding')[0].condition, 'sliding');
});

test('parseModEffects: "Damage on first shot in Magazine" carries the firstShot condition (Primed Chamber)', () => {
  assert.deepEqual(
    [effectsOf('+100% Damage on first shot in Magazine')[0].condition, effectsOf('+100% Damage on first shot in Magazine')[0].value],
    ['firstShot', 1],
  );
});

test('parseModEffects: "per Status Type" marks the effect perStatusType (Condition Overload)', () => {
  assert.equal(effectsOf('+80% Melee Damage per Status Type affecting the target')[0].perStatusType, true);
});

test('parseModEffects: "per Combo Multiplier" marks the effect as combo-scaled (Weeping Wounds)', () => {
  assert.equal(effectsOf('+40% Status Chance per Combo Multiplier')[0].scalesWithCombo, true);
});

test('parseModEffects: "stacks with Combo Multiplier" is combo-scaled too (Blood Rush)', () => {
  assert.equal(effectsOf('+40% Critical Chance stacks with Combo Multiplier')[0].scalesWithCombo, true);
});

test('parseModEffects: "(x2 for Bows)" marks the effect as doubled on bows (Vigilante Fervor)', () => {
  assert.equal(effectsOf('+45% Fire Rate (x2 for Bows)')[0].doublesForBows, true);
});

test('parseModEffects: a "Stacks up to 240%" total cap becomes a stack count (240 / 40 = 6)', () => {
  assert.equal(effectsOf('On Kill:', '+40% Damage for 10s. Stacks up to 240%.')[0].maxStacks, 6);
});

test('parseModEffects: a conversion line keeps a positive share (claw augment)', () => {
  const [conversion] = effectsOf('Convert all base Physical Damage to Slash Damage');
  assert.deepEqual([conversion.op, conversion.convertsTo, conversion.value], ['convert', 'slash', 1]);
});

test('parseModEffects: an unknown stat line is reported as unmatched, not silently dropped', () => {
  assert.deepEqual(parseModEffects([['+30% Shield Gating Duration']]).unmatched, ['+30% Shield Gating Duration']);
});

test('parseModEffects: an out-of-scope line is reported separately from unmatched ones', () => {
  const parsed = parseModEffects([['+150% Critical Chance for Slide Attack']]);
  assert.deepEqual([parsed.outOfScope, parsed.unmatched], [['+150% Critical Chance for Slide Attack'], []]);
});

test('parseModEffects: only the top rank is read; lower ranks do not add effects', () => {
  assert.deepEqual(parseModEffects([['+15% Damage'], ['+30% Damage']]).effects.map((effect) => effect.value), [0.3]);
});

test('parseModEffects: no ranks means no effects and nothing unmatched', () => {
  assert.deepEqual(parseModEffects([]), { effects: [], unmatched: [], outOfScope: [] });
});

test('parseModEffects: a passive repeated under the header counts once and unconditionally (Primary Merciless)', () => {
  // DE writes the max-rank passive "+30% Reload Speed" inside the On Kill block and again on its own.
  const { effects } = parseModEffects([['On Kill:\n+30% Damage for 4s. Stacks up to 12x.\n+30% Reload Speed', '+30% Reload Speed']]);
  const reload = effects.filter((effect) => effect.target === 'reloadSpeed');
  assert.deepEqual(reload.map((effect) => effect.condition), [undefined]);
});

test('parseModEffects: the condition inside the repeated block still gates the damage stat (Primary Merciless)', () => {
  const { effects } = parseModEffects([['On Kill:\n+30% Damage for 4s. Stacks up to 12x.\n+30% Reload Speed', '+30% Reload Speed']]);
  const damage = effects.find((effect) => effect.target === 'baseDamage');
  assert.deepEqual([damage?.condition, damage?.maxStacks], ['onKill', 12]);
});
