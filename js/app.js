// Phone app for «Готовим вместе».
// One phone creates a game (the host) and runs the engine; others join by QR code or game code.
// Every screen is rendered from the shared game state; actions go to the host and come back as new state.

import { validate, prepare, createState, apply, options, cookIndex, statsJSON, title as stepTitle } from './engine.js';
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
let lastTap = 0;          // when this phone was last tapped

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
  if (!net) net = new Net(PID, s => { netStatus = s; document.body.dataset.net = s; if (s === 'online') onOnline(); render(); });
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
setInterval(() => { resend(false); if (pending.size) render(); }, 1500);

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
// One rule for every screen: only what a cook needs right now. One main button, at the bottom.

const back = (label, act) => `<button class="back" data-act="${act}">‹ ${label}</button>`;
const who = i => `<span class="who" style="--cc:${ccol(i)}">${esc(st.cooks[i].name)}</span>`;
const names = () => `<div class="names">${st.cooks.map((_, i) => who(i)).join('')}</div>`;
const hostName = () => { const h = st.cooks.find(c => c.pid === st.host); return h ? h.name : 'ведущий'; };
const hero = () => (R.image ? `<div class="hero">${dishPic(R)}</div>` : '');

/** A line about the connection, shown only when something is wrong. */
function netBar() {
  if (!role || !st || (st.phase === 'lobby' && role === 'host')) return '';
  const slow = [...pending.values()].some(p => Date.now() - p.first > 2500);
  if (netStatus === 'online' && !slow) return '';
  return `<div class="net" role="status">${netStatus === 'offline' ? 'Нет связи. Пробуем снова…' : netStatus === 'connecting' ? 'Подключаемся…' : 'Отправляем…'}</div>`;
}

function scrHome() {
  const cur = book[pick];
  return `<h1 class="title">Готовим вместе</h1>
    <button class="chosen" data-act="book">${cur ? dishPic(cur.r) : `<span class="pic"><span class="emo" aria-hidden="true">📖</span></span>`}
      <span class="ct"><b>${cur ? esc(cur.r.title) : 'Выберите блюдо'}</b><span class="chev" aria-hidden="true">›</span></span></button>
    ${bookErr && !book.length ? `<p class="err">${esc(bookErr)}</p>` : ''}
    <input type="text" id="name" data-bind="name" value="${esc(myName)}" placeholder="Ваше имя" aria-label="Ваше имя" autocomplete="given-name" maxlength="24">
    <div class="stack">
      ${cur ? `<button class="big" data-act="create">Создать игру</button>` : ''}
      <button class="linkish" data-act="tocode">У меня есть код игры</button>
    </div>`;
}

function scrBook() {
  return `${back('Назад', 'home')}<h1>Книга рецептов</h1>
    <div class="tiles">${book.map((c, i) => `<button class="tile dish" data-act="pick" data-i="${i}" aria-pressed="${i === pick}">${dishPic(c.r)}<b>${esc(c.r.title)}</b></button>`).join('')}</div>
    ${bookErr ? `<p class="err">${esc(bookErr)}</p>` : ''}${fileErr ? `<p class="err">${esc(fileErr)}</p>` : ''}
    <button class="linkish" data-act="addfile">Добавить рецепт из файла</button>`;
}

function scrCode() {
  return `${back('Назад', 'home')}<h1>Код игры</h1>
    <p class="muted">Пять букв под QR-кодом на телефоне ведущего.</p>
    <input type="text" id="code" class="code" data-bind="code" maxlength="5" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCDE" aria-label="Код игры">
    <button class="big" data-act="findcode">Найти игру</button>`;
}

function scrLookup() {
  if (lookup === 'missing') {
    return `${back('На главную', 'leavegame')}<div class="card grow mid"><h2>Игра ${esc(code)} не найдена</h2><p class="muted">Проверьте код или отсканируйте QR-код ещё раз.</p></div>`;
  }
  return `${back('Отмена', 'leavegame')}<div class="card grow mid"><h2>Подключаемся…</h2>
    ${lookup === 'searching' || netStatus === 'offline' ? `<p class="muted">${netStatus === 'offline' ? 'Нет связи. Проверьте интернет.' : 'Ищем игру на других серверах.'}</p>` : ''}</div>`;
}

