# R5 crash-boundary coverage audit

Status: **BLOCKED — production behavior violates §4.3 row 254.**

Scope: `docs/plans/companion-mobile-evidence/p4-current-design-v2.md` §4.3, lines 246–265, audited against the entire `tests/` tree. Existing unit/integration coverage counts as coverage. New real-process scenarios use the existing stdio fixture, `os._exit(9)` only after the named production boundary commits, restart a fresh gateway, reconcile by owner/request/backend/profile, and assert real SQLite/registry/event artifacts.

No production files were changed.

## Coverage table

| Line | Crash/failure boundary | Status | Coverage |
|---:|---|---|---|
| 246 | Draft or pure preflight | COVERED | `tests/tui_gateway/test_companion_session_create_rpc.py::test_strict_schema_rejected_before_writes` |
| 247 | Reservation refused | COVERED | `tests/tui_gateway/test_companion_creation_process_matrix.py::test_capacity_refusal_has_no_durable_creation_effects` |
| 248 | Reservation acquired, before C bind | COVERED (new real process) | `tests/tui_gateway/test_companion_creation_process_matrix.py::test_death_after_reservation_before_binding_is_cleaned_and_not_found` |
| 249 | C binding commit ambiguous | COVERED | `tests/tui_gateway/test_companion_session_create_rpc.py::test_ambiguous_committed_bind_releases_then_reconciles_without_second_key` |
| 250 | C bound, before preparing | COVERED | `tests/tui_gateway/test_companion_creation_recovery.py::test_dead_creator_recovery_failure_table` (`bound/absent`, dead/alive/unknown cases) |
| 251 | C preparing, before/during trusted create | COVERED | `tests/tui_gateway/test_companion_creation_process_matrix.py::test_death_before_the_trusted_create_leaves_no_row_and_no_dispatch`; `tests/tui_gateway/test_companion_creation_recovery.py::test_dead_creator_recovery_failure_table` (`preparing/absent/dead`) |
| 252 | Runtime allocated, before T preparation | COVERED | `tests/tui_gateway/test_companion_session_create_rpc.py::test_crash_after_runtime_before_row_tears_down_exact_runtime_and_reservation` |
| 253 | T preparation transaction interrupted | COVERED | `tests/tui_gateway/test_companion_session_continuity.py::test_created_session_row_and_first_claim_commit_atomically`; `tests/tui_gateway/test_companion_session_continuity.py::test_created_session_preparation_rolls_back_row_and_claim_together` |
| 254 | T pair committed, C still preparing | **NOT COVERED / MISSING** | New evidence test: `tests/tui_gateway/test_companion_creation_process_matrix.py::test_death_after_turn_pair_before_coordinator_prepared_settles_without_dispatch` — fails because reconciliation returns `recovery_required`, not required `not_admitted` |
| 255 | C prepared, before dispatch gate | COVERED | `tests/tui_gateway/test_companion_creation_recovery.py::test_dead_creator_recovery_failure_table` (`prepared/claimed/dead`) |
| 256 | C dispatching, before entering submit | COVERED | `tests/tui_gateway/test_companion_creation_process_matrix.py::test_crash_before_submit_entry_recovers_as_not_admitted_with_zero_dispatch` |
| 257 | Inside submit before admit | COVERED (new real process) | `tests/tui_gateway/test_companion_creation_process_matrix.py::test_death_inside_submit_before_admission_settles_without_build` |
| 258 | Admit commit ambiguous | COVERED (new real process) | `tests/tui_gateway/test_companion_creation_process_matrix.py::test_death_after_admit_commit_never_retries_pipeline_or_reports_rejection` |
| 259 | Admitted, before build/thread | COVERED | `tests/tui_gateway/test_companion_creation_process_matrix.py::test_crash_after_admission_recovers_as_unknown_outcome` |
| 260 | Build/thread started, before running write | COVERED (new real process) | `tests/tui_gateway/test_companion_creation_process_matrix.py::test_death_after_agent_build_before_running_write_is_unknown_and_not_replayed` |
| 261 | Running or tool side effects, before settlement | COVERED | `tests/tui_gateway/test_companion_creation_recovery.py::test_dead_creator_recovery_failure_table` (`dispatching/running`, dead executor); `tests/tui_gateway/test_companion_session_continuity.py::test_creation_recovery_requires_coordinator_creator_authority` |
| 262 | T terminal, before C close | COVERED | `tests/tui_gateway/test_companion_creation_recovery.py::test_settlement_close_crash_resumes_and_competing_finalizers_are_idempotent` |
| 263 | C close, before response/client save | COVERED | `tests/tui_gateway/test_companion_creation_reconcile_rpc.py::test_registered_creation_reconcile_returns_exact_server_bound_receipt_once`; `tests/tui_gateway/test_companion_session_create_rpc.py::test_registered_create_chain_is_durable_lazy_and_exactly_once` |
| 264 | Lease rollback/cleanup write fails | COVERED | `tests/tui_gateway/test_companion_creation_reservations.py::test_rollback_three_failures_retains_reference_and_sanitizes_log`; `tests/tui_gateway/test_companion_creation_reservations.py::test_later_lifecycle_sweep_retries_exact_retained_release` |
| 265 | T deleted/replaced after preparation | COVERED | `tests/tui_gateway/test_companion_creation_recovery.py::test_dead_creator_recovery_failure_table` (`prepared/absent`, `dispatching/inconsistent`, `dispatching/unavailable`); `tests/tui_gateway/test_companion_creation_observation.py::test_missing_pair_classification_is_read_only` |

