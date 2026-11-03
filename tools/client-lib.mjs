// Общее для инструментов клиентов: client.json (= анкета) → файлы сайта конкретной кондитерской.
// Код продукта (страницы, стили, скрипты, Code.gs) одинаковый у всех; от клиента зависят только
// «клиентские блоки» в HTML (между <!-- client:имя --> и <!-- /client:имя -->) и файлы клиента.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Файлы и папки продукта: одинаковые у всех клиентов, обновляются tools/upgrade.mjs. */
export function productPaths(root = PRODUCT_ROOT) {
  return fs.readFileSync(path.join(root, 'product-files.txt'), 'utf8')
    .split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
}

/** Все файлы продукта (рекурсивно раскрывает папки) — относительные пути. */
export function listProductFiles(root = PRODUCT_ROOT) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    if (fs.statSync(abs).isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        if (name === 'node_modules' || name.startsWith('.DS_')) continue;
        walk(path.posix.join(rel, name));
      }
    } else out.push(rel);
  };
  productPaths(root).forEach((p) => walk(p.replace(/\/$/, '')));
  return out;
}

export const VERSION = () => fs.readFileSync(path.join(PRODUCT_ROOT, 'VERSION'), 'utf8').trim();

export function loadClient(file) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = [];
  const need = (v, name) => { if (v == null || String(v).trim() === '') problems.push(name); };
  need(c.bakery && c.bakery.name, 'bakery.name');
  need(c.bakery && c.bakery.logo, 'bakery.logo');
  need(c.bakery && c.bakery.tagline, 'bakery.tagline');
  need(c.legal && c.legal.operator, 'legal.operator');
  need(c.legal && c.legal.inn, 'legal.inn');
  need(c.legal && c.legal.email, 'legal.email');
  need(c.legal && c.legal.address, 'legal.address');
  const tz = (c.bakery && c.bakery.timeZone) || 'Europe/Moscow';
  if (tz !== 'Europe/Moscow') problems.push('bakery.timeZone: пока поддерживается только Europe/Moscow (время в календаре и на сервере — московское)');
  if (problems.length) throw new Error(`${file}: заполните ${problems.join(', ')}`);
  return c;
}

// ---------- Текст ----------
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Неразрывный пробел перед тире — как во всех текстах сайта. */
const typo = (s) => String(s || '').replace(/ —/g, '\u00a0—');
const jsStr = (s) => `'${String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const ruDate = (d = new Date()) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} г.`;

// ---------- Клиентские блоки в HTML ----------
const BLOCK_RE = /<!-- client:([\w-]+) -->([\s\S]*?)<!-- \/client:\1 -->/g;

export function readBlocks(html) {
  const out = {};
  for (const m of html.matchAll(BLOCK_RE)) out[m[1]] = m[2];
  return out;
}

/** Заменяет содержимое блоков; блок, которого нет в blocks, не трогается. */
export function fillBlocks(html, blocks) {
  return html.replace(BLOCK_RE, (all, name) => (name in blocks ? `<!-- client:${name} -->${blocks[name]}<!-- /client:${name} -->` : all));
}

const LEGAL_NOTES = {
  'consent.html': '    <p class="doc__note"><b>Шаблон для демо.</b> Реквизиты оператора вымышлены. Для реального клиента текст обязательно проверить у юриста: в том числе требование о локализации (ч. 5 ст. 18 152-ФЗ), трансграничную передачу данных (Google, Telegram) и уведомление Роскомнадзора.</p>\n',
  'privacy.html': '    <p class="doc__note"><b>Шаблон для демо.</b> Реквизиты оператора вымышлены. Для реального клиента текст обязательно проверить у юриста (152-ФЗ «О персональных данных», локализация, трансграничная передача, уведомление Роскомнадзора).</p>\n',
};

