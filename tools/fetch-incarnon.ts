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
import { mapTarget, readNumber } from '../src/mods/parse.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT_DIR = join(ROOT, 'data/raw/incarnon');
const OUT_JSON = join(ROOT, 'data/raw/incarnon-stats.json');

const force = process.argv.includes('--force');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;

/** Removes wiki markup so a bullet reads like game text. */
function clean(text: string): string {
  return text
    .replace(/'''?/g, '')
    .replace(/\{\{[^{}]*\}\}/g, ' ')
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface IncarnonOption {
  tier: string;
  name: string;
  /** The perk's icon on the wiki ("IncarnonCritChanceCritDamage.png"), next to its name. */
  image?: string;
  effects: Array<{ target: string; element?: string; faction?: string; op: string; value: number; raw: string; flat?: boolean; perStatusType?: boolean }>;
  text: string[];
}

/** Extracts every EVO row of the "Evolutions" table. */
function parseEvolutions(wikitext: string): IncarnonOption[] {
  const section = wikitext.split('===Evolutions===')[1] ?? '';
  const body = section.split('\n|}')[0];
  const options: IncarnonOption[] = [];
  let tier = 'EVO1';

  for (const row of body.split(/\n\|-/)) {
    const tierMatch = /EVO\d/.exec(row);
    if (tierMatch) tier = tierMatch[0];
    // EVO1 is the unlock itself, not a choice: its bullets describe how to transform and the
    // wiki does not always bold "Incarnon Form", so the name search below would pick a number
    // out of the prose ("6x", "0.5"). The form's own profile is read from the weapon database.
    if (tier === 'EVO1') continue;

    // The option name is the first bolded phrase of the row. Apostrophes are allowed inside
    // ("Templar's Wrath"): excluding them made the match fall through to the first bullet's
    // number, which is how "EVO2: +150" ended up in the data.
    // The name is the cell text right before the perk's icon; not every page bolds it (Burston's
    // "Ready Retaliation" is plain, and the first bold text there is "+100%" in its bullet).
    const iconCell = /\|([^|\n]*?)\[\[File:([^|\]]+)/.exec(row);
    const nameMatch = iconCell && clean(iconCell[1]) ? { index: iconCell.index, 1: iconCell[1] } : /'''(.{2,60}?)'''/.exec(row);
    if (!nameMatch) continue;
    const name = clean(nameMatch[1]);
    if (!name || /Evolution Challenge|Incarnon Form$/i.test(name)) continue;

    const bullets = row
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('*'))
      .map((line) => clean(line.replace(/^\*+\s*/, '')))
      .filter(Boolean);

    const effects: IncarnonOption['effects'] = [];
    for (const bullet of bullets) {
      // A bullet can hold several stats: "Increase Base Damage by +51."
      for (const sentence of bullet.split(/\.\s+|,\s+(?=[+-]?\d)/)) {
        // Swift Punishment's sprint-speed gate is met by the perk itself (wiki), so it is dropped.
        const text = sentence.replace(/^with sprint speed [\d.]+ or higher:\s*/i, '').replace(/^increase |^gain |^adds? /i, '').trim();
        const perStatusType = /\bper status type\b/i.test(text);
        // Two shapes exist: "+60% Damage" and "Increase Base Damage by +51".
        const byMatch = /^(.*?)\s+by\s+([+-]?\d+(?:[.,]\d+)?)\s*(%|x)?/i.exec(text);
        const number = byMatch
          ? { value: Number(byMatch[2].replace(',', '.')), unit: (byMatch[3]?.toLowerCase() as '%' | 'x' | undefined) ?? null, rest: byMatch[1] }
          : readNumber(text);
        if (!number) continue;
        const mapped = mapTarget(
          number.rest
            .replace(/\bon last shot in magazine\b/i, '')
            .replace(/\bbase\b/i, '')
            .replace(/\s*per status type affecting the target\.?$/i, '')
            .replace(/\s+/g, ' ')
            .trim(),
        );
        if (!mapped) continue;
        const unit = number.unit;
        effects.push({
          target: mapped.target,
          element: mapped.element,
          faction: mapped.faction,
          op: mapped.op,
          value: unit === '%' ? number.value / 100 : unit === 'x' ? number.value - 1 : number.value,
          raw: sentence.trim(),
          ...(unit === null ? { flat: true } : {}),
          ...(perStatusType ? { perStatusType: true } : {}),
        });
      }
    }

    // The icon follows the bolded name: '''Critical Parallel''' [[File:IncarnonCritChanceCritDamage.png|64px|center]]
    const imageMatch = iconCell ? [iconCell[0], iconCell[2]] : /\[\[File:([^|\]]+)/.exec(row.slice(nameMatch.index));
    const image = imageMatch ? imageMatch[1].trim().replace(/ /g, '_') : undefined;
    if (bullets.length) options.push({ tier, name, ...(image ? { image } : {}), effects, text: bullets });
  }
  return options;
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

    const options = parseEvolutions(wikitext);
    if (options.length) {
      out[weapon] = options;
      console.log(`${weapon.padEnd(22)} ${options.length} option(s), ${options.reduce((n, o) => n + o.effects.length, 0)} parsed effect(s)`);
    } else {
      missing++;
    }
    await new Promise((resolve) => setTimeout(resolve, 120)); // be polite to the wiki
  }

  await writeFile(OUT_JSON, JSON.stringify(out, null, 2) + '\n');
  console.log(`\n${Object.keys(out).length} weapon(s) with evolutions -> data/raw/incarnon-stats.json (${missing} without data)`);
}

await main();
