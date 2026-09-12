"""Session / delegation / spawn-tree / billing / pet JSON-RPC handlers.

Bodies are rebound onto server.py's globals at install time (method_ctx.py), so they use server
helpers (``_sessions``, ``_ok``, ``_err``, ...) bare; module-level helpers are published onto
server.py the same way (tests monkeypatching ``server.X`` still intercept)."""

import contextlib

from .method_ctx import HandlerRegistry, bind_module

_registry = HandlerRegistry()
method = _registry.method
_profile_scoped = _registry.profile_scoped


# ── shared handler plumbing ──────────────────────────────────────────
def _session_arg(resolve):
    """Resolve ``params.session_id`` via ``resolve`` (a lambda — decoration precedes bind_module) → 3rd arg."""
    def deco(fn):
        def handler(rid, params: dict) -> dict:
            session, err = resolve(params, rid)
            return err or fn(rid, params, session)
        return handler
    return deco


_with_session = _session_arg(lambda params, rid: _sess_nowait(params, rid))  # no agent-build wait
_with_live_session = _session_arg(lambda params, rid: _sess(params, rid))  # waits for the agent build


def _session_method(name: str, *, live: bool = False):
    """``@method(name)`` over ``_with_live_session`` (waits for the agent build) or ``_with_session``."""
    return lambda fn: method(name)((_with_live_session if live else _with_session)(fn))


def _with_db(code: int, *, session_scoped: bool):
    """Append a db arg — the session's db (after ``_with_session``) or ``_profile_db(params)``; ``code`` when None."""
    def deco(fn):
        def handler(rid, params: dict, *session) -> dict:
            with (_session_db(session[0]) if session_scoped else _profile_db(params)) as db:
                if db is None:
                    return _db_unavailable_error(rid, code=code)
                return fn(rid, params, *session, db)
        return _with_session(handler) if session_scoped else handler
    return deco


def _str_param(params: dict, key: str, default: str = "") -> str:
    """``str(params[key]).strip()`` with ``default`` for missing / falsy values."""
    return str(params.get(key) or "").strip() or default


def _flag(params: dict, name: str) -> bool:
    return is_truthy_value(params.get(name, False))


def _int_param(params: dict, key: str, default: int) -> int:
    """``int(params[key])`` with ``default`` for missing / unparsable values."""
    try:
        return int(params.get(key, default))
    except (TypeError, ValueError):
        return default


def _cwd_info(session: dict, cwd: str, branch=None) -> dict:
    """session.info after a cwd change: the full agent view, or the lazy shape."""
    if (agent := session.get("agent")) is not None:
        return _session_info(agent, session)
    return {"cwd": cwd, "branch": git_probe.branch(cwd) if branch is None else branch,
            "project": _project_info_for_cwd(cwd), "lazy": True}


def _session_row_summary(row: dict, *, tip_row: dict | None = None, resolved_id=None) -> dict:
    """Compact session.list row; ``tip_row``/``resolved_id`` come from the compression tip."""
    tip_row = tip_row or row
    return {"id": row["id"], **({} if resolved_id is None else {"resolved_id": resolved_id}),
            "title": row.get("title") or "", "preview": tip_row.get("preview") or "",
            "started_at": row.get("started_at") or 0,
            "last_active": tip_row.get("last_active") or tip_row.get("last_activity_at")
            or tip_row.get("started_at") or 0,
            "message_count": tip_row.get("message_count") or 0,
            "source": row.get("source") or "", "pinned": bool(row.get("pinned"))}


# Hidden from human listings (sub-agent runs, kanban workers); a deny-list so new platforms surface automatically.
_LISTING_DENY_SOURCES = frozenset({"kanban", "tool"})


def _denied_source(row: dict) -> bool:
    return (row.get("source") or "").strip().lower() in _LISTING_DENY_SOURCES


def _listing_rows(db, limit: int, **kwargs) -> list:
    """Human-facing ``list_sessions_rich`` rows (most recent first), deny-list applied."""
    rows = db.list_sessions_rich(source=None, limit=limit, order_by_last_active=True, compact_rows=True, **kwargs)
    return [row for row in rows if not _denied_source(row)]


def _snapshot_sessions(rid):
    """``(list(_sessions.items()), None)`` under the lock, or ``(None, 5036 error)`` — fail CLOSED."""
    try:
        with _sessions_lock:
            return list(_sessions.items()), None
    except Exception as e:
        return None, _err(rid, 5036, f"could not enumerate active sessions: {e}")


def _pet_display_cfg() -> dict:
    """``display.pet`` config block, ``{}`` when config is unreadable."""
    try:
        from hermes_cli.config import load_config
        cfg = load_config()
        display = cfg.get("display", {}) if isinstance(cfg.get("display"), dict) else {}
        return display.get("pet", {}) if isinstance(display.get("pet"), dict) else {}
    except Exception:
        return {}


def _pet_emit(event: str, payload: dict, what: str) -> None:
    """Best-effort progress emit: a transport hiccup must never abort generation."""
    try:
        _emit(event, "", payload)
    except Exception as exc:  # noqa: BLE001
        logger.debug("%s emit failed: %s", what, exc)


def _pet_gen_abort(rid, token: str, code: int, message: str) -> dict:
    """Release the cancel arm for ``token`` and return ``_err``."""
    _pet_cancel_release(token)
    return _err(rid, code, message)


def _pet_method(name: str, *, fail_open=None, slug: bool = False, scoped: bool = True):
    """``@method`` (+ ``@_profile_scoped`` unless ``scoped=False``) whose exceptions never break the surface: logged
    at debug, then ``fail_open`` (payload or ``params -> payload``) or ``_err(5031)``. ``slug``: 3rd arg (4004)."""
    def deco(fn):
        def handler(rid, params: dict) -> dict:
            try:
                if slug and not (value := _str_param(params, "slug")):
                    return _err(rid, 4004, "missing slug")
                return fn(rid, params, value) if slug else fn(rid, params)
            except Exception as exc:  # noqa: BLE001 - cosmetic surface
                logger.debug("%s failed: %s", name, exc)
                if fail_open is not None:
                    return _ok(rid, fail_open(params) if callable(fail_open) else dict(fail_open))
                return _err(rid, 5031, f"{name} failed: {exc}")
        return method(name)(_profile_scoped(handler) if scoped else handler)
    return deco


def _active_pet():
    """``(pet, scale)`` when the pet display is enabled and the pet exists, else None."""
    enabled, pet, scale = _pet_active_selection()
    return None if not enabled or pet is None or not pet.exists else (pet, scale)


def _billing_call(rid, fn, extra: dict | None = None) -> dict:
    """Portal call → ok; BillingError → serialized envelope, else generic; ``extra`` rides both ERROR envelopes."""
    from hermes_cli.nous_billing import BillingError
    try:
        return _ok(rid, fn())
    except BillingError as exc:
        return _ok(rid, {**_serialize_billing_error(exc), **(extra or {})})
    except Exception as exc:
        return _ok(rid, {"ok": False, "error": "error", "message": str(exc), **(extra or {})})


def _billing_invalid(rid, message: str, error: str = "invalid_request") -> dict:
    return _ok(rid, {"ok": False, "error": error, "message": message})


def _billing_pick(result: dict, **fields) -> dict:
    """``{"ok": True, <snake>: result[<camel>], ...}`` in ``fields`` order."""
    return {"ok": True, **{key: result.get(src) for key, src in fields.items()}}


def _billing_pending_change(result: dict) -> dict:
    return {"ok": True, "message": result.get("message"), "payload": result}


# ── session.list / most_recent / facts ───────────────────────────────
def _session_list_by_title(
    rid, db, title_lookup: str, *, include_hidden: bool = False, include_archived: bool = False
) -> dict:
    """EXACT-title lookup (title as identity), window-free on purpose (a busy profile's windowed listing can
    push the row out). Hidden rows always resolve (canonical chats are born hidden and the desktop's
    click-open path sends no flags); archived rows resolve only when explicitly requested; deny-listed rows
    do not. ``include_hidden`` is accepted for caller compatibility. Compression lineages resolve to the
    live tip (``resolved_id``)."""
    row = db.get_session_by_title(title_lookup)
    if row and row.get("archived") and not include_archived:
        from tools.bot_mode_probe import BOT_CHAT_TITLE
        # A Bot Chat archived by the ws-orphan reaper / agent_close is an accident (the desktop would mint
        # replacements forever): resurrect recoverable reasons only. Re-fetch by ID — title is not UNIQUE.
        if title_lookup == BOT_CHAT_TITLE and db.unarchive_recoverable_session(row["id"]):
            # The canonical Bot Chat is identity-scoped: an archive stamped by the ws-orphan reaper or older
            # agent cleanup (ws_orphan_reap / agent_close) is an accident, not user intent, and hiding the
            # row here makes the desktop mint transient replacements forever (#92687). Resurrect it — same
            # recoverable-reason set as stale-route recovery. Deliberate archives (no/explicit end_reason)
            # still hide. Re-fetch by ID: title has no DB-level UNIQUE, so a title re-query could grab a
            # different (still-archived) duplicate row.
            row = db.get_session(row["id"])
    if not row or (row.get("archived") and not include_archived) or _denied_source(row):
        return _ok(rid, {"sessions": []})
    tip = row["id"]
    with contextlib.suppress(Exception):
        # Real compression continuation only: the resolver's unmarked-child fallback could redirect Bot Chat.
        tip = db.get_compression_tip(row["id"]) or row["id"]
    tip_row = (db.get_session(tip) or row) if tip != row["id"] else row
    return _ok(rid, {"sessions": [_session_row_summary(row, tip_row=tip_row, resolved_id=tip)]})


