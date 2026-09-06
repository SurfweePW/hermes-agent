"""Companion owner-only organization priority RPC registration."""
from tui_gateway.companion_priorities import CompanionPrioritiesError, execute
from tui_gateway.transport import current_transport


def _capability() -> dict:
    return {
        "version": 1,
        "operations": ["needs_me"],
        "read_only": True,
        "sort": "recommended",
        "policy_version": "policy-v1",
    }


def register(server) -> None:
    def capabilities(rid, params):
        if params not in ({}, None):
            return server._err(rid, -32602, "parameters must be an empty object")
        return server._ok(rid, _capability())

    def needs_me(rid, params):
        authorization = getattr(
            current_transport(), "companion_owner_authorization", None
        )
        try:
            return server._ok(
                rid,
                execute(server, params, owner_authorization=authorization),
            )
        except CompanionPrioritiesError as exc:
            return server._err(rid, exc.code, str(exc))
        except Exception:
            return server._err(rid, 5065, "Needs Me priority operation unavailable")

    server._methods["companion.organization.capabilities"] = capabilities
    server._methods["companion.organization.needs_me"] = needs_me
    server._companion_organization_capability = _capability()
