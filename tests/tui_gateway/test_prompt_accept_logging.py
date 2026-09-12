"""Desktop/TUI turn-dispatch observability (#86647).

During the #79278/#86647 persistent-mute investigation the decisive evidence
was an *absence*: a Desktop request left no INFO record in ``agent.log`` or
``gateway.log`` at all (``0 platform=desktop`` across the whole file), so a
muted window was structurally indistinguishable from a request that never
arrived. This suite pins the two-record contract that fixes that:

* ``_run_prompt_submit`` logs one ``tui prompt accepted`` INFO record before
  the turn thread starts, carrying the UI session id, the gateway
  ``session_key``, and the agent's live ``session_id`` (rotated independently
  by compression — the triple is what a rotation-mute trace needs).
* The turn's ``finally`` logs exactly one ``tui turn finished`` bookend on
  every path (success, returned error, exception), re-reading
  ``agent.session_id`` so a mid-turn compression rotation shows up as an
  accepted/finished pair with different agent ids.
* No prompt content is ever logged.
"""

from __future__ import annotations

from contextlib import contextmanager
import json
import logging
import threading
import types

import pytest

from hermes_state import SessionDB
from tui_gateway import companion_turns, server
from tui_gateway.companion_turns import (
    TurnClaim,
    active_lineage_turn,
    admit_turn,
    bind_turn,
    claim_turn,
    mark_running,
    new_operation_id,
    prepare_created_session,
    read_turn,
    reset_bound_turn,
)


CREATION_FAILURE_MESSAGE = "Durable creation failed."


class _Refusal:
    def __init__(self, message):
        self.message = message
        self.reason = message

    def __str__(self):
        return self.message


class _InlineThread:
    """Run the turn synchronously so tests observe its final state."""

    def __init__(self, target=None, daemon=None, args=(), kwargs=None):
        self._target = target
        self._args = args
        self._kwargs = kwargs or {}

    def start(self):
        if self._target is not None:
            self._target(*self._args, **self._kwargs)

    def is_alive(self):
        return False

    def join(self, timeout=None):
        return None


def _session(agent=None, **extra):
    return {
        "agent": agent if agent is not None else types.SimpleNamespace(),
        "session_key": "gw-session-key",
        "history": [],
        "history_lock": threading.Lock(),
        "history_version": 0,
        "running": False,
        "attached_images": [],
        "image_counter": 0,
        "cols": 80,
        "slash_worker": None,
        "show_reasoning": False,
        "tool_progress_mode": "all",
        "inflight_turn": None,
        **extra,
    }


@pytest.fixture()
def turn_env(monkeypatch, tmp_path):
    """Neutralize the turn pipeline's environment-heavy side paths."""
    monkeypatch.setattr(server.threading, "Thread", _InlineThread)
    monkeypatch.setattr(server, "_emit", lambda *a, **k: None)
    monkeypatch.setattr(server, "_wire_callbacks", lambda sid: None)
    monkeypatch.setattr(server, "_sync_agent_model_with_config", lambda sid, session: None)
    monkeypatch.setattr(server, "_session_cwd", lambda session: str(tmp_path))
    monkeypatch.setattr(server, "_register_session_cwd", lambda session: None)
    monkeypatch.setattr(server, "_tts_stream_begin", lambda: None)
    monkeypatch.setattr(server, "_sync_session_key_after_compress", lambda *a, **k: None)
    monkeypatch.setattr(server, "_get_usage", lambda agent: {})


def _records(caplog, needle):
    return [r for r in caplog.records if needle in r.getMessage()]


SECRETISH_PROMPT = "please rotate QDRANT_API_KEY=hunter2-super-secret now"


def _bound_claim() -> TurnClaim:
    return TurnClaim(
        operation_id="bound-operation",
        payload_sha256="a" * 64,
        lineage_root_id="gw-session-key",
        admitted_tip_id="gw-session-key",
        generation=1,
        executor_pid=1,
        executor_started=1,
        executor_token="test-executor",
    )


def _created_claim(db: SessionDB, _operation_id: str) -> TurnClaim:
    return prepare_created_session(
        db,
        {
            "session_id": "gw-session-key",
            "source": "companion",
            "model": "test/model",
            "model_config": {"model": "test/model", "provider": "test"},
            "profile_name": "atlas",
            "cwd": "/safe/project",
            "git_repo_root": "/safe/project",
        },
        new_operation_id(),
        "c" * 64,
        (123, 456, "c" * 48),
    )


def _prompt_submit_creation_env(monkeypatch, session, db, emitted):
    @contextmanager
    def session_db(_session):
        yield db

    monkeypatch.setattr(server, "_sess_nowait", lambda _params, _rid: (session, None))
    monkeypatch.setattr(server, "_legacy_group_fence_error", lambda *_args: None)
    monkeypatch.setattr(server, "_ensure_active_session_slot", lambda *_args: None)
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda *_args: False)
    monkeypatch.setattr(server, "_reattach_refusal", lambda *_args: None)
    monkeypatch.setattr(server, "_session_db", session_db)
    monkeypatch.setattr(server, "_emit", lambda *args: emitted.append(args))


def _attach_creation_lease(session, lease):
    session["active_session_lease"] = lease
    session["_creation_active_session_lease"] = lease


def _all_public_output(response, emitted, caplog) -> str:
    return json.dumps(response) + json.dumps(emitted) + "\n".join(
        record.getMessage() for record in caplog.records
    )


