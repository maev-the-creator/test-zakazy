// Юнит-тесты логики apps-script/Code.gs (загружается в Node с заглушками Google).
// Запуск: npm test
process.env.TZ = 'Europe/Moscow';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadGas, parseOut, msk, ROOT } from './helpers/gas.mjs';

const gas = loadGas();
const L = (name) => gas.get(name);
const settings = (over = {}) => L('normalizeSettings')(over);

// ---------- Статусы дат ----------

test('статусы: free / few / full / closed при лимите 4 и пороге 25%', () => {
  const s = settings({ defaultLimit: 4, fewPercent: 25 });
  const st = (accepted, extra = {}) => L('computeDayStatus')({ accepted, ...extra }, s).status;
  assert.equal(st(0), 'free');
  assert.equal(st(2), 'free'); // осталось 2 из 4 = 50%
  assert.equal(st(3), 'few'); // осталось 1 = 25%
  assert.equal(st(4), 'full');
  assert.equal(st(7), 'full'); // перебор (владелец вручную перевёл из ожидания)
  assert.equal(st(0, { closed: 'да' }), 'closed');
  assert.equal(st(0, { limit: 0 }), 'closed');
});

test('порог «мало мест»: 25%, но не меньше одного места', () => {
  const s25 = settings({ fewPercent: 25 });
  const st = (limit, accepted) => L('computeDayStatus')({ limit, accepted }, s25);
  // лимит 10: 25% = 2.5 → «мало», когда осталось 2 или 1
  assert.equal(st(10, 7).status, 'free'); // осталось 3
  assert.equal(st(10, 8).status, 'few'); // осталось 2
  assert.equal(st(10, 9).status, 'few'); // осталось 1
  // лимит 2: 25% = 0.5, но минимум одно место → «мало» при 1 свободном
  assert.equal(st(2, 0).status, 'free');
  assert.equal(st(2, 1).status, 'few');
  // лимит 1: единственное место — всегда «мало»
  assert.equal(st(1, 0).status, 'few');
  // порог 0% — всё равно последнее место «мало»
  const s0 = settings({ fewPercent: 0 });
  assert.equal(L('computeDayStatus')({ limit: 5, accepted: 4 }, s0).status, 'few');
  assert.equal(L('computeDayStatus')({ limit: 5, accepted: 3 }, s0).status, 'free');
  // left и limit в ответе
  assert.deepEqual({ ...st(10, 8) }, { status: 'few', limit: 10, accepted: 8, left: 2 });
});

test('лимит 0 = закрыто; «Закрыть дату = да» = закрыто; пусто = по умолчанию', () => {
  const s = settings({ defaultLimit: 6 });
  const eff = (day) => L('effectiveLimit')(day, s);
  assert.equal(eff({ limit: 0 }), 0);
  assert.equal(eff({ limit: '0' }), 0);
  assert.equal(eff({ limit: '' }), 6);
  assert.equal(eff({}), 6);
  assert.equal(eff({ limit: 3 }), 3);
  assert.equal(eff({ limit: 3, closed: 'да' }), 0);
  assert.equal(eff({ limit: 3, closed: 'Да' }), 0);
  assert.equal(eff({ limit: 3, closed: 'нет' }), 3);
  assert.equal(eff({ limit: 3, closed: true }), 0);
  assert.equal(L('computeDayStatus')({ limit: 3, closed: 'да', accepted: 0 }, s).status, 'closed');
});

test('настройки: значения по умолчанию и границы', () => {
  const d = settings({});
  assert.equal(d.acceptingOrders, true);
  assert.equal(d.defaultLimit, 4);
  assert.equal(d.daysAhead, 45);
  assert.equal(d.fewPercent, 25);
  assert.equal(d.bakeryName, 'Кондитерская'); // нейтрально: название задаёт свойство BAKERY_NAME
  assert.equal(settings({ daysAhead: 500 }).daysAhead, 180);
  assert.equal(settings({ daysAhead: 0 }).daysAhead, 1);
  assert.equal(settings({ acceptingOrders: 'нет' }).acceptingOrders, false);
  assert.equal(settings({ acceptingOrders: 'Да' }).acceptingOrders, true);
  assert.equal(settings({ fewPercent: '30,5' }).fewPercent, 30.5);
});

// ---------- Даты и Москва ----------

