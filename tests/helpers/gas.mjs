// Загрузка apps-script/Code.gs в Node с заглушками сервисов Google.
// Заглушки минимальные: таблица в памяти (значения, без вычисления формул),
// блокировка, свойства скрипта, UrlFetchApp/DriveApp с записью вызовов.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CODE_PATH = path.join(ROOT, 'apps-script', 'Code.gs');

// Любой неизвестный метод — «ничего не делать и вернуть себя» (для цепочек форматирования).
function chainable(target) {
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === 'symbol') return undefined;
      return () => proxy;
    },
  });
  return proxy;
}

function builder() {
  const b = chainable({ build: () => ({ built: true }) });
  return b;
}

// Как в Google Таблицах: ведущий апостроф — признак «это текст», при чтении его нет.
// В sheet.data значение хранится как записано (тесты проверяют, что защита sheetSafe применена).
const unquote = (v) => (typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v);

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.data = []; // массив строк
    this.calls = [];
  }
  cell(r, c) {
    return (this.data[r - 1] || [])[c - 1];
  }
  setCell(r, c, v) {
    while (this.data.length < r) this.data.push([]);
    const row = this.data[r - 1];
    while (row.length < c) row.push('');
    row[c - 1] = v;
  }
  getName() { return this.name; }
  getLastRow() {
    for (let i = this.data.length - 1; i >= 0; i--) {
      if ((this.data[i] || []).some((v) => v !== '' && v != null)) return i + 1;
    }
    return 0;
  }
  getLastColumn() { return Math.max(0, ...this.data.map((r) => r.length)); }
  getRange(r, c, nr = 1, nc = 1) {
    if (typeof r === 'string') return chainable({ a1: r });
    const sheet = this;
    return chainable({
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = [];
          for (let j = 0; j < nc; j++) {
            const v = sheet.cell(r + i, c + j);
            row.push(v === undefined ? '' : unquote(v));
          }
          out.push(row);
        }
        return out;
      },
      getValue() { const v = sheet.cell(r, c); return v === undefined ? '' : unquote(v); },
      setValues(values) {
        if (values.length !== nr || values.some((row) => row.length !== nc)) {
          throw new Error(`setValues: размер ${values.length}x${values[0] && values[0].length} не совпадает с диапазоном ${nr}x${nc}`);
        }
        values.forEach((row, i) => row.forEach((v, j) => sheet.setCell(r + i, c + j, v)));
        return this;
      },
      setValue(v) { sheet.setCell(r, c, v); return this; },
    });
  }
  deleteRow(r) {
    this.data.splice(r - 1, 1);
    return this;
  }
  appendRow(row) {
    const r = this.getLastRow() + 1;
    row.forEach((v, j) => this.setCell(r, j + 1, v));
    return this;
  }
}

class FakeSpreadsheet {
  constructor() {
    this.sheets = [];
    this.named = {};
    this.timeZone = 'Etc/GMT';
  }
  getId() { return 'fake-spreadsheet-id'; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  getSheets() { return this.sheets.slice(); }
  insertSheet(name, index) {
    const s = chainable(new FakeSheet(name));
    if (index == null || index > this.sheets.length) this.sheets.push(s);
    else this.sheets.splice(index, 0, s);
    return s;
  }
  deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
  setSpreadsheetTimeZone(tz) { this.timeZone = tz; }
  getNamedRanges() {
    return Object.keys(this.named).map((name) => ({ getName: () => name, setRange: (r) => { this.named[name] = r; } }));
  }
  setNamedRange(name, r) { this.named[name] = r; }
  setActiveSheet() {}
  toast() {}
}

function formatDate(date, tz, fmt) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  return fmt
    .replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', parts.hour).replace('mm', parts.minute);
}

/**
 * Создаёт окружение и загружает Code.gs.
 * opts.nowMs — «текущее время», opts.telegram — функция (url, options) → { code, body } или throw.
 */
