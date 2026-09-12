from datetime import datetime, timezone
import json
import sqlite3
import threading

import pytest

from hermes_cli.companion_organization import (
    OrganizationStore,
    SourceNamespace,
    SourceSessionRef,
    WorkBinding,
)
from hermes_cli.companion_work_store import WorkStore
from hermes_state import SessionDB
from tui_gateway import server


WORK_PAYLOAD = {
    "title": "Prepare campaign",
    "brief": "A bounded business brief",
    "evidence": ["verified evidence"],
    "next_action": "Review preparation",
    "owner": "Pawel",
}


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
        {"question": "Which environment?", "work_ref": {"profile": "worker", "id": "work-42"}},
    )
    server._pending["secret-id"] = ("rt", event)
    server._pending_prompt_payloads["secret-id"] = (
        "secret.request",
        {"prompt": "API_TOKEN=super-secret", "work_ref": {"profile": "../worker", "id": "work-42"}},
    )
    monkeypatch.setattr("tools.approval.list_gateway_approvals", lambda _key: [])

    items = _attention()
    assert {(item["kind"], item["profile"]) for item in items} == {
        ("question", "worker"),
        ("blocker", "worker"),
    }
    assert all(item["runtime_session_id"] == "rt" for item in items)
    assert all(item["stored_session_id"] == "stored" for item in items)
    assert all("work_ref" not in item for item in items)
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
            "work_ref": {"profile": "default", "id": "work-approval"},
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
    assert "work_ref" not in approval


def test_completion_requires_live_turn_and_outcomes_clear(monkeypatch):
    session = _live()
    monkeypatch.setattr("tools.approval.list_gateway_approvals", lambda _key: [])
    server._emit("message.complete", "rt", {"text": "idle replay"})
    assert _attention() == []

    session["running"] = True
    session["inflight_turn"] = {"user": "work"}
    server._emit("message.complete", "rt", {"text": "sensitive answer"})
    server._companion_attention_outcomes["rt"]["work_ref"] = {
        "profile": "default", "id": "work-completion"
    }
    assert [item["kind"] for item in _attention()] == ["completion"]
    assert "work_ref" not in _attention()[0]
    assert "sensitive answer" not in repr(_attention())

    server._clear_companion_attention_outcome("rt")
    assert _attention() == []
    server._emit("error", "rt", {"message": "boom"})
    assert _attention()[0]["kind"] == "error"
    server._pop_session_by_id("rt")
    assert server._companion_attention_outcomes == {}


def _durable_binding(monkeypatch, tmp_path, *, work_count=1,
                     reference_backend: str | None = "backend-a",
                     reference_profile="worker", reference_session="stored", stale_source=False,
                     relay_id: str | None = "backend-a", work_kind="companion_card"):
    root = tmp_path / ".hermes"
    profile_home = root / "profiles" / "worker"
    profile_home.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(root))
    if relay_id is None:
        monkeypatch.delenv("GATEWAY_RELAY_ID", raising=False)
        monkeypatch.delenv("GATEWAY_RELAY_INSTANCE_ID", raising=False)
        monkeypatch.setenv("HERMES_MACHINE_ID", "attention-test-machine")
        monkeypatch.setattr(server, "_load_cfg", lambda: {})
    else:
        monkeypatch.setenv("GATEWAY_RELAY_ID", relay_id)
    monkeypatch.setattr(server, "_hermes_home", profile_home)
    monkeypatch.setattr(server, "_current_profile_name", lambda: "worker")

    if reference_backend is None:
        from tui_gateway.companion_projects import _backend_namespace

        reference_backend = _backend_namespace(server, installation_home=root)

    work = WorkStore(profile_home / "companion-work.db", "worker")
    organization = OrganizationStore(profile_home=profile_home, profile="worker")
    source_namespace = SourceNamespace(reference_backend, reference_profile)
    card_ids = []
    for index in range(work_count):
        card = work.upsert(f"source-{index}", WORK_PAYLOAD)["item"]
        card_ids.append(card["id"])
        source_session = SourceSessionRef(
            source_namespace, reference_session, f"root-{index}", f"tip-{index}"
        )
        organization.create_work_binding(
            WorkBinding(
                id=f"binding-{index}",
                source_namespace=source_namespace,
                work_kind=work_kind,
                source_work_id=f"missing-{index}" if stale_source else card["id"],
                primary_session=source_session if index == 0 else None,
                related_sessions=(source_session,) if index else (),
                attributed_by="agent:test",
            ),
            actor="agent:test",
        )
    return profile_home, work, card_ids


