/**
 * ORDER FORGE — «Окно заказов» для кондитерской.
 * Бэкенд на Google Apps Script: Google-таблица + уведомления в Telegram.
 *
 * Как установить — docs/SETUP_GOOGLE.md (пошагово, для новичка).
 *
 * ТОКЕН БОТА В ЭТОТ ФАЙЛ НЕ ПИШИТЕ. Он хранится только в
 * «Настройки проекта → Свойства скрипта»:
 *   TELEGRAM_BOT_TOKEN — токен бота от @BotFather
 *   TELEGRAM_CHAT_ID   — id чата/группы, куда приходят заявки
 *
 * Устройство файла:
 *   1) ЧИСТАЯ ЛОГИКА (между маркерами PURE LOGIC) — без объектов Google.
 *      Эту часть tools/sync-logic.mjs копирует в js/logic.generated.js,
 *      и её же проверяют тесты в Node. Правите логику — запустите
 *      `npm run sync-logic` и `npm test`.
 *   2) РАБОТА С ТАБЛИЦЕЙ, DRIVE И TELEGRAM — функции с «_» на конце,
 *      setup(), doGet(), doPost(), testTelegram().
 */

// === PURE LOGIC START ===

const TIME_ZONE = 'Europe/Moscow';
// В Москве нет перехода на летнее время с 2014 года: всегда UTC+3.
const MOSCOW_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Ассортимент больше не зашит в код: сервер берёт опубликованный каталог
// (лист «_Опубликовано», тот же JSON, что data/catalog.json на сайте).
// Все функции ниже получают список десертов параметром.

// Версия серверного кода. Сайт и админка знают ожидаемую (js/logic.generated.js) и
// показывают «сервер устарел», если в Apps Script вставлена старая. Увеличивать при каждом изменении Code.gs.
const SERVER_VERSION = 2;

const DEFAULT_SETTINGS = {
  acceptingOrders: true,
  bakeryName: 'Кондитерская',
  defaultLimit: 4,
  daysAhead: 45,
  fewPercent: 25,
  pauseNote: '',
};

const DAY_STATUS_LABELS = { free: 'Свободно', few: 'Мало мест', full: 'Мест нет', closed: 'Закрыто' };
const ORDER_STATUS_LABELS = { new: 'Новая', waitlist: 'Лист ожидания' };

const FIELD_LIMITS = {
  nameMin: 2,
  nameMax: 60,
  contactMax: 64,
  addressMin: 5,
  addressMax: 200,
  commentMax: 500,
  // base64 сжатого фото (клиент сжимает до ~1600px, JPEG 0.8 — обычно 200–900 КБ).
  photoBase64Max: 4 * 1024 * 1024,
};

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const WEEKDAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const WEEKDAYS_LONG = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_NOMINATIVE = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

// ---------- Даты (строки вида YYYY-MM-DD, без часовых поясов) ----------

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function ymdFromUtcDate(d) {
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

/** Сегодняшняя дата в Москве для момента nowMs (миллисекунды UTC). */
function moscowToday(nowMs) {
  return ymdFromUtcDate(new Date(nowMs + MOSCOW_UTC_OFFSET_MS));
}

function isValidYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const parts = s.split('-').map(Number);
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return ymdFromUtcDate(d) === s;
}

function ymdToUtcMs(s) {
  const parts = s.split('-').map(Number);
  return Date.UTC(parts[0], parts[1] - 1, parts[2]);
}

function addDays(ymd, n) {
  return ymdFromUtcDate(new Date(ymdToUtcMs(ymd) + n * DAY_MS));
}

/** Сколько дней от a до b (b − a). */
function diffDays(a, b) {
  return Math.round((ymdToUtcMs(b) - ymdToUtcMs(a)) / DAY_MS);
}

/** День недели: 0 — понедельник … 6 — воскресенье. */
function weekdayIndex(ymd) {
  return (new Date(ymdToUtcMs(ymd)).getUTCDay() + 6) % 7;
}

/** «суббота, 15 ноября 2026» */
function formatDateLong(ymd) {
  const p = ymd.split('-').map(Number);
  return WEEKDAYS_LONG[weekdayIndex(ymd)] + ', ' + p[2] + ' ' + MONTHS_GENITIVE[p[1] - 1] + ' ' + p[0];
}

/** «15 ноября» */
function formatDateShort(ymd) {
  const p = ymd.split('-').map(Number);
  return p[2] + ' ' + MONTHS_GENITIVE[p[1] - 1];
}

/** «Суббота, 15 ноября» (с заглавной, без года) */
function formatDateWeekday(ymd) {
  const w = WEEKDAYS_LONG[weekdayIndex(ymd)];
  return w.charAt(0).toUpperCase() + w.slice(1) + ', ' + formatDateShort(ymd);
}

/** 1 день, 2 дня, 5 дней, 14 дней, 21 день */
function pluralRu(n, one, few, many) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

function daysWord(n) {
  return n + ' ' + pluralRu(n, 'день', 'дня', 'дней');
}

// ---------- Настройки ----------

function parseYesNo(v, fallback) {
  if (v === true || v === false) return v;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (['да', 'yes', 'y', 'true', '1', 'д'].indexOf(s) >= 0) return true;
  if (['нет', 'no', 'n', 'false', '0', 'н'].indexOf(s) >= 0) return false;
  return fallback;
}

