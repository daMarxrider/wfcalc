/**
 * Validation harness.
 *
 * Running every damage combination in game is impossible, so this checks the model
 * three ways instead:
 *
 *  1. **Invariants** — properties that must hold for *any* correct implementation,
 *     regardless of the exact numbers: linearity in base damage, monotonicity when
 *     adding a beneficial mod, bounds on armour DR, shares summing to 1, determinism,
 *     no NaN/negatives. Run over the whole dataset, these catch structural bugs.
 *
 *  2. **Cross-checks** — the same build computed two independent ways inside the
 *     engine (per-type path vs total path) must agree.
 *
 *  3. **Golden values** — numbers the wiki states explicitly are asserted in
 *     tests/engine.test.ts; this tool re-checks the ones that depend on live data.
 *
 * Run: node tools/validate.ts [--verbose]
 * Exit code is non-zero when an invariant fails, so it can gate a release.
 */
import { loadSnapshot, modsForWeapon } from '../src/data.ts';
import { resolveBuild, type Build } from '../src/engine/build.ts';
import { armorDamageReduction, scaleEnemy } from '../src/engine/enemy.ts';
import { hitEnemy } from '../src/engine/damage.ts';
import { DAMAGE_TYPES, type WeaponData } from '../src/types.ts';

const verbose = process.argv.includes('--verbose');
const snapshot = loadSnapshot();

interface Failure {
  check: string;
  subject: string;
  detail: string;
}

const failures: Failure[] = [];
const fail = (check: string, subject: string, detail: string): void => {
  failures.push({ check, subject, detail });
  if (verbose) console.log(`  FAIL ${check}: ${subject} — ${detail}`);
};

const finite = (value: number): boolean => Number.isFinite(value);
const resolve = (build: Build) => resolveBuild(snapshot, build);

/** Every weapon, with a couple of representative builds. */
const weapons = Object.values(snapshot.weapons);
const sampleMods = new Map<string, string[]>();
for (const weapon of weapons) {
  const fit = modsForWeapon(snapshot, weapon).filter((mod) => !mod.conclave && mod.effects.length > 0);
  const damageMod = fit.find((mod) => mod.effects.some((effect) => effect.target === 'baseDamage' && effect.element === undefined));
  const elementMod = fit.find((mod) => mod.effects.some((effect) => effect.target === 'element' && effect.element));
  const critMod = fit.find((mod) => mod.effects.some((effect) => effect.target === 'critChance'));
  sampleMods.set(weapon.name, [damageMod?.name, elementMod?.name, critMod?.name].filter((name): name is string => Boolean(name)));
}

// ---------------------------------------------------------------- invariants

console.log(`1. sanity over ${weapons.length} weapons`);
for (const weapon of weapons) {
  let bare;
  try {
    bare = resolve({ weapon: weapon.name, mods: [] });
  } catch (error) {
    fail('resolve', weapon.name, String(error));
    continue;
  }
  const checks: Array<[string, number, boolean]> = [
    ['projectileTotal finite', bare.damage.projectileTotal, finite(bare.damage.projectileTotal)],
    ['projectileTotal positive', bare.damage.projectileTotal, bare.damage.projectileTotal > 0],
    ['critChance finite', bare.critChance, finite(bare.critChance)],
    ['critMultiplier >= 1', bare.critMultiplier, bare.critMultiplier >= 1],
    ['multishot positive', bare.multishot, bare.multishot > 0],
    ['fireRate positive', bare.fireRate, bare.fireRate > 0],
    ['sustainedDps finite', bare.sustainedDps, finite(bare.sustainedDps)],
    ['no negative damage types', 0, Object.values(bare.damage.perProjectile).every((amount) => (amount ?? 0) >= 0)],
  ];
  for (const [check, value, ok] of checks) if (!ok) fail(check, weapon.name, String(value));

  // Shares must sum to 1 when all damage types are counted.
  const shareTotal = bare.elements.reduce((sum, element) => sum + element.share, 0);
  if (bare.damage.projectileTotal > 0 && Math.abs(shareTotal - 1) > 1e-6) {
    fail('shares sum to 1', weapon.name, String(shareTotal));
  }

  // Determinism.
  const again = resolve({ weapon: weapon.name, mods: [] });
  if (Math.abs(again.averageShotDamage - bare.averageShotDamage) > 1e-9) fail('determinism', weapon.name, 'differs between runs');
}

// Every fire mode must carry damage: an empty attack dict in the export must inherit
// the weapon's distribution instead of becoming zero (Haalvu's alt-fire did).
for (const weapon of weapons) {
  const weaponHasDamage = Object.values(weapon.stats).some((value) => typeof value === 'number' && value > 0);
  for (const fireMode of weapon.modes) {
    const modeTotal = DAMAGE_TYPES.reduce((sum, type) => sum + (fireMode.stats[type] ?? 0), 0);
    if (weaponHasDamage && !(modeTotal > 0)) fail('fire mode damage', `${weapon.name} / ${fireMode.name}`, 'zero damage');
  }
}

console.log('2. linearity in base damage');
for (const weapon of weapons) {
  // Doubling every damage type must exactly double the per-projectile damage
  // when no conditional/crit-dependent effect is in play.
  const doubled: WeaponData = { ...weapon, stats: { ...weapon.stats } };
  for (const type of DAMAGE_TYPES) doubled.stats[type] = (weapon.stats[type] ?? 0) * 2;
  const snapshot2 = { ...snapshot, weapons: { ...snapshot.weapons, [weapon.name]: doubled } };
  const one = resolveBuild(snapshot, { weapon: weapon.name, mods: [] });
  const two = resolveBuild(snapshot2, { weapon: weapon.name, mods: [] });
  if (one.damage.projectileTotal <= 0) continue;
  const ratio = two.damage.projectileTotal / one.damage.projectileTotal;
  if (Math.abs(ratio - 2) > 1e-6) fail('linearity', weapon.name, `ratio ${ratio}`);
}

