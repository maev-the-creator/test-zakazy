// Сквозные тесты в браузере (Playwright, демо-режим).
//   NODE_PATH=$(npm root -g) node --test tests/e2e.mjs
// Можно прогнать против опубликованного сайта: E2E_URL=https://… node --test tests/e2e.mjs
process.env.TZ = 'Europe/Moscow';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startStaticServer } from '../tools/static-server.mjs';
import { setApiUrl, forceDemo, FIXTURE_CATALOG, FIXTURE_PHOTO } from './helpers/config-route.mjs';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(path.join(process.env.NODE_PATH || '/usr/lib/node_modules', 'playwright')); }

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
let server, browser, BASE;

before(async () => {
  if (process.env.E2E_URL) BASE = process.env.E2E_URL.replace(/\/?$/, '/');
  else { server = await startStaticServer({ port: 0 }); BASE = server.url; }
  browser = await pw.chromium.launch();
});
after(async () => {
  await browser.close();
  if (server) await server.close();
});

async function openPage({ width = 375, height = 812, query = '?demo=reset', mobile = true } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height }, isMobile: mobile, hasTouch: mobile, locale: 'ru-RU', timezoneId: 'Europe/Moscow',
    reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await forceDemo(page); // никогда не шлём тестовые заявки в реальную таблицу
  await page.goto(BASE + query, { waitUntil: 'networkidle' });
  await page.waitForSelector('#calendar .day');
  return { ctx, page, errors };
}

const dayLoc = (page, kind) => page.locator(`#calendar .day.day--${kind}`).first();

async function fillContact(page, { name = 'Анна', contact = '@anna_test', comment = 'Надпись «С днём рождения, мама»' } = {}) {
  await page.fill('#f-name', name);
  await page.fill('#f-contact', contact);
  if (comment) await page.fill('#f-comment', comment);
  await page.check('#f-consent', { force: true });
}

