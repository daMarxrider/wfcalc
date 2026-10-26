/** Core types shared by the data pipeline, the engine and the UIs. */

export const DAMAGE_TYPES = [
  'impact',
  'puncture',
  'slash',
  'heat',
  'cold',
  'electricity',
  'toxin',
  'blast',
  'corrosive',
  'gas',
  'magnetic',
  'radiation',
  'viral',
  'true',
  'void',
  'tau',
] as const;

export type DamageType = (typeof DAMAGE_TYPES)[number];

/** The three physical (IPS) damage types. */
export const PHYSICAL_TYPES = ['impact', 'puncture', 'slash'] as const;
export type PhysicalType = (typeof PHYSICAL_TYPES)[number];

/** Single elements that pair up into combined elements. */
export const BASE_ELEMENTS = ['heat', 'cold', 'electricity', 'toxin'] as const;
export type BaseElement = (typeof BASE_ELEMENTS)[number];

/** Which two base elements make each combined element. */
export const ELEMENT_COMBINATIONS: Record<string, [BaseElement, BaseElement]> = {
  blast: ['heat', 'cold'],
  corrosive: ['electricity', 'toxin'],
  gas: ['heat', 'toxin'],
  magnetic: ['cold', 'electricity'],
  radiation: ['heat', 'electricity'],
  viral: ['cold', 'toxin'],
};

export const FACTIONS = ['grineer', 'corpus', 'infested', 'orokin', 'murmur', 'sentient', 'narmer', 'tenno'] as const;
export type Faction = (typeof FACTIONS)[number];

/**
 * Damage-type modifiers: percentage points, e.g. +50 or -50.
 * Indexed `modifiers[damageType][healthClass]`, using the Damage 3.0 health classes
 * (Grineer, Corpus, Orokin, Overguard, ...) that replaced the Damage 2.0 health types
 * in Update 36.
 */
export type ModifierTable = Record<string, Record<string, number>>;

export interface HealthPool {
  /**
   * Pool name from the data export, e.g. "Cloned Flesh" or "Alloy Armor".
   * Since Damage 3.0 these no longer select a damage modifier: the enemy's
   * `healthClass` does. They still say which pools exist and how big they are.
   */
  type: string;
  /** Wiki category: health, armor or shield (each is modified differently). */
  category: 'health' | 'armor' | 'shield' | 'object';
  amount: number;
}

export interface EnemyData {
  id: string;
  name: string;
  faction: string | null;
  /**
   * Damage 3.0 health class (Grineer, Kuva Grineer, Corpus, Orokin, Sentient, ...).
   * Every pool of the enemy takes the same modifier, which is the whole point of the
   * simplified faction resistances introduced in Update 36.
   */
  healthClass: string;
  kind: string | null;
  /** Base level as used by the scaling curves (1 for almost every enemy). */
  baseLevel: number;
  health: number;
  shield: number;
  armor: number;
  pools: HealthPool[];
  /** True when Toxin damage bypasses this enemy's shields. */
  toxinBypassesShields: boolean;
}

/** Weapon stat block: unmodded values used as the engine's input. */
export interface WeaponStats {
  impact: number;
  puncture: number;
  slash: number;
  heat: number;
  cold: number;
  electricity: number;
  toxin: number;
  blast: number;
  corrosive: number;
  gas: number;
  magnetic: number;
  radiation: number;
  viral: number;
  true: number;
  void: number;
  tau: number;
  critChance: number;
  critMultiplier: number;
  statusChance: number;
  /** Shots (or pellets) per second, as the arsenal displays it. */
  fireRate: number;
  /** Projectiles per trigger pull. For shotguns this is the pellet count. */
  multishot: number;
  magazineSize: number;
  reloadTime: number;
  /** Melee only: heavy attack wind-up in seconds. */
  heavyAttackSpeed?: number;
}

export interface WeaponMode {
  name: string;
  stats: WeaponStats;
  /** How this mode is triggered: Auto, Semi, Charge, Burst, Held... */
  trigger: string | null;
  /** Average area-of-effect radius in meters, when the mode explodes. */
  aoeRadius?: number;
  /**
   * Damage falloff for an AoE attack: full damage inside `start` metres, dropping
   * linearly by `reduction` (fraction) until `end` metres.
   */
  falloff?: { start: number; end: number; reduction: number };
  /** Damage of the AoE part, kept separately from the direct hit. */
  aoeDamage?: number;
}