@method("session.list")
@_with_db(5006, session_scoped=False)
def _(rid, params: dict, db) -> dict:
    try:
        if title_lookup := _str_param(params, "title"):
            return _session_list_by_title(
                rid, db, title_lookup,
                include_hidden=_flag(params, "include_hidden"),
                include_archived=_flag(params, "include_archived"),
            )
        limit = int(params.get("limit", 200) or 200)
        # Over-fetch: per-source filtering + tip merging must not leave us short. ``include_hidden`` is for
        # surfaces that OWN hidden sessions (Bots pane, pickers).
        rows = _listing_rows(db, max(limit * 2, 200), include_hidden=_flag(params, "include_hidden"))[:limit]
        return _ok(rid, {"sessions": [_session_row_summary(s) for s in rows]})
    except Exception as e:
        return _err(rid, 5006, str(e))


@method("session.most_recent")
def _(rid, params: dict) -> dict:
    """Most recent human-facing session (session.list deny-list); errors fold into ``session_id: null``."""
    with _profile_db(params) as db:
        try:
            # Generous over-fetch: many ``tool`` rows must not yield a false "none".
            for row in _listing_rows(db, 200)[:1] if db is not None else ():
                return _ok(rid, {"session_id": row.get("id"), "title": row.get("title") or "",
                                 "started_at": row.get("started_at") or 0, "source": row.get("source") or ""})
        except Exception:
            logger.exception("session.most_recent failed")
        return _ok(rid, {"session_id": None})


@method("project.facts")
def _(rid, params: dict) -> dict:
    """The system prompt's coding-context detection for a cwd (UIs don't re-sniff); null = not code."""
    try:
        from agent.coding_context import project_facts_for
        return _ok(rid, {"facts": project_facts_for(params.get("cwd"))})
    except Exception:
        logger.exception("project.facts failed")
        return _ok(rid, {"facts": None})


@method("verification.status")
@_profile_scoped
def _(rid, params: dict) -> dict:
    """Best known verification evidence for a cwd/session. Read-only: never runs checks,
    never upgrades targeted evidence into a repository-wide guarantee."""
    try:
        from agent.verification_evidence import verification_status
        return _ok(rid, {"verification": verification_status(
            session_id=params.get("session_id") or params.get("session_key"), cwd=params.get("cwd"))})
    except Exception:
        logger.exception("verification.status failed")
        return _ok(rid, {"verification": {"status": "unknown", "evidence": None}})


# ── cwd / workspace / live-session bookkeeping ───────────────────────
@_session_method("session.cwd.set")
def _(rid, params: dict, session: dict) -> dict:
    if session.get("running"):
        return _err(rid, 4009, "session busy")
    if not (raw := _str_param(params, "cwd")):
        return _err(rid, 4016, "cwd required")
    try:
        cwd = _set_session_cwd(session, raw)
    except ValueError as e:
        return _err(rid, 4017, str(e))
    info = _cwd_info(session, cwd)
    _emit("session.info", params.get("session_id", ""), info)
    return _ok(rid, info)


@method("session.workspace.move")
def _(rid, params: dict) -> dict:
    """Re-home a STORED session's workspace (by ``session_key``; no live agent required). git branch/root are
    REPLACED (a stale ``git_repo_root`` kept the session under the project it left); a live agent follows even
    mid-turn (refusing made the UI claim success while state.db kept the old cwd)."""
    if not (target := _str_param(params, "session_key")):
        return _err(rid, 4007, "session_key required")
    if not (raw := _str_param(params, "cwd")):
        return _err(rid, 4016, "cwd required")
    from hermes_constants import translate_cwd_for_wsl_backend
    resolved = os.path.abspath(os.path.expanduser(translate_cwd_for_wsl_backend(raw)))
    if not os.path.isdir(resolved):
        return _err(rid, 4017, f"working directory does not exist: {raw}")
    # Snapshot under the lock — concurrent RPCs mutate _sessions.
    with _sessions_lock:
        live_sid, live = next(
            ((sid, sess) for sid, sess in list(_sessions.items()) if sess.get("session_key") == target), ("", None))
        if live is not None and not _provisional_creation_access_allowed(live):
            return _err(rid, 4090, "session creation is still pending")
    branch, root = git_probe.branch(resolved), git_probe.common_repo_root(resolved)
    with _profile_db(params) as db:
        if db is None:
            return _db_unavailable_error(rid, code=5007)
        # A draft has no row yet; the live re-home still applies (row inherits cwd on write).
        if not db.get_session(target):
            if live is None:
                return _err(rid, 4007, "session not found")
        else:
            try:
                db.update_session_cwd(target, resolved, branch, root, replace_git_meta=True)
            except Exception as e:
                return _err(rid, 5007, f"move failed: {e}")
    if live is not None:
        try:
            _set_session_cwd(live, resolved)
        except ValueError as e:
            return _err(rid, 4017, str(e))
        _emit("session.info", live_sid, _cwd_info(live, resolved, branch=branch))
    return _ok(rid, {"cwd": resolved, "branch": branch, "git_repo_root": root})


@method("session.active_list")
def _(rid, params: dict) -> dict:
    """Live TUI sessions in this process (not a DB browser)."""
    snapshot, err = _snapshot_sessions(rid)
    if err:
        return err
    current = str(params.get("current_session_id") or "")
    # ``_finalized`` sessions linger until the reaper pops them (they inflated the footer). Do NOT filter on
    # the WS-detached sentinel: detached is attachable until grace-reap, and ``hermes --tui`` rides stdio.
    # Keep insertion order (focused must not jump).
    rows = [
        _session_live_item(sid, session, current)
        for sid, session in snapshot
        if not session.get("_finalized") and session.get(_CREATION_AUTHORITY_KEY) is None
    ]
    return _ok(rid, {"sessions": rows})


@_session_method("session.activate")
def _(rid, params: dict, session: dict) -> dict:
    """Attach the frontend to a live TUI session without closing the previously focused one."""
    sid = str(params.get("session_id") or "")
    # Only the rebind is atomic with grace expiry; the payload (a DB history read unless
    # ``omit_messages``) must not hold the process-wide resume lock.
    with _session_resume_lock:
        if (refusal := _reattach_refusal(rid, sid, session)) is not None:
            return refusal
        with session["history_lock"]:
            _rebind_live_transport(sid, session, current_transport() or _stdio_transport)
    return _ok(rid, _live_session_payload(
        sid, session, touch=True, omit_messages=is_truthy_value(params.get("omit_messages", False))))


@method("session.delete")
def _(rid, params: dict) -> dict:
    """Delete a stored session + transcripts; refused while live here (FK trips on the agent's next flush)."""
    if not (target := params.get("session_id", "")):
        return _err(rid, 4006, "session_id required")
    snapshot, err = _snapshot_sessions(rid)
    if err:
        return err
    if any(s.get("session_key") == target for _sid, s in snapshot):
        return _err(rid, 4023, "cannot delete an active session")
    profile_home = _profile_home((params.get("profile") or "").strip() or None)
    with _profile_db(params) as db:
        if db is None:
            return _db_unavailable_error(rid, code=5036)
        try:
            home = Path(profile_home) if profile_home is not None else get_hermes_home()
            deleted = db.delete_session(target, sessions_dir=home / "sessions")
        except Exception as e:
            return _err(rid, 5036, f"delete failed: {e}")
    return _ok(rid, {"deleted": target}) if deleted else _err(rid, 4007, "session not found")


def _title_read(session: dict, db, key: str) -> str:
    """``session.title`` without ``title``: read it, applying a queued pending_title if possible."""
    fallback = session.get("pending_title") or ""
    try:
        resolved_title = db.get_session_title(key) or ""
        if not fallback:
            if resolved_title:
                session["pending_title"] = None
        elif (db.set_session_title(key, fallback)
              or ((db.get_session(key) or {}).get("title") or "").strip() == fallback):
            session["pending_title"] = None
            resolved_title = fallback
        elif not resolved_title:
            resolved_title = fallback
    except Exception:
        resolved_title = fallback
    return resolved_title


@method("session.title")
@_with_db(5007, session_scoped=True)
def _(rid, params: dict, session: dict, db) -> dict:
    key = session["session_key"]
    if "title" not in params:
        result = {"title": _title_read(session, db, key), "session_key": key}
    elif not (title := (params.get("title", "") or "").strip()):
        return _err(rid, 4021, "title required")
    else:
        try:
            if db.set_session_title(key, title):
                pending, value = False, title
            # rowcount == 0 can mean "same value" as well as "missing row".
            elif existing_row := db.get_session(key):
                pending, value = False, existing_row.get("title") or title
            else:
                # No row yet: an explicit /title is clear intent, so persist the row NOW (as the gateway's
                # _handle_title_command); the min-messages sidebar filter hides a titled 0-message row. If
                # row creation didn't take, queue so the post-turn apply block can recover.
                _ensure_session_db_row(session)
                with _session_db(session) as scoped_db:
                    pending, value = not (scoped_db is not None and scoped_db.set_session_title(key, title)), title
        except ValueError as e:
            return _err(rid, 4022, str(e))
        except Exception as e:
            return _err(rid, 5007, str(e))
        session["pending_title"] = value if pending else None
        result = {"pending": pending, "title": value}
    _emit_session_info_for_session(params.get("session_id", ""), session)
    return _ok(rid, result)