/** Блоки для каждого HTML-файла продукта. catalog — текущий data/catalog.json (контакты для JSON-LD). */
export function htmlBlocks(c, catalog = {}) {
  const b = c.bakery;
  const L = c.legal;
  const seo = c.seo || {};
  const site = String(c.siteUrl || '').replace(/\/+$/, '');
  const fictional = !!c.fictional;
  const title = typo(seo.title || `${b.name} — ${b.tagline} · заявка онлайн`);
  const description = typo(seo.description || 'Выберите десерт и свободную дату, оставьте контакт — готовая заявка сразу придёт кондитеру. Оплаты на странице нет.');
  const ogTitle = typo(seo.ogTitle || `${b.name} — ${b.tagline}`);
  const ogDescription = typo(seo.ogDescription || 'Выберите десерт и дату — заявка сразу придёт кондитеру.');
  const img = (site ? site + '/' : '') + 'images/web/hero-1152.webp';
  const contacts = catalog.contacts || {};
  let head = '\n'
    + `  <title>${esc(title)}</title>\n`
    + `  <meta name="description" content="${esc(description)}">\n`
    + '  <meta name="theme-color" content="#5B3A29">\n'
    + '  <meta name="color-scheme" content="light">\n'
    + `  <meta property="og:title" content="${esc(ogTitle)}">\n`
    + `  <meta property="og:description" content="${esc(ogDescription)}">\n`
    + `  <meta property="og:image" content="${esc(img)}">\n`
    + (site ? `  <meta property="og:url" content="${esc(site + '/')}">\n  <link rel="canonical" href="${esc(site + '/')}">\n` : '')
    + '  <meta property="og:type" content="website">\n';
  if (!fictional && site) {
    const ld = {
      '@context': 'https://schema.org', '@type': 'Bakery', name: b.name, url: site + '/', image: img,
      ...(contacts.phone ? { telephone: contacts.phone } : {}),
      ...(contacts.address ? { address: { '@type': 'PostalAddress', streetAddress: contacts.address, addressLocality: b.city || '' } } : {}),
    };
    head += `  <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>\n`;
  }
  head += '  ';
  const logo = esc(b.logo);
  const details = `ИНН ${esc(L.inn)}${L.ogrnip ? `, ОГРНИП ${esc(L.ogrnip)}` : ''}`;
  const edition = esc(L.edition || ruDate());
  return {
    'index.html': {
      head,
      logo,
      fictional: fictional ? '\n        <span class="site-footer__fake">Контакты и адрес вымышлены\u00a0— это демо.</span>\n' : '\n',
    },
    'admin.html': {
      'admin-title': `\n  <title>Админка — ${esc(b.name)}</title>\n  `,
      logo,
    },
    'consent.html': {
      'doc-title': `\n  <title>Согласие на обработку персональных данных — ${esc(b.name)}</title>\n  `,
      'legal-note': '\n' + (fictional ? LEGAL_NOTES['consent.html'] : ''),
      operator: `\n    <p>Отправляя заявку на сайте кондитерской «${esc(b.name)}» и отмечая галочку «Я согласен(на) на обработку персональных данных», я свободно, своей волей и в своём интересе даю согласие оператору — <b>${esc(L.operator)}</b> (${details}, адрес: ${esc(L.address)}; e-mail: ${esc(L.email)}${fictional ? '; данные вымышлены' : ''}) — на обработку моих персональных данных на следующих условиях.</p>\n`,
      edition,
    },
    'privacy.html': {
      'doc-title': `\n  <title>Политика конфиденциальности — ${esc(b.name)}</title>\n  `,
      'legal-note': '\n' + (fictional ? LEGAL_NOTES['privacy.html'] : ''),
      operator: `\n    <p>Оператор персональных данных — ${esc(L.operator)} (кондитерская «${esc(b.name)}»), ${details}, ${esc(L.address)}, e-mail: ${esc(L.email)}.${fictional ? ' Данные вымышлены и приведены для демонстрации.' : ''}</p>\n`,
      email: esc(L.email),
      edition,
    },
  };
}

