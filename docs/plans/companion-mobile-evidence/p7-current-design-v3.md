# P7 final design-v3 — immutable implementation contract

Repository: /Users/atlasweber/hermes-companion
Audited branch: feature/hermes-companion
Audited HEAD: 15bb315df34945a2097876053e49aae0c77a9b69
Basis: actual working-tree files, including existing modified/untracked Companion work; NOT HEAD alone.
Status: design approved for implementation, not implementation acceptance or release approval.

This document supersedes /tmp/p7-current-design-v2.md. Its normative decisions are closed. Implement against this version; a change to authority, target identity, compatibility, transaction semantics, or freshness requires a separately reviewed successor, not an in-place reinterpretation. “Immutable” means a frozen design contract, not a filesystem permission change.

## 1. Authority, evidence and audit limits

Governing inputs, in descending priority:

1. The explicit fixed decision in docs/plans/companion-mobile-evidence/p7-security-boundary-decision.md: all remote privileged RPCs require current server-issued owner authorization bound to profile and transport; shared credentials confer no privilege; retain trusted local stdio; migrate remote Desktop in the same candidate; no partial rollout.
2. docs/plans/2026-09-09-companion-mobile-continuity-implementation.md:273–285 (P7), with P8:287–298 governing candidate/release acceptance. P7 includes open-stream/download revocation, Android foreground recovery without focus jumps, truthful 30-second catalog freshness, unsupported-backend behavior, isolated backup/restore, idempotent notifications, and Mac Companion/Desktop regression.
3. Current code and the v2 findings. Where this document changes v2, this document wins.

Read-only audit: no repository file, configuration, credential, service, or git state was changed. Only the requested /tmp artifact was written. git diff --check returned success. The working tree was already dirty; a clean-tree claim would be false. No builds or test suites were run. Python inventory execution was blocked by the execution tool's single-query approval policy; inventory below was traced from registration source, including generated registrations. No approval configuration was changed or execution restriction bypassed. Runtime registry equality and all tests below are implementation acceptance requirements, not fabricated audit results.

Reference SHA-256 values obtained with shasum:

- v2: 45143a0f51138f773ee34a28749a3bf61d67d83eb6038adaa8dbc5290c161349
- boundary decision: d67d3943506e898e85a3f537c09494ca79322ddb0524e19f4d9ab26bdc7d7fc1
- authoritative implementation plan: 36e0fc9cd2c79ea679ae4f878aae3c6bca3428127989b199debdd4461df06ac6
- tui_gateway/server.py: 3309b8eca09159ac036f61157202c12bf2b6c50bdf8da2e1e25072f0042aea39
- tui_gateway/ws.py: b5a18b67c39c5baa8ed29e69f735074e681852d548b957f2829eea014f4f5dab
- hermes_cli/dashboard_auth/ws_tickets.py: 994068e3e911a0b40e32a1c2152d60a6385ccaaad1d6897d02127707df69c5ea
- apps/desktop/electron/main.ts: 7b5bd8848737a3231b3f2d7256a12ed0b8f424242a7474ea4f9ad658cc642ca3
- apps/companion/src/state/companion-store.ts: 2d9f6b55df636957a084d3cbb1b8cec8156ad3fa6255b712f744a9c53567abc5

These identify critical inputs, not a hash of the entire dirty checkout. Recheck source drift before implementing; do not discard the existing work.

## 2. Findings that determine the design

- server.py:735–809 registers naked handlers; handle_request invokes them without a privilege policy. dispatch binds a transport, copies context into the worker pool, and otherwise defaults to _stdio_transport. This is the correct shared dispatch seam, but “no context means trusted” is unsafe for remote adapters.
- method_ctx.py:62–69 installs rebound functions directly into server._methods. Companion register functions also assign directly. companion_sessions.continue_session calls _methods['session.resume'] and _methods['prompt.submit'] directly. A check only in ws.handle_ws or only on new Companion names is bypassable by nested dispatch.
- ws_tickets.OwnerAuthorizationLease currently contains identity, expiry and generation only. It is not bound to a backend/profile set or particular transport. Current ticket identity metadata is narrowed in web_server_chat._stamp_identity before the web_server._ws_auth_reason_with_owner_lease facade issues the lease.
- WSTransport._safe_send_many checks only _closed. Buffered tokens, already scheduled batches, worker replies, replay, and unsolicited events do not receive live owner/profile checks. close does not clear the token buffer.
- Remote Desktop already has native PKCE, access-token refresh, cookie login, ticket minting, and freshGatewayWsUrl. It still uses static token URLs outside authMode='oauth'; mintGatewayWsTicket catches native refresh failures as null and can select cookies. The migration is concrete, not a greenfield login project.
- Desktop useGatewayRequest retries arbitrary failed RPCs after reconnect. Stop call sites include resume-and-retry behavior; native notifications and approval components can omit request identity. These must migrate with server enforcement.
- methods_prompt._approval_respond_session_fallback searches all live sessions by request ID; approval.respond accepts all/default choice. session.interrupt stops process-global TTS before target validation.
- companion-store.signOutOwner switches to shared mode and clears only part of state; it does not revoke the saved shared token. Helper revocation functions are not sufficient production wiring.
- Library downloadOriginal/allChunks uses JSON-RPC chunks and a post-transfer async digest, not a fetch stream. Cancellation must reach the actual shared request path and guard the digest/export boundary.
- directory-refresh currently uses one Promise.allSettled, completion-time Date.now, a fixed interval, and a void Library refresh. That cannot prove per-source authoritative freshness.
- session_lifecycle._schedule_ws_orphan_reap can interrupt running work after a phone disappears when activity is absent/stale. A background thread alone does not establish execution independence.

## 3. Exact method classification and inventory

### 3.1 Classes and normative rule

S = non-privileged, sanitized protocol read. Accepted on an authenticated shared-token transport or an owner transport. No business/private data, resource access, state mutation, or delegated execution. Missing upgrade credentials are still rejected. S is NOT anonymous access.

O = owner-privileged remote operation. Includes confidential reads as well as mutations. Every invocation requires the gate in section 4. “Read-only” does not mean non-privileged. Existing finer-grained ownership, billing, human approval, expected-version and integrity controls remain additional checks.

L = trusted local stdio exemption from the NEW central remote gate only. It preserves existing handler behavior; it does not manufacture a human owner lease for Companion/Work handlers that already require one.

D = unknown/unclassified method: unavailable remotely, including to owners. An unregistered method returns -32601. A registered method with missing policy is a startup/CI failure and fails closed if encountered at runtime. No name-prefix, suffix such as '.get', client type, or params.action inference grants privilege.

The entire S allowlist is exactly:

- ping: {pong:true}.
- gateway.capabilities: build/protocol enforcement booleans and version values only. Preserve per_session_exclusive_submit. Add the section 5 capability fields; do not include profile lists, paths, identities, tokens, session state, tool configuration or environment.

All other existing RPCs listed below are O, even their capability/list/read variants. Shared-token clients retain only the two safe protocol reads and sanitized handshake/error frames. This deliberately small compatibility surface resolves ambiguous “read-only” exemptions instead of promising legacy private reads.

In the inventory, prefix.{a,b.c} is exact finite expansion into prefix.a and prefix.b.c; it is not a runtime wildcard. Module paths are relative to tui_gateway unless specified. The implemented manifest must store expanded exact strings.

### 3.2 Existing O inventory

methods_session.py:

