"""Final real-process Companion creation matrix: duplicate, race and crash boundaries.

Spec: ``docs/plans/companion-mobile-evidence/p4-current-design-v2.md`` sections 4.3/4.4 and
the completion requirements in ``docs/plans/companion-mobile-evidence/g3c-pause-state.md``
("final subprocess E2E duplicate/race/failure matrix").  Every scenario launches the
production stdio entrypoint in its own process and shares only the real temporary
``HERMES_HOME`` (C index, T turn records, active-session registry, state.db).
"""
from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import uuid
from typing import Any

import pytest

from hermes_cli import projects_db as pdb
from tests.tui_gateway.test_companion_transport_integration import (
    BACKEND,
    PROFILE,
    StdioRpcClient,
)

# Design §1.4: the receipt vocabulary is closed; every status is legal for any operation.
_RECEIPT_STATUSES = frozenset(
    {
        "not_found",
        "preparing",
        "claimed",
        "admitted",
        "running",
        "completed",
        "failed",
        "cancelled",
        "not_admitted",
        "interrupted_outcome_unknown",
    }
)
_ROW_STATES = frozenset({"absent", "present", "unavailable"})

TURN_SECONDS = 0.6


def _turn(duration: float = TURN_SECONDS) -> str:
    return json.dumps(
        {
            "duration_s": duration,
            "chunk": 1000,
            "delta_interval_s": 0.02,
            "tokens_per_delta": 1,
        },
        separators=(",", ":"),
    )


def _seed(base: Path, name: str) -> tuple[Path, Path, Any]:
    """Create the one home both real gateway processes share, with one canonical project."""
    home = base / name / "home"
    project = base / name / "project"
    home.mkdir(parents=True)
    project.mkdir(parents=True)
    (home / "config.yaml").write_text(
        "model: synthetic-heavy\ncompression:\n  enabled: false\n", encoding="utf-8"
    )
    connection = pdb.connect(home / "projects.db")
    try:
        project_id = pdb.create_project(
            connection, name="Canonical", folders=[str(project)], primary_path=str(project)
        )
    finally:
        connection.close()
    return home, project, project_id


def _create_params(request_id: str, project_id: int | None, text: str) -> dict[str, Any]:
    return {
        "version": 1,
        "backend_namespace": BACKEND,
        "profile": PROFILE,
        "client_request_id": request_id,
        "project_id": project_id,
        "text": text,
    }


def _reconcile_params(request_id: str) -> dict[str, str]:
    return {
        "operation_kind": "create",
        "backend_namespace": BACKEND,
        "profile": PROFILE,
        "client_request_id": request_id,
    }


def _events(path: Path) -> list[str]:
    if not path.exists():
        return []
    return [line for line in path.read_text(encoding="utf-8").splitlines() if line]


def _count(events: list[str], event: str) -> int:
    return sum(1 for line in events if line.split(" ", 1)[0] == event)


def _session_rows(home: Path) -> list[str]:
    """Every persisted session row of the target profile, straight from state.db."""
    database = home / "state.db"
    if not database.exists():
        return []
    connection = sqlite3.connect(database)
    try:
        return [
            str(row[0])
            for row in connection.execute(
                "select id from sessions where profile_name = ? order by id", (PROFILE,)
            )
        ]
    finally:
        connection.close()


def _shared_env(monkeypatch: pytest.MonkeyPatch, events: Path) -> None:
    monkeypatch.setenv("HERMES_COMPANION_TEST_EVENTS_FILE", str(events))


def _unreachable_call(client: StdioRpcClient, request_id: str, params: dict[str, Any]) -> Any:
    """Send a request whose process is expected to die; return the death evidence."""
    client.send(request_id, "companion.sessions.create", params)
    with pytest.raises(AssertionError) as failure:
        client.receive(lambda value: value.get("id") == request_id, timeout=30.0)
    return str(failure.value)


