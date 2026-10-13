// Game engine for «Готовим вместе».
// Pure logic, no DOM and no network: the host phone runs it, every phone renders the state it produces.
// The same module runs in the browser and in Node tests.

export const SUPPORTED_FORMAT = 1;
export const MAX_COOKS = 4;

/* ---------------- recipes ---------------- */

export function validate(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw 'файл не похож на рецепт.';
  if (r.format_version > SUPPORTED_FORMAT) throw `рецепт сделан для более новой версии приложения (формат ${r.format_version}).`;
  for (const k of ['id', 'title', 'equipment', 'ingredients', 'steps']) if (!(k in r)) throw `нет поля «${k}».`;
  if (!Array.isArray(r.steps) || !r.steps.length) throw 'в рецепте нет шагов.';
  const ids = new Set(), eq = new Set(r.equipment.map(e => e.id));
  for (const s of r.steps) {
    if (!s.id || !s.title) throw 'у каждого шага должны быть id и title.';
    if (ids.has(s.id)) throw `шаг «${s.id}» встречается дважды.`;
    ids.add(s.id);
  }
  for (const s of r.steps) {
    s.depends_on = s.depends_on || []; s.resources = s.resources || []; s.kind = s.kind || 'active';
    for (const d of s.depends_on) if (!ids.has(d)) throw `шаг «${s.id}» зависит от несуществующего шага «${d}».`;
    for (const x of s.resources) if (!eq.has(x)) throw `шаг «${s.id}» использует «${x}», которого нет в инвентаре.`;
    if (s.timer && s.timer.type === 'countdown' && !(s.timer.seconds > 0)) throw `у таймера шага «${s.id}» нет длительности.`;
    if (s.timer && s.timer.type === 'reminder' && !(s.timer.after_seconds > 0)) throw `у напоминания шага «${s.id}» нет времени.`;
  }
  const S = Object.fromEntries(r.steps.map(s => [s.id, s])), seen = new Set();
  const visit = (id, path) => {
    if (path.includes(id)) throw `шаги зациклены: ${[...path, id].join(' → ')}.`;
    if (seen.has(id)) return;
    S[id].depends_on.forEach(d => visit(d, [...path, id]));
    seen.add(id);
  };
  r.steps.forEach(s => visit(s.id, []));
  r.fallback_tasks = r.fallback_tasks || [];
  r.players = r.players || { min: 1, max: 3 };
  return r;
}

/** Lookup tables derived from a recipe. Not stored in the shared state. */
export function prepare(R) {
  const S = Object.fromEntries(R.steps.map(s => [s.id, s]));
  const F = Object.fromEntries(R.fallback_tasks.map(f => [f.id, f]));
  const CAP = Object.fromEntries(R.equipment.map(e => [e.id, e.count || 1]));
  const kids = {};
  R.steps.forEach(s => s.depends_on.forEach(d => (kids[d] = kids[d] || []).push(s.id)));
  const desc = {};
  const dc = id => {
    if (desc[id]) return desc[id];
    const set = new Set();
    (kids[id] || []).forEach(k => { set.add(k); dc(k).forEach(x => set.add(x)); });
    return (desc[id] = set);
  };
  R.steps.forEach(s => dc(s.id));
  return { R, S, F, CAP, desc };
}

export const isBg = s => s.kind === 'waiting';
export const maxCooks = R => Math.min(MAX_COOKS, (R.players && R.players.max) || 3);

/* ---------------- state ---------------- */

export function createState({ code, recipe, hostPid, hostName, now }) {
  return {
    v: 1, code, rev: 0, now,
    recipeId: recipe.id, recipeVersion: recipe.version ?? null,
    phase: 'lobby', host: hostPid, speed: 1,
    cooks: [{ pid: hostPid, name: cleanName(hostName, 0), task: null }],
    checked: {}, done: {}, bg: {}, fb: {}, log: [],
    start: null, end: null, applied: [],
  };
}

export const cookIndex = (st, pid) => st.cooks.findIndex(c => c.pid === pid);
const cleanName = (n, i) => String(n || '').trim().slice(0, 24) || `Повар ${i + 1}`;

/* ---------------- scheduling ---------------- */