test('путь покупателя: «Выбрать» → начинка → дата → доставка → данные → фото → согласие → успех', async () => {
  const { ctx, page, errors } = await openPage();
  // Липкая панель скрыта до выбора десерта
  assert.equal(await page.locator('#action-bar').getAttribute('aria-hidden'), 'true');

  await page.click('[data-pick="bento"]');
  await page.waitForTimeout(500);
  assert.equal(await page.inputValue('#f-dessert'), 'bento', 'десерт подставлен в форму');
  assert.equal(await page.locator('[data-pick="bento"]').getAttribute('aria-pressed'), 'true');
  const scrolledTo = await page.evaluate(() => Math.abs(document.querySelector('#step-dessert').getBoundingClientRect().top) < 120);
  assert.ok(scrolledTo, 'страница прокрутилась к шагу 1 формы');
  assert.equal(await page.locator('#action-bar').getAttribute('aria-hidden'), 'false', 'появилась липкая панель');
  assert.match(await page.textContent('#bar-price'), /от 1\s900 до 2\s400\s₽/);
  assert.match(await page.textContent('.action-bar'), /точную стоимость назовёт кондитер/);
  assert.equal(await page.getAttribute('#submit-btn', 'aria-disabled'), 'true', 'кнопка неактивна, пока форма не заполнена');
  assert.match(await page.textContent('#calendar .cal__hint'), /Ближайшая дата для этого десерта: .+ \(заказывать за 2 дня\)/);

  await page.click('#filling-choices .chip:has-text("Фисташка-малина")');
  assert.match(await page.textContent('#filling-meta'), /фисташковый бисквит и малиновый конфи/);
  assert.match(await page.textContent('[data-dessert="bento"] .price'), /от 1\s900 до 2\s400\s₽/);
  const free = dayLoc(page, 'free');
  const date = await free.getAttribute('data-date');
  await free.click();
  assert.match(await page.textContent('.cal__status'), /: свободно$/);

  await page.click('.segmented__opt:has-text("Доставка")');
  assert.ok(await page.isVisible('#f-address'), 'появилось поле «Адрес»');
  await page.fill('#f-address', 'ул. Примерная, 5, кв. 12');
  await fillContact(page, { contact: '8 900 123 45 67' });
  await page.locator('#f-contact').blur();
  assert.equal(await page.inputValue('#f-contact'), '+7 900 123-45-67', 'телефон отформатирован');

  await page.setInputFiles('#f-photo', FIXTURE_PHOTO);
  await page.waitForSelector('#photo-preview:not([hidden])');
  assert.match(await page.textContent('#photo-size'), /^\d+×\d+, \d+/);

  assert.equal(await page.getAttribute('#submit-btn', 'aria-disabled'), 'false', 'кнопка активна');
  assert.equal((await page.textContent('#submit-label')).trim(), 'Отправить заявку');
  await page.click('#submit-btn');
  await page.waitForSelector('#success:not([hidden])', { timeout: 10000 });

  const title = await page.textContent('#success-title');
  assert.match(title, /^Заявка A-\d{4} отправлена$/);
  assert.ok(await page.locator('#success-title .nowrap').count(), 'номер заявки не разрывается');
  assert.match(await page.textContent('#success-text'), /Кондитер свяжется с вами, подтвердит дату и назовёт точную стоимость/);
  const summary = await page.textContent('#success-summary');
  assert.match(summary, /Бенто-торт «Пудра»/);
  assert.match(summary, /Фисташка-малина/);
  assert.match(summary, /Доставка\s— ул\. Примерная, 5, кв\. 12/);
  assert.match(summary, /Фотоприкреплено/);
  const body = await page.textContent('body');
  assert.doesNotMatch(body, /заказ\s+подтвержд/i);
  assert.equal(await page.locator('#action-bar').getAttribute('aria-hidden'), 'true', 'панель скрыта на экране успеха');

  const orders = await page.evaluate(() => JSON.parse(localStorage.getItem('orderforge-demo:REGALIA')).orders);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].date, date);
  assert.equal(orders[0].hasPhoto, true);
  assert.equal(orders[0].contact, '+7 900 123-45-67');

  // «Отправить ещё одну» — форма снова пустая (кроме имени и контакта)
  await page.click('#again');
  assert.ok(await page.isVisible('#order-form'));
  assert.equal(await page.inputValue('#f-dessert'), '');
  assert.equal(await page.inputValue('#f-name'), 'Анна');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('дата без мест → «Встать в лист ожидания» → экран листа ожидания', async () => {
  const { ctx, page, errors } = await openPage();
  await page.selectOption('#f-dessert', 'macarons');
  await page.click('#filling-choices .chip >> nth=0');
  const full = dayLoc(page, 'full');
  const date = await full.getAttribute('data-date');
  await full.click();
  assert.match(await page.textContent('.cal__status'), /мест нет\s— заявка попадёт в лист ожидания/);
  await page.click('.segmented__opt:has-text("Самовывоз")');
  assert.ok(!(await page.isVisible('#f-address')));
  await fillContact(page, { comment: '' });
  // На 375px подпись короче («В лист ожидания»), полное название — в aria-label
  assert.match((await page.textContent('#submit-label')).trim(), /^(Встать )?[Вв] лист ожидания$/);
  assert.equal(await page.getAttribute('#submit-btn', 'aria-label'), 'Встать в лист ожидания');
  await page.click('#submit-btn');
  await page.waitForSelector('#success:not([hidden])');
  const [, , d] = date.split('-').map(Number);
  assert.match(await page.textContent('#success-text'), new RegExp(`^Вы в листе ожидания на ${d} [а-я]+\\. Если место освободится, кондитер напишет вам\\.$`));
  const orders = await page.evaluate(() => JSON.parse(localStorage.getItem('orderforge-demo:REGALIA')).orders);
  assert.equal(orders[0].status, 'waitlist');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('последнее место заняли за секунду до отправки → лист ожидания с пояснением', async () => {
  const { ctx, page } = await openPage();
  await page.selectOption('#f-dessert', 'bento');
  await page.click('#filling-choices .chip >> nth=0');
  const few = dayLoc(page, 'few'); // в демо — 1 свободное место из 4
  const date = await few.getAttribute('data-date');
  await few.click();
  await page.click('.segmented__opt:has-text("Самовывоз")');
  await fillContact(page, { comment: '' });
  // Другой покупатель занимает последнее место (тот же «сервер» — localStorage)
  await page.evaluate(async (d) => {
    const { createMockBackend, localStorageStorage } = await import('./js/mock-backend.js');
    const other = createMockBackend({ storage: localStorageStorage('orderforge-demo:REGALIA') });
    const r = await other.submit({ dessertId: 'cupcakes', filling: 'Ваниль', date: d, pickup: 'pickup', name: 'Борис', contact: '@boris_b', consent: true });
    if (r.status !== 'new') throw new Error('ожидалась «Новая»: ' + JSON.stringify(r));
  }, date);
  await page.click('#submit-btn');
  await page.waitForSelector('#success:not([hidden])');
  assert.match(await page.textContent('#success-text'), /последнее место на эту дату заняли\. Вы в листе ожидания/);
  await ctx.close();
});

test('режим «приём остановлен»: баннер с заметкой, форма заблокирована, каталог виден', async () => {
  const { ctx, page, errors } = await openPage({ query: '?demo=paused' });
  assert.ok(await page.isVisible('#pause-banner'));
  assert.match(await page.textContent('#pause-banner'), /Приём заявок временно остановлен/);
  assert.match(await page.textContent('#pause-note'), /в отпуске до 20 ноября/);
  assert.ok(await page.locator('#order-fieldset').evaluate((f) => f.disabled), 'форма заблокирована');
  assert.equal(await page.locator('#catalog-grid .dish').count(), 8, 'каталог виден');
  assert.ok(await page.isVisible('#order-paused'), 'сообщение о паузе в начале формы');
  assert.match(await page.textContent('#order-paused'), /в отпуске до 20 ноября/);
  assert.equal((await page.textContent('[data-pick="cheesecake"]')).trim(), 'Приём на паузе');
  await page.click('[data-pick="cheesecake"]', { force: true });
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#action-bar').getAttribute('aria-hidden'), 'true', 'панель отправки не показывается');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('ошибки валидации: подсветка первого незаполненного, понятные тексты', async () => {
  const { ctx, page } = await openPage();
  await page.selectOption('#f-dessert', 'birthday');
  // Кнопка неактивна (aria-disabled), но нажатие подсвечивает первое незаполненное — начинку.
  // force: Playwright не кликает по aria-disabled, а живой пользователь — может.
  await page.click('#submit-btn', { force: true });
  await page.waitForTimeout(500);
  assert.match(await page.textContent('#err-filling'), /Выберите начинку/);
  assert.ok(await page.locator('#step-filling').evaluate((el) => el.classList.contains('is-invalid')));
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.name);
  assert.equal(focused, 'filling', 'фокус на первом незаполненном');
  assert.match(await page.textContent('#err-date'), /Выберите дату/);
  assert.match(await page.textContent('#err-consent'), /согласие/);

  // Неверный контакт
  await page.fill('#f-contact', '12345');
  await page.locator('#f-contact').blur();
  assert.match(await page.textContent('#err-contact'), /\+7 900 000-00-00 или ник Telegram/);
  await page.fill('#f-contact', '@anna_test');
  await page.waitForTimeout(100);
  assert.equal(await page.textContent('#err-contact'), '');

  // Доставка без адреса
  await page.click('.segmented__opt:has-text("Доставка")');
  await page.click('#submit-btn', { force: true });
  await page.waitForTimeout(300);
  assert.match(await page.textContent('#err-address'), /адрес/i);

  // Ранние даты недоступны: торт «Праздник» — за 3 дня
  const offs = await page.locator('#calendar .day--off').evaluateAll((els) => els.map((e) => e.dataset.date));
  const today = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date()));
  const plus = (n) => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  for (const n of [0, 1, 2]) {
    if (plus(n).slice(0, 7) === today.slice(0, 7)) assert.ok(offs.includes(plus(n)), `сегодня+${n} недоступно`);
  }
  // Клик по недоступному дню не выбирает его и объясняет причину
  if (plus(1).slice(0, 7) === today.slice(0, 7)) {
    await page.locator(`#calendar [data-date="${plus(1)}"]`).click({ force: true });
    assert.equal(await page.locator('#calendar .day.is-selected').count(), 0);
    assert.match(await page.textContent('.cal__status'), /недоступно\s— раньше срока: заказывать за 3 дня/);
  }
  await ctx.close();
});

