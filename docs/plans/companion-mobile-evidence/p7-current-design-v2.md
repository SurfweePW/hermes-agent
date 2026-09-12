P7 audit and implementation design

Repository: /Users/atlasweber/hermes-companion
Branch: feature/hermes-companion
HEAD: 15bb315df34945a2097876053e49aae0c77a9b69
Basis: current dirty files and tests, authoritative P7 at docs/plans/2026-09-09-companion-mobile-continuity-implementation.md:273–285, and /tmp/p7-current-gaps.md.

Read-only audit. No repository modifications, builds, installations, service operations, or business actions. git diff --check passed. Test suites were inspected, not rerun; historical test counts are not current results.

Verdict: REQUEST_REDESIGN. The lifecycle, cleanup, and freshness design below is actionable. One security/compatibility decision remains unresolved: how existing shared-token remote clients are prevented from bypassing owner-only operations without silently breaking the existing Desktop contract.

1. Current findings

The previous gap report remains directionally correct, but is not an accurate current snapshot:

- signOutOwner() now clears session drafts. It still leaves other identity-scoped state behind.
- test_companion_transport_integration.py now exists. It exercises real stdio and synthetic execution, not production WebSocket disconnect teardown.
- Its historical Python failures and missing-Java report must be reverified, not repeated as current facts.
- iOS is not an additional implementation prerequisite: the authoritative plan targets Android and existing Mac compatibility.

Production gaps:

A. Foreground reconnect is still unwired.

app.tsx:62 installs only installDirectoryRefreshLifecycle(). installGatewayConnectionLifecycle() has no production caller and is shared-token-shaped: loadToken()/connect(token), not native owner-ticket reconnect.

companion-store.ts:786 handleState() disconnects the catalogs and publishes disconnected. The refresh lifecycle then skips because phase is not ready.

Simply wiring recover() is unsafe:
- recover():1877 calls session.resume or resolveBotChat when no retry record exists.
- resolveBotChat():1017 can create a session.
- connect():1051 reattaches stores; directory.attach():703 clears selection/history.
- App’s disconnected/recovering branch unmounts the conversation.
- App’s route-restoration effect reruns on phase changes and explicitly scrolls to zero.

Thus even a focus-neutral reconnect helper cannot preserve the production screen.

B. Revocation does not cover production resources.

createGatewayResourceRevocation() and createSecureOwnerSignOut() are isolated helpers. Production downloadOriginal()/allChunks() in library.tsx:120–185 use repeated JSON-RPC chunks, not fetch. Registering a disconnected AbortController would accomplish nothing.

CompanionClient does not forward cancellation signals, although apps/shared/src/json-rpc-gateway.ts:344 already supports them.

WSTransport validates neither lease validity nor owner status before sending queued stream frames. Revocation currently invalidates subsequent gated RPCs, not unsolicited outgoing data.

C. Logout remains incomplete and races remain.

companion-store.ts:1349 signOutOwner() does not invoke SessionSecretStore.revoke('gateway-token'). It leaves messages, streaming state, selected/runtime/stored identity, activeSession, recent sessions and other caches.

forgetSavedToken():1918 deletes the credential without first invalidating the active connection.

Additional races require fixing:
- savedTokenReady can restore a token after a later security transition.
- openPersistedSession() awaits digest/history, then persists retry metadata, publishes history and dispatches continue without checking generations at every intervening boundary.
- work.attach() publishes after an awaited capability call without validating its captured connection epoch.
- Library PDF verification can finish after selection/revocation and create an object URL.
- transcript-scroll.ts has a module-level scrollPositions map with no identity reset.

D. Owner authorization is incomplete.

Persisted Companion session RPCs use live owner leases. Generic session.interrupt, approval.respond and session.events.since do not.

approval.respond additionally searches all live sessions by request ID. Stop performs process-global TTS interruption before target validation.

server.handle_request()/dispatch() does not supply a central privilege gate. Adding owner-only Companion wrappers alone therefore does not eliminate generic-method bypass.

E. Freshness is currently overstated.

directory-refresh.ts:
- starts a fixed 30-second interval;
- blocks all sources behind one Promise.allSettled;
- records completion time only for Directory;
- treats fulfilled refresh promises as success even when stores internally record failures;
- treats incrementing a Library React token as completed Library refresh.

Its tests prove triggering/coalescing, not exact boundary behavior or bounded data age.

F. Phone disconnect can still influence execution.

methods_prompt.py starts a server thread, but ws.handle_ws() calls _close_sessions_for_transport(). session_lifecycle.py:495 can interrupt a detached running session after its activity becomes stale, including missing activity instrumentation.

Transport-independent execution is therefore not established merely by the background thread or current stdio test.