test('сегодня по Москве: переход через полночь', () => {
  const today = L('moscowToday');
  // 31 октября 20:59 UTC = 23:59 МСК → ещё 31-е
  assert.equal(today(Date.UTC(2026, 9, 31, 20, 59)), '2026-10-31');
  // 31 октября 21:00 UTC = 00:00 МСК 1 ноября → уже 1-е
  assert.equal(today(Date.UTC(2026, 9, 31, 21, 0)), '2026-11-01');
  // Новый год
  assert.equal(today(Date.UTC(2026, 11, 31, 21, 30)), '2027-01-01');
});

test('арифметика дат: конец месяца, год, високосный', () => {
  const add = L('addDays');
  assert.equal(add('2026-10-30', 2), '2026-11-01');
  assert.equal(add('2026-12-30', 3), '2027-01-02');
  assert.equal(add('2028-02-28', 1), '2028-02-29');
  assert.equal(add('2027-02-28', 1), '2027-03-01');
  assert.equal(L('diffDays')('2026-11-01', '2026-11-15'), 14);
  assert.equal(L('weekdayIndex')('2026-11-02'), 0); // понедельник
  assert.equal(L('weekdayIndex')('2026-11-01'), 6); // воскресенье
  assert.equal(L('formatDateLong')('2026-11-14'), 'суббота, 14 ноября 2026');
  assert.equal(L('isValidYmd')('2026-02-30'), false);
  assert.equal(L('isValidYmd')('2026-11-15'), true);
  assert.equal(L('daysWord')(2), '2 дня');
  assert.equal(L('daysWord')(14), '14 дней');
  assert.equal(L('daysWord')(21), '21 день');
});

// ---------- Сроки заказа по каждому десерту ----------

const CATALOG = JSON.parse(fs.readFileSync(ROOT + '/tests/fixtures/catalog.json', 'utf8'));
const DESSERTS = CATALOG.desserts;
const baseOrder = (over = {}) => ({
  dessertId: 'bento',
  filling: 'Ваниль-клубника',
  date: '2026-11-10',
  pickup: 'pickup',
  name: 'Анна',
  contact: '@anna_test',
  consent: true,
  website: '',
  ...over,
});
const firstFilling = (id) => DESSERTS.find((d) => d.id === id).fillings[0];

test('срок заказа для каждого десерта относительно «сегодня» по Москве', () => {
  const s = settings({});
  for (const d of DESSERTS) {
    for (const nowMs of [msk('2026-11-01', 0, 1), msk('2026-11-01', 23, 59)]) {
      const today = L('moscowToday')(nowMs);
      assert.equal(today, '2026-11-01');
      const ok = L('decideOrder')(
        { dessertId: d.id, date: L('addDays')(today, d.leadDays) },
        { settings: s, today, desserts: DESSERTS, day: { accepted: 0 } }
      );
      assert.equal(ok.ok, true, `${d.id}: дата через ${d.leadDays} дн. должна приниматься`);
      const early = L('decideOrder')(
        { dessertId: d.id, date: L('addDays')(today, d.leadDays - 1) },
        { settings: s, today, desserts: DESSERTS, day: { accepted: 0 } }
      );
      assert.equal(early.ok, false, `${d.id}: на день раньше срока — отказ`);
      assert.equal(early.code, 'too_early');
    }
  }
});

test('срок заказа: в 23:59 и 00:00 по Москве ближайшая дата сдвигается', () => {
  const s = settings({});
  // 31 октября 23:59 МСК: бенто (2 дня) можно на 2 ноября
  let today = L('moscowToday')(msk('2026-10-31', 23, 59));
  assert.equal(L('decideOrder')({ dessertId: 'bento', date: '2026-11-02' }, { settings: s, today, desserts: DESSERTS, day: {} }).ok, true);
  // через минуту — уже 1 ноября, 2 ноября слишком рано
  today = L('moscowToday')(msk('2026-10-31', 23, 59) + 60_000);
  assert.equal(today, '2026-11-01');
  assert.equal(L('decideOrder')({ dessertId: 'bento', date: '2026-11-02' }, { settings: s, today, desserts: DESSERTS, day: {} }).code, 'too_early');
  // конец месяца: 29 ноября + 3 дня (торт «Праздник») = 2 декабря
  today = '2026-11-29';
  assert.equal(L('earliestDateFor')(L('findDessert')('birthday', DESSERTS), today), '2026-12-02');
  assert.equal(L('decideOrder')({ dessertId: 'birthday', date: '2026-12-01' }, { settings: s, today, desserts: DESSERTS, day: {} }).code, 'too_early');
  assert.equal(L('decideOrder')({ dessertId: 'birthday', date: '2026-12-02' }, { settings: s, today, desserts: DESSERTS, day: {} }).ok, true);
});