function usage(st, ctx) {
  const u = {};
  const add = id => ctx.S[id].resources.forEach(r => (u[r] = (u[r] || 0) + 1));
  st.cooks.forEach(c => { if (c.task && c.task.type === 'step') add(c.task.id); });
  Object.keys(st.bg).forEach(add);
  return u;
}
const taken = (st, id) => !!st.bg[id] || st.cooks.some(c => c.task && c.task.type === 'step' && c.task.id === id);

/** Steps whose prerequisites are all done and whose equipment is free, most unlocking first. */
export function avail(st, ctx) {
  const u = usage(st, ctx);
  return ctx.R.steps
    .filter(s => !st.done[s.id] && !taken(st, s.id)
      && s.depends_on.every(d => st.done[d])
      && s.resources.every(r => (u[r] || 0) + 1 <= (ctx.CAP[r] || 1)))
    .sort((a, b) => ctx.desc[b.id].size - ctx.desc[a.id].size);
}

/** What a cook may pick right now. Nothing is reserved until they pick. */
export function options(st, ctx, ci) {
  const c = st.cooks[ci];
  const steps = avail(st, ctx).filter(s => !isBg(s));
  const helps = st.cooks
    .map((o, i) => ({ o, i }))
    .filter(({ o, i }) => i !== ci && o.task && o.task.type === 'step' && ctx.S[o.task.id].help
      && !st.cooks.some(h => h.task && h.task.type === 'help' && h.task.of === o.task.id))
    .map(({ o, i }) => ({ id: o.task.id, host: i, name: o.name }));
  const fbs = Object.keys(st.done).length
    ? ctx.R.fallback_tasks.filter(f => !st.fb[f.id] && !st.cooks.some(o => o !== c && o.task && o.task.type === 'fallback' && o.task.id === f.id))
    : [];
  return { steps, helps, fbs };
}

function log(st, e, now) {
  st.log.push({ type: e.type, id: e.id, of: e.of ?? null, cook: e.cook ?? null, start: e.start, end: now, ms: now - e.start });
}

function schedule(st, ctx, now) {
  for (let g = 0; g < 50; g++) {
    const b = avail(st, ctx).find(isBg);
    if (!b) break;
    const cd = b.timer && b.timer.type === 'countdown';
    st.bg[b.id] = { start: now, end: cd ? now + (b.timer.seconds * 1000) / st.speed : null };
  }
  st.cooks.forEach(c => { if (!c.task) c.task = { type: 'choose', start: now }; });
  if (ctx.R.steps.every(s => st.done[s.id])) finish(st, now);
}

function finish(st, now) {
  st.cooks.forEach((c, i) => {
    if (c.task) log(st, { ...c.task, type: c.task.type === 'choose' ? 'wait' : c.task.type, cook: i }, now);
    c.task = null;
  });
  Object.entries(st.bg).forEach(([id, b]) => log(st, { type: 'timer', id, start: b.start }, now));
  st.bg = {};
  st.phase = 'done';
  st.end = now;
}

/** Advance the clock: countdowns on the stove finish by themselves. Returns ids that just finished. */
export function tick(st, ctx, now) {
  if (st.phase !== 'cook') return [];
  const ended = [];
  for (const [id, b] of Object.entries(st.bg)) {
    if (b.end && now >= b.end) {
      log(st, { type: 'timer', id, start: b.start }, now);
      st.done[id] = true;
      delete st.bg[id];
      ended.push(id);
    }
  }
  if (ended.length) { schedule(st, ctx, now); st.rev++; }
  return ended;
}

/* ---------------- actions ---------------- */

/**
 * Apply one action from a phone. Returns { ok: true } or { ok: false, err } with a message for that phone.
 * Every action carries `aid` (unique id, for de-duplication) and `pid` (the phone that sent it).
 */
export function apply(st, ctx, a, now) {
  if (a.aid && st.applied.includes(a.aid)) return { ok: true, dup: true };
  const res = applyInner(st, ctx, a, now);
  if (a.aid) { st.applied.push(a.aid); if (st.applied.length > 300) st.applied.splice(0, st.applied.length - 300); }
  if (res.ok) st.rev++;
  return res;
}

