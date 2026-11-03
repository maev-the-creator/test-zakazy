// Форма заявки: десерт ↔ каталог, начинки, календарь, получение, данные, фото,
// липкая панель с ценой, отправка и экран результата.
import { h, $, $$, scrollToEl, prefersReducedMotion } from './dom.js';
import { markPicked, setCatalogPaused } from './render.js';
import { Calendar } from './calendar.js';
import { compressPhoto, formatBytes } from './photo.js';
import {
  validateOrder, priceRangeText, daysWord, formatDateLong, formatDateShort, normalizeContact,
} from './logic.generated.js';

// Порядок шагов = порядок подсветки первой ошибки.
const FIELD_ORDER = ['dessertId', 'filling', 'date', 'pickup', 'address', 'name', 'contact', 'comment', 'photo', 'consent'];
const FIELD_STEP = {
  dessertId: 'step-dessert', filling: 'step-filling', date: 'step-date', pickup: 'step-pickup', address: 'step-pickup',
  name: 'step-contact', contact: 'step-contact', comment: 'step-contact', photo: 'step-contact', consent: 'step-contact',
};
const FIELD_FOCUS = {
  dessertId: '#f-dessert', filling: '#filling-choices input', date: '#calendar .day[tabindex="0"]', pickup: 'input[name="pickup"]',
  address: '#f-address', name: '#f-name', contact: '#f-contact', comment: '#f-comment', photo: '#f-photo', consent: '#f-consent',
};
const FIELD_INPUT = { dessertId: '#f-dessert', address: '#f-address', name: '#f-name', contact: '#f-contact', comment: '#f-comment', consent: '#f-consent' };

function newRequestId() {
  const rnd = window.crypto && crypto.getRandomValues ? Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('') : String(Math.random()).slice(2) + Date.now();
  return 'r' + rnd;
}