test('смена десерта сбрасывает слишком раннюю дату', async () => {
  const { ctx, page } = await openPage();
  await page.selectOption('#f-dessert', 'bento');
  const first = page.locator('#calendar .day:not(.day--off):not(.day--full)').first();
  const date = await first.getAttribute('data-date');
  await first.click();
  await page.selectOption('#f-dessert', 'wedding'); // 14 дней
  assert.match(await page.textContent('#err-date'), /слишком рано для этого десерта/);
  assert.equal(await page.locator(`#calendar .day.is-selected`).count(), 0);
  assert.ok(date);
  await ctx.close();
});

test('календарь управляется с клавиатуры', async () => {
  const { ctx, page } = await openPage({ width: 1280, height: 900, mobile: false });
  await page.selectOption('#f-dessert', 'bento');
  const start = page.locator('#calendar .day[tabindex="0"]');
  await start.focus();
  const d0 = await start.getAttribute('data-date');
  await page.keyboard.press('ArrowRight');
  const d1 = await page.evaluate(() => document.activeElement.dataset.date);
  const next = new Date(d0 + 'T00:00:00Z'); next.setUTCDate(next.getUTCDate() + 1);
  assert.equal(d1, next.toISOString().slice(0, 10));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const sel = await page.locator('#calendar .day.is-selected').getAttribute('data-date');
  assert.equal(sel, await page.evaluate(() => document.activeElement.dataset.date));
  await page.keyboard.press('PageDown');
  assert.ok(await page.evaluate(() => document.activeElement.classList.contains('day')), 'PageDown переключает месяц');
  await ctx.close();
});

