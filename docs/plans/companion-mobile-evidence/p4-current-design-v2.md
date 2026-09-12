# P4 current design v2 — immutable G0 snapshot

Status: final design decision, not an implementation or test-pass report.
Scope: creation and first send for an ordinary Companion conversation; existing continuation thereafter.
Repository: /Users/atlasweber/hermes-companion
Branch inspected: feature/hermes-companion
HEAD inspected: 15bb315df34945a2097876053e49aae0c77a9b69
Basis: /tmp/p4-astra-current-audit.md and the current working-tree implementations named below. HEAD alone does not describe this dirty working tree.

This file is the frozen G0 handoff. Do not revise it in place during implementation; a changed decision requires a separately named successor and renewed G0 review. “Immutable” means a versioned, content-addressable design artifact, not a promise that /tmp survives reboot or a privileged user cannot change a file. Its SHA-256 is reported separately after creation.

Only this requested artifact was written. No repository edits, installs, formatting, tests, application execution, session creation, Git mutation, or live-provider calls were performed for this design. The output path existed as an empty file before this write. Python execution tools were blocked by the session's approval policy; ordinary read/search/Git inspection and shasum supplied the evidence instead.

## 0. Final architecture and safety contract

Use one owner-only composite RPC, `companion.sessions.create`, feeding the existing registered `session.create` logic and then the existing registered `prompt.submit` pipeline. Use the existing launch-profile `state_meta` request index, ordinary target-profile `sessions` row, existing v3 turn record/lineage slot, and existing active-session lease registry. There is no mobile session table, run table, prompt outbox, persistent plaintext retry queue, second runner, or direct call to an agent from the composite.

Choose a resumable, fail-closed saga across the launch-profile coordinator DB, target-profile session DB, and existing lease registry. Do NOT claim cross-DB atomicity. The ordinary row and first turn claim ARE prepared together in one target-DB transaction. Coordinator recovery may finish bookkeeping and terminalize an abandoned operation; it never resumes creation or replays the first prompt. This deliberately sacrifices automatic execution recovery in exchange for a small, auditable at-most-once implementation.

Exactly-once has a precise boundary: a successful first send invokes `prompt.submit` once; all deliveries of that same operation combined invoke it at most once. A crash immediately before invocation can leave zero invocations. It is impossible to promise unconditional exactly-once invocation across that crash gap without an execution acknowledgment protocol/runner that this task excludes. The durable result explicitly reports that gap; it never pretends that a timeout proves rejection. The same distinction applies to provider-side effects: no claim of exactly-once external tools is made.

Opening, editing, selecting a project in, or cancelling a new draft is client-only. Only a deliberate first Send can allocate a runtime, ordinary row, or turn. Once the first-send preparation transaction commits, an empty ordinary row can remain if execution fails; that is an attempted send, not an abandoned draft. Do not delete such a row to make the UI look successful.

## 1. Public wire contract — exact decisions

### 1.1 Capability

Retain current capability fields and method listing. Add exactly:

    "companion.sessions.create": {
      "version": 1,
      "receipt_version": 1,
      "reconcile_by_request": true,
      "explicit_null_project": true
    }

Advertise only with both registered handlers and the required schema/transaction seams available. Revalidate the live owner lease as current `companion.capabilities` does. Profile-specific unavailability remains a validation error. No UI fallback to generic create plus generic submit, Bot Chat creation, hidden creation, or another profile. An absent/unknown capability is “New conversation unavailable on this backend,” not a reason to guess the contract.

### 1.2 Creation request

Method: `companion.sessions.create`. `params` must be an object with exactly these six keys, all required:

    {
      "backend_namespace": string,
      "profile": string,
      "project_id": string | null,
      "text": string,
      "client_request_id": string
    }

Validation is strict, without coercion:

- `backend_namespace`: 1–4096 UTF-8 bytes, no control characters, no surrounding whitespace, equal to this gateway's exact namespace.
- `profile`: exact served profile identifier, matching `[a-z0-9][a-z0-9_-]{0,63}` (including literal `default`); no alias, display name, empty value or `All`. Validate against the live served allowlist and guarded profile directory. Never activate the profile globally.
- `project_id`: explicit JSON null OR a nonempty string of at most 512 UTF-8 bytes, no control characters or surrounding whitespace. For a string, query exact `projects.id`, verify the returned ID equals the input, and reject archived/noncanonical/virtual/discovered nodes. Slug lookup is not an identity lookup. `"null"`, `""`, synthetic Home IDs, missing, array and boolean are invalid.
- `text`: a string of 1–1,000,000 UTF-8 bytes with no unpaired surrogate. Apply the same `sanitize_user_prompt_text` used by `prompt.submit`; reject if sanitized text is empty after whitespace stripping or matches the pure typed-stop predicate. Do not call the effectful stop handler in preflight. Sanitized text must also meet the byte bound. Preserve leading/trailing content in what is submitted; stripping here tests emptiness, not a content rewrite. Other ordinary text, including slash-looking text, follows `prompt.submit` semantics, not a new slash dispatcher.
- `client_request_id`: canonical lowercase UUID v4, regex `[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`. Generate once with secure randomness before transmission. JSON-RPC envelope `id` is unrelated and may change between retries.
- Reject all extra keys, especially cwd, messages/history, title, source, hidden, parent ID, runtime/stored IDs, profile home, model/provider overrides, attachments, authorization, operation ID, claims, leases and executor tokens. There is no public reserved-key field.
- At the JSON parser boundary reject duplicate object members rather than accepting last-key-wins ambiguity; malformed UTF-8/JSON is a protocol error. Apply the duplicate-member check to the real stdio and WebSocket decode paths, not just dictionary unit tests.

Authorization is exclusively `current_transport().companion_owner_authorization` plus current live validation. A stored/runtime ID, matching digest, client owner hint, or receipt is never authority.

### 1.3 Creation reconciliation request

Extend the existing `companion.sessions.reconcile` handler with a discriminated creation variant. Its exact keys are:

    {
      "operation_kind": "create",
      "backend_namespace": string,
      "profile": string,
      "client_request_id": canonical UUID v4
    }

No stored ID, text or project is required or accepted. Preserve the current four-key continuation variant (`backend_namespace`, `profile`, `stored_session_id`, `client_request_id`) for compatibility. The sets are disjoint: partial combinations/extra keys are invalid. The creation variant looks up the stable authenticated owner/request key in the coordinator first, verifies operation kind and exact backend/profile, then uses the server-bound target. It does not perform title lookup, scan histories, create a row, create/resume a runtime, or call submit.

A duplicate valid creation request returns the same creation receipt projection, using the existing binding, with no execution. It must compare the full payload digest before projection. Reconciliation can advance recovery bookkeeping only as specified in section 4; it is not a send API.

### 1.4 Receipt schema

Creation and creation reconciliation return the SAME exact flat object; every field is required, with nulls rather than shape drift:

    {
      "version": 1,
      "operation_kind": "create",
      "backend_namespace": string,
      "profile": string,
      "client_request_id": string,
      "project_id": string | null,
      "stored_session_id": string | null,
      "row_state": "absent" | "present" | "unavailable",
      "operation_status": status,
      "runtime_session_id": string | null
    }

`status` is exactly one of:

    not_found, preparing, claimed, admitted, running,
    completed, failed, cancelled, not_admitted,
    interrupted_outcome_unknown, recovery_required

Rules:

