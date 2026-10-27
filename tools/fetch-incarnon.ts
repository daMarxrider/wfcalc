/**
 * Downloads Incarnon Genesis evolution trees.
 *
 * The wiki keeps one page per weapon ("Torid Incarnon Genesis") with a table of
 * evolutions: EVO1 unlocks the Incarnon Form, EVO2-EVO5 each offer two perks and the
 * player picks one. Perks are written as prose bullets, so this tool extracts the
 * option name and its bullets; the numbers are then mapped with the same rules the
 * mod parser uses, and anything unmapped is kept as text for display.
 *
 * Run: node tools/fetch-incarnon.ts [--force] [--limit N]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSnapshot } from '../src/data.ts';
import { mapTarget, readConditionHeader, readNumber } from '../src/mods/parse.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT_DIR = join(ROOT, 'data/raw/incarnon');
const OUT_JSON = join(ROOT, 'data/raw/incarnon-stats.json');

const force = process.argv.includes('--force');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;

/** Removes wiki markup so a bullet reads like game text: {{D|Heat}} -> Heat, {{M|Serration|label}} -> label. */
export function clean(text: string): string {
  return text
    .replace(/'''?/g, '')
    .replace(/\{\{[^{}|]*\|[^{}|]*\|([^{}|]*)\}\}/g, '$1')
    .replace(/\{\{[^{}|]*\|([^{}|]*)\}\}/g, '$1')
    .replace(/\{\{[^{}]*\}\}/g, ' ')
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface IncarnonEffect {
  target: string;
  element?: string;
  faction?: string;
  op: string;
  value: number;
  raw: string;
  flat?: boolean;
  perStatusType?: boolean;
  /** Gate in the mod parser's terms ("onKill", "onReloadEmpty", "onWeakPointHit"...). */
  condition?: string;
  maxStacks?: number;
  /** "Increase Base Critical Chance by +16%": added to the weapon's base stat, before mods. */
  base?: boolean;
  /** Only in the Incarnon form, or only outside it. */
  form?: 'incarnon' | 'normal';
  /** "With Critical Chance Below 50%": only while the build's crit chance is under this. */
  critChanceBelow?: number;
}

export interface IncarnonOption {
  tier: string;
  name: string;
  /** The perk's icon on the wiki ("IncarnonCritChanceCritDamage.png"), next to its name. */
  image?: string;
  effects: IncarnonEffect[];
  /** The perk's lines (placeholders filled in for this weapon), then the wiki's notes. */
  text: string[];
}

/** Base stats an Incarnon perk can raise before mods, by the parser's target name. */
const BASE_TARGETS = new Set(['critChance', 'statusChance', 'critDamage', 'multishot', 'magazine', 'fireRate']);

/** A gate written before a colon ("On Kill:", "With Critical Chance Below 50%:"); null for a note ("Bug:"). */
export function readGate(head: string): { condition?: string; critChanceBelow?: number } | null {
  const text = head.trim();
  if (/^bug$/i.test(text)) return null;
  // Swift Punishment's sprint-speed gate is met by the perk itself (wiki), so it is no gate.
  if (/^with sprint speed/i.test(text)) return {};
  const below = /^with critical chance below (\d+(?:\.\d+)?)%$/i.exec(text);
  if (below) return { critChanceBelow: Number(below[1]) / 100 };
  return { condition: readConditionHeader(`${text.replace(/ magazine$/i, '')}:`)?.key };
}

/** Gates written after the stat: "+40% Critical Chance on undamaged enemies", "+200% if enemy has less than half health". */
const SUFFIX_GATES: Array<[RegExp, string]> = [
  [/\s+on undamaged enemies$/i, 'onUndamagedEnemy'],
  [/\s+if (?:the )?(?:enemy|target) has less than half health$/i, 'enemyBelowHalfHealth'],
  [/\s+on (?:the )?last shot in (?:the )?magazine$/i, 'lastShotInMagazine'],
];

/**
 * Reads one perk sentence ("On Kill: +30% Damage for 8s", "Increase Base Status Chance by +96% for
 * Incarnon Form"). `gate` is a condition the whole line or a header line above it put on it.
 */
export function readSentence(sentence: string, gate: { condition?: string; critChanceBelow?: number } = {}): IncarnonEffect | null {
  let body = sentence.trim().replace(/\.$/, '');
  let { condition, critChanceBelow } = gate;
  const prefix = /^([^:]{3,80}):\s*(.+)$/.exec(body);
  if (prefix) {
    const own = readGate(prefix[1]);
    if (!own) return null;
    body = prefix[2];
    if (own.condition) condition = condition ? `${condition}+${own.condition}` : own.condition;
    if (own.critChanceBelow !== undefined) critChanceBelow = own.critChanceBelow;
  }
  body = body.replace(/,\s*resets on reload$/i, '');
  for (const [pattern, key] of SUFFIX_GATES) {
    if (!pattern.test(body)) continue;
    body = body.replace(pattern, '');
    condition = condition ? `${condition}+${key}` : key;
  }
  let form: IncarnonEffect['form'];
  if (/\s+(?:for|in) (?:the )?incarnon form$/i.test(body)) {
    form = 'incarnon';
    body = body.replace(/\s+(?:for|in) (?:the )?incarnon form$/i, '');
  }
  const stacks = /\.?\s*stacks? up to (\d+)x?/i.exec(body);
  body = body
    .replace(/\.?\s*stacks? up to \d+x?/i, '')
    .replace(/\s+for \d+(?:\.\d+)?\s*s(?:econds)?\b/i, '')
    .replace(/\s+per projectile$/i, '')
    .replace(/^(?:increase|increases|gain|gains|adds?) /i, '')
    .trim();
  const perStatusType = /\bper status type\b/i.test(body);
  // Two shapes: "+60% Damage" and "Base Damage by +51".
  const byMatch = /^(.*?)\s+by\s+([+-]?\d+(?:[.,]\d+)?)\s*(%|x)?/i.exec(body);
  const read = byMatch ? null : readNumber(body);
  const number = byMatch
    ? { value: Number(byMatch[2].replace(',', '.')), unit: (byMatch[3]?.toLowerCase() as '%' | 'x' | undefined) ?? null, rest: byMatch[1], signed: /^[+-]/.test(byMatch[2]) }
    : read ? { ...read, signed: /^[+-]/.test(body) } : null;
  if (!number) return null;
  // "by 25% of current Status Chance, up to 35%" is a formula, not a flat bonus.
  if (byMatch && /^\s*of\b/i.test(body.slice(byMatch[0].length))) return null;
  const base = /^base\b/i.test(number.rest);
  const rest = number.rest
    .replace(/\bon last shot in magazine\b/i, '')
    .replace(/^base\s+/i, '')
    .replace(/\s*per status type affecting the target\.?$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const mapped = /^critical damage multiplier$/i.test(rest) ? { target: 'critDamage', op: 'add' } : mapTarget(rest);
  if (!mapped) return null;
  const onBase = base && BASE_TARGETS.has(mapped.target);
  const unit = number.unit;
  // "+0.4x" adds to a multiplier; "x1.3" multiplies.
  const value = unit === '%' ? number.value / 100 : unit === 'x' ? (number.signed ? number.value : number.value - 1) : number.value;
  return {
    target: mapped.target,
    ...('element' in mapped && mapped.element ? { element: mapped.element } : {}),
    ...('faction' in mapped && mapped.faction ? { faction: mapped.faction } : {}),
    op: mapped.op,
    value,
    raw: sentence.trim(),
    ...(unit === null && !onBase ? { flat: true } : {}),
    ...(perStatusType ? { perStatusType: true } : {}),
    ...(condition ? { condition } : {}),
    ...(stacks ? { maxStacks: Number(stacks[1]) } : {}),
    ...(onBase ? { base: true } : {}),
    ...(form ? { form } : {}),
    ...(critChanceBelow !== undefined ? { critChanceBelow } : {}),
  };
}

interface Cell { span: number; raw: string; header: boolean }

/** Splits a table row into cells; a cell starts at a line beginning with "|" or "!". */
function cellsOf(row: string): Cell[] {
  const cells: Cell[] = [];
  for (const line of row.split('\n')) {
    const trimmed = line.trim();
    const start = /^([|!])(?![-}+])/.exec(trimmed);
    if (!start) {
      if (cells.length) cells[cells.length - 1].raw += `\n${line}`;
      continue;
    }
    let text = trimmed.slice(1);
    // Attributes end at the first "|" outside [[...]] and {{...}}: | colspan="2" style="..." | -
    let depth = 0;
    let split = -1;
    for (let i = 0; i < text.length; i++) {
      const pair = text.slice(i, i + 2);
      if (pair === '[[' || pair === '{{') { depth++; i++; continue; }
      if (pair === ']]' || pair === '}}') { depth--; i++; continue; }
      if (depth === 0 && text[i] === '|') { split = i; break; }
    }
    let attributes = '';
    if (split >= 0 && /=/.test(text.slice(0, split))) {
      attributes = text.slice(0, split);
      text = text.slice(split + 1);
    }
    const span = Number(/colspan="?(\d+)/.exec(attributes)?.[1] ?? 1);
    cells.push({ span, raw: text, header: start[1] === '!' });
  }
  return cells;
}

/** "X = 14<br>Y = 60%" -> { X: '14', Y: '60%' }; null for "-" (nothing to fill in). */
function valuesOf(raw: string): Record<string, string> | null {
  const values: Record<string, string> = {};
  for (const match of raw.matchAll(/\b([A-Z])\s*=\s*([^<\n]+)/g)) values[match[1]] = clean(match[2]);
  return Object.keys(values).length ? values : null;
}

const PLACEHOLDER = /(\+?)\b([XYZ])\b/g;
const hasPlaceholder = (text: string): boolean => /\b[XYZ]\b/.test(text);

/**
 * Extracts every EVO row of the "Evolutions" table, per weapon variant: the table has one value
 * column per variant ("X = 14" on the Braton, "X = 2" on the Braton Prime), and the perk text
 * says "+X". Effects come from the perk lines only, never from the notes; a note saying the
 * perk does not affect the Incarnon form scopes its effects to the normal form.
 */
export function parseEvolutions(wikitext: string, fallbackWeapon: string): Record<string, IncarnonOption[]> {
  const section = wikitext.split('===Evolutions===')[1] ?? '';
  const body = section.split('\n|}')[0];
  const rows = body.split(/\n\|-/);
  const header = rows.find((row) => /\{\{Weapon\|/.test(row) && !/EVO\d/.test(row)) ?? '';
  // The value columns name the page's own weapon and its variants; a header that does not name the
  // page's weapon (Hate's mentions Dread and Despair) has no variant columns.
  let variants = [...header.matchAll(/\{\{Weapon\|([^|}]+)/g)].map((match) => match[1].trim());
  if (!variants.includes(fallbackWeapon)) variants = [fallbackWeapon];
  const out: Record<string, IncarnonOption[]> = Object.fromEntries(variants.map((variant) => [variant, []]));
  let tier = 'EVO1';

  const bulletsOf = (raw: string): string[] => raw.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('*'))
    .map((line) => clean(line.replace(/^\*+\s*/, '')))
    .filter(Boolean);

  for (const row of rows) {
    const tierMatch = /EVO\d/.exec(row);
    if (tierMatch) tier = tierMatch[0];
    // EVO1 is the unlock itself, not a choice; the form's profile comes from the weapon database.
    if (tier === 'EVO1') continue;
    const cells = cellsOf(row).filter((cell) => !cell.header);
    if (cells.length < 2) continue;
    // The name is the cell text before the perk's icon; not every page bolds it (Burston's
    // "Ready Retaliation" is plain, and the first bold text there is "+100%" in its bullet).
    const nameCell = cells[0].raw;
    const icon = /\[\[File:([^|\]]+)/.exec(nameCell);
    const name = clean(nameCell.replace(/\[\[File:[^\]]*\]\]/g, ''));
    if (!name || /Evolution Challenge|^Incarnon Form$/i.test(name)) continue;
    const image = icon ? icon[1].trim().replace(/ /g, '_') : undefined;

    const perk = bulletsOf(cells[1].raw);
    if (!perk.length) continue;
    // Value cells, one span per variant, then the notes.
    const columns: Array<Record<string, string> | null> = [];
    let index = 2;
    while (columns.length < variants.length && index < cells.length) {
      const values = valuesOf(cells[index].raw);
      for (let i = 0; i < cells[index].span; i++) columns.push(values);
      index++;
    }
    const notes = cells.slice(index).flatMap((cell) => bulletsOf(cell.raw));
    // Only a note that is nothing but "Does not apply to the Incarnon form" scopes the perk; the
    // magazine variants ("Increased Base Magazine Capacity does not affect Incarnon Form") scope
    // the magazine bonus alone. Longer notes explain details and scope nothing.
    const scopeNote = notes.find((note) => /^(?:the bonus |this (?:bonus |effect )?|it |increased base magazine capacity )?(?:does not|doesn't) (?:apply to|affect) (?:the )?incarnon form(?:'s magazine)?\.?$/i.test(note));
    const notIncarnon = scopeNote !== undefined;
    const onlyMagazine = notIncarnon && /magazine/i.test(scopeNote!);

    variants.forEach((variant, column) => {
      const values = columns[column] ?? null;
      const lines = perk.map((line) => line
        .replace(PLACEHOLDER, (match, plus: string, key: string) => {
          const value = values?.[key];
          if (!value) return match;
          return /^[+-]/.test(value) ? value : `${plus}${value}`;
        })
        // "+X%" with "X = 20%" reads "+20%%".
        .replace(/(\d)(%|x)\2/g, '$1$2'));
      const effects: IncarnonEffect[] = [];
      // "On Equip From Primary:" alone on a line gates the lines below it.
      let header: { condition?: string; critChanceBelow?: number } = {};
      for (const line of lines) {
        const headerLine = /^([^:]{3,80}):$/.exec(line.trim());
        if (headerLine) {
          header = readGate(headerLine[1]) ?? {};
          continue;
        }
        // A gate at the start of a line covers all of it: "On Kill: +25% X for 5s. Stacks up to 3x."
        let gate = header;
        let text = line.replace(/\.\s+(stacks? up to)/gi, ' $1');
        const lead = /^([^:]{3,80}):\s*(.+)$/.exec(text);
        if (lead) {
          const own = readGate(lead[1]);
          if (!own) continue;
          gate = {
            condition: [header.condition, own.condition].filter(Boolean).join('+') || undefined,
            critChanceBelow: own.critChanceBelow ?? header.critChanceBelow,
          };
          text = lead[2];
        }
        // "+15% Status Chance. Effect doubles in Incarnon Form." -> +15% outside the form, +30% in it.
        const doubles = /\.?\s*effect doubles in (?:the )?incarnon form\.?/i.test(text);
        text = text.replace(/\.?\s*effect doubles in (?:the )?incarnon form\.?/i, '');
        // Several stats per line: "+3 Punch Through, +40% Accuracy", "Punch Through +4 and +40% Accuracy".
        for (const sentence of text.split(/\.\s+|,\s+(?=[+-]?\d)|\s+and\s+(?=[+-]\d)/)) {
          if (hasPlaceholder(sentence)) continue; // no value for this variant
          const effect = readSentence(sentence, gate);
          if (!effect) continue;
          if (doubles && !effect.form) {
            effects.push({ ...effect, form: 'normal' }, { ...effect, value: effect.value * 2, form: 'incarnon' });
            continue;
          }
          if (notIncarnon && !effect.form && (!onlyMagazine || effect.target === 'magazine')) effect.form = 'normal';
          effects.push(effect);
        }
      }
      // "+12% per projectile" and "+96% for Incarnon Form" are one bonus: the form's figure is the
      // per-projectile value times its pellets (wiki: "divided by the innate multishot"), so a form
      // line that is a whole multiple of the plain one is the same bonus and is dropped.
      for (const effect of [...effects]) {
        // Only a "... for Incarnon Form" line; the doubled copy of "Effect doubles" is a real value.
        if (effect.form !== 'incarnon' || !/incarnon form/i.test(effect.raw)) continue;
        const perPellet = effects.find((other) => other.form !== 'incarnon' && other.target === effect.target && other.base === effect.base && other.value > 0);
        const ratio = perPellet ? effect.value / perPellet.value : 0;
        // The wiki rounds the form figure (Strun Prime: 12 x 11.3% shows as 136%).
        if (ratio >= 2 && Math.abs(ratio - Math.round(ratio)) < 0.05) effects.splice(effects.indexOf(effect), 1);
      }
      out[variant].push({ tier, name, ...(image ? { image } : {}), effects, text: [...lines, ...notes] });
    });
  }
  return out;
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const snapshot = loadSnapshot();
  // A transformed profile means the weapon has a tree: ranged weapons name the mode
  // "Incarnon Form", melee weapon names are free-form ("Spectral Dagger") and appear only
  // in `incarnonForm`.
  const candidates = Object.values(snapshot.weapons)
    .filter((weapon) => weapon.incarnonForm || weapon.modes.some((mode) => /incarnon/i.test(mode.name)))
    .map((weapon) => weapon.name)
    .slice(0, limit === Infinity ? undefined : limit);

  const out: Record<string, IncarnonOption[]> = {};
  let missing = 0;

  for (const weapon of candidates) {
    const file = join(OUT_DIR, `${weapon.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.wiki`);
    let wikitext: string | null = null;
    if (!force) {
      try {
        wikitext = await readFile(file, 'utf8');
      } catch {
        wikitext = null;
      }
    }
    if (!wikitext) {
      // Genesis weapons have a dedicated "X Incarnon Genesis" page; native Incarnon
      // weapons (Phenmor, Laetum...) keep the same Evolutions table on their own page.
      const pages = [
        `${encodeURIComponent(weapon).replace(/%2F/g, '/')}_Incarnon_Genesis`,
        encodeURIComponent(weapon).replace(/%2F/g, '/'),
      ];
      for (const page of pages) {
        const response = await fetch(`https://wiki.warframe.com/w/${page}?action=raw`, {
          headers: { 'user-agent': 'wfcalc/0.1 (offline damage calculator)' },
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) continue;
        const text = await response.text();
        if (/<!DOCTYPE html>/i.test(text) || !text.includes('===Evolutions===')) continue;
        wikitext = text;
        await writeFile(file, text);
        break;
      }
      if (!wikitext) {
        missing++;
        continue;
      }
    }

    const byVariant = parseEvolutions(wikitext, weapon);
    const options = byVariant[weapon] ?? Object.values(byVariant)[0] ?? [];
    if (options.length) {
      // Every variant column of the page (Braton, Mk1-Braton, Braton Vandal, Braton Prime) has its own values.
      for (const [variant, variantOptions] of Object.entries(byVariant)) if (variantOptions.length) out[variant] = variantOptions;
      console.log(`${weapon.padEnd(22)} ${options.length} option(s), ${options.reduce((n, o) => n + o.effects.length, 0)} parsed effect(s), variants: ${Object.keys(byVariant).join(', ')}`);
    } else {
      missing++;
    }
    await new Promise((resolve) => setTimeout(resolve, 120)); // be polite to the wiki
  }

  await writeFile(OUT_JSON, JSON.stringify(out, null, 2) + '\n');
  console.log(`\n${Object.keys(out).length} weapon(s) with evolutions -> data/raw/incarnon-stats.json (${missing} without data)`);
}

// Run as a script only: the tests import the parser.
if (import.meta.url === `file://${process.argv[1]}`) await main();
