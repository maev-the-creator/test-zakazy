// Маленькие помощники для DOM. Весь текст вставляется через textContent — без innerHTML.

/** h('p', { class: 'x', onclick: fn }, 'текст', h('b', {}, 'жирный')) */
export function h(tag, attrs, ...children) {
  const el = attrs && attrs.ns === 'svg' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false || k === 'ns') continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') Object.entries(v).forEach(([p, val]) => el.style.setProperty(p, val));
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Заполняет элементы с data-bind / data-href / data-alt / data-list значениями из конфига. */
export function bindConfig(config, root = document) {
  $$('[data-bind]', root).forEach((el) => {
    const v = getPath(config, el.dataset.bind);
    if (v != null && v !== '') el.textContent = String(v);
  });
  $$('[data-href]', root).forEach((el) => {
    const v = getPath(config, el.dataset.href);
    if (v) el.setAttribute('href', v);
  });
  $$('[data-alt]', root).forEach((el) => {
    const v = getPath(config, el.dataset.alt);
    if (v) el.setAttribute('alt', v);
  });
  $$('[data-list]', root).forEach((el) => {
    const list = getPath(config, el.dataset.list) || [];
    el.replaceChildren(...list.map((item) => h('li', {}, item)));
  });
}

/** Картинка карточки: base — путь без размера (images/web/bento → bento-480.webp, bento-900.webp). */
export function picture(base, alt, sizes, { eager = false, width = 900, height = 675, ext = 'webp', src = '' } = {}) {
  // src — готовая картинка (превью в админке, демо-публикация); иначе файлы base-480/900.ext.
  if (src) return h('picture', {}, h('img', { src, width, height, alt: alt || '', decoding: 'async' }));
  const type = ext === 'jpg' ? 'image/jpeg' : 'image/webp';
  return h('picture', {},
    h('source', { type, srcset: `${base}-480.${ext} 480w, ${base}-900.${ext} 900w`, sizes }),
    h('img', {
      src: `${base}-900.${ext}`, width, height, alt: alt || '',
      loading: eager ? null : 'lazy', decoding: 'async',
    })
  );
}

export function svgIcon(paths, size = 18) {
  const svg = h('svg', { ns: 'svg', viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true' });
  paths.forEach((d) => svg.append(h('path', { ns: 'svg', d, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })));
  return svg;
}

export const ICONS = {
  tick: ['m5 12.5 4.5 4.5L19 7.5'],
  prev: ['m14.5 6-6 6 6 6'],
  next: ['m9.5 6 6 6-6 6'],
};

export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function scrollToEl(el, { block = 'start', offset = 16 } = {}) {
  const top = el.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top: block === 'start' ? top : top - window.innerHeight / 3, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}
