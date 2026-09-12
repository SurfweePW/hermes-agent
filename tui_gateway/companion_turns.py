"""Durable, privacy-minimal turn admission for shared persisted lineages."""
from __future__ import annotations

from contextvars import ContextVar, Token
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
import hashlib
import json
import math
import os
import re
import secrets
from typing import Any, Mapping

from gateway.status import get_process_start_time, probe_pid_liveness

_TURN_PREFIX = "continuity_turn_v3:"
_SLOT_PREFIX = "continuity_active_v3:"
_GENERATION_PREFIX = "continuity_generation_v3:"
_TERMINAL_STATES = frozenset(
    {"completed", "failed", "cancelled", "not_admitted", "interrupted_outcome_unknown"}
)
_ACTIVE_STATES = frozenset({"claimed", "admitted", "running"})
_HEX_64 = re.compile(r"[0-9a-f]{64}")
_PROCESS_TOKEN = secrets.token_hex(16)
_CREATION_CLAIM_KEYS = frozenset({
    "v", "operation_kind", "operation_id", "payload_sha256", "lineage_root_id",
    "admitted_tip_id", "state", "executor_pid", "executor_started",
    "executor_token", "generation", "claimed_at",
})
_CREATION_SLOT_KEYS = frozenset({
    "v", "operation_kind", "operation_id", "payload_sha256", "lineage_root_id",
    "admitted_tip_id", "generation", "executor_pid", "executor_started",
    "executor_token",
})
_CREATION_ADMITTED_KEYS = _CREATION_CLAIM_KEYS | frozenset({"runtime_id", "admitted_at"})
_CREATION_RUNNING_KEYS = _CREATION_ADMITTED_KEYS | frozenset({"running_at"})
_CREATION_TERMINAL_KEYS = frozenset({"outcome", "finished_at", "final_tip_id"})
_HEX_48 = re.compile(r"[0-9a-f]{48}")
_HEX_32 = re.compile(r"[0-9a-f]{32}")
_MAX_SQLITE_INTEGER = 2**63 - 1


class TurnAdmissionError(RuntimeError):
    pass


class TurnBusyError(TurnAdmissionError):
    pass


class TurnStateError(TurnAdmissionError):
    pass


@dataclass(frozen=True, slots=True)
class CreatedSessionObservation:
    """Privacy-minimal result of one target-store read transaction."""

    row_state: str
    evidence_state: str
    turn_state: str | None = None


