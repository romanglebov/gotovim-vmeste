// Phone app for «Готовим вместе».
// One phone creates a game (the host) and runs the engine; others join by QR code or game code.
// Every screen is rendered from the shared game state; actions go to the host and come back as new state.

import { validate, prepare, createState, apply, options, cookIndex, maxCooks, statsJSON, title as stepTitle, STATIONS } from './engine.js';
import { Net, findGame } from './net.js';

const UNITS = { g: 'г', ml: 'мл', pcs: 'шт.', tsp: 'ч. л.', tbsp: 'ст. л.', pinch: 'щеп.', handful: 'горсть', bunch: 'пучка', to_taste: 'по вкусу' };
const $ = s => document.querySelector(s);
const app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ccol = i => `var(--c${(i % 4) + 1})`;
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
function fmt(ms) { ms = Math.max(0, Math.round(ms / 1000)); const m = Math.floor(ms / 60), s = ms % 60; return m + ':' + String(s).padStart(2, '0'); }
function plural(n, one, few, many) { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; }

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } },
};

const PID = store.get('gv-pid') || (() => { const p = rid() + rid(); store.set('gv-pid', p); return p; })();
let myName = store.get('gv-name', '');

/* ---------------- recipe book ---------------- */

let book = [], bookErr = '', fileErr = '';
function resolveImages(r, base) {
  const fix = o => { if (!o.image || /^data:/.test(o.image)) return; if (base) o.image = base + o.image; else delete o.image; };
  fix(r); r.equipment.forEach(fix); r.ingredients.forEach(fix); return r;
}
async function loadBook() {
  try {
    const idx = await (await fetch('recipes/index.json', { cache: 'no-cache' })).json();
    for (const f of idx.recipes || []) {
      try { book.push({ r: resolveImages(validate(await (await fetch('recipes/' + f, { cache: 'no-cache' })).json()), 'recipes/'), src: 'library' }); }
      catch (e) { bookErr += `Не загрузился рецепт ${f}: ${typeof e === 'string' ? e : 'файл недоступен.'} `; }
    }
  } catch (e) { bookErr = 'Не удалось открыть книгу рецептов. Проверьте интернет.'; }
  for (const r of store.get('gv-local-recipes', [])) {
    try { const v = resolveImages(validate(r), null); if (!book.some(c => c.r.id === v.id)) book.push({ r: v, src: 'local' }); } catch (e) { /* skip broken */ }
  }
}
const saveLocalRecipes = () => store.set('gv-local-recipes', book.filter(c => c.src === 'local').map(c => c.r));
const plateCount = r => `${r.steps.length} ${plural(r.steps.length, 'шаг', 'шага', 'шагов')} · ${r.players.min || 1}–${maxCooks(r)} ${plural(maxCooks(r), 'повар', 'повара', 'поваров')}`;
const dishPic = r => `<span class="pic">${r.image ? `<img src="${esc(r.image)}" alt="">` : `<span class="emo" aria-hidden="true">${esc(r.icon || '🍽️')}</span>`}</span>`;

/* ---------------- session ---------------- */

let role = null;          // 'host' | 'guest' | null
let st = null, R = null, ctx = null;
let code = null, brokerIdx = 0;
let view = 'home';        // screens outside a game: home | book | code
let pick = store.get('gv-pick', null);
let net = null, netStatus = 'idle';
let pending = new Map();  // guest actions waiting for the host
let toast = '';
let toastTimer = null;
let offset = 0;           // host clock minus this phone's clock
let lookup = null;        // guest: 'connecting' | 'searching' | 'missing'
let lookupTimer = null;
const seenNotes = new Set();
let deck = null;          // index of the recipe card being viewed; null = follow my own work
let deckKey = '';         // what my own work was when the deck was last reset
let showOther = false;    // the 'Другое дело' list is open

const me = () => (st ? cookIndex(st, PID) : -1);

function showToast(t) { toast = t; render(); clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast = ''; render(); }, 4500); }

function saveSession() {
  if (role === 'host') store.set('gv-session', { role, code, broker: brokerIdx, recipe: R, st });
  else if (role === 'guest') store.set('gv-session', { role, code, broker: brokerIdx });
}

function endSession({ clearBroker = false } = {}) {
  if (clearBroker && net && code) net.clear(code);
  store.del('gv-session');
  role = null; st = null; R = null; ctx = null; code = null; lookup = null;
  pending.clear(); clearTimeout(lookupTimer);
  view = 'home';
  if (net) net.join('__none__', {});
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  render();
}

