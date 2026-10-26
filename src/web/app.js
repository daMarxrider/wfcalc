/**
 * wfcalc UI. Vanilla JS, no build step: the server serves these three files directly.
 *
 * Everything the browser shows comes from POST /api/calc, so the UI can never drift from
 * the CLI or the tests. State lives in one object, is mirrored to the URL fragment (so a
 * build is shareable) and to localStorage (so it survives closing the tab).
 */

const MAX_SLOTS = 8; // plus exilus; melee also gets a stance slot that adds capacity
const STORAGE_KEY = 'wfcalc.builds';

const ELEMENT_COLORS = {
  impact: '#8b93a8', puncture: '#a08a6a', slash: '#c0504d', heat: '#f0793a',
  cold: '#5bbcec', electricity: '#7f7fdc', toxin: '#9fc03a', blast: '#c6502a',
  corrosive: '#93c203', gas: '#7fb04a', magnetic: '#7f8fd0', radiation: '#c8b23c',
  viral: '#4aa88a', true: '#dcdcdc', void: '#b07fd0', tau: '#d0a05b',
};

/** Warframe polarity colours, used to tint mod cards. */
const POLARITY_COLORS = {
  madurai: '#e2664f', vazarin: '#4f9de2', naramon: '#c9d24a', zenurik: '#b07fd0',
  unairu: '#7ac77a', penjaga: '#4ac7bb', umbra: '#e0b04a', universal: '#9aa3b5',
};
const polarityColor = (polarity) => POLARITY_COLORS[String(polarity ?? '').toLowerCase()] ?? POLARITY_COLORS.universal;

/** Polarity glyphs as the game shows them on a slot. */
const POLARITY_GLYPH = {
  madurai: 'V', vazarin: 'D', naramon: '–', zenurik: '=', unairu: 'Ω',
  penjaga: 'P', umbra: 'U', universal: '·',
};
const glyph = (polarity) => POLARITY_GLYPH[String(polarity ?? '').toLowerCase()] ?? '';

/** Rarity colours, bronze to platinum like the game. */
const RARITY_COLORS = {
  common: '#c08a5a', uncommon: '#b9c2d0', rare: '#e0b04a', legendary: '#e8e8f0',
};
const rarityColor = (rarity) => RARITY_COLORS[String(rarity ?? '').toLowerCase()] ?? '#8d95a7';

/**
 * The headline stat of a mod at a given rank. `levels` holds one line per rank, so an R8
 * Serration shows +135% and not the max-rank +165% the description carries.
 */
function headline(mod, rank) {
  const levels = mod.levels ?? [];
  const line = levels[rank ?? levels.length - 1] ?? (mod.description ?? '').split('\n')[0] ?? '';
  // Keep the number and its sign, drop the rest of the phrase ("+165% Damage" -> "+165%").
  const match = /([+-]?\d+(?:[.,]\d+)?%?)/.exec(line);
  return match ? match[1] : '';
}

/**
 * One mod card: artwork, rarity frame, headline stat, drain, name, stats, compatibility and
 * rank stars — the game's mod card, whose frame is CSS rather than a baked image, so
 * the card always renders even when the artwork fails.
 */
function modCardMarkup(mod, options = {}) {
  const equipped = options.equipped ?? false;
  const showShare = options.showShare ?? false;
  const share = options.share ?? 0;
  const stars = Math.min((mod.maxRank ?? 0) + 1, 11);
  const rank = options.rank ?? mod.maxRank ?? 0;
  // The slot passes the drain it really pays (halved on a polarity match); the library shows
  // the max-rank cost with no slot to halve it.
  const drain = options.drain ?? (mod.baseDrain ?? 0) + rank;
  const statLines = (mod.description ?? '').split('\n').filter(Boolean);
  // The frame is coloured by rarity, with a distinct one for Galvanized mods.
  const rarity = /galvan/i.test(mod.name)
    ? 'galvanized'
    : String(mod.rarity ?? 'common').toLowerCase();
  return `
    <div class="mcard ${rarity}" style="--rarity:${rarityColor(mod.rarity)}">
      <span class="mcard-glow" aria-hidden="true"></span>
      ${headline(mod, rank) ? `<span class="mcard-stat" title="${(mod.levels?.[rank] ?? mod.description ?? '').replace(/"/g, '&quot;')}">${headline(mod, rank)}</span>` : ''}
      ${showShare && share > 0.005 ? `<span class="mcard-share">+${(share * 100).toFixed(0)}%</span>` : ''}
      ${mod.isExilus ? '<span class="mcard-exilus" title="Exilus mod: only fits the Exilus slot">exilus</span>' : ''}
      <span class="mcard-drain">${drain}<i class="polarity" style="color:${polarityColor(mod.polarity)}">${glyph(mod.polarity)}</i></span>
      <figure class="mcard-image">
        ${mod.image ? `<img src="/img/${mod.image}" alt="" loading="lazy" draggable="false" onerror="this.style.display='none'" />` : ''}
      </figure>
      <div class="mcard-text">
        <b>${mod.name}</b>
        ${statLines.slice(1).map((line) => `<span>${line}</span>`).join('')}
      </div>
      <div class="mcard-compat">${(mod.classes ?? [])[0] ?? ''}</div>
      <div class="mcard-stars">${'★'.repeat(stars)}</div>
      <input class="rank mcard-rank" type="range" min="0" max="${mod.maxRank ?? 0}" value="${options.rank ?? mod.maxRank ?? 0}"
             data-index="${options.index ?? ''}" oninput="this.closest('.slot')?.querySelector('.rank-proxy')?.dispatchEvent(new Event('input'))" />
      ${equipped ? '<span class="mcard-badge">equipped</span>' : ''}
    </div>`;
}

const emptyState = () => ({
  weapon: '',
  mods: [], // [{ name, rank }]
  slotPolarities: [], // per-slot forma polarity override, null = weapon's own
  reactor: false,
  arcanes: [],
  buffs: [],
  frame: '',
  frameMods: [],
  warframeArcanes: [],
  abilityStrength: 100,
  riven: null,
  rivenRoll: 1,
  rivenRank: 8,
  incarnon: [],
  comboHits: 0,
  heavyAttack: false,
  aoeDistance: null,
  elementBonus: null,
  enemy: 'Bombard',
  level: 100,
  // Steel Path: health and shields x2.5; with steelPathNodeLevel the level slider is the
  // star-chart node's level and the enemy is 100 levels higher.
  steelPath: false,
  steelPathNodeLevel: true,
  mode: '',
  conditions: {},
  headshot: false,
  // Armour strip brought by the squad, the weapon or an ability.
  corrosiveProjections: 0,
  armorStripPercent: 0,
  shatteringImpactHits: 0,
  stripFrom: '',
  lastAbility: '',
});

let state = emptyState();
let allMods = [];
/** Weapon metadata by name, for capacity and polarity matching. */
const weaponData = new Map();
let allBuffs = [];
let allAbilities = [];
let calculationId = 0;
/** Mod name -> share of burst DPS, refreshed on every calculation. */
const lastContributions = new Map();

const $ = (id) => document.getElementById(id);
const fmt = (value, digits = 0) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const pct = (value) => `${(value * 100).toFixed(value < 0.1 ? 2 : 1)}%`;

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** ---------- state <-> URL <-> storage ---------- */

function saveToUrl() {
  try {
    history.replaceState(null, '', `#${btoa(unescape(encodeURIComponent(JSON.stringify(state))))}`);
  } catch {
    /* ignore: a non-serialisable state must never break the UI */
  }
}

function loadFromUrl() {
  if (!location.hash || location.hash.length < 2) return false;
  try {
    state = { ...emptyState(), ...JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(1))))) };
    return true;
  } catch {
    return false;
  }
}

/** Set when a drop was refused, so the notes panel can say why. */
let dragWarning = '';

const loadLibrary = () => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
  } catch {
    return [];
  }
};
const saveLibrary = (builds) => localStorage.setItem(STORAGE_KEY, JSON.stringify(builds));

/** ---------- parsing helpers ---------- */

const parseRivenInput = (text) => {
  const stats = [];
  let malus = null;
  for (const token of text.split(',').map((part) => part.trim()).filter(Boolean)) {
    if (token.startsWith('-')) malus = token.slice(1);
    else stats.push(token);
  }
  return stats.length ? { stats, malus } : null;
};

const parseElementBonus = (text) => {
  const [type, raw] = text.split(':');
  const amount = Number((raw ?? '').replace('%', ''));
  if (!type?.trim() || !Number.isFinite(amount)) return null;
  return { type: type.trim().toLowerCase(), value: amount > 1 ? amount / 100 : amount };
};

const elementBonusText = (bonus) =>
  bonus ? `${bonus.type}:${(bonus.value * 100).toFixed(0)}` : '';

const parseNameList = (text) =>
  text.split(',').map((name) => name.trim()).filter(Boolean).map((name) => ({ name }));

/** ---------- tabs ---------- */

function showTab(name) {
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.tab === name);
  for (const panel of document.querySelectorAll('.tab-panel')) panel.classList.toggle('active', panel.id === `tab-${name}`);
}

/** ---------- rendering: build ---------- */

