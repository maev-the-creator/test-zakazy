// Встроенный тестовый бэкенд (демо-режим). Работает по той же логике, что и Apps Script:
// функции берутся из js/logic.generated.js — копии блока PURE LOGIC из Code.gs.
// Используется:
//   • в браузере, когда в config.js пустой APPS_SCRIPT_URL (данные — в localStorage);
//   • в tools/mock-server.mjs для нагрузочного теста (данные — в памяти).
import * as L from './logic.generated.js';
import { CATALOG } from '../data/catalog.js';

const STATE_VERSION = 2;

/** Хранилище в памяти (Node, тесты). */
export function memoryStorage() {
  let data = null;
  return {
    load: () => (data ? JSON.parse(data) : null),
    save: (s) => { data = JSON.stringify(s); },
    clear: () => { data = null; },
  };
}

/** Хранилище в localStorage (браузер). Если localStorage недоступен — в памяти. */
export function localStorageStorage(key = 'orderforge-demo') {
  const mem = memoryStorage();
  const safe = (fn, fallback) => { try { return fn(); } catch (e) { return fallback(); } };
  return {
    load: () => safe(() => JSON.parse(window.localStorage.getItem(key) || 'null'), mem.load),
    save: (s) => safe(() => window.localStorage.setItem(key, JSON.stringify(s)), () => mem.save(s)),
    clear: () => safe(() => window.localStorage.removeItem(key), mem.clear),
  };
}

/**
 * Демо-занятость, чтобы календарь выглядел «живым»: несколько дней «мало мест»,
 * пара занятых выходных и один выходной день кондитера. Только для демо-режима.
 */
function demoSeed(today) {
  const counts = {};
  const days = {};
  const at = (offset) => L.addDays(today, offset);
  // Ближайшие дни после минимального срока
  counts[at(2)] = 3; // мало мест
  counts[at(3)] = 1;
  // Выходные: первые две субботы заняты, воскресенья — мало мест
  let saturdays = 0;
  for (let i = 2; i < 40; i++) {
    const d = at(i);
    const w = L.weekdayIndex(d);
    if (w === 5) {
      saturdays++;
      counts[d] = saturdays <= 2 ? 4 : saturdays === 3 ? 3 : 2;
    }
    if (w === 6 && saturdays <= 3) counts[d] = 3;
    if (w === 4 && saturdays === 1) counts[d] = 2; // пятница перед второй субботой
  }
  // Один понедельник — выходной кондитера (лимит 0)
  for (let i = 6; i < 20; i++) {
    if (L.weekdayIndex(at(i)) === 0) { days[at(i)] = { limit: 0, closed: 'нет' }; break; }
  }
  return { counts, days };
}

function initialState(today, { seed, settings }) {
  const s = seed ? demoSeed(today) : { counts: {}, days: {} };
  return {
    version: STATE_VERSION,
    createdFor: today,
    settings: Object.assign({}, L.DEFAULT_SETTINGS, settings || {}),
    days: s.days,
    seedCounts: s.counts,
    orders: [],
    counter: 0,
  };
}

/**
 * opts: { storage, now: () => ms, latencyMs, seed: true, settings: { defaultLimit, ... },
 *         getCatalog: () => каталог (по умолчанию data/catalog.js) }
 */