2. Required state model

Keep transport, authorization, execution and navigation separate.

In companion-store.ts introduce explicit state dimensions:

- Lifecycle: foreground / background.
- Connectivity: offline / connecting / connected / reconnecting.
- Authorization: unknown / owner / shared / sign-in-required / revoking / cleanup-failed.
- Existing turn state remains independent.
- identityEpoch, connectionGeneration and sessionGeneration guard different boundaries.

Do not encode every combination in CompanionPhase. Keep setup/connecting for explicit initial configuration, not foreground recovery.

Transitions:

- Connected → background:
  Stop refresh scheduling, invalidate outstanding read generations, cancel previews/downloads, detach and close the client socket. Preserve the same-owner route, selection, draft and scroll anchor. Never send Stop or resolve an approval.

- Background → foreground:
  Recalculate freshness immediately. If online and previously authorized, run one coalesced reconnect. Obtain a new owner ticket through ownerWebSocketUrl(); never reuse a ticket, call ownerSignIn automatically, or fall back to a saved shared token.

- Network loss:
  Close/invalidate the current socket immediately, cancel read resources, mark active submit/Stop outcomes uncertain, preserve same-owner presentation. Do not erase credentials on transient network failure.

- Network restoration / foreground / focus:
  Feed one coordinator, not independent reconnect loops. Retry transient failures while foreground with bounded backoff; duplicate signals share the same promise.

- Explicit authentication refusal or revocation:
  Invalidate authority and enter the cleanup path. Lease expiry is distinguishable from identity revocation: expiry may obtain one fresh ticket; explicit revocation must not silently reauthenticate.

- Logout/token forget:
  Synchronously enter revoking and invalidate all generations before the first await. End in signed-out or cleanup-failed, never usable shared mode.

- Destroy:
  Cancel listeners, timers, resources and callbacks. Ordinary application teardown must not delete persistent native login credentials.

Production wiring:
- app.tsx owns one lifecycle installation per store.
- Extend connection.ts around store.reconnectForeground()/suspend(), rather than token callbacks.
- Add a narrow native lifecycle adapter using GatewayTokenPlugin/MainActivity’s existing lifecycle. Events expose only activity state; preserve OwnerAppVisibility’s OAuth behavior.
- Browser/Electron use visibilitychange, online/offline and focus. Native and DOM signals are coalesced.
- Handle initial state and late listener registration; destruction must remove listeners even if registration finishes late.

3. Foreground reconnect is observation, not recovery-by-resume

Create reconnectForeground() as a separate entry point. Manual Recover should use the same safe observation path for persisted sessions.

It must not call configure(), configureOwner(), selectTeammate(), resolveBotChat(), session.create, session.resume, prompt.submit or any decision mutation.

Reconnect sequence:

1. Capture identity epoch and the exact backend/profile/logical-session target.
2. Acquire a fresh native ticket and establish a new transport generation.
3. Negotiate required capabilities before presenting ready.
4. Reconcile an outstanding durable request ID, if present.
5. Fetch canonical history and authoritative execution status.
6. Refresh catalogs independently.
7. Publish only if identity, transport and selected target still match.

Current reconcile_session() requires client_request_id and only returns status; it does not establish a new live event subscription. Successful submit currently clears retry metadata too early to support general reconnect observation.

Required extension:
- Retain the accepted operation receipt until a terminal canonical result, separately from “retry an uncertain submit” metadata.
- Add an owner-only, read-only observation operation for a durable session without a client request ID, including turns started on Desktop.
- Return logical identity, current tip, execution identity/status and pending approval identity. Never create a runtime or reactivate a project.
- Initially use bounded read-only polling after reconnect rather than silently treating session.resume as subscription. Live subscription can be added only with an explicit snapshot/replay-watermark contract.

Unknown or conflicting receipt outcomes remain uncertain. A failed reconciliation is not permission to generate a new request ID.

UI:
- Keep the same screen subtree mounted during transient reconnect.
- Show connection status without replacing the conversation with Recovery.
- Change directory.attach/disconnect so transient reconnect preserves selection and last verified history; reset remains destructive.
- Route restoration runs on genuine navigation/identity changes, not every connection-phase transition.
- Preserve transcript anchor and follow/unread state; do not focus the main element or composer automatically.
- Process death follows the plan’s cold-start behavior, not a false promise that DOM focus survives process recreation.

4. Security and transport boundary

Every privileged request must validate:
- server-issued live lease;
- current configured owner;
- served profile;
- exact backend/logical session;
- current execution/request identity where applicable.

Client ownerStatus is not authorization. On Android it can involve network/refresh; on Electron it is currently a local credential-presence check.

