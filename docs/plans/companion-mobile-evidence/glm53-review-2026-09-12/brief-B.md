# Independent code review — lens B: persistence projection, recovery & session lifecycle

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

Hermes Companion mobile continuity work. The scope under review is the uncommitted work in this
worktree: `git diff HEAD` (70 modified files, ~11.4k insertions) plus untracked new files listed
by `git status --porcelain` (new files are NOT in `git diff`).

## Your lens — reads, resume/recovery, projection, lifecycle, disconnect

Primary files (read the real file contents, not only the diff):

- `tui_gateway/companion_sessions.py` (+771 lines)
- `tui_gateway/session_lifecycle.py`, `tui_gateway/session_reaper.py`, `tui_gateway/session_workdir.py`
- `tui_gateway/methods_session.py` (large DELETION — check where the code went and whether any
  caller still needs it), `methods_session_create.py`, `methods_session_resume.py` (both new)
- `tui_gateway/prompt_turn.py`
- `tui_gateway/companion_library.py`, `tui_gateway/companion_priorities.py`
- `hermes_state_sessions.py`, `hermes_cli/active_sessions.py`, `gateway/status.py`
- `hermes_cli/companion_work_store.py` (a module-scope import was moved into a call site)

Useful context: `docs/plans/2026-09-09-companion-mobile-continuity-implementation.md`
(sections 4, 6-P1/P3/P7, 7) and `docs/plans/companion-mobile-evidence/baseline.md`.
Treat those documents as CLAIMS to verify, not as established fact.

## Claims to attack (each must get VERIFIED / REFUTED / INCONCLUSIVE + file:line evidence)

1. READING NEVER EXECUTES. Listing sessions/projects/history, opening a chat view, browsing a
   project, or refreshing the directory must not create a runtime, call `session.create`,
   `session.resume`, `prompt.submit`, or activate a project / change another task's `cwd`.
   Attack: `session.resume` side effects, lazy resume on view open, project activation on read,
   directory refresh paths.
2. Client disconnect does NOT stop server-side work: no implicit interrupt, no implicit
   approval, no implicit retry, no second run. Check `session_reaper.py`, orphan/reclaim logic,
   execution-owner tracking, and the absence of the reaper entry from the diff.
3. Two clients on one logical session converge on ONE live run/turn. A second message while a
   turn is in flight must not start a parallel turn.
4. Compacted sessions resolve to a current logical tip: no second logical conversation for one
   lineage; `stored_session_id` and `runtime_session_id` stay distinct and are never used
   interchangeably.
5. Status/projection honesty: an unavailable/stale/unauthorized/failed source must never
   collapse into a fake empty list, a fake `0`, or an implicit default project/session.
   `gateway/status.py` and `hermes_cli/active_sessions.py` changed — verify their new fields and
   who consumes them.
6. The `hermes_cli/companion_work_store.py` import deferral actually fixes the four suites that
   sandbox `hermes_constants` in `sys.modules`, and does not itself bypass a profile-home
   safety check on any path that needs it.

## Also hunt for (your own findings)

- Any remaining module-scope import in the changed files that re-introduces the same
  import-time coupling through `tui_gateway.server`.
- Silent failure paths, swallowed exceptions, `try/except: pass`, or `.get()` defaults that
  turn a source error into an empty result.
- Cache/state that survives logout and leaks a previous identity's history or drafts.
- Data-loss or duplication risks on recovery/reconcile: partial writes, non-atomic
  index+store updates, or a receipt written for a row that was never committed.
- Anything that breaks OTHER callers of the removed `methods_session.py` code — enumerate the
  call sites with file:line.
- Anything that would fail after merging into `origin/main` (these files do not exist there).

## Method

- Read the actual current file text. Quote exact `file:line` for every claim.
- For each claim: try to construct a concrete counterexample. If you cannot, say so explicitly.
- Label every statement `EVIDENCE` or `INFERENCE`.
- If verification needs a running gateway, a real phone, or two real clients, write `BLOCKED`
  with exactly what is missing. Never fill gaps with plausible prose.
- Confidence: HIGH / MEDIUM / LOW on every finding.

## Deliverable

Write your report to:
`/Users/atlasweber/.hermes/profiles/atlas/workspace/companion-g3c-glm53-review-2026-09-12/review-B.md`

Structure:

1. `## Verdict` — `PASS`, `PASS WITH FINDINGS`, `REQUEST CHANGES`, or `BLOCKED`, plus one
   paragraph why, and whether this code is safe to freeze as a release candidate from your lens.
2. `## Claim verification` — the six claims, each with verdict + file:line evidence.
3. `## Findings` — numbered: severity (BLOCKER / MAJOR / MINOR / NIT), file:line, what is wrong,
   why it matters, concrete failure scenario, confidence, suggested check (not a patch).
4. `## Blocked / not verifiable here`.
5. `## Files read` — exact paths you opened.

Then print to stdout a summary: verdict, counts by severity, top 3 findings one line each,
under 1500 characters.
