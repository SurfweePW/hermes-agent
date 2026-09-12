from __future__ import annotations

from dataclasses import FrozenInstanceError
import json

import pytest

from hermes_state import SessionDB
from tui_gateway import server
from tui_gateway.companion_turns import TurnClaim, bind_turn, reset_bound_turn

OPERATION = "a" * 48
CREATOR_TOKEN = "b" * 48


class Lease:
    enabled = True
    released = False
    track_liveness = True

    def __init__(self, session_id: str, lease_id: str = "reserved-lease") -> None:
        self.session_id = session_id
        self.lease_id = lease_id
        self.release_calls = 0

    def release(self) -> None:
        self.release_calls += 1
        self.released = True


@pytest.fixture
def reserved_env(tmp_path, monkeypatch):
    profile_home = (tmp_path / "profiles" / "atlas").resolve()
    cwd = (tmp_path / "project").resolve()
    profile_home.mkdir(parents=True)
    cwd.mkdir()
    db = SessionDB(profile_home / "state.db")

    monkeypatch.setattr(server, "_current_profile_name", lambda: "launch")
    monkeypatch.setattr(
        server, "_profile_home", lambda profile: profile_home if profile == "atlas" else None
    )
    monkeypatch.setattr(server, "_enable_gateway_prompts", lambda: None)
    monkeypatch.setattr(server, "_resolve_model", lambda: "test/model")
    monkeypatch.setattr(server, "_load_show_reasoning", lambda: False)
    monkeypatch.setattr(server, "_load_tool_progress_mode", lambda: "default")
    monkeypatch.setattr(server.git_probe, "branch", lambda _cwd: "main")
    monkeypatch.setattr(server, "_project_info_for_cwd", lambda path: {"cwd": path})
    monkeypatch.setattr(server, "_register_session_cwd", lambda _session: None)
    monkeypatch.setattr(
        server, "_schedule_agent_build", lambda _sid: pytest.fail("reserved create prewarmed")
    )
    monkeypatch.setattr(
        server,
        "_schedule_session_cap_enforcement",
        lambda: pytest.fail("reserved create scheduled generic post-work"),
    )
    monkeypatch.setattr(server, "_get_db", lambda: db)
    monkeypatch.setattr(server, "_sessions", {})
    with server._lifecycle_reservation_lock:
        server._inflight_creation_reservations.clear()
    yield profile_home, cwd, db
    with server._lifecycle_reservation_lock:
        server._inflight_creation_reservations.clear()
    db.close()


def make_reserved(profile_home, cwd, *, sid="runtime-exact", key="stored-exact", lease=None):
    lease = lease or Lease(key)
    assert server._track_creation_reservation(
        lease, session_key=key, live_session_id=sid
    )
    return server.ReservedSessionCreate(
        runtime_session_id=sid,
        stored_session_id=key,
        target_profile="atlas",
        target_profile_home=str(profile_home),
        canonical_project_cwd=str(cwd),
        operation_id=OPERATION,
        creator_pid=123,
        creator_started_at=456,
        creator_token=CREATOR_TOKEN,
        creator_epoch=1,
        lease=lease,
    )


def test_reserved_create_publishes_exact_empty_lazy_runtime_and_transfers_marker(reserved_env):
    profile_home, cwd, db = reserved_env
    reserved = make_reserved(profile_home, cwd)

    response = server._invoke_reserved_session_create(reserved, rid="private")

    assert response["result"]["session_id"] == "runtime-exact"
    assert response["result"]["stored_session_id"] == "stored-exact"
    assert response["result"]["message_count"] == 0
    assert response["result"]["messages"] == []
    session = server._sessions["runtime-exact"]
    assert session["session_key"] == "stored-exact"
    assert session["source"] == "companion"
    assert session["profile_home"] == str(profile_home)
    assert session["cwd"] == str(cwd)
    assert session["history"] == []
    assert session["parent_session_id"] is None
    assert session["agent"] is None
    assert not session["agent_ready"].is_set()
    assert session["slash_worker"] is None
    assert session["active_session_lease"] is reserved.lease
    assert session[server._CREATION_LEASE_KEY] is reserved.lease
    assert server._own_live_lease_ids() == {reserved.lease.lease_id}
    assert db.get_session("stored-exact") is None


