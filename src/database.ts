import { constants } from "node:fs";
import { mkdir, open, stat, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";

const REQUIRED_DIRECTORY_MODE = 0o700;
const PROCESS_LOCK_FILENAME = ".btauthorchestrator.lock";

const schemaMigration = `
CREATE TABLE IF NOT EXISTS secrets (
  name text PRIMARY KEY,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signing_keys (
  kid text PRIMARY KEY,
  algorithm text NOT NULL,
  status text NOT NULL CHECK (status IN ('current', 'retired', 'revoked')),
  public_key text NOT NULL,
  private_key_ciphertext bytea NOT NULL,
  private_key_iv bytea NOT NULL,
  private_key_auth_tag bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  revoked_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS signing_keys_one_current
  ON signing_keys ((true))
  WHERE status = 'current';

CREATE TABLE IF NOT EXISTS emergency_rotation_audit (
  id text PRIMARY KEY,
  triggered_at timestamptz NOT NULL DEFAULT now(),
  result text NOT NULL CHECK (result IN ('success', 'failure')),
  triggered_by text,
  source_ip text,
  previous_kid text,
  new_kid text,
  failure_reason text
);

-- CONTRACT-005 §1. password_algorithm/password_cost_n/password_block_size_r/
-- password_parallelization_p/password_key_length are stored per-row (not
-- DB-constrained, application-validated) so a future hashing-parameter or
-- algorithm change never invalidates existing rows.
CREATE TABLE IF NOT EXISTS local_users (
  id text PRIMARY KEY,
  username text UNIQUE NOT NULL,
  email text UNIQUE NOT NULL,
  password_hash bytea NOT NULL,
  password_salt bytea NOT NULL,
  password_algorithm text NOT NULL DEFAULT 'scrypt',
  password_cost_n integer NOT NULL,
  password_block_size_r integer NOT NULL,
  password_parallelization_p integer NOT NULL,
  password_key_length integer NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  failed_login_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);

-- CONTRACT-005 §1/§6. One row per /auth/local-login attempt, success or
-- failure. failure_reason is intentionally more granular than the HTTP
-- response the caller ever sees (§2's enumeration-resistance scheme).
CREATE TABLE IF NOT EXISTS local_login_audit (
  id text PRIMARY KEY,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  username text NOT NULL,
  result text NOT NULL CHECK (result IN ('success', 'failure')),
  failure_reason text,
  source_ip text
);

-- CONTRACT-005 §1/§4/§6 (TASK-016). One row per admin CRUD action (create,
-- update, delete) and per admin-API authentication failure. Read-only
-- actions (GET /admin/users, GET /admin/users/:id) are deliberately not in
-- the action CHECK below and are not audited on success — §6 names exactly
-- these four action values, not a "read" action.
CREATE TABLE IF NOT EXISTS local_user_admin_audit (
  id text PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  action text NOT NULL CHECK (action IN ('create', 'update', 'delete', 'auth_failure')),
  target_user_id text,
  target_username text,
  changed_fields text,
  result text NOT NULL CHECK (result IN ('success', 'failure')),
  failure_reason text,
  actor_label text,
  source_ip text
);

-- CONTRACT-011 §6. How each admin action was authorized and, for console
-- sessions, which local user performed it. Rows written before this
-- migration keep NULL in both. ADD COLUMN IF NOT EXISTS keeps it idempotent.
ALTER TABLE local_user_admin_audit
  ADD COLUMN IF NOT EXISTS auth_method text CHECK (auth_method IN ('token', 'session', 'public'));
ALTER TABLE local_user_admin_audit
  ADD COLUMN IF NOT EXISTS actor_user_id text;

ALTER TABLE local_users ADD COLUMN IF NOT EXISTS recovery_version integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS password_recovery (
  user_id text PRIMARY KEY REFERENCES local_users(id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  email text NOT NULL,
  password_snapshot bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now()
);
`;

export interface DatabaseHandle {
  database: PGlite;
  close(): Promise<void>;
}

export async function prepareDataDirectory(dataDirectory: string): Promise<void> {
  try {
    await mkdir(dataDirectory, { mode: REQUIRED_DIRECTORY_MODE, recursive: true });
  } catch (error) {
    throw new Error(
      `Data directory error for ${dataDirectory}: unable to create directory with mode 0700: ${errorMessage(error)}`,
    );
  }

  let directoryStat;
  try {
    directoryStat = await stat(dataDirectory);
  } catch (error) {
    throw new Error(`Data directory error for ${dataDirectory}: unable to inspect directory: ${errorMessage(error)}`);
  }

  if (!directoryStat.isDirectory()) {
    throw new Error(`Data directory error: ${dataDirectory} is not a directory.`);
  }

  // Windows has no POSIX mode bits or uids (stat reports 0666/0777 and
  // process.getuid is undefined), so the 0700/owner check cannot be expressed
  // here. start.ps1 enforces the equivalent: an owner-only, non-inherited ACL
  // (CONTRACT-007 §5).
  if (process.platform === "win32") {
    return;
  }

  const actualMode = directoryStat.mode & 0o777;
  if (actualMode !== REQUIRED_DIRECTORY_MODE) {
    throw new Error(
      `Data directory permissions error: ${dataDirectory} must have mode 0700 (found ${modeString(actualMode)}). Run: chmod 700 ${dataDirectory}`,
    );
  }

  const currentUid = process.getuid?.();
  if (currentUid === undefined) {
    throw new Error(`Data directory ownership error: unable to determine the running user's uid for ${dataDirectory}.`);
  }
  if (directoryStat.uid !== currentUid) {
    throw new Error(
      `Data directory ownership error: ${dataDirectory} is owned by uid ${directoryStat.uid}, but the process runs as uid ${currentUid}. Run: chown ${currentUid} ${dataDirectory}`,
    );
  }
}

export async function openDatabase(dataDirectory: string): Promise<DatabaseHandle> {
  const lockPath = join(dataDirectory, PROCESS_LOCK_FILENAME);
  const lock = await acquireProcessLock(lockPath);
  let database: PGlite | undefined;

  try {
    database = await PGlite.create(dataDirectory);
    await database.exec(schemaMigration);
  } catch (error) {
    if (database !== undefined) {
      await database.close().catch(() => undefined);
    }
    await releaseProcessLock(lock, lockPath).catch(() => undefined);
    throw error;
  }

  let closed = false;
  return {
    database,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await database.close();
      await releaseProcessLock(lock, lockPath);
    },
  };
}

async function acquireProcessLock(lockPath: string): Promise<FileHandle> {
  try {
    const lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await lock.writeFile(`${process.pid}\n`);
    return lock;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "EEXIST") {
      throw new Error(
        `Single-process error: the data directory is already locked (${lockPath}). Stop the other BTAuthOrchestrator process before starting this one.`,
      );
    }
    throw new Error(`Single-process error: unable to create lock ${lockPath}: ${errorMessage(error)}`);
  }
}

async function releaseProcessLock(lock: FileHandle, lockPath: string): Promise<void> {
  await lock.close();
  await unlink(lockPath);
}

function modeString(mode: number): string {
  return mode.toString(8).padStart(4, "0");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