- A bound operation always exposes its immutable reserved `stored_session_id`, even before a row exists. Never infer row existence from an allocated key.
- `not_found` is allowed only when the coordinator lookup definitively has no v3/v4/legacy binding. Its stored ID and project ID are null, row_state is absent, runtime ID is null. It is a snapshot of absence, NOT proof that an older network request cannot arrive later. Client retains the same request ID.
- For other statuses, `project_id` is the original selection in the index, not a claim that a project can never be reorganized subsequently.
- `row_state=present` requires a verified ordinary row in the bound target DB. `absent` requires a successful exact read proving no row; `unavailable` covers unreadable/corrupt/replaced/mismatching storage and never authorizes execution.
- `admitted`, `running`, `completed`, `failed`, `cancelled`, `interrupted_outcome_unknown` come from the existing turn record, not from a legacy handler result. `claimed` requires the target row/claim preparation commit. `preparing` covers an active creator before that commit.
- `not_admitted` is terminal for this request. It can have an absent or present row. It never means the same request may be dispatched again.
- `recovery_required` means unknown liveness, inconsistent evidence, or unavailable authoritative storage. It is not success or rejection. A later read may resolve it without replay.
- A runtime ID is returned only if, under the resume/runtime ownership lock, its stored key belongs to the bound current lineage, its exact profile matches, its active lease belongs to that runtime, and the current authorized transport may attach. Otherwise return null. A bare `_sessions` membership test is insufficient. A runtime in another process is not fabricated as a locally usable handle.
- No `reconciled` flag, message count, digest, operation ID, token, timestamp, root/tip IDs, raw status aliases, history, cwd, title, `info`, or legacy result. Existing history/continuation already accept the original ordinary stored key and resolve its lineage. Do not spread any internal dictionary into this object.

Strictly parse these responses in TypeScript at runtime. Reject unknown keys, contradictory field combinations, wrong version/kind/scope/request identity and invalid IDs. A malformed receipt produces uncertainty and preserves retry state; it never causes a fallback send.

### 1.5 Error boundary

Before a binding can have committed: return sanitized JSON-RPC errors, using `-32602` (shape/text), `4403` (owner/served-scope denial), `4404` (backend/project unavailable), `4121` (unsupported compute/terminal mode), `4091` (capacity/exclusive reservation refusal), `5072` (storage preflight unavailable), or `4090` (immutable request conflict). Messages are fixed public strings without paths or raw exceptions. Existing wrapper codes for continuation remain compatible.

Once an index write is attempted, an ambiguous error is NOT a definitive prebinding rejection. Read back the exact key. If found, use a receipt; if its existence cannot be proved either way, return fixed `5066`, “Creation outcome unknown; reconcile this request.” The client treats transport errors and 5066 as uncertain. Once binding is proven, ordinary failures return a receipt with the durable state; do not throw an apparently zero-effect validation error after a row/admission exists. Revoked authority still denies the response without leaking a receipt; the server privately settles any unstarted work when it can.

## 2. Durable binding and privacy-minimal coordinator schema

C = the existing launch-profile DB returned by `_continuity_ledger`; T = the guarded target-profile `state.db`. The deployment must use one canonical C per backend namespace. Multiple gateway processes for that namespace must resolve the same C and the same target homes. A namespace with differently configured coordinator homes is unsupported and must not advertise creation. Independent backends are not a distributed deduplication domain; the client must never replay an unresolved operation on another backend.

Reuse `_continuity_v3_key(owner, client_request_id)` unchanged. It hashes the JSON owner/request tuple; neither profile nor operation kind belongs in this key. Do not introduce a parallel “creation index” namespace that would allow create/continue request reuse.

Creation index value, exact allowlist (v4 on the existing key):

    v: 4
    operation_kind: "create"
    payload_sha256: lowercase SHA-256 hex
    operation_id: existing new_operation_id() value
    backend_namespace: exact namespace
    target_profile: exact profile
    requested_id: server-reserved ordinary session key
    project_id: exact selected ID or null
    creator_pid: positive integer
    creator_started: process start identity, nonzero
    creator_token: server-generated process token
    creator_epoch: 1
    phase: "bound" | "preparing" | "prepared" | "dispatching" | "closed"
    bound_at: UTC timestamp
    phase_at: UTC timestamp
    closed_outcome: null | "not_admitted" | "turn_record"

No other index fields. In particular no runtime dictionary, prompt, execution cwd, filesystem paths, project name, transcript, errors, response blob, bearer credentials or legacy result. Creator identity fields are internal coordination data and are never receipts. Raw owner/request strings are absent from the value. The original ordinary key is never changed to a compression tip.

`payload_sha256 = SHA256(UTF8(json.dumps(["p4.create.v1", backend, profile, project_id, original_text, sanitized_text], ensure_ascii=False, separators=(",", ":"))))`.

Both original and sanitized text are hashed, not stored. This makes any changed raw text conflict, including two strings that sanitize identically, while binding the actual execution interpretation. Null differs from every string. No normalization of ID spelling or Unicode is performed. Sanitizer behavior is part of protocol version 1; a future incompatible sanitizer requires an explicit versioned protocol decision, not reinterpretation of existing bindings.

Inside one C `BEGIN IMMEDIATE` callback:

1. Read BOTH the legacy key and shared v3 key.
2. If legacy exists, fail closed as legacy unknown; no migration into a new creation operation.
3. If an existing v3 index has no `operation_kind`, treat it as `continue`. New continuation indices explicitly record `operation_kind="continue"`. Creation encountering either conflicts with 4090. Continuation encountering a creation index conflicts with 4090 BEFORE legacy v3 result processing. Keep existing v3 continuation digests for compatibility.
4. For existing creation, compare version, kind, exact routing, project/null and constant-time digest. Identical means read/reconcile only, never owner adoption for execution. Different means conflict.
5. Only absence permits insertion of the server-generated stored key, operation ID and creator identity. Return a separate `inserted_here` boolean from the transaction. Only the invocation that inserted may progress the first-send saga.

The callback contains SQL and comparisons only. Generate keys, clock snapshots and executor identity outside it. No runtime allocation, lease operations, transport output, timers or provider work inside `_execute_write` retry callbacks.

Retain indices/tombstones for the lifetime of the coordinator, including deleted/archived sessions. No TTL pruning and no “retry receipt cleanup” on the server. A missing target row after a previously prepared operation is a recovery problem, not permission to recreate it. Administrative database rollback/loss is outside exactly-once guarantees: do not resume an old namespace after partial restore while old executors can exist; quiesce them and restore C/T/registry consistently or rotate backend identity. This is a deployment constraint, not a hidden retry heuristic.

## 3. Admission ordering, reservation and trusted create seam

The order below is mandatory. “Validation,” “capacity reservation,” “binding,” “ordinary-row preparation,” and “turn admission” are separate boundaries.

### 3.1 Pure validation and duplicate fast path

1. Parse strict request; sanitize with a pure helper; validate the live owner and backend/profile authority.
2. Open C for a no-create read; check the shared request key. A matching existing binding follows receipt/recovery, without rerunning mutable project validation or reserving capacity. An old request remains reconcilable if its project was later archived. Changed payload/kind conflicts here and again at the insert race.
3. For a truly new request, guarded no-create read opens validate C/T schema, ordinary row/turn primitives, project DB and profile configuration. Missing, corrupt, symlink-swapped, read-only or unsupported schema fails before mutation. Do not use opening helpers that create/migrate stores in this phase. Actual future write/disk-full races cannot be predicted by a read; those become post-reservation/binding outcomes.
4. Resolve the exact project or null workspace as section 5. Probe accessibility without creating files. Validate local execution only: target profile terminal backend must resolve to local, and compute-host turn isolation must be disabled. No implicit fallback from unsupported remote/isolation settings. No provider prewarm or credential probe. Read target profile's existing model/memory configuration; do not change it.
5. Revalidate owner immediately before reservation. No pure-validation failure may create a runtime, session/index/turn row, lease, terminal override, prompt history, timer, thread, project/config mutation, or gateway prompt enablement. Safe read caches are not runtime publication.