function joinUrl() { return `${location.origin}${location.pathname}${location.search}#join-${code}-${brokerIdx}`; }

function scrLobby() {
  const min = R.players.min || 1;
  if (role === 'host') {
    let qr = '';
    if (net && net.online) {
      try { const q = window.qrcode(0, 'M'); q.addData(joinUrl()); q.make(); qr = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); } catch (e) { qr = ''; }
    }
    return `${back('Отменить', 'cancelgame')}<h1>Зовите поваров</h1>
      <div class="card mid">${qr ? `<div class="qr" aria-label="QR-код для входа в игру">${qr}</div><p class="muted">Наведите камеру или введите код</p><div class="code">${esc(code)}</div>`
        : `<p class="muted">${netStatus === 'offline' ? 'Нет связи. Пробуем снова. Готовить одному можно и без связи.' : 'Подключаемся…'}</p>`}</div>
      ${names()}
      <button class="big" data-act="toEquip" ${st.cooks.length >= min ? '' : 'disabled'}>Начать готовку</button>`;
  }
  if (me() < 0) {
    return `${back('Отмена', 'leavegame')}${hero()}<h1>${esc(R.title)}</h1><p class="muted">${esc(hostName())} зовёт готовить вместе.</p>
      <input type="text" id="name" data-bind="name" value="${esc(myName)}" placeholder="Ваше имя" aria-label="Ваше имя" autocomplete="given-name" maxlength="24">
      <button class="big" data-act="join" ${isPending() ? 'disabled' : ''}>Присоединиться</button>`;
  }
  return `${back('Выйти', 'leave')}${hero()}<h1>${esc(R.title)}</h1>${names()}
    <p class="muted wait">Ждём, пока ${esc(hostName())} начнёт.</p>`;
}

function tile(k, item, qty) {
  const ok = st.checked[k] != null;
  const pic = item.image ? `<img src="${esc(item.image)}" alt="">` : esc(item.icon || '🍽️');
  return `<button class="tile ${ok ? 'ok' : ''}" data-act="tick" data-k="${esc(k)}" aria-pressed="${ok}">${ok ? '<span class="tick">✓</span>' : ''}
    <span class="tp" aria-hidden="true">${pic}</span><span class="nm">${esc(item.name)}${item.optional ? ' *' : ''}</span>${qty ? `<span class="q">${esc(qty)}</span>` : ''}</button>`;
}
function scrEquip() {
  const amt = i => i.amount == null ? (UNITS[i.unit] || '') : (String(i.amount).replace('.', ',') + ' ' + (UNITS[i.unit] || i.unit || ''));
  return `<h1>Вам понадобятся</h1>
    <p class="muted">Отметьте, что уже достали. Отметки видны всем.</p>
    <h3 class="sub">Инвентарь</h3>
    <div class="tiles">${R.equipment.map(e => tile('e:' + e.id, e, (e.count || 1) > 1 ? e.count + ' шт.' : '')).join('')}</div>
    <h3 class="sub">Продукты</h3>
    <div class="tiles">${R.ingredients.map(i => tile('i:' + i.id, i, amt(i))).join('')}</div>
    ${R.ingredients.some(i => i.optional) ? `<p class="muted small">* по желанию</p>` : ''}
    <button class="big" data-act="go">Начинаем</button>`;
}

const lowerFirst = t => (t ? t[0].toLowerCase() + t.slice(1) : '');

/** A line about someone else's step, or a step that cannot be done yet. Empty when there is nothing to add. */
function stepStatus(s) {
  if (st.done[s.id]) {
    const e = st.log.find(x => x.id === s.id && x.type === 'step');
    return e && e.cook != null ? `✓ Сделано · ${who(e.cook)}` : '✓ Сделано';
  }
  const ci = st.cooks.findIndex(c => c.task && c.task.type === 'step' && c.task.id === s.id);
  if (ci >= 0) return ci === me() ? '' : `Делает ${who(ci)}`;
  const missing = s.depends_on.filter(d => !st.done[d]);
  if (missing.length) return `Откроется после «${esc(missing.map(d => lowerFirst(ctx.S[d].title)).join('», «'))}»`;
  return '';
}

