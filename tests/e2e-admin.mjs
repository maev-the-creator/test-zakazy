// Сквозные тесты админки (Playwright, демо-режим: данные в localStorage браузера).
//   NODE_PATH=$(npm root -g) node --test tests/e2e-admin.mjs
process.env.TZ = 'Europe/Moscow';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { startStaticServer } from '../tools/static-server.mjs';
import { forceDemo, FIXTURE_PHOTO } from './helpers/config-route.mjs';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(path.join(process.env.NODE_PATH || '/usr/lib/node_modules', 'playwright')); }
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SHOTS = process.env.SHOTS_DIR || path.join(ROOT, 'screenshots');

let server, browser, BASE;
before(async () => {
  if (process.env.E2E_URL) BASE = process.env.E2E_URL.replace(/\/?$/, '/');
  else { server = await startStaticServer({ port: 0 }); BASE = server.url; }
  browser = await pw.chromium.launch();
  fs.mkdirSync(SHOTS, { recursive: true });
});
after(async () => {
  await browser.close();
  if (server) await server.close();
});

async function open({ width = 390, height = 844, mobile = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, locale: 'ru-RU', timezoneId: 'Europe/Moscow', reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  await forceDemo(page);
  await page.goto(BASE + 'admin.html', { waitUntil: 'networkidle' });
  return { ctx, page, errors };
}

async function login(page, password = 'demo-admin') {
  await page.fill('#password', password);
  await page.click('#password-submit');
}

test('вход: неверный пароль — ошибка; верный — админка с вкладками', async () => {
  const { ctx, page, errors } = await open();
  assert.ok(await page.isVisible('#login'));
  assert.match(await page.textContent('#login-demo'), /demo-admin/);
  assert.equal(await page.getAttribute('meta[name=robots]', 'content'), 'noindex, nofollow');
  await login(page, 'wrong');
  await page.waitForSelector('#login-error:not([hidden])');
  assert.match(await page.textContent('#login-error'), /Неверный пароль/);
  await login(page);
  await page.waitForSelector('#app:not([hidden]) .item');
  assert.equal(await page.locator('.item').count(), 8);
  assert.match(await page.textContent('#pub-title'), /Всё опубликовано/);
  await page.screenshot({ path: path.join(SHOTS, 'admin-mobile-catalog.png'), fullPage: true });
  // остальные вкладки открываются без ошибок
  for (const tab of ['fillings', 'texts', 'days', 'orders', 'reception', 'access']) {
    await page.click(`[data-tab="${tab}"]`);
    await page.waitForSelector('#panel .adm__h2');
  }
  await page.click('[data-tab="days"]');
  await page.waitForSelector('.row');
  assert.ok(await page.locator('.row').count() >= 40);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('правка десерта с новым фото → «Опубликовать» → витрина показывает изменения', async () => {
  const { ctx, page, errors } = await open({ width: 1280, height: 900, mobile: false });
  await login(page);
  await page.waitForSelector('.item');
  // открыть редактор бенто
  await page.locator('.item').first().getByRole('button', { name: 'Изменить' }).click();
  await page.waitForSelector('.editor .preview .dish');
  await page.fill('.editor [data-field="name"] input', 'Бенто-торт «Облако»');
  await page.fill('.editor [data-field="priceMin"] input', '2100');
  await page.fill('.editor [data-field="priceMax"] input', '2700');
  // превью обновляется вживую
  await page.waitForFunction(() => document.querySelector('.editor .preview .dish__name').textContent.includes('Облако'));
  assert.match(await page.textContent('.editor .preview .price'), /от 2\s100 до 2\s700/);
  // новое фото + выбор кадра
  await page.setInputFiles('#photo-file', FIXTURE_PHOTO);
  await page.waitForSelector('.photo-edit__stage:not([hidden]) img');
  const stage = await page.locator('.photo-edit__stage').boundingBox();
  await page.mouse.click(stage.x + stage.width * 0.3, stage.y + stage.height * 0.4);
  await page.waitForFunction(() => document.querySelector('.editor .preview .dish__media img')?.src.startsWith('data:image/'));
  await page.screenshot({ path: path.join(SHOTS, 'admin-desktop-editor.png') });
  // ошибка: цена «до» меньше «от»
  await page.fill('.editor [data-field="priceMax"] input', '1000');
  await page.click('.editor__foot .btn--primary');
  await page.waitForSelector('.editor [data-field="priceMax"] .f__err:not(:empty)');
  await page.fill('.editor [data-field="priceMax"] input', '2700');
  await page.click('.editor__foot .btn--primary');
  await page.waitForSelector('.editor', { state: 'detached' });
  await page.waitForFunction(() => /Не опубликовано изменений: 1/.test(document.querySelector('#pub-title').textContent));
  assert.match(await page.textContent('.item:first-child .item__name'), /Облако/);
  assert.equal(await page.locator('.item:first-child .tag--draft').count(), 1, 'метка «новое фото»');

  // скрыть свадебный торт
  await page.locator('.item', { hasText: 'Свадебный' }).getByRole('button', { name: 'Изменить' }).click();
  await page.locator('.editor .switch').click();
  await page.click('.editor__foot .btn--primary');
  await page.waitForSelector('.editor', { state: 'detached' });

  // тексты
  await page.click('[data-tab="texts"]');
  await page.fill('[data-field="hero.titleLines"] textarea', 'Торты\nк вашему\nпразднику');
  await page.click('#panel .btn--primary');
  await page.waitForFunction(() => /Не опубликовано изменений: 3/.test(document.querySelector('#pub-title').textContent));

  // публикация
  await page.click('#publish');
  await page.waitForFunction(() => /Всё опубликовано/.test(document.querySelector('#pub-title').textContent), null, { timeout: 15000 });
  assert.match(await page.textContent('#pub-list'), /Версия 2/);

  // витрина в этом же браузере
  const shop = await ctx.newPage();
  await forceDemo(shop);
  await shop.goto(BASE, { waitUntil: 'networkidle' });
  assert.match(await shop.textContent('#hero-title'), /Торты\s*к\s*вашему\s*празднику/);
  const first = shop.locator('#catalog-grid .dish').first();
  assert.match(await first.locator('.dish__name').textContent(), /Облако/);
  assert.match(await first.locator('.price').textContent(), /от 2\s100 до 2\s700/);
  assert.match(await first.locator('img').getAttribute('src'), /^data:image\//, 'новое фото');
  assert.equal(await shop.locator('[data-dessert="wedding"]').count(), 0, 'скрытый десерт не показан');
  assert.equal(await shop.locator('#f-dessert option[value="wedding"]').count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('новый десерт без фото нельзя показать; скрытым — можно', async () => {
  const { ctx, page } = await open();
  await login(page);
  await page.waitForSelector('.item');
  await page.click('text=+ Добавить десерт');
  await page.fill('.editor [data-field="name"] input', 'Медовик');
  assert.equal(await page.inputValue('.editor [data-field="id"] input'), 'medovik', 'код из названия');
  await page.fill('.editor .tags-input input', 'Медовый крем');
  await page.keyboard.press('Enter');
  await page.fill('.editor [data-field="priceMin"] input', '3000');
  await page.fill('.editor [data-field="priceMax"] input', '4200');
  await page.click('.editor__foot .btn--primary');
  await page.waitForSelector('.editor [data-field="image"] .f__err:not(:empty)');
  assert.match(await page.textContent('.editor [data-field="image"] .f__err'), /Загрузите фото/);
  await page.locator('.editor .switch').click(); // скрыть
  await page.click('.editor__foot .btn--primary');
  await page.waitForSelector('.editor', { state: 'detached' });
  assert.equal(await page.locator('.item').count(), 9);
  assert.match(await page.textContent('.item:last-child'), /скрыт/);
  await ctx.close();
});

test('доступ, приём, даты: изменения применяются', async () => {
  const { ctx, page } = await open();
  await login(page);
  await page.waitForSelector('.item');
  await page.click('[data-tab="access"]');
  await page.fill('#panel input[type=email]', 'anna.helper@gmail.com');
  await page.click('#panel >> text=Добавить');
  await page.waitForSelector('text=anna.helper@gmail.com');
  await page.screenshot({ path: path.join(SHOTS, 'admin-mobile-access.png'), fullPage: true });
  await page.click('[data-tab="reception"]');
  await page.locator('#panel .switch').first().click();
  await page.fill('[data-field="pauseNote"] input', 'Отпуск до 20 ноября');
  await page.click('#panel .btn--primary');
  await page.waitForSelector('#toast.is-on');
  // витрина: приём остановлен
  const shop = await ctx.newPage();
  await forceDemo(shop);
  await shop.goto(BASE, { waitUntil: 'networkidle' });
  await shop.waitForSelector('#pause-banner:not([hidden])');
  assert.match(await shop.textContent('#pause-note'), /Отпуск до 20 ноября/);
  // выход
  await page.click('#logout');
  await page.waitForSelector('#login:not([hidden])');
  await ctx.close();
});

test('админка на 360px: нет горизонтального скролла', async () => {
  const { ctx, page } = await open({ width: 360, height: 740 });
  await login(page);
  await page.waitForSelector('.item');
  for (const tab of ['catalog', 'days', 'access']) {
    await page.click(`[data-tab="${tab}"]`);
    await page.waitForSelector('#panel .adm__h2');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(overflow, 0, tab);
  }
  await page.click('[data-tab="catalog"]');
  await page.locator('.item').first().getByRole('button', { name: 'Изменить' }).click();
  await page.waitForSelector('.editor .preview .dish');
  await page.screenshot({ path: path.join(SHOTS, 'admin-mobile-editor.png') });
  await ctx.close();
});

test('сервер со старым Code.gs (без админки): понятная подсказка вместо формы', async () => {
  // bypassCSP: локальный mock на другом порту CSP админки (правильно) не пускает.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, bypassCSP: true });
  const page = await ctx.newPage();
  const { startMockServer } = await import('../tools/mock-server.mjs');
  const mock = await startMockServer({ port: 0, quiet: true }); // mock знает только заявки — как старый сервер
  try {
    const { setApiUrl } = await import('./helpers/config-route.mjs');
    await setApiUrl(page, mock.url);
    await page.goto(BASE + 'admin.html', { waitUntil: 'networkidle' });
    await page.waitForSelector('#login-error:not([hidden])');
    assert.match(await page.textContent('#login-error'), /Сервер ещё не обновлён для админки/);
    assert.ok(await page.isHidden('#password-form'));
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('admin.html отдаётся с CSP и запретом встраивания в чужие сайты', async () => {
  if (process.env.E2E_URL && !process.env.E2E_URL.includes('vercel.app')) return;
  const res = await fetch(BASE + 'admin.html');
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self' https:\/\/accounts\.google\.com\/gsi\/client/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});