- session.{create,list,most_recent,resume,cwd.set,workspace.move,active_list,activate,delete,title,set_hidden,set_pinned,usage,context_breakdown,status,history,undo,compress,save,close,branch,interrupt,steer,redirect,events.since,events.stats}
- project.facts; verification.status; attention.list; message.react; llm.oneshot
- handoff.{request,state,fail}
- pet.{info,info.meta,cells,gallery,select,remove,export,rename,thumb,disable,scale,cancel,generate.status,generate,hatch}
- billing.{state,charge,charge_status,auto_reload,step_up}; usage.bars
- subscription.{state,preview,change,resume,upgrade}
- delegation.{status,pause}; subagent.{interrupt,steer}; spawn_tree.{save,list,load}; terminal.resize

The billing view/route factories and _correction_method registrations are included, not just @method literals.

methods_prompt.py:

- prompt.{submit,background,btw}; clipboard.paste; image.{attach,attach_bytes,detach}; pdf.attach; file.attach; input.detect_drop; preview.restart
- clarify.respond; terminal.read.respond; preview.read.respond; preview.act.respond; window.read.respond; tour.respond; mcp.setup.respond; sudo.respond; secret.respond
- approval.{pending,received,respond}

methods_session_control.py: session.control.read; session.control. Every action carried by session.control remains O, including goal/loop/subgoal/heartbeat actions. It is not a set of separately registered goal.* RPCs.

methods_session_foreign.py: session.foreign.{list,preview,import}.

methods_projects.py: projects.{list,get,create,archive,delete,set_active,for_cwd,update,add_folder,remove_folder,set_primary}. Include _register_project_mutator expansions.

methods_config.py: projects.{discover_repos,record_repos,tree,project_sessions}; config.get; setup.{status,runtime_check}; diagnostics.share_nous.

methods_config_set.py: config.set. All keys/actions remain O, including approval and yolo settings. The gate is not a replacement for explicit business/human safety policy.

methods_profiles.py: profiles.{list,create,describe,configure,set_asset,get_asset}.

methods_complete.py: paste.collapse; complete.{path,slash}; model.{options,save_key,disconnect}.

methods_images.py: image.generate.

methods_voice.py, excluding S above: wake.{start,stop,pause,resume,status,feed}; voice.{toggle,record,tts}.

methods_browser_control.py: browser.controller.{register,result,heartbeat,detach}. Retain controller principal/scope checks in addition to owner authorization. A server-internal identity alone does not become an owner.

methods_tools.py:

- system.battery; process.{stop,kill}; reload.{env,mcp}
- plugins.{list,manage}; tools.{list,show,configure}; toolsets.list; agents.list
- commands.catalog; cli.exec; command.{resolve,dispatch}; slash.exec; shell.exec
- insights.get; rollback.{list,restore,diff}; browser.manage; config.show; cron.manage
- learning.{frames,detail,delete,edit}; skills.{manage,reload}; mcp.catalog
- mcp.servers.{list,status,add,set_api_key,test,remove,oauth.start,oauth.poll,oauth.callback}

The _SIMPLE_RPCS, learning factory, and _mcp_rpc expansions are included. Mixed-action cron/skills/plugins/browser management and slash/CLI/shell dispatch are wholly O; requesting a read-looking action cannot enter through S and subsequently execute a mutation.

methods_bot_relay.py: bot_relay.{roster.sync,outbox.drain,deliver,reply}.

methods_groups.py: groups.{capabilities,list,create,state,send,rename,log,disband,replicate,replica_state,promote,demote,stop,retry,approve,peer.invite,peer.revoke,peer.register}. This module IS installed indirectly by methods_bot_relay.register:164–173; absence from server.py's direct import list is not absence from the surface.

methods_work.py, expanded from hermes_cli/companion_work.py:FIELDS:

- work.{capabilities,list,get,upsert,propose,comment,decide,complete,preparation.list,preparation.ack,digest,digest.ack}

Agent/CLI Work producer APIs keep their current local application boundary. They must not acquire human decision authority merely because local stdio bypasses the new remote gate. In particular work.decide's current owner check stays.

methods_companion_sessions.py:

- companion.capabilities
- companion.sessions.{list,history,continue,reconcile}

reconcile is privileged and not classified as strictly pure: current _v3_result(reconcile_dead=True) may settle dead-executor ledger state. It never grants permission to resubmit.

methods_companion_projects.py: companion.projects.{list,get}.

methods_companion_library.py: companion.library.{capabilities,profiles,resolve,list,get,preview,download,pin_reviewed}. Both chunk access methods are privileged reads; pin_reviewed is a mutation with immutable version identity.

methods_companion_topics.py: companion.topics.{capabilities,list,get}.

methods_companion_organization.py and companion_organization_mutations.capability:

- companion.organization.{capabilities,needs_me}
- companion.topics.{create,update,set_lifecycle}
- companion.bindings.{upsert,remove}
- companion.priorities.{override_set,restore_recommended}
- companion.business_projects.{create,update,set_lifecycle}
- companion.source_projects.{upsert,create,update,remove}
- companion.source_sessions.{upsert,create,update,remove}
- companion.captures.create

methods_browser.py, methods_slash.py and methods_complete_helpers.py provide helpers; a helper's name is not an extra public RPC. Exposure through command.dispatch/slash.exec remains O.

### 3.3 New O RPCs, fixed names

Add in methods_companion_sessions.py, backed by companion_sessions.py and the new exact-control service described below:

- companion.sessions.observe
- companion.sessions.stop
- companion.sessions.approval.respond

No second new approval-pending RPC is needed: observe returns a scoped snapshot of pending approval identities; generic approval.pending also gets the same identity fields for Desktop.

All corresponding replies, replay entries, errors containing private details, tool/browser/approval requests, token/reasoning/status/completion events, Library chunks and notification payloads are privileged frames. The only non-privileged outbound application frames are explicit sanitized gateway.ready, S replies, and generic non-sensitive protocol/auth errors. Do not classify a frame as safe merely because it lacks session_id.

### 3.4 Inventory enforcement

Create tui_gateway/rpc_policy.py (new): MethodPolicy, METHOD_POLICY, SHARED_READ_METHODS, authorize_rpc, authorize_frame, authorize_commit. Use literal expanded method names and explicit scope metadata. Add test_rpc_policy_inventory.py (new): import the real server under isolated test home, compare the exact registered keys with the manifest, report both missing and extra keys, reject duplicate registration, and assert S equals the allowlist above. Include direct Companion assignments and indirect groups installation. Do not give a new plugin RPC owner access by default; it needs a reviewed manifest entry. Freeze the manifest after registration. Future changes to the inventory are reviewable policy changes.

## 4. Central server gate and scope

### 4.1 Placement and non-bypassability

Use one policy implementation, not independent WS/Companion/Desktop policies:

1. server.handle_request normalizes the request and invokes authorize_rpc BEFORE invoking a handler. dispatch performs cheap admission before queueing a long handler; handle_request checks again when that worker actually starts. Context is copied, but authorization validity is not cached in the copy.
2. Wrap every installed entry in server._methods with the same authorize_rpc entry guard, OUTSIDE profile-scoped wrappers. This covers direct nested _methods calls. Update server.method, method_ctx.HandlerRegistry.install and the direct Companion/work registrars to call new server.register_rpc(name, handler). Keep the raw callable private to registration, never returned from the public registry. Existing direct calls continue to hit guarded callables. Do not rely on a final one-time wrapping pass that later registration bypasses.
3. Dispatch's repeated validation is intentional. A ContextVar can hold an immutable transport/request context, not an 'already-authorized forever' boolean. Every nested call re-evaluates the current lease and its target. Long initialization waits, lock waits and authorization-sensitive commits need authorize_commit as described below.
4. Binding an absent transport never establishes local trust inside handle_request. The actual tui_gateway.entry stdio entry supplies the server-owned trusted context. Preserve dispatch(req) for that entry by explicitly binding the canonical local capability at entry/bootstrap; arbitrary remote adapters must pass a remote context and transport. Direct handle_request without context fails closed for O; update unit fixtures to select local or remote explicitly.
5. A public boolean, Python object's chosen attribute name, loopback peer address, Tailscale host, Origin, Desktop header, profile parameter, server-internal identity string, or shared token is not a local exemption. Trust is a private registered transport/context capability established by the local entry, not structural isinstance/duck typing supplied by a request.
6. Local TeeTransport retains local input semantics only when its originating input really is trusted stdio. Remote secondary output is independently gated. A remote WebSocket tunneled/proxied into stdio must retain its remote context; never launder it into the local capability.

