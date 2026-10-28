// Run after npm run build. Isolated PGlite; never loads .env or binds a socket.
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Readable } = require('node:stream');
const { generateKeyPairSync } = require('node:crypto');
const vm = require('node:vm');
const { loadConfig } = require('../dist/config.js');
const { openDatabase } = require('../dist/database.js');
const { createLocalUserStore } = require('../dist/localUsers.js');
const passwords = require('../dist/password.js');
const { createRequestHandler } = require('../dist/index.js');
const { createOpenApiDocument } = require('../dist/openapi.js');
const environment = {
  PORT: '3210', PGLITE_DATA_DIR: 'unused', DB_ENCRYPTION_KEY: 'a'.repeat(64),
  COOKIE_SECURE: 'false', SERVICE_ISSUER: 'http://localhost:3210',
  EMERGENCY_ROTATION_TOKEN: 'b'.repeat(32), LOCAL_USER_ADMIN_TOKEN: 'c'.repeat(32),
  LOCAL_LOGIN: 'true', LOCAL_LOGIN_MAX_FAILED_ATTEMPTS: '2',
  LOCAL_LOGIN_IP_THROTTLE_MAX_ATTEMPTS: '2',
};
const json = { 'content-type': 'application/json' };
const auth = { ...json, authorization: `Bearer ${environment.LOCAL_USER_ADMIN_TOKEN}` };
const oldPassword = 'original-password-123';
const newPassword = 'replacement-password-456';
const change = { username: ' Test.User ', currentPassword: oldPassword, newPassword };
async function request(handler, method, url, body, headers = json, ip = '127.0.0.1') {
  const req = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]);
  Object.assign(req, { method, url, headers, socket: { remoteAddress: ip } });
  let response;
  await handler(req, {
    writeHead(status, headers) { response = { status, headers }; },
    end(body) { response.body = body; },
  });
  if (url === '/auth/local-change-password' && method === 'POST' && response.status !== 404) {
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.equal(response.headers['Content-Type'], 'application/json');
    assert.equal(response.headers['Set-Cookie'], undefined);
  }
  return response;
}
async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'bt-password-change-'));
  let handle;
  const originals = Object.fromEntries(['hashPassword', 'verifyPassword', 'deriveDummyHashForTimingParity'].map(k => [k, passwords[k]]));
  const calls = { hashPassword: 0, verifyPassword: 0, deriveDummyHashForTimingParity: 0, lookup: 0 };
  for (const key of Object.keys(originals)) passwords[key] = async (...args) => { calls[key]++; return originals[key](...args); };
  try {
    handle = await openDatabase(directory);
    const db = handle.database;
    const store = createLocalUserStore(db);
    const find = store.findByUsername;
    store.findByUsername = async (...args) => { calls.lookup++; return find(...args); };
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const signingKey = { kid: 'test-key', algorithm: 'RS256', privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
    const secrets = { getCurrentSigningKey: async () => signingKey, getPublicSigningKeys: async () => [] };
    const config = loadConfig(environment);
    const fresh = (overrides = {}, users = store) => createRequestHandler(secrets, loadConfig({ ...environment, ...overrides }), users);
    const handler = fresh();
    const entraConfig = loadConfig({ ...environment, LOCAL_LOGIN: 'false', TENANT_ID: 'test', CLIENT_ID: 'test' });
    const entra = createRequestHandler(secrets, entraConfig, store);
    const unmatched = await request(entra, 'GET', '/no-such-route');
    for (const method of ['GET', 'POST']) {
      const gated = await request(entra, method, '/auth/local-change-password', change);
      assert.equal(gated.status, 404); assert.equal(gated.body, unmatched.body);
    }
    for (const h of [handler, entra]) {
      const page = await request(h, 'GET', '/admin/reset-password');
      assert.equal(page.status, 200); assert.equal(page.headers['Cache-Control'], 'no-store');
      assert.match(page.body, /id="admin-token" type="password"/);
    }
    assert.ok(createOpenApiDocument(config).paths['/auth/local-change-password']);
    assert.equal(createOpenApiDocument(entraConfig).paths['/auth/local-change-password'], undefined);
    assert.ok(createOpenApiDocument(entraConfig).paths['/admin/reset-password']);
    console.log('PASS: route and OpenAPI gating, static uncached admin page');

    const user = await store.createUser({ username: 'test.user', email: 'test@example.test', passwordHash: await passwords.hashPassword(oldPassword), createdBy: 'test' });
    const auditRows = async () => (await db.query('SELECT * FROM local_user_admin_audit ORDER BY occurred_at')).rows;
    const loginRows = async () => (await db.query('SELECT * FROM local_login_audit')).rows;
    const state = () => find('test.user');
    const snapshot = { ...calls };
    for (const [body, headers, status] of [
      [change, {}, 415], [change, { 'content-type': 'text/plain' }, 415],
      ['{', json, 400], [null, json, 400], [[], json, 400],
      [{ ...change, newPassword: 'short' }, json, 400],
      [{ ...change, newPassword: oldPassword }, json, 400],
      ...['username', 'currentPassword', 'newPassword'].flatMap(key => [undefined, '', 1, null, {}].map(value => [{ ...change, [key]: value }, json, 400])),
      [{ ...change, username: '   ' }, json, 400],
    ]) assert.equal((await request(handler, 'POST', '/auth/local-change-password', body, headers)).status, status);
    assert.deepEqual(calls, snapshot); assert.equal((await auditRows()).length, 0); assert.equal((await loginRows()).length, 0);
    console.log('PASS: validation has no lookup, derivation, audit, or throttle effects');

    const login = (h, password, ip = 'login') => request(h, 'POST', '/auth/local-login', { username: user.username, password }, json, ip);
    const signedIn = await login(handler, oldPassword);
    assert.equal(signedIn.status, 200);
    const token = signedIn.headers['Set-Cookie'].match(/bt_session=([^;]+)/)[1];
    await db.query("UPDATE local_users SET failed_login_attempts=1, locked_until=now()-interval '1 minute' WHERE id=$1", [user.id]);
    const before = await state();
    const updatedBefore = (await store.getUserById(user.id)).updatedAt;
    const loginCount = (await loginRows()).length;
    const success = await request(handler, 'POST', '/auth/local-change-password', change);
    assert.equal(success.status, 200); assert.deepEqual(JSON.parse(success.body), { status: 'password_changed', username: user.username });
    const after = await state();
    assert.notDeepEqual(after.passwordHash, before.passwordHash); assert.notDeepEqual(after.passwordSalt, before.passwordSalt);
    assert.equal(after.failedLoginAttempts, 0); assert.equal(after.lockedUntil, null);
    assert.ok(new Date((await store.getUserById(user.id)).updatedAt) > new Date(updatedBefore));
    assert.equal((await loginRows()).length, loginCount);
    assert.equal((await login(handler, oldPassword)).status, 401);
    assert.equal((await login(handler, newPassword)).status, 200);
    const { jwtVerify, exportJWK, createLocalJWKSet } = await import('jose');
    const jwk = { ...await exportJWK(keys.publicKey), kid: signingKey.kid, alg: 'RS256', use: 'sig' };
    assert.equal((await jwtVerify(token, createLocalJWKSet({ keys: [jwk] }), { issuer: config.issuer })).payload.sub, user.id);
    console.log('PASS: fresh hash/salt, atomic lockout reset, timestamp, no cookie/login audit, old/new sign-in, prior session verification');

    const bad = { ...change, currentPassword: 'incorrect-password', newPassword: 'another-password-789' };
    const unchanged = (await state()).passwordHash;
    const beforeDummy = calls.deriveDummyHashForTimingParity;
    const unknown = await request(handler, 'POST', '/auth/local-change-password', { ...bad, username: ' Unknown.User ' }, json, 'unknown');
    assert.equal(calls.deriveDummyHashForTimingParity, beforeDummy + 1);
    const wrong = await request(handler, 'POST', '/auth/local-change-password', bad, json, 'bad');
    assert.equal(unknown.status, 401); assert.equal(wrong.body, unknown.body);
    assert.equal((await state()).failedLoginAttempts, 1);
    assert.equal((await login(fresh(), 'incorrect-password', 'shared')).status, 401);
    const locked = await state(); assert.equal(locked.failedLoginAttempts, 2); assert.ok(locked.lockedUntil > new Date());
    const v = calls.verifyPassword;
    const lockedResponse = await request(handler, 'POST', '/auth/local-change-password', bad, json, 'locked');
    assert.equal(lockedResponse.status, 423); assert.match(lockedResponse.body, new RegExp(locked.lockedUntil.toISOString().replaceAll('.', '\\.')));
    assert.deepEqual(await state(), locked); assert.equal(calls.verifyPassword, v + 1);
    // The correct current password does not bypass a lock or a disable either.
    const correct = { ...change, currentPassword: newPassword, newPassword: bad.newPassword };
    assert.equal((await request(handler, 'POST', '/auth/local-change-password', correct, json, 'locked')).status, 423);
    assert.deepEqual(await state(), locked);
    // Locked and disabled attempts do not consume the change endpoint's IP budget.
    for (let i = 0; i < 3; i++) assert.equal((await request(handler, 'POST', '/auth/local-change-password', bad, json, 'locked')).status, 423);
    await db.query('UPDATE local_users SET is_active=false, locked_until=NULL WHERE id=$1', [user.id]);
    const disabledBefore = await state();
    for (let i = 0; i < 3; i++) assert.equal((await request(handler, 'POST', '/auth/local-change-password', bad, json, 'disabled')).status, 403);
    assert.equal((await request(handler, 'POST', '/auth/local-change-password', correct, json, 'disabled')).status, 403);
    assert.deepEqual(await state(), disabledBefore); assert.deepEqual((await state()).passwordHash, unchanged);
    assert.equal((await request(handler, 'PATCH', `/admin/users/${user.id}`, { password: newPassword }, auth)).status, 200);
    assert.equal((await state()).isActive, false); assert.equal((await state()).failedLoginAttempts, 0);
    await store.updateUser(user.id, { isActive: true });
    // Change failures themselves lock too, sharing the same persistent counter.
    for (let i = 0; i < 2; i++) assert.equal((await request(fresh(), 'POST', '/auth/local-change-password', bad)).status, 401);
    assert.ok((await state()).lockedUntil > new Date());
    assert.equal((await request(handler, 'PATCH', `/admin/users/${user.id}`, { password: newPassword }, auth)).status, 200);
    assert.equal((await state()).lockedUntil, null);
    console.log('PASS: merged credentials, full-cost dummy/locked verification, shared lockout, disabled/locked immutability, same-password admin reset');

    for (const reverse of [false, true]) {
      const h = fresh();
      const first = reverse ? '/auth/local-login' : '/auth/local-change-password';
      const second = reverse ? '/auth/local-change-password' : '/auth/local-login';
      const body = { ...bad, username: 'missing', password: 'incorrect-password' };
      for (let i = 0; i < 2; i++) assert.equal((await request(h, 'POST', first, body)).status, 401);
      const saved = { ...calls }; const audits = (await auditRows()).length; const logins = (await loginRows()).length;
      assert.equal((await request(h, 'POST', first, '{', {})).status, 429);
      assert.deepEqual(calls, saved); assert.equal((await auditRows()).length, audits); assert.equal((await loginRows()).length, logins);
      assert.equal((await request(h, 'POST', second, body)).status, 401);
      // Throttled requests must not even consume the stream.
      await h({ method: 'POST', url: first, headers: {}, socket: { remoteAddress: '127.0.0.1' }, [Symbol.asyncIterator]() { throw Error('body read'); } }, { writeHead(status) { assert.equal(status, 429); }, end() {} });
    }
    const audits = (await auditRows()).filter(row => row.actor_label === 'self-service');
    assert.equal(audits.length, 17, 'exactly one admin audit row per validated change attempt');
    const successRows = audits.filter(row => row.result === 'success');
    assert.equal(successRows.length, 1);
    assert.equal(successRows[0].failure_reason, null); assert.equal(successRows[0].source_ip, '127.0.0.1');
    for (const row of audits) {
      assert.equal(row.action, 'update'); assert.ok(row.source_ip);
      assert.equal(row.changed_fields, row.result === 'success' ? 'password' : null);
      if (row.failure_reason === 'unknown_username') assert.equal(row.target_user_id, null);
      else { assert.equal(row.target_user_id, user.id); assert.equal(row.target_username, user.username); }
    }
    assert.equal(audits.find(row => row.target_username === ' Unknown.User ').failure_reason, 'unknown_username');
    for (const reason of ['unknown_username', 'bad_password', 'locked', 'disabled']) assert.ok(audits.some(row => row.failure_reason === reason));
    for (const password of [oldPassword, newPassword, bad.currentPassword, bad.newPassword]) assert.equal(JSON.stringify(await auditRows()).includes(password), false);
    console.log('PASS: independent throttle counters, throttle-before-body, audit attribution/categories and secret exclusion');

    const logs = []; const originalError = console.error; console.error = (...args) => logs.push(args.join(' '));
    try {
      const failed = fresh({}, { ...store, findByUsername: async () => { throw Error(oldPassword); } });
      const auditsBefore = (await auditRows()).length;
      const result = await request(failed, 'POST', '/auth/local-change-password', { ...change, currentPassword: newPassword, newPassword: oldPassword });
      assert.equal(result.status, 500); assert.equal(result.body.includes(oldPassword), false);
      const errorAudits = await auditRows();
      assert.equal(errorAudits.length, auditsBefore + 1);
      assert.equal(errorAudits.at(-1).failure_reason, 'unexpected_error');
      assert.equal(JSON.stringify(errorAudits).includes(oldPassword), false);
      const noAudit = fresh({}, { ...store, writeAdminAudit: async () => { throw Error(oldPassword); } });
      assert.equal((await request(noAudit, 'POST', '/auth/local-change-password', { ...bad, username: 'missing' })).status, 401);
      assert.equal(logs.join('').includes(oldPassword), false);
    } finally { console.error = originalError; }
    console.log('PASS: generic unexpected error and best-effort audit without secret logging');

    for (const admin of [false, true]) {
      const page = await request(handler, 'GET', admin ? '/admin/reset-password' : '/auth/local-change-password');
      const script = page.body.match(/<script>([\s\S]*?)<\/script>/)[1];
      assert.doesNotMatch(script, /localStorage|sessionStorage|document\.cookie|location|innerHTML/);
      for (const scenario of ['mismatch', 'success', 'blank-label', 'unknown', 'list-error', 'patch-error', 'unauthorized-list', 'unauthorized-patch']) {
        let submit; const fetches = [];
        const elements = Object.fromEntries(['username', 'current-password', 'new-password', 'confirm-password', 'acted-by', 'admin-token', 'message', 'submit-button'].map(id => [id, { value: '' }]));
        Object.assign(elements, { 'password-form': { addEventListener(_, fn) { submit = fn; }, reset() { this.resetCalled = true; } } });
        elements.username.value = ' Test.User '; elements['current-password'].value = oldPassword;
        elements['new-password'].value = newPassword; elements['confirm-password'].value = scenario === 'mismatch' ? 'different' : newPassword;
        elements['admin-token'].value = 'browser-only-secret'; elements['acted-by'].value = scenario === 'blank-label' ? '  ' : 'Operator';
        const error = scenario.startsWith('unauthorized') ? 'Unauthorized' : '<img src=x onerror=alert(1)>';
        vm.runInNewContext(script, {
          document: { getElementById: id => elements[id] },
          fetch: async (url, options) => {
            fetches.push({ url, options });
            if (admin) {
              assert.equal(options.headers.Authorization, 'Bearer browser-only-secret');
              if (fetches.length === 1) {
                assert.equal(url, '/admin/users');
                return { ok: !['list-error', 'unauthorized-list'].includes(scenario), json: async () => ({ error, users: scenario === 'unknown' ? [] : [{ username: user.username, id: user.id }] }) };
              }
              assert.equal(url, `/admin/users/${user.id}`); assert.equal(options.method, 'PATCH');
              assert.deepEqual(JSON.parse(options.body), scenario === 'blank-label' ? { password: newPassword } : { password: newPassword, actedBy: 'Operator' });
            } else {
              assert.equal(url, '/auth/local-change-password'); assert.equal(options.method, 'POST');
              assert.deepEqual(JSON.parse(options.body), change);
            }
            assert.equal(options.headers['Content-Type'], 'application/json');
            return { ok: !['patch-error', 'unauthorized-patch'].includes(scenario), json: async () => ({ error }) };
          },
        });
        await submit({ preventDefault() {} });
        if (scenario === 'mismatch') { assert.equal(fetches.length, 0); assert.equal(elements.message.textContent, 'Passwords do not match.'); }
        else if (admin && scenario === 'unknown') { assert.equal(fetches.length, 1); assert.equal(elements.message.textContent, 'No such user.'); }
        else if (['patch-error', 'unauthorized-patch'].includes(scenario) || (admin && ['list-error', 'unauthorized-list'].includes(scenario))) assert.equal(elements.message.textContent, error);
        else if (admin) { assert.equal(elements.message.textContent, 'Password reset for test.user.'); assert.equal(elements['new-password'].value, ''); assert.equal(elements['confirm-password'].value, ''); }
        else { assert.equal(elements.message.textContent, 'Your password has been changed.'); assert.equal(elements['password-form'].hidden, true); assert.ok(elements['password-form'].resetCalled); }
        assert.equal(elements.message.innerHTML, undefined);
      }
    }
    const loginPage = (await request(handler, 'GET', '/auth/local-login')).body;
    assert.match(loginPage, /href="\/auth\/local-change-password"/);
    for (const path of ['/auth/local-login', '/auth/local-register', '/auth/local-change-password']) {
      const body = (await request(handler, 'GET', path)).body;
      for (const adminPage of ['/admin/reset-password', '/admin/console']) assert.equal(body.includes(adminPage), false);
    }
    console.log('PASS: both form scripts, mismatch, lookup, PATCH/header/body, optional label, success, text errors, no token storage/public admin link');
  } finally {
    Object.assign(passwords, originals);
    await handle?.close(); await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
