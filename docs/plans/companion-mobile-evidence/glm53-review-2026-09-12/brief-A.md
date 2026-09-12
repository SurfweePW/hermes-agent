# Independent code review — lens A: session creation & authorization seams

You are an independent, adversarial code reviewer. You have no stake in this code.
Repo (shared, DIRTY worktree — read-only for you): `/Users/atlasweber/hermes-companion`

## HARD CONSTRAINTS

- READ ONLY. Do not edit, create, move, delete files in the repo. Do not run `git add`,
  `git commit`, `git checkout`, `git restore`, `git reset`, `git stash`, `git clean`,
  `git apply`, or anything that changes index/working tree/refs.
- Allowed git commands: `git status`, `git diff`, `git diff HEAD -- <path>`, `git log`, `git show`.
- Do not run the test suite (another process is using CPU). Read tests instead of running them.
- Your ONLY write target is your report file (path below).
- Do not print secrets, tokens, or credential values.

## What is being reviewed

Hermes Companion mobile continuity work: a mobile client (Android) must open, continue and
create the SAME logical Hermes sessions as Hermes Desktop, with exactly-once execution and
no second run when two clients watch one session. The scope under review is the uncommitted
work in this worktree (`git diff HEAD` = 70 modified files, ~11.4k insertions, plus untracked
new files — `git status --porcelain` shows them; new files are NOT in `git diff`).

## Your lens — creation, state machine, authorization

Primary files (read the real file contents, not only the diff):

- `tui_gateway/companion_session_create.py` (main saga; ~680 lines)
- `tui_gateway/companion_creation.py` (untracked/new)
- `tui_gateway/companion_attention.py`, `tui_gateway/companion_turns.py` (new)
- `tui_gateway/companion_projects.py` (`hold_creation_workspace`, `resolve_creation_workspace`)
- `tui_gateway/methods_prompt.py` (`_settle_creation_for_refusal`, `_bind_provisional_creation_submission`)
- `tui_gateway/methods_companion_sessions.py`, `tui_gateway/server.py`
- `hermes_cli/companion_work_store_readonly.py` (new)

Useful context: `docs/plans/2026-09-09-companion-mobile-continuity-implementation.md`
(sections 4, 6-P1, 6-P4, 7) and `docs/plans/companion-mobile-evidence/g3c-pause-state.md`
(state before your review). Treat both documents as CLAIMS to be verified, not as established
fact.

## Claims to attack (each must get VERIFIED / REFUTED / INCONCLUSIVE + file:line evidence)

1. Exactly-once submit: a creation attempt produces at most one runtime submit and at most one
   persisted session, including across a crash between "prepared" and "dispatching", a lost
   RPC response, a reconcile pass, and a retry by the client.
2. The five-phase machine `bound → preparing → prepared → dispatching → closed` cannot be
   advanced twice, cannot be entered by two concurrent callers for the same draft, and cannot
   be left in a state that both dispatches and reports failure.
3. Owner authorization is re-validated at EVERY seam before `prompt.submit` (pre-resolve,
   pre-dispatch, after `bind_turn`). A revoked/expired owner must never reach `prompt.submit`,
   never fall back to a shared gateway token, and never be projected as an uncertain outcome
   instead of a clean authorization refusal.
4. `hold_creation_workspace` is ONE continuous hold (pinned `projects.db` descriptor/device/inode
   + ancestor chain + project folder fingerprint) from first resolution through the
   `prepared → dispatching` CAS. No window exists where the workspace identity can change
   between validation and dispatch (TOCTOU).
5. Refusal/uncertainty projection: `not_admitted` vs `recovery_required` vs `row_state` values
   are chosen correctly on each exit path (success, refusal, crash, unknown outcome). An
   authorization refusal must never be reported as an uncertain/recovery outcome, and an
   uncertain outcome must never be reported as a clean failure that invites blind retry.

## Also hunt for (your own findings, not limited to the list above)

- Any path where a revoked owner, a wrong profile, or a renderer-supplied identity flag reaches
  a state-changing operation.
- Path traversal / symlink / race in project folder and workspace identity checks.
- Silent `except` blocks, swallowed errors, or `if/elif` ladders ≥4 branches keyed on a name.
- Dead code, unreachable branches, flags nobody sets, or a test-only seam that changes
  production behaviour.
- Regression risk to OTHER callers: `git diff HEAD -- tui_gateway/methods_session.py` removes a
  large amount of code — check every remaining caller of what moved.
- Anything that would break once this branch is merged into `origin/main` (this file set does
  not exist on `origin/main`; other suites import `tui_gateway.server`).

## Method

- Read the actual current file text. Quote exact `file:line` for every claim.
- For each claim: try to construct a concrete counterexample (interleaving, injected failure,
  crash point, second client). If you cannot, say so explicitly.
- Label every statement `EVIDENCE` (you read it in code) or `INFERENCE` (you reasoned it).
- If you cannot verify something (needs a running gateway, a phone, or two real clients), write
  `BLOCKED` with exactly what is missing. Do not fill gaps with plausible prose.
- Report only what you can defend. False findings cost more than missing ones, so mark
  confidence: HIGH / MEDIUM / LOW.

## Deliverable

Write your report to:
`/Users/atlasweber/.hermes/profiles/atlas/workspace/companion-g3c-glm53-review-2026-09-12/review-A.md`

Structure:

1. `## Verdict` — one of `PASS`, `PASS WITH FINDINGS`, `REQUEST CHANGES`, `BLOCKED`, plus one
   paragraph why. State plainly whether this code is safe to freeze as a release candidate
   from your lens.
2. `## Claim verification` — the five claims above, each with verdict + file:line evidence.
3. `## Findings` — numbered, each: severity (BLOCKER / MAJOR / MINOR / NIT), file:line,
   what is wrong, why it matters, concrete failure scenario, confidence, suggested check
   (not a code patch).
4. `## Blocked / not verifiable here` — explicit list.
5. `## Files read` — the exact paths you actually opened.

Then print to stdout a summary: verdict, counts by severity, and your top 3 findings in one
line each. Keep the stdout summary under 1500 characters.