function newCode() { const A = 'ABCDEFGHJKLMNPRSTUVWXYZ'; let s = ''; for (let i = 0; i < 5; i++) s += A[Math.floor(Math.random() * A.length)]; return s; }

async function ensureNet(index, tryOthers = true) {
  if (!net) net = new Net(PID, s => { netStatus = s; if (s === 'online') onOnline(); render(); });
  netStatus = 'connecting'; render();
  try {
    brokerIdx = await net.connect(index, { tryOthers });
  } catch (e) {
    netStatus = 'offline'; render();
    setTimeout(() => { if (role && !(net && net.online)) ensureNet(index, tryOthers); }, 5000);
    return false;
  }
  net.join(code, role === 'host' ? { act: onAct } : { state: onState, recipe: onRecipe });
  onOnline(); saveSession(); render();
  return true;
}

function onOnline() {
  if (!role || !net || !net.online) return;
  if (role === 'host' && st) { net.publish('recipe', R, { retain: true }); publishState(); }
  if (role === 'guest') resend(true);
}

/* ---------------- host ---------------- */

function createGame() {
  const c = book[pick]; if (!c) return;
  role = 'host'; code = newCode(); R = c.r; ctx = prepare(R);
  st = createState({ code, recipe: R, hostPid: PID, hostName: myName, now: Date.now() });
  saveSession(); render(); keepAwake();
  ensureNet(0);
}
function publishState() {
  st.now = Date.now();
  if (net && net.online) net.publish('state', st, { retain: true });
  saveSession();
}
function onAct(a) { if (a && a.pid && a.type) hostApply(a); }
function hostApply(a) {
  const res = apply(st, ctx, a, Date.now());
  if (!res.ok && res.err && a.pid !== PID) { st.notes = st.notes || {}; st.notes[a.pid] = { aid: a.aid, err: res.err }; st.rev++; }
  publishState(); render();
  return res;
}

/* ---------------- guest ---------------- */

function joinByCode(c, b) {
  role = 'guest'; code = c; brokerIdx = b ?? 0; st = null; R = null; ctx = null; lookup = 'connecting';
  saveSession(); render();
  const known = b != null;
  ensureNet(brokerIdx, !known).then(ok => {
    if (!ok) return;
    clearTimeout(lookupTimer);
    lookupTimer = setTimeout(async () => {
      if (st || role !== 'guest' || code !== c) return;
      lookup = 'searching'; render();
      const found = await findGame(c, PID);
      if (role !== 'guest' || code !== c || st) return;
      if (found < 0) { lookup = 'missing'; render(); return; }
      if (found !== brokerIdx) { brokerIdx = found; saveSession(); ensureNet(found, false); }
    }, 7000);
  });
}
function onState(s) {
  if (!s) { if (st && st.phase !== 'done') { st = { ...st, phase: 'closed' }; render(); } return; }
  if (st && s.code === st.code && s.rev < st.rev) return;
  st = s; lookup = null; clearTimeout(lookupTimer);
  offset = s.now - Date.now();
  for (const aid of [...pending.keys()]) if (s.applied.includes(aid)) pending.delete(aid);
  const note = s.notes && s.notes[PID];
  if (note && !seenNotes.has(note.aid)) { seenNotes.add(note.aid); showToast(note.err); }
  if (me() >= 0) keepAwake();
  render();
}
function onRecipe(r) {
  if (!r) return;
  try { R = validate(r); ctx = prepare(R); } catch (e) { R = null; ctx = null; }
  render();
}
function resend(force) {
  if (role !== 'guest' || !net || !net.online) return;
  const t = Date.now();
  for (const p of pending.values()) {
    if (force || t - p.sent > 2000) { net.publish('act', p.a); p.sent = t; }
  }
}
setInterval(() => resend(false), 1500);

/* ---------------- actions from this phone ---------------- */

function send(type, extra = {}) {
  const a = { aid: rid(), pid: PID, type, ...extra };
  if (role === 'host') { const r = hostApply(a); if (!r.ok && r.err) showToast(r.err); return; }
  pending.set(a.aid, { a, sent: Date.now(), first: Date.now() });
  if (net) net.publish('act', a);
  render();
}
const isPending = () => role === 'guest' && pending.size > 0;

/* ---------------- sound and screen ---------------- */

let wake = null;
async function keepAwake() {
  if (wake && !wake.released) return;
  try { wake = await navigator.wakeLock.request('screen'); } catch (e) { /* not supported */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !role) return;
  keepAwake();
  if (net && !net.online) ensureNet(brokerIdx, false);
});