def test_reserved_record_is_immutable_and_replay_is_refused(reserved_env):
    profile_home, cwd, _db = reserved_env
    reserved = make_reserved(profile_home, cwd)
    with pytest.raises(FrozenInstanceError):
        reserved.runtime_session_id = "changed"

    assert "result" in server._invoke_reserved_session_create(reserved)
    replay = server._invoke_reserved_session_create(reserved)

    assert replay["error"]["message"] == server._RESERVED_CREATE_FAILURE
    assert list(server._sessions) == ["runtime-exact"]


def test_matching_handler_response_without_publication_does_not_consume_authority(
    reserved_env, monkeypatch
):
    profile_home, cwd, _db = reserved_env
    reserved = make_reserved(profile_home, cwd)
    actual = server._methods["session.create"]
    monkeypatch.setitem(
        server._methods,
        "session.create",
        lambda rid, params: {
            "id": rid,
            "result": {
                "session_id": reserved.runtime_session_id,
                "stored_session_id": reserved.stored_session_id,
            },
        },
    )

    refused = server._invoke_reserved_session_create(reserved)
    assert refused["error"]["message"] == server._RESERVED_CREATE_FAILURE
    assert server._sessions == {}

    monkeypatch.setitem(server._methods, "session.create", actual)
    assert "result" in server._invoke_reserved_session_create(reserved)


def test_eager_resume_build_fence_blocks_reserved_runtime_publication(reserved_env):
    profile_home, cwd, _db = reserved_env
    reserved = make_reserved(profile_home, cwd)

    with server._eager_resume_build_fence(profile_home, reserved.stored_session_id):
        response = server._invoke_reserved_session_create(reserved)

    assert response["error"]["message"] == server._RESERVED_CREATE_FAILURE
    assert reserved.runtime_session_id not in server._sessions
    assert server._tracked_creation_reservation(reserved.lease) is not None
    assert reserved._capability._state == "fresh"


def test_registration_failure_before_publication_leaks_no_runtime_or_authority(
    reserved_env, monkeypatch
):
    profile_home, cwd, _db = reserved_env
    reserved = make_reserved(profile_home, cwd)
    monkeypatch.setattr(
        server,
        "_register_session_cwd",
        lambda _session: (_ for _ in ()).throw(RuntimeError("PRIVATE")),
    )

    failed = server._invoke_reserved_session_create(reserved)

    assert failed["error"]["message"] == server._RESERVED_CREATE_FAILURE
    assert server._sessions == {}
    assert server._tracked_creation_reservation(reserved.lease)[0] is reserved.lease
    monkeypatch.setattr(server, "_register_session_cwd", lambda _session: None)
    replay = server._invoke_reserved_session_create(reserved)
    assert replay["result"]["session_id"] == reserved.runtime_session_id


def test_registered_handler_rejects_context_without_active_capability(reserved_env):
    profile_home, cwd, _db = reserved_env
    reserved = make_reserved(profile_home, cwd)
    token = server._reserved_session_create_context.set(reserved)
    try:
        response = server._methods["session.create"]("private", {})
    finally:
        server._reserved_session_create_context.reset(token)

    assert response["error"]["message"] == server._RESERVED_CREATE_FAILURE
    assert server._sessions == {}
    assert server._tracked_creation_reservation(reserved.lease)[0] is reserved.lease


def test_external_json_cannot_activate_reserved_behavior(reserved_env, monkeypatch):
    profile_home, cwd, _db = reserved_env
    scheduled = []
    monkeypatch.setattr(server, "_schedule_agent_build", scheduled.append)
    monkeypatch.setattr(server, "_schedule_session_cap_enforcement", lambda: None)
    payload = {
        "runtime_session_id": "spoof-runtime",
        "stored_session_id": "spoof-stored",
        "target_profile_home": str(profile_home),
        "canonical_project_cwd": str(cwd),
        "source": "tool",
        "_capability": {"state": "fresh"},
    }

    response = server.handle_request({"id": "public", "method": "session.create", "params": payload})

    sid = response["result"]["session_id"]
    assert sid != "spoof-runtime"
    assert response["result"]["stored_session_id"] != "spoof-stored"
    assert server._sessions[sid]["source"] == "tool"
    assert scheduled == [sid]


