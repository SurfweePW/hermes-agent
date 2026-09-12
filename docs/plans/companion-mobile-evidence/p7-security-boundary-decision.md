# P7 remote privilege boundary decision

Status: chosen for design-v3 audit; no partial deployment permitted.

## Decision

All privileged RPCs over remote transports require a current, server-issued owner authorization bound to the served profile and transport. A shared gateway token is not an authorization source for privileged operations.

Trusted local stdio retains its existing local contract. Remote shared-token clients retain only explicitly classified non-privileged/read-only operations.

Remote Hermes Desktop is migrated to owner-ticket authorization for privileged requests in the same release candidate. The server change must not be deployed until the matching Desktop client path passes compatibility tests. There is no client-asserted trusted flag and no forgeable capability derived from a shared token.

## Required scope

The server-enforced method policy must inventory and classify at least session create/resume/submit/interrupt, approval pending/respond, Work decisions/comments/priorities, Library review pinning and download/preview access, attention, event replay, and outgoing stream/reply frames. Exact-target Companion Stop and approval operations remain required; securing only their new names is insufficient if generic methods bypass the boundary.

Revocation and lease expiry must stop subsequent privileged requests and queued outgoing application frames. Bytes already handed to the operating system cannot be recalled.

## Compatibility and rollout

- Preserve trusted local stdio behavior.
- Migrate every remote Desktop privileged call to owner-ticket authorization.
- Keep read-only shared-token compatibility only where the method classification explicitly permits it.
- Add deny tests for shared, missing, expired, revoked, wrong-owner and wrong-profile remote authorization.
- Add positive compatibility tests for local stdio and owner-authorized remote Desktop.
- Ship server and migrated remote clients as one candidate; no partial production rollout.
