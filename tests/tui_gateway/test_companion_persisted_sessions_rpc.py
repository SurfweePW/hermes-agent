"""Behavior contract for Companion's persisted, read-only session projections."""

from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
import contextlib
import json
import sqlite3
import threading

import pytest

from hermes_cli.dashboard_auth.ws_tickets import OwnerAuthorizationLease
from hermes_state import SessionDB
from tui_gateway import companion_sessions, server
from tui_gateway.companion_turns import admit_turn, current_bound_turn, mark_running
from tui_gateway.transport import Transport, bind_transport, reset_transport


class OwnerTransport(Transport):
    def __init__(self, authorization):
        self.companion_owner_authorization = authorization

    def write(self, obj: dict) -> bool:
        del obj
        return True

    def close(self) -> None:
        pass


@pytest.fixture(autouse=True)
def _owner_transport(monkeypatch):
    from tui_gateway import companion_library

    monkeypatch.setattr(
        companion_library,
        "_owner_identity",
        lambda identity: identity if identity == "basic:owner" else None,
    )
    token = bind_transport(
        OwnerTransport(OwnerAuthorizationLease("basic:owner", float("inf")))
    )
    try:
        yield
    finally:
        reset_transport(token)


def _call(method: str, **params):
    return server._methods[method]("companion-test", params)


def _admit_bound_submit(db: SessionDB, runtime_id: str) -> None:
    """Model the durable side effect performed by the real prompt.submit."""
    claim = current_bound_turn()
    assert claim is not None
    admit_turn(db, claim, runtime_id=runtime_id)
    mark_running(db, claim, runtime_id=runtime_id)


