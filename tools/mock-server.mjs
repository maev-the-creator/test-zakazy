#!/usr/bin/env node
// Локальный mock-сервер с тем же API, что у Apps Script:
//   GET  /?action=availability
//   POST /   (тело — JSON, Content-Type: text/plain;charset=utf-8)
// Логика — js/mock-backend.js (= блок PURE LOGIC из Code.gs), блокировка — очередь.
//
// Запуск:  node tools/mock-server.mjs --port 8787 --limit 3 --no-seed --latency 40
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createMockBackend, memoryStorage } from '../js/mock-backend.js';

export function startMockServer({ port = 8787, limit = 4, seed = false, latencyMs = 40, quiet = false, catalog = null } = {}) {
  const backend = createMockBackend({ storage: memoryStorage(), seed, latencyMs, settings: { defaultLimit: limit }, ...(catalog ? { getCatalog: () => catalog } : {}) });
  const send = (res, code, obj) => {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(obj));
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
        return res.end();
      }
      if (req.method === 'GET') {
        if (url.searchParams.get('action') === 'availability') return send(res, 200, await backend.availability());
        if (url.searchParams.get('action') === 'orders') return send(res, 200, { ok: true, orders: backend.orders() });
        return send(res, 200, { ok: true, service: 'ORDER FORGE mock' });
      }
      if (req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        let payload;
        try { payload = JSON.parse(body); } catch { return send(res, 200, { ok: false, code: 'bad_request', message: 'Не удалось прочитать заявку.' }); }
        const result = await backend.submit(payload);
        if (!quiet) console.log(`[mock] ${result.ok ? result.number + ' ' + result.status : 'отказ ' + result.code}`);
        return send(res, 200, result);
      }
      send(res, 405, { ok: false, code: 'method' });
    } catch (e) {
      send(res, 500, { ok: false, code: 'server_error', message: String(e) });
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({ server, backend, url: `http://127.0.0.1:${actual}/`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const val = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
  const { url } = await startMockServer({
    port: Number(val('--port', 8787)),
    limit: Number(val('--limit', 4)),
    seed: !args.includes('--no-seed'),
    latencyMs: Number(val('--latency', 40)),
  });
  console.log(`Mock-сервер ORDER FORGE: ${url}  (Ctrl+C — остановить)`);
}
