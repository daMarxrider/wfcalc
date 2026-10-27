/**
 * Arcane rules the card text alone does not give the engine (all from wiki.warframe.com).
 *
 *   - Rank values: arcanes do not all scale linearly with rank. Merciless gets its +30% Reload
 *     Speed only at max rank, Doughty goes 0.5x..1.0x. Every parsed effect is read off the text
 *     of the equipped rank instead of being scaled from max rank.
 *   - Weapon scope: Warframe arcanes that buff one weapon class (Arcane Fury: melee only).
 *   - Curated effects: arcanes whose text the parser cannot map, written out per rank. Some use
 *     targets that build.ts turns into a mechanic of their own (Doughty, Duplicate, Plated Round,
 *     Fortifier, Empowered, Enervate).
 */
import type { ArcaneData, Effect, WeaponData } from '../types.ts';

/** Warframe arcanes that buff one weapon class only. Absent: every weapon. */
const WEAPON_SCOPE: Record<string, { label: string; fits: (weapon: WeaponData) => boolean }> = {
  'Arcane Acceleration': { label: 'primary weapons except shotguns', fits: (w) => w.category === 'primary' && w.type !== 'Shotgun' },
  'Arcane Arachne': { label: 'primary and secondary weapons', fits: (w) => w.category === 'primary' || w.category === 'secondary' },
  'Arcane Awakening': { label: 'secondary weapons', fits: (w) => w.category === 'secondary' },
  'Arcane Blade Charger': { label: 'melee weapons', fits: (w) => w.category === 'melee' },
  'Arcane Fury': { label: 'melee weapons', fits: (w) => w.category === 'melee' },
  'Arcane Momentum': { label: 'sniper rifles', fits: (w) => w.type === 'Sniper' },
  'Arcane Precision': { label: 'secondary weapons', fits: (w) => w.category === 'secondary' },
  'Arcane Primary Charger': { label: 'primary weapons', fits: (w) => w.category === 'primary' },
  'Arcane Rage': { label: 'primary weapons', fits: (w) => w.category === 'primary' },
  'Arcane Rise': { label: 'primary weapons', fits: (w) => w.category === 'primary' },
  'Arcane Strike': { label: 'melee weapons', fits: (w) => w.category === 'melee' },
  'Arcane Tempo': { label: 'shotguns', fits: (w) => w.type === 'Shotgun' },
  'Arcane Velocity': { label: 'secondary weapons', fits: (w) => w.category === 'secondary' },
};

/** Which weapons a Warframe arcane buffs, or null when it buffs this one. */
export function arcaneScopeMiss(name: string, weapon: WeaponData): string | null {
  const scope = WEAPON_SCOPE[name];
  return scope && !scope.fits(weapon) ? scope.label : null;
}

const pct = (value: number): string => `${Math.round(value * 10000) / 100}%`;
const effect = (target: string, value: number, raw: string, extra: Partial<Effect> = {}): Effect => ({ target, op: 'add', value, raw, ...extra });