console.log('3. monotonicity');
for (const [weaponName, mods] of sampleMods) {
  const base = resolve({ weapon: weaponName, mods: [] });
  for (const mod of mods) {
    const withMod = resolve({ weapon: weaponName, mods: [mod] });
    // A damage/rElement/crit mod must never lower the average shot.
    // Some "beneficial" mods carry a damage malus (Anemic Agility), so require the mod's
    // net effect on the axis to be positive before demanding monotonicity.
    const effects = snapshot.mods[mod]?.effects ?? [];
    const sum = (target: string) => effects.filter((e) => e.target === target).reduce((total, e) => total + e.value, 0);
    const netPositive =
      sum('baseDamage') > 0 || sum('element') > 0 || sum('critChance') > 0 || sum('critDamage') > 0 || sum('multishot') > 0;
    if (netPositive && withMod.averageShotDamage < base.averageShotDamage - 1e-6) {
      fail('monotonic', `${weaponName} + ${mod}`, `${withMod.averageShotDamage} < ${base.averageShotDamage}`);
    }
  }
  // Enabling a conditional effect must never reduce output either.
  const conditional = Object.values(snapshot.mods).find((mod) =>
    mod.classes.some((c) => snapshot.weapons[weaponName].modClasses.includes(c)) &&
    mod.effects.some((effect) => effect.condition && effect.maxStacks),
  );
  if (conditional) {
    const off = resolve({ weapon: weaponName, mods: [conditional.name] });
    const on = resolve({ weapon: weaponName, mods: [conditional.name], conditions: { onKill: 5 } });
    if (on.averageShotDamage < off.averageShotDamage - 1e-6) {
      fail('monotonic condition', `${weaponName} + ${conditional.name}`, `${on.averageShotDamage} < ${off.averageShotDamage}`);
    }
  }
}

console.log('4. armour and enemy bounds');
const bounds: Array<[string, number, number, number]> = [
  ['no armour', 0, 1, 1e-12],
  ['2700 armour', 2700, 0.1, 1e-9],
  ['above cap', 5400, 300 / 5700 / 1, 1e-9],
];
for (const [label, armor, expectedPass, tolerance] of bounds) {
  const passed = 1 - armorDamageReduction(armor);
  if (Math.abs(passed - expectedPass) > tolerance) fail('armour bound', label, `${passed} != ${expectedPass}`);
}
for (const defense of Object.values(snapshot.enemies).slice(0, 200)) {
  const scaled1 = scaleEnemy(snapshot, defense, 1);
  const scaled2 = scaleEnemy(snapshot, defense, 200);
  if (!finite(scaled1.health) || !finite(scaled2.health)) fail('enemy scaling finite', defense.name, 'NaN health');
  if (scaled2.health < scaled1.health) fail('enemy health monotonic', defense.name, 'health drops with level');
  if (scaled2.armor > 2700) fail('armour clamp', defense.name, String(scaled2.armor));
}

console.log('5. cross-path consistency (per-type sum vs total)');
const grineer = Object.values(snapshot.enemies).find((enemy) => enemy.faction === 'grineer' && enemy.health > 0);
if (grineer) {
  for (const weaponName of Object.keys(snapshot.weapons).slice(0, 120)) {
    const built = resolve({ weapon: weaponName, mods: [] });
    const hit = hitEnemy(snapshot, built, scaleEnemy(snapshot, grineer, 100));
    const summed = hit.breakdown.reduce((sum, entry) => sum + entry.toHealth, 0);
    const diff = Math.abs(summed - hit.damagePerShotHealth / (built.critChance * (built.critMultiplier - 1) + 1) / built.multishot);
    if (diff > 1e-6) fail('breakdown sum', weaponName, `sum ${summed} vs ${hit.damagePerShotHealth}`);
  }
}

console.log('6. DoT never exceeds the direct hit by an absurd factor');
for (const weaponName of Object.keys(snapshot.weapons).slice(0, 200)) {
  const built = resolve({ weapon: weaponName, mods: [] });
  if (!grineer) break;
  const hit = hitEnemy(snapshot, built, scaleEnemy(snapshot, grineer, 100));
  const dotDps = hit.dot.reduce((sum, entry) => sum + entry.dps, 0);
  // A proc does at most ~2x the direct damage per hit in the game's maths.
  const ceiling = hit.totalDps * 10 + 1e-6;
  if (dotDps > ceiling) fail('dot ceiling', weaponName, `${dotDps} > ${ceiling}`);
}

console.log('7. weapon mods have one per-rank line per rank');
const weaponMods = new Set(weapons.flatMap((weapon) => modsForWeapon(snapshot, weapon)));
for (const mod of weaponMods) {
  // One level = only the max-rank description, no per-rank table to check.
  const levels = mod.levels?.length ?? 0;
  if (levels > 1 && levels !== mod.maxRank + 1) fail('rank count', mod.name, `maxRank ${mod.maxRank}, ${levels} levels`);
}

// ------------------------------------------------------------------- report

const byCheck = new Map<string, number>();
for (const failure of failures) byCheck.set(failure.check, (byCheck.get(failure.check) ?? 0) + 1);

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${failures.length} violation(s)`);
if (failures.length) {
  for (const [check, count] of [...byCheck].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${check}`);
    if (!verbose) console.log(`        e.g. ${failures.find((f) => f.check === check)?.subject}: ${failures.find((f) => f.check === check)?.detail}`);
  }
  process.exitCode = 1;
}
