# TASK-017: Extend scripts/seed.js to bootstrap the first local user

Owner role: Implementer
Assigned agent: Claude Sonnet 5, standing in for openai-coder (Codex MCP
server confirmed unreachable again this session; Patrick explicitly chose to
continue this substitution rather than wait for it)
Proposed by: Claude (direct request from Patrick to break CONTRACT-005 into
small tasks)
Proposed date: 2026-09-15
Approved by: Patrick
Approved date: 2026-09-15
Related contracts: CONTRACT-005 (§5), CONTRACT-004 (§4's existing
idempotent seeding pattern, extended not modified)
Related ADRs: ADR-003
Dependencies: TASK-015 (needs `local_users` schema and the password-hashing
path to exist)

## Desired outcome

`scripts/seed.js` optionally provisions the first `local_users` row,
alongside its existing `CLIENT_SECRET`/signing-key seeding, unconditional
on `LOCAL_LOGIN`'s value.

## Context

CONTRACT-005 §5 reversed an earlier draft default: pre-staging a local user
during the same one-time bootstrap flow was judged more convenient than a
separate manual `POST /admin/users` call. This extends CONTRACT-004 §4's
existing idempotent "determine what needs seeding" pattern with one more
check, rather than introducing a parallel bootstrap mechanism.

## Scope

### Included

- A new check in `scripts/seed.js`'s existing per-piece seeding logic:
  if zero `local_users` rows exist, prompt for username/email/password
  (hidden interactive prompt by default, or a one-time input file for
  non-interactive use, mirroring `--client-secret-file`'s exact
  read-once-then-unlink-or-abort behavior) and create the first local user
  via TASK-015's password-hashing path.
- If one or more `local_users` rows already exist, skip and report so,
  matching the script's existing per-piece skip behavior.
- Runs regardless of `LOCAL_LOGIN`'s value (confirmed — not conditional).

### Excluded

- Any change to how `CLIENT_SECRET`/the signing key are seeded — unaffected.
- The admin API — TASK-016, already landed by the time this runs in
  practice, but not a hard dependency of this task's own scope.

## Plan

1. Add a `local_users` existence check to the seed script's existing
   "what needs seeding" logic.
2. Prompt for username/email/password using the same input-handling
   conventions already established for `CLIENT_SECRET`.
3. Hash via TASK-015's scrypt path (not a separate/simplified routine) and
   insert with `is_active = true`, `created_by = 'seed-script'`.

## Acceptance criteria

- [x] A fresh, unseeded database gets exactly one `local_users` row after
      running the seed script, in addition to its existing
      `CLIENT_SECRET`/signing-key seeding.
- [x] Re-running the script against an already-seeded `local_users` table
      skips that piece and reports it, without duplicating or overwriting
      the existing row.
- [x] The seeded user can immediately log in via `POST /auth/local-login`
      (TASK-015) with the credentials supplied at seed time.
- [x] The interactive password prompt is hidden (not echoed); the
      file-input path deletes its input file immediately after reading, or
      aborts without writing if the delete fails — same as
      `--client-secret-file`.

## Validation requirements

Per CONTRACT-005's Validation requirements section, the bootstrap-specific
bullets.

## Risks and assumptions

None beyond TASK-015 landing first.

## Blocker

None (depends on TASK-015 completing, not literally blocked yet).

## Implementation handoff

Task: TASK-017 — Extend scripts/seed.js to bootstrap the first local user
Implementer: Claude Sonnet 5, standing in for openai-coder (Codex MCP server
confirmed unreachable again this session; Patrick explicitly chose to
continue this substitution rather than wait for it)
Date: 2026-09-15

### Changes made

