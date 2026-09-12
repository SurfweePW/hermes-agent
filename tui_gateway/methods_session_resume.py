"""Session resume handler and its cold, eager, deferred, and live-reuse paths.

Bodies are rebound onto server.py globals at install time so server-owned state and
monkeypatch seams retain the same behavior.
"""

import contextlib

from .method_ctx import HandlerRegistry, bind_module

_registry = HandlerRegistry()
method = _registry.method


# ── session.resume ───────────────────────────────────────────────────
class _Resume:
    """Per-call ``session.resume`` state. ``owns_db``: the DEDICATED profile handle is ours
    to close (handler ``finally``) until handed to the hydration worker or the agent."""

    def __init__(self, rid, params: dict, target: str) -> None:
        self.rid, self.params, self.target = rid, params, target
        self.db, self.owns_db, self.found, self.profile_resume_cwd = None, False, None, ""
        self.creation_claim: object | None = None
        self.cols = _int_param(params, "cols", 80)
        # ``profile`` (app-global remote mode): resume from another local profile's state.db.
        self.profile = (params.get("profile") or "").strip() or None
        self.profile_home = _profile_home(self.profile)
        self.lazy, self.defer_history = _flag(params, "lazy"), _flag(params, "defer_history")
        # Desktop hydrates over REST; suppress the duplicate WS copy only when asked.
        self.omit_messages, self.eager_build = _flag(params, "omit_messages"), _flag(params, "eager_build")

    def mint(self, prompts: bool = True) -> tuple:
        """``(runtime sid, source, cwd)`` for the live record this resume registers (+ gateway prompts on)."""
        ids = _new_runtime_ids(self.params)
        if prompts:
            _enable_gateway_prompts()
        return *ids, self.profile_resume_cwd or _default_session_cwd()

    def record(self, source: str, cwd: str, history: list, overrides: dict | None = None, **extra) -> dict:
        """``_deferred_session_record`` with this resume's common fields (lease claimed lazily on turn 1);
        ``overrides`` restores the stored model/provider/reasoning/tier so the deferred build matches eager."""
        if overrides is not None:
            extra.update(model_override=overrides.get("model_override"), resume_runtime_overrides=overrides or None)
        record = _deferred_session_record(
            self.target, cols=self.cols, cwd=cwd, history=history, lease=None, source=source,
            close_on_disconnect=_flag(self.params, "close_on_disconnect"),
            profile_home=self.profile_home, explicit_cwd=bool(self.profile_resume_cwd), **extra)
        if self.creation_claim is not None and not _install_reconstructed_creation_fence(
            record, self.creation_claim
        ):
            raise RuntimeError("pending creation fence is unavailable")
        return record

    def claim(self, sid: str, record: dict) -> dict | None:
        """Register ``record`` live under the resume lock, or reuse a concurrent winner's session."""
        live = _claim_or_reuse_live(sid, self.target, record, None)
        return None if live is None else _resume_reuse_live(self, *live)

    def restore(self):
        """``(sanitized model history, display history, raw history)`` for a cold/eager resume."""
        raw, display = self.read_history()
        return sanitize_replay_history(raw), display, raw

    def info(self, cwd: str, overrides: dict) -> dict:
        return _lazy_resume_info(cwd, model=(overrides.get("model_override") or {}).get("model") or "",
                                 provider=overrides.get("provider_override") or "", profile=self.profile)

    def child_history(self, repair: bool) -> list:
        """The child's OWN conversation (no ancestors), row ids included."""
        return self.db.get_messages_as_conversation(self.target, repair_alternation=repair, include_row_ids=True)

    def messages(self, display: list) -> list:
        return [] if self.omit_messages else _history_to_messages(display)

    def read_history(self) -> tuple:
        """One lineage SELECT, two projections: model-fed copy alternation-repaired (healed once
        here instead of every turn's pre-request repair), display copy verbatim."""
        self.db.reopen_session(self.target)
        if self.omit_messages:
            return self.child_history(repair=True), []
        return self.db.get_resume_conversations(self.target)

    def display_prefix(self) -> list:
        """Ancestor display rows (model-fed history drops a dangling tool-call tail — display keeps it)."""
        return [] if self.omit_messages else self.db.get_ancestor_display_prefix(self.target)


