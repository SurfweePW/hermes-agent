"""Public durable Companion creation saga through registered RPC handlers."""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import sqlite3

import pytest

from hermes_cli import projects_db as pdb
from hermes_cli.dashboard_auth.ws_tickets import OwnerAuthorizationLease
from hermes_state import SessionDB
from tui_gateway import (
    companion_creation,
    companion_projects,
    companion_session_create,
    companion_sessions,
    companion_turns,
    server,
)
from tui_gateway.transport import Transport, bind_transport, reset_transport

OWNER = "basic:owner"
BACKEND = "g3c-backend"
PROFILE = "default"
REQUEST = "71a83cca-207f-4e39-8217-67ea2da77f23"
TEXT = "PRIVATE-PROMPT-CANARY /owner/secret"
RECEIPT_KEYS = {
    "version", "operation_kind", "backend_namespace", "profile",
    "client_request_id", "project_id", "stored_session_id", "row_state",
    "operation_status", "runtime_session_id",
}


class OwnerTransport(Transport):
    def __init__(self, authorization):
        self.companion_owner_authorization = authorization

    def write(self, obj: dict) -> bool:
        del obj
        return True

    def close(self) -> None:
        pass


class Lease:
    enabled = True
    released = False
    track_liveness = True

    def __init__(self, session_id: str, lease_id: str):
        self.session_id = session_id
        self.lease_id = lease_id
        self.release_calls = 0

    def release(self):
        self.release_calls += 1
        self.released = True


class FakeThread:
    starts = 0

    def __init__(self, *args, **kwargs):
        del args, kwargs

    def start(self):
        type(self).starts += 1

    def is_alive(self):
        return False


