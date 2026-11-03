// Админка «Окна заказов». Все данные приходят с сервера (Apps Script) или из демо в браузере.
// Весь текст выводится через textContent (h()), без innerHTML.
import { CONFIG } from '../../config.js';
import { h, $, $$, svgIcon, ICONS } from '../dom.js';
import { dishCard } from '../render.js';
import { createAdminApi } from './api.js';
import { resetDemoAdmin } from './mock-admin.js';
import { loadImage, encodeCrop, cropBox, RATIO } from './photo.js';
import { formatDateWeekday, slugify, priceRangeText, SERVER_VERSION } from '../logic.generated.js';

const api = createAdminApi(CONFIG);
const TOKEN_KEY = 'orderforge-admin-token';
const state = { token: '', me: null, catalog: null, tab: 'catalog' };

// ---------- Утилиты ----------
const getToken = () => { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return state.token; } };
const setToken = (t) => { state.token = t; try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* приватный режим */ } };

async function call(action, data = {}) {
  const res = await api.call(action, { ...data, token: getToken() || state.token });
  if (res && res.code === 'unauthorized') {
    setToken('');
    showLogin(res.message);
  }
  return res || { ok: false, message: 'Пустой ответ сервера.' };
}

let toastTimer;
function toast(text, error = false) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.toggle('toast--error', error);
  t.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-on'), error ? 6000 : 3200);
}

function setBusy(btn, on) {
  btn.classList.toggle('is-loading', on);
  btn.disabled = on;
}

function field(label, input, { hint = '', name = '', count = 0 } = {}) {
  const id = input.id || `f-${name || Math.random().toString(36).slice(2)}`;
  input.id = id;
  const err = h('p', { class: 'f__err', id: `${id}-err` });
  input.setAttribute('aria-describedby', `${id}-err`);
  const counter = count ? h('span', { class: 'f__count' }, `${input.value.length}/${count}`) : null;
  if (counter) input.addEventListener('input', () => { counter.textContent = `${input.value.length}/${count}`; });
  return h('div', { class: 'f', 'data-field': name }, h('label', { for: id }, label), input, hint ? h('p', { class: 'f__hint' }, hint) : null, counter, err);
}

function showErrors(root, errors = {}) {
  $$('.f', root).forEach((f) => {
    const name = f.dataset.field;
    const err = $('.f__err', f);
    const ctl = $('input, textarea, select', f);
    if (err) err.textContent = errors[name] || '';
    if (ctl) ctl.toggleAttribute('aria-invalid', !!errors[name]);
  });
  const first = Object.keys(errors)[0];
  const el = first && $(`[data-field="${first}"] input, [data-field="${first}"] textarea`, root);
  if (el) el.focus();
}

function switchCtl(label, checked, onChange) {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked, input));
  return h('label', { class: 'switch' }, input, h('span', { class: 'switch__track', 'aria-hidden': 'true' }), h('span', {}, label));
}

const fmtDateTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
};

// ---------- Вход ----------
function showLogin(message = '') {
  $('#app').hidden = true;
  $('#login').hidden = false;
  const err = $('#login-error');
  err.hidden = !message;
  err.textContent = message;
}

async function initLogin() {
  const cfg = await api.call('admin.config');
  if (!cfg.ok || typeof cfg.passwordEnabled !== 'boolean') {
    // Старый Code.gs (до админки) не знает admin.* — подсказываем, что сделать.
    showLogin(cfg.code === 'network' || cfg.code === 'http'
      ? cfg.message
      : 'Сервер ещё не обновлён для админки: вставьте новый Code.gs в Apps Script, запустите setup() и обновите развертывание (новая версия). Инструкция — docs/SETUP_GOOGLE.md, шаг 11.');
    $('#password-form').hidden = true;
    return false;
  }
  state.serverNotes = serverNotes(cfg);
  if (cfg.demo) {
    const demo = $('#login-demo');
    demo.hidden = false;
    demo.replaceChildren('Демо-режим. Пароль: ', h('b', {}, cfg.demoPassword));
  }
  if (cfg.googleEnabled && CONFIG.GOOGLE_CLIENT_ID) setupGoogle(cfg.nonce);
  $('#password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#password-submit');
    const pw = $('#password').value;
    if (!pw) return showLogin('Введите пароль.');
    setBusy(btn, true);
    const r = await api.call('admin.login', { password: pw });
    setBusy(btn, false);
    if (!r.ok) return showLogin(r.message);
    $('#password').value = '';
    afterLogin(r);
  });
  return true;
}

