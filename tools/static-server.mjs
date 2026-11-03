#!/usr/bin/env node
// Простой статический сервер для локального просмотра сайта (как отдаёт Vercel).
//   node tools/static-server.mjs [--port 4173]   → http://127.0.0.1:4173/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// Заголовки из vercel.json — чтобы локально работало так же, как на Vercel (CSP админки и т. п.).
function vercelHeaders(urlPath) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    const out = {};
    (cfg.headers || []).forEach((rule) => {
      const re = new RegExp('^' + rule.source.replace(/\(\.\*\)/g, '.*') + '$');
      if (re.test(urlPath)) rule.headers.forEach((h) => { out[h.key] = h.value; });
    });
    return out;
  } catch {
    return {};
  }
}

export function startStaticServer({ port = 4173 } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не найдено'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', ...vercelHeaders(url.pathname) });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)),
  })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--port');
  const { url } = await startStaticServer({ port: i > 0 ? Number(process.argv[i + 1]) : 4173 });
  console.log('Сайт: ' + url);
}
