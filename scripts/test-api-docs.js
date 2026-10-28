// Run after npm run build. No .env, database, credentials, or network required.
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { loadConfig } = require('../dist/config.js');
const { createRequestHandler } = require('../dist/index.js');
const environment = {
  PORT: '3210', PGLITE_DATA_DIR: 'unused', DB_ENCRYPTION_KEY: 'a'.repeat(64),
  COOKIE_SECURE: 'false', SERVICE_ISSUER: 'http://localhost:3210',
  EMERGENCY_ROTATION_TOKEN: 'b'.repeat(32), LOCAL_USER_ADMIN_TOKEN: 'c'.repeat(32),
  LOCAL_LOGIN: 'true',
};
async function request(handler, url, method = 'GET') {
  const req = Object.assign(Readable.from([]), { method, url, headers: {} });
  const result = {};
  await handler(req, {
    writeHead(status, headers) { Object.assign(result, { status, headers }); },
    end(body) { result.body = body; },
  });
  return result;
}
async function main() {
  for (const local of [true, false]) {
    for (const registration of [true, false]) {
      const config = loadConfig({ ...environment, LOCAL_LOGIN: String(local),
        TENANT_ID: 'tenant', CLIENT_ID: 'client', ALLOW_NEW_LOCAL_LOGIN_CREATION: String(registration) });
      // Any attempt to use a store fails: docs must be independent of the DB.
      const unavailable = new Proxy({}, { get() { throw new Error('Docs accessed store'); } });
      const handler = createRequestHandler(unavailable, config, unavailable);
      const result = await request(handler, '/api/openapi.json?test=1');
      assert.equal(result.status, 200);
      const spec = JSON.parse(result.body);
      assert.equal(spec.openapi, '3.0.3');
      assert.equal(Boolean(spec.paths['/auth/local-login']), local);
      assert.equal(Boolean(spec.paths['/auth/login']), !local);
      assert.equal(Boolean(spec.paths['/auth/callback']), !local);
      assert.match(spec.paths['/admin/users'].post.description, new RegExp(`currently ${registration ? 'enabled' : 'disabled'}`));
      const userSecurity = [{ LocalUserAdminToken: [] }, { ConsoleSession: [] }];
      assert.deepEqual(spec.paths['/admin/users'].post.security, registration ? [...userSecurity, {}] : userSecurity);
      assert.deepEqual(spec.paths['/admin/users'].get.security, userSecurity);
      assert.ok(spec.paths['/admin/session'].get); assert.ok(spec.paths['/auth/logout'].post);
      assert.deepEqual(spec.paths['/admin/emergency-rotate-keys'].post.security, [{ EmergencyRotationToken: [] }]);
      for (const secret of [environment.DB_ENCRYPTION_KEY, environment.EMERGENCY_ROTATION_TOKEN, environment.LOCAL_USER_ADMIN_TOKEN]) assert.equal(result.body.includes(secret), false);
      for (const path of ['/api/docs', '/api/docs/', '/docs', '/docs/']) {
        const page = await request(handler, path);
        assert.equal(page.status, 200);
        assert.match(page.body, /id="swagger-ui"/);
        for (const asset of [...page.body.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1])) {
          const response = await request(handler, asset);
          assert.equal(response.status, 200);
          assert.ok(response.body.length > 0);
          assert.equal((await request(handler, asset, 'HEAD')).body, undefined);
        }
      }
      assert.equal((await request(handler, '/api/docs/../package.json')).status, 404);
      assert.equal((await request(handler, '/api/docs/unknown.js')).status, 404);
      assert.equal((await request(handler, '/api/docs', 'POST')).status, 404);
      assert.equal((await request(handler, '/health')).status, 200);
      assert.equal((await request(handler, '/openapi.json')).body, result.body);
    }
  }
  console.log('PASS: docs routes/assets, HEAD, mode switches, security, secret exclusion, and health regression');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
