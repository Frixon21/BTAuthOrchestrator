# TASK-027: Browser admin console

Owner role: Implementation (interface-designer for UI and UX)
Assigned agent: interface-designer
Proposed by: Patrick
Proposed date: 2026-10-27
Approved by: Patrick
Approved date: 2026-10-27
Related contracts: CONTRACT-010 (supersedes parts of CONTRACT-003 and
CONTRACT-005), CONTRACT-003, CONTRACT-005, CONTRACT-006, CONTRACT-009
Related ADRs: ADR-001
Dependencies: CONTRACT-010 approved; TASK-026 accepted

## Desired outcome

Operators manage local users and signing keys from a polished browser
console at `/admin/console`, with light and dark themes, instead of making
API calls directly. The API's behavior is unchanged.

## Context

Patrick first asked for a second service as a web front end. He then
suggested a single-page JavaScript app instead (2026-10-27). The API has no
CORS support, so a page hosted anywhere else could not call it. Serving the
SPA from this service keeps it on the same origin, the pattern `/api/docs`
and `/admin/reset-password` already use. Patrick decided:

- the console covers every operation the API supports;
- it accepts both bearer tokens;
- it keeps them in `sessionStorage`;
- `/admin/reset-password` stays;
- the console is polished, with light and dark themes.

## Scope

### Included

- Routes and an allow-listed static asset handler for `/admin/console`, per
  CONTRACT-010 §1.
- Console HTML, CSS and JS covering CONTRACT-010 §2–§7.
- Links between the console and `/admin/reset-password`.
- OpenAPI, `docs/DEVELOPMENT.md` and README entries.
- Tests per CONTRACT-010 "Validation requirements".
- After Patrick approves CONTRACT-010, the header-only `Superseded by` edits
  to CONTRACT-003 and CONTRACT-005.

### Excluded

- Any API, authorization, audit or schema change.
- An audit viewer, and console versions of the user-facing sign-in,
  change-password or registration flows.
- Frameworks, a build step, and third-party or CDN assets.
- Changes to the deployed `.env` or the running service.

## Plan

1. Add the console routes and static handler, with the CONTRACT-010 headers,
   reusing the `src/apiDocs.ts` approach where it fits.
2. Build the console, ideally as plain JS modules with no build step, kept
   in a folder such as `src/console/` that the build copies to `dist/` or
   embeds in the build output.
3. Implement token handling and the API client first, then the Overview,
   Users, Signing keys and Settings areas.
4. Add the theme system and the responsive and accessibility work.
5. Write the tests, update the docs, and do the manual browser check.

## Acceptance criteria

- [ ] `/admin/console` and its assets are served in both modes with the
      CONTRACT-010 §1 headers. Unknown and traversal paths return `404`.
- [ ] Every API operation in the CONTRACT-010 Inputs and outputs table works
      from the console. Each token goes only to its own endpoints.
- [ ] Tokens persist in `sessionStorage` only. A `401` clears the matching
      token, and "Forget all" clears both.
- [ ] Delete and rotation require typed confirmation.
- [ ] All dynamic text is rendered as text. There are no inline scripts or
      styles, and none of the APIs CONTRACT-010 §6 forbids.
- [ ] Light, dark and system themes work, meet AA contrast, and work at
      360px width and with only a keyboard.
- [ ] The existing test scripts pass unchanged.

## Validation requirements

- `npm run build`
- the new console test script
- every existing `scripts/test-*.js`
- `git diff --check`
- the manual browser check from CONTRACT-010, recorded in the handoff

## Risks and assumptions

- Keeping tokens in `sessionStorage` means any script injected on this origin
  could read them. The strict CSP, text-only rendering and the ban on inline
  code are the main defenses, which is why the contract sets them as hard
  requirements.
- A shared machine leaves tokens available until the tab closes. The
  "Forget all" action exists for this.
- Creating users from the console still depends on
  `ALLOW_NEW_LOCAL_LOGIN_CREATION` (CONTRACT-010 open question 1).
- The build currently runs `tsc` only. Shipping static console files may
  need a copy step or embedded strings. The implementer chooses, and records
  the choice in the handoff.

## Blocker

None for the contract: Patrick approved CONTRACT-010 on 2026-10-27 and
answered its open questions inline. The answers were (a) accept that
creation depends on the registration switch, keep linking to the
user-facing pages, use `/admin/console`, and store the theme in
`localStorage`. This task still needs Patrick's approval. Its listed
dependency, TASK-026's acceptance, is pending; TASK-026 is committed but
still in `review/`.

## Implementation handoff

Task: TASK-027 Browser admin console
Implementer: interface-designer
Date: 2026-10-27

### Changes made