/** Which polarity a slot accepts: the weapon's own, or the exilus polarity for slot 9. */
/** Slot roles: 0-7 normal, 8 exilus, 9 stance (melee only). */
const EXILUS_SLOT = 8;
const STANCE_SLOT = 9;
const isStance = (index) => index === STANCE_SLOT;
const hasStance = () => Boolean(weaponData.get(state.weapon)?.stancePolarity);
/** 8 standard slots, the Exilus slot and, on a melee weapon, the stance slot. */
const slotCount = () => MAX_SLOTS + 1 + (hasStance() ? 1 : 0);

/**
 * The board always shows every slot, empty ones included: the player sees how much room the
 * build has before touching anything, and the drop targets exist from the first render.
 */
function padSlots() {
  const total = slotCount();
  while (state.mods.length < total) state.mods.push({ name: '', rank: undefined });
  // Switching from melee to a rifle leaves one slot too many; drop it if it is empty.
  while (state.mods.length > total && !state.mods[state.mods.length - 1].name) state.mods.pop();
}

/** One copy of each mod: a saved or shared build from before the rule may carry two. */
function dedupeMods() {
  const seen = new Set();
  state.mods = state.mods.map((mod) => {
    if (!mod?.name) return { name: '', rank: undefined };
    if (seen.has(mod.name)) return { name: '', rank: undefined };
    seen.add(mod.name);
    return mod;
  });
}

/** Index of the slot already carrying this mod, ignoring one slot (the drop target). */
function equippedIndex(name, except = -1) {
  return state.mods.findIndex((entry, index) => index !== except && entry.name === name);
}

/** Briefly outline a slot, to show where the mod the player just tried to add already is. */
function flashSlot(index) {
  const row = $('slots')?.querySelectorAll('.slot')[index];
  if (!row) return;
  row.classList.remove('flash');
  void row.offsetWidth;
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 700);
}

function slotPolarity(index) {
  const forma = state.slotPolarities?.[index];
  if (forma) return forma;
  const weapon = weaponData.get(state.weapon);
  if (!weapon) return null;
  if (index === STANCE_SLOT) return weapon.stancePolarity ?? null;
  if (index === EXILUS_SLOT) return weapon.exilusPolarity ?? null;
  return weapon.polarities?.[index] ?? null;
}

/** Forma polarities cycle in the order the game offers them. */
const FORMA_ORDER = [null, 'madurai', 'vazarin', 'naramon', 'zenurik', 'unairu'];
function cycleForma(index) {
  state.slotPolarities = state.slotPolarities ?? [];
  const current = state.slotPolarities[index] ?? null;
  const next = FORMA_ORDER[(FORMA_ORDER.indexOf(current) + 1) % FORMA_ORDER.length];
  state.slotPolarities[index] = next;
  renderSlots();
}

/**
 * Mod capacity, as the game counts it: a mod costs `baseDrain + rank`, halved (rounded up)
 * when its polarity matches the slot's. Rank-30 weapons have 30 points, 60 with a reactor.
 */
function capacityInfo() {
  let total = state.reactor ? 60 : 30;
  let used = 0;
  state.mods.forEach((mod, index) => {
    if (!mod.name) return;
    const info = allMods.find((entry) => entry.name === mod.name);
    if (!info) return;
    const base = (info.baseDrain ?? 0) + (mod.rank ?? info.maxRank ?? 0);
    const matches = Boolean(info.polarity && slotPolarity(index) && info.polarity === slotPolarity(index));
    const cost = matches ? Math.ceil(base / 2) : base;
    // A stance mod works like an aura: it grants capacity instead of spending it, doubled
    // when its polarity matches the stance slot.
    if (isStance(index)) total += matches ? base * 2 : base;
    else used += cost;
  });
  return { used, total };
}

/**
 * Hover preview: the full card plus its complete text, the way the game shows a mod when
 * you point at it. One element, positioned next to the pointer and clamped to the viewport.
 */
function showPreview(modName, event) {
  const mod = allMods.find((entry) => entry.name === modName);
  const bubble = $('preview');
  if (!mod || !bubble) return;
  const drain = (mod.baseDrain ?? 0) + (mod.maxRank ?? 0);
  bubble.innerHTML = `
    ${mod.card ? `<img src="/card/${mod.card}" alt="" />` : ''}
    <div class="pv-body">
      <div class="pv-title"><span class="polarity" style="color:${polarityColor(mod.polarity)}">${glyph(mod.polarity)}</span>${mod.name}</div>
      <div class="pv-text">${(mod.description || '').replace(/\n/g, '<br>')}</div>
      <div class="pv-meta">
        <span>${mod.rarity ?? ''}</span>
        <span>drain ${drain}</span>
        <span>R${mod.maxRank}</span>
        ${lastContributions.get(mod.name) ? `<span class="pv-share">+${(lastContributions.get(mod.name) * 100).toFixed(0)}% dps</span>` : ''}
      </div>
    </div>`;
  bubble.hidden = false;
  positionPreview(event);
}

function positionPreview(event) {
  const bubble = $('preview');
  if (!bubble || bubble.hidden) return;
  const pad = 12;
  const rect = bubble.getBoundingClientRect();
  let x = (event?.clientX ?? 0) + 16;
  let y = (event?.clientY ?? 0) + 16;
  if (x + rect.width + pad > window.innerWidth) x = Math.max(pad, (event?.clientX ?? 0) - rect.width - 16);
  if (y + rect.height + pad > window.innerHeight) y = Math.max(pad, window.innerHeight - rect.height - pad);
  bubble.style.left = `${x}px`;
  bubble.style.top = `${y}px`;
}

const hidePreview = () => {
  const bubble = $('preview');
  if (bubble) bubble.hidden = true;
};

/** Wires hover + keyboard focus preview onto any element carrying data-mod. */
function bindPreview(root) {
  for (const element of root.querySelectorAll('[data-mod]')) {
    const name = element.dataset.mod;
    element.addEventListener('mouseenter', (event) => showPreview(name, event));
    element.addEventListener('mousemove', positionPreview);
    element.addEventListener('mouseleave', hidePreview);
    element.addEventListener('focus', (event) => {
      const rect = element.getBoundingClientRect();
      showPreview(name, { clientX: rect.left + rect.width / 2, clientY: rect.top });
    });
    element.addEventListener('blur', hidePreview);
  }
}

/** Mods that were not in the previous render, so their card can animate in. */
let previousMods = [];
let lastContributionsVersion = 0;

/** Index of the slot being dragged, shared by the slot grid and the library. */
let dragFrom = null;
let dragPayload = null;

