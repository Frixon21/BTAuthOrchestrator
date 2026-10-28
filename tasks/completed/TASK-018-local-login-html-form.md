# TASK-018: Minimal HTML login form for local login

Owner role: Implementer
Assigned agent: TBD
Proposed by: Claude (direct request from Patrick to break CONTRACT-005 into
small tasks)
Proposed date: 2026-09-15
Approved by: Patrick
Approved date: 2026-09-15
Related contracts: CONTRACT-005 (§11)
Related ADRs: ADR-003
Dependencies: TASK-015 (wraps its `POST /auth/local-login` endpoint)

## Desired outcome

`GET /auth/local-login` serves a minimal, unstyled HTML form so a human
tester can sign in from a browser without constructing a raw HTTP request.

## Context

Deliberately a thin client-side wrapper, not a second implementation:
CONTRACT-005 §11 requires the form's submission to call TASK-015's
existing `POST /auth/local-login` JSON endpoint via client-side JavaScript,
never a native form POST or any server-side credential-verification logic
of its own.

## Scope

### Included

- `GET /auth/local-login`: minimal HTML page, username/password fields,
  inline `fetch()` call to `POST /auth/local-login`.
- Live only when `LOCAL_LOGIN=true` — same generic-404 gating as the JSON
  endpoint when `LOCAL_LOGIN=false`.
- Success rendering: replace the form with a plain "You're signed in."
  confirmation on the same page (no redirect).
- Failure rendering: display the JSON error response's `error` string
  as-is next to the form (no reinterpretation) — including the exact
  disabled/locked messages when applicable.

### Excluded

- Any change to `POST /auth/local-login`'s own behavior — TASK-015,
  unmodified here.
- Styling, branding, or responsive design — explicitly not required
  (CONTRACT-005 §11).

## Plan

1. Add `GET /auth/local-login` to `index.ts`, gated identically to the
   POST endpoint.
2. Serve a minimal HTML page with a form and an inline `<script>` that
   posts JSON to the existing endpoint via `fetch()`.
3. Render success/failure per CONTRACT-005 §11.

## Acceptance criteria

- [x] `GET /auth/local-login` returns the HTML form when `LOCAL_LOGIN=true`,
      and the same generic 404 as any unmatched route when
      `LOCAL_LOGIN=false`.
- [x] Submitting correct credentials via the form results in a `bt_session`
      cookie being set and a visible "You're signed in." confirmation.
- [x] Submitting incorrect credentials displays the exact error text
      `POST /auth/local-login` returned, unmodified.
- [x] No credential-verification logic exists in the page itself — the
      only place a username/password is checked is TASK-015's existing
      endpoint.

## Validation requirements

Load the form in a real browser (or headless), submit valid and invalid
credentials, confirm the rendered outcome matches `POST
/auth/local-login`'s actual response in each case.

## Risks and assumptions

None beyond TASK-015 landing first.

## Blocker

None (depends on TASK-015 completing, not literally blocked yet).

## Implementation handoff

Task: TASK-018 — Minimal HTML login form for local login
Implementer: Claude Sonnet 5, standing in for openai-coder (Codex MCP server
confirmed unreachable again this session; Patrick explicitly chose to keep
using this substitution rather than wait for it)
Date: 2026-09-15

### Changes made