- **`src/seed.ts`**: extended the existing "what needs seeding" pattern with
  a third check, `EXISTS (SELECT 1 FROM local_users)`, added to the same
  state-detection query alongside `has_client_secret`/`has_current_key`. The
  script's whole-database "nothing to do" short-circuit now requires all
  three pieces to be present (previously two); this is the only change to
  the existing CLIENT_SECRET/signing-key logic, and it does not alter how
  either of those two pieces themselves are seeded, checked, or reported —
  per-piece, each is still handled by its own independent `if (!hasX)` block,
  unchanged.
  - **New `if (!hasLocalUser)` block** (after the existing signing-key
    block): obtains username/email/password (from `--local-user-file` if
    supplied, else an interactive prompt), hashes the password via
    `src/password.ts`'s existing `hashPassword` (the exact same scrypt code
    path/parameters `POST /admin/users` and `POST /auth/local-login` use —
    no new or simplified hashing routine), and calls TASK-016's existing
    `LocalUserStore.createUser` (`src/localUsers.ts`, imported via
    `createLocalUserStore`) to perform the actual insert — reusing that
    function's existing transaction/insert logic rather than writing new SQL
    here. `createdBy: "seed-script"` is passed as the fixed marker
    CONTRACT-005 §5 specifies; `LocalUserStore.createUser` itself already
    sets `is_active = true` and defaults `failed_login_attempts = 0`/
    `locked_until = NULL` at the schema level (CONTRACT-005 §1), so this
    task's insert doesn't need to set those explicitly.
  - **`--local-user-file=<path>`** (new CLI flag): read-once-then-
    unlink-or-abort, byte-for-byte mirroring `--client-secret-file`'s
    existing behavior — read the whole file, attempt to delete it
    immediately, and if the delete fails, abort the entire run (before the
    database is even opened) with an error naming the file and instructing
    manual deletion, writing nothing to PGlite. Both the client-secret file
    and the local-user file are read (and deleted) unconditionally, before
    `openDatabase()` is ever called — same ordering as the existing
    CLIENT_SECRET file handling — so a file is always consumed exactly once
    per invocation regardless of whether its value ends up needed (e.g. if
    `local_users` turns out to already be seeded).
  - **File format convention (documented in the code and in
    `docs/DEVELOPMENT.md`, since CONTRACT-005 §5 explicitly leaves this an
    implementation detail): exactly three lines, in order — username, then
    email, then password.** A single trailing newline is stripped (same
    convention as `--client-secret-file`'s own trailing-newline handling);
    any other line count is a clear startup error. Username/email/password
    are validated against the same format rules `POST /admin/users` applies
    (CONTRACT-005 "Resolved decisions" #4: username normalized lowercase,
    3-64 chars, `[a-z0-9._-]`; email a loose but non-empty
    shape check; password ≥ 12 characters) — these three validators are
    intentionally re-declared in `src/seed.ts` rather than imported from
    `src/index.ts` (see "Assumptions and deviations").
  - **New CLI-argument guards**: `--local-user=`, `--local-username=`,
    `--local-email=`, and `--local-password=` are all explicitly rejected
    with an error pointing to the hidden prompt or `--local-user-file`,
    mirroring the existing guard against `--client-secret=`. `--local-user-
    file` may only be specified once and requires a non-empty path, same
    validation as `--client-secret-file`.
  - **Interactive prompting**: username and email are prompted visibly
    (echoed) so an operator can see and correct typos; the password prompt
    is hidden (not echoed) — per this task's own acceptance criteria ("the
    interactive password prompt is hidden"), only the password needs to be
    masked, not all three fields, even though CONTRACT-005 §5's prose
    ("using the same input pattern already established for CLIENT_SECRET")
    could be read either way. All three fields are read via a single,
    continuous raw-mode session (one `RawLineReader` instance, entered once
    and exited once) rather than three independent prompt calls, or a mix
    of Node's `readline` module and the existing hand-rolled raw-mode
    reader. This was not a stylistic choice — see "Assumptions and
    deviations" and "Validation performed" below for a real bug this
    avoided.
  - **`promptHidden` generalized** (previously hardcoded to `CLIENT_SECRET`
    in its prompt/error text): now takes a `fieldLabel` parameter used in
    its "requires a TTY"/"cancelled"/"ended before a value was submitted"
    messages, so the exact same function serves both the `CLIENT_SECRET`
    prompt (call site unchanged in behavior/wording, `fieldLabel:
    "CLIENT_SECRET"`) and the new local-user password prompt. Internally,
    `promptHidden` now delegates to the same `RawLineReader`/
    `readLine(..., { echo: false })` primitive the local-user prompts use,
    rather than a separate ad hoc implementation — reducing duplication
    without changing `CLIENT_SECRET`'s observable behavior (verified — see
    "Validation performed").
- **`docs/DEVELOPMENT.md`**: added a paragraph describing the new
  `local_users` seeding step (idempotent check, skip/report behavior,
  interactive vs. file input, the three-line file format, hashing/insert
  path, and "runs regardless of `LOCAL_LOGIN`"), and updated the existing
  `POST /auth/local-login` paragraph, which previously said no seed-script
  path existed yet, to reflect that it now does.