export function createMockBackend(opts = {}) {
  const getDesserts = () => L.visibleDesserts((opts.getCatalog || (() => CATALOG))());
  const storage = opts.storage || memoryStorage();
  const now = opts.now || (() => Date.now());
  const latencyMs = opts.latencyMs == null ? 0 : opts.latencyMs;
  const seed = opts.seed !== false;
  const wait = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

  function load() {
    const today = L.moscowToday(now());
    let state = storage.load();
    // Пересоздаём демо-данные, если они устарели больше чем на неделю или формат поменялся.
    if (!state || state.version !== STATE_VERSION || L.diffDays(state.createdFor, today) > 7) {
      state = initialState(today, { seed, settings: opts.settings });
      storage.save(state);
    }
    return state;
  }

  function counts(state) {
    const c = Object.assign({}, state.seedCounts);
    state.orders.forEach((o) => {
      if (o.status === 'new') c[o.date] = (c[o.date] || 0) + 1;
    });
    return c;
  }

  // Последовательная очередь — аналог LockService.getScriptLock().
  let queue = Promise.resolve();
  function withLock(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  async function availability() {
    await wait(latencyMs);
    const state = load();
    return L.buildAvailability({
      settings: L.normalizeSettings(state.settings),
      today: L.moscowToday(now()),
      days: state.days,
      counts: counts(state),
    });
  }

  async function submit(payload) {
    const pre = L.validateOrder(payload, getDesserts());
    if (!pre.ok) { await wait(latencyMs); return pre; }
    return withLock(async () => {
      const state = load();
      const requestId = L.normalizeRequestId(payload.requestId);
      state.requests = state.requests || {};
      if (requestId && state.requests[requestId]) return state.requests[requestId];
      const settings = L.normalizeSettings(state.settings);
      const today = L.moscowToday(now());
      const c = counts(state);
      // Имитация чтения таблицы под блокировкой.
      await wait(latencyMs);
      const prepared = L.prepareOrder(payload, {
        settings,
        desserts: getDesserts(),
        today,
        getDay: (date) => {
          const d = state.days[date] || {};
          return { limit: d.limit, closed: d.closed, accepted: c[date] || 0 };
        },
      });
      if (!prepared.ok) return prepared;
      const order = prepared.order;
      const n = L.nextOrderNumber(state.orders.map((o) => o.number), state.counter);
      const number = L.formatOrderNumber(n);
      state.counter = n;
      state.orders.push({
        number,
        status: order.status,
        createdAt: new Date(now()).toISOString(),
        dessertId: order.dessertId,
        dessertName: order.dessertName,
        filling: order.filling,
        date: order.date,
        pickup: order.pickup,
        address: order.address,
        name: order.name,
        contact: order.contact,
        comment: order.comment,
        priceText: order.priceText,
        hasPhoto: !!order.photo, // само фото в демо не храним
      });
      const result = { ok: true, number, status: order.status, message: L.successMessage(order.status, order.date) };
      if (requestId) state.requests[requestId] = result;
      storage.save(state);
      // Текст, который ушёл бы владельцу в Telegram — для отладки и демонстрации.
      const telegramText = L.buildTelegramMessage(Object.assign({}, order, { number, hasPhoto: !!order.photo }), settings.bakeryName);
      return Object.assign({}, result, { telegramPreview: telegramText });
    });
  }

  function update(fn) {
    const state = load();
    fn(state);
    storage.save(state);
  }

  return {
    availability,
    submit,
    /** Включить/остановить приём (демо-переключатель ?demo=paused). */
    setAccepting: (on, note = '') => update((s) => { s.settings.acceptingOrders = on ? 'да' : 'нет'; s.settings.pauseNote = note; }),
    setDay: (ymd, day) => update((s) => { s.days[ymd] = Object.assign({}, s.days[ymd], day); }),
    setSettings: (patch) => update((s) => { Object.assign(s.settings, patch); }),
    orders: () => load().orders.slice(),
    reset: () => storage.clear(),
    // Для демо-админки:
    getSettings: () => L.normalizeSettings(load().settings),
    setOrderStatus: (number, status) => update((s) => {
      const o = s.orders.find((x) => x.number === number);
      if (o) o.status = status === 'Новая' ? 'new' : status === 'Лист ожидания' ? 'waitlist' : 'cancelled';
    }),
    days: async () => {
      const av = await availability();
      const state = load();
      av.dates.forEach((d) => {
        const r = state.days[d.date] || {};
        d.customLimit = r.limit === '' || r.limit == null ? '' : Number(r.limit);
        d.closedFlag = L.parseYesNo(r.closed, false);
      });
      return Object.assign({ settings: L.normalizeSettings(state.settings) }, av);
    },
  };
}
