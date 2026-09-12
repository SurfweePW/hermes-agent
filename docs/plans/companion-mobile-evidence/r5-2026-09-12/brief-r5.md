# Task — close the R5 crash-boundary coverage gap (real-process scenarios)

You are extending an existing, deliberately built real-process test suite. Read this whole brief
first. The rule that matters most: **do not invent new architecture, and do not duplicate coverage
that already exists elsewhere.**

## Where you are

- Repo: `/Users/atlasweber/hermes-companion`, branch `feature/hermes-companion`, HEAD `03c0e34260`.
- Working tree is clean. You **may** edit `tests/tui_gateway/test_companion_creation_process_matrix.py`,
  `tests/tui_gateway/fixtures/companion_stdio_gateway.py`, and — only if genuinely required — the
  other companion test files under `tests/tui_gateway/`. **Do not edit production code**
  (`tui_gateway/**`): this task adds evidence, it does not change behaviour.
- **Do not commit, push, or create branches.** Leave the tree dirty; the caller reviews and commits.
- Never run bare `pytest`; always `scripts/run_tests.sh`.

## The gap

`docs/plans/companion-mobile-evidence/p4-current-design-v2.md` §4.3 is the authoritative failure-state
table ("all durable gaps", lines ~242–265). Requirement R5 is that the system is safe at **every** row
of that table. An independent audit found the process matrix covers only about five rows and flagged
the rest as unverified.

The matrix today covers these rows (verify the mapping yourself, do not trust this list):
`test_duplicate_create_from_two_processes_yields_one_session_and_one_dispatch`,
`test_capacity_refusal_has_no_durable_creation_effects`,
`test_crash_before_submit_entry_recovers_as_not_admitted_with_zero_dispatch`,
`test_crash_after_admission_recovers_as_unknown_outcome`,
`test_same_request_id_with_a_different_payload_is_refused`,
`test_death_before_the_trusted_create_leaves_no_row_and_no_dispatch`.

## What to do

1. Enumerate every row of §4.3 with its line number. Produce a table: row → covered / not covered →
   where it is covered (file + test name) or `MISSING`.
2. Before writing anything, **search the whole `tests/` tree** for existing coverage of each
   uncovered row — several are likely already exercised by
   `test_companion_creation_recovery.py`, `test_companion_creation_reservations.py`,
   `test_companion_session_continuity.py`, `test_companion_creation_reconcile_rpc.py`, or the
   observation/index suites. Existing unit coverage is a legitimate "covered, elsewhere" answer;
   record it with `file::test_name`.
3. Add **one real-process scenario per genuinely missing row** that can be reproduced faithfully at
   process level, following the existing style in the matrix file: spawn the real gateway through the
   fixture in `tests/tui_gateway/fixtures/companion_stdio_gateway.py`, kill or halt it at the exact
   boundary the row names, restart, reconcile, then assert on **real artifacts** (SQLite rows in the
   real temp profile DB, the real registry file, the real recorded event file) rather than on mocks.
   The fixture already exposes test-only halt hooks (`HERMES_COMPANION_TEST_HALT_AT`) and event
   recording — reuse them; extend them if a new boundary needs a new hook, and keep every hook
   strictly test-only and inert in production.
4. For any row that genuinely cannot be reproduced faithfully at process level, do **not** fake it with
   a mock that proves nothing. Say so explicitly in the report, name what would be required, and add
   the closest honest automated check only if it still proves the row's contract.
5. Each new test must assert the row's contract, not a current snapshot: the invariant is what the
   table's "Duplicate prevention" and "Recovery/result" columns demand (e.g. "no dispatch", "never
   recreate", "fail closed"). Never weaken or delete an existing assertion. No change-detector tests,
   and never read source files as text in a test.

## Verification (required, in this order)

```
scripts/run_tests.sh tests/tui_gateway/test_companion_creation_process_matrix.py          # 3 times in a row
scripts/run_tests.sh tests/tui_gateway                                                      # whole directory
.venv/bin/ruff check <every file you touched>
git diff --check
```

Baseline for the whole directory is `127 files, 1791 tests passed, 0 failed`. The matrix baseline is
`6 tests passed, 0 failed`; it must stay green across three consecutive runs (these are process-level
tests — flakiness here is a real defect, report it rather than retrying away). Do not add tests that
take longer than the existing ones without saying why.

## Deliverable

Write `/Users/atlasweber/.hermes/profiles/atlas/workspace/companion-r5-2026-09-12/report-r5.md`:

1. The row → covered/covered-where/MISSING table.
2. Per new test: the row it proves, the mechanism (how the process is killed/halted), and the exact
   assertions.
3. Per still-uncovered row: why it cannot be reproduced faithfully yet.
4. Exact commands and their result lines.
5. Final line exactly: `R5_STATUS: DONE` or `R5_STATUS: BLOCKED: <reason>`.

Print a short summary as your final answer. Never print credentials or tokens; use `[REDACTED]`.
