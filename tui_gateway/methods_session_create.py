"""Session creation, persistence, branching, save, and close handlers.

Bodies are rebound onto server.py's globals at install time (method_ctx.py), preserving
server-owned state and monkeypatch seams without importing server at module scope.
"""

import contextlib
import contextvars
from dataclasses import dataclass, field

from .method_ctx import HandlerRegistry, bind_module

_registry = HandlerRegistry()
method = _registry.method


_RESERVED_CREATE_FAILURE = "Durable creation failed."
_eager_resume_builds: dict[tuple[str | None, str], int] = {}


@contextlib.contextmanager
def _eager_resume_build_fence(profile_home, stored_session_id: str):
    key = (str(profile_home) if profile_home is not None else None, stored_session_id)
    with _session_resume_lock:
        _eager_resume_builds[key] = _eager_resume_builds.get(key, 0) + 1
    try:
        yield
    finally:
        with _session_resume_lock:
            remaining = _eager_resume_builds.get(key, 0) - 1
            if remaining > 0:
                _eager_resume_builds[key] = remaining
            else:
                _eager_resume_builds.pop(key, None)


def _eager_resume_build_active(profile_home, stored_session_id: str) -> bool:
    key = (str(profile_home) if profile_home is not None else None, stored_session_id)
    return _eager_resume_builds.get(key, 0) > 0
_CREATION_LEASE_KEY = "_creation_active_session_lease"


class _ReservedSessionCreateCapability:
    """Process-local, identity-bearing one-shot authority for one reserved create."""

    __slots__ = ("_lock", "_state")

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state = "fresh"

    def begin(self) -> bool:
        with self._lock:
            if self._state != "fresh":
                return False
            self._state = "active"
            return True

    def is_active(self) -> bool:
        with self._lock:
            return self._state == "active"

    def mark_published(self) -> bool:
        with self._lock:
            if self._state != "active":
                return False
            self._state = "published"
            return True

    def is_published(self) -> bool:
        with self._lock:
            return self._state == "published"

    def finish(self) -> None:
        with self._lock:
            if self._state == "published":
                self._state = "consumed"
            elif self._state == "active":
                self._state = "fresh"


@dataclass(frozen=True, slots=True)
class ReservedSessionCreate:
    """Trusted coordinates for publishing a pre-reserved Companion runtime."""

    runtime_session_id: str
    stored_session_id: str
    target_profile: str
    target_profile_home: str
    canonical_project_cwd: str
    operation_id: str
    creator_pid: int
    creator_started_at: int
    creator_token: str
    creator_epoch: int
    lease: object = field(repr=False, compare=False)
    workspace_none: bool = False
    _capability: _ReservedSessionCreateCapability = field(
        default_factory=_ReservedSessionCreateCapability,
        init=False,
        repr=False,
        compare=False,
    )


_reserved_session_create_context: contextvars.ContextVar[ReservedSessionCreate | None] = (
    contextvars.ContextVar("hermes_reserved_session_create", default=None)
)
_provisional_creation_submit_context: contextvars.ContextVar[ReservedSessionCreate | None] = (
    contextvars.ContextVar("hermes_provisional_creation_submit", default=None)
)
_CREATION_AUTHORITY_KEY = "_provisional_creation_authority"


@dataclass(frozen=True, slots=True)
class _ProvisionalCreationAuthority:
    """Process-private fence identity; it is never accepted from JSON."""

    operation_id: str
    creator_pid: int
    creator_started_at: int
    creator_token: str
    creator_epoch: int
    lease: object = field(repr=False, compare=False)


def _authority_from_reserved(reserved: ReservedSessionCreate) -> _ProvisionalCreationAuthority:
    return _ProvisionalCreationAuthority(
        operation_id=reserved.operation_id,
        creator_pid=reserved.creator_pid,
        creator_started_at=reserved.creator_started_at,
        creator_token=reserved.creator_token,
        creator_epoch=reserved.creator_epoch,
        lease=reserved.lease,
    )