@pytest.fixture
def create_env(tmp_path, monkeypatch):
    home = (tmp_path / "home").resolve()
    project = (tmp_path / "project").resolve()
    home.mkdir()
    project.mkdir()
    (home / "config.yaml").write_text("model: test/model\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("GATEWAY_RELAY_ID", BACKEND)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setattr(server, "_hermes_home", home)
    monkeypatch.setattr(server, "_current_profile_name", lambda: PROFILE)
    monkeypatch.setattr(server, "_profile_home", lambda _profile: None)
    monkeypatch.setattr(server, "_profile_configured_cwd", lambda _home: str(project))
    monkeypatch.setattr(server, "_launch_configured_cwd", lambda: str(project))
    monkeypatch.setattr(server, "_enable_gateway_prompts", lambda: None)
    monkeypatch.setattr(server, "_load_show_reasoning", lambda: False)
    monkeypatch.setattr(server, "_load_tool_progress_mode", lambda: "default")
    monkeypatch.setattr(server, "_load_dashboard_process_isolation_config", lambda: {})
    monkeypatch.setattr(server, "_register_session_cwd", lambda _session: None)
    monkeypatch.setattr(server, "_start_agent_build", lambda *_args: None)
    monkeypatch.setattr(server.threading, "Thread", FakeThread)
    monkeypatch.setattr(
        companion_sessions, "_owner_authorized_profiles", lambda _server: frozenset({PROFILE})
    )
    from tui_gateway import companion_library
    monkeypatch.setattr(
        companion_library, "_owner_identity", lambda identity: identity if identity == OWNER else None
    )

    db = SessionDB(home / "state.db")
    monkeypatch.setattr(server, "_get_db", lambda: db)
    monkeypatch.setattr(server, "_sessions", {})
    with server._lifecycle_reservation_lock:
        server._inflight_creation_reservations.clear()

    with pdb.connect(home / "projects.db") as conn:
        project_id = pdb.create_project(
            conn, name="Canonical", folders=[str(project)], primary_path=str(project)
        )

    claims = []
    real_claim = server._claim_active_session_slot

    def claim(session_key, *, live_session_id, profile_home=None, config=None,
              strict_reservation=False):
        del profile_home, config
        assert strict_reservation is True
        lease = Lease(session_key, f"lease-{len(claims)}")
        assert server._track_creation_reservation(
            lease, session_key=session_key, live_session_id=live_session_id
        )
        claims.append(lease)
        return lease, None

    monkeypatch.setattr(server, "_claim_active_session_slot", claim)
    FakeThread.starts = 0
    transport = OwnerTransport(OwnerAuthorizationLease(OWNER, float("inf")))
    token = bind_transport(transport)
    try:
        yield {
            "home": home, "project": project, "project_id": project_id,
            "db": db, "claims": claims, "transport": transport,
            "real_claim": real_claim,
        }
    finally:
        reset_transport(token)
        with server._lifecycle_reservation_lock:
            server._inflight_creation_reservations.clear()
        db.close()


def params(**changes):
    value = {
        "version": 1,
        "backend_namespace": BACKEND,
        "profile": PROFILE,
        "client_request_id": REQUEST,
        "project_id": None,
        "text": TEXT,
    }
    value.update(changes)
    return value


def call(**changes):
    return server._methods["companion.sessions.create"]("create", params(**changes))


def assert_private_receipt(response):
    assert "error" not in response, response
    receipt = response["result"]
    assert set(receipt) == RECEIPT_KEYS
    encoded = json.dumps(receipt)
    for canary in (TEXT, "/owner/secret", "payload_sha256", "operation_id", "creator_token"):
        assert canary not in encoded
    return receipt


def test_registered_create_chain_is_durable_lazy_and_exactly_once(create_env, monkeypatch):
    calls = {"reserved": 0, "submit": 0, "agent": 0}
    real_reserved = server._invoke_reserved_session_create
    real_submit = server._methods["prompt.submit"]

    def reserved(value, *, rid=None):
        calls["reserved"] += 1
        return real_reserved(value, rid=rid)

    def submit(rid, value):
        calls["submit"] += 1
        return real_submit(rid, value)

    monkeypatch.setattr(server, "_invoke_reserved_session_create", reserved)
    monkeypatch.setitem(server._methods, "prompt.submit", submit)
    monkeypatch.setattr(
        server, "_make_agent", lambda *_a, **_k: calls.__setitem__("agent", calls["agent"] + 1)
    )

    receipt = assert_private_receipt(call(project_id=create_env["project_id"]))

    assert receipt["project_id"] == create_env["project_id"]
    assert receipt["row_state"] == "present"
    assert receipt["operation_status"] == "admitted"
    assert receipt["runtime_session_id"] in server._sessions
    assert calls == {"reserved": 1, "submit": 1, "agent": 0}
    assert FakeThread.starts == 1
    row = create_env["db"].get_session(receipt["stored_session_id"])
    assert row["cwd"] == str(create_env["project"])
    assert row["git_repo_root"] == str(create_env["project"])
    assert row["message_count"] == 0
    raw = json.dumps(create_env["db"].get_meta(
        companion_sessions._continuity_v3_key(OWNER, REQUEST)
    ))
    assert TEXT not in raw
    assert json.loads(json.loads(raw))["phase"] == "closed"

    replay = assert_private_receipt(call(project_id=create_env["project_id"]))
    assert replay["stored_session_id"] == receipt["stored_session_id"]
    assert calls == {"reserved": 1, "submit": 1, "agent": 0}


def test_explicit_null_route_persists_no_workspace(create_env):
    receipt = assert_private_receipt(call())
    row = create_env["db"].get_session(receipt["stored_session_id"])
    assert receipt["project_id"] is None
    assert row["cwd"] is None
    assert row["git_repo_root"] is None
    assert json.loads(row["model_config"])["_companion_workspace_none"] is True


def test_held_workspace_rejects_replaced_directory_inode(create_env):
    project = create_env["project"]
    displaced = project.with_name("displaced-project")

    with companion_projects.hold_creation_workspace(
        server, PROFILE, create_env["project_id"]
    ) as workspace:
        assert workspace._directory.fd is not None
        held_inode = os.fstat(workspace._directory.fd).st_ino
        project.rename(displaced)
        project.mkdir()

        assert project.stat().st_ino != held_inode
        with pytest.raises(
            companion_projects.CompanionProjectsError, match="workspace changed"
        ):
            workspace.validate()


def test_held_workspace_rejects_replaced_project_store_inode(create_env):
    source = create_env["home"] / "projects.db"
    replacement = source.with_name("projects-replacement.db")

    with pytest.raises(companion_projects.CompanionProjectsError):
        with companion_projects.hold_creation_workspace(
            server, PROFILE, create_env["project_id"]
        ) as workspace:
            shutil.copy2(source, replacement)
            os.replace(replacement, source)
            workspace.validate()


def test_held_workspace_rejects_project_content_change(create_env):
    with companion_projects.hold_creation_workspace(
        server, PROFILE, create_env["project_id"]
    ) as workspace:
        with pdb.connect(create_env["home"] / "projects.db") as conn:
            conn.execute(
                "UPDATE projects SET name = ? WHERE id = ?",
                ("Changed while preparing", create_env["project_id"]),
            )
            conn.commit()

        with pytest.raises(
            companion_projects.CompanionProjectsError, match="workspace changed"
        ):
            workspace.validate()


@pytest.mark.parametrize("mutation", ["directory", "project_store"])
def test_creation_settles_if_held_workspace_changes_before_dispatch(
    create_env, monkeypatch, mutation
):
    real_advance = companion_creation._advance_creation_phase
    submitted = []
    changed = False

    def advance(*args, **kwargs):
        nonlocal changed
        result = real_advance(*args, **kwargs)
        if kwargs.get("next_phase") == "prepared" and not changed:
            changed = True
            if mutation == "directory":
                project = create_env["project"]
                project.rename(project.with_name("project-before-replacement"))
                project.mkdir()
            else:
                with pdb.connect(create_env["home"] / "projects.db") as conn:
                    conn.execute(
                        "UPDATE projects SET name = ? WHERE id = ?",
                        ("Changed before dispatch", create_env["project_id"]),
                    )
                    conn.commit()
        return result

    monkeypatch.setattr(companion_creation, "_advance_creation_phase", advance)
    monkeypatch.setitem(
        server._methods,
        "prompt.submit",
        lambda *_args: submitted.append(True),
    )

    receipt = assert_private_receipt(call(project_id=create_env["project_id"]))

    assert changed is True
    assert receipt["operation_status"] == "not_admitted"
    assert submitted == []
    assert create_env["claims"][0].release_calls == 1


@pytest.mark.parametrize(
    "mutation",
    [
        lambda p: p.pop("text"),
        lambda p: p.update(extra=True),
        lambda p: p.update(version=True),
        lambda p: p.update(client_request_id=REQUEST.upper()),
        lambda p: p.update(project_id=" project"),
        lambda p: p.update(text=""),
        lambda p: p.update(cwd="/client/chosen"),
    ],
)
def test_strict_schema_rejected_before_writes(create_env, mutation):
    request = params()
    mutation(request)
    before = create_env["db"]._conn.total_changes
    response = server._methods["companion.sessions.create"]("bad", request)
    assert response["error"]["code"] == -32602
    assert create_env["db"]._conn.total_changes == before
    assert create_env["claims"] == []
    assert server._sessions == {}


def test_revoked_owner_is_checked_on_each_public_call(create_env):
    expired = bind_transport(OwnerTransport(OwnerAuthorizationLease(OWNER, 0.0)))
    try:
        response = call()
    finally:
        reset_transport(expired)
    assert response["error"] == {
        "code": 4403, "message": "authenticated dashboard owner required"
    }
    assert create_env["claims"] == []
    assert server._sessions == {}
    assert TEXT not in json.dumps(response)


@pytest.mark.parametrize("revocation_gate", ["before_dispatch", "after_bind", "before_submit"])
def test_owner_is_revalidated_at_every_gate_before_submit(
    create_env, monkeypatch, revocation_gate
):
    authorization = create_env["transport"].companion_owner_authorization
    submits = []
    monkeypatch.setitem(
        server._methods,
        "prompt.submit",
        lambda rid, value: submits.append((rid, value)) or {"result": {"status": "streaming"}},
    )
    revoked: list[str] = []

    def revoke() -> None:
        object.__setattr__(authorization, "expires_at", 0.0)
        revoked.append(revocation_gate)

    if revocation_gate == "before_dispatch":
        real_resolve = companion_projects.resolve_creation_workspace

        def resolve(*args, **kwargs):
            result = real_resolve(*args, **kwargs)
            if not revoked:
                # Pre-dispatch gate: revoke on the first workspace re-resolution, not
                # on a fixed call ordinal — the ordinal silently stopped matching the
                # flow and left this arm asserting on a request that was never revoked.
                revoke()
            return result

        monkeypatch.setattr(companion_projects, "resolve_creation_workspace", resolve)
    elif revocation_gate == "after_bind":
        real_bind = companion_turns.bind_turn

        def bind(claim):
            result = real_bind(claim)
            revoke()
            return result

        monkeypatch.setattr(companion_turns, "bind_turn", bind)
    else:
        real_advance = companion_creation._advance_creation_phase

        def advance(*args, **kwargs):
            result = real_advance(*args, **kwargs)
            if kwargs.get("next_phase") == "dispatching":
                revoke()
            return result

        monkeypatch.setattr(companion_creation, "_advance_creation_phase", advance)

    receipt = assert_private_receipt(call())
    # A no-op injection would let this test pass or fail for the wrong reason.
    assert revoked == [revocation_gate]
    assert receipt["operation_status"] == "not_admitted"
    assert submits == []


def test_identical_bind_loser_releases_its_proposed_reservation(create_env, monkeypatch):
    real_bind = companion_creation._creation_request_index

    def lose_bind(db, **kwargs):
        winner = {
            **kwargs,
            "stored_id": "winner-stored-key",
        }
        _index, inserted = real_bind(db, **winner)
        assert inserted is True
        return real_bind(db, **kwargs)

    monkeypatch.setattr(companion_creation, "_creation_request_index", lose_bind)

    receipt = assert_private_receipt(call())

    assert receipt["stored_session_id"] == "winner-stored-key"
    assert len(create_env["claims"]) == 1
    loser_lease = create_env["claims"][0]
    assert loser_lease.session_id != receipt["stored_session_id"]
    assert loser_lease.release_calls == 1
    assert loser_lease.released is True
    with server._lifecycle_reservation_lock:
        tracked = tuple(server._inflight_creation_reservations.values())
    assert all(entry[0] is not loser_lease for entry in tracked)
    assert server._sessions == {}


def test_identical_bind_loser_release_failure_stays_tracked_and_returns_4091(
    create_env, monkeypatch
):
    real_bind = companion_creation._creation_request_index

    def lose_bind(db, **kwargs):
        winner = {**kwargs, "stored_id": "winner-stored-key"}
        _index, inserted = real_bind(db, **winner)
        assert inserted is True
        return real_bind(db, **kwargs)

    def fail_release(lease):
        lease.release_calls += 1
        raise OSError("PRIVATE")

    monkeypatch.setattr(companion_creation, "_creation_request_index", lose_bind)
    monkeypatch.setattr(Lease, "release", fail_release)

    response = call()

    assert response["error"] == {
        "code": 4091,
        "message": "session capacity or ownership reservation unavailable",
    }
    loser_lease = create_env["claims"][0]
    assert loser_lease.release_calls == 3
    with server._lifecycle_reservation_lock:
        assert server._inflight_creation_reservations[id(loser_lease)] == (
            loser_lease,
            loser_lease.session_id,
            server._inflight_creation_reservations[id(loser_lease)][2],
            True,
        )


def test_conflicting_bind_loser_releases_its_reservation_without_second_side_effect(
    create_env, monkeypatch
):
    real_bind = companion_creation._creation_request_index

    def conflicting_bind(db, **kwargs):
        winner = {
            **kwargs,
            "stored_id": "winner-stored-key",
            "payload_digest": "0" * 64,
        }
        _index, inserted = real_bind(db, **winner)
        assert inserted is True
        return real_bind(db, **kwargs)

    monkeypatch.setattr(companion_creation, "_creation_request_index", conflicting_bind)

    response = call()

    assert response["error"]["code"] == 4090
    assert len(create_env["claims"]) == 1
    conflict_lease = create_env["claims"][0]
    assert conflict_lease.session_id != "winner-stored-key"
    assert conflict_lease.release_calls == 1
    assert conflict_lease.released is True
    assert server._sessions == {}


def test_bind_storage_failure_with_proven_absence_releases_and_returns_5072(
    create_env, monkeypatch
):
    monkeypatch.setattr(
        companion_creation,
        "_creation_request_index",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("PRIVATE")),
    )

    response = call()

    assert response["error"] == {
        "code": 5072,
        "message": "creation storage unavailable",
    }
    assert len(create_env["claims"]) == 1
    assert create_env["claims"][0].release_calls == 1
    request_key = companion_sessions._continuity_v3_key(OWNER, REQUEST)
    assert create_env["db"].get_meta(request_key) is None
    assert server._sessions == {}