@dataclass(frozen=True, slots=True)
class TurnClaim:
    operation_id: str
    payload_sha256: str
    lineage_root_id: str
    admitted_tip_id: str
    generation: int
    executor_pid: int
    executor_started: int
    executor_token: str
    settle_in_parent: bool = False
    operation_kind: str = "continue"
    _prepared_row_fields: str | None = field(default=None, repr=False, compare=False)

    def to_wire(self, *, settle_in_parent: bool | None = None) -> dict[str, Any]:
        return {
            "operation_id": self.operation_id,
            "payload_sha256": self.payload_sha256,
            "lineage_root_id": self.lineage_root_id,
            "admitted_tip_id": self.admitted_tip_id,
            "generation": self.generation,
            "executor_pid": self.executor_pid,
            "executor_started": self.executor_started,
            "executor_token": self.executor_token,
            "settle_in_parent": (
                self.settle_in_parent if settle_in_parent is None else settle_in_parent
            ),
            "operation_kind": self.operation_kind,
        }

    @classmethod
    def from_wire(cls, value: Any) -> "TurnClaim":
        if not isinstance(value, dict):
            raise TurnStateError("durable turn context is invalid")
        try:
            allowed = {
                "operation_id", "payload_sha256", "lineage_root_id", "admitted_tip_id",
                "generation", "executor_pid", "executor_started", "executor_token",
                "settle_in_parent", "operation_kind",
            }
            if set(value) - allowed:
                raise TypeError("unknown durable turn field")
            claim = cls(
                operation_id=value["operation_id"],
                payload_sha256=value["payload_sha256"],
                lineage_root_id=value["lineage_root_id"],
                admitted_tip_id=value["admitted_tip_id"],
                generation=value["generation"],
                executor_pid=value["executor_pid"],
                executor_started=value["executor_started"],
                executor_token=value["executor_token"],
                settle_in_parent=value.get("settle_in_parent", False),
                operation_kind=value.get("operation_kind", "continue"),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise TurnStateError("durable turn context is invalid") from exc
        _validate_claim(claim)
        return claim


_BOUND_TURN: ContextVar[TurnClaim | None] = ContextVar("companion_bound_turn", default=None)


def new_operation_id() -> str:
    return secrets.token_hex(24)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _process_started(pid: int) -> int:
    try:
        return int(get_process_start_time(pid) or 0)
    except Exception:
        return 0


def current_executor() -> tuple[int, int, str]:
    pid = os.getpid()
    return pid, _process_started(pid), _PROCESS_TOKEN


def executor_liveness(record: dict[str, Any]) -> str:
    """Classify executor identity without treating incomplete evidence as death."""
    try:
        pid = record["executor_pid"]
        started = record["executor_started"]
    except (KeyError, TypeError):
        return "unknown"
    if type(pid) is not int or type(started) is not int or pid <= 0 or started <= 0:
        return "unknown"
    try:
        pid_state = probe_pid_liveness(pid)
    except Exception:
        return "unknown"
    if pid_state == "dead":
        return "dead"
    if pid_state != "alive":
        return "unknown"
    try:
        observed_started = get_process_start_time(pid)
    except Exception:
        return "unknown"
    if type(observed_started) is not int or observed_started <= 0:
        return "unknown"
    return "alive" if observed_started == started else "dead"


def executor_alive(record: dict[str, Any]) -> bool | None:
    """Compatibility boolean view of :func:`executor_liveness`."""
    state = executor_liveness(record)
    return True if state == "alive" else False if state == "dead" else None


def bind_turn(claim: TurnClaim) -> Token:
    _validate_claim(claim)
    return _BOUND_TURN.set(claim)


def reset_bound_turn(token: Token) -> None:
    _BOUND_TURN.reset(token)


def current_bound_turn() -> TurnClaim | None:
    return _BOUND_TURN.get()


def _meta_key(prefix: str, value: str) -> str:
    return prefix + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _turn_key(operation_id: str) -> str:
    return _TURN_PREFIX + operation_id


def _slot_key(root_id: str) -> str:
    return _meta_key(_SLOT_PREFIX, root_id)


def _generation_key(root_id: str) -> str:
    return _meta_key(_GENERATION_PREFIX, root_id)


def _decode(raw: Any) -> dict[str, Any]:
    try:
        value = json.loads(str(raw))
    except (TypeError, ValueError) as exc:
        raise TurnStateError("durable turn record is invalid") from exc
    if not isinstance(value, dict) or value.get("v") != 3:
        raise TurnStateError("durable turn record is invalid")
    return value


def _encode(value: dict[str, Any]) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _verify_creation_claim_replay(
    conn, record: dict[str, Any], *, operation_id: str, payload_sha256: str,
    requested_id: str, executor: tuple[int, int, str],
) -> None:
    """Require the complete canonical row/slot evidence before adopting a replay."""
    executor_pid, executor_started, executor_token = executor
    expected = {
        "v": 3,
        "operation_kind": "create",
        "operation_id": operation_id,
        "payload_sha256": payload_sha256,
        "lineage_root_id": requested_id,
        "admitted_tip_id": requested_id,
        "state": "claimed",
        "executor_pid": executor_pid,
        "executor_started": executor_started,
        "executor_token": executor_token,
        "generation": 1,
    }
    if (
        set(record) != _CREATION_CLAIM_KEYS
        or any(record.get(key) != value for key, value in expected.items())
        or any(type(record.get(key)) is not int for key in (
            "v", "executor_pid", "executor_started", "generation"
        ))
        or not _canonical_evidence_timestamp(record.get("claimed_at"))
    ):
        raise TurnStateError("created session turn claim evidence is invalid")

    slot_row = conn.execute(
        "SELECT value FROM state_meta WHERE key = ?", (_slot_key(requested_id),)
    ).fetchone()
    if slot_row is None:
        raise TurnStateError("created session lineage slot is unavailable")
    slot = _decode(slot_row["value"])
    slot_expected = {key: value for key, value in expected.items() if key not in {"state"}}
    if (
        set(slot) != _CREATION_SLOT_KEYS
        or any(slot.get(key) != value for key, value in slot_expected.items())
        or any(type(slot.get(key)) is not int for key in (
            "v", "executor_pid", "executor_started", "generation"
        ))
    ):
        raise TurnStateError("created session lineage slot evidence is invalid")

    generation = conn.execute(
        "SELECT value FROM state_meta WHERE key = ?", (_generation_key(requested_id),)
    ).fetchone()
    if generation is None or str(generation["value"]) != "1":
        raise TurnStateError("created session generation evidence is invalid")


def _row(conn, session_id: str) -> dict[str, Any] | None:
    found = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    return dict(found) if found is not None else None


def _fork_child(row: dict[str, Any]) -> bool:
    config = row.get("model_config")
    if isinstance(config, str):
        try:
            config = json.loads(config)
        except ValueError as exc:
            raise TurnStateError("session lineage metadata is invalid") from exc
    config = config if isinstance(config, dict) else {}
    return bool(config.get("_branched_from") or config.get("_delegate_from") or config.get("_reset_from"))


def _compression_root(conn, requested_id: str) -> str:
    current = _row(conn, requested_id)
    if current is None:
        raise TurnStateError("session not found")
    seen = {requested_id}
    for _ in range(100):
        parent_id = str(current.get("parent_session_id") or "")
        if not parent_id or _fork_child(current) or str(current.get("source") or "") == "tool":
            return str(current["id"])
        parent = _row(conn, parent_id)
        if parent is None or parent.get("end_reason") != "compression":
            return str(current["id"])
        if parent_id in seen:
            raise TurnStateError("session lineage contains a cycle")
        seen.add(parent_id)
        current = parent
    raise TurnStateError("session lineage exceeds the supported depth")


def _compression_tip(conn, root_id: str) -> str:
    current = _row(conn, root_id)
    if current is None:
        raise TurnStateError("session lineage is unavailable")
    seen = {root_id}
    for _ in range(100):
        if current.get("end_reason") != "compression":
            return str(current["id"])
        candidates = [
            dict(row)
            for row in conn.execute(
                "SELECT * FROM sessions WHERE parent_session_id = ?",
                (current["id"],),
            ).fetchall()
        ]
        eligible = [
            row for row in candidates
            if not _fork_child(row) and str(row.get("source") or "") != "tool"
        ]
        if not eligible:
            return str(current["id"])
        eligible.sort(
            key=lambda row: (
                0 if row.get("end_reason") == "compression" else 1 if row.get("ended_at") is None else 2,
                -(float(row.get("last_active") or row.get("started_at") or 0)),
                -(float(row.get("started_at") or 0)),
                str(row.get("id") or ""),
            )
        )
        child = eligible[0]
        child_id = str(child.get("id") or "")
        if not child_id or child_id in seen:
            raise TurnStateError("session lineage contains a cycle")
        seen.add(child_id)
        current = child
    raise TurnStateError("session lineage exceeds the supported depth")


def resolve_lineage(conn, requested_id: str) -> tuple[str, str]:
    root = _compression_root(conn, requested_id)
    return root, _compression_tip(conn, root)


def _validate_claim(claim: TurnClaim) -> None:
    if claim.operation_kind == "create":
        if (
            type(claim.operation_id) is not str
            or _HEX_48.fullmatch(claim.operation_id) is None
            or type(claim.payload_sha256) is not str
            or _HEX_64.fullmatch(claim.payload_sha256) is None
            or type(claim.lineage_root_id) is not str
            or not claim.lineage_root_id
            or type(claim.admitted_tip_id) is not str
            or claim.admitted_tip_id != claim.lineage_root_id
            or type(claim.generation) is not int
            or claim.generation != 1
            or type(claim.executor_pid) is not int
            or not 0 < claim.executor_pid <= _MAX_SQLITE_INTEGER
            or type(claim.executor_started) is not int
            or not 0 < claim.executor_started <= _MAX_SQLITE_INTEGER
            or type(claim.executor_token) is not str
            or not (
                _HEX_48.fullmatch(claim.executor_token)
                or _HEX_32.fullmatch(claim.executor_token)
            )
            or type(claim.settle_in_parent) is not bool
        ):
            raise TurnStateError("created session turn context is invalid")
        return
    if (
        type(claim.operation_id) is not str
        or not claim.operation_id
        or type(claim.payload_sha256) is not str
        or _HEX_64.fullmatch(claim.payload_sha256) is None
        or type(claim.lineage_root_id) is not str
        or not claim.lineage_root_id
        or type(claim.admitted_tip_id) is not str
        or not claim.admitted_tip_id
        or type(claim.generation) is not int
        or claim.generation <= 0
        or type(claim.executor_pid) is not int
        or claim.executor_pid <= 0
        or type(claim.executor_started) is not int
        or claim.executor_started < 0
        or type(claim.executor_token) is not str
        or not claim.executor_token
        or type(claim.settle_in_parent) is not bool
        or claim.operation_kind != "continue"
    ):
        raise TurnStateError("durable turn context is invalid")


def _claim_turn_tx(
    conn,
    *,
    operation_id: str,
    payload_sha256: str,
    requested_id: str,
    executor: tuple[int, int, str],
    operation_kind: str = "continue",
    claimed_at: str,
) -> dict[str, Any]:
    """Claim a lineage using the caller's transaction; never begin or commit."""
    if (
        not operation_id or _HEX_64.fullmatch(payload_sha256) is None or not requested_id
        or operation_kind not in {"continue", "create"}
    ):
        raise TurnStateError("durable turn claim is invalid")
    try:
        executor_pid, executor_started, executor_token = executor
        if operation_kind == "continue":
            executor_pid = int(executor_pid)
            executor_started = int(executor_started)
            executor_token = str(executor_token)
    except (TypeError, ValueError) as exc:
        raise TurnStateError("durable turn executor is invalid") from exc
    if operation_kind == "create" and not _valid_creation_executor(executor):
        raise TurnStateError("durable turn executor is invalid")
    if executor_pid <= 0 or not executor_token or (operation_kind == "create" and executor_started <= 0):
        raise TurnStateError("durable turn executor is invalid")

    existing_row = conn.execute(
        "SELECT value FROM state_meta WHERE key = ?", (_turn_key(operation_id),)
    ).fetchone()
    if existing_row is not None:
        existing = (
            _decode_creation_evidence(existing_row["value"])
            if operation_kind == "create"
            else _decode(existing_row["value"])
        )
        root, tip = resolve_lineage(conn, requested_id)
        existing_kind = str(existing.get("operation_kind") or "continue")
        expected = {
            "operation_id": operation_id,
            "payload_sha256": payload_sha256,
            "lineage_root_id": root,
            "admitted_tip_id": tip,
            "executor_pid": executor_pid,
            "executor_started": executor_started,
            "executor_token": executor_token,
        }
        if existing_kind != operation_kind or any(existing.get(key) != value for key, value in expected.items()):
            raise TurnStateError("operation id conflicts with another durable turn")
        if operation_kind == "create":
            _verify_creation_claim_replay(
                conn,
                existing,
                operation_id=operation_id,
                payload_sha256=payload_sha256,
                requested_id=requested_id,
                executor=(executor_pid, executor_started, executor_token),
            )
            return existing
        if existing.get("state") != "claimed":
            raise TurnStateError("operation was already admitted or settled")
        slot_row = conn.execute(
            "SELECT value FROM state_meta WHERE key = ?", (_slot_key(root),)
        ).fetchone()
        if slot_row is None:
            raise TurnStateError("durable lineage slot is unavailable")
        slot = _decode(slot_row["value"])
        for key, value in {**expected, "generation": int(existing.get("generation") or 0)}.items():
            # Older in-flight continuation slots did not duplicate all claim fields.
            if key in slot and slot.get(key) != value:
                raise TurnStateError("durable lineage slot conflicts with turn record")
        if slot.get("operation_id") != operation_id or int(slot.get("generation") or 0) != int(existing.get("generation") or 0):
            raise TurnStateError("durable lineage slot conflicts with turn record")
        return existing
    root, tip = resolve_lineage(conn, requested_id)
    slot_key = _slot_key(root)
    slot_row = conn.execute(
        "SELECT value FROM state_meta WHERE key = ?", (slot_key,)
    ).fetchone()
    if slot_row is not None:
        slot = _decode(slot_row["value"])
        if slot.get("operation_id") != operation_id:
            raise TurnBusyError("session lineage already has an active turn")
        raise TurnStateError("durable lineage slot exists without its turn record")
    generation_key = _generation_key(root)
    generation_row = conn.execute(
        "SELECT value FROM state_meta WHERE key = ?", (generation_key,)
    ).fetchone()
    generation = int(generation_row["value"] if generation_row is not None else 0) + 1
    conn.execute(
        "INSERT INTO state_meta (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (generation_key, str(generation)),
    )
    record = {
        "v": 3,
        "operation_kind": operation_kind,
        "operation_id": operation_id,
        "payload_sha256": payload_sha256,
        "lineage_root_id": root,
        "admitted_tip_id": tip,
        "state": "claimed",
        "executor_pid": executor_pid,
        "executor_started": executor_started,
        "executor_token": executor_token,
        "generation": generation,
        "claimed_at": claimed_at,
    }
    slot = {
        "v": 3,
        "operation_kind": operation_kind,
        "operation_id": operation_id,
        "payload_sha256": payload_sha256,
        "lineage_root_id": root,
        "admitted_tip_id": tip,
        "generation": generation,
        "executor_pid": executor_pid,
        "executor_started": executor_started,
        "executor_token": executor_token,
    }
    conn.execute("INSERT INTO state_meta (key, value) VALUES (?, ?)", (_turn_key(operation_id), _encode(record)))
    conn.execute("INSERT INTO state_meta (key, value) VALUES (?, ?)", (slot_key, _encode(slot)))
    return record


def claim_turn(
    db,
    *,
    operation_id: str,
    payload_sha256: str,
    requested_id: str,
    settle_in_parent: bool = False,
) -> TurnClaim:
    if not operation_id or _HEX_64.fullmatch(payload_sha256) is None or not requested_id:
        raise TurnStateError("durable turn claim is invalid")
    executor = current_executor()
    claimed_at = _now()

    def write(conn):
        return _claim_turn_tx(
            conn,
            operation_id=operation_id,
            payload_sha256=payload_sha256,
            requested_id=requested_id,
            executor=executor,
            claimed_at=claimed_at,
        )

    record = db._execute_write(write)
    claim = TurnClaim(
        operation_id=operation_id,
        payload_sha256=payload_sha256,
        lineage_root_id=str(record["lineage_root_id"]),
        admitted_tip_id=str(record["admitted_tip_id"]),
        generation=int(record["generation"]),
        executor_pid=int(record["executor_pid"]),
        executor_started=int(record.get("executor_started") or 0),
        executor_token=str(record["executor_token"]),
        settle_in_parent=settle_in_parent,
        operation_kind="continue",
    )
    _validate_claim(claim)
    return claim


def claim_from_record(record: dict[str, Any], *, settle_in_parent: bool = False) -> TurnClaim:
    claim = TurnClaim(
        operation_id=record.get("operation_id"),
        payload_sha256=record.get("payload_sha256"),
        lineage_root_id=record.get("lineage_root_id"),
        admitted_tip_id=record.get("admitted_tip_id"),
        generation=record.get("generation"),
        executor_pid=record.get("executor_pid"),
        executor_started=record.get("executor_started"),
        executor_token=record.get("executor_token"),
        settle_in_parent=settle_in_parent,
        operation_kind=record.get("operation_kind", "continue"),
    )
    _validate_claim(claim)
    return claim


def claimed_creation_fence_for_session(db: Any, stored_id: str) -> TurnClaim | None:
    """Reconstruct only an exact untouched claimed-creation fence from a real store."""
    if type(stored_id) is not str or not stored_id:
        return None
    try:
        with db._read_ctx() as conn:
            slot_row = conn.execute(
                "SELECT value FROM state_meta WHERE key = ?", (_slot_key(stored_id),)
            ).fetchone()
            row_found = conn.execute(
                "SELECT * FROM sessions WHERE id = ?", (stored_id,)
            ).fetchone()
            transcript = conn.execute(
                "SELECT 1 FROM messages WHERE session_id = ? LIMIT 1", (stored_id,)
            ).fetchone()
            generation_row = conn.execute(
                "SELECT value FROM state_meta WHERE key = ?", (_generation_key(stored_id),)
            ).fetchone()
            if slot_row is None or row_found is None or transcript is not None or generation_row is None:
                return None
            slot = _decode_creation_evidence(slot_row["value"])
            operation_id = slot.get("operation_id")
            if type(operation_id) is not str:
                return None
            turn_row = conn.execute(
                "SELECT value FROM state_meta WHERE key = ?", (_turn_key(operation_id),)
            ).fetchone()
            if turn_row is None:
                return None
            record = _decode_creation_evidence(turn_row["value"])
            row = dict(row_found)
            index = {
                "operation_id": operation_id,
                "payload_sha256": slot.get("payload_sha256"),
                "requested_id": stored_id,
                "target_profile": row.get("profile_name"),
                "creator_pid": slot.get("executor_pid"),
                "creator_started": slot.get("executor_started"),
                "creator_token": slot.get("executor_token"),
            }
            if (
                _canonical_generation(generation_row["value"]) != 1
                or _validate_creation_turn(record, index) != "claimed"
                or not _claimed_creation_row_matches(row, index, record.get("claimed_at"))
            ):
                return None
            _validate_creation_slot(slot, record, index)
            return claim_from_record(record)
    except Exception:
        return None


_CREATION_ROW_FIELDS = frozenset({
    "session_id", "source", "model", "model_config", "system_prompt",
    "user_id", "session_key", "chat_id", "chat_type", "thread_id",
    "parent_session_id", "cwd", "profile_name", "git_repo_root", "origin_json",
    "display_name",
})
_CREATION_NULL_ROW_FIELDS = frozenset({
    "system_prompt", "user_id", "session_key", "chat_id", "chat_type", "thread_id",
    "parent_session_id", "origin_json", "display_name",
})


def _valid_creation_executor(value: Any) -> bool:
    if type(value) is not tuple or len(value) != 3:
        return False
    pid, started, token = value
    return (
        type(pid) is int
        and 0 < pid <= _MAX_SQLITE_INTEGER
        and type(started) is int
        and 0 < started <= _MAX_SQLITE_INTEGER
        and type(token) is str
        and _HEX_48.fullmatch(token) is not None
    )


def _valid_creation_json(value: Any, active: set[int] | None = None) -> bool:
    """Accept only the ordinary JSON value model, without tuple/key coercion."""
    if value is None or type(value) in {bool, int, str}:
        return True
    if type(value) is float:
        return math.isfinite(value)
    if type(value) not in {dict, list}:
        return False
    active = set() if active is None else active
    identity = id(value)
    if identity in active:
        return False
    active.add(identity)
    try:
        if type(value) is dict:
            return all(
                type(key) is str and _valid_creation_json(item, active)
                for key, item in value.items()
            )
        return all(_valid_creation_json(item, active) for item in value)
    finally:
        active.remove(identity)


def _validate_creation_inputs(
    row_fields: Any,
    operation_id: Any,
    payload_sha256: Any,
    executor: Any,
) -> tuple[dict[str, Any], str, tuple[int, int, str]]:
    """Validate and isolate all caller-owned creation data before opening a write."""
    if (
        type(operation_id) is not str
        or _HEX_48.fullmatch(operation_id) is None
        or type(payload_sha256) is not str
        or _HEX_64.fullmatch(payload_sha256) is None
    ):
        raise TurnStateError("created session operation identity is invalid")
    if not _valid_creation_executor(executor):
        raise TurnStateError("durable turn executor is invalid")
    if (
        type(row_fields) is not dict
        or any(type(key) is not str for key in row_fields)
        or "session_id" not in row_fields
        or "source" not in row_fields
        or "id" in row_fields
    ):
        raise TurnStateError("created session row fields are invalid")

    fields = dict(row_fields)

    from tui_gateway.companion_creation import (
        _valid_creation_profile,
        _valid_protocol_text,
    )
    from tui_gateway.companion_sessions import (
        _MAX_QUERY_LENGTH,
        _MAX_SESSION_ID_LENGTH,
    )

    model = fields.get("model")
    model_config = fields.get("model_config")

    def valid_text(value: Any, maximum: int) -> bool:
        return type(value) is str and _valid_protocol_text(value, maximum)
    if (
        not {"session_id", "source", "profile_name"} <= set(fields)
        or any(type(key) is not str for key in fields)
        or set(fields) - _CREATION_ROW_FIELDS
        or type(fields["source"]) is not str
        or fields["source"] != "companion"
        or not valid_text(fields["session_id"], _MAX_SESSION_ID_LENGTH)
        or type(fields["profile_name"]) is not str
        or not _valid_creation_profile(fields["profile_name"])
        or not (model is None or valid_text(model, _MAX_QUERY_LENGTH))
        or not all(fields.get(name) is None for name in _CREATION_NULL_ROW_FIELDS)
        or any(
            fields.get(name) is not None
            and not valid_text(fields[name], _MAX_QUERY_LENGTH)
            for name in ("cwd", "git_repo_root")
        )
        or not (
            model_config is None
            or (type(model_config) is dict and _valid_creation_json(model_config))
        )
    ):
        raise TurnStateError("created session row fields are invalid")

    prepared_row_fields = _snapshot_creation_fields(fields)
    try:
        isolated = _decode_creation_evidence(prepared_row_fields)
    except TurnStateError as exc:
        raise TurnStateError("created session row fields are invalid") from exc
    return isolated, prepared_row_fields, executor


def _creation_started_at(claimed_at: Any) -> float:
    if not isinstance(claimed_at, str) or not claimed_at.endswith("Z"):
        raise TurnStateError("created session claim timestamp is invalid")
    try:
        parsed = datetime.fromisoformat(claimed_at[:-1] + "+00:00")
    except ValueError as exc:
        raise TurnStateError("created session claim timestamp is invalid") from exc
    if parsed.tzinfo != timezone.utc or parsed.isoformat().replace("+00:00", "Z") != claimed_at:
        raise TurnStateError("created session claim timestamp is invalid")
    return parsed.timestamp()


def _canonical_creation_row(fields: dict[str, Any], claimed_at: Any) -> dict[str, Any]:
    """Return the exact SQLite row emitted for an untouched creation root."""
    model_config = fields.get("model_config")
    return {
        "id": fields["session_id"],
        "source": "companion",
        "user_id": None,
        "session_key": None,
        "chat_id": None,
        "chat_type": None,
        "thread_id": None,
        "display_name": None,
        "origin_json": None,
        "expiry_finalized": 0,
        "model": fields.get("model"),
        "model_config": json.dumps(model_config) if model_config else None,
        "system_prompt": None,
        "system_prompt_hash": None,
        "parent_session_id": None,
        "started_at": _creation_started_at(claimed_at),
        "ended_at": None,
        "end_reason": None,
        "message_count": 0,
        "tool_call_count": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "reasoning_tokens": 0,
        "cwd": fields.get("cwd"),
        "git_branch": None,
        "git_repo_root": fields.get("git_repo_root"),
        "git_metadata_generation": 0,
        "billing_provider": None,
        "billing_base_url": None,
        "billing_mode": None,
        "estimated_cost_usd": None,
        "actual_cost_usd": None,
        "cost_status": None,
        "cost_source": None,
        "pricing_version": None,
        "title": None,
        "title_source": None,
        "last_activity_at": None,
        "last_activity_description": None,
        "last_activity_provenance": None,
        "api_call_count": 0,
        "handoff_state": None,
        "handoff_platform": None,
        "handoff_error": None,
        "compression_failure_cooldown_until": None,
        "compression_failure_error": None,
        "compression_fallback_streak": 0,
        "compression_ineffective_count": 0,
        "compression_recovery_deadline": None,
        "profile_name": fields["profile_name"],
        "rewind_count": 0,
        "archived": 0,
        "pinned": 0,
        "hidden": 0,
        "last_read_at": None,
        "tool_names": None,
    }


def _creation_row_matches(
    row: dict[str, Any], fields: dict[str, Any], claimed_at: Any
) -> bool:
    expected = _canonical_creation_row(fields, claimed_at)
    return set(row) == set(expected) and all(
        type(row[key]) is type(value) and row[key] == value
        if value is not None else row[key] is None
        for key, value in expected.items()
    )


def _snapshot_creation_fields(fields: dict[str, Any]) -> str:
    """Capture private preparation context without retaining caller-owned objects."""
    try:
        return json.dumps(
            fields,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError, RecursionError) as exc:
        raise TurnStateError("created session row fields are invalid") from exc


def _prepared_creation_fields(claim: TurnClaim) -> dict[str, Any]:
    raw = claim._prepared_row_fields
    if type(raw) is not str:
        raise TurnStateError("created session prepared row snapshot is unavailable")
    try:
        fields = _decode_creation_evidence(raw)
    except TurnStateError as exc:
        raise TurnStateError("created session prepared row snapshot is malformed") from exc
    if (
        set(fields) - _CREATION_ROW_FIELDS
        or "id" in fields
        or fields.get("session_id") != claim.lineage_root_id
        or fields.get("source") != "companion"
        or type(fields.get("profile_name")) is not str
        or not fields["profile_name"]
    ):
        raise TurnStateError("created session prepared row snapshot is malformed")
    return fields


def _decode_creation_evidence(raw: Any) -> dict[str, Any]:
    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("duplicate key")
            value[key] = item
        return value

    try:
        value = json.loads(
            raw,
            object_pairs_hook=reject_duplicates,
            parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("constant")),
        )
    except (TypeError, ValueError, RecursionError) as exc:
        raise TurnStateError("created session evidence is invalid") from exc
    if not isinstance(value, dict):
        raise TurnStateError("created session evidence is invalid")
    return value


