// Календарь свободных дат: месяц, неделя с понедельника, статусы, клавиатура.
import { h, svgIcon, ICONS } from './dom.js';
import {
  addDays, diffDays, weekdayIndex, formatDateLong, formatDateWeekday, daysWord,
  MONTHS_NOMINATIVE, WEEKDAYS_SHORT,
} from './logic.generated.js';

const TAGS = { free: 'есть', few: 'мало', full: 'нет', off: '—' };
// Рукописная обводка выбранной даты (SVG-путь «пером», с нахлёстом в конце).
const RING_PATH = 'M52 5 C79 4 97 15 96 31 C95 49 74 57 49 56 C24 55 4 46 5 30 C6 14 25 6 57 7';

function ymdParts(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return { y, m, d };
}
function monthKey(ymd) {
  return ymd.slice(0, 7);
}
function firstOfMonth(key) {
  return `${key}-01`;
}
function shiftMonth(key, delta) {
  let [y, m] = key.split('-').map(Number);
  m += delta;
  while (m > 12) { m -= 12; y++; }
  while (m < 1) { m += 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

export class Calendar {
  constructor(root, { onSelect, defaultLead = 0 } = {}) {
    this.root = root;
    this.defaultLead = defaultLead; // срок, пока десерт не выбран (минимальный по каталогу)
    this.onSelect = onSelect || (() => {});
    this.av = null;
    this.byDate = new Map();
    this.dessert = null;
    this.selected = null;
    this.focusDate = null;
    this.month = null;
    root.addEventListener('keydown', (e) => this.onKey(e));
  }

  // ---------- Состояния загрузки ----------
  setLoading() {
    this.root.setAttribute('aria-busy', 'true');
    this.root.replaceChildren(
      h('p', { class: 'visually-hidden', role: 'status' }, 'Загружаем свободные даты…'),
      h('div', { class: 'cal__skeleton', 'aria-hidden': 'true' }, Array.from({ length: 35 }, () => h('span')))
    );
  }

  setError(message, onRetry) {
    this.root.removeAttribute('aria-busy');
    this.root.replaceChildren(
      h('div', { class: 'cal__error', role: 'alert' },
        h('p', {}, message || 'Не удалось загрузить свободные даты.'),
        h('button', { class: 'btn btn--outline', type: 'button', onclick: onRetry }, 'Повторить')
      )
    );
  }

  setData(av) {
    this.av = av;
    this.byDate = new Map(av.dates.map((d) => [d.date, d]));
    this.root.removeAttribute('aria-busy');
    if (!this.month) this.month = monthKey(this.selected || this.firstAvailable() || av.today);
    // Если выбранная дата перестала существовать — сброс.
    if (this.selected && !this.byDate.has(this.selected)) this.selected = null;
    this.render();
  }

  setDessert(dessert) {
    this.dessert = dessert;
    let cleared = null;
    if (this.selected && this.dayState(this.selected).off) {
      cleared = this.selected;
      this.selected = null;
      this.onSelect(null, null);
    }
    if (this.av) {
      const first = this.firstAvailable();
      if (!this.selected && first) this.month = monthKey(first);
      this.render();
    }
    return cleared;
  }

  // ---------- Вычисления ----------
  minLead() {
    return this.dessert ? this.dessert.leadDays : this.defaultLead;
  }

  /** { status: free|few|full|off, reason, info } */
  dayState(ymd) {
    const info = this.byDate.get(ymd);
    if (!info) return { status: 'off', off: true, reason: 'вне окна приёма' };
    if (info.status === 'closed') return { status: 'off', off: true, reason: 'кондитерская не работает', info };
    if (this.av && diffDays(this.av.today, ymd) < this.minLead()) {
      return { status: 'off', off: true, reason: this.dessert ? `раньше срока: заказывать за ${daysWord(this.minLead())}` : `десерты заказывают минимум за ${daysWord(this.minLead())}`, info };
    }
    return { status: info.status, off: false, info };
  }

  /** Ближайшая дата с местами (не «нет») с учётом срока десерта. */
  firstAvailable() {
    if (!this.av) return null;
    for (const d of this.av.dates) {
      const st = this.dayState(d.date);
      if (!st.off && st.status !== 'full') return d.date;
    }
    return null;
  }

  statusText(ymd) {
    const st = this.dayState(ymd);
    const when = formatDateWeekday(ymd);
    if (st.status === 'free') return { text: `${when}: свободно`, tone: 'free' };
    if (st.status === 'few') return { text: `${when}: осталось мало мест`, tone: 'few' };
    if (st.status === 'full') return { text: `${when}: мест нет — заявка попадёт в лист ожидания`, tone: 'full' };
    return { text: `${when}: недоступно`, tone: 'off' };
  }

  isWaitlist() {
    return !!this.selected && this.dayState(this.selected).status === 'full';
  }

  // ---------- Отрисовка ----------
  monthRange() {
    const first = monthKey(this.av.today);
    const last = monthKey(this.av.dates[this.av.dates.length - 1].date);
    return { first, last };
  }

  render() {
    if (!this.av) return;
    const { first, last } = this.monthRange();
    if (this.month < first) this.month = first;
    if (this.month > last) this.month = last;
    const key = this.month;
    const { y, m } = ymdParts(firstOfMonth(key));
    const titleId = 'cal-title';

    const head = h('div', { class: 'cal__head' },
      h('p', { class: 'cal__month', id: titleId }, `${MONTHS_NOMINATIVE[m - 1]} ${y}`),
      h('div', { class: 'cal__nav' },
        h('button', { class: 'cal__btn', type: 'button', 'aria-label': 'Предыдущий месяц', disabled: key <= first, onclick: () => this.goMonth(-1) }, svgIcon(ICONS.prev, 18)),
        h('button', { class: 'cal__btn', type: 'button', 'aria-label': 'Следующий месяц', disabled: key >= last, onclick: () => this.goMonth(1) }, svgIcon(ICONS.next, 18))
      )
    );

    // Сетка месяца: строки по неделям, понедельник первым.
    const start = firstOfMonth(key);
    const lead = weekdayIndex(start);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(addDays(start, d - 1));
    while (cells.length % 7) cells.push(null);

    // Какая ячейка получает фокус Tab (roving tabindex).
    const inMonth = (ymd) => ymd && monthKey(ymd) === key;
    let tabTarget = [this.focusDate, this.selected, this.firstAvailable()].find((x) => inMonth(x));
    if (!tabTarget) tabTarget = cells.find((c) => c && !this.dayState(c).off) || cells.find(Boolean);

    const rows = [];
    for (let r = 0; r < cells.length; r += 7) {
      rows.push(h('tr', {}, cells.slice(r, r + 7).map((ymd) => h('td', {}, ymd ? this.dayButton(ymd, ymd === tabTarget) : h('span', { class: 'cal__empty' })))));
    }

    const table = h('table', { class: 'cal__table', role: 'grid', 'aria-labelledby': titleId },
      h('thead', {}, h('tr', {}, WEEKDAYS_SHORT.map((w) => h('th', { scope: 'col', abbr: w }, w)))),
      h('tbody', {}, rows)
    );

    const legend = h('p', { class: 'cal__legend', 'aria-hidden': 'true' },
      h('span', {}, h('b', { class: 'lg-free' }, 'есть'), ' свободно'),
      h('span', {}, h('b', { class: 'lg-few' }, 'мало'), ' мало мест'),
      h('span', {}, h('b', { class: 'lg-full' }, 'нет'), ' мест нет — лист ожидания'),
      h('span', {}, h('b', {}, '—'), ' недоступно')
    );

    this.hintEl = h('p', { class: 'cal__hint' }, this.hintText());
    this.statusEl = h('p', { class: 'cal__status', role: 'status', 'aria-live': 'polite' });
    this.root.replaceChildren(head, table, legend, this.hintEl, this.statusEl);
    this.updateStatus();
  }

  dayButton(ymd, tabbable) {
    const st = this.dayState(ymd);
    const { d } = ymdParts(ymd);
    const cls = ['day', `day--${st.off ? 'off' : st.status}`];
    if (this.av && ymd === this.av.today) cls.push('day--today');
    if (ymd === this.selected) cls.push('is-selected');
    const label = st.off ? `${formatDateLong(ymd)}: недоступно, ${st.reason}` : `${formatDateLong(ymd)}: ${({ free: 'свободно', few: 'мало мест', full: 'мест нет, можно встать в лист ожидания' })[st.status]}`;
    return h('button', {
      class: cls.join(' '), type: 'button', 'data-date': ymd, tabindex: tabbable ? '0' : '-1',
      'aria-label': label, 'aria-pressed': String(ymd === this.selected), 'aria-disabled': st.off ? 'true' : null,
      onclick: () => this.pick(ymd),
    },
    h('span', { class: 'day__num' }, d),
    h('span', { class: 'day__tag', 'aria-hidden': 'true' }, TAGS[st.off ? 'off' : st.status]),
    h('svg', { ns: 'svg', class: 'day__ring', viewBox: '0 0 100 60', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      h('path', { ns: 'svg', d: RING_PATH, pathLength: '1' })));
  }

  hintText() {
    if (!this.av) return '';
    if (!this.dessert) return 'Выберите десерт — покажем ближайшую дату, на которую его можно заказать.';
    const first = this.firstAvailable();
    if (!first) return `Свободных дат для «${this.dessert.name}» пока нет — выберите день с пометкой «нет», чтобы встать в лист ожидания.`;
    return `Ближайшая дата для этого десерта: ${formatDateLong(first).replace(/ \d{4}$/, '')} (заказывать за ${daysWord(this.dessert.leadDays)}).`;
  }

  updateStatus() {
    if (!this.statusEl) return;
    this.statusEl.className = 'cal__status';
    if (!this.selected) { this.statusEl.textContent = ''; return; }
    const s = this.statusText(this.selected);
    this.statusEl.classList.add(`cal__status--${s.tone}`);
    this.statusEl.textContent = s.text;
  }

  // ---------- Действия ----------
  pick(ymd) {
    const st = this.dayState(ymd);
    if (st.off) {
      this.statusEl.className = 'cal__status';
      this.statusEl.textContent = `${formatDateWeekday(ymd)}: недоступно — ${st.reason}.`;
      return;
    }
    const prev = this.root.querySelector('.day.is-selected');
    if (prev) { prev.classList.remove('is-selected'); prev.setAttribute('aria-pressed', 'false'); }
    this.selected = ymd;
    this.focusDate = ymd;
    const btn = this.root.querySelector(`[data-date="${ymd}"]`);
    if (btn) {
      // Даём браузеру отрисовать начальное состояние, чтобы обводка «нарисовалась».
      requestAnimationFrame(() => { btn.classList.add('is-selected'); btn.setAttribute('aria-pressed', 'true'); });
      this.root.querySelectorAll('.day[tabindex="0"]').forEach((b) => b.setAttribute('tabindex', '-1'));
      btn.setAttribute('tabindex', '0');
    }
    this.updateStatus();
    this.onSelect(ymd, st);
  }

  clear() {
    this.selected = null;
    this.focusDate = null;
    if (this.av) this.render();
  }

  goMonth(delta, focusDate) {
    const { first, last } = this.monthRange();
    const next = shiftMonth(this.month, delta);
    if (next < first || next > last) return false;
    this.month = next;
    if (focusDate) this.focusDate = focusDate;
    this.render();
    this.announceMonth();
    return true;
  }

  /** Постоянная (не перерисовываемая) живая область — скринридер объявит новый месяц. */
  announceMonth() {
    const live = document.getElementById('cal-live');
    const [y, m] = this.month.split('-').map(Number);
    if (live) live.textContent = `${MONTHS_NOMINATIVE[m - 1]} ${y}`;
  }

  onKey(e) {
    const btn = e.target.closest && e.target.closest('.day');
    if (!btn) return;
    const cur = btn.dataset.date;
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let target = null;
    if (moves[e.key] != null) target = addDays(cur, moves[e.key]);
    else if (e.key === 'Home') target = addDays(cur, -weekdayIndex(cur));
    else if (e.key === 'End') target = addDays(cur, 6 - weekdayIndex(cur));
    else if (e.key === 'PageUp' || e.key === 'PageDown') {
      const delta = e.key === 'PageUp' ? -1 : 1;
      const { y, m, d } = ymdParts(cur);
      const key = shiftMonth(`${y}-${String(m).padStart(2, '0')}`, delta);
      const [ny, nm] = key.split('-').map(Number);
      const dim = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
      target = `${key}-${String(Math.min(d, dim)).padStart(2, '0')}`;
    } else return;
    e.preventDefault();
    const { first, last } = this.monthRange();
    const tk = monthKey(target);
    if (tk < first || tk > last) return;
    this.focusDate = target;
    if (tk !== this.month) {
      this.month = tk;
      this.render();
      this.announceMonth();
    }
    const el = this.root.querySelector(`[data-date="${target}"]`);
    if (el) {
      this.root.querySelectorAll('.day[tabindex="0"]').forEach((b) => b.setAttribute('tabindex', '-1'));
      el.setAttribute('tabindex', '0');
      el.focus();
    }
  }
}
