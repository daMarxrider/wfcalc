/**
 * Riven mods.
 *
 * Riven attribute values follow the wiki (Riven Mods → Attributes):
 *
 *   value = base_attribute_value × disposition × roll_weight × random(0.9 … 1.1)
 *
 * then scaled by mod rank (rank 8 = full value) and by how many bonuses and
 * maluses the riven has:
 *
 *   | build        | bonus weight | malus weight |
 *   | 2 bonuses    | 0.99         | –            |
 *   | 2 + 1 malus  | 1.2375       | −0.495       |
 *   | 3 bonuses    | 0.75         | –            |
 *   | 3 + 1 malus  | 0.9375       | −0.75        |
 *
 * The base values are parsed from the wiki table into `snapshot.rivenStats`;
 * the disposition multiplier is the game's own value (`omegaAttenuation`).
 */
import type { DamageType, Effect, Faction, ModData, Snapshot, WeaponData } from '../types.ts';

export interface RivenSpec {
  /** Attribute ids, see RIVEN_ATTRIBUTES. Two or three bonuses. */
  stats: string[];
  /** Optional negative attribute. */
  malus?: string;
  /** 0.9 … 1.1 random roll; 1 is an average riven. */
  roll?: number;
  /** Mod rank, 0-8. Defaults to 8 (max). */
  rank?: number;
  /**
   * The values printed on the player's own riven, by attribute id (malus included): percent for
   * percentage stats (142.3 for +142.3%), the multiplier for faction stats (1.24 for x1.24), the
   * plain amount for metres and seconds. A stat given here skips the disposition/roll estimate.
   */
  values?: Record<string, number>;
  /** Drain shown on the card at its rank, and its polarity: what the riven costs in its slot. */
  drain?: number;
  polarity?: string;
}

/** The riven as a mod for capacity: its card drain, polarity and slot (no effects of its own). */
export function rivenAsMod(spec: RivenSpec): ModData | null {
  if (spec.drain === undefined || !Number.isFinite(spec.drain)) return null;
  return {
    id: 'Riven', name: 'Riven', category: 'Riven Mod', classes: [], polarity: spec.polarity ?? null, rarity: 'Riven',
    baseDrain: Math.max(0, spec.drain), maxRank: 0, description: '', effects: [], cardImage: null, partial: false,
    outOfScopeLines: [], incompatible: [], set: null, upgradeTypes: [], isAugment: false, isRiven: true, conclave: false,
  } as unknown as ModData;
}

export interface RivenAttribute {
  id: string;
  /** Label exactly as the wiki table writes it. */
  label: string;
  target: string;
  element?: DamageType;
  faction?: Faction;
  /** True when the wiki value is a flat amount (metres, seconds) instead of a fraction. */
  flat?: boolean;
}

const ELEMENT_ATTRIBUTES = ['heat', 'cold', 'electricity', 'toxin'] as const;
const PHYSICAL_ATTRIBUTES = ['impact', 'puncture', 'slash'] as const;
const FACTION_ATTRIBUTES: Array<[string, Faction]> = [
  ['corpus', 'corpus'],
  ['grineer', 'grineer'],
  ['infested', 'infested'],
  ['orokin', 'orokin'],
  ['murmur', 'murmur'],
  ['sentient', 'sentient'],
];

/** Every riven attribute the calculator understands, with the id used on the CLI. */
export const RIVEN_ATTRIBUTES: RivenAttribute[] = [
  { id: 'damage', label: 'Damage', target: 'baseDamage' },
  { id: 'multishot', label: 'Multishot', target: 'multishot' },
  { id: 'crit-chance', label: 'Critical Chance', target: 'critChance' },
  { id: 'crit-damage', label: 'Critical Damage', target: 'critDamage' },
  { id: 'status-chance', label: 'Status Chance', target: 'statusChance' },
  { id: 'status-duration', label: 'Status Duration', target: 'statusDuration' },
  { id: 'fire-rate', label: 'Fire Rate', target: 'fireRate' },
  { id: 'reload', label: 'Reload Speed', target: 'reloadSpeed' },
  { id: 'magazine', label: 'Magazine Capacity', target: 'magazine' },
  { id: 'ammo', label: 'Ammo Maximum', target: 'ammoMax' },
  { id: 'punch', label: 'Punch Through', target: 'punchThrough', flat: true },
  { id: 'zoom', label: 'Zoom', target: 'zoom' },
  { id: 'recoil', label: 'Recoil', target: 'recoil' },
  { id: 'proj-speed', label: 'Projectile Speed', target: 'projectileSpeed' },
  ...ELEMENT_ATTRIBUTES.map((element) => ({
    id: element,
    label: `${element[0].toUpperCase()}${element.slice(1)} Damage`,
    target: 'element',
    element: element as DamageType,
  })),
  ...PHYSICAL_ATTRIBUTES.map((type) => ({
    id: type,
    label: `${type[0].toUpperCase()}${type.slice(1)} Damage`,
    target: 'element',
    element: type as DamageType,
  })),
  ...FACTION_ATTRIBUTES.map(([id, faction]) => ({
    id: `faction-${id}`,
    label: `Damage vs. ${id[0].toUpperCase()}${id.slice(1)}`,
    target: 'factionDamage',
    faction,
  })),
];

