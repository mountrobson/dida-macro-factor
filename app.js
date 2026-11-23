/* DiDa Macros: a personal photo-based macro tracker.
 * Everything is stored on this device (IndexedDB + localStorage).
 * Photo estimates call the Anthropic API directly with the user's own key. */
'use strict';

/* ---------- tiny helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const round = (n) => Math.round(Number(n) || 0);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return dateKey(d); };
const todayKey = () => dateKey(new Date());
const KG_PER_LB = 0.45359237;

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ---------- settings (localStorage) ---------- */
const DEFAULT_SETTINGS = {
  targets: { kcal: 2200, p: 160, c: 220, f: 70 },
  provider: 'gemini',        // 'gemini' (free tier) or 'claude' (paid)
  geminiKey: '',
  geminiModel: '',           // '' = pick automatically from the models the key can use
  apiKey: '',                // Anthropic key
  model: 'claude-opus-5-5',
  keepPhotos: true,
  unit: 'kg',
};
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('dida.settings') || '{}');
    return { ...DEFAULT_SETTINGS, ...s, targets: { ...DEFAULT_SETTINGS.targets, ...(s.targets || {}) } };
  } catch { return structuredClone(DEFAULT_SETTINGS); }
}
let settings = loadSettings();
function saveSettings() { localStorage.setItem('dida.settings', JSON.stringify(settings)); }