- **`src/index.ts`**:
  - Added `LOCAL_LOGIN_FORM_RESPONSE_HEADERS` (`Content-Type: text/html;
    charset=utf-8` — same as `renderHtml`'s existing Entra HTML responses;
    no `Cache-Control` header, matching that same existing convention rather
    than the JSON admin surface's `no-store` posture) and
    `LOCAL_LOGIN_FORM_HTML`, a fixed, self-contained HTML string: a
    username/password `<form>`, an `#error-message` paragraph, a hidden
    `#success-message` paragraph, and one inline `<script>`.
  - The script's *entire* server interaction is one `fetch("/auth/local-login",
    {method: "POST", ...})` call on the form's `submit` handler (with
    `event.preventDefault()` so the browser never issues a native form POST).
    On `response.ok` it hides the form and un-hides `#success-message` ("You're
    signed in."), no redirect. On failure it sets `#error-message`'s
    `textContent` to `result.body.error` — the JSON body's `error` string
    verbatim, via `textContent` (never `innerHTML`), so no reinterpretation,
    translation, HTML-injection risk, or embellishment is possible. A
    `.catch()` on the fetch promise itself (a genuine network failure, not a
    JSON error response) shows a fixed "Sign-in failed." string — this path
    cannot fire in this task's own validation (the same-origin server was
    always reachable) and is called out under "Assumptions and deviations"
    below since CONTRACT-005 §11 does not address a non-JSON transport
    failure explicitly.
  - New route: `GET /auth/local-login`, gated `config.localLogin === true`
    (identical condition to the existing `POST /auth/local-login` route
    immediately above it in the dispatcher), returning `200` +
    `LOCAL_LOGIN_FORM_HTML` when live. When `config.localLogin === false`,
    no route matches and the request falls through to the existing, unmodified
    generic `404 {"error":"Not found"}` — the same fallthrough
    `POST /auth/local-login` already used before this task (§7/§11 identical
    gating).
  - Removed the stale "GET /auth/local-login... deliberately not implemented
    here — TASK-018's scope" comment TASK-015 left in place; no other change
    to `POST /auth/local-login`, `handleLocalLogin`, or any other existing
    route/handler.
  - No new imports, no new module, no change to `LocalUserStore`,
    `password.ts`, `ipThrottle.ts`, `config.ts`, or `database.ts`. This route
    handler performs zero database access, zero password/hashing calls, and
    reads no request body — it always returns the same fixed HTML string when
    live.
- **`docs/DEVELOPMENT.md`**: updated the "Local username/password login"
  subsection's mode-switch paragraph (removed the "not implemented yet" note
  for `GET /auth/local-login` and stated its gating) and added a new
  paragraph directly under the JSON endpoint's description documenting the
  HTML form's behavior (thin `fetch()` wrapper, success/failure rendering,
  no styling).

### Validation performed