Add exact-target Companion Stop and runtime-approval operations:
- Stop includes durable target and expected execution ID.
- Approval includes durable target, execution ID, request ID and an allowed choice.
- No global request-ID search, resolve_all, arbitrary default choice or fallback target.
- Revalidate after blocking waits and immediately before mutation.
- “Stop accepted” is not proof that execution has settled. Terminal state comes from authoritative completion/reconciliation.
- Timeout or disconnect never automatically retries Stop, approval, Work decisions or evidence pinning.

Keep P5’s revision checks, preparation-only meaning, separate tool approvals and server read-back.

Server stream revocation:
- Extend ws_tickets.py lease revocation and WSTransport lifecycle.
- Gate outgoing events and replies again immediately before send, including queued/coalesced frames and replay results.
- Schedule closure at lease expiry; revocation notifies matching live transports.
- Discard queued tokens, cancel flush timers and reject subsequent privileged requests.
- Bytes already handed to the operating system cannot be recalled; guarantee no new application-level sends after revocation takes effect.
- Use distinct sanitized expiry/revocation close reasons, propagated through CompanionClient rather than collapsed into generic closed.

Execution ownership:
- Mark admitted durable Companion turns as server-owned from the authenticated admission path, not from caller parameters.
- In session_lifecycle._close_sessions_for_transport/_schedule_ws_orphan_reap, detach observation but do not interrupt such a turn because a phone disappeared.
- Retain existing independent execution-liveness protections. Server failure settles through the durable ledger; it must not manufacture a successful result.
- Do not change unrelated close_on_disconnect sidecar behavior globally.

5. Complete logout and late-result suppression

Use one revokeOwnerSession() implementation for explicit logout, confirmed revocation and local token-forget safety.

Required ordering:

1. Synchronously block new operations; increment identity/connection/session epochs.
2. Detach event/state listeners; close exact active and pending sockets.
3. Abort all catalog, preview and download controllers.
4. Clear identity-scoped memory and hide private UI immediately.
5. Attempt both native ownerSignOut() and secrets.revoke('gateway-token'), independently.
6. Clear persisted identity-scoped drafts, retry receipts, pins and navigation/scroll caches.
7. Report any cleanup failure without reopening authority.

Do not use Promise.allSettled to race credential deletion against resource invalidation. It is appropriate only after the synchronous security barrier.

Clear:
- Every private CompanionSnapshot field.
- profileIds, canonicalSessions, pendingSubmit, pendingInterrupt, interruptedTurn, completedSessionId, persistedContinuationTarget and activeDraftIdentity.
- savedToken and pending hydration eligibility.
- Work/Directory caches and their profile/selection metadata.
- Library profiles/list/detail/preview/errors, chunk buffers and object URLs.
- transcript scroll map, component refs and private navigation parameters.

Use a native-persisted opaque cache scope, rotated on explicit identity replacement, to namespace restart-surviving drafts and receipts. Hydrate only after the native credential scope is confirmed. Do not put owner identifiers, credentials or draft text in URLs. Legacy unscoped caches must not be automatically imported into a new identity.

SessionSecretStore.revoke must prevent stale get/set completion from restoring a revoked credential. Serialize native mutations; make failed deletion retryable. A permanently cached failed revocation promise is not a cleanup retry mechanism.

Native owner sign-out is currently local on both Android and Electron. Preserve that contract: it does not log out the system browser or revoke other devices. Server-side owner revocation is a separate event. Do not describe a local bridge error as “remote sign-out failed.”

For downloads/previews:
- Pass AbortSignal separately from RPC params through LibraryGateway → CompanionClient → shared request().
- Capture one client/identity epoch for the entire transfer; never switch gateways between chunks.
- Check cancellation after every await, including digest verification, and immediately before Blob creation, state publication or anchor.click().
- Abort on logout, disconnect, selection replacement and unmount.
- Remove partial bytes/object URLs; do not auto-restart or switch retained evidence to Latest.
- Files already deliberately exported to Android/another application are outside revocation’s reach.

6. Exact freshness contract

Define freshness as age of successfully committed authoritative data, not time since a trigger.

Track per backend/profile/catalog/query:
- oldest request-start time contributing to the committed snapshot;
- completion time;
- coverage;
- in-flight generation;
- error/unsupported state.

Use an injected monotonic clock. Persisted timestamps do not establish freshness after process restart. On resume, invalidate/recheck rather than assuming a suspended timer ran.

For a committed snapshot whose conservative observation origin is t:

- t + 29,999 ms: age-valid.
- t + 30,000 ms: age-valid, inclusively.
- t + 30,001 ms: stale.

Refreshing does not change t. Completion may commit a new origin only after validated data is applied. A fulfilled promise containing failed/partial source results is not full success.

