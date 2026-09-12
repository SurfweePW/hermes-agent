"""Dead-creator creation recovery is terminal-only and fail-closed."""
from __future__ import annotations

from contextlib import contextmanager
import json

import pytest

from hermes_state import SessionDB
from tui_gateway import companion_creation, companion_sessions, companion_turns

OWNER = "basic:owner"
REQUEST = "123e4567-e89b-42d3-a456-426614174000"
DIGEST = "a" * 64
OPERATION = "b" * 48
STORED = "created-session"
CREATOR = {
    "creator_pid": 123,
    "creator_started": 456,
    "creator_token": "c" * 48,
    "creator_epoch": 1,
}
RECEIPT_KEYS = {
    "version", "operation_kind", "backend_namespace", "profile",
    "client_request_id", "project_id", "stored_session_id", "row_state",
    "operation_status", "runtime_session_id",
}


def _bind(ledger: SessionDB) -> dict:
    return companion_creation._creation_request_index(
        ledger,
        owner=OWNER,
        client_request_id=REQUEST,
        payload_digest=DIGEST,
        backend="backend",
        profile="atlas",
        stored_id=STORED,
        project_id="project-1",
        operation_id=OPERATION,
        creator_pid=CREATOR["creator_pid"],
        creator_started=CREATOR["creator_started"],
        creator_token=CREATOR["creator_token"],
        bound_at="2026-09-10T10:00:00Z",
    )[0]


def _phase(ledger: SessionDB, index: dict, phase: str) -> dict:
    path = ["bound", "preparing", "prepared", "dispatching"]
    current = index
    while current["phase"] != phase:
        next_phase = path[path.index(current["phase"]) + 1]
        current, changed = companion_creation._advance_creation_phase(
            ledger,
            owner=OWNER,
            client_request_id=REQUEST,
            snapshot=current,
            creator=CREATOR,
            next_phase=next_phase,
            phase_at=f"2026-09-10T10:00:0{path.index(next_phase)}Z",
        )
        assert changed is True
    return current


def _prepare(target: SessionDB):
    return companion_turns.prepare_created_session(
        target,
        {
            "session_id": STORED,
            "source": "companion",
            "model": "test/model",
            "model_config": {"model": "test/model", "provider": "PRIVATE-PROVIDER"},
            "profile_name": "atlas",
            "cwd": "/private/raw/path",
            "git_repo_root": "/private/raw/path",
        },
        OPERATION,
        DIGEST,
        (CREATOR["creator_pid"], CREATOR["creator_started"], CREATOR["creator_token"]),
    )


def _stored_index(ledger: SessionDB) -> dict:
    raw = ledger.get_meta(companion_sessions._continuity_v3_key(OWNER, REQUEST))
    assert raw is not None
    return json.loads(raw)


