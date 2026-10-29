// Explicit local-only real delivery entry point. No .env or other app credential reads.
const { runPreview } = require('./preview-password-recovery.js');
async function main() {
  if (!process.argv.includes('--send-real-mail') || process.argv.includes('--smoke'))
    throw Error('Use the masked-prompt start-real-mail-recovery-test.ps1 launcher. Real mail has no automated smoke mode.');
  const apiKey = process.env.BT_RECOVERY_TEST_RESEND_KEY;
  delete process.env.BT_RECOVERY_TEST_RESEND_KEY;
  if (!apiKey?.trim()) throw Error('Enter the dedicated key through the masked-prompt launcher.');
  await runPreview({realMail:true,apiKey});
}
if (require.main === module) main().catch(()=>{console.error('Local real-mail test could not start. Check the launcher, build and port; no credential details are logged.');process.exitCode=1});