// Что сказать администратору про сервер: устаревший Code.gs или не заданные свойства скрипта.
const PROP_HINTS = {
  SITE_URL: 'SITE_URL — адрес сайта (без него сервер не видит свежий каталог)',
  GITHUB_REPO: 'GITHUB_REPO — «владелец/репозиторий» сайта (без него не работает «Опубликовать»)',
  GITHUB_TOKEN: 'GITHUB_TOKEN — ключ GitHub (без него не работает «Опубликовать»)',
};
function serverNotes(cfg) {
  const notes = [];
  if (!(Number(cfg.serverVersion) >= SERVER_VERSION)) {
    notes.push(`Сервер устарел (версия ${cfg.serverVersion || 1}, нужна ${SERVER_VERSION}). Вставьте свежий Code.gs в Apps Script → «Начать развертывание» → «Управление развертываниями» → ✏️ → Версия: «Новая версия». Не создавайте новое развертывание — у него другой адрес.`);
  }
  const missing = (cfg.setupProblems || []).map((k) => PROP_HINTS[k] || k);
  if (missing.length) notes.push(`В Apps Script не заданы свойства скрипта: ${missing.join('; ')}.`);
  return notes;
}

function setupGoogle(nonce) {
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = () => {
    window.google.accounts.id.initialize({
      client_id: CONFIG.GOOGLE_CLIENT_ID,
      nonce, // одноразовый: сервер примет токен только с ним
      callback: async (resp) => {
        const r = await api.call('admin.login', { google: resp.credential, nonce });
        if (!r.ok) return showLogin(r.message);
        afterLogin(r);
      },
    });
    window.google.accounts.id.renderButton($('#google-button'), { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', locale: 'ru', width: 300 });
    $('#google-box').hidden = false;
  };
  document.head.append(s);
}

function afterLogin(r) {
  setToken(r.token);
  state.me = r;
  start();
}

// ---------- Каркас ----------
async function start() {
  const me = await call('admin.me');
  if (!me.ok) return;
  state.me = me;
  $('#who').textContent = me.email ? me.email : 'вход по паролю';
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#demo-note').hidden = api.mode !== 'demo';
  const notes = state.serverNotes || [];
  $('#server-note').hidden = !notes.length;
  $('#server-note').replaceChildren(...notes.map((n) => h('p', {}, n)));
  await refreshCatalog();
  openTab(state.tab);
}

$$('.adm__tabs [data-tab]').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.tab)));
$('#logout').addEventListener('click', async () => {
  await call('admin.logout');
  setToken('');
  showLogin('Вы вышли.');
});
$('#demo-reset').addEventListener('click', () => {
  if (!confirm('Сбросить демо-каталог и публикацию в этом браузере?')) return;
  resetDemoAdmin();
  setToken('');
  location.reload();
});

const TABS = { catalog: renderCatalogTab, fillings: renderFillingsTab, texts: renderTextsTab, days: renderDaysTab, orders: renderOrdersTab, reception: renderReceptionTab, access: renderAccessTab };

function openTab(tab) {
  state.tab = tab;
  $$('.adm__tabs [data-tab]').forEach((b) => (b.dataset.tab === tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  const panel = $('#panel');
  panel.replaceChildren(h('p', { class: 'loading' }, 'Загрузка…'));
  TABS[tab](panel);
}

// ---------- Публикация ----------
async function refreshCatalog(data) {
  const c = data && data.draft ? data : await call('admin.catalog.get');
  if (!c.ok) { toast(c.message, true); return null; }
  state.catalog = c;
  updatePubbar();
  return c;
}

function updatePubbar() {
  const c = state.catalog;
  const bar = $('#pubbar');
  const btn = $('#publish');
  const n = c.changes.length;
  bar.classList.toggle('has-changes', n > 0);
  $('#pub-title').textContent = n ? `Не опубликовано изменений: ${n}` : 'Всё опубликовано';
  $('#pub-list').textContent = n
    ? (c.problems.length ? `Сначала исправьте: ${c.problems[0]}` : c.changes.join(', '))
    : (c.published.publishedAt ? `Версия ${c.published.version} · ${fmtDateTime(c.published.publishedAt)}${c.published.publishedBy ? ' · ' + c.published.publishedBy : ''}` : '');
  btn.setAttribute('aria-disabled', String(!n || c.problems.length > 0));
}

$('#publish').addEventListener('click', async () => {
  const btn = $('#publish');
  const c = state.catalog;
  if (!c || btn.getAttribute('aria-disabled') === 'true') {
    if (c && c.problems.length) toast('Сначала исправьте: ' + c.problems.join('; '), true);
    else toast('Нет изменений для публикации.');
    return;
  }
  if (!confirm(`Опубликовать на сайте?\n\n${c.changes.join('\n')}`)) return;
  setBusy(btn, true);
  const r = await call('admin.publish');
  setBusy(btn, false);
  if (!r.ok) return toast(r.message, true);
  toast(r.message);
  await refreshCatalog();
  if (state.tab === 'catalog') openTab('catalog');
});

// ---------- Ассортимент ----------
function thumbSrc(d) {
  if (d.imageSrc) return d.imageSrc;
  if (String(d.image).startsWith('images/')) return `${d.image}-480.${d.imageExt === 'jpg' ? 'jpg' : 'webp'}`;
  return '';
}

function renderCatalogTab(panel) {
  const c = state.catalog;
  if (!c) return panel.replaceChildren(h('p', { class: 'loading' }, 'Не удалось загрузить каталог.'));
  const ds = c.draft.desserts;
  const list = h('div', { class: 'items' }, ds.map((d, i) => {
    const src = thumbSrc(d);
    const thumb = src ? h('img', { class: 'item__thumb', src, alt: '', width: 72, height: 54, loading: 'lazy' }) : h('div', { class: 'item__thumb' });
    if (!src && String(d.image).startsWith('drive:')) loadPreview(d.image).then((u) => { if (u) thumb.replaceWith(h('img', { class: 'item__thumb', src: u, alt: '', width: 72, height: 54 })); });
    return h('div', { class: `item${d.visible === false ? ' is-hidden' : ''}` },
      thumb,
      h('div', {},
        h('p', { class: 'item__name' }, d.name),
        h('p', { class: 'item__meta' }, `${priceRangeText(d)} · ${d.unit || '—'} · за ${d.leadDays} дн.`),
        h('div', { class: 'item__tags' },
          d.badge ? h('span', { class: 'tag tag--berry' }, d.badge) : null,
          d.visible === false ? h('span', { class: 'tag' }, 'скрыт') : null,
          String(d.image).startsWith('drive:') ? h('span', { class: 'tag tag--draft' }, 'новое фото') : null)
      ),
      h('div', { class: 'item__actions' },
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Выше: ${d.name}`, disabled: i === 0, onclick: () => move(i, -1) }, svgIcon(['M12 18V6', 'm6 12 6-6 6 6'], 18)),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Ниже: ${d.name}`, disabled: i === ds.length - 1, onclick: () => move(i, 1) }, svgIcon(['M12 6v12', 'm6 12 6 6 6-6'], 18)),
        h('button', { class: 'btn btn--outline', type: 'button', style: { 'min-height': '44px', padding: '0 18px' }, onclick: () => openEditor(d) }, 'Изменить'))
    );
  }));
  panel.replaceChildren(
    h('div', { class: 'adm__head' },
      h('div', {}, h('h1', { class: 'adm__h2' }, 'Ассортимент'), h('p', { class: 'adm__sub' }, 'Порядок здесь = порядок на сайте. Первый десерт показывается крупной карточкой. Изменения попадут на сайт после «Опубликовать».')),
      h('button', { class: 'btn btn--primary', type: 'button', onclick: () => openEditor(null) }, '+ Добавить десерт')),
    list
  );
}

