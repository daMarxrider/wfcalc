import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSnapshot } from '../src/data.ts';
import { resolveBuild, type Build } from '../src/engine/build.ts';
import { ammoBuffUptime, ammoCost, expectedAmmoCost } from '../src/engine/ammo.ts';
import { sustainedPulls } from '../src/engine/dot.ts';

const snapshot = loadSnapshot();
const close = (actual: number, expected: number, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const resolve = (weapon: string, extra: Partial<Build> = {}) => resolveBuild(snapshot, { weapon, mods: [], ...extra });

test('ammo per shot: sources add up to the 75% cap, Energized Munitions multiplies on top (wiki)', () => {
  close(ammoCost(0.5, []), 0.5);
  close(ammoCost(1.2, []), 0.25);
  close(ammoCost(0.75, [0.75]), 0.0625);
  // A magazine of 10 at 50% lasts 20 shots: at 10/s with a 2 s reload, 20 / (2 + 2) = 5 pulls/s.
  close(sustainedPulls({ magazineSize: 10, fireRate: 10, reloadTime: 2, ammo: { efficiency: 0.5, multipliers: [], buffs: [], cost: 0.5 } }), 5);
  close(sustainedPulls({ magazineSize: 10, fireRate: 10, reloadTime: 2, ammo: { efficiency: 0, multipliers: [], buffs: [], cost: 0 } }), 10);
});

test('timed ammo buffs: refreshing ones need a proc in the last window, the others wait it out', () => {
  const buff = { name: 'x', chance: 0.2, seconds: 6, trigger: 'headshot' as const, efficiency: 1 };
  // A headshot every second: 6 tries per window.
  close(ammoBuffUptime({ ...buff, refresh: true }, 1), 1 - 0.8 ** 6);
  close(ammoBuffUptime({ ...buff, refresh: false }, 1), 6 / (6 + 1 / 0.2));
  assert.equal(ammoBuffUptime({ ...buff, refresh: true }, Infinity), 0);
  // Half the time free, half the time at the 20% base cost... of 0.8.
  close(expectedAmmoCost(0.2, [], [{ ...buff, refresh: true }], [0.5]), 0.4);
});

test('Velox: 20% innate, 40% in Protea\'s hands', () => {
  close(resolve('Velox').ammo.efficiency, 0.2);
  close(resolve('Velox', { frame: 'Protea' }).ammo.efficiency, 0.4);
  close(resolve('Velox').sustainedDps / resolve('Velox').burstDps, sustainedPulls(resolve('Velox')) / resolve('Velox').fireRate);
});

test('Lex Trusty Sidearm: +60% with a channeled ability, not in the Incarnon form', () => {
  const lex = (extra: Partial<Build>) => resolve('Lex', { incarnon: ['EVO2:Trusty Sidearm'], stackMode: 'max', ...extra });
  close(lex({}).ammo.efficiency, 0.6);
  close(lex({}).ammo.cost, 0.4);
  assert.equal(lex({ incarnon: ['EVO2:Trusty Sidearm', 'form'] }).ammo.cost, 1);
  assert.equal(lex({ stackMode: 'none' }).ammo.cost, 1);
});

test('a riven\'s Ammo Efficiency counts', () => {
  const riven = { stats: ['crit-chance', 'ammo-efficiency'], values: { 'crit-chance': 100, 'ammo-efficiency': 45 } };
  close(resolve('Lex', { riven }).ammo.efficiency, 0.45, 1e-6);
});

test('Akimbo Slip Shot: Dual Pistols only, and only with the sliding switch', () => {
  const arcanes = ['Akimbo Slip Shot'];
  assert.equal(resolve('Akstiletto Prime', { arcanes, stackMode: 'max' }).ammo.efficiency, 0);
  close(resolve('Akstiletto Prime', { arcanes, stackMode: 'max', conditions: { sliding: true } }).ammo.efficiency, 0.65);
  assert.equal(resolve('Lex', { arcanes, stackMode: 'max', conditions: { sliding: true } }).ammo.efficiency, 0);
});

test('dual pistols are found by type or by name (the data types Akstiletto Prime a Pistol)', async () => {
  const { isDualPistols } = await import('../src/engine/arcanes.ts');
  const duals = ['Akstiletto Prime', 'Twin Rogga', 'Dual Toxocyst', 'Aklex', 'Kuva Twin Stubbas', 'Prisma Twin Gremlins', 'Telos Akbolto', 'Afuris'];
  for (const name of duals) assert.ok(isDualPistols(snapshot.weapons[name]), name);
  for (const name of ['Lex', 'Akuba', 'Atomos', 'Kuva Kraken']) if (snapshot.weapons[name]) assert.ok(!isDualPistols(snapshot.weapons[name]), name);
});

test('Primary Compression: +5.5% Ammo Efficiency per metre of radius lost while aiming', () => {
  // Acceltra: 4 m radius, x0.2 while aiming, 3.2 m lost.
  const acceltra = (conditions: Build['conditions']) => resolve('Acceltra', { arcanes: ['Primary Compression'], conditions });
  close(acceltra({ aiming: true }).ammo.efficiency, 0.055 * 3.2, 1e-9);
  assert.equal(acceltra({}).ammo.efficiency, 0);
});

test('Energized Munitions: 75% on top of the capped sum', () => {
  const lex = resolve('Lex', { incarnon: ['EVO2:Trusty Sidearm'], stackMode: 'max', buffs: ['energized-munitions'] });
  close(lex.ammo.cost, 0.4 * 0.25);
});

test('Infinite Ammo traits and augments become timed buffs, gated on head hits', () => {
  const magnus = resolve('Magnus Prime', { stackMode: 'max' });
  assert.deepEqual(magnus.ammo.buffs.map((buff) => [buff.chance, buff.seconds, buff.trigger]), [[0.04, 4, 'hit']]);
  assert.equal(resolve('Knell', { stackMode: 'max' }).ammo.buffs.length, 0);
  assert.equal(resolve('Knell', { stackMode: 'max', hit: 'head' }).ammo.buffs.length, 1);
  const viper = resolve('Viper', { mods: [{ name: 'Skull Shots', rank: 1 }], stackMode: 'max', hit: 'head' });
  assert.deepEqual(viper.ammo.buffs.map((buff) => [buff.chance, buff.seconds]), [[0.2, 1]]);
});
