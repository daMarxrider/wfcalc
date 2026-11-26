/**
 * Condition Overload-style bonuses (Condition Overload, Galvanized Aptitude/Savvy/Shot, Secondary
 * Shiver): "Adding" or "Multiplying" with Serration-type damage mods, per attack.
 *
 * Source: wiki.warframe.com/w/Condition_Overload_(Mechanic), "Attack Catalog" (read 2026-11-26).
 * Every attack the catalog marks "Multiplying" that this tool can fire has a test below; the
 * snapshot mode each wiki attack maps to is written next to it.
 *
 * The claim, made robust to other bonuses a weapon carries (Cedo's own +60% per status):
 * with an 80% per-status bonus active, how much does a +165% damage mod still raise the hit?
 *   Multiplying: the mod keeps its full x2.65, whatever sits in the per-status bucket.
 *   Adding:      (1 + 1.65 + 0.8) / (1 + 0.8) = x1.9167 on a weapon with no other bonus.
 * Arch-guns use Secondary Shiver (+45% per Cold stack, 1 stack) and Rubedo-Lined Barrel (+100%):
 *   Multiplying: x2.0;  Adding: (1 + 1 + 0.45) / (1 + 0.45) = x1.6897.
 *
 * Catalog rows not tested, with the reason:
 *   - Robotic weapons and Amps: no Condition Overload-style source fits them (wiki source list).
 *   - Zenith "Alt-fire Disk Bonk", Exodia Contagion, Exalted Umbra Blade "Heavy Waves": the data
 *     has no such attack to fire.
 */
import { test } from 'node:test';
import { loadSnapshot } from '../src/data.ts';
import { resolveBuild, type Build } from '../src/engine/build.ts';
import { close } from './builders.ts';

const snap = loadSnapshot();

/** Weapon-class pair: a +165% damage mod (+100% on arch-guns) and the per-status source at +80% (+45%). */
const KIT = {
  rifle: { damage: 'Serration', status: { mods: ['Galvanized Aptitude'], conditions: { onKill: 2 } } },
  shotgun: { damage: 'Primed Point Blank', status: { mods: ['Galvanized Savvy'], conditions: { onKill: 2 } } },
  pistol: { damage: 'Magnum Force', status: { mods: ['Galvanized Shot'], conditions: { onKill: 2 } } },
  melee: { damage: 'Primed Pressure Point', status: { mods: ['Condition Overload'], conditions: {} } },
  archgun: { damage: 'Rubedo-Lined Barrel', status: { mods: [], conditions: {}, arcanes: ['Secondary Shiver'], sourceStacks: { 'Secondary Shiver': 1 } } },
} as const;
type Kit = keyof typeof KIT;

/** How much the damage mod raises the hit while the per-status bonus is up: damage(both) / damage(status only). */
function damageModGainWithStatusBonus(weapon: string, mode: string, kit: Kit): number {
  const { damage, status } = KIT[kit];
  const base: Build = {
    weapon, mode, mods: [...status.mods], quantize: false,
    conditions: { ...status.conditions, statusTypes: 1 },
    arcanes: 'arcanes' in status ? [...status.arcanes] : [],
    sourceStacks: 'sourceStacks' in status ? { ...status.sourceStacks } : undefined,
  };
  const statusOnly = resolveBuild(snap, base).damage.projectileTotal;
  const both = resolveBuild(snap, { ...base, mods: [damage, ...status.mods] }).damage.projectileTotal;
  return both / statusOnly;
}

const MULTIPLYING = { rifle: 2.65, shotgun: 2.65, pistol: 2.65, melee: 2.65, archgun: 2.0 } as const;
const ADDING = { rifle: 3.45 / 1.8, shotgun: 3.45 / 1.8, pistol: 3.45 / 1.8, melee: 3.45 / 1.8, archgun: 2.45 / 1.45 } as const;

