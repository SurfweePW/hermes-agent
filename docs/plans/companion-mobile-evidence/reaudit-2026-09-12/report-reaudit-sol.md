RE-AUDIT_VERDICT: FAIL

The four reported defects are closed in their narrow stated forms. The candidate still fails the design contract because I found two mobile durability defects, including one high-severity loss of unresolved retry metadata.

Frozen-tree verification

Command:
  git branch --show-current && git rev-parse HEAD && git status --short

Observed:
  branch: feature/hermes-companion
  HEAD: a542da9f5b9566c1a3e9eea118489635792a0aba
  status: empty

The same command was repeated after all testing with the same result. No files were modified, formatted, staged, or committed.

D1 — CLOSED

Capacity is now reserved before the durable request index is bound:

- Strict reservation: tui_gateway/companion_session_create.py:335-343
- Capacity refusal returns 4091 before index creation: tui_gateway/companion_session_create.py:344-352
- Index binding starts only afterward: tui_gateway/companion_session_create.py:354-371
- Bind failure rolls back the proposed lease: tui_gateway/companion_session_create.py:372-378

The regression test verifies 4091 and no request-index row, session row, runtime, submit, or retained lease at tests/tui_gateway/test_companion_session_create_rpc.py:542-566.

Command:
  scripts/run_tests.sh tests/tui_gateway/test_companion_session_create_rpc.py::test_capacity_refusal_is_4091_with_no_index_row_runtime_or_submit

Observed:
  1 test passed, 0 failed, exit 0.

Conclusion: a refused reservation no longer leaves an already-created operation.

D2 — CLOSED for the reported defect

The active mobile first-send path now uses the durable APIs:

- Gateway methods call companion.sessions.create, companion.sessions.continue, and companion.sessions.reconcile: apps/companion/src/gateway/companion-client.ts:733-748
- First send persists uncertainty before transmission and calls durable create: apps/companion/src/state/companion-store.ts:1678-1697
- Subsequent sends use companion.sessions.continue: apps/companion/src/state/companion-store.ts:2107-2115
- Owner reconnect reconciles retained creation requests: apps/companion/src/state/companion-store.ts:1616-1632 and :1816-1830

The focused test verifies that:

- Generic createSession/listSessions are not called: apps/companion/src/state/companion-store.test.ts:214-217
- The first connection performs exactly one durable create: apps/companion/src/state/companion-store.test.ts:218-228
- Reconnect reconciles instead of creating again: apps/companion/src/state/companion-store.test.ts:223-230

Command:
  npx vitest run src/state/companion-store.test.ts -t "reconciles an uncertain first send without creating a second session"

Observed:
  1 test passed, 102 skipped, 0 failed, exit 0.

The original “Bot Chat plus generic session.create” defect is therefore closed. Separate durability defects in this new client implementation are reported below.

D3 — CLOSED

Trusted public identity is now passed into degraded-receipt construction:

- Validated backend/profile/request fields enter project_creation_receipt at tui_gateway/companion_creation.py:387-399.
- The degraded receipt explicitly emits those trusted strings rather than null: tui_gateway/companion_creation.py:248-267.
- If identity itself is malformed, the code raises sanitized 5066 rather than returning a schema-invalid receipt: tui_gateway/companion_creation.py:150-169.

The parameterized test verifies degraded receipts preserve backend_namespace, profile, and client_request_id as strings at tests/tui_gateway/test_companion_creation_observation.py:764-801.

Command:
  scripts/run_tests.sh tests/tui_gateway/test_companion_creation_observation.py::test_malformed_liveness_or_age_preserves_trusted_identity

Observed:
  7 parameterized tests passed, 0 failed, exit 0.

D4 — CLOSED

For a dead creator with exact committed turn evidence, claimed turns are now settled from preparing as well as prepared/dispatching:

- preparing is included in the eligible phase set: tui_gateway/companion_creation.py:573-575
- The turn is settled as not_admitted: tui_gateway/companion_creation.py:576-589
- The coordinator is then closed with turn_record evidence: tui_gateway/companion_creation.py:604-618

The row-254 regression test kills the creator after the turn pair commit but before coordinator prepared, then requires not_admitted and an unchanged operation identity at tests/tui_gateway/test_companion_creation_process_matrix.py:589-622.

Command:
  scripts/run_tests.sh tests/tui_gateway/test_companion_creation_process_matrix.py::test_death_after_turn_pair_before_coordinator_prepared_settles_without_dispatch

Observed:
  1 test passed, 0 failed, exit 0.

I also ran:

  git diff 1db6b98b4a^ 1db6b98b4a -- tui_gateway/companion_creation.py tests/tui_gateway/test_companion_creation_process_matrix.py

Observed:
  The predecessor only settled claimed turns in prepared/dispatching. The current change adds preparing and the corresponding crash-boundary test. The test would fail against the pre-fix code because reconciliation would return recovery_required/claimed instead of its asserted not_admitted result.

New defects

1. HIGH — ordinary owner sign-out destroys unresolved durable creation metadata

The contract requires unresolved metadata to survive sign-out and remain partitioned by stable owner identity; it says not to delete it “as a convenience” at docs/plans/companion-mobile-evidence/p4-current-design-v2.md:347.

The implementation instead:

- Derives ownerScope from only the gateway base URL plus a random local UUID, not authenticated server-owner identity: apps/companion/src/state/companion-store.ts:600-611
- Deletes every retry for that scope during sign-out: apps/companion/src/state/companion-store.ts:1840-1850

Concrete failure:

