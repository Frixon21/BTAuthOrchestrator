# TASK-024: Contract — container deployment (supersedes CONTRACT-007)

Owner role: Contract designer
Assigned agent: contract-architect
Proposed by: Patrick Moon
Proposed date: 2026-10-20
Approved by: Patrick
Approved date: 2026-10-20
Related contracts: CONTRACT-007 (to be retired in full and superseded by the
new contract, expected to be CONTRACT-008); CONTRACT-001, CONTRACT-003,
CONTRACT-005 (consumers of CONTRACT-007's interfaces, expected unaffected)
Related ADRs: ADR-001 (contracts are retired by supersession, never amended
in place)
Dependencies: none

## Desired outcome

An approved CONTRACT-008 that supersedes CONTRACT-007 in full and defines how
BTAuthOrchestrator's secret/key storage, bootstrap seed, data-directory
protection, and single-process guarantees behave when the service runs as a
Docker container on TrueNAS SCALE. Once it exists, TASK-025 can be
implemented without further architectural decisions.

## Context

Patrick decided (2026-10-20) that the service should be deployable as a
Docker container on TrueNAS SCALE, with:

- **Persistent data.** `PGLITE_DATA_DIR` is fixed inside the container at
  `/data` and backed by a volume. The host-side location is chosen by the
  operator at install time through TrueNAS's app configuration, never by
  the image.
- **Required first-boot inputs.** The container deployment requires a
  `CLIENT_SECRET` and initial local-user credentials. On first start the
  container seeds itself from those inputs, so no interactive
  `node scripts/seed.js` run is needed.
- **Caddy in the same compose project** as the TLS reverse proxy (custom
  image with the `caddy-dns/cloudflare` module). Caddy is TASK-025's
  concern, but this contract must cover the trust boundary it creates; see
  the forwarded-address item below.

Patrick explicitly chose to retire CONTRACT-007 and write a new contract
rather than treat container deployment as an implementation detail.

CONTRACT-007 sections that conflict with, or are silent on, container
operation:

1. **§4 Bootstrap/seed interface.** It is specified as run manually, once,
   by an operator. It reads `--client-secret-file` and then must `unlink` it,
   aborting if the unlink fails. Docker/TrueNAS secret mounts are typically
   read-only, so the unlink always fails. "Already seeded" exits non-zero,
   which an automatic first-boot entrypoint has to interpret on every
   restart.
2. **Where secret inputs come from.** CONTRACT-007 says `DB_ENCRYPTION_KEY`
   lives "only in `.env`", and it treats CLI-visible secrets as unacceptable.
   The TrueNAS Custom App form most naturally passes values as plain
   environment variables, which are visible in `docker inspect` and in the
   TrueNAS app configuration. The contract must state which input channels
   are acceptable for `DB_ENCRYPTION_KEY`, `CLIENT_SECRET`, the initial
   local-user credentials, and the two admin bearer tokens. Options include
   env only, `*_FILE` secret-file only, or both. It must also state whether
   first-boot seed inputs may (or must) be removed from the configuration
   after the first successful start.
3. **§5 Data-directory permissions.** The `0700` and owned-by-running-user
   check still applies inside the container. On TrueNAS, the host dataset's
   owner must match the container's UID; TrueNAS apps conventionally run as
   `568:568` (`apps`). The contract must state the expected container
   UID/GID behavior, and whether it is fixed or operator-configurable.
4. **§6 Single-process enforcement.** The current guard
   (`src/database.ts` `acquireProcessLock`) is an `O_EXCL` lock file with no
   stale-lock detection. After an unclean container stop (host reboot,
   `docker kill`, OOM), the lock file persists on the volume. Every
   subsequent start then fails, and a restart policy turns that into a crash
   loop. The contract must define how a stale lock is recognised and
   recovered without weakening the "no two concurrent instances" guarantee.
5. **Forwarded client address (new; CONTRACT-003 and CONTRACT-005
   adjacent).** `extractSourceIp` trusts the first `X-Forwarded-For` entry
   from any peer. The login IP throttle and audit rows use it. Behind Caddy,
   with Node unpublished, this is safe; if Node's port is ever exposed, it is
   spoofable. Decide whether this contract (or a separate CONTRACT-005
   supersession) requires a trusted-proxy setting.

## Scope

### Included

- Draft CONTRACT-008 as a whole-document successor to CONTRACT-007,
  copying forward unchanged sections verbatim (ADR-001), and changing only
  what container deployment requires (items 1–4 above, plus item 5 if it
  is placed here).
- Retain CONTRACT-007's POSIX-host and Windows-host behavior unless Patrick
  decides otherwise, so non-container deployments keep working.
- List the open questions that need Patrick's decision before approval.
- After Patrick approves CONTRACT-008, make the header-only retirement
  edit to CONTRACT-007 (`Status: Retired`, `Superseded by: CONTRACT-008`).

### Excluded

- Any application code, Dockerfile, compose file, or Caddy configuration
  (TASK-025).
- TrueNAS catalog/app-template packaging beyond what the contract needs to
  state as operator-facing behavior.
- Changes to the encryption scheme, schema, or key lifecycle (CONTRACT-007
  §1–§3) unless container operation proves they are required.

## Plan

1. Read CONTRACT-007 in full and the current seed, database, and startup
   code.
2. Draft CONTRACT-008 addressing Context items 1–5, with open questions
   listed explicitly.
3. Patrick reviews and decides open questions; iterate.
4. On approval, apply the CONTRACT-007 retirement header edit.

## Acceptance criteria

- [ ] CONTRACT-008 exists, states `Supersedes: CONTRACT-007`, and is a
      complete standalone document per ADR-001.
- [ ] It specifies first-boot automatic seeding: inputs, input channels,
      idempotence on restart, and failure behavior when inputs are missing
      or invalid.
- [ ] It specifies data-directory ownership/permission behavior inside the
      container.
- [ ] It specifies stale-lock recovery that still prevents two concurrent
      instances.
- [ ] It resolves (or explicitly defers to a named follow-up) the
      forwarded-client-address trust question.
- [ ] Unchanged sections are carried forward verbatim from CONTRACT-007.
- [ ] CONTRACT-007's header is updated only after Patrick approves
      CONTRACT-008.

## Validation requirements

Review against CONTRACT-007 confirms that every difference is intentional and
listed in CONTRACT-008's "Relationship to CONTRACT-007" note. Patrick
explicitly approves the contract.

## Risks and assumptions

- Target host is TrueNAS SCALE 25.10.0.1 (Goldeye; Docker/Compose-based
  apps). Patrick
  confirmed (2026-10-20) that deployment is a TrueNAS **Custom App** (form
  or "Install via YAML"), not a catalog app. The contract's input channels
  must therefore be workable from a Custom App: environment variables
  and host-path mounts, with compose `secrets:` available only via YAML.
- Accepting plain environment variables for first-boot secrets is a weaker
  posture than CONTRACT-007's file-and-delete flow. That tradeoff must be an
  explicit, recorded decision, not an implementation default.

## Blocker

None.

## Implementation handoff

Task: TASK-024
Implementer: contract-architect
Date: 2026-10-20

### Changes made

- Drafted
  `docs/contracts/CONTRACT-008-container-deployment-secret-and-key-storage.md`
  (Status: Draft), a whole-document successor to CONTRACT-007. Sections that
  are unchanged were copied verbatim. Every difference is listed in its
  "Relationship to CONTRACT-007" note.
- Substantive additions:
  - §6: stale-lock recovery requirements S1–S8.
  - §7: container deployment profile, covering the `/data` path, the input
    channels and `*_FILE` rules, UID/GID and ownership, the non-interactive
    first-boot seed mode, and stop behavior.
  - §8: the forwarded-address deployment invariant.
  - Matching rows were added to Postconditions, Failure behavior,
    Interfaces, UX expectations, and Validation requirements.
  - Resolved decisions #18–#22 record Patrick's 2026-10-20 decisions.
- No application code, other contract, or TASK-025 was edited. CONTRACT-007's
  header was not edited; that waits until Patrick approves CONTRACT-008.

### Validation performed

- Read CONTRACT-007 and the relevant parts of CONTRACT-005, then grounded
  the contract in `src/seed.ts`, `src/database.ts`, `src/config.ts`,
  `src/index.ts` (`extractSourceIp`, start and shutdown), `scripts/startup-check.js`,
  and `start.sh`.
- Spot-checked carried-forward text against CONTRACT-007 for verbatim
  copies. A full diff review against CONTRACT-007 remains part of this
  task's validation requirement.

### Acceptance criteria evidence

- `Supersedes: CONTRACT-007`; standalone document: met (header, all
  sections present).
- First-boot seeding (inputs, channels, idempotence, failure): §7.2, §7.4,
  Failure behavior.
- Data-directory ownership in the container: §7.3. The decision is in OQ-5.
- Stale-lock recovery that preserves single-instance safety: §6 S1–S8. The
  mechanism is in OQ-6.
- Forwarded address: deployment invariant in §8. The trusted-proxy setting
  is deferred to a proposed follow-up in OQ-9.
- Unchanged sections verbatim: yes. See the relationship note.
- CONTRACT-007 header updated only after approval: not yet done (pending).

### Assumptions and deviations

- The contract Status is "Draft" per Patrick's instruction, whereas
  `docs/contracts/TEMPLATE.md` uses "Proposed."
- CONTRACT-007's own header reads `Status: Accepted`, not the template's
  `Approved`. It is left as is and flagged for Patrick.
- The local-user step of seeding is governed by CONTRACT-005 §5. The
  container path conflicts with its "immediately-deleted input file"
  wording. This is raised as OQ-8 (proposed section-level supersession)
  rather than resolved silently.
- The proposed variable names (`*_FILE`, `INITIAL_LOCAL_USER_*`) and the
  `--non-interactive` flag are drafts for Patrick to confirm (OQ-1, OQ-4).
- It is assumed but not verified that the TrueNAS Custom App form can mount
  single files. Compose `secrets:` works through YAML. TASK-025 should
  verify this.

### Unresolved risks

- Ten open questions (OQ-1 to OQ-10) block approval.
- The service cannot detect NFSv4 or extended ACLs on the TrueNAS dataset.
  Operators are responsible for this as a precondition.
- Stale-lock recovery relies on PGlite's crash recovery after a SIGKILL.

### Documentation updated

- New contract file only.

### Lifecycle note

This agent has no file move or delete tool, so the task file could not be
moved from `approved/` to `in-progress/` and then to `review/`. It needs
`git mv tasks/approved/TASK-024-contract-container-deployment.md tasks/review/`
to reach `review/` per `docs/workflow/lifecycle.md`.

## Review

Not applicable (contract-designer task; Patrick reviews the contract
directly).

## Human acceptance

Pending.
