/**
 * CLI contract tests.
 *
 * An AI agent drives this tool, so the JSON has to be machine-readable and stable: these tests
 * fail if a listing command stops emitting a parseable payload or loses a field an agent needs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/wfcalc', import.meta.url));

const run = (args: string[]): unknown => {
  const out = execFileSync(BIN, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
};

const runRaw = (args: string[], input?: string) =>
  spawnSync(BIN, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, input, stdio: ['pipe', 'pipe', 'pipe'] });

test('listing commands emit parseable JSON', () => {
  const weapons = run(['weapons', 'Soma', '--json']) as Array<{ name: string }>;
  assert.ok(weapons.length > 0);
  assert.ok(weapons.every((w) => typeof w.name === 'string'));

  const mods = run(['mods', 'Soma', '--json']) as { weapon: string; count: number; mods: Array<{ name: string; partial: boolean }> };
  assert.equal(mods.weapon, 'Soma');
  assert.equal(mods.count, mods.mods.length);
  // partial is how an agent knows a number is a lower bound rather than the real value.
  assert.ok(mods.mods.every((m) => typeof m.partial === 'boolean'));

  for (const [command, args] of [
    ['enemies', ['Bombard', '--json']],
    ['arcanes', ['--json']],
    ['buffs', ['--json']],
    ['rivens', ['--json']],
    ['incarnon', ['Torid', '--json']],
  ] as const) {
    const payload = run([command, ...args]);
    assert.ok(payload, `${command} produced nothing`);
  }
});

test('fusion cores and Operator arcanes are not weapon candidates', () => {
  const mods = run(['mods', 'Soma', '--json']) as { mods: Array<{ name: string; classes: string[] }> };
  const junk = mods.mods.filter((m) => /Core$|Transmute Core/.test(m.name) || m.classes.includes('Antique'));
  assert.deepEqual(junk.map((m) => m.name), [], 'candidate list carries non-equippable entries');
});

test('calc reports the time to kill an agent can quote', () => {
  const result = run(['calc', 'Soma', '--mod', 'Serration', '--mod', 'Stormbringer', '--enemy', 'Bombard', '--level', '102', '--json']) as {
    sustainedDps: number;
    timeToKill: number | null;
    warnings: string[];
    unsupportedMods: string[];
  };
  assert.ok(result.sustainedDps > 0);
  assert.ok(result.timeToKill === null || result.timeToKill > 0);
  assert.ok(Array.isArray(result.warnings) && Array.isArray(result.unsupportedMods));
});

test('an unknown weapon fails loudly instead of returning an empty build', () => {
  assert.throws(() => run(['mods', 'NotAWeaponAtAll', '--json']));
});

test('armour strip flags change the answer, and bad values fail loudly', () => {
  const timeToKill = (extra: string[]): number => {
    const result = run(['calc', 'Soma Prime', '--mod', 'Serration', '--enemy', 'Bombard', '--level', '150', '--json', ...extra]) as {
      timeToKill: number | null;
      armor: number;
    };
    return result.timeToKill ?? 0;
  };
  const bare = timeToKill([]);
  const oneCorrosive = timeToKill(['--cp', '1']);
  const fourCorrosive = timeToKill(['--cp', '4']);
  assert.ok(oneCorrosive < bare, 'one Corrosive Projection should help');
  assert.ok(fourCorrosive < oneCorrosive, 'four should help more');
  // Additive strips: Terrify at 60% plus one aura at 18% leaves 22% of the armour.
  assert.ok(timeToKill(['--strip-from', 'Terrify', '--cp', '1']) < timeToKill(['--strip-from', 'Terrify']));
  assert.throws(() => run(['calc', 'Soma Prime', '--cp', '9', '--json']));
});


test('--brief is one compact line for a calculation', () => {
  // The agent default: no per-type tree, no JSON, the numbers that answer the question.
  const result = runRaw(['calc', 'Kuva Bramma', '--mod', 'Serration', '--enemy', 'Bombard', '--level', '150', '--brief']);
  assert.equal(result.status, 0);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `brief should be one line, got:\n${result.stdout}`);
  assert.match(lines[0], /^Kuva Bramma vs Bombard 150 · /);
  assert.match(lines[0], /total [\d,.]+ dps with status/);
  assert.match(lines[0], /ttk [\d,.]+s \([\d,.]+ shots\)/);
});

test('--brief search keeps the mod list and the assumptions', () => {
  const result = runRaw(['search', 'Soma Prime', '--enemy', 'Bombard', '--level', '150', '--top', '1', '--brief']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Soma Prime vs Bombard 150 · 1 of \d+ builds/);
  assert.match(result.stdout, /^1\. .*s · .* dps · \d+F · \d+\/\d+ cap/m);
  assert.match(result.stdout, /^   .*Serration/m, 'the answer must carry the mods');
  assert.match(result.stdout, /^assumptions: /m);
});

test('expected failures exit 2, stay terse, and are JSON when asked', () => {
  const json = runRaw(['calc', 'NoSuchWeapon', '--json']);
  assert.equal(json.status, 2);
  assert.equal(json.stdout.trim(), '');
  const payload = JSON.parse(json.stderr) as { error: { code: string; message: string } };
  assert.equal(payload.error.code, 'weapon_not_found');
  assert.equal(payload.error.message, 'weapon not found: NoSuchWeapon');
  assert.ok(!/file:|\bat .*cli\.ts/.test(json.stderr), 'an expected failure must not print a stack trace');

  const text = runRaw(['calc', 'NoSuchWeapon']);
  assert.equal(text.status, 2);
  assert.match(text.stderr, /^error: weapon not found: NoSuchWeapon/);

  const ability = runRaw(['ability', 'Not An Ability', '--json']);
  assert.equal(ability.status, 2);
  assert.equal((JSON.parse(ability.stderr) as { error: { code: string } }).error.code, 'ability_not_found');
});

test('--brief=answer keeps the answer and drops the context', () => {
  const result = runRaw(['calc', 'Kuva Bramma', '--mod', 'Serration', '--enemy', 'Bombard', '--level', '150', '--brief=answer']);
  assert.equal(result.status, 0);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ttk [\d,.]+s/);
  for (const word of ['burst', 'sustained', 'armour']) assert.ok(!lines[0].includes(word));
});

test('batch prices every record and reports a bad one without stopping', () => {
  const input = [
    JSON.stringify({ label: 'bramma', weapon: 'Kuva Bramma', mods: [{ name: 'Serration' }], enemy: 'Bombard', level: 150 }),
    JSON.stringify({ label: 'typo', weapon: 'NoSuchWeapon', enemy: 'Bombard', level: 150 }),
    JSON.stringify({ label: 'avalanche', ability: 'Avalanche', strength: 200 }),
  ].join('\n');
  const result = runRaw(['batch', '--brief=answer'], input);
  assert.equal(result.status, 1, 'one failed record makes the batch exit 1');
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^bramma: Kuva Bramma vs Bombard 150 · [\d,.]+ dps · ttk /);
  assert.match(lines[1], /^typo: error: weapon not found: NoSuchWeapon/);
  assert.match(lines[2], /^avalanche: Frost Avalanche .* · strip 100%/);
});

test('the text report shows the effective armour after a strip', () => {
  const result = runRaw(['calc', 'Haalvu', '--armor-strip', '100', '--enemy', 'Bombard', '--level', '150']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /armor 0 \(base 2,700\)/, result.stdout);
});

test('a comma list in --mod is the same as repeated flags', () => {
  const comma = run(['calc', 'Haalvu', '--mod', 'Serration,Galvanized Chamber', '--enemy', 'Bombard', '--level', '150', '--json']) as { projectileTotal: number };
  const separate = run(['calc', 'Haalvu', '--mod', 'Serration', '--mod', 'Galvanized Chamber', '--enemy', 'Bombard', '--level', '150', '--json']) as { projectileTotal: number };
  assert.equal(comma.projectileTotal, separate.projectileTotal);
});

test('calc reports capacity, Forma and the equipped arcane', () => {
  const result = run([
    'calc', 'Haalvu', '--mod', 'Serration,Galvanized Chamber', '--arcane', 'Primary Merciless',
    '--enemy', 'Bombard', '--level', '150', '--json',
  ]) as {
    capacityUsed: number; capacity: number; formaNeeded: number; fits: boolean;
    arcanes: Array<{ name: string }>;
  };
  // Haalvu has two Madurai slots: Serration and Galvanized Chamber are halved for free.
  assert.equal(result.capacityUsed, 15);
  assert.equal(result.capacity, 60);
  assert.equal(result.formaNeeded, 0);
  assert.equal(result.fits, true);
  assert.deepEqual(result.arcanes.map((arcane) => arcane.name), ['Primary Merciless']);
});

test('--arcane auto picks an arcane only when its condition is active', () => {
  const withStacks = run([
    'search', 'Haalvu', '--enemy', 'Bombard', '--level', '150', '--armor-strip', '100',
    '--stacks', 'onKill=12', '--status-types', '2', '--arcane', 'auto',
    '--objective', 'dps', '--top', '1', '--json',
  ]) as { builds: Array<{ arcanes: Array<{ name: string }> }> };
  // Merciless (+30% x 12) and Dexterity (+60% x 6) are the same +360% at full on-kill stacks.
  assert.ok(['Primary Merciless', 'Primary Dexterity'].includes(withStacks.builds[0].arcanes[0]?.name ?? ''));

  // Without on-kill stacks every damage arcane's conditional line is inactive; Fractalized Reset
  // used to win the tie while contributing nothing. What may still win is a real passive: max-rank
  // Primary Merciless always gives +30% Reload Speed (DE's text lists it on its own line), and
  // Primary Debilitate adds base procs on 10+ combined stacks without any condition.
  const without = run([
    'search', 'Haalvu', '--enemy', 'Bombard', '--level', '150', '--armor-strip', '100',
    '--arcane', 'auto', '--objective', 'dps', '--top', '1', '--json',
  ]) as { builds: Array<{ arcanes: Array<{ name: string }> }> };
  assert.ok(!without.builds[0].arcanes.some((arcane) => arcane.name === 'Fractalized Reset'));
  assert.ok(without.builds[0].arcanes.every((arcane) => ['Primary Merciless', 'Primary Debilitate'].includes(arcane.name)));
});

test('--eximus adds level-scaled Overguard to the target', () => {
  const plain = run(['calc', 'Soma Prime', '--mod', 'Serration', '--enemy', 'Bombard', '--level', '150', '--json']) as { timeToKill: number | null; overguard: number };
  const eximus = run(['calc', 'Soma Prime', '--mod', 'Serration', '--eximus', '--enemy', 'Bombard', '--level', '150', '--json']) as {
    timeToKill: number | null; overguard: number; overguardDps: number;
  };
  assert.equal(plain.overguard, 0);
  assert.equal(eximus.overguard, 281865);
  assert.ok(eximus.overguardDps > 0);
  assert.ok((eximus.timeToKill ?? 0) > (plain.timeToKill ?? 0));
});

test('an ability cast has to break Overguard before health', () => {
  const result = run(['ability', 'Avalanche', '--strength', '200', '--enemy', 'Bombard', '--level', '150', '--eximus', '--json']) as {
    target: { overguard: number; overguardPerCast: number; castsToKill: number | null };
  };
  assert.equal(result.target.overguard, 281865);
  assert.equal(result.target.overguardPerCast, 3000); // Cold is neutral to Overguard
  // ceil(281865/3000) overguard casts, then the health pool. Cold has no Grineer modifier in
  // Damage 3.0. An Eximus Bombard also has 6x base health above level 100 (wiki: 0.25 x
  // (300 + 900) x 6 = 1800 vs 300), so the health phase takes six times the casts.
  assert.equal(result.target.castsToKill, 2464);
});

test('attenuation is opt-in for Archons and automatic for Eidolons', () => {
  const plain = run(['calc', 'Haalvu', '--mod', 'Serration', '--enemy', 'Bombard', '--level', '150', '--json']) as {
    timeToKill: number | null; attenuation: unknown;
  };
  const capped = run(['calc', 'Haalvu', '--mod', 'Serration', '--enemy', 'Bombard', '--level', '150', '--mdpt', '1', '--mdps', '1', '--json']) as {
    timeToKill: number | null; attenuation: { id: string; mdpi: number; mdps: number } | null;
  };
  assert.equal(plain.attenuation, null);
  assert.equal(capped.attenuation?.id, 'custom');
  assert.equal(capped.attenuation?.mdpi, 1);
  assert.ok((capped.timeToKill ?? 0) > (plain.timeToKill ?? 0));

  const archon = run(['calc', 'Haalvu', '--mod', 'Serration', '--enemy', 'Bombard', '--level', '150', '--attenuation', 'archon', '--json']) as {
    attenuation: { id: string; mdpi: number; mdps: number; flatDr: number; statusDr: number } | null;
  };
  assert.equal(archon.attenuation?.id, 'archon');
  assert.equal(archon.attenuation?.mdpi, 460000);
  assert.equal(archon.attenuation?.mdps, 935000);
  assert.equal(archon.attenuation?.statusDr, 0.5);

  const eidolon = run(['calc', 'Rubico Prime', '--mod', 'Serration', '--enemy', 'Eidolon Teralyst', '--level', '30', '--json']) as {
    attenuation: { id: string } | null;
  };
  assert.equal(eidolon.attenuation?.id, 'eidolon');
  const off = run(['calc', 'Rubico Prime', '--mod', 'Serration', '--enemy', 'Eidolon Teralyst', '--level', '30', '--attenuation', 'none', '--json']) as {
    attenuation: unknown;
  };
  assert.equal(off.attenuation, null);
});

test('ability statuses are reported in the brief', () => {
  const miasma = runRaw(['ability', 'Miasma', '--strength', '100', '--enemy', 'Bombard', '--level', '150', '--brief']);
  assert.equal(miasma.status, 0);
  assert.match(miasma.stdout, /180\/cast/);
  assert.match(miasma.stdout, /1 viral/);

  const stacked = runRaw(['ability', 'Miasma', '--viral', '10', '--enemy', 'Bombard', '--level', '150', '--brief']);
  assert.match(stacked.stdout, /10 viral/);

  const shuriken = runRaw(['ability', 'Shuriken', '--strength', '100', '--enemy', 'Bombard', '--level', '150', '--brief']);
  assert.equal(shuriken.status, 0);
  assert.match(shuriken.stdout, /\+1,577\.1 status/);
});

test('ability briefs show the shield phase against Corpus', () => {
  const result = runRaw(['ability', 'Avalanche', '--strength', '200', '--enemy', 'Corpus Tech', '--level', '150', '--brief']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /shields [\d,.]+\/cast/);
});

test('ability --targets reports the whole cast', () => {
  const result = runRaw(['ability', 'Miasma', '--strength', '100', '--enemy', 'Bombard', '--level', '150', '--targets', '5', '--brief']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /5 targets = 900/);
});

test('search briefs name the conditional mods', () => {
  const result = runRaw([
    'search', 'Soma Prime', '--enemy', 'Bombard', '--level', '150', '--top', '1',
    '--must', 'Galvanized Chamber', '--stacks', 'onKill=12', '--status-types', '2', '--brief',
  ]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /conditional Galvanized Chamber/);
});

test('ability briefs show a split damage type', () => {
  const result = runRaw(['ability', 'Inferno', '--strength', '100', '--enemy', 'Bombard', '--level', '150', '--brief']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Inferno \(impact\+heat\)/);
});

test('an AoE weapon reports the radial share across a group', () => {
  const result = run(['calc', 'Kuva Bramma', '--targets', '5', '--enemy', 'Bombard', '--level', '150', '--json']) as {
    totalDps: number; multiTargetDps: number | null; multiTargetFactor: number; warnings: string[];
  };
  // Direct 187 Impact + radial 839 Blast: 4 extra targets x 81.7% radial share.
  assert.ok(result.multiTargetFactor > 4.2 && result.multiTargetFactor < 4.3);
  assert.ok((result.multiTargetDps ?? 0) > result.totalDps);
  assert.ok(result.warnings.some((line) => /AoE group/.test(line)));
});

test('Torid chains with --targets and other weapons warn instead', () => {
  const torid = run(['calc', 'Torid', '--incarnon', 'form', '--targets', '6', '--enemy', 'Bombard', '--level', '150', '--json']) as {
    totalDps: number; multiTargetDps: number | null; multiTargetFactor: number; warnings: string[];
  };
  assert.ok(torid.multiTargetFactor > 3.28 && torid.multiTargetFactor < 3.29);
  assert.ok((torid.multiTargetDps ?? 0) > torid.totalDps);
  assert.ok(torid.warnings.some((line) => /Chain/.test(line)));

  const soma = run(['calc', 'Soma Prime', '--targets', '2', '--enemy', 'Bombard', '--level', '150', '--json']) as {
    multiTargetDps: number | null; warnings: string[];
  };
  assert.equal(soma.multiTargetDps, null);
  assert.ok(soma.warnings.some((line) => /multi-target is not modelled for this weapon/.test(line)));
});

test('Thermal Sunder accepts --ability-mode heat', () => {
  const result = runRaw(['ability', 'Thermal Sunder', '--ability-mode', 'heat', '--enemy', 'Bombard', '--level', '150', '--brief']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /heat mode/);
  assert.match(result.stdout, /1,500/);
});

test('per-status-type bonuses count the build own status types, plus extra ones', () => {
  const mods = ['Serration', 'Galvanized Aptitude', 'Primed Cryo Rounds', 'Infected Clip'];
  const calc = (extra: string[]) => run(['calc', 'Haalvu', '--mod', mods.join(','), '--stacks', 'onKill=12', ...extra, '--enemy', 'Bombard', '--level', '150', '--json']) as {
    statusTypes: number; burstDps: number;
  };
  const own = calc([]);
  const one = calc(['--status-types', '1']);
  const extra = calc(['--extra-status-types', '2']);
  // Tau + Viral, counted from the build; a given total wins; extra types add to the build's own.
  assert.equal(own.statusTypes, 2);
  assert.equal(one.statusTypes, 1);
  assert.equal(extra.statusTypes, 4);
  assert.ok(own.burstDps > one.burstDps, 'two status types should make Galvanized Aptitude stronger');
  assert.ok(extra.burstDps > own.burstDps);
});

test('Spores brief shows the Corrosive strip', () => {
  const result = runRaw(['ability', 'Spores', '--enemy', 'Bombard', '--level', '150', '--brief']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /corrosive 10 \(80% strip\)/);
});

test('ability distance falloff is reported in the brief', () => {
  const result = runRaw(['ability', 'Discharge', '--enemy', 'Bombard', '--level', '150', '--ability-distance', '20', '--brief']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /20 m \(x0\.50\)/);
});

test('a duplicate mod is a bad request, not a doubled bonus', () => {
  // The game equips one copy; before this check, Serration twice took 14 capacity and raised
  // the DPS from 152.6 to 234.5.
  const duplicate = runRaw(['calc', 'Soma Prime', '--mod', 'Serration', '--mod', 'Serration', '--json']);
  assert.equal(duplicate.status, 2);
  const payload = JSON.parse(duplicate.stderr) as { error: { code: string; message: string } };
  assert.equal(payload.error.code, 'duplicate_mod');
  assert.match(payload.error.message, /Serration/);

  // The same mod written differently is the same mod.
  const caseVariant = runRaw(['calc', 'Soma Prime', '--mod', 'Serration', '--mod', 'serration:R4', '--json']);
  assert.equal(caseVariant.status, 2);

  // A normal build still works.
  const ok = runRaw(['calc', 'Soma Prime', '--mod', 'Serration', '--enemy', 'Bombard', '--level', '150', '--brief=answer']);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /dps/);
});

test('the answer states the damage per pull that actually lands on the target', () => {
  // The arsenal number (31.8) is before the target. Against a level 150 Bombard, 2700 armour
  // cuts 90% and the per-type floor applies, so a pull removes 6.21 from health. Quantization
  // (1/32 of 12) makes the split 1.125 / 4.875 / 6 rather than 1.2 / 4.8 / 6.
  const result = run(['calc', 'Soma Prime', '--mod', 'Serration', '--enemy', 'Bombard', '--level', '150', '--json']) as {
    projectileTotal: number; averageShotDamage: number;
    damagePerShotHealth: number; damagePerShotShield: number;
  };
  assert.equal(result.projectileTotal.toFixed(2), '31.80');
  assert.equal(result.damagePerShotHealth.toFixed(4), '6.2110');
  assert.equal(result.damagePerShotShield, 0);
  assert.ok(result.damagePerShotHealth < result.averageShotDamage / 8, 'armour must show up in the per-shot number');

  const brief = runRaw(['calc', 'Soma Prime', '--mod', 'Serration', '--enemy', 'Bombard', '--level', '150', '--brief']);
  assert.match(brief.stdout, /shot 6\.2 to health/);
});
