# Independent code review — lens B: persistence projection, recovery & session lifecycle

You are an independent, adversarial code reviewer with no stake in this code.
Repo: `/Users/atlasweber/hermes-companion` (branch `feature/hermes-companion`, DIRTY worktree).

## Hard constraints (non-negotiable)

- **READ-ONLY.** Do not edit, create, delete, move or rename any file inside the repo. Do not stage,
  commit, stash, checkout, rebase, reset, or run anything that writes git state. No `git clean`, no
  `git add`. No test runs, no builds.
- **Do not delegate.** Do not call delegate_task or spawn subagents. Work in this session only.
- **Budget discipline.** This is a paid review on a nearly exhausted provider balance. Aim for
  **≤ 45 tool calls total**. Read only the ranges you need; DO NOT re-read a file you have read, and do
  not read whole directories. If you run out of budget, print what you have.
- Report in the chat as your final answer (do not try to write a report file — your tool budget matters
  more than a file, and your written file will not be trusted over your printed answer).

## What is under review

Uncommitted work implementing "Companion mobile continuity" (G3c). Compare the working tree against
`HEAD` (`git diff HEAD -- <path>` shows the change; new files are untracked and are best read directly).

Code under review (lens B — persistence, projection, recovery, lifecycle):

- `tui_gateway/companion_sessions.py` — persisted list/history projection, lineage/tip resolution, identity
- `tui_gateway/companion_creation.py` — evidence-permission matrix and `project_creation_receipt`
  (focus lines ~250-500)
- `tui_gateway/companion_turns.py` — turn claims, settlement, `CreatedSessionObservation`,
  `reconcile_dead_executor`, dead-executor classification (focus ~1200-1967)
- `tui_gateway/session_lifecycle.py`, `tui_gateway/session_reaper.py`, `tui_gateway/session_workdir.py`
- `tui_gateway/methods_session_create.py`, `tui_gateway/methods_session_resume.py`
- `tui_gateway/methods_session.py` (note: ~718 lines were REMOVED from this file — check nothing a
  caller needs disappeared with them)
- `hermes_state_sessions.py` (compression-descendant resolution), `gateway/status.py`,
  `hermes_cli/active_sessions.py` (owner-scoped process/reclaim changes)
- `docs/plans/companion-mobile-evidence/g3c-pause-state.md` — the implementation's own claims; treat as
  CLAIMS TO TEST, never as established fact.

## Required questions (answer each with file:line evidence)

1. **Disconnect must not imply interrupt/approval/retry, and must not spawn a second run.** Trace what
   actually happens to a *running* turn when its client transport disappears. Can the reaper, orphan
   sweep, or lease expiry settle or kill a turn whose creator process is alive? Can it start a second
   run for the same lineage while the first is still executing?
2. **Projection honesty.** Is there any path where a read (`companion.sessions.list` /
   `companion.sessions.history`) creates, resumes or activates a runtime, writes a row, or otherwise
   mutates state? Is any source error collapsed into a fake `0`, an empty list, or an implicit
   `Main conversation`?
3. **Receipt correctness.** For every exit path of the creation saga and reconcile, does the projected
   `operation_status` / `row_state` match reality? Specifically look for: a live, still-running creator
   whose receipt says `recovery_required`; a refusal reported as uncertain; an uncertain outcome
   reported as a clean, retry-inviting failure; a receipt with `client_request_id: null` that a client
   cannot correlate.
4. **Unknown-outcome handling.** If the response is lost (client killed) mid-create or mid-dispatch,
   does reconcile by the same `client_request_id` return the durable truth without creating a second
   session, and without a blind resubmit?
5. **Cross-client / cross-profile safety.** Two clients on the same persisted session: can they end up
   with two live runtimes or two logical conversations for one lineage? Can browsing from Companion
   change the Desktop's global active project, another task's cwd, or another profile's state?
6. **Removal risk.** Did `methods_session.py` lose any registration, guard, or behaviour that another
   caller still depends on (grep the repo for the removed names)? Same question for
   `hermes_state_sessions.py` and `gateway/status.py`.
7. **Disconfirming evidence.** Actively try to falsify the "exactly one run / no second logical
   conversation / honest projection" claims, and say which claims you could NOT verify and why.

## Evidence rules

- Every finding: severity (BLOCKER / MAJOR / MINOR / NIT), `path:line`, what breaks, the concrete
  triggering sequence, and confidence (HIGH/MEDIUM/LOW) with an explicit `VERIFIED` (you read the code
  and traced the path) vs `INFERENCE` (reasoned but unproven) label. No speculation without the label.
- Say explicitly what you read and what you did **not** cover. Honest `uncertain` / `not verified`
  markers are required; do not fill gaps with plausible prose.
- End with `Verdict: PASS | PASS WITH FINDINGS | FAIL`, a count by severity, and a top-3 list.