Local preservation means generic CLI create/resume/submit/interrupt/approvals continue under their existing local contract. Do not convert trusted stdio into an owner or remove handler-local checks that historically prohibit agent decision-making.

### 4.2 Lease and admission data

Extend ws_tickets.OwnerAuthorizationLease with immutable, server-only fields:

- lease_id, human_identity, identity_generation
- backend_namespace and launch_profile
- authorized_profiles: frozenset of canonical served profile names
- permitted endpoint/transport family, transport_id (bound on consumption, not supplied by JSON)
- monotonic expires_at and admission policy generation

Keep a server registry of issued leases and active transport bindings. A reconstructed dataclass with matching strings is not accepted unless it is the issued object/binding in that registry. A lease copied to another transport, backend or server process is invalid. The registry is process-local; a server restart invalidates tickets and leases. Multiprocess deployment must route mint/consume to the same authority process or implement one shared revocation authority; do not deploy separate uncoordinated registries.

POST /api/auth/ws-ticket accepts a versioned body containing requested canonical profile(s) and audience. These are requests for scope, never authority. Server derives the verified identity from the authenticated native bearer/cookie, checks current launch-owner policy with fail_closed=True, intersects requested profiles with the explicitly served profile set, and rejects any requested unauthorized profile (no silent partial grant). Empty legacy body defaults to the authenticated route's resolved launch profile and /api/ws audience, not all profiles. New Companion may explicitly request served-profile scope for its cross-profile catalogs; Desktop requests the connection's resolved profile. Server permits the broader Companion set only when the same owner is authorized for each served target.

Ticket records retain the scope and generation through consume_ticket; do not drop it in _stamp_identity. _ws_auth_reason_with_owner_lease and the route adapter create/bind a single lease after validating audience/backend/profile routing. Preserve the 30-second one-use admission ticket and 300-second maximum owner lease. Ticket validity uses server monotonic elapsed time with expiry at >= deadline; do not confuse its exclusive security deadline with catalog freshness's inclusive bound.

An authenticated non-owner may receive an auth failure but never an owner lease. Shared, missing and internal credentials cannot call ticket mint successfully as an owner. No ticket value/prefix may appear in errors or logs; remove the current unknown-ticket prefix disclosure. Prefer the existing ticket-subprotocol route where supported; a ticket URL retained for compatible clients remains ephemeral and redacted. Main/native storage holds access/refresh credentials; React state, logs, localStorage and navigation do not.

### 4.3 Per-request scope resolution

Authorize against policy loaded from the immutable launch-home path captured at bootstrap, not get_hermes_home after request profile scoping. Current owner policy and served-profile policy must parse from current bytes with fail-closed semantics, never general config's last-known-good fallback.

Every O invocation resolves an authorization scope before data access:

- Profile-scoped methods: explicit profile must be canonical and in lease.authorized_profiles AND the current served set. If omitted, use the transport's negotiated default profile, not ambient active UI/profile globals. An explicit unknown/empty/malformed profile is rejected, not normalized into default.
- Runtime/session methods: lookup a candidate only to resolve canonical backend/profile; then verify authority before returning anything. Any explicit profile/backend must equal the stored target. Capture the live record object/generation; runtime ID alone is not authority. Revalidate after waits.
- Stored lineage methods: exact backend_namespace/profile/stored_session_id; compression lineage resolution cannot cross profile or fork boundary. IDs from another profile must produce a non-enumerating refusal.
- Catalog/list/attention/profile enumeration: filter and query only the intersection of granted/current profiles. A request for one profile cannot aggregate a sibling accidentally. Each emitted row/frame carries server-derived scope. Requests explicitly naming an unauthorized profile fail instead of probing it.
- Cross-profile bindings: validate every referenced source namespace/profile as well as the mutation target before resolving paths or opening stores. Never authorize only the target while leaking another source.
- Launch/global administration (process.stop, reloads, shared provider/billing state and similar genuinely process-wide handlers): explicit policy scope is launch administration. Require current launch-owner authorization and a lease including launch_profile. Do not treat owner-of-one served profile as process administrator. Process-wide effects remain explicit administration actions, not session Stop. Preserve additional portal/billing scopes; owner authorization does not itself authorize charging.

MethodPolicy records scope resolver (profile/runtime/stored/cross-profile/launch) and operation semantics. Compound dispatch always carries the resolved context; it cannot switch backend/profile through arguments unnoticed. Private metadata/errors use the same scope. Global notifications go only to a lease authorized for their real scope, never every connected WS.

### 4.4 Transaction and authorization linearization

Entry authorization is necessary, not sufficient for a blocked mutation:

- Resolve and validate inputs; acquire the operation's ordinary target locks/DB transaction; revalidate live record, expected version and exact target; acquire the authority guard last; check current generation, monotonic expiry, owner policy and scope immediately before the short atomic mutation/admission; commit or enqueue that exact action; release authority/target locks.
- Revocation generation updates and authorize_commit use the same authority guard. Revocation does not hold it while waiting for a target lock or network I/O. No external I/O/model work runs under the guard. Do not introduce the opposite lock order in callbacks.
- Authorization-sensitive local durable transactions must roll back if the final check fails. A committed/admitted action ordered before revocation is not retroactively uncommitted. An action still waiting when revocation wins must not mutate.
- External/long-running effects have an explicit admission point and server-owned operation identity. Admission checks authority; execution after admission is independent of the observation socket. A follow-up client command requires a new live check. Do not keep using the expired RPC context to admit new commands later.
- Unknown commit outcome is never translated into 'not executed'. Durable operation/idempotency keys and read-back reconcile it. Reuse of a key with a different payload/target conflicts.

## 5. Desktop obtains, refreshes and uses owner tickets

Required capability metadata, exposed by the actual enforcing build:

- gateway.capabilities.remote_privilege_policy = 'owner-ticket-v1'
- gateway.capabilities.owner_lease_seconds = 300
- gateway.capabilities.exact_session_control = 1
- gateway.capabilities.companion_observe = 1

Advertise these only when central ingress/egress gates and exact-control services are active. /api/status must advertise the corresponding protocol/auth requirement for pre-connection Desktop setup without exposing private data. Owner auth is not inferred from the old authMode label.

Desktop implementation, in apps/desktop/electron/main.ts:

