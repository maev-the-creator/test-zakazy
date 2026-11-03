#!/usr/bin/env node
// Проверка сайта конкретной кондитерской перед показом клиенту и после обновлений.
//   node tools/check-client.mjs [client.json] [--root .]
// Падает (код 1), если: остались следы демо-кондитерской «Регалия», каталог не собран или с ошибками,
// нет фото, не заполнены клиентские блоки страниц.
import fs from 'node:fs';
import path from 'node:path';
import { loadClient, htmlBlocks, readBlocks } from './client-lib.mjs';
import { catalogToJs } from './build-catalog.mjs';

const LEFTOVERS = [/Регали/i, /regalia/i, /order-forge-demo/i, /morro-supremo/i, /Примеров/i, /ул\. Примерная/i, /0{12}/, /вымышлен/i];
const PAGE_IMAGES = ['hero-768', 'hero-1152', 'hero-1536', 'hero-sq-640', 'hero-sq-1024', 'fillings-480', 'fillings-900', 'chef-hands-480', 'chef-hands-900', 'gift-box-480', 'gift-box-900'];

export async function checkClient({ root = process.cwd(), clientFile } = {}) {
  const problems = [];
  const warnings = [];
  const file = clientFile || path.join(root, 'client.json');
  if (!fs.existsSync(file)) return { problems: [`нет ${path.relative(root, file) || file} (анкета клиента)`], warnings };
  let c;
  try { c = loadClient(file); } catch (e) { return { problems: [e.message], warnings }; }
  const read = (rel) => (fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel), 'utf8') : null);

  // 1. Каталог
  const json = read('data/catalog.json');
  let catalog = null;
  if (!json) problems.push('нет data/catalog.json');
  else {
    catalog = JSON.parse(json);
    if (read('data/catalog.js') !== catalogToJs(catalog)) problems.push('data/catalog.js не совпадает с data/catalog.json — npm run build-catalog');
    const L = await import(path.join(root, 'js', 'logic.generated.js'));
    L.validateCatalog(catalog).forEach((p) => problems.push('каталог: ' + p));
    if (!L.visibleDesserts(catalog).length) problems.push('каталог: нет ни одного видимого десерта');
    for (const d of catalog.desserts || []) {
      const ext = d.imageExt === 'jpg' ? 'jpg' : 'webp';
      for (const w of [480, 900]) if (!fs.existsSync(path.join(root, `${d.image}-${w}.${ext}`))) problems.push(`нет фото ${d.image}-${w}.${ext} («${d.name}»)`);
    }
  }
  for (const n of PAGE_IMAGES) if (!fs.existsSync(path.join(root, 'images', 'web', n + '.webp'))) problems.push(`нет фото страницы images/web/${n}.webp`);

  // 2. Клиентские блоки страниц совпадают с client.json
  if (catalog) {
    for (const [page, blocks] of Object.entries(htmlBlocks(c, catalog))) {
      const html = read(page);
      if (!html) { problems.push(`нет ${page}`); continue; }
      const have = readBlocks(html);
      for (const [name, value] of Object.entries(blocks)) {
        if (!(name in have)) problems.push(`${page}: нет метки <!-- client:${name} -->`);
        else if (have[name] !== value) problems.push(`${page}: блок «${name}» не совпадает с client.json — npm run apply-client -- client.json`);
      }
    }
  }

  // 3. Следы чужой (демо) кондитерской
  if (!c.fictional) {
    const files = ['config.js', 'data/catalog.json', 'index.html', 'admin.html', 'consent.html', 'privacy.html', 'images/favicon.svg'];
    if (fs.existsSync(path.join(root, 'handover'))) fs.readdirSync(path.join(root, 'handover')).forEach((f) => files.push('handover/' + f));
    for (const f of files) {
      const text = read(f);
      if (text == null) continue;
      text.split('\n').forEach((line, i) => {
        const hit = LEFTOVERS.find((re) => re.test(line));
        if (hit) problems.push(`${f}:${i + 1}: остаток демо (${hit.source}): ${line.trim().slice(0, 90)}`);
      });
    }
  }

  // 4. Адрес сервера
  const cfg = read('config.js') || '';
  const url = (cfg.match(/APPS_SCRIPT_URL:\s*'([^']*)'/) || [])[1] || '';
  if (!url) warnings.push('APPS_SCRIPT_URL пуст — сайт в демо-режиме (заявки остаются в браузере). Вставьте адрес после подключения Google.');
  else if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) problems.push('APPS_SCRIPT_URL не похож на адрес веб-приложения Apps Script (…/exec)');
  return { problems, warnings };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf('--root');
  const root = rootIdx >= 0 ? path.resolve(args[rootIdx + 1]) : process.cwd();
  const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--root');
  const { problems, warnings } = await checkClient({ root, clientFile: file && path.resolve(file) });
  warnings.forEach((w) => console.log('⚠️  ' + w));
  if (problems.length) {
    console.error(`❌ Найдено проблем: ${problems.length}`);
    problems.forEach((p) => console.error('  • ' + p));
    process.exit(1);
  }
  console.log('✅ Сайт клиента в порядке.');
}
