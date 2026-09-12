"""Creator liveness and strict creation phase coordination."""
from __future__ import annotations

import json
import multiprocessing
import threading

import pytest

from hermes_state import SessionDB
from tui_gateway import companion_creation as subject, companion_sessions

OWNER = "basic:owner"
REQUEST = "request-1"
CREATOR = {
    "creator_pid": 123,
    "creator_started": 456,
    "creator_token": "1" * 48,
    "creator_epoch": 1,
}


def _bound(db):
    return subject._creation_request_index(
        db, owner=OWNER, client_request_id=REQUEST, payload_digest="a" * 64,
        backend="backend", profile="atlas", stored_id="stored", project_id="project",
        operation_id="b" * 48, creator_pid=CREATOR["creator_pid"],
        creator_started=CREATOR["creator_started"], creator_token=CREATOR["creator_token"],
        bound_at="2026-09-10T10:00:00Z",
    )[0]


def test_creator_snapshot_fails_closed_without_canonical_start(monkeypatch):
    monkeypatch.setattr(subject, "get_process_start_time", lambda _pid: None)
    with pytest.raises(companion_sessions.CompanionSessionsError) as raised:
        subject._snapshot_creation_creator()
    assert raised.value.code == 5006
    assert "identity is unavailable" in str(raised.value)


def test_creator_snapshot_is_canonical(monkeypatch):
    monkeypatch.setattr(subject, "get_process_start_time", lambda _pid: 99)
    result = subject._snapshot_creation_creator()
    assert isinstance(result["creator_pid"], int) and result["creator_pid"] > 0
    assert result["creator_started"] == 99
    assert result["creator_epoch"] == 1
    assert isinstance(result["creator_token"], str) and len(result["creator_token"]) == 48
    assert set(result["creator_token"]) <= set("0123456789abcdef")


@pytest.mark.parametrize(
    ("pid_state", "started", "expected"),
    [("alive", 456, "alive"), ("dead", None, "dead"), ("unknown", None, "unknown"),
     ("alive", 999, "dead"), ("alive", None, "unknown"),
     ("alive", 456.0, "unknown")],
)
def test_creator_liveness_is_tristate_and_probes_at_most_once(
    monkeypatch, pid_state, started, expected
):
    calls = {"liveness": 0, "started": 0}

    def pid_liveness(_pid):
        calls["liveness"] += 1
        return pid_state

    def process_started(_pid):
        calls["started"] += 1
        return started

    monkeypatch.setattr(subject, "probe_pid_liveness", pid_liveness)
    monkeypatch.setattr(subject, "get_process_start_time", process_started)
    index = {**CREATOR, "bound_at": "1900-01-01T00:00:00Z"}
    assert subject._creation_creator_liveness(index) == expected
    assert calls["liveness"] == 1
    assert calls["started"] == (1 if pid_state == "alive" else 0)


@pytest.mark.parametrize("seam", ["probe_pid_liveness", "get_process_start_time"])
def test_creator_liveness_probe_exception_is_unknown(monkeypatch, seam):
    monkeypatch.setattr(subject, "probe_pid_liveness", lambda _pid: "alive")
    monkeypatch.setattr(subject, "get_process_start_time", lambda _pid: 456)

    def fail(_pid):
        raise OSError("private host detail")

    monkeypatch.setattr(subject, seam, fail)
    assert subject._creation_creator_liveness(CREATOR) == "unknown"


@pytest.mark.macos_only
def test_creator_snapshot_resets_in_fork_child_while_parent_lock_is_held(monkeypatch):
    monkeypatch.setattr(subject, "get_process_start_time", lambda pid: pid)
    parent_before = subject._snapshot_creation_creator()
    receive, send = multiprocessing.get_context("fork").Pipe(duplex=False)

    def snapshot_in_child():
        send.send(subject._snapshot_creation_creator())
        send.close()

    process = multiprocessing.get_context("fork").Process(target=snapshot_in_child)
    subject._PROCESS_CREATION_TOKEN_LOCK.acquire()
    try:
        process.start()
        assert receive.poll(2), "fork child blocked on an inherited creator-token lock"
        child = receive.recv()
        process.join(2)
        assert process.exitcode == 0
    finally:
        subject._PROCESS_CREATION_TOKEN_LOCK.release()
        receive.close()
        send.close()
        if process.is_alive():
            process.terminate()
            process.join(2)

    parent_after = subject._snapshot_creation_creator()
    assert child["creator_pid"] != parent_before["creator_pid"]
    assert child["creator_token"] != parent_before["creator_token"]
    assert parent_after["creator_token"] == parent_before["creator_token"]