export function initOrderForm({ config, api }) {
  const desserts = config.desserts;
  const byId = new Map(desserts.map((d) => [d.id, d]));
  const state = {
    dessertId: '', filling: '', date: '', pickup: '', photo: null, photoName: '',
    accepting: true, sending: false, touched: new Set(), attempted: false,
    requestId: newRequestId(),
  };

  const form = $('#order-form');
  const fieldset = $('#order-fieldset');
  const select = $('#f-dessert');
  const fillingBox = $('#filling-choices');
  const bar = $('#action-bar');
  const submitBtn = $('#submit-btn');
  const submitLabel = $('#submit-label');
  const formError = $('#form-error');
  const success = $('#success');

  // ---------- Десерт ----------
  select.append(...desserts.map((d) => h('option', { value: d.id }, d.name)));
  select.addEventListener('change', () => setDessert(select.value, { source: 'select' }));

  const calendar = new Calendar($('#calendar'), {
    defaultLead: Math.min(...desserts.map((d) => d.leadDays)),
    onSelect: (ymd) => {
      state.date = ymd || '';
      if (ymd) clearError('date');
      refresh();
      // Строка-статус под календарём не должна прятаться под липкой панелью.
      const status = ymd && $('#calendar .cal__status');
      if (status) requestAnimationFrame(() => status.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' }));
    },
  });

  function setDessert(id, { source } = {}) {
    const d = byId.get(id) || null;
    state.dessertId = d ? d.id : '';
    select.value = state.dessertId;
    markPicked(state.dessertId);
    $('#dessert-meta').textContent = d
      ? `${priceRangeText(d)} · ${d.unit} · заказывать за ${daysWord(d.leadDays)}`
      : '';
    renderFillings(d);
    const cleared = calendar.setDessert(d);
    if (cleared) {
      state.date = '';
      showError('date', `${formatDateLong(cleared)} — слишком рано для этого десерта. Выберите дату позже.`);
    }
    if (d) clearError('dessertId');
    refresh();
    if (source === 'catalog') {
      // Шаг 1 с подставленным десертом и сразу под ним — выбор начинки.
      scrollToEl($('#step-dessert'), { offset: 16 });
      // Фокус — на следующее действие (начинка), иначе Tab вернёт в каталог.
      const next = $('#filling-choices input:checked') || $('#filling-choices input') || select;
      setTimeout(() => next.focus({ preventScroll: true }), 50);
    }
  }

  const fillingInfo = new Map((config.fillings.items || []).map((f) => [f.name, f.description]));
  function showFillingInfo() {
    const desc = fillingInfo.get(state.filling);
    $('#filling-meta').textContent = desc ? `${state.filling}: ${desc.charAt(0).toLowerCase()}${desc.slice(1)}` : '';
  }

  function renderFillings(d) {
    if (!d) {
      $('#filling-meta').textContent = '';
      state.filling = '';
      fillingBox.replaceChildren(h('p', { class: 'choices__empty' }, 'Сначала выберите десерт'));
      return;
    }
    if (!d.fillings.includes(state.filling)) state.filling = '';
    // Единственная начинка выбирается сама.
    if (d.fillings.length === 1) state.filling = d.fillings[0];
    fillingBox.replaceChildren(...d.fillings.map((f) =>
      h('label', { class: 'chip' },
        h('input', { type: 'radio', name: 'filling', value: f, checked: f === state.filling }),
        h('span', {}, f))
    ));
    if (state.filling) clearError('filling');
    showFillingInfo();
  }
  fillingBox.addEventListener('change', (e) => {
    if (e.target.name !== 'filling') return;
    state.filling = e.target.value;
    showFillingInfo();
    clearError('filling');
    refresh();
  });

  // ---------- Получение ----------
  const addressField = $('#address-field');
  form.addEventListener('change', (e) => {
    if (e.target.name !== 'pickup') return;
    state.pickup = e.target.value;
    addressField.hidden = state.pickup !== 'delivery';
    $('#pickup-meta').textContent = state.pickup === 'delivery'
      ? 'Стоимость доставки назовёт кондитер — она зависит от адреса и размера торта.'
      : `${config.contacts.address}. ${config.contacts.hours}.`;
    clearError('pickup');
    if (state.pickup !== 'delivery') clearError('address');
    refresh();
  });

  // ---------- Текстовые поля: проверка при уходе с поля ----------
  ['address', 'name', 'contact', 'comment'].forEach((name) => {
    const input = $(FIELD_INPUT[name]);
    input.addEventListener('input', () => {
      if (state.touched.has(name) || state.attempted) liveCheck(name);
      refresh();
    });
    input.addEventListener('blur', () => {
      if (input.value.trim()) state.touched.add(name);
      if (state.touched.has(name)) liveCheck(name);
    });
  });
  // Контакт: аккуратно форматируем телефон после ввода.
  $('#f-contact').addEventListener('blur', (e) => {
    const n = normalizeContact(e.target.value);
    if (n.ok && n.kind === 'phone') e.target.value = n.value;
  });
  $('#f-consent').addEventListener('change', () => {
    if ($('#f-consent').checked) clearError('consent');
    refresh();
  });

  function liveCheck(name) {
    const v = validateOrder(payload(), desserts);
    if (v.ok || !v.errors[name]) clearError(name);
    else showError(name, v.errors[name]);
  }

  // ---------- Фото-референс ----------
  const photoInput = $('#f-photo');
  photoInput.addEventListener('change', async () => {
    const file = photoInput.files && photoInput.files[0];
    if (!file) return;
    clearError('photo');
    const pick = $('.photo__pick span');
    pick.textContent = 'Обрабатываем фото…';
    try {
      const p = await compressPhoto(file, { maxMb: config.form.photoMaxMb });
      state.photo = { type: p.type, data: p.data };
      state.photoName = file.name;
      $('#photo-img').src = p.dataUrl;
      $('#photo-name').textContent = file.name;
      $('#photo-size').textContent = `${p.width}×${p.height}, ${formatBytes(p.bytes)}`;
      $('#photo-preview').hidden = false;
      pick.textContent = 'Заменить фото';
    } catch (err) {
      state.photo = null;
      showError('photo', err.message);
      pick.textContent = 'Прикрепить фото';
    }
    photoInput.value = '';
  });
  $('#photo-remove').addEventListener('click', () => {
    state.photo = null;
    state.photoName = '';
    $('#photo-preview').hidden = true;
    $('#photo-img').removeAttribute('src');
    $('.photo__pick span').textContent = 'Прикрепить фото';
    clearError('photo');
    photoInput.focus();
  });

  // ---------- Ошибки ----------
  function showError(field, message) {
    const err = $(`#err-${field}`);
    if (err) err.textContent = message;
    const input = FIELD_INPUT[field] && $(FIELD_INPUT[field]);
    if (input) input.setAttribute('aria-invalid', 'true');
    $(`#${FIELD_STEP[field]}`).classList.add('is-invalid');
  }
  function clearError(field) {
    const err = $(`#err-${field}`);
    if (err) err.textContent = '';
    const input = FIELD_INPUT[field] && $(FIELD_INPUT[field]);
    if (input) input.removeAttribute('aria-invalid');
    const step = $(`#${FIELD_STEP[field]}`);
    const stillBad = FIELD_ORDER.some((f) => FIELD_STEP[f] === FIELD_STEP[field] && $(`#err-${f}`) && $(`#err-${f}`).textContent);
    if (!stillBad) step.classList.remove('is-invalid');
  }
  function clearAllErrors() {
    FIELD_ORDER.forEach(clearError);
    formError.hidden = true;
    formError.textContent = '';
  }
  function showFormError(message) {
    formError.textContent = message;
    formError.hidden = false;
  }

  // ---------- Данные заявки ----------
  function payload() {
    return {
      dessertId: state.dessertId,
      filling: state.filling,
      date: state.date,
      pickup: state.pickup,
      address: $('#f-address').value,
      name: $('#f-name').value,
      contact: $('#f-contact').value,
      comment: $('#f-comment').value,
      consent: $('#f-consent').checked,
      photo: state.photo,
      website: $('#f-website').value,
      // Одна и та же попытка при повторе (после таймаута) не создаст вторую заявку.
      requestId: state.requestId,
    };
  }

  // ---------- Липкая панель ----------
  let barShown = false;
  const ro = 'ResizeObserver' in window ? new ResizeObserver(() => syncBarHeight()) : null;
  if (ro) ro.observe(bar);
  function syncBarHeight() {
    document.documentElement.style.setProperty('--bar-h', barShown ? `${bar.offsetHeight}px` : '0px');
  }
  function setBar(show) {
    if (show === barShown) return;
    barShown = show;
    bar.classList.toggle('is-visible', show);
    bar.setAttribute('aria-hidden', String(!show));
    syncBarHeight();
  }

  function refresh() {
    const d = byId.get(state.dessertId);
    $('#bar-price').textContent = d ? priceRangeText(d) : '';
    setBar(!!d && state.accepting && success.hidden);
    const waitlist = calendar.isWaitlist();
    if (!state.sending) {
      // На узком экране — короткая подпись, чтобы панель не вырастала; полная — для скринридера.
      const narrow = window.matchMedia('(max-width: 479px)').matches;
      submitLabel.textContent = waitlist ? (narrow ? 'В лист ожидания' : 'Встать в лист ожидания') : 'Отправить заявку';
      submitBtn.setAttribute('aria-label', waitlist ? 'Встать в лист ожидания' : 'Отправить заявку');
    }
    const complete = validateOrder(payload(), desserts).ok;
    submitBtn.setAttribute('aria-disabled', String(!complete || state.sending || !state.accepting));
    // Отмечаем заполненные шаги
    $('#step-dessert').classList.toggle('is-done', !!d);
    $('#step-filling').classList.toggle('is-done', !!state.filling);
    $('#step-date').classList.toggle('is-done', !!state.date);
    $('#step-pickup').classList.toggle('is-done', !!state.pickup && (state.pickup !== 'delivery' || $('#f-address').value.trim().length >= 5));
    $('#step-contact').classList.toggle('is-done', $('#f-name').value.trim().length >= 2 && normalizeContact($('#f-contact').value).ok && $('#f-consent').checked);
  }

  // ---------- Отправка ----------
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.sending || !state.accepting) return;
    state.attempted = true;
    formError.hidden = true;
    const data = payload();
    const v = validateOrder(data, desserts);
    if (!v.ok) {
      if (v.code === 'spam') return showFormError('Не получилось отправить заявку. Обновите страницу и попробуйте ещё раз.');
      FIELD_ORDER.forEach((f) => (v.errors[f] ? showError(f, v.errors[f]) : clearError(f)));
      highlightFirst(v.errors);
      return;
    }
    const expectedWaitlist = calendar.isWaitlist();
    setSending(true);
    let res;
    try {
      res = await api.submit(data);
    } catch (err) {
      setSending(false);
      showFormError(`${err.message} Ваши данные сохранены в форме.`);
      return;
    }
    setSending(false);
    if (res && res.ok) {
      state.requestId = newRequestId();
      showSuccess(res, data, expectedWaitlist);
      loadAvailability({ quiet: true });
      return;
    }
    handleFailure(res || {});
  });

  // Кнопка в панели: пока заявка не заполнена — подсвечиваем первое незаполненное.
  submitBtn.addEventListener('click', (e) => {
    if (submitBtn.getAttribute('aria-disabled') === 'true' && !state.sending && state.accepting) {
      e.preventDefault();
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });

  function highlightFirst(errors) {
    const first = FIELD_ORDER.find((f) => errors[f]);
    if (!first) return;
    const step = $(`#${FIELD_STEP[first]}`);
    scrollToEl(step, { offset: 16 });
    const target = $(FIELD_FOCUS[first]);
    if (target) setTimeout(() => target.focus({ preventScroll: true }), 350);
  }

  function handleFailure(res) {
    const code = res.code;
    if (code === 'validation' && res.errors) {
      FIELD_ORDER.forEach((f) => (res.errors[f] ? showError(f, res.errors[f]) : clearError(f)));
      highlightFirst(res.errors);
      return;
    }
    if (code === 'paused') {
      loadAvailability({ quiet: true });
      showFormError(res.message);
      scrollToEl($('#order'), { offset: 8 });
      return;
    }
    if (code === 'too_early' || code === 'closed' || code === 'out_of_window') {
      showError('date', res.message);
      calendar.clear();
      state.date = '';
      refresh();
      highlightFirst({ date: true });
      loadAvailability({ quiet: true });
      return;
    }
    showFormError(res.message || 'Не получилось отправить заявку. Попробуйте ещё раз через минуту.');
  }

  function setSending(on) {
    state.sending = on;
    submitBtn.classList.toggle('is-loading', on);
    submitBtn.setAttribute('aria-busy', String(on));
    if (on) submitLabel.textContent = 'Отправляем…';
    fieldset.disabled = on || !state.accepting;
    refresh();
  }

  // ---------- Экран результата ----------
  function showSuccess(res, data, expectedWaitlist) {
    const d = byId.get(data.dessertId);
    const waitlist = res.status === 'waitlist';
    $('#success-title').replaceChildren('Заявка ', h('span', { class: 'nowrap' }, res.number), ' отправлена');
    let text = waitlist
      ? `Вы в листе ожидания на ${formatDateShort(data.date)}. Если место освободится, кондитер напишет вам.`
      : 'Кондитер свяжется с вами, подтвердит дату и назовёт точную стоимость.';
    if (waitlist && !expectedWaitlist) text = `Пока вы заполняли форму, последнее место на эту дату заняли. ${text}`;
    $('#success-text').textContent = text;
    const contact = normalizeContact(data.contact);
    const rows = [
      ['Десерт', d.name],
      ['Начинка', data.filling],
      ['Дата', formatDateLong(data.date)],
      ['Получение', data.pickup === 'delivery' ? `Доставка — ${data.address.trim()}` : 'Самовывоз'],
      ['Имя', data.name.trim()],
      ['Контакт', contact.ok ? contact.value : data.contact],
      data.comment.trim() ? ['Комментарий', data.comment.trim()] : null,
      data.photo ? ['Фото', 'прикреплено'] : null,
      ['Цена-ориентир', priceRangeText(d)],
    ].filter(Boolean);
    $('#success-summary').replaceChildren(...rows.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))));
    form.hidden = true;
    success.hidden = false;
    success.classList.remove('is-entering');
    void success.offsetWidth;
    success.classList.add('is-entering');
    refresh();
    scrollToEl($('#order'), { offset: 8 });
    setTimeout(() => success.focus({ preventScroll: true }), 50);
  }

  $('#again').addEventListener('click', () => {
    resetForm();
    scrollToEl($('#order'), { offset: 8 });
    setTimeout(() => select.focus({ preventScroll: true }), 300);
  });

  function resetForm() {
    // Имя и контакт оставляем — удобно, если заказывают ещё один десерт.
    state.filling = '';
    state.date = '';
    state.pickup = '';
    state.photo = null;
    state.attempted = false;
    state.touched.clear();
    $$('input[name="pickup"]').forEach((r) => { r.checked = false; });
    addressField.hidden = true;
    $('#pickup-meta').textContent = '';
    ['#f-address', '#f-comment'].forEach((s) => { $(s).value = ''; });
    $('#f-consent').checked = false;
    $('#photo-remove').click();
    calendar.clear();
    setDessert('', {});
    clearAllErrors();
    success.hidden = true;
    form.hidden = false;
    refresh();
  }

  // ---------- Свободные даты ----------
  async function loadAvailability({ quiet = false } = {}) {
    if (!quiet) calendar.setLoading();
    try {
      const av = await api.availability();
      if (!av || !av.ok) throw new Error((av && av.message) || 'Не удалось загрузить свободные даты.');
      applyAccepting(av);
      calendar.setData(av);
      if (state.date && !calendar.byDate.has(state.date)) state.date = '';
      refresh();
    } catch (err) {
      if (!quiet) calendar.setError(`${err.message || 'Не удалось загрузить свободные даты.'}`, () => loadAvailability());
    }
  }

  function applyAccepting(av) {
    state.accepting = av.acceptingOrders !== false;
    const banner = $('#pause-banner');
    banner.hidden = state.accepting;
    $('#pause-note').textContent = state.accepting ? '' : (av.pauseNote || '');
    fieldset.disabled = !state.accepting || state.sending;
    // Сообщение — в начале формы, а не под ней; кнопки каталога — «Приём на паузе».
    $('#order-paused').hidden = state.accepting;
    $('#order-paused-note').textContent = [av.pauseNote, 'Форма откроется, когда кондитер снова начнёт принимать заказы. Каталог можно смотреть.'].filter(Boolean).join(' ');
    setCatalogPaused(!state.accepting, state.dessertId);
    refresh();
  }

  // Стартовое состояние
  refresh();
  loadAvailability();

  return {
    pickFromCatalog: (id) => {
      if (!state.accepting) return;
      // После отправленной заявки «Выбрать» начинает новую.
      if (!success.hidden) resetForm();
      setDessert(id, { source: 'catalog' });
    },
    reload: () => loadAvailability(),
  };
}
