# Companion durable work inbox — RPC contract (v1)

Separate from `attention.list` (runtime tool permissions). All calls use existing
JSON-RPC `/api/ws` auth/origin boundary. `profile` is optional (launch profile);
unknown/invalid profiles fail closed. State is SQLite in the selected profile's
`companion-work.db`, shared by every client, not browser storage. No production
adapters or publication run inside this inbox.

```ts
type WorkState = 'ideas'|'in_progress'|'needs_me'|'done'|'declined';
type WorkDecision = 'approve_preparation'|'request_changes'|'snooze'|'decline';
interface WorkPayload {
  title: string; brief: string; evidence: string[]; next_action: string; owner: string;
  execution_ref?: string; // planning pointer, NOT proof of dispatch
}
interface WorkCard extends WorkPayload {
  id: string; profile: string; source_key: string; state: WorkState;
  revision: number; version: number; created_at: string; updated_at: string;
  snoozed_until: string|null; attention_due: boolean; attention_key: string;
  approval: null|{revision: number; scope: 'preparation_only'; decision_id: string};
  preparation_status: 'not_authorized'|'approved_task_linking_pending'|
    'linked_awaiting_triage'|'preparing'|'prepared'|'blocked'|'status_unavailable';
  handoff_key: string|null;
  execution_link: null|{execution_ref: string; acknowledged_at: string; handoff_key: string};
  completion_evidence: string[]|null;
}
interface WorkComment {
  id: string; card_id: string; revision: number; actor: 'agent'|'human';
  text: string; created_at: string;
}
interface WorkDecisionRecord {
  id: string; card_id: string; revision: number; action: WorkDecision;
  actor: string; reason: string; snoozed_until: string|null; created_at: string;
  scope: 'preparation_only'|'none';
}
```

## Methods

Every parameter object may include `profile`.

* `work.capabilities {}` → `{can_decide: boolean, reason: string|null}`. Decisions, reminders and comments require gated dashboard owner login and its single-use ticket. Shared tokens, server-internal credentials, stdio and agent CLI are read-only. Disabled controls are honest but do not replace native login integration.
* `work.list {states?: WorkState[], include_snoozed?: boolean}` → `{items: WorkCard[]}` (default all states including snoozed, newest first).
* `work.get {id}` → `{item: WorkCard, comments: WorkComment[], decisions: WorkDecisionRecord[]}`.
* `work.upsert {source_key, payload: WorkPayload, expected_version?: number}` → `{item}`. Creation omits version; update requires current version. Identical payload is a deduplicated no-op, even from a stale producer. Changed payload increments revision, clears approval and acknowledged execution link, and returns to ideas **except a snoozed pending decision retains needs_me and its human-set due date**. Snooze survives evidence edits, reproposal and restart. Closed cards cannot reopen or change.
* `work.propose {id, expected_version}` → `{item}`. Ideas → needs_me; repeat proposal of needs_me is a no-op, including snooze. Must revise after request_changes before reproposing. Approved or closed cards cannot be proposed again.
* `work.comment {id, text, idempotency_key}` → `{comment}`. Owner-only focused durable discussion, server-derived actor role, no approval or version implications.
* Every `WorkCard` carries server-owned `recommended_action`, exactly one of `approve_preparation`, `request_changes`, or `remind_in_2_hours`; clients must not infer it from priority text or button order. The simple decision card exposes exactly **Approve**, **Request changes**, and **Remind in 2 hours**. The reminder maps to the existing `snooze` mutation with a client-generated timestamp two hours from the click; arbitrary-date snooze and decline are not exposed on this card.
* `work.decide {id, expected_version, revision, action: WorkDecision, idempotency_key, reason?: string, snoozed_until?: string}` → `{item, decision}`. Owner-authenticated WebSocket only, never caller-supplied actor. Dates must be timezone-aware ISO-8601; snooze must be future. Exact retries return original result; altered retries conflict. Only unsnoozed needs_me cards are actionable. Approval → in_progress with **dispatch_pending**, not a claim that a worker started. Request changes → ideas; decline remains a historical/backend transition; snooze retains needs_me but suppresses attention until due.
* `work.preparation.list {}` → `{items: WorkCard[]}`. Current-revision approved preparation work. Includes pending and acknowledged handoffs; adapters filter `preparation_status`.
* `work.preparation.ack {id, expected_version, revision, handoff_key, execution_ref, idempotency_key}` → `{item}`. Trusted adapter reports a real tracker task it has read back. Checks current version, revision, approval and deterministic handoff key. Writes `execution_link`, increments version and changes preparation_status to linked. Exact retries return original response; changed key reuse conflicts. An optional payload execution_ref never counts as an acknowledgement. A delayed old-revision ack cannot authorize a changed proposal.
* `work.complete {id, expected_version, completion_evidence: string}` → `{item}`. Trusted adapter reports verified completion with nonempty tracker read-back evidence. Requires current-revision approved, linked work. Does not execute anything; records the report, changes state to done and preparation_status to completed. The inbox cannot independently query a tracker: the reporting adapter owns evidence truth.
* `work.digest {consumer: string}` → `{items: WorkCard[]}`. Due needs_me cards not yet acknowledged for this **local calendar day/card/consumer**. No messages sent.
* `work.digest.ack {consumer, items: {id: string, attention_key: string}[]}` → `{acknowledged: number}`. Call after delivery. Atomic receipts dedupe within a day across restarts and evidence revisions. Unresolved decisions can remind again tomorrow. Receipt validates current exact attention_key, including local date; a receipt crossing midnight or a revision conflicts and must be reconciled, not blindly retried.

