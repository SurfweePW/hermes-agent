"""Companion owner-only persisted session RPC registration."""
from tui_gateway.companion_sessions import (
    CompanionSessionsError,
    continue_session,
    list_sessions,
    reconcile_session,
    session_history,
)
from tui_gateway.companion_session_create import create_session
from tui_gateway.transport import current_transport


def register(server) -> None:
    def wrap(operation, failure_code):
        def handler(rid, params):
            authorization = getattr(
                current_transport(), "companion_owner_authorization", None
            )
            try:
                return server._ok(
                    rid,
                    operation(
                        server,
                        params,
                        owner_authorization=authorization,
                    ),
                )
            except CompanionSessionsError as exc:
                return server._err(rid, exc.code, str(exc))
            except Exception:
                return server._err(rid, failure_code, "session operation unavailable")

        return handler

    server._methods["companion.sessions.list"] = wrap(list_sessions, 5062)
    server._methods["companion.sessions.history"] = wrap(session_history, 5063)
    server._methods["companion.sessions.continue"] = wrap(continue_session, 5064)
    server._methods["companion.sessions.reconcile"] = wrap(reconcile_session, 5065)
    server._methods["companion.sessions.create"] = wrap(create_session, 5066)

    def capabilities(rid, params):
        del params
        authorization = getattr(
            current_transport(), "companion_owner_authorization", None
        )
        try:
            # Validate the live lease on every call; transport authentication is
            # not a permanent authorization grant and may have expired/revoked.
            from tui_gateway.companion_sessions import _require_owner

            _require_owner(authorization)
            creation_available = all(
                callable(server._methods.get(name))
                for name in (
                    "companion.sessions.create",
                    "companion.sessions.reconcile",
                )
            )
            capabilities = {
                "companion.sessions": 1,
                "companion.library": getattr(
                    server, "_companion_library_capability", {"version": 0}
                ),
                "companion.topics": getattr(
                    server, "_companion_topics_capability", {"version": 0}
                ),
                "companion.organization": getattr(
                    server, "_companion_organization_capability", {"version": 0}
                ),
                "methods": sorted(
                    name
                    for name in server._methods
                    if name.startswith("companion.")
                    and name != "companion.capabilities"
                ),
            }
            if creation_available:
                capabilities["companion.sessions.create"] = {
                    "version": 1,
                    "receipt_version": 1,
                    "reconcile_by_request": True,
                    "explicit_null_project": True,
                }
            return server._ok(
                rid,
                capabilities,
            )
        except CompanionSessionsError as exc:
            return server._err(rid, exc.code, str(exc))
        except Exception:
            return server._err(rid, 5062, "session operation unavailable")

    server._methods["companion.capabilities"] = capabilities