/** The instruction, with "previous" and "next" along its sides. */
function card(idx, inner) {
  return `<div class="card step" id="deck">
    <button class="nav" data-act="prev" ${idx != null && idx <= 0 ? 'disabled' : ''} aria-label="Предыдущий шаг">‹</button>
    <div class="inst">${inner}</div>
    <button class="nav" data-act="next" ${idx != null && idx >= R.steps.length - 1 ? 'disabled' : ''} aria-label="Следующий шаг">›</button>
  </div>`;
}
function stepCard(idx, note) {
  const s = R.steps[idx], status = stepStatus(s);
  return card(idx, `${note ? `<p class="note">${note}</p>` : ''}<h2>${esc(s.title)}</h2><p class="desc">${esc(s.description)}</p>${status ? `<p class="stat-line">${status}</p>` : ''}`);
}

/** The recipe card this phone shows when the cook is not browsing: the step they are on. */
function myCard(ci) {
  const t = st.cooks[ci].task;
  return t && (t.type === 'step' || t.type === 'help') ? R.steps.indexOf(ctx.S[t.id]) : null;
}
const firstOpen = () => Math.max(0, R.steps.findIndex(s => !st.done[s.id]));
/** For a cook with nothing to do right now: the next step of the recipe that nobody has yet. */
const upcoming = () => {
  const i = R.steps.findIndex(s => !st.done[s.id] && !st.cooks.some(c => c.task && c.task.type === 'step' && c.task.id === s.id));
  return i >= 0 ? i : firstOpen();
};

/** Three square tiles: what else this cook could do instead. Tapping one switches to it. */
function suggestions(ci) {
  const o = options(st, ctx, ci);
  const all = [
    ...o.steps.map(s => `<button class="tile opt" data-act="take" data-kind="step" data-id="${esc(s.id)}"><b>${esc(s.title)}</b></button>`),
    ...o.helps.map(h => `<button class="tile opt" data-act="take" data-kind="help" data-id="${esc(h.id)}"><b>${esc(ctx.S[h.id].help.text)}</b><span>помочь: ${esc(h.name)}</span></button>`),
    ...o.fbs.map(f => `<button class="tile opt" data-act="take" data-kind="fallback" data-id="${esc(f.id)}"><b>${esc(f.title)}</b></button>`),
  ].slice(0, 3);
  return all.length ? `<div class="tiles">${all.join('')}</div>` : '';
}

function scrCook() {
  const ci = me();
  const doneN = Object.keys(st.done).length, total = R.steps.length;
  const head = `<div class="bar" role="progressbar" aria-label="Сделано шагов" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${doneN}"><i style="width:${(doneN / total) * 100}%"></i></div>`;
  if (ci < 0) return head + `<div class="card grow mid"><h2>Игра идёт без этого телефона</h2><p class="muted">Присоединиться можно только до начала готовки.</p></div><button class="big secondary" data-act="leavegame">На главную</button>`;

  const t = st.cooks[ci].task;
  const key = t ? t.type + ':' + (t.id || '') : '';
  if (key !== deckKey) {
    // A step arrived by itself while the cook had nothing to do: a short buzz, for phones that can.
    if (deckKey.startsWith('choose') && key.startsWith('step') && Date.now() - lastTap > 2000) { try { navigator.vibrate && navigator.vibrate(200); } catch (e) { /* no vibration */ } }
    deckKey = key; deck = null;
  }
  const mine = myCard(ci);
  const browsing = deck != null;
  const busy = isPending() ? 'disabled' : '';
  const done = id => `<button class="big" data-act="done" data-id="${esc(id)}" ${busy}>Готово</button>`;

  let body, action = '';
  if (browsing) {
    body = stepCard(deck);
    action = `<button class="big secondary" data-act="mine">К моему шагу</button>`;
  } else if (t && t.type === 'fallback') {
    body = card(null, `<p class="note">Пока остальное готовится</p><h2>${esc(ctx.F[t.id].title)}</h2>`);
    action = done(t.id);
  } else if (mine != null) {
    body = stepCard(mine, t.type === 'help' ? `Помогаете: ${esc(ctx.S[t.id].help.text)}` : '');
    action = done(t.id);
  } else {
    body = stepCard(upcoming());
  }
  return head + body + `<div class="foot">${action}${browsing ? '' : suggestions(ci)}</div>`;
}