@pytest.mark.parametrize("entrypoint", ["direct", "public"])
@pytest.mark.parametrize("failure_kind", ["exception", "returned", "mixed"])
def test_post_admission_creation_failure_is_strictly_sanitized(
    monkeypatch, tmp_path, caplog, capsys, turn_env, entrypoint, failure_kind
):
    canary = "ARBITRARY_TURN_ERROR_CANARY_/private/cwd_model_prompt"
    prompt = f"private prompt {canary}"
    private_result = {
        "final_response": canary,
        "error": canary,
        "failed": True,
        "last_reasoning": canary,
        "billing_block": {"detail": canary},
        "failure_reason": canary,
        "rendered": canary,
        "callback": canary,
        "error_surface": {"detail": canary},
        "private_extra": canary,
    }

    def run_conversation(*_args, **_kwargs):
        if failure_kind == "exception":
            raise RuntimeError(canary)
        if failure_kind == "mixed":
            return {**private_result, "interrupted": True}
        return private_result

    agent = types.SimpleNamespace(
        session_id="agent-sid-1",
        provider=canary,
        model=canary,
        run_conversation=run_conversation,
        clear_interrupt=lambda: None,
    )
    db = SessionDB(tmp_path / "state.db")
    claim = _created_claim(db, f"creation-{entrypoint}-{failure_kind}")
    session = _session(agent=agent)
    emitted = []
    terminal = []
    crash_log = tmp_path / "gateway-crash.log"

    @contextmanager
    def session_db(_session):
        yield db

    monkeypatch.setattr(server, "_session_db", session_db)
    monkeypatch.setattr(server, "_emit", lambda *args: emitted.append(args))
    monkeypatch.setattr(server, "_CRASH_LOG", str(crash_log))
    monkeypatch.setattr(server.threading, "Thread", _InlineThread)

    token = None
    try:
        with caplog.at_level(logging.INFO, logger="tui_gateway.server"):
            if entrypoint == "direct":
                admit_turn(db, claim, runtime_id="ui-sid")
                session["_durable_turn_claim"] = claim.to_wire()
                session["running"] = True
                server._start_inflight_turn(session, prompt)
                response = server._run_prompt_submit(
                    "rid", "ui-sid", session, prompt, terminal_callback=terminal.append
                )
            else:
                _prompt_submit_creation_env(monkeypatch, session, db, emitted)
                monkeypatch.setattr(
                    server, "_persist_session_row_for_submit", lambda *_args: None
                )
                monkeypatch.setattr(
                    server, "_restart_completed_failed_agent_build", lambda *_args: True
                )
                token = bind_turn(claim)
                response = server._methods["prompt.submit"](
                    "rid", {
                        "session_id": "ui-sid",
                        "text": prompt,
                    }
                )

        completes = [args[2] for args in emitted if args[0] == "message.complete"]
        assert completes == [{
            "text": "",
            "usage": {},
            "status": "error",
            "error": CREATION_FAILURE_MESSAGE,
            "recoverable": True,
        }]
        assert terminal == ([{
            "status": "failed", "text": "", "error": CREATION_FAILURE_MESSAGE
        }] if entrypoint == "direct" else [])
        snapshot = server._inflight_snapshot(session)
        assert snapshot == {
            "assistant": "",
            "streaming": False,
            "user": "",
            "error": CREATION_FAILURE_MESSAGE,
            "status": "error",
            "recoverable": True,
        }
        captured = capsys.readouterr()
        crash_text = crash_log.read_text() if crash_log.exists() else ""
        all_channels = json.dumps({
            "response": response,
            "events": emitted,
            "terminal": terminal,
            "inflight": session.get("inflight_turn"),
            "stdout": captured.out,
            "stderr": captured.err,
            "logs": [record.getMessage() for record in caplog.records],
            "crash_log": crash_text,
        }, default=str)
        assert canary not in all_channels
        assert CREATION_FAILURE_MESSAGE in all_channels
        assert read_turn(db, claim.operation_id)["state"] == "failed"
        assert active_lineage_turn(db, "gw-session-key") is False
        assert session["running"] is False
        assert "_durable_turn_claim" not in session
    finally:
        if token is not None:
            reset_bound_turn(token)
        db.close()


@pytest.mark.parametrize("failure_signal", ["failed", "error"])
def test_mixed_interrupted_creation_result_is_replaced_wholesale(failure_signal):
    canary = "MIXED_RESULT_PRIVATE_CANARY"
    claim = types.SimpleNamespace(operation_kind="create")
    result = {
        "interrupted": True,
        failure_signal: canary if failure_signal == "error" else True,
        "final_response": canary,
        "last_reasoning": canary,
        "billing_block": {"detail": canary},
        "failure_reason": canary,
        "rendered": canary,
        "callback": canary,
    }
    turn_run = getattr(server, "_TurnRun")
    sanitize_result = getattr(server, "_sanitize_durable_creation_result")
    state = turn_run(
        agent=types.SimpleNamespace(),
        one_turn_restore=None,
        terminal_callback=None,
        receipt_committed=True,
        durable_claim=claim,
        result=result,
    )

    sanitize_result(state)

    assert state.result == {
        "final_response": "",
        "error": CREATION_FAILURE_MESSAGE,
        "failed": True,
    }


def test_clean_interrupted_creation_result_preserves_cancellation_semantics():
    result = {"interrupted": True, "final_response": "cancelled partial response"}
    turn_run = getattr(server, "_TurnRun")
    state = turn_run(
        agent=types.SimpleNamespace(),
        one_turn_restore=None,
        terminal_callback=None,
        receipt_committed=True,
        durable_claim=types.SimpleNamespace(operation_kind="create"),
        result=result,
    )

    getattr(server, "_sanitize_durable_creation_result")(state)

    assert state.result is result
    assert getattr(server, "_turn_outcome")(state.result)[1] == "interrupted"


def test_post_admission_creation_agent_build_failure_is_strictly_sanitized(
    monkeypatch, tmp_path, caplog, capsys
):
    canary = "ARBITRARY_AGENT_BUILD_ERROR_CANARY_/private/cwd_model_prompt"
    db = SessionDB(tmp_path / "state.db")
    claim = _created_claim(db, "creation-agent-build")
    admit_turn(db, claim, runtime_id="ui-sid")
    session = _session(
        running=True,
        _durable_turn_claim=claim.to_wire(),
        inflight_turn={"user": canary, "assistant": canary, "streaming": True},
    )
    emitted = []
    terminal = []

    @contextmanager
    def session_db(_session):
        yield db

    monkeypatch.setattr(server, "_session_db", session_db)
    monkeypatch.setattr(server, "_emit", lambda *args: emitted.append(args))
    monkeypatch.setattr(
        server, "_wait_agent_for_prompt",
        lambda *_args: {"error": {"message": canary, "private": canary}},
    )
    try:
        with caplog.at_level(logging.INFO, logger="tui_gateway.server"):
            server._run_after_agent_ready(
                "rid", "ui-sid", session, canary, None, terminal.append
            )

        completes = [args[2] for args in emitted if args[0] == "message.complete"]
        assert completes == [{
            "text": "", "usage": {}, "status": "error",
            "error": CREATION_FAILURE_MESSAGE, "recoverable": True,
        }]
        assert terminal == [{
            "status": "failed", "text": "", "error": CREATION_FAILURE_MESSAGE,
        }]
        assert server._inflight_snapshot(session) == {
            "assistant": "", "streaming": False, "user": "",
            "error": CREATION_FAILURE_MESSAGE, "status": "error", "recoverable": True,
        }
        captured = capsys.readouterr()
        all_channels = json.dumps({
            "events": emitted,
            "terminal": terminal,
            "inflight": session.get("inflight_turn"),
            "stdout": captured.out,
            "stderr": captured.err,
            "logs": [record.getMessage() for record in caplog.records],
        }, default=str)
        assert canary not in all_channels
        assert read_turn(db, claim.operation_id)["state"] == "failed"
        assert active_lineage_turn(db, "gw-session-key") is False
        assert session["running"] is False
        assert "_durable_turn_claim" not in session
    finally:
        db.close()


