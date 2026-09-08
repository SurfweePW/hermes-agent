from __future__ import annotations

from datetime import datetime, timezone
import json
from urllib.error import URLError

import pytest

from hermes_cli import companion_kanban_bridge as bridge_module
from hermes_cli.companion_kanban_bridge import (
    BridgeError,
    CompanionKanbanBridge,
    KanbanIntakeClient,
)
from hermes_cli.companion_work_store import WorkStore


PAYLOAD = {
    "title": "Prepare HOFFEE campaign brief",
    "brief": "Produce an internal campaign brief only.",
    "evidence": ["library:research/customer-language-v3"],
    "next_action": "Draft the brief; do not publish or spend.",
    "owner": "hoffeecmo",
}
NOW = datetime(2026, 9, 8, 12, 0, tzinfo=timezone.utc)


def approved(store: WorkStore):
    item = store.upsert("campaign:autumn", PAYLOAD)["item"]
    item = store.propose(item["id"], item["version"])["item"]
    return store.decide(
        item["id"], item["version"], item["revision"],
        "approve_preparation", "owner-approval", human_identity="basic:pawel",
    )["item"]


class FakeIntake:
    def __init__(self):
        self.tasks = {}
        self.create_calls = 0
        self.fail_after_create_once = False

    def create(self, payload):
        self.create_calls += 1
        key = payload["idempotency_key"]
        task = self.tasks.setdefault(key, {
            "id": "t_12345678", "title": payload["title"], "body": payload["body"],
            "status": "triage", "priority": payload["priority"],
            "assignee": "hoffeecmo", "tenant": "hoffee", "workspace_kind": "scratch",
            "idempotency_key": key, "created_at": 1, "completed_at": None, "result": None,
        })
        if self.fail_after_create_once:
            self.fail_after_create_once = False
            raise BridgeError("intake response unavailable")
        return dict(task)

    def get(self, task_id):
        task = next(value for value in self.tasks.values() if value["id"] == task_id)
        return dict(task)


def test_approval_handoff_is_one_logical_task_and_survives_uncertain_restart(tmp_path):
    path = tmp_path / "work.db"
    store = WorkStore(path, "hoffeecmo", clock=lambda: NOW)
    item = approved(store)
    intake = FakeIntake()
    intake.fail_after_create_once = True

    first = CompanionKanbanBridge(store, intake, clock=lambda: NOW).reconcile_once()
    assert first == {"examined": 1, "linked": 0, "updated": 1, "completed": 0, "errors": 1}
    uncertain = store.get(item["id"])["item"]
    assert uncertain["preparation_status"] == "status_unavailable"
    assert uncertain["handoff_reconciliation_required"] is True

    reopened = WorkStore(path, "hoffeecmo", clock=lambda: NOW)
    second = CompanionKanbanBridge(reopened, intake, clock=lambda: NOW).reconcile_once()
    assert second == {"examined": 1, "linked": 1, "updated": 0, "completed": 0, "errors": 0}
    linked = reopened.get(item["id"])["item"]
    assert linked["execution_link"]["execution_ref"] == "kanban:hoffee:t_12345678"
    assert linked["preparation_status"] == "linked_awaiting_triage"
    assert intake.create_calls == 2
    assert len(intake.tasks) == 1
    assert next(iter(intake.tasks)) == item["handoff_key"]

    assert CompanionKanbanBridge(reopened, intake, clock=lambda: NOW).reconcile_once() == {
        "examined": 1, "linked": 0, "updated": 0, "completed": 0, "errors": 0,
    }
    assert intake.create_calls == 2


