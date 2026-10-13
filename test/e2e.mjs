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

async function playGame(title, reloadMidway) {
  const host = await newPhone(`${title}/host`), guest = await newPhone(`${title}/guest`);
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

  // "Готово" pressed by mistake is taken back with "Отменить".
  await host.click('[data-act="done"]');
  await host.locator('[data-act="undo"]').click({ timeout: 5000 });
  await sleep(300);
  if ((await host.locator('#deck h2').innerText()) !== myTitle) errors.push(`${title}: «Отменить» не вернул шаг`);

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
      for (const sel of ['button[data-act="done"]:not([disabled])', '[data-act="bgdone"]', '.opt']) {
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

let results;
try {
  results = await Promise.all(titles.map((t, i) => playGame(t, i === 0)));
} finally {
  await browser.close();
  await dev.close();
}
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.title}: игра ${r.code}, ${r.actions} нажатий, ${r.seconds} с${r.reloaded ? ', с перезагрузкой обоих телефонов' : ''}`);
if (errors.length) { console.log('Ошибки в консоли:\n' + [...new Set(errors)].slice(0, 20).join('\n')); }
process.exit(results.every(r => r.ok) && !errors.length ? 0 : 1);