export function loadGas(opts = {}) {
  const ss = opts.spreadsheet || new FakeSpreadsheet();
  // Свойства конкретной кондитерской (без них setup() отказывает). noClientProps: true — проверить отказ.
  const props = { ...(opts.noClientProps ? {} : { SITE_URL: 'https://test-bakery.example', GITHUB_REPO: 'owner/test-zakazy' }), ...(opts.props || {}) };
  const fetchCalls = [];
  const drive = { folders: [], files: [] };
  let lockHeld = false;
  const logs = [];

  const cache = new Map();
  const github = fakeGithub(opts.githubFails, opts.repoCatalog);
  const env = {
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => { cache.set(k, String(v)); },
        remove: (k) => { cache.delete(k); },
      }),
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      openById: () => ss,
      flush: () => {},
      newDataValidation: builder,
      newConditionalFormatRule: builder,
      getUi: () => chainable({}),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => { if (lockHeld) return false; lockHeld = true; return true; },
        waitLock: () => { lockHeld = true; },
        releaseLock: () => { lockHeld = false; },
        hasLock: () => lockHeld,
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        getProperties: () => ({ ...props }),
        deleteProperty: (k) => { delete props[k]; },
      }),
    },
    UrlFetchApp: {
      fetch: (url, options = {}) => {
        fetchCalls.push({ url, options, locked: lockHeld }); // locked: шёл ли запрос под общим замком
        let r;
        if (url.includes('/data/catalog.json') && !url.startsWith('https://api.github.com/')) {
          r = opts.siteCatalog === null ? { code: 404, body: 'not found' } : { code: 200, body: JSON.stringify(opts.siteCatalog || JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'catalog.json'), 'utf8'))) };
        } else if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
          if (url.includes('id_token=')) throw new Error('ID-токен не должен передаваться в адресе');
          r = opts.google ? opts.google(options.payload.id_token) : { code: 400, body: '{"error":"invalid_token"}' };
        } else if (url.startsWith('https://api.github.com/')) {
          r = github.handle(url, options);
        } else {
          r = opts.telegram ? opts.telegram(url, options) : { code: 200, body: '{"ok":true}' };
        }
        return { getResponseCode: () => r.code, getContentText: () => r.body };
      },
    },
    Session: {
      getEffectiveUser: () => ({ getEmail: () => opts.ownerEmail || 'owner@gmail.com' }),
    },
    DriveApp: {
      getFileById: (id) => {
        const f = drive.files.find((x) => x.id === id);
        if (!f) throw new Error('no file ' + id);
        return { getBlob: () => ({ getBytes: () => f.blob.bytes }), setTrashed: (v) => { f.trashed = v; } };
      },
      getFolderById: (id) => {
        const f = drive.folders.find((x) => x.id === id);
        if (!f) throw new Error('no folder');
        return f.api;
      },
      getFoldersByName: (name) => {
        const list = drive.folders.filter((x) => x.name === name);
        let i = 0;
        return { hasNext: () => i < list.length, next: () => list[i++].api };
      },
      createFolder: (name) => {
        if (opts.driveFails) throw new Error('Drive недоступен');
        const f = { id: 'folder-' + (drive.folders.length + 1), name };
        f.api = {
          getId: () => f.id,
          createFile: (blob) => {
            const file = { id: 'file-' + (drive.files.length + 1), blob };
            drive.files.push(file);
            return chainable({ getUrl: () => 'https://drive.google.com/file/d/' + file.id, getId: () => file.id });
          },
        };
        drive.folders.push(f);
        return f.api;
      },
    },
    Utilities: {
      formatDate,
      base64Decode: (s) => Array.from(Buffer.from(s, 'base64')),
      base64Encode: (bytes) => Buffer.from(bytes.map((b) => b & 0xff)).toString('base64'),
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      // Как в Apps Script: массив знаковых байтов (-128…127).
      computeDigest: (alg, text) => Array.from(crypto.createHash(alg).update(String(text), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
      getUuid: () => crypto.randomUUID(),
      newBlob: (bytes, type, name) => ({ bytes, type, name, getName: () => name, getDataAsString: () => Buffer.from(bytes.map((b) => b & 0xff)).toString('utf8') }),
      sleep: () => {},
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (s) => {
        const out = { content: s, mime: null, getContent: () => s };
        out.setMimeType = (m) => { out.mime = m; return out; };
        return out;
      },
    },
    console: {
      log: (...a) => logs.push(['log', ...a]),
      warn: (...a) => logs.push(['warn', ...a]),
      error: (...a) => logs.push(['error', ...a]),
    },
    Buffer,
  };

  const context = vm.createContext(env);
  vm.runInContext(fs.readFileSync(CODE_PATH, 'utf8'), context, { filename: 'Code.gs' });
  if (opts.nowMs != null) setNow(context, opts.nowMs);

  return {
    ctx: context,
    ss,
    props,
    github,
    cache,
    fetchCalls,
    drive,
    logs,
    get: (expr) => vm.runInContext(expr, context),
    setNow: (ms) => setNow(context, ms),
  };
}

