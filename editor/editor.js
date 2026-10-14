// «Рецептор»: a visual editor for the recipe files of «Готовим вместе».
// A recipe is drawn as a horizontal tree: products on the left flow through the steps into the dish on the right.
// A step's branches are the steps and products it cannot start without. Files are the same JSON the phones read.

import { validate, STATIONS } from '../js/engine.js';

const POSTS = {
  sink: { color: '#2E6DB4', icon: '🚰' },
  board: { color: '#A0703F', icon: '🔪' },
  counter: { color: '#8A877C', icon: '🍽️' },
  stove: { color: '#D9481C', icon: '🔥' },
  appliance: { color: '#6E4BB3', icon: '🔌' },
};
const UNITS = { g: 'г', ml: 'мл', pcs: 'шт.', tsp: 'ч. л.', tbsp: 'ст. л.', pinch: 'щеп.', handful: 'горсть', bunch: 'пучок', to_taste: 'по вкусу' };
// Key order of a step in the files, so that a recipe opened and saved without changes stays byte for byte the same.
const STEP_KEYS = ['id', 'title', 'station', 'item', 'description', 'ingredients', 'technique', 'depends_on', 'resources', 'optional_ingredient', 'late', 'help'];

// Geometry of the tree, in pixels at 100%.
const COLW = 236, STEPW = 192, TILE = 84, ROWH = 100, PAD = 48, DISHW = 216, DISHH = 196, GAP = COLW - STEPW;

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
};

let R = null;                 // the recipe being edited, as plain JSON
let sel = { kind: 'recipe' }; // what the panel on the right shows: recipe | step | ing | eq
let selEdge = null;           // the selected link, e.g. 'dep:peel_garlic>mince_garlic'
let guessed = false;          // product links were guessed from the text of an older file
let hist = [], fut = [], typing = null;
let cam = { x: 0, y: 0, k: 1 }; // the camera over the canvas: shift in pixels and zoom
let L = null;                 // current layout
let picked = new Set();       // tiles picked with a frame or Shift+click; they move together

/* ---------------- names and ids ---------------- */

const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const slug = t => String(t || '').toLowerCase().split('').map(c => TR[c] ?? c).join('').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'item';
const uniq = (base, taken) => { let id = base, n = 2; while (taken.has(id)) id = `${base}_${n++}`; return id; };
const stepIds = () => new Set(R.steps.map(s => s.id));
const S = id => R.steps.find(s => s.id === id);
const I = id => R.ingredients.find(i => i.id === id);
const E = id => R.equipment.find(e => e.id === id);
const amountText = i => (i.amount == null ? (UNITS[i.unit] || '') : `${String(i.amount).replace('.', ',')} ${UNITS[i.unit] || i.unit || ''}`).trim();

/** Does step `from` need step `to`, directly or through other steps? */
function needs(from, to) {
  const seen = new Set(), stack = [from];
  while (stack.length) {
    const id = stack.pop();
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const s = S(id); if (s) stack.push(...s.depends_on);
  }
  return false;
}

/* ---------------- history and saving ---------------- */

// pin: first nail every tile to where it stands now, so that removing tiles does not move the others.
function commit(fn, pin = false) {
  hist.push(JSON.stringify(R)); if (hist.length > 200) hist.shift();
  fut = []; typing = null;
  const before = layout();
  if (pin) { const pos = positions(); for (const n of before.nodes) if (!pos[n.key]) pos[n.key] = [Math.round(n.x), Math.round(n.y)]; }
  fn();
  settle(before);
  saved(); render();
}
/** Tiles that appeared with an edit stand where it makes sense, not somewhere new:
    a product that lost its last step stays exactly where its tile was; a hanging product, once linked, stays where it hung;
    a new step next to its neighbour, even if that neighbour was moved by hand. */
function settle(before) {
  const after = layout(), had = before.byKey, pos = positions(), set = (n, x, y) => { pos[n.key] = [Math.round(x), Math.round(y)]; n.x = x; n.y = y; n.pinned = true; };
  for (const n of after.nodes) {
    if (had[n.key] || n.pinned) continue;
    if (n.kind === 'ing') {
      const old = n.free ? before.nodes.find(o => o.kind === 'ing' && o.id === n.id && !o.free) : had['ing:' + n.id];
      if (old) { set(n, old.x, old.y); continue; }
    }
    // Next to the tile it feeds, at the nearest free spot to its left.
    const p = n.parent;
    if (!p || !p.pinned) continue;
    const x = n.ax + p.x - p.ax, y0 = p.y + p.h / 2 - n.h / 2;
    const free = y => !after.nodes.some(o => o !== n && o.x < x + n.w + 8 && o.x + o.w + 8 > x && o.y < y + n.h + 8 && o.y + o.h + 8 > y);
    let y = y0;
    for (let i = 1; i < 60 && !free(y); i++) y = y0 + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * ROWH;
    set(n, x, y);
  }
  if (!Object.keys(pos).length) { delete R.editor.positions; if (!Object.keys(R.editor).length) delete R.editor; }
}
function undo() {
  if (!hist.length) return;
  fut.push(JSON.stringify(R)); R = JSON.parse(hist.pop()); typing = null;
  fixSelection(); saved(); render();
}
function redo() {
  if (!fut.length) return;
  hist.push(JSON.stringify(R)); R = JSON.parse(fut.pop()); typing = null;
  fixSelection(); saved(); render();
}
function fixSelection() {
  if ((sel.kind === 'step' && !S(sel.id)) || (sel.kind === 'ing' && !I(sel.id)) || (sel.kind === 'eq' && !E(sel.id))) sel = { kind: 'recipe' };
  selEdge = null;
}
const saved = () => store.set('receptor:draft', { R, guessed });

/** Steps in an order the phone can list them: every step after the steps it needs, otherwise as close to the old order as possible. */
function ordered(steps) {
  const idx = new Map(steps.map((s, i) => [s.id, i]));
  const indeg = new Map(steps.map(s => [s.id, s.depends_on.filter(d => idx.has(d)).length]));
  const kids = {};
  steps.forEach(s => s.depends_on.forEach(d => (kids[d] = kids[d] || []).push(s.id)));
  const ready = steps.filter(s => !indeg.get(s.id)).map(s => s.id), out = [];
  while (ready.length) {
    ready.sort((a, b) => idx.get(a) - idx.get(b));
    const id = ready.shift(); out.push(id);
    for (const k of kids[id] || []) { indeg.set(k, indeg.get(k) - 1); if (!indeg.get(k)) ready.push(k); }
  }
  return out.length === steps.length ? out.map(id => steps[idx.get(id)]) : steps;
}
function cleanStep(s) {
  const o = {};
  for (const k of STEP_KEYS) if (k in s) o[k] = s[k];
  for (const k of Object.keys(s)) if (!(k in o)) o[k] = s[k];
  if (!o.ingredients || !o.ingredients.length) delete o.ingredients;
  if (!o.late) delete o.late;
  return o;
}
// Where tiles were moved by hand is kept in the file under "editor"; the phones ignore it.
const positions = () => ((R.editor = R.editor || {}).positions = R.editor.positions || {});
function fileText() {
  const out = { ...R, steps: ordered(R.steps).map(cleanStep) };
  if (R.editor) {
    const keys = new Set(layout().nodes.map(n => n.key));
    const { positions: pos = {}, ...rest } = R.editor;
    const kept = Object.fromEntries(Object.entries(pos).filter(([k]) => keys.has(k)));
    if (Object.keys(kept).length) out.editor = { ...rest, positions: kept };
    else if (Object.keys(rest).length) out.editor = rest;
    else delete out.editor;
  }
  return JSON.stringify(out, null, 2) + '\n';
}

