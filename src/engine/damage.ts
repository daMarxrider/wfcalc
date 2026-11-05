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
import { resolveBuild, type Build, type ResolvedBuild } from './build.ts';
import { arcaneBuildUp } from './arcanes.ts';
import { armorDamageReduction, type ScaledEnemy } from './enemy.ts';
import { arcaneProcRates, atLeastTen, computeDot, procRates, pullsBy, sustainedPulls, effectiveArmor, viralMultiplier, type DotContext, type DotEntry } from './dot.ts';
import { automaticAttenuation, resolveAttenuation, type AttenuationProfile, type ResolvedAttenuation } from './attenuation.ts';
import { hitProfile, type HitProfile } from './hit.ts';
import { AMMO_EFFICIENCY_CAP, ammoBuffUptime, expectedAmmoCost } from './ammo.ts';
import { BEAM_DECAY_DELAY, BEAM_DECAY_TIME, BEAM_RAMP_TIME, beamStart, simulateKill, type SimulationResult } from './simulate.ts';

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
   * The build as entered: with `simulate`, arcanes whose stacks move in a fight (arcanes.ts
   * arcaneBuildUp) build up from 0 or decay instead of holding the counted stacks. Costs a
   * resolve per stack step, so searches leave it out.
   */
  input?: Build;
  /**
   * Cheap stand-in for the simulation, used to rank many builds before the best few are
   * simulated: the statuses the build's own procs put up (Viral, Corrosive, Heat, Puncture,
   * Cold, Tau) and its DoT ticks, only as far as they get before the kill (fightLengthHit).
   */
  steadyStatus?: boolean;
  /**
   * With `steadyStatus`: the target's state this many seconds into the fight (stacks, Heat
   * strip and DoT ticks only as far as they got by then). Omitted, the kill time integrates it.
   */
  at?: number;
  /** With `at`: the share of the sustained pull rate the trigger delivers then (a magazine fires faster, a reload not at all). */
  firing?: number;
  /** With `at`: the beam ramp's share of full damage over that step (beamShare). */
  beam?: number;
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
  /** Kills per minute against a stream of these targets, the reloads between kills included (0: cannot kill). */
  killsPerMinute: number;
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

/**
 * Timed ammo buffs (engine/ammo.ts): Infinite Ammo or extra Ammo Efficiency for a while after an
 * event. Their uptime needs the event spacing: one weak-point kill per time-to-kill (the same
 * target over and over), one hit per pellet otherwise, at the pulls per second the ammo allows.
 * Both grow as the buffs cut reloads, so uptime, ammo per shot and kill time are iterated until
 * they agree.
 * shortcut: every kill and every pellet counts as an event, though some buffs ignore DoT kills
 * (Arcane Pistoleer) or also count status ticks (Magnus Prime); split events by source if needed.
 *
 * A timed trait buff (Athodai's Overdrive) is counted the same way: the fight runs at the buffed
 * rate for its uptime and at the plain rate (build.timedBuff.off) otherwise, so kill speeds and
 * DPS blend by time. It is down while it waits for its trigger, so that wait runs at the off rate.
 * shortcut: Overdrive's precedence over Arcane Pistoleer is not modelled; both count when equipped.
 */