def _unsigned_cursor(value: dict) -> str:
    raw = json.dumps(value, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _mutate_one_byte(cursor: str) -> str:
    index = next(index for index, value in enumerate(cursor) if value not in ".=")
    replacement = "A" if cursor[index] != "A" else "B"
    return cursor[:index] + replacement + cursor[index + 1 :]


def _cursor_error(method: str, **params) -> dict:
    response = _call(method, **params)
    assert response["error"]["code"] == 4006
    return response["error"]


@pytest.fixture()
def db(tmp_path, monkeypatch):
    database = SessionDB(tmp_path / "state.db")
    monkeypatch.setenv("GATEWAY_RELAY_ID", "companion-test-backend")
    monkeypatch.setattr(server, "_get_db", lambda: database)
    monkeypatch.setattr(server, "_current_profile_name", lambda: "atlas")
    monkeypatch.setattr(
        companion_sessions,
        "_owner_authorized_profiles",
        lambda _server: frozenset({"atlas"}),
    )
    try:
        yield database
    finally:
        database.close()


def _session(
    db: SessionDB,
    sid: str,
    *,
    source: str = "desktop",
    started_at: float = 1.0,
    title: str | None = None,
    hidden: bool = False,
    archived: bool = False,
    parent: str | None = None,
    end_reason: str | None = None,
    model_config: dict | None = None,
):
    db.create_session(
        sid,
        source=source,
        parent_session_id=parent,
        model_config=model_config,
    )
    db._conn.execute(
        "UPDATE sessions SET started_at = ?, title = ?, hidden = ?, archived = ?, end_reason = ? WHERE id = ?",
        (started_at, title, int(hidden), int(archived), end_reason, sid),
    )
    db._conn.commit()


def test_companion_persisted_session_capability_and_methods_are_registered():
    assert "companion.sessions.list" in server._methods
    assert "companion.sessions.history" in server._methods
    assert "companion.sessions.continue" in server._methods
    assert "companion.capabilities" in server._methods

    result = _call("companion.capabilities")["result"]
    assert result["companion.sessions"] == 1
    assert set(result["methods"]) >= {
        "companion.sessions.list",
        "companion.sessions.history",
        "companion.sessions.continue",
    }


def test_registered_continue_is_exact_idempotent_and_busy_safe(db, monkeypatch):
    _session(db, "stored-exact")
    db._conn.execute("UPDATE sessions SET cwd = ? WHERE id = ?", ("/persisted/exact-cwd", "stored-exact"))
    db._conn.commit()
    calls = []
    runtime_id = "runtime/exact:01"
    monkeypatch.setitem(server._sessions, runtime_id, {"running": False})

    def resume(rid, params):
        calls.append(("resume", rid, dict(params)))
        return server._ok(rid, {"session_id": runtime_id, "session_key": "stored-exact", "resumed": "stored-exact", "messages": []})

    def submit(rid, params):
        calls.append(("submit", rid, dict(params)))
        _admit_bound_submit(db, runtime_id)
        server._sessions[runtime_id]["running"] = True
        return server._ok(rid, {"status": "streaming"})

    monkeypatch.setitem(server._methods, "session.resume", resume)
    monkeypatch.setitem(server._methods, "prompt.submit", submit)
    params = {"backend_namespace": "companion-test-backend", "profile": "atlas", "stored_session_id": "stored-exact", "text": "Continue exactly", "client_request_id": "request-1"}

    first = _call("companion.sessions.continue", **params)["result"]
    replay = _call("companion.sessions.continue", **params)["result"]
    assert first["status"] == "streaming"
    assert replay["status"] == "uncertain"
    assert replay["operation_state"] == "running"
    assert replay["reconciled"] is True
    assert "session_id" not in replay
    assert first["cwd"] == "/persisted/exact-cwd"
    assert first["session_id"] == runtime_id
    assert first["messages"] == []
    assert [kind for kind, _rid, _params in calls] == ["resume", "submit"]

    reconciled = _call(
        "companion.sessions.reconcile",
        backend_namespace=params["backend_namespace"],
        profile=params["profile"],
        stored_session_id=params["stored_session_id"],
        client_request_id=params["client_request_id"],
    )["result"]
    assert reconciled.pop("identity") == {
        "profile": "atlas",
        "backend_namespace": "companion-test-backend",
        "original_id": "stored-exact",
        "root_id": "stored-exact",
        "resolved_tip_id": "stored-exact",
    }
    assert reconciled == {
        "status": "reconciled",
        "operation_status": "running",
        "reconciled": True,
        "runtime_session_id": runtime_id,
        "backend_namespace": "companion-test-backend",
        "profile": "atlas",
        "stored_session_id": "stored-exact",
    }

    conflict = _call("companion.sessions.continue", **{**params, "text": "Changed text"})
    assert conflict["error"]["code"] == 4090
    busy = _call("companion.sessions.continue", **{**params, "client_request_id": "request-2"})
    assert busy["error"]["code"] == 4091
    assert [kind for kind, _rid, _params in calls].count("submit") == 1


def test_success_shaped_submit_without_admission_stays_uncertain(db, monkeypatch):
    _session(db, "stored-inert-submit")
    runtime_id = "runtime-inert-submit"
    monkeypatch.setitem(server._sessions, runtime_id, {"running": False})
    monkeypatch.setitem(
        server._methods,
        "session.resume",
        lambda rid, params: server._ok(
            rid,
            {
                "session_id": runtime_id,
                "session_key": params["session_id"],
                "resumed": params["session_id"],
                "messages": [],
            },
        ),
    )
    monkeypatch.setitem(
        server._methods,
        "prompt.submit",
        lambda rid, _params: server._ok(rid, {"status": "streaming"}),
    )

    result = _call(
        "companion.sessions.continue",
        backend_namespace="companion-test-backend",
        profile="atlas",
        stored_session_id="stored-inert-submit",
        text="Do not infer admission from this response",
        client_request_id="inert-submit-request",
    )["result"]
    records = db._conn.execute(
        "SELECT value FROM state_meta WHERE key LIKE 'continuity_turn_v3:%'"
    ).fetchall()

    assert result["status"] == "uncertain"
    assert result["operation_state"] == "claimed"
    assert "session_id" not in result
    assert server._sessions[runtime_id]["running"] is False
    assert [json.loads(row["value"])["state"] for row in records] == ["claimed"]


def test_accepted_continue_replay_remaps_runtime_after_process_restart(db, monkeypatch):
    _session(db, "stored-restart")
    calls = []
    runtime_ids = iter(("runtime-before-restart", "runtime-after-restart"))

    def resume(rid, params):
        runtime_id = next(runtime_ids)
        calls.append(("resume", runtime_id))
        monkeypatch.setitem(server._sessions, runtime_id, {"running": False})
        return server._ok(
            rid,
            {
                "session_id": runtime_id,
                "session_key": params["session_id"],
                "resumed": params["session_id"],
                "messages": [],
            },
        )

    def submit(rid, params):
        calls.append(("submit", params["session_id"]))
        _admit_bound_submit(db, params["session_id"])
        server._sessions[params["session_id"]]["running"] = True
        return server._ok(rid, {"status": "streaming"})

    monkeypatch.setitem(server._methods, "session.resume", resume)
    monkeypatch.setitem(server._methods, "prompt.submit", submit)
    params = {
        "backend_namespace": "companion-test-backend",
        "profile": "atlas",
        "stored_session_id": "stored-restart",
        "text": "Submit only before restart",
        "client_request_id": "restart-replay-request",
    }

    first = _call("companion.sessions.continue", **params)["result"]
    server._sessions.pop(first["session_id"])
    replay = _call("companion.sessions.continue", **params)["result"]
    assert replay["operation_state"] == "running"
    assert "session_id" not in replay
    assert replay["reconciled"] is True
    assert calls == [
        ("resume", "runtime-before-restart"),
        ("submit", "runtime-before-restart"),
    ]


def test_concurrent_continue_requests_for_one_target_submit_once(db, monkeypatch):
    _session(db, "stored-concurrent")
    runtime_id = "runtime-concurrent"
    monkeypatch.setitem(server._sessions, runtime_id, {"running": False})
    submit_started = threading.Event()
    release_submit = threading.Event()
    second_started = threading.Event()
    calls = []

    def resume(rid, params):
        calls.append(("resume", rid))
        return server._ok(
            rid,
            {
                "session_id": runtime_id,
                "session_key": params["session_id"],
                "resumed": params["session_id"],
                "messages": [],
            },
        )

    def submit(rid, params):
        calls.append(("submit", rid))
        submit_started.set()
        assert release_submit.wait(timeout=2)
        _admit_bound_submit(db, params["session_id"])
        server._sessions[params["session_id"]]["running"] = True
        return server._ok(rid, {"status": "streaming"})

    def concurrent_call(params):
        try:
            return {
                "result": companion_sessions.continue_session(
                    server,
                    params,
                    owner_authorization=OwnerAuthorizationLease(
                        "basic:owner", float("inf")
                    ),
                )
            }
        except companion_sessions.CompanionSessionsError as exc:
            return {"error": {"code": exc.code, "message": str(exc)}}

    def second_call(params):
        second_started.set()
        return concurrent_call(params)

    monkeypatch.setitem(server._methods, "session.resume", resume)
    monkeypatch.setitem(server._methods, "prompt.submit", submit)
    base = {
        "backend_namespace": "companion-test-backend",
        "profile": "atlas",
        "stored_session_id": "stored-concurrent",
        "text": "Only one turn",
    }
    with ThreadPoolExecutor(max_workers=2) as pool:
        first_future = pool.submit(
            concurrent_call,
            {**base, "client_request_id": "concurrent-request-1"},
        )
        assert submit_started.wait(timeout=2)
        second_future = pool.submit(
            second_call,
            {**base, "client_request_id": "concurrent-request-2"},
        )
        assert second_started.wait(timeout=2)
        release_submit.set()
        first = first_future.result(timeout=2)
        second = second_future.result(timeout=2)

    assert first["result"]["status"] == "streaming"
    assert second["error"]["code"] == 4091
    assert [kind for kind, _rid in calls].count("submit") == 1


def test_same_request_replay_during_index_claim_gap_stays_pending_with_identity(db, monkeypatch):
    from tui_gateway import companion_turns

    _session(db, "stored-index-gap")
    runtime_id = "runtime-index-gap"
    monkeypatch.setitem(server._sessions, runtime_id, {"running": False})
    index_written = threading.Event()
    release_claim = threading.Event()
    original_claim = companion_turns.claim_turn
    calls = []

    def delayed_claim(*args, **kwargs):
        index_written.set()
        assert release_claim.wait(timeout=2)
        return original_claim(*args, **kwargs)

    def resume(rid, params):
        calls.append("resume")
        return server._ok(rid, {
            "session_id": runtime_id,
            "session_key": params["session_id"],
            "resumed": params["session_id"],
            "messages": [],
        })

    def submit(rid, params):
        calls.append("submit")
        _admit_bound_submit(db, params["session_id"])
        server._sessions[params["session_id"]]["running"] = True
        return server._ok(rid, {"status": "streaming"})

    monkeypatch.setattr(companion_turns, "claim_turn", delayed_claim)
    monkeypatch.setitem(server._methods, "session.resume", resume)
    monkeypatch.setitem(server._methods, "prompt.submit", submit)
    params = {
        "backend_namespace": "companion-test-backend",
        "profile": "atlas",
        "stored_session_id": "stored-index-gap",
        "text": "Exactly once across the index gap",
        "client_request_id": "index-gap-request",
    }

    with ThreadPoolExecutor(max_workers=2) as pool:
        first_future = pool.submit(
            companion_sessions.continue_session,
            server,
            params,
            owner_authorization=OwnerAuthorizationLease("basic:owner", float("inf")),
        )
        assert index_written.wait(timeout=2)
        replay = companion_sessions.continue_session(
            server,
            params,
            owner_authorization=OwnerAuthorizationLease("basic:owner", float("inf")),
        )
        assert replay["status"] == "uncertain"
        assert replay["operation_state"] == "indexed"
        assert replay["identity"] == {
            "profile": "atlas",
            "backend_namespace": "companion-test-backend",
            "original_id": "stored-index-gap",
            "root_id": "stored-index-gap",
            "resolved_tip_id": "stored-index-gap",
        }
        assert calls == []
        release_claim.set()
        first = first_future.result(timeout=2)

    assert first["status"] == "streaming"
    assert calls == ["resume", "submit"]


def test_continue_request_id_reuse_conflicts_across_stored_targets(db, monkeypatch):
    changed_target = "stored-other"
    _session(db, "stored-exact")
    _session(db, changed_target)
    calls = []
    runtime_id = "runtime-target"
    monkeypatch.setitem(server._sessions, runtime_id, {"running": False})

    def resume(rid, params):
        calls.append(("resume", dict(params)))
        return server._ok(
            rid,
            {
                "session_id": runtime_id,
                "session_key": params["session_id"],
                "resumed": params["session_id"],
                "messages": [],
            },
        )

    def submit(rid, params):
        calls.append(("submit", dict(params)))
        _admit_bound_submit(db, params["session_id"])
        return server._ok(rid, {"status": "streaming"})

    monkeypatch.setitem(server._methods, "session.resume", resume)
    monkeypatch.setitem(server._methods, "prompt.submit", submit)
    params = {
        "backend_namespace": "companion-test-backend",
        "profile": "atlas",
        "stored_session_id": "stored-exact",
        "text": "Same text",
        "client_request_id": "globally-unique-request",
    }

    assert _call("companion.sessions.continue", **params)["result"]["status"] == "streaming"
    conflict = _call(
        "companion.sessions.continue",
        **{**params, "stored_session_id": changed_target},
    )
    assert conflict["error"]["code"] == 4090
    assert [kind for kind, _params in calls] == ["resume", "submit"]


def test_continue_request_id_is_global_across_authorized_profile_dbs(
    db, tmp_path, monkeypatch
):
    coder_db = SessionDB(tmp_path / "coder" / "state.db")
    _session(db, "atlas-session")
    _session(coder_db, "coder-session")
    calls = []
    opened_profiles = []

    @contextlib.contextmanager
    def source(_server, profile, **_kwargs):
        opened_profiles.append(profile)
        yield {"atlas": db, "coder": coder_db}[profile]

    monkeypatch.setattr(companion_sessions, "_source", source)
    monkeypatch.setattr(
        companion_sessions,
        "_owner_authorized_profiles",
        lambda _server: frozenset({"atlas", "coder"}),
    )
    monkeypatch.setitem(server._sessions, "runtime-atlas", {"running": False})
    monkeypatch.setitem(server._sessions, "runtime-coder", {"running": False})

    def resume(rid, params):
        calls.append(("resume", params["profile"]))
        return server._ok(
            rid,
            {
                "session_id": f"runtime-{params['profile']}",
                "session_key": params["session_id"],
                "resumed": params["session_id"],
                "messages": [],
            },
        )

    def submit(rid, params):
        calls.append(("submit", params["session_id"]))
        _admit_bound_submit(db, params["session_id"])
        return server._ok(rid, {"status": "streaming"})

    monkeypatch.setitem(server._methods, "session.resume", resume)
    monkeypatch.setitem(server._methods, "prompt.submit", submit)
    request_id = "cross-profile-request"
    atlas_params = {
        "backend_namespace": "companion-test-backend",
        "profile": "atlas",
        "stored_session_id": "atlas-session",
        "text": "Submit exactly once",
        "client_request_id": request_id,
    }
    try:
        first = _call("companion.sessions.continue", **atlas_params)["result"]
        replay = _call("companion.sessions.continue", **atlas_params)["result"]
        conflict = _call(
            "companion.sessions.continue",
            **{
                **atlas_params,
                "profile": "coder",
                "stored_session_id": "coder-session",
            },
        )
        canonical_receipts = db._conn.execute(
            "SELECT COUNT(*) FROM state_meta WHERE key LIKE 'companion_continuity_v3:%'"
        ).fetchone()[0]
        with coder_db._read_ctx() as conn:
            target_receipts = conn.execute(
                "SELECT COUNT(*) FROM state_meta WHERE key LIKE 'companion_continuity_v3:%'",
            ).fetchone()[0]
    finally:
        coder_db.close()

    assert replay["operation_state"] == "running"
    assert replay["status"] == "uncertain"
    assert "session_id" not in replay
    assert replay["reconciled"] is True
    assert conflict["error"]["code"] == 4090
    assert calls == [("resume", "atlas"), ("submit", "runtime-atlas")]
    assert opened_profiles == ["atlas", "atlas", "atlas"]
    assert (canonical_receipts, target_receipts) == (1, 0)
    assert coder_db.db_path != db.db_path


def test_continue_payload_digest_rejects_backend_change_after_restart(db, monkeypatch):
    _session(db, "stored-backend")
    calls = []
    runtime_id = "runtime-backend"
    monkeypatch.setitem(server._sessions, runtime_id, {"running": False})

    def resume(rid, params):
        calls.append("resume")
        return server._ok(
            rid,
            {
                "session_id": runtime_id,
                "session_key": params["session_id"],
                "resumed": params["session_id"],
                "messages": [],
            },
        )

    def submit(rid, submit_params):
        calls.append("submit")
        _admit_bound_submit(db, submit_params["session_id"])
        return server._ok(rid, {"status": "streaming"})

    monkeypatch.setitem(server._methods, "session.resume", resume)
    monkeypatch.setitem(server._methods, "prompt.submit", submit)
    params = {
        "backend_namespace": "companion-test-backend",
        "profile": "atlas",
        "stored_session_id": "stored-backend",
        "text": "Same text",
        "client_request_id": "backend-bound-request",
    }
    assert _call("companion.sessions.continue", **params)["result"]["status"] == "streaming"

    monkeypatch.setenv("GATEWAY_RELAY_ID", "replacement-backend")
    conflict = _call(
        "companion.sessions.continue",
        **{**params, "backend_namespace": "replacement-backend"},
    )
    assert conflict["error"]["code"] == 4090
    assert calls == ["resume", "submit"]


def test_continue_request_id_reuse_conflicts_before_backend_rejection(db, monkeypatch):
    _session(db, "stored-backend-intent")
    runtime_id = "runtime-backend-intent"
    calls = []
    monkeypatch.setitem(server._sessions, runtime_id, {"running": False})
    monkeypatch.setitem(
        server._methods,
        "session.resume",
        lambda rid, params: server._ok(
            rid,
            {
                "session_id": runtime_id,
                "session_key": params["session_id"],
                "resumed": params["session_id"],
                "messages": [],
            },
        ),
    )

    def submit(rid, submit_params):
        calls.append(rid)
        _admit_bound_submit(db, submit_params["session_id"])
        return server._ok(rid, {"status": "streaming"})

    monkeypatch.setitem(server._methods, "prompt.submit", submit)
    params = {
        "backend_namespace": "companion-test-backend",
        "profile": "atlas",
        "stored_session_id": "stored-backend-intent",
        "text": "Bind this request",
        "client_request_id": "backend-intent-request",
    }

    assert _call("companion.sessions.continue", **params)["result"]["status"] == "streaming"
    conflict = _call(
        "companion.sessions.continue",
        **{**params, "backend_namespace": "wrong-backend"},
    )

    assert conflict["error"]["code"] == 4404
    assert len(calls) == 1


def test_new_wrong_backend_releases_claim_for_corrected_request(db, monkeypatch):
    _session(db, "stored-corrected-backend")
    runtime_id = "runtime-corrected-backend"
    monkeypatch.setitem(server._sessions, runtime_id, {"running": False})
    monkeypatch.setitem(
        server._methods,
        "session.resume",
        lambda rid, params: server._ok(
            rid,
            {
                "session_id": runtime_id,
                "session_key": params["session_id"],
                "resumed": params["session_id"],
                "messages": [],
            },
        ),
    )
    monkeypatch.setitem(
        server._methods,
        "prompt.submit",
        lambda rid, submit_params: (
            _admit_bound_submit(db, submit_params["session_id"])
            or server._ok(rid, {"status": "streaming"})
        ),
    )
    params = {
        "backend_namespace": "wrong-backend",
        "profile": "atlas",
        "stored_session_id": "stored-corrected-backend",
        "text": "Correct the route",
        "client_request_id": "corrected-backend-request",
    }

    assert _call("companion.sessions.continue", **params)["error"]["code"] == 4404
    corrected = _call(
        "companion.sessions.continue",
        **{**params, "backend_namespace": "companion-test-backend"},
    )
    assert corrected["result"]["status"] == "streaming"


@pytest.mark.parametrize(
    ("session_key", "resumed_id"),
    [
        (None, "stored-mapping"),
        ("stored-mapping", None),
        ("different-lineage", "stored-mapping"),
        ("stored-mapping", "different-lineage"),
    ],
)
def test_continue_fails_closed_on_missing_or_mismatched_resume_identity(
    db, monkeypatch, session_key, resumed_id
):
    _session(db, "stored-mapping")
    runtime_id = "runtime-mapping"
    submits = []
    monkeypatch.setitem(server._sessions, runtime_id, {"running": False})

    def resume(rid, _params):
        result = {"session_id": runtime_id, "messages": []}
        if session_key is not None:
            result["session_key"] = session_key
        if resumed_id is not None:
            result["resumed"] = resumed_id
        return server._ok(rid, result)

    monkeypatch.setitem(server._methods, "session.resume", resume)
    monkeypatch.setitem(
        server._methods,
        "prompt.submit",
        lambda *_args: submits.append(True) or pytest.fail("must not submit"),
    )
    response = _call(
        "companion.sessions.continue",
        backend_namespace="companion-test-backend",
        profile="atlas",
        stored_session_id="stored-mapping",
        text="Do not misroute",
        client_request_id=f"mapping-{session_key}-{resumed_id}",
    )
    assert response["error"]["code"] == 5000
    assert submits == []


def test_continue_accepts_db_proven_lineage_root_to_canonical_compression_tip(
    db, monkeypatch
):
    _session(db, "lineage-root", started_at=1, end_reason="compression")
    _session(db, "compression-tip", started_at=2, parent="lineage-root")
    db.append_message("compression-tip", "assistant", "compressed context")
    runtime_id = "runtime-compression-tip"
    calls = []
    monkeypatch.setitem(server._sessions, runtime_id, {"running": False})

    def resume(rid, params):
        calls.append(("resume", dict(params)))
        return server._ok(
            rid,
            {
                "session_id": runtime_id,
                "session_key": "compression-tip",
                "resumed": "compression-tip",
                "messages": [],
            },
        )

    def submit(rid, params):
        calls.append(("submit", dict(params)))
        _admit_bound_submit(db, params["session_id"])
        return server._ok(rid, {"status": "streaming"})

    monkeypatch.setitem(server._methods, "session.resume", resume)
    monkeypatch.setitem(server._methods, "prompt.submit", submit)
    result = _call(
        "companion.sessions.continue",
        backend_namespace="companion-test-backend",
        profile="atlas",
        stored_session_id="lineage-root",
        text="Continue after compression",
        client_request_id="compression-lineage-request",
    )["result"]

    assert result["stored_session_id"] == "lineage-root"
    assert result["session_id"] == runtime_id
    assert calls == [
        ("resume", {"session_id": "compression-tip", "profile": "atlas"}),
        ("submit", {"session_id": runtime_id, "text": "Continue after compression"}),
    ]


def test_continue_validates_actual_resume_shape_for_compacted_lineage(db, monkeypatch):
    _session(db, "actual-lineage-root", started_at=1, end_reason="compression")
    _session(db, "actual-compression-tip", started_at=2, parent="actual-lineage-root")
    db.append_message("actual-compression-tip", "assistant", "compacted continuation")
    db._conn.execute(
        "UPDATE sessions SET cwd = ? WHERE id IN (?, ?)",
        ("/persisted/compacted", "actual-lineage-root", "actual-compression-tip"),
    )
    db._conn.commit()
    actual_resume = server._methods["session.resume"]
    observed = []
    monkeypatch.setattr(server, "_profile_session_db", lambda _home: (db, False))
    monkeypatch.setattr(server, "_enable_gateway_prompts", lambda: None)
    monkeypatch.setattr(server, "_schedule_agent_build", lambda _sid: None)
    monkeypatch.setattr(server, "_schedule_session_cap_enforcement", lambda: None)

    def resume(rid, params):
        response = actual_resume(rid, params)
        observed.append(response)
        return response

    monkeypatch.setitem(server._methods, "session.resume", resume)
    monkeypatch.setitem(
        server._methods,
        "prompt.submit",
        lambda rid, submit_params: (
            _admit_bound_submit(db, submit_params["session_id"])
            or server._ok(rid, {"status": "streaming"})
        ),
    )

    runtime_id = None
    try:
        result = _call(
            "companion.sessions.continue",
            backend_namespace="companion-test-backend",
            profile="atlas",
            stored_session_id="actual-lineage-root",
            text="Continue through the actual resume RPC",
            client_request_id="actual-compacted-resume-request",
        )["result"]
        runtime_id = result["session_id"]

        assert observed[0]["result"]["session_key"] == "actual-compression-tip"
        assert observed[0]["result"]["resumed"] == "actual-compression-tip"
        assert result["stored_session_id"] == "actual-lineage-root"
        assert result["cwd"] == "/persisted/compacted"
    finally:
        if runtime_id is not None:
            server._sessions.pop(runtime_id, None)


def test_continue_receipt_survives_store_reopen_and_hashes_sensitive_scope(db, monkeypatch):
    _session(db, "durable-secret-session")
    db._conn.execute(
        "UPDATE sessions SET cwd = ? WHERE id = ?",
        ("/sensitive/initial-cwd", "durable-secret-session"),
    )
    db._conn.commit()
    calls = []
    runtime_id = "runtime-durable"
    monkeypatch.setitem(server._sessions, runtime_id, {"running": False})
    monkeypatch.setitem(
        server._methods,
        "session.resume",
        lambda rid, params: calls.append("resume") or server._ok(
            rid,
            {"session_id": runtime_id, "session_key": params["session_id"],
                "resumed": params["session_id"], "messages": []},
        ),
    )

    def submit(rid, params):
        calls.append("submit")
        _admit_bound_submit(db, params["session_id"])
        return server._ok(rid, {"status": "streaming"})

    monkeypatch.setitem(server._methods, "prompt.submit", submit)
    params = {
        "backend_namespace": "companion-test-backend",
        "profile": "atlas",
        "stored_session_id": "durable-secret-session",
        "text": "Sensitive continuation body",
        "client_request_id": "durable-secret-request",
    }

    first = _call("companion.sessions.continue", **params)["result"]
    assert first["cwd"] == "/sensitive/initial-cwd"
    rows = db._conn.execute(
        "SELECT key, value FROM state_meta WHERE key LIKE 'continuity_turn_v3:%'",
    ).fetchall()
    assert len(rows) == 1
    assert "durable-secret-session" not in rows[0]["key"]
    assert "durable-secret-request" not in rows[0]["key"]
    receipt = json.loads(rows[0]["value"])
    assert receipt["v"] == 3
    assert receipt["state"] == "running"
    assert receipt["payload_sha256"] == companion_sessions._continuity_payload_digest(
        params["backend_namespace"], params["profile"], params["stored_session_id"], params["text"]
    )
    for forbidden in (
        params["text"], "/sensitive/initial-cwd", "messages", "cwd",
    ):
        assert forbidden not in rows[0]["value"]

    db._conn.execute(
        "UPDATE sessions SET cwd = ? WHERE id = ?",
        ("/authoritative/replay-cwd", params["stored_session_id"]),
    )
    db._conn.commit()

    reopened = SessionDB(db.db_path)
    monkeypatch.setattr(server, "_get_db", lambda: reopened)
    try:
        replay = _call("companion.sessions.continue", **params)["result"]
    finally:
        reopened.close()
    assert replay["operation_state"] == "running"
    assert replay["reconciled"] is True
    assert calls == ["resume", "submit"]


def test_legacy_expanded_accepted_receipt_fails_closed_without_resubmit(db, monkeypatch):
    _session(db, "legacy-expanded")
    params = {
        "backend_namespace": "companion-test-backend",
        "profile": "atlas",
        "stored_session_id": "legacy-expanded",
        "text": "Must not replay legacy payload",
        "client_request_id": "legacy-expanded-request",
    }
    key = companion_sessions._continuity_receipt_key(
        "basic:owner", params["client_request_id"]
    )
    digest = companion_sessions._continuity_payload_digest(
        params["backend_namespace"],
        params["profile"],
        params["stored_session_id"],
        params["text"],
    )
    db._conn.execute(
        "INSERT INTO state_meta (key, value) VALUES (?, ?)",
        (
            key,
            json.dumps(
                {
                    "v": companion_sessions._CONTINUITY_RECEIPT_VERSION,
                    "state": "accepted",
                    "payload_sha256": digest,
                    "result": {
                        "session_id": "legacy-runtime",
                        "stored_session_id": params["stored_session_id"],
                        "messages": [{"role": "user", "content": params["text"]}],
                        "status": "streaming",
                        "backend_namespace": params["backend_namespace"],
                        "profile": params["profile"],
                        "cwd": "/legacy/cwd",
                        "reconciled": False,
                    },
                }
            ),
        ),
    )
    db._conn.commit()
    monkeypatch.setitem(
        server._methods,
        "session.resume",
        lambda *_args: pytest.fail("invalid legacy receipt must not resume"),
    )
    monkeypatch.setitem(
        server._methods,
        "prompt.submit",
        lambda *_args: pytest.fail("invalid legacy receipt must not submit"),
    )

    response = _call("companion.sessions.continue", **params)

    assert response["error"]["code"] == 4092


def test_unconfirmed_durable_claim_returns_uncertain_without_resubmit(db, monkeypatch):
    _session(db, "crash-window")
    params = {
        "backend_namespace": "companion-test-backend",
        "profile": "atlas",
        "stored_session_id": "crash-window",
        "text": "Possibly accepted",
        "client_request_id": "crashed-request",
    }
    key = companion_sessions._continuity_receipt_key("basic:owner", "crashed-request")
    digest = companion_sessions._continuity_payload_digest(
        params["backend_namespace"],
        params["profile"],
        params["stored_session_id"],
        params["text"],
    )
    db._conn.execute(
        "INSERT INTO state_meta (key, value) VALUES (?, ?)",
        (
            key,
            json.dumps(
                {
                    "v": companion_sessions._CONTINUITY_RECEIPT_VERSION,
                    "state": "claimed",
                    "payload_sha256": digest,
                }
            ),
        ),
    )
    db._conn.commit()
    monkeypatch.setitem(
        server._methods,
        "session.resume",
        lambda *_args, **_kwargs: pytest.fail("must not resume an uncertain claim"),
    )
    monkeypatch.setitem(
        server._methods,
        "prompt.submit",
        lambda *_args, **_kwargs: pytest.fail("must not resubmit an uncertain claim"),
    )

    result = _call("companion.sessions.continue", **params)
    assert result["error"]["code"] == 4092


def test_definitive_submit_failure_releases_claim_for_safe_retry(db, monkeypatch):
    _session(db, "retry-after-failure")
    runtime_id = "runtime-retry"
    monkeypatch.setitem(server._sessions, runtime_id, {"running": False})
    monkeypatch.setitem(
        server._methods,
        "session.resume",
        lambda rid, params: server._ok(
            rid,
            {
                "session_id": runtime_id,
                "session_key": params["session_id"],
                "resumed": params["session_id"],
                "messages": [],
            },
        ),
    )
    attempts = []

    def submit(rid, _params):
        attempts.append(rid)
        if len(attempts) == 1:
            return server._err(rid, 4500, "definitive rejection")
        return server._ok(rid, {"status": "streaming"})

    monkeypatch.setitem(server._methods, "prompt.submit", submit)
    params = {
        "backend_namespace": "companion-test-backend",
        "profile": "atlas",
        "stored_session_id": "retry-after-failure",
        "text": "Retry only after rejection",
        "client_request_id": "released-request",
    }

    assert _call("companion.sessions.continue", **params)["error"]["code"] == 4500
    replay = _call("companion.sessions.continue", **params)["result"]
    assert replay["status"] == "uncertain"
    assert replay["operation_state"] == "not_admitted"
    assert len(attempts) == 1


@pytest.mark.parametrize(
    ("change", "code"),
    [
        ({"backend_namespace": "wrong-backend"}, 4404),
        ({"profile": "coder"}, 4403),
        ({"stored_session_id": "missing"}, 4404),
        ({"text": "x" * (companion_sessions._MAX_CONTINUATION_TEXT_LENGTH + 1)}, -32602),
    ],
)
def test_registered_continue_denies_mismatched_or_unbounded_targets(db, change, code):
    _session(db, "stored-exact")
    params = {"backend_namespace": "companion-test-backend", "profile": "atlas", "stored_session_id": "stored-exact", "text": "Continue", "client_request_id": "request-denied"}
    response = _call("companion.sessions.continue", **{**params, **change})
    assert response["error"]["code"] == code


def test_companion_capabilities_revalidates_owner_lease_and_sanitizes_denial():
    cases = (
        OwnerTransport("agent:internal"),
        OwnerTransport(None),
        OwnerTransport(OwnerAuthorizationLease("basic:owner", 0.0)),
    )
    for transport in cases:
        token = bind_transport(transport)
        try:
            response = server._methods["companion.capabilities"]("denied", {})
        finally:
            reset_transport(token)

        assert response["error"] == {
            "code": 4401,
            "message": "authenticated dashboard owner required",
        }
        assert "agent:internal" not in json.dumps(response)


def test_list_is_complete_bounded_profile_scoped_and_keeps_empty_rows(db):
    _session(db, "older-desktop", started_at=10, title="Alpha launch")
    _session(db, "newer-cli", source="cli", started_at=20, title="Beta notes")
    _session(db, "zero-message", started_at=30, title="Saved empty")
    _session(db, "tool-worker", source="tool", started_at=40)
    _session(db, "kanban-worker", source="kanban", started_at=50)
    _session(db, "hidden-one", started_at=60, hidden=True)
    _session(db, "archived-one", started_at=70, archived=True)

    first = _call("companion.sessions.list", profile="atlas", limit=2)["result"]
    assert [item["root_id"] for item in first["items"]] == ["zero-message", "newer-cli"]
    assert first["items"][0]["message_count"] == 0
    assert first["has_more"] is True
    assert first["next_cursor"]
    assert first["total"] == 3
    assert first["coverage"] == "complete"
    assert first["warnings"] == []
    assert isinstance(first["as_of"], str) and first["as_of"]
    identity = first["items"][0]["identity"]
    assert identity == {
        "backend_namespace": first["backend_namespace"],
        "profile": "atlas",
        "original_id": "zero-message",
        "root_id": "zero-message",
        "resolved_tip_id": "zero-message",
    }

    # A concurrent insert is outside this cursor's snapshot and cannot shift page 2.
    _session(db, "inserted-after-page-one", started_at=999, title="New")
    second = _call(
        "companion.sessions.list",
        profile="atlas",
        limit=2,
        cursor=first["next_cursor"],
    )["result"]
    assert [item["root_id"] for item in second["items"]] == ["older-desktop"]
    assert second["has_more"] is False
    assert second["as_of"] == first["as_of"]
    assert {item["root_id"] for item in first["items"] + second["items"]} == {
        "older-desktop",
        "newer-cli",
        "zero-message",
    }

    archived = _call("companion.sessions.list", profile="atlas", view="archived")["result"]
    assert [item["root_id"] for item in archived["items"]] == ["archived-one"]
    hidden = _call("companion.sessions.list", profile="atlas", view="hidden")["result"]
    assert [item["root_id"] for item in hidden["items"]] == ["hidden-one"]

    desktop = _call("companion.sessions.list", profile="atlas", origin="desktop")["result"]
    assert all(item["origin"] == "desktop" for item in desktop["items"])
    assert "newer-cli" not in {item["root_id"] for item in desktop["items"]}

    by_title = _call("companion.sessions.list", profile="atlas", search="alpha")["result"]
    assert [item["root_id"] for item in by_title["items"]] == ["older-desktop"]
    by_id = _call("companion.sessions.list", profile="atlas", search="newer-c")["result"]
    assert [item["root_id"] for item in by_id["items"]] == ["newer-cli"]


def test_hidden_view_filters_in_sql_before_snapshot_cap(db, monkeypatch):
    _session(db, "older-hidden", started_at=1, hidden=True)
    _session(db, "new-visible-1", started_at=3)
    _session(db, "new-visible-2", started_at=2)
    monkeypatch.setattr(companion_sessions, "_MAX_SNAPSHOT_SESSIONS", 2)

    result = _call("companion.sessions.list", profile="atlas", view="hidden")["result"]

    assert [item["root_id"] for item in result["items"]] == ["older-hidden"]
    assert result["coverage"] == "complete"
    assert result["total"] == 1


def test_origin_filters_precede_batches_and_all_matches_remain_reachable(
    db, monkeypatch
):
    for index in range(5):
        _session(db, f"new-other-{index}", source="other", started_at=100 + index)
    expected = {"desktop-old", "cli-old", "desktop-older"}
    _session(db, "desktop-old", source="desktop", started_at=3)
    _session(db, "cli-old", source="cli", started_at=2)
    _session(db, "desktop-older", source="desktop", started_at=1)
    monkeypatch.setattr(companion_sessions, "_MAX_SNAPSHOT_SESSIONS", 2)
    monkeypatch.setattr(companion_sessions, "_MAX_SINGLE_SNAPSHOT_BYTES", 1)

    page = _call(
        "companion.sessions.list",
        profile="atlas",
        origin=["desktop", "cli"],
        limit=1,
    )["result"]
    collected = list(page["items"])
    while page["next_cursor"]:
        page = _call(
            "companion.sessions.list",
            profile="atlas",
            origin=["desktop", "cli"],
            limit=1,
            cursor=page["next_cursor"],
        )["result"]
        collected.extend(page["items"])

    assert {item["root_id"] for item in collected} == expected
    assert len(collected) == len(expected)
    assert page["coverage"] == "complete"
    assert page["total"] == len(expected)
    assert page["has_more"] is False


def test_list_projects_compression_identity_without_duplicate_logical_rows(db):
    _session(db, "root", started_at=10, title="Original", end_reason="compression")
    _session(db, "tip", started_at=11, title="Current", parent="root")
    db.append_message("tip", "user", "continued", timestamp=12)

    result = _call("companion.sessions.list", profile="atlas")["result"]
    assert len(result["items"]) == 1
    item = result["items"][0]
    assert item["original_id"] == "root"
    assert item["root_id"] == "root"
    assert item["resolved_tip_id"] == "tip"
    assert item["title"] == "Current"
    assert item["message_count"] == 1


def test_list_cursor_freezes_membership_and_order_across_compression_insert(db):
    _session(db, "first", started_at=30, title="First")
    _session(db, "middle", started_at=20, title="Middle")
    _session(db, "last", started_at=10, title="Last")

    first = _call("companion.sessions.list", profile="atlas", limit=1)["result"]
    assert [item["root_id"] for item in first["items"]] == ["first"]

    # Advancing an unconsumed row used to re-sort/project the live result and
    # make offset pagination skip that logical conversation.
    db._conn.execute(
        "UPDATE sessions SET end_reason = 'compression' WHERE id = 'middle'"
    )
    db._conn.commit()
    _session(db, "middle-continuation", started_at=999, parent="middle")
    db.append_message("middle-continuation", "user", "new continuation", timestamp=999)

    second = _call(
        "companion.sessions.list",
        profile="atlas",
        limit=1,
        cursor=first["next_cursor"],
    )["result"]
    third = _call(
        "companion.sessions.list",
        profile="atlas",
        limit=1,
        cursor=second["next_cursor"],
    )["result"]

    combined = first["items"] + second["items"] + third["items"]
    assert [item["root_id"] for item in combined] == ["first", "middle", "last"]
    assert [item["resolved_tip_id"] for item in combined] == ["first", "middle", "last"]
    assert len({item["root_id"] for item in combined}) == 3
    assert third["has_more"] is False
    assert second["as_of"] == third["as_of"] == first["as_of"]


def test_list_text_metadata_uses_secret_safe_projection(db):
    _session(
        db,
        "secret-preview",
        started_at=1,
        title="Deploy with OPENAI_API_KEY=abcdefghijklmnopqrstuvwxyz123456",
    )
    db.append_message(
        "secret-preview",
        "user",
        "Connect with OPENAI_API_KEY=abcdefghijklmnopqrstuvwxyz123456 before continuing",
    )

    result = _call("companion.sessions.list", profile="atlas")["result"]

    assert result["items"][0]["title"] == "Deploy with OPENAI_API_KEY=***"
    assert result["items"][0]["preview"] == "Connect with OPENAI_API_KEY=***"
    assert "abcdefghijklmnopqrstuvwxyz123456" not in json.dumps(result)


@pytest.mark.parametrize("value", [[], {}, 1, True])
def test_list_rejects_malformed_view_with_parameter_error(db, value):
    response = _call("companion.sessions.list", profile="atlas", view=value)

    assert response["error"]["code"] == -32602
    assert "view" in response["error"]["message"].lower()


def test_history_validates_alias_scalars_before_selecting_one(db):
    _session(db, "valid")

    for params in (
        {"session_id": [], "id": "valid"},
        {"session_id": "valid", "id": {}},
        {"session_id": "valid", "id": "different"},
    ):
        response = _call("companion.sessions.history", profile="atlas", **params)
        assert response["error"]["code"] == -32602


def test_list_cursor_preserves_deleted_snapshot_rows(db):
    for started_at, sid in ((4, "first"), (3, "deleted"), (2, "third"), (1, "fourth")):
        _session(db, sid, started_at=started_at)

    first = _call("companion.sessions.list", profile="atlas", limit=1)["result"]
    db._conn.execute("DELETE FROM sessions WHERE id = 'deleted'")
    db._conn.commit()

    second = _call(
        "companion.sessions.list",
        profile="atlas",
        limit=2,
        cursor=first["next_cursor"],
    )["result"]

    assert [item["root_id"] for item in second["items"]] == ["deleted", "third"]
    assert second["has_more"] is True
    assert second["coverage"] == "complete"
    assert second["total"] == 4
    assert second["warnings"] == []
    third = _call(
        "companion.sessions.list",
        profile="atlas",
        limit=2,
        cursor=second["next_cursor"],
    )["result"]
    assert [item["root_id"] for item in third["items"]] == ["fourth"]
    assert third["has_more"] is False


def test_malformed_or_scope_mismatched_cursor_fails_clearly(db):
    _session(db, "one")
    malformed = _call("companion.sessions.list", profile="atlas", cursor="not-a-cursor")
    assert malformed["error"]["code"] == 4006
    assert "cursor" in malformed["error"]["message"].lower()

    page = _call("companion.sessions.list", profile="atlas", limit=1)["result"]
    if page["next_cursor"] is None:
        _session(db, "two", started_at=2)
        page = _call("companion.sessions.list", profile="atlas", limit=1)["result"]
    mismatch = _call(
        "companion.sessions.list",
        profile="atlas",
        limit=1,
        origin="desktop",
        cursor=page["next_cursor"],
    )
    assert mismatch["error"]["code"] == 4006
    assert "scope" in mismatch["error"]["message"].lower()


def test_history_reads_persisted_lineage_only_and_returns_safe_projection(db, monkeypatch):
    _session(db, "root", started_at=1, end_reason="compression")
    _session(db, "tip", started_at=2, parent="root")
    user_id = db.append_message(
        "root",
        "user",
        "Use sk-abcdefghijklmnopqrstuvwxyz and keep api_content out",
        api_content="SECRET API SIDECAR",
        reasoning="SECRET USER REASONING",
    )
    assistant_id = db.append_message(
        "tip",
        "assistant",
        "Done",
        reasoning="SECRET CHAIN OF THOUGHT",
        reasoning_content="SECRET REASONING CONTENT",
        api_content="SECRET ASSISTANT SIDECAR",
    )
    tool_call_id = db.append_message(
        "tip",
        "assistant",
        None,
        tool_calls=[
            {
                "id": "call-1",
                "function": {"name": "terminal", "arguments": '{"token":"raw-secret"}'},
            }
        ],
    )
    tool_result_id = db.append_message(
        "tip", "tool", "RAW TOOL PAYLOAD WITH PASSWORD=hunter2", tool_name="terminal"
    )
    timeline_id = db.append_message(
        "tip", "user", "opaque internal marker", display_kind="model_switch"
    )
    system_id = db.append_message(
        "tip", "system", "PRIVATE SYSTEM INSTRUCTIONS password=hunter2"
    )

    before_sessions = dict(server._sessions)
    for forbidden in ("_sess", "_sess_nowait", "_init_session", "_activate_project_for_cwd"):
        if hasattr(server, forbidden):
            monkeypatch.setattr(
                server,
                forbidden,
                lambda *_a, _name=forbidden, **_k: pytest.fail(f"called {_name}"),
            )

    first = _call(
        "companion.sessions.history",
        profile="atlas",
        session_id="root",
        limit=3,
    )["result"]
    assert server._sessions == before_sessions
    assert first["identity"]["root_id"] == "root"
    assert first["identity"]["resolved_tip_id"] == "tip"
    assert first["has_more"] is True
    assert first["next_cursor"]
    cursor_snapshot = companion_sessions._decode_cursor(first["next_cursor"])
    assert cursor_snapshot is not None
    serialized_cursor_snapshot = json.dumps(cursor_snapshot)
    assert "PRIVATE SYSTEM INSTRUCTIONS" not in serialized_cursor_snapshot
    assert "SECRET CHAIN OF THOUGHT" not in serialized_cursor_snapshot
    assert "RAW TOOL PAYLOAD" not in serialized_cursor_snapshot
    assert [item["row_id"] for item in first["items"]] == [tool_result_id, timeline_id, system_id]
    assert first["items"][0]["kind"] == "internal_event"
    assert first["items"][0]["label"] == "Tool completed: terminal"
    assert first["items"][1]["event"] == "model_switch"
    assert first["items"][2] == {
        "kind": "internal_event",
        "event": "system_message",
        "label": "System message",
        "collapsed": True,
        "row_id": system_id,
        "segment_id": "tip",
        "timestamp": first["items"][2]["timestamp"],
    }

    # New rows are beyond the first page's message snapshot.
    db.append_message("tip", "assistant", "arrived later")
    second = _call(
        "companion.sessions.history",
        profile="atlas",
        session_id="root",
        limit=3,
        cursor=first["next_cursor"],
    )["result"]
    assert [item["row_id"] for item in second["items"]] == [
        user_id,
        assistant_id,
        tool_call_id,
    ]
    assert second["items"][0]["kind"] == "message"
    assert second["items"][0]["role"] == "user"
    assert "abcdefghijklmnopqrstuvwxyz" not in second["items"][0]["text"]
    assert set(second["items"][0]) == {"kind", "role", "text", "row_id", "segment_id", "timestamp"}
    assert second["items"][2]["event"] == "tool_call"
    assert second["items"][2]["label"] == "Assistant used one or more tools"
    assert "RAW TOOL PAYLOAD" not in json.dumps(first)
    assert "opaque internal marker" not in json.dumps(first)
    assert "PRIVATE SYSTEM INSTRUCTIONS" not in json.dumps(second)
    assert second["has_more"] is False
    assert second["as_of"] == first["as_of"]
    assert "reasoning" not in json.dumps(first).lower()
    assert "api sidecar" not in json.dumps(first).lower()


def test_history_redacts_secret_shaped_event_and_tool_metadata(db):
    _session(db, "metadata")
    secret = "OPENAI_API_KEY=abcdefghijklmnopqrstuvwxyz123456"
    secret_event_id = db.append_message(
        "metadata", "user", "hidden event body", display_kind=secret
    )
    ordinary_event_id = db.append_message(
        "metadata", "user", "hidden ordinary body", display_kind="model_switch"
    )
    secret_tool_id = db.append_message(
        "metadata", "tool", "hidden tool body", tool_name=secret
    )
    ordinary_tool_id = db.append_message(
        "metadata", "tool", "hidden ordinary tool body", tool_name="terminal"
    )

    page = _call(
        "companion.sessions.history", profile="atlas", session_id="metadata", limit=1
    )["result"]
    items = list(page["items"])
    while page["next_cursor"]:
        decoded = companion_sessions._decode_cursor(page["next_cursor"])
        assert decoded is not None
        assert "abcdefghijklmnopqrstuvwxyz123456" not in json.dumps(decoded)
        page = _call(
            "companion.sessions.history",
            profile="atlas",
            session_id="metadata",
            limit=1,
            cursor=page["next_cursor"],
        )["result"]
        items.extend(page["items"])
    by_id = {item["row_id"]: item for item in items}

    assert by_id[secret_event_id]["event"] == "OPENAI_API_KEY=***"
    assert by_id[secret_event_id]["label"] == "Openai api key=***"
    assert by_id[ordinary_event_id]["event"] == "model_switch"
    assert by_id[ordinary_event_id]["label"] == "Model switch"
    assert by_id[secret_tool_id]["label"] == "Tool completed: OPENAI_API_KEY=***"
    assert by_id[ordinary_tool_id]["label"] == "Tool completed: terminal"
    serialized = json.dumps(items)
    assert "abcdefghijklmnopqrstuvwxyz123456" not in serialized
    assert "hidden event body" not in serialized
    assert "hidden tool body" not in serialized


@pytest.mark.parametrize(
    ("role", "marker"),
    [
        ("user", "[CONTEXT SUMMARY]:"),
        ("assistant", "[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]"),
    ],
)
def test_history_collapses_compaction_summaries_without_exposing_body(role, marker):
    secret_body = "protected summary body OPENAI_API_KEY=abcdefghijklmnopqrstuvwxyz123456"

    item = companion_sessions._safe_history_message(
        role,
        f"{marker}\n{secret_body}",
        {"row_id": 1, "segment_id": "segment", "timestamp": 1.0},
    )

    assert item == {
        "kind": "internal_event",
        "event": "compaction_summary",
        "label": "Earlier context summary (details hidden)",
        "collapsed": True,
        "row_id": 1,
        "segment_id": "segment",
        "timestamp": 1.0,
    }
    assert secret_body not in json.dumps(item)
    assert "text" not in item


def test_history_cursor_preserves_deleted_snapshot_rows(db):
    _session(db, "root")
    ids = [db.append_message("root", "user", word) for word in ("one", "two", "three", "four")]
    first = _call(
        "companion.sessions.history",
        profile="atlas",
        session_id="root",
        limit=1,
    )["result"]

    db._conn.execute("DELETE FROM messages WHERE id = ?", (ids[1],))
    db._conn.commit()
    second = _call(
        "companion.sessions.history",
        profile="atlas",
        session_id="root",
        limit=3,
        cursor=first["next_cursor"],
    )["result"]

    assert [item["row_id"] for item in first["items"]] == [ids[3]]
    assert [item["row_id"] for item in second["items"]] == ids[:3]
    assert second["total"] == 4
    assert second["coverage"] == "complete"
    assert second["has_more"] is False


def test_missing_server_side_snapshot_fails_honestly(db):
    _session(db, "first", started_at=2)
    _session(db, "second", started_at=1)
    page = _call("companion.sessions.list", profile="atlas", limit=1)["result"]
    decoded = companion_sessions._decode_cursor(page["next_cursor"])
    assert decoded is not None
    assert "first" not in json.dumps(decoded)
    assert "second" not in json.dumps(decoded)
    decoded["snapshot"] = "missing-snapshot-token"
    missing_cursor = companion_sessions._encode_cursor(decoded)

    response = _call(
        "companion.sessions.list",
        profile="atlas",
        limit=1,
        cursor=missing_cursor,
    )
    assert response["error"]["code"] == 4404
    assert "snapshot" in response["error"]["message"].lower()


def test_expired_server_side_snapshot_fails_honestly(db, monkeypatch):
    _session(db, "history")
    db.append_message("history", "user", "one")
    db.append_message("history", "assistant", "two")
    page = _call(
        "companion.sessions.history",
        profile="atlas",
        session_id="history",
        limit=1,
    )["result"]
    decoded = companion_sessions._decode_cursor(page["next_cursor"])
    assert decoded is not None
    expires_at = companion_sessions._SNAPSHOT_CACHE[decoded["snapshot"]][0]
    monkeypatch.setattr(companion_sessions.time, "monotonic", lambda: expires_at)

    response = _call(
        "companion.sessions.history",
        profile="atlas",
        session_id="history",
        limit=1,
        cursor=page["next_cursor"],
    )
    assert response["error"]["code"] == 4404
    assert "expired" in response["error"]["message"].lower()


def test_history_cursor_keeps_original_lineage_snapshot_when_tip_advances(db):
    _session(db, "root", started_at=1, end_reason="compression")
    _session(db, "tip", started_at=2, parent="root")
    first_id = db.append_message("root", "user", "one")
    second_id = db.append_message("tip", "assistant", "two")
    third_id = db.append_message("tip", "user", "three")
    fourth_id = db.append_message("tip", "assistant", "four")

    first = _call(
        "companion.sessions.history",
        profile="atlas",
        session_id="root",
        limit=2,
    )["result"]
    assert [item["row_id"] for item in first["items"]] == [third_id, fourth_id]

    db._conn.execute("UPDATE sessions SET end_reason = 'compression' WHERE id = 'tip'")
    db._conn.commit()
    _session(db, "new-tip", started_at=3, parent="tip")
    later_id = db.append_message("new-tip", "assistant", "arrived after snapshot")

    second = _call(
        "companion.sessions.history",
        profile="atlas",
        session_id="root",
        limit=2,
        cursor=first["next_cursor"],
    )["result"]

    assert [item["row_id"] for item in second["items"]] == [first_id, second_id]
    assert later_id not in {item["row_id"] for item in second["items"]}
    assert second["identity"]["root_id"] == "root"
    assert second["identity"]["resolved_tip_id"] == "tip"
    assert second["total"] == 4
    assert second["has_more"] is False
    assert second["as_of"] == first["as_of"]


def test_wrong_profile_fails_closed_instead_of_falling_back_to_launch_db(db):
    response = _call("companion.sessions.list", profile="../atlas")
    assert response["error"]["code"] == 4003
    assert "profile" in response["error"]["message"].lower()


def test_unserved_valid_profile_is_denied_before_source_probe(db, monkeypatch):
    probed = []
    monkeypatch.setattr(
        companion_sessions,
        "_source",
        lambda *_args: probed.append(True),
    )

    response = _call("companion.sessions.list", profile="coder")

    assert response["error"]["code"] == 4403
    assert probed == []


def test_session_rpcs_reject_agent_shared_and_revoked_authority(db):
    _session(db, "private")
    cases = (
        OwnerTransport("agent:internal"),
        OwnerTransport(None),
        OwnerTransport(OwnerAuthorizationLease("basic:owner", 0.0)),
    )
    calls = (
        ("companion.sessions.list", {"profile": "atlas"}),
        (
            "companion.sessions.history",
            {"profile": "atlas", "session_id": "private"},
        ),
        (
            "companion.sessions.continue",
            {
                "backend_namespace": "companion-test-backend",
                "profile": "atlas",
                "stored_session_id": "private",
                "text": "Denied",
                "client_request_id": "denied-request",
            },
        ),
        (
            "companion.sessions.reconcile",
            {
                "backend_namespace": "companion-test-backend",
                "profile": "atlas",
                "stored_session_id": "private",
                "client_request_id": "denied-request",
            },
        ),
    )
    for transport in cases:
        token = bind_transport(transport)
        try:
            for method, params in calls:
                response = server._methods[method]("denied", params)
                assert response["error"]["code"] == 4401
        finally:
            reset_transport(token)


def test_session_rpc_sanitizes_unexpected_failures(db, monkeypatch):
    secret = "/private/profile/state.db"
    monkeypatch.setattr(
        companion_sessions,
        "_backend_namespace",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError(secret)),
    )

    response = _call("companion.sessions.list", profile="atlas")

    assert response["error"] == {
        "code": 5062,
        "message": "session operation unavailable",
    }
    assert secret not in json.dumps(response)


