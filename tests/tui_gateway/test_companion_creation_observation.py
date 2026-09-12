from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import sqlite3

import pytest

from hermes_state import SessionDB
from tui_gateway import companion_creation, companion_turns


DIGEST = "a" * 64
OPERATION = "b" * 48
STORED = "created-session"
EXECUTOR = (123, 456, "c" * 48)
REQUEST = "123e4567-e89b-42d3-a456-426614174000"
RECEIPT_KEYS = {
    "version", "operation_kind", "backend_namespace", "profile",
    "client_request_id", "project_id", "stored_session_id", "row_state",
    "operation_status", "runtime_session_id",
}


def _index(*, phase="preparing", closed_outcome=None, project_id="project-1"):
    return {
        "v": 4,
        "operation_kind": "create",
        "payload_sha256": DIGEST,
        "operation_id": OPERATION,
        "backend_namespace": "backend",
        "target_profile": "atlas",
        "requested_id": STORED,
        "project_id": project_id,
        "creator_pid": EXECUTOR[0],
        "creator_started": EXECUTOR[1],
        "creator_token": EXECUTOR[2],
        "creator_epoch": 1,
        "phase": phase,
        "bound_at": "2026-09-10T10:00:00Z",
        "phase_at": "2026-09-10T10:00:01Z",
        "closed_outcome": closed_outcome,
    }


def _prepare(db, *, project_id="project-1"):
    if project_id is None:
        model_config = {"model": "test/model", "_companion_workspace_none": True}
        cwd = root = None
    else:
        model_config = {"model": "test/model", "provider": "test"}
        cwd = root = "/deleted/project"
    return companion_turns.prepare_created_session(
        db,
        {
            "session_id": STORED,
            "source": "companion",
            "model": "test/model",
            "model_config": model_config,
            "profile_name": "atlas",
            "cwd": cwd,
            "git_repo_root": root,
        },
        OPERATION,
        DIGEST,
        EXECUTOR,
    )


def _receipt(index, observation, *, liveness="alive", age=1.0):
    return companion_creation.project_creation_receipt(
        client_request_id=REQUEST,
        index=index,
        observation=observation,
        creator_liveness=liveness,
        age_seconds=age,
    )


def test_observation_uses_one_sqlite_snapshot_and_proves_exact_absence(tmp_path):
    real = SessionDB(tmp_path / "state.db")

    class CountingDB:
        def __init__(self):
            self.reads = 0

        @contextmanager
        def _read_ctx(self):
            self.reads += 1
            with real._read_ctx() as conn:
                yield conn

        def __getattr__(self, name):
            raise AssertionError(f"unexpected helper access: {name}")

    db = CountingDB()
    observed = companion_turns.observe_created_session(db, _index())
    assert db.reads == 1
    assert observed.row_state == "absent"
    assert observed.evidence_state == "absent"
    assert observed.turn_state is None
    real.close()


def test_observation_snapshot_excludes_settlement_committed_between_selects(tmp_path):
    db_path = tmp_path / "state.db"
    reader = SessionDB(db_path)
    claim = _prepare(reader)
    writer = SessionDB(db_path)

    class InterleavingConnection:
        def __init__(self, conn):
            self._conn = conn
            self._settled = False

        def execute(self, sql, parameters=()):
            if "continuity_turn_v3:" in str(parameters) and not self._settled:
                self._settled = True
                companion_turns.settle_turn(
                    writer, claim, outcome="not_admitted", final_tip_id=STORED
                )
            return self._conn.execute(sql, parameters)

        def __getattr__(self, name):
            return getattr(self._conn, name)

    class InterleavingDB:
        @contextmanager
        def _read_ctx(self):
            snapshot = sqlite3.connect(":memory:")
            snapshot.row_factory = sqlite3.Row
            assert reader._conn is not None
            reader._conn.backup(snapshot)
            try:
                yield InterleavingConnection(snapshot)
            finally:
                snapshot.close()

    observed = companion_turns.observe_created_session(InterleavingDB(), _index())

    assert observed == companion_turns.CreatedSessionObservation(
        "present", "exact", "claimed"
    )
    assert companion_turns.read_turn(writer, OPERATION)["state"] == "not_admitted"
    writer.close()
    reader.close()