def test_collision_or_tracker_mismatch_does_not_overwrite_or_claim_success(reserved_env):
    profile_home, cwd, _db = reserved_env
    occupied = {"session_key": "other", "active_session_lease": object()}
    server._sessions["runtime-exact"] = occupied
    reserved = make_reserved(profile_home, cwd)

    collision = server._invoke_reserved_session_create(reserved)

    assert collision["error"]["message"] == server._RESERVED_CREATE_FAILURE
    assert server._sessions["runtime-exact"] is occupied
    assert reserved.lease is server._tracked_creation_reservation(reserved.lease)[0]
    server._sessions.clear()
    with server._lifecycle_reservation_lock:
        server._inflight_creation_reservations[id(reserved.lease)] = (
            reserved.lease, "wrong-key", "runtime-exact", False
        )
    mismatch = server._invoke_reserved_session_create(reserved)
    assert mismatch["error"]["message"] == server._RESERVED_CREATE_FAILURE
    assert server._sessions == {}


def test_transfer_refusal_and_marker_failure_restore_exact_reservation(reserved_env, monkeypatch):
    profile_home, cwd, _db = reserved_env
    reserved = make_reserved(profile_home, cwd)
    monkeypatch.setattr(server, "_transfer_creation_reservation", lambda *_a, **_k: False)

    refused = server._invoke_reserved_session_create(reserved)

    assert refused["error"]["message"] == server._RESERVED_CREATE_FAILURE
    assert server._sessions == {}
    assert server._tracked_creation_reservation(reserved.lease)[0] is reserved.lease



def test_marker_failure_restores_exact_reservation(reserved_env, monkeypatch):
    profile_home, cwd, _db = reserved_env
    reserved = make_reserved(profile_home, cwd)
    monkeypatch.setattr(
        server, "_track_transferred_creation_lease", lambda *_a: (_ for _ in ()).throw(RuntimeError("PRIVATE"))
    )

    marker_failure = server._invoke_reserved_session_create(reserved)

    assert marker_failure["error"]["message"] == server._RESERVED_CREATE_FAILURE
    assert server._sessions == {}
    assert server._tracked_creation_reservation(reserved.lease) == (
        reserved.lease, "stored-exact", "runtime-exact", False
    )


def test_publish_and_exact_transfer_run_under_the_sessions_lock(reserved_env, monkeypatch):
    profile_home, cwd, _db = reserved_env
    reserved = make_reserved(profile_home, cwd)
    actual = server._transfer_creation_reservation
    observed = []

    def transfer(lease, *, sid, session):
        observed.append((server._sessions_lock._is_owned(), server._sessions.get(sid) is session))
        return actual(lease, sid=sid, session=session)

    monkeypatch.setattr(server, "_transfer_creation_reservation", transfer)
    response = server._invoke_reserved_session_create(reserved)

    assert response["result"]["session_id"] == "runtime-exact"
    assert observed == [(True, True)]


def test_unbound_prompt_to_provisional_runtime_is_rejected_without_side_effects(
    reserved_env, monkeypatch
):
    profile_home, cwd, _db = reserved_env
    reserved = make_reserved(profile_home, cwd)
    assert "result" in server._invoke_reserved_session_create(reserved)
    builds = []
    threads = []

    class DeferredThread:
        def __init__(self, *, target, daemon):
            self.target = target
            self.daemon = daemon

        def start(self):
            threads.append(self)

    monkeypatch.setattr(server, "_persist_session_row_for_submit", lambda *_a: None)
    monkeypatch.setattr(server, "_start_agent_build", lambda sid, session: builds.append((sid, session)))
    monkeypatch.setattr(server.threading, "Thread", DeferredThread)

    response = server._methods["prompt.submit"](
        "prompt", {"session_id": "runtime-exact", "text": "hello"}
    )

    assert response["error"] == {"code": 4090, "message": "session creation is still pending"}
    assert builds == []
    assert threads == []
    session = server._sessions["runtime-exact"]
    assert session["agent"] is None
    assert session["active_session_lease"] is reserved.lease
    assert session[server._CREATION_LEASE_KEY] is reserved.lease


