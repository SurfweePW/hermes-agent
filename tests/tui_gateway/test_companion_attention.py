import threading

import pytest

from hermes_state import SessionDB
from tui_gateway import server


@pytest.fixture(autouse=True)
def clean_live_state(monkeypatch):
    monkeypatch.setattr(server, "write_json", lambda _frame: None)
    server._sessions.clear()
    server._pending.clear()
    server._pending_prompt_payloads.clear()
    server._companion_attention_outcomes.clear()
    yield
    server._sessions.clear()
    server._pending.clear()
    server._pending_prompt_payloads.clear()
    server._companion_attention_outcomes.clear()


def _live(sid="rt", key="stored", profile_home=None, **extra):
    session = {
        "_sid": sid,
        "session_key": key,
        "profile_home": str(profile_home) if profile_home else None,
        "last_active": 10,
        "running": False,
        "inflight_turn": None,
    }
    session.update(extra)
    server._sessions[sid] = session
    return session


def _attention():
    response = server._methods["attention.list"]("r", {})
    assert "error" not in response, response
    assert response["result"]["scope"] == "connected_runtime"
    assert response["result"]["scope_note"]
    return response["result"]["items"]


def test_attention_aggregates_live_prompts_with_profile_identity(monkeypatch, tmp_path):
    profile = tmp_path / "profiles" / "worker"
    _live(profile_home=profile)
    event = threading.Event()
    server._pending["clarify-id"] = ("rt", event)
    server._pending_prompt_payloads["clarify-id"] = (
        "clarify.request",
        {"question": "Which environment?"},
    )
    server._pending["secret-id"] = ("rt", event)
    server._pending_prompt_payloads["secret-id"] = (
        "secret.request",
        {"prompt": "API_TOKEN=super-secret"},
    )
    monkeypatch.setattr("tools.approval.list_gateway_approvals", lambda _key: [])

    items = _attention()
    assert {(item["kind"], item["profile"]) for item in items} == {
        ("question", "worker"),
        ("blocker", "worker"),
    }
    assert all(item["runtime_session_id"] == "rt" for item in items)
    assert all(item["stored_session_id"] == "stored" for item in items)
    assert "super-secret" not in repr(items)


def test_attention_redacts_approval_and_error_payloads(monkeypatch):
    _live(running=True, inflight_turn={"user": "go"})
    monkeypatch.setattr(
        "tools.approval.list_gateway_approvals",
        lambda _key: [{
            "request_id": "approval-1",
            "command": "curl -H 'Authorization: Bearer secret-token'",
            "description": "run secret-token",
            "pattern_keys": ["secret-token"],
            "choices": ["once", "always", "malicious"],
            "allow_permanent": True,
        }],
    )
    server._emit("error", "rt", {"message": "password=secret-token"})

    items = _attention()
    assert {item["kind"] for item in items} == {"approval", "error"}
    assert "secret-token" not in repr(items)
    approval = next(item for item in items if item["kind"] == "approval")
    assert approval["request"] == {
        "request_id": "approval-1",
        "allow_session": False,
        "allow_permanent": True,
        "choices": ["once", "always"],
    }
    assert approval["actionable"] is True
    assert approval["resolution"] == "approval"


def test_completion_requires_live_turn_and_outcomes_clear(monkeypatch):
    session = _live()
    monkeypatch.setattr("tools.approval.list_gateway_approvals", lambda _key: [])
    server._emit("message.complete", "rt", {"text": "idle replay"})
    assert _attention() == []

    session["running"] = True
    session["inflight_turn"] = {"user": "work"}
    server._emit("message.complete", "rt", {"text": "sensitive answer"})
    assert [item["kind"] for item in _attention()] == ["completion"]
    assert "sensitive answer" not in repr(_attention())

    server._clear_companion_attention_outcome("rt")
    assert _attention() == []
    server._emit("error", "rt", {"message": "boom"})
    assert _attention()[0]["kind"] == "error"
    server._pop_session_by_id("rt")
    assert server._companion_attention_outcomes == {}


def test_session_list_hidden_exact_lookup_and_fields(monkeypatch, tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session("bot", source="companion")
    db.set_session_title("bot", "Bot Chat")
    db.set_session_hidden("bot", True)
    db.set_session_pinned("bot", True)
    db.append_message("bot", role="user", content="hello")
    monkeypatch.setattr(server, "_get_db", lambda: db)

    hidden = server._methods["session.list"]("r1", {"title": "Bot Chat"})
    assert hidden["result"]["sessions"] == []
    found = server._methods["session.list"](
        "r2", {"title": "Bot Chat", "include_hidden": True}
    )["result"]["sessions"][0]
    assert found["id"] == "bot"
    assert found["pinned"] is True
    assert found["last_active"] > 0
    db.close()


def test_session_list_can_resolve_archived_canonical_title(monkeypatch, tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session("bot", source="companion")
    db.set_session_title("bot", "Bot Chat")
    db.set_session_hidden("bot", True)
    db.set_session_archived("bot", True)
    monkeypatch.setattr(server, "_get_db", lambda: db)

    default = server._methods["session.list"](
        "r1", {"title": "Bot Chat", "include_hidden": True}
    )
    assert default["result"]["sessions"] == []
    found = server._methods["session.list"](
        "r2", {
            "title": "Bot Chat",
            "include_hidden": True,
            "include_archived": True,
        },
    )["result"]["sessions"][0]
    assert found["id"] == "bot"
    db.close()


def test_session_set_pinned_is_profile_isolated(monkeypatch, tmp_path):
    launch = SessionDB(db_path=tmp_path / "launch.db")
    launch.create_session("same", source="tui")
    launch.set_session_title("same", "Launch")
    profile_home = tmp_path / "profiles" / "worker"
    profile_home.mkdir(parents=True)
    profile = SessionDB(db_path=profile_home / "state.db")
    profile.create_session("same", source="tui")
    profile.set_session_title("same", "Worker")
    profile.close()

    monkeypatch.setattr(server, "_get_db", lambda: launch)
    monkeypatch.setattr(
        server, "_profile_home", lambda name: profile_home if name == "worker" else None
    )
    response = server._methods["session.set_pinned"](
        "r", {"profile": "worker", "session_id": "same", "pinned": True}
    )
    assert response["result"] == {"pinned": True, "session_id": "same", "changed": True}
    worker = SessionDB(db_path=profile_home / "state.db")
    assert worker.get_session("same")["pinned"] == 1
    assert launch.get_session("same")["pinned"] == 0
    worker.close()
    launch.close()


def test_session_set_pinned_rejects_unknown_or_unsafe_profile(monkeypatch, tmp_path):
    launch = SessionDB(db_path=tmp_path / "launch.db")
    launch.create_session("same", source="tui")
    monkeypatch.setattr(server, "_get_db", lambda: launch)
    monkeypatch.setattr(server, "_profile_home", lambda _name: None)

    unknown = server._methods["session.set_pinned"](
        "r1", {"profile": "missing", "session_id": "same", "pinned": True}
    )
    unsafe = server._methods["session.set_pinned"](
        "r2", {"profile": "../atlas", "session_id": "same", "pinned": True}
    )

    assert unknown["error"]["code"] == 4001
    assert unsafe["error"]["code"] == 4006
    assert launch.get_session("same")["pinned"] == 0
    launch.close()