- `src/console/index.html`, `app.js`, `theme.js`, `app.css` (new): the console.
  It is plain HTML, CSS and JS with no framework or build tool, and covers
  Overview, Users (list, filter, detail, create, email, enable/disable,
  reset, delete), Signing keys (JWKS with show/copy modulus, and emergency
  rotation) and Settings (two tokens, acting-as label, Forget all).
  The theme picker (System/Light/Dark) sits in the header.
  `theme.js` loads in `<head>` so an explicit theme applies before first paint.
- `src/adminConsole.ts` (new): a GET/HEAD handler driven by a fixed URL-to-file
  map (`/admin/console`, `/admin/console/`, `app.js`, `theme.js`, `app.css`).
  It sends the exact §1 headers. Anything else falls through to the generic
  404, and request paths never build a filesystem path. If a file is
  missing it returns 500 JSON and logs a message, following the
  `apiDocs.ts` precedent.
- `src/index.ts`: wires the handler right after the API docs handler and adds
  an "Open the admin console" link to `/admin/reset-password`. No API,
  authorization, audit or schema change.
- `src/openapi.ts`: adds `/admin/console` and `/admin/console/{asset}` (tag
  "Admin console"), and notes the console link on `/admin/reset-password`.
- `scripts/copy-console-assets.js` (new), and in `package.json` `build` is now
  `tsc && node scripts/copy-console-assets.js`.
- `scripts/test-admin-console.js` (new).
- `scripts/test-local-password-change.js`: the public-page link check now
  asserts that no public page links to `/admin/reset-password` or
  `/admin/console`.