function renderSlots() {
  const container = $('slots');
  container.innerHTML = '';
  padSlots();

  state.mods.forEach((mod, index) => {
    const info = allMods.find((entry) => entry.name === mod.name);
    const maxRank = info?.maxRank ?? 0;
    const exilus = index === EXILUS_SLOT;
    const stance = isStance(index);
    const row = document.createElement('div');
    row.className = `slot${mod.name ? ' filled' : ''}${exilus ? ' exilus' : ''}${stance ? ' stance' : ''}`;
    if (mod.name) row.dataset.mod = mod.name;
    const description = (info?.description ?? '').split('\n')[0];
    if (info?.polarity) row.style.borderLeftColor = polarityColor(info.polarity);
    if (info?.rarity) row.style.setProperty('--rarity', rarityColor(info.rarity));
    // Newcomers animate in, so dropping a mod feels like the card landing in the slot.
    if (mod.name && !previousMods.includes(mod.name)) row.classList.add('entering');
    const slotPolarityName = slotPolarity(index);
    const matches = Boolean(info?.polarity && slotPolarityName && info.polarity === slotPolarityName);
    const share = lastContributions.get(mod.name);
    const rank = mod.rank ?? maxRank;
    const realDrain = info
      ? matches ? Math.ceil(((info.baseDrain ?? 0) + rank) / 2) : (info.baseDrain ?? 0) + rank
      : 0;
    // Card layout: a small toolbar (rank + remove) above the name, then the mod's own text.
    row.innerHTML = `
      <div class="slot-top">
        <button class="polarity forma${state.slotPolarities?.[index] ? ' applied' : ''}" title="forma: cycle polarity"
                data-forma="${index}" style="color:${polarityColor(slotPolarityName)}">${glyph(slotPolarityName) || '·'}</button>
        <span class="rank-value">${mod.name ? `R${mod.rank ?? maxRank}` : ''}</span>
        <span class="drain${matches ? ' halved' : ''}">${mod.name && info ? realDrain : ''}</span>
        <span class="mod-share">${mod.name && share ? `+${(share * 100).toFixed(0)}%` : ''}</span>
        <button class="remove" data-index="${index}" title="remove">×</button>
      </div>
      ${info
        ? modCardMarkup(info, { showShare: true, share: share ?? 0, rank, drain: realDrain })
        : `<div class="slot-glyph" style="color:${polarityColor(slotPolarityName)}">${glyph(slotPolarityName) || '·'}</div>`}
      <div class="mod-name${mod.name ? ' sr-only' : ''}" data-index="${index}" tabindex="0" role="button"
           aria-label="edit mod">${mod.name ? mod.name.replace(/</g, '&lt;') : `<span class="placeholder">${exilus ? 'exilus slot' : 'empty slot'}</span>`}</div>
      ${mod.name && !info?.card ? `<div class="mod-desc">${description}</div>` : ''}
      <input class="rank" type="range" min="0" max="${maxRank}" value="${mod.rank ?? maxRank}" data-index="${index}" />`;

    // Drag a filled slot onto another to swap; drag it out of the grid to remove.
    if (mod.name) {
      row.draggable = true;
      row.addEventListener('dragstart', (event) => {
        dragFrom = { kind: 'slot', index };
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', mod.name);
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        dragFrom = null;
      });
    }
    row.addEventListener('dragover', (event) => {
      if (!dragFrom && !dragPayload) return;
      event.preventDefault();
      row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      row.classList.remove('drop-target');
      event.stopPropagation();
      applyDrop(index);
    });
    container.appendChild(row);
  });

  previousMods = state.mods.map((mod) => mod.name).filter(Boolean);
  $('mod-count').textContent = state.mods.filter((mod) => mod.name).length;
  const capacity = capacityInfo();
  const formas = (state.slotPolarities ?? []).filter(Boolean).length;
  const wasted = (state.slotPolarities ?? []).filter((polarity, index) => {
    const weapon = weaponData.get(state.weapon);
    const innate = index === STANCE_SLOT ? weapon?.stancePolarity
      : index === EXILUS_SLOT ? weapon?.exilusPolarity
      : weapon?.polarities?.[index];
    return polarity && innate && polarity === innate;
  }).length;
  const over = capacity.used > capacity.total;
  $('capacity').innerHTML = `<div class="cap-bar${over ? ' over' : ''}">
      <i style="width:${Math.min(100, (capacity.used / capacity.total) * 100).toFixed(0)}%"></i>
    </div>
    <span class="cap-text${over ? ' over' : ''}">${capacity.used} / ${capacity.total}</span>
    ${formas ? `<span class="badge${wasted ? ' warn' : ''}" title="formas applied${wasted ? ` (${wasted} redundant: same as the slot's innate polarity)` : ''}">${formas}F</span>` : ''}`;
  // Dropping a dragged slot outside any card removes it.
  container.ondragover = (event) => {
    if (dragFrom?.kind === 'slot') event.preventDefault();
  };
  container.ondrop = (event) => {
    if (dragFrom?.kind !== 'slot') return;
    event.preventDefault();
    const index = dragFrom.index;
    dragFrom = null;
    // Dragging a slot out of the grid clears it; the slot itself stays.
    state.mods[index] = { name: '', rank: undefined };
    renderSlots();
    recalc();
  };
  renderLibrary();

  // The name is a label (so it can wrap) that becomes the input while editing.
  // Forma buttons must not start a drag.
  container.querySelectorAll('[data-forma]').forEach((button) => {
    button.addEventListener('mousedown', (event) => event.stopPropagation());
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      cycleForma(Number(button.dataset.forma));
    });
  });
  container.querySelectorAll('.mod-name').forEach((label) => {
    const edit = () => {
      const index = Number(label.dataset.index);
      const input = document.createElement('input');
      input.className = 'mod-name editing';
      input.setAttribute('list', 'mod-list');
      input.value = state.mods[index].name ?? '';
      input.dataset.index = String(index);
      label.replaceWith(input);
      input.focus();
      input.select();
      input.addEventListener('input', (event) => {
        state.mods[index].name = event.target.value;
        state.mods[index].rank = undefined;
        renderModList(event.target.value.toLowerCase());
      });
      // Typing the name of a mod that is already in another slot would duplicate it.
      const commit = () => {
        const index = Number(input.dataset.index);
        const typed = (state.mods[index]?.name ?? '').trim();
        const already = typed ? equippedIndex(typed, index) : -1;
        if (already >= 0) {
          state.mods[index] = { name: '', rank: undefined };
          dragWarning = `${typed} is already equipped: a build can only carry one copy.`;
          renderSlots();
          recalc();
          flashSlot(already);
          return;
        }
        renderSlots();
        recalc();
      };
      input.addEventListener('change', commit);
      input.addEventListener('blur', commit);
    };
    label.addEventListener('click', edit);
    label.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        edit();
      }
    });
  });
  container.querySelectorAll('.rank').forEach((input) => {
    input.addEventListener('input', (event) => {
      const index = Number(event.target.dataset.index);
      state.mods[index].rank = Number(event.target.value);
      event.target.parentElement.querySelector('.rank-value').textContent = `R${event.target.value}`;
      recalc();
    });
  });
  container.querySelectorAll('.remove').forEach((button) => {
    button.onclick = () => {
      // Empty the slot instead of removing it: the board keeps its shape.
      state.mods[Number(button.dataset.index)] = { name: '', rank: undefined };
      renderSlots();
      recalc();
    };
  });
}

/**
 * Exilus mods only fit the Exilus slot, and nothing else fits it. WFCD has no Exilus flag, so
 * this comes from the wiki's "Exilus Weapon Mods" category, carried through the snapshot.
 * Returns the reason when the drop is illegal, or null when it is fine.
 */
function exilusConflict(name, index) {
  if (!name) return null;
  const info = allMods.find((mod) => mod.name === name) ?? null;
  if (!info) return null;
  if (info.isExilus && index !== EXILUS_SLOT) {
    return `${name} is an Exilus mod: it only fits the Exilus slot.`;
  }
  if (!info.isExilus && index === EXILUS_SLOT) {
    return `${name} cannot go in the Exilus slot.`;
  }
  return null;
}

/** Moves whatever was dragged into `index`. */
function applyDrop(index) {
  if (dragFrom?.kind === 'slot') {
    const from = dragFrom.index;
    if (from === index) return;
    const conflict = exilusConflict(state.mods[from]?.name, index)
      ?? exilusConflict(state.mods[index]?.name, from);
    if (conflict) {
      dragWarning = conflict;
      dragFrom = null;
      dragPayload = null;
      renderSlots();
      recalc();
      return;
    }
    const a = state.mods[from];
    state.mods[from] = state.mods[index] ?? { name: '', rank: undefined };
    state.mods[index] = a;
  } else if (dragFrom?.kind === 'library' && dragPayload) {
    const already = equippedIndex(dragPayload, index);
    if (already >= 0) {
      dragWarning = `${dragPayload} is already equipped: a build can only carry one copy.`;
      dragFrom = null;
      dragPayload = null;
      renderSlots();
      recalc();
      flashSlot(already);
      return;
    }
    const conflict = exilusConflict(dragPayload, index);
    if (conflict) {
      dragWarning = conflict;
      dragFrom = null;
      dragPayload = null;
      renderSlots();
      recalc();
      return;
    }
    state.mods[index] = { name: dragPayload, rank: undefined };
  }
  dragFrom = null;
  dragPayload = null;
  dragWarning = '';
  renderSlots();
  recalc();
}

/**
 * The mod library: the mods that fit the weapon, as a searchable grid of cards. Clicking one
 * fills the first empty slot; dragging one drops it wherever you want.
 */
function renderLibrary() {
  const query = ($('mod-filter')?.value ?? '').toLowerCase();
  const polarity = $('filter-polarity')?.value ?? '';
  const sort = $('filter-sort')?.value ?? 'name';
  const typeFilter = $('filter-type')?.value ?? '';
  const rarityFilter = $('filter-rarity')?.value ?? '';
  // Fusion cores and other inventory noise are not equippable mods.
  const JUNK = /^(Ancient Fusion Core|Flawed )/i;
  const list = allMods
    .filter((mod) => !JUNK.test(mod.name))
    // Conclave mods are PvP-only; they never fit a PvE build.
    .filter((mod) => !mod.conclave)
    .filter((mod) => !polarity || String(mod.polarity ?? '').toLowerCase() === polarity)
    .filter((mod) => !typeFilter || (mod.classes ?? []).some((name) => String(name).toLowerCase() === typeFilter))
    .filter((mod) => !rarityFilter || String(mod.rarity ?? '').toLowerCase() === rarityFilter)
    .filter((mod) => !query || mod.name.toLowerCase().includes(query) || (mod.description ?? '').toLowerCase().includes(query))
    .sort((a, b) =>
      sort === 'share'
        ? (lastContributions.get(b.name) ?? 0) - (lastContributions.get(a.name) ?? 0)
        : a.name.localeCompare(b.name),
    );
  $('lib-count').textContent = String(list.length);
  if (!state.weapon) {
    $('mod-list').innerHTML = '<p class="hint">Pick a weapon to see the mods that fit it.</p>';
    return;
  }

  $('mod-list').innerHTML = list
    .slice(0, 120)
    .map(
      (mod) => `<button class="lib-card${state.mods.some((entry) => entry.name === mod.name) ? ' equipped' : ''}"
        draggable="true" data-mod="${mod.name.replace(/"/g, '&quot;')}"
        style="border-left-color:${polarityColor(mod.polarity)}">
        ${modCardMarkup(mod, { equipped: state.mods.some((entry) => entry.name === mod.name) })}
      </button>`,
    )
    .join('') || '<p class="hint">No mod matches that search.</p>';

  for (const card of $('mod-list').querySelectorAll('.lib-card')) {
    const name = card.dataset.mod;
    card.addEventListener('dragstart', (event) => {
      dragFrom = { kind: 'library' };
      dragPayload = name;
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('text/plain', name);
    });
    card.addEventListener('dragend', () => {
      dragFrom = null;
      dragPayload = null;
    });
    card.addEventListener('click', () => {
      hidePreview();
      // One copy per build: clicking an equipped mod points at its slot instead of adding it.
      const already = equippedIndex(name);
      if (already >= 0) {
        flashSlot(already);
        return;
      }
      const empty = state.mods.findIndex((entry) => !entry.name);
      if (empty < 0) return;
      state.mods[empty] = { name, rank: undefined };
      renderSlots();
      recalc();
    });
  }
}