def test_ordinary_prompt_has_no_durable_turn_coupling():
    session = _session()

    prepare_claim = getattr(server, "_prepare_durable_turn_claim")
    assert prepare_claim("ui-sid", session) is None
    assert "_durable_turn_claim" not in session


def test_malformed_internal_durable_claim_fails_closed(monkeypatch):
    session = _session(running=True, _durable_turn_claim={"operation_id": "malformed"})
    emitted = []
    monkeypatch.setattr(server, "_ensure_active_session_slot", lambda *_args: None)
    monkeypatch.setattr(server, "_emit", lambda *args: emitted.append(args))

    admit_prompt = getattr(server, "_admit_prompt_turn")
    admitted = admit_prompt("ui-sid", session, "go", None, None)

    assert admitted is None
    assert session["running"] is False
    assert emitted[-1][0] == "error"
    assert "durable turn context is invalid" in emitted[-1][2]["message"]


def test_bound_continuation_under_isolation_returns_4121(monkeypatch):
    session = _session()
    monkeypatch.setattr(server, "_sess_nowait", lambda _params, _rid: (session, None))
    monkeypatch.setattr(server, "_legacy_group_fence_error", lambda *_args: None)
    monkeypatch.setattr(server, "_ensure_active_session_slot", lambda *_args: None)
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda *_args: True)
    token = bind_turn(_bound_claim())
    try:
        response = server._methods["prompt.submit"](
            "bound-isolation", {"session_id": "ui-sid", "text": "go"}
        )
    finally:
        reset_bound_turn(token)

    assert response["error"]["code"] == 4121
    assert session["running"] is False
    assert "_durable_turn_claim" not in session


def test_busy_bound_continuation_returns_4091_without_queue_or_steer(monkeypatch):
    session = _session(running=True)
    monkeypatch.setattr(server, "_sess_nowait", lambda _params, _rid: (session, None))
    monkeypatch.setattr(server, "_legacy_group_fence_error", lambda *_args: None)
    monkeypatch.setattr(server, "_ensure_active_session_slot", lambda *_args: None)
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda *_args: False)
    monkeypatch.setattr(server, "_reattach_refusal", lambda *_args: None)
    monkeypatch.setattr(
        server,
        "_handle_busy_submit",
        lambda *_args, **_kwargs: pytest.fail("bound continuation must not queue or steer"),
    )
    token = bind_turn(_bound_claim())
    try:
        response = server._methods["prompt.submit"](
            "bound-busy", {"session_id": "ui-sid", "text": "go", "queued": True}
        )
    finally:
        reset_bound_turn(token)

    assert response["error"]["code"] == 4091
    assert session["running"] is True
    assert "queued_prompt" not in session
    assert "_durable_turn_claim" not in session


@pytest.mark.parametrize(
    "refusal_kind",
    ["preflight", "isolation", "reattach", "busy-runtime", "pre-worker"],
)
def test_bound_creation_early_refusal_is_fixed_and_releases_only_creation(
    monkeypatch, tmp_path, caplog, refusal_kind
):
    canary = f"EARLY_REFUSAL_PRIVATE_CANARY_{refusal_kind}_/private/workspace"
    db = SessionDB(tmp_path / "state.db")
    claim = _created_claim(db, f"creation-early-{refusal_kind}")
    existing_thread = object()
    existing_lease = object()
    released = []

    class CreationLease:
        enabled = True
        released = False
        track_liveness = False

        def release(self):
            self.released = True
            released.append(self)

    creation_lease = CreationLease()
    session = _session(
        running=refusal_kind == "busy-runtime",
        _run_thread=existing_thread if refusal_kind == "busy-runtime" else None,
        active_session_lease=existing_lease if refusal_kind == "busy-runtime" else None,
    )
    if refusal_kind != "busy-runtime":
        _attach_creation_lease(session, creation_lease)
    emitted = []
    _prompt_submit_creation_env(monkeypatch, session, db, emitted)
    monkeypatch.setattr(
        server.threading, "Thread",
        lambda *_args, **_kwargs: pytest.fail("early refusal must not construct a worker"),
    )
    if refusal_kind == "preflight":
        monkeypatch.setattr(
            server, "_legacy_group_fence_error",
            lambda rid, *_args: server._err(rid, 4009, canary, {"reason": canary}),
        )
    elif refusal_kind == "isolation":
        monkeypatch.setattr(server, "_session_uses_compute_host", lambda *_args: True)
    elif refusal_kind == "reattach":
        monkeypatch.setattr(
            server, "_reattach_refusal",
            lambda rid, *_args: server._err(rid, 4007, canary, {"reason": canary}),
        )
    elif refusal_kind == "pre-worker":
        monkeypatch.setattr(
            server, "_lock_in_submit_turn",
            lambda rid, *_args: (server._err(rid, 4009, canary, {"reason": canary}), {}),
        )

    token = bind_turn(claim)
    try:
        with caplog.at_level(logging.WARNING, logger="tui_gateway.server"):
            response = server._methods["prompt.submit"](
                "bound-early-refusal", {"session_id": "ui-sid", "text": "go"}
            )

        assert response["error"] == {"code": 5006, "message": CREATION_FAILURE_MESSAGE}
        assert emitted == []
        assert canary not in _all_public_output(response, emitted, caplog)
        assert read_turn(db, claim.operation_id)["state"] == "not_admitted"
        assert active_lineage_turn(db, "gw-session-key") is False
        assert "_durable_turn_claim" not in session
        if refusal_kind == "busy-runtime":
            assert session["running"] is True
            assert session["_run_thread"] is existing_thread
            assert session["active_session_lease"] is existing_lease
            assert released == []
        else:
            assert creation_lease.released is True
            assert released == [creation_lease]
            assert "active_session_lease" not in session
    finally:
        reset_bound_turn(token)
        db.close()


