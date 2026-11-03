// Связь с бэкендом: Google Apps Script или встроенный демо-режим.
import { createMockBackend, localStorageStorage } from './mock-backend.js';
import { CATALOG } from '../data/catalog.js';

// Демо-админка «публикует» каталог в localStorage этого браузера — витрина в демо-режиме берёт его отсюда.
export const DEMO_CATALOG_KEY = 'orderforge-demo:catalog';

export function demoPublishedCatalog() {
  try {
    const raw = window.localStorage.getItem(DEMO_CATALOG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Каталог для витрины: опубликованный data/catalog.js или (только в демо) публикация демо-админки. */
export function loadCatalog(config) {
  const demo = !String(config.APPS_SCRIPT_URL || '').trim();
  return (demo && demoPublishedCatalog()) || CATALOG;
}

// Apps Script после записи ещё отправляет фото и Telegram — даём ответу до минуты.
const TIMEOUT_MS = 60000;

export class ApiError extends Error {
  constructor(message, code = 'network') {
    super(message);
    this.code = code;
  }
}

async function fetchJson(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    // Apps Script отвечает редиректом на googleusercontent.com — fetch проходит его сам.
    res = await fetch(url, { redirect: 'follow', signal: ctrl.signal, ...init });
  } catch (e) {
    throw new ApiError(
      e.name === 'AbortError'
        ? 'Сервер долго не отвечает. Возможно, заявка уже дошла — повторная отправка не создаст дубль, её можно нажать ещё раз.'
        : 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.',
      e.name === 'AbortError' ? 'timeout' : 'network'
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new ApiError(`Сервер ответил ошибкой (${res.status}). Попробуйте ещё раз через минуту.`, 'http');
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError('Сервер вернул неожиданный ответ. Попробуйте ещё раз через минуту.', 'bad_json');
  }
}

/**
 * Демо-переключатели (только в демо-режиме, для видео и тестов):
 *   ?demo=paused — показать режим «приём остановлен» (отдельные данные, обычный режим не трогает)
 *   ?demo=reset  — сбросить демо-заявки и занятость
 */
export function createApi(config) {
  const url = String(config.APPS_SCRIPT_URL || '').trim();
  if (!url) {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get('demo');
    const paused = mode === 'paused';
    const storage = localStorageStorage(`orderforge-demo:${config.bakery.logo}${paused ? ':paused' : ''}`);
    if (mode === 'reset') storage.clear();
    const backend = createMockBackend({ storage, latencyMs: 500, getCatalog: () => loadCatalog(config) });
    if (paused) backend.setAccepting(false, 'Мы в отпуске до 20 ноября — заявки снова откроются 21‑го.');
    return {
      mode: 'demo',
      backend,
      availability: () => backend.availability(),
      submit: async (payload) => {
        const r = await backend.submit(payload);
        if (r.ok && r.telegramPreview) {
          // Так сообщение выглядело бы в Telegram у владельца.
          console.info('[демо] Сообщение владельцу в Telegram:\n' + r.telegramPreview.replace(/<[^>]+>/g, ''));
        }
        return r;
      },
    };
  }
  return {
    mode: 'live',
    availability: () => fetchJson(url + (url.includes('?') ? '&' : '?') + 'action=availability'),
    // text/plain — «простой» запрос без CORS-preflight, Apps Script его принимает.
    submit: (payload) => fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) }),
  };
}
