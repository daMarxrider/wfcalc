/**
 * Builds data/snapshot.json from data/raw/.
 *
 * Master data sources, in order of authority:
 *  - WARFRAME Wiki Lua modules: mod list + descriptions + upgrade axes,
 *    damage-type modifier matrix, warframe stats.
 *  - WFCD/warframe-items JSON (game export): per-rank mod stats, weapon stat
 *    blocks, enemy health pools, arcanes.
 *
 * The wiki is the master for anything that has an `InternalName`, because WFCD
 * contains duplicate entries (flawed/spectre variants share a name) and a few
 * misnamed rows. WFCD supplies the numbers the game actually uses.
 *
 * Run: node tools/build-data.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLuaModule } from './parse-lua.ts';
import { parseModEffects } from '../src/mods/parse.ts';
import {
  DAMAGE_TYPES,
  type AbilityData,
  type ArcaneData,
  type DamageAbilityData,
  type DamageType,
  type Effect,
  type EnemyData,
  type HealthPool,
  type ModData,
  type Snapshot,
  type WarframeData,
  type WeaponData,
  type WeaponMode,
  type WeaponStats,
} from '../src/types.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const RAW = join(ROOT, 'data/raw');
const OUT = join(ROOT, 'data/snapshot.json');

type Loose = Record<string, any>;

const readJson = (file: string): any[] => JSON.parse(readFileSync(join(RAW, file), 'utf8'));
const readJsonFile = (file: string): any => JSON.parse(readFileSync(join(RAW, file), 'utf8'));
const readLua = (file: string): any => parseLuaModule(readFileSync(join(RAW, file), 'utf8'));

/** Lua tables produce `{ "1": x, "2": y }`; turn that into a real array. */
function luaArray(value: Loose | undefined): any[] {
  if (!value || typeof value !== 'object') return [];
  return Object.keys(value)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => value[k]);
}

// ---------------------------------------------------------------- modifiers

function buildDamageTypes(): { modifiers: Record<string, Record<string, number>>; healthTypes: Record<string, HealthPool['category']> } {
  const module = readLua('module-damagetypes.lua');
  const modifiers: Record<string, Record<string, number>> = {};
  const healthTypes: Record<string, HealthPool['category']> = {};

  // Pool categories only. The stat block still calls pools "Cloned Flesh" or "Alloy Armor",
  // so they need a category (health/armour/shield) for the shield phase and the armour DR.
  for (const [name, entry] of Object.entries<Loose>(module.Health ?? {})) {
    const category = String(entry.Type ?? 'Health').toLowerCase() as HealthPool['category'];
    healthTypes[name] = category === 'armor' ? 'armor' : category === 'shield' ? 'shield' : category === 'object' ? 'object' : 'health';
  }

  // Damage 3.0 (Update 36, 2024-06-18): "With the removal of Resistances/Vulnerabilities being
  // tied to Health Type, they will now be Faction-specific" (wiki: Damage). The matrix the
  // wiki still keeps under Health[...].Positives is the Damage 2.0 one, marked "Depreciated
  // health/armor types as of U36; keeping to preserve links and template calls". Use it and
  // every element recommendation is two years stale.
  //
  // `Types[damage].Positives/Negatives` lists health classes without a magnitude, which the
  // module's own patch code (the commented-out block at the end) reads as ±50%.
  for (const [name, entry] of Object.entries<Loose>(module.Types ?? {})) {
    const key = name.toLowerCase();
    for (const [field, sign] of [['Positives', 1], ['Negatives', -1]] as const) {
      for (const item of luaArray(entry[field])) {
        const pair = luaArray(item);
        const healthClass = String(typeof item === 'object' ? pair[0] : item).trim();
        const pct = typeof item === 'object' ? Number(pair[1] ?? 50) : 50;
        if (!healthClass || !Number.isFinite(pct)) continue;
        (modifiers[key] ??= {})[healthClass] = sign * pct;
      }
    }
  }
  // Modifiers not mentioned are 0; keep the table sparse and default to 0 at runtime.
  return { modifiers, healthTypes };
}

// --------------------------------------------------------------------- mods

/** WFCD mod rows indexed by their internal name, which is what the wiki stores too. */
function indexWfcdMods(): Map<string, Loose> {
  const index = new Map<string, Loose>();
  for (const mod of readJson('wfcd-Mods.json')) {
    if (typeof mod.uniqueName === 'string') index.set(mod.uniqueName, mod);
  }
  return index;
}

/**
 * The headline stat of one rank, e.g. "+165% Damage". Strips the colour tags the game data
 * embeds ("+165% <DT_FREEZE_COLOR>Cold") and picks the first line that carries a number: for
 * conditional mods the first line is a label ("On Weak Point Hit:") and the value comes after.
 */
function cleanRankLines(lines: string[]): string {
  const split = lines
    .flatMap((line) => line.split(/\n|\\n/))
    .map((line) => line.replace(/<[^>]*>/g, '').trim())
    .filter(Boolean);
  return split.find((line) => /[+-]?\d/.test(line)) ?? split[0] ?? '';
}

/**
 * Names from the wiki's "Exilus Weapon Mods" category. WFCD has no Exilus flag, so this is the
 * only thing that tells a mod like Aerial Ace apart from any other rifle mod.
 */
function exilusModNames(): Set<string> {
  try {
    const list = readJson('wiki-exilus-mods.json');
    return new Set(Array.isArray(list) ? list.map((name) => String(name)) : []);
  } catch {
    return new Set();
  }
}