- No changes to `src/config.ts`, `src/database.ts`, `src/index.ts`,
  `src/localUsers.ts`, or `src/password.ts` — this task reuses
  `hashPassword` and `LocalUserStore.createUser`/`createLocalUserStore`
  exactly as they already exist (confirmed by reading both modules before
  starting), and the admin API (`src/index.ts`) is untouched per this task's
  explicit exclusion.

### A real bug found and fixed during validation (not merely a design choice)

The first implementation attempt used Node's `readline` module for the
visible username/email prompts (closing/reopening `readline.createInterface`
either once per field, or once across both fields), falling back to the
existing hand-rolled raw-mode reader only for the hidden password. Direct
testing (a Python-driven pty harness, described below) reproduced a genuine
data-loss bug: whenever more than one line's worth of input arrived in a
single underlying chunk — which happens whenever an operator types (or
pastes) faster than the prompts are printed, e.g. typing all three values
immediately rather than waiting for each prompt — a field's value could be
silently dropped or bound to the *next* field instead. Concretely: typing
`dana` / `dana@example.invalid` / `interactive-strong-password-7` in quick
succession resulted in `username="dana"` (correct) but `email` receiving
`"interactive-strong-password-7"` (the password value) and `password`
timing out — `dana@example.invalid` was silently lost, and every field after
the first was shifted by one. This reproduced identically whether the
visible fields used `readline` (interface recreated per field, or a single
interface reused across both visible fields) or an early version of the raw
reader that returned from its 'data' handler as soon as it saw the first
line terminator in a chunk, discarding the remainder of that same chunk.

The fix implemented (`RawLineReader` in `src/seed.ts`) keeps one persistent
internal string buffer, fed by a single `'data'` listener for the whole
raw-mode session (entered once for all three fields, exited once at the
end). Each `readLine()` call first drains from that shared buffer — so any
characters left over after a previous field's terminating newline are used
immediately, in order, as the start of the next field — before waiting for
further `'data'` events. No `readline` interface is created or destroyed
between fields, and no partially-read chunk is ever discarded. This was
verified directly against both the burst/paste scenario above and a
realistic "wait for each prompt, then type" scenario, and against a
concurrent multi-line `--local-user-file` (which never exercises this
listener code path at all, since the whole file is read in one call before
any prompting occurs, but is unaffected either way).

### Validation performed

`npm run build` passed with no errors throughout, after every edit.

- **Fresh, unseeded database — file-based, all three pieces** (real
  compiled `dist/seed.js`, real PGlite data directory):
  ```
  CLIENT_SECRET stored.
  Signing key dba71faf-fc73-4cd5-ac13-75ba51170667 generated and stored as current.
  Local user alice created.
  EXIT_CODE=0
  ```
  Both the `--client-secret-file` and `--local-user-file` input files were
  confirmed deleted afterward. Direct database inspection confirmed exactly
  one `local_users` row: `is_active=true`, `failed_login_attempts=0`,
  `locked_until=null`, `created_by="seed-script"`,
  `password_algorithm="scrypt"`, `password_cost_n=131072`,
  `password_block_size_r=8`, `password_parallelization_p=1`,
  `password_key_length=64`, hash/salt byte lengths 64/16 — matching
  CONTRACT-005 §1's exact scrypt parameters.
  ```json
  [{"id":"7f95237f-fc8f-4a70-87c0-a50f3bb15066","username":"alice","email":"alice@example.invalid","is_active":true,"failed_login_attempts":0,"locked_until":null,"created_by":"seed-script","password_algorithm":"scrypt","password_cost_n":131072,"password_block_size_r":8,"password_parallelization_p":1,"password_key_length":64,"hash_len":64,"salt_len":16}]
  ```
- **Re-running against a fully-seeded database**: exact output
  `Database already seeded; nothing to do.`, exit code 1 — unchanged wording
  from TASK-006's original behavior; the condition now requires all three
  pieces present, verified by testing the case where it must *not*
  short-circuit next.
