// Run after npm run build. CONTRACT-012 §2-§3 (TASK-029): TRUSTED_PROXIES
// parsing and the client address used for audit source_ip and the per-IP
// throttles. Uses an isolated temporary database; never loads .env or binds
// a socket.
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Readable } = require('node:stream');
const { loadConfig } = require('../dist/config.js');
const { openDatabase } = require('../dist/database.js');
const { createLocalUserStore } = require('../dist/localUsers.js');
const { createSecretsStore } = require('../dist/secrets.js');
const { createRequestHandler } = require('../dist/index.js');
const { createClientAddressResolver, parseTrustedProxies } = require('../dist/clientAddress.js');
const { hashPassword } = require('../dist/password.js');

const ADMIN = 'c'.repeat(32);
const environment = {
  PORT: '3210', PGLITE_DATA_DIR: 'unused', DB_ENCRYPTION_KEY: 'a'.repeat(64),
  COOKIE_SECURE: 'true', SERVICE_ISSUER: 'https://orca.biztechro.com',
  EMERGENCY_ROTATION_TOKEN: 'b'.repeat(32), LOCAL_USER_ADMIN_TOKEN: ADMIN, LOCAL_LOGIN: 'true',
  LOCAL_LOGIN_IP_THROTTLE_MAX_ATTEMPTS: '3',
};
const CONNECTOR = '172.30.10.2';
const SUBNET = '172.30.10.0/29';

async function request(handler, method, url, body, headers = {}, peer = '127.0.0.1') {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  Object.assign(req, { method, url, headers, socket: { remoteAddress: peer } });
  let response;
  await handler(req, {
    writeHead(status, responseHeaders) { response = { status, headers: responseHeaders }; },
    end(text) { response.body = text; },
  });
  return response;
}

const fakeRequest = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });

