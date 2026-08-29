# Hermes Companion Vertical Slice Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Ship a separate, simple Hermes Companion for macOS and Android that connects privately to the existing Mac mini Hermes gateway over Tailscale and delivers teammates, conversations, streaming, approvals, and recovery without exposing Control Center complexity.

**Architecture:** Add one React/Vite product package whose UI and gateway domain layer are shared by two thin native shells: Electron for macOS and Capacitor for Android. Reuse `@hermes/shared` for JSON-RPC/WebSocket behavior. The gateway remains on the Mac mini; neither client runs an agent runtime. URL/token setup is explicit, tokens are never logged, and persistence must use native protected storage or remain session-only until protected storage is available.

**Tech Stack:** TypeScript 6, React 19, Vite 8, Vitest, Electron 40, Capacitor Android, Kotlin native secure-store bridge, Hermes JSON-RPC gateway.

---

## Acceptance journey

1. Open Companion on macOS or Android while connected to the tailnet.
2. Enter a private Tailscale gateway URL and token once.
3. See named Hermes profiles as teammates with latest conversation previews.
4. Open a teammate, resume its latest session or create a new one.
5. Send a prompt and see streamed response and tool-progress state.
6. If approval is requested, see a plain-language card and approve or deny it.
7. Close/reopen a client and continue the same server-side conversation.
8. If the gateway is unreachable, see a recovery screen that preserves the draft and never pretends the task failed server-side.

## Safety invariants

- No public gateway exposure or automatic router/firewall mutation.
- The Mac mini remains the only agent runtime.
- No token in source, logs, screenshots, URL fields after save, or localStorage.
- WebSocket authentication uses the gateway's existing token/ticket contract.
- Approval defaults to deny and is scoped to the exact session/request.
- Existing `apps/desktop` and its remote connection remain unchanged.

### Task 1: Create the shared Companion application package

**Objective:** Establish an isolated workspace with deterministic scripts and test harness.

**Files:**
- Create: `apps/companion/package.json`
- Create: `apps/companion/tsconfig.json`
- Create: `apps/companion/vite.config.ts`
- Create: `apps/companion/index.html`
- Create: `apps/companion/src/main.tsx`
- Create: `apps/companion/src/app.tsx`
- Create: `apps/companion/src/test/setup.ts`

**Steps:**
1. Write a smoke test that renders the app shell and fails.
2. Add the minimal Vite/React shell.
3. Run `npm run test --workspace apps/companion`.
4. Run `npm run typecheck --workspace apps/companion`.
5. Commit only `apps/companion` and root lockfile changes.

### Task 2: Implement gateway configuration and redacted URL building

**Objective:** Turn a Tailscale HTTP(S) base URL plus token into the exact Hermes WebSocket URL without leaking credentials.

**Files:**
- Create: `apps/companion/src/gateway/connection.ts`
- Create: `apps/companion/src/gateway/connection.test.ts`
- Create: `apps/companion/src/security/secret-store.ts`
- Create: `apps/companion/src/security/secret-store.test.ts`

**Steps:**
1. Test HTTP→WS, HTTPS→WSS, existing `/api/ws`, IPv4/hostname, whitespace, and invalid/public-looking URL warnings.
2. Reuse `buildHermesWebSocketUrl` from `@hermes/shared`.
3. Ensure serialization/redaction never returns token values.
4. Persist base URL separately; keep token session-only until a native secure store is active.
5. Verify unit tests and typecheck.

### Task 3: Implement the Companion gateway domain client

**Objective:** Provide typed operations for roster, sessions, streaming, interrupts, and approvals.

**Files:**
- Create: `apps/companion/src/gateway/types.ts`
- Create: `apps/companion/src/gateway/companion-client.ts`
- Create: `apps/companion/src/gateway/companion-client.test.ts`

**Steps:**
1. Write tests against a fake WebSocket for `profiles.list`, `session.create`, `session.resume`, `prompt.submit`, `session.interrupt`, `approval.pending`, and `approval.respond`.
2. Implement with `JsonRpcGatewayClient` from `@hermes/shared`.
3. Convert `message.delta`, `message.complete`, tool and approval events into a small typed event stream.
4. Verify session/request IDs are preserved exactly.
5. Verify reconnect never duplicates a submitted prompt.