1. probeRemoteAuthMode/connection setup records the new requirement. A saved remote token configuration is a migration-required state. It may perform S discovery; it may not become a usable private gateway. Prompt one explicit owner sign-in using the existing hermes:connection-config:oauth-login path. Shared token is not exchanged for an owner credential.
2. Use existing runNativeLogin PKCE/system-browser flow when supported. Preserve the already-supported password-provider embedded cookie login where applicable; it must still result in a server-verified owner. Do not add new credentials, providers or basic auth as part of this audit/design.
3. ensureNativeAccessToken refreshes with /auth/native/refresh. Add a per-canonical-backend single-flight refresh and auth generation so foreground/profile/popout requests cannot rotate one refresh token concurrently or restore tokens after logout. Serialize _storeNativeTokens/_clearNativeTokens against that generation.
4. mintGatewayWsTicket sends the requested profile/audience and uses the chosen native/cookie auth lane. Remove .catch(() => null) for native refresh: transient errors remain retryable without changing identity; explicit native refusal latches sign-in-required. Cookie use is allowed only when that was the chosen login lane or no native session was established, never as fallback after native failure/revocation.
5. freshGatewayWsUrl(profile) resolves ensureBackend(profile) first, mints one fresh ticket for that backend/profile before EVERY WS open, remembers only necessary scoped headers, and never returns a cached shared-token URL for a privileged remote connection. A failed owner mint never calls the token branch.
6. apps/shared/src/websocket-url.ts:resolveGatewayWsUrl must recognize the required privilege protocol even if an old connection object says token. No cached-URL fallback for owner-required remote connections. Initial boot, pooled profiles, soft switches, reconnect, sleep/wake, popouts and voice sockets all use it.
7. Receive an owner lease deadline as a relative duration in the authenticated handshake. Schedule foreground renewal 30 seconds before expiry; coalesce mint/open per connection. Background/closed sockets mint on return. Each connection uses a distinct one-shot ticket. Establish replacement, negotiate and reobserve, switch generation, then close old observation. Overlapping sockets may receive duplicate observations; watermarks/generations suppress duplicate presentation. Do not transfer a lease to the new socket.
8. Renewing observation never submits, creates or resumes a session implicitly. Desktop restoration that currently calls session.resume must be separated into explicit user activation versus lease-renewal observation. Use observe/history/replay identities. No refresh-triggered automatic continuation of crash markers.
9. Explicit revocation/wrong-owner/malformed policy closes connections and clears identity-scoped UI; do not silently restart native login. Expiry may attempt a fresh ticket with the same valid native session. Network failures use bounded retry and retain encrypted credentials.
10. Logout invalidates the native generation and every socket for that backend before clearing native and cookie credentials. A late login/refresh/mint result cannot store credentials or connect. Keep local sign-out and cross-device server revocation distinct.

Known call paths requiring same-candidate changes/tests:

- apps/desktop/src/store/gateway.ts (including pooled connection acquisition)
- apps/desktop/src/app/gateway/hooks/use-gateway-request.ts:useGatewayRequest/requestGateway/ensureGatewayOpen
- apps/desktop/src/lib/voice-playback.ts
- apps/desktop/src/store/session-states.ts:requestForOwnedSession and runtime ownership routing
- apps/desktop/src/store/native-notifications.ts
- apps/desktop/src/components/assistant-ui/tool/approval.tsx
- apps/desktop/src/app/session/hooks/use-prompt-actions/{index,slash,rewind}.ts or .tsx as currently present (index.ts is the existing hook entry)
- apps/desktop/src/app/chat/session-tile-actions.ts
- apps/desktop/src/plugins/hermes-bots/{group-rounds,group-turns}.ts

requestGateway must not transparently replay mutations after a transport failure. Use explicit method retry metadata from the shared protocol: only documented observational reads retry automatically. Submit retries require the SAME durable client_request_id and a reconciliation contract; Stop, approval, Work decisions, pins and administration do not auto-repeat. Remove remote Stop's session.resume-and-retry path and ambient-gateway fallback for unknown approval targets. Notification handlers need exact recorded target/request identity; otherwise open the authoritative view without deciding.

Local Desktop over TCP/WebSocket, even on 127.0.0.1, is not trusted stdio. It must use owner tickets too, or an actual private local stdio adapter retaining the original local boundary. This candidate chooses owner tickets for Desktop WebSocket connections; no loopback exemption. Existing genuine local CLI stdio remains unchanged. Owner-unconfigured local WS deployments show setup-required for private features; they are not silently granted owner status.

## 6. Other remote adapters and no privilege laundering

The same candidate must cover more than /api/ws:

- hermes_cli/web_routers/chat_ws.py:gateway_ws passes the issued binding into WSTransport; never permits implicit stdio dispatch.
- /api/events and its broadcaster are privileged output. Bind subscribers to owner lease, backend/profile and exact channel authorization; gate every queued frame at send. Channel knowledge is not authority.
- /api/pub is not an owner RPC alternative. The current process-lifetime internal credential must not be allowed to publish arbitrary frames into an owner channel. Restrict server-produced sidecar publication to a server-created exact producer/channel binding and validate scope/schema; no remote shared-token publication. It cannot invoke RPCs or grant owner authority.
- /api/pty is a remote execution/input and private-output path, even if the child uses stdio. Require a current owner-bound outer connection before creation/attachment and on subsequent input/output; invalidate attachment on expiry/revocation. Do not hand the child a process-lifetime credential granting arbitrary /api/ws RPCs. If an embedded remote TUI proxies RPCs, the parent must retain/validate the real owner context at every forwarded RPC, and child output must pass the outer gate. Direct local CLI stdio is unaffected.
- An unsupported remote embedded/sidecar mode must fail closed with update-required, not fall back to a legacy token/internal URL. Candidate acceptance includes the used Dashboard/Desktop bridge modes; disabling a used compatibility path is a failed gate, not a shipped workaround.
- Any HTTP/IPC route that calls server.dispatch/handle_request must create an explicit current remote owner context from verified credentials. Direct calls without context fail closed. Private REST download/preview aliases must independently verify current owner/scope at each request/send; working WS auth is not proof of REST auth. No shared-token REST alias may reach the same privileged control/Library data as a bypass.

Trusted server execution after authenticated admission is distinct from a remote client. Internal producers may persist their already-authorized job outputs through typed application services, never impersonate a human decision RPC with a magic internal identity. New external Work decisions/tool approvals still need the owner boundary.

## 7. Outbound revocation and expiry

Extend ws.py:WSTransport.write, write_async, _flush_tokens, _safe_send_many and close. Retain structured frame envelopes until send, with server-derived classification, backend/profile/session/operation scope and transport generation; do not keep only pre-serialized unlabelled strings in _pending_tokens.

Required send algorithm:

1. Admission/enqueue rejects a closed/revoked transport and out-of-scope private frame.
2. After acquiring _send_lock, and immediately before EACH application frame handoff, authorize_frame checks registry binding, current generation, exact profile scope, owner policy and monotonic expiry. A batch check once before an await is insufficient.
3. Every scheduled batch carries its generation. Moving a batch out of _pending_tokens does not exempt it. Keep task/future ownership so revocation can invalidate queued and in-progress sends, cancel flush timers and dispose buffered payloads.
4. Revocation synchronously increments the authority generation under its guard and invalidates matching transport send fences; notify the owning loops for closure and cleanup without holding target locks. Expiry has an independent timer and a per-send clock check, so a delayed timer cannot extend authorization. Current policy is also checked on every private send; policy changes cannot depend on an incoming RPC to become effective.
5. At the revocation linearization point no new private send can begin. Cancel pending transport sends and discard application queues; a send that has already handed bytes to the underlying network cannot be recalled. Do not claim that retracting React text retracts delivered data. Verify the real ASGI/WebSocket adapter's cancellation behavior; unflushed application payloads must not drain after closure. A library that retains queued application frames after cancellation must have its queue discarded/connection aborted at that lower adapter before acceptance.
6. close clears token buffers, cancels token/expiry timers, invalidates outstanding batches and unregisters revocation callbacks. It detaches observers; it does not stop an admitted server-owned turn.

Sanitized close reasons: owner_lease_expired (renewal eligible) versus owner_revoked/owner_forbidden (explicit reauthentication needed). Use existing 4403 for authorization denial and 4401 for lease/auth expiry, with stable reason fields; do not put identity, ticket, config bytes or private target details into close/error text. Propagate typed reasons through CompanionClient/shared connection state instead of collapsing everything to 'closed'. Shared transports never receive private unsolicited gateway-ready/session/model events.

