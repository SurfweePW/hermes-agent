"""Owner-authorized, path-free Companion Library RPC application boundary.

Configuration is deliberately explicit and read from the dashboard launch
profile on every call::

    companion_library:
      profiles:
        atlas:
          limits:
            max_file_size: 268435456       # hard ceiling: 256 MiB
            max_scan_bytes: 2147483648     # hard ceiling: 2 GiB
            max_scan_files: 100000         # hard ceiling: 100,000
            max_scan_depth: 64             # hard ceiling: 64
            max_retained_items: 100000     # hard ceiling: 100,000
            max_retained_bytes: 2147483648 # hard ceiling: 2 GiB
            max_html_preview_size: 33554432 # hard ceiling: 32 MiB
          collections:
            operations:
              name: Atlas operations
              root: /absolute/canonical/output/root

A conservative single-profile shorthand is also accepted: top-level
``companion_library.collections`` applies only to the launch profile. Merely
having another Hermes profile does not authorize it: cross-profile reads need
an exact entry under ``profiles``. Missing configuration produces an
authenticated, complete empty ``unconfigured`` result and never constructs an
``ArtifactLibrary`` or scans a fallback directory. Malformed policy fails
closed.
"""
from __future__ import annotations

import base64
from collections import OrderedDict
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import threading
import time
from typing import Any, Mapping, TypedDict, cast

from hermes_cli.artifact_library import (
    ArtifactError,
    ArtifactLibrary,
    ArtifactNotFound,
    ArtifactSecurityError,
    ArtifactUnavailable,
)
from tui_gateway.companion_projects import _backend_namespace


DEFAULT_PAGE_SIZE = 100
MAX_PAGE_SIZE = 500
DEFAULT_CHUNK_SIZE = 64 * 1024
MAX_CHUNK_SIZE = 256 * 1024
LIBRARY_LIMIT_CEILINGS = {
    "max_file_size": 256 * 1024 * 1024,
    "max_scan_bytes": 2 * 1024 * 1024 * 1024,
    "max_scan_files": 100_000,
    "max_scan_depth": 64,
    "max_retained_items": 100_000,
    "max_retained_bytes": 2 * 1024 * 1024 * 1024,
    "max_html_preview_size": 32 * 1024 * 1024,
}


class _ArtifactLibraryLimits(TypedDict, total=False):
    max_file_size: int
    max_scan_bytes: int
    max_scan_files: int
    max_scan_depth: int
    max_retained_items: int
    max_retained_bytes: int
    max_html_preview_size: int


_MAX_CURSOR_BYTES = 1024 * 1024
_MAX_SNAPSHOT_ITEMS = 10_000
_MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024
_SNAPSHOT_TTL = 15 * 60
_SNAPSHOT_MAX = 64
_ARTIFACT_ID_RE = re.compile(r"^art_[0-9a-f]{64}$")
_VERSION_ID_RE = re.compile(r"^ver_[0-9a-f]{64}$")
_PREVIEW_TYPES = frozenset({"markdown", "text", "image", "pdf", "html"})
_CURSOR_SECRET = os.urandom(32)
_SNAPSHOTS: OrderedDict[str, dict[str, Any]] = OrderedDict()
_SNAPSHOT_LOCK = threading.Lock()
_RELATION_KINDS = {"projects": "project", "topics": "topic", "sessions": "session"}


class CompanionLibraryError(Exception):
    def __init__(self, message: str, code: int):
        super().__init__(message)
        self.code = code


def _as_of() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _launch_home() -> Path:
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home())


def _owner_identity(human_identity: Any) -> str | None:
    # Reuses the existing dashboard owner policy. That function reparses the
    # current config bytes and fails closed on malformed/revoked policy.
    from hermes_cli.companion_work import owner_identity

    return owner_identity(human_identity)


def _current_profile(server) -> str:
    return str(server._current_profile_name() or "default")


def _read_config(home: Path) -> Mapping[str, Any] | None:
    path = home / "config.yaml"
    if not path.is_file():
        return None
    try:
        from hermes_cli.config import load_config_path_readonly

        value = load_config_path_readonly(path, fail_closed=True)
    except (OSError, UnicodeError, ValueError) as exc:
        raise CompanionLibraryError("library authorization unavailable", 4403) from exc
    if not isinstance(value, Mapping):
        raise CompanionLibraryError("library authorization unavailable", 4403)
    return value


def _collections_from_mapping(value: Any) -> list[dict[str, Any]]:
    """Normalize explicit collection mappings without accepting implicit roots."""
    if value is None:
        return []
    result: list[dict[str, Any]] = []
    if isinstance(value, Mapping):
        for collection_id, raw in value.items():
            if isinstance(raw, str):
                raw = {"root": raw}
            if not isinstance(collection_id, str) or not isinstance(raw, Mapping):
                raise CompanionLibraryError("library authorization unavailable", 4403)
            result.append({"id": collection_id, **dict(raw)})
        return result
    if isinstance(value, list):
        if not all(isinstance(item, Mapping) for item in value):
            raise CompanionLibraryError("library authorization unavailable", 4403)
        return [dict(item) for item in value]
    raise CompanionLibraryError("library authorization unavailable", 4403)


