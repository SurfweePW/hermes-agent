"""Companion owner-only Library RPC registration."""
from tui_gateway.companion_library import (
    MAX_CHUNK_SIZE,
    MAX_PAGE_SIZE,
    CompanionLibraryError,
    execute,
)
from tui_gateway.transport import current_transport


def _capability() -> dict:
    return {
        "version": 1,
        "max_page_size": MAX_PAGE_SIZE,
        "max_chunk_size": MAX_CHUNK_SIZE,
        "download_transport": "authenticated_json_rpc_base64_chunks",
        "transfer_consistency": "signed_immutable_descriptor",
        "html_preview": "sanitized_static_document",
        "relationship_filters": ["collection", "project", "topic", "session", "status"],
        "evidence_pin": "explicit_owner_reviewed_latest",
    }


def register(server) -> None:
    def capabilities(rid, params):
        if params not in ({}, None):
            return server._err(rid, -32602, "parameters must be an empty object")
        return server._ok(rid, _capability())

    server._methods["companion.library.capabilities"] = capabilities
    for operation in ("profiles", "list", "get", "preview", "download", "pin_reviewed"):
        def handler(rid, params, operation=operation):
            transport = current_transport()
            authorization = getattr(transport, "companion_owner_authorization", None)
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
            except CompanionLibraryError as exc:
                return server._err(rid, exc.code, str(exc))
            except Exception:
                # Unexpected core/config errors can contain local paths. Never
                # serialize them across the RPC boundary.
                return server._err(rid, 5064, "library operation unavailable")

        server._methods[f"companion.library.{operation}"] = handler

    # Exposed for aggregate capability negotiation without importing internals.
    server._companion_library_capability = _capability()