def test_exact_phase_path_and_close_are_final(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    current = _bound(db)
    for phase, timestamp in (
        ("preparing", "2026-09-10T10:00:01Z"),
        ("prepared", "2026-09-10T10:00:02Z"),
        ("dispatching", "2026-09-10T10:00:03Z"),
    ):
        current, changed = subject._advance_creation_phase(
            db, owner=OWNER, client_request_id=REQUEST, snapshot=current,
            creator=CREATOR, next_phase=phase, phase_at=timestamp,
        )
        assert changed is True
        assert current["phase"] == phase
    closed, changed = subject._close_creation_phase(
        db, owner=OWNER, client_request_id=REQUEST, snapshot=current,
        creator=CREATOR, closed_outcome="turn_record", phase_at="2026-09-10T10:00:04Z",
    )
    assert changed is True
    assert closed["closed_outcome"] == "turn_record"
    with pytest.raises(companion_sessions.CompanionSessionsError):
        subject._advance_creation_phase(
            db, owner=OWNER, client_request_id=REQUEST, snapshot=closed,
            creator=CREATOR, next_phase="preparing", phase_at="2026-09-10T10:00:05Z",
        )
    db.close()


@pytest.mark.parametrize("next_phase", ["prepared", "dispatching", "bound"])
def test_phase_cas_rejects_skip_or_backward(tmp_path, next_phase):
    db = SessionDB(tmp_path / "state.db")
    snapshot = _bound(db)
    with pytest.raises(companion_sessions.CompanionSessionsError) as raised:
        subject._advance_creation_phase(
            db, owner=OWNER, client_request_id=REQUEST, snapshot=snapshot,
            creator=CREATOR, next_phase=next_phase, phase_at="2026-09-10T10:00:01Z",
        )
    assert raised.value.code == 4090
    db.close()


def test_phase_cas_rejects_stale_immutable_change_and_takeover(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    snapshot = _bound(db)
    advanced, _ = subject._advance_creation_phase(
        db, owner=OWNER, client_request_id=REQUEST, snapshot=snapshot,
        creator=CREATOR, next_phase="preparing", phase_at="2026-09-10T10:00:01Z",
    )
    with pytest.raises(companion_sessions.CompanionSessionsError):
        subject._advance_creation_phase(
            db, owner=OWNER, client_request_id=REQUEST, snapshot=snapshot,
            creator=CREATOR, next_phase="preparing", phase_at="2026-09-10T10:00:02Z",
        )
    for creator in ({**CREATOR, "creator_token": "2" * 48}, {**CREATOR, "creator_epoch": 2}):
        with pytest.raises(companion_sessions.CompanionSessionsError):
            subject._advance_creation_phase(
                db, owner=OWNER, client_request_id=REQUEST, snapshot=advanced,
                creator=creator, next_phase="prepared", phase_at="2026-09-10T10:00:02Z",
            )
    stored = db.get_meta(companion_sessions._continuity_v3_key(OWNER, REQUEST))
    assert stored is not None
    raw = json.loads(stored)
    raw["backend_namespace"] = "other"
    db.set_meta(companion_sessions._continuity_v3_key(OWNER, REQUEST), json.dumps(raw))
    with pytest.raises(companion_sessions.CompanionSessionsError):
        subject._advance_creation_phase(
            db, owner=OWNER, client_request_id=REQUEST, snapshot=advanced,
            creator=CREATOR, next_phase="prepared", phase_at="2026-09-10T10:00:02Z",
        )
    db.close()


@pytest.mark.parametrize(
    ("field", "equal_but_wrong_type"),
    [
        ("creator_pid", 123.0),
        ("creator_started", 456.0),
        ("creator_epoch", True),
    ],
)
def test_phase_cas_requires_type_exact_creator_identity(
    tmp_path, field, equal_but_wrong_type
):
    db = SessionDB(tmp_path / "state.db")
    snapshot = _bound(db)
    creator = {**CREATOR, field: equal_but_wrong_type}

    with pytest.raises(companion_sessions.CompanionSessionsError) as raised:
        subject._advance_creation_phase(
            db, owner=OWNER, client_request_id=REQUEST, snapshot=snapshot,
            creator=creator, next_phase="preparing", phase_at="2026-09-10T10:00:01Z",
        )

    assert raised.value.code == 4090
    assert "identity conflicts" in str(raised.value)
    db.close()


def test_same_exact_cas_has_one_changed_here_winner(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    snapshot = _bound(db)
    db.close()
    barrier = threading.Barrier(2)
    results = []

    def run():
        local = SessionDB(tmp_path / "state.db")
        barrier.wait()
        results.append(subject._advance_creation_phase(
            local, owner=OWNER, client_request_id=REQUEST, snapshot=snapshot,
            creator=CREATOR, next_phase="preparing", phase_at="2026-09-10T10:00:01Z",
        )[1])
        local.close()

    threads = [threading.Thread(target=run) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(results) == [False, True]


@pytest.mark.parametrize("outcome", ["not_admitted", "turn_record"])
def test_close_allows_only_documented_outcomes_and_exact_replay(tmp_path, outcome):
    db = SessionDB(tmp_path / "state.db")
    snapshot = _bound(db)
    closed, changed_here = subject._close_creation_phase(
        db, owner=OWNER, client_request_id=REQUEST, snapshot=snapshot,
        creator=CREATOR, closed_outcome=outcome, phase_at="2026-09-10T10:00:01Z",
    )
    observed, replay_changed_here = subject._close_creation_phase(
        db, owner=OWNER, client_request_id=REQUEST, snapshot=snapshot,
        creator=CREATOR, closed_outcome=outcome, phase_at="2026-09-10T10:00:01Z",
    )
    assert changed_here is True
    assert replay_changed_here is False
    assert observed == closed
    db.close()


@pytest.mark.parametrize("outcome", [None, "success", "unknown"])
def test_close_rejects_arbitrary_outcomes(tmp_path, outcome):
    db = SessionDB(tmp_path / "state.db")
    snapshot = _bound(db)
    with pytest.raises(companion_sessions.CompanionSessionsError) as raised:
        subject._close_creation_phase(
            db, owner=OWNER, client_request_id=REQUEST, snapshot=snapshot,
            creator=CREATOR, closed_outcome=outcome, phase_at="2026-09-10T10:00:01Z",
        )
    assert raised.value.code == -32602
    db.close()