Read/data authorization can be revoked while a slow handler reads. Its result is rechecked at egress and dropped; authorization failure must not leak private handler exception details. Already admitted server work can finish and persist data while no authorized observer is connected.

## 8. Exact-target observation, Stop and approval

### 8.1 Identity and observation contract

Use this canonical target tuple, never display names:

- backend_namespace
- profile
- stored_session_id (the requested durable ID)
- lineage_root_id (server-resolved compression lineage; forks remain separate)
- execution_id (opaque server-issued ID for ONE admitted turn)
- execution_generation (monotonic within that lineage)

runtime_session_id is an optional routing hint, not a replacement for the durable/execution tuple. Existing TurnClaim.operation_id and generation provide the execution identity for v3 turns. Never expose executor_token/PID authority as client credentials. For a legacy live turn lacking a v3 claim, assign a process-instance-scoped opaque execution ID plus generation under its admission lock before exposing control; do not derive it from a runtime ID or title. Unknown persisted legacy outcomes remain unknown, not controllable guessed runs.

companion.sessions.observe params: exactly backend_namespace, profile, stored_session_id, and optional known_execution_id. It is a read-only snapshot: resolve lineage; return canonical target/current tip, active execution identity/status, runtime hint if live, history revision/replay epoch and watermark if available, and pending approvals with exact request identity. It does not create a runtime, resume, submit, mark a project active, acknowledge an approval or reconcile a dead executor by writing. Unknown/stale execution is a result state, not an instruction to act on the current replacement. Existing reconcile remains the durable receipt reconciliation method and may retain its explicitly classified ledger housekeeping.

Initial P7 observation uses bounded polling and canonical history, not an implicit subscription through session.resume. If replay is used, the snapshot watermark and replay epoch must be coherent; an epoch reset requires canonical re-read. A newly opened socket does not automatically receive a historical run's stream. Desktop-originated turns are observable without a Companion client_request_id.

### 8.2 Stop contract

companion.sessions.stop requires exact backend_namespace, profile, stored_session_id, execution_id, execution_generation and a client_control_id. No current-selection fallback and no automatic coercion of missing IDs. The server resolves the immutable lineage and compares the active execution under locks immediately before targeting cancellation.

Return one of: stop_requested (accepted signal, not terminal completion), already_terminal (same exact execution), or target_conflict/not_found. Never stop a replacement turn. Client_control_id is scoped to owner/backend/profile/execution and payload: duplicate same request returns the prior receipt; different target/payload conflicts. A timeout makes outcome uncertain; observe/reconcile before another deliberate user action. There is no timer-generated retry.

Generic session.interrupt on remote transports requires the SAME execution target fields (runtime_session_id/session_id remains a hint) and calls the same service. Trusted local stdio retains legacy argument behavior. expected_hosted_task_id is an additional predicate, not a substitute for backend/profile/execution identity.

Validate first, then perform only target-scoped interruption. Move _tts_stream_stop after validation and do not use its global behavior for remote session Stop: add a target-owned playback stop hook or let the requesting client silence its own playback. No unrelated process TTS interruption, kill_all, neighboring execution cancellation or automatic session.resume is allowed.

### 8.3 Approval contract

companion.sessions.approval.respond additionally requires request_id and choice, with optional bounded reason. The target tuple and execution identity are mandatory. Allowed choices for this narrow Companion method are 'once' and 'deny'; it must not create standing/session-wide permission. Generic remote approval.respond may preserve existing explicit 'session'/'always' policy choices only through its existing deliberate Desktop UI and normal policy checks; all choices are validated explicitly, and exact target/request identity is still mandatory. Missing choice is invalid. all/resolve_all is prohibited on remote approval RPCs.

Update approval.pending/received and emitted approval.request envelopes to include the execution target and unique request ID. ack is an exact-target mutation, not a harmless read. Remove _approval_respond_session_fallback from ALL remote paths. Never find a target by searching every live session for a request ID. A pending request is looked up only inside its validated execution. Expired, settled, duplicate, reused or mismatching requests cannot decide another waiter.

Create tui_gateway/session_control_authority.py (new), with observe_execution, stop_execution, respond_execution_approval and resolve_exact_execution. Use it from generic and Companion handlers. Extend tools/approval.py and tools/approval_gateway_wait.py so waiter records bind execution_id/generation at creation and resolution compares target+request under the existing approval lock. Do not implement pending-list -> unlock -> FIFO resolve; exact comparison and removal/resolution is one critical section. Existing approval denial/standing-policy semantics remain after that selection, not before it.

Lock contract: retain _session_resume_lock -> _sessions_lock for live map changes; take the target history/control lock before the approval queue lock; acquire the final authority guard last for short validation+decision/admission. Approval callbacks wake execution only after locks are released. No callback may take the reverse lock order. Stop/settlement must use the same execution fence, so a newly admitted generation cannot be cancelled by an older Stop.

### 8.4 Durable admission invariants

Keep companion_turns.claim_turn's transactional active lineage slot and generation. All submitting paths (Companion continue and Desktop generic prompt.submit) participate in the same exclusion/admission mechanism where they target a persisted lineage.

- Immutable request index key is owner/backend/profile/client_request_id; payload digest includes exact target and text. Reuse with different content conflicts.
- Indexed -> claimed -> admitted -> running -> terminal. Terminal set retains completed, failed, cancelled, not_admitted, interrupted_outcome_unknown. No transition from terminal back to running under the same operation.
- Existing separate index/claim transactions are not falsely described as atomic together. Crash between them leaves indexed/pending, never inferred rejection. Current _v3_result's intentional gap remains explicit.
- Claim and active-slot write are one DB transaction. Admission rechecks lineage tip, execution fence and live owner authority. Revocation before admission yields not_admitted if it is known no admission happened. A lost response after admission remains uncertain until read-back.
- Mark execution ownership server-owned at this admission point. Do not trust a caller-provided detached/server_owned flag. Durable receipt retains operation/generation independently of socket.
- In-memory execution wake and durable decision/cancellation receipt must have an explicit crash rule. For a crash between a durable control receipt and wake, do not replay an approval against a new runtime: reconcile the same execution or record outcome unknown. Never claim universal exactly-once external side effects.
- Work decisions/comments/priorities retain current expected_version/revision, actor-scoped idempotency and audit transaction. Evidence pinning retains exact retained version/digest, not 'Latest'. The owner check runs inside the commit boundary. Work approval still means preparation-only and is separate from a runtime tool approval.

## 9. Server execution does not depend on the phone

Update session_lifecycle._close_sessions_for_transport, _schedule_ws_orphan_reap, _rebind_live_transport, _interrupt_session_turn and prompt_turn admission/finalization paths.

On phone background, network loss, socket renewal, local sign-out, owner lease expiry or owner revocation:

- Remove that observation transport and cancel its resource/subscription tasks.
- Preserve any server-owned admitted execution and its active lineage slot, pending tool approval, durable receipt, executor heartbeat and finalization.
- Do not call Stop, deny approvals, retire active-turn markers, clear pending decisions, set running=False, pop the live executor or invoke disconnect-driven teardown on it.
- Orphan reaping may reclaim idle observation shells, not an admitted server-owned execution. Its exemption must be checked before both direct close_on_disconnect cleanup and the timer's stale-activity/forced-pop paths. Test the already-fired timer race as well as scheduling.
- Existing independent executor liveness/watchdog protection remains. Detect a genuinely dead executor by its durable identity/boot generation, not absence of the client or of a client heartbeat. Missing activity samples alone cannot let the WS orphan reaper kill admitted work.
- Terminal executor cleanup releases the matching active slot by execution/generation CAS, persists canonical outcome/history, then permits runtime reclamation. A stale finalizer cannot release another run's slot.

