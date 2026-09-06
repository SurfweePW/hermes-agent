"""Secure read-only Companion Topics directory and detail projection."""
from __future__ import annotations

import base64
import binascii
from collections import OrderedDict
from datetime import datetime, timezone
import hashlib
import hmac
import json
from pathlib import Path
import secrets
import threading
import time
from typing import Any, Mapping

from hermes_cli.companion_organization import (
    OrganizationError,
    OrganizationStore,
    OutcomeAssessment,
    Topic,
    WorkBinding,
)
from tui_gateway.companion_projects import _backend_namespace

DEFAULT_PAGE_SIZE = 100
MAX_PAGE_SIZE = 500
_CURSOR_FALLBACK_KEY = secrets.token_bytes(32)
_SNAPSHOT_TTL = 15 * 60
_SNAPSHOT_MAX = 64
_SNAPSHOTS: OrderedDict[str, dict[str, Any]] = OrderedDict()
_SNAPSHOT_LOCK = threading.Lock()


class CompanionTopicsError(Exception):
    def __init__(self, message: str, code: int):
        super().__init__(message)
        self.code = code


def _as_of() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _require_owner(owner_authorization) -> str:
    # Keep owner admission and live revocation semantics identical to Library,
    # but never leak another RPC module's exception type through this boundary.
    from tui_gateway.companion_library import _require_owner as require_owner

    try:
        return require_owner(owner_authorization)
    except Exception as exc:
        raise CompanionTopicsError("authenticated dashboard owner required", 4403) from exc


def _owner_authorized_profiles(server) -> frozenset[str]:
    """Return the gateway's explicit profile scope without probing a request."""
    from hermes_cli.profiles import profiles_to_serve

    try:
        config = server._load_cfg()
        if not isinstance(config, Mapping):
            raise ValueError
        gateway = config.get("gateway", {})
        if gateway is None:
            gateway = {}
        if not isinstance(gateway, Mapping):
            raise ValueError
        multiplex = config.get(
            "multiplex_profiles", gateway.get("multiplex_profiles", False)
        )
        if type(multiplex) is not bool:
            raise ValueError
        allowlist = config.get(
            "multiplex_profile_allowlist",
            gateway.get("multiplex_profile_allowlist"),
        )
        if allowlist is not None and (
            not isinstance(allowlist, list)
            or any(not isinstance(value, str) for value in allowlist)
        ):
            raise ValueError
        return frozenset(
            name
            for name, _home in profiles_to_serve(
                multiplex=multiplex,
                profile_allowlist=allowlist,
            )
        )
    except Exception as exc:
        raise CompanionTopicsError("topics profile unavailable", 4403) from exc


def _profile(server, raw: Any) -> tuple[str, Path]:
    """Validate, authorize, then safely resolve one exact profile."""
    from tui_gateway.companion_library import _profile as validate_profile
    from tui_gateway.companion_projects import _resolve_profile

    try:
        profile = validate_profile(server, raw)
    except Exception as exc:
        if getattr(exc, "code", None) == -32602:
            raise CompanionTopicsError("invalid profile", -32602) from exc
        raise CompanionTopicsError("topics profile unavailable", 4403) from exc
    # Authorization deliberately precedes target path resolution/probing.
    if profile not in _owner_authorized_profiles(server):
        raise CompanionTopicsError("topics profile unavailable", 4403)
    try:
        resolved, home = _resolve_profile(server, profile)
    except Exception as exc:
        raise CompanionTopicsError("topics profile unavailable", 4403) from exc
    if resolved != profile:
        raise CompanionTopicsError("topics profile unavailable", 4403)
    return profile, home


def _source_authorized(
    namespace: Any, backend: str, authorized_profiles: frozenset[str]
) -> bool:
    return bool(
        namespace is not None
        and getattr(namespace, "backend_id", None) == backend
        and getattr(namespace, "profile", None) in authorized_profiles
    )


def _limit(params: Mapping[str, Any]) -> int:
    value = params.get("limit", DEFAULT_PAGE_SIZE)
    if type(value) is not int or not 1 <= value <= MAX_PAGE_SIZE:
        raise CompanionTopicsError("limit must be an integer from 1 to 500", -32602)
    return value


