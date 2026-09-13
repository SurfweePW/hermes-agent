"""Authenticated owner organization mutations for Companion.

The transport authorization is the sole source of actor identity. Client
payloads can describe organization data, but cannot select an actor, profile
outside the gateway allowlist, or a source namespace outside this backend.
"""
from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any, Mapping

from hermes_cli.companion_organization import (
    BusinessProject,
    Capture,
    OrganizationError,
    OrganizationStore,
    PriorityOverride,
    SourceNamespace,
    SourceProjectRef,
    SourceSessionRef,
    Topic,
    WorkBinding,
)
from tui_gateway.companion_errors import OWNER_AUTHORIZATION_REQUIRED_CODE
from tui_gateway.companion_projects import _backend_namespace
from tui_gateway.companion_topics import (
    CompanionTopicsError,
    _owner_authorized_profiles,
    _profile,
    _require_owner,
)


class CompanionOrganizationMutationError(Exception):
    """Stable client-facing error for an organization mutation."""

    def __init__(self, message: str, code: int):
        super().__init__(message)
        self.code = code


_MUTATION_METHODS = (
    "companion.topics.create",
    "companion.topics.update",
    "companion.topics.set_lifecycle",
    "companion.bindings.upsert",
    "companion.bindings.remove",
    "companion.priorities.override_set",
    "companion.priorities.restore_recommended",
)
_RECORD_MUTATION_METHODS = (
    "companion.business_projects.create",
    "companion.business_projects.update",
    "companion.business_projects.set_lifecycle",
    "companion.source_projects.upsert",
    "companion.source_projects.create",
    "companion.source_projects.update",
    "companion.source_projects.remove",
    "companion.source_sessions.upsert",
    "companion.source_sessions.create",
    "companion.source_sessions.update",
    "companion.source_sessions.remove",
    "companion.captures.create",
)


def capability() -> dict[str, Any]:
    return {
        "version": 2,
        "operations": ["needs_me"],
        "read_only": False,
        "sort": "recommended",
        "policy_version": "policy-v1",
        "mutation_methods": list(_MUTATION_METHODS),
        "record_mutation_methods": list(_RECORD_MUTATION_METHODS),
        "owner_authorization": True,
        "optimistic_concurrency": "expected_version",
        "idempotency": "actor_scoped_key",
        "audit": True,
    }


def _launch_home() -> Path:
    from tui_gateway.companion_library import _launch_home as launch_home

    return Path(launch_home())


def _store(path: Path, profile: str) -> OrganizationStore:
    return OrganizationStore(path=path, profile=profile)


def _params(value: Any, allowed: set[str]) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise CompanionOrganizationMutationError("parameters must be an object", -32602)
    result = dict(value)
    unknown = set(result) - allowed
    if unknown:
        raise CompanionOrganizationMutationError("unsupported organization parameter", -32602)
    return result


def _required_text(value: Any, field: str, maximum: int = 500) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > maximum
    ):
        raise CompanionOrganizationMutationError(f"invalid {field}", -32602)
    return value


def _optional_text(value: Any, field: str, maximum: int = 500) -> str | None:
    if value is None:
        return None
    return _required_text(value, field, maximum)


def _version(value: Any, *, create_only: bool = False) -> int:
    if type(value) is not int or value < 0:
        raise CompanionOrganizationMutationError(
            "expected_version must be a non-negative integer", -32602
        )
    if create_only and value != 0:
        raise CompanionOrganizationMutationError(
            "expected_version must be 0 when creating", 4090
        )
    return value


def _request_key(value: Any) -> str:
    return _required_text(value, "idempotency_key", 200)


def _namespace(value: Any) -> SourceNamespace:
    if not isinstance(value, Mapping) or set(value) != {"backend_id", "profile"}:
        raise CompanionOrganizationMutationError("invalid source reference", -32602)
    try:
        return SourceNamespace(value["backend_id"], value["profile"])
    except (KeyError, TypeError, OrganizationError) as exc:
        raise CompanionOrganizationMutationError("invalid source reference", -32602) from exc


def _session(value: Any) -> SourceSessionRef:
    if not isinstance(value, Mapping) or set(value) - {
        "namespace",
        "persisted_session_id",
        "lineage_root_id",
        "resolved_tip_id",
    }:
        raise CompanionOrganizationMutationError("invalid session reference", -32602)
    try:
        return SourceSessionRef(
            _namespace(value["namespace"]),
            value["persisted_session_id"],
            value["lineage_root_id"],
            value.get("resolved_tip_id"),
        )
    except (KeyError, TypeError, OrganizationError) as exc:
        raise CompanionOrganizationMutationError("invalid session reference", -32602) from exc