/* ---------------- screens ---------------- */

function statusBar() {
  if (!role) return '';
  const ci = me();
  const label = { online: 'На связи', connecting: 'Подключаемся…', offline: 'Нет связи', idle: '' }[netStatus] || '';
  const cls = netStatus === 'online' ? 'online' : netStatus === 'offline' ? 'offline' : '';
  return `<div class="status"><span>${ci >= 0 ? `<span class="who" style="--cc:${ccol(ci)}">${esc(st.cooks[ci].name)}</span>` : (role === 'host' ? 'Ведущий' : 'Гость')} · игра ${esc(code)}</span>
    <span class="dot ${cls}">${label}${isPending() ? ' · отправляем…' : ''}</span></div>`;
}

function scrHome() {
  const cur = book[pick];
  return `<div><div class="eyebrow">Совместная готовка</div><h1>Готовим вместе</h1></div>
    ${cur ? `<button class="chosen" data-act="book">${dishPic(cur.r)}<span class="ct"><span class="eyebrow">Готовим</span><b>${esc(cur.r.title)}</b><small>${plateCount(cur.r)}</small><span class="link">Сменить рецепт</span></span></button>`
          : `<button class="chosen" data-act="book"><span class="pic"><span class="emo" aria-hidden="true">📖</span></span><span class="ct"><b>Книга рецептов</b><small>Выберите, что будем готовить</small></span></button>`}
    ${bookErr && !book.length ? `<p class="err">${esc(bookErr)}</p>` : ''}
    <label class="eyebrow" for="name">Ваше имя</label>
    <input type="text" id="name" data-bind="name" value="${esc(myName)}" placeholder="Как вас зовут" autocomplete="given-name" maxlength="24">
    <div class="stack">
      <button class="big" data-act="create" ${cur ? '' : 'disabled'}>${cur ? 'Создать игру' : 'Сначала выберите рецепт'}</button>
      <button class="big secondary" data-act="tocode">Присоединиться по коду</button>
    </div>`;
}

function scrBook() {
  return `<button class="ghost back" data-act="home">← Назад</button>
    <div><div class="eyebrow">Что готовим?</div><h1>Книга рецептов</h1></div>
    <div class="book">${book.map((c, i) => `<button class="dish" data-act="pick" data-i="${i}" aria-pressed="${i === pick}">${dishPic(c.r)}
        <span class="dt"><b>${esc(c.r.title)}</b><small>${plateCount(c.r)}</small>${c.src === 'local' ? '<small>Добавлен из файла</small>' : ''}</span></button>`).join('')}
      <button class="dish add" data-act="addfile"><span class="pic" aria-hidden="true">+</span><span class="dt"><b>Добавить рецепт</b><small>из файла .json</small></span></button></div>
    ${bookErr ? `<p class="err">${esc(bookErr)}</p>` : ''}${fileErr ? `<p class="err">${esc(fileErr)}</p>` : ''}`;
}

function scrCode() {
  return `<button class="ghost back" data-act="home">← Назад</button>
    <div><div class="eyebrow">Присоединиться</div><h1>Код игры</h1></div>
    <p class="muted">Код написан на телефоне ведущего под QR-кодом. Проще всего отсканировать QR-код обычной камерой телефона.</p>
    <input type="text" id="code" class="code" data-bind="code" maxlength="5" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCDE">
    <button class="big" data-act="findcode">Найти игру</button>`;
}

function scrLookup() {
  if (lookup === 'missing') {
    return `<div class="card grow"><h2>Игра ${esc(code)} не найдена</h2><p class="muted">Проверьте код или попросите ведущего показать QR-код ещё раз.</p></div>
      <button class="big" data-act="leavegame">На главную</button>`;
  }
  return `<div class="card grow"><h2>Подключаемся к игре ${esc(code)}…</h2>
      <p class="muted">${lookup === 'searching' ? 'Ищем игру на других серверах.' : netStatus === 'offline' ? 'Нет связи. Проверьте интернет, пробуем снова.' : 'Это займёт пару секунд.'}</p></div>
    <button class="big secondary" data-act="leavegame">Отмена</button>`;
}

function players() {
  return `<ul class="people">${st.cooks.map((c, i) => `<li><span class="who" style="--cc:${ccol(i)}">${esc(c.name)}${c.pid === PID ? ' (вы)' : ''}</span><span class="muted">${c.pid === st.host ? 'ведущий' : ''}</span></li>`).join('')}</ul>`;
}