def _authority_matches_claim(authority, claim, *, lease) -> bool:
    return bool(
        type(authority) is _ProvisionalCreationAuthority
        and getattr(claim, "operation_kind", None) == "create"
        and type(getattr(claim, "operation_id", None)) is str
        and claim.operation_id == authority.operation_id
        and type(getattr(claim, "generation", None)) is int
        and claim.generation == authority.creator_epoch == 1
        and type(getattr(claim, "executor_pid", None)) is int
        and claim.executor_pid == authority.creator_pid
        and type(getattr(claim, "executor_started", None)) is int
        and claim.executor_started == authority.creator_started_at
        and type(getattr(claim, "executor_token", None)) is str
        and claim.executor_token == authority.creator_token
        and authority.lease is lease
    )


def _provisional_creation_access_allowed(session: dict) -> bool:
    """Allow only the exact internal bound creation submission through the runtime fence."""
    authority = session.get(_CREATION_AUTHORITY_KEY)
    if authority is None:
        return True
    reserved = _provisional_creation_submit_context.get()
    if type(reserved) is not ReservedSessionCreate:
        return False
    from tui_gateway.companion_turns import current_bound_turn

    lease = session.get("active_session_lease")
    return bool(
        _authority_from_reserved(reserved) == authority
        and reserved.lease is authority.lease
        and session.get(_CREATION_LEASE_KEY) is authority.lease
        and _authority_matches_claim(authority, current_bound_turn(), lease=lease)
    )


def _bind_provisional_creation_submission(reserved: ReservedSessionCreate, session: dict):
    """Bind the one internal prompt boundary after exact marker validation."""
    authority = session.get(_CREATION_AUTHORITY_KEY)
    if (
        type(reserved) is not ReservedSessionCreate
        or type(authority) is not _ProvisionalCreationAuthority
        or _authority_from_reserved(reserved) != authority
        or reserved.lease is not authority.lease
    ):
        raise RuntimeError("provisional creation authority is invalid")
    return _provisional_creation_submit_context.set(reserved)


def _reset_provisional_creation_submission(token) -> None:
    _provisional_creation_submit_context.reset(token)


def _install_reconstructed_creation_fence(session: dict, claim) -> bool:
    """Fence a resumed exact claimed creation; another process has no lease authority."""
    if (
        getattr(claim, "operation_kind", None) != "create"
        or type(getattr(claim, "operation_id", None)) is not str
        or type(getattr(claim, "generation", None)) is not int
        or claim.generation != 1
        or type(getattr(claim, "executor_pid", None)) is not int
        or type(getattr(claim, "executor_started", None)) is not int
        or type(getattr(claim, "executor_token", None)) is not str
    ):
        return False
    session[_CREATION_AUTHORITY_KEY] = _ProvisionalCreationAuthority(
        operation_id=claim.operation_id,
        creator_pid=claim.executor_pid,
        creator_started_at=claim.executor_started,
        creator_token=claim.executor_token,
        creator_epoch=1,
        lease=None,
    )
    session["_durable_turn_claim"] = claim.to_wire()
    return True


def _rollback_published_provisional_runtime(
    runtime_session_id: str, reserved: ReservedSessionCreate
) -> bool:
    """Remove/release only the exact fenced runtime published by ``reserved``."""
    with _lifecycle_reservation_lock, _sessions_lock:
        session = _sessions.get(runtime_session_id)
        authority = session.get(_CREATION_AUTHORITY_KEY) if session else None
        if (
            session is None
            or type(authority) is not _ProvisionalCreationAuthority
            or _authority_from_reserved(reserved) != authority
            or reserved.lease is not authority.lease
            or session.get("active_session_lease") is not authority.lease
            or session.get(_CREATION_LEASE_KEY) is not authority.lease
        ):
            return False
        if not _release_creation_slot(session):
            # Retain the exact authority marker: uncertainty stays fenced.
            return False
        if _sessions.get(runtime_session_id) is not session:
            return False
        _sessions.pop(runtime_session_id, None)
        return True


def _reserved_create_error(rid) -> dict:
    return _err(rid, 5006, _RESERVED_CREATE_FAILURE)


