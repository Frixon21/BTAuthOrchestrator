# CONTRACT-010: Browser admin console

Status: Approved
Approved by: Patrick
Approved date: 2026-10-27
Related tasks: TASK-027
Related ADRs: ADR-001
Supersedes:
- CONTRACT-005 for its exclusion of any browser-rendered admin UI. CONTRACT-009
  had already lifted that exclusion for the password-reset page only; this
  contract lifts it for the console defined here.
- CONTRACT-003 for its "UX expectations" statement that no browser-facing UI
  is provided for the emergency rotation trigger.

All other behavior in CONTRACT-003, CONTRACT-005, CONTRACT-006 and
CONTRACT-009 remains in force.
Superseded by:

## Purpose

Give operators a browser console for everything the service's HTTP API
supports, so they no longer need `curl` or Swagger. Patrick made these
decisions on 2026-10-27:

- The console is a single-page app served by this service itself, not a
  second service. No new process or port is added, and because the console
  runs on the API's own origin, no CORS is needed.
- It covers every operation the API supports.
- It accepts both `LOCAL_USER_ADMIN_TOKEN` and `EMERGENCY_ROTATION_TOKEN`,
  each entered separately.
- It keeps tokens in `sessionStorage`.
- The existing `/admin/reset-password` page stays.
- The console is polished, with light and dark themes.

The console is a client of the existing API only. It adds no server-side
business logic, endpoints, credentials or authorization rules.

## Scope

### Included

- `GET /admin/console`, which serves the console page.
- Static assets for the console under `/admin/console/`.
- These console areas:
  - **Overview:**
    - service health
    - active login mode
    - links to the user-facing and documentation pages that exist in that
      mode
  - **Users:**
    - list, search and view users
    - create a user
    - change a user's email
    - enable or disable a user
    - reset a user's password
    - delete a user
  - **Signing keys:**
    - view the published JWKS keys
    - trigger emergency key rotation
  - **Settings:**
    - enter or forget each token
    - set an optional "acting as" label
    - choose a light, dark or system theme
- OpenAPI, `docs/DEVELOPMENT.md` and README entries for the new routes.

### Excluded

- Any new or changed API endpoint, request or response shape, credential,
  authorization rule, or audit behavior.
- Viewing audit tables, because no API reads them yet.
- Rebuilding the sign-in, Entra sign-in, change-password or registration
  flows inside the console. The console links to the existing pages instead.
- Accounts, sessions or roles for the console itself. Access depends only on
  holding the bearer tokens.
- Frameworks, a build step, CDN or third-party assets, web fonts, and
  external network calls.
- Removing or changing `/admin/reset-password`.

## Actors

- **Operator**: holds `LOCAL_USER_ADMIN_TOKEN`, `EMERGENCY_ROTATION_TOKEN`,
  or both.
- **Browser**: runs the console and stores tokens in `sessionStorage`.
- **BTAuthOrchestrator**: serves static files and answers API calls
  exactly as it does today.

## Inputs and outputs

The console calls only these existing same-origin endpoints:

| Console action | API call | Token sent |
|---|---|---|
| Health | `GET /health` | none |
| Login mode | `GET /api/openapi.json` | none |
| Public keys | `GET /.well-known/jwks.json` | none |
| List or search users | `GET /admin/users` | user-admin |
| View user | `GET /admin/users/:id` | user-admin |
| Create user | `POST /admin/users` | none (see §4) |
| Edit email, enable or disable, reset password | `PATCH /admin/users/:id` | user-admin |
| Delete user | `DELETE /admin/users/:id` | user-admin |
| Emergency rotation | `POST /admin/emergency-rotate-keys` | emergency |

Requests and responses are as the existing contracts define them.

## Preconditions

- The endpoints above exist as currently implemented and documented in
  `src/openapi.ts`.

## Required behavior

### 1. Serving

- `GET /admin/console` serves the console HTML in both login modes,
  regardless of `ALLOW_NEW_LOCAL_LOGIN_CREATION`, with no authentication.
  Like `/admin/reset-password`, the page is static and contains no user data.
  Every action the console performs is authorized by the API.
- `GET /admin/console/` redirects to `/admin/console` or serves the same page.
- Static assets are served only from a fixed allow-list of files under
  `/admin/console/`, such as `app.js` and `app.css`, with correct content
  types. Any other path under `/admin/console/` returns the generic `404`.
  Request paths must never be resolved against the filesystem.
- Every console response carries these headers:
  - `Cache-Control: no-store`
  - `X-Content-Type-Options: nosniff`
  - a Content-Security-Policy at least as strict as the API docs page's:
    `default-src 'none'; script-src 'self'; style-src 'self';
    img-src 'self' data:; connect-src 'self'; base-uri 'none';
    form-action 'none'; frame-ancestors 'none'`
