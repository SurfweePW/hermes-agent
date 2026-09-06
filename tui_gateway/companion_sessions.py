"""Read-only, bounded projections of persisted Companion sessions."""
from __future__ import annotations

import base64
import atexit
from collections import OrderedDict
import contextlib
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import tempfile
import threading
import time
from typing import Any, Iterator, Mapping

from tui_gateway.companion_projects import _backend_namespace


# Query batch size, not a population cap. Every eligible row is collected into
# the server-side immutable snapshot before the first page is returned.
_MAX_SNAPSHOT_SESSIONS = 5000
_DEFAULT_LIMIT = 200
_MAX_LIMIT = 500
_MAX_CURSOR_LENGTH = 8_000_000
_MAX_SESSION_ID_LENGTH = 512
_MAX_QUERY_LENGTH = 4096
_MAX_HISTORY_SNAPSHOT_MESSAGES = 50_000
_SNAPSHOT_TTL_SECONDS = 300.0
_MAX_SNAPSHOT_CACHE_ENTRIES = 128
_MAX_SNAPSHOT_CACHE_BYTES = 64 * 1024 * 1024
_MAX_SINGLE_SNAPSHOT_BYTES = 16 * 1024 * 1024
_MAX_SQLITE_INTEGER = (1 << 63) - 1
_WORKER_SOURCES = ["tool", "kanban"]
_CURSOR_KEY = hashlib.sha256(
    b"companion-session-cursor-v1\0"
    + (os.environ.get("GATEWAY_RELAY_SECRET", "").encode() or secrets.token_bytes(32))
).digest()
_SNAPSHOT_CACHE: OrderedDict[str, tuple[float, str, dict, Any, int]] = OrderedDict()
_SNAPSHOT_CACHE_BYTES = 0
_SNAPSHOT_CACHE_LOCK = threading.Lock()


class _DiskSnapshot:
    def __init__(self, path: str):
        self.path = path


def _remove_snapshot_payload(payload: Any) -> None:
    if isinstance(payload, _DiskSnapshot):
        with contextlib.suppress(OSError):
            os.unlink(payload.path)


def _cleanup_snapshot_cache() -> None:
    with _SNAPSHOT_CACHE_LOCK:
        for _expires, _kind, _scope, payload, _size in _SNAPSHOT_CACHE.values():
            _remove_snapshot_payload(payload)
        _SNAPSHOT_CACHE.clear()


atexit.register(_cleanup_snapshot_cache)


class CompanionSessionsError(Exception):
    def __init__(self, message: str, code: int):
        super().__init__(message)
        self.code = code


def _require_owner(owner_authorization: Any) -> str:
    from tui_gateway.companion_library import _require_owner as require_owner

    try:
        return require_owner(owner_authorization)
    except Exception as exc:
        raise CompanionSessionsError(
            "authenticated dashboard owner required", 4403
        ) from exc


def _owner_authorized_profiles(server) -> frozenset[str]:
    """Return the profiles explicitly served by this gateway."""
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
        raise CompanionSessionsError("session profile unavailable", 4403) from exc


def _as_of() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _encode_cursor(value: dict[str, Any]) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    payload = base64.urlsafe_b64encode(raw).decode().rstrip("=")
    signature = hmac.new(_CURSOR_KEY, raw, hashlib.sha256).digest()
    tag = base64.urlsafe_b64encode(signature).decode().rstrip("=")
    return f"{payload}.{tag}"


def _reject_json_constant(_value: str) -> None:
    raise ValueError("non-finite JSON number")


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON key")
        value[key] = item
    return value