test('окно daysAhead: последний день окна принимается, следующий — нет, прошлое — нет', () => {
  const s = settings({ daysAhead: 10 });
  const today = '2026-11-01';
  const dec = (date) => L('decideOrder')({ dessertId: 'bento', date }, { settings: s, today, desserts: DESSERTS, day: {} });
  assert.equal(dec('2026-11-10').ok, true); // сегодня + 9 = последний день окна
  assert.equal(dec('2026-11-11').code, 'out_of_window');
  assert.equal(dec('2026-10-31').code, 'out_of_window');
  const av = L('buildAvailability')({ settings: s, today, days: {}, counts: {} });
  assert.equal(av.dates.length, 10);
  assert.equal(av.dates[0].date, '2026-11-01');
  assert.equal(av.dates[9].date, '2026-11-10');
  // свадебный торт (14 дней) в окне 10 дней — недоступен
  assert.equal(L('decideOrder')({ dessertId: 'wedding', date: '2026-11-10' }, { settings: s, today, desserts: DESSERTS, day: {} }).code, 'too_early');
});

test('остановка приёма: любая заявка отклоняется с заметкой', () => {
  const s = settings({ acceptingOrders: 'нет', pauseNote: 'Мы в отпуске до 20 ноября' });
  const r = L('decideOrder')({ dessertId: 'bento', date: '2026-11-10' }, { settings: s, today: '2026-11-01', desserts: DESSERTS, day: {} });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'paused');
  assert.match(r.message, /отпуске до 20 ноября/);
  const av = L('buildAvailability')({ settings: s, today: '2026-11-01', days: {}, counts: {} });
  assert.equal(av.acceptingOrders, false);
  assert.equal(av.pauseNote, 'Мы в отпуске до 20 ноября');
});

test('закрытая дата отклоняется, полная — уходит в лист ожидания', () => {
  const s = settings({ defaultLimit: 3 });
  const today = '2026-11-01';
  const dec = (day) => L('decideOrder')({ dessertId: 'bento', date: '2026-11-10' }, { settings: s, today, desserts: DESSERTS, day });
  assert.equal(dec({ closed: 'да' }).code, 'closed');
  assert.equal(dec({ limit: 0 }).code, 'closed');
  assert.equal(dec({ accepted: 2 }).status, 'new');
  assert.equal(dec({ accepted: 3 }).status, 'waitlist');
  assert.equal(dec({ accepted: 5 }).status, 'waitlist');
});

// ---------- Валидация ----------

test('контакты: телефоны +7/8 и ники Telegram', () => {
  const nc = L('normalizeContact');
  assert.deepEqual({ ...nc('+7 900 123-45-67') }, { ok: true, kind: 'phone', value: '+7 900 123-45-67' });
  assert.equal(nc('89001234567').value, '+7 900 123-45-67');
  assert.equal(nc('8 (900) 123 45 67').value, '+7 900 123-45-67');
  assert.equal(nc('+79001234567').ok, true);
  assert.equal(nc('@anna').ok, true);
  assert.equal(nc('@anna_cakes_2026').ok, true);
  assert.equal(nc('https://t.me/anna_cakes').value, '@anna_cakes');
  assert.equal(nc('t.me/anna_cakes').value, '@anna_cakes');
  for (const bad of ['', '900 123 45 67', '+1 555 123 4567', '+7 900 123', '7900123456', '@ab', '@анна', '@anna cakes', 'anna', '+7 900 123-45-678']) {
    assert.equal(nc(bad).ok, false, `должен отклонить: «${bad}»`);
  }
});

test('валидация: корректная заявка проходит и нормализуется', () => {
  const v = L('validateOrder')(baseOrder({ contact: '8 900 123 45 67', name: '  Анна  ', comment: 'Надпись «С днём рождения, мама»' }), DESSERTS);
  assert.equal(v.ok, true);
  assert.equal(v.order.name, 'Анна');
  assert.equal(v.order.contact, '+7 900 123-45-67');
  assert.equal(v.order.address, '');
});

test('валидация: обязательные поля и понятные ошибки', () => {
  const v = L('validateOrder')({ consent: false }, DESSERTS);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'validation');
  for (const f of ['dessertId', 'filling', 'date', 'pickup', 'name', 'contact', 'consent']) {
    assert.ok(v.errors[f], `нет ошибки для поля ${f}`);
  }
  assert.equal(L('validateOrder')(null, DESSERTS).code, 'bad_request');
});