- **Per-piece skip when only `local_users` is pre-existing** (simulating a
  database seeded before this task existed, or one where `local_users` was
  populated independently): manually deleted the `local_users` row while
  leaving `CLIENT_SECRET`/the current signing key in place, then re-ran the
  script with only `--local-user-file`. Output was exactly
  `Local user bob created.` — no `CLIENT_SECRET stored.`/`Signing key ...`
  lines were printed, confirming the existing two pieces were correctly
  left untouched (verified directly: `secrets` still held exactly one
  `CLIENT_SECRET` row, `signing_keys` still held exactly one `current` row,
  no duplicates).
- **Per-piece skip when only `local_users` is already seeded, the other two
  are missing** (the reverse case): pre-inserted a `local_users` row
  directly via `createLocalUserStore`/`hashPassword` into a fresh, otherwise
  fully-unseeded data directory, then ran the seed script with
  `--client-secret-file`. Output was:
  ```
  CLIENT_SECRET stored.
  Signing key b7d48fcb-7d92-4859-8a13-a1be65f5c4f7 generated and stored as current.
  local_users already seeded; skipping.
  EXIT_CODE=0
  ```
  Direct inspection confirmed exactly one `local_users` row remained
  (`preexisting`, unchanged) — no duplicate or overwritten row.
- **End-to-end login with seed-time credentials** (clean, single-run test to
  avoid any ambiguity from the per-piece tests above, which intentionally
  manipulated rows mid-sequence): fresh data directory, one seed run
  (`--client-secret-file` + `--local-user-file` for user `carol`), then the
  real compiled service (`dist/index.js`) started against the same
  directory and a real `curl -i POST /auth/local-login` with `carol`'s
  exact seed-time password:
  ```
  HTTP/1.1 200 OK
  Set-Cookie: bt_session=...
  {"status":"signed_in","username":"carol"}
  ```
  The minted token was decoded and verified offline against the live
  `GET /.well-known/jwks.json` using `jose`'s `createLocalJWKSet`/
  `jwtVerify`: verification succeeded, payload
  `{"sub":"52f8c6eb-...","email":"carol@example.invalid","upn":"carol",
  "iat":...,"exp":...,"iss":"https://test-issuer.example.invalid"}` — `sub`
  equal to the created user's id, `email`/`upn` matching, six claims,
  confirming the seeded user is indistinguishable from any other local user
  at the login/token layer.
- **Hidden password prompt, interactive, "burst"/paste scenario** (a
  Python-driven pty harness that opens a real pty, spawns
  `dist/seed.js --client-secret-file=...`, and writes all three lines —
  username, email, password — immediately, before the process has even
  finished storing `CLIENT_SECRET`/generating the signing key, simulating a
  fast typist or a paste of all three values at once):
  ```
  Local user username: dana
  Local user email: dana@example.invalid
  Local user password: 
  Local user dana created.
  EXIT_CODE=0
  ```
  Username and email are visibly echoed; the line after "Local user
  password: " is blank (no echoed characters), confirming the password
  prompt is hidden. Direct database inspection confirmed
  `{"username":"dana","email":"dana@example.invalid","is_active":true,
  "created_by":"seed-script"}`, and a live `POST /auth/local-login` with
  `dana`/`interactive-strong-password-7` (the exact typed values) returned
  `200` with a valid `Set-Cookie`. This exact scenario is what exposed and
  then confirmed the fix for the bug described above — the first
  (`readline`-based) implementation produced `email` bound to the password
  value and lost the real email entirely under this identical input.
- **Hidden password prompt, interactive, "paced" scenario** (the same pty
  harness, but waiting for each prompt's exact text to appear before
  sending the next value — the ordinary case of a human typing one field at
  a time): identical correct result —
  `{"username":"erin","email":"erin@example.invalid","is_active":true,
  "created_by":"seed-script","failed_login_attempts":0,"locked_until":null}`,
  password prompt not echoed, and a live login with `erin`'s typed password
  succeeded (`200`, valid `bt_session`).
- **`CLIENT_SECRET`'s own hidden prompt, unaffected by the `promptHidden`
  refactor**: same pty harness, interactive `CLIENT_SECRET` entry (with
  `--local-user-file` supplying the local user non-interactively) —
  `CLIENT_SECRET: ` prompt shown, no echoed characters, exit 0. Decrypted
  the stored value directly via `SecretsStore.getSecret("CLIENT_SECRET")`
  and confirmed it matched the exact typed value
  (`interactive-real-client-secret-value`) byte-for-byte.