/* ---------------- opening ---------------- */

function normalize(r) {
  if (!r || typeof r !== 'object' || !Array.isArray(r.steps)) throw 'это не похоже на файл рецепта: в нём нет шагов.';
  r.ingredients = r.ingredients || []; r.equipment = r.equipment || [];
  for (const s of r.steps) {
    s.depends_on = s.depends_on || []; s.resources = s.resources || []; s.ingredients = s.ingredients || [];
    if (!('help' in s)) s.help = null;
  }
  return r;
}

// Older files do not say which products go into which step. Guess: the first step whose title names the product,
// otherwise the first step whose instruction does. Russian endings are cut off, and «перец» also matches «перца».
const STOP = new Set(['средний', 'средняя', 'нарезанные', 'молотый', 'молотая', 'сладкий', 'сладкая', 'красный', 'черный', 'готовые', 'собственном', 'соку', 'зубчики', 'свежий', 'свежая', 'или', 'для', 'крупный', 'мелкий']);
function guessLinks(r) {
  const norm = t => ' ' + String(t || '').toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9]+/g, ' ') + ' ';
  const titles = r.steps.map(s => norm(s.title + ' ' + (s.item || ''))), texts = r.steps.map(s => norm(s.description));
  for (const ing of r.ingredients) {
    const stems = norm(ing.name).trim().split(' ').filter(w => w.length >= 3 && !STOP.has(w)).flatMap(w => {
      const st = w.replace(/[аеиоуыэюяйь]+$/, '');
      return [st.length >= 3 ? st : w, ...(/ец$/.test(w) ? [w.slice(0, -2) + 'ц'] : [])];
    });
    const has = t => stems.some(st => t.includes(' ' + st));
    let i = titles.findIndex(has);
    if (i < 0) i = texts.findIndex(has);
    if (i >= 0) r.steps[i].ingredients.push(ing.id);
  }
}

function load(obj) {
  const r = normalize(obj);
  guessed = r.ingredients.length > 0 && !obj.steps.some(s => s.ingredients.length);
  if (guessed) guessLinks(r);
  R = r; hist = []; fut = []; sel = { kind: 'recipe' }; selEdge = null; typing = null; picked = new Set();
  saved(); render(); firstView();
}

let book = null;
async function loadBook() {
  if (book) return book;
  const idx = await (await fetch('../recipes/index.json', { cache: 'no-cache' })).json();
  book = await Promise.all(idx.recipes.map(async f => {
    try { const r = await (await fetch('../recipes/' + f, { cache: 'no-cache' })).json(); return { f, r }; } catch (e) { return null; }
  }));
  return (book = book.filter(Boolean));
}
const dishPic = r => (r.image ? `<img src="../recipes/${esc(r.image)}" alt="">` : `<span class="emo">${esc(r.icon || '🍽️')}</span>`);
const bookTiles = () => (book || []).map((b, i) => `<button class="btile" data-act="openbook" data-i="${i}">${dishPic(b.r)}<b>${esc(b.r.title)}</b></button>`).join('');

function newRecipe() {
  load({
    format_version: 1, id: 'new_dish', version: 1, title: 'Новое блюдо', icon: '🍽️', base_servings: 2, players: { min: 1, max: 3 },
    equipment: [], ingredients: [],
    steps: [{ id: 'serve', title: 'Подать', station: 'counter', item: 'блюдо', description: 'Разложите по тарелкам.', ingredients: [], depends_on: [], resources: [], help: null }],
  });
}

/* ---------------- layout ---------------- */

// Columns are counted back from the dish: a step stands one column left of the first step that needs it,
// so every product and every step sits right next to where it is used. Rows are a tidy tree hanging off the dish.
function layout() {
  const steps = R.steps, ids = stepIds(), order = new Map(steps.map((s, i) => [s.id, i]));
  const users = {};
  steps.forEach(s => s.depends_on.forEach(d => { if (ids.has(d)) (users[d] = users[d] || []).push(s.id); }));
  const col = {}, busy = new Set();
  const colOf = id => {
    if (id in col) return col[id];
    if (busy.has(id)) return -1;
    busy.add(id);
    const us = users[id] || [];
    const c = us.length ? Math.min(...us.map(colOf)) - 1 : -1;
    busy.delete(id);
    return (col[id] = c);
  };
  steps.forEach(s => colOf(s.id));
  const parent = {};
  for (const s of steps) {
    const us = users[s.id] || [];
    parent[s.id] = us.length ? us.reduce((a, b) => (col[b] < col[a] || (col[b] === col[a] && order.get(b) < order.get(a)) ? b : a)) : 'dish';
  }
  const kids = { dish: [] }; steps.forEach(s => (kids[s.id] = []));
  steps.forEach(s => kids[parent[s.id]].push(s.id));

  const nodes = [];
  const build = id => {
    const s = S(id);
    const n = { key: 'step:' + id, kind: 'step', id, col: col[id], kids: kids[id].map(build) };
    for (const i of s.ingredients) if (I(i)) n.kids.push({ key: `ing:${i}@${id}`, kind: 'ing', id: i, step: id, col: col[id] - 1, kids: [] });
    return n;
  };
  const dish = { key: 'dish', kind: 'dish', col: 0, kids: kids.dish.map(build) };
  let row = 0;
  const place = (n, parent) => {
    n.parent = parent || null;
    nodes.push(n);
    if (!n.kids.length) { n.row = row++; return; }
    n.kids.forEach(k => place(k, n));
    n.row = (n.kids[0].row + n.kids[n.kids.length - 1].row) / 2;
  };
  place(dish);
  if (!dish.kids.length) dish.row = 0, row = 1;
  const minCol = Math.min(0, ...nodes.map(n => n.col));
  // Products that no step uses yet hang on their own, unconnected, under the tree.
  const used = new Set(steps.flatMap(s => s.ingredients));
  for (const i of R.ingredients) if (!used.has(i.id)) nodes.push({ key: 'ing:' + i.id, kind: 'ing', id: i.id, step: null, free: true, col: minCol, row: row++, kids: [], parent: null });
  for (const n of nodes) {
    n.w = n.kind === 'dish' ? DISHW : n.kind === 'ing' ? TILE : STEPW;
    n.h = n.kind === 'dish' ? DISHH : TILE;
    const colX = PAD + (n.col - minCol) * COLW;
    n.x = n.kind === 'ing' ? colX + STEPW - TILE : colX;
    n.cy = Math.round(PAD + n.row * ROWH + TILE / 2); // whole pixels, so a tile nailed down where it stands does not budge
    n.y = n.cy - n.h / 2;
  }
  const byKey = Object.fromEntries(nodes.map(n => [n.key, n]));
  const edges = [];
  for (const n of nodes) for (const k of n.kids) edges.push({ key: k.kind === 'ing' ? `ing:${k.id}>${n.id}` : n.kind === 'dish' ? `sink:${k.id}` : `dep:${k.id}>${n.id}`, from: k, to: n, kind: k.kind === 'ing' ? 'ing' : n.kind === 'dish' ? 'sink' : 'dep' });
  for (const s of steps) for (const d of s.depends_on) {
    if (parent[d] !== s.id && byKey['step:' + d]) edges.push({ key: `dep:${d}>${s.id}`, from: byKey['step:' + d], to: byKey['step:' + s.id], kind: 'far' });
  }
  const top = Math.min(...nodes.map(n => n.y)), shift = top < PAD ? PAD - top : 0;
  nodes.forEach(n => { n.y += shift; n.cy += shift; n.ax = n.x; n.ay = n.y; });
  const pos = (R.editor && R.editor.positions) || {};
  for (const n of nodes) { const p = pos[n.key]; if (p) { n.x = p[0]; n.y = p[1]; n.cy = n.y + n.h / 2; n.pinned = true; } }
  const x1 = Math.min(...nodes.map(n => n.x)), y1 = Math.min(...nodes.map(n => n.y));
  const x2 = Math.max(...nodes.map(n => n.x + n.w)), y2 = Math.max(...nodes.map(n => n.y + n.h));
  return { nodes, edges, byKey, box: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } };
}