@method("session.set_hidden")
def _(rid, params: dict) -> dict:
    """Set/clear ``hidden`` (leaves the default list, stays resumable by its owner) on a session + lineage:
    LIVE runtime id first (unpersisted drafts via ``pending_hidden``), then a stored id/key in the profile db."""
    hidden = is_truthy_value(params.get("hidden", True))
    session, err = _sess_nowait(params, rid)
    with (_profile_db(params) if session is None else _session_db(session)) as db:
        if db is None:
            return _db_unavailable_error(rid, code=5007)
        try:
            if session is not None:
                key = session["session_key"]
                if not db.set_session_hidden(key, hidden):
                    session["pending_hidden"] = hidden  # no row yet: _ensure_session_db_row is born hidden
            else:
                # ``resolve_session_id`` follows key/title aliases like the REST pin/archive path.
                target = _str_param(params, "session_id")
                if not (key := db.resolve_session_id(target) if hasattr(db, "resolve_session_id") else target):
                    return err
                db.set_session_hidden(key, hidden)
            return _ok(rid, {"hidden": hidden, "session_key": key})
        except Exception as e:
            return _err(rid, 5007, str(e))


@method("session.set_pinned")
def _(rid, params: dict) -> dict:
    """Persist a conversation pin in the explicitly requested profile DB."""
    requested_profile = _str_param(params, "profile")
    if requested_profile:
        try:
            from hermes_cli.profiles import normalize_profile_name, validate_profile_name

            requested_profile = normalize_profile_name(requested_profile)
            validate_profile_name(requested_profile)
        except (ImportError, ValueError) as exc:
            return _err(rid, 4006, f"invalid profile: {exc}")
        if requested_profile != _current_profile_name() and _profile_home(requested_profile) is None:
            return _err(rid, 4001, "profile not found")
        params = {**params, "profile": requested_profile}
    target = _str_param(params, "session_id")
    if not target:
        return _err(rid, 4006, "session_id required")
    pinned = _flag(params, "pinned") if "pinned" in params else True
    with _profile_db(params) as db:
        if db is None:
            return _db_unavailable_error(rid, code=5007)
        try:
            resolved = db.resolve_session_id(target) if hasattr(db, "resolve_session_id") else target
            if not resolved:
                return _err(rid, 4001, "session not found")
            changed = db.set_session_pinned(resolved, pinned)
            return _ok(rid, {"pinned": pinned, "session_id": resolved, "changed": bool(changed)})
        except Exception as exc:
            return _err(rid, 5007, str(exc))


@method("attention.list")
def _(rid, params: dict) -> dict:
    """Return attention signals visible to this connected gateway process."""
    try:
        limit = max(1, min(int(params.get("limit", 100) or 100), 100))
    except (TypeError, ValueError):
        limit = 100
    with _sessions_lock:
        sessions = [(sid, dict(session)) for sid, session in _sessions.items()
                    if not session.get("_finalized")]
        outcomes = {sid: dict(value) for sid, value in _companion_attention_outcomes.items()}
    with _prompt_lock:
        prompts = []
        for request_id, (pending_sid, _event) in _pending.items():
            event, payload = _pending_prompt_payloads.get(request_id, ("", {}))
            prompts.append((request_id, pending_sid, event, dict(payload)))
    items = []
    try:
        from pathlib import Path
        from tools.approval import list_gateway_approvals
        from tui_gateway.companion_attention import derive_attention_work_ref
        from tui_gateway import server as gateway_server

        for sid, session in sessions:
            profile = (Path(session["profile_home"]).name if session.get("profile_home")
                       else _current_profile_name())
            work_ref = derive_attention_work_ref(gateway_server, session)
            base = {"profile": profile, "runtime_session_id": sid,
                    "stored_session_id": session.get("session_key") or None,
                    **({"work_ref": work_ref} if work_ref else {})}
            for approval in list_gateway_approvals(session.get("session_key") or ""):
                if not isinstance(approval, dict) or not approval.get("request_id"):
                    continue
                safe_approval = _approval_request_payload(approval)
                raw_choices = safe_approval.get("choices")
                choices = [choice for choice in (raw_choices if isinstance(raw_choices, list) else [])
                           if choice in {"once", "session", "always", "deny"}][:4]
                request = {"request_id": str(safe_approval["request_id"])[:128],
                           "allow_session": bool(safe_approval.get("allow_session")),
                           "allow_permanent": bool(safe_approval.get("allow_permanent")),
                           "choices": choices}
                items.append({**base, "id": f"approval:{sid}:{approval['request_id']}",
                              "kind": "approval", "title": "Approval requested",
                              "detail": "Review the requested action before Hermes continues.",
                              "occurred_at": session.get("last_active") or 0,
                              "actionable": True, "resolution": "approval", "request": request})
            for request_id, pending_sid, event, payload in prompts:
                if pending_sid != sid:
                    continue
                if event == "clarify.request":
                    question = payload.get("question")
                    title = (question.strip()[:240] if isinstance(question, str) and question.strip()
                             else "Hermes has a question")
                    kind, detail = "question", "Answer this question in a full Hermes client to continue."
                else:
                    title = {"secret.request": "Secure input required",
                             "sudo.request": "Administrator input required",
                             "terminal.read.request": "Terminal input required",
                             "mcp.setup.request": "Setup decision required"}.get(event, "Input required")
                    kind, detail = "blocker", "This secure input must be resolved in a full Hermes client."
                items.append({**base, "id": f"prompt:{sid}:{request_id}", "kind": kind,
                              "title": title, "detail": detail,
                              "occurred_at": session.get("last_active") or 0,
                              "actionable": False, "resolution": "unsupported_here",
                              "request_id": request_id})
            if outcome := outcomes.get(sid):
                safe_outcome = {name: outcome[name] for name in (
                    "kind", "title", "detail", "occurred_at") if name in outcome}
                items.append({**base, "id": f"outcome:{sid}:{outcome.get('occurred_at', 0)}",
                              "actionable": True, "resolution": "open_session", **safe_outcome})
    except Exception as exc:
        return _err(rid, 5062, str(exc))
    rank = {"approval": 0, "question": 1, "blocker": 2, "error": 3, "completion": 4}
    items.sort(key=lambda item: (rank.get(item.get("kind"), 9),
                                 -float(item.get("occurred_at") or 0)))
    return _ok(rid, {
        "items": items[:limit], "scope": "connected_runtime",
        "scope_note": "Only sessions and requests visible to this gateway process are included.",
    })


@_session_method("message.react")
def _(rid, params: dict, session: dict) -> dict:
    """Set/clear one author's emoji reaction (Tapback semantics: one per author, same emoji retracts, null
    clears). ``row_id`` is ``messages.id``; a not-yet-persisted live message names ``newest_role`` instead."""
    newest_role = _str_param(params, "newest_role")
    row_id = params.get("row_id")
    if row_id is None and newest_role not in {"user", "assistant"}:
        return _err(rid, 4023, "row_id or newest_role required")
    if (emoji := params.get("emoji")) is not None and not (emoji := str(emoji).strip()):
        return _err(rid, 4024, "emoji must be a non-empty string or null")
    if (author := str(params.get("author") or "user").strip()) not in {"user", "agent"}:
        return _err(rid, 4025, "author must be 'user' or 'agent'")
    with _session_db(session) as db:
        if db is None:
            return _db_unavailable_error(rid, code=5007)
        try:
            if row_id is None:
                row_id = db.latest_message_row_id(session["session_key"], role=newest_role)
                if row_id is None:
                    return _err(rid, 4040, "no message to react to yet")
            reactions = db.set_message_reaction(session["session_key"], int(row_id), emoji, author=author)
        except Exception as e:
            return _err(rid, 5007, str(e))
    if reactions is None:
        return _err(rid, 4040, "message not found in this session")
    return _ok(rid, {"row_id": int(row_id), "reactions": reactions})


@method("llm.oneshot")
def _(rid, params: dict) -> dict:
    """Stateless one-shot LLM request; a live ``session_id`` lends its model, else the ``task`` backend."""
    template = (params.get("template") or "").strip() or None
    instructions = params.get("instructions") or ""
    user_input = params.get("input") or ""
    variables = params.get("variables") if isinstance(params.get("variables"), dict) else {}
    try:
        temperature = float(params["temperature"]) if params.get("temperature") is not None else 0.3
    except (TypeError, ValueError):
        temperature = 0.3
    if not template and not str(instructions).strip() and not str(user_input).strip():
        return _err(rid, 4030, "llm.oneshot requires a template or instructions/input")
    session_id = params.get("session_id") or ""
    if session_id:
        session, err = _sess_nowait({"session_id": session_id}, rid)
        if err:
            return err
    else:
        session = None
    try:
        from agent.oneshot import run_oneshot
        return _ok(rid, {"text": run_oneshot(
            instructions=instructions, user_input=user_input, template=template, variables=variables,
            task=(params.get("task") or "title_generation").strip() or "title_generation",
            max_tokens=_int_param(params, "max_tokens", 1024) or 1024, temperature=temperature,
            main_runtime=_main_runtime_from_agent(session.get("agent")) if session else None)})
    except (KeyError, ValueError) as e:
        return _err(rid, 4031 if isinstance(e, KeyError) else 4032, str(e))
    except Exception as e:
        logger.warning("llm.oneshot failed: %s", e)
        return _err(rid, 5030, f"one-shot generation failed: {e}")


