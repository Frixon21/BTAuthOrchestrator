# CONTRACT-006: Public local account registration

Status: Approved
Approved by: Patrick (direct request and public-registration clarification)
Approved date: 2026-09-16
Related tasks: TASK-020
Related ADRs: ADR-001
Supersedes: CONTRACT-005 only for HTTP user creation authorization and the
prohibition on self-service registration; all other behavior remains in force.
Superseded by: CONTRACT-011 for the 403 returned to admin-token creation while
creation is disabled, and for public-registration attribution of
token-authorized creation while it is enabled. All other behavior remains in
force.

## Required behavior

- `ALLOW_NEW_LOCAL_LOGIN_CREATION` permits HTTP user creation only when its
  trimmed value equals `true`, case-insensitively. Absent, empty, false, and
  unrecognized values disable it. Configuration is loaded at startup. The
  originally supplied spelling `AllOW_NEW_LOCAL_LOGIN_CREATION` is accepted as
  an alias when the uppercase spelling is absent; uppercase takes precedence.
- `GET /auth/local-register` serves a minimal username/email/password form
  when enabled, or a disabled message without a form otherwise. Local sign-in
  links to this page. The page uses the same origin's `POST /admin/users`.
- `POST /admin/users` is public when enabled, independent of `LOCAL_LOGIN`.
  When disabled it returns 403 without hashing or saving a user, including
  requests with a valid admin token. This gate is enforced by the server.
- Creation requires JSON Content-Type (415 otherwise) and retains the existing
  input validation, scrypt hashing, conflict responses, and public response
  fields. It never sends the admin token to the browser. Successful creation
  does not sign the user in automatically.
- Public creation audit attribution is `public-registration`; user-supplied
  `actedBy` is not trusted as an administrator label. Disabled creation attempts
  write a best-effort create/failure audit with `creation_disabled`.
- All other `/admin/users*` operations continue to require
  `LOCAL_USER_ADMIN_TOKEN`. Local sign-in remains gated by `LOCAL_LOGIN`.
- Bootstrap seed remains an operator command independent of this HTTP switch.

## Validation

Verify fail-closed flag values, direct API refusal while disabled, tokenless
creation while enabled, input/duplicate handling, stored password hashing,
unchanged authorization for other admin operations, and form success/error
rendering without HTML interpretation.

## Operational limits

Enabling this flag permits anyone who can reach the service to create an active
local account. Registration reuses existing API resource limits and does not
introduce email verification or registration rate limiting.