def test_ambiguous_committed_bind_releases_then_reconciles_without_second_key(
    create_env, monkeypatch
):
    real_bind = companion_creation._creation_request_index

    def commit_then_raise(db, **kwargs):
        _index, inserted = real_bind(db, **kwargs)
        assert inserted is True
        raise OSError("PRIVATE")

    monkeypatch.setattr(companion_creation, "_creation_request_index", commit_then_raise)

    receipt = assert_private_receipt(call())

    assert receipt["stored_session_id"] == create_env["claims"][0].session_id
    assert receipt["row_state"] == "absent"
    assert len(create_env["claims"]) == 1
    assert create_env["claims"][0].release_calls == 1
    assert create_env["claims"][0].released is True
    assert server._sessions == {}


def test_capacity_refusal_is_4091_with_no_index_row_runtime_or_submit(create_env, monkeypatch):
    registry_before = json.dumps(server._inflight_creation_reservations, default=repr, sort_keys=True)
    submitted = []
    monkeypatch.setattr(server, "_claim_active_session_slot", lambda *_a, **_k: (None, object()))
    monkeypatch.setitem(server._methods, "prompt.submit", lambda *_a: submitted.append(True))

    response = call()

    registry_after = json.dumps(server._inflight_creation_reservations, default=repr, sort_keys=True)
    assert response["error"] == {
        "code": 4091,
        "message": "session capacity or ownership reservation unavailable",
    }
    request_key = companion_sessions._continuity_v3_key(OWNER, REQUEST)
    assert create_env["db"].get_meta(request_key) is None
    with sqlite3.connect(create_env["home"] / "state.db") as connection:
        assert connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
    assert server._sessions == {}
    assert submitted == []
    assert registry_after == registry_before