def test_duplicate_create_from_two_processes_yields_one_session_and_one_dispatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two independent delivery processes, one request key: one creation, never two.

    Design §4.4: a competing delivery process releases its unused reservation and never
    enters creation, so at most one runtime exists for one ``client_request_id``.
    """
    home, _project, project_id = _seed(tmp_path, "duplicate")
    events = tmp_path / "duplicate" / "events.log"
    _shared_env(monkeypatch, events)
    request_id = str(uuid.uuid4())
    params = _create_params(request_id, project_id, _turn())

    first = StdioRpcClient(home)
    second = StdioRpcClient(home)
    try:
        # Send both requests back to back so the two processes genuinely race.
        first.send("create-first", "companion.sessions.create", params)
        second.send("create-second", "companion.sessions.create", params)

        outcomes: dict[str, Any] = {}
        for label, client, request in (
            ("first", first, "create-first"),
            ("second", second, "create-second"),
        ):
            try:
                outcomes[label] = client.receive(
                    lambda value, request=request: value.get("id") == request, timeout=60.0
                )
            except AssertionError as error:
                outcomes[label] = {"error": str(error)}
    finally:
        first.close()
        second.close()

    recorded = _events(events)
    rows = _session_rows(home)

    # §4.4: a competing delivery process releases its unused reservation and never enters
    # creation, so exactly one process creates and exactly one runtime is dispatched.
    assert _count(recorded, "create_entry") == 1, recorded
    assert _count(recorded, "agent_build") == 1, recorded
    assert len(rows) == 1, rows

    receipts: list[dict[str, Any]] = []
    for outcome in outcomes.values():
        if isinstance(outcome.get("result"), dict):
            receipt = outcome["result"]
            assert receipt["client_request_id"] == request_id, receipt
            assert receipt["operation_status"] in _RECEIPT_STATUSES, receipt
            assert receipt["row_state"] in _ROW_STATES, receipt
            # One request key, one logical conversation: a receipt may still leave the row
            # unknown, but it may never point somewhere else.
            assert receipt["stored_session_id"] in {None, rows[0]}, receipt
            receipts.append(receipt)
        else:
            # A peer that refuses must say so explicitly instead of continuing silently.
            failure = outcome["error"]
            assert isinstance(failure, dict) and failure.get("code") in {4090, 4091}, outcome
    # Non-vacuity: the operation really reached the stored row, not just an empty shell.
    assert any(receipt["stored_session_id"] == rows[0] for receipt in receipts), outcomes
    runtimes = {receipt["runtime_session_id"] for receipt in receipts} - {None}
    assert len(runtimes) <= 1, runtimes


def test_crash_before_submit_entry_recovers_as_not_admitted_with_zero_dispatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Death while dispatching must settle to not_admitted and never leave a running turn."""
    home, _project, project_id = _seed(tmp_path, "crash-pre-submit")
    events = tmp_path / "crash-pre-submit" / "events.log"
    _shared_env(monkeypatch, events)
    request_id = str(uuid.uuid4())
    params = _create_params(request_id, project_id, _turn())

    monkeypatch.setenv("HERMES_COMPANION_TEST_HALT_AT", "submit_entry")
    rigged = StdioRpcClient(home)
    try:
        rigged.send("create-crashed", "companion.sessions.create", params)
        with pytest.raises(AssertionError):
            rigged.receive(
                lambda value: value.get("id") == "create-crashed", timeout=60.0
            )
        # Death is verified, not inferred from a receive timeout: the halt point fired and
        # the process left through the crash exit code.
        assert rigged.process.wait(timeout=30) == 9, rigged.process.returncode
    finally:
        rigged.close()
    monkeypatch.delenv("HERMES_COMPANION_TEST_HALT_AT", raising=False)

    recorded = _events(events)
    assert _count(recorded, "create_entry") == 1, recorded
    assert _count(recorded, "agent_build") == 0, recorded
    assert ["halt", "submit_entry"] in [line.split()[:2] for line in recorded], recorded

    rows_before = _session_rows(home)
    dispatches_before = _count(recorded, "agent_build")
    fresh = StdioRpcClient(home)
    try:
        response = fresh.call(
            "reconcile-crashed", "companion.sessions.reconcile", _reconcile_params(request_id)
        )
        assert "result" in response, response
        receipt = response["result"]
        assert receipt["operation_status"] == "not_admitted", receipt
        assert receipt["runtime_session_id"] is None, receipt
        assert receipt["client_request_id"] == request_id

        retry = fresh.call("create-retry", "companion.sessions.create", params)
        retried = retry.get("result")
        if isinstance(retried, dict):
            assert retried["operation_status"] == "not_admitted", retried
            assert retried["runtime_session_id"] is None, retried
            # A closed index is terminal: the retry may never resurrect the request.
            assert retried["client_request_id"] == request_id, retried
    finally:
        fresh.close()

    # The retry is judged by its effect, whatever envelope it arrived in.
    assert _session_rows(home) == rows_before, (rows_before, _session_rows(home))
    final = _events(events)
    assert _count(final, "agent_build") == dispatches_before, final
    assert _count(final, "submit_entry") == 1, final


