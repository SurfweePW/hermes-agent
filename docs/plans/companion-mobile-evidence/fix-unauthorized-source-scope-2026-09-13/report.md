# Fix — a single unauthorized source no longer wipes the companion directory

Date: 2026-09-13 · Client-only change (`apps/companion`), no server contract change.

## Symptom (measured on the Galaxy S24, real gateway)

The phone could connect and read data, but every durable conversation creation was refused:

```
EVAL: {"w":384,"entry":true}
"Durable conversation creation is unavailable for this connection."
```

Client state read live from the device (WebView CDP, React fiber):

```
coverage = 0 entries, sessions = 0, topics = 0, detailStatus = "idle"
```

Yet the server answered fine for every profile that it serves:

```
companion.sessions.list   {profile: "hoffeecmo", ...} -> ok, backend_namespace "derived:7eb6…"
companion.sessions.list   {profile: "hoffecmo", ...} -> {"code": 4403, "message": "session profile unavailable"}
```

## Root cause

`apps/companion/src/features/directory/directory-store.ts` treated **any** `4403` from a
per-profile request as a session-wide revocation: `purgeUnauthorized()` cleared every
profile's rows, cleared `coverage`, and dropped the gateway. Because the roster
(`profiles.list`) advertises every profile on disk while the companion data RPCs only serve
the profiles the gateway is configured for (`profiles_to_serve`), one unavailable profile
(`hoffecmo`) destroyed the directory for all nine profiles. With `coverage` empty,
`backendNamespaceForProfile()` returned `null`, the creation guard refused, and the mobile
client could never create a conversation — with no way out by reload, because the same
sequence repeated on every connect.

`features/work/work-store.ts` carried the same class of defect (purge-all on any `4403`).

## Change

Authorization is a property of ONE source, so it is now handled per source:

- `markUnauthorized(profile)` / `markTopicsUnauthorized(profile)` drop only that profile's
  cached rows, mark its coverage `error` with `This source is not authorized.`, and clear the
  open detail **only** when the open detail belongs to that profile.
- Detail/history paths publish the same per-source message instead of purging.
- The work store now relies on its existing per-source failure loop (`sourceStates`) and keeps
  verified data; writes on an unauthorized source stay locked and report the boundary.
- `purgeUnauthorized()` removed from both stores (no caller left, dead code).

## Verification

- `npx vitest run` — **590 passed / 0 failed** (37 files). Two contract tests rewritten to the
  new invariant and one new cross-profile test added: a revoked `atlas` source leaves `mentor`
  verified and selected.
- `npm run typecheck` — clean. `npm run lint` — 0 errors.
- Device proof, same session, fixed APK (`645654f8` marker, installed 01:07):

```
coverage = 9 entries:
  default:ready  atlas:ready  hoffecmo:error  hoffee-marketing-os:ready  hoffeecmo:ready
  hoffeeoperator:ready  hoffeeeresearch:ready  maven:ready  mentor:ready
sessions = 223
```

Creation from the phone then reached the server:

```
-> companion.sessions.create {backend_namespace: "derived:7eb6…", profile: "atlas",
   client_request_id: "0198e82d-…", text: "Test z telefonu: …"}
<- {operation_kind: "create", stored_session_id: "20260913_010646_b4e189",
    row_state: "present", operation_status: "admitted", runtime_session_id: "3f89ed8b"}
```

Confirmed in the profile database: session `20260913_010646_b4e189`, `source = companion`,
13 messages, 6 tool calls, first message `Test z telefonu: sprawdzenie trwałego tworzenia rozmowy.`
The phone showed the new conversation with the assistant turn already running (`TOOL terminal`).