export function hitEnemy(snapshot: Snapshot, build: ResolvedBuild, scaled: ScaledEnemy, options: HitOptions = {}): EnemyHit {
  const on = ammoHit(snapshot, build, scaled, options);
  const timed = build.timedBuff;
  if (!timed?.off || on.timeToKill === null) return on;
  // shortcut: arcane build-up runs in the buffed state only; the off state keeps its counted stacks.
  const off = ammoHit(snapshot, timed.off, scaled, { ...options, input: undefined });
  const interval = timed.trigger === 'weakPointKill'
    ? 60 / off.killsPerMinute
    : 1 / (sustainedPulls(timed.off) * Math.max(1, timed.off.multishot));
  const uptime = ammoBuffUptime({ chance: 1, seconds: timed.seconds, refresh: timed.refresh }, interval);
  const blend = (a: number, b: number): number => uptime * a + (1 - uptime) * b;
  // Share of a target removed per second; the off state may not kill at all (0).
  const speed = blend(1 / on.timeToKill, off.timeToKill ? 1 / off.timeToKill : 0);
  const timeToKill = speed > 0 ? 1 / speed : null;
  return {
    ...on,
    timeToKill,
    shotsToKill: timeToKill === null ? Infinity : timeToKill * blend(on.shotsToKill / on.timeToKill, off.timeToKill ? off.shotsToKill / off.timeToKill : 0),
    totalDps: blend(on.totalDps, off.totalDps),
    killsPerMinute: blend(on.killsPerMinute, off.killsPerMinute),
    warnings: [...on.warnings, `${timed.name}: ${timed.seconds}s buff up ${(uptime * 100).toFixed(0)}% of the fight${timed.refresh ? '' : ' (no refresh)'}`],
  };
}

function ammoHit(snapshot: Snapshot, build: ResolvedBuild, scaled: ScaledEnemy, options: HitOptions): EnemyHit {
  const ammo = build.ammo ?? { efficiency: 0, multipliers: [], buffs: [], cost: 1 };
  let hit = hitOnce(snapshot, build, scaled, options);
  let uptimes = ammo.buffs.map(() => 0);
  let cost = ammo.cost;
  if (ammo.buffs.length && build.reloadTime > 0) {
    for (let round = 0; round < 20; round++) {
      const pellets = sustainedPulls({ ...build, ammo: { ...ammo, cost } }) * Math.max(1, build.multishot);
      const next = ammo.buffs.map((buff) => ammoBuffUptime(buff, buff.trigger === 'weakPointKill' ? 60 / hit.killsPerMinute : (buff.every ?? 1) / pellets));
      if (next.every((uptime, i) => Math.abs(uptime - uptimes[i]) < 1e-6)) break;
      uptimes = next;
      cost = expectedAmmoCost(ammo.efficiency, ammo.multipliers, ammo.buffs, uptimes);
      hit = hitOnce(snapshot, { ...build, ammo: { ...ammo, cost } }, scaled, options);
    }
  }
  if (cost < 1) {
    const buffs = ammo.buffs.map((buff, i) => `${buff.name} ${buff.efficiency >= 1 ? 'Infinite Ammo' : `+${(buff.efficiency * 100).toFixed(0)}%`} up ${(uptimes[i] * 100).toFixed(0)}%`);
    hit.warnings.push(`Ammo: ${((1 - cost) * 100).toFixed(1)}% of shots cost no ammo${cost > 0 ? ` (${(1 / cost).toFixed(2)} shots per round)` : ', no reloads'}`
      + `${ammo.efficiency > 0 ? `; Ammo Efficiency ${(Math.min(AMMO_EFFICIENCY_CAP, ammo.efficiency) * 100).toFixed(1)}%${ammo.efficiency > AMMO_EFFICIENCY_CAP ? ` (capped from ${(ammo.efficiency * 100).toFixed(1)}%)` : ''}` : ''}`
      + `${buffs.length ? `; ${buffs.join(', ')}` : ''}`);
  }
  return hit;
}

/**
 * Fast estimate of the simulated fight, for `steadyStatus`. Statuses build up over the fight:
 * a short one sees few stacks and few DoT ticks (Heat starts at 1 s), and the first magazine
 * fires before any reload. The share of the target removed per second is 1 / kill time at the
 * state reached by then; summed over time steps it reaches 1 at the kill. Past the longest
 * status timer the state no longer changes, so the rest of the fight runs at the sustained rate.
 */
