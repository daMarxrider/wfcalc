/**
 * Modular weapons: every zaw, kitgun and amp part combination assembled into a normal weapon,
 * so the rest of the engine (build, search, brute force, riven picker) needs no special case.
 * Part data is the wiki's (snapshot.modular, tools/fetch-modular.ts); the combination rules are
 * the wiki's own Module:Modular:
 *
 *   Zaw     damage = (strike damage + grip + link) x strike multiplier for the grip's hand type,
 *           split over the strike's damage types in proportion (Plague strikes: a quarter of the
 *           change to each type); speed = strike + grip + link; crit/status = strike + link.
 *   Kitgun  damage and fire rate come from the chamber's table for the grip; crit/status/crit
 *           damage = chamber + loader; magazine = the chamber's size for the loader's class;
 *           reload = loader.
 *   Amp     the prism's attack (its explosion included) with the brace's bonuses; the scaffold's
 *           attack is a second fire mode. Energy works as a magazine: pool / energy per shot
 *           shots, refilled after the recharge delay at the recharge rate.
 *
 *           The Slide Attack mode is the total damage x the strike's Slide multiplier for the grip's
 *           hand type (the wiki's SlideDamage), with the same crit, status and speed.
 *
 * Not modelled: kitgun explosions and tendrils (the wiki has no numbers for them), zaw slam, heavy
 * slam and heavy attacks and their wind-up (the wiki lists none for zaws, and no melee weapon
 * has a heavy wind-up in the data), the Leap and Wall multipliers in Module:Modular/data (the
 * wiki never uses them), amp energy regeneration while firing.
 */
import type { DamageType, ModularKind, ModularSource, Snapshot, WeaponData, WeaponMode, WeaponStats, WikiTable } from '../types.ts';

/** Amp braces (wiki: Amp, and each brace's page). Crit/status are flat additions. */
export const AMP_BRACES: Record<string, { pool?: number; delay?: number; rate?: number; crit?: number; status?: number }> = {
  'Clapkra Brace': { pool: 40 },
  'Juttni Brace': { delay: -1 },
  'Lohrin Brace': { crit: 0.12, status: 0.12 },
  'Anspatha Brace': { pool: 20, rate: 15 },
  'Suo Brace': { pool: 100, delay: 2 },
  'Plaga Brace': { pool: -20, delay: -1.5 },
  'Certus Brace': { crit: 0.2 },
};

/** Primary kitgun classes (wiki Module:Modular/generator); every secondary kitgun is a Pistol. */
const PRIMARY_KITGUN_TYPE: Record<string, string> = { Catchmoon: 'Shotgun', Sporelacer: 'Shotgun', Tombfinger: 'Launcher' };

const DAMAGE_KEYS: DamageType[] = ['impact', 'puncture', 'slash', 'heat', 'cold', 'electricity', 'toxin', 'blast', 'corrosive', 'gas', 'magnetic', 'radiation', 'viral', 'true', 'void', 'tau'];

function stats(damage: Record<string, number>, rest: Omit<WeaponStats, DamageType>): WeaponStats {
  const out = Object.fromEntries(DAMAGE_KEYS.map((key) => [key, 0])) as unknown as WeaponStats;
  for (const [type, value] of Object.entries(damage)) {
    const key = type.toLowerCase() as DamageType;
    if (key in out) out[key] += Number(value) || 0;
  }
  return Object.assign(out, rest);
}

const sum = (damage: Record<string, number>): number => Object.values(damage).reduce((total, value) => total + value, 0);

function weapon(name: string, kind: ModularKind, parts: string[], fields: Pick<WeaponData, 'category' | 'type' | 'modClasses' | 'stats' | 'modes'> & Partial<WeaponData>): WeaponData {
  return {
    id: name,
    name,
    masteryRank: 0,
    // Every modular part carries the flat 1.2 disposition on the wiki (Module:Weapons/data/modular).
    disposition: 4,
    dispositionMultiplier: 1.2,
    polarities: [],
    exilusPolarity: null,
    hasRivenSlot: kind !== 'amp',
    stancePolarity: null,
    image: null,
    modular: { kind, parts },
    ...fields,
  };
}