def test_attention_derives_stable_work_identity_from_durable_binding(monkeypatch, tmp_path):
    profile_home, work, card_ids = _durable_binding(monkeypatch, tmp_path)
    card = work.propose(card_ids[0], 1)["item"]
    _live(profile_home=profile_home)
    monkeypatch.setattr(
        "tools.approval.list_gateway_approvals",
        lambda _key: [{"request_id": "mutable-old-id", "work_ref": {
            "profile": "spoof", "id": "not-the-card"
        }}],
    )

    first = _attention()[0]
    assert first["id"] == "approval:rt:mutable-old-id"
    assert first["work_ref"] == {"profile": "worker", "id": card_ids[0]}

    work.decide(
        card["id"], card["version"], card["revision"], "snooze", "decision-1",
        snoozed_until=datetime(2099, 1, 1, tzinfo=timezone.utc).isoformat(),
        human_identity="test-owner",
    )
    monkeypatch.setattr(
        "tools.approval.list_gateway_approvals",
        lambda _key: [{"request_id": "mutable-new-id"}],
    )
    changed = _attention()[0]
    assert changed["id"] == "approval:rt:mutable-new-id"
    assert changed["work_ref"] == first["work_ref"]


def test_attention_uses_launch_home_for_derived_backend_namespace(monkeypatch, tmp_path):
    profile_home, _work, card_ids = _durable_binding(
        monkeypatch, tmp_path, reference_backend=None, relay_id=None
    )
    _live(profile_home=profile_home)
    monkeypatch.setattr(
        "tools.approval.list_gateway_approvals",
        lambda _key: [{"request_id": "approval-with-derived-backend"}],
    )

    item = _attention()[0]
    assert item["work_ref"] == {"profile": "worker", "id": card_ids[0]}


def test_attention_preserves_runtime_item_for_foreign_work_kind(monkeypatch, tmp_path):
    profile_home, _work, _card_ids = _durable_binding(
        monkeypatch, tmp_path, work_kind="foreign_work"
    )
    _live(profile_home=profile_home)
    monkeypatch.setattr(
        "tools.approval.list_gateway_approvals",
        lambda _key: [{"request_id": "approval-foreign-kind"}],
    )

    items = _attention()
    assert len(items) == 1
    assert items[0]["id"] == "approval:rt:approval-foreign-kind"
    assert "work_ref" not in items[0]


@pytest.mark.parametrize(
    ("work_count", "reference_backend", "reference_profile", "reference_session", "work_state"),
    [
        (2, "backend-a", "worker", "stored", "valid"),
        (1, "backend-b", "worker", "stored", "valid"),
        (1, "backend-a", "other-profile", "stored", "valid"),
        (1, "backend-a", "worker", "other-session", "valid"),
        (1, "backend-a", "worker", "stored", "stale"),
        (1, "backend-a", "worker", "stored", "missing"),
        (1, "backend-a", "worker", "stored", "invalid"),
    ],
)
def test_attention_preserves_runtime_item_when_binding_is_not_unique_and_exact(
    monkeypatch, tmp_path, work_count, reference_backend, reference_profile, reference_session,
    work_state,
):
    profile_home, _work, _card_ids = _durable_binding(
        monkeypatch,
        tmp_path,
        work_count=work_count,
        reference_backend=reference_backend,
        reference_profile=reference_profile,
        reference_session=reference_session,
        stale_source=work_state == "stale",
    )
    work_path = profile_home / "companion-work.db"
    if work_state in {"missing", "invalid"}:
        work_path.unlink()
    if work_state == "invalid":
        work_path.write_bytes(b"not a sqlite database")
    _live(profile_home=profile_home)
    monkeypatch.setattr(
        "tools.approval.list_gateway_approvals",
        lambda _key: [{"request_id": "approval-1", "work_ref": {
            "profile": "worker", "id": "spoofed"
        }}],
    )

    items = _attention()
    assert len(items) == 1
    assert items[0]["id"] == "approval:rt:approval-1"
    assert "work_ref" not in items[0]
    if work_state == "missing":
        assert not work_path.exists()
    elif work_state == "invalid":
        assert work_path.read_bytes() == b"not a sqlite database"


