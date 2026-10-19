import { generateKeyPair, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type RequestListener } from "node:http";
import { promisify } from "node:util";

import { exportJWK, importSPKI } from "jose";

import { loadConfig, type Config } from "./config.js";
import { createApiDocsHandler } from "./apiDocs.js";
import { openDatabase, prepareDataDirectory, type DatabaseHandle } from "./database.js";
import { createIpThrottle, type IpThrottle } from "./ipThrottle.js";
import {
  describeError,
  describeErrorWithStack,
  installConsoleFormatting,
  installProcessErrorLogging,
  withRequestMonitoring,
} from "./logging.js";
import {
  createLocalUserStore,
  EmailConflictError,
  UsernameConflictError,
  type AdminAuditInput,
  type LocalUserStore,
} from "./localUsers.js";
import {
  computeCodeChallenge,
  createHandshakeStore,
  EntraDiscoveryCache,
  EntraUnreachableError,
  exchangeAuthorizationCode,
  generateCodeVerifier,
  generateOpaqueToken,
  IdentityClaimMissingError,
  IdTokenValidationError,
  TokenExchangeError,
  validateIdToken,
  type EntraDiscoveryDocument,
} from "./oidc.js";
import { deriveDummyHashForTimingParity, hashPassword, verifyPassword } from "./password.js";
import { createSecretsStore, type SecretsStore } from "./secrets.js";
import { mintSessionToken, nextLocalMidnightEpochSeconds } from "./tokens.js";

const generateKeyPairAsync = promisify(generateKeyPair);

const SESSION_COOKIE_NAME = "bt_session";
// Fixed by CONTRACT-001 §7 ("the parent domain shared by all consuming
// apps"); not operator-configurable in this milestone.
const SESSION_COOKIE_DOMAIN = ".biztechro.com";

const ENTRA_UNREACHABLE_MESSAGE =
  "Unable to reach the organization's sign-in service right now. Try again in a few minutes.";
const SIGN_IN_CANCELLED_MESSAGE = "Sign-in was cancelled or denied.";
const SIGN_IN_EXPIRED_MESSAGE = "Your sign-in attempt has expired or is no longer valid. Please start again.";
const SIGN_IN_INCOMPLETE_MESSAGE = "Your sign-in attempt could not be completed. Please start again.";
const GENERIC_SERVER_ERROR_MESSAGE = "Something went wrong signing you in; this has been logged.";

// CONTRACT-003: a generous but bounded cap on the optional JSON request body
// (`{ "triggeredBy"?: string }`) for the emergency-rotation trigger, to avoid
// buffering an unbounded request body in memory before authentication is even
// checked. Not specified by the contract; a narrow implementation judgment
// call, flagged in the handoff.
const EMERGENCY_ROTATION_BODY_LIMIT_BYTES = 16_384;
const EMERGENCY_ROTATION_RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

// CONTRACT-005: same defensive-cap posture as
// EMERGENCY_ROTATION_BODY_LIMIT_BYTES above (not specified by the contract;
// a narrow implementation judgment call, see the handoff's "Assumptions and
// deviations"). Unlike the emergency-rotation body (fully optional), the
// local-login body carries the required username/password, so exceeding
// this cap is treated as the same 400 "malformed request" outcome as any
// other missing/invalid body, never a 500.
const LOCAL_LOGIN_BODY_LIMIT_BYTES = 16_384;

const LOCAL_LOGIN_MISSING_FIELDS_MESSAGE = "username and password are required";
const LOCAL_LOGIN_INVALID_CREDENTIALS_MESSAGE = "Invalid username or password.";
const LOCAL_LOGIN_DISABLED_MESSAGE = "This account has been disabled.";
const LOCAL_LOGIN_TOO_MANY_ATTEMPTS_MESSAGE = "Too many sign-in attempts. Try again later.";
const LOCAL_LOGIN_GENERIC_SERVER_ERROR_MESSAGE =
  "Something went wrong signing you in; this has been logged.";

const LOCAL_LOGIN_RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
};

// CONTRACT-005 §11: the minimal HTML login form served at
// GET /auth/local-login. This is a PURE client-side wrapper around the
// existing POST /auth/local-login JSON endpoint above — every
// credential-verification decision (unknown user / bad password / disabled /
// locked / success) is made exclusively by handleLocalLogin via the fetch()
// call below. There is no username/password comparison, no hashing, and no
// server-side rendering of the outcome anywhere in this constant or its
// route handler: the page's own inline <script> reads the JSON response
// handleLocalLogin already produced and displays it verbatim. Deliberately
// unstyled/minimal (no CSS framework, no branding, no responsive design) per
// CONTRACT-005 §11 and NOTES.md's "no UI polish" posture.
const LOCAL_LOGIN_FORM_RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
};
const LOCAL_LOGIN_FORM_HTML = `<!doctype html>
<html>
<head><title>Local sign-in</title></head>
<body>
<h1>Local sign-in</h1>
<p><a href="/auth/local-register">Create an account</a></p>
<form id="login-form">
  <div>
    <label for="username">Username</label>
    <input type="text" id="username" name="username" autocomplete="username" required>
  </div>
  <div>
    <label for="password">Password</label>
    <input type="password" id="password" name="password" autocomplete="current-password" required>
  </div>
  <button type="submit">Sign in</button>
</form>
<p id="error-message"></p>
<p id="success-message" hidden>You're signed in.</p>
<script>
(function () {
  var form = document.getElementById("login-form");
  var errorMessage = document.getElementById("error-message");
  var successMessage = document.getElementById("success-message");

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    errorMessage.textContent = "";

    var username = document.getElementById("username").value;
    var password = document.getElementById("password").value;

    fetch("/auth/local-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username, password: password }),
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { ok: response.ok, body: body };
        });
      })
      .then(function (result) {
        if (result.ok) {
          form.hidden = true;
          successMessage.hidden = false;
        } else {
          errorMessage.textContent =
            result.body && typeof result.body.error === "string"
              ? result.body.error
              : "Sign-in failed.";
        }
      })
      .catch(function () {
        errorMessage.textContent = "Sign-in failed.";
      });
  });
})();
</script>
</body>
</html>
`;

const LOCAL_REGISTER_FORM_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Create an account</title></head>
<body>
<h1>Create an account</h1>
<form id="create-user-form">
  <div>
    <label for="username">Username</label>
    <input id="username" name="username" autocomplete="username" minlength="3" maxlength="64" required>
  </div>
  <div>
    <label for="email">Email</label>
    <input type="email" id="email" name="email" autocomplete="email" required>
  </div>
  <div>
    <label for="password">Password (at least 12 characters)</label>
    <input type="password" id="password" name="password" autocomplete="new-password" minlength="12" required>
  </div>
  <button type="submit" id="create-user-button">Create account</button>