/** A link drawn like a tram line: straight, then one rounded bend in the gap just before the step it feeds.
    If a tile was moved so that the step it feeds is not to its right, the link becomes a soft curve. */
function wire(x1, y1, x2, y2) {
  if (x2 - x1 < 24) { const c = Math.max(60, (x1 - x2) / 2); return `M${x1} ${y1}C${x1 + c} ${y1} ${x2 - c} ${y2} ${x2} ${y2}`; }
  if (Math.abs(y1 - y2) < 0.5) return `M${x1} ${y1}H${x2}`;
  const mx = Math.max(x1 + 12, x2 - GAP / 2), r = Math.min(14, Math.abs(y2 - y1) / 2, mx - x1, x2 - mx), s = y2 > y1 ? 1 : -1;
  return `M${x1} ${y1}H${mx - r}Q${mx} ${y1} ${mx} ${y1 + s * r}V${y2 - s * r}Q${mx} ${y2} ${mx + r} ${y2}H${x2}`;
}

/* ---------------- drawing ---------------- */

function render() {
  document.body.classList.toggle('empty', !R);
  renderTop();
  if (!R) { $('#side').innerHTML = ''; $('#insp').innerHTML = ''; welcome(); return; }
  renderSide(); renderCanvas(); renderInsp();
}

function renderTop() {
  $('#docname').textContent = R ? R.title || 'Без названия' : '';
  document.title = R ? `${R.title} · Рецептор` : 'Рецептор';
  $('[data-act="undo"]').disabled = !hist.length;
  $('[data-act="redo"]').disabled = !fut.length;
  $('[data-act="download"]').disabled = !R;
  const c = $('#check');
  if (!R) { c.hidden = true; return; }
  const is = issues(), errs = is.filter(i => i.err).length;
  c.hidden = false;
  c.className = 'check ' + (errs ? 'bad' : is.length ? 'warn' : 'ok');
  c.textContent = errs ? 'Есть ошибка' : is.length ? `${is.length} ${plural(is.length, 'замечание', 'замечания', 'замечаний')}` : 'Рецепт в порядке';
}
function plural(n, one, few, many) { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; }

function issues() {
  const out = [];
  try { validate(clone(R)); } catch (e) { out.push({ err: true, text: 'Телефоны не откроют рецепт: ' + e }); }
  const used = new Set(R.steps.flatMap(s => s.ingredients));
  for (const i of R.ingredients) if (!used.has(i.id)) out.push({ text: `Продукт «${i.name}» не входит ни в один шаг.`, sel: { kind: 'ing', id: i.id } });
  for (const s of R.steps) if (!String(s.description || '').trim()) out.push({ text: `У шага «${s.title}» нет инструкции.`, sel: { kind: 'step', id: s.id } });
  const needed = new Set(R.steps.flatMap(s => s.resources));
  for (const e of R.equipment) if (!needed.has(e.id)) out.push({ text: `Инвентарь «${e.name}» не нужен ни одному шагу.`, sel: { kind: 'eq', id: e.id } });
  return out;
}

function renderSide() {
  const used = new Set(R.steps.flatMap(s => s.ingredients));
  const needed = new Set(R.steps.flatMap(s => s.resources));
  $('#side').innerHTML = `
    <h2>Продукты</h2>
    <p class="hint">Перетащите продукт на шаг, где он идёт в дело.</p>
    <div class="ptiles">${R.ingredients.map(i => `<button class="ptile ${used.has(i.id) ? '' : 'unused'} ${sel.kind === 'ing' && sel.id === i.id ? 'sel' : ''}" data-drag="ing:${esc(i.id)}" data-act="seling" data-id="${esc(i.id)}" title="${used.has(i.id) ? esc(i.name) : 'Не входит ни в один шаг'}">
        <span class="pi">${esc(i.icon || '🥕')}</span><span class="pn">${esc(i.name)}</span><span class="pa">${esc(amountText(i))}</span></button>`).join('')}
      <button class="ptile add" data-act="adding"><span class="pi">+</span><span class="pn">Продукт</span></button></div>
    <h2>Инвентарь</h2>
    <ul class="eqs">${R.equipment.map(e => `<li><button class="eq ${needed.has(e.id) ? '' : 'unused'} ${sel.kind === 'eq' && sel.id === e.id ? 'sel' : ''}" data-act="seleq" data-id="${esc(e.id)}"><span>${esc(e.icon || '🍴')}</span><span class="en">${esc(e.name)}</span>${(e.count || 1) > 1 ? `<span class="ec">${e.count}</span>` : ''}</button></li>`).join('')}
      <li><button class="eq add" data-act="addeq"><span>+</span><span class="en">Инвентарь</span></button></li></ul>`;
}

