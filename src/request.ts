/**
 * Turn a JSON request into a Build.
 *
 * The HTTP API, `wfcalc batch` and any future front end share this: one definition of the
 * field names means a payload that works over HTTP works in a batch file, and vice versa.
 */
import type { Build } from './engine/build.ts';
import { resolveStrip } from './engine/strip.ts';
import type { Snapshot } from './types.ts';

const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

export function buildFromJson(snapshot: Snapshot, body: any, weaponName: string): Build {
  // `strength` is the flag name; `abilityStrength` is the API field. Accept both so a batch
  // record can mirror the CLI without a translation table.
  const strength = body.abilityStrength ?? body.strength;
  // The semantic strip fields are resolved here so a caller can say "2 Corrosive Projections
  // and Avalanche at 200% strength" instead of pre-computing the debuff.
  const strip = resolveStrip(snapshot, {
    corrosiveProjections: body.corrosiveProjections,
    armorStripPercent: body.armorStripPercent,
    stripFrom: body.stripFrom,
    shatteringImpactHits: body.shatteringImpactHits,
    strength: strength ? Number(strength) : undefined,
  });
  return {
    weapon: weaponName,
    mods: Array.isArray(body.mods) ? body.mods : [],
    // "auto" is a search instruction, not an arcane name: the server strips it before the
    // search chooses the arcane itself.
    arcanes: Array.isArray(body.arcanes) ? body.arcanes.filter((entry: unknown) => String(entry).toLowerCase() !== 'auto') : [],
    buffs: list(body.buffs),
    abilityStrength: strength ? Number(strength) : undefined,
    frameMods: Array.isArray(body.frameMods) ? body.frameMods : [],
    frame: body.frame || undefined,
    warframeArcanes: Array.isArray(body.warframeArcanes) ? body.warframeArcanes : [],
    incarnon: Array.isArray(body.incarnon) ? body.incarnon.map(String) : [],
    elementBonus: body.elementBonus
      ? {
          type: body.elementBonus.type,
          value: Number(body.elementBonus.value) > 1 ? Number(body.elementBonus.value) / 100 : Number(body.elementBonus.value),
        }
      : undefined,
    // null means "not set" (the UI's default), not a distance of 0 m.
    aoeDistance: body.aoeDistance != null ? Number(body.aoeDistance) : undefined,
    comboHits: body.comboHits ? Number(body.comboHits) : undefined,
    heavyAttack: Boolean(body.heavyAttack),
    riven: body.riven ?? undefined,
    debuffs: { ...(body.debuffs ?? {}), ...strip },
    mode: body.mode || undefined,
    conditions: body.conditions ?? {},
    headshot: Boolean(body.headshot),
    hit: body.hit === 'head' || body.hit === 'body' ? body.hit : undefined,
    stackMode: body.stackMode === 'none' || body.stackMode === 'max' || body.stackMode === 'custom' ? body.stackMode : undefined,
    zoom: body.zoom !== undefined && body.zoom !== null ? Number(body.zoom) : undefined,
    extraStatusTypes: body.extraStatusTypes ? Number(body.extraStatusTypes) : undefined,
    sniperCombo: body.sniperCombo ? Number(body.sniperCombo) : undefined,
    shards: Array.isArray(body.shards)
      ? body.shards.filter((shard: any) => shard && typeof shard.color === 'string').slice(0, 5)
        .map((shard: any) => ({ color: String(shard.color).toLowerCase(), bonus: String(shard.bonus ?? 'other'), tauforged: Boolean(shard.tauforged) }))
      : undefined,
    sourceStacks: body.sourceStacks && typeof body.sourceStacks === 'object'
      ? Object.fromEntries(Object.entries(body.sourceStacks).map(([name, value]) => [name, Number(value)]).filter(([, value]) => Number.isFinite(value as number)))
      : undefined,
  };
}
