/**
 * Weapon-specific mods (Gilded Truth, Scattered Justice, ...): they carry the weapon's name as
 * their class, so a broken fit or a dropped effect line silently leaves them out of every build.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSnapshot, modsForWeapon } from '../src/data.ts';
import { resolveBuild, type ResolvedBuild } from '../src/engine/build.ts';
import { hitEnemy } from '../src/engine/damage.ts';
import { scaleEnemy } from '../src/engine/enemy.ts';
import { DAMAGE_TARGETS, search } from '../src/engine/search.ts';

const snapshot = loadSnapshot();
// every condition on; aiming is a played switch that "max" never assumes (Lasting Purity needs it)
const resolve = (weapon: string, mods: string[], quantize?: boolean) =>
  resolveBuild(snapshot, { weapon, mods, stackMode: 'max', conditions: { aiming: true }, quantize });
const close = (actual: number, expected: number, label: string) =>
  assert.ok(Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected)), `${label}: ${actual} vs ${expected}`);

test('Gilded Truth: +80% fire rate on Burston Prime, more than Speed Trigger, additive with it', () => {
  const base = resolve('Burston Prime', []).fireRate;
  const gilded = resolve('Burston Prime', ['Gilded Truth']);
  const speed = resolve('Burston Prime', ['Speed Trigger']);
  close(gilded.fireRate, base * 1.8, 'Gilded Truth');
  close(speed.fireRate, base * 1.6, 'Speed Trigger');
  close(resolve('Burston Prime', ['Gilded Truth', 'Speed Trigger']).fireRate, base * 2.4, 'both');

  const enemy = scaleEnemy(snapshot, snapshot.enemies['Bombard'], 100);
  const ttk = (build: ResolvedBuild) => hitEnemy(snapshot, build, enemy).timeToKill!;
  assert.ok(ttk(gilded) < ttk(speed), `Gilded Truth ${ttk(gilded)} s should kill faster than Speed Trigger ${ttk(speed)} s`);
  assert.ok(gilded.sustainedDps > speed.sustainedDps);

  const offered = (weapon: string) => modsForWeapon(snapshot, snapshot.weapons[weapon]).some((mod) => mod.name === 'Gilded Truth');
  assert.ok(offered('Burston Prime'));
  assert.equal(offered('Burston'), false, 'Gilded Truth is a Burston Prime augment only');
});

// [weapon, augment, stat, factor over the unmodded value]
const SCALED: Array<[string, string, 'fireRate' | 'multishot' | 'critChance' | 'critMultiplier' | 'statusChance' | 'magazineSize' | 'shotDamage', number]> = [
  ['Hek', 'Scattered Justice', 'multishot', 3],
  ['Grinlok', 'Deadly Sequence', 'critChance', 3],
  ['Glaxion', 'Photon Overcharge', 'critMultiplier', 1.9],
  ['Bronco', 'Dizzying Rounds', 'statusChance', 3],
  ['Sobek', 'Shattering Justice', 'statusChance', 1.9],
  ['Paris Prime', 'Bhisaj-Bal', 'statusChance', 1.9],
  ['Gorgon', 'Metamorphic Magazine', 'magazineSize', 1.9],
  ['Higasa', 'Higasa Serration', 'shotDamage', 5.5],
];

for (const [weapon, augment, stat, factor] of SCALED) {
  test(`${augment} scales ${weapon}'s ${stat} by ${factor}`, () => {
    close(resolve(weapon, [augment])[stat], resolve(weapon, [])[stat] * factor, augment);
  });
}

test('elemental augments add their element: Toxic Blight +100% Toxin on Mire, Damzav-Vati +240% Viral on Akbronco Prime', () => {
  // unquantized: the game rounds each element to 1/32 of the base, which hides the exact +100%
  const mire = resolve('Mire', [], false).damage;
  close(resolve('Mire', ['Toxic Blight'], false).damage.perProjectile.toxin ?? 0, (mire.perProjectile.toxin ?? 0) + mire.projectileTotal, 'Toxic Blight');
  // Viral is a combined element: it needs Cold or Toxin next to it, so check the total instead.
  const bronco = resolve('Akbronco Prime', [], false).damage.projectileTotal;
  close(resolve('Akbronco Prime', ['Damzav-Vati'], false).damage.projectileTotal, bronco * 3.4, 'Damzav-Vati');
});

test('every weapon-specific mod with a damage effect fits its weapon and changes the build', () => {
  const numbers = (build: ResolvedBuild) => JSON.stringify(Object.entries(build).filter(([, value]) => typeof value === 'number').concat([['damage', build.damage.perProjectile as any]]));
  let checked = 0;
  for (const mod of Object.values(snapshot.mods)) {
    if (mod.conclave || mod.classes.length !== 1 || !mod.effects.some((effect) => DAMAGE_TARGETS.has(String(effect.target)))) continue;
    const weapon = snapshot.weapons[mod.classes[0]];
    if (!weapon) continue;
    assert.ok(modsForWeapon(snapshot, weapon).includes(mod), `${mod.name} is not offered on ${weapon.name}`);
    assert.notEqual(numbers(resolve(weapon.name, [mod.name])), numbers(resolve(weapon.name, [])), `${mod.name} does nothing on ${weapon.name}`);
    checked++;
  }
  assert.ok(checked >= 25, `only ${checked} weapon-specific mods checked`);
});

test('the quick search takes an augment where it wins: Scattered Justice on Hek, Deadly Sequence on Grinlok', () => {
  for (const [weapon, augment] of [['Hek', 'Scattered Justice'], ['Grinlok', 'Deadly Sequence']]) {
    const best = search(snapshot, { weapon, enemy: 'Bombard', level: 100, limit: 1 }).builds[0];
    assert.ok(best.mods.some((mod) => mod.name === augment), `${weapon}: ${best.mods.map((mod) => mod.name).join(', ')}`);
  }
});