const renderModList = debounce(() => renderLibrary(), 80);

/** The buff picker exists twice (Build tab, brute force); both edit the same `state.buffs`. */
function renderBuffList() {
  for (const [listId, countId] of [['buff-list', 'buff-count'], ['find-buff-list', 'find-buff-count']]) {
    $(listId).innerHTML = allBuffs
      .map(
        (buff) => `<label>
          <input type="checkbox" value="${buff.id}" ${state.buffs.includes(buff.id) ? 'checked' : ''} />
          <span>${buff.ability}${buff.augments ? ' †' : buff.subsumable ? ' ‡' : ''} <span class="frame">${buff.frame}</span></span>
        </label>`,
      )
      .join('');
    $(countId).textContent = state.buffs.length ? String(state.buffs.length) : '';
    $(listId).querySelectorAll('input').forEach((input) => {
      input.addEventListener('change', () => {
        state.buffs = [...$(listId).querySelectorAll('input:checked')].map((element) => element.value);
        renderBuffList();
        recalc();
      });
    });
  }
}

/** Arch-guns hold a Primary and a Secondary arcane; every other weapon holds one. */
const isArchgun = (name) => weaponData.get(name)?.category === 'archgun';

/** Writes the arcane fields of both tabs from state, and shows the second slot on arch-guns. */
function renderArcaneFields() {
  const [first, second] = [state.arcanes?.[0]?.name ?? '', state.arcanes?.[1]?.name ?? ''];
  const buildArch = isArchgun(state.weapon);
  $('arcane-input').value = first;
  $('arcane2-input').value = second;
  $('arcane2-field').hidden = !buildArch;
  $('arcane-label').textContent = buildArch ? 'Primary arcane (Archgun Arcane Adapter)' : 'Weapon arcane';
  const findArch = isArchgun($('find-weapon').value.trim() || state.weapon);
  $('find-arcane').value = first;
  $('find-arcane2').value = second;
  $('find-arcane2-field').hidden = !findArch;
  $('find-arcane-label').textContent = findArch ? 'Primary arcane (arch-gun)' : 'Weapon arcane';
}

/** Arcanes from a pair of fields: the second only counts on an arch-gun. */
function setArcanes(first, second, weapon) {
  const names = isArchgun(weapon) ? [first, second] : [first];
  state.arcanes = names.map((name) => name.trim()).filter(Boolean).map((name) => ({ name }));
  renderArcaneFields();
  recalc();
}

/** The brute force may target another weapon than the Build tab: list the arcanes that fit it. */
async function refreshFindArcanes() {
  const weapon = $('find-weapon').value.trim() || state.weapon;
  if (!weapon) return;
  try {
    const arcanes = await getJson(`/api/arcanes?weapon=${encodeURIComponent(weapon)}`);
    $('find-arcane-list').innerHTML = arcanes.map((arcane) => `<option value="${arcane.name}">${(arcane.description || '').split('\n')[0].slice(0, 44)}</option>`).join('');
  } catch {
    /* the list is a convenience; typing a name still works */
  }
  renderArcaneFields();
}

function renderWeaponMeta(result) {
  if (!result?.weapon) {
    $('weapon-meta').innerHTML = '';
    const empty = document.getElementById('weapon-desc');
    if (empty) { empty.textContent = ''; empty.hidden = true; }
    $('mode-field').hidden = true;
    return;
  }
  const weapon = result.weapon;
  // `type` is usually the first mod class, so don't print it twice.
  const classes = weapon.modClasses.filter((name) => name !== weapon.type);
  const meta = weaponData.get(state.weapon);
  $('weapon-art').innerHTML = meta?.image ? `<img src="/img/${meta.image}" alt="" />` : '';
  // The weapon's artwork, blurred, becomes the board's backdrop.
  const board = document.querySelector('.board');
  if (board) {
    board.style.setProperty('--silhouette', meta?.image ? `url("/img/${meta.image}")` : 'none');
  }
  // The weapon's flavour text, the way the game prints it under the build name.
  const description = String(meta?.description ?? '').trim();
  // Forma count, the way the arsenal shows it next to mastery rank.
  const formas = (state.slotPolarities ?? []).filter(Boolean).length;
  $('weapon-meta').innerHTML = `<span class="chip">${weapon.type}</span>
    <span class="chip">MR ${weapon.masteryRank}</span>
    ${formas ? `<span class="chip forma">${formas} forma${formas === 1 ? '' : 's'}</span>` : ''}
    <span class="chip">${(weapon.disposition ?? 1).toFixed(1)}★ riven</span>
    ${classes.length ? `<span class="chip">${classes.join(' / ')}</span>` : ''}`;
  const desc = document.getElementById('weapon-desc');
  if (desc) {
    desc.textContent = description;
    desc.hidden = !description;
    desc.title = description;
  }
  const modes = weapon.modes ?? [];
  $('mode-field').hidden = modes.length === 0;
  if (modes.length) {
    $('mode-select').innerHTML = ['<option value="">arsenal (default)</option>', ...modes.map((mode) => `<option value="${mode}">${mode}</option>`)].join('');
    $('mode-select').value = state.mode;
  }
}

