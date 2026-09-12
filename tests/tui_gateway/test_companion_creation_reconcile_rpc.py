"""Public creation reconciliation through the registered Companion RPC."""
from __future__ import annotations

import json
from contextlib import contextmanager
from pathlib import Path

import pytest

from hermes_cli.dashboard_auth.ws_tickets import OwnerAuthorizationLease
from hermes_state import SessionDB
from tui_gateway import companion_creation, companion_sessions, server
from tui_gateway.transport import Transport, bind_transport, reset_transport

OWNER = "basic:owner"
REQUEST_ID = "71a83cca-207f-4e39-8217-67ea2da77f23"
BACKEND = "companion-test-backend"
PROFILE = "atlas"
RECEIPT_KEYS = {
    "version",
    "operation_kind",
    "backend_namespace",
    "profile",
    "client_request_id",
    "project_id",
    "stored_session_id",
    "row_state",
    "operation_status",
    "runtime_session_id",
}


class OwnerTransport(Transport):
    def __init__(self, authorization):
        self.companion_owner_authorization = authorization

    def write(self, obj: dict) -> bool:
        del obj
        return True

    def close(self) -> None:
        pass


@pytest.fixture(autouse=True)
def rpc_env(tmp_path, monkeypatch):
    from tui_gateway import companion_library

    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("GATEWAY_RELAY_ID", BACKEND)
    monkeypatch.setattr(
        companion_library,
        "_owner_identity",
        lambda identity: identity if identity == OWNER else None,
    )
    database = SessionDB(home / "state.db")
    monkeypatch.setattr(server, "_get_db", lambda: database)
    monkeypatch.setattr(server, "_current_profile_name", lambda: PROFILE)
    monkeypatch.setattr(
        companion_sessions,
        "_owner_authorized_profiles",
        lambda _server: frozenset({PROFILE}),
    )
    token = bind_transport(
        OwnerTransport(OwnerAuthorizationLease(OWNER, float("inf")))
    )
    try:
        yield database
    finally:
        reset_transport(token)
        database.close()


def _call(**params):
    return server._methods["companion.sessions.reconcile"]("creation-reconcile", params)


def _params(**changes):
    result = {
        "operation_kind": "create",
        "backend_namespace": BACKEND,
        "profile": PROFILE,
        "client_request_id": REQUEST_ID,
    }
    result.update(changes)
    return result


def _bind(db: SessionDB, **changes) -> dict:
    values = {
        "owner": OWNER,
        "client_request_id": REQUEST_ID,
        "payload_digest": "a" * 64,
        "backend": BACKEND,
        "profile": PROFILE,
        "stored_id": "server-bound-session",
        "project_id": "server-bound-project",
        "operation_id": "b" * 48,
        "creator_pid": 999_999_999,
        "creator_started": 456,
        "creator_token": "c" * 48,
        "bound_at": "2026-09-10T10:00:00Z",
    }
    values.update(changes)
    return companion_creation._creation_request_index(db, **values)[0]


def test_registered_creation_reconcile_returns_exact_server_bound_receipt_once(
    rpc_env, monkeypatch
):
    index = _bind(rpc_env)
    calls = []
    expected = {
        "version": 1,
        "operation_kind": "create",
        "backend_namespace": BACKEND,
        "profile": PROFILE,
        "client_request_id": REQUEST_ID,
        "project_id": "server-bound-project",
        "stored_session_id": "server-bound-session",
        "row_state": "absent",
        "operation_status": "not_admitted",
        "runtime_session_id": None,
    }
    real_reconcile = companion_creation._reconcile_creation_recovery

    def reconcile(ledger, target, **kwargs):
        calls.append((ledger, target, kwargs))
        return real_reconcile(ledger, target, **kwargs)

    monkeypatch.setattr(companion_creation, "_creation_creator_liveness", lambda _index: "dead")
    monkeypatch.setattr(companion_creation, "_reconcile_creation_recovery", reconcile)
    for method in ("session.create", "session.resume", "prompt.submit"):
        monkeypatch.setitem(
            server._methods,
            method,
            lambda *_args, _method=method, **_kwargs: pytest.fail(
                f"forbidden method called: {_method}"
            ),
        )
    for name in ("_sess", "_sess_nowait", "_init_session", "_activate_project_for_cwd"):
        if hasattr(server, name):
            monkeypatch.setattr(
                server,
                name,
                lambda *_args, _name=name, **_kwargs: pytest.fail(
                    f"forbidden runtime/project path called: {_name}"
                ),
            )
    monkeypatch.setattr(
        rpc_env,
        "create_session",
        lambda *_args, **_kwargs: pytest.fail("must not create a session row"),
    )
    monkeypatch.setattr(
        rpc_env,
        "_insert_session_row_tx",
        lambda *_args, **_kwargs: pytest.fail("must not reserve a session row"),
    )
    before_sessions = dict(server._sessions)

    response = _call(**_params())

    assert response["result"] == expected
    assert set(response["result"]) == RECEIPT_KEYS
    assert len(calls) == 1
    assert calls[0][0] is rpc_env and calls[0][1] is rpc_env
    assert calls[0][2]["owner"] == OWNER
    assert calls[0][2]["client_request_id"] == REQUEST_ID
    assert calls[0][2]["index"] == index
    assert isinstance(calls[0][2]["age_seconds"], float)
    assert calls[0][2]["age_seconds"] >= 0
    assert server._sessions == before_sessions