def _decode_cursor(raw: Any) -> dict[str, Any] | None:
    if raw in (None, ""):
        return None
    if not isinstance(raw, str) or len(raw) > _MAX_CURSOR_LENGTH:
        raise CompanionSessionsError("invalid cursor", 4006)
    try:
        payload, tag = raw.split(".")
        if not payload or not tag:
            raise ValueError
        padded = payload + "=" * (-len(payload) % 4)
        decoded = base64.b64decode(padded.encode(), altchars=b"-_", validate=True)
        tag_padded = tag + "=" * (-len(tag) % 4)
        signature = base64.b64decode(tag_padded.encode(), altchars=b"-_", validate=True)
        expected = hmac.new(_CURSOR_KEY, decoded, hashlib.sha256).digest()
        if len(signature) != len(expected) or not hmac.compare_digest(signature, expected):
            raise ValueError
        value = json.loads(
            decoded.decode(),
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_json_constant,
        )
        if (
            not isinstance(value, dict)
            or type(value.get("v")) is not int
            or value["v"] != 1
        ):
            raise ValueError
        return value
    except Exception as exc:
        raise CompanionSessionsError("invalid cursor", 4006) from exc


def _scope_digest(kind: str, scope: dict) -> str:
    raw = json.dumps(
        {"kind": kind, "scope": scope}, sort_keys=True, separators=(",", ":")
    ).encode()
    return hmac.new(_CURSOR_KEY, raw, hashlib.sha256).hexdigest()


def _purge_snapshot_cache(now: float) -> None:
    global _SNAPSHOT_CACHE_BYTES
    expired = [
        token
        for token, (expires_at, _kind, _scope, _payload, _size) in _SNAPSHOT_CACHE.items()
        if expires_at <= now
    ]
    for token in expired:
        _expires_at, _kind, _scope, payload, size = _SNAPSHOT_CACHE.pop(token)
        _remove_snapshot_payload(payload)
        _SNAPSHOT_CACHE_BYTES -= size


def _cache_snapshot(kind: str, scope: dict, payload: Any) -> str:
    global _SNAPSHOT_CACHE_BYTES
    serialized = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    size = len(serialized)
    cached_payload: Any = payload
    if size > _MAX_SINGLE_SNAPSHOT_BYTES:
        fd, path = tempfile.mkstemp(prefix="hermes-session-snapshot-", suffix=".json")
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(serialized)
        except Exception:
            with contextlib.suppress(OSError):
                os.close(fd)
            with contextlib.suppress(OSError):
                os.unlink(path)
            raise
        cached_payload = _DiskSnapshot(path)
        size = 0
    now = time.monotonic()
    with _SNAPSHOT_CACHE_LOCK:
        _purge_snapshot_cache(now)
        token = secrets.token_urlsafe(24)
        while token in _SNAPSHOT_CACHE:
            token = secrets.token_urlsafe(24)
        while _SNAPSHOT_CACHE and (
            len(_SNAPSHOT_CACHE) >= _MAX_SNAPSHOT_CACHE_ENTRIES
            or _SNAPSHOT_CACHE_BYTES + size > _MAX_SNAPSHOT_CACHE_BYTES
        ):
            _old_token, (_expires, _kind, _scope, old_payload, old_size) = (
                _SNAPSHOT_CACHE.popitem(last=False)
            )
            _remove_snapshot_payload(old_payload)
            _SNAPSHOT_CACHE_BYTES -= old_size
        _SNAPSHOT_CACHE[token] = (
            now + _SNAPSHOT_TTL_SECONDS,
            kind,
            dict(scope),
            cached_payload,
            size,
        )
        _SNAPSHOT_CACHE_BYTES += size
    return token


def _get_snapshot(token: Any, kind: str, scope: dict) -> Any:
    if not _valid_bounded_string(token, 128):
        raise CompanionSessionsError("invalid cursor", 4006)
    now = time.monotonic()
    with _SNAPSHOT_CACHE_LOCK:
        _purge_snapshot_cache(now)
        entry = _SNAPSHOT_CACHE.get(token)
        if entry is None:
            raise CompanionSessionsError("session snapshot is unavailable or expired", 4404)
        _expires_at, cached_kind, cached_scope, payload, _size = entry
        if cached_kind != kind or cached_scope != scope:
            raise CompanionSessionsError("cursor scope does not match request", 4006)
        if isinstance(payload, _DiskSnapshot):
            try:
                with open(payload.path, "rb") as stream:
                    return json.load(stream)
            except (OSError, ValueError, TypeError) as exc:
                raise CompanionSessionsError(
                    "session snapshot is unavailable or expired", 4404
                ) from exc
    return payload