def test_inner_creation_active_session_refusal_is_one_fixed_terminal(
    monkeypatch, tmp_path, caplog, capsys
):
    canary = "INNER_ACTIVE_SESSION_PRIVATE_CANARY_/private/workspace"
    db = SessionDB(tmp_path / "state.db")
    claim = _created_claim(db, "creation-inner-active-refusal")
    admit_turn(db, claim, runtime_id="ui-sid")
    released = []

    class CreationLease:
        enabled = True
        released = False
        track_liveness = False

        def release(self):
            self.released = True
            released.append(True)

    lease = CreationLease()
    session = _session(
        running=True,
        _durable_turn_claim=claim.to_wire(),
        inflight_turn={"user": canary, "assistant": canary, "streaming": True},
    )
    _attach_creation_lease(session, lease)
    emitted = []
    terminal = []
    refusal = _Refusal(canary)

    @contextmanager
    def session_db(_session):
        yield db

    monkeypatch.setattr(server, "_session_db", session_db)
    monkeypatch.setattr(server, "_ensure_active_session_slot", lambda *_args: refusal)
    monkeypatch.setattr(server, "_emit", lambda *args: emitted.append(args))
    monkeypatch.setattr(
        server.threading, "Thread",
        lambda *_args, **_kwargs: pytest.fail("refused inner turn must not construct a worker"),
    )

    try:
        with caplog.at_level(logging.INFO, logger="tui_gateway.server"):
            response = server._run_prompt_submit(
                "rid", "ui-sid", session, canary, terminal_callback=terminal.append
            )

        assert response is False
        assert [args for args in emitted if args[0] == "error"] == []
        assert [args[2] for args in emitted if args[0] == "message.complete"] == [{
            "text": "", "usage": {}, "status": "error",
            "error": CREATION_FAILURE_MESSAGE, "recoverable": True,
        }]
        assert terminal == [{
            "status": "failed", "text": "", "error": CREATION_FAILURE_MESSAGE,
        }]
        captured = capsys.readouterr()
        channels = json.dumps({
            "events": emitted, "terminal": terminal, "inflight": session.get("inflight_turn"),
            "stdout": captured.out, "stderr": captured.err,
            "logs": [record.getMessage() for record in caplog.records],
        }, default=str)
        assert canary not in channels
        assert read_turn(db, claim.operation_id)["state"] == "failed"
        assert active_lineage_turn(db, "gw-session-key") is False
        assert session["running"] is False
        assert "_durable_turn_claim" not in session
        assert released == [True]
        assert "active_session_lease" not in session
    finally:
        db.close()


def test_inner_creation_refusal_never_releases_unmarked_busy_runtime_lease(
    monkeypatch, tmp_path
):
    db = SessionDB(tmp_path / "state.db")
    claim = _created_claim(db, "ordinary-busy-lease")
    admit_turn(db, claim, runtime_id="ui-sid")
    released = []

    class BusyLease:
        track_liveness = True
        enabled = True
        released = False

        def release(self):
            self.released = True
            released.append(True)

    lease = BusyLease()
    session = _session(
        running=True, active_session_lease=lease, _durable_turn_claim=claim.to_wire()
    )
    emitted = []

    @contextmanager
    def session_db(_session):
        yield db

    monkeypatch.setattr(server, "_session_db", session_db)
    monkeypatch.setattr(server, "_ensure_active_session_slot", lambda *_args: _Refusal("private"))
    monkeypatch.setattr(server, "_emit", lambda *args: emitted.append(args))

    assert server._run_prompt_submit("rid", "ui-sid", session, "go") is False
    assert released == []
    assert session["active_session_lease"] is lease
    db.close()


def test_failed_creation_lease_release_is_retained_and_reports_unknown(
    monkeypatch, tmp_path, caplog
):
    db = SessionDB(tmp_path / "state.db")
    claim = _created_claim(db, "release-failure")

    class FailingLease:
        track_liveness = True
        enabled = True
        released = False

        def __init__(self):
            self.attempts = 0

        def release(self):
            self.attempts += 1
            raise OSError("private release failure")

    lease = FailingLease()
    session = _session()
    _attach_creation_lease(session, lease)

    @contextmanager
    def session_db(_session):
        yield db

    monkeypatch.setattr(server, "_session_db", session_db)
    with caplog.at_level(logging.WARNING, logger="tui_gateway.server"):
        response = server._refuse_unstarted_durable_creation("rid", session, claim)

    assert response["error"] == {
        "code": 5066, "message": "Creation outcome unknown; reconcile this request."
    }
    assert lease.attempts == 3
    assert session["active_session_lease"] is lease
    assert session["_creation_active_session_lease"] is lease
    assert session["_durable_turn_claim"] == claim.to_wire()
    assert "private release failure" not in "\n".join(
        record.getMessage() for record in caplog.records
    )
    db.close()


def test_failed_creation_settlement_retains_claim_and_lease(monkeypatch, tmp_path):
    db = SessionDB(tmp_path / "state.db")
    claim = _created_claim(db, "settlement-failure")
    lease = types.SimpleNamespace(track_liveness=True, enabled=True, released=False)
    session = _session(_durable_turn_claim=claim.to_wire())
    _attach_creation_lease(session, lease)

    @contextmanager
    def session_db(_session):
        yield db

    monkeypatch.setattr(server, "_session_db", session_db)
    monkeypatch.setattr(
        companion_turns, "settle_turn",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("private settlement failure")),
    )

    response = server._refuse_unstarted_durable_creation("rid", session, claim)

    assert response["error"] == {
        "code": 5066, "message": "Creation outcome unknown; reconcile this request."
    }
    assert session["_durable_turn_claim"] == claim.to_wire()
    assert session["active_session_lease"] is lease
    assert session["_creation_active_session_lease"] is lease
    assert read_turn(db, claim.operation_id)["state"] == "claimed"
    db.close()


@pytest.mark.parametrize("marker_state", ["matching", "mismatched", "absent"])
def test_completed_creation_retires_only_the_matching_provisional_marker(
    monkeypatch, tmp_path, marker_state
):
    db = SessionDB(tmp_path / "state.db")
    claim = _created_claim(db, "completed-marker-retirement")
    admit_turn(db, claim, runtime_id="ui-sid")
    lease = types.SimpleNamespace(enabled=True, released=False)
    marker = (
        lease
        if marker_state == "matching"
        else types.SimpleNamespace(enabled=True, released=False)
    )
    session = _session(
        active_session_lease=lease,
        _durable_turn_claim=claim.to_wire(),
    )
    if marker_state != "absent":
        session["_creation_active_session_lease"] = marker

    @contextmanager
    def session_db(_session):
        yield db

    monkeypatch.setattr(server, "_session_db", session_db)
    if marker_state != "mismatched":
        server._settle_session_durable_turn(session, "completed", claim)
        assert "_durable_turn_claim" not in session
        assert "_creation_active_session_lease" not in session
    else:
        with pytest.raises(RuntimeError, match="Creation outcome unknown"):
            server._settle_session_durable_turn(session, "completed", claim)
        assert session["_durable_turn_claim"] == claim.to_wire()
        assert session["_creation_active_session_lease"] is marker
    assert session["active_session_lease"] is lease
    assert read_turn(db, claim.operation_id)["state"] == "completed"
    db.close()