def _find_live_unpersisted(needle: str, home) -> str:
    """Runtime sid of a live, not-yet-persisted session matched by stored key or pending title."""
    want_home = str(home) if home is not None else None
    return next((
        live_sid for live_sid, record in list(_sessions.items())
        if isinstance(record, dict) and (record.get("profile_home") or None) == want_home
        and (str(record.get("session_key") or "") == needle or (record.get("pending_title") or "") == needle)), "")


def _resume_live_unpersisted(ctx: _Resume, live_sid: str, live: dict) -> dict:
    """Reattach a LIVE lazy session with no state.db row yet (every fresh Bot Chat; a 404 here killed messaging
    for never-spoken bots). Rebind the transport and cancel the armed orphan-reap Timer (a WS drop may have
    sentinel-parked the record) or it fires against this client."""
    if not _provisional_creation_access_allowed(live):
        return _err(ctx.rid, 4090, "session creation is still pending")
    if ctx.owns_db:
        _release_db(ctx.db)
    with _session_resume_lock:
        if (refusal := _reattach_refusal(ctx.rid, live_sid, live)) is not None:
            return refusal
        live["last_active"] = time.time()
        if (transport := current_transport()) is not None:
            with live.setdefault("history_lock", threading.Lock()):
                _rebind_live_transport(live_sid, live, transport)
        else:
            _cancel_ws_orphan_reap(live_sid)
    history = live.get("history") or []
    return _ok(ctx.rid, _attach_todo_state({
        "session_id": live_sid, "stored_session_id": str(live.get("session_key") or ""),
        "message_count": len(history), "messages": ctx.messages(history),
        "info": {"model": _resolve_model(), "lazy": True, "profile_name": ctx.profile or ""}}, live))


def _resume_adopt_stranded(ctx: _Resume) -> None:
    """Adopt a lineage stranded in the DEFAULT store (older builds ran a profile bot's turns on the focused
    tile's backend; unadopted it 4001s forever). Exact-id ONLY — bot titles collide; never a retired donor."""
    try:
        # Stranded-session adoption (#93296 follow-up): before session RPCs routed by their TARGET session,
        # a profile bot's turns executed on the focused tile's backend — usually default — so its canonical
        # session accumulated in the DEFAULT profile's state.db. Now that routing is correct, this
        # profile-scoped resume is the first place the fix and the stranded data collide: the id exists in
        # the default store but not here, and without adoption the same chat 4001s forever (the fix made it
        # unreachable instead of misrouted). Adopt the full lineage from the default store into this
        # profile's db, then retry the lookup. Only profile-scoped resumes reach here (owns_db); unknown ids
        # in the default store still 4007 exactly as before.
        default_db = _get_db()
        donor_row = default_db.get_session(ctx.target) if default_db is not None else None
        if not donor_row or donor_row.get("archived"):
            return
        adoption = ctx.db.adopt_session_lineage_from(default_db, donor_row["id"])
        if adoption.get("adopted"):
            logger.info("adopted stranded session %s (lineage of %s segment(s)) from default store into profile %s",
                        donor_row["id"],
                        len(adoption.get("imported_ids") or []) + len(adoption.get("skipped_ids") or []),
                        ctx.profile or "?")
            ctx.found = ctx.db.get_session(donor_row["id"])
            if ctx.found:
                ctx.target = ctx.found["id"]
    except Exception:
        logger.exception("stranded-session adoption failed for %s", ctx.target)


def _resume_locate(ctx: _Resume) -> dict | None:
    """Resolve ``ctx.target`` to a stored row (``ctx.found``); a dict is an early response."""
    ctx.found = ctx.db.get_session(ctx.target)
    if ctx.found:
        return None
    ctx.found = ctx.db.get_session_by_title(ctx.target)
    if ctx.found:
        ctx.target = ctx.found["id"]
        return None
    if ctx.lazy and _child_run_active(ctx.target):
        # Fresh subagent watch window: `subagent.start` relays BEFORE the child's first DB flush. Proceed lazily
        # with empty history — the live mirror streams the turn and the row exists by upgrade time.
        ctx.found = {}
        return None
    live_sid = _find_live_unpersisted(ctx.target, ctx.profile_home)
    if (live := _sessions.get(live_sid) if live_sid else None) is not None:
        return _resume_live_unpersisted(ctx, live_sid, live)
    if ctx.owns_db:
        _resume_adopt_stranded(ctx)
    return None if ctx.found else _err(ctx.rid, 4007, "session not found")