function toNumberOr(v, fallback) {
  if (v === '' || v == null) return fallback;
  const n = Number(String(v).replace(',', '.').replace(/\s/g, ''));
  return isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** Приводит «сырые» значения из листа «Настройки» к проверенному виду. */
function normalizeSettings(raw) {
  raw = raw || {};
  return {
    acceptingOrders: parseYesNo(raw.acceptingOrders, DEFAULT_SETTINGS.acceptingOrders),
    bakeryName: String(raw.bakeryName == null ? '' : raw.bakeryName).trim() || DEFAULT_SETTINGS.bakeryName,
    defaultLimit: clamp(Math.floor(toNumberOr(raw.defaultLimit, DEFAULT_SETTINGS.defaultLimit)), 0, 999),
    daysAhead: clamp(Math.floor(toNumberOr(raw.daysAhead, DEFAULT_SETTINGS.daysAhead)), 1, 180),
    fewPercent: clamp(toNumberOr(raw.fewPercent, DEFAULT_SETTINGS.fewPercent), 0, 100),
    pauseNote: String(raw.pauseNote == null ? '' : raw.pauseNote).trim().slice(0, 300),
  };
}

// ---------- Статусы дат ----------

/** Действующий лимит: «Закрыть = да» или лимит 0 → 0; пустой лимит → по умолчанию. */
function effectiveLimit(day, settings) {
  day = day || {};
  if (parseYesNo(day.closed, false)) return 0;
  if (day.limit === '' || day.limit == null) return settings.defaultLimit;
  return Math.max(0, Math.floor(toNumberOr(day.limit, settings.defaultLimit)));
}

/**
 * «Мало мест», если свободно не больше fewPercent % лимита,
 * но порог никогда не меньше одного места (последнее место — всегда «мало»).
 */
function isFew(left, limit, fewPercent) {
  return left > 0 && left <= Math.max(1, (limit * fewPercent) / 100);
}

/** day: { limit, closed, accepted } → { status, limit, accepted, left } */
function computeDayStatus(day, settings) {
  const limit = effectiveLimit(day, settings);
  const accepted = Math.max(0, Math.floor(toNumberOr(day && day.accepted, 0)));
  if (limit <= 0) return { status: 'closed', limit: 0, accepted: accepted, left: 0 };
  const left = Math.max(0, limit - accepted);
  let status = 'free';
  if (left <= 0) status = 'full';
  else if (isFew(left, limit, settings.fewPercent)) status = 'few';
  return { status: status, limit: limit, accepted: accepted, left: left };
}

/** Окно приёма: от сегодня включительно, daysAhead дней. */
function isInWindow(ymd, today, daysAhead) {
  const d = diffDays(today, ymd);
  return d >= 0 && d <= daysAhead - 1;
}

/**
 * Ответ GET ?action=availability.
 * days: { 'YYYY-MM-DD': { limit, closed } }, counts: { 'YYYY-MM-DD': число заявок «Новая» }
 */
function buildAvailability(input) {
  const settings = input.settings;
  const days = input.days || {};
  const counts = input.counts || {};
  const dates = [];
  for (let i = 0; i < settings.daysAhead; i++) {
    const ymd = addDays(input.today, i);
    const info = days[ymd] || {};
    const s = computeDayStatus({ limit: info.limit, closed: info.closed, accepted: counts[ymd] || 0 }, settings);
    dates.push({ date: ymd, status: s.status, limit: s.limit, accepted: s.accepted, left: s.left });
  }
  return {
    ok: true,
    acceptingOrders: settings.acceptingOrders,
    pauseNote: settings.pauseNote,
    bakeryName: settings.bakeryName,
    daysAhead: settings.daysAhead,
    today: input.today,
    dates: dates,
  };
}

// ---------- Десерты и цены ----------

function findDessert(id, desserts) {
  const list = desserts || [];
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

/** Ближайшая дата, на которую можно заказать десерт. */
function earliestDateFor(dessert, today) {
  return addDays(today, dessert.leadDays);
}

/** 1900 → «1 900» (неразрывный пробел) */
function formatRub(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** «от 1 900 до 2 400 ₽» */
function priceRangeText(dessert) {
  return 'от ' + formatRub(dessert.priceMin) + ' до ' + formatRub(dessert.priceMax) + ' ₽';
}

// ---------- Валидация заявки ----------

function cleanText(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Контакт: телефон +7XXXXXXXXXX / 8XXXXXXXXXX (пробелы, скобки, дефисы допустимы)
 * или ник Telegram @name (буквы латиницей, цифры, «_», 4–32 символа; можно t.me/name).
 */
function normalizeContact(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const tme = s.match(/^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{4,32})\/?$/i);
  if (tme) return { ok: true, kind: 'telegram', value: '@' + tme[1] };
  if (s.charAt(0) === '@') {
    return /^@[A-Za-z0-9_]{4,32}$/.test(s) ? { ok: true, kind: 'telegram', value: s } : { ok: false };
  }
  const digits = s.replace(/[\s\-() ]/g, '');
  const m = digits.match(/^(?:\+7|8)(\d{10})$/);
  if (!m) return { ok: false };
  const d = m[1];
  return { ok: true, kind: 'phone', value: '+7 ' + d.slice(0, 3) + ' ' + d.slice(3, 6) + '-' + d.slice(6, 8) + '-' + d.slice(8, 10) };
}

/**
 * Проверка полей заявки. desserts — десерты, которые сейчас можно заказать (видимые).
 * Возвращает { ok:true, order } или
 * { ok:false, code:'validation'|'spam'|'bad_request', message, errors:{поле:текст} }.
 */
function validateOrder(p, desserts) {
  if (!p || typeof p !== 'object') {
    return { ok: false, code: 'bad_request', message: 'Не удалось прочитать заявку. Обновите страницу и попробуйте ещё раз.', errors: {} };
  }
  // Honeypot: невидимое поле, которое заполняют только боты.
  if (String(p.website == null ? '' : p.website).trim() !== '') {
    return { ok: false, code: 'spam', message: 'Заявка отклонена.', errors: {} };
  }
  const errors = {};
  const dessert = findDessert(String(p.dessertId || ''), desserts);
  if (!dessert) errors.dessertId = 'Выберите десерт';

  const filling = cleanText(p.filling, 80);
  if (!filling) errors.filling = 'Выберите начинку';
  else if (dessert && dessert.fillings.indexOf(filling) < 0) errors.filling = 'У этого десерта нет такой начинки — выберите из списка';

  const date = String(p.date || '');
  if (!isValidYmd(date)) errors.date = 'Выберите дату в календаре';

  const pickup = p.pickup === 'delivery' ? 'delivery' : p.pickup === 'pickup' ? 'pickup' : '';
  if (!pickup) errors.pickup = 'Выберите самовывоз или доставку';

  const address = cleanText(p.address, FIELD_LIMITS.addressMax);
  if (pickup === 'delivery' && address.length < FIELD_LIMITS.addressMin) errors.address = 'Укажите адрес доставки';

  const name = cleanText(p.name, FIELD_LIMITS.nameMax + 1);
  if (name.length < FIELD_LIMITS.nameMin) errors.name = 'Как к вам обращаться?';
  else if (name.length > FIELD_LIMITS.nameMax) errors.name = 'Имя слишком длинное — до ' + FIELD_LIMITS.nameMax + ' символов';

  const contactRaw = cleanText(p.contact, FIELD_LIMITS.contactMax);
  const contact = normalizeContact(contactRaw);
  if (!contactRaw) errors.contact = 'Оставьте телефон или ник в Telegram';
  else if (!contact.ok) errors.contact = 'Телефон в формате +7 900 000-00-00 или ник Telegram вида @name';

  const comment = cleanText(p.comment, FIELD_LIMITS.commentMax + 1);
  if (comment.length > FIELD_LIMITS.commentMax) errors.comment = 'Комментарий до ' + FIELD_LIMITS.commentMax + ' символов';

  if (p.consent !== true) errors.consent = 'Нужно согласие на обработку персональных данных';

  let photo = null;
  if (p.photo && typeof p.photo === 'object' && p.photo.data) {
    const data = String(p.photo.data);
    const type = String(p.photo.type || '');
    if (PHOTO_TYPES.indexOf(type) < 0) errors.photo = 'Фото должно быть в формате JPG, PNG или WebP';
    else if (data.length > FIELD_LIMITS.photoBase64Max) errors.photo = 'Фото слишком большое — выберите другое';
    else if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) errors.photo = 'Фото повреждено — выберите его ещё раз';
    else photo = { type: type, data: data };
  }

  const keys = Object.keys(errors);
  if (keys.length) {
    return { ok: false, code: 'validation', message: 'Проверьте поля формы: ' + keys.map(function (k) { return errors[k]; }).join('; ') + '.', errors: errors };
  }
  return {
    ok: true,
    order: {
      dessertId: dessert.id,
      filling: filling,
      date: date,
      pickup: pickup,
      address: pickup === 'delivery' ? address : '',
      name: name,
      contact: contact.value,
      contactKind: contact.kind,
      comment: comment,
      photo: photo,
    },
  };
}

/**
 * Решение по проверенной заявке. ctx: { settings, today, desserts, day:{limit, closed, accepted} }.
 * Возвращает { ok:true, status:'new'|'waitlist' } или { ok:false, code, message }.
 */
function decideOrder(order, ctx) {
  const settings = ctx.settings;
  if (!settings.acceptingOrders) {
    return { ok: false, code: 'paused', message: 'Приём заявок временно остановлен.' + (settings.pauseNote ? ' ' + settings.pauseNote : '') };
  }
  const dessert = findDessert(order.dessertId, ctx.desserts);
  if (!dessert) return { ok: false, code: 'validation', message: 'Этого десерта больше нет в каталоге — обновите страницу.', errors: { dessertId: 'Выберите десерт' } };
  if (!isInWindow(order.date, ctx.today, settings.daysAhead)) {
    return { ok: false, code: 'out_of_window', message: 'На эту дату заявки не принимаются. Выберите дату в календаре.' };
  }
  if (diffDays(ctx.today, order.date) < dessert.leadDays) {
    return {
      ok: false,
      code: 'too_early',
      message: '«' + dessert.name + '» нужно заказывать минимум за ' + daysWord(dessert.leadDays) + '. Ближайшая дата: ' + formatDateLong(earliestDateFor(dessert, ctx.today)) + '.',
    };
  }
  const s = computeDayStatus(ctx.day || {}, settings);
  if (s.status === 'closed') {
    return { ok: false, code: 'closed', message: 'В этот день кондитерская не принимает заказы. Выберите другую дату.' };
  }
  return { ok: true, status: s.left > 0 ? 'new' : 'waitlist', day: s };
}

/**
 * Полная проверка заявки: валидация + правила дат.
 * ctx: { settings, today, desserts, getDay(date) → { limit, closed, accepted } } — вызывается ПОД БЛОКИРОВКОЙ.
 */
function prepareOrder(payload, ctx) {
  const v = validateOrder(payload, ctx.desserts);
  if (!v.ok) return v;
  const d = decideOrder(v.order, { settings: ctx.settings, today: ctx.today, desserts: ctx.desserts, day: ctx.getDay(v.order.date) });
  if (!d.ok) return d;
  const dessert = findDessert(v.order.dessertId, ctx.desserts);
  const order = Object.assign({}, v.order, {
    status: d.status,
    dessertName: dessert.name,
    priceText: priceRangeText(dessert),
  });
  return { ok: true, order: order };
}

// ---------- Номера, ответы, сообщения ----------

function formatOrderNumber(n) {
  return 'A-' + ('000' + n).slice(-Math.max(4, String(n).length));
}

function parseOrderNumber(s) {
  const m = String(s || '').match(/^A-(\d+)$/);
  return m ? Number(m[1]) : 0;
}

/** Следующий номер: больше и максимума в листе, и сохранённого счётчика. */
function nextOrderNumber(existingNumbers, counter) {
  let max = Math.max(0, Number(counter) || 0);
  (existingNumbers || []).forEach(function (s) {
    max = Math.max(max, parseOrderNumber(s));
  });
  return max + 1;
}

function successMessage(status, date) {
  if (status === 'waitlist') {
    return 'Вы в листе ожидания на ' + formatDateShort(date) + '. Если место освободится, кондитер напишет вам.';
  }
  return 'Кондитер свяжется с вами, подтвердит дату и назовёт точную стоимость.';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Текст для Telegram (parse_mode HTML). Весь ввод покупателя экранируется. */
function buildTelegramMessage(o, bakeryName) {
  const lines = [];
  if (o.status === 'waitlist') {
    lines.push('⏳ <b>ЛИСТ ОЖИДАНИЯ · заявка ' + escapeHtml(o.number) + '</b>');
    lines.push('На эту дату мест нет — предложите место, если кто-то откажется');
    lines.push('');
  } else {
    lines.push('🧁 <b>Новая заявка ' + escapeHtml(o.number) + '</b>');
  }
  lines.push('Десерт: ' + escapeHtml(o.dessertName));
  lines.push('Начинка: ' + escapeHtml(o.filling));
  lines.push('Дата: ' + formatDateLong(o.date));
  lines.push('Получение: ' + (o.pickup === 'delivery' ? 'доставка — ' + escapeHtml(o.address) : 'самовывоз'));
  lines.push('Имя: ' + escapeHtml(o.name));
  lines.push('Контакт: ' + escapeHtml(o.contact));
  lines.push('Комментарий: ' + (o.comment ? escapeHtml(o.comment) : '—'));
  lines.push('Цена, которую видел покупатель: ' + escapeHtml(o.priceText) + ' (ориентир — точную цену называете вы)');
  if (o.hasPhoto) lines.push('Фото-референс: отдельным сообщением ниже');
  if (bakeryName) {
    lines.push('');
    lines.push('<i>' + escapeHtml(bakeryName) + ' · окно заказов</i>');
  }
  return lines.join('\n');
}

/**
 * Идентификатор попытки отправки (генерирует браузер). Повтор с тем же id
 * (например, после таймаута) не создаёт вторую заявку. '' — если id нет или он странный.
 */
function normalizeRequestId(v) {
  const s = String(v == null ? '' : v);
  return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : '';
}

/** Текст, который Google-таблица не превратит в формулу или число. */
function sheetSafe(s) {
  s = String(s == null ? '' : s);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

// ---------- Каталог: тексты, проверка, публикация ----------

/** Тексты витрины, которые меняются из админки. key — путь в catalog.json. */
const TEXT_FIELDS = [
  { key: 'hero.titleLines', label: 'Заголовок первого экрана', hint: 'Каждая строка — с новой строки', multiline: true, lines: true, max: 80 },
  { key: 'hero.lead', label: 'Подзаголовок первого экрана', multiline: true, max: 300 },
  { key: 'about.text.0', label: 'О кондитерской — первый абзац', multiline: true, max: 600 },
  { key: 'about.text.1', label: 'О кондитерской — второй абзац', multiline: true, max: 600 },
  { key: 'fillings.caption', label: 'Подпись к фото начинок', multiline: true, max: 300 },
  { key: 'delivery.lead', label: 'Упаковка и доставка — вступление', multiline: true, max: 300 },
  { key: 'delivery.pickup.text', label: 'Самовывоз', multiline: true, max: 300 },
  { key: 'delivery.courier.text', label: 'Доставка по городу', multiline: true, max: 300 },
  { key: 'contacts.phone', label: 'Телефон', max: 40 },
  { key: 'contacts.email', label: 'E-mail', max: 80 },
  { key: 'contacts.address', label: 'Адрес самовывоза', max: 120 },
  { key: 'contacts.hours', label: 'Часы работы', max: 80 },
  { key: 'links.instagram', label: 'Ссылка на Instagram', max: 200, url: true },
  { key: 'links.telegram', label: 'Ссылка на Telegram', max: 200, url: true },
];

function getPath(obj, path) {
  return String(path).split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj);
}

function setPath(obj, path, value) {
  const keys = String(path).split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (o[k] == null || typeof o[k] !== 'object') o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[k];
  }
  o[keys[keys.length - 1]] = value;
  return obj;
}

function findTextField(key) {
  for (let i = 0; i < TEXT_FIELDS.length; i++) if (TEXT_FIELDS[i].key === key) return TEXT_FIELDS[i];
  return null;
}

/** Текущее значение текстового поля как строка (для формы админки и листа «Тексты»). */
function readTextField(catalog, key) {
  const v = getPath(catalog, key);
  if (Array.isArray(v)) return v.join('\n');
  return v == null ? '' : String(v);
}

/** Проверяет и записывает текст в каталог. Возвращает '' или текст ошибки. */
function applyTextField(catalog, key, raw) {
  const f = findTextField(key);
  if (!f) return 'Неизвестное поле';
  const value = String(raw == null ? '' : raw).replace(/\r/g, '').trim();
  if (value.length > (f.lines ? f.max * 4 : f.max)) return 'Слишком длинно — до ' + f.max + ' символов';
  if (f.url && value && value !== '#' && !/^https:\/\/[^\s<>"]+$/.test(value)) return 'Ссылка должна начинаться с https://';
  if (f.lines) {
    const lines = value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    if (!lines.length) return 'Заголовок не может быть пустым';
    setPath(catalog, 'hero.titleLines', lines);
    setPath(catalog, 'hero.title', lines.join(' '));
    return '';
  }
  setPath(catalog, key, value);
  if (key === 'contacts.phone') {
    const digits = value.replace(/[^\d+]/g, '');
    setPath(catalog, 'contacts.phoneHref', digits ? 'tel:' + digits.replace(/^8(?=\d{10}$)/, '+7') : '');
  }
  return '';
}

const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };

/** «Торт «Праздник»» → «tort-prazdnik» (id десерта и имя файлов фото). */
function slugify(name) {
  return String(name || '').toLowerCase().split('').map(function (ch) {
    return TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch;
  }).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

function toInt(v) {
  const n = Number(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.'));
  return isFinite(n) ? Math.round(n) : NaN;
}

/**
 * Проверка карточки десерта из админки. Возвращает { ok, errors, dessert } (dessert — очищенная копия).
 */
function validateDessertDraft(d) {
  d = d || {};
  const errors = {};
  const out = {};
  out.id = String(d.id || '').trim();
  if (!/^[a-z0-9-]{2,40}$/.test(out.id)) errors.id = 'Код — латиница, цифры и дефис, 2–40 символов';
  out.visible = d.visible !== false && d.visible !== 'нет';
  out.name = cleanText(d.name, 81);
  if (out.name.length < 2) errors.name = 'Введите название';
  else if (out.name.length > 80) errors.name = 'Название до 80 символов';
  out.description = cleanText(d.description, 301);
  if (out.description.length > 300) errors.description = 'Описание до 300 символов';
  const fillings = (Array.isArray(d.fillings) ? d.fillings : String(d.fillings || '').split(/;|\n/))
    .map(function (f) { return cleanText(f, 81); }).filter(Boolean);
  const unique = [];
  fillings.forEach(function (f) { if (unique.indexOf(f) < 0) unique.push(f); });
  out.fillings = unique;
  if (!unique.length) errors.fillings = 'Добавьте хотя бы одну начинку';
  else if (unique.length > 12) errors.fillings = 'Не больше 12 начинок';
  else if (unique.some(function (f) { return f.length > 80; })) errors.fillings = 'Название начинки до 80 символов';
  out.priceMin = toInt(d.priceMin);
  out.priceMax = toInt(d.priceMax);
  if (!(out.priceMin > 0) || out.priceMin > 10000000) errors.priceMin = 'Цена «от» — целое число рублей';
  if (!(out.priceMax > 0) || out.priceMax > 10000000) errors.priceMax = 'Цена «до» — целое число рублей';
  else if (out.priceMin > out.priceMax) errors.priceMax = 'Цена «до» должна быть не меньше цены «от»';
  out.unit = cleanText(d.unit, 41);
  if (out.unit.length > 40) errors.unit = 'До 40 символов';
  out.leadDays = toInt(d.leadDays);
  if (!(out.leadDays >= 0 && out.leadDays <= 90)) errors.leadDays = 'Срок — от 0 до 90 дней';
  out.badge = cleanText(d.badge, 21);
  if (out.badge.length > 20) errors.badge = 'Бейдж до 20 символов';
  out.image = String(d.image || '').trim();
  // images/… — опубликованное фото; drive:… — загружено в админке, станет images/… при публикации.
  if (out.image && !/^(images\/[a-z0-9\/_-]+|drive:[\w-]+\|[\w-]+(\|(webp|jpg))?)$/.test(out.image)) errors.image = 'Неверный путь к фото';
  // Расширение файлов фото: старые — webp; загруженные в браузере без поддержки WebP (Safari) — jpg.
  out.imageExt = d.imageExt === 'jpg' ? 'jpg' : 'webp';
  if (out.visible && !out.image) errors.image = 'Загрузите фото';
  out.alt = cleanText(d.alt, 201) || out.name;
  if (out.alt.length > 200) errors.alt = 'Описание фото до 200 символов';
  return { ok: Object.keys(errors).length === 0, errors: errors, dessert: out };
}

/** Десерты, которые видит покупатель и которые можно заказать (в порядке каталога). */
function visibleDesserts(catalog) {
  return ((catalog && catalog.desserts) || []).filter(function (d) { return d.visible !== false; });
}

/** Проверка всего каталога перед публикацией. Возвращает массив текстов ошибок (пустой — можно публиковать). */
function validateCatalog(catalog) {
  const problems = [];
  const ids = {};
  (catalog.desserts || []).forEach(function (d, i) {
    const v = validateDessertDraft(d);
    const title = '«' + (d.name || d.id || ('десерт ' + (i + 1))) + '»';
    Object.keys(v.errors).forEach(function (k) { problems.push(title + ': ' + v.errors[k]); });
    if (ids[d.id]) problems.push(title + ': такой код уже есть у другого десерта');
    ids[d.id] = true;
  });
  if (!visibleDesserts(catalog).length) problems.push('В каталоге нет ни одного видимого десерта');
  return problems;
}

/** Собирает новую опубликованную версию: база (текущий каталог) + черновик из админки. */
function buildPublishedCatalog(base, draft, meta) {
  const next = JSON.parse(JSON.stringify(base || {}));
  if (draft.desserts) next.desserts = draft.desserts.map(function (d) { return validateDessertDraft(d).dessert; });
  if (draft.fillings) {
    next.fillings = next.fillings || {};
    next.fillings.items = draft.fillings
      .map(function (f) { return { name: cleanText(f.name, 80), description: cleanText(f.description, 300) }; })
      .filter(function (f) { return f.name; });
  }
  if (draft.texts) {
    Object.keys(draft.texts).forEach(function (k) { if (findTextField(k)) applyTextField(next, k, draft.texts[k]); });
  }
  next.version = (Number(next.version) || 0) + 1;
  next.publishedAt = new Date(meta.nowMs).toISOString();
  next.publishedBy = meta.by || '';
  return next;
}

/** То же, что tools/build-catalog.mjs: ES-модуль для сайта. */
function catalogToJsModule(catalog) {
  return '// АВТОМАТИЧЕСКИ: генерируется из data/catalog.json (админка → «Опубликовать» или npm run build-catalog).\n'
    + '// Не редактируйте вручную.\nexport const CATALOG = ' + JSON.stringify(catalog, null, 2) + ';\n';
}

/** Каталог, который получится, если сейчас нажать «Опубликовать» (без метаданных). */
function draftCatalog(published, draft) {
  return buildPublishedCatalog(published, draft, { nowMs: 0, by: '' });
}

function stripCatalogMeta(c) {
  const copy = JSON.parse(JSON.stringify(c));
  delete copy.version; delete copy.publishedAt; delete copy.publishedBy;
  return copy;
}

/** Что изменилось в черновике по сравнению с опубликованным — для счётчика у кнопки «Опубликовать». */
function draftChanges(published, draft) {
  const next = draftCatalog(published, draft);
  const changes = [];
  const before = {};
  (published.desserts || []).forEach(function (d) { before[d.id] = JSON.stringify(validateDessertDraft(d).dessert); });
  next.desserts.forEach(function (d, i) {
    const pd = (published.desserts || [])[i];
    if (!before[d.id]) changes.push('новый десерт «' + d.name + '»');
    else if (before[d.id] !== JSON.stringify(d) || !pd || pd.id !== d.id) changes.push('«' + d.name + '»');
  });
  (published.desserts || []).forEach(function (d) {
    if (!next.desserts.some(function (x) { return x.id === d.id; })) changes.push('удалён «' + d.name + '»');
  });
  if (JSON.stringify((published.fillings || {}).items || []) !== JSON.stringify(next.fillings.items || [])) changes.push('начинки');
  TEXT_FIELDS.forEach(function (f) {
    if (readTextField(published, f.key) !== readTextField(next, f.key)) changes.push(f.label);
  });
  return changes;
}

/**
 * Строка заголовков листа → { cols: { 'Заголовок': индекс с 0 }, missing: [...] }.
 * Столбцы ищем по названию, а не по номеру: владелец может вставить свой столбец или переставить их.
 */
function mapHeaders(headerRow, required) {
  const cols = {};
  (headerRow || []).forEach(function (h, i) {
    const k = String(h == null ? '' : h).trim();
    if (k && !(k in cols)) cols[k] = i;
  });
  return { cols: cols, missing: (required || []).filter(function (h) { return !(h in cols); }) };
}

// === PURE LOGIC END ===

// =====================================================================
// Ниже — работа с Google-таблицей, Drive и Telegram.
// =====================================================================

const SHEETS = {
  SETTINGS: 'Настройки', DATES: 'Даты', ORDERS: 'Заявки', LOG: 'Журнал',
  CATALOG: 'Каталог', FILLINGS: 'Начинки', TEXTS: 'Тексты', ACCESS: 'Доступ', PUBLISHED: '_Опубликовано',
};

// Адрес сайта и репозиторий задаются ТОЛЬКО свойствами скрипта (SITE_URL, GITHUB_REPO, при желании GITHUB_BRANCH):
// Code.gs одинаковый у всех кондитерских, умолчаний «чужого» сайта нет.
const DEFAULT_GITHUB_BRANCH = 'main';
// Версия структуры таблицы: при росте сервер сам донастраивает листы (ensureMigrated_), setup() вручную не нужен.
const SCHEMA_VERSION = 2;
// Без этих столбцов «Заявок» нельзя честно посчитать места — заявки уходят в лист ожидания.
const ORDERS_CRITICAL = ['Статус', 'Дата заказа'];

const OWNER_YELLOW = '#FFF2B3';
const HEADER_BG = '#5B3A29';
const HEADER_FG = '#FFFFFF';

const SETTINGS_SPEC = [
  { key: 'acceptingOrders', label: 'Принимаем заявки (да/нет)', value: 'да', yesNo: true,
    note: '«нет» полностью останавливает приём: страница сразу показывает баннер, форма блокируется. Каталог остаётся виден.' },
  { key: 'bakeryName', label: 'Название кондитерской', value: '',
    note: 'Попадает в сообщения владельцу в Telegram и в название папки с фото-референсами.' },
  { key: 'defaultLimit', label: 'Лимит по умолчанию на день', value: 4,
    note: 'Сколько заявок со статусом «Новая» можно принять на один день, если на листе «Даты» лимит не указан.' },
  { key: 'daysAhead', label: 'Показывать дней вперёд', value: 45,
    note: 'От 1 до 180. Столько дней, начиная с сегодня, видно в календаре на странице.' },
  { key: 'fewPercent', label: 'Порог «мало мест», %', value: 25,
    note: 'Когда свободно не больше этой доли лимита, день помечается «мало мест». Последнее свободное место — всегда «мало мест».' },
  { key: 'pauseNote', label: 'Заметка на странице при остановке приёма', value: '',
    note: 'Необязательно. Показывается в баннере, когда приём остановлен. Пример: «Мы в отпуске до 20 ноября».' },
];

const DATES_HEADERS = ['Дата', 'День', 'Лимит заказов', 'Закрыть дату', 'Действующий лимит', 'Принято', 'Осталось', 'Статус', 'Комментарий'];
const DATES_NOTES = [
  'Дата. Новые дни добавляются автоматически.',
  'День недели.',
  'ЗАПОЛНЯЕТЕ ВЫ. Пусто — лимит по умолчанию из «Настроек». 0 — выходной (дата закрыта).',
  'ЗАПОЛНЯЕТЕ ВЫ. «да» — закрыть дату (отпуск, всё занято офлайн).',
  'Считается сам: 0, если дата закрыта; иначе ваш лимит или лимит по умолчанию.',
  'Считается сам: сколько заявок со статусом «Новая» на эту дату.',
  'Считается сам: лимит минус принято.',
  'Считается сам: Свободно / Мало мест / Мест нет / Закрыто. Так дата выглядит на сайте.',
  'ЗАПОЛНЯЕТЕ ВЫ. Заметки для себя — на сайте не видны.',
];
const ORDERS_HEADERS = ['Время заявки', 'Номер', 'Статус', 'Десерт', 'Начинка', 'Дата заказа', 'Получение', 'Адрес', 'Имя', 'Контакт', 'Комментарий', 'Цена-ориентир', 'Фото-референс'];
const LOG_HEADERS = ['Время', 'Заявка', 'Событие', 'Подробности'];

// ---------- Точки входа веб-приложения ----------

function doGet(e) {
  ensureMigrated_();
  try {
    const action = e && e.parameter && e.parameter.action;
    if (action === 'availability') return json_(getAvailability_());
    return json_({ ok: true, service: 'ORDER FORGE', hint: 'GET ?action=availability или POST заявки' });
  } catch (err) {
    logEvent_('', 'Ошибка при загрузке дат', errorText_(err));
    return json_({ ok: false, code: 'server_error', message: 'Не удалось загрузить свободные даты. Попробуйте ещё раз.' });
  }
}

function doPost(e) {
  ensureMigrated_();
  let payload;
  try {
    payload = JSON.parse((e && e.postData && e.postData.contents) || '');
  } catch (err) {
    return json_({ ok: false, code: 'bad_request', message: 'Не удалось прочитать заявку. Обновите страницу и попробуйте ещё раз.' });
  }
  if (payload && typeof payload.action === 'string' && payload.action.indexOf('admin.') === 0) {
    try {
      return json_(handleAdmin_(payload));
    } catch (err) {
      logEvent_('', 'Админка: ошибка сервера (' + payload.action + ')', errorText_(err));
      return json_({ ok: false, code: 'server_error', message: 'Не получилось выполнить действие. Попробуйте ещё раз; если повторится — посмотрите лист «Журнал».' });
    }
  }
  try {
    return json_(handleOrder_(payload));
  } catch (err) {
    logEvent_('', 'Ошибка сервера при заявке', errorText_(err));
    return json_({ ok: false, code: 'server_error', message: 'Не получилось отправить заявку. Попробуйте ещё раз через минуту или напишите нам в директ.' });
  }
}

/** Меню в таблице для владельца. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ORDER FORGE')
    .addItem('Подготовить таблицу (setup)', 'setup')
    .addItem('Проверить Telegram', 'testTelegram')
    .addToUi();
}

// ---------- Логика запросов ----------

function getAvailability_() {
  const ss = getSpreadsheet_();
  const datesSheet = ss.getSheetByName(SHEETS.DATES);
  const ordersSheet = ss.getSheetByName(SHEETS.ORDERS);
  if (!datesSheet || !ordersSheet || !ss.getSheetByName(SHEETS.SETTINGS)) {
    return { ok: false, code: 'not_configured', message: 'Таблица ещё не подготовлена: запустите setup() в редакторе Apps Script.' };
  }
  const settings = readSettings_(ss);
  const today = moscowToday(nowMs_());
  // Дописываем новые дни. Короткая блокировка, чтобы два запроса не добавили одну дату дважды.
  const lock = LockService.getScriptLock();
  if (lock.tryLock(5000)) {
    try {
      ensureDates_(datesSheet, settings, today);
    } finally {
      lock.releaseLock();
    }
  }
  const counts = countAccepted_(ordersSheet);
  const av = buildAvailability({
    settings: settings,
    today: today,
    days: readDays_(datesSheet),
    // Столбцы «Заявок» не найдены → честно считать места нельзя: показываем дни занятыми (заявки — в лист ожидания).
    counts: counts || allFull_(settings, today),
  });
  av.serverVersion = SERVER_VERSION;
  return av;
}

function allFull_(settings, today) {
  const out = {};
  for (let i = 0; i < settings.daysAhead; i++) out[addDays(today, i)] = 1e9;
  return out;
}

function handleOrder_(payload) {
  const catalog = getPublishedCatalog_();
  const desserts = visibleDesserts(catalog);
  if (!desserts.length) {
    return { ok: false, code: 'not_configured', message: 'Каталог ещё не опубликован. Напишите нам в директ.' };
  }
  // Быстрая проверка полей ещё до блокировки.
  const pre = validateOrder(payload, desserts);
  if (!pre.ok) return pre;

  const ss = getSpreadsheet_();
  const ordersSheet = ss.getSheetByName(SHEETS.ORDERS);
  const datesSheet = ss.getSheetByName(SHEETS.DATES);
  if (!ordersSheet || !datesSheet) {
    return { ok: false, code: 'not_configured', message: 'Приём заявок ещё не настроен. Напишите нам в директ.' };
  }

  // 1. Блокировка: защита от двух заявок на последнее место одновременно.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return { ok: false, code: 'busy', message: 'Сейчас много заявок одновременно. Нажмите «Отправить заявку» ещё раз через пару секунд.' };
  }
  const requestId = normalizeRequestId(payload.requestId);
  const cache = CacheService.getScriptCache();
  let settings, order, number, result;
  try {
    // Повтор той же отправки (браузер не дождался ответа) — возвращаем уже записанную заявку.
    const cached = requestId ? cache.get('req:' + requestId) : null;
    if (cached) return JSON.parse(cached);
    settings = readSettings_(ss);
    const today = moscowToday(nowMs_());
    const days = readDays_(datesSheet);
    const counts = countAccepted_(ordersSheet) || allFull_(settings, today);
    // 2–4. Валидация, проверка дат и мест — под блокировкой, на свежих данных.
    const prepared = prepareOrder(payload, {
      settings: settings,
      today: today,
      desserts: desserts,
      getDay: function (date) {
        const d = days[date] || {};
        return { limit: d.limit, closed: d.closed, accepted: counts[date] || 0 };
      },
    });
    if (!prepared.ok) return prepared;
    order = prepared.order;

    // 5. Номер и запись строки.
    const props = PropertiesService.getScriptProperties();
    number = formatOrderNumber(nextOrderNumber(readOrderNumbers_(ordersSheet), props.getProperty('LAST_ORDER_NUMBER')));
    props.setProperty('LAST_ORDER_NUMBER', String(parseOrderNumber(number)));
    order.number = number;
    order.row = appendOrderRow_(ordersSheet, order);
    order.photoCol = ordersCols_(ordersSheet).cols['Фото-референс'];
    SpreadsheetApp.flush();
    result = { ok: true, number: number, status: order.status, message: successMessage(order.status, order.date) };
    if (requestId) cache.put('req:' + requestId, JSON.stringify(result), 600);
  } finally {
    lock.releaseLock();
  }

  // 6. Фото и Telegram — уже после записи: их ошибки не теряют заявку.
  let photoBlob = null;
  if (order.photo) {
    try {
      const saved = savePhoto_(order, settings.bakeryName);
      photoBlob = saved.blob;
      if (order.photoCol != null) ordersSheet.getRange(order.row, order.photoCol + 1).setValue(saved.url);
    } catch (err) {
      if (order.photoCol != null) ordersSheet.getRange(order.row, order.photoCol + 1).setValue('не сохранилось — см. «Журнал»');
      logEvent_(number, 'Фото не сохранилось в Drive', errorText_(err));
    }
  }
  try {
    sendTelegram_(buildTelegramMessage(Object.assign({}, order, { hasPhoto: !!order.photo }), settings.bakeryName));
  } catch (err) {
    logEvent_(number, 'Telegram: сообщение не отправлено', errorText_(err));
  }
  if (order.photo) {
    try {
      const blob = photoBlob || photoBlob_(order);
      sendTelegramPhoto_(blob, 'Фото-референс к заявке ' + number);
    } catch (err) {
      logEvent_(number, 'Telegram: фото не отправлено', errorText_(err));
    }
  }

  // 7. Ответ сайту.
  return result;
}

// ---------- Таблица ----------

function getSpreadsheet_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Не найдена таблица: запустите setup() из редактора, открытого через «Расширения → Apps Script».');
  return SpreadsheetApp.openById(id);
}

function nowMs_() {
  return Date.now();
}

function ymdToSheetDate_(ymd) {
  const p = ymd.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}

/** Значение ячейки с датой → 'YYYY-MM-DD' (или '' если не дата). */
function cellToYmd_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return Utilities.formatDate(v, TIME_ZONE, 'yyyy-MM-dd');
  const s = String(v == null ? '' : v).trim();
  if (isValidYmd(s)) return s;
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) {
    const ymd = m[3] + '-' + pad2(Number(m[2])) + '-' + pad2(Number(m[1]));
    return isValidYmd(ymd) ? ymd : '';
  }
  return '';
}

function readSettings_(ss) {
  const sheet = ss.getSheetByName(SHEETS.SETTINGS);
  const raw = {};
  if (sheet && sheet.getLastRow() >= 2) {
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
    values.forEach(function (row) {
      const label = String(row[0]).trim();
      SETTINGS_SPEC.forEach(function (spec) {
        if (spec.label === label) raw[spec.key] = row[1];
      });
    });
  }
  return normalizeSettings(raw);
}

/** Лист «Даты» → { 'YYYY-MM-DD': { limit, closed } } */
function readDays_(sheet) {
  const result = {};
  const last = sheet.getLastRow();
  if (last < 2) return result;
  sheet.getRange(2, 1, last - 1, 4).getValues().forEach(function (row) {
    const ymd = cellToYmd_(row[0]);
    if (ymd) result[ymd] = { limit: row[2], closed: row[3] };
  });
  return result;
}

/** Столбцы «Заявок» по заголовкам (владелец мог вставить свои столбцы или переставить). */
function ordersCols_(sheet) {
  const width = Math.max(sheet.getLastColumn ? sheet.getLastColumn() : 0, ORDERS_HEADERS.length);
  const map = mapHeaders(sheet.getRange(1, 1, 1, width).getValues()[0], ORDERS_HEADERS);
  map.width = width;
  if (map.missing.length) {
    alertOnce_('orders_headers', '⚠️ <b>Лист «Заявки»</b>: не найдены столбцы ' + escapeHtml(map.missing.join(', '))
      + '. Верните заголовки в первой строке. Пока их нет, новые заявки идут в «Лист ожидания».');
  }
  return map;
}

/** Все строки «Заявок» (без шапки) с картой столбцов. */
function readOrderRows_(sheet) {
  const map = ordersCols_(sheet);
  const last = sheet.getLastRow();
  const rows = last < 2 ? [] : sheet.getRange(2, 1, last - 1, map.width).getValues();
  return { map: map, rows: rows };
}

/** Сколько заявок «Новая» на каждую дату. null — столбцы «Статус»/«Дата заказа» не найдены (посчитать нельзя). */
function countAccepted_(sheet) {
  const data = readOrderRows_(sheet);
  const c = data.map.cols;
  if (ORDERS_CRITICAL.some(function (h) { return !(h in c); })) return null;
  const counts = {};
  data.rows.forEach(function (row) {
    if (String(row[c['Статус']]).trim() !== ORDER_STATUS_LABELS.new) return;
    const ymd = cellToYmd_(row[c['Дата заказа']]);
    if (ymd) counts[ymd] = (counts[ymd] || 0) + 1;
  });
  return counts;
}

function readOrderNumbers_(sheet) {
  const data = readOrderRows_(sheet);
  const col = data.map.cols['Номер'];
  return col == null ? [] : data.rows.map(function (r) { return r[col]; });
}

function appendOrderRow_(sheet, o) {
  const values = {
    'Время заявки': new Date(nowMs_()),
    'Номер': o.number,
    'Статус': ORDER_STATUS_LABELS[o.status],
    'Десерт': sheetSafe(o.dessertName),
    'Начинка': sheetSafe(o.filling),
    'Дата заказа': ymdToSheetDate_(o.date),
    'Получение': o.pickup === 'delivery' ? 'Доставка' : 'Самовывоз',
    'Адрес': sheetSafe(o.address),
    'Имя': sheetSafe(o.name),
    'Контакт': sheetSafe(o.contact),
    'Комментарий': sheetSafe(o.comment),
    'Цена-ориентир': sheetSafe(o.priceText),
    'Фото-референс': o.photo ? 'загружается…' : 'нет',
  };
  const map = ordersCols_(sheet);
  const row = [];
  for (let i = 0; i < map.width; i++) row.push('');
  Object.keys(values).forEach(function (h) { if (h in map.cols) row[map.cols[h]] = values[h]; });
  const r = sheet.getLastRow() + 1;
  sheet.getRange(r, 1, 1, row.length).setValues([row]);
  if ('Время заявки' in map.cols) sheet.getRange(r, map.cols['Время заявки'] + 1).setNumberFormat('dd.mm.yyyy hh:mm');
  if ('Дата заказа' in map.cols) sheet.getRange(r, map.cols['Дата заказа'] + 1).setNumberFormat('dd.mm.yyyy');
  return r;
}

/** Тревога владельцу не чаще раза в час на один и тот же повод (+ запись в «Журнал»). */
function alertOnce_(key, html) {
  const cache = CacheService.getScriptCache();
  if (cache.get('alert_' + key)) return;
  cache.put('alert_' + key, '1', 3600);
  logEvent_('', 'Тревога', html.replace(/<[^>]+>/g, ''));
  notifyOwner_(html);
}

/** Добавляет на лист «Даты» недостающие дни окна [сегодня; сегодня + daysAhead). */
function ensureDates_(sheet, settings, today) {
  const existing = readDays_(sheet);
  const missing = [];
  for (let i = 0; i < settings.daysAhead; i++) {
    const ymd = addDays(today, i);
    if (!existing[ymd]) missing.push(ymd);
  }
  if (!missing.length) return 0;
  const start = sheet.getLastRow() + 1;
  const rows = missing.map(function (ymd, i) {
    const r = start + i;
    return [
      ymdToSheetDate_(ymd),
      WEEKDAYS_SHORT[weekdayIndex(ymd)],
      '',
      'нет',
      '=IF(D' + r + '="да",0,IF(C' + r + '="",SETTING_DEFAULT_LIMIT,C' + r + '))',
      '=COUNTIFS(\'' + SHEETS.ORDERS + '\'!$F:$F,A' + r + ',\'' + SHEETS.ORDERS + '\'!$C:$C,"' + ORDER_STATUS_LABELS.new + '")',
      '=MAX(0,E' + r + '-F' + r + ')',
      '=IF(E' + r + '<=0,"Закрыто",IF(G' + r + '<=0,"Мест нет",IF(G' + r + '<=MAX(1,E' + r + '*SETTING_FEW_PERCENT/100),"Мало мест","Свободно")))',
      '',
    ];
  });
  sheet.getRange(start, 1, rows.length, DATES_HEADERS.length).setValues(rows);
  formatDateRows_(sheet, start, rows.length);
  return rows.length;
}

function formatDateRows_(sheet, start, count) {
  sheet.getRange(start, 1, count, 1).setNumberFormat('dd.mm.yyyy');
  [3, 4, 9].forEach(function (col) {
    sheet.getRange(start, col, count, 1).setBackground(OWNER_YELLOW);
  });
  sheet.getRange(start, 5, count, 4).setFontColor('#6B5A50');
  sheet.getRange(start, 3, count, 1).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireNumberGreaterThanOrEqualTo(0)
      .setAllowInvalid(false)
      .setHelpText('Число заказов в этот день. Пусто — по умолчанию, 0 — выходной.')
      .build()
  );
  sheet.getRange(start, 4, count, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['да', 'нет'], true).setAllowInvalid(false).build()
  );
}

// ---------- setup(): один раз создаёт и оформляет таблицу ----------

/**
 * Запустите один раз из редактора (кнопка «Выполнить»). Повторный запуск безопасен:
 * существующие значения, даты и заявки не трогаются, добавляется только недостающее.
 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Откройте редактор через таблицу: «Расширения → Apps Script».');
  const missing = missingClientProps_();
  if (missing.length) {
    throw new Error('Сначала добавьте свойства скрипта (⚙️ Настройки проекта → Свойства скрипта): ' + missing.join(', ')
      + '. SITE_URL — адрес сайта кондитерской (https://….vercel.app), GITHUB_REPO — «владелец/репозиторий» сайта. См. docs/SETUP_GOOGLE.md.');
  }
  ss.setSpreadsheetTimeZone(TIME_ZONE);
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());

  // «Настройки»
  const st = ensureSheet_(ss, SHEETS.SETTINGS, ['Параметр', 'Значение', 'Пояснение'], 0);
  const present = {};
  if (st.getLastRow() >= 2) {
    st.getRange(2, 1, st.getLastRow() - 1, 1).getValues().forEach(function (r, i) {
      present[String(r[0]).trim()] = i + 2;
    });
  }
  SETTINGS_SPEC.forEach(function (spec) {
    let row = present[spec.label];
    if (!row) {
      row = st.getLastRow() + 1;
      const value = spec.key === 'bakeryName' ? sheetSafe(bakeryNameProp_() || DEFAULT_SETTINGS.bakeryName) : spec.value;
      st.getRange(row, 1, 1, 3).setValues([[spec.label, value, spec.note]]);
    } else {
      st.getRange(row, 3).setValue(spec.note); // пояснение обновляем, значение — нет
    }
    st.getRange(row, 2).setBackground(OWNER_YELLOW).setHorizontalAlignment('left');
    if (spec.yesNo) {
      st.getRange(row, 2).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['да', 'нет'], true).setAllowInvalid(false).build());
    }
    if (spec.key === 'defaultLimit') setNamedRange_(ss, 'SETTING_DEFAULT_LIMIT', st.getRange(row, 2));
    if (spec.key === 'fewPercent') setNamedRange_(ss, 'SETTING_FEW_PERCENT', st.getRange(row, 2));
  });
  st.setColumnWidth(1, 330);
  st.setColumnWidth(2, 160);
  st.setColumnWidth(3, 560);
  st.getRange(2, 3, Math.max(1, st.getLastRow() - 1), 1).setWrap(true).setFontColor('#6B5A50');

  // «Даты»
  const dt = ensureSheet_(ss, SHEETS.DATES, DATES_HEADERS, 1);
  DATES_NOTES.forEach(function (note, i) {
    dt.getRange(1, i + 1).setNote(note);
  });
  [3, 4, 9].forEach(function (col) {
    dt.getRange(1, col).setBackground('#8A6A2F');
  });
  dt.setColumnWidth(1, 110);
  dt.setColumnWidth(9, 280);
  // Лист «Заявки» создаём до формул «Дат», которые на него ссылаются.
  ensureSheet_(ss, SHEETS.ORDERS, ORDERS_HEADERS, 2);
  const settings = readSettings_(ss);
  ensureDates_(dt, settings, moscowToday(nowMs_()));
  const statusRange = dt.getRange('H2:H');
  dt.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Мало мест').setFontColor('#B03A5B').setBold(true).setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Мест нет').setFontColor('#9A8F88').setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Закрыто').setFontColor('#9A8F88').setItalic(true).setRanges([statusRange]).build(),
  ]);

  // «Заявки»
  const ot = ensureSheet_(ss, SHEETS.ORDERS, ORDERS_HEADERS, 2);
  ot.getRange(1, 3).setNote('«Новая» занимает место в дне. «Лист ожидания» — не занимает. Поменяйте на «Отменена», чтобы освободить место.');
  ot.getRange('C2:C').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Новая', 'Лист ожидания', 'Отменена'], true).setAllowInvalid(true).build()
  );
  ot.setColumnWidth(1, 130);
  ot.setColumnWidth(4, 200);
  ot.setColumnWidth(11, 260);
  ot.setColumnWidth(12, 190);
  ot.setColumnWidth(13, 220);

  // «Журнал»
  const lt = ensureSheet_(ss, SHEETS.LOG, LOG_HEADERS, 3);
  lt.setColumnWidth(1, 140);
  lt.setColumnWidth(3, 260);
  lt.setColumnWidth(4, 520);

  // Каталог, начинки, тексты, доступ — для админки
  setupAdminSheets_(ss);
  protectSheets_(ss);
  PropertiesService.getScriptProperties().setProperty('SCHEMA_VERSION', String(SCHEMA_VERSION));

  // Пустой «Лист1» от новой таблицы убираем, если он пустой.
  const blank = ss.getSheetByName('Лист1') || ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);

  ss.setActiveSheet(ss.getSheetByName(SHEETS.SETTINGS));
  ss.toast('Таблица готова. Следующий шаг — свойства скрипта и развертывание.', 'ORDER FORGE', 8);
  return 'ok';
}

/** Обязательные свойства для конкретной кондитерской (без них setup() и публикация не работают). */
function missingClientProps_() {
  const pr = PropertiesService.getScriptProperties();
  return ['SITE_URL', 'GITHUB_REPO'].filter(function (k) { return !String(pr.getProperty(k) || '').trim(); });
}

function bakeryNameProp_() {
  return String(PropertiesService.getScriptProperties().getProperty('BAKERY_NAME') || '').trim().slice(0, 80);
}

/**
 * Обновили Code.gs («Новая версия»), а таблица старая → один раз донастраиваем листы сами.
 * Идемпотентно (то же, что делает setup() для листов); ошибка не мешает приёму заявок.
 */
function ensureMigrated_() {
  try {
    const pr = PropertiesService.getScriptProperties();
    if (Number(pr.getProperty('SCHEMA_VERSION') || 0) >= SCHEMA_VERSION) return;
    if (!pr.getProperty('SPREADSHEET_ID')) return; // setup() ещё не запускали — мигрировать нечего
    const ss = getSpreadsheet_();
    if (!ss.getSheetByName(SHEETS.SETTINGS)) return;
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return;
    try {
      if (Number(pr.getProperty('SCHEMA_VERSION') || 0) >= SCHEMA_VERSION) return;
      setupAdminSheets_(ss);
      protectSheets_(ss);
      pr.setProperty('SCHEMA_VERSION', String(SCHEMA_VERSION));
      logEvent_('', 'Сервер обновлён', 'Таблица донастроена до версии ' + SCHEMA_VERSION + ' (Code.gs v' + SERVER_VERSION + ')');
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    try { logEvent_('', 'Обновление таблицы не удалось', errorText_(err)); } catch (e) { /* молча */ }
  }
}

/** Защита «только предупреждение»: шапки листов и служебный лист. Случайная правка спросит подтверждение. */
function protectSheets_(ss) {
  [[SHEETS.ORDERS, ORDERS_HEADERS.length], [SHEETS.DATES, DATES_HEADERS.length], [SHEETS.CATALOG, CATALOG_HEADERS.length],
    [SHEETS.TEXTS, TEXTS_HEADERS.length], [SHEETS.ACCESS, ACCESS_HEADERS.length]].forEach(function (x) {
    const sheet = ss.getSheetByName(x[0]);
    if (sheet) protectOnce_(sheet.getRange(1, 1, 1, x[1]), sheet, 'ORDER FORGE: заголовки «' + x[0] + '» — не переименовывайте, сервер ищет столбцы по ним');
  });
  const pub = ss.getSheetByName(SHEETS.PUBLISHED);
  if (pub) protectOnce_(pub.getRange(1, 1, Math.max(2, pub.getLastRow()), 4), pub, 'ORDER FORGE: служебный лист — не меняйте');
}

function protectOnce_(range, sheet, description) {
  try {
    const existing = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
    if (existing.some(function (p) { return p.getDescription() === description; })) return;
    range.protect().setDescription(description).setWarningOnly(true);
  } catch (e) { /* нет прав или тестовая среда — защита необязательна */ }
}

function ensureSheet_(ss, name, headers, index) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name, index);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground(HEADER_BG)
    .setFontColor(HEADER_FG)
    .setVerticalAlignment('middle')
    .setWrap(true);
  sheet.setFrozenRows(1);
  return sheet;
}