async function move(i, delta) {
  const ids = state.catalog.draft.desserts.map((d) => d.id);
  const j = i + delta;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  const r = await call('admin.reorder', { ids });
  if (!r.ok) return toast(r.message, true);
  await refreshCatalog(r);
  openTab('catalog');
}

const previewCache = new Map();
async function loadPreview(ref) {
  if (previewCache.has(ref)) return previewCache.get(ref);
  const r = await call('admin.photo.preview', { ref });
  const url = r.ok ? r.dataUrl : '';
  previewCache.set(ref, url);
  return url;
}

function openEditor(dessert) {
  const isNew = !dessert;
  const d = dessert ? { ...dessert } : { id: '', visible: true, name: '', description: '', fillings: [], priceMin: '', priceMax: '', unit: '', leadDays: 2, badge: '', image: '', alt: '' };
  const library = (state.catalog.draft.fillings || []).map((f) => f.name);
  let fillings = [...(d.fillings || [])];
  let photo = null; // { src (bitmap), fx, fy, enc }

  const inp = (name, value, attrs = {}) => h('input', { type: 'text', name, value: value ?? '', autocomplete: 'off', ...attrs });
  const name = inp('name', d.name, { maxlength: 80 });
  const code = inp('id', d.id, { maxlength: 40, autocapitalize: 'none', spellcheck: 'false', inputmode: 'url' });
  const desc = h('textarea', { name: 'description', maxlength: 300, rows: 3 }, d.description || '');
  const priceMin = inp('priceMin', d.priceMin, { inputmode: 'numeric' });
  const priceMax = inp('priceMax', d.priceMax, { inputmode: 'numeric' });
  const unit = inp('unit', d.unit, { maxlength: 40, placeholder: 'за торт ~450 г' });
  const lead = inp('leadDays', d.leadDays, { inputmode: 'numeric' });
  const badge = inp('badge', d.badge, { maxlength: 20, list: 'badge-list', placeholder: 'Хит, Новинка…' });
  const alt = inp('alt', d.alt, { maxlength: 200, placeholder: 'Что на фото — для незрячих и поисковиков' });
  let visible = d.visible !== false;
  let codeTouched = !isNew;
  code.addEventListener('input', () => { codeTouched = true; });
  name.addEventListener('input', () => { if (!codeTouched) code.value = slugify(name.value); });

  // Начинки — чипы
  const tagBox = h('div', { class: 'tags-input' });
  const tagInput = h('input', { type: 'text', list: 'filling-list', placeholder: 'Начинка и Enter', 'aria-label': 'Добавить начинку' });
  const addTag = () => {
    const v = tagInput.value.trim();
    if (v && !fillings.includes(v)) fillings.push(v);
    tagInput.value = '';
    drawTags();
    update();
  };
  tagInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(); } });
  tagInput.addEventListener('change', addTag);
  function drawTags() {
    tagBox.replaceChildren(...fillings.map((f) => h('span', { class: 'chip-x' }, f,
      h('button', { type: 'button', 'aria-label': `Убрать «${f}»`, onclick: () => { fillings = fillings.filter((x) => x !== f); drawTags(); update(); } }, svgIcon(['m6 6 12 12', 'M18 6 6 18'], 16)))), tagInput);
  }
  drawTags();
  const fillingsField = h('div', { class: 'f', 'data-field': 'fillings' }, h('span', { class: 'f__label' }, 'Начинки'), tagBox,
    h('p', { class: 'f__hint' }, 'Покупатель выберет одну из них в форме.'), h('p', { class: 'f__err' }));

  // Фото
  const stage = h('div', { class: 'photo-edit__stage', hidden: true, title: 'Нажмите на главное в кадре' });
  const frame = h('div', { class: 'photo-edit__frame' });
  const fileInput = h('input', { type: 'file', accept: 'image/*', class: 'visually-hidden', id: 'photo-file' });
  const photoErr = h('p', { class: 'f__err' });
  const photoField = h('div', { class: 'f photo-edit', 'data-field': 'image' },
    h('span', { class: 'f__label' }, 'Фото'),
    h('label', { class: 'photo-edit__pick', for: 'photo-file' }, svgIcon(['M4 8.5h3l1.6-2.5h6.8L17 8.5h3v10H4z', 'M12 16.4a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z'], 20), h('span', {}, d.image ? 'Заменить фото' : 'Загрузить фото')),
    fileInput, stage,
    h('p', { class: 'f__hint' }, 'Кадр 4:3. Нажмите на фото там, где главное — кадр сдвинется. Сжатие делается автоматически.'),
    photoErr);
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    photoErr.textContent = '';
    try {
      const src = await loadImage(file);
      photo = { src, fx: 0.5, fy: 0.5 };
      const url = URL.createObjectURL(file);
      stage.replaceChildren(h('img', { src: url, alt: '' }), frame);
      stage.hidden = false;
      await new Promise((r) => requestAnimationFrame(r));
      reframe();
    } catch (err) {
      photoErr.textContent = err.message;
    }
  });
  stage.addEventListener('click', (e) => {
    if (!photo) return;
    const r = stage.getBoundingClientRect();
    photo.fx = (e.clientX - r.left) / r.width;
    photo.fy = (e.clientY - r.top) / r.height;
    reframe();
  });
  function reframe() {
    const w = photo.src.width || photo.src.naturalWidth;
    const hh = photo.src.height || photo.src.naturalHeight;
    const box = cropBox(w, hh, photo.fx, photo.fy);
    Object.assign(frame.style, { left: `${(box.x / w) * 100}%`, top: `${(box.y / hh) * 100}%`, width: `${(box.w / w) * 100}%`, height: `${(box.h / hh) * 100}%` });
    photo.enc = encodeCrop(photo.src, photo.fx, photo.fy);
    update();
  }

  // Форма
  const errorsBox = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const form = h('form', { class: 'fgrid', novalidate: true },
    field('Название', name, { name: 'name', count: 80 }),
    field('Описание', desc, { name: 'description', count: 300, hint: 'Одно-два предложения: что это, размер, украшение.' }),
    fillingsField,
    h('div', { class: 'fgrid fgrid--2' },
      field('Цена от, ₽', priceMin, { name: 'priceMin' }),
      field('Цена до, ₽', priceMax, { name: 'priceMax' })),
    h('div', { class: 'fgrid fgrid--2' },
      field('Единица / размер', unit, { name: 'unit', hint: 'за торт ~450 г, 1,5–2,5 кг, набор 6 шт' }),
      field('Заказывать минимум за, дней', lead, { name: 'leadDays' })),
    h('div', { class: 'fgrid fgrid--2' },
      field('Бейдж', badge, { name: 'badge', hint: 'Необязательно' }),
      field('Код', code, { name: 'id', hint: 'Латиницей; используется в адресах фото. Обычно не трогать.' })),
    photoField,
    field('Описание фото', alt, { name: 'alt' }),
    switchCtl('Показывать на сайте', visible, (v) => { visible = v; update(); }),
    errorsBox,
    h('datalist', { id: 'filling-list' }, library.map((n) => h('option', { value: n }))),
    h('datalist', { id: 'badge-list' }, ['Хит', 'Новинка', 'Фирменный', 'Сезонный'].map((n) => h('option', { value: n })))
  );
  form.addEventListener('input', () => update());
  form.addEventListener('submit', (e) => { e.preventDefault(); saveBtn.click(); });

  const previewBox = h('ul', {});
  const preview = h('aside', { class: 'preview', 'aria-label': 'Превью карточки' }, h('p', { class: 'preview__label' }, 'Так увидит покупатель'), previewBox);
  const current = () => ({
    id: code.value.trim(), visible, name: name.value, description: desc.value, fillings,
    priceMin: priceMin.value, priceMax: priceMax.value, unit: unit.value, leadDays: lead.value, badge: badge.value, alt: alt.value,
    image: d.image, imageExt: d.imageExt,
  });
  async function update() {
    const cur = current();
    const card = { ...cur, priceMin: Number(cur.priceMin) || 0, priceMax: Number(cur.priceMax) || 0, name: cur.name || 'Название десерта', fillings: fillings.length ? fillings : ['—'] };
    if (photo && photo.enc) card.imageSrc = photo.enc.preview;
    else if (d.imageSrc) card.imageSrc = d.imageSrc;
    else if (String(d.image).startsWith('drive:')) card.imageSrc = await loadPreview(d.image);
    previewBox.replaceChildren(dishCard(card, {}));
  }

  const saveBtn = h('button', { class: 'btn btn--primary', type: 'button' }, h('span', { class: 'btn__label' }, isNew ? 'Добавить' : 'Сохранить'), h('span', { class: 'btn__spinner', 'aria-hidden': 'true' }));
  const delBtn = isNew ? null : h('button', { class: 'btn btn--danger', type: 'button' }, 'Удалить');
  const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Закрыть' }, svgIcon(['m6 6 12 12', 'M18 6 6 18'], 18));

  const sheet = h('div', { class: 'editor__sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'editor-title' },
    h('div', { class: 'editor__head' }, h('h2', { class: 'editor__title', id: 'editor-title' }, isNew ? 'Новый десерт' : d.name), closeBtn),
    h('div', { class: 'editor__body' }, form, preview),
    h('div', { class: 'editor__foot' }, delBtn || h('span'), h('div', { style: { display: 'flex', gap: '10px' } },
      h('button', { class: 'btn btn--outline', type: 'button', onclick: () => close() }, 'Отмена'), saveBtn)));
  const overlay = h('div', { class: 'editor' }, sheet);
  const opener = document.activeElement;
  document.body.append(overlay);
  document.body.style.overflow = 'hidden';
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  closeBtn.addEventListener('click', () => close());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  name.focus();
  update();

  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    document.body.style.overflow = '';
    if (opener && opener.focus) opener.focus();
  }

  saveBtn.addEventListener('click', async () => {
    errorsBox.hidden = true;
    const cur = current();
    if (!cur.id) cur.id = slugify(cur.name);
    setBusy(saveBtn, true);
    // Новое фото: сначала загружаем, потом сохраняем карточку со ссылкой на него.
    if (photo && photo.enc) {
      const up = await call('admin.photo.upload', { dessertId: cur.id, type: photo.enc.type, w480: photo.enc.w480, w900: photo.enc.w900 });
      if (!up.ok) { setBusy(saveBtn, false); photoErr.textContent = up.message; return; }
      cur.image = up.ref;
      cur.imageExt = photo.enc.type === 'image/jpeg' ? 'jpg' : 'webp';
      previewCache.set(up.ref, photo.enc.preview);
    }
    const r = await call('admin.dessert.save', { dessert: cur, originalId: isNew ? '' : d.id });
    setBusy(saveBtn, false);
    if (!r.ok) {
      showErrors(form, r.errors || {});
      errorsBox.textContent = r.message;
      errorsBox.hidden = false;
      return;
    }
    await refreshCatalog(r);
    close();
    openTab('catalog');
    toast(isNew ? 'Десерт добавлен. Не забудьте «Опубликовать».' : 'Сохранено. Не забудьте «Опубликовать».');
  });

  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm(`Удалить «${d.name}» из каталога? На сайте он пропадёт после публикации.\nСкрыть, не удаляя, можно переключателем «Показывать на сайте».`)) return;
    const r = await call('admin.dessert.delete', { id: d.id });
    if (!r.ok) return toast(r.message, true);
    await refreshCatalog(r);
    close();
    openTab('catalog');
    toast('Удалено из черновика.');
  });
}

