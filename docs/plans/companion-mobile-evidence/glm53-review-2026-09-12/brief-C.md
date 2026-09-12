# Independent code review — lens C: test validity & client-side correctness

You are an independent, adversarial code reviewer. You have no stake in this code.
Repo (shared, DIRTY worktree — read-only for you): `/Users/atlasweber/hermes-companion`

## HARD CONSTRAINTS

- READ ONLY. Do not edit, create, move, delete files in the repo. Do not run `git add`,
  `git commit`, `git checkout`, `git restore`, `git reset`, `git stash`, `git clean`.
- Allowed git commands: `git status`, `git diff`, `git diff HEAD -- <path>`, `git log`, `git show`.
- Do not run the test suite (another process is using CPU). READ tests instead of running them.
- Your ONLY write target is your report file (path below).
- Do not print secrets, tokens, or credential values.

## Your lens — are the tests real, and is the client correct?

Two questions, both adversarial:

### Question 1 — Do the tests actually prove what the report claims?

The claim under review: "G3c focused gate: 481 passed, 0 failed" and "critical behaviours are
proven by tests, not by assumption". Your job is to find tests that pass for the wrong reason.

Attack vectors to check explicitly:

- A test whose setup injects a condition that never fires (dead injection), so the assertion is
  satisfied by the un-injected path. This class already happened ONCE in this work: an arm
  guarded by `if calls == 2` while the function was only called once, so the owner was never
  revoked. Read `tests/tui_gateway/test_companion_session_create_rpc.py` (function
  `test_owner_is_revalidated_at_every_gate_before_submit`) and prove whether the guard
  `assert revoked == [revocation_gate]` genuinely makes a silent no-op impossible for ALL arms
  (pre-resolve / before_submit / after_bind).
- Change-detector assertions (freezing a count, a model list, a version, a set size) instead of
  relationships between two pieces of data.
- Tests that read source text (`read_text()` / regex on `.py`) — banned in this repo.
- Assertions that only check "no exception raised" or mock the very thing they claim to verify.
- OS-marked or skipif tests that cannot run in the Linux CI lane, or tests placed in `tests/*.py`
  that assert about `.ts/.tsx` sources (they will not run on a JS-only PR).
- Tests that would pass on the unfixed code (verify by reading the diff of the test file and
  reasoning about the pre-change behaviour of the code under test).

Files: `tests/tui_gateway/test_companion_creation_*.py`, `test_companion_reserved_session_create.py`,
`test_companion_session_create_rpc.py`, `test_companion_session_continuity.py`,
`test_companion_transport_integration.py`, `test_companion_persisted_sessions_rpc.py`,
`test_companion_attention.py`, `test_companion_library_rpc.py`,
`tests/hermes_cli/test_companion_work_p5_w1.py`, `tests/gateway/test_status.py`,
`tests/hermes_cli/test_active_sessions.py`, and the other modified test files in
`git diff --stat` that live under `tests/` or `apps/companion/src/`.

### Question 2 — Is the client correct?

Files (read the actual file, plus its diff): `apps/companion/src/gateway/companion-client.ts`,
`connection.ts`, `types.ts`, `security/owner-auth.ts`, `security/secret-store.ts`,
`state/companion-store.ts` (+1131), `state/session-drafts.ts` (new),
`features/conversation/conversation.tsx`, `message-composer.tsx` (new), `status-row.tsx` (new),
`transcript-scroll.ts` (new), `features/directory/*`, `features/work/*`, `features/library/*`,
`app.tsx`, `styles/app.css`.

Verify with file:line evidence:

1. View-toggle / optimistic state cannot fabricate a session that does not exist server-side.
2. An uncertain submit result (`unknown`) is reconciled with the server; the UI does not simply
   re-enable a "Send again" button that can duplicate a turn.
3. Drafts are per logical session (A → B → A keeps the right text) and do not leak between
   profiles or across logout.
4. Local cache/persistence after logout cannot serve a previous identity's history or drafts.
5. The client never derives profile/project/session identity from a display name or title.
6. Nothing in the client treats a source error as an empty collection, or infers completeness
   from a short page.

## Method

- Read the actual current file text. Quote exact `file:line`.
- For each claim: construct the concrete way it could pass falsely, or state you could not.
- Label statements `EVIDENCE` or `INFERENCE`. Confidence HIGH / MEDIUM / LOW.
- `BLOCKED` markers where a real device/two clients are required. No gap-filling prose.

## Deliverable

Write your report to:
`/Users/atlasweber/.hermes/profiles/atlas/workspace/companion-g3c-glm53-review-2026-09-12/review-C.md`

Structure:

1. `## Verdict` — `PASS`, `PASS WITH FINDINGS`, `REQUEST CHANGES`, or `BLOCKED`, plus one
   paragraph, and whether the test evidence is trustworthy enough to freeze a release candidate.
2. `## Tests that pass for the wrong reason` — each with file:line and the exact reason.
3. `## Client findings` — numbered: severity (BLOCKER / MAJOR / MINOR / NIT), file:line, what is
   wrong, failure scenario, confidence, suggested check (not a patch).
4. `## Test coverage gaps` — behaviours claimed as proven that have no test that could fail.
5. `## Blocked / not verifiable here`.
6. `## Files read` — exact paths you opened.

Then print to stdout a summary: verdict, counts by severity, top 3 findings one line each,
under 1500 characters.
