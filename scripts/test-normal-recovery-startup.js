// Runs actual npm start, or start.sh with --bash=/path/to/bash, from a disposable application copy.
// Production route/adapter code; only outbound fetch is replaced by a test preload.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawn,spawnSync}=require('node:child_process');
const {createServer}=require('node:net');
const {generateKeyPairSync,randomBytes}=require('node:crypto');
const {openDatabase,prepareDataDirectory}=require('../dist/database.js');
const {createLocalUserStore}=require('../dist/localUsers.js');
const {createSecretsStore}=require('../dist/secrets.js');
const {hashPassword}=require('../dist/password.js');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){
 const bash=process.argv.find(value=>value.startsWith('--bash='))?.slice(7);
 const launcher=bash?'start.sh through Bash':'npm start';
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'bt-normal-start-')), app=path.join(root,'app'),data=path.join(root,'persistent-data');
 const mailFile=path.join(root,'mock-mail.json'),stopFile=path.join(root,'stop');let child,dbHandle,logs='';
 try{
  await fs.mkdir(app);await fs.cp(path.join(__dirname,'../dist'),path.join(app,'dist'),{recursive:true});
  await fs.copyFile(path.join(__dirname,'../package.json'),path.join(app,'package.json'));
  if(bash){
   // Linux checkouts use LF; normalize only this disposable Windows test copy.
   await fs.writeFile(path.join(app,'start.sh'),(await fs.readFile(path.join(__dirname,'../start.sh'),'utf8')).replace(/\r\n/g,'\n'),{mode:0o700});
   await fs.mkdir(path.join(app,'scripts'));await fs.copyFile(path.join(__dirname,'startup-check.js'),path.join(app,'scripts/startup-check.js'));
   const syntax=spawnSync(bash,['-n',path.join(app,'start.sh').replace(/\\/g,'/')],{encoding:'utf8'});assert.equal(syntax.status,0,syntax.stderr);
  }
  await fs.symlink(path.resolve(__dirname,'../node_modules'),path.join(app,'node_modules'),process.platform==='win32'?'junction':'dir');
  const preload=path.join(root,'transport.cjs');
  await fs.writeFile(preload,`const fs=require('node:fs');
const mailFile=${JSON.stringify(mailFile)},stopFile=${JSON.stringify(stopFile)};
global.fetch=async(url,options)=>{
 if(url!=='https://api.resend.com/emails')throw Error('External test transport refused');
 const payload=JSON.parse(options.body);
 fs.writeFileSync(mailFile,JSON.stringify(payload));
 await new Promise(resolve=>setTimeout(resolve,150));
 return new Response(JSON.stringify({id:'mock-only'}),{status:200});
};
if(process.argv[1]?.endsWith('index.js'))setInterval(()=>{if(fs.existsSync(stopFile))process.emit('SIGTERM')},25).unref();
`);
  const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const origin='http://127.0.0.1:'+port;
  const settings={PORT:port,LISTEN_HOST:'127.0.0.1',PGLITE_DATA_DIR:data.replace(/\\/g,'/'),DB_ENCRYPTION_KEY:randomBytes(32).toString('hex'),COOKIE_SECURE:'false',SERVICE_ISSUER:origin,EMERGENCY_ROTATION_TOKEN:randomBytes(32).toString('hex'),LOCAL_USER_ADMIN_TOKEN:randomBytes(32).toString('hex'),LOCAL_LOGIN:'true',ALLOW_NEW_LOCAL_LOGIN_CREATION:'false',PASSWORD_RESET_PUBLIC_ORIGIN:origin,PASSWORD_RESET_FROM:'Notifications@trustbiztech.com',RESEND_API_KEY:'synthetic-test-never-sent'};
  await prepareDataDirectory(data);dbHandle=await openDatabase(data);const users=createLocalUserStore(dbHandle.database);
  const existing=await users.createUser({username:'existing.employee',email:'Existing.Employee@example.test',passwordHash:await hashPassword('Existing-password-1234'),createdBy:'pre-recovery-fixture'});
  const before=await users.findByUsername(existing.username);
  const pair=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  await createSecretsStore(dbHandle.database,settings.DB_ENCRYPTION_KEY).insertSigningKey({kid:'persistent-test-key',algorithm:'RS256',publicKeyPem:pair.publicKey,privateKeyPem:pair.privateKey});
  await dbHandle.database.exec('DROP TABLE password_recovery; ALTER TABLE local_users DROP COLUMN recovery_version');await dbHandle.close();dbHandle=undefined;
  async function writeEnv(values){await fs.writeFile(path.join(app,'.env'),Object.entries(values).map(([key,value])=>key+'='+JSON.stringify(String(value))).join('\n'))}
  const npmCli=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
  const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,ComSpec:process.env.ComSpec,TEMP:os.tmpdir(),TMP:os.tmpdir(),NODE_OPTIONS:'--require '+JSON.stringify(preload)};
  async function start(values=settings,expectFailure=false){
   await fs.rm(stopFile,{force:true});await writeEnv(values);logs='';
   child=spawn(bash ?? process.execPath,bash ? ['--noprofile','--norc',path.join(app,'start.sh').replace(/\\/g,'/')] : [npmCli,'start'],{cwd:bash?root:app,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
   child.stdout.on('data',chunk=>logs+=chunk);child.stderr.on('data',chunk=>logs+=chunk);
   for(let i=0;i<400;i++){
    if(child.exitCode!==null){if(expectFailure)return;throw Error('Synthetic '+launcher+' exited unexpectedly: '+logs.replace(/synthetic-test-never-sent/g,'[test-key]'))}
    if(logs.includes('listening on port')){if(expectFailure)throw Error('Invalid config was accepted');return}
    await delay(25);
   }
   throw Error('Synthetic npm start timeout');
  }
  async function stop(){
   if(!child)return;
   await fs.writeFile(stopFile,'stop');
   for(let i=0;i<400 && child.exitCode===null;i++)await delay(25);
   assert.notEqual(child.exitCode,null,'normal app did not shut down');assert.equal(child.exitCode,0);child=undefined;
  }
  const post=(route,body)=>fetch(origin+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});
  await start();assert.match(logs,/passwordRecovery=enabled/);
  let response=await fetch(origin+'/auth/local-login');assert.match(await response.text(),/href="\/auth\/forgot-password"/);
  response=await post('/auth/local-login',{username:existing.username,password:'Existing-password-1234'});assert.equal(response.status,200);
  response=await post('/auth/forgot-password',{email:'existing.employee@example.test'});assert.equal(response.status,200);const generic=await response.text();
  for(let i=0;i<200;i++){try{await fs.access(mailFile);break}catch{await delay(10)}}
  // Stop immediately during the stub provider delay: startup must drain accepted work.
  await stop();const mail=JSON.parse(await fs.readFile(mailFile,'utf8'));assert.deepEqual(mail.to,[existing.email]);assert.equal(mail.from,settings.PASSWORD_RESET_FROM);
  const link=new URL(mail.text.match(/http[^\s]+/)[0]);assert.equal(link.origin,origin);const token=new URLSearchParams(link.hash.slice(1)).get('token');assert.ok(token);
  assert.ok(!logs.includes(token));assert.ok(!logs.includes(settings.RESEND_API_KEY));
  dbHandle=await openDatabase(data);const persisted=await createLocalUserStore(dbHandle.database).findByUsername(existing.username);assert.deepEqual(persisted.passwordHash,before.passwordHash);assert.equal(persisted.id,existing.id);assert.equal(persisted.recoveryVersion,0);assert.equal((await dbHandle.database.query('SELECT * FROM password_recovery')).rows.length,1);await dbHandle.close();dbHandle=undefined;
  await start();response=await post('/auth/reset-password',{token,newPassword:'Normal-start-password-5678'});assert.equal(response.status,200);
  response=await post('/auth/local-login',{username:existing.username,password:'Normal-start-password-5678'});assert.equal(response.status,200);
  response=await post('/auth/reset-password',{token,newPassword:'Normal-start-password-5678'});assert.equal(response.status,400);
  await stop();await start();response=await post('/auth/local-login',{username:existing.username,password:'Normal-start-password-5678'});assert.equal(response.status,200);await stop();
  console.log('PASS '+launcher+', same-.env settings, real app Resend adapter with mock transport, existing-account migration, shutdown drain, persistent reset token and password across restart');
  const missing={...settings,PASSWORD_RESET_PUBLIC_ORIGIN:'',PASSWORD_RESET_FROM:'',RESEND_API_KEY:''};
  await start(missing);assert.match(logs,/passwordRecovery=disabled/);response=await fetch(origin+'/auth/forgot-password');assert.equal(response.status,503);
  response=await post('/auth/forgot-password',{email:existing.email});assert.equal(response.status,503);const known=await response.text();response=await post('/auth/forgot-password',{email:'unknown@example.test'});assert.equal(await response.text(),known);await stop();
  await start({...missing,RESEND_API_KEY:'synthetic-partial'},true);assert.equal(child.exitCode,1);assert.match(logs,/Recovery requires/);assert.ok(!logs.includes('synthetic-partial'));child=undefined;
  console.log('PASS normal startup disabled/missing configuration reports unavailable equally for all accounts; partial config fails startup without credential logging');
 }finally{
  if(child && child.exitCode===null){await fs.writeFile(stopFile,'stop');for(let i=0;i<400 && child.exitCode===null;i++)await delay(25);if(child.exitCode===null)throw Error('Synthetic child still running; temp data retained at '+root)}
  await dbHandle?.close();await fs.rm(root,{recursive:true,force:true});
 }
}
main().catch(error=>{console.error(error);process.exitCode=1});