function joinUrl() { return `${location.origin}${location.pathname}${location.search}#join-${code}-${brokerIdx}`; }

function scrLobby() {
  const max = maxCooks(R), min = R.players.min || 1;
  if (role === 'host') {
    let qr = '';
    if (net && net.online) {
      try { const q = window.qrcode(0, 'M'); q.addData(joinUrl()); q.make(); qr = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); } catch (e) { qr = ''; }
    }
    return `<div><div class="eyebrow">${esc(R.title)}</div><h1>Зовите поваров</h1></div>
      <div class="card">
        ${qr ? `<div class="qr" aria-label="QR-код для входа в игру">${qr}</div><div class="code">${esc(code)}</div>
          <p class="muted" style="text-align:center;font-size:.9rem">Отсканируйте камерой телефона или введите код на главном экране</p>
          <button class="ghost" data-act="share">Отправить ссылку</button>`
        : `<p class="muted">${netStatus === 'offline' ? 'Нет связи с сервером игры. Пробуем снова. Готовить одному можно и без связи.' : 'Подключаемся к серверу игры…'}</p>`}
      </div>
      <div class="card"><div class="eyebrow">В игре ${st.cooks.length} из ${max}</div>${players()}</div>
      <div class="stack">
        <button class="big" data-act="toEquip" ${st.cooks.length >= min ? '' : 'disabled'}>Начать готовку</button>
        <button class="big secondary" data-act="cancelgame">Отменить игру</button>
      </div>`;
  }
  if (me() < 0) {
    return `<div><div class="eyebrow">Игра ${esc(code)}</div><h1>${esc(R.title)}</h1></div>
      ${dishCard()}
      <div class="card"><div class="eyebrow">Уже в игре</div>${players()}</div>
      <label class="eyebrow" for="name">Ваше имя</label>
      <input type="text" id="name" data-bind="name" value="${esc(myName)}" placeholder="Как вас зовут" autocomplete="given-name" maxlength="24">
      <div class="stack">
        <button class="big" data-act="join" ${isPending() ? 'disabled' : ''}>Присоединиться</button>
        <button class="big secondary" data-act="leavegame">Отмена</button>
      </div>`;
  }
  return `<div><div class="eyebrow">Игра ${esc(code)}</div><h1>${esc(R.title)}</h1></div>
    ${dishCard()}
    <div class="card grow"><div class="eyebrow">Повара</div>${players()}<p class="muted">Ждём, пока ведущий начнёт.</p></div>
    <button class="big secondary" data-act="leave">Выйти из игры</button>`;
}
function dishCard() { return R.image ? `<div class="chosen" style="cursor:default">${dishPic(R)}</div>` : ''; }

function tile(k, item, qty) {
  const by = st.checked[k];
  const pic = item.image ? `<img src="${esc(item.image)}" alt="">` : esc(item.icon || '🍽️');
  return `<button class="tile ${by != null ? 'ok' : ''}" data-act="tick" data-k="${esc(k)}" aria-pressed="${by != null}">
    ${by != null ? `<span class="by" style="--cc:${ccol(by)}"></span><span class="tick">✓</span>` : ''}
    <span class="tp" aria-hidden="true">${pic}</span><span class="nm">${esc(item.name)}${item.optional ? ' *' : ''}</span>${qty ? `<span class="q">${esc(qty)}</span>` : ''}</button>`;
}
function scrEquip() {
  const amt = i => i.amount == null ? (UNITS[i.unit] || '') : (String(i.amount).replace('.', ',') + ' ' + (UNITS[i.unit] || i.unit || ''));
  const total = R.equipment.length + R.ingredients.length, got = Object.keys(st.checked).length;
  return `<div><div class="eyebrow">${esc(R.title)}</div><h1>Вам понадобятся</h1></div>
    <p class="muted" style="font-size:.92rem">Достаньте всё и отметьте. Отметки видят все повара.</p>
    <div class="eyebrow">Инвентарь</div>
    <div class="tiles">${R.equipment.map(e => tile('e:' + e.id, e, (e.count || 1) > 1 ? e.count + ' шт.' : '')).join('')}</div>
    <div class="eyebrow">Продукты</div>
    <div class="tiles">${R.ingredients.map(i => tile('i:' + i.id, i, amt(i))).join('')}</div>
    ${R.ingredients.some(i => i.optional) ? `<p class="muted" style="font-size:.8rem">* по желанию</p>` : ''}
    <button class="big" data-act="go">${got === total ? 'Всё на месте, начинаем' : `Начинаем (${got} из ${total})`}</button>`;
}