def _project(value: Any) -> SourceProjectRef:
    if not isinstance(value, Mapping) or set(value) != {"namespace", "source_id", "kind"}:
        raise CompanionOrganizationMutationError("invalid project reference", -32602)
    try:
        return SourceProjectRef(
            _namespace(value["namespace"]), value["source_id"], value["kind"]
        )
    except (KeyError, TypeError, OrganizationError) as exc:
        raise CompanionOrganizationMutationError("invalid project reference", -32602) from exc


def _authorize_reference(
    namespace: SourceNamespace,
    *,
    backend: str,
    profiles: frozenset[str],
) -> None:
    if namespace.backend_id != backend or namespace.profile not in profiles:
        # Never reveal which backend/profile component failed.
        raise CompanionOrganizationMutationError("source reference unavailable", 4403)


def _authorize_references(
    value: Topic | WorkBinding,
    *,
    backend: str,
    profiles: frozenset[str],
) -> None:
    references: list[SourceNamespace] = []
    if isinstance(value, Topic):
        if value.primary_project is not None:
            references.append(value.primary_project.namespace)
    else:
        assert value.source_namespace is not None
        references.append(value.source_namespace)
        if value.primary_session is not None:
            references.append(value.primary_session.namespace)
        references.extend(item.namespace for item in value.related_sessions)
        references.extend(item.namespace for item in value.source_projects)
    for namespace in references:
        _authorize_reference(namespace, backend=backend, profiles=profiles)


def _topic(params: Mapping[str, Any], *, lifecycle: str | None = None) -> Topic:
    primary = params.get("primary_project")
    try:
        return Topic(
            id=params["id"],
            collection=params["collection"],
            name=params["name"],
            objective=params["objective"],
            primary_project=_project(primary) if primary is not None else None,
            lifecycle=lifecycle if lifecycle is not None else params.get("lifecycle", "active"),
            primary_business_project_id=params.get("primary_business_project_id"),
        )
    except (KeyError, TypeError, OrganizationError) as exc:
        raise CompanionOrganizationMutationError("invalid topic", -32602) from exc


def _binding(params: Mapping[str, Any], actor: str) -> WorkBinding:
    try:
        primary_session = params.get("primary_session")
        related_sessions = params.get("related_sessions", [])
        related_topics = params.get("related_topic_ids", [])
        source_projects = params.get("source_projects", [])
        related_business_projects = params.get("related_business_project_ids", [])
        if not isinstance(related_sessions, list) or not isinstance(related_topics, list):
            raise TypeError
        if not isinstance(source_projects, list) or not isinstance(
            related_business_projects, list
        ):
            raise TypeError
        return WorkBinding(
            id=params["id"],
            source_namespace=_namespace(params["source_namespace"]),
            work_kind=params["work_kind"],
            source_work_id=params["source_work_id"],
            primary_topic_id=params.get("primary_topic_id"),
            primary_session=_session(primary_session) if primary_session is not None else None,
            related_sessions=tuple(_session(item) for item in related_sessions),
            related_topic_ids=tuple(related_topics),
            source_projects=tuple(_project(item) for item in source_projects),
            # Deliberately disregard the client display value. Authorization is
            # server-derived and is also what the durable audit records.
            attributed_by=actor,
            primary_business_project_id=params.get("primary_business_project_id"),
            related_business_project_ids=tuple(related_business_projects),
        )
    except (KeyError, TypeError, OrganizationError) as exc:
        raise CompanionOrganizationMutationError("invalid work binding", -32602) from exc


def _override(params: Mapping[str, Any], actor: str) -> PriorityOverride:
    try:
        return PriorityOverride(
            id=params["id"],
            target_id=params["target_id"],
            mode=params["mode"],
            label=params["label"],
            actor=actor,
            reason=params["reason"],
            expires_at=params.get("expires_at"),
            review_id=params.get("review_id"),
            review_at=params.get("review_at"),
        )
    except (KeyError, TypeError, OrganizationError) as exc:
        raise CompanionOrganizationMutationError("invalid priority override", -32602) from exc


def _business_project(
    params: Mapping[str, Any], *, lifecycle: str | None = None
) -> BusinessProject:
    try:
        return BusinessProject(
            id=params["id"],
            collection=params["collection"],
            name=params["name"],
            objective=params["objective"],
            lifecycle=lifecycle if lifecycle is not None else params.get("lifecycle", "active"),
        )
    except (KeyError, TypeError, OrganizationError) as exc:
        raise CompanionOrganizationMutationError(
            "invalid business project", -32602
        ) from exc