export function assembleZaw(source: ModularSource, strikeName: string, gripName: string, linkName: string): WeaponData {
  const strike = source.Zaw.Strike[strikeName];
  const grip = source.Zaw.Grip[gripName];
  const link = source.Zaw.Link[linkName];
  const base = sum(strike.Damage);
  const total = (base + grip.Damage + link.Damage) * strike.Multi[grip.Type].Base;
  const plague = /^Plague /.test(strikeName);
  const split = (amount: number): Record<string, number> => Object.fromEntries(Object.entries<number>(strike.Damage).map(([type, value]) => [
    type,
    plague ? value + (amount - base) / 4 : (value * amount) / base,
  ]));
  const rest = {
    critChance: strike.CritChance + (link.CritChance ?? 0),
    critMultiplier: strike.CritMultiplier + (link.CritMultiplier ?? 0),
    statusChance: strike.StatusChance + (link.StatusChance ?? 0),
    fireRate: Math.round((strike.Speed + grip.Speed + link.Speed) * 1000) / 1000,
    multishot: 1,
    magazineSize: 0,
    reloadTime: 0,
  };
  const own = stats(split(total), rest);
  const slide = stats(split(total * strike.Multi[grip.Type].Slide), rest);
  const name = `${strikeName} / ${gripName} / ${linkName}`;
  return weapon(name, 'zaw', [strikeName, gripName, linkName], {
    category: 'melee',
    type: 'Melee',
    modClasses: ['Melee'],
    trigger: '',
    description: `Zaw: ${strike.Type[grip.Type]} (${grip.Type === 'TwoHanded' ? 'two' : 'one'}-handed).`,
    stats: own,
    modes: [
      { name: 'Normal Attack', stats: own, trigger: null },
      { name: 'Slide Attack', stats: slide, trigger: null },
    ],
  });
}

export function assembleKitgun(source: ModularSource, slot: 'primary' | 'secondary', chamberName: string, gripName: string, loaderName: string): WeaponData {
  const table = slot === 'primary' ? source.KitgunPrimary : source.KitgunSecondary;
  const chamber = table.Chamber[chamberName];
  const loader = table.Loader[loaderName];
  const own = stats(chamber.Damage[gripName] ?? chamber.Damage.Base, {
    critChance: chamber.CritChance + loader.CritChance,
    critMultiplier: chamber.CritMultiplier + loader.CritMultiplier,
    statusChance: chamber.StatusChance + loader.StatusChance,
    fireRate: chamber.FireRate[gripName] ?? 1,
    multishot: chamber.Multishot ?? 1,
    magazineSize: chamber.Magazine[loader.Magazine] ?? 1,
    reloadTime: loader.Reload,
  });
  const falloff = chamber.Falloff ? { start: chamber.Falloff.StartRange, end: chamber.Falloff.EndRange, reduction: chamber.Falloff.Reduction } : undefined;
  const type = slot === 'secondary' ? 'Pistol' : PRIMARY_KITGUN_TYPE[chamberName] ?? 'Rifle';
  const name = `${chamberName} / ${gripName} / ${loaderName}`;
  return weapon(name, `kitgun-${slot}`, [chamberName, gripName, loaderName], {
    category: slot,
    type,
    modClasses: [type === 'Shotgun' ? 'Shotgun' : type === 'Pistol' ? 'Pistol' : 'Rifle'],
    exilusPolarity: 'madurai',
    trigger: chamber.Trigger,
    description: `${slot === 'primary' ? 'Primary' : 'Secondary'} kitgun.`,
    stats: own,
    modes: [{ name: 'Normal Attack', stats: own, trigger: chamber.ShotType ?? null, ...(falloff ? { falloff } : {}) }],
  });
}

/**
 * One amp attack as a fire mode: the attack and its explosion (the arsenal counts both, as for
 * every other weapon), energy as magazine. Fragments and other child hits are left out.
 */
function ampMode(name: string, entry: WikiTable, brace: typeof AMP_BRACES[string]): WeaponMode {
  const attacks: WikiTable[] = entry.Attacks ?? [];
  const [first] = attacks;
  const radial = attacks.filter((attack) => attack !== first && attack.ShotType === 'AoE');
  const damage: Record<string, number> = { ...first.Damage };
  for (const attack of radial) for (const [type, value] of Object.entries<number>(attack.Damage)) damage[type] = (damage[type] ?? 0) + value;
  const pool = (entry.Magazine ?? 100) + (brace.pool ?? 0);
  const rate = (entry.ReloadRate ?? 0) + (brace.rate ?? 0);
  const cost = first.AmmoCost ?? radial[0]?.AmmoCost ?? 1;
  const delay = Math.max(0, (entry.ReloadDelay ?? 0) + (brace.delay ?? 0));
  const own = stats(damage, {
    critChance: first.CritChance + (brace.crit ?? 0),
    critMultiplier: first.CritMultiplier,
    statusChance: first.StatusChance + (brace.status ?? 0),
    fireRate: first.FireRate,
    multishot: first.Multishot ?? 1,
    magazineSize: pool / cost,
    reloadTime: rate > 0 ? delay + pool / rate : entry.Reload ?? 0,
    ...(rate > 0 ? { reloadDelay: delay, energyPool: pool } : {}),
  });
  const aoe = radial.reduce((total, attack) => total + sum(attack.Damage), 0);
  return { name, stats: own, trigger: first.ShotType ?? null, ...(aoe > 0 ? { aoeDamage: aoe } : {}) };
}

