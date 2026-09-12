# Fix 5 — mobile retry-ledger durability

## What changed

- `apps/companion/src/state/companion-store.ts:541-551,1646-1649,1775-1784,1815-1825,1841-1845,2601-2609`
  - Removed the gateway-URL plus random local UUID owner scope.
  - Reads the authenticated owner scope returned by native owner sign-in/status and uses it together with the backend namespace in retry identities.
  - Reconciles unresolved creations after owner sign-in/reconnect.
  - Sign-out now clears the in-memory/presented owner state but does not clear the durable retry ledger.
- `apps/companion/electron/owner-auth.ts:13-18,219-221,267-269` and `apps/companion/electron/preload.ts:93-104`
  - Derive a stable, non-secret owner scope from the authenticated server `provider` plus `user_id` using SHA-256.
  - Return and validate that scope across the Electron native/preload boundary without exposing credentials.
- `apps/companion/android/app/src/main/java/com/hermes/companion/OwnerSession.java:79-80,173-175,304-316,438-473`
  - Preserve the authenticated server `user_id`, derive the same stable SHA-256 owner scope, and include only that non-secret scope in signed-in status results.
- `apps/companion/src/state/session-operation-retries.ts:52-53,93-112,129-145`
  - Enforces the 100-entry limit before adding a new retry.
  - Allows updates to existing retries at the limit.
  - Refuses a new send with `Retry ledger is full. Resolve a pending send before starting a new one.` without mutating memory or storage.
  - Quarantines malformed, oversized, or over-limit persisted ledgers in place; it does not delete or rewrite unresolved durable metadata and refuses further sends until reconciliation/repair.
- Behavioural coverage:
  - `apps/companion/src/state/companion-store.test.ts:182-228`
  - `apps/companion/src/state/session-operation-retries.test.ts:38-58`
  - Owner-auth boundary tests and existing fixtures were updated for the authenticated owner-scope result contract.

## Required behavioural tests

1. `preserves unresolved creation metadata across sign-out and reuses the authenticated owner partition`
2. `refuses a new send at 100 entries without dropping unresolved retries`

Additional behavioural regression: `quarantines an over-limit ledger without deleting its unresolved metadata` covers the auditor's 101-entry restart reproduction directly.

## Required gates (run from `apps/companion`)

- `npx vitest run`
  - PASS, exit 0: 37 test files passed; 589 tests passed.
- `npx tsc -p . --noEmit`
  - PASS, exit 0; no diagnostics.
- `npx eslint src/ -f json`
  - PASS, exit 0; every file reported `errorCount: 0`. Existing warning-level formatting findings remain outside the changed scope; the required error count is zero.

## Additional verification

- `npx tsc -p tsconfig.electron.json --noEmit`
  - PASS, exit 0; no diagnostics.
- `git diff --check`
  - PASS, exit 0; no whitespace errors.

## Could not verify

- Android JVM unit tests could not run on this host. `JAVA_HOME=/opt/homebrew/opt/openjdk@21 ./gradlew testDebugUnitTest` reached Gradle but failed before compilation because no Android SDK location is configured (`ANDROID_HOME`/`sdk.dir`). The required Vitest, TypeScript, and ESLint gates all passed.
