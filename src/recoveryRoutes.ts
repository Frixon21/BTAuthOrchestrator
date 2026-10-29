import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from './config.js';
import type { PasswordRecovery } from './passwordRecovery.js';

const confirmation = 'If an eligible account exists, a password reset link will be emailed. Check your inbox and spam folder.';
const invalid = 'This reset link is invalid or expired. Request a new link.';
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
const page = (reset: boolean) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${reset ? 'Reset password' : 'Forgot password'}</title></head><body>
<h1>${reset ? 'Reset password' : 'Forgot password'}</h1>
<form id="recovery-form">
${reset ? '<p><label for="password">New password (12–1024 characters)</label> <input id="password" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required></p><p><label for="confirm">Confirm new password</label> <input id="confirm" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required></p>' : '<p><label for="email">Email address</label> <input id="email" type="email" autocomplete="email" maxlength="254" required></p>'}
<button id="submit" type="submit">${reset ? 'Reset password' : 'Email reset link'}</button></form>
<p id="message" role="status" aria-live="polite"></p><p><a href="/auth/local-login">Back to sign in</a></p>
${reset ? '<p><a href="/auth/forgot-password">Request a new link</a></p>' : ''}
<script>
(function () {
var reset = ${reset}, token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
if (reset) history.replaceState(null, '', location.pathname);
var form = document.getElementById('recovery-form'), message = document.getElementById('message'), button = document.getElementById('submit');
if (reset && !/^[A-Za-z0-9_-]{43}$/.test(token)) { form.hidden = true; message.textContent = ${JSON.stringify(invalid)}; }
form.addEventListener('submit', async function(event) {
 event.preventDefault(); if (!form.reportValidity()) return;
 if (reset && document.getElementById('password').value !== document.getElementById('confirm').value) { message.textContent = 'Passwords must match.'; return; }
 button.disabled = true; message.textContent = '';
 try {
  var body = reset ? {token:token,newPassword:document.getElementById('password').value} : {email:document.getElementById('email').value};
  var response = await fetch(reset ? '/auth/reset-password' : '/auth/forgot-password', {method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  var result = await response.json(); message.textContent = result.message || result.error || 'Please try again.';
  if (response.ok) { form.hidden = true; form.reset(); token = ''; }
 } catch (_) { message.textContent = 'Unable to complete the request. Please try again.'; }
 finally { button.disabled = false; }
});
})();
</script></body></html>`;

// Bounded, expiring buckets: failed/unknown accounts consume the same limits.
export function createRecoveryHandler(config: Config, recovery: PasswordRecovery | undefined,
  sourceIp: (request: IncomingMessage) => string | null) {
  const buckets = new Map<string, { count: number; until: number }>();
  function allow(key: string, max: number, window: number) {
    const now = Date.now();
    for (const [k,v] of buckets) if (v.until <= now) buckets.delete(k);
    const entry = buckets.get(key);
    if (entry) { if (entry.count >= max) return false; entry.count++; return true; }
    if (buckets.size >= 10000) return false;
    buckets.set(key, {count:1,until:now+window}); return true;
  }
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = (request.url ?? '').split('?')[0];
    if (!config.localLogin || !['/auth/forgot-password','/auth/reset-password'].includes(path)) return false;
    const reset = path === '/auth/reset-password';
    const reply = (status: number, body: object) => {response.writeHead(status,headers); response.end(JSON.stringify(body));};
    if (!config.recovery) {
      const message = 'Password recovery is currently unavailable. Contact your administrator.';
      if (request.method === 'GET') {
        response.writeHead(503,{...headers,'Content-Type':'text/html; charset=utf-8'});
        response.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Password recovery unavailable</title></head><body><h1>Password recovery unavailable</h1><p>'+message+'</p><p><a href="/auth/local-login">Back to sign in</a></p></body></html>');
      } else reply(503,{error:message});
      return true;
    }
    if (request.method === 'GET') {
      response.writeHead(200,{...headers,'Content-Type':'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options':'nosniff'});
      response.end(page(reset)); return true;
    }
    if (request.method !== 'POST') { reply(405,{error:'Method not allowed'}); return true; }
    if (!allow((sourceIp(request) ?? 'unknown') + ':' + path, reset ? 10 : 5, 15*60*1000)) {
      if (reset) reply(429,{error:'Too many attempts. Try again later.'});
      else reply(200,{message:confirmation});
      return true;
    }
    // JSON prevents simple cross-site forms; Origin and fetch metadata protect browser requests.
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') { reply(415,{error:'Content-Type must be application/json'}); return true; }
    const origin = request.headers.origin;
    if ((origin !== undefined && origin !== (config.recovery?.origin ?? (URL.canParse(config.issuer) ? new URL(config.issuer).origin : undefined))) || request.headers['sec-fetch-site'] === 'cross-site') {
      reply(403,{error:'Request origin rejected'}); return true;
    }
    let body: Record<string,unknown>;
    try {
      let size=0; const chunks: Buffer[]=[];
      for await (const chunk of request) { const data=Buffer.from(chunk); size+=data.length; if(size>8192) throw Error(); chunks.push(data); }
      body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error();
    } catch { reply(400,{error:'Invalid request'}); return true; }
    if (!reset) {
      if (typeof body.email !== 'string' || body.email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) {
        reply(400,{error:'Enter a valid email address.'}); return true;
      }
      const email=body.email.trim().toLowerCase();
      const key='email:'+createHash('sha256').update(email).digest('hex');
      // Delivery is asynchronous so account lookup/provider latency cannot enumerate users.
      if (allow(key,1,60000)) void recovery?.request(email).catch(() => console.error('Password recovery request failed'));
      reply(200,{message:confirmation}); return true;
    }
    if (typeof body.newPassword !== 'string' || body.newPassword.length<12 || body.newPassword.length>1024) {
      reply(400,{error:'Password must be 12–1024 characters.'}); return true;
    }
    if (typeof body.token !== 'string') { reply(400,{error:invalid}); return true; }
    try {
      const ok = await recovery?.reset(body.token,body.newPassword);
      if (!ok) reply(400,{error:invalid});
      else reply(200,{message:'Your password has been reset. You can now sign in with your new password.'});
    } catch { console.error('Password recovery reset failed'); reply(503,{error:'Unable to reset password. Please try again.'}); }
    return true;
  };
}