def _canonical_evidence_timestamp(value: Any) -> bool:
    try:
        _creation_started_at(value)
    except TurnStateError:
        return False
    return True


def _ordinary_creation_row(row: dict[str, Any], index: Mapping[str, Any]) -> bool:
    """Validate stable ordinary identity without freezing mutable workspace fields."""
    if (
        type(row.get("id")) is not str
        or row["id"] != index.get("requested_id")
        or type(row.get("profile_name")) is not str
        or row["profile_name"] != index.get("target_profile")
        or type(row.get("source")) is not str
        or row["source"] != "companion"
        or row.get("parent_session_id") is not None
        or any(row.get(key) is not None for key in (
            "user_id", "session_key", "chat_id", "chat_type", "thread_id",
            "display_name", "origin_json",
        ))
        or type(row.get("hidden")) is not int
        or row["hidden"] != 0
        or type(row.get("archived")) is not int
        or row["archived"] not in {0, 1}
        or type(row.get("pinned")) is not int
        or row["pinned"] not in {0, 1}
    ):
        return False
    title = row.get("title")
    title_source = row.get("title_source")
    if not (
        (title is None and title_source is None)
        or (
            type(title) is str
            and bool(title)
            and type(title_source) is str
            and title_source in {"user", "derived", "llm"}
        )
    ):
        return False
    try:
        config = (
            _decode_creation_evidence(row.get("model_config"))
            if row.get("model_config") is not None
            else {}
        )
    except TurnStateError:
        return False
    if any(config.get(key) for key in ("_branched_from", "_delegate_from", "_reset_from")):
        return False
    return True


