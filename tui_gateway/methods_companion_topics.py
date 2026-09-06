"""Companion owner-only Topics RPC registration."""
from tui_gateway.companion_topics import (
    MAX_PAGE_SIZE,
    CompanionTopicsError,
    execute,
)
from tui_gateway.transport import current_transport


def _capability() -> dict:
    return {
        "version": 1,
        "max_page_size": MAX_PAGE_SIZE,
        "operations": ["list", "get"],
        "pagination": "signed_snapshot_cursor",
        "read_only": True,
    }


def register(server) -> None:
    def capabilities(rid, params):
        if params not in ({}, None):
            return server._err(rid, -32602, "parameters must be an empty object")
        return server._ok(rid, _capability())

    server._methods["companion.topics.capabilities"] = capabilities
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
            except CompanionTopicsError as exc:
                return server._err(rid, exc.code, str(exc))
            except Exception:
                return server._err(rid, 5065, "topics operation unavailable")

        server._methods[f"companion.topics.{operation}"] = handler

    server._companion_topics_capability = _capability()
