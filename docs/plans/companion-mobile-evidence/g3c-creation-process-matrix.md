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

- `tests/tui_gateway/test_companion_creation_process_matrix.py` — four scenarios, each in its
  own real gateway process(es) sharing one temp `HERMES_HOME`, so C/T/registry files are real.
- `tests/tui_gateway/fixtures/companion_stdio_gateway.py` — env-gated test-only extension:
  an append-only event log (`create_entry`, `submit_entry`, `agent_build`, `halt <point>`) and
  hard crash boundaries (`os._exit(9)`) at named points. Both are inert unless the test sets
  the env vars; no production code carries a bypass.

## Scenarios and results (run 5×, stable)

| # | Scenario | Assertion (contract) | Observed |
|---|---|---|---|
| 1 | Two competing gateway processes, same `client_request_id`, same payload | exactly one `create_entry`, exactly one `submit_entry`, exactly one `agent_build`, exactly one session row; both replies share one `stored_session_id` | held in all 5 runs; the losing process releases its reservation and returns the same logical operation (`preparing`/`admitted`), never a second creation |
| 2 | Death at `submit_entry` (dispatching, before the submit pipeline) | reconcile by request id → `not_admitted`, `runtime_session_id` null, zero pipeline entries, no session row | held |
| 3 | Death at `agent_build` (admitted, before build/thread) | reconcile → `interrupted_outcome_unknown`, `row_state` `present` — never a fabricated success | held |
| 4 | Same `client_request_id`, different payload | refusal with documented conflict code 4090 (`client_request_id conflicts with different creation payload`), row count and dispatch count unchanged | held |

## Commands

```
scripts/run_tests.sh tests/tui_gateway/test_companion_creation_process_matrix.py \
    tests/tui_gateway/test_companion_transport_integration.py \
    tests/tui_gateway/test_companion_creation_{coordinator,index,observation,reconcile_rpc,recovery,reservations}.py \
    tests/tui_gateway/test_companion_{reserved_session_create,session_create_rpc,session_continuity}.py
```

Result: **11 files, 485 tests passed, 0 failed, 6.7 s (20 workers)** — the 481 pre-existing G3c
tests plus 4 new matrix scenarios.

## Still not covered (needs the phone, or a second real client)

- Two *real* clients (Android + Mac) on one candidate session: the matrix uses two protocol
  clients on one backend; the human-visible acceptance (MC-16 new session visible on Desktop,
  MC-14 disconnect does not interrupt) is not covered here.
- The mobile client does not yet call `companion.sessions.create` (verified: `apps/companion`
  contains no such RPC; new conversations still go through the generic `session.create` +
  `prompt.submit` "Bot Chat" path), so the durability proven here is not yet reachable from
  the app. This is the largest remaining product gap.