@pytest.mark.parametrize("source_kind", ["profile", "database"])
def test_symlinked_current_session_source_is_rejected(
    tmp_path, monkeypatch, source_kind
):
    real_home = tmp_path / "real-profile"
    real_home.mkdir()
    real = real_home / "state.db"
    database = SessionDB(real)
    database.close()
    if source_kind == "profile":
        alias_home = tmp_path / "profile-alias"
        alias_home.symlink_to(real_home, target_is_directory=True)
        source = alias_home / "state.db"
    else:
        source = tmp_path / "state.db"
        source.symlink_to(real)
    with pytest.raises(sqlite3.OperationalError, match="canonical regular file"):
        SessionDB(source, read_only=True)


def test_cursors_are_tamper_evident_and_reject_malicious_encodings(db):
    _session(db, "newer", started_at=2)
    _session(db, "older", started_at=1)
    db.append_message("newer", "user", "one")
    db.append_message("newer", "assistant", "two")

    list_page = _call(
        "companion.sessions.list", profile="atlas", limit=1
    )["result"]
    history_page = _call(
        "companion.sessions.history", profile="atlas", session_id="newer", limit=1
    )["result"]
    assert list_page["next_cursor"] and history_page["next_cursor"]

    _cursor_error(
        "companion.sessions.list",
        profile="atlas",
        limit=1,
        cursor=_mutate_one_byte(list_page["next_cursor"]),
    )
    _cursor_error(
        "companion.sessions.history",
        profile="atlas",
        session_id="newer",
        limit=1,
        cursor=_mutate_one_byte(history_page["next_cursor"]),
    )

    malicious = [
        "not-base64!",
        _unsigned_cursor({"v": 1, "kind": "sessions"}),
        base64.urlsafe_b64encode(b'{"v":1,"offset":NaN}').decode().rstrip("="),
        "A" * (companion_sessions._MAX_CURSOR_LENGTH + 1),
    ]
    for cursor in malicious:
        _cursor_error("companion.sessions.list", profile="atlas", cursor=cursor)


