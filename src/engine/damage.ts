/**
 * Damage dealt by a resolved build to a scaled enemy.
 *
 * Model:
 *   health hit:  damage × (1 + healthTypeModifier) × (1 − armorDR(type))
 *   shield hit:  damage × (1 + shieldTypeModifier)      (armor does not apply)
 *   Toxin bypasses shields for every enemy except the documented exceptions.
 *
 * Armor type modifiers act on the armor value itself (a resistance makes armor
 * protect more, a vulnerability makes it protect less) — see docs/formulas.md.
 */
import { DAMAGE_TYPES, type DamageType, type Snapshot } from '../types.ts';
import type { ResolvedBuild } from './build.ts';
import { armorDamageReduction, type ScaledEnemy } from './enemy.ts';
import { computeDot, debilitateRates, effectiveArmor, viralMultiplier, type DotContext, type DotEntry } from './dot.ts';
import { automaticAttenuation, resolveAttenuation, type AttenuationProfile, type ResolvedAttenuation } from './attenuation.ts';
import { hitProfile, type HitProfile } from './hit.ts';
import { simulateKill, type SimulationResult } from './simulate.ts';

export interface TypeBreakdown {
  type: DamageType;
  /** Damage of this type per projectile, before enemy modifiers. */
  raw: number;
  /** Combined multiplier applied to health damage (health modifier × armor DR). */
  healthMultiplier: number;
  /** Damage of this type per projectile that lands on health. */
  toHealth: number;
  /** Damage of this type per projectile that lands on shields. */
  toShield: number;
  /** Share of this build's status procs that will be of this type. */
  procShare: number;
}

export interface HitOptions {
  /**
   * Boss damage attenuation: a profile id ("archon", "eidolon") or an explicit profile.
   * Eidolons get theirs automatically from the enemy name.
   */
  attenuation?: string | AttenuationProfile | null;
  /** Total enemies hit by one shot when the weapon has a chain (Torid). */
  targets?: number;
  /**
   * Time to kill from a step simulation in which status effects (Viral, Corrosive, Heat,
   * Magnetic, Cold, Puncture, Tau and the DoTs) build up during the fight, instead of the steady
   * state. Not used under boss attenuation, whose caps the simulation does not model.
   */
  simulate?: boolean;
  /**
   * Cheap stand-in for the simulation: Viral, Corrosive and Heat at the stacks the build's own
   * proc rate keeps up (rate x duration, capped), as if the fight were already under way. Used
   * to rank many builds before the best few are simulated.
   */
  steadyStatus?: boolean;
}

export interface EnemyHit {
  level: number;
  health: number;
  shield: number;
  armor: number;
  breakdown: TypeBreakdown[];
  /** Damage per trigger pull against shields. */
  damagePerShotShield: number;
  /** Damage per trigger pull against health (armour, class modifier, crit avg, multishot). */
  damagePerShotHealth: number;
  /** Damage per trigger pull against Overguard: 0 unless the target has any. */
  damagePerShotOverguard: number;
  /** Overguard the target had, and our direct damage rate against it. */
  overguard: number;
  overguardDps: number;
  /** The attenuation actually applied, if any. */
  attenuation: ResolvedAttenuation | null;
  /** Multi-target result when the shot chains (Torid); null for a single target. */
  multiTargetDps: number | null;
  multiTargetFactor: number;
  /** Targets requested for the multi-target report (1 when single). */
  multiTargetTargets: number;
  /** Trigger pulls needed to remove shields, then health. */
  shotsToKill: number;
  /** Seconds to kill, accounting for reloads. */
  timeToKill: number | null;
  /** Faction damage multiplier that was applied to this target (1 when none). */
  factionMultiplier: number;
  /** Hit location against this target: its multiplier and the crit numbers it implies. */
  hit: HitProfile;
  /** The fight, step by step, when `simulate` was asked for (null otherwise). */
  simulation: SimulationResult | null;
  /** Damage over time by status type. */
  dot: DotEntry[];
  /** Sustained DPS including status damage. */
  totalDps: number;
  /** Highest single-type damage multiplier found (useful to sanity check element choice). */
  bestType: { type: DamageType; multiplier: number } | null;
  warnings: string[];
}

const healthModifier = (snapshot: Snapshot, type: DamageType, healthType: string): number =>
  (snapshot.modifiers[type]?.[healthType] ?? 0) / 100;

