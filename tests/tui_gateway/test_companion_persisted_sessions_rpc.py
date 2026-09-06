"""Behavior contract for Companion's persisted, read-only session projections."""

from __future__ import annotations

import base64
import json
import sqlite3

import pytest

from hermes_cli.dashboard_auth.ws_tickets import OwnerAuthorizationLease
from hermes_state import SessionDB
from tui_gateway import companion_sessions, server
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
    assert "companion.capabilities" in server._methods

    result = _call("companion.capabilities")["result"]
    assert result["companion.sessions"] == 1
    assert set(result["methods"]) >= {
        "companion.sessions.list",
        "companion.sessions.history",
    }


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
            "code": 4403,
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
    assert [item["row_id"] for item in first["items"]] == [user_id, assistant_id, tool_call_id]
    assert first["items"][0]["kind"] == "message"
    assert first["items"][0]["role"] == "user"
    assert "abcdefghijklmnopqrstuvwxyz" not in first["items"][0]["text"]
    assert set(first["items"][0]) == {"kind", "role", "text", "row_id", "segment_id", "timestamp"}
    assert first["items"][2] == {
        "kind": "internal_event",
        "event": "tool_call",
        "label": "Assistant used one or more tools",
        "collapsed": True,
        "row_id": tool_call_id,
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
        tool_result_id,
        timeline_id,
        system_id,
    ]
    assert second["items"][0]["kind"] == "internal_event"
    assert second["items"][0]["label"] == "Tool completed: terminal"
    assert "RAW TOOL PAYLOAD" not in json.dumps(second)
    assert second["items"][1]["event"] == "model_switch"
    assert "opaque internal marker" not in json.dumps(second)
    assert second["items"][2]["event"] == "system_message"
    assert second["items"][2]["collapsed"] is True
    assert "text" not in second["items"][2]
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

    assert [item["row_id"] for item in second["items"]] == ids[1:]
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
    assert [item["row_id"] for item in first["items"]] == [first_id, second_id]

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

    assert [item["row_id"] for item in second["items"]] == [third_id, fourth_id]
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
    )
    for transport in cases:
        token = bind_transport(transport)
        try:
            for method, params in calls:
                response = server._methods[method]("denied", params)
                assert response["error"]["code"] == 4403
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