def test_creation_reconcile_definitive_absence_is_exact_not_found_receipt(rpc_env):
    response = _call(**_params())

    assert response["result"] == {
        "version": 1,
        "operation_kind": "create",
        "backend_namespace": BACKEND,
        "profile": PROFILE,
        "client_request_id": REQUEST_ID,
        "project_id": None,
        "stored_session_id": None,
        "row_state": "absent",
        "operation_status": "not_found",
        "runtime_session_id": None,
    }
    assert set(response["result"]) == RECEIPT_KEYS


@pytest.mark.parametrize("binding", ["continue", "legacy_index", "legacy"])
def test_creation_reconcile_conflicts_with_existing_other_kind_before_target_access(
    rpc_env, monkeypatch, binding
):
    if binding == "continue":
        companion_sessions._request_index(
            rpc_env,
            owner=OWNER,
            client_request_id=REQUEST_ID,
            payload_digest="d" * 64,
            backend=BACKEND,
            profile=PROFILE,
            stored_id="continued-session",
        )
        expected_message = "client_request_id conflicts with another operation kind"
    elif binding == "legacy_index":
        rpc_env.set_meta(
            companion_sessions._continuity_v3_key(OWNER, REQUEST_ID),
            json.dumps(
                {
                    "v": 3,
                    "payload_sha256": "d" * 64,
                    "operation_id": "e" * 48,
                    "backend_namespace": BACKEND,
                    "target_profile": PROFILE,
                    "requested_id": "legacy-continued-session",
                }
            ),
        )
        expected_message = "client_request_id conflicts with another operation kind"
    else:
        rpc_env.set_meta(
            companion_sessions._continuity_receipt_key(OWNER, REQUEST_ID),
            json.dumps({"private": "must not leak"}),
        )
        expected_message = "client_request_id conflicts with a legacy continuation"
    monkeypatch.setattr(
        companion_sessions,
        "_source",
        lambda *_args, **_kwargs: pytest.fail("target profile must not be inspected"),
    )

    response = _call(**_params())

    assert response["error"] == {"code": 4090, "message": expected_message}
    assert "private" not in json.dumps(response)


@pytest.mark.parametrize(
    "index_change",
    [
        {"backend": "index-other-backend"},
        {"profile": "coder"},
    ],
)
def test_creation_reconcile_rejects_immutable_route_mismatch_before_recovery(
    rpc_env, monkeypatch, index_change
):
    _bind(rpc_env, **index_change)
    monkeypatch.setattr(
        companion_creation,
        "_reconcile_creation_recovery",
        lambda *_args, **_kwargs: pytest.fail("must not recover a mismatched route"),
    )

    response = _call(**_params())

    assert response["error"] == {
        "code": 4090,
        "message": "creation reconciliation target conflicts with request",
    }


@pytest.mark.parametrize(
    "params",
    [
        {},
        {"operation_kind": "create"},
        {
            "operation_kind": "create",
            "backend_namespace": BACKEND,
            "profile": PROFILE,
        },
        _params(stored_session_id="client-selected"),
        _params(text="must not be accepted"),
        _params(project_id="client-selected"),
        _params(payload_sha256="d" * 64),
        _params(operation_id="e" * 48),
        _params(owner="request-hint"),
        _params(extra=True),
        {
            "operation_kind": "create",
            "backend_namespace": BACKEND,
            "profile": PROFILE,
            "stored_session_id": "mixed",
            "client_request_id": REQUEST_ID,
        },
        _params(operation_kind="continue"),
    ],
)
def test_creation_reconcile_rejects_partial_mixed_and_extra_shapes(rpc_env, params):
    response = _call(**params)

    assert response["error"] == {
        "code": -32602,
        "message": "invalid session reconciliation parameters",
    }


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("backend_namespace", ""),
        ("backend_namespace", " backend"),
        ("backend_namespace", "back\nend"),
        ("backend_namespace", "é" * 2049),
        ("backend_namespace", 1),
        ("profile", "Atlas"),
        ("profile", "atlas "),
        ("profile", "a" * 65),
        ("profile", "hermes"),
        ("profile", []),
        ("client_request_id", "71A83CCA-207F-4E39-8217-67EA2DA77F23"),
        ("client_request_id", "71a83cca-207f-1e39-8217-67ea2da77f23"),
        ("client_request_id", "{71a83cca-207f-4e39-8217-67ea2da77f23}"),
        ("client_request_id", "not-a-uuid"),
        ("client_request_id", 1),
    ],
)
def test_creation_reconcile_rejects_noncanonical_values(rpc_env, field, value):
    response = _call(**_params(**{field: value}))

    assert response["error"] == {
        "code": -32602,
        "message": "invalid session reconciliation parameters",
    }


