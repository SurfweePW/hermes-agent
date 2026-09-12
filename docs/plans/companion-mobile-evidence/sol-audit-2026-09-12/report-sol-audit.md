# Independent audit — Hermes Companion durable session creation (G3c)

Auditor: gpt-5.6-sol via openai-codex (ChatGPT Codex lane), reasoning=high, source=companion-sol-audit,
session 20260912_214545_3c5882. Read-only over the frozen candidate 3c4e18bcef.

Note: the auditor hit its tool-call limit before it could write this file, so the report below is
recovered verbatim from its run log (run-sol-audit.log). No content was added or reworded.

---

Audit result: FAIL.

I could not write the requested report file because the runtime stopped further tool calls at the iteration limit. The repository remained read-only and unmodified. The findings below are the audit result that would have gone into the report.

Verdict

The frozen candidate is not fit to close G3c, even behind a feature gate.

The durable server path passes its 486-test Python gate and the principal crash-recovery scenarios work. However:

1. Creation binds the durable request index before reserving capacity, contrary to the authoritative ordering and zero-effect capacity-refusal contract.
2. The mobile client does not use the new durable creation API at all.
3. The server can emit a receipt with null values in fields the schema requires to be strings.
4. The subprocess matrix does not directly prove every assertion made about request-index cardinality and reservation release.

Claim findings

C1 — PARTIAL / literally REFUTED

Confirmed:
- The request index uses one atomic insert and compares an existing payload at `tui_gateway/companion_creation.py:807-845`.
- Duplicate handling replays when insertion loses at `tui_gateway/companion_session_create.py:337-353`.
- The process test observed one create entry, one agent build and one row at `tests/tui_gateway/test_companion_creation_process_matrix.py:136-199`.

Refuted:
- The implementation binds the index at `tui_gateway/companion_session_create.py:337-351` and only then attempts capacity reservation at `:354-360`.
- Therefore the losing duplicate does not “release its reservation”; it normally never acquired one.
- The matrix does not count the exact request-index rows or prove losing-lease release.

Falsification attempted: inspected operation ordering and the real two-process test. A concrete sequencing defect was observed.

C2 — CONFIRMED

- Existing request payloads are compared with `hmac.compare_digest`; mismatch raises 4090 at `tui_gateway/companion_creation.py:830-843`.
- The real process scenario verifies 4090 and unchanged session/dispatch counts at `tests/tui_gateway/test_companion_creation_process_matrix.py:309-352`.

Falsification attempted: looked for a replay path that adopted the conflicting payload or dispatched before comparison. None observed.

C3 — CONFIRMED

- Dead creators with absent evidence in `bound`/`preparing` are closed as `not_admitted` at `tui_gateway/companion_creation.py:531-547`.
- The real `create_entry` crash test verifies an absent row, stable non-null stored ID, no dispatch and same-operation replay at `tests/tui_gateway/test_companion_creation_process_matrix.py:353-410`.

Falsification attempted: looked for new ID allocation or dispatch during retry/reconcile. The test rejects both; no defect observed.

C4 — CONFIRMED

- A dead `claimed` turn in prepared/dispatching state is settled to `not_admitted` at `tui_gateway/companion_creation.py:560-574`.
- The real `submit_entry` crash test verifies `not_admitted`, null runtime and no agent build at `tests/tui_gateway/test_companion_creation_process_matrix.py:202-259`.

Falsification attempted: checked whether reconcile enters submit/build or resurrects the closed operation. No such behaviour was observed.

C5 — CONFIRMED

- Dead admitted/running execution settles to `interrupted_outcome_unknown` at `tui_gateway/companion_turns.py:1932-1961`.
- The `agent_build` crash scenario verifies that status, `row_state == "present"` and no fabricated completion at `tests/tui_gateway/test_companion_creation_process_matrix.py:262-304`.

Falsification attempted: looked for completion inferred from the legacy handler response or mere row presence. None observed.

C6 — CONFIRMED, with UX risk

- Reconciliation computes age from the original `bound_at`, not `phase_at`, at `tui_gateway/companion_creation.py:222-225`.
- Freshness is defined as live and total age no more than 60 seconds at `tui_gateway/companion_creation.py:464-478`.
- The design makes `recovery_required` non-terminal and prohibits age-based replay at `docs/plans/companion-mobile-evidence/p4-current-design-v2.md:339-345`.

Assessment: not a safety-contract violation because it never authorizes replay. It is a conservative UX risk: a healthy operation that advances after 60 seconds can still be presented as requiring recovery.

C7 — CONFIRMED