### 3.2 Reserve real capacity before binding

6. Generate proposed stored key and proposed runtime ID with the existing server ID generators, without allocating a runtime. Reserve one active-session slot for that key/runtime in the TARGET profile registry, using the target profile's config. Extend `_claim_active_session_slot` with internal config/strict-reservation arguments; use `try_acquire_active_session(..., surface="companion", track_liveness=True)`.
7. Add an optional internal `persist_prune_on_refusal=False` argument to the existing lease acquisition primitive; default True preserves generic callers. P4 refusal does not rewrite/prune registry entries. Successful reservation is performed under the existing file lock and strict PID/start-time liveness rules. No cap check-then-act race and no disabled/no-op lease is accepted. Capacity policy may be unlimited, but per-key exclusive ownership remains mandatory.
8. Record the live provisional lease object in the server's existing lifecycle ownership accounting before releasing the acquisition critical section to an orphan sweep. Extend `_own_live_lease_ids` to include a small in-memory set of in-flight creation reservations. This is not a second durable registry. Under a shared lifecycle reservation lock, acquisition, tracking, transfer to the runtime, and orphan-sweep snapshots cannot race. Do not hold `_sessions_lock` during registry I/O.
9. Attempt the C binding transaction. Revalidate owner just before it. Identical-request losers release their own proposed reservation and return the winner's receipt. Conflicting losers also release. If no index exists after a proven rollback, release and return a prebinding storage error. If commit is ambiguous, release the provisional lease only after ensuring this invocation will not proceed, then reconcile its exact owner/request key; never mint another key in that invocation.

A rejected capacity reservation has zero creation business effects and no lease. A successful reservation is an intentional reversible side effect before binding; it is NOT labelled pure validation. If the process crashes here, the registry can temporarily contain the unused key, but there is no session or index and no runtime. Strict dead-process cleanup removes it. That unused key is not a created conversation, so a later request may bind a different unused key without duplicating a session. No timeout eviction of a live/unknown reservation.

Release rollback is explicit: bounded three attempts using the existing release helper. If release fails, keep its tracked reference, block local reuse, and report coordination unavailable/uncertain as appropriate. A subsequent lifecycle sweep may retry exact lease release; process-death pruning is the final safety net. Do not silently drop a failed release and claim no outstanding reservation. Pure-validation tests and injected release-failure tests assert different outcomes.

### 3.3 Bound creation and ordinary-row preparation

10. Only `inserted_here=True` may CAS C `bound -> preparing`, with the original creator identity/epoch and matching immutable fields. That CAS authorizes at most one call to trusted creation. A failed or ambiguously committed phase transition is resolved by a fresh read; a handler whose control flow lost certainty stops instead of retrying runtime creation.
11. Revalidate workspace snapshots/owner/config at this point. A change after binding is a durable `not_admitted` outcome, not a request validation error. Never pick another project path. Transfer the reservation into the trusted create context below.
12. Invoke the existing registered `session.create` handler with public-shaped server-chosen ordinary defaults and a PRIVATE context value. Create the ordinary runtime, without agent prewarming. The runtime is provisional and not exposed to other prompt submissions/resumes until row+claim preparation; `_sess_nowait`/resume must reject a runtime carrying an unprepared creation marker except for its matching bound internal context. Disconnect orphan/cap sweeps must treat its in-flight creation reservation as active.
13. In one T transaction, insert the ordinary row and first claim/lineage slot (section 4). Read the actual committed row and claim, not `_ensure_session_db_row`'s best-effort boolean. Verify exact profile/key/workspace/source and empty initial history. The row may now be listed/read normally, but retain the runtime's creation/build fence until its matching first turn is admitted or terminally not_admitted. An ordinary resume of a claimed creation may view history but must not prewarm, create a competing eager runtime, or submit. Test the cross-process resume case against the durable claimed slot, not only an in-memory marker.
14. CAS C `preparing -> prepared`. This is a cache of durable preparation progress, not the authority for turn state; recovery can observe a committed T preparation while C still says preparing.
15. Revalidate owner and workspace immediately before dispatch. CAS C `prepared -> dispatching` with the original creator identity/epoch. This is the no-reentry gate. Bind the existing TurnClaim using `bind_turn`, attach the existing reservation to `active_session_lease`, and invoke registered `prompt.submit` with exactly `{"session_id": runtime_id, "text": sanitized_text}` once. Always reset the ContextVar. No generic submit with no claim and no `_run_prompt_submit`/agent call from this service.
16. Existing prompt admission adopts the claim, verifies the strict prepared row, uses the already-held capacity slot, admits the ordinary turn, persists/verifies its ordinary row, builds the agent, and starts its ordinary turn thread. Row-proof failure is loud for this context. No queue/busy replay: a busy bound first turn is a durable unstarted failure.
17. Read the turn record and project a receipt even if the legacy return is error/None or the turn already completed. Mark C closed/turn_record once dispatch has returned or recovery has authoritative turn evidence. Thread lifecycle continues to own running/terminal states. A crash before this final C write changes no execution decision.

### 3.4 Private seam inside `session.create`

Add a frozen `ReservedSessionCreate` dataclass and ContextVar in `methods_session.py`, with internal bind/reset helpers, consumed once by the registered create handler. Fields: reserved stored key, proposed runtime ID, target profile/home reference, execution cwd, workspace-none boolean, already-acquired lease object, operation ID, creator epoch/token. This object is not serializable from RPC params. Binding is internal only, scoped to one synchronous handler invocation, cleared in `finally`, and copied only through trusted server context propagation.

The trusted branch uses the existing record-construction logic instead of a second factory: server IDs replace `_new_session_key`/runtime generation for this call; source is companion, hidden/room_plumbing/follow_profile_config false, no parent/history/title/model override, close_on_disconnect false. The selected profile remains explicit. `cwd` is the validated server execution cwd, not a client string. The lease is transferred, never reacquired. Preserve all ordinary runtime fields, locks, profile routing and transport attachment.

For this context only, defer `_enable_gateway_prompts` until preparation is safe; register per-session terminal cwd only after binding/reservation and successful runtime allocation. Skip `_schedule_agent_build`, `_schedule_session_cap_enforcement`, branch seeding, and the generic response's `git_probe`/project-info/history expansion. The internal success result need only identify the runtime and stored key; it is consumed privately. Generic callers retain their exact old lazy row, IDs, response and prewarm behavior. Reject attempted public private-context parameter spellings instead of interpreting them.

Prewarm remains suppressed permanently for this creation call; ordinary `prompt.submit` at its existing build point is the first build trigger. On pre-admission failure, remove only this provisional runtime through existing teardown, clear its terminal override, release its lease, and durably close the operation. Never call generic close in a way that finalizes another runtime's row or destroys accepted work.

## 4. Cross-DB saga and crash recovery

### 4.1 One atomic target preparation transaction

Refactor `SessionSessionsMixin._insert_session_row` into a normalized private transaction-taking primitive `_insert_session_row_tx(conn, ...)` plus the current `_execute_write` wrapper. Preserve existing field defaults/upsert/system-prompt/profile inheritance semantics. The new primitive does not begin/commit/nest a transaction.

Similarly extract `claim_turn`'s SQL callback as `_claim_turn_tx(conn, ..., executor=...)`; `claim_turn` remains its existing wrapper for continuation. Add `prepare_created_session(db, row_fields, operation_id, payload_sha256, executor)` in `companion_turns.py`:

