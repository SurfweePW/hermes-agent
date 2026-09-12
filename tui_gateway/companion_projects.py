"""Read-only Companion projection of Desktop projects and discovered repos."""
from __future__ import annotations

import base64
import atexit
import binascii
import contextlib
from collections import OrderedDict
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import tempfile
import threading
import time
import uuid
from typing import Any


class CompanionProjectsError(Exception):
    def __init__(self, message: str, code: int):
        super().__init__(message)
        self.code = code


def _require_owner(owner_authorization: Any) -> str:
    from tui_gateway.companion_library import _require_owner as require_owner

    try:
        return require_owner(owner_authorization)
    except Exception as exc:
        raise CompanionProjectsError(
            "authenticated dashboard owner required", 4403
        ) from exc


def _as_of() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _machine_identity() -> str:
    """Return stable public machine material, or an empty string."""
    machine = str(os.environ.get("HERMES_MACHINE_ID") or "").strip()
    if machine:
        return machine
    for path in (Path("/etc/machine-id"), Path("/var/lib/dbus/machine-id")):
        try:
            machine = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if machine:
            return machine
    try:
        result = subprocess.run(  # noqa: S603 - fixed absolute system binary
            ["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
        match = re.search(r'"IOPlatformUUID"\s*=\s*"([^"\r\n]+)"', result.stdout)
        if result.returncode == 0 and match:
            return match.group(1)
    except (OSError, subprocess.SubprocessError):
        pass
    node = uuid.getnode()
    if node and not (node & 0x010000000000):
        return f"node:{node:012x}"
    return ""


def _backend_namespace(server, *, installation_home: Path | None = None) -> str:
    """Return a stable, non-secret identity for this backend installation."""
    value = str(
        os.environ.get("GATEWAY_RELAY_ID")
        or os.environ.get("GATEWAY_RELAY_INSTANCE_ID")
        or ""
    ).strip()
    if not value:
        try:
            gateway = server._load_cfg().get("gateway") or {}
            value = str(
                gateway.get("relay_id")
                or gateway.get("relay_instance_id")
                or ""
            ).strip()
        except Exception:
            value = ""
    if value:
        return value

    # Unenrolled gateways still need distinct source identities. Hash a stable,
    # non-secret machine identifier with the installation path; never expose the
    # machine identifier itself. A random uuid.getnode() fallback is not stable
    # across processes and must fail closed.
    machine = _machine_identity()
    try:
        from hermes_constants import get_hermes_home

        installation = os.path.normcase(
            os.path.realpath(str(installation_home or get_hermes_home()))
        )
    except Exception as exc:
        raise CompanionProjectsError("backend identity unavailable", 5061) from exc
    if not machine or not installation:
        raise CompanionProjectsError("backend identity unavailable", 5061)
    digest = hashlib.sha256(f"{machine}\0{installation}".encode()).hexdigest()
    return f"derived:{digest}"


def _validated_profile_dir(path: Path, *, anchor: Path) -> Path:
    """Validate a profile path without following any profile-tree symlink."""
    candidate = Path(os.path.abspath(os.fspath(path)))
    root = Path(os.path.abspath(os.fspath(anchor)))
    try:
        relative = candidate.relative_to(root)
    except ValueError as exc:
        raise CompanionProjectsError("profile path escapes profile root", 4404) from exc

    # The host may expose trusted ancestors through a platform alias (macOS
    # commonly maps /var to /private/var).  Reject links at the profile anchor
    # and below without treating those out-of-scope ancestors as profile-tree
    # links.
    current = root
    paths = [root]
    for component in relative.parts:
        current /= component
        paths.append(current)
    try:
        if any(component.is_symlink() for component in paths):
            raise CompanionProjectsError("symlinked profile paths are unavailable", 4404)
        if not candidate.is_dir():
            raise CompanionProjectsError("profile unavailable", 4404)
        resolved_root = root.resolve(strict=True)
        resolved_candidate = candidate.resolve(strict=True)
        resolved_candidate.relative_to(resolved_root)
    except CompanionProjectsError:
        raise
    except (OSError, RuntimeError, ValueError) as exc:
        raise CompanionProjectsError("profile path escapes profile root", 4404) from exc
    return candidate


def _owner_authorized_profiles(server) -> frozenset[str]:
    """Use the persisted-session served-profile boundary for project reads."""
    from tui_gateway.companion_sessions import (
        CompanionSessionsError,
        _owner_authorized_profiles as authorized_profiles,
    )

    try:
        return authorized_profiles(server)
    except CompanionSessionsError as exc:
        raise CompanionProjectsError("project profile unavailable", 4403) from exc


def _resolve_profile(server, raw: Any) -> tuple[str, Path]:
    from hermes_cli.profiles import (
        _get_profiles_root,
        get_active_profile_name,
        get_profile_dir,
        validate_profile_name,
    )
    from hermes_constants import get_hermes_home

    current = get_active_profile_name() or "default"
    selected = current if raw is None else raw
    if raw is None:
        if selected not in _owner_authorized_profiles(server):
            raise CompanionProjectsError("project profile unavailable", 4403)
        current_home = Path(get_hermes_home())
        return current, _validated_profile_dir(current_home, anchor=current_home)
    if not isinstance(raw, str) or not raw:
        raise CompanionProjectsError("invalid profile", -32602)
    try:
        # Source identities are exact.  Unlike user-facing profile selectors,
        # this RPC does not lowercase or otherwise repair an incoming key.
        validate_profile_name(raw)
    except ValueError as exc:
        raise CompanionProjectsError(str(exc), -32602) from exc

    # An installed profile is not necessarily served by this gateway. Enforce
    # the same owner-visible multiplex allowlist as persisted sessions before
    # resolving or probing any profile-owned path.
    if raw not in _owner_authorized_profiles(server):
        raise CompanionProjectsError("project profile unavailable", 4403)

    current_home = Path(os.path.abspath(os.fspath(get_hermes_home())))
    candidate = Path(os.path.abspath(os.fspath(get_profile_dir(raw))))
    if raw == "default":
        anchor = candidate
    else:
        root = Path(os.path.abspath(os.fspath(_get_profiles_root())))
        if candidate != root / raw:
            raise CompanionProjectsError("profile alias unavailable", 4404)
        anchor = root
    candidate = _validated_profile_dir(candidate, anchor=anchor)
    if raw == current and candidate != current_home:
        raise CompanionProjectsError("profile alias unavailable", 4404)
    return raw, candidate


def _canonical_creation_directory(raw: Any) -> str:
    """Return one existing absolute directory with no caller-visible path repair."""
    if not isinstance(raw, str) or not raw or raw != raw.strip():
        raise CompanionProjectsError("project workspace unavailable", 4404)
    candidate = Path(raw)
    try:
        if not candidate.is_absolute() or candidate.resolve(strict=True) != candidate:
            raise CompanionProjectsError("project workspace unavailable", 4404)
        if not candidate.is_dir() or not os.access(candidate, os.R_OK | os.X_OK):
            raise CompanionProjectsError("project workspace unavailable", 4404)
    except CompanionProjectsError:
        raise
    except (OSError, RuntimeError, ValueError) as exc:
        raise CompanionProjectsError("project workspace unavailable", 4404) from exc
    return str(candidate)


class _CreationDirectoryGuard:
    """Pin and revalidate every directory identity in a creation path."""

    def __init__(self, path: str):
        self.path = Path(path)
        self.fd: int | None = None
        self.chain: tuple[tuple[str, int, int], ...] = ()

    def open(self) -> None:
        current = Path(self.path.anchor)
        paths = [current]
        for component in self.path.parts[1:]:
            current /= component
            paths.append(current)
        try:
            identities = []
            for candidate in paths:
                value = os.lstat(candidate)
                if stat.S_ISLNK(value.st_mode) or not stat.S_ISDIR(value.st_mode):
                    raise CompanionProjectsError("project workspace unavailable", 4404)
                identities.append((str(candidate), value.st_dev, value.st_ino))
            flags = (
                os.O_RDONLY
                | getattr(os, "O_CLOEXEC", 0)
                | getattr(os, "O_NOFOLLOW", 0)
                | getattr(os, "O_DIRECTORY", 0)
            )
            self.fd = os.open(self.path, flags)
            held = os.fstat(self.fd)
            if (held.st_dev, held.st_ino) != identities[-1][1:]:
                raise CompanionProjectsError("project workspace unavailable", 4404)
            self.chain = tuple(identities)
            self.validate()
        except CompanionProjectsError:
            self.close()
            raise
        except OSError as exc:
            self.close()
            raise CompanionProjectsError("project workspace unavailable", 4404) from exc

    def validate(self) -> None:
        try:
            if self.fd is None or not self.chain:
                raise CompanionProjectsError("project workspace changed", 4404)
            held = os.fstat(self.fd)
            if (held.st_dev, held.st_ino) != self.chain[-1][1:]:
                raise CompanionProjectsError("project workspace changed", 4404)
            for raw_path, device, inode in self.chain:
                current = os.lstat(raw_path)
                if (
                    stat.S_ISLNK(current.st_mode)
                    or not stat.S_ISDIR(current.st_mode)
                    or (current.st_dev, current.st_ino) != (device, inode)
                ):
                    raise CompanionProjectsError("project workspace changed", 4404)
            if not os.access(self.path, os.R_OK | os.X_OK):
                raise CompanionProjectsError("project workspace unavailable", 4404)
        except CompanionProjectsError:
            raise
        except OSError as exc:
            raise CompanionProjectsError("project workspace changed", 4404) from exc

    def close(self) -> None:
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


class _HeldCreationWorkspace(dict):
    """Creation projection backed by held store and directory identities."""

    def __init__(
        self,
        value: dict[str, Any],
        *,
        directory: _CreationDirectoryGuard,
        project_guard: "_SourceGuard | None",
        project_conn: Any,
        project_fingerprint: str | None,
    ):
        super().__init__(value)
        self._directory = directory
        self._project_guard = project_guard
        self._project_conn = project_conn
        self._project_fingerprint = project_fingerprint
        self.invalid = False

    @property
    def identity(self) -> tuple[Any, ...]:
        project_identity = None
        if self._project_guard is not None and self._project_guard.opened is not None:
            opened = self._project_guard.opened
            project_identity = (opened.st_dev, opened.st_ino)
        return (project_identity, self._project_fingerprint, self._directory.chain)

    def validate(self) -> None:
        from hermes_cli import projects_db as pdb

        try:
            self._directory.validate()
            if self._project_guard is None:
                return
            self._project_guard.validate()
            row = self._project_conn.execute(
                "SELECT * FROM projects WHERE id = ?", (self["project_id"],)
            ).fetchone()
            if row is None or row["id"] != self["project_id"] or bool(row["archived"]):
                raise CompanionProjectsError("project workspace changed", 4404)
            fingerprint = json.dumps(
                pdb._load_project(self._project_conn, row).to_dict(),
                sort_keys=True,
                separators=(",", ":"),
            )
            if fingerprint != self._project_fingerprint:
                raise CompanionProjectsError("project workspace changed", 4404)
        except CompanionProjectsError:
            self.invalid = True
            raise


@contextlib.contextmanager
def hold_creation_workspace(server, profile: str, project_id: str | None):
    """Hold the exact project store and directory identities through admission."""
    from hermes_cli import projects_db as pdb
    from hermes_cli.config import load_config_path_readonly
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    selected, home = _resolve_profile(server, profile)
    if selected != profile:
        raise CompanionProjectsError("project profile unavailable", 4403)
    try:
        config = load_config_path_readonly(home / "config.yaml", fail_closed=True)
    except Exception as exc:
        raise CompanionProjectsError("profile configuration unavailable", 5072) from exc
    if not isinstance(config, dict):
        raise CompanionProjectsError("profile configuration unavailable", 5072)

    project_guard = None
    project_context = None
    project_context_entered = False
    project_conn = None
    project_fingerprint = None
    directory = None
    workspace = None
    failure: BaseException | None = None
    try:
        workspace_none = project_id is None
        if workspace_none:
            raw_cwd = (
                server._profile_configured_cwd(home)
                or server._launch_configured_cwd()
                or os.environ.get("TERMINAL_CWD")
                or os.getcwd()
            )
            cwd = _canonical_creation_directory(raw_cwd)
            persisted_cwd = None
            git_root = None
        else:
            project_guard = _SourceGuard(home, "projects.db")
            project_guard.open()
            if project_guard.opened is None:
                raise CompanionProjectsError("project not found", 4404)
            project_context = pdb.connect_readonly(project_guard.path)
            project_conn = project_context.__enter__()
            project_context_entered = True
            project_guard.validate()
            if project_conn is None:
                raise CompanionProjectsError("project not found", 4404)
            row = project_conn.execute(
                "SELECT * FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
            if row is None or row["id"] != project_id or bool(row["archived"]):
                raise CompanionProjectsError("project not found", 4404)
            project = pdb._load_project(project_conn, row)
            primaries = [folder.path for folder in project.folders if folder.is_primary]
            if (
                not project.primary_path
                or len(primaries) != 1
                or primaries[0] != project.primary_path
            ):
                raise CompanionProjectsError("project workspace unavailable", 4404)
            cwd = _canonical_creation_directory(project.primary_path)
            persisted_cwd = cwd
            git_root = cwd
            project_fingerprint = json.dumps(
                project.to_dict(), sort_keys=True, separators=(",", ":")
            )

        directory = _CreationDirectoryGuard(cwd)
        directory.open()
        token = set_hermes_home_override(home)
        try:
            row_model, model_config = server._workdir_row_model_config(
                {
                    "model_override": None,
                    "create_reasoning_override": None,
                    "create_service_tier_override": None,
                    "parent_session_id": None,
                    "room_plumbing": False,
                    "follow_profile_config": False,
                    "workspace_none": workspace_none,
                }
            )
        finally:
            reset_hermes_home_override(token)
        workspace = _HeldCreationWorkspace(
            {
                "profile": profile,
                "profile_home": str(home),
                "project_id": project_id,
                "cwd": cwd,
                "persisted_cwd": persisted_cwd,
                "git_repo_root": git_root,
                "workspace_none": workspace_none,
                "config": config,
                "model": row_model,
                "model_config": model_config,
            },
            directory=directory,
            project_guard=project_guard,
            project_conn=project_conn,
            project_fingerprint=project_fingerprint,
        )
        workspace.validate()
        yield workspace
    except BaseException as exc:
        failure = exc
        raise
    finally:
        if directory is not None:
            directory.close()
        try:
            if project_context is not None and project_context_entered:
                exit_failure = failure
                if exit_failure is None and workspace is not None and workspace.invalid:
                    exit_failure = CompanionProjectsError(
                        "project database source changed", 4404
                    )
                try:
                    project_context.__exit__(
                        type(exit_failure) if exit_failure is not None else None,
                        exit_failure,
                        exit_failure.__traceback__ if exit_failure is not None else None,
                    )
                except ValueError as exc:
                    if exit_failure is None:
                        raise CompanionProjectsError(
                            "project database source changed", 4404
                        ) from exc
        finally:
            if project_guard is not None:
                project_guard.close()


def resolve_creation_workspace(server, profile: str, project_id: str | None) -> dict[str, Any]:
    """Resolve a strict owner-visible creation target without project-store writes."""
    with hold_creation_workspace(server, profile, project_id) as workspace:
        return {**workspace, "_identity": workspace.identity}


_CURSOR_KEY = secrets.token_bytes(32)
_SNAPSHOTS: OrderedDict[str, dict[str, Any]] = OrderedDict()
_SNAPSHOT_LOCK = threading.Lock()
_SNAPSHOT_TTL = 15 * 60
_SNAPSHOT_MAX = 64
_SNAPSHOT_MEMORY_LIMIT = 16 * 1024 * 1024
_SESSION_FETCH_BATCH = 5000


def _cleanup_snapshots() -> None:
    with _SNAPSHOT_LOCK:
        for entry in _SNAPSHOTS.values():
            if entry.get("_disk_path"):
                with contextlib.suppress(OSError):
                    os.unlink(entry["_disk_path"])
        _SNAPSHOTS.clear()


atexit.register(_cleanup_snapshots)


def _encode_cursor_payload(value: dict[str, Any]) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    signature = hmac.new(_CURSOR_KEY, payload, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(payload + signature).decode().rstrip("=")


def _decode_cursor(raw: Any) -> dict[str, Any]:
    if raw in (None, ""):
        return {"version": 1, "offset": 0, "session_limit": 500}
    if not isinstance(raw, str):
        raise CompanionProjectsError("invalid cursor", -32602)
    try:
        padded = raw + "=" * (-len(raw) % 4)
        signed = base64.b64decode(padded.encode(), altchars=b"-_", validate=True)
        if (
            len(signed) <= 32
            or base64.urlsafe_b64encode(signed).decode().rstrip("=") != raw
        ):
            raise ValueError
        payload, signature = signed[:-32], signed[-32:]
        if not hmac.compare_digest(signature, hmac.new(_CURSOR_KEY, payload, hashlib.sha256).digest()):
            raise ValueError
        value = json.loads(payload.decode())
        if not isinstance(value, dict):
            raise ValueError
        if value.get("v") == 2:
            if set(value) != {"v", "token", "index"}:
                raise ValueError
            if not isinstance(value["token"], str) or not value["token"]:
                raise ValueError
            if type(value["index"]) is not int or value["index"] < 0:
                raise ValueError
            return {"version": 2, "token": value["token"], "index": value["index"]}
        if set(value) != {"v", "offset", "session_limit"} or value.get("v") != 1:
            raise ValueError
        offset = value["offset"]
        session_limit = value["session_limit"]
        if (
            type(offset) is not int
            or type(session_limit) is not int
            or offset < 0
            or not 1 <= session_limit <= 500
        ):
            raise ValueError
        return {"version": 1, "offset": offset, "session_limit": session_limit}
    except (UnicodeError, binascii.Error, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise CompanionProjectsError("invalid cursor", -32602) from exc


def _cursor(offset: int, session_limit: int) -> str:
    """Create a signed legacy/first-read cursor (kept for internal compatibility)."""
    if type(offset) is not int or type(session_limit) is not int:
        raise ValueError("cursor values must be integers")
    return _encode_cursor_payload(
        {"v": 1, "offset": offset, "session_limit": session_limit}
    )


def _snapshot_cursor(token: str, index: int) -> str:
    return _encode_cursor_payload({"v": 2, "token": token, "index": index})


def _snapshot_scope(operation: str, profile: str, backend: str, params: dict) -> str:
    bound: dict[str, Any] = {
        "operation": operation,
        "profile": profile,
        "backend": backend,
    }
    if operation == "list":
        bound.update(
            archived=params.get("archived"),
            include_discovered=params.get("include_discovered", True),
            limit=params.get("limit", 200),
        )
    else:
        bound.update(id=params.get("id"), kind=params.get("kind"))
    return hashlib.sha256(
        json.dumps(bound, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _store_snapshot(snapshot: dict[str, Any]) -> str:
    token = secrets.token_urlsafe(24)
    now = time.monotonic()
    serialized = json.dumps(snapshot, sort_keys=True, separators=(",", ":")).encode()
    entry = snapshot
    if len(serialized) > _SNAPSHOT_MEMORY_LIMIT:
        fd, path = tempfile.mkstemp(prefix="hermes-project-snapshot-", suffix=".json")
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
        entry = {
            "operation": snapshot["operation"],
            "scope": snapshot["scope"],
            "_disk_path": path,
        }
    with _SNAPSHOT_LOCK:
        expired = [key for key, value in _SNAPSHOTS.items() if now - value["stored"] > _SNAPSHOT_TTL]
        for key in expired:
            expired_entry = _SNAPSHOTS.pop(key, None)
            if expired_entry and expired_entry.get("_disk_path"):
                with contextlib.suppress(OSError):
                    os.unlink(expired_entry["_disk_path"])
        entry["stored"] = now
        _SNAPSHOTS[token] = entry
        while len(_SNAPSHOTS) > _SNAPSHOT_MAX:
            _old_token, old_entry = _SNAPSHOTS.popitem(last=False)
            if old_entry.get("_disk_path"):
                with contextlib.suppress(OSError):
                    os.unlink(old_entry["_disk_path"])
    return token


def _load_snapshot(cursor: dict[str, Any], scope: str, operation: str) -> dict[str, Any]:
    with _SNAPSHOT_LOCK:
        entry = _SNAPSHOTS.get(cursor["token"])
        if entry is None or time.monotonic() - entry["stored"] > _SNAPSHOT_TTL:
            expired = _SNAPSHOTS.pop(cursor["token"], None)
            if expired and expired.get("_disk_path"):
                with contextlib.suppress(OSError):
                    os.unlink(expired["_disk_path"])
            raise CompanionProjectsError("cursor expired or unavailable", -32602)
        if entry["scope"] != scope or entry["operation"] != operation:
            raise CompanionProjectsError("cursor does not match this request", -32602)
        _SNAPSHOTS.move_to_end(cursor["token"])
        if entry.get("_disk_path"):
            try:
                with open(entry["_disk_path"], "rb") as stream:
                    return json.load(stream)
            except (OSError, ValueError, TypeError) as exc:
                raise CompanionProjectsError(
                    "cursor expired or unavailable", -32602
                ) from exc
        return entry


class _SourceGuard:
    def __init__(self, home: Path, name: str):
        self.home = home
        self.path = home / name
        self.home_opened: os.stat_result | None = None
        self.fd: int | None = None
        self.opened: os.stat_result | None = None

    def open(self) -> None:
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            self.home_opened = os.lstat(self.home)
            if stat.S_ISLNK(self.home_opened.st_mode) or not stat.S_ISDIR(
                self.home_opened.st_mode
            ):
                raise CompanionProjectsError("profile database source is unsafe", 4404)
            self.fd = os.open(self.path, flags)
        except FileNotFoundError:
            return
        except OSError as exc:
            raise CompanionProjectsError("profile database source is unsafe", 4404) from exc
        self.opened = os.fstat(self.fd)
        self.validate()

    def validate(self) -> None:
        # Revalidate the profile and exact directory entry before and after all
        # list/detail/membership reads. A replacement race therefore yields no
        # response assembled from an out-of-scope source.
        try:
            current_home = os.lstat(self.home)
            current = os.lstat(self.path)
        except FileNotFoundError:
            if self.opened is None:
                return
            raise CompanionProjectsError("profile database source changed", 4404)
        if self.opened is None or self.home_opened is None:
            raise CompanionProjectsError("profile database source changed", 4404)
        if (
            stat.S_ISLNK(current_home.st_mode)
            or not stat.S_ISDIR(current_home.st_mode)
            or (current_home.st_dev, current_home.st_ino)
            != (self.home_opened.st_dev, self.home_opened.st_ino)
            or stat.S_ISLNK(current.st_mode)
            or not stat.S_ISREG(self.opened.st_mode)
            or (current.st_dev, current.st_ino) != (self.opened.st_dev, self.opened.st_ino)
        ):
            raise CompanionProjectsError("profile database source is unsafe", 4404)

    def close(self) -> None:
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


def _project_sessions(project: dict | None) -> list[dict]:
    if not project:
        return []
    return [
        session
        for repo in project.get("repos") or []
        for group in repo.get("groups") or []
        for session in group.get("sessions") or []
    ]


def _project_session_ids(project: dict | None) -> list[str] | None:
    """Project Desktop membership onto persisted lineage-root identities."""
    if project is None:
        return None
    return list(
        dict.fromkeys(
            str(session.get("_lineage_root_id") or session["id"])
            for session in _project_sessions(project)
        )
    )


def _build_tree(
    server, db, conn, *, session_limit: int
) -> tuple[dict, bool, bool, str, str | None]:
    """Run the same project-tree resolver as Desktop, without write-side refreshes."""
    from tui_gateway import project_tree
    from hermes_cli import projects_db as pdb

    rows = []
    if db is not None:
        offset = 0
        while True:
            batch = db.list_sessions_rich(
                limit=_SESSION_FETCH_BATCH,
                offset=offset,
                order_by_last_active=True,
                min_message_count=0,
                include_children=False,
                exclude_sources=server._PROJECT_TREE_EXCLUDED_SOURCES,
                include_archived=True,
                compact_rows=True,
            )
            rows.extend(batch)
            if len(batch) < _SESSION_FETCH_BATCH:
                break
            offset += len(batch)
    bounded = False
    sessions = [server._project_tree_row(row) for row in rows]
    server.git_probe.warm_roots(s["cwd"] for s in sessions if s.get("cwd"))

    projects = (
        [p.to_dict() for p in pdb.list_projects(conn)] if conn is not None else []
    )
    policy = server._repo_discovery_policy()
    cache_coverage = "complete"
    cache_warning = None
    include_cached = False
    if conn is not None and policy["enabled"]:
        policy_key = server._repo_discovery_policy_key(policy)
        stored_key = pdb.get_discovery_policy_key(conn)
        include_cached = stored_key == policy_key or (
            stored_key is None and server._repo_discovery_policy_is_default(policy)
        )
        if not include_cached:
            cache_coverage = "stale_suppressed"
            cache_warning = (
                "Discovered repository cache does not match the current Desktop "
                "discovery policy; stale cached repositories were suppressed."
            )
    if db is not None:
        discovered = server._discover_repos_payload(
            db,
            conn=conn,
            backfill=False,
            include_cached=include_cached,
        )
    elif conn is not None and include_cached:
        discovered = [
            {
                "root": entry["root"],
                "label": entry.get("label") or "",
                "sessions": 0,
                "last_active": 0.0,
            }
            for entry in pdb.list_discovered_repos(conn)
        ]
    else:
        discovered = []
    server.git_probe.warm_roots(
        [str(folder.get("path") or "") for p in projects for folder in (p.get("folders") or [])]
        + [str(repo.get("root") or "") for repo in discovered]
    )
    server._DIR_EXISTS_CACHE.clear()
    tree = project_tree.build_tree(
        projects,
        sessions,
        discovered,
        server.git_probe.resolve,
        preview_limit=0,
        hydrate=True,
        is_junk_root=server._is_repo_junk,
        is_junk_cwd=server._is_session_cwd_junk,
        exists=server._dir_exists_cached,
    )
    # A missing state.db is the authoritative empty session population.  An
    # existing but unreadable database raises while opening and never reaches
    # this point, so it cannot be mistaken for a complete zero.
    return tree, bounded, True, cache_coverage, cache_warning


@contextlib.contextmanager
def _source(server, params: dict):
    from hermes_cli import projects_db as pdb
    from hermes_state import SessionDB
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    profile, home = _resolve_profile(server, params.get("profile"))
    token = set_hermes_home_override(home)
    db = None
    state_guard = _SourceGuard(home, "state.db")
    projects_guard = _SourceGuard(home, "projects.db")
    try:
        state_guard.open()
        projects_guard.open()
        if state_guard.opened is not None:
            db = SessionDB(db_path=state_guard.path, read_only=True)
            state_guard.validate()
        try:
            readonly = pdb.connect_readonly(projects_guard.path)
            with readonly as conn:
                projects_guard.validate()
                yield profile, home, db, conn
                state_guard.validate()
                projects_guard.validate()
        except ValueError as exc:
            raise CompanionProjectsError("profile database source is unsafe", 4404) from exc
    finally:
        if db is not None:
            db.close()
        state_guard.close()
        projects_guard.close()
        reset_hermes_home_override(token)


def _namespaces(profile: str, backend: str) -> dict:
    return {
        "profile": profile,
        "backend_namespace": backend,
        "source_namespace": {"backend": backend, "profile": profile},
    }


def _named_item(project: dict, node: dict | None, profile: str, backend: str) -> dict:
    return {
        **project,
        "kind": "desktop_project",
        **_namespaces(profile, backend),
        "session_count": node.get("sessionCount", 0) if node else None,
        "session_ids": _project_session_ids(node),
        "last_active": float(node.get("lastActive") or 0) if node else None,
    }


def _discovered_item(node: dict, profile: str, backend: str) -> dict:
    path = node.get("path") or node.get("id")
    return {
        "id": node["id"],
        "name": node.get("label") or node["id"],
        "kind": "discovered_repository",
        "archived": False,
        "folders": ([{"path": path, "label": None, "is_primary": True}] if path else []),
        **_namespaces(profile, backend),
        "session_count": int(node.get("sessionCount") or 0),
        "session_ids": _project_session_ids(node),
        "last_active": float(node.get("lastActive") or 0),
    }


def _validate_params(operation: str, params: Any) -> dict:
    if not isinstance(params, dict):
        raise CompanionProjectsError("parameters must be an object", -32602)
    allowed = {
        "list": {"profile", "archived", "include_discovered", "limit", "cursor"},
        "get": {"profile", "id", "kind", "cursor"},
    }[operation]
    if set(params) - allowed:
        raise CompanionProjectsError("unexpected project browsing parameters", -32602)
    if "archived" in params and type(params["archived"]) is not bool:
        raise CompanionProjectsError("archived must be a boolean", -32602)
    if "include_discovered" in params and type(params["include_discovered"]) is not bool:
        raise CompanionProjectsError("include_discovered must be a boolean", -32602)
    return params


def execute(
    server,
    operation: str,
    params: Any,
    *,
    owner_authorization: Any = None,
) -> dict:
    from hermes_cli import projects_db as pdb
    from hermes_constants import get_hermes_home

    params = _validate_params(operation, params)
    _require_owner(owner_authorization)
    cursor = _decode_cursor(params.get("cursor"))
    installation_home = Path(get_hermes_home())
    timestamp = _as_of()

    with _source(server, params) as (profile, _home, db, conn):
        backend = _backend_namespace(server, installation_home=installation_home)
        scope = _snapshot_scope(operation, profile, backend, params)
        if cursor["version"] == 2:
            snapshot = _load_snapshot(cursor, scope, operation)
            index = cursor["index"]
            if operation == "list":
                limit = snapshot["page_size"]
                items = snapshot["items"]
                if index > len(items):
                    raise CompanionProjectsError("invalid cursor", -32602)
                page = items[index : index + limit]
                next_index = index + len(page)
                next_cursor = (
                    _snapshot_cursor(cursor["token"], next_index)
                    if next_index < len(items)
                    else None
                )
                return {
                    **snapshot["base"],
                    "items": page,
                    "next_cursor": next_cursor,
                    "has_more": next_cursor is not None,
                }

            page_size = snapshot["page_size"]
            items = snapshot["items"]
            if index > len(items):
                raise CompanionProjectsError("invalid cursor", -32602)
            page = items[index : index + page_size]
            next_index = index + len(page)
            next_cursor = (
                _snapshot_cursor(cursor["token"], next_index)
                if next_index < len(items)
                else None
            )
            coverage = (
                "bounded" if next_cursor is not None else snapshot["final_coverage"]
            )
            warnings = list(snapshot["warnings"])
            if coverage == "truncated" and not any(
                "terminal truncation" in value for value in warnings
            ):
                warnings.append(
                    "Project membership source reported terminal truncation."
                )
            membership = {
                "project": snapshot["project"],
                "items": page,
                "next_cursor": next_cursor,
                "has_more": next_cursor is not None,
                "coverage": coverage,
                "warnings": warnings,
            }
            if coverage == "complete":
                membership["total"] = snapshot["total"]
            return {
                **snapshot["base"],
                "membership": membership,
                "next_cursor": next_cursor,
                "has_more": next_cursor is not None,
                "coverage": {
                    **snapshot["base"]["coverage"],
                    "membership": coverage,
                },
                "warnings": warnings,
            }

        tree, bounded, state_available, discovery_coverage, discovery_warning = _build_tree(
            server, db, conn, session_limit=cursor["session_limit"]
        )
        nodes = {str(node.get("id")): node for node in tree["projects"]}
        named = (
            [p.to_dict() for p in pdb.list_projects(conn, include_archived=True)]
            if conn is not None
            else []
        )

        if operation == "list":
            archived_filter = params.get("archived")
            if archived_filter is not None:
                named = [p for p in named if bool(p.get("archived")) is archived_filter]
            items = [
                _named_item(project, nodes.get(project["id"]), profile, backend)
                for project in named
            ]
            if params.get("include_discovered", True) and archived_filter is not True:
                named_ids = {project["id"] for project in named}
                items.extend(
                    _discovered_item(node, profile, backend)
                    for node in tree["projects"]
                    if node.get("isAuto")
                    and not node.get("isNoProject")
                    and node.get("id") not in named_ids
                )

            limit = params.get("limit", 200)
            if type(limit) is not int or not 1 <= limit <= 500:
                raise CompanionProjectsError("limit must be an integer from 1 to 500", -32602)
            offset = cursor["offset"]
            page = items[offset : offset + limit]
            page_more = offset + len(page) < len(items)
            warnings = []
            if discovery_warning:
                warnings.append(discovery_warning)
            if not state_available:
                warnings.append("Profile session state is unavailable; project membership is incomplete.")
            if bounded:
                warnings.append(
                    "Project membership source reported terminal truncation."
                )
            result_base = {
                "as_of": timestamp,
                "coverage": {
                    "named_projects": "complete",
                    "membership": (
                        "unavailable"
                        if not state_available
                        else ("truncated" if bounded else "complete")
                    ),
                    "session_limit": cursor["session_limit"],
                    "discovered_repositories": discovery_coverage,
                },
                "warnings": warnings,
                "profile": profile,
                "backend_namespace": backend,
            }
            if state_available and not bounded:
                result_base["total"] = len(items)
            next_cursor = None
            if page_more:
                token = _store_snapshot(
                    {
                        "operation": "list",
                        "scope": scope,
                        "items": items,
                        "page_size": limit,
                        "base": result_base,
                    }
                )
                next_cursor = _snapshot_cursor(token, offset + len(page))
            return {
                **result_base,
                "items": page,
                "next_cursor": next_cursor,
                "has_more": next_cursor is not None,
            }

        project_id = params.get("id")
        if not isinstance(project_id, str) or not project_id:
            raise CompanionProjectsError("id required", -32602)
        kind = params.get("kind")
        if kind not in (None, "desktop_project", "discovered_repository"):
            raise CompanionProjectsError("invalid project kind", -32602)

        named_project = next(
            (p for p in named if p["id"] == project_id or p.get("slug") == project_id),
            None,
        )
        node = nodes.get(named_project["id"] if named_project else project_id)
        if kind == "discovered_repository":
            named_project = None
        if named_project is not None and kind != "discovered_repository":
            item = _named_item(named_project, node, profile, backend)
            if node is None:
                # Archived projects are intentionally absent from Desktop's live
                # grouping.  Preserve the record but do not manufacture a zero.
                membership_coverage = "unavailable_archived"
            elif not state_available:
                membership_coverage = "unavailable"
            else:
                membership_coverage = "bounded" if bounded else "complete"
        elif (
            kind != "desktop_project"
            and node
            and node.get("isAuto")
            and not node.get("isNoProject")
        ):
            item = _discovered_item(node, profile, backend)
            membership_coverage = "bounded" if bounded else "complete"
        else:
            raise CompanionProjectsError("project not found", 4404)

        all_member_items = _project_sessions(node)
        page_size = min(cursor["session_limit"], 500)
        member_items = all_member_items[:page_size]
        warning = []
        if discovery_warning:
            warning.append(discovery_warning)
        if not state_available:
            warning.append("Profile session state is unavailable; project membership is incomplete.")
        if bounded:
            warning.append(
                f"Project membership is bounded to the {cursor['session_limit']} most recent eligible sessions."
            )
        if membership_coverage == "unavailable_archived":
            warning.append("Archived projects are not included in Desktop's live membership projection.")
        if bounded:
            membership_coverage = "truncated"
            warning.append(
                "Project membership source reported terminal truncation."
            )
        next_cursor = None
        if len(all_member_items) > len(member_items):
            # Retain the complete resolved membership server-side. Cursors stay
            # small and later inserts/deletes cannot repeat or skip rows.
            membership_coverage = "bounded"
            warning.append(
                f"Project membership continues after this {page_size}-item page."
            )
            token = _store_snapshot(
                {
                    "operation": "get",
                    "scope": scope,
                    "items": all_member_items,
                    "page_size": page_size,
                    "project": node,
                    "total": len(all_member_items),
                    "final_coverage": "truncated" if bounded else "complete",
                    "warnings": warning,
                    "base": {
                        "item": item,
                        "as_of": timestamp,
                        "coverage": {
                            "project": "complete",
                            "membership": "bounded",
                            "session_limit": page_size,
                            "discovered_repositories": discovery_coverage,
                        },
                        "warnings": warning,
                        "profile": profile,
                        "backend_namespace": backend,
                    },
                }
            )
            next_cursor = _snapshot_cursor(token, len(member_items))
        return {
            "item": item,
            "membership": {
                "project": node,
                "items": member_items,
                "next_cursor": next_cursor,
                "has_more": next_cursor is not None,
                "coverage": membership_coverage,
                "warnings": warning,
                **(
                    {"total": len(all_member_items)}
                    if membership_coverage == "complete"
                    else {}
                ),
            },
            "next_cursor": next_cursor,
            "has_more": next_cursor is not None,
            "as_of": timestamp,
            "coverage": {
                "project": "complete",
                "membership": membership_coverage,
                "session_limit": cursor["session_limit"],
                "discovered_repositories": discovery_coverage,
            },
            "warnings": warning,
            "profile": profile,
            "backend_namespace": backend,
        }