test('нет горизонтального скролла на 360, 375, 768, 1440; поля ввода ≥ 16px; тап-зоны ≥ 44px', async () => {
  for (const width of [360, 375, 768, 1440]) {
    const { ctx, page } = await openPage({ width, height: 800, mobile: width < 768 });
    await page.click('[data-pick="wedding"]');
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(overflow, 0, `горизонтальный скролл на ${width}px`);
    const small = await page.evaluate(() => Array.from(document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=file]), select, textarea'))
      .filter((el) => el.offsetParent && parseFloat(getComputedStyle(el).fontSize) < 16).map((el) => el.id));
    assert.deepEqual(small, [], 'поля с шрифтом < 16px');
    if (width < 768) {
      const tiny = await page.evaluate(() => Array.from(document.querySelectorAll('button, .btn, .social__link, .chip span, .segmented__opt span, .photo__pick, .site-footer a, .day'))
        .filter((el) => { const r = el.getBoundingClientRect(); return el.offsetParent && (r.height < 44 || r.width < 44); })
        .map((el) => (el.id || el.className) + ':' + Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height)));
      assert.deepEqual(tiny, [], 'тап-зоны меньше 44×44px');
    }
    await ctx.close();
  }
});

test('в подвале есть вход для кондитерской → admin.html', async () => {
  const { ctx, page } = await openPage();
  const link = page.locator('.site-footer__admin');
  assert.equal(await link.getAttribute('href'), 'admin.html');
  assert.equal((await link.textContent()).trim(), 'Вход для кондитерской');
  await link.click();
  await page.waitForURL(/admin\.html$/);
  await ctx.close();
});

test('шрифты: кириллица и «₽» набираются нужными гарнитурами', async () => {
  const { ctx, page } = await openPage({ width: 1440, height: 900, mobile: false });
  await page.evaluate(() => document.fonts.ready);
  const fams = await page.evaluate(() => ({
    h1: getComputedStyle(document.querySelector('.hero__title')).fontFamily,
    logo: getComputedStyle(document.querySelector('.brand__logo')).fontFamily,
    price: getComputedStyle(document.querySelector('.price')).fontFamily,
    loaded: Array.from(document.fonts).filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')),
    // «₽» реально есть в Golos Text: ширина отличается от системного запасного шрифта
    rub: (() => {
      const c = document.createElement('canvas').getContext('2d');
      c.font = '40px "Golos Text", monospace'; const a = c.measureText('₽').width;
      c.font = '40px monospace'; const b = c.measureText('₽').width;
      return a !== b;
    })(),
  }));
  assert.match(fams.h1, /Unbounded/);
  assert.match(fams.logo, /Unbounded/);
  assert.match(fams.price, /Golos Text/);
  for (const f of ['Unbounded', 'Golos Text']) assert.ok(fams.loaded.includes(f), `шрифт ${f} загружен`);
  assert.ok(fams.rub, 'знак ₽ из Golos Text');
  await ctx.close();
});