function setNamedRange_(ss, name, range) {
  const existing = ss.getNamedRanges().filter(function (r) { return r.getName() === name; });
  if (existing.length) existing[0].setRange(range);
  else ss.setNamedRange(name, range);
}

function logEvent_(number, event, details) {
  try {
    const ss = getSpreadsheet_();
    let sheet = ss.getSheetByName(SHEETS.LOG);
    if (!sheet) sheet = ensureSheet_(ss, SHEETS.LOG, LOG_HEADERS, 3);
    sheet.appendRow([new Date(nowMs_()), sheetSafe(number || ''), sheetSafe(scrubSecrets_(event)), sheetSafe(scrubSecrets_(details).slice(0, 1000))]);
  } catch (e) {
    console.error('Журнал недоступен: ' + scrubSecrets_(event) + ' — ' + scrubSecrets_(details));
  }
  console.warn('[ORDER FORGE] ' + (number || '') + ' ' + scrubSecrets_(event) + ': ' + scrubSecrets_(details));
}

/** Убирает из текста всё, похожее на токены (Telegram, GitHub, Google ID-токен). */
function scrubSecrets_(text) {
  return String(text == null ? '' : text)
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***')
    .replace(/\d{6,}:[A-Za-z0-9_-]{30,}/g, '***')
    .replace(/(github_pat_|ghp_|gho_|ghs_)[A-Za-z0-9_]+/g, '$1***')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '***');
}

