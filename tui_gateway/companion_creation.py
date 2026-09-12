"""P4 durable Companion session creation coordination."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import threading
from typing import Any, Mapping
import uuid

from gateway.status import get_process_start_time, probe_pid_liveness
from tui_gateway.companion_sessions import (
    CompanionSessionsError,
    _MAX_QUERY_LENGTH,
    _MAX_SESSION_ID_LENGTH,
    _MAX_SQLITE_INTEGER,
    _as_of,
    _contains_unicode_control,
    _continuity_receipt_key,
    _continuity_v3_key,
    _parse_request_index,
    _request_index_kind,
)


_CREATION_INDEX_KEYS = frozenset({
    "v", "operation_kind", "payload_sha256", "operation_id",
    "backend_namespace", "target_profile", "requested_id", "project_id",
    "creator_pid", "creator_started", "creator_token", "creator_epoch",
    "phase", "bound_at", "phase_at", "closed_outcome",
})
_CREATION_PHASES = frozenset({"bound", "preparing", "prepared", "dispatching", "closed"})
_CREATION_CLOSED_OUTCOMES = frozenset({None, "not_admitted", "turn_record"})
_CREATION_EXECUTION_TRANSITIONS = {
    "bound": "preparing",
    "preparing": "prepared",
    "prepared": "dispatching",
}
_PROCESS_CREATION_TOKEN = secrets.token_hex(24)
_PROCESS_CREATION_TOKEN_PID = os.getpid()
_PROCESS_CREATION_TOKEN_LOCK = threading.Lock()
_CREATION_RECONCILE_KEYS = frozenset({
    "operation_kind", "backend_namespace", "profile", "client_request_id",
})
_INVALID_RECONCILIATION_MESSAGE = "invalid session reconciliation parameters"
_CREATION_UNKNOWN_MESSAGE = "Creation outcome unknown; reconcile this request."


def _reset_process_creation_identity_after_fork() -> None:
    """Replace fork-inherited creator state without touching a possibly locked parent lock."""
    global _PROCESS_CREATION_TOKEN, _PROCESS_CREATION_TOKEN_PID, _PROCESS_CREATION_TOKEN_LOCK
    _PROCESS_CREATION_TOKEN_LOCK = threading.Lock()
    _PROCESS_CREATION_TOKEN = secrets.token_hex(24)
    _PROCESS_CREATION_TOKEN_PID = os.getpid()


try:
    _register_at_fork = getattr(os, "register_at_fork", None)
    if callable(_register_at_fork):
        _register_at_fork(after_in_child=_reset_process_creation_identity_after_fork)
except Exception:
    # Unsupported runtimes keep the existing lazy PID-change refresh path.
    pass


def _creation_payload_digest(
    backend: str,
    profile: str,
    project_id: str | None,
    original_text: str,
    sanitized_text: str,
) -> str:
    """Bind both the caller's bytes and the text interpreted by submission."""
    raw = json.dumps(
        ["p4.create.v1", backend, profile, project_id, original_text, sanitized_text],
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _valid_utc_timestamp(value: Any) -> bool:
    if (
        not isinstance(value, str)
        or re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", value) is None
    ):
        return False
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return False
    return (
        parsed.tzinfo is not None
        and parsed.utcoffset() == timezone.utc.utcoffset(parsed)
        and parsed.isoformat().replace("+00:00", "Z") == value
    )

def _valid_protocol_text(value: Any, maximum_bytes: int) -> bool:
    """Accept non-empty canonical UTF-8 text without wire controls."""
    if not isinstance(value, str) or value != value.strip() or not value:
        return False
    if _contains_unicode_control(value):
        return False
    try:
        return len(value.encode("utf-8")) <= maximum_bytes
    except UnicodeEncodeError:
        return False


def _valid_creation_profile(value: Any) -> bool:
    """Apply the canonical profile validator used by every creation-v4 boundary."""
    if not _valid_protocol_text(value, 64):
        return False
    try:
        from hermes_cli.profiles import validate_profile_name

        validate_profile_name(value)
    except (ImportError, TypeError, ValueError):
        return False
    return True


def _valid_canonical_uuid4(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parsed = uuid.UUID(value)
    except (AttributeError, ValueError):
        return False
    return (
        parsed.version == 4
        and parsed.variant == uuid.RFC_4122
        and str(parsed) == value
    )


def _validate_creation_reconcile_params(params: Any) -> dict[str, str]:
    if (
        not isinstance(params, dict)
        or set(params) != _CREATION_RECONCILE_KEYS
        or params.get("operation_kind") != "create"
        or not _valid_protocol_text(params.get("backend_namespace"), _MAX_QUERY_LENGTH)
        or not _valid_creation_profile(params.get("profile"))
        or not _valid_canonical_uuid4(params.get("client_request_id"))
    ):
        raise CompanionSessionsError(_INVALID_RECONCILIATION_MESSAGE, -32602)
    return params


def _creation_not_found_receipt(params: Mapping[str, str]) -> dict[str, Any]:
    return {
        "version": 1,
        "operation_kind": "create",
        "backend_namespace": params["backend_namespace"],
        "profile": params["profile"],
        "client_request_id": params["client_request_id"],
        "project_id": None,
        "stored_session_id": None,
        "row_state": "absent",
        "operation_status": "not_found",
        "runtime_session_id": None,
    }


def reconcile_creation_session(
    server, params: Any, *, owner_authorization: Any = None
) -> dict[str, Any]:
    """Reconcile an indexed creation without obtaining execution authority."""
    from tui_gateway.companion_sessions import (
        _backend_namespace,
        _continuity_ledger,
        _require_owner,
        _source,
        _validate_profile,
    )

    params = _validate_creation_reconcile_params(params)
    owner = _require_owner(owner_authorization)
    ledger = _continuity_ledger(server)
    request_id = params["client_request_id"]

    # The launch-profile coordinator is authoritative and is always inspected
    # before any target profile is opened. Reconciliation never creates a row.
    raw = ledger.get_meta(_continuity_v3_key(owner, request_id))
    if raw is not None:
        try:
            index = _parse_request_index(raw)
        except CompanionSessionsError as exc:
            raise CompanionSessionsError(
                "creation reconciliation index is invalid", 5006
            ) from exc
        if _request_index_kind(index) != "create":
            raise CompanionSessionsError(
                "client_request_id conflicts with another operation kind", 4090
            )
    else:
        index = None

    if ledger.get_meta(_continuity_receipt_key(owner, request_id)) is not None:
        raise CompanionSessionsError(
            "client_request_id conflicts with a legacy continuation", 4090
        )

    backend = _backend_namespace(server)
    profile = _validate_profile(server, params["profile"])
    if params["backend_namespace"] != backend:
        raise CompanionSessionsError("session backend unavailable", 4404)
    if index is None:
        return _creation_not_found_receipt(params)
    if (
        index["backend_namespace"] != backend
        or index["target_profile"] != profile
    ):
        raise CompanionSessionsError(
            "creation reconciliation target conflicts with request", 4090
        )

    age_seconds = max(
        0.0,
        (datetime.now(timezone.utc) - _parse_utc_timestamp(index["bound_at"])).total_seconds(),
    )
    from contextlib import ExitStack

    source_stack = ExitStack()
    try:
        target = source_stack.enter_context(_source(server, profile, writable=True))
    except CompanionSessionsError as exc:
        if exc.code != 4404:
            raise
        source_stack.close()
        from tui_gateway.companion_turns import CreatedSessionObservation

        return project_creation_receipt(
            client_request_id=request_id,
            index=index,
            observation=CreatedSessionObservation(
                row_state="unavailable",
                evidence_state="unavailable",
            ),
            creator_liveness="unknown",
            age_seconds=age_seconds,
        )
    except BaseException:
        source_stack.close()
        raise

    with source_stack:
        return _reconcile_creation_recovery(
            ledger,
            target,
            owner=owner,
            client_request_id=request_id,
            index=index,
            age_seconds=age_seconds,
        )


def _parse_utc_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value[:-1] + "+00:00")


def _valid_creation_request_index(value: Mapping[str, Any], common_valid: bool) -> bool:
    project_id = value.get("project_id")
    return bool(
        set(value) == _CREATION_INDEX_KEYS
        and common_valid
        and _valid_protocol_text(value.get("backend_namespace"), _MAX_QUERY_LENGTH)
        and _valid_creation_profile(value.get("target_profile"))
        and _valid_protocol_text(value.get("requested_id"), _MAX_SESSION_ID_LENGTH)
        and (
            project_id is None
            or _valid_protocol_text(project_id, _MAX_SESSION_ID_LENGTH)
        )
        and type(value.get("creator_pid")) is int
        and 0 < value["creator_pid"] <= _MAX_SQLITE_INTEGER
        and type(value.get("creator_started")) is int
        and 0 < value["creator_started"] <= _MAX_SQLITE_INTEGER
        and isinstance(value.get("creator_token"), str)
        and re.fullmatch(r"[0-9a-f]{48}", value["creator_token"]) is not None
        and type(value.get("creator_epoch")) is int
        and value["creator_epoch"] == 1
        and isinstance(value.get("phase"), str)
        and value["phase"] in _CREATION_PHASES
        and _valid_utc_timestamp(value.get("bound_at"))
        and _valid_utc_timestamp(value.get("phase_at"))
        and _parse_utc_timestamp(value["phase_at"]) >= _parse_utc_timestamp(value["bound_at"])
        and (
            value.get("closed_outcome") is None
            or (
                isinstance(value.get("closed_outcome"), str)
                and value["closed_outcome"] in _CREATION_CLOSED_OUTCOMES
            )
        )
        and ((value["phase"] == "closed") == (value["closed_outcome"] is not None))
    )


def _snapshot_creation_creator() -> dict[str, Any]:
    """Capture this process's stable creator identity before any SQL retry."""
    global _PROCESS_CREATION_TOKEN, _PROCESS_CREATION_TOKEN_PID
    pid = os.getpid()
    if type(pid) is not int or not 0 < pid <= _MAX_SQLITE_INTEGER:
        raise CompanionSessionsError("creation coordinator identity is unavailable", 5006)
    try:
        started = get_process_start_time(pid)
    except Exception as exc:
        raise CompanionSessionsError(
            "creation coordinator identity is unavailable", 5006
        ) from exc
    if type(started) is not int or not 0 < started <= _MAX_SQLITE_INTEGER:
        raise CompanionSessionsError("creation coordinator identity is unavailable", 5006)
    # A fork inherits module globals. Refresh once in the child so the token is
    # process-local rather than merely interpreter-import-local.
    with _PROCESS_CREATION_TOKEN_LOCK:
        if _PROCESS_CREATION_TOKEN_PID != pid:
            _PROCESS_CREATION_TOKEN = secrets.token_hex(24)
            _PROCESS_CREATION_TOKEN_PID = pid
        token = _PROCESS_CREATION_TOKEN
    if re.fullmatch(r"[0-9a-f]{48}", token) is None:
        raise CompanionSessionsError("creation coordinator identity is unavailable", 5006)
    return {
        "creator_pid": pid,
        "creator_started": started,
        "creator_token": token,
        "creator_epoch": 1,
    }


def _creation_creator_liveness(index: Mapping[str, Any]) -> str:
    """Return alive/dead/unknown without killing or applying an age policy."""
    pid = index["creator_pid"]
    expected_started = index["creator_started"]
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
    if (
        type(observed_started) is not int
        or not 0 < observed_started <= _MAX_SQLITE_INTEGER
    ):
        return "unknown"
    return "alive" if observed_started == expected_started else "dead"


def _creation_evidence_permitted(
    index: Mapping[str, Any], *, evidence_state: str, turn_state: str | None
) -> bool:
    """Apply the fail-closed creation phase/evidence matrix."""
    phase = index["phase"]
    closed_outcome = index["closed_outcome"]
    if evidence_state == "absent":
        return phase in {"bound", "preparing"} or (
            phase == "closed" and closed_outcome == "not_admitted"
        )
    if evidence_state != "exact" or turn_state is None:
        return False
    if phase == "bound":
        return False
    if phase in {"preparing", "prepared"}:
        return turn_state in {"claimed", "not_admitted"}
    if phase == "dispatching":
        return turn_state in {
            "claimed", "admitted", "running", "completed", "failed", "cancelled",
            "not_admitted", "interrupted_outcome_unknown",
        }
    if closed_outcome == "not_admitted":
        return False
    return closed_outcome == "turn_record" and turn_state in {
        "admitted", "running", "completed", "failed", "cancelled", "not_admitted",
        "interrupted_outcome_unknown",
    }


def _degraded_creation_receipt(
    *, client_request_id: str, index: Mapping[str, Any]
) -> dict[str, Any]:
    return {
        "version": 1,
        "operation_kind": "create",
        "backend_namespace": index["backend_namespace"],
        "profile": index["target_profile"],
        "client_request_id": client_request_id,
        "project_id": index["project_id"],
        "stored_session_id": index["requested_id"],
        "row_state": "unavailable",
        "operation_status": "recovery_required",
        "runtime_session_id": None,
    }


def project_creation_receipt(
    *,
    client_request_id: str,
    index: Mapping[str, Any],
    observation: Any,
    creator_liveness: str,
    age_seconds: float,
) -> dict[str, Any]:
    """Project only the exact pre-runtime creation receipt contract."""
    from tui_gateway.companion_turns import CreatedSessionObservation

    try:
        index = _canonical_creation_index_snapshot(index)
    except Exception as exc:
        raise CompanionSessionsError(_CREATION_UNKNOWN_MESSAGE, 5066) from exc
    if not _valid_canonical_uuid4(client_request_id):
        raise CompanionSessionsError(_CREATION_UNKNOWN_MESSAGE, 5066)

    try:
        if type(creator_liveness) is not str or creator_liveness not in {
            "alive", "dead", "unknown"
        }:
            return _degraded_creation_receipt(
                client_request_id=client_request_id, index=index
            )
        if type(age_seconds) is int:
            valid_age = age_seconds >= 0
        elif type(age_seconds) is float:
            valid_age = math.isfinite(age_seconds) and age_seconds >= 0
        else:
            valid_age = False
        if not valid_age or type(observation) is not CreatedSessionObservation:
            return _degraded_creation_receipt(
                client_request_id=client_request_id, index=index
            )

        row_state = observation.row_state
        evidence_state = observation.evidence_state
        turn_state = observation.turn_state
        valid_observation = (
            type(row_state) is str
            and row_state in {"absent", "present", "unavailable"}
            and type(evidence_state) is str
            and evidence_state in {"absent", "exact", "inconsistent", "unavailable"}
            and (
                turn_state is None
                or (
                    type(turn_state) is str
                    and turn_state in {
                        "claimed", "admitted", "running", "completed", "failed",
                        "cancelled", "not_admitted", "interrupted_outcome_unknown",
                    }
                )
            )
            and (
                (evidence_state == "absent" and row_state == "absent" and turn_state is None)
                or (evidence_state == "exact" and row_state == "present" and turn_state is not None)
                or (
                    evidence_state in {"inconsistent", "unavailable"}
                    and row_state == "unavailable"
                    and turn_state is None
                )
            )
        )
        if not valid_observation:
            return _degraded_creation_receipt(
                client_request_id=client_request_id, index=index
            )

        operation_status = "recovery_required"
        permitted = _creation_evidence_permitted(
            index, evidence_state=evidence_state, turn_state=turn_state
        )
        fresh_creator = creator_liveness == "alive" and age_seconds <= 60.0
        if permitted and evidence_state == "exact":
            if turn_state in {"claimed", "admitted", "running"}:
                if fresh_creator:
                    operation_status = turn_state
            else:
                operation_status = turn_state
        elif permitted and evidence_state == "absent":
            phase = index["phase"]
            if phase == "closed":
                operation_status = "not_admitted"
            elif fresh_creator:
                operation_status = "preparing"
        if operation_status == "recovery_required" and not permitted:
            row_state = "unavailable"

        return {
            "version": 1,
            "operation_kind": "create",
            "backend_namespace": index["backend_namespace"],
            "profile": index["target_profile"],
            "client_request_id": client_request_id,
            "project_id": index["project_id"],
            "stored_session_id": index["requested_id"],
            "row_state": row_state,
            "operation_status": operation_status,
            "runtime_session_id": None,
        }
    except Exception as exc:
        raise CompanionSessionsError(_CREATION_UNKNOWN_MESSAGE, 5066) from exc


def _reconcile_creation_recovery(
    ledger_db,
    target_db,
    *,
    owner: str,
    client_request_id: str,
    index: Mapping[str, Any],
    age_seconds: float,
    phase_at: str | None = None,
) -> dict[str, Any]:
    """Finalize one dead creator without acquiring execution authority."""
    from tui_gateway.companion_turns import (
        CreatedSessionObservation,
        TurnStateError,
        _observe_created_session_recovery,
        claim_from_record,
        reconcile_dead_executor,
        settle_turn,
    )

    snapshot = _canonical_creation_index_snapshot(index)
    creator_liveness = _creation_creator_liveness(snapshot)
    observation, record = _observe_created_session_recovery(target_db, snapshot)

    def receipt(
        current: Mapping[str, Any], observed: CreatedSessionObservation
    ) -> dict[str, Any]:
        return project_creation_receipt(
            client_request_id=client_request_id,
            index=current,
            observation=observed,
            creator_liveness=creator_liveness,
            age_seconds=age_seconds,
        )

    if creator_liveness != "dead" or snapshot["phase"] == "closed":
        return receipt(snapshot, observation)
    if observation.evidence_state == "absent":
        if snapshot["phase"] not in {"bound", "preparing"}:
            return receipt(snapshot, observation)
        closed, _changed = _close_creation_phase(
            ledger_db,
            owner=owner,
            client_request_id=client_request_id,
            snapshot=snapshot,
            creator={name: snapshot[name] for name in (
                "creator_pid", "creator_started", "creator_token", "creator_epoch"
            )},
            closed_outcome="not_admitted",
            phase_at=phase_at,
        )
        return receipt(closed, observation)
    if observation.evidence_state != "exact" or observation.turn_state is None:
        return receipt(snapshot, observation)

    if record is None:
        return receipt(
            snapshot, CreatedSessionObservation("unavailable", "inconsistent")
        )
    state = record.get("state")
    terminal = {
        "completed", "failed", "cancelled", "not_admitted",
        "interrupted_outcome_unknown",
    }
    if state == "claimed" and snapshot["phase"] in {
        "preparing", "prepared", "dispatching",
    }:
        try:
            record = settle_turn(
                target_db,
                claim_from_record(record),
                outcome="not_admitted",
                final_tip_id=snapshot["requested_id"],
                coordinator_index=snapshot,
                expected_active_record=record,
            )
        except TurnStateError:
            return receipt(
                snapshot, CreatedSessionObservation("unavailable", "inconsistent")
            )
        state = record.get("state")
    elif state in {"admitted", "running"} and snapshot["phase"] == "dispatching":
        try:
            record = reconcile_dead_executor(
                target_db,
                claim_from_record(record),
                coordinator_index=snapshot,
                observed_record=record,
            )
        except TurnStateError:
            return receipt(
                snapshot, CreatedSessionObservation("unavailable", "inconsistent")
            )
        state = record.get("state")

    observed = CreatedSessionObservation("present", "exact", state)
    if state not in terminal:
        return receipt(snapshot, observed)
    closed, _changed = _close_creation_phase(
        ledger_db,
        owner=owner,
        client_request_id=client_request_id,
        snapshot=snapshot,
        creator={name: snapshot[name] for name in (
            "creator_pid", "creator_started", "creator_token", "creator_epoch"
        )},
        closed_outcome="turn_record",
        phase_at=phase_at,
    )
    return receipt(closed, observed)


_CREATION_IMMUTABLE_FIELDS = (
    "v",
    "operation_kind",
    "payload_sha256",
    "operation_id",
    "backend_namespace",
    "target_profile",
    "requested_id",
    "project_id",
    "creator_pid",
    "creator_started",
    "creator_token",
    "creator_epoch",
    "bound_at",
)


def _canonical_creation_index_snapshot(snapshot: Mapping[str, Any]) -> dict[str, Any]:
    try:
        encoded = json.dumps(snapshot, sort_keys=True, separators=(",", ":"))
        parsed = _parse_request_index(encoded)
    except (CompanionSessionsError, TypeError, ValueError, RecursionError) as exc:
        raise CompanionSessionsError("creation coordinator state is invalid", 5006) from exc
    if _request_index_kind(parsed) != "create":
        raise CompanionSessionsError("creation coordinator state is invalid", 5006)
    if (
        not _valid_protocol_text(parsed.get("backend_namespace"), _MAX_QUERY_LENGTH)
        or not _valid_creation_profile(parsed.get("target_profile"))
        or not _valid_protocol_text(parsed.get("requested_id"), _MAX_SESSION_ID_LENGTH)
        or (
            parsed.get("project_id") is not None
            and not _valid_protocol_text(parsed.get("project_id"), _MAX_SESSION_ID_LENGTH)
        )
    ):
        raise CompanionSessionsError("creation coordinator state is invalid", 5006)
    return parsed


def _creation_phase_cas(
    db,
    *,
    owner: str,
    client_request_id: str,
    snapshot: Mapping[str, Any],
    creator: Mapping[str, Any],
    expected_phase: str,
    next_phase: str,
    closed_outcome: str | None = None,
    phase_at: str | None = None,
) -> tuple[dict[str, Any], bool]:
    """Strictly advance one creation phase; bool says this call changed it."""
    expected = _canonical_creation_index_snapshot(snapshot)
    expected_creator = {
        name: expected[name]
        for name in ("creator_pid", "creator_started", "creator_token", "creator_epoch")
    }
    supplied_creator = dict(creator)
    if (
        supplied_creator.keys() != expected_creator.keys()
        or any(
            type(supplied_creator[name]) is not type(expected_value)
            or supplied_creator[name] != expected_value
            for name, expected_value in expected_creator.items()
        )
    ):
        raise CompanionSessionsError("creation coordinator identity conflicts", 4090)
    if expected_phase != expected["phase"] or expected_phase == "closed":
        raise CompanionSessionsError("creation coordinator phase conflicts", 4090)
    if next_phase == "closed":
        if closed_outcome not in {"not_admitted", "turn_record"}:
            raise CompanionSessionsError("creation close outcome is invalid", -32602)
    elif (
        closed_outcome is not None
        or _CREATION_EXECUTION_TRANSITIONS.get(expected_phase) != next_phase
    ):
        raise CompanionSessionsError("creation coordinator phase transition is invalid", 4090)

    # Generate and validate once, before the callback that _execute_write may retry.
    transition_at = phase_at if phase_at is not None else _as_of()
    if (
        not _valid_utc_timestamp(transition_at)
        or _parse_utc_timestamp(transition_at) < _parse_utc_timestamp(expected["phase_at"])
    ):
        raise CompanionSessionsError("creation coordinator phase timestamp is invalid", 4090)
    target = dict(expected)
    target.update(
        phase=next_phase,
        phase_at=transition_at,
        closed_outcome=closed_outcome if next_phase == "closed" else None,
    )
    _canonical_creation_index_snapshot(target)
    key = _continuity_v3_key(owner, client_request_id)
    serialized_target = json.dumps(target, sort_keys=True, separators=(",", ":"))

    def write(conn):
        row = conn.execute("SELECT value FROM state_meta WHERE key = ?", (key,)).fetchone()
        if row is None:
            raise CompanionSessionsError("creation coordinator state is unavailable", 4090)
        try:
            current = _parse_request_index(row["value"])
        except CompanionSessionsError as exc:
            raise CompanionSessionsError("creation coordinator state is invalid", 5006) from exc
        if _request_index_kind(current) != "create":
            raise CompanionSessionsError("creation coordinator state conflicts", 4090)
        if any(current[name] != expected[name] for name in _CREATION_IMMUTABLE_FIELDS):
            raise CompanionSessionsError("creation coordinator state conflicts", 4090)
        if current == target:
            return current, False
        if current["phase"] == "closed":
            if next_phase == "closed" and current["closed_outcome"] == closed_outcome:
                return current, False
            raise CompanionSessionsError("creation coordinator is closed", 4090)
        if any(
            current[name] != expected[name]
            for name in ("phase", "phase_at", "closed_outcome")
        ):
            raise CompanionSessionsError("creation coordinator phase conflicts", 4090)
        conn.execute(
            "UPDATE state_meta SET value = ? WHERE key = ?",
            (serialized_target, key),
        )
        return target, True

    return db._execute_write(write)


def _advance_creation_phase(
    db, *, owner: str, client_request_id: str, snapshot: Mapping[str, Any],
    creator: Mapping[str, Any], next_phase: str, phase_at: str | None = None,
) -> tuple[dict[str, Any], bool]:
    return _creation_phase_cas(
        db,
        owner=owner,
        client_request_id=client_request_id,
        snapshot=snapshot,
        creator=creator,
        expected_phase=str(snapshot.get("phase", "")),
        next_phase=next_phase,
        phase_at=phase_at,
    )


def _close_creation_phase(
    db, *, owner: str, client_request_id: str, snapshot: Mapping[str, Any],
    creator: Mapping[str, Any], closed_outcome: str, phase_at: str | None = None,
) -> tuple[dict[str, Any], bool]:
    return _creation_phase_cas(
        db,
        owner=owner,
        client_request_id=client_request_id,
        snapshot=snapshot,
        creator=creator,
        expected_phase=str(snapshot.get("phase", "")),
        next_phase="closed",
        closed_outcome=closed_outcome,
        phase_at=phase_at,
    )

def _creation_request_index(
    db,
    *,
    owner: str,
    client_request_id: str,
    payload_digest: str,
    backend: str,
    profile: str,
    stored_id: str,
    project_id: str | None,
    operation_id: str,
    creator_pid: int,
    creator_started: int,
    creator_token: str,
    bound_at: str,
) -> tuple[dict, bool]:
    """Atomically bind one creation to the shared owner/request namespace.

    Generated values are captured before the SQL callback so storage retries
    cannot mint another session, operation, creator, or timestamp.
    """
    key = _continuity_v3_key(owner, client_request_id)
    legacy_key = _continuity_receipt_key(owner, client_request_id)
    proposed = {
        "v": 4,
        "operation_kind": "create",
        "payload_sha256": payload_digest,
        "operation_id": operation_id,
        "backend_namespace": backend,
        "target_profile": profile,
        "requested_id": stored_id,
        "project_id": project_id,
        "creator_pid": creator_pid,
        "creator_started": creator_started,
        "creator_token": creator_token,
        "creator_epoch": 1,
        "phase": "bound",
        "bound_at": bound_at,
        "phase_at": bound_at,
        "closed_outcome": None,
    }
    _parse_request_index(json.dumps(proposed, separators=(",", ":")))

    def write(conn):
        row = conn.execute("SELECT value FROM state_meta WHERE key = ?", (key,)).fetchone()
        existing = None
        if row is not None:
            existing = _parse_request_index(row["value"])
            if _request_index_kind(existing) != "create":
                raise CompanionSessionsError(
                    "client_request_id conflicts with another operation kind", 4090
                )
        legacy = conn.execute(
            "SELECT 1 FROM state_meta WHERE key = ?", (legacy_key,)
        ).fetchone()
        if legacy is not None:
            raise CompanionSessionsError(
                "client_request_id conflicts with a legacy continuation", 4090
            )
        if row is None:
            conn.execute(
                "INSERT INTO state_meta (key, value) VALUES (?, ?)",
                (key, json.dumps(proposed, sort_keys=True, separators=(",", ":"))),
            )
            return proposed, True
        assert existing is not None
        if not hmac.compare_digest(existing["payload_sha256"], payload_digest):
            raise CompanionSessionsError(
                "client_request_id conflicts with different creation payload", 4090
            )
        if any(
            existing.get(name) != expected
            for name, expected in (
                ("backend_namespace", backend),
                ("target_profile", profile),
                ("project_id", project_id),
            )
        ):
            raise CompanionSessionsError(
                "client_request_id conflicts with different creation target", 4090
            )
        return existing, False

    return db._execute_write(write)
