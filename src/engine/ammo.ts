/**
 * Ammo Efficiency and Infinite Ammo (wiki: Ammo#Ammo Efficiency, Update 44.1.3).
 *
 *   - Shots per ammo = 1 / (1 - Ammo Efficiency): a magazine lasts magazine / cost shots, and the
 *     fractions carry over between magazines, so the average is exact.
 *   - Sources add up and are capped at 75%. Energized Munitions (Helminth) multiplies on top.
 *   - Some sources give Infinite Ammo for a few seconds instead (cost 0: no reloads).
 *   - Timed buffs with a chance per event (headshot, hit, weak-point kill) are counted by their
 *     uptime: events arrive every `interval` seconds, each procs with `chance`. A buff that
 *     refreshes is up when a proc landed in the last `seconds`: 1 - (1 - chance)^(seconds / interval).
 *     One that does not refresh starts again only after it ran out, a mean interval / chance
 *     later: seconds / (seconds + interval / chance).
 *   - The Incarnon form has its own ammo and ignores all of this (wiki: Vasto Incarnon Genesis).
 *
 * The card texts give none of it in a form the parser reads (several are outdated), so the
 * sources are written out here: mods, Incarnon evolutions and weapon traits. Arcanes are in
 * arcanes.ts, Energized Munitions in buffs.ts, rivens in riven.ts.
 */
import type { AmmoBuffSpec, Effect, WeaponData } from '../types.ts';

export const AMMO_EFFICIENCY_CAP = 0.75;

const pct = (value: number): string => `${Math.round(value * 1000) / 10}%`;
const efficiency = (value: number, raw: string, extra: Partial<Effect> = {}): Effect => ({ target: 'ammoEfficiency', op: 'add', value, raw, ...extra });
/** The condition a timed buff's event stands for: the weak-point ones need head hits. */
export const TRIGGER_CONDITION: Record<AmmoBuffSpec['trigger'], string> = { hit: 'onHit', headshot: 'onWeakPointHit', weakPointKill: 'onWeakPointKill' };
/** A timed buff: `chance` per event is the effect's value, so rank and stack gating apply to it. */
const timed = (chance: number, spec: AmmoBuffSpec, raw: string, extra: Partial<Effect> = {}): Effect => ({ target: 'ammoBuff', op: 'add', value: chance, raw, ammoBuff: spec, condition: TRIGGER_CONDITION[spec.trigger], ...extra });
const infinite = (seconds: number, trigger: AmmoBuffSpec['trigger'], refresh: boolean, every?: number): AmmoBuffSpec => ({ seconds, trigger, refresh, efficiency: 1, every });

/** Weapon augments, by rank (wiki tables; Brain Storm and Skull Shots since Update 44.1.3). */
const MODS: Record<string, (r: number) => Effect[]> = {
  // Brain Storm refreshes on headshots (wiki); Skull Shots is the same mod for the Viper.
  'Brain Storm': (r) => [timed(0.1 * (r + 1), infinite([0.5, 1, 2, 2][r], 'headshot', true), `On Headshot: ${pct(0.1 * (r + 1))} chance for Infinite Ammo for ${[0.5, 1, 2, 2][r]}s`)],
  'Skull Shots': (r) => [timed(0.1 * (r + 1), infinite([0.5, 1, 2, 2][r], 'headshot', true), `On Headshot: ${pct(0.1 * (r + 1))} chance for Infinite Ammo for ${[0.5, 1, 2, 2][r]}s`)],
  'Zazvat-Kar': (r) => [efficiency(0.125 * (r + 1), `+${pct(0.125 * (r + 1))} Ammo Efficiency while Airborne`, { condition: 'airborne' })],
};

/** Incarnon evolutions, by perk name: the same numbers on every variant (wiki: Ammo). */
const INCARNON: Record<string, Effect[]> = {
  'Daring Reverie': [efficiency(0.5, 'With Channeled Ability active: +50% Ammo Efficiency', { condition: 'with_channeled_ability_active' })],
  'Trusty Sidearm': [efficiency(0.6, 'With Channeled Ability active: +60% Ammo Efficiency', { condition: 'with_channeled_ability_active' })],
  'Crimson Overture': [efficiency(0.25, 'On Kill: +25% Ammo Efficiency for 5s, up to 3x', { condition: 'onKill', maxStacks: 3 })],
  // +80% on the card, lowered to the 75% cap in Update 44.1.3.
  'Enough for Everyone': [efficiency(0.75, '+75% Ammo Efficiency when 6 enemies are within 6m', { condition: 'sixEnemiesNear' })],
  'Ruptured Plentitude': [efficiency(0.7, 'On Punch Through 3 enemies: +70% Ammo Efficiency for 20s', { condition: 'punchThroughThree' })],
  'Agile Executor': [efficiency(0.5, '+50% Ammo Efficiency while Aim Gliding and Sliding', { condition: 'sliding' })],
  'Feather of Justice': [efficiency(0.6, '+60% Ammo Efficiency while Aim Gliding or Sliding', { condition: 'sliding', form: 'normal' })],
  "Marksman's Gain": [timed(0.2, { seconds: 6, trigger: 'headshot', refresh: true, efficiency: 0.5 }, 'On Headshot: 20% chance for +50% Ammo Efficiency for 6s', { form: 'normal' })],
};
/** Reaper's Plenty differs per weapon. Whether it refreshes is not stated: counted as not refreshing. */
const REAPERS_PLENTY: Record<string, Effect[]> = {
  Vasto: [timed(1, infinite(2, 'headshot', false), 'On Headshot: Infinite Ammo for 2s', { form: 'normal' })],
  Laetum: [timed(1, { seconds: 6, trigger: 'headshot', refresh: false, efficiency: 0.4 }, 'On Headshot: +40% Ammo Efficiency for 6s', { form: 'normal' })],
};