function stoveHTML() {
  return Object.keys(st.bg).map(id => {
    const s = ctx.S[id];
    return `<div class="clock"><span><b>${esc(s.title)}</b><small>Готово, когда: ${esc(lowerFirst(s.done_when))}</small></span><button data-act="bgdone" data-id="${esc(id)}">Готово</button></div>`;
  }).join('');
}
const lowerFirst = t => (t ? t[0].toLowerCase() + t.slice(1) : '');

/** Who did or does a step, and whether it can be taken. */
function stepStatus(s) {
  const by = ci => `<span class="who" style="--cc:${ccol(ci)}">${esc(st.cooks[ci].name)}</span>`;
  if (st.done[s.id]) {
    const e = st.log.find(x => x.id === s.id && x.type === 'step');
    return { kind: 'done', html: e && e.cook != null ? `✓ Сделано · ${by(e.cook)}` : '✓ Сделано' };
  }
  if (st.bg[s.id]) return { kind: 'stove', html: 'Идёт на плите' };
  const ci = st.cooks.findIndex(c => c.task && c.task.type === 'step' && c.task.id === s.id);
  if (ci >= 0) return { kind: 'busy', ci, html: ci === me() ? 'Это ваш шаг' : `Сейчас делает ${by(ci)}` };
  const missing = s.depends_on.filter(d => !st.done[d]);
  if (missing.length) return { kind: 'locked', html: `Откроется после «${esc(missing.map(d => lowerFirst(ctx.S[d].title)).join('», «'))}»` };
  return { kind: 'free', html: 'Можно брать' };
}

function stepCard(s, label) {
  const n = ctx.R.steps.indexOf(s) + 1, total = ctx.R.steps.length;
  const status = stepStatus(s);
  return `<div class="card grow step s-${status.kind}" id="deck">
    <div class="steptop"><span class="post">${esc(STATIONS[s.station] || '')}${s.item ? ' · ' + esc(s.item) : ''}</span><span class="prog">${n} из ${total}</span></div>
    ${label ? `<div class="eyebrow next">${label}</div>` : ''}
    <h2>${esc(s.title)}</h2>
    <p class="desc">${esc(s.description)}</p>
    ${s.done_when ? `<div class="when"><b>Готово, когда</b>${esc(lowerFirst(s.done_when))}${s.typical ? `<small>Обычно ${esc(s.typical)}</small>` : ''}</div>` : ''}
    <p class="stat-line muted">${status.html}</p>
  </div>`;
}

/** The step this phone shows when the cook is not browsing: their own step, or the one suggested next. */
function myCard(ci) {
  const t = st.cooks[ci].task;
  if (t && (t.type === 'step' || t.type === 'help')) return ctx.R.steps.indexOf(ctx.S[t.id]);
  if (t && t.type === 'choose') { const o = options(st, ctx, ci); if (o.steps.length) return ctx.R.steps.indexOf(o.steps[0]); }
  return null;
}

function otherList(ci) {
  const o = options(st, ctx, ci);
  let html = '';
  const rest = o.steps.slice(1);
  if (rest.length) html += `<div class="grp">Другие шаги</div>` + rest.map(s =>
    `<button class="opt" data-act="take" data-kind="step" data-id="${esc(s.id)}"><b>${esc(s.title)}</b><span>${esc(STATIONS[s.station])} · ${esc(s.item || '')}</span></button>`).join('');
  if (o.helps.length) html += `<div class="grp">Помочь</div>` + o.helps.map(h =>
    `<button class="opt" data-act="take" data-kind="help" data-id="${esc(h.id)}"><b>${esc(ctx.S[h.id].help.text)}</b><span>${esc(h.name)} · ${esc(lowerFirst(ctx.S[h.id].title))}</span></button>`).join('');
  if (o.fbs.length) html += `<div class="grp">Пока ждём</div>` + o.fbs.map(f =>
    `<button class="opt" data-act="take" data-kind="fallback" data-id="${esc(f.id)}"><b>${esc(f.title)}</b></button>`).join('');
  return html;
}