@pytest.mark.parametrize(
    ("method_name", "params"),
    [
        ("session.close", {"session_id": "runtime-exact"}),
        (
            "session.workspace.move",
            {"session_key": "stored-exact", "cwd": None},
        ),
        (
            "llm.oneshot",
            {"session_id": "runtime-exact", "input": "must not execute"},
        ),
    ],
)
def test_ordinary_session_operations_cannot_bypass_provisional_fence(
    reserved_env, method_name, params
):
    profile_home, cwd, _db = reserved_env
    reserved = make_reserved(profile_home, cwd)
    assert "result" in server._invoke_reserved_session_create(reserved)
    if method_name == "session.workspace.move":
        params = {**params, "cwd": str(cwd)}

    response = server._methods[method_name]("ordinary", params)

    assert response["error"] == {
        "code": 4090,
        "message": "session creation is still pending",
    }
    assert server._sessions[reserved.runtime_session_id][server._CREATION_AUTHORITY_KEY]


def test_active_list_hides_provisional_runtime(reserved_env):
    profile_home, cwd, _db = reserved_env
    reserved = make_reserved(profile_home, cwd)
    assert "result" in server._invoke_reserved_session_create(reserved)

    response = server._methods["session.active_list"](
        "ordinary", {"current_session_id": reserved.runtime_session_id}
    )

    assert response["result"] == {"sessions": []}


def test_resume_rejects_rowless_provisional_runtime_without_rebinding(reserved_env):
    profile_home, cwd, _db = reserved_env
    reserved = make_reserved(profile_home, cwd)
    assert "result" in server._invoke_reserved_session_create(reserved)
    session = server._sessions[reserved.runtime_session_id]
    before_transport = session.get("transport")
    before_last_active = session["last_active"]

    response = server._methods["session.resume"](
        "resume-provisional", {"session_id": reserved.stored_session_id, "profile": "atlas"}
    )

    assert response["error"] == {
        "code": 4090,
        "message": "session creation is still pending",
    }
    assert "result" not in response
    assert session.get("transport") is before_transport
    assert session["last_active"] == before_last_active


def test_provisional_agent_build_failure_is_fixed_and_private(
    reserved_env, monkeypatch, caplog
):
    from tui_gateway import entry

    profile_home, cwd, _db = reserved_env
    reserved = make_reserved(profile_home, cwd)
    assert "result" in server._invoke_reserved_session_create(reserved)
    session = server._sessions[reserved.runtime_session_id]
    session["profile_home"] = None
    emitted = []

    class InlineThread:
        def __init__(self, *, target, daemon):
            self.target = target
            self.daemon = daemon

        def start(self):
            self.target()

    monkeypatch.setattr(entry, "ensure_mcp_discovery_started", lambda: None)
    monkeypatch.setattr(
        server,
        "_make_agent",
        lambda *_a, **_k: (_ for _ in ()).throw(
            RuntimeError("PRIVATE-AGENT-BUILD-CANARY-/secret/project")
        ),
    )
    monkeypatch.setattr(server, "_emit", lambda *args: emitted.append(args))
    monkeypatch.setattr(server.threading, "Thread", InlineThread)

    server._start_agent_build(reserved.runtime_session_id, session)

    rendered = repr((session.get("agent_error"), emitted, caplog.text))
    assert "PRIVATE-AGENT-BUILD-CANARY" not in rendered
    assert session["agent_error"] == "Durable creation failed."
    assert any(
        args[0] == "error" and args[2] == {"message": "Durable creation failed."}
        for args in emitted
    )