def _validate_profile(server, raw: Any) -> str:
    from hermes_cli.profiles import validate_profile_name

    current = str(server._current_profile_name() or "default")
    if raw is None:
        raw = current
    if not isinstance(raw, str) or not raw or raw != raw.strip():
        raise CompanionSessionsError("invalid profile", 4003)
    try:
        validate_profile_name(raw)
    except ValueError as exc:
        raise CompanionSessionsError(f"invalid profile: {exc}", 4003) from exc
    if raw not in _owner_authorized_profiles(server):
        raise CompanionSessionsError("session profile unavailable", 4403)
    return raw


@contextlib.contextmanager
def _source(server, profile: str) -> Iterator[Any]:
    """Open exactly one no-follow profile state store without activating it."""
    from hermes_state import SessionDB
    from tui_gateway.companion_projects import (
        CompanionProjectsError,
        _resolve_profile,
        _SourceGuard,
        _validated_profile_dir,
    )

    guard = None
    db = None
    owns_db = False
    try:
        if profile == str(server._current_profile_name() or "default"):
            db = server._get_db()
            if db is None:
                raise CompanionSessionsError("state.db unavailable", 5006)
            path = Path(db.db_path)
            home = _validated_profile_dir(path.parent, anchor=path.parent)
            guard = _SourceGuard(home, path.name)
        else:
            resolved, home = _resolve_profile(server, profile)
            if resolved != profile:
                raise CompanionSessionsError("session profile unavailable", 4403)
            guard = _SourceGuard(home, "state.db")

        guard.open()
        if guard.opened is None:
            raise CompanionSessionsError("profile session state unavailable", 4404)
        if db is None:
            db = SessionDB(db_path=guard.path, read_only=True)
            owns_db = True
        guard.validate()
        yield db
        guard.validate()
    except CompanionSessionsError:
        raise
    except CompanionProjectsError as exc:
        raise CompanionSessionsError("profile session state unavailable", 4404) from exc
    except Exception as exc:
        raise CompanionSessionsError("profile session state unavailable", 4404) from exc
    finally:
        if owns_db and db is not None:
            db.close()
        if guard is not None:
            guard.close()


def _limit(params: dict) -> int:
    value = params.get("limit", _DEFAULT_LIMIT)
    if type(value) is not int or not 1 <= value <= _MAX_LIMIT:
        raise CompanionSessionsError("limit must be an integer from 1 to 500", -32602)
    return value


def _session_rowids(db) -> tuple[int, dict[str, int]]:
    with db._read_ctx() as conn:
        rows = conn.execute("SELECT rowid, id FROM sessions").fetchall()
    mapping = {str(row["id"]): int(row["rowid"]) for row in rows}
    return max(mapping.values(), default=0), mapping


def _valid_bounded_string(value: Any, maximum: int) -> bool:
    return isinstance(value, str) and 0 < len(value) <= maximum


def _valid_cursor_integer(value: Any) -> bool:
    return type(value) is int and 0 <= value <= _MAX_SQLITE_INTEGER


def _validate_snapshot_cursor(cursor: dict[str, Any], kind: str, scope: dict) -> tuple[int, str]:
    if (
        set(cursor) != {"v", "kind", "scope", "offset", "snapshot"}
        or cursor.get("kind") != kind
        or cursor.get("scope") != _scope_digest(kind, scope)
        or not _valid_cursor_integer(cursor.get("offset"))
        or not _valid_bounded_string(cursor.get("snapshot"), 128)
    ):
        raise CompanionSessionsError("cursor scope does not match request", 4006)
    return cursor["offset"], cursor["snapshot"]