def _original_creation_workspace_matches(
    row: dict[str, Any], index: Mapping[str, Any]
) -> bool:
    """Prove the original workspace shape while a creation is only claimed."""
    try:
        config = (
            _decode_creation_evidence(row.get("model_config"))
            if row.get("model_config") is not None
            else {}
        )
    except TurnStateError:
        return False
    if index.get("project_id") is None:
        return (
            row.get("cwd") is None
            and row.get("git_repo_root") is None
            and row.get("git_branch") is None
            and config.get("_companion_workspace_none") is True
        )
    return (
        "_companion_workspace_none" not in config
        and type(row.get("cwd")) is str
        and bool(row["cwd"])
        and (
            row.get("git_repo_root") is None
            or (type(row.get("git_repo_root")) is str and bool(row["git_repo_root"]))
        )
        and (
            row.get("git_branch") is None
            or (type(row.get("git_branch")) is str and bool(row["git_branch"]))
        )
    )


def _validate_creation_turn(
    record: dict[str, Any], index: Mapping[str, Any]
) -> str:
    state = record.get("state")
    if type(state) is not str or state not in _ACTIVE_STATES | _TERMINAL_STATES:
        raise TurnStateError("created session turn state is invalid")
    common = {
        "v": 3,
        "operation_kind": "create",
        "operation_id": index.get("operation_id"),
        "payload_sha256": index.get("payload_sha256"),
        "lineage_root_id": index.get("requested_id"),
        "admitted_tip_id": index.get("requested_id"),
        "generation": 1,
    }
    if any(
        type(record.get(key)) is not type(expected) or record.get(key) != expected
        for key, expected in common.items()
    ) or not _canonical_evidence_timestamp(record.get("claimed_at")):
        raise TurnStateError("created session turn identity is invalid")

    creator_executor = (
        type(record.get("executor_pid")) is int
        and record["executor_pid"] == index.get("creator_pid")
        and type(record.get("executor_started")) is int
        and record["executor_started"] == index.get("creator_started")
        and type(record.get("executor_token")) is str
        and record["executor_token"] == index.get("creator_token")
        and _HEX_48.fullmatch(record["executor_token"]) is not None
    )
    running_executor = (
        type(record.get("executor_pid")) is int
        and 0 < record["executor_pid"] <= _MAX_SQLITE_INTEGER
        and type(record.get("executor_started")) is int
        and 0 < record["executor_started"] <= _MAX_SQLITE_INTEGER
        and type(record.get("executor_token")) is str
        and _HEX_32.fullmatch(record["executor_token"]) is not None
    )

    expected_keys = _CREATION_CLAIM_KEYS
    if state == "admitted":
        expected_keys = _CREATION_ADMITTED_KEYS
    elif state == "running":
        expected_keys = _CREATION_RUNNING_KEYS
    elif state in _TERMINAL_STATES:
        if record.get("outcome") != state:
            raise TurnStateError("created session terminal outcome is invalid")
        if state == "not_admitted":
            base = _CREATION_CLAIM_KEYS
        else:
            base = (
                _CREATION_RUNNING_KEYS
                if "running_at" in record
                else _CREATION_ADMITTED_KEYS
            )
        expected_keys = base | _CREATION_TERMINAL_KEYS
    if set(record) != expected_keys:
        raise TurnStateError("created session turn fields are invalid")
    transitioned = state == "running" or (
        state in _TERMINAL_STATES and "running_at" in record
    )
    if transitioned:
        if not running_executor:
            raise TurnStateError("created session running executor is invalid")
    elif not creator_executor:
        raise TurnStateError("created session creator identity is invalid")
    for timestamp in ("admitted_at", "running_at", "finished_at"):
        if timestamp in record and not _canonical_evidence_timestamp(record[timestamp]):
            raise TurnStateError("created session turn timestamp is invalid")
    ordered_timestamps = [
        _creation_started_at(record[name])
        for name in ("claimed_at", "admitted_at", "running_at", "finished_at")
        if name in record
    ]
    if ordered_timestamps != sorted(ordered_timestamps):
        raise TurnStateError("created session turn timestamps are out of order")
    if "runtime_id" in record and (type(record["runtime_id"]) is not str or not record["runtime_id"]):
        raise TurnStateError("created session runtime identity is invalid")
    if state in _TERMINAL_STATES and (
        type(record.get("final_tip_id")) is not str or not record["final_tip_id"]
    ):
        raise TurnStateError("created session terminal tip is invalid")
    if state == "not_admitted" and expected_keys != _CREATION_CLAIM_KEYS | _CREATION_TERMINAL_KEYS:
        raise TurnStateError("created session rejection evidence is invalid")
    return state


