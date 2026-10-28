/**
 * Engine tests.
 *
 * Every expected value here is either quoted from the WARFRAME Wiki
 * (Damage/Calculation, Armor, Enemy_Level_Scaling) or derived from the
 * documented formula by hand in the comment above the assertion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { falloffFactor, resolveBuild as resolveQuantized, type Build } from '../src/engine/build.ts';
import { arcaneEffectsAt, arcaneRankScale, enervateCritChance } from '../src/engine/arcanes.ts';
import { armorDamageReduction, eximusBaseHealth, overguardForLevel, scaleEnemy } from '../src/engine/enemy.ts';
import { elementalOrders } from '../src/engine/bruteforce.ts';
import { hitProfile, weakPointBase } from '../src/engine/hit.ts';
import { hitEnemy } from '../src/engine/damage.ts';
import { simulateKill } from '../src/engine/simulate.ts';
import { parseModEffects } from '../src/mods/parse.ts';
import { buffEffects, buffById, abilityStrengthFromMods } from '../src/engine/buffs.ts';
import { rivenEffects } from '../src/engine/riven.ts';
import { enumerateRivens, rivenPicker } from '../src/engine/riven-picker.ts';
import { viralMultiplier, corrosiveArmorMultiplier } from '../src/engine/dot.ts';
import type { AbilityData, ArcaneData, EnemyData, ModData, Snapshot, WeaponData, WeaponStats } from '../src/types.ts';

/**
 * The golden values below pin each formula on its own, before the game's 1/32 quantization
 * rounds the result; quantization has its own tests at the end of this file.
 */
const resolveBuild = (snap: Snapshot, build: Build) => resolveQuantized(snap, { quantize: false, ...build });

const close = (actual: number, expected: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);

function stats(overrides: Partial<WeaponStats> = {}): WeaponStats {
  const base: WeaponStats = {
    impact: 0, puncture: 0, slash: 0, heat: 0, cold: 0, electricity: 0, toxin: 0,
    blast: 0, corrosive: 0, gas: 0, magnetic: 0, radiation: 0, viral: 0, true: 0, void: 0, tau: 0,
    critChance: 0.2, critMultiplier: 2, statusChance: 0.1, fireRate: 2, multishot: 1,
    magazineSize: 10, reloadTime: 1,
  };
  return { ...base, ...overrides };
}

function weapon(overrides: Partial<WeaponStats> = {}): WeaponData {
  return {
    id: 'Test Weapon',
    name: 'Test Weapon',
    category: 'primary',
    type: 'Rifle',
    masteryRank: 0,
    disposition: 1,
    dispositionMultiplier: 1,
    polarities: [],
    exilusPolarity: null,
    modClasses: ['Rifle'],
    stats: stats(overrides),
    modes: [],
    hasRivenSlot: true,
  };
}

/** Builds a ModData whose effects come from the real text parser, so the parser is under test too. */
function mod(name: string, maxRank: number, topRankStats: string[], overrides: Partial<ModData> = {}): ModData {
  const { effects } = parseModEffects([topRankStats]);
  return {
    id: name,
    name,
    category: 'Primary Mod',
    classes: ['Rifle'],
    polarity: 'madurai',
    rarity: 'Rare',
    baseDrain: 4,
    maxRank,
    description: topRankStats.join('\n'),
    effects,
    cardImage: null,
    partial: false,
    outOfScopeLines: [],
    incompatible: [],
    set: null,
    upgradeTypes: [],
    isAugment: false,
    isRiven: false,
    conclave: false,
    ...overrides,
  };
}

function snapshot(
  weapons: WeaponData[],
  mods: ModData[],
  enemies: EnemyData[] = [],
  extras: { abilities?: AbilityData[]; arcanes?: ArcaneData[] } = {},
): Snapshot {
  const byName = <T extends { name: string }>(items: T[]) => Object.fromEntries(items.map((i) => [i.name, i]));
  return {
    version: 1,
    generatedAt: '',
    gameVersion: '',
    weapons: byName(weapons),
    mods: byName(mods),
    arcanes: byName(extras.arcanes ?? []),
    warframes: {},
    // Abilities are keyed by ability name (AbilityData has no `name` field).
    abilities: Object.fromEntries((extras.abilities ?? []).map((a) => [a.ability, a])),
    enemies: byName(enemies),
    // Damage 3.0 (Update 36): one table per faction health class.
    // Grineer: Impact and Corrosive +50. Orokin: Puncture/Viral +50, Radiation -50.
    // Overguard: Void +50 and neutral to everything else.
    modifiers: {
      corrosive: { Grineer: 50 },
      radiation: { Grineer: 0, Orokin: -50 },
      puncture: { Orokin: 50 },
      void: { Overguard: 50 },
    },
    healthTypes: { 'Alloy Armor': 'armor', 'Cloned Flesh': 'health' },
    incarnons: {},
    setBonuses: {
      'Sacrificial Set': {
        set: 'Sacrificial Set', kind: 'amplify', description: 'enhances all equipped mods',
        amplify: { '2': { '*': 0.25 } },
      },
    },
    rivenStats: {
      rifle: { Damage: 1.65, Multishot: 0.9, 'Critical Chance': 1.4999, 'Critical Damage': 1.19997, Zoom: 0.5999 },
      shotgun: { Damage: 1.647 },
      pistol: { Damage: 2.196 },
      archgun: { Damage: 0.999 },
      melee: { Damage: 1.647 },
    },
  };
}

const dummy: EnemyData = {
  id: 'Dummy', name: 'Dummy', faction: 'grineer', healthClass: 'Grineer', kind: 'Grineer', baseLevel: 1,
  health: 1_000_000, shield: 0, armor: 0,
  pools: [{ type: 'Neutral Flesh', category: 'health', amount: 1_000_000 }],
  toxinBypassesShields: true,
};

const bombard: EnemyData = {
  id: 'Bombard', name: 'Bombard', faction: 'grineer', healthClass: 'Grineer', kind: 'Grineer', baseLevel: 1,
  health: 300, shield: 0, armor: 500,
  pools: [
    { type: 'Alloy Armor', category: 'armor', amount: 500 },
    { type: 'Cloned Flesh', category: 'health', amount: 300 },
  ],
  toxinBypassesShields: true,
};

const serration = mod('Serration', 10, ['+165% Damage']);
const heavyCaliber = mod('Heavy Caliber', 10, ['+165% Damage', '-55% Accuracy']);
const hellfire = mod('Hellfire', 5, ['+90% Heat']);
const cryoRounds = mod('Cryo Rounds', 5, ['+90% Cold']);
const infectedClip = mod('Infected Clip', 5, ['+90% Toxin']);
const stormbringer = mod('Stormbringer', 5, ['+90% Electricity']);
const thermite = mod('Thermite Rounds', 5, ['+60% Heat']);
const vitalSense = mod('Vital Sense', 5, ['+120% Critical Damage']);
const splitChamber = mod('Split Chamber', 5, ['+90% Multishot']);
const baneOfGrineer = mod('Bane of Grineer', 5, ['x1.3 Damage to Grineer']);
const galvanizedChamber = mod('Galvanized Chamber', 10, ['+80% Multishot', 'On Kill:', '+30% Multishot for 20s. Stacks up to 5x.']);

function build(snap: Snapshot, mods: string[], extra: Partial<Build> = {}) {
  return resolveBuild(snap, { weapon: 'Test Weapon', mods, ...extra });
}

test('parser reads percentages, elements, multipliers and conditions', () => {
  close(serration.effects[0].value, 1.65);
  assert.equal(serration.effects[0].target, 'baseDamage');
  assert.equal(hellfire.effects[0].element, 'heat');
  close(baneOfGrineer.effects[0].value, 0.3, 1e-9);
  assert.equal(baneOfGrineer.effects[0].faction, 'grineer');
  assert.equal(galvanizedChamber.effects.length, 2);
  assert.equal(galvanizedChamber.effects[1].condition, 'onKill');
  assert.equal(galvanizedChamber.effects[1].maxStacks, 5);
});

test('Serration example from the wiki: 18 base damage at rank 9 becomes 45', () => {
  // Wiki (Serration): "a weapon with a base damage of 18 equipped with a rank 9
  // Serration mod (150%) would have a new base damage of 45: 18 × (1 + 1.5) = 45".
  const snap = snapshot([weapon({ impact: 18 })], [serration]);
  const resolved = build(snap, ['Serration'], { conditions: {} });
  const ranked = resolveBuild(snap, { weapon: 'Test Weapon', mods: [{ name: 'Serration', rank: 9 }] });
  close(resolved.damage.projectileTotal, 18 * 2.65);
  close(ranked.damage.projectileTotal, 45);
});

test('base damage mods stack additively (Serration + Heavy Caliber = +330%)', () => {
  const snap = snapshot([weapon({ impact: 18 })], [serration, heavyCaliber]);
  close(build(snap, ['Serration', 'Heavy Caliber']).damage.projectileTotal, 18 * (1 + 3.3));
});

test('one element adds its share of the total base damage', () => {
  const snap = snapshot([weapon({ impact: 100 })], [hellfire]);
  const resolved = build(snap, ['Hellfire']);
  close(resolved.damage.perProjectile.heat ?? 0, 90);
  close(resolved.damage.projectileTotal, 190);
});

test('two base elements combine into a secondary element', () => {
  const snap = snapshot([weapon({ impact: 100 })], [hellfire, cryoRounds]);
  const resolved = build(snap, ['Hellfire', 'Cryo Rounds']);
  close(resolved.damage.perProjectile.blast ?? 0, 180);
  assert.equal(resolved.damage.perProjectile.heat ?? 0, 0);
  close(resolved.damage.projectileTotal, 280);
});

test('a third element stays on its own', () => {
  const snap = snapshot([weapon({ impact: 100 })], [hellfire, cryoRounds, infectedClip]);
  const resolved = build(snap, ['Hellfire', 'Cryo Rounds', 'Infected Clip']);
  close(resolved.damage.perProjectile.blast ?? 0, 180);
  close(resolved.damage.perProjectile.toxin ?? 0, 90);
});

test('elemental mods combined with damage mods scale off the modded base', () => {
  // Base 100, Serration +165% -> 265 total, Hellfire adds 90% of the 100 base = 90,
  // and that 90 also benefits from the damage bonus: 90 × 2.65.
  const snap = snapshot([weapon({ impact: 100 })], [serration, hellfire]);
  const resolved = build(snap, ['Serration', 'Hellfire']);
  close(resolved.damage.perProjectile.heat ?? 0, 90 * 2.65);
  close(resolved.damage.projectileTotal, 265 + 90 * 2.65);
});

test('melee/physical mods only boost their own damage type share', () => {
  const impactMod = mod('Impact Mod', 5, ['+60% Impact']);
  const snap = snapshot([weapon({ impact: 50, puncture: 50 })], [impactMod]);
  const resolved = build(snap, ['Impact Mod']);
  close(resolved.damage.perProjectile.impact ?? 0, 50 * 1.6);
  close(resolved.damage.perProjectile.puncture ?? 0, 50);
});

test('crit chance and crit damage are multiplicative on the base stat', () => {
  const pistolGambit = mod('Pistol Gambit', 5, ['+120% Critical Chance'], { classes: ['Rifle'] });
  const snap = snapshot([weapon({ impact: 100, critChance: 0.2, critMultiplier: 2 })], [pistolGambit, vitalSense]);
  const resolved = build(snap, ['Pistol Gambit', 'Vital Sense']);
  close(resolved.critChance, 0.2 * 2.2);
  close(resolved.critMultiplier, 2 * 2.2);
});

test('average damage uses the wiki crit expectation 1 + cc × (cd - 1)', () => {
  const snap = snapshot([weapon({ impact: 100, critChance: 0.5, critMultiplier: 2 })], []);
  const resolved = build(snap, []);
  // 100 × (1 + 0.5 × (2 - 1)) = 150
  close(resolved.averageShotDamage, 150);
});

test('multishot multiplies the shot total', () => {
  const snap = snapshot([weapon({ impact: 100 })], [splitChamber]);
  const resolved = build(snap, ['Split Chamber']);
  close(resolved.multishot, 1.9);
  close(resolved.shotDamage, 190);
});

test('galvanized multishot only counts when the on-kill condition has stacks', () => {
  const snap = snapshot([weapon({ impact: 100 })], [galvanizedChamber]);
  close(build(snap, ['Galvanized Chamber']).multishot, 1.8);
  close(build(snap, ['Galvanized Chamber'], { conditions: { onKill: 5 } }).multishot, 1.8 + 0.3 * 5);
});

test('faction mods multiply damage only against that faction', () => {
  const snap = snapshot([weapon({ impact: 100 })], [baneOfGrineer], [bombard]);
  const grineerHit = hitEnemy(snap, build(snap, ['Bane of Grineer']), scaleEnemy(snap, bombard, 1));
  assert.ok(grineerHit.damagePerShotHealth > 0);
});

test('armor damage reduction follows the wiki curve', () => {
  close(armorDamageReduction(2700), 0.9, 1e-9);
  close(armorDamageReduction(300), 0.9 * Math.sqrt(300 / 2700), 1e-9);
  close(armorDamageReduction(0), 0);
  // Above 2700 armor the game switches back to armor / (armor + 300).
  close(armorDamageReduction(5400), 5400 / 5700, 1e-9);
});

