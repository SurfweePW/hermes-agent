"""Owner-only composite durable Companion creation saga."""
from __future__ import annotations

from datetime import datetime, timezone
import hmac
import logging
from typing import Any, Mapping
import uuid

from tui_gateway.companion_sessions import CompanionSessionsError

logger = logging.getLogger(__name__)

_CREATE_KEYS = frozenset(
    {
        "version",
        "backend_namespace",
        "profile",
        "client_request_id",
        "project_id",
        "text",
    }
)
_RECEIPT_KEYS = frozenset(
    {
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
)
_CREATE_FAILURE = "Durable creation failed."
_CREATE_UNKNOWN = "Creation outcome unknown; reconcile this request."
_TURN_RECORD_COORDINATOR_STATES = frozenset(
    {"admitted", "running", "completed", "failed", "interrupted", "not_admitted"}
)


def _exact_streaming_ack(response: Any, request_id: Any) -> bool:
    return (
        isinstance(response, dict)
        and set(response) == {"jsonrpc", "id", "result"}
        and response.get("jsonrpc") == "2.0"
        and response.get("id") == request_id
        and response.get("result") == {"status": "streaming"}
    )


def _validate_create_params(params: Any) -> tuple[dict[str, Any], str]:
    from hermes_cli.input_sanitize import sanitize_user_prompt_text
    from tui_gateway.companion_creation import (
        _valid_canonical_uuid4,
        _valid_creation_profile,
        _valid_protocol_text,
    )

    if not isinstance(params, dict) or set(params) != _CREATE_KEYS:
        raise CompanionSessionsError("invalid session creation parameters", -32602)
    if type(params.get("version")) is not int or params["version"] != 1:
        raise CompanionSessionsError("unsupported session creation version", -32602)
    if not _valid_protocol_text(params.get("backend_namespace"), 4096):
        raise CompanionSessionsError("invalid session creation parameters", -32602)
    if not _valid_creation_profile(params.get("profile")):
        raise CompanionSessionsError("invalid session creation parameters", -32602)
    if not _valid_canonical_uuid4(params.get("client_request_id")):
        raise CompanionSessionsError("invalid session creation parameters", -32602)
    project_id = params.get("project_id")
    if project_id is not None and not _valid_protocol_text(project_id, 512):
        raise CompanionSessionsError("invalid session creation parameters", -32602)
    text = params.get("text")
    if not isinstance(text, str):
        raise CompanionSessionsError("text must be a bounded non-empty string", -32602)
    try:
        if not 1 <= len(text.encode("utf-8")) <= 1_000_000:
            raise ValueError
        sanitized = sanitize_user_prompt_text(text)
        if not isinstance(sanitized, str) or not sanitized.strip():
            raise ValueError
        if not 1 <= len(sanitized.encode("utf-8")) <= 1_000_000:
            raise ValueError
    except (UnicodeEncodeError, ValueError) as exc:
        raise CompanionSessionsError(
            "text must be a bounded non-empty string", -32602
        ) from exc
    try:
        from tools.voice_mode import is_voice_stop_phrase

        if is_voice_stop_phrase(sanitized):
            raise CompanionSessionsError(
                "text must be a bounded non-empty string", -32602
            )
    except CompanionSessionsError:
        raise
    except Exception:
        # Failure to load an optional voice helper must not reinterpret ordinary text.
        pass
    return params, sanitized


def _creator_fields(index: Mapping[str, Any]) -> dict[str, Any]:
    return {
        name: index[name]
        for name in ("creator_pid", "creator_started", "creator_token", "creator_epoch")
    }


def _existing_index(
    ledger, *, owner: str, request_id: str, digest: str, backend: str,
    profile: str, project_id: str | None,
) -> dict[str, Any] | None:
    from tui_gateway.companion_creation import _canonical_creation_index_snapshot
    from tui_gateway.companion_sessions import (
        _continuity_receipt_key,
        _continuity_v3_key,
        _parse_request_index,
        _request_index_kind,
    )

    raw = ledger.get_meta(_continuity_v3_key(owner, request_id))
    if ledger.get_meta(_continuity_receipt_key(owner, request_id)) is not None:
        raise CompanionSessionsError(
            "client_request_id conflicts with another operation kind", 4090
        )
    if raw is None:
        return None
    parsed = _parse_request_index(raw)
    if _request_index_kind(parsed) != "create":
        raise CompanionSessionsError(
            "client_request_id conflicts with another operation kind", 4090
        )
    index = _canonical_creation_index_snapshot(parsed)
    if not hmac.compare_digest(index["payload_sha256"], digest):
        raise CompanionSessionsError(
            "client_request_id conflicts with different creation payload", 4090
        )
    if (
        index["backend_namespace"] != backend
        or index["target_profile"] != profile
        or index["project_id"] != project_id
    ):
        raise CompanionSessionsError(
            "client_request_id conflicts with different creation target", 4090
        )
    return index


def _replay_receipt(server, params: Mapping[str, Any], owner_authorization: Any) -> dict[str, Any]:
    from tui_gateway.companion_creation import reconcile_creation_session

    return reconcile_creation_session(
        server,
        {
            "operation_kind": "create",
            "backend_namespace": params["backend_namespace"],
            "profile": params["profile"],
            "client_request_id": params["client_request_id"],
        },
        owner_authorization=owner_authorization,
    )


def _project_receipt(
    server, *, ledger, owner: str, request_id: str, index: Mapping[str, Any],
    target_db=None, runtime_id: str | None = None,
) -> dict[str, Any]:
    from tui_gateway.companion_creation import (
        _creation_creator_liveness,
        _parse_utc_timestamp,
        project_creation_receipt,
    )
    from tui_gateway.companion_sessions import _source
    from tui_gateway.companion_turns import observe_created_session
    from tui_gateway.transport import current_transport

    def build(db):
        age = max(
            0.0,
            (datetime.now(timezone.utc) - _parse_utc_timestamp(index["bound_at"])).total_seconds(),
        )
        return project_creation_receipt(
            client_request_id=request_id,
            index=index,
            observation=observe_created_session(db, index),
            creator_liveness=_creation_creator_liveness(index),
            age_seconds=age,
        )

    if target_db is None:
        with _source(server, index["target_profile"], writable=True) as opened:
            receipt = build(opened)
    else:
        receipt = build(target_db)
    if runtime_id is not None:
        with server._lifecycle_reservation_lock, server._sessions_lock:
            session = server._sessions.get(runtime_id)
            lease = session.get("active_session_lease") if session else None
            if (
                session is not None
                and session.get("session_key") == index["requested_id"]
                and (
                    (
                        session.get("profile_home") is None
                        and index["target_profile"] == server._current_profile_name()
                    )
                    or str(session.get("profile_home") or "").rstrip("/").endswith(
                        "/" + index["target_profile"]
                    )
                )
                and session.get("transport") is current_transport()
                and lease is not None
                and not getattr(lease, "released", False)
            ):
                receipt["runtime_session_id"] = runtime_id
    if set(receipt) != _RECEIPT_KEYS:
        raise CompanionSessionsError("creation receipt unavailable", 5066)
    return receipt


def _close_index(
    ledger, *, owner: str, request_id: str, index: Mapping[str, Any], outcome: str,
) -> dict[str, Any]:
    from tui_gateway.companion_creation import _close_creation_phase

    closed, _ = _close_creation_phase(
        ledger,
        owner=owner,
        client_request_id=request_id,
        snapshot=index,
        creator=_creator_fields(index),
        closed_outcome=outcome,
    )
    return closed


def _rollback_before_row(
    server, ledger, *, owner: str, request_id: str, index, lease,
    runtime_id: str | None = None, reserved=None,
) -> tuple[dict[str, Any], bool]:
    if runtime_id is not None:
        released = bool(
            reserved is not None
            and server._rollback_published_provisional_runtime(runtime_id, reserved)
        )
    else:
        released = server._rollback_creation_reservation(lease) is None
    if not released:
        return dict(index), False
    try:
        closed = _close_index(
            ledger, owner=owner, request_id=request_id, index=index, outcome="not_admitted"
        )
    except Exception:
        return dict(index), False
    return closed, released and closed["phase"] == "closed"


def _settle_prepared(server, target_db, ledger, *, owner: str, request_id: str,
                     index, claim, lease, runtime_id: str | None) -> tuple[dict[str, Any], bool]:
    from tui_gateway.companion_turns import settle_turn

    released = False
    try:
        if runtime_id is not None:
            session = server._sessions.get(runtime_id)
            released = bool(
                session is not None
                and server._settle_creation_for_refusal(session, claim, "not_admitted")
            )
        else:
            settle_turn(
                target_db,
                claim,
                outcome="not_admitted",
                final_tip_id=index["requested_id"],
                coordinator_index=index,
            )
            released = server._rollback_creation_reservation(lease) is None
        index = _close_index(
            ledger, owner=owner, request_id=request_id, index=index, outcome="turn_record"
        )
    except Exception:
        logger.warning(_CREATE_UNKNOWN)
        return dict(index), False
    return index, released


def _bind_provisional_creation_submission(
    server, reserved, session, *, owner_authorization: Any
):
    """Bind provisional submit only while the current owner lease is live."""
    from tui_gateway.companion_sessions import _require_owner

    _require_owner(owner_authorization)
    return server._bind_provisional_creation_submission(reserved, session)


def _create_session_in_workspace(
    server,
    params: Mapping[str, Any],
    sanitized: str,
    owner_authorization: Any,
    *,
    owner: str,
    backend: str,
    profile: str,
    digest: str,
    ledger,
    workspace: Mapping[str, Any],
    held_workspace,
) -> dict[str, Any]:
    from tui_gateway.companion_creation import (
        _advance_creation_phase,
        _creation_request_index,
        _snapshot_creation_creator,
    )
    from tui_gateway.companion_sessions import _require_owner, _source
    from tui_gateway.companion_projects import resolve_creation_workspace
    from tui_gateway.companion_turns import (
        bind_turn,
        new_operation_id,
        observe_created_session,
        prepare_created_session,
        reset_bound_turn,
    )

    stored_id = server._new_session_key()
    runtime_id = uuid.uuid4().hex[:8]
    operation_id = new_operation_id()
    creator = _snapshot_creation_creator()
    _require_owner(owner_authorization)
    index, inserted = _creation_request_index(
        ledger,
        owner=owner,
        client_request_id=params["client_request_id"],
        payload_digest=digest,
        backend=backend,
        profile=profile,
        stored_id=stored_id,
        project_id=params["project_id"],
        operation_id=operation_id,
        creator_pid=creator["creator_pid"],
        creator_started=creator["creator_started"],
        creator_token=creator["creator_token"],
        bound_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    )
    if not inserted:
        return _replay_receipt(server, params, owner_authorization)
    lease, refusal = server._claim_active_session_slot(
        stored_id,
        live_session_id=runtime_id,
        profile_home=workspace["profile_home"],
        config=workspace["config"],
        strict_reservation=True,
    )
    if lease is None or refusal is not None:
        try:
            index = _close_index(
                ledger,
                owner=owner,
                request_id=params["client_request_id"],
                index=index,
                outcome="not_admitted",
            )
            return _project_receipt(
                server,
                ledger=ledger,
                owner=owner,
                request_id=params["client_request_id"],
                index=index,
            )
        except Exception as exc:
            raise CompanionSessionsError(_CREATE_UNKNOWN, 5066) from exc

    claim = None
    runtime_published = False
    reserved = server.ReservedSessionCreate(
        runtime_session_id=runtime_id,
        stored_session_id=stored_id,
        target_profile=profile,
        target_profile_home=workspace["profile_home"],
        canonical_project_cwd=workspace["cwd"],
        operation_id=operation_id,
        creator_pid=creator["creator_pid"],
        creator_started_at=creator["creator_started"],
        creator_token=creator["creator_token"],
        creator_epoch=creator["creator_epoch"],
        lease=lease,
        workspace_none=workspace["workspace_none"],
    )
    with _source(server, profile, writable=True) as target_db:
        try:
            comparable = (
                "profile_home", "project_id", "cwd", "persisted_cwd", "git_repo_root",
                "workspace_none", "model", "model_config", "_identity",
            )
            held_value = {**held_workspace, "_identity": held_workspace.identity}
            if any(held_value[name] != workspace[name] for name in comparable):
                raise RuntimeError(_CREATE_FAILURE)
            _require_owner(owner_authorization)
            index, _ = _advance_creation_phase(
                ledger,
                owner=owner,
                client_request_id=params["client_request_id"],
                snapshot=index,
                creator=creator,
                next_phase="preparing",
            )
            # Publish the trusted empty runtime while it is fenced. No row, agent,
            # history, or prompt side effect exists before this exact handoff.
            private_response = server._invoke_reserved_session_create(reserved, rid=None)
            private_result = private_response.get("result") if isinstance(private_response, dict) else None
            if not isinstance(private_result, dict):
                raise RuntimeError(_CREATE_FAILURE)
            runtime_published = True
            claim = prepare_created_session(
                target_db,
                {
                    "session_id": stored_id,
                    "source": "companion",
                    "model": workspace["model"],
                    "model_config": workspace["model_config"],
                    "profile_name": profile,
                    "cwd": workspace["persisted_cwd"],
                    "git_repo_root": workspace["git_repo_root"],
                },
                operation_id,
                digest,
                (
                    creator["creator_pid"],
                    creator["creator_started"],
                    creator["creator_token"],
                ),
            )
            index, _ = _advance_creation_phase(
                ledger,
                owner=owner,
                client_request_id=params["client_request_id"],
                snapshot=index,
                creator=creator,
                next_phase="prepared",
            )
            _require_owner(owner_authorization)
            held_workspace.validate()
            current_workspace = resolve_creation_workspace(
                server, profile, params["project_id"]
            )
            if any(current_workspace[name] != workspace[name] for name in comparable):
                raise RuntimeError(_CREATE_FAILURE)
            _require_owner(owner_authorization)
            index, _ = _advance_creation_phase(
                ledger,
                owner=owner,
                client_request_id=params["client_request_id"],
                snapshot=index,
                creator=creator,
                next_phase="dispatching",
            )
            _require_owner(owner_authorization)
            token = bind_turn(claim)
            submit_token = None
            try:
                # Registered prompt.submit is the sole execution boundary. Both the
                # exact durable claim and process-private runtime authority must match.
                session = server._sessions.get(runtime_id)
                if session is None:
                    raise RuntimeError(_CREATE_FAILURE)
                submit_token = _bind_provisional_creation_submission(
                    server,
                    reserved,
                    session,
                    owner_authorization=owner_authorization,
                )
                _require_owner(owner_authorization)
                submit_response = server._methods["prompt.submit"](
                    None, {"session_id": runtime_id, "text": sanitized}
                )
            finally:
                if submit_token is not None:
                    server._reset_provisional_creation_submission(submit_token)
                reset_bound_turn(token)
            try:
                observation = observe_created_session(target_db, index)
            except Exception:
                observation = None
            may_close_to_turn_record = bool(
                observation is not None
                and observation.evidence_state == "exact"
                and observation.turn_state in _TURN_RECORD_COORDINATOR_STATES
                and (
                    observation.turn_state not in {"admitted", "running"}
                    or _exact_streaming_ack(submit_response, None)
                )
            )
            if may_close_to_turn_record:
                try:
                    index = _close_index(
                        ledger,
                        owner=owner,
                        request_id=params["client_request_id"],
                        index=index,
                        outcome="turn_record",
                    )
                except Exception:
                    logger.warning(_CREATE_UNKNOWN)
            receipt = _project_receipt(
                server,
                ledger=ledger,
                owner=owner,
                request_id=params["client_request_id"],
                index=index,
                target_db=target_db,
                runtime_id=runtime_id,
            )
            if not may_close_to_turn_record:
                receipt["operation_status"] = "recovery_required"
            return receipt
        except CompanionSessionsError:
            if index is None:
                server._rollback_creation_reservation(lease)
                raise
            if claim is None:
                index, settled = _rollback_before_row(
                    server,
                    ledger,
                    owner=owner,
                    request_id=params["client_request_id"],
                    index=index,
                    lease=lease,
                    runtime_id=runtime_id if runtime_published else None,
                    reserved=reserved,
                )
                if not settled:
                    raise CompanionSessionsError(_CREATE_UNKNOWN, 5066)
            else:
                index, settled = _settle_prepared(
                    server,
                    target_db,
                    ledger,
                    owner=owner,
                    request_id=params["client_request_id"],
                    index=index,
                    claim=claim,
                    lease=lease,
                    runtime_id=runtime_id if runtime_published else None,
                )
                if not settled:
                    receipt = _project_receipt(
                        server,
                        ledger=ledger,
                        owner=owner,
                        request_id=params["client_request_id"],
                        index=index,
                        target_db=target_db,
                    )
                    receipt["operation_status"] = "recovery_required"
                    return receipt
            return _project_receipt(
                server,
                ledger=ledger,
                owner=owner,
                request_id=params["client_request_id"],
                index=index,
                target_db=target_db,
            )
        except Exception:
            logger.warning(_CREATE_FAILURE)
            if index is None:
                if server._rollback_creation_reservation(lease) is not None:
                    raise CompanionSessionsError(_CREATE_UNKNOWN, 5066)
                raise CompanionSessionsError(_CREATE_FAILURE, 5006)
            if claim is None:
                index, settled = _rollback_before_row(
                    server,
                    ledger,
                    owner=owner,
                    request_id=params["client_request_id"],
                    index=index,
                    lease=lease,
                    runtime_id=runtime_id if runtime_published else None,
                    reserved=reserved,
                )
            else:
                index, settled = _settle_prepared(
                    server,
                    target_db,
                    ledger,
                    owner=owner,
                    request_id=params["client_request_id"],
                    index=index,
                    claim=claim,
                    lease=lease,
                    runtime_id=runtime_id if runtime_published else None,
                )
            receipt = _project_receipt(
                server,
                ledger=ledger,
                owner=owner,
                request_id=params["client_request_id"],
                index=index,
                target_db=target_db,
                runtime_id=runtime_id if runtime_published and settled else None,
            )
            if not settled:
                receipt["operation_status"] = "recovery_required"
            return receipt


def create_session(server, params: Any, *, owner_authorization: Any = None) -> dict[str, Any]:
    """Create and dispatch one ordinary Companion session through registered handlers."""
    from contextlib import ExitStack

    from tui_gateway.companion_creation import _creation_payload_digest
    from tui_gateway.companion_projects import (
        CompanionProjectsError,
        _backend_namespace,
        hold_creation_workspace,
    )
    from tui_gateway.companion_sessions import (
        _continuity_ledger,
        _require_owner,
        _source,
        _validate_profile,
    )

    params, sanitized = _validate_create_params(params)
    owner = _require_owner(owner_authorization)
    backend = _backend_namespace(server)
    if params["backend_namespace"] != backend:
        raise CompanionSessionsError("session backend unavailable", 4404)
    profile = _validate_profile(server, params["profile"])
    digest = _creation_payload_digest(
        backend, profile, params["project_id"], params["text"], sanitized
    )
    ledger = _continuity_ledger(server)
    existing = _existing_index(
        ledger,
        owner=owner,
        request_id=params["client_request_id"],
        digest=digest,
        backend=backend,
        profile=profile,
        project_id=params["project_id"],
    )
    if existing is not None:
        return _replay_receipt(server, params, owner_authorization)

    workspace_stack = ExitStack()
    try:
        held_workspace = workspace_stack.enter_context(
            hold_creation_workspace(server, profile, params["project_id"])
        )
        workspace = {**held_workspace, "_identity": held_workspace.identity}
        with _source(server, profile, writable=False):
            pass
    except CompanionProjectsError as exc:
        workspace_stack.close()
        raise CompanionSessionsError(str(exc), exc.code) from exc
    except BaseException:
        workspace_stack.close()
        raise

    with workspace_stack:
        _require_owner(owner_authorization)
        return _create_session_in_workspace(
            server,
            params,
            sanitized,
            owner_authorization,
            owner=owner,
            backend=backend,
            profile=profile,
            digest=digest,
            ledger=ledger,
            workspace=workspace,
            held_workspace=held_workspace,
        )