function renderCanvas() {
  L = layout();
  const world = $('#world');
  const on1 = n => picked.has(n.key) || (!picked.size && ((n.kind === 'dish' && sel.kind === 'recipe') || (n.kind === sel.kind && n.id === sel.id)));
  const edgeSvg = L.edges.map(e => {
    const d = wire(e.from.x + e.from.w, e.from.cy, e.to.x, e.to.cy);
    const on = selEdge === e.key || (sel.kind === 'step' && (e.from.id === sel.id || e.to.id === sel.id) && e.kind !== 'ing') || (sel.kind === 'ing' && e.kind === 'ing' && e.from.id === sel.id);
    return `<path class="wire ${e.kind} ${on ? 'on' : ''}" d="${d}"/>` + (e.kind === 'sink' ? '' : `<path class="hit" d="${d}" data-edge="${esc(e.key)}"/>`);
  }).join('');
  const tiles = L.nodes.map(n => {
    const pos = `left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px`;
    if (n.kind === 'dish') {
      return `<div class="node dish ${on1(n) ? 'sel' : ''}" data-node="dish" data-key="dish" style="${pos}">
        <span class="dp">${dishPic(R)}</span><b>${esc(R.title || 'Без названия')}</b>
        <small>${R.steps.length} ${plural(R.steps.length, 'шаг', 'шага', 'шагов')}, ${R.ingredients.length} ${plural(R.ingredients.length, 'продукт', 'продукта', 'продуктов')}</small></div>`;
    }
    if (n.kind === 'ing') {
      const i = I(n.id);
      return `<div class="node ing ${n.free ? 'free' : ''} ${on1(n) ? 'sel' : ''}" data-node="ing:${esc(n.id)}" data-key="${esc(n.key)}" style="${pos}" title="${esc(i.name)}${n.free ? ' — не входит ни в один шаг. Потяните от кружка к шагу.' : ''}">
        <span class="pi">${esc(i.icon || '🥕')}</span><span class="pn">${esc(i.name)}</span><span class="pa">${esc(amountText(i))}</span>
        <span class="port" data-port="ing:${esc(n.id)}" title="Потяните к шагу, где этот продукт тоже нужен"></span></div>`;
    }
    const s = S(n.id), post = POSTS[s.station] || POSTS.counter;
    const eq = s.resources.map(r => E(r)).filter(Boolean).map(e => esc(e.icon || '🍴')).join('');
    return `<div class="node step ${on1(n) ? 'sel' : ''}" data-node="step:${esc(n.id)}" data-key="${esc(n.key)}" style="${pos};--post:${post.color}">
      <button class="plus" data-act="addbefore" data-id="${esc(n.id)}" title="Добавить шаг, без которого этот не начнётся" aria-label="Добавить шаг перед «${esc(s.title)}»">+</button>
      <b class="st">${esc(s.title || 'Без названия')}</b>
      <span class="sm"><span>${post.icon} ${esc(STATIONS[s.station] || 'Стол')}${s.late ? ' · в конце' : ''}</span><span class="se">${eq}</span></span>
      <span class="port" data-port="step:${esc(n.id)}" title="Потяните к шагу, который без этого не начнётся"></span></div>`;
  }).join('');
  let cut = '';
  const se = selEdge && L.edges.find(e => e.key === selEdge);
  if (se) cut = `<button class="cut" data-act="cut" style="left:${Math.max(se.from.x + se.from.w + 12, se.to.x - GAP / 2)}px;top:${(se.from.cy + se.to.cy) / 2}px">Убрать связь</button>`;
  const banner = guessed ? `<div class="guess">Этот файл не говорит, какие продукты в каком шаге. Связи угаданы по тексту инструкций — проверьте их. <button data-act="okguess">Понятно</button></div>` : '';
  world.innerHTML = `<svg class="wires" width="1" height="1" aria-hidden="true">${edgeSvg}<path class="wire temp" id="temp" d=""/></svg>${tiles}${cut}`;
  $('#canvas').querySelector('.guess')?.remove();
  if (banner) $('#canvas').insertAdjacentHTML('beforeend', banner);
  applyCam();
}

function welcome() {
  const w = $('#world');
  w.style.transform = ''; $('#canvas').style.backgroundSize = ''; $('#canvas').style.backgroundPosition = '';
  w.innerHTML = `<div class="hello"><h1>Соберите рецепт из плиток</h1>
    <p>Продукты слева, готовое блюдо справа. Каждая ветка — то, без чего следующий шаг не начнётся.</p>
    <div class="btiles">${book ? bookTiles() : '<span class="muted">Загружаем книгу рецептов…</span>'}</div>
    <div class="row"><button class="tb" data-act="new">Начать новый</button><button class="tb" data-act="file">Открыть файл</button></div></div>`;
  if (!book) loadBook().then(() => { if (!R) welcome(); }).catch(() => {});
}

/* ---------------- the panel on the right ---------------- */

const field = (label, html, hint = '') => `<label class="f"><span class="fl">${label}</span>${html}${hint ? `<span class="fh">${hint}</span>` : ''}</label>`;
const input = (f, v, attrs = '') => `<input data-f="${f}" value="${esc(v ?? '')}" ${attrs}>`;

function renderInsp() {
  const p = $('#insp');
  if (sel.kind === 'step') return (p.innerHTML = inspStep(S(sel.id)));
  if (sel.kind === 'ing') return (p.innerHTML = inspIng(I(sel.id)));
  if (sel.kind === 'eq') return (p.innerHTML = inspEq(E(sel.id)));
  if (sel.kind === 'multi') return (p.innerHTML = inspMulti());
  p.innerHTML = inspRecipe();
}

function inspMulti() {
  return `<h2 class="ph">Выбрано плиток: ${picked.size}</h2>
    <p class="fh">Перетащите любую из них — сдвинутся все вместе. Shift+щелчок добавляет плитку к выбору или убирает её.</p>
    <div class="row"><button class="tb" data-act="unplace">Вернуть на свои места</button></div>
    <button class="danger" data-act="delpicked">Удалить выбранные</button>`;
}

function inspRecipe() {
  return `<h2 class="ph">Блюдо</h2>
    ${field('Название', input('title', R.title))}
    ${field('Картинка', input('image', R.image, 'placeholder="images/dish.svg"'), 'Путь внутри папки recipes. Пока картинки нет, на плитке будет значок.')}
    ${field('Значок', input('icon', R.icon, 'maxlength="4" class="short"'))}
    <div class="two">${field('Порций', input('base_servings', R.base_servings, 'type="number" min="1" data-t="num"'))}
      ${field('Поваров', `<span class="range">${input('players.min', R.players?.min ?? 1, 'type="number" min="1" max="4" data-t="num"')}–${input('players.max', R.players?.max ?? 3, 'type="number" min="1" max="4" data-t="num"')}</span>`)}</div>
    <div class="two">${field('Имя файла', input('id', R.id, 'data-t="id"'), 'Латиницей. Так файл и назовётся.')}
      ${field('Версия', input('version', R.version, 'type="number" min="1" data-t="num"'), 'Увеличьте, если меняли шаги.')}</div>
    <div class="row"><button class="tb" data-act="addstep">Добавить шаг</button>${R.editor && R.editor.positions && Object.keys(R.editor.positions).length ? '<button class="tb" data-act="unplaceall">Разложить плитки заново</button>' : ''}</div>`;
}

function chips(all, on, act, label) {
  return `<div class="chips">${all.map(x => `<button class="chip ${on.includes(x.id) ? 'on' : ''}" data-act="${act}" data-id="${esc(x.id)}" aria-pressed="${on.includes(x.id)}">${esc(x.icon || '')} ${esc(x[label])}</button>`).join('') || '<span class="muted">Пока пусто.</span>'}</div>`;
}

