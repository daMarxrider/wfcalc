/**
 * Agent answer eval.
 *
 * These are the questions an agent actually gets, run through the CLI, with the answers
 * pinned. It is not an LLM eval: it guards the contract an agent depends on — the brief line,
 * the numbers a player will be told, the error shape, and the output size that keeps this
 * cheaper than an MCP round-trip.
 *
 * When the snapshot changes on purpose (a new game update), re-run this and update GOLDEN
 * where the game changed. A diff here is a promise to the player being broken.
 *
 * Run: npm run eval
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/wfcalc', import.meta.url));

const GOLDEN = {
  // Damage 3.0 (Update 36): Grineer takes +50% Impact/Corrosive and nothing from the old
  // Alloy Armor table, so the best build is now a Slash/status one, not the Viral one.
  // Since Hunter Munitions is searchable (category-wide "Primary" mods) and status ticks inherit
  // the crit multiplier (wiki: Damage_over_Time), crit-fed Bleed dominates against 2700 armour.
  somaSearchTtk: '3.77s',
  somaSearchDps: '31,408.2 dps',
  brammaTotal: 'total 213.5 dps with status',
  brammaTtk: 'ttk 554.84s',
  somaStrippedTtk: 'ttk 161.22s',
  avalancheCast: '3,000 at 200%',
  ceramicIncarnonHit: 1540,
  eximusOverguard: '281,865',
  miasmaCast: '180/cast',
  shurikenStatus: '+1,577.1 status',
};

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

const run = (args: string[], input?: string): Run =>
  spawnSync(BIN, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, input, stdio: ['pipe', 'pipe', 'pipe'] });

class Failure extends Error {}

const check = (condition: unknown, message: string): void => {
  if (!condition) throw new Failure(message);
};
const contains = (text: string, needle: string): void =>
  check(text.includes(needle), `expected ${JSON.stringify(needle)} in:\n${text.trim()}`);

interface Case {
  name: string;
  question: string;
  run: () => void;
}

const cases: Case[] = [
  {
    name: 'best build',
    question: 'What should I put on a Soma Prime for a level 150 Bombard?',
    run: () => {
      const result = run(['search', 'Soma Prime', '--enemy', 'Bombard', '--level', '150', '--top', '1', '--brief']);
      check(result.status === 0, `exit ${result.status}: ${result.stderr}`);
      contains(result.stdout, `1. ${GOLDEN.somaSearchTtk}`);
      contains(result.stdout, GOLDEN.somaSearchDps);
      contains(result.stdout, 'Serration R10');
      contains(result.stdout, 'Hunter Munitions R5');
      contains(result.stdout, 'assumptions:');
      // The token promise: the whole answer is cheaper than one JSON dump.
      check(result.stdout.length < 1600, `brief search is ${result.stdout.length} chars, expected < 1600`);
    },
  },
  {
    name: 'judge a build',
    question: 'Is a Serration-only Kuva Bramma good against a level 150 Bombard?',
    run: () => {
      const result = run(['calc', 'Kuva Bramma', '--mod', 'Serration', '--enemy', 'Bombard', '--level', '150', '--brief']);
      check(result.status === 0, `exit ${result.status}: ${result.stderr}`);
      contains(result.stdout, GOLDEN.brammaTotal);
      contains(result.stdout, GOLDEN.brammaTtk);
      check(result.stdout.length < 400, `brief calc is ${result.stdout.length} chars, expected < 400`);
    },
  },
  {
    name: 'armour strip changes the answer',
    question: 'They run Avalanche at 200% strength. Does it matter?',
    run: () => {
      const result = run([
        'calc', 'Soma Prime', '--mod', 'Serration', '--strip-from', 'Avalanche', '--strength', '200',
        '--enemy', 'Bombard', '--level', '150', '--brief',
      ]);
      check(result.status === 0, `exit ${result.status}: ${result.stderr}`);
      contains(result.stdout, GOLDEN.somaStrippedTtk);
      contains(result.stdout, 'armour 0');
      // The same build without the strip must be much slower: the model must price it.
      const bare = run(['calc', 'Soma Prime', '--mod', 'Serration', '--enemy', 'Bombard', '--level', '150', '--brief']);
      const ttk = (line: string) => Number(/ttk ([\d,.]+)s/.exec(line)![1].replace(/,/g, ''));
      check(ttk(result.stdout) < ttk(bare.stdout) / 3, `strip should more than triple the dps: ${result.stdout} vs ${bare.stdout}`);
    },
  },
  {
    name: 'melee Incarnon and Condition Overload',
    question: 'Ceramic Dagger Incarnon with Pressure Point and Condition Overload, three statuses?',
    run: () => {
      const result = run([
        'calc', 'Ceramic Dagger', '--mod', 'Pressure Point', '--mod', 'Condition Overload', '--status-types', '3',
        '--incarnon', 'form', '--enemy', 'Bombard', '--level', '150', '--json',
      ]);
      check(result.status === 0, `exit ${result.status}: ${result.stderr}`);
      const payload = JSON.parse(result.stdout) as {
        projectileTotal: number;
        inactiveConditions: string[];
        warnings: string[];
      };
      check(Math.abs(payload.projectileTotal - GOLDEN.ceramicIncarnonHit) < 1e-6,
        `expected the spectral hit at ${GOLDEN.ceramicIncarnonHit}, got ${payload.projectileTotal}`);
      check(payload.inactiveConditions.some((line) => /spectral hits ignore melee damage/.test(line)),
        'Pressure Point must be reported as ignored on a spectral hit');
      check(payload.warnings.length === 0, `unexpected warnings: ${payload.warnings.join(', ')}`);
    },
  },
  {
    name: 'ability strip',
    question: 'How much armour does Avalanche remove at 200% strength?',
    run: () => {
      const result = run(['ability', 'Avalanche', '--strength', '200', '--brief']);
      check(result.status === 0, `exit ${result.status}: ${result.stderr}`);
      contains(result.stdout, GOLDEN.avalancheCast);
      contains(result.stdout, 'strip 100%');
    },
  },
  {
    name: 'answer-only brief',
    question: 'Same Bramma question, assumptions already known.',
    run: () => {
      const result = run(['calc', 'Kuva Bramma', '--mod', 'Serration', '--enemy', 'Bombard', '--level', '150', '--brief=answer']);
      check(result.status === 0, `exit ${result.status}: ${result.stderr}`);
      const lines = result.stdout.trim().split('\n');
      check(lines.length === 1, `expected one line, got ${lines.length}`);
      for (const word of ['burst', 'sustained', 'armour']) {
        check(!lines[0].includes(word), `answer mode should omit ${word}: ${lines[0]}`);
      }
      contains(result.stdout, GOLDEN.brammaTtk);
    },
  },
  {
    name: 'unknown name fails cleanly',
    question: 'A typo must be fixable, not a stack trace.',
    run: () => {
      const result = run(['calc', 'NoSuchWeapon', '--json']);
      check(result.status === 2, `expected exit 2, got ${result.status}`);
      check(result.stdout.trim() === '', `stdout should be empty, got ${result.stdout}`);
      const payload = JSON.parse(result.stderr) as { error: { code: string } };
      check(payload.error.code === 'weapon_not_found', `unexpected code ${payload.error.code}`);
      check(!/file:|\bat .*\.ts/.test(result.stderr), 'no stack trace for an expected failure');
    },
  },
  {
    name: 'Eximus Overguard',
    question: 'Does the answer include an Eximus overguard layer?',
    run: () => {
      const result = run(['calc', 'Soma Prime', '--mod', 'Serration', '--eximus', '--enemy', 'Bombard', '--level', '150', '--brief']);
      check(result.status === 0, `exit ${result.status}: ${result.stderr}`);
      contains(result.stdout, `overguard ${GOLDEN.eximusOverguard}`);
      const bare = run(['calc', 'Soma Prime', '--mod', 'Serration', '--enemy', 'Bombard', '--level', '150', '--brief']);
      const ttk = (line: string) => Number(/ttk ([\d,.]+)s/.exec(line)![1].replace(/,/g, ''));
      check(ttk(result.stdout) > ttk(bare.stdout), `Overguard must cost time: ${result.stdout} vs ${bare.stdout}`);
    },
  },
  {
    name: 'ability statuses',
    question: 'Does Miasma apply Viral, and does Shuriken apply Bleed?',
    run: () => {
      const miasma = run(['ability', 'Miasma', '--strength', '100', '--enemy', 'Bombard', '--level', '150', '--brief']);
      check(miasma.status === 0, `exit ${miasma.status}: ${miasma.stderr}`);
      contains(miasma.stdout, GOLDEN.miasmaCast);
      contains(miasma.stdout, '1 viral');
      const shuriken = run(['ability', 'Shuriken', '--strength', '100', '--enemy', 'Bombard', '--level', '150', '--brief']);
      contains(shuriken.stdout, GOLDEN.shurikenStatus);
    },
  },
  {
    name: 'ability shields',
    question: 'Does an ability answer account for Corpus shields?',
    run: () => {
      const result = run(['ability', 'Avalanche', '--strength', '200', '--enemy', 'Corpus Tech', '--level', '150', '--brief']);
      check(result.status === 0, `exit ${result.status}: ${result.stderr}`);
      contains(result.stdout, 'shields 3,000/cast');
      contains(result.stdout, '58 casts');
    },
  },
  {
    name: 'boss attenuation',
    question: 'Does an Eidolon answer cap damage, and can it be turned off?',
    run: () => {
      const result = run(['calc', 'Rubico Prime', '--mod', 'Serration', '--enemy', 'Eidolon Teralyst', '--level', '30', '--brief']);
      check(result.status === 0, `exit ${result.status}: ${result.stderr}`);
      contains(result.stdout, 'attenuation eidolon');
      const off = run(['calc', 'Rubico Prime', '--mod', 'Serration', '--enemy', 'Eidolon Teralyst', '--level', '30', '--attenuation', 'none', '--brief']);
      check(!off.stdout.includes('attenuation'), `--attenuation none must suppress it: ${off.stdout}`);
    },
  },
  {
    name: 'partial mods are a lower bound',
    question: 'Spectral Serration on a Soma Prime: is the number exact?',
    run: () => {
      const result = run(['calc', 'Soma Prime', '--mod', 'Spectral Serration', '--enemy', 'Bombard', '--level', '150', '--brief']);
      check(result.status === 0, `exit ${result.status}: ${result.stderr}`);
      contains(result.stdout, 'lower bound');
      contains(result.stdout, 'warning(s)');
    },
  },
  {
    name: 'batch',
    question: 'Price three setups in one process.',
    run: () => {
      const input = [
        JSON.stringify({ label: 'bramma', weapon: 'Kuva Bramma', mods: [{ name: 'Serration' }], enemy: 'Bombard', level: 150 }),
        JSON.stringify({ label: 'dagger', weapon: 'Ceramic Dagger', mods: [{ name: 'Pressure Point' }], incarnon: ['form'], enemy: 'Bombard', level: 150 }),
        JSON.stringify({ label: 'avalanche', ability: 'Avalanche', strength: 200 }),
      ].join('\n');
      const result = run(['batch', '--json'], input);
      check(result.status === 0, `exit ${result.status}: ${result.stderr}`);
      const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
      check(lines.length === 3, `expected 3 lines, got ${lines.length}`);
      check(lines[0].label === 'bramma' && lines[0].totalDps === 213.5, `bad bramma line: ${JSON.stringify(lines[0])}`);
      check(lines[1].armor === 2700 && typeof lines[1].timeToKill === 'number', `bad dagger line: ${JSON.stringify(lines[1])}`);
      check(lines[2].ability === 'Avalanche' && lines[2].armorStrip.fraction === 1, `bad ability line: ${JSON.stringify(lines[2])}`);
    },
  },
  {
    name: 'batch reports a bad record without aborting',
    question: 'One typo in a batch must not cost the other answers.',
    run: () => {
      const input = [
        JSON.stringify({ label: 'ok', weapon: 'Kuva Bramma', mods: [{ name: 'Serration' }], enemy: 'Bombard', level: 150 }),
        JSON.stringify({ label: 'typo', weapon: 'NoSuchWeapon', enemy: 'Bombard', level: 150 }),
      ].join('\n');
      const result = run(['batch'], input);
      check(result.status === 1, `expected exit 1 when a record failed, got ${result.status}`);
      contains(result.stdout, 'ok: Kuva Bramma vs Bombard 150');
      contains(result.stdout, 'typo: error: weapon not found: NoSuchWeapon');
    },
  },
];

let failed = 0;
for (const entry of cases) {
  try {
    entry.run();
    console.log(`PASS  ${entry.name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${entry.name}`);
    console.log(`      ${entry.question}`);
    console.log(`      ${(error as Error).message.replace(/\n/g, '\n      ')}`);
  }
}

console.log(`\n${cases.length - failed}/${cases.length} agent cases pass`);
process.exitCode = failed ? 1 : 0;