def _matching_claim(**changes):
    values = {
        "operation_id": OPERATION,
        "payload_sha256": "c" * 64,
        "lineage_root_id": "stored-exact",
        "admitted_tip_id": "stored-exact",
        "generation": 1,
        "executor_pid": 123,
        "executor_started": 456,
        "executor_token": CREATOR_TOKEN,
        "operation_kind": "create",
    }
    values.update(changes)
    return TurnClaim(**values)


def test_only_exact_bound_creation_authority_crosses_lookup_fence(reserved_env):
    profile_home, cwd, _db = reserved_env
    reserved = make_reserved(profile_home, cwd)
    assert "result" in server._invoke_reserved_session_create(reserved)
    session = server._sessions[reserved.runtime_session_id]

    claim_token = bind_turn(_matching_claim())
    submit_token = server._bind_provisional_creation_submission(reserved, session)
    try:
        found, error = server._sess_nowait({"session_id": reserved.runtime_session_id}, "bound")
    finally:
        server._reset_provisional_creation_submission(submit_token)
        reset_bound_turn(claim_token)
    assert found is session and error is None
    assert server._sess_nowait({"session_id": reserved.runtime_session_id}, "replay")[0] is None


@pytest.mark.parametrize(
    "claim",
    [
        _matching_claim(operation_id="d" * 48),
        _matching_claim(executor_pid=124),
        _matching_claim(executor_started=457),
        _matching_claim(executor_token="e" * 48),
    ],
)
def test_wrong_bound_creation_identity_is_rejected(reserved_env, claim):
    profile_home, cwd, _db = reserved_env
    reserved = make_reserved(profile_home, cwd)
    assert "result" in server._invoke_reserved_session_create(reserved)
    session = server._sessions[reserved.runtime_session_id]
    claim_token = bind_turn(claim)
    submit_token = server._bind_provisional_creation_submission(reserved, session)
    try:
        found, error = server._sess_nowait({"session_id": reserved.runtime_session_id}, "wrong")
    finally:
        server._reset_provisional_creation_submission(submit_token)
        reset_bound_turn(claim_token)
    assert found is None
    assert error["error"] == {"code": 4090, "message": "session creation is still pending"}


def test_wrong_bound_creation_lease_is_rejected(reserved_env):
    profile_home, cwd, _db = reserved_env
    reserved = make_reserved(profile_home, cwd)
    assert "result" in server._invoke_reserved_session_create(reserved)
    session = server._sessions[reserved.runtime_session_id]
    session["active_session_lease"] = Lease(reserved.stored_session_id, "wrong-lease")
    claim_token = bind_turn(_matching_claim())
    submit_token = server._bind_provisional_creation_submission(reserved, session)
    try:
        found, error = server._sess_nowait({"session_id": reserved.runtime_session_id}, "wrong")
    finally:
        server._reset_provisional_creation_submission(submit_token)
        reset_bound_turn(claim_token)
    assert found is None
    assert error["error"]["code"] == 4090


def test_malformed_coordinates_are_sanitized_and_leave_exact_lease_tracked(reserved_env):
    profile_home, cwd, _db = reserved_env
    reserved = make_reserved(profile_home, cwd / "missing")

    response = server._invoke_reserved_session_create(reserved, rid="private")

    assert response["error"] == {"code": 5006, "message": server._RESERVED_CREATE_FAILURE}
    encoded = json.dumps(response)
    assert "missing" not in encoded
    assert "stored-exact" not in encoded
    assert server._sessions == {}
    assert server._tracked_creation_reservation(reserved.lease)[0] is reserved.lease


def test_private_invoker_uses_rebound_registered_handler_seam(reserved_env, monkeypatch):
    profile_home, cwd, _db = reserved_env
    reserved = make_reserved(profile_home, cwd)
    actual = server._methods["session.create"]
    observed = []

    def rebound(rid, params):
        observed.append((rid, params, server._reserved_session_create_context.get()))
        return actual(rid, params)

    monkeypatch.setitem(server._methods, "session.create", rebound)
    response = server._invoke_reserved_session_create(reserved, rid="private")

    assert response["result"]["session_id"] == "runtime-exact"
    assert observed == [("private", {}, reserved)]