- Execute exactly one T `_execute_write` callback.
- Verify no preexisting unrelated row/claim uses the reserved key/operation. A same-operation committed pair can be READ for ambiguous-commit proof, but never creates a runtime or dispatches again. A row-only or claim-only mismatch is corruption and fails closed, not adoptable content.
- Call `_insert_session_row_tx` for the ordinary visible root row: id=reserved key, source=companion, exact profile_name, no parent/title/hidden/messages, canonical `_workdir_row_model_config` under selected profile, and persisted workspace per section 5.
- Call `_claim_turn_tx` against this now-existing row. Initial root=tip=reserved key, generation=1, ordinary v3 state=claimed and ordinary lineage slot. Do not admit yet.
- Verify those row fields and claim/slot identity inside the transaction, then commit. Every SQL retry is pure and uses stable IDs/executor snapshots.

A failed transaction leaves neither row nor claim. No separate row-then-claim crash gap remains. If C and T happen to be the same file, still use this same sequential saga; never nest C and T writes or claim a larger transaction than actually exists.

Strengthen existing v3 transitions to compare operation, generation, payload, root/tip, and executor token/PID/start identity against both record and slot. `mark_running` for a creation-origin claim must transition from admitted only; the current claimed->running allowance is not usable as a creation admission bypass. Make this a claim/turn-record invariant using a creation-origin flag in the existing turn record (`operation_kind="create"`), not a new runner. Generic claim semantics remain compatible. Recovery cannot manufacture a new executable claim.

### 4.2 Creator lease and bounded takeover

The creator identity in C is a non-expiring ownership lease, not a wall-clock lease granting execution after expiration. Its original execution epoch is always 1 and is never reassigned. PID alone is insufficient; use PID plus high-resolution process start identity and process token. Require usable start identity before reservation. Fix false-dead treatment: if the PID exists but start-time lookup fails or identity is unparseable, return unknown, not dead. Same-host single-backend processes are the supported topology; cross-host/network-filesystem executors are unsupported. A validated host reboot makes previous-host process identities dead; uncertainty is not permission to assume it.

Takeover is FINALIZATION-ONLY. A live creator is not taken over. An unknown creator is not taken over. A positively dead creator permits any authorized reconciler to inspect T and CAS monotonically toward closed. The reconciler never becomes an execution owner, creates a runtime/row, obtains an execution lease or dispatches a prompt. Competing finalizers are harmless because target settlement and C terminal CAS are idempotent and checked against the immutable index snapshot. No cleanup worker with prompt access is introduced.

Each reconcile RPC performs at most one creator liveness probe, one target observation/settlement pass, and one coordinator close CAS (each SQL callback may use existing bounded storage-busy retries). It returns rather than polling. Alive creators with no progress for 60 seconds are displayed as `recovery_required`, without changing executor authority; unknown liveness immediately gives recovery_required. The age is presentation-only. Repeated reads can later resolve proven death. No infinite hidden pending loop, automatic process kill, timer takeover, or human “force resend” button exists.

Index-only recovery: if C is bound/preparing, no target row/turn exists, and creator is positively dead, CAS C to closed/not_admitted. This requires no stored ID from the client and no target row just to create a turn tombstone. If the target DB is unavailable, return recovery_required with row_state unavailable, not not_admitted. A closed index forever blocks delayed identical create handlers from executing. Provisional registry entries are reclaimed by strict dead-process lease cleanup, not by a request timeout.

Prepared recovery: inspect the ordinary row+claim pair in T. With dead creator and claimed turn, use the existing settlement primitive to record not_admitted and release the lineage slot. Then close C/turn_record. A crash between those writes resumes by reading the already-terminal turn. A missing pair where C says prepared/dispatching is a consistency failure, never permission to recreate.

Dispatched recovery: T admitted/running is authoritative even if C still says prepared due an impossible-looking external mutation; treat contradiction as recovery_required rather than execute. With a consistent dispatching/closed index and a positively dead turn executor, use existing `reconcile_dead_executor`: admitted/running -> interrupted_outcome_unknown; claimed -> not_admitted. If the executor remains live or unknown, do not settle merely because the creator phase is old. Existing run threads cannot outlive a dead owning process in this supported non-isolated topology.

A process-local exception after binding must stop its handler's forward progress before settlement. A completion `finally` terminalizes unstarted work if durable evidence permits. If the process remains alive but evidence/write access is unavailable, recovery_required is honest until repair or process death. Supervised action is limited to repairing storage or quiescing the confirmed old process and then reconciling; it does not authorize replay of an admitted/unknown operation.

### 4.3 Failure-state table (all durable gaps)

| Crash/failure boundary | Durable evidence | Recovery/result | Duplicate prevention |
|---|---|---|---|
| Draft or pure preflight | Nothing | Local draft / fixed validation error | No create, build, row, lease, index or submit |
| Reservation refused | Nothing new | 4091, same draft retained | Locked capacity decision; no binding |
| Reservation acquired, before C bind | Existing registry entry only | Dead-process cleanup; request lookup not_found | No runtime is permitted before C; unused key is not a session |
| C binding commit ambiguous | C may exist; registry may exist | Exact-key read; otherwise 5066/uncertain | Do not proceed or generate another binding on uncertainty |
| C bound, before preparing | Index only | Live=preparing; dead=closed/not_admitted | Only original inserter can CAS preparing; no execution takeover |
| C preparing, before/during trusted create | Index plus possible provisional runtime/registry entry | Dead with no T pair=not_admitted; live/unknown=preparing/recovery_required | Preparing is not permission for another handler to call create |
| Runtime allocated, before T preparation | Same index; no durable ordinary row yet | Private teardown if handler fails; death finalizes index | No recovery runtime creation; no prewarm/submit yet |
| T preparation transaction interrupted | Either neither row/claim, or the complete pair | Exact read distinguishes; unreadable=required | Same-DB transaction, stable IDs, no runtime work in retry |
| T pair committed, C still preparing | Ordinary row+claimed slot, stale C phase | Dead: settle not_admitted then close; live: original handler progresses | Recovery reads pair but cannot dispatch |
| C prepared, before dispatch gate | Pair claimed | Dead: not_admitted; live: original handler only | CAS tied to original epoch/token |
| C dispatching, before entering submit | Pair still claimed | Dead: not_admitted; zero invocation allowed | Do not “complete” the call by reentering submit |
| Inside submit before admit | Pair claimed; possible in-flight runtime text | Proven unstarted error/death: not_admitted | Pipeline cannot build/run before durable admission |
| Admit commit ambiguous | Claimed or admitted | Stop local forward progress; exact read; failure/unknown as supported | Never retry pipeline entry, never relabel admitted as safe rejection |
| Admitted, before build/thread | T admitted | Controlled failure=failed; death=interrupted_outcome_unknown | Admission consumes operation permanently |
| Build/thread started, before running write | T admitted | Existing hooks settle; death=interrupted_outcome_unknown | No alternative worker; first-turn mark_running requires admitted |
| Running or tool side effects, before settlement | T running | Existing terminal hooks; death=interrupted_outcome_unknown | No timeout replay |
| T terminal, before C close | Terminal T, stale C | Reconciler closes C/turn_record | Terminal turn wins; no legacy status inference |
| C close, before response/client save | Index and T retained | Reconcile using owner/request/backend/profile | Client need not know stored ID |
| Lease rollback/cleanup write fails | Exact outstanding registry ownership | Fail closed, bounded retries, later lifecycle cleanup | Do not publish another runtime or pretend release succeeded |
| T deleted/replaced after preparation | Retained index, missing/inconsistent target | recovery_required, never recreate | Tombstone lifetime exceeds session lifetime |

### 4.4 Safety proof

