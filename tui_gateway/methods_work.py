"""Companion business inbox RPCs; separate from runtime tool permissions."""
from hermes_cli.companion_work import FIELDS, execute
from hermes_cli.companion_work_store import WorkError
from tui_gateway.transport import current_transport


def register(server):
    # Unlike the legacy mechanical split, these handlers close over their
    # dependencies explicitly; no rebinding or process-global identity.
    for operation in FIELDS:
        def handler(rid, params, operation=operation):
            transport = current_transport()
            authorization = getattr(transport, 'companion_owner_authorization', None)
            try:
                return server._ok(
                    rid,
                    execute(operation, params, owner_authorization=authorization),
                )
            except WorkError as exc:
                return server._err(rid, exc.code, str(exc))
        server._methods['work.' + operation] = handler