def _identity(profile: str, backend: str, root: str, tip: str) -> dict:
    return {
        "backend_namespace": backend,
        "profile": profile,
        "original_id": root,
        "root_id": root,
        "resolved_tip_id": tip,
    }


def _list_scope(profile: str, backend: str, params: dict) -> dict:
    return {
        "profile": profile,
        "backend": backend,
        "view": params.get("view", "active"),
        "origin": sorted(_filter_values(params.get("origin"), "origin")),
        "backend_namespace": sorted(
            _filter_values(params.get("backend_namespace"), "backend_namespace")
        ),
        "search": params.get("search") or "",
    }


def _validate_list_params(params: Any) -> dict:
    if not isinstance(params, dict):
        raise CompanionSessionsError("parameters must be an object", -32602)
    allowed = {
        "profile", "limit", "cursor", "view", "origin", "backend_namespace", "search"
    }
    if set(params) - allowed:
        raise CompanionSessionsError("unexpected session browsing parameters", -32602)
    view = params.get("view", "active")
    if not isinstance(view, str) or view not in {"active", "hidden", "archived", "all"}:
        raise CompanionSessionsError("invalid session view", -32602)
    _filter_values(params.get("origin"), "origin")
    _filter_values(params.get("backend_namespace"), "backend_namespace")
    if "search" in params and (
        not isinstance(params["search"], str) or len(params["search"]) > _MAX_QUERY_LENGTH
    ):
        raise CompanionSessionsError("search must be a bounded string", -32602)
    return params


def _filter_values(value: Any, field: str) -> tuple[str, ...]:
    """Validate one-or-many exact directory filters without repairing them."""
    if value in (None, ""):
        return ()
    values = value if isinstance(value, list) else [value]
    if not values or len(values) > 100:
        raise CompanionSessionsError(f"invalid {field}", -32602)
    result = []
    for item in values:
        if (
            not isinstance(item, str)
            or not item
            or item != item.strip()
            or len(item) > _MAX_QUERY_LENGTH
        ):
            raise CompanionSessionsError(f"{field} must contain bounded strings", -32602)
        result.append(item)
    return tuple(sorted(set(result)))