/* ---------- IndexedDB ---------- */
let dbp;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('dida', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        const e = d.createObjectStore('entries', { keyPath: 'id' });
        e.createIndex('date', 'date');
        d.createObjectStore('weights', { keyPath: 'date' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const putEntry = (e) => tx('entries', 'readwrite', (s) => s.put(e));
const deleteEntryDb = (id) => tx('entries', 'readwrite', (s) => s.delete(id));
const entriesFor = (date) => tx('entries', 'readonly', (s) => s.index('date').getAll(date));
const allEntries = () => tx('entries', 'readonly', (s) => s.getAll());
const putWeight = (w) => tx('weights', 'readwrite', (s) => s.put(w));
const deleteWeight = (date) => tx('weights', 'readwrite', (s) => s.delete(date));
const allWeights = () => tx('weights', 'readonly', (s) => s.getAll());

/* ---------- state ---------- */
let currentDate = todayKey();
let currentView = 'today';
let editing = null;          // entry being edited, or null for a new one
let pendingPhoto = null;     // { dataUrl (for API), thumb }
let baseMacros = null;       // macros before portion scaling

/* ---------- navigation ---------- */
function showView(v) {
  currentView = v;
  $$('.view').forEach((el) => el.classList.toggle('hidden', el.id !== `view-${v}`));
  $$('.tab[data-view]').forEach((el) => el.classList.toggle('active', el.dataset.view === v));
  $('.topbar').classList.toggle('hidden', v !== 'today');
  if (v === 'today') renderToday();
  if (v === 'progress') renderProgress();
  if (v === 'settings') renderSettings();
  window.scrollTo(0, 0);
}

function dateLabel(k) {
  const t = todayKey();
  if (k === t) return 'Today';
  if (k === addDays(t, -1)) return 'Yesterday';
  if (k === addDays(t, 1)) return 'Tomorrow';
  return parseKey(k).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/* ---------- Today ---------- */
const MEALS = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
const MACROS = [
  { key: 'p', label: 'Protein', color: 'var(--p)' },
  { key: 'c', label: 'Carbs', color: 'var(--c)' },
  { key: 'f', label: 'Fat', color: 'var(--f)' },
];

function sumEntries(list) {
  return list.reduce((a, e) => ({ kcal: a.kcal + (+e.kcal || 0), p: a.p + (+e.p || 0), c: a.c + (+e.c || 0), f: a.f + (+e.f || 0) }), { kcal: 0, p: 0, c: 0, f: 0 });
}

async function renderToday() {
  $('#dateLabel').textContent = dateLabel(currentDate);
  const list = (await entriesFor(currentDate)).sort((a, b) => a.time - b.time);
  const tot = sumEntries(list);
  const T = settings.targets;

  const left = T.kcal - tot.kcal;
  $('#kcalLeft').textContent = Math.abs(round(left)).toLocaleString();
  $('#kcalLeftLabel').textContent = left >= 0 ? `kcal left of ${round(T.kcal).toLocaleString()}` : 'kcal over';
  const circ = 2 * Math.PI * 52;
  const ring = $('#kcalRing');
  ring.style.strokeDasharray = circ;
  ring.style.strokeDashoffset = circ * (1 - Math.min(1, T.kcal ? tot.kcal / T.kcal : 0));
  ring.classList.toggle('over', left < 0);

  $('#macroBars').innerHTML = MACROS.map((m) => {
    const v = tot[m.key], t = T[m.key] || 0;
    const pct = t ? Math.min(100, (v / t) * 100) : 0;
    return `<div class="macro"><div class="top"><b>${m.label}</b><span>${round(v)} / ${round(t)} g</span></div>
      <div class="bar"><i style="width:${pct}%;background:${m.color}"></i></div></div>`;
  }).join('');

  if (!list.length) {
    $('#mealList').innerHTML = `<div class="empty">Nothing logged ${currentDate === todayKey() ? 'yet today' : 'on this day'}.<br>Tap 📷 to snap your food.</div>`;
    return;
  }
  $('#mealList').innerHTML = MEALS.map((meal) => {
    const items = list.filter((e) => (e.meal || 'Snack') === meal);
    if (!items.length) return '';
    const s = sumEntries(items);
    return `<div class="meal"><div class="meal-head"><span>${meal}</span><span>${round(s.kcal)} kcal</span></div>
      ${items.map((e) => `<button class="entry" data-id="${e.id}">
        ${e.thumb ? `<img src="${e.thumb}" alt="">` : '<div class="ph">🍴</div>'}
        <div class="info"><div class="name">${esc(e.name)}</div>
          <div class="mac"><span class="dot" style="background:var(--p)"></span>${round(e.p)}P
          <span class="dot" style="background:var(--c)"></span>${round(e.c)}C
          <span class="dot" style="background:var(--f)"></span>${round(e.f)}F${e.ai ? ' · AI' : ''}</div></div>
        <div class="kc">${round(e.kcal)}</div></button>`).join('')}</div>`;
  }).join('');
  $$('.entry').forEach((b) => b.addEventListener('click', async () => {
    const e = list.find((x) => x.id === b.dataset.id);
    if (e) openSheet({ entry: e });
  }));
}

/* ---------- entry sheet ---------- */
function defaultMeal() {
  const h = new Date().getHours();
  if (h >= 4 && h < 11) return 'Breakfast';
  if (h >= 11 && h < 15) return 'Lunch';
  if (h >= 17 && h < 22) return 'Dinner';
  return 'Snack';
}

function setForm(m) {
  $('#eName').value = m.name ?? '';
  $('#eKcal').value = m.kcal != null ? round(m.kcal) : '';
  $('#eP').value = m.p != null ? round(m.p) : '';
  $('#eC').value = m.c != null ? round(m.c) : '';
  $('#eF').value = m.f != null ? round(m.f) : '';
}
function readForm() {
  return {
    name: $('#eName').value.trim(),
    kcal: +$('#eKcal').value || 0,
    p: +$('#eP').value || 0,
    c: +$('#eC').value || 0,
    f: +$('#eF').value || 0,
    meal: $('#eMeal').value,
  };
}

/* ---------- editable items ----------
 * An entry can have a list of items (from the AI, or added by hand). Editing any item
 * re-adds the totals. Editing a total directly is also allowed (it then overrides). */
let items = [];              // [{ name, portion, kcal, p, c, f }]
let aiMeta = null;           // { confidence, notes } from the last AI estimate

// AI items use protein_g etc.; stored and edited items use p/c/f. Accept both.
const normItem = (i) => ({
  name: i.name || '', portion: i.portion || '',
  kcal: +(i.kcal ?? 0) || 0, p: +(i.p ?? i.protein_g ?? 0) || 0, c: +(i.c ?? i.carbs_g ?? 0) || 0, f: +(i.f ?? i.fat_g ?? 0) || 0,
});
const r1 = (n) => Math.round(n * 10) / 10;

function setItems(list, meta) {
  items = (list || []).map(normItem);
  if (meta !== undefined) aiMeta = meta;
  baseMacros = null;
  renderItemEditor();
}

function renderItemEditor() {
  const box = $('#eItems');
  const meta = aiMeta?.confidence ? `<div class="conf">AI confidence: ${esc(aiMeta.confidence)}${aiMeta.notes ? ` · ${esc(aiMeta.notes)}` : ''}</div>` : '';
  box.innerHTML = `<div class="items-head"><span>${items.length ? 'Items (tap a number to change it)' : 'Items'}</span>
      <button type="button" id="addItem">＋ Add item</button></div>${meta}
    ${items.map((it, i) => `<div class="item-row" data-i="${i}">
      <div class="item-top">
        <input class="i-name" data-k="name" value="${esc(it.name)}" placeholder="Food" aria-label="Item name">
        <input class="i-portion" data-k="portion" value="${esc(it.portion)}" placeholder="amount" aria-label="Amount">
        <button type="button" class="i-del" aria-label="Remove item">✕</button>
      </div>
      <div class="i-nums">
        <label>kcal<input type="number" inputmode="decimal" data-k="kcal" value="${round(it.kcal)}"></label>
        <label>Protein<input type="number" inputmode="decimal" data-k="p" value="${r1(it.p)}"></label>
        <label>Carbs<input type="number" inputmode="decimal" data-k="c" value="${r1(it.c)}"></label>
        <label>Fat<input type="number" inputmode="decimal" data-k="f" value="${r1(it.f)}"></label>
      </div>
      <div class="i-steps">
        <button type="button" data-mul="0.5">½</button><button type="button" data-mul="0.75">−25%</button>
        <button type="button" data-mul="1.25">+25%</button><button type="button" data-mul="2">2×</button>
      </div></div>`).join('')}`;

  $('#addItem').addEventListener('click', () => {
    items.push(normItem({ name: '' }));
    renderItemEditor();
    const rows = $$('#eItems .item-row');
    rows[rows.length - 1]?.querySelector('.i-name').focus();
  });
  $$('#eItems .item-row').forEach((row) => {
    const i = +row.dataset.i;
    row.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', () => {
      const k = inp.dataset.k;
      items[i][k] = (k === 'name' || k === 'portion') ? inp.value : (+inp.value || 0);
      if (k !== 'name' && k !== 'portion') totalsFromItems();
    }));
    row.querySelector('.i-del').addEventListener('click', () => { items.splice(i, 1); renderItemEditor(); totalsFromItems(); });
    row.querySelectorAll('[data-mul]').forEach((b) => b.addEventListener('click', () => {
      const m = +b.dataset.mul;
      const it = items[i];
      Object.assign(it, { kcal: it.kcal * m, p: it.p * m, c: it.c * m, f: it.f * m });
      if (it.portion) it.portion = scalePortion(it.portion, m);
      renderItemEditor(); totalsFromItems();
    }));
  });
}

// "150 g" × 1.5 → "225 g"; leaves text without a leading number alone.
function scalePortion(portion, m) {
  return portion.replace(/^(\d+(?:[.,]\d+)?)/, (n) => String(r1(parseFloat(n.replace(',', '.')) * m)));
}

function totalsFromItems() {
  baseMacros = null;
  if (!items.length) { $('#totalsHint').textContent = ''; return; }
  const s = items.reduce((a, it) => ({ kcal: a.kcal + it.kcal, p: a.p + it.p, c: a.c + it.c, f: a.f + it.f }), { kcal: 0, p: 0, c: 0, f: 0 });
  setForm({ name: $('#eName').value, ...s });
  $('#totalsHint').textContent = 'sum of items';
}

async function openSheet({ entry = null, photo = null } = {}) {
  editing = entry;
  pendingPhoto = photo;
  baseMacros = null;
  $('#sheetTitle').textContent = entry ? 'Edit food' : photo ? 'Snap food' : 'Add food';
  $('#deleteEntry').classList.toggle('hidden', !entry);
  $('#photoArea').classList.toggle('hidden', !photo);
  setStatus('');
  $('#photoNote').value = '';
  if (photo) $('#photoPreview').src = photo.dataUrl;
  setForm(entry || {});
  $('#totalsHint').textContent = '';
  $('#eMeal').value = entry?.meal || defaultMeal();
  setItems(entry?.items || [], entry?.confidence ? { confidence: entry.confidence, notes: entry.notes } : null);
  // The AI box: estimate from a photo, or tell the AI what to fix on an existing entry.
  $('#aiBox').classList.toggle('hidden', !(photo || entry));
  updateAiBox();

  // recent foods for quick re-logging (manual add only)
  $('#recentWrap').classList.add('hidden');
  if (!entry && !photo) {
    const all = (await allEntries()).sort((a, b) => b.time - a.time);
    const seen = new Set(); const recent = [];
    for (const e of all) { const k = e.name.toLowerCase(); if (!seen.has(k)) { seen.add(k); recent.push(e); } if (recent.length >= 12) break; }
    if (recent.length) {
      $('#recentWrap').classList.remove('hidden');
      $('#recentList').innerHTML = recent.map((e, i) => `<button type="button" class="chip" data-i="${i}">${esc(e.name)} · ${round(e.kcal)}</button>`).join('');
      $$('#recentList .chip').forEach((b) => b.addEventListener('click', () => {
        const e = recent[+b.dataset.i];
        setForm(e); setItems(e.items || [], null); $('#totalsHint').textContent = '';
        if (e.thumb && !pendingPhoto) pendingPhoto = { thumb: e.thumb, reused: true };
      }));
    }
  }
  $('#sheet').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  if (photo && hasAiKey()) estimate();
  else if ((photo || entry) && !hasAiKey()) setStatus('Add a free Gemini API key in Settings to get AI estimates and fixes, or fill in the numbers yourself below.');
}

// Before an estimate exists the box asks for extra info; afterwards it takes corrections.
function updateAiBox() {
  const fixing = items.length > 0 || !!editing;
  $('#noteLabel').textContent = fixing ? 'Tell the AI what to fix' : "Anything the photo can't show? (optional)";
  $('#photoNote').placeholder = fixing ? 'e.g. only 2 eggs, rice was about 200 g, no sauce' : 'e.g. cooked in butter, large portion, 2 eggs';
  $('#estimateBtn').textContent = fixing ? 'Fix with AI' : 'Estimate macros';
}
function setStatus(text, isError = false) {
  const el = $('#estimateStatus');
  el.textContent = text;
  el.classList.toggle('status-error', isError);
}
function closeSheet() {
  $('#sheet').classList.add('hidden');
  document.body.style.overflow = '';
  editing = null; pendingPhoto = null; items = []; aiMeta = null;
}

async function saveEntry(ev) {
  ev.preventDefault();
  const f = readForm();
  if (!f.name) { toast('Give it a name'); return; }
  const e = editing ? { ...editing, ...f } : {
    id: uid(), date: currentDate, time: Date.now(), ...f,
  };
  if (!editing && pendingPhoto?.thumb && settings.keepPhotos) e.thumb = pendingPhoto.thumb;
  e.items = items.filter((it) => it.name || it.kcal).map((it) => ({ ...it }));
  if (aiMeta) { e.ai = true; e.confidence = aiMeta.confidence; e.notes = aiMeta.notes; }
  await putEntry(e);
  closeSheet();
  toast(editing ? 'Updated' : `Logged ${round(e.kcal)} kcal`);
  renderToday();
}

/* ---------- photos ---------- */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
    img.src = url;
  });
}
function resize(img, max, quality) {
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/jpeg', quality);
}
function squareThumb(img, size) {
  const s = Math.min(img.naturalWidth, img.naturalHeight);
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  c.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
  return c.toDataURL('image/jpeg', 0.7);
}
async function onPhoto(file) {
  if (!file) return;
  try {
    const img = await loadImage(file);
    openSheet({ photo: { dataUrl: resize(img, 1280, 0.85), thumb: squareThumb(img, 144) } });
  } catch (err) { toast(err.message); }
}

