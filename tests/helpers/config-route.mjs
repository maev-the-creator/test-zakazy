// Подмена клиентских файлов для браузерных тестов.
// Тесты продукта не должны зависеть от контента конкретной кондитерской: config.js и data/catalog.js
// подменяются фикстурами (tests/fixtures), отсутствующие фото — заглушкой. Поэтому тесты зелёные
// в любом репозитории клиента. А ещё они никогда не шлют заявки в настоящую таблицу (адрес — mock или пусто).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogToJs } from '../../tools/build-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX = path.join(ROOT, 'tests', 'fixtures');
export const FIXTURE_CATALOG = JSON.parse(fs.readFileSync(path.join(FIX, 'catalog.json'), 'utf8'));
export const FIXTURE_PHOTO = path.join(FIX, 'photo.png');
const CONFIG_TEXT = fs.readFileSync(path.join(FIX, 'config.js'), 'utf8');
const PLACEHOLDER = fs.readFileSync(path.join(FIX, 'placeholder.webp'));

/**
 * url — адрес API ('' = демо-режим в браузере).
 * fixtures: false — оставить настоящие config.js и каталог (скриншоты конкретного сайта), подменяется только адрес.
 */
export async function setApiUrl(page, url, { fixtures = true } = {}) {
  await page.route('**/config.js', async (route) => {
    const body = fixtures ? CONFIG_TEXT : await (await route.fetch()).text();
    await route.fulfill({ status: 200, body: body.replace(/APPS_SCRIPT_URL:\s*'[^']*'/, `APPS_SCRIPT_URL: '${url}'`), contentType: 'text/javascript; charset=utf-8' });
  });
  if (!fixtures) return;
  await page.route('**/data/catalog.js', (route) => route.fulfill({ status: 200, body: catalogToJs(FIXTURE_CATALOG), contentType: 'text/javascript; charset=utf-8' }));
  // Фото десертов фикстуры могут отсутствовать в репозитории клиента — тогда отдаём заглушку.
  await page.route(/\/images\/(web|catalog)\/[^?]+\.(webp|jpg)(\?|$)/, async (route) => {
    const rel = new URL(route.request().url()).pathname.replace(/^\/+/, '');
    if (fs.existsSync(path.join(ROOT, rel))) return route.fallback();
    return route.fulfill({ status: 200, body: PLACEHOLDER, contentType: 'image/webp' });
  });
}
export const forceDemo = (page, opts) => setApiUrl(page, '', opts);