def _text_filter(value: Any, field: str, maximum: int) -> tuple[str, ...]:
    if value in (None, ""):
        return ()
    values = value if isinstance(value, list) else [value]
    if not values or len(values) > 100:
        raise CompanionTopicsError(f"invalid {field}", -32602)
    result = []
    for item in values:
        if not isinstance(item, str) or not item or item != item.strip() or len(item) > maximum:
            raise CompanionTopicsError(f"invalid {field}", -32602)
        result.append(item)
    return tuple(sorted(set(result)))


def _query(params: Mapping[str, Any]) -> str:
    query = params.get("query")
    search = params.get("search")
    if query not in (None, "") and search not in (None, ""):
        raise CompanionTopicsError("use query or search, not both", -32602)
    value = query if query not in (None, "") else search
    if value in (None, ""):
        return ""
    if not isinstance(value, str) or value != value.strip() or len(value) > 500:
        raise CompanionTopicsError("invalid query", -32602)
    return value


def _filters(params: Mapping[str, Any]) -> dict[str, Any]:
    lifecycles = _text_filter(params.get("lifecycle"), "lifecycle", 20)
    if any(value not in {"active", "completed", "archived"} for value in lifecycles):
        raise CompanionTopicsError("invalid lifecycle", -32602)
    verified = params.get("verified")
    if verified is not None and type(verified) is not bool:
        raise CompanionTopicsError("verified must be a boolean", -32602)
    sort = params.get("sort", "updated")
    if sort not in {"updated", "name"}:
        raise CompanionTopicsError("sort must be updated or name", -32602)
    return {
        "query": _query(params),
        "collection": _text_filter(params.get("collection"), "collection", 200),
        "lifecycle": lifecycles,
        "verified": verified,
        "sort": sort,
    }


def _scope(
    profile: str,
    backend: str,
    authorized_profiles: frozenset[str],
    filters: Mapping[str, Any],
    limit: int,
) -> str:
    value = {
        "v": 1,
        "profile": profile,
        "backend": backend,
        "authorized_profiles": sorted(authorized_profiles),
        "limit": limit,
        **filters,
    }
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _cursor_signing_key() -> bytes:
    """Use stable gateway secret material when configured, else process scope."""
    try:
        from gateway.relay import relay_connection_auth

        _gateway_id, secret = relay_connection_auth()
    except Exception:
        secret = None
    material = secret.encode() if isinstance(secret, str) and secret else _CURSOR_FALLBACK_KEY
    return hashlib.sha256(b"companion-topics-cursor-v1\0" + material).digest()