// ---------- Начинки ----------
function renderFillingsTab(panel) {
  let items = (state.catalog.draft.fillings || []).map((f) => ({ ...f }));
  const list = h('div', { class: 'rows' });
  function draw() {
    list.replaceChildren(...items.map((f, i) => {
      const n = h('input', { type: 'text', value: f.name, maxlength: 80, 'aria-label': 'Название начинки' });
      const ds = h('textarea', { rows: 2, maxlength: 300, 'aria-label': 'Описание начинки' }, f.description);
      n.addEventListener('input', () => { items[i].name = n.value; });
      ds.addEventListener('input', () => { items[i].description = ds.value; });
      return h('div', { class: 'panel', style: { padding: '14px' } },
        h('div', { class: 'fgrid' }, h('div', { class: 'f' }, n), h('div', { class: 'f' }, ds)),
        h('button', { class: 'adm__link', type: 'button', onclick: () => { items.splice(i, 1); draw(); } }, 'Удалить начинку'));
    }));
  }
  draw();
  const save = h('button', { class: 'btn btn--primary', type: 'button' }, h('span', { class: 'btn__label' }, 'Сохранить начинки'), h('span', { class: 'btn__spinner', 'aria-hidden': 'true' }));
  save.addEventListener('click', async () => {
    setBusy(save, true);
    const r = await call('admin.fillings.save', { items });
    setBusy(save, false);
    if (!r.ok) return toast(r.message, true);
    await refreshCatalog(r);
    toast('Начинки сохранены. Не забудьте «Опубликовать».');
  });
  panel.replaceChildren(
    h('div', { class: 'adm__head' }, h('div', {}, h('h1', { class: 'adm__h2' }, 'Начинки'), h('p', { class: 'adm__sub' }, 'Описания для блока «Начинки» на сайте. Сами начинки каждого десерта задаются в его карточке.'))),
    list,
    h('div', { style: { display: 'flex', gap: '12px', 'flex-wrap': 'wrap', 'margin-top': '16px' } },
      h('button', { class: 'btn btn--outline', type: 'button', onclick: () => { items.push({ name: '', description: '' }); draw(); } }, '+ Добавить начинку'), save)
  );
}

