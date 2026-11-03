// Движение: загрузка первого экрана, появление при прокрутке, счётчики.
// Всё видно и без JS; при prefers-reduced-motion — без сдвигов и счёта.
import { prefersReducedMotion } from './dom.js';
import { formatStat } from './render.js';

/** Один оркестрованный момент — первый экран. Ждём фото и шрифты, но не дольше 450 мс. */
export function playHero() {
  const img = document.querySelector('.hero__media img');
  const ready = img && img.decode ? img.decode().catch(() => {}) : Promise.resolve();
  const fonts = document.fonts ? document.fonts.ready.catch(() => {}) : Promise.resolve();
  const timeout = new Promise((r) => setTimeout(r, 450));
  Promise.race([Promise.all([ready, fonts]), timeout]).then(() => {
    requestAnimationFrame(() => document.documentElement.classList.add('is-loaded'));
  });
}

export function initReveals() {
  const els = document.querySelectorAll('.reveal:not(.is-in)');
  if (!('IntersectionObserver' in window)) {
    els.forEach((el) => el.classList.add('is-in'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add('is-in');
      io.unobserve(e.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  els.forEach((el) => io.observe(el));
}

/** Факты о кондитерской досчитывают один раз, когда видны. */
export function initCounters(stats) {
  const nodes = Array.from(document.querySelectorAll('[data-count]'));
  if (!nodes.length || prefersReducedMotion() || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      io.unobserve(e.target);
      count(e.target, stats[nodes.indexOf(e.target)]);
    });
  }, { threshold: 0.6 });
  nodes.forEach((n, i) => {
    n.textContent = formatStat(startValue(Number(n.dataset.count), stats[i]), stats[i]);
    io.observe(n);
  });
}

// Год считаем от «десятилетия назад», остальные — от нуля.
const startValue = (to, stat) => (stat.format === 'year' ? to - 12 : 0);

function count(el, stat) {
  const to = Number(el.dataset.count);
  const from = startValue(to, stat);
  const dur = 1200;
  const t0 = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 4);
  const tick = (now) => {
    const t = Math.min(1, (now - t0) / dur);
    const v = from + (to - from) * ease(t);
    el.textContent = formatStat(t < 1 ? (stat.decimals ? v : Math.round(v)) : to, stat);
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