/** [weapon, snapshot mode, kit, wiki attack name] for every catalog row marked "Multiplying". */
const MULTIPLYING_ATTACKS: Array<[string, string, Kit, string]> = [
  // Primaries
  ['Aeolak', 'Normal Attack', 'rifle', 'Normal Attack'],
  ['Aeolak', 'Alt-Fire', 'rifle', 'Alt-fire'],
  ['Alternox', 'Normal Attack', 'rifle', 'Normal Attack'],
  ['Alternox Prime', 'Normal Attack', 'rifle', 'Normal Attack'],
  ['Arca Plasmor', 'Normal Attack', 'shotgun', 'Normal Attack'],
  ['Tenet Arca Plasmor', 'Normal Attack', 'shotgun', 'Normal Attack'],
  ['Basmu', 'Auto', 'rifle', 'Main-fire'],
  ['Battacor', 'Normal Attack', 'rifle', 'Main-fire'],
  ['Bubonico', 'Auto', 'shotgun', 'Main-fire'],
  ['Bubonico', 'Burst', 'shotgun', 'Alt-fire'],
  ['Buzlok', 'Normal Attack', 'rifle', 'Normal Attack'],
  ['Buzlok', 'Beacon', 'rifle', 'Alt-fire'],
  ['Catchmoon / Tremor / Arcroid', 'Normal Attack', 'shotgun', 'Catchmoon (Primary) (Tremor) Normal Attack'],
  ['Sporelacer / Tremor / Arcroid', 'Normal Attack', 'shotgun', 'Sporelacer (Primary) (Tremor) Normal Attack'],
  ['Tombfinger / Brash / Arcroid', 'Normal Attack', 'rifle', 'Tombfinger (Primary) (Brash) Normal Attack'],
  ['Cedo', 'Alt-Fire Glaive', 'shotgun', 'Alt-fire'],
  ['Cedo Prime', 'Alt-Fire Glaive', 'shotgun', 'Alt-fire'],
  ['Coda Bassocyst', 'Normal Attack', 'rifle', 'Normal Attack'],
  ['Coda Hema', 'Normal Attack', 'rifle', 'Normal Attack'],
  ['Hema', 'Normal Attack', 'rifle', 'Normal Attack'],
  ['Mutalist Cernos', 'Uncharged Shot', 'rifle', 'Uncharged Attack'],
  ['Mutalist Cernos', 'Toxin Cloud', 'rifle', 'Uncharged AoE Toxin Cloud'],
  ['Cinta', 'Quick Shot', 'rifle', 'Uncharged Attack'],
  ['Cinta', 'Charged Shot', 'rifle', 'Charged Attack'],
  ['Cinta', 'Perfect Shot', 'rifle', 'Perfect Shot'],
  ['Dread', 'Incarnon Form Charged Shot', 'rifle', 'Incarnon Mode'],
  ['Exergis', 'Normal Attack', 'shotgun', 'Normal Attack'],
  ['Felarx', 'Normal Attack', 'shotgun', 'Normal Attack'],
  ['Felarx', 'Incarnon Form', 'shotgun', 'Incarnon Mode'],
  ['Fulmin', 'Semi-Auto Mode', 'rifle', 'Semi-Mode'],
  ['Harpak', 'Harpoon', 'rifle', 'Alt-fire'],
  ['Javlok', 'Projectile Impact', 'rifle', 'Main-fire'],
  ['Latron', 'Incarnon Form', 'rifle', 'Incarnon Mode'],
  ['Latron Prime', 'Incarnon Form', 'rifle', 'Incarnon Mode'],
  ['Miter', 'Incarnon Form', 'rifle', 'Incarnon Mode'],
  ['Nataruk', 'Charged Shot', 'rifle', 'Charged Attack'],
  ['Nataruk', 'Perfect Shot', 'rifle', 'Perfect Shot'],
  ['Nunchasa', 'Alt-Fire', 'rifle', 'Alternate Fire'],
  ['Paracyst', 'Infested Harpoon', 'rifle', 'Alt-fire'],
  ['Paris', 'Incarnon Form Charged Shot', 'rifle', 'Incarnon Mode'],
  ['Paris Prime', 'Incarnon Form Charged Shot', 'rifle', 'Incarnon Mode'],
  ['Phantasma', 'Cluster Bombs Impact', 'shotgun', 'Alt-fire Child Bomb'],
  ['Phantasma Prime', 'Cluster Bombs Impact', 'shotgun', 'Alt-fire Child Bomb'],
  ['Quellor', 'Alt-Fire', 'rifle', 'Alt-fire'],
  ['Scourge', 'Spear Throw Impact', 'rifle', 'Throw'],
  ['Scourge Prime', 'Spear Throw', 'rifle', 'Throw'],
  ['Shedu', 'Normal Attack', 'rifle', 'Normal Attack'],
  ['Stahlta', 'Auto', 'rifle', 'Main-fire'],
  ['Stahlta', 'Alt-Fire', 'rifle', 'Alt-fire'],
  ['Steflos', 'Normal Attack', 'shotgun', 'Normal Attack'],
  ['Steflos Prime', 'Normal Attack', 'shotgun', 'Normal Attack'],
  ['Tenet Envoy', 'Grenade Impact', 'rifle', 'Normal Attack'],
  ['Torid', 'Grenade Impact', 'rifle', 'Main-fire'],
  ['Torid', 'Poison Cloud', 'rifle', 'Toxin AoE Cloud'],
  ['Trumna', 'Grenade Impact', 'rifle', 'Alt-fire'],
  // Secondaries
  ['Akarius Prime', 'Rocket Impact', 'pistol', 'Rocket Impact'],
  ['Aegrit', 'Direct Hit', 'pistol', 'Direct Hit'],
  ['Angstrum', 'Incarnon Form', 'pistol', 'Incarnon Mode'],
  ['Prisma Angstrum', 'Incarnon Form', 'pistol', 'Incarnon Mode'],
  ['Ballistica Prime', 'Incarnon Form', 'pistol', 'Incarnon Mode'],
  ['Catabolyst', 'Partial Reload Impact', 'pistol', 'Partial Reload Impact'],
  ['Catabolyst', 'Reload From Empty Impact', 'pistol', 'Reload From Empty Impact'],
  ['Catchmoon / Gibber / Arcroid', 'Normal Attack', 'pistol', 'Catchmoon (Secondary) Normal Attack'],
  ['Tombfinger / Gibber / Arcroid', 'Normal Attack', 'pistol', 'Tombfinger (Secondary) Normal Attack'],
  ['Cyanex', 'Projectile Impact', 'pistol', 'Projectile Impact'],
  ['Cyanex', 'Burst Mode', 'pistol', 'Burst Mode'],
  ['Epitaph', 'Charged Shot', 'pistol', 'Charged Shot'],
  ['Epitaph', 'Uncharged Direct Hit', 'pistol', 'Uncharged Direct Hit'],
  ['Kunai', 'Incarnon Form', 'pistol', 'Incarnon Mode'],
  ['Mk1-Kunai', 'Incarnon Form', 'pistol', 'Incarnon Mode'],
  ['Tenet Plinx', 'Alt-Fire', 'pistol', 'Alt Fire Impact'],
  ['Seer', 'Normal Attack', 'pistol', 'Normal Attack'],
  ['Kuva Seer', 'Projectile Impact', 'pistol', 'Projectile Impact'],
  ['Sepulcrum', 'Primary-Fire', 'pistol', 'Primary-Fire'],
  ['Sepulcrum', 'Lock-On Mode', 'pistol', 'Lock-On Mode'],
  ['Tenet Diplos', 'Lock-on Mode', 'pistol', 'Lock-on Mode'],
  ['Tenet Spirex', 'Slug Impact', 'pistol', 'Slug Impact'],
  ['Zakti', 'Dart Impact', 'pistol', 'Normal Attack'],
  ['Zakti Prime', 'Normal Attack', 'pistol', 'Normal Attack'],
  ['Zymos', 'Homing Spore Contact', 'pistol', 'Homing Spore Contact'],
  // Melee projectiles (Condition Overload)
  ['Corufell', 'Charged Projectile', 'melee', 'Heavy Attack Projectile'],
  ['Nepheri', 'Fireballs', 'melee', 'Neutral Combo Fireball'],
  ['Syam', 'First Shockwave', 'melee', 'Heavy Attack Wave 1'],
  ['Syam', 'Second Shockwave', 'melee', 'Heavy Attack Wave 2'],
  ['Tenet Grigori', 'Energy Disk', 'melee', 'Energy Disk'],
  ['Verdilac', 'Energy Wave', 'melee', 'Energy Wave'],
  // Arch-guns (Secondary Shiver)
  ['Arbucep', '1st Attack', 'archgun', 'Direct Hit'],
  ['Kuva Ayanga', 'Grenade Impact', 'archgun', 'Direct Hit'],
  ['Corvas Prime', 'Uncharged Shot', 'archgun', 'Uncharged Attack'],
  ['Corvas Prime', 'Charged Shot', 'archgun', 'Charged Attack'],
  ['Grattler', 'Projectile Impact', 'archgun', 'Normal attack'],
  ['Larkspur Prime', 'Alt-Fire Projectile Impact', 'archgun', 'Alt-fire'],
  ['Mandonel', 'Horizontal Spread', 'archgun', 'Uncharged Attack'],
  ['Velocitus', 'Uncharged Shot', 'archgun', 'Uncharged attack'],
  ['Velocitus', 'Charged Shot', 'archgun', 'Charged attack'],
];

