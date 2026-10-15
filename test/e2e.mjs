// End-to-end test: two "phones" (separate browser profiles) cook each recipe in the book to the end,
// talking through a local MQTT broker exactly as real phones talk through a public one.
// Midway through one game both phones reload the page, to check that a game survives it.
//   npm run test:e2e        (needs Playwright with Chromium: npx playwright install chromium)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { startDevServer } from '../tools/dev-server.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.error('Playwright not found: npm i -D playwright && npx playwright install chromium'); process.exit(2); }

const index = JSON.parse(readFileSync(new URL('../recipes/index.json', import.meta.url)));
const titles = index.recipes.map(f => JSON.parse(readFileSync(new URL('../recipes/' + f, import.meta.url))).title);

const dev = await startDevServer({ httpPort: 8091, mqttPort: 8893, quiet: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }).catch(() => chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }));
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: false };
const errors = [];

async function newPhone(label) {
  const ctx = await browser.newContext(phone);
  // Serve the two CDN libraries from node_modules, so the test runs offline.
  await ctx.route('https://cdn.jsdelivr.net/npm/**', route => {
    const u = route.request().url();
    const file = u.includes('/mqtt@') ? 'node_modules/mqtt/dist/mqtt.min.js' : u.includes('/qrcode-generator@') ? 'node_modules/qrcode-generator/qrcode.js' : null;
    return file ? route.fulfill({ path: new URL('../' + file, import.meta.url).pathname, contentType: 'text/javascript' }) : route.abort();
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|Failed to load resource/.test(m.text())) errors.push(`${label}: ${m.text()}`); });
  return page;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const text = p => p.locator('#app').innerText();

/** Рома creates a game, Алёна joins by the link; both are on the "you will need" screen. */
async function startGame(title, tag = '') {
  const host = await newPhone(`${title}${tag}/host`), guest = await newPhone(`${title}${tag}/guest`);
  await host.goto(dev.url);
  await host.click('[data-act="book"]');
  await host.locator('.dish', { hasText: title }).click();
  await host.fill('#name', 'Рома');
  await host.click('[data-act="create"]');
  await host.locator('.qr svg').waitFor({ timeout: 15000 });
  const code = (await host.locator('.code').innerText()).trim();

  await guest.goto(`${dev.url}#join-${code}-0`);
  await guest.locator('#name').waitFor({ timeout: 15000 });
  await guest.fill('#name', 'Алёна');
  await guest.click('[data-act="join"]');
  await host.locator('.names', { hasText: 'Алёна' }).waitFor({ timeout: 10000 });
  await guest.locator('text=Ждём, пока Рома начнёт').waitFor({ timeout: 10000 });

  await host.click('[data-act="toEquip"]');
  await guest.locator('text=Вам понадобятся').waitFor({ timeout: 10000 });
  return { host, guest, code };
}

async function playGame(title, reloadMidway) {
  const { host, guest, code } = await startGame(title);

  // A tick on one phone shows up on the other.
  await host.locator('.tile').nth(0).click();
  await guest.locator('.tile').nth(1).click();
  await host.locator('.tile.ok').nth(1).waitFor({ timeout: 10000 });
  await guest.locator('.tile.ok').nth(1).waitFor({ timeout: 10000 });
  await guest.click('[data-act="go"]');

  // The recipe deck can be browsed and brought back to your own step.
  await host.locator('#deck').waitFor({ timeout: 10000 });
  const myTitle = await host.locator('#deck h2').innerText();
  await host.click('[data-act="next"]');
  await host.click('[data-act="next"]');
  await host.locator('[data-act="mine"]').click();
  if ((await host.locator('#deck h2').innerText()) !== myTitle) errors.push(`${title}: «К моему шагу» не вернул к своему шагу`);

  const phones = [host, guest];
  const start = Date.now();
  let reloaded = false, actions = 0;
  while (Date.now() - start < 240000) {
    const done = await Promise.all(phones.map(async p => (await text(p)).includes('Приятного аппетита')));
    if (done.every(Boolean)) break;
    if (reloadMidway && !reloaded && actions > 12) {
      reloaded = true;
      await Promise.all(phones.map(p => p.reload()));
      await Promise.all(phones.map(p => p.locator('body[data-net="online"]').waitFor({ timeout: 15000 })));
    }
    let acted = false;
    for (const p of phones) {
      for (const sel of ['button[data-act="done"]:not([disabled])', '.opt']) {
        const el = p.locator(sel).first();
        if (await el.count() && await el.isVisible().catch(() => false)) {
          await el.click({ timeout: 2000 }).catch(() => {});
          acted = true; actions++;
          await sleep(120);
          break;
        }
      }
    }
    if (!acted) await sleep(500);
  }
  const ok = (await text(host)).includes('Приятного аппетита') && (await text(guest)).includes('Приятного аппетита');
  await host.context().close(); await guest.context().close();
  return { title, ok, code, actions, seconds: Math.round((Date.now() - start) / 1000), reloaded };
}