@pytest.mark.parametrize("stage", ["prepare", "private", "phase", "bind"])
def test_pre_submit_failure_stages_settle_without_runtime_or_plaintext(
    create_env, monkeypatch, stage
):
    submitted = []
    monkeypatch.setitem(server._methods, "prompt.submit", lambda *_a: submitted.append(True))
    if stage == "prepare":
        monkeypatch.setattr(
            companion_session_create, "prepare_created_session", None, raising=False
        )
        # Imported inside create_session: patch the defining module instead.
        from tui_gateway import companion_turns
        monkeypatch.setattr(companion_turns, "prepare_created_session", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("PRIVATE")))
    elif stage == "private":
        monkeypatch.setattr(server, "_invoke_reserved_session_create", lambda *_a, **_k: {"error": {"message": "PRIVATE"}})
    elif stage == "phase":
        monkeypatch.setattr(companion_creation, "_advance_creation_phase", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("PRIVATE")))
    else:
        from tui_gateway import companion_turns
        monkeypatch.setattr(companion_turns, "bind_turn", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("PRIVATE")))

    receipt = assert_private_receipt(call())
    assert receipt["operation_status"] in {"not_admitted", "recovery_required"}
    assert submitted == []
    assert TEXT not in json.dumps(receipt)


def test_crash_after_runtime_before_row_tears_down_exact_runtime_and_reservation(
    create_env, monkeypatch
):
    monkeypatch.setattr(
        companion_turns,
        "prepare_created_session",
        lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("PRIVATE")),
    )
    receipt = assert_private_receipt(call())
    assert receipt["operation_status"] == "not_admitted"
    assert server._sessions == {}
    assert len(create_env["claims"]) == 1
    assert create_env["claims"][0].release_calls == 1
    assert create_env["db"].get_session(receipt["stored_session_id"]) is None


