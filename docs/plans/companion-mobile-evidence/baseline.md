# Companion mobile continuity — frozen baseline

**Recorded:** 2026-09-09 12:20:49 CEST (UTC+0200)  
**Scope:** sanitized read-only baseline for the implementation candidate. No token, cookie, credential value, session prompt, business decision, service restart, or external write was performed.

## Source candidates

| Role | Path | Revision / version | State |
|---|---|---|---|
| Implementation worktree | `/Users/atlasweber/hermes-companion` | `15bb315df34945a2097876053e49aae0c77a9b69`, branch `feature/hermes-companion` | Working tree contains the approved implementation plan and in-flight changes; final candidate not frozen yet. |
| Deployed Companion backend snapshot | `/Users/atlasweber/hermes-companion-final-snapshot` | `15bb315df34945a2097876053e49aae0c77a9b69`, detached | Companion 0.4.4 baseline served by the isolated remote dashboard. |
| Current core checkout | `/Users/atlasweber/hermes` | `7acdc2234098e1c87f9a442b66b2aba608124c30`, branch `main` | Newer core; must not be replaced wholesale by the historical feature branch. |
| Desktop-managed runtime checkout | `/Users/atlasweber/.hermes/hermes-agent` | `dd0e4ab81abccf7df5b11c6c16853d5e5de9db69`, detached | Separate runtime identity; deployment compatibility must be checked independently. |
| Companion package | `apps/companion/package.json` | 0.4.4 | Shared renderer/Electron/Android product baseline. |

The implementation candidate must record a new final SHA after all code and test changes. The hashes above are baselines, not acceptance claims.

## Live private topology

| Component | LaunchAgent | Observed state | Responsibility |
|---|---|---|---|
| Companion remote dashboard | `com.hermes.dashboard-atlas-remote` | loaded, running, PID 866 | Isolated dashboard for the Atlas profile, served from the frozen Companion snapshot. |
| Local dashboard | `com.hermes.dashboard` | loaded, running, PID 620 | Local dashboard/control surface; not the Companion deployment target. |
| Atlas messaging gateway | `com.hermes.gateway.atlas` | loaded, running, PID 3462 | Messaging gateway; must not be restarted merely for a Companion UI rollout. |

The existing deployment runbook documents the private route as tailnet HTTPS → localhost reverse proxy on 9121 → isolated dashboard on 9120. The isolated dashboard process working directory was independently observed as `/Users/atlasweber/hermes-companion-final-snapshot`. The implementation worktree is not the running backend.

At baseline, harmless probes of `/` returned HTTP 200 on localhost ports 9119, 9120 and 9121; the protected auth-status route returned HTTP 401 without credentials, which is the expected fail-closed result. No credential was printed or reused.

No Samsung was connected over ADB at capture time (`adb_devices=0`). Device-only acceptance remains a separate external gate; device-independent implementation and packaging continue.

## Authoritative identities and execution ownership

1. A logical conversation is keyed by authoritative backend namespace, profile, and persisted session lineage/root—not by display title.
2. `stored_session_id` identifies persisted state. `runtime_session_id` identifies an attached execution runtime. They are not interchangeable.
3. Compression descendants resolve to the current logical tip. The persisted projection must not expose a second logical conversation for one lineage.
4. `companion.sessions.list` and `companion.sessions.history` read persisted state through the selected profile's `state.db`. Read operations must not create/resume a runtime, submit a prompt, or activate a project.
5. Execution still uses the existing `session.resume`/`session.create` and `prompt.submit` runtime path. There is no separate Companion agent runtime or second history store.
6. Concurrent clients must converge on one live runtime/turn for a selected logical session. A disconnect must not imply interrupt, approval, retry, or a second run.
7. Project membership and workspace/cwd are resolved server-side from existing Hermes project/session data. Browsing from Companion must not change Desktop's global active project or another running task's cwd.

## Capability and authorization inventory

### Owner-only persisted reads

`methods_companion_sessions.py` registers:

- `companion.sessions.list`
- `companion.sessions.history`
- `companion.capabilities`

