// Run after npm run build. Uses an isolated temporary database; never loads .env.
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Readable } = require('node:stream');
const vm = require('node:vm');
const { loadConfig } = require('../dist/config.js');
const { openDatabase } = require('../dist/database.js');
const { createLocalUserStore } = require('../dist/localUsers.js');
const { createRequestHandler } = require('../dist/index.js');

const environment = {
  PORT: '3210', PGLITE_DATA_DIR: 'unused', DB_ENCRYPTION_KEY: 'a'.repeat(64),
  COOKIE_SECURE: 'false', SERVICE_ISSUER: 'http://localhost:3210',
  EMERGENCY_ROTATION_TOKEN: 'b'.repeat(32), LOCAL_USER_ADMIN_TOKEN: 'c'.repeat(32),
  LOCAL_LOGIN: 'true',
};

async function request(handler, method, url, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  Object.assign(req, { method, url, headers, socket: { remoteAddress: '127.0.0.1' } });
  let response;
  await handler(req, {
    writeHead(status, responseHeaders) { response = { status, headers: responseHeaders }; },
    end(text) { response.body = text; },
  });
  return response;
}

async function main() {
  for (const value of [undefined, '', 'false', 'False', 'yes', '1', 'tru']) {
    assert.equal(loadConfig({ ...environment, ALLOW_NEW_LOCAL_LOGIN_CREATION: value }).allowNewLocalLoginCreation, false);
  }
  for (const value of ['true', 'True', ' TRUE ']) {
    assert.equal(loadConfig({ ...environment, ALLOW_NEW_LOCAL_LOGIN_CREATION: value }).allowNewLocalLoginCreation, true);
  }
  assert.equal(loadConfig({ ...environment, AllOW_NEW_LOCAL_LOGIN_CREATION: 'True' }).allowNewLocalLoginCreation, true);
  assert.equal(loadConfig({ ...environment, AllOW_NEW_LOCAL_LOGIN_CREATION: 'True', ALLOW_NEW_LOCAL_LOGIN_CREATION: 'false' }).allowNewLocalLoginCreation, false);
  console.log('PASS: flag values, original spelling, and uppercase precedence');

  const directory = await mkdtemp(join(tmpdir(), 'bt-registration-'));
  let handle;
  try {
    handle = await openDatabase(directory);
    const store = createLocalUserStore(handle.database);
    const disabled = createRequestHandler({}, loadConfig(environment), store);
    const enabled = createRequestHandler({}, loadConfig({ ...environment, ALLOW_NEW_LOCAL_LOGIN_CREATION: 'True' }), store);
    const body = { username: 'New.User', email: 'new@example.test', password: 'fixture-password-123', actedBy: 'forged-admin' };
    const json = { 'content-type': 'application/json' };
    const auth = { ...json, authorization: `Bearer ${environment.LOCAL_USER_ADMIN_TOKEN}` };
    // CONTRACT-011 §7: with registration off, anonymous creation is a 401 and
    // the admin token still creates users, attributed to its actedBy.
    assert.equal((await request(disabled, 'POST', '/admin/users', body, json)).status, 401);
    assert.equal((await store.listUsers()).length, 0);
    assert.equal((await request(disabled, 'GET', '/auth/local-register')).body.includes('<form'), false);
    assert.match((await request(disabled, 'GET', '/auth/local-register')).body, /No local users yet/);
    const tokenBody = { ...body, username: 'token.user', email: 'token@example.test' };
    const tokenCreated = await request(disabled, 'POST', '/admin/users', tokenBody, auth);
    assert.equal(tokenCreated.status, 201);
    assert.equal((await request(enabled, 'POST', '/admin/users', { ...tokenBody, username: 'wrong.token', email: 'wrong@example.test' },
      { ...json, authorization: 'Bearer wrong-token' })).status, 401, 'a wrong token never falls back to public creation');
    assert.equal((await request(enabled, 'POST', '/admin/users', { ...tokenBody, username: 'enabled.token', email: 'enabled@example.test' }, auth)).status, 201);
    const tokenRows = await handle.database.query(
      "SELECT u.username, u.created_by, a.auth_method FROM local_users u JOIN local_user_admin_audit a ON a.target_user_id = u.id AND a.action = 'create' ORDER BY u.username");
    assert.deepEqual(tokenRows.rows.map(r => ({ ...r })), [
      { username: 'enabled.token', created_by: 'forged-admin', auth_method: 'token' },
      { username: 'token.user', created_by: 'forged-admin', auth_method: 'token' },
    ]);
    for (const user of await store.listUsers()) await store.deleteUser(user.id);
    console.log('PASS: disabled API refuses anonymous creation, admin token creates in both states, disabled page renders');

    assert.equal((await request(enabled, 'POST', '/admin/users', body)).status, 415);
    assert.equal((await request(enabled, 'POST', '/admin/users', { ...body, password: 'short' }, json)).status, 400);
    const created = await request(enabled, 'POST', '/admin/users', body, json);
    assert.equal(created.status, 201);
    const user = JSON.parse(created.body);
    assert.equal(user.username, 'new.user');
    assert.equal(user.isActive, true);
    assert.equal(created.body.includes('password'), false);
    const rows = await handle.database.query('SELECT password_hash, password_salt, created_by FROM local_users');
    assert.notEqual(Buffer.from(rows.rows[0].password_hash).toString(), body.password);
    assert.ok(rows.rows[0].password_salt.length > 0);
    assert.equal(rows.rows[0].created_by, 'public-registration');
    const publicAudit = await handle.database.query("SELECT auth_method FROM local_user_admin_audit WHERE action = 'create' AND target_username = 'new.user' AND result = 'success'");
    assert.equal(publicAudit.rows[0].auth_method, 'public');
    assert.equal((await request(enabled, 'POST', '/admin/users', body, json)).status, 409);
    assert.equal((await request(enabled, 'POST', '/admin/users', { ...body, username: 'other.user' }, json)).status, 409);
    console.log('PASS: public creation, validation, hashing, attribution, and duplicate rejection');

    for (const [method, url, value] of [
      ['GET', '/admin/users'], ['GET', `/admin/users/${user.id}`],
      ['PATCH', `/admin/users/${user.id}`, { isActive: false }],
      ['DELETE', `/admin/users/${user.id}`],
    ]) {
      assert.equal((await request(enabled, method, url, value, json)).status, 401);
    }
    assert.equal((await request(disabled, 'GET', '/admin/users', undefined, auth)).status, 200);
    const second = await request(enabled, 'POST', '/admin/users', { ...body, username: 'disabled.user', email: 'disabled@example.test' }, json);
    const secondUser = JSON.parse(second.body);
    assert.equal((await request(enabled, 'PATCH', `/admin/users/${secondUser.id}`, { isActive: false }, auth)).status, 200);
    for (const handler of [enabled, disabled]) {
      const listing = (await request(handler, 'GET', '/auth/local-register')).body;
      assert.match(listing, /<td>new.user<\/td><td>Active<\/td>/);
      assert.match(listing, /<td>disabled.user<\/td><td>Disabled<\/td>/);
      assert.equal(listing.includes(body.email), false);
      assert.equal(listing.includes('disabled@example.test'), false);
      assert.equal(listing.includes(body.password), false);
    }
    const unavailable = createRequestHandler({}, loadConfig(environment), { listUsers: async () => { throw new Error('private database failure'); } });
    const unavailablePage = (await request(unavailable, 'GET', '/auth/local-register')).body;
    assert.match(unavailablePage, /Unable to load local users/);
    assert.equal(unavailablePage.includes('private database failure'), false);
    const escaped = createRequestHandler({}, loadConfig(environment), { listUsers: async () => [{ username: '<script>alert(1)</script>', isActive: true }] });
    assert.match((await request(escaped, 'GET', '/auth/local-register')).body, /&lt;script&gt;/);
    console.log('PASS: public Active/Disabled list in both modes, empty/error states, and escaped usernames');
    const entra = createRequestHandler({}, loadConfig({ ...environment, LOCAL_LOGIN: 'false', TENANT_ID: 'fixture', CLIENT_ID: 'fixture', ALLOW_NEW_LOCAL_LOGIN_CREATION: 'True' }), store);
    assert.equal((await request(entra, 'GET', '/auth/local-register')).status, 200);
    assert.equal((await request(entra, 'GET', '/auth/local-login')).status, 404);
    console.log('PASS: other admin authorization and local-login mode preserved');

    const page = await request(enabled, 'GET', '/auth/local-register');
    assert.equal(page.headers['Cache-Control'], 'no-store');
    assert.equal(page.body.includes(environment.LOCAL_USER_ADMIN_TOKEN), false);
    const script = page.body.match(/<script>([\s\S]*?)<\/script>/)[1];
    for (const ok of [false, true]) {
      let submit;
      const elements = {
        'create-user-form': { addEventListener(_, fn) { submit = fn; }, reset() { this.resetCalled = true; } },
        'create-user-button': {}, message: {}, username: { value: 'new.user' },
        email: { value: body.email }, password: { value: body.password },
        'local-users-body': { children: [], appendChild(child) { this.children.push(child); } },
        'local-users-empty': { hidden: false },
      };
      const error = '<img src=x onerror=alert(1)>';
      vm.runInNewContext(script, {
        document: {
          getElementById(id) { return elements[id]; },
          createElement() { return { children: [], appendChild(child) { this.children.push(child); } }; },
        },
        fetch: async (url, options) => {
          assert.equal(url, '/admin/users');
          assert.equal(options.method, 'POST');
          assert.equal(JSON.parse(options.body).password, body.password);
          assert.equal(options.headers.Authorization, undefined);
          return { ok, json: async () => ({ error, username: 'new.user', isActive: true }) };
        },
      });
      await submit({ preventDefault() {} });
      assert.equal(elements['create-user-button'].disabled, false);
      if (ok) {
        assert.equal(elements['create-user-form'].hidden, true);
        assert.equal(elements['create-user-form'].resetCalled, true);
        assert.equal(elements['local-users-body'].children[0].children[0].textContent, 'new.user');
        assert.equal(elements['local-users-body'].children[0].children[1].textContent, 'Active');
        assert.equal(elements['local-users-empty'].hidden, true);
      } else {
        assert.equal(elements.message.textContent, error);
        assert.equal(elements.message.innerHTML, undefined);
      }
    }
    console.log('PASS: form API submission, success and safe error rendering');
  } finally {
    await handle?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