// ---------- config.js ----------
/** config.js клиента. Уже вставленные адрес Apps Script и Google Client ID сохраняются. */
export function configJs(c, existing = '') {
  const keep = (key) => {
    const m = existing.match(new RegExp(`${key}:\\s*'([^']*)'`));
    return m ? m[1] : '';
  };
  const f = c.form || {};
  return `/*
 * config.js — настройки сайта, которые НЕ меняются из админки.
 * Генерируется из client.json (npm run apply-client). Адрес Apps Script и Google Client ID
 * при повторной генерации сохраняются.
 *
 * Ассортимент, начинки, тексты, контакты и ссылки — в data/catalog.json:
 * их меняет администратор на странице /admin.html и публикует кнопкой «Опубликовать».
 *
 * НИКОГДА не пишите сюда токены (Telegram, GitHub) и пароли: сайт публичный.
 * Секреты хранятся только в «Свойствах скрипта» Google Apps Script.
 */

export const CONFIG = {
  // Адрес веб-приложения Google Apps Script (см. docs/SETUP_GOOGLE.md).
  // Пустая строка '' включает демо-режим (для видео: ?demo=reset, ?demo=paused).
  APPS_SCRIPT_URL: ${jsStr(keep('APPS_SCRIPT_URL'))},

  // OAuth Client ID для входа в админку через Google (не секрет, см. docs/SETUP_GOOGLE.md, шаг 11).
  // Пусто — кнопки «Войти через Google» нет, работает только вход по паролю.
  GOOGLE_CLIENT_ID: ${jsStr(keep('GOOGLE_CLIENT_ID'))},

  bakery: {
    name: ${jsStr(c.bakery.name)},
    logo: ${jsStr(c.bakery.logo)},
    tagline: ${jsStr(c.bakery.tagline)},
    city: ${jsStr(c.bakery.city || '')},
    timeZone: 'Europe/Moscow',
  },

  product: {
    name: 'ORDER FORGE',
    footerNote: 'Окно заказов от ORDER FORGE',
  },

  form: {
    priceNote: ${jsStr(f.priceNote || 'точную стоимость назовёт кондитер: она зависит от размера, декора и доставки')},
    contactHint: ${jsStr(f.contactHint || '+7 900 000-00-00 или @ник')},
    commentHint: ${jsStr(f.commentHint || 'Надпись на торте, аллергии, удобное время')},
    photoMaxMb: 5,
    // Показывается после отправки заявки.
    replyNote: ${jsStr(f.replyNote || 'Обычно отвечаем в течение дня — в Telegram или по телефону, который вы указали.')},
  },

  legal: {
    consentUrl: 'consent.html',
    privacyUrl: 'privacy.html',
  },
};
`;
}

// ---------- Иконка ----------
export function faviconSvg(c) {
  const letter = esc(Array.from(String(c.bakery.logo).trim())[0] || 'O').toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#5B3A29"/><text x="32" y="45" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="38" fill="#F7F1E8">${letter}</text><path d="M16 52c10-2 21-2.5 32-1" fill="none" stroke="#B03A5B" stroke-width="3" stroke-linecap="round"/></svg>\n`;
}

// ---------- Каталог ----------
export function catalogFromClient(c, now = new Date()) {
  if (!c.catalog) throw new Error('В client.json нет раздела catalog (десерты, начинки, тексты).');
  return { version: 1, publishedAt: now.toISOString(), publishedBy: 'разработчик', ...c.catalog };
}

// ---------- Передача партнёру ----------
export function handoverText(c) {
  return `ORDER FORGE — подключение «${c.bakery.name}»
=============================================

Свойства скрипта (Apps Script → ⚙️ Настройки проекта → Свойства скрипта).
Добавить ДО запуска setup():

  SITE_URL           = адрес сайта из Vercel, без «/» в конце (https://….vercel.app)
  GITHUB_REPO        = ник-клиента/название-репозитория (после передачи репозитория клиенту)
  BAKERY_NAME        = ${c.bakery.name}
  TELEGRAM_BOT_TOKEN = токен бота (клиент вставляет сам, никому не пересылать)
  TELEGRAM_CHAT_ID   = chat_id группы для заявок (число с минусом)
  ADMIN_PASSWORD     = пароль админки (клиент придумывает сам, от 8 символов)
  GITHUB_TOKEN       = ключ github_pat_… (клиент создаёт в своём GitHub, только этот репозиторий, Contents: Read and write)

После setup() и развертывания: адрес …/exec вставить в config.js (APPS_SCRIPT_URL) через GitHub клиента.
Подробно — «Инструкция партнёра: подключение клиента».
`;
}