@pytest.mark.parametrize("kind", ["row", "turn", "slot"])
def test_partial_or_corrupt_creation_evidence_is_unavailable(tmp_path, kind):
    db = SessionDB(tmp_path / "state.db")
    claim = _prepare(db)
    conn = db._conn
    assert conn is not None
    if kind == "row":
        conn.execute("DELETE FROM state_meta WHERE key LIKE 'continuity_turn_v3:%'")
        conn.execute("DELETE FROM state_meta WHERE key LIKE 'continuity_active_v3:%'")
    elif kind == "turn":
        conn.execute("DELETE FROM sessions WHERE id = ?", (STORED,))
        conn.execute("DELETE FROM state_meta WHERE key LIKE 'continuity_active_v3:%'")
    else:
        slot_key = companion_turns._slot_key(claim.lineage_root_id)
        raw = conn.execute("SELECT value FROM state_meta WHERE key = ?", (slot_key,)).fetchone()[0]
        value = json.loads(raw)
        value["generation"] = True
        conn.execute("UPDATE state_meta SET value = ? WHERE key = ?", (json.dumps(value), slot_key))
    conn.commit()
    observed = companion_turns.observe_created_session(db, _index())
    assert observed.row_state == "unavailable"
    assert observed.evidence_state == "inconsistent"
    assert _receipt(_index(), observed)["operation_status"] == "recovery_required"
    db.close()


@pytest.mark.parametrize("kind", ["extra", "wrong_type", "malformed"])
def test_noncanonical_turn_is_rejected(tmp_path, kind):
    db = SessionDB(tmp_path / "state.db")
    _prepare(db)
    conn = db._conn
    assert conn is not None
    row = conn.execute("SELECT key, value FROM state_meta WHERE key LIKE 'continuity_turn_v3:%'").fetchone()
    if kind == "malformed":
        raw = "{"
    else:
        value = json.loads(row["value"])
        if kind == "extra":
            value["plaintext_prompt"] = "privacy canary"
        else:
            value["executor_pid"] = True
        raw = json.dumps(value)
    conn.execute("UPDATE state_meta SET value = ? WHERE key = ?", (raw, row["key"]))
    conn.commit()
    assert companion_turns.observe_created_session(db, _index()).row_state == "unavailable"
    db.close()


@pytest.mark.parametrize("state", ["claimed", "admitted", "running"])
def test_exact_active_creation_states_are_observed_and_projected(tmp_path, state):
    db = SessionDB(tmp_path / "state.db")
    claim = _prepare(db)
    if state in {"admitted", "running"}:
        companion_turns.admit_turn(db, claim, runtime_id="private-runtime")
    if state == "running":
        companion_turns.mark_running(db, claim, runtime_id="private-runtime")
    if state in {"admitted", "running"}:
        db.append_message(STORED, "user", "ordinary admitted history")
    index = _index(phase="preparing" if state == "claimed" else "dispatching")
    observed = companion_turns.observe_created_session(db, index)
    receipt = _receipt(index, observed)
    assert observed.turn_state == state
    assert receipt["operation_status"] == state
    assert receipt["row_state"] == "present"
    assert receipt["runtime_session_id"] is None
    db.close()


@pytest.mark.parametrize(
    "terminal", ["completed", "failed", "cancelled", "not_admitted", "interrupted_outcome_unknown"]
)
def test_each_exact_terminal_creation_state_projects_authoritatively(tmp_path, terminal):
    db = SessionDB(tmp_path / "state.db")
    claim = _prepare(db)
    if terminal != "not_admitted":
        companion_turns.admit_turn(db, claim, runtime_id="private-runtime")
    companion_turns.settle_turn(db, claim, outcome=terminal, final_tip_id=STORED)
    index = _index(
        phase="closed",
        closed_outcome="turn_record",
    )
    observed = companion_turns.observe_created_session(db, index)
    receipt = _receipt(index, observed)
    assert receipt["operation_status"] == terminal
    assert receipt["runtime_session_id"] is None
    assert set(receipt) == RECEIPT_KEYS
    db.close()