def _capture(params: Mapping[str, Any], actor: str) -> Capture:
    source = params.get("source_session")
    try:
        return Capture(
            id=params["id"],
            source_session=_session(source) if source is not None else None,
            title_at_capture=params["title_at_capture"],
            captured_at=params["captured_at"],
            verified_deep_link=params.get("verified_deep_link"),
            created_by=actor,
        )
    except (KeyError, TypeError, OrganizationError) as exc:
        raise CompanionOrganizationMutationError("invalid capture", -32602) from exc


def _validate_topic_links(store: OrganizationStore, value: WorkBinding) -> None:
    ids = set(value.related_topic_ids)
    if value.primary_topic_id is not None:
        ids.add(value.primary_topic_id)
    for topic_id in ids:
        try:
            store.get_topic(topic_id)
        except OrganizationError as exc:
            # This also prevents linking to a deleted/tombstoned topic.
            raise CompanionOrganizationMutationError("topic reference unavailable", 4090) from exc


def _validate_business_project_links(
    store: OrganizationStore, value: Topic | WorkBinding
) -> None:
    ids: set[str] = set()
    if isinstance(value, Topic):
        if value.primary_business_project_id is not None:
            ids.add(value.primary_business_project_id)
    else:
        if value.primary_business_project_id is not None:
            ids.add(value.primary_business_project_id)
        ids.update(value.related_business_project_ids)
    for project_id in ids:
        try:
            store.get_business_project(project_id)
        except OrganizationError as exc:
            raise CompanionOrganizationMutationError(
                "business project reference unavailable", 4090
            ) from exc


def _context(server: Any, params: Mapping[str, Any], authorization: Any):
    try:
        actor = _require_owner(authorization)
    except Exception as exc:
        raise CompanionOrganizationMutationError(
            "authenticated dashboard owner required", OWNER_AUTHORIZATION_REQUIRED_CODE
        ) from exc
    try:
        profile, home = _profile(server, params.get("profile"))
        profiles = _owner_authorized_profiles(server)
        backend = _backend_namespace(server, installation_home=_launch_home())
    except CompanionTopicsError as exc:
        raise CompanionOrganizationMutationError(str(exc), exc.code) from exc
    except Exception as exc:
        raise CompanionOrganizationMutationError("organization profile unavailable", 4403) from exc
    if profile not in profiles:
        raise CompanionOrganizationMutationError("organization profile unavailable", 4403)
    return actor, profile, home, profiles, backend


def _translate_store_error(exc: OrganizationError) -> CompanionOrganizationMutationError:
    message = str(exc)
    if any(
        marker in message
        for marker in (
            "stale organization version",
            "already exists",
            "idempotency key reused",
            "not found",
            "audit history",
        )
    ):
        return CompanionOrganizationMutationError(message, 4090)
    if any(marker in message for marker in ("safe", "migration", "schema", "database")):
        return CompanionOrganizationMutationError("organization storage unavailable", 5065)
    return CompanionOrganizationMutationError(message, -32602)


def _record(value: Any) -> dict[str, Any]:
    """Return the public record plus its stable organization identity."""
    return {**value.to_dict(), "canonical_id": value.canonical_id}