def _invoke_reserved_session_create(reserved: ReservedSessionCreate, *, rid=None) -> dict:
    """Invoke the installed generic handler with process-local reserved authority."""
    if type(reserved) is not ReservedSessionCreate or not reserved._capability.begin():
        return _reserved_create_error(rid)
    token = _reserved_session_create_context.set(reserved)
    try:
        handler = _methods.get("session.create")
        if not callable(handler):
            return _reserved_create_error(rid)
        response = handler(rid, {})
        result = response.get("result") if isinstance(response, dict) else None
        valid_response = (
            isinstance(result, dict)
            and result.get("session_id") == reserved.runtime_session_id
            and result.get("stored_session_id") == reserved.stored_session_id
        )
        if not isinstance(response, dict) or not valid_response or not reserved._capability.is_published():
            return _reserved_create_error(rid)
        return response
    except Exception:
        logger.warning(_RESERVED_CREATE_FAILURE)
        return _reserved_create_error(rid)
    finally:
        _reserved_session_create_context.reset(token)
        reserved._capability.finish()


def _new_runtime_ids(params: dict) -> tuple[str, str]:
    """Fresh runtime sid + resolved DB ``source`` for a session minted from ``params``."""
    return uuid.uuid4().hex[:8], _resolve_session_source(_str_param(params, "source") or None)


@contextlib.contextmanager
def _profile_build_scope(profile_home):
    """Bind HERMES_HOME + secret scope for an agent build (home alone leaves get_secret() on the LAUNCH .env)."""
    if not profile_home:
        yield
        return
    home_token = set_hermes_home_override(str(profile_home))
    secret_token = set_secret_scope(build_profile_secret_scope(Path(str(profile_home))))
    try:
        yield
    finally:
        reset_hermes_home_override(home_token)
        reset_secret_scope(secret_token)


def _make_agent_in_context(sid: str, key: str, **kwargs):
    """``_make_agent`` with the session context bound for the build and cleared after."""
    tokens = _set_session_context(key)
    try:
        return _make_agent(sid, key, session_id=key, **kwargs)
    finally:
        _clear_session_context(tokens)


def _profile_session_db(profile_home):
    """``(db, owns)``: a DEDICATED handle on ``profile_home``'s state.db, else the shared launch db."""
    if profile_home:
        from hermes_state_registry import acquire
        return acquire(Path(profile_home) / "state.db"), True
    return _get_db(), False


def _release_db(db) -> None:
    with contextlib.suppress(Exception):
        from hermes_state_registry import release_or_close
        release_or_close(db)


def _branch_title(db, parent_key: str) -> str:
    """Next title in the parent's lineage (mirrors the TUI /branch naming)."""
    current = db.get_session_title(parent_key) or "branch"
    if hasattr(db, "get_next_title_in_lineage"):
        return db.get_next_title_in_lineage(current)
    return f"{current} (branch)"


def _persist_branch(db, new_key: str, parent_key: str, title: str, history: list, *, source, cwd, profile_name,
                    copy_fields=(), compensate: bool = False) -> None:
    """Branch child row + parent transcript (bounded-chunk transactions) + title. ``_branched_from`` keeps the
    row visible in list_sessions_rich() (the live parent never matches the legacy end_reason='branched'
    heuristic); NULL ``profile_name`` rows drop out of profile-keyed sidebar matching / deep links. ``compensate``
    deletes a committed row whose transcript/title failed (a durable-but-empty row would defeat the INSERT OR
    IGNORE first-prompt seed) — except on disk-full, where the delete cannot land."""
    db.create_session(new_key, source=source, model=_resolve_model(), model_config={"_branched_from": parent_key},
                      parent_session_id=parent_key, cwd=cwd, profile_name=profile_name)
    try:
        # Compensation guard (#93959 review): if the transcript copy or title write fails AFTER the row
        # committed, the durable-but-empty row would defeat the lazy first-prompt fallback
        # (_ensure_session_db_row is INSERT OR IGNORE — the row exists, so the seed never lands and the
        # renderer fail-latches on a "transcript-less" session again). Roll back just this child so the seed
        # path can retry cleanly on first submit.
        # Copy the whole parent history in bounded-chunk transactions — a branch seed can be hundreds of
        # rows, and per-row transactions were the write-amplification pattern removed in #23254.
        db.append_messages_batch(
            new_key, [{"role": msg.get("role", "user"), "content": msg.get("content"),
                       **{field: msg.get(field) for field in copy_fields}} for msg in history], chunk_rows=500)
        db.set_session_title(new_key, title)
    except Exception as exc:
        from hermes_state_errors import is_disk_full_error
        if compensate and not is_disk_full_error(exc):
            try:
                db.delete_session(new_key)
            except Exception:
                logger.debug("branch seed compensation delete failed for %s", new_key, exc_info=True)
        raise