function scrCook() {
  const ci = me();
  const doneN = Object.keys(st.done).length, total = R.steps.length;
  const head = `<div class="bar"><i style="width:${(doneN / total) * 100}%"></i></div>
    <div class="status"><span>${esc(R.title)}</span><span class="prog">сделано ${doneN} из ${total}</span></div>
    ${Object.keys(st.bg).length ? `<div class="stove"><div class="eyebrow">На плите</div>${stoveHTML()}</div>` : ''}`;
  if (ci < 0) return head + `<div class="card grow"><h2>Игра идёт без этого телефона</h2><p class="muted">Присоединиться можно только до начала готовки.</p></div><button class="big secondary" data-act="leavegame">На главную</button>`;

  const t = st.cooks[ci].task;
  const key = t ? t.type + ':' + (t.id || '') : '';
  if (key !== deckKey) { deckKey = key; deck = null; showOther = false; }
  const mine = myCard(ci);
  const idx = deck ?? mine;
  const browsing = deck != null && deck !== mine;

  let body, action = '';
  if (t && t.type === 'fallback' && deck == null) {
    body = `<div class="card grow step"><div class="eyebrow">Пока остальное готовится</div><h2>${esc(ctx.F[t.id].title)}</h2></div>`;
    action = `<button class="big" data-act="done" data-id="${esc(t.id)}" ${isPending() ? 'disabled' : ''}>Готово</button>`;
  } else if (idx == null) {
    const busy = st.cooks.map((x, i) => ({ x, i })).filter(({ x, i }) => i !== ci && x.task && x.task.type === 'step');
    body = `<div class="card grow step"><div class="eyebrow">Свободная минута</div><h2>Ждём</h2><p class="desc muted">${Object.keys(st.bg).length ? 'На плите идёт процесс. Когда будет готово, нажмите «Готово» наверху.'
      : busy.length ? 'Следующий шаг откроется, когда закончат: ' + busy.map(({ x, i }) => `<span class="who" style="--cc:${ccol(i)}">${esc(x.name)}</span>`).join(', ') + '.' : 'Следующий шаг скоро откроется.'}</p>
      ${otherList(ci) ? `<div class="opts">${otherList(ci)}</div>` : ''}</div>`;
  } else {
    const s = R.steps[idx];
    let label = '';
    if (!browsing && t && t.type === 'choose') label = 'Дальше для вас';
    if (!browsing && t && t.type === 'help') label = `Вы помогаете: ${esc(ctx.S[t.id].help.text)}`;
    body = stepCard(s, label);
    const status = stepStatus(s);
    if (t && t.type === 'step' && t.id === s.id) action = `<button class="big" data-act="done" data-id="${esc(t.id)}" ${isPending() ? 'disabled' : ''}>Готово</button>`;
    else if (t && t.type === 'help' && t.id === s.id) action = `<button class="big" data-act="done" data-id="${esc(t.id)}" ${isPending() ? 'disabled' : ''}>Готово, помог(ла)</button>`;
    else if (t && t.type === 'choose' && status.kind === 'free' && options(st, ctx, ci).steps.some(x => x.id === s.id))
      action = `<button class="big" data-act="take" data-kind="step" data-id="${esc(s.id)}" ${isPending() ? 'disabled' : ''}>Беру этот шаг</button>`;
    else if (t && t.type === 'choose' && status.kind === 'free') action = `<p class="muted center">Сейчас занят нужный инвентарь</p>`;
    else if (status.kind === 'free') action = `<p class="muted center">Сначала закончите свой шаг</p>`;
  }

  const nav = idx == null ? '' : `<div class="deck-nav">
      <button class="ghost" data-act="prev" ${idx <= 0 ? 'disabled' : ''} aria-label="Предыдущий шаг">‹</button>
      ${browsing || (deck != null && mine == null) ? `<button class="ghost" data-act="mine">К моему шагу</button>` : `<span class="muted">листайте рецепт</span>`}
      <button class="ghost" data-act="next" ${idx >= total - 1 ? 'disabled' : ''} aria-label="Следующий шаг">›</button>
    </div>`;
  const other = t && t.type === 'choose' && idx != null && !browsing
    ? (showOther ? `<div class="opts">${otherList(ci) || '<p class="muted">Других дел пока нет.</p>'}</div>` : `<button class="ghost linkish" data-act="other">Другое дело</button>`)
    : '';
  return head + body + nav + action + other
    + (role === 'host' ? `<div id="stopbox"><button class="ghost" data-act="askstop" style="width:100%;font-size:.85rem">Закончить досрочно</button></div>` : '');
}

