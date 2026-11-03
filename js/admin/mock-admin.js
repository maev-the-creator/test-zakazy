// Демо-админка: те же действия, что admin.* в Apps Script, но данные — в localStorage этого браузера.
// Включается, когда в config.js пустой APPS_SCRIPT_URL. «Опубликовать» обновляет витрину только в этом браузере.
import * as L from '../logic.generated.js';
import { CATALOG } from '../../data/catalog.js';
import { CONFIG } from '../../config.js';
import { DEMO_CATALOG_KEY, demoPublishedCatalog } from '../api.js';

export const DEMO_PASSWORD = 'demo-admin';
const KEY = 'orderforge-demo:admin';
const SESSION_MS = 12 * 3600 * 1000;

const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
const write = (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* квота — демо */ } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');

function published() {
  return demoPublishedCatalog() || CATALOG;
}

function initialState() {
  const p = published();
  const texts = {};
  L.TEXT_FIELDS.forEach((f) => { texts[f.key] = L.readTextField(p, f.key); });
  return {
    draft: {
      desserts: p.desserts.map((d) => Object.assign(L.validateDessertDraft(d).dessert, d.imageSrc ? { imageSrc: d.imageSrc } : {})),
      fillings: ((p.fillings || {}).items || []).map((f) => ({ ...f })),
      texts,
    },
    photos: {},
    sessions: {},
    access: [{ email: 'olga.cakes@gmail.com', name: 'Ольга (пример)', enabled: true, lastLogin: '' }],
    password: DEMO_PASSWORD,
    fails: 0,
  };
}

