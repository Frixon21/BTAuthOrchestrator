import { randomUUID } from "node:crypto";

import type { PGlite } from "@electric-sql/pglite";

import type { ScryptParameters } from "./password.js";

// CONTRACT-005 §1/§9: local_users/local_login_audit live in the same PGlite
// database as CONTRACT-004's tables but are deliberately outside
// SecretsStore's module boundary (see src/password.ts's header comment and
// CONTRACT-005 Interfaces > "Interface to CONTRACT-004"). This module owns
// that boundary for the local-login path only — the admin CRUD API
// (TASK-016) extends this module directly (createUser/listUsers/
// getUserById/updateUser/deleteUser/writeAdminAudit below) rather than
// duplicating a second store.

export interface LocalUserRow {
  id: string;
  username: string;
  email: string;
  passwordHash: Buffer;
  passwordSalt: Buffer;
  passwordAlgorithm: string;
  passwordCostN: number;
  passwordBlockSizeR: number;
  passwordParallelizationP: number;
  passwordKeyLength: number;
  isActive: boolean;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  recoveryVersion?: number;
}

export type LocalLoginFailureReason = "unknown_username" | "bad_password" | "disabled" | "locked";

export interface LocalLoginAuditInput {
  username: string;
  result: "success" | "failure";
  failureReason: LocalLoginFailureReason | null;
  sourceIp: string | null;
}

// --- TASK-016: admin CRUD API (CONTRACT-005 §4) ---

/** Public shape returned by the admin API — never password hash/salt/params. */
export interface LocalUserPublicRecord {
  id: string;
  username: string;
  email: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// Thrown by createUser/updateUser on a unique-constraint collision so
// src/index.ts can map each to its own 409 message (CONTRACT-005 Failure
// behavior: "username already exists" vs. "email already exists").
export class UsernameConflictError extends Error {
  constructor() {
    super("A user with that username already exists.");
    this.name = "UsernameConflictError";
  }
}
export class EmailConflictError extends Error {
  constructor() {
    super("A user with that email already exists.");
    this.name = "EmailConflictError";
  }
}

export interface CreateLocalUserInput {
  // Already normalized (trimmed + lowercased) and format-validated by the
  // caller (src/index.ts) before reaching this store.
  username: string;
  email: string;
  passwordHash: ScryptParameters & { hash: Buffer; salt: Buffer; algorithm: string };
  // CONTRACT-005 §1 `created_by`: operator-self-asserted actedBy, or null.
  createdBy: string | null;
}

export interface UpdateLocalUserInput {
  // Each field undefined means "leave unchanged" (PATCH semantics — at
  // least one of the three must be provided by the caller before calling
  // this function; that "at least one" validation lives in src/index.ts).
  email?: string;
  passwordHash?: ScryptParameters & { hash: Buffer; salt: Buffer; algorithm: string };
  isActive?: boolean;
}

export type AdminAuditAction = "create" | "update" | "delete" | "auth_failure";

export interface AdminAuditInput {
  action: AdminAuditAction;
  targetUserId: string | null;
  targetUsername: string | null;
  // Comma-separated field names actually changed by an `update` (e.g.
  // "email,isActive"). Never the password value itself, even when the
  // field name "password" appears here.
  changedFields: string | null;
  result: "success" | "failure";
  failureReason: string | null;
  actorLabel: string | null;
  sourceIp: string | null;
  // CONTRACT-011 §6. Omitted (stored as NULL) where no admin credential is
  // involved, such as self-service password changes.
  authMethod?: "token" | "session" | "public" | null;
  // The signed-in user's local_users.id, for authMethod 'session' only.
  actorUserId?: string | null;
}

export interface LocalUserStore {
  findByUsername(normalizedUsername: string): Promise<LocalUserRow | undefined>;
  // CONTRACT-005 §2 step 4 (success) / Postconditions: resets lockout state.
  recordSuccessfulLogin(userId: string): Promise<void>;
  // CONTRACT-005 §2 step 4 (bad_password) / §3: increments
  // failed_login_attempts; if the new count reaches maxFailedAttempts, sets
  // locked_until = now() + lockoutMinutes in the same statement/transaction
  // so the row can never observably sit at-threshold-but-unlocked.
  recordFailedPassword(userId: string, maxFailedAttempts: number, lockoutMinutes: number): Promise<void>;
  // CONTRACT-005 §6: best-effort caller's responsibility to catch failures;
  // this function does not swallow errors itself so the caller can apply the
  // log-line backstop (src/index.ts).
  writeLoginAudit(input: LocalLoginAuditInput): Promise<void>;