function buildMods(unmatchedReport: string[]): Record<string, ModData> {
  const module = readLua('module-mods.lua');
  const setOf = new Map<string, string>();
  const wfcd = indexWfcdMods();
  const out: Record<string, ModData> = {};

  // Set membership comes from each mod's own `Set` field; module.Sets holds the set cards.
  for (const [modName, entry] of Object.entries<Loose>(module.Mods ?? {})) {
    if (typeof entry.Set === 'string' && entry.Set) setOf.set(modName, entry.Set);
  }

  let partialCount = 0;
  const exilusNames = exilusModNames();
  for (const [name, entry] of Object.entries<Loose>(module.Mods ?? {})) {
    const internal = typeof entry.InternalName === 'string' ? entry.InternalName : '';
    const source = internal ? wfcd.get(internal) : undefined;

    // Per-rank stat strings: WFCD if we have them, else the wiki's max-rank description.
    const ranks: string[][] = Array.isArray(source?.levelStats) && source!.levelStats.length
      ? source!.levelStats.map((l: Loose) => (Array.isArray(l.stats) ? l.stats : []))
      : [[String(entry.Description ?? '')].filter(Boolean)];

    const parsed = parseModEffects(ranks);
    // Cannonade mods carry a rule that no stat line expresses: "Fire Rate cannot be modified".
    const description = String(entry.Description ?? '');
    if (/fire rate cannot be modified/i.test(description)) {
      parsed.effects.push({ target: 'fireRateLock', op: 'add', value: 1, raw: 'Fire Rate cannot be modified' });
    }
    if (/only compatible with semi-auto trigger/i.test(description)) {
      parsed.effects.push({ target: 'requiresSemiTrigger', op: 'add', value: 1, raw: 'Semi-Auto triggers only' });
    }
    const partial = parsed.unmatched.length > 0;
    if (partial) {
      partialCount++;
      for (const line of parsed.unmatched) unmatchedReport.push(`${name}\t${line}`);
    }

    const classes = [entry.Type, entry.Class].filter((c): c is string => typeof c === 'string');
    const mod: ModData = {
      id: name,
      name,
      category: typeof entry.Class === 'string' && ['Galvanized', 'Riven', 'Primed', 'Umbra'].includes(entry.Class) ? entry.Class : String(entry.Type ?? ''),
      classes,
      polarity: typeof entry.Polarity === 'string' ? entry.Polarity.toLowerCase() : null,
      rarity: typeof entry.Rarity === 'string' ? entry.Rarity : null,
      baseDrain: Number(entry.BaseDrain ?? 0),
      maxRank: Number(entry.MaxRank ?? 0),
      description: String(entry.Description ?? '').replace(/\r\n?/g, '\n').trim(),
      levels: ranks.map((rank) => cleanRankLines(rank.length ? rank : [String(entry.Description ?? '')])),
      effects: parsed.effects,
      cardImage: typeof entry.Image === 'string' ? entry.Image : null,
      image: typeof source?.imageName === 'string' ? source.imageName : null,
      partial,
      outOfScopeLines: parsed.outOfScope,
      incompatible: luaArray(entry.Incompatible).filter((x): x is string => typeof x === 'string'),
      set: setOf.get(name) ?? null,
      upgradeTypes: luaArray(entry.UpgradeTypes).filter((x): x is string => typeof x === 'string'),
      isAugment: Boolean(source?.isAugment) || /Augment/i.test(String(entry.Class ?? '')),
      isRiven: /Riven/i.test(name) || /Riven/i.test(String(source?.type ?? '')),
      isExilus: exilusNames.has(name),
      conclave: Boolean(entry.Conclave),
    };
    out[name] = mod;
  }

  console.log(`mods: ${Object.keys(out).length} (${partialCount} partial, ${((100 * partialCount) / Object.keys(out).length).toFixed(0)}%)`);
  return out;
}

// ------------------------------------------------------------------ weapons

const CATEGORY_FILES: Array<[file: string, category: string]> = [
  ['wfcd-Primary.json', 'primary'],
  ['wfcd-Secondary.json', 'secondary'],
  ['wfcd-Melee.json', 'melee'],
  ['wfcd-Arch-Gun.json', 'archgun'],
  ['wfcd-Arch-Melee.json', 'archmelee'],
  ['wfcd-SentinelWeapons.json', 'sentinel'],
];

/**
 * Which mod-compatibility classes a weapon accepts. The game has families
 * (Rifle covers rifles, launchers, sniper rifles and bows) and specialisations
 * (a Sniper mod only fits sniper rifles).
 */
function modClassesFor(category: string, type: string): string[] {
  switch (category) {
    case 'primary':
      if (type === 'Shotgun') return ['Shotgun'];
      if (type === 'Bow') return ['Rifle', 'Bow'];
      if (type === 'Sniper') return ['Rifle', 'Sniper'];
      return ['Rifle'];
    case 'secondary':
      return ['Pistol'];
    case 'melee':
      return ['Melee'];
    case 'archgun':
      return ['Archgun'];
    case 'archmelee':
      return ['Archmelee'];
    case 'sentinel':
      return ['Companion', 'Robotic', 'Sentinel'];
    default:
      return [];
  }
}

function emptyStats(): WeaponStats {
  const stats = {} as WeaponStats;
  for (const t of DAMAGE_TYPES) stats[t] = 0;
  stats.critChance = 0;
  stats.critMultiplier = 1;
  stats.statusChance = 0;
  stats.fireRate = 1;
  stats.multishot = 1;
  stats.magazineSize = 0;
  stats.reloadTime = 0;
  return stats;
}