def _resume_follow_tip(ctx: _Resume) -> None:
    """Rebind a rotated-out parent id to its compression tip (resuming the original reloads the parent
    transcript and loses the post-compression reply). Skipped for lazy watch windows (exact child); Bot Chat
    follows proven compression edges only."""
    if not ctx.found or ctx.lazy:
        return
    tip = ctx.target
    with contextlib.suppress(Exception):
        from tools.bot_mode_probe import BOT_CHAT_TITLE
        if (ctx.found.get("title") or "").strip() == BOT_CHAT_TITLE:
            tip = ctx.db.get_compression_tip(ctx.target) or ctx.target
        else:
            tip = ctx.db.resolve_resume_session_id(ctx.target)
    if tip and tip != ctx.target:
        ctx.target = tip
        ctx.found = ctx.db.get_session(tip) or ctx.found


def _resume_guard(ctx: _Resume) -> dict | None:
    """Refuse a runaway transcript before any history read (sessions.max_resume_messages). Deferred /
    omit_messages / lazy paths load the TIP segment only and are guarded tip-only (a lineage count rejected
    exactly the well-compressed chats). Metadata fallback for lightweight adaptor DBs; fails OPEN on errors."""
    from hermes_state import SessionResumeTooLargeError, resolved_max_resume_messages
    tip_only = ctx.lazy or ctx.omit_messages or (ctx.defer_history and not ctx.eager_build)
    try:
        if callable(safety_check := getattr(ctx.db, "assert_resume_safe", None)):
            safety_check(ctx.target, **({"tip_only": True} if tip_only else {}))
        elif (limit := resolved_max_resume_messages()) and (n := int(ctx.found.get("message_count") or 0)) > limit:
            raise SessionResumeTooLargeError(n, limit)
    except SessionResumeTooLargeError as exc:
        return _err(ctx.rid, 4130, str(exc))
    except Exception as exc:
        logger.warning("resume safety check failed for %s (proceeding without guard): %s", ctx.target, exc)
    return None


def _resume_reuse_live(ctx: _Resume, sid: str, session: dict) -> dict:
    """Reattach an already-live session under the resume lock (held across the client-gone check,
    transport rebind and reap cancel so grace expiry is atomic)."""
    with _session_resume_lock:
        return _resume_reuse_live_locked(ctx, sid, session)


def _resume_reuse_live_locked(ctx: _Resume, sid: str, session: dict) -> dict:
    """Reuse with _session_resume_lock already held (including the eager double-check)."""
    if not _provisional_creation_access_allowed(session):
        return _err(ctx.rid, 4090, "session creation is still pending")
    if (refusal := _reattach_refusal(ctx.rid, sid, session)) is not None:
        return refusal
    _cancel_ws_orphan_reap(sid)  # unconditionally: the fast path must never race the reap Timer
    payload = _live_session_payload(sid, session, cols=ctx.cols, touch=True, omit_messages=ctx.omit_messages,
                                    transport=current_transport() or _stdio_transport)
    payload["resumed"] = ctx.target
    if ctx.defer_history:
        payload.update(messages=[], hydrating=bool(session.get("resume_hydrating")),
                       message_count=int(session.get("resume_message_count") or payload["message_count"]))
    # A lazy watch session never owns a run loop — overlay the child-run registry.
    if session.get("agent") is None and _child_run_active(ctx.target):
        payload.update(running=True, status="streaming")
    return _ok(ctx.rid, payload)


def _resume_response(
    ctx: _Resume, sid: str, record: dict, *, info: dict, display: list = (), count_source: list | None = None,
    messages: list | None = None, message_count: int | None = None, running: bool = False,
    status: str = "idle", hydrating: bool | None = None, started_at=None, auto_continue=None,
) -> dict:
    """Common resume payload; omit_messages counts ``count_source`` (client still learns the stored size)."""
    if messages is None:
        messages = ctx.messages(display)
    if message_count is None:
        message_count = len(count_source) if ctx.omit_messages else len(messages)
    payload = {"session_id": sid, "resumed": ctx.target, "message_count": message_count, "messages": messages,
               **({"messages_omitted": ctx.omit_messages} if hydrating is None else {"hydrating": hydrating}),
               "info": info, "inflight": None, "running": running, "session_key": ctx.target,
               "started_at": record["created_at"] if started_at is None else started_at, "status": status}
    if auto_continue is not None:
        payload["auto_continue"] = auto_continue
    return _ok(ctx.rid, _attach_todo_state(payload, record))


