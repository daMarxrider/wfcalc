/**
 * Weapon trait survey: what each weapon does beyond its stats, from its wiki page, for the
 * curated tables in src/engine/traits.ts and src/engine/ammo.ts.
 *
 * Downloads the raw page of every snapshot weapon into data/raw/weapon-pages/, then pulls the
 * bullets of its Characteristics and Notes sections that describe an effect, in two passes:
 *   1. trigger words: on headshot/kill/hit, chance, stacks, buff, signature ("when wielded by"),
 *      spool, ramps up, increases damage/crit/status/fire rate...
 *   2. a number (12%, x2) together with a verb (grants, gains, increases, while, per, every...),
 *      which catches traits worded without the trigger words (Coda Bassocyst's Mercy kill buff).
 * Utility lines (pinning corpses, stagger, polarities, Kuva/Tenet boilerplate) are dropped.
 * Every line still needs a human read: this finds candidates, it does not decide.
 *
 *   node tools/survey-weapon-traits.ts            fetch missing pages, write the candidates
 *   node tools/survey-weapon-traits.ts --force    re-download every page (after a game update)
 *   node tools/survey-weapon-traits.ts --new      print only weapons whose lines changed since the last review
 *   node tools/survey-weapon-traits.ts --reviewed record the current lines as reviewed
 *
 * Output: data/raw/weapon-trait-candidates.json ({ weapon: [lines] }). The review record,
 * data/weapon-trait-review.json, keeps a fingerprint of each weapon's lines as they were when a
 * human last read them (first review: 2026-10-28, every weapon), so after a game update `--new`
 * shows only new weapons and changed text.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PAGES = join(ROOT, 'data/raw/weapon-pages');
const OUT = join(ROOT, 'data/raw/weapon-trait-candidates.json');
const force = process.argv.includes('--force');
const onlyNew = process.argv.includes('--new');
const markReviewed = process.argv.includes('--reviewed');
const REVIEW = join(ROOT, 'data/weapon-trait-review.json');

/** Wiki titles that differ from the snapshot name in more than spaces. */
const TITLES: Record<string, string> = { 'Ax-52': 'AX-52', 'Efv-5 Jupiter': 'EFV-5_Jupiter', 'Efv-8 Mars': 'EFV-8_Mars' };
const fileOf = (name: string): string => join(PAGES, `${name.replace(/[^A-Za-z0-9_.'()-]+/g, '_')}.wiki`);