- The page contains no inline scripts, inline event handlers or inline
  styles. Because `style-src` has no `'unsafe-inline'`, the code sets
  element styles through classes, not `style` attributes.
- No public page links to the console. The console links to
  `/admin/reset-password`, and `/admin/reset-password` links to the console.

### 2. Tokens and session storage

- The settings area has separate fields for the user-admin token and the
  emergency token. Each field is a password input that can be shown or
  hidden.
- When the operator saves a token, it is written to `sessionStorage` under
  its own fixed key, so it lasts for that browser tab until the tab closes.
  Tokens are never written to `localStorage`, cookies, the URL, the page
  title, the console's log output, or any error message.
- The user-admin token is sent only to `/admin/users*` requests, and the
  emergency token only to `POST /admin/emergency-rotate-keys`. Each is sent
  as `Authorization: Bearer <token>` on same-origin requests. No other
  request carries either token, including `POST /admin/users`.
- Each token has a "Forget" action, and a "Forget all" action clears both
  tokens and the acting-as label from `sessionStorage` and from the form.
- When an API call returns `401`, the console:
  - removes the token that call used from `sessionStorage`;
  - shows that the token was rejected;
  - asks the operator to enter it again;
  - leaves the other token untouched.
- The console shows which tokens are present without ever displaying their
  values, unless the operator chooses to show the input.
- The optional "acting as" label is stored in `sessionStorage`. The console
  sends it as `actedBy` on user writes and as `triggeredBy` on rotation. The
  console states that this label is self-asserted and not verified.

### 3. Overview

- **Health:** the console shows the result of `GET /health`, or an
  "unreachable" state if the request fails.
- **Login mode:** the console reads the mode from `GET /api/openapi.json`. The
  mode is local when the document includes a `/auth/local-login` path, and
  Entra otherwise.
- **Links:** the console links to `/api/docs`, `/auth/local-register`,
  `/admin/reset-password`, and the sign-in and change-password pages that
  exist in the current mode.

### 4. Users

- **List:** shows username, email, status (Active or Disabled), created time
  and updated time. It can be filtered on the client by username or email,
  and refreshed on demand. Timestamps are shown in the browser's local time.
- **Detail:** opens from a list row and loads `GET /admin/users/:id`.
- **Create:**
  - The form asks for username, email, password and confirmation.
  - The console checks before sending that the two passwords match, the
    password is at least 12 characters, and the username has 3–64 characters
    from `a-z`, `0-9`, `.`, `-` and `_` once trimmed and lowercased. The
    server's response is still authoritative.
  - The request goes to `POST /admin/users` without a token.
  - When the API returns `403` because public creation is disabled, the
    console explains that creating users requires
    `ALLOW_NEW_LOCAL_LOGIN_CREATION=true` plus a restart. It also shows the
    API's error text.
  - The console states that while that setting is on, anyone who can reach
    the service can create an account (CONTRACT-006).
- **Edit email**, **Enable/Disable**, and **Reset password** (new password
  and confirmation) each send a single-field `PATCH`.
  - The console warns that a disabled user's existing sessions stay valid
    until they expire.
  - It notes that a reset unlocks the account, does not re-enable it, and
    keeps existing sessions.
- **Delete:** the operator must type the target username exactly before the
  delete button becomes active. The confirmation says the delete is
  permanent and that audit history is kept.
- After any successful write, the console updates the list from the API's
  response or refreshes it, and shows a confirmation.

### 5. Signing keys

- **Public keys:** shows `kid`, `alg` and `use` for each key from
  `GET /.well-known/jwks.json`. The modulus can be shown on request and
  copied. The console notes that JWKS includes the current key and retired
  keys, and leaves out revoked keys.
- **Emergency rotation:**
  - The rotation action is visually separated from the rest of the page and
    styled as dangerous.
  - The confirmation explains that rotation immediately invalidates every
    session signed with the current key, for any verifier that fetches a
    fresh JWKS.
  - The operator must type `ROTATE` before the action becomes active.
  - On success, the console shows `previousKid`, `newKid` and `rotatedAt`,
    and refreshes the key list.
  - The emergency token is used only for this action.

### 6. Feedback, errors and safety

- Each action shows a pending state, and its submit control is disabled while
  the request is in flight, so double submission is impossible.
- API error responses are shown using the API's `error` string. Network
  failures and non-JSON responses get a generic message. Destructive actions
  are never retried automatically.
- All server-provided and user-entered text is rendered as text nodes or
  `textContent`. The console never uses `innerHTML`, `insertAdjacentHTML`,
  `document.write`, `eval`, `new Function`, or string-built event handlers.
  All values from the API are treated as untrusted, including usernames and
  emails.
