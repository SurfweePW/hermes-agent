"""Server-owned projection from durable Work bindings to runtime Attention."""
from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

from hermes_cli.companion_organization import OrganizationStore, SourceNamespace, WorkBinding
from hermes_cli.companion_work_store_readonly import existing_card_ids
from tui_gateway.companion_projects import _backend_namespace


def _runtime_profile_home(server, session: Mapping[str, Any]) -> tuple[str, Path] | None:
    launch_home = Path(server._hermes_home).resolve(strict=True)
    current_profile = str(server._current_profile_name() or "default")
    raw_home = session.get("profile_home")
    if not raw_home:
        return current_profile, launch_home

    supplied = Path(str(raw_home)).resolve(strict=True)
    profile = supplied.name
    if profile == current_profile and supplied == launch_home:
        return profile, supplied
    expected = server._profile_home(profile)
    if expected is None or Path(expected).resolve(strict=True) != supplied:
        return None
    return profile, supplied


def derive_attention_work_ref(server, session: Mapping[str, Any]) -> dict[str, str] | None:
    """Prove one exact profile-local Work card for a live persisted session."""
    try:
        stored_session_id = session.get("session_key")
        if not isinstance(stored_session_id, str) or not stored_session_id:
            return None
        resolved = _runtime_profile_home(server, session)
        if resolved is None:
            return None
        profile, home = resolved
        from tui_gateway.companion_library import _launch_home

        backend = _backend_namespace(server, installation_home=_launch_home())
        namespace = SourceNamespace(backend, profile)
        records = OrganizationStore.list_existing(
            home / "organization.db",
            profile=profile,
            record_types=("work_binding",),
        )
        if records is None:
            return None

        candidate_ids = set()
        for binding in records:
            if (
                not isinstance(binding, WorkBinding)
                or binding.work_kind != "companion_card"
                or binding.source_namespace != namespace
            ):
                continue
            references = (*binding.related_sessions,)
            if binding.primary_session is not None:
                references = (binding.primary_session, *references)
            if any(
                reference.namespace == namespace
                and reference.persisted_session_id == stored_session_id
                for reference in references
            ):
                candidate_ids.add(binding.source_work_id)
        if not candidate_ids:
            return None
        matches = existing_card_ids(
            home / "companion-work.db", profile, candidate_ids
        )
        if matches is None or len(matches) != 1:
            return None
        return {"profile": profile, "id": next(iter(matches))}
    except Exception:
        # Attention visibility must survive stale, malformed, or unavailable durable stores.
        return None