import test from 'node:test';
import assert from 'node:assert/strict';
import { findWeapon, loadSnapshot } from '../src/data.ts';
import { resolveBuild, type Build } from '../src/engine/build.ts';
import { partSearch } from '../src/engine/part-search.ts';
import { handleApi } from '../src/api.ts';

const snapshot = loadSnapshot();
const close = (actual: number, expected: number, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const resolve = (weapon: string, extra: Partial<Build> = {}) => resolveBuild(snapshot, { weapon, mods: [], ...extra });

test('zaw: (strike + grip + link) x hand multiplier, split by the strike\'s damage types (wiki Module:Modular)', () => {
  const zaw = snapshot.weapons['Balla / Kroostra / Vargeet Jai II'];
  // Balla 224 + Kroostra 14 + Vargeet Jai II -8 = 230, two-handed Balla multiplier 1.
  close(zaw.stats.impact, 11.5);
  close(zaw.stats.puncture, 138);
  close(zaw.stats.slash, 80.5);
  close(zaw.stats.fireRate, 1.1);
  close(zaw.stats.critChance, 0.25);
  close(zaw.stats.statusChance, 0.14);
  assert.equal(zaw.category, 'melee');
});

test('kitgun: damage and fire rate from the chamber per grip, crit/status/magazine from the loader', () => {
  const kitgun = snapshot.weapons['Catchmoon / Gibber / Bashrack'];
  close(kitgun.stats.heat, 119);
  close(kitgun.stats.impact, 41);
  close(kitgun.stats.fireRate, 3.17);
  close(kitgun.stats.critChance, 0.28);
  close(kitgun.stats.critMultiplier, 2.1);
  assert.equal(kitgun.stats.magazineSize, 11);
  close(kitgun.stats.reloadTime, 1.7);
  assert.deepEqual(resolve(kitgun.name).forcedProcs.map((proc) => proc.type), ['impact']);
  assert.equal(snapshot.weapons['Tombfinger / Tremor / Zip'].type, 'Launcher');
});

test('amp: prism shot with the brace, energy pool as magazine, recharge as reload', () => {
  const amp = snapshot.weapons['Raplak Prism / Propa Scaffold / Certus Brace'];
  close(amp.stats.void, 3000);
  close(amp.stats.critChance, 0.38 + 0.2);
  close(amp.stats.magazineSize, 100 / 10);
  close(amp.stats.reloadTime, 2 + 100 / 30);
  assert.deepEqual(amp.modes.map((mode) => mode.name), ['Normal Attack', 'Propa Scaffold']);
  // Clapkra +40 pool, Juttni -1 s delay.
  close(snapshot.weapons['Raplak Prism / Propa Scaffold / Clapkra Brace'].stats.magazineSize, 14);
  close(snapshot.weapons['Raplak Prism / Propa Scaffold / Juttni Brace'].stats.reloadTime, 1 + 100 / 30);
  assert.ok(snapshot.weapons['Mote Amp']);
});

test('combinations are looked up, not listed: weapon lists stay free of ~3,300 entries', () => {
  assert.ok(!Object.keys(snapshot.weapons).includes('Balla / Kroostra / Vargeet Jai II'));
  assert.equal(findWeapon(snapshot, 'Balla/Kroostra/Vargeet Jai II').item?.name, 'Balla / Kroostra / Vargeet Jai II');
});

test('arcane slots: kitguns add a Pax/Residual slot, amps take two amp arcanes plus Operator ones', () => {
  assert.deepEqual(resolve('Catchmoon / Gibber / Bashrack', { arcanes: ['Secondary Merciless', 'Pax Bolt'] }).warnings, []);
  assert.ok(resolve('Catchmoon / Gibber / Bashrack', { arcanes: ['Pax Bolt', 'Residual Boils'] }).warnings.some((line) => /one kitgun arcane/.test(line)));
  assert.ok(resolve('Balla / Kroostra / Vargeet Jai II', { arcanes: ['Pax Bolt'] }).warnings.some((line) => /does not fit/.test(line)));
  const amp = resolve('Raplak Prism / Propa Scaffold / Certus Brace', { arcanes: ['Virtuos Forge', 'Virtuos Strike', 'Magus Melt'], stackMode: 'max' });
  assert.deepEqual(amp.warnings, []);
  // 98% of the Void becomes Heat, and Magus Melt's 7 stacks multiply it by 1 + 7 x 30%.
  const heat = amp.damage.perProjectile.heat ?? 0;
  assert.ok(heat > 3000 * 0.98 * 3.1 * 0.98 && heat < 3000 * 0.98 * 3.1 * 1.02, `heat ${heat}`);
});

test('part search ranks owned parts and picks the amp scaffold by its own alt-fire', () => {
  const result = partSearch(snapshot, {
    kind: 'amp',
    parts: [['Raplak Prism', 'Shwaak Prism'], null, ['Certus Brace', 'Plaga Brace']],
    simulate: false,
    top: 4,
  });
  assert.equal(result.combinations, 4);
  assert.equal(result.results.length, 4);
  const times = result.results.map(({ build }) => build.timeToKill ?? Infinity);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  for (const { parts } of result.results) assert.ok(/ Scaffold$/.test(parts[1]));
});

test('GET /api/modular and POST /api/part-search', async () => {
  const parts = (await handleApi('GET', new URL('http://x/api/modular'), null))!.body as Record<string, string[][]>;
  assert.equal(parts.zaw[0].length, 11);
  const reply = (await handleApi('POST', new URL('http://x/api/part-search'), {
    kind: 'kitgun-secondary', parts: [['Catchmoon'], ['Gibber', 'Haymaker'], ['Bashrack']], top: 1, simulate: false,
  }))!;
  assert.equal(reply.status, 200);
  assert.match((reply.body as any).results[0].weapon, /^Catchmoon \/ (Gibber|Haymaker) \/ Bashrack$/);
  const bad = (await handleApi('POST', new URL('http://x/api/part-search'), { kind: 'sword' }))!;
  assert.equal(bad.status, 400);
});
