# Review A — session creation & authorization seams

Route: `z-ai/glm-5.3` via OpenRouter (independent reviewer process, read-only).
Captured verbatim from `run-A.log` (session `20260912_110040_20ed98`); the reviewer's own
file write was skipped when it ran out of tool budget, so this file is the authoritative copy.

---

# Independent code review — lens A: session creation & authorization seams

## Verdict

**PASS WITH FINDINGS.** From the creation/state-machine/authorization lens, this code is substantially sound: the phase machine is a strict single-writer CAS inside one SQLite write transaction, the exactly-once story is anchored in an atomic request-index bind plus idempotent replay, owner authorization is a server-minted monotonic lease re-validated at every seam, and the workspace hold genuinely pins directory and `projects.db` identities with `O_NOFOLLOW` descriptors. I could not construct a counterexample where a creation dispatches twice or where an authorization refusal is projected as uncertain. The findings below are a narrow residual TOCTOU window (claim 4's "no window exists" is overstated), a microsecond owner-revocation race before the internal submit, a >60s-saga false `recovery_required`, and a hard merge-order dependency on the untracked new files. None of these is a blocker; freezing as a release candidate is defensible from this lens once the merge finding is acknowledged.

## Claim verification

**Claim 1 — Exactly-once submit: VERIFIED (HIGH).**
- The request index is minted atomically in one SQL write with all generated values captured before the retry-able callback: `tui_gateway/companion_creation.py:764-847` (`_creation_request_index`; docstring 780-784 "cannot mint another session, operation, creator, or timestamp"). Re-entry returns `(existing, False)` (823-845) and `create_session` replays instead of re-binding: `tui_gateway/companion_session_create.py:650-651, 352-353` (`_replay_receipt` → `reconcile_creation_session`, which "never creates a row", `companion_creation.py:169-259`).
- Payload/target conflicts are rejected with `hmac.compare_digest` on the digest (`companion_session_create.py:138-149`; write side `companion_creation.py:830-844`), so a client retry with a different body cannot hijack the id.
- Runtime submit is fenced exactly once: `_provisional_creation_access_allowed` requires the process-private `ReservedSessionCreate` context to match a frozen authority AND the durable claim (`pid`, `started_at`, `token`, `epoch==1`, same lease object identity) — `tui_gateway/methods_session_create.py:138-172`; `_authority_matches_claim` also requires `claim.generation == authority.creator_epoch == 1` (145). Without the context var, all session-scoped RPC on the fenced runtime is refused 4090 ("session creation is still pending", `tui_gateway/server.py:1082-1088`).
- The row + first-turn claim are published atomically with re-entry proof: `tui_gateway/companion_turns.py:1307-1386` (`prepare_created_session`: row/claim pairing enforced 1331-1338, replay verification 1360-1367, generation==1 enforced 1378-1382).
- Crash between prepared and dispatching: recovery only settles **dead** creators (`companion_creation.py:531` `if creator_liveness != "dead" or phase == "closed": return receipt`), `claimed` rows under `prepared/dispatching` are settled `not_admitted` (560-574), `admitted/running` under `dispatching` go through `reconcile_dead_executor` which classifies executor liveness by pid+start-time (`companion_turns.py:1932-1961`, liveness 148-171). A live creator is never settled by a second process; a client retry while the creator is alive gets a projected receipt, not a second dispatch.
- Lost RPC response: the saga's own `_project_receipt` path and `_replay_receipt` both derive from the ledger, not from the RPC result (`companion_session_create.py:168-222, 153-165`).
- Counterexample attempts (second client racing `bind_turn`; kill between `_advance_creation_phase(..., "prepared")` at 440-447 and `"dispatching"` at 456-463; duplicate `prompt.submit` from another transport) all failed to produce a second submit. INFERENCE on thread interleavings (not executed).

**Claim 2 — Five-phase machine integrity: VERIFIED (HIGH).**
- Allowed transitions are closed over `_CREATION_EXECUTION_TRANSITIONS` (`bound→preparing→prepared→dispatching`, `companion_creation.py:39-43`); CAS rejects wrong expected phase, `closed` re-entry with a different outcome, and any non-listed next phase (672-681). The write re-reads current state inside the transaction and rejects any drift in phase/phase_at/closed_outcome (712-722); identical target is a no-op returning `False` (712-713), so double-advance is idempotent, not a second advance.
- Two concurrent callers for the same draft: both must present the exact creator tuple recorded in the index (663-671); creator identity is a per-process token refreshed per-pid after fork (302-330), and the in-transaction phase comparison serializes them — the loser gets 4090.
- "Dispatches and reports failure": every exception path either rolls the runtime back and closes `not_admitted` (`_rollback_before_row`, `companion_session_create.py:241-260`), settles the turn and closes `turn_record` (`_settle_prepared`, 263-290), or forces `operation_status = "recovery_required"` (520-521, 560-562, 608-611). I found no path that reports a clean failure while the fenced runtime stays dispatchable. Caveat: if rollback succeeds but `_close_index` throws, the caller raises 5066 unknown (`252-259, 538-539`) while nothing will dispatch — conservative (reports *more* uncertainty than reality), not the dangerous direction.

**Claim 3 — Owner authorization at every seam: VERIFIED (with one micro-race finding).**
- Identity source is admission-only: the lease is stamped into `ws.scope` exclusively by ticket admission (`hermes_cli/web_server.py:790-800` — pops first, re-issues only for `ticket`/`ticket-subprotocol` credentials) and read onto the transport at `tui_gateway/ws.py:88-90` ("Set only by dashboard ticket admission, not JSON-RPC parameters"). No RPC param can supply it.
- Lease validity is server-clock monotonic expiry **and** generation revocation: `hermes_cli/dashboard_auth/ws_tickets.py:70-84` (`monotonic() >= expires_at` → None; generation mismatch → None); revocation bumps the generation (`87-99`).
- Re-validation points in the saga: entry `companion_session_create.py:632`; pre-index 336; pre-`preparing` 405; pre-`prepared` 448; post-workspace-revalidate 455; pre-`dispatching` 464; and immediately before the internal submit via `_bind_provisional_creation_submission` at 293-300 (`_require_owner(owner_authorization)` first) plus 479. Reconcile re-validates at `companion_creation.py:182`; capabilities re-validates the live lease on every call (`methods_companion_sessions.py:44-53`). No fallback to a shared gateway token exists anywhere in the read set.
- Gap: after the check at 479 there is **no further owner check inside `prompt.submit`** before the model runs (`methods_prompt.py:844-1015` never consults the owner lease). See Finding 2.

**Claim 4 — One continuous workspace hold, no TOCTOU: VERIFIED WITH A RESIDUAL WINDOW (MEDIUM-HIGH).**
- The hold is genuinely one context: entered once at `companion_session_create.py:653-657` and held through the whole `_create_session_in_workspace` call (668-682). `_CreationDirectoryGuard.open` pins every path component with `lstat` (rejects symlinks and non-dirs, 242-246), then opens `O_NOFOLLOW|O_DIRECTORY|O_CLOEXEC` and requires the fd's `(st_dev, st_ino)` to match the last chain entry (247-256). `validate()` re-checks fd identity, every ancestor's `(dev,ino,dir,not-symlink)`, and access (266-286). The `projects.db` side is a second `_SourceGuard` with the same dev/ino revalidation (`companion_projects.py:650-695`), plus row and canonical-fingerprint recheck in `_HeldCreationWorkspace.validate` (321-343).
- Revalidation before the CAS: held-vs-resolved dict comparison at saga lines 398-404 (comparables include `_identity`, i.e. the pinned chain identity), `held_workspace.validate()` + a fresh `resolve_creation_workspace` + comparison at 449-454, then the `prepared→dispatching` CAS at 456-463.
- Residual window (Finding 1): after the 449-454 validation returns and before the CAS at 456, there is no further guard validation; a local process that rename-swaps the workspace directory in that sub-millisecond gap is detected only at the *next* `validate()` — which does not happen before dispatch. The held fd still pins the old directory, so the effect is that dispatch proceeds against the originally-validated directory (fd-backed), i.e. the damage is bounded, but the claim's "no window exists" is not literally true.

**Claim 5 — Refusal/uncertainty projection: VERIFIED (HIGH).**
- The fail-closed matrix `_creation_evidence_permitted` (`companion_creation.py:357-383`) plus `project_creation_receipt` (401-493): evidence `absent` + phase `closed/not_admitted` → permitted → `operation_status="not_admitted"` (471-474) — a lease-slot refusal is therefore projected as a clean refusal, not recovery. Anything not permitted → `recovery_required` with `row_state` forced to `"unavailable"` (477-478). Uncertain in-saga outcomes are forced to `recovery_required` at the saga level (520-521, 560-562, 608-611); `_settle_creation_for_refusal` failure returns the 5066 unknown error rather than a clean failure (`methods_prompt.py:633-649, 629-630`). I found no path that projects an authorization refusal as uncertain, and no path that projects an uncertain outcome as a clean retry-inviting failure. One soft spot: `_refuse_admitted_durable_creation` settles `failed` (`methods_prompt.py:670-684`) — see Finding 4.

## Findings

1. **MAJOR (process/merge) — untracked files are load-bearing.** `tui_gateway/companion_creation.py`, `companion_session_create.py`, `companion_turns.py`, `methods_session_create.py`, `methods_session_resume.py`, `hermes_cli/companion_work_store_readonly.py` (and 13 new test files) are `??` in `git status`, while tracked files already import them (`tui_gateway/server.py:3248` imports `methods_session_create`; `companion_sessions.py` lazy-imports the new modules). Committing only the modified files breaks `import tui_gateway.server` for every other suite. Confidence HIGH. Check: verify `git status` is empty of `??` under `tui_gateway/` and `hermes_cli/` before the branch is frozen.

2. **MINOR — no owner re-check inside the dispatch boundary.** `companion_session_create.py:479` validates the lease, then `prompt.submit` runs at 480-482 with no further `leased_human_identity` check (`methods_prompt.py:844-1015`). A revocation landing in that window lets a revoked owner's first creation turn execute. Confidence MEDIUM (race is microseconds; revocation is rare). Check: assert `current_transport().companion_owner_authorization` liveness (or the bound owner) once inside `prompt.submit` when a durable claim is present.

3. **MINOR — residual TOCTOU between workspace revalidation and the dispatching CAS.** `companion_session_create.py:449-454` validate, then 456-463 CAS with no guard validation in between (`companion_projects.py:266-286` is the last full check). A rename-swap in that gap dispatches against the pinned-fd directory while `projects.db` may already point elsewhere. Confidence MEDIUM (requires local FS control; fd pinning bounds the impact). Check: call `held_workspace.validate()` immediately after the CAS succeeds, before `_bind_provisional_creation_submission`.

4. **MINOR — admitted-creation failure projects a clean `failed`.** `_refuse_admitted_durable_creation` settles with `outcome="failed"` (`methods_prompt.py:682`), the coordinator closes `turn_record` (`companion_session_create.py:500-508` via `_TURN_RECORD_COORDINATOR_STATES` including `"failed"`, 40-42), and the receipt projects `failed` (`companion_creation.py:469-470`) — a clean failure after `admit_turn` committed. A client that blindly retries creates a second session for the same intent while the first row persists. Confidence MEDIUM. Check: confirm the Android client treats a `failed` creation receipt as terminal (no auto-retry) and surfaces the persisted row.

5. **MINOR — fresh-creator window produces spurious `recovery_required`.** `project_creation_receipt` gates live-creator progress reporting on `age_seconds <= 60.0` (`companion_creation.py:464, 467-468, 475-476`): a saga whose agent build takes >60s reports `recovery_required` to a polling client while the turn is actually `admitted/running`. Conservative, but a client heeding it may trigger reconcile churn. Confidence MEDIUM (design choice; confirmed by code, not by a live client). Check: verify the mobile client tolerates `recovery_required` while `creator_liveness == "alive"`.

6. **NIT — null receipt on internal exception loses correlation.** `project_creation_receipt`'s catch-all returns `_null_creation_receipt()` with `client_request_id: None` (`companion_creation.py:492-493, 386-398`); a client polling reconcile on a corrupted index gets an uncorrelatable receipt instead of an error. Confidence HIGH (code), impact LOW.

7. **NIT — probe-only `_source` open.** `companion_session_create.py:659-660` opens the profile store read-only and discards it (`pass`); it serves only as an early failure probe. Harmless but undocumented; add a comment or drop it.

8. **NIT — silent `ValueError` swallow in hold teardown.** `companion_projects.py:470-474`: if `project_context.__exit__` raises `ValueError` while `exit_failure is not None`, it is silently discarded (only the `exit_failure is None` branch re-raises). Confidence HIGH (code), impact LOW.

## Blocked / not verifiable here

- Runtime interleavings: no two live clients, no kill -9 mid-saga, no real revoked-lease race — all concurrency conclusions are code-reasoned (INFERENCE), not executed. Test suite not run per constraints (read only).
- `hermes_state_registry.acquire/release_or_close` and `SessionDB._execute_write` retry semantics are imported, not read in depth — the single-writer guarantees of the CAS assume their documented behavior.
- `web_server_chat._ws_auth_reason` internals (ticket→identity stamping) were read only at the facade (`web_server.py:787-801`).
- The Android client's handling of `recovery_required` / `not_admitted` receipts (apps/companion TS side) was not reviewed — different lens.
- `session_lifecycle.py` lease `release()` retry semantics (`_lease_retry`, `methods_prompt.py:615-620`) under a contended lock were not traced to the OS-level lock file.

## Files read

- tui_gateway/companion_session_create.py (full)
- tui_gateway/companion_creation.py (full)
- tui_gateway/companion_projects.py (full incl. `_SourceGuard`)
- tui_gateway/companion_turns.py (full, 1967 lines)
- tui_gateway/companion_sessions.py (partial: `_require_owner`, `_source`, `_owner_authorized_profiles`, identity/scope helpers)
- tui_gateway/companion_library.py (partial: `_require_owner`)
- tui_gateway/methods_prompt.py (full)
- tui_gateway/methods_session_create.py (full)
- tui_gateway/methods_companion_sessions.py (full)
- tui_gateway/server.py (partial: build seam 1040-1079, `_sess_nowait` 1082-1115, imports 3248+)
- tui_gateway/methods_session_resume.py (header/`_Resume`)
- tui_gateway/method_ctx.py (partial: `bind_module`)
- tui_gateway/ws.py (partial: transport identity)
- tui_gateway/session_lifecycle.py (partial)
- hermes_cli/dashboard_auth/ws_tickets.py (partial: lease/revocation/tickets)
- hermes_cli/web_server.py (partial: owner-lease admission facade)
- hermes_cli/companion_work_store_readonly.py (partial)
- docs/plans/2026-09-09-companion-mobile-continuity-implementation.md (partial)
- docs/plans/companion-mobile-evidence/g3c-pause-state.md
- git status / git diff HEAD -- tui_gateway/methods_session.py (regression scan)

---

**Stdout summary** (verdict + counts + top 3):

Verdict: PASS WITH FINDINGS. Counts: MAJOR 1, MINOR 4, NIT 3. Claims: 1 VERIFIED, 2 VERIFIED, 3 VERIFIED (micro-race), 4 VERIFIED w/ residual window, 5 VERIFIED.
Top 3:
1. MAJOR: new modules (companion_creation/turns/session_create, methods_session_create) are still untracked — committing only modified files breaks `import tui_gateway.server` for all suites.
2. MINOR: last owner-lease check is at companion_session_create.py:479; prompt.submit never re-validates — microsecond revocation race before the model runs.
3. MINOR: no workspace-guard validate between the 449-454 revalidation and the prepared→dispatching CAS (456) — narrow residual TOCTOU contradicting claim 4's "no window".
Report file NOT written (tool budget exhausted) — save the inline report above to /Users/atlasweber/.hermes/profiles/atlas/workspace/companion-g3c-glm53-review-2026-09-12/review-A.md.

session_id: 20260912_110040_20ed98