def _seed_branch_row(record: dict, key: str, parent_session_id: str, history: list, source: str, profile_home):
    """Persist a seeded desktop branch child NOW (the one session.create exception to lazy rows): the
    renderer's post-create resume re-fetches it via REST/defer_history, so an unpersisted child 404s and
    the fail-latch spins forever. Best-effort — on failure the lazy first-prompt path is the fallback."""
    try:
        with _session_db(record) as db:
            if db is None:
                return
            _persist_branch(db, key, parent_session_id, _branch_title(db, parent_session_id), history,
                            source=source, cwd=record["cwd"],
                            profile_name=(Path(profile_home).name if profile_home else None), compensate=True)
            record["pending_title"] = None
    except Exception:
        logger.warning("seeded-branch persistence failed for %s; falling back to lazy row creation", key,
                       exc_info=True)


def _create_overrides(params: dict) -> tuple:
    """PER-SESSION (model, reasoning, service_tier) overrides from the composer — never a global config
    write. ``fast`` presence is the contract: omitted inherits, true pins priority, false pins normal ("")."""
    create_model = _str_param(params, "model")
    model_override = None
    if create_model:
        model_override = {"model": create_model, "provider": _str_param(params, "provider") or None}
    reasoning_override = None
    if effort := _str_param(params, "reasoning_effort"):
        with contextlib.suppress(Exception):
            from hermes_constants import parse_reasoning_effort
            reasoning_override = parse_reasoning_effort(effort)
    service_tier_override = None
    if "fast" in params:
        service_tier_override = "priority" if is_truthy_value(params.get("fast")) else ""
    return model_override, reasoning_override, service_tier_override


def _validated_reserved_create(reserved: ReservedSessionCreate):
    """Return normalized trusted coordinates, or None without exposing which coordinate failed."""
    if (
        type(reserved) is not ReservedSessionCreate
        or type(reserved._capability) is not _ReservedSessionCreateCapability
        or not reserved._capability.is_active()
    ):
        return None
    values = (
        reserved.runtime_session_id,
        reserved.stored_session_id,
        reserved.target_profile,
        reserved.target_profile_home,
        reserved.canonical_project_cwd,
    )
    if any(type(value) is not str or not value or value != value.strip() for value in values):
        return None
    if reserved.runtime_session_id == reserved.stored_session_id:
        return None
    if (
        type(reserved.operation_id) is not str
        or len(reserved.operation_id) != 48
        or any(char not in "0123456789abcdef" for char in reserved.operation_id)
        or type(reserved.creator_pid) is not int
        or not 0 < reserved.creator_pid <= 2**63 - 1
        or type(reserved.creator_started_at) is not int
        or not 0 < reserved.creator_started_at <= 2**63 - 1
        or type(reserved.creator_token) is not str
        or len(reserved.creator_token) != 48
        or any(char not in "0123456789abcdef" for char in reserved.creator_token)
        or type(reserved.creator_epoch) is not int
        or reserved.creator_epoch != 1
    ):
        return None
    try:
        profile = reserved.target_profile
        from hermes_cli.profiles import validate_profile_name

        validate_profile_name(profile)
        expected_home = (
            Path(_hermes_home)
            if profile == _current_profile_name()
            else _profile_home(profile)
        )
        if expected_home is None:
            return None
        expected_home = Path(expected_home).resolve(strict=True)
        supplied_home = Path(reserved.target_profile_home)
        cwd = Path(reserved.canonical_project_cwd)
        if (
            not supplied_home.is_absolute()
            or supplied_home.resolve(strict=True) != supplied_home
            or supplied_home != expected_home
            or not cwd.is_absolute()
            or cwd.resolve(strict=True) != cwd
            or not cwd.is_dir()
        ):
            return None
    except Exception:
        return None
    profile_home = None if expected_home == Path(_hermes_home).resolve() else str(expected_home)
    if type(reserved.workspace_none) is not bool:
        return None
    return (
        reserved.runtime_session_id,
        reserved.stored_session_id,
        profile,
        profile_home,
        str(cwd),
        reserved.lease,
        reserved.workspace_none,
        _authority_from_reserved(reserved),
    )