function fightLengthHit(snapshot: Snapshot, build: ResolvedBuild, scaled: ScaledEnemy, options: HitOptions): EnemyHit {
  const full = hitOnce(snapshot, build, scaled, { ...options, at: Infinity });
  if (full.timeToKill === null || full.timeToKill <= 0) return full;
  const sustained = sustainedPulls(build);
  // totalDps is the pools over the kill time, as everywhere else.
  const finish = (seconds: number): EnemyHit => ({
    ...full, timeToKill: seconds, shotsToKill: pullsBy(build, seconds), killsPerMinute: killRate(build, pullsBy(build, seconds)), totalDps: (full.totalDps * full.timeToKill!) / seconds,
  });
  // Midpoint rule: the state halfway through a step, with the pulls the trigger fired in it.
  const progress = (a: number, b: number): number => {
    const firing = (pullsBy(build, b) - pullsBy(build, a)) / ((b - a) * sustained);
    const hit = hitOnce(snapshot, build, scaled, { ...options, at: (a + b) / 2, firing, beam: beamShare(build, a, b) });
    return hit.timeToKill === null || hit.timeToKill <= 0 ? 0 : (b - a) / hit.timeToKill;
  };
  // Corrosive's 8 s is the longest timer; Heat ticks 1 s late and Blast lands 1.5 s late.
  const duration = 1 + Math.max(-0.9, build.statusDurationBonus ?? 0);
  // A refreshing Heat chain keeps growing, so with Heat the fight never settles: step to the kill.
  const settled = full.dot.some((entry) => entry.type === 'heat' && entry.procsPerSecond > 0) ? Infinity : 8 * duration + 1.5;
  // Steps end where the state jumps (Heat's strip steps, the DoT delays, Blast's window), so no
  // midpoint lands on the wrong side of one: a slightly different kill time no longer shifts it.
  const breaks = [0.5 * duration, duration, 1.5 * duration, 2 * duration, 1, 1.5, 1.75].sort((x, y) => x - y);
  let t = 0;
  let done = 0;
  const first = Math.min(full.timeToKill / 4, settled / 8);
  let step = first;
  for (let i = 0; i < 48 && t < settled; i++) {
    // No step longer than the fight so far: a midpoint far ahead would see a Heat chain that big.
    let next = Math.min(settled, t + Math.min(step, Math.max(first, t)), breaks.find((x) => x > t + 1e-9) ?? Infinity);
    let area = progress(t, next);
    // The kill falls inside this step: shrink it onto the kill (the pulls depend on where it ends).
    for (let k = 0; k < 4 && done + area > 1 + 1e-3; k++) {
      next = t + ((next - t) * (1 - done)) / area;
      area = progress(t, next);
    }
    if (done + area >= 1 - 1e-3) return finish(next);
    done += area;
    t = next;
    step *= 1.6;
  }
  // The rest at the settled rate: the pulls it needs, then the time to fire them with whole reloads.
  return finish(secondsToFire(build, pullsBy(build, t) + (1 - done) * full.timeToKill * sustained));
}

/** Seconds to fire `pulls` trigger pulls from the start of a fight (the inverse of dot.ts pullsBy). */
function secondsToFire(build: ResolvedBuild, pulls: number): number {
  const cost = build.ammo?.cost ?? 1;
  if (!(cost > 1e-9)) return pulls / build.fireRate;
  const perMagazine = Math.max(1, build.magazineSize) / cost;
  const cycle = perMagazine / Math.max(0.01, build.fireRate) + Math.max(0, build.spoolSeconds ?? 0) + Math.max(0, build.reloadTime);
  const cycles = Math.max(0, Math.ceil(pulls / perMagazine) - 1);
  return cycles * cycle + (pulls - cycles * perMagazine) / build.fireRate;
}

/**
 * Kills per minute when the targets keep coming: the next one is shot as soon as the last dies
 * (no switch time) and starts with no statuses. Shots per kill at the sustained pull rate, so a
 * kill that starts mid-magazine pays its share of the reloads.
 */