export interface WeaponData {
  id: string;
  name: string;
  /** Broad bucket: primary, secondary, melee, archgun, archmelee, sentinel weapon. */
  category: string;
  /** Narrow in-game class, decides which mods fit: Rifle, Shotgun, Bow, Sniper, Pistol, ... */
  type: string;
  masteryRank: number;
  /** Riven disposition as stars, 1 to 5 (for display). */
  disposition: number;
  /** The game's disposition multiplier for riven stat values (0.5 - 1.55). */
  dispositionMultiplier: number;
  polarities: string[];
  exilusPolarity: string | null;
  /** Which mod-compatibility class this weapon accepts. */
  modClasses: string[];
  /** Firing trigger from the game data: Auto, Semi, Charge, Held... */
  trigger?: string;
  /** WFCD artwork filename, so a snapshot-only install still shows the weapon. */
  image?: string | null;
  /** Melee stance polarity, which decides the stance slot's capacity bonus. */
  stancePolarity?: string | null;
  /**
   * The Incarnon form's own stats, when the weapon has one. WFCD does not export it; it comes
   * from the wiki's weapon database. Mods apply on top of these, as in the game.
   */
  incarnonForm?: WeaponStats;
  /**
   * Extra hits the transformed weapon fires on the same shot ("Incarnon Form AoE", the melee
   * forms' "Spectral Axe Explosion"). The single-profile model adds only the direct hit, so
   * they are kept here to be reported instead of silently dropped.
   */
  incarnonFormExtra?: Array<{
    name: string;
    damage: Partial<Record<DamageType, number>>;
    falloff?: { start: number; end: number; reduction: number };
  }>;
  /**
   * Share of the transformed profile's base damage that comes from the direct hit (0..1).
   * Direct-only multipliers (Condition Overload, Galvanized Aptitude) scale by it, because the
   * wiki says the radial hit does not take them.
   */
  incarnonFormDirectShare?: number;
  /** The form chains to nearby enemies (Torid: 5 links at 75% of the previous link). */
  incarnonFormChain?: { maxTargets: number; falloff: number } | null;
  /**
   * The form fires a spectral projectile instead of swinging the weapon. The wiki states that
   * those hits ignore melee damage bonuses (Pressure Point, Arcane Fury, the stance and the
   * combo multiplier) while still taking elemental, faction, crit, status and Condition
   * Overload bonuses.
   */
  incarnonFormSpectral?: boolean;
  /** Flavour text from the game data, shown under the weapon name. */
  description?: string;
  /** The arsenal stat block: what the game shows as the weapon's damage. */
  stats: WeaponStats;
  /** Alternative fire modes (alt-fire, charged, Incarnon) when the game exposes them. */
  modes: WeaponMode[];
  /** Riven mod capacity: most weapons have 1 slot. */
  hasRivenSlot: boolean;
}

/**
 * One modifier produced by a mod: a number applied to a stat axis.
 * `target` narrows the axis (which element, which physical type, which faction).
 */
export type EffectTarget =
  | 'baseDamage'
  | 'multishot'
  | 'critChance'
  | 'critDamage'
  | 'statusChance'
  | 'statusDuration'
  | 'statusDamage'
  | 'fireRate'
  | 'reloadSpeed'
  | 'magazine'
  | 'ammoMax'
  | 'punchThrough'
  | 'accuracy'
  | 'recoil'
  | 'zoom'
  | 'heavyAttackSpeed'
  | 'comboDuration'
  | 'headshotMultiplier'
  | string;

/** What the effect multiplies into. `add` accumulates in a (1 + Σ) bucket. */
export type EffectOp = 'add' | 'mult' | 'convert' | 'flat';

export interface Effect {
  /** Stat axis this effect touches. */
  target: EffectTarget;
  /** Damage type, when the target is an element ('heat', 'viral'...) or a physical type. */
  element?: DamageType;
  /** Faction, when the target is a faction damage bonus. `all` = every faction (Roar). */
  faction?: Faction | 'all';
  op: EffectOp;
  /** Fraction, e.g. 1.65 for +165%. Faction bonuses store x-1. */
  value: number;
  /** Condition that must be met for the effect to apply, if any. */
  condition?: string;
  /** True when the effect scales with the number of status types on the target. */
  perStatusType?: boolean;
  /** True when the value multiplies by the melee combo multiplier (Blood Rush, Weeping Wounds). */
  scalesWithCombo?: boolean;
  /** True when the mod's text says "(x2 for Bows)": the value doubles on bows. */
  doublesForBows?: boolean;
  /** True when the value is a flat amount (e.g. ``+1.2 Punch Through``), not a fraction. */
  flat?: boolean;
  /** Maximum stacks of a stacking effect. */
  maxStacks?: number;
  /** Converted-into damage type, for `convert` effects. */
  convertsTo?: DamageType;
  /** Original text, for display. */
  raw: string;
}