def _claimed_creation_row_matches(
    row: dict[str, Any], index: Mapping[str, Any], claimed_at: Any
) -> bool:
    """Rebuild and compare the exact untouched preparation row."""
    try:
        model_config = (
            _decode_creation_evidence(row["model_config"])
            if row.get("model_config") is not None
            else None
        )
        fields = {
            "session_id": index["requested_id"],
            "source": "companion",
            "model": row.get("model"),
            "model_config": model_config,
            "profile_name": index["target_profile"],
            "cwd": row.get("cwd"),
            "git_repo_root": row.get("git_repo_root"),
        }
        return _creation_row_matches(row, fields, claimed_at)
    except (KeyError, TypeError, ValueError, TurnStateError):
        return False


def _validate_creation_slot(
    slot: dict[str, Any], record: dict[str, Any], index: Mapping[str, Any]
) -> None:
    # The active slot retains the identity that claimed the turn. mark_running
    # transfers the turn record to the process executor, whose canonical token
    # is intentionally a different (32-hex) identity. The non-executor fields
    # must still match the record exactly, while the slot executor must remain
    # the original creator captured by the creation index.
    expected = {
        key: record[key]
        for key in _CREATION_SLOT_KEYS
        if key not in {"executor_pid", "executor_started", "executor_token"}
    }
    expected.update(
        executor_pid=index.get("creator_pid"),
        executor_started=index.get("creator_started"),
        executor_token=index.get("creator_token"),
    )
    if (
        set(slot) != _CREATION_SLOT_KEYS
        or any(type(slot.get(key)) is not type(value) or slot.get(key) != value for key, value in expected.items())
        or slot.get("operation_id") != index.get("operation_id")
    ):
        raise TurnStateError("created session lineage slot evidence is invalid")


def _canonical_generation(raw: Any) -> int:
    if type(raw) is not str or re.fullmatch(r"[1-9][0-9]*", raw) is None:
        raise TurnStateError("created session generation evidence is invalid")
    try:
        generation = int(raw)
    except ValueError as exc:
        raise TurnStateError("created session generation evidence is invalid") from exc
    if generation > _MAX_SQLITE_INTEGER:
        raise TurnStateError("created session generation evidence is invalid")
    return generation


def _validate_later_generation_slot(
    conn: Any, slot: dict[str, Any], *, lineage_root_id: str, generation: int,
    creation_operation_id: str,
) -> None:
    if (
        set(slot) != _CREATION_SLOT_KEYS
        or type(slot.get("v")) is not int
        or slot["v"] != 3
        or type(slot.get("operation_kind")) is not str
        or slot["operation_kind"] != "continue"
        or type(slot.get("operation_id")) is not str
        or not slot["operation_id"]
        or slot["operation_id"] == creation_operation_id
        or type(slot.get("payload_sha256")) is not str
        or _HEX_64.fullmatch(slot["payload_sha256"]) is None
        or type(slot.get("lineage_root_id")) is not str
        or slot["lineage_root_id"] != lineage_root_id
        or type(slot.get("admitted_tip_id")) is not str
        or not slot["admitted_tip_id"]
        or type(slot.get("generation")) is not int
        or slot["generation"] != generation
        or type(slot.get("executor_pid")) is not int
        or not 0 < slot["executor_pid"] <= _MAX_SQLITE_INTEGER
        or type(slot.get("executor_started")) is not int
        or not 0 <= slot["executor_started"] <= _MAX_SQLITE_INTEGER
        or type(slot.get("executor_token")) is not str
        or _HEX_32.fullmatch(slot["executor_token"]) is None
    ):
        raise TurnStateError("created session later lineage slot evidence is invalid")
    if _compression_root(conn, slot["admitted_tip_id"]) != lineage_root_id:
        raise TurnStateError("created session later lineage slot is outside its lineage")


def _observe_created_session_snapshot(
    db: Any, index: Mapping[str, Any], *, enforce_phase: bool
) -> tuple[CreatedSessionObservation, dict[str, Any] | None]:
    """Observe a reserved creation target from exactly one read-only snapshot."""
    try:
        from tui_gateway.companion_creation import _canonical_creation_index_snapshot

        index = _canonical_creation_index_snapshot(index)
    except Exception:
        return CreatedSessionObservation("unavailable", "inconsistent"), None
    try:
        stored_id = index["requested_id"]
        with db._read_ctx() as conn:
            transaction_started = False
            try:
                if conn.in_transaction:
                    raise TurnStateError("created session observation connection is not idle")
                try:
                    conn.execute("BEGIN")
                except Exception:
                    if conn.in_transaction:
                        try:
                            conn.execute("ROLLBACK")
                        except Exception:
                            conn.close()
                    raise
                transaction_started = True
                row_found = conn.execute(
                    "SELECT * FROM sessions WHERE id = ?", (stored_id,)
                ).fetchone()
                turn_found = conn.execute(
                    "SELECT value FROM state_meta WHERE key = ?",
                    (_turn_key(index["operation_id"]),),
                ).fetchone()
                slot_found = conn.execute(
                    "SELECT value FROM state_meta WHERE key = ?", (_slot_key(stored_id),)
                ).fetchone()
                transcript_found = conn.execute(
                    "SELECT 1 FROM messages WHERE session_id = ? LIMIT 1", (stored_id,)
                ).fetchone()
                generation_found = conn.execute(
                    "SELECT value FROM state_meta WHERE key = ?", (_generation_key(stored_id),)
                ).fetchone()

                if (
                    row_found is None
                    and turn_found is None
                    and slot_found is None
                    and transcript_found is None
                    and generation_found is None
                ):
                    return CreatedSessionObservation("absent", "absent"), None
                if row_found is None or turn_found is None:
                    raise TurnStateError("created session row and turn are inconsistent")
                row = dict(row_found)
                record = _decode_creation_evidence(turn_found["value"])
                state = _validate_creation_turn(record, index)
                if not _ordinary_creation_row(row, index):
                    raise TurnStateError("created session row is invalid")
                if generation_found is None:
                    raise TurnStateError("created session generation evidence is invalid")
                generation = _canonical_generation(generation_found["value"])
                if state in _ACTIVE_STATES:
                    if generation != 1:
                        raise TurnStateError("created session generation evidence is invalid")
                    if slot_found is None:
                        raise TurnStateError("created session slot is missing")
                    _validate_creation_slot(
                        _decode_creation_evidence(slot_found["value"]), record, index
                    )
                else:
                    if generation == 1:
                        if slot_found is not None:
                            raise TurnStateError("created session terminal slot is inconsistent")
                    elif slot_found is not None:
                        _validate_later_generation_slot(
                            conn, _decode_creation_evidence(slot_found["value"]),
                            lineage_root_id=stored_id,
                            generation=generation,
                            creation_operation_id=index["operation_id"],
                        )
                    final_tip = record["final_tip_id"]
                    if _compression_root(conn, final_tip) != stored_id:
                        raise TurnStateError("created session terminal tip is outside its lineage")
                    lineage_root, _current_tip = resolve_lineage(conn, stored_id)
                    if lineage_root != stored_id:
                        raise TurnStateError("created session root lineage is invalid")
                if state == "claimed" and (
                    transcript_found is not None
                    or not _original_creation_workspace_matches(row, index)
                    or not _claimed_creation_row_matches(row, index, record.get("claimed_at"))
                ):
                    raise TurnStateError("created session claim row is not pristine")
                from tui_gateway.companion_creation import _creation_evidence_permitted

                if enforce_phase and not _creation_evidence_permitted(
                    index, evidence_state="exact", turn_state=state
                ):
                    raise TurnStateError("creation phase contradicts its durable evidence")
                return CreatedSessionObservation("present", "exact", state), record
            finally:
                if transaction_started:
                    try:
                        conn.execute("ROLLBACK")
                    except Exception:
                        try:
                            conn.close()
                        finally:
                            raise
    except (KeyError, TypeError, ValueError, TurnStateError):
        return CreatedSessionObservation("unavailable", "inconsistent"), None
    except Exception:
        return CreatedSessionObservation("unavailable", "unavailable"), None


