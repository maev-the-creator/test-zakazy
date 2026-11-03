#!/usr/bin/env node
// Копирует блок чистой логики из apps-script/Code.gs в js/logic.generated.js (ES-модуль),
// чтобы сайт (демо-режим) и локальный mock-сервер работали по тем же правилам, что и сервер.
// Запуск: npm run sync-logic   (тест tests/parity.test.mjs проверяет, что копия свежая)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SRC = path.join(ROOT, 'apps-script', 'Code.gs');
export const OUT = path.join(ROOT, 'js', 'logic.generated.js');

export function buildLogicModule(code) {
  const start = code.indexOf('// === PURE LOGIC START ===');
  const end = code.indexOf('// === PURE LOGIC END ===');
  if (start < 0 || end < 0 || end < start) throw new Error('Не найдены маркеры PURE LOGIC в Code.gs');
  const block = code.slice(start, end + '// === PURE LOGIC END ==='.length);
  const names = new Set();
  for (const m of block.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) names.add(m[1]);
  for (const m of block.matchAll(/^const\s+([A-Za-z_$][\w$]*)\s*=/gm)) names.add(m[1]);
  return [
    '// АВТОМАТИЧЕСКИ СГЕНЕРИРОВАНО из apps-script/Code.gs командой `npm run sync-logic`.',
    '// Не редактируйте вручную — правьте Code.gs и запустите синхронизацию.',
    '/* eslint-disable */',
    block,
    '',
    'export {',
    ...[...names].map((n) => `  ${n},`),
    '};',
    '',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = buildLogicModule(fs.readFileSync(SRC, 'utf8'));
  fs.writeFileSync(OUT, out);
  console.log('Обновлён ' + path.relative(ROOT, OUT));
}
