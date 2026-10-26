# JSON API

`wfcalc serve` exposes a small HTTP API on `http://127.0.0.1:7777` (loopback only by
default). It is meant for the web UI and for programs that speak HTTP; **an AI agent should use
the CLI**, which is cheaper per question (`--brief`, `--brief=answer`, `wfcalc batch`) and has
no schema round-trip. Same inputs and engine either way.

## `GET /api/weapons`

```json
[{ "name": "Kuva Bramma", "category": "primary", "type": "Bow", "masteryRank": 15 }]
```

## `GET /api/enemies`

```json
[{ "name": "Bombard", "faction": "grineer", "health": 300, "shield": 0, "armor": 500 }]
```

## `GET /api/mods?weapon=Kuva%20Bramma`

Mods that fit the weapon, with max rank, polarity and description.

```json
[{ "name": "Serration", "maxRank": 10, "polarity": "madurai", "description": "+165% Damage",
   "partial": false, "baseDrain": 4, "rarity": "Uncommon", "set": null }]
```

`partial: true` means the calculator only understood part of the mod's effects; the
damage result is a lower bound.

## `GET /api/incarnons?weapon=Torid`

```json
[{ "tier": "EVO2", "name": "Final Fusillade",
   "effects": [{ "target": "baseDamage", "value": 51, "flat": true }],
   "text": ["Increase Base Damage by +51."] }]
```

## `GET /api/buffs`

```json
[{ "id": "roar", "ability": "Roar", "frame": "Rhino", "augments": false }]
```

## `GET /api/arcanes?weapon=Torid`

Weapon arcanes whose slot fits the weapon, with max rank and description.

## `GET /api/abilities`

Every damage-dealing or armour-stripping ability in the snapshot, for pickers and agents that
need to know what `stripFrom` accepts.

```json
[{ "ability": "Miasma", "frame": "Saryn", "damageType": "viral", "baseDamage": 150,
   "perSecond": true, "durationSeconds": 6, "radius": 20, "armorStrip": null },
 { "ability": "Avalanche", "frame": "Frost", "damageType": "cold", "baseDamage": 1500,
   "perSecond": false, "durationSeconds": null, "radius": 4.5,
   "armorStrip": { "mode": "percent", "value": 60 } }]
```

## `GET /api/ability?name=Miasma&strength=200&enemy=Bombard&level=150`

One damage-dealing ability, resolved through the same target maths weapons use: faction
health-class modifier (Damage 3.0), armour reduction and a minimum of 1 per damage type.

```json
{
  "frame": "Saryn", "ability": "Miasma", "mode": null, "damageType": "viral",
  "baseDamage": 150, "strength": 200, "scaledDamage": 300,
  "perSecond": true, "durationSeconds": 6, "totalDamage": 1800,
  "armorStrip": null,
  "target": { "enemy": "Bombard", "level": 150, "healthMultiplier": 1,
              "armorReduction": 0.9, "perCast": 180, "directPerCast": 180,
              "statusPerCast": 0, "viralStacks": 1, "corrosiveStacks": 0, "corrosiveArmorMultiplier": 1,
              "targets": 1, "totalPerCast": 180,
              "statusProcs": [{ "type": "viral", "stacks": 1, "damageType": "viral", "total": 0 }],
              "shield": 0, "shieldPerCast": 0, "bypassesShield": false,
              "overguard": 0, "overguardPerCast": 0, "castsToKill": 659 },
  "notes": ["Ability damage is flat: it does not crit, use multi..."]
}
```