Uniqueness: C's single owner/request key serializes all operation kinds across served profiles. Only its inserter can execute, and only with its immutable proposed stored key. Competing delivery processes release their unused reservations; they do not enter creation. A crashed inserter is never replaced by an execution owner. Therefore the creation operation can allocate at most one runtime through `session.create` and create at most one ordinary root row.

Atomic preparation: T inserts the ordinary row and first lineage claim/slot in one transaction. There is no legal row-only preparation to repair by guessing. Existing slot/generation admission protects against concurrent ordinary continuation. Preserve legacy-submit fences: a generic `prompt.submit` with no matching bound claim must refuse while the existing active lineage slot belongs to this creation, even on another local runtime. Check this before in-flight mutation/build.

Execution: C dispatching is a one-way, original-owner gate and never a retry instruction. Only that control-flow branch enters `prompt.submit`; its T claimed->admitted CAS consumes the first turn, and ordinary turn code alone runs it. Recovery only observes/settles. A stale resumed process cannot exist after positive process death; live/unknown processes are never taken over. Thus no C/T/registry crash gap can produce a second creation/send for the same request. A different deliberately submitted continuation is a new operation and must use the existing lineage fences.

Liveness: recovery of index-only death and partial settlement needs no plaintext or client-known stored key. Unknown liveness/storage is surfaced in a bounded RPC as recovery_required rather than falsely resolved. This design guarantees safe convergence when authoritative storage and death evidence are available, not forced progress under arbitrary storage loss or an unkillable live handler.

## 5. Exact project and explicit null semantics

### 5.1 Existing project

Resolve in the selected profile, through `_resolve_profile`/`_SourceGuard` read-only paths. Read canonical projects and folders without refresh/discovery writes. Use an exact `WHERE id = ?` read (or verify `get_project` returned that exact id); reject archived and synthetic/discovered IDs. Require a nonempty existing local primary_path which is also that project's unique primary folder. Canonicalize to an absolute real path on the server; require no symlink components in the selected path for v1, with readable/searchable directory access. Missing, replaced or inaccessible paths do not fall back to another folder.

Use the canonical Desktop `_FolderIndex` and `_project_for_session` on a hypothetical ordinary row with that cwd and the read-only probed common repo root. Reject equal-depth ties shared by different projects; do not rely on scan order. Require both current cwd-only placement and placement with probed repo root to resolve to the selected ID, including nested/overlapping folders. Reject a mismatch/ambiguity before reservation. Persist that canonical cwd; selected runtime has `explicit_cwd=True`. No new session-project foreign key or separate relation table.

Hold the guarded project DB read snapshot during preparation and revalidate its identity/content and the directory device/inode chain before runtime construction and before dispatch. If the project/folder/path changed, fail durably after binding. Do not perform a silent target substitution. A read-only DB snapshot and inode checks are not an OS filesystem sandbox: a privileged external actor can still mutate paths after the final check. The contract is correct admission against the validated project snapshot, not immutability against arbitrary future admin/agent filesystem changes. Such later changes are ordinary project lifecycle, never justification to rerun creation.

### 5.2 Explicit null (“Bez projektu”)

Null means NO persisted workspace identity; it does not mean the process has no execution directory.

For creation, choose execution cwd server-side using the existing fallback order under the target profile: target profile configured cwd, launch configured cwd, launch TERMINAL_CWD, process cwd. Canonicalize/validate the selected existing local directory using the same guarded directory policy; skip no invalid configured path silently at first-send validation. It is a fallback execution context, not a selected project. No client cwd is accepted and no process environment/global active workspace is changed.

Persist source=companion, cwd=NULL, git_repo_root=NULL and git_branch=NULL. Store exactly one durable policy marker in the ordinary row's existing model_config: `_companion_workspace_none: true`. This is a workspace-intent bit, not a project relation or session/run model. Do not persist the execution fallback path in that marker or the index. Runtime has `workspace_none=True`, `explicit_cwd=False` and the actual server-only execution cwd. `_context_cwd_is_launch_artifact` returns true for this policy, so agent context does not misrepresent fallback cwd as a chosen workspace.

The policy must survive ALL ordinary lifecycle paths, not only first insertion:

- `_persisted_session_cwd` returns null while the marker is active, regardless of implicit fallback.
- `_Resume.record`, deferred/eager resume and agent construction restore workspace-none from the ordinary row before any build/cwd metadata update. Eager resume's direct launch-artifact expression must use this same policy, not only source='desktop'. A null-workspace resumed runtime resolves the current target-profile fallback server-side; no historical fallback path is recovered from a receipt.
- `_reconcile_session_cwd_from_terminal`, automatic cwd healing, `_persist_session_cwd_and_schedule_git_meta`, and `_persist_session_git_meta` do not turn this fallback into persisted cwd/git membership.
- At the storage boundary, `_insert_session_row_tx`, `update_session_cwd` and `publish_session_git_metadata` honor the marker in their transaction. Ordinary agent upserts must not fill null cwd/git fields from fallback. Delayed git publication must fail its generation/policy condition. Null-policy rows remain null even if a generic agent path supplies a cwd.
- Preserve the marker in model-config merges. In `_inherit_parent_session_metadata`, copy it for compression descendants of the same ordinary conversation before deciding cwd/git inheritance, and clear inherited cwd/git when set. Do not lose it when the compression child receives model_config later.
- An explicit existing Desktop workspace-selection action may leave no-project intentionally: `_set_session_cwd` clears the marker in the SAME ordinary DB transaction that sets the explicitly chosen cwd and advances git generation, then updates the runtime policy. Automatic terminal cd/settle is never that explicit action. Generic callers without the marker retain their existing semantics.

Desktop tree needs no second relation algorithm. With null cwd AND null git root, current `_project_for_session` gives no owner and `_auto_buckets` places the ordinary row in Home/no-project. Verify via real `list_sessions_rich` -> `_project_tree_row` -> `build_tree`, including live overlays and compression descendants. Do not lie with source='desktop', a synthetic project ID, or a client-only grouping override.

## 6. Privacy boundaries

The creation index allowlist is section 2. The existing turn record retains only its current operation/digest/lineage/executor/generation/status/timestamps/runtime-ID/final-tip fields plus operation_kind; no prompt/cwd/legacy result is added. The active-session registry retains its ordinary lease metadata; do not add text or paths there. The public receipt allowlist is section 1.4.

The ordinary sessions/messages/model configuration remain the canonical places for intentional user content and execution history. Prohibiting plaintext in the INDEX/RECEIPT/RETRY does not prohibit the ordinary prompt pipeline from persisting a user message to its ordinary transcript. There is no duplicate prompt copy in coordination storage. Project cwd may exist in an ordinary selected-project session row, never the coordinator receipt or local retry. No-project fallback cwd is not persisted as workspace identity.

Local retry allowlist, per operation:

    version: 2
    operationKind: "create"
    ownerScope: non-secret stable local account partition identifier
    backendNamespace: string
    profile: string
    projectId: string | null
    draftId: local UUID
    draftRevision: nonnegative integer
    clientRequestId: canonical UUID v4
    messageSha256: lowercase SHA-256 of captured raw UTF-8 text
    storedSessionId: string | null
    operationStatus: "untransmitted" | "uncertain" | receipt status

No runtime handle, bearer token, source URL, cwd/path, plaintext prompt, history, title, result object, exception string, or receipt spread. The local draft store separately holds intentional plaintext draft content. It is explicitly not a reliable execution queue and is never scanned to auto-submit after restart. Digests reveal equality; do not log them or show them unnecessarily.

Errors/logging/events for the new coordinator contain only fixed codes and minimal identifiers where operationally necessary. Do not log request params or inner create/submit payloads/results. Privacy tests scan C state_meta, creation-related T state_meta, serialized retry, new receipts and captured logs with synthetic prompt/path/legacy-result canaries. Ordinary transcript/cwd fields are tested as explicit exceptions, not accidentally included in the scan.