def _encode_cursor(value: Mapping[str, Any]) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    signature = hmac.new(_cursor_signing_key(), payload, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(payload + signature).decode().rstrip("=")


def _decode_cursor(raw: Any) -> dict[str, Any] | None:
    if raw in (None, ""):
        return None
    if not isinstance(raw, str) or len(raw) > 4096:
        raise CompanionTopicsError("invalid cursor", 4006)
    try:
        padded = raw + "=" * (-len(raw) % 4)
        signed = base64.b64decode(padded.encode(), altchars=b"-_", validate=True)
        if (
            len(signed) <= 32
            or base64.urlsafe_b64encode(signed).decode().rstrip("=") != raw
        ):
            raise ValueError
        payload, signature = signed[:-32], signed[-32:]
        expected = hmac.new(_cursor_signing_key(), payload, hashlib.sha256).digest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError
        value = json.loads(payload)
        if set(value) != {"v", "token", "index", "scope"} or value.get("v") != 1:
            raise ValueError
        if (
            not isinstance(value["token"], str)
            or not value["token"]
            or type(value["index"]) is not int
            or value["index"] < 0
            or not isinstance(value["scope"], str)
            or len(value["scope"]) != 64
        ):
            raise ValueError
        return value
    except (UnicodeError, binascii.Error, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise CompanionTopicsError("invalid cursor", 4006) from exc


def _store_snapshot(
    scope: str,
    items: list[dict[str, Any]],
    timestamp: str,
    coverage: dict[str, Any],
) -> str:
    token = secrets.token_urlsafe(24)
    now = time.monotonic()
    with _SNAPSHOT_LOCK:
        for key in [
            key for key, value in _SNAPSHOTS.items() if now - value["stored"] > _SNAPSHOT_TTL
        ]:
            _SNAPSHOTS.pop(key, None)
        _SNAPSHOTS[token] = {
            "scope": scope,
            "items": items,
            "as_of": timestamp,
            "coverage": coverage,
            "stored": now,
        }
        while len(_SNAPSHOTS) > _SNAPSHOT_MAX:
            _SNAPSHOTS.popitem(last=False)
    return token


def _load_snapshot(cursor: Mapping[str, Any], scope: str) -> dict[str, Any]:
    with _SNAPSHOT_LOCK:
        snapshot = _SNAPSHOTS.get(cursor["token"])
        if snapshot is None or time.monotonic() - snapshot["stored"] > _SNAPSHOT_TTL:
            _SNAPSHOTS.pop(cursor["token"], None)
            raise CompanionTopicsError("cursor expired or unavailable", 4006)
        if cursor["scope"] != scope or snapshot["scope"] != scope:
            raise CompanionTopicsError("cursor scope does not match request", 4006)
        if cursor["index"] > len(snapshot["items"]):
            raise CompanionTopicsError("invalid cursor", 4006)
        _SNAPSHOTS.move_to_end(cursor["token"])
        return snapshot


def _status(topic: Topic) -> dict[str, Any]:
    return {
        "value": topic.lifecycle,
        "verified": True,
        "authority": "organization.topic.lifecycle",
        "observed_at": topic.updated_at,
    }


def _topic_assessments(
    bindings: list[WorkBinding], assessments: list[OutcomeAssessment]
) -> list[OutcomeAssessment]:
    action_keys = {
        key
        for binding in bindings
        for key in (binding.id, binding.canonical_id, binding.source_work_id)
    }
    return [
        value
        for value in assessments
        if value.action_id in action_keys
    ]


def _assessment_scope(
    topic: Topic,
    topic_bindings: list[WorkBinding],
    authorized_bindings: list[WorkBinding],
    assessments: list[OutcomeAssessment],
) -> tuple[list[OutcomeAssessment], bool]:
    """Gate topic assessments through an owner-authorized source binding."""
    topic_keys = {topic.id, topic.canonical_id}
    topic_action_keys = {
        key
        for binding in topic_bindings
        for key in (binding.id, binding.canonical_id, binding.source_work_id)
    }
    authorized_action_keys = {
        key
        for binding in authorized_bindings
        for key in (binding.id, binding.canonical_id, binding.source_work_id)
    }
    relevant = [
        value
        for value in assessments
        if value.outcome_id in topic_keys or value.action_id in topic_action_keys
    ]
    visible = [value for value in relevant if value.action_id in authorized_action_keys]
    return visible, len(visible) != len(relevant)


def _next_action(
    bindings: list[WorkBinding], assessments: list[OutcomeAssessment]
) -> dict[str, Any]:
    candidates = [
        value
        for value in _topic_assessments(bindings, assessments)
        if value.next_action_refs
    ]
    if not candidates:
        return {
            "availability": "unknown",
            "coverage": "unavailable",
            "reason": "No linked outcome assessment supplies a next-action reference.",
        }
    selected = max(candidates, key=lambda value: (value.assessed_at, value.canonical_id))
    return {
        "availability": "available",
        "assessment_id": selected.id,
        "outcome_id": selected.outcome_id,
        "action_id": selected.action_id,
        "references": list(selected.next_action_refs),
        "assessed_at": selected.assessed_at,
        "confidence": selected.confidence.value,
        "benefit": selected.benefit.value,
        "potential": selected.potential,
    }


def _topic_bindings(topic: Topic, bindings: list[WorkBinding]) -> list[WorkBinding]:
    return [
        value
        for value in bindings
        if value.primary_topic_id == topic.id or topic.id in value.related_topic_ids
    ]


def _primary_project(
    topic: Topic, backend: str, authorized_profiles: frozenset[str]
) -> dict[str, Any] | None:
    value = topic.primary_project
    if value is None or not _source_authorized(
        value.namespace, backend, authorized_profiles
    ):
        return None
    return {
        "canonical_id": value.canonical_id,
        "source_id": value.source_id,
        "kind": value.kind,
        "namespace": value.namespace.to_dict(),
    }


def _list_item(
    topic: Topic,
    bindings: list[WorkBinding],
    assessments: list[OutcomeAssessment],
    backend: str,
    authorized_profiles: frozenset[str],
    *,
    references_filtered: bool,
) -> dict[str, Any]:
    return {
        "id": topic.id,
        "canonical_id": topic.canonical_id,
        "collection": topic.collection,
        "name": topic.name,
        "objective": topic.objective,
        "lifecycle": topic.lifecycle,
        "version": topic.version,
        "created_at": topic.created_at,
        "updated_at": topic.updated_at,
        "primary_project": _primary_project(topic, backend, authorized_profiles),
        "verified_status": _status(topic),
        "next_useful_action": _next_action(bindings, assessments),
        "linked_work": {
            "coverage": "partial",
            "organization_bindings": "partial" if references_filtered else "complete",
            "source_records": "unavailable",
            "authorization_filtered": references_filtered,
        },
    }


def _filter_topics(topics: list[Topic], filters: Mapping[str, Any]) -> list[Topic]:
    query = filters["query"].casefold()
    collections = set(filters["collection"])
    lifecycles = set(filters["lifecycle"])
    verified = filters["verified"]
    result = []
    for topic in topics:
        if collections and topic.collection not in collections:
            continue
        if lifecycles and topic.lifecycle not in lifecycles:
            continue
        if verified is False:
            continue
        if query and query not in " ".join(
            (topic.id, topic.collection, topic.name, topic.objective, topic.lifecycle)
        ).casefold():
            continue
        result.append(topic)
    if filters["sort"] == "name":
        return sorted(result, key=lambda item: (item.name.casefold(), item.id))
    return sorted(
        result,
        key=lambda item: (str(item.updated_at or item.created_at or ""), item.id),
        reverse=True,
    )


def _coverage(
    timestamp: str, topics: list[Topic], *, references_filtered: bool = False
) -> dict[str, Any]:
    latest = max(
        (str(topic.updated_at or topic.created_at or "") for topic in topics),
        default=None,
    )
    return {
        "configured": True,
        "status": "partial" if references_filtered else "complete",
        "population": "all organization topics in the authorized profile",
        "organization_topics": "complete",
        "source_references": "partial" if references_filtered else "complete",
        "authorization_filtered": references_filtered,
        "source": "organization.db",
        "freshness": {"as_of": timestamp, "organization_updated_at": latest},
        "linked_collections": {
            "needs_me": "unavailable",
            "work_source_records": "unavailable",
            "files": "unavailable",
            "source_details": "unavailable",
        },
    }


def _read(home: Path, profile: str) -> list[Any] | None:
    try:
        return OrganizationStore.list_existing(
            home / "organization.db",
            profile=profile,
            record_types=("topic", "work_binding", "outcome_assessment"),
        )
    except OrganizationError as exc:
        raise CompanionTopicsError("topics source unavailable", 5065) from exc


def _unconfigured(profile: str, backend: str) -> dict[str, Any]:
    timestamp = _as_of()
    return {
        "items": [],
        "has_more": False,
        "next_cursor": None,
        "total": 0,
        "as_of": timestamp,
        "profile": profile,
        "backend_namespace": backend,
        "coverage": {
            "configured": False,
            "status": "unconfigured",
            "population": "no organization database exists for the authorized profile",
            "source": "organization.db",
            "freshness": {"as_of": timestamp, "organization_updated_at": None},
            "linked_collections": {
                "needs_me": "unavailable",
                "work_source_records": "unavailable",
                "files": "unavailable",
                "source_details": "unavailable",
            },
        },
        "warnings": [
            "No organization database exists for this profile; no topic records were opened or created."
        ],
    }


def _topic_source_scope(
    topic: Topic,
    bindings: list[WorkBinding],
    backend: str,
    authorized_profiles: frozenset[str],
) -> tuple[list[WorkBinding], bool]:
    visible = [
        value
        for value in bindings
        if _source_authorized(value.source_namespace, backend, authorized_profiles)
    ]
    filtered = len(visible) != len(bindings) or bool(
        topic.primary_project
        and not _source_authorized(
            topic.primary_project.namespace, backend, authorized_profiles
        )
    )
    filtered = filtered or any(
        (
            value.primary_session is not None
            and not _source_authorized(
                value.primary_session.namespace, backend, authorized_profiles
            )
        )
        or any(
            not _source_authorized(item.namespace, backend, authorized_profiles)
            for item in value.related_sessions
        )
        or any(
            not _source_authorized(item.namespace, backend, authorized_profiles)
            for item in value.source_projects
        )
        for value in visible
    )
    return visible, filtered


def _list(
    profile: str,
    backend: str,
    authorized_profiles: frozenset[str],
    records: list[Any] | None,
    params: Mapping[str, Any],
):
    if records is None:
        if params.get("cursor") not in (None, ""):
            raise CompanionTopicsError("cursor expired or unavailable", 4006)
        return _unconfigured(profile, backend)
    filters = _filters(params)
    limit = _limit(params)
    scope = _scope(profile, backend, authorized_profiles, filters, limit)
    cursor = _decode_cursor(params.get("cursor"))
    if cursor is None:
        topics = [value for value in records if isinstance(value, Topic)]
        all_bindings = [value for value in records if isinstance(value, WorkBinding)]
        assessments = [value for value in records if isinstance(value, OutcomeAssessment)]
        filtered = _filter_topics(topics, filters)
        items = []
        any_filtered = False
        for topic in filtered:
            topic_bindings = _topic_bindings(topic, all_bindings)
            bindings, references_filtered = _topic_source_scope(
                topic, topic_bindings, backend, authorized_profiles
            )
            topic_assessments, assessments_filtered = _assessment_scope(
                topic, topic_bindings, bindings, assessments
            )
            references_filtered = references_filtered or assessments_filtered
            any_filtered = any_filtered or references_filtered
            items.append(
                _list_item(
                    topic,
                    bindings,
                    topic_assessments,
                    backend,
                    authorized_profiles,
                    references_filtered=references_filtered,
                )
            )
        timestamp = _as_of()
        coverage = _coverage(
            timestamp, topics, references_filtered=any_filtered
        )
        token = _store_snapshot(scope, items, timestamp, coverage)
        index = 0
    else:
        snapshot = _load_snapshot(cursor, scope)
        items = snapshot["items"]
        timestamp = snapshot["as_of"]
        token = cursor["token"]
        index = cursor["index"]
        coverage = snapshot["coverage"]
    page = items[index : index + limit]
    next_index = index + len(page)
    has_more = next_index < len(items)
    return {
        "items": page,
        "has_more": has_more,
        "next_cursor": _encode_cursor(
            {"v": 1, "token": token, "index": next_index, "scope": scope}
        )
        if has_more
        else None,
        "total": len(items),
        "as_of": timestamp,
        "profile": profile,
        "backend_namespace": backend,
        "coverage": coverage,
        "warnings": [
            "Needs Me, source work status, file links, and live source details are not yet queryable from the organization registry.",
            *(
                ["Some organization source references were omitted because their backend or profile is outside the authorized scope."]
                if coverage.get("authorization_filtered")
                else []
            ),
        ],
    }


def _binding_projection(
    value: WorkBinding,
    topic: Topic,
    backend: str,
    authorized_profiles: frozenset[str],
) -> tuple[dict[str, Any], bool]:
    namespace = value.source_namespace
    if namespace is None or not _source_authorized(
        namespace, backend, authorized_profiles
    ):
        raise CompanionTopicsError("topics source unavailable", 5065)
    primary_session = value.primary_session
    primary_authorized = primary_session is None or _source_authorized(
        primary_session.namespace, backend, authorized_profiles
    )
    related_sessions = [
        item
        for item in value.related_sessions
        if _source_authorized(item.namespace, backend, authorized_profiles)
    ]
    source_projects = [
        item
        for item in value.source_projects
        if _source_authorized(item.namespace, backend, authorized_profiles)
    ]
    filtered = (
        not primary_authorized
        or len(related_sessions) != len(value.related_sessions)
        or len(source_projects) != len(value.source_projects)
    )
    return {
        "id": value.id,
        "canonical_id": value.canonical_id,
        "work_kind": value.work_kind,
        "source_work_id": value.source_work_id,
        "source_namespace": namespace.to_dict(),
        "relationship": "primary"
        if value.primary_topic_id == topic.id
        else "related",
        "primary_session": (
            primary_session.to_dict()
            if primary_session is not None and primary_authorized
            else None
        ),
        "related_sessions": [item.to_dict() for item in related_sessions],
        "source_projects": [item.to_dict() for item in source_projects],
        "version": value.version,
        "updated_at": value.updated_at,
        "authorization_filtered": filtered,
        "source_status": {
            "availability": "unknown",
            "coverage": "unavailable",
        },
    }, filtered


def _source_projection(
    topic: Topic,
    bindings: list[WorkBinding],
    backend: str,
    authorized_profiles: frozenset[str],
) -> tuple[list[dict[str, Any]], bool]:
    sources: dict[tuple[str, str], dict[str, Any]] = {}
    filtered = False

    def add(kind: str, canonical_id: str, value: dict[str, Any]) -> None:
        sources[(kind, canonical_id)] = {
            "kind": kind,
            "canonical_id": canonical_id,
            **value,
        }

    if topic.primary_project:
        project = topic.primary_project
        if _source_authorized(project.namespace, backend, authorized_profiles):
            add(
                "project",
                project.canonical_id,
                {
                    "source_id": project.source_id,
                    "project_kind": project.kind,
                    "namespace": project.namespace.to_dict(),
                    "relationship": "primary_project",
                },
            )
        else:
            filtered = True
    for binding in bindings:
        namespace = binding.source_namespace
        if namespace is None or not _source_authorized(
            namespace, backend, authorized_profiles
        ):
            filtered = True
            continue
        add(
            "namespace",
            namespace.canonical_id,
            {"namespace": namespace.to_dict(), "relationship": "work_origin"},
        )
        sessions = [
            (binding.primary_session, "primary_session"),
            *((session, "related_session") for session in binding.related_sessions),
        ]
        for session, relationship in sessions:
            if session is None:
                continue
            if _source_authorized(session.namespace, backend, authorized_profiles):
                add(
                    "session",
                    session.canonical_id,
                    {"session": session.to_dict(), "relationship": relationship},
                )
            else:
                filtered = True
        for project in binding.source_projects:
            if _source_authorized(project.namespace, backend, authorized_profiles):
                add(
                    "project",
                    project.canonical_id,
                    {
                        "source_id": project.source_id,
                        "project_kind": project.kind,
                        "namespace": project.namespace.to_dict(),
                        "relationship": "work_project",
                    },
                )
            else:
                filtered = True
    return [sources[key] for key in sorted(sources)], filtered


def _detail(
    profile: str,
    backend: str,
    authorized_profiles: frozenset[str],
    records: list[Any] | None,
    params: Mapping[str, Any],
) -> dict[str, Any]:
    topic_id = params.get("id")
    if (
        not isinstance(topic_id, str)
        or not topic_id
        or topic_id != topic_id.strip()
        or len(topic_id) > 200
    ):
        raise CompanionTopicsError("invalid topic id", -32602)
    if records is None:
        raise CompanionTopicsError("topic not found", 4404)
    topics = [value for value in records if isinstance(value, Topic)]
    topic = next((value for value in topics if value.id == topic_id), None)
    if topic is None:
        raise CompanionTopicsError("topic not found", 4404)
    all_bindings = [value for value in records if isinstance(value, WorkBinding)]
    assessments = [value for value in records if isinstance(value, OutcomeAssessment)]
    topic_bindings = _topic_bindings(topic, all_bindings)
    bindings, scope_filtered = _topic_source_scope(
        topic, topic_bindings, backend, authorized_profiles
    )
    topic_assessments, assessments_filtered = _assessment_scope(
        topic, topic_bindings, bindings, assessments
    )
    binding_projections = [
        _binding_projection(value, topic, backend, authorized_profiles)
        for value in bindings
    ]
    sources, sources_filtered = _source_projection(
        topic, topic_bindings, backend, authorized_profiles
    )
    references_filtered = (
        scope_filtered
        or sources_filtered
        or assessments_filtered
        or any(filtered for _projection, filtered in binding_projections)
    )
    timestamp = _as_of()
    item = _list_item(
        topic,
        bindings,
        topic_assessments,
        backend,
        authorized_profiles,
        references_filtered=references_filtered,
    )
    unavailable = {
        "items": None,
        "coverage": {
            "status": "unavailable",
            "reason": "This linked collection has no read-only query contract yet.",
        },
    }
    return {
        "topic": item,
        "overview": {
            "objective": topic.objective,
            "next_useful_action": item["next_useful_action"],
            "verified_status": item["verified_status"],
            "primary_project": item["primary_project"],
            "coverage": {"status": "complete", "authority": "organization.db"},
        },
        "needs_me": dict(unavailable),
        "work": {
            "items": [projection for projection, _filtered in binding_projections],
            "coverage": {
                "status": "partial",
                "organization_bindings": "partial" if references_filtered else "complete",
                "source_records": "unavailable",
                "authorization_filtered": references_filtered,
            },
        },
        "files": dict(unavailable),
        "sources": {
            "items": sources,
            "coverage": {
                "status": "partial",
                "organization_references": "partial" if references_filtered else "complete",
                "source_details": "unavailable",
                "authorization_filtered": references_filtered,
            },
        },
        "tabs": ["overview", "needs_me", "work", "files", "sources"],
        "as_of": timestamp,
        "profile": profile,
        "backend_namespace": backend,
        "coverage": _coverage(
            timestamp, topics, references_filtered=references_filtered
        ),
        "warnings": [
            "Needs Me, source work status, file links, and live source details are unavailable; organization references are shown without inventing empty source collections.",
            *(
                ["Some organization source references were omitted because their backend or profile is outside the authorized scope."]
                if references_filtered
                else []
            ),
        ],
    }


def _validate_params(operation: str, params: Any) -> dict[str, Any]:
    if not isinstance(params, dict):
        raise CompanionTopicsError("parameters must be an object", -32602)
    allowed = {
        "list": {
            "profile", "query", "search", "collection", "lifecycle", "verified",
            "sort", "limit", "cursor",
        },
        "get": {"profile", "id"},
    }[operation]
    if set(params) - allowed:
        raise CompanionTopicsError("unexpected topics parameters", -32602)
    return params


def execute(
    server,
    operation: str,
    params: Any,
    *,
    owner_authorization: Any = None,
) -> dict[str, Any]:
    if operation not in {"list", "get"}:
        raise CompanionTopicsError("unknown topics operation", -32601)
    params = _validate_params(operation, params)
    _require_owner(owner_authorization)
    from tui_gateway.companion_library import _launch_home

    installation_home = _launch_home()
    profile, home = _profile(server, params.get("profile"))
    backend = _backend_namespace(server, installation_home=installation_home)
    authorized_profiles = _owner_authorized_profiles(server)
    if profile not in authorized_profiles:
        # Recheck the live profile policy immediately before opening its store.
        raise CompanionTopicsError("topics profile unavailable", 4403)
    records = _read(home, profile)
    if operation == "list":
        return _list(profile, backend, authorized_profiles, records, params)
    return _detail(profile, backend, authorized_profiles, records, params)
