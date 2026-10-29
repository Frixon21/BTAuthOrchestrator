// Synthetic DB, injected mail, loopback HTTP only. Never loads .env or contacts Resend.
const assert = require('node:assert/strict');
const {mkdtemp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {Readable}=require('node:stream');
const {generateKeyPairSync,createHash}=require('node:crypto');
const {createServer}=require('node:http');
const vm=require('node:vm');
const {openDatabase}=require('../dist/database.js');
const {createLocalUserStore}=require('../dist/localUsers.js');
const {createPasswordRecovery,loadRecoveryConfig,resendDelivery}=require('../dist/passwordRecovery.js');
const {hashPassword,verifyPassword}=require('../dist/password.js');
const {createRequestHandler}=require('../dist/index.js');
const {loadConfig}=require('../dist/config.js');
const {withRequestMonitoring}=require('../dist/logging.js');
const env={PORT:'3210',PGLITE_DATA_DIR:'unused',DB_ENCRYPTION_KEY:'a'.repeat(64),COOKIE_SECURE:'false',SERVICE_ISSUER:'http://localhost:3210',EMERGENCY_ROTATION_TOKEN:'b'.repeat(32),LOCAL_USER_ADMIN_TOKEN:'c'.repeat(32),LOCAL_LOGIN:'true',PASSWORD_RESET_PUBLIC_ORIGIN:'http://localhost:3210',PASSWORD_RESET_FROM:'Notifications@example.test',RESEND_API_KEY:'mock-never-sent'};
const json={'content-type':'application/json'};
const original='old-synthetic-password';
const replacement='new-synthetic-password';
async function request(handler,method,url,body,headers=json,ip='127.0.0.1') {
 const req=Readable.from(body===undefined?[]:[typeof body==='string'?body:JSON.stringify(body)]);
 Object.assign(req,{method,url,headers,socket:{remoteAddress:ip}});let result;
 await handler(req,{writeHead(status,headers){result={status,headers}},end(body){result.body=body}});return result;
}
const tokenOf=mail=>new URLSearchParams(new URL(mail.link).hash.slice(1)).get('token');
const stored=row=>({hash:row.passwordHash,salt:row.passwordSalt,algorithm:row.passwordAlgorithm,costN:row.passwordCostN,blockSizeR:row.passwordBlockSizeR,parallelizationP:row.passwordParallelizationP,keyLength:row.passwordKeyLength});
async function main(){
 const dir=await mkdtemp(join(tmpdir(),'bt-recovery-'));let handle,server;
 try {
  handle=await openDatabase(dir);
  const legacyStore=createLocalUserStore(handle.database);
  const legacy=await legacyStore.createUser({username:'legacy',email:'Legacy@Example.test',passwordHash:await hashPassword(original),createdBy:'legacy-fixture'});
  const legacyBefore=await legacyStore.findByUsername('legacy');
  await handle.database.exec('DROP TABLE password_recovery; ALTER TABLE local_users DROP COLUMN recovery_version');
  await handle.close();handle=await openDatabase(dir);
  const upgraded=await createLocalUserStore(handle.database).findByUsername('legacy');
  assert.equal(upgraded.id,legacy.id);assert.equal(upgraded.email,'Legacy@Example.test');assert.equal(upgraded.isActive,true);
  assert.deepEqual(upgraded.passwordHash,legacyBefore.passwordHash);assert.deepEqual(upgraded.passwordSalt,legacyBefore.passwordSalt);assert.equal(upgraded.recoveryVersion,0);
  console.log('PASS migration from pre-recovery schema preserves existing mixed-case account and hash');
  const db=handle.database, users=createLocalUserStore(db), config=loadConfig(env), mails=[];
  const recovery=createPasswordRecovery(db,config.recovery,async mail=>{mails.push(mail)});
  const keys=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  const key={kid:'synthetic',algorithm:'RS256',privateKeyPem:keys.privateKey,publicKeyPem:keys.publicKey};
  const secrets={getCurrentSigningKey:async()=>key,listPublishableSigningKeys:async()=>[key]};
  const fresh=(options={},service=recovery)=>createRequestHandler(secrets,{...config,...options},users,service);
  const h=fresh();
  const alice=await users.createUser({username:'alice',email:'alice@example.test',passwordHash:await hashPassword(original),createdBy:'test'});
  const bob=await users.createUser({username:'bob',email:'bob@example.test',passwordHash:await hashPassword(original),createdBy:'test'});
  const login=async(password=original)=>request(h,'POST','/auth/local-login',{username:'alice',password});
  const oldLogin=await login();assert.equal(oldLogin.status,200);const oldCookie=oldLogin.headers['Set-Cookie'].split(';')[0];
  const consoleHeaders={'x-bt-admin-console':'1',cookie:oldCookie};
  assert.equal((await request(h,'GET','/admin/users',undefined,consoleHeaders)).status,200);
  const forgot=await request(h,'POST','/auth/forgot-password',{email:' ALICE@example.test '});
  const unknown=await request(h,'POST','/auth/forgot-password',{email:'unknown@example.test'});
  assert.equal(forgot.status,200);assert.equal(forgot.body,unknown.body);
  // Await the deliberately asynchronous injected delivery via the DB query queue.
  for(let i=0;i<100 && mails.length<1;i++) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(mails.length,1);const token=tokenOf(mails[0]);assert.match(token,/^[\w-]{43}$/);
  const rows=(await db.query('SELECT * FROM password_recovery')).rows;assert.equal(rows.length,1);assert.equal(rows[0].token_hash,createHash('sha256').update(token).digest('hex'));assert.ok(!JSON.stringify(rows).includes(token));
  await recovery.request(alice.email);assert.equal(mails.length,1);
  const restarted=createPasswordRecovery(db,config.recovery,async mail=>mails.push(mail));
  const beforeRestartRequest=mails.length;await restarted.request(alice.email);assert.equal(mails.length,beforeRestartRequest);
  const before=(await users.findByUsername('alice')).passwordHash;
  const page=await request(h,'GET','/auth/reset-password?token='+token);assert.equal(page.status,200);assert.equal(page.headers['Referrer-Policy'],'no-referrer');assert.equal(page.headers['Cache-Control'],'no-store');assert.ok(!page.body.includes(token));
  assert.equal((await db.query('SELECT * FROM password_recovery')).rows.length,1);
  assert.equal((await request(h,'POST','/auth/reset-password',{token,newPassword:'short'})).status,400);
  assert.equal((await request(h,'POST','/auth/reset-password',{token:'x'.repeat(43),newPassword:replacement})).status,400);
  const concurrent=await Promise.all([1,2].map(()=>request(h,'POST','/auth/reset-password',{token,newPassword:replacement})));
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,400]);
  const after=await users.findByUsername('alice');assert.notDeepEqual(after.passwordHash,before);assert.equal(await verifyPassword(replacement,stored(after)),true);assert.equal(await verifyPassword(original,stored(after)),false);assert.equal(after.recoveryVersion,1);
  assert.equal((await request(h,'POST','/auth/reset-password',{token,newPassword:replacement})).status,400);
  assert.equal((await login()).status,401);assert.equal((await login(replacement)).status,200);
  assert.equal((await request(h,'GET','/admin/users',undefined,consoleHeaders)).status,401);
  const newLogin=await login(replacement);assert.equal((await request(h,'GET','/admin/users',undefined,{...consoleHeaders,cookie:newLogin.headers['Set-Cookie'].split(';')[0]})).status,200);
  const {jwtVerify,importSPKI}=await import('jose');const oldJwt=oldCookie.slice('bt_session='.length);
  assert.equal((await jwtVerify(oldJwt,await importSPKI(keys.publicKey,'RS256'),{issuer:config.issuer})).payload.sub,alice.id);
  assert.equal(await recovery.acceptSession(bob.id,undefined),true);
  assert.equal((await db.query("SELECT * FROM local_user_admin_audit WHERE actor_label='email-recovery'")).rows.length,1);
  console.log('PASS happy flow, generic response, SHA256 storage, GET scanner safety, password policy, single concurrent consume, reuse, sign-in, console revocation and offline JWT compatibility');

  async function issue(email=alice.email){await db.query('DELETE FROM password_recovery WHERE email=$1',[email]);await recovery.request(email);return tokenOf(mails.at(-1));}
  let next=await issue();await db.query("UPDATE password_recovery SET expires_at=now()-interval '1 second'");assert.equal(await recovery.reset(next,replacement),false);
  next=await issue();await users.updateUser(alice.id,{passwordHash:await hashPassword(replacement)});assert.equal(await recovery.reset(next,replacement),false);
  next=await issue();await users.updateUser(alice.id,{email:'changed@example.test'});assert.equal(await recovery.reset(next,replacement),false);await users.updateUser(alice.id,{email:alice.email});
  next=await issue();await users.updateUser(alice.id,{isActive:false});assert.equal(await recovery.reset(next,replacement),false);const count=mails.length;await db.query('DELETE FROM password_recovery');await recovery.request(alice.email);assert.equal(mails.length,count);await users.updateUser(alice.id,{isActive:true});
  const revertedEmailToken=await issue();
  await users.updateUser(alice.id,{email:'temporary@example.test'});await users.updateUser(alice.id,{email:alice.email});
  assert.equal(await recovery.reset(revertedEmailToken,replacement),false);
  const reenabledToken=await issue();await users.updateUser(alice.id,{isActive:false});await users.updateUser(alice.id,{isActive:true});
  assert.equal(await recovery.reset(reenabledToken,replacement),false);
  console.log('PASS email-revert and disable/re-enable cannot revive outstanding links');
  const superseded=await issue();await db.query("UPDATE password_recovery SET requested_at=now()-interval '2 minutes'");
  await recovery.request(alice.email);const newer=tokenOf(mails.at(-1));assert.notEqual(newer,superseded);
  assert.equal(await recovery.reset(superseded,replacement),false);
  await db.query("UPDATE local_users SET failed_login_attempts=10,locked_until=now()+interval '15 minutes' WHERE id=$1",[alice.id]);
  assert.equal(await recovery.reset(newer,replacement),true);
  assert.equal((await users.findByUsername('alice')).lockedUntil,null);assert.equal((await users.findByUsername('alice')).failedLoginAttempts,0);
  const deletedToken=await issue(bob.email);await users.deleteUser(bob.id);assert.equal(await recovery.reset(deletedToken,replacement),false);
  next=await issue();const beforeRollback=(await users.findByUsername('alice')).passwordHash;
  await db.exec('ALTER TABLE local_users ADD CONSTRAINT recovery_test_failure CHECK (recovery_version < 3)');
  await assert.rejects(recovery.reset(next,replacement));assert.deepEqual((await users.findByUsername('alice')).passwordHash,beforeRollback);assert.equal((await db.query('SELECT * FROM password_recovery')).rows.length,1);
  await db.exec('ALTER TABLE local_users DROP CONSTRAINT recovery_test_failure');assert.equal(await recovery.reset(next,replacement),true);
  console.log('PASS expired tokens, password/email change, disabled accounts, transactional failure rollback and retry');
  const mixed=await users.createUser({username:'mixed',email:'Mixed@Example.test',passwordHash:await hashPassword(original),createdBy:'test'});
  await recovery.request('mixed@example.test');assert.equal(mails.at(-1).to,'Mixed@Example.test');
  const mixedToken=tokenOf(mails.at(-1));assert.equal(await recovery.reset(mixedToken,replacement),true);
  await users.createUser({username:'mixed-duplicate',email:'mixed@example.test',passwordHash:await hashPassword(original),createdBy:'test'});
  const beforeAmbiguous=mails.length;await recovery.request('mixed@example.test');assert.equal(mails.length,beforeAmbiguous);
  const beforeInjection=mails.length;await recovery.request("x'OR(1=1)--@example.test");assert.equal(mails.length,beforeInjection);
  const injectionEmail=await request(fresh(),'POST','/auth/forgot-password',{email:"x'OR(1=1)--@example.test"});assert.equal(injectionEmail.status,200);assert.equal(injectionEmail.body,forgot.body);
  assert.equal((await users.getUserById(mixed.id)).email,'Mixed@Example.test');
  console.log('PASS existing mixed-case email, fail-closed case-variant ambiguity and parameterized injection input');

  const failing=createPasswordRecovery(db,config.recovery,async()=>{throw Error('sensitive provider detail')});
  await assert.rejects(failing.request(alice.email));assert.equal((await db.query('SELECT * FROM password_recovery')).rows.length,0);
  await recovery.request(alice.email);assert.equal(mails.at(-1).to,alice.email);
  const mailBefore=mails.length;
  for(let i=0;i<8;i++) assert.equal((await request(h,'POST','/auth/forgot-password',{email:alice.email})).body,forgot.body);
  assert.equal(mails.length,mailBefore);
  for(let i=0;i<10;i++) await request(h,'POST','/auth/reset-password',{token:'bad',newPassword:replacement},json,'limit');
  assert.equal((await request(h,'POST','/auth/reset-password',{token:'bad',newPassword:replacement},json,'limit')).status,429);
  assert.equal((await request(fresh(),'POST','/auth/forgot-password',{email:alice.email},{...json,origin:'https://evil.test'})).status,403);
  assert.equal((await request(fresh(),'POST','/auth/forgot-password',{email:alice.email},{...json,'sec-fetch-site':'cross-site'})).status,403);
  assert.equal((await request(fresh(),'POST','/auth/forgot-password',{email:alice.email},{'content-type':'text/plain'})).status,415);
  assert.equal((await request(fresh(),'POST','/auth/forgot-password','{')).status,400);
  assert.equal((await request(fresh(),'POST','/auth/forgot-password',{email:'invalid'})).status,400);
  assert.equal((await request(fresh(),'POST','/auth/forgot-password','x'.repeat(9000))).status,400);
  assert.equal((await request(fresh({localLogin:false}),'GET','/auth/forgot-password')).status,404);
  const injection=await request(fresh(),'POST','/auth/reset-password',{token:"' OR 1=1 --",newPassword:replacement});assert.equal(injection.status,400);
  assert.equal(injection.headers.Location,undefined);
  const redirectPayload=await request(fresh(),'POST','/auth/forgot-password',{email:'nobody@example.test',redirect:'https://evil.test',returnTo:'https://evil.test'}, {...json,host:'evil.test'});
  assert.equal(redirectPayload.status,200);assert.equal(redirectPayload.headers.Location,undefined);assert.equal(redirectPayload.body,forgot.body);
  const absent=createPasswordRecovery(db);assert.equal((await request(fresh({recovery:undefined},absent),'POST','/auth/forgot-password',{email:alice.email})).status,503);
  for(const origin of ['https://evil.test/path','javascript:alert(1)','https://user:pass@example.test','https://x.test/?x=1','https://x.test/#x']) assert.throws(()=>loadRecoveryConfig({...env,PASSWORD_RESET_PUBLIC_ORIGIN:origin}));
  assert.throws(()=>loadRecoveryConfig({RESEND_API_KEY:'secret'}));assert.equal(loadRecoveryConfig({}),undefined);
  console.log('PASS delivery failure cleanup/retry, cooldown, IP limits, malformed/oversized input, origin/CSRF checks, mode gating and fail-closed configuration');

  // Route failures must return exactly the same confirmation without sensitive logs.
  const errorLines=[],oldError=console.error;console.error=(...args)=>errorLines.push(args.join(' '));
  try {
   const broken={...recovery,request:async()=>{throw Error('sensitive-account-provider-detail')}};
   const failure=await request(fresh({},broken),'POST','/auth/forgot-password',{email:alice.email});
   assert.equal(failure.body,forgot.body);await new Promise(resolve=>setImmediate(resolve));
   assert.ok(errorLines.every(line=>!line.includes('sensitive-account-provider-detail')));
  }finally{console.error=oldError}
  // A login paused after reading an old hash must carry the old generation.
  const readUser=users.findByUsername;let release,entered;
  const blocked=new Promise(resolve=>entered=resolve),resume=new Promise(resolve=>release=resolve);
  users.findByUsername=async(...args)=>{const row=await readUser(...args);entered();await resume;return row};
  const racingLogin=login(replacement);await blocked;
  const raceToken=await issue();assert.equal(await recovery.reset(raceToken,replacement),true);release();
  const staleLogin=await racingLogin;users.findByUsername=readUser;
  assert.equal(staleLogin.status,200);
  assert.equal((await request(h,'GET','/admin/users',undefined,{...consoleHeaders,cookie:staleLogin.headers['Set-Cookie'].split(';')[0]})).status,401);
  console.log('PASS generic route failure logging and login/reset race revocation');

  // Provider boundary uses a stub fetch: no external network.
  const realFetch=global.fetch;let sent;
  try {global.fetch=async(url,options)=>{sent={url,options};return {ok:true,body:{cancel:async()=>{}}}};await resendDelivery(config.recovery)({to:'test@example.test',link:'http://localhost:3210/auth/reset-password#token=mock'});assert.equal(sent.url,'https://api.resend.com/emails');assert.equal(JSON.parse(sent.options.body).from,env.PASSWORD_RESET_FROM);
   global.fetch=async()=>({ok:false,body:{cancel:async()=>{}}});await assert.rejects(resendDelivery(config.recovery)({to:'test@example.test',link:'mock'}));
  }finally{global.fetch=realFetch}

  // Execute the actual inline scripts with a minimal DOM and mock fetch.
  async function ui(reset){
   const html=(await request(h,'GET',reset?'/auth/reset-password':'/auth/forgot-password')).body;
   const nodes={};for(const id of ['recovery-form','message','submit','password','confirm','email'])nodes[id]={value:'',textContent:'',hidden:false,disabled:false};
   let submit,fetchCount=0,historyCleared=false;
   Object.assign(nodes['recovery-form'],{addEventListener:(_,fn)=>submit=fn,reportValidity:()=>true,reset:()=>{}});
   const context={document:{getElementById:id=>nodes[id]},location:{hash:'#token='+'A'.repeat(43),pathname:'/auth/reset-password'},history:{replaceState:()=>historyCleared=true},URLSearchParams,fetch:async()=>{fetchCount++;return{ok:true,json:async()=>({message:'Success'})}}};
   vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
   if(reset){assert.equal(historyCleared,true);nodes.password.value=replacement;nodes.confirm.value='different';await submit({preventDefault(){}});assert.equal(fetchCount,0);assert.equal(nodes.message.textContent,'Passwords must match.');nodes.confirm.value=replacement;}
   else nodes.email.value='test@example.test';
   await submit({preventDefault(){}});assert.equal(fetchCount,1);assert.equal(nodes['recovery-form'].hidden,true);assert.equal(nodes.message.textContent,'Success');assert.equal(nodes.submit.disabled,false);
  }
  await ui(false);await ui(true);
  console.log('PASS Resend adapter with stub fetch and actual form scripts, validation, status and back-to-login markup');

  // Real loopback HTTP with request monitoring; synthetic data only.
  const httpMail=[];
  const httpRecovery=createPasswordRecovery(db,config.recovery,async mail=>httpMail.push(mail));
  await db.query('DELETE FROM password_recovery');
  const lines=[],oldLog=console.log;console.log=(...args)=>lines.push(args.join(' '));
  try {
   server=createServer(withRequestMonitoring(fresh({},httpRecovery)));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
   const base='http://127.0.0.1:'+server.address().port;
   let response=await fetch(base+'/auth/reset-password?token=DO_NOT_LOG');assert.equal(response.status,200);await response.text();
   response=await fetch(base+'/auth/forgot-password',{method:'POST',headers:{...json,origin:config.recovery.origin,host:'attacker.invalid'},body:JSON.stringify({email:'nobody@example.test'})});assert.equal(response.status,200);await response.text();
   assert.ok(lines.every(line=>!line.includes('DO_NOT_LOG')));
   response=await fetch(base+'/auth/forgot-password',{method:'POST',headers:{...json,origin:config.recovery.origin,host:'attacker.invalid'},body:JSON.stringify({email:alice.email})});
   assert.equal(response.status,200);await response.text();
   for(let i=0;i<100 && httpMail.length<1;i++) await new Promise(resolve=>setImmediate(resolve));
   assert.equal(httpMail.length,1);assert.equal(new URL(httpMail[0].link).origin,config.recovery.origin);
   response=await fetch(base+'/auth/reset-password',{method:'POST',headers:{...json,origin:config.recovery.origin},body:JSON.stringify({token:tokenOf(httpMail[0]),newPassword:replacement})});
   assert.equal(response.status,200);await response.text();
  }finally{console.log=oldLog;if(server)await new Promise(resolve=>server.close(resolve));server=undefined}
  console.log('PASS local HTTP routing, generic request, Host independence and query-token log redaction');
  const persistedToken=await issue();
  const finalHash=(await users.findByUsername('alice')).passwordHash;
  await handle.close();handle=await openDatabase(dir);assert.equal(await createPasswordRecovery(handle.database).sessionVersion(alice.id),5);
  assert.deepEqual((await createLocalUserStore(handle.database).findByUsername('alice')).passwordHash,finalHash);
  const reopened=createPasswordRecovery(handle.database,config.recovery,async mail=>mails.push(mail));
  const beforeReopenRequest=mails.length;await reopened.request(alice.email);assert.equal(mails.length,beforeReopenRequest);
  assert.equal(await reopened.reset(persistedToken,replacement),true);
  console.log('PASS idempotent migration and persisted session revocation across reopen');
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await handle?.close();await rm(dir,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1});