/** Reads a WFCD `damage` dictionary (arsenal damage per type). */
/** True when a damage dictionary carries no damage type at all. */
function isEmptyDamage(damage: Loose | undefined): boolean {
  if (!damage || typeof damage !== 'object') return true;
  return !Object.entries(damage).some(([key, value]) => key !== 'total' && typeof value === 'number' && value > 0);
}

function statsFromDamage(damage: Loose | undefined, base: WeaponStats, damagePerShot?: number[]): WeaponStats {
  const stats: WeaponStats = { ...base };
  for (const t of DAMAGE_TYPES) stats[t] = 0;
  if (damage) {
    for (const [key, value] of Object.entries(damage)) {
      // WFCD writes lower-case keys, the wiki's weapon database writes "Toxin"; both are the
      // same axis.
      const axis = key.toLowerCase();
      if (axis === 'total' || typeof value !== 'number') continue;
      if (axis in stats) stats[axis as DamageType] = value;
    }
  }
  // `damagePerShot` is the same data as a fixed-order array; use it only as a fallback.
  if (!damage && Array.isArray(damagePerShot)) {
    damagePerShot.slice(0, 12).forEach((value, i) => {
      const key = DAMAGE_TYPES[i];
      if (key && typeof value === 'number') stats[key] = value;
    });
  }
  return stats;
}

/** Builds the arsenal stat block for a weapon. */
function baseStats(weapon: Loose): WeaponStats {
  const stats = statsFromDamage(weapon.damage, emptyStats(), weapon.damagePerShot);
  stats.critChance = Number(weapon.criticalChance ?? 0);
  stats.critMultiplier = Number(weapon.criticalMultiplier ?? 1);
  stats.statusChance = Number(weapon.procChance ?? 0);
  // Charge weapons ship fireRate 0; the real rate is one shot per charge time.
  let fireRate = Number(weapon.fireRate ?? 0);
  if (!(fireRate > 0)) {
    const chargeTimes = (Array.isArray(weapon.attacks) ? weapon.attacks : [])
      .map((attack: Loose) => Number(attack.charge_time ?? 0))
      .filter((time: number) => time > 0);
    fireRate = chargeTimes.length ? 1 / Math.max(...chargeTimes) : 1;
  }
  stats.fireRate = fireRate;
  stats.multishot = Number(weapon.multishot ?? 1);
  stats.magazineSize = Number(weapon.magazineSize ?? 0);
  stats.reloadTime = Number(weapon.reloadTime ?? 0);
  return stats;
}

/**
 * Alternative fire modes from WFCD `attacks`. That array mixes two very different
 * things: parts of a single trigger pull (Kuva Bramma: impact direct + blast radial)
 * and genuinely different modes (Soma Prime: normal + Incarnon). We keep them as
 * separate, selectable modes and never add them up, because the arsenal total
 * already includes the parts of the main shot.
 */
function buildModes(weapon: Loose, base: WeaponStats): WeaponMode[] {
  const attacks: Loose[] = Array.isArray(weapon.attacks) ? weapon.attacks : [];
  const modes: WeaponMode[] = [];
  for (const attack of attacks) {
    // Some weapons (Haalvu) ship an empty damage dict per attack: the mode then shares the
    // weapon's damage distribution and only overrides crit/status/rate.
    const stats = isEmptyDamage(attack.damage) ? { ...base } : statsFromDamage(attack.damage, base);
    stats.critChance = Number(attack.crit_chance ?? 0) / 100;
    stats.critMultiplier = Number(attack.crit_mult ?? 1);
    stats.statusChance = Number(attack.status_chance ?? 0) / 100;
    stats.fireRate = Number(attack.speed ?? base.fireRate);
    const falloff = attack.falloff && typeof attack.falloff === 'object'
      ? {
          start: Number(attack.falloff.start ?? 0),
          end: Number(attack.falloff.end ?? 0),
          reduction: Number(attack.falloff.reduction ?? 0),
        }
      : undefined;
    modes.push({
      name: String(attack.name ?? 'Attack'),
      stats,
      trigger: typeof attack.shot_type === 'string' ? attack.shot_type : null,
      ...(falloff && falloff.end > 0 ? { falloff } : {}),
    });
  }
  return modes;
}

/**
 * The Incarnon form's own stats, read from the wiki's weapon database.
 *
 * WFCD does not export the transformed weapon at all, so without this the calculator applied
 * the evolution perks on top of the base weapon's numbers, which is not what the game does:
 * a Torid Incarnon fires a 51 Toxin beam with 29% crit at 8/s, not a 100 Toxin grenade at 1.5/s.
 * The wiki lists it as one more attack, named "Incarnon Form"; melee weapons have no such
 * attack and instead name theirs "Spectral Axe", "Spectral Dagger", "Spectral Blade", each
 * with an "... Explosion" child that this single-profile model does not add.
 */
interface RawIncarnonForm {
  damage: Loose;
  critChance: number;
  critMultiplier: number;
  statusChance: number;
  fireRate: number;
  multishot: number;
  magazineSize: number;
  extra: Array<{ name: string; damage: Partial<Record<DamageType, number>>; falloff?: { start: number; end: number; reduction: number } }>;
  directShare: number;
  /** True when the attack is one of the melee "Spectral" projectiles, not a gun form. */
  spectral: boolean;
}