export function assembleAmp(source: ModularSource, prismName: string, scaffoldName?: string, braceName?: string): WeaponData {
  const prism = source.Amp[prismName];
  const brace = braceName ? AMP_BRACES[braceName] : {};
  const main = ampMode(prism.Attacks[0].AttackName ?? 'Normal Attack', prism, brace);
  const modes = [main];
  if (scaffoldName) modes.push(ampMode(scaffoldName, source.Amp[scaffoldName], brace));
  const parts = [prismName, scaffoldName, braceName].filter((part): part is string => Boolean(part));
  return weapon(parts.join(' / '), 'amp', parts, {
    category: 'amp',
    type: 'Amp',
    modClasses: [],
    trigger: prism.Trigger,
    description: scaffoldName ? 'Operator amp. Second fire mode: the scaffold.' : 'Operator amp.',
    stats: main.stats,
    modes,
  });
}

/** Part names per modular kind, in the order a weapon name lists them. */
export function modularParts(source: ModularSource): Record<ModularKind, string[][]> {
  const names = (table: Record<string, unknown>): string[] => Object.keys(table).sort();
  const amps = names(source.Amp);
  return {
    zaw: [names(source.Zaw.Strike), names(source.Zaw.Grip), names(source.Zaw.Link)],
    'kitgun-primary': [names(source.KitgunPrimary.Chamber), names(source.KitgunPrimary.Grip), names(source.KitgunPrimary.Loader)],
    'kitgun-secondary': [names(source.KitgunSecondary.Chamber), names(source.KitgunSecondary.Grip), names(source.KitgunSecondary.Loader)],
    amp: [amps.filter((name) => / Prism$/.test(name)), amps.filter((name) => / Scaffold$/.test(name)), Object.keys(AMP_BRACES)],
  };
}

export function assemble(source: ModularSource, kind: ModularKind, [first, second, third]: string[]): WeaponData {
  if (kind === 'zaw') return assembleZaw(source, first, second, third);
  if (kind === 'amp') return assembleAmp(source, first, second, third);
  return assembleKitgun(source, kind === 'kitgun-primary' ? 'primary' : 'secondary', first, second, third);
}

/** Every part combination of a kind (the cartesian product of its part lists). */
export function combinations(lists: string[][]): string[][] {
  return lists.reduce<string[][]>((acc, list) => acc.flatMap((prefix) => list.map((part) => [...prefix, part])), [[]]);
}

/**
 * Adds every modular combination to `snapshot.weapons` (about 3,300), plus the amps that are not
 * modular (Mote Amp, Sirocco). Their guaranteed procs go into `snapshot.forcedProcs`. Each weapon
 * is assembled on first access (building all of them up front cost every process and worker
 * ~100 ms at load) and is not enumerable: weapon lists, tools and fuzzy name lookup skip the
 * combinations, `snapshot.weapons[name]` finds them. `modularParts` lists the parts instead.
 */
export function addModularWeapons(snapshot: Snapshot): void {
  const source = snapshot.modular;
  if (!source) return;
  const parts = modularParts(source);
  for (const kind of Object.keys(parts) as ModularKind[]) {
    for (const combination of combinations(parts[kind])) {
      const name = combination.join(' / ');
      Object.defineProperty(snapshot.weapons, name, {
        configurable: true,
        get: () => {
          const value = assemble(source, kind, combination);
          Object.defineProperty(snapshot.weapons, name, { value, configurable: true, writable: true });
          return value;
        },
      });
      const chamber = kind.startsWith('kitgun') ? source[kind === 'kitgun-primary' ? 'KitgunPrimary' : 'KitgunSecondary'].Chamber[combination[0]] : null;
      if (chamber?.ForcedProcs?.length) {
        const procs = chamber.ForcedProcs.map((type: string) => type.toLowerCase() as DamageType);
        (snapshot.forcedProcs ??= {})[name] = { '': procs, 'Normal Attack': procs };
      }
    }
  }
  for (const name of Object.keys(source.Amp)) {
    if (/ (?:Prism|Scaffold)$/.test(name) || snapshot.weapons[name]) continue;
    snapshot.weapons[name] = { ...assembleAmp(source, name), modular: undefined };
  }
}