function setNow(context, ms) {
  context.__now = ms;
  vm.runInContext('nowMs_ = function () { return __now; };', context);
}

/** Поддельный GitHub Git Data API: хранит блобы, деревья, коммиты и ветку main. */
function fakeGithub(fails, repoCatalog) {
  const state = { blobs: {}, trees: {}, commits: { c0: { tree: { sha: 't0' } } }, ref: 'c0', calls: [], n: 0 };
  const id = (p) => p + ++state.n;
  state.handle = (url, options) => {
    const method = (options.method || 'get').toLowerCase();
    const p = url.replace(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+/, '');
    const body = options.payload ? JSON.parse(options.payload) : null;
    state.calls.push({ method, path: p, body, auth: (options.headers || {}).Authorization });
    if (fails) return { code: 401, body: '{"message":"Bad credentials"}' };
    if (method === 'get' && p.startsWith('/contents/data/catalog.json')) {
      // Что сейчас в main: последний коммит, иначе начальный каталог репозитория (если задан).
      const committed = state.ref !== 'c0' && state.lastFiles()['data/catalog.json'];
      const text = committed ? committed.content : repoCatalog ? JSON.stringify(repoCatalog) : null;
      if (!text) return { code: 404, body: '{"message":"Not Found"}' };
      return { code: 200, body: JSON.stringify({ content: Buffer.from(text, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n') }) };
    }
    if (method === 'get' && p.startsWith('/git/ref/heads/')) return { code: 200, body: JSON.stringify({ object: { sha: state.ref } }) };
    if (method === 'get' && p.startsWith('/git/commits/')) return { code: 200, body: JSON.stringify(state.commits[p.split('/').pop()]) };
    if (method === 'post' && p === '/git/blobs') { const sha = id('b'); state.blobs[sha] = body; return { code: 201, body: JSON.stringify({ sha }) }; }
    if (method === 'post' && p === '/git/trees') { const sha = id('t'); state.trees[sha] = body; return { code: 201, body: JSON.stringify({ sha }) }; }
    if (method === 'post' && p === '/git/commits') { const sha = id('c'); state.commits[sha] = { tree: { sha: body.tree }, message: body.message, parents: body.parents }; return { code: 201, body: JSON.stringify({ sha }) }; }
    if (method === 'patch' && p.startsWith('/git/refs/heads/')) { state.ref = body.sha; return { code: 200, body: '{}' }; }
    return { code: 404, body: '{"message":"Not Found"}' };
  };
  /** Файлы последнего коммита: путь → содержимое (строка или base64). */
  state.lastFiles = () => {
    const tree = state.trees[state.commits[state.ref].tree.sha];
    const out = {};
    (tree ? tree.tree : []).forEach((e) => { out[e.path] = state.blobs[e.sha]; });
    return out;
  };
  return state;
}

/** Ответ doGet/doPost → объект. */
export function parseOut(out) {
  return JSON.parse(out.getContent());
}

/** Момент времени: московская дата и время → миллисекунды UTC. */
export function msk(ymd, hh = 12, mm = 0) {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh - 3, mm);
}