def _limits_from_mapping(value: Any) -> _ArtifactLibraryLimits:
    """Validate the exact bounded ArtifactLibrary constructor policy surface."""
    if value is None:
        return {}
    if not isinstance(value, Mapping) or set(value) - set(LIBRARY_LIMIT_CEILINGS):
        raise CompanionLibraryError("library authorization unavailable", 4403)
    result: dict[str, int] = {}
    for key, raw in value.items():
        ceiling = LIBRARY_LIMIT_CEILINGS[key]
        if (
            not isinstance(raw, int)
            or isinstance(raw, bool)
            or raw <= 0
            or raw > ceiling
        ):
            raise CompanionLibraryError("library authorization unavailable", 4403)
        result[key] = raw
    return cast(_ArtifactLibraryLimits, result)


def _configured_policy(
    server, profile: str
) -> tuple[list[dict[str, Any]] | None, Path, _ArtifactLibraryLimits]:
    """Authorize one profile and return its collections, home, and bounded limits."""
    launch_home = _launch_home()
    current = _current_profile(server)
    config = _read_config(launch_home)
    if config is None or "companion_library" not in config:
        if profile != current:
            raise CompanionLibraryError("library profile unavailable", 4403)
        return None, launch_home, {}

    section = config.get("companion_library")
    if not isinstance(section, Mapping):
        raise CompanionLibraryError("library authorization unavailable", 4403)
    profiles = section.get("profiles")
    selected: Any = None
    explicitly_scoped = False
    if profiles is not None:
        if not isinstance(profiles, Mapping):
            raise CompanionLibraryError("library authorization unavailable", 4403)
        if profile in profiles:
            selected = profiles[profile]
            explicitly_scoped = True
        elif profile != current:
            # Do not resolve or probe an unconfigured profile directory.
            raise CompanionLibraryError("library profile unavailable", 4403)
    elif profile != current:
        raise CompanionLibraryError("library profile unavailable", 4403)

    if explicitly_scoped:
        if not isinstance(selected, Mapping):
            raise CompanionLibraryError("library authorization unavailable", 4403)
        entries = _collections_from_mapping(selected.get("collections"))
        limits = _limits_from_mapping(selected.get("limits"))
    elif profile == current and ({"collections", "limits"} & set(section)):
        entries = _collections_from_mapping(section.get("collections"))
        limits = _limits_from_mapping(section.get("limits"))
    else:
        return None, launch_home, {}

    home = launch_home if profile == current else _resolve_profile_home(server, profile)
    return entries, home, limits


def _configured_collections(server, profile: str) -> tuple[list[dict[str, Any]] | None, Path]:
    """Backward-compatible collection-only view of the authorized profile policy."""
    entries, home, _limits = _configured_policy(server, profile)
    return entries, home


def _resolve_profile_home(server, profile: str) -> Path:
    # This resolver validates the exact profile name, root anchoring, aliases and
    # every symlink component before returning a profile home.
    from tui_gateway.companion_projects import _resolve_profile

    resolved, home = _resolve_profile(server, profile)
    if resolved != profile:
        raise CompanionLibraryError("library profile unavailable", 4403)
    return home


def _authorized_library(server, profile: str) -> tuple[ArtifactLibrary | None, list[dict[str, Any]]]:
    entries, home, limits = _configured_policy(server, profile)
    # An absent policy and an explicitly empty allowlist both authorize no
    # filesystem roots. Avoid constructing ArtifactLibrary in either case:
    # its retained-store initialization is a write and would make an empty
    # policy look configured even though there is no possible scan coverage.
    if not entries:
        return None, []
    try:
        library = ArtifactLibrary(
            home, profile=profile, collections=entries, **limits
        )
    except (TypeError, ValueError, OSError, ArtifactError) as exc:
        # Collection validation messages can contain IDs and filesystem state;
        # malformed sensitive policy gets one non-enumerating response.
        raise CompanionLibraryError("library authorization unavailable", 4403) from exc
    return library, library.list_collections()


def _authorized_profile_catalog(server) -> list[dict[str, Any]]:
    """Enumerate only served profiles explicitly covered by Library policy."""
    from tui_gateway.companion_sessions import _owner_authorized_profiles

    served = _owner_authorized_profiles(server)
    current = _current_profile(server)
    config = _read_config(_launch_home())
    section = config.get("companion_library") if isinstance(config, Mapping) else None
    if section is None:
        return [{"profile": current, "configured": False}] if current in served else []
    if not isinstance(section, Mapping):
        raise CompanionLibraryError("library authorization unavailable", 4403)
    profiles = section.get("profiles")
    if profiles is not None and not isinstance(profiles, Mapping):
        raise CompanionLibraryError("library authorization unavailable", 4403)
    candidates = set(profiles or {})
    if "collections" in section:
        candidates.add(current)
    result = []
    for profile in sorted(candidates & set(served)):
        entries, _home = _configured_collections(server, profile)
        result.append({"profile": profile, "configured": bool(entries)})
    return result


def _require_owner(owner_authorization: Any) -> str:
    from hermes_cli.dashboard_auth.ws_tickets import leased_human_identity

    human = leased_human_identity(owner_authorization)
    owner = _owner_identity(human)
    if not owner:
        raise CompanionLibraryError("authenticated dashboard owner required", 4403)
    return owner


def _profile(server, raw: Any) -> str:
    from hermes_cli.profiles import validate_profile_name

    value = _current_profile(server) if raw is None else raw
    if not isinstance(value, str) or not value or value != value.strip():
        raise CompanionLibraryError("invalid profile", -32602)
    try:
        validate_profile_name(value)
    except ValueError as exc:
        raise CompanionLibraryError("invalid profile", -32602) from exc
    return value


