// Скриншоты страницы и ключевых состояний (демо-режим) в screenshots/.
//   node tests/screens.mjs [--out screenshots] [--url http://...]
// Без --url поднимает локальный статический сервер.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { startStaticServer } from '../tools/static-server.mjs';
import { forceDemo } from './helpers/config-route.mjs';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(path.join(process.env.NODE_PATH || '/usr/lib/node_modules', 'playwright')); }
const { chromium } = playwright;

const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(val('--out', 'screenshots'));
fs.mkdirSync(OUT, { recursive: true });

const server = val('--url') ? null : await startStaticServer({ port: 0 });
const BASE = val('--url', server && server.url);

const VIEWPORTS = [
  { name: 'mobile-375', width: 375, height: 812, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'tablet-768', width: 768, height: 1024, deviceScaleFactor: 1 },
  { name: 'desktop-1440', width: 1440, height: 900, deviceScaleFactor: 1 },
];

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    document.documentElement.classList.add('is-loaded');
    document.querySelectorAll('.reveal').forEach((el) => el.classList.add('is-in'));
  });
  // Прокрутка, чтобы подгрузились lazy-картинки и досчитали счётчики
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
    await Promise.all(Array.from(document.images).map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
    await new Promise((r) => setTimeout(r, 1400));
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
}

const browser = await chromium.launch();
const report = [];
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.deviceScaleFactor, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await forceDemo(page, { fixtures: false }); // скриншоты этого сайта, без заявок в реальную таблицу
  await page.goto(BASE + '?demo=reset', { waitUntil: 'networkidle' });
  await settle(page);
  await page.screenshot({ path: path.join(OUT, `${vp.name}-full.png`), fullPage: true });
  await page.screenshot({ path: path.join(OUT, `${vp.name}-first-screen.png`) });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  // Состояние: выбран десерт → календарь и липкая панель
  await page.click('[data-pick="bento"]');
  await page.waitForTimeout(900);
  await page.click('#filling-choices .chip >> nth=2');
  const day = page.locator('#calendar .day.day--few:not(.day--off)').first();
  if (await day.count()) await day.click();
  await page.waitForTimeout(600);
  await page.locator('#step-date').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -40));
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `${vp.name}-calendar.png`) });

  // Каталог
  await page.locator('#catalog').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, document.querySelector('#catalog').offsetTop));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, `${vp.name}-catalog.png`) });

  // Дата без мест → лист ожидания, липкая панель
  const full = page.locator('#calendar .day.day--full').first();
  if (await full.count()) {
    await full.click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, `${vp.name}-waitlist.png`) });
  }

  // Экран успеха
  await page.locator('#calendar .day.day--free').first().click();
  await page.click('.segmented__opt:has-text("Самовывоз")');
  await page.fill('#f-name', 'Анна');
  await page.fill('#f-contact', '@anna_test');
  await page.check('#f-consent', { force: true });
  await page.click('#submit-btn');
  await page.waitForSelector('#success:not([hidden])');
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, `${vp.name}-success.png`) });

  report.push({ viewport: vp.name, horizontalOverflowPx: overflow, errors });
  await ctx.close();
}

// Состояние «приём остановлен» и экран успеха — на мобильном
{
  const vp = VIEWPORTS[0];
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
  const page = await ctx.newPage();
  await forceDemo(page, { fixtures: false });
  await page.goto(BASE + '?demo=paused', { waitUntil: 'networkidle' });
  await settle(page);
  await page.locator('#pause-banner').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -120));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'mobile-375-paused.png') });
  await page.click('[data-pick="bento"]', { force: true });
  await page.evaluate(() => window.scrollTo(0, document.querySelector('#order').offsetTop));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'mobile-375-paused-form.png') });
  await ctx.close();
}

await browser.close();
if (server) await server.close();
console.log(JSON.stringify(report, null, 2));