function inspStep(s) {
  const post = POSTS[s.station] || POSTS.counter;
  const deps = s.depends_on.map(d => S(d)).filter(Boolean);
  const addable = R.steps.filter(o => o.id !== s.id && !s.depends_on.includes(o.id) && !needs(o.id, s.id));
  const users = R.steps.filter(o => o.depends_on.includes(s.id));
  return `<div class="pstrip" style="--post:${post.color}"></div>
    ${field('Шаг', `<input data-f="title" class="big" value="${esc(s.title)}">`)}
    ${field('Инструкция', `<textarea data-f="description" rows="6">${esc(s.description)}</textarea>`, 'Если жарить или варить — до какого состояния и сколько минут.')}
    <div class="f"><span class="fl">Пост</span><div class="posts">${Object.entries(STATIONS).map(([k, name]) => `<button class="post ${s.station === k ? 'on' : ''}" style="--post:${POSTS[k].color}" data-act="post" data-k="${k}" aria-pressed="${s.station === k}">${POSTS[k].icon}<span>${name}</span></button>`).join('')}</div></div>
    ${field('С чем работает шаг', input('item', s.item, 'placeholder="лук, суп"'), 'Кто помыл перец, тому предложат его же резать.')}
    <div class="f"><span class="fl">Продукты</span>${chips(R.ingredients, s.ingredients, 'toging', 'name')}</div>
    <div class="f"><span class="fl">Инвентарь</span>${chips(R.equipment, s.resources, 'togeq', 'name')}</div>
    <div class="f"><span class="fl">Начинается после</span><div class="chips">${deps.map(d => `<span class="chip on dep">${esc(d.title)}<button data-act="undep" data-id="${esc(d.id)}" aria-label="Убрать «${esc(d.title)}»">×</button></span>`).join('') || '<span class="muted">Можно начинать сразу.</span>'}</div>
      ${addable.length ? `<select data-act="adddep"><option value="">Добавить шаг…</option>${addable.map(o => `<option value="${esc(o.id)}">${esc(o.title)}</option>`).join('')}</select>` : ''}</div>
    ${users.length ? `<p class="fh">Нужен для: ${users.map(u => `«${esc(u.title)}»`).join(', ')}.</p>` : '<p class="fh">Ничего после него не ждёт — это последний шаг перед блюдом.</p>'}
    <label class="cb"><input type="checkbox" data-f="late" data-t="bool" ${s.late ? 'checked' : ''}> Предлагать в самом конце, как «Накрыть на стол»</label>
    <div class="f"><span class="fl">Помощь второго повара</span>
      <select data-f="help.type" data-t="help"><option value="">Не нужна</option><option value="split" ${s.help?.type === 'split' ? 'selected' : ''}>Разделить работу</option><option value="assist" ${s.help?.type === 'assist' ? 'selected' : ''}>Подсобить</option></select>
      ${s.help ? input('help.text', s.help.text, 'placeholder="Почистите вторую картофелину."') : ''}</div>
    ${field('Служебное имя', input('id', s.id, 'data-t="id"'), 'Латиницей, для файла.')}
    <button class="danger" data-act="delstep">Удалить шаг</button>`;
}

