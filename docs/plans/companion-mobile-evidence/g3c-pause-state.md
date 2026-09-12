# G3c Pause State — 2026-09-11 (Codex usage limit exhausted)

## Status

G3c is OPEN, not formally closed. Local implementation is far along; final independent
`PASS` is blocked by provider exhaustion.

- Provider: `openai-codex` (Sol) — `rate-limited usage_limit_reached (429)`, reset ~5d 18h.
- Last failed delegation: `deleg_c73022d2` (HTTP 429 after 3 retries).
- Earlier checkpoint: 40 audits/night exhausted the topped-up ~50 EUR account.

## Implemented (verified locally, focused gates green)

- B1: live owner revalidation after project/workspace validation, before
  `prepared -> dispatching` CAS (first seam).
- B1: target-store 4404 → exact 10-field `row_state="unavailable",
  operation_status="recovery_required"` receipt (open-time projection).
- B2: held workspace identity — pinned `projects.db` descriptor/device/inode,
  full ancestor device/inode chain, selected project + folder content fingerprint,
  no-project cwd gets same directory policy; pre-runtime and pre-dispatch gates.
- Five-phase machine `bound → preparing → prepared → dispatching → closed`
  and exactly-once submit restored after earlier worker regressions.
- Full provisional-runtime fence cluster A: `session.close`, `session.workspace.move`,
  `session.active_list`, session-scoped `llm.oneshot`, `session.resume`
  (row-less + persisted live + claimed persisted cold reconstruction), eager-build
  race fence — all closed and reviewed `PASS` (review `deleg_d3955080`).

## Open (from audit `deleg_eb72f9d9` — REQUEST_CHANGES, not yet fixed)

