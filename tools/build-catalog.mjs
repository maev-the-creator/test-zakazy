#!/usr/bin/env node
// data/catalog.json — единственный источник ассортимента и текстов витрины.
// Этот скрипт делает из него ES-модуль data/catalog.js (его импортирует сайт).
// Админка при публикации пишет оба файла сама; руками запускать нужно, только если правили JSON вручную:
//   npm run build-catalog
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const JSON_PATH = path.join(ROOT, 'data', 'catalog.json');
export const JS_PATH = path.join(ROOT, 'data', 'catalog.js');

/** Та же функция есть в Code.gs (catalogToJsModule) — тест проверяет, что результат совпадает. */
export function catalogToJs(catalog) {
  return '// АВТОМАТИЧЕСКИ: генерируется из data/catalog.json (админка → «Опубликовать» или npm run build-catalog).\n'
    + '// Не редактируйте вручную.\nexport const CATALOG = ' + JSON.stringify(catalog, null, 2) + ';\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const catalog = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  fs.writeFileSync(JS_PATH, catalogToJs(catalog));
  console.log('Обновлён data/catalog.js');
}