function inspIng(i) {
  const steps = R.steps.filter(s => s.ingredients.includes(i.id));
  return `<h2 class="ph">${esc(i.icon || '🥕')} Продукт</h2>
    ${field('Название', input('name', i.name))}
    <div class="two">${field('Сколько', input('amount', i.amount, 'type="number" min="0" step="any" data-t="numnull"'))}
      ${field('Мера', `<select data-f="unit">${Object.entries(UNITS).map(([k, v]) => `<option value="${k}" ${i.unit === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`)}</div>
    ${field('Значок', input('icon', i.icon, 'maxlength="4" class="short"'))}
    <label class="cb"><input type="checkbox" data-f="optional" data-t="bool" ${i.optional ? 'checked' : ''}> По желанию</label>
    <div class="f"><span class="fl">Идёт в шаги</span><div class="chips">${steps.map(s => `<span class="chip on dep">${esc(s.title)}<button data-act="unuse" data-id="${esc(s.id)}" aria-label="Убрать из «${esc(s.title)}»">×</button></span>`).join('') || '<span class="muted">Ни в один. Перетащите плитку продукта на шаг.</span>'}</div></div>
    ${field('Служебное имя', input('id', i.id, 'data-t="id"'))}
    <button class="danger" data-act="deling">Удалить продукт</button>`;
}

function inspEq(e) {
  const steps = R.steps.filter(s => s.resources.includes(e.id));
  return `<h2 class="ph">${esc(e.icon || '🍴')} Инвентарь</h2>
    ${field('Название', input('name', e.name))}
    <div class="two">${field('Сколько штук', input('count', e.count ?? 1, 'type="number" min="1" data-t="num"'), 'Столько шагов с ним могут идти одновременно.')}
      ${field('Значок', input('icon', e.icon, 'maxlength="4" class="short"'))}</div>
    <div class="f"><span class="fl">Нужен шагам</span><div class="chips">${steps.map(s => `<span class="chip on">${esc(s.title)}</span>`).join('') || '<span class="muted">Пока ни одному. Отметьте его в нужном шаге.</span>'}</div></div>
    ${field('Служебное имя', input('id', e.id, 'data-t="id"'))}
    <button class="danger" data-act="deleq">Удалить инвентарь</button>`;
}

/** The object the panel on the right edits. */
const target = () => (sel.kind === 'step' ? S(sel.id) : sel.kind === 'ing' ? I(sel.id) : sel.kind === 'eq' ? E(sel.id) : R);

function setField(el) {
  const t = target(); if (!t) return;
  const path = el.dataset.f, kind = el.dataset.t;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (kind === 'num') v = v === '' ? undefined : Math.max(0, Number(v));
  if (kind === 'numnull') v = v === '' ? null : Number(v);
  if (kind === 'help') { t.help = v ? { type: v, text: t.help?.text || '' } : null; return true; }
  if (kind === 'id') return renameId(t, el);
  const keys = path.split('.'), last = keys.pop();
  let o = t; for (const k of keys) o = o[k] = o[k] || {};
  if (v === undefined) delete o[last]; else o[last] = v;
  return false;
}

function renameId(t, el) {
  const nid = slug(el.value), old = t.id;
  if (nid === old) { el.value = old; return false; }
  const taken = sel.kind === 'step' ? stepIds() : sel.kind === 'ing' ? new Set(R.ingredients.map(i => i.id)) : sel.kind === 'eq' ? new Set(R.equipment.map(e => e.id)) : new Set();
  if (taken.has(nid)) { toast(`Имя «${nid}» уже занято.`); el.value = old; return false; }
  t.id = nid;
  // Tiles keep their places under the new name.
  const pos = R.editor && R.editor.positions;
  if (pos && (sel.kind === 'step' || sel.kind === 'ing')) for (const k of Object.keys(pos)) {
    const m = k.match(/^(step|ing):([^@]+)(?:@(.+))?$/); if (!m) continue;
    let [, kind, a, b] = m;
    if (sel.kind === 'step' && kind === 'step' && a === old) a = nid;
    else if (sel.kind === 'step' && kind === 'ing' && b === old) b = nid;
    else if (sel.kind === 'ing' && kind === 'ing' && a === old) a = nid;
    else continue;
    pos[`${kind}:${a}${b ? '@' + b : ''}`] = pos[k]; delete pos[k];
  }
  for (const s of R.steps) {
    if (sel.kind === 'step') s.depends_on = s.depends_on.map(d => (d === old ? nid : d));
    if (sel.kind === 'ing') s.ingredients = s.ingredients.map(d => (d === old ? nid : d));
    if (sel.kind === 'eq') s.resources = s.resources.map(d => (d === old ? nid : d));
  }
  if (sel.kind !== 'recipe') sel.id = nid;
  return true;
}

/* ---------------- editing ---------------- */

function select(s) { sel = s; selEdge = null; typing = null; picked = new Set(); render(); }

/** The panel on the right follows the picked tiles: one tile shows itself, several show what can be done with them. */
function pickedToSel() {
  selEdge = null; typing = null;
  if (picked.size > 1) { sel = { kind: 'multi' }; return; }
  if (!picked.size) { sel = { kind: 'recipe' }; return; }
  const k = [...picked][0];
  sel = k === 'dish' ? { kind: 'recipe' } : k.startsWith('step:') ? { kind: 'step', id: k.slice(5) } : { kind: 'ing', id: k.slice(4).split('@')[0] };
}

function connect(src, dst) {
  if (!dst || !dst.startsWith('step:')) return toast('Отпустите на шаге, который без этого не начнётся.');
  const b = S(dst.slice(5));
  if (src.startsWith('ing:')) {
    const iid = src.slice(4);
    if (b.ingredients.includes(iid)) return toast(`«${I(iid).name}» уже идёт в «${b.title}».`);
    return commit(() => { b.ingredients.push(iid); sel = { kind: 'step', id: b.id }; });
  }
  const a = S(src.slice(5));
  if (a.id === b.id) return;
  if (b.depends_on.includes(a.id)) return toast('Эти шаги уже связаны.');
  if (needs(a.id, b.id)) return toast(`Получится круг: «${a.title}» уже ждёт «${b.title}».`);
  commit(() => { b.depends_on.push(a.id); sel = { kind: 'step', id: b.id }; });
}

function cutEdge(key) {
  const [kind, rest] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  const [a, b] = rest.split('>');
  commit(() => {
    if (kind === 'dep') S(b).depends_on = S(b).depends_on.filter(d => d !== a);
    if (kind === 'ing') S(b).ingredients = S(b).ingredients.filter(d => d !== a);
    selEdge = null;
  });
}

function addStep(before) {
  commit(() => {
    const id = uniq('step', stepIds());
    const s = { id, title: 'Новый шаг', station: before ? S(before).station : 'counter', item: before ? S(before).item : '', description: '', ingredients: [], depends_on: [], resources: [], help: null };
    if (before) {
      const b = S(before);
      b.depends_on.push(id);
      R.steps.splice(R.steps.indexOf(b), 0, s);
    } else R.steps.push(s);
    sel = { kind: 'step', id };
  });
  setTimeout(() => { const t = $('#insp [data-f="title"]'); if (t) { t.focus(); t.select(); } }, 0);
}

/** Delete tiles: 'step:ID', a product tile 'ing:ID@STEP' or 'ing:ID', or a whole product 'prod:ID'.
    Only the tiles themselves and their links go; every other tile stays where it is. Steps that fed a removed step
    become last steps; products of a removed step stay hanging, unconnected, where they were. The dish stays. */
function deleteKeys(keys) {
  keys = keys.filter(k => k !== 'dish');
  if (!keys.length) return toast('Блюдо не удаляется — это корень рецепта.');
  commit(() => {
    const gone = new Set();
    for (const k of keys) {
      if (k.startsWith('step:')) {
        const id = k.slice(5);
        R.steps = R.steps.filter(o => o.id !== id);
        for (const o of R.steps) o.depends_on = o.depends_on.filter(d => d !== id);
      } else if (k.startsWith('prod:')) gone.add(k.slice(5));
      else if (k.startsWith('ing:')) {
        const [id, step] = k.slice(4).split('@');
        if (step && S(step)) S(step).ingredients = S(step).ingredients.filter(i => i !== id);
        gone.add(id + (step ? '@' : ''));
      }
    }
    const used = new Set(R.steps.flatMap(o => o.ingredients));
    const drop = new Set([...gone].filter(g => !g.endsWith('@') || !used.has(g.slice(0, -1))).map(g => g.replace(/@$/, '')));
    R.ingredients = R.ingredients.filter(i => !drop.has(i.id));
    for (const o of R.steps) o.ingredients = o.ingredients.filter(i => !drop.has(i));
    picked = new Set(); sel = { kind: 'recipe' }; selEdge = null;
  }, true);
}

/* ---------------- input ---------------- */

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (b && b.tagName === 'SELECT') return;
  if (!b) {
    if (!e.target.closest('#pop') && !e.target.closest('[data-act="open"],[data-act="issues"]')) closePop();
    const hit = e.target.closest('[data-edge]');
    if (hit) { selEdge = hit.dataset.edge; renderCanvas(); return; }
    const n = e.target.closest('[data-key]');
    if (dragged) return;
    if (n) {
      const key = n.dataset.key;
      if (e.shiftKey) { if (picked.has(key)) picked.delete(key); else picked.add(key); } else picked = new Set([key]);
      pickedToSel(); return render();
    }
    if (R && e.target.closest('#canvas') && !e.target.closest('.zoom, .guess')) { picked = new Set(); pickedToSel(); render(); }
    return;
  }
  const a = b.dataset.act, id = b.dataset.id;
  switch (a) {
    case 'open': return openPop(b);
    case 'file': closePop(); $('#file').value = ''; return $('#file').click();
    case 'openbook': closePop(); return load(clone(book[+b.dataset.i].r));
    case 'new': closePop(); return newRecipe();
    case 'undo': return undo();
    case 'redo': return redo();
    case 'download': return download();
    case 'issues': return issuesPop(b);
    case 'gotoissue': { closePop(); const it = issues()[+b.dataset.i]; if (it && it.sel) select(it.sel); return; }
    case 'okguess': guessed = false; saved(); return renderCanvas();
    case 'zoomin': return zoomBy(1.25);
    case 'zoomout': return zoomBy(1 / 1.25);
    case 'unplace': return commit(() => { const pos = positions(); picked.forEach(k => delete pos[k]); });
    case 'unplaceall': return commit(() => { delete R.editor.positions; if (!Object.keys(R.editor).length) delete R.editor; });
    case 'fit': return fit();
    case 'cut': return cutEdge(selEdge);
    case 'addbefore': return addStep(id);
    case 'addstep': return addStep(null);
    case 'delstep': return deleteKeys(['step:' + sel.id]);
    case 'delpicked': return deleteKeys([...picked]);
    case 'seling': if (!dragged) select({ kind: 'ing', id }); return;
    case 'seleq': return select({ kind: 'eq', id });
    case 'post': return commit(() => { S(sel.id).station = b.dataset.k; });
    case 'toging': return commit(() => { const s = S(sel.id); s.ingredients = s.ingredients.includes(id) ? s.ingredients.filter(x => x !== id) : [...s.ingredients, id]; });
    case 'togeq': return commit(() => { const s = S(sel.id); s.resources = s.resources.includes(id) ? s.resources.filter(x => x !== id) : [...s.resources, id]; });
    case 'undep': return commit(() => { const s = S(sel.id); s.depends_on = s.depends_on.filter(x => x !== id); });
    case 'unuse': return commit(() => { const s = S(id); s.ingredients = s.ingredients.filter(x => x !== sel.id); });
    case 'adding': return commit(() => { const nid = uniq('product', new Set(R.ingredients.map(i => i.id))); R.ingredients.push({ id: nid, name: 'Новый продукт', amount: null, unit: 'pcs', icon: '🥕' }); sel = { kind: 'ing', id: nid }; });
    case 'addeq': return commit(() => { const nid = uniq('tool', new Set(R.equipment.map(i => i.id))); R.equipment.push({ id: nid, name: 'Новый инвентарь', count: 1, icon: '🍴' }); sel = { kind: 'eq', id: nid }; });
    case 'deling': return deleteKeys(['prod:' + sel.id]);
    case 'deleq': return commit(() => { const x = sel.id; R.equipment = R.equipment.filter(i => i.id !== x); R.steps.forEach(s => (s.resources = s.resources.filter(i => i !== x))); sel = { kind: 'recipe' }; });
  }
});

// Typing in the panel changes the recipe at once; one history entry per field.
$('#insp').addEventListener('input', e => {
  const el = e.target.closest('[data-f]'); if (!el || el.dataset.t === 'id' || el.dataset.t === 'help' || el.type === 'checkbox' || el.tagName === 'SELECT') return;
  const key = sel.kind + (sel.id || '') + el.dataset.f;
  if (typing !== key) { hist.push(JSON.stringify(R)); fut = []; typing = key; }
  setField(el); saved();
  renderTop(); renderSide(); renderCanvas();
});
$('#insp').addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.act === 'adddep') { if (el.value) { const v = el.value; commit(() => S(sel.id).depends_on.push(v)); } return; }
  if (!el.dataset.f) return;
  if (el.dataset.t === 'id' || el.dataset.t === 'help' || el.type === 'checkbox' || el.tagName === 'SELECT') commit(() => setField(el));
  else typing = null;
});

document.addEventListener('keydown', e => {
  const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  const ctrl = e.ctrlKey || e.metaKey, key = k => e.code === 'Key' + k.toUpperCase() || e.key.toLowerCase() === k; // works on the Russian layout too
  if (ctrl && key('z') && !inField) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  if (ctrl && key('y') && !inField) { e.preventDefault(); redo(); }
  if ((e.key === 'Delete' || e.key === 'Backspace') && !inField && R && !drag) {
    e.preventDefault();
    if (selEdge) cutEdge(selEdge);
    else if (picked.size) deleteKeys([...picked]);
    else if (sel.kind === 'step') deleteKeys(['step:' + sel.id]);
  }
  if (e.key === 'Escape') { closePop(); if (selEdge || picked.size) { selEdge = null; picked = new Set(); pickedToSel(); render(); } }
  if (ctrl && key('a') && !inField && R) { e.preventDefault(); picked = new Set(L.nodes.map(n => n.key)); pickedToSel(); render(); }
  if (e.code === 'Space' && !inField && R) { e.preventDefault(); space = true; document.body.classList.add('panready'); }
});
document.addEventListener('keyup', e => { if (e.code === 'Space') { space = false; document.body.classList.remove('panready'); } });

/* ---------------- pointer: pan, move tiles, pick with a frame, link ---------------- */
// Like Miro: the middle button (or Space with the left button) pans, the wheel zooms to the pointer,
// a tile is dragged with the left button, and the left button on empty canvas draws a frame that picks tiles.
// Dragging from a tile's port to a step links them; a product from the list on the left can be dropped on a step.
let drag = null, dragged = false, space = false, raf = 0;
const canvasEl = $('#canvas');
const keyOf = el => el && el.closest('[data-key]') && el.closest('[data-key]').dataset.key;
const later = fn => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; fn(); }); };

document.addEventListener('pointerdown', e => {
  if (!R) return;
  const inCanvas = e.target.closest('#canvas'), port = e.target.closest('[data-port]'), side = e.target.closest('[data-drag]');
  dragged = false;
  if (inCanvas && (e.button === 1 || (e.button === 0 && space) || (e.pointerType === 'touch' && !e.target.closest('.node, button')))) {
    e.preventDefault();
    drag = { mode: 'pan', x0: e.clientX, y0: e.clientY, cx: cam.x, cy: cam.y, moved: false };
    document.body.classList.add('panning');
    return;
  }
  if (e.button !== 0) return;
  if (port || side) {
    drag = { mode: port ? 'port' : 'side', src: port ? port.dataset.port : side.dataset.drag, x0: e.clientX, y0: e.clientY, moved: false };
    if (port) { e.preventDefault(); drag.from = L.byKey[keyOf(port)]; }
    return;
  }
  if (!inCanvas || e.target.closest('button, .zoom, .guess, [data-edge]')) return;
  const key = keyOf(e.target);
  if (key) {
    e.preventDefault();
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) document.activeElement.blur(); // so Delete removes the tile, not a letter
    if (e.shiftKey) return; // Shift+click adds or removes the tile; that happens on click
    if (!picked.has(key)) picked = new Set([key]);
    drag = { mode: 'move', x0: e.clientX, y0: e.clientY, moved: false, snap: JSON.stringify(R),
      start: Object.fromEntries([...picked].filter(k => L.byKey[k]).map(k => [k, [L.byKey[k].x, L.byKey[k].y]])) };
    return;
  }
  drag = { mode: 'box', x0: e.clientX, y0: e.clientY, moved: false, add: e.shiftKey };
});

document.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
  if (!drag.moved && Math.hypot(dx, dy) < 5) return;
  if (!drag.moved && drag.mode === 'move') { pickedToSel(); renderInsp(); }
  drag.moved = true; dragged = true;
  if (drag.mode === 'pan') { cam.x = drag.cx + dx; cam.y = drag.cy + dy; applyCam(); return; }
  if (drag.mode === 'move') {
    document.body.classList.add('moving');
    const pos = positions();
    for (const [k, [x, y]] of Object.entries(drag.start)) pos[k] = [Math.round(x + dx / cam.k), Math.round(y + dy / cam.k)];
    later(renderCanvas);
    return;
  }
  if (drag.mode === 'box') {
    const r = canvasEl.getBoundingClientRect();
    let m = $('#marquee');
    if (!m) { m = document.createElement('div'); m.id = 'marquee'; m.className = 'marquee'; canvasEl.append(m); }
    Object.assign(m.style, { left: Math.min(e.clientX, drag.x0) - r.left + 'px', top: Math.min(e.clientY, drag.y0) - r.top + 'px', width: Math.abs(dx) + 'px', height: Math.abs(dy) + 'px' });
    return;
  }
  document.body.classList.add('dragging');
  const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-node^="step:"]');
  document.querySelectorAll('.node.drop').forEach(n => n !== over && n.classList.remove('drop'));
  if (over) over.classList.add('drop');
  const p = toWorld(e.clientX, e.clientY);
  if (drag.mode === 'port' && drag.from) $('#temp').setAttribute('d', `M${drag.from.x + drag.from.w} ${drag.from.cy}C${drag.from.x + drag.from.w + 60} ${drag.from.cy} ${p.x - 60} ${p.y} ${p.x} ${p.y}`);
  if (drag.mode === 'side') {
    let g = $('#ghost');
    if (!g) { g = document.createElement('div'); g.id = 'ghost'; g.className = 'ghost'; const i = I(drag.src.slice(4)); g.textContent = `${i.icon || '🥕'} ${i.name}`; document.body.append(g); }
    g.style.left = e.clientX + 12 + 'px'; g.style.top = e.clientY + 12 + 'px';
  }
});

function endDrag(e, cancelled) {
  if (!drag) return;
  const d = drag; drag = null;
  document.body.classList.remove('dragging', 'panning', 'moving');
  $('#ghost')?.remove(); $('#marquee')?.remove();
  document.querySelectorAll('.node.drop').forEach(n => n.classList.remove('drop'));
  const t = $('#temp'); if (t) t.setAttribute('d', '');
  if (!d.moved) return;
  setTimeout(() => (dragged = false), 0);
  if (d.mode === 'move') {
    hist.push(d.snap); if (hist.length > 200) hist.shift();
    fut = []; typing = null; saved(); renderTop(); renderCanvas(); renderInsp();
    return;
  }
  if (cancelled) return;
  if (d.mode === 'box') {
    const a = toWorld(d.x0, d.y0), b = toWorld(e.clientX, e.clientY);
    const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x), y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
    const hit = L.nodes.filter(n => n.x < x2 && n.x + n.w > x1 && n.y < y2 && n.y + n.h > y1).map(n => n.key);
    picked = new Set(d.add ? [...picked, ...hit] : hit);
    pickedToSel(); render();
    return;
  }
  if (d.mode === 'port' || d.mode === 'side') {
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-node]');
    connect(d.src, over ? over.dataset.node : null);
  }
}
document.addEventListener('pointerup', e => endDrag(e, false));
document.addEventListener('pointercancel', e => endDrag(e, true));
canvasEl.addEventListener('auxclick', e => e.preventDefault());

/* ---------------- camera ---------------- */

function applyCam() {
  $('#world').style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})`;
  // The dotted paper moves and scales with the tiles.
  const g = 22 * cam.k;
  canvasEl.style.backgroundSize = `${g}px ${g}px`;
  canvasEl.style.backgroundPosition = `${cam.x}px ${cam.y}px`;
  $('#zoomlabel').textContent = Math.round(cam.k * 100) + '%';
}
function toWorld(cx, cy) {
  const r = canvasEl.getBoundingClientRect();
  return { x: (cx - r.left - cam.x) / cam.k, y: (cy - r.top - cam.y) / cam.k };
}
/** Zoom keeping the point under (cx, cy) in place. */
function zoomAt(k, cx, cy) {
  const r = canvasEl.getBoundingClientRect(), px = cx - r.left, py = cy - r.top;
  k = Math.min(2, Math.max(0.2, k));
  cam.x = px - (px - cam.x) * k / cam.k; cam.y = py - (py - cam.y) * k / cam.k; cam.k = k;
  applyCam();
}
function zoomBy(f) { const r = canvasEl.getBoundingClientRect(); zoomAt(cam.k * f, r.left + r.width / 2, r.top + r.height / 2); }
/** Show the whole recipe. */
function fit() {
  if (!L) return;
  const c = canvasEl, b = L.box;
  cam.k = Math.min(1, Math.max(0.2, Math.min((c.clientWidth - 80) / b.w, (c.clientHeight - 80) / b.h)));
  cam.x = (c.clientWidth - b.w * cam.k) / 2 - b.x * cam.k;
  cam.y = (c.clientHeight - b.h * cam.k) / 2 - b.y * cam.k;
  applyCam();
}
/** On opening: the whole recipe if it stays readable, otherwise readable tiles with the dish in view. */
function firstView() {
  if (!L) return;
  const c = canvasEl, b = L.box;
  if (Math.min((c.clientWidth - 80) / b.w, (c.clientHeight - 80) / b.h) >= 0.7) return fit();
  const d = L.byKey.dish;
  cam.k = 0.7;
  cam.x = c.clientWidth - 48 - (d.x + d.w) * cam.k;
  cam.y = c.clientHeight / 2 - d.cy * cam.k;
  applyCam();
}
function centerOn(key) {
  const n = L.byKey[key]; if (!n) return;
  cam.x = canvasEl.clientWidth / 2 - (n.x + n.w / 2) * cam.k;
  cam.y = canvasEl.clientHeight / 2 - n.cy * cam.k;
  applyCam();
}
canvasEl.addEventListener('wheel', e => {
  if (!R) return;
  e.preventDefault();
  const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  zoomAt(cam.k * Math.exp(-d * 0.0015), e.clientX, e.clientY);
}, { passive: false });