# ── handoff ──────────────────────────────────────────────────────────
@_session_method("handoff.request")
def _(rid, params: dict, session: dict) -> dict:
    """Queue a handoff (desktop /handoff): only writes ``pending``; the gateway watcher claims and re-binds."""
    if session.get("running"):
        return _err(rid, 4009, "session busy — wait for the current turn to finish, then retry the handoff")
    if not (platform_name := (params.get("platform", "") or "").strip().lower()):
        return _err(rid, 4023, "platform required")
    # Validate up front: an unconfigured platform / missing home channel pends forever.
    from gateway.config import Platform, load_gateway_config
    try:
        platform = Platform(platform_name)
    except (ValueError, KeyError):
        return _err(rid, 4024, f"unknown platform '{platform_name}'")
    try:
        with _session_profile_runtime_scope(session):
            gw_config = load_gateway_config()
    except Exception as e:
        return _err(rid, 5021, f"could not load gateway config: {e}")
    if not getattr(gw_config.platforms.get(platform), "enabled", False):
        return _err(rid, 4025, f"platform '{platform_name}' is not configured/enabled in the gateway")
    if not (home := gw_config.get_home_channel(platform)) or not home.chat_id:
        return _err(rid, 4026, f"no home channel configured for {platform_name} — set one with "
                    "/sethome on the destination chat first")
    # The watcher transfers a persisted row, so make sure one exists for an empty chat.
    _ensure_session_db_row(session)
    key = session["session_key"]
    with _session_db(session) as db:
        if db is None:
            return _db_unavailable_error(rid, code=5007)
        try:
            if not db.get_session(key):
                db.set_session_title(key, f"handoff-{key[:8]}")
            if not db.request_handoff(key, platform_name):
                return _err(rid, 4027, "session is already in flight for handoff — wait for it to settle, then retry")
        except Exception as e:
            return _err(rid, 5007, str(e))
    return _ok(rid, {"queued": True, "session_key": key, "platform": platform_name, "home_name": home.name})


@method("handoff.state")
@_with_db(5007, session_scoped=True)
def _(rid, params: dict, session: dict, db) -> dict:
    """Poll ``{state, platform, error}``; ``state`` is pending|running|completed|failed or empty."""
    record = db.get_handoff_state(session["session_key"]) or {}
    return _ok(rid, {field: record.get(field) or "" for field in ("state", "platform", "error")})


@method("handoff.fail")
def _(rid, params: dict) -> dict:
    """Fail a not-yet-claimed handoff (poll timeout); a claimed ``running`` row is the watcher's (CAS)."""
    # Undecorated on purpose: tests rebind this handler's __code__ directly.
    session, err = _sess_nowait(params, rid)
    if err:
        return err
    reason = str(params.get("error") or "handoff failed").strip()[:500]
    with _session_db(session) as db:
        if db is None:
            return _db_unavailable_error(rid, code=5007)
        key = session["session_key"]
        try:
            failed = db.fail_handoff(key, reason, only_states=("pending",))
        except TypeError:
            # Older SessionDB without only_states: fail only when still pending.
            if failed := ((db.get_handoff_state(key) or {}).get("state") or "") == "pending":
                db.fail_handoff(key, reason)
        state = "failed" if failed else (db.get_handoff_state(key) or {}).get("state") or ""
    return _ok(rid, {"failed": bool(failed), "state": state})


# ── usage ────────────────────────────────────────────────────────────
@_session_method("session.usage")
def _(rid, params: dict, session: dict) -> dict:
    usage: dict = _session_usage_snapshot(session)
    if session.get("agent") is None and not usage:
        usage = {"calls": 0, "input": 0, "output": 0, "total": 0}
    # Nous credits are agent-independent (portal fetch); fail-open when absent.
    with contextlib.suppress(Exception):
        from agent.account_usage import nous_credits_lines
        if credits := nous_credits_lines():
            usage["credits_lines"] = credits
    return _ok(rid, usage)


@_session_method("session.context_breakdown")
def _(rid, params: dict, session: dict) -> dict:
    if (agent := session.get("agent")) is None:
        usage = _session_usage_snapshot(session) or _get_usage(None)
        return _ok(rid, {
            "categories": [], "context_max": usage.get("context_max", 0) or 0,
            "context_percent": usage.get("context_percent", 0) or 0,
            "context_used": usage.get("context_used", 0) or 0,
            "estimated_total": usage.get("context_used", 0) or usage.get("total", 0) or 0,
            "model": _metadata_mirror(session).get("model", "")})
    with session["history_lock"]:
        history = list(session.get("history", []))
    # Bind the session context: on the RPC thread the session cwd is unset, so the prompt build
    # inside would key its workspace pin on the backend's cwd and overwrite the session's pin.
    tokens = _set_session_context(session["session_key"])
    try:
        from agent.context_breakdown import compute_session_context_breakdown
        return _ok(rid, compute_session_context_breakdown(agent, history))
    except Exception as exc:
        return _err(rid, 5000, f"Could not compute context breakdown: {exc}")
    finally:
        _clear_session_context(tokens)


# ── pet ──────────────────────────────────────────────────────────────
_PET_OFF = {"enabled": False}


@_pet_method("pet.info", fail_open=_PET_OFF)
def _(rid, params: dict) -> dict:
    """Active pet for sprite renderers: spritesheet (base64) + frame geometry + state-row taxonomy."""
    if (active := _active_pet()) is None:
        return _ok(rid, {"enabled": False})
    pet, scale = active
    payload = {"enabled": True, **_pet_sprite_payload(pet, scale=scale)}
    # Send-once for the multi-MB sheet: same revision → metadata only.
    if (known := str(params.get("knownRevision", "") or "")) and known == payload.get("spritesheetRevision"):
        # Send-once semantics for the multi-MB spritesheet (#54730): a caller that already holds the sheet
        # passes the revision it has, and an unchanged sheet comes back as metadata only
        # (spritesheetUnchanged).
        payload.pop("spritesheetBase64", None)
        payload["spritesheetUnchanged"] = True
    return _ok(rid, payload)


@_pet_method("pet.info.meta", fail_open=_PET_OFF)
def _(rid, params: dict) -> dict:
    """Cheap active-pet metadata used to avoid full payload refreshes."""
    if (active := _active_pet()) is None:
        return _ok(rid, {"enabled": False})
    pet, scale = active
    return _ok(rid, {"enabled": True, "slug": pet.slug, "displayName": pet.display_name, "scale": scale,
                     "spritesheetRevision": _pet_sheet_revision(pet.spritesheet)})


def _pet_kitty_cells(pet, pet_cfg: dict, state: str, scale: float) -> dict | None:
    """kitty payload for a TTY that speaks it (dashboard PTY falls through); only kitty is grid-safe in Ink."""
    from agent.pet import constants, render
    from agent.pet.render import PetRenderer
    configured = str(pet_cfg.get("render_mode", "auto") or "auto").lower()
    if (render.detect_terminal_graphics() if configured in ("", "auto") else configured) != "kitty":
        return None
    image_id = render.kitty_image_id(pet.slug)
    # kitty sizes from scaled pixels, so unicode_cols is moot here.
    payload = PetRenderer(str(pet.spritesheet), mode="kitty", scale=scale).kitty_payload(state, image_id=image_id)
    if not payload:
        return None
    return {"graphics": "kitty", "imageId": image_id, "color": render.kitty_color_hex(image_id),
            "cols": payload["cols"], "rows": payload["rows"], "placeholder": payload["placeholder"],
            "frames": payload["frames"], "frameMs": constants.LOOP_MS / max(1, len(payload["frames"]) or 1),
            "scale": scale}


@_pet_method("pet.cells", fail_open=_PET_OFF)
def _(rid, params: dict) -> dict:
    """Half-block cell frames (``[tr,tg,tb,ta, br,bg,bb,ba]``) for one pet ``state``; ``cols``, ``graphics``."""
    from agent.pet import constants, store
    from agent.pet.render import PetRenderer
    pet_cfg = _pet_display_cfg()
    pet = None
    if is_truthy_value(pet_cfg.get("enabled"), default=False):
        pet = store.resolve_active_pet(str(pet_cfg.get("slug", "") or ""))
    if pet is None or not pet.exists:
        return _ok(rid, {"enabled": False})
    state = str(params.get("state") or constants.PetState.IDLE.value)
    scale = float(pet_cfg.get("scale", constants.DEFAULT_SCALE) or constants.DEFAULT_SCALE)
    cols = int(params.get("cols") or 0) or constants.resolve_cols(scale, pet_cfg.get("unicode_cols", 0))
    base = {"enabled": True, "slug": pet.slug, "displayName": pet.display_name, "state": state}
    if params.get("graphics") and (kitty := _pet_kitty_cells(pet, pet_cfg, state, scale)):
        return _ok(rid, {**base, **kitty})
    renderer = PetRenderer(str(pet.spritesheet), mode="unicode", scale=scale, unicode_cols=cols)
    count = renderer.frame_count(state) or 1
    frames = [[[[*top, *bottom] for (top, bottom) in row] for row in renderer.cells(state, i, cols=cols)]
              for i in range(count)]
    return _ok(rid, {**base, "cols": cols, "frameMs": constants.LOOP_MS / max(1, count), "frames": frames,
                     "scale": scale})