export interface ModData {
  id: string;
  name: string;
  /** WFCD type: "Primary Mod", "Melee Mod", "Warframe Mod", ... */
  category: string;
  /** In-game compatibility class from the wiki: Rifle, Shotgun, Bow, Aura, WARFRAME... */
  classes: string[];
  polarity: string | null;
  rarity: string | null;
  baseDrain: number;
  maxRank: number;
  /** Max-rank description text (wiki). */
  description: string;
  /**
   * The headline stat of every rank, e.g. ["+10% Damage", "+20% Damage", ...]. Optional so
   * older snapshots still load; when present the card shows the value at the equipped rank
   * instead of the max-rank text.
   */
  levels?: string[];
  /** Effects at max rank. Per-rank scaling is `value * rank / maxRank` for linear mods. */
  effects: Effect[];
  /** Wiki filename of the full in-game card (frame, name, stat), e.g. "SerrationMod.png". */
  cardImage: string | null;
  /** WFCD artwork filename, served by /img when the export is not present locally. */
  image?: string | null;
  /** True when some lines could not be mapped and are not known utility. */
  partial: boolean;
  /** Lines that are real effects this model cannot use (movement, healing, slide attacks). */
  outOfScopeLines: string[];
  /** Mods that cannot be equipped together with this one. */
  incompatible: string[];
  /** Mod set this mod belongs to, if any. */
  set: string | null;
  /** Wiki upgrade-type constants, useful for debugging and for the long tail. */
  upgradeTypes: string[];
  isAugment: boolean;
  isRiven: boolean;
  /** Exilus mods only fit the Exilus slot; the wiki category is the only source for this. */
  isExilus?: boolean;
  /** Conclave (PvP) mods are excluded from PvE builds. */
  conclave: boolean;
}

export interface ArcaneData {
  id: string;
  name: string;
  category: string;
  rarity: string | null;
  maxRank: number;
  description: string;
  effects: Effect[];
  /** Where it goes: 'warframe', 'primary', 'secondary', 'melee', 'operator'... */
  slot: string | null;
}

export interface WarframeData {
  id: string;
  name: string;
  health: number;
  shield: number;
  armor: number;
  energy: number;
  sprintSpeed: number;
  abilities: string[];
}

/** One labelled stat from an ability or augment infobox, at max rank. */
export interface AbilityStat {
  label: string;
  max: number | null;
}

/** Numbers for an ability that can buff a weapon. Mechanics live in src/engine/buffs.ts. */
export interface AbilityData {
  ability: string;
  frame: string;
  page: string;
  kind: 'ability' | 'augment';
  /** Max-rank buff value (first stat of the infobox). */
  value: number | null;
  segments: AbilityStat[];
  duration: number | null;
  range: number | null;
  /** True when the Helminth can transfer this ability to another Warframe. */
  subsumable: boolean;
}

/** One choice inside an Incarnon evolution tier. */
/** An ability that deals damage on its own, from the wiki's infobox. */
export interface AbilityModeData {
  damageType: DamageType | null;
  baseDamage: number | null;
  damageComponents?: Array<{ type: DamageType; amount: number }> | null;
  statusProcs?: Array<{ type: DamageType; stacks: number; seedFraction?: number; seed?: number }> | null;
  /** Alternative modes (Thermal Sunder tap/hold), keyed by the mode name. */
  modes?: Record<string, AbilityModeData> | null;
  /** A status that ramps over the cast (Spores' Corrosive), with expected procs per second. */
  statusRamp?: { type: DamageType; procsPerSecond: number; maxStacks: number } | null;
  /** Damage falloff with distance from the cast point (Discharge: 50% at max range). */
  distanceFalloff?: { start: number; end: number; reduction: number } | null;
  perSecond?: boolean;
  durationSeconds?: number | null;
  extraDot?: { perSecond: number; damageType: string | null; seconds: number } | null;
}

