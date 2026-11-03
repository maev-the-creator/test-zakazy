// АВТОМАТИЧЕСКИ СГЕНЕРИРОВАНО из apps-script/Code.gs командой `npm run sync-logic`.
// Не редактируйте вручную — правьте Code.gs и запустите синхронизацию.
/* eslint-disable */
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

export {
  pad2,
  ymdFromUtcDate,
  moscowToday,
  isValidYmd,
  ymdToUtcMs,
  addDays,
  diffDays,
  weekdayIndex,
  formatDateLong,
  formatDateShort,
  formatDateWeekday,
  pluralRu,
  daysWord,
  parseYesNo,
  toNumberOr,
  clamp,
  normalizeSettings,
  effectiveLimit,
  isFew,
  computeDayStatus,
  isInWindow,
  buildAvailability,
  findDessert,
  earliestDateFor,
  formatRub,
  priceRangeText,
  cleanText,
  normalizeContact,
  validateOrder,
  decideOrder,
  prepareOrder,
  formatOrderNumber,
  parseOrderNumber,
  nextOrderNumber,
  successMessage,
  escapeHtml,
  buildTelegramMessage,
  normalizeRequestId,
  sheetSafe,
  getPath,
  setPath,
  findTextField,
  readTextField,
  applyTextField,
  slugify,
  toInt,
  validateDessertDraft,
  visibleDesserts,
  validateCatalog,
  buildPublishedCatalog,
  catalogToJsModule,
  draftCatalog,
  stripCatalogMeta,
  draftChanges,
  mapHeaders,
  TIME_ZONE,
  MOSCOW_UTC_OFFSET_MS,
  DAY_MS,
  SERVER_VERSION,
  DEFAULT_SETTINGS,
  DAY_STATUS_LABELS,
  ORDER_STATUS_LABELS,
  FIELD_LIMITS,
  PHOTO_TYPES,
  WEEKDAYS_SHORT,
  WEEKDAYS_LONG,
  MONTHS_GENITIVE,
  MONTHS_NOMINATIVE,
  TEXT_FIELDS,
  TRANSLIT,
};