def _reserved_session_record(
    sid: str, key: str, profile_home: str | None, cwd: str, lease, now: float,
    *, workspace_none: bool = False, creation_authority=None,
) -> dict:
    """Build the empty, lazy runtime shape used by a trusted Companion reservation."""
    return {
        "_sid": sid,
        "agent": None, "agent_error": None, "agent_ready": threading.Event(), "attached_images": [],
        "close_on_disconnect": False,
        "active_session_lease": None,
        "cols": 80, "created_at": now, "edit_snapshots": {},
        "explicit_cwd": not workspace_none,
        "history": [], "history_lock": threading.Lock(), "history_version": 0, "image_counter": 0,
        "cwd": cwd, "inflight_turn": None, "last_active": now,
        "model_override": None,
        "create_reasoning_override": None,
        "create_service_tier_override": None,
        "parent_session_id": None, "pending_title": None,
        "pending_hidden": False, "room_plumbing": False,
        "follow_profile_config": False,
        "profile_home": profile_home,
        "workspace_none": workspace_none,
        "running": False, "session_key": key, "show_reasoning": _load_show_reasoning(), "source": "companion",
        "slash_worker": None, "tool_progress_mode": _load_tool_progress_mode(), "tool_started_at": {},
        "transport": current_transport() or _stdio_transport,
        **({_CREATION_AUTHORITY_KEY: creation_authority} if creation_authority is not None else {}),
    }


def _create_reserved_session(rid, reserved: ReservedSessionCreate) -> dict:
    coordinates = _validated_reserved_create(reserved)
    if coordinates is None:
        return _reserved_create_error(rid)
    sid, key, profile, profile_home, cwd, lease, workspace_none, authority = coordinates
    _enable_gateway_prompts()
    # Resolve response-only probes before publishing: after exact transfer there is no
    # fallible work between ownership installation and the success response.
    info = {
        "model": _resolve_model(), "tools": {}, "skills": {}, "cwd": cwd,
        "branch": git_probe.branch(cwd), "project": _project_info_for_cwd(cwd),
        "lazy": True, "desktop_contract": DESKTOP_BACKEND_CONTRACT,
        "profile_name": profile,
    }
    session = _reserved_session_record(
        sid, key, profile_home, cwd, lease, time.time(), workspace_none=workspace_none,
        creation_authority=authority,
    )
    # Generic cwd registration is the last fallible hook and must precede publication.
    try:
        _register_session_cwd(session)
    except Exception:
        logger.warning(_RESERVED_CREATE_FAILURE)
        return _reserved_create_error(rid)
    with _session_resume_lock, _lifecycle_reservation_lock, _sessions_lock:
        tracked = _tracked_creation_reservation(lease)
        if (
            _eager_resume_build_active(profile_home, key)
            or tracked is None
            or tracked[0] is not lease
            or tracked[1:] != (key, sid, False)
            or str(getattr(lease, "session_id", "")) != key
            or not getattr(lease, "enabled", False)
            or getattr(lease, "released", False)
            or not getattr(lease, "track_liveness", False)
            or sid in _sessions
            or any(existing.get("session_key") == key for existing in _sessions.values())
            or any(existing.get("active_session_lease") is lease for existing in _sessions.values())
            or any(
                other_lease is not lease and (other_key == key or other_sid == sid)
                for other_lease, other_key, other_sid, _retained
                in _inflight_creation_reservations.values()
            )
        ):
            return _reserved_create_error(rid)
        _sessions[sid] = session
        if not _transfer_creation_reservation(lease, sid=sid, session=session):
            if _sessions.get(sid) is session:
                _sessions.pop(sid, None)
            return _reserved_create_error(rid)
        try:
            _track_transferred_creation_lease(session, lease)
            if session.get(_CREATION_LEASE_KEY) is not lease:
                raise RuntimeError("creation reservation marker is invalid")
            if not reserved._capability.mark_published():
                raise RuntimeError("reserved creation publication authority is invalid")
        except Exception:
            # Restore the exact pre-publication ownership state. Re-track before
            # removing the runtime so lease snapshots never lose this reservation.
            restored = _track_creation_reservation(
                lease, session_key=key, live_session_id=sid
            )
            if not restored:
                _inflight_creation_reservations[id(lease)] = (lease, key, sid, False)
                restored = True
            if restored and _sessions.get(sid) is session:
                session["active_session_lease"] = None
                session.pop(_CREATION_LEASE_KEY, None)
                _sessions.pop(sid, None)
            return _reserved_create_error(rid)
    return _ok(rid, {
        "session_id": sid, "stored_session_id": key, "message_count": 0,
        "messages": [], "info": info,
    })