Scheduling:
- Refresh immediately on initial connection, foreground and explicit refresh.
- Start the next read by 15 seconds after the prior observation origin.
- Give each complete source/query refresh a 15-second budget.
- This meets the ≤30-second target when the backend, transport and foreground scheduler satisfy that budget.
- At timeout, abort that read generation, release its single-flight slot and report slow/unverified data. Do not keep it globally in flight indefinitely.
- Late responses cannot commit, clear newer errors or reset timestamps.
- Other sources continue independently.

At 30,000 ms the old snapshot can still be age-valid while health reports slow/error. At 30,001 ms it must visibly be stale. Do not confuse temporal age with healthy connection or complete coverage.

Library needs a store-owned, awaited refresh operation, not refreshToken. Explicit refresh returns structured per-source results and completes only after data commits or a bounded failure. Repeated requests coalesce; a manual refresh arriving during an older request queues at most one follow-up observation.

For paginated results, the oldest contributing observation controls age. Preserve truthful coverage and loaded history/anchors. Never claim an entire collection fresh from its first page.

7. Implementation and acceptance order

A. Security prerequisite
Resolve the remote legacy privilege boundary below; write deny tests before exposing new operations.

B. Resource and identity lifetime
Implement generation guards, signal propagation, actual revoke() wiring, retryable cleanup and cache reset tests.

C. Observation and server lifetime
Implement read-only reconnect status; retain receipts; protect admitted runs from phone-disconnect reaping.

D. Production lifecycle/UI
Wire native/DOM signals and remove reconnect-induced remount, route restoration and focus jumps.

E. Freshness
Implement independent awaited refresh results, exact age predicates and bounded slow-refresh behavior.

Required host tests:

- app.test.tsx: hidden → socket close → foreground/online; identical route, selected target, draft, scroll anchor and focused element; one reconnect; zero create/resume/submit/approval.
- companion-store.test.ts: logout/reconnect/configure races at every deferred boundary; stale digest/history/ticket/token hydration; no post-logout RPC dispatch or data publication.
- connection.test.ts and owner-auth.test.ts: actual store/socket cleanup ordering, double logout, failed cleanup then retry.
- secret-store/native-secret-store tests: revoke invoked, stale set/get suppressed, encrypted deletion failure, restart isolation.
- library.test.tsx and companion-client.test.ts: revocation during capabilities, each chunk, digest and final export; no partial export or cross-generation continuation.
- directory-refresh.test.ts: separate 29,999/30,000/30,001 assertions; slow/hung source, timeout release, late results, partial coverage, independent catalogs and awaited manual refresh.
- Existing P1/P3/P5/P6 suites remain mandatory.
- Add real WebSocket tests through production admission, dispatch, send queue and teardown: missing/shared/non-owner/expired/revoked leases; generic bypass attempts; revocation while a frame/chunk is queued; disconnect beyond orphan grace; second-client reconciliation with one admitted run.
- Retain test_companion_transport_integration.py as stdio evidence, not WebSocket evidence.
- Preserve test_companion_backup_restore.py::test_ac33_full_companion_state_survives_isolated_backup_restore and the Work digest deduplication test. Restore into isolation only.
- Required backend capabilities missing → “Wymagana aktualizacja”; no blank-session fallback.

Physical gates remain explicit:
- Samsung background/foreground, network/Tailscale loss, Activity recreation and process death.
- Keystore restart/update/key invalidation and backup exclusion.
- Back/IME/keyboard/focus/scroll.
- Download/open/share for every retained P6 manifest entry.
- Mac Companion packaged lifecycle/auth regression and Desktop same-session compatibility.

A disconnected phone blocks only those physical checks. No Firebase or new paid push service. No push after process termination must be disclosed separately from continued server execution.

8. Exact unresolved decision

The current shared gateway exposes generic privileged RPCs to legacy-token transports. It cannot distinguish a legitimate legacy Desktop request from the same request sent by a modified Companion. Client flags or new RPC names are not a security boundary.

Before implementation approval, settle one of these server-enforced contracts:

- Require current owner authorization for all remote privileged generic RPCs, with an explicit Desktop/shared-client migration; retain trusted local stdio separately.
- Introduce a server-issued, non-forgeable trusted-client capability with explicit privileges and revocation, and prove that ordinary shared/agent tokens cannot obtain or bypass it.

Specify the affected remote methods and compatibility behavior, including create/resume/submit, Stop, approval pending/respond, pinning, attention, event replay and outgoing streams. Merely securing the new Companion Stop/approval names does not satisfy the requirement.

Until this is settled, claiming both “owner-only on every privileged call” and “unchanged legacy remote Desktop authorization” would hide an unresolved contradiction.

REQUEST_REDESIGN