def test_creation_finalizer_logs_fixed_coordination_unknown_on_marker_mismatch(
    monkeypatch, tmp_path, caplog
):
    from hermes_cli import mem_trim

    db = SessionDB(tmp_path / "state.db")
    claim = _created_claim(db, "finalizer-marker-mismatch")
    admit_turn(db, claim, runtime_id="ui-sid")
    active_lease = types.SimpleNamespace(enabled=True, released=False)
    marker = types.SimpleNamespace(enabled=True, released=False)
    session = _session(
        active_session_lease=active_lease,
        _creation_active_session_lease=marker,
        _durable_turn_claim=claim.to_wire(),
    )

    @contextmanager
    def session_db(_session):
        yield db

    monkeypatch.setattr(server, "_session_db", session_db)
    monkeypatch.setattr(mem_trim, "trim_memory", lambda **_kwargs: None)
    turn = server._TurnRun(
        agent=session["agent"],
        one_turn_restore=None,
        terminal_callback=None,
        receipt_committed=False,
        durable_claim=claim,
        result={"final_response": "ok"},
    )
    with caplog.at_level(logging.WARNING, logger="tui_gateway.server"):
        server._finish_turn("ui-sid", session, turn)

    messages = [record.getMessage() for record in caplog.records]
    assert messages.count("Creation outcome unknown; reconcile this request.") == 1
    assert CREATION_FAILURE_MESSAGE not in messages
    assert session["_durable_turn_claim"] == claim.to_wire()
    assert session["_creation_active_session_lease"] is marker
    assert session["active_session_lease"] is active_lease
    assert read_turn(db, claim.operation_id)["state"] == "completed"
    db.close()


def test_post_stream_creation_liveness_refusal_is_one_fixed_terminal(
    monkeypatch, tmp_path
):
    db = SessionDB(tmp_path / "state.db")
    claim = _created_claim(db, "post-stream-liveness")
    admit_turn(db, claim, runtime_id="ui-sid")
    released = []

    class Lease:
        track_liveness = True
        enabled = True
        released = False

        def release(self):
            self.released = True
            released.append(True)

    session = _session(
        running=False,
        _turn_cancel_requested=False,
        _durable_turn_claim=claim.to_wire(),
        inflight_turn={"user": "private", "assistant": "private", "streaming": True},
    )
    _attach_creation_lease(session, Lease())
    emitted = []
    terminal = []

    @contextmanager
    def session_db(_session):
        yield db

    monkeypatch.setattr(server, "_session_db", session_db)
    monkeypatch.setattr(server, "_wait_agent_for_prompt", lambda *_args: None)
    monkeypatch.setattr(server, "_emit", lambda *args: emitted.append(args))

    server._run_after_agent_ready("rid", "ui-sid", session, "private", None, terminal.append)

    assert [event[0] for event in emitted] == ["message.complete"]
    assert emitted[0][2]["error"] == CREATION_FAILURE_MESSAGE
    assert terminal == [{
        "status": "failed", "text": "", "error": CREATION_FAILURE_MESSAGE
    }]
    assert read_turn(db, claim.operation_id)["state"] == "failed"
    assert released == [True]
    db.close()


def test_creation_marker_failure_resets_context_and_completes_once(
    monkeypatch, tmp_path
):
    canary = "MARKER_PRIVATE_CANARY_/private/path"
    db = SessionDB(tmp_path / "state.db")
    claim = _created_claim(db, "marker-failure")
    admit_turn(db, claim, runtime_id="ui-sid")

    class Lease:
        track_liveness = True
        enabled = True
        released = False

        def release(self):
            self.released = True

    session = _session(running=True, _durable_turn_claim=claim.to_wire())
    _attach_creation_lease(session, Lease())
    emitted = []
    terminal = []

    @contextmanager
    def session_db(_session):
        yield db

    monkeypatch.setattr(server, "_session_db", session_db)
    monkeypatch.setattr(server, "_ensure_active_session_slot", lambda *_args: None)
    monkeypatch.setattr(server, "_record_turn_marker", lambda *_args: (_ for _ in ()).throw(OSError(canary)))
    monkeypatch.setattr(server, "_emit", lambda *args: emitted.append(args))
    monkeypatch.setattr(server.threading, "Thread", _InlineThread)

    # Inline thread: run() completes synchronously, so the turn WAS dispatched and
    # terminally failed inside it. Production dispatches async; the observable contract
    # is the single fixed terminal frame below, not the dispatch return value.
    assert server._run_prompt_submit(
        "rid", "ui-sid", session, "private", terminal_callback=terminal.append
    ) is True

    assert server._current_runtime_session_record.get() is None
    assert [event[0] for event in emitted].count("message.complete") == 1
    assert terminal == [{
        "status": "failed", "text": "", "error": CREATION_FAILURE_MESSAGE
    }]
    assert canary not in json.dumps({"events": emitted, "terminal": terminal})
    assert read_turn(db, claim.operation_id)["state"] == "failed"
    assert session["running"] is False
    db.close()


@pytest.mark.parametrize("release_fails", [False, True])
def test_creation_turn_state_init_failure_completes_and_releases_once(
    monkeypatch, tmp_path, release_fails
):
    canary = "TURN_STATE_PRIVATE_CANARY_/private/path"
    db = SessionDB(tmp_path / "state.db")
    claim = _created_claim(db, "turn-state-init-failure")
    admit_turn(db, claim, runtime_id="ui-sid")

    class Lease:
        track_liveness = True
        enabled = True
        released = False

        def release(self):
            if release_fails:
                raise OSError("private release failure")
            self.released = True

    lease = Lease()
    session = _session(running=True, _durable_turn_claim=claim.to_wire())
    _attach_creation_lease(session, lease)
    emitted = []
    terminal = []

    @contextmanager
    def session_db(_session):
        yield db

    monkeypatch.setattr(server, "_session_db", session_db)
    monkeypatch.setattr(server, "_ensure_active_session_slot", lambda *_args: None)
    monkeypatch.setattr(server, "_record_turn_marker", lambda *_args: None)
    monkeypatch.setattr(
        server, "_TurnRun",
        lambda **_kwargs: (_ for _ in ()).throw(RuntimeError(canary)),
    )
    monkeypatch.setattr(server, "_emit", lambda *args: emitted.append(args))
    monkeypatch.setattr(server.threading, "Thread", _InlineThread)

    assert server._run_prompt_submit(
        "rid", "ui-sid", session, "private", terminal_callback=terminal.append
    ) is True

    assert server._current_runtime_session_record.get() is None
    assert [event[0] for event in emitted] == ["message.start", "message.complete"]
    expected_error = (
        "Creation outcome unknown; reconcile this request."
        if release_fails else CREATION_FAILURE_MESSAGE
    )
    assert terminal == [{"status": "failed", "text": "", "error": expected_error}]
    assert canary not in json.dumps({"events": emitted, "terminal": terminal})
    assert read_turn(db, claim.operation_id)["state"] == "failed"
    assert session["running"] is False
    assert lease.released is (not release_fails)
    if release_fails:
        assert session["_durable_turn_claim"] == claim.to_wire()
        assert session["_creation_active_session_lease"] is lease
    else:
        assert "_durable_turn_claim" not in session
        assert "_creation_active_session_lease" not in session
    db.close()


