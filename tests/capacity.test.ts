/**
 * Mod capacity and Forma (src/engine/capacity.ts).
 *
 * Wiki (Mod, Polarity): a mod drains its base drain + rank; a matching polarity halves that
 * (rounded up), a mismatched one adds 25% (rounded up); a Forma turns a slot to the mod's polarity.
 * The test mods drain 4 + rank and are Madurai unless stated otherwise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacityOf } from '../src/engine/capacity.ts';
import type { ModData } from '../src/types.ts';
import { mod, snapshot, weapon } from './builders.ts';

const serration = () => mod('Serration', 10, ['+165% Damage']);
/** Eight different 14-drain Madurai mods, enough to fill every slot. */
const eightMods = (): ModData[] => ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((letter) => mod(`Mod ${letter}`, 10, ['+10% Damage']));

test('a max-rank mod on an unpolarised slot drains base + rank (4 + 10 = 14)', () => {
  const result = capacityOf(snapshot([weapon()], [serration()]), weapon(), ['Serration']);
  assert.deepEqual([result.capacityUsed, result.formaNeeded, result.fits], [14, 0, true]);
});

test('a lower rank drains less (Serration rank 0: 4)', () => {
  assert.equal(capacityOf(snapshot([weapon()], [serration()]), weapon(), [{ name: 'Serration', rank: 0 }]).capacityUsed, 4);
});

test('a matching polarity halves the drain (14 -> 7)', () => {
  const polarised = weapon({}, { polarities: ['madurai'] });
  assert.equal(capacityOf(snapshot([polarised], [serration()]), polarised, ['Serration']).capacityUsed, 7);
});

test('a halved odd drain rounds up (4 + 5 = 9 -> 5)', () => {
  const polarised = weapon({}, { polarities: ['madurai'] });
  const nine = mod('Nine Drain', 5, ['+90% Multishot']);
  assert.equal(capacityOf(snapshot([polarised], [nine]), polarised, ['Nine Drain']).capacityUsed, 5);
});

test('the halved slot reports the mod as halved by polarity', () => {
  const polarised = weapon({}, { polarities: ['madurai'] });
  assert.equal(capacityOf(snapshot([polarised], [serration()]), polarised, ['Serration']).mods[0].halvedByPolarity, true);
});

test('a mismatched polarity adds 25%, rounded up (14 x 1.25 = 17.5 -> 18)', () => {
  // Eight Vazarin slots leave no neutral slot for a Madurai mod.
  const allVazarin = weapon({}, { polarities: Array(8).fill('vazarin') });
  assert.equal(capacityOf(snapshot([allVazarin], [serration()]), allVazarin, ['Serration'], 60).capacityUsed, 18);
});

test('a mod without a polarity pays no mismatch on a polarised slot', () => {
  const allVazarin = weapon({}, { polarities: Array(8).fill('vazarin') });
  const neutral = mod('Neutral Test', 10, ['+10% Damage'], { polarity: null as unknown as string });
  assert.equal(capacityOf(snapshot([allVazarin], [neutral]), allVazarin, ['Neutral Test']).capacityUsed, 14);
});

test('Forma is spent until the build fits: 8 x 14 = 112 needs 8 Forma to reach 8 x 7 = 56', () => {
  const mods = eightMods();
  const result = capacityOf(snapshot([weapon()], mods), weapon(), mods.map((entry) => entry.name));
  assert.deepEqual([result.capacityUsed, result.formaNeeded, result.fits], [56, 8, true]);
});

test('no Forma is spent when the build already fits', () => {
  const mods = eightMods().slice(0, 4);
  const result = capacityOf(snapshot([weapon()], mods), weapon(), mods.map((entry) => entry.name));
  assert.deepEqual([result.capacityUsed, result.formaNeeded], [56, 0]);
});

test('a lower capacity needs more Forma (4 x 14 = 56 into 30: 4 Forma -> 28)', () => {
  const mods = eightMods().slice(0, 4);
  const result = capacityOf(snapshot([weapon()], mods), weapon(), mods.map((entry) => entry.name), 30);
  assert.deepEqual([result.capacityUsed, result.formaNeeded, result.fits], [28, 4, true]);
});

test('a build Forma cannot save reports that it does not fit', () => {
  const neutral = mod('Neutral Test', 10, ['+10% Damage'], { polarity: null as unknown as string });
  const result = capacityOf(snapshot([weapon()], [neutral]), weapon(), ['Neutral Test'], 10);
  assert.deepEqual([result.capacityUsed, result.formaNeeded, result.fits], [14, 0, false]);
});

test('an unknown mod name drains nothing instead of failing', () => {
  assert.equal(capacityOf(snapshot([weapon()], []), weapon(), ['No Such Mod']).capacityUsed, 0);
});