  // --- Admin CRUD (TASK-016, CONTRACT-005 §4) ---
  // Throws UsernameConflictError/EmailConflictError on a collision (checked
  // inside the same transaction as the insert, so the check-then-insert
  // sequence is atomic against concurrent admin requests).
  createUser(input: CreateLocalUserInput): Promise<LocalUserPublicRecord>;
  listUsers(): Promise<LocalUserPublicRecord[]>;
  getUserById(id: string): Promise<LocalUserPublicRecord | undefined>;
  // Returns undefined if no row has this id (caller maps to 404). Throws
  // EmailConflictError if the new email collides with a different row.
  // changedFields lists exactly which of email/password/isActive changed.
  updateUser(
    id: string,
    input: UpdateLocalUserInput,
  ): Promise<{ record: LocalUserPublicRecord; changedFields: string[] } | undefined>;
  // Returns undefined if no row has this id (caller maps to 404).
  deleteUser(id: string): Promise<{ id: string; username: string } | undefined>;
  writeAdminAudit(input: AdminAuditInput): Promise<void>;
}

interface LocalUserPublicDbRow {
  id: string;
  username: string;
  email: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

function toPublicRecord(row: LocalUserPublicDbRow): LocalUserPublicRecord {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface LocalUserDbRow {
  id: string;
  username: string;
  email: string;
  password_hash: Uint8Array;
  password_salt: Uint8Array;
  password_algorithm: string;
  password_cost_n: number;
  password_block_size_r: number;
  password_parallelization_p: number;
  password_key_length: number;
  is_active: boolean;
  failed_login_attempts: number;
  locked_until: string | null;
  recovery_version: number;
}

export function createLocalUserStore(database: PGlite): LocalUserStore {
  async function findByUsername(normalizedUsername: string): Promise<LocalUserRow | undefined> {
    const result = await database.query<LocalUserDbRow>(
      `SELECT id, username, email, password_hash, password_salt, password_algorithm,
              password_cost_n, password_block_size_r, password_parallelization_p,
              password_key_length, is_active, failed_login_attempts, locked_until, recovery_version
       FROM local_users
       WHERE username = $1`,
      [normalizedUsername],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      recoveryVersion: row.recovery_version,
      id: row.id,
      username: row.username,
      email: row.email,
      passwordHash: Buffer.from(row.password_hash),
      passwordSalt: Buffer.from(row.password_salt),
      passwordAlgorithm: row.password_algorithm,
      passwordCostN: row.password_cost_n,
      passwordBlockSizeR: row.password_block_size_r,
      passwordParallelizationP: row.password_parallelization_p,
      passwordKeyLength: row.password_key_length,
      isActive: row.is_active,
      failedLoginAttempts: row.failed_login_attempts,
      lockedUntil: row.locked_until !== null ? new Date(row.locked_until) : null,
    };
  }

  async function recordSuccessfulLogin(userId: string): Promise<void> {
    await database.query(
      `UPDATE local_users
       SET failed_login_attempts = 0, locked_until = NULL, updated_at = now()
       WHERE id = $1`,
      [userId],
    );
  }

  async function recordFailedPassword(
    userId: string,
    maxFailedAttempts: number,
    lockoutMinutes: number,
  ): Promise<void> {
    await database.transaction(async (transaction) => {
      const updated = await transaction.query<{ failed_login_attempts: number }>(
        `UPDATE local_users
         SET failed_login_attempts = failed_login_attempts + 1, updated_at = now()
         WHERE id = $1
         RETURNING failed_login_attempts`,
        [userId],
      );
      const attempts = updated.rows[0]?.failed_login_attempts;
      if (attempts !== undefined && attempts >= maxFailedAttempts) {
        await transaction.query(
          `UPDATE local_users
           SET locked_until = now() + ($1 || ' minutes')::interval
           WHERE id = $2`,
          [String(lockoutMinutes), userId],
        );
      }
    });
  }

  async function writeLoginAudit(input: LocalLoginAuditInput): Promise<void> {
    await database.query(
      `INSERT INTO local_login_audit (id, username, result, failure_reason, source_ip)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), input.username, input.result, input.failureReason, input.sourceIp],
    );
  }

  // --- Admin CRUD (TASK-016, CONTRACT-005 §4) ---

  async function createUser(input: CreateLocalUserInput): Promise<LocalUserPublicRecord> {
    return database.transaction(async (transaction) => {
      // Check-then-insert inside one transaction, mirroring the existing
      // signing_keys "current" check-then-insert pattern (src/secrets.ts) —
      // atomic against concurrent admin requests, and lets us distinguish
      // which field collided (the unique-index violation itself wouldn't).
      const conflicts = await transaction.query<{ username: string; email: string }>(
        `SELECT username, email FROM local_users WHERE username = $1 OR email = $2 LIMIT 2`,
        [input.username, input.email],
      );
      for (const row of conflicts.rows) {
        if (row.username === input.username) throw new UsernameConflictError();
      }
      for (const row of conflicts.rows) {
        if (row.email === input.email) throw new EmailConflictError();
      }

      const id = randomUUID();
      const result = await transaction.query<LocalUserPublicDbRow>(
        `INSERT INTO local_users (
           id, username, email, password_hash, password_salt, password_algorithm,
           password_cost_n, password_block_size_r, password_parallelization_p,
           password_key_length, is_active, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11)
         RETURNING id, username, email, is_active, created_at, updated_at`,
        [
          id,
          input.username,
          input.email,
          input.passwordHash.hash,
          input.passwordHash.salt,
          input.passwordHash.algorithm,
          input.passwordHash.costN,
          input.passwordHash.blockSizeR,
          input.passwordHash.parallelizationP,
          input.passwordHash.keyLength,
          input.createdBy,
        ],
      );
      return toPublicRecord(result.rows[0]!);
    });
  }

  async function listUsers(): Promise<LocalUserPublicRecord[]> {
    const result = await database.query<LocalUserPublicDbRow>(
      `SELECT id, username, email, is_active, created_at, updated_at
       FROM local_users
       ORDER BY created_at, id`,
    );
    return result.rows.map(toPublicRecord);
  }

  async function getUserById(id: string): Promise<LocalUserPublicRecord | undefined> {
    const result = await database.query<LocalUserPublicDbRow>(
      `SELECT id, username, email, is_active, created_at, updated_at
       FROM local_users
       WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toPublicRecord(row);
  }

  async function updateUser(
    id: string,
    input: UpdateLocalUserInput,
  ): Promise<{ record: LocalUserPublicRecord; changedFields: string[] } | undefined> {
    return database.transaction(async (transaction) => {
      const existing = await transaction.query<{ id: string }>(
        `SELECT id FROM local_users WHERE id = $1`,
        [id],
      );
      if (existing.rows[0] === undefined) return undefined;

      const changedFields: string[] = [];
      const setClauses: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (input.email !== undefined) {
        const conflict = await transaction.query<{ id: string }>(
          `SELECT id FROM local_users WHERE email = $1 AND id <> $2`,
          [input.email, id],
        );
        if (conflict.rows[0] !== undefined) throw new EmailConflictError();
        setClauses.push(`email = $${paramIndex++}`);
        values.push(input.email);
        changedFields.push("email");
      }

      if (input.passwordHash !== undefined) {
        setClauses.push(`password_hash = $${paramIndex++}`);
        values.push(input.passwordHash.hash);
        setClauses.push(`password_salt = $${paramIndex++}`);
        values.push(input.passwordHash.salt);
        setClauses.push(`password_algorithm = $${paramIndex++}`);
        values.push(input.passwordHash.algorithm);
        setClauses.push(`password_cost_n = $${paramIndex++}`);
        values.push(input.passwordHash.costN);
        setClauses.push(`password_block_size_r = $${paramIndex++}`);
        values.push(input.passwordHash.blockSizeR);
        setClauses.push(`password_parallelization_p = $${paramIndex++}`);
        values.push(input.passwordHash.parallelizationP);
        setClauses.push(`password_key_length = $${paramIndex++}`);
        values.push(input.passwordHash.keyLength);
        // CONTRACT-005 Postconditions: a password change resets lockout state.
        setClauses.push(`failed_login_attempts = 0`);
        setClauses.push(`locked_until = NULL`);
        changedFields.push("password");
      }

      if (input.isActive !== undefined) {
        setClauses.push(`is_active = $${paramIndex++}`);
        values.push(input.isActive);
        changedFields.push("isActive");
      }

      setClauses.push(`updated_at = now()`);
      values.push(id);

      const result = await transaction.query<LocalUserPublicDbRow>(
        `UPDATE local_users SET ${setClauses.join(", ")}
         WHERE id = $${paramIndex}
         RETURNING id, username, email, is_active, created_at, updated_at`,
        values,
      );
      // Email/password changes and disable operations permanently retire outstanding
      // links in the same transaction. A later email revert or re-enable must not
      // revive a link sent under an earlier account state. Existing JWT policy is unchanged.
      if (input.email !== undefined || input.passwordHash !== undefined || input.isActive === false) {
        await transaction.query('DELETE FROM password_recovery WHERE user_id=$1', [id]);
      }
      return { record: toPublicRecord(result.rows[0]!), changedFields };
    });
  }

  async function deleteUser(id: string): Promise<{ id: string; username: string } | undefined> {
    const result = await database.query<{ id: string; username: string }>(
      `DELETE FROM local_users WHERE id = $1 RETURNING id, username`,
      [id],
    );
    return result.rows[0];
  }

  async function writeAdminAudit(input: AdminAuditInput): Promise<void> {
    await database.query(
      `INSERT INTO local_user_admin_audit (
         id, action, target_user_id, target_username, changed_fields,
         result, failure_reason, actor_label, source_ip, auth_method, actor_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        randomUUID(),
        input.action,
        input.targetUserId,
        input.targetUsername,
        input.changedFields,
        input.result,
        input.failureReason,
        input.actorLabel,
        input.sourceIp,
        input.authMethod ?? null,
        input.actorUserId ?? null,
      ],
    );
  }

  return {
    findByUsername,
    recordSuccessfulLogin,
    recordFailedPassword,
    writeLoginAudit,
    createUser,
    listUsers,
    getUserById,
    updateUser,
    deleteUser,
    writeAdminAudit,
  };
}