/* ---------- AI estimate (Anthropic Messages API) ---------- */
const ESTIMATE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short name for the whole meal, e.g. "Chicken burrito bowl"' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          portion: { type: 'string', description: 'Estimated amount, e.g. "150 g" or "1 cup"' },
          kcal: { type: 'number' },
          protein_g: { type: 'number' },
          carbs_g: { type: 'number' },
          fat_g: { type: 'number' },
        },
        required: ['name', 'portion', 'kcal', 'protein_g', 'carbs_g', 'fat_g'],
        additionalProperties: false,
      },
    },
    kcal: { type: 'number' },
    protein_g: { type: 'number' },
    carbs_g: { type: 'number' },
    fat_g: { type: 'number' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    notes: { type: 'string', description: 'One short sentence on the main uncertainty, or empty' },
  },
  required: ['name', 'items', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'confidence', 'notes'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are a nutrition estimator inside a personal macro-tracking app. The user photographs food they are about to eat. Identify each distinct food or drink, estimate its portion from visual cues (plate and utensil size, packaging, hands), and estimate calories, protein, carbohydrate and fat for the amount shown. Assume typical home or restaurant preparation, including cooking oil and sauces that are likely present. If the user adds a note, trust it over the photo. Totals must equal the sum of the items. If the photo shows no food, return an empty item list, zero totals, low confidence, and say so in notes.`;

// The user message: optional extra info, and for corrections the current estimate to update.
function userText({ note, current }) {
  if (current) {
    return `Here is the current estimate for this meal (as JSON):\n${JSON.stringify(current)}\n\n` +
      `My correction: ${note}\n\nApply my correction and return the full updated estimate. Keep items I didn't mention as they are, unless the correction affects them.`;
  }
  return (note ? `Note from me: ${note}\n` : '') + 'Estimate the macros for this.';
}