test('enemy health scaling follows the documented curves', () => {
  const snap = snapshot([], [], [bombard]);
  // Level 1: no multiplier.
  close(scaleEnemy(snap, bombard, 1).health, 300 * 1, 1e-6);
  // Level 150: q = 149, above the 70..80 transition, so the high-level curve wins:
  // f2 = 1 + 10.7332 × 149^0.72 = 394.87... for Grineer.
  const at150 = scaleEnemy(snap, bombard, 150);
  close(at150.health, 300 * (1 + 10.7332 * Math.pow(149, 0.72)), 1e-5);
  // Armor is clamped to the 200..2700 band at high level.
  close(at150.armor, 2700, 1e-9);
});

test('the faction table decides the element: corrosive beats radiation against a Bombard', () => {
  const radiationMod = mod('Radiation Mod', 5, ['+90% Radiation']);
  const corrosiveMod = mod('Corrosive Mod', 5, ['+90% Corrosive']);
  const snap = snapshot([weapon({ puncture: 100 })], [radiationMod, corrosiveMod], [bombard]);
  const hit = hitEnemy(snap, build(snap, ['Corrosive Mod']), scaleEnemy(snap, bombard, 100));
  const corrosive = hit.breakdown.find((entry) => entry.type === 'corrosive');
  // Damage 3.0: Grineer takes +50% Corrosive and is neutral to Radiation (the Damage 2.0
  // Alloy Armor table gave Radiation +75 and Corrosive nothing).
  close(corrosive?.healthMultiplier ?? 0, (1 + 0.5) * (1 - 0.9 * Math.sqrt(2700 / 2700)), 1e-9);
});

test('toxin bypasses shields when the enemy allows it', () => {
  const shielded: EnemyData = {
    ...bombard,
    shield: 1000,
    pools: [{ type: 'Shield', category: 'shield', amount: 1000 }, ...bombard.pools],
  };
  const toxinMod = mod('Toxin Mod', 5, ['+90% Toxin']);
  const snap = { ...snapshot([weapon({ toxin: 100 })], [toxinMod], [shielded]), healthTypes: { ...{}, 'Shield': 'shield' as const, 'Alloy Armor': 'armor' as const, 'Cloned Flesh': 'health' as const } };
  const hit = hitEnemy(snap, build(snap, ['Toxin Mod']), scaleEnemy(snap, shielded, 1));
  const toxin = hit.breakdown.find((entry) => entry.type === 'toxin');
  close(toxin?.toShield ?? -1, 0);
  assert.ok((toxin?.toHealth ?? 0) > 0);
});

/** Minimal ability entry: one labelled stat, like the wiki infobox gives us. */
function ability(name: string, frame: string, value: number, label = 'value'): AbilityData {
  return {
    ability: name, frame, page: name, kind: 'ability', value,
    segments: [{ label, max: value }], duration: 30, range: 25, subsumable: true,
  };
}

function arcane(name: string, slot: string, maxRank: number, topRankStats: string[]): ArcaneData {
  const { effects } = parseModEffects([topRankStats]);
  return { id: name, name, category: `${slot} Arcane`, rarity: 'Rare', maxRank, description: topRankStats.join(' '), effects, slot };
}

const grineer = bombard;
const corpusEnemy: EnemyData = {
  ...bombard, id: 'Corpus Tech', name: 'Corpus Tech', faction: 'corpus', healthClass: 'Corpus',
  pools: [{ type: 'Cloned Flesh', category: 'health', amount: 300 }],
};

test('faction mods multiply damage only against their faction', () => {
  const snap = snapshot([weapon({ impact: 100 })], [baneOfGrineer], [grineer, corpusEnemy]);
  const resolved = build(snap, ['Bane of Grineer']);
  const vsGrineer = hitEnemy(snap, resolved, scaleEnemy(snap, grineer, 1));
  const vsCorpus = hitEnemy(snap, resolved, scaleEnemy(snap, corpusEnemy, 1));
  close(vsGrineer.factionMultiplier, 1.3);
  close(vsCorpus.factionMultiplier, 1);
});

test('Roar is a faction bonus that applies to every faction and scales with strength', () => {
  const snap = snapshot([weapon({ impact: 100 })], [], [grineer, corpusEnemy], {
    abilities: [ability('Roar', 'Rhino', 50)],
  });
  const at100 = resolveBuild(snap, { weapon: 'Test Weapon', mods: [], buffs: ['roar'] });
  const at200 = resolveBuild(snap, { weapon: 'Test Weapon', mods: [], buffs: ['roar'], abilityStrength: 200 });
  close(at100.factionBonus.all ?? 0, 0.5);
  close(at200.factionBonus.all ?? 0, 1.0);
  // Roar multiplies on top of damage mods, and hits Grineer and Corpus alike.
  const hit = hitEnemy(snap, at100, scaleEnemy(snap, corpusEnemy, 1));
  close(hit.factionMultiplier, 1.5);
});

test('Eclipse is its own multiplier on top of Serration, status ticks included', () => {
  const snap = snapshot([weapon({ impact: 250 })], [serration], [], {
    abilities: [ability('Eclipse', 'Mirage', 200, 'damage bonus')],
  });
  const plain = resolveBuild(snap, { weapon: 'Test Weapon', mods: ['Serration'] });
  const resolved = resolveBuild(snap, { weapon: 'Test Weapon', mods: ['Serration'], buffs: ['eclipse'], abilityStrength: 130 });
  // Wiki (Eclipse): 250 base, maxed Serration and Intensify -> 250 x 2.65 x (1 + 2 x 1.3) = 2,385.
  close(resolved.damage.projectileTotal, 2385);
  // Wiki (Damage over Time): total multipliers such as Eclipse carry into status ticks.
  close(resolved.dotSeed, plain.dotSeed * 3.6);
});

test('per-status-type damage adds to Serration on most weapons and multiplies on the wiki\'s list', () => {
  const galvanizedAptitude = mod('Galvanized Aptitude', 10, [
    '+80% Status Chance', 'On Kill:', '+40% Direct Damage per Status Type affecting the target for 20s. Stacks up to 2x.',
  ]);
  const adding = weapon({ impact: 100 });
  const multiplying: WeaponData = { ...adding, id: 'Hema', name: 'Hema' };
  const snap = snapshot([adding, multiplying], [serration, galvanizedAptitude], [], {
    abilities: [ability('Eclipse', 'Mirage', 200, 'damage bonus')],
  });
  const conditions = { onKill: 2, statusTypes: 2 };
  const mods = ['Serration', 'Galvanized Aptitude'];
  // Adding (wiki: Condition Overload (Mechanic)): 100 x (1 + 1.65 + 1.6).
  close(resolveBuild(snap, { weapon: 'Test Weapon', mods, conditions }).damage.projectileTotal, 425);
  // Multiplying (Hema's Normal Attack is on the list): 100 x 2.65 x 2.6.
  close(resolveBuild(snap, { weapon: 'Hema', mods, conditions }).damage.projectileTotal, 689);
  // Adding skips final multipliers: Eclipse x3 scales 100 x 2.65 only, the +160% stays 160.
  close(resolveBuild(snap, { weapon: 'Test Weapon', mods, conditions, buffs: ['eclipse'] }).damage.projectileTotal, 100 * 2.65 * 3 + 160);
});

test('elemental infusions add their damage type proportionally to base damage', () => {
  const snap = snapshot([weapon({ impact: 100 })], [], [], {
    abilities: [ability("Xata's Whisper", 'Xaku', 26), ability('Shock Trooper', 'Volt', 100, 'damage')],
  });
  const voidResolved = resolveBuild(snap, { weapon: 'Test Weapon', mods: [], buffs: ['xatas-whisper'] });
  close(voidResolved.damage.perProjectile.void ?? 0, 26);

  const electricResolved = resolveBuild(snap, { weapon: 'Test Weapon', mods: [], buffs: ['shock-trooper'] });
  close(electricResolved.damage.perProjectile.electricity ?? 0, 100);
});

test('Toxic Lash adds Toxin that participates in elemental combination', () => {
  const snap = snapshot([weapon({ impact: 100 })], [cryoRounds], [], {
    abilities: [ability('Toxic Lash', 'Saryn', 30, 'added gun damage')],
  });
  const resolved = resolveBuild(snap, { weapon: 'Test Weapon', mods: ['Cryo Rounds'], buffs: ['toxic-lash'] });
  // Cold 90 + Toxin 30 combine into Viral 120.
  close(resolved.damage.perProjectile.viral ?? 0, 120);
  close(resolved.damage.perProjectile.toxin ?? 0, 0);
});

test('Accelerant multiplies only Heat damage', () => {
  const snap = snapshot([weapon({ heat: 100, slash: 100 })], [], [], {
    abilities: [ability('Accelerant', 'Ember', 2.5, 'damage multiplier')],
  });
  const resolved = resolveBuild(snap, { weapon: 'Test Weapon', mods: [], buffs: ['accelerant'] });
  close(resolved.damage.perProjectile.heat ?? 0, 250);
  close(resolved.damage.perProjectile.slash ?? 0, 100);
});

test('Sonar raises the weak-point multiplier', () => {
  const snap = snapshot([weapon({ impact: 100 })], [], [], {
    abilities: [ability('Sonar', 'Banshee', 5), ability('Eclipse', 'Mirage', 0, 'damage bonus')],
  });
  const withoutBuff = resolveBuild(snap, { weapon: 'Test Weapon', mods: [], headshot: true });
  const withSonar = resolveBuild(snap, { weapon: 'Test Weapon', mods: [], headshot: true, buffs: ['sonar'] });
  // Head weak point x3 (wiki: Enemy Body Parts); head crits double the crit multiplier:
  // 1 + 0.2 x (2 x 2 - 1) = 1.6 -> 100 x 3 x 1.6 = 480.
  close(withoutBuff.averageShotDamage, 480);
  // Sonar replaces the x3 weak-point multiplier with x5: 100 x 5 x 1.6 = 800.
  close(withSonar.averageShotDamage, 800);
});

test('weapon arcanes apply with their stack condition', () => {
  const merciless = arcane('Primary Merciless', 'primary', 5, ['On Kill:', '+30% Damage for 4s. Stacks up to 12x.']);
  const snap = snapshot([weapon({ impact: 100 })], [], [], { arcanes: [merciless] });
  const idle = resolveBuild(snap, { weapon: 'Test Weapon', mods: [], arcanes: ['Primary Merciless'] });
  const stacked = resolveBuild(snap, {
    weapon: 'Test Weapon', mods: [], arcanes: ['Primary Merciless'], conditions: { onKill: 5 },
  });
  close(idle.damage.projectileTotal, 100);
  close(stacked.damage.projectileTotal, 100 * (1 + 0.3 * 5));
});

test('an on-status arcane (Cascadia Flare) only counts when the build procs that status', () => {
  const flare = arcane('Cascadia Flare', 'primary', 5, ['On Heat Status Effect:', '+12% Damage for 10s. Stacks up to 480%.']);
  const noHeat = snapshot([weapon({ impact: 100, statusChance: 0.2 })], [], [], { arcanes: [flare] });
  const heat = snapshot([weapon({ heat: 100, statusChance: 0.2 })], [], [], { arcanes: [flare] });
  const build: Build = { weapon: 'Test Weapon', mods: [], arcanes: ['Cascadia Flare'], stackMode: 'max' };
  close(resolveBuild(noHeat, build).damage.projectileTotal, 100);
  close(resolveBuild(heat, build).damage.projectileTotal, 100 * (1 + 0.12 * 40));
  // A stack count the player sets is kept: Heat from abilities or other weapons feeds it too.
  close(resolveBuild(noHeat, { ...build, sourceStacks: { 'Cascadia Flare': 10 } }).damage.projectileTotal, 100 * (1 + 0.12 * 10));
});

test('Secondary Enervate averages its crit chance over the reset cycle', () => {
  const enervate: ArcaneData = {
    id: 'Secondary Enervate', name: 'Secondary Enervate', category: 'Secondary Arcane', rarity: 'Rare', maxRank: 5,
    description: 'On Hit: Increase Critical Chance by 10%. Resets after 6 Big Critical Hit.', effects: [], slot: 'secondary',
  };
  // From 200% every shot is a big crit: bonuses 0..50% over six shots, +25% (wiki: AFCC = 25 + x).
  close(enervateCritChance(2.5, 6), 2.75);
  // At 195% the first shot is big 95% of the time: E[sum]/E[shots] = (6.05 x 1.95 + 1.53) / 6.05.
  // The wiki's fit (35 + 0.95x = 220.25%) averages per-cycle means, which is not the per-shot average.
  close(enervateCritChance(1.95, 6), 1.95 + 1.53 / 6.05);
  const snap = snapshot([weapon({ impact: 100, critChance: 2.5 })], [], [], { arcanes: [enervate] });
  close(resolveBuild(snap, { weapon: 'Test Weapon', mods: [], arcanes: ['Secondary Enervate'] }).critChance, 2.75);
  close(resolveBuild(snap, { weapon: 'Test Weapon', mods: [], arcanes: [{ name: 'Secondary Enervate', rank: 0 }] }).critChance, 2.5);

  // Projectile multishot is one hit per pellet: 3 pellets give 0, 30 ... 150% over six shots, +75%.
  // Hitscan and shotgun-sidearm pellets are one hit; and at most 30 triggers a second.
  const projectile = (extra: Partial<WeaponData> = {}, fireRate = 1): WeaponData => {
    const base = weapon({ impact: 100, critChance: 2.5, multishot: 3, fireRate });
    return { ...base, ...extra, modes: [{ name: 'Normal Attack', stats: base.stats, trigger: 'Projectile' }] };
  };
  const enervateOn = (w: WeaponData) => resolveBuild(snapshot([w], [], [], { arcanes: [enervate] }), { weapon: 'Test Weapon', mods: [], arcanes: ['Secondary Enervate'] }).critChance;
  close(enervateOn(projectile()), 3.25);
  close(enervateOn(projectile({ shotgunSidearm: true })), 2.75);
  close(enervateOn({ ...projectile(), modes: [{ ...projectile().modes[0], trigger: 'Hit-Scan' }] }), 2.75);
  close(enervateOn(projectile({}, 15)), 2.5 + 0.1 * 2 * 2.5); // 30 / 15 rps = 2 hits a shot
});

