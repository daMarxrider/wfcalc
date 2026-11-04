/**
 * Exalted weapons: one per category against the wiki's numbers (wiki.warframe.com, ability pages).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBuild, arcaneSlotsOf } from '../src/engine/build.ts';
import { exaltedInfo, peacemakerDamageShare, peacemakerRateShare } from '../src/engine/exalted.ts';
import { loadSnapshot } from '../src/data.ts';
import { hitEnemy } from '../src/engine/damage.ts';
import { scaleEnemy } from '../src/engine/enemy.ts';

const snapshot = loadSnapshot();
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6 * Math.max(1, expected), `${actual} != ${expected}`);
const shot = (build: Parameters<typeof resolveBuild>[1]) => resolveBuild(snapshot, { quantize: false, ...build });

test('all 33 exalted weapons are in the snapshot, without riven slot; only Regulators take arcanes', () => {
  const exalted = Object.values(snapshot.weapons).filter((weapon) => weapon.exalted);
  assert.equal(exalted.length, 33);
  for (const weapon of exalted) {
    assert.equal(weapon.hasRivenSlot, false, weapon.name);
    if (weapon.exalted?.family === 'Regulators') assert.deepEqual(arcaneSlotsOf(weapon), ['secondary'], weapon.name);
    else assert.deepEqual(arcaneSlotsOf(weapon), [], weapon.name);
  }
});

test('melee: Exalted Blade is 250 damage at 100% Ability Strength and scales linearly with it', () => {
  close(shot({ weapon: 'Exalted Blade', mods: [], abilityStrength: 100 }).shotDamage, 250);
  close(shot({ weapon: 'Exalted Blade', mods: [], abilityStrength: 200 }).shotDamage, 500);
});

test('Chromatic Blade: physical damage becomes the chosen element, status chance x Ability Strength', () => {
  const plain = shot({ weapon: 'Exalted Blade', mods: [], abilityStrength: 150 });
  const chromatic = shot({ weapon: 'Exalted Blade', mods: [], abilityStrength: 150, augments: [{ name: 'Chromatic Blade', rank: 3 }], chromaticElement: 'cold' });
  close(chromatic.shotDamage, 375);
  close(chromatic.damage.perProjectile.cold ?? 0, 375);
  close(chromatic.damage.perProjectile.slash ?? 0, 0);
  // Rank 3: +300% status chance x 1.5 strength, additive with status mods.
  close(chromatic.statusChance, plain.statusChance * (1 + 3 * 1.5));
});

test('secondary: Peacemaker adds +150% x Ability Strength to the 50 base damage, x2.5 when ramped (wiki)', () => {
  close(shot({ weapon: 'Regulators', mods: [], abilityStrength: 100 }).shotDamage, 125 * 2.5);
  // Additive with Hornet Strike (+220%): 50 x (1 + 1.5 + 2.2).
  close(shot({ weapon: 'Regulators', mods: [{ name: 'Hornet Strike' }], abilityStrength: 100 }).shotDamage, 50 * 4.7 * 2.5);
  // The wiki's example: 8th burst, Intensify, Hornet Strike, Convulsion.
  const eighth = 50 * (1 + 1.5 * 8 / 20) * (1 + 1.5 * 1.3 + 2.2) * 1.9;
  const ramped = shot({ weapon: 'Regulators', mods: [{ name: 'Hornet Strike' }, { name: 'Convulsion' }], frameMods: [{ name: 'Intensify' }] }).shotDamage;
  close(ramped * peacemakerDamageShare(7 * 2), eighth);
});

test('Peacemaker ramps from the cast: the first burst +7.5%, full at the 20th; fire rate 25% -> 100% in 3.5 s', () => {
  close(peacemakerDamageShare(0), 1.075 / 2.5);
  close(peacemakerDamageShare(38), 1);
  close(peacemakerDamageShare(500), 1);
  close(peacemakerRateShare(0), 0.25);
  close(peacemakerRateShare(3.5), 1);
  // A short fight is fought mostly unramped: the simulation is far slower than the ramped estimate.
  const regulators = shot({ weapon: 'Regulators', mods: [] });
  const target = scaleEnemy(snapshot, snapshot.enemies['Heavy Gunner'], 30);
  const steady = hitEnemy(snapshot, regulators, target).timeToKill!;
  const fight = hitEnemy(snapshot, regulators, target, { simulate: true }).timeToKill!;
  assert.ok(fight > steady * 1.5, `${fight} vs ${steady}`);
});

test('primary: Artemis Bow fires 7 arrows of 240 at 100% Ability Strength, Concentrated Arrow picks its mode', () => {
  const bow = shot({ weapon: 'Artemis Bow', mods: [], abilityStrength: 100 });
  close(bow.shotDamage, 240 * 7);
  const concentrated = shot({ weapon: 'Artemis Bow', mods: [], augments: [{ name: 'Concentrated Arrow' }] });
  assert.equal(concentrated.mode?.name, 'Concentrated Arrow Charged Shot');
});

test('Rubble Heap adds to Ability Strength for Landslide only', () => {
  const base = shot({ weapon: 'Landslide Fists', mods: [], abilityStrength: 100 }).shotDamage;
  close(shot({ weapon: 'Landslide Fists', mods: [], abilityStrength: 100, augments: [{ name: 'Rubble Heap' }] }).shotDamage, base * 2);
  close(shot({ weapon: 'Exalted Blade', mods: [], abilityStrength: 100, augments: [{ name: 'Rubble Heap' }] }).shotDamage, 250);
});

test('the UI gets each exalted weapon\'s frame and its augments', () => {
  const info = exaltedInfo(snapshot.weapons['Exalted Umbra Blade']);
  assert.equal(info?.frame, 'Excalibur');
  assert.deepEqual(info?.augments.map((augment) => augment.name), ['Chromatic Blade']);
  for (const weapon of Object.values(snapshot.weapons).filter((weapon) => weapon.exalted)) assert.ok(exaltedInfo(weapon), weapon.name);
});