Parameters: `name` (required), `strength` (percent, default 100), `enemy`, `level`,
`eximus` (`1`/`true`), `overguard`
(an explicit amount), `viral` (Viral stacks already on the target; Miasma also applies its
own), `targets` (enemies hit by one cast, all at full damage), `mode` (Thermal Sunder's `heat`)
and `distance` (Discharge's falloff). `target.castsToKill` includes the casts needed to break Overguard;
`target.overguard` and `target.overguardPerCast` are reported separately. `perCast` is damage
to health: direct plus the guaranteed statuses (`statusPerCast`); `statusProcs` lists them and
`viralStacks` the Viral stacks in effect. `shield`/`shieldPerCast` are the shield phase (Toxin
sets `bypassesShield`), and `castsToKill` is the sum of the Overguard, shield and health
phases. An unknown name is a 404 with
`{ "error": "..." }`.

## `POST /api/search`

Finds the best eight-slot build for a target. Same options as the CLI's `wfcalc search`.

```json
{
  "weapon": "Soma Prime",
  "objective": "dps",
  "enemy": "Bombard",
  "level": 150,
  "capacity": 60,
  "maxForma": 2,
  "mustInclude": ["Serration"],
  "exclude": ["Heavy Caliber"],
  "limit": 3,
  "budget": 12000,
  "chooseIncarnon": false,
  "chooseArcane": false,
  "eximus": false,
  "overguard": null,
  "attenuation": "archon",
  "base": { "arcanes": [{ "name": "Primary Merciless" }], "conditions": { "onKill": 12 } }
}
```

- `objective`: `ttk` (default) minimises time to kill; `dps` maximises damage on the target.
- `mustInclude` / `exclude` are mod names; a comma-separated string is also accepted.
- `maxForma: null` means "as many as needed" (that is the default when omitted).
- `chooseIncarnon` lets the search pick evolution perks; it is off by default.
- `chooseArcane` (or `"arcane": "auto"`) tries every arcane whose slot fits and keeps the best
  build. An explicit arcane in `base.arcanes` wins over `auto`.
- `eximus` adds the wiki's level-scaled Overguard to the target; `overguard` sets an explicit
  amount instead. The search scores the time to remove it plus shields and health.
- `attenuation` applies the same boss caps as `/api/calc`; the result echoes the resolved
  profile in `attenuation` and its assumptions.
- `base` fixes everything the search does not choose (arcanes, buffs, frame, riven, debuffs,
  the armour strip, conditions, mode, combo). The top level is accepted as well, so the
  `/api/calc` body shape works when `base` is omitted.

Response (abridged):

```json
{
  "weapon": "Soma Prime", "objective": "dps", "enemy": "Bombard", "level": 150,
  "capacity": 60, "evaluated": 787, "elapsedMs": 56, "overguard": 0, "attenuation": null,
  "builds": [{
    "mods": [{ "name": "Split Chamber", "rank": 5, "drain": 5, "polarity": "madurai" }],
    "capacityUsed": 60, "capacity": 60, "formaNeeded": 2,
    "burstDps": 20000, "sustainedDps": 15000, "totalDps": 17000,
    "timeToKill": 6.9, "shotsToKill": 12,
    "arcanes": [{ "name": "Primary Merciless", "rank": 5 }],
    "conditionalMods": ["Galvanized Chamber", "Galvanized Aptitude"],
    "incarnon": ["EVO2:0"], "incarnonNames": ["EVO2 Final Fusillade"]
  }],
  "assumptions": ["Melee combo assumed at 12x (220 hits)"],
  "notes": []
}
```

## `POST /api/bruteforce`

Exhaustive build search: every feasible mod combination, scored against one target. Same body as
`/api/search` for the target and build inputs (`enemy`, `level`, `eximus`, `overguard`,
`attenuation`, `capacity`, `maxForma`, `exclude`, and `base` or top-level buffs, Incarnon,
arcanes, riven), plus:

| Field | Meaning |
|---|---|
| `steelPath` | `true`: target health and shields x2.5 (`level` is the actual enemy level) |
| `fixed` | Mods always equipped: `["Serration", {"name": "Hunter Munitions", "rank": 3}]` |
| `maxEvaluations` | Combination budget that sizes the shortlist (default 2,000,000) |
| `pool` | Force a shortlist of this many candidate mods |
| `limit` | Builds to return (default 5) |

```json
{"weapon": "Soma Prime", "enemy": "Heavy Gunner", "level": 200, "steelPath": true,
 "fixed": ["Serration"], "buffs": ["roar"], "abilityStrength": 150}
```

The answer carries `builds` (best first, each mod flagged `fixed` or not), `exhaustive` (true when
every candidate mod was enumerated, false when a shortlist was), `candidates`, `leftOut`,
`combinations`, `evaluated`, `workers`, and the scaled target (`health`, `shield`, `armor`).
`steelPath` is also accepted by `/api/calc` and `/api/search`.

## `POST /api/calc`

```json
{
  "weapon": "Kuva Bramma",
  "arcanes": [{ "name": "Primary Merciless", "rank": 5 }],
  "buffs": ["roar", "toxic-lash"],
  "abilityStrength": 284,
  "frameMods": [{ "name": "Intensify" }],
  "frame": "Rhino",
  "warframeArcanes": ["Arcane Avenger"],
  "riven": { "stats": ["damage", "multishot"], "malus": "zoom", "roll": 1.05, "rank": 8 },
  "debuffs": { "viralStacks": 10, "corrosiveStacks": 4 },
  "incarnon": ["EVO2:0", "EVO4:1"],
  "comboHits": 220,
  "aoeDistance": 4,
  "corrosiveProjections": 2,
  "armorStripPercent": 30,
  "stripFrom": "Avalanche",
  "shatteringImpactHits": 20,
  "elementBonus": { "type": "heat", "value": 0.6 },
  "heavyAttack": false,
  "targets": 1,
  "eximus": false,
  "overguard": null,
  "attenuation": "archon",
  "mods": [{ "name": "Serration" }, { "name": "Vital Sense", "rank": 3 }],
  "enemy": "Bombard",
  "level": 150,
  "mode": "Radial Attack",
  "headshot": false,
  "conditions": { "onKill": 5, "aiming": true, "statusTypes": 3 }
}
```

- `mods`: order matters — it is the slot order the game uses for elemental combination.
- `rank` is optional; omitted means max rank.
- `mode` is optional; omitted means the arsenal stat block.
- `arcanes`: weapon arcanes; the slot must match the weapon category.
- `buffs`: registry ids from `GET /api/buffs`; `abilityStrength` is a percentage (100 = unmodded).
- `riven` is resolved against the weapon's own disposition; `roll` (0.9-1.1) and `rank` (0-8) are optional.
- `incarnon` picks evolution tiers (`"EVO2:0"` = first option of tier EVO2; see `GET /api/incarnons`);
  `"form"` uses the transformed profile with no perks.
- `elementBonus` is the Kuva/Tenet bonus (`value` as a fraction or a percentage).
- `conditions.covenantDamage` feeds Harrow's Covenant (damage prevented).
- `eximus` adds the level-scaled Eximus Overguard; `overguard` sets an explicit amount instead.
- `targets` reports a group: abilities hit N enemies at full damage; Torid's Incarnon chains to
  N targets in total (75% per link); an AoE weapon gives the extras only the radial share. A
  weapon with neither warns.
- `attenuation` applies boss caps (`"archon"`, `"eidolon"`, `"none"`) or a custom object
  `{ "id": "custom", "mdpi": 460000, "mdps": 935000, "flatDr": 0.2, "statusDr": 0.5 }`.
  `mdpt`/`mdps`/`flatDr`/`statusDr` at the top level are shorthand for a custom profile
  (`flatDr`/`statusDr` in percent). Eidolons apply theirs automatically.
- `aoeDistance` (metres) applies the weapon's own AoE falloff; omitted means blast centre.
- `comboHits` drives the melee combo multiplier; `heavyAttack` applies it to damage.
- `frame` is optional: it validates Helminth availability of the requested buffs.
- `warframeArcanes` apply to the weapon and to Ability Strength (Molt Augmented).
- `debuffs` are status stacks kept up on the target: Viral amplifies health damage, Corrosive strips armour.
- `corrosiveProjections` (0-4, 18% each), `armorStripPercent` (0-100), `stripFrom` (an ability
  name from `GET /api/abilities`) and `shatteringImpactHits` (6 base armour each) are resolved
  server-side into `debuffs.armorStrip` / `armorStripFlat` / `armorStripBaseFlat`. Percentage
  strips add up: Terrify at 60% plus one Corrosive Projection leaves 22% of the armour, not 33%.
  `stripFrom` uses `abilityStrength` for its scaling.
- `conditions` toggles conditional mods: `onKill` (stacks), `onWeakPointHit`,
  `onWeakPointKill`, `onReload`, `aiming`, `sliding`, `holstered`, `statusTypes` (count).

Response (abridged):

```json
{
  "weapon": { "name": "Kuva Bramma", "type": "Bow", "modClasses": ["Rifle", "Bow"],
              "mode": null, "modes": ["Charged Shot", "Radial Attack", "..."] },
  "damage": { "impact": 495.55, "blast": 7117.37 },
  "projectileTotal": 7612.92,
  "averageShotDamage": 32791.1,
  "damagePerShotHealth": 612.4, "damagePerShotShield": 0, "damagePerShotOverguard": 32791.1,
  "critChance": 0.35, "critMultiplier": 4.62, "statusChance": 0.21,
  "multishot": 1.9, "fireRate": 0.667,
  "burstDps": 21860.8, "sustainedDps": 15614.8,
  "capacityUsed": 59, "capacity": 60, "formaNeeded": 3, "fits": true,
  "arcanes": [{ "name": "Primary Merciless", "rank": 5 }],
  "elements": [{ "type": "blast", "share": 0.935 }],
  "overguard": 0, "overguardDps": 0, "attenuation": null,
  "multiTargetDps": null, "multiTargetFactor": 1,
  "capacityUsed": 59, "capacity": 60, "formaNeeded": 3, "fits": true, "arcanes": [],
  "target": {
    "name": "Bombard", "level": 150, "health": 118480.2, "armor": 2700,
    "breakdown": [{ "type": "blast", "raw": 7117.37, "healthMultiplier": 0.1,
                    "toHealth": 711.74, "procShare": 0.935 }],
    "shotsToKill": 27.4, "timeToKill": 57.51,
    "dot": [{ "type": "slash", "procsPerSecond": 0.13, "tickDamage": 952, "ticks": 6, "dps": 760 }],
    "totalDps": 6360,
    "critVariance": { "pellets": 22, "expectedCrits": 3.96, "atLeastOneCrit": 0.987 }
  },
  "warnings": [],
  "unsupportedMods": [],
  "inactiveConditions": ["..."]
}
```

Errors come back as `{ "error": "...", "suggestions": ["..."] }`. An unknown weapon, enemy or
ability is a 404. A request that cannot describe a legal build is a 400 with a stable `code`:
`duplicate_mod` (the same mod twice — the game equips one copy) or `unknown_weapon`.

## Agent recipes

"Is my build good against high-level Grineer?"

```sh
curl -s localhost:7777/api/calc -H 'content-type: application/json' -d '{
  "weapon":"Lex Prime",
  "mods":[{"name":"Hornet Strike"},{"name":"Primed Pistol Gambit"},{"name":"Primed Target Cracker"}],
  "enemy":"Bombard","level":200}' | jq '{dps:.sustainedDps, ttk:.target.timeToKill, warns:.warnings}'
```

"Which elemental combo is best for this weapon?"

```sh
for combo in "Hellfire,Cryo Rounds" "Infected Clip,Stormbringer" "Hellfire,Infected Clip"; do
  jq -n --arg c "$combo" '{weapon:"Ignis Wraith", mods:[{name:"Serration"}] + ($c|split(",")|map({name:.})),
                            enemy:"Corrupted Bombard", level:160}' |
  curl -s localhost:7777/api/calc -H 'content-type: application/json' -d @- |
  jq -r --arg c "$combo" '"\($c): \(.target.timeToKill)s"'
done
```

"Find me mods that fit this weapon and mention multishot":

```sh
curl -s 'localhost:7777/api/mods?weapon=Kuva%20Bramma' | jq -r '.[] | select(.description|test("Multishot")) | "\(.name)  \(.description|split("\n")[0])"'
```
