================================================================
WHAT I READ (recoverable in this session's context)
================================================================
- tui_gateway/companion_turns.py: 120-200 (executor identity/liveness), 1290-1440 (prepare_created_session, record_not_admitted), 1440-1620 (_validate_claim_evidence, _validate_creation_active_evidence), 1780-1967 (mark_running, settle_turn, reconcile_dead_executor, active_lineage_turn)
- tui_gateway/companion_creation.py: 320-849 (creator liveness, evidence matrix, project_creation_receipt, _reconcile_creation_recovery, phase CAS, _creation_request_index)
- tui_gateway/companion_sessions.py: 460-592 (list_sessions), grep of full def/error surface incl. _source at 304-350
- tui_gateway/session_lifecycle.py: 575-720 (WS-orphan reap: _cancel_ws_orphan_reap, _reattach_refusal, _rebind_live_transport, _ws_orphan_turn_activity_is_fresh, _schedule_ws_orphan_reap), plus lines 25/415 constants
- tui_gateway/methods_prompt.py: 415, 476-585, 740-830, 860-1010 region (durable claim prep, active-slot gate, transport rebind, admit/settle wiring)
- tui_gateway/server.py: grep hits for module wiring (3240-3320 region read, output partially recovered)
- Earlier in this session (pre-compaction, content no longer quotable line-by-line): full session_reaper.py, session_lifecycle.py, companion_session_create.py, methods_session_create.py, methods_session_resume.py, large parts of companion_sessions.py/companion_turns.py/companion_creation.py, diffs of hermes_state_sessions.py / gateway/status.py / hermes_cli/active_sessions.py / session_workdir.py / methods_session.py

NOT COVERED / NOT VERIFIABLE from current evidence: session_workdir.py contents; hermes_state_sessions.py compression-descendant diff details; gateway/status.py and hermes_cli/active_sessions.py diff details (read pre-compaction, output demoted — cannot cite lines); g3c-pause-state.md claims (not tested); whether every @method registration removed from methods_session.py is re-registered elsewhere (not enumerated); session_reaper.py idle/LRU behavior (read pre-compaction, not quotable now).

================================================================
Q1. DISCONNECT vs INTERRUPT / SECOND RUN
================================================================
Verified trace: on WS disconnect the session is re-pointed at a detached transport and a single reap Timer is scheduled (session_lifecycle.py:639-698). The reaper does NOT immediately interrupt: while the detached turn's activity clock is fresh it defers and reschedules (session_lifecycle.py:662-667, freshness test at 612-637, default stale threshold 600s at server.py:146).

But the claim "disconnect must not imply interrupt" holds ONLY while activity is fresh:
- If the turn goes quiet >600s (long tool call, stalled API wait) OR _WS_ORPHAN_ACTIVITY_STALE_S is set <=0 (which makes _ws_orphan_turn_activity_is_fresh return False unconditionally, session_lifecycle.py:613-614), the reaper sets _client_gone_interrupt_requested and calls _interrupt_session_turn (session_lifecycle.py:680-686) — an interrupt of a turn whose creator process is fully alive, triggered purely by client absence.
- After _WS_ORPHAN_INTERRUPT_REAP_MAX_POLLS it force-pops the session (session_lifecycle.py:668-673) and tears it down with end_reason ws_orphan_reap.

Neither path spawns a second run by itself: the durable lineage slot persists while the turn is active (deleted only inside settle_turn's write transaction, companion_turns.py:~1925 "DELETE FROM state_meta WHERE key = slot_key"), and reconcile_dead_executor settles only when executor liveness == "dead" (companion_turns.py:1932-1957), never for a live creator. Liveness classification is fail-safe: probe failure, missing fields, or start-time unreadable all return "unknown", not "dead" (companion_turns.py:148-173) — a live turn cannot be false-killed by reconcile. VERIFIED.

Second-run risk after force-reap: INFERENCE, not proven. If force-reap pops the in-memory session while the run thread is still executing, the durable turn record stays "running" with executor = the backend process itself (alive), so reconcile_dead_executor will never settle it until backend restart. Two consequences, both unverified end-to-end:
(a) the lineage slot may wedge (active_lineage_turn, companion_turns.py:1963-1967, keeps returning true) until restart;
(b) whether a fresh resume + new continuation claim on the same lineage is rejected while the old slot exists depends on _claim_turn_tx's slot enforcement for "continue" claims, which I did not trace.
This is the strongest remaining candidate for "second run while first executes" — flagged as UNVERIFIED RISK, not a finding.

================================================================
Q2. PROJECTION HONESTY (reads that mutate / collapsed errors)
================================================================
Reads are clean at the DB layer: list_sessions and session_history use _source(server, profile) whose default is writable=False (companion_sessions.py:304), open via db._read_ctx(), and write nothing durable; the only "write" is the in-process snapshot cache for cursors (companion_sessions.py:218, _cache_snapshot — memory, not state). No runtime is created, resumed, or activated on any list/history path I read. VERIFIED.

Source errors propagate honestly at the DB/profile level: "state.db unavailable" 5006, "session profile unavailable" 4403, "profile session state unavailable" 4404 (companion_sessions.py:304-350) — no path I saw collapses a missing source into an empty list or total 0. VERIFIED.

Finding m1 (MINOR, HIGH, VERIFIED): per-field fallbacks DO collapse corrupt values into fake zeros: companion_sessions.py:545-551 — int(row.get("message_count") or 0), float(row.get("started_at") or 0), float(row.get("last_active") or ... or 0). A row with a corrupt/missing message_count lists as message_count: 0 rather than erroring. Same pattern for title/preview ("_safe_text(... or '')" → empty string). Not "Main conversation" — I found no implicit "Main conversation" substitution in the ranges I read; not verified repo-wide.

Bounded listings are honestly labeled (coverage: "bounded", warning string, total omitted when bounded — companion_sessions.py:575-590). VERIFIED good.

================================================================
Q3. RECEIPT CORRECTNESS
================================================================
Finding M1 (MAJOR, HIGH, VERIFIED): a live, still-running creator is projected as recovery_required once the creation is older than 60 seconds.
Evidence: project_creation_receipt (companion_creation.py:401-494): fresh_creator = creator_liveness == "alive" and age_seconds <= 60.0 (line ~462). For turn_state in {claimed, admitted, running}, operation_status stays the default "recovery_required" unless fresh_creator (lines ~466-467). And _reconcile_creation_recovery returns early with just a receipt for any non-dead creator (companion_creation.py:522-525: "if creator_liveness != 'dead' or snapshot['phase'] == 'closed': return receipt(...)"), so reconcile cannot clear the recovery_required state while the creator lives. Trigger: a creation whose agent build + first turn takes >60s (routine for cold builds) — the client polls and is told "recovery_required" for a perfectly healthy in-flight create, for the entire duration. Fail-closed by design, but it fails CLOSED in the wrong direction: the client cannot distinguish "slow but fine" from "dead creator" until the creator actually dies or the turn reaches a terminal state. This is precisely the disconfirming case the brief asked about.

Refusal vs uncertain — VERIFIED honest:
- Pre-execution refusals tombstone deterministically via record_not_admitted (companion_turns.py:1361-1407), and a closed phase with closed_outcome "not_admitted" projects operation_status "not_admitted" (companion_creation.py:474).
- Dead-executor mid-run settles to "interrupted_outcome_unknown", not a clean failure (companion_turns.py:1955-1956: outcome = "not_admitted" if state == "claimed" else "interrupted_outcome_unknown"). Not retry-inviting.
- In methods_prompt, exception paths settle the durable turn "failed" with an explicit 5006 error carrying the durable operation id (methods_prompt.py:~774, ~803, ~1010-1030 region).

Finding m2 (MINOR, HIGH, VERIFIED): _null_creation_receipt (companion_creation.py:388-398) returns client_request_id: null with operation_status "recovery_required", and project_creation_receipt falls back to it on ANY invalid input or ANY exception (the whole body is one try/except returning the null receipt, companion_creation.py:410, ~493). A client that receives this cannot correlate it to its request — the exact uncorrelatable-receipt case. It also masks genuine internal errors (e.g., a corrupted index failing _canonical_creation_index_snapshot) as a generic "recovery_required" instead of surfacing an error code.

================================================================
Q4. UNKNOWN-OUTCOME / LOST RESPONSE
================================================================
VERIFIED good. _creation_request_index (companion_creation.py:769-849) binds atomically per (owner, client_request_id): same payload digest → returns the existing index (no second session); different payload → 4090 "conflicts with different creation payload"; different backend/profile/project target → 4090; legacy-continuation key collision → 4090. Generated values (operation_id, session id, timestamps) are captured before the retryable write callback, so a storage retry cannot mint a second session. Reconcile by the same client_request_id observes the durable index + turn record (_observe_created_session_recovery, companion_turns.py:1297-1300 — recovery variant deliberately skips phase policy to return exact evidence) and settles only when the creator is provably dead (companion_creation.py:527-588). No blind resubmit path exists on the reconcile route.

================================================================
Q5. CROSS-CLIENT / CROSS-PROFILE
================================================================
In-process, VERIFIED: every session lives in one in-memory dict; a second client rebinding goes through _session_resume_lock + _reattach_refusal (session_lifecycle.py:588-592: stale-session and interrupt-settling refusals) and _rebind_live_transport cancels the pending reap (session_lifecycle.py:608-609). Both clients funnel into the same runtime; the active-slot gate (_ensure_active_session_slot, methods_prompt.py:878) and the running-flag loop serialize turns. Reads are profile-scoped (_validate_profile + _owner_authorized_profiles, companion_sessions.py:103-138, 286-299) and read-only, so Companion browsing cannot touch another profile's state.db, and I saw no global-active-project or cwd mutation on any list/history path.
NOT VERIFIED: two backend processes hosting the same persisted sid simultaneously (cross-process double runtime), and the owner-scoped reclaim changes in hermes_cli/active_sessions.py — read pre-compaction but no longer quotable.

================================================================
Q6. REMOVAL RISK
================================================================
- methods_session.py: repo-wide grep (excluding tests) found exactly ONE external reference — a comment at hermes_state.py:1141. The create/resume/lifecycle/reaper/workdir modules are wired exclusively through tui_gateway/server.py (grep -l across tui_gateway/*.py hit only server.py; a grep of methods_session.py itself for create/resume/lifecycle/reaper/workdir imports/registrations returned no matches). So the ~718 removed lines were relocated, not orphaned, as far as import graph goes. VERIFIED for wiring existence; NOT VERIFIED that every removed @method registration is re-registered (I could not enumerate the removed method list against current registrations — the diff hunks were lost to compaction).
- hermes_state_sessions.py, gateway/status.py: diffs read pre-compaction; output demoted; cannot cite. NOT VERIFIED.

================================================================
Q7. DISCONFIRMING EVIDENCE — WHAT SURVIVED, WHAT DIDN'T
================================================================
Survived adversarial probing (could not falsify):
- "No second logical conversation per client_request_id" — the index CAS + payload/target conflict checks (companion_creation.py:769-849) held up.
- "Reconcile never false-kills a live executor" — liveness "unknown" on any probe ambiguity (companion_turns.py:148-173) held up.
- "Reads never mutate" — held up within everything I read.
- Evidence integrity is aggressively fail-closed: _validate_creation_active_evidence (companion_turns.py:1487-1600) enforces exact key sets, types, timestamp ordering, and cross-record executor identity; settle_turn deletes the lineage slot only inside the same transaction that terminalizes the record.

Could NOT verify:
1. Whether the force-reap path (session_lifecycle.py:668-673) strands a durable "running" turn with a live backend executor, wedging the lineage slot until restart (depends on _teardown_popped_session and _claim_turn_tx continuation enforcement — not traced).
2. Whether _claim_turn_tx rejects a second continuation claim on a lineage whose slot is occupied (underpins the entire "no second run" claim after a forced teardown).
3. session_reaper.py idle/LRU behavior vs running turns (read pre-compaction, not quotable).
4. methods_session.py removed registrations re-registered; hermes_state_sessions.py / gateway/status.py / active_sessions.py diff correctness.
5. g3c-pause-state.md claims — untested.

================================================================
FINDINGS SUMMARY
================================================================
BLOCKER: 0
MAJOR: 2
  M1. Live in-flight creation projected as recovery_required after 60s (companion_creation.py:462-467 + 522-525). HIGH, VERIFIED.
  M2. WS-orphan reaper interrupts and can force-reap a running turn whose creator process is alive once activity is stale >600s or the stale threshold is disabled (session_lifecycle.py:613-614, 680-686, 668-673) — "disconnect never implies interrupt" is only conditionally true. HIGH for the interrupt path (VERIFIED); the lineage-wedge consequence is MEDIUM, INFERENCE.
MINOR: 2
  m1. Per-field 0/empty fallbacks in list projection silently normalize corrupt rows (companion_sessions.py:545-551). HIGH, VERIFIED.
  m2. _null_creation_receipt returns client_request_id: null and swallows all internal errors as generic recovery_required (companion_creation.py:388-398, 410, ~493). HIGH, VERIFIED.

Top 3:
1. M1 — receipt honesty for long-running live creations (misleads clients into recovery flow for healthy operations).
2. M2 — activity-stale interrupt/force-reap of live turns on client absence, plus the unverified lineage-wedge tail.
3. m2 — uncorrelatable null receipts masking internal errors.

Verdict: PASS WITH FINDINGS
(0 BLOCKER / 2 MAJOR / 2 MINOR; two material claims — post-force-reap lineage behavior and removed-registration completeness — remain unverified and should be closed before merge.)

session_id: 20260912_112702_c4e038
