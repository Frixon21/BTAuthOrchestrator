import { parseTrustedProxies, type TrustedProxyRange } from "./clientAddress.js";

// CONTRACT-005 §10: TENANT_ID/CLIENT_ID are required only when
// LOCAL_LOGIN=false. This list is the set of variables required
// unconditionally, regardless of LOCAL_LOGIN's value; TENANT_ID/CLIENT_ID
// are appended conditionally in loadConfig below.
const ALWAYS_REQUIRED_VARIABLES = [
  "PORT",
  "PGLITE_DATA_DIR",
  "DB_ENCRYPTION_KEY",
  "COOKIE_SECURE",
  "SERVICE_ISSUER",
  "EMERGENCY_ROTATION_TOKEN",
  "LOCAL_LOGIN",
  "LOCAL_USER_ADMIN_TOKEN",
] as const;

const EMERGENCY_ROTATION_TOKEN_MIN_LENGTH = 32;
// CONTRACT-005 Preconditions: "same format/length rule as CONTRACT-003's
// EMERGENCY_ROTATION_TOKEN".
const LOCAL_USER_ADMIN_TOKEN_MIN_LENGTH = 32;

// CONTRACT-005 §3: optional, validated-if-present, silently defaulted if
// absent — the one deliberate exception in this contract to the project's
// usual required-with-no-implicit-default posture.
const DEFAULT_LOCAL_LOGIN_MAX_FAILED_ATTEMPTS = 10;
const DEFAULT_LOCAL_LOGIN_LOCKOUT_MINUTES = 15;
const DEFAULT_LOCAL_LOGIN_IP_THROTTLE_MAX_ATTEMPTS = 20;
const DEFAULT_LOCAL_LOGIN_IP_THROTTLE_WINDOW_MINUTES = 5;

export interface Config {
  port: number;
  pgliteDataDir: string;
  dbEncryptionKey: string;
  cookieSecure: string;
  // "" when LOCAL_LOGIN=true and TENANT_ID/CLIENT_ID are absent (CONTRACT-005 §10).
  tenantId: string;
  clientId: string;
  issuer: string;
  emergencyRotationToken: string;
  localLogin: boolean;
  allowNewLocalLoginCreation: boolean;
  localUserAdminToken: string;
  localLoginMaxFailedAttempts: number;
  localLoginLockoutMinutes: number;
  localLoginIpThrottleMaxAttempts: number;
  localLoginIpThrottleWindowMinutes: number;
  // CONTRACT-012 §3: optional; empty means forwarded headers are ignored.
  trustedProxies: TrustedProxyRange[];
}

function normalizeLocalLoginFlag(raw: string | undefined): "true" | "false" | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === "true" || value === "false") return value;
  return undefined;
}

// CONTRACT-005 §3's positive-integer rule: base-10, no sign, no decimal
// point, strictly greater than zero. Absent/empty silently defaults; present
// but unparseable/non-positive is recorded in `invalid` (caller fails closed).
function parseOptionalPositiveInteger(
  raw: string | undefined,
  name: string,
  defaultValue: number,
  invalid: string[],
): number {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return defaultValue;
  if (!/^[1-9]\d*$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
    invalid.push(`${name} (must be a positive integer)`);
    return defaultValue;
  }
  return Number(trimmed);
}