def observe_created_session(
    db: Any, index: Mapping[str, Any]
) -> CreatedSessionObservation:
    """Observe a reserved creation target from exactly one read-only snapshot."""
    return _observe_created_session_snapshot(db, index, enforce_phase=True)[0]


def _observe_created_session_recovery(
    db: Any, index: Mapping[str, Any]
) -> tuple[CreatedSessionObservation, dict[str, Any] | None]:
    """Return exact recovery evidence without applying coordinator phase policy."""
    return _observe_created_session_snapshot(db, index, enforce_phase=False)


_observe_created_session = observe_created_session


def prepare_created_session(
    db,
    row_fields: dict[str, Any],
    operation_id: str,
    payload_sha256: str,
    executor: tuple[int, int, str],
) -> TurnClaim:
    """Atomically publish an ordinary Companion row and its first-turn claim.

    Re-entry may prove an already committed exact pair, but mismatched/partial evidence is
    corruption and is never adopted. Values are captured before `_execute_write` retries.
    """
    fields, prepared_row_fields, normalized_executor = _validate_creation_inputs(
        row_fields, operation_id, payload_sha256, executor
    )
    session_id = fields["session_id"]
    claimed_at = _now()
    started_at = _creation_started_at(claimed_at)

    def write(conn):
        row = _row(conn, session_id)
        turn_row = conn.execute(
            "SELECT value FROM state_meta WHERE key = ?", (_turn_key(operation_id),)
        ).fetchone()
        if (row is None) != (turn_row is None):
            raise TurnStateError("created session row and turn claim are inconsistent")
        if row is None:
            if conn.execute(
                "SELECT 1 FROM state_meta WHERE key IN (?, ?)",
                (_slot_key(session_id), _generation_key(session_id)),
            ).fetchone() is not None:
                raise TurnStateError("reserved session lineage already exists")
            db._insert_session_row_tx(conn, started_at=started_at, **fields)
        else:
            existing_record = _decode(turn_row["value"])
            if not _creation_row_matches(row, fields, existing_record.get("claimed_at")):
                raise TurnStateError("reserved session row conflicts with existing content")

        _claim_turn_tx(
            conn,
            operation_id=operation_id,
            payload_sha256=payload_sha256,
            requested_id=session_id,
            executor=normalized_executor,
            operation_kind="create",
            claimed_at=claimed_at,
        )
        stored_turn = conn.execute(
            "SELECT value FROM state_meta WHERE key = ?", (_turn_key(operation_id),)
        ).fetchone()
        if stored_turn is None:
            raise TurnStateError("created session turn claim verification failed")
        record = _decode_creation_evidence(stored_turn["value"])
        _verify_creation_claim_replay(
            conn,
            record,
            operation_id=operation_id,
            payload_sha256=payload_sha256,
            requested_id=session_id,
            executor=normalized_executor,
        )
        claim = claim_from_record(record)
        committed_row = _row(conn, session_id)
        if committed_row is None or not _creation_row_matches(
            committed_row, fields, record.get("claimed_at")
        ):
            raise TurnStateError("created session row verification failed")
        if conn.execute(
            "SELECT 1 FROM messages WHERE session_id = ? LIMIT 1", (session_id,)
        ).fetchone() is not None:
            raise TurnStateError("created session already has transcript history")
        generation = conn.execute(
            "SELECT value FROM state_meta WHERE key = ?", (_generation_key(session_id),)
        ).fetchone()
        if generation is None or _canonical_generation(generation["value"]) != 1:
            raise TurnStateError("created session generation verification failed")
        return claim

    claim = db._execute_write(write)
    return replace(claim, _prepared_row_fields=prepared_row_fields)


def record_not_admitted(
    db, *, operation_id: str, payload_sha256: str, requested_id: str
) -> dict[str, Any]:
    """Tombstone an indexed operation before execution; delayed claimers then fail closed."""
    pid, started, token = current_executor()

    def write(conn):
        key = _turn_key(operation_id)
        row = conn.execute("SELECT value FROM state_meta WHERE key = ?", (key,)).fetchone()
        if row is not None:
            return _decode(row["value"])
        root, tip = resolve_lineage(conn, requested_id)
        generation_key = _generation_key(root)
        generation_row = conn.execute(
            "SELECT value FROM state_meta WHERE key = ?", (generation_key,)
        ).fetchone()
        generation = int(generation_row["value"] if generation_row is not None else 0) + 1
        conn.execute(
            "INSERT INTO state_meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (generation_key, str(generation)),
        )
        record = {
            "v": 3,
            "operation_id": operation_id,
            "payload_sha256": payload_sha256,
            "lineage_root_id": root,
            "admitted_tip_id": tip,
            "state": "not_admitted",
            "outcome": "not_admitted",
            "executor_pid": pid,
            "executor_started": started,
            "executor_token": token,
            "generation": generation,
            "claimed_at": _now(),
            "finished_at": _now(),
            "final_tip_id": tip,
        }
        conn.execute("INSERT INTO state_meta (key, value) VALUES (?, ?)", (key, _encode(record)))
        return record

    return db._execute_write(write)


def _verify_claim_evidence(conn, record: dict[str, Any], claim: TurnClaim) -> None:
    record_kind = str(record.get("operation_kind") or "continue")
    if record_kind != claim.operation_kind:
        raise TurnStateError("durable turn claim kind no longer matches its record")
    claim_fields = {
        "operation_id": claim.operation_id,
        "payload_sha256": claim.payload_sha256,
        "lineage_root_id": claim.lineage_root_id,
        "admitted_tip_id": claim.admitted_tip_id,
        "generation": claim.generation,
        "executor_pid": claim.executor_pid,
        "executor_started": claim.executor_started,
        "executor_token": claim.executor_token,
    }
    slot_row = conn.execute(
        "SELECT value FROM state_meta WHERE key = ?", (_slot_key(claim.lineage_root_id),)
    ).fetchone()
    if slot_row is None:
        raise TurnStateError("durable lineage slot is unavailable")
    slot = _decode(slot_row["value"])
    slot_kind = str(slot.get("operation_kind") or "continue")
    if slot_kind != claim.operation_kind:
        raise TurnStateError("durable lineage slot kind no longer matches its claim")
    required = claim_fields if claim.operation_kind == "create" else {
        key: value for key, value in claim_fields.items()
        if key in slot or key in {"operation_id", "generation"}
    }
    executor_fields = ("executor_pid", "executor_started", "executor_token")
    immutable_required = {
        key: value for key, value in required.items() if key not in executor_fields
    }
    immutable_claim_fields = {
        key: value for key, value in claim_fields.items() if key not in executor_fields
    }
    if any(record.get(key) != value for key, value in immutable_claim_fields.items()):
        raise TurnStateError("durable turn claim no longer matches its record")
    if any(slot.get(key) != value for key, value in immutable_required.items()):
        raise TurnStateError("durable lineage slot no longer matches its claim")
    claim_executor = tuple(getattr(claim, key) for key in executor_fields)
    record_executor = tuple(record.get(key) for key in executor_fields)
    slot_executor = tuple(slot.get(key) for key in executor_fields)
    if record.get("state") == "running":
        # mark_running transfers the turn record from the admitting creator to
        # the actual runner while the active slot intentionally retains the
        # original claim owner. Finalization may therefore carry either the
        # original in-memory claim or a claim reconstructed from the running
        # record during dead-executor reconciliation, but never a third
        # identity.
        if claim_executor != record_executor and claim_executor != slot_executor:
            raise TurnStateError("durable turn claim no longer matches its executor")
    elif record_executor != claim_executor:
        raise TurnStateError("durable turn claim no longer matches its record")
    if claim.operation_kind == "create" and record.get("state") != "running" and slot_executor != claim_executor:
        raise TurnStateError("durable lineage slot no longer matches its claim")