@method("session.create")
def _(rid, params: dict) -> dict:
    if (reserved := _reserved_session_create_context.get()) is not None:
        return _create_reserved_session(rid, reserved)
    (sid, source), key = _new_runtime_ids(params), _new_session_key()
    history = _coerce_seed_history(params.get("messages"))
    # Branch: links back so list_sessions_rich keeps it visible and the sidebar nests it.
    parent_session_id = _str_param(params, "parent_session_id") or None
    # Only an explicitly chosen existing workspace persists as cwd; the launch-dir fallback is "No workspace".
    explicit_cwd = False
    raw_cwd = _str_param(params, "cwd")  # unguarded, as on BASE: only the path check is best-effort
    with contextlib.suppress(Exception):
        explicit_cwd = bool(raw_cwd) and os.path.isdir(os.path.abspath(os.path.expanduser(raw_cwd)))
    _enable_gateway_prompts()
    # ``profile`` (app-global remote mode): stored so the build and every turn re-bind HERMES_HOME.
    profile_home = _profile_home(profile := (params.get("profile") or "").strip() or None)
    session_model_override, create_reasoning_override, create_service_tier_override = _create_overrides(params)
    now = time.time()
    with _sessions_lock:
        _sessions[sid] = {
            "_sid": sid,
            "agent": None, "agent_error": None, "agent_ready": threading.Event(), "attached_images": [],
            "close_on_disconnect": _flag(params, "close_on_disconnect"),
            "active_session_lease": None,  # claimed lazily on the first turn (_ensure_active_session_slot)
            "cols": int(params.get("cols", 80)), "created_at": now, "edit_snapshots": {},
            "explicit_cwd": explicit_cwd,
            "history": history, "history_lock": threading.Lock(), "history_version": 0, "image_counter": 0,
            "cwd": _completion_cwd(params), "inflight_turn": None, "last_active": now,
            "model_override": session_model_override,
            "create_reasoning_override": create_reasoning_override,
            "create_service_tier_override": create_service_tier_override,
            "parent_session_id": parent_session_id, "pending_title": _str_param(params, "title") or None,
            "pending_hidden": _flag(params, "hidden"), "room_plumbing": _flag(params, "room_plumbing"),
            "follow_profile_config": _flag(params, "follow_profile_config"),
            "profile_home": str(profile_home) if profile_home is not None else None,
            "running": False, "session_key": key, "show_reasoning": _load_show_reasoning(), "source": source,
            "slash_worker": None, "tool_progress_mode": _load_tool_progress_mode(), "tool_started_at": {},
            "transport": current_transport() or _stdio_transport}
        _register_session_cwd(_sessions[sid])
    # No DB row here (drafts left "Untitled" litter): created on the first prompt — except seeded branch children.
    # NOTE: we intentionally do NOT persist a DB row here. Every TUI/desktop launch (and every "New agent" /
    # draft) opens a session here just to paint the composer, so eagerly creating a row left an "Untitled"
    # empty session behind for every launch the user never typed into. The row is now created lazily on the
    # first prompt (see _ensure_session_db_row + prompt.submit), and the AIAgent's own INSERT-OR-IGNORE
    # persists it on the first turn too. EXCEPTION — seeded branch children (#93959): a desktop branch
    # carries parent_session_id AND a seeded transcript, which is explicit user intent, not an abandoned
    # draft. The row MUST exist immediately: the renderer's post-create resume re-fetches the child through
    # REST + defer_history hydration, both of which read the DB — an unpersisted child 404s, the fail-latch
    # then refuses to bind a "transcript-less" session, and the user sees an infinite spinner whose
    # optimistic row vanishes on restart. Persisting up front also means a restart keeps the branch (both
    # reports lost it) and the title lands in the parent's lineage instead of falling back to a
    # message-preview name. Title mirrors the TUI /branch naming.
    if parent_session_id and history:
        _seed_branch_row(_sessions[sid], key, parent_session_id, history, source, profile_home)
    # Return immediately so Ink can paint; the AIAgent builds right after the flush.
    _schedule_agent_build(sid)
    _schedule_session_cap_enforcement()  # trim detached idle sessions over the cap
    cwd = _sessions[sid]["cwd"]
    override = session_model_override or {}
    return _ok(rid, {
        "session_id": sid, "stored_session_id": key, "message_count": len(history),
        "messages": _history_to_messages(history),
        # Reflect the override now so the client doesn't clobber its sticky pick.
        "info": {"model": override.get("model") if override else _resolve_model(),
                 **({"provider": override["provider"]} if override.get("provider") else {}),
                 "tools": {}, "skills": {}, "cwd": cwd, "branch": git_probe.branch(cwd),
                 "project": _project_info_for_cwd(cwd), "lazy": True, "desktop_contract": DESKTOP_BACKEND_CONTRACT,
                 "profile_name": _response_profile_name(profile)}})