</form>
<p id="message" role="status" aria-live="polite"></p>
<p><a href="/auth/local-login">Sign in</a></p>
<!-- LOCAL_USERS_LIST -->
<script>
(function () {
  var form = document.getElementById("create-user-form");
  var button = document.getElementById("create-user-button");
  var message = document.getElementById("message");
  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    button.disabled = true;
    message.textContent = "";
    try {
      var response = await fetch("/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: document.getElementById("username").value,
          email: document.getElementById("email").value,
          password: document.getElementById("password").value
        })
      });
      var result = await response.json();
      if (response.ok) {
        form.reset();
        form.hidden = true;
        message.textContent = "Your account has been created. You can now sign in.";
        var row = document.createElement("tr");
        var usernameCell = document.createElement("td");
        var statusCell = document.createElement("td");
        usernameCell.textContent = result.username;
        statusCell.textContent = result.isActive ? "Active" : "Disabled";
        row.appendChild(usernameCell);
        row.appendChild(statusCell);
        document.getElementById("local-users-body").appendChild(row);
        document.getElementById("local-users-empty").hidden = true;
      } else {
        message.textContent = result.error || "Unable to create an account.";
      }
    } catch (error) {
      message.textContent = "Unable to reach the service. Please try again.";
    } finally {
      button.disabled = false;
    }
  });
})();
</script>
</body>
</html>`;

// CONTRACT-005 §4/Interfaces: admin CRUD API for /admin/users*. Same
// defensive body-size-cap posture as EMERGENCY_ROTATION_BODY_LIMIT_BYTES/
// LOCAL_LOGIN_BODY_LIMIT_BYTES above (not contract-specified).
const ADMIN_USERS_BODY_LIMIT_BYTES = 16_384;
// CONTRACT-005 Interfaces: "All admin responses include Cache-Control:
// no-store" — same posture as CONTRACT-003's endpoint.
const ADMIN_USERS_RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
const ADMIN_UNAUTHORIZED_MESSAGE = "Unauthorized";
const ADMIN_NOT_FOUND_MESSAGE = "No such user.";
const ADMIN_GENERIC_SERVER_ERROR_MESSAGE = "Unable to complete the request.";

// CONTRACT-005 "Resolved decisions" #4: username 3-64 chars, lowercase
// ASCII letters/digits/'.'/'-'/'_' (application-validated, not DB-enforced).
const USERNAME_REGEX = /^[a-z0-9._-]{3,64}$/;
// CONTRACT-005 "Resolved decisions" #4: minimum password length 12
// characters, no additional complexity rule.
const ADMIN_MIN_PASSWORD_LENGTH = 12;
// Email format is not prescribed further by CONTRACT-005 beyond "identity
// fields satisfying CONTRACT-001's claim shape" — a loose, permissive
// shape check (must contain "@" and a "."), not a full RFC 5322 validator,
// plus a defensive length cap. Implementation judgment call, flagged in the
// handoff, same posture as CONTRACT-005 not otherwise constraining email
// syntax.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ADMIN_EMAIL_MAX_LENGTH = 254;

type HandlerResult = { status: number; headers: Record<string, string>; body: string };

function adminUnauthorized(): HandlerResult {
  return {
    status: 401,
    headers: ADMIN_USERS_RESPONSE_HEADERS,
    body: JSON.stringify({ error: ADMIN_UNAUTHORIZED_MESSAGE }),
  };
}

function adminNotFound(): HandlerResult {
  return {
    status: 404,
    headers: ADMIN_USERS_RESPONSE_HEADERS,
    body: JSON.stringify({ error: ADMIN_NOT_FOUND_MESSAGE }),
  };
}

function adminBadRequest(message: string): HandlerResult {
  return { status: 400, headers: ADMIN_USERS_RESPONSE_HEADERS, body: JSON.stringify({ error: message }) };
}

function adminServerError(): HandlerResult {
  return {
    status: 500,
    headers: ADMIN_USERS_RESPONSE_HEADERS,
    body: JSON.stringify({ error: ADMIN_GENERIC_SERVER_ERROR_MESSAGE }),
  };
}

type FieldValidation<T> = { value: T } | { error: string };

function validateAdminUsername(raw: unknown): FieldValidation<string> {
  if (typeof raw !== "string") return { error: "username is required and must be a string" };
  const normalized = raw.trim().toLowerCase();
  if (!USERNAME_REGEX.test(normalized)) {
    return {
      error:
        "username must be 3-64 characters, using only lowercase letters, digits, '.', '-', or '_'",
    };
  }
  return { value: normalized };
}

function validateAdminEmail(raw: unknown): FieldValidation<string> {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { error: "email is required and must be a non-empty string" };
  }
  const trimmed = raw.trim();
  if (trimmed.length > ADMIN_EMAIL_MAX_LENGTH || !EMAIL_REGEX.test(trimmed)) {
    return { error: "email must be a valid email address" };
  }
  return { value: trimmed };
}

function validateAdminPassword(raw: unknown): FieldValidation<string> {
  if (typeof raw !== "string") return { error: "password is required and must be a string" };
  if (raw.length < ADMIN_MIN_PASSWORD_LENGTH) {
    return { error: `password must be at least ${ADMIN_MIN_PASSWORD_LENGTH} characters` };
  }
  return { value: raw };
}

// CONTRACT-005 Interfaces: actedBy is an operator-self-asserted, unverified
// label carried into the audit row only — same caveat CONTRACT-003 already
// accepts for triggeredBy. A missing/non-string/empty value is simply null,
// never a request failure.
function extractActedBy(parsedBody: unknown): string | null {
  if (typeof parsedBody !== "object" || parsedBody === null) return null;
  const actedBy = (parsedBody as Record<string, unknown>).actedBy;
  return typeof actedBy === "string" && actedBy.trim() !== "" ? actedBy : null;
}

// Log-line text only (never returned to a client or stored): includes the
// error code and cause chain so failures like Node's "fetch failed" show
// their underlying reason.
function errorMessage(error: unknown): string {
  return describeError(error);
}

function extractBearerToken(headerValue: string | string[] | undefined): string | null {
  if (typeof headerValue !== "string") return null;
  const prefix = "Bearer ";
  if (!headerValue.startsWith(prefix)) return null;
  const token = headerValue.slice(prefix.length);
  return token.length > 0 ? token : null;
}

// Constant-time comparison per CONTRACT-003 §2: unequal lengths are an
// immediate mismatch without a data-dependent comparison of contents; equal
// lengths are compared via crypto.timingSafeEqual, never `===`.
function constantTimeTokenMatches(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (candidateBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(candidateBuffer, expectedBuffer);
}

async function readRequestBody(request: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bufferChunk: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bufferChunk.length;
    if (size > limitBytes) {
      throw new Error("Request body exceeds the maximum accepted size.");
    }
    chunks.push(bufferChunk);
  }
  return Buffer.concat(chunks);
}

// CONTRACT-003 Failure behavior: a missing/empty/non-string `triggeredBy` (or
// an unparseable body) is stored as null and never treated as a failure —
// this field is a convenience label only, never part of the authorization
// decision.
function extractTriggeredBy(bodyText: string): string | null {
  if (bodyText.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "triggeredBy" in parsed &&
      typeof (parsed as { triggeredBy?: unknown }).triggeredBy === "string" &&
      (parsed as { triggeredBy: string }).triggeredBy !== ""
    ) {
      return (parsed as { triggeredBy: string }).triggeredBy;
    }
    return null;
  } catch {
    return null;
  }
}

// CONTRACT-003 Interfaces: best-effort proxy-forwarded client address (first
// X-Forwarded-For entry) when reachable via the configured reverse proxy,
// otherwise the raw socket peer address. Audit metadata only.
function extractSourceIp(request: IncomingMessage): string | null {
  const forwardedFor = request.headers["x-forwarded-for"];
  const forwardedValue = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  if (typeof forwardedValue === "string" && forwardedValue.trim() !== "") {
    return forwardedValue.split(",")[0]!.trim();
  }
  return request.socket.remoteAddress ?? null;
}

function renderHtml(status: number, title: string, message: string): { status: number; headers: Record<string, string>; body: string } {
  return {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: `<!doctype html><html><head><title>${title}</title></head><body><p>${message}</p></body></html>`,
  };
}

function buildSetCookieHeader(token: string, iat: number, exp: number, secure: boolean): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${token}`,
    `Domain=${SESSION_COOKIE_DOMAIN}`,
    "Path=/",
    `Expires=${new Date(exp * 1000).toUTCString()}`,
    `Max-Age=${exp - iat}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function createRequestHandler(
  secretsStore: SecretsStore,
  config: Config,
  localUserStore: LocalUserStore,
): RequestListener {
  const handleApiDocs = createApiDocsHandler(config);
  const handshakeStore = createHandshakeStore();
  const discoveryCache = new EntraDiscoveryCache();
  const ipThrottle: IpThrottle = createIpThrottle(
    config.localLoginIpThrottleMaxAttempts,
    config.localLoginIpThrottleWindowMinutes * 60_000,
  );

  async function handleLogin(): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    let discovery: EntraDiscoveryDocument;
    try {
      discovery = await discoveryCache.getDiscoveryDocument(config.tenantId);
    } catch (error) {
      console.error(`Entra discovery fetch failed during login initiation: ${errorMessage(error)}`);
      return renderHtml(502, "Sign-in unavailable", ENTRA_UNREACHABLE_MESSAGE);
    }

    const state = generateOpaqueToken();
    const nonce = generateOpaqueToken();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = computeCodeChallenge(codeVerifier);
    handshakeStore.create(state, nonce, codeVerifier);

    const redirectUri = `${config.issuer}/auth/callback`;
    const authorizeUrl = new URL(discovery.authorization_endpoint);
    authorizeUrl.searchParams.set("client_id", config.clientId);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", "openid profile email");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("nonce", nonce);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    return { status: 302, headers: { Location: authorizeUrl.toString() }, body: "" };
  }

  async function handleCallback(
    url: URL,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const params = url.searchParams;

    const errorParam = params.get("error");
    if (errorParam !== null) {
      const description = params.get("error_description");
      console.error(
        `Entra returned an authorization error at the callback: ${errorParam}${description !== null ? ` (${description})` : ""}`,
      );
      return renderHtml(400, "Sign-in cancelled", SIGN_IN_CANCELLED_MESSAGE);
    }

    const state = params.get("state");
    const entry = state !== null ? handshakeStore.consume(state) : undefined;
    if (entry === undefined) {
      return renderHtml(400, "Sign-in expired", SIGN_IN_EXPIRED_MESSAGE);
    }

    const code = params.get("code");
    if (code === null || code === "") {
      return renderHtml(400, "Sign-in incomplete", SIGN_IN_INCOMPLETE_MESSAGE);
    }

    let discovery: EntraDiscoveryDocument;
    try {
      discovery = await discoveryCache.getDiscoveryDocument(config.tenantId);
    } catch (error) {
      console.error(`Entra discovery fetch failed during callback handling: ${errorMessage(error)}`);
      return renderHtml(502, "Sign-in unavailable", ENTRA_UNREACHABLE_MESSAGE);
    }

    let clientSecret: string;
    try {
      clientSecret = await secretsStore.getSecret("CLIENT_SECRET");
    } catch (error) {
      console.error(`Unable to load CLIENT_SECRET:\n${describeErrorWithStack(error)}`);
      return renderHtml(500, "Sign-in error", GENERIC_SERVER_ERROR_MESSAGE);
    }

    const redirectUri = `${config.issuer}/auth/callback`;

    let idToken: string;
    try {
      idToken = await exchangeAuthorizationCode({
        tokenEndpoint: discovery.token_endpoint,
        clientId: config.clientId,
        clientSecret,
        code,
        redirectUri,
        codeVerifier: entry.codeVerifier,
      });
    } catch (error) {
      if (error instanceof EntraUnreachableError) {
        console.error(`Entra token exchange unreachable: ${errorMessage(error)}`);
        return renderHtml(502, "Sign-in unavailable", ENTRA_UNREACHABLE_MESSAGE);
      }
      if (error instanceof TokenExchangeError) {
        console.error(`Entra token exchange rejected the request: ${errorMessage(error)}`);
        return renderHtml(400, "Sign-in incomplete", SIGN_IN_INCOMPLETE_MESSAGE);
      }
      console.error(`Unexpected token exchange failure:\n${describeErrorWithStack(error)}`);
      return renderHtml(500, "Sign-in error", GENERIC_SERVER_ERROR_MESSAGE);
    }

    let claims: { oid: string; email: string; preferredUsername: string };
    try {
      const remoteJwks = discoveryCache.getRemoteJwks(discovery.jwks_uri);
      claims = await validateIdToken({
        idToken,
        remoteJwks,
        expectedIssuer: discovery.issuer,
        expectedAudience: config.clientId,
        expectedNonce: entry.nonce,
      });
    } catch (error) {
      if (error instanceof EntraUnreachableError) {
        console.error(`Entra JWKS fetch failed during ID token validation: ${errorMessage(error)}`);
        return renderHtml(502, "Sign-in unavailable", ENTRA_UNREACHABLE_MESSAGE);
      }
      if (error instanceof IdentityClaimMissingError) {
        console.error(`Entra ID token was missing a required identity claim: ${errorMessage(error)}`);
        return renderHtml(500, "Sign-in error", GENERIC_SERVER_ERROR_MESSAGE);
      }
      if (error instanceof IdTokenValidationError) {
        console.error(`ID token validation failed: ${errorMessage(error)}`);
        return renderHtml(400, "Sign-in incomplete", SIGN_IN_INCOMPLETE_MESSAGE);
      }
      console.error(`Unexpected ID token validation failure:\n${describeErrorWithStack(error)}`);
      return renderHtml(500, "Sign-in error", GENERIC_SERVER_ERROR_MESSAGE);
    }

    try {
      const signingKey = await secretsStore.getCurrentSigningKey();
      const now = new Date();
      const token = await mintSessionToken(
        { sub: claims.oid, email: claims.email, upn: claims.preferredUsername },
        signingKey,
        config.issuer,
        now,
      );
      const iat = Math.floor(now.getTime() / 1_000);
      const exp = nextLocalMidnightEpochSeconds(now);
      const cookieSecure = config.cookieSecure.trim().toLowerCase() === "true";
      return {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Set-Cookie": buildSetCookieHeader(token, iat, exp, cookieSecure),
        },
        body: "<!doctype html><html><head><title>Signed in</title></head><body><p>You're signed in. You may close this window.</p></body></html>",
      };
    } catch (error) {
      console.error(`Session token minting failed:\n${describeErrorWithStack(error)}`);
      return renderHtml(500, "Sign-in error", GENERIC_SERVER_ERROR_MESSAGE);
    }
  }

  async function writeEmergencyRotationFailureAudit(input: {
    triggeredBy: string | null;
    sourceIp: string | null;
    failureReason: string;
  }): Promise<void> {
    try {
      await secretsStore.recordEmergencyRotationFailure(input);
    } catch (error) {
      // CONTRACT-003 Failure behavior: never block the caller's response on
      // this write; fall back to a server-side log-line backstop naming only
      // a timestamp and failure category — never the credential value or any
      // secret material.
      console.error(
        `Emergency rotation audit write failed; log-line backstop: timestamp=${new Date().toISOString()} failureReason=${input.failureReason}: ${errorMessage(error)}`,
      );
    }
  }

  async function handleEmergencyRotateKeys(
    request: IncomingMessage,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const sourceIp = extractSourceIp(request);

    let bodyText = "";
    try {
      bodyText = (await readRequestBody(request, EMERGENCY_ROTATION_BODY_LIMIT_BYTES)).toString("utf8");
    } catch (error) {
      // An oversized/unreadable body is not an authorization decision; it
      // just means triggeredBy is unavailable for this attempt.
      console.error(`Emergency rotation request body could not be read: ${errorMessage(error)}`);
    }
    const triggeredBy = extractTriggeredBy(bodyText);

    const token = extractBearerToken(request.headers.authorization);
    if (token === null || !constantTimeTokenMatches(token, config.emergencyRotationToken)) {
      await writeEmergencyRotationFailureAudit({ triggeredBy, sourceIp, failureReason: "bad_credential" });
      return {
        status: 401,
        headers: EMERGENCY_ROTATION_RESPONSE_HEADERS,
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }

    try {
      const kid = randomUUID();
      const { publicKey, privateKey } = await generateKeyPairAsync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      const result = await secretsStore.rotateSigningKeyEmergency(
        { kid, algorithm: "RS256", publicKeyPem: publicKey, privateKeyPem: privateKey },
        { triggeredBy, sourceIp },
      );
      const rotatedAt = new Date();
      return {
        status: 200,
        headers: EMERGENCY_ROTATION_RESPONSE_HEADERS,
        body: JSON.stringify({
          status: "rotated",
          previousKid: result.previousKid,
          newKid: result.newKid,
          rotatedAt: rotatedAt.toISOString(),
        }),
      };
    } catch (error) {
      console.error(`Emergency key rotation failed:\n${describeErrorWithStack(error)}`);
      await writeEmergencyRotationFailureAudit({ triggeredBy, sourceIp, failureReason: "rotation_error" });
      return {
        status: 500,
        headers: EMERGENCY_ROTATION_RESPONSE_HEADERS,
        body: JSON.stringify({ error: "Unable to complete emergency rotation" }),
      };
    }
  }

  // CONTRACT-005 §2: parses and validates the request body, returning the
  // normalized username/password pair, or null if the body is missing,
  // malformed, oversized, or missing either required non-empty string field
  // — all of which map to the same 400 response, before any user lookup or
  // hashing occurs.
  async function parseLocalLoginRequestBody(
    request: IncomingMessage,
  ): Promise<{ normalizedUsername: string; password: string } | null> {
    let bodyText: string;
    try {
      bodyText = (await readRequestBody(request, LOCAL_LOGIN_BODY_LIMIT_BYTES)).toString("utf8");
    } catch {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return null;
    }

    if (typeof parsed !== "object" || parsed === null) return null;
    const { username, password } = parsed as Record<string, unknown>;
    if (typeof username !== "string" || username.trim() === "") return null;
    if (typeof password !== "string" || password === "") return null;

    return { normalizedUsername: username.trim().toLowerCase(), password };
  }

  async function writeLocalLoginAuditBestEffort(input: {
    username: string;
    result: "success" | "failure";
    failureReason: "unknown_username" | "bad_password" | "disabled" | "locked" | null;
    sourceIp: string | null;
  }): Promise<void> {
    try {
      await localUserStore.writeLoginAudit(input);
    } catch (error) {
      // CONTRACT-005 §6: never block the caller's response on this write;
      // fall back to a server-side log-line backstop naming only a
      // timestamp and result/failure category — never a credential value.
      console.error(
        `local_login_audit write failed; log-line backstop: timestamp=${new Date().toISOString()} result=${input.result} failureReason=${input.failureReason ?? "null"}: ${errorMessage(error)}`,
      );
    }
  }

  async function handleLocalLogin(
    request: IncomingMessage,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const sourceIp = extractSourceIp(request);
    // CONTRACT-005 §3: a request with no determinable source IP is bucketed
    // under a fixed key so it still receives coarse throttling rather than
    // bypassing it entirely — not expected in normal operation (the socket
    // peer address is always available server-side), flagged as an
    // implementer judgment call in the handoff.
    const throttleKey = sourceIp ?? "unknown";
    const now = Date.now();

    // CONTRACT-005 §2 step 1: checked first, before any body parsing, user
    // lookup, or hashing.
    if (ipThrottle.isThrottled(throttleKey, now)) {
      return {
        status: 429,
        headers: LOCAL_LOGIN_RESPONSE_HEADERS,
        body: JSON.stringify({ error: LOCAL_LOGIN_TOO_MANY_ATTEMPTS_MESSAGE }),
      };
    }

    const parsedBody = await parseLocalLoginRequestBody(request);
    if (parsedBody === null) {
      // CONTRACT-005 §2: malformed request — before any user lookup or
      // hashing occurs, and (per §6) not itself an audited login attempt.
      return {
        status: 400,
        headers: LOCAL_LOGIN_RESPONSE_HEADERS,
        body: JSON.stringify({ error: LOCAL_LOGIN_MISSING_FIELDS_MESSAGE }),
      };
    }
    const { normalizedUsername, password } = parsedBody;

    // CONTRACT-005 §8: every failure path renders a plain JSON error body,
    // never a raw/unhandled exception. This try/catch covers every step
    // between body validation and the success/failure outcome being decided
    // (lookup, the uniform-cost password derivation, and the per-account/
    // audit/throttle side effects), so an unexpected failure at any of those
    // steps (e.g. a database error, or the defensive password_algorithm
    // guard in src/password.ts) still surfaces as the same generic 500
    // rather than an unhandled rejection.
    let userRow: Awaited<ReturnType<LocalUserStore["findByUsername"]>>;
    let failureReason: "unknown_username" | "bad_password" | "disabled" | "locked" | null;
    let isSuccess: boolean;
    try {
      userRow = await localUserStore.findByUsername(normalizedUsername);

      // CONTRACT-005 §2 step 3: this uniform-cost password-derivation
      // computation runs to completion for every outcome (unknown username,
      // locked, disabled, bad password) before the outcome is decided
      // below, so response timing cannot distinguish them.
      let passwordMatches = false;
      if (userRow === undefined) {
        await deriveDummyHashForTimingParity();
      } else {
        passwordMatches = await verifyPassword(password, {
          hash: userRow.passwordHash,
          salt: userRow.passwordSalt,
          algorithm: userRow.passwordAlgorithm,
          costN: userRow.passwordCostN,
          blockSizeR: userRow.passwordBlockSizeR,
          parallelizationP: userRow.passwordParallelizationP,
          keyLength: userRow.passwordKeyLength,
        });
      }

      // CONTRACT-005 §2 step 4: outcome precedence — not found, then locked
      // (regardless of password match), then disabled (regardless of
      // password match), then bad password, then success.
      failureReason = null;
      if (userRow === undefined) {
        failureReason = "unknown_username";
      } else {
        const isLockedNow = userRow.lockedUntil !== null && userRow.lockedUntil.getTime() > now;
        if (isLockedNow) {
          failureReason = "locked";
        } else if (!userRow.isActive) {
          failureReason = "disabled";
        } else if (!passwordMatches) {
          failureReason = "bad_password";
        }
      }
      isSuccess = failureReason === null;

      // Per-account side effects (§2 step 4 / §3). Locked and disabled
      // outcomes leave failed_login_attempts/locked_until untouched — an
      // attempt made while already locked never further extends the
      // lockout.
      if (userRow !== undefined) {
        if (isSuccess) {
          await localUserStore.recordSuccessfulLogin(userRow.id);
        } else if (failureReason === "bad_password") {
          await localUserStore.recordFailedPassword(
            userRow.id,
            config.localLoginMaxFailedAttempts,
            config.localLoginLockoutMinutes,
          );
        }
      }

      // §6: one audit row per attempt, best-effort.
      await writeLocalLoginAuditBestEffort({
        username: normalizedUsername,
        result: isSuccess ? "success" : "failure",
        failureReason,
        sourceIp,
      });

      // §3: only failed attempts count toward the per-IP throttle; a
      // success does not reset or otherwise affect any IP's failure count.
      if (!isSuccess) {
        ipThrottle.recordFailure(throttleKey, now);
      }
    } catch (error) {
      console.error(`Local-login credential verification failed unexpectedly:\n${describeErrorWithStack(error)}`);
      return {
        status: 500,
        headers: LOCAL_LOGIN_RESPONSE_HEADERS,
        body: JSON.stringify({ error: LOCAL_LOGIN_GENERIC_SERVER_ERROR_MESSAGE }),
      };
    }

    if (failureReason === "unknown_username" || failureReason === "bad_password") {
      return {
        status: 401,
        headers: LOCAL_LOGIN_RESPONSE_HEADERS,
        body: JSON.stringify({ error: LOCAL_LOGIN_INVALID_CREDENTIALS_MESSAGE }),
      };
    }
    if (failureReason === "disabled") {
      return {
        status: 403,
        headers: LOCAL_LOGIN_RESPONSE_HEADERS,
        body: JSON.stringify({ error: LOCAL_LOGIN_DISABLED_MESSAGE }),
      };
    }
    if (failureReason === "locked") {
      // userRow is defined whenever failureReason === "locked".
      const lockedUntilIso = userRow!.lockedUntil!.toISOString();
      return {
        status: 423,
        headers: LOCAL_LOGIN_RESPONSE_HEADERS,
        body: JSON.stringify({
          error: `This account is temporarily locked. Try again after ${lockedUntilIso}.`,
        }),
      };
    }

    // Success: mint and set bt_session exactly as CONTRACT-001's callback
    // handler does (CONTRACT-005 §9) — same mintSessionToken call, same
    // cookie-construction logic, no reimplementation.
    try {
      const signingKey = await secretsStore.getCurrentSigningKey();
      const mintedAt = new Date();
      const token = await mintSessionToken(
        { sub: userRow!.id, email: userRow!.email, upn: userRow!.username },
        signingKey,
        config.issuer,
        mintedAt,
      );
      const iat = Math.floor(mintedAt.getTime() / 1_000);
      const exp = nextLocalMidnightEpochSeconds(mintedAt);
      const cookieSecure = config.cookieSecure.trim().toLowerCase() === "true";
      return {
        status: 200,
        headers: {
          ...LOCAL_LOGIN_RESPONSE_HEADERS,
          "Set-Cookie": buildSetCookieHeader(token, iat, exp, cookieSecure),
        },
        body: JSON.stringify({ status: "signed_in", username: userRow!.username }),
      };
    } catch (error) {
      console.error(`Local-login session token minting failed:\n${describeErrorWithStack(error)}`);
      return {
        status: 500,
        headers: LOCAL_LOGIN_RESPONSE_HEADERS,
        body: JSON.stringify({ error: LOCAL_LOGIN_GENERIC_SERVER_ERROR_MESSAGE }),
      };
    }
  }

  // CONTRACT-005 §4: same bearer-check pattern as
  // handleEmergencyRotateKeys/constantTimeTokenMatches above, gated on
  // LOCAL_USER_ADMIN_TOKEN instead of EMERGENCY_ROTATION_TOKEN. Checked
  // first, with no request-body I/O required, so an unauthenticated caller
  // never causes the service to buffer/parse a body it can't yet be
  // trusted to have sent legitimately — the auth decision needs no read()
  // at all, unlike CONTRACT-003's endpoint (which reads the body first
  // purely to attribute triggeredBy on an auth failure too, since the body
  // there is small and read()-then-check-auth costs nothing observable). For
  // POST/PATCH admin requests below we still read the body before this
  // check specifically to recover actedBy for the auth_failure audit row —
  // mirroring CONTRACT-003's own choice there — but the check itself does
  // not require it.
  function checkAdminBearerAuth(request: IncomingMessage): boolean {
    const token = extractBearerToken(request.headers.authorization);
    return token !== null && constantTimeTokenMatches(token, config.localUserAdminToken);
  }

  async function writeAdminAuditBestEffort(input: AdminAuditInput): Promise<void> {
    try {
      await localUserStore.writeAdminAudit(input);
    } catch (error) {
      // CONTRACT-005 §6: never block the caller's response on this write;
      // fall back to a server-side log-line backstop naming only a
      // timestamp, action, and result/failure category — never a
      // credential, password, or actor-label value.
      console.error(
        `local_user_admin_audit write failed; log-line backstop: timestamp=${new Date().toISOString()} action=${input.action} result=${input.result} failureReason=${input.failureReason ?? "null"}: ${errorMessage(error)}`,
      );
    }
  }

  // Reads and best-effort JSON-parses a POST/PATCH admin request body,
  // returning [parsedBodyOrUndefined, actedBy]. `undefined` distinguishes
  // "unreadable/malformed JSON" from a legitimate `null`/non-object body,
  // both of which are validation errors, so the caller can produce a 400
  // without ever throwing out of this function.
  async function readAdminRequestBody(
    request: IncomingMessage,
  ): Promise<{ parsed: unknown; actedBy: string | null }> {
    let bodyText = "";
    try {
      bodyText = (await readRequestBody(request, ADMIN_USERS_BODY_LIMIT_BYTES)).toString("utf8");
    } catch (error) {
      console.error(`Admin request body could not be read: ${errorMessage(error)}`);
      return { parsed: undefined, actedBy: null };
    }
    if (bodyText.trim() === "") return { parsed: undefined, actedBy: null };
    try {
      const parsed: unknown = JSON.parse(bodyText);
      return { parsed, actedBy: extractActedBy(parsed) };
    } catch {
      return { parsed: undefined, actedBy: null };
    }
  }

  async function handleAdminCreateUser(request: IncomingMessage): Promise<HandlerResult> {
    const sourceIp = extractSourceIp(request);
    // CONTRACT-006: public creation is explicitly enabled by the operator.
    // The gate applies even to callers holding the admin bearer token.
    if (config.allowNewLocalLoginCreation !== true) {
      await writeAdminAuditBestEffort({
        action: "create",
        targetUserId: null,
        targetUsername: null,
        changedFields: null,
        result: "failure",
        failureReason: "creation_disabled",
        actorLabel: null,
        sourceIp,
      });
      return {
        status: 403,
        headers: ADMIN_USERS_RESPONSE_HEADERS,
        body: JSON.stringify({ error: "New local account creation is disabled." }),
      };
    }

    // Require JSON so a cross-origin HTML form cannot submit a simple request.
    if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return { status: 415, headers: ADMIN_USERS_RESPONSE_HEADERS,
        body: JSON.stringify({ error: "Content-Type must be application/json." }) };
    }
    const { parsed } = await readAdminRequestBody(request);
    // Public callers cannot claim administrator attribution through actedBy.
    const actedBy = "public-registration";

    if (typeof parsed !== "object" || parsed === null) {
      return adminBadRequest("Request body must be a JSON object.");
    }
    const body = parsed as Record<string, unknown>;

    const usernameResult = validateAdminUsername(body.username);
    if ("error" in usernameResult) return adminBadRequest(usernameResult.error);
    const emailResult = validateAdminEmail(body.email);
    if ("error" in emailResult) return adminBadRequest(emailResult.error);
    const passwordResult = validateAdminPassword(body.password);
    if ("error" in passwordResult) return adminBadRequest(passwordResult.error);

    try {
      const passwordHash = await hashPassword(passwordResult.value);
      const created = await localUserStore.createUser({
        username: usernameResult.value,
        email: emailResult.value,
        passwordHash,
        createdBy: actedBy,
      });
      await writeAdminAuditBestEffort({
        action: "create",
        targetUserId: created.id,
        targetUsername: created.username,
        changedFields: null,
        result: "success",
        failureReason: null,
        actorLabel: actedBy,
        sourceIp,
      });
      return { status: 201, headers: ADMIN_USERS_RESPONSE_HEADERS, body: JSON.stringify(created) };
    } catch (error) {
      if (error instanceof UsernameConflictError || error instanceof EmailConflictError) {
        await writeAdminAuditBestEffort({
          action: "create",
          targetUserId: null,
          targetUsername: usernameResult.value,
          changedFields: null,
          result: "failure",
          failureReason: "conflict",
          actorLabel: actedBy,
          sourceIp,
        });
        return { status: 409, headers: ADMIN_USERS_RESPONSE_HEADERS, body: JSON.stringify({ error: error.message }) };
      }
      console.error(`Admin create-user failed unexpectedly:\n${describeErrorWithStack(error)}`);
      await writeAdminAuditBestEffort({
        action: "create",
        targetUserId: null,
        targetUsername: usernameResult.value,
        changedFields: null,
        result: "failure",
        failureReason: "database_error",
        actorLabel: actedBy,
        sourceIp,
      });
      return adminServerError();
    }
  }

  async function handleAdminListUsers(request: IncomingMessage): Promise<HandlerResult> {
    if (!checkAdminBearerAuth(request)) {
      await writeAdminAuditBestEffort({
        action: "auth_failure",
        targetUserId: null,
        targetUsername: null,
        changedFields: null,
        result: "failure",
        failureReason: "bad_credential",
        actorLabel: null,
        sourceIp: extractSourceIp(request),
      });
      return adminUnauthorized();
    }
    try {
      const users = await localUserStore.listUsers();
      // CONTRACT-005 §6/schema: reads are not part of the audited action
      // set (create/update/delete/auth_failure only) — no audit row here.
      return { status: 200, headers: ADMIN_USERS_RESPONSE_HEADERS, body: JSON.stringify({ users }) };
    } catch (error) {
      console.error(`Admin list-users failed unexpectedly:\n${describeErrorWithStack(error)}`);
      return adminServerError();
    }
  }

  async function handleAdminGetUser(request: IncomingMessage, targetId: string): Promise<HandlerResult> {
    if (!checkAdminBearerAuth(request)) {
      await writeAdminAuditBestEffort({
        action: "auth_failure",
        targetUserId: null,
        targetUsername: null,
        changedFields: null,
        result: "failure",
        failureReason: "bad_credential",
        actorLabel: null,
        sourceIp: extractSourceIp(request),
      });
      return adminUnauthorized();
    }
    try {
      const record = await localUserStore.getUserById(targetId);
      if (record === undefined) return adminNotFound(); // read action — no audit row, see handleAdminListUsers.
      return { status: 200, headers: ADMIN_USERS_RESPONSE_HEADERS, body: JSON.stringify(record) };
    } catch (error) {
      console.error(`Admin get-user failed unexpectedly:\n${describeErrorWithStack(error)}`);
      return adminServerError();
    }
  }

  async function handleAdminPatchUser(request: IncomingMessage, targetId: string): Promise<HandlerResult> {
    const sourceIp = extractSourceIp(request);
    const { parsed, actedBy } = await readAdminRequestBody(request);

    if (!checkAdminBearerAuth(request)) {
      await writeAdminAuditBestEffort({
        action: "auth_failure",
        targetUserId: null,
        targetUsername: null,
        changedFields: null,
        result: "failure",
        failureReason: "bad_credential",
        actorLabel: actedBy,
        sourceIp,
      });
      return adminUnauthorized();
    }

    if (typeof parsed !== "object" || parsed === null) {
      return adminBadRequest("Request body must be a JSON object.");
    }
    const body = parsed as Record<string, unknown>;

    // CONTRACT-005 Interfaces: "Username is not renamable via this
    // endpoint" — treated as a validation error if the caller attempts it,
    // rather than silently ignoring the field (an implementer's call; the
    // contract doesn't specify the precise response, only that a rename
    // never happens).
    if ("username" in body) {
      return adminBadRequest("username cannot be changed via this endpoint; delete and recreate the user instead.");
    }

    const hasEmail = "email" in body;
    const hasPassword = "password" in body;
    const hasIsActive = "isActive" in body;
    if (!hasEmail && !hasPassword && !hasIsActive) {
      return adminBadRequest("At least one of email, password, or isActive is required.");
    }

    let emailValue: string | undefined;
    if (hasEmail) {
      const emailResult = validateAdminEmail(body.email);
      if ("error" in emailResult) return adminBadRequest(emailResult.error);
      emailValue = emailResult.value;
    }

    let passwordValue: string | undefined;
    if (hasPassword) {
      const passwordResult = validateAdminPassword(body.password);
      if ("error" in passwordResult) return adminBadRequest(passwordResult.error);
      passwordValue = passwordResult.value;
    }

    let isActiveValue: boolean | undefined;
    if (hasIsActive) {
      if (typeof body.isActive !== "boolean") return adminBadRequest("isActive must be a boolean.");
      isActiveValue = body.isActive;
    }

    try {
      const passwordHash = passwordValue !== undefined ? await hashPassword(passwordValue) : undefined;
      const updateResult = await localUserStore.updateUser(targetId, {
        email: emailValue,
        passwordHash,
        isActive: isActiveValue,
      });
      if (updateResult === undefined) {
        await writeAdminAuditBestEffort({
          action: "update",
          targetUserId: targetId,
          targetUsername: null,
          changedFields: null,
          result: "failure",
          failureReason: "not_found",
          actorLabel: actedBy,
          sourceIp,
        });
        return adminNotFound();
      }
      await writeAdminAuditBestEffort({
        action: "update",
        targetUserId: updateResult.record.id,
        targetUsername: updateResult.record.username,
        changedFields: updateResult.changedFields.join(","),
        result: "success",
        failureReason: null,
        actorLabel: actedBy,
        sourceIp,
      });
      return { status: 200, headers: ADMIN_USERS_RESPONSE_HEADERS, body: JSON.stringify(updateResult.record) };
    } catch (error) {
      if (error instanceof EmailConflictError) {
        await writeAdminAuditBestEffort({
          action: "update",
          targetUserId: targetId,
          targetUsername: null,
          changedFields: null,
          result: "failure",
          failureReason: "conflict",
          actorLabel: actedBy,
          sourceIp,
        });
        return { status: 409, headers: ADMIN_USERS_RESPONSE_HEADERS, body: JSON.stringify({ error: error.message }) };
      }
      console.error(`Admin update-user failed unexpectedly:\n${describeErrorWithStack(error)}`);
      await writeAdminAuditBestEffort({
        action: "update",
        targetUserId: targetId,
        targetUsername: null,
        changedFields: null,
        result: "failure",
        failureReason: "database_error",
        actorLabel: actedBy,
        sourceIp,
      });
      return adminServerError();
    }
  }

  async function handleAdminDeleteUser(request: IncomingMessage, targetId: string): Promise<HandlerResult> {
    const sourceIp = extractSourceIp(request);
    // CONTRACT-005 Interfaces documents no request body for DELETE, so
    // (unlike POST/PATCH above) no body is read here — actedBy is always
    // null for this endpoint's audit rows.
    if (!checkAdminBearerAuth(request)) {
      await writeAdminAuditBestEffort({
        action: "auth_failure",
        targetUserId: null,
        targetUsername: null,
        changedFields: null,
        result: "failure",
        failureReason: "bad_credential",
        actorLabel: null,
        sourceIp,
      });
      return adminUnauthorized();
    }
    try {
      const deleted = await localUserStore.deleteUser(targetId);
      if (deleted === undefined) {
        await writeAdminAuditBestEffort({
          action: "delete",
          targetUserId: targetId,
          targetUsername: null,
          changedFields: null,
          result: "failure",
          failureReason: "not_found",
          actorLabel: null,
          sourceIp,
        });
        return adminNotFound();
      }
      await writeAdminAuditBestEffort({
        action: "delete",
        targetUserId: deleted.id,
        targetUsername: deleted.username,
        changedFields: null,
        result: "success",
        failureReason: null,
        actorLabel: null,
        sourceIp,
      });
      return {
        status: 200,
        headers: ADMIN_USERS_RESPONSE_HEADERS,
        body: JSON.stringify({ status: "deleted", id: deleted.id, username: deleted.username }),
      };
    } catch (error) {
      console.error(`Admin delete-user failed unexpectedly:\n${describeErrorWithStack(error)}`);
      await writeAdminAuditBestEffort({
        action: "delete",
        targetUserId: targetId,
        targetUsername: null,
        changedFields: null,
        result: "failure",
        failureReason: "database_error",
        actorLabel: null,
        sourceIp,
      });
      return adminServerError();
    }
  }

  return async (request, response) => {
    if (await handleApiDocs(request, response)) return;
    if (config.localLogin === false && request.method === "GET" && request.url === "/auth/login") {
      const result = await handleLogin();
      response.writeHead(result.status, result.headers);
      response.end(result.body);
      return;
    }

    if (
      config.localLogin === false &&
      request.method === "GET" &&
      (request.url ?? "").split("?")[0] === "/auth/callback"
    ) {
      const url = new URL(request.url ?? "/auth/callback", "http://localhost");
      const result = await handleCallback(url);
      response.writeHead(result.status, result.headers);
      response.end(result.body);
      return;
    }

    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (request.method === "GET" && request.url === "/.well-known/jwks.json") {
      try {
        const signingKeys = await secretsStore.listPublishableSigningKeys();
        const keys = await Promise.all(signingKeys.map(async (signingKey) => {
          if (signingKey.algorithm !== "RS256") {
            throw new Error(`Unsupported signing algorithm for key ${signingKey.kid}.`);
          }
          const publicKey = await importSPKI(signingKey.publicKeyPem, "RS256");
          const jwk = await exportJWK(publicKey);
          if (jwk.kty !== "RSA" || jwk.n === undefined || jwk.e === undefined) {
            throw new Error(`Signing key ${signingKey.kid} is not a valid RSA public key.`);
          }
          return {
            kty: "RSA" as const,
            use: "sig" as const,
            alg: "RS256" as const,
            kid: signingKey.kid,
            n: jwk.n,
            e: jwk.e,
          };
        }));
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        response.end(JSON.stringify({ keys }));
      } catch (error) {
        console.error(`JWKS publication failed:\n${describeErrorWithStack(error)}`);
        response.writeHead(500, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        response.end(JSON.stringify({ error: "Unable to publish signing keys" }));
      }
      return;
    }

    if (request.method === "POST" && (request.url ?? "").split("?")[0] === "/admin/emergency-rotate-keys") {
      const result = await handleEmergencyRotateKeys(request);
      response.writeHead(result.status, result.headers);
      response.end(result.body);
      return;
    }

    if (request.method === "GET" && (request.url ?? "").split("?")[0] === "/auth/local-register") {
      let usersHtml: string;
      try {
        const users = await localUserStore.listUsers();
        const escapeHtml = (value: string): string => value.replace(/[&<>"']/g,
          character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
        usersHtml = `<h2>Local users</h2>