def execute(
    server: Any,
    operation: str,
    raw_params: Any,
    *,
    owner_authorization: Any,
) -> dict[str, Any]:
    common = {"profile", "expected_version", "idempotency_key"}
    fields = {
        "companion.topics.create": common
        | {
            "id", "collection", "name", "objective", "primary_project",
            "primary_business_project_id", "lifecycle",
        },
        "companion.topics.update": common
        | {
            "id", "collection", "name", "objective", "primary_project",
            "primary_business_project_id", "lifecycle",
        },
        "companion.topics.set_lifecycle": common | {"id", "lifecycle"},
        "companion.bindings.upsert": common
        | {
            "id",
            "source_namespace",
            "work_kind",
            "source_work_id",
            "primary_topic_id",
            "primary_session",
            "related_sessions",
            "related_topic_ids",
            "source_projects",
            "primary_business_project_id",
            "related_business_project_ids",
            "attributed_by",
        },
        "companion.bindings.remove": common | {"id"},
        "companion.priorities.override_set": common
        | {
            "id",
            "target_id",
            "mode",
            "label",
            "reason",
            "expires_at",
            "review_id",
            "review_at",
            "actor",
        },
        "companion.priorities.restore_recommended": common | {"id"},
        "companion.business_projects.create": common
        | {"id", "collection", "name", "objective", "lifecycle"},
        "companion.business_projects.update": common
        | {"id", "collection", "name", "objective", "lifecycle"},
        "companion.business_projects.set_lifecycle": common | {"id", "lifecycle"},
        "companion.source_projects.upsert": common
        | {"namespace", "source_id", "kind"},
        "companion.source_projects.create": common
        | {"namespace", "source_id", "kind"},
        "companion.source_projects.update": common
        | {"namespace", "source_id", "kind"},
        "companion.source_projects.remove": common
        | {"namespace", "source_id", "kind"},
        "companion.source_sessions.upsert": common
        | {
            "namespace",
            "persisted_session_id",
            "lineage_root_id",
            "resolved_tip_id",
        },
        "companion.source_sessions.create": common
        | {
            "namespace",
            "persisted_session_id",
            "lineage_root_id",
            "resolved_tip_id",
        },
        "companion.source_sessions.update": common
        | {
            "namespace",
            "persisted_session_id",
            "lineage_root_id",
            "resolved_tip_id",
        },
        "companion.source_sessions.remove": common
        | {
            "namespace",
            "persisted_session_id",
            "lineage_root_id",
            "resolved_tip_id",
        },
        "companion.captures.create": common
        | {
            "id",
            "source_session",
            "title_at_capture",
            "captured_at",
            "verified_deep_link",
            "created_by",
        },
    }
    if operation not in fields:
        raise CompanionOrganizationMutationError("unknown organization mutation", -32601)
    params = _params(raw_params, fields[operation])
    # Owner admission and profile authorization intentionally happen before
    # constructing OrganizationStore (which may create/migrate a database).
    actor, profile, home, profiles, backend = _context(
        server, params, owner_authorization
    )
    expected = _version(params.get("expected_version"))
    key = _request_key(params.get("idempotency_key"))
    source_creates = {
        "companion.source_projects.create",
        "companion.source_sessions.create",
    }
    source_existing = {
        "companion.source_projects.update",
        "companion.source_projects.remove",
        "companion.source_sessions.update",
        "companion.source_sessions.remove",
    }
    if operation in source_creates and expected != 0:
        raise CompanionOrganizationMutationError(
            "expected_version must be 0 when creating", 4090
        )
    if operation in {
        "companion.topics.update",
        "companion.business_projects.update",
    } | source_existing and expected == 0:
        raise CompanionOrganizationMutationError(
            "expected_version must identify an existing record", 4090
        )
    request = dict(params)
    request.pop("actor", None)
    request.pop("attributed_by", None)
    request.pop("created_by", None)
    request["server_actor"] = actor
    source_project = None
    source_session = None
    if operation.startswith("companion.source_projects."):
        source_project = _project(
            {name: params[name] for name in ("namespace", "source_id", "kind")}
        )
        _authorize_reference(
            source_project.namespace, backend=backend, profiles=profiles
        )
    elif operation.startswith("companion.source_sessions."):
        source_session = _session(
            {
                name: params.get(name)
                for name in (
                    "namespace",
                    "persisted_session_id",
                    "lineage_root_id",
                    "resolved_tip_id",
                )
                if name in params
            }
        )
        _authorize_reference(
            source_session.namespace, backend=backend, profiles=profiles
        )
    store_path = home / "organization.db"
    try:
        store = _store(store_path, profile)
        if operation in {
            "companion.business_projects.create",
            "companion.business_projects.update",
        }:
            if operation.endswith("create") and expected != 0:
                raise CompanionOrganizationMutationError(
                    "expected_version must be 0 when creating", 4090
                )
            project = _business_project(params)
            record, replay = store.owner_mutation(
                operation,
                project,
                expected_version=expected,
                idempotency_key=key,
                request=request,
                actor=actor,
            )
            return {"record": _record(record), "idempotent": replay}
        if operation == "companion.business_projects.set_lifecycle":
            project_id = _required_text(params.get("id"), "id", 200)
            lifecycle = params.get("lifecycle")
            if lifecycle not in {"active", "completed", "archived"}:
                raise CompanionOrganizationMutationError("invalid lifecycle", -32602)
            current = store.get_business_project(project_id)
            project = replace(current, lifecycle=lifecycle)
            record, replay = store.owner_mutation(
                operation,
                project,
                expected_version=expected,
                idempotency_key=key,
                request=request,
                actor=actor,
            )
            return {"record": _record(record), "idempotent": replay}
        if operation in {
            "companion.source_projects.upsert",
            "companion.source_projects.create",
            "companion.source_projects.update",
            "companion.source_projects.remove",
        }:
            assert source_project is not None
            if operation == "companion.source_projects.remove":
                record, replay = store.owner_remove(
                    operation,
                    "source_project",
                    source_project.canonical_id,
                    expected_version=expected,
                    idempotency_key=key,
                    request=request,
                    actor=actor,
                )
                return {
                    "record": _record(record),
                    "removed": True,
                    "idempotent": replay,
                }
            record, replay = store.owner_mutation(
                operation,
                source_project,
                expected_version=expected,
                idempotency_key=key,
                request=request,
                actor=actor,
            )
            return {"record": _record(record), "idempotent": replay}
        if operation in {
            "companion.source_sessions.upsert",
            "companion.source_sessions.create",
            "companion.source_sessions.update",
            "companion.source_sessions.remove",
        }:
            assert source_session is not None
            if operation == "companion.source_sessions.remove":
                record, replay = store.owner_remove(
                    operation,
                    "source_session",
                    source_session.canonical_id,
                    expected_version=expected,
                    idempotency_key=key,
                    request=request,
                    actor=actor,
                )
                return {
                    "record": _record(record),
                    "removed": True,
                    "idempotent": replay,
                }
            record, replay = store.owner_mutation(
                operation,
                source_session,
                expected_version=expected,
                idempotency_key=key,
                request=request,
                actor=actor,
            )
            return {"record": _record(record), "idempotent": replay}
        if operation == "companion.captures.create":
            if expected != 0:
                raise CompanionOrganizationMutationError(
                    "expected_version must be 0 when creating", 4090
                )
            capture = _capture(params, actor)
            if capture.source_session is not None:
                _authorize_reference(
                    capture.source_session.namespace,
                    backend=backend,
                    profiles=profiles,
                )
            record, replay = store.owner_mutation(
                operation,
                capture,
                expected_version=expected,
                idempotency_key=key,
                request=request,
                actor=actor,
            )
            return {"record": _record(record), "idempotent": replay}
        if operation in {"companion.topics.create", "companion.topics.update"}:
            if operation.endswith("create") and expected != 0:
                raise CompanionOrganizationMutationError(
                    "expected_version must be 0 when creating", 4090
                )
            topic = _topic(params)
            _authorize_references(topic, backend=backend, profiles=profiles)
            _validate_business_project_links(store, topic)
            record, replay = store.owner_mutation(
                operation,
                topic,
                expected_version=expected,
                idempotency_key=key,
                request=request,
                actor=actor,
            )
            return {"record": _record(record), "idempotent": replay}
        if operation == "companion.topics.set_lifecycle":
            topic_id = _required_text(params.get("id"), "id", 200)
            lifecycle = params.get("lifecycle")
            if lifecycle not in {"active", "completed", "archived"}:
                raise CompanionOrganizationMutationError("invalid lifecycle", -32602)
            current = store.get_topic(topic_id)
            topic = replace(current, lifecycle=lifecycle)
            record, replay = store.owner_mutation(
                operation,
                topic,
                expected_version=expected,
                idempotency_key=key,
                request=request,
                actor=actor,
            )
            return {"record": _record(record), "idempotent": replay}
        if operation == "companion.bindings.upsert":
            binding = _binding(params, actor)
            _authorize_references(binding, backend=backend, profiles=profiles)
            _validate_topic_links(store, binding)
            _validate_business_project_links(store, binding)
            record, replay = store.owner_mutation(
                operation,
                binding,
                expected_version=expected,
                idempotency_key=key,
                request=request,
                actor=actor,
            )
            return {"record": _record(record), "idempotent": replay}
        if operation == "companion.bindings.remove":
            record, replay = store.owner_remove(
                operation,
                "work_binding",
                _required_text(params.get("id"), "id", 200),
                expected_version=expected,
                idempotency_key=key,
                request=request,
                actor=actor,
            )
            return {
                "record": _record(record),
                "removed": True,
                "idempotent": replay,
            }
        if operation == "companion.priorities.override_set":
            override = _override(params, actor)
            record, replay = store.owner_mutation(
                operation,
                override,
                expected_version=expected,
                idempotency_key=key,
                request=request,
                actor=actor,
            )
            return {"record": _record(record), "idempotent": replay}
        record, replay = store.owner_remove(
            operation,
            "priority_override",
            _required_text(params.get("id"), "id", 200),
            expected_version=expected,
            idempotency_key=key,
            request=request,
            actor=actor,
        )
        return {
            "record": _record(record),
            "restored": True,
            "idempotent": replay,
        }
    except CompanionOrganizationMutationError:
        raise
    except OrganizationError as exc:
        raise _translate_store_error(exc) from exc
    except OSError as exc:
        raise CompanionOrganizationMutationError(
            "organization storage unavailable", 5065
        ) from exc