// ---------- Тексты ----------
function renderTextsTab(panel) {
  const c = state.catalog;
  const ctrls = {};
  const form = h('form', { class: 'fgrid', novalidate: true }, c.textFields.map((f) => {
    const v = c.draft.texts[f.key] ?? '';
    const ctl = f.multiline ? h('textarea', { rows: f.lines ? 3 : 3 }, v) : h('input', { type: f.url ? 'url' : 'text', value: v, inputmode: f.url ? 'url' : null });
    ctrls[f.key] = ctl;
    return field(f.label, ctl, { name: f.key, hint: f.hint || '' });
  }));
  const save = h('button', { class: 'btn btn--primary', type: 'button' }, h('span', { class: 'btn__label' }, 'Сохранить тексты'), h('span', { class: 'btn__spinner', 'aria-hidden': 'true' }));
  save.addEventListener('click', async () => {
    const texts = {};
    Object.entries(ctrls).forEach(([k, el]) => { texts[k] = el.value; });
    setBusy(save, true);
    const r = await call('admin.texts.save', { texts });
    setBusy(save, false);
    if (!r.ok) { showErrors(form, r.errors || {}); return toast(r.message, true); }
    showErrors(form, {});
    await refreshCatalog(r);
    toast('Тексты сохранены. Не забудьте «Опубликовать».');
  });
  panel.replaceChildren(
    h('div', { class: 'adm__head' }, h('div', {}, h('h1', { class: 'adm__h2' }, 'Тексты и контакты'), h('p', { class: 'adm__sub' }, 'Заголовки, описания, адрес, часы и ссылки на соцсети.'))),
    h('div', { class: 'panel' }, form, h('div', { style: { 'margin-top': '20px' } }, save))
  );
}

