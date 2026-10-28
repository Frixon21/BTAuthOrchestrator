// Run after npm run build. CONTRACT-011 console sign-in: session authorization
// on /admin/users*, GET /admin/session, POST /auth/logout, audit attribution
// and the audit-column migration. Uses an isolated temporary database; never
// loads .env or binds a socket. Cookies are injected directly, so no
// biztechro.com host is needed.
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Readable } = require('node:stream');
const { generateKeyPairSync, randomUUID } = require('node:crypto');
const { SignJWT, importPKCS8 } = require('jose');
const { loadConfig } = require('../dist/config.js');
const { openDatabase } = require('../dist/database.js');
const { createLocalUserStore } = require('../dist/localUsers.js');
const { createSecretsStore } = require('../dist/secrets.js');
const { createRequestHandler } = require('../dist/index.js');
const { hashPassword } = require('../dist/password.js');
const { mintSessionToken } = require('../dist/tokens.js');

const ADMIN = 'c'.repeat(32);
const EMERGENCY = 'b'.repeat(32);
const ISSUER = 'https://orca.biztechro.com';
const environment = {
  PORT: '3210', PGLITE_DATA_DIR: 'unused', DB_ENCRYPTION_KEY: 'a'.repeat(64),
  COOKIE_SECURE: 'true', SERVICE_ISSUER: ISSUER,
  EMERGENCY_ROTATION_TOKEN: EMERGENCY, LOCAL_USER_ADMIN_TOKEN: ADMIN, LOCAL_LOGIN: 'true',
  TENANT_ID: 'tenant', CLIENT_ID: 'client',
};
const CONSOLE = { 'x-bt-admin-console': '1' };
const JSON_TYPE = { 'content-type': 'application/json' };

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

