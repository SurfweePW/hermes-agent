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
                if isinstance(params, dict) and 'profile' in params:
                    # An existing sibling is not sufficient authority: Work may
                    # only address profiles this gateway was configured to serve.
                    from hermes_cli.profiles import validate_profile_name
                    from tui_gateway.companion_topics import _owner_authorized_profiles

                    profile = params['profile']
                    try:
                        validate_profile_name(profile)
                    except (TypeError, ValueError):
                        pass  # execute() returns the canonical parameter error
                    else:
                        try:
                            served_profiles = _owner_authorized_profiles(server)
                        except Exception as exc:
                            raise WorkError('work profile unavailable', 4403) from exc
                        if profile not in served_profiles:
                            raise WorkError('work profile unavailable', 4403)
                return server._ok(
                    rid,
                    execute(operation, params, owner_authorization=authorization),
                )
            except WorkError as exc:
                return server._err(rid, exc.code, str(exc))
        server._methods['work.' + operation] = handler