// ---------- Даты ----------
async function renderDaysTab(panel) {
  const r = await call('admin.days.get');
  if (!r.ok) return panel.replaceChildren(h('p', { class: 'loading' }, r.message));
  const LABEL = { free: 'свободно', few: 'мало мест', full: 'мест нет', closed: 'закрыто' };
  const rows = h('div', { class: 'rows' }, r.dates.map((d) => {
    const limit = h('input', { type: 'number', min: 0, max: 999, inputmode: 'numeric', value: d.customLimit, placeholder: String(r.settings.defaultLimit), 'aria-label': `Лимит на ${d.date}` });
    const status = h('span', { class: `status status--${d.status}` }, LABEL[d.status]);
    const info = h('span', { class: 'small muted' }, d.status === 'closed' ? '' : `принято ${d.accepted} из ${d.limit}`);
    let closed = d.closedFlag;
    const saveDay = async () => {
      const res = await call('admin.day.set', { date: d.date, limit: limit.value === '' ? '' : Number(limit.value), closed });
      if (!res.ok) return toast(res.message, true);
      const nd = res.dates.find((x) => x.date === d.date);
      status.className = `status status--${nd.status}`;
      status.textContent = LABEL[nd.status];
      info.textContent = nd.status === 'closed' ? '' : `принято ${nd.accepted} из ${nd.limit}`;
      toast(`${formatDateWeekday(d.date)}: сохранено`);
    };
    limit.addEventListener('change', saveDay);
    return h('div', { class: 'row' },
      h('p', { class: 'row__date' }, formatDateWeekday(d.date), info),
      status,
      h('div', { class: 'row__ctrl' }, h('label', { class: 'small' }, 'Лимит ', limit), switchCtl('Закрыть', closed, (v) => { closed = v; saveDay(); })));
  }));
  panel.replaceChildren(
    h('div', { class: 'adm__head' }, h('div', {}, h('h1', { class: 'adm__h2' }, 'Даты и лимиты'),
      h('p', { class: 'adm__sub' }, `Пустой лимит — по умолчанию (${r.settings.defaultLimit}). 0 или «Закрыть» — выходной. Меняется сразу, публиковать не нужно.`))),
    rows
  );
}