function newKeyPair() {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { kid: randomUUID(), algorithm: 'RS256', publicKeyPem: pair.publicKey, privateKeyPem: pair.privateKey };
}

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'bt-console-sign-in-'));
  let handle;
  try {
    // Migration: an audit table from before CONTRACT-011 gains the columns,
    // keeps NULLs in existing rows, and reopening is safe.
    handle = await openDatabase(directory);
    await handle.database.exec('ALTER TABLE local_user_admin_audit DROP COLUMN auth_method; ALTER TABLE local_user_admin_audit DROP COLUMN actor_user_id;');
    await handle.database.query(`INSERT INTO local_user_admin_audit (id, action, result) VALUES ('old-row', 'create', 'success')`);
    await handle.close();
    handle = await openDatabase(directory);
    await handle.close();
    handle = await openDatabase(directory);
    const db = handle.database;
    const old = (await db.query(`SELECT auth_method, actor_user_id FROM local_user_admin_audit WHERE id = 'old-row'`)).rows[0];
    assert.deepEqual({ ...old }, { auth_method: null, actor_user_id: null });
    await assert.rejects(db.query(`INSERT INTO local_user_admin_audit (id, action, result, auth_method) VALUES ('bad', 'create', 'success', 'other')`));
    console.log('PASS: audit-column migration adds nullable columns, keeps old rows, and is idempotent');

    const users = createLocalUserStore(db);
    const secrets = createSecretsStore(db, environment.DB_ENCRYPTION_KEY);
    const firstKey = newKeyPair();
    await secrets.insertSigningKey(firstKey);
    const alice = await users.createUser({ username: 'alice', email: 'alice@example.test', passwordHash: await hashPassword('alice-password-123'), createdBy: 'test' });
    const target = await users.createUser({ username: 'target', email: 'target@example.test', passwordHash: await hashPassword('target-password-123'), createdBy: 'test' });

    const config = (overrides = {}) => loadConfig({ ...environment, ...overrides });
    const handler = createRequestHandler(secrets, config(), users);
    const mint = (sub, { key = firstKey, issuer = ISSUER, now = new Date() } = {}) =>
      mintSessionToken({ sub, email: 'x@example.test', upn: 'x' }, key, issuer, now);
    const cookie = token => ({ cookie: `other=1; bt_session=${token}` });
    const aliceToken = await mint(alice.id);
    const lastFailure = async () => (await db.query(
      `SELECT failure_reason, auth_method, actor_label FROM local_user_admin_audit WHERE action = 'auth_failure' ORDER BY occurred_at DESC, id DESC LIMIT 1`)).rows[0];
    const auditCount = async () => (await db.query('SELECT count(*)::int AS n FROM local_user_admin_audit')).rows[0].n;

    // Signing in through /auth/local-login sets the cookie the console then uses.
    const login = await request(handler, 'POST', '/auth/local-login', { username: 'alice', password: 'alice-password-123' }, JSON_TYPE);
    assert.equal(login.status, 200);
    const loginToken = login.headers['Set-Cookie'].split(';')[0].slice('bt_session='.length);

    // Session success on every user route, with session attribution.
    const asAlice = { ...CONSOLE, ...cookie(loginToken) };
    assert.equal((await request(handler, 'GET', '/admin/users', undefined, asAlice)).status, 200);
    assert.equal((await request(handler, 'GET', `/admin/users/${target.id}`, undefined, asAlice)).status, 200);
    const patched = await request(handler, 'PATCH', `/admin/users/${target.id}`, { isActive: false, actedBy: 'Forged Label' }, asAlice);
    assert.equal(patched.status, 200);
    const reset = await request(handler, 'PATCH', `/admin/users/${target.id}`, { password: 'replacement-pass-1' }, asAlice);
    assert.equal(reset.status, 200);
    const created = await request(handler, 'POST', '/admin/users', { username: 'made.by.alice', email: 'made@example.test', password: 'long-enough-password', actedBy: 'Forged Label' }, { ...asAlice, ...JSON_TYPE });
    assert.equal(created.status, 201);
    const madeId = JSON.parse(created.body).id;
    assert.equal((await request(handler, 'DELETE', `/admin/users/${madeId}`, undefined, asAlice)).status, 200);
    const writes = (await db.query(
      `SELECT action, actor_label, auth_method, actor_user_id FROM local_user_admin_audit WHERE result = 'success' AND auth_method = 'session' ORDER BY occurred_at, id`)).rows;
    assert.deepEqual(writes.map(r => r.action).sort(), ['create', 'delete', 'update', 'update']);
    for (const row of writes) assert.deepEqual([row.actor_label, row.actor_user_id], ['alice', alice.id]);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM local_user_admin_audit WHERE actor_label = 'Forged Label'`)).rows[0].n, 0);
    console.log('PASS: an active local user\'s session lists, views, edits, resets, creates and deletes with session attribution; body actedBy ignored');

    // Each §1 rule failing on its own: generic 401 plus the matching failure_reason.
    const generic = { status: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    const expectRefused = async (h, headers, reason, method = 'GET', url = '/admin/users', body) => {
      const before = await auditCount();
      const r = await request(h, method, url, body, headers);
      assert.deepEqual({ status: r.status, body: r.body }, generic, reason);
      assert.equal(await auditCount(), before + 1, `${reason} audited`);
      const row = await lastFailure();
      assert.equal(row.failure_reason, reason);
      return row;
    };
    let row = await expectRefused(handler, {}, 'bad_credential');
    assert.equal(row.auth_method, null);
    await expectRefused(createRequestHandler(secrets, config({ ALLOW_NEW_LOCAL_LOGIN_CREATION: 'true' }), users), asAlice, 'session_registration_open');
    await expectRefused(createRequestHandler(secrets, config({ LOCAL_LOGIN: 'false' }), users), asAlice, 'session_local_login_off');
    await expectRefused(createRequestHandler(secrets, config({ ALLOW_NEW_LOCAL_LOGIN_CREATION: 'true', LOCAL_LOGIN: 'false' }), users),
      cookie(aliceToken), 'session_registration_open');
    await expectRefused(handler, { ...CONSOLE, cookie: `bt_session=${aliceToken}; bt_session=${aliceToken}` }, 'session_invalid');
    await expectRefused(handler, { ...CONSOLE, ...cookie('not-a-jwt') }, 'session_invalid');
    const forger = newKeyPair();
    const forged = await new SignJWT({ sub: alice.id }).setProtectedHeader({ alg: 'RS256', kid: firstKey.kid })
      .setIssuedAt().setExpirationTime('1h').setIssuer(ISSUER).sign(await importPKCS8(forger.privateKeyPem, 'RS256'));
    await expectRefused(handler, { ...CONSOLE, ...cookie(forged) }, 'session_invalid');
    await expectRefused(handler, { ...CONSOLE, ...cookie(await mint(alice.id, { issuer: 'https://evil.example' })) }, 'session_invalid');
    await expectRefused(handler, { ...CONSOLE, ...cookie(await mint(alice.id, { now: new Date('2020-01-01T12:00:00Z') })) }, 'session_invalid');
    const noExp = await new SignJWT({ sub: alice.id }).setProtectedHeader({ alg: 'RS256', kid: firstKey.kid })
      .setIssuedAt().setIssuer(ISSUER).sign(await importPKCS8(firstKey.privateKeyPem, 'RS256'));
    await expectRefused(handler, { ...CONSOLE, ...cookie(noExp) }, 'session_invalid');
    await expectRefused(handler, { ...CONSOLE, ...cookie(await mint(randomUUID())) }, 'session_user_not_active');
    await expectRefused(handler, { ...CONSOLE, ...cookie(await mint('00000000-entra-object-id')) }, 'session_user_not_active');
    row = await expectRefused(handler, cookie(aliceToken), 'session_csrf_rejected');
    assert.deepEqual([row.auth_method, row.actor_label], ['session', null]);
    await expectRefused(handler, { 'x-bt-admin-console': 'yes', ...cookie(aliceToken) }, 'session_csrf_rejected');
    await expectRefused(handler, { ...asAlice, origin: 'https://other.biztechro.com' }, 'session_csrf_rejected');
    await expectRefused(handler, { ...asAlice, 'sec-fetch-site': 'same-site' }, 'session_csrf_rejected');
    assert.equal((await request(handler, 'GET', '/admin/users', undefined, { ...asAlice, origin: ISSUER, 'sec-fetch-site': 'same-origin' })).status, 200);
    console.log('PASS: every §1 rule failing in isolation gives the generic 401 and its own failure_reason');

    // Disabling or deleting the signed-in user ends their admin access on the next request.
    await users.updateUser(alice.id, { isActive: false });
    await expectRefused(handler, asAlice, 'session_user_not_active');
    await users.updateUser(alice.id, { isActive: true });
    assert.equal((await request(handler, 'GET', '/admin/users', undefined, asAlice)).status, 200);
    // A lockout does not remove session admin (CONTRACT-011 OQ-5).
    await db.query(`UPDATE local_users SET locked_until = now() + interval '1 hour' WHERE id = $1`, [alice.id]);
    assert.equal((await request(handler, 'GET', '/admin/users', undefined, asAlice)).status, 200);
    await db.query(`UPDATE local_users SET locked_until = NULL WHERE id = $1`, [alice.id]);
    const bob = await users.createUser({ username: 'bob', email: 'bob@example.test', passwordHash: await hashPassword('bob-password-1234'), createdBy: 'test' });
    const asBob = { ...CONSOLE, ...cookie(await mint(bob.id)) };
    assert.equal((await request(handler, 'GET', '/admin/users', undefined, asBob)).status, 200);
    await users.deleteUser(bob.id);
    await expectRefused(handler, asBob, 'session_user_not_active');
    console.log('PASS: mid-session disable or delete is refused on the next request; a lockout is not');

    // Precedence: an Authorization header always means the token path.
    row = await expectRefused(handler, { ...asAlice, authorization: 'Bearer wrong' }, 'bad_credential');
    assert.equal(row.auth_method, 'token');
    assert.equal((await request(handler, 'GET', '/admin/users', undefined, { authorization: `Bearer ${ADMIN}` })).status, 200);
    const tokenPatch = await request(handler, 'PATCH', `/admin/users/${target.id}`, { isActive: true, actedBy: 'Operator Pat' }, { authorization: `Bearer ${ADMIN}` });
    assert.equal(tokenPatch.status, 200);
    const tokenRow = (await db.query(`SELECT actor_label, auth_method, actor_user_id FROM local_user_admin_audit WHERE action = 'update' AND auth_method = 'token'`)).rows[0];
    assert.deepEqual({ ...tokenRow }, { actor_label: 'Operator Pat', auth_method: 'token', actor_user_id: null });
    console.log('PASS: a wrong bearer token is refused even with a valid cookie; a correct token behaves as before');

    // Emergency rotation never accepts the cookie.
    const rotationCookie = await request(handler, 'POST', '/admin/emergency-rotate-keys', undefined, asAlice);
    assert.equal(rotationCookie.status, 401);
    console.log('PASS: emergency rotation refuses a valid session cookie');

    // GET /admin/session: every reason/signedIn combination.
    const sessionOf = async (h, headers = {}) => {
      const r = await request(h, 'GET', '/admin/session', undefined, headers);
      assert.equal(r.status, 200); assert.equal(r.headers['Cache-Control'], 'no-store');
      return JSON.parse(r.body);
    };
    assert.deepEqual(await sessionOf(handler), { sessionAdmin: 'available', reason: null, signedIn: false, user: null });
    assert.deepEqual(await sessionOf(handler, cookie(aliceToken)), { sessionAdmin: 'available', reason: null, signedIn: true, user: { id: alice.id, username: 'alice' } });
    assert.deepEqual(await sessionOf(handler, cookie('garbage')), { sessionAdmin: 'available', reason: null, signedIn: false, user: null });
    assert.deepEqual(await sessionOf(handler, { cookie: `bt_session=${aliceToken}; bt_session=${aliceToken}` }), { sessionAdmin: 'available', reason: null, signedIn: false, user: null });
    assert.deepEqual(await sessionOf(createRequestHandler(secrets, config({ ALLOW_NEW_LOCAL_LOGIN_CREATION: 'true' }), users), cookie(aliceToken)),
      { sessionAdmin: 'unavailable', reason: 'registration_open', signedIn: false, user: null });
    assert.deepEqual(await sessionOf(createRequestHandler(secrets, config({ LOCAL_LOGIN: 'false' }), users), cookie(aliceToken)),
      { sessionAdmin: 'unavailable', reason: 'local_login_off', signedIn: false, user: null });
    const brokenStore = { ...users, getUserById: async () => { throw new Error('private database failure'); } };
    const broken = await request(createRequestHandler(secrets, config(), brokenStore), 'GET', '/admin/session', undefined, cookie(aliceToken));
    assert.equal(broken.status, 500); assert.equal(broken.body.includes('private database failure'), false);
    const brokenAdmin = await request(createRequestHandler(secrets, config(), brokenStore), 'GET', '/admin/users', undefined, asAlice);
    assert.equal(brokenAdmin.status, 500);
    console.log('PASS: GET /admin/session reports availability, reason and the signed-in user; store failures are a generic 500');

    // Retired keys still verify; revoked keys do not.
    await db.query(`UPDATE signing_keys SET status = 'retired', retired_at = now() WHERE kid = $1`, [firstKey.kid]);
    const secondKey = newKeyPair();
    await secrets.insertSigningKey(secondKey);
    assert.equal((await request(handler, 'GET', '/admin/users', undefined, asAlice)).status, 200, 'retired key');
    assert.equal((await request(handler, 'GET', '/admin/users', undefined, { ...CONSOLE, ...cookie(await mint(alice.id, { key: secondKey })) })).status, 200);
    await db.query(`UPDATE signing_keys SET status = 'revoked', revoked_at = now() WHERE kid = $1`, [firstKey.kid]);
    await expectRefused(handler, asAlice, 'session_invalid');
    console.log('PASS: a cookie signed by a retired key authorizes; a revoked key does not');

    // POST /auth/logout.
    const out = await request(handler, 'POST', '/auth/logout', undefined, { ...CONSOLE, origin: ISSUER });
    assert.equal(out.status, 200);
    assert.deepEqual(JSON.parse(out.body), { status: 'signed_out' });
    assert.equal(out.headers['Set-Cookie'], 'bt_session=; Domain=.biztechro.com; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Lax; Secure');
    assert.match(login.headers['Set-Cookie'], /^bt_session=[^;]+; Domain=\.biztechro\.com; Path=\//, 'same name, domain and path as sign-in');
    for (const headers of [{}, { ...CONSOLE, origin: 'https://evil.example' }, { ...CONSOLE, 'sec-fetch-site': 'cross-site' }]) {
      const refused = await request(handler, 'POST', '/auth/logout', undefined, headers);
      assert.equal(refused.status, 403); assert.equal(refused.headers['Set-Cookie'], undefined);
    }
    const entraOut = await request(createRequestHandler(secrets, config({ LOCAL_LOGIN: 'false' }), users), 'POST', '/auth/logout', undefined, CONSOLE);
    assert.equal(entraOut.status, 200);
    console.log('PASS: POST /auth/logout clears bt_session with matching attributes, in both modes, and refuses requests without the console checks');

    // Creation (§7): registration off.
    const newUser = n => ({ username: n, email: `${n}@example.test`, password: 'long-enough-password' });
    const asAliceNow = { ...CONSOLE, ...cookie(await mint(alice.id, { key: secondKey })), ...JSON_TYPE };
    assert.equal((await request(handler, 'POST', '/admin/users', newUser('off.anon'), JSON_TYPE)).status, 401);
    assert.equal((await lastFailure()).failure_reason, 'bad_credential');
    assert.equal((await request(handler, 'POST', '/admin/users', newUser('off.session'), asAliceNow)).status, 201);
    assert.equal((await request(handler, 'POST', '/admin/users', newUser('off.token'), { ...JSON_TYPE, authorization: `Bearer ${ADMIN}` })).status, 201);
    assert.equal((await request(handler, 'POST', '/admin/users', newUser('off.textplain'), { authorization: `Bearer ${ADMIN}`, 'content-type': 'text/plain' })).status, 415);
    // Registration on: a wrong token is never public creation; no header is.
    const open = createRequestHandler(secrets, config({ ALLOW_NEW_LOCAL_LOGIN_CREATION: 'true' }), users);
    assert.equal((await request(open, 'POST', '/admin/users', newUser('on.wrong'), { ...JSON_TYPE, authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await request(open, 'POST', '/admin/users', newUser('on.public'), asAliceNow)).status, 201, 'cookie ignored; public');
    const createdRows = (await db.query(`SELECT u.username, u.created_by, a.auth_method, a.actor_user_id FROM local_users u
      JOIN local_user_admin_audit a ON a.target_user_id = u.id AND a.action = 'create' AND a.result = 'success'
      WHERE u.username LIKE 'o%.%' ORDER BY u.username`)).rows.map(r => ({ ...r }));
    assert.deepEqual(createdRows, [
      { username: 'off.session', created_by: 'alice', auth_method: 'session', actor_user_id: alice.id },
      { username: 'off.token', created_by: null, auth_method: 'token', actor_user_id: null },
      { username: 'on.public', created_by: 'public-registration', auth_method: 'public', actor_user_id: null },
    ]);
    console.log('PASS: creation by token or session while registration is off, public only without a header while it is on');

    // bt_session never appears in audit rows.
    const dump = JSON.stringify((await db.query('SELECT * FROM local_user_admin_audit')).rows);
    for (const token of [aliceToken, loginToken]) assert.equal(dump.includes(token), false);
    console.log('PASS: session tokens never stored in audit rows');
  } finally {
    await handle?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