<p id="local-users-empty"${users.length > 0 ? " hidden" : ""}>No local users yet.</p>
<table><thead><tr><th scope="col">Username</th><th scope="col">Status</th></tr></thead>
<tbody id="local-users-body">${users.map(user => `<tr><td>${escapeHtml(user.username)}</td><td>${user.isActive ? "Active" : "Disabled"}</td></tr>`).join("")}</tbody></table>`;
      } catch (error) {
        console.error(`Registration page could not list local users:\n${describeErrorWithStack(error)}`);
        usersHtml = '<h2>Local users</h2><p>Unable to load local users. Reload the page to try again.</p><p id="local-users-empty" hidden></p><table><thead><tr><th scope="col">Username</th><th scope="col">Status</th></tr></thead><tbody id="local-users-body"></tbody></table>';
      }
      const page = config.allowNewLocalLoginCreation === true
        ? LOCAL_REGISTER_FORM_HTML
        : '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Create an account</title></head><body><h1>Create an account</h1><p>New local account creation is disabled.</p><p><a href="/auth/local-login">Sign in</a></p><!-- LOCAL_USERS_LIST --></body></html>';
      response.writeHead(200, { ...LOCAL_LOGIN_FORM_RESPONSE_HEADERS, "Cache-Control": "no-store" });
      response.end(page.replace("<!-- LOCAL_USERS_LIST -->", () => usersHtml));
      return;
    }

    // CONTRACT-005 §4/§7: /admin/users* is reachable regardless of
    // LOCAL_LOGIN's value (not gated by that switch). CONTRACT-006 makes POST
    // creation public and gates it with allowNewLocalLoginCreation; other
    // operations retain the LOCAL_USER_ADMIN_TOKEN check. Placed outside (and
    // before) the LOCAL_LOGIN-gated block below.
    {
      const adminUsersPath = (request.url ?? "").split("?")[0];
      const adminUserIdMatch = /^\/admin\/users\/([^/]+)$/.exec(adminUsersPath ?? "");

      if (request.method === "POST" && adminUsersPath === "/admin/users") {
        const result = await handleAdminCreateUser(request);
        response.writeHead(result.status, result.headers);
        response.end(result.body);
        return;
      }
      if (request.method === "GET" && adminUsersPath === "/admin/users") {
        const result = await handleAdminListUsers(request);
        response.writeHead(result.status, result.headers);
        response.end(result.body);
        return;
      }
      if (request.method === "GET" && adminUserIdMatch !== null) {
        const result = await handleAdminGetUser(request, decodeURIComponent(adminUserIdMatch[1]!));
        response.writeHead(result.status, result.headers);
        response.end(result.body);
        return;
      }
      if (request.method === "PATCH" && adminUserIdMatch !== null) {
        const result = await handleAdminPatchUser(request, decodeURIComponent(adminUserIdMatch[1]!));
        response.writeHead(result.status, result.headers);
        response.end(result.body);
        return;
      }
      if (request.method === "DELETE" && adminUserIdMatch !== null) {
        const result = await handleAdminDeleteUser(request, decodeURIComponent(adminUserIdMatch[1]!));
        response.writeHead(result.status, result.headers);
        response.end(result.body);
        return;
      }
    }

    // CONTRACT-005 §7: strict either/or with GET /auth/login and GET
    // /auth/callback above — live only when LOCAL_LOGIN=true, otherwise
    // falls through to the same generic 404 below as any unmatched route.
    if (config.localLogin === true && request.method === "POST" && (request.url ?? "").split("?")[0] === "/auth/local-login") {
      const result = await handleLocalLogin(request);
      response.writeHead(result.status, result.headers);
      response.end(result.body);
      return;
    }

    // CONTRACT-005 §11: GET /auth/local-login — the minimal HTML login form,
    // gated identically to the JSON endpoint immediately above (live only
    // when LOCAL_LOGIN=true; otherwise falls through to the same generic 404
    // as any unmatched route). Serves a fixed, self-contained HTML document;
    // no request body is read and no credential is inspected here at all.
    if (config.localLogin === true && request.method === "GET" && (request.url ?? "").split("?")[0] === "/auth/local-login") {
      response.writeHead(200, LOCAL_LOGIN_FORM_RESPONSE_HEADERS);
      response.end(LOCAL_LOGIN_FORM_HTML);
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
  };
}

async function start(): Promise<void> {
  installConsoleFormatting();
  installProcessErrorLogging();
  let databaseHandle: DatabaseHandle | undefined;
  try {
    const config = loadConfig(process.env);
    console.log(
      `Starting BTAuthOrchestrator (node ${process.version}, pid ${process.pid}): ` +
        `port=${config.port} localLogin=${config.localLogin} ` +
        `allowNewLocalLoginCreation=${config.allowNewLocalLoginCreation} ` +
        `issuer=${config.issuer} dataDir=${config.pgliteDataDir}`,
    );
    await prepareDataDirectory(config.pgliteDataDir);
    databaseHandle = await openDatabase(config.pgliteDataDir);
    const secretsStore = createSecretsStore(databaseHandle.database, config.dbEncryptionKey);
    const localUserStore = createLocalUserStore(databaseHandle.database);
    const server = createServer(withRequestMonitoring(createRequestHandler(secretsStore, config, localUserStore)));

    server.listen(config.port, () => {
      console.log(`BTAuthOrchestrator listening on port ${config.port}`);
    });

    server.on("error", (error) => {
      console.error(`Startup error: ${error.message}`);
      process.exitCode = 1;
    });

    let shuttingDown = false;
    const shutdown = async (): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await databaseHandle?.close();
    };
    const shutdownFromSignal = async (): Promise<void> => {
      try {
        await shutdown();
        process.exit(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Shutdown error: ${message}`);
        process.exit(1);
      }
    };
    process.once("SIGINT", () => void shutdownFromSignal());
    process.once("SIGTERM", () => void shutdownFromSignal());
  } catch (error) {
    await databaseHandle?.close().catch(() => undefined);
    console.error(`Startup failed: ${describeError(error)}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void start();
}