function killRate(build: ResolvedBuild, shots: number): number {
  return Number.isFinite(shots) && shots > 0 ? (60 * sustainedPulls(build)) / shots : 0;
}

/** Share of a ramp reached `seconds` in: 0 before `delay`, then rising to 1 over `length` (0: a step). */
function rampAt(seconds: number, delay: number, length: number): number {
  if (seconds === Infinity) return 1;
  const after = seconds - delay;
  if (after < 0) return 0;
  return length <= 0 ? 1 : Math.min(1, after / length);
}

/**
 * Seconds' worth of sustained fire in the `life` seconds up to `seconds` into the fight: what a
 * status with that duration has collected. Early on less than `life`, inside a magazine more.
 */
function firedWithin(build: ResolvedBuild, seconds: number, life: number): number {
  if (seconds === Infinity) return life;
  return (pullsBy(build, seconds) - pullsBy(build, seconds - life)) / sustainedPulls(build);
}

/**
 * Beam ramp (simulate.ts): a held beam starts at a share of full damage and climbs to full over
 * 0.6 s of firing; a reload longer than 0.8 s lets it decay (over 2 s), so each magazine climbs
 * again from there. The share averaged over the fire between `from` and `to` seconds into the
 * fight, weighted by the pulls; `from` = Infinity: averaged over a later magazine.
 */
export function beamShare(build: ResolvedBuild, from: number, to = Infinity): number {
  const start = beamStart(build);
  if (start === null) return 1;
  const cost = build.ammo?.cost ?? 1;
  const fireTime = cost > 1e-9 ? Math.max(1, build.magazineSize) / cost / Math.max(0.01, build.fireRate) : Infinity;
  const reload = Math.max(0, build.reloadTime) + Math.max(0, build.spoolSeconds ?? 0);
  const restart = Math.max(start, 1 - ((1 - start) * Math.max(0, reload - BEAM_DECAY_DELAY)) / BEAM_DECAY_TIME);
  // The share summed over the first `x` seconds of a magazine that starts at `level`.
  const area = (level: number, x: number): number => {
    const rising = Math.min(x, ((1 - level) * BEAM_RAMP_TIME) / (1 - start));
    return rising * level + ((1 - start) * rising * rising) / (2 * BEAM_RAMP_TIME) + (x - rising);
  };
  if (from === Infinity) return Number.isFinite(fireTime) ? area(restart, fireTime) / fireTime : 1;
  const cycle = fireTime + reload;
  if (!Number.isFinite(cycle)) return (area(start, to) - area(start, from)) / (to - from);
  let summed = 0;
  let fired = 0;
  for (let c = Math.floor(from / cycle); c * cycle < to; c++) {
    const lo = Math.max(from, c * cycle) - c * cycle;
    const hi = Math.min(to, c * cycle + fireTime) - c * cycle;
    if (hi <= lo) continue;
    summed += area(c === 0 ? start : restart, hi) - area(c === 0 ? start : restart, lo);
    fired += hi - lo;
  }
  return fired > 0 ? summed / fired : 1;
}

/** DoT seconds after the proc before ticking, and how long it ticks (simulate.ts). */
const DOT_TIMING: Record<string, { delay: number; length: number }> = {
  // Electricity and Gas tick at once, the others from 1 s (wiki: Damage over Time).
  slash: { delay: 1, length: 6 },
  toxin: { delay: 1, length: 6 },
  heat: { delay: 1, length: 6 },
  // A single hit: the procs of a short window 1.5 s back.
  blast: { delay: 1.5, length: 0.25 },
};

