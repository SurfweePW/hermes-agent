# Companion owner authentication bridge

Additive top-level `window.hermesCompanion` methods (existing `gatewayToken` unchanged):

```ts
type OwnerStatus = { signedIn: boolean; baseUrl?: string }
ownerSignIn(input: { baseUrl: string }): Promise<OwnerStatus>
ownerStatus(input: { baseUrl: string }): Promise<OwnerStatus>
ownerSignOut(input: { baseUrl: string }): Promise<void>
ownerWebSocketUrl(input: { baseUrl: string }): Promise<string>
```

Sign-in is explicit, opens the OS browser, and waits for PKCE login and authenticated ticket capability validation before encrypted persistence. Never collect passwords in Companion. No fallback from failed owner login to static token identity. An unconfigured/older gateway rejects with `owner-auth-setup-required`.

`ownerWebSocketUrl` returns only a freshly minted, single-use `/api/ws?ticket=…` URL, NOT an access or refresh credential. Use immediately, never persist/log it, obtain a fresh URL on every reconnect. The requested normalized base must match the encrypted owner session. Renderer owns the socket and MUST disconnect it on sign-out, gateway changes, or owner-auth failure; no automatic silent escalation of an already-open legacy token socket. Server admission and server-derived permissions remain authoritative for `work.decide`; cached `signedIn` status only indicates saved credentials.

`ownerSignOut` cancels pending login/network work and deletes local encrypted owner credentials (does not log out the external browser or revoke other gateway sessions). It must remain available when storage is corrupt. New sign-in cancels an older pending attempt.

Rejections use fixed `Error.message` codes: `invalid-request`, `untrusted-renderer`, `invalid-gateway-url`, `owner-auth-setup-required`, `owner-auth-required`, `owner-auth-cancelled`, `owner-auth-timeout`, `owner-auth-failed`, `secure-storage-unavailable`. Native credentials and raw server errors never cross IPC.

HTTP owner authentication is accepted only for true loopback (`localhost`, `127.0.0.0/8`, or `::1`); every LAN, RFC1918, CGNAT/Tailscale, and public owner-auth endpoint requires HTTPS with platform certificate verification. Userinfo, queries, fragments, traversal/encoded path segments, WS protocols, and public cleartext gateways are rejected. Gateway reverse-proxy prefixes are preserved.