async function download(names: string[]): Promise<string[]> {
  mkdirSync(PAGES, { recursive: true });
  const queue = names.filter((name) => force || !existsSync(fileOf(name)));
  const missing: string[] = [];
  // Three at a time, 400 ms apart: about four minutes for every weapon, gentle on the wiki.
  const worker = async (): Promise<void> => {
    for (let name = queue.shift(); name; name = queue.shift()) {
      const title = TITLES[name] ?? name.replace(/ /g, '_');
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(`https://wiki.warframe.com/w/${encodeURIComponent(title)}?action=raw`, {
            headers: { 'user-agent': 'wfcalc/0.1 (personal damage calculator; weapon trait survey)' },
          });
          if (response.ok) { writeFileSync(fileOf(name), await response.text()); break; }
          if (response.status === 404) { missing.push(name); break; }
        } catch { /* network hiccup: retry */ }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return missing;
}

const TRIGGER = /(when (wielded|used|equipped) by|signature|in the hands of|on (weak ?point|head ?shot)|head ?shot kills?|weak ?point (hit|kill)s?|\bon kill|chance (to|for)|stacks? up to|\bbuff\b|consecutive|spool|ramps? up|bonus (damage|critical|status|fire)|increas\w* (its |the )?(damage|critical|crit|status|fire rate|multishot|attack speed)|damage multiplier|final (critical|crit|status|damage)|guaranteed (critical|crit)|instantly reload|refill|potency)/i;
const NUMBER = /([+-]?\d+(\.\d+)?\s?%|\b\d+(\.\d+)?x\b|x\s?\d+(\.\d+)?\b)/;
const VERB = /\b(grants?|gains?|increas\w*|bonus|chance|while|when|after|on (hit|kill|status|reload|headshot|mercy|finisher|block|slide|heavy)|per|every|stacks?|set to|doubl\w*|multipl\w*|potency)\b/i;
const UTILITY = /(pin(s|ning)? (the )?(corpse|bod)|bodies will follow|self-stagger|polariz|polarit|elemental vice|valence fusion|kuva lich|sister of parvos|progenitor|25%-60%|zoom|holster|ammo pickup|ammo max|riven|disposition|blueprint|\bconclave\b|codex|syndicate standing|falloff|punch ?through|accuracy|recoil|spread|projectile speed|travel time|line of sight|headshot multiplier of 1x|movement speed)/i;

const clean = (line: string): string => line
  .replace(/<ref>.*?<\/ref>/g, '')
  .replace(/\{\{(?:D|M|A|WF|Weapon|Arcane|Pol|Resource|Stat|Focus|Faction|E|Text|Ability)\|([^}|]*)(?:\|[^}]*)?\}\}/g, '$1')
  .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
  .replace(/'''?/g, '').replace(/<[^>]+>/g, '').replace(/\{\{[^}]*\}\}/g, '')
  .replace(/\s+/g, ' ').trim();

export function traitCandidates(wikitext: string): string[] {
  const lines: string[] = [];
  for (const section of wikitext.matchAll(/^==\s*(Characteristics|Notes)\s*==\s*$([\s\S]*?)(?=^==[^=]|(?![\s\S]))/gm)) {
    for (const raw of section[2].split('\n')) {
      if (!raw.startsWith('*')) continue;
      const line = clean(raw.replace(/^\*+/, ''));
      if (line.length < 15 || UTILITY.test(line) || lines.includes(line)) continue;
      if (TRIGGER.test(line) || (NUMBER.test(line) && VERB.test(line))) lines.push(line);
    }
  }
  return lines;
}

const snapshot = JSON.parse(readFileSync(join(ROOT, 'data/snapshot.json'), 'utf8')) as { weapons: Record<string, unknown> };
const names = Object.keys(snapshot.weapons);
const missing = await download(names);
const out: Record<string, string[]> = {};
for (const name of names) {
  if (!existsSync(fileOf(name))) continue;
  const lines = traitCandidates(readFileSync(fileOf(name), 'utf8'));
  if (lines.length) out[name] = lines;
}
writeFileSync(OUT, JSON.stringify(out, null, 1));

const fingerprint = (lines: string[]): string => createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 12);
const review = existsSync(REVIEW) ? JSON.parse(readFileSync(REVIEW, 'utf8')) as Record<string, string> : {};
const changed = Object.keys(out).filter((name) => review[name] !== fingerprint(out[name]));
if (markReviewed) {
  writeFileSync(REVIEW, JSON.stringify(Object.fromEntries(Object.keys(out).sort().map((name) => [name, fingerprint(out[name])])), null, 1) + '\n');
}
// Which of them the curated tables already name: a hint, not a verdict (most are left out on purpose).
const curated = ['src/engine/traits.ts', 'src/engine/ammo.ts'].map((file) => readFileSync(join(ROOT, file), 'utf8')).join('\n');
const covered = (name: string): boolean => curated.includes(`'${name}'`) || new RegExp(`^\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`, 'm').test(curated);
for (const name of onlyNew ? changed : Object.keys(out)) {
  console.log(`## ${name}${review[name] ? (changed.includes(name) ? '  (changed since review)' : '') : '  (new)'}${covered(name) ? '  [in traits.ts/ammo.ts]' : ''}`);
  for (const line of out[name]) console.log(`  - ${line.slice(0, 220)}`);
}
console.log(`\n${readdirSync(PAGES).length} pages, ${Object.keys(out).length} weapons with candidates (${Object.values(out).reduce((sum, lines) => sum + lines.length, 0)} lines), `
  + `${changed.length} new or changed since the last review${markReviewed ? ' (now recorded as reviewed)' : ''}${missing.length ? `; no page: ${missing.join(', ')}` : ''} -> data/raw/weapon-trait-candidates.json`);