def test_crash_after_admission_recovers_as_unknown_outcome(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Death after the durable admission but before the run must never be reported as done.

    Design §4.3 ("Admitted, before build/thread — death ⇒ interrupted_outcome_unknown"):
    the ledger keeps the admission, so an interrupted outcome is the only honest receipt.
    """
    home, _project, project_id = _seed(tmp_path, "crash-admitted")
    events = tmp_path / "crash-admitted" / "events.log"
    _shared_env(monkeypatch, events)
    request_id = str(uuid.uuid4())
    params = _create_params(request_id, project_id, _turn(duration=30.0))

    monkeypatch.setenv("HERMES_COMPANION_TEST_HALT_AT", "agent_build")
    rigged = StdioRpcClient(home)
    try:
        rigged.send("create-crashed", "companion.sessions.create", params)
        with pytest.raises(AssertionError):
            rigged.receive(lambda value: value.get("id") == "create-crashed", timeout=60.0)
    finally:
        rigged.close()
    monkeypatch.delenv("HERMES_COMPANION_TEST_HALT_AT", raising=False)

    recorded = _events(events)
    assert _count(recorded, "create_entry") == 1, recorded
    assert _count(recorded, "submit_entry") == 1, recorded

    fresh = StdioRpcClient(home)
    try:
        response = fresh.call(
            "reconcile-crashed", "companion.sessions.reconcile", _reconcile_params(request_id)
        )
        assert "result" in response, response
        receipt = response["result"]
        assert receipt["operation_status"] == "interrupted_outcome_unknown", receipt
        assert receipt["client_request_id"] == request_id
        assert receipt["row_state"] == "present", receipt
        # The admission is durable, but nothing was reported as done and reconcile is a read.
        assert receipt["runtime_session_id"] is None, receipt
        after = _events(events)
        assert _count(after, "submit_entry") == 1, after
        assert _count(after, "agent_build") == 1, after
    finally:
        fresh.close()


def test_same_request_id_with_a_different_payload_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One request key owns exactly one payload: a conflicting re-use never adopts or recreates."""
    home, _project, project_id = _seed(tmp_path, "conflict")
    events = tmp_path / "conflict" / "events.log"
    _shared_env(monkeypatch, events)
    request_id = str(uuid.uuid4())

    owner = StdioRpcClient(home)
    try:
        first = owner.call(
            "create-owner",
            "companion.sessions.create",
            _create_params(request_id, project_id, _turn()),
        )
        assert first["result"]["operation_status"] == "admitted", first
        stored = first["result"]["stored_session_id"]
    finally:
        owner.close()

    rows_after_first = _session_rows(home)
    dispatches_after_first = _count(_events(events), "agent_build")
    assert rows_after_first == [stored], rows_after_first

    impostor = StdioRpcClient(home)
    try:
        conflict = impostor.call(
            "create-conflict",
            "companion.sessions.create",
            _create_params(request_id, project_id, _turn(duration=11.0)),
        )
    finally:
        impostor.close()

    if "error" in conflict:
        # Documented conflict contract: one request key owns one payload.
        assert conflict["error"]["code"] == 4090, conflict
    else:
        # The product path refuses instead of adopting, so a receipt here is a contract
        # violation, not an alternative success.
        pytest.fail(f"a conflicting payload must be refused: {conflict}")
    assert _session_rows(home) == rows_after_first, _session_rows(home)
    assert _count(_events(events), "agent_build") == dispatches_after_first, _events(events)
def test_death_before_the_trusted_create_leaves_no_row_and_no_dispatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Death before the reserved create commits must settle to not_admitted with row absent."""
    home, _project, project_id = _seed(tmp_path, "crash-pre-create")
    events = tmp_path / "crash-pre-create" / "events.log"
    _shared_env(monkeypatch, events)
    request_id = str(uuid.uuid4())
    params = _create_params(request_id, project_id, _turn())

    monkeypatch.setenv("HERMES_COMPANION_TEST_HALT_AT", "create_entry")
    rigged = StdioRpcClient(home)
    try:
        rigged.send("create-crashed", "companion.sessions.create", params)
        with pytest.raises(AssertionError):
            rigged.receive(
                lambda value: value.get("id") == "create-crashed", timeout=60.0
            )
        assert rigged.process.wait(timeout=30) == 9, rigged.process.returncode
    finally:
        rigged.close()
    monkeypatch.delenv("HERMES_COMPANION_TEST_HALT_AT", raising=False)

    recorded = _events(events)
    assert _count(recorded, "create_entry") == 1, recorded
    assert ["halt", "create_entry"] in [line.split()[:2] for line in recorded], recorded
    assert _session_rows(home) == [], _session_rows(home)

    fresh = StdioRpcClient(home)
    try:
        response = fresh.call(
            "reconcile-pre-create", "companion.sessions.reconcile", _reconcile_params(request_id)
        )
        assert "result" in response, response
        receipt = response["result"]
        assert receipt["operation_status"] == "not_admitted", receipt
        assert receipt["row_state"] == "absent", receipt
        assert receipt["runtime_session_id"] is None, receipt
        assert receipt["client_request_id"] == request_id
        reserved = receipt["stored_session_id"]
        assert isinstance(reserved, str) and reserved, receipt

        retry = fresh.call("create-retry-pre-create", "companion.sessions.create", params)
        retried = retry.get("result")
        if isinstance(retried, dict):
            # The reservation is stable: a retry re-reads the same closed operation
            # instead of minting a second identity.
            assert retried["stored_session_id"] == reserved, retried
            assert retried["operation_status"] == "not_admitted", retried
            assert retried["row_state"] == "absent", retried
    finally:
        fresh.close()

    # Nothing was created, and the retry never entered the dispatch pipeline.
    assert _session_rows(home) == [], _session_rows(home)
    final = _events(events)
    assert _count(final, "submit_entry") == 0, final
    assert _count(final, "agent_build") == 0, final
