"""Durable logical-lineage turn admission invariants."""
from __future__ import annotations

import json
import multiprocessing
from dataclasses import replace
from pathlib import Path

import pytest

from hermes_state import SessionDB
from tui_gateway import companion_turns
from tui_gateway.companion_turns import (
    TurnBusyError,
    TurnStateError,
    admit_turn,
    claim_turn,
    mark_running,
    new_operation_id,
    prepare_created_session,
    settle_turn,
)


def _claim_in_process(db_path: str, requested_id: str, ready, release, output) -> None:
    db = SessionDB(Path(db_path))
    operation_id = new_operation_id()
    try:
        claim = claim_turn(
            db,
            operation_id=operation_id,
            payload_sha256="a" * 64,
            requested_id=requested_id,
        )
        mark_running(db, claim, runtime_id=f"runtime-{operation_id}")
        output.put(("running", operation_id, claim.lineage_root_id, claim.generation))
        ready.set()
        release.wait(10)
        settle_turn(db, claim, outcome="completed", final_tip_id=claim.admitted_tip_id)
        output.put(("completed", operation_id))
    except TurnBusyError:
        output.put(("busy", operation_id))
    finally:
        db.close()


def _session(db: SessionDB, sid: str, *, parent: str | None = None) -> None:
    db.create_session(sid, source="desktop", parent_session_id=parent)


def test_independent_processes_share_one_logical_lineage_slot(tmp_path):
    db_path = tmp_path / "state.db"
    db = SessionDB(db_path)
    _session(db, "root")
    db.end_session("root", "compression")
    _session(db, "tip", parent="root")
    db.close()

    ctx = multiprocessing.get_context("spawn")
    first_ready = ctx.Event()
    release = ctx.Event()
    output = ctx.Queue()
    first = ctx.Process(
        target=_claim_in_process,
        args=(str(db_path), "root", first_ready, release, output),
    )
    first.start()
    assert first_ready.wait(10)

    second_ready = ctx.Event()
    second = ctx.Process(
        target=_claim_in_process,
        args=(str(db_path), "tip", second_ready, release, output),
    )
    second.start()
    second.join(10)
    assert second.exitcode == 0

    first_event = output.get(timeout=5)
    second_event = output.get(timeout=5)
    assert {first_event[0], second_event[0]} == {"running", "busy"}
    running = first_event if first_event[0] == "running" else second_event
    assert running[2] == "root"

    release.set()
    first.join(10)
    assert first.exitcode == 0

    third_ready = ctx.Event()
    third_release = ctx.Event()
    third = ctx.Process(
        target=_claim_in_process,
        args=(str(db_path), "tip", third_ready, third_release, output),
    )
    third.start()
    assert third_ready.wait(10)
    third_release.set()
    third.join(10)
    assert third.exitcode == 0

    remaining = [output.get(timeout=5), output.get(timeout=5), output.get(timeout=5)]
    later_running = next(event for event in remaining if event[0] == "running")
    assert later_running[2] == "root"
    assert later_running[3] > running[3]


def _creation_fields(session_id: str) -> dict:
    return {
        "session_id": session_id,
        "source": "companion",
        "model": "test/model",
        "model_config": {"model": "test/model", "provider": "test"},
        "profile_name": "atlas",
        "cwd": "/project",
        "git_repo_root": "/project",
    }


def _creation_index(claim, creator=(123, 456, "c" * 48)) -> dict:
    return {
        "v": 4,
        "operation_kind": "create",
        "payload_sha256": claim.payload_sha256,
        "operation_id": claim.operation_id,
        "backend_namespace": "backend",
        "target_profile": "atlas",
        "requested_id": claim.lineage_root_id,
        "project_id": "project",
        "creator_pid": creator[0],
        "creator_started": creator[1],
        "creator_token": creator[2],
        "creator_epoch": 1,
        "phase": "dispatching",
        "bound_at": "2026-09-10T10:00:00Z",
        "phase_at": "2026-09-10T10:00:03Z",
        "closed_outcome": None,
    }