def test_forged_list_cursor_cannot_inject_hidden_or_archived_sessions(db):
    _session(db, "visible", started_at=3)
    _session(db, "visible-older", started_at=2)
    _session(db, "hidden-secret", started_at=4, hidden=True)
    _session(db, "archived-secret", started_at=5, archived=True)

    backend = _call("companion.sessions.list", profile="atlas")["result"][
        "backend_namespace"
    ]
    for forbidden in ("hidden-secret", "archived-secret"):
        forged = _unsigned_cursor(
            {
                "v": 1,
                "kind": "sessions",
                "scope": {
                    "profile": "atlas",
                    "backend": backend,
                    "view": "active",
                    "origin": "",
                    "search": "",
                },
                "offset": 0,
                "snapshot": [[forbidden, forbidden]],
                "bounded": False,
                "as_of": "2026-01-01T00:00:00Z",
            }
        )
        _cursor_error(
            "companion.sessions.list", profile="atlas", limit=1, cursor=forged
        )


def test_list_resume_keeps_snapshot_and_enforces_cursor_scope(db, monkeypatch):
    _session(db, "first", started_at=3, title="match first")
    _session(db, "second", started_at=2, title="match second")
    first = _call(
        "companion.sessions.list",
        profile="atlas",
        search="match",
        origin="desktop",
        limit=1,
    )["result"]
    cursor = first["next_cursor"]
    assert cursor

    for changed in (
        {"search": "different", "origin": "desktop"},
        {"search": "match", "origin": "cli"},
        {"search": "match", "origin": "desktop", "view": "all"},
    ):
        _cursor_error(
            "companion.sessions.list",
            profile="atlas",
            limit=1,
            cursor=cursor,
            **changed,
        )

    monkeypatch.setenv("GATEWAY_RELAY_ID", "another-backend")
    _cursor_error(
        "companion.sessions.list",
        profile="atlas",
        search="match",
        origin="desktop",
        limit=1,
        cursor=cursor,
    )
    monkeypatch.setenv("GATEWAY_RELAY_ID", "companion-test-backend")

    db._conn.execute("UPDATE sessions SET hidden = 1 WHERE id = 'second'")
    db._conn.commit()
    response = _call(
        "companion.sessions.list",
        profile="atlas",
        search="match",
        origin="desktop",
        limit=1,
        cursor=cursor,
    )["result"]
    assert [item["root_id"] for item in response["items"]] == ["second"]
    assert response["items"][0]["hidden"] is False