@pytest.mark.parametrize(
    (
        "phase", "target_state", "creator_liveness", "target_liveness", "age",
        "status", "closed",
    ),
    [
        ("bound", "absent", "dead", None, 1.0, "not_admitted", "not_admitted"),
        ("preparing", "absent", "dead", None, 1.0, "not_admitted", "not_admitted"),
        ("bound", "absent", "alive", None, 1.0, "preparing", None),
        ("bound", "absent", "alive", None, 61.0, "recovery_required", None),
        ("bound", "absent", "unknown", None, 1.0, "recovery_required", None),
        ("prepared", "claimed", "dead", None, 1.0, "not_admitted", "turn_record"),
        ("dispatching", "claimed", "dead", None, 1.0, "not_admitted", "turn_record"),
        ("dispatching", "admitted", "dead", "dead", 1.0, "interrupted_outcome_unknown", "turn_record"),
        ("dispatching", "running", "dead", "dead", 1.0, "interrupted_outcome_unknown", "turn_record"),
        ("dispatching", "running", "dead", "alive", 1.0, "recovery_required", None),
        ("dispatching", "running", "dead", "unknown", 1.0, "recovery_required", None),
        ("dispatching", "failed", "dead", None, 1.0, "failed", "turn_record"),
        ("prepared", "admitted", "dead", None, 1.0, "recovery_required", None),
        ("prepared", "absent", "dead", None, 1.0, "recovery_required", None),
        ("dispatching", "inconsistent", "dead", None, 1.0, "recovery_required", None),
        ("dispatching", "unavailable", "dead", None, 1.0, "recovery_required", None),
    ],
)
def test_dead_creator_recovery_failure_table(
    tmp_path,
    monkeypatch,
    phase,
    target_state,
    creator_liveness,
    target_liveness,
    age,
    status,
    closed,
):
    ledger = SessionDB(tmp_path / "ledger.db")
    target = SessionDB(tmp_path / "target.db")
    index = _phase(ledger, _bind(ledger), phase)
    claim = None
    if target_state not in {"absent", "unavailable"}:
        claim = _prepare(target)
        if target_state in {"admitted", "running", "failed"}:
            companion_turns.admit_turn(target, claim, runtime_id="PRIVATE-RUNTIME")
        if target_state == "running":
            monkeypatch.setattr(
                companion_turns, "current_executor", lambda: (777, 888, "d" * 32)
            )
            companion_turns.mark_running(target, claim, runtime_id="PRIVATE-RUNTIME")
        elif target_state == "failed":
            companion_turns.settle_turn(
                target, claim, outcome="failed", final_tip_id=STORED
            )
        elif target_state == "inconsistent":
            target._conn.execute(
                "DELETE FROM state_meta WHERE key = ?",
                (companion_turns._slot_key(STORED),),
            )
            target._conn.commit()

    creator_probes = []
    target_probes = []
    monkeypatch.setattr(
        companion_creation,
        "_creation_creator_liveness",
        lambda observed: creator_probes.append(observed["creator_token"]) or creator_liveness,
    )
    monkeypatch.setattr(
        companion_turns,
        "executor_liveness",
        lambda record: target_probes.append(record["executor_token"]) or target_liveness,
    )
    ledger_before = ledger._conn.total_changes
    target_before = target._conn.total_changes

    class RecoveryTarget:
        def __init__(self):
            self.reads = 0
            self.writes = 0

        @contextmanager
        def _read_ctx(self):
            self.reads += 1
            if target_state == "unavailable":
                raise OSError("PRIVATE-TARGET-PATH")
            with target._read_ctx() as conn:
                yield conn

        def _execute_write(self, callback):
            self.writes += 1
            return target._execute_write(callback)

        def __getattr__(self, name):
            raise AssertionError(f"recovery accessed forbidden target path: {name}")

    recovery_target = RecoveryTarget()

    receipt = companion_creation._reconcile_creation_recovery(
        ledger,
        recovery_target,
        owner=OWNER,
        client_request_id=REQUEST,
        index=index,
        age_seconds=age,
        phase_at="2026-09-10T10:00:09Z",
    )

    assert set(receipt) == RECEIPT_KEYS
    assert receipt["operation_status"] == status
    assert receipt["runtime_session_id"] is None
    assert creator_probes == [CREATOR["creator_token"]]
    assert len(target_probes) == (1 if target_liveness is not None else 0)
    assert recovery_target.reads == 1
    assert recovery_target.writes == (
        1
        if target_state in {"claimed", "admitted", "running"}
        and status != "recovery_required"
        else 0
    )
    stored = _stored_index(ledger)
    assert stored["closed_outcome"] == closed
    if closed is None:
        assert ledger._conn.total_changes == ledger_before
    if target_state in {"absent", "failed", "inconsistent", "unavailable"} or target_liveness in {"alive", "unknown"}:
        assert target._conn.total_changes == target_before
    if target_state in {"claimed", "admitted", "running"} and status != "recovery_required":
        assert companion_turns.read_turn(target, OPERATION)["state"] == status
    encoded = json.dumps(receipt)
    for private in (DIGEST, OPERATION, CREATOR["creator_token"], "PRIVATE-RUNTIME", "/private/raw/path"):
        assert private not in encoded
    ledger.close()
    target.close()


def test_settlement_close_crash_resumes_and_competing_finalizers_are_idempotent(
    tmp_path, monkeypatch
):
    ledger = SessionDB(tmp_path / "ledger.db")
    target = SessionDB(tmp_path / "target.db")
    index = _phase(ledger, _bind(ledger), "prepared")
    _prepare(target)
    monkeypatch.setattr(companion_creation, "_creation_creator_liveness", lambda _index: "dead")
    real_close = companion_creation._close_creation_phase
    close_calls = 0

    def fail_first_close(*args, **kwargs):
        nonlocal close_calls
        close_calls += 1
        if close_calls == 1:
            raise companion_sessions.CompanionSessionsError("fixed close failure", 5006)
        return real_close(*args, **kwargs)

    monkeypatch.setattr(companion_creation, "_close_creation_phase", fail_first_close)
    with pytest.raises(companion_sessions.CompanionSessionsError, match="fixed close failure"):
        companion_creation._reconcile_creation_recovery(
            ledger,
            target,
            owner=OWNER,
            client_request_id=REQUEST,
            index=index,
            age_seconds=1.0,
            phase_at="2026-09-10T10:00:08Z",
        )
    assert companion_turns.read_turn(target, OPERATION)["state"] == "not_admitted"
    assert _stored_index(ledger)["phase"] == "prepared"

    first = companion_creation._reconcile_creation_recovery(
        ledger,
        target,
        owner=OWNER,
        client_request_id=REQUEST,
        index=index,
        age_seconds=1.0,
        phase_at="2026-09-10T10:00:09Z",
    )
    second = companion_creation._reconcile_creation_recovery(
        ledger,
        target,
        owner=OWNER,
        client_request_id=REQUEST,
        index=index,
        age_seconds=1.0,
        phase_at="2026-09-10T10:00:10Z",
    )

    assert first == second
    assert first["operation_status"] == "not_admitted"
    assert _stored_index(ledger)["closed_outcome"] == "turn_record"
    assert companion_turns.read_turn(target, OPERATION)["state"] == "not_admitted"
    ledger.close()
    target.close()