@_pet_method("pet.gallery", fail_open={"enabled": False, "active": "", "pets": []})
def _(rid, params: dict) -> dict:
    """Petdex gallery + local install state (installed-only offline); ``localOnly`` skips the remote manifest."""
    local_only = bool(params.get("localOnly"))
    from agent.pet import store
    pet_cfg = _pet_display_cfg()
    installed = {p.slug: p for p in store.installed_pets()}
    gallery: list[dict] = []
    try:
        from agent.pet.manifest import fetch_manifest, prefetch
        # Local-only still warms the manifest cache in the background.
        if local_only:
            prefetch()
        for entry in [] if local_only else fetch_manifest():
            gallery.append({
                "slug": entry.slug, "displayName": entry.display_name, "installed": entry.slug in installed,
                "spritesheetUrl": entry.spritesheet_url,
                # No popularity metric; petdex's hand-picked set (by asset path) is closest.
                "curated": "/curated/" in entry.spritesheet_url,
                "generated": entry.slug in installed and installed[entry.slug].generated})
    except Exception as exc:  # noqa: BLE001 - offline: fall back to installed
        logger.debug("pet.gallery manifest fetch failed: %s", exc)
    seen = {item["slug"] for item in gallery}
    gallery.extend(
        {"slug": slug, "displayName": pet.display_name, "installed": True, "spritesheetUrl": "",
         "generated": pet.generated}
        for slug, pet in installed.items() if slug not in seen)
    return _ok(rid, {"enabled": is_truthy_value(pet_cfg.get("enabled"), default=False),
                     "active": str(pet_cfg.get("slug", "") or ""), "pets": gallery})


@_pet_method("pet.select", slug=True)
def _(rid, params: dict, slug: str) -> dict:
    """Adopt a pet: install (if needed) + activate; writes ``display.pet.*`` to config."""
    from agent.pet import store
    from agent.pet.manifest import ManifestError
    from hermes_cli.pets import _set_active
    try:
        pet = store.install_pet(slug)
    except (store.PetStoreError, ManifestError) as exc:
        return _err(rid, 5031, f"could not adopt '{slug}': {exc}")
    _set_active(slug)
    return _ok(rid, {"ok": True, "slug": slug, "displayName": pet.display_name})


@_pet_method("pet.remove", slug=True)
def _(rid, params: dict, slug: str) -> dict:
    """Uninstall a pet (delete its directory); if it was active, turn the display off."""
    from agent.pet import store
    from hermes_cli.pets import _clear_active_if
    removed = store.remove_pet(slug)
    _pet_config_followup("pet.remove", _clear_active_if, slug)
    return _ok(rid, {"ok": removed, "slug": slug})


def _pet_config_followup(what: str, fn, *args) -> None:
    """Best-effort ``hermes_cli.pets`` active-slug update after a store op that already succeeded."""
    try:
        fn(*args)
    except Exception as exc:  # noqa: BLE001
        logger.debug("%s config update failed: %s", what, exc)


def _b64(data: bytes) -> str:
    import base64
    return base64.standard_b64encode(data).decode("ascii")


@_pet_method("pet.export", slug=True)
def _(rid, params: dict, slug: str) -> dict:
    """Export an installed pet as a re-importable ``.zip`` → ``{ok, filename, zipBase64}``."""
    from agent.pet import store
    filename, data = store.export_pet(slug)
    return _ok(rid, {"ok": True, "filename": filename, "zipBase64": _b64(data)})


@_pet_method("pet.rename", slug=True)
def _(rid, params: dict, slug: str) -> dict:
    """Rename a pet's display name + realign its slug/dir; follows the active slug in config."""
    if not (name := _str_param(params, "name")):
        return _err(rid, 4004, "missing name")
    from agent.pet import store
    if not (new_slug := store.rename_pet(slug, name)):
        return _err(rid, 5031, "pet.rename failed")
    if new_slug != slug:
        from hermes_cli.pets import _rename_active_if
        _pet_config_followup("pet.rename", _rename_active_if, slug, new_slug)
    return _ok(rid, {"ok": True, "slug": new_slug, "displayName": name})


@_pet_method("pet.thumb", slug=True, fail_open=lambda params: {"ok": False, "slug": _str_param(params, "slug")})
def _(rid, params: dict, slug: str) -> dict:
    """Idle-frame PNG data URI for the picker (desktop CSP breaks CDN ``<img>``); ``url``: not-yet-installed."""
    from agent.pet import store
    if not (data := store.thumbnail_png(slug, source_url=str(params.get("url") or ""))):
        return _ok(rid, {"ok": False, "slug": slug})
    return _ok(rid, {"ok": True, "slug": slug, "dataUri": "data:image/png;base64," + _b64(data)})


@_pet_method("pet.disable")
def _(rid, params: dict) -> dict:
    """``display.pet.enabled=false`` from the desktop picker."""
    from hermes_cli.pets import _set_enabled
    _set_enabled(False)
    return _ok(rid, {"ok": True})


@_pet_method("pet.scale")
def _(rid, params: dict) -> dict:
    """Persist ``display.pet.scale`` (clamped to engine bounds) from the desktop slider."""
    from hermes_cli.pets import set_pet_scale
    scale, err = set_pet_scale(params.get("scale"))
    return _err(rid, 4004, err) if err else _ok(rid, {"ok": True, "scale": scale})


@method("pet.cancel")
def _(rid, params: dict) -> dict:
    """Stop an in-flight generate/hatch by token (idempotent; off the pool so it lands mid-generation)."""
    if token := _str_param(params, "token"):
        _pet_cancel_request(token)
    return _ok(rid, {"ok": True})


@_pet_method("pet.generate.status", scoped=False, fail_open={"available": False, "providers": []})
def _(rid, params: dict) -> dict:
    """Whether pet generation is possible: a reference-capable image backend is configured."""
    from agent.pet.generate.imagegen import GenerationError, list_sprite_providers, resolve_provider
    available, providers = True, []
    try:
        resolve_provider(require_references=True)
    except GenerationError:
        available = False
    try:
        providers = list_sprite_providers()
    except Exception as exc:  # noqa: BLE001 - picker is best-effort
        logger.debug("pet provider list failed: %s", exc)
    return _ok(rid, {"available": available, "providers": providers})


def _pet_pick_provider(params: dict, *, require_references: bool):
    """Picker-chosen ``params.provider`` resolved up front (a bad pick fails fast, not mid-fan-out)."""
    from agent.pet.generate.imagegen import resolve_provider
    name = _str_param(params, "provider")
    return resolve_provider(require_references=require_references, prefer=name) if name else None


@_pet_method("pet.generate", scoped=False)
def _(rid, params: dict) -> dict:
    """Candidate base looks for a new pet (draft step; worker pool): ``prompt`` (or a ``referenceImage``
    data URL), ``count`` (≤4), ``style``, ``provider`` → ``{ok, token, drafts:[{index, dataUri}]}``."""
    prompt = _str_param(params, "prompt")
    ref_raw = _str_param(params, "referenceImage")
    if not prompt and not ref_raw:
        return _err(rid, 4004, "missing prompt")
    count = max(1, min(4, _int_param(params, "count", 4) or 4))
    import shutil
    from agent.pet.generate import generate_base_drafts
    from agent.pet.generate.imagegen import GenerationError
    root = _pet_gen_root()
    _pet_gen_sweep(root)
    # Token up front so each draft is staged + streamed the moment it lands.
    token = uuid.uuid4().hex[:12]
    _pet_cancel_arm(token)
    stage = root / token
    stage.mkdir(parents=True, exist_ok=True)
    reference_images = None
    if ref_raw:
        try:
            reference_images = _pet_reference_images_from_data_url(ref_raw, stage)
        except ValueError as exc:
            return _pet_gen_abort(rid, token, 4004, str(exc))
    try:
        sprite = _pet_pick_provider(params, require_references=bool(reference_images))
    except GenerationError as exc:
        return _pet_gen_abort(rid, token, 5031, str(exc))
    out: list[dict] = []
    # Token-only init event so a Stop fired before the first draft can target this run.
    _pet_emit("pet.generate.progress", {"token": token, "count": count}, "pet.generate init")

    def _on_draft(index: int, src) -> None:
        dest = stage / f"draft-{index}.png"
        try:
            shutil.copyfile(src, dest)
            data_uri = _pet_png_data_uri(dest)
        except Exception as exc:  # noqa: BLE001 - skip a bad draft, keep the rest
            logger.debug("pet.generate draft %d failed: %s", index, exc)
            return
        out.append({"index": index, "dataUri": data_uri})
        _pet_emit("pet.generate.progress", {"token": token, "index": index, "dataUri": data_uri, "count": count},
                  "pet.generate progress")
    try:
        generate_base_drafts(prompt or "a pet based on the reference image", n=count,
                             style=_str_param(params, "style", "auto"), reference_images=reference_images,
                             provider=sprite, on_draft=_on_draft, is_cancelled=lambda: _pet_is_cancelled(token))
    except GenerationError as exc:
        return _pet_gen_abort(rid, token, 5031, str(exc))
    cancelled = _pet_is_cancelled(token)
    _pet_cancel_release(token)
    if cancelled or not out:
        return _err(rid, 5031, "generation cancelled" if cancelled else "generation produced no usable drafts")
    return _ok(rid, {"ok": True, "token": token, "drafts": sorted(out, key=lambda d: d["index"])})


