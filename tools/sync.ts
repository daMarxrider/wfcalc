/**
 * Weekly sync: only re-download when an upstream actually changed, then rebuild, verify
 * and reconcile.
 *
 *   node tools/sync.ts --check     report freshness, touch nothing
 *   node tools/sync.ts             fetch + rebuild + validate + calibrate, write a log
 *   node tools/sync.ts --force     ignore the change check
 *
 * Why not just re-download everything weekly: the sources are ~12 MB and the wiki pages
 * are stable for months. This uses cheap change detection instead —
 *  - GitHub API for the WFCD export (last commit touching the data directory),
 *  - ETag/If-None-Match for every wiki page.
 *
 * The sync also keeps a record: docs/sync-log.md gets one entry per run with what changed
 * and how the calibration moved, so a regression can be traced to a specific week.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WIKI_PAGE_SOURCES, WIKI_CATEGORY_SOURCES } from './sources.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const STATE_FILE = join(ROOT, 'data/raw/.upstream-state.json');
const LOG_FILE = join(ROOT, 'docs/sync-log.md');

/** Run after every rebuild, in this order (package.json "update" runs the same list). */
const PATCH_TOOLS = ['public-export.ts', 'fetch-compression.ts', 'fetch-snipers.ts', 'fetch-forced-procs.ts'];

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const force = args.includes('--force');

interface UpstreamState {
  /** Last commit sha + date seen on the WFCD export repository. */
  wfcd?: { sha: string; date: string };
  /** URL -> Last-Modified for wiki pages (the wiki sends no ETag). */
  lastModified?: Record<string, string>;
  /** Category label -> hash of its member list. The API sends no Last-Modified, so without
   *  this every category looked changed on every run and forced a full re-download. */
  categoryHashes?: Record<string, string>;
}

const state: UpstreamState = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};


/**
 * Wiki categories this project depends on, read through the MediaWiki API. The Exilus one is
 * the only source saying which mods are Exilus-only; WFCD has no such flag.
 */
const WIKI_CATEGORIES = WIKI_CATEGORY_SOURCES.map(([category]) => category);

/**
 * Wiki pages and modules this project depends on. The downloaded ones come from the shared
 * source list, so a page that fetch.ts reads is always watched here. The rest document formulas
 * or curated data: a change there means "read it and check the engine by hand".
 */
const WIKI_PAGES = [
  ...WIKI_PAGE_SOURCES.map(([page]) => page),
  'Module:Ability/data',
  'Armor',
  'Damage_over_Time',
  'Status_Effect',
  'Set_Mods',
  'Umbral_Set',
  'Sacrificial_Set',
  'Vigilante_Set',
  'Gladiator_Set',
  'Reservoir',
  'Covenant',
  'Roar',
  'Eclipse',
  'Vex_Armor',
];

async function wfcdHead(): Promise<{ sha: string; date: string }> {
  const response = await fetch(
    'https://api.github.com/repos/WFCD/warframe-items/commits?path=data/json&per_page=1',
    { headers: { 'user-agent': 'wfcalc-sync', accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) },
  );
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);
  const commits: any = await response.json();
  const latest = commits[0];
  if (!latest) throw new Error('no commits found');
  return { sha: latest.sha, date: latest.commit?.committer?.date ?? '' };
}

/**
 * Reports which wiki pages changed. The wiki sends no ETag, but it does send Last-Modified
 * and honours If-Modified-Since with a 304, so unchanged pages cost a round trip and
 * nothing more.
 */
function categoryUrl(category: string): string {
  const url = new URL('https://wiki.warframe.com/api.php');
  url.searchParams.set('action', 'query');
  url.searchParams.set('list', 'categorymembers');
  url.searchParams.set('cmtitle', `Category:${category}`);
  url.searchParams.set('cmlimit', '500');
  url.searchParams.set('format', 'json');
  return url.toString();
}