/** Effects at rank `r` (0..max) for arcanes the parser cannot read, per the wiki's rank tables. */
const CURATED: Record<string, (r: number, context: { heavyAttack: boolean }) => Effect[]> = {
  'Arcane Awakening': (r) => [effect('baseDamage', 0.25 * (r + 1), `On Reload: +${pct(0.25 * (r + 1))} Damage to Pistols`, { condition: 'onReload' })],
  'Arcane Primary Charger': (r) => [effect('baseDamage', 0.5 * (r + 1), `On Melee Kill: +${pct(0.5 * (r + 1))} Primary Weapon Damage`, { condition: 'onMeleeKill' })],
  'Arcane Tempo': (r) => [effect('fireRate', 0.15 * (r + 1), `On Critical Hit: +${pct(0.15 * (r + 1))} Fire Rate to Shotguns`, { condition: 'on_critical_hit' })],
  'Arcane Velocity': (r) => [effect('fireRate', 0.2 * (r + 1), `On Critical Hit: +${pct(0.2 * (r + 1))} Fire Rate to Pistols`, { condition: 'on_critical_hit' })],
  'Arcane Hot Shot': (r) => [effect('critChance', 0.01 * (r + 1), `Ability Heat procs: +${pct(0.01 * (r + 1))} Critical Chance per stack, up to 50x`, { condition: 'onAbilityHeatProc', maxStacks: 50 })],
  // "Final" critical damage: added to the finished multiplier, after mods.
  'Arcane Crepuscular': (r) => [
    effect('critDamage', 0.5 * (r + 1), `While invisible: +${0.5 * (r + 1)}x Final Critical Damage`, { op: 'flat', condition: 'whileInvisible' }),
    effect('abilityStrength', 0.05 * (r + 1), `While invisible: +${pct(0.05 * (r + 1))} Ability Strength`, { condition: 'whileInvisible' }),
  ],
  'Cascadia Accuracy': (r) => [effect('weakPointCritChance', 0.5 * (r + 1), `On Roll: +${pct(0.5 * (r + 1))} Critical Chance on Weak Point Hits`, { condition: 'onRoll' })],
  'Melee Animosity': (r, { heavyAttack }) => (heavyAttack
    ? [effect('critChance', 0.07 * (r + 1), `Per melee hit: +${pct(0.07 * (r + 1))} Critical Chance on the next Heavy Attack, up to 10x`, { condition: 'onMeleeHit', maxStacks: 10 })]
    : []),
  'Melee Assimilation': (r, { heavyAttack }) => (heavyAttack
    ? [effect('baseDamage', 0.25 * (r + 1), `On Shield Break: +${pct(0.25 * (r + 1))} Melee Damage on Heavy Attack`, { condition: 'onShieldBreak' })]
    : []),
  // A multiplier of its own ("x2.5"), against fully frozen targets (10 Cold stacks).
  'Melee Careen': (r) => [effect('damageMultiplier', 0.25 * (r + 1), `x${1 + 0.25 * (r + 1)} Melee Damage against Frozen enemies`, { op: 'mult', condition: 'enemyFrozen' })],
  'Melee Doughty': (r) => [effect('doughty', 0.5 + 0.1 * r, `+${0.5 + 0.1 * r}x Critical Damage per 10% Puncture status chance`)],
  'Melee Duplicate': (r) => [effect('duplicateChance', 0.25 + 0.15 * r, `On Base Critical Hits: ${pct(0.25 + 0.15 * r)} chance to strike a second time`)],
  // Stacks = whole 200s of current Shields; the cap is 420% at every rank.
  'Melee Retaliation': (r) => [effect('baseDamage', 0.05 * (r + 1), `+${pct(0.05 * (r + 1))} Melee Damage per 200 Shields, up to 420%`, { condition: 'per200Shields', maxStacks: 420 / (5 * (r + 1)) })],
  // Stacks = armour points past 1,000; the bonus stops at 1,500 armour at every rank.
  'Primary Bulwark': (r) => [effect('baseDamage', 0.005 + 0.001 * r, `+${pct(0.005 + 0.001 * r)} damage per armour point past 1,000, up to 500 points`, { condition: 'armorOver1000', maxStacks: 500 })],
  'Primary Crux': (r) => [effect('statusChance', 0.05 * (r + 1), `On Weak Point Hit: +${pct(0.05 * (r + 1))} Status Chance, up to 10x`, { condition: 'onWeakPointHit', maxStacks: 10 })],
  // Stacks = max Energy (at 90% Energy or more); 35% of it as Multishot, capped per rank.
  'Primary Overcharge': (r) => [effect('multishot', 0.0035, `At 90%+ Energy: 35% of Max Energy as Multishot, up to ${pct(1 + 0.5 * r)}`, { condition: 'maxEnergy', maxStacks: (1 + 0.5 * r) / 0.0035 })],
  // Value = buff duration in seconds; build.ts turns it into the magazine-based bonus.
  'Primary Plated Round': (r) => [effect('platedRound', [3, 4, 5, 6, 8, 10][r], `On Reload: damage per round loaded for ${[3, 4, 5, 6, 8, 10][r]}s`, { condition: 'onReload' })],
  'Secondary Enervate': (r) => [effect('enervateResets', r + 1, `On Hit: +10% Critical Chance, resets after ${r + 1} Big Critical Hits`)],
  'Secondary Fortifier': (r) => [effect('overguardDamage', 3 + r, `x${3 + r} damage to Overguard`)],
  'Cascadia Empowered': (r) => [effect('procDamage', 250 + 100 * r, `On Status Effect: +${250 + 100 * r} damage of that status's type`)],
  // No global cap on the wiki; 24 is the largest buff count it lists (Jade, Octavia).
  'Secondary Kinship': (r) => [effect('critChance', [0.0334, 0.0667, 0.1002, 0.1336, 0.167, 0.2004][r], `Per ally buff: +${pct([0.0334, 0.0667, 0.1002, 0.1336, 0.167, 0.2004][r])} Critical Chance`, { condition: 'allyBuffs', maxStacks: 24 })],
  'Secondary Outburst': (r) => {
    const value = [0.05, 0.07, 0.09, 0.12, 0.16, 0.2][r];
    return [
      effect('critChance', value, `Per combo multiplier consumed: +${pct(value)} Critical Chance`, { condition: 'comboConsumed', maxStacks: 12 }),
      effect('critDamage', value, `Per combo multiplier consumed: +${pct(value)} Critical Damage`, { condition: 'comboConsumed', maxStacks: 12 }),
    ];
  },
  // Per Cold stack on the target (10 at most); additive to Hornet Strike.
  'Secondary Shiver': (r) => [effect('baseDamage', 0.075 * (r + 1), `+${pct(0.075 * (r + 1))} damage per Cold stack on the target`, { condition: 'on_cold_status_effect', maxStacks: 10 })],
};