1. Owner revocation **after** `bind_turn` still reaches `prompt.submit`
   (revalidation seam #2 missing — fix #1 of `deleg_c73022d2` was intended).
2. Held workspace snapshot opens/closes at initial resolution, then a second one
   starts only after coordinator insertion + slot reservation — must be one
   continuous context from first resolution through dispatch validation.
3. 4404 raised inside `_reconcile_creation_recovery` body is wrongly converted to
   target-store unavailable receipt — projection must apply only while entering/
   opening `_source`.

## Intended fix plan (next Sol run, after limit reset)

Fixes 1–3 exactly as delegated to `deleg_c73022d2` (see its task text in
`/Users/atlasweber/.hermes/profiles/atlas/cache/delegation/live/deleg_c73022d2/task-0.log`
and conversation). Then: full gate + independent audit + final subprocess E2E
duplicate/race/failure matrix (real shared C/T/registry files) — the last missing
G3c acceptance element.

## Latest local evidence (pre-pause)

- Creation saga: 30/30; reconcile RPC: 39/39; five-phase/exactly-once: 354/354.
- Full provisional-runtime fence/resume/reserved suites: 692/692 earlier; re-run after final fixes.
- Ruff, `py_compile`, `git diff --check`: PASS.

## Checkpoints

- Full dirty checkpoint (96 paths): `/tmp/hermes-companion-g3c-review-findings.tar.gz`
  SHA-256 `d068d924b0be6be3c0f5c2eb393b0e524ad0f895b7ff4dea1a9cae0f2d7897af`.
- After cluster A/B fixes (96 paths): `/tmp/hermes-companion-g3c-pre-pause.tar.gz`
  (re-archive before resuming if it no longer exists).
- Constraint reminder: shared dirty worktree — no commits, no restore/reset/checkout/clean.

## Verified state re-check — 2026-09-11 23:10 CEST (read-only, no code change)

Re-audit after the pause, to remove guesswork from the next Sol run:

- **Live tree is byte-identical to this checkpoint.** Every `.py` file in
  `checkpoints/hermes-companion-g3c-pre-pause.tar.gz` matches
  `/Users/atlasweber/hermes-companion` — no drift, nothing landed after 03:32.
  `/tmp/hermes-companion-g3c-review-findings.tar.gz` has the same content (both
  archives were taken at the same code state), so the archives are a valid
  restore reference but NOT a pre-fix baseline.
- **Focused gate moved from green to 1 red.** Pre-pause evidence claimed
  "creation saga 30/30"; the tree now reports:

  ```
  scripts/run_tests.sh tests/tui_gateway/test_companion_creation_{coordinator,
  index,observation,reconcile_rpc,recovery,reservations}.py \
  test_companion_reserved_session_create.py test_companion_session_create_rpc.py \
  test_companion_session_continuity.py
  → 9 files, 478 passed, 1 failed
  FAILED test_companion_session_create_rpc.py::
         test_owner_is_revalidated_at_both_dispatch_boundaries[before_dispatch]
    assert 'recovery_required' == 'not_admitted'
  ```

  The P1 transport gate is unaffected —
  `scripts/run_tests.sh tests/tui_gateway/test_companion_transport_integration.py`
  → 1 passed, 0 failed (the subprocess MC-09/MC-11/MC-12/MC-13 gate). Complete G3c
  focused picture: **10 files, 479 passed, 1 failed**.

  The `before_submit` arm of the same test passes; only `before_dispatch` fails.
  `deleg_c73022d2` wrote that test for fix #1 and then died on HTTP 429 (03:31:04),
  so the failing arm is its own unfinished work, not a regression of a shipped path.
- **Failing locus (fix #2/#3 territory, not fix #1):** with revocation injected
  during the second `resolve_creation_workspace` call, `_require_owner` at
  `tui_gateway/companion_session_create.py:455` raises while phase is still
  `prepared`; the handler's `except CompanionSessionsError:` branch routes it through
  `_settle_prepared(...)`, and when that returns `settled=False` the receipt is
  overwritten to `recovery_required` at `companion_session_create.py:561`. An
  authorization refusal is therefore projected as an uncertain outcome instead of
  `not_admitted` — the same projection defect class as open finding #3.
- **Acceptance target for the remaining work is already written:** the failing test
  (`tests/tui_gateway/test_companion_session_create_rpc.py:357-394`, assert at :393)
  defines done. No new test needs authoring.

### Updated next-step

1. Make `[before_dispatch]` return `not_admitted` without weakening the
   `before_submit` arm or the 478 currently-passing G3c tests.
2. Then re-check findings #1 and #2 as *completed*, not assumed: #1 partially landed
   (`_require_owner` at :448 and :455, `resolve_creation_workspace` at :450), #2 is
   only *compared* against the held workspace — confirm it is one continuous context
   from first resolution through dispatch validation rather than a fresh re-resolve.
3. Then full gate + independent audit + final subprocess E2E matrix (unchanged).
4. Mode decision pending with Pawel: finish on `deepseek-v4.1-flash` (narrow, test as
   target, no commits) or wait for the Sol/Codex weekly reset (~2026-09-16 22:00 CEST;
   the binding limit is the plan window, not credits — 785 credits remain).

Constraints unchanged: shared dirty worktree — no commits, no restore/reset/checkout/clean.

## Astra note

The Astra prohibition remains absolute; all next audits use Sol/Codex only.

## Completion run — 2026-09-12 (deepseek-v4.1-flash, Pawel's decision "kończ… działaj")

### Correction to the 23:10 read-only re-check

The "failing locus" above was a **misdiagnosis**. `_settle_prepared` never returned
`settled=False` on this path, and `companion_session_create.py:561` was not reached.
The real cause was the test's own injection:

- `resolve_creation_workspace` is called **once** per create (`companion_session_create.py:450`);
  the arm's guard `if calls == 2` therefore never fired, so the owner was *never revoked*.
- With no revocation the request ran to completion — measured directly: `submits = 1`,
  turn never settled, `may_close_to_turn_record` false → `recovery_required` at
  `companion_session_create.py:521` (the success path), not `:561`.
- Measured by instrumented run (temporary scratch test, deleted): with the injection
  actually firing at the first resolve call the tree already produced
  `operation_status = "not_admitted"`, `runtime_session_id = null`, `submits = 0`.
  **No production change was needed for the acceptance criteria.**

### Changes made (uncommitted, shared dirty worktree)

1. `tests/tui_gateway/test_companion_session_create_rpc.py` — repaired the broken arm
   (`if not revoked` instead of a call ordinal), added a self-verifying
   `assert revoked == [revocation_gate]` so a silent no-op injection can never again
   pass/fail for the wrong reason, and added the `after_bind` arm that injects
   revocation at the seam named by audit finding #1. Renamed to
   `test_owner_is_revalidated_at_every_gate_before_submit` (three gates, old name said
   "both"). Counted run without `-k`, so a deselected arm cannot fake green.
2. `hermes_cli/companion_work_store.py` — **pre-existing committed regression found by
   the broad gate, not by any earlier focused gate.** The module-scope
   `from hermes_constants import assert_named_profile_home_live` (:19 at HEAD) is
   reached by every `tui_gateway.server` import through
   `methods_work → hermes_cli.companion_work → companion_work_store`, so four old tests
   that sandbox `hermes_constants` in `sys.modules` died at setup/import
   (`ImportError: cannot import name 'assert_named_profile_home_live' from
   '<unknown module name>'`): `test_compaction_status.py`,
   `test_moa_reference_emit.py`, `test_inline_rpc_gil_starvation.py`,
   `test_slash_worker_profile_home.py`. `companion_work_store.py` does not exist on
   `origin/main`, so this would have broken those suites on merge. Fixed by deferring
   the import to its single call site (`_ensure_profile_available`), matching the
   existing lazy-import pattern in `companion_projects.hold_creation_workspace`.

### Findings status (evidence, not assumption)

- **#1 — owner revocation after `bind_turn` reaching `prompt.submit`: CLOSED.**
  Proven by the new `after_bind` arm (revocation injected on `bind_turn` return):
  refusal comes from `_bind_provisional_creation_submission` → `_require_owner`
  (`companion_session_create.py:299`), after `bind_turn` (:465) and before submit;
  `submits == []`, receipt `not_admitted`. The `before_submit` arm covers the
  `_require_owner` at :479. Both arms assert the injection fired.
- **#2 — one continuous held context: CONFIRMED, no code change.**
  `hold_creation_workspace` is entered exactly once
  (`companion_session_create.py:656`, `workspace_stack.enter_context`) and
  `with workspace_stack:` (:671) wraps the whole `_create_session_in_workspace` call,
  so the pinned `projects.db` + directory guards stay open from before the coordinator
  insert (:337) through the `prepared → dispatching` CAS. `resolve_creation_workspace`
  at :450 is an additional identity comparison against that live hold
  (`held_workspace.validate()` at :449), not a replacement context; it opens its own
  short-lived hold internally (`companion_projects.py:482`). The audit's wording
  ("rather than a fresh re-resolve") is satisfied because the comparison never
  replaces the held guards.
- **#3 — refusal projected as uncertainty: fulfillment verified for all three seams.**
  Pre-resolve / pre-dispatch refusals (`_require_owner` :448, :455) go through
  `_settle_prepared` → `_settle_creation_for_refusal` (`methods_prompt.py:633`) and
  project `not_admitted`; the no-claim path (`_rollback_before_row` →
  `_close_index(outcome="not_admitted")`) projects `row_state="absent"` +
  `not_admitted`. A passing test is not an audit: independent review of the
  settle/projection path stays open below.

### Gates on the current tree (real output)

- G3c focused, 10 files → **480 passed, 0 failed**.
- Plan §8 repo gate (13 files, sections 8.1–8.3) → **441 passed, 0 failed**.
- Combined G3c + plan §8 (23 files) → **922 passed, 0 failed**.
- Broad regression `tests/tui_gateway/` + companion/hermes_cli/projects/kanban → **132 files,
  1944 passed, 0 failed** (before the store fix: 1842 passed, 1 failed, 3 files erroring at setup).
- P1 transport subprocess gate (MC-09/11/12/13) included and green.

### Still open (unchanged, not blocked by me)

1. Independent audit of the fixed tree — **Sol/Codex only** (Astra prohibition absolute).
   Blocked by the weekly plan window, reset ~2026-09-16 22:00 CEST; the one-shot cron
   `ed3cdb23b829` (2026-09-17 09:00) resumes it.
2. Final subprocess E2E duplicate/race/failure matrix and the two real clients.
3. No commits were made — the shared dirty worktree is intact by design.