export function loadConfig(environment: NodeJS.ProcessEnv): Config {
  const localLoginRaw = environment.LOCAL_LOGIN;
  const normalizedLocalLogin = normalizeLocalLoginFlag(localLoginRaw);

  // CONTRACT-005 §10: "configuration loading reads LOCAL_LOGIN before
  // evaluating whether TENANT_ID/CLIENT_ID are required." If LOCAL_LOGIN
  // itself is missing or does not resolve to a valid true/false value, that
  // is already a separate startup failure (see the LOCAL_LOGIN validity
  // check below); in that case TENANT_ID/CLIENT_ID are conservatively
  // treated as still required, preserving this project's default
  // fail-closed posture rather than guessing at intent. Documented as an
  // implementer judgment call for this edge case, which the contract does
  // not explicitly resolve.
  const entraConfigRequired = normalizedLocalLogin !== "true";

  const requiredVariables: readonly string[] = entraConfigRequired
    ? [...ALWAYS_REQUIRED_VARIABLES, "TENANT_ID", "CLIENT_ID"]
    : ALWAYS_REQUIRED_VARIABLES;

  const missing = requiredVariables.filter(
    (name) => environment[name]?.trim() === "" || environment[name] === undefined,
  );

  const invalid: string[] = [];

  const portValue = environment.PORT?.trim();
  const port = portValue !== undefined && /^\d+$/.test(portValue) ? Number(portValue) : NaN;
  if (
    portValue !== undefined &&
    portValue !== "" &&
    (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
  ) {
    invalid.push("PORT (must be a positive integer between 1 and 65535)");
  }

  const encryptionKeyValue = environment.DB_ENCRYPTION_KEY?.trim();
  if (
    encryptionKeyValue !== undefined &&
    encryptionKeyValue !== "" &&
    !/^[0-9a-f]{64}$/.test(encryptionKeyValue)
  ) {
    invalid.push("DB_ENCRYPTION_KEY (must be exactly 64 lowercase hexadecimal characters)");
  }

  const emergencyRotationTokenValue = environment.EMERGENCY_ROTATION_TOKEN?.trim();
  if (
    emergencyRotationTokenValue !== undefined &&
    emergencyRotationTokenValue !== "" &&
    emergencyRotationTokenValue.length < EMERGENCY_ROTATION_TOKEN_MIN_LENGTH
  ) {
    invalid.push(
      `EMERGENCY_ROTATION_TOKEN (must be at least ${EMERGENCY_ROTATION_TOKEN_MIN_LENGTH} characters)`,
    );
  }

  // CONTRACT-005 Preconditions: "after trimming and case-folding, equals
  // exactly 'true' or 'false' ... no implicit default." A present-but-empty
  // value is already caught by `missing` above; this handles present-but-
  // wrong-value (e.g. "1", "yes", a typo).
  if (
    localLoginRaw !== undefined &&
    localLoginRaw.trim() !== "" &&
    normalizedLocalLogin === undefined
  ) {
    invalid.push('LOCAL_LOGIN (must be exactly "true" or "false", case-insensitive)');
  }

  const localUserAdminTokenValue = environment.LOCAL_USER_ADMIN_TOKEN?.trim();
  if (
    localUserAdminTokenValue !== undefined &&
    localUserAdminTokenValue !== "" &&
    localUserAdminTokenValue.length < LOCAL_USER_ADMIN_TOKEN_MIN_LENGTH
  ) {
    invalid.push(
      `LOCAL_USER_ADMIN_TOKEN (must be at least ${LOCAL_USER_ADMIN_TOKEN_MIN_LENGTH} characters)`,
    );
  }

  const localLoginMaxFailedAttempts = parseOptionalPositiveInteger(
    environment.LOCAL_LOGIN_MAX_FAILED_ATTEMPTS,
    "LOCAL_LOGIN_MAX_FAILED_ATTEMPTS",
    DEFAULT_LOCAL_LOGIN_MAX_FAILED_ATTEMPTS,
    invalid,
  );
  const localLoginLockoutMinutes = parseOptionalPositiveInteger(
    environment.LOCAL_LOGIN_LOCKOUT_MINUTES,
    "LOCAL_LOGIN_LOCKOUT_MINUTES",
    DEFAULT_LOCAL_LOGIN_LOCKOUT_MINUTES,
    invalid,
  );
  const localLoginIpThrottleMaxAttempts = parseOptionalPositiveInteger(
    environment.LOCAL_LOGIN_IP_THROTTLE_MAX_ATTEMPTS,
    "LOCAL_LOGIN_IP_THROTTLE_MAX_ATTEMPTS",
    DEFAULT_LOCAL_LOGIN_IP_THROTTLE_MAX_ATTEMPTS,
    invalid,
  );
  const localLoginIpThrottleWindowMinutes = parseOptionalPositiveInteger(
    environment.LOCAL_LOGIN_IP_THROTTLE_WINDOW_MINUTES,
    "LOCAL_LOGIN_IP_THROTTLE_WINDOW_MINUTES",
    DEFAULT_LOCAL_LOGIN_IP_THROTTLE_WINDOW_MINUTES,
    invalid,
  );

  const trustedProxies = parseTrustedProxies(environment.TRUSTED_PROXIES, invalid);

  if (missing.length > 0 || invalid.length > 0) {
    const details = [
      missing.length > 0
        ? `missing required environment variable(s): ${missing.join(", ")}`
        : undefined,
      invalid.length > 0
        ? `invalid environment variable(s): ${invalid.join(", ")}`
        : undefined,
    ].filter((detail): detail is string => detail !== undefined);

    throw new Error(`Configuration error: ${details.join("; ")}`);
  }

  return {
    port,
    pgliteDataDir: environment.PGLITE_DATA_DIR!.trim(),
    dbEncryptionKey: environment.DB_ENCRYPTION_KEY!.trim(),
    cookieSecure: environment.COOKIE_SECURE!.trim(),
    tenantId: environment.TENANT_ID?.trim() ?? "",
    clientId: environment.CLIENT_ID?.trim() ?? "",
    issuer: environment.SERVICE_ISSUER!.trim(),
    emergencyRotationToken: environment.EMERGENCY_ROTATION_TOKEN!.trim(),
    localLogin: normalizedLocalLogin === "true",
    // Creation is opt-in; absent, empty, or unrecognized values fail closed.
    allowNewLocalLoginCreation:
      normalizeLocalLoginFlag(
        environment.ALLOW_NEW_LOCAL_LOGIN_CREATION ?? environment.AllOW_NEW_LOCAL_LOGIN_CREATION,
      ) === "true",
    localUserAdminToken: environment.LOCAL_USER_ADMIN_TOKEN!.trim(),
    localLoginMaxFailedAttempts,
    localLoginLockoutMinutes,
    localLoginIpThrottleMaxAttempts,
    localLoginIpThrottleWindowMinutes,
    trustedProxies,
  };
}