/* ---------------- popups, files, messages ---------------- */

function openPop(btn) {
  const p = $('#pop');
  p.innerHTML = `<h3>Из книги рецептов</h3><div class="btiles">${book ? bookTiles() : '<span class="muted">Загружаем…</span>'}</div>
    <div class="row"><button class="tb" data-act="file">Файл с компьютера…</button><span class="muted small">или перетащите файл .json в окно</span></div>`;
  place(p, btn);
  if (!book) loadBook().then(() => { if (!p.hidden) openPop(btn); }).catch(() => { p.querySelector('.btiles').innerHTML = '<span class="muted">Книга не загрузилась. Откройте файл с компьютера.</span>'; });
}
function issuesPop(btn) {
  const is = issues(), p = $('#pop');
  p.innerHTML = is.length
    ? `<h3>Что поправить</h3><ul class="issues">${is.map((x, i) => `<li class="${x.err ? 'err' : ''}">${x.sel ? `<button data-act="gotoissue" data-i="${i}">${esc(x.text)}</button>` : esc(x.text)}</li>`).join('')}</ul>`
    : '<h3>Рецепт в порядке</h3><p class="muted">Телефоны его откроют: все шаги связаны, кругов нет, все продукты в деле.</p>';
  place(p, btn);
}
function place(p, btn) {
  const r = btn.getBoundingClientRect();
  p.hidden = false;
  p.style.top = r.bottom + 8 + 'px';
  p.style.left = Math.max(8, Math.min(window.innerWidth - p.offsetWidth - 8, r.left)) + 'px';
}
function closePop() { $('#pop').hidden = true; }