function renderResults(result) {
  if (result.error) {
    $('stats').innerHTML = `<p class="error">${result.error}${result.suggestions?.length ? ` — did you mean ${result.suggestions.join(', ')}?` : ''}</p>`;
    $('weapon-summary').innerHTML = '';
    $('damage-bars').innerHTML = '';
    $('contributions').innerHTML = '';
    $('target-report').innerHTML = '';
    $('notes').innerHTML = '';
    return;
  }
  const target = result.target;
  const dot = target?.dot ?? [];
  const dotDps = dot.reduce((sum, entry) => sum + entry.dps, 0);
  const critAvg = 1 + result.critChance * (result.critMultiplier - 1);

  // Headline numbers, like the game's "total damage" block.
  $('weapon-summary').innerHTML = `
    <div class="kpi"><span>damage / shot</span><b>${fmt(result.averageShotDamage, 0)}</b></div>
    <div class="kpi" title="Damage per second while the magazine lasts"><span>burst dps</span><b>${fmt(result.burstDps, 0)}</b></div>
    <div class="kpi" title="Average DPS including reloads"><span>sustained</span><b>${fmt(result.sustainedDps, 0)}</b></div>
    ${target ? `<div class="kpi accent"><span>ttk lv${target.level}</span><b>${target.timeToKill === null ? '—' : `${fmt(target.timeToKill, 2)}s`}</b></div>` : ''}
  `;

  // Stats as a dense label/value list, the way the arsenal presents them.
  const rows = [
    ['section', 'Weapon'],
    ['Crit ch.', pct(result.critChance)],
    ['Crit dmg', `×${fmt(result.critMultiplier, 2)}`],
    ['Fire rate', `${fmt(result.fireRate, 2)}/s`],
    ['Magazine', fmt(result.magazineSize)],
    ['Multishot', `×${fmt(result.multishot, 2)}`],
    ['Status', pct(result.statusChance)],
    ['Reload', `${fmt(result.reloadTime, 2)}s`],
    ['section', 'Against target'],
  ];
  for (const entry of result.elements.slice().sort((a, b) => b.share - a.share)) {
    rows.push([entry.type, `${fmt(result.damage[entry.type], 1)}  (${pct(entry.share)})`]);
  }
  rows.push(['section', 'Result']);
  rows.push(['Avg hit', fmt(result.averageShotDamage, 0)]);
  rows.push(['Burst dps', fmt(result.burstDps, 0)]);
  rows.push(['Sust. dps', fmt(result.sustainedDps, 0)]);
  if (dot.length) rows.push(['Status dps', fmt(dotDps, 0)]);
  if (result.critVariance && result.critVariance.pellets >= 2) {
    rows.push(['Crit spread', `${result.critVariance.expectedCrits.toFixed(1)} of ${result.critVariance.pellets.toFixed(1)} · ${pct(result.critVariance.atLeastOneCrit)} land one`]);
  }
  if (target) {
    rows.push(['Shots', fmt(target.shotsToKill, 1)]);
    rows.push(['TTK', target.timeToKill === null ? '—' : `${fmt(target.timeToKill, 2)}s`]);
  }
  $('stats').innerHTML = rows
    .map(([label, value]) =>
      label === 'section'
        ? `<div class="section">${value}</div>`
        : `<div class="k">${label}</div><div class="v">${value}</div>`,
    )
    .join('');

  $('damage-bars').innerHTML = result.elements
    .slice()
    .sort((a, b) => b.share - a.share)
    .map(
      (element) => `<div class="bar-row">
        <span class="bar-label">${element.type}</span>
        <div class="bar"><i style="width:${(element.share * 100).toFixed(1)}%;background:${ELEMENT_COLORS[element.type] ?? '#888'}"></i></div>
        <span class="bar-value">${fmt(result.damage[element.type], 1)} <small>${pct(element.share)}</small></span>
      </div>`,
    )
    .join('');

  // Per-mod contribution: the share of the burst DPS that disappears without that mod.
  const contributions = result.contributions ?? [];
  lastContributions.clear();
  for (const entry of contributions) lastContributions.set(entry.name, entry.deltaPct);
  // Refresh the "+62%" badge on each slot card without re-rendering the grid.
  document.querySelectorAll('#slots .slot').forEach((slot, index) => {
    const badge = slot.querySelector('.mod-share');
    const name = state.mods[index]?.name;
    if (!badge) return;
    const share = name ? lastContributions.get(name) : undefined;
    badge.textContent = share && share > 0.005 ? `+${(share * 100).toFixed(0)}%` : '';
  });
  $('contributions').innerHTML = contributions.length
    ? contributions
        .slice()
        .sort((a, b) => b.deltaPct - a.deltaPct)
        .map(
          (entry) => `<div class="bar-row" title="${entry.name}${entry.conditional ? ' (conditional: activate its stacks to see its value)' : ''}">
            <span class="bar-label" title="${entry.name}">${entry.name.length > 14 ? `${entry.name.slice(0, 13)}…` : entry.name}</span>
            <div class="bar"><i style="width:${Math.max(0, Math.min(100, entry.deltaPct * 100)).toFixed(1)}%;background:var(--accent)"></i></div>
            <span class="bar-value">${entry.deltaPct > 0 ? `+${pct(entry.deltaPct)}` : entry.conditional ? 'conditional' : pct(entry.deltaPct)}</span>
          </div>`,
        )
        .join('')
    : '<p class="hint">Add mods to see what each one contributes.</p>';

  if (target) {
    $('target-report').innerHTML = `
      <div class="meta">
        <span class="chip">${target.name}</span>
        <span class="chip">${fmt(target.health)} hp</span>
        ${target.shield ? `<span class="chip">${fmt(target.shield)} shields</span>` : ''}
        ${target.armor ? `<span class="chip">${fmt(target.armor)} armor</span>` : ''}
        ${target.pools.map((pool) => `<span class="chip subtle">${pool.type}</span>`).join('')}
      </div>
      <table class="breakdown">
        <thead><tr><th>type</th><th>raw</th><th>vs health</th><th>dmg</th><th>procs</th></tr></thead>
        <tbody>${target.breakdown
          .slice()
          .sort((a, b) => b.toHealth - a.toHealth)
          .map(
            (entry) => `<tr><td><i class="dot" style="background:${ELEMENT_COLORS[entry.type] ?? '#888'}"></i>${entry.type}</td>
              <td>${fmt(entry.raw, 1)}</td><td>×${entry.healthMultiplier.toFixed(2)}</td>
              <td>${fmt(entry.toHealth, 1)}</td><td>${pct(entry.procShare)}</td></tr>`,
          )
          .join('')}</tbody>
      </table>
      ${dot.length ? `<table class="breakdown">
        <thead><tr><th>status</th><th>proc/s</th><th>tick</th><th>ticks</th><th>dps</th></tr></thead>
        <tbody>${dot
          .slice()
          .sort((a, b) => b.dps - a.dps)
          .map(
            (entry) => `<tr><td><i class="dot" style="background:${ELEMENT_COLORS[entry.type] ?? '#888'}"></i>${entry.type}</td>
              <td>${fmt(entry.procsPerSecond, 2)}</td><td>${fmt(entry.tickDamage, 1)}</td><td>${entry.ticks}</td>
              <td>${fmt(entry.dps, 0)}</td></tr>`,
          )
          .join('')}</tbody></table>` : ''}`;
  } else {
    $('target-report').innerHTML = '';
  }

  const notes = [...result.warnings];
  if (result.unsupportedMods.length) notes.push(`Unknown mod effects (lower bound): ${result.unsupportedMods.join(', ')}`);
  if (result.inactiveConditions.length) notes.push(`${result.inactiveConditions.length} conditional effect(s) inactive`);
  if (result.weapon.mode) notes.push(`Using fire mode: ${result.weapon.mode}`);
  if (result.incarnon?.length) notes.push(`Incarnon: ${result.incarnon.join(' / ')}`);
  if (result.riven?.length) notes.push(`Riven: ${result.riven.join(', ')}`);
  // A refused drop has no effect on the build, so it is reported on its own.
  if (dragWarning) notes.unshift(dragWarning);
  // An exilus mod sitting outside the exilus slot is an illegal build; flag it even when it
  // arrived from a shared link rather than a drag.
  for (const [index, mod] of state.mods.entries()) {
    const conflict = exilusConflict(mod?.name, index);
    if (conflict) notes.push(conflict);
  }
  $('notes').innerHTML = notes.map((note) => `<p>· ${note}</p>`).join('');
}

/** ---------- calculation ---------- */

/** The enemy's actual level: the Steel Path adds 100 to a node's level. */
const effectiveLevel = (level, steelPath, nodeLevel) => Number(level) + (steelPath && nodeLevel ? 100 : 0);

function renderSteelPath() {
  $('sp-box').classList.toggle('on', Boolean(state.steelPath));
  $('sp-summary').innerHTML = state.steelPath
    ? `<span class="chip sp">lv ${effectiveLevel(state.level, true, state.steelPathNodeLevel)}</span><span class="chip">health &amp; shields ×2.5</span>`
    : '';
}

function buildPayload(extra = {}) {
  return {
    ...state,
    level: effectiveLevel(state.level, state.steelPath, state.steelPathNodeLevel),
    mods: state.mods.filter((mod) => mod.name),
    riven: state.riven ? { ...state.riven, roll: state.rivenRoll, rank: state.rivenRank } : null,
    ...extra,
  };
}

async function postCalc(payload) {
  const response = await fetch('/api/calc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function recalc() {
  saveToUrl();
  if (!state.weapon) {
    $('stats').innerHTML = '<p class="hint">Pick a weapon to start.</p>';
    for (const id of ['weapon-summary', 'damage-bars', 'contributions', 'target-report', 'notes']) $(id).innerHTML = '';
    return;
  }
  const id = ++calculationId;
  const result = await postCalc(buildPayload({ contributions: true }));
  if (id !== calculationId) return; // a newer request is in flight
  renderWeaponMeta(result);
  renderResults(result);
  // The target report below lists hp, armour and health types; this line only flags the mode.
  $('enemy-meta').innerHTML = result.target && state.steelPath
    ? `<span class="chip sp">Steel Path · lv ${result.target.level ?? effectiveLevel(state.level, true, state.steelPathNodeLevel)}</span>`
    : '';
}

/** ---------- compare ---------- */

async function runCompare() {
  if (!state.weapon) {
    $('compare-out').innerHTML = '<p class="hint">Pick a weapon in Build first.</p>';
    return;
  }
  const bMods = parseNameList($('b-mods').value);
  const bWeapon = $('b-weapon').value.trim() || state.weapon;
  const bElement = parseElementBonus($('b-element').value);
  const bArcane = $('b-arcane').value.trim();

  const [a, b] = await Promise.all([
    postCalc(buildPayload({ contributions: false })),
    postCalc({
      ...buildPayload({ contributions: false }),
      weapon: bWeapon,
      mods: bMods.length ? bMods : buildPayload().mods,
      elementBonus: $('b-element').value.trim() ? bElement : state.elementBonus,
      arcanes: bArcane ? [{ name: bArcane }] : state.arcanes,
    }),
  ]);

  if (a.error || b.error) {
    $('compare-out').innerHTML = `<p class="error">${a.error ?? b.error}</p>`;
    return;
  }
  const rows = [
    ['Damage / projectile', fmt(a.projectileTotal, 1), fmt(b.projectileTotal, 1), ratioCell(a.projectileTotal, b.projectileTotal)],
    ['Burst DPS', fmt(a.burstDps, 0), fmt(b.burstDps, 0), ratioCell(a.burstDps, b.burstDps)],
    ['Sustained DPS', fmt(a.sustainedDps, 0), fmt(b.sustainedDps, 0), ratioCell(a.sustainedDps, b.sustainedDps)],
    ['Elements', a.elements.map((e) => `${e.type} ${pct(e.share)}`).join(', '), b.elements.map((e) => `${e.type} ${pct(e.share)}`).join(', '), ''],
    ['Time to kill', a.target?.timeToKill != null ? `${fmt(a.target.timeToKill, 2)}s` : '—', b.target?.timeToKill != null ? `${fmt(b.target.timeToKill, 2)}s` : '—', ratioCell(b.target?.timeToKill ?? 0, a.target?.timeToKill ?? 0)],
  ];
  $('compare-out').innerHTML = `<table class="breakdown compare">
    <thead><tr><th></th><th>A (current)</th><th>B</th><th>B vs A</th></tr></thead>
    <tbody>${rows.map(([label, left, right, delta]) => `<tr><td>${label}</td><td>${left}</td><td>${right}</td><td class="delta">${delta}</td></tr>`).join('')}</tbody>
  </table>`;
}

/** ratio of B against A, as a signed percentage. */
function ratioCell(b, a) {
  if (!a || !b || !Number.isFinite(a) || !Number.isFinite(b)) return '—';
  const change = (b / a - 1) * 100;
  const cls = change > 0.5 ? 'up' : change < -0.5 ? 'down' : '';
  return `<span class="${cls}">${change > 0 ? '+' : ''}${change.toFixed(1)}%</span>`;
}

/** ---------- find a build ---------- */

const findMethod = () => document.querySelector('input[name="find-method"]:checked')?.value ?? 'search';

function renderFindMethod() {
  const brute = findMethod() === 'bruteforce';
  $('tab-find').classList.toggle('find-brute', brute);
  $('find-must-label').textContent = brute ? 'Fixed mods (always kept, :R3 for a rank)' : 'Must include';
  $('find-run').textContent = brute ? 'brute force' : 'search';
  $('find-sp-box').classList.toggle('on', $('find-sp').checked);
}

/** "Serration, Hunter Munitions:R3" -> [{ name, rank? }] */
const parseFixed = (text) => text.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
  const match = /^(.*?)[\s:]+R(\d+)$/i.exec(entry);
  return match ? { name: match[1].trim(), rank: Number(match[2]) } : { name: entry };
});