export interface DamageAbilityData {
  frame: string;
  ability: string;
  /** Null for an ability kept only for its armour strip. */
  damageType: DamageType | null;
  /** Damage at 100% Ability Strength, max rank. Null when the ability deals none. */
  baseDamage: number | null;
  /** Direct damage split across types when one type is not enough (Inferno, Fireball). */
  damageComponents?: Array<{ type: DamageType; amount: number }> | null;
  radius: number | null;
  /**
   * Armour strip at 100% Ability Strength: a fraction of the total, or a flat number of points.
   * Ability Strength scales both, and it is the weapon that benefits, not the ability.
   */
  armorStrip?: { mode: 'percent' | 'flat'; value: number } | null;
  /** True when the base damage is per second rather than per cast (Miasma, Thermal Sunder). */
  perSecond?: boolean;
  /** How long the effect lasts, in seconds: ticks for a per-second ability, ring lifetime. */
  durationSeconds?: number | null;
  /** A second, ticking component alongside the direct hit (Inferno's ring of fire). */
  extraDot?: { perSecond: number; damageType: string | null; seconds: number } | null;
  /**
   * Status effects the ability guarantees on cast. `seedFraction` is the share of the ability's
   * damage that seeds the DoT (Inferno's meteorite is half Heat); omitted means all of it.
   * Viral has no DoT: it amplifies health damage instead.
   */
  statusProcs?: Array<{ type: DamageType; stacks: number; seedFraction?: number; seed?: number }> | null;
  /** Alternative modes (Thermal Sunder tap/hold), keyed by the mode name. */
  modes?: Record<string, AbilityModeData> | null;
  /** A status that ramps over the cast (Spores' Corrosive), with expected procs per second. */
  statusRamp?: { type: DamageType; procsPerSecond: number; maxStacks: number } | null;
  /** Damage falloff with distance from the cast point (Discharge: 50% at max range). */
  distanceFalloff?: { start: number; end: number; reduction: number } | null;
}

export interface IncarnonOption {
  tier: string;
  name: string;
  /** Effects the parser could map; perks that are mechanics keep their text only. */
  effects: Array<{
    target: string;
    element?: DamageType;
    faction?: Faction;
    op: string;
    value: number;
    raw: string;
    flat?: boolean;
  }>;
  /** Perk text as the wiki writes it, for display. */
  text: string[];
}

/** Set Mod bonus: either scales the set's own mods, or is an effect per pieces equipped. */
export interface SetBonus {
  set: string;
  kind: 'amplify' | 'table';
  /** amplify: pieces equipped -> mod name (or "*") -> percentage bonus. */
  amplify?: Record<string, Record<string, number>>;
  /** table: pieces equipped -> value (fraction). */
  table?: Record<string, number>;
  description: string;
}

export interface Snapshot {
  version: number;
  generatedAt: string;
  gameVersion: string;
  weapons: Record<string, WeaponData>;
  mods: Record<string, ModData>;
  arcanes: Record<string, ArcaneData>;
  warframes: Record<string, WarframeData>;
  /** Ability numbers used by the buff registry (Roar, Eclipse, elemental augments...). */
  abilities: Record<string, AbilityData>;
  /**
   * Riven base values per weapon class (`rifle`, `shotgun`, `pistol`, `archgun`, `melee`),
   * keyed by attribute label as the wiki writes it ("Critical Chance", "Damage vs. Grineer").
   * Percentages are already fractions; multipliers and flat values are as written.
   */
  rivenStats: Record<string, Record<string, number>>;
  /** Incarnon evolution trees by weapon name. */
  incarnons: Record<string, IncarnonOption[]>;
  /** Damage-dealing abilities, keyed by ability name. Optional: older snapshots lack it. */
  damageAbilities?: Record<string, DamageAbilityData>;
  /** Set Mod bonuses, keyed by set name. */
  setBonuses: Record<string, SetBonus>;
  /**
   * Primary Compression per weapon attack (wiki table: radius, how well the arcane reads it, and
   * whether its bonus multiplies or adds to other damage bonuses). Optional: older snapshots lack it.
   */
  compression?: Record<string, CompressionEntry[]>;
  enemies: Record<string, EnemyData>;
  /** damage type -> health class -> percentage points */
  modifiers: ModifierTable;
  /** Pool type -> category, so enemies can reference types without repeating them. */
  healthTypes: Record<string, 'health' | 'armor' | 'shield' | 'object'>;
}

export interface CompressionEntry {
  attack: string;
  /** Share of the radius loss the arcane actually credits (1 = as intended). */
  effectiveness: number;
  /** How the bonus combines with other damage bonuses. */
  stacking: 'multiplies' | 'adds';
  /** Base explosion radius in metres. */
  radius: number;
}