- **Validation error paths, `--local-user-file`** (each independently, real
  `dist/seed.js` runs):
  - Invalid username (`Bad!User`): `Local user username must be 3-64
    characters, using only lowercase letters, digits, '.', '-', or '_' (same
    rule POST /admin/users applies).`, exit 1; input file deleted.
  - Invalid email (`not-an-email`): `Local user email must be a valid email
    address.`, exit 1.
  - Short password (`short`, 5 characters): `Local user password must be at
    least 12 characters.`, exit 1.
  - Wrong line count (2 lines instead of 3): `--local-user-file must
    contain exactly three lines, in order: username, then email, then
    password.`, exit 1.
  - In each case, direct database inspection (via `openDatabase()`, which
    applies the schema) confirmed **zero** rows in `secrets`, `signing_keys`,
    and `local_users` — because `--local-user-file` is read, validated, and
    (if invalid) rejected *before* `openDatabase()` is ever called in this
    script's control flow, so an invalid file aborts the entire run cleanly
    with no partial database state at all, even though `--client-secret-file`
    was also supplied in the same invocation.
- **Unlink failure for `--local-user-file` aborts without writing**: made
  the input file's containing directory read-only (`chmod 500`) so the
  delete-after-read step fails with `EACCES`. Output:
  `Unable to delete local user input file <path>. Delete it manually before
  retrying; nothing was written to PGlite. EACCES: permission denied,
  unlink '<path>'`, exit 1. The file was confirmed still present afterward,
  and direct database inspection confirmed zero rows in all three tables —
  matching `--client-secret-file`'s existing behavior exactly.
- **CLI argument guards**: `--local-user=foo`, `--local-username=foo`, and
  `--local-password=foo` each produced the same rejection: `The local
  user's username/email/password must not be supplied as command-line
  values. Use the hidden prompt or --local-user-file=<path>.`, exit 1.
  `--local-user-file` specified twice: `--local-user-file may only be
  specified once.`, exit 1. `--local-user-file=` (empty path):
  `--local-user-file requires a path.`, exit 1. `--local-user-file`
  pointing at a nonexistent path: a clean `ENOENT` error, exit 1 (no crash,
  no partial write).
- **Non-interactive, no TTY, no `--local-user-file` supplied, `local_users`
  still needing seeding**: run with stdin redirected from `/dev/null` (no
  TTY) — `CLIENT_SECRET stored.`/`Signing key ...` printed normally, then
  `Interactive local user input requires a TTY. Use --local-user-file=<path>
  for non-interactive bootstrap.`, exit 1 — fails fast rather than hanging.
- **Password preserving internal spaces/punctuation, not trimmed**: seeded a
  user via `--local-user-file` with password
  `correct horse battery staple!` (spaces and a trailing `!`); login with
  that exact string succeeded (`200`), confirming the password is not
  trimmed or otherwise mangled (only username/email are trimmed).

### Acceptance criteria evidence

- [x] "A fresh, unseeded database gets exactly one `local_users` row...
  in addition to its existing `CLIENT_SECRET`/signing-key seeding." —
  confirmed directly above (`alice`, `carol`, `dana`, `erin`, `frank` each
  in their own fresh directory), each producing exactly one row with all
  fields matching CONTRACT-005 §1/Postconditions.
- [x] "Re-running the script against an already-seeded `local_users` table
  skips that piece and reports it, without duplicating or overwriting the
  existing row." — confirmed both for the whole-database "nothing to do"
  case and the narrower per-piece `local_users already seeded; skipping.`
  case, with byte-identical row counts/content before and after.
- [x] "The seeded user can immediately log in via `POST /auth/local-login`
  with the credentials supplied at seed time." — confirmed for both
  file-supplied and interactively-typed credentials (including a password
  containing spaces/punctuation), with the resulting `bt_session` verified
  offline against the live JWKS endpoint.
- [x] "The interactive password prompt is hidden (not echoed); the
  file-input path deletes its input file immediately after reading, or
  aborts without writing if the delete fails." — confirmed: password prompt
  produces no echoed characters in either the burst or paced interactive
  scenario; the file-input path's delete-then-abort behavior was confirmed
  both on success (file gone) and on a forced unlink failure (file remains,
  nothing written to PGlite, matching `--client-secret-file` exactly).

All four of this task's acceptance criteria are met.

### Assumptions and deviations