def test_runtime_teardown_failure_keeps_coordinator_open_and_runtime_fenced(
    create_env, monkeypatch
):
    monkeypatch.setattr(
        companion_turns,
        "prepare_created_session",
        lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("PRIVATE")),
    )

    def fail_release(lease):
        lease.release_calls += 1
        raise OSError("PRIVATE")

    monkeypatch.setattr(Lease, "release", fail_release)
    receipt = assert_private_receipt(call())

    assert receipt["operation_status"] == "recovery_required"
    assert len(server._sessions) == 1
    runtime_id, runtime = next(iter(server._sessions.items()))
    assert runtime[server._CREATION_AUTHORITY_KEY].operation_id
    assert runtime[server._CREATION_LEASE_KEY] is create_env["claims"][0]
    assert runtime["active_session_lease"] is create_env["claims"][0]
    refused = server._methods["prompt.submit"](
        "ordinary", {"session_id": runtime_id, "text": "must remain fenced"}
    )
    assert refused["error"] == {
        "code": 4090,
        "message": "session creation is still pending",
    }
    raw = create_env["db"].get_meta(companion_sessions._continuity_v3_key(OWNER, REQUEST))
    assert json.loads(raw)["phase"] == "preparing"


def test_real_store_claim_reconstruction_fences_resumed_runtime(create_env, monkeypatch):
    stored = "resume-claimed-create"
    claim = companion_turns.prepare_created_session(
        create_env["db"],
        {
            "session_id": stored,
            "source": "companion",
            "model": "test/model",
            "model_config": None,
            "profile_name": PROFILE,
            "cwd": str(create_env["project"]),
            "git_repo_root": str(create_env["project"]),
        },
        "1" * 48,
        "2" * 64,
        (321, 654, "f" * 48),
    )
    builds = []
    monkeypatch.setattr(server, "_schedule_agent_build", builds.append)

    resumed = server._methods["session.resume"]("resume", {"session_id": stored})
    runtime_id = resumed["result"]["session_id"]
    runtime = server._sessions[runtime_id]
    assert runtime[server._CREATION_AUTHORITY_KEY].operation_id == claim.operation_id
    assert builds == []

    refused = server._methods["prompt.submit"](
        "ordinary", {"session_id": runtime_id, "text": "must not adopt"}
    )
    assert refused["error"] == {"code": 4090, "message": "session creation is still pending"}
    assert runtime["agent"] is None
    assert runtime["_durable_turn_claim"]["operation_id"] == claim.operation_id