function errorText_(err) {
  return scrubSecrets_(String((err && (err.stack || err.message)) || err));
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- Фото-референс (Google Drive) ----------

function photoBlob_(order) {
  const ext = order.photo.type === 'image/png' ? 'png' : order.photo.type === 'image/webp' ? 'webp' : 'jpg';
  return Utilities.newBlob(Utilities.base64Decode(order.photo.data), order.photo.type, order.number + '.' + ext);
}

function savePhoto_(order, bakeryName) {
  const blob = photoBlob_(order);
  const folder = getPhotoFolder_(bakeryName);
  const file = folder.createFile(blob);
  file.setDescription('Фото-референс к заявке ' + order.number);
  return { url: file.getUrl(), blob: blob };
}

function getPhotoFolder_(bakeryName) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('PHOTO_FOLDER_ID');
  if (id) {
    try {
      return DriveApp.getFolderById(id);
    } catch (e) {
      // папку удалили — создадим новую
    }
  }
  const name = bakeryName + ' — референсы';
  const found = DriveApp.getFoldersByName(name);
  const folder = found.hasNext() ? found.next() : DriveApp.createFolder(name);
  props.setProperty('PHOTO_FOLDER_ID', folder.getId());
  return folder;
}

// ---------- Telegram ----------

function telegramConfig_() {
  const props = PropertiesService.getScriptProperties();
  const token = (props.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  const chatId = (props.getProperty('TELEGRAM_CHAT_ID') || '').trim();
  if (!token || !chatId) throw new Error('Не заданы свойства скрипта TELEGRAM_BOT_TOKEN и/или TELEGRAM_CHAT_ID.');
  return { token: token, chatId: chatId };
}

function telegramCall_(method, options) {
  const cfg = telegramConfig_();
  const url = 'https://api.telegram.org/bot' + cfg.token + '/' + method;
  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res;
    try {
      res = UrlFetchApp.fetch(url, Object.assign({ method: 'post', muteHttpExceptions: true }, options(cfg.chatId)));
    } catch (e) {
      // Текст сетевой ошибки Apps Script содержит URL с токеном — не пропускаем его дальше.
      lastError = 'Telegram ' + method + ': сеть недоступна';
      Utilities.sleep(1000);
      continue;
    }
    const code = res.getResponseCode();
    if (code === 200) return JSON.parse(res.getContentText());
    // В текст ошибки не попадает URL с токеном — только ответ Telegram.
    lastError = 'Telegram ' + method + ' ответил ' + code + ': ' + res.getContentText().slice(0, 300);
    if (code >= 400 && code < 500 && code !== 429) break;
    Utilities.sleep(1000);
  }
  throw new Error(lastError);
}

