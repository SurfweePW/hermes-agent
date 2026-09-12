# G3c — final real-process creation matrix (evidence)

Spec: `docs/plans/companion-mobile-evidence/p4-current-design-v2.md` §4.3 (failure table) and
§4.4 (uniqueness proof). This closes the last missing G3c acceptance element on the server
side: an independent-process concurrency matrix over real shared C/T/registry files.

## What was missing before

`tests/tui_gateway/test_companion_transport_integration.py` already drives the real stdio
gateway in real subprocesses for continuation (MC-09/MC-11 lost response, MC-12 two clients
on one session, MC-13 reconcile). Nothing equivalent existed for **creation**: duplicate
delivery, racing creators, or death at a durability boundary.

## New artefact

- `tests/tui_gateway/test_companion_creation_process_matrix.py` — five scenarios, each in its
  own real gateway process(es) sharing one temp `HERMES_HOME`, so C/T/registry files are real.
- `tests/tui_gateway/fixtures/companion_stdio_gateway.py` — env-gated test-only extension:
  an append-only event log (`create_entry`, `submit_entry`, `agent_build`, `halt <point>`) and
  hard crash boundaries (`os._exit(9)`) at named points. Both are inert unless the test sets
  the env vars; no production code carries a bypass.

## Scenarios and results (run 5×, stable)

| # | Scenario | Assertion (contract) | Observed |
|---|---|---|---|
| 1 | Two competing gateway processes, same `client_request_id`, same payload | exactly one `create_entry`, exactly one `submit_entry`, exactly one `agent_build`, exactly one session row; both replies share one `stored_session_id` | held in all 5 runs; the losing process returns the same logical operation, never a second creation. **Correction after the independent audit:** the loser does *not* release a capacity reservation — as implemented, the durable index is bound before capacity is claimed, so the loser never acquires one. Design §3.2 step 9 requires the opposite order (acquire, then bind, then release on loss). See the audit defect 1 below. |
| 2 | Death at `submit_entry` (dispatching, before the submit pipeline) | reconcile by request id → `not_admitted`, `runtime_session_id` null, zero pipeline entries, no session row | held |
| 3 | Death at `agent_build` (admitted, before build/thread) | reconcile → `interrupted_outcome_unknown`, `row_state` `present` — never a fabricated success | held |
| 4 | Same `client_request_id`, different payload | refusal with documented conflict code 4090 (`client_request_id conflicts with different creation payload`), row count and dispatch count unchanged | held |
| 5 | Death at `create_entry` (before the reserved create commits) | reconcile → `not_admitted`, `row_state` `absent`, reserved `stored_session_id` stable across a retry, zero rows, zero `submit_entry`, zero `agent_build` | held |

Scenario 5 was added after the independent review (below) pointed out that the fixture
advertised a `create_entry` halt point that no test used, leaving the §4.3 "preparing" row
untested.

## Commands

```
scripts/run_tests.sh tests/tui_gateway/test_companion_creation_process_matrix.py \
    tests/tui_gateway/test_companion_transport_integration.py \
    tests/tui_gateway/test_companion_creation_{coordinator,index,observation,reconcile_rpc,recovery,reservations}.py \
    tests/tui_gateway/test_companion_{reserved_session_create,session_create_rpc,session_continuity}.py
```

Result: **11 files, 486 tests passed, 0 failed** — the 481 pre-existing G3c tests plus 5 new
matrix scenarios.

## Independent review of this matrix (GLM-5.3, adversarial lens C2)

Verdict: **PASS WITH FINDINGS** — the matrix is falsifiable per scenario, the fixture's
env-unset behaviour is a clean pass-through, and the counters prove the product ran. The
review's own limits: it read code only (no suite run) and could not measure the hit rate of
the race it identified; its exposure of the workspace guard's internals and of two unrelated
import bindings stayed unverified.

Acted on (all in the test artefact, no production change):

- Receipt status assertions moved from an observed-common-case set to the closed §1.4
  vocabulary — the old set excluded spec-legal `claimed`/`running`/`completed`, reachable when
  `mark_running` wins the race against receipt projection (a real flake source).
- Crash scenarios now assert death itself: the child's exit code and the emitted halt event,
  instead of inferring death from a receive timeout.
- The retry half of the dispatching-death scenario is judged by effect (row set and dispatch
  counters) instead of being skipped when the retry returns an error envelope.
- Reconcile is asserted to be a read: identical row set and no new pipeline entries.
- The payload-conflict scenario now fails loudly on a receipt instead of accepting one.
- Unused `import os` removed.

Left open, with reasons:

- The `submit_entry` halt cannot distinguish "dispatching, before submit" from "inside submit,
  before admit" — the durable evidence is identical at both points; the §4.3 rows are covered
  by scenarios 2 and 3 between them.
- The fixture stubs the startup orphan sweep, so production-restart recovery does not run in
  these scenarios; that path needs its own harness.
- One assertion (`at most one runtime id across both receipts`) cannot catch a *missing* winner
  runtime id; the non-vacuity check added instead requires that the operation really reached
  the stored row.

## Independent audit gate — FAIL (2026-09-12)

`gpt-5.6-sol` via `openai-codex`, reasoning `high`, one-shot over the frozen candidate
`3c4e18bcef`, read-only. Verdict: **`AUDIT_VERDICT: FAIL`** — the candidate is not fit to close
G3c, even behind a feature gate. Full report:
`docs/plans/companion-mobile-evidence/sol-audit-2026-09-12/report-sol-audit.md`.

Claims C2–C7 and C10 were CONFIRMED; C1 is PARTIAL/literally REFUTED (the index is bound before
capacity is reserved, so a losing duplicate never holds a reservation to release); C8 and C9 are
PARTIAL (the fixture always installs test auth and a synthetic persistence agent; the vitest and
typecheck numbers were not reproduced by the auditor).

Must fix before the gate closes:

1. **High** — `tui_gateway/companion_session_create.py:337-378` binds the durable request index
   *before* `_claim_active_session_slot` (`:354`). Design §3.2 (steps 6–9, lines 176–185) requires
   reserve-then-bind, and "a rejected capacity reservation has zero creation business effects".
   As implemented, a capacity refusal creates and closes a durable creation operation.
2. **High / product-blocking** — the mobile client does not enter durable creation at all (see
   the client gap below).
3. **Medium** — `_null_creation_receipt` (`tui_gateway/companion_creation.py:386-398`) returns
   nulls in `backend_namespace`, `profile` and `client_request_id`, which §1.4 requires to be
   strings.

Open items adjudicated: O1 owner checks exist (not a defect); O2 intentional; O3 server-safe but
client-incomplete; O4 is defect 3 above; O5 is intentional exception preservation in
`tui_gateway/companion_projects.py:464-474` (the earlier brief named a nonexistent `hermes_cli/`
path); O6 confirmed a tool-output redaction artefact — the file contains `= None`, the bytes
`***` do not appear in it.

## Still not covered (needs the phone, or a second real client)

- Two *real* clients (Android + Mac) on one candidate session: the matrix uses two protocol
  clients on one backend; the human-visible acceptance (MC-16 new session visible on Desktop,
  MC-14 disconnect does not interrupt) is not covered here.
- The mobile client does not yet call `companion.sessions.create` (verified: `apps/companion`
  contains no such RPC; new conversations still go through the generic `session.create` +
  `prompt.submit` "Bot Chat" path), so the durability proven here is not yet reachable from
  the app. This is the largest remaining product gap.