def test_restart_applies_recovered_task_status_in_same_reconcile(tmp_path):
    path = tmp_path / "work.db"
    store = WorkStore(path, "hoffeecmo", clock=lambda: NOW)
    source = approved(store)
    intake = FakeIntake()
    intake.fail_after_create_once = True

    assert CompanionKanbanBridge(store, intake, clock=lambda: NOW).reconcile_once()["errors"] == 1
    task = intake.tasks[source["handoff_key"]]
    task["status"] = "blocked"
    task["result"] = "Waiting for approved source photography"

    reopened = WorkStore(path, "hoffeecmo", clock=lambda: NOW)
    bridge = CompanionKanbanBridge(reopened, intake, clock=lambda: NOW)
    assert bridge.reconcile_once() == {
        "examined": 1, "linked": 1, "updated": 1, "completed": 0, "errors": 0,
    }
    recovered = reopened.get(source["id"])["item"]
    assert recovered["preparation_status"] == "blocked"
    assert recovered["tracker_evidence"]["evidence"] == [
        "kanban:hoffee:t_12345678:status=blocked",
    ]
    assert recovered["tracker_evidence"]["blocker"] == task["result"]
    assert intake.create_calls == 2

    assert bridge.reconcile_once() == {
        "examined": 1, "linked": 0, "updated": 0, "completed": 0, "errors": 0,
    }
    assert intake.create_calls == 2


def test_authoritative_kanban_states_map_to_truthful_preparation_and_done(tmp_path):
    store = WorkStore(tmp_path / "work.db", "hoffeecmo", clock=lambda: NOW)
    source = approved(store)
    intake = FakeIntake()
    bridge = CompanionKanbanBridge(store, intake, clock=lambda: NOW)
    bridge.reconcile_once()
    task = intake.tasks[source["handoff_key"]]

    task["status"] = "running"
    assert bridge.reconcile_once()["updated"] == 1
    assert store.get(source["id"])["item"]["preparation_status"] == "preparing"

    task["status"] = "ready"
    assert bridge.reconcile_once()["updated"] == 1
    assert store.get(source["id"])["item"]["preparation_status"] == "linked_awaiting_triage"

    task["status"] = "running"
    assert bridge.reconcile_once()["updated"] == 1

    task["status"] = "blocked"
    task["result"] = "Waiting for approved source photography"
    assert bridge.reconcile_once()["updated"] == 1
    blocked = store.get(source["id"])["item"]
    assert blocked["preparation_status"] == "blocked"
    assert blocked["tracker_evidence"]["blocker"] == task["result"]

    task["status"] = "done"
    task["completed_at"] = 1_788_870_000
    task["result"] = "library:campaigns/autumn/brief-v1.pdf"
    result = bridge.reconcile_once()
    assert result["updated"] == 1 and result["completed"] == 1
    done = store.get(source["id"])["item"]
    assert done["state"] == "done"
    assert done["preparation_status"] == "prepared"
    assert done["completion_evidence"] == [task["result"]]
    assert done["publication_status"] == "not_authorized"
    assert [event["state"] for event in store.get(source["id"])["tracker_status_history"]] == [
        "preparing", "linked_awaiting_triage", "preparing", "blocked", "prepared",
    ]


def test_done_without_result_is_status_unavailable_not_prepared(tmp_path):
    store = WorkStore(tmp_path / "work.db", "hoffeecmo", clock=lambda: NOW)
    source = approved(store)
    intake = FakeIntake()
    bridge = CompanionKanbanBridge(store, intake, clock=lambda: NOW)
    bridge.reconcile_once()
    intake.tasks[source["handoff_key"]]["status"] = "done"

    result = bridge.reconcile_once()
    item = store.get(source["id"])["item"]
    assert result["completed"] == 0
    assert item["state"] == "in_progress"
    assert item["preparation_status"] == "status_unavailable"
    assert "result evidence" in item["tracker_evidence"]["evidence"][0]