function sendTelegram_(text) {
  return telegramCall_('sendMessage', function (chatId) {
    return {
      contentType: 'application/json',
      payload: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true }),
    };
  });
}

function sendTelegramPhoto_(blob, caption) {
  return telegramCall_('sendPhoto', function (chatId) {
    return { payload: { chat_id: chatId, caption: caption, photo: blob } };
  });
}

/** Запустите из редактора, чтобы проверить токен и chat_id: в группу придёт тестовое сообщение. */
function testTelegram() {
  const settings = readSettings_(getSpreadsheet_());
  sendTelegram_('✅ <b>ORDER FORGE подключён</b>\nЗаявки с сайта «' + escapeHtml(settings.bakeryName) + '» будут приходить сюда.');
  return 'Сообщение отправлено — проверьте группу в Telegram.';
}

// =====================================================================
// АДМИНКА: вход, доступ, каталог (черновик), фото, даты, заявки, публикация.
// Страница сайта /admin.html шлёт сюда POST { action: 'admin.*', token, ... }.
// Секреты (пароль, токен GitHub) — только в «Свойствах скрипта», в ответы не попадают.
// =====================================================================

const SESSION_HOURS = 12;
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_SECONDS = 15 * 60;
const PASSWORD_ITERATIONS = 1000;
const ORDER_STATUSES = ['Новая', 'Лист ожидания', 'Отменена'];

const CATALOG_HEADERS = ['Код', 'Показывать', 'Название', 'Описание', 'Начинки', 'Цена от', 'Цена до', 'Единица', 'Срок, дней', 'Бейдж', 'Фото', 'Описание фото'];
const FILLINGS_HEADERS = ['Начинка', 'Описание'];
const TEXTS_HEADERS = ['Поле', 'Текст', 'Код поля'];
const ACCESS_HEADERS = ['Почта Google', 'Имя', 'Доступ', 'Последний вход'];

// ---------- Маршрутизация ----------

function handleAdmin_(p) {
  const action = String(p.action);
  // Без входа доступны только эти действия.
  if (action === 'admin.config') return adminConfig_();
  if (action === 'admin.login') return adminLogin_(p);

  const session = checkSession_(p.token);
  if (!session) return { ok: false, code: 'unauthorized', message: 'Сессия закончилась — войдите снова.' };
  const who = session.email || 'вход по паролю';

  switch (action) {
    case 'admin.me': return { ok: true, email: session.email || '', method: session.method, owner: ownerEmail_() };
    case 'admin.logout': deleteSession_(p.token); return { ok: true };
    case 'admin.catalog.get': return adminCatalogGet_();
    case 'admin.dessert.save': return withLock_(function () { return adminDessertSave_(p, who); });
    case 'admin.dessert.delete': return withLock_(function () { return adminDessertDelete_(p, who); });
    case 'admin.reorder': return withLock_(function () { return adminReorder_(p, who); });
    case 'admin.fillings.save': return withLock_(function () { return adminFillingsSave_(p, who); });
    case 'admin.texts.save': return withLock_(function () { return adminTextsSave_(p, who); });
    case 'admin.photo.upload': return withLock_(function () { return adminPhotoUpload_(p, who); });
    case 'admin.photo.preview': return adminPhotoPreview_(p);
    case 'admin.days.get': return adminDaysGet_();
    case 'admin.day.set': return withLock_(function () { return adminDaySet_(p, who); });
    case 'admin.settings.get': return { ok: true, settings: readSettings_(getSpreadsheet_()) };
    case 'admin.settings.set': return withLock_(function () { return adminSettingsSet_(p, who); });
    case 'admin.orders.list': return adminOrdersList_(p);
    case 'admin.order.setStatus': return withLock_(function () { return adminOrderSetStatus_(p, who); });
    case 'admin.access.list': return adminAccessList_();
    case 'admin.access.save': return withLock_(function () { return adminAccessSave_(p, who); });
    case 'admin.access.delete': return withLock_(function () { return adminAccessDelete_(p, who); });
    case 'admin.password.set': return adminPasswordSet_(p, who);
    case 'admin.sessions.revoke': return adminSessionsRevoke_(p.token, who);
    case 'admin.publish': return adminPublish_(who);
    default: return { ok: false, code: 'bad_request', message: 'Неизвестное действие.' };
  }
}

function withLock_(fn, ms) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(ms || 20000)) return { ok: false, code: 'busy', message: 'Сервер занят — повторите через пару секунд.' };
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function props_() {
  return PropertiesService.getScriptProperties();
}

function adminConfig_() {
  const pr = props_();
  const googleEnabled = !!(pr.getProperty('GOOGLE_CLIENT_ID') || '').trim();
  // Одноразовый nonce: Google вшивает его в ID-токен, сервер принимает токен только с живым nonce.
  let nonce = '';
  if (googleEnabled) {
    nonce = randomToken_().slice(0, 32);
    CacheService.getScriptCache().put('gnonce_' + nonce, '1', 600);
  }
  return {
    ok: true,
    googleEnabled: googleEnabled,
    nonce: nonce,
    passwordEnabled: !!(pr.getProperty('ADMIN_PASSWORD_HASH') || pr.getProperty('ADMIN_PASSWORD')),
    bakeryName: readSettings_(getSpreadsheet_()).bakeryName,
    serverVersion: SERVER_VERSION,
    // Что не настроено — админка покажет предупреждение (сами значения не раскрываем).
    setupProblems: missingClientProps_().concat(pr.getProperty('GITHUB_TOKEN') ? [] : ['GITHUB_TOKEN']),
  };
}

// ---------- Вход и сессии ----------

function ownerEmail_() {
  const fromProp = (props_().getProperty('OWNER_EMAIL') || '').trim().toLowerCase();
  if (fromProp) return fromProp;
  try {
    return String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  } catch (e) {
    return '';
  }
}

function hexOf_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function sha256Hex_(text) {
  return hexOf_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8));
}

function hashPassword_(password, salt) {
  let h = salt + ':' + password;
  for (let i = 0; i < PASSWORD_ITERATIONS; i++) h = sha256Hex_(h + ':' + salt);
  return h;
}

function safeEqual_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

/** '' — пароль подходит, иначе текст проблемы. */
function passwordProblem_(pw) {
  pw = String(pw || '');
  if (pw.length < 8) return 'Пароль — не короче 8 символов.';
  if (/^(.)\1+$/.test(pw) || /^(12345678|123456789|password|qwertyui|пароль12|11111111)/i.test(pw)) return 'Слишком простой пароль — придумайте другой.';
  return '';
}

/** Первичный пароль из свойства ADMIN_PASSWORD сразу превращается в хэш, открытое значение удаляется. */
function migratePlainPassword_() {
  const pr = props_();
  const plain = pr.getProperty('ADMIN_PASSWORD');
  if (plain) {
    if (passwordProblem_(plain)) return passwordProblem_(plain) + ' Поменяйте свойство ADMIN_PASSWORD.';
    const salt = Utilities.getUuid();
    pr.setProperty('ADMIN_PASSWORD_SALT', salt);
    pr.setProperty('ADMIN_PASSWORD_HASH', hashPassword_(plain, salt));
    pr.deleteProperty('ADMIN_PASSWORD');
  }
  return '';
}

/** Неверный пароль. Счётчик уже увеличен в adminLogin_ (до проверки, под блокировкой). */
function loginFailed_(reason, fails) {
  // Журнал не раздуваем: пишем первые попытки и каждую десятую.
  if (fails <= LOGIN_MAX_FAILS || fails % 10 === 0) logEvent_('', 'Админка: неудачный вход', reason + (fails ? ' (попытка ' + fails + ')' : ''));
  if (fails === LOGIN_MAX_FAILS) {
    notifyOwner_('⚠️ <b>Админка: ' + LOGIN_MAX_FAILS + ' неудачных попыток входа</b>\nВход по паролю заблокирован на 15 минут. Если это были не вы — смените пароль.');
  }
  return { ok: false, code: 'login_failed', message: 'Неверный пароль или нет доступа.' };
}

