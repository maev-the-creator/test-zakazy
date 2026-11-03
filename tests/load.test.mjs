// Нагрузочный тест на локальном mock-сервере: лимит 3, 5 одновременных заявок
// → ровно 3 «Новая», 2 «Лист ожидания», номера без дублей.
process.env.TZ = 'Europe/Moscow';

import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockServer } from '../tools/mock-server.mjs';
import { runLoadTest } from '../tools/send-test-requests.mjs';

test('5 одновременных заявок на дату с лимитом 3 → 3 «Новая» + 2 «Лист ожидания», без дублей', async () => {
  const mock = await startMockServer({ port: 0, limit: 3, seed: false, latencyMs: 40, quiet: true });
  try {
    const lines = [];
    const s = await runLoadTest({ url: mock.url, n: 5, log: (l) => lines.push(l) });
    console.log(lines.join('\n'));
    assert.equal(s.errors, 0);
    assert.equal(s.new, 3);
    assert.equal(s.waitlist, 2);
    assert.equal(s.duplicates.length, 0);
    assert.equal(new Set(s.numbers).size, 5);
    assert.equal(s.after.status, 'full');
    assert.equal(s.after.accepted, 3);
    assert.ok(s.pass);
  } finally {
    await mock.close();
  }
});

test('20 одновременных заявок на лимит 3 — всё ещё ровно 3 места', async () => {
  const mock = await startMockServer({ port: 0, limit: 3, seed: false, latencyMs: 5, quiet: true });
  try {
    const s = await runLoadTest({ url: mock.url, n: 20, log: () => {} });
    assert.equal(s.new, 3);
    assert.equal(s.waitlist, 17);
    assert.equal(s.duplicates.length, 0);
  } finally {
    await mock.close();
  }
});

test('mock: повтор с тем же requestId возвращает ту же заявку', async () => {
  const { createMockBackend } = await import('../js/mock-backend.js');
  const fixture = JSON.parse((await import('node:fs')).readFileSync(new URL('./fixtures/catalog.json', import.meta.url), 'utf8'));
  const b = createMockBackend({ seed: false, getCatalog: () => fixture });
  const { moscowToday, addDays } = await import('../js/logic.generated.js');
  const body = { dessertId: 'bento', filling: 'Ваниль-клубника', date: addDays(moscowToday(Date.now()), 5), pickup: 'pickup', name: 'Анна', contact: '@anna_test', consent: true, requestId: 'rabcdef0123456789' };
  const [a, c] = await Promise.all([b.submit(body), b.submit(body)]);
  assert.equal(a.number, c.number);
  assert.equal(b.orders().length, 1);
});