Each session read receives `current_transport().companion_owner_authorization` and validates the live owner lease on every call. `companion.capabilities` also revalidates that lease and reports only registered Companion methods.

`methods_companion_projects.py` registers owner-only `companion.projects.list` and `companion.projects.get` through the same transport-bound authorization. Library, topics, organization and work are separate Companion capability families and preserve their own server-side policy checks.

### Execution boundary still requiring proof

The generic `session.create`, `session.resume`, `prompt.submit`, `session.interrupt` and approval methods are real runtime operations. Their mere presence is not proof that a Companion owner request is bound to the intended persisted profile/project/session, serialized with another client, or idempotent after an unknown submit result. P1 must prove this through the real dispatcher and add only the minimum coordination needed.

A shared gateway token is transport connectivity, not owner authority. Missing/expired/revoked owner policy must remain a denial; it must never fall back to a shared token or a renderer-controlled identity flag.

## Source availability behavior

- A verified empty collection is rendered as empty.
- Unsupported, stale, unauthorized, incomplete or failed sources retain explicit coverage/error state.
- No source error may be collapsed into a fake `0`, an empty project, an empty session, or an implicit `Main conversation`.
- Pagination cursors and `has_more` remain authoritative; the client does not infer completeness from a short page.

## Baseline verification receipts

Before implementation changes were integrated:

- Companion Vitest: 34 files, 379 tests passed.
- Companion TypeScript typecheck passed.
- Companion ESLint passed.
- Targeted persisted sessions/library/organization/topics/attention Python group passed.
- Targeted Companion work/organization/kanban/backup/plugin Python group passed.
- Targeted projects RPC/tree/database Python group passed.

These receipts were collected on the starting code and are regression baselines only. P8 must rerun all required commands against one frozen final candidate and record its own raw outputs.

## Acceptance ledger

No row becomes PASS from this baseline. Each row needs evidence tied to the final candidate.

| ID | Requirement | Initial state | Required evidence |
|---|---|---|---|
| MC-01 | Compatible source and runtime topology | PENDING | Final client/backend SHAs, execution owner and deployment target. |
| MC-02 | Owner login and restart | PENDING | Native credential persistence/revocation tests and device restart. |
| MC-03 | Three destinations and stable start | PENDING | Renderer tests plus mobile-width fixture/device check. |
| MC-04 | Profiles/projects preserve identities | PENDING | Duplicate-name and cross-profile tests. |
| MC-05 | Empty/unassigned records remain visible | PENDING | Directory behavior tests using persisted records. |
| MC-06 | Pagination/archive/search is truthful | PENDING | Cursor/completeness tests and older-session search. |
| MC-07 | Desktop membership/rename semantics | PENDING | Existing resolver integration tests. |
| MC-08 | Reads have no execution side effects | PENDING | Dispatcher spy proving zero create/resume/submit/project activation. |
| MC-09 | Desktop → Companion → Desktop round-trip | PASS (P1 transport gate) | Real stdio JSON-RPC + temp `HERMES_HOME`/SessionDB; `p1-transport-gate.json`. |
| MC-10 | Compression lineage continuity | PENDING | Root/tip test without duplicate logical row. |
| MC-11 | Persisted history with Desktop closed | PASS (P1 transport gate) | Harness launches no Desktop/Electron client; persisted read + controlled submit pass over real stdio JSON-RPC. |
| MC-12 | Two clients, one run | PASS (P1 transport gate) | Two independent gateway processes/transports share one SessionDB: one completed run and one durable `not_admitted`/4091 busy result. |
| MC-13 | Unknown submit reconciliation | PASS (P1 transport gate) | Response left unread after durable admission; process killed; fresh transport reconciles the same request to `interrupted_outcome_unknown` with one operation and zero resubmits. |
| MC-14 | Server work survives phone disconnect | PENDING | Orphan/reconnect lifecycle evidence. |
| MC-15 | Stop targets the selected run | PENDING | Runtime identity and interrupt result test. |
| MC-16 | New project/unassigned session | PENDING | One persisted row, explicit profile, Desktop visibility. |
| MC-17 | Per-session/profile drafts | PENDING | A→B→A, restart and sign-out isolation tests. |
| MC-18 | Mobile IME/keyboard/scroll | PENDING | Component tests and 360 CSS px/device check. |
| MC-19 | Safe message/content rendering | PENDING | Compaction/tool/attachment/HTML tests. |
| MC-20 | One decision card/count, distinct consent types | PENDING | Work/Attention deduplication and approval tests. |
| MC-21 | Revision-safe decisions and handoff | PENDING | Competing clients, stale revision and single tracker task. |
| MC-22 | Ranking/grouping/snooze preserved | PENDING | WorkStore behavior tests. |
| MC-23 | Topic/binding controls preserved | PENDING | Existing owner-only topic tests. |
| MC-24 | Context deep links | PENDING | Decision↔session↔artifact and legacy-link tests. |
| MC-25 | Library manifest coverage | PENDING | Per-type preview/fallback/download/share evidence. |
| MC-26 | Retained evidence remains immutable | PENDING | Reviewed-version versus latest-version test. |
| MC-27 | Revocation/profile isolation | PENDING | Already-open transport, cross-profile and cache-clear tests. |
| MC-28 | Stale/unavailable backend is explicit | PENDING | Update-required/partial-source tests. |
| MC-29 | Backup/restore and notification idempotency | PENDING | Existing restore suite plus notification deduplication. |
| MC-30 | Android update and usability | PENDING | Signed APK, install, login, Back, keyboard, restart, network and share on Samsung. |
| MC-31 | Desktop/Mac regression safety | PENDING | Desktop session/project suites and Companion Mac package smoke. |
| MC-32 | One-candidate final verification | PENDING | Full suites/builds/security evidence with no unauthorized external effects. |