export function createMockAdmin({ backend }) {
  let state = read() || initialState();
  const save = () => write(state);

  function catalogGet() {
    const pub = published();
    const draft = { ...state.draft, desserts: state.draft.desserts.map(({ imageSrc, ...d }) => d) };
    return {
      ok: true,
      draft: state.draft,
      textFields: L.TEXT_FIELDS,
      published: { version: pub.version, publishedAt: pub.publishedAt, publishedBy: pub.publishedBy },
      changes: L.draftChanges(pub, draft),
      problems: L.validateCatalog(L.draftCatalog(pub, draft)),
      siteUrl: new URL('./', location.href).href,
      demo: true,
    };
  }

  const handlers = {
    'admin.config': () => ({ ok: true, googleEnabled: false, passwordEnabled: true, bakeryName: CONFIG.bakery.name, demo: true, demoPassword: DEMO_PASSWORD, serverVersion: L.SERVER_VERSION, setupProblems: [] }),
    'admin.login': (p) => {
      if (p.google) return { ok: false, code: 'login_failed', message: 'В демо-режиме вход через Google выключен.' };
      if (state.fails >= 5) return { ok: false, code: 'locked', message: 'Слишком много неудачных попыток. В демо — очистите данные сайта или подождите.' };
      if (String(p.password) !== state.password) {
        state.fails += 1; save();
        return { ok: false, code: 'login_failed', message: 'Неверный пароль или нет доступа.' };
      }
      state.fails = 0;
      const t = token();
      state.sessions[t] = Date.now() + SESSION_MS;
      save();
      return { ok: true, token: t, email: '', method: 'password', expiresAt: state.sessions[t] };
    },
    'admin.me': () => ({ ok: true, email: '', method: 'password', owner: 'owner@gmail.com (демо)' }),
    'admin.logout': (p) => { delete state.sessions[p.token]; save(); return { ok: true }; },
    'admin.catalog.get': catalogGet,
    'admin.dessert.save': (p) => {
      const input = { ...(p.dessert || {}) };
      if (!input.id) input.id = L.slugify(input.name);
      const prevId = String(p.originalId || input.id);
      const idx = state.draft.desserts.findIndex((d) => d.id === prevId);
      const prev = idx >= 0 ? state.draft.desserts[idx] : null;
      if (!input.image && prev) input.image = prev.image;
      if (!input.imageExt && prev) input.imageExt = prev.imageExt;
      const v = L.validateDessertDraft(input);
      if (!v.ok) return { ok: false, code: 'validation', message: 'Проверьте поля карточки.', errors: v.errors };
      if (state.draft.desserts.some((d, i) => d.id === v.dessert.id && i !== idx)) {
        return { ok: false, code: 'validation', message: 'Такой код уже есть у другого десерта.', errors: { id: 'Код занят — придумайте другой' } };
      }
      const photo = state.photos[v.dessert.image];
      const next = photo ? { ...v.dessert, imageSrc: photo.w900 } : prev && prev.image === v.dessert.image && prev.imageSrc ? { ...v.dessert, imageSrc: prev.imageSrc } : v.dessert;
      if (idx >= 0) state.draft.desserts[idx] = next; else state.draft.desserts.push(next);
      save();
      return catalogGet();
    },
    'admin.dessert.delete': (p) => {
      state.draft.desserts = state.draft.desserts.filter((d) => d.id !== p.id);
      save();
      return catalogGet();
    },
    'admin.reorder': (p) => {
      const ids = p.ids || [];
      if (ids.length !== state.draft.desserts.length) return { ok: false, code: 'validation', message: 'Список изменился — обновите страницу.' };
      state.draft.desserts = ids.map((id) => state.draft.desserts.find((d) => d.id === id)).filter(Boolean);
      save();
      return catalogGet();
    },
    'admin.fillings.save': (p) => {
      state.draft.fillings = (p.items || []).map((f) => ({ name: String(f.name || '').trim(), description: String(f.description || '').trim() })).filter((f) => f.name);
      save();
      return catalogGet();
    },
    'admin.texts.save': (p) => {
      const probe = L.draftCatalog(published(), state.draft);
      const errors = {};
      Object.entries(p.texts || {}).forEach(([k, v]) => { const e = L.applyTextField(probe, k, v); if (e) errors[k] = e; });
      if (Object.keys(errors).length) return { ok: false, code: 'validation', message: 'Проверьте тексты.', errors };
      L.TEXT_FIELDS.forEach((f) => { state.draft.texts[f.key] = L.readTextField(probe, f.key); });
      save();
      return catalogGet();
    },
    'admin.photo.upload': (p) => {
      if (!/^[a-z0-9-]{2,40}$/.test(String(p.dessertId || ''))) return { ok: false, code: 'validation', message: 'Сначала сохраните карточку (нужен код десерта).' };
      const ext = p.type === 'image/jpeg' ? 'jpg' : 'webp';
      const ref = `drive:demo${Date.now()}a|demo${Date.now()}b|${ext}`;
      const mime = ext === 'jpg' ? 'image/jpeg' : 'image/webp';
      state.photos = { [ref]: { w900: `data:${mime};base64,${p.w900}` } }; // храним только последнее фото — квота localStorage
      const d = state.draft.desserts.find((x) => x.id === p.dessertId);
      if (d) { d.image = ref; d.imageExt = ext; d.imageSrc = state.photos[ref].w900; }
      save();
      return { ok: true, ref };
    },
    'admin.photo.preview': (p) => {
      const ph = state.photos[p.ref];
      return ph ? { ok: true, dataUrl: ph.w900 } : { ok: false, code: 'not_found', message: 'Нет такого фото.' };
    },
    'admin.days.get': async () => ({ ok: true, ...(await backend.days()) }),
    'admin.day.set': async (p) => {
      backend.setDay(p.date, { limit: p.limit === '' || p.limit == null ? '' : Number(p.limit), closed: p.closed ? 'да' : 'нет' });
      return { ok: true, ...(await backend.days()) };
    },
    'admin.settings.get': () => ({ ok: true, settings: backend.getSettings() }),
    'admin.settings.set': (p) => {
      const patch = { ...(p.settings || {}) };
      if ('acceptingOrders' in patch) patch.acceptingOrders = patch.acceptingOrders ? 'да' : 'нет';
      backend.setSettings(patch);
      return { ok: true, settings: backend.getSettings() };
    },
    'admin.orders.list': () => ({
      ok: true,
      orders: backend.orders().slice().reverse().map((o) => ({
        createdAt: o.createdAt, number: o.number, status: o.status === 'new' ? 'Новая' : o.status === 'waitlist' ? 'Лист ожидания' : 'Отменена',
        dessert: o.dessertName, filling: o.filling, date: o.date, pickup: o.pickup === 'delivery' ? 'Доставка' : 'Самовывоз',
        address: o.address, name: o.name, contact: o.contact, comment: o.comment, price: o.priceText, photo: o.hasPhoto ? 'есть (в демо не сохраняется)' : 'нет',
      })),
    }),
    'admin.order.setStatus': (p) => { backend.setOrderStatus(p.number, p.status); return { ok: true }; },
    'admin.access.list': () => ({ ok: true, owner: 'owner@gmail.com (демо)', people: state.access, passwordEnabled: true }),
    'admin.access.save': (p) => {
      const email = String(p.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, code: 'validation', message: 'Укажите почту Google, например name@gmail.com' };
      const a = state.access.find((x) => x.email === email);
      if (a) Object.assign(a, { name: p.name || a.name, enabled: p.enabled !== false });
      else state.access.push({ email, name: p.name || '', enabled: p.enabled !== false, lastLogin: '' });
      save();
      return handlers['admin.access.list']();
    },
    'admin.access.delete': (p) => {
      state.access = state.access.filter((x) => x.email !== p.email);
      save();
      return handlers['admin.access.list']();
    },
    'admin.password.set': (p) => {
      const pw = String(p.password || '');
      if (pw.length < 8) return { ok: false, code: 'validation', message: 'Пароль — не короче 8 символов.' };
      state.password = pw;
      state.sessions = {};
      save();
      return { ok: true, message: 'Пароль изменён (демо). Войдите снова.' };
    },
    'admin.sessions.revoke': () => { state.sessions = {}; save(); return { ok: true, message: 'Все входы завершены — войдите снова.' }; },
    'admin.publish': () => {
      const pub = published();
      const plain = { ...state.draft, desserts: state.draft.desserts.map(({ imageSrc, ...d }) => d) };
      const changes = L.draftChanges(pub, plain);
      if (!changes.length) return { ok: false, code: 'nothing', message: 'Нет изменений для публикации.' };
      // Фото из демо-черновика: картинка хранится прямо в каталоге (imageSrc).
      const srcs = {};
      plain.desserts = plain.desserts.map((d) => {
        if (String(d.image).startsWith('drive:')) {
          srcs[d.id] = state.draft.desserts.find((x) => x.id === d.id).imageSrc;
          return { ...d, image: `images/demo/${d.id}` };
        }
        const prevSrc = (pub.desserts || []).find((x) => x.id === d.id && x.image === d.image);
        if (prevSrc && prevSrc.imageSrc) srcs[d.id] = prevSrc.imageSrc;
        return d;
      });
      const next = L.buildPublishedCatalog(pub, plain, { nowMs: Date.now(), by: 'демо-админка' });
      const problems = L.validateCatalog(next);
      if (problems.length) return { ok: false, code: 'validation', message: 'Исправьте перед публикацией: ' + problems.slice(0, 5).join('; ') + '.', problems };
      next.desserts.forEach((d) => { if (srcs[d.id]) d.imageSrc = srcs[d.id]; });
      try {
        localStorage.setItem(DEMO_CATALOG_KEY, JSON.stringify(next));
      } catch {
        return { ok: false, code: 'publish_failed', message: 'Не хватило места в браузере для демо-публикации — уменьшите фото.' };
      }
      state.draft.desserts.forEach((d) => { if (String(d.image).startsWith('drive:')) d.image = `images/demo/${d.id}`; });
      save();
      return { ok: true, version: next.version, commit: 'demo', commitUrl: '', message: 'Опубликовано в демо-режиме: витрина в этом браузере уже обновлена.' };
    },
  };

  return async function call(action, data = {}) {
    await wait(250);
    const h = handlers[action];
    if (!h) return { ok: false, code: 'bad_request', message: 'Неизвестное действие.' };
    if (action !== 'admin.config' && action !== 'admin.login') {
      const exp = state.sessions[data.token];
      if (!exp || exp < Date.now()) return { ok: false, code: 'unauthorized', message: 'Сессия закончилась — войдите снова.' };
    }
    return h(data);
  };
}

/** Сбросить демо-админку и демо-публикацию (кнопка в админке). */
export function resetDemoAdmin() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(DEMO_CATALOG_KEY);
  } catch { /* ignore */ }
}
