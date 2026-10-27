/**
 * Enemy stats at a given level.
 *
 * Level scaling follows wiki.warframe.com/w/Enemy_Level_Scaling: two endpoint curves
 * f1 (low levels) and f2 (high levels) blended with a smoothstep between level
 * gaps L=70 and U=80, evaluated in binary32 like the game does.
 *
 * Armor damage reduction follows wiki.warframe.com/w/Armor:
 *   DR = 90% × sqrt(armor / 2700)     while armor ≤ 2700
 *   DR = armor / (armor + 300)        above that (only reachable with buffs/debuffs)
 */
import type { EnemyData, HealthPool, Snapshot } from '../types.ts';
import { InputError } from '../errors.ts';

/** f32 rounding, because the game stores these values as binary32. */
const f32 = Math.fround;

interface Curve {
  c1: number;
  e1: number;
  c2: number;
  e2: number;
}

/** Health scaling coefficients per faction family. */
const HEALTH_CURVES: Record<string, Curve> = {
  grineer: { c1: 0.015, e1: 2.12, c2: 10.7332, e2: 0.72 },
  scaldra: { c1: 0.015, e1: 2.12, c2: 10.7332, e2: 0.72 },
  corpus: { c1: 0.015, e1: 2.12, c2: 13.4165, e2: 0.55 },
  infested: { c1: 0.0225, e1: 2.12, c2: 16.0998, e2: 0.72 },
  corrupted: { c1: 0.015, e1: 2.1, c2: 10.7332, e2: 0.685 },
  orokin: { c1: 0.015, e1: 2.1, c2: 10.7332, e2: 0.685 },
  anarchs: { c1: 0.015, e1: 2.1, c2: 10.7332, e2: 0.685 },
  techrot: { c1: 0.02, e1: 2.12, c2: 15.0998, e2: 0.7 },
  murmur: { c1: 0.015, e1: 2.0, c2: 10.7332, e2: 0.5 },
  sentient: { c1: 0.015, e1: 2.0, c2: 10.7332, e2: 0.5 },
  neutral: { c1: 0.015, e1: 2.0, c2: 10.7332, e2: 0.5 },
  tenno: { c1: 0.015, e1: 2.0, c2: 10.7332, e2: 0.5 },
};

const SHIELD_CURVES: Record<string, Curve> = {
  corpus: { c1: 0.02, e1: 1.76, c2: 2, e2: 0.76 },
  techrot: { c1: 0.02, e1: 1.76, c2: 3.5, e2: 0.76 },
  corrupted: { c1: 0.02, e1: 1.75, c2: 2, e2: 0.75 },
  orokin: { c1: 0.02, e1: 1.75, c2: 2, e2: 0.75 },
  anarchs: { c1: 0.02, e1: 1.75, c2: 2, e2: 0.75 },
  default: { c1: 0.02, e1: 1.75, c2: 1.6, e2: 0.75 },
};

/** Armor has a single curve shared by every faction. */
const ARMOR_CURVE: Curve = { c1: 0.005, e1: 1.75, c2: 0.4, e2: 0.75 };

const TRANSITION_LOW = 70;
const TRANSITION_HIGH = 80;

/** Blends the two endpoint curves with the smoothstep the game uses. */
function curveMultiplier(curve: Curve, levelGap: number): number {
  const q = f32(Math.max(0, levelGap));
  const f1 = f32(1 + f32(curve.c1 * f32(Math.pow(q, curve.e1))));
  const f2 = f32(1 + f32(curve.c2 * f32(Math.pow(q, curve.e2))));
  const t = f32(Math.min(1, Math.max(0, f32(f32(q - TRANSITION_LOW) / f32(TRANSITION_HIGH - TRANSITION_LOW)))));
  const s = f32(f32(t * t) * f32(3 - f32(2 * t)));
  return f32(f1 + f32(f32(f2 - f1) * s));
}

export interface ScaledPool extends HealthPool {
  /** Current amount at the requested level. */
  current: number;
}

export interface ScaledEnemy {
  enemy: EnemyData;
  level: number;
  health: number;
  shield: number;
  armor: number;
  /** Overguard at this level: 0 unless the caller asked for an Eximus or a custom amount. */
  overguard: number;
  /** Steel Path multipliers are applied to health and shields. */
  steelPath: boolean;
  /** Armor after damage-type and status effects, per incoming damage type. */
  pools: ScaledPool[];
}

export interface ScaleOptions {
  /** An Eximus unit: base Overguard 12, scaled by level. */
  eximus?: boolean;
  /** Explicit Overguard amount, used as-is (bosses, Deep Archimedea, a known value). */
  overguard?: number;
  /**
   * The Steel Path: health and shields x2.5 (wiki: The_Steel_Path). Armour is not multiplied
   * since Update 29.10. The +100 level is not added here: `level` is the enemy's actual level.
   */
  steelPath?: boolean;
}

/** Health and shield multiplier on the Steel Path. */
export const STEEL_PATH_MULTIPLIER = 2.5;