/** Secondaries the wiki tags SECONDARYSHOTGUN (Detron, Bronco...): their pellets are one hit. */
function readShotgunSidearms(): Set<string> {
  const module = readLua('module-weapons-secondary.lua') as Loose;
  return new Set(Object.entries<Loose>(module.Weapons ?? module)
    .filter(([, entry]) => luaArray(entry?.CompatibilityTags).includes('SECONDARYSHOTGUN'))
    .map(([name]) => name));
}

function readIncarnonForms(): Record<string, RawIncarnonForm> {
  const out: Record<string, RawIncarnonForm> = {};
  const files = ['module-weapons-primary.lua', 'module-weapons-secondary.lua', 'module-weapons-melee.lua'];
  for (const file of files) {
    let root: Loose;
    try {
      const module = parseLuaModule(readFileSync(join(RAW, file), 'utf8')) as Loose;
      root = (module.Weapons ?? module) as Loose;
    } catch (error) {
      console.warn(`incarnon forms: cannot read ${file}: ${(error as Error).message}`);
      continue;
    }
    for (const [name, entry] of Object.entries<Loose>(root)) {
      // The wiki writes Attacks as a keyed table, not a list.
      const attacks: Loose[] = Array.isArray(entry?.Attacks)
        ? entry.Attacks
        : Object.values<Loose>(entry?.Attacks ?? {});
      const nameOf = (attack: Loose): string => String(attack?.AttackName ?? '');
      // The transformed shot is the direct hit; radial children ("... AoE", "... Explosion")
      // are separate attacks, not the form itself.
      const form = attacks.find((attack: Loose) => /incarnon form/i.test(nameOf(attack)) && !/aoe|radial|explosion/i.test(nameOf(attack)))
        ?? attacks.find((attack: Loose) => /spectral/i.test(nameOf(attack)) && !/explosion/i.test(nameOf(attack)));
      if (!form) continue;
      // The transformed shot is the direct hit; radial children ("... AoE", "... Explosion")
      // are separate attacks. Some weapon modules carry AttackParentIndex, others only the
      // shared name prefix (Braton's "Incarnon Form AoE" has no parent index).
      const extra = attacks
        .filter((attack: Loose) => attack !== form
          && /aoe|radial|explosion/i.test(nameOf(attack))
          && (String(attack?.AttackParentIndex) === String(form.AttackIndex)
            || nameOf(attack).startsWith(nameOf(form))))
        .map((attack: Loose) => ({
          name: nameOf(attack),
          damage: Object.fromEntries(
            Object.entries<number>(attack.Damage ?? {}).filter(([, value]) => typeof value === 'number' && value > 0),
          ) as Partial<Record<DamageType, number>>,
          ...(attack.Falloff && typeof attack.Falloff === 'object'
            ? {
                falloff: {
                  start: Number(attack.Falloff.StartRange ?? 0),
                  end: Number(attack.Falloff.EndRange ?? 0),
                  reduction: Number(attack.Falloff.Reduction ?? 0),
                },
              }
            : {}),
        }));
      const damageSum = (damage: Loose): number =>
        Object.values<number>(damage ?? {}).reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);
      const directTotal = damageSum(form.Damage ?? {});
      const extraTotal = extra.reduce((sum, attack) => sum + Object.values(attack.damage).reduce((n, value) => n + (value ?? 0), 0), 0);
      out[name] = {
        damage: (form.Damage ?? {}) as Loose,
        critChance: Number(form.CritChance ?? 0),
        critMultiplier: Number(form.CritMultiplier ?? 1),
        statusChance: Number(form.StatusChance ?? 0),
        fireRate: Number(form.FireRate ?? 0),
        multishot: Number(form.Multishot ?? 1),
        magazineSize: Number.isFinite(Number(form.AmmoCost)) ? Number(form.AmmoCost) : 0,
        extra,
        directShare: directTotal + extraTotal > 0 ? directTotal / (directTotal + extraTotal) : 1,
        spectral: /spectral/i.test(nameOf(form)),
      };
    }
  }
  console.log(`incarnon forms: ${Object.keys(out).length} weapon(s) with a transformed profile`);
  return out;
}