function hitOnce(snapshot: Snapshot, build: ResolvedBuild, scaled: ScaledEnemy, options: HitOptions): EnemyHit {
  if (options.steadyStatus && options.at === undefined) return fightLengthHit(snapshot, build, scaled, options);
  // Overguard takes only Cold (at most 4 stacks), so its layer gets a crit of its own.
  const overguardBuild = options.steadyStatus && scaled.overguard > 0 ? withSteadyCrit(build, options.at ?? Infinity, true) : null;
  if (options.steadyStatus) build = withSteadyCrit(build, options.at ?? Infinity);
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
  if (options.steadyStatus) Object.assign(debuffs, steadyStatusDebuffs(build, options.at));
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
  const overguardCrit = overguardBuild ? hitProfile(overguardBuild, scaled.enemy.faction).averageCrit : critMultiplier;
  const damagePerShotOverguard = perProjectileOverguard * overguardCrit * shots * factionMultiplier;

  // Sequential kill, as rates rather than shots so status damage counts:
  // shields first (shield-capable direct damage + DoT), then health (direct + DoT).
  const dot = computeDot(snapshot, build, scaled, debuffs, factionMultiplier);
  // A short fight only sees the ticks that land before the kill.
  if (options.steadyStatus && options.at !== undefined && options.at !== Infinity) {
    const durationScale = 1 + Math.max(-0.9, build.statusDurationBonus ?? 0);
    for (const entry of dot) {
      const timing = DOT_TIMING[entry.type] ?? { delay: 0, length: 6 };
      const length = entry.type === 'blast' ? timing.length : timing.length * durationScale;
      let share = firedWithin(build, options.at - timing.delay, length) / length;
      if (entry.type === 'heat') {
        // Heat (simulate.ts): once the chain is 1 s old every stack on it ticks, and dense procs
        // keep refreshing them all: the stacks blend from the window's procs to all since it began.
        const window = entry.procsPerSecond * firedWithin(build, options.at, length);
        const all = entry.procsPerSecond * firedWithin(build, options.at, options.at);
        const stacks = options.at >= timing.delay ? window + (1 - Math.exp(-window)) * (all - window) : 0;
        share = entry.procsPerSecond > 0 ? stacks / (entry.procsPerSecond * entry.ticks) : 0;
      }
      entry.dps *= share;
      entry.shieldDps *= share;
    }
  }
  // A ramping beam's hits and the procs they seed are weaker early on (steady estimate only).
  const beam = options.steadyStatus ? options.beam ?? beamShare(build, Infinity) : 1;
  const dotDps = beam * dot.reduce((sum, entry) => sum + entry.dps, 0);
  // Ticks hit shields too, Slash included (U27.2); bypassing Toxin goes to health instead (not counted there).
  const dotShieldDps = shieldType
    ? beam * dot.reduce((sum, entry) => sum + (entry.type === 'toxin' && scaled.enemy.toxinBypassesShields ? 0 : entry.shieldDps), 0)
    : 0;
  const pullsPerSecond = sustainedPulls(build);

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
  // Mid-fight (steady estimate): the trigger fires faster inside a magazine, not at all reloading.
  const firePulls = pullsPerSecond * (options.firing ?? 1) * beam;
  const directHealthDps = damagePerShotHealth * firePulls;
  const directShieldDps = damagePerShotShield * firePulls;
  const directOverguardDps = damagePerShotOverguard * firePulls;
  const effectiveHealthDps = attenuation
    ? Math.min(
        cappedDirect(directHealthDps, damagePerShotHealth) * flatFactor
          + Math.min(dotDps * statusFactor, attenuation.mdps > 0 ? attenuation.mdps : Infinity),
        attenuation.mdps > 0 ? attenuation.mdps : Infinity,
      )
    : directHealthDps + dotDps;
  const effectiveShieldDps = attenuation
    ? Math.min(
        cappedDirect(directShieldDps, damagePerShotShield) * flatFactor
          + Math.min(dotShieldDps * statusFactor, attenuation.mdps > 0 ? attenuation.mdps : Infinity),
        attenuation.mdps > 0 ? attenuation.mdps : Infinity,
      )
    : directShieldDps + dotShieldDps;
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
      const bypassDps = bypassProjectile * critMultiplier * build.multishot * firePulls;
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
    const input = options.input;
    const sources = input ? arcaneBuildUp(snapshot, input, build) : [];
    // Ammo buffs (ammoHit) priced the ammo cost for this build: the re-resolved ones keep it.
    const resolveAt = (stacks: Record<string, number>): ResolvedBuild => {
      const next = resolveBuild(snapshot, { ...input!, sourceStacks: { ...(input!.sourceStacks ?? {}), ...stacks } });
      return build.ammo?.buffs.length ? { ...next, ammo: build.ammo } : next;
    };
    simulation = simulateKill(snapshot, build, scaled, { factionMultiplier, debuffs, estimate: timeToKill, buildUp: sources.length ? { sources, resolveAt } : undefined });
    const stacks = Object.entries(simulation.arcaneStacks ?? {});
    if (stacks.length) warnings.push(`arcane stacks build up in the fight: ${stacks.map(([name, value]) => `${name} ${value} at the kill`).join(', ')}`);
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
    } else if (!build.irradiateShare) {
      warnings.push(`multi-target is not modelled for this weapon; ${requestedTargets} targets ignored`);
    }
  }
  // Secondary Irradiate (wiki): a direct hit on a target with 10 Radiation stacks deals the
  // arcane's share of that hit to every enemy nearby. The share of hits that qualify is
  // P(N >= 10) for the steady Radiation stack count (12 s each, like Debilitate's).
  // shortcut: the spread hit is valued like the original body hit (the wiki: elemental mods 33%
  // less effective, no weak-point bonus, own crit roll); split the hit by type if it matters.
  if (requestedTargets > 1 && build.irradiateShare > 0 && totalDps > 0) {
    const own = procRates(build, pullsPerSecond, hit.critChance)('radiation');
    const rate = own.natural + own.forced + (arcaneProcRates(build, pullsPerSecond, () => 0).radiation ?? 0);
    const up = atLeastTen(rate * 12 * (1 + Math.max(-0.9, build.statusDurationBonus ?? 0)));
    if (up > 0) {
      multiTargetDps = totalDps * multiTargetFactor + (requestedTargets - 1) * build.irradiateShare * up * directHealthDps;
      multiTargetFactor = multiTargetDps / totalDps;
      warnings.push(`Secondary Irradiate: ${requestedTargets - 1} nearby target(s) take ${(build.irradiateShare * 100).toFixed(0)}% of the direct hit, ${(up * 100).toFixed(0)}% of hits on 10 Radiation stacks`);
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
    killsPerMinute: killRate(build, shotsToKill),
    factionMultiplier,
    hit,
    simulation,
    dot,
    totalDps,
    bestType,
    warnings,
  };
}