/** Level steps shared by the Eximus base health and base shield increase (wiki: Enemy_Level_Scaling). */
function eximusStep(level: number): number {
  if (level <= 15) return 1;
  if (level <= 25) return 1 + 0.025 * (level - 15);
  if (level <= 35) return 1.25 + 0.125 * (level - 25);
  if (level <= 50) return 2.5 + (2 / 15) * (level - 35);
  if (level <= 100) return 4.5 + 0.03 * (level - 50);
  return 6;
}

/**
 * Eximus base health, before faction level scaling.
 * Units with shields or armour take 0.25 × (base + 900) per step, the others 0.375.
 */
export function eximusBaseHealth(baseHealth: number, level: number, hasShieldOrArmor: boolean): number {
  const factor = hasShieldOrArmor ? 0.25 : 0.375;
  return Math.max(baseHealth * 1.1, factor * (baseHealth + 900) * eximusStep(level));
}

/** Eximus base shields, before faction level scaling. */
export function eximusBaseShield(baseShield: number, level: number): number {
  return Math.max(baseShield * 1.1, baseShield * eximusStep(level));
}

/**
 * Eximus Overguard at a level.
 *
 * wiki: Overguard is independent of the enemy's health/shield scaling and the same for every
 * Eximus type. Its base is 12 and it scales with q = level - 1 on two curves, blended with
 * smoothstep between 45 and 50 (not the 70/80 used by health). At level 150 that is ~282k.
 */
export function overguardForLevel(level: number, base = 12): number {
  const q = f32(Math.max(0, level - 1));
  const f1 = f32(1 + f32(0.0015 * f32(Math.pow(q, 4))));
  const f2 = f32(1 + f32(260 * f32(Math.pow(q, 0.9))));
  const t = f32(Math.min(1, Math.max(0, f32(f32(q - 45) / f32(50 - 45)))));
  const s = f32(f32(t * t) * f32(3 - f32(2 * t)));
  return base * f32(f1 + f32(f32(f2 - f1) * s));
}

/** Scales an enemy's pools to the requested level. */
export function scaleEnemy(
  snapshot: Snapshot,
  enemy: EnemyData,
  level: number,
  options: ScaleOptions = {},
): ScaledEnemy {
  // Every caller passes user input through here; a NaN or overflowing level used to come out as
  // a target with no health, killed in 0 s. The game caps enemy level at 9999.
  if (!Number.isFinite(level) || level < 1 || level > 9999) {
    throw new InputError(`enemy level must be a number from 1 to 9999, got ${level}`, 'invalid_level');
  }
  const faction = (enemy.faction ?? 'neutral').toLowerCase();
  const q = Math.max(0, level - enemy.baseLevel);

  const healthCurve = HEALTH_CURVES[faction] ?? HEALTH_CURVES.neutral;
  const shieldCurve = SHIELD_CURVES[faction] ?? SHIELD_CURVES.default;

  // An Eximus raises its base health/shields before the faction curve scales them.
  const baseHealth = options.eximus ? eximusBaseHealth(enemy.health, level, enemy.shield > 0 || enemy.armor > 0) : enemy.health;
  const baseShield = options.eximus ? eximusBaseShield(enemy.shield, level) : enemy.shield;
  const steelPath = options.steelPath ? STEEL_PATH_MULTIPLIER : 1;
  const health = baseHealth * curveMultiplier(healthCurve, q) * steelPath;
  const shield = baseShield * curveMultiplier(shieldCurve, q) * steelPath;
  // Level scaling clamps enemy armor to the 200..2700 band (wiki: Armor).
  const armorFromLevel = enemy.armor * curveMultiplier(ARMOR_CURVE, q);
  const armor = armorFromLevel > 0 ? Math.min(2700, Math.max(200, armorFromLevel)) : 0;

  const explicitOverguard = Number(options.overguard);
  const overguard = options.overguard !== undefined && Number.isFinite(explicitOverguard)
    ? Math.max(0, explicitOverguard)
    : options.eximus
      ? overguardForLevel(level)
      : 0;

  const pools: ScaledPool[] = enemy.pools.map((pool) => ({
    ...pool,
    current: pool.amount * (pool.category === 'shield' ? shield / Math.max(1, enemy.shield) : health / Math.max(1, enemy.health)),
  }));

  return { enemy, level, health, shield, armor, overguard, pools, steelPath: Boolean(options.steelPath) };
  void snapshot;
}

/**
 * Damage reduction from armor.
 *
 * Damage 3.0 removed the armour-type modifiers (Update 36), so there is no longer a question
 * of how a +50% interacts with armour: the faction modifier multiplies the damage and the
 * armour value only sets DR. The old `--armor-model` switch modelled a Damage 2.0 mechanic
 * that no longer exists and was dropped with this change.
 */
export function armorDamageReduction(armor: number): number {
  if (armor <= 0) return 0;
  if (armor <= 2700) return Math.min(0.9, 0.9 * Math.sqrt(armor / 2700));
  return armor / (armor + 300);
}