/** Numeric overrides for a transformed profile, from data/weapon-overrides.json. */
function applyFormOverrides(form: WeaponStats, overrides: unknown): WeaponStats {
  if (!overrides || typeof overrides !== 'object') return form;
  for (const [field, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (typeof value === 'number' && field in form) (form as any)[field] = value;
  }
  return form;
}

/** Turns a raw Incarnon form into full stats, on top of the weapon's own damage-type keys. */
function incarnonFormStats(raw: RawIncarnonForm, base: WeaponStats): WeaponStats {
  const stats = statsFromDamage(raw.damage, base);
  stats.critChance = raw.critChance;
  stats.critMultiplier = raw.critMultiplier;
  stats.statusChance = raw.statusChance;
  stats.fireRate = raw.fireRate || base.fireRate;
  stats.multishot = raw.multishot;
  if (raw.magazineSize) stats.magazineSize = raw.magazineSize;
  return stats;
}

function buildWeapons(): Record<string, WeaponData> {
  const out: Record<string, WeaponData> = {};
  const overrides = loadWeaponOverrides();
  // Built from a neutral base: the form replaces the weapon's damage and crit wholesale.
  // Raw form stats per weapon name; they are turned into full WeaponStats once the weapon's
  // own stats are known, because statsFromDamage only fills keys the base already has.
  const incarnonForms = readIncarnonForms();
  const shotgunSidearms = readShotgunSidearms();
  for (const [file, category] of CATEGORY_FILES) {
    for (const weapon of readJson(file)) {
      const name = String(weapon.name ?? '').trim();
      const type = String(weapon.type ?? '');
      if (!name) continue;
      // Zaw/Kitgun components are crafting parts, not weapons.
      if (/Component$/.test(type) || /Component$/.test(name) || /Blueprint$/.test(name)) continue;
      // Skip the hidden duplicate rows WFCD emits for amp scaffolds etc.
      if (out[name]) continue;

      const stats = baseStats(weapon);
      // Apply curated corrections (documented in data/weapon-overrides.json).
      const override = overrides[name];
      if (override) {
        for (const [field, value] of Object.entries(override)) {
          if (field === 'note' || field === 'modes') continue;
          if (typeof value === 'number' && field in stats) (stats as any)[field] = value;
        }
      }
      const modes = buildModes(weapon, stats);
      // Per-mode corrections: fire modes can differ in stats the top-level block does not
      // model (the Phantasma's beam has multishot 6 while its alt-fire fires 1 projectile).
      const modeOverrides = (override?.modes ?? {}) as Record<string, Record<string, number>>;
      for (const mode of modes) {
        const patch = modeOverrides[mode.name];
        if (!patch) continue;
        for (const [field, value] of Object.entries(patch)) {
          if (field in mode.stats) (mode.stats as any)[field] = value;
        }
      }
      out[name] = {
        id: name,
        name,
        category,
        type,
        masteryRank: Number(weapon.masteryReq ?? 0),
        disposition: Number(weapon.disposition ?? 1),
        // omegaAttenuation is the exact disposition multiplier the game uses for rivens.
        dispositionMultiplier: Number(weapon.omegaAttenuation ?? 1),
        polarities: Array.isArray(weapon.polarities) ? weapon.polarities.map((p: unknown) => String(p).toLowerCase()) : [],
        exilusPolarity: typeof weapon.exilusPolarity === 'string' ? weapon.exilusPolarity.toLowerCase() : null,
        modClasses: modClassesFor(category, type),
        trigger: String(weapon.trigger ?? ''),
        image: typeof weapon.imageName === 'string' ? weapon.imageName : null,
        stancePolarity: typeof weapon.stancePolarity === 'string' ? weapon.stancePolarity : null,
        description: String(weapon.description ?? '').replace(/\r\n?/g, ' ').replace(/\s+/g, ' ').trim(),
        stats,
        modes,
        hasRivenSlot: category !== 'sentinel',
        ...(shotgunSidearms.has(name) ? { shotgunSidearm: true } : {}),
        ...(incarnonForms[name]
          ? {
              // Curated form corrections (the Ceramic Dagger fires two spectral daggers, and the
              // melee attack table has no multishot to say so). See data/weapon-overrides.json.
              incarnonForm: applyFormOverrides(
                incarnonFormStats(incarnonForms[name], stats),
                override?.incarnonForm,
              ),
              ...(incarnonForms[name].extra.length ? { incarnonFormExtra: incarnonForms[name].extra } : {}),
              ...(incarnonForms[name].extra.length ? { incarnonFormDirectShare: incarnonForms[name].directShare } : {}),
              ...(incarnonForms[name].spectral ? { incarnonFormSpectral: true } : {}),
              ...(INCARNON_CHAIN[name] ? { incarnonFormChain: INCARNON_CHAIN[name] } : {}),
            }
          : {}),
      };
    }
  }
  console.log(`weapons: ${Object.keys(out).length}`);
  return out;
}

// ---------------------------------------------------------------- overrides

/**
 * Corrections for weapons whose export data is wrong or missing, verified against
 * Overframe's oracle. See data/weapon-overrides.json for the evidence per entry.
 */
function loadWeaponOverrides(): Record<string, { note?: string; [key: string]: unknown }> {
  const file = join(RAW, '..', 'weapon-overrides.json');
  let raw: Record<string, any>;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  delete raw._comment;
  return raw;
}

// ------------------------------------------------------------------ enemies

const FACTION_NAMES: Record<string, string> = {
  corpus: 'corpus',
  grineer: 'grineer',
  infestation: 'infested',
  infested: 'infested',
  orokin: 'orokin',
  corrupted: 'orokin',
  sentient: 'sentient',
  stalker: 'stalker',
  neutral: 'neutral',
  tenno: 'tenno',
  predator: 'infested',
  prey: 'infested',
  warframe: 'tenno',
  orbiter: 'neutral',
};

/**
 * Damage 3.0 health class for each enemy faction.
 *
 * The simplified faction resistances made the class a property of the faction, not of the
 * pool: every pool of a Grineer takes the Grineer table, armour included. `Object` is the
 * wiki's catch-all for things with no table (conservation animals, destructibles).
 */
const HEALTH_CLASS: Record<string, string> = {
  grineer: 'Grineer',
  corpus: 'Corpus',
  infested: 'Infested',
  orokin: 'Orokin',
  sentient: 'Sentient',
  stalker: 'Tenno',
  tenno: 'Tenno',
  neutral: 'Object',
};

/**
 * Faction from the asset path, for rows whose `type` is not a faction.
 *
 * WFCD puts the weapon class in `type` for a handful of enemies ("Rifle", "Shotgun"), which
 * left Lancer, Trooper, Crewman and Corrupted Lancer with no faction and made them fall back
 * to the neutral health curve: a level 80 Lancer read 9,635 hp instead of 24,791.
 */
function factionFromPath(uniqueName: string): string | null {
  const segment = /\/Enemies\/([^/]+)\//.exec(uniqueName)?.[1] ?? '';
  if (/^Grineer/.test(segment)) return 'grineer';
  if (/^Corpus/.test(segment)) return 'corpus';
  if (/^Orokin/.test(segment)) return 'orokin';
  if (/^Infested/.test(segment)) return 'infested';
  if (/^Sentients/.test(segment)) return 'sentient';
  if (/^(Acolytes|Stalker)$/.test(segment)) return 'stalker';
  return null;
}

/** The Damage 3.0 class, including the sub-factions the wiki splits off by name. */
function healthClassFor(name: string, faction: string | null): string {
  if (faction === 'grineer' && /^Kuva /.test(name)) return 'Kuva Grineer';
  if (faction === 'corpus' && /^Amalgam /.test(name)) return 'Corpus Amalgam';
  return HEALTH_CLASS[faction ?? ''] ?? 'Object';
}

function buildEnemies(healthTypes: Record<string, HealthPool['category']>): Record<string, EnemyData> {
  const out: Record<string, EnemyData> = {};
  for (const enemy of readJson('wfcd-Enemy.json')) {
    const name = String(enemy.name ?? '').trim();
    if (!name || out[name]) continue;

    const pools: HealthPool[] = [];
    for (const entry of enemy.resistances ?? []) {
      const type = String(entry.type ?? '');
      if (!type || type === 'None') continue;
      const amount = Number(entry.amount ?? 0);
      if (!(amount > 0)) continue;
      pools.push({ type, category: healthTypes[type] ?? 'health', amount });
    }

    const faction = FACTION_NAMES[String(enemy.type ?? '').toLowerCase()]
      ?? factionFromPath(String(enemy.uniqueName ?? ''));

    out[name] = {
      id: name,
      name,
      faction,
      healthClass: healthClassFor(name, faction),
      kind: String(enemy.type ?? '') || null,
      baseLevel: 1,
      health: Number(enemy.health ?? 0),
      shield: Number(enemy.shield ?? 0),
      armor: Number(enemy.armor ?? 0),
      pools,
      // Treasurer and Hounds are documented exceptions to Toxin's shield bypass.
      toxinBypassesShields: !/^(Treasurer|Hound)$/i.test(name),
    };
  }
  console.log(`enemies: ${Object.keys(out).length}`);
  return out;
}

// ------------------------------------------------------- arcanes, warframes

/** Which equipment slot an arcane fits, from its wiki category. */
function arcaneSlot(category: string): string | null {
  const map: Record<string, string> = {
    'Primary Arcane': 'primary',
    'Secondary Arcane': 'secondary',
    'Melee Arcane': 'melee',
    'Bow Arcane': 'bow',
    'Shotgun Arcane': 'shotgun',
    'Kitgun Arcane': 'kitgun',
    'Zaw Arcane': 'zaw',
    'Warframe Arcane': 'warframe',
    'Amp Arcane': 'amp',
    'Operator Arcane': 'operator',
  };
  return map[category] ?? null;
}

/** Arcanes that add critical chance as a flat amount instead of scaling the base stat. */
const FLAT_CRIT_ARCANES = new Set(['Arcane Avenger']);

function buildArcanes(): Record<string, ArcaneData> {
  const out: Record<string, ArcaneData> = {};
  for (const arcane of readJson('wfcd-Arcanes.json')) {
    const name = String(arcane.name ?? '').trim();
    if (!name || out[name]) continue;
    const ranks: string[][] = Array.isArray(arcane.levelStats)
      ? arcane.levelStats.map((l: Loose) => (Array.isArray(l.stats) ? l.stats : []))
      : [];
    const parsed = ranks.length ? parseModEffects(ranks) : { effects: [] as Effect[], unmatched: [] };
    out[name] = {
      id: name,
      name,
      category: String(arcane.type ?? ''),
      rarity: typeof arcane.rarity === 'string' ? arcane.rarity : null,
      // WFCD ships one levelStats entry per rank, so max rank is length - 1.
      maxRank: Math.max(0, ranks.length - 1),
      description: ranks.length ? String(ranks[ranks.length - 1].join(' / ')) : '',
      levels: ranks.map((lines) => lines.join(' / ')),
      effects: FLAT_CRIT_ARCANES.has(name)
        ? parsed.effects.map((effect) => (effect.target === 'critChance' ? { ...effect, op: 'flat' as const } : effect))
        : parsed.effects,
      slot: arcaneSlot(String(arcane.type ?? '')),
    };
  }
  console.log(`arcanes: ${Object.keys(out).length}`);
  return out;
}

function buildWarframes(): Record<string, WarframeData> {
  const out: Record<string, WarframeData> = {};
  for (const frame of readJson('wfcd-Warframes.json')) {
    const name = String(frame.name ?? '').trim();
    if (!name || out[name]) continue;
    out[name] = {
      id: name,
      name,
      health: Number(frame.health ?? 0),
      shield: Number(frame.shield ?? 0),
      armor: Number(frame.armor ?? 0),
      energy: Number(frame.power ?? 0),
      sprintSpeed: Number(frame.sprintSpeed ?? 0),
      abilities: Array.isArray(frame.abilities) ? frame.abilities.map((a: Loose) => String(a.name ?? '')) : [],
    };
  }
  console.log(`warframes: ${Object.keys(out).length}`);
  return out;
}

// -------------------------------------------------------------------- rivens

/** Weapon classes the riven base-value table is split into. */
const RIVEN_CLASSES = ['rifle', 'shotgun', 'pistol', 'archgun', 'melee'];

/**
 * Reads the "Base Values" wikitable from the Riven Mods page:
 *   | Effect        | Prefix || Suffix || Rifle || Shotgun || Pistol || Archgun || Melee
 * Each cell is a percentage ("149.99%"), a multiplier ("x0.45") or a flat value ("8.1s").
 */
function buildRivenStats(): Record<string, Record<string, number>> {
  const wikitext = readFileSync(join(RAW, 'wiki-riven-mods.wiki'), 'utf8');
  const section = wikitext.split('=== Base Values ===')[1]?.split('\n|}')[0] ?? '';
  const rows = section.split(/\n\|-\n/).slice(1);
  const out: Record<string, Record<string, number>[]> = {};

  for (const row of rows) {
    const lines = row.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length || !lines[0].startsWith('|') || lines[0].startsWith('|-')) continue;
    const label = lines[0]
      .replace(/^\|\s*/, '')
      // {{D|Heat}} and {{Faction|Grineer}} carry the meaning: expand them before dropping templates.
      .replace(/\{\{D\|([^}|]*)[^}]*\}\}/g, '$1')
      .replace(/\{\{Faction\|([^}|]*)[^}]*\}\}/g, '$1')
      .replace(/<sup>.*?<\/sup>/g, '')
      .replace(/<br\s*\/?>/g, ' / ')
      .replace(/\{\{[^}]*\}\}/g, ' ')
      .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
      .replace(/\s+/g, ' ')
      .trim()
      // "Critical Chance / Critical Chance (x2 for Heavy Attacks)" -> keep the first name.
      .split(' / ')[0]
      .replace(/\s*\(.*?\)\s*$/, '')
      .trim();
    const cells = lines.slice(1).join(' ').split('||').map((cell) => cell.trim());
    // Effect label, prefix, suffix, then one value per weapon class.
    const values = cells.slice(2, 2 + RIVEN_CLASSES.length);
    if (!label || values.length < RIVEN_CLASSES.length) continue;
    if (out[label]) continue;
    out[label] = [];
    values.forEach((cell) => {
      const kind = /^x/i.test(cell) ? 'multiplier' : /s$/i.test(cell) ? 'flat' : 'percent';
      const number = Number(cell.replace(/[^\d.]/g, ''));
      out[label].push(Number.isFinite(number) ? { [kind]: number } as any : ({} as any));
    });
  }

  const table: Record<string, Record<string, number>> = {};
  RIVEN_CLASSES.forEach((klass, index) => {
    table[klass] = {};
    for (const [label, values] of Object.entries(out)) {
      const value = values[index];
      const kind = Object.keys(value ?? {})[0];
      if (!kind) continue;
      const raw = (value as any)[kind] as number;
      table[klass][label] = kind === 'percent' ? raw / 100 : raw;
    }
  });
  console.log(`riven stats: ${Object.keys(table.rifle).length} attributes x ${RIVEN_CLASSES.length} classes`);
  return table;
}

