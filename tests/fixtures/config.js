/*
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
  APPS_SCRIPT_URL: '',

  // OAuth Client ID для входа в админку через Google (не секрет, см. docs/SETUP_GOOGLE.md, шаг 11).
  // Пусто — кнопки «Войти через Google» нет, работает только вход по паролю.
  GOOGLE_CLIENT_ID: '',

  bakery: {
    name: 'Регалия',
    logo: 'REGALIA',
    tagline: 'Авторские торты и десерты · Москва',
    city: 'Москва',
    timeZone: 'Europe/Moscow',
  },

  product: {
    name: 'ORDER FORGE',
    footerNote: 'Окно заказов от ORDER FORGE',
  },

  form: {
    priceNote: 'точную стоимость назовёт кондитер: она зависит от размера, декора и доставки',
    contactHint: '+7 900 000-00-00 или @ник',
    commentHint: 'Надпись на торте, аллергии, удобное время',
    photoMaxMb: 5,
    // Показывается после отправки заявки.
    replyNote: 'Обычно отвечаем в течение дня — в Telegram или по телефону, который вы указали.',
  },

  legal: {
    consentUrl: 'consent.html',
    privacyUrl: 'privacy.html',
  },
};