let toastTimer = null;
function toast(t, long = false) {
  const el = $('#toast'); el.textContent = t; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), long ? 9000 : 3500);
}

function download() {
  if (!R) return;
  const name = (R.id || 'recipe') + '.json';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([fileText()], { type: 'application/json' }));
  a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Файл ${name} скачан. Чтобы рецепт появился в книге, положите его в папку recipes и допишите имя в recipes/index.json.`, true);
}

function readFile(f) {
  const rd = new FileReader();
  rd.onload = () => {
    try { load(JSON.parse(rd.result)); toast(`Открыт ${f.name}.`); }
    catch (err) { toast('Не получилось открыть: ' + (typeof err === 'string' ? err : 'файл не читается как JSON.'), true); }
  };
  rd.readAsText(f);
}
$('#file').onchange = e => { const f = e.target.files[0]; if (f) readFile(f); };
window.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); document.body.classList.add('filedrop'); } });
window.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('filedrop'); });
window.addEventListener('drop', e => {
  document.body.classList.remove('filedrop');
  const f = e.dataTransfer.files[0]; if (!f) return;
  e.preventDefault(); readFile(f);
});

/* ---------------- start ---------------- */

const draft = store.get('receptor:draft');
if (draft && draft.R) {
  try { R = normalize(draft.R); guessed = !!draft.guessed; } catch (e) { R = null; }
}
render();
if (R) requestAnimationFrame(firstView);
loadBook().catch(() => {});

// For tests and the console: the exact file "Скачать файл" would save.
window.receptor = { fileText: () => (R ? fileText() : null), load: o => load(o), center: centerOn, get recipe() { return R; }, get cam() { return { ...cam }; }, nodes: () => (L ? L.nodes.map(n => ({ key: n.key, x: n.x, y: n.y })) : []) };
