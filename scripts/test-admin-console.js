// Run after npm run build. CONTRACT-010 admin console: serving, static checks,
// and console script behavior in a VM with DOM, fetch and storage stand-ins.
// Uses an isolated temporary PGlite database; never loads .env or binds a socket.
const assert = require('node:assert/strict');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Readable } = require('node:stream');
const { generateKeyPairSync, randomUUID } = require('node:crypto');
const vm = require('node:vm');
const { loadConfig } = require('../dist/config.js');
const { openDatabase } = require('../dist/database.js');
const { createLocalUserStore } = require('../dist/localUsers.js');
const { createSecretsStore } = require('../dist/secrets.js');
const { createRequestHandler } = require('../dist/index.js');
const { createOpenApiDocument } = require('../dist/openapi.js');
const { hashPassword } = require('../dist/password.js');

const ADMIN = 'admin-console-test-' + 'c'.repeat(32);
const EMERGENCY = 'emergency-console-test-' + 'b'.repeat(32);
const environment = {
  PORT: '3210', PGLITE_DATA_DIR: 'unused', DB_ENCRYPTION_KEY: 'a'.repeat(64),
  COOKIE_SECURE: 'false', SERVICE_ISSUER: 'http://localhost:3210',
  EMERGENCY_ROTATION_TOKEN: EMERGENCY, LOCAL_USER_ADMIN_TOKEN: ADMIN, LOCAL_LOGIN: 'true',
  TENANT_ID: 'tenant', CLIENT_ID: 'client',
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const KEYS = { admin: 'btConsole.userAdminToken', emergency: 'btConsole.emergencyToken', actingAs: 'btConsole.actingAs' };
const MARKUP = '<img src=x onerror=alert(1)>';

async function request(handler, url, method = 'GET', body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [body]);
  Object.assign(req, { method, url, headers, socket: { remoteAddress: '127.0.0.1' } });
  const result = {};
  await handler(req, {
    writeHead(status, h) { Object.assign(result, { status, headers: h }); },
    end(b) { result.body = b === undefined ? undefined : String(b); },
  });
  return result;
}

// ---------------------------------------------------------------- mini DOM
const VOID = new Set(['meta', 'link', 'input', 'br', 'hr', 'img']);
const decode = s => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
const makeEvent = (type, props = {}) => ({ type, defaultPrevented: false, cancelBubble: false,
  preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.cancelBubble = true; }, ...props });