// ---------------------------------------------------------------- incarnons

/**
 * An Incarnon Genesis installs on the base weapon *and* its variants, so a Prime/Wraith/
 * Vandal/Prisma weapon inherits the tree of its base version. This is why 44 of the 69
 * Incarnon-capable weapons have no page of their own.
 */
// Chaining Incarnon forms, from the weapon's own page: Torid's beam chains to up to five
// nearby enemies within 7 m of each other, each link doing 75% of the previous one.
const INCARNON_CHAIN: Record<string, { maxTargets: number; falloff: number }> = {
  Torid: { maxTargets: 5, falloff: 0.75 },
};

const VARIANT_PREFIXES = [/^Mk1-/, /^Prisma /, /^Telos /, /^Rakta /, /^Synoid /, /^Dex /, /^Kuva /];
const VARIANT_SUFFIXES = [/ Prime$/, / Wraith$/, / Vandal$/, / Prisma$/, / Umbra$/];

function baseWeaponName(name: string): string | null {
  let base = name;
  for (const re of VARIANT_PREFIXES) base = base.replace(re, '');
  for (const re of VARIANT_SUFFIXES) base = base.replace(re, '');
  return base !== name ? base.trim() : null;
}

/**
 * Damage-dealing abilities, from the curated list in tools/fetch-damage-abilities.ts. Only the
 * frame, the ability, its damage type, its max-rank base damage and its radius are kept: how
 * each ability behaves beyond that is prose, not data.
 */