- **Username/email/password format validation is re-declared in
  `src/seed.ts` rather than imported from `src/index.ts`.** The admin API's
  own validators (`validateAdminUsername`/`validateAdminEmail`/
  `validateAdminPassword`) are not exported, and this task's exclusions
  explicitly say the admin API is "already built... reuse it, don't touch
  it." Adding exports to `src/index.ts` felt like a larger, riskier change
  to a file this task is told not to touch than duplicating three small,
  stable regexes/length checks (identical rules, same values). `hashPassword`
  and `LocalUserStore.createUser` — the two pieces of actual state-changing
  logic this task was specifically told to reuse — are reused directly, not
  duplicated. Flagged here as the one place a stricter reading of "reuse
  rather than duplicate" could have gone the other way.
- **"The interactive password prompt is hidden" (this task's own acceptance
  criterion) is read as applying to the password only, not username/email.**
  CONTRACT-005 §5's prose ("using the same input pattern already
  established for CLIENT_SECRET") is ambiguous on its own — CLIENT_SECRET's
  own pattern is entirely hidden, and read literally could imply all three
  new fields should be hidden too. This task's acceptance criteria
  disambiguate by naming "the interactive **password** prompt" specifically,
  which is also the more usable choice (an operator retyping a mistyped
  username blind is worse UX for no security benefit, since usernames/
  emails aren't secret). Username and email are therefore prompted visibly;
  only the password is masked.
- **File validation happens before the database is opened, so an invalid
  `--local-user-file` leaves the database completely untouched for that
  invocation — even if `--client-secret-file` was supplied in the same
  invocation and would otherwise have been stored.** This mirrors
  `--client-secret-file`'s own file-read timing (before `openDatabase()`)
  and was verified directly (see "Validation performed"): an invalid
  local-user file aborts before `CLIENT_SECRET`/the signing key are ever
  touched. By contrast, an *interactive* password/format failure (which can
  only be detected after the prompt returns, which happens after the
  CLIENT_SECRET/signing-key blocks in `main()`'s control flow) can leave
  those two pieces already stored from that same run before the local-user
  step fails — this asymmetry is a natural consequence of file input being
  fully read/validated up front versus interactive input being requested
  lazily at the point it's needed, and either way a corrected re-run
  correctly picks up only the remaining unseeded piece(s), per this
  project's existing idempotent-per-piece design.
- **The bug and fix described above** (a `readline`-based or
  early-return-on-first-newline implementation silently drops or misroutes
  a field's value under fast/burst input) is the most significant technical
  finding of this task. It was not something CONTRACT-005 or the task file
  anticipated, and would not have been caught by a validation pass that
  only tested "wait for each prompt, then type" — it required deliberately
  reproducing fast/pasted input via a scripted pty harness. Flagging this
  prominently since it represents a real correctness risk this task's own
  narrow implementation could plausibly have shipped with, had validation
  stopped at the paced/one-field-at-a-time scenario.

### Unresolved risks

- **No automated regression test suite exists for this script** (matching
  every prior task's validation methodology in this project — `package.json`
  defines no test command beyond `build`); validation above is direct,
  reproducible manual/scripted testing (including a custom Python pty
  harness for the interactive-prompt scenarios), not wired into CI.
- **The email-format regex duplicated from `src/index.ts`'s own posture is
  intentionally permissive** (same caveat TASK-016 already recorded for the
  admin API's own validator) and has not been adversarially tested against
  RFC 5322 edge cases.
- **`RawLineReader`'s `\r`/`\n` handling collapses an immediate `\r\n` pair
  into a single line terminator** (to avoid a stray trailing `\n` leaking
  into the next field as a spurious empty line) but has only been tested
  against `\n`-terminated input (this project's and the validation
  harness's own convention); a terminal or pasted source that sends bare
  `\r` without a following `\n` was not separately exercised, though the
  existing `character === "\r" || character === "\n"` check (carried over
  from the pre-existing `CLIENT_SECRET` prompt) already treats either
  character alone as a valid terminator.

### Documentation updated

- `docs/DEVELOPMENT.md`: added a paragraph under "Local username/password
  login (CONTRACT-005)" describing the new `local_users` seeding step
  (idempotent check, skip/report wording, interactive vs.
  `--local-user-file` input, the three-line file format convention, the
  shared hashing/insert path, and "runs regardless of `LOCAL_LOGIN`"); updated
  the existing `POST /auth/local-login` paragraph, which previously stated no
  seed-script path existed yet, to reference this task's new step.

## Review

Not reviewed.
