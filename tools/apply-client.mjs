#!/usr/bin/env node
// client.json (= анкета кондитерской) → файлы сайта этой кондитерской.
//   node tools/apply-client.mjs client.json [--catalog] [--root .]
// Пишет config.js (адрес Apps Script сохраняется), клиентские блоки в index/admin/consent/privacy.html,
// images/favicon.svg и handover/ПОДКЛЮЧЕНИЕ.txt. С --catalog — ещё data/catalog.json и catalog.js
// (только для нового сайта: дальше каталогом владеет админка, её публикации не затираем).
import fs from 'node:fs';
import path from 'node:path';
import { loadClient, htmlBlocks, fillBlocks, configJs, faviconSvg, catalogFromClient, handoverText } from './client-lib.mjs';
import { catalogToJs } from './build-catalog.mjs';

export function applyClient(clientFile, { root = process.cwd(), catalog = false, now = new Date() } = {}) {
  const c = loadClient(clientFile);
  const changed = [];
  const write = (rel, content) => {
    const abs = path.join(root, rel);
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (before === content) return;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    changed.push(rel);
  };
  if (catalog) {
    const cat = catalogFromClient(c, now);
    write('data/catalog.json', JSON.stringify(cat, null, 2) + '\n');
    write('data/catalog.js', catalogToJs(cat));
  }
  const cfgPath = path.join(root, 'config.js');
  write('config.js', configJs(c, fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : ''));
  const current = JSON.parse(fs.readFileSync(path.join(root, 'data/catalog.json'), 'utf8'));
  const blocks = htmlBlocks(c, current);
  for (const [file, b] of Object.entries(blocks)) {
    const abs = path.join(root, file);
    write(file, fillBlocks(fs.readFileSync(abs, 'utf8'), b));
  }
  write('images/favicon.svg', faviconSvg(c));
  if (!c.fictional) {
    write('handover/ПОДКЛЮЧЕНИЕ.txt', handoverText(c));
    // Памятки клиенту — из шаблонов docs/ с адресом сайта и названием.
    const site = String(c.siteUrl || '').replace(/\/+$/, '') || 'https://<адрес-сайта>';
    for (const [src, dst] of [['docs/ADMIN_GUIDE.md', 'Памятка — админка.md'], ['docs/OWNER_GUIDE.md', 'Памятка — таблица и заявки.md'], ['docs/DIRECT_REPLIES.md', 'Готовые ответы в директ.md']]) {
      const abs = path.join(root, src);
      if (!fs.existsSync(abs)) continue;
      const text = fs.readFileSync(abs, 'utf8').replace(/^<!--.*-->\n/, '').replaceAll('{{SITE_URL}}', site).replaceAll('{{BAKERY}}', c.bakery.name);
      write('handover/' + dst, text);
    }
  }
  return changed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Использование: node tools/apply-client.mjs client.json [--catalog] [--root папка]');
    process.exit(1);
  }
  const rootIdx = args.indexOf('--root');
  const root = rootIdx >= 0 ? path.resolve(args[rootIdx + 1]) : process.cwd();
  const changed = applyClient(path.resolve(file), { root, catalog: args.includes('--catalog') });
  console.log(changed.length ? `Обновлено: ${changed.join(', ')}` : 'Без изменений.');
}
