// Совпадение данных сервера (Code.gs) и сайта (config.js), свежесть js/logic.generated.js,
// отсутствие секретов и запрещённых формулировок в репозитории.
process.env.TZ = 'Europe/Moscow';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { loadGas, ROOT } from './helpers/gas.mjs';
import { buildLogicModule, SRC, OUT } from '../tools/sync-logic.mjs';
import { catalogToJs, JSON_PATH, JS_PATH } from '../tools/build-catalog.mjs';

const gas = loadGas();
const CATALOG = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

test('data/catalog.js сгенерирован из data/catalog.json (иначе: npm run build-catalog)', () => {
  assert.equal(fs.readFileSync(JS_PATH, 'utf8'), catalogToJs(CATALOG));
});

test('сервер (Code.gs) публикует catalog.js в точности как tools/build-catalog.mjs', () => {
  assert.equal(gas.get('catalogToJsModule')(CATALOG), catalogToJs(CATALOG));
});

test('опубликованный каталог проходит серверную проверку', () => {
  assert.deepEqual(Array.from(gas.get('validateCatalog')(CATALOG)), []);
  assert.ok(gas.get('visibleDesserts')(CATALOG).length > 0);
});

test('у каждого десерта есть фото 480 и 900 (WebP или JPEG из Safari)', () => {
  for (const d of CATALOG.desserts) {
    const ext = d.imageExt === 'jpg' ? 'jpg' : 'webp';
    for (const w of [480, 900]) assert.ok(fs.existsSync(path.join(ROOT, `${d.image}-${w}.${ext}`)), `${d.image}-${w}.${ext}`);
  }
});

test('в config.js нет ассортимента — он только в data/catalog.json', async () => {
  const { CONFIG } = await import('../config.js');
  for (const k of ['desserts', 'fillings', 'hero', 'about', 'delivery', 'contacts', 'links']) assert.ok(!(k in CONFIG), k);
});

test('js/logic.generated.js синхронизирован с Code.gs (иначе: npm run sync-logic)', () => {
  const expected = buildLogicModule(fs.readFileSync(SRC, 'utf8'));
  assert.equal(fs.readFileSync(OUT, 'utf8'), expected);
});

test('часовой пояс Apps Script — Europe/Moscow', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps-script', 'appsscript.json'), 'utf8'));
  assert.equal(manifest.timeZone, 'Europe/Moscow');
});

// Все отслеживаемые git файлы + новые неигнорируемые (то, что попадёт в коммит).
function repoTextFiles() {
  const list = execSync('git ls-files --cached --others --exclude-standard', { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !f.startsWith('.claude/skills/'))
    .filter((f) => !/\.(png|jpe?g|webp|gif|zip|ico|woff2?)$/i.test(f))
    .filter((f) => fs.existsSync(path.join(ROOT, f)));
  return list.map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]);
}

test('в репозитории нет токена Telegram-бота', () => {
  // Шаблон токена: <цифры>:<35 символов>. Сам токен в тест не вписываем.
  const tokenLike = /\b\d{8,11}:[A-Za-z0-9_-]{30,}\b/;
  for (const [file, text] of repoTextFiles()) {
    assert.doesNotMatch(text, tokenLike, `похоже на токен в ${file}`);
  }
});

test('в репозитории нет ключей GitHub (github_pat_… / ghp_…)', () => {
  const tokenLike = /\bgithub_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}\b|\bghp_[A-Za-z0-9]{36}\b/;
  for (const [file, text] of repoTextFiles()) assert.doesNotMatch(text, tokenLike, `похоже на ключ GitHub в ${file}`);
});

test('нет формулировок «заказ подтверждён» / «оформить заказ» на сайте', () => {
  const site = repoTextFiles().filter(([f]) => /^(index|consent|privacy)\.html$|^js\/|^config\.js$/.test(f));
  for (const [file, text] of site) {
    assert.doesNotMatch(text, /заказ\s+(?:успешно\s+)?подтвержд[её]н/i, file);
    assert.doesNotMatch(text, /оформить\s+заказ/i, file);
  }
});