test('валидация: начинка должна быть у выбранного десерта, десерт должен существовать', () => {
  assert.ok(L('validateOrder')(baseOrder({ filling: 'Солёная карамель' }), DESSERTS).errors.filling); // у бенто нет
  assert.ok(L('validateOrder')(baseOrder({ dessertId: 'pizza' }), DESSERTS).errors.dessertId);
  for (const d of DESSERTS) {
    for (const f of d.fillings) {
      assert.equal(L('validateOrder')(baseOrder({ dessertId: d.id, filling: f }), DESSERTS).ok, true, `${d.id} / ${f}`);
    }
  }
});

test('валидация: доставка требует адрес, длины полей ограничены', () => {
  assert.ok(L('validateOrder')(baseOrder({ pickup: 'delivery', address: '' }), DESSERTS).errors.address);
  assert.equal(L('validateOrder')(baseOrder({ pickup: 'delivery', address: 'ул. Примерная, 5' }), DESSERTS).ok, true);
  assert.ok(L('validateOrder')(baseOrder({ name: 'А' }), DESSERTS).errors.name);
  assert.ok(L('validateOrder')(baseOrder({ name: 'А'.repeat(61) }), DESSERTS).errors.name);
  assert.ok(L('validateOrder')(baseOrder({ comment: 'x'.repeat(501) }), DESSERTS).errors.comment);
  assert.equal(L('validateOrder')(baseOrder({ comment: 'x'.repeat(500) }), DESSERTS).ok, true);
  assert.ok(L('validateOrder')(baseOrder({ pickup: 'teleport' }), DESSERTS).errors.pickup);
  assert.ok(L('validateOrder')(baseOrder({ date: '2026-13-01' }), DESSERTS).errors.date);
});

test('валидация: согласие должно быть именно true', () => {
  assert.ok(L('validateOrder')(baseOrder({ consent: 'true' }), DESSERTS).errors.consent);
  assert.ok(L('validateOrder')(baseOrder({ consent: undefined }), DESSERTS).errors.consent);
});

test('honeypot: заполненное скрытое поле — отказ как спам', () => {
  const v = L('validateOrder')(baseOrder({ website: 'http://spam.example' }), DESSERTS);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'spam');
});

test('фото: тип и размер проверяются', () => {
  const tiny = Buffer.from('fake-jpeg').toString('base64');
  assert.equal(L('validateOrder')(baseOrder({ photo: { type: 'image/jpeg', data: tiny } }), DESSERTS).ok, true);
  assert.ok(L('validateOrder')(baseOrder({ photo: { type: 'application/pdf', data: tiny } }), DESSERTS).errors.photo);
  assert.ok(L('validateOrder')(baseOrder({ photo: { type: 'image/jpeg', data: 'A'.repeat(4 * 1024 * 1024 + 4) } }), DESSERTS).errors.photo);
  assert.ok(L('validateOrder')(baseOrder({ photo: { type: 'image/jpeg', data: 'не base64!' } }), DESSERTS).errors.photo);
});

// ---------- Сообщения ----------

test('цены и номера', () => {
  assert.equal(L('priceRangeText')(L('findDessert')('bento', DESSERTS)), 'от 1 900 до 2 400 ₽');
  assert.equal(L('priceRangeText')(L('findDessert')('wedding', DESSERTS)), 'от 18 000 до 35 000 ₽');
  assert.equal(L('formatOrderNumber')(12), 'A-0012');
  assert.equal(L('formatOrderNumber')(12345), 'A-12345');
  assert.equal(L('nextOrderNumber')(['A-0001', 'A-0007', '', 'мусор'], '3'), 8);
  assert.equal(L('nextOrderNumber')([], null), 1);
  assert.equal(L('nextOrderNumber')(['A-0002'], '9'), 10); // строки удалили, номер не повторится
});