An explicit, currently authorized exact Stop is different from losing observation. Other existing ephemeral/local/sidecar lifecycle behavior is not globally disabled. Server failure does not promise resumption or success; dead/uncertain outcomes reconcile honestly. No Firebase/new paid push infrastructure; lack of push after process termination is independent of continued server execution. Phone disconnection pauses only device-dependent acceptance tests, not implementation or host verification.

## 10. Companion lifecycle and state invariants

Separate fields in companion-store.ts:

- lifecycle: foreground/background
- connectivity: offline/connecting/connected/reconnecting
- authorization: unknown/owner/shared-read-only/sign-in-required/revoking/cleanup-failed
- independent execution/turn state and selected navigation target
- identityEpoch, connectionGeneration, sessionGeneration, plus per-query read generations

Do not turn every connection transition into setup/recovery screen remount. app.tsx installs ONE production lifecycle coordinator through installGatewayConnectionLifecycle; replace its loadToken/connect(token) contract with store.suspend()/reconnectForeground(). Native GatewayTokenPlugin/MainActivity lifecycle feeds visibility-only events while retaining OwnerAppVisibility's OAuth handoff behavior. DOM visibility/focus/online/offline and native events coalesce. Handle initial state and late listener installation; destroy removes late registrations too.

Transitions:

- Background: stop scheduling, increment read/connection generations, abort previews/downloads, detach/close observation socket. Preserve same-owner selected route, draft, transcript anchor, follow/unread state. No mutation RPC.
- Foreground/online: invalidate freshness, one reconnect single-flight, obtain a fresh owner ticket through ownerWebSocketUrl, negotiate capabilities, reconcile retained operation receipt, observe exact durable target, read canonical history/status and refresh independent catalogs. Publish only if captured identity/client/selection still match.
- Network failure: abort reads, retain same-owner presentation and encrypted credentials, mark in-flight mutations uncertain, bounded retry only while foreground/online. No fallback to shared auth or blank Bot Chat.
- Auth refusal/revocation: synchronous barrier and cleanup in section 11. Lease expiry can renew same owner without resetting navigation. No ownerSignIn call automatically opens a browser.
- Destroy: stop callbacks/listeners/resources; do not delete persistent native credentials merely because React unmounted or the app closed.

reconnectForeground and manual observation recovery do NOT call configure/selectTeammate/resolveBotChat/session.create/session.resume/prompt.submit. Explicit user continuation still uses the authenticated continue operation. Preserve accepted operation receipts separately from 'uncertain submit retry'; clear them only after canonical terminal reconciliation. Do not synthesize a new client_request_id after a failed reconcile.

directory.attach/disconnect and work.attach must support transient reattachment without destructive selection/cache reset. Route restoration and scroll-to-zero run on actual navigation/identity replacement, not phase changes. Keep the conversation subtree and focused element mounted during an ordinary same-process reconnect. Process death has cold-start behavior; do not promise persistence of DOM focus across process recreation.

## 11. Cancellation, logout and cache/credential ordering

Production signOutOwner and forgetSavedToken must call one revokeOwnerSession path. A helper existing in isolation does not satisfy this design.

Synchronous barrier, BEFORE the first await:

1. Set authorization=revoking; block new reads/mutations/reconnect; increment identity, connection, selection and read generations.
2. Detach state/event listeners; close/invalidate exact active AND pending sockets, including a ticket/open in flight. Cancel scheduled reconnect/renewal/refresh timers and native pending operation generations.
3. Abort every registered catalog/read/preview/download; resources registered after the barrier are immediately cancelled.
4. Hide/clear private UI and in-memory identity state immediately. Do not switch to usable shared mode.

Then independently attempt native ownerSignOut and SessionSecretStore.revoke('gateway-token'); collect both failures rather than skipping one because the other failed. Clear durable identity-scoped drafts, receipts, navigation and transient review caches. Cleanup uses settled-result aggregation only AFTER the security barrier. Double logout coalesces while in flight. A failed cleanup promise is released for a later retry; authorization remains blocked until cleanup succeeds or a deliberate supported identity replacement completes safely.

Clear CompanionSnapshot private fields and backing maps/refs: messages, streaming, pending approvals, active/runtime/stored identity, activeSession, recent sessions, profileIds, canonicalSessions, pendingSubmit/pendingInterrupt/interruptedTurn/completedSessionId/persistedContinuationTarget, continuityRetry, activeDraftIdentity, savedToken and hydration eligibility; Work/Directory data/profile/selection metadata; Library list/detail/preview/errors/chunks/object URLs; transcript-scroll.ts:scrollPositions and component refs; private navigation parameters. Deleting local review caches does not delete server retained evidence or Work decisions.

Use an opaque native-persisted credential/cache scope for restart-surviving drafts/receipts. Scope changes on explicit identity replacement/logout, not token refresh or lease renewal. Hydrate only after native scope confirmation. No import of old unscoped private caches into a new owner. Keep only non-secret base URL/preferences outside identity scope. Never put draft text, owner identity or credentials in URLs.

SessionSecretStore native operations serialize set/reset with a generation. revoke marks blocked before awaiting reset. A previously started set must not resurrect a token after revoke; queue the reset after the old write, reject its result and keep reads blocked. get checks generation after await. Failed reset is retryable; a native deletion failure cannot be reported as success. savedTokenReady must capture/check identity generation before publishing or selecting any auth lane.

Android OwnerSession already has generation, ReadLease/Disclosure and process-wide operation arbitration. Extend those mechanisms, do not replace them with only a React boolean. GatewayTokenPlugin must cancel late result disclosure on logout/destroy. Electron Companion owner-auth.ts:OwnerAuth and owner-ipc/preload need the same scope/generation contract. Local ownerSignOut deletes that client's credentials and cancels its pending work; it does not revoke other devices or sign the system browser out. Server-wide identity revocation is separate. A local cleanup error must not be described as a remote logout failure.

### Actual RPC resource cancellation

Pass AbortSignal as an out-of-band request option through LibraryGateway/library-types.ts -> CompanionClient methods -> apps/shared/src/json-rpc-gateway.ts:request(..., signal). Do not serialize it into RPC params. Extend source refresh APIs similarly. Cancelling a read removes its pending request/listeners and suppresses result publication; it is NOT an execution Stop RPC.

A transfer captures ONE client, identity epoch, connection generation, selection generation and immutable artifact/version descriptor for all chunks. After each await (capabilities, chunk, digest, native export preparation) check cancellation and captured identity. Check immediately before Blob creation, object URL publication and anchor.click/native share. On cancel discard partial buffers and revoke URLs. Unmount/selection replacement/disconnect/logout all revoke the transfer; no automatic restart on another gateway or switch from retained version to Latest.

openPersistedSession guards every asynchronous boundary, including digest/history before writing retry metadata and before continue dispatch. work.attach checks its captured epoch after capabilities. Library PDF verification cannot publish after selection replacement. A finalizer from an obsolete request cannot clear a new in-flight slot or errors.

Files deliberately exported before revocation are outside the app's recall boundary. State this limitation; do not attempt to delete external files.

## 12. Exact freshness contract: 29,999 / 30,000 / 30,001

For EACH backend/profile/source/query/coverage snapshot, track:

- observationOrigin: monotonic start of the oldest authoritative request contributing to the committed snapshot
- completedAt, coverage, generation, health, unsupported/error and in-flight state

freshByAge = snapshot exists AND clock is valid AND 0 <= now - observationOrigin <= 30_000 milliseconds. Keep health/coverage/connection truth separate from age. Unknown/partial/error is never shown as fully verified healthy data.

