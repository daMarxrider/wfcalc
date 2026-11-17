import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadSnapshot } from '../src/data.ts';
import { resolveBuild, type Build } from '../src/engine/build.ts';
import { COMBO, NEXT_SHOT, necrophagicVigor, spoolSeconds } from '../src/engine/traits.ts';

const snapshot = loadSnapshot();
const close = (actual: number, expected: number, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const resolve = (weapon: string, extra: Partial<Build> = {}) => resolveBuild(snapshot, { weapon, mods: [], ...extra });

test('every weapon named in the trait tables exists (a typo would silently drop its trait)', () => {
  const source = readFileSync(new URL('../src/engine/traits.ts', import.meta.url), 'utf8');
  const names = new Set([...source.matchAll(/^\s+'([^']+)': (?:always|signature|both|\{ (?:start|trigger|hitsPerStep))/gm), ...source.matchAll(/^\s+([A-Z][A-Za-z]+): (?:always|\{ start)/gm)].map((match) => match[1]));
  for (const match of source.matchAll(/variants\(\[([^\]]+)\]/g)) for (const name of match[1].matchAll(/'([^']+)'/g)) names.add(name[1]);
  for (const name of [...Object.keys(NEXT_SHOT), ...Object.keys(COMBO)]) names.add(name);
  assert.ok(names.size > 40, `found ${names.size} names`);
  for (const name of names) assert.ok(snapshot.weapons[name], `not in the data: ${name}`);
});

test('guaranteed procs of the attack fired: Daikyu Impact, Epitaph Prime Impact + Cold, Hystrix per quill', () => {
  const procs = (weapon: string, extra: Partial<Build> = {}) => resolve(weapon, extra).forcedProcs.map((proc) => `${proc.type}:${proc.chance}`);
  assert.deepEqual(procs('Daikyu'), ['impact:1']);
  assert.deepEqual(procs('Epitaph Prime'), ['impact:1', 'cold:1']);
  assert.deepEqual(procs('Hystrix', { mode: 'Fire Quill' }), ['heat:1']);
  assert.deepEqual(procs('Soma Prime'), []);
});

test('signature bonuses need their Warframe', () => {
  assert.equal(resolve('Epitaph Prime').headshotMultiplierBonus, 0);
  close(resolve('Epitaph Prime', { frame: 'Sevagoth Prime' }).headshotMultiplierBonus, 0.2);
  close(resolve('Tekko Prime', { frame: 'Atlas' }).statusChance - resolve('Tekko Prime').statusChance, 0.06);
  assert.equal(resolve('Knell', { frame: 'Harrow' }).magazineSize, 2);
});

test('Death Knell: +0.5x final crit multiplier and +20% final status per stack, 3 stacks, weak point hits only', () => {
  const head = resolve('Knell', { stackMode: 'max', hit: 'head' });
  const body = resolve('Knell', { stackMode: 'max' });
  close(head.critMultiplier - body.critMultiplier, 1.5);
  close(head.statusChance - body.statusChance, 0.6);
});

test('innate headshot and weak-point traits', () => {
  close(resolve('Cernos Prime').headshotFactor, 1.5);
  close(resolve('Kuva Chakkhurr').headshotMultiplierBonus, 0.5);
  // Stored as the absolute crit chance it adds on weak points: the base crit chance times the bonus.
  close(resolve('Daikyu Prime').weakPointCritChance, 2.5 * snapshot.weapons['Daikyu Prime'].stats.critChance);
  close(resolve('Ax-52', { stackMode: 'max', conditions: { aiming: true } }).weakPointCritChance, 4 * snapshot.weapons['Ax-52'].stats.critChance);
  assert.equal(resolve('Ax-52', { stackMode: 'max' }).weakPointCritChance, 0);
});

test('next-shot traits: Sagek Prime\'s crits set 500% status on 6% of the next shots', () => {
  const sagek = resolve('Sagek Prime');
  const share = 0.06 * Math.min(1, sagek.critChance);
  close(sagek.statusChance, (1 - share) * snapshot.weapons['Sagek Prime'].stats.statusChance + share * 5);
});

test('spool-up: Soma Prime loses (1/0.25 - 1 + 1/0.55 - 1 + 1/0.85 - 1) / 15 s per magazine', () => {
  close(spoolSeconds('Soma Prime', 200, 15), (3 + 1 / 0.55 - 1 + 1 / 0.85 - 1) / 15);
  const soma = resolve('Soma Prime');
  assert.ok(soma.spoolSeconds > 0);
  assert.equal(resolve('Braton Prime').spoolSeconds, 0);
});

test('shell-by-shell reload (wiki): Strun 0.75s + 0.5s per shell, so magazine mods lengthen it', () => {
  for (const name of ['Corinth', 'Felarx', 'Zarr', 'Kuva Zarr', 'Strun', 'Mk1-Strun', 'Strun Prime', 'Strun Wraith']) {
    const build = resolve(name);
    assert.ok(build.shellReload, `${name} reloads by shell`);
    close(build.reloadTime, snapshot.weapons[name].stats.reloadTime!);
  }
  close(resolve('Strun', { mods: [{ name: 'Ammo Stock' }] }).reloadTime, 0.75 + 0.5 * 10);
  close(resolve('Strun', { mods: [{ name: 'Tactical Pump' }] }).reloadTime, 3.75 / 1.6);
  close(resolve('Hek', { mods: [{ name: 'Ammo Stock' }] }).reloadTime, snapshot.weapons.Hek.stats.reloadTime!);
  assert.equal(resolve('Strun', { incarnon: ['form'] }).shellReload, null);
});

test('melee combo exceptions: Venka Prime reaches 13x at 240 hits, Dex Nikana steps every 11 up to 11x', () => {
  assert.equal(resolve('Venka Prime', { comboHits: 240 }).comboMultiplier, 13);
  assert.equal(resolve('Fang Prime', { comboHits: 240 }).comboMultiplier, 12);
  assert.equal(resolve('Dex Nikana', { comboHits: 11 }).comboMultiplier, 2);
  assert.equal(resolve('Dex Nikana', { comboHits: 500 }).comboMultiplier, 11);
});

test('Coda Motovore: physical mods x6, the strongest picks the wheel', () => {
  const plain = resolve('Coda Motovore');
  const slash = resolve('Coda Motovore', { mods: ['Buzz Kill'] });
  const base = snapshot.weapons['Coda Motovore'].stats.slash ?? 0;
  // Buzz Kill: +120% Slash, x6 = +720%.
  assert.ok((slash.damage.perProjectile.slash ?? 0) > base * 7, `${slash.damage.perProjectile.slash} vs ${base}`);
  close(slash.statusChance - plain.statusChance, snapshot.weapons['Coda Motovore'].stats.statusChance, 1e-6);
});

test('Necrophagic Vigor: +20% crit chance and damage per 20 Health drained (half the health), capped at 360%', async () => {
  const { resolveBuild } = await import('../src/engine/build.ts');
  const { loadSnapshot } = await import('../src/data.ts');
  const snap = loadSnapshot();
  const build = (frame: string, mods: Array<{ name: string; rank: number }>) => resolveBuild(snap, { weapon: 'Coda Hema', frame, mods });
  const vigor = [{ name: 'Necrophagic Vigor', rank: 5 }];
  // Ash 455 health: floor(227.5 / 20) = 11 chunks x 20% = +220%.
  assert.ok(Math.abs(build('Ash', vigor).critChance / build('Ash', []).critChance - 3.2) < 1e-9);
  assert.ok(Math.abs(build('Ash', vigor).critMultiplier / build('Ash', []).critMultiplier - 3.2) < 1e-9);
  // 1000 health would be 25 chunks = 500%: capped at 360%.
  assert.ok(Math.abs(necrophagicVigor(5, 1000)[0].value - 3.6) < 1e-9);
});