async function main() {
  // §3 parsing and validation.
  const ok = [];
  assert.deepEqual(parseTrustedProxies(undefined, ok), []);
  assert.deepEqual(parseTrustedProxies('   ', ok), []);
  assert.deepEqual(parseTrustedProxies(` ${SUBNET} , 10.1.2.3, fd00::/8, ::ffff:192.168.1.5 `, ok), [
    { address: '172.30.10.0', prefix: 29, family: 'ipv4' },
    { address: '10.1.2.3', prefix: 32, family: 'ipv4' },
    { address: 'fd00::', prefix: 8, family: 'ipv6' },
    { address: '192.168.1.5', prefix: 32, family: 'ipv4' },
  ]);
  assert.deepEqual(ok, []);
  for (const bad of ['10.0.0.0/33', 'fd00::/129', 'not-an-ip', '10.0.0.1/', '10.0.0.0/8/1', '10.0.0.0/-1', '10.0.0.0/x', '10.0.0.1,,10.0.0.2', '10.0.0.256', 'orca.biztechro.com']) {
    assert.throws(() => loadConfig({ ...environment, TRUSTED_PROXIES: bad }), error => {
      assert.match(error.message, /TRUSTED_PROXIES \(invalid entry "/);
      return true;
    }, bad);
  }
  assert.throws(() => loadConfig({ ...environment, TRUSTED_PROXIES: '10.0.0.1, nope' }), /invalid entry "nope"/);
  assert.deepEqual(loadConfig(environment).trustedProxies, []);
  console.log('PASS: TRUSTED_PROXIES accepts addresses and CIDR ranges and fails closed naming each bad entry');

  // §2 rule table, directly on the resolver.
  const none = createClientAddressResolver([]);
  const trusted = createClientAddressResolver(parseTrustedProxies(`${SUBNET}, fd00::/8`, []));
  const forged = { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1' };
  assert.equal(none(fakeRequest(CONNECTOR, forged)), CONNECTOR, 'unset: headers ignored');
  assert.equal(none(fakeRequest('::ffff:203.0.113.4')), '203.0.113.4', 'mapped peer normalized');
  assert.equal(none(fakeRequest(undefined)), null);
  assert.equal(trusted(fakeRequest('203.0.113.50', forged)), '203.0.113.50', 'untrusted peer: headers ignored');
  assert.equal(trusted(fakeRequest(CONNECTOR, { 'x-forwarded-for': '198.51.100.1' })), CONNECTOR, 'X-Forwarded-For never read');
  assert.equal(trusted(fakeRequest(CONNECTOR, { 'cf-connecting-ip': ' 203.0.113.9 ' })), '203.0.113.9');
  assert.equal(trusted(fakeRequest(`::ffff:${CONNECTOR}`, { 'cf-connecting-ip': '2001:db8::7' })), '2001:db8::7', 'mapped trusted peer, IPv6 client');
  assert.equal(trusted(fakeRequest('fd00::5', { 'cf-connecting-ip': '::ffff:203.0.113.9' })), '203.0.113.9', 'IPv6 trusted peer, mapped client');
  for (const value of [undefined, '', 'garbage', '203.0.113.9, 203.0.113.10', '203.0.113.999', '<script>']) {
    const headers = value === undefined ? {} : { 'cf-connecting-ip': value };
    assert.equal(trusted(fakeRequest(CONNECTOR, headers)), CONNECTOR, `fallback for ${value}`);
  }
  assert.equal(trusted(fakeRequest(CONNECTOR, { 'cf-connecting-ip': ['203.0.113.9', '203.0.113.10'] })), CONNECTOR, 'repeated header');
  assert.equal(trusted(fakeRequest('172.30.10.8', forged)), '172.30.10.8', 'just outside the range');
  console.log('PASS: client address follows every row of CONTRACT-012 §2');

  // End to end: throttle keys and audit source_ip through the real handler.
  const directory = await mkdtemp(join(tmpdir(), 'bt-trusted-proxies-'));
  let handle;
  try {
    handle = await openDatabase(directory);
    const db = handle.database;
    const users = createLocalUserStore(db);
    await users.createUser({ username: 'alice', email: 'alice@example.test', passwordHash: await hashPassword('alice-password-123'), createdBy: 'test' });
    const json = { 'content-type': 'application/json' };
    const wrong = { username: 'alice', password: 'wrong-password-123' };
    const secrets = createSecretsStore(db, environment.DB_ENCRYPTION_KEY);
    const tunnel = createRequestHandler(secrets, loadConfig({ ...environment, TRUSTED_PROXIES: SUBNET }), users);
    const direct = createRequestHandler(secrets, loadConfig(environment), users);
    const attempt = (handler, headers, peer) => request(handler, 'POST', '/auth/local-login', wrong, { ...json, ...headers }, peer);

    // Two clients behind the connector are throttled separately (max 3).
    for (let i = 0; i < 3; i++) assert.equal((await attempt(tunnel, { 'cf-connecting-ip': '203.0.113.1' }, CONNECTOR)).status, 401);
    assert.equal((await attempt(tunnel, { 'cf-connecting-ip': '203.0.113.1' }, CONNECTOR)).status, 429);
    assert.equal((await attempt(tunnel, { 'cf-connecting-ip': '203.0.113.2' }, CONNECTOR)).status, 401, 'second client unaffected');
    // Without TRUSTED_PROXIES, a forged header cannot escape the throttle.
    for (let i = 0; i < 3; i++) await attempt(direct, { 'cf-connecting-ip': `198.51.100.${i}`, 'x-forwarded-for': `198.51.100.${i}` }, '203.0.113.77');
    assert.equal((await attempt(direct, { 'cf-connecting-ip': '198.51.100.99', 'x-forwarded-for': '198.51.100.99' }, '203.0.113.77')).status, 429);
    const loginIps = (await db.query('SELECT DISTINCT source_ip FROM local_login_audit ORDER BY source_ip')).rows.map(r => r.source_ip);
    assert.deepEqual(loginIps, ['203.0.113.1', '203.0.113.2', '203.0.113.77']);
    console.log('PASS: per-IP throttle counts real clients behind the tunnel; forged headers do not escape it; login audit records the derived address');

    // Admin and rotation audit rows use the same address.
    await request(tunnel, 'GET', '/admin/users', undefined, { 'cf-connecting-ip': '203.0.113.3' }, CONNECTOR);
    await request(tunnel, 'POST', '/admin/emergency-rotate-keys', undefined, { 'cf-connecting-ip': '203.0.113.4', authorization: 'Bearer wrong' }, CONNECTOR);
    await request(direct, 'GET', '/admin/users', undefined, { 'cf-connecting-ip': '198.51.100.5', 'x-forwarded-for': '198.51.100.5' }, '203.0.113.88');
    const adminIps = (await db.query(`SELECT source_ip FROM local_user_admin_audit WHERE action = 'auth_failure' ORDER BY occurred_at, id`)).rows.map(r => r.source_ip);
    assert.deepEqual(adminIps, ['203.0.113.3', '203.0.113.88']);
    const rotationIp = (await db.query('SELECT source_ip FROM emergency_rotation_audit')).rows.map(r => r.source_ip);
    assert.deepEqual(rotationIp, ['203.0.113.4']);
    console.log('PASS: admin and emergency-rotation audit rows record the derived address');
  } finally {
    await handle?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
