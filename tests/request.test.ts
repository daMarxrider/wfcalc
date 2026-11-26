/**
 * JSON request -> Build (src/request.ts): the shape the HTTP API, `wfcalc batch` and the Pages
 * worker share. This is a trust boundary, so bad or missing fields must land on safe defaults.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFromJson } from '../src/request.ts';
import { snapshot, weapon } from './builders.ts';

const parse = (body: unknown) => buildFromJson(snapshot([weapon()], []), body, 'Test Weapon');

test('an empty body gives an empty build on the named weapon', () => {
  const build = parse({});
  assert.deepEqual(
    [build.weapon, build.mods, build.arcanes, build.buffs, build.conditions, build.headshot, build.stackMode, build.hit],
    ['Test Weapon', [], [], [], {}, false, undefined, undefined],
  );
});

test('mods that are not a list are ignored, not iterated as characters', () => {
  assert.deepEqual(parse({ mods: 'Serration' }).mods, []);
});

test('mods keep their rank objects', () => {
  assert.deepEqual(parse({ mods: ['Serration', { name: 'Split Chamber', rank: 3 }] }).mods, ['Serration', { name: 'Split Chamber', rank: 3 }]);
});

test('"auto" in the arcane list is a search instruction and is dropped, in any letter case', () => {
  assert.deepEqual(parse({ arcanes: ['AUTO', 'Primary Merciless', 'auto'] }).arcanes, ['Primary Merciless']);
});

test('buff ids are turned into strings', () => {
  assert.deepEqual(parse({ buffs: ['roar', 7] }).buffs, ['roar', '7']);
});

test('the "strength" flag name works as Ability Strength', () => {
  assert.equal(parse({ strength: 200 }).abilityStrength, 200);
});

test('"abilityStrength" wins over "strength" when both are given', () => {
  assert.equal(parse({ abilityStrength: 150, strength: 200 }).abilityStrength, 150);
});

test('element bonus given in percent is stored as a fraction (40 -> 0.4)', () => {
  assert.deepEqual(parse({ elementBonus: { type: 'toxin', value: 40 } }).elementBonus, { type: 'toxin', value: 0.4 });
});

test('element bonus given as a fraction is kept (0.4)', () => {
  assert.deepEqual(parse({ elementBonus: { type: 'toxin', value: 0.4 } }).elementBonus, { type: 'toxin', value: 0.4 });
});

test('element bonus without a value is the 60% maximum', () => {
  assert.deepEqual(parse({ elementBonus: { type: 'heat' } }).elementBonus, { type: 'heat', value: 0.6 });
});

test('element bonus "none" means no bonus element (value 0)', () => {
  assert.equal(parse({ elementBonus: { type: 'none', value: 60 } }).elementBonus?.value, 0);
});

test('an AoE distance of null is "not set", not 0 m', () => {
  assert.equal(parse({ aoeDistance: null }).aoeDistance, undefined);
});

test('an AoE distance of 0 is the blast centre, kept as 0', () => {
  assert.equal(parse({ aoeDistance: 0 }).aoeDistance, 0);
});

test('a zoom of 0 (unscoped) is kept, not dropped', () => {
  assert.equal(parse({ zoom: 0 }).zoom, 0);
});

test('a numeric string combo count becomes a number', () => {
  assert.equal(parse({ comboHits: '40' }).comboHits, 40);
});

test('an unknown hit zone is ignored', () => {
  assert.equal(parse({ hit: 'neck' }).hit, undefined);
});

test('an unknown stack mode is ignored', () => {
  assert.equal(parse({ stackMode: 'turbo' }).stackMode, undefined);
});

test('each known stack mode passes through', () => {
  assert.deepEqual(['none', 'max', 'custom'].map((stackMode) => parse({ stackMode }).stackMode), ['none', 'max', 'custom']);
});

test('an unknown Chromatic Blade element is ignored', () => {
  assert.equal(parse({ chromaticElement: 'plasma' }).chromaticElement, undefined);
});

test('per-source stacks keep numbers and numeric strings and drop the rest', () => {
  assert.deepEqual(parse({ sourceStacks: { A: 3, B: '2', C: 'lots' } }).sourceStacks, { A: 3, B: 2 });
});

test('a per-source stack of 0 is kept: it switches that source off', () => {
  assert.deepEqual(parse({ sourceStacks: { A: 0 } }).sourceStacks, { A: 0 });
});

test('a per-source stack of null or "" is "not set", not 0 stacks', () => {
  assert.deepEqual(parse({ sourceStacks: { A: null, B: '' } }).sourceStacks, {});
});

test('at most five Archon Shards are kept', () => {
  const shards = Array(7).fill({ color: 'crimson', bonus: 'critDamage' });
  assert.equal(parse({ shards }).shards?.length, 5);
});

test('a shard without a colour is dropped; colours are lower-cased and the bonus defaults to "other"', () => {
  assert.deepEqual(parse({ shards: [{ bonus: 'x' }, { color: 'AZURE' }] }).shards, [{ color: 'azure', bonus: 'other', tauforged: false }]);
});

test('Corrosive Projection count becomes an 18% armour strip each (2 -> 36%)', () => {
  assert.deepEqual(parse({ corrosiveProjections: 2 }).debuffs, { armorStrip: 0.36 });
});

test('more than four Corrosive Projections is refused', () => {
  assert.throws(() => parse({ corrosiveProjections: 5 }), /corrosiveProjections expects 0 to 4/);
});

test('a percentage strip above 100% is capped at the whole armour', () => {
  assert.deepEqual(parse({ armorStripPercent: 250 }).debuffs, { armorStrip: 1 });
});

test('a non-numeric percentage strip is refused', () => {
  assert.throws(() => parse({ armorStripPercent: 'half' }), /armorStripPercent expects a percentage/);
});

test('Shattering Impact hits remove 6 base armour each (5 -> 30)', () => {
  assert.deepEqual(parse({ shatteringImpactHits: 5 }).debuffs, { armorStripBaseFlat: 30 });
});

test('explicit debuffs and the resolved strip are merged', () => {
  assert.deepEqual(parse({ debuffs: { viralStacks: 4 }, corrosiveProjections: 1 }).debuffs, { viralStacks: 4, armorStrip: 0.18 });
});
