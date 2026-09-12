# Adversarial audit of a new test file (falsifiability review)

You are an independent adversarial reviewer. Repo `/Users/atlasweber/hermes-companion`
(dirty shared worktree — READ ONLY: no edits, no commits, no git state changes, do not run
the test suite; another process uses the CPU).

## Scope

Two files, both uncommitted and new/modified by the author you are auditing:

1. `tests/tui_gateway/test_companion_creation_process_matrix.py` — a new real-process E2E
   matrix for Companion session creation (duplicate/race/crash boundaries).
2. `tests/tui_gateway/fixtures/companion_stdio_gateway.py` — the test launcher, to which
   env-gated "test-only observability and crash boundaries" wrappers were added
   (`HERMES_COMPANION_TEST_EVENTS_FILE`, `HERMES_COMPANION_TEST_HALT_AT`).

Read also, for the contract under test:
`docs/plans/companion-mobile-evidence/p4-current-design-v2.md` (§4.3 failure table, §4.4
uniqueness proof) and `tests/tui_gateway/test_companion_transport_integration.py` (the
existing harness the new file imports).

## Questions to answer, each with file:line evidence

1. **Falsifiability.** For each of the four tests, name the concrete production defect that
   would make it fail. If a test would still pass with the defect present (vacuous assertion,
   assertion on the harness rather than the product, race that never races), say so explicitly.
   Pay attention to whether the two processes in test 1 actually race, and whether the
   crash tests really prove death at the claimed boundary rather than at another boundary.
2. **Launcher contamination.** Do the added wrappers change production behaviour when the env
   vars are unset? Could they mask a real defect (e.g. by wrapping the wrong symbol, by
   bypassing a required check, or by making a counter prove the harness ran rather than the
   product)? Is `os._exit` inside `submit_entry`/`agent_build` genuinely the boundary the
   design's failure table names?
3. **Assertions vs spec.** Which assertions encode a behaviour contract, and which encode the
   author's observation of current behaviour (a change detector)? Name any assertion the spec
   contradicts.
4. **Missing coverage.** Which row of the §4.3 failure table, or which §4.4 uniqueness claim,
   remains untested by this file plus the existing transport gate? Be specific and short.

## Output

Write your report to
`/Users/atlasweber/.hermes/profiles/atlas/workspace/companion-g3c-glm53-review-2026-09-12/review-C2.md`
and print a copy of it in your final message. Classify each finding BLOCKER / MAJOR / MINOR /
NIT with confidence (HIGH/MEDIUM/LOW). State what you could not verify. No flattery: verdict
first (PASS / PASS WITH FINDINGS / FAIL), then the findings.
