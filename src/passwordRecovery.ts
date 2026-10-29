import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { hashPassword } from "./password.js";

export interface RecoveryConfig { origin: string; sender: string; apiKey: string }
export interface RecoveryMail { to: string; link: string }
export type MailDelivery = (mail: RecoveryMail) => Promise<void>;
export function loadRecoveryConfig(env: NodeJS.ProcessEnv): RecoveryConfig | undefined {
  const values = [env.PASSWORD_RESET_PUBLIC_ORIGIN, env.PASSWORD_RESET_FROM, env.RESEND_API_KEY];
  if (values.every(value => !value?.trim())) return undefined;
  if (values.some(value => !value?.trim())) throw new Error("Recovery requires PASSWORD_RESET_PUBLIC_ORIGIN, PASSWORD_RESET_FROM and RESEND_API_KEY");
  const origin = new URL(values[0]!.trim());
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error("PASSWORD_RESET_PUBLIC_ORIGIN must be a trusted HTTP(S) origin without path, credentials, query or fragment");
  const sender = values[1]!.trim();
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(sender)) throw new Error("PASSWORD_RESET_FROM must be an email address");
  return { origin: origin.origin, sender, apiKey: values[2]!.trim() };
}
export function resendDelivery(config: RecoveryConfig): MailDelivery {
  return async ({ to, link }) => {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: 'Bearer ' + config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.sender, to: [to], subject: 'Reset your BTAuth password',
        text: 'Use this link within 30 minutes to reset your password: ' + link + '\nIf you did not request this, ignore this email.' }),
    });
    // Provider responses can contain recipient data. Never log or expose them.
    if (!response.ok) { await response.body?.cancel(); throw new Error('Mail delivery failed'); }
    await response.body?.cancel();
  };
}
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
export interface PasswordRecovery {
  request(email: string): Promise<void>;
  drain(): Promise<void>;
  reset(token: string, password: string): Promise<boolean>;
  sessionVersion(id: string): Promise<number>;
  acceptSession(id: string, version: unknown): Promise<boolean>;
}
export function createPasswordRecovery(database: PGlite, config?: RecoveryConfig, delivery?: MailDelivery): PasswordRecovery {
  const send = delivery ?? (config ? resendDelivery(config) : undefined);
  async function sessionVersion(id: string): Promise<number> {
    const result = await database.query<{ recovery_version: number }>('SELECT recovery_version FROM local_users WHERE id=$1', [id]);
    return result.rows[0]?.recovery_version ?? -1;
  }
  const pending = new Set<Promise<void>>();
  async function requestMail(email: string): Promise<void> {
    if (!config || !send) return;
    const token = randomBytes(32).toString('base64url');
    const hash = digest(token);
    // Atomic cooldown and token replacement; no account-dependent response.
    const result = await database.query<{ user_id: string; email: string }>(
      `INSERT INTO password_recovery (user_id,token_hash,email,password_snapshot,expires_at)
       SELECT id,$1,email,password_hash,now()+interval '30 minutes' FROM local_users WHERE lower(email)=lower($2) AND is_active=true
         AND (SELECT count(*) FROM local_users WHERE lower(email)=lower($2))=1
       ON CONFLICT (user_id) DO UPDATE SET token_hash=excluded.token_hash,email=excluded.email,
         password_snapshot=excluded.password_snapshot,expires_at=excluded.expires_at,requested_at=now()
       WHERE password_recovery.requested_at < now()-interval '1 minute' RETURNING user_id,email`, [hash,email]);
    if (!result.rows.length) return;
    try { await send({ to: result.rows[0].email, link: config.origin + '/auth/reset-password#token=' + token }); }
    catch {
      // Delete only our failed delivery, never a replacement from another request.
      await database.query('DELETE FROM password_recovery WHERE token_hash=$1', [hash]);
      throw new Error('Recovery delivery failed');
    }
  }
  return {
    sessionVersion,
    async acceptSession(id, version) { return (version ?? 0) === await sessionVersion(id); },
    request(email) {
      const task = requestMail(email);
      pending.add(task);
      void task.then(() => pending.delete(task), () => pending.delete(task));
      return task;
    },
    async drain() { await Promise.allSettled([...pending]); },
    async reset(token, password) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token) || password.length < 12 || password.length > 1024) return false;
      const hash = digest(token);
      const candidate = await database.query('SELECT user_id FROM password_recovery WHERE token_hash=$1 AND expires_at>now()', [hash]);
      if (!candidate.rows.length) return false;
      const next = await hashPassword(password);
      return database.transaction(async tx => {
        const consumed = await tx.query<{ user_id: string; email: string; password_snapshot: Uint8Array }>(
          `DELETE FROM password_recovery r WHERE token_hash=$1 AND expires_at>now()
           AND EXISTS (SELECT 1 FROM local_users u WHERE u.id=r.user_id AND u.is_active=true
             AND u.email=r.email AND u.password_hash=r.password_snapshot)
           RETURNING user_id,email,password_snapshot`, [hash]);
        const row = consumed.rows[0];
        if (!row) return false;
        const updated = await tx.query(`UPDATE local_users SET password_hash=$1,password_salt=$2,password_algorithm=$3,
          password_cost_n=$4,password_block_size_r=$5,password_parallelization_p=$6,password_key_length=$7,
          failed_login_attempts=0,locked_until=NULL,updated_at=now(),recovery_version=recovery_version+1
          WHERE id=$8 AND email=$9 AND password_hash=$10 AND is_active=true RETURNING id`,
          [next.hash,next.salt,next.algorithm,next.costN,next.blockSizeR,next.parallelizationP,next.keyLength,row.user_id,row.email,row.password_snapshot]);
        if (updated.rows.length !== 1) return false;
        await tx.query(`INSERT INTO local_user_admin_audit (id,action,target_user_id,changed_fields,result,actor_label)
          VALUES ($1,'update',$2,'password','success','email-recovery')`, [randomUUID(),row.user_id]);
        return true;
      });
    },
  };
}
