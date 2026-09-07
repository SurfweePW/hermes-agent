"""Contract tests for POST /api/plugins/kanban/companion-intake."""
from __future__ import annotations

import importlib.util
import secrets
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_cli import kanban_db as kb
from hermes_cli import kanban_db_connect as kbc
from hermes_cli.dashboard_auth import TokenPrincipal, clear_providers, register_provider
from hermes_cli.dashboard_auth import token_auth
from plugins.dashboard_auth.kanban_intake import KanbanIntakeSecretProvider

ROUTE = "/api/plugins/kanban/companion-intake"
SCOPE = "kanban:hoffee:create_get"
TASK_KEYS = {
    "id", "title", "body", "status", "priority", "assignee", "tenant",
    "workspace_kind", "idempotency_key", "created_at", "completed_at", "result",
}


def _load_router():
    path = Path(__file__).resolve().parents[2] / "plugins/kanban/dashboard/plugin_api.py"
    spec = importlib.util.spec_from_file_location("kanban_companion_intake_test_api", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.router


@pytest.fixture
def intake(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    kb.create_board("hoffee")
    kb.create_board("other")

    clear_providers()
    token_auth.clear_token_routes()
    secret = secrets.token_urlsafe(32)
    register_provider(KanbanIntakeSecretProvider(secret=secret))
    token_auth.register_token_route(ROUTE)

    app = FastAPI()
    app.include_router(_load_router(), prefix="/api/plugins/kanban")
    app.middleware("http")(token_auth.token_auth_middleware)
    with TestClient(app) as client:
        yield client, secret

    clear_providers()
    token_auth.clear_token_routes()


def _headers(secret: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {secret}"}


def test_create_is_pinned_restricted_and_idempotent(intake):
    client, secret = intake
    payload = {
        "operation": "create",
        "payload": {
            "title": "Review Companion lead",
            "body": "Lead details",
            "priority": 4,
            "idempotency_key": "companion:lead:42",
            "triage": True,
            "goal_mode": False,
            "assignee": "hoffeecmo",
            "tenant": "hoffee",
            "workspace_kind": "scratch",
        },
    }

    first = client.post(ROUTE, headers=_headers(secret), json=payload)
    second = client.post(ROUTE, headers=_headers(secret), json=payload)

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    first_body = first.json()
    second_body = second.json()
    assert first_body["ok"] is True and first_body["operation"] == "create"
    assert set(first_body) == {"ok", "operation", "task"}
    assert set(first_body["task"]) == TASK_KEYS
    assert second_body["task"] == first_body["task"]

    task = first_body["task"]
    assert task["status"] == "triage"
    assert task["assignee"] == "hoffeecmo"
    assert task["tenant"] == "hoffee"
    assert task["workspace_kind"] == "scratch"

    with kbc.connect_closing(board="hoffee") as conn:
        stored = kb.get_task(conn, task["id"])
        assert stored is not None
        assert stored.goal_mode is False
        assert stored.project_id is None
        assert stored.max_runtime_seconds is None
        assert stored.skills is None
        assert stored.model_override is None
        assert stored.provider_override is None
        count = conn.execute(
            "SELECT COUNT(*) AS n FROM tasks WHERE idempotency_key = ?",
            (payload["payload"]["idempotency_key"],),
        ).fetchone()["n"]
        assert count == 1
    with kbc.connect_closing(board="other") as conn:
        assert kb.get_task(conn, task["id"]) is None


def test_get_uses_same_deterministic_shape(intake):
    client, secret = intake
    created = client.post(
        ROUTE,
        headers=_headers(secret),
        json={"operation": "create", "payload": {"title": "One"}},
    ).json()["task"]

    response = client.post(
        ROUTE,
        headers=_headers(secret),
        json={"operation": "get", "task_id": created["id"]},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body == {"ok": True, "operation": "get", "task": created}
    assert set(body["task"]) == TASK_KEYS


def test_auth_scope_and_closed_schema_are_enforced(intake):
    client, secret = intake
    envelope = {"operation": "create", "payload": {"title": "x"}}
    assert client.post(ROUTE, json=envelope).status_code == 401
    assert client.post(
        ROUTE, headers=_headers(secret + "wrong"), json=envelope
    ).status_code == 401

    clear_providers()

    class WrongScope(KanbanIntakeSecretProvider):
        name = "wrong-scope"

        def verify_token(self, *, token: str):
            if token == secret:
                return TokenPrincipal("peer", self.name, ("kanban:other:create_get",))
            return None

    register_provider(WrongScope(secret=secret))
    assert client.post(
        ROUTE, headers=_headers(secret), json=envelope
    ).status_code == 403


def test_rejects_forbidden_create_knobs_and_invalid_get(intake):
    client, secret = intake
    headers = _headers(secret)
    forbidden = (
        "workspace_path", "parents", "model_override", "provider_override",
        "reasoning_effort", "max_runtime_seconds", "skills", "project_id",
    )
    for field in forbidden:
        response = client.post(
            ROUTE,
            headers=headers,
            json={"operation": "create", "payload": {"title": "x", field: None}},
        )
        assert response.status_code == 422, (field, response.text)

    assert client.post(
        ROUTE, headers=headers, json={"operation": "get", "task_id": "not-a-task"}
    ).status_code == 422
    assert client.post(
        ROUTE,
        headers=headers,
        json={"operation": "get", "task_id": "t_deadbeef", "payload": {"title": "not allowed"}},
    ).status_code == 422


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("triage", False),
        ("goal_mode", True),
        ("assignee", "someone-else"),
        ("tenant", "other"),
        ("workspace_kind", "dir"),
    ],
)
def test_rejects_non_pinned_create_policy_values(intake, field, value):
    client, secret = intake
    response = client.post(
        ROUTE,
        headers=_headers(secret),
        json={"operation": "create", "payload": {"title": "x", field: value}},
    )
    assert response.status_code == 422, response.text