- The 600-second activity stale threshold is at `tui_gateway/server.py:144-146`.
- Historical `git grep` found the same constant and uses in `826ef4b72c^`, before the candidate commits. The candidate diff did not introduce or alter it.

Falsification attempted: compared the parent revision with frozen HEAD. No regression observed.

C8 — PARTIAL

Confirmed:
- Crash/event hooks are located only in the test fixture.
- With the two environment variables unset, `_record` returns and `_halt_if` never exits at `tests/tui_gateway/fixtures/companion_stdio_gateway.py:64-120`.
- Production code contains no environment-triggered test bypass.

Limitation:
- The fixture always installs test authentication and a synthetic persistence agent at `tests/tui_gateway/fixtures/companion_stdio_gateway.py:12-62`; that is appropriate for a test launcher but means it is not literal unmodified production transport.
- The matrix does not directly assert one coordinator key or the losing reservation’s release.
- In the duplicate scenario, one peer may return 4090/4091 and still satisfy the test at `tests/tui_gateway/test_companion_creation_process_matrix.py:181-199`.

Falsification attempted: inspected whether weakened assertions could permit a broken implementation. Some proof gaps were found.

C9 — PARTIAL

Reproduced:
- Command: `scripts/run_tests.sh` over the stated 11 creation/continuity/transport suites.
- Result: 486 passed, 0 failed, exit 0.

Not reproduced:
- `apps/companion` Vitest claim of 574 tests / 36 files.
- `npm run typecheck`.

C10 — CONFIRMED

- Repository grep found zero `companion.sessions.create` references under `apps/companion/src`.
- `createSession` still calls generic `session.create` at `apps/companion/src/gateway/companion-client.ts:598-614`.
- The store resolves or creates a canonical shared `Bot Chat` at `apps/companion/src/state/companion-store.ts:1245-1264`.
- Tests explicitly expect generic `session.create` at `apps/companion/src/gateway/companion-client.test.ts:202-216`, `:349-352`, and `:382-389`.

Falsification attempted: searched the entire mobile source tree for a hidden durable-creation caller. None was found.

Defects

1. High — durable index is committed before capacity reservation

What breaks:
- Capacity refusal creates and closes a durable creation operation instead of having zero creation business effects.
- This reverses design §3.2’s reserve-then-bind uniqueness proof.
- It also makes C1’s losing-reservation statement false.

Exact code:
- Binding: `tui_gateway/companion_session_create.py:337-351`
- Reservation: `tui_gateway/companion_session_create.py:354-360`
- Capacity refusal closes the already-created index: `:361-378`
- Existing test explicitly expects the resulting `not_admitted` receipt at `tests/tui_gateway/test_companion_session_create_rpc.py:456-467`.

Minimal fix:
- Acquire and track strict capacity before `_creation_request_index`.
- On identical/conflicting insert loss, explicitly roll back that invocation’s proposed lease before replay/error.
- Capacity refusal must return 4091 with no coordinator index, row, runtime or dispatch.
- Add process-level assertions for lease release and zero coordinator key after refusal.

Blast radius:
- `companion_session_create.py`, reservation rollback/accounting tests, duplicate process test, capacity-refusal tests.

Must fix before gate closes: yes.

2. High/product-blocking — mobile does not enter durable creation

What breaks:
- New conversations continue through title lookup plus generic `session.create`.
- None of the durable request ID, uncertain-send, reconciliation or immutable payload guarantees protect actual mobile first-send operations.

Exact code:
- `apps/companion/src/state/companion-store.ts:1245-1264`
- `apps/companion/src/gateway/companion-client.ts:598-614`

Minimal fix:
- Implement the client state machine described below.

Blast radius:
- Gateway types/parser/client, draft persistence, store, directory/new-conversation UI, composer state and tests.

Must fix before claiming end-to-end G3c delivery: yes. A strictly server-only hidden gate may exist, but it is not a usable Companion feature.

3. Medium — all-null receipt violates the exact receipt schema

What breaks:
- `backend_namespace`, `profile`, and `client_request_id` are required strings by `docs/plans/companion-mobile-evidence/p4-current-design-v2.md:78-113`.
- `_null_creation_receipt` returns them as null at `tui_gateway/companion_creation.py:386-398`.
- Malformed internal evidence reaches this fallback at `:412-427`, `:457-458`, and `:492-493`.
- Tests explicitly bless the invalid shape at `tests/tui_gateway/test_companion_creation_observation.py:721-795`.

Minimal fix:
- Preserve already validated public request identity where available and return `recovery_required` with `row_state="unavailable"`.
- If identity itself cannot be trusted, raise the fixed sanitized 5066 error instead of emitting a schema-invalid receipt.
- Update parser/privacy tests accordingly.