def test_bound_creation_admission_error_is_fixed_at_prompt_submit_boundary(
    monkeypatch, tmp_path, caplog
):
    db = SessionDB(tmp_path / "state.db")
    claim = _created_claim(db, "creation-admission-operation")
    session = _session()
    canary = "ARBITRARY_ADMISSION_DETAIL_/private/path_model=internal"
    emitted = []
    _prompt_submit_creation_env(monkeypatch, session, db, emitted)
    monkeypatch.setattr(
        companion_turns,
        "admit_turn",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError(canary)),
    )
    token = bind_turn(claim)
    try:
        with caplog.at_level(logging.WARNING, logger="tui_gateway.server"):
            response = server._methods["prompt.submit"](
                "bound-admission-error", {"session_id": "ui-sid", "text": "go"}
            )

        assert response["error"] == {"code": 5006, "message": CREATION_FAILURE_MESSAGE}
        output = _all_public_output(response, emitted, caplog)
        assert canary not in output
        assert CREATION_FAILURE_MESSAGE in output
        record = read_turn(db, claim.operation_id)
        assert record is not None
        assert record["state"] == "not_admitted"
        assert active_lineage_turn(db, "gw-session-key") is False
    finally:
        reset_bound_turn(token)
        db.close()


def test_bound_creation_preparation_error_is_fixed_and_releases_slot(
    monkeypatch, tmp_path, caplog
):
    db = SessionDB(tmp_path / "state.db")
    claim = _created_claim(db, "creation-preparation-operation")
    session = _session()
    emitted = []
    canary = "ARBITRARY_PREPARATION_DETAIL_/private/cwd_creator-token"
    _prompt_submit_creation_env(monkeypatch, session, db, emitted)
    monkeypatch.setattr(
        server,
        "_prepare_durable_turn_claim",
        lambda *_args: (_ for _ in ()).throw(RuntimeError(canary)),
    )
    token = bind_turn(claim)
    try:
        with caplog.at_level(logging.WARNING, logger="tui_gateway.server"):
            response = server._methods["prompt.submit"](
                "bound-preparation-error", {"session_id": "ui-sid", "text": "go"}
            )
        assert response["error"] == {"code": 5006, "message": CREATION_FAILURE_MESSAGE}
        output = _all_public_output(response, emitted, caplog)
        assert canary not in output
        assert CREATION_FAILURE_MESSAGE in output
        assert read_turn(db, claim.operation_id)["state"] == "not_admitted"
        assert active_lineage_turn(db, "gw-session-key") is False
        assert session["running"] is False
    finally:
        reset_bound_turn(token)
        db.close()


def test_bound_creation_mark_running_error_emits_and_logs_fixed_text(
    monkeypatch, tmp_path, caplog
):
    db = SessionDB(tmp_path / "state.db")
    claim = _created_claim(db, "creation-mark-running-operation")
    session = _session()
    emitted = []
    canary = "ARBITRARY_MARK_RUNNING_DETAIL_/private/model-operation"
    _prompt_submit_creation_env(monkeypatch, session, db, emitted)
    monkeypatch.setattr(server.threading, "Thread", _InlineThread)
    monkeypatch.setattr(
        companion_turns,
        "mark_running",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError(canary)),
    )
    token = bind_turn(claim)
    try:
        with caplog.at_level(logging.WARNING, logger="tui_gateway.server"):
            response = server._methods["prompt.submit"](
                "bound-running-error", {"session_id": "ui-sid", "text": "go"}
            )
        assert response["result"]["status"] == "streaming"
        assert [args for args in emitted if args[0] == "error"] == []
        assert [args[2] for args in emitted if args[0] == "message.complete"] == [{
            "text": "", "usage": {}, "status": "error",
            "error": CREATION_FAILURE_MESSAGE, "recoverable": True,
        }]
        output = _all_public_output(response, emitted, caplog)
        assert canary not in output
        assert CREATION_FAILURE_MESSAGE in output
        assert read_turn(db, claim.operation_id)["state"] == "failed"
        assert active_lineage_turn(db, "gw-session-key") is False
        assert session["running"] is False
    finally:
        reset_bound_turn(token)
        db.close()


def test_bound_creation_thread_start_error_is_fixed_and_releases_slot(
    monkeypatch, tmp_path, caplog
):
    canary = "ARBITRARY_THREAD_DETAIL_/private/path_prompt"

    class FailingThread:
        def __init__(self, *args, **kwargs):
            pass

        def start(self):
            raise RuntimeError(canary)

    db = SessionDB(tmp_path / "state.db")
    claim = _created_claim(db, "creation-thread-operation")
    session = _session()
    emitted = []
    _prompt_submit_creation_env(monkeypatch, session, db, emitted)
    monkeypatch.setattr(server, "_persist_session_row_for_submit", lambda *_args: None)
    monkeypatch.setattr(server, "_restart_completed_failed_agent_build", lambda *_args: True)
    monkeypatch.setattr(server.threading, "Thread", FailingThread)
    token = bind_turn(claim)
    try:
        with caplog.at_level(logging.WARNING, logger="tui_gateway.server"):
            response = server._methods["prompt.submit"](
                "bound-thread-error", {"session_id": "ui-sid", "text": "go"}
            )
        assert response["error"] == {"code": 5006, "message": CREATION_FAILURE_MESSAGE}
        output = _all_public_output(response, emitted, caplog)
        assert canary not in output
        assert CREATION_FAILURE_MESSAGE in output
        assert read_turn(db, claim.operation_id)["state"] == "failed"
        assert active_lineage_turn(db, "gw-session-key") is False
        assert session["running"] is False
        assert "_run_thread" not in session
    finally:
        reset_bound_turn(token)
        db.close()


