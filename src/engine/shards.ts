/**
 * Archon Shards on the Warframe (wiki: Archon_Shard, the per-colour pages and the fusion notes).
 *
 * Five slots, one bonus per shard; Tauforged shards give 1.5x. Only the bonuses that change
 * weapon damage are modelled; the rest are accepted as `other` and do nothing here.
 *
 *   Crimson  +25% Melee Critical Damage | +25% Primary Status Chance | +25% Secondary Critical
 *            Chance | +10% Ability Strength            (weapon bonuses add to the mod pools)
 *   Violet   +30% Primary Electricity, +10% more per Crimson, Azure or Violet shard equipped
 *            (itself included), combining like an innate element | +25% Melee Critical Damage,
 *            doubled while max Energy is over 500
 *   Topaz    +1% Secondary Critical Chance per kill of a Heat-affected enemy, up to 50%
 *   Emerald  Toxin status effects deal +30% | Corrosion max stacks +2 (Tauforged +3)
 */
import type { Effect } from '../types.ts';

export type ShardColor = 'crimson' | 'amber' | 'azure' | 'violet' | 'topaz' | 'emerald';

export interface ShardSpec {
  color: ShardColor;
  /** The chosen bonus; see SHARD_BONUSES. */
  bonus: string;
  tauforged?: boolean;
}

/** Bonuses with a weapon effect, per colour, with what each one does. */
export const SHARD_BONUSES: Record<ShardColor, Record<string, string>> = {
  crimson: {
    meleeCritDamage: '+25% Melee Critical Damage',
    primaryStatus: '+25% Primary Status Chance',
    secondaryCrit: '+25% Secondary Critical Chance',
    abilityStrength: '+10% Ability Strength',
    other: 'Ability Duration (no weapon effect)',
  },
  amber: { other: 'no weapon effect' },
  azure: { other: 'no weapon effect' },
  violet: {
    primaryElectricity: '+30% Primary Electricity, +10% per Crimson/Azure/Violet shard',
    meleeCritDamage: '+25% Melee Critical Damage, doubled over 500 max Energy',
    other: 'no weapon effect',
  },
  topaz: {
    secondaryHeatKillCrit: '+1% Secondary Critical Chance per Heat kill, max 50%',
    other: 'no weapon effect',
  },
  emerald: {
    toxinStatusDamage: 'Toxin status effects deal +30%',
    corrosionStacks: 'Corrosion max stacks +2',
    other: 'no weapon effect',
  },
};

export interface ShardResult {
  /** Mod-pool effects, already filtered to the weapon's class. */
  effects: Effect[];
  /** Electricity as a share of base damage, joining the elements like an innate one. */
  electricity: number;
  /** Extra damage of Toxin status ticks (Emerald). */
  toxinStatusDamage: number;
  /** Extra Corrosion stacks allowed (Emerald). */
  corrosiveStacks: number;
  /** Ability Strength points (Crimson). */
  abilityStrength: number;
  warnings: string[];
}

/** Weapon classes a shard's "Primary", "Secondary" or "Melee" wording covers. */
const CLASS_OF: Record<string, 'primary' | 'secondary' | 'melee' | null> = {
  primary: 'primary',
  secondary: 'secondary',
  melee: 'melee',
};

export function shardEffects(shards: ShardSpec[] | undefined, weaponCategory: string): ShardResult {
  const result: ShardResult = { effects: [], electricity: 0, toxinStatusDamage: 0, corrosiveStacks: 0, abilityStrength: 0, warnings: [] };
  const list = (shards ?? []).filter((shard) => shard && shard.color);
  if (list.length > 5) result.warnings.push(`${list.length} Archon Shards: a Warframe has 5 slots, the first 5 are used`);
  const used = list.slice(0, 5);
  const weaponClass = CLASS_OF[weaponCategory] ?? null;
  // Violet Electricity counts every Crimson, Azure and Violet shard, itself included.
  const counted = used.filter((shard) => shard.color === 'crimson' || shard.color === 'azure' || shard.color === 'violet').length;
  const effect = (target: string, value: number, raw: string, extra: Partial<Effect> = {}): Effect =>
    ({ target, op: 'add', value, raw, ...extra }) as Effect;

  for (const shard of used) {
    const k = shard.tauforged ? 1.5 : 1;
    const known = SHARD_BONUSES[shard.color];
    if (!known || !(shard.bonus in known)) {
      result.warnings.push(`unknown ${shard.color} shard bonus: ${shard.bonus}`);
      continue;
    }
    const label = `${shard.tauforged ? 'Tauforged ' : ''}${shard.color} shard`;
    switch (`${shard.color}:${shard.bonus}`) {
      case 'crimson:meleeCritDamage':
        if (weaponClass === 'melee') result.effects.push(effect('critDamage', 0.25 * k, `${label}: Melee Critical Damage`));
        break;
      case 'crimson:primaryStatus':
        if (weaponClass === 'primary') result.effects.push(effect('statusChance', 0.25 * k, `${label}: Primary Status Chance`));
        break;
      case 'crimson:secondaryCrit':
        if (weaponClass === 'secondary') result.effects.push(effect('critChance', 0.25 * k, `${label}: Secondary Critical Chance`));
        break;
      case 'crimson:abilityStrength':
        result.abilityStrength += 10 * k;
        break;
      case 'violet:primaryElectricity':
        if (weaponClass === 'primary') result.electricity += (0.3 + 0.1 * counted) * k;
        break;
      case 'violet:meleeCritDamage':
        if (weaponClass === 'melee') {
          result.effects.push(effect('critDamage', 0.25 * k, `${label}: Melee Critical Damage`));
          // Doubled while max Energy is over 500: the second half is a condition.
          result.effects.push(effect('critDamage', 0.25 * k, `${label}: doubled over 500 max Energy`, { condition: 'energyOver500' }));
        }
        break;
      case 'topaz:secondaryHeatKillCrit':
        if (weaponClass === 'secondary') {
          result.effects.push(effect('critChance', 0.01 * k, `${label}: +${k}% Secondary Critical Chance per Heat kill`, { condition: 'onHeatKill', maxStacks: 50 }));
        }
        break;
      case 'emerald:toxinStatusDamage':
        result.toxinStatusDamage += 0.3 * k;
        break;
      case 'emerald:corrosionStacks':
        result.corrosiveStacks += shard.tauforged ? 3 : 2;
        break;
      default:
        break;
    }
  }
  return result;
}