// ---------- Заявки ----------
async function renderOrdersTab(panel) {
  const r = await call('admin.orders.list', { limit: 150 });
  if (!r.ok) return panel.replaceChildren(h('p', { class: 'loading' }, r.message));
  let filter = 'all';
  const list = h('div', { class: 'rows' });
  const filters = h('div', { class: 'filters', role: 'group', 'aria-label': 'Фильтр' }, [['all', 'Все'], ['Новая', 'Новые'], ['Лист ожидания', 'Лист ожидания'], ['Отменена', 'Отменённые']].map(([k, label]) =>
    h('button', { type: 'button', 'aria-pressed': String(k === filter), onclick: (e) => { filter = k; $$('button', filters).forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); draw(); } }, label)));
  function contactLink(c) {
    if (/^@/.test(c)) return h('a', { href: `https://t.me/${c.slice(1)}`, target: '_blank', rel: 'noopener' }, c);
    if (/^\+7/.test(c)) return h('a', { href: `tel:${c.replace(/[^\d+]/g, '')}` }, c);
    return c;
  }
  function draw() {
    const items = r.orders.filter((o) => filter === 'all' || o.status === filter);
    if (!items.length) return list.replaceChildren(h('p', { class: 'muted' }, 'Заявок пока нет.'));
    list.replaceChildren(...items.map((o) => {
      const sel = h('select', { 'aria-label': `Статус ${o.number}` }, ['Новая', 'Лист ожидания', 'Отменена'].map((s) => h('option', { value: s, selected: s === o.status }, s)));
      sel.addEventListener('change', async () => {
        const res = await call('admin.order.setStatus', { number: o.number, status: sel.value });
        if (!res.ok) { sel.value = o.status; return toast(res.message, true); }
        o.status = sel.value;
        toast(`${o.number}: ${sel.value}`);
      });
      const rows = [
        ['Дата', o.date ? formatDateWeekday(o.date) : '—'], ['Десерт', o.dessert], ['Начинка', o.filling],
        ['Получение', o.pickup + (o.address ? ` — ${o.address}` : '')], ['Имя', o.name], ['Контакт', contactLink(o.contact)],
        o.comment ? ['Комментарий', o.comment] : null, ['Цена-ориентир', o.price],
        o.photo && o.photo !== 'нет' ? ['Фото', /^https:\/\//.test(o.photo) ? h('a', { href: o.photo, target: '_blank', rel: 'noopener' }, 'открыть') : o.photo] : null,
      ].filter(Boolean);
      return h('article', { class: 'panel order' },
        h('div', { class: 'order__top' }, h('span', { class: 'order__num' }, o.number), h('span', { class: 'small muted' }, fmtDateTime(o.createdAt)), sel),
        h('dl', { class: 'order__body' }, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
    }));
  }
  draw();
  panel.replaceChildren(
    h('div', { class: 'adm__head' }, h('div', {}, h('h1', { class: 'adm__h2' }, 'Заявки'), h('p', { class: 'adm__sub' }, '«Отменена» освобождает место в дне. Из листа ожидания в «Новая» — когда освободилось место.'))),
    filters, list
  );
}

// ---------- Приём ----------
async function renderReceptionTab(panel) {
  const r = await call('admin.settings.get');
  if (!r.ok) return panel.replaceChildren(h('p', { class: 'loading' }, r.message));
  const s = r.settings;
  let accepting = s.acceptingOrders;
  const note = h('input', { type: 'text', value: s.pauseNote, maxlength: 300, placeholder: 'Мы в отпуске до 20 ноября' });
  const limit = h('input', { type: 'number', min: 0, max: 999, value: s.defaultLimit, inputmode: 'numeric' });
  const ahead = h('input', { type: 'number', min: 1, max: 180, value: s.daysAhead, inputmode: 'numeric' });
  const few = h('input', { type: 'number', min: 0, max: 100, value: s.fewPercent, inputmode: 'numeric' });
  const save = h('button', { class: 'btn btn--primary', type: 'button' }, h('span', { class: 'btn__label' }, 'Сохранить'), h('span', { class: 'btn__spinner', 'aria-hidden': 'true' }));
  save.addEventListener('click', async () => {
    setBusy(save, true);
    const res = await call('admin.settings.set', { settings: { acceptingOrders: accepting, pauseNote: note.value, defaultLimit: Number(limit.value), daysAhead: Number(ahead.value), fewPercent: Number(few.value) } });
    setBusy(save, false);
    if (!res.ok) return toast(res.message, true);
    toast(accepting ? 'Сохранено. Приём заявок открыт.' : 'Сохранено. Приём заявок остановлен — на сайте баннер.');
  });
  panel.replaceChildren(
    h('div', { class: 'adm__head' }, h('div', {}, h('h1', { class: 'adm__h2' }, 'Приём заявок'), h('p', { class: 'adm__sub' }, 'Меняется сразу, публиковать не нужно.'))),
    h('div', { class: 'panel fgrid' },
      switchCtl('Принимаем заявки', accepting, (v) => { accepting = v; }),
      field('Заметка на сайте, когда приём остановлен', note, { name: 'pauseNote' }),
      h('div', { class: 'fgrid fgrid--2' },
        field('Лимит заказов на день по умолчанию', limit, { name: 'defaultLimit' }),
        field('Показывать дней вперёд', ahead, { name: 'daysAhead', hint: 'От 1 до 180' })),
      field('Порог «мало мест», %', few, { name: 'fewPercent', hint: 'Последнее место — всегда «мало мест»' }),
      h('div', {}, save))
  );
}

// ---------- Доступ ----------
async function renderAccessTab(panel) {
  const r = await call('admin.access.list');
  if (!r.ok) return panel.replaceChildren(h('p', { class: 'loading' }, r.message));
  const people = h('div', { class: 'rows' });
  function draw(list) {
    if (!list.length) return people.replaceChildren(h('p', { class: 'muted' }, 'Пока никого — входить через Google может только владелец таблицы.'));
    people.replaceChildren(...list.map((p) => h('div', { class: 'row' },
      h('p', { class: 'row__date' }, p.email, h('span', {}, [p.name, p.lastLogin ? `вход: ${fmtDateTime(p.lastLogin)}` : 'ещё не входил(а)'].filter(Boolean).join(' · '))),
      h('span'),
      h('div', { class: 'row__ctrl' },
        switchCtl('Доступ', p.enabled, async (v, input) => {
          const res = await call('admin.access.save', { email: p.email, name: p.name, enabled: v });
          if (!res.ok) { input.checked = !v; return toast(res.message, true); }
          toast(v ? `Доступ включён: ${p.email}` : `Доступ выключен: ${p.email}`);
        }),
        h('button', { class: 'adm__link', type: 'button', onclick: async () => {
          if (!confirm(`Убрать доступ ${p.email}?`)) return;
          const res = await call('admin.access.delete', { email: p.email });
          if (!res.ok) return toast(res.message, true);
          draw(res.people);
        } }, 'Удалить')))));
  }
  draw(r.people);

  const email = h('input', { type: 'email', inputmode: 'email', autocomplete: 'off', placeholder: 'name@gmail.com' });
  const nm = h('input', { type: 'text', maxlength: 60, placeholder: 'Ольга' });
  const add = h('button', { class: 'btn btn--outline', type: 'button' }, 'Добавить');
  add.addEventListener('click', async () => {
    const res = await call('admin.access.save', { email: email.value, name: nm.value, enabled: true });
    if (!res.ok) return toast(res.message, true);
    email.value = ''; nm.value = '';
    draw(res.people);
    toast('Добавлено. Человек сможет войти кнопкой «Войти через Google».');
  });

  const pw1 = h('input', { type: 'password', autocomplete: 'new-password' });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const setPw = h('button', { class: 'btn btn--outline', type: 'button' }, 'Сменить пароль');
  setPw.addEventListener('click', async () => {
    if (pw1.value !== pw2.value) return toast('Пароли не совпадают.', true);
    const res = await call('admin.password.set', { password: pw1.value });
    if (!res.ok) return toast(res.message, true);
    pw1.value = pw2.value = '';
    toast(res.message);
    if (state.me && state.me.method === 'password') { setToken(''); showLogin('Пароль изменён — войдите с новым.'); }
  });
  const revoke = h('button', { class: 'btn btn--danger', type: 'button' }, 'Выйти на всех устройствах');
  revoke.addEventListener('click', async () => {
    if (!confirm('Завершить все входы в админку, включая этот?')) return;
    const res = await call('admin.sessions.revoke');
    if (!res.ok) return toast(res.message, true);
    setToken('');
    showLogin(res.message);
  });

  panel.replaceChildren(
    h('div', { class: 'adm__head' }, h('div', {}, h('h1', { class: 'adm__h2' }, 'Доступ к админке'),
      h('p', { class: 'adm__sub' }, 'Все администраторы равны: могут всё, включая публикацию и доступ. О каждом изменении приходит сообщение в Telegram.'))),
    h('section', { class: 'panel' }, h('h2', { class: 'panel__title' }, 'Вход через Google'),
      h('p', { class: 'small muted', style: { 'margin-bottom': '12px' } }, `Владелец таблицы входит всегда: ${r.owner || '—'}. Этот же список — лист «Доступ» в Google-таблице.`),
      people,
      h('div', { class: 'fgrid fgrid--2', style: { 'margin-top': '16px' } }, field('Почта Google', email, { name: 'email' }), field('Имя', nm, { name: 'name' })),
      h('div', { style: { 'margin-top': '12px' } }, add)),
    h('section', { class: 'panel' }, h('h2', { class: 'panel__title' }, 'Пароль'),
      h('p', { class: 'small muted', style: { 'margin-bottom': '12px' } }, 'Один общий пароль для входа без Google. Хранится только в зашифрованном виде; после смены все, кто вошёл по старому, выходят.'),
      h('div', { class: 'fgrid fgrid--2' }, field('Новый пароль (от 8 символов)', pw1, { name: 'pw1' }), field('Ещё раз', pw2, { name: 'pw2' })),
      h('div', { style: { 'margin-top': '12px' } }, setPw)),
    h('section', { class: 'panel' }, h('h2', { class: 'panel__title' }, 'Безопасность'),
      h('p', { class: 'small muted', style: { 'margin-bottom': '12px' } }, 'Если кажется, что пароль узнал посторонний: смените пароль и нажмите кнопку ниже.'),
      revoke)
  );
}

// ---------- Старт ----------
(async function init() {
  const ready = await initLogin();
  if (!ready) return; // сообщение о проблеме уже на экране входа
  if (getToken()) start(); else showLogin();
})();