## 7. Client state machine and reconnect

Extend `state/session-drafts.ts`, not a second features/conversation draft store. Add an owner-scoped `sessionKind='local'` identity with local draft UUID. The local draft carries selected profile/project-null and revision separately from text. Draft open/edit/select/cancel never calls selectTeammate, resolveBotChat, create, resume, prompt, or project mutation. Read-only directory/capability loads are allowed. “All” requires explicit agent selection before Send.

States and decisions:

1. LOCAL_DRAFT: text exists only in the intentional draft store. No runtime/stored identity. Missing capability/owner/agent/project selection blocks Send locally.
2. PREPARING_LOCAL_SEND: synchronously freeze owner/backend/profile/project/draft ID/revision/text and allocate the stable request UUID. Block double-tap for that logical revision. Hash captured raw text, then write/read-verify the minimal retry entry BEFORE any request. Check owner/connection generation, active draft identity/revision and frozen scope after every await and immediately before the network call. If changed, do not transmit; keep newer draft untouched. Never obtain a new request ID solely because a response took too long.
3. TRANSMITTED_UNCERTAIN: mark local metadata uncertain before making the call. A crash at this point may have sent nothing, but reconnect starts with reconciliation. Disable resubmission of this logical operation. Editing creates a newer local revision, not a mutation of the sent payload.
4. PREPARING/CLAIMED/ADMITTED/RUNNING receipt: persist minimal returned identity/status. Show precise pending/accepted activity; fetch safe ordinary history once row_state is present. Do not promise “sent” for preparing or claimed. Lost early events are repaired via existing history/reconcile, not a second send.
5. TERMINAL completed/failed/cancelled: first creation is consumed. Transition to the ordinary stored-session target when row exists; clear only the old submitted revision's text if its identity AND revision AND digest still match. Preserve newer text in its own draft; rekey to stored identity only if it does not overwrite another stored draft. Next Send uses `openPersistedSession`/existing `companion.sessions.continue` with a NEW continuation request ID.
6. NOT_ADMITTED with row present: open that SAME ordinary stored session. Offer deliberate Send through existing continuation, not another creation request. With row absent: mark the old request terminal and offer a deliberate new draft-send attempt with a new request ID, only after this definitive receipt. Never do either automatically.
7. INTERRUPTED_OUTCOME_UNKNOWN: preserve the binding, load history if available, show “Outcome unknown; inspect conversation before sending again.” No automatic resend/clone/new-ID recovery. A deliberate subsequent ordinary continuation is new work, with an uncertainty warning; it is not represented as replay of the old request.
8. RECOVERY_REQUIRED or invalid/unavailable response: retain binding and show uncertainty. Reconcile on owner reconnect or explicit refresh with bounded backoff; do not interpret age as safe retry. No clear-receipt-and-resend control.
9. NOT_FOUND: keep the SAME request ID. If the owner explicitly retries and the exact original text remains available with matching digest and scope, retransmit the identical composite. Otherwise remain local unresolved and request restoration of the original draft or further reconciliation. Do not generate a fresh ID merely because a reconcile read saw absence; the old request may still arrive.

Owner reconnect must yield the same authenticated server owner identity, not merely the same profile/display name. Local entries are partitioned by backend AND stable owner account scope. Switching owner/backend hides prior scoped drafts/retries and cancels their active callbacks; it never transmits them in the new scope. A fresh lease for the same owner can reconcile by request without stored ID. Signout clears memory/visible text; do not delete unresolved durable metadata as a convenience. Legacy retry records lacking owner scope are quarantined, not automatically replayed.

Replace the single overwritable continuation retry slot with per-request namespaced entries (same abstraction, discriminated create/continue variants). Limit to 100 entries and 16,384 serialized bytes per entry; refuse NEW sends if unresolved entries cannot be stored, never evict an unresolved request. Do not put raw text in this structure. For same-draft inter-tab exclusion use the browser Web Locks API on owner/backend/draft ID plus read-verified storage; if unavailable, new creation is disabled rather than using a non-atomic localStorage lock. Multiple tabs using different draft IDs are deliberately distinct conversations. A retry of a shared logical draft reuses its persisted request ID. Existing continuation tests must ensure no old status branch clears indexed/unknown metadata.

Capture operation callbacks by request ID and immutable scope, not the active conversation pointer. A late response can update its own retry entry and directory cache but cannot select another agent, steal the current screen, replace a newer draft, or clear its text. Keep current IME/Enter safeguards in the existing composer.

Once row identity exists, use existing owner-safe history, exact resume/reattach, interrupt/Stop and continuation. Creation receipts do not attach a transport by themselves. Exact resume for these targets must refuse title/adoption fallback via a PRIVATE verified-target context around the existing resume handler; generic resume keeps its current behavior. Revalidate row/profile/lineage inside that seam to close read-then-resume deletion races. Existing accepted turns use `close_on_disconnect=False`, producing-orphan protection and lease lifecycle; an old disconnected transport cannot close a newer attachment. No replacement worker on phone disconnect.

## 8. Short sequence diagram

    Client             Composite RPC             Existing stores/runtime
      | local draft          |                            |
      | freeze UUID; verify local retry                   |
      |-- create ----------->|-- pure preflight ---------->| C + T + projects (read)
      |                      |-- capacity reservation --->| existing registry
      |                      |-- bind; preparing CAS ---->| C
      |                      |-- session.create --------->| ordinary runtime, no prewarm
      |                      |-- row + claim transaction >| T (single commit)
      |                      |-- prepared/dispatching CAS >| C
      |                      |-- bound prompt.submit ---->| ordinary pipeline
      |                      |                            |-- admit in T
      |                      |                            |-- build/thread/run/settle
      |<-- minimal receipt --|<-- read C + T -------------|
      X first response lost  |                            |
      |-- reconcile -------->|-- exact owner/request ---->| C -> bound target T
      |                      |-- terminal-only recovery ->| no create/resume/submit
      |<-- identity/status --|                            |

No transaction spans C, T and the registry; the table in section 4 specifies those gaps.

## 9. Implementation seams — exact files and symbols

Names prefixed “new” below are planned additions, not claims they already exist. Preserve current dirty-tree work; do not restore/reset it.

