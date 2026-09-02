# Hermes Companion Priorities 1–3 Implementation Plan

> **For Hermes:** Implement task-by-task with regression tests and verify every supported build target.

**Goal:** Replace the Companion vertical-slice/demo behavior with a truthful cross-profile attention queue, resumable/pinnable existing conversations, canonical per-profile Bot Chats, and an Atlas-default quick-task inbox.

**Architecture:** Extend the existing read-only gateway surface with one narrowly scoped `attention.list` aggregate based only on authoritative live session state, pending approval registries, pending gateway prompts, and recorded terminal turn outcomes—never text heuristics. Extend `session.list` with durable pin and last-activity fields plus a profile-aware `session.set_pinned` mutation. The Companion client validates these responses, falls back gracefully when older gateways do not expose new capabilities, and keeps UI-only pin fallback in local storage only when server persistence is unavailable.

**Tech Stack:** Python JSON-RPC gateway and pytest; React 19, TypeScript, Vite, Vitest/Testing Library; existing Electron/Capacitor shells.

---

### Task 1: Pin the gateway contracts with tests

**Files:**
- Create: `tests/tui_gateway/test_companion_attention.py`
- Modify: `tests/test_tui_gateway_server.py` or create a focused session-list contract test

**Steps:**
1. Write failing tests for `attention.list` returning only authoritative approval, question, blocker, completion, and error records with profile/session/deep-link identity.
2. Write failing tests proving `session.list` includes `pinned` and `last_active` and that `session.set_pinned` targets the requested profile DB.
3. Run the focused pytest selection and confirm RED.
4. Implement the smallest read-only aggregate and pin mutation.
5. Re-run focused tests and confirm GREEN.

### Task 2: Add validated Companion gateway methods

**Files:**
- Modify: `apps/companion/src/gateway/types.ts`
- Modify: `apps/companion/src/gateway/companion-client.ts`
- Modify: `apps/companion/src/gateway/companion-client.test.ts`

**Steps:**
1. Add failing client tests for exact `attention.list`, profile-scoped `session.list`, exact-title Bot Chat lookup, and `session.set_pinned` frames.
2. Define allowlisted response types and runtime validators so raw paths/secrets/unknown fields do not enter UI state.
3. Implement methods and graceful unsupported-method detection at the store boundary.
4. Re-run client tests.

### Task 3: Model recent conversations, pins, canonical chats, and attention

**Files:**
- Modify: `apps/companion/src/state/companion-store.ts`
- Modify: `apps/companion/src/state/companion-store.test.ts`
- Modify: `apps/companion/src/fixtures/fake-gateway.ts`

**Steps:**
1. Add failing store tests for cross-profile recents, server pins, old-gateway fallback, deep-link selection, exact-title `Bot Chat` reuse/create, latest result/activity, and Atlas-default quick submission.
2. Load bounded recents for every profile after roster discovery; load the attention aggregate when supported.
3. Resume selected recent/deep-linked sessions and toggle pins via the profile-aware RPC; retain local fallback only for older gateways.
4. Make ordinary profile/chat entry resolve exact-title `Bot Chat`, resuming it when present and creating hidden `Bot Chat` only when absent.
5. Add a quick-task action that selects Atlas by default, resolves its canonical chat, submits text exactly once, and navigates to that conversation.
6. Re-run store tests.

### Task 4: Build the production UI

**Files:**
- Modify: `apps/companion/src/app.tsx`
- Modify: `apps/companion/src/app.test.tsx`
- Modify: `apps/companion/src/features/attention/needs-me.tsx`
- Create/modify focused feature tests as needed
- Modify: `apps/companion/src/styles/app.css`

**Steps:**
1. Add failing UI tests for the Atlas-default “What should I do?” composer, agent selector, recent conversation cards, Resume, pin/unpin, latest result/activity, and all attention kinds opening their exact target.
2. Render the quick composer and recent sessions on Home without demo counts/metrics.
3. Render Needs Me from typed aggregate records, including actionable deep links and honest empty/unsupported states.
4. Make the Conversation navigation open the selected profile’s canonical Bot Chat rather than creating a fresh session.
5. Re-run UI tests and accessibility-oriented existing tests.

### Task 5: Native capability boundary and cleanup

**Files:**
- Inspect only unless supported: `apps/companion/electron/*`, `apps/companion/android/*`
- Modify docs/comments/tests where needed

**Steps:**
1. Confirm whether the existing shells expose safe notification/file/share/camera/voice bridges.
2. Integrate only capabilities already exposed by those shells; otherwise keep text-only controls and document the limitation—do not add speculative APIs or permissions.
3. Remove hard-coded demo metrics/state from production paths while retaining explicitly gated fixture data for tests/QA.
4. Run `git diff --check` and review for secrets, profile paths, destructive operations, and Control Center scope creep.

### Task 6: Verification

**Commands:**
1. Focused Python gateway tests.
2. Focused Companion Vitest files.
3. `npm test --workspace apps/companion` (or `npm test` from the Companion directory).
4. `npm run typecheck --workspace apps/companion`.
5. `npm run build:web --workspace apps/companion`.
6. If time/environment permits: `npm run android:debug --workspace apps/companion` or the equivalent Gradle compile/assemble task from `apps/companion/android`.

**Acceptance:** Every requested priority is backed by real gateway data or an explicit older-gateway unavailable state; every write is profile-scoped; existing security boundaries stay intact; exact command exit results and residual platform limitations are reported.