## Legacy requirement namespaces

The 6 September handoff and release-evidence matrix reuse numbers with different meanings. They remain separate namespaces:

| Legacy namespace | Mapping to mobile-continuity gates |
|---|---|
| H6-AC-01–03 | MC-05, MC-16 |
| H6-AC-04 | MC-08, MC-11 |
| H6-AC-05 | MC-01, MC-04, MC-27 |
| H6-AC-06–07 | MC-06 |
| H6-AC-08 | MC-06, MC-19 |
| H6-AC-09–10 | MC-07, MC-10 |
| H6-AC-11 | MC-05, MC-07 |
| H6-AC-12 | MC-28 |
| H6-AC-13 | MC-08 |
| H6-AC-14 | MC-09, MC-24 |
| H6-AC-15–17 | MC-23, MC-24, MC-28 |
| H6-AC-18–22 | MC-22 |
| H6-AC-23–26 | MC-20, MC-21 |
| H6-AC-27–28 | MC-19, MC-27 |
| H6-AC-29–30 | MC-25, MC-26 |
| H6-AC-31–32 | MC-14, MC-30 |
| H6-AC-33–34 | MC-29 |
| H6-AC-35–36 | MC-31, MC-32 |
| R-AC-01–02 | MC-02, MC-27, MC-30 |
| R-AC-03–07 | MC-04, MC-05, MC-23, MC-24 |
| R-AC-08–10 | MC-06, MC-08, MC-09, MC-24 |
| R-AC-11–14 | MC-23, MC-24 |
| R-AC-15–17 | MC-28, MC-30 |
| R-AC-18–22 | MC-20, MC-22 |
| R-AC-23–26 | MC-21 |
| R-AC-27–30 | MC-25, MC-26, MC-27 |
| R-AC-31–32 | MC-14, MC-30 |
| R-AC-33–34 | MC-29 |
| R-AC-35–36 | MC-31, MC-32 |

The mapping is traceability, not test evidence. Final acceptance expands every legacy row independently and links it to a concrete test or an explicitly accepted external limitation.

## P0 gate result

**PASS for baseline discovery only.** Sources of truth, live process roles, version divergence, authorization domains, and current test baseline are identified. This does not approve P1–P8, deployment, or any MC row.
