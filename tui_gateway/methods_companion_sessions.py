"""Companion owner-only persisted session RPC registration."""
from tui_gateway.companion_sessions import (
    CompanionSessionsError,
    list_sessions,
    session_history,
)
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
            return server._ok(
                rid,
                {
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
                },
            )
        except CompanionSessionsError as exc:
            return server._err(rid, exc.code, str(exc))
        except Exception:
            return server._err(rid, 5062, "session operation unavailable")

    server._methods["companion.capabilities"] = capabilities
