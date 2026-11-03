// Точка входа сайта. Настройки — config.js, ассортимент и тексты — data/catalog.js (публикуется из админки).
import { CONFIG } from '../config.js';
import { bindConfig, $ } from './dom.js';
import { renderHero, renderCatalog, renderFillings, renderAbout } from './render.js';
import { createApi, loadCatalog } from './api.js';
import { visibleDesserts } from './logic.generated.js';
import { initOrderForm } from './form.js';
import { playHero, initReveals, initCounters } from './motion.js';

// Витрина = настройки (config.js) + опубликованный каталог (data/catalog.js, меняется из админки).
const catalog = loadCatalog(CONFIG);
const SITE = { ...CONFIG, ...catalog, desserts: visibleDesserts(catalog) };

document.title = `${CONFIG.bakery.name} — ${CONFIG.bakery.tagline}`;

bindConfig(SITE);
renderHero(SITE);
playHero();

let form = null;
renderCatalog(SITE, (id) => form && form.pickFromCatalog(id));
renderFillings(SITE);
renderAbout(SITE);

const api = createApi(CONFIG);
if (api.mode === 'demo') {
  $('#demo-badge').hidden = false;
  document.documentElement.dataset.mode = 'demo';
}
form = initOrderForm({ config: SITE, api });

initReveals();
initCounters(SITE.about.stats);
