/**
 * Time-to-kill with status effects that build up during the fight.
 *
 * The static model in damage.ts treats every status as either absent or at a fixed number of
 * stacks. In a real engagement the first shots hit full armour and no Viral, and the target gets
 * softer as procs accumulate. This walks the fight in small time steps on expected values:
 *
 *   - shots follow the trigger: magazine at the fire rate, then the reload
 *   - every shot adds expected procs per damage type (status chance x multishot x share, plus
 *     forced procs such as Hunter Munitions), never while Overguard is up (status immunity)
 *   - each status lives for its own duration (Status Duration stretches it) with its own cap,
 *     and feeds back into damage (wiki: Status Effect):
 *       Viral      +100% then +25%/stack to +325% damage to health, 6 s, 10 stacks
 *       Corrosive  -26% then -6%/stack to -80% armour, 8 s, 10 stacks
 *       Heat       every proc refreshes all Heat stacks; armour strip ramps 15/30/40/50% every
 *                  0.5 s and decays 50/40/30/15/0% every 1.5 s after the last stack ends (both
 *                  stretched by Status Duration); multiplicative with Corrosive; ticks from 1 s.
 *                  On expected values a chain is alive with probability 1 - e^-W (W: expected
 *                  procs in the last duration window); its stacks blend from the procs in the
 *                  window (sparse procs, no refresh) to everything since the chain began (dense
 *                  procs keep refreshing)
 *       Magnetic   +100% then +25%/stack to +325% damage to shields and Overguard, 6 s
 *       Cold       +0.1 then +0.05/stack crit multiplier to +0.5 (9 stacks), additive after mods
 *       Puncture   +5% crit chance per stack to +25%, additive after mods, 10 s
 *       Tau        +10% status chance per stack to +100%, 8 s
 *       Blast      30% of the hit's base damage, 1.5 s after the proc
 *       Slash, Toxin, Electricity, Gas: one tick per second for the duration
 *   - a tick is seeded when it procs (crit, location, faction and status damage of that hit) and
 *     lands through the target's state at that moment (armour, Viral, health class)
 *   - layers fall in order: Overguard, shields, health; Toxin goes straight to health.
 *
 * Electricity's chain to nearby enemies, Gas's cloud on others and Magnetic's burst when shields
 * break are not modelled: this is the single target's time to kill.
 */
import { DAMAGE_TYPES, type DamageType, type Snapshot } from '../types.ts';
import type { ResolvedBuild } from './build.ts';
import { armorDamageReduction, type ScaledEnemy } from './enemy.ts';
import { effectiveArmor, healthModifier, TICK_COEFFICIENT, TICK_DAMAGE_TYPE, type DotContext } from './dot.ts';
import { hitProfile } from './hit.ts';

interface StackRule {
  duration: number;
  cap: number;
}

/** Statuses with independent stack timers (wiki: Status Effect table). */
const STACKING: Record<string, StackRule> = {
  viral: { duration: 6, cap: 10 },
  corrosive: { duration: 8, cap: 10 },
  magnetic: { duration: 6, cap: 10 },
  cold: { duration: 6, cap: 10 },
  puncture: { duration: 10, cap: 5 },
  tau: { duration: 8, cap: 10 },
};

/** Damage-over-time statuses that tick once a second with their own timers. */
const TICKING = ['slash', 'toxin', 'electricity', 'gas'] as const;
const DOT_DURATION = 6;
const HEAT_DURATION = 6;
const HEAT_FIRST_TICK = 1;
const HEAT_RAMP_UP = [0.15, 0.3, 0.4, 0.5];
const HEAT_RAMP_DOWN = [0.4, 0.3, 0.15, 0];
const BLAST_COEFFICIENT = 0.3;
const BLAST_DELAY = 1.5;

/** +100% at the first stack, +25% per further stack, to +325% (Viral and Magnetic). */
const amplifier = (stacks: number): number => (stacks <= 0 ? 1 : 1 + Math.min(3.25, 1 + 0.25 * (stacks - 1)));
const coldCritBonus = (stacks: number): number => (stacks <= 0 ? 0 : Math.min(0.5, 0.1 + 0.05 * (stacks - 1)));
const punctureCritBonus = (stacks: number): number => Math.min(0.25, 0.05 * Math.max(0, stacks));
const tauStatusBonus = (stacks: number): number => Math.min(1, 0.1 * Math.max(0, stacks));

