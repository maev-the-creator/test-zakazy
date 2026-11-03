# CLAUDE.md — правила проекта ORDER FORGE «Окно заказов»

## Стек
- Сайт: чистые HTML + CSS + JS (ES-модули), **без сборки и фреймворков**. Vercel отдаёт корень репозитория как есть (прод = ветка `main`). Служебное исключено в `.vercelignore`.
- Бэкенд: Google-таблица + Google Apps Script (`apps-script/Code.gs`, `appsscript.json`, часовой пояс Europe/Moscow). Уведомления — Telegram-бот.
- Шрифты — Google Fonts (Unbounded — заголовки, Golos Text — текст и цены; кириллица). Иконки — inline SVG.

## Продукт и клиенты
- Этот репозиторий — **эталон** продукта; демо «Регалия» в нём — **клиент №0** (`clients/regalia.client.json`, `fictional: true`). У каждой кондитерской свой репозиторий.
- **Файлы продукта** — список в `product-files.txt` (страницы, `css/`, `js/`, `apps-script/`, `tools/`, `tests/`, `docs/`…): одинаковые у всех, правятся только в эталоне и раскатываются `tools/upgrade.mjs`. Всё остальное — **файлы клиента**: `client.json`, `config.js`, `data/`, `images/web/`, `images/catalog/`, `images/favicon.svg`, `handover/`.
- Клиентские места внутри страниц размечены `<!-- client:имя -->…<!-- /client:имя -->` (заголовки, превью ссылки, логотип, реквизиты в юр. страницах) — их заполняет `apply-client` из `client.json`; руками не правьте.
- `Code.gs` одинаковый у всех: всё клиентское — в Script Properties (`SITE_URL`, `GITHUB_REPO`, `BAKERY_NAME`). Любая правка Code.gs → увеличить `SERVER_VERSION` (в PURE LOGIC) и пометить версию в `CHANGELOG.md` как **[сервер]**; новая структура листов → увеличить `SCHEMA_VERSION` (миграция `ensureMigrated_`).
- Каталог правится руками только ради новых полей — тогда увеличить `version` в `data/catalog.json` (сервер берёт более новую версию сайта/снимка).
- Тесты продукта работают на фикстурах (`tests/fixtures`) и зелёные в любом репозитории клиента; контент клиента проверяет `check-client`.

## Где что
- **Настройки — `config.js`** (бренд, `APPS_SCRIPT_URL`, `GOOGLE_CLIENT_ID`, тексты формы). Пустой `APPS_SCRIPT_URL` = демо-режим (mock в браузере, localStorage).
- **Ассортимент и тексты — `data/catalog.json`** (+ сгенерированный `data/catalog.js`: `npm run build-catalog`). Обычно его меняет админка (`admin.html`) кнопкой «Опубликовать» — коммитом в `main` через GitHub API. Перед своими правками в `main` делайте `git pull`: там могут быть коммиты публикаций.
- Админка: `admin.html`, `css/admin.css`, `js/admin/*` (демо-режим — `js/admin/mock-admin.js`, пароль `demo-admin`). Сервер — `admin.*` в `Code.gs`: вход паролем (хэш в Script Properties) и Google (ID-токен), лист «Доступ», сессии 12 ч.
- Чистая логика (статусы дат, сроки, валидация, сообщение Telegram) — в `Code.gs` между `// === PURE LOGIC START/END ===`. Её копия для браузера — `js/logic.generated.js` (**не править руками**: `npm run sync-logic`).
- Сервер проверяет заявки по каталогу сайта или снимку «_Опубликовано» — что новее по `version`; `catalogToJsModule` в Code.gs должен совпадать с `tools/build-catalog.mjs` — проверяет `tests/parity.test.mjs`.
- Дизайн-решения — `DESIGN.md`; продукт — `PRODUCT.md`; допущения — `DECISIONS.md`; результаты проверок — `TEST_REPORT.md`.

## Команды
```bash
npm test                                         # логика и админка Code.gs, паритет каталога, нагрузочный тест на mock
NODE_PATH=$(npm root -g) npm run test:e2e        # сквозные сценарии витрины и админки в Playwright (демо-режим)
npm run build-catalog                            # data/catalog.js из data/catalog.json
NODE_PATH=$(npm root -g) npm run screens         # скриншоты в screenshots/
npm run sync-logic                               # после правки логики в Code.gs
npm run serve                                    # сайт локально: http://127.0.0.1:4173/
npm run mock-server -- --limit 3 --no-seed       # mock API как у Apps Script
node tools/send-test-requests.mjs --url <URL> --n 5 [--date YYYY-MM-DD]
npm run images                                   # WebP из images/*.png (Python + Pillow)
npm run apply-client -- clients/regalia.client.json   # файлы клиента из client.json (--catalog — ещё каталог)
npm run check-client -- clients/regalia.client.json   # нет следов демо, каталог и фото на месте
npm run new-client -- clients/<ник>.client.json ../<ник>-zakazy   # новый сайт кондитерской
node <эталон>/tools/upgrade.mjs                  # в репозитории клиента: обновить файлы продукта
```
Подробно о клиентах — `docs/NEW_CLIENT.md`. CI — `.github/workflows/ci.yml` (публикации из админки «Каталог vN» пропускаются).

## Правила
- **Секреты никогда не попадают в репозиторий** — ни в код, ни в конфиг, ни в доки, ни в тесты: `TELEGRAM_BOT_TOKEN`, `GITHUB_TOKEN`, `ADMIN_PASSWORD(_HASH)` — только в Script Properties. Тест `parity` ищет похожие на токен строки. `GOOGLE_CLIENT_ID` — не секрет.
- Тексты: «Отправить заявку», «Заявка отправлена — кондитер свяжется…». Никогда «заказ подтверждён» / «оформить заказ». Цена — только диапазон с пометкой про кондитера.
- Пользовательский ввод — только через `textContent` (в браузере) и `escapeHtml` (Telegram), `sheetSafe` (таблица).
- Палитра строго: шоколад `#5B3A29`, ягодный `#B03A5B` только для акцентов, крем `#F7F1E8`; оранжевого нет.
- Анимации: только `transform`/`opacity`/`clip-path`, ease-out, hover только под `(hover: hover) and (pointer: fine)`, уважать `prefers-reduced-motion`.
- Мобильная версия главная: от 360px, тап-зоны ≥ 44px, поля ≥ 16px, без горизонтального скролла.
- Не коммитить `node_modules`, скриншоты из `screenshots/`, временные файлы.