def test_creation_reconcile_requires_exact_live_backend_and_served_profile(rpc_env):
    wrong_backend = _call(**_params(backend_namespace="other-backend"))
    wrong_profile = _call(**_params(profile="coder"))

    assert wrong_backend["error"] == {
        "code": 4404,
        "message": "session backend unavailable",
    }
    assert wrong_profile["error"] == {
        "code": 4403,
        "message": "session profile unavailable",
    }


def test_creation_capability_and_method_surface_are_advertised(rpc_env):
    assert "companion.sessions.create" in server._methods
    capability = server._methods["companion.capabilities"]("capability", {})["result"]
    assert "companion.sessions.create" in capability["methods"]
    assert capability["companion.sessions.create"] == {
        "version": 1,
        "receipt_version": 1,
        "reconcile_by_request": True,
        "explicit_null_project": True,
    }


def test_creation_reconcile_revoked_owner_leaks_no_receipt_or_binding(rpc_env):
    _bind(rpc_env)
    token = bind_transport(OwnerTransport(OwnerAuthorizationLease(OWNER, 0.0)))
    try:
        response = _call(**_params())
    finally:
        reset_transport(token)

    assert response["error"] == {
        "code": 4403,
        "message": "authenticated dashboard owner required",
    }
    encoded = json.dumps(response)
    assert "server-bound-session" not in encoded
    assert "server-bound-project" not in encoded


def test_creation_reconcile_projects_target_store_unavailable_as_exact_receipt(
    rpc_env, monkeypatch
):
    key = companion_sessions._continuity_v3_key(OWNER, REQUEST_ID)
    rpc_env.set_meta(key, json.dumps(_bind_values_for_replacement()))

    @contextmanager
    def unavailable_source(*_args, **_kwargs):
        raise companion_sessions.CompanionSessionsError(
            "session backend unavailable", 4404
        )
        yield

    monkeypatch.setattr(companion_sessions, "_source", unavailable_source)
    response = _call(**_params())
    assert "error" not in response
    assert response["result"] == {
        "version": 1,
        "operation_kind": "create",
        "backend_namespace": BACKEND,
        "profile": PROFILE,
        "client_request_id": REQUEST_ID,
        "project_id": None,
        "stored_session_id": "server-bound-session",
        "row_state": "unavailable",
        "operation_status": "recovery_required",
        "runtime_session_id": None,
    }


def test_creation_reconcile_sanitizes_malformed_index_and_unexpected_recovery(
    rpc_env, monkeypatch
):
    key = companion_sessions._continuity_v3_key(OWNER, REQUEST_ID)
    rpc_env.set_meta(key, json.dumps({"v": 4, "private": "/secret/index"}))
    malformed = _call(**_params())
    assert malformed["error"] == {
        "code": 5006,
        "message": "creation reconciliation index is invalid",
    }
    assert "/secret/index" not in json.dumps(malformed)

    rpc_env.set_meta(key, json.dumps(_bind_values_for_replacement()))

    @contextmanager
    def source(*_args, **_kwargs):
        yield rpc_env

    monkeypatch.setattr(companion_sessions, "_source", source)
    monkeypatch.setattr(
        companion_creation,
        "_reconcile_creation_recovery",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("/private/path")),
    )
    unexpected = _call(**_params())
    assert unexpected["error"] == {
        "code": 5065,
        "message": "session operation unavailable",
    }
    assert "/private/path" not in json.dumps(unexpected)


def _bind_values_for_replacement() -> dict:
    return {
        "v": 4,
        "operation_kind": "create",
        "payload_sha256": "a" * 64,
        "operation_id": "b" * 48,
        "backend_namespace": BACKEND,
        "target_profile": PROFILE,
        "requested_id": "server-bound-session",
        "project_id": None,
        "creator_pid": 999_999_999,
        "creator_started": 456,
        "creator_token": "c" * 48,
        "creator_epoch": 1,
        "phase": "bound",
        "bound_at": "2026-09-10T10:00:00Z",
        "phase_at": "2026-09-10T10:00:00Z",
        "closed_outcome": None,
    }