const clean = (text: string): string => text.replace(/<[^>]+>/g, '').replace(/\\n|\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
const NUMBER = /\d+(?:\.\d+)?/g;
const scaleCache = new Map<string, number>();

/**
 * How much of an effect's max-rank value applies at `rank`, read from that rank's own text:
 * the effect's line with its numbers as wildcards. Absent at that rank (a max-rank-only line)
 * means 0. When the line cannot be found even at max rank, the linear (rank + 1) / (max + 1).
 */
export function arcaneRankScale(arcane: ArcaneData, line: Effect, rank: number): number {
  const top = arcane.maxRank;
  if (rank >= top || top <= 0) return 1;
  const linear = (rank + 1) / (top + 1);
  if (arcane.levels?.length !== top + 1) return linear;
  const key = `${arcane.name}\u0000${line.raw}\u0000${rank}`;
  const cached = scaleCache.get(key);
  if (cached !== undefined) return cached;
  const raw = clean(line.raw);
  const value = Number(raw.match(NUMBER)?.[0] ?? NaN);
  const pattern = new RegExp(raw.split(NUMBER).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(\\d+(?:\\.\\d+)?)'));
  let scale = linear;
  if (value > 0 && pattern.test(clean(arcane.levels[top]))) {
    const match = pattern.exec(clean(arcane.levels[rank]));
    scale = match ? Number(match[1]) / value : 0;
  }
  scaleCache.set(key, scale);
  return scale;
}

/** An arcane's effects at the equipped rank (default max), values already scaled. */
export function arcaneEffectsAt(arcane: ArcaneData, rank: number | undefined, context: { heavyAttack: boolean } = { heavyAttack: false }): Effect[] {
  const at = Math.max(0, Math.min(arcane.maxRank, rank ?? arcane.maxRank));
  const curated = CURATED[arcane.name];
  if (curated) return curated(at, context);
  return arcane.effects
    .map((line) => ({ ...line, value: line.value * arcaneRankScale(arcane, line, at) }))
    .filter((line) => line.value !== 0);
}

/**
 * Secondary Enervate (wiki): every shot adds +10% flat crit chance, and the bonus resets after
 * `resets` Big Critical Hits (tier 2 and up, i.e. the part of crit chance above 100%). Damage is
 * linear in crit chance, so the average crit chance over a reset cycle gives the average damage.
 * The cycle is walked exactly: on shot k the bonus is (k-1) x `hitsPerShot` x 10%, and the cycle
 * ends with the `resets`-th big crit. Pellets of one shot land in one tick and count as one big
 * crit at most. See `enervateHitsPerShot` for how many hits a shot is.
 */
export function enervateCritChance(critChance: number, resets: number, pellets = 1, hitsPerShot = 1): number {
  let bigs = [1]; // bigs[b]: chance the cycle is still running with b big crits so far
  let shots = 0;
  let total = 0;
  for (let k = 0; bigs.some((p) => p > 1e-12); k++) {
    const chance = critChance + 0.1 * hitsPerShot * k;
    const big = 1 - Math.pow(1 - Math.min(1, Math.max(0, chance - 1)), Math.max(1, pellets));
    const alive = bigs.reduce((sum, p) => sum + p, 0);
    shots += alive;
    total += alive * chance;
    const next = new Array(resets).fill(0);
    bigs.forEach((p, b) => {
      next[b] += p * (1 - big);
      if (b + 1 < resets) next[b + 1] += p * big;
    });
    bigs = next;
  }
  return total / shots;
}

/**
 * Hits one shot counts for an on-hit stack (wiki: Secondary Enervate). Hitscan multishot and AoE
 * are one hit, projectile multishot is one hit per pellet, a shotgun sidearm's pellets are one
 * hit, and the arcane triggers at most 30 times a second.
 */
export function enervateHitsPerShot(weapon: WeaponData, trigger: string | null | undefined, multishot: number, fireRate: number): number {
  const hits = /projectile/i.test(trigger ?? '') && !weapon.shotgunSidearm ? Math.max(1, multishot) : 1;
  return Math.min(hits, 30 / Math.max(0.01, fireRate));
}