| File | Existing seam -> required minimal change |
|---|---|
| tui_gateway/methods_companion_sessions.py | `register`, `wrap`, `capabilities`: register composite, advertise versioned capability, strict sanitized postbinding errors; creation reconcile variant |
| tui_gateway/companion_sessions.py | `_continuity_v3_key`, `_request_index`, `_continuity_ledger`, `_validate_reconcile_params`, `reconcile_session`, `continue_session`, `_v3_result`: new `create_session`, strict validators, v4 creation decode/projection, shared kind conflict, saga CAS/finalization; do not use `_legacy_continue_session` |
| tui_gateway/companion_projects.py | `_resolve_profile`, `_SourceGuard`, `_source`, `_build_tree`: new `resolve_creation_workspace` using read-only exact-ID project/folder snapshots and Desktop canonical matching, no refresh/mutation |
| tui_gateway/methods_session.py | registered `session.create`, `_create_overrides`, `_Resume.record`, `_Resume.mint`, `_resume_locate`, `_resume_follow_tip`, `_resume_reuse_live_locked`: new private ReservedSessionCreate context, one-shot reserved IDs/no prewarm, restore null policy in all resume variants; private exact-target resume guard |
| tui_gateway/session_lifecycle.py | `_claim_active_session_slot`, `_ensure_active_session_slot`, `_release_active_session_slot`, `_own_live_lease_ids`, `_close_sessions_for_transport`: strict provisional reservation/config injection, tracked transfer/rollback, protect preparing runtime; retain mobile disconnect behavior |
| hermes_cli/active_sessions.py | `try_acquire_active_session`, `_pid_liveness`, `_read_live_entries`, `_prune_dead`: optional no-prune-write refusal, strict unknown liveness; reuse existing FileLock and registry, no new registry |
| tui_gateway/session_workdir.py | `_workdir_row_model_config`, `_ensure_session_db_row`, `_persisted_session_cwd`, `_context_cwd_is_launch_artifact`, `_reconcile_session_cwd_from_terminal`, `_persist_session_cwd_and_schedule_git_meta`, `_persist_session_git_meta`, `_set_session_cwd`: pure row-fields construction/strict proof, null marker and explicit-only departure |
| hermes_state_sessions.py | `SessionSessionsMixin._insert_session_row`, `_inherit_parent_session_metadata`, `update_session_cwd`, `publish_session_git_metadata`: new `_insert_session_row_tx`, null-policy storage guard, compression inheritance and explicit workspace change transaction; ordinary schema only |
| hermes_state.py | `_execute_write`: retain existing transaction/retry discipline; no nested writes or new database manager |
| tui_gateway/companion_turns.py | `claim_turn`, `current_executor`, `executor_alive`, `_transition`, `mark_running`, `settle_turn`, `reconcile_dead_executor`: extract `_claim_turn_tx`, new `prepare_created_session`, creation kind/admission invariant and strict executor comparisons |
| tui_gateway/methods_prompt.py | typed-stop predicate/`prompt.submit`, `_prepare_durable_turn_claim`, `_persist_session_row_for_submit`, settlement helpers: pure shared preflight, prepared-row proof and matched-claim fence before any build; retain existing single thread/build path |
| tui_gateway/prompt_turn.py | existing running/terminal hooks: enforce creation admitted-before-running and leave all execution in this ordinary path; no creation-specific agent branch |
| tui_gateway/server.py | long-handler dispatch set, `handle_request`, `dispatch`, `_sess_nowait`, `_claim_or_reuse_live`, `_stored_session_runtime_overrides`, `_make_agent`: ContextVar propagation, provisional-runtime guard, null policy before eager build; no network/file work under global runtime lock |
| tui_gateway/entry.py; tui_gateway/ws.py | existing stdio/WS JSON decode entrypoints: duplicate-member rejection, real transport test coverage; no owner bypass in production stdio |
| tui_gateway/project_tree.py; tui_gateway/methods_projects.py | `_FolderIndex`, `_project_for_session`, `_auto_buckets`, `_project_tree_row`: reuse as canonical test oracle; no second grouping relation, ensure no live overlay overwrites persisted null policy |
| apps/companion/src/gateway/types.ts | dedicated exact creation/reconcile/receipt/capability contracts, no broad SessionResult alias |
| apps/companion/src/gateway/companion-client.ts | new creation and request-only reconciliation methods plus runtime schema parser; no cast/spread-through of legacy result |
| apps/companion/src/state/session-drafts.ts | owner-scoped local identity/revision and safe conditional rekey; extend existing draft store |
| apps/companion/src/state/companion-store.ts | new draft actions/first-send state machine; replace single retry slot with scoped per-request variants, Web Lock, checks before send and after awaits; `openPersistedSession` remains continuation seam; bypass `resolveBotChat`/`selectTeammate` for new drafts |
| apps/companion/src/features/directory/work-directory.tsx; apps/companion/src/app.tsx | owner/capability-gated New conversation, agent/project/explicit null selection, local draft -> existing conversation UI |
| apps/companion/src/features/conversation/message-composer.tsx; conversation.tsx | reuse current composer/IME/draft rendering, pending/uncertainty state only; no second composer/runner |

Before implementing a listed seam, recheck its current definition/usages against these hashes and the line references in the audit. Small symbol drift is not permission to change the contract. Existing profile-scoped configuration is read through current override context, reset after the call, and copied into worker context as the existing pipeline does; never mutate HERMES_HOME/TERMINAL_CWD/process active project globally.

## 10. Red -> green invariant test matrix and delivery gate

All tests below are REQUIRED future work. None were executed for this read-only G0 artifact. First add a failing assertion against the current code (missing method/capability/behavior), record the actual red result, implement the relevant seam, then run the same assertion green. Do not call a mocked composite result proof of admission.

| Group | Red invariant and fault schedule | Required green observation | Test files |
|---|---|---|---|
| R1 wire/auth | Missing capability; every extra/missing/wrong-type key, duplicate JSON member, invalid UUID/UTF-8, owner shared/agent/expired/revoked/unserved | Exact schemas; fixed sanitized errors; zero preflight business effects; no production stdio auth bypass | tests/tui_gateway/test_companion_persisted_sessions_rpc.py; test_protocol.py; test_companion_transport_integration.py |
| R2 pure preflight | Sanitized-empty, stop-only, missing/read-only/corrupt C/T, invalid profile/project, remote terminal/isolation | Instrument counters for create/runtime row/index/turn/lease/build/timers/terminal overrides/history/config: all zero | test_companion_persisted_sessions_rpc.py; test_prompt_accept_logging.py |
| R3 capacity | Cap=1, independent processes simultaneously reserve distinct drafts; registry unknown liveness; refusal with stale entries; sweep during transfer | One successful reservation; refusal does not rewrite registry; no hidden orphan lease transfer; strict unknown fails closed; unused proposals rolled back | test_companion_session_continuity.py plus existing active-session lease tests |
| R4 immutable binding | Same owner/request from multiple processes; changed text/backend/profile/project/null/kind; legacy receipt present | One C index/key; one create invocation; one initial ordinary row/claim; at most one pipeline entry/admission; losers release unused leases | test_companion_session_continuity.py; test_companion_persisted_sessions_rpc.py |
| R5 cross-DB gaps | Separate real C and T files; deterministic process barriers/crashes at EVERY row of failure table, including T committed/C preparing and T terminal/C not closed | Only legal evidence pairs; recovery matches table; no runtime/submit during recovery; same known-or-unknown stored ID recovered | test_companion_session_continuity.py |
| R6 liveness/takeover | PID reuse; lookup denied; start=0; live stalled creator >60s; dead creator; simultaneous reconcilers | Never timeout replay; bounded recovery_required for unknown/live-stalled; dead index-only reaches terminal; creator epoch never reassigned | test_companion_session_continuity.py |
| R7 SQLite/cleanup faults | BUSY retry, IOERR, disk-full, commit acknowledgment loss, `_ensure_session_db_row` false success, release failure | SQL callbacks have zero runtime effects; proof not boolean; ambiguous commit never fresh execution; exact leaked lease reported/retained | test_companion_persisted_sessions_rpc.py; test_companion_session_continuity.py |
| R8 ordinary pipeline | Spy on real registered create/submit plus real T DB/turn transitions; unrelated generic submit races first slot; fastest possible completion | Exactly one create and one submit on success; generic bypass refused; first row exists before claim/admit; no prewarm before admit; completed receipt accepted | test_companion_transport_integration.py; test_prompt_accept_logging.py |
| R9 projects | Exact ID vs slug; archived/discovered; overlaps/ties; primary mismatch; symlink/path inode change at each boundary | Reject unsupported before reserve or durable not_admitted after binding; correct selected profile/model/memory; actual Desktop tree selected ID | test_projects_rpc.py; test_companion_persisted_sessions_rpc.py |
| R10 no-project | Fallback inside registered repo; upsert, delayed git publication, terminal cd/settle, eager/deferred resume, compression, later explicit workspace move | NULL cwd/git and Home before explicit move; marker survives; execution fallback works; explicit move clears marker atomically; active global config unchanged | test_projects_rpc.py; test_protocol.py; existing session DB ownership/resume tests |
| R11 privacy | Canary raw prompt, cwd and legacy result injected into inner returns/errors; malformed receipt; stored retry scan | Only allowlisted coordination/receipt/retry fields; normal transcript is sole prompt persistence; no path/raw exception/log leak | test_companion_persisted_sessions_rpc.py; test_prompt_accept_logging.py; companion-client.test.ts; companion-store.test.ts |
| R12 local draft | Open/edit/cancel, All without agent, project change, storage/crypto/Web Locks unavailable, double tap | No runtime RPC before Send; stable persisted ID before transmission; no RPC if safety prerequisites fail | session-drafts.test.ts; companion-store.test.ts; work-directory.test.tsx; app.test.tsx |
| R13 overlapping client state | Await barriers at hash/storage/send/response/history; newer draft/profile/owner/backend; two tabs; per-request storage full | No wrong-scope transmission, request overwrite, stolen screen or cleared newer text; same logical draft shares one ID | companion-store.test.ts; session-drafts.test.ts; companion-client.test.ts |
| R14 reconnect | Drop FIRST response before client learns ID; restart app/process; same owner new lease; wrong owner; not_found delayed original arrival | Request-only reconcile restores exact binding; no cross-owner disclosure; not_found retry uses same ID; indexed/unknown never cleared as rejected | test_companion_transport_integration.py; companion-store.test.ts |
| R15 lifecycle | Disconnect during build/run, reattach, stale old transport close, Stop; second send | Original ordinary pipeline survives detach; old close cannot kill new attachment; Stop settles ordinary turn; second send uses continuation | test_companion_transport_integration.py; companion-store.test.ts; conversation.test.tsx |
| R16 generic regression | Existing generic create/branch/resume/prompt tests before and after private seam | Unchanged public generic responses, lazy-row behavior, defaults, source, IDs/prewarm/profile config | test_protocol.py; test_projects_rpc.py; tests/test_tui_gateway_server.py |

