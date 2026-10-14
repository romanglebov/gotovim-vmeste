// Engine tests: every recipe in the book is cooked to the end by 1, 2 and 3 cooks,
// with cooks switching steps now and then. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validate, prepare, createState, apply, options, STATIONS } from '../js/engine.js';

const dir = new URL('../recipes/', import.meta.url);
const index = JSON.parse(readFileSync(new URL('index.json', dir)));
const recipes = index.recipes.map(f => validate(JSON.parse(readFileSync(new URL(f, dir)))));

function rng(seed) { return () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648; }

let aidN = 0;
function act(st, ctx, a, now) {
  const r = apply(st, ctx, { aid: 'a' + aidN++, ...a }, now);
  checkInvariants(st, ctx);
  return r;
}

function checkInvariants(st, ctx) {
  // No equipment is used more times than the kitchen has it.
  const u = {};
  const add = id => ctx.S[id].resources.forEach(r => (u[r] = (u[r] || 0) + 1));
  st.cooks.forEach(c => { if (c.task && c.task.type === 'step') add(c.task.id); });
  for (const [r, n] of Object.entries(u)) assert.ok(n <= ctx.CAP[r], `resource ${r} used ${n} > ${ctx.CAP[r]}`);
  // Every running step has all its prerequisites done.
  const running = st.cooks.filter(c => c.task && c.task.type === 'step').map(c => c.task.id);
  for (const id of running) for (const d of ctx.S[id].depends_on) assert.ok(st.done[d], `${id} started before ${d}`);
}

function play(recipe, nCooks, strategy, seed = 1) {
  const R = JSON.parse(JSON.stringify(recipe));
  const ctx = prepare(R);
  const rand = rng(seed);
  let now = 1_000_000;
  const st = createState({ code: 'TEST', recipe: R, hostPid: 'p0', hostName: 'Рома', now });
  for (let i = 1; i < nCooks; i++) assert.ok(act(st, ctx, { pid: 'p' + i, type: 'join', name: ['Алёна', 'Третий'][i - 1] }, now).ok);
  assert.equal(st.cooks.length, nCooks);
  assert.ok(act(st, ctx, { pid: 'p0', type: 'toEquip' }, now).ok);
  for (const e of R.equipment) act(st, ctx, { pid: 'p1'.slice(0, nCooks > 1 ? 2 : 0) || 'p0', type: 'tick', key: 'e:' + e.id }, now);
  assert.ok(act(st, ctx, { pid: 'p0', type: 'go' }, now).ok);

  for (let guard = 0; guard < 5000 && st.phase === 'cook'; guard++) {
    now += 1000 + Math.floor(rand() * 4000);
    let did = false;
    const order = st.cooks.map((_, i) => i);
    if (strategy === 'random') order.sort(() => rand() - 0.5);
    for (const ci of order) {
      const c = st.cooks[ci];
      if (!c.task) continue;
      const o = options(st, ctx, ci);
      if (c.task.type === 'choose') {
        // Nothing to cook right now: help someone or do a small task, or just wait.
        let pick = null;
        if (o.helps.length && rand() < 0.7) pick = { kind: 'help', id: o.helps[0].id };
        else if (o.fbs.length && rand() < 0.3) pick = { kind: 'fallback', id: o.fbs[0].id };
        if (pick) { assert.ok(act(st, ctx, { pid: c.pid, type: 'take', ...pick }, now).ok); did = true; }
      } else if (strategy === 'random' && o.steps.length && rand() < 0.1) {
        // "Другое дело": switch to another step.
        const s = o.steps[Math.floor(rand() * o.steps.length)];
        assert.ok(act(st, ctx, { pid: c.pid, type: 'take', kind: 'step', id: s.id }, now).ok);
        did = true;
      } else if (rand() < 0.6) {
        assert.ok(act(st, ctx, { pid: c.pid, type: 'done', id: c.task.id }, now).ok);
        did = true;
      }
    }
    if (!did) assert.ok(st.cooks.some(c => c.task && c.task.type !== 'choose'), 'nobody can move: the game is stuck');
  }
  assert.equal(st.phase, 'done', `${R.id} with ${nCooks} cooks did not finish`);
  for (const s of R.steps) assert.ok(st.done[s.id], `${s.id} not done`);
  // Order respected: each step started after all its prerequisites finished.
  const finishedAt = {};
  for (const e of st.log) if (e.type === 'step') finishedAt[e.id] = e.end;
  for (const s of R.steps) for (const d of s.depends_on) {
    const started = st.log.find(e => e.id === s.id && e.type === 'step').start;
    assert.ok(finishedAt[d] <= started, `${R.id}: ${s.id} started before ${d} finished`);
  }
  return st;
}

for (const r of recipes) {
  for (const n of [1, 2, 3]) {
    if (n > r.players.max) continue;
    test(`${r.title}: ${n} ${n === 1 ? 'повар' : 'повара'}, рекомендованные шаги`, () => { play(r, n, 'recommended'); });
    test(`${r.title}: ${n} ${n === 1 ? 'повар' : 'повара'}, случайный порядок`, () => { for (let s = 1; s <= 25; s++) play(r, n, 'random', s * 7919); });
  }
}

test('нельзя взять шаг раньше его зависимостей', () => {
  const R = JSON.parse(JSON.stringify(recipes.find(r => r.id === 'mushroom_cream_soup')));
  const ctx = prepare(R);
  const st = createState({ code: 'X', recipe: R, hostPid: 'h', hostName: 'h', now: 0 });
  apply(st, ctx, { pid: 'h', type: 'toEquip' }, 0);
  apply(st, ctx, { pid: 'h', type: 'go' }, 0);
  const r = apply(st, ctx, { pid: 'h', type: 'take', kind: 'step', id: 'pour_water' }, 1);
  assert.equal(r.ok, false);
  assert.ok(!options(st, ctx, 0).steps.some(s => s.id === 'pour_water'));
});

