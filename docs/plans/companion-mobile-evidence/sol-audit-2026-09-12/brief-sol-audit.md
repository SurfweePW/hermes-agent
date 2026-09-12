# Independent audit — Hermes Companion durable session creation (G3c)

You are the independent auditor. Your job is to falsify or confirm the claims below against the
actual code and the actual test behaviour. You are not the author of this work and you must not
assume the author's summary is true.

## Repository and freeze point

- Repo: `/Users/atlasweber/hermes-companion`
- Branch: `feature/hermes-companion`, HEAD = `3c4e18bcef`, working tree **clean** (verify with
  `git status --porcelain` and `git log --oneline -3`).
- Candidate commits under audit:
  - `826ef4b72c` feat(companion): durable session creation and dispatch continuity
  - `f8166a7def` test(companion): drop unused imports from the creation process matrix
  - `3c4e18bcef` test(companion): harden the creation process matrix per adversarial review
- **READ-ONLY. Do not edit, create, delete, commit, push or stash anything in the repo.** Run
  commands that only read: `git`, `grep`, `sed`, `python -m pytest`, `scripts/run_tests.sh`.

## Spec (authoritative)

- `docs/plans/companion-mobile-evidence/p4-current-design-v2.md` — the design. Load-bearing
  sections: §1.4 (receipt vocabulary and binding rules), §1.5 (immutable request conflict),
  §4.3 (failure table: preparing / dispatching / admitted / unknown outcome), §4.4 (uniqueness
  proof), §10 (R3/R4/R5/R8).
- `docs/plans/2026-09-09-companion-mobile-continuity-implementation.md` — implementation plan.
- `docs/plans/companion-mobile-evidence/g3c-creation-process-matrix.md` — the author's evidence
  note for the test matrix (treat as a claim to verify, not as evidence).

## What was built (claims to audit)

Server-side durable session creation and dispatch continuity for the Hermes Companion mobile
client. Main production surfaces:

- `tui_gateway/companion_session_create.py`
- `tui_gateway/companion_creation.py`
- `tui_gateway/companion_turns.py`, `tui_gateway/synthetic_turn.py`
- `tui_gateway/session_lifecycle.py`
- `hermes_cli/companion_projects.py`

Test surfaces added/changed:

- `tests/tui_gateway/test_companion_creation_process_matrix.py` (new, 5 scenarios,
  real subprocesses over a shared temp `HERMES_HOME`)
- `tests/tui_gateway/fixtures/companion_stdio_gateway.py` (env-gated test-only hooks)
- `tests/tui_gateway/test_companion_transport_integration.py` (pre-existing real-transport gate)

### Claims

- **C1** Duplicate or racing creation for one `client_request_id` and one payload yields exactly
  one request-index record, one persisted session row and one dispatch; the losing process
  releases its reservation and returns the same logical operation rather than creating anything.
- **C2** Same `client_request_id` with a *different* payload is refused with JSON-RPC error code
  **4090**, with no second creation and no extra dispatch.
- **C3** Death before the reserved create commits (halt at `create_entry`): reconcile returns
  `not_admitted` with `row_state == "absent"`, a stable reserved `stored_session_id`, no session
  row, no dispatch; a retry re-reads that same closed operation.
- **C4** Death while dispatching (halt at `submit_entry`): reconcile returns `not_admitted` with
  `runtime_session_id == null` and no pipeline entry.
- **C5** Death after admission but before build/thread (halt at `agent_build`): reconcile returns
  `interrupted_outcome_unknown` with `row_state == "present"` — never a fabricated success.
- **C6** The 60-second `recovery_required` window is presentation-only per design v2:232; note
  that the code computes the *whole operation duration* rather than *time since last progress* —
  decide whether that is a real contract violation, a UX risk, or acceptable.
- **C7** The 600-second orphan reaper in `session_lifecycle.py` is pre-existing behaviour, not a
  regression introduced by these commits.
- **C8** The new matrix is falsifiable (it would fail on broken code) and the fixture hooks add no
  production bypass — with the env vars unset they are inert pass-throughs.
- **C9** Gate numbers, reproducible: `scripts/run_tests.sh` over the 11 companion creation /
  continuity / transport suites = 486 passed, 0 failed; `apps/companion` vitest = 574 passed /
  36 files; `npm run typecheck` clean. Reproduce at least the Python gate yourself.
- **C10** The mobile client does **not** call `companion.sessions.create`: `apps/companion/src`
  contains zero references to it, while `apps/companion/src/gateway/companion-client.ts:613`
  still issues the generic `session.create`, and the client's new-conversation params carry
  `title: 'Bot Chat'` (see `companion-client.test.ts:204,350,387`). Per the design this path is
  the one creation was meant to replace. Determine the minimal correct client integration the
  design actually requires.

## Open items to adjudicate (from three earlier review lenses)

Decide each: real defect / intentional / not a defect — with file:line and, when it is a defect,
the minimal fix and its blast radius.

- **O1** No owner/authorization check before the commit step of creation.
- **O2** Workspace verification after the compare-and-swap.
- **O3** The `failed` status plus client-side retry: is retry after a failed creation safe and
  defined, and does the client have what it needs to distinguish "retry" from "wait"?
- **O4** Can an all-null ("empty") receipt be produced, and is that legal under §1.4?
- **O5** A swallowed `ValueError` in `hermes_cli/companion_projects.py` — locate it, say what
  breaks when it fires, and whether it can hide an inconsistent workspace state.
- **O6** Every grep of `tui_gateway/companion_creation.py:169-170` shows the literal
  `owner_authorization: Any *** None`. Confirm independently whether the file on disk really
  contains `***` (byte-level check) or whether that is a display/redaction artefact of the tool
  output. The module imports cleanly, but confirm, because it would be a syntax error if real.

## Method requirements

1. Read the spec sections first, then the code, then the tests. Cite `file:line` for every claim
   you make.
2. **Attempt falsification**: for each claim, state what concrete defect would make it fail and
   say whether you actually observed such a defect or only reasoned about it.
3. Prefer running the real thing over reading it. Use `scripts/run_tests.sh` (never bare pytest —
   see `AGENTS.md`); the system `python3` has no pytest, the venv does.
4. Report honestly what you could **not** verify and why. An unverified area is a finding, not a
   gap to paper over.
5. Never print credentials, tokens or environment values; if you see one, write `[REDACTED]`.
6. Budget: ≤60 turns. Do not sweep the whole repository; read what the claims touch.

## Deliverable

Write your report to:
`/Users/atlasweber/.hermes/profiles/atlas/workspace/companion-sol-audit-2026-09-12/report-sol-audit.md`

Structure:

1. **Verdict** — is the frozen candidate fit to ship behind a feature gate? State it plainly.
2. **Claim-by-claim findings** — C1…C10, each with evidence `file:line`, the command you ran where
   relevant, and CONFIRMED / REFUTED / PARTIAL / UNVERIFIED.
3. **Defects** — ordered by severity, each with: what breaks, the exact line, the minimal fix, and
   whether it must be fixed before the audit gate closes.
4. **Client integration** — what the mobile client must change to reach this server-side
   durability, per the design (the largest open product gap).
5. **What I could not verify.**
6. A final line, exactly: `AUDIT_VERDICT: PASS` or `AUDIT_VERDICT: PASS_WITH_FINDINGS` or
   `AUDIT_VERDICT: FAIL`.

Then print a short summary of the verdict in your final answer.
