"""Real stdio JSON-RPC gate for Companion continuity (MC-09/11/12/13)."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import queue
import sqlite3
import subprocess
import sys
import threading
import time
from typing import Any

from hermes_state import SessionDB


REPO_ROOT = Path(__file__).resolve().parents[2]
LAUNCHER = REPO_ROOT / "tests" / "tui_gateway" / "fixtures" / "companion_stdio_gateway.py"
BACKEND = "p1-transport-gate"
PROFILE = "default"


class StdioRpcClient:
    """A real newline-delimited JSON-RPC client around the production entrypoint."""

    def __init__(self, home: Path, *, consume_output: bool = True):
        env = os.environ.copy()
        env.update(
            {
                "HERMES_HOME": str(home),
                "GATEWAY_RELAY_ID": BACKEND,
                "HERMES_ISO_CERTIFY_SYNTH_TURN": "1",
                "HERMES_IGNORE_RULES": "1",
                "PYTHONUNBUFFERED": "1",
            }
        )
        self.process = subprocess.Popen(
            [sys.executable, str(LAUNCHER)],
            cwd=REPO_ROOT,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        self._messages: queue.Queue[dict[str, Any]] = queue.Queue()
        self._reader = None
        if consume_output:
            self._reader = threading.Thread(target=self._read_stdout, daemon=True)
            self._reader.start()
            ready = self.receive(
                lambda value: value.get("method") == "event"
                and value.get("params", {}).get("type") == "gateway.ready"
            )
            assert ready["params"]["payload"]["change_events"] is True

    def _read_stdout(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                self._messages.put(value)

    def send(self, request_id: str, method: str, params: dict[str, Any]) -> None:
        assert self.process.stdin is not None
        payload = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        self.process.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
        self.process.stdin.flush()

    def call(self, request_id: str, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self.send(request_id, method, params)
        return self.receive(lambda value: value.get("id") == request_id)

    def receive(self, predicate, timeout: float = 15.0) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        skipped: list[dict[str, Any]] = []
        try:
            while time.monotonic() < deadline:
                try:
                    value = self._messages.get(timeout=min(0.1, deadline - time.monotonic()))
                except queue.Empty:
                    if self.process.poll() is not None:
                        stderr = self.process.stderr.read() if self.process.stderr else ""
                        raise AssertionError(
                            f"gateway exited {self.process.returncode}: {stderr[-2000:]}"
                        )
                    continue
                if predicate(value):
                    return value
                skipped.append(value)
        finally:
            for value in skipped:
                self._messages.put(value)
        raise AssertionError("timed out waiting for JSON-RPC frame")

    def close(self, *, kill: bool = False) -> None:
        if self.process.poll() is None:
            if kill:
                self.process.kill()
            else:
                if self.process.stdin is not None:
                    self.process.stdin.close()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)


def _prepare_home(base: Path, name: str) -> tuple[Path, Path]:
    home = base / name / "home"
    project = base / name / "project"
    home.mkdir(parents=True)
    project.mkdir(parents=True)
    (home / "config.yaml").write_text(
        "model: synthetic-heavy\ncompression:\n  enabled: false\n",
        encoding="utf-8",
    )
    db = SessionDB(home / "state.db")
    db.create_session(
        "lineage-root",
        source="desktop",
        cwd=str(project),
        profile_name=PROFILE,
        git_repo_root=str(project),
    )
    db.set_session_title("lineage-root", "Transport continuity")
    db.append_message("lineage-root", "user", "desktop-before")
    db.append_message("lineage-root", "assistant", "desktop-ready")
    db.end_session("lineage-root", "compression")
    db.create_session(
        "lineage-tip",
        source="desktop",
        parent_session_id="lineage-root",
        cwd=str(project),
        profile_name=PROFILE,
        git_repo_root=str(project),
    )
    db.set_session_title("lineage-tip", "Transport continuity")
    db.append_message("lineage-tip", "user", "desktop-after-compression")
    db.append_message("lineage-tip", "assistant", "desktop-tip-ready")
    db.close()
    return home, project


def _continue_params(request_id: str, *, duration: float) -> dict[str, Any]:
    return {
        "backend_namespace": BACKEND,
        "profile": PROFILE,
        "stored_session_id": "lineage-root",
        "text": json.dumps(
            {
                "duration_s": duration,
                "chunk": 1000,
                "delta_interval_s": 0.02,
                "tokens_per_delta": 1,
            },
            separators=(",", ":"),
        ),
        "client_request_id": request_id,
    }


def _reconcile_params(request_id: str) -> dict[str, str]:
    return {
        "backend_namespace": BACKEND,
        "profile": PROFILE,
        "stored_session_id": "lineage-root",
        "client_request_id": request_id,
    }


def _turn_records(home: Path) -> list[dict[str, Any]]:
    with sqlite3.connect(home / "state.db") as conn:
        rows = conn.execute(
            "SELECT value FROM state_meta WHERE key LIKE 'continuity_turn_v3:%' ORDER BY key"
        ).fetchall()
    return [json.loads(row[0]) for row in rows]


def _wait_for_turn(home: Path, states: set[str], *, count: int = 1, timeout: float = 15.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        records = _turn_records(home)
        if len(records) == count and all(record.get("state") in states for record in records):
            return records
        time.sleep(0.02)
    raise AssertionError(f"turn records did not reach {states}: {_turn_records(home)}")


def _history(client: StdioRpcClient) -> dict[str, Any]:
    response = client.call(
        "history",
        "companion.sessions.history",
        {"profile": PROFILE, "session_id": "lineage-root", "limit": 100},
    )
    assert "error" not in response, response
    return response["result"]


def _redacted_receipt(cases: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema": "companion-p1-transport-gate-v1",
        "transport": "newline-delimited-json-rpc-stdio",
        "production_entrypoint": "tui_gateway.entry.main",
        "persistence": "temp-HERMES_HOME/state.db",
        "model": "local-synthetic-no-network-no-tools",
        "privacy": {
            "prompt_plaintext": "omitted",
            "credentials_tokens": "omitted",
            "cwd": "omitted",
        },
        "cases": cases,
    }


def test_p1_real_transport_gate_mc09_mc11_mc12_mc13(tmp_path):
    cases: dict[str, Any] = {}

    # MC-09 + MC-11: no Desktop/Electron child exists.  A Companion stdio client
    # reads persisted Desktop history, admits one turn, exits, and a fresh client
    # reads the same root->tip lineage and completed history.
    home, project = _prepare_home(tmp_path, "roundtrip")
    companion = StdioRpcClient(home)
    before = _history(companion)
    assert before["identity"] == {
        "backend_namespace": BACKEND,
        "profile": PROFILE,
        "original_id": "lineage-root",
        "root_id": "lineage-root",
        "resolved_tip_id": "lineage-tip",
    }
    accepted = companion.call(
        "companion-submit",
        "companion.sessions.continue",
        _continue_params("mc09-one-run", duration=0.15),
    )
    assert accepted["result"]["status"] == "streaming"
    assert accepted["result"]["operation_state"] in {"admitted", "running"}
    _wait_for_turn(home, {"completed"})
    companion.close()

    desktop_return = StdioRpcClient(home)
    after = _history(desktop_return)
    desktop_return.close()
    assert after["identity"] == before["identity"]
    assert after["total"] == before["total"] + 2
    assert [item["role"] for item in after["items"][-2:]] == ["user", "assistant"]
    records = _turn_records(home)
    assert len(records) == 1 and records[0]["state"] == "completed"
    db = SessionDB(home / "state.db")
    root = db.get_session("lineage-root")
    tip = db.get_session("lineage-tip")
    assert root is not None and tip is not None
    assert root["cwd"] == tip["cwd"] == str(project)
    assert root["git_repo_root"] == tip["git_repo_root"] == str(project)
    assert root["profile_name"] == tip["profile_name"] == PROFILE
    assert db.resolve_resume_session_id("lineage-root") == "lineage-tip"
    db.close()
    cases["MC-09"] = {
        "status": "pass",
        "same_profile": True,
        "same_project": True,
        "same_cwd": True,
        "same_logical_lineage": True,
        "lineage": {"root": "lineage-root", "tip": "lineage-tip"},
        "history_before": before["total"],
        "history_after": after["total"],
        "accepted_runs": 1,
    }
    cases["MC-11"] = {
        "status": "pass",
        "desktop_client_process_started": False,
        "persisted_history_read": True,
        "controlled_submit_completed": True,
    }

    # MC-12: two independent OS processes, two serialized transports, one DB.
    concurrent_home, _ = _prepare_home(tmp_path, "concurrent")
    clients = [StdioRpcClient(concurrent_home), StdioRpcClient(concurrent_home)]
    barrier = threading.Barrier(2)

    def submit(index: int):
        barrier.wait(timeout=5)
        return clients[index].call(
            f"concurrent-{index}",
            "companion.sessions.continue",
            _continue_params(f"mc12-client-{index}", duration=0.8),
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(submit, range(2)))
    accepted_responses = [value for value in responses if "result" in value]
    busy_responses = [
        value for value in responses if value.get("error", {}).get("code") == 4091
    ]
    assert len(accepted_responses) == 1
    assert len(busy_responses) == 1
    _wait_for_turn(concurrent_home, {"completed", "not_admitted"}, count=2)
    concurrent_records = _turn_records(concurrent_home)
    assert sum(record["state"] == "completed" for record in concurrent_records) == 1
    assert sum(record["state"] == "not_admitted" for record in concurrent_records) == 1
    for client in clients:
        client.close()
    cases["MC-12"] = {
        "status": "pass",
        "independent_clients": 2,
        "accepted_runs": 1,
        "busy_or_not_admitted": 1,
        "duplicate_runs": 0,
        "lineage": {"root": "lineage-root", "tip": "lineage-tip"},
    }

    # MC-13: do not consume stdout.  Kill only after the durable admission is
    # visible, then reconnect and reconcile by the same opaque request id.
    lost_home, _ = _prepare_home(tmp_path, "lost-response")
    lost = StdioRpcClient(lost_home, consume_output=False)
    lost.send(
        "lost-response",
        "companion.sessions.continue",
        _continue_params("mc13-stable-request", duration=10.0),
    )
    admitted_records = _wait_for_turn(lost_home, {"admitted", "running"})
    operation_id = admitted_records[0]["operation_id"]
    lost.close(kill=True)
    loss_db = SessionDB(lost_home / "state.db")
    message_count_after_loss = len(loss_db.get_messages("lineage-tip"))
    loss_db.close()

    restarted = StdioRpcClient(lost_home)
    reconciled = restarted.call(
        "reconcile-after-restart",
        "companion.sessions.reconcile",
        _reconcile_params("mc13-stable-request"),
    )
    assert reconciled["result"]["status"] == "reconciled"
    assert reconciled["result"]["operation_status"] == "interrupted_outcome_unknown"
    assert len(_turn_records(lost_home)) == 1
    assert _turn_records(lost_home)[0]["operation_id"] == operation_id
    check_db = SessionDB(lost_home / "state.db")
    assert len(check_db.get_messages("lineage-tip")) == message_count_after_loss
    check_db.close()
    restarted.close()
    cases["MC-13"] = {
        "status": "pass",
        "response_consumed_before_restart": False,
        "admission_observed_before_process_loss": True,
        "reconciled_by_same_request_id": True,
        "operation_status": "interrupted_outcome_unknown",
        "durable_operations": 1,
        "blind_resubmits": 0,
        "lineage": {"root": "lineage-root", "tip": "lineage-tip"},
    }

    receipt = _redacted_receipt(cases)
    receipt_path = os.environ.get("COMPANION_TRANSPORT_RECEIPT_PATH")
    if receipt_path:
        Path(receipt_path).write_text(
            json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
    print("COMPANION_TRANSPORT_RECEIPT=" + json.dumps(receipt, sort_keys=True))