// fetch with a time limit, so a stalled request ends with a clear message instead of spinning.
async function fetchWithTimeout(url, opts, ms = 60000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  catch (e) {
    if (e.name === 'AbortError') { const err = new Error(`No answer after ${ms / 1000} seconds`); err.status = 504; err.raw = err.message; throw err; }
    const err = new Error(`Network error: ${e.message}. Check your connection.`); err.status = 599; err.raw = err.message; throw err;
  } finally { clearTimeout(t); }
}

function fallbackSupported(model) { return model === 'claude-opus-5-5' || model === 'claude-sonnet-5-5'; }

async function callClaude({ imageDataUrl, note, current, withFallbacks = true }) {
  const model = settings.model || DEFAULT_SETTINGS.model;
  const useFallbacks = withFallbacks && fallbackSupported(model);
  const content = [];
  if (imageDataUrl) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageDataUrl.split(',')[1] } });
  }
  content.push({ type: 'text', text: userText({ note, current }) });

  const body = {
    model,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: ESTIMATE_SCHEMA } },
    messages: [{ role: 'user', content }],
  };
  const headers = {
    'content-type': 'application/json',
    'x-api-key': settings.apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (useFallbacks) { body.fallbacks = 'default'; headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; }

  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    // If this account or model doesn't accept the fallback option, retry once without it.
    if (useFallbacks && res.status === 400 && /fallback|beta/i.test(msg)) return callClaude({ imageDataUrl, note, current, withFallbacks: false });
    if (res.status === 401) throw new Error('The API key was rejected. Check it in Settings.');
    if (res.status === 429) throw new Error('Rate limited by the API. Wait a moment and try again.');
    if (res.status === 529 || res.status >= 500) throw new Error('The AI service is busy. Try again in a moment.');
    throw new Error(msg);
  }
  if (data.stop_reason === 'refusal') throw new Error('The AI declined to estimate this photo. Enter the numbers yourself.');
  if (data.stop_reason === 'max_tokens') throw new Error('The estimate got cut off. Try again.');
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return JSON.parse(text); } catch { throw new Error('Could not read the AI answer. Try again.'); }
}

/* ---------- Google Gemini (free tier) ---------- */
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// Free-tier models as of Nov 2026, best first. Flash-Lite has the largest free daily allowance.
const GEMINI_FREE_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-flash-latest', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest'];

// Gemini takes an OpenAPI-style schema: uppercase types, no additionalProperties.
function toGeminiSchema(s) {
  const out = { type: String(s.type).toUpperCase() };
  if (s.description) out.description = s.description;
  if (s.enum) { out.enum = s.enum; out.format = 'enum'; }
  if (s.items) out.items = toGeminiSchema(s.items);
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    out.required = s.required;
    out.propertyOrdering = Object.keys(s.properties);
  }
  return out;
}

// Rank the models a key can use: newest full Flash first (best accuracy), then Flash-Lite
// (bigger free daily allowance). Image-generation, audio and other special models are skipped.
function rankGeminiModels(names) {
  const ver = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  const ok = names.filter((n) => /^gemini-[\d.]+-flash(-lite)?$/.test(n));
  const full = ok.filter((n) => !n.endsWith('-lite')).sort((a, b) => ver(b) - ver(a));
  const lite = ok.filter((n) => n.endsWith('-lite')).sort((a, b) => ver(b) - ver(a));
  // Models known to be on the free tier go first; newer models (e.g. Gemini 4) may have a
  // free quota of 0, so they only come after.
  const free = GEMINI_FREE_MODELS.filter((n) => names.includes(n));
  return [...new Set([...free, ...full, ...lite])];
}

// Turn a Gemini error response into a message that shows Google's own reason plus a hint.
function geminiError(res, data) {
  const e = data?.error || {};
  const reason = (e.details || []).map((d) => d.reason).find(Boolean) || e.status || '';
  const raw = e.message || `HTTP ${res.status}`;
  let hint = '';
  if (reason === 'API_KEY_INVALID' || reason === 'ACCESS_TOKEN_TYPE_UNSUPPORTED' || /api key not valid/i.test(raw)) {
    hint = 'Copy the key again: open the key in aistudio.google.com/apikey and tap "Copy key" (the list view shows a shortened key). New keys start with "AQ." and are about 53 characters; older ones start with "AIza".';
  }
  else if (/referer|referrer/i.test(raw) || reason === 'API_KEY_HTTP_REFERRER_BLOCKED') hint = 'The key has website restrictions. In Google Cloud Console, either remove them or allow https://mountrobson.github.io/*.';
  else if (/location is not supported|region/i.test(raw)) hint = 'Google does not offer the Gemini API in your country.';
  else if (reason === 'SERVICE_DISABLED' || /has not been used|is disabled/i.test(raw)) hint = 'Enable the "Generative Language API" for the key\'s project, or create the key from aistudio.google.com instead.';
  else if (/unregistered callers|without.*key|missing.*key/i.test(raw)) hint = 'No key reached Google. Paste the key and tap Save.';
  const err = new Error(`Google said: ${raw}${hint ? ` ${hint}` : ''} (HTTP ${res.status})`);
  err.status = res.status;
  err.reason = reason;
  err.raw = raw;
  const retry = (e.details || []).find((d) => d.retryDelay)?.retryDelay;
  if (retry) err.retrySec = parseFloat(retry);
  return err;
}
const isKeyProblem = (e) => e.status === 401 || e.status === 403 || /API_KEY|ACCESS_TOKEN/.test(e.reason || '') || /api key|referer|location is not supported/i.test(e.raw || '');