@pytest.mark.parametrize(
    "failure_kind", ["persist", "restart", "build", "thread-constructor"]
)
def test_bound_creation_preworker_failure_is_fixed_and_failed(
    monkeypatch, tmp_path, caplog, failure_kind
):
    canary = f"PREWORKER_PRIVATE_CANARY_{failure_kind}_/private/path"
    db = SessionDB(tmp_path / "state.db")
    claim = _created_claim(db, f"creation-preworker-{failure_kind}")
    session = _session()
    emitted = []
    _prompt_submit_creation_env(monkeypatch, session, db, emitted)
    monkeypatch.setattr(server, "_persist_session_row_for_submit", lambda *_args: None)
    monkeypatch.setattr(server, "_restart_completed_failed_agent_build", lambda *_args: True)
    if failure_kind == "persist":
        monkeypatch.setattr(
            server, "_persist_session_row_for_submit",
            lambda rid, *_args: server._err(rid, 5071, canary, {"reason": canary}),
        )
    elif failure_kind == "restart":
        monkeypatch.setattr(
            server, "_restart_completed_failed_agent_build",
            lambda *_args: (_ for _ in ()).throw(RuntimeError(canary)),
        )
    elif failure_kind == "build":
        monkeypatch.setattr(server, "_restart_completed_failed_agent_build", lambda *_args: False)
        monkeypatch.setattr(
            server, "_start_agent_build",
            lambda *_args: (_ for _ in ()).throw(RuntimeError(canary)),
        )
    else:
        monkeypatch.setattr(
            server.threading, "Thread",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError(canary)),
        )

    token = bind_turn(claim)
    try:
        with caplog.at_level(logging.WARNING, logger="tui_gateway.server"):
            response = server._methods["prompt.submit"](
                "bound-preworker-error", {"session_id": "ui-sid", "text": "go"}
            )

        assert response["error"] == {"code": 5006, "message": CREATION_FAILURE_MESSAGE}
        assert emitted == []
        assert canary not in _all_public_output(response, emitted, caplog)
        assert read_turn(db, claim.operation_id)["state"] == "failed"
        assert active_lineage_turn(db, "gw-session-key") is False
        assert session["running"] is False
        assert "_durable_turn_claim" not in session
        assert "_run_thread" not in session
    finally:
        reset_bound_turn(token)
        db.close()


@pytest.mark.parametrize("refusal_kind", ["closing", "registry-mismatch"])
def test_inner_creation_liveness_refusal_is_one_fixed_terminal(
    monkeypatch, tmp_path, caplog, refusal_kind
):
    canary = f"INNER_LIVENESS_PRIVATE_CANARY_{refusal_kind}"
    db = SessionDB(tmp_path / "state.db")
    claim = _created_claim(db, f"creation-inner-{refusal_kind}")
    admit_turn(db, claim, runtime_id="ui-sid")
    session = _session(
        running=True,
        _closing=refusal_kind == "closing",
        _durable_turn_claim=claim.to_wire(),
        inflight_turn={"user": canary, "assistant": canary, "streaming": True},
    )
    emitted = []
    terminal = []

    @contextmanager
    def session_db(_session):
        yield db

    monkeypatch.setattr(server, "_session_db", session_db)
    monkeypatch.setattr(server, "_ensure_active_session_slot", lambda *_args: None)
    monkeypatch.setattr(server, "_emit", lambda *args: emitted.append(args))
    class NoStartThread:
        def __init__(self, *_args, **_kwargs):
            pass

        def start(self):
            pytest.fail("liveness refusal must not start a worker")

    monkeypatch.setattr(server.threading, "Thread", NoStartThread)
    if refusal_kind == "registry-mismatch":
        monkeypatch.setitem(server._sessions, "ui-sid", _session())

    try:
        with caplog.at_level(logging.INFO, logger="tui_gateway.server"):
            response = server._run_prompt_submit(
                "rid", "ui-sid", session, canary, terminal_callback=terminal.append
            )

        assert response is False
        assert [args for args in emitted if args[0] == "error"] == []
        assert len([args for args in emitted if args[0] == "message.complete"]) == 1
        assert terminal == [{
            "status": "failed", "text": "", "error": CREATION_FAILURE_MESSAGE,
        }]
        assert canary not in json.dumps({
            "events": emitted, "terminal": terminal, "inflight": session.get("inflight_turn"),
            "logs": [record.getMessage() for record in caplog.records],
        }, default=str)
        assert read_turn(db, claim.operation_id)["state"] == "failed"
        assert active_lineage_turn(db, "gw-session-key") is False
        assert session["running"] is False
    finally:
        server._sessions.pop("ui-sid", None)
        db.close()


def test_inner_creation_turn_thread_start_failure_is_sanitized_and_settled(
    monkeypatch, tmp_path, caplog, capsys
):
    canary = "ARBITRARY_INNER_THREAD_CANARY"
    workers = []
    emitted = []
    terminal = []

    class ControlledThread:
        def __init__(self, target=None, daemon=None, args=(), kwargs=None):
            self._target = target
            self._args = args
            self._kwargs = kwargs or {}
            self._ordinal = len(workers) + 1
            workers.append(self)

        def start(self):
            if self._ordinal == 2:
                raise RuntimeError(canary)

        def run_controlled(self):
            self._target(*self._args, **self._kwargs)

        def is_alive(self):
            return False

    db = SessionDB(tmp_path / "state.db")
    claim = _created_claim(db, "creation-inner-thread-operation")
    worker_calls = []
    agent = types.SimpleNamespace(
        session_id="agent-sid-1",
        clear_interrupt=lambda: None,
        run_conversation=lambda *_args, **_kwargs: worker_calls.append(True),
    )
    session = _session(agent=agent)
    _prompt_submit_creation_env(monkeypatch, session, db, emitted)
    monkeypatch.setattr(server, "_hosted_submit_error", lambda *_args: None)
    monkeypatch.setattr(server, "_persist_session_row_for_submit", lambda *_args: None)
    monkeypatch.setattr(
        server, "_restart_completed_failed_agent_build", lambda *_args: True
    )
    monkeypatch.setattr(server, "_wait_agent_for_prompt", lambda *_args: None)
    monkeypatch.setattr(server.threading, "Thread", ControlledThread)
    token = bind_turn(claim)
    try:
        with caplog.at_level(logging.INFO, logger="tui_gateway.server"):
            response = server._methods["prompt.submit"]("inner-thread-start", {
                "session_id": "ui-sid",
                "text": "go",
                "_hosted_terminal_callback": terminal.append,
            })
            assert response["result"]["status"] == "streaming"
            assert len(workers) == 1
            workers[0].run_controlled()

        assert len(workers) == 2
        assert worker_calls == []
        assert [args[2] for args in emitted if args[0] == "message.complete"] == [{
            "text": "",
            "usage": {},
            "status": "error",
            "error": CREATION_FAILURE_MESSAGE,
            "recoverable": True,
        }]
        assert terminal == [{
            "status": "failed", "text": "", "error": CREATION_FAILURE_MESSAGE
        }]
        assert server._inflight_snapshot(session) == {
            "assistant": "",
            "streaming": False,
            "user": "",
            "error": CREATION_FAILURE_MESSAGE,
            "status": "error",
            "recoverable": True,
        }
        captured = capsys.readouterr()
        all_channels = json.dumps({
            "response": response,
            "events": emitted,
            "terminal": terminal,
            "inflight": session.get("inflight_turn"),
            "session_errors": {
                key: value for key, value in session.items() if "error" in key
            },
            "stdout": captured.out,
            "stderr": captured.err,
            "caplog": caplog.text,
            "logs": [record.getMessage() for record in caplog.records],
        }, default=str)
        assert canary not in all_channels
        assert CREATION_FAILURE_MESSAGE in all_channels
        assert read_turn(db, claim.operation_id)["state"] == "failed"
        assert active_lineage_turn(db, "gw-session-key") is False
        assert session["running"] is False
        assert "_durable_turn_claim" not in session
        assert "_run_thread" not in session
    finally:
        reset_bound_turn(token)
        db.close()