- Passwords entered in console forms are never stored. After a request
  finishes, whether it succeeds or fails, the password fields are cleared.

### 7. Look and feel

- The visual design is clean and consistent, using a small set of CSS custom
  properties for color, spacing, radius and type. The layout navigates
  between the four areas.
- **Light and dark themes:**
  - The default theme follows `prefers-color-scheme`.
  - A theme control offers System, Light and Dark. The choice is stored in
    `localStorage` and the console still works if storage is unavailable.
  - Both themes meet WCAG 2.1 AA contrast (4.5:1 for body text, 3:1 for
    large text and UI components).
- **Responsive layout:** the console works at phone width (from 360px) with
  no horizontal page scrolling. Tables reflow or scroll inside their own
  container.
- **Accessibility:**
  - Every input has a label.
  - Focus states are visible.
  - Dialogs trap focus and close with Escape.
  - The console can be fully operated with a keyboard.
  - Status messages are announced through an `aria-live` region.
- The console uses system font stacks only, with no external assets.

## Postconditions and invariants

- Every state change the console can make goes through an existing API
  endpoint, with that endpoint's own authorization and audit.
- Tokens exist only in that browser tab's `sessionStorage` and in requests to
  their own endpoints.
- Removing the console would leave the API's behavior unchanged.

## Failure behavior

| Condition | Console behavior |
|---|---|
| Token missing for an action | Action disabled, with a prompt to add the token |
| `401` | That token is cleared and re-entry is requested |
| `403` on create | Explains the registration switch and shows the API text |
| `404`, `409` or `400` | Shows the API's `error` text in context |
| `500`, network error, non-JSON | Generic error; destructive actions not retried |
| `sessionStorage` unavailable | Tokens are held in memory only, with a notice |
| `/api/openapi.json` unavailable | Mode shown as unknown; mode-specific links hidden |

## Interfaces

| Method and path | Gate | Auth | Headers |
|---|---|---|---|
| `GET /admin/console` (and `/admin/console/`) | always | none | no-store, nosniff, CSP |
| `GET /admin/console/<allow-listed asset>` | always | none | no-store, nosniff, CSP, correct `Content-Type` |

## UX expectations

The console should feel like a small, finished internal tool:

- clear navigation between its four areas
- destructive actions that are hard to trigger by accident
- confirmation messages after writes
- empty, loading and error states for every list

Wording uses plain language. Error text from the API is shown as written.

## Validation requirements

Isolated handler tests, in the style of the existing `scripts/test-*.js`
files, cover:

- **Serving and headers:**
  - console HTML and each allow-listed asset are served in both login modes
    with the exact headers in §1
  - unknown and traversal paths (`..`, encoded `%2e%2e`, backslashes) under
    `/admin/console/` return the generic `404`
- **Static checks** on the served files:
  - no inline `<script>` content, `on*=` attributes or `style=` attributes
  - none of the APIs §6 forbids appear in the JavaScript
- **Console script behavior**, run in a VM with DOM, `fetch` and
  `sessionStorage` stand-ins as earlier tests did:
  - each action sends exactly the method, URL, body and `Authorization`
    header the table in Inputs and outputs specifies
  - neither token is sent anywhere else
  - a `401` clears only the matching token
  - "Forget all" clears storage
  - password fields are cleared after success and after failure
  - the delete and rotate confirmations block the request until the exact
    text is typed
  - API error strings are rendered as text, using a markup payload
  - the `403` create message is shown
  - mode detection works from a sample OpenAPI document
- **Unchanged API:** the existing test scripts still pass.
- **Manual browser check, recorded in the handoff:**
  - light and dark themes
  - the 360px layout
  - keyboard-only operation
  - a contrast spot-check

## Open questions

1. **Creating users when registration is off.** The API allows creation only
   when `ALLOW_NEW_LOCAL_LOGIN_CREATION=true`, even with the admin token, so
   the console can't create users otherwise. Options:
   - (a) accept that, and have the console explain it (drafted above);
   - (b) add admin-token-authorized creation, which is an API change that
     needs its own contract.
- a

   Recommended: (a) now, with (b) as an optional follow-up.
2. **User-facing flows.** The draft links to the existing sign-in,
   change-password and registration pages instead of rebuilding them in the
   console. Recommended: keep linking.
- keep linking
3. **Path.** Is `/admin/console` the right path?
- yes
4. **Theme choice in `localStorage`.** Only the theme preference is stored
   there, and it is not secret. Alternatively it could go in `sessionStorage`
   with the tokens. Recommended: `localStorage`, so the theme is remembered
   across visits.
- localstorage is fine.