test('arcane values come from the equipped rank text, not a straight line', () => {
  const merciless: ArcaneData = {
    id: 'Primary Merciless', name: 'Primary Merciless', category: 'Primary Arcane', rarity: 'Rare', maxRank: 5, slot: 'primary',
    description: '', effects: parseModEffects([['On Kill:', '+30% Damage for 4s. Stacks up to 12x.', '+30% Reload Speed']]).effects,
    levels: [5, 10, 15, 20, 25].map((v) => `On Kill: / +${v}% Damage for 4s. Stacks up to 12x.`).concat('On Kill: / +30% Damage for 4s. Stacks up to 12x. / +30% Reload Speed'),
  };
  const at = (rank: number) => Object.fromEntries(arcaneEffectsAt(merciless, rank).map((e) => [e.target, e.value]));
  assert.deepEqual(at(5), { baseDamage: 0.3, reloadSpeed: 0.3 });
  // The reload line is a max-rank passive (DE export): rank 2 has +15% damage and no reload.
  close(at(2).baseDamage, 0.15);
  assert.equal(at(2).reloadSpeed, undefined);
  // No rank text: linear, as before.
  close(arcaneRankScale({ ...merciless, levels: undefined }, merciless.effects[0], 2), 3 / 6);
});

test('Warframe arcanes that buff one weapon class skip the others', () => {
  const fury = arcane('Arcane Fury', 'warframe', 5, ['On Critical Hit:', '60% chance for +180% Melee Damage to Melee Weapons for 18s']);
  const snap = snapshot([weapon({ impact: 100 })], [], [], { arcanes: [fury] });
  const resolved = resolveBuild(snap, { weapon: 'Test Weapon', mods: [], warframeArcanes: ['Arcane Fury'], stackMode: 'max' });
  close(resolved.damage.projectileTotal, 100);
  assert.ok(resolved.inactiveConditions.some((line) => line.includes('only buffs melee')));
});

test('curated arcane mechanics: Plated Round, Doughty, Duplicate, Crepuscular', () => {
  const named = (name: string, slot: string): ArcaneData => ({ id: name, name, category: `${slot} Arcane`, rarity: 'Rare', maxRank: 5, description: '', effects: [], slot });
  const arcanes = [named('Primary Plated Round', 'primary'), named('Melee Doughty', 'melee'), named('Melee Duplicate', 'melee'), named('Arcane Crepuscular', 'warframe')];
  // Plated Round: 15 x sqrt(5 x 80) = +300% for a full 80-round reload (wiki table), all 80 shots
  // inside the 10 s buff at 8 rounds/s; at 4 rounds/s only half of them.
  const rifle = (fireRate: number) => snapshot([weapon({ impact: 100, magazineSize: 80, fireRate })], [], [], { arcanes });
  const plated = { weapon: 'Test Weapon', mods: [], arcanes: ['Primary Plated Round'], stackMode: 'max' as const };
  close(resolveBuild(rifle(8), plated).damage.projectileTotal, 400);
  close(resolveBuild(rifle(4), plated).damage.projectileTotal, 250);
  // Crepuscular: +3x added to the finished crit multiplier.
  close(resolveBuild(rifle(8), { weapon: 'Test Weapon', mods: [], warframeArcanes: ['Arcane Crepuscular'], stackMode: 'max' }).critMultiplier, 2 + 3);

  const blade = { ...weapon({ puncture: 50, slash: 50, statusChance: 0.4, critChance: 0.3 }), category: 'melee', type: 'Melee' };
  const melee = snapshot([blade], [], [], { arcanes });
  // Doughty: half the damage is Puncture, 40% status -> 20% Puncture status -> +2.0x at 1.0x per 10%.
  close(resolveBuild(melee, { weapon: 'Test Weapon', mods: [], arcanes: ['Melee Doughty'] }).critMultiplier, 2 + 2);
  // Duplicate: 30% of hits are base crits and strike again: x1.3 hits.
  close(resolveBuild(melee, { weapon: 'Test Weapon', mods: [], arcanes: ['Melee Duplicate'] }).multishot, 1.3);
});

test('an arcane in the wrong slot only warns', () => {
  const meleeArcane = arcane('Melee Exposure', 'melee', 5, ['Gain 60% Corrosive Damage on Melee strikes for 25s.']);
  const snap = snapshot([weapon({ impact: 100 })], [], [], { arcanes: [meleeArcane] });
  const resolved = resolveBuild(snap, { weapon: 'Test Weapon', mods: [], arcanes: ['Melee Exposure'], conditions: { onAbilityCast: 1 } });
  assert.ok(resolved.warnings.some((warning) => warning.includes('melee arcane')));
});

test('buff registry resolves the curated values from the dataset', () => {
  const snap = snapshot([], [], [], {
    abilities: [
      ability('Roar', 'Rhino', 50),
      ability('Eclipse', 'Mirage', 75, 'damage reduction'),
      ability('Vex Armor', 'Chroma', 275, 'fury max damage bonus'),
    ],
  });
  const roar = buffById('roar')!;
  close(buffEffects(snap, roar, 150)[0].value, 0.75);
  // Eclipse must pick the "damage bonus" stat, not the damage reduction one.
  const eclipse = buffById('eclipse')!;
  close(buffEffects(snap, eclipse, 100)[0].value, 0.75);
  const vex = buffById('vex-armor')!;
  close(buffEffects(snap, vex, 100)[0].value, 2.75);
});

test('riven values follow base × disposition (1.2 for every weapon) × weight', () => {
  const snap = snapshot([weapon({ impact: 100 })], []);
  // Two bonuses and no malus -> weight 0.99 (wiki: Attribute Value Formula). Disposition is retired
  // at 1.2, whatever the weapon data still says.
  const riven = rivenEffects(snap, snap.weapons['Test Weapon'], { stats: ['damage', 'multishot'] });
  close(riven.effects[0].value, 1.65 * 1.2 * 0.99, 1e-9);
  close(riven.effects[1].value, 0.9 * 1.2 * 0.99, 1e-9);
  // Adding a malus switches to the 2+1 weights: 1.2375 for bonuses, -0.495 for the malus.
  const withMalus = rivenEffects(snap, snap.weapons['Test Weapon'], { stats: ['damage', 'multishot'], malus: 'zoom' });
  close(withMalus.effects[0].value, 1.65 * 1.2 * 1.2375, 1e-9);
  close(withMalus.effects[2].value, 0.5999 * 1.2 * -0.495, 1e-9);
});