def test_prompt_refusal_uses_synchronous_settlement_and_release(create_env, monkeypatch):
    real_submit = server._methods["prompt.submit"]
    monkeypatch.setattr(server, "_lock_in_submit_turn", lambda rid, *_a, **_k: (
        server._err(rid, 4090, "PRIVATE refusal"), {}
    ))
    monkeypatch.setitem(server._methods, "prompt.submit", real_submit)
    receipt = assert_private_receipt(call())
    assert receipt["operation_status"] == "not_admitted"
    assert create_env["claims"][0].release_calls == 1


def test_settlement_uncertainty_retains_exact_private_claim_and_lease(create_env, monkeypatch):
    from tui_gateway import companion_turns
    real_submit = server._methods["prompt.submit"]
    monkeypatch.setattr(server, "_lock_in_submit_turn", lambda rid, *_a, **_k: (
        server._err(rid, 4090, "PRIVATE refusal"), {}
    ))
    monkeypatch.setattr(companion_turns, "settle_turn", lambda *_a, **_k: (_ for _ in ()).throw(OSError("PRIVATE")))
    monkeypatch.setitem(server._methods, "prompt.submit", real_submit)
    receipt = assert_private_receipt(call())
    assert receipt["operation_status"] == "recovery_required"
    runtime = server._sessions[receipt["runtime_session_id"]]
    assert runtime["_durable_turn_claim"]["operation_kind"] == "create"
    assert runtime[server._CREATION_LEASE_KEY] is create_env["claims"][0]
    assert runtime["active_session_lease"] is create_env["claims"][0]
    assert create_env["claims"][0].release_calls == 0
    raw = create_env["db"].get_meta(
        companion_sessions._continuity_v3_key(OWNER, REQUEST)
    )
    assert json.loads(raw)["phase"] == "dispatching"


def test_capability_requires_create_and_reconcile_handlers(create_env, monkeypatch):
    capability = server._methods["companion.capabilities"]("caps", {})["result"]
    assert "companion.sessions.create" in capability
    monkeypatch.delitem(server._methods, "companion.sessions.reconcile")
    capability = server._methods["companion.capabilities"]("caps", {})["result"]
    assert "companion.sessions.create" not in capability
