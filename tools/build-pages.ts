#!/usr/bin/env node
/**
 * Builds the GitHub Pages version into dist/ (or --out <dir>): the web UI at the root, the engine
 * with its types stripped by Node's own stripper (no dependencies), node: imports pointed at the
 * browser shims in src/pages/shims/, and the snapshot. Only files reachable from the two worker
 * entries are built, so a new node: import in the engine fails here instead of in the browser.
 *
 *   node tools/build-pages.ts [--out dist] [--art]   (--art: download artwork missing from data/img, data/cards)
 */
import { stripTypeScriptTypes } from 'node:module';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const outArg = process.argv.indexOf('--out');
const OUT = outArg >= 0 ? process.argv[outArg + 1] : join(ROOT, 'dist');
const SHIMS: Record<string, string> = {
  'node:fs': 'src/pages/shims/fs.js',
  'node:os': 'src/pages/shims/os.js',
  'node:path': 'src/pages/shims/path.js',
  'node:worker_threads': 'src/pages/shims/worker_threads.js',
};
const ENTRIES = ['src/pages/api-worker.ts', 'src/engine/bruteforce-worker.ts', ...Object.values(SHIMS)];

const write = (file: string, content: string | Buffer): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
};

rmSync(OUT, { recursive: true, force: true });

// The engine: every module the workers import, as .js with relative specifiers.
const built = new Set<string>();
const queue = [...ENTRIES];
while (queue.length) {
  const file = queue.pop()!;
  if (built.has(file)) continue;
  built.add(file);
  const source = readFileSync(join(ROOT, file), 'utf8');
  const code = file.endsWith('.ts') ? stripTypeScriptTypes(source, { mode: 'strip' }) : source;
  const linked = code.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|new URL\(\s*)(['"])([^'"]+)\2/g, (match, lead, quote, spec: string) => {
    if (spec.startsWith('node:')) {
      const shim = SHIMS[spec];
      if (!shim) throw new Error(`${file}: no browser shim for ${spec} (add one to src/pages/shims/ and SHIMS)`);
      const path = relative(dirname(file), shim);
      return `${lead}${quote}${path.startsWith('.') ? path : `./${path}`}${quote}`;
    }
    if (!spec.startsWith('.') || !/\.(ts|js)$/.test(spec)) return match;
    queue.push(join(dirname(file), spec));
    return `${lead}${quote}${spec.replace(/\.ts$/, '.js')}${quote}`;
  });
  write(join(OUT, file.replace(/\.ts$/, '.js')), linked);
}

// The UI at the root, with the API rerouted to the worker before app.js runs.
for (const name of readdirSync(join(ROOT, 'src/web'))) {
  if (name.endsWith('.d.ts')) continue;
  let content: string | Buffer = readFileSync(join(ROOT, 'src/web', name));
  if (name === 'index.html') {
    const html = content.toString('utf8');
    const app = '<script type="module" src="app.js"></script>';
    if (!html.includes(app)) throw new Error('index.html: app.js script tag not found');
    content = html.replace(app, `<script type="module" src="src/pages/pages.js"></script>\n${app}`);
  }
  write(join(OUT, name), content);
}
cpSync(join(ROOT, 'src/pages/pages.js'), join(OUT, 'src/pages/pages.js'));
cpSync(join(ROOT, 'data/snapshot.json'), join(OUT, 'data/snapshot.json'));

// Artwork ships with the site (GDPR: no visitor IP goes to the wiki or raw.githubusercontent.com).
// Same caches and upstreams as src/server.ts; --art downloads what the cache is missing.
const snapshot = JSON.parse(readFileSync(join(ROOT, 'data/snapshot.json'), 'utf8'));
const imgs = new Set<string>();
const cards = new Set<string>();
for (const mod of Object.values<any>(snapshot.mods)) {
  if (mod.image) imgs.add(mod.image);
  if (mod.cardImage) cards.add(mod.cardImage);
}
// Exalted weapon art is a wiki file (app.js shows it through cardUrl), like the Incarnon perk icons.
for (const weapon of Object.values<any>(snapshot.weapons)) if (weapon.image) (weapon.exalted ? cards : imgs).add(weapon.image);
for (const options of Object.values<any>(snapshot.incarnons)) for (const option of options) if (option.image) cards.add(option.image);

const ART = [
  { dir: 'img', files: imgs, url: (file: string) => `https://raw.githubusercontent.com/WFCD/warframe-items/master/data/img/${file}` },
  { dir: 'card', cache: 'cards', files: cards, url: (file: string) => `https://wiki.warframe.com/w/Special:FilePath/${encodeURIComponent(file)}?width=220` },
];
const missing: string[] = [];
for (const { dir, cache = dir, files, url } of ART) {
  const queue = [...files].filter((file) => /^[A-Za-z0-9._'()&\x20-]+\.(png|jpe?g|webp|gif)$/i.test(file));
  mkdirSync(join(ROOT, 'data', cache), { recursive: true });
  const fetchOne = async (file: string): Promise<void> => {
    const cached = join(ROOT, 'data', cache, file);
    if (!existsSync(cached)) {
      if (!process.argv.includes('--art')) return void missing.push(`${dir}/${file}`);
      for (let attempt = 1; ; attempt++) {
        const reply = await fetch(url(file), { headers: { 'user-agent': 'wfcalc/0.1 (static site build)' } });
        if (reply.ok) { writeFileSync(cached, Buffer.from(await reply.arrayBuffer())); break; }
        if (reply.status === 404) return void missing.push(`${dir}/${file}`);
        // Rate limits and server errors: back off, then fail the build rather than ship holes.
        if (attempt === 4) throw new Error(`${url(file)}: HTTP ${reply.status}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    cpSync(cached, join(OUT, dir, file));
  };
  // A few requests at a time: the wiki is a community server.
  await Promise.all(Array.from({ length: 4 }, async () => { for (let file; (file = queue.pop());) await fetchOne(file); }));
}
if (missing.length) console.warn(`Artwork missing (${missing.length}${process.argv.includes('--art') ? ', 404 upstream' : ', run with --art'}): ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''}`);
// No Jekyll on GitHub Pages: the files are served as they are.
write(join(OUT, '.nojekyll'), '');

console.log(`GitHub Pages build: ${built.size} modules, UI and snapshot in ${relative(process.cwd(), OUT) || '.'}`);