async function changedWikiPages(): Promise<{
  changed: string[];
  lastModified: Record<string, string>;
  categoryHashes: Record<string, string>;
}> {
  const lastModified: Record<string, string> = { ...(state.lastModified ?? {}) };
  const categoryHashes: Record<string, string> = { ...(state.categoryHashes ?? {}) };
  const changed: string[] = [];
  const targets: Array<{ label: string; url: string; category?: string }> = [
    ...WIKI_PAGES.map((page) => ({
      label: page,
      url: `https://wiki.warframe.com/w/${encodeURIComponent(page).replace(/%2F/g, '/')}?action=raw`,
    })),
    ...WIKI_CATEGORIES.map((category) => ({ label: `Category:${category}`, url: categoryUrl(category), category })),
  ];
  await Promise.all(
    targets.map(async ({ label, url, category }) => {
      const headers: Record<string, string> = { 'user-agent': 'wfcalc-sync' };
      try {
        if (category) {
          // A category is a query, not a page: no Last-Modified, no 304. Hash its sorted member
          // list instead, which costs a few KB and stays stable while the category does.
          const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
          if (!response.ok) {
            changed.push(label);
            return;
          }
          const body = (await response.json()) as { query?: { categorymembers?: Array<{ title: string }> } };
          const titles = (body.query?.categorymembers ?? []).map((member) => member.title).sort();
          const hash = createHash('sha256').update(titles.join('\n')).digest('hex');
          if (!force && state.categoryHashes?.[label] === hash) return;
          categoryHashes[label] = hash;
          changed.push(label);
          return;
        }
        const known = state.lastModified?.[url];
        if (known && !force) headers['if-modified-since'] = known;
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
        if (response.status === 304) return;
        if (!response.ok) {
          changed.push(label);
          return;
        }
        const stamp = response.headers.get('last-modified');
        if (stamp) lastModified[url] = stamp;
        changed.push(label);
      } catch {
        changed.push(label);
      }
    }),
  );
  return { changed: changed.sort(), lastModified, categoryHashes };
}

function run(script: string, extra: string[] = []): void {
  execFileSync('node', [join(ROOT, 'tools', script), ...extra], { cwd: ROOT, stdio: 'inherit' });
}