Independent-process concurrency must use `multiprocessing` spawn/subprocesses with separate imports, connections and server globals, sharing only actual temp C/T/registry files. A thread pool cannot certify this invariant. Use file/pipe barriers and external append-only test counters for create entry, submit entry and fake-agent invocation; do not count only final messages because duplicate admission may fail before persistence. Crash at boundaries with actual process termination in tests, not just caught exceptions. Test both C=T and C!=T. Seed projects/config/schemas only in fixture setup, never during “pure validation” measurement.

Real stdio gate extends existing `StdioRpcClient` and `tests/tui_gateway/fixtures/companion_stdio_gateway.py`: launch production `entry.main`, actual method registration and ContextVar dispatch, server-minted TEST owner lease on the transport, real SessionDB/registry, controlled persistent synthetic agent and no provider/network calls. Keep the fixture's test-only authorization arrangement isolated; also test production unauthenticated stdio denial and real WebSocket owner/revocation separately. Ensure parser-level duplicate-member tests send raw lines, not dictionaries already normalized by Python.

Required demonstration: new local draft -> existing-project first send -> intentionally discard first receipt -> disconnect -> request-only reconciliation -> inspect the actual ordinary row through Desktop's project tree -> ordinary continuation -> Stop. Repeat with explicit null inside a project-like fallback and with target profile different from launch profile. Evidence must include row/claim counts, create/submit counters, final receipt, Desktop membership and unchanged active workspace/config. No device is required for server invariants; physical Samsung comfort/IME acceptance remains a later UI gate, not G0 proof.

Future verification commands, in an isolated test environment with existing dependencies (not executed here):

    python -m pytest tests/tui_gateway/test_companion_persisted_sessions_rpc.py tests/tui_gateway/test_companion_session_continuity.py tests/tui_gateway/test_companion_transport_integration.py tests/tui_gateway/test_protocol.py tests/tui_gateway/test_projects_rpc.py tests/tui_gateway/test_prompt_accept_logging.py -o addopts= -q
    npm --prefix apps/companion test -- src/gateway/companion-client.test.ts src/state/companion-store.test.ts src/state/session-drafts.test.ts src/features/directory/work-directory.test.tsx src/features/conversation/conversation.test.tsx src/app.test.tsx
    npm --prefix apps/companion run typecheck
    npm --prefix apps/companion run lint

Run the additionally touched storage/lifecycle/resume test suites identified by definition/usages, and the full relevant regression suites before delivery. G1–G7 require actual logs/results; this design does not mark them passed. No commit/push is implied by this handoff.

## 11. Source fingerprint and G0 closure

Fingerprints of inspected critical working-tree files (SHA-256):

    c1248f72570468a9f1f4716c1778c0c47f3959d35da91fe384dddc5250202dbf  tui_gateway/companion_sessions.py
    ad3359ca0ca7831f39860578b8f3e14d1682508a8b78d32387c049bf8873ef5b  tui_gateway/companion_turns.py
    c11de551fc3ed82d14ac9e6e4a0f34f3d3b25fcadd8c1ec80560ca388e1cc602  tui_gateway/methods_session.py
    f0f7495d71cd7d7b79be2456b55c0f196bc348eb512e8defe4cb08876a013025  tui_gateway/methods_prompt.py
    5e35178ac2a3354587c37b6dd799f07d883579646647b4e430ff6ceb967f5b57  tui_gateway/session_workdir.py
    d38b24f15d9c0e8c89830d3c5dd809caa1f6faf7253a1d0df62d1399ab481a1d  tui_gateway/project_tree.py
    718e4989b3fcb3123804f525cb5a124a57fdb3daf113bb24e5355ab100f3f60d  hermes_cli/active_sessions.py
    515a2bbcdf1087594febc6d1c2d7c1ece8aaaa543e82d0f8d197feea8c3e9739  apps/companion/src/state/companion-store.ts
    3541dd1d1329f97f962825a8d5d66cbff4a80aaa4fb1083cd60802eda1866aaf  apps/companion/src/state/session-drafts.ts
    36e0fc9cd2c79ea679ae4f878aae3c6bca3428127989b199debdd4461df06ac6  docs/plans/2026-09-09-companion-mobile-continuity-implementation.md
    81b9fea3e217b01953acecd94c227060c726858fe3b9dc78773c84368ae239d5  /tmp/p4-astra-current-audit.md

Final read-only verification detected concurrent external change to `apps/companion/src/state/companion-store.ts`: its later SHA-256 was `eb99885c7f74ac1d0e6c8f289644b000dec8d762beaa18fcd1d0a94044b4d953`. The fingerprint above records the inspected earlier version, not a claim that the repository was frozen. A subsequent symbol check confirmed the same single retry record/storage key, existing draft store, and `openPersistedSession` continuation seam (now starting at line 1412). The other critical fingerprints above were unchanged at verification. Rebase implementation on the then-current working tree without restoring either version; this design's decisions remain fixed.

G0 closure: strict RPC/capability/receipt and request-only reconciliation are fixed; owner/request/kind binding precedes runtime; index-only recovery is terminal-only and bounded; cross-DB gaps are an explicit saga with one atomic row/claim transaction; reserved-key create is a private one-shot seam with no prewarm; actual capacity reservation has explicit rollback and is not called pure validation; ordinary prompt.submit is the sole execution path; project/null identity and fallback persistence are explicit; privacy allowlists and client uncertain-state rules are fixed; exact implementation seams and red-green/independent-process/stdio gates are named.

There are no remaining undecided G0 questions. This approves implementation of this design, not a claim of implemented correctness or G1–G7 passage.

PASS_TO_IMPLEMENT