function scrDone() {
  const total = st.end - st.start, ci = me();
  const TYPES = { step: 'шаг', help: 'помощь', fallback: 'пока ждём', stove: 'плита' };
  const rows = st.log.filter(e => e.type !== 'wait').sort((a, b) => a.start - b.start);
  const mine = ci >= 0 ? st.log.filter(e => e.cook === ci && e.type === 'step').length : 0;
  const complete = R.steps.every(s => st.done[s.id]);
  return `<div><div class="eyebrow">${esc(R.title)}</div><h1>${complete ? 'Готово! Приятного аппетита' : 'Готовка остановлена'}</h1></div>
    <div class="stats"><div class="stat"><span class="muted">Всего</span><b>${fmt(total)}</b></div>
      <div class="stat"><span class="muted">${ci >= 0 ? 'Ваших шагов' : 'Шагов'}</span><b>${ci >= 0 ? mine : Object.keys(st.done).length}</b></div></div>
    <div class="card"><div class="eyebrow">Сколько занял каждый шаг</div><table>
      ${rows.map(e => `<tr><td>${esc(stepTitle(ctx, e.id))} ${e.type !== 'step' ? `<span class="tag">${TYPES[e.type]}</span>` : ''}</td><td>${e.cook == null ? '' : `<span class="who" style="--cc:${ccol(e.cook)}" title="${esc(st.cooks[e.cook].name)}"></span>`}</td><td class="n">${fmt(e.ms)}</td></tr>`).join('')}
    </table></div>
    <div class="row"><button class="ghost" data-act="copy">Скопировать статистику</button><span class="muted" id="copied" aria-live="polite" style="font-size:.85rem"></span></div>
    <textarea class="raw" id="raw" hidden readonly></textarea>
    <button class="big" data-act="${role === 'host' ? 'newgame' : 'leavegame'}">${role === 'host' ? 'Новая игра' : 'На главную'}</button>`;
}

function scrClosed() {
  return `<div class="card grow"><h2>Ведущий закрыл игру</h2><p class="muted">Можно начать новую или присоединиться к другой.</p></div>
    <button class="big" data-act="leavegame">На главную</button>`;
}

function screen() {
  if (!role) return view === 'book' ? scrBook() : view === 'code' ? scrCode() : scrHome();
  if (!st || (role === 'guest' && !R)) return scrLookup();
  if (st.phase === 'closed') return scrClosed();
  if (st.phase === 'lobby') return scrLobby();
  if (me() < 0 && st.phase !== 'done') return `<div class="card grow"><h2>Игра уже идёт без вас</h2><p class="muted">Присоединиться можно только в лобби, до начала готовки.</p></div><button class="big" data-act="leavegame">На главную</button>`;
  if (st.phase === 'equip') return scrEquip();
  if (st.phase === 'cook') return scrCook();
  return scrDone();
}

function render() {
  const f = document.activeElement, fid = f && f.id && f.tagName === 'INPUT' ? f.id : null;
  const sel = fid ? f.selectionStart : null;
  app.innerHTML = statusBar() + (toast ? `<div class="toast" role="status">${esc(toast)}</div>` : '') + screen();
  if (fid) { const el = document.getElementById(fid); if (el) { el.focus(); try { el.setSelectionRange(sel, sel); } catch (e) { /* not a text input */ } } }
}

/* ---------------- input ---------------- */

app.addEventListener('input', e => {
  const b = e.target.dataset.bind;
  if (b === 'name') { myName = e.target.value; store.set('gv-name', myName); }
  if (b === 'code') e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
});
app.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'code') $('[data-act="findcode"]').click();
});
app.addEventListener('click', e => {
  const b = e.target.closest('button[data-act]'); if (!b || b.disabled) return;
  const a = b.dataset.act;
  switch (a) {
    case 'book': view = 'book'; return render();
    case 'home': view = 'home'; fileErr = ''; return render();
    case 'tocode': view = 'code'; render(); setTimeout(() => { const el = $('#code'); if (el) el.focus(); }, 50); return;
    case 'pick': pick = +b.dataset.i; store.set('gv-pick', pick); view = 'home'; fileErr = ''; return render();
    case 'addfile': $('#file').value = ''; return $('#file').click();
    case 'create': return createGame();
    case 'findcode': {
      const c = ($('#code').value || '').trim().toUpperCase();
      if (!/^[A-Z]{5}$/.test(c)) return showToast('Код игры — пять латинских букв.');
      return joinByCode(c, null);
    }
    case 'join': send('join', { name: myName }); return;
    case 'leave': send('leave'); setTimeout(() => endSession(), 600); return;
    case 'leavegame': return endSession();
    case 'cancelgame': st.phase = 'closed'; st.rev++; publishState(); return endSession();
    case 'newgame': return endSession({ clearBroker: true });
    case 'share': return shareLink();
    case 'toEquip': return send('toEquip');
    case 'tick': return send('tick', { key: b.dataset.k });
    case 'go': return send('go');
    case 'take': return send('take', { kind: b.dataset.kind, id: b.dataset.id });
    case 'done': return send('done', { id: b.dataset.id });
    case 'bgdone': return send('bgdone', { id: b.dataset.id });
    case 'prev': case 'next': {
      const cur = deck ?? myCard(me()) ?? 0;
      deck = Math.max(0, Math.min(R.steps.length - 1, cur + (a === 'next' ? 1 : -1)));
      return render();
    }
    case 'mine': deck = null; return render();
    case 'other': showOther = true; return render();
    case 'askstop':
      $('#stopbox').innerHTML = `<div class="card"><b>Закончить готовку сейчас?</b><div class="row"><button class="ghost" data-act="stop">Да, закончить</button><button class="ghost" data-act="nostop">Нет</button></div></div>`;
      return;
    case 'nostop': return render();
    case 'stop': return send('stop');
    case 'copy': return copyStats();
  }
});

