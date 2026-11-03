// Инструменты клиентов: клиентские блоки в HTML, генерация из client.json, проверка сайта.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBlocks, fillBlocks, htmlBlocks, loadClient, listProductFiles } from '../tools/client-lib.mjs';
import { applyClient } from '../tools/apply-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('клиентские блоки: заменяется только содержимое между метками', () => {
  const html = '<p><!-- client:a -->старое<!-- /client:a --></p><i><!-- client:b -->x<!-- /client:b --></i><!-- client:a -->ещё<!-- /client:a -->';
  const out = fillBlocks(html, { a: 'новое' });
  assert.deepEqual(readBlocks(out), { a: 'новое', b: 'x' });
  assert.equal(out.match(/новое/g).length, 2, 'одинаковые метки заполняются все');
});

test('в каждой странице продукта есть все клиентские метки', () => {
  const c = loadClient(path.join(ROOT, 'tests', 'fixtures', 'client.json'));
  for (const [page, blocks] of Object.entries(htmlBlocks(c))) {
    const have = readBlocks(fs.readFileSync(path.join(ROOT, page), 'utf8'));
    for (const name of Object.keys(blocks)) assert.ok(name in have, `${page}: <!-- client:${name} -->`);
  }
});

test('apply-client: текст в разметке экранируется, адрес Apps Script сохраняется, повтор ничего не меняет', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'of-apply-'));
  for (const f of ['index.html', 'admin.html', 'consent.html', 'privacy.html']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'config.js'), "export const CONFIG = { APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfyX/exec' };");
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'client.json'), 'utf8'));
  c.bakery.name = 'Торты <script>"Ада"</script>';
  const file = path.join(dir, 'client.json');
  fs.writeFileSync(file, JSON.stringify(c));
  applyClient(file, { root: dir, catalog: true });
  const index = fs.readFileSync(path.join(dir, 'consent.html'), 'utf8');
  assert.ok(!index.includes('<script>"Ада"'), 'HTML экранирован');
  assert.match(fs.readFileSync(path.join(dir, 'config.js'), 'utf8'), /AKfyX/);
  assert.deepEqual(applyClient(file, { root: dir }), [], 'повторный запуск — без изменений');
});

test('демо «Регалия» = клиент №0: apply-client не меняет файлы демо', { skip: !fs.existsSync(path.join(ROOT, 'clients', 'regalia.client.json')) && 'не эталон' }, () => {
  const before = Object.fromEntries(['config.js', 'index.html', 'admin.html', 'consent.html', 'privacy.html', 'images/favicon.svg'].map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'of-demo-'));
  for (const f of Object.keys(before)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), before[f]); }
  fs.mkdirSync(path.join(dir, 'data'));
  fs.copyFileSync(path.join(ROOT, 'data', 'catalog.json'), path.join(dir, 'data', 'catalog.json'));
  assert.deepEqual(applyClient(path.join(ROOT, 'clients', 'regalia.client.json'), { root: dir }), []);
});

test('файлы продукта существуют и не включают файлы клиента', () => {
  const files = listProductFiles(ROOT);
  assert.ok(files.includes('apps-script/Code.gs') && files.includes('js/app.js') && files.includes('index.html'));
  for (const f of files) assert.ok(!/^(config\.js|data\/|images\/|client\.json|clients\/|handover\/)/.test(f), f);
});