@_pet_method("pet.hatch", scoped=False)
def _(rid, params: dict) -> dict:
    """Turn a base draft (``token`` + ``index``) into a full pet — installed but NOT active (``pet.select``
    adopts, ``pet.remove`` discards) → ``{ok, slug, displayName, warnings, pet}``."""
    token, name = _str_param(params, "token"), _str_param(params, "name")
    if not token or not name:
        return _err(rid, 4004, "missing token" if not token else "missing name")
    # Own cancel key: pet.generate may still be releasing `token`. Falls back for old clients.
    cancel_token = _str_param(params, "cancelToken") or token
    from agent.pet import store
    from agent.pet.generate import hatch_pet
    from agent.pet.generate.imagegen import GenerationError
    base = _pet_gen_root() / token / f"draft-{_int_param(params, 'index', 0)}.png"
    if not base.is_file():
        return _err(rid, 4004, "draft expired — generate again")
    try:
        sprite = _pet_pick_provider(params, require_references=True)  # rows always need reference grounding
    except GenerationError as exc:
        return _err(rid, 5031, str(exc))
    _pet_cancel_arm(cancel_token)
    slug = store.unique_slug(name)

    def _on_progress(event: str, detail: str) -> None:
        # Row progress "<state>:<done>:<total>" → "Drawing <state>… (n/total)".
        payload: dict = {"event": event, "detail": detail}
        if event == "row" and detail.count(":") == 2:
            state, done, total = detail.split(":")
            payload = {"event": "row", "state": state, "done": done, "total": total}
        _pet_emit("pet.hatch.progress", payload, "pet.hatch progress")
    try:
        result = hatch_pet(
            base_image=base, slug=slug, display_name=name, description=str(params.get("description") or ""),
            concept=str(params.get("prompt") or name), style=_str_param(params, "style", "auto"), provider=sprite,
            on_progress=_on_progress, is_cancelled=lambda: _pet_is_cancelled(cancel_token))
    except GenerationError as exc:
        return _err(rid, 5031, str(exc))
    finally:
        _pet_cancel_release(cancel_token)
    pet = store.load_pet(result.slug)
    return _ok(rid, {"ok": True, "slug": result.slug, "displayName": result.display_name,
                     "warnings": result.validation.get("warnings", []),
                     "pet": _pet_sprite_payload(pet, scale=_pet_config_scale()) if pet else {}})


# ── billing / subscription ───────────────────────────────────────────
# All fail-open: a logged-out / unreachable portal yields an ``ok`` envelope with a typed
# ``error`` (not a JSON-RPC error) so the TUI maps it to copy. ``billing:manage`` routes
# return error=insufficient_scope on 403, which drives the ``billing.step_up`` device flow.
def _billing_view(name: str, module: str, builder: str, serializer: str, fallback: dict) -> None:
    """Read-only view RPC (no scope required): ``serializer(module.builder())``, ``fallback`` on any error.
    The view module stays a lazy import (startup budget); the serializer is a server global."""
    @method(name)
    def _(rid, params: dict) -> dict:
        try:
            from importlib import import_module
            return _ok(rid, globals()[serializer](getattr(import_module(module), builder)()))
        except Exception:
            return _ok(rid, dict(fallback))


_billing_view("billing.state", "agent.billing_view", "build_billing_state", "_serialize_billing_state",
              {"ok": True, "logged_in": False, "error": "could not load billing state"})
_billing_view("usage.bars", "agent.billing_usage", "build_usage_model", "_serialize_usage_model",  # two-bar $ view
              {"ok": True, "available": False})
_billing_view("subscription.state", "agent.subscription_view", "build_subscription_state",
              "_serialize_subscription_state",
              {"ok": True, "logged_in": False, "error": "could not load subscription state"})


@method("subscription.preview")
def _(rid, params: dict) -> dict:
    """POST /api/billing/subscription/preview → chargeless effect quote. billing:manage."""
    from agent.subscription_view import subscription_change_preview_from_payload
    from hermes_cli.nous_billing import post_subscription_preview
    if not (tier_id := params.get("subscription_type_id")):
        return _billing_invalid(rid, "subscription_type_id is required")
    return _billing_call(rid, lambda: _serialize_subscription_preview(
        subscription_change_preview_from_payload(post_subscription_preview(subscription_type_id=tier_id))))


def _billing_route(name: str, call, *, invalid=None, message: str = "", error: str = "invalid_request",
                   idempotent: bool = False):
    """Portal write route on ``hermes_cli.nous_billing`` (lazy; tests patch its functions): ``invalid(params)``
    → ``_billing_invalid(message, error)``; ``call(nb, params, key)`` performs the request. ``idempotent``
    mints ``idempotency_key`` if absent and echoes it (also on error) so the TUI retries the SAME operation."""
    @method(name)
    def _(rid, params: dict) -> dict:
        import hermes_cli.nous_billing as nb
        if invalid is not None and invalid(params):
            return _billing_invalid(rid, message, error=error)
        key = extra = None
        if idempotent:
            from agent.billing_view import new_idempotency_key
            key = params.get("idempotency_key") or new_idempotency_key()
            extra = {"idempotency_key": key}
        return _billing_call(rid, lambda: call(nb, params, key) | (extra or {}), extra=extra)


# PUT pending-change: schedule a downgrade / same-price change OR a period-end cancellation.
_billing_route("subscription.change", lambda nb, p, _k: _billing_pending_change(nb.put_subscription_pending_change(
    subscription_type_id=p.get("subscription_type_id"), cancel=bool(p.get("cancel")))),
    invalid=lambda p: not p.get("cancel") and not p.get("subscription_type_id"),
    message="subscription_type_id or cancel is required")
# DELETE pending-change: clear a scheduled downgrade / cancellation (re-enables recurring spend).
_billing_route("subscription.resume",
               lambda nb, p, _k: _billing_pending_change(nb.delete_subscription_pending_change()))
# The money route (prorate + charge + flip plan). SCA / decline → status requires_action / payment_failed +
# recovery_url.
_billing_route("subscription.upgrade", lambda nb, p, key: _billing_pick(
    nb.post_subscription_upgrade(subscription_type_id=p.get("subscription_type_id"), idempotency_key=key),
    status="status", target_tier_name="targetTierName", recovery_url="recoveryUrl", reason="reason"),
    invalid=lambda p: not p.get("subscription_type_id"), message="subscription_type_id is required", idempotent=True)
# POST /api/billing/charge → {ok, charge_id, idempotency_key}.
_billing_route("billing.charge", lambda nb, p, key: _billing_pick(
    nb.post_charge(amount_usd=p.get("amount_usd"), idempotency_key=key), charge_id="chargeId"),
    invalid=lambda p: p.get("amount_usd") is None, message="amount_usd is required", idempotent=True)
# GET /api/billing/charge/{id} — a single status read; the caller drives the poll cadence.
_billing_route("billing.charge_status", lambda nb, p, _k: _billing_pick(
    nb.get_charge_status(p.get("charge_id")), status="status", amount_usd="amountUsd", settled_at="settledAt",
    reason="reason"), invalid=lambda p: not p.get("charge_id"), message="charge_id is required",
    error="invalid_charge_id")


def _auto_reload(nb, p: dict, _key) -> dict:
    """PATCH /api/billing/auto-top-up. params: {enabled, threshold, top_up_amount}."""
    nb.patch_auto_top_up(enabled=bool(p.get("enabled")), threshold=p.get("threshold"),
                         top_up_amount=p.get("top_up_amount"))
    return {"ok": True}


_billing_route("billing.auto_reload", _auto_reload, message="threshold and top_up_amount are required",
               invalid=lambda p: p.get("threshold") is None or p.get("top_up_amount") is None)


@method("billing.step_up")
def _(rid, params: dict) -> dict:
    """billing:manage step-up device flow → {ok, granted} (false when the server downscopes). Pooled (blocks
    for minutes); URL/code reach the TUI via ``billing.step_up.verification`` (stdout is the RPC pipe) and the
    browser opens TUI-side, never via the gateway's headless webbrowser.open."""
    sid = params.get("session_id") or ""

    def call():
        from hermes_cli.auth import step_up_nous_billing_scope
        granted = step_up_nous_billing_scope(
            open_browser=False,
            on_verification=lambda url, code: _emit(
                "billing.step_up.verification", sid, {"verification_url": url, "user_code": code}))
        return {"ok": True, "granted": bool(granted)}
    return _billing_call(rid, call, extra={"granted": False})


# ── session status / history / undo / compress ───────────────────────
def _status_row(session: dict, params: dict, key: str) -> dict:
    """Stored row for ``key``: the live session's bound profile db first, else params.profile / launch."""
    if not key:
        return {}
    with _session_db(session) as db:
        if db is not None:
            return _try_get_session(db, key)
        with _profile_db(params) as db2:
            return _try_get_session(db2, key) if db2 else {}


def _try_get_session(db, key: str) -> dict:
    with contextlib.suppress(Exception):
        return db.get_session(key) or {}
    return {}


def _status_dt(value, fallback=None):
    if value:
        with contextlib.suppress(Exception):
            return datetime.fromtimestamp(float(value))
    return fallback or datetime.now()


@_session_method("session.status")
def _(rid, params: dict, session: dict) -> dict:
    from hermes_constants import display_hermes_home
    key = session.get("session_key") or params.get("session_id") or ""
    agent = session.get("agent")
    meta = _status_row(session, params, key)
    created = _status_dt(meta.get("started_at"))
    updated = next((_status_dt(meta[f], created) for f in ("updated_at", "last_updated_at", "last_activity_at")
                    if meta.get(f)), created)
    mirror = _metadata_mirror(session)
    provider = getattr(agent, "provider", None) or mirror.get("provider") or "unknown"
    model = getattr(agent, "model", None) or mirror.get("model") or "(unknown)"
    project = _project_info_for_cwd(_display_session_cwd(session))
    title = (meta.get("title") or "").strip()
    lines = [
        "Hermes TUI Status", "", f"Session ID: {key}", f"Path: {display_hermes_home()}",
        *([f"Project: {project['name']}"] if project else []), *([f"Title: {title}"] if title else []),
        f"Model: {model} ({provider})", f"Created: {created.strftime('%Y-%m-%d %H:%M')}",
        f"Last Activity: {updated.strftime('%Y-%m-%d %H:%M')}",
        f"Tokens: {int(_session_usage_snapshot(session).get('total') or 0):,}",
        f"Agent Running: {'Yes' if session.get('running') else 'No'}"]
    return _ok(rid, {"output": "\n".join(lines)})