function buildDamageAbilities(): Record<string, DamageAbilityData> {
  const out: Record<string, DamageAbilityData> = {};
  let entries: Array<{
    frame: string; ability: string; damageType: string | null; baseDamage: number | null;
    radius: number | null; armorStrip?: { mode: 'percent' | 'flat'; value: number } | null;
    perSecond?: boolean; durationSeconds?: number | null;
    extraDot?: { perSecond: number; damageType: string | null; seconds: number } | null;
    statusProcs?: Array<{ type: string; stacks: number; seedFraction?: number; seed?: number }> | null;
    damageComponents?: Array<{ type: string; amount: number }> | null;
    modes?: Record<string, any> | null;
    statusRamp?: { type: string; procsPerSecond: number; maxStacks: number } | null;
    distanceFalloff?: { start: number; end: number; reduction: number } | null;
  }>;
  try {
    entries = readJson('damage-abilities.json');
  } catch {
    console.warn('damage abilities: data/raw/damage-abilities.json missing, run tools/fetch-damage-abilities.ts');
    return out;
  }
  for (const entry of entries) {
    // An ability with neither damage nor armour strip is not worth carrying.
    if ((!entry.damageType || !entry.baseDamage) && !entry.armorStrip) continue;
    out[entry.ability] = {
      frame: entry.frame,
      ability: entry.ability,
      damageType: (entry.damageType as DamageType) ?? null,
      baseDamage: entry.baseDamage ?? null,
      radius: entry.radius,
      armorStrip: entry.armorStrip ?? null,
      perSecond: Boolean(entry.perSecond),
      durationSeconds: entry.durationSeconds ?? null,
      extraDot: entry.extraDot ?? null,
      ...(entry.statusProcs?.length ? { statusProcs: entry.statusProcs as DamageAbilityData['statusProcs'] } : {}),
      ...(entry.damageComponents?.length ? { damageComponents: entry.damageComponents as DamageAbilityData['damageComponents'] } : {}),
      ...(entry.modes && Object.keys(entry.modes).length ? { modes: entry.modes as DamageAbilityData['modes'] } : {}),
      ...(entry.statusRamp ? { statusRamp: entry.statusRamp as DamageAbilityData['statusRamp'] } : {}),
      ...(entry.distanceFalloff ? { distanceFalloff: entry.distanceFalloff } : {}),
    };
  }
  console.log(`damage abilities: ${Object.keys(out).length}`);
  return out;
}

