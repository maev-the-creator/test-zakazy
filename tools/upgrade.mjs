#!/usr/bin/env node
// Обновить сайт клиента до текущей версии продукта. Запускать В РЕПОЗИТОРИИ КЛИЕНТА:
//   node <путь-к-эталону>/tools/upgrade.mjs [--no-test]
// Копирует только файлы продукта (product-files.txt эталона), удаляет исчезнувшие, заново заполняет
// клиентские блоки из client.json. Каталог, фото и config.js клиента (адрес Apps Script) не трогаются.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PRODUCT_ROOT, listProductFiles, VERSION } from './client-lib.mjs';
import { applyClient } from './apply-client.mjs';
import { checkClient } from './check-client.mjs';

export async function upgrade(dest, { test = true, log = console.log } = {}) {
  if (path.resolve(dest) === PRODUCT_ROOT) throw new Error('Запускайте в репозитории клиента, а не в эталоне.');
  const manifestPath = path.join(dest, '.orderforge', 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('Нет .orderforge/manifest.json — это не сайт ORDER FORGE (или он создан не new-client).');
  const old = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const git = (...a) => execFileSync('git', a, { cwd: dest, encoding: 'utf8' });
  if (git('status', '--porcelain').trim()) throw new Error('В репозитории клиента есть незакоммиченные изменения — сначала разберитесь с ними.');

  const files = listProductFiles();
  for (const rel of files) {
    fs.mkdirSync(path.join(dest, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(path.join(PRODUCT_ROOT, rel), path.join(dest, rel));
  }
  const removed = (old.files || []).filter((f) => !files.includes(f) && fs.existsSync(path.join(dest, f)));
  removed.forEach((f) => fs.rmSync(path.join(dest, f)));
  applyClient(path.join(dest, 'client.json'), { root: dest });
  fs.writeFileSync(manifestPath, JSON.stringify({ version: VERSION(), files }, null, 2) + '\n');

  git('add', '-A');
  if (!git('status', '--porcelain').trim()) { log(`Уже последняя версия (${VERSION()}).`); return false; }
  if (test) {
    execFileSync('npm', ['test', '--silent'], { cwd: dest, stdio: 'inherit' });
    const { problems } = await checkClient({ root: dest });
    if (problems.length) throw new Error('check-client:\n  • ' + problems.join('\n  • '));
  }
  git('commit', '-q', '-m', `Обновление ORDER FORGE ${old.version} → ${VERSION()}`);
  log(`✅ ${old.version} → ${VERSION()}${removed.length ? `, удалено: ${removed.join(', ')}` : ''}. Проверьте CHANGELOG.md: нужно ли обновить Code.gs (пометка [сервер]). Дальше — git push.`);
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  upgrade(process.cwd(), { test: !process.argv.includes('--no-test') }).catch((e) => { console.error('❌ ' + e.message); process.exit(1); });
}