async function runFind() {
  const weapon = $('find-weapon').value.trim() || state.weapon;
  if (!weapon) {
    $('find-out').innerHTML = '<p class="hint">Pick a weapon in Build first, or type one above.</p>';
    return;
  }
  if (findMethod() === 'bruteforce') return runBruteForce(weapon);
  const chooseIncarnon = $('find-incarnon').checked;
  const base = buildPayload({ contributions: false });
  // The search chooses the mods (and, if asked, the evolutions): do not pin them here.
  delete base.mods;
  if (chooseIncarnon) delete base.incarnon;
  const names = (text) => text.split(',').map((name) => name.trim()).filter(Boolean);
  const payload = {
    weapon,
    objective: $('find-objective').value,
    enemy: $('find-enemy').value.trim() || 'Bombard',
    level: findLevel(),
    steelPath: $('find-sp').checked,
    capacity: Number($('find-capacity').value) || 60,
    maxForma: $('find-forma').value === '' ? null : Number($('find-forma').value),
    mustInclude: names($('find-must').value),
    exclude: names($('find-exclude').value),
    chooseIncarnon,
    base,
  };
  $('find-out').innerHTML = '<p class="hint">searching…</p>';
  const response = await fetch('/api/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (result.error) {
    $('find-out').innerHTML = `<p class="error">${result.error}</p>`;
    return;
  }
  renderFind(result);
}

const findLevel = () => effectiveLevel(Number($('find-level').value) || 150, $('find-sp').checked, $('find-sp-offset').checked);