test('Telegram: формат и экранирование HTML', () => {
  const o = {
    number: 'A-0012', status: 'new', dessertName: 'Бенто-торт «Пудра»', filling: 'Фисташка-малина', date: '2026-11-14',
    pickup: 'delivery', address: 'ул. Примерная, 5', name: 'Анна <b>', contact: '@anna', comment: 'Надпись «С днём рождения, мама» & <script>',
    priceText: 'от 1 900 до 2 400 ₽', hasPhoto: true,
  };
  const t = L('buildTelegramMessage')(o, 'Регалия');
  assert.match(t, /^🧁 <b>Новая заявка A-0012<\/b>/);
  assert.match(t, /Десерт: Бенто-торт «Пудра»/);
  assert.match(t, /Дата: суббота, 14 ноября 2026/);
  assert.match(t, /Получение: доставка — ул\. Примерная, 5/);
  assert.match(t, /Имя: Анна &lt;b&gt;/);
  assert.match(t, /&amp; &lt;script&gt;/);
  assert.doesNotMatch(t, /<script>/);
  assert.match(t, /Цена, которую видел покупатель: от 1.900 до 2.400.₽ \(ориентир — точную цену называете вы\)/);
  assert.match(t, /Регалия/);
  const w = L('buildTelegramMessage')({ ...o, status: 'waitlist', number: 'A-0013', pickup: 'pickup', comment: '' }, 'Регалия');
  assert.match(w, /^⏳ <b>ЛИСТ ОЖИДАНИЯ · заявка A-0013<\/b>\nНа эту дату мест нет — предложите место, если кто-то откажется/);
  assert.match(w, /Получение: самовывоз/);
  assert.match(w, /Комментарий: —/);
});

test('ячейки таблицы: ввод не превращается в формулу или число', () => {
  const safe = L('sheetSafe');
  assert.equal(safe('=HYPERLINK("x")'), "'=HYPERLINK(\"x\")");
  assert.equal(safe('+7 900 123-45-67'), "'+7 900 123-45-67");
  assert.equal(safe('@anna'), "'@anna");
  assert.equal(safe('Анна'), 'Анна');
});

test('нигде в ответах нет «заказ подтверждён»', () => {
  const msgs = [L('successMessage')('new', '2026-11-14'), L('successMessage')('waitlist', '2026-11-14')];
  for (const m of msgs) assert.doesNotMatch(m, /подтвержд[её]н/i);
  assert.match(msgs[1], /листе ожидания на 14 ноября/);
});

// ---------- Интеграция: setup() → doGet → doPost на поддельной таблице ----------

function freshGas(extra = {}) {
  const g = loadGas({ nowMs: msk('2026-11-01', 10), props: { TELEGRAM_BOT_TOKEN: 'TEST_TOKEN', TELEGRAM_CHAT_ID: '-100', BAKERY_NAME: 'Регалия' }, ...extra });
  g.ctx.setup();
  return g;
}
const post = (g, body) => parseOut(g.ctx.doPost({ postData: { contents: JSON.stringify(body) } }));
const getAv = (g) => parseOut(g.ctx.doGet({ parameter: { action: 'availability' } }));