def test_restart_completes_after_crash_between_prepared_status_and_complete(tmp_path):
    class SimulatedCrash(BaseException):
        pass

    path = tmp_path / "work.db"
    store = WorkStore(path, "hoffeecmo", clock=lambda: NOW)
    source = approved(store)
    intake = FakeIntake()
    bridge = CompanionKanbanBridge(store, intake, clock=lambda: NOW)
    bridge.reconcile_once()
    task = intake.tasks[source["handoff_key"]]
    task["status"] = "done"
    task["completed_at"] = 1_788_870_000
    task["result"] = "library:campaigns/autumn/brief-v1.pdf"

    def crash_before_complete(*_args, **_kwargs):
        raise SimulatedCrash

    store.complete = crash_before_complete
    with pytest.raises(SimulatedCrash):
        bridge.reconcile_once()

    stranded = store.get(source["id"])
    assert stranded["item"]["state"] == "in_progress"
    assert stranded["item"]["preparation_status"] == "prepared"
    assert stranded["item"]["completion_evidence"] is None
    assert len(stranded["tracker_status_history"]) == 1

    reopened = WorkStore(path, "hoffeecmo", clock=lambda: NOW)
    restarted = CompanionKanbanBridge(reopened, intake, clock=lambda: NOW)
    assert restarted.reconcile_once() == {
        "examined": 1, "linked": 0, "updated": 0, "completed": 1, "errors": 0,
    }
    done = reopened.get(source["id"])
    assert done["item"]["state"] == "done"
    assert done["item"]["preparation_status"] == "prepared"
    assert done["item"]["completion_evidence"] == [task["result"]]
    assert done["tracker_status_history"] == stranded["tracker_status_history"]
    assert restarted.reconcile_once() == {
        "examined": 0, "linked": 0, "updated": 0, "completed": 0, "errors": 0,
    }


class Response:
    def __init__(self, body, status=200):
        self.body = json.dumps(body).encode()
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return None

    def read(self, _limit=-1):
        return self.body


def test_intake_client_uses_bearer_closed_response_and_bounded_request():
    seen = []
    task = {
        "id": "t_12345678", "title": "x", "body": None, "status": "triage",
        "priority": 0, "assignee": "hoffeecmo", "tenant": "hoffee",
        "workspace_kind": "scratch", "idempotency_key": "key", "created_at": 1,
        "completed_at": None, "result": None,
    }

    def opener(request, timeout):
        seen.append((request, timeout))
        return Response({"ok": True, "operation": "get", "task": task})

    client = KanbanIntakeClient("https://kanban.example/api/plugins/kanban/companion-intake", "secret", opener=opener, timeout=7)
    assert client.get(task["id"]) == task
    request, timeout = seen[0]
    assert timeout == 7
    assert request.get_header("Authorization") == "Bearer secret"
    assert json.loads(request.data) == {"operation": "get", "task_id": task["id"]}

    def malformed(_request, timeout):
        assert timeout == 15
        return Response({"ok": True, "operation": "get", "task": {**task, "tenant": "other"}})

    with pytest.raises(BridgeError, match="response"):
        KanbanIntakeClient("https://kanban.example/intake", "secret", opener=malformed).get(task["id"])


def test_intake_client_wraps_network_error_without_secret_leak():
    def opener(_request, timeout):
        assert timeout == 15
        raise URLError("offline")

    with pytest.raises(BridgeError) as exc:
        KanbanIntakeClient("https://kanban.example/intake", "do-not-leak", opener=opener).get("t_12345678")
    assert "do-not-leak" not in str(exc.value)


@pytest.mark.parametrize(
    ("url", "secret"),
    [
        (None, None),
        (None, "configured-secret"),
        ("https://kanban.example/intake", None),
    ],
)
def test_cli_fails_closed_before_opening_store_when_environment_is_missing(
    monkeypatch, capsys, url, secret,
):
    for name, value in (
        ("HERMES_COMPANION_KANBAN_INTAKE_URL", url),
        ("HERMES_DASHBOARD_KANBAN_INTAKE_SECRET", secret),
    ):
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)

    def unexpected_store(_profile):
        pytest.fail("WorkStore must not open without complete bridge authority")

    monkeypatch.setattr(bridge_module, "resolve_store", unexpected_store)
    assert bridge_module.main([]) == 1
    assert json.loads(capsys.readouterr().err)["error"]["message"]
