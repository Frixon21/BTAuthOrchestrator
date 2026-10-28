# TASK-013: Rewrite README for this project

Owner role: Implementer
Assigned agent: Claude (direct request from Patrick — not openai-coder;
his explicit preference for README writing, given directly in
conversation rather than via the usual specialist-routing default)
Proposed by: Patrick Moon
Proposed date: 2026-09-15
Approved by: Patrick Moon
Approved date: 2026-09-15
Related contracts: none
Related ADRs: none
Dependencies: None

## Desired outcome

`README.md` actually describes BTAuthOrchestrator — what it is, its current
status, and how to set it up and run it — instead of being the unmodified
generic `Project Template DbC` boilerplate it still is today.

## Context

`README.md` was never customized after this repo was bootstrapped from the
template: it still says "# Project Template," describes itself as "a
repository template," and its "Origin of Design by Contract" section refers
to "this template's name." Noticed while syncing `docs/AI_DEVELOPMENT_SYSTEM.md`
with the template's corrected DbC framing. Patrick asked for this directly,
explicitly excluding the DbC material — this project's README should be
about the project, not about the process template it came from.

## Scope

### Included

- Replace the title, description, and all template-boilerplate language with
  content specific to BTAuthOrchestrator.
- A concise purpose statement (what problem this solves, who it's for) —
  source from `NOTES.md` §1.
- Current status: milestone 1-2 (Entra registration through offline
  verification proof, TASK-004–012) implemented and accepted; TASK-003d
  (TLS/Caddy) still pending.
- Setup and run instructions condensed from `docs/DEVELOPMENT.md` (env vars,
  npm scripts) — enough to get a new reader running locally, not a full copy
  of that document's depth.
- A short endpoint summary (health, login/callback, JWKS, emergency
  rotation).
- Pointers to the deeper docs (`docs/DEVELOPMENT.md`, `docs/contracts/`,
  `CLAUDE.md`/`AGENTS.md`, `tasks/`) rather than duplicating their content.

### Excluded

- Any "Design by Contract" / Meyer / template-origin material — explicitly
  dropped per Patrick's instruction, not merely deprioritized.
- Rewriting or duplicating `docs/DEVELOPMENT.md`'s full technical detail.
- Any change to process docs (`CLAUDE.md`, `AGENTS.md`, `docs/`) — this task
  touches only `README.md`.

## Plan

1. Draft new `README.md` content from `NOTES.md` §1 (purpose) and
   `docs/DEVELOPMENT.md` (setup/commands/endpoints), condensed to
   README-appropriate length.
2. State current milestone status accurately (what's built/accepted vs.
   still pending).
3. Link out to deeper docs rather than restating them.

## Acceptance criteria

- [x] No template-boilerplate or DbC/Meyer language remains in `README.md`.
- [x] A new reader can find the project's purpose, current status, and how
      to set it up/run it within the file itself.
- [x] Setup instructions are accurate against `docs/DEVELOPMENT.md` (env
      vars, npm scripts) as of this task's date.

## Validation requirements

Read the result against `docs/DEVELOPMENT.md` and `.env.example` for
accuracy; confirm every documented npm script actually exists in
`package.json`.

## Risks and assumptions

None.

## Blocker

None.

## Implementation handoff

Task: TASK-013 — Rewrite README for this project
Implementer: Claude Sonnet 5 (direct request, standing in for the usual
openai-coder routing per Patrick's explicit preference for README writing)
Date: 2026-09-15

### Changes made

Replaced `README.md` in full. New content: a purpose statement condensed
from `NOTES.md` §1, a status line naming milestone 1-2 as accepted and
TASK-003d (TLS) as the one open item, setup/run instructions condensed from
`docs/DEVELOPMENT.md` (env vars via `.env.example`, the six `npm run`
scripts), an endpoint summary table, and links out to `docs/DEVELOPMENT.md`,
`docs/contracts/`, `CLAUDE.md`/`AGENTS.md`, and `tasks/` rather than
duplicating their content. No DbC/Meyer/template-origin material included,
per explicit instruction.

### Validation performed

- Cross-checked every npm script named in the new README
  (`dev`/`build`/`seed`/`start`/`verify-offline`) against `package.json`'s
  actual `scripts` block — all present, no others omitted.
- Cross-checked every environment variable named against `.env.example`'s
  current contents (`PORT`, `PGLITE_DATA_DIR`, `DB_ENCRYPTION_KEY`,
  `COOKIE_SECURE`, `TENANT_ID`, `CLIENT_ID`, `SERVICE_ISSUER`,
  `EMERGENCY_ROTATION_TOKEN` — eight total).
- Cross-checked every named endpoint (`/health`, `/auth/login`,
  `/auth/callback`, `/.well-known/jwks.json`,
  `POST /admin/emergency-rotate-keys`) against `src/index.ts`'s actual
  route handling.
- Confirmed the milestone-status claim against `tasks/completed/` (TASK-004
  through TASK-012 present) and `tasks/approved/` (only TASK-003d remains).

### Acceptance criteria evidence

- No boilerplate/DbC language: the replaced file contained the only
  occurrences of "Project Template" and "Origin of Design by Contract" in
  `README.md`; both are gone from the new content.
- Purpose/status/setup all present and read in under a minute; deeper detail
  linked rather than inlined.
- Setup instructions verified against `.env.example` and `package.json`
  directly, not from memory of `docs/DEVELOPMENT.md`'s prose alone.

### Assumptions and deviations

- Kept the status line to a single accurate sentence rather than a full
  milestone changelog — `tasks/completed/` is the authoritative detailed
  record; the README only orients a reader to "where things stand," per
  this task's own scope (link out, don't duplicate).

### Unresolved risks

None identified.

### Documentation updated

`README.md` itself is the deliverable; no other document changed.

## Review

Not applicable — Patrick requested this directly and is reviewing the
result himself; no independent reviewer role assigned to this task.