async function runBruteForce(weapon) {
  const base = buildPayload({ contributions: false });
  // Mods are searched; everything else on the Build tab (buffs, strength, Incarnon, arcane,
  // riven, debuffs) is the player's input and goes in as it stands.
  delete base.mods;
  delete base.level;
  delete base.steelPath;
  const payload = {
    weapon,
    objective: $('find-objective').value,
    enemy: $('find-enemy').value.trim() || 'Bombard',
    level: findLevel(),
    steelPath: $('find-sp').checked,
    capacity: Number($('find-capacity').value) || 60,
    maxForma: $('find-forma').value === '' ? null : Number($('find-forma').value),
    fixed: parseFixed($('find-must').value),
    exclude: $('find-exclude').value.split(',').map((name) => name.trim()).filter(Boolean),
    maxEvaluations: Number($('find-max-evals').value) || undefined,
    base,
  };
  const started = performance.now();
  const button = $('find-run');
  button.disabled = true;
  $('find-out').innerHTML = `<div class="working">Enumerating every combination on every core… <span id="find-clock">0s</span></div>`;
  const clock = setInterval(() => {
    const el = $('find-clock');
    if (el) el.textContent = `${((performance.now() - started) / 1000).toFixed(0)}s`;
  }, 500);
  try {
    const response = await fetch('/api/bruteforce', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (result.error) {
      $('find-out').innerHTML = `<p class="error">${result.error}</p>`;
      return;
    }
    renderFind(result);
  } catch (error) {
    $('find-out').innerHTML = `<p class="error">${String(error.message ?? error)}</p>`;
  } finally {
    clearInterval(clock);
    button.disabled = false;
  }
}

function renderFind(result) {
  const builds = result.builds ?? [];
  const target = `${result.weapon} vs ${result.enemy} level ${result.level}${result.steelPath ? ' <span class="chip sp">Steel Path</span>' : ''}`;
  const brute = result.combinations !== undefined;
  $('find-out').innerHTML = `
    ${brute
      ? `<div class="stat-line">
          <span class="chip">${fmt(result.combinations, 0)} combinations</span>
          <span class="chip">${fmt(result.evaluated, 0)} builds scored</span>
          <span class="chip">${result.workers} threads</span>
          <span class="chip">${(result.elapsedMs / 1000).toFixed(1)}s</span>
          <span class="chip${result.exhaustive ? ' fixed' : ''}">${result.exhaustive ? `exhaustive: all ${result.candidates.length} mods` : `shortlist of ${result.candidates.length} mods`}</span>
        </div>
        <p class="hint">${target} · ${fmt(result.health, 0)} hp · ${fmt(result.shield, 0)} shields · ${fmt(result.armor, 0)} armor</p>`
      : `<p class="hint">${result.evaluated} builds tried in ${result.elapsedMs} ms · ${target}</p>`}
    ${builds
      .map((build, index) => `<div class="build-card">
        <div class="build-head">
          <div>
            <b>${index + 1}. ${build.timeToKill === null ? 'cannot kill' : `${fmt(build.timeToKill, 2)}s`}</b>
            <span class="meta">
              <span class="chip">${fmt(build.totalDps, 0)} dps</span>
              <span class="chip">${fmt(build.sustainedDps, 0)} direct</span>
              <span class="chip">crit ${pct(build.critChance)} ×${fmt(build.critMultiplier, 1)}</span>
              <span class="chip">status ${pct(build.statusChance)}</span>
              <span class="chip">×${fmt(build.multishot, 2)} multishot</span>
              <span class="chip${build.capacityUsed > build.capacity ? ' warn' : ''}">${build.capacityUsed}/${build.capacity} cap</span>
              ${build.formaNeeded ? `<span class="chip">${build.formaNeeded} forma</span>` : ''}
            </span>
          </div>
          <button class="ghost" data-find-load="${index}">load</button>
        </div>
        <div class="build-mods">${build.mods
          .map((mod) => `<span class="chip${mod.fixed ? ' fixed' : ''}" ${mod.fixed ? 'title="fixed mod"' : ''}>${mod.name}${mod.rank < 99 ? ` R${mod.rank}` : ''}</span>`)
          .join('')}${build.exilus ? `<span class="chip fixed">${build.exilus.name} R${build.exilus.rank} · exilus</span>` : ''}</div>
        ${build.incarnonNames?.length ? `<div class="meta">${build.incarnonNames.map((name) => `<span class="chip subtle">${name}</span>`).join('')}</div>` : ''}
        ${build.partialMods?.length ? `<p class="hint">lower bound: ${build.partialMods.join(', ')}</p>` : ''}
        ${build.warnings?.length ? `<p class="hint">${build.warnings.join(' · ')}</p>` : ''}
      </div>`)
      .join('') || '<p class="hint">No build fits those limits.</p>'}
    ${(result.assumptions ?? []).map((line) => `<p class="hint">· ${line}</p>`).join('')}
    ${(result.notes ?? []).map((line) => `<p class="hint">· ${line}</p>`).join('')}
    ${brute && !result.exhaustive && result.leftOut?.length ? `<p class="hint">· Left out: ${result.leftOut.join(', ')}</p>` : ''}`;

  for (const button of $('find-out').querySelectorAll('[data-find-load]')) {
    button.onclick = async () => {
      const build = builds[Number(button.dataset.findLoad)];
      if (!build) return;
      // The search counted capacity with the Forma it decided to spend; put those on the
      // matching slots, or the loaded build would show as over capacity.
      const innate = weaponData.get(result.weapon)?.polarities ?? [];
      const slotPolarities = build.mods.map((mod, index) =>
        mod.halvedByPolarity && innate[index] !== mod.polarity ? mod.polarity : null);
      state = {
        ...state,
        weapon: result.weapon,
        enemy: result.enemy,
        // The answer carries the enemy's actual level; keep the Build tab's node-level reading.
        level: result.steelPath && state.steelPathNodeLevel ? result.level - 100 : result.level,
        steelPath: Boolean(result.steelPath),
        reactor: result.capacity >= 60,
        slotPolarities,
        mods: [
          ...build.mods.map((mod) => ({ name: mod.name, rank: mod.rank })),
          ...(build.exilus ? [{ name: build.exilus.name, rank: build.exilus.rank }] : []),
        ],
        // The brute force takes the Incarnon evolutions as input, so it returns none.
        incarnon: build.incarnon ? [...build.incarnon] : state.incarnon,
      };
      await loadModsForWeapon();
      syncInputs();
      renderSlots();
      showTab('build');
      recalc();
    };
  }
}

/** ---------- abilities ---------- */

async function runAbility() {
  const name = $('ability-select').value;
  if (!name) return;
  state.lastAbility = name;
  saveToUrl();
  const params = new URLSearchParams({
    name,
    strength: $('ability-strength').value,
    enemy: $('ability-enemy').value.trim() || 'Bombard',
    level: $('ability-level').value || '150',
    ...($('ability-sp').checked ? { steelPath: '1' } : {}),
  });
  try {
    renderAbility(await getJson(`/api/ability?${params}`));
  } catch (error) {
    $('ability-out').innerHTML = `<p class="error">${String(error.message ?? error)}</p>`;
  }
}

function renderAbility(result) {
  $('ability-out').innerHTML = `
    <div class="build-head">
      <div>
        <h3>${result.frame} — ${result.ability}${result.damageType ? ` <span class="chip">${result.damageType}</span>` : ''}</h3>
        <span class="meta">
          <span class="chip">${fmt(result.baseDamage, 0)}${result.perSecond ? '/s' : ''} at 100%</span>
          <span class="chip">${fmt(result.scaledDamage, 0)}${result.perSecond ? '/s' : ''} at ${fmt(result.strength, 0)}%</span>
          ${result.durationSeconds ? `<span class="chip">${result.durationSeconds}s</span>` : ''}
          ${result.radius ? `<span class="chip">${fmt(result.radius, 1)} m</span>` : ''}
          ${result.armorStrip
            ? `<span class="chip">strip ${result.armorStrip.fraction !== null ? `${(result.armorStrip.fraction * 100).toFixed(0)}%` : `${fmt(result.armorStrip.points, 0)} pts`}</span>`
            : ''}
        </span>
      </div>
    </div>
    ${result.ticks ? `<p class="hint">plus ${fmt(result.ticks.perSecond, 0)}/s ${result.ticks.damageType ?? ''} for ${result.ticks.seconds}s</p>` : ''}
    <div class="kpi-row">
      <div class="kpi"><span>full cast</span><b>${fmt(result.totalDamage, 0)}</b></div>
      ${result.target ? `<div class="kpi"><span>on ${result.target.enemy} lv${result.target.level}</span><b>${fmt(result.target.perCast, 0)}</b></div>` : ''}
      ${result.target ? `<div class="kpi"><span>health modifier</span><b>×${fmt(result.target.healthMultiplier, 2)}</b></div>` : ''}
      ${result.target ? `<div class="kpi"><span>armour removes</span><b>${pct(result.target.armorReduction)}</b></div>` : ''}
      ${result.target?.castsToKill !== null && result.target ? `<div class="kpi accent"><span>casts to kill</span><b>${fmt(result.target.castsToKill, 0)}</b></div>` : ''}
    </div>
    ${(result.notes ?? []).map((note) => `<p class="hint">· ${note}</p>`).join('')}`;
}

/** ---------- library ---------- */

function renderSaved() {
  const builds = loadLibrary();
  $('saved-count').textContent = builds.length;
  $('saved-list').innerHTML = builds.length
    ? builds
        .map(
          (entry, index) => `<div class="saved-item">
            <div>
              <b>${entry.name}</b>
              <small>${entry.state.weapon} · ${entry.state.mods.filter((mod) => mod.name).length} mods · ${entry.state.enemy}</small>
            </div>
            <div class="saved-actions">
              <button data-load="${index}" class="ghost">load</button>
              <button data-delete="${index}" class="ghost danger">delete</button>
            </div>
          </div>`,
        )
        .join('')
    : '<p class="hint">No saved builds yet. Build something and press “save build”.</p>';

  for (const button of $('saved-list').querySelectorAll('[data-load]')) {
    button.onclick = () => {
      const entry = loadLibrary()[Number(button.dataset.load)];
      if (!entry) return;
      state = { ...emptyState(), ...entry.state };
      dedupeMods();
      syncInputs();
      showTab('build');
      recalc();
    };
  }
  for (const button of $('saved-list').querySelectorAll('[data-delete]')) {
    button.onclick = () => {
      const builds = loadLibrary();
      builds.splice(Number(button.dataset.delete), 1);
      saveLibrary(builds);
      renderSaved();
    };
  }
}

/** ---------- inputs ---------- */

function syncInputs() {
  $('weapon-input').value = state.weapon;
  $('enemy-input').value = state.enemy;
  $('level-input').value = String(state.level);
  $('level-value').textContent = String(state.level);
  $('headshot').checked = Boolean(state.headshot);
  $('onkill').value = String(state.conditions.onKill ?? 0);
  $('status-types').value = String(state.conditions.statusTypes ?? 1);
  $('aiming').checked = Boolean(state.conditions.aiming);
  $('viral').value = String(state.debuffs?.viralStacks ?? 0);
  $('corrosive').value = String(state.debuffs?.corrosiveStacks ?? 0);
  $('covenant-damage').value = state.conditions.covenantDamage ? String(state.conditions.covenantDamage) : '';
  renderArcaneFields();
  $('strength-input').value = String(state.abilityStrength ?? 100);
  $('find-strength').value = String(state.abilityStrength ?? 100);
  $('find-strength-value').textContent = `${state.abilityStrength ?? 100}%`;
  $('strength-value').textContent = `${state.abilityStrength ?? 100}%`;
  $('framemods-input').value = (state.frameMods ?? []).map((mod) => mod.name).join(', ');
  $('framearcane-input').value = (state.warframeArcanes ?? []).map((mod) => mod.name).join(', ');
  $('frame-input').value = state.frame ?? '';
  $('riven-input').value = state.riven ? [...state.riven.stats, state.riven.malus ? `-${state.riven.malus}` : ''].filter(Boolean).join(',') : '';
  $('riven-roll').value = String(state.rivenRoll ?? 1);
  $('roll-value').textContent = Number(state.rivenRoll ?? 1).toFixed(2);
  $('riven-rank').value = String(state.rivenRank ?? 8);
  $('rinkrank-value').textContent = String(state.rivenRank ?? 8);
  $('incarnon-input').value = (state.incarnon ?? []).join(',');
  $('combo-input').value = String(state.comboHits ?? 0);
  $('combo-value').textContent = String(state.comboHits ?? 0);
  $('heavy').checked = Boolean(state.heavyAttack);
  $('aoe-input').value = String(state.aoeDistance ?? 0);
  $('aoe-value').textContent = state.aoeDistance ? `${state.aoeDistance} m` : 'centre';
  $('element-bonus').value = elementBonusText(state.elementBonus);
  $('reactor').checked = Boolean(state.reactor);
  $('cp-input').value = String(state.corrosiveProjections ?? 0);
  $('strip-input').value = String(state.armorStripPercent ?? 0);
  $('shattering-input').value = String(state.shatteringImpactHits ?? 0);
  $('strip-from').value = state.stripFrom ?? '';
  $('find-weapon').value = '';
  $('find-enemy').value = state.enemy ?? 'Bombard';
  $('find-level').value = String(state.level ?? 150);
  $('sp-toggle').checked = Boolean(state.steelPath);
  $('sp-offset').checked = state.steelPathNodeLevel !== false;
  $('find-sp').checked = Boolean(state.steelPath);
  $('find-sp-offset').checked = state.steelPathNodeLevel !== false;
  renderSteelPath();
  renderFindMethod();
  renderBuffList();
}

let eventsBound = false;

function bindEvents() {
  // main() can run again from the retry button; listeners must not stack up.
  if (eventsBound) return;
  eventsBound = true;
  for (const tab of document.querySelectorAll('.tab')) tab.onclick = () => showTab(tab.dataset.tab);

  $('weapon-input').addEventListener('change', async (event) => {
    const name = event.target.value;
    if (name === state.weapon) return;
    state.weapon = name;
    state.mods = [];
    allMods = [];
    await loadModsForWeapon();
    renderSlots();
    recalc();
  });

  $('mod-filter').addEventListener('input', () => renderModList());
  $('filter-polarity').addEventListener('change', () => renderLibrary());
  $('filter-sort').addEventListener('change', () => renderLibrary());
  $('filter-type').addEventListener('change', () => renderLibrary());
  $('filter-rarity').addEventListener('change', () => renderLibrary());
  $('reactor').addEventListener('change', (event) => {
    state.reactor = event.target.checked;
    renderSlots();
  });
  $('mode-select').addEventListener('change', (event) => {
    state.mode = event.target.value;
    recalc();
  });
  $('enemy-input').addEventListener('change', (event) => {
    state.enemy = event.target.value;
    recalc();
  });
  $('level-input').addEventListener('input', (event) => {
    state.level = Number(event.target.value);
    $('level-value').textContent = state.level;
    renderSteelPath();
    recalc();
  });
  $('sp-toggle').addEventListener('change', (event) => {
    state.steelPath = event.target.checked;
    $('find-sp').checked = state.steelPath;
    renderSteelPath();
    renderFindMethod();
    recalc();
  });
  $('sp-offset').addEventListener('change', (event) => {
    state.steelPathNodeLevel = event.target.checked;
    $('find-sp-offset').checked = event.target.checked;
    renderSteelPath();
    recalc();
  });
  for (const radio of document.querySelectorAll('input[name="find-method"]')) radio.addEventListener('change', renderFindMethod);
  $('find-sp').addEventListener('change', renderFindMethod);
  $('headshot').addEventListener('change', (event) => {
    state.headshot = event.target.checked;
    recalc();
  });

  const conditionInput = (id, key, numeric) => {
    $(id).addEventListener('change', (event) => {
      const value = numeric ? Number(event.target.value) : event.target.checked;
      if (value) state.conditions[key] = value;
      else delete state.conditions[key];
      recalc();
    });
  };
  conditionInput('onkill', 'onKill', true);
  conditionInput('status-types', 'statusTypes', true);
  conditionInput('aiming', 'aiming', false);
  conditionInput('covenant-damage', 'covenantDamage', true);

  const debuffInput = (id, key) => {
    $(id).addEventListener('change', (event) => {
      state.debuffs = { ...(state.debuffs ?? {}), [key]: Number(event.target.value) };
      recalc();
    });
  };
  debuffInput('viral', 'viralStacks');
  debuffInput('corrosive', 'corrosiveStacks');

  for (const id of ['strength-input', 'find-strength']) {
    $(id).addEventListener('input', (event) => {
      state.abilityStrength = Number(event.target.value);
      $('strength-input').value = $('find-strength').value = String(state.abilityStrength);
      $('strength-value').textContent = $('find-strength-value').textContent = `${state.abilityStrength}%`;
      recalc();
    });
  }
  $('framemods-input').addEventListener('change', (event) => {
    state.frameMods = parseNameList(event.target.value);
    recalc();
  });
  $('framearcane-input').addEventListener('change', (event) => {
    state.warframeArcanes = parseNameList(event.target.value);
    recalc();
  });
  $('frame-input').addEventListener('change', (event) => {
    state.frame = event.target.value.trim();
    recalc();
  });
  for (const id of ['arcane-input', 'arcane2-input']) {
    $(id).addEventListener('change', () => setArcanes($('arcane-input').value, $('arcane2-input').value, state.weapon));
  }
  for (const id of ['find-arcane', 'find-arcane2']) {
    $(id).addEventListener('change', () => setArcanes($('find-arcane').value, $('find-arcane2').value, $('find-weapon').value.trim() || state.weapon));
  }
  $('find-weapon').addEventListener('change', refreshFindArcanes);
  $('riven-input').addEventListener('change', (event) => {
    state.riven = parseRivenInput(event.target.value);
    recalc();
  });
  $('riven-roll').addEventListener('input', (event) => {
    state.rivenRoll = Number(event.target.value);
    $('roll-value').textContent = state.rivenRoll.toFixed(2);
    recalc();
  });
  $('riven-rank').addEventListener('input', (event) => {
    state.rivenRank = Number(event.target.value);
    $('rinkrank-value').textContent = String(state.rivenRank);
    recalc();
  });
  $('incarnon-input').addEventListener('change', (event) => {
    state.incarnon = event.target.value.split(',').map((part) => part.trim()).filter(Boolean);
    recalc();
  });
  $('combo-input').addEventListener('input', (event) => {
    state.comboHits = Number(event.target.value);
    $('combo-value').textContent = String(state.comboHits);
    recalc();
  });
  $('heavy').addEventListener('change', (event) => {
    state.heavyAttack = event.target.checked;
    recalc();
  });
  $('aoe-input').addEventListener('input', (event) => {
    const value = Number(event.target.value);
    state.aoeDistance = value === 0 ? null : value;
    $('aoe-value').textContent = value === 0 ? 'centre' : `${value} m`;
    recalc();
  });
  $('element-bonus').addEventListener('change', (event) => {
    state.elementBonus = parseElementBonus(event.target.value);
    recalc();
  });

  const stripInput = (id, key) => {
    $(id).addEventListener('change', (event) => {
      state[key] = Math.max(0, Number(event.target.value) || 0);
      recalc();
    });
  };
  stripInput('cp-input', 'corrosiveProjections');
  stripInput('strip-input', 'armorStripPercent');
  stripInput('shattering-input', 'shatteringImpactHits');
  $('strip-from').addEventListener('change', (event) => {
    state.stripFrom = event.target.value;
    recalc();
  });

  $('find-run').onclick = runFind;
  $('ability-run').onclick = runAbility;
  $('ability-strength').addEventListener('input', (event) => {
    $('ability-strength-value').textContent = `${event.target.value}%`;
  });

  $('compare-run').onclick = runCompare;

  $('save-build').onclick = () => {
    const name = prompt('Name this build', `${state.weapon} ${new Date().toLocaleDateString()}`);
    if (!name) return;
    const builds = loadLibrary();
    builds.unshift({ name, state: JSON.parse(JSON.stringify(state)), savedAt: Date.now() });
    saveLibrary(builds.slice(0, 50));
    renderSaved();
  };

  $('share').onclick = async () => {
    saveToUrl();
    try {
      await navigator.clipboard.writeText(location.href);
      $('share').textContent = 'copied';
      setTimeout(() => ($('share').textContent = 'copy link'), 1200);
    } catch {
      prompt('Copy this link', location.href);
    }
  };
}

/** ---------- boot ---------- */

async function loadStaticLists() {
  const [weapons, enemies, buffs, arcanes, warframes, abilities] = await Promise.all([
    getJson('/api/weapons'),
    getJson('/api/enemies'),
    getJson('/api/buffs'),
    getJson('/api/arcanes'),
    getJson('/api/warframes'),
    getJson('/api/abilities'),
  ]);
  $('frame-list').innerHTML = warframes.map((frame) => `<option value="${frame.name}"></option>`).join('');
  weaponData.clear();
  for (const weapon of weapons) weaponData.set(weapon.name, weapon);
  // Type filter options come from the mods we ship; filled on first weapon load.
  $('weapon-list').innerHTML = weapons.map((weapon) => `<option value="${weapon.name}">${weapon.type}</option>`).join('');
  $('weapon-list').innerHTML = weapons.map((weapon) => `<option value="${weapon.name}">${weapon.type}</option>`).join('');
  $('enemy-list').innerHTML = enemies.map((enemy) => `<option value="${enemy.name}">${enemy.faction ?? ''} hp${enemy.health}</option>`).join('');
  $('arcane-list').innerHTML = arcanes.map((arcane) => `<option value="${arcane.name}">${(arcane.description || '').split('\n')[0].slice(0, 44)}</option>`).join('');
  allBuffs = buffs;
  allAbilities = abilities;
  renderBuffList();
  renderAbilityLists();
}

/** The ability picker and the armour-strip picker, both fed by the same list. */
function renderAbilityLists() {
  const select = $('ability-select');
  if (select) {
    select.innerHTML = allAbilities
      .map((ability) => `<option value="${ability.ability}">${ability.frame} — ${ability.ability}${ability.damageType ? ` (${ability.damageType})` : ''}</option>`)
      .join('');
    select.value = state.lastAbility && allAbilities.some((a) => a.ability === state.lastAbility)
      ? state.lastAbility
      : allAbilities[0]?.ability ?? '';
  }
  const strip = $('strip-from');
  if (strip) {
    const stripping = allAbilities.filter((ability) => ability.armorStrip);
    strip.innerHTML = '<option value="">none</option>' + stripping
      .map((ability) => `<option value="${ability.ability}">${ability.frame} — ${ability.ability}</option>`)
      .join('');
    strip.value = state.stripFrom ?? '';
  }
}

async function loadModsForWeapon() {
  if (!state.weapon) return;
  const [mods, arcanes] = await Promise.all([
    getJson(`/api/mods?weapon=${encodeURIComponent(state.weapon)}`),
    getJson(`/api/arcanes?weapon=${encodeURIComponent(state.weapon)}`),
  ]);
  allMods = mods;
  const types = [...new Set(mods.flatMap((mod) => mod.classes ?? []))].sort();
  $('filter-type').innerHTML = '<option value="">All types</option>' + types.map((type) => `<option value="${type.toLowerCase()}">${type}</option>`).join('');
  renderModList('');
  $('arcane-list').innerHTML = arcanes.map((arcane) => `<option value="${arcane.name}">${(arcane.description || '').split('\n')[0].slice(0, 44)}</option>`).join('');
  // A non-arch-gun keeps only its first arcane.
  if (!isArchgun(state.weapon) && (state.arcanes?.length ?? 0) > 1) state.arcanes = state.arcanes.slice(0, 1);
  refreshFindArcanes();
}

/**
 * Boot failures used to leave a blank page: main() had no catch, so one failed request among
 * the five static lists silently stopped everything. Now it reports and offers a retry.
 */
function showBootError(error) {
  const target = $('stats');
  if (!target) return;
  const detail = String(error?.message ?? error ?? 'unknown error');
  target.innerHTML = `<p class="error">Could not load the data: ${detail.replace(/</g, '&lt;')}</p>
    <p class="hint">The page needs the wfcalc server; check that it is running and reachable.</p>
    <button id="boot-retry">retry</button>`;
  $('boot-retry')?.addEventListener('click', () => {
    target.innerHTML = '';
    void main();
  });
}

async function main() {
  try {
    loadFromUrl();
    dedupeMods();
    await loadStaticLists();
    bindEvents();
    // ?tab=find opens a tab directly, so a link can point at the brute force.
    const startTab = new URLSearchParams(location.search).get('tab');
    if (startTab && $(`tab-${startTab}`)) showTab(startTab);
    syncInputs();
    renderSaved();
    if (state.weapon) await loadModsForWeapon();
    // The board renders even with no weapon: the slots are the first thing to see.
    renderSlots();
    recalc();
  } catch (error) {
    console.error('wfcalc boot failed', error);
    showBootError(error);
  }
}

main();
