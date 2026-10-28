/**
 * Parser for the wiki's riven "Base Values" tabs (Riven_Mods page), shared by build-data.ts and
 * fetch-riven-stats.ts. See fetch-riven-stats.ts for what the stored numbers mean.
 */
export const RIVEN_CLASSES = ['rifle', 'shotgun', 'pistol', 'archgun', 'melee'] as const;
const POSITIVE = 1.2 * 0.9375 * 1.1;
const NEGATIVE = 1.2 * 0.75 * 1.1;

/** Wiki row label -> the snapshot labels it fills. The first Faction Damage row is the normal stat, the second the spliced one. */
const LABELS: Record<string, string[]> = {
  'Ammo Maximum': ['Ammo Maximum'],
  'Faction Damage': ['Damage vs. Corpus', 'Damage vs. Grineer', 'Damage vs. Infested', 'Damage vs. Murmur', 'Damage vs. Sentient'],
  'Faction Damage (spliced)': ['Damage vs. Orokin'],
  'Elemental Damage': ['Cold Damage', 'Electricity Damage', 'Heat Damage', 'Toxin Damage'],
  'Combined Elemental Damage': ['Blast Damage', 'Corrosive Damage', 'Gas Damage', 'Magnetic Damage', 'Radiation Damage', 'Viral Damage'],
  'Physical Damage': ['Impact Damage', 'Puncture Damage', 'Slash Damage'],
  'Critical Chance': ['Critical Chance'],
  'Critical Damage': ['Critical Damage'],
  Damage: ['Damage'],
  'Melee Damage': ['Damage'],
  'Rate of Fire': ['Fire Rate'],
  'Attack Speed': ['Fire Rate'],
  'Projectile Speed': ['Projectile Speed'],
  'Magazine Capacity': ['Magazine Capacity'],
  Multishot: ['Multishot'],
  'Punch Through': ['Punch Through'],
  'Reload Speed': ['Reload Speed'],
  'Status Chance': ['Status Chance'],
  'Status Duration': ['Status Duration'],
  Recoil: ['Recoil'],
  Zoom: ['Zoom'],
  'Ammo Efficiency': ['Ammo Efficiency'],
  'Status Damage': ['Status Damage'],
  'Weakpoint Damage': ['Weakpoint Damage'],
  'Weakpoint Critical Chance': ['Weakpoint Critical Chance'],
  'Additional Combo Count Chance': ['Additional Combo Count Chance'],
  'Chance to Gain Combo Count': ['Chance to Gain Combo Count'],
  'Combo Duration': ['Combo Duration'],
  'Critical Chance for Slide Attack': ['Critical Chance for Slide Attack'],
  'Finisher Damage': ['Finisher Damage'],
  'Initial Combo': ['Initial Combo'],
  'Heavy Attack Efficiency': ['Heavy Attack Efficiency'],
  Range: ['Range'],
};

/** The upper bound of a range cell ("151.86% — 185.61%", "x1.46 — x1.56", "8.2s — 10.02s"), or null for "—". */
function upper(cell: string): number | null {
  const parts = cell.replace(/&#x2007;/g, '').split('&#8212;').map((part) => part.trim()).filter(Boolean);
  const text = parts[parts.length - 1];
  if (!text) return null;
  const number = Math.abs(Number(text.replace(/[^\d.-]/g, '')));
  if (!Number.isFinite(number)) return null;
  if (/^-?x/i.test(text)) return number - 1;
  if (/%$/.test(text)) return number / 100;
  return number; // seconds, metres, flat counts
}

export function parseRivenStats(wikitext: string): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  const tabs = wikitext.split(/^\|-\|(\w+) Attribute Ranges=$/m);
  for (let i = 1; i < tabs.length; i += 2) {
    const klass = tabs[i].toLowerCase();
    if (!(RIVEN_CLASSES as readonly string[]).includes(klass)) continue;
    const table: Record<string, number> = {};
    let factionRows = 0;
    for (const line of tabs[i + 1].split('\n')) {
      const match = /^\| style="text-align: left \| ([^|]+?)\s*\|\|(.*)$/.exec(line);
      if (!match) continue;
      let label = match[1].replace(/\s*\(.*\)$/, '').trim();
      if (label === 'Faction Damage' && factionRows++ > 0) label = 'Faction Damage (spliced)';
      const cells = match[2].split('||');
      const positive = upper(cells[0] ?? '');
      const malus = upper(cells[4] ?? '');
      const value = positive !== null ? positive / POSITIVE : malus !== null ? malus / NEGATIVE : null;
      if (value === null) continue;
      for (const key of LABELS[label] ?? []) table[key] ??= Math.round(value * 1e6) / 1e6;
    }
    out[klass] = table;
  }
  // Every class carries every attribute; one it cannot roll is 0.
  const keys = new Set(Object.values(out).flatMap((table) => Object.keys(table)));
  for (const klass of RIVEN_CLASSES) for (const key of keys) out[klass] = { ...out[klass], [key]: out[klass]?.[key] ?? 0 };
  return out;
}