/** Calibration score, parsed from the tool's output. */
function calibrateSample(count: number): { matched: number; total: number; failing: string[] } {
  // A calibration run exits non-zero while any build mismatches, and execFileSync throws on
  // a non-zero exit: capture stdout from the error instead of treating it as a crash.
  let output = '';
  try {
    output = execFileSync('node', [join(ROOT, 'tools/calibrate.ts'), '--battery', String(count)], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  } catch (error) {
    output = String((error as any).stdout ?? '');
  }
  const match = /matched: (\d+)\/(\d+)/.exec(output);
  const failing = [...new Set([...output.matchAll(/^  (\d+) ([^:]+): /gm)].map((entry) => `${entry[1]} ${entry[2]}`))];
  return { matched: match ? Number(match[1]) : 0, total: match ? Number(match[2]) : 0, failing };
}

async function main(): Promise<void> {
  mkdirSync(join(ROOT, 'data/raw'), { recursive: true });

  const outgoing: UpstreamState = { lastModified: state.lastModified, categoryHashes: state.categoryHashes };
  let upstreamChanged = false;

  console.log('checking upstreams…');
  try {
    const head = await wfcdHead();
    outgoing.wfcd = head;
    if (state.wfcd?.sha !== head.sha) {
      upstreamChanged = true;
      console.log(`  WFCD export changed: ${state.wfcd?.sha?.slice(0, 8) ?? '(none)'} -> ${head.sha.slice(0, 8)} (${head.date})`);
    } else {
      console.log(`  WFCD export unchanged (${head.sha.slice(0, 8)})`);
    }
  } catch (error) {
    console.log(`  WFCD check failed: ${String(error)}`);
  }

  const wiki = await changedWikiPages();
  outgoing.lastModified = wiki.lastModified;
  outgoing.categoryHashes = wiki.categoryHashes;
  if (wiki.changed.length) {
    upstreamChanged = true;
    console.log(`  ${wiki.changed.length} wiki page(s) changed or new:`);
    for (const page of wiki.changed.slice(0, 10)) console.log(`    ${page}`);
  } else {
    console.log('  wiki pages unchanged');
  }

  if (checkOnly) {
    console.log(upstreamChanged ? '\nchanges available; run `npm run sync` to apply' : '\nup to date');
    process.exitCode = upstreamChanged ? 0 : 0;
    return;
  }
  if (!upstreamChanged && !force) {
    console.log('\nnothing to do (use --force to rebuild anyway)');
    return;
  }

  console.log('\n1/5 fetching sources…');
  // The fetchers skip files that already exist, so a detected change only reaches data/raw if
  // they are forced. Change detection decides *when* to pay for the download, not *what* to
  // download: this is the one run that has to see the new upstream.
  run('fetch.ts', ['--force']);
  run('fetch-abilities.ts', ['--force']);
  run('fetch-damage-abilities.ts', ['--force']);
  run('fetch-incarnon.ts', ['--force']);
  run('fetch-sets.ts', ['--force']);
  run('fetch-oracle-db.ts');

  console.log('\n2/5 rebuilding the snapshot…');
  run('build-data.ts');
  // build-data writes the snapshot from data/raw only; these patch in what it does not build
  // (DE's own weapon stats, Compression radii, sniper zooms, guaranteed procs). Same order as
  // `npm run update`.
  for (const patch of PATCH_TOOLS) run(patch);

  console.log('\n3/5 invariants…');
  try {
    run('validate.ts');
  } catch {
    console.error('invariants failed — snapshot kept, review before shipping');
    writeFileSync(STATE_FILE, JSON.stringify(outgoing, null, 2) + '\n');
    process.exitCode = 1;
    return;
  }

  console.log('\n4/5 coverage and drift…');
  run('coverage.ts');
  let driftLines: string[] = [];
  try {
    const drift = execFileSync('node', [join(ROOT, 'tools/drift.ts'), '--quiet'], { cwd: ROOT, encoding: 'utf8' });
    driftLines = drift.split('\n').filter((line) => /divergence|weapons where/.test(line));
    for (const line of driftLines) console.log(`  ${line}`);
  } catch (error) {
    // drift.ts exits non-zero when it finds divergences; that is the point.
    const output = String((error as any).stdout ?? '');
    driftLines = output.split('\n').filter((line) => /divergence|weapons where/.test(line));
    for (const line of driftLines) console.log(`  ${line}`);
  }

  console.log('\n5/5 calibration sample…');
  const score = calibrateSample(60);

  writeFileSync(STATE_FILE, JSON.stringify(outgoing, null, 2) + '\n');

  const entry = [
    '',
    `## ${new Date().toISOString().slice(0, 10)}`,
    '',
    `- WFCD export: ${outgoing.wfcd?.sha?.slice(0, 8) ?? '?'} (${outgoing.wfcd?.date ?? '?'})`,
    `- wiki pages changed: ${wiki.changed.length ? wiki.changed.join(', ') : 'none'}`,
    `- calibration sample: **${score.matched}/${score.total}**`,
    ...(driftLines.length ? [`- \`tools/drift.ts\`: ${driftLines.join(' ')}`] : []),
    ...(score.failing.length ? ['- failing builds:', ...score.failing.slice(0, 10).map((line) => `  - ${line}`)] : []),
    '',
  ].join('\n');
  if (!existsSync(LOG_FILE)) writeFileSync(LOG_FILE, '# Sync log\n\nOne entry per run: what changed upstream and how calibration moved.');
  writeFileSync(LOG_FILE, readFileSync(LOG_FILE, 'utf8') + entry);
  console.log(`\nlogged to docs/sync-log.md (calibration ${score.matched}/${score.total})`);
}

await main();
