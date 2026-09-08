"""Production bridge from approved Companion preparation to HOFFEE Kanban.

The WorkStore remains decision authority and Kanban remains execution authority.
This adapter has one narrow job: reconcile an approved, revision-bound handoff
through the scoped ``companion-intake`` endpoint, read the task back, and record
truthful tracker evidence. It grants no publication or spending authority.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
import re
import sys
from typing import Any, Callable, Protocol
import urllib.error
import urllib.parse
import urllib.request

from hermes_cli.companion_work import resolve_store
from hermes_cli.companion_work_store import WorkError, WorkStore


_INTAKE_URL_ENV = "HERMES_COMPANION_KANBAN_INTAKE_URL"
_INTAKE_SECRET_ENV = "HERMES_DASHBOARD_KANBAN_INTAKE_SECRET"
_TASK_ID_RE = re.compile(r"^t_[a-f0-9]{8,}$")
_TASK_KEYS = {
    "id", "title", "body", "status", "priority", "assignee", "tenant",
    "workspace_kind", "idempotency_key", "created_at", "completed_at", "result",
}
_KANBAN_STATUSES = {
    "triage", "todo", "scheduled", "ready", "running", "blocked", "review",
    "done", "archived",
}
_PENDING_STATUSES = {"triage", "todo", "scheduled", "ready"}
_ACTIVE_STATUSES = {"running", "review"}
_MAX_RESPONSE_BYTES = 1024 * 1024


class BridgeError(RuntimeError):
    """A bounded, secret-free adapter failure."""


def _nonempty(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _validate_task(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != _TASK_KEYS:
        raise BridgeError("invalid Kanban intake response")
    if (
        not _nonempty(value.get("id"))
        or not _TASK_ID_RE.fullmatch(value["id"])
        or not _nonempty(value.get("title"))
        or value.get("status") not in _KANBAN_STATUSES
        or type(value.get("priority")) is not int
        or value.get("assignee") != "hoffeecmo"
        or value.get("tenant") != "hoffee"
        or value.get("workspace_kind") != "scratch"
        or not _nonempty(value.get("idempotency_key"))
        or type(value.get("created_at")) is not int
        or (value.get("body") is not None and not isinstance(value["body"], str))
        or (value.get("completed_at") is not None and type(value["completed_at"]) is not int)
        or (value.get("result") is not None and not isinstance(value["result"], str))
    ):
        raise BridgeError("invalid Kanban intake response")
    return dict(value)


class KanbanIntakeClient:
    """Bounded client for the token-scoped HOFFEE create/get endpoint."""

    def __init__(
        self,
        url: str,
        secret: str,
        *,
        timeout: float = 15.0,
        opener: Callable[..., Any] = urllib.request.urlopen,
    ) -> None:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password or parsed.fragment:
            raise BridgeError("Kanban intake URL must be an absolute HTTP(S) URL without credentials or fragment")
        if not _nonempty(secret):
            raise BridgeError("Kanban intake secret is required")
        if timeout <= 0 or timeout > 60:
            raise BridgeError("Kanban intake timeout must be between 0 and 60 seconds")
        self.url = url
        self._secret = secret
        self.timeout = timeout
        self._opener = opener

    @classmethod
    def from_environment(cls) -> "KanbanIntakeClient":
        return cls(os.environ.get(_INTAKE_URL_ENV, ""), os.environ.get(_INTAKE_SECRET_ENV, ""))

    def _post(self, envelope: dict[str, Any], operation: str) -> dict[str, Any]:
        request = urllib.request.Request(
            self.url,
            data=json.dumps(envelope, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {self._secret}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "hermes-companion-kanban-bridge/1",
            },
        )
        try:
            with self._opener(request, timeout=self.timeout) as response:
                raw = response.read(_MAX_RESPONSE_BYTES + 1)
                if len(raw) > _MAX_RESPONSE_BYTES:
                    raise BridgeError("Kanban intake response exceeds size limit")
                body = json.loads(raw.decode("utf-8"))
        except BridgeError:
            raise
        except (OSError, urllib.error.URLError, UnicodeError, json.JSONDecodeError) as exc:
            raise BridgeError(f"Kanban intake {operation} failed ({type(exc).__name__})") from exc
        if not isinstance(body, dict) or set(body) != {"ok", "operation", "task"}:
            raise BridgeError("invalid Kanban intake response")
        if body.get("ok") is not True or body.get("operation") != operation:
            raise BridgeError("invalid Kanban intake response")
        return _validate_task(body.get("task"))

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post({"operation": "create", "payload": payload}, "create")

    def get(self, task_id: str) -> dict[str, Any]:
        if not isinstance(task_id, str) or not _TASK_ID_RE.fullmatch(task_id):
            raise BridgeError("invalid Kanban task id")
        return self._post({"operation": "get", "task_id": task_id}, "get")


class IntakeClient(Protocol):
    def create(self, payload: dict[str, Any]) -> dict[str, Any]: ...

    def get(self, task_id: str) -> dict[str, Any]: ...


def _execution_ref(task_id: str) -> str:
    return f"kanban:hoffee:{task_id}"


def _task_id(execution_ref: str) -> str:
    prefix = "kanban:hoffee:"
    candidate = execution_ref[len(prefix):] if execution_ref.startswith(prefix) else ""
    if not _TASK_ID_RE.fullmatch(candidate):
        raise BridgeError("linked execution_ref is not a scoped HOFFEE Kanban task")
    return candidate


def _body(card: dict[str, Any]) -> str:
    evidence = "\n".join(f"- {entry}" for entry in card["evidence"]) or "- No supporting evidence supplied"
    return (
        f"{card['brief']}\n\n"
        f"Next action\n{card['next_action']}\n\n"
        f"Evidence\n{evidence}\n\n"
        f"Companion handoff: {card['handoff_key']}\n"
        "Scope: preparation only. Publication, live store changes, purchases, and spend are not authorized."
    )


def _same_evidence(current: Any, proposed: dict[str, Any]) -> bool:
    if not isinstance(current, dict):
        return False
    fields = {"state", "execution_ref", "evidence", "blocker", "result_evidence"}
    return all(current.get(field) == proposed.get(field) for field in fields)


def _status_key(card: dict[str, Any], evidence: dict[str, Any]) -> str:
    """Bounded stable key; tracker text may be much larger than WorkStore's key cap."""
    fingerprint = hashlib.sha256(
        json.dumps(evidence, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:24]
    return f"kanban-status:{card['id']}:{card['revision']}:{card['version']}:{fingerprint}"


class CompanionKanbanBridge:
    def __init__(
        self,
        store: WorkStore,
        intake: IntakeClient,
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.store = store
        self.intake = intake
        self.clock = clock or (lambda: datetime.now(timezone.utc))

    def _observed_at(self) -> str:
        value = self.clock()
        if value.tzinfo is None:
            raise BridgeError("bridge clock must be timezone-aware")
        return value.astimezone(timezone.utc).isoformat()

    @staticmethod
    def _create_payload(card: dict[str, Any]) -> dict[str, Any]:
        return {
            "title": card["title"],
            "body": _body(card),
            "priority": 3,
            "idempotency_key": card["handoff_key"],
            "triage": True,
            "goal_mode": False,
            "assignee": "hoffeecmo",
            "tenant": "hoffee",
            "workspace_kind": "scratch",
        }

    def _record_unavailable(self, card: dict[str, Any], message: str) -> bool:
        evidence: dict[str, Any] = {
            "state": "status_unavailable",
            "observed_at": self._observed_at(),
            "evidence": [message],
        }
        link = card.get("execution_link")
        if link:
            evidence["execution_ref"] = link["execution_ref"]
        if _same_evidence(card.get("tracker_evidence"), evidence):
            return False
        self.store.preparation_status_update(
            card["id"], card["version"], card["revision"], card["handoff_key"],
            evidence, _status_key(card, evidence),
        )
        return True

    def _ensure_link(
        self, card: dict[str, Any],
    ) -> tuple[dict[str, Any], bool, dict[str, Any] | None]:
        if card.get("execution_link"):
            return card, False, None
        task = self.intake.create(self._create_payload(card))
        if task["idempotency_key"] != card["handoff_key"]:
            raise BridgeError("Kanban read-back idempotency key does not match handoff")
        # A create response is not enough: perform the specified authoritative read-back.
        task = self.intake.get(task["id"])
        if task["idempotency_key"] != card["handoff_key"]:
            raise BridgeError("Kanban read-back idempotency key does not match handoff")
        result = self.store.preparation_ack(
            card["id"], card["version"], card["revision"], card["handoff_key"],
            _execution_ref(task["id"]), f"kanban-link:{card['handoff_key']}",
        )
        return result["item"], True, task

    def _tracker_evidence(self, task: dict[str, Any]) -> dict[str, Any] | None:
        ref = _execution_ref(task["id"])
        status = task["status"]
        common = {
            "execution_ref": ref,
            "observed_at": self._observed_at(),
            "evidence": [f"{ref}:status={status}"],
        }
        if status in _PENDING_STATUSES:
            return dict(common, state="linked_awaiting_triage")
        if status in _ACTIVE_STATUSES:
            return dict(common, state="preparing")
        if status == "blocked":
            blocker = task.get("result")
            blocker_text = str(blocker).strip()[:20000] if _nonempty(blocker) else "Kanban task is blocked"
            return dict(common, state="blocked", blocker=blocker_text)
        if status == "done":
            result = task.get("result")
            if not _nonempty(result) or len(str(result).strip()) > 4000:
                return dict(
                    common,
                    state="status_unavailable",
                    evidence=[f"{ref}:status=done but bounded verified result evidence is missing"],
                )
            return dict(common, state="prepared", result_evidence=[str(result).strip()])
        return dict(common, state="status_unavailable", evidence=[f"{ref}:status={status} is not an executable preparation state"])

    def _sync_status(
        self, card: dict[str, Any], task: dict[str, Any] | None = None,
    ) -> tuple[bool, bool]:
        if task is None:
            task = self.intake.get(_task_id(card["execution_link"]["execution_ref"]))
        if _execution_ref(task["id"]) != card["execution_link"]["execution_ref"]:
            raise BridgeError("Kanban read-back task does not match linked handoff")
        if task["idempotency_key"] != card["handoff_key"]:
            raise BridgeError("Kanban read-back idempotency key does not match handoff")
        evidence = self._tracker_evidence(task)
        if evidence is None:
            return False, False
        if _same_evidence(card.get("tracker_evidence"), evidence):
            if evidence["state"] != "prepared":
                return False, False
            # The status write and completion are separate durable transactions.
            # A restart must finish the latter without duplicating tracker history.
            self.store.complete(
                card["id"], card["version"],
                f"Verified HOFFEE Kanban completion: {card['execution_link']['execution_ref']}",
            )
            return False, True
        if (card.get("tracker_evidence") is None
                and card.get("preparation_status") == evidence["state"]):
            return False, False
        updated = self.store.preparation_status_update(
            card["id"], card["version"], card["revision"], card["handoff_key"],
            evidence,
            _status_key(card, evidence),
        )["item"]
        if evidence["state"] != "prepared":
            return True, False
        self.store.complete(
            updated["id"], updated["version"],
            f"Verified HOFFEE Kanban completion: {updated['execution_link']['execution_ref']}",
        )
        return True, True

    def reconcile_once(self) -> dict[str, int]:
        counts = {"examined": 0, "linked": 0, "updated": 0, "completed": 0, "errors": 0}
        for original in self.store.list(preparation=True)["items"]:
            counts["examined"] += 1
            card = original
            try:
                card, linked, recovered_task = self._ensure_link(card)
                counts["linked"] += int(linked)
                # Reuse the mandatory create read-back so a task recovered after
                # restart projects its current authoritative state in this tick.
                updated, completed = self._sync_status(card, recovered_task)
                counts["updated"] += int(updated)
                counts["completed"] += int(completed)
            except (BridgeError, WorkError) as exc:
                counts["errors"] += 1
                # Refresh canonical Work state before recording an uncertainty; a competing
                # bridge may have linked/completed it after this tick's initial list.
                try:
                    canonical = self.store.get(original["id"])["item"]
                    if (isinstance(exc, BridgeError) and canonical["state"] == "in_progress"
                            and canonical.get("approval")
                            and not (not original.get("execution_link") and canonical.get("execution_link"))):
                        message = (
                            "Kanban handoff requires reconciliation after an unavailable create/read-back"
                            if not canonical.get("execution_link")
                            else f"Kanban status read-back unavailable ({type(exc).__name__})"
                        )
                        counts["updated"] += int(self._record_unavailable(canonical, message))
                except (BridgeError, WorkError):
                    pass
        return counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Reconcile approved Companion preparation with scoped HOFFEE Kanban intake")
    parser.add_argument("--profile", default="hoffeecmo", help="WorkStore profile (default: hoffeecmo)")
    args = parser.parse_args(argv)
    try:
        # Validate remote authority before opening the local store. A partially
        # configured scheduled invocation must fail closed without touching work.
        intake = KanbanIntakeClient.from_environment()
        result = CompanionKanbanBridge(resolve_store(args.profile), intake).reconcile_once()
        print(json.dumps(result, sort_keys=True))
        return 1 if result["errors"] else 0
    except (BridgeError, WorkError) as exc:
        print(json.dumps({"error": {"message": str(exc)}}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
