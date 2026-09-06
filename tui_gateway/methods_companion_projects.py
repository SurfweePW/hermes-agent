"""Companion owner-only project directory/detail RPC registration."""
from tui_gateway.companion_projects import CompanionProjectsError, execute
from tui_gateway.transport import current_transport


def register(server) -> None:
    for operation in ("list", "get"):
        def handler(rid, params, operation=operation):
            authorization = getattr(
                current_transport(), "companion_owner_authorization", None
            )
            try:
                return server._ok(
                    rid,
                    execute(
                        server,
                        operation,
                        params,
                        owner_authorization=authorization,
                    ),
                )
            except CompanionProjectsError as exc:
                return server._err(rid, exc.code, str(exc))
            except Exception:
                return server._err(rid, 5061, "project operation unavailable")

        server._methods[f"companion.projects.{operation}"] = handler