def test_history_cursor_rejects_future_snapshot_and_scope_mismatch(db, monkeypatch):
    _session(db, "root")
    _session(db, "other")
    db.append_message("root", "user", "one")
    db.append_message("root", "assistant", "two")
    first = _call(
        "companion.sessions.history",
        profile="atlas",
        session_id="root",
        limit=1,
    )["result"]
    cursor = first["next_cursor"]
    assert cursor

    forged = companion_sessions._decode_cursor(cursor)
    assert forged is not None
    forged["snapshot_id"] = (1 << 63) - 1
    _cursor_error(
        "companion.sessions.history",
        profile="atlas",
        session_id="root",
        limit=1,
        cursor=companion_sessions._encode_cursor(forged),
    )

    _cursor_error(
        "companion.sessions.history",
        profile="atlas",
        session_id="other",
        limit=1,
        cursor=cursor,
    )
    monkeypatch.setattr(
        companion_sessions,
        "_owner_authorized_profiles",
        lambda _server: frozenset({"atlas", "default"}),
    )
    _cursor_error(
        "companion.sessions.history",
        profile="default",
        session_id="root",
        limit=1,
        cursor=cursor,
    )
    monkeypatch.setenv("GATEWAY_RELAY_ID", "another-backend")
    _cursor_error(
        "companion.sessions.history",
        profile="atlas",
        session_id="root",
        limit=1,
        cursor=cursor,
    )