def list_sessions(server, params: Any, *, owner_authorization: Any = None) -> dict:
    params = _validate_list_params(params)
    _require_owner(owner_authorization)
    profile = _validate_profile(server, params.get("profile"))
    backend = _backend_namespace(server)
    scope = _list_scope(profile, backend, params)
    cursor = _decode_cursor(params.get("cursor"))
    limit = _limit(params)

    snapshot_token = None
    if cursor is not None:
        offset, snapshot_token = _validate_snapshot_cursor(cursor, "sessions", scope)
        snapshot = _get_snapshot(snapshot_token, "sessions", scope)
        items = snapshot["items"]
        bounded = snapshot["bounded"]
        timestamp = snapshot["as_of"]
        if offset >= len(items):
            raise CompanionSessionsError("invalid cursor", 4006)
    else:
        offset = 0
        timestamp = _as_of()
        view = params.get("view", "active")
        origins = _filter_values(params.get("origin"), "origin")
        backend_namespaces = _filter_values(
            params.get("backend_namespace"), "backend_namespace"
        )
        with _source(server, profile) as db:
            rows = []
            query_offset = 0
            while True:
                batch = db.list_sessions_rich(
                    sources=list(origins) or None,
                    exclude_sources=_WORKER_SOURCES,
                    limit=_MAX_SNAPSHOT_SESSIONS,
                    offset=query_offset,
                    include_children=False,
                    min_message_count=0,
                    project_compression_tips=True,
                    order_by_last_active=True,
                    include_archived=view in {"archived", "all"},
                    archived_only=view == "archived",
                    search_query=params.get("search") or None,
                    compact_rows=True,
                    include_hidden=view in {"hidden", "all"},
                    hidden_only=view == "hidden",
                )
                rows.extend(batch)
                if len(batch) < _MAX_SNAPSHOT_SESSIONS:
                    break
                query_offset += len(batch)
            snapshot_rowid, rowids = _session_rowids(db)
            filtered = []
            for row in rows:
                if backend_namespaces and backend not in backend_namespaces:
                    continue

                root = str(row.get("_lineage_root_id") or row["id"])
                tip = str(row["id"])
                if rowids.get(root, snapshot_rowid + 1) > snapshot_rowid:
                    continue
                if rowids.get(tip, snapshot_rowid + 1) > snapshot_rowid:
                    continue
                if view == "hidden" and not bool(row.get("hidden")):
                    continue
                if view == "active" and (
                    bool(row.get("hidden")) or bool(row.get("archived"))
                ):
                    continue
                filtered.append((row, root, tip))

        offset = 0
        bounded = False
        items = []
        for row, root, tip in filtered:
            origin = str(row.get("source") or "")
            items.append(
                {
                    "identity": _identity(profile, backend, root, tip),
                    "original_id": root,
                    "root_id": root,
                    "resolved_tip_id": tip,
                    "title": _safe_text(row.get("title") or ""),
                    "preview": _safe_text(row.get("preview") or ""),
                    "origin": origin,
                    "source": origin,
                    "started_at": float(row.get("started_at") or 0),
                    "last_active": float(
                        row.get("last_active") or row.get("started_at") or 0
                    ),
                    "message_count": int(row.get("message_count") or 0),
                    "hidden": bool(row.get("hidden")),
                    "archived": bool(row.get("archived")),
                    "pinned": bool(row.get("pinned")),
                }
            )

    page = items[offset : offset + limit]
    has_more = offset + len(page) < len(items)
    next_cursor = None
    if has_more:
        if snapshot_token is None:
            snapshot_token = _cache_snapshot(
                "sessions",
                scope,
                {"items": items, "bounded": bounded, "as_of": timestamp},
            )
        next_cursor = _encode_cursor(
            {
                "v": 1,
                "kind": "sessions",
                "scope": _scope_digest("sessions", scope),
                "offset": offset + len(page),
                "snapshot": snapshot_token,
            }
        )

    warnings = []
    if bounded:
        warnings.append(
            f"Session listing is bounded to {_MAX_SNAPSHOT_SESSIONS} conversations."
        )
    result = {
        "items": page,
        "has_more": has_more,
        "next_cursor": next_cursor,
        "as_of": timestamp,
        "coverage": "bounded" if bounded else "complete",
        "warnings": warnings,
        "profile": profile,
        "backend_namespace": backend,
    }
    if not bounded:
        result["total"] = len(items)
    return result


def _compression_descriptor(db, requested: str) -> tuple[str, str, list[str]]:
    row = db.get_session(requested)
    if row is None:
        raise CompanionSessionsError("session not found", 4404)
    root = requested
    seen = {root}
    for _ in range(100):
        current = db.get_session(root)
        parent_id = str(current.get("parent_session_id") or "") if current else ""
        if not parent_id or parent_id in seen:
            break
        parent = db.get_session(parent_id)
        model_config = current.get("model_config") if current else None
        if isinstance(model_config, str):
            try:
                model_config = json.loads(model_config)
            except Exception:
                model_config = {}
        if (
            not parent
            or parent.get("end_reason") != "compression"
            or (isinstance(model_config, dict) and (model_config.get("_branched_from") or model_config.get("_delegate_from")))
            or str(current.get("source") or "") == "tool"
        ):
            break
        root = parent_id
        seen.add(root)
    tip = str(db.get_compression_tip(root) or root)
    segments = [root]
    current = root
    for _ in range(100):
        if current == tip:
            break
        with db._read_ctx() as conn:
            candidates = conn.execute(
                "SELECT id FROM sessions WHERE parent_session_id = ? ORDER BY rowid",
                (current,),
            ).fetchall()
        next_id = None
        for candidate in candidates:
            cid = str(candidate["id"])
            if cid in segments:
                continue
            if db.get_compression_tip(cid) == tip:
                next_id = cid
                break
        if next_id is None:
            break
        segments.append(next_id)
        current = next_id
    if segments[-1] != tip:
        raise CompanionSessionsError("session lineage is unavailable", 4404)
    return root, tip, segments