@method("session.save")
def _(rid, params: dict) -> dict:
    session, err = _sess(params, rid)
    if err:
        return err
    if _session_uses_compute_host(session):
        return _save_via_compute_host(rid, params)
    agent = session["agent"]
    # Classic CLI /save: under the profile home, with the system prompt (dashboard parity).
    saved_dir = get_hermes_home() / "sessions" / "saved"
    try:
        saved_dir.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        return _err(rid, 5011, f"failed to create save directory {saved_dir}: {e}")
    path = saved_dir / f"hermes_conversation_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with session["history_lock"]:
        messages = list(session.get("history", []))
    # Prefer the agent's session_start (classic CLI export); else the gateway created_at.
    started = getattr(agent, "session_start", None)
    if not isinstance(started, datetime):
        created_at = session.get("created_at")
        started = datetime.fromtimestamp(created_at) if isinstance(created_at, (int, float)) else None
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"model": getattr(agent, "model", ""),
                       "session_id": getattr(agent, "session_id", None) or session.get("session_key") or "",
                       "session_start": started.isoformat() if started else "",
                       "system_prompt": getattr(agent, "_cached_system_prompt", "") or "",
                       "messages": messages}, f, indent=2, ensure_ascii=False)
    except Exception as e:
        return _err(rid, 5011, str(e))
    return _ok(rid, {"file": str(path)})


@method("session.close")
def _(rid, params: dict) -> dict:
    with _session_resume_lock:  # lock only the ownership claim; finalization must not block resumes
        _session, err = _sess_nowait(params, rid)
        if err:
            return err
        session = _pop_session_by_id(params.get("session_id", ""))
    return _ok(rid, {"closed": _teardown_popped_session(session, end_reason="tui_close")})


def _visible_branch_history(messages) -> list:
    """user/assistant rows with visible text, as FULL copies (reasoning + timeline-marker tags survive)."""
    return [dict(message) for message in messages or []
            if isinstance(message, dict) and message.get("role") in {"user", "assistant"}
            and _coerce_message_text(message.get("content")).strip()]