## New real-process evidence

Added five genuinely missing process scenarios:

1. Row 248: halt immediately after real strict reservation acquisition, before C bind. Verifies no SQLite row/create/submit/build, request reconciliation is `not_found`, and a later one-slot reservation pass cleans the dead registry key.
2. Row 254: halt after `prepare_created_session` commits the ordinary row + claimed turn, before the caller can CAS C to `prepared`. Verifies one row and zero submit/build. This exposes the blocker below.
3. Row 257: enter real `prompt.submit`, complete its lock-in, halt before durable admission. Restart settles `not_admitted`; exact retry does not submit or build again.
4. Row 258: halt immediately after real `admit_turn` commit. Restart returns `interrupted_outcome_unknown`, never `not_admitted`; exact retry does not re-enter submit/build.
5. Row 260: complete real synthetic agent construction, halt before the builder publishes readiness to the run path. Restart returns `interrupted_outcome_unknown`; exact retry does not submit/build again.

The fixture additions are test-only pass-through wrappers when `HERMES_COMPANION_TEST_HALT_AT` is absent. No sleeps or widened timeouts were added.

## Blocker / production mismatch

The row-254 process test reaches exactly:

- C phase: `preparing`
- T evidence: complete ordinary session row + `claimed` turn/slot pair
- creator: dead (`os._exit(9)`)
- submit count: 0
- agent-build count: 0

Required result: settle T `not_admitted`, then close C with `turn_record`.

Observed result: `recovery_required`.

The cause is in production `tui_gateway/companion_creation.py:573`: `_reconcile_creation_recovery` settles a dead `claimed` record only when C phase is `{prepared, dispatching}`. It excludes `preparing`, although §4.3 line 254 requires that exact stale phase to settle. Fixing it requires a production-code change, which this task explicitly forbids.

The assertion was not weakened and the failing evidence test was left in the dirty tree.

## Verification

Required order was attempted. The first matrix run was not green, so three consecutive green runs were impossible.

- Matrix run 1: **10 passed, 1 failed** — row 254 returned `recovery_required`.
- Matrix run 2: **10 passed, 1 failed** — identical deterministic failure.
- Matrix run 3 (after fixture cleanup): **10 passed, 1 failed** — identical deterministic failure.
- Full `tests/tui_gateway`: **1,795 passed, 1 failed** — only the new row-254 test failed.
- Ruff on both touched files: **passed**.
- `git diff --check`: **passed**.

This is not flaky: the same semantic failure reproduced on all three matrix runs. The full-suite matrix file took 32.83s under 20-way per-file parallelism because it contains 11 real gateway scenarios; no artificial delay or timeout increase was introduced.