/** Stacks `seconds` into the fight: the procs of the last `life` seconds, up to the cap. */
function stacksAt(build: ResolvedBuild, procs: number, life: number, cap: number, seconds: number): number {
  return Math.min(cap, procs * firedWithin(build, seconds, life));
}

/**
 * Puncture, Cold and Tau from the build's own procs, as the simulation applies them (simulate.ts),
 * all additive after mods: Puncture +5% crit chance per stack (5, 10 s); Cold +0.1, then +0.05 per
 * stack, to the crit multiplier (+0.5 at 9, 6 s; Cryogenic adds stacks per Puncture proc); Tau
 * +10% status chance per stack (10, 8 s). Ten Cold procs in a window freeze the target: +1.0 for
 * 3 s, then 3 stacks back and 7 more procs to the next freeze. On Overguard only Cold lands, at
 * most 4 stacks and no freeze (simulate.ts).
 */
function withSteadyCrit(build: ResolvedBuild, seconds: number, overguard = false): ResolvedBuild {
  const pulls = sustainedPulls(build);
  const duration = 1 + Math.max(-0.9, build.statusDurationBonus ?? 0);
  const rates = procRates(build, pulls, hitProfile(build, null).critChance);
  const own = (type: DamageType): number => rates(type).natural + rates(type).forced;
  const extra = arcaneProcRates(build, pulls, own);
  const rate = (type: DamageType): number => own(type) + (extra[type] ?? 0);
  const puncture = overguard ? 0 : stacksAt(build, rate('puncture'), 10 * duration, 5, seconds);
  // Cryogenic's Cold per Puncture proc is in `extra` already (arcaneProcRates).
  const coldRate = rate('cold');
  const cold = stacksAt(build, coldRate, 6 * duration, overguard ? COLD_OVERGUARD_CAP : Infinity, seconds);
  const tau = overguard ? 0 : stacksAt(build, rate('tau'), 8 * duration, 10, seconds);
  if (puncture <= 0 && cold <= 0 && tau <= 0) return build;
  return {
    ...build,
    critChance: build.critChance + 0.05 * puncture,
    critMultiplier: build.critMultiplier + coldCritBonus(cold, coldRate, duration, !overguard),
    statusChance: build.statusChance * (1 + Math.min(1, 0.1 * tau)),
  };
}

