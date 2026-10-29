// TEST-ONLY disposable preview. Direct CLI uses mocked mail; the separate real-mail entry point opts in explicitly.
// Neither mode reads .env or opens an existing database.
// Binds IPv4 loopback only; synthetic account and captured mail are disposable.
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { generateKeyPairSync, randomBytes } = require('node:crypto');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { loadConfig } = require('../dist/config.js');
const { openDatabase } = require('../dist/database.js');
const { createLocalUserStore } = require('../dist/localUsers.js');
const { hashPassword } = require('../dist/password.js');
const { createPasswordRecovery, resendDelivery } = require('../dist/passwordRecovery.js');
const { createRequestHandler } = require('../dist/index.js');
const { withRequestMonitoring } = require('../dist/logging.js');

async function runPreview(options = {}) {
  const realMail = options.realMail === true;
  if (realMail && !options.apiKey) throw Error('Dedicated local-test key required');
  const recipient = realMail ? 'alex@trustbiztech.com' : 'preview@example.test';
  const smoke = options.smoke ?? process.argv.includes('--smoke');
  const portArg = process.argv.find(value => value.startsWith('--port='));
  const port = smoke ? 0 : Number(portArg?.slice(7) ?? 43210);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || (!smoke && port === 0)) throw Error('Use --port=1..65535');
  const directory = await mkdtemp(join(tmpdir(), 'bt-recovery-preview-'));
  const mailboxPath = join(directory, 'mock-mail.json');
  const captures = [];
  let databaseHandle, server, stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    if (server?.listening) await new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
    await databaseHandle?.close();
    // Only remove the exact temporary preview directory created by this run.
    if (resolve(directory).startsWith(resolve(tmpdir()) + require('node:path').sep) && directory.includes('bt-recovery-preview-')) {
      await rm(directory, { recursive: true, force: true });
    }
  }
  try {
    databaseHandle = await openDatabase(directory);
    const users = createLocalUserStore(databaseHandle.database);
    await users.createUser({ username: 'preview', email: recipient,
      passwordHash: await hashPassword('Preview-password-1234'), createdBy: 'synthetic-preview' });
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: {type:'spki',format:'pem'}, privateKeyEncoding: {type:'pkcs8',format:'pem'} });
    const key = {kid:'preview-only',algorithm:'RS256',privateKeyPem:pair.privateKey,publicKeyPem:pair.publicKey};
    const secrets = {getCurrentSigningKey:async()=>key,listPublishableSigningKeys:async()=>[key]};
    // No delivery settings or real credentials are read from the user's environment.
    const config = loadConfig({ PORT:'43210',PGLITE_DATA_DIR:directory,DB_ENCRYPTION_KEY:randomBytes(32).toString('hex'),
      COOKIE_SECURE:'false',SERVICE_ISSUER:'http://127.0.0.1:43210',EMERGENCY_ROTATION_TOKEN:randomBytes(32).toString('hex'),
      LOCAL_USER_ADMIN_TOKEN:randomBytes(32).toString('hex'),LOCAL_LOGIN:'true' });
    if (!realMail) await writeFile(mailboxPath, '[]', {mode:0o600});
    // Resolve the trusted origin after binding an ephemeral port for --smoke.
    server = createServer();
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)});
    const origin = 'http://127.0.0.1:' + server.address().port;
    config.issuer = origin;
    config.recovery = {origin,sender:realMail ? 'Notifications@trustbiztech.com' : 'mock@example.test',apiKey:realMail ? options.apiKey : 'mock-unused'};
    const realDelivery = realMail ? (options.delivery ?? resendDelivery(config.recovery)) : undefined;
    let attemptedRealDelivery = false;
    const recovery = createPasswordRecovery(databaseHandle.database,config.recovery,async mail=>{
      if (realMail) {
        // Explicit test mode: one attempted message, fixed recipient and loopback link.
        if (attemptedRealDelivery || mail.to !== 'alex@trustbiztech.com' || new URL(mail.link).origin !== origin)
          throw Error('Local real-mail test delivery refused');
        attemptedRealDelivery = true;
        await realDelivery(mail);
        if (!smoke) console.log('Resend accepted the local test email to alex@trustbiztech.com. Check that inbox; no link is logged.');
      }
      captures.push(mail);
      // Raw links exist ONLY in this test-only mock-mail capture, never production logs.
      if (!realMail) await writeFile(mailboxPath,JSON.stringify(captures,null,2),{mode:0o600});
      if (!smoke && !realMail) console.log('Mock reset email captured in ' + mailboxPath);
    });
    server.on('request',withRequestMonitoring(createRequestHandler(secrets,config,users,recovery)));
    if (smoke) {
      const json={'Content-Type':'application/json',Origin:origin};
      let response=await fetch(origin+'/auth/local-login');assert.equal(response.status,200);await response.text();
      response=await fetch(origin+'/auth/forgot-password',{method:'POST',headers:json,body:JSON.stringify({email:recipient})});assert.equal(response.status,200);await response.text();
      for(let count=0;count<1000 && !captures.length;count++) await new Promise(resolve=>setImmediate(resolve));
      assert.equal(captures.length,1);
      const token=new URLSearchParams(new URL(captures[0].link).hash.slice(1)).get('token');
      response=await fetch(origin+'/auth/reset-password',{method:'POST',headers:json,body:JSON.stringify({token,newPassword:'Changed-preview-password-1234'})});assert.equal(response.status,200);await response.text();
      response=await fetch(origin+'/auth/local-login',{method:'POST',headers:json,body:JSON.stringify({username:'preview',password:'Changed-preview-password-1234'})});assert.equal(response.status,200);await response.text();
      console.log('PASS synthetic preview smoke: injected mail, HTTP reset and new-password sign-in');
      await stop();
      return;
    }
    console.log('Synthetic preview: ' + origin + '/auth/local-login');
    console.log('Fixture: username preview; email ' + recipient + '; initial password Preview-password-1234');
    if (realMail) {
      console.log('REAL-MAIL TEST: only alex@trustbiztech.com; sender Notifications@trustbiztech.com. One attempted message per run.');
      console.log('No email is sent until you submit Forgot password for that address. The local reset link goes through Resend to Alex.');
    } else console.log('Mock mail capture: ' + mailboxPath);
    console.log('Ctrl+C stops the preview and removes its disposable data.');
    process.once('SIGINT',()=>void stop().catch(error=>{console.error(error.message);process.exitCode=1}));
    process.once('SIGTERM',()=>void stop().catch(error=>{console.error(error.message);process.exitCode=1}));
  } catch(error) { await stop(); throw error; }
}
module.exports = { runPreview };
if (require.main === module) runPreview().catch(error=>{console.error(error.message);process.exitCode=1});