def test_terminal_creation_survives_later_generation_and_active_continuation(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    creation = _prepare(db)
    companion_turns.admit_turn(db, creation, runtime_id="private-runtime")
    companion_turns.settle_turn(db, creation, outcome="completed", final_tip_id=STORED)
    later = companion_turns.claim_turn(
        db, operation_id="d" * 48, payload_sha256="e" * 64, requested_id=STORED
    )
    assert later.generation == 2

    index = _index(phase="closed", closed_outcome="turn_record")
    observed = companion_turns.observe_created_session(db, index)
    assert observed == companion_turns.CreatedSessionObservation("present", "exact", "completed")
    assert _receipt(index, observed)["operation_status"] == "completed"
    db.close()


def test_terminal_creation_survives_after_later_continuation_settles(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    creation = _prepare(db)
    companion_turns.admit_turn(db, creation, runtime_id="private-runtime")
    companion_turns.settle_turn(db, creation, outcome="completed", final_tip_id=STORED)
    later = companion_turns.claim_turn(
        db, operation_id="d" * 48, payload_sha256="e" * 64, requested_id=STORED
    )
    companion_turns.settle_turn(
        db, later, outcome="not_admitted", final_tip_id=STORED
    )

    index = _index(phase="closed", closed_outcome="turn_record")
    assert companion_turns.observe_created_session(
        db, index
    ) == companion_turns.CreatedSessionObservation("present", "exact", "completed")
    db.close()


@pytest.mark.parametrize("generation", [None, "01", "0", "true"])
def test_terminal_creation_requires_canonical_generation_metadata(tmp_path, generation):
    db = SessionDB(tmp_path / "state.db")
    creation = _prepare(db)
    companion_turns.admit_turn(db, creation, runtime_id="private-runtime")
    companion_turns.settle_turn(db, creation, outcome="completed", final_tip_id=STORED)
    key = companion_turns._generation_key(STORED)
    if generation is None:
        db._conn.execute("DELETE FROM state_meta WHERE key = ?", (key,))
    else:
        db._conn.execute("UPDATE state_meta SET value = ? WHERE key = ?", (generation, key))
    db._conn.commit()

    index = _index(phase="closed", closed_outcome="turn_record")
    assert companion_turns.observe_created_session(db, index).row_state == "unavailable"
    db.close()


def test_terminal_generation_one_rejects_retained_creation_slot(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    creation = _prepare(db)
    slot_key = companion_turns._slot_key(STORED)
    slot = db.get_meta(slot_key)
    assert slot is not None
    companion_turns.admit_turn(db, creation, runtime_id="private-runtime")
    companion_turns.settle_turn(db, creation, outcome="completed", final_tip_id=STORED)
    db.set_meta(slot_key, slot)

    index = _index(phase="closed", closed_outcome="turn_record")
    assert companion_turns.observe_created_session(db, index).row_state == "unavailable"
    db.close()


@pytest.mark.parametrize(
    "mutation", ["malformed", "wrong_root", "wrong_generation", "same_operation", "extra"]
)
def test_terminal_creation_rejects_invalid_later_generation_slot(tmp_path, mutation):
    db = SessionDB(tmp_path / "state.db")
    creation = _prepare(db)
    companion_turns.admit_turn(db, creation, runtime_id="private-runtime")
    companion_turns.settle_turn(db, creation, outcome="completed", final_tip_id=STORED)
    companion_turns.claim_turn(
        db, operation_id="d" * 48, payload_sha256="e" * 64, requested_id=STORED
    )
    slot_key = companion_turns._slot_key(STORED)
    raw_slot = db.get_meta(slot_key)
    assert raw_slot is not None
    slot = json.loads(raw_slot)
    if mutation == "malformed":
        raw = "{"
    else:
        if mutation == "wrong_root":
            slot["lineage_root_id"] = "other"
        elif mutation == "wrong_generation":
            slot["generation"] = 3
        elif mutation == "same_operation":
            slot["operation_id"] = OPERATION
        else:
            slot["private"] = "CANARY"
        raw = json.dumps(slot)
    db.set_meta(slot_key, raw)

    index = _index(phase="closed", closed_outcome="turn_record")
    assert companion_turns.observe_created_session(db, index).row_state == "unavailable"
    db.close()


def test_terminal_creation_accepts_compression_descendant_tip_in_same_lineage(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    creation = _prepare(db)
    companion_turns.admit_turn(db, creation, runtime_id="private-runtime")
    companion_turns.mark_running(db, creation, runtime_id="private-runtime")
    db.end_session(STORED, "compression")
    db.create_session(
        "compressed-tip", source="companion", parent_session_id=STORED,
        profile_name="atlas", cwd="/deleted/project", git_repo_root="/deleted/project",
    )
    companion_turns.settle_turn(
        db, creation, outcome="completed", final_tip_id="compressed-tip"
    )

    index = _index(phase="closed", closed_outcome="turn_record")
    observed = companion_turns.observe_created_session(db, index)
    assert observed == companion_turns.CreatedSessionObservation("present", "exact", "completed")
    assert _receipt(index, observed)["operation_status"] == "completed"
    db.close()


def test_terminal_creation_rejects_unrelated_final_tip(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    creation = _prepare(db)
    companion_turns.admit_turn(db, creation, runtime_id="private-runtime")
    db.create_session("unrelated", source="desktop")
    with pytest.raises(companion_turns.TurnStateError, match="terminal tip"):
        companion_turns.settle_turn(
            db, creation, outcome="completed", final_tip_id="unrelated"
        )
    index = _index(phase="dispatching")
    assert companion_turns.observe_created_session(db, index) == (
        companion_turns.CreatedSessionObservation("present", "exact", "admitted")
    )
    db.close()


def test_claimed_creation_rejects_transcript_pollution(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    _prepare(db)
    db.append_message(STORED, "user", "secret prompt")
    observed = companion_turns.observe_created_session(db, _index())
    assert observed.row_state == "unavailable"
    db.close()


def test_no_project_requires_null_workspace_and_exact_marker(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    _prepare(db, project_id=None)
    index = _index(project_id=None)
    assert companion_turns.observe_created_session(db, index).row_state == "present"
    db._conn.execute("UPDATE sessions SET cwd = '' WHERE id = ?", (STORED,))
    db._conn.commit()
    assert companion_turns.observe_created_session(db, index).row_state == "unavailable"
    db.close()


def test_selected_project_observation_uses_only_persisted_row(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    _prepare(db)  # The persisted workspace deliberately does not exist.
    assert companion_turns.observe_created_session(db, _index()).row_state == "present"
    db.close()


@pytest.mark.parametrize(
    ("phase", "closed", "liveness", "age", "status", "row_state"),
    [
        ("bound", None, "alive", 60.0, "preparing", "absent"),
        ("preparing", None, "alive", 61.0, "recovery_required", "absent"),
        ("bound", None, "unknown", 1.0, "recovery_required", "absent"),
        ("bound", None, "dead", 1.0, "recovery_required", "absent"),
        ("prepared", None, "alive", 1.0, "recovery_required", "unavailable"),
        ("dispatching", None, "alive", 1.0, "recovery_required", "unavailable"),
        ("closed", "not_admitted", "dead", 500.0, "not_admitted", "absent"),
        ("closed", "turn_record", "alive", 1.0, "recovery_required", "unavailable"),
    ],
)
def test_missing_pair_classification_is_read_only(
    tmp_path, phase, closed, liveness, age, status, row_state
):
    db = SessionDB(tmp_path / "state.db")
    index = _index(phase=phase, closed_outcome=closed)
    observed = companion_turns.observe_created_session(db, index)
    before = db._conn.total_changes
    receipt = _receipt(index, observed, liveness=liveness, age=age)
    assert receipt["operation_status"] == status
    assert receipt["row_state"] == row_state
    assert db._conn.total_changes == before
    db.close()


def test_closed_turn_record_allows_admitted_work_to_finish_after_rpc_close(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    claim = _prepare(db)
    companion_turns.admit_turn(db, claim, runtime_id="private-runtime")
    index = _index(phase="closed", closed_outcome="turn_record")
    receipt = _receipt(index, companion_turns.observe_created_session(db, index))
    assert receipt["operation_status"] == "admitted"
    assert receipt["row_state"] == "present"
    db.close()


def test_receipt_is_exact_flat_private_and_runtime_null(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    observed = companion_turns.observe_created_session(db, _index())
    receipt = _receipt(_index(), observed)
    assert set(receipt) == RECEIPT_KEYS
    assert receipt == {
        "version": 1,
        "operation_kind": "create",
        "backend_namespace": "backend",
        "profile": "atlas",
        "client_request_id": REQUEST,
        "project_id": "project-1",
        "stored_session_id": STORED,
        "row_state": "absent",
        "operation_status": "preparing",
        "runtime_session_id": None,
    }
    encoded = json.dumps(receipt)
    for canary in (DIGEST, OPERATION, EXECUTOR[2], "private-runtime", "2026-09-10"):
        assert canary not in encoded
    db.close()


def test_target_unavailable_projects_recovery_required():
    class BrokenDB:
        @contextmanager
        def _read_ctx(self):
            raise OSError("unreadable")
            yield

    observed = companion_turns.observe_created_session(BrokenDB(), _index())
    receipt = _receipt(_index(), observed)
    assert receipt["row_state"] == "unavailable"
    assert receipt["operation_status"] == "recovery_required"


def _set_session_fields(db, **fields):
    assignments = ", ".join(f"{name} = ?" for name in fields)
    db._conn.execute(
        f"UPDATE sessions SET {assignments} WHERE id = ?",
        (*fields.values(), STORED),
    )
    db._conn.commit()


@pytest.mark.parametrize(
    ("phase", "closed_outcome", "turn_state", "expected_status", "expected_row"),
    [
        ("bound", None, None, "preparing", "absent"),
        ("bound", None, "claimed", "recovery_required", "unavailable"),
        ("preparing", None, None, "preparing", "absent"),
        ("preparing", None, "claimed", "claimed", "present"),
        ("preparing", None, "not_admitted", "not_admitted", "present"),
        ("preparing", None, "admitted", "recovery_required", "unavailable"),
        ("preparing", None, "completed", "recovery_required", "unavailable"),
        ("prepared", None, None, "recovery_required", "unavailable"),
        ("prepared", None, "claimed", "claimed", "present"),
        ("prepared", None, "not_admitted", "not_admitted", "present"),
        ("prepared", None, "running", "recovery_required", "unavailable"),
        ("dispatching", None, "claimed", "claimed", "present"),
        ("dispatching", None, "admitted", "admitted", "present"),
        ("dispatching", None, "running", "running", "present"),
        ("dispatching", None, "failed", "failed", "present"),
        ("closed", "not_admitted", None, "not_admitted", "absent"),
        ("closed", "not_admitted", "not_admitted", "recovery_required", "unavailable"),
        ("closed", "not_admitted", "completed", "recovery_required", "unavailable"),
        ("closed", "turn_record", None, "recovery_required", "unavailable"),
        ("closed", "turn_record", "admitted", "admitted", "present"),
        ("closed", "turn_record", "running", "running", "present"),
        ("closed", "turn_record", "completed", "completed", "present"),
        ("closed", "turn_record", "not_admitted", "not_admitted", "present"),
    ],
)
def test_phase_evidence_matrix_fails_closed(
    phase, closed_outcome, turn_state, expected_status, expected_row
):
    observation = companion_turns.CreatedSessionObservation(
        "absent" if turn_state is None else "present",
        "absent" if turn_state is None else "exact",
        turn_state,
    )
    receipt = _receipt(
        _index(phase=phase, closed_outcome=closed_outcome), observation
    )
    assert receipt["operation_status"] == expected_status
    assert receipt["row_state"] == expected_row


def test_observer_projects_phase_turn_contradiction_as_unavailable(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    claim = _prepare(db)
    companion_turns.admit_turn(db, claim, runtime_id="private-runtime")

    observed = companion_turns.observe_created_session(db, _index(phase="preparing"))

    assert observed == companion_turns.CreatedSessionObservation(
        "unavailable", "inconsistent"
    )
    db.close()


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("started_at", 1.0),
        ("message_count", 1),
        ("tool_call_count", 1),
        ("ended_at", 2.0),
        ("last_activity_at", 2.0),
        ("estimated_cost_usd", 1.25),
        ("title", "mutated"),
        ("archived", 1),
        ("pinned", 1),
    ],
)
def test_claimed_creation_requires_the_exact_pristine_row(tmp_path, field, value):
    db = SessionDB(tmp_path / "state.db")
    _prepare(db)
    updates = {field: value}
    if field == "title":
        updates["title_source"] = "user"
    _set_session_fields(db, **updates)

    observed = companion_turns.observe_created_session(db, _index())

    assert observed.row_state == "unavailable"
    assert observed.evidence_state == "inconsistent"
    db.close()


@pytest.mark.parametrize("generation_value", [None, "01", "2", "true"])
def test_claimed_creation_requires_exact_generation_metadata(tmp_path, generation_value):
    db = SessionDB(tmp_path / "state.db")
    claim = _prepare(db)
    key = companion_turns._generation_key(claim.lineage_root_id)
    if generation_value is None:
        db._conn.execute("DELETE FROM state_meta WHERE key = ?", (key,))
    else:
        db._conn.execute("UPDATE state_meta SET value = ? WHERE key = ?", (generation_value, key))
    db._conn.commit()

    assert companion_turns.observe_created_session(db, _index()).row_state == "unavailable"
    db.close()


def test_generation_without_creation_pair_is_inconsistent_not_absent(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    db.set_meta(companion_turns._generation_key(STORED), "1")

    observed = companion_turns.observe_created_session(db, _index())

    assert observed == companion_turns.CreatedSessionObservation(
        "unavailable", "inconsistent"
    )
    db.close()


@pytest.mark.parametrize("state", ["admitted", "running", "completed"])
def test_later_creation_rows_allow_ordinary_archive_and_pin_mutations(
    tmp_path, state
):
    db = SessionDB(tmp_path / "state.db")
    claim = _prepare(db)
    companion_turns.admit_turn(db, claim, runtime_id="private-runtime")
    if state == "running":
        companion_turns.mark_running(db, claim, runtime_id="private-runtime")
    elif state == "completed":
        companion_turns.settle_turn(db, claim, outcome="completed", final_tip_id=STORED)
    _set_session_fields(db, archived=1, pinned=1, title="ordinary", title_source="user")
    index = _index(
        phase="closed" if state == "completed" else "dispatching",
        closed_outcome="turn_record" if state == "completed" else None,
    )

    observed = companion_turns.observe_created_session(db, index)

    assert observed.turn_state == state
    assert observed.row_state == "present"
    db.close()


@pytest.mark.parametrize(
    ("project_id", "new_config"),
    [
        (None, {"model": "test/model", "provider": "test"}),
        ("project-1", {"model": "test/model", "provider": "reorganized"}),
    ],
)
def test_completed_creation_survives_ordinary_workspace_mutation(
    tmp_path, project_id, new_config
):
    db = SessionDB(tmp_path / "state.db")
    claim = _prepare(db, project_id=project_id)
    companion_turns.admit_turn(db, claim, runtime_id="private-runtime")
    companion_turns.settle_turn(db, claim, outcome="completed", final_tip_id=STORED)
    _set_session_fields(
        db,
        cwd="/ordinary/reorganized",
        git_repo_root="/ordinary/reorganized",
        git_branch="ordinary-branch",
        model_config=json.dumps(new_config),
    )
    index = _index(
        phase="closed", closed_outcome="turn_record", project_id=project_id
    )

    observed = companion_turns.observe_created_session(db, index)
    receipt = _receipt(index, observed)

    assert observed == companion_turns.CreatedSessionObservation(
        "present", "exact", "completed"
    )
    assert receipt["operation_status"] == "completed"
    assert receipt["project_id"] == project_id
    db.close()


@pytest.mark.parametrize(
    ("project_id", "new_config"),
    [
        (None, {"model": "test/model", "provider": "test"}),
        ("project-1", {"model": "test/model", "provider": "reorganized"}),
    ],
)
def test_claimed_creation_rejects_ordinary_workspace_mutation(
    tmp_path, project_id, new_config
):
    db = SessionDB(tmp_path / "state.db")
    _prepare(db, project_id=project_id)
    _set_session_fields(
        db,
        cwd="/ordinary/reorganized",
        git_repo_root="/ordinary/reorganized",
        git_branch="ordinary-branch",
        model_config=json.dumps(new_config),
    )

    observed = companion_turns.observe_created_session(
        db, _index(project_id=project_id)
    )

    assert observed == companion_turns.CreatedSessionObservation(
        "unavailable", "inconsistent"
    )
    db.close()


@pytest.mark.parametrize(
    ("liveness", "age"),
    [
        ("unknown", 1.0),
        ("dead", 1.0),
        ("alive", 60.0001),
    ],
)
@pytest.mark.parametrize("state", ["claimed", "admitted", "running"])
def test_nonterminal_exact_evidence_requires_live_fresh_creator(state, liveness, age):
    observation = companion_turns.CreatedSessionObservation("present", "exact", state)
    receipt = _receipt(
        _index(phase="dispatching"), observation, liveness=liveness, age=age
    )
    assert receipt["operation_status"] == "recovery_required"
    assert receipt["row_state"] == "present"


def test_terminal_exact_evidence_ignores_creator_liveness_and_age():
    observation = companion_turns.CreatedSessionObservation("present", "exact", "failed")
    receipt = _receipt(
        _index(phase="closed", closed_outcome="turn_record"),
        observation,
        liveness="dead",
        age=10**10_000,
    )
    assert receipt["operation_status"] == "failed"
    assert receipt["row_state"] == "present"


@pytest.mark.parametrize("field", ["row_state", "evidence_state", "turn_state"])
def test_unhashable_observation_values_return_all_null_identity(field):
    values = {
        "row_state": "present",
        "evidence_state": "exact",
        "turn_state": "claimed",
    }
    values[field] = ["PRIVATE-CANARY"]
    receipt = _receipt(_index(), companion_turns.CreatedSessionObservation(**values))

    assert receipt["backend_namespace"] is None
    assert receipt["client_request_id"] is None
    assert receipt["stored_session_id"] is None
    assert "CANARY" not in json.dumps(receipt)


@pytest.mark.parametrize(
    ("liveness", "age"),
    [
        (["alive", "LIVENESS-CANARY"], 1.0),
        ("invalid", 1.0),
        ("alive", True),
        ("alive", float("nan")),
        ("alive", float("inf")),
        ("alive", -1.0),
    ],
)
def test_malformed_liveness_or_age_returns_all_null_identity(liveness, age):
    receipt = _receipt(
        _index(),
        companion_turns.CreatedSessionObservation("present", "exact", "claimed"),
        liveness=liveness,
        age=age,
    )

    assert receipt["backend_namespace"] is None
    assert receipt["profile"] is None
    assert receipt["client_request_id"] is None
    assert receipt["stored_session_id"] is None


@pytest.mark.parametrize(
    "malformed",
    [
        {**_index(), "plaintext_prompt": "INDEX-CANARY"},
        {**_index(), "backend_namespace": {"secret": "BACKEND-CANARY"}},
        {**_index(), "target_profile": ["PROFILE-CANARY"]},
        {**_index(), "project_id": {"secret": "PROJECT-CANARY"}},
        {**_index(), "requested_id": {"secret": "ID-CANARY"}},
        {**_index(), "phase": "closed", "closed_outcome": None},
        {**_index(), "creator_pid": True},
    ],
)
def test_malformed_projection_boundary_returns_private_fixed_receipt(malformed):
    receipt = companion_creation.project_creation_receipt(
        client_request_id=REQUEST,
        index=malformed,
        observation=companion_turns.CreatedSessionObservation("present", "exact", "running"),
        creator_liveness="alive",
        age_seconds=1.0,
    )

    assert set(receipt) == RECEIPT_KEYS
    assert receipt == {
        "version": 1,
        "operation_kind": "create",
        "backend_namespace": None,
        "profile": None,
        "client_request_id": None,
        "project_id": None,
        "stored_session_id": None,
        "row_state": "unavailable",
        "operation_status": "recovery_required",
        "runtime_session_id": None,
    }
    encoded = json.dumps(receipt)
    assert "CANARY" not in encoded


def test_malformed_request_id_cannot_leak_through_projection_boundary():
    receipt = companion_creation.project_creation_receipt(
        client_request_id={"secret": "REQUEST-CANARY"},
        index=_index(),
        observation=companion_turns.CreatedSessionObservation("present", "exact", "claimed"),
        creator_liveness="alive",
        age_seconds=1.0,
    )

    assert set(receipt) == RECEIPT_KEYS
    assert receipt["client_request_id"] is None
    assert receipt["backend_namespace"] is None
    assert receipt["row_state"] == "unavailable"
    assert "REQUEST-CANARY" not in json.dumps(receipt)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("backend_namespace", "backend\nleak"),
        ("backend_namespace", "backend\u0085leak"),
        ("backend_namespace", "é" * 2049),
        ("target_profile", "Atlas"),
        ("target_profile", "atlas.dot"),
        ("requested_id", "created\x00session"),
        ("requested_id", "created\u0080session"),
        ("project_id", "project\rsecret"),
        ("project_id", "project\u009fsecret"),
        ("bound_at", "2026-09-10T10:00:00.0Z"),
        ("phase_at", "2026-09-10T10:00:01.0Z"),
    ],
)
def test_projection_rejects_noncanonical_protocol_identifiers(field, value):
    receipt = companion_creation.project_creation_receipt(
        client_request_id=REQUEST,
        index={**_index(), field: value},
        observation=companion_turns.CreatedSessionObservation("present", "exact", "claimed"),
        creator_liveness="alive",
        age_seconds=1.0,
    )
    assert receipt == {
        "version": 1,
        "operation_kind": "create",
        "backend_namespace": None,
        "profile": None,
        "client_request_id": None,
        "project_id": None,
        "stored_session_id": None,
        "row_state": "unavailable",
        "operation_status": "recovery_required",
        "runtime_session_id": None,
    }


def test_projection_preserves_non_control_unicode_protocol_identifiers():
    receipt = companion_creation.project_creation_receipt(
        client_request_id=REQUEST,
        index={
            **_index(),
            "backend_namespace": "bäckend",
            "requested_id": "会話",
            "project_id": "项目",
        },
        observation=companion_turns.CreatedSessionObservation("present", "exact", "claimed"),
        creator_liveness="alive",
        age_seconds=1.0,
    )

    assert receipt["backend_namespace"] == "bäckend"
    assert receipt["stored_session_id"] == "会話"
    assert receipt["project_id"] == "项目"
    assert receipt["operation_status"] == "claimed"


@pytest.mark.parametrize(
    "request_id",
    [
        "request-secret",
        "123E4567-E89B-42D3-A456-426614174000",
        "123e4567-e89b-12d3-a456-426614174000",
        "123e4567-e89b-42d3-7456-426614174000",
    ],
)
def test_projection_requires_canonical_uuid_v4_request_id(request_id):
    receipt = companion_creation.project_creation_receipt(
        client_request_id=request_id,
        index=_index(),
        observation=companion_turns.CreatedSessionObservation("present", "exact", "claimed"),
        creator_liveness="alive",
        age_seconds=1.0,
    )
    assert receipt["client_request_id"] is None
    assert receipt["backend_namespace"] is None


def test_observer_rejects_full_schema_invalid_index_before_reading():
    class NoReadDB:
        def _read_ctx(self):
            raise AssertionError("invalid index must not reach storage")

    malformed = {**_index(), "phase_at": "2026-09-10T09:59:59Z"}
    assert companion_turns.observe_created_session(
        NoReadDB(), malformed
    ) == companion_turns.CreatedSessionObservation("unavailable", "inconsistent")


@pytest.mark.parametrize(
    "outcome", ["completed", "failed", "cancelled", "interrupted_outcome_unknown"]
)
def test_creation_non_rejection_terminal_requires_prior_admission(tmp_path, outcome):
    db = SessionDB(tmp_path / "state.db")
    claim = _prepare(db)

    with pytest.raises(companion_turns.TurnStateError, match="admitted"):
        companion_turns.settle_turn(db, claim, outcome=outcome, final_tip_id=STORED)

    assert companion_turns.read_turn(db, OPERATION)["state"] == "claimed"
    db.close()


def test_observer_rejects_claim_shaped_non_rejection_terminal(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    claim = _prepare(db)
    turn_key = companion_turns._turn_key(OPERATION)
    record = json.loads(db.get_meta(turn_key))
    record.update({
        "state": "failed",
        "outcome": "failed",
        "finished_at": record["claimed_at"],
        "final_tip_id": STORED,
    })
    db.set_meta(turn_key, json.dumps(record))
    db._conn.execute(
        "DELETE FROM state_meta WHERE key = ?",
        (companion_turns._slot_key(claim.lineage_root_id),),
    )
    db._conn.commit()
    index = _index(phase="closed", closed_outcome="turn_record")

    assert companion_turns.observe_created_session(db, index).row_state == "unavailable"
    db.close()