@_session_method("session.history")
def _(rid, params: dict, session: dict) -> dict:
    history = list(session.get("history", []))
    if session.get("session_key"):
        with _session_db(session) as db:
            if db is not None:
                # include_row_ids: the durable row id is how clients address a persisted turn (reactions,
                # truncation targets); _history_to_messages forwards it.
                with contextlib.suppress(Exception):
                    # The projection in _history_to_messages only forwards row_id when the row carries a
                    # stamp, so an unstamped read here silently strips the one durable address clients can
                    # use. See #87059.
                    history = db.get_messages_as_conversation(
                        session["session_key"], include_ancestors=True, include_row_ids=True)
    return _ok(rid, {"count": len(history), "messages": _history_to_messages(history)})


@_session_method("session.undo", live=True)
def _(rid, params: dict, session: dict) -> dict:
    # Under a running turn the post-run write would clobber the undo — /interrupt first.
    busy = _err(rid, 4009, "session busy — /interrupt the current turn before /undo")
    if session.get("running"):
        return busy
    removed = 0
    with session["history_lock"]:
        if session.get("running"):
            return busy
        history = _history_without_ephemeral_scaffolding(session.get("history", []))
        # Truncate from the last *real* user turn (not a timeline marker / compaction handoff).
        from agent.context_compressor import user_originated_turn_view
        if user_turns := sum(1 for message in history if user_originated_turn_view(message) is not None):
            try:
                removed = _rewind_active_session_history(session, user_turns - 1)[2]
            except Exception as exc:
                return _err(rid, 5008, f"undo: {exc}")
    return _ok(rid, {"removed": removed})


def _compute_host_ack_error(rid, ack: dict, code: int, default: str):
    """``_err`` for a ``control.error``/``error`` ack, else None."""
    if ack.get("type") in {"control.error", "error"}:
        return _err(rid, code, str(ack.get("message") or default))
    return None


def _save_via_compute_host(rid, params: dict) -> dict:
    """``session.save`` for a turn-isolated session: the host owns the transcript file."""
    try:
        ack = _send_compute_host_control(str(params.get("session_id") or ""), route_name="session.save", wait=True)
    except Exception as exc:
        return _err(rid, 5011, f"compute-host session save failed: {exc}")
    if (resp := _compute_host_ack_error(rid, ack, 5011, "compute-host session save failed")) is not None:
        return resp
    if not isinstance(result := ack.get("result"), dict):
        return _err(rid, 5011, "compute-host session save returned an invalid response")
    return _ok(rid, result)


def _compress_via_compute_host(rid, params: dict, session: dict) -> dict:
    """``session.compress`` for a turn-isolated session: forward ``/compress`` to the host."""
    sid = str(params.get("session_id") or "")
    focus_topic = _str_param(params, "focus_topic")

    def _on_late_ack(late: dict, _sid=sid) -> None:
        _adopt_late_compute_host_compress_ack(_sid, session, late, route_name="session.compress")
    try:
        ack = _send_compute_host_control(
            sid, route_name="session.compress", command="/compress" + (f" {focus_topic}" if focus_topic else ""),
            # compression.context_total_ceiling_seconds: the host legitimately runs that long.
            wait=True, timeout=_compute_host_compress_wait_seconds(), on_late_ack=_on_late_ack)
    except queue.Empty:
        # Waiter gave up, host still compressing; the late-ack handler adopts the rotated session when it
        # lands. Not an error (a 5019 here reported timeouts that later succeeded).
        return _ok(rid, {"status": "pending", "turn_isolation": True,
                         "message": ("compression still running in the background; "
                                     "the transcript will refresh when it finishes")})
    except Exception as exc:
        return _err(rid, 5019, f"compute-host compress failed: {exc}")
    if (resp := _compute_host_ack_error(rid, ack, 4009, "compute-host compress failed")) is not None:
        return resp
    _apply_compute_host_metadata_mirror(session, ack)
    if isinstance(host_result := ack.get("result"), dict):
        # Host-owned result verbatim (carries `status: aborted` / `summary.aborted`).
        return _ok(rid, {**host_result, "turn_isolation": True})
    host_info = ack.get("session_info") if isinstance(ack.get("session_info"), dict) else {}
    return _ok(rid, {
        "status": "compressed", "turn_isolation": True,
        # `messages` goes top-level for the transcript replacement; don't duplicate it in the ack.
        "host_ack": {key: value for key, value in ack.items() if key != "messages"}, "info": host_info,
        "messages": _history_to_messages(ack.get("messages")) if isinstance(ack.get("messages"), list) else [],
        "usage": host_info.get("usage") if isinstance(host_info.get("usage"), dict) else {}})


def _compress_live(rid, sid: str, session: dict, focus_topic: str) -> dict:
    """In-process ``session.compress``: status pinned "compressing", then the before/after summary + messages."""
    from agent.conversation_compression import finalize_context_engine_compression_notification
    from agent.manual_compression_feedback import summarize_manual_compression
    from agent.model_metadata import estimate_request_tokens_rough
    with session["history_lock"]:
        before_messages = list(session.get("history", []))
        history_version = int(session.get("history_version", 0))
    before_count = len(before_messages)
    _agent = session["agent"]
    _sys_prompt = getattr(_agent, "_cached_system_prompt", "") or ""
    _tools = getattr(_agent, "tools", None) or None

    def _tokens(msgs) -> int:
        # Re-reads prompt + tools each call: _compress_context may have rebuilt the system prompt.
        sys_prompt = getattr(_agent, "_cached_system_prompt", "") or _sys_prompt
        tools = getattr(_agent, "tools", None) or _tools
        return estimate_request_tokens_rough(msgs, system_prompt=sys_prompt, tools=tools) if msgs else 0
    before_tokens = _tokens(before_messages)
    if before_count >= 4:
        focus_suffix = f', focus: "{focus_topic}"' if focus_topic else ""
        _status_update(sid, "compressing",
                       f"⠋ compressing {before_count} messages (~{before_tokens:,} tok){focus_suffix}…")
    try:
        removed, usage = _compress_session_history(
            session, focus_topic, approx_tokens=before_tokens, before_messages=before_messages,
            history_version=history_version)
        with session["history_lock"]:
            messages = list(session.get("history", []))
        after_tokens = _tokens(messages)
        agent = session["agent"]
        _sync_session_key_after_compress(sid, session)
        summary = summarize_manual_compression(before_messages, messages, before_tokens, after_tokens,
                                               compression_state=getattr(agent, "context_compressor", None))
        info = _session_info(agent, session)
        _emit("session.info", sid, info)
        finalize_context_engine_compression_notification(agent, committed=True)
        return _ok(rid, {
            "status": "aborted" if summary["aborted"] else "compressed", "removed": removed,
            "before_messages": before_count, "after_messages": len(messages),
            "before_tokens": before_tokens, "after_tokens": after_tokens, "summary": summary,
            "usage": usage, "info": info, "messages": _history_to_messages(messages)})
    finally:
        # Always clear the pinned compressing status (success, no-op, or raise).
        _status_update(sid, "ready")


@method("session.compress")
def _(rid, params: dict) -> dict:
    session, err = _sess_nowait(params, rid)
    if err:
        return err
    if _session_uses_compute_host(session):
        return _compress_via_compute_host(rid, params, session)
    session, err = _sess(params, rid)
    if err:
        return err
    if session.get("running"):
        return _err(rid, 4009, "session busy — /interrupt the current turn before /compress")
    sid = params.get("session_id", "")
    try:
        return _compress_live(rid, sid, session, _str_param(params, "focus_topic"))
    except CompressionLockHeld as e:
        _status_update(sid, "ready")
        from agent.manual_compression_feedback import describe_compression_lock_skip
        return _ok(rid, {"compressed": False, "lock_held": True, "message": describe_compression_lock_skip(e.holder)})
    except Exception as e:
        from agent.conversation_compression import finalize_context_engine_compression_notification
        finalize_context_engine_compression_notification(session["agent"], committed=False)
        return _err(rid, 5005, str(e))


# ── interrupt / steer / redirect ─────────────────────────────────────
@method("session.interrupt")
def _(rid, params: dict) -> dict:
    _tts_stream_stop()  # keypress barge-in also silences streaming TTS (voice is process-global)
    session, err = _sess_nowait(params, rid)
    if err:
        return err
    if expected := _str_param(params, "expected_hosted_task_id"):
        with session["history_lock"]:
            task = session.get("_hosted_room_task")
            if not (session.get("running") and isinstance(task, dict) and task.get("task_id") == expected):
                return _ok(rid, {"status": "not_interrupted", "interrupted": False})
    sid = str(params.get("session_id") or "")
    if _session_uses_compute_host(session):
        try:
            _interrupt_session_turn(sid, session, request_id=f"interrupt-{rid}")
        except Exception as exc:
            return _err(rid, 5019, f"compute-host interrupt failed: {exc}")
        return _ok(rid, {"status": "interrupted", "turn_isolation": True})
    session, err = _sess(params, rid)
    if err:
        return err
    _interrupt_session_turn(sid, session)
    # Retire the crash-recovery marker NOW: until the run thread's finally, a backend exit looks like a crash
    # and session.resume auto-continues the turn the user just stopped (the extra key covers compression
    # rotating session_key mid-turn).
    with session["history_lock"]:
        active_marker_key = str(session.pop("_active_turn_marker_key", "") or "")
    _retire_turn_marker(session, active_marker_key)
    return _ok(rid, {"status": "interrupted"})