test('повторное действие с тем же id применяется один раз', () => {
  const R = JSON.parse(JSON.stringify(recipes[0]));
  const ctx = prepare(R);
  const st = createState({ code: 'X', recipe: R, hostPid: 'h', hostName: 'h', now: 0 });
  apply(st, ctx, { aid: 'same', pid: 'g', type: 'join', name: 'Гость' }, 0);
  apply(st, ctx, { aid: 'same', pid: 'g2', type: 'join', name: 'Гость 2' }, 0);
  assert.equal(st.cooks.length, 2);
});

test('нельзя присоединиться после начала', () => {
  const R = JSON.parse(JSON.stringify(recipes[0]));
  const ctx = prepare(R);
  const st = createState({ code: 'X', recipe: R, hostPid: 'h', hostName: 'h', now: 0 });
  apply(st, ctx, { pid: 'h', type: 'toEquip' }, 0);
  assert.equal(apply(st, ctx, { pid: 'late', type: 'join', name: 'Поздний' }, 0).ok, false);
});

test('у каждого шага есть пост и продукт, а признаки готовности — в самой инструкции', () => {
  for (const r of recipes) for (const s of r.steps) {
    assert.ok(STATIONS[s.station], `${r.id}/${s.id}: пост`);
    assert.ok(s.item && s.description, `${r.id}/${s.id}: item, description`);
    for (const k of ['timer', 'done_when', 'typical']) assert.equal(s[k], undefined, `${r.id}/${s.id}: без ${k}`);
  }
});

function started(recipe) {
  const R = JSON.parse(JSON.stringify(recipe)); const ctx = prepare(R);
  const st = createState({ code: 'X', recipe: R, hostPid: 'h', hostName: 'Рома', now: 0 });
  apply(st, ctx, { pid: 'g', type: 'join', name: 'Алёна' }, 0);
  apply(st, ctx, { pid: 'h', type: 'toEquip' }, 0);
  apply(st, ctx, { pid: 'h', type: 'go' }, 0);
  return { st, ctx };
}

test('на старте каждый повар сразу получает свой шаг', () => {
  for (const r of recipes) {
    const { st } = started(r);
    assert.ok(st.cooks.every(c => c.task && c.task.type === 'step'), r.id);
    assert.notEqual(st.cooks[0].task.id, st.cooks[1].task.id);
  }
});

test('после «Готово» повару сразу достаётся продолжение', () => {
  const { st, ctx } = started(recipes.find(r => r.id === 'shakshuka'));
  if (st.cooks[1].task.id !== 'wash_pepper') assert.ok(apply(st, ctx, { pid: 'g', type: 'take', kind: 'step', id: 'wash_pepper' }, 1).ok);
  apply(st, ctx, { pid: 'g', type: 'done', id: 'wash_pepper' }, 2);
  assert.equal(st.cooks[1].task.id, 'seed_pepper');
});

test('продолжение шага остаётся за тем, кто его начал', () => {
  const { st, ctx } = started(recipes.find(r => r.id === 'shakshuka'));
  if (st.cooks[0].task.id !== 'wash_pepper') {
    if (st.cooks[1].task.id === 'wash_pepper') apply(st, ctx, { pid: 'g', type: 'take', kind: 'step', id: options(st, ctx, 1).steps[0].id }, 1);
    assert.ok(apply(st, ctx, { pid: 'h', type: 'take', kind: 'step', id: 'wash_pepper' }, 1).ok);
  }
  apply(st, ctx, { pid: 'h', type: 'done', id: 'wash_pepper' }, 2);
  assert.equal(st.cooks[0].task.id, 'seed_pepper', 'Рома чистит свой перец');
  assert.notEqual(st.cooks[1].task.id, 'seed_pepper', 'у Алёны другое дело');
});

test('«Другое дело» возвращает прежний шаг остальным', () => {
  const { st, ctx } = started(recipes.find(r => r.id === 'mushroom_cream_soup'));
  const was = st.cooks[0].task.id;
  const other = options(st, ctx, 0).steps[0];
  assert.ok(apply(st, ctx, { pid: 'h', type: 'take', kind: 'step', id: other.id }, 1).ok);
  assert.equal(st.cooks[0].task.id, other.id);
  assert.ok(options(st, ctx, 1).steps.some(s => s.id === was), 'прежний шаг снова свободен');
});

test('в рецептах только шаги готовки: ни ожиданий, ни дел вроде «помыть посуду»', () => {
  for (const r of recipes) assert.equal(r.fallback_tasks.length, 0, `${r.id}: fallback_tasks`);
  for (const r of recipes) for (const s of r.steps) {
    assert.equal(s.kind, undefined, `${r.id}/${s.id}: kind`);
    assert.ok(!/^(Ждём|Дождаться|Вода закипает|Паста варится|Суп кипит)/.test(s.title), `${r.id}/${s.id}: ${s.title}`);
  }
});

test('каждый продукт идёт в какой-нибудь шаг', () => {
  for (const r of recipes) {
    const used = new Set(r.steps.flatMap(s => s.ingredients || []));
    for (const i of r.ingredients) assert.ok(used.has(i.id), `${r.id}: продукт ${i.id} ни в одном шаге`);
  }
});

test('накрыть на стол предлагается последним', () => {
  const { st, ctx } = started(recipes.find(r => r.id === 'mushroom_cream_soup'));
  const list = options(st, ctx, 0).steps;
  assert.equal(list.at(-1).id, 'set_table');
});
