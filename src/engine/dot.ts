/**
 * Damage over time from weapon status effects.
 *
 * From wiki.warframe.com/w/Damage_over_Time and Damage/Calculation:
 *
 *   tick = (seed + 1) × C × M
 *
 *   seed = the modded damage of that type from the hit (total damage for Bleed)
 *   C    = 0.35 for Slash, 0.5 for Heat / Electricity / Toxin / Gas
 *   M    = status damage bonuses × faction damage, applied a second time
 *          × the critical multiplier of the hit that applied it (wiki: "DoT Damage Scaling")
 *
 * Tick counts over the effect's duration:
 *
 *   | type        | ticks | notes                                  |
 *   | Slash       | 6     | True damage, ignores armour            |
 *   | Heat        | 6     |                                        |
 *   | Toxin       | 6     | bypasses shields where applicable      |
 *   | Electricity | 6     |                                        |
 *   | Gas         | 6     |                                        |
 *   | Blast       | 1     | detonation at 2s, not a real DoT       |
 *
 * Procs arrive at `statusChance × multishot × damageShare` per trigger pull, and each
 * proc is an independent instance, so the steady-state DoT is
 * `procsPerSecond × tickDamage × ticks`.
 */
import { type DamageType, type Snapshot } from '../types.ts';
import type { ResolvedBuild } from './build.ts';
import { armorDamageReduction, type ScaledEnemy } from './enemy.ts';
import { hitProfile } from './hit.ts';

/** Damage types that produce a damage-over-time effect from weapon hits. */
export const DOT_TYPES = ['slash', 'heat', 'toxin', 'electricity', 'gas', 'blast'] as const;

/** Tick coefficient per type (wiki: C). */
export const TICK_COEFFICIENT: Record<string, number> = {
  slash: 0.35,
  heat: 0.5,
  toxin: 0.5,
  electricity: 0.5,
  gas: 0.5,
  blast: 0.5,
};

/** Number of ticks per proc. */
export const TICK_COUNT: Record<string, number> = {
  slash: 6,
  heat: 6,
  toxin: 6,
  electricity: 6,
  gas: 6,
  blast: 1,
};

/** Bleed is True damage: it ignores armour and health-type modifiers. */
export const TICK_DAMAGE_TYPE: Record<string, DamageType> = {
  slash: 'true',
  heat: 'heat',
  toxin: 'toxin',
  electricity: 'electricity',
  gas: 'gas',
  blast: 'blast',
};

export interface DotEntry {
  /** Damage type that procced. */
  type: DamageType;
  /** Procs per second at the build's fire rate. */
  procsPerSecond: number;
  /** Damage of one tick after enemy modifiers. */
  tickDamage: number;
  /** Ticks per proc. */
  ticks: number;
  /** Damage per second contributed by this status. */
  dps: number;
  /** Total damage of one proc. */
  damagePerProc: number;
}

export const healthModifier = (snapshot: Snapshot, type: DamageType, healthType: string): number =>
  (snapshot.modifiers[type]?.[healthType] ?? 0) / 100;

export interface DotContext {
  /** Viral stacks on the target: +100% damage to health at 1 stack, +25% each more. */
  viralStacks?: number;
  /** Corrosive stacks: 26% armour reduction, then 6% more each, capped at 80%. */
  corrosiveStacks?: number;
  /** Heat's armour strip, 0..0.5; multiplicative with Corrosive and the other strips (wiki: Heat). */
  heatStrip?: number;
  /**
   * Fraction of armour removed by percentage strips, 0..1. Ability strips and Corrosive
   * Projection auras are **additive**: the wiki's own example is Terrify (60%) plus one
   * Corrosive Projection (18%) leaving 22% of the armour, not 33%.
   */
  armorStrip?: number;
  /** Armour points drained from the current value (Polarize). */
  armorStripFlat?: number;
  /**
   * Armour points removed from the enemy's *base* armour (Shattering Impact, 6 per hit at max
   * rank). Base armour scales with level, so it is multiplied by the same factor the enemy's
   * armour was scaled by.
   */
  armorStripBaseFlat?: number;
  /** The enemy's level-1 armour, needed to scale a base-armour reduction. */
  armorBase?: number;
}