// Used if listing models fails (some key types may not be allowed to list models).
const GEMINI_FALLBACK_MODELS = GEMINI_FREE_MODELS;

async function listGeminiModels() {
  const res = await fetch(`${GEMINI_BASE}/models?pageSize=1000`, { headers: { 'x-goog-api-key': settings.geminiKey } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw geminiError(res, data);
  const names = (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''));
  const ranked = rankGeminiModels(names);
  settings.geminiCandidates = ranked;
  settings.geminiRankV = 2;
  saveSettings();
  return ranked;
}

async function geminiGenerate(model, { imageDataUrl, note, current }, structured = true) {
  const parts = [];
  if (imageDataUrl) parts.push({ inline_data: { mime_type: 'image/jpeg', data: imageDataUrl.split(',')[1] } });
  parts.push({ text: userText({ note, current }) +
    (structured ? '' : `\nReply with only JSON matching this schema: ${JSON.stringify(ESTIMATE_SCHEMA)}`) });
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  };
  if (structured) body.generationConfig.responseSchema = toGeminiSchema(ESTIMATE_SCHEMA);
  const res = await fetchWithTimeout(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': settings.geminiKey },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw geminiError(res, data);
  const cand = (data.candidates || [])[0];
  if (!cand) throw new Error(data.promptFeedback?.blockReason ? 'Gemini declined this photo. Enter the numbers yourself.' : 'Gemini returned no answer. Try again.');
  if (cand.finishReason === 'MAX_TOKENS') throw new Error('The estimate got cut off. Try again.');
  const text = (cand.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch { throw new Error(`Could not read the AI answer (${model}). Try again. It began: ${text.slice(0, 80)}`); }
}

async function callGemini(args) {
  if (settings.geminiRankV !== 2) { settings.geminiCandidates = null; settings.geminiRankV = 2; saveSettings(); } // re-rank after updates
  let candidates = settings.geminiModel ? [settings.geminiModel] : settings.geminiCandidates;
  if (!candidates?.length) {
    // Listing is only a convenience: if it fails, try well-known models directly. A real key
    // problem then shows up on the generate call, which is the error that matters.
    try { candidates = await listGeminiModels(); } catch { candidates = []; }
    if (!candidates.length) { candidates = GEMINI_FALLBACK_MODELS; settings.geminiCandidates = candidates; saveSettings(); }
  }
  // Skip models whose free daily limit already ran out today (limits reset at midnight Pacific;
  // the local date is close enough, and a wrong skip just falls back to the next model).
  const spent = (settings.geminiSpent?.date === todayKey()) ? settings.geminiSpent.models : [];
  const fresh = candidates.filter((m) => !spent.includes(m));
  if (fresh.length) candidates = fresh;
  let lastErr;
  const tried = [];
  for (const model of candidates.slice(0, 6)) {
    try {
      try { return await geminiGenerate(model, args, true); }
      catch (e) {
        // Some models reject a response schema; ask for plain JSON instead.
        if (e.status === 400 && /schema|response_?mime|responseSchema/i.test(e.message)) return await geminiGenerate(model, args, false);
        throw e;
      }
    } catch (e) {
      lastErr = e;
      tried.push(`${model}: ${e.raw || e.message}`);
      if (isKeyProblem(e)) throw e;
      // Out of quota, model gone, overloaded, timed out, or the model rejected the request: try the next one.
      if (e.status === 429 || e.status === 404 || e.status >= 500 || e.status === 400) {
        if (e.status === 404 && !settings.geminiModel) settings.geminiCandidates = null;
        if (e.status === 429 && /per ?day/i.test(e.message)) {
          const g = settings.geminiSpent?.date === todayKey() ? settings.geminiSpent : { date: todayKey(), models: [] };
          if (!g.models.includes(model)) g.models.push(model);
          settings.geminiSpent = g;
        }
        saveSettings();
        continue;
      }
      throw e;
    }
  }
  // Only per-minute limits were hit (free tier allows a few requests a minute): wait and retry once.
  if (lastErr?.status === 429 && !/per ?day/i.test(lastErr.message) && !args._retried) {
    const wait = Math.min(40, Math.max(5, lastErr.retrySec || 20));
    args.onWait?.(wait);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return callGemini({ ...args, _retried: true });
  }
  const detail = tried.length ? ` Google said: ${tried.join(' | ')}` : '';
  if (lastErr?.status === 429) throw new Error(`No free quota left on any model right now. Daily limits reset at midnight Pacific time.${detail}`);
  if (lastErr?.status >= 500) throw new Error(`Gemini is overloaded right now. Try again in a minute.${detail}`);
  throw lastErr ? new Error(`${lastErr.message}${detail}`) : new Error('Estimate failed');
}

function hasAiKey() { return settings.provider === 'claude' ? !!settings.apiKey : !!settings.geminiKey; }
function callAi(args) { return settings.provider === 'claude' ? callClaude(args) : callGemini(args); }

let estimating = false;
let queuedFix = false;       // user tapped the button while a request was running
async function estimate() {
  if (estimating) { queuedFix = true; setStatus('Got it, will apply your note as soon as the first estimate is done…'); return; }
  if (!hasAiKey()) { toast('Add your API key in Settings first'); return; }
  const note = $('#photoNote').value.trim();
  const fixing = items.length > 0 || !!editing;
  if (fixing && !note) { setStatus('Type what to fix first, e.g. "only 2 eggs".', true); $('#photoNote').focus(); return; }
  // Use the full photo when we have it, else the saved thumbnail of a logged entry.
  const image = pendingPhoto?.dataUrl || editing?.thumb || null;
  if (!fixing && !image) return;
  const current = fixing ? { name: $('#eName').value, items, total: readForm() } : null;

  const sheetSession = { entry: editing, photo: pendingPhoto };
  estimating = true; queuedFix = false;
  $('#estimateStatus').classList.remove('status-error');
  $('#estimateStatus').innerHTML = `<span class="spinner"></span> ${fixing ? 'Applying your fix…' : 'Looking at your food…'}`;
  try {
    const r = await callAi({ imageDataUrl: image, note, current,
      onWait: (sec) => { $('#estimateStatus').innerHTML = `<span class="spinner"></span> Free tier allows only a few requests a minute. Retrying in ${sec} s…`; } });
    if (editing !== sheetSession.entry || pendingPhoto !== sheetSession.photo || $('#sheet').classList.contains('hidden')) return; // sheet changed meanwhile
    setForm({ name: r.name || $('#eName').value, kcal: r.kcal, p: r.protein_g, c: r.carbs_g, f: r.fat_g });
    setItems(r.items, { confidence: r.confidence, notes: r.notes });
    $('#totalsHint').textContent = items.length ? 'sum of items' : '';
    if ($('#photoNote').value.trim() === note) $('#photoNote').value = '';
    updateAiBox();
    setStatus(fixing ? 'Updated. Check it, then save. You can fix more the same way.' : 'Check the items, fix anything that\'s off right in the list or tell the AI above, then save.');
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    estimating = false;
  }
  // A note typed (and sent) while the first estimate was running gets applied now.
  if (queuedFix) { queuedFix = false; if ($('#photoNote').value.trim() && !$('#sheet').classList.contains('hidden')) estimate(); }
}

/* ---------- Progress ---------- */
const toUnit = (kg) => settings.unit === 'lb' ? kg / KG_PER_LB : kg;
const fromUnit = (v) => settings.unit === 'lb' ? v * KG_PER_LB : v;
const fmtW = (kg) => toUnit(kg).toFixed(1);

function trendSeries(weights) {
  // Exponentially smoothed trend so day-to-day water swings don't hide the real direction.
  const sorted = [...weights].sort((a, b) => a.date.localeCompare(b.date));
  let t = null, prev = null;
  return sorted.map((w) => {
    if (t == null) t = w.kg;
    else {
      const gap = Math.max(1, Math.round((parseKey(w.date) - parseKey(prev)) / 86400000));
      const a = 1 - Math.pow(0.9, gap);
      t = t + a * (w.kg - t);
    }
    prev = w.date;
    return { ...w, trend: t };
  });
}

function trendAt(series, date) {
  let last = null;
  for (const s of series) { if (s.date <= date) last = s; else break; }
  return last;
}

async function renderProgress() {
  $('#weightUnit').textContent = settings.unit;
  const weights = await allWeights();
  const series = trendSeries(weights);
  const now = series[series.length - 1];

  if (!series.length) {
    $('#weightStats').innerHTML = '';
    $('#weightChart').innerHTML = '<div class="empty">Log your weight each morning to see your trend.</div>';
  } else {
    const wk = trendAt(series, addDays(now.date, -7));
    const mo = trendAt(series, addDays(now.date, -30));
    const delta = (x) => x ? `${now.trend - x.trend >= 0 ? '+' : ''}${(toUnit(now.trend) - toUnit(x.trend)).toFixed(1)}` : '–';
    $('#weightStats').innerHTML = `
      <div class="stat"><b>${fmtW(now.trend)}</b><span>trend ${settings.unit}</span></div>
      <div class="stat"><b>${delta(wk)}</b><span>7‑day change</span></div>
      <div class="stat"><b>${delta(mo)}</b><span>30‑day change</span></div>`;
    $('#weightChart').innerHTML = weightChart(series.filter((s) => s.date >= addDays(todayKey(), -90)));
  }

  $('#weightList').innerHTML = series.length ? [...series].reverse().slice(0, 14).map((s) =>
    `<div class="wrow"><span>${dateLabel(s.date)}</span><span>${fmtW(s.kg)} ${settings.unit} <button data-d="${s.date}" aria-label="Delete">✕</button></span></div>`).join('')
    : '<div class="hint">No weigh-ins yet.</div>';
  $$('#weightList button').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this weigh-in?')) return;
    await deleteWeight(b.dataset.d); renderProgress();
  }));

  // last 7 days of intake
  const days = Array.from({ length: 7 }, (_, i) => addDays(todayKey(), -i));
  const rows = await Promise.all(days.map(async (d) => ({ d, s: sumEntries(await entriesFor(d)) })));
  const logged = rows.filter((r) => r.s.kcal > 0);
  const avg = logged.length ? sumEntries(logged.map((r) => r.s)) : null;
  const n = logged.length || 1;
  $('#weekTable').innerHTML = `<table><tr><th>Day</th><th>kcal</th><th>P</th><th>C</th><th>F</th></tr>
    ${rows.map((r) => `<tr><td>${dateLabel(r.d)}</td><td>${r.s.kcal ? round(r.s.kcal) : '–'}</td><td>${r.s.kcal ? round(r.s.p) : '–'}</td><td>${r.s.kcal ? round(r.s.c) : '–'}</td><td>${r.s.kcal ? round(r.s.f) : '–'}</td></tr>`).join('')}
    ${avg ? `<tr><th>Average</th><th>${round(avg.kcal / n)}</th><th>${round(avg.p / n)}</th><th>${round(avg.c / n)}</th><th>${round(avg.f / n)}</th></tr>` : ''}
    <tr><td class="hint">Target</td><td class="hint">${round(settings.targets.kcal)}</td><td class="hint">${round(settings.targets.p)}</td><td class="hint">${round(settings.targets.c)}</td><td class="hint">${round(settings.targets.f)}</td></tr></table>`;
}