function adminLogin_(p) {
  const cache = CacheService.getScriptCache();
  let email = '';
  let method = '';
  if (p.google) {
    if (!(props_().getProperty('GOOGLE_CLIENT_ID') || '').trim()) {
      return { ok: false, code: 'google_disabled', message: 'Вход через Google не настроен — войдите по паролю.' };
    }
    // Отдельный лимит для Google-попыток: не трогает вход по паролю и не тратит квоту запросов.
    const gFails = Number(cache.get('google_fails') || 0);
    if (gFails >= 20) return { ok: false, code: 'locked', message: 'Слишком много попыток входа через Google. Подождите 15 минут.' };
    const v = verifyGoogleToken_(String(p.google), String(p.nonce || ''));
    if (!v.ok) {
      cache.put('google_fails', String(gFails + 1), LOGIN_LOCK_SECONDS);
      if (gFails < 5) logEvent_('', 'Админка: неудачный вход через Google', v.reason);
      return { ok: false, code: 'login_failed', message: 'Не получилось войти через Google. Обновите страницу и попробуйте ещё раз.' };
    }
    if (!isAllowedEmail_(v.email)) {
      logEvent_('', 'Админка: нет доступа', v.email);
      return { ok: false, code: 'forbidden', message: 'У почты ' + v.email + ' нет доступа к админке. Попросите владельца добавить её на лист «Доступ».' };
    }
    email = v.email;
    method = 'google';
  } else if (p.password != null) {
    // Счётчик попыток увеличиваем ДО проверки и под блокировкой — параллельные запросы не обойдут лимит.
    const attempt = withLock_(function () {
      const n = Number(cache.get('admin_fails') || 0);
      if (n >= LOGIN_MAX_FAILS) return -1;
      cache.put('admin_fails', String(n + 1), LOGIN_LOCK_SECONDS);
      return n + 1;
    }, 10000);
    if (attempt === -1) return { ok: false, code: 'locked', message: 'Слишком много неудачных попыток. Вход по паролю заблокирован на 15 минут — или войдите через Google.' };
    if (typeof attempt !== 'number') return attempt; // сервер занят
    const weak = migratePlainPassword_();
    if (weak) return { ok: false, code: 'weak_password', message: weak };
    const pr = props_();
    const hash = pr.getProperty('ADMIN_PASSWORD_HASH');
    const salt = pr.getProperty('ADMIN_PASSWORD_SALT');
    if (!hash || !salt) return { ok: false, code: 'no_password', message: 'Пароль ещё не задан. Владелец задаёт его в свойствах скрипта (ADMIN_PASSWORD) или в админке.' };
    if (!safeEqual_(hashPassword_(String(p.password), salt), hash)) {
      loginFailed_('неверный пароль', attempt);
      return { ok: false, code: 'login_failed', message: 'Неверный пароль.' };
    }
    method = 'password';
  } else {
    return { ok: false, code: 'bad_request', message: 'Нужен пароль или вход через Google.' };
  }
  cache.remove('admin_fails');
  const token = randomToken_();
  const exp = nowMs_() + SESSION_HOURS * 3600 * 1000;
  const pr = props_();
  cleanupSessions_();
  pr.setProperty('sess_' + sha256Hex_(token), JSON.stringify({ email: email, method: method, exp: exp, epoch: Number(pr.getProperty('SESSION_EPOCH') || 0) }));
  if (email) markLastLogin_(email);
  logEvent_('', 'Админка: вход', email || 'по паролю');
  notifyOwner_('✅ <b>Вход в админку</b>: ' + escapeHtml(email || 'по паролю'));
  return { ok: true, token: token, email: email, method: method, expiresAt: exp };
}

function verifyGoogleToken_(idToken, nonce) {
  const clientId = (props_().getProperty('GOOGLE_CLIENT_ID') || '').trim();
  if (!clientId) return { ok: false, reason: 'вход через Google не настроен (GOOGLE_CLIENT_ID)' };
  if (idToken.length > 4096) return { ok: false, reason: 'слишком длинный токен' };
  const cache = CacheService.getScriptCache();
  if (!/^[a-f0-9]{32}$/.test(nonce) || !cache.get('gnonce_' + nonce)) return { ok: false, reason: 'устаревшая страница входа (nonce)' };
  cache.remove('gnonce_' + nonce); // одноразовый
  let res;
  try {
    // Токен — в теле запроса, не в адресе (адрес может попасть в текст ошибки).
    res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo', { method: 'post', payload: { id_token: idToken }, muteHttpExceptions: true });
  } catch (e) {
    return { ok: false, reason: 'Google недоступен' };
  }
  if (res.getResponseCode() !== 200) return { ok: false, reason: 'токен не принят Google' };
  let info;
  try { info = JSON.parse(res.getContentText()); } catch (e) { return { ok: false, reason: 'ответ Google не прочитан' }; }
  if (info.aud !== clientId) return { ok: false, reason: 'токен выписан для другого сайта' };
  if (['accounts.google.com', 'https://accounts.google.com'].indexOf(info.iss) < 0) return { ok: false, reason: 'неверный издатель токена' };
  if (!(info.email_verified === true || info.email_verified === 'true')) return { ok: false, reason: 'почта не подтверждена' };
  if (!(Number(info.exp) * 1000 > nowMs_())) return { ok: false, reason: 'токен просрочен' };
  if (info.nonce !== nonce) return { ok: false, reason: 'nonce не совпадает' };
  return { ok: true, email: String(info.email || '').toLowerCase() };
}

/** Почта может входить: владелец таблицы всегда, остальные — по листу «Доступ». */
function isAllowedEmail_(email) {
  email = String(email || '').trim().toLowerCase();
  if (!email) return false;
  if (email === ownerEmail_()) return true;
  return readAccess_().some(function (a) { return a.email === email && a.enabled; });
}

function checkSession_(token) {
  if (!token || !/^[a-f0-9]{64}$/.test(String(token))) return null;
  const pr = props_();
  const raw = pr.getProperty('sess_' + sha256Hex_(String(token)));
  if (!raw) return null;
  let s;
  try { s = JSON.parse(raw); } catch (e) { return null; }
  if (!(s.exp > nowMs_()) || s.epoch !== Number(pr.getProperty('SESSION_EPOCH') || 0)) {
    pr.deleteProperty('sess_' + sha256Hex_(String(token)));
    return null;
  }
  // Доступ проверяется при каждом действии: убрали почту из «Доступа» — сессия перестаёт работать сразу.
  if (s.method === 'google' && !isAllowedEmail_(s.email)) return null;
  return s;
}

function deleteSession_(token) {
  if (token) props_().deleteProperty('sess_' + sha256Hex_(String(token)));
}

function cleanupSessions_() {
  const pr = props_();
  const all = pr.getProperties();
  const epoch = Number(all.SESSION_EPOCH || 0);
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('sess_') !== 0) return;
    try {
      const s = JSON.parse(all[k]);
      if (!(s.exp > nowMs_()) || s.epoch !== epoch) pr.deleteProperty(k);
    } catch (e) {
      pr.deleteProperty(k);
    }
  });
}

function adminSessionsRevoke_(currentToken, who) {
  const pr = props_();
  pr.setProperty('SESSION_EPOCH', String(Number(pr.getProperty('SESSION_EPOCH') || 0) + 1));
  cleanupSessions_();
  logEvent_('', 'Админка: все сессии завершены', who);
  notifyOwner_('🚪 <b>Админка: все сессии завершены</b> (' + escapeHtml(who) + ')');
  return { ok: true, message: 'Все входы завершены — войдите снова.' };
}

function adminPasswordSet_(p, who) {
  const pw = String(p.password || '');
  const problem = passwordProblem_(pw);
  if (problem) return { ok: false, code: 'validation', message: problem };
  const pr = props_();
  const salt = Utilities.getUuid();
  pr.setProperty('ADMIN_PASSWORD_SALT', salt);
  pr.setProperty('ADMIN_PASSWORD_HASH', hashPassword_(pw, salt));
  pr.deleteProperty('ADMIN_PASSWORD');
  // Все, кто вошёл по старому паролю, выходят.
  const all = pr.getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('sess_') !== 0) return;
    try { if (JSON.parse(all[k]).method === 'password') pr.deleteProperty(k); } catch (e) { pr.deleteProperty(k); }
  });
  logEvent_('', 'Админка: пароль изменён', who);
  notifyOwner_('🔑 <b>Пароль админки изменён</b> (' + escapeHtml(who) + ')');
  return { ok: true, message: 'Пароль изменён. Все, кто входил по старому паролю, вышли.' };
}

/** Уведомление владельцу в Telegram; ошибка не мешает действию. */
function notifyOwner_(html) {
  try {
    sendTelegram_(html);
  } catch (e) {
    console.warn('Telegram недоступен: ' + e);
  }
}

// ---------- Лист «Доступ» ----------

function readAccess_() {
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.ACCESS);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, ACCESS_HEADERS.length).getValues()
    .map(function (r, i) {
      return { row: i + 2, email: String(r[0]).trim().toLowerCase(), name: String(r[1]).trim(), enabled: parseYesNo(r[2], false), lastLogin: r[3] instanceof Date ? r[3].toISOString() : String(r[3] || '') };
    })
    .filter(function (a) { return a.email; });
}

function markLastLogin_(email) {
  const a = readAccess_().filter(function (x) { return x.email === email; })[0];
  if (a) getSpreadsheet_().getSheetByName(SHEETS.ACCESS).getRange(a.row, 4).setValue(new Date(nowMs_())).setNumberFormat('dd.mm.yyyy hh:mm');
}

function adminAccessList_() {
  return {
    ok: true,
    owner: ownerEmail_(),
    people: readAccess_().map(function (a) { return { email: a.email, name: a.name, enabled: a.enabled, lastLogin: a.lastLogin }; }),
    passwordEnabled: !!props_().getProperty('ADMIN_PASSWORD_HASH'),
  };
}

function adminAccessSave_(p, who) {
  const email = String(p.email || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._%+-]*@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) || email.length > 120) return { ok: false, code: 'validation', message: 'Укажите почту Google, например name@gmail.com' };
  const name = cleanText(p.name, 60);
  const enabled = p.enabled !== false;
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ACCESS);
  const existing = readAccess_().filter(function (a) { return a.email === email; })[0];
  if (existing) {
    sheet.getRange(existing.row, 2, 1, 2).setValues([[sheetSafe(name), enabled ? 'да' : 'нет']]);
  } else {
    if (readAccess_().length >= 50) return { ok: false, code: 'validation', message: 'Не больше 50 администраторов.' };
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, 4).setValues([[sheetSafe(email), sheetSafe(name), enabled ? 'да' : 'нет', '']]);
  }
  const text = (existing ? (enabled ? 'доступ включён' : 'доступ выключен') : 'добавлен доступ') + ': ' + email;
  logEvent_('', 'Админка: ' + text, who);
  notifyOwner_((enabled ? '➕' : '➖') + ' <b>Админка</b>: ' + escapeHtml(text) + ' (' + escapeHtml(who) + ')');
  return adminAccessList_();
}

function adminAccessDelete_(p, who) {
  const email = String(p.email || '').trim().toLowerCase();
  const a = readAccess_().filter(function (x) { return x.email === email; })[0];
  if (!a) return { ok: false, code: 'not_found', message: 'Такой почты нет в списке.' };
  getSpreadsheet_().getSheetByName(SHEETS.ACCESS).deleteRow(a.row);
  logEvent_('', 'Админка: удалён доступ: ' + email, who);
  notifyOwner_('➖ <b>Админка</b>: удалён доступ ' + escapeHtml(email) + ' (' + escapeHtml(who) + ')');
  return adminAccessList_();
}

// ---------- Опубликованный каталог ----------

function siteUrl_() {
  return String(props_().getProperty('SITE_URL') || '').trim().replace(/\/+$/, '');
}

function readSnapshot_() {
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.PUBLISHED);
  if (!sheet || sheet.getLastRow() < 2) return null;
  const raw = String(sheet.getRange(2, 1).getValue() || '');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { logEvent_('', 'Каталог: лист «_Опубликовано» повреждён', errorText_(e)); return null; }
}

/**
 * Каталог, по которому проверяются заявки: то, что сейчас на сайте (кэш 10 мин), или снимок последней публикации —
 * что новее по номеру версии. Так правки каталога, сделанные не из админки (разработчиком), тоже учитываются.
 */
function getPublishedCatalog_() {
  const snap = readSnapshot_();
  let site = null;
  if (siteUrl_()) {
    try { site = fetchSiteCatalog_(); } catch (e) { if (!snap) throw e; }
  }
  if (!snap) {
    if (!site) throw new Error('Каталог не найден: задайте свойство скрипта SITE_URL (адрес сайта).');
    return site;
  }
  if (site && (Number(site.version) || 0) > (Number(snap.version) || 0)) {
    savePublished_(site, 'с сайта', 'сайт');
    return site;
  }
  return snap;
}

function fetchSiteCatalog_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('site_catalog');
  if (cached) return JSON.parse(cached);
  if (!siteUrl_()) throw new Error('Не задано свойство скрипта SITE_URL (адрес сайта).');
  const res = UrlFetchApp.fetch(siteUrl_() + '/data/catalog.json', { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Не удалось загрузить каталог с сайта (' + res.getResponseCode() + '). Проверьте свойство SITE_URL.');
  const text = res.getContentText();
  const catalog = JSON.parse(text);
  if (text.length < 90000) cache.put('site_catalog', text, 600);
  return catalog;
}

function savePublished_(catalog, commit, who) {
  const ss = getSpreadsheet_();
  const sheet = ensureSheet_(ss, SHEETS.PUBLISHED, ['Каталог (JSON)', 'Когда', 'Кто', 'Коммит'], ss.getSheets().length);
  sheet.getRange(2, 1, 1, 4).setValues([[JSON.stringify(catalog), new Date(nowMs_()), sheetSafe(who || catalog.publishedBy || ''), commit || '']]);
  if (commit !== 'с сайта') CacheService.getScriptCache().remove('site_catalog');
}

// ---------- Черновик каталога (листы «Каталог», «Начинки», «Тексты») ----------

function dessertToRow_(d) {
  return [d.id, d.visible === false ? 'нет' : 'да', sheetSafe(d.name), sheetSafe(d.description), sheetSafe((d.fillings || []).join('; ')),
    d.priceMin, d.priceMax, sheetSafe(d.unit), d.leadDays, sheetSafe(d.badge || ''),
    // Фото: путь на сайте (с «.jpg», если файлы jpg) или ссылка на черновик в Drive.
    (d.image || '') + (d.imageExt === 'jpg' && String(d.image || '').indexOf('images/') === 0 ? '.jpg' : ''), sheetSafe(d.alt || '')];
}

function rowToDessert_(r) {
  return {
    id: String(r[0]).trim(), visible: parseYesNo(r[1], true), name: String(r[2]), description: String(r[3]),
    fillings: String(r[4]).split(';').map(function (f) { return f.trim(); }).filter(Boolean),
    priceMin: r[5], priceMax: r[6], unit: String(r[7]), leadDays: r[8], badge: String(r[9]),
    image: String(r[10]).trim().replace(/\.jpg$/, ''), alt: String(r[11]),
    imageExt: /\.jpg$|\|jpg$/.test(String(r[10]).trim()) ? 'jpg' : 'webp',
  };
}

function readDraft_() {
  const ss = getSpreadsheet_();
  const cs = ss.getSheetByName(SHEETS.CATALOG);
  const fs = ss.getSheetByName(SHEETS.FILLINGS);
  const ts = ss.getSheetByName(SHEETS.TEXTS);
  if (!cs || !fs || !ts) throw new Error('Нет листов каталога — запустите setup() в редакторе Apps Script.');
  const desserts = cs.getLastRow() < 2 ? [] : cs.getRange(2, 1, cs.getLastRow() - 1, CATALOG_HEADERS.length).getValues()
    .filter(function (r) { return String(r[0]).trim(); }).map(rowToDessert_);
  const fillings = fs.getLastRow() < 2 ? [] : fs.getRange(2, 1, fs.getLastRow() - 1, 2).getValues()
    .filter(function (r) { return String(r[0]).trim(); }).map(function (r) { return { name: String(r[0]).trim(), description: String(r[1]).trim() }; });
  const texts = {};
  if (ts.getLastRow() >= 2) {
    ts.getRange(2, 1, ts.getLastRow() - 1, 3).getValues().forEach(function (r) {
      const key = String(r[2]).trim();
      if (findTextField(key)) texts[key] = String(r[1]);
    });
  }
  return { desserts: desserts, fillings: fillings, texts: texts };
}

function writeDesserts_(desserts) {
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.CATALOG);
  const last = sheet.getLastRow();
  if (last >= 2) sheet.getRange(2, 1, last - 1, CATALOG_HEADERS.length).clearContent();
  if (desserts.length) sheet.getRange(2, 1, desserts.length, CATALOG_HEADERS.length).setValues(desserts.map(dessertToRow_));
}