def _safe_text(value: Any) -> str:
    from agent.redact import redact_sensitive_text

    try:
        return redact_sensitive_text(str(value or ""), force=True)
    except Exception:
        return "[REDACTED - redaction failed]"


_ATTACHMENT_REFERENCE = re.compile(
    r"(?:\[(?:image|file|document|audio|video) attached at:[^\]\n]*\]|"
    r"\bMEDIA:\s*(?:file://)?\S+|data:image/[^;\s]+;base64,[A-Za-z0-9+/=]+)",
    re.IGNORECASE,
)
_HOST_PATH = re.compile(
    r"(?<![\w:])(?:file://)?/(?:Users|home|root|private|var|tmp|opt|mnt|Volumes)/[^\s\]\[()<>]+"
    r"|(?<![\w])(?:[A-Za-z]:\\[^\s\]\[()<>]+)"
)
_SUMMARY_MARKERS = (
    "[CONTEXT SUMMARY]:",
    "[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]",
    "--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---",
)


def _safe_history_message(role: str, content: Any, base: dict) -> dict:
    """Project persisted text without exposing host attachment locations."""
    text = str(content or "")
    is_summary = role in {"user", "assistant"} and any(
        marker in text for marker in _SUMMARY_MARKERS
    )
    if is_summary:
        return {
            "kind": "internal_event",
            "event": "compaction_summary",
            "label": "Earlier context summary (details hidden)",
            "collapsed": True,
            **base,
        }
    has_attachment = bool(_ATTACHMENT_REFERENCE.search(text))
    has_host_path = bool(_HOST_PATH.search(text))
    if has_attachment or has_host_path:
        return {
            "kind": "internal_event",
            "event": "attachment_projection",
            "label": (
                "Attachment or artifact (details hidden)"
                if has_attachment
                else "Host path reference (details hidden)"
            ),
            "collapsed": True,
            **base,
        }
    return {"kind": "message", "role": role, "text": _safe_text(text), **base}


def _history_item(db, row: Any) -> dict:
    base = {
        "row_id": int(row["id"]),
        "segment_id": str(row["session_id"]),
        "timestamp": float(row["timestamp"] or 0),
    }
    display_kind = str(row["display_kind"] or "").strip()
    if display_kind:
        safe_display_kind = _safe_text(display_kind)
        return {
            "kind": "internal_event",
            "event": safe_display_kind,
            "label": _safe_text(safe_display_kind.replace("_", " ").capitalize()),
            "collapsed": True,
            **base,
        }
    if row["tool_calls"]:
        return {
            "kind": "internal_event",
            "event": "tool_call",
            "label": "Assistant used one or more tools",
            "collapsed": True,
            **base,
        }
    role = str(row["role"] or "")
    if role == "system":
        return {
            "kind": "internal_event",
            "event": "system_message",
            "label": "System message",
            "collapsed": True,
            **base,
        }
    if role == "tool":
        name = _safe_text(row["tool_name"] or "tool")
        return {
            "kind": "internal_event",
            "event": "tool_result",
            "label": _safe_text(f"Tool completed: {name}"),
            "collapsed": True,
            **base,
        }
    if role not in {"user", "assistant"}:
        return {
            "kind": "internal_event",
            "event": "internal_message",
            "label": "Internal message",
            "collapsed": True,
            **base,
        }
    content = db._decode_content(row["content"]) if row["content"] is not None else ""
    return _safe_history_message(role, content, base)