export function hitEnemy(snapshot: Snapshot, build: ResolvedBuild, scaled: ScaledEnemy, options: HitOptions = {}): EnemyHit {
  const warnings: string[] = [];
  const armor = scaled.pools.find((pool) => pool.category === 'armor');
  const shields = scaled.pools.filter((pool) => pool.category === 'shield');
  const health = scaled.pools.filter((pool) => pool.category === 'health' || pool.category === 'object');

  // Damage 3.0: the faction health class decides the modifier, once, for every pool. The
  // pools still say what exists (armour, shields, health) and how much of it, nothing else.
  const healthClass = scaled.enemy.healthClass;
  if (!health.length) warnings.push('enemy has no health pool in the dataset; health damage is still reported');
  const shieldType = shields[0]?.type ?? null;

  // Head or body: the location multiplier scales every damage type, and head crits double the
  // critical multiplier (hit.ts).
  const hit = hitProfile(build, scaled.enemy.faction);
  const critMultiplier = hit.averageCrit;
  const totalRaw = build.damage.projectileTotal || 1;

  // Faction damage bonus (Bane mods, Roar): multiplicative with everything else and
  // only against the matching faction. `all` is Roar, which applies to every faction.
  const factionKey = (scaled.enemy.faction ?? '').toLowerCase();
  const factionMultiplier = 1 + (build.factionBonus[factionKey] ?? 0) + (build.factionBonus.all ?? 0);

  // Status debuffs the player keeps up on the target.
  // The pool's amount is the level-1 armour, which a base-armour reduction has to be scaled by.
  const debuffs: DotContext = { ...build.debuffs, armorBase: armor?.amount };
  if (options.steadyStatus) Object.assign(debuffs, steadyStatusDebuffs(build));
  const viral = viralMultiplier(debuffs.viralStacks ?? 0);
  const armorAfterStatus = effectiveArmor(scaled.armor, debuffs);

  const breakdown: TypeBreakdown[] = [];
  let perProjectileShield = 0;
  let perProjectileHealth = 0;
  let perProjectileOverguard = 0;

  for (const type of DAMAGE_TYPES) {
    const raw = build.damage.perProjectile[type] ?? 0;
    if (raw <= 0) continue;
    const landed = raw * hit.location;

    const healthMod = healthModifier(snapshot, type, healthClass);
    const dr = armor ? armorDamageReduction(armorAfterStatus) : 0;
    // Wiki (Armor): "When damage is reduced from armor, each damage type has a minimum damage
    // of 1" — a Braton always does at least 3 against an armoured target. Verified in game:
    // an unmodded Soma Prime (3 damage types) deals exactly 3 to a level 101 Elite Frontier
    // Lancer, where every type would otherwise round to under 1.
    const armorFloor = armor ? 1 : 0;
    // Viral amplifies all damage dealt to health, direct hits included.
    const toHealth = Math.max(landed * (1 + healthMod) * (1 - dr) * viral, armorFloor);

    // Overguard is a health class of its own: Void +50%, neutral to everything else, no
    // armour, and not bypassed by Toxin. Magnetic's status amplification is not modelled.
    perProjectileOverguard += landed * (1 + healthModifier(snapshot, type, 'Overguard')) * (build.overguardDamageMultiplier ?? 1);

    const shieldMod = healthModifier(snapshot, type, healthClass);
    const bypassesShield = type === 'toxin' && scaled.enemy.toxinBypassesShields;
    const toShield = shieldType && !bypassesShield ? landed * (1 + shieldMod) : 0;

    breakdown.push({
      type,
      raw,
      healthMultiplier: (1 + healthMod) * (1 - dr),
      toHealth,
      toShield,
      procShare: raw / totalRaw,
    });
    perProjectileHealth += toHealth;
    perProjectileShield += toShield;
  }

  // Toxin that bypasses shields still eats health while shields are up.
  const bypassProjectile =
    breakdown
      .filter((entry) => entry.type === 'toxin' && scaled.enemy.toxinBypassesShields)
      .reduce((sum, entry) => sum + entry.toHealth, 0) * factionMultiplier;

  const shots = build.multishot;
  // Cascadia Empowered (wiki): every proc adds flat damage of its own type; no crit, weak point
  // or mod scaling, only faction and the target's resistances. Statuses do not land on Overguard.
  let procHealth = 0;
  let procShield = 0;
  if (build.procDamage) {
    const dr = armor ? armorDamageReduction(armorAfterStatus) : 0;
    const procs: Array<[DamageType, number]> = DAMAGE_TYPES
      .map((type): [DamageType, number] => [type, build.statusChance * ((build.damage.perProjectile[type] ?? 0) / totalRaw)]);
    for (const proc of build.forcedProcs ?? []) procs.push([proc.type, proc.chance * (proc.requiresCrit ? Math.min(1, build.critChance) : 1)]);
    for (const [type, chance] of procs) {
      if (chance <= 0) continue;
      const amount = build.procDamage * chance * shots * factionMultiplier;
      const modifier = 1 + healthModifier(snapshot, type, healthClass);
      procHealth += amount * modifier * (1 - dr) * viral;
      if (shieldType && !(type === 'toxin' && scaled.enemy.toxinBypassesShields)) procShield += amount * modifier;
    }
  }
  const damagePerShotShield = perProjectileShield * critMultiplier * shots * factionMultiplier + procShield;
  const damagePerShotHealth = perProjectileHealth * critMultiplier * shots * factionMultiplier + procHealth;
  const damagePerShotOverguard = perProjectileOverguard * critMultiplier * shots * factionMultiplier;

  // Sequential kill, as rates rather than shots so status damage counts:
  // shields first (only shield-capable damage), then health (direct + DoT).
  const dot = computeDot(snapshot, build, scaled, debuffs, factionMultiplier);
  const dotDps = dot.reduce((sum, entry) => sum + entry.dps, 0);
  const cycleTime = build.magazineSize / Math.max(0.01, build.fireRate) + build.reloadTime;
  const pullsPerSecond = build.magazineSize / cycleTime;

  // `undefined` means "automatic" (Eidolons); `null`/"none" means the caller explicitly
  // turned attenuation off.
  const attenuation = options.attenuation !== undefined
    ? resolveAttenuation(options.attenuation, scaled.health)
    : resolveAttenuation(automaticAttenuation(scaled.enemy), scaled.health);
  /**
   * Caps a direct-damage rate before flat DR.
   *
   * Per instance, the wiki gives the hyperbolic formula used by the Hemocyte/Archon family:
   *   attenuated = damage x MDPI / (damage x multishot + MDPI)
   * which approaches MDPI/multishot per pellet as the hit grows. The per-second cap is applied
   * on top; its exponential smoothing is not modelled.
   */
  const cappedDirect = (dps: number, perShot: number): number => {
    if (!attenuation) return dps;
    const pellets = Math.max(1, build.multishot);
    if (attenuation.mdpi > 0 && perShot > 0) {
      const perPellet = perShot / pellets;
      const attenuatedPerPellet = (perPellet * attenuation.mdpi) / (perPellet * pellets + attenuation.mdpi);
      const byInstance = attenuatedPerPellet * pellets * pullsPerSecond;
      return Math.min(dps, byInstance, attenuation.mdps > 0 ? attenuation.mdps : Infinity);
    }
    return Math.min(dps, attenuation.mdps > 0 ? attenuation.mdps : Infinity);
  };
  const flatFactor = attenuation ? 1 - attenuation.flatDr : 1;
  const statusFactor = attenuation ? flatFactor * (1 - attenuation.statusDr) : 1;
  const directHealthDps = damagePerShotHealth * pullsPerSecond;
  const directShieldDps = damagePerShotShield * pullsPerSecond;
  const directOverguardDps = damagePerShotOverguard * pullsPerSecond;
  const effectiveHealthDps = attenuation
    ? Math.min(
        cappedDirect(directHealthDps, damagePerShotHealth) * flatFactor
          + Math.min(dotDps * statusFactor, attenuation.mdps > 0 ? attenuation.mdps : Infinity),
        attenuation.mdps > 0 ? attenuation.mdps : Infinity,
      )
    : directHealthDps + dotDps;
  const effectiveShieldDps = attenuation
    ? cappedDirect(directShieldDps, damagePerShotShield) * flatFactor
    : directShieldDps;
  const effectiveOverguardDps = attenuation
    ? cappedDirect(directOverguardDps, damagePerShotOverguard) * flatFactor
    : directOverguardDps;

  let remainingShield = scaled.shield;
  let remainingHealth = scaled.health;
  let shotsToKill = 0;

  const shieldDps = effectiveShieldDps;
  const healthDps = effectiveHealthDps;
  const overguardDps = effectiveOverguardDps;
  const totalPool = scaled.overguard + scaled.shield + scaled.health;

  if (overguardDps <= 0 && shieldDps <= 0 && healthDps <= 0) {
    shotsToKill = Infinity;
  } else {
    let seconds = 0;
    // Overguard is its own layer, first, and ignores armour. Status DoT is not applied to it
    // (the model only credits direct damage while it is up); the warning says so.
    if (scaled.overguard > 0) {
      if (overguardDps > 0) seconds += scaled.overguard / overguardDps;
      else seconds = Infinity;
    }
    if (Number.isFinite(seconds) && remainingShield > 0 && shieldDps > 0) {
      const shieldSeconds = remainingShield / shieldDps;
      seconds += shieldSeconds;
      // Shield-bypassing damage (Toxin) already chews health during the shield phase.
      const bypassDps = bypassProjectile * critMultiplier * build.multishot * pullsPerSecond;
      remainingHealth = Math.max(0, remainingHealth - shieldSeconds * bypassDps);
    } else if (Number.isFinite(seconds) && remainingShield > 0) {
      remainingShield = 0; // only shield-bypassing damage: shields never break, health still drops
    }
    if (Number.isFinite(seconds) && remainingHealth > 0) {
      seconds += healthDps > 0 ? remainingHealth / healthDps : Infinity;
    }
    shotsToKill = Number.isFinite(seconds) ? seconds * pullsPerSecond : Infinity;
  }

  let timeToKill = Number.isFinite(shotsToKill) && pullsPerSecond > 0 ? shotsToKill / pullsPerSecond : null;
  let simulation: SimulationResult | null = null;
  if (options.simulate && !attenuation) {
    simulation = simulateKill(snapshot, build, scaled, { factionMultiplier, debuffs, estimate: timeToKill });
    if (simulation.timeToKill !== null) {
      timeToKill = simulation.timeToKill;
      shotsToKill = simulation.shots;
    } else if (timeToKill !== null) {
      // Killable, but slower than the simulation's horizon: keep the steady-state estimate.
      warnings.push(`fight longer than the simulation horizon; time to kill is the steady-state estimate`);
    }
  }

  // Against this target: the rate that actually removes its pools, Overguard and shields
  // included. With no Overguard or shields this is the old health rate, so the documented
  // health/totalDps == timeToKill relation still holds for a plain Bombard.
  const totalDps = timeToKill !== null && timeToKill > 0 ? totalPool / timeToKill : healthDps + overguardDps;
  // A chained Incarnon (Torid) hits nearby enemies at a fraction of the previous link. The
  // primary target is unchanged; the extra targets share the same profile here, which is an
  // approximation (health types, armour and distance differ in a real group).
  const requestedTargets = Math.max(1, Math.floor(options.targets ?? 1));
  const chain = build.incarnonFormActive ? build.weapon.incarnonFormChain : undefined;
  let multiTargetFactor = 1;
  let multiTargetDps: number | null = null;
  if (requestedTargets > 1 && chain) {
    const links = Math.min(requestedTargets - 1, chain.maxTargets);
    let share = 1;
    for (let link = 0; link < links; link++) {
      share *= chain.falloff;
      multiTargetFactor += share;
    }
    multiTargetDps = totalDps * multiTargetFactor;
    warnings.push(`Chain: ${links} extra target(s) at 75% per link, same profile assumed`);
  } else if (requestedTargets > 1) {
    // One AoE shot: the primary target takes the whole profile, the others only the radial
    // share (the direct hit is a single point). Same target profile and distance assumed.
    let secondaryShare = 0;
    if (build.incarnonFormActive && build.weapon.incarnonFormExtra?.length) {
      const extra = build.weapon.incarnonFormExtra[0];
      const distance = build.aoeDistance ?? 0;
      const falloff = extra.falloff ? Math.max(0, 1 - extra.falloff.reduction * (
        distance <= extra.falloff.start ? 0
        : distance >= extra.falloff.end ? 1
        : (distance - extra.falloff.start) / (extra.falloff.end - extra.falloff.start)
      )) : 1;
      secondaryShare = (1 - (build.weapon.incarnonFormDirectShare ?? 1)) * falloff;
    } else {
      const radial = build.weapon.modes.find((mode) => mode.falloff);
      if (radial?.falloff) {
        const damageKeys = ['impact','puncture','slash','heat','cold','electricity','toxin','blast','corrosive','gas','magnetic','radiation','viral','true','void','tau'] as const;
        const sum = (stats: Record<string, number>) => damageKeys.reduce((total, key) => total + (stats[key] ?? 0), 0);
        const radialTotal = sum(radial.stats as unknown as Record<string, number>);
        const baseTotal = sum(build.weapon.stats as unknown as Record<string, number>);
        const distance = build.aoeDistance ?? 0;
        const { start, end, reduction } = radial.falloff;
        const falloff = distance <= start ? 1
          : distance >= end ? Math.max(0, 1 - reduction)
          : 1 - reduction * ((distance - start) / (end - start));
        secondaryShare = baseTotal > 0 ? (radialTotal / baseTotal) * falloff : 0;
      }
    }
    if (secondaryShare > 0) {
      multiTargetFactor = 1 + (requestedTargets - 1) * secondaryShare;
      multiTargetDps = totalDps * multiTargetFactor;
      warnings.push(`AoE group: ${requestedTargets - 1} extra target(s) at the same distance, radial share ${(secondaryShare * 100).toFixed(0)}%`);
    } else {
      warnings.push(`multi-target is not modelled for this weapon; ${requestedTargets} targets ignored`);
    }
  }
  const num = (value: number): string => value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (scaled.overguard > 0) {
    warnings.push('Overguard: direct damage only, status DoT not applied; Magnetic amplification not modelled');
  }
  if (attenuation) {
    warnings.push(
      `Damage attenuation ${attenuation.id}: caps ${num(attenuation.mdpi)} per hit and `
      + `${num(attenuation.mdps)} per second applied; exponential smoothing not modelled (TTK is conservative)`,
    );
    if (automaticAttenuation(scaled.enemy) && !options.attenuation) {
      warnings.push('Eidolon joints and invulnerability phases are not modelled; the caps apply to the whole health pool');
    }
  }
  const bestType = breakdown.reduce<{ type: DamageType; multiplier: number } | null>(
    (best, entry) => (!best || entry.healthMultiplier > best.multiplier ? { type: entry.type, multiplier: entry.healthMultiplier } : best),
    null,
  );

  return {
    level: scaled.level,
    health: scaled.health,
    shield: scaled.shield,
    // The armour actually applied, after strips: reporting the enemy's own value would make a
    // stripped target look untouched.
    armor: armorAfterStatus,
    breakdown,
    damagePerShotShield,
    damagePerShotHealth,
    damagePerShotOverguard,
    overguard: scaled.overguard,
    overguardDps: effectiveOverguardDps,
    attenuation,
    multiTargetDps,
    multiTargetFactor,
    multiTargetTargets: requestedTargets,
    shotsToKill,
    timeToKill,
    factionMultiplier,
    hit,
    simulation,
    dot,
    totalDps,
    bestType,
    warnings,
  };
}