test('a riven negative stat is always a drawback: a recoil malus adds recoil', () => {
  const snap = snapshot([weapon({ impact: 100 })], []);
  snap.rivenStats.rifle = { ...snap.rivenStats.rifle, Recoil: 0.9 };
  const test = snap.weapons['Test Weapon'];
  // Less recoil is the good direction, so the bonus is negative and the malus positive.
  assert.ok(rivenEffects(snap, test, { stats: ['recoil', 'damage'] }).effects[0].value < 0);
  assert.ok(rivenEffects(snap, test, { stats: ['damage', 'multishot'], malus: 'recoil' }).effects[2].value > 0);
  assert.ok(rivenEffects(snap, test, { stats: ['damage', 'multishot'], malus: 'recoil', values: { recoil: 60 } }).effects[2].value > 0);
  // A typed faction malus (card x0.64) lowers faction damage.
  const faction = rivenEffects(snap, test, { stats: ['damage', 'multishot'], malus: 'faction-grineer', values: { 'faction-grineer': 0.64 } });
  close(faction.effects[2].value, -0.36, 1e-9);
  // Elemental stats never roll negative.
  const heat = rivenEffects(snap, test, { stats: ['damage', 'multishot'], malus: 'heat' });
  assert.equal(heat.effects.length, 2);
  assert.ok(heat.warnings.some((warning) => /cannot be a riven's negative stat/.test(warning)));
});

test('riven stat rank scales from rank 0 to rank 8', () => {
  const snap = snapshot([weapon({ impact: 100 })], []);
  const rank0 = rivenEffects(snap, snap.weapons['Test Weapon'], { stats: ['damage', 'multishot'], rank: 0 });
  const rank8 = rivenEffects(snap, snap.weapons['Test Weapon'], { stats: ['damage', 'multishot'], rank: 8 });
  close(rank0.effects[0].value, rank8.effects[0].value / 9, 1e-9);
});

test('viral and corrosive stacks follow the wiki tables', () => {
  close(viralMultiplier(0), 1);
  close(viralMultiplier(1), 2); // first stack: +100%
  close(viralMultiplier(10), 4.25); // 325% cap
  close(corrosiveArmorMultiplier(1), 0.74); // 26% strip
  close(corrosiveArmorMultiplier(10), 0.2); // 80% strip cap
});

test('slash bleed is True damage: it ignores the 90% armour reduction', () => {
  // 100 base damage, forced Slash proc on every hit through Hunter Munitions.
  const hunterMunitions = mod('Hunter Munitions', 5, ['+30% chance to apply on Critical'], { classes: ['Rifle'] });
  const snap = snapshot([weapon({ slash: 100, critChance: 1, critMultiplier: 1 })], [hunterMunitions], [bombard]);
  const resolved = build(snap, ['Hunter Munitions'], { conditions: { } });
  const hit = hitEnemy(snap, resolved, scaleEnemy(snap, bombard, 100));
  const bleed = hit.dot.find((entry) => entry.type === 'slash');
  assert.ok(bleed, 'expected a bleed proc');
  // Faction 1, status damage 1: tick = (100 + 1) × 0.35 = 35.35, no armour applied.
  close(bleed!.tickDamage, (100 + 1) * 0.35, 1e-6);
  close(bleed!.ticks, 6);
});

test('heat DoT is reduced by armour, bleed is not', () => {
  const snap = snapshot([weapon({ heat: 100 })], [], [bombard]);
  const resolved = build(snap, [], { conditions: {} });
  const hit = hitEnemy(snap, resolved, scaleEnemy(snap, bombard, 100));
  const heat = hit.dot.find((entry) => entry.type === 'heat');
  assert.ok(heat);
  assert.ok(heat!.tickDamage < (100 + 1) * 0.5, 'heat DoT must suffer armour DR');
});

test('Corrosive stacks reduce armour and therefore raise direct damage', () => {
  const snap = snapshot([weapon({ puncture: 100 })], [], [bombard]);
  const clean = hitEnemy(snap, build(snap, []), scaleEnemy(snap, bombard, 100));
  const stripped = hitEnemy(snap, build(snap, [], { debuffs: { corrosiveStacks: 10 } }), scaleEnemy(snap, bombard, 100));
  assert.ok(stripped.damagePerShotHealth > clean.damagePerShotHealth * 3);
});

test('Viral stacks amplify damage to health', () => {
  const snap = snapshot([weapon({ impact: 100 })], [], [bombard]);
  const clean = hitEnemy(snap, build(snap, []), scaleEnemy(snap, bombard, 100));
  const viral = hitEnemy(snap, build(snap, [], { debuffs: { viralStacks: 10 } }), scaleEnemy(snap, bombard, 100));
  close(viral.damagePerShotHealth / clean.damagePerShotHealth, 4.25, 1e-9);
});

test('ability strength is derived from Warframe mods', () => {
  const intensify = mod('Intensify', 5, ['+30% Ability Strength'], { classes: ['Warframe'] });
  const blindRage = mod('Blind Rage', 5, ['+99% Ability Strength', '-55% Ability Efficiency'], { classes: ['Warframe'] });
  const snap = snapshot([], [intensify, blindRage]);
  const strength = abilityStrengthFromMods(snap, ['Intensify', 'Blind Rage']);
  close(strength.strength, 100 * (1 + 0.3 + 0.99));
});

test('melee combo multiplier follows the wiki ladder and caps at 12x', () => {
  const snap = snapshot([weapon({ slash: 100 })], []);
  const at = (hits: number) => resolveBuild(snap, { weapon: 'Test Weapon', mods: [], comboHits: hits }).comboMultiplier;
  close(at(0), 1);
  close(at(19), 1);
  close(at(20), 2);
  close(at(40), 3);
  close(at(220), 12);
  close(at(400), 12); // capped
});

test('combo-scaling mods multiply their bonus by (multiplier - 1)', () => {
  const bloodRush = mod('Blood Rush', 5, ['+40% Critical Chance stacks with Combo Multiplier'], { classes: ['Melee'] });
  const snap = snapshot([weapon({ slash: 100, critChance: 0.2 })], [bloodRush]);
  const noCombo = resolveBuild(snap, { weapon: 'Test Weapon', mods: ['Blood Rush'] });
  const fullCombo = resolveBuild(snap, { weapon: 'Test Weapon', mods: ['Blood Rush'], comboHits: 220 });
  close(noCombo.critChance, 0.2); // 1x combo: no bonus at all
  close(fullCombo.critChance, 0.2 * (1 + 0.4 * 11)); // 12x: +440%
});

test('only heavy attacks get the combo damage multiplier', () => {
  const snap = snapshot([weapon({ slash: 100 })], []);
  const normal = resolveBuild(snap, { weapon: 'Test Weapon', mods: [], comboHits: 120 });
  const heavy = resolveBuild(snap, { weapon: 'Test Weapon', mods: [], comboHits: 120, heavyAttack: true });
  close(normal.shotDamage, 100);
  close(heavy.shotDamage, 100 * 7); // 120 hits -> 7x
});

test('Incarnon flat base damage is added and scaled by damage mods', () => {
  const snap = snapshot([weapon({ toxin: 140 })], [serration], [], {});
  snap.incarnons = {
    'Test Weapon': [
      { tier: 'EVO2', name: 'Final Fusillade', effects: [{ target: 'baseDamage', op: 'add', value: 51, raw: 'Increase Base Damage by +51', flat: true }], text: [] },
    ],
  };
  const resolved = resolveBuild(snap, { weapon: 'Test Weapon', mods: ['Serration'], incarnon: ['EVO2:0'] });
  // 140 x 2.65 (Serration) + 51 x 2.65 (flat base damage, also multiplied) = 506.15
  close(resolved.damage.projectileTotal, (140 + 51) * 2.65);
});

test('AoE falloff is linear between start and end and clamps outside', () => {
  const falloff = { start: 0, end: 8, reduction: 0.9 };
  close(falloffFactor(falloff, 0), 1);
  close(falloffFactor(falloff, 4), 1 - 0.9 * 0.5);
  close(falloffFactor(falloff, 8), 0.1);
  close(falloffFactor(falloff, 20), 0.1); // beyond max range the floor applies
  const inner = { start: 2, end: 6, reduction: 0.5 };
  close(falloffFactor(inner, 1), 1); // inside the full-damage radius
});

test('AoE distance replaces the radial portion of the arsenal damage', () => {
  // Arsenal block = direct 100 + radial 900; the radial mode carries the falloff.
  const direct = 100;
  const radial = 900;
  const weaponWithAoe = weapon({ impact: direct + radial });
  weaponWithAoe.modes = [
    { name: 'Direct Hit', stats: stats({ impact: direct }), trigger: 'Projectile' },
    { name: 'Radial Attack', stats: stats({ impact: radial }), trigger: 'AoE', falloff: { start: 0, end: 10, reduction: 0.9 } },
  ];
  const snap = snapshot([weaponWithAoe], []);
  const centre = resolveBuild(snap, { weapon: 'Test Weapon', mods: [], aoeDistance: 0 });
  const edge = resolveBuild(snap, { weapon: 'Test Weapon', mods: [], aoeDistance: 5 });
  close(centre.damage.projectileTotal, direct + radial);
  // Halfway: radial keeps 1 - 0.45 of its damage.
  close(edge.damage.projectileTotal, direct + radial * (1 - 0.9 * 0.5));
});

test('Direct Damage per status type skips the AoE explosion (wiki: never worked on AoE)', () => {
  const galvanizedAptitude = mod('Galvanized Aptitude', 10, [
    '+80% Status Chance', 'On Kill:', '+40% Direct Damage per Status Type affecting the target for 20s. Stacks up to 2x.',
  ]);
  const launcher = weapon({ impact: 100, blast: 900 });
  launcher.modes = [
    { name: 'Direct Hit', stats: stats({ impact: 100 }), trigger: 'Projectile' },
    { name: 'Explosion', stats: stats({ blast: 900 }), trigger: 'AoE', falloff: { start: 0, end: 10, reduction: 0.9 } },
  ];
  const snap = snapshot([launcher], [galvanizedAptitude]);
  const conditions = { onKill: 2, statusTypes: 3 };
  // Only the 100 direct damage takes the +240%.
  close(resolveBuild(snap, { weapon: 'Test Weapon', mods: ['Galvanized Aptitude'], conditions }).damage.projectileTotal, 100 * 3.4 + 900);
  const edge = resolveBuild(snap, { weapon: 'Test Weapon', mods: ['Galvanized Aptitude'], conditions, aoeDistance: 5 });
  close(edge.damage.projectileTotal, 100 * 3.4 + 900 * 0.55);
});

test('Incarnon options can be picked by name or by tier index', () => {
  const snap = snapshot([weapon({ toxin: 100 })], []);
  snap.incarnons = {
    'Test Weapon': [
      { tier: 'EVO2', name: 'Skillful Chase', effects: [{ target: 'multishot', op: 'add', value: 0.5, raw: '+50% Multishot' }], text: [] },
      { tier: 'EVO2', name: 'Lone Blade', effects: [{ target: 'critChance', op: 'add', value: 1, raw: '+100% Critical Chance' }], text: [] },
    ],
  };
  const byName = resolveBuild(snap, { weapon: 'Test Weapon', mods: [], incarnon: ['EVO2:Lone Blade'] });
  const byIndex = resolveBuild(snap, { weapon: 'Test Weapon', mods: [], incarnon: ['EVO2:0'] });
  close(byName.critChance, 0.2 * 2);
  close(byIndex.multishot, 1.5);
});

test('flat crit bonuses (Arcane Avenger) are added, not multiplied', () => {
  const avenger: ArcaneData = {
    id: 'Arcane Avenger', name: 'Arcane Avenger', category: 'Warframe Arcane', rarity: 'Rare', maxRank: 5,
    description: 'On Damaged: 21% chance for +45% Critical Chance for 12s',
    effects: [{ target: 'critChance', op: 'flat', value: 0.45, condition: 'on_damaged', raw: '+45% Critical Chance' }],
    slot: 'warframe',
  };
  const snap = snapshot([weapon({ impact: 100, critChance: 0.3 })], [], [], { arcanes: [avenger] });
  const withoutBuff = resolveBuild(snap, { weapon: 'Test Weapon', mods: [], warframeArcanes: ['Arcane Avenger'] });
  const withBuff = resolveBuild(snap, {
    weapon: 'Test Weapon', mods: [], warframeArcanes: ['Arcane Avenger'], conditions: { on_damaged: 1 },
  });
  close(withoutBuff.critChance, 0.3); // condition not met
  close(withBuff.critChance, 0.3 + 0.45); // flat, not 0.3 x 1.45
});

test('Molt Augmented feeds Ability Strength from its stacks', () => {
  const molt: ArcaneData = {
    id: 'Molt Augmented', name: 'Molt Augmented', category: 'Warframe Arcane', rarity: 'Legendary', maxRank: 5,
    description: 'On Kill: +0.24% Ability Strength. Stacks up to 250x',
    effects: [{ target: 'abilityStrength', op: 'add', value: 0.0024, condition: 'onKill', maxStacks: 250, raw: '+0.24% Ability Strength' }],
    slot: 'warframe',
  };
  const snap = snapshot([weapon({ impact: 100 })], [], [], { arcanes: [molt], abilities: [ability('Roar', 'Rhino', 50)] });
  const full = resolveBuild(snap, {
    weapon: 'Test Weapon', mods: [], buffs: ['roar'], warframeArcanes: ['Molt Augmented'], conditions: { onKill: 250 },
  });
  // 100 + 0.24 x 250 = 160% strength -> Roar 50% x 1.6
  close(full.abilityStrength, 160);
  close(full.factionBonus.all ?? 0, 0.8);
});

test('crit spread reports expected crits and the chance of at least one', () => {
  const snap = snapshot([weapon({ impact: 10, multishot: 10, critChance: 0.35 })], []);
  const resolved = resolveBuild(snap, { weapon: 'Test Weapon', mods: [] });
  close(resolved.critVariance.pellets, 10);
  close(resolved.critVariance.expectedCrits, 3.5);
  close(resolved.critVariance.atLeastOneCrit, 1 - Math.pow(0.65, 10));
});

test('a non-subsumable buff from another frame only warns', () => {
  const snap = snapshot([weapon({ impact: 100 })], [], [], { abilities: [ability('Sonar', 'Banshee', 5)] });
  snap.abilities.Sonar.subsumable = false;
  const resolved = resolveBuild(snap, { weapon: 'Test Weapon', mods: [], buffs: ['sonar'], frame: 'Rhino' });
  assert.ok(resolved.warnings.some((warning) => warning.includes('not subsumable')));
});

test('Kuva/Tenet elemental bonus joins the combination as innate damage', () => {
  const snap = snapshot([{ ...weapon({ impact: 100 }), name: 'Kuva Test' }], [hellfire, cryoRounds]);
  // 60% of 100 base = 60 Heat, added before mods; Hellfire (+90%) stacks on top of the
  // 100 base, so Heat = 60 + 90 = 150 and nothing is left to combine.
  const bare = resolveBuild(snap, { weapon: 'Kuva Test', mods: [], elementBonus: { type: 'heat', value: 0.6 } });
  close(bare.damage.perProjectile.heat ?? 0, 60);
  close(bare.damage.projectileTotal, 160);

  // The bonus counts as base damage, so elemental mods scale off the larger total:
  // Cryo Rounds adds 90% of 160 = 144 Cold, which pairs with the innate 60 Heat.
  const withCold = resolveBuild(snap, {
    weapon: 'Kuva Test', mods: ['Cryo Rounds'], elementBonus: { type: 'heat', value: 0.6 },
  });
  close(withCold.damage.perProjectile.blast ?? 0, 60 + 144);
  close(withCold.damage.perProjectile.heat ?? 0, 0);
});

test('Covenant gives flat crit chance, capped per hit type', () => {
  const snap = snapshot([weapon({ impact: 100, critChance: 0.3 })], [], [], {
    abilities: [
      {
        ability: 'Covenant', frame: 'Harrow', page: 'Covenant', kind: 'ability', value: 5,
        segments: [{ label: 'base critical chance', max: 5 }, { label: 'critical chance per 100 damage', max: 1.5 }],
        duration: 12, range: 50, subsumable: false,
      },
    ],
  });
  const at = (damage: number, headshot = false) =>
    resolveBuild(snap, { weapon: 'Test Weapon', mods: [], buffs: ['covenant'], conditions: { covenantDamage: damage }, headshot });

  close(at(0).critChance, 0.35); // 30% base + 5% flat
  close(at(1000).critChance, 0.3 + 0.20); // 5% + 1.5% x 10
  close(at(4000).critChance, 0.3 + 0.50); // capped at 50% on body shots
  close(at(20000, true).critChance, 0.3 + 2.00); // capped at 200% on weak points
});

/**
 * Golden values copied verbatim from wiki.warframe.com/w/Damage/Calculation →
 * "Damage Over Time Final Calculations". Each one is a worked example with the
 * seed, the bonuses and the expected tick damage the game displays.
 */
test('wiki DoT example: Heat, 40 seed with +60% Heat -> 32.8 per tick', () => {
  // (40 + 1) x 0.5 x 1.6 = 32.8
  const snap = snapshot([weapon({ heat: 40 })], [thermite], [dummy]);
  const resolved = build(snap, ['Thermite Rounds']);
  const hit = hitEnemy(snap, resolved, scaleEnemy(snap, dummy, 1));
  const heat = hit.dot.find((entry) => entry.type === 'heat');
  assert.ok(heat);
  close(heat!.tickDamage, 32.8, 1e-3);
});

test('wiki DoT example: the seed is the whole modded base damage, not the type share', () => {
  // Supra Vandal (wiki): 40 base damage over Impact/Puncture/Slash, Thermite Rounds adds 24 Heat.
  // Heat still seeds from all 40: (40 + 1) x 0.5 x 1.6 = 32.8. Bleed seeds from 40 too, not the
  // 64 that includes Heat: (40 + 1) x 0.35 = 14.35.
  const snap = snapshot([weapon({ impact: 4, puncture: 30, slash: 6 })], [thermite], [dummy]);
  const hit = hitEnemy(snap, build(snap, ['Thermite Rounds']), scaleEnemy(snap, dummy, 1));
  close(hit.dot.find((entry) => entry.type === 'heat')!.tickDamage, 32.8, 1e-3);
  close(hit.dot.find((entry) => entry.type === 'slash')!.tickDamage, 14.35, 1e-3);
});

test('innate elements go last, unless a mod of the same element places them (wiki: Elemental Damage)', () => {
  const cryo = mod('Cryo Rounds', 5, ['+90% Cold']);
  const infected = mod('Infected Clip', 5, ['+90% Toxin']);
  const hellfire = mod('Hellfire', 5, ['+90% Heat']);
  const storm = mod('Stormbringer', 5, ['+90% Electricity']);
  const snap = snapshot([weapon({ puncture: 50, electricity: 50 })], [cryo, infected, hellfire, storm], [dummy]);
  const types = (mods: string[]) => Object.keys(build(snap, mods).damage.perProjectile).filter((t) => (build(snap, mods).damage.perProjectile as Record<string, number>)[t] > 0).sort();
  // Prova/Lecta example: Cold, Toxin, Heat mods -> Cold+Toxin = Viral, Heat + innate Electricity = Radiation.
  assert.deepEqual(types(['Cryo Rounds', 'Infected Clip', 'Hellfire']), ['puncture', 'radiation', 'viral']);
  // Toxin + Heat pair first, the innate Electricity is left on its own.
  assert.deepEqual(types(['Infected Clip', 'Hellfire']), ['electricity', 'gas', 'puncture']);
  // Amprex + Stormbringer: the mod pulls the innate Electricity to the front, so it now pairs
  // with Heat (Radiation) and Toxin is the one left over.
  assert.deepEqual(types(['Stormbringer', 'Hellfire', 'Infected Clip']), ['puncture', 'radiation', 'toxin']);
});

test('Kuva/Tenet/Coda weapons carry a bonus element, 60% Heat unless the player picks one', () => {
  const kuva = { ...weapon({ impact: 100 }), id: 'Kuva Test', name: 'Kuva Test' };
  const snap = snapshot([kuva, weapon({ impact: 100 })], [thermite], [dummy]);
  const at = (extra: Partial<Build>) => resolveBuild(snap, { weapon: 'Kuva Test', mods: [], ...extra });
  close(at({}).damage.perProjectile.heat ?? 0, 60);
  close(at({ elementBonus: { type: 'toxin', value: 0.45 } }).damage.perProjectile.toxin ?? 0, 45);
  assert.equal(at({ elementBonus: { type: 'heat', value: 0 } }).elementBonus, null);
  // It is base damage: Thermite's +60% Heat works on 160, and status ticks seed from 160.
  close(at({ mods: ['Thermite Rounds'] }).damage.perProjectile.heat ?? 0, 60 + 160 * 0.6);
  const heatTick = hitEnemy(snap, at({}), scaleEnemy(snap, dummy, 1)).dot.find((entry) => entry.type === 'heat')!;
  close(heatTick.tickDamage, (160 + 1) * 0.5, 1e-6);
  // Out-of-game picks only warn; ordinary weapons get no default.
  assert.ok(at({ elementBonus: { type: 'blast', value: 0.6 } }).warnings.some((line) => line.includes('not a bonus element')));
  const plain = resolveBuild(snap, { weapon: 'Test Weapon', mods: [] });
  assert.equal(plain.elementBonus, null);
  // Not on an ordinary weapon, not past the game's 60%: ignored or clamped, with a warning.
  const ordinary = resolveBuild(snap, { weapon: 'Test Weapon', mods: [], elementBonus: { type: 'heat', value: 0.6 } });
  assert.ok(ordinary.warnings.some((line) => line.includes('no bonus element')));
  close(ordinary.damage.projectileTotal, 100);
  close(at({ elementBonus: { type: 'heat', value: 50 } }).damage.perProjectile.heat ?? 0, 60);
});

test('enemy levels outside 1..9999 are refused instead of scaling to nothing', () => {
  const snap = snapshot([weapon({ impact: 100 })], [], [dummy]);
  for (const level of [Number.NaN, 0, -5, 1e9]) assert.throws(() => scaleEnemy(snap, dummy, level), /level must be a number/);
  assert.ok(scaleEnemy(snap, dummy, 9999).health > 0);
});

test('Primary Debilitate adds base statuses on 10+ stacks of a combined one', () => {
  const debilitate: ArcaneData = { id: 'Primary Debilitate', name: 'Primary Debilitate', category: 'Primary Arcane', rarity: 'Rare', maxRank: 5, description: '', effects: [], slot: 'primary' };
  // Pure Gas, 100% status, 10 shots/s, no reloads: 60 Gas procs alive over 6 s, so every proc lands on 10+.
  const snap = snapshot([weapon({ gas: 100, statusChance: 1, fireRate: 10, magazineSize: 1000, reloadTime: 0 })], [], [dummy], { arcanes: [debilitate] });
  const dotOf = (arcanes: string[]) => hitEnemy(snap, build(snap, [], { arcanes }), scaleEnemy(snap, dummy, 1)).dot;
  assert.equal(dotOf([]).some((entry) => entry.type === 'heat'), false);
  const withArcane = dotOf(['Primary Debilitate']);
  // Half of the 10 Gas procs a second turn into Heat, the other half into Toxin.
  close(withArcane.find((entry) => entry.type === 'heat')!.procsPerSecond, 5, 1e-3);
  close(withArcane.find((entry) => entry.type === 'toxin')!.procsPerSecond, 5, 1e-3);
  // Seeded by the hit's base damage like any proc: (100 + 1) x 0.5.
  close(withArcane.find((entry) => entry.type === 'heat')!.tickDamage, 50.5, 1e-3);
  // At a low proc rate the stacks rarely reach 10: almost nothing extra.
  const slow = snapshot([weapon({ gas: 100, statusChance: 0.1, fireRate: 1 })], [], [dummy], { arcanes: [debilitate] });
  const sparse = hitEnemy(slow, build(slow, [], { arcanes: ['Primary Debilitate'] }), scaleEnemy(slow, dummy, 1)).dot;
  assert.ok((sparse.find((entry) => entry.type === 'heat')?.procsPerSecond ?? 0) < 1e-6);
  // The simulated fight sees the extra Heat as well: a shorter kill.
  const fight = (arcanes: string[]) => hitEnemy(snap, build(snap, [], { arcanes }), scaleEnemy(snap, dummy, 1), { simulate: true }).timeToKill ?? Infinity;
  assert.ok(fight(['Primary Debilitate']) < fight([]));
});

test('status procs per second count reloads; each proc keeps all its ticks', () => {
  // 10 rounds at 10/s, then a 1 s reload: 5 pulls a second over the fight, not 10.
  const slashOf = (reloadTime: number) => {
    const snap = snapshot([weapon({ slash: 100, statusChance: 1, fireRate: 10, magazineSize: 10, reloadTime })], [], [dummy]);
    return hitEnemy(snap, build(snap, []), scaleEnemy(snap, dummy, 1)).dot.find((entry) => entry.type === 'slash')!;
  };
  const slash = slashOf(1);
  close(slash.procsPerSecond, 5, 1e-9);
  // Ticks from procs before the reload still land during it: all 6 count, so the DoT is
  // exactly half of the same weapon without reloads.
  assert.equal(slash.ticks, 6);
  close(slash.dps / slashOf(0).dps, 0.5, 1e-9);
});

test('Arcane Pistoleer: Infinite Ammo uptime from the kill time, only on weak-point hits and secondaries', () => {
  const pistoleer: ArcaneData = { id: 'Arcane Pistoleer', name: 'Arcane Pistoleer', category: '', rarity: 'Legendary', maxRank: 5, description: '', effects: [], slot: 'warframe' };
  // 10 rounds at 5/s, then a 4 s reload: reloads are 2/3 of the time.
  const pistol = { ...weapon({ impact: 100, fireRate: 5, magazineSize: 10, reloadTime: 4 }), category: 'secondary' as const, type: 'Pistol' };
  const target: EnemyData = { ...dummy, health: 20_000, pools: [{ type: 'Neutral Flesh', category: 'health', amount: 20_000 }] };
  const snap = snapshot([pistol], [], [target], { arcanes: [pistoleer] });
  const kill = (extra: Partial<Build>) => hitEnemy(snap, build(snap, [], { stackMode: 'max', simulate: false, ...extra } as Partial<Build>), scaleEnemy(snap, target, 1), { simulate: false });
  const plain = kill({ hit: 'head' });
  // Body hits: no weak-point kill, no buff.
  assert.equal(kill({ hit: 'body', warframeArcanes: ['Arcane Pistoleer'] }).timeToKill, kill({ hit: 'body' }).timeToKill);
  const head = kill({ hit: 'head', warframeArcanes: ['Arcane Pistoleer'] });
  assert.ok(head.timeToKill! < plain.timeToKill!);
  // The reported uptime is the no-refresh renewal one, at the kill time it produced.
  const uptime = 12 / (12 + head.timeToKill! / 0.6);
  const note = head.warnings.find((line) => line.startsWith('Ammo:'))!;
  assert.match(note, new RegExp(`Arcane Pistoleer Infinite Ammo up ${Math.round(uptime * 100)}%`));
  // Only secondary weapons: on a rifle it is inactive.
  const rifle = snapshot([weapon({ impact: 100, fireRate: 5, magazineSize: 10, reloadTime: 4 })], [], [target], { arcanes: [pistoleer] });
  const onRifle = build(rifle, [], { stackMode: 'max', hit: 'head', warframeArcanes: ['Arcane Pistoleer'] });
  assert.equal(onRifle.ammo.buffs.length, 0);
  assert.ok(onRifle.inactiveConditions.some((line) => line.includes('only buffs secondary weapons')));
});

test('Encumber, Cryogenic, Irradiate, Surge and Theorem Demulcent', () => {
  const arcane = (name: string, slot: string): ArcaneData => ({ id: name, name, category: '', rarity: 'Rare', maxRank: 5, description: '', effects: [], slot });
  const pistol = { ...weapon({ puncture: 100, statusChance: 0.5, fireRate: 10, magazineSize: 1000, reloadTime: 0 }), category: 'secondary' as const, type: 'Pistol' };
  const snap = snapshot([pistol], [], [dummy], { arcanes: ['Secondary Encumber', 'Secondary Cryogenic', 'Secondary Irradiate', 'Secondary Surge'].map((n) => arcane(n, 'secondary')).concat(arcane('Theorem Demulcent', 'warframe')) });
  const dotOf = (arcanes: string[]) => hitEnemy(snap, build(snap, [], { arcanes }), scaleEnemy(snap, dummy, 1)).dot;
  // Encumber: 10 pulls/s x (24% x 50%) = 1.2 extra procs/s, spread over 13 statuses.
  close(dotOf(['Secondary Encumber']).find((entry) => entry.type === 'slash')!.procsPerSecond, 1.2 / 13, 1e-9);
  // Cryogenic: 5 Puncture procs/s x 3 Cold stacks show up in the simulated fight's Cold.
  const cold = (arcanes: string[]) => hitEnemy(snap, build(snap, [], { arcanes }), scaleEnemy(snap, dummy, 1), { simulate: true }).simulation!.atEnd.cold;
  assert.equal(cold([]), 0);
  assert.ok(cold(['Secondary Cryogenic']) > 0);
  // Irradiate needs Radiation stacks: pure Puncture never qualifies, so no splash.
  const group = (arcanes: string[]) => hitEnemy(snap, build(snap, [], { arcanes }), scaleEnemy(snap, dummy, 1), { targets: 3 }).multiTargetFactor;
  assert.equal(group(['Secondary Irradiate']), 1);
  const rad = snapshot([{ ...pistol, stats: { ...pistol.stats, puncture: 0, radiation: 100, statusChance: 1 } }], [], [dummy], { arcanes: [arcane('Secondary Irradiate', 'secondary')] });
  const radGroup = hitEnemy(rad, build(rad, [], { arcanes: ['Secondary Irradiate'] }), scaleEnemy(rad, dummy, 1), { targets: 3 });
  assert.ok(radGroup.multiTargetFactor > 1 + 2 * 1.8 * 0.9 * 0.5);
  // Surge: x8 on the empowered shot, never assumed by max mode.
  const surge = (extra: Partial<Build>) => build(snap, [], { arcanes: ['Secondary Surge'], ...extra }).damage.projectileTotal;
  close(surge({ stackMode: 'max' }), surge({}));
  close(surge({ conditions: { surgeShot: true } }) / surge({}), 8, 1e-6);
  close(surge({ conditions: { surgeShot: 600 } }) / surge({}), 4, 1e-6);
  // Theorem Demulcent: +180% of the zone's element at 15 stacks, like an elemental mod.
  const zone = build(snap, [], { warframeArcanes: ['Theorem Demulcent'], residualElement: 'heat', stackMode: 'max' });
  close(zone.damage.perProjectile.heat ?? 0, 180, 1e-6);
});

test('wiki DoT example: Toxin, 40 seed, +225% Toxin and +55% faction -> 158.68 per tick', () => {
  // ((40 x 1.55) + 1) x 0.5 x 3.25 x 1.55 = 158.68
  const toxinBig = mod('Primed Infected Clip', 10, ['+225% Toxin'], { classes: ['Rifle'] });
  const bane = mod('Primed Bane of Grineer', 10, ['x1.55 Damage to Grineer'], { classes: ['Rifle'] });
  const snap = snapshot([weapon({ toxin: 40 })], [toxinBig, bane], [dummy]);
  const resolved = build(snap, ['Primed Infected Clip', 'Primed Bane of Grineer']);
  const hit = hitEnemy(snap, resolved, scaleEnemy(snap, dummy, 1));
  const toxin = hit.dot.find((entry) => entry.type === 'toxin');
  assert.ok(toxin);
  close(toxin!.tickDamage, 158.68, 1e-2);
});

test('wiki DoT example: Slash bleed, 40 seed with +55% faction -> 34.18 per tick', () => {
  // ((40 x 1.55) + 1) x 0.35 x 1.55 = 34.18, and bleed ignores armour entirely.
  const bane = mod('Primed Bane of Grineer', 10, ['x1.55 Damage to Grineer'], { classes: ['Rifle'] });
  const hunterMunitions = mod('Hunter Munitions', 5, ['+30% chance to apply on Critical'], { classes: ['Rifle'] });
  const snap = snapshot(
    [weapon({ slash: 40, critChance: 1, critMultiplier: 1 })],
    [bane, hunterMunitions],
    [dummy],
  );
  const resolved = build(snap, ['Primed Bane of Grineer', 'Hunter Munitions']);
  const hit = hitEnemy(snap, resolved, scaleEnemy(snap, dummy, 1));
  const bleed = hit.dot.find((entry) => entry.type === 'slash');
  assert.ok(bleed);
  close(bleed!.tickDamage, 34.18, 1e-3);
});

test('wiki DoT example: Gas, 40 seed with no bonuses -> 20.5 per tick', () => {
  // (40 + 1) x 0.5 = 20.5 with "no applicable bonuses": combined types like Gas get no
  // elemental multiplier on the DoT (their component mods only add to the Gas pool itself).
  const snap = snapshot([weapon({ gas: 40 })], [], [dummy]);
  const resolved = build(snap, []);
  const hit = hitEnemy(snap, resolved, scaleEnemy(snap, dummy, 1));
  const gas = hit.dot.find((entry) => entry.type === 'gas');
  assert.ok(gas);
  close(gas!.tickDamage, 20.5, 1e-3);
});

test('compound conditions use the stack count, not the boolean gate', () => {
  // Galvanized Scope: "On Weak Point Kill: +40% Critical Chance when Aiming, stacks to 5x".
  const scope = mod('Galvanized Scope', 10, [
    'On Weak Point Hit:',
    '+120% Critical Chance when Aiming for 9s',
    'On Weak Point Kill:',
    '+40% Critical Chance when Aiming for 9s. Stacks up to 5x.',
  ]);
  const snap = snapshot([weapon({ impact: 100, critChance: 0.25 })], [scope]);
  const at = (stacks: number) =>
    resolveBuild(snap, {
      weapon: 'Test Weapon',
      mods: ['Galvanized Scope'],
      conditions: { onWeakPointHit: 1, onWeakPointKill: stacks, aiming: 1 },
    });
  // Base 25% x (1 + 1.2 base buff + 0.4 x 3 stacks) = 25% x 3.4
  close(at(3).critChance, 0.25 * (1 + 1.2 + 0.4 * 3));
  close(at(1).critChance, 0.25 * (1 + 1.2 + 0.4));
  // Without aiming, the buff is inactive even with the kill stacks.
  const noAim = resolveBuild(snap, {
    weapon: 'Test Weapon', mods: ['Galvanized Scope'], conditions: { onWeakPointHit: 1, onWeakPointKill: 3 },
  });
  close(noAim.critChance, 0.25);
});

/**
 * Calibration against Overframe (Haalvu build, 2026-10):
 *   Galvanized Chamber, Galvanized Aptitude, Hellfire, Thermite Rounds, Critical Delay,
 *   Primed Shred, Vital Sense, Serration.
 * Overframe reports multishot 1.8, crit 75%, crit damage 5.5x, status 45.6%, fire rate
 * 17.55 and 393.5 total damage with the Galvanized Aptitude condition active.
 */
test('matches the Overframe Haalvu build: arsenal stats', () => {
  const galvanizedAptitude = mod('Galvanized Aptitude', 10, [
    '+80% Status Chance', 'On Kill:', '+40% Direct Damage per Status Type affecting the target for 20s. Stacks up to 2x.',
  ]);
  const criticalDelay = mod('Critical Delay', 10, ['+200% Critical Chance', '-20% Fire Rate']);
  const primedShred = mod('Primed Shred', 10, ['+55% Fire Rate', '+2.2 Punch Through']);
  const thermite = mod('Thermite Rounds', 5, ['+60% Heat', '+60% Status Chance']);
  const galvChamber = mod('Galvanized Chamber', 10, ['+80% Multishot', 'On Kill:', '+30% Multishot for 20s. Stacks up to 5x.']);

  const haalvu = weapon({ tau: 33, critChance: 0.25, critMultiplier: 2.5, statusChance: 0.19, fireRate: 13, magazineSize: 150, reloadTime: 1 });
  const snap = snapshot([haalvu], [galvanizedAptitude, criticalDelay, primedShred, thermite, galvChamber, hellfire, vitalSense, serration]);

  const mods = ['Galvanized Chamber', 'Galvanized Aptitude', 'Hellfire', 'Thermite Rounds', 'Critical Delay', 'Primed Shred', 'Vital Sense', 'Serration'];
  const bare = resolveBuild(snap, { weapon: 'Test Weapon', mods });
  // Pre-conditional arsenal values, as Overframe shows them per damage type.
  close(bare.multishot, 1.8, 1e-9);
  close(bare.critChance, 0.75, 1e-9);           // 25% x (1 + 200%)
  close(bare.critMultiplier, 5.5, 1e-9);        // 2.5 x (1 + 120%)
  close(bare.statusChance, 0.456, 1e-9);        // 19% x (1 + 80% + 60%)
  close(bare.fireRate, 17.55, 1e-6);            // 13 x (1 + 55% - 20%)
  close(bare.damage.perProjectile.tau ?? 0, 87.5, 1e-2);   // 33 x 2.65
  close(bare.damage.perProjectile.heat ?? 0, 131.2, 1e-2); // 49.5 x 2.65
  close(bare.damage.projectileTotal, 218.7, 1e-1);

  // With Galvanized Aptitude active: Overframe shows 218.7 x 1.8 = 393.5, but the wiki
  // (Condition Overload (Mechanic)) lists the Haalvu as Adding, so the +80% joins Serration's
  // bucket: 33 x (1 + 1.5) x (1 + 1.65 + 0.8) = 284.6.
  const stacked = resolveBuild(snap, { weapon: 'Test Weapon', mods, conditions: { onKill: 2, statusTypes: 1 } });
  close(stacked.damage.projectileTotal, 284.6, 1e-1);
});

test('"(x2 for Bows)" doubles the effect on bow-type weapons only', () => {
  const shred = mod('Shred', 5, ['+30% Fire Rate (x2 for Bows)', '+1.2 Punch Through']);
  const rifle = { ...weapon({ impact: 100, fireRate: 10 }), name: 'Rifle Test', id: 'Rifle Test' };
  const bow: WeaponData = { ...rifle, name: 'Bow Test', id: 'Bow Test', type: 'Bow', modClasses: ['Rifle', 'Bow'] };
  const snap = snapshot([rifle, bow], [shred]);
  const onRifle = resolveBuild(snap, { weapon: 'Rifle Test', mods: ['Shred'] });
  const onBow = resolveBuild(snap, { weapon: 'Bow Test', mods: ['Shred'] });
  close(onRifle.fireRate, 10 * 1.3);
  close(onBow.fireRate, 10 * 1.6);
});

test('Cannonade mods lock the fire rate, ignoring other mods', () => {
  const cannonade = mod('Semi-Rifle Cannonade', 5, ['+240% Damage', '+1.5 Punch Through'], {
    description: 'Only compatible with Semi-Auto Trigger. Fire Rate cannot be modified.',
  });
  cannonade.effects.push({ target: 'fireRateLock', op: 'add', value: 1, raw: 'Fire Rate cannot be modified' });
  const criticalDelay = mod('Critical Delay', 5, ['+200% Critical Chance', '-20% Fire Rate']);
  const semi = { ...weapon({ impact: 100, fireRate: 4 }), type: 'Rifle' };
  const snap = snapshot([semi], [cannonade, criticalDelay]);
  const withCannonade = resolveBuild(snap, { weapon: 'Test Weapon', mods: ['Semi-Rifle Cannonade', 'Critical Delay'] });
  close(withCannonade.fireRate, 4); // locked: Critical Delay's -20% does not apply
  const withoutCannonade = resolveBuild(snap, { weapon: 'Test Weapon', mods: ['Critical Delay'] });
  close(withoutCannonade.fireRate, 4 * 0.8);
});

test('a set bonus amplifies its own mods (Sacrificial style)', () => {
  const steel = mod('Sacrificial Steel', 10, ['+220% Critical Chance'], { classes: ['Melee'], set: 'Sacrificial Set' });
  const pressure = mod('Sacrificial Pressure', 10, ['+110% Melee Damage'], { classes: ['Melee'], set: 'Sacrificial Set' });
  const melee = { ...weapon({ slash: 100, critChance: 0.24 }), type: 'Melee', modClasses: ['Melee'] };
  const snap = snapshot([melee], [steel, pressure]);
  const alone = resolveBuild(snap, { weapon: 'Test Weapon', mods: ['Sacrificial Steel'] });
  const together = resolveBuild(snap, { weapon: 'Test Weapon', mods: ['Sacrificial Steel', 'Sacrificial Pressure'] });
  close(alone.critChance, 0.24 * (1 + 2.2));
  // Both pieces equipped: the set amplifies the mod's effect by 25% -> +275%.
  close(together.critChance, 0.24 * (1 + 2.75));
});

test('Gladiator set adds crit chance per combo step', () => {
  const steel = mod('Gladiator Might', 5, ['+60% Critical Damage'], { classes: ['Melee'], set: 'Gladiator Set' });
  const melee = { ...weapon({ slash: 100, critChance: 0.2 }), type: 'Melee', modClasses: ['Melee'] };
  const snap = snapshot([melee], [steel]);
  snap.setBonuses['Gladiator Set'] = {
    set: 'Gladiator Set', kind: 'table', description: 'crit chance per combo stack', table: { '1': 0.1 },
  };
  const at12x = resolveBuild(snap, { weapon: 'Test Weapon', mods: ['Gladiator Might'], comboHits: 220 });
  // +10% per piece x (12 - 1) = +110% crit chance.
  close(at12x.critChance, 0.2 + 0.1 * 11);
});

test('each damage type deals at least 1 against an armoured target (verified in game)', () => {
  // Wiki (Armor): "a Braton will always do a minimum of 3 damage against an armored target"
  // because it has three damage types. Confirmed in game: an unmodded Soma Prime deals
  // exactly 3 to a level 101 Elite Frontier Lancer.
  const soma = weapon({ impact: 1.2, puncture: 4.8, slash: 6, critChance: 0, critMultiplier: 1 });
  const snap = snapshot([soma], [], [bombard]);
  const hit = hitEnemy(snap, build(snap, []), scaleEnemy(snap, bombard, 150));
  // Every type is floored to 1, so the hit is exactly 3 damage.
  close(hit.damagePerShotHealth, 3);
});

test('the floor does not apply to targets without armour', () => {
  const weak = weapon({ impact: 0.1, critChance: 0, critMultiplier: 1 });
  const snap = snapshot([weak], [], [dummy]);
  const hit = hitEnemy(snap, build(snap, []), scaleEnemy(snap, dummy, 1));
  close(hit.damagePerShotHealth, 0.1);
});

test('Condition Overload scales with the status types on the target', () => {
  // "+80% Melee Damage per Status Type affecting the target": the wiki's example is
  // 1 status -> +80%, 3 statuses -> +240%. The modifier has no condition of its own, and an
  // early return on that used to make it add nothing at all.
  const conditionOverload = mod('Condition Overload', 5, ['+80% Melee Damage per Status Type affecting the target'], { classes: ['Melee'] });
  const melee = { ...weapon({ slash: 100 }), category: 'melee', type: 'Sword', modClasses: ['Melee'] };
  const snap = snapshot([melee], [conditionOverload]);
  const at = (statusTypes: number) => resolveBuild(snap, {
    weapon: 'Test Weapon', mods: ['Condition Overload'], conditions: { statusTypes },
  }).damage.projectileTotal;
  close(at(1), 100 * 1.8);
  close(at(3), 100 * 3.4);
});


test('Eximus Overguard is a separate layer, neutral except Void', () => {
  // wiki (Enemy Level Scaling): base 12, q = level - 1, two curves blended between 45 and 50.
  close(overguardForLevel(150), 281865, 1e-9);
  const snap = snapshot([weapon({ void: 100, heat: 100, critChance: 0, statusChance: 0, fireRate: 1, magazineSize: 1, reloadTime: 0 })], []);
  const target = scaleEnemy(snap, dummy, 1, { overguard: 1000 });
  const resolved = resolveBuild(snap, { weapon: 'Test Weapon', mods: [] });
  const hit = hitEnemy(snap, resolved, target);
  // 100 Void x 1.5 + 100 Heat x 1.0 = 250 direct damage to Overguard; no armour, no crit.
  close(hit.overguard, 1000);
  close(hit.overguardDps, 250);
  // 1000 / 250 = 4 s of Overguard, then 1e6 health at 200/s.
  close(hit.timeToKill!, 4 + 1_000_000 / 200);
  assert.ok(hit.warnings.some((line) => /Overguard/.test(line)));
});

test('Archon attenuation caps damage per hit and per second', () => {
  // One shot of 1,000,000 would kill the 1,000,000-health dummy instantly. Archon caps it at
  // 460,000 per trigger and 935,000 per second, with 20% flat DR: 460,000 x 0.8 = 368,000.
  const snap = snapshot([weapon({ heat: 1_000_000, critChance: 0, statusChance: 0, fireRate: 1, magazineSize: 1, reloadTime: 0 })], []);
  const resolved = resolveBuild(snap, { weapon: 'Test Weapon', mods: [] });
  const plain = hitEnemy(snap, resolved, scaleEnemy(snap, dummy, 1));
  const capped = hitEnemy(snap, resolved, scaleEnemy(snap, dummy, 1), { attenuation: 'archon' });
  close(plain.timeToKill!, 1);
  // Wiki per-hit formula: 1M x 460k / (1M + 460k) = 315,068; x 0.8 flat DR = 252,054.
  close(capped.timeToKill!, 1_000_000 / ((1_000_000 * 460_000 / (1_000_000 + 460_000)) * 0.8));
  assert.equal(capped.attenuation?.id, 'archon');
  assert.ok(capped.warnings.some((line) => /attenuation archon/.test(line)));
});

test('Eidolon attenuation is automatic and health-relative', () => {
  // MDPI = 200% and MDPS = 100% of max health. A 5M hit on a 1M-health Eidolon is capped to
  // 1M per second, so it takes one second instead of one fifth.
  const eidolon: EnemyData = { ...dummy, name: 'Eidolon Teralyst' };
  const snap = snapshot([weapon({ heat: 5_000_000, critChance: 0, statusChance: 0, fireRate: 1, magazineSize: 1, reloadTime: 0 })], []);
  const resolved = resolveBuild(snap, { weapon: 'Test Weapon', mods: [] });
  const plain = hitEnemy(snap, resolved, scaleEnemy(snap, eidolon, 1), { attenuation: null });
  const capped = hitEnemy(snap, resolved, scaleEnemy(snap, eidolon, 1));
  close(plain.timeToKill!, 0.2);
  close(capped.timeToKill!, 1);
  assert.equal(capped.attenuation?.id, 'eidolon');
});

test('a chained Incarnon adds 75% links behind the primary target', () => {
  // Torid: 1 + 0.75 + 0.5625 + ... for five links = 3.2880859375.
  const snap = snapshot([weapon({ toxin: 100 })], []);
  snap.weapons['Test Weapon'].incarnonForm = stats({ toxin: 100 });
  snap.weapons['Test Weapon'].incarnonFormChain = { maxTargets: 5, falloff: 0.75 };
  const resolved = resolveBuild(snap, { weapon: 'Test Weapon', mods: [], incarnon: ['form'] });
  const hit = hitEnemy(snap, resolved, scaleEnemy(snap, dummy, 1), { targets: 6 });
  close(hit.multiTargetFactor, 3.2880859375);
  close(hit.multiTargetDps!, hit.totalDps * 3.2880859375);
  const single = hitEnemy(snap, resolved, scaleEnemy(snap, dummy, 1), { targets: 1 });
  assert.equal(single.multiTargetDps, null);
  assert.equal(single.multiTargetFactor, 1);
});

test('the per-hit attenuation formula accounts for multishot', () => {
  // Per pellet 500k, 2 pellets: 500k x 460k / (500k x 2 + 460k) = 239,583 per pellet,
  // 479,166 per trigger, x 0.8 flat DR.
  const snap = snapshot([weapon({ heat: 500_000, critChance: 0, statusChance: 0, fireRate: 1, magazineSize: 1, reloadTime: 0, multishot: 2 })], []);
  const resolved = resolveBuild(snap, { weapon: 'Test Weapon', mods: [] });
  const hit = hitEnemy(snap, resolved, scaleEnemy(snap, dummy, 1), { attenuation: 'archon' });
  const perPellet = 500_000 * 460_000 / (500_000 * 2 + 460_000);
  close(hit.timeToKill!, 1_000_000 / (perPellet * 2 * 0.8));
});

// ------------------------------------------------------------- wiki checks added with bruteforce

test('quantization rounds each type to 1/32 of base damage (wiki Damage/Calculation example)', () => {
  // 30 Impact / 30 Puncture / 40 Slash: scale 100/32 = 3.125, so 30 -> 10 x 3.125 = 31.25 and
  // 40 -> 13 x 3.125 = 40.625, total 103.125.
  const snap = snapshot([weapon({ impact: 30, puncture: 30, slash: 40 })], []);
  const resolved = resolveQuantized(snap, { weapon: 'Test Weapon', mods: [] });
  close(resolved.damage.perProjectile.impact ?? 0, 31.25);
  close(resolved.damage.perProjectile.puncture ?? 0, 31.25);
  close(resolved.damage.perProjectile.slash ?? 0, 40.625);
  close(resolved.damage.projectileTotal, 103.125);
});

test('quantization scales with damage mods: Serration is a plain multiplier on the quantized total', () => {
  // Wiki: a non-elemental bonus multiplies the numerator and the scale alike.
  const snap = snapshot([weapon({ impact: 30, puncture: 30, slash: 40 })], [serration]);
  const resolved = resolveQuantized(snap, { weapon: 'Test Weapon', mods: ['Serration'] });
  close(resolved.damage.projectileTotal, 103.125 * 2.65);
});

test('innate elements combine last in the hierarchy (wiki Damage)', () => {
  // Innate Electricity, Hellfire then Cryo Rounds: Heat + Cold pair first (Blast 90 + 90), the
  // innate Electricity is last and stays alone. Innate-first would have made Radiation.
  const snap = snapshot([weapon({ impact: 80, electricity: 20 })], [hellfire, cryoRounds]);
  const resolved = build(snap, ['Hellfire', 'Cryo Rounds']);
  close(resolved.damage.perProjectile.blast ?? 0, 180);
  close(resolved.damage.perProjectile.electricity ?? 0, 20);
  assert.equal(resolved.damage.perProjectile.radiation ?? 0, 0);
});

test('a mod of the innate element pulls the innate damage to its position (wiki: Amprex + Stormbringer)', () => {
  const snap = snapshot([weapon({ impact: 80, electricity: 20 })], [stormbringer, hellfire]);
  const resolved = build(snap, ['Stormbringer', 'Hellfire']);
  // Electricity (90 + innate 20) is first, Heat second: Radiation 200.
  close(resolved.damage.perProjectile.radiation ?? 0, 200);
  assert.equal(resolved.damage.perProjectile.electricity ?? 0, 0);
});

test('a repeated element keeps the position where it first appears (wiki: Thermite before Hellfire)', () => {
  // Heat (60 + 90) is placed at Thermite's slot and pairs with Cold: one Blast of 240, no stray Heat.
  const snap = snapshot([weapon({ impact: 100 })], [thermite, cryoRounds, hellfire]);
  const resolved = build(snap, ['Thermite Rounds', 'Cryo Rounds', 'Hellfire']);
  close(resolved.damage.perProjectile.blast ?? 0, 240);
  assert.equal(resolved.damage.perProjectile.heat ?? 0, 0);
});

test('brute force tries one slot order per distinct elemental pairing', () => {
  const elements: Record<string, 'heat' | 'cold' | 'toxin' | 'electricity'> = {
    Hellfire: 'heat', 'Cryo Rounds': 'cold', 'Infected Clip': 'toxin', Stormbringer: 'electricity', 'Thermite Rounds': 'heat',
  };
  const of = (name: string) => elements[name] ?? null;
  const mods = (names: string[]) => names.map((name) => ({ name }));
  assert.equal(elementalOrders(mods(['Serration', 'Hellfire']), of, []).length, 1);
  assert.equal(elementalOrders(mods(['Hellfire', 'Cryo Rounds']), of, []).length, 1);
  // Three elements: which two pair up (3 ways). Four: which pairs (3 ways), not 24 permutations.
  assert.equal(elementalOrders(mods(['Hellfire', 'Cryo Rounds', 'Infected Clip']), of, []).length, 3);
  assert.equal(elementalOrders(mods(['Hellfire', 'Cryo Rounds', 'Infected Clip', 'Stormbringer']), of, []).length, 3);
  // Two Heat mods are one element: still a single pairing with Cold.
  assert.equal(elementalOrders(mods(['Hellfire', 'Thermite Rounds', 'Cryo Rounds']), of, []).length, 1);
  // Innate elements come last, so two mod elements always pair with each other: one outcome.
  assert.equal(elementalOrders(mods(['Hellfire', 'Cryo Rounds']), of, ['toxin']).length, 1);
  // Three mod elements plus an innate fourth: the leftover mod element pairs with the innate one.
  assert.equal(elementalOrders(mods(['Hellfire', 'Cryo Rounds', 'Infected Clip']), of, ['electricity']).length, 3);
  // Every order keeps every mod.
  for (const order of elementalOrders(mods(['Serration', 'Hellfire', 'Cryo Rounds', 'Infected Clip']), of, [])) {
    assert.deepEqual(order.map((mod) => mod.name).sort(), ['Cryo Rounds', 'Hellfire', 'Infected Clip', 'Serration']);
  }
});

test('Steel Path multiplies health and shields by 2.5 and leaves armour alone', () => {
  const shielded: EnemyData = { ...bombard, shield: 200, pools: [{ type: 'Shield', category: 'shield', amount: 200 }, ...bombard.pools] };
  const snap = snapshot([weapon({ impact: 100 })], [], [shielded]);
  const normal = scaleEnemy(snap, shielded, 150);
  const steel = scaleEnemy(snap, shielded, 150, { steelPath: true });
  close(steel.health, normal.health * 2.5);
  close(steel.shield, normal.shield * 2.5);
  close(steel.armor, normal.armor);
  assert.equal(steel.steelPath, true);
  // Pools follow, so the damage engine sees the larger health.
  close(steel.pools.find((pool) => pool.category === 'health')!.current, normal.pools.find((pool) => pool.category === 'health')!.current * 2.5);
});

test('Eximus units raise their base health before level scaling (wiki Enemy_Level_Scaling)', () => {
  // Armoured unit, base 300: level 100 -> max(330, 0.25 x 1200 x (4.5 + 0.03 x 50)) = 1800.
  close(eximusBaseHealth(300, 100, true), 1800);
  // Level 10: the first step is 1, so 0.25 x 1200 = 300 loses to the 1.1x floor.
  close(eximusBaseHealth(300, 10, true), 330);
  // Above 100 the step is capped at 6; without shields or armour the factor is 0.375.
  close(eximusBaseHealth(300, 150, false), 0.375 * 1200 * 6);
  const snap = snapshot([weapon({ impact: 100 })], [], [bombard]);
  close(scaleEnemy(snap, bombard, 100, { eximus: true }).health, scaleEnemy(snap, bombard, 100).health * 6);
});

test('Techrot health uses its own curve (wiki: 1 + 15.0998 q^0.7 above the transition)', () => {
  const techrot: EnemyData = { ...bombard, faction: 'techrot', armor: 0, pools: [{ type: 'Flesh', category: 'health', amount: 300 }] };
  const snap = snapshot([weapon({ impact: 100 })], [], [techrot]);
  close(scaleEnemy(snap, techrot, 101).health, 300 * (1 + 15.0998 * Math.pow(100, 0.7)), 1e-5);
});

// ------------------------------------------------------------------ hit location and stacks

test('headshot model follows the wiki worked example: (3 + 1.5 x (3.5 + 0.75)) x (1 + 0.3 + 0.4)', () => {
  const acuity = mod('Primary Acuity', 5, ['+350% Weak Point Damage', '+350% Weak Point Critical Chance']);
  const deadhead = mod('Deadhead Test', 5, ['+30% to Headshot Multiplier']);
  const prowl = mod('Prowl Test', 5, ['+40% to Headshot Multiplier']);
  const seek = mod('Seek Test', 5, ['+75% Weak Point Damage']);
  const snap = snapshot([weapon({ impact: 100, critChance: 0 })], [acuity, deadhead, prowl, seek], [bombard]);
  const resolved = build(snap, ['Primary Acuity', 'Deadhead Test', 'Prowl Test', 'Seek Test'], { hit: 'head' });
  close(hitProfile(resolved, 'grineer').location, 15.9375);
  close(weakPointBase('techrot'), 1.5);
  // Bodyshots ignore all of it; Meticulous Aim's malus applies there instead.
  const meticulous = mod('Meticulous Aim', 5, ['+105% Headshot Damage', '-45% Bodyshot Damage']);
  const body = build(snapshot([weapon({ impact: 100 })], [meticulous]), ['Meticulous Aim'], { hit: 'body' });
  close(hitProfile(body, 'grineer').location, 0.55);
});

test('head crits double the critical multiplier; weak point crit chance only counts on heads', () => {
  const acuity = mod('Primary Acuity', 5, ['+350% Weak Point Critical Chance']);
  const snap = snapshot([weapon({ impact: 100, critChance: 0.2, critMultiplier: 2 })], [acuity]);
  const head = hitProfile(build(snap, ['Primary Acuity'], { hit: 'head' }), 'grineer');
  close(head.critChance, 0.2 * 4.5);
  close(head.averageCrit, 1 + 0.9 * (2 * 2 - 1));
  const body = hitProfile(build(snap, ['Primary Acuity'], { hit: 'body' }), 'grineer');
  close(body.critChance, 0.2);
  close(body.averageCrit, 1.2);
  // Corpus heads cannot be crit-headshot (wiki: Weak Point): still 3x, but crits stay x2.
  const corpus = hitProfile(build(snap, ['Primary Acuity'], { hit: 'head' }), 'corpus');
  close(corpus.location, 3);
  close(corpus.averageCrit, 1 + 0.9 * (2 - 1));
});

test('stack modes: none turns conditions off, max uses each cap, a non-stacking effect counts once', () => {
  const merciless = arcane('Primary Merciless', 'primary', 5, ['On Kill:', '+30% Damage for 4s. Stacks up to 12x.']);
  const bladed = mod('Bladed Rounds', 5, ['On Kill:', '+120% Critical Damage when Aiming for 9s']);
  const snap = snapshot([weapon({ impact: 100, critChance: 1 })], [bladed], [], { arcanes: [merciless] });
  const base = { arcanes: ['Primary Merciless'] };
  close(build(snap, [], { ...base, stackMode: 'none' }).damage.projectileTotal, 100);
  close(build(snap, [], { ...base, stackMode: 'max' }).damage.projectileTotal, 100 * (1 + 0.3 * 12));
  // onKill=12 drives Merciless to 12, but Bladed Rounds has no stack cap: it counts once, not 12x.
  const custom = build(snap, ['Bladed Rounds'], { ...base, conditions: { onKill: 12, aiming: true } });
  close(custom.critMultiplier, 2 * (1 + 1.2));
  // A per-source override wins over the mode.
  close(build(snap, [], { ...base, stackMode: 'max', sourceStacks: { 'Primary Merciless': 3 } }).damage.projectileTotal, 100 * 1.9);
});

test('max stacks leave weak-point conditions off on body shots', () => {
  const deadhead = arcane('Primary Deadhead', 'primary', 5, ['On Weak Point Kill:', '+120% Damage for 24s. Stacks up to 3x.']);
  const snap = snapshot([weapon({ impact: 100 })], [], [], { arcanes: [deadhead] });
  close(build(snap, [], { arcanes: ['Primary Deadhead'], stackMode: 'max', hit: 'body' }).damage.projectileTotal, 100);
  close(build(snap, [], { arcanes: ['Primary Deadhead'], stackMode: 'max', hit: 'head' }).damage.projectileTotal, 100 * (1 + 1.2 * 3));
});

test('simulation: Viral stacks build up and shorten the kill versus a fight with none', () => {
  const viralWeapon = weapon({ viral: 100, statusChance: 1, fireRate: 10, magazineSize: 100, critChance: 0 });
  const snap = snapshot([viralWeapon], [], [bombard]);
  const resolved = build(snap, []);
  const scaled = scaleEnemy(snap, bombard, 100);
  const plain = hitEnemy(snap, resolved, scaled);
  const simulated = hitEnemy(snap, resolved, scaled, { simulate: true });
  assert.ok(simulated.simulation);
  assert.ok((simulated.timeToKill ?? Infinity) < (plain.timeToKill ?? Infinity));
  // 10 procs a second for 6 s saturates Viral at its cap of 10.
  close(simulated.simulation!.atEnd.viral, 10);
});

test('simulation: Corrosive and Heat strip armour during the fight, Heat multiplicatively', () => {
  const corrosiveHeat = weapon({ corrosive: 50, heat: 50, statusChance: 2, fireRate: 10, magazineSize: 200, critChance: 0 });
  const snap = snapshot([corrosiveHeat], [], [bombard]);
  const scaled = scaleEnemy(snap, bombard, 200);
  const simulated = hitEnemy(snap, build(snap, []), scaled, { simulate: true });
  const end = simulated.simulation!.atEnd;
  assert.ok(end.corrosive > 9.9);
  assert.ok(end.heatStrip > 0.45);
  close(end.armor, scaled.armor * 0.2 * (1 - end.heatStrip), 1e-6);
});

test('simulation: under Overguard only Magnetic and Cold land, Cold at most 4 stacks (wiki: Overguard)', () => {
  const mixed = weapon({ viral: 50, magnetic: 30, cold: 20, statusChance: 3, fireRate: 10, magazineSize: 100 });
  const snap = snapshot([mixed], [], [bombard]);
  const scaled = scaleEnemy(snap, bombard, 50, { overguard: 1e9 });
  const end = hitEnemy(snap, build(snap, []), scaled, { simulate: true }).simulation!.atEnd;
  assert.equal(end.viral, 0);
  close(end.magnetic, 10);
  close(end.cold, 4);
});

test('simulation: the 10th Cold stack freezes the target at +1.0 crit multiplier (wiki: Cold Damage)', () => {
  // Cold procs 10 times a second: the target sits frozen most of the fight, so a 2x crit weapon
  // hits at 3x there, more than the +0.5 the first 9 stacks allow.
  const fight = (critChance: number) => {
    const snap = snapshot([weapon({ cold: 100, statusChance: 1, fireRate: 10, magazineSize: 1000, critChance, critMultiplier: 2 })], [], [dummy]);
    return hitEnemy(snap, build(snap, []), scaleEnemy(snap, dummy, 1), { simulate: true }).timeToKill!;
  };
  const ratio = fight(0) / fight(1);
  assert.ok(ratio > 2.7 && ratio <= 3, `crit gain ${ratio}`);
});

test('simulation: the automatic time step is fine enough that a finer one changes nothing', () => {
  // A fast-firing weapon on a long fight: the case coarse steps (estimate / 200) got wrong by ~1%.
  const snap = snapshot([weapon({ slash: 300, impact: 100, statusChance: 0.4, fireRate: 15, magazineSize: 100, reloadTime: 2 })], [], [dummy]);
  const resolved = build(snap, []);
  const scaled = scaleEnemy(snap, dummy, 1);
  const options = { factionMultiplier: 1, debuffs: {}, estimate: hitEnemy(snap, resolved, scaled, { simulate: false }).timeToKill };
  const auto = simulateKill(snap, resolved, scaled, options).timeToKill!;
  const fine = simulateKill(snap, resolved, scaled, { ...options, step: 0.001 }).timeToKill!;
  assert.ok(Math.abs(auto / fine - 1) < 5e-4, `auto ${auto}, fine ${fine}`);
});

test('simulation: Magnetic deals 3% of max shields per stack as Electricity when shields break (wiki: Magnetic Damage)', () => {
  const shielded: EnemyData = {
    id: 'Shielded', name: 'Shielded', faction: 'corpus', healthClass: 'Corpus', kind: 'Corpus', baseLevel: 1,
    // Shields that take well over 10 shots, so Magnetic is at its 10-stack cap when they break.
    health: 1_000_000, shield: 100_000, armor: 0,
    pools: [{ type: 'Shield', category: 'shield', amount: 100_000 }, { type: 'Flesh', category: 'health', amount: 1_000_000 }],
    toxinBypassesShields: true,
  };
  const snap = snapshot([weapon({ magnetic: 100, statusChance: 1, fireRate: 10, magazineSize: 1000 })], [], [shielded]);
  const scaled = scaleEnemy(snap, shielded, 1);
  const simulated = hitEnemy(snap, build(snap, []), scaled, { simulate: true }).simulation!;
  // 10 Magnetic stacks when the shields break: 30% of the maximum, as Electricity, nothing else deals Electricity.
  assert.ok(Math.abs((simulated.damageBySource.electricity ?? 0) - 0.3 * scaled.shield) < 0.01 * scaled.shield,
    `electricity ${simulated.damageBySource.electricity}`);
});

// ------------------------------------------------------------------ Archon Shards

test('Violet shard: +30% Primary Electricity, +10% per Crimson/Azure/Violet shard, combined last like innate', () => {
  const snap = snapshot([weapon({ impact: 100 })], [hellfire, cryoRounds]);
  const shards = [
    { color: 'violet', bonus: 'primaryElectricity' },
    { color: 'crimson', bonus: 'other' },
    { color: 'azure', bonus: 'other' },
  ] as const;
  const alone = build(snap, [], { shards: [...shards] });
  // 3 counted shards: 30% + 3 x 10% = 60% of the 100 base.
  close(alone.damage.perProjectile.electricity ?? 0, 60);
  // Mods first: Heat + Cold pair into Blast; the shard's Electricity stays on its own.
  const withMods = build(snap, ['Hellfire', 'Cryo Rounds'], { shards: [...shards] });
  close(withMods.damage.perProjectile.blast ?? 0, 180);
  close(withMods.damage.perProjectile.electricity ?? 0, 60);
  // Tauforged: 1.5x (the wiki's Violet examples, 45% + 15% per shard).
  const tau = build(snap, [], { shards: [{ color: 'violet', bonus: 'primaryElectricity', tauforged: true }] });
  close(tau.damage.perProjectile.electricity ?? 0, 60);
});

test('Crimson shard bonuses only touch their weapon class; Tauforged is 1.5x', () => {
  const snap = snapshot([weapon({ impact: 100, statusChance: 0.2 })], []);
  const primary = build(snap, [], { shards: [{ color: 'crimson', bonus: 'primaryStatus' }, { color: 'crimson', bonus: 'primaryStatus', tauforged: true }] });
  close(primary.statusChance, 0.2 * (1 + 0.25 + 0.375));
  const wrongClass = build(snap, [], { shards: [{ color: 'crimson', bonus: 'secondaryCrit' }] });
  close(wrongClass.critChance, 0.2);
});

test('Emerald shards raise the Corrosion cap and Toxin status damage', () => {
  const corrosiveWeapon = weapon({ corrosive: 100, statusChance: 3, fireRate: 10, magazineSize: 200, critChance: 0 });
  const snap = snapshot([corrosiveWeapon], [], [bombard]);
  const scaled = scaleEnemy(snap, bombard, 200);
  const plain = hitEnemy(snap, build(snap, []), scaled, { simulate: true });
  const emerald = hitEnemy(snap, build(snap, [], { shards: [{ color: 'emerald', bonus: 'corrosionStacks' }] }), scaled, { simulate: true });
  close(plain.simulation!.atEnd.corrosive, 10);
  close(emerald.simulation!.atEnd.corrosive, 12);
  close(corrosiveArmorMultiplier(12), 1 - 0.92);
  const toxin = snapshot([weapon({ toxin: 100, statusChance: 1 })], [], [bombard]);
  const base = hitEnemy(toxin, build(toxin, []), scaleEnemy(toxin, bombard, 50));
  const boosted = hitEnemy(toxin, build(toxin, [], { shards: [{ color: 'emerald', bonus: 'toxinStatusDamage' }] }), scaleEnemy(toxin, bombard, 50));
  close(boosted.dot.find((e) => e.type === 'toxin')!.tickDamage, base.dot.find((e) => e.type === 'toxin')!.tickDamage * 1.3);
});

test('Incarnon "Increase Base X" raises the base stat before mods; perks also work untransformed', () => {
  const pointStrike = mod('Point Strike', 5, ['+150% Critical Chance']);
  const snap = snapshot([{ ...weapon({ impact: 100, critChance: 0.2, critMultiplier: 2 }), incarnonForm: stats({ heat: 300, critChance: 0.4 }) }], [pointStrike], [], {});
  snap.incarnons = {
    'Test Weapon': [
      { tier: 'EVO4', name: 'Edge', effects: [{ target: 'critChance', op: 'add', value: 0.1, raw: 'Increase Base Critical Chance by +10%', base: true }], text: [] },
      { tier: 'EVO4', name: 'Form Only', effects: [{ target: 'critChance', op: 'add', value: 0.1, raw: 'x', base: true, form: 'incarnon' }], text: [] },
      { tier: 'EVO5', name: 'Prelude', effects: [{ target: 'critDamage', op: 'add', value: 3, raw: 'y', base: true, critChanceBelow: 0.5 }], text: [] },
    ],
  };
  const build = (mods: string[], incarnon: string[]) => resolveBuild(snap, { weapon: 'Test Weapon', mods, incarnon });
  // (0.2 + 0.1) x 2.5, not 0.2 x (1 + 1.5 + 0.1): the perk is base crit chance.
  close(build(['Point Strike'], ['EVO4:Edge']).critChance, 0.3 * 2.5);
  // Picking a perk does not transform the weapon; "form" does.
  assert.equal(build([], ['EVO4:Edge']).incarnonFormActive, false);
  close(build([], ['EVO4:Edge']).damage.projectileTotal, 100);
  assert.equal(build([], ['EVO4:Edge', 'form']).incarnonFormActive, true);
  // A form-only perk does nothing untransformed.
  close(build([], ['EVO4:Form Only']).critChance, 0.2);
  close(build([], ['EVO4:Form Only', 'form']).critChance, 0.5);
  // Prelude of Might: +3 base crit multiplier while crit chance stays under 50%.
  close(build([], ['EVO5:Prelude']).critMultiplier, 2 + 3);
  close(build(['Point Strike'], ['EVO5:Prelude']).critMultiplier, 2);
});

test('riven picker: 3 positives (at most one spliced) + 1 negative that may roll negative', () => {
  const snap = snapshot([weapon({ impact: 100 })], []);
  snap.rivenStats.rifle = { Damage: 1.65, Multishot: 0.9, Zoom: 0.6, 'Critical Chance': 1.5, 'Viral Damage': 0.9 };
  const rivens = enumerateRivens(snap, 'Test Weapon');
  // 10 positive triples: the 6 with Viral leave 2 negatives each, the 4 without leave 1.
  assert.equal(rivens.length, 6 * 2 + 4 * 1);
  assert.ok(rivens.every((riven) => riven.malus !== 'viral' && !riven.stats.includes(riven.malus!)));
  assert.ok(rivens.every((riven) => riven.roll === 1.1 && riven.rank === 8));
});

test('riven picker: each riven replaces the build mod it is worth most against, counts cover every riven', async () => {
  const snap = snapshot([weapon({ impact: 100, critChance: 0.2, critMultiplier: 2, statusChance: 0.3 })], [serration, hellfire, cryoRounds, infectedClip], [dummy]);
  snap.rivenStats.rifle = { Damage: 1.65, Multishot: 0.9, Zoom: 0.6, Recoil: 0.9, 'Critical Chance': 1.5, 'Viral Damage': 0.9 };
  const result = await rivenPicker(snap, { weapon: 'Test Weapon', mods: [{ name: 'Serration' }, { name: 'Hellfire' }, { name: 'Cryo Rounds' }], enemy: 'Dummy', level: 1 });
  assert.equal(Object.values(result.replacedCounts).reduce((sum, count) => sum + count, 0), result.rivens);
  assert.equal(result.picks.reduce((sum, pick) => sum + pick.equivalent, 0), result.rivens);
  // Zoom and recoil do nothing to damage: rivens differing only in those share a group.
  assert.ok(result.groups < result.rivens);
  for (let i = 1; i < result.picks.length; i++) {
    const best = (pick: typeof result.picks[number]) => Math.max(pick.score, pick.swap?.score ?? -Infinity);
    assert.ok(best(result.picks[i - 1]) >= best(result.picks[i]));
  }
  // The best riven beats the build as it is (a "+zoom +recoil -damage" one need not).
  assert.ok(result.picks[0].score > result.baseline.score);
  // The filter keeps only rivens with the stats the player has.
  const viral = await rivenPicker(snap, { weapon: 'Test Weapon', mods: [{ name: 'Serration' }, { name: 'Hellfire' }, { name: 'Cryo Rounds' }], enemy: 'Dummy', level: 1, stats: ['viral'] });
  assert.ok(viral.picks.length && viral.picks.every((pick) => pick.stats.includes('viral')));
});