def _validate_history_params(params: Any) -> dict:
    if not isinstance(params, dict):
        raise CompanionSessionsError("parameters must be an object", -32602)
    allowed = {"profile", "session_id", "id", "limit", "cursor"}
    if set(params) - allowed:
        raise CompanionSessionsError("unexpected session history parameters", -32602)
    for key in ("session_id", "id"):
        if key in params and not _valid_bounded_string(
            params[key], _MAX_SESSION_ID_LENGTH
        ):
            raise CompanionSessionsError(f"{key} must be a bounded string", -32602)
    session_id = params.get("session_id")
    alias_id = params.get("id")
    if session_id is not None and alias_id is not None and session_id != alias_id:
        raise CompanionSessionsError("session_id and id must match", -32602)
    requested = session_id if session_id is not None else alias_id
    if requested is None:
        raise CompanionSessionsError("session_id required", -32602)
    params = dict(params)
    params["requested"] = requested
    return params


def session_history(server, params: Any, *, owner_authorization: Any = None) -> dict:
    params = _validate_history_params(params)
    _require_owner(owner_authorization)
    profile = _validate_profile(server, params.get("profile"))
    backend = _backend_namespace(server)
    limit = _limit(params)
    request_scope = {
        "profile": profile,
        "backend": backend,
        "requested": params["requested"],
    }
    cursor = _decode_cursor(params.get("cursor"))

    snapshot_token = None
    if cursor is not None:
        offset, snapshot_token = _validate_snapshot_cursor(
            cursor, "history", request_scope
        )
        payload = _get_snapshot(snapshot_token, "history", request_scope)
        root = payload["root"]
        tip = payload["tip"]
        snapshot = payload["items"]
        bounded = payload["bounded"]
        timestamp = payload["as_of"]
        if offset >= len(snapshot):
            raise CompanionSessionsError("invalid cursor", 4006)
    else:
        offset = 0
        timestamp = _as_of()
        with _source(server, profile) as db:
            root, tip, segments = _compression_descriptor(db, params["requested"])
            placeholders = ",".join("?" for _ in segments)
            sql = f"""
                SELECT id, session_id, role, content, timestamp, tool_calls, tool_name, display_kind
                  FROM messages
                 WHERE session_id IN ({placeholders})
                   AND (active = 1 OR compacted = 1)
                 ORDER BY id ASC
                 LIMIT {_MAX_HISTORY_SNAPSHOT_MESSAGES + 1}
            """
            with db._read_ctx() as conn:
                rows = conn.execute(sql, segments).fetchall()
            bounded = len(rows) > _MAX_HISTORY_SNAPSHOT_MESSAGES
            snapshot = [
                _history_item(db, row)
                for row in rows[:_MAX_HISTORY_SNAPSHOT_MESSAGES]
            ]

    total = len(snapshot)
    items = snapshot[offset : offset + limit]
    has_more = offset + len(items) < total
    next_cursor = None
    if has_more:
        if snapshot_token is None:
            snapshot_token = _cache_snapshot(
                "history",
                request_scope,
                {
                    "root": root,
                    "tip": tip,
                    "items": snapshot,
                    "bounded": bounded,
                    "as_of": timestamp,
                },
            )
        next_cursor = _encode_cursor(
            {
                "v": 1,
                "kind": "history",
                "scope": _scope_digest("history", request_scope),
                "offset": offset + len(items),
                "snapshot": snapshot_token,
            }
        )

    warnings = []
    if bounded:
        warnings.append(
            "Session history is bounded to "
            f"{_MAX_HISTORY_SNAPSHOT_MESSAGES} messages."
        )
    result = {
        "identity": _identity(profile, backend, root, tip),
        "items": items,
        "has_more": has_more,
        "next_cursor": next_cursor,
        "as_of": timestamp,
        "coverage": "bounded" if bounded else "complete",
        "warnings": warnings,
        "profile": profile,
        "backend_namespace": backend,
    }
    if not bounded:
        result["total"] = total
    return result
