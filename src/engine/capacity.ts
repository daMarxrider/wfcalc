/**
 * Mod capacity and Forma for an arbitrary build.
 *
 * The search fits its own candidates, but `calc` and the HTTP API also need to say whether a
 * list the player handed us actually fits. Both go through the same fitter, so "59/60 with 3
 * Forma" means the same thing everywhere.
 */
import { findMod } from '../data.ts';
import type { BuildMod } from './build.ts';
import { fitMods } from './search.ts';
import { rivenAsMod, type RivenSpec } from './riven.ts';
import type { Snapshot, WeaponData } from '../types.ts';

export interface CapacityResult {
  capacityUsed: number;
  capacity: number;
  formaNeeded: number;
  fits: boolean;
  mods: Array<{ name: string; rank: number; drain: number; polarity: string | null; halvedByPolarity: boolean }>;
}

export function capacityOf(
  snapshot: Snapshot,
  weapon: WeaponData,
  mods: Array<string | BuildMod>,
  capacity = 60,
  riven?: RivenSpec,
): CapacityResult {
  const resolved: Array<{ mod: NonNullable<ReturnType<typeof findMod>['item']>; rank: number }> = [];
  for (const entry of mods) {
    const name = typeof entry === 'string' ? entry : entry.name;
    const rank = typeof entry === 'string' ? undefined : entry.rank;
    const { item } = findMod(snapshot, name);
    if (!item) continue;
    resolved.push({ mod: item, rank: rank ?? item.maxRank });
  }
  // A riven with its card drain takes a slot and capacity like any mod.
  const rivenMod = riven ? rivenAsMod(riven) : null;
  if (rivenMod) resolved.push({ mod: rivenMod, rank: 0 });
  const fitted = fitMods(resolved, weapon, capacity);
  return {
    capacityUsed: fitted.drain,
    capacity,
    formaNeeded: fitted.formaNeeded,
    fits: fitted.drain <= capacity,
    mods: fitted.entries,
  };
}