def _resume_lazy(ctx: _Resume) -> dict:
    """Lazy/watch resume (desktop subagent windows): a live session WITHOUT an agent — the child runs
    inside the parent's turn, so the window needs stored history + a transport; prompt.submit upgrades it."""
    sid, source, cwd = ctx.mint(prompts=False)
    try:
        ctx.db.reopen_session(ctx.target)
        # repair_alternation heals a durable ``user;user`` once here.
        history = ctx.child_history(repair=True)
    except Exception as e:
        return _err(ctx.rid, 5000, f"resume failed: {e}")
    record = ctx.record(source, cwd, history, lazy=True, todo_state=_todo_state_from_history(history))
    if (reused := ctx.claim(sid, record)) is not None:
        return reused
    # A child mid-run emits no session events — liveness comes from the relay registry.
    running = _child_run_active(ctx.target)
    # Display uses the VERBATIM child-only projection so model-invisible rows survive; repaired ``history``
    # still feeds live replay.
    display = history
    try:
        display = ctx.child_history(repair=False)
    except Exception:
        logger.debug("child-watch display projection read failed", exc_info=True)
    return _resume_response(ctx, sid, record, info=_lazy_resume_info(cwd, profile=ctx.profile), display=display,
                            count_source=display, running=running, status="streaming" if running else "idle")


def _resume_deferred(ctx: _Resume) -> dict:
    """Bounded ack; the transcript hydrates in the background (the ONE history read) and pages over REST."""
    sid, source, cwd = ctx.mint()
    overrides = _stored_session_runtime_overrides(ctx.found)
    record = ctx.record(source, cwd, [], overrides)
    record.update(resume_history_ready=threading.Event(), resume_hydrating=True,
                  resume_message_count=int(ctx.found.get("message_count") or 0))
    if (reused := ctx.claim(sid, record)) is not None:
        return reused
    _schedule_resume_hydration(sid, ctx.target, ctx.db, close_db=ctx.owns_db)
    ctx.owns_db = False  # the hydration worker now owns (and closes) the profile-scoped handle
    _schedule_session_cap_enforcement()
    return _resume_response(ctx, sid, record, info=ctx.info(cwd, overrides), messages=[],
                            message_count=record["resume_message_count"], status="resuming", hydrating=True)


def _resume_cold(ctx: _Resume) -> dict:
    """Default cold resume: transcript now, agent OFF the response path (_make_agent can block for seconds;
    callers await this RPC before painting) — pre-warmed on a timer, _sess() builds on demand if the first
    prompt beats it. Unlike lazy, restores full ancestor history + persisted runtime identity."""
    sid, source, cwd = ctx.mint()
    try:
        history, display_history, raw_history = ctx.restore()
    except Exception as e:
        return _err(ctx.rid, 5000, f"resume failed: {e}")
    overrides = _stored_session_runtime_overrides(ctx.found)
    record = ctx.record(source, cwd, history, overrides, display_history_prefix=ctx.display_prefix(),
                        todo_state=_todo_state_from_history(history))
    if (reused := ctx.claim(sid, record)) is not None:
        return reused
    if ctx.creation_claim is None:
        _schedule_agent_build(sid)
        _schedule_session_cap_enforcement()  # trim detached idle sessions over the cap
    return _resume_response(ctx, sid, record, info=ctx.info(cwd, overrides), display=display_history,
                            count_source=raw_history,
                            auto_continue=_maybe_schedule_auto_continue(sid, record, ctx.target))


def _resume_eager(ctx: _Resume) -> dict:
    with _eager_resume_build_fence(ctx.profile_home, ctx.target):
        return _resume_eager_fenced(ctx)


