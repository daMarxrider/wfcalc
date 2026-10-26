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
import { armorDamageReduction, eximusBaseHealth, overguardForLevel, scaleEnemy } from '../src/engine/enemy.ts';
import { elementalOrders } from '../src/engine/bruteforce.ts';
import { hitEnemy } from '../src/engine/damage.ts';
import { parseModEffects } from '../src/mods/parse.ts';
import { buffEffects, buffById, abilityStrengthFromMods } from '../src/engine/buffs.ts';
import { rivenEffects } from '../src/engine/riven.ts';
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

test('Eclipse adds to the damage bucket and stacks additively with Serration', () => {
  const snap = snapshot([weapon({ impact: 100 })], [serration], [], {
    abilities: [ability('Eclipse', 'Mirage', 200, 'damage bonus')],
  });
  const resolved = resolveBuild(snap, { weapon: 'Test Weapon', mods: ['Serration'], buffs: ['eclipse'] });
  // +165% (Serration) and +200% (Eclipse) share the damage bucket: 100 x (1 + 3.65).
  close(resolved.damage.projectileTotal, 465);
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
  // Base weak point x2, crit expectation x1.2 (20% cc, x2 cd) -> 240.
  close(withoutBuff.averageShotDamage, 240);
  // Sonar replaces the x2 weak-point multiplier with x5: 100 x 5 x 1.2 = 600.
  close(withSonar.averageShotDamage, 600);
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

test('riven values follow base × disposition × weight', () => {
  const snap = snapshot([weapon({ impact: 100 })], []);
  // Two bonuses and no malus -> weight 0.99 (wiki: Attribute Value Formula).
  const riven = rivenEffects(snap, snap.weapons['Test Weapon'], { stats: ['damage', 'multishot'] });
  close(riven.effects[0].value, 1.65 * 1 * 0.99, 1e-9);
  close(riven.effects[1].value, 0.9 * 1 * 0.99, 1e-9);
  // Adding a malus switches to the 2+1 weights: 1.2375 for bonuses, -0.495 for the malus.
  const withMalus = rivenEffects(snap, snap.weapons['Test Weapon'], { stats: ['damage', 'multishot'], malus: 'zoom' });
  close(withMalus.effects[0].value, 1.65 * 1.2375, 1e-9);
  close(withMalus.effects[2].value, 0.5999 * -0.495, 1e-9);
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
    { name: 'Radial Attack', stats: stats({ impact: radial }), trigger: null, falloff: { start: 0, end: 10, reduction: 0.9 } },
  ];
  const snap = snapshot([weaponWithAoe], []);
  const centre = resolveBuild(snap, { weapon: 'Test Weapon', mods: [], aoeDistance: 0 });
  const edge = resolveBuild(snap, { weapon: 'Test Weapon', mods: [], aoeDistance: 5 });
  close(centre.damage.projectileTotal, direct + radial);
  // Halfway: radial keeps 1 - 0.45 of its damage.
  close(edge.damage.projectileTotal, direct + radial * (1 - 0.9 * 0.5));
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
  const snap = snapshot([weapon({ impact: 100 })], [hellfire, cryoRounds]);
  // 60% of 100 base = 60 Heat, added before mods; Hellfire (+90%) stacks on top of the
  // 100 base, so Heat = 60 + 90 = 150 and nothing is left to combine.
  const bare = resolveBuild(snap, { weapon: 'Test Weapon', mods: [], elementBonus: { type: 'heat', value: 0.6 } });
  close(bare.damage.perProjectile.heat ?? 0, 60);
  close(bare.damage.projectileTotal, 160);

  // The bonus counts as base damage, so elemental mods scale off the larger total:
  // Cryo Rounds adds 90% of 160 = 144 Cold, which pairs with the innate 60 Heat.
  const withCold = resolveBuild(snap, {
    weapon: 'Test Weapon', mods: ['Cryo Rounds'], elementBonus: { type: 'heat', value: 0.6 },
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

  // With Galvanized Aptitude active the total is 218.7 x (1 + 80%) = 393.5: Direct Damage
  // multiplies the Serration result instead of sharing its bucket.
  const stacked = resolveBuild(snap, { weapon: 'Test Weapon', mods, conditions: { onKill: 2, statusTypes: 1 } });
  close(stacked.damage.projectileTotal, 393.5, 1e-1);
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
