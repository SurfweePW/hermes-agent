"""Shared machine-readable Companion authorization error codes."""

# Transport-level owner lease failures are distinct from profile/artifact
# authorization failures, which deliberately remain 4403 at their boundaries.
OWNER_AUTHORIZATION_REQUIRED_CODE = 4401