export interface SimulationOptions {
  factionMultiplier: number;
  /** Debuffs the squad keeps up (strips, Corrosive Projection, Viral/Corrosive already applied). */
  debuffs: DotContext;
  /** Give up after this many seconds (an unkillable target returns null). */
  maxSeconds?: number;
  /** A first guess at the kill time; it only sizes the time step. */
  estimate?: number | null;
}

export interface SimulationSample {
  t: number;
  overguard: number;
  shield: number;
  health: number;
  viral: number;
  corrosive: number;
  heatStrip: number;
  armor: number;
}

export interface SimulationResult {
  timeToKill: number | null;
  /** Trigger pulls fired until the kill. */
  shots: number;
  /** Damage dealt by source until the kill: direct hits and each status. */
  damageBySource: Record<string, number>;
  /** Target state when it died (or when the simulation gave up). */
  atEnd: { viral: number; corrosive: number; heatStrip: number; magnetic: number; cold: number; puncture: number; armor: number };
  /** About 60 samples of the fight, for charts. */
  timeline: SimulationSample[];
  step: number;
}

/** A sliding window of per-step amounts with a running total, so each step costs O(1). */
class Window {
  private readonly slots: Float64Array;
  total = 0;
  constructor(length: number) {
    this.slots = new Float64Array(Math.max(1, length));
  }
  /** Puts `amount` in the step's slot, dropping what fell out of the window. */
  put(step: number, amount: number): void {
    const index = step % this.slots.length;
    this.total += amount - this.slots[index];
    this.slots[index] = amount;
    if (this.total < 1e-12) this.total = 0;
  }
  /** What was put `length` steps ago (a fixed delay line). */
  due(step: number): number {
    return this.slots[step % this.slots.length];
  }
}