Blast radius:
- Receipt projector, reconcile/create wrappers and malformed-evidence tests.

Must fix before gate closes: yes, because exact runtime parsing is required and the current fallback contradicts §1.4.

Open items

O1 — NOT A DEFECT

Owner checks exist:
- Public entry: `tui_gateway/companion_session_create.py:631-636`
- Before workspace handoff: `:668-670`
- Immediately before index binding: `:332-337`
- Before phase transition/create: `:405-416`
- Before dispatch and submit: `:448-480`

The real defect is not missing authorization; it is binding before capacity reservation.

O2 — INTENTIONAL

Workspace is deliberately revalidated after preparation:
- Snapshot comparison: `tui_gateway/companion_session_create.py:398-404`
- Post-preparation guard and fresh resolution: `:448-454`

This follows `p4-current-design-v2.md:189-195`. Failure is settled durably rather than selecting another workspace.

O3 — SERVER-SAFE, CLIENT-INCOMPLETE

- `failed` is terminal under the design at `p4-current-design-v2.md:341-342`.
- Reusing the same creation request ID replays the existing binding via `tui_gateway/companion_session_create.py:641-651`; it does not redispatch.
- The next deliberate message must be a new ordinary continuation request, not a creation retry.

The current mobile client cannot distinguish this correctly because it has no creation receipt parser/state machine. This is part of the client-integration blocker.

O4 — REAL DEFECT

An all-null identity receipt is intentionally produced by `tui_gateway/companion_creation.py:386-398`, but it is not legal under §1.4. Privacy fail-closed behaviour does not justify returning a schema-invalid success object.

O5 — INTENTIONAL EXCEPTION PRESERVATION

The brief names a nonexistent path; the relevant file is `tui_gateway/companion_projects.py`.

- `project_context.__exit__` can raise `ValueError` at `tui_gateway/companion_projects.py:464-470`.
- With no existing exception it becomes sanitized 4404 at `:471-474`.
- With an existing exception it is suppressed so the original failure remains authoritative.

This can suppress secondary evidence that the project DB changed during cleanup, but cannot turn the operation into success or hide inconsistency behind a successful workspace result. Not a gate defect.

O6 — DISPLAY/REDACTION ARTEFACT

Byte-oriented `git show | grep -Fq` checks established:
- `owner_authorization: Any = None` exists.
- The literal starred spelling does not exist.
- The same was true in both creation modules.

The module source is syntactically valid; `***` was tool-output redaction.

Client integration required

Minimum correct integration, from `p4-current-design-v2.md:331-353` and `:398-403`:

1. Add exact TypeScript request and receipt types plus strict runtime parsing for `companion.sessions.create`.
2. Add `createCompanionSession` and request-only creation reconciliation methods.
3. Extend the existing draft store with an owner/backend-scoped local draft identity, local UUID, selected profile/project-null and revision.
4. Before first send, freeze the exact draft revision and scope, allocate one stable `client_request_id`, and persist/read-verify minimal retry metadata before network transmission.
5. Mark the request uncertain before sending; never generate a replacement ID because of timeout/disconnect.
6. Send the composite create request directly—do not run `resolveBotChat`, title lookup, generic `session.create`, resume or separate `prompt.submit`.
7. Interpret every receipt state:
   - preparing/claimed: pending, not “sent”
   - admitted/running: accepted
   - completed/failed/cancelled: creation consumed; transition to ordinary stored session
   - not_admitted: deliberate new draft only if row absent; ordinary continuation if present
   - interrupted_outcome_unknown: inspect history, never auto-resend
   - recovery_required/invalid: retain binding and reconcile
   - not_found: retain and reuse the same request ID
8. Replace the single continuation retry slot with per-request create/continue entries.
9. Partition retries by stable authenticated owner and backend.
10. Add Web Lock exclusion for the same draft; disable creation if atomic exclusion is unavailable.
11. Preserve later edits as newer revisions and clear/rekey only the exact submitted revision.
12. Add mobile tests proving uncertain first-send retry creates exactly one session.

What could not be verified

- Vitest 574/36 claim.
- TypeScript typecheck claim.
- Behaviour on a real Android device.
- True multiprocess behaviour under storage corruption, disk-full and PID-lookup-denied schedules beyond the included matrix.
- The full R5 requirement to crash at every failure-table row; the new matrix covers five selected scenarios, not every table row.
- The report file was not created because the tool-call limit was reached before the outside-repository write could be performed.

AUDIT_VERDICT: FAIL

session_id: 20260912_214545_3c5882