Required exact assertions for a valid committed snapshot with origin t:

- t + 29,999 ms: age-valid.
- t + 30,000 ms: age-valid, inclusive.
- t + 30,001 ms: stale, visibly so.

Triggering refresh, a fulfilled promise, a React refreshToken increment, capability discovery, a failed/partial result or a connection ping NEVER advances origin. New origin commits only after schema/identity/coverage validation and store application. Do not use request completion time to conceal backend latency.

Scheduling and boundedness:

- Initial connection, foreground and explicit refresh start observations immediately when authorized/online.
- Per-source single-flight, independent of other sources. Begin the next refresh by 15 seconds after the prior observation origin; each complete source/query refresh has a 15-second total budget including pagination. If the old read consumed the interval, start its follow-up promptly rather than adding another fixed 30 seconds.
- Deadline expiration aborts/increments generation, releases the slot and reports slow/error. Late completion cannot publish or reset age. Use bounded retry scheduling to avoid a timeout spin.
- Under healthy backend/transport/foreground scheduling within that budget, data meets the <=30-second target. A stalled event loop/network is not a false freshness guarantee: evaluate age on every render/read and immediately on resume; schedule the stale transition, but do not trust a suspended timer.
- At exactly 30,000 ms the old data may be age-valid while health already says slow/failed. At 30,001 it is stale regardless of in-flight refresh. A success committing at the boundary is ordered deterministically; test before and after commit independently.
- Repeated refresh calls coalesce per source. A manual request arriving after an older observation started queues at most one follow-up; its returned promise settles after that qualifying observation commits or its bounded failure. Return structured per-source results, not a blanket 'refreshed'.

Library needs an awaited store-owned refresh operation (new library-store.ts), not a void refresh token. Directory, Work, attention and Library publish their own success/failure; one hung source does not block timestamps/UI of the others. Whole-collection freshness needs whole requested coverage. For pagination retain the oldest request origin, validate cursor progress/deduplication, and expose partial coverage if budget prevents completing it. Never label all rows fresh from page one. Preserve loaded history/anchors while refreshing catalogs.

Use injected monotonic clocks in tests. Persisted monotonic timestamps have no validity across process restart; mark unknown/stale until observation. Treat background as requiring revalidation because platform clocks/timers can suspend. The 30-second catalog bound is NOT a credential lease rule: security leases expire at their deadline (>=), without the catalog's inclusive grace.

## 13. File/symbol implementation map

Existing paths/symbols are grounded above; names explicitly marked new are proposed implementation seams, not claims of existing APIs.

Server policy/admission:

- tui_gateway/server.py:method, handle_request, dispatch, _methods; new register_rpc.
- tui_gateway/method_ctx.py:HandlerRegistry.install; direct register functions in methods_work.py and methods_companion_*.py.
- tui_gateway/transport.py:current_transport, bind_transport, StdioTransport, TeeTransport; tui_gateway/entry.py for trusted input provenance.
- tui_gateway/rpc_policy.py (new) and tests/tui_gateway/test_rpc_policy_inventory.py (new).
- hermes_cli/dashboard_auth/ws_tickets.py:OwnerAuthorizationLease, mint_ticket, consume_ticket, issue_owner_authorization_lease, leased_human_identity, revoke_owner_authorization, internal_ws_credential.
- hermes_cli/dashboard_auth/routes.py:api_auth_ws_ticket; hermes_cli/web_server.py:_ws_auth_reason_with_owner_lease; hermes_cli/web_server_chat.py:_ws_auth_reason/_resolve_chat_argv; hermes_cli/web_routers/chat_ws.py:gateway_ws, pub_ws, events_ws and PTY admission/forwarding.
- tui_gateway/ws.py:WSTransport and handle_ws; outbound adapters/broadcaster reached from chat_ws also require the shared frame gate.

Control/execution:

- tui_gateway/session_control_authority.py (new).
- tui_gateway/methods_session.py:session.interrupt registration, session.events.since, session.events.stats, attention.list and runtime status/history projections.
- tui_gateway/methods_prompt.py:prompt.submit, approval.pending/received/respond, _approval_respond_session_fallback and late response handlers.
- tui_gateway/methods_session_control.py:session.control/read, with the shared target/owner checks.
- tui_gateway/companion_sessions.py:continue_session, reconcile_session, _v3_result; new observe wrapper delegates to the control service.
- tui_gateway/companion_turns.py:TurnClaim, claim_turn, bind_turn, settlement/admission transitions; tui_gateway/prompt_turn.py admission/finalization.
- tui_gateway/session_lifecycle.py:_close_sessions_for_transport, _schedule_ws_orphan_reap, _rebind_live_transport, _interrupt_session_turn; existing server teardown wrappers must not bypass server-owned execution protection.
- tools/approval.py:resolve_gateway_approval, list_gateway_approvals, ack_gateway_approval; tools/approval_gateway_wait.py waiter creation.
- hermes_cli/companion_work.py:owner_identity/execute and companion_work_store.py transactions; tui_gateway/companion_organization_mutations.py and companion_library.py commits keep defense-in-depth.

Clients:

- apps/shared/src/{json-rpc-gateway,websocket-url}.ts: request cancellation, typed closes, owner-required URL resolution/retry policy.
- apps/desktop/electron/main.ts:ensureNativeAccessToken, mintGatewayWsTicket, freshGatewayWsUrl and connection-config login/logout IPC; Desktop call paths in section 5.
- apps/companion/src/gateway/{connection,companion-client,types}.ts; security/{owner-auth,secret-store}.ts; state/companion-store.ts and session-drafts.ts.
- apps/companion/src/app.tsx; features/directory/{directory-refresh,directory-store}.ts; features/work/work-store.ts; features/library/{library.tsx,library-types.ts}; new features/library/library-store.ts; features/conversation/transcript-scroll.ts.
- apps/companion/android/app/src/main/java/com/hermes/companion/{GatewayTokenPlugin,OwnerSession}.java and existing lifecycle adapter/MainActivity where required; retain Keystore/OwnerAppVisibility protections.
- apps/companion/electron/{owner-auth,owner-ipc,preload}.ts and their native-storage integration.

Do not refactor unrelated modules or change credentials/configuration merely to make tests pass. Follow existing module rebinding conventions: policy wrappers installed after rebind must not accidentally close over the wrong server globals.

## 14. Implementation sequence and test matrix

All rows below are required evidence from the final candidate. They are PENDING implementation/testing, not current PASS claims.

A. Freeze/deny first: manifest + central guarded registry + explicit local provenance + lease scope + egress fence. Write negative tests before exposing new control methods.
B. Implement the exact execution/control identity and transactions, durable admission/observation, server lifetime protection.
C. Implement Desktop ticket migration and all RPC retry/Stop/approval call paths in the same branch/candidate; do not deploy A/B alone.
D. Implement native/store generations, actual cancellation and complete cleanup.
E. Wire production lifecycle, keep UI mounted, implement per-source freshness and awaited Library store.
F. Run host suites/builds, then physical acceptance and isolated release gate. Phone absence does not halt A–E or host F.

