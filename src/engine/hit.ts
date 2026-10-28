/**
 * Where a shot lands, and what that does to damage and crits (wiki: Enemy Body Parts,
 * Critical Hit → Critical Headshots).
 *
 *   head  multiplier = (weak point base + 1.5 × Σ weak point damage) × (1 + Σ headshot multiplier)
 *         weak point base: 3.0x for most factions, 1.5x for the Murmur and the Techrot, or a
 *         replacement such as Sonar's
 *         crit chance += base crit × Σ weak point critical chance
 *         head crits double the critical multiplier: 1 + tier × (2 × CD − 1), except on heads
 *         that cannot be crit-headshot (Corpus, most Murmur and Techrot)
 *   body  multiplier = 1 + Σ bodyshot damage (Meticulous Aim −45%)
 *
 * The same location multiplier and crit multiplier carry into status ticks (wiki:
 * Damage_over_Time → DoT Damage Scaling lists body part multipliers and critical hits).
 */
import type { ResolvedBuild } from './build.ts';

/** Factions whose heads are softer weak points (wiki: "closer to 1.5x"). */
const SOFT_HEADS = new Set(['murmur', 'techrot']);

/**
 * Wiki (Weak Point): the critical headshot "excludes the heads of all Corpus humanoids and ground
 * units, most of The Murmur, and much of Techrot"; they still take the weak point multiplier.
 * shortcut: the whole faction for Murmur and Techrot, the wiki names no exceptions; per-unit data would refine it.
 */
const NO_CRIT_HEADSHOT = new Set(['corpus', 'murmur', 'techrot']);

export function weakPointBase(faction: string | null | undefined): number {
  return SOFT_HEADS.has(String(faction ?? '').toLowerCase()) ? 1.5 : 3;
}

export interface HitProfile {
  zone: 'head' | 'body';
  /** Damage multiplier of the hit location. */
  location: number;
  /** Crit chance on this location (weak point crit chance included). */
  critChance: number;
  /** Average crit multiplier over all hits. */
  averageCrit: number;
  /** Average crit multiplier of a hit that did crit (orange/red tiers included). */
  critOnCrit: number;
  /** Whether crits on this hit double the critical multiplier (a critical headshot). */
  critHeadshot: boolean;
}

export function hitProfile(build: ResolvedBuild, faction: string | null | undefined): HitProfile {
  const head = build.hitZone === 'head';
  const location = head
    ? ((build.weakPointOverride || weakPointBase(faction)) + 1.5 * build.weakPointDamageBonus) * (1 + build.headshotMultiplierBonus) * (build.headshotFactor ?? 1)
    : Math.max(0, 1 + build.bodyshotMultiplierBonus);
  const critChance = Math.max(0, build.critChance + (head ? build.weakPointCritChance : 0));
  const critDamage = Math.max(1, build.critMultiplier);
  // Expected crit tier equals the crit chance at any value, so the average is linear in it.
  const critHeadshot = head && !NO_CRIT_HEADSHOT.has(String(faction ?? '').toLowerCase());
  const perTier = critHeadshot ? 2 * critDamage - 1 : critDamage - 1;
  // Vigilante: a hit that crits gains one more tier at `critTierBonus` odds.
  const averageCrit = 1 + (critChance + Math.min(1, critChance) * build.critTierBonus) * perTier;
  const p = Math.min(1, critChance);
  const critOnCrit = p > 0 ? (averageCrit - (1 - p)) / p : 1 + perTier;
  return { zone: head ? 'head' : 'body', location, critChance, averageCrit, critOnCrit, critHeadshot };
}