def test_created_session_row_and_first_claim_commit_atomically(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    executor = (123, 456, "c" * 48)
    operation_id = new_operation_id()

    claim = prepare_created_session(
        db, _creation_fields("created-root"), operation_id, "b" * 64, executor
    )
    replay = prepare_created_session(
        db, _creation_fields("created-root"), operation_id, "b" * 64, executor
    )
    row = db.get_session("created-root")

    assert replay == claim
    assert row is not None
    assert row["source"] == "companion"
    assert row["profile_name"] == "atlas"
    assert claim.lineage_root_id == claim.admitted_tip_id == "created-root"
    assert claim.generation == 1
    assert claim.operation_kind == "create"
    with pytest.raises(TurnStateError, match="admitted before running"):
        mark_running(db, claim, runtime_id="runtime-created")
    admit_turn(db, claim, runtime_id="runtime-created")
    assert mark_running(db, claim, runtime_id="runtime-created")["state"] == "running"
    db.close()


def test_running_created_session_settles_and_releases_its_exact_slot(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    claim = prepare_created_session(
        db,
        _creation_fields("created-root"),
        new_operation_id(),
        "9" * 64,
        (123, 456, "c" * 48),
    )
    admit_turn(db, claim, runtime_id="runtime-created")
    running = mark_running(db, claim, runtime_id="runtime-created")

    settled = settle_turn(
        db, claim, outcome="completed", final_tip_id="created-root"
    )

    assert running["executor_token"] != claim.executor_token
    assert settled["state"] == "completed"
    assert settled["executor_token"] == running["executor_token"]
    assert db.get_meta(companion_turns._slot_key(claim.lineage_root_id)) is None
    db.close()


def test_creation_recovery_requires_coordinator_creator_authority(tmp_path, monkeypatch):
    db = SessionDB(tmp_path / "state.db")
    creator = (123, 456, "c" * 48)
    claim = prepare_created_session(
        db, _creation_fields("created-root"), new_operation_id(), "9" * 64, creator
    )
    admit_turn(db, claim, runtime_id="runtime-created")
    running = mark_running(db, claim, runtime_id="runtime-created")
    recovery_claim = companion_turns.claim_from_record(running)
    monkeypatch.setattr(companion_turns, "probe_pid_liveness", lambda _pid: "dead")

    with pytest.raises(TurnStateError, match="coordinator creator authority"):
        companion_turns.reconcile_dead_executor(db, recovery_claim)

    assert companion_turns.reconcile_dead_executor(
        db, recovery_claim, coordinator_index=_creation_index(claim, creator)
    )["state"] == "interrupted_outcome_unknown"
    db.close()


def test_creation_recovery_rejects_slot_not_owned_by_coordinator_creator(
    tmp_path, monkeypatch
):
    db = SessionDB(tmp_path / "state.db")
    creator = (123, 456, "c" * 48)
    claim = prepare_created_session(
        db, _creation_fields("created-root"), new_operation_id(), "9" * 64, creator
    )
    admit_turn(db, claim, runtime_id="runtime-created")
    running = mark_running(db, claim, runtime_id="runtime-created")
    recovery_claim = companion_turns.claim_from_record(running)
    slot_key = companion_turns._slot_key(claim.lineage_root_id)
    forged_slot = _mutate_creation_meta(
        db,
        slot_key,
        lambda value: value.update(
            executor_pid=999,
            executor_started=888,
            executor_token="d" * 48,
        ),
    )
    original_turn = db.get_meta(companion_turns._turn_key(claim.operation_id))
    monkeypatch.setattr(companion_turns, "probe_pid_liveness", lambda _pid: "dead")

    with pytest.raises(TurnStateError, match="coordinator creator"):
        companion_turns.reconcile_dead_executor(
            db, recovery_claim, coordinator_index=_creation_index(claim, creator)
        )

    assert db.get_meta(companion_turns._turn_key(claim.operation_id)) == original_turn
    assert db.get_meta(slot_key) == forged_slot
    db.close()


def test_creation_mark_running_requires_the_admitted_runtime_identity(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    claim = prepare_created_session(
        db, _creation_fields("created-root"), new_operation_id(), "9" * 64,
        (123, 456, "c" * 48),
    )
    admit_turn(db, claim, runtime_id="runtime-a")
    turn_key = companion_turns._turn_key(claim.operation_id)
    slot_key = companion_turns._slot_key(claim.lineage_root_id)
    admitted = db.get_meta(turn_key)
    slot = db.get_meta(slot_key)

    with pytest.raises(TurnStateError, match="runtime identity"):
        mark_running(db, claim, runtime_id="runtime-b")

    assert db.get_meta(turn_key) == admitted
    assert db.get_meta(slot_key) == slot
    assert mark_running(db, claim, runtime_id="runtime-a")["state"] == "running"
    db.close()


@pytest.mark.parametrize(
    "mutation",
    [
        lambda value: value.__setitem__("unexpected", "PRIVATE-CANARY"),
        lambda value: value.__setitem__("generation", True),
        lambda value: value.__setitem__("finished_at", "bad-time"),
        lambda value: value.__setitem__("operation_id", "d" * 48),
        lambda value: value.__setitem__("admitted_tip_id", "forged-tip"),
    ],
)
def test_creation_idempotent_settlement_rejects_malformed_terminal_evidence(
    tmp_path, mutation
):
    db = SessionDB(tmp_path / "state.db")
    claim = prepare_created_session(
        db, _creation_fields("created-root"), new_operation_id(), "9" * 64,
        (123, 456, "c" * 48),
    )
    admit_turn(db, claim, runtime_id="runtime-created")
    settle_turn(db, claim, outcome="completed", final_tip_id="created-root")
    turn_key = companion_turns._turn_key(claim.operation_id)
    malformed = _mutate_creation_meta(db, turn_key, mutation)

    with pytest.raises(TurnStateError):
        settle_turn(db, claim, outcome="completed", final_tip_id="created-root")
    with pytest.raises(TurnStateError):
        companion_turns.read_turn(db, claim.operation_id)
    with pytest.raises(TurnStateError):
        companion_turns.reconcile_dead_executor(db, claim)

    assert db.get_meta(turn_key) == malformed
    db.close()


@pytest.mark.parametrize("state", ["claimed", "admitted"])
def test_creation_pre_running_settlement_requires_the_admitted_tip(tmp_path, state):
    db = SessionDB(tmp_path / "state.db")
    claim = prepare_created_session(
        db, _creation_fields("created-root"), new_operation_id(), "9" * 64,
        (123, 456, "c" * 48),
    )
    if state == "admitted":
        admit_turn(db, claim, runtime_id="runtime-created")
    turn_key = companion_turns._turn_key(claim.operation_id)
    slot_key = companion_turns._slot_key(claim.lineage_root_id)
    original_turn = db.get_meta(turn_key)
    original_slot = db.get_meta(slot_key)

    with pytest.raises(TurnStateError, match="terminal tip"):
        settle_turn(
            db, claim,
            outcome="not_admitted" if state == "claimed" else "failed",
            final_tip_id="wrong-tip",
        )

    assert db.get_meta(turn_key) == original_turn
    assert db.get_meta(slot_key) == original_slot
    db.close()


def test_running_creation_rejects_unrelated_tip_without_mutation(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    claim = prepare_created_session(
        db, _creation_fields("created-root"), new_operation_id(), "9" * 64,
        (123, 456, "c" * 48),
    )
    admit_turn(db, claim, runtime_id="runtime-created")
    mark_running(db, claim, runtime_id="runtime-created")
    db.create_session("unrelated", source="desktop")
    turn_key = companion_turns._turn_key(claim.operation_id)
    slot_key = companion_turns._slot_key(claim.lineage_root_id)
    original_turn = db.get_meta(turn_key)
    original_slot = db.get_meta(slot_key)

    with pytest.raises(TurnStateError, match="terminal tip"):
        settle_turn(db, claim, outcome="completed", final_tip_id="unrelated")

    assert db.get_meta(turn_key) == original_turn
    assert db.get_meta(slot_key) == original_slot
    db.close()


def test_running_creation_accepts_verified_compression_descendant_tip(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    claim = prepare_created_session(
        db, _creation_fields("created-root"), new_operation_id(), "9" * 64,
        (123, 456, "c" * 48),
    )
    admit_turn(db, claim, runtime_id="runtime-created")
    mark_running(db, claim, runtime_id="runtime-created")
    db.end_session("created-root", "compression")
    db.create_session(
        "compressed-tip", source="companion", parent_session_id="created-root",
        profile_name="atlas", cwd="/project", git_repo_root="/project",
    )

    settled = settle_turn(
        db, claim, outcome="completed", final_tip_id="compressed-tip"
    )

    assert settled["final_tip_id"] == "compressed-tip"
    db.close()


def test_created_session_preparation_rolls_back_row_and_claim_together(tmp_path, monkeypatch):
    db = SessionDB(tmp_path / "state.db")
    operation_id = new_operation_id()
    original = companion_turns._claim_turn_tx

    def fail_after_claim(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("injected after claim")

    monkeypatch.setattr(companion_turns, "_claim_turn_tx", fail_after_claim)
    with pytest.raises(RuntimeError, match="injected after claim"):
        prepare_created_session(
            db,
            _creation_fields("rolled-back-root"),
            operation_id,
            "c" * 64,
            (123, 456, "c" * 48),
        )

    assert db.get_session("rolled-back-root") is None
    assert db._conn.execute(
        "SELECT COUNT(*) FROM state_meta WHERE key LIKE 'continuity_%_v3:%'"
    ).fetchone()[0] == 0
    db.close()


def test_created_session_preparation_validates_stored_claim_before_commit(
    tmp_path, monkeypatch
):
    db = SessionDB(tmp_path / "state.db")
    operation_id = new_operation_id()
    original = companion_turns._claim_turn_tx

    def corrupt_stored_claim(conn, *args, **kwargs):
        record = original(conn, *args, **kwargs)
        malformed = {**record, "executor_pid": True}
        conn.execute(
            "UPDATE state_meta SET value = ? WHERE key = ?",
            (
                json.dumps(malformed, sort_keys=True, separators=(",", ":")),
                companion_turns._turn_key(operation_id),
            ),
        )
        return malformed

    monkeypatch.setattr(companion_turns, "_claim_turn_tx", corrupt_stored_claim)
    before = _creation_target_state(db, "rolled-back-root")

    with pytest.raises(TurnStateError, match="claim evidence"):
        prepare_created_session(
            db,
            _creation_fields("rolled-back-root"),
            operation_id,
            "c" * 64,
            (123, 456, "c" * 48),
        )

    assert _creation_target_state(db, "rolled-back-root") == before
    db.close()


def test_created_session_preparation_rejects_partial_preexisting_pair(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    db.create_session(
        "row-only", source="companion", model="test/model",
        model_config={"model": "test/model", "provider": "test"},
        profile_name="atlas", cwd="/project", git_repo_root="/project",
    )
    before = _creation_target_state(db, "row-only")

    with pytest.raises(TurnStateError, match="inconsistent"):
        prepare_created_session(
            db,
            _creation_fields("row-only"),
            new_operation_id(),
            "d" * 64,
            (123, 456, "c" * 48),
        )
    assert _creation_target_state(db, "row-only") == before
    db.close()


@pytest.mark.parametrize(
    ("record_kind", "mutate", "message"),
    [
        ("slot", lambda value: value.pop("payload_sha256"), "slot evidence"),
        ("slot", lambda value: value.__setitem__("unexpected", True), "slot evidence"),
        ("turn", lambda value: value.__setitem__("unexpected", True), "claim evidence"),
        ("turn", lambda value: value.__setitem__("executor_started", True), "claim evidence"),
    ],
)
def test_created_session_replay_requires_exact_claim_and_slot_evidence(
    tmp_path, record_kind, mutate, message
):
    db = SessionDB(tmp_path / "state.db")
    operation_id = new_operation_id()
    executor = (123, 1, "c" * 48)
    fields = _creation_fields("created-root")
    prepare_created_session(db, fields, operation_id, "e" * 64, executor)
    conn = db._conn
    assert conn is not None

    prefix = (
        "continuity_turn_v3:" if record_kind == "turn" else "continuity_active_v3:"
    )
    row = conn.execute(
        "SELECT key, value FROM state_meta WHERE key LIKE ?", (prefix + "%",)
    ).fetchone()
    assert row is not None
    value = json.loads(row["value"])
    mutate(value)
    conn.execute(
        "UPDATE state_meta SET value = ? WHERE key = ?",
        (json.dumps(value, sort_keys=True, separators=(",", ":")), row["key"]),
    )
    conn.commit()

    with pytest.raises(TurnStateError, match=message):
        prepare_created_session(db, fields, operation_id, "e" * 64, executor)
    db.close()


def test_created_session_replay_requires_canonical_generation_evidence(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    operation_id = new_operation_id()
    executor = (123, 1, "c" * 48)
    fields = _creation_fields("created-root")
    prepare_created_session(db, fields, operation_id, "f" * 64, executor)
    conn = db._conn
    assert conn is not None

    conn.execute(
        "UPDATE state_meta SET value = '01' WHERE key LIKE 'continuity_generation_v3:%'"
    )
    conn.commit()

    with pytest.raises(TurnStateError, match="generation evidence"):
        prepare_created_session(db, fields, operation_id, "f" * 64, executor)
    db.close()


def test_created_session_replay_rejects_mutated_initial_row_evidence(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    operation_id = new_operation_id()
    executor = (123, 1, "c" * 48)
    fields = _creation_fields("created-root")
    prepare_created_session(db, fields, operation_id, "0" * 64, executor)
    conn = db._conn
    assert conn is not None
    conn.execute(
        "UPDATE sessions SET title = ?, title_source = ? WHERE id = ?",
        ("not-initial", "manual", "created-root"),
    )
    conn.commit()

    with pytest.raises(TurnStateError, match="row conflicts"):
        prepare_created_session(db, fields, operation_id, "0" * 64, executor)
    db.close()


def test_created_session_replay_requires_canonical_row_encoding(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    operation_id = new_operation_id()
    executor = (123, 1, "c" * 48)
    fields = _creation_fields("created-root")
    prepare_created_session(db, fields, operation_id, "1" * 64, executor)
    conn = db._conn
    assert conn is not None
    conn.execute(
        "UPDATE sessions SET model_config = ? WHERE id = ?",
        ('{ "provider": "test", "model": "test/model" }', "created-root"),
    )
    conn.commit()

    with pytest.raises(TurnStateError, match="row conflicts"):
        prepare_created_session(db, fields, operation_id, "1" * 64, executor)
    db.close()


def test_creation_kind_is_bound_to_claim_across_transitions(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    operation_id = new_operation_id()
    executor = (123, 1, "c" * 48)
    claim = prepare_created_session(
        db, _creation_fields("created-root"), operation_id, "2" * 64, executor
    )
    conn = db._conn
    assert conn is not None
    row = conn.execute(
        "SELECT key, value FROM state_meta WHERE key LIKE 'continuity_turn_v3:%'"
    ).fetchone()
    record = json.loads(row["value"])
    record["operation_kind"] = "continue"
    conn.execute(
        "UPDATE state_meta SET value = ? WHERE key = ?",
        (json.dumps(record, sort_keys=True, separators=(",", ":")), row["key"]),
    )
    conn.commit()

    with pytest.raises(
        TurnStateError, match="^created session turn evidence is invalid$"
    ):
        admit_turn(db, claim, runtime_id="runtime-created")
    db.close()


def _assert_creation_still_claimed(db, claim, original_slot):
    raw = db.get_meta(companion_turns._turn_key(claim.operation_id))
    assert raw is not None
    record = json.loads(raw)
    assert record["state"] == "claimed"
    assert db.get_meta(companion_turns._slot_key(claim.lineage_root_id)) == original_slot


@pytest.mark.parametrize(
    ("column", "value"),
    [
        ("source", "desktop"),
        ("profile_name", "other-profile"),
        ("cwd", "/other/project"),
        ("git_repo_root", "/other/repository"),
        ("model_config", '{"model":"mutated/model","provider":"other"}'),
    ],
)
def test_creation_admission_rejects_mutated_prepared_row(tmp_path, column, value):
    db = SessionDB(tmp_path / "state.db")
    claim = prepare_created_session(
        db,
        _creation_fields("created-root"),
        new_operation_id(),
        "3" * 64,
        (123, 456, "c" * 48),
    )
    slot_key = companion_turns._slot_key(claim.lineage_root_id)
    original_slot = db.get_meta(slot_key)
    db._conn.execute(
        f"UPDATE sessions SET {column} = ? WHERE id = ?", (value, "created-root")
    )
    db._conn.commit()

    with pytest.raises(TurnStateError, match="prepared row"):
        admit_turn(db, claim, runtime_id="runtime-created")

    _assert_creation_still_claimed(db, claim, original_slot)
    db.close()


def test_creation_admission_rejects_transcript_pollution(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    claim = prepare_created_session(
        db,
        _creation_fields("created-root"),
        new_operation_id(),
        "4" * 64,
        (123, 456, "c" * 48),
    )
    original_slot = db.get_meta(companion_turns._slot_key(claim.lineage_root_id))
    db.append_message("created-root", "user", "polluted before admission")

    with pytest.raises(TurnStateError, match="transcript"):
        admit_turn(db, claim, runtime_id="runtime-created")

    _assert_creation_still_claimed(db, claim, original_slot)
    db.close()


@pytest.mark.parametrize("generation", [None, "01", "2", "true"])
def test_creation_admission_rejects_noncanonical_generation(tmp_path, generation):
    db = SessionDB(tmp_path / "state.db")
    claim = prepare_created_session(
        db,
        _creation_fields("created-root"),
        new_operation_id(),
        "5" * 64,
        (123, 456, "c" * 48),
    )
    original_slot = db.get_meta(companion_turns._slot_key(claim.lineage_root_id))
    generation_key = companion_turns._generation_key(claim.lineage_root_id)
    if generation is None:
        db._conn.execute("DELETE FROM state_meta WHERE key = ?", (generation_key,))
    else:
        db._conn.execute(
            "UPDATE state_meta SET value = ? WHERE key = ?", (generation, generation_key)
        )
    db._conn.commit()

    with pytest.raises(TurnStateError, match="generation"):
        admit_turn(db, claim, runtime_id="runtime-created")

    _assert_creation_still_claimed(db, claim, original_slot)
    db.close()


def _mutate_creation_meta(db, key, mutation):
    raw = db.get_meta(key)
    assert raw is not None
    value = json.loads(raw)
    mutation(value)
    changed = json.dumps(value, sort_keys=True, separators=(",", ":"))
    db.set_meta(key, changed)
    return changed


@pytest.mark.parametrize(
    ("target", "mutation"),
    [
        ("turn", lambda value: value.__setitem__("generation", True)),
        ("turn", lambda value: value.__setitem__("generation", 1.0)),
        ("slot", lambda value: value.__setitem__("generation", True)),
        ("slot", lambda value: value.__setitem__("generation", 1.0)),
        ("turn", lambda value: value.__setitem__("unexpected", "CANARY")),
        ("turn", lambda value: value.pop("payload_sha256")),
        ("slot", lambda value: value.__setitem__("unexpected", "CANARY")),
        ("slot", lambda value: value.pop("payload_sha256")),
        ("turn", lambda value: value.__setitem__("state", True)),
        ("turn", lambda value: value.__setitem__("claimed_at", 1)),
        ("turn", lambda value: value.__setitem__("claimed_at", "not-a-timestamp")),
        ("turn", lambda value: value.__setitem__("executor_pid", True)),
        ("turn", lambda value: value.__setitem__("executor_started", 456.0)),
        ("slot", lambda value: value.__setitem__("executor_pid", True)),
        ("slot", lambda value: value.__setitem__("executor_started", 456.0)),
    ],
)
def test_creation_admission_requires_exact_claimed_turn_and_slot_schema(
    tmp_path, target, mutation
):
    db = SessionDB(tmp_path / "state.db")
    claim = prepare_created_session(
        db, _creation_fields("created-root"), new_operation_id(), "5" * 64,
        (123, 456, "c" * 48),
    )
    turn_key = companion_turns._turn_key(claim.operation_id)
    slot_key = companion_turns._slot_key(claim.lineage_root_id)
    key = turn_key if target == "turn" else slot_key
    malformed = _mutate_creation_meta(db, key, mutation)
    untouched = db.get_meta(slot_key if target == "turn" else turn_key)

    with pytest.raises(TurnStateError):
        admit_turn(db, claim, runtime_id="runtime-created")

    assert db.get_meta(key) == malformed
    assert db.get_meta(slot_key if target == "turn" else turn_key) == untouched
    db.close()


@pytest.mark.parametrize("generation", [True, 1.0])
def test_creation_admission_requires_type_exact_claim_identity(tmp_path, generation):
    db = SessionDB(tmp_path / "state.db")
    claim = prepare_created_session(
        db, _creation_fields("created-root"), new_operation_id(), "5" * 64,
        (123, 456, "c" * 48),
    )
    original_turn = db.get_meta(companion_turns._turn_key(claim.operation_id))
    original_slot = db.get_meta(companion_turns._slot_key(claim.lineage_root_id))

    with pytest.raises(TurnStateError):
        admit_turn(db, replace(claim, generation=generation), runtime_id="runtime-created")

    assert db.get_meta(companion_turns._turn_key(claim.operation_id)) == original_turn
    assert db.get_meta(companion_turns._slot_key(claim.lineage_root_id)) == original_slot
    db.close()


@pytest.mark.parametrize(
    ("target", "mutation"),
    [
        ("turn", lambda value: value.__setitem__("generation", True)),
        ("turn", lambda value: value.__setitem__("generation", 1.0)),
        ("slot", lambda value: value.__setitem__("generation", True)),
        ("slot", lambda value: value.__setitem__("generation", 1.0)),
        ("turn", lambda value: value.__setitem__("unexpected", "CANARY")),
        ("turn", lambda value: value.pop("runtime_id")),
        ("slot", lambda value: value.__setitem__("unexpected", "CANARY")),
        ("slot", lambda value: value.pop("executor_token")),
        ("turn", lambda value: value.__setitem__("state", ["admitted"])),
        ("turn", lambda value: value.__setitem__("admitted_at", "bad-time")),
        ("turn", lambda value: value.__setitem__("runtime_id", True)),
        ("turn", lambda value: value.__setitem__("executor_pid", 123.0)),
    ],
)
def test_creation_running_requires_exact_admitted_turn_and_slot_schema(
    tmp_path, target, mutation
):
    db = SessionDB(tmp_path / "state.db")
    claim = prepare_created_session(
        db, _creation_fields("created-root"), new_operation_id(), "5" * 64,
        (123, 456, "c" * 48),
    )
    admit_turn(db, claim, runtime_id="runtime-created")
    turn_key = companion_turns._turn_key(claim.operation_id)
    slot_key = companion_turns._slot_key(claim.lineage_root_id)
    key = turn_key if target == "turn" else slot_key
    malformed = _mutate_creation_meta(db, key, mutation)
    untouched = db.get_meta(slot_key if target == "turn" else turn_key)

    with pytest.raises(TurnStateError):
        mark_running(db, claim, runtime_id="runtime-created")

    assert db.get_meta(key) == malformed
    assert db.get_meta(slot_key if target == "turn" else turn_key) == untouched
    db.close()


@pytest.mark.parametrize("state", ["claimed", "admitted", "running"])
@pytest.mark.parametrize("target", ["turn", "slot"])
def test_creation_settlement_rejects_malformed_active_evidence_without_mutation(
    tmp_path, state, target
):
    db = SessionDB(tmp_path / "state.db")
    claim = prepare_created_session(
        db, _creation_fields("created-root"), new_operation_id(), "5" * 64,
        (123, 456, "c" * 48),
    )
    if state in {"admitted", "running"}:
        admit_turn(db, claim, runtime_id="runtime-created")
    if state == "running":
        mark_running(db, claim, runtime_id="runtime-created")
    turn_key = companion_turns._turn_key(claim.operation_id)
    slot_key = companion_turns._slot_key(claim.lineage_root_id)
    key = turn_key if target == "turn" else slot_key
    malformed = _mutate_creation_meta(
        db, key, lambda value: value.__setitem__("generation", True)
    )
    untouched = db.get_meta(slot_key if target == "turn" else turn_key)

    with pytest.raises(TurnStateError):
        settle_turn(
            db, claim,
            outcome="not_admitted" if state == "claimed" else "failed",
            final_tip_id="created-root",
        )

    assert db.get_meta(key) == malformed
    assert db.get_meta(slot_key if target == "turn" else turn_key) == untouched
    db.close()


def test_creation_claim_wire_excludes_ephemeral_prepared_row(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    fields = _creation_fields("created-root")
    fields["profile_name"] = "private-profile-canary"
    fields["model"] = "private-model-canary"
    fields["model_config"] = {
        "model": "private-model-canary",
        "nested": {"secret": "private-config-canary"},
    }
    fields["cwd"] = fields["git_repo_root"] = "/private/path/canary"
    claim = prepare_created_session(
        db, fields, new_operation_id(), "6" * 64, (123, 456, "c" * 48)
    )

    wire = claim.to_wire()
    encoded = json.dumps(wire, sort_keys=True)
    conn = db._conn
    assert conn is not None
    assert set(wire) == {
        "operation_id", "payload_sha256", "lineage_root_id", "admitted_tip_id",
        "generation", "executor_pid", "executor_started", "executor_token",
        "settle_in_parent", "operation_kind",
    }
    for canary in (
        "private-profile-canary", "private-model-canary",
        "private-config-canary", "/private/path/canary",
    ):
        assert canary not in encoded
        assert canary not in repr(claim)
        assert all(
            canary not in row["value"]
            for row in conn.execute("SELECT value FROM state_meta").fetchall()
        )

    injected_wire = {**wire, "_prepared_row_fields": "private-config-canary"}
    with pytest.raises(TurnStateError, match="durable turn context"):
        companion_turns.TurnClaim.from_wire(injected_wire)

    reconstructed = companion_turns.TurnClaim.from_wire(wire)
    with pytest.raises(TurnStateError, match="prepared row snapshot"):
        admit_turn(db, reconstructed, runtime_id="runtime-created")
    assert companion_turns.read_turn(db, claim.operation_id)["state"] == "claimed"
    db.close()


def test_creation_prepared_snapshot_isolated_from_caller_mutation(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    fields = _creation_fields("created-root")
    fields["model_config"]["nested"] = {"value": "prepared"}
    claim = prepare_created_session(
        db, fields, new_operation_id(), "7" * 64, (123, 456, "c" * 48)
    )

    fields["source"] = "desktop"
    fields["cwd"] = "/caller/mutated"
    fields["model_config"]["model"] = "caller/mutated"
    fields["model_config"]["nested"]["value"] = "caller-mutated"

    assert admit_turn(db, claim, runtime_id="runtime-created")["state"] == "admitted"
    db.close()


def test_creation_preparation_uses_snapshot_captured_before_transaction(
    tmp_path, monkeypatch
):
    db = SessionDB(tmp_path / "state.db")
    fields = _creation_fields("created-root")
    fields["model_config"]["nested"] = {"value": "prepared"}
    original_execute_write = db._execute_write

    def mutate_caller_then_execute(write, *args, **kwargs):
        fields["model_config"]["model"] = "caller/mutated"
        fields["model_config"]["nested"]["value"] = "caller-mutated"
        return original_execute_write(write, *args, **kwargs)

    monkeypatch.setattr(db, "_execute_write", mutate_caller_then_execute)
    claim = prepare_created_session(
        db, fields, new_operation_id(), "8" * 64, (123, 456, "c" * 48)
    )

    row = db.get_session("created-root")
    assert row is not None
    assert json.loads(row["model_config"]) == {
        "model": "test/model",
        "provider": "test",
        "nested": {"value": "prepared"},
    }
    assert companion_turns._prepared_creation_fields(claim)["model_config"] == {
        "model": "test/model",
        "provider": "test",
        "nested": {"value": "prepared"},
    }
    assert admit_turn(db, claim, runtime_id="runtime-created")["state"] == "admitted"
    db.close()


def test_creation_preparation_rejects_unserializable_and_cyclic_fields(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    unserializable = _creation_fields("unserializable-root")
    unserializable["model_config"]["value"] = object()
    cyclic = _creation_fields("cyclic-root")
    cyclic["model_config"]["cycle"] = cyclic["model_config"]

    for fields in (unserializable, cyclic):
        before = _creation_target_state(db, fields["session_id"])
        with pytest.raises(TurnStateError, match="row fields are invalid"):
            prepare_created_session(
                db, fields, new_operation_id(), "9" * 64,
                (123, 456, "c" * 48),
            )
        assert _creation_target_state(db, fields["session_id"]) == before

    db.close()


def _creation_target_state(db, session_id):
    conn = db._conn
    assert conn is not None
    return {
        "session": conn.execute(
            "SELECT * FROM sessions WHERE id = ?", (session_id,)
        ).fetchall(),
        "turns": conn.execute(
            "SELECT key, value FROM state_meta WHERE key LIKE 'continuity_turn_v3:%'"
        ).fetchall(),
        "slots": conn.execute(
            "SELECT key, value FROM state_meta WHERE key LIKE 'continuity_active_v3:%'"
        ).fetchall(),
        "generations": conn.execute(
            "SELECT key, value FROM state_meta WHERE key LIKE 'continuity_generation_v3:%'"
        ).fetchall(),
    }


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_creation_preparation_rejects_nonfinite_json_before_writing(tmp_path, value):
    db = SessionDB(tmp_path / "state.db")
    fields = _creation_fields("created-root")
    fields["model_config"]["value"] = value
    before = _creation_target_state(db, "created-root")

    with pytest.raises(TurnStateError, match="row fields are invalid"):
        prepare_created_session(
            db, fields, new_operation_id(), "9" * 64, (123, 456, "c" * 48)
        )

    assert _creation_target_state(db, "created-root") == before
    db.close()


def test_creation_preparation_rejects_malformed_replay_before_writing(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    operation_id = new_operation_id()
    fields = _creation_fields("created-root")
    prepare_created_session(
        db, fields, operation_id, "9" * 64, (123, 456, "c" * 48)
    )
    before = _creation_target_state(db, "created-root")

    with pytest.raises(TurnStateError):
        prepare_created_session(
            db, fields, operation_id, "9" * 64, (True, 456, "c" * 48)
        )

    assert _creation_target_state(db, "created-root") == before
    db.close()


@pytest.mark.parametrize("operation_id", ["a" * 47, "A" * 48, "g" * 48, 123])
def test_creation_preparation_rejects_noncanonical_operation_before_writing(
    tmp_path, operation_id
):
    db = SessionDB(tmp_path / "state.db")
    before = _creation_target_state(db, "created-root")

    with pytest.raises(TurnStateError):
        prepare_created_session(
            db, _creation_fields("created-root"), operation_id, "9" * 64,
            (123, 456, "c" * 48),
        )

    assert _creation_target_state(db, "created-root") == before
    db.close()


@pytest.mark.parametrize("payload_sha256", ["a" * 63, "A" * 64, "g" * 64, 123])
def test_creation_preparation_rejects_noncanonical_digest_before_writing(
    tmp_path, payload_sha256
):
    db = SessionDB(tmp_path / "state.db")
    before = _creation_target_state(db, "created-root")

    with pytest.raises(TurnStateError):
        prepare_created_session(
            db, _creation_fields("created-root"), new_operation_id(), payload_sha256,
            (123, 456, "c" * 48),
        )

    assert _creation_target_state(db, "created-root") == before
    db.close()


@pytest.mark.parametrize(
    "executor",
    [
        (123, 456),
        (123, 456, "c" * 48, "extra"),
        [123, 456, "c" * 48],
        (True, 456, "c" * 48),
        (123.0, 456, "c" * 48),
        (0, 456, "c" * 48),
        ((1 << 63), 456, "c" * 48),
        (123, True, "c" * 48),
        (123, 456.0, "c" * 48),
        (123, 0, "c" * 48),
        (123, (1 << 63), "c" * 48),
        (123, 456, 123),
        (123, 456, "C" * 48),
        (123, 456, "c" * 47),
        (123, 456, "g" * 48),
    ],
)
def test_creation_preparation_rejects_noncanonical_executor_before_writing(
    tmp_path, executor
):
    db = SessionDB(tmp_path / "state.db")
    before = _creation_target_state(db, "created-root")

    with pytest.raises(TurnStateError):
        prepare_created_session(
            db, _creation_fields("created-root"), new_operation_id(), "9" * 64,
            executor,
        )

    assert _creation_target_state(db, "created-root") == before
    db.close()


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("session_id", True),
        ("source", True),
        ("model", ["test/model"]),
        ("profile_name", True),
        ("cwd", 1),
        ("git_repo_root", False),
        ("system_prompt", False),
        ("model_config", []),
        ("model_config", ()),
    ],
)
def test_creation_preparation_rejects_noncanonical_row_fields_before_writing(
    tmp_path, field, value
):
    db = SessionDB(tmp_path / "state.db")
    fields = _creation_fields("created-root")
    fields[field] = value
    before = _creation_target_state(db, "created-root")

    with pytest.raises(TurnStateError):
        prepare_created_session(
            db, fields, new_operation_id(), "9" * 64, (123, 456, "c" * 48)
        )

    assert _creation_target_state(db, "created-root") == before
    db.close()


@pytest.mark.parametrize(
    ("fields", "target_id"),
    [
        (
            {
                **{
                    key: value
                    for key, value in _creation_fields("alias-only").items()
                    if key not in {"session_id", "source"}
                },
                "id": "alias-only",
            },
            "alias-only",
        ),
        (
            {
                key: value
                for key, value in _creation_fields("missing-source").items()
                if key != "source"
            },
            "missing-source",
        ),
        (
            {**_creation_fields("duplicate-id"), "id": "duplicate-id"},
            "duplicate-id",
        ),
        (
            {**_creation_fields("wrong-source"), "source": "desktop"},
            "wrong-source",
        ),
    ],
    ids=["id-only-no-source", "session-id-no-source", "id-plus-session-id", "wrong-source"],
)
def test_creation_preparation_rejects_repaired_or_defaulted_row_fields_pre_write(
    tmp_path, monkeypatch, fields, target_id
):
    db = SessionDB(tmp_path / "state.db")
    before = _creation_target_state(db, target_id)

    def reject_write(*_args, **_kwargs):
        raise AssertionError("creation validation reached _execute_write")

    monkeypatch.setattr(db, "_execute_write", reject_write)
    with pytest.raises(
        TurnStateError, match="^created session row fields are invalid$"
    ):
        prepare_created_session(
            db, fields, new_operation_id(), "9" * 64, (123, 456, "c" * 48)
        )

    assert _creation_target_state(db, target_id) == before
    db.close()


def test_creation_preparation_rejects_string_subclasses_before_writing(tmp_path):
    class StringSubclass(str):
        pass

    db = SessionDB(tmp_path / "state.db")
    for fields in (
        {**_creation_fields("created-root"), "model": StringSubclass("test/model")},
        {
            StringSubclass("session_id"): "created-root",
            **{key: value for key, value in _creation_fields("created-root").items()
               if key != "session_id"},
        },
    ):
        before = _creation_target_state(db, "created-root")
        with pytest.raises(TurnStateError, match="row fields are invalid"):
            prepare_created_session(
                db, fields, new_operation_id(), "9" * 64, (123, 456, "c" * 48)
            )
        assert _creation_target_state(db, "created-root") == before
    db.close()


def test_creation_preparation_accepts_canonical_unicode_row_fields(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    fields = _creation_fields("会話-root")
    fields.update(
        model="模型/会話", cwd="/项目/会話", git_repo_root="/项目",
        model_config={"model": "模型/会話", "nested": {"label": "正常"}},
    )

    claim = prepare_created_session(
        db, fields, new_operation_id(), "9" * 64, (123, 456, "c" * 48)
    )

    assert claim.lineage_root_id == "会話-root"
    assert db.get_session("会話-root") is not None
    db.close()


def test_creation_admission_rejects_malformed_private_snapshot(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    claim = prepare_created_session(
        db,
        _creation_fields("created-root"),
        new_operation_id(),
        "9" * 64,
        (123, 456, "c" * 48),
    )
    original_slot = db.get_meta(companion_turns._slot_key(claim.lineage_root_id))

    with pytest.raises(TurnStateError, match="snapshot is malformed"):
        admit_turn(
            db,
            replace(claim, _prepared_row_fields='{"session_id":"created-root"}'),
            runtime_id="runtime-created",
        )

    _assert_creation_still_claimed(db, claim, original_slot)
    db.close()


def test_continuation_wire_round_trip_and_admission_remain_compatible(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    _session(db, "root")
    claim = claim_turn(
        db, operation_id=new_operation_id(), payload_sha256="8" * 64, requested_id="root"
    )

    reconstructed = companion_turns.TurnClaim.from_wire(claim.to_wire())

    assert reconstructed == claim
    assert admit_turn(db, reconstructed, runtime_id="runtime-continuation")["state"] == "admitted"
    db.close()


@pytest.mark.parametrize("started", [None, 0, "invalid"])
def test_executor_liveness_unknown_start_does_not_settle(tmp_path, monkeypatch, started):
    db = SessionDB(tmp_path / "state.db")
    _session(db, "root")
    claim = claim_turn(
        db, operation_id=new_operation_id(), payload_sha256="a" * 64, requested_id="root"
    )
    monkeypatch.setattr(companion_turns, "probe_pid_liveness", lambda _pid: "alive")
    monkeypatch.setattr(companion_turns, "get_process_start_time", lambda _pid: started)
    assert companion_turns.executor_liveness(
        companion_turns.read_turn(db, claim.operation_id)
    ) == "unknown"
    assert companion_turns.reconcile_dead_executor(db, claim)["state"] == "claimed"
    db.close()


def test_executor_liveness_start_lookup_error_does_not_settle(tmp_path, monkeypatch):
    db = SessionDB(tmp_path / "state.db")
    _session(db, "root")
    claim = claim_turn(
        db, operation_id=new_operation_id(), payload_sha256="a" * 64, requested_id="root"
    )
    monkeypatch.setattr(companion_turns, "probe_pid_liveness", lambda _pid: "alive")
    monkeypatch.setattr(
        companion_turns, "get_process_start_time",
        lambda _pid: (_ for _ in ()).throw(OSError("private host detail")),
    )
    assert companion_turns.reconcile_dead_executor(db, claim)["state"] == "claimed"
    db.close()


def test_executor_liveness_mismatched_valid_start_settles_dead(tmp_path, monkeypatch):
    db = SessionDB(tmp_path / "state.db")
    _session(db, "root")
    claim = claim_turn(
        db, operation_id=new_operation_id(), payload_sha256="a" * 64, requested_id="root"
    )
    monkeypatch.setattr(companion_turns, "probe_pid_liveness", lambda _pid: "alive")
    monkeypatch.setattr(
        companion_turns, "get_process_start_time", lambda _pid: claim.executor_started + 1
    )
    assert companion_turns.reconcile_dead_executor(db, claim)["state"] == "not_admitted"
    db.close()


def test_executor_liveness_access_denied_is_alive_and_not_settled(tmp_path, monkeypatch):
    db = SessionDB(tmp_path / "state.db")
    _session(db, "root")
    claim = claim_turn(
        db, operation_id=new_operation_id(), payload_sha256="a" * 64, requested_id="root"
    )
    monkeypatch.setattr(companion_turns, "probe_pid_liveness", lambda _pid: "alive")
    monkeypatch.setattr(
        companion_turns, "get_process_start_time", lambda _pid: claim.executor_started
    )
    assert companion_turns.executor_liveness(
        companion_turns.read_turn(db, claim.operation_id)
    ) == "alive"
    assert companion_turns.reconcile_dead_executor(db, claim)["state"] == "claimed"
    db.close()