def test_duplicate_running_invocation_does_not_settle_or_clear_winner(
    monkeypatch, tmp_path
):
    db = SessionDB(tmp_path / "state.db")
    db.create_session("gw-session-key", source="desktop")
    claim = claim_turn(
        db,
        operation_id="duplicate-running-operation",
        payload_sha256="b" * 64,
        requested_id="gw-session-key",
    )
    admit_turn(db, claim, runtime_id="ui-sid")
    mark_running(db, claim, runtime_id="ui-sid")
    session = _session(running=True, _durable_turn_claim=claim.to_wire())

    @contextmanager
    def session_db(_session):
        yield db

    monkeypatch.setattr(server, "_ensure_active_session_slot", lambda *_args: None)
    monkeypatch.setattr(server, "_session_db", session_db)
    monkeypatch.setattr(server, "_emit", lambda *_args: None)
    try:
        admit_prompt = getattr(server, "_admit_prompt_turn")
        admitted = admit_prompt("ui-sid", session, "go", None, None)

        assert admitted is None
        assert session["running"] is True
        assert session["_durable_turn_claim"] == claim.to_wire()
        record = read_turn(db, claim.operation_id)
        assert record is not None
        assert record["state"] == "running"
        assert active_lineage_turn(db, "gw-session-key") is True
    finally:
        db.close()


def test_accepted_and_finished_records_on_success(turn_env, caplog):
    agent = types.SimpleNamespace(
        session_id="agent-sid-1",
        run_conversation=lambda *a, **k: {"final_response": "done"},
        clear_interrupt=lambda: None,
    )
    session = _session(agent=agent, running=True)

    with caplog.at_level(logging.INFO, logger="tui_gateway.server"):
        server._run_prompt_submit("rid", "ui-sid", session, SECRETISH_PROMPT)

    accepted = _records(caplog, "tui prompt accepted")
    finished = _records(caplog, "tui turn finished")
    assert len(accepted) == 1
    assert len(finished) == 1

    msg = accepted[0].getMessage()
    # The full id triple a rotation-mute trace needs.
    assert "ui_session=ui-sid" in msg
    assert "session_key=gw-session-key" in msg
    assert "agent_session_id=agent-sid-1" in msg
    # Prompt content is never logged — only its length.
    assert "hunter2" not in msg
    assert "QDRANT_API_KEY" not in msg
    assert f"chars={len(SECRETISH_PROMPT)}" in msg

    fin = finished[0].getMessage()
    assert "ui_session=ui-sid" in fin
    assert "status=complete" in fin
    assert "hunter2" not in fin


def test_finished_record_reflects_mid_turn_rotation(turn_env, caplog):
    """Compression rotating agent.session_id mid-turn must be visible as an
    accepted/finished pair with different agent ids — that pair IS the
    rotation trace #86647 asks for."""

    agent = types.SimpleNamespace(session_id="parent-sid", clear_interrupt=lambda: None)

    def _rotate_and_finish(*a, **k):
        agent.session_id = "continuation-sid"  # what _compress_context does
        return {"final_response": "done"}

    agent.run_conversation = _rotate_and_finish
    session = _session(agent=agent, running=True)

    with caplog.at_level(logging.INFO, logger="tui_gateway.server"):
        server._run_prompt_submit("rid", "ui-sid", session, "go")

    accepted = _records(caplog, "tui prompt accepted")[0].getMessage()
    finished = _records(caplog, "tui turn finished")[0].getMessage()
    assert "agent_session_id=parent-sid" in accepted
    assert "agent_session_id=continuation-sid" in finished


def test_finished_record_fires_on_exception_path(turn_env, caplog):
    def _boom(*a, **k):
        raise RuntimeError("connection reset mid-stream")

    agent = types.SimpleNamespace(
        session_id="agent-sid-1",
        run_conversation=_boom,
        clear_interrupt=lambda: None,
    )
    session = _session(agent=agent, running=True)

    with caplog.at_level(logging.INFO, logger="tui_gateway.server"):
        server._run_prompt_submit("rid", "ui-sid", session, "go")

    finished = _records(caplog, "tui turn finished")
    assert len(finished) == 1
    msg = finished[0].getMessage()
    assert "status=error" in msg
    assert "error_retained=True" in msg


def test_finished_record_fires_on_returned_error(turn_env, caplog):
    agent = types.SimpleNamespace(
        session_id="agent-sid-1",
        run_conversation=lambda *a, **k: {
            "final_response": "",
            "error": "provider 402: billing wall",
            "failed": True,
        },
        clear_interrupt=lambda: None,
    )
    session = _session(agent=agent, running=True)

    with caplog.at_level(logging.INFO, logger="tui_gateway.server"):
        server._run_prompt_submit("rid", "ui-sid", session, "go")

    finished = _records(caplog, "tui turn finished")
    assert len(finished) == 1
    assert "status=error" in finished[0].getMessage()
