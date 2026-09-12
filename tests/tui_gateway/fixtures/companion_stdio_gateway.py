"""Test-only authenticated stdio launcher for Companion transport tests."""
from __future__ import annotations

import os
from typing import Any

from hermes_cli.dashboard_auth.ws_tickets import OwnerAuthorizationLease
from tui_gateway import companion_library, entry, server
from tui_gateway.transport import Transport


# Companion is WebSocket-owner-only in production.  The integration harness uses
# the production stdio entrypoint, so attach the same server-minted lease shape to
# that transport without adding a production bypass.
class OwnerStdioTransport(Transport):
    def __init__(self, delegate: Transport) -> None:
        self.delegate = delegate
        self.companion_owner_authorization = OwnerAuthorizationLease(
            "basic:transport-test-owner", float("inf")
        )

    def write(self, obj: dict) -> bool:
        return self.delegate.write(obj)

    def close(self) -> None:
        self.delegate.close()


server._stdio_transport = OwnerStdioTransport(server._stdio_transport)
companion_library._owner_identity = lambda identity: (
    identity if identity == "basic:transport-test-owner" else None
)

# The existing synthetic agent deliberately has no persistence surface because
# its isolation benchmark only measures GIL pressure.  For this transport gate,
# attach the real SessionDB passed by session.resume and persist the deterministic
# user/assistant pair at completion, matching the side effect of AIAgent without
# invoking a provider or tool.
_make_agent = server._make_agent


def _make_persistent_synthetic_agent(*args, session_db=None, **kwargs):
    agent: Any = _make_agent(*args, session_db=session_db, **kwargs)
    setattr(agent, "_session_db", session_db if session_db is not None else server._get_db())
    setattr(agent, "_owns_session_db", False)
    run_conversation = agent.run_conversation

    def run_and_persist(message, **run_kwargs):
        result = run_conversation(message, **run_kwargs)
        if not result.get("interrupted"):
            persisted_user = run_kwargs.get("persist_user_message", message)
            agent._session_db.append_message(agent.session_id, "user", persisted_user)
            agent._session_db.append_message(
                agent.session_id, "assistant", result["final_response"]
            )
        return result

    setattr(agent, "run_conversation", run_and_persist)
    return agent


server._make_agent = _make_persistent_synthetic_agent

# --- Test-only observability and crash boundaries (inert unless env vars set) ---
# The final subprocess matrix (docs/plans/companion-mobile-evidence/p4-current-design-v2.md
# section 10) needs external, append-only counters for create entry, submit entry and agent
# build, plus the ability to die at a real boundary.  Nothing here changes production
# behaviour: with the env vars absent these wrappers are pass-throughs.
_EVENTS_FILE = os.environ.get("HERMES_COMPANION_TEST_EVENTS_FILE")
_HALT_AT = os.environ.get("HERMES_COMPANION_TEST_HALT_AT")


def _record(event: str, detail: str = "") -> None:
    if not _EVENTS_FILE:
        return
    handle = os.open(_EVENTS_FILE, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(handle, f"{event} {detail}\n".encode("utf-8"))
    finally:
        os.close(handle)


def _halt_if(point: str, detail: str = "") -> None:
    if _HALT_AT == point:
        _record(f"halt {point}", detail)
        os._exit(9)


_invoke_reserved_session_create = server._invoke_reserved_session_create


def _counted_invoke_reserved_session_create(reserved, *, rid=None):
    _record("create_entry")
    _halt_if("create_entry")
    return _invoke_reserved_session_create(reserved, rid=rid)


server._invoke_reserved_session_create = _counted_invoke_reserved_session_create

_claim_active_session_slot = server._claim_active_session_slot


def _counted_claim_active_session_slot(*args, **kwargs):
    lease, refusal = _claim_active_session_slot(*args, **kwargs)
    if kwargs.get("strict_reservation") and lease is not None:
        _record("reservation_acquired", str(getattr(lease, "session_id", "")))
    return lease, refusal


server._claim_active_session_slot = _counted_claim_active_session_slot

_rollback_creation_reservation = server._rollback_creation_reservation


def _counted_rollback_creation_reservation(lease):
    result = _rollback_creation_reservation(lease)
    if result is None:
        _record("reservation_released", str(getattr(lease, "session_id", "")))
    return result


server._rollback_creation_reservation = _counted_rollback_creation_reservation

_submit_prompt = server._methods["prompt.submit"]


def _counted_submit_prompt(rid, params):
    _record("submit_entry")
    _halt_if("submit_entry")
    return _submit_prompt(rid, params)


server._methods["prompt.submit"] = _counted_submit_prompt

_agent_factory = server._make_agent


def _counted_make_agent(*args, **kwargs):
    _record("agent_build")
    _halt_if("agent_build")
    return _agent_factory(*args, **kwargs)


server._make_agent = _counted_make_agent

# Keep the subprocess deterministic and offline.  These startup auxiliaries are
# unrelated to JSON-RPC dispatch, session persistence, or turn execution.
entry.ensure_mcp_discovery_started = lambda: None
setattr(server, "_start_backend_heartbeat_refresher", lambda: None)
setattr(server, "_schedule_startup_orphan_sweep", lambda: None)
setattr(server, "_ensure_skin_watcher", lambda: None)

import hermes_cli.model_switch_providers as model_switch_providers

model_switch_providers.prewarm_picker_cache_async = lambda: None


if __name__ == "__main__":
    entry.main()