export const findRivenAttribute = (id: string): RivenAttribute | undefined =>
  RIVEN_ATTRIBUTES.find((attribute) => attribute.id === id.toLowerCase())
  ?? RIVEN_ATTRIBUTES.find((attribute) => attribute.label.toLowerCase().replace(/[^a-z]/g, '') === id.toLowerCase().replace(/[^a-z]/g, ''));

/** Which column of the wiki table a weapon uses. */
export function rivenClass(weapon: WeaponData): string {
  switch (weapon.category) {
    case 'shotgun':
      return 'shotgun';
    case 'primary':
      return 'rifle'; // rifles, bows, snipers and launchers all share the rifle table
    case 'secondary':
      return 'pistol';
    case 'melee':
      return 'melee';
    case 'archgun':
      return 'archgun';
    default:
      return 'rifle';
  }
}

/** Bonus/malus weights by riven build shape (wiki: Attribute Value Formula). */
function rivenWeights(stats: string[], malus: string | undefined): { bonus: number; malus: number } {
  const hasMalus = Boolean(malus);
  if (stats.length >= 3) return { bonus: hasMalus ? 0.9375 : 0.75, malus: hasMalus ? -0.75 : 0 };
  return { bonus: hasMalus ? 1.2375 : 0.99, malus: hasMalus ? -0.495 : 0 };
}

export interface RivenResult {
  effects: Effect[];
  /** Human-readable summary lines, e.g. "Damage +120.4%". */
  lines: string[];
  warnings: string[];
  disposition: number;
}

/** Turns a riven spec into effects for a specific weapon. */
export function rivenEffects(snapshot: Snapshot, weapon: WeaponData, spec: RivenSpec): RivenResult {
  const warnings: string[] = [];
  const effects: Effect[] = [];
  const lines: string[] = [];

  const disposition = weapon.dispositionMultiplier ?? 1;
  const table = snapshot.rivenStats[rivenClass(weapon)] ?? {};
  const roll = Math.min(1.1, Math.max(0.9, spec.roll ?? 1));
  const rank = Math.max(0, Math.min(8, spec.rank ?? 8));
  const rankScale = (rank + 1) / 9;
  const weights = rivenWeights(spec.stats, spec.malus);

  const stats = spec.stats.slice(0, 3);
  if (!stats.length) warnings.push('riven has no positive stats');
  if (stats.length > 3) warnings.push('rivens have at most three positive stats; extras ignored');

  const build = (id: string, negative: boolean) => {
    const attribute = findRivenAttribute(id);
    if (!attribute) {
      warnings.push(`unknown riven attribute: ${id}`);
      return;
    }
    const given = spec.values?.[id] ?? spec.values?.[attribute.id];
    let value: number;
    if (given !== undefined && Number.isFinite(given)) {
      // The player's own riven: the card value as printed, its sign set by bonus or malus.
      const magnitude = Math.abs(given);
      const fraction = attribute.faction ? (magnitude < 3 ? magnitude - 1 : magnitude / 100) : attribute.flat ? magnitude : magnitude / 100;
      value = negative ? (attribute.faction ? -Math.abs(fraction) : -fraction) : fraction;
    } else {
      const base = table[attribute.label];
      if (base === undefined || base === 0) {
        warnings.push(`${attribute.label} is not available on ${weapon.type} rivens`);
        return;
      }
      const weight = negative ? weights.malus : weights.bonus;
      if (weight === 0) return;
      value = base * disposition * weight * roll * rankScale;
    }
    const raw = `${attribute.label} ${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
    lines.push(raw);
    effects.push({
      target: attribute.target,
      op: attribute.target === 'factionDamage' ? 'add' : 'add',
      value,
      element: attribute.element,
      faction: attribute.faction,
      raw,
      ...(attribute.flat ? { flat: true } : {}),
    });
  };

  for (const id of stats) build(id, false);
  if (spec.malus) build(spec.malus, true);

  return { effects, lines, warnings, disposition };
}