export function simulateKill(snapshot: Snapshot, build: ResolvedBuild, scaled: ScaledEnemy, options: SimulationOptions): SimulationResult {
  const estimate = options.estimate && Number.isFinite(options.estimate) ? options.estimate : 30;
  // Statuses only shorten a fight, but the steady-state guess can be off early on: allow four
  // times the estimate (at least 10 minutes, at most two hours) before calling it unkillable.
  const maxSeconds = options.maxSeconds ?? Math.min(7200, Math.max(600, estimate * 4));
  // About 200 steps per kill, never coarser than a second nor finer than 5 ms.
  const dt = Math.min(1, Math.max(0.005, estimate / 200));
  const durationScale = 1 + Math.max(-0.9, build.statusDurationBonus ?? 0);
  const slots = (seconds: number): number => Math.max(1, Math.round((seconds * durationScale) / dt));

  const healthClass = scaled.enemy.healthClass;
  const faction = options.factionMultiplier;
  const hit = hitProfile(build, scaled.enemy.faction);
  const head = hit.zone === 'head';
  const debuffs = options.debuffs;
  const hasArmor = scaled.pools.some((pool) => pool.category === 'armor') && scaled.armor > 0;
  const hasShieldPool = scaled.pools.some((pool) => pool.category === 'shield');
  const toxinBypass = Boolean(scaled.enemy.toxinBypassesShields);
  const modOf = (type: DamageType, against = healthClass): number => 1 + healthModifier(snapshot, type, against);

  // ---- everything that does not change during the fight, as flat arrays
  const perProjectile = build.damage.perProjectile;
  const total = build.damage.projectileTotal || 1;
  const types = DAMAGE_TYPES.filter((type) => (perProjectile[type] ?? 0) > 0);
  const landed = types.map((type) => (perProjectile[type] ?? 0) * hit.location);
  const healthMod = types.map((type) => modOf(type));
  const overguardMod = types.map((type) => modOf(type, 'Overguard'));
  const bypass = types.map((type) => type === 'toxin' && toxinBypass);
  const shares = types.map((type) => (perProjectile[type] ?? 0) / total);
  const statusDamage = 1 + (build.statusDamageBonus ?? 0);
  const elementBonus = (type: string): number =>
    type === 'gas' || type === 'blast' ? 0 : (build.elementBonuses as Record<string, number | undefined>)[type] ?? 0;
  // Attacker-side seed of one tick, before crit (wiki DoT formula, as in dot.ts).
  const tickSeed = (type: string, coefficient: number): number => {
    const component = type === 'slash' ? total : perProjectile[type as DamageType] ?? 0;
    const bonus = elementBonus(type);
    const seed = bonus > 0 ? component / (1 + bonus) : component;
    const typeBonus = type === 'toxin' ? 1 + (build.toxinStatusDamageBonus ?? 0) : 1;
    return ((seed * faction) + 1) * coefficient * (1 + bonus) * statusDamage * typeBonus * faction * hit.location;
  };

  // Statuses by index: stacking ones, ticking ones, heat and blast.
  const STACK_TYPES = Object.keys(STACKING);
  const stackIndex = new Map(STACK_TYPES.map((type, i) => [type, i]));
  const stackWindows = STACK_TYPES.map((type) => new Window(slots(STACKING[type].duration)));
  // Emerald shards raise the Corrosion cap above 10.
  const stackCaps = STACK_TYPES.map((type) => STACKING[type].cap + (type === 'corrosive' ? build.corrosiveCapBonus ?? 0 : 0));
  const tickWindows = TICKING.map(() => new Window(slots(DOT_DURATION)));
  const tickIndex = new Map<string, number>(TICKING.map((type, i) => [type, i]));
  const tickSeeds = TICKING.map((type) => tickSeed(type, TICK_COEFFICIENT[type] ?? 0.5));
  // Enemy-side multipliers of each ticking type: [health with armour, shield, is True damage].
  const tickHealthMod = TICKING.map((type) => (TICK_DAMAGE_TYPE[type] === 'true' ? 1 : modOf(TICK_DAMAGE_TYPE[type] ?? type)));
  const tickTrue = TICKING.map((type) => TICK_DAMAGE_TYPE[type] === 'true');
  const toxinTick = tickIndex.get('toxin')!;
  const heatSeed = tickSeed('heat', TICK_COEFFICIENT.heat ?? 0.5);
  const heatMod = modOf('heat');
  const blastSeed = ((total * faction) + 1) * BLAST_COEFFICIENT * statusDamage * faction * hit.location;
  const blastMod = modOf('blast');
  const blastLine = new Window(Math.round(BLAST_DELAY / dt));
  const heatWindow = new Window(slots(HEAT_DURATION));
  const heatSeedWindow = new Window(slots(HEAT_DURATION));

  // Which status (if any) a damage type's procs feed: [stack index, tick index].
  const procTargets = (type: string): { stack: number; tick: number; heat: boolean; blast: boolean } => ({
    stack: stackIndex.get(type) ?? -1,
    tick: tickIndex.get(type) ?? -1,
    heat: type === 'heat',
    blast: type === 'blast',
  });
  const typeTargets = types.map(procTargets);
  const forced = (build.forcedProcs ?? []).map((proc) => ({ ...procTargets(proc.type), chance: proc.chance, requiresCrit: proc.requiresCrit }));

  const stackProcs = new Float64Array(STACK_TYPES.length);
  const tickWeight = new Float64Array(TICKING.length);
  const iViral = stackIndex.get('viral')!;
  const iCorrosive = stackIndex.get('corrosive')!;
  const iMagnetic = stackIndex.get('magnetic')!;
  const iCold = stackIndex.get('cold')!;
  const iPuncture = stackIndex.get('puncture')!;
  const iTau = stackIndex.get('tau')!;

  let overguard = scaled.overguard;
  let shield = scaled.shield;
  let health = scaled.health;
  const bySource = new Float64Array(TICKING.length + 3); // ticking..., heat, blast, direct
  const timeline: SimulationSample[] = [];
  const sampleEvery = Math.max(1, Math.round(Math.min(maxSeconds, estimate * 1.5) / dt / 60));

  const magazine = Math.max(1, build.magazineSize);
  const fireTime = magazine / Math.max(0.01, build.fireRate);
  const cycle = fireTime + Math.max(0, build.reloadTime);
  /** Seconds spent firing inside [a, b). */
  const firing = (a: number, b: number): number => {
    let seconds = 0;
    let start = Math.floor(a / cycle) * cycle;
    while (start < b) {
      seconds += Math.max(0, Math.min(b, start + fireTime) - Math.max(a, start));
      start += cycle;
    }
    return seconds;
  };

  // Heat chain: when it began, everything it accumulated, and the strip left when it ended.
  let heatChainStart: number | null = null;
  let heatEndedAt: number | null = null;
  let heatStripAtEnd = 0;
  let heatAccumulated = 0;
  const rampStep = 0.5 * durationScale;
  const decayStep = 1.5 * durationScale;
  const heatRamp = (t: number): number => {
    if (heatChainStart !== null) {
      const index = Math.floor((t - heatChainStart) / rampStep) - 1;
      return index < 0 ? 0 : HEAT_RAMP_UP[Math.min(index, HEAT_RAMP_UP.length - 1)];
    }
    if (heatEndedAt !== null && heatStripAtEnd > 0) {
      const index = Math.floor((t - heatEndedAt) / decayStep);
      return index < 0 ? heatStripAtEnd : Math.min(heatStripAtEnd, HEAT_RAMP_DOWN[Math.min(index, HEAT_RAMP_DOWN.length - 1)]);
    }
    return 0;
  };

  let t = 0;
  let step = 0;
  let shots = 0;
  let killedAt: number | null = null;
  let end = { viral: 0, corrosive: 0, heatStrip: 0, magnetic: 0, cold: 0, puncture: 0, armor: scaled.armor };

  while (t < maxSeconds) {
    // ---- target state at the start of this step
    const stacks = (i: number): number => Math.min(stackCaps[i], stackWindows[i].total);
    const viral = Math.max(stacks(iViral), debuffs.viralStacks ?? 0);
    const corrosive = Math.max(stacks(iCorrosive), debuffs.corrosiveStacks ?? 0);
    const magnetic = stacks(iMagnetic);
    const cold = stacks(iCold);
    const puncture = stacks(iPuncture);
    const tau = stacks(iTau);
    const heatAlive = 1 - Math.exp(-heatWindow.total);
    const strip = heatAlive * heatRamp(t);
    const armor = hasArmor ? effectiveArmor(scaled.armor, { ...debuffs, corrosiveStacks: corrosive }) * (1 - strip) : 0;
    const armorFactor = hasArmor ? 1 - armorDamageReduction(armor) : 1;
    const viralMultiplier = amplifier(viral);
    const magneticMultiplier = amplifier(magnetic);
    end = { viral, corrosive, heatStrip: strip, magnetic, cold, puncture, armor };

    // Crit with Cold and Puncture, additive after mods; head crits double the multiplier.
    const critChance = hit.critChance + punctureCritBonus(puncture);
    const critDamage = Math.max(1, build.critMultiplier + coldCritBonus(cold));
    const perTier = head ? 2 * critDamage - 1 : critDamage - 1;
    const averageCrit = 1 + critChance * perTier;
    const pCrit = Math.min(1, critChance);
    const critOnCrit = pCrit > 0 ? (averageCrit - (1 - pCrit)) / pCrit : 1 + perTier;

    // ---- direct damage this step, per layer
    const pulls = firing(t, t + dt) * build.fireRate;
    shots += pulls;
    let toHealth = 0;
    let toxinHealth = 0;
    let toShield = 0;
    let toOverguard = 0;
    for (let i = 0; i < types.length; i++) {
      const healthHit = Math.max(landed[i] * healthMod[i] * armorFactor * viralMultiplier, hasArmor ? 1 : 0);
      if (bypass[i]) toxinHealth += healthHit;
      else {
        toHealth += healthHit;
        if (hasShieldPool) toShield += landed[i] * healthMod[i] * magneticMultiplier;
      }
      toOverguard += landed[i] * overguardMod[i] * magneticMultiplier;
    }
    const volley = pulls * build.multishot * averageCrit * faction;

    // ---- procs this step (none while Overguard is up: status immunity)
    stackProcs.fill(0);
    tickWeight.fill(0);
    let heatProcs = 0;
    let heatWeight = 0;
    let blastWeight = 0;
    if (overguard <= 0 && pulls > 0) {
      const pellets = pulls * build.multishot;
      const statusChance = build.statusChance * (1 + tauStatusBonus(tau));
      const add = (target: { stack: number; tick: number; heat: boolean; blast: boolean }, procs: number, crit: number): void => {
        if (target.stack >= 0) stackProcs[target.stack] += procs;
        if (target.tick >= 0) tickWeight[target.tick] += procs * crit;
        if (target.heat) { heatProcs += procs; heatWeight += procs * crit; }
        if (target.blast) blastWeight += procs * crit;
      };
      for (let i = 0; i < types.length; i++) add(typeTargets[i], pellets * statusChance * shares[i], averageCrit);
      for (const proc of forced) add(proc, pellets * proc.chance * (proc.requiresCrit ? pCrit : 1), proc.requiresCrit ? critOnCrit : averageCrit);
    }

    // ---- damage over time this step, through the current target state (per second x dt)
    let dotHealth = 0;
    let dotShield = 0;
    let toxinDot = 0;
    const tickDealt = new Float64Array(TICKING.length + 2);
    for (let i = 0; i < TICKING.length; i++) {
      const rate = tickWindows[i].total * dt;
      if (rate <= 0) continue;
      const toH = rate * tickHealthMod[i] * (tickTrue[i] ? 1 : armorFactor) * viralMultiplier;
      tickDealt[i] = toH;
      if (i === toxinTick && toxinBypass) toxinDot += toH;
      else {
        dotHealth += toH;
        dotShield += rate * tickHealthMod[i] * magneticMultiplier;
      }
    }
    // Heat: alive chains tick from a second after they began; stacks blend from the window's
    // procs (no refresh) to the whole chain (refreshing).
    if (heatChainStart !== null && t - heatChainStart >= HEAT_FIRST_TICK) {
      const stacked = heatSeedWindow.total + heatAlive * Math.max(0, heatAccumulated - heatSeedWindow.total);
      const rate = stacked * dt;
      const toH = rate * heatMod * armorFactor * viralMultiplier;
      tickDealt[TICKING.length] = toH;
      dotHealth += toH;
      dotShield += rate * heatMod * magneticMultiplier;
    }
    // Blast: lands a fixed delay after its proc.
    const blastDue = blastLine.due(step);
    if (blastDue > 0) {
      const toH = blastDue * blastMod * armorFactor * viralMultiplier;
      tickDealt[TICKING.length + 1] = toH;
      dotHealth += toH;
      dotShield += blastDue * blastMod * magneticMultiplier;
    }

    // ---- apply: Overguard, then shields, then health (Toxin skips shields)
    let fraction = 1;
    if (overguard > 0) {
      const dealt = toOverguard * volley;
      const spent = dealt >= overguard && dealt > 0 ? overguard / dealt : 1;
      overguard = spent < 1 ? 0 : overguard - dealt;
      bySource[TICKING.length + 2] += dealt * spent;
      fraction = spent < 1 ? 1 - spent : 0;
    }
    if (fraction > 0 && shield > 0) {
      const dealt = (toShield * volley + dotShield) * fraction;
      const spent = dealt >= shield && dealt > 0 ? fraction * (shield / dealt) : fraction;
      // Toxin reaches health for exactly the share of the step spent on shields.
      health -= (toxinHealth * volley + toxinDot) * spent;
      bySource[TICKING.length + 2] += toxinHealth * volley * spent;
      bySource[toxinTick] += toxinDot * spent;
      shield = spent < fraction ? 0 : shield - dealt;
      fraction -= spent;
    }
    if (fraction > 0) {
      const direct = (toHealth + toxinHealth) * volley * fraction;
      const dot = (dotHealth + toxinDot) * fraction;
      bySource[TICKING.length + 2] += direct;
      for (let i = 0; i < tickDealt.length; i++) bySource[i] += tickDealt[i] * fraction;
      const dealt = direct + dot;
      if (dealt >= health && dealt > 0) {
        killedAt = t + dt * (1 - fraction) + dt * fraction * (health / dealt);
        health = 0;
      } else {
        health -= dealt;
      }
    }
    if (health <= 0 && killedAt === null) killedAt = t + dt;

    if (step % sampleEvery === 0 || killedAt !== null) {
      timeline.push({ t, overguard, shield, health: Math.max(0, health), viral, corrosive, heatStrip: strip, armor });
    }
    if (killedAt !== null) break;

    // ---- advance status timers into the next step
    const next = step + 1;
    for (let i = 0; i < stackWindows.length; i++) stackWindows[i].put(next, stackProcs[i]);
    // Each proc carries its own hit's crit multiplier into its ticks.
    for (let i = 0; i < tickWindows.length; i++) tickWindows[i].put(next, tickWeight[i] * tickSeeds[i]);
    blastLine.put(step, blastWeight * blastSeed);
    heatWindow.put(next, heatProcs);
    heatSeedWindow.put(next, heatWeight * heatSeed);
    if (heatWindow.total > 1e-9) {
      if (heatChainStart === null) {
        heatChainStart = t + dt;
        heatEndedAt = null;
      }
      heatAccumulated += heatWeight * heatSeed;
    } else if (heatChainStart !== null) {
      heatStripAtEnd = heatRamp(t);
      heatChainStart = null;
      heatEndedAt = t + dt;
      heatAccumulated = 0;
    }

    t += dt;
    step++;
  }

  const damageBySource: Record<string, number> = { direct: bySource[TICKING.length + 2] };
  TICKING.forEach((type, i) => { if (bySource[i] > 0) damageBySource[type] = bySource[i]; });
  if (bySource[TICKING.length] > 0) damageBySource.heat = bySource[TICKING.length];
  if (bySource[TICKING.length + 1] > 0) damageBySource.blast = bySource[TICKING.length + 1];
  return { timeToKill: killedAt, shots, damageBySource, atEnd: end, timeline, step: dt };
}