def test_authenticated_cursor_values_are_strictly_bounded(db):
    _session(db, "one", started_at=2)
    _session(db, "two", started_at=1)
    list_page = _call(
        "companion.sessions.list", profile="atlas", limit=1
    )["result"]
    list_value = companion_sessions._decode_cursor(list_page["next_cursor"])
    assert list_value is not None

    for invalid in (True, float("nan"), 1 << 80):
        candidate = dict(list_value)
        candidate["offset"] = invalid
        _cursor_error(
            "companion.sessions.list",
            profile="atlas",
            limit=1,
            cursor=companion_sessions._encode_cursor(candidate),
        )
    candidate = dict(list_value)
    candidate["snapshot"] = [["x" * 513, "two"]]
    candidate["offset"] = 0
    _cursor_error(
        "companion.sessions.list",
        profile="atlas",
        limit=1,
        cursor=companion_sessions._encode_cursor(candidate),
    )

    db.append_message("one", "user", "one")
    db.append_message("one", "assistant", "two")
    history_page = _call(
        "companion.sessions.history", profile="atlas", session_id="one", limit=1
    )["result"]
    history_value = companion_sessions._decode_cursor(history_page["next_cursor"])
    assert history_value is not None
    for invalid in (True, float("nan"), 1 << 80):
        candidate = dict(history_value)
        candidate["offset"] = invalid
        _cursor_error(
            "companion.sessions.history",
            profile="atlas",
            session_id="one",
            limit=1,
            cursor=companion_sessions._encode_cursor(candidate),
        )
    candidate = dict(history_value)
    candidate["snapshot"] = "x" * 129
    _cursor_error(
        "companion.sessions.history",
        profile="atlas",
        session_id="one",
        limit=1,
        cursor=companion_sessions._encode_cursor(candidate),
    )