/** Weapon traits (wiki: Ammo, each weapon's page). Their other effects (fire rate...) are not modelled. */
const WEAPONS: Record<string, Effect[]> = {
  'Magnus Prime': [timed(0.04, infinite(4, 'hit', true), 'Chamber Cascade: on hit, 4% chance for Infinite Ammo for 4s')],
  'Akmagnus Prime': [timed(0.04, infinite(4, 'hit', true), 'Chamber Cascade: on hit, 4% chance for Infinite Ammo for 4s')],
  Athodai: [timed(1, infinite(8, 'weakPointKill', false), 'Overdrive: on headshot kill, Infinite Ammo for 8s')],
  'Athodai Prime': [timed(1, infinite(12, 'weakPointKill', false), 'Overdrive: on headshot kill, Infinite Ammo for 12s')],
  'Dual Toxocyst': [timed(1, infinite(3, 'headshot', true), 'Frenzy: on headshot, Infinite Ammo for 3s')],
  Knell: [timed(1, infinite(2, 'headshot', true), 'Death Knell: on weak point hit, Infinite Ammo for 2s')],
  'Knell Prime': [timed(1, infinite(2, 'headshot', true), 'Death Knell: on weak point hit, Infinite Ammo for 2s')],
  // Four headshots in a burst (or a headshot kill, which comes later than four headshots).
  Perigale: [timed(1, infinite(4, 'headshot', true, 4), 'Gale Force: on 4 headshots, Infinite Ammo for 4s')],
  'Perigale Prime': [timed(1, infinite(4, 'headshot', true, 4), 'Gale Force: on 4 headshots, Infinite Ammo for 4s')],
};
const PROTEA = /^Protea( Prime)?$/i;

export function modAmmoEffects(name: string, rank: number, maxRank: number): Effect[] {
  return MODS[name]?.(Math.max(0, Math.min(maxRank, rank))) ?? [];
}

export function incarnonAmmoEffects(weapon: WeaponData, perk: string): Effect[] {
  if (perk === "Reaper's Plenty") return REAPERS_PLENTY[weapon.name.split(' ')[0]] ?? [];
  return INCARNON[perk] ?? [];
}

export function weaponAmmoEffects(weapon: WeaponData, frame: string | undefined, aiming = false): Effect[] {
  // AX-52: +75% when hip-firing (aiming gives it headshot crit chance instead, traits.ts).
  if (weapon.name === 'Ax-52') return aiming ? [] : [efficiency(0.75, 'Hip-fire: +75% Ammo Efficiency')];
  // Velox: 20% innate, 40% in Protea's hands (signature weapon).
  if (/^Velox( Prime)?$/.test(weapon.name)) {
    const value = PROTEA.test(frame ?? '') ? 0.4 : 0.2;
    return [efficiency(value, `${pct(value)} innate Ammo Efficiency${value > 0.2 ? ' (Protea)' : ''}`)];
  }
  return WEAPONS[weapon.name] ?? [];
}

/** A timed buff in a resolved build: its spec and its chance per event. */
export interface AmmoBuff extends AmmoBuffSpec {
  name: string;
  chance: number;
}

/** Ammo per shot from the always-on sources: additive ones capped, multiplicative ones on top. */
export function ammoCost(additive: number, multiplicative: number[]): number {
  return (1 - Math.min(AMMO_EFFICIENCY_CAP, Math.max(0, additive))) * multiplicative.reduce((cost, value) => cost * (1 - Math.min(1, value)), 1);
}

/** Share of the time a timed buff is up, given its events' spacing in seconds. */
export function ammoBuffUptime(buff: AmmoBuff, interval: number): number {
  const chance = Math.min(1, Math.max(0, buff.chance));
  if (!(chance > 0) || !(interval > 0) || !Number.isFinite(interval)) return 0;
  if (buff.refresh) return 1 - Math.pow(1 - chance, buff.seconds / interval);
  return buff.seconds / (buff.seconds + interval / chance);
}

/**
 * Average ammo per shot with the timed buffs at their uptimes, taken as independent: every on/off
 * combination, weighted by its odds. Infinite Ammo makes a shot free; an efficiency buff adds to
 * the always-on sources under the same cap.
 */
export function expectedAmmoCost(additive: number, multiplicative: number[], buffs: AmmoBuff[], uptimes: number[]): number {
  let total = 0;
  for (let mask = 0; mask < 1 << buffs.length; mask++) {
    let odds = 1;
    let extra = 0;
    let free = false;
    buffs.forEach((buff, i) => {
      const on = (mask >> i) & 1;
      odds *= on ? uptimes[i] : 1 - uptimes[i];
      if (!on) return;
      if (buff.efficiency >= 1) free = true;
      else extra += buff.efficiency;
    });
    if (odds > 0) total += odds * (free ? 0 : ammoCost(additive + extra, multiplicative));
  }
  return total;
}