function writeFillings_(items) {
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.FILLINGS);
  const last = sheet.getLastRow();
  if (last >= 2) sheet.getRange(2, 1, last - 1, 2).clearContent();
  if (items.length) sheet.getRange(2, 1, items.length, 2).setValues(items.map(function (f) { return [sheetSafe(f.name), sheetSafe(f.description)]; }));
}

function writeTexts_(catalogLike) {
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.TEXTS);
  const last = sheet.getLastRow();
  if (last >= 2) sheet.getRange(2, 1, last - 1, 3).clearContent();
  sheet.getRange(2, 1, TEXT_FIELDS.length, 3).setValues(TEXT_FIELDS.map(function (f) {
    return [f.label, sheetSafe(readTextField(catalogLike, f.key)), f.key];
  }));
}

function adminCatalogGet_() {
  const published = getPublishedCatalog_();
  const draft = readDraft_();
  return {
    ok: true,
    draft: draft,
    textFields: TEXT_FIELDS,
    published: { version: published.version, publishedAt: published.publishedAt, publishedBy: published.publishedBy },
    changes: draftChanges(published, draft),
    problems: validateCatalog(draftCatalog(published, draft)),
    siteUrl: siteUrl_(),
  };
}

function adminDessertSave_(p, who) {
  const draft = readDraft_();
  const input = p.dessert || {};
  if (!input.id) input.id = slugify(input.name);
  const prevId = String(p.originalId || input.id);
  const idx = draft.desserts.map(function (d) { return d.id; }).indexOf(prevId);
  // Фото, если не прислали новое, остаётся прежним.
  if (!input.image && idx >= 0) input.image = draft.desserts[idx].image;
  const v = validateDessertDraftAdmin_(input);
  if (!v.ok) return { ok: false, code: 'validation', message: 'Проверьте поля карточки.', errors: v.errors };
  if (draft.desserts.some(function (d, i) { return d.id === v.dessert.id && i !== idx; })) {
    return { ok: false, code: 'validation', message: 'Такой код уже есть у другого десерта.', errors: { id: 'Код занят — придумайте другой' } };
  }
  if (idx < 0 && draft.desserts.length >= 40) return { ok: false, code: 'validation', message: 'В каталоге не больше 40 десертов — скройте или удалите лишние.' };
  if (idx >= 0) draft.desserts[idx] = v.dessert;
  else draft.desserts.push(v.dessert);
  writeDesserts_(draft.desserts);
  logEvent_('', 'Админка: сохранён десерт «' + v.dessert.name + '»', who);
  return adminCatalogGet_();
}

/** Как validateDessertDraft, но фото из черновика (drive:…) тоже допустимо. */
function validateDessertDraftAdmin_(input) {
  const image = String(input.image || '');
  if (image.indexOf('drive:') === 0) {
    const v = validateDessertDraft(Object.assign({}, input, { image: 'images/draft' }));
    v.dessert.image = parseOwnPhotoRef_(image) ? image : '';
    if (!v.dessert.image) { v.ok = false; v.errors.image = 'Фото повреждено — загрузите заново'; }
    return v;
  }
  return validateDessertDraft(input);
}

function adminDessertDelete_(p, who) {
  const draft = readDraft_();
  const before = draft.desserts.length;
  draft.desserts = draft.desserts.filter(function (d) { return d.id !== p.id; });
  if (draft.desserts.length === before) return { ok: false, code: 'not_found', message: 'Десерт не найден.' };
  writeDesserts_(draft.desserts);
  logEvent_('', 'Админка: удалён десерт ' + p.id, who);
  return adminCatalogGet_();
}

function adminReorder_(p, who) {
  const draft = readDraft_();
  const ids = Array.isArray(p.ids) ? p.ids.map(String) : [];
  if (ids.length !== draft.desserts.length || ids.some(function (id) { return !draft.desserts.some(function (d) { return d.id === id; }); })) {
    return { ok: false, code: 'validation', message: 'Список изменился — обновите страницу.' };
  }
  writeDesserts_(ids.map(function (id) { return draft.desserts.filter(function (d) { return d.id === id; })[0]; }));
  logEvent_('', 'Админка: изменён порядок десертов', who);
  return adminCatalogGet_();
}

function adminFillingsSave_(p, who) {
  const items = (Array.isArray(p.items) ? p.items : []).map(function (f) {
    return { name: cleanText(f && f.name, 80), description: cleanText(f && f.description, 300) };
  }).filter(function (f) { return f.name; });
  if (items.length > 40) return { ok: false, code: 'validation', message: 'Не больше 40 начинок.' };
  writeFillings_(items);
  logEvent_('', 'Админка: сохранены начинки', who);
  return adminCatalogGet_();
}

function adminTextsSave_(p, who) {
  const texts = p.texts || {};
  const draft = readDraft_();
  const probe = draftCatalog(getPublishedCatalog_(), draft);
  const errors = {};
  Object.keys(texts).forEach(function (k) {
    const err = applyTextField(probe, k, texts[k]);
    if (err) errors[k] = err;
  });
  if (Object.keys(errors).length) return { ok: false, code: 'validation', message: 'Проверьте тексты.', errors: errors };
  writeTexts_(probe);
  logEvent_('', 'Админка: сохранены тексты', who);
  return adminCatalogGet_();
}

// ---------- Фото каталога ----------

function catalogPhotoFolder_() {
  const pr = props_();
  const id = pr.getProperty('CATALOG_PHOTO_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* создадим заново */ }
  }
  const folder = DriveApp.createFolder(readSettings_(getSpreadsheet_()).bakeryName + ' — фото каталога (черновики)');
  pr.setProperty('CATALOG_PHOTO_FOLDER_ID', folder.getId());
  return folder;
}

// Фото принимаются только из тех, что загрузила сама админка (иначе по id можно было бы
// прочитать или опубликовать любой файл с Диска владельца).
const MAX_OWN_PHOTOS = 120;

function ownPhotoIds_() {
  try { return JSON.parse(props_().getProperty('CATALOG_PHOTO_IDS') || '[]'); } catch (e) { return []; }
}

function rememberOwnPhotos_(ids) {
  const list = ownPhotoIds_().concat(ids);
  props_().setProperty('CATALOG_PHOTO_IDS', JSON.stringify(list.slice(-MAX_OWN_PHOTOS)));
}

function forgetOwnPhotos_(ids) {
  props_().setProperty('CATALOG_PHOTO_IDS', JSON.stringify(ownPhotoIds_().filter(function (x) { return ids.indexOf(x) < 0; })));
}

/** drive:<id480>|<id900>|ext → { ids, ext } только для своих фото, иначе null. */
function parseOwnPhotoRef_(ref) {
  const m = String(ref || '').match(/^drive:([\w-]+)\|([\w-]+)(?:\|(webp|jpg))?$/);
  if (!m) return null;
  const own = ownPhotoIds_();
  if (own.indexOf(m[1]) < 0 || own.indexOf(m[2]) < 0) return null;
  return { ids: [m[1], m[2]], ext: m[3] === 'jpg' ? 'jpg' : 'webp' };
}

