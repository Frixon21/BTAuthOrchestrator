import type { Config } from "./config.js";

type Schema = Record<string, unknown>;
const string = { type: "string" };
const object = (properties: Record<string, Schema>, required: string[] = []) => ({ type: "object", properties, required });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (description: string, schema: Schema) => ({ description, content: { "application/json": { schema } } });
const html = (description: string) => ({ description, content: { "text/html": { schema: string } } });
const errors = (...codes: number[]) => Object.fromEntries(codes.map(code => [code, json(({
  400: "Invalid request", 401: "Invalid or missing credentials", 403: "Disabled account, or sign-out without the console request checks",
  404: "Not found or login route disabled in this mode", 409: "Username or email already exists",
  415: "Content-Type must be application/json", 423: "Account temporarily locked; error includes unlock time",
  429: "Source IP throttled", 500: "Internal server error",
} as Record<number, string>)[code] ?? "Error", ref("Error"))]));
const body = (schema: Schema, required = true) => ({ required, content: { "application/json": { schema } } });
// CONTRACT-011 §1: user management accepts the user-admin token or an active
// local user's bt_session (with the X-BT-Admin-Console header). An
// Authorization header always takes precedence over the cookie.
const adminSecurity = [{ LocalUserAdminToken: [] }, { ConsoleSession: [] }];
const sessionNote = " A bt_session cookie also authorizes this while LOCAL_LOGIN=true and ALLOW_NEW_LOCAL_LOGIN_CREATION is off, if it belongs to an active local user and the request sends X-BT-Admin-Console: 1 (and, when present, a same-origin Origin and Sec-Fetch-Site). A request with an Authorization header is always judged by the token alone.";
const id = [{ name: "id", in: "path", required: true, schema: string, description: "Local user ID" }];