function buildIncarnons(weapons: Record<string, WeaponData>): Record<string, any[]> {
  const raw: Record<string, any[]> = { ...readJsonFile('incarnon-stats.json') };
  let inherited = 0;
  for (const weapon of Object.values(weapons)) {
    if (raw[weapon.name]) continue;
    // Melee forms have no "Incarnon Form" mode, so the profile is the signal that a tree exists.
    if (!weapon.incarnonForm && !weapon.modes.some((mode) => /incarnon/i.test(mode.name))) continue;
    let candidate = baseWeaponName(weapon.name);
    while (candidate) {
      if (raw[candidate]) {
        raw[weapon.name] = raw[candidate].map((option: Loose) => ({ ...option, inheritedFrom: candidate }));
        inherited++;
        break;
      }
      const next = baseWeaponName(candidate);
      if (next === candidate) break;
      candidate = next;
    }
  }
  console.log(`incarnons: ${Object.keys(raw).length} weapon(s) (${inherited} inherited from a base variant)`);
  return raw;
}

// --------------------------------------------------------------------- sets

function buildSetBonuses(): Record<string, any> {
  let raw: Record<string, any>;
  try {
    raw = readJsonFile('set-bonuses.json');
  } catch {
    return {};
  }
  const amplify = Object.values(raw).filter((entry) => entry.kind === 'amplify').length;
  console.log(`set bonuses: ${Object.keys(raw).length} (${amplify} amplify mod stats)`);
  return raw;
}

// ----------------------------------------------------------------- abilities

function buildAbilities(): Record<string, AbilityData> {
  const raw = readJsonFile('ability-stats.json');
  // Subsumable = the Helminth can put this ability on another frame.
  const subsumable = new Set<string>();
  try {
    const module = readLua('module-ability.lua');
    for (const entry of Object.values<Loose>(module.Ability ?? {})) {
      if (entry.Subsumable && typeof entry.Name === 'string') subsumable.add(entry.Name);
    }
  } catch {
    console.warn('could not read Module:Ability/data; Helminth flags missing');
  }
  const out: Record<string, AbilityData> = {};
  for (const entry of raw) {
    out[entry.ability] = {
      ability: entry.ability,
      frame: entry.frame,
      page: entry.page,
      kind: entry.kind,
      value: entry.value,
      segments: (entry.segments ?? []).map((segment: Loose) => ({ label: String(segment.label), max: segment.max })),
      duration: entry.duration ?? null,
      range: entry.range ?? null,
      subsumable: subsumable.has(entry.ability),
    };
  }
  console.log(`abilities: ${Object.keys(out).length}`);
  return out;
}

// --------------------------------------------------------------------- main

function main(): void {
  const unmatched: string[] = [];
  const { modifiers, healthTypes } = buildDamageTypes();

  const weapons = buildWeapons();
  const snapshot: Snapshot = {
    version: 1,
    generatedAt: new Date().toISOString(),
    gameVersion: '',
    weapons,
    mods: buildMods(unmatched),
    arcanes: buildArcanes(),
    warframes: buildWarframes(),
    abilities: buildAbilities(),
    rivenStats: buildRivenStats(),
    incarnons: buildIncarnons(weapons),
    damageAbilities: buildDamageAbilities(),
    setBonuses: buildSetBonuses(),
    enemies: buildEnemies(healthTypes),
    modifiers,
    healthTypes,
  };

  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(OUT, JSON.stringify(snapshot));
  writeFileSync(join(ROOT, 'docs/unmatched-mods.txt'), unmatched.join('\n').replace(/\t/g, ' | ') + '\n');

  const bytes = readFileSync(OUT).length;
  console.log(`\nsnapshot: ${(bytes / 1024 / 1024).toFixed(1)}MB -> data/snapshot.json`);
  console.log(`partial mods listed in docs/unmatched-mods.txt (${unmatched.length} lines)`);
}

main();