// ---------- «Живой» режим: настоящий fetch к API с контрактом Apps Script ----------
import { startMockServer } from '../tools/mock-server.mjs';

async function openWithApi(apiUrl, { width = 375, height = 812 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, locale: 'ru-RU', timezoneId: 'Europe/Moscow', reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await setApiUrl(page, apiUrl);
  const requests = [];
  page.on('request', (r) => { if (r.url().startsWith(apiUrl.replace(/\/$/, ''))) requests.push({ method: r.method(), type: r.headers()['content-type'] || '' }); });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  return { ctx, page, requests };
}

test('живой режим: даты и заявка идут через API (GET availability, POST text/plain без preflight)', async () => {
  const mock = await startMockServer({ port: 0, limit: 2, seed: false, latencyMs: 30, quiet: true, catalog: FIXTURE_CATALOG });
  try {
    const { ctx, page, requests } = await openWithApi(mock.url);
    await page.waitForSelector('#calendar .day');
    assert.ok(await page.locator('#demo-badge').isHidden(), 'метки «демо-режим» нет');
    await page.selectOption('#f-dessert', 'cheesecake');
    await page.click('#filling-choices .chip >> nth=1');
    await page.locator('#calendar .day.day--free').first().click();
    await page.click('.segmented__opt:has-text("Самовывоз")');
    await fillContact(page, { contact: '+7 (999) 111-22-33' });
    await page.click('#submit-btn');
    await page.waitForSelector('#success:not([hidden])');
    assert.match(await page.textContent('#success-title'), /Заявка A-0001 отправлена/);
    const orders = await (await fetch(mock.url + '?action=orders')).json();
    assert.equal(orders.orders.length, 1);
    assert.equal(orders.orders[0].filling, 'Солёная карамель');
    assert.ok(requests.some((r) => r.method === 'GET'), 'GET availability');
    const post = requests.find((r) => r.method === 'POST');
    assert.ok(post, 'POST заявки');
    assert.match(post.type, /^text\/plain/);
    assert.ok(!requests.some((r) => r.method === 'OPTIONS'), 'нет CORS-preflight');
    await ctx.close();
  } finally {
    await mock.close();
  }
});

test('ошибка загрузки дат: понятное сообщение и «Повторить»', async () => {
  const { ctx, page } = await openWithApi('http://127.0.0.1:9/');
  await page.waitForSelector('#calendar .cal__error', { timeout: 15000 });
  assert.match(await page.textContent('#calendar .cal__error'), /Нет связи с сервером|Не удалось/);
  assert.ok(await page.isVisible('#calendar .cal__error button:has-text("Повторить")'));
  await page.click('#calendar .cal__error button');
  await page.waitForSelector('#calendar .cal__error', { timeout: 15000 });
  await ctx.close();
});

test('«Выбрать» в каталоге после отправленной заявки начинает новую', async () => {
  const { ctx, page } = await openPage();
  await page.selectOption('#f-dessert', 'macarons');
  await page.click('#filling-choices .chip >> nth=0');
  await page.locator('#calendar .day.day--free').first().click();
  await page.click('.segmented__opt:has-text("Самовывоз")');
  await fillContact(page, { comment: '' });
  await page.click('#submit-btn');
  await page.waitForSelector('#success:not([hidden])');
  await page.click('[data-pick="kids"]');
  await page.waitForTimeout(400);
  assert.ok(await page.isVisible('#order-form'), 'форма снова видна');
  assert.ok(await page.isHidden('#success'));
  assert.equal(await page.inputValue('#f-dessert'), 'kids');
  assert.equal(await page.locator('#action-bar').getAttribute('aria-hidden'), 'false');
  await ctx.close();
});

// ---------- Тексты не вылезают из своих блоков (Unbounded широкий; контент клиентов любой) ----------
import { DEMO_CATALOG_KEY } from '../js/api.js';

const OVERFLOW_SELECTORS = '.fact__value, .dish__name, .menu__name, .section-title, h1, h2';

async function textOverflows({ width, catalog }) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ru-RU', timezoneId: 'Europe/Moscow', reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  if (catalog) await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [DEMO_CATALOG_KEY, JSON.stringify(catalog)]);
  await forceDemo(page);
  await page.goto(BASE + '?demo=reset', { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const bad = await page.evaluate((sel) => Array.from(document.querySelectorAll(sel))
    .filter((el) => el.offsetParent && el.scrollWidth > el.clientWidth + 1)
    .map((el) => `${el.className || el.tagName}: «${el.textContent.trim().slice(0, 40)}» ${el.scrollWidth}>${el.clientWidth}`), OVERFLOW_SELECTORS);
  const facts = await page.locator('.fact__value').allTextContents();
  await ctx.close();
  return { bad, facts };
}

test('цифры «О кондитерской» и заголовки помещаются в свои блоки на 360–1920 px', async () => {
  for (const width of [360, 768, 1280, 1920]) {
    const { bad, facts } = await textOverflows({ width });
    assert.equal(facts.length, 3, 'три цифры');
    assert.deepEqual(bad, [], `ширина ${width}px`);
  }
});

test('длинные цифры клиента («10 000+», «с 2015», «4,9») тоже помещаются', async () => {
  const catalog = structuredClone(FIXTURE_CATALOG);
  catalog.about.stats = [
    { prefix: 'с ', value: 2015, suffix: '', label: 'года печём', format: 'year' },
    { prefix: '', value: 10000, suffix: '+', label: 'тортов' },
    { prefix: '', value: 4.9, suffix: '', label: 'оценка', decimals: 1 },
  ];
  catalog.desserts[0].name = 'Индивидуальный свадебный торт по эскизу';
  for (const width of [360, 1280, 1920]) {
    const { bad, facts } = await textOverflows({ width, catalog });
    assert.deepEqual(facts.map((t) => t.replace(/\s/g, ' ')), ['с 2015', '10 000+', '4,9']);
    assert.deepEqual(bad, [], `ширина ${width}px`);
  }
});

test('без цифр блок цифр скрыт, страница работает', async () => {
  const catalog = structuredClone(FIXTURE_CATALOG);
  delete catalog.about.stats;
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, locale: 'ru-RU', timezoneId: 'Europe/Moscow', reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [DEMO_CATALOG_KEY, JSON.stringify(catalog)]);
  await forceDemo(page);
  await page.goto(BASE + '?demo=reset', { waitUntil: 'networkidle' });
  await page.waitForSelector('#calendar .day');
  assert.ok(await page.locator('#about-facts').isHidden(), 'пустой блок цифр скрыт');
  assert.deepEqual(errors, []);
  await ctx.close();
});

// ---------- Боевой режим: реальный Apps Script из config.js (только чтение, заявки не шлём) ----------
import { CONFIG } from '../config.js';

test('боевой режим: даты грузятся из Google-таблицы, метки «демо-режим» нет', { skip: !CONFIG.APPS_SCRIPT_URL && 'APPS_SCRIPT_URL пуст' }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, locale: 'ru-RU', timezoneId: 'Europe/Moscow', reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const apiCalls = [];
  page.on('response', (r) => { if (r.url().includes('script.google')) apiCalls.push(r.status()); });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#calendar .day', { timeout: 45000 });
  assert.ok(await page.locator('#demo-badge').isHidden(), 'метки «демо-режим» нет');
  assert.ok(apiCalls.length > 0, 'был запрос к Apps Script');
  assert.ok(await page.locator('#calendar .day:not(.day--off)').count() > 0, 'есть доступные дни');
  assert.deepEqual(errors, []);
  await ctx.close();
});