def _artifact_id(value: Any) -> str:
    if not isinstance(value, str) or not _ARTIFACT_ID_RE.fullmatch(value):
        raise CompanionLibraryError("invalid artifact_id", -32602)
    return value


def _version_id(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not _VERSION_ID_RE.fullmatch(value):
        raise CompanionLibraryError("invalid version_id", -32602)
    return value


def _safe_provenance(value: Any) -> Any:
    """Retain useful provenance while removing credentials and absolute paths."""
    from agent.redact import redact_sensitive_text

    sensitive_keys = {
        "access_token", "refresh_token", "id_token", "token", "api_key",
        "apikey", "client_secret", "password", "authorization", "cookie",
        "path", "root", "file", "url",
    }
    if isinstance(value, Mapping):
        return {
            str(key): ("[REDACTED]" if str(key).lower() in sensitive_keys else _safe_provenance(item))
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_safe_provenance(item) for item in value]
    if isinstance(value, tuple):
        return [_safe_provenance(item) for item in value]
    if isinstance(value, str):
        text = redact_sensitive_text(value, force=True)
        if text.startswith(("/", "file://")) or re.match(r"^[A-Za-z]:[\\/]", text):
            return "[REDACTED PATH]"
        return text
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return "[REDACTED]"


def _download_descriptor() -> dict[str, Any]:
    return {"authenticated_request_required": True, "operation": "companion.library.download"}


def _preview(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {"kind": "unsupported", "preview_available": False}
    allowed = {
        "kind", "preview_available", "message", "sandbox", "scripts", "network",
        "app_origin", "content_security_policy",
    }
    return {key: value[key] for key in allowed if key in value}


def _collection(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    allowed = {"id", "name", "owner", "description", "availability"}
    return {key: value[key] for key in allowed if key in value}


def _relationships(value: Any) -> dict[str, list[dict[str, str]]]:
    """Project already-validated, namespaced relationship metadata."""
    result: dict[str, list[dict[str, str]]] = {key: [] for key in _RELATION_KINDS}
    if not isinstance(value, Mapping):
        return result
    for kind in result:
        raw_items = value.get(kind)
        if not isinstance(raw_items, list):
            continue
        for raw in raw_items:
            if (
                not isinstance(raw, Mapping)
                or not isinstance(raw.get("id"), str)
                or not isinstance(raw.get("backend_namespace"), str)
                or not isinstance(raw.get("profile"), str)
            ):
                continue
            item = {
                "id": raw["id"],
                "backend_namespace": raw["backend_namespace"],
                "profile": raw["profile"],
            }
            if isinstance(raw.get("title"), str):
                item["title"] = raw["title"]
            if kind == "sessions" and raw.get("relationship") in {"primary", "related"}:
                item["relationship"] = raw["relationship"]
            result[kind].append(item)
    return result


def _relationship_exists(
    server,
    kind: str,
    relationship: Mapping[str, str],
    *,
    profile: str,
    backend: str,
    owner_authorization: Any,
) -> bool:
    """Resolve a namespaced relationship against its authorized source."""
    if (
        relationship.get("backend_namespace") != backend
        or relationship.get("profile") != profile
    ):
        return False
    ident = relationship["id"]
    try:
        if kind == "projects":
            from tui_gateway.companion_projects import execute as execute_projects

            value = execute_projects(
                server,
                "get",
                {"profile": profile, "id": ident},
                owner_authorization=owner_authorization,
            )
            item = value.get("project") or value.get("item") or value
            return (
                value.get("profile") == profile
                and value.get("backend_namespace") == backend
                and isinstance(item, Mapping)
                and item.get("id") == ident
            )
        if kind == "topics":
            from tui_gateway.companion_topics import execute as execute_topics

            value = execute_topics(
                server,
                "get",
                {"profile": profile, "id": ident},
                owner_authorization=owner_authorization,
            )
            item = value.get("topic") or value.get("item") or value
            return (
                value.get("profile") == profile
                and value.get("backend_namespace") == backend
                and isinstance(item, Mapping)
                and item.get("id") == ident
            )
        if kind == "sessions":
            from tui_gateway.companion_sessions import session_history

            value = session_history(
                server,
                {"profile": profile, "session_id": ident, "limit": 1},
                owner_authorization=owner_authorization,
            )
            identity = value.get("identity")
            return (
                value.get("profile") == profile
                and value.get("backend_namespace") == backend
                and isinstance(identity, Mapping)
                and ident in {identity.get("original_id"), identity.get("resolved_tip_id")}
            )
    except Exception:
        return False
    return False


def _authorized_relationships(
    server,
    value: Any,
    *,
    profile: str,
    backend: str,
    owner_authorization: Any,
    strict: bool = False,
) -> dict[str, list[dict[str, str]]]:
    projected = _relationships(value)
    result = {key: [] for key in _RELATION_KINDS}
    for kind, relationships in projected.items():
        for relationship in relationships:
            if _relationship_exists(
                server,
                kind,
                relationship,
                profile=profile,
                backend=backend,
                owner_authorization=owner_authorization,
            ):
                result[kind].append(relationship)
            elif strict:
                raise CompanionLibraryError(
                    "artifact relationship is outside authorized sources", 4403
                )
    return result


def _filter_relationships(
    server,
    items: list[dict[str, Any]],
    *,
    profile: str,
    backend: str,
    owner_authorization: Any,
) -> list[dict[str, Any]]:
    cache: dict[tuple[str, str, str, str], bool] = {}
    for item in items:
        filtered = {key: [] for key in _RELATION_KINDS}
        for kind, relationships in _relationships(item.get("relationships")).items():
            for relationship in relationships:
                identity = (
                    kind,
                    relationship["backend_namespace"],
                    relationship["profile"],
                    relationship["id"],
                )
                allowed = cache.get(identity)
                if allowed is None:
                    allowed = _relationship_exists(
                        server,
                        kind,
                        relationship,
                        profile=profile,
                        backend=backend,
                        owner_authorization=owner_authorization,
                    )
                    cache[identity] = allowed
                if allowed:
                    filtered[kind].append(relationship)
        item["relationships"] = filtered
        item["related_links"] = _related_links(filtered)
    return items


def _related_links(
    relationships: Mapping[str, list[dict[str, str]]]
) -> list[dict[str, str]]:
    links: list[dict[str, str]] = []
    for plural, singular in _RELATION_KINDS.items():
        for relationship in relationships.get(plural, []):
            links.append({"kind": singular, **relationship})
    return links


def _version_projection(value: Mapping[str, Any]) -> dict[str, Any]:
    result = {
        key: value[key]
        for key in (
            "version_id", "title", "filename", "size", "sha256", "mime_type",
            "ingested_at", "reviewed", "availability", "status",
        )
        if key in value
    }
    result["preview"] = _preview(value.get("preview"))
    result["download"] = _download_descriptor()
    if "provenance" in value:
        result["provenance"] = _safe_provenance(value.get("provenance"))
    result["relationships"] = _relationships(value.get("relationships"))
    result["related_links"] = _related_links(result["relationships"])
    return result


def _latest_projection(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping) or value.get("availability") != "available":
        return {"availability": "unavailable"}
    result = {
        key: value[key]
        for key in (
            "version_id", "filename", "size", "sha256", "mime_type", "availability",
            "reviewed", "status", "modified_at",
        )
        if key in value
    }
    result["preview"] = _preview(value.get("preview"))
    result["download"] = _download_descriptor()
    result["relationships"] = _relationships(value.get("relationships"))
    result["related_links"] = _related_links(result["relationships"])
    return result


def _detail_projection(value: Mapping[str, Any]) -> dict[str, Any]:
    result = {
        "artifact_id": value["artifact_id"],
        "profile": value["profile"],
        "collection": _collection(value.get("collection")),
        "relative_path": value.get("relative_path", ""),
        "filename": value.get("filename", ""),
        "versions": [_version_projection(version) for version in value.get("versions", [])],
        "latest": _latest_projection(value.get("latest")),
        "download": _download_descriptor(),
    }
    return result


def _catalog(library: ArtifactLibrary) -> list[dict[str, Any]]:
    """Merge verified evidence and live files without transferring review state."""
    live = {item["artifact_id"]: item for item in library.scan()}
    # Retained bytes, not the disposable index, are re-opened and verified here.
    grouped = {item["artifact_id"]: item for item in library._grouped_metadata()}
    items = []
    for artifact_id in sorted(set(live) | set(grouped)):
        current = live.get(artifact_id)
        retained = grouped.get(artifact_id)
        versions = (retained or {}).get("versions", [])
        if versions:
            # A reviewed version is the default catalog selection. Latest live
            # bytes remain an explicitly separate choice in detail/content RPCs.
            newest = max(versions, key=lambda value: str(value.get("ingested_at") or ""))
            item = _version_projection(newest)
            item.pop("provenance", None)
            item.update(
                {
                    "artifact_id": artifact_id,
                    "profile": (retained or newest)["profile"],
                    "collection": _collection((retained or newest).get("collection")),
                    "relative_path": (retained or newest).get("relative_path", ""),
                    "filename": newest.get("filename", ""),
                    "version_count": len(versions),
                    "reviewed": True,
                    "status": "reviewed",
                }
            )
            item["date"] = newest.get("ingested_at")
        else:
            assert current is not None
            item = _latest_projection(current)
            item.update(
                {
                    "artifact_id": artifact_id,
                    "profile": current["profile"],
                    "collection": _collection(current.get("collection")),
                    "relative_path": current.get("relative_path", ""),
                    "filename": current.get("filename", ""),
                    "version_count": 0,
                    "reviewed": False,
                    "status": "live",
                    "date": current.get("modified_at"),
                }
            )
        items.append(item)
    return items


def _scope(profile: str, backend: str, params: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "profile": profile,
        "backend": backend,
        "search": params.get("search") or "",
        "collection": _filter_values(params.get("collection"), "collection"),
        "project": _filter_values(params.get("project"), "project"),
        "topic": _filter_values(params.get("topic"), "topic"),
        "session": _filter_values(params.get("session"), "session"),
        "status": _filter_values(params.get("status"), "status"),
        "type": params.get("type") or "",
        "date_from": params.get("date_from") or "",
        "date_to": params.get("date_to") or "",
        "reviewed": params.get("reviewed"),
    }


def _encode_cursor(value: Mapping[str, Any]) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    if len(raw) > _MAX_CURSOR_BYTES:
        raise CompanionLibraryError("library snapshot exceeds the cursor safety limit", 5064)
    signature = hmac.new(_CURSOR_SECRET, raw, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(signature + raw).decode().rstrip("=")


def _decode_cursor(raw: Any) -> dict[str, Any] | None:
    if raw in (None, ""):
        return None
    if not isinstance(raw, str) or len(raw) > (_MAX_CURSOR_BYTES * 2):
        raise CompanionLibraryError("invalid cursor", 4006)
    try:
        padded = raw + "=" * (-len(raw) % 4)
        decoded = base64.b64decode(padded.encode(), altchars=b"-_", validate=True)
        if len(decoded) <= 32 or len(decoded) > _MAX_CURSOR_BYTES + 32:
            raise ValueError
        signature, payload = decoded[:32], decoded[32:]
        expected = hmac.new(_CURSOR_SECRET, payload, hashlib.sha256).digest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError
        value = json.loads(payload)
        if not isinstance(value, dict) or value.get("v") != 1:
            raise ValueError
        return value
    except Exception as exc:
        raise CompanionLibraryError("invalid cursor", 4006) from exc


def _store_snapshot(value: dict[str, Any]) -> str:
    encoded_size = len(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())
    if encoded_size > _MAX_SNAPSHOT_BYTES:
        raise CompanionLibraryError("library snapshot exceeds the safety limit", 5064)
    token = secrets.token_urlsafe(24)
    now = time.monotonic()
    with _SNAPSHOT_LOCK:
        for key in [
            key for key, snapshot in _SNAPSHOTS.items()
            if now - snapshot["stored"] > _SNAPSHOT_TTL
        ]:
            _SNAPSHOTS.pop(key, None)
        value = dict(value)
        value["stored"] = now
        _SNAPSHOTS[token] = value
        while len(_SNAPSHOTS) > _SNAPSHOT_MAX:
            _SNAPSHOTS.popitem(last=False)
    return token


def _load_snapshot(token: Any, scope: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(token, str) or not token or len(token) > 128:
        raise CompanionLibraryError("invalid cursor", 4006)
    now = time.monotonic()
    with _SNAPSHOT_LOCK:
        snapshot = _SNAPSHOTS.get(token)
        if snapshot is None or now - snapshot["stored"] > _SNAPSHOT_TTL:
            _SNAPSHOTS.pop(token, None)
            raise CompanionLibraryError("cursor expired or unavailable", 4006)
        if snapshot.get("scope") != scope:
            raise CompanionLibraryError("cursor scope does not match request", 4006)
        _SNAPSHOTS.move_to_end(token)
        return snapshot


def _limit(params: Mapping[str, Any]) -> int:
    value = params.get("limit", DEFAULT_PAGE_SIZE)
    if type(value) is not int or not 1 <= value <= MAX_PAGE_SIZE:
        raise CompanionLibraryError("limit must be an integer from 1 to 500", -32602)
    return value


def _validate_date(value: Any, field: str) -> str:
    if value in (None, ""):
        return ""
    if not isinstance(value, str) or len(value) > 64:
        raise CompanionLibraryError(f"invalid {field}", -32602)
    _date_instant(value, field)
    return value


def _date_instant(value: str, field: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError
        return parsed.astimezone(timezone.utc)
    except ValueError as exc:
        raise CompanionLibraryError(f"invalid {field}", -32602) from exc


def _filter_values(value: Any, field: str) -> list[str]:
    if value in (None, "", []):
        return []
    values = [value] if isinstance(value, str) else value
    if (
        not isinstance(values, list)
        or len(values) > 256
        or not all(
            isinstance(item, str)
            and bool(item)
            and len(item.encode("utf-8")) <= 512
            and not any(ord(char) < 32 for char in item)
            for item in values
        )
    ):
        raise CompanionLibraryError(f"invalid {field}", -32602)
    return sorted(set(values))


def _filter_catalog(items: list[dict[str, Any]], params: Mapping[str, Any]) -> list[dict[str, Any]]:
    search = params.get("search", "")
    collections = _filter_values(params.get("collection"), "collection")
    dimensions = (
        (_filter_values(params.get("project"), "project"), "projects"),
        (_filter_values(params.get("topic"), "topic"), "topics"),
        (_filter_values(params.get("session"), "session"), "sessions"),
    )
    statuses = _filter_values(params.get("status"), "status")
    kind = params.get("type", "")
    reviewed = params.get("reviewed")
    date_from = _validate_date(params.get("date_from"), "date_from")
    date_to = _validate_date(params.get("date_to"), "date_to")
    if not isinstance(search, str) or len(search) > 500:
        raise CompanionLibraryError("invalid search", -32602)
    if any(status not in {"reviewed", "live"} for status in statuses):
        raise CompanionLibraryError("invalid status", -32602)
    if kind and (not isinstance(kind, str) or kind not in _PREVIEW_TYPES | {"unsupported"}):
        raise CompanionLibraryError("invalid type", -32602)
    if reviewed is not None and type(reviewed) is not bool:
        raise CompanionLibraryError("reviewed must be a boolean", -32602)

    query = search.casefold().strip()
    lower_bound = _date_instant(date_from, "date_from") if date_from else None
    upper_bound = _date_instant(date_to, "date_to") if date_to else None
    filtered = []
    for item in items:
        if collections and item.get("collection", {}).get("id") not in collections:
            continue
        relationships = item.get("relationships", {})
        if any(
            requested and not set(requested).intersection(
                relationship.get("id")
                for relationship in relationships.get(entity_kind, [])
            )
            for requested, entity_kind in dimensions
        ):
            continue
        if statuses and item.get("status") not in statuses:
            continue
        if kind and item.get("preview", {}).get("kind") != kind:
            continue
        if reviewed is not None and bool(item.get("reviewed")) is not reviewed:
            continue
        date = str(item.get("date") or "")
        instant = _date_instant(date, "artifact date") if date else None
        if lower_bound and (instant is None or instant < lower_bound):
            continue
        if upper_bound and (instant is None or instant > upper_bound):
            continue
        if query:
            links = item.get("related_links", [])
            haystack = " ".join(
                str(value)
                for value in (
                    item.get("filename"), item.get("relative_path"), item.get("mime_type"),
                    item.get("collection", {}).get("id"), item.get("collection", {}).get("name"),
                    item.get("collection", {}).get("owner"), item.get("title"), item.get("status"),
                    *(link.get("id") for link in links),
                    *(link.get("title") for link in links),
                )
            ).casefold()
            if query not in haystack:
                continue
        filtered.append(item)
    return sorted(
        filtered,
        key=lambda item: (
            _date_instant(str(item["date"]), "artifact date").timestamp()
            if item.get("date") else float("-inf"),
            item["artifact_id"],
        ),
        reverse=True,
    )


def _coverage(collections: list[dict[str, Any]]) -> tuple[dict[str, Any], list[str]]:
    statuses = {str(item.get("id")): str(item.get("availability")) for item in collections}
    unavailable = [key for key, value in statuses.items() if value != "available"]
    status = "partial" if unavailable else "complete"
    warnings = []
    if unavailable:
        warnings.append(
            "One or more configured Library roots are unavailable; results are incomplete."
        )
    return {"configured": True, "status": status, "collections": statuses}, warnings


def _list(
    server, profile: str, backend: str, library, collections, params,
    *, owner_authorization: Any,
) -> dict[str, Any]:
    limit = _limit(params)
    cursor = _decode_cursor(params.get("cursor"))
    scope = _scope(profile, backend, params)
    snapshot_token: str | None = None
    if cursor is None:
        timestamp = _as_of()
        items = _filter_catalog(
            _filter_relationships(
                server,
                _catalog(library),
                profile=profile,
                backend=backend,
                owner_authorization=owner_authorization,
            ),
            params,
        )
        # The inventory passed by the authorization boundary predates the
        # scan. Re-evaluate it against the library's pinned root identities so
        # a root replaced after authorization cannot be reported available.
        collections = library.list_collections()
        if len(items) > _MAX_SNAPSHOT_ITEMS:
            raise CompanionLibraryError("library listing exceeds the safety limit", 5064)
        snapshot = items
        offset = 0
    else:
        if (
            cursor.get("kind") != "library"
            or cursor.get("scope") != scope
            or type(cursor.get("offset")) is not int
            or cursor["offset"] < 0
        ):
            raise CompanionLibraryError("cursor scope does not match request", 4006)
        stored = _load_snapshot(cursor.get("snapshot"), scope)
        snapshot = stored["items"]
        timestamp = stored["as_of"]
        snapshot_token = cursor["snapshot"]
        offset = cursor["offset"]
        if offset > len(snapshot):
            raise CompanionLibraryError("invalid cursor", 4006)

    page = snapshot[offset : offset + limit]
    has_more = offset + len(page) < len(snapshot)
    next_cursor = None
    if has_more:
        if snapshot_token is None:
            snapshot_token = _store_snapshot(
                {"scope": scope, "items": snapshot, "as_of": timestamp}
            )
        next_cursor = _encode_cursor(
            {
                "v": 1,
                "kind": "library",
                "scope": scope,
                "snapshot": snapshot_token,
                "offset": offset + len(page),
            }
        )
    # Collection availability is live state. Re-read it after scanning so a
    # replaced or disconnected root cannot be reported as a complete empty
    # result merely because it was available when the store was constructed.
    collections = library.list_collections()
    coverage, warnings = _coverage(collections)
    result = {
        "items": page,
        "collections": collections,
        "has_more": has_more,
        "next_cursor": next_cursor,
        "as_of": timestamp,
        "coverage": coverage,
        "warnings": warnings,
        "profile": profile,
        "backend_namespace": backend,
    }
    if coverage["status"] == "complete":
        result["total"] = len(snapshot)
    return result


def _selector(params: Mapping[str, Any]) -> tuple[str | None, bool]:
    version = _version_id(params.get("version_id"))
    latest_raw = params.get("latest", version is None)
    if type(latest_raw) is not bool or (version is not None and latest_raw):
        raise CompanionLibraryError("select either one version_id or latest", -32602)
    if version is None and not latest_raw:
        raise CompanionLibraryError("version_id or latest is required", -32602)
    return version, latest_raw


def _chunk_params(params: Mapping[str, Any]) -> tuple[int, int]:
    offset = params.get("offset", 0)
    chunk_size = params.get("chunk_size", DEFAULT_CHUNK_SIZE)
    if type(offset) is not int or offset < 0:
        raise CompanionLibraryError("offset must be a non-negative integer", -32602)
    if type(chunk_size) is not int or not 1 <= chunk_size <= MAX_CHUNK_SIZE:
        raise CompanionLibraryError(
            f"chunk_size must be an integer from 1 to {MAX_CHUNK_SIZE}", -32602
        )
    return offset, chunk_size


def _open_selected(library: ArtifactLibrary, artifact_id: str, version: str | None):
    return library.download(artifact_id, version)


def _transfer_descriptor(
    artifact_id: str, metadata: Mapping[str, Any], *, preview: bool
) -> str:
    value = {
        "v": 1,
        "kind": "library-transfer",
        "artifact_id": artifact_id,
        "version_id": metadata.get("version_id"),
        "sha256": metadata.get("sha256"),
        "size": metadata.get("size"),
        "filename": metadata.get("filename"),
        "mime_type": metadata.get("mime_type"),
        "preview": preview,
    }
    return _encode_cursor(value)


def _verify_transfer_descriptor(
    raw: Any,
    artifact_id: str,
    metadata: Mapping[str, Any],
    *,
    preview: bool,
    required: bool,
) -> str:
    expected = _transfer_descriptor(artifact_id, metadata, preview=preview)
    if raw in (None, ""):
        if required:
            raise CompanionLibraryError("transfer descriptor is required after the first chunk", 4090)
        return expected
    try:
        decoded = _decode_cursor(raw)
    except CompanionLibraryError as exc:
        raise CompanionLibraryError("artifact changed during transfer", 4090) from exc
    if (
        not isinstance(decoded, dict)
        or decoded.get("kind") != "library-transfer"
        or not hmac.compare_digest(raw, expected)
    ):
        raise CompanionLibraryError("artifact changed during transfer", 4090)
    return expected


def _chunk(
    opened,
    offset: int,
    chunk_size: int,
    *,
    artifact_id: str,
    preview: bool,
    descriptor: Any,
) -> dict[str, Any]:
    metadata = opened.metadata
    size = metadata.get("size")
    digest = metadata.get("sha256")
    if type(size) is not int or size < 0 or not isinstance(digest, str):
        raise ArtifactUnavailable("artifact metadata is unavailable")
    if offset > size:
        raise CompanionLibraryError("offset exceeds artifact size", -32602)
    stable_descriptor = _verify_transfer_descriptor(
        descriptor, artifact_id, metadata, preview=preview, required=offset > 0
    )
    try:
        opened.file.seek(offset)
        data = opened.read(min(chunk_size, size - offset))
    except (OSError, ValueError) as exc:
        raise ArtifactUnavailable("artifact chunk is unavailable") from exc
    next_offset = offset + len(data)
    result = {
        "data_base64": base64.b64encode(data).decode("ascii"),
        "offset": offset,
        "next_offset": next_offset,
        "eof": next_offset >= size,
        "size": size,
        "sha256": digest,
        "filename": metadata.get("filename", "artifact"),
        "mime_type": metadata.get("mime_type", "application/octet-stream"),
        "descriptor": stable_descriptor,
    }
    return result


def _get(library: ArtifactLibrary, artifact_id: str) -> dict[str, Any]:
    return _detail_projection(library.get_artifact(artifact_id))


def _pin_reviewed(
    server, library: ArtifactLibrary, params: Mapping[str, Any], *, profile: str,
    backend: str, owner_authorization: Any,
) -> dict[str, Any]:
    artifact_id = _artifact_id(params.get("artifact_id"))
    provenance = params.get("provenance")
    if not isinstance(provenance, (Mapping, str)) or not provenance:
        raise CompanionLibraryError("non-empty provenance is required", -32602)
    try:
        relationships = ArtifactLibrary._validated_relationships(
            params.get("relationships")
        )
    except ValueError as exc:
        raise CompanionLibraryError("invalid artifact relationships", -32602) from exc
    relationships = _authorized_relationships(
        server,
        relationships,
        profile=profile,
        backend=backend,
        owner_authorization=owner_authorization,
        strict=True,
    )
    detail = library.get_artifact(artifact_id)
    latest = detail.get("latest")
    if not isinstance(latest, Mapping) or latest.get("availability") != "available":
        raise ArtifactUnavailable("latest artifact is unavailable")
    reviewed_descriptor = params.get("reviewed_descriptor")
    if not isinstance(reviewed_descriptor, str) or not reviewed_descriptor:
        raise CompanionLibraryError(
            "a reviewed immutable source descriptor is required", -32602
        )
    # Only a descriptor returned by the safe-preview lane can authorize a
    # review pin. It is signed over the exact live fingerprint; regenerating an
    # expectation from a newer live file therefore rejects V1 -> V2 swaps.
    _verify_transfer_descriptor(
        reviewed_descriptor,
        artifact_id,
        latest,
        preview=True,
        required=True,
    )
    pinned = library.pin_reviewed(
        latest["collection"]["id"],
        latest["relative_path"],
        provenance=_safe_provenance(provenance),
        title=params.get("title"),
        relationships=relationships,
        expected_fingerprint={
            "sha256": latest.get("sha256"),
            "size": latest.get("size"),
            "filename": latest.get("filename"),
            "mime_type": latest.get("mime_type"),
        },
    )
    return {
        "artifact_id": artifact_id,
        "profile": profile,
        "backend_namespace": backend,
        "version": _version_projection(pinned),
    }


def _content(library: ArtifactLibrary, params: Mapping[str, Any], *, preview: bool) -> dict[str, Any]:
    artifact_id = _artifact_id(params.get("artifact_id"))
    version, _latest = _selector(params)
    offset, chunk_size = _chunk_params(params)
    detail = library.get_artifact(artifact_id)
    selected: Mapping[str, Any] | None
    if version is None:
        selected = detail.get("latest") if isinstance(detail.get("latest"), Mapping) else None
    else:
        selected = next(
            (item for item in detail.get("versions", []) if item.get("version_id") == version),
            None,
        )
    if not isinstance(selected, Mapping):
        raise ArtifactNotFound("artifact version not found")

    preview_policy = _preview(selected.get("preview"))
    if preview and not preview_policy.get("preview_available"):
        return {
            "artifact_id": artifact_id,
            "version_id": version,
            "preview": preview_policy,
            "available": False,
        }
    if preview and preview_policy.get("kind") == "html":
        opened = library.open_html_preview(artifact_id, version)
    else:
        # Only browser-safe classified preview kinds reach this branch. Original
        # retrieval remains a separately named RPC even though image/PDF bytes
        # are necessarily their own static preview representation.
        opened = _open_selected(library, artifact_id, version)
    with opened:
        result = _chunk(
            opened,
            offset,
            chunk_size,
            artifact_id=artifact_id,
            preview=preview,
            descriptor=params.get("descriptor"),
        )
        result.update(
            {
                "artifact_id": artifact_id,
                "version_id": opened.metadata.get("version_id"),
            }
        )
        if preview:
            result["preview"] = preview_policy
            for key in (
                "sandbox", "scripts", "network", "app_origin", "content_security_policy",
            ):
                if key in opened.metadata:
                    result[key] = opened.metadata[key]
        else:
            result["download"] = _download_descriptor()
        return result


def _validate_params(operation: str, params: Any) -> dict[str, Any]:
    if not isinstance(params, dict):
        raise CompanionLibraryError("parameters must be an object", -32602)
    allowed = {
        "profiles": set(),
        "list": {
            "profile", "search", "collection", "type", "date_from", "date_to",
            "reviewed", "project", "topic", "session", "status", "limit", "cursor",
        },
        "get": {"profile", "artifact_id"},
        "preview": {
            "profile", "artifact_id", "version_id", "latest", "offset", "chunk_size",
            "descriptor",
        },
        "download": {
            "profile", "artifact_id", "version_id", "latest", "offset", "chunk_size",
            "descriptor",
        },
        "pin_reviewed": {
            "profile", "artifact_id", "provenance", "title", "relationships",
            "reviewed_descriptor",
        },
    }[operation]
    if set(params) - allowed:
        raise CompanionLibraryError("unexpected library parameters; paths are not accepted", -32602)
    return params


def execute(
    server,
    operation: str,
    params: Any,
    *,
    owner_authorization: Any = None,
) -> dict[str, Any]:
    if operation not in {"profiles", "list", "get", "preview", "download", "pin_reviewed"}:
        raise CompanionLibraryError("unknown library operation", -32601)
    params = _validate_params(operation, params)
    _require_owner(owner_authorization)
    if operation == "profiles":
        return {
            "items": _authorized_profile_catalog(server),
            "backend_namespace": _backend_namespace(server, installation_home=_launch_home()),
            "as_of": _as_of(),
        }
    profile = _profile(server, params.get("profile"))
    library, collections = _authorized_library(server, profile)
    backend = _backend_namespace(server, installation_home=_launch_home())
    timestamp = _as_of()
    if library is None:
        if operation != "list":
            raise CompanionLibraryError("artifact not found", 4404)
        return {
            "items": [],
            "collections": [],
            "has_more": False,
            "next_cursor": None,
            "total": 0,
            "as_of": timestamp,
            "coverage": {"configured": False, "status": "unconfigured", "collections": {}},
            "warnings": [
                "No Companion Library collections are configured for this profile; no roots were scanned."
            ],
            "profile": profile,
            "backend_namespace": backend,
        }
    try:
        if operation == "list":
            return _list(
                server, profile, backend, library, collections, params,
                owner_authorization=owner_authorization,
            )
        artifact_id = _artifact_id(params.get("artifact_id"))
        if operation == "get":
            result = _get(library, artifact_id)
            relationship_items = list(result.get("versions", []))
            if isinstance(result.get("latest"), dict):
                relationship_items.append(result["latest"])
            _filter_relationships(
                server,
                relationship_items,
                profile=profile,
                backend=backend,
                owner_authorization=owner_authorization,
            )
            result.update({"as_of": timestamp, "profile": profile, "backend_namespace": backend})
            return result
        if operation == "pin_reviewed":
            return _pin_reviewed(
                server, library, params, profile=profile, backend=backend,
                owner_authorization=owner_authorization,
            )
        return _content(library, params, preview=operation == "preview")
    except CompanionLibraryError:
        raise
    except ArtifactSecurityError as exc:
        raise CompanionLibraryError("artifact access denied", 4403) from exc
    except ArtifactNotFound as exc:
        raise CompanionLibraryError("artifact not found", 4404) from exc
    except ArtifactUnavailable as exc:
        raise CompanionLibraryError("artifact unavailable", 4504) from exc
    except ArtifactError as exc:
        raise CompanionLibraryError("artifact operation failed", 5064) from exc