def _validate_creation_active_evidence(
    conn: Any,
    record: dict[str, Any],
    claim: TurnClaim,
    *,
    coordinator_index: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Validate executing creation authority inside the write transaction."""
    _validate_claim(claim)
    state = record.get("state")
    if type(state) is not str or state not in _ACTIVE_STATES:
        raise TurnStateError("created session turn state is invalid")
    expected_keys = {
        "claimed": _CREATION_CLAIM_KEYS,
        "admitted": _CREATION_ADMITTED_KEYS,
        "running": _CREATION_RUNNING_KEYS,
    }[state]
    immutable = {
        "v": 3,
        "operation_kind": "create",
        "operation_id": claim.operation_id,
        "payload_sha256": claim.payload_sha256,
        "lineage_root_id": claim.lineage_root_id,
        "admitted_tip_id": claim.admitted_tip_id,
        "generation": 1,
    }
    if (
        set(record) != expected_keys
        or any(
            type(record.get(key)) is not type(value) or record.get(key) != value
            for key, value in immutable.items()
        )
        or not _canonical_evidence_timestamp(record.get("claimed_at"))
    ):
        raise TurnStateError("created session turn evidence is invalid")
    if state in {"admitted", "running"} and (
        type(record.get("runtime_id")) is not str or not record["runtime_id"]
    ):
        raise TurnStateError("created session runtime identity is invalid")
    timestamp_names = ["claimed_at"]
    if state in {"admitted", "running"}:
        timestamp_names.append("admitted_at")
    if state == "running":
        timestamp_names.append("running_at")
    if any(not _canonical_evidence_timestamp(record.get(name)) for name in timestamp_names):
        raise TurnStateError("created session turn timestamp is invalid")
    timestamps = [_creation_started_at(record[name]) for name in timestamp_names]
    if timestamps != sorted(timestamps):
        raise TurnStateError("created session turn timestamps are out of order")

    slot_row = conn.execute(
        "SELECT value FROM state_meta WHERE key = ?", (_slot_key(claim.lineage_root_id),)
    ).fetchone()
    if slot_row is None:
        raise TurnStateError("created session lineage slot is unavailable")
    slot = _decode_creation_evidence(slot_row["value"])
    if set(slot) != _CREATION_SLOT_KEYS:
        raise TurnStateError("created session lineage slot evidence is invalid")
    slot_immutable = {key: value for key, value in immutable.items()}
    if any(
        type(slot.get(key)) is not type(value) or slot.get(key) != value
        for key, value in slot_immutable.items()
    ):
        raise TurnStateError("created session lineage slot evidence is invalid")

    def canonical_executor(value: Mapping[str, Any], token_pattern: re.Pattern[str]) -> bool:
        return (
            type(value.get("executor_pid")) is int
            and 0 < value["executor_pid"] <= _MAX_SQLITE_INTEGER
            and type(value.get("executor_started")) is int
            and 0 < value["executor_started"] <= _MAX_SQLITE_INTEGER
            and type(value.get("executor_token")) is str
            and token_pattern.fullmatch(value["executor_token"]) is not None
        )

    if not canonical_executor(slot, _HEX_48):
        raise TurnStateError("created session lineage slot executor is invalid")
    if not canonical_executor(record, _HEX_32 if state == "running" else _HEX_48):
        raise TurnStateError("created session turn executor is invalid")
    executor_keys = ("executor_pid", "executor_started", "executor_token")
    claim_executor = tuple(getattr(claim, key) for key in executor_keys)
    record_executor = tuple(record[key] for key in executor_keys)
    slot_executor = tuple(slot[key] for key in executor_keys)
    if coordinator_index is not None:
        coordinator_identity = tuple(
            coordinator_index[key]
            for key in ("creator_pid", "creator_started", "creator_token")
        )
        coordinator_claim = {
            "operation_id": coordinator_index["operation_id"],
            "payload_sha256": coordinator_index["payload_sha256"],
            "lineage_root_id": coordinator_index["requested_id"],
        }
        if (
            any(
                type(immutable[key]) is not type(value) or immutable[key] != value
                for key, value in coordinator_claim.items()
            )
            or any(
                type(slot[key]) is not type(value) or slot[key] != value
                for key, value in zip(executor_keys, coordinator_identity)
            )
        ):
            raise TurnStateError(
                "created session lineage slot conflicts with coordinator creator"
            )
    if state == "running":
        if claim_executor not in {record_executor, slot_executor}:
            raise TurnStateError("created session turn executor identity is invalid")
    elif claim_executor != record_executor or claim_executor != slot_executor:
        raise TurnStateError("created session creator identity is invalid")

    generation = conn.execute(
        "SELECT value FROM state_meta WHERE key = ?",
        (_generation_key(claim.lineage_root_id),),
    ).fetchone()
    if generation is None or _canonical_generation(generation["value"]) != 1:
        raise TurnStateError("created session generation evidence is invalid")
    return slot


def _validate_creation_terminal_update(
    record: dict[str, Any], *, prior_state: str, slot: Mapping[str, Any]
) -> None:
    base = {
        "claimed": _CREATION_CLAIM_KEYS,
        "admitted": _CREATION_ADMITTED_KEYS,
        "running": _CREATION_RUNNING_KEYS,
    }[prior_state]
    if (
        set(record) != base | _CREATION_TERMINAL_KEYS
        or type(record.get("outcome")) is not str
        or record.get("state") != record["outcome"]
        or record["outcome"] not in _TERMINAL_STATES
        or type(record.get("final_tip_id")) is not str
        or not record["final_tip_id"]
        or not _canonical_evidence_timestamp(record.get("finished_at"))
    ):
        raise TurnStateError("created session terminal evidence is invalid")
    timestamps = [
        _creation_started_at(record[name])
        for name in ("claimed_at", "admitted_at", "running_at", "finished_at")
        if name in record
    ]
    if timestamps != sorted(timestamps):
        raise TurnStateError("created session turn timestamps are out of order")
    if prior_state != "running" and any(
        record[key] != slot[key]
        for key in ("executor_pid", "executor_started", "executor_token")
    ):
        raise TurnStateError("created session terminal executor is invalid")


def _validate_creation_final_tip(
    conn: Any, record: Mapping[str, Any], *, prior_state: str, final_tip_id: Any
) -> None:
    """Bind settlement to the admitted tip or its executed compression lineage."""
    admitted_tip_id = record.get("admitted_tip_id")
    if type(final_tip_id) is not str or not final_tip_id:
        raise TurnStateError("created session terminal tip is invalid")
    if prior_state != "running":
        if final_tip_id != admitted_tip_id:
            raise TurnStateError("created session terminal tip is invalid")
        return
    if final_tip_id == admitted_tip_id:
        return
    try:
        root = _compression_root(conn, final_tip_id)
    except TurnStateError as exc:
        raise TurnStateError("created session terminal tip is invalid") from exc
    if root != record.get("lineage_root_id"):
        raise TurnStateError("created session terminal tip is invalid")


def _validate_stored_creation_record(
    conn: Any, record: dict[str, Any], *, operation_id: str
) -> str:
    """Validate one creation record and its durable lineage evidence."""
    if (
        type(operation_id) is not str
        or _HEX_48.fullmatch(operation_id) is None
        or type(record.get("operation_id")) is not str
        or record["operation_id"] != operation_id
        or type(record.get("payload_sha256")) is not str
        or _HEX_64.fullmatch(record["payload_sha256"]) is None
        or type(record.get("lineage_root_id")) is not str
        or not record["lineage_root_id"]
        or type(record.get("admitted_tip_id")) is not str
        or record["admitted_tip_id"] != record["lineage_root_id"]
    ):
        raise TurnStateError("created session turn identity is invalid")

    state = record.get("state")
    slot_row = conn.execute(
        "SELECT value FROM state_meta WHERE key = ?",
        (_slot_key(record["lineage_root_id"]),),
    ).fetchone()
    slot = (
        _decode_creation_evidence(slot_row["value"])
        if slot_row is not None
        else None
    )
    creator = slot if state == "running" and slot is not None else record
    index = {
        "operation_id": operation_id,
        "payload_sha256": record["payload_sha256"],
        "requested_id": record["lineage_root_id"],
        "creator_pid": creator.get("executor_pid"),
        "creator_started": creator.get("executor_started"),
        "creator_token": creator.get("executor_token"),
    }
    state = _validate_creation_turn(record, index)

    generation_row = conn.execute(
        "SELECT value FROM state_meta WHERE key = ?",
        (_generation_key(record["lineage_root_id"]),),
    ).fetchone()
    if generation_row is None:
        raise TurnStateError("created session generation evidence is invalid")
    generation = _canonical_generation(generation_row["value"])
    if state in _ACTIVE_STATES:
        if generation != 1 or slot is None:
            raise TurnStateError("created session active lineage evidence is invalid")
        _validate_creation_slot(slot, record, index)
        return state

    if generation == 1:
        if slot is not None:
            raise TurnStateError("created session terminal slot is inconsistent")
    elif slot is not None:
        _validate_later_generation_slot(
            conn,
            slot,
            lineage_root_id=record["lineage_root_id"],
            generation=generation,
            creation_operation_id=operation_id,
        )
    _validate_creation_final_tip(
        conn,
        record,
        prior_state="running" if "running_at" in record else "admitted",
        final_tip_id=record.get("final_tip_id"),
    )
    lineage_root, _tip = resolve_lineage(conn, record["lineage_root_id"])
    if lineage_root != record["lineage_root_id"]:
        raise TurnStateError("created session root lineage is invalid")
    return state


def _transition(db, claim: TurnClaim, expected: set[str], state: str, **fields: Any) -> dict[str, Any]:
    _validate_claim(claim)

    def write(conn):
        row = conn.execute("SELECT value FROM state_meta WHERE key = ?", (_turn_key(claim.operation_id),)).fetchone()
        if row is None:
            raise TurnStateError("durable turn record is unavailable")
        record = (
            _decode_creation_evidence(row["value"])
            if claim.operation_kind == "create"
            else _decode(row["value"])
        )
        record_state = record.get("state")
        if type(record_state) is not str or record_state not in expected:
            raise TurnStateError("durable turn transition is invalid")
        if claim.operation_kind == "create":
            _validate_creation_active_evidence(conn, record, claim)
        else:
            _verify_claim_evidence(conn, record, claim)
        if claim.operation_kind == "create" and state == "admitted":
            prepared_fields = _prepared_creation_fields(claim)
            prepared_row = _row(conn, claim.lineage_root_id)
            if conn.execute(
                "SELECT 1 FROM messages WHERE session_id = ? LIMIT 1",
                (claim.lineage_root_id,),
            ).fetchone() is not None:
                raise TurnStateError("created session prepared transcript is not empty")
            if prepared_row is None or not _creation_row_matches(
                prepared_row, prepared_fields, record.get("claimed_at")
            ):
                raise TurnStateError("created session prepared row no longer matches")
            generation = conn.execute(
                "SELECT value FROM state_meta WHERE key = ?",
                (_generation_key(claim.lineage_root_id),),
            ).fetchone()
            if generation is None or _canonical_generation(generation["value"]) != 1:
                raise TurnStateError("created session generation evidence is invalid")
        if claim.operation_kind == "create" and state == "running" and record.get("state") != "admitted":
            raise TurnStateError("created session turn must be admitted before running")
        if claim.operation_kind == "create" and state == "running" and (
            type(fields.get("runtime_id")) is not str
            or not fields["runtime_id"]
            or fields["runtime_id"] != record.get("runtime_id")
        ):
            raise TurnStateError("created session runtime identity is invalid")
        updated = {**record, "state": state, **fields}
        if claim.operation_kind == "create":
            _validate_creation_active_evidence(conn, updated, claim)
        conn.execute("UPDATE state_meta SET value = ? WHERE key = ?", (_encode(updated), _turn_key(claim.operation_id)))
        return updated

    return db._execute_write(write)


def admit_turn(db, claim: TurnClaim, *, runtime_id: str) -> dict[str, Any]:
    return _transition(db, claim, {"claimed"}, "admitted", runtime_id=runtime_id, admitted_at=_now())


def mark_running(db, claim: TurnClaim, *, runtime_id: str) -> dict[str, Any]:
    pid, started, token = current_executor()
    return _transition(
        db,
        claim,
        {"admitted", "claimed"},
        "running",
        runtime_id=runtime_id,
        executor_pid=pid,
        executor_started=started,
        executor_token=token,
        running_at=_now(),
    )


def settle_turn(
    db,
    claim: TurnClaim,
    *,
    outcome: str,
    final_tip_id: str | None = None,
    coordinator_index: Mapping[str, Any] | None = None,
    expected_active_record: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    if coordinator_index is not None:
        if claim.operation_kind != "create":
            raise TurnStateError("coordinator evidence is invalid for continuation settlement")
        try:
            from tui_gateway.companion_creation import _canonical_creation_index_snapshot

            coordinator_index = _canonical_creation_index_snapshot(coordinator_index)
        except Exception as exc:
            raise TurnStateError("creation coordinator evidence is invalid") from exc
        expected_claim = {
            "operation_id": claim.operation_id,
            "payload_sha256": claim.payload_sha256,
            "requested_id": claim.lineage_root_id,
        }
        if any(
            type(coordinator_index.get(key)) is not type(value)
            or coordinator_index.get(key) != value
            for key, value in expected_claim.items()
        ):
            raise TurnStateError("creation coordinator evidence conflicts with turn claim")
    if outcome not in _TERMINAL_STATES:
        raise TurnStateError("invalid durable turn outcome")
    allowed = {"claimed"} if outcome == "not_admitted" else set(_ACTIVE_STATES)
    _validate_claim(claim)

    def write(conn):
        row = conn.execute("SELECT value FROM state_meta WHERE key = ?", (_turn_key(claim.operation_id),)).fetchone()
        if row is None:
            raise TurnStateError("durable turn record is unavailable")
        record = (
            _decode_creation_evidence(row["value"])
            if claim.operation_kind == "create"
            else _decode(row["value"])
        )
        record_state = record.get("state")
        if type(record_state) is not str:
            raise TurnStateError("durable turn settlement is invalid")
        if record_state in _TERMINAL_STATES:
            if claim.operation_kind == "create":
                _validate_stored_creation_record(
                    conn, record, operation_id=claim.operation_id
                )
                immutable = {
                    "payload_sha256": claim.payload_sha256,
                    "lineage_root_id": claim.lineage_root_id,
                    "admitted_tip_id": claim.admitted_tip_id,
                    "generation": claim.generation,
                }
                if any(
                    type(record.get(key)) is not type(value)
                    or record.get(key) != value
                    for key, value in immutable.items()
                ):
                    raise TurnStateError("created session terminal identity is invalid")
            return record
        if expected_active_record is not None and record != dict(expected_active_record):
            return record
        if (
            claim.operation_kind == "create"
            and outcome != "not_admitted"
            and record_state == "claimed"
        ):
            raise TurnStateError("created session turn must be admitted before settlement")
        if record_state not in allowed:
            raise TurnStateError("durable turn settlement is invalid")
        slot_key = _slot_key(claim.lineage_root_id)
        slot = None
        if claim.operation_kind == "create":
            slot = _validate_creation_active_evidence(
                conn, record, claim, coordinator_index=coordinator_index
            )
            _validate_creation_final_tip(
                conn,
                record,
                prior_state=record_state,
                final_tip_id=final_tip_id,
            )
        else:
            _verify_claim_evidence(conn, record, claim)
        updated = {
            **record,
            "state": outcome,
            "outcome": outcome,
            "finished_at": _now(),
            **({"final_tip_id": final_tip_id} if final_tip_id else {}),
        }
        if claim.operation_kind == "create":
            assert slot is not None
            _validate_creation_terminal_update(
                updated, prior_state=record_state, slot=slot
            )
        conn.execute("UPDATE state_meta SET value = ? WHERE key = ?", (_encode(updated), _turn_key(claim.operation_id)))
        conn.execute("DELETE FROM state_meta WHERE key = ?", (slot_key,))
        return updated

    return db._execute_write(write)


def read_turn(db, operation_id: str) -> dict[str, Any] | None:
    with db._read_ctx() as conn:
        row = conn.execute(
            "SELECT value FROM state_meta WHERE key = ?", (_turn_key(operation_id),)
        ).fetchone()
        if row is None:
            return None
        record = _decode(row["value"])
        if record.get("operation_kind") == "create":
            record = _decode_creation_evidence(row["value"])
            _validate_stored_creation_record(conn, record, operation_id=operation_id)
        return record


def reconcile_dead_executor(
    db,
    claim: TurnClaim,
    *,
    coordinator_index: Mapping[str, Any] | None = None,
    observed_record: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    if claim.operation_kind == "create" and coordinator_index is None:
        raise TurnStateError("creation recovery requires coordinator creator authority")
    record = (
        dict(observed_record)
        if observed_record is not None
        else read_turn(db, claim.operation_id)
    )
    if record and record.get("operation_id") != claim.operation_id:
        raise TurnStateError("durable turn observation conflicts with its claim")
    if record is None or record.get("state") in _TERMINAL_STATES:
        return record or {}
    liveness = executor_liveness(record)
    if liveness != "dead":
        return record
    outcome = "not_admitted" if record.get("state") == "claimed" else "interrupted_outcome_unknown"
    return settle_turn(
        db,
        claim,
        outcome=outcome,
        final_tip_id=record.get("admitted_tip_id"),
        coordinator_index=coordinator_index,
        expected_active_record=record,
    )


def active_lineage_turn(db, requested_id: str) -> bool:
    with db._read_ctx() as conn:
        root, _tip = resolve_lineage(conn, requested_id)
        return conn.execute("SELECT 1 FROM state_meta WHERE key = ?", (_slot_key(root),)).fetchone() is not None