/**
 * Cold's crit multiplier bonus from `procs` in its window: +0.1, then +0.05 per stack to +0.5 at 9.
 * Once ten land, the frozen share of each freeze cycle gets +1.0 and the rest the average of
 * stacks 3-9 (+0.35). Mirrored in src/web/gpu-search.js.
 */
function coldCritBonus(procs: number, rate: number, duration: number, canFreeze: boolean): number {
  if (!(procs > 0)) return 0;
  if (!canFreeze || procs < 10) return Math.min(0.5, 0.1 + 0.05 * (procs - 1));
  const frozen = 3 * duration / (3 * duration + 7 / rate);
  return frozen + (1 - frozen) * 0.35;
}

/** Cold stacks an Overguarded target takes (simulate.ts COLD_OVERGUARD_CAP). */
const COLD_OVERGUARD_CAP = 4;

/** Heat's armour strip rises by these every 0.5 s of the chain, to 50% (simulate.ts). */
const HEAT_RAMP_STEPS = [0.15, 0.15, 0.1, 0.1];

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
 * With a time into the fight, the state by then: stacks rise at the proc rate from 0, and Heat's
 * strip climbs 15/30/40/50% every 0.5 s (simulate.ts).
 */
export function steadyStatusDebuffs(build: ResolvedBuild, seconds = Infinity): Pick<DotContext, 'viralStacks' | 'corrosiveStacks' | 'heatStrip'> {
  const pulls = sustainedPulls(build);
  const duration = 1 + Math.max(-0.9, build.statusDurationBonus ?? 0);
  const rates = procRates(build, pulls, hitProfile(build, null).critChance);
  const rate = (type: DamageType): number => rates(type).natural + rates(type).forced;
  // Arcanes add procs: Encumber's random statuses, Debilitate's base statuses (dot.ts).
  const extra = arcaneProcRates(build, pulls, rate);
  const stacks = (procs: number, life: number, cap: number): number => stacksAt(build, procs, life, cap, seconds);
  const viral = stacks(rate('viral') + (extra.viral ?? 0), 6 * duration, 10);
  const corrosive = stacks(rate('corrosive') + (extra.corrosive ?? 0), 8 * duration, 10 + (build.corrosiveCapBonus ?? 0));
  const ramp = HEAT_RAMP_STEPS.reduce((sum, rise, i) => sum + rise * rampAt(seconds, 0.5 * (i + 1) * duration, 0), 0);
  const heat = ramp * (1 - Math.exp(-stacks(rate('heat') + (extra.heat ?? 0), 6 * duration, Infinity)));
  return {
    viralStacks: Math.max(viral, build.debuffs?.viralStacks ?? 0),
    corrosiveStacks: Math.max(corrosive, build.debuffs?.corrosiveStacks ?? 0),
    heatStrip: heat,
  };
}
