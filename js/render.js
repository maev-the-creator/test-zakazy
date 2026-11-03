// Отрисовка секций витрины из config.js.
import { h, $, picture, svgIcon, ICONS } from './dom.js';
import { formatRub, daysWord, priceRangeText } from './logic.generated.js';

export function renderHero(config) {
  const lines = config.hero.titleLines && config.hero.titleLines.length ? config.hero.titleLines : [config.hero.title];
  const title = $('#hero-title');
  // Внутри строки — неразрывные пробелы: на телефоне перенос только между строками.
  const line = (l) => h('span', { class: 'hero__line' }, l.replace(/ /g, '\u00a0'));
  title.replaceChildren(...lines.flatMap((l, i) => (i ? [' ', line(l)] : [line(l)])));
}

/** Карточка десерта (витрина и превью в админке используют одну и ту же разметку). */
export function dishCard(d, { feature = false, index = 0, onPick = () => {} } = {}) {
  const nameId = `dish-${d.id}`;
  const sizes = feature ? '(min-width: 1024px) 40vw, (min-width: 640px) 100vw, 100vw' : '(min-width: 1024px) 30vw, (min-width: 640px) 50vw, 100vw';
  const li = h('li', { class: `dish reveal${feature ? ' dish--feature' : ''}`, style: { '--delay': `${Math.min(index, 5) * 60}ms` }, 'data-dessert': d.id },
    h('div', { class: 'dish__media' },
      d.image || d.imageSrc ? picture(d.image, d.alt, sizes, { ext: d.imageExt, src: d.imageSrc }) : h('div', { class: 'dish__noimg' }, 'Нет фото'),
      d.badge ? h('span', { class: 'badge' }, d.badge) : null,
      h('span', { class: 'dish__check', 'aria-hidden': 'true' }, svgIcon(ICONS.tick, 18))
    ),
    h('div', { class: 'dish__body' },
      h('h3', { class: 'dish__name', id: nameId }, d.name),
      d.description ? h('p', { class: 'dish__desc' }, d.description) : null,
      h('p', { class: 'dish__fillings' }, h('b', {}, 'Начинки: '), (d.fillings || []).join(', ')),
      h('div', { class: 'dish__foot' },
        h('p', { class: 'dish__price' },
          h('span', { class: 'price' }, priceRangeText(d)),
          d.unit ? h('span', { class: 'price__unit' }, d.unit) : null,
          h('span', { class: 'lead-time' }, `Заказывать за ${daysWord(Number(d.leadDays) || 0)}`)
        ),
        h('button', {
          class: 'btn btn--outline dish__pick', type: 'button', 'aria-pressed': 'false', 'aria-describedby': nameId,
          'data-pick': d.id, onclick: () => onPick(d.id),
        }, svgIcon(ICONS.tick, 18), h('span', { class: 'dish__pick-label' }, 'Выбрать'))
      )
    )
  );
  li.querySelector('.dish__pick svg').classList.add('tick');
  return li;
}

export function renderCatalog(config, onPick) {
  const grid = $('#catalog-grid');
  grid.replaceChildren(...config.desserts.map((d, i) => dishCard(d, { feature: i === 0, index: i, onPick })));
}

let catalogPaused = false;

export function markPicked(dessertId) {
  document.querySelectorAll('[data-pick]').forEach((btn) => {
    const on = btn.dataset.pick === dessertId && !catalogPaused;
    btn.setAttribute('aria-pressed', String(on));
    const card = btn.closest('.dish');
    if (card) card.classList.toggle('is-picked', on);
    if (catalogPaused) btn.setAttribute('aria-disabled', 'true');
    else btn.removeAttribute('aria-disabled');
    btn.querySelector('.dish__pick-label').textContent = catalogPaused ? 'Приём на паузе' : on ? 'Выбрано' : 'Выбрать';
  });
}

/** Приём остановлен: кнопки «Выбрать» неактивны, каталог остаётся виден. */
export function setCatalogPaused(paused, dessertId) {
  catalogPaused = paused;
  markPicked(dessertId);
}

export function renderFillings(config) {
  const list = $('#fillings-list');
  list.replaceChildren(...config.fillings.items.map((f, i) =>
    h('div', { class: 'menu__item reveal', style: { '--delay': `${i * 50}ms` } },
      h('dt', { class: 'menu__name' }, f.name),
      h('dd', { class: 'menu__desc' }, f.description)
    )
  ));
}

export function renderAbout(config) {
  $('#about-text').replaceChildren(...(config.about.text || []).map((t) => h('p', {}, t)));
  const stats = config.about.stats || [];
  const facts = $('#about-facts');
  facts.hidden = !stats.length;
  // Размер цифр в CSS считается от длины самой длинной из них (Unbounded широкий — иначе цифры налезают друг на друга).
  facts.style.setProperty('--fact-chars', String(Math.max(3, ...stats.map(factText).map((t) => t.length))));
  facts.replaceChildren(...stats.map((s) =>
    h('li', { class: 'fact' },
      h('p', { class: 'fact__value' },
        s.prefix || '',
        h('span', { 'data-count': s.value, 'data-decimals': s.decimals || 0, 'data-format': s.format || '' }, formatStat(s.value, s)),
        s.suffix || ''
      ),
      h('p', { class: 'fact__label' }, s.label)
    )
  ));
}

/** Итоговый текст цифры: «с 2019», «1 200+», «5,0». */
export const factText = (s) => `${s.prefix || ''}${formatStat(s.value, s)}${s.suffix || ''}`;

export function formatStat(v, s) {
  if (s.format === 'year') return String(Math.round(v));
  if (s.decimals) return v.toFixed(s.decimals).replace('.', ',');
  return formatRub(v);
}