/** Live configuration is deliberately limited to public feature switches, never credentials. */
export function createOpenApiDocument(config: Config) {
  const localMode = config.localLogin;
  const paths: Record<string, unknown> = {
    "/health": { get: { tags: ["Service"], summary: "Check service health", responses: { 200: json("Healthy", object({ status: { type: "string", enum: ["ok"] } }, ["status"])) } } },
    "/.well-known/jwks.json": { get: { tags: ["Service"], summary: "Get public RS256 signing keys", description: "Includes current and retired keys; excludes revoked keys. Cache-Control: no-store.", responses: { 200: json("Public keys", object({ keys: { type: "array", items: ref("Jwk") } }, ["keys"])), ...errors(500) } } },
    "/auth/local-register": { get: { tags: ["Authentication"], summary: "Account registration page and public username/status list", description: `Available in both login modes. Account creation is currently ${config.allowNewLocalLoginCreation ? "enabled" : "disabled"}. Lists usernames and Active/Disabled status even when creation is disabled.`, responses: { 200: html("Registration page") } } },
    "/admin/reset-password": { get: { tags: ["Users"], summary: "Admin password reset form", description: "Static public page available in both login modes, Cache-Control: no-store. Links to /admin/console. Actions use the admin bearer token with GET /admin/users and PATCH /admin/users/{id}. Password reset clears lockout, preserves disabled status and existing sessions, and permits the same password. The token is never persisted.", responses: { 200: html("Password reset page") } } },
    "/admin/console": { get: { tags: ["Admin console"], summary: "Browser admin console", description: "Static single-page console, available in both login modes and regardless of ALLOW_NEW_LOCAL_LOGIN_CREATION. No authentication; contains no user data. /admin/console/ serves the same page. Responses use Cache-Control: no-store, X-Content-Type-Options: nosniff and a strict Content-Security-Policy. Operators can sign in with a local account (GET /admin/session, POST /auth/local-login, POST /auth/logout) and then manage users through the session cookie; otherwise the console sends the user-admin token for /admin/users* and the emergency token only for POST /admin/emergency-rotate-keys. Tokens are kept in the browser tab's sessionStorage.", responses: { 200: html("Console page") } } },
    "/admin/console/{asset}": { get: { tags: ["Admin console"], summary: "Admin console static asset", description: "Served only from a fixed allow-list, with the same headers as the console page. Any other path under /admin/console/ returns the generic 404.", parameters: [{ name: "asset", in: "path", required: true, schema: { type: "string", enum: ["app.js", "theme.js", "app.css"] } }], responses: { 200: { description: "Asset", content: { "application/javascript": { schema: string }, "text/css": { schema: string } } }, 404: json("Not an allow-listed asset", ref("Error")) } } },
    "/admin/users": {
      get: { tags: ["Users"], summary: "List local users", description: sessionNote.trim(), security: adminSecurity, responses: { 200: json("Users", object({ users: { type: "array", items: ref("User") } }, ["users"])), ...errors(401, 500) } },
      post: { tags: ["Users"], summary: "Create a local user", description: `Public registration is currently ${config.allowNewLocalLoginCreation ? "enabled" : "disabled"} (ALLOW_NEW_LOCAL_LOGIN_CREATION). The user-admin token always authorizes creation and records actedBy. While registration is off, a console session also authorizes it (recorded as the signed-in user) and a request with neither gets 401. While registration is on, a request without an Authorization header is public and recorded as public-registration; a wrong token is a 401, never public. Username is trimmed and lowercased. Requires Content-Type: application/json.`, security: config.allowNewLocalLoginCreation ? [...adminSecurity, {}] : adminSecurity, requestBody: body(ref("CreateUser")), responses: { 201: json("Created user", ref("User")), ...errors(400, 401, 409, 415, 500) } },
    },
    "/admin/users/{id}": {
      get: { tags: ["Users"], summary: "Get a local user", description: sessionNote.trim(), security: adminSecurity, parameters: id, responses: { 200: json("User", ref("User")), ...errors(401, 404, 500) } },
      patch: { tags: ["Users"], summary: "Update a local user", description: "Supply at least one of email, password, or isActive. Username cannot be changed. Changing password resets account lockout. actedBy is an unverified caller label, ignored for session-authorized requests." + sessionNote, security: adminSecurity, parameters: id, requestBody: body(ref("UpdateUser")), responses: { 200: json("Updated user", ref("User")), ...errors(400, 401, 404, 409, 500) } },
      delete: { tags: ["Users"], summary: "Permanently delete a local user", description: "Audit records are retained." + sessionNote, security: adminSecurity, parameters: id, responses: { 200: json("Deleted", object({ status: { type: "string", enum: ["deleted"] }, id: string, username: string }, ["status", "id", "username"])), ...errors(401, 404, 500) } },
    },
    "/admin/session": { get: { tags: ["Admin console"], summary: "Console sign-in status", description: "Available in both login modes; no credential required. Reports whether console sign-in can work (unavailable while ALLOW_NEW_LOCAL_LOGIN_CREATION is on or LOCAL_LOGIN is off) and, if the bt_session cookie belongs to an active local user, who that is. Cache-Control: no-store. Not audited.", responses: { 200: json("Status", object({ sessionAdmin: { type: "string", enum: ["available", "unavailable"] }, reason: { type: "string", nullable: true, enum: ["registration_open", "local_login_off"] }, signedIn: { type: "boolean" }, user: { ...object({ id: string, username: string }, ["id", "username"]), nullable: true } }, ["sessionAdmin", "reason", "signedIn", "user"])), ...errors(500) } } },
    "/auth/logout": { post: { tags: ["Authentication"], summary: "Sign this browser out", description: "Available in both login modes. Requires X-BT-Admin-Console: 1 and, when present, a same-origin Origin and Sec-Fetch-Site; otherwise 403. Expires the shared bt_session cookie, which signs the browser out of every *.biztechro.com app. Does not revoke the token itself.", parameters: [{ name: "X-BT-Admin-Console", in: "header", required: true, schema: { type: "string", enum: ["1"] } }], responses: { 200: { ...json("Signed out", object({ status: { type: "string", enum: ["signed_out"] } }, ["status"])), headers: { "Set-Cookie": { schema: string, description: "Expires bt_session" } } }, ...errors(403) } } },
    "/admin/emergency-rotate-keys": { post: { tags: ["Signing keys"], summary: "Revoke the current signing key and generate a new one", description: "Invalidates tokens signed with the previous key for verifiers using fresh JWKS. Uses a dedicated emergency token; a session cookie does not authorize this operation. triggeredBy is an unverified caller label. Optional malformed body is ignored.", security: [{ EmergencyRotationToken: [] }], requestBody: body(object({ triggeredBy: string }), false), responses: { 200: json("Rotated", object({ status: { type: "string", enum: ["rotated"] }, previousKid: string, newKid: string, rotatedAt: { type: "string", format: "date-time" } }, ["status", "previousKid", "newKid", "rotatedAt"])), ...errors(401, 500) } } },
  };
  if (localMode) {
    paths["/auth/forgot-password"] = {
      get: { tags: ["Authentication"], summary: "Email password recovery form", responses: { 200: html("Recovery page"), 503: html("Recovery unavailable: mail configuration is absent") } },
      post: { tags: ["Authentication"], summary: "Request a password reset email",
        description: "Generic confirmation for known, unknown, disabled, throttled accounts and delivery failures. Trusted origin and JSON required for browser POST. Delivery requires all three server-side recovery settings; absent configuration returns 503 for every account.",
        requestBody: body(object({ email: { type: "string", format: "email", maxLength: 254 } }, ["email"])),
        responses: { 200: json("Generic confirmation", object({message:string})), ...errors(400,403,415,503) } },
    };
    paths["/auth/reset-password"] = {
      get: { tags: ["Authentication"], summary: "Reset password form; never consumes a token", responses: { 200: html("Reset page; token supplied in URL fragment") } },
      post: { tags: ["Authentication"], summary: "Consume a single-use password reset link",
        description: "Expires after 30 minutes. Password update and token consumption are atomic. Revokes BTAuth console sessions; existing offline JWTs remain verifiable until expiry. No automatic sign-in.",
        requestBody: body(object({ token:string, newPassword:{type:"string",format:"password",minLength:12,maxLength:1024} }, ["token","newPassword"])),
        responses: { 200:json("Password reset",object({message:string})), ...errors(400,403,415,429,503) } },
    };
    paths["/auth/local-change-password"] = {
      get: { tags: ["Authentication"], summary: "Local password change form", responses: { 200: html("Password change page") } },
      post: { tags: ["Authentication"], summary: "Change a local password using the current password",
        description: "Available only with LOCAL_LOGIN=true (otherwise 404). Username is trimmed and lowercased. New password must differ from currentPassword. Shared account lockout with sign-in; separate IP counter with the same LOCAL_LOGIN_IP_THROTTLE_* thresholds. Throttle precedes JSON validation. Unknown username/wrong password share the login 401; locked/disabled return 423/403. Success clears lockout, sets no cookie and preserves existing sessions. All JSON responses use Cache-Control: no-store. Validated attempts write one self-service update admin audit row, never a login audit row.",
        requestBody: body(object({ username: { type: "string", minLength: 1 }, currentPassword: { type: "string", format: "password", minLength: 1 }, newPassword: { type: "string", format: "password", minLength: 12 } }, ["username", "currentPassword", "newPassword"])),
        responses: { 200: json("Password changed; no Set-Cookie", object({ status: { type: "string", enum: ["password_changed"] }, username: string }, ["status", "username"])), ...errors(400, 401, 403, 404, 415, 423, 429, 500) },
      },
    };
    paths["/auth/local-login"] = {
      get: { tags: ["Authentication"], summary: "Local sign-in form", responses: { 200: html("Sign-in page") } },
      post: { tags: ["Authentication"], summary: "Sign in with username and password", description: "Sets the HttpOnly bt_session cookie scoped to .biztechro.com, expiring at next local midnight. Unknown username and wrong password share the same 401 response.", requestBody: body(object({ username: string, password: { type: "string", format: "password" } }, ["username", "password"])), responses: { 200: { ...json("Signed in", object({ status: { type: "string", enum: ["signed_in"] }, username: string }, ["status", "username"])), headers: { "Set-Cookie": { schema: string, description: "bt_session session cookie" } } }, ...errors(400, 401, 403, 423, 429, 500) } },
    };
  } else {
    paths["/auth/login"] = { get: { tags: ["Authentication"], summary: "Begin Entra OIDC sign-in", description: "Open in a browser to follow the redirect. Creates a single-use, ten-minute state/nonce/PKCE handshake.", responses: { 302: { description: "Redirect to Entra", headers: { Location: { schema: string } } }, 502: html("Entra unavailable"), 500: html("Sign-in failed") } } };
    paths["/auth/callback"] = { get: { tags: ["Authentication"], summary: "Entra OIDC callback", description: "Entra redirect target, not a standalone login endpoint. Validates state and tokens and sets the bt_session cookie on success.", parameters: ["code", "state", "error"].map(name => ({ name, in: "query", schema: string })), responses: { 200: { ...html("Signed in"), headers: { "Set-Cookie": { schema: string } } }, 400: html("Invalid, rejected, or expired handshake"), 500: html("Sign-in failed"), 502: html("Entra unavailable") } } };
  }
  return {
    openapi: "3.0.3", info: { title: "BT Auth Orchestrator API", version: "0.9.0", description: `Authentication and local user management. Active login mode: ${localMode ? "local" : "Entra"}. Inactive login routes return 404 and are omitted. Admin user operations remain available in either mode. An active local user's session cookie authorizes user management (not key rotation) under the conditions on each operation.` },
    servers: [{ url: "/", description: "This service" }], paths,
    components: {
      securitySchemes: {
        LocalUserAdminToken: { type: "http", scheme: "bearer", description: "LOCAL_USER_ADMIN_TOKEN (not a session JWT)" },
        EmergencyRotationToken: { type: "http", scheme: "bearer", description: "EMERGENCY_ROTATION_TOKEN (separate from the user admin token)" },
        ConsoleSession: { type: "apiKey", in: "cookie", name: "bt_session", description: "Session cookie of an active local user, used by the admin console. Requires the X-BT-Admin-Console: 1 header." },
      },
      schemas: {
        Error: object({ error: string }, ["error"]),
        User: object({ id: string, username: string, email: string, isActive: { type: "boolean" }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" } }, ["id", "username", "email", "isActive", "createdAt", "updatedAt"]),
        CreateUser: object({ username: { type: "string", minLength: 3, maxLength: 64, description: "Trimmed and lowercased; then must match [a-z0-9._-]+" }, email: { type: "string", format: "email" }, password: { type: "string", format: "password", minLength: 12 }, actedBy: string }, ["username", "email", "password"]),
        UpdateUser: { ...object({ email: { type: "string", format: "email" }, password: { type: "string", format: "password", minLength: 12 }, isActive: { type: "boolean" }, actedBy: string }), anyOf: [{ required: ["email"] }, { required: ["password"] }, { required: ["isActive"] }] },
        Jwk: object({ kty: { type: "string", enum: ["RSA"] }, use: { type: "string", enum: ["sig"] }, alg: { type: "string", enum: ["RS256"] }, kid: string, n: string, e: string }, ["kty", "use", "alg", "kid", "n", "e"]),
      },
    },
  };
}
