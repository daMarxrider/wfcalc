import test from 'node:test';
import assert from 'node:assert/strict';
import { findEnemy, loadSnapshot } from '../src/data.ts';
import { resolveBuild, type Build } from '../src/engine/build.ts';
import { arcaneBuildUp } from '../src/engine/arcanes.ts';
import { hitEnemy } from '../src/engine/damage.ts';
import { scaleEnemy } from '../src/engine/enemy.ts';

const snapshot = loadSnapshot();
const fight = (build: Build, enemy: string, level: number, input = true) =>
  hitEnemy(snapshot, resolveBuild(snapshot, build), scaleEnemy(snapshot, findEnemy(snapshot, enemy).item!, level, {}), { simulate: true, input: input ? build : undefined });

const blight: Build = { weapon: 'Soma Prime', mods: ['Serration', 'Split Chamber', 'Vital Sense', 'Point Strike', 'Infected Clip', 'Hammer Shot'], arcanes: ['Primary Blight'], stackMode: 'max' };

test('build-up sources: trigger, chance and duration at the equipped rank, pinned stacks stay fixed', () => {
  const build: Build = { ...blight, warframeArcanes: [{ name: 'Arcane Acceleration', rank: 0 }] };
  const sources = arcaneBuildUp(snapshot, build, resolveBuild(snapshot, build));
  assert.deepEqual(sources.map((source) => [source.name, source.trigger, source.chance, source.seconds, source.stacks]), [
    ['Primary Blight', { status: 'toxin' }, 1, 12, 40],
    ['Arcane Acceleration', 'crit', 0.3, 9, 1],
  ]);
  const pinned = { ...build, sourceStacks: { 'Primary Blight': 20 } };
  assert.deepEqual(arcaneBuildUp(snapshot, pinned, resolveBuild(snapshot, pinned)).map((source) => source.name), ['Arcane Acceleration']);
});

test('Primary Blight builds up from 0: slower than full stacks from the first shot, faster than none', () => {
  const built = fight(blight, 'Bombard', 150);
  const full = fight(blight, 'Bombard', 150, false).timeToKill!;
  const none = fight({ ...blight, sourceStacks: { 'Primary Blight': 0 } }, 'Bombard', 150).timeToKill!;
  assert.ok(built.timeToKill! > full && built.timeToKill! < none, `${full} < ${built.timeToKill} < ${none}`);
  assert.equal(built.simulation!.arcaneStacks!['Primary Blight'], 40);
});

test('Primary Merciless only decays on one target: a stack per 4 s, gone after 48 s', () => {
  const merciless: Build = { weapon: 'Soma Prime', mods: ['Serration', 'Split Chamber'], arcanes: ['Primary Merciless'], stackMode: 'max' };
  const long = fight(merciless, 'Bombard', 300);
  assert.ok(long.timeToKill! > 48);
  assert.equal(long.simulation!.arcaneStacks!['Primary Merciless'], 0);
  assert.ok(long.timeToKill! > fight(merciless, 'Bombard', 300, false).timeToKill!);
});