def _apply_correction(rid, session: dict, verb: str, text: str, accepted_status: str) -> dict:
    """``agent.<verb>(text)``; on acceptance record it on the live turn (mid-turn resume rebuilds the bubble)
    and purge queued self-copies so post-turn drain cannot re-fire the old prompt."""
    try:
        accepted = getattr(session["agent"], verb)(text)
    except Exception as exc:
        return _err(rid, 5000, f"{verb} failed: {exc}")
    if accepted:
        with session["history_lock"]:
            _record_inflight_correction(session, text)
            # #84417: steer does not cancel the live original, but a server queue self-copy of that original
            # must still not re-fire after settle (same class as redirect).
            # #84417: purge server-queue self-duplicates of the live original so post-turn drain cannot
            # restart the pre-correction prompt.
            _drop_queued_duplicates_of_inflight_user(session)
            session["last_active"] = time.time()
    return _ok(rid, {"status": accepted_status if accepted else "rejected", "text": text})


def _correction_method(name: str, verb: str, accepted_status: str, supported, unsupported: str):
    """steer/redirect RPC: ``params.text`` (4002, checked before the session) into a live session;
    ``supported(agent)`` gates 4010."""
    @method(name)
    def _(rid, params: dict) -> dict:
        if not (text := (params.get("text") or "").strip()):
            return _err(rid, 4002, "text is required")
        session, err = _sess_nowait(params, rid)
        if err:
            return err
        agent = session.get("agent")
        # Redirect during the turn-build window (running=True, agent None): queue for the next turn instead of
        # a misleading 4010 the client swallows into a lost follow-up.
        if verb == "redirect" and agent is None and session.get("running"):
            _enqueue_prompt(session, text, current_transport() or _stdio_transport)
            session["last_active"] = time.time()
            return _ok(rid, {"status": "queued", "text": text})
        if not supported(agent):
            return _err(rid, 4010, unsupported)
        return _apply_correction(rid, session, verb, text, accepted_status)


# Inject text into the next tool result without interrupting (AIAgent.steer(): no new user turn, no role
# alternation violation).
_correction_method("session.steer", "steer", "queued", lambda agent: hasattr(agent, "steer"),
                   "agent does not support steer")
# Redirect the active model turn while preserving valid work/context.
_correction_method("session.redirect", "redirect", "redirected",
                   lambda agent: getattr(agent, "_supports_active_turn_redirect", False) is True
                   and hasattr(agent, "redirect"), "agent does not support active-turn redirect")


# ── delegation / spawn trees ─────────────────────────────────────────
@method("delegation.status")
def _(rid, params: dict) -> dict:
    from tools import delegate_tool as dt
    return _ok(rid, {"active": dt.list_active_subagents(), "paused": dt.is_spawn_paused(),
                     "max_spawn_depth": dt._get_max_spawn_depth(),
                     "max_concurrent_children": dt._get_max_concurrent_children()})


@method("delegation.pause")
def _(rid, params: dict) -> dict:
    from tools.delegate_tool import set_spawn_paused
    return _ok(rid, {"paused": set_spawn_paused(bool(params.get("paused", True)))})


@method("subagent.interrupt")
def _(rid, params: dict) -> dict:
    from tools.delegate_tool import interrupt_subagent
    if not (subagent_id := _str_param(params, "subagent_id")):
        return _err(rid, 4000, "subagent_id required")
    return _ok(rid, {"found": interrupt_subagent(subagent_id), "subagent_id": subagent_id})


@method("subagent.steer")
def _(rid, params: dict) -> dict:
    """Queue steering text into a live delegated child (the in-flight tool call is never cut). "queued"
    is not "delivered": a child past its final tool batch surfaces ``missed_steer`` on the parent entry."""
    from tools.delegate_tool import steer_subagent
    if not (subagent_id := _str_param(params, "subagent_id")):
        return _err(rid, 4000, "subagent_id required")
    if not (text := (params.get("text") or "").strip()):
        return _err(rid, 4002, "text is required")
    if (err := _sess_nowait(params, rid)[1]) is not None:
        return err
    owner_id = _str_param(params, "session_id")
    transport, owner = _current_session_steer_authority(owner_id)
    queued = transport is not None and owner is not None and steer_subagent(
        subagent_id, text, owner_session_id=owner_id, owner_transport=transport, owner_session_record=owner)
    return _ok(rid, {"status": "queued" if queued else "rejected", "subagent_id": subagent_id, "text": text})


@method("spawn_tree.save")
def _(rid, params: dict) -> dict:
    session_id = _str_param(params, "session_id")
    subagents = params.get("subagents") or []
    if not isinstance(subagents, list) or not subagents:
        return _err(rid, 4000, "subagents list required")
    started_at, label = params.get("started_at"), str(params.get("label") or "")
    finished_at = float(params.get("finished_at") or time.time())
    d = _spawn_tree_session_dir(session_id or "default")
    path = d / f"{datetime.utcfromtimestamp(finished_at).strftime('%Y%m%dT%H%M%S')}.json"
    meta = {"session_id": session_id, "started_at": float(started_at) if started_at else None,
            "finished_at": finished_at, "label": label}
    try:
        path.write_text(json.dumps({**meta, "subagents": subagents}, ensure_ascii=False), encoding="utf-8")
    except OSError as exc:
        return _err(rid, 5000, f"spawn_tree.save failed: {exc}")
    _append_spawn_tree_index(d, {"path": str(path), **meta, "count": len(subagents)})
    return _ok(rid, {"path": str(path), "session_id": session_id})


def _legacy_spawn_tree_entry(p, session_dir_name: str) -> dict | None:
    """Index-shaped entry for a pre-index snapshot file (None when unreadable)."""
    try:
        stat = p.stat()
    except OSError:
        return None
    raw = {}
    with contextlib.suppress(Exception):
        raw = json.loads(p.read_text(encoding="utf-8"))
    subagents = raw.get("subagents") or []
    return {"path": str(p), "session_id": raw.get("session_id") or session_dir_name,
            "finished_at": raw.get("finished_at") or stat.st_mtime, "started_at": raw.get("started_at"),
            "label": raw.get("label") or "", "count": len(subagents) if isinstance(subagents, list) else 0}


@method("spawn_tree.list")
def _(rid, params: dict) -> dict:
    session_id = _str_param(params, "session_id")
    if bool(params.get("cross_session")):
        roots = [p for p in _spawn_trees_root().iterdir() if p.is_dir()]
    else:
        roots = [_spawn_tree_session_dir(session_id or "default")]
    entries: list[dict] = []
    for d in roots:
        if indexed := _read_spawn_tree_index(d):
            # Skip index entries whose snapshot file was manually deleted.
            entries.extend(e for e in indexed if (p := e.get("path")) and Path(p).exists())
        else:  # Legacy (pre-index) sessions: full scan, once per session until the next save.
            entries.extend(
                entry for p in d.glob("*.json")
                if p.name != _SPAWN_TREE_INDEX and (entry := _legacy_spawn_tree_entry(p, d.name)) is not None)
    entries.sort(key=lambda e: e.get("finished_at") or 0, reverse=True)
    return _ok(rid, {"entries": entries[:int(params.get("limit") or 50)]})


@method("spawn_tree.load")
def _(rid, params: dict) -> dict:
    if not (raw_path := _str_param(params, "path")):
        return _err(rid, 4000, "path required")
    try:
        (resolved := Path(raw_path).resolve()).relative_to(_spawn_trees_root().resolve())
    except (ValueError, OSError) as exc:
        return _err(rid, 4030, f"path outside spawn-trees root: {exc}")
    try:
        payload = json.loads(resolved.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return _err(rid, 5000, f"spawn_tree.load failed: {exc}")
    return _ok(rid, payload)


# ── terminal / event replay ──────────────────────────────────────────
@_session_method("terminal.resize")
def _(rid, params: dict, session: dict) -> dict:
    session["cols"] = cols = int(params.get("cols", 80))
    return _ok(rid, {"cols": cols})


@method("session.events.since")
def _(rid, params: dict) -> dict:
    """Replay events after ``last_seen`` (WS reconnect); ``truncated`` past the ring window → client refetches."""
    sid = str(params.get("session_id") or "")
    try:
        last_seen = int(params.get("last_seen", 0))
    except (TypeError, ValueError):
        return _err(rid, -32602, "invalid params: last_seen must be an integer")
    from tui_gateway import event_replay as er
    frames = er.events_since(sid, last_seen)
    # ``epoch``: in-process seq — clients reset watermarks when this differs from gateway.ready's.
    return _ok(rid, {"events": frames, "latest_seq": er.latest_seq(sid), "truncated": er.is_truncated(sid, last_seen),
                     "count": len(frames), "epoch": er.replay_epoch()})


@method("session.events.stats")
def _(rid, params: dict) -> dict:
    """Replay-buffer telemetry (ops/debug)."""
    from tui_gateway import event_replay
    return _ok(rid, event_replay.replay_stats())


def register(server) -> None:
    """Publish this module's helpers onto ``server`` (rebound to its globals) and install handlers."""
    bind_module(globals(), server, skip=("_",))
