#!/usr/bin/env node
// Новый сайт кондитерской: файлы продукта (одинаковые у всех) + анкета клиента.
//   node tools/new-client.mjs clients/<клиент>.client.json <папка> [--no-test]
// Папка — пустая или свежий клон пустого репозитория клиента. История демо туда не попадает.
// Фото: в client.json "photos": путь к папке с оригиналами (hero, <id десерта>, fillings, chef-hands, gift-box —
// .png/.jpg), путь считается от client.json. "photos": "demo" — взять фото демо (для тестового сайта).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PRODUCT_ROOT, listProductFiles, loadClient, VERSION } from './client-lib.mjs';
import { applyClient } from './apply-client.mjs';
import { checkClient } from './check-client.mjs';

export async function newClient(clientFile, dest, { test = true, log = console.log } = {}) {
  const c = loadClient(clientFile);
  if (c.fictional) throw new Error('Вымышленная кондитерская — это демо; для клиента fictional должен быть false.');
  fs.mkdirSync(dest, { recursive: true });
  const busy = fs.readdirSync(dest).filter((f) => f !== '.git');
  if (busy.length) throw new Error(`Папка ${dest} не пустая: ${busy.slice(0, 5).join(', ')}`);

  const files = listProductFiles();
  for (const rel of files) {
    fs.mkdirSync(path.join(dest, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(path.join(PRODUCT_ROOT, rel), path.join(dest, rel));
  }
  // Фото
  const web = path.join(dest, 'images', 'web');
  fs.mkdirSync(web, { recursive: true });
  if (c.photos === 'demo') {
    for (const f of fs.readdirSync(path.join(PRODUCT_ROOT, 'images', 'web'))) fs.copyFileSync(path.join(PRODUCT_ROOT, 'images', 'web', f), path.join(web, f));
  } else if (c.photos) {
    const src = path.resolve(path.dirname(clientFile), c.photos);
    execFileSync('python3', [path.join(dest, 'tools', 'make-images.py'), src, web], { stdio: 'inherit' });
  } else throw new Error('В client.json не указаны фото (photos: папка с оригиналами или "demo").');

  fs.copyFileSync(clientFile, path.join(dest, 'client.json'));
  fs.writeFileSync(path.join(dest, 'README.md'), `# Окно заказов «${c.bakery.name}»\n\nСайт на ORDER FORGE ${VERSION()}. Ассортимент, фото и тексты меняются в админке: \`/admin.html\`.\nДля разработчика: \`CLAUDE.md\`, \`docs/NEW_CLIENT.md\`.\n`);
  fs.mkdirSync(path.join(dest, '.orderforge'), { recursive: true });
  fs.writeFileSync(path.join(dest, '.orderforge', 'manifest.json'), JSON.stringify({ version: VERSION(), files }, null, 2) + '\n');
  const changed = applyClient(path.join(dest, 'client.json'), { root: dest, catalog: true });
  log(`Файлы клиента: ${changed.join(', ')}`);

  const git = (...a) => execFileSync('git', a, { cwd: dest, encoding: 'utf8' });
  if (!fs.existsSync(path.join(dest, '.git'))) git('init', '-q', '-b', 'main');
  git('add', '-A');
  if (test) {
    execFileSync('npm', ['test', '--silent'], { cwd: dest, stdio: 'inherit' });
    const { problems, warnings } = await checkClient({ root: dest });
    warnings.forEach((w) => log('⚠️  ' + w));
    if (problems.length) throw new Error('check-client:\n  • ' + problems.join('\n  • '));
  }
  git('add', '-A');
  git('commit', '-q', '-m', `ORDER FORGE ${VERSION()} — «${c.bakery.name}»`);
  log(`✅ Готово: ${dest}. Дальше: git push в пустой репозиторий клиента, превью на Vercel, подключение по инструкции партнёра.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, dest] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!file || !dest) {
    console.error('Использование: node tools/new-client.mjs clients/<клиент>.client.json <папка> [--no-test]');
    process.exit(1);
  }
  newClient(path.resolve(file), path.resolve(dest), { test: !process.argv.includes('--no-test') }).catch((e) => { console.error('❌ ' + e.message); process.exit(1); });
}