/** Damage-to-health multiplier from Viral stacks (wiki: 100%, then +25% up to 325%). */
export function viralMultiplier(stacks: number): number {
  if (stacks <= 0) return 1;
  const bonus = Math.min(3.25, 1 + 0.25 * (stacks - 1));
  return 1 + bonus;
}

/** Armour multiplier after Corrosive stacks (wiki: 26%, then 6% each, capped at 80%). */
export function corrosiveArmorMultiplier(stacks: number): number {
  if (stacks <= 0) return 1;
  const strip = Math.min(0.8, 0.26 + 0.06 * (stacks - 1));
  return 1 - strip;
}

/** Effective armour after Corrosive procs. */
export function effectiveArmor(armor: number, context: DotContext): number {
  // Shattering Impact works on base armour, which is the level-1 value the enemy scaled from,
  // so its removal grows with the same factor the armour did.
  const scale = context.armorBase && context.armorBase > 0 ? armor / context.armorBase : 1;
  const fromBase = (context.armorStripBaseFlat ?? 0) * scale;
  // Flat drains come off first (Polarize takes armour points, Shattering Impact chips at the
  // base), then the additive percentage strips, then corrosive procs on what is left.
  const afterFlat = Math.max(0, armor - (context.armorStripFlat ?? 0) - fromBase);
  const fraction = Math.max(0, Math.min(1, context.armorStrip ?? 0));
  const heat = Math.max(0, Math.min(0.5, context.heatStrip ?? 0));
  return Math.max(0, afterFlat * (1 - fraction) * corrosiveArmorMultiplier(context.corrosiveStacks ?? 0) * (1 - heat));
}

/**
 * Computes the sustained damage per second from status procs alone.
 * `flatFactionMultiplier` is the faction bonus already resolved by the caller.
 */