| Area | Required cases and assertions | Evidence target |
|---|---|---|
| Registry | Exact expanded key equality; generated groups/work/organization/project/MCP/billing entries; duplicate/unclassified registration fails; S exact; direct nested _methods cannot bypass | New test_rpc_policy_inventory.py and test_rpc_authorization.py |
| Remote deny | Missing/shared/internal/non-owner/expired/revoked/wrong backend/wrong profile/wrong transport/copy of lease; forged params flags/identity; no side effect/private response | Parameterized real dispatcher and production WS tests for every O entry |
| Local compatibility | Actual entry stdio create/resume/submit/interrupt/legacy approval unchanged; no-context remote adapter rejected; already owner-only Work/Companion restrictions retained | Existing test_companion_transport_integration.py plus stdio/core regressions |
| Policy edits | Already-open socket after owner removal, served-profile removal, malformed/unreadable/non-mapping policy; no last-known-good admission or stream | Owner/ticket tests and real WS egress tests |
| Queue races | Revocation before worker start, after wait, before commit; nested call; same-profile and cross-profile catalog/command dispatch | Barrier-driven tests, no sleep-based timing assumption |
| Egress | Tokens in coalescer, batch extracted awaiting send lock, worker reply, replay, approval, chunk, next frame after an awaited send; expiry with delayed timer; ordinary close clears buffers | Real WSTransport/ASGI test plus underlying adapter cancellation assertion |
| Ticketing | One-use, replay, wrong audience/profile, mint/consume generation race, lease transfer, native owner vs non-owner; 30-second ticket deadline and 300-second lease deadline exclusive | dashboard_auth/ws_tickets and route integration suites |
| Desktop auth | Saved token migration, PKCE/cookie chosen lane, single-flight rotation, transient vs 401, no native->cookie downgrade, expired lease renewal, explicit revocation latch, logout during refresh/mint/open | Electron helper tests + matching real backend |
| Desktop lanes | Initial/pooled/profile/popout/sleep-wake/voice; no cached token fallback; REST download separately; unknown session notification never ambient-routed | gateway-ws-url tests, store/gateway, native-notifications, request hook, UI integration |
| Stop | Same execution, wrong ID/generation/profile, runtime reuse, compression, fork, already terminal, late Stop while next run begins, hosted task additional check; no unrelated TTS/process stop | New test_companion_exact_control.py + existing generic interrupt suites |
| Approval | Mandatory choice/request; foreign request ID, two pending waiters, settled/reused ID, runtime replacement, simultaneous decisions/revocation; no all/FIFO/global scan; once/deny Companion contract | tools approval tests + RPC/UI notification integration |
| Admission | Simultaneous Desktop/phone submit to one lineage; index/claim crash gaps; revocation before/after admission; duplicate/different payload receipt; unknown reconciliation never resubmits | test_companion_session_continuity.py and persisted session suites |
| Independence | Real WS submit/admission -> close socket -> exceed orphan grace with missing/stale activity -> execution still runs; approval remains pending; client B observes same run; independent executor death settles honestly | New test_companion_ws_lifecycle.py through production teardown, not stdio substitute |
| Cleanup | Double logout, failed native/token reset then retry, savedTokenReady race, stale login/ticket/digest/history/store.attach; no post-barrier send/state/cache write | companion-store, owner-auth, secret-store tests and native tests |
| Resources | Cancel before/after capabilities, every chunk, digest, URL creation, export boundary; selection change and unmount; no cross-client continuation/partial export | library.test.tsx, companion-client.test.ts, shared request tests |
| Foreground UX | Actual app wiring hidden->close->online/visible/focus; coalesced reconnect; route/selected target/draft/scroll/focus unchanged; no create/resume/submit/approval call | app.test.tsx, connection.test.ts, store and conversation tests |
| Freshness | Separate 29,999, 30,000, 30,001 assertions; origin vs completion; commit at boundary; slow/hung source, independent source success, timeout/late result, partial pagination, manual follow-up, resume/restart | directory-refresh.test.ts + Directory/Work/new Library store tests |
| Older backend | Missing required enforcement/observe/control capability; “Wymagana aktualizacja”; no blank session, token downgrade, hidden legacy route or auto-submit | Companion and Desktop integration |
| Persistence | Isolated backup/restore decisions/bindings/retained evidence/history/projects; retained digest/version; idempotent Work notification digest after reconnect/restart | Existing backup/restore and Work digest tests; no live restore |
| Physical | Samsung background/resume/Tailscale outage/Activity recreation/process death, Keystore restart/update/key invalidation/backup exclusion, Back/IME/focus/scroll; all P6 retained export/open/share cases | Candidate-stamped Samsung evidence |
| Mac | Packaged Mac Companion auth/lifecycle/export; matching remote Hermes Desktop same-session control/approval/read paths; local stdio unaffected | Candidate-stamped Mac evidence |

Existing regression anchors include tests/tui_gateway/test_companion_{library_rpc,organization_mutations_rpc,persisted_sessions_rpc,topics_rpc,attention,session_continuity,transport_integration}.py, tests/hermes_cli/test_companion_work.py and test_artifact_library.py, plus existing P1/P3/P5/P6 security and native-storage suites. Preserve test_companion_backup_restore.py::test_ac33_full_companion_state_survives_isolated_backup_restore and Work digest deduplication coverage. Do not report historical counts as current results.

Use the repository's existing package scripts for Companion test/typecheck/lint/build and Android/Mac packaging, and the corresponding Desktop/shared checks. Run Python tests with isolated HERMES_HOME and no production provider/business calls. Save raw output and identify candidate commit plus artifact fingerprints. This audit did not execute these commands or claim their results.

## 15. Compatibility and rollout gate — indivisible candidate

Compatibility is explicit, not silent:

- Trusted local stdio retains its existing contract.
- Remote shared-token clients receive only S protocol discovery/liveness and update/sign-in guidance. They lose private reads as well as mutation access. This is intentional and must appear in release notes.
- Remote Desktop receives a working owner-ticket migration in the SAME candidate, including token-config migration, renewal, per-profile routing, exact-target controls, non-replaying mutations, logout and private REST paths.
- Existing Companion owner login is retained; its ticket scope/renewal and resource lifecycle are upgraded without credential disclosure. A missing protocol shows “Wymagana aktualizacja”, never fallback to a blank/new session.
- Server-internal/PTY/sidecar credentials are not grandfathered as privileged remote clients. Used paths pass the owner-mediated compatibility tests before release.

Release is blocked until ALL of the following are true:

1. Freeze one integrated candidate containing server, shared protocol, Desktop, Android Companion and Mac Companion changes; record full source and artifact identities. Rebase/minimally port against current live core in an isolated release worktree if needed; do not overwrite newer live core with this historical feature branch.
2. Registry equality, all owner deny tests, local stdio positives, remote Desktop positives and real queued-frame revocation tests pass. No skipped compatibility path or expected-failure security test counts as pass.
3. Required suites, typechecks, lint/build/package checks, isolated backup/restore and retained-evidence/notification tests pass with raw logs.
4. Samsung and Mac physical acceptance passes on these exact artifacts. A missing phone is a pending physical gate, not permission to deploy or stop device-independent work.
5. Auth-required deployment prerequisites are verified read-only; owner provider/policy and served scopes actually support the intended clients. Provisioning/changing live owner config or restarting services is separately authorized, not implicit in implementation approval.
6. Stage matching clients and backend behind a closed canary/maintenance boundary. Do not expose the new server to production until the matching Desktop path has passed compatibility. Do not expose new clients as a partially enabled production release against an old unprotected server. Quiesce/handle active operations under the approved runbook, activate the integrated set, reopen traffic only after protocol/read-back checks, and preserve admitted work.
7. Rollback is an integrated operation: close the affected remote boundary first, preserve/backup new durable records, use the tested compatible rollback set, and reopen only after security checks. Never roll back just the server and reopen a shared-token privileged hole. If no secure compatible rollback exists, keep remote private access closed; local stdio remains available under its existing boundary.

Design acceptance does not authorize a service restart, credential migration on Pawel's devices, publication or deployment. Those remain the P8 operational gates. There is no remaining policy choice or design exception permitting partial rollout.

PASS_TO_IMPLEMENT