function applyInner(st, ctx, a, now) {
  const ci = cookIndex(st, a.pid);
  const isHost = a.pid === st.host;
  switch (a.type) {
    case 'join': {
      if (ci >= 0) { st.cooks[ci].name = cleanName(a.name, ci); return { ok: true }; }
      if (st.phase !== 'lobby') return { ok: false, err: 'Игра уже началась, присоединиться можно только в лобби.' };
      if (st.cooks.length >= maxCooks(ctx.R)) return { ok: false, err: 'В игре уже максимум поваров для этого рецепта.' };
      st.cooks.push({ pid: a.pid, name: cleanName(a.name, st.cooks.length), task: null });
      return { ok: true };
    }
    case 'leave': {
      if (st.phase !== 'lobby' || ci <= 0) return { ok: false, err: 'Сейчас выйти нельзя.' };
      st.cooks.splice(ci, 1);
      return { ok: true };
    }
    case 'speed': {
      if (!isHost || st.phase !== 'lobby') return { ok: false };
      st.speed = a.x === 20 ? 20 : 1;
      return { ok: true };
    }
    case 'toEquip': {
      if (!isHost || st.phase !== 'lobby') return { ok: false };
      if (st.cooks.length < (ctx.R.players.min || 1)) return { ok: false, err: 'Не хватает поваров.' };
      st.phase = 'equip';
      return { ok: true };
    }
    case 'tick': {
      if (st.phase !== 'equip' || ci < 0) return { ok: false };
      if (st.checked[a.key] != null) delete st.checked[a.key]; else st.checked[a.key] = ci;
      return { ok: true };
    }
    case 'go': {
      if (st.phase !== 'equip' || ci < 0) return { ok: false };
      st.phase = 'cook';
      st.start = now;
      schedule(st, ctx, now);
      return { ok: true };
    }
    case 'take': {
      if (st.phase !== 'cook' || ci < 0) return { ok: false };
      const c = st.cooks[ci];
      if (!c.task || c.task.type !== 'choose') return { ok: false };
      const o = options(st, ctx, ci);
      let task = null;
      if (a.kind === 'step' && o.steps.some(s => s.id === a.id)) task = { type: 'step', id: a.id, start: now };
      if (a.kind === 'help') { const h = o.helps.find(h => h.id === a.id); if (h) task = { type: 'help', id: a.id, of: a.id, host: h.host, start: now }; }
      if (a.kind === 'fallback' && o.fbs.some(f => f.id === a.id)) task = { type: 'fallback', id: a.id, start: now };
      if (!task) return { ok: false, err: 'Это уже взял кто-то другой.' };
      log(st, { type: 'wait', id: 'wait', cook: ci, start: c.task.start }, now);
      c.task = task;
      schedule(st, ctx, now);
      return { ok: true };
    }
    case 'done': {
      if (st.phase !== 'cook' || ci < 0) return { ok: false };
      const c = st.cooks[ci], t = c.task;
      if (!t || t.type === 'choose') return { ok: false };
      if (a.id && t.id !== a.id) return { ok: false };
      log(st, { ...t, cook: ci }, now);
      if (t.type === 'step') {
        st.done[t.id] = true;
        st.cooks.forEach((h, hi) => {
          if (h.task && h.task.type === 'help' && h.task.of === t.id) { log(st, { ...h.task, cook: hi }, now); h.task = null; }
        });
      }
      if (t.type === 'fallback') st.fb[t.id] = true;
      c.task = null;
      schedule(st, ctx, now);
      return { ok: true };
    }
    case 'bgdone': {
      if (st.phase !== 'cook' || ci < 0) return { ok: false };
      const b = st.bg[a.id];
      if (!b) return { ok: false };
      log(st, { type: 'timer', id: a.id, start: b.start }, now);
      st.done[a.id] = true;
      delete st.bg[a.id];
      schedule(st, ctx, now);
      return { ok: true };
    }
    case 'stop': {
      if (!isHost || st.phase !== 'cook') return { ok: false };
      finish(st, now);
      return { ok: true };
    }
    default:
      return { ok: false };
  }
}

/* ---------------- stats ---------------- */

export function title(ctx, id) {
  return (ctx.S[id] || ctx.F[id] || {}).title || id;
}

export function statsJSON(st, ctx) {
  return {
    recipe: st.recipeId, recipe_version: st.recipeVersion, speed: st.speed,
    started: st.start ? new Date(st.start).toISOString() : null,
    total_ms: st.end && st.start ? st.end - st.start : null,
    cooks: st.cooks.map(c => c.name),
    log: [...st.log].sort((a, b) => a.start - b.start).map(e => ({
      ...e, cook: e.cook == null ? null : st.cooks[e.cook].name, title: e.type === 'wait' ? null : title(ctx, e.id),
    })),
  };
}
