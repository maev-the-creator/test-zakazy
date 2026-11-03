#!/usr/bin/env node
// Нагрузочный тест: N ОДНОВРЕМЕННЫХ заявок на одну дату.
// Проверяет, что мест не выдаётся больше лимита, а номера не повторяются.
//
//   node tools/send-test-requests.mjs --url <URL> [--n 5] [--date YYYY-MM-DD] [--dessert bento]
//
// <URL> — адрес mock-сервера (http://127.0.0.1:8787/) или веб-приложения Apps Script
// (https://script.google.com/macros/s/.../exec).
// ВНИМАНИЕ: на реальном URL создаются настоящие строки в таблице и сообщения в Telegram
// (имена «Нагрузочный тест N», комментарий «ТЕСТ — удалить»). После проверки удалите строки.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESSERT_FILLING = {
  bento: 'Ваниль-клубника', birthday: 'Шоколадный трюфель', wedding: 'Шоколадный трюфель', kids: 'Ваниль-клубника',
  cupcakes: 'Ваниль', macarons: 'Ассорти', cheesecake: 'Классический с ягодным соусом', 'dessert-set': 'Ассорти от кондитера',
};
const LEAD = { bento: 2, birthday: 3, wedding: 14, kids: 5, cupcakes: 2, macarons: 2, cheesecake: 2, 'dessert-set': 3 };

async function getJson(url, init) {
  const res = await fetch(url, { redirect: 'follow', ...init });
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error(`Ответ не JSON (HTTP ${res.status}): ${text.slice(0, 200)}`); }
}

export async function runLoadTest({ url, n = 5, date, dessert = 'bento', log = console.log }) {
  const base = url.replace(/\?.*$/, '');
  const av = await getJson(base + '?action=availability');
  if (!av.ok) throw new Error('availability: ' + JSON.stringify(av));
  let target = date;
  if (!target) {
    const minDiff = LEAD[dessert] ?? 2;
    const idx = av.dates.findIndex((d, i) => i >= minDiff && d.status !== 'closed');
    target = av.dates[idx].date;
  }
  const before = av.dates.find((d) => d.date === target);
  log(`Дата: ${target}; до теста: лимит ${before?.limit}, принято ${before?.accepted}, осталось ${before?.left} (${before?.status})`);
  log(`Отправляю ${n} заявок одновременно…`);

  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      getJson(base, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          dessertId: dessert, filling: DESSERT_FILLING[dessert], date: target, pickup: 'pickup',
          name: `Нагрузочный тест ${i + 1}`, contact: `@loadtest_${i + 1}`, comment: 'ТЕСТ — удалить',
          consent: true, website: '',
        }),
      }).catch((e) => ({ ok: false, code: 'network', message: String(e) }))
    )
  );
  const ms = Date.now() - started;

  results.forEach((r, i) => log(`  #${i + 1}: ${r.ok ? `${r.number}  ${r.status === 'new' ? 'Новая' : 'Лист ожидания'}` : `ОШИБКА ${r.code}: ${r.message}`}`));
  const okResults = results.filter((r) => r.ok);
  const numbers = okResults.map((r) => r.number);
  const duplicates = numbers.filter((x, i) => numbers.indexOf(x) !== i);
  const summary = {
    date: target,
    sent: n,
    ok: okResults.length,
    new: okResults.filter((r) => r.status === 'new').length,
    waitlist: okResults.filter((r) => r.status === 'waitlist').length,
    errors: results.length - okResults.length,
    duplicates,
    numbers,
    leftBefore: before?.left,
    ms,
  };
  const after = (await getJson(base + '?action=availability')).dates.find((d) => d.date === target);
  summary.after = after;
  const expectedNew = Math.min(n, Math.max(0, before?.left ?? 0));
  summary.pass = summary.errors === 0 && duplicates.length === 0 && summary.new === expectedNew && summary.waitlist === n - expectedNew;
  log(`Итог за ${ms} мс: «Новая» — ${summary.new} (ожидалось ${expectedNew}), «Лист ожидания» — ${summary.waitlist}, ошибок — ${summary.errors}, дублей номеров — ${duplicates.length}`);
  log(`После теста: принято ${after?.accepted}, осталось ${after?.left}, статус ${after?.status}`);
  log(summary.pass ? 'РЕЗУЛЬТАТ: ПРОЙДЕН ✅' : 'РЕЗУЛЬТАТ: НЕ ПРОЙДЕН ❌');
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const val = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
  const url = val('--url');
  if (!url) {
    console.log('Укажите адрес: node tools/send-test-requests.mjs --url https://script.google.com/macros/s/…/exec [--n 5] [--date 2026-11-20]');
    process.exit(2);
  }
  const summary = await runLoadTest({ url, n: Number(val('--n', 5)), date: val('--date'), dessert: val('--dessert', 'bento') });
  process.exit(summary.pass ? 0 : 1);
}