1. A first creation is transmitted, but its response is lost.
2. The retry remains uncertain.
3. The user signs out to refresh credentials or later signs back into the same owner.
4. signOutOwner deletes the only request ID/digest/binding metadata.
5. Reconnect has nothing to reconcile. A later manual first-send can allocate a new request ID and create a duplicate session.

The same URL-based scope can also be reused during account reauthentication without proving the authenticated owner is unchanged, contrary to the account-partition requirement.

2. MEDIUM — 101 unresolved retries are accepted, then all are silently erased on restart

The contract requires a 100-entry limit, refusal of new sends when the limit is reached, and no eviction of unresolved requests: docs/plans/companion-mobile-evidence/p4-current-design-v2.md:349.

Current behavior:

- Load treats more than 100 persisted entries as corruption: apps/companion/src/state/session-operation-retries.ts:92-100
- The catch path deletes the entire stored ledger: apps/companion/src/state/session-operation-retries.ts:99-100
- put() has no 100-entry check and persists every new entry: apps/companion/src/state/session-operation-retries.ts:103-120

I exercised the store directly without writing files. Command used Node’s TypeScript stripping and an in-memory localStorage implementation to insert 101 valid unresolved entries, then reconstructed the store.

Observed:
  {"beforeRestart":101,"serializedBytes":38785}
  {"afterRestart":0,"storagePresent":false}

Concrete failure: the 101st unresolved operation is accepted because the aggregate payload is below the byte limit. On app restart, all 101 request IDs are deleted. They can no longer be reconciled, and later resubmission can create duplicates.

Regression checks

- 4090 conflict: retained. Payload digest mismatch raises 4090 at tui_gateway/companion_creation.py:845-848. The real-process conflict assertions are at tests/tui_gateway/test_companion_creation_process_matrix.py:448-462.
- 4091 capacity refusal: retained. Refusal path is tui_gateway/companion_session_create.py:344-352; focused test passed 1/1.
- 5072 storage failure: retained. Proven absence after ambiguous index write produces 5072 at tui_gateway/companion_session_create.py:400-406. Storage-failure behavior is exercised at tests/tui_gateway/test_companion_session_create_rpc.py:497-523.
- 5066 unknown outcome: retained. Ambiguous reconciliation/rollback paths raise 5066 at tui_gateway/companion_session_create.py:399-403; malformed private evidence is asserted as sanitized 5066 at tests/tui_gateway/test_companion_creation_observation.py:794-817.
- 60-second recovery window: retained. Fresh/alive preparing remains preparing through age <= 60, while older state requires recovery, at tui_gateway/companion_creation.py:473-479. Boundary cases 60.0 and 61.0 are tested at tests/tui_gateway/test_companion_creation_observation.py:407-418.
- 600-second reaper threshold: retained. Default orphan activity staleness is 600.0 seconds at tui_gateway/server.py:143-147.

Requested gates

1. Command:
     scripts/run_tests.sh tests/tui_gateway/test_companion_creation_process_matrix.py

   Observed:
     1 file, 11 tests passed, 0 failed, exit 0.

2. Command:
     scripts/run_tests.sh tests/tui_gateway/

   Observed:
     128 files, 1,796 tests passed, 0 failed, exit 0.

3. Command from apps/companion:
     npx vitest run

   Observed:
     36 files passed, 574 tests passed, 0 failed, exit 0.

4. Command from apps/companion:
     npx tsc -p . --noEmit

   Observed:
     0 diagnostics, no output, exit 0.

5. Command from apps/companion:
     npx eslint src/ -f json

   Observed after parsing the JSON:
     73 file results, 0 errors, 0 fatal errors, 0 warnings, exit 0.

The historical 486/0 result refers to an earlier, unspecified 11-file command. Exact parity with that narrower command is NOT VERIFIED because its full file list is not recorded. The required current full-directory gate is broader and passed 1,796/0. The claimed 574-test JavaScript baseline was reproduced exactly.

Test honesty

- The D4 process test is a real process test, not a psutil mock. StdioRpcClient launches the production fixture using subprocess.Popen at tests/tui_gateway/test_companion_transport_integration.py:25-50.
- Crash injection sends a real JSON-RPC request, waits for process exit code 9, and starts a fresh process for reconciliation at tests/tui_gateway/test_companion_creation_process_matrix.py:139-179.
- Repository search found no mocked psutil in the process matrix or its support path.
- D4 is behavioral, not a source-string change detector: it verifies the persisted receipt, row status, operation identity, and absence of dispatch after a real process death at tests/tui_gateway/test_companion_creation_process_matrix.py:589-622. It would fail on pre-fix code.
- D1’s focused test is also behavioral: it inspects the index, session DB, runtime, submit calls, and lease registry after refusal at tests/tui_gateway/test_companion_session_create_rpc.py:542-566.
- D2’s focused test is meaningful but unit-level: it uses fake gateway methods and proves one durable create followed by one reconcile at apps/companion/src/state/companion-store.test.ts:182-230. It does not prove Android lifecycle or real WebSocket behavior.
- The green JS suite does not cover either newly reported durability defect.

NOT VERIFIED on this machine

- Actual Android device behavior across process death, OS eviction, backgrounding, and app restart.
- Native owner-auth account switching and credential-expiry behavior end to end.
- Real device Web Locks/localStorage behavior under concurrent tabs or multiple app instances.
- Production WebSocket loss during the exact first-response boundary.
- End-to-end UI presentation and accessibility of preparing, recovery_required, and outcome-unknown states.

session_id: 20260912_231933_30d791