let touchX = null, touchY = null;
app.addEventListener('touchstart', e => { if (e.target.closest('#deck')) { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; } }, { passive: true });
app.addEventListener('touchend', e => {
  if (touchX == null) return;
  const dx = e.changedTouches[0].clientX - touchX, dy = e.changedTouches[0].clientY - touchY;
  touchX = null;
  if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
  const btn = $(`[data-act="${dx < 0 ? 'next' : 'prev'}"]`);
  if (btn && !btn.disabled) btn.click();
}, { passive: true });

$('#file').onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      let raw; try { raw = JSON.parse(rd.result); } catch (_) { throw 'файл не читается как JSON.'; }
      const r = resolveImages(validate(raw), null), i = book.findIndex(c => c.r.id === r.id);
      if (i >= 0 && book[i].src === 'library') throw `рецепт с id «${r.id}» уже есть в книге.`;
      if (i >= 0) book[i] = { r, src: 'local' }; else book.push({ r, src: 'local' });
      saveLocalRecipes(); pick = book.findIndex(c => c.r.id === r.id); store.set('gv-pick', pick); fileErr = ''; view = 'home';
    } catch (err) { fileErr = 'Рецепт не подошёл: ' + err; }
    render();
  };
  rd.readAsText(f);
};

async function shareLink() {
  const url = joinUrl();
  try {
    if (navigator.share) { await navigator.share({ title: 'Готовим вместе', text: `Присоединяйся: ${R.title}, игра ${code}`, url }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); showToast('Ссылка скопирована'); } catch (e) { showToast(url); }
}

function copyStats() {
  const data = JSON.stringify(statsJSON(st, ctx), null, 2);
  const done = () => { const c = $('#copied'); if (c) c.textContent = 'Скопировано'; };
  navigator.clipboard.writeText(data).then(done).catch(() => {
    const r = $('#raw'); r.hidden = false; r.value = data; r.select();
    const c = $('#copied'); if (c) c.textContent = 'Выделено, скопируйте вручную';
  });
  const hist = store.get('gv-history', []); hist.push(statsJSON(st, ctx)); store.set('gv-history', hist.slice(-50));
}

/* ---------------- start ---------------- */

async function boot() {
  await loadBook();
  if (pick != null && !book[pick]) pick = null;
  const m = location.hash.match(/^#join-([A-Z]{5})-(\d)$/);
  const saved = store.get('gv-session', null);
  if (m) {
    history.replaceState(null, '', location.pathname + location.search);
    if (saved && saved.role === 'host' && saved.code === m[1]) resumeHost(saved);
    else joinByCode(m[1], +m[2]);
  } else if (saved && saved.role === 'host' && saved.st && saved.recipe) {
    resumeHost(saved);
  } else if (saved && saved.role === 'guest' && saved.code) {
    joinByCode(saved.code, saved.broker);
  }
  render();
}
function resumeHost(saved) {
  role = 'host'; code = saved.code; brokerIdx = saved.broker || 0;
  try { R = validate(saved.recipe); ctx = prepare(R); st = saved.st; } catch (e) { store.del('gv-session'); role = null; return; }
  if (st.phase === 'done' || st.phase === 'closed') { store.del('gv-session'); role = null; st = null; return; }
  keepAwake();
  // Guests already know this broker from the QR code, so stay on it.
  ensureNet(brokerIdx, false);
}
boot();