export function computeDot(
  snapshot: Snapshot,
  build: ResolvedBuild,
  scaled: ScaledEnemy,
  context: DotContext,
  factionMultiplier: number,
): DotEntry[] {
  const healthClass = scaled.enemy.healthClass;
  const armor = effectiveArmor(scaled.armor, context);
  const viral = viralMultiplier(context.viralStacks ?? 0);

  // Trigger pulls per second, ignoring reloads: DoT keeps ticking between magazines anyway.
  const pullsPerSecond = build.fireRate;
  const perProjectileTotal = build.damage.projectileTotal || 1;
  const statusPerProjectile = build.statusChance;
  const statusDamageBonus = 1 + (build.statusDamageBonus ?? 0);

  const entries: DotEntry[] = [];

  // A tick inherits the crit multiplier of the hit that applied it. A status roll is independent
  // of the crit roll, so ordinary procs carry the average multiplier; a proc that only happens on
  // a crit (Hunter Munitions) carries the multiplier of a critical hit, orange/red tiers included.
  // The hit location (body part multiplier) and its crit numbers carry into the tick as well.
  const hit = hitProfile(build, scaled.enemy.faction);
  const averageCrit = hit.averageCrit;
  const pCrit = Math.min(1, hit.critChance);
  const critOnCrit = hit.critOnCrit;

  // Forced procs (Hunter Munitions): extra proc rate of a type, sometimes gated on crits.
  // Kept as damage-weighted rates: `forced` counts procs, `forcedWeight` procs x crit multiplier.
  const forced = new Map<DamageType, number>();
  const forcedWeight = new Map<DamageType, number>();
  for (const proc of build.forcedProcs ?? []) {
    const rate = build.multishot * pullsPerSecond * proc.chance * (proc.requiresCrit ? pCrit : 1);
    if (rate <= 0) continue;
    forced.set(proc.type, (forced.get(proc.type) ?? 0) + rate);
    forcedWeight.set(proc.type, (forcedWeight.get(proc.type) ?? 0) + rate * (proc.requiresCrit ? critOnCrit : averageCrit));
  }

  for (const type of DOT_TYPES) {
    const coefficient = TICK_COEFFICIENT[type];
    const ticks = TICK_COUNT[type];
    const dotType = TICK_DAMAGE_TYPE[type];

    // Bleed takes the whole modded damage as its seed; the others use their own component.
    const component = type === 'slash' ? perProjectileTotal : build.damage.perProjectile[type] ?? 0;
    if (component <= 0) continue;

    // Proc share: the status roll is weighted by each type's damage share.
    const share = type === 'slash'
      ? (build.damage.perProjectile.slash ?? 0) / perProjectileTotal
      : component / perProjectileTotal;
    // A purely forced proc (no damage of that type on the weapon) still deals its DoT.
    if (share <= 0 && (forced.get(type) ?? 0) <= 0) continue;

    const procsPerProjectile = statusPerProjectile * share;
    const naturalPerSecond = procsPerProjectile * build.multishot * pullsPerSecond;
    const procsPerSecond = naturalPerSecond + (forced.get(type) ?? 0);
    // Procs per second weighted by the crit multiplier each one carries.
    const critWeighted = naturalPerSecond * averageCrit + (forcedWeight.get(type) ?? 0);

    // The wiki separates the seed (damage before the elemental bonus) from the elemental
    // multiplier: (seed + 1) × C × (1 + element bonus) × … Combined types (Gas, Blast) are
    // explicitly NOT buffed by their component mods, so their bonus stays 0.
    const elementalBonus = (type === 'gas' || type === 'blast')
      ? 0
      : (build.elementBonuses as Record<string, number | undefined>)[type] ?? 0;
    const seed = elementalBonus > 0 ? component / (1 + elementalBonus) : component;
    // Faction damage scales the seed itself and is then applied again, exactly as the wiki's
    // worked examples do it: ((seed x faction) + 1) x C x (1 + element bonus) x status x faction.
    const rawTick = ((seed * factionMultiplier) + 1) * coefficient * (1 + elementalBonus) * statusDamageBonus * factionMultiplier;
    const dr = dotType === 'true' ? 0 : armorDamageReduction(armor);
    const healthMod = dotType === 'true' ? 0 : healthModifier(snapshot, dotType, healthClass);
    const tickDamage = rawTick * hit.location * (1 + healthMod) * (1 - dr) * viral;

    const dps = critWeighted * tickDamage * ticks;
    entries.push({
      type,
      procsPerSecond,
      tickDamage,
      ticks,
      // Average over this type's procs, crits included.
      damagePerProc: procsPerSecond > 0 ? dps / procsPerSecond : tickDamage * ticks,
      dps,
    });
  }

  return entries;
}


/**
 * One guaranteed status proc, as an ability applies it.
 *
 * Abilities have no weapon mods, so the seed is just the ability's damage of that type:
 * tick = (seed + 1) x C, then health-type and armour modifiers (Slash is True and skips both)
 * and Viral amplification. This is the same formula computeDot uses for weapon procs.
 */
export function statusProcDamage(
  snapshot: Snapshot,
  type: DamageType,
  seed: number,
  scaled: ScaledEnemy,
  context: DotContext,
  viralStacks = 0,
): { type: DamageType; damageType: DamageType; tickDamage: number; ticks: number; total: number } | null {
  if (!(DOT_TYPES as readonly string[]).includes(type)) return null;
  const coefficient = TICK_COEFFICIENT[type];
  const ticks = TICK_COUNT[type];
  const dotType = TICK_DAMAGE_TYPE[type];
  const healthClass = scaled.enemy.healthClass;
  const armor = effectiveArmor(scaled.armor, context);
  const dr = dotType === 'true' ? 0 : armorDamageReduction(armor);
  const healthMod = dotType === 'true' ? 0 : healthModifier(snapshot, dotType, healthClass);
  const tickDamage = (seed + 1) * coefficient * (1 + healthMod) * (1 - dr) * viralMultiplier(viralStacks);
  return { type, damageType: dotType, tickDamage, ticks, total: tickDamage * ticks };
}