- Docs: `docs/DEVELOPMENT.md` (layout, build note, new "Browser admin console
  (CONTRACT-010)" section, validation list, reset-page note) and `README.md`
  (build command, endpoint row, "Admin console" section).
- Contract headers only: CONTRACT-003 gains a `Superseded by:` line naming
  CONTRACT-010 for the UX-expectations statement. CONTRACT-005's existing
  line is extended with CONTRACT-010 for the browser admin UI exclusion. No
  contract body was edited.

**Asset-shipping choice:** a copy step in `npm run build`, not embedded
strings. The files stay as normal, directly editable `.html/.js/.css` in
`src/console/` and end up in `dist/console/`. This works with TASK-025
provided its Dockerfile build stage runs `npm run build`, not bare `tsc`,
and the runtime stage copies `dist/`. TASK-025's text currently says
"(`npm ci`, `tsc`)", so whoever implements it needs to know this. Every
existing script and doc already uses `npm run build`.

### Validation performed

- `npm run build`: exit 0 (tsc, then "Copied 4 admin console files").
- `node scripts/test-admin-console.js`: exit 0, 10 PASS lines.
- `node scripts/test-api-docs.js`: exit 0.
- `node scripts/test-local-password-change.js`: exit 0, 7 PASS lines.
- `node scripts/test-local-registration.js`: exit 0.
- `git diff --check`: exit 0. It does not cover untracked files, so the new
  files were checked separately for trailing whitespace and final
  newlines; none were found.
- Mutation sanity check: two faults were injected into `dist/console/app.js`
  only. One sent the admin token on `POST /admin/users`; the other enabled
  delete without the typed confirmation. The test failed on both. The
  build was then re-run to restore dist.
- **Manual browser check: NOT performed.** No real browser was available in
  the implementer's environment. See "Unresolved risks" for the checklist.

### Acceptance criteria evidence

- Serving: the test requests the page, `/admin/console/`, a query-string
  variant and every asset with GET and HEAD. It covers all four
  combinations of LOCAL_LOGIN and ALLOW_NEW_LOCAL_LOGIN_CREATION, and
  `deepEqual`s the full header set. It sends 15 unknown or traversal paths
  (`..`, `%2e%2e`, `%2E%2E%2F`, `..%2f`, backslashes, `./`, double slash,
  case variants, `index.html`, encoded letters) plus POST/PUT/DELETE, and
  each one returns a 404 identical to an unmatched route. The handler is
  built with a store that throws if touched.
- API operations and token isolation: the VM-run console calls the real
  request handler, backed by an isolated PGlite database with a real
  signing key. Each call's method, URL, body and Authorization are checked
  against the CONTRACT-010 table for:
  - health and OpenAPI
  - list, view, create, PATCH email, PATCH isActive, PATCH password,
    DELETE
  - JWKS and rotation

  The database confirms the effects, including `actor_label` and
  `triggered_by` set to the acting-as label. `checkIsolation` asserts
  that across every recorded call, neither token appears anywhere except
  its own endpoints' Authorization header. It also asserts that no token
  appears in the page text or attributes, the title, the console log or
  localStorage. The admin token is never sent on `POST /admin/users`.
- Storage: tokens are written to sessionStorage under fixed keys, and
  localStorage stays empty apart from the theme.
  - A 401 on the user list clears only the admin token.
  - A 401 on rotation clears only the emergency token.
  - Forget all clears all three session keys and the form fields.
  - When sessionStorage throws, the console falls back to memory, shows
    a notice and still sends the token.
- Typed confirmation: delete stays disabled, and form submission is
  ignored, for near-miss inputs (`new.admi`, `New.Admin`, ` new.admin`).
  Rotation does the same for `rotate`, `ROTATE `, `ROTAT`. In every case
  zero requests are sent. The action proceeds only on the exact text.
- Text rendering: the fake DOM throws on `innerHTML`, `outerHTML`, `style`
  and `insertAdjacentHTML`, and on any `on*` or `style` attribute.
  - A markup email from the API renders as text.
  - A markup API error renders as text.
  - No `<img>` element ever exists in the DOM.
  - Static regex checks cover inline script, `on*=` and `style=` in the
    HTML, the §6-forbidden APIs in the JS, and external URLs, `@import`
    and `url(` in all files.
- Other behavior covered:
  - a 403 on create shows the registration-switch explanation plus the
    API text
  - passwords are cleared after success, after a 400 and after the 403
  - 5xx, non-JSON and network failures show a generic message
  - a failed DELETE is sent exactly once
  - an in-flight request disables its button and sets `aria-busy`, and a
    second submit sends nothing
  - dialogs trap Tab and Shift+Tab, close on Escape or `cancel`, and
    restore focus
  - mode detection works from real local and Entra OpenAPI documents and
    from a sample document; an unavailable document gives "Unknown" and
    hides the mode-specific links
- Themes: selecting a theme sets or removes `data-theme` and persists it in
  localStorage. A reload restores it. It still works when localStorage
  throws. Computed WCAG contrast passes for 25 text pairs (4.5:1 or more)
  and 7 UI pairs (3:1 or more) in both palettes. The lowest text ratio is
  5.41:1 and the lowest UI ratio is 3.59:1. The test also asserts that the
  two dark-palette CSS blocks are identical. Layout at 360px and real
  keyboard use are **not** browser-verified (see below).
- Existing tests pass. `test-local-password-change.js` received the one
  edit described above.

### Assumptions and deviations

- `actedBy` is also sent on `POST /admin/users` when a label is set, because
  §2 says "user writes". The API ignores it (creation is attributed to
  public-registration), and the Settings text says so. DELETE has no body,
  so it carries no label.
- 5xx responses show a generic message rather than the API's `error` string,
  following the Failure behavior table.
- The username sent on create is exactly what was typed. The client only
  validates the trimmed, lowercased form, so the server stays authoritative.
- The console sends `cache: "no-store"` on its fetches and does not change
  the fetch `credentials` default.
- CONTRACT-003 had no `Superseded by:` line, so one was added to its header
  block. CONTRACT-005's line was extended as instructed.
- The acceptance criterion "existing test scripts pass unchanged" conflicts
  with the instruction to update the public-link test. The test was
  extended (not weakened), as instructed.
- Extra hardening beyond the contract: `<meta name="referrer"
  content="no-referrer">` and a `data:` favicon to avoid a 404.

### Unresolved risks

- **Manual browser check is still required (Patrick):**
  1. Open `/admin/console` with Light, Dark and System selected (toggle the
     OS theme for System). Confirm there is no flash of the wrong theme on
     reload with an explicit choice.
  2. At 360px width (devtools device mode), check each of the four areas,
     with no horizontal page scrolling. Confirm the users table reflows into
     stacked cards below about 704px, that long emails, kids and the
     modulus wrap, and that dialogs fit the screen.
  3. Keyboard only:
     - the skip link
     - the tabs
     - every form
     - the Manage buttons
     - Show/Hide token
     - the delete and rotate dialogs: Tab and Shift+Tab stay inside, Escape
       closes, and focus returns to the opener (or to the section heading
       after a delete)
     - visible focus rings in both themes
  4. Contrast spot-check with a browser tool on body text, hint text, the
     primary and danger buttons, badges, and the danger zone in both themes.
  5. Optionally, confirm the browser console shows no CSP violations, and
     that Copy modulus works over https or localhost (clipboard needs a
     secure context; otherwise the console shows a fallback message).
- Tokens in sessionStorage can be read by any script running on this origin
  (accepted in the task). The defenses are CSP, text-only rendering and no
  inline code.
- The table reflow uses explicit ARIA table roles to keep semantics, but
  this has not been checked with a real screen reader.
- If a deployment runs bare `tsc` instead of `npm run build`, the console
  returns 500 "Unable to load the admin console" (see TASK-025 note).

### Documentation updated

`README.md`, `docs/DEVELOPMENT.md`, `src/openapi.ts`, and the CONTRACT-003 and
CONTRACT-005 headers.

## Review

Not reviewed.