@pytest.mark.parametrize("work_state", ["ideas", "in_progress", "done", "declined"])
def test_attention_rejects_snooze_outside_needs_me_without_hiding_runtime_item(
    monkeypatch, tmp_path, work_state,
):
    profile_home, work, card_ids = _durable_binding(monkeypatch, tmp_path)
    card = work.get(card_ids[0])["item"]
    if work_state != "ideas":
        card = work.propose(card["id"], card["version"])["item"]
    if work_state == "declined":
        card = work.decide(
            card["id"], card["version"], card["revision"], "decline",
            "decline-illegal-snooze", human_identity="test-owner",
        )["item"]
    elif work_state in {"in_progress", "done"}:
        card = work.decide(
            card["id"], card["version"], card["revision"], "approve_preparation",
            "approve-illegal-snooze", human_identity="test-owner",
        )["item"]
        if work_state == "done":
            card = work.preparation_ack(
                card["id"], card["version"], card["revision"], card["handoff_key"],
                "tracker:illegal-snooze", "ack-illegal-snooze",
            )["item"]
            card = work.preparation_status_update(
                card["id"], card["version"], card["revision"], card["handoff_key"], {
                    "state": "prepared",
                    "execution_ref": "tracker:illegal-snooze",
                    "observed_at": "2026-09-06T10:00:00Z",
                    "evidence": ["tracker reports prepared"],
                    "result_evidence": ["artifact:prepared-result"],
                }, "prepare-illegal-snooze",
            )["item"]
            card = work.complete(card["id"], card["version"], "trusted read-back")["item"]

    work_path = profile_home / "companion-work.db"
    with sqlite3.connect(work_path) as db:
        db.execute(
            "UPDATE work_cards SET snoozed_until=? WHERE id=?",
            ("2099-01-01T00:00:00+00:00", card["id"]),
        )
    before = work_path.read_bytes()
    _live(profile_home=profile_home)
    monkeypatch.setattr(
        "tools.approval.list_gateway_approvals",
        lambda _key: [{"request_id": f"approval-illegal-snooze-{work_state}"}],
    )

    items = _attention()

    assert len(items) == 1
    assert items[0]["id"] == f"approval:rt:approval-illegal-snooze-{work_state}"
    assert "work_ref" not in items[0]
    assert work_path.read_bytes() == before


