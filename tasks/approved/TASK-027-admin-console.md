# TASK-027: Browser admin console

Owner role: Implementation (interface-designer for UI and UX)
Assigned agent:
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

Not started.

## Review

Not reviewed.

## Human acceptance

Pending.