test('setup(): создаёт 4 листа, настройки и даты; повторный запуск ничего не ломает', () => {
  const g = freshGas();
  const names = g.ss.getSheets().map((s) => s.getName());
  for (const n of ['Настройки', 'Даты', 'Заявки', 'Журнал']) assert.ok(names.includes(n), n);
  const st = g.ss.getSheetByName('Настройки');
  assert.equal(st.getLastRow(), 7); // заголовок + 6 параметров
  const dt = g.ss.getSheetByName('Даты');
  assert.equal(dt.getLastRow(), 46); // заголовок + 45 дней
  assert.equal(g.ss.timeZone, 'Europe/Moscow');
  assert.ok(g.ss.named.SETTING_DEFAULT_LIMIT && g.ss.named.SETTING_FEW_PERCENT);
  // владелец поменял лимит по умолчанию и закрыл дату
  st.getRange(4, 2).setValue(2);
  dt.getRange(5, 4).setValue('да');
  g.ctx.setup();
  assert.equal(st.getLastRow(), 7);
  assert.equal(st.getRange(4, 2).getValue(), 2, 'значение владельца сохранено');
  assert.equal(dt.getRange(5, 4).getValue(), 'да');
  assert.equal(dt.getLastRow(), 46, 'даты не задвоились');
  // формулы на месте
  assert.match(String(dt.getRange(2, 5).getValue()), /^=IF\(D2="да"/);
});

test('doGet availability: контракт ответа и автодобавление новых дней', () => {
  const g = freshGas();
  const av = getAv(g);
  assert.equal(av.ok, true);
  assert.deepEqual(Object.keys(av).sort(), ['acceptingOrders', 'bakeryName', 'dates', 'daysAhead', 'ok', 'pauseNote', 'serverVersion', 'today'].sort());
  assert.equal(av.today, '2026-11-01');
  assert.equal(av.dates.length, 45);
  assert.deepEqual(Object.keys(av.dates[0]).sort(), ['accepted', 'date', 'left', 'limit', 'status']);
  // прошло 3 дня — в таблицу дописались 3 новых дня
  g.setNow(msk('2026-11-04', 10));
  const av2 = getAv(g);
  assert.equal(av2.today, '2026-11-04');
  assert.equal(g.ss.getSheetByName('Даты').getLastRow(), 49);
});

test('doPost: заявки занимают места, потом лист ожидания; Telegram получает сообщение', () => {
  const g = freshGas();
  g.ss.getSheetByName('Настройки').getRange(4, 2).setValue(2); // лимит 2
  const date = '2026-11-10';
  const r1 = post(g, baseOrder({ date }));
  const r2 = post(g, baseOrder({ date, name: 'Борис' }));
  const r3 = post(g, baseOrder({ date, name: 'Вера' }));
  assert.deepEqual([r1.number, r2.number, r3.number], ['A-0001', 'A-0002', 'A-0003']);
  assert.deepEqual([r1.status, r2.status, r3.status], ['new', 'new', 'waitlist']);
  assert.match(r3.message, /листе ожидания на 10 ноября/);
  const day = getAv(g).dates.find((d) => d.date === date);
  assert.deepEqual({ status: day.status, accepted: day.accepted, left: day.left }, { status: 'full', accepted: 2, left: 0 });
  const sheet = g.ss.getSheetByName('Заявки');
  assert.equal(sheet.getLastRow(), 4);
  assert.equal(sheet.getRange(4, 3).getValue(), 'Лист ожидания');
  assert.equal(sheet.data[1][9], "'@anna_test", 'ввод защищён от формул (sheetSafe)');
  assert.equal(sheet.getRange(2, 10).getValue(), '@anna_test');
  const tg = g.fetchCalls.filter((c) => c.url.includes('/sendMessage'));
  assert.equal(tg.length, 3);
  assert.equal(JSON.parse(tg[0].options.payload).chat_id, '-100');
  assert.match(JSON.parse(tg[2].options.payload).text, /ЛИСТ ОЖИДАНИЯ · заявка A-0003/);
  // владелец отменил первую заявку → место освободилось
  sheet.getRange(2, 3).setValue('Отменена');
  assert.equal(getAv(g).dates.find((d) => d.date === date).left, 1);
});

test('doPost: повтор с тем же requestId (после таймаута) не создаёт вторую заявку', () => {
  const g = freshGas();
  const r1 = post(g, baseOrder({ requestId: 'r0123456789abcdef' }));
  const r2 = post(g, baseOrder({ requestId: 'r0123456789abcdef' }));
  const r3 = post(g, baseOrder({ requestId: 'rffffffffffffffff' }));
  assert.equal(r1.number, 'A-0001');
  assert.equal(r2.number, 'A-0001', 'повтор вернул ту же заявку');
  assert.equal(r3.number, 'A-0002');
  assert.equal(g.ss.getSheetByName('Заявки').getLastRow(), 3, 'в таблице 2 заявки, а не 3');
  assert.equal(g.fetchCalls.filter((c) => c.url.includes('/sendMessage')).length, 2, 'в Telegram 2 сообщения');
  assert.equal(L('normalizeRequestId')('<script>'), '');
});

test('setup(): лист «Заявки» создаётся раньше формул «Дат», подпись лимита как в брифе', () => {
  const g = freshGas();
  const names = g.ss.getSheets().map((s) => s.getName());
  assert.deepEqual(names.slice(0, 4), ['Настройки', 'Даты', 'Заявки', 'Журнал']);
  assert.deepEqual(names.slice(4), ['Каталог', 'Начинки', 'Тексты', 'Доступ', '_Опубликовано']);
  assert.equal(g.ss.getSheetByName('Настройки').getRange(4, 1).getValue(), 'Лимит по умолчанию на день');
});

test('doPost: ошибка Telegram не теряет заявку, пишется в «Журнал»', () => {
  const g = freshGas({ telegram: () => ({ code: 500, body: 'Bad Gateway' }) });
  const r = post(g, baseOrder());
  assert.equal(r.ok, true);
  assert.equal(r.number, 'A-0001');
  assert.equal(g.ss.getSheetByName('Заявки').getLastRow(), 2);
  const log = g.ss.getSheetByName('Журнал');
  assert.equal(log.getLastRow(), 2);
  assert.match(String(log.getRange(2, 3).getValue()), /Telegram/);
  assert.doesNotMatch(String(log.getRange(2, 4).getValue()), /TEST_TOKEN/, 'токен не попадает в журнал');
});

test('doPost: без токена заявка всё равно сохраняется', () => {
  const g = loadGas({ nowMs: msk('2026-11-01', 10) });
  g.ctx.setup();
  const r = post(g, baseOrder());
  assert.equal(r.ok, true);
  assert.match(String(g.ss.getSheetByName('Журнал').getRange(2, 4).getValue()), /TELEGRAM_BOT_TOKEN/);
});

test('doPost: фото сохраняется в Drive и уходит в Telegram отдельным сообщением', () => {
  const g = freshGas();
  const data = Buffer.from('fake-jpeg-bytes').toString('base64');
  const r = post(g, baseOrder({ photo: { type: 'image/jpeg', data } }));
  assert.equal(r.ok, true);
  assert.equal(g.drive.folders[0].name, 'Регалия — референсы');
  assert.equal(g.drive.files.length, 1);
  assert.match(String(g.ss.getSheetByName('Заявки').getRange(2, 13).getValue()), /^https:\/\/drive\.google\.com/);
  const photoCall = g.fetchCalls.find((c) => c.url.includes('/sendPhoto'));
  assert.ok(photoCall);
  assert.equal(photoCall.options.payload.caption, 'Фото-референс к заявке A-0001');
  // вторая заявка — та же папка
  post(g, baseOrder({ photo: { type: 'image/jpeg', data } }));
  assert.equal(g.drive.folders.length, 1);
});

test('doPost: сбой Drive не теряет заявку', () => {
  const g = freshGas({ driveFails: true });
  const r = post(g, baseOrder({ photo: { type: 'image/jpeg', data: Buffer.from('x').toString('base64') } }));
  assert.equal(r.ok, true);
  assert.match(String(g.ss.getSheetByName('Заявки').getRange(2, 13).getValue()), /не сохранилось/);
});

test('doPost: остановка приёма, honeypot, срок, плохой JSON', () => {
  const g = freshGas();
  assert.equal(post(g, baseOrder({ website: 'x' })).code, 'spam');
  assert.equal(post(g, baseOrder({ date: '2026-11-02' })).code, 'too_early');
  assert.equal(parseOut(g.ctx.doPost({ postData: { contents: '{oops' } })).code, 'bad_request');
  g.ss.getSheetByName('Настройки').getRange(2, 2).setValue('нет');
  assert.equal(post(g, baseOrder()).code, 'paused');
  assert.equal(getAv(g).acceptingOrders, false);
  assert.equal(g.ss.getSheetByName('Заявки').getLastRow(), 1, 'ни одной строки не записано');
});

test('doPost: закрытая владельцем дата не принимается', () => {
  const g = freshGas();
  const dt = g.ss.getSheetByName('Даты');
  // строка 11 = 2026-11-10 (строка 2 = сегодня)
  dt.getRange(11, 4).setValue('да');
  assert.equal(post(g, baseOrder({ date: '2026-11-10' })).code, 'closed');
  dt.getRange(11, 4).setValue('нет');
  dt.getRange(11, 3).setValue(0);
  assert.equal(post(g, baseOrder({ date: '2026-11-10' })).code, 'closed');
  assert.equal(getAv(g).dates.find((d) => d.date === '2026-11-10').status, 'closed');
});

test('doPost: занятая блокировка → понятный ответ «busy»', () => {
  const g = freshGas();
  const lock = g.ctx.LockService.getScriptLock();
  lock.tryLock();
  const r = post(g, baseOrder());
  lock.releaseLock();
  assert.equal(r.code, 'busy');
});

// ---------- Эталон для клиентов: свойства кондитерской, столбцы по заголовкам, версия, миграция ----------

test('setup() без SITE_URL / GITHUB_REPO — понятный отказ; Code.gs не тянется к чужому сайту', () => {
  const g = loadGas({ nowMs: msk('2026-11-01', 10), noClientProps: true });
  assert.throws(() => g.ctx.setup(), /SITE_URL, GITHUB_REPO/);
  assert.equal(g.ss.getSheets().length, 0, 'таблица не тронута');
  const code = fs.readFileSync(ROOT + '/apps-script/Code.gs', 'utf8');
  assert.doesNotMatch(code, /order-forge-demo|morro-supremo|Регалия/, 'в серверном коде нет демо-кондитерской');
});

test('BAKERY_NAME засевает название; приём заявок работает и без SITE_URL (по снимку)', () => {
  const g = freshGas();
  assert.equal(g.get('readSettings_(getSpreadsheet_())').bakeryName, 'Регалия');
  delete g.props.SITE_URL;
  g.cache.clear();
  const r = post(g, baseOrder());
  assert.equal(r.ok, true, r.message);
});

/** Владелец вставил свой столбец «Предоплата» перед «Статусом». */
function insertColumn(sheet, index, title) {
  sheet.data.forEach((row, i) => row.splice(index, 0, i === 0 ? title : ''));
}

test('столбцы «Заявок» ищутся по заголовкам: вставленный столбец не ломает подсчёт мест', () => {
  const g = freshGas();
  const orders = g.ss.getSheetByName('Заявки');
  insertColumn(orders, 2, 'Предоплата');
  const date = '2026-11-20';
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push(post(g, baseOrder({ date, requestId: 'req-ins-' + i })).status);
  assert.deepEqual(statuses, ['new', 'new', 'new', 'new', 'waitlist'], 'лимит 4 по умолчанию соблюдён');
  const header = orders.data[0];
  const row = orders.data[1];
  assert.equal(row[header.indexOf('Предоплата')], '', 'чужой столбец не заполняется');
  assert.equal(row[header.indexOf('Статус')], 'Новая');
  assert.equal(row[header.indexOf('Номер')], 'A-0001');
  const av = getAv(g);
  assert.equal(av.dates.find((d) => d.date === date).status, 'full');
});

test('нет заголовка «Статус» → заявка в лист ожидания (не перебор) и одна тревога в Telegram', () => {
  const g = freshGas();
  const orders = g.ss.getSheetByName('Заявки');
  orders.data[0][orders.data[0].indexOf('Статус')] = 'Состояние';
  const a = post(g, baseOrder({ requestId: 'r-a' }));
  const b = post(g, baseOrder({ requestId: 'r-b' }));
  assert.equal(a.status, 'waitlist');
  assert.equal(b.status, 'waitlist');
  const alerts = g.fetchCalls.filter((c) => c.url.includes('api.telegram.org') && /не найдены столбцы/.test(JSON.parse(c.options.payload).text));
  assert.equal(alerts.length, 1, 'тревога не чаще раза в час');
  assert.equal(getAv(g).dates.every((d) => d.status !== 'free' && d.status !== 'few'), true, 'на сайте свободных дней нет');
});

test('версия сервера в ответе; старая таблица донастраивается сама один раз', () => {
  const g = freshGas();
  const v = g.get('SERVER_VERSION');
  assert.ok(v >= 2);
  assert.equal(getAv(g).serverVersion, v);
  // «старый» сервер: таблица без листов админки и без SCHEMA_VERSION
  for (const n of ['Каталог', 'Начинки', 'Тексты', 'Доступ']) g.ss.deleteSheet(g.ss.getSheetByName(n));
  delete g.props.SCHEMA_VERSION;
  getAv(g);
  assert.ok(g.ss.getSheetByName('Каталог') && g.ss.getSheetByName('Доступ'), 'листы админки созданы автоматически');
  assert.equal(g.props.SCHEMA_VERSION, String(g.get('SCHEMA_VERSION')));
  const logged = g.ss.getSheetByName('Журнал').data.filter((r) => r[2] === 'Сервер обновлён').length;
  getAv(g);
  assert.equal(g.ss.getSheetByName('Журнал').data.filter((r) => r[2] === 'Сервер обновлён').length, logged, 'второй раз не мигрирует');
});

test('каталог для проверки заявок: версия на сайте новее снимка → берётся сайт', () => {
  const site = JSON.parse(fs.readFileSync(ROOT + '/tests/fixtures/catalog.json', 'utf8'));
  const g = freshGas({ siteCatalog: site });
  site.version = Number(site.version || 1) + 5;
  site.desserts = site.desserts.map((d) => (d.id === 'bento' ? { ...d, visible: false } : d));
  g.cache.clear();
  const r = post(g, baseOrder({ dessertId: 'bento' }));
  assert.ok(r.errors && r.errors.dessertId, 'скрытый на сайте десерт не принимается');
  assert.equal(JSON.parse(g.ss.getSheetByName('_Опубликовано').getRange(2, 1).getValue()).version, site.version, 'снимок обновлён');
});