/** The ✕ during cooking: a question first, then home. A cook who left can come back; the host ends the game for all. */
async function quitGame(title) {
  const { host, guest, code } = await startGame(title, ' (выход)');
  const fail = m => errors.push(`${title} (выход): ${m}`);
  await host.click('[data-act="go"]');
  await guest.locator('#deck').waitFor({ timeout: 10000 });
  const ask = async (p, expectNote) => {
    await p.click('[data-act="quit"]');
    const d = p.locator('.dlg');
    await d.waitFor({ timeout: 5000 });
    if ((await d.locator('h2').innerText()) !== 'Закончить и выйти на главный экран?') fail('не тот вопрос: ' + await d.locator('h2').innerText());
    const note = await d.locator('#dlgd').count() ? await d.locator('#dlgd').innerText() : '';
    if (note !== expectNote) fail(`пояснение «${note}», а ждали «${expectNote}»`);
  };
  // «Остаться» and Escape keep the game.
  await ask(guest, 'Остальные доготовят без вас.');
  await guest.click('.dlg [data-act="stay"]');
  if (await guest.locator('.dlg').count() || !(await guest.locator('#deck').count())) fail('«Остаться» не вернуло к готовке');
  await ask(guest, 'Остальные доготовят без вас.');
  await guest.keyboard.press('Escape');
  if (await guest.locator('.dlg').count()) fail('Escape не закрыл вопрос');
  // Алёна leaves: she is home, Рома keeps cooking and gets her step back into the pool.
  await ask(guest, 'Остальные доготовят без вас.');
  await guest.click('.dlg [data-act="quitok"]');
  await guest.locator('h1.title', { hasText: 'Готовим вместе' }).waitFor({ timeout: 10000 });
  await sleep(500);
  if (!(await host.locator('button[data-act="done"]').count())) fail('у ведущего пропал шаг после выхода гостя');
  // She comes back by the same link.
  await guest.goto(`${dev.url}#join-${code}-0`);
  await guest.locator('text=Вы вышли из игры').waitFor({ timeout: 10000 });
  await guest.click('[data-act="join"]');
  await guest.locator('button[data-act="done"]').waitFor({ timeout: 10000 });
  // Рома ends it for everyone; Алёна sees the end screen.
  await ask(host, 'Готовка закончится у всех.');
  await host.click('.dlg [data-act="quitok"]');
  await host.locator('h1.title', { hasText: 'Готовим вместе' }).waitFor({ timeout: 10000 });
  await guest.locator('text=Готовка остановлена').waitFor({ timeout: 10000 });
  // On the "you will need" screen the ✕ is there too.
  const second = await startGame(title, ' (выход до начала)');
  await second.host.click('[data-act="quit"]');
  await second.host.click('.dlg [data-act="quitok"]');
  await second.guest.locator('text=Ведущий закрыл игру').waitFor({ timeout: 10000 });
  for (const p of [host, guest, second.host, second.guest]) await p.context().close();
  return { title: title + ': выход из игры', ok: true, code, actions: 0, seconds: 0 };
}

let results;
try {
  results = await Promise.all([...titles.map((t, i) => playGame(t, i === 0)), quitGame(titles[titles.length - 1]).catch(e => { errors.push('выход: ' + e.message); return { title: 'выход из игры', ok: false }; })]);
} finally {
  await browser.close();
  await dev.close();
}
for (const r of results) console.log(r.actions ? `${r.ok ? 'OK  ' : 'FAIL'} ${r.title}: игра ${r.code}, ${r.actions} нажатий, ${r.seconds} с${r.reloaded ? ', с перезагрузкой обоих телефонов' : ''}` : `${r.ok ? 'OK  ' : 'FAIL'} ${r.title}`);
if (errors.length) { console.log('Ошибки в консоли:\n' + [...new Set(errors)].slice(0, 20).join('\n')); }
process.exit(results.every(r => r.ok) && !errors.length ? 0 : 1);