/** Expected status procs per trigger pull, by damage type. */
export function statusProcs(build: ResolvedBuild): Array<{ type: DamageType; procs: number }> {
  const totalRaw = build.damage.projectileTotal || 1;
  const perShot = build.statusChance * build.multishot;
  return (Object.entries(build.damage.perProjectile) as Array<[DamageType, number]>)
    .filter(([, amount]) => amount > 0)
    .map(([type, amount]) => ({ type, procs: perShot * (amount / totalRaw) }));
}

/**
 * Status stacks a build keeps up on its own at a steady rate of fire (procs per second x the
 * status duration, capped), for the `steadyStatus` option. Player-given stacks are a floor.
 */
export function steadyStatusDebuffs(build: ResolvedBuild): Pick<DotContext, 'viralStacks' | 'corrosiveStacks' | 'heatStrip'> {
  const total = build.damage.projectileTotal || 1;
  const cycle = build.magazineSize / Math.max(0.01, build.fireRate) + build.reloadTime;
  const pellets = build.multishot * (build.magazineSize / Math.max(0.01, cycle));
  const duration = 1 + Math.max(-0.9, build.statusDurationBonus ?? 0);
  const rate = (type: DamageType): number => {
    const natural = pellets * build.statusChance * ((build.damage.perProjectile[type] ?? 0) / total);
    const forced = (build.forcedProcs ?? [])
      .filter((proc) => proc.type === type)
      .reduce((sum, proc) => sum + pellets * proc.chance * (proc.requiresCrit ? Math.min(1, build.critChance) : 1), 0);
    return natural + forced;
  };
  // Primary Debilitate adds base procs (Heat among them) on 10+ stacks of a combined status.
  const debilitated = debilitateRates(build.debilitateChance ?? 0, duration, rate);
  const viral = Math.min(10, rate('viral') * 6 * duration);
  const corrosive = Math.min(10 + (build.corrosiveCapBonus ?? 0), rate('corrosive') * 8 * duration);
  const heat = 0.5 * (1 - Math.exp(-(rate('heat') + (debilitated.heat ?? 0)) * 6 * duration));
  return {
    viralStacks: Math.max(viral, build.debuffs?.viralStacks ?? 0),
    corrosiveStacks: Math.max(corrosive, build.debuffs?.corrosiveStacks ?? 0),
    heatStrip: heat,
  };
}
