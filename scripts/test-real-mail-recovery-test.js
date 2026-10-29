// Mocked tests for the explicit real-mail preview path. Never contacts Resend.
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {runPreview}=require('./preview-password-recovery.js');
async function main(){
  const blocked=spawnSync(process.execPath,['scripts/real-mail-recovery-test.js'],{encoding:'utf8',env:{...process.env,BT_RECOVERY_TEST_RESEND_KEY:'synthetic-never-used'}});
  assert.equal(blocked.status,1);assert.ok(!blocked.stdout.includes('synthetic-never-used'));assert.ok(!blocked.stderr.includes('synthetic-never-used'));
  const sent=[];
  await runPreview({realMail:true,smoke:true,apiKey:'synthetic-never-sent',delivery:async mail=>sent.push(mail)});
  assert.equal(sent.length,1);assert.equal(sent[0].to,'alex@trustbiztech.com');
  const link=new URL(sent[0].link);assert.equal(link.hostname,'127.0.0.1');assert.equal(link.protocol,'http:');assert.equal(link.pathname,'/auth/reset-password');assert.ok(link.hash.startsWith('#token='));
  console.log('PASS explicit real-mail test guard, fixed recipient and loopback reset link using mocked delivery');
}
main().catch(error=>{console.error(error);process.exitCode=1});