function weightChart(series) {
  if (series.length < 2) return '<div class="hint">Your trend line appears after two weigh-ins.</div>';
  const W = 320, H = 180, L = 34, R = 8, T = 10, B = 22;
  const t0 = parseKey(series[0].date).getTime(), t1 = parseKey(series[series.length - 1].date).getTime();
  const vals = series.flatMap((s) => [toUnit(s.kg), toUnit(s.trend)]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1) { const m = (hi + lo) / 2; lo = m - 0.5; hi = m + 0.5; }
  const pad2 = (hi - lo) * 0.1; lo -= pad2; hi += pad2;
  const x = (d) => L + ((parseKey(d).getTime() - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const dots = series.map((s) => `<circle cx="${x(s.date).toFixed(1)}" cy="${y(toUnit(s.kg)).toFixed(1)}" r="2.5" fill="var(--muted)" opacity=".6"/>`).join('');
  const line = series.map((s, i) => `${i ? 'L' : 'M'}${x(s.date).toFixed(1)},${y(toUnit(s.trend)).toFixed(1)}`).join('');
  const ticks = [lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1];
  const fmtD = (d) => parseKey(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${ticks.map((v) => `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke-dasharray="2 4"/><text x="${L - 4}" y="${y(v) + 3}" text-anchor="end">${v.toFixed(1)}</text>`).join('')}
    ${dots}<path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>
    <text x="${L}" y="${H - 6}">${fmtD(series[0].date)}</text><text x="${W - R}" y="${H - 6}" text-anchor="end">${fmtD(series[series.length - 1].date)}</text>
  </svg>`;
}

/* ---------- Settings ---------- */
function renderSettings() {
  const T = settings.targets;
  $('#tKcal').value = T.kcal; $('#tP').value = T.p; $('#tC').value = T.c; $('#tF').value = T.f;
  $('#provider').value = settings.provider;
  $('#geminiKey').value = settings.geminiKey;
  renderGeminiModels();
  $('#apiKey').value = settings.apiKey;
  $('#model').value = settings.model;
  showProviderBox();
  $('#keepPhotos').checked = settings.keepPhotos;
  $('#unit').value = settings.unit;
  $$('.wu').forEach((el) => { el.textContent = settings.unit; });
  $('#aiStatus').textContent = hasAiKey() ? 'A key is saved on this phone.' : 'No key saved yet.';
}
function showProviderBox() {
  const p = $('#provider').value;
  $('#geminiBox').classList.toggle('hidden', p !== 'gemini');
  $('#claudeBox').classList.toggle('hidden', p !== 'claude');
}
function renderGeminiModels() {
  const list = [...new Set([...(settings.geminiCandidates || []), settings.geminiModel].filter(Boolean))];
  $('#geminiModel').innerHTML = '<option value="">Pick automatically</option>' + list.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  $('#geminiModel').value = settings.geminiModel || '';
}
function readAiSettings() {
  settings.provider = $('#provider').value;
  const gk = $('#geminiKey').value.replace(/[\s"'`]/g, '');
  if (gk !== settings.geminiKey) { settings.geminiKey = gk; settings.geminiCandidates = null; }
  settings.geminiModel = $('#geminiModel').value;
  settings.apiKey = $('#apiKey').value.trim();
  settings.model = $('#model').value;
  settings.keepPhotos = $('#keepPhotos').checked;
  saveSettings();
}

function calcTargets() {
  const sex = $('#cSex').value, age = +$('#cAge').value, h = +$('#cHeight').value;
  const kg = fromUnit(+$('#cWeight').value), act = +$('#cAct').value, goal = +$('#cGoal').value;
  if (!age || !h || !kg) { toast('Fill in age, height and weight'); return; }
  const bmr = 10 * kg + 6.25 * h - 5 * age + (sex === 'm' ? 5 : -161);
  const kcal = Math.round((bmr * act * (1 + goal)) / 10) * 10;
  const p = Math.round(kg * 2);
  const f = Math.round((kcal * 0.28) / 9);
  const c = Math.max(0, Math.round((kcal - p * 4 - f * 9) / 4));
  $('#tKcal').value = kcal; $('#tP').value = p; $('#tC').value = c; $('#tF').value = f;
  toast('Filled in. Tap Save targets to keep them.');
}

async function exportData() {
  const data = { app: 'dida-macros', version: 1, exported: new Date().toISOString(),
    settings: { ...settings, apiKey: undefined, geminiKey: undefined }, entries: await allEntries(), weights: await allWeights() };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `dida-macros-backup-${todayKey()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'dida-macros') throw new Error('That is not a DiDa Macros backup');
    if (!confirm(`Import ${data.entries?.length || 0} foods and ${data.weights?.length || 0} weigh-ins? Matching items are overwritten.`)) return;
    for (const e of data.entries || []) await putEntry(e);
    for (const w of data.weights || []) await putWeight(w);
    if (data.settings) {
      const { apiKey, geminiKey } = settings;
      settings = { ...settings, ...data.settings, apiKey, geminiKey };
      saveSettings();
    }
    toast('Backup imported');
    renderSettings();
  } catch (err) { toast(err.message || 'Import failed'); }
}

async function wipe() {
  if (!confirm('Delete all foods, weigh-ins and settings on this phone? This cannot be undone.')) return;
  localStorage.removeItem('dida.settings');
  const d = await db(); d.close(); dbp = null;
  await new Promise((r) => { const q = indexedDB.deleteDatabase('dida'); q.onsuccess = q.onerror = q.onblocked = () => r(); });
  settings = loadSettings();
  toast('Everything deleted');
  renderSettings();
}

/* ---------- wiring ---------- */
function bind() {
  $$('.tab[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $$('[data-action="photo"]').forEach((b) => b.addEventListener('click', () => {
    if (currentView !== 'today') showView('today');
    $('#cameraInput').value = '';
    $('#cameraInput').click();
  }));
  $$('[data-action="library"]').forEach((b) => b.addEventListener('click', () => {
    $('#libraryInput').value = '';
    $('#libraryInput').click();
  }));
  $('#libraryInput').addEventListener('change', (e) => onPhoto(e.target.files[0]));
  $$('[data-action="manual"]').forEach((b) => b.addEventListener('click', () => openSheet()));
  $('#cameraInput').addEventListener('change', (e) => onPhoto(e.target.files[0]));

  $('#prevDay').addEventListener('click', () => { currentDate = addDays(currentDate, -1); renderToday(); });
  $('#nextDay').addEventListener('click', () => { currentDate = addDays(currentDate, 1); renderToday(); });
  $('#dateLabel').addEventListener('click', () => {
    const p = $('#datePicker');
    p.value = currentDate;
    if (p.showPicker) { try { p.showPicker(); return; } catch { /* fall through */ } }
    currentDate = todayKey(); renderToday();
  });
  $('#datePicker').addEventListener('change', (e) => { if (e.target.value) { currentDate = e.target.value; renderToday(); } });

  $('#closeSheet').addEventListener('click', closeSheet);
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
  $('#entryForm').addEventListener('submit', saveEntry);
  $('#estimateBtn').addEventListener('click', estimate);
  $('#deleteEntry').addEventListener('click', async () => {
    if (!editing || !confirm(`Delete "${editing.name}"?`)) return;
    await deleteEntryDb(editing.id); closeSheet(); toast('Deleted'); renderToday();
  });
  $$('.chip[data-scale]').forEach((b) => b.addEventListener('click', () => {
    // Scales relative to the values before the first tap, so ½× then 2× gives 2× the original.
    const cur = readForm();
    if (!baseMacros) baseMacros = { ...cur, items: items.map((it) => ({ ...it })) };
    const k = +b.dataset.scale;
    items = baseMacros.items.map((it) => ({ ...it, kcal: it.kcal * k, p: it.p * k, c: it.c * k, f: it.f * k, portion: it.portion ? scalePortion(it.portion, k) : '' }));
    const keep = baseMacros;
    renderItemEditor();
    setForm({ name: cur.name, kcal: keep.kcal * k, p: keep.p * k, c: keep.c * k, f: keep.f * k });
    baseMacros = keep;
    toast(`Scaled to ${b.textContent} the original`);
  }));
  ['#eKcal', '#eP', '#eC', '#eF'].forEach((s) => $(s).addEventListener('input', () => {
    baseMacros = null;
    if (items.length) $('#totalsHint').textContent = 'edited by hand';
  }));
  $('#photoNote').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); estimate(); } });

  $('#weightForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = parseFloat($('#weightInput').value);
    if (!v) return;
    await putWeight({ date: todayKey(), kg: fromUnit(v) });
    $('#weightInput').value = '';
    toast('Weight logged');
    renderProgress();
  });

  $('#saveTargets').addEventListener('click', () => {
    settings.targets = { kcal: +$('#tKcal').value || 0, p: +$('#tP').value || 0, c: +$('#tC').value || 0, f: +$('#tF').value || 0 };
    saveSettings(); toast('Targets saved');
  });
  $('#calcTargets').addEventListener('click', calcTargets);
  $('#provider').addEventListener('change', showProviderBox);
  $('#saveAi').addEventListener('click', () => { readAiSettings(); renderSettings(); toast('Saved'); });
  $('#testAi').addEventListener('click', async () => {
    readAiSettings();
    if (!hasAiKey()) { toast('Paste a key first'); return; }
    $('#aiStatus').innerHTML = '<span class="spinner"></span> Testing…';
    try {
      if (settings.provider === 'gemini' && !settings.geminiModel) {
        settings.geminiCandidates = null;
        try { await listGeminiModels(); renderGeminiModels(); } catch { /* callAi falls back to known models */ }
      }
      const r = await callAi({ note: 'One medium banana.' });
      const models = (settings.geminiModel ? [settings.geminiModel] : settings.geminiCandidates || []).slice(0, 3);
      const which = settings.provider === 'gemini' && models.length ? ` Models: ${models.join(', ')}.` : '';
      $('#aiStatus').textContent = `Works. Test answer: one banana ≈ ${round(r.kcal)} kcal.${which}`;
    } catch (err) { $('#aiStatus').textContent = `Failed: ${err.message}`; }
  });
  $('#unit').addEventListener('change', () => { settings.unit = $('#unit').value; saveSettings(); renderSettings(); });
  $('#exportBtn').addEventListener('click', exportData);
  $('#importFile').addEventListener('change', (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; });
  $('#wipeBtn').addEventListener('click', wipe);

  // Jump back to today when the app is reopened on a new day.
  let lastToday = todayKey();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && todayKey() !== lastToday) {
      if (currentDate === lastToday) currentDate = todayKey();
      lastToday = todayKey();
      if (currentView === 'today') renderToday();
    }
  });
}

bind();
showView('today');
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  // Always check for a new version, and reload once when it takes over so the new code runs.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded && !document.querySelector('#sheet:not(.hidden)')) { reloaded = true; location.reload(); }
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
}

// Shown at the bottom of Settings so it's easy to tell which version a phone is running.
const APP_VERSION = 'v6 (2026-11-23)';
$('#appVersion').textContent = APP_VERSION;