@pytest.mark.parametrize(
    "malformation",
    [
        "approval_missing",
        "execution_link_missing",
        "tracker_missing",
        "completion_missing",
        "link_handoff_mismatch",
        "tracker_handoff_mismatch",
        "tracker_execution_mismatch",
        "tracker_state_mismatch",
        "completion_result_mismatch",
        "legacy_completion_with_tracker",
    ],
)
def test_attention_rejects_impossible_done_lifecycle_without_hiding_runtime_item(
    monkeypatch, tmp_path, malformation,
):
    profile_home, work, card_ids = _durable_binding(monkeypatch, tmp_path)
    card = work.propose(card_ids[0], 1)["item"]
    approved = work.decide(
        card["id"], card["version"], card["revision"], "approve_preparation",
        "approve-impossible-done", human_identity="test-owner",
    )["item"]
    linked = work.preparation_ack(
        approved["id"], approved["version"], approved["revision"],
        approved["handoff_key"], "tracker:done-task", "ack-impossible-done",
    )["item"]
    prepared = work.preparation_status_update(
        linked["id"], linked["version"], linked["revision"], linked["handoff_key"], {
            "state": "prepared",
            "execution_ref": "tracker:done-task",
            "observed_at": "2026-09-06T10:00:00Z",
            "evidence": ["tracker reports prepared"],
            "result_evidence": ["artifact:prepared-result"],
        }, "prepare-impossible-done",
    )["item"]
    work.complete(prepared["id"], prepared["version"], "trusted read-back")

    work_path = profile_home / "companion-work.db"
    with sqlite3.connect(work_path) as db:
        if malformation.endswith("_missing"):
            column = {
                "approval_missing": "approval",
                "execution_link_missing": "execution_link",
                "tracker_missing": "tracker_evidence",
                "completion_missing": "completion_evidence",
            }[malformation]
            db.execute(f"UPDATE work_cards SET {column}=NULL WHERE id=?", (card_ids[0],))
        elif malformation in {"completion_result_mismatch", "legacy_completion_with_tracker"}:
            completion = (
                json.dumps(["artifact:different-result"])
                if malformation == "completion_result_mismatch"
                else "legacy tracker read-back"
            )
            db.execute(
                "UPDATE work_cards SET completion_evidence=? WHERE id=?",
                (completion, card_ids[0]),
            )
        else:
            column = "execution_link" if malformation == "link_handoff_mismatch" else "tracker_evidence"
            raw = db.execute(
                f"SELECT {column} FROM work_cards WHERE id=?", (card_ids[0],)
            ).fetchone()[0]
            evidence = json.loads(raw)
            if malformation in {"link_handoff_mismatch", "tracker_handoff_mismatch"}:
                evidence["handoff_key"] = "worker:wrong-card:wrong-decision"
            elif malformation == "tracker_execution_mismatch":
                evidence["execution_ref"] = "tracker:wrong-task"
            else:
                evidence["state"] = "preparing"
                evidence.pop("result_evidence")
            db.execute(
                f"UPDATE work_cards SET {column}=? WHERE id=?",
                (json.dumps(evidence), card_ids[0]),
            )

    before = work_path.read_bytes()
    _live(profile_home=profile_home)
    monkeypatch.setattr(
        "tools.approval.list_gateway_approvals",
        lambda _key: [{"request_id": "approval-impossible-done"}],
    )

    items = _attention()

    assert len(items) == 1
    assert items[0]["id"] == "approval:rt:approval-impossible-done"
    assert "work_ref" not in items[0]
    assert work_path.read_bytes() == before


@pytest.mark.parametrize("malformation", ["minimal_schema", "payload", "state"])
def test_attention_rejects_noncanonical_work_rows_without_hiding_runtime_item(
    monkeypatch, tmp_path, malformation,
):
    profile_home, _work, card_ids = _durable_binding(monkeypatch, tmp_path)
    work_path = profile_home / "companion-work.db"
    if malformation == "minimal_schema":
        work_path.unlink()
        with sqlite3.connect(work_path) as db:
            db.execute("CREATE TABLE inbox_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            db.execute("INSERT INTO inbox_meta VALUES ('profile', 'worker')")
            db.execute("CREATE TABLE work_cards (id TEXT PRIMARY KEY)")
            db.execute("INSERT INTO work_cards VALUES (?)", (card_ids[0],))
    else:
        with sqlite3.connect(work_path) as db:
            db.execute(
                f"UPDATE work_cards SET {malformation}=? WHERE id=?",
                ("not-json" if malformation == "payload" else "unknown", card_ids[0]),
            )
    before = work_path.read_bytes()
    _live(profile_home=profile_home)
    monkeypatch.setattr(
        "tools.approval.list_gateway_approvals",
        lambda _key: [{"request_id": "approval-corrupt-work"}],
    )

    items = _attention()

    assert len(items) == 1
    assert items[0]["id"] == "approval:rt:approval-corrupt-work"
    assert "work_ref" not in items[0]
    assert work_path.read_bytes() == before


def test_session_list_hidden_exact_lookup_and_fields(monkeypatch, tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session("bot", source="companion")
    db.set_session_title("bot", "Bot Chat")
    db.set_session_hidden("bot", True)
    db.set_session_pinned("bot", True)
    db.append_message("bot", role="user", content="hello")
    monkeypatch.setattr(server, "_get_db", lambda: db)

    hidden = server._methods["session.list"]("r1", {"title": "Bot Chat"})
    # Hidden canonical rows resolve on exact-title lookup (current-main contract):
    # the desktop's click-open path sends no flags, so hiding them here would
    # make the desktop mint replacements forever.
    found = hidden["result"]["sessions"][0]
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

    default = server._methods["session.list"]("r1", {"title": "Bot Chat"})
    # Archived rows stay hidden unless explicitly requested.
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