def _resume_eager_fenced(ctx: _Resume) -> dict:
    """Synchronous build OUTSIDE _session_resume_lock (it would stall session.close), then double-checked."""
    sid, source, _cwd = ctx.mint()
    with _profile_build_scope(ctx.profile_home):
        try:
            history, display_history, raw_history = ctx.restore()
            display_history_prefix = ctx.display_prefix()
            # Profile db so turns persist to the right state.db; stored runtime identity so switching chats does
            # not inherit another chat's global model.
            stored_runtime_overrides = _stored_session_runtime_overrides(ctx.found)
            agent = _make_agent_in_context(
                sid, ctx.target, session_db=ctx.db, platform_override=source,
                context_cwd_is_launch_artifact=(source in _LAUNCH_CWD_NOT_A_WORKSPACE and not ctx.profile_resume_cwd),
                **stored_runtime_overrides)
        except Exception as e:
            return _err(ctx.rid, 5000, f"resume failed: {e}")
    with _session_resume_lock:
        live = _find_live_session_by_key(ctx.target, ctx.profile_home)
        if live is not None:
            with contextlib.suppress(Exception):
                agent.close()
            return _resume_reuse_live_locked(ctx, *live)
        try:
            with _profile_build_scope(ctx.profile_home):
                _init_session(sid, ctx.target, agent, history, cols=ctx.cols, cwd=ctx.profile_resume_cwd,
                              session_db=ctx.db, source=source, explicit_cwd=bool(ctx.profile_resume_cwd))
                # Ownership TRANSFER: the agent holds the handle for life (AIAgent.close() releases it). The
                # owns_db drop is UNCONDITIONAL — the session is registered against the handle, so the finally
                # must not close it even if the transfer was refused (a leak beats "closed database" every
                # turn). Gated on owns_db: the SHARED launch handle must never move onto one session.
                if ctx.owns_db:
                    _transfer_db_to_agent(agent, ctx.db)
                ctx.owns_db = False
            if (session := _sessions.get(sid)) is not None:
                if stored_runtime_overrides.get("model_override") is not None:
                    session["model_override"] = stored_runtime_overrides["model_override"]
                # Each turn re-binds HERMES_HOME (mid-turn memory/skills reads); lease claimed lazily on turn 1.
                if ctx.profile_home is not None:
                    session["profile_home"] = str(ctx.profile_home)
                session.update(display_history_prefix=display_history_prefix, active_session_lease=None)
        except Exception as e:
            # _init_session registers _sessions[sid] BEFORE its first db read; left in place the fast path
            # would serve that dead session forever.
            if ctx.owns_db:
                with _sessions_lock:
                    _sessions.pop(sid, None)
            return _err(ctx.rid, 5000, f"resume failed: {e}")
        session = _sessions.get(sid) or {}
    return _resume_response(
        ctx, sid, session, info=_session_info(agent, session), display=display_history, count_source=raw_history,
        started_at=float(session.get("created_at") or time.time()),
        auto_continue=_maybe_schedule_auto_continue(sid, session, ctx.target) if session else None)


@method("session.resume")
def _(rid, params: dict) -> dict:
    if not (target := params.get("session_id", "")):
        return _err(rid, 4006, "session_id required")
    ctx = _Resume(rid, params, target)
    # Profile scope: a DEDICATED handle we own until the agent takes it; else the shared launch db.
    ctx.db, ctx.owns_db = _profile_session_db(ctx.profile_home)
    try:
        if ctx.db is None:
            return _db_unavailable_error(rid, code=5000)
        if (resp := _resume_locate(ctx)) is not None:
            return resp
        _resume_follow_tip(ctx)
        from tui_gateway.companion_turns import claimed_creation_fence_for_session
        ctx.creation_claim = claimed_creation_fence_for_session(ctx.db, ctx.target)
        if ctx.creation_claim is not None:
            # Never prewarm/adopt a creation claimed by another process.
            ctx.lazy = ctx.defer_history = ctx.eager_build = False
        if (resp := _resume_guard(ctx)) is not None:
            return resp
        ctx.profile_resume_cwd = _str_param(ctx.found, "cwd") or _profile_configured_cwd(ctx.profile_home)
        # Fast path: reuse a session live IN THIS PROFILE (never another profile's runtime).
        with _session_resume_lock:
            live = _find_live_session_by_key(ctx.target, ctx.profile_home)
        if live is not None:
            return _resume_reuse_live(ctx, *live)
        if ctx.lazy:
            return _resume_lazy(ctx)
        if ctx.eager_build:
            return _resume_eager(ctx)
        return _resume_deferred(ctx) if ctx.defer_history else _resume_cold(ctx)
    finally:
        # Refcounting alone does not release the sqlite fds: SessionDB pins ITSELF (atexit.register) once its
        # background token writer starts; only close() unregisters.
        if ctx.owns_db and ctx.db is not None:
            with contextlib.suppress(Exception):
                ctx.db.close()


def register(server) -> None:
    """Publish resume helpers onto server and install the session.resume handler."""
    bind_module(globals(), server, skip=("_",))