This sandbox permits live socket binding (confirmed via a throwaway
`net.createServer().listen(0, "127.0.0.1", ...)` probe, same check
TASK-009/TASK-015's sessions made), so all validation below used the real
compiled service (`dist/index.js`) over a real loopback socket.

- `npm run build`: TypeScript compiled cleanly with no errors, both
  immediately after the change and again after every subsequent edit
  (`docs/DEVELOPMENT.md` is not compiled, so only `src/index.ts` mattered
  here).

- **No credential-verification logic in the new page** (per the task's own
  validation requirement — "grep the new code for anything resembling a
  password check"):
  ```
  $ sed -n '/const LOCAL_LOGIN_FORM_HTML/,/^`;$/p' src/index.ts \
      | grep -inE "password ===|username ===|scrypt|timingSafeEqual|passwordHash|compare|verify"
  NONE FOUND — clean
  $ sed -n '/const LOCAL_LOGIN_FORM_HTML/,/^`;$/p' src/index.ts | grep -n "fetch("
  32:    fetch("/auth/local-login", {
  ```
  The only server call the page's script makes is that one `fetch()` to the
  existing JSON endpoint; there is no other network call, comparison, or
  hashing operation anywhere in the served HTML/JS.

- **Real headless-browser test**, not a hand-simulated fetch: this sandbox
  has a system Chromium binary (`/usr/bin/chromium`). `puppeteer-core@23`
  was installed **only into a scratch validation directory** (not added to
  this project's `package.json`/`node_modules` — zero new runtime
  dependencies to the shipped service) and used to drive that real browser
  against the actual compiled service, clicking the actual rendered
  `<button type="submit">` and reading the actual DOM afterward — this is a
  genuine browser test, not a simulation of the page's own JS logic.
  - Because the `bt_session` cookie's `Domain` is fixed to `.biztechro.com`
    (CONTRACT-001 §7, unrelated to this task), a real browser correctly
    refuses to store it when the page is served from plain `127.0.0.1` (a
    cookie's `Domain` attribute must be a suffix of the request host) — this
    was confirmed as a browser-policy artifact, not a bug, by checking the
    raw `Set-Cookie` header via `curl -i` (it was present and correct) while
    the same first browser run showed `bt_session cookie present: false`.
    Re-ran with Chromium's `--host-resolver-rules=MAP
    task018-validation.biztechro.com 127.0.0.1` so the browser's origin is a
    real `biztechro.com` subdomain (no `/etc/hosts` edit, and no change to
    the service itself), after which the cookie was stored correctly.
  - Seeded via `node dist/seed.js --client-secret-file=... --local-user-file=...`
    against a fresh scratch `PGLITE_DATA_DIR` (`chmod 700`), `LOCAL_LOGIN=true`,
    creating local user `formtester`. Additional users `disabled-form-user`
    (disabled via `PATCH /admin/users/:id`) and `locked-form-user` (locked via
    10 wrong-password attempts, default threshold) were created through the
    already-reviewed admin API (TASK-016) purely as fixtures for this task's
    own validation — no admin-API code was touched.
  - **Correct credentials** (`formtester`): real browser fill + click →
    `POST /auth/local-login` → `200`; form became `hidden`, `#success-message`
    became visible with exact text `"You're signed in."`; `bt_session` cookie
    present (confirmed via `page.cookies()`, value begins
    `eyJhbGciOiJSUzI1NiIs...`, a real RS256 JWT).
  - **Wrong password** (`formtester` / wrong password): `401`, JSON
    `error: "Invalid username or password."`; rendered `#error-message` text
    identical to the JSON field (`errorText === responseBody.error` →
    `true`); form remained visible (not replaced).
  - **Unknown username**: `401`, identical rendered text
    `"Invalid username or password."` — confirmed merged/generic with the
    wrong-password case, matching CONTRACT-005 §2/§11.
  - **Disabled account** (`disabled-form-user`): `403`, JSON
    `error: "This account has been disabled."`; rendered text verbatim match
    confirmed (`true`).
  - **Locked account** (`locked-form-user`, correct password supplied but
    already locked): `423`, JSON
    `error: "This account is temporarily locked. Try again after
    2026-09-16T00:16:00.629Z."`; rendered text verbatim match confirmed
    (`true`), including the exact ISO 8601 unlock timestamp — confirming no
    reinterpretation/truncation/reformatting of that dynamic value occurs in
    the page's rendering.

- **Gating, both directions, live HTTP** (`curl -i`):
  - `LOCAL_LOGIN=true`: `GET /auth/local-login` → `200`, HTML body containing
    the form and `fetch("/auth/local-login"`.
  - `LOCAL_LOGIN=false` (fresh instance, `TENANT_ID`/`CLIENT_ID` present as
    required in that mode): `GET /auth/local-login` → `404
    {"error":"Not found"}`, byte-identical to a genuine unmatched route
    (`GET /no-such-route-at-all` → the same `404 {"error":"Not found"}`, compared
    side by side); `POST /auth/local-login` (already-reviewed TASK-015
    behavior) still `404` in this mode too, confirming this task did not
    regress the existing gating.

- **Clean shutdown / no lock leakage**: both service instances (`LOCAL_LOGIN=true`
  and `LOCAL_LOGIN=false`) were stopped via `kill <pid>` and confirmed to
  remove `PGLITE_DATA_DIR/.btauthorchestrator.lock` before the next instance
  started; no stale-lock recovery was needed.

### Acceptance criteria evidence

- [x] "`GET /auth/local-login` returns the HTML form when `LOCAL_LOGIN=true`,
  and the same generic 404 as any unmatched route when `LOCAL_LOGIN=false`."
  — confirmed live, both directions, above (including a direct byte-for-byte
  comparison against a genuinely unmatched route).
- [x] "Submitting correct credentials via the form results in a `bt_session`
  cookie being set and a visible 'You're signed in.' confirmation." —
  confirmed via a real headless-browser click-through (Chromium via
  `puppeteer-core`, scratch-only dependency), including the cookie
  (once tested from a `biztechro.com`-matching origin, since the cookie's
  fixed `Domain` attribute is a real-browser-enforced constraint unrelated to
  this task).
- [x] "Submitting incorrect credentials displays the exact error text `POST
  /auth/local-login` returned, unmodified." — confirmed for all four failure
  outcomes (unknown username, wrong password, disabled, locked), each
  compared programmatically against the actual JSON response body's `error`
  field in the same browser session (`errorText === responseBody.error`).
- [x] "No credential-verification logic exists in the page itself." —
  confirmed by grep (above) and by code review: the route handler performs
  no database access and the served script's only network call is the
  `fetch()` to the existing JSON endpoint.

All four of TASK-018's acceptance criteria are met.

### Assumptions and deviations

- **Network-failure (non-JSON-response) rendering is not contract-specified.**
  CONTRACT-005 §11 specifies rendering for the JSON endpoint's success/failure
  *responses* but does not address what the page should show if the `fetch()`
  call itself rejects (e.g. the browser is offline, or the server closes the
  connection before responding) or if `response.json()` fails to parse a
  non-JSON body. I added a `.catch()` showing a fixed "Sign-in failed." string
  for this case, on the narrowest reading that *some* visible feedback is
  better than a silently-inert submit button, without inventing any
  interpretation of a failure the server never actually reported. This path
  is not exercised by CONTRACT-005's own validation requirements and was not
  triggered in this task's validation (the local service was always
  reachable); flagged here rather than silently added.
- **No `Cache-Control` header on the HTML response.** I matched the existing
  `renderHtml()` helper's convention (used by `GET /auth/login`/`GET
  /auth/callback`'s HTML responses), which sets no `Cache-Control` header,
  rather than the JSON admin surface's `no-store` convention — CONTRACT-005
  §11 doesn't specify caching behavior for this page, and this HTML response
  contains no secret material (it's a fixed, static form), so I judged
  matching the project's existing *HTML*-response precedent more consistent
  than borrowing the JSON-response precedent. A narrow implementation
  judgment call, not contract-specified either way.
- **Route placement in the dispatcher.** The new `GET` check was placed
  immediately after the existing `POST /auth/local-login` check (same
  `config.localLogin === true` guard) rather than elsewhere in the handler,
  since they are gated identically and logically belong together; this is a
  code-organization choice with no behavioral effect on route matching order
  (different HTTP methods on the same path never conflict).
- Did not touch `POST /auth/local-login`, `src/password.ts`,
  `src/localUsers.ts`, `src/ipThrottle.ts`, `src/config.ts`, `src/database.ts`,
  `scripts/seed.js`/`src/seed.ts`, or the admin API — all out of this task's
  scope and confirmed unmodified by `git diff` before finalizing this handoff.
- `puppeteer-core` was installed only in a scratch validation directory
  outside this repository, purely as a validation tool for this handoff; it
  is not referenced anywhere in `package.json`, `src/`, or any committed file.

### Unresolved risks / notes across the whole CONTRACT-005 feature (015-018)

This is the last of the four tasks (015-018) implementing CONTRACT-005.
Reviewing all four together, from this task's vantage point:

- **`docs/DEVELOPMENT.md`'s repository-layout list** (added by TASK-015) does
  not mention any new file for TASK-018, which is correct — this task added
  no new `src/` module, only two constants and one route inside the existing
  `src/index.ts`.
- **No retention policy for `local_login_audit`** (CONTRACT-005 §6, explicitly
  deferred per the contract's own text) remains genuinely open, unaffected by
  this task; restating it here only because this task's own validation added
  a modest number of additional audit rows (browser-driven login attempts)
  to a table CONTRACT-005 already flags as able to grow quickly.
- **All three prior tasks (015, 016, 017) are still sitting in
  `tasks/review/`, not `tasks/completed/`** — none have been through human
  acceptance yet. This task's implementation depended on their *code*
  (`POST /auth/local-login`, the admin API used only for validation fixtures,
  and `scripts/seed.js`'s local-user bootstrap) being present and working,
  which it is, but none of the four tasks has been formally accepted. Nothing
  in this task's own scope is blocked by that; flagging it only because
  Patrick asked to be told if anything looked incomplete/inconsistent across
  the whole feature now that all four pieces exist together — the pieces are
  functionally complete and interoperate correctly (this task's own
  validation exercised real rows created via TASK-016's admin API and
  TASK-017's seed-script path against TASK-015's login endpoint, all working
  together without incident), but the lifecycle state (`review/`, not
  `completed/`) reflects that no human acceptance has happened yet for any of
  them.
- **No automated test suite exists for any of the four tasks** — all
  validation across 015-018 has been manual/scripted (`curl`, direct DB
  inspection, and now a real headless browser), re-run by hand each time.
  This matches the project's validation posture so far (no test framework is
  in `package.json`), not a gap specific to this task, but worth naming now
  that the full feature is assembled: a regression in any of the four pieces
  would currently only be caught by re-running these manual scripts.

## Review

Not reviewed.
