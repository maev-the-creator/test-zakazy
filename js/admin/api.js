// Клиент API админки: Apps Script (POST text/plain, без preflight) или демо в браузере.
import { createMockBackend, localStorageStorage } from '../mock-backend.js';
import { createMockAdmin } from './mock-admin.js';
import { loadCatalog } from '../api.js';

const TIMEOUT_MS = 90000; // публикация с фото может занять до минуты

export function createAdminApi(config) {
  const url = String(config.APPS_SCRIPT_URL || '').trim();
  if (!url) {
    const storage = localStorageStorage(`orderforge-demo:${config.bakery.logo}`);
    const backend = createMockBackend({ storage, latencyMs: 150, getCatalog: () => loadCatalog(config) });
    return { mode: 'demo', call: createMockAdmin({ backend }) };
  }
  return {
    mode: 'live',
    async call(action, data = {}) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: 'POST',
          redirect: 'follow',
          signal: ctrl.signal,
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action, ...data }),
        });
        if (!res.ok) return { ok: false, code: 'http', message: `Сервер ответил ошибкой (${res.status}).` };
        return await res.json();
      } catch (e) {
        return { ok: false, code: 'network', message: e.name === 'AbortError' ? 'Сервер долго не отвечает — попробуйте ещё раз.' : 'Нет связи с сервером. Проверьте интернет.' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
