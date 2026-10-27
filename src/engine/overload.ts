/**
 * Per-status-type damage (Condition Overload, Galvanized Aptitude/Savvy/Shot, Incarnon perks)
 * adds to Serration-type bonuses on most attacks and multiplies with them on a few
 * (wiki: Condition Overload (Mechanic), "Adding" vs "Multiplying").
 *
 * Attacks listed there as Multiplying, by weapon. '*' is the default profile (no mode picked),
 * 'incarnon' the Incarnon form, anything else a mode name from the snapshot.
 * shortcut: melee heavy/projectile attacks, archguns and amps are left out (Galvanized mods do
 * not fit them, Condition Overload stays additive), re-read the wiki table when it changes.
 */
const MULTIPLYING: Record<string, string[]> = {
  Aeolak: ['*', 'Normal Attack', 'Alt-Fire'],
  Alternox: ['*', 'Normal Attack'],
  'Alternox Prime': ['*', 'Normal Attack'],
  'Arca Plasmor': ['*', 'Normal Attack'],
  'Tenet Arca Plasmor': ['*', 'Normal Attack'],
  Basmu: ['*', 'Auto'],
  Battacor: ['*', 'Normal Attack'],
  Bubonico: ['*', 'Auto', 'Burst'],
  Buzlok: ['*', 'Normal Attack', 'Beacon'],
  Cedo: ['Alt-Fire Glaive'],
  'Cedo Prime': ['Alt-Fire Glaive'],
  Cinta: ['*', 'Quick Shot', 'Charged Shot', 'Perfect Shot'],
  'Coda Bassocyst': ['*', 'Normal Attack'],
  'Coda Hema': ['*', 'Normal Attack'],
  Hema: ['*', 'Normal Attack'],
  'Mutalist Cernos': ['Uncharged Shot'],
  Dread: ['incarnon', 'Incarnon Form Charged Shot'],
  Exergis: ['*', 'Normal Attack'],
  Felarx: ['*', 'Normal Attack', 'incarnon', 'Incarnon Form'],
  Fulmin: ['Semi-Auto Mode'],
  Harpak: ['Harpoon'],
  Javlok: ['*', 'Projectile Impact'],
  Latron: ['incarnon', 'Incarnon Form'],
  'Latron Prime': ['incarnon', 'Incarnon Form'],
  Miter: ['incarnon', 'Incarnon Form'],
  Nataruk: ['*', 'Charged Shot', 'Perfect Shot'],
  Nunchasa: ['Alt-Fire'],
  Paracyst: ['Infested Harpoon', 'Infested Harpoon Contact'],
  Paris: ['incarnon', 'Incarnon Form Charged Shot'],
  'Paris Prime': ['incarnon', 'Incarnon Form Charged Shot'],
  Phantasma: ['Cluster Bombs Impact'],
  'Phantasma Prime': ['Cluster Bombs Impact'],
  Quellor: ['Alt-Fire'],
  Scourge: ['Spear Throw Impact'],
  'Scourge Prime': ['Spear Throw'],
  Shedu: ['*', 'Normal Attack'],
  Stahlta: ['*', 'Auto', 'Alt-Fire'],
  Steflos: ['*', 'Normal Attack'],
  'Tenet Envoy': ['*', 'Grenade Impact'],
  Torid: ['*', 'Grenade Impact', 'Poison Cloud'],
  Trumna: ['Grenade Impact'],
  'Akarius Prime': ['*', 'Rocket Impact'],
  Aegrit: ['*', 'Direct Hit'],
  Angstrum: ['incarnon', 'Incarnon Form'],
  'Prisma Angstrum': ['incarnon', 'Incarnon Form'],
  'Ballistica Prime': ['incarnon', 'Incarnon Form'],
  Catabolyst: ['Partial Reload Impact', 'Reload From Empty Impact'],
  Cyanex: ['*', 'Projectile Impact', 'Burst Mode'],
  Epitaph: ['*', 'Charged Shot', 'Uncharged Direct Hit'],
  Kunai: ['incarnon', 'Incarnon Form'],
  'Mk1-Kunai': ['incarnon', 'Incarnon Form'],
  'Kuva Seer': ['*', 'Projectile Impact'],
  Seer: ['*', 'Normal Attack'],
  Sepulcrum: ['*', 'Primary-Fire', 'Lock-On Mode'],
  'Tenet Diplos': ['Lock-on Mode'],
  'Tenet Plinx': ['Alt-Fire'],
  'Tenet Spirex': ['*', 'Slug Impact'],
  Zakti: ['*', 'Dart Impact'],
  'Zakti Prime': ['*', 'Normal Attack'],
  Zymos: ['Homing Spore Contact'],
};

/** True when this attack multiplies per-status-type damage with Serration instead of adding it. */
export function overloadMultiplies(weapon: string, mode: string | null, incarnonForm: boolean): boolean {
  const attacks = MULTIPLYING[weapon];
  if (!attacks) return false;
  if (incarnonForm) return attacks.includes('incarnon');
  return attacks.includes(mode ?? '*');
}