def _build_branch_agent(session: dict, new_sid: str, new_key: str, history: list, source: str):
    """Build + register the branched agent in the parent's profile; the DEDICATED db handle is ours until
    ``_transfer_db_to_agent`` (released here on failure)."""
    parent_home = session.get("profile_home")
    branch_db, branch_owns_db = _profile_session_db(parent_home) if parent_home else (None, False)
    try:
        with _profile_build_scope(parent_home):
            agent = _make_agent_in_context(new_sid, new_key, session_db=branch_db, platform_override=source,
                                           context_cwd_is_launch_artifact=_context_cwd_is_launch_artifact(session))
            _init_session(new_sid, new_key, agent, list(history), cols=session.get("cols", 80),
                          cwd=_session_cwd(session), session_db=branch_db, source=source, profile_home=parent_home,
                          explicit_cwd=bool(session.get("explicit_cwd")))
            _transfer_db_to_agent(agent, branch_db)
            branch_owns_db = False
        if new_sid in _sessions:
            _sessions[new_sid]["active_session_lease"] = None  # claimed lazily on the first turn
        return agent
    finally:
        if branch_owns_db and branch_db is not None:
            _release_db(branch_db)


_BRANCH_COPY_FIELDS = (
    "reasoning", "reasoning_content", "reasoning_details", "codex_reasoning_items", "codex_message_items",
    # Timeline markers ride as role=user; untagged they become bare user turns after a restart, corrupting
    # the truncate ordinal address space.
    "display_kind", "display_metadata",
    # Branch copies are history, not new activity: keep the parent's timestamps.
    "timestamp")


def _branch_source_history(db, session: dict, old_key: str) -> list:
    """Rows a branch copies: the persisted DISPLAY projection reconciled with live memory (live history is
    the MODEL projection — post-compaction summary + tail — the child would lose every archived turn)."""
    with session["history_lock"]:
        in_memory_history = [
            dict(msg) for msg in list(session.get("display_history_prefix") or []) + list(session.get("history", []))
            if isinstance(msg, dict)]
    history = None
    if callable(get_resume_conversations := getattr(db, "get_resume_conversations", None)):
        try:
            _, display_history = get_resume_conversations(old_key)
            history = _visible_branch_history(_reconcile_display_with_live(display_history, in_memory_history))
        except Exception:
            logger.debug("branch display projection read failed", exc_info=True)
    return history or _visible_branch_history(in_memory_history)


@method("session.branch")
def _(rid, params: dict) -> dict:
    session, err = _sess(params, rid)
    if err:
        return err
    # Write into the parent's profile-scoped state.db; the launch handle would orphan rows.
    with _session_db(session) as db:
        if db is None:
            return _db_unavailable_error(rid, code=5008)
        old_key = session["session_key"]
        history = _branch_source_history(db, session, old_key)
        if not history:
            return _err(rid, 4008, "nothing to branch — send a message first")
        if isinstance(count := params.get("count"), int) and count > 0:
            history = history[:count]
        new_key, new_sid, source = _new_session_key(), uuid.uuid4().hex[:8], _session_source(session)
        try:
            title = params.get("name", "") or _branch_title(db, old_key)
            home = session.get("profile_home")
            _persist_branch(db, new_key, old_key, title, history, source=source, cwd=_session_cwd(session),
                            profile_name=Path(home).name if home else _current_profile_name(),
                            copy_fields=_BRANCH_COPY_FIELDS)
        except Exception as e:
            return _err(rid, 5008, f"branch failed: {e}")
    try:
        agent = _build_branch_agent(session, new_sid, new_key, history, source)
    except Exception as e:
        return _err(rid, 5000, f"agent init failed on branch: {e}")
    return _ok(rid, {"session_id": new_sid, "stored_session_id": new_key, "title": title, "parent": old_key,
                     "message_count": len(history), "messages": _history_to_messages(history),
                     "info": _session_info(agent, _sessions.get(new_sid))})


def register(server) -> None:
    """Publish creation helpers onto ``server`` and install the rebound handlers."""
    bind_module(globals(), server, skip=("_",))