function dur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'меньше минуты';
  const h = Math.floor(m / 60), r = m % 60;
  return (h ? h + ' ч ' : '') + (r || !h ? r + ' мин' : '');
}

function scrDone() {
  const total = st.end - st.start;
  const TYPES = { step: 'шаг', help: 'помощь', fallback: 'пока ждём' };
  const rows = st.log.filter(e => e.type !== 'wait').sort((a, b) => a.start - b.start);
  const complete = R.steps.every(s => st.done[s.id]);
  const steps = i => st.log.filter(e => e.cook === i && e.type === 'step').length;
  const by = st.cooks.length > 1
    ? st.cooks.map((c, i) => `${who(i)} — ${steps(i)} ${plural(steps(i), 'шаг', 'шага', 'шагов')}`).join('<br>')
    : `${steps(0)} ${plural(steps(0), 'шаг', 'шага', 'шагов')}`;
  return `${hero()}<h1>${complete ? 'Приятного аппетита!' : 'Готовка остановлена'}</h1>
    <p class="summary">${esc(R.title)} за ${dur(total)}.<br>${by}</p>
    <details class="more"><summary>Сколько занял каждый шаг</summary>
      <table>${rows.map(e => `<tr><td>${esc(stepTitle(ctx, e.id))} ${e.type !== 'step' ? `<span class="tag">${TYPES[e.type]}</span>` : ''}</td><td>${e.cook == null ? '' : `<span class="who" style="--cc:${ccol(e.cook)}" title="${esc(st.cooks[e.cook].name)}"></span>`}</td><td class="n">${fmt(e.ms)}</td></tr>`).join('')}</table>
      <div class="row"><button class="ghost" data-act="copy">Скопировать статистику</button><span class="muted small" id="copied" aria-live="polite"></span></div>
      <textarea class="raw" id="raw" hidden readonly></textarea>
    </details>
    <button class="big" data-act="${role === 'host' ? 'newgame' : 'leavegame'}">${role === 'host' ? 'Новая игра' : 'На главную'}</button>`;
}

function scrClosed() {
  return `<div class="card grow mid"><h2>Ведущий закрыл игру</h2></div>
    <button class="big" data-act="leavegame">На главную</button>`;
}

function screen() {
  if (!role) return view === 'book' ? scrBook() : view === 'code' ? scrCode() : scrHome();
  if (!st || (role === 'guest' && !R)) return scrLookup();
  if (st.phase === 'closed') return scrClosed();
  if (st.phase === 'lobby') return scrLobby();
  if (me() < 0 && st.phase !== 'done') return `<div class="card grow mid"><h2>Игра уже идёт без вас</h2><p class="muted">Присоединиться можно только до начала готовки.</p></div><button class="big" data-act="leavegame">На главную</button>`;
  if (st.phase === 'equip') return scrEquip();
  if (st.phase === 'cook') return scrCook();
  return scrDone();
}

function render() {
  const f = document.activeElement, fid = f && f.id && f.tagName === 'INPUT' ? f.id : null;
  const sel = fid ? f.selectionStart : null;
  const open = !!document.querySelector('details.more[open]');
  app.innerHTML = netBar() + (toast ? `<div class="toast" role="status">${esc(toast)}</div>` : '') + screen();
  if (open) { const d = document.querySelector('details.more'); if (d) d.open = true; }
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
  lastTap = Date.now();
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
    case 'toEquip': return send('toEquip');
    case 'tick': return send('tick', { key: b.dataset.k });
    case 'go': return send('go');
    case 'take': return send('take', { kind: b.dataset.kind, id: b.dataset.id });
    case 'done': return send('done', { id: b.dataset.id });
    case 'prev': case 'next': {
      const mine = myCard(me()), t = st.cooks[me()].task;
      const shown = deck ?? mine ?? (t && t.type === 'fallback' ? null : upcoming());
      deck = shown == null ? firstOpen() : Math.max(0, Math.min(R.steps.length - 1, shown + (a === 'next' ? 1 : -1)));
      if (deck === mine || (mine == null && !(t && t.type === 'fallback') && deck === upcoming())) deck = null;
      return render();
    }
    case 'mine': deck = null; return render();
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