RPC errors: `-32602` invalid parameters, `4403` unauthorized, `4404` not found/profile unavailable, `4409` stale version/revision, invalid transition or idempotency conflict. Re-fetch on 4409, never automatically replay the decision with a new version. Dates are UTC ISO strings. Refresh list/detail after mutations; no new subscription required. Exact idempotent responses are historical snapshots: re-fetch current state before using one to dispatch.

## Daily reminders and semantic suppression

`attention_key` is opaque to callers (currently `local-date:revision:generation`).
The selected profile's existing `config.yaml` `timezone` sets the local calendar;
unset defaults to UTC. Direct WorkStore consumers pass `timezone_name` explicitly
when their business day differs from UTC. Keep `consumer` stable (e.g.
`hoffee-daily-digest`); do not append random run IDs to evade deduplication.
Deliver digest, then ack its exact keys. Read/ack prevents sequential duplicate
pings, not simultaneous senders: one delivery owner per consumer is required.
A crash after delivery before ack can redeliver; no exactly-once messaging claim.
Silence never grants approval. Snoozed, approved, declined and done cards do not remind.

`source_key` MUST identify the business proposal semantically, not its evidence
filename, refresh date or generated UUID. The backend enforces uniqueness and
terminal decline/done for that key. It cannot infer that unrelated keys refer to
the same campaign: source adapters own canonicalization and historical suppression.
A refreshed evidence filename belongs in payload.evidence under the SAME key.

## Adapter and execution boundary

WorkStore CLI: `python -m hermes_cli.companion_work --help` provides upsert, propose,
comment, list, get, preparation, preparation-ack, complete, digest and digest-ack
using the same store. No decide command or actor flag. Select the profile with
existing HERMES_HOME/--profile behavior.

The production HOFFEE adapter is `python -m hermes_cli.companion_kanban_bridge`.
It requires `HERMES_COMPANION_KANBAN_INTAKE_URL` and the separately provisioned
`HERMES_DASHBOARD_KANBAN_INTAKE_SECRET`. Run it as a single-owner periodic
one-shot for the `hoffeecmo` profile. The destination endpoint grants only
`kanban:hoffee:create_get` and pins triage, `hoffeecmo`, tenant `hoffee`, scratch
workspace, and non-goal execution. The bridge uses `handoff_key` as destination
idempotency key, reads the returned task back before acknowledging it, and uses
`kanban:hoffee:<task-id>` as `execution_ref`.

Handoff identity is stable for one decision: `profile:card-id:decision-id`.
Before dispatch, re-read current approval/revision; create/get through destination
atomic idempotency; read back the real task, then preparation-ack. A timeout after
task creation records `status_unavailable`; the next run repeats the same
idempotency key and therefore recovers the same logical task instead of creating
twice. Kanban triage/todo/scheduled/ready map to `linked_awaiting_triage`,
running/review to `preparing`, blocked to `blocked`, and done to `prepared` only
when nonempty result evidence is present. Verified done then closes WorkStore;
done without evidence remains `status_unavailable`. Adapter concurrency/claim
policy remains with existing Kanban. `execution_link` is the acknowledged
reference; payload.execution_ref is only input context.
Preparation excludes publication, paid activation/spending, and live store
changes. HOFFEE Kanban remains execution authority; its publication ledger is a
separate final-write authority and is never altered here.

## Auth integration boundary for native clients

Existing server path is supported and exercised with a test provider:
1. Gated deployment advertises native auth through `/api/status`.
2. Native app opens `/auth/native/authorize` in system browser with S256 PKCE,
   loopback redirect and state; validates callback state.
3. POST `/auth/native/token` exchanges one-use callback code + verifier for
   bearer/refresh tokens. Store through OS secure credentials, not work params.
4. POST `/api/auth/ws-ticket` with `Authorization: Bearer <access-token>`.
5. Connect `/api/ws?ticket=<one-use-ticket>`; obtain a new ticket every reconnect.
6. Server `_ws_auth_reason` consumes ticket and stamps provider:user_id in ASGI
   scope; WSTransport carries it; methods_work derives identity from the current
   transport, never params. Internal/shared-token clients remain nonhuman.

**Native integration:** Companion implements the owner login, encrypted refresh
credential, fresh one-use ticket on every reconnect, and local sign-out paths in
Electron and Android. Loopback server-token mode still cannot grant work.decide.
The app exposes credential reset even when its owner socket is disconnected.

**Revocation boundary:** ticket admission creates a server-owned, five-minute
owner-authorization lease. Every sensitive work RPC revalidates both that lease
and the current owner allowlist, so removing an identity revokes an already-open
socket immediately. Local sign-out closes this client's socket and removes its
credentials; it does not claim global revocation of separately admitted sockets,
whose authority remains bounded by lease expiry or allowlist removal.

## Owner policy and loopback seam

Work decision capability is server-owned. `dashboard.work_owner_identities` is an
explicit allowlist of `provider:user_id` strings; when absent, the built-in basic
auth provider grants exactly its configured `dashboard.basic_auth.username`
(single-owner default) and no other identity. An empty list or malformed policy
fails closed — no identity is elevated. Servers bound to loopback run without the
auth gate by default; `dashboard.require_auth_on_loopback: true` opts a private
loopback deployment back into the same gate (no Host/Origin or token relaxation).

The established dashboard owner gate authorizes access across existing profiles;
this inbox adds no per-profile user ACL. Identity labels are not a sandbox against
same-OS-user code that can write the DB or read owner credentials. Keep those
credentials and writable owner state outside agent containers when required.