### Task 4: Implement the Signal House visual system and product navigation

**Objective:** Convert the approved mockup into production React components for desktop and Android breakpoints.

**Files:**
- Create: `apps/companion/src/styles/tokens.css`
- Create: `apps/companion/src/styles/app.css`
- Create: `apps/companion/src/features/roster/*`
- Create: `apps/companion/src/features/conversation/*`
- Create: `apps/companion/src/features/attention/*`
- Create: `apps/companion/src/features/recovery/*`

**Steps:**
1. Add component tests for roster statuses, approval card actions, conversation streaming, and recovery copy.
2. Implement Teammates, Conversation, Needs Me, Search placeholder, and Teammate Details.
3. Use responsive layout, not a shrunk desktop canvas.
4. Verify 1500×1000 desktop and 412×915 Android viewports with Playwright screenshots.
5. Visually compare to approved mockups at final size.

### Task 5: Integrate live roster and conversation flows

**Objective:** Make the UI operate against a real or fixture Hermes gateway.

**Files:**
- Create: `apps/companion/src/state/companion-store.ts`
- Create: `apps/companion/src/state/use-companion.ts`
- Modify: feature components from Task 4
- Create: `apps/companion/src/fixtures/fake-gateway.ts`

**Steps:**
1. Test first-run setup, roster load, resume/create, prompt streaming, approval, disconnect, and recovery.
2. Implement a fixture mode for deterministic QA only.
3. Implement live mode with the gateway client.
4. Preserve unsent drafts through connection loss.
5. Verify the client does not claim a server-side turn failed solely because the socket closed.

### Task 6: Add the macOS Electron shell

**Objective:** Produce a packaged macOS Companion app without modifying the existing Hermes Desktop.

**Files:**
- Create: `apps/companion/electron/main.ts`
- Create: `apps/companion/electron/preload.ts`
- Create: `apps/companion/electron/secure-store.ts`
- Create: `apps/companion/electron/*.test.ts`
- Modify: `apps/companion/package.json`

**Steps:**
1. Test a narrow preload API and encrypted token persistence with Electron `safeStorage`.
2. Use a distinct app ID, product name, user-data directory, and protocol from Hermes Desktop.
3. Disable Node integration; enable context isolation and sandboxing where compatible.
4. Package a macOS `.app`/zip.
5. Launch the exact packaged artifact and capture screenshots.

### Task 7: Add the Android Capacitor shell

**Objective:** Produce an installable Android APK backed by the same tested React application.

**Files:**
- Create: `apps/companion/capacitor.config.ts`
- Generate: `apps/companion/android/**`
- Create: Android secure-store plugin under the generated application package
- Modify: `apps/companion/package.json`

**Steps:**
1. Install JDK and Android command-line tools if absent.
2. Add Capacitor Android and sync the built web bundle.
3. Implement Android Keystore-backed token storage; never use WebView localStorage for the token.
4. Add network-security configuration that permits the explicitly configured tailnet HTTP endpoint only for the private dogfood build; prefer HTTPS/Tailscale Serve for release.
5. Run unit tests, Android lint, and `assembleDebug`.
6. Verify signing, alignment, package metadata, permissions, size, and SHA-256.
7. Install and cold-launch on ADB hardware if available; otherwise mark physical verification outstanding.

### Task 8: Real gateway integration and final review

**Objective:** Prove the vertical slice against the user's existing Mac mini topology without exposing secrets.

**Files:**
- Create: `apps/companion/docs/TAILSCALE_SETUP.md`
- Create: `apps/companion/docs/VERIFICATION.md`

**Steps:**
1. Connect using the same private gateway base URL/auth mode already used by Hermes Desktop, entered through the app UI.
2. Read `profiles.list`; open a disposable session; send a harmless prompt; verify streaming completion.
3. Exercise a harmless approval request if a deterministic fixture is unavailable.
4. Disconnect/reconnect and verify session continuity.
5. Run tests, lint, typecheck, production web build, macOS package, Android lint/build/inspection.
6. Freeze the snapshot, run spec review, then code-quality/security review.
7. Commit intended files only and report exact verified boundaries.