function adminPhotoUpload_(p, who) {
  const id = String(p.dessertId || '');
  if (!/^[a-z0-9-]{2,40}$/.test(id)) return { ok: false, code: 'validation', message: 'Сначала сохраните карточку (нужен код десерта).' };
  const sizes = { w480: p.w480, w900: p.w900 };
  const ext = p.type === 'image/jpeg' ? 'jpg' : 'webp';
  const mime = ext === 'jpg' ? 'image/jpeg' : 'image/webp';
  const ids = [];
  const folder = catalogPhotoFolder_();
  const stamp = String(nowMs_());
  for (const k of ['w480', 'w900']) {
    const data = String(sizes[k] || '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length > 2 * 1024 * 1024) return { ok: false, code: 'validation', message: 'Фото повреждено или слишком большое — выберите другое.' };
    const bytes = Utilities.base64Decode(data);
    if (!looksLikeImage_(bytes, ext)) return { ok: false, code: 'validation', message: 'Это не фото WebP/JPEG — выберите другое.' };
    const blob = Utilities.newBlob(bytes, mime, id + '-' + stamp + '-' + k.slice(1) + '.' + ext);
    ids.push(folder.createFile(blob).getId());
  }
  rememberOwnPhotos_(ids);
  const ref = 'drive:' + ids[0] + '|' + ids[1] + '|' + ext;
  // Если карточка уже есть — сразу ставим фото в черновик.
  const draft = readDraft_();
  const d = draft.desserts.filter(function (x) { return x.id === id; })[0];
  if (d) {
    d.image = ref;
    d.imageExt = ext;
    writeDesserts_(draft.desserts);
  }
  logEvent_('', 'Админка: загружено фото для ' + id, who);
  return { ok: true, ref: ref };
}

/** Проверка «магических байтов»: WebP начинается с RIFF…WEBP, JPEG — с FF D8. */
function looksLikeImage_(bytes, ext) {
  const b = function (i) { return bytes[i] & 0xff; };
  if (ext === 'jpg') return bytes.length > 3 && b(0) === 0xff && b(1) === 0xd8;
  return bytes.length > 12 && b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50;
}

function adminPhotoPreview_(p) {
  const ph = parseOwnPhotoRef_(p.ref);
  if (!ph) return { ok: false, code: 'validation', message: 'Нет такого фото.' };
  const blob = DriveApp.getFileById(ph.ids[0]).getBlob();
  return { ok: true, dataUrl: 'data:image/' + (ph.ext === 'jpg' ? 'jpeg' : 'webp') + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

// ---------- Даты, приём, заявки ----------

function adminDaysGet_() {
  const ss = getSpreadsheet_();
  const settings = readSettings_(ss);
  const today = moscowToday(nowMs_());
  const dt = ss.getSheetByName(SHEETS.DATES);
  ensureDates_(dt, settings, today);
  const av = buildAvailability({ settings: settings, today: today, days: readDays_(dt), counts: countAccepted_(ss.getSheetByName(SHEETS.ORDERS)) });
  const raw = readDays_(dt);
  av.dates.forEach(function (d) {
    const r = raw[d.date] || {};
    d.customLimit = r.limit === '' || r.limit == null ? '' : Number(r.limit);
    d.closedFlag = parseYesNo(r.closed, false);
  });
  return Object.assign({ ok: true, settings: settings }, av);
}

function adminDaySet_(p, who) {
  const date = String(p.date || '');
  if (!isValidYmd(date)) return { ok: false, code: 'validation', message: 'Неверная дата.' };
  const limit = p.limit === '' || p.limit == null ? '' : toInt(p.limit);
  if (limit !== '' && !(limit >= 0 && limit <= 999)) return { ok: false, code: 'validation', message: 'Лимит — число от 0 до 999 или пусто.' };
  const dt = getSpreadsheet_().getSheetByName(SHEETS.DATES);
  const last = dt.getLastRow();
  const rows = last < 2 ? [] : dt.getRange(2, 1, last - 1, 1).getValues();
  let rowIdx = -1;
  rows.forEach(function (r, i) { if (cellToYmd_(r[0]) === date) rowIdx = i + 2; });
  if (rowIdx < 0) return { ok: false, code: 'not_found', message: 'Этой даты нет на листе «Даты».' };
  dt.getRange(rowIdx, 3, 1, 2).setValues([[limit, p.closed ? 'да' : 'нет']]);
  logEvent_('', 'Админка: дата ' + date + ' — лимит ' + (limit === '' ? 'по умолчанию' : limit) + (p.closed ? ', закрыта' : ''), who);
  return adminDaysGet_();
}

function adminSettingsSet_(p, who) {
  const st = getSpreadsheet_().getSheetByName(SHEETS.SETTINGS);
  const values = st.getRange(2, 1, st.getLastRow() - 1, 2).getValues();
  const patch = p.settings || {};
  const check = normalizeSettings(Object.assign({}, readSettings_(getSpreadsheet_()), patch));
  SETTINGS_SPEC.forEach(function (spec) {
    if (!(spec.key in patch) || spec.key === 'bakeryName') return;
    values.forEach(function (row, i) {
      if (String(row[0]).trim() !== spec.label) return;
      let v = check[spec.key];
      if (spec.key === 'acceptingOrders') v = v ? 'да' : 'нет';
      st.getRange(i + 2, 2).setValue(spec.key === 'pauseNote' ? sheetSafe(v) : v);
    });
  });
  logEvent_('', 'Админка: изменены настройки приёма', who + ' — ' + JSON.stringify(patch).slice(0, 300));
  if ('acceptingOrders' in patch) notifyOwner_((check.acceptingOrders ? '▶️ <b>Приём заявок открыт</b>' : '⏸ <b>Приём заявок остановлен</b>') + ' (' + escapeHtml(who) + ')');
  return { ok: true, settings: readSettings_(getSpreadsheet_()) };
}

function adminOrdersList_(p) {
  const data = readOrderRows_(getSpreadsheet_().getSheetByName(SHEETS.ORDERS));
  const c = data.map.cols;
  const limit = Math.min(200, Math.max(1, toInt(p.limit) || 100));
  const get = function (r, h) { return h in c ? r[c[h]] : ''; };
  const orders = data.rows.map(function (r, i) {
    const t = get(r, 'Время заявки');
    return {
      createdAt: t instanceof Date ? t.toISOString() : String(t), number: String(get(r, 'Номер')), status: String(get(r, 'Статус')),
      dessert: String(get(r, 'Десерт')), filling: String(get(r, 'Начинка')), date: cellToYmd_(get(r, 'Дата заказа')),
      pickup: String(get(r, 'Получение')), address: String(get(r, 'Адрес')), name: String(get(r, 'Имя')),
      contact: String(get(r, 'Контакт')).replace(/^'/, ''), comment: String(get(r, 'Комментарий')),
      price: String(get(r, 'Цена-ориентир')), photo: String(get(r, 'Фото-референс')),
      _t: t instanceof Date ? t.getTime() : 0, _i: i,
    };
  }).filter(function (o) { return o.number; });
  // Свежие сверху — по времени заявки (владелец мог отсортировать лист как угодно).
  orders.sort(function (a, b) { return (b._t - a._t) || (b._i - a._i); });
  return { ok: true, orders: orders.slice(0, limit).map(function (o) { delete o._t; delete o._i; return o; }) };
}

function adminOrderSetStatus_(p, who) {
  if (ORDER_STATUSES.indexOf(p.status) < 0) return { ok: false, code: 'validation', message: 'Неизвестный статус.' };
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.ORDERS);
  const data = readOrderRows_(sheet);
  const c = data.map.cols;
  if (!('Номер' in c) || !('Статус' in c)) return { ok: false, code: 'not_configured', message: 'На листе «Заявки» нет столбца «Номер» или «Статус».' };
  let row = -1;
  data.rows.forEach(function (r, i) { if (String(r[c['Номер']]) === String(p.number)) row = i + 2; });
  if (row < 0) return { ok: false, code: 'not_found', message: 'Заявка не найдена.' };
  sheet.getRange(row, c['Статус'] + 1).setValue(p.status);
  logEvent_(String(p.number), 'Админка: статус → ' + p.status, who);
  return { ok: true };
}

// ---------- Публикация в GitHub ----------

function githubConfig_() {
  const pr = props_();
  const token = (pr.getProperty('GITHUB_TOKEN') || '').trim();
  if (!token) throw new Error('Не задано свойство скрипта GITHUB_TOKEN — публикация невозможна (см. docs/SETUP_GOOGLE.md).');
  const repo = (pr.getProperty('GITHUB_REPO') || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Не задано свойство скрипта GITHUB_REPO в виде «владелец/репозиторий» — публикация невозможна (см. docs/SETUP_GOOGLE.md).');
  return {
    token: token,
    repo: repo,
    branch: (pr.getProperty('GITHUB_BRANCH') || DEFAULT_GITHUB_BRANCH).trim(),
  };
}

/** data/catalog.json из репозитория (то, что сейчас в main) или null. */
function githubCatalog_(cfg) {
  try {
    const r = githubApi_(cfg, 'get', '/contents/data/catalog.json?ref=' + encodeURIComponent(cfg.branch));
    if (!r || !r.content) return null;
    const text = Utilities.newBlob(Utilities.base64Decode(String(r.content).replace(/\s/g, ''))).getDataAsString('UTF-8');
    return JSON.parse(text);
  } catch (err) {
    logEvent_('', 'Публикация: не удалось прочитать каталог из репозитория — беру снимок', errorText_(err));
    return null;
  }
}

function githubApi_(cfg, method, path, body) {
  const res = UrlFetchApp.fetch('https://api.github.com/repos/' + cfg.repo + path, {
    method: method,
    contentType: 'application/json',
    payload: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  // В текст ошибки не попадает токен — только код и ответ GitHub.
  if (code < 200 || code >= 300) throw new Error('GitHub ' + method.toUpperCase() + ' ' + path + ' → ' + code + ': ' + res.getContentText().slice(0, 300));
  return JSON.parse(res.getContentText() || '{}');
}

/** Один коммит в ветку: files = [{ path, content (строка) | base64 }]. */
function githubCommit_(files, message) {
  const cfg = githubConfig_();
  const ref = githubApi_(cfg, 'get', '/git/ref/heads/' + cfg.branch);
  const parentSha = ref.object.sha;
  const parent = githubApi_(cfg, 'get', '/git/commits/' + parentSha);
  const tree = files.map(function (f) {
    const blob = githubApi_(cfg, 'post', '/git/blobs', f.base64 != null ? { content: f.base64, encoding: 'base64' } : { content: f.content, encoding: 'utf-8' });
    return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha };
  });
  const newTree = githubApi_(cfg, 'post', '/git/trees', { base_tree: parent.tree.sha, tree: tree });
  const commit = githubApi_(cfg, 'post', '/git/commits', { message: message, tree: newTree.sha, parents: [parentSha] });
  githubApi_(cfg, 'patch', '/git/refs/heads/' + cfg.branch, { sha: commit.sha, force: false });
  return { sha: commit.sha, url: 'https://github.com/' + cfg.repo + '/commit/' + commit.sha };
}

/**
 * Публикация. Общий замок (им же пользуются заявки покупателей) берём только на короткие шаги:
 * снять копию черновика и записать результат. Запросы к GitHub и Диску идут без замка,
 * поэтому заявки не получают «Сервер занят», пока публикуется каталог.
 */
function adminPublish_(who) {
  const cache = CacheService.getScriptCache();
  if (cache.get('publishing')) return { ok: false, code: 'busy', message: 'Публикация уже идёт — подождите минуту и обновите страницу.' };
  let draft;
  const taken = withLock_(function () {
    if (cache.get('publishing')) return { ok: false, code: 'busy', message: 'Публикация уже идёт — подождите минуту и обновите страницу.' };
    draft = readDraft_();
    cache.put('publishing', '1', 180);
    return { ok: true };
  });
  if (!taken.ok) return taken;
  try {
    return publishDraft_(draft, who);
  } finally {
    cache.remove('publishing');
  }
}

function publishDraft_(draft, who) {
  let cfg;
  try {
    cfg = githubConfig_();
  } catch (err) {
    return { ok: false, code: 'not_configured', message: String(err.message || err) };
  }
  // База — то, что сейчас лежит в репозитории: так не затираются правки, сделанные не из админки.
  const published = githubCatalog_(cfg) || getPublishedCatalog_();
  const changes = draftChanges(published, draft);
  if (!changes.length) return { ok: false, code: 'nothing', message: 'Нет изменений для публикации.' };

  // Фото из черновиков → файлы images/catalog/… в том же коммите.
  const files = [];
  const photoRefs = {};
  const usedDriveIds = [];
  let foreign = '';
  const draftRefs = {};
  draft.desserts.forEach(function (d) {
    if (String(d.image || '').indexOf('drive:') !== 0) return;
    const ph = parseOwnPhotoRef_(d.image);
    if (!ph) { foreign = d.name; return; }
    draftRefs[d.id] = d.image;
    const base = 'images/catalog/' + d.id + '-' + String(nowMs_()).slice(-8);
    files.push({ path: base + '-480.' + ph.ext, base64: Utilities.base64Encode(DriveApp.getFileById(ph.ids[0]).getBlob().getBytes()) });
    files.push({ path: base + '-900.' + ph.ext, base64: Utilities.base64Encode(DriveApp.getFileById(ph.ids[1]).getBlob().getBytes()) });
    usedDriveIds.push(ph.ids[0], ph.ids[1]);
    photoRefs[d.id] = base;
    d.image = base;
    d.imageExt = ph.ext;
  });
  if (foreign) return { ok: false, code: 'validation', message: 'У «' + foreign + '» фото не из админки — загрузите фото заново.' };
  if (draft.desserts.length > 40) return { ok: false, code: 'validation', message: 'В каталоге больше 40 десертов — скройте или удалите лишние.' };

  // Автор в публичном каталоге — нейтральный; почта остаётся только в «Журнале» и на листе «_Опубликовано».
  const next = buildPublishedCatalog(published, draft, { nowMs: nowMs_(), by: 'админка' });
  if (JSON.stringify(next).length > 45000) return { ok: false, code: 'validation', message: 'Каталог слишком большой — сократите описания или число десертов.' };
  const problems = validateCatalog(next);
  if (problems.length) return { ok: false, code: 'validation', message: 'Исправьте перед публикацией: ' + problems.slice(0, 5).join('; ') + '.', problems: problems };

  files.push({ path: 'data/catalog.json', content: JSON.stringify(next, null, 2) + '\n' });
  files.push({ path: 'data/catalog.js', content: catalogToJsModule(next) });
  let commit;
  try {
    commit = githubCommit_(files, 'Каталог v' + next.version + ': публикация из админки\n\nИзменения: ' + changes.join(', '));
  } catch (err) {
    logEvent_('', 'Админка: публикация не удалась', errorText_(err));
    return { ok: false, code: 'publish_failed', message: 'Не удалось опубликовать: ' + String(err.message || err).slice(0, 200) + ' Черновик сохранён — попробуйте ещё раз.' };
  }

  withLock_(function () {
    savePublished_(next, commit.sha, who);
    // Фото в черновике теперь указывают на опубликованные файлы. Черновик перечитываем:
    // пока шла публикация, его могли изменить — чужие правки не затираем.
    if (Object.keys(photoRefs).length) {
      const current = readDraft_();
      current.desserts.forEach(function (d) {
        if (photoRefs[d.id] && d.image === draftRefs[d.id]) {
          const pub = (next.desserts || []).filter(function (x) { return x.id === d.id; })[0];
          d.image = photoRefs[d.id];
          if (pub && pub.imageExt) d.imageExt = pub.imageExt; else delete d.imageExt;
        }
      });
      writeDesserts_(current.desserts);
    }
    return { ok: true };
  }, 30000);
  usedDriveIds.forEach(function (id) { try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { /* не страшно */ } });
  if (usedDriveIds.length) forgetOwnPhotos_(usedDriveIds);
  logEvent_('', 'Админка: каталог v' + next.version + ' опубликован', who + ' — ' + changes.join(', ') + ' — ' + commit.url);
  notifyOwner_('📢 <b>Каталог опубликован</b> (v' + next.version + ', ' + escapeHtml(who) + ')\nИзменения: ' + escapeHtml(changes.join(', ')) + '\nСайт обновится примерно через минуту.');
  return { ok: true, version: next.version, commit: commit.sha, commitUrl: commit.url, message: 'Опубликовано. Сайт обновится примерно через минуту.' };
}

// ---------- setup() для админки ----------

function setupAdminSheets_(ss) {
  const pr = props_();
  try {
    const me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
    if (me) pr.setProperty('OWNER_EMAIL', me);
  } catch (e) { /* без почты владельца — вход только по листу «Доступ» и паролю */ }

  const cs = ensureSheet_(ss, SHEETS.CATALOG, CATALOG_HEADERS, ss.getSheets().length);
  const fs = ensureSheet_(ss, SHEETS.FILLINGS, FILLINGS_HEADERS, ss.getSheets().length);
  const ts = ensureSheet_(ss, SHEETS.TEXTS, TEXTS_HEADERS, ss.getSheets().length);
  const as = ensureSheet_(ss, SHEETS.ACCESS, ACCESS_HEADERS, ss.getSheets().length);
  ensureSheet_(ss, SHEETS.PUBLISHED, ['Каталог (JSON)', 'Когда', 'Кто', 'Коммит'], ss.getSheets().length);

  as.getRange(1, 1).setNote('Почты Google, которым можно входить в админку (кнопка «Войти через Google»). Владелец таблицы может входить всегда.');
  as.getRange(1, 3).setNote('«да» — может входить, «нет» — доступ выключен (сразу, даже если человек уже вошёл).');
  as.getRange('C2:C200').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['да', 'нет'], true).setAllowInvalid(false).build());
  as.getRange('A2:C200').setBackground(OWNER_YELLOW);
  as.setColumnWidth(1, 260); as.setColumnWidth(2, 160); as.setColumnWidth(4, 150);

  cs.getRange(1, 1).setNote('Черновик каталога. Меняйте в админке (/admin.html) или здесь; на сайт попадёт после «Опубликовать».');
  cs.getRange('B2:B200').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['да', 'нет'], true).setAllowInvalid(false).build());
  cs.setColumnWidth(3, 220); cs.setColumnWidth(4, 320); cs.setColumnWidth(5, 280);
  ts.getRange(1, 3).setNote('Служебный код — не меняйте.');
  ts.setColumnWidth(1, 300); ts.setColumnWidth(2, 520); ts.setColumnWidth(3, 160);
  const pub = ss.getSheetByName(SHEETS.PUBLISHED);
  try { pub.hideSheet(); } catch (e) { /* в тестах */ }

  // Заполняем черновик из опубликованного каталога, если листы пустые.
  if (cs.getLastRow() < 2 || fs.getLastRow() < 2 || ts.getLastRow() < 2) {
    let catalog = null;
    try {
      catalog = getPublishedCatalog_();
    } catch (e) {
      logEvent_('', 'setup(): не удалось загрузить каталог с сайта', errorText_(e));
    }
    if (catalog) {
      if (pub.getLastRow() < 2) savePublished_(catalog, 'с сайта');
      if (cs.getLastRow() < 2) writeDesserts_((catalog.desserts || []).map(function (d) { return validateDessertDraft(d).dessert; }));
      if (fs.getLastRow() < 2) writeFillings_(((catalog.fillings || {}).items) || []);
      if (ts.getLastRow() < 2) writeTexts_(catalog);
    }
  }
}