class FakeNode {
  constructor(doc) { this.ownerDocument = doc; this.childNodes = []; this.parentNode = null; this.listeners = new Map(); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
  set textContent(v) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; const t = String(v ?? ''); if (t) this.appendChild(new FakeText(this.ownerDocument, t)); }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  removeChild(c) { const i = this.childNodes.indexOf(c); assert.ok(i >= 0); this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  addEventListener(t, fn) { if (!this.listeners.has(t)) this.listeners.set(t, []); this.listeners.get(t).push(fn); }
  removeEventListener(t, fn) { this.listeners.set(t, (this.listeners.get(t) ?? []).filter(f => f !== fn)); }
  dispatchEvent(ev) {
    ev.target ??= this;
    for (let n = this; n; n = n.parentNode) { ev.currentTarget = n; for (const fn of [...(n.listeners.get(ev.type) ?? [])]) fn.call(n, ev); if (ev.cancelBubble) break; }
    return !ev.defaultPrevented;
  }
  *descendants() { for (const c of this.childNodes) if (c instanceof FakeElement) { yield c; yield* c.descendants(); } }
  querySelectorAll(sel) { const tests = compile(sel); return [...this.descendants()].filter(e => tests.some(t => t(e))); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}
class FakeText extends FakeNode {
  constructor(doc, data) { super(doc); this.data = data; }
  get textContent() { return this.data; } set textContent(v) { this.data = String(v); }
}
class FakeElement extends FakeNode {
  constructor(doc, tag) { super(doc); this.tagName = tag.toUpperCase(); this.attrs = new Map(); this._value = ''; }
  getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
  setAttribute(n, v) { assert.ok(!/^on|^style$/i.test(n), `forbidden attribute ${n}`); this.attrs.set(n, String(v)); }
  removeAttribute(n) { this.attrs.delete(n); }
  hasAttribute(n) { return this.attrs.has(n); }
  get id() { return this.getAttribute('id') ?? ''; }
  get hidden() { return this.hasAttribute('hidden'); } set hidden(v) { v ? this.attrs.set('hidden', '') : this.attrs.delete('hidden'); }
  get disabled() { return this.hasAttribute('disabled'); } set disabled(v) { v ? this.attrs.set('disabled', '') : this.attrs.delete('disabled'); }
  get open() { return this.hasAttribute('open'); }
  get value() { return this._value; }
  set value(v) {
    v = String(v);
    if (this.tagName === 'SELECT' && !this.querySelectorAll('option').some(o => o.getAttribute('value') === v)) v = '';
    this._value = v;
  }
  get classList() {
    const get = () => (this.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    const set = list => this.attrs.set('class', list.join(' '));
    return {
      add: (...c) => set([...new Set([...get(), ...c])]), remove: (...c) => set(get().filter(x => !c.includes(x))),
      contains: c => get().includes(c),
      toggle: (c, force) => { const want = force === undefined ? !get().includes(c) : Boolean(force); want ? set([...new Set([...get(), c])]) : set(get().filter(x => x !== c)); return want; },
    };
  }
  matches(sel) { return compile(sel).some(t => t(this)); }
  closest(sel) { for (let n = this; n instanceof FakeElement; n = n.parentNode) if (n.matches(sel)) return n; return null; }
  focus() { if (!this.disabled) this.ownerDocument.activeElement = this; }
  click() {
    if (this.disabled) return;
    const ev = makeEvent('click'); this.dispatchEvent(ev);
    if (!ev.defaultPrevented && this.tagName === 'BUTTON' && (this.getAttribute('type') ?? 'submit') === 'submit') this.closest('form')?.dispatchEvent(makeEvent('submit'));
  }
  showModal() { assert.equal(this.open, false, 'dialog already open'); this.attrs.set('open', ''); }
  close() { this.attrs.delete('open'); this.dispatchEvent(makeEvent('close')); }
}
// Any HTML-parsing or inline-style API use fails the test immediately.
for (const name of ['innerHTML', 'outerHTML', 'style']) Object.defineProperty(FakeElement.prototype, name, { get() { throw Error(`${name} used`); }, set() { throw Error(`${name} used`); } });
FakeElement.prototype.insertAdjacentHTML = () => { throw Error('insertAdjacentHTML used'); };
function compile(sel) {
  return sel.split(',').map(part => {
    const m = part.trim().match(/^([a-z]*)((?:[#.][\w-]+|\[[^\]]+\])*)$/i);
    assert.ok(m, `unsupported selector ${part}`);
    const tag = m[1].toUpperCase();
    const tests = [...m[2].matchAll(/([#.])([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g)];
    return el => (!tag || el.tagName === tag) && tests.every(t => t[1] === '#' ? el.id === t[2] : t[1] === '.' ? el.classList.contains(t[2]) : t[4] !== undefined ? el.getAttribute(t[3]) === t[4] : el.hasAttribute(t[3]));
  });
}
class FakeDocument extends FakeNode {
  constructor() { super(null); this.ownerDocument = this; this.readyState = 'complete'; this.activeElement = null; }
  createElement(t) { return new FakeElement(this, t); }
  createTextNode(d) { return new FakeText(this, d); }
  getElementById(id) { for (const e of this.descendants()) if (e.id === id) return e; return null; }
  get documentElement() { return this.querySelector('html'); }
  get body() { return this.querySelector('body'); }
  get title() { return this.querySelector('title').textContent; }
  write() { throw Error('document.write used'); }
}
function parse(html) {
  const doc = new FakeDocument(); const stack = [doc];
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-z0-9]+)\s*>|<([a-z0-9]+)((?:\s+[^\s=>/]+(?:\s*=\s*"[^"]*")?)*)\s*>|([^<]+)/gi;
  for (const m of html.matchAll(re)) {
    const top = stack.at(-1);
    if (m[1]) { assert.equal(top.tagName, m[1].toUpperCase(), 'well-formed HTML'); stack.pop(); }
    else if (m[2]) {
      const el = doc.createElement(m[2]);
      for (const a of m[3].matchAll(/([^\s=]+)(?:\s*=\s*"([^"]*)")?/g)) el.attrs.set(a[1], decode(a[2] ?? ''));
      top.appendChild(el);
      if (!VOID.has(el.tagName.toLowerCase())) stack.push(el);
    } else if (m[4]) top.appendChild(doc.createTextNode(decode(m[4])));
  }
  assert.equal(stack.length, 1, 'all elements closed');
  for (const e of doc.descendants()) {
    if (e.tagName === 'INPUT') e._value = e.getAttribute('value') ?? '';
    if (e.tagName === 'SELECT') e._value = e.querySelector('option').getAttribute('value');
  }
  doc.activeElement = doc.body;
  return doc;
}
class FakeStorage {
  constructor(entries = {}) { this.map = new Map(Object.entries(entries)); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

// ---------------------------------------------------------------- harness
let assets;
async function boot({ responder, session = new FakeStorage(), local = new FakeStorage(), clipboard }) {
  const document = parse(assets.html);
  const env = { document, calls: [], inflight: new Set(), session, local, logs: [], clipboardWrites: [] };
  const context = {
    document, console: Object.fromEntries(['log', 'error', 'warn', 'info', 'debug'].map(k => [k, (...a) => env.logs.push(a.join(' '))])),
    navigator: { clipboard: clipboard === null ? undefined : { writeText: async text => { env.clipboardWrites.push(text); } } },
    fetch(url, init = {}) {
      const call = { url, method: init.method ?? 'GET', headers: { ...(init.headers ?? {}) }, body: init.body };
      env.calls.push(call);
      const p = Promise.resolve().then(() => responder(call));
      env.inflight.add(p); p.finally(() => env.inflight.delete(p)).catch(() => {});
      return p;
    },
  };
  context.window = context;
  for (const [name, store] of [['sessionStorage', session], ['localStorage', local]]) {
    Object.defineProperty(context, name, { get() { if (store === 'throw') throw Error('SecurityError'); return store; } });
  }
  vm.createContext(context);
  vm.runInContext(assets.theme, context);
  vm.runInContext(assets.app, context);
  env.$ = id => { const e = document.getElementById(id); assert.ok(e, `element #${id}`); return e; };
  env.type = (id, v) => { const e = env.$(id); e.value = v; e.dispatchEvent(makeEvent('input')); };
  env.click = id => env.$(id).click();
  env.submit = id => env.$(id).dispatchEvent(makeEvent('submit'));
  env.key = (key, shiftKey = false) => document.activeElement.dispatchEvent(makeEvent('keydown', { key, shiftKey }));
  env.tab = name => document.querySelector(`[data-section="${name}"]`).click();
  env.since = start => env.calls.slice(start);
  await settle(env);
  return env;
}
async function settle(env) {
  for (let round = 0; round < 50; round++) {
    for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
    if (env.inflight.size === 0) return;
    await Promise.allSettled([...env.inflight]);
  }
  throw Error('requests did not settle');
}
const reply = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const notJson = status => ({ ok: status >= 200 && status < 300, status, json: async () => { throw SyntaxError('Unexpected token <'); } });
function viaHandler(handler) {
  return async call => {
    const headers = Object.fromEntries(Object.entries(call.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const res = await request(handler, call.url, call.method, call.body, headers);
    return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => JSON.parse(res.body) };
  };
}
function expectedToken(method, url) {
  if (method === 'POST' && url === '/admin/emergency-rotate-keys') return EMERGENCY;
  if (url === '/admin/users') return method === 'POST' ? null : ADMIN;
  if (url.startsWith('/admin/users/')) return ADMIN;
  return null;
}
// Each token goes only to its own endpoints, and nowhere else in the page.
function checkIsolation(env, { wrongTokens = [] } = {}) {
  for (const call of env.calls) {
    const expected = expectedToken(call.method, call.url);
    const auth = call.headers.Authorization;
    if (expected === null) assert.equal(auth, undefined, `${call.method} ${call.url} must carry no token`);
    else assert.ok(auth === `Bearer ${expected}` || wrongTokens.some(t => auth === `Bearer ${t}`), `${call.method} ${call.url} token`);
    const serialized = JSON.stringify({ ...call, headers: { ...call.headers, Authorization: undefined } });
    for (const t of [ADMIN, EMERGENCY, ...wrongTokens]) assert.equal(serialized.includes(t), false, 'token outside Authorization');
    if (expected === ADMIN) assert.equal(JSON.stringify(call).includes(EMERGENCY), false);
    if (expected === EMERGENCY) assert.equal(JSON.stringify(call).includes(ADMIN), false);
  }
  const visible = [];
  for (const e of env.document.descendants()) { visible.push(...e.attrs.values()); }
  visible.push(env.document.textContent, env.document.title, ...env.logs);
  if (env.local !== 'throw') visible.push(...env.local.map.values(), ...env.local.map.keys());
  for (const t of [ADMIN, EMERGENCY, ...wrongTokens]) for (const v of visible) assert.equal(String(v).includes(t), false, 'token leaked into page, log or localStorage');
  assert.equal(env.document.querySelectorAll('img').length, 0, 'no markup from data was parsed');
}
const body = call => call.body === undefined ? undefined : JSON.parse(call.body);

// ---------------------------------------------------------------- tests
async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'bt-admin-console-'));
  let handle;
  try {
    const dist = join(__dirname, '..', 'dist', 'console');
    assets = Object.fromEntries(await Promise.all([['html', 'index.html'], ['app', 'app.js'], ['theme', 'theme.js'], ['css', 'app.css']]
      .map(async ([k, f]) => [k, await readFile(join(dist, f), 'utf8')])));

    // Serving and headers, in both login modes and both registration settings.
    const unavailable = new Proxy({}, { get() { throw new Error('Console accessed a store'); } });
    for (const local of [true, false]) for (const registration of [true, false]) {
      const handler = createRequestHandler(unavailable, loadConfig({ ...environment, LOCAL_LOGIN: String(local), ALLOW_NEW_LOCAL_LOGIN_CREATION: String(registration) }), unavailable);
      const generic = await request(handler, '/no-such-route');
      assert.equal(generic.status, 404);
      const served = {
        '/admin/console': ['text/html; charset=utf-8', assets.html], '/admin/console/': ['text/html; charset=utf-8', assets.html],
        '/admin/console?x=1': ['text/html; charset=utf-8', assets.html],
        '/admin/console/app.js': ['application/javascript; charset=utf-8', assets.app], '/admin/console/theme.js': ['application/javascript; charset=utf-8', assets.theme],
        '/admin/console/app.css': ['text/css; charset=utf-8', assets.css],
      };
      for (const [path, [type, content]] of Object.entries(served)) {
        for (const method of ['GET', 'HEAD']) {
          const r = await request(handler, path, method);
          assert.equal(r.status, 200, path);
          assert.deepEqual(r.headers, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP });
          assert.equal(r.body, method === 'HEAD' ? undefined : content);
        }
      }
      const referenced = [...assets.html.matchAll(/(?:src|href)="(\/admin\/console\/[^"]+)"/g)].map(m => m[1]);
      assert.deepEqual(referenced.sort(), ['/admin/console/app.css', '/admin/console/app.js', '/admin/console/theme.js']);
      for (const path of ['/admin/console/../package.json', '/admin/console/%2e%2e/package.json', '/admin/console/%2E%2E%2Fpackage.json',
        '/admin/console/..%2f..%2fpackage.json', '/admin/console/..\\package.json', '/admin/console/\\..\\index.js', '/admin/console/./app.js',
        '/admin/console/app.js/', '/admin/console/APP.JS', '/admin/console/index.html', '/admin/console/unknown.js', '/admin/console//app.js',
        '/admin/console/%61pp.js', '/admin/consolex', '/admin/console/console/app.js']) {
        const r = await request(handler, path);
        assert.equal(r.status, 404, path); assert.deepEqual(r, generic, path);
      }
      for (const method of ['POST', 'PUT', 'DELETE']) assert.deepEqual(await request(handler, '/admin/console', method), generic);
    }
    console.log('PASS: console page and allow-listed assets in both modes with exact headers; unknown/traversal paths give the generic 404');

    // Static checks on the served files.
    assert.doesNotMatch(assets.html, /<script(?![^>]*\ssrc=)[^>]*>/i);
    assert.doesNotMatch(assets.html, /<script[^>]*>[^<]+<\/script>/i);
    assert.doesNotMatch(assets.html, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(assets.html, /\sstyle\s*=|<style|javascript:/i);
    for (const [name, text] of Object.entries(assets)) assert.doesNotMatch(text, /https?:\/\/|\/\/cdn|@import|@font-face|url\(/i, `${name} external reference`);
    for (const script of [assets.app, assets.theme]) {
      assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function|\bFunction\s*\(|setTimeout|setInterval|\.style\b|setAttribute\(\s*["'](style|on)|\.on[a-z]+\s*=|document\.cookie|\blocation\b|console\./);
    }
    assert.doesNotMatch(assets.app, /localStorage/, 'tokens are never written to localStorage');
    assert.match(assets.html, /href="\/admin\/reset-password"/);
    const store = { listUsers: async () => [] };
    for (const local of [true, false]) {
      const handler = createRequestHandler(unavailable, loadConfig({ ...environment, LOCAL_LOGIN: String(local), ALLOW_NEW_LOCAL_LOGIN_CREATION: 'true' }), store);
      assert.match((await request(handler, '/admin/reset-password')).body, /href="\/admin\/console"/);
      for (const path of local ? ['/auth/local-login', '/auth/local-register', '/auth/local-change-password'] : ['/auth/local-register']) {
        const page = await request(handler, path);
        assert.equal(page.status, 200);
        for (const admin of ['/admin/console', '/admin/reset-password']) assert.equal(page.body.includes(admin), false, `${path} links to ${admin}`);
      }
    }
    console.log('PASS: no inline script/style/handlers, no forbidden APIs or external assets, reset page and console link each other, no public page links to either');

    // Computed WCAG contrast for the theme palettes (supports the manual spot-check).
    const blockVars = selector => { const i = assets.css.indexOf(selector + ' {'); assert.ok(i >= 0, selector); return Object.fromEntries([...assets.css.slice(i, assets.css.indexOf('}', i)).matchAll(/--(color-[\w-]+):\s*(#[0-9a-f]{6})/g)].map(m => [m[1], m[2]])); };
    const light = blockVars(':root'); const dark = { ...light, ...blockVars(':root[data-theme="dark"]') };
    assert.deepEqual({ ...light, ...blockVars(':root:not([data-theme="light"])') }, dark, 'both dark blocks match');
    const lum = h => { const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const textPairs = ['text/bg', 'text/surface', 'text/surface-muted', 'text/accent-soft', 'text/warning-soft', 'text/danger-soft', 'text-muted/bg', 'text-muted/surface', 'text-muted/surface-muted', 'text-muted/danger-soft', 'text-muted/accent-soft', 'accent/surface', 'accent/bg', 'accent/accent-soft', 'on-accent/accent', 'on-accent/accent-hover', 'danger/surface', 'danger/danger-soft', 'danger/bg', 'on-danger/danger', 'on-danger/danger-hover', 'success/surface', 'success/success-soft', 'success/bg', 'warning/warning-soft'];
    const uiPairs = ['border-strong/surface', 'border-strong/bg', 'border-strong/surface-muted', 'focus/surface', 'focus/bg', 'focus/danger-soft', 'danger/danger-soft'];
    for (const palette of [light, dark]) for (const [pairs, min] of [[textPairs, 4.5], [uiPairs, 3]]) for (const pair of pairs) {
      const [fg, bg] = pair.split('/'); assert.ok(ratio(palette['color-' + fg], palette['color-' + bg]) >= min, `${pair} contrast`);
    }
    console.log('PASS: light and dark palettes meet computed WCAG AA contrast (4.5:1 text, 3:1 UI)');

    // Console script against the real handler and an isolated database.
    handle = await openDatabase(directory);
    const db = handle.database;
    const users = createLocalUserStore(db);
    const secrets = createSecretsStore(db, environment.DB_ENCRYPTION_KEY);
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const firstKid = randomUUID();
    await secrets.insertSigningKey({ kid: firstKid, algorithm: 'RS256', publicKeyPem: pair.publicKey, privateKeyPem: pair.privateKey });
    const seeded = await users.createUser({ username: 'seeded.user', email: `${MARKUP}@example.test`, passwordHash: await hashPassword('seeded-password-123'), createdBy: 'test' });
    const live = createRequestHandler(secrets, loadConfig({ ...environment, ALLOW_NEW_LOCAL_LOGIN_CREATION: 'true' }), users);
    const env = await boot({ responder: viaHandler(live) });
    const { $ } = env;
    assert.deepEqual(env.calls.map(c => `${c.method} ${c.url}`).sort(), ['GET /api/openapi.json', 'GET /health']);
    assert.equal($('health-status').textContent, 'Healthy');
    assert.equal($('mode-status').textContent, 'Local username and password');
    const modeLinks = () => env.document.querySelectorAll('[data-mode]').filter(li => !li.hidden).map(li => li.querySelector('a').getAttribute('href'));
    assert.deepEqual(modeLinks(), ['/auth/local-login', '/auth/local-change-password']);
    assert.equal($('storage-notice').hidden, true);

    // Without the admin token, user actions are disabled with a prompt.
    env.tab('users');
    assert.equal($('section-users').hidden, false); assert.equal($('section-overview').hidden, true);
    assert.equal(env.document.querySelector('[data-section="users"]').getAttribute('aria-current'), 'page');
    assert.equal(env.document.activeElement, $('users-heading'));
    assert.equal($('users-token-prompt').hidden, false); assert.equal($('users-refresh').disabled, true);
    assert.equal(env.calls.length, 2);

    // Settings: save tokens and the acting-as label.
    env.tab('settings');
    env.type('admin-token-input', ` ${ADMIN} `); env.submit('admin-token-form');
    assert.equal(env.session.getItem(KEYS.admin), ADMIN);
    assert.equal($('chip-admin').textContent, 'User-admin token: set');
    assert.equal($('admin-token-input').getAttribute('type'), 'password');
    env.click('admin-token-reveal');
    assert.equal($('admin-token-input').getAttribute('type'), 'text'); assert.equal($('admin-token-reveal').getAttribute('aria-pressed'), 'true');
    env.click('admin-token-reveal');
    assert.equal($('admin-token-input').getAttribute('type'), 'password');
    env.type('acting-input', 'Operator Pat'); env.submit('acting-form');
    assert.equal(env.session.getItem(KEYS.actingAs), 'Operator Pat');
    assert.equal(env.local.map.size, 0, 'nothing but the theme goes to localStorage');

    // Create (no token), with client-side checks first.
    env.tab('users'); await settle(env);
    let start = env.calls.length;
    assert.deepEqual(env.since(start - 1).map(c => `${c.method} ${c.url}`), ['GET /admin/users']);
    env.click('users-new');
    assert.equal($('create-dialog').open, true); assert.equal(env.document.activeElement, $('create-username'));
    const createFields = (password, confirm) => { env.type('create-username', ' New.Admin '); env.type('create-email', 'new@example.test'); env.type('create-password', password); env.type('create-confirm', confirm); };
    createFields('short', 'short'); env.click('create-submit');
    createFields('long-enough-password', 'different-password'); env.click('create-submit');
    env.type('create-username', 'x'); env.click('create-submit');
    await settle(env); assert.equal(env.calls.length, start, 'invalid create input is not sent');
    createFields('long-enough-password', 'long-enough-password'); env.click('create-submit');
    await settle(env);
    let [call] = env.since(start);
    assert.equal(call.method, 'POST'); assert.equal(call.url, '/admin/users'); assert.equal(call.headers.Authorization, undefined);
    assert.deepEqual(body(call), { username: ' New.Admin ', email: 'new@example.test', password: 'long-enough-password', actedBy: 'Operator Pat' });
    assert.equal($('create-dialog').open, false); assert.equal($('create-password').value, ''); assert.equal($('create-confirm').value, '');
    assert.equal($('toast-text').textContent, 'Created user new.admin.');
    assert.equal($('announcer').textContent, 'Created user new.admin.');
    const created = (await users.listUsers()).find(u => u.username === 'new.admin');
    assert.ok(created);

    // List, markup rendered as text, filter.
    const rows = () => $('users-tbody').querySelectorAll('tr');
    assert.equal(rows().length, 2);
    const seededRow = rows().find(r => r.textContent.includes('seeded.user'));
    assert.equal(seededRow.querySelectorAll('td')[1].textContent, `${MARKUP}@example.test`);
    env.type('users-filter', 'NEW'); assert.equal(rows().length, 1); assert.equal($('users-count').textContent, 'Showing 1 of 2 users.');
    env.type('users-filter', 'zzz'); assert.equal(rows().length, 0); assert.equal($('users-state').textContent, 'No users match “zzz”.');
    env.type('users-filter', '');

    // Detail, email, disable, reset.
    start = env.calls.length;
    rows().find(r => r.textContent.includes('new.admin')).querySelector('button').click(); await settle(env);
    [call] = env.since(start);
    assert.deepEqual([call.method, call.url, call.headers.Authorization, call.body], ['GET', `/admin/users/${created.id}`, `Bearer ${ADMIN}`, undefined]);
    assert.equal($('detail-username').textContent, 'new.admin');
    start = env.calls.length;
    env.type('email-input', 'changed@example.test'); env.click('email-submit'); await settle(env);
    env.click('status-toggle'); await settle(env);
    assert.equal($('status-toggle').textContent, 'Enable user'); assert.equal($('detail-status').textContent, 'Disabled');
    env.type('reset-password', 'replacement-pass-1'); env.type('reset-confirm', 'mismatch-pass-123'); env.click('reset-submit'); await settle(env);
    assert.equal($('reset-message').textContent, 'The passwords do not match.');
    env.type('reset-password', 'replacement-pass-1'); env.type('reset-confirm', 'replacement-pass-1'); env.click('reset-submit'); await settle(env);
    assert.equal($('reset-password').value, ''); assert.equal($('reset-confirm').value, '');
    assert.match($('reset-message').textContent, /^Password reset for new\.admin/);
    const patches = env.since(start);
    assert.deepEqual(patches.map(c => [c.method, c.url, c.headers.Authorization, c.headers['Content-Type']]), Array(3).fill(['PATCH', `/admin/users/${created.id}`, `Bearer ${ADMIN}`, 'application/json']));
    assert.deepEqual(patches.map(body), [{ email: 'changed@example.test', actedBy: 'Operator Pat' }, { isActive: false, actedBy: 'Operator Pat' }, { password: 'replacement-pass-1', actedBy: 'Operator Pat' }]);
    const after = await users.getUserById(created.id);
    assert.equal(after.email, 'changed@example.test'); assert.equal(after.isActive, false);
    const labels = (await db.query("SELECT actor_label FROM local_user_admin_audit WHERE action='update' AND result='success'")).rows.map(r => r.actor_label);
    assert.deepEqual(labels, ['Operator Pat', 'Operator Pat', 'Operator Pat']);

    // Delete is blocked until the exact username is typed.
    start = env.calls.length;
    env.click('delete-open');
    assert.equal($('delete-dialog').open, true); assert.equal($('delete-target').textContent, 'new.admin');
    assert.equal($('delete-submit').disabled, true);
    for (const attempt of ['new.admi', 'New.Admin', ' new.admin']) {
      env.type('delete-confirm', attempt); assert.equal($('delete-submit').disabled, true);
      env.click('delete-submit'); env.submit('delete-form');
    }
    await settle(env); assert.equal(env.calls.length, start, 'delete blocked before confirmation');
    env.type('delete-confirm', 'new.admin'); assert.equal($('delete-submit').disabled, false);
    env.click('delete-submit'); await settle(env);
    [call] = env.since(start);
    assert.deepEqual([call.method, call.url, call.headers.Authorization, call.body], ['DELETE', `/admin/users/${created.id}`, `Bearer ${ADMIN}`, undefined]);
    assert.equal(env.since(start).length, 1);
    assert.equal($('delete-dialog').open, false); assert.equal($('user-detail-view').hidden, true);
    assert.equal(rows().length, 1); assert.equal(await users.getUserById(created.id), undefined);
    assert.equal($('toast-text').textContent, 'Deleted new.admin. Audit history is kept.');

    // Signing keys and emergency rotation.
    start = env.calls.length;
    env.tab('keys'); await settle(env);
    [call] = env.since(start);
    assert.deepEqual([call.method, call.url, call.headers.Authorization], ['GET', '/.well-known/jwks.json', undefined]);
    const keyCards = () => $('keys-list').querySelectorAll('li');
    assert.equal(keyCards().length, 1); assert.match(keyCards()[0].textContent, new RegExp(firstKid));
    const [toggle, copy] = keyCards()[0].querySelectorAll('button');
    const modulus = keyCards()[0].querySelector('pre');
    assert.equal(modulus.hidden, true); toggle.click();
    assert.equal(modulus.hidden, false); assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    copy.click(); await settle(env);
    assert.deepEqual(env.clipboardWrites, [modulus.textContent]);
    assert.equal($('rotate-open').disabled, true); assert.equal($('rotate-token-prompt').hidden, false);
    env.tab('settings'); env.type('emergency-token-input', EMERGENCY); env.submit('emergency-token-form');
    env.tab('keys');
    assert.equal($('rotate-open').disabled, false);
    start = env.calls.length;
    env.click('rotate-open'); assert.equal(env.document.activeElement, $('rotate-confirm'));
    for (const attempt of ['rotate', 'ROTATE ', 'ROTAT']) { env.type('rotate-confirm', attempt); assert.equal($('rotate-submit').disabled, true); env.click('rotate-submit'); env.submit('rotate-form'); }
    await settle(env); assert.equal(env.calls.length, start, 'rotation blocked before confirmation');
    env.type('rotate-confirm', 'ROTATE'); env.click('rotate-submit'); await settle(env);
    const rotation = env.since(start);
    assert.deepEqual(rotation.map(c => `${c.method} ${c.url}`), ['POST /admin/emergency-rotate-keys', 'GET /.well-known/jwks.json']);
    assert.equal(rotation[0].headers.Authorization, `Bearer ${EMERGENCY}`);
    assert.deepEqual(body(rotation[0]), { triggeredBy: 'Operator Pat' });
    assert.equal($('rotate-dialog').open, false); assert.equal($('rotate-result').hidden, false);
    assert.equal($('rotate-previous').textContent, firstKid);
    const current = await secrets.getCurrentSigningKey();
    assert.equal($('rotate-new').textContent, current.kid);
    assert.match(keyCards().map(k => k.textContent).join(), new RegExp(current.kid));
    assert.equal((await db.query("SELECT triggered_by FROM emergency_rotation_audit WHERE result='success'")).rows[0].triggered_by, 'Operator Pat');
    checkIsolation(env);

    // Forget all clears storage and the form.
    env.tab('settings'); env.click('forget-all');
    for (const k of Object.values(KEYS)) assert.equal(env.session.getItem(k), null);
    for (const id of ['admin-token-input', 'emergency-token-input', 'acting-input']) assert.equal($(id).value, '');
    assert.equal($('chip-admin').textContent, 'User-admin token: not set'); assert.equal($('chip-emergency').textContent, 'Emergency token: not set');
    console.log('PASS: every console action against the real API: exact method/URL/body/Authorization, token isolation, text rendering, typed confirmations, password clearing, Forget all');

    // 403 on create with registration disabled (real API).
    const closed = createRequestHandler(secrets, loadConfig({ ...environment, ALLOW_NEW_LOCAL_LOGIN_CREATION: 'false' }), users);
    const env403 = await boot({ responder: viaHandler(closed), session: new FakeStorage({ [KEYS.admin]: ADMIN }) });
    env403.tab('users'); await settle(env403);
    env403.click('users-new');
    env403.type('create-username', 'blocked.user'); env403.type('create-email', 'b@example.test');
    env403.type('create-password', 'long-enough-password'); env403.type('create-confirm', 'long-enough-password');
    env403.click('create-submit'); await settle(env403);
    const createCall = env403.calls.at(-1);
    assert.equal(createCall.url, '/admin/users'); assert.equal(createCall.headers.Authorization, undefined, 'admin token never sent to POST /admin/users');
    assert.match(env403.$('create-message').textContent, /ALLOW_NEW_LOCAL_LOGIN_CREATION=true.*restart.*New local account creation is disabled\./);
    assert.equal(env403.$('create-password').value, ''); assert.equal(env403.$('create-confirm').value, '');
    assert.equal(env403.$('create-dialog').open, true);
    checkIsolation(env403);
    console.log('PASS: 403 create explains the registration switch, shows API text, clears passwords, sends no token');

    // Mode detection: Entra document, and unavailable document/health.
    const entra = createRequestHandler(unavailable, loadConfig({ ...environment, LOCAL_LOGIN: 'false' }), unavailable);
    const envEntra = await boot({ responder: viaHandler(entra) });
    assert.equal(envEntra.$('mode-status').textContent, 'Microsoft Entra');
    assert.deepEqual(envEntra.document.querySelectorAll('[data-mode]').filter(li => !li.hidden).map(li => li.querySelector('a').getAttribute('href')), ['/auth/login']);
    const sample = createOpenApiDocument(loadConfig(environment));
    const envSample = await boot({ responder: c => c.url === '/api/openapi.json' ? reply(200, sample) : reply(200, { status: 'ok' }) });
    assert.equal(envSample.$('mode-status').textContent, 'Local username and password');
    const envDown = await boot({ responder: c => { if (c.url === '/health') throw TypeError('Failed to fetch'); return reply(500, { error: 'x' }); } });
    assert.equal(envDown.$('health-status').textContent, 'Unreachable');
    assert.equal(envDown.$('mode-status').textContent, 'Unknown');
    assert.equal(envDown.document.querySelectorAll('[data-mode]').filter(li => !li.hidden).length, 0);
    console.log('PASS: mode detection from sample OpenAPI documents; unknown mode hides mode links; unreachable health');

    // 401 clears only the matching token.
    const userList = { users: [{ id: 'u1', username: 'u.one', email: 'u1@example.test', isActive: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' }] };
    let mode = 'ok';
    const canned = async c => {
      if (c.url === '/health') return reply(200, { status: 'ok' });
      if (c.url === '/api/openapi.json') return reply(200, sample);
      if (c.url === '/.well-known/jwks.json') return reply(200, { keys: [] });
      if (mode === '401') return reply(401, { error: 'Unauthorized' });
      if (c.url === '/admin/users') return reply(200, userList);
      if (c.url === '/admin/users/u1' && c.method === 'GET') return reply(200, userList.users[0]);
      if (mode === 'markup') return reply(400, { error: MARKUP });
      if (mode === '500') return reply(500, { error: 'Unable to complete the request.' });
      if (mode === 'nonjson') return notJson(502);
      if (mode === 'network') throw TypeError('Failed to fetch');
      return reply(200, userList.users[0]);
    };
    const WRONG_ADMIN = 'wrong-admin-token-value'; const WRONG_EMERGENCY = 'wrong-emergency-token-value';
    const env401 = await boot({ responder: canned, session: new FakeStorage({ [KEYS.admin]: WRONG_ADMIN, [KEYS.emergency]: EMERGENCY }) });
    assert.equal(env401.$('admin-token-input').value, WRONG_ADMIN, 'saved token prefilled (masked)');
    assert.equal(env401.$('admin-token-input').getAttribute('type'), 'password');
    mode = '401'; env401.tab('users'); await settle(env401);
    assert.equal(env401.session.getItem(KEYS.admin), null); assert.equal(env401.session.getItem(KEYS.emergency), EMERGENCY);
    assert.equal(env401.$('admin-token-input').value, '');
    assert.match(env401.$('admin-token-message').textContent, /rejected/);
    assert.match(env401.$('toast-text').textContent, /User-admin token was rejected/); assert.equal(env401.$('toast-action').hidden, false);
    assert.equal(env401.$('users-token-prompt').hidden, false);
    env401.session.setItem(KEYS.admin, ADMIN); env401.session.setItem(KEYS.emergency, WRONG_EMERGENCY);
    env401.tab('settings'); env401.type('admin-token-input', ADMIN); env401.submit('admin-token-form');
    env401.type('emergency-token-input', WRONG_EMERGENCY); env401.submit('emergency-token-form');
    env401.tab('keys'); env401.click('rotate-open'); env401.type('rotate-confirm', 'ROTATE'); env401.click('rotate-submit'); await settle(env401);
    assert.equal(env401.session.getItem(KEYS.emergency), null); assert.equal(env401.session.getItem(KEYS.admin), ADMIN);
    assert.match(env401.$('rotate-message').textContent, /Emergency token was rejected/);
    checkIsolation(env401, { wrongTokens: [WRONG_ADMIN, WRONG_EMERGENCY] });
    console.log('PASS: 401 clears only the token that request used and asks for re-entry');

    // Errors as text, password clearing on failure, generic errors, no retry, pending state.
    mode = 'ok';
    const envErr = await boot({ responder: canned, session: new FakeStorage({ [KEYS.admin]: ADMIN }) });
    envErr.tab('users'); await settle(envErr);
    envErr.$('users-tbody').querySelector('button').click(); await settle(envErr);
    mode = 'markup';
    envErr.type('reset-password', 'replacement-pass-1'); envErr.type('reset-confirm', 'replacement-pass-1'); envErr.click('reset-submit'); await settle(envErr);
    assert.equal(envErr.$('reset-message').textContent, MARKUP); assert.equal(envErr.$('reset-password').value, ''); assert.equal(envErr.$('reset-confirm').value, '');
    for (const [m, pattern] of [['500', /could not complete the request \(HTTP 500\)/], ['nonjson', /could not complete the request \(HTTP 502\)/], ['network', /Unable to reach the service/]]) {
      mode = m; envErr.type('email-input', 'x@example.test'); envErr.click('email-submit'); await settle(envErr);
      assert.match(envErr.$('email-message').textContent, pattern);
    }
    mode = '500'; let before = envErr.calls.length;
    envErr.click('delete-open'); envErr.type('delete-confirm', 'u.one'); envErr.click('delete-submit'); await settle(envErr);
    assert.equal(envErr.since(before).filter(c => c.method === 'DELETE').length, 1, 'destructive action not retried');
    assert.match(envErr.$('delete-message').textContent, /HTTP 500/);
    envErr.key('Escape');
    let release; mode = 'ok';
    const pendingEnv = await boot({ responder: async c => { if (c.method === 'PATCH') { await new Promise(r => { release = r; }); } return canned(c); }, session: new FakeStorage({ [KEYS.admin]: ADMIN }) });
    pendingEnv.tab('users'); await settle(pendingEnv);
    pendingEnv.$('users-tbody').querySelector('button').click(); await settle(pendingEnv);
    before = pendingEnv.calls.length;
    pendingEnv.type('reset-password', 'replacement-pass-1'); pendingEnv.type('reset-confirm', 'replacement-pass-1');
    pendingEnv.click('reset-submit'); for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
    assert.equal(pendingEnv.$('reset-submit').disabled, true); assert.equal(pendingEnv.$('reset-submit').getAttribute('aria-busy'), 'true');
    assert.equal(pendingEnv.$('reset-submit').textContent, 'Resetting...');
    pendingEnv.submit('reset-form'); pendingEnv.click('reset-submit');
    release(); await settle(pendingEnv);
    assert.equal(pendingEnv.since(before).length, 1, 'no double submission');
    assert.equal(pendingEnv.$('reset-submit').disabled, false); assert.equal(pendingEnv.$('reset-submit').textContent, 'Reset password');
    assert.equal(pendingEnv.$('reset-password').value, '');
    console.log('PASS: API errors rendered as text, passwords cleared after failure, generic 5xx/non-JSON/network errors, no retry, pending state blocks double submission');

    // Dialog keyboard behavior: focus trap, Escape, focus restore.
    const envKeys = await boot({ responder: canned });
    envKeys.tab('users'); envKeys.$('users-new').focus(); envKeys.click('users-new');
    const dialog = envKeys.$('create-dialog');
    const focusable = dialog.querySelectorAll('button, input').filter(e => !e.disabled);
    focusable.at(-1).focus(); envKeys.key('Tab');
    assert.equal(envKeys.document.activeElement, focusable[0]);
    envKeys.key('Tab', true); assert.equal(envKeys.document.activeElement, focusable.at(-1));
    envKeys.key('Escape');
    assert.equal(dialog.open, false); assert.equal(envKeys.document.activeElement, envKeys.$('users-new'));
    envKeys.click('users-new'); dialog.dispatchEvent(makeEvent('cancel')); assert.equal(dialog.open, false);
    console.log('PASS: dialogs trap Tab/Shift+Tab, close with Escape or cancel, and restore focus');

    // Storage unavailable: tokens in memory with a notice; theme still works.
    const envNoStore = await boot({ responder: canned, session: 'throw', local: 'throw' });
    assert.equal(envNoStore.$('storage-notice').hidden, false);
    envNoStore.tab('settings'); envNoStore.type('admin-token-input', ADMIN); envNoStore.submit('admin-token-form');
    envNoStore.tab('users'); await settle(envNoStore);
    assert.equal(envNoStore.calls.at(-1).headers.Authorization, `Bearer ${ADMIN}`);
    envNoStore.type('theme-select', 'dark'); envNoStore.$('theme-select').dispatchEvent(makeEvent('change'));
    assert.equal(envNoStore.document.documentElement.getAttribute('data-theme'), 'dark');
    checkIsolation(envNoStore);
    // Theme choice persists in localStorage only.
    const themeStore = new FakeStorage();
    const envTheme = await boot({ responder: canned, local: themeStore });
    assert.equal(envTheme.$('theme-select').value, 'system'); assert.equal(envTheme.document.documentElement.hasAttribute('data-theme'), false);
    for (const choice of ['dark', 'light', 'system']) {
      envTheme.$('theme-select').value = choice; envTheme.$('theme-select').dispatchEvent(makeEvent('change'));
      assert.equal(themeStore.getItem('btConsole.theme'), choice);
      assert.equal(envTheme.document.documentElement.getAttribute('data-theme'), choice === 'system' ? null : choice);
    }
    const envReload = await boot({ responder: canned, local: new FakeStorage({ 'btConsole.theme': 'light' }) });
    assert.equal(envReload.document.documentElement.getAttribute('data-theme'), 'light'); assert.equal(envReload.$('theme-select').value, 'light');
    console.log('PASS: sessionStorage fallback to memory with notice; System/Light/Dark theme stored in localStorage with storage-failure fallback');
  } finally {
    await handle?.close(); await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