for (const [weapon, mode, kit, wikiAttack] of MULTIPLYING_ATTACKS) {
  test(`multiplying: ${weapon} ${mode} (wiki: ${wikiAttack}) keeps the full damage mod on top of the per-status bonus`, () => {
    close(damageModGainWithStatusBonus(weapon, mode, kit), MULTIPLYING[kit], 1e-6);
  });
}

/** [weapon, snapshot mode, kit, why it adds] for attacks the catalog marks "Adding", and the default. */
const ADDING_ATTACKS: Array<[string, string, Kit, string]> = [
  ['Kunai', 'Normal Attack', 'pistol', 'wiki: Normal Attack, Adding (only the Incarnon form multiplies)'],
  ['Acrid', 'Normal Attack', 'pistol', 'wiki: Normal Attack, Adding'],
  ['Mara Detron', 'Normal Attack', 'pistol', 'wiki: Normal Attack, Adding'],
  ['Fluctus', 'Normal Attack', 'archgun', 'wiki: Normal attack, Adding'],
  ['Mandonel', 'Charge', 'archgun', 'wiki: Charged attack, Adding'],
  ['Corufell', 'Normal Attack', 'melee', 'a melee swing, not a listed projectile'],
  ['Soma Prime', 'Fully Spooled', 'rifle', 'not in the catalog: hit-scan attacks add (wiki: "the most common way")'],
  ['Latron', 'Normal Attack', 'rifle', 'wiki: Latron Normal Attack adds, only its Incarnon Mode multiplies'],
];

for (const [weapon, mode, kit, why] of ADDING_ATTACKS) {
  test(`adding: ${weapon} ${mode} (${why}) adds the damage mod to the per-status bonus`, () => {
    close(damageModGainWithStatusBonus(weapon, mode, kit), ADDING[kit], 1e-6);
  });
}
