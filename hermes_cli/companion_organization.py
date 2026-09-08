"""Profile-local organization metadata and deterministic priority policy.

This registry references source projects, sessions, cards, tasks, and artefacts;
it never becomes an authority for their names, membership, lifecycle, content,
or permissions.  Source identity is always the configured backend namespace,
exact profile, and original source identifier -- never a title or path.
"""
from __future__ import annotations

import base64
from contextlib import contextmanager
from dataclasses import dataclass, fields, replace
from datetime import datetime, timezone
from enum import Enum
import json
import os
from pathlib import Path
import sqlite3
import stat
from typing import Any, Callable, Iterable, Iterator, Mapping, Sequence, TypeVar

from hermes_constants import get_hermes_home

POLICY_VERSION = "policy-v1"
CANONICAL_ID_VERSION = "v1"
SCHEMA_VERSION = 2


class OrganizationError(ValueError):
    """Invalid organization data or a rejected optimistic write."""


def canonical_json(value: Any) -> str:
    """Encode portable JSON deterministically and reject NaN/infinity."""
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise OrganizationError(f"value is not deterministic JSON: {exc}") from None


def _text(value: Any, name: str, maximum: int = 20_000, *, exact: bool = False) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise OrganizationError(f"{name} must be nonempty text (max {maximum})")
    return value if exact else value.strip()


def _optional_text(
    value: Any, name: str, maximum: int = 20_000, *, exact: bool = False
) -> str | None:
    if value is None:
        return None
    return _text(value, name, maximum, exact=exact)


def _timestamp(value: Any, name: str) -> str:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError
    except (AttributeError, TypeError, ValueError):
        raise OrganizationError(f"{name} must be ISO-8601 with timezone") from None
    return parsed.astimezone(timezone.utc).isoformat()


def _tuple_text(values: Any, name: str, maximum_items: int = 1_000) -> tuple[str, ...]:
    if not isinstance(values, (tuple, list)) or len(values) > maximum_items:
        raise OrganizationError(f"{name} must be an array (max {maximum_items})")
    return tuple(_text(value, name, 4_000) for value in values)


def _canonical_id(kind: str, parts: Mapping[str, Any]) -> str:
    raw = canonical_json(parts).encode("utf-8")
    token = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    # Identity must remain stable when the independently versioned ranking
    # policy changes.
    return f"urn:hermes-org:{CANONICAL_ID_VERSION}:{kind}:{token}"


def _enum_value(value: Any, enum_type: type[Enum], name: str):
    if isinstance(value, enum_type):
        return value
    try:
        return enum_type(value)
    except (TypeError, ValueError):
        raise OrganizationError(f"invalid {name}") from None


class _Ranked(str, Enum):
    @property
    def rank(self) -> int:
        return self._order().index(self.value)

    @classmethod
    def _order(cls) -> tuple[str, ...]:
        raise NotImplementedError


class Benefit(_Ranked):
    UNKNOWN = "unknown"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"

    @classmethod
    def _order(cls):
        return ("unknown", "low", "medium", "high")


class Confidence(_Ranked):
    UNKNOWN = "unknown"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"

    @classmethod
    def _order(cls):
        return ("unknown", "low", "medium", "high")


class CostOfDelay(_Ranked):
    UNKNOWN = "unknown"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"

    @classmethod
    def _order(cls):
        return ("unknown", "low", "medium", "high", "critical")


class DependencyUnblocking(_Ranked):
    UNKNOWN = "unknown"
    NONE = "none"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"

    @classmethod
    def _order(cls):
        return ("unknown", "none", "low", "medium", "high")


class Burden(_Ranked):
    UNKNOWN = "unknown"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"

    @classmethod
    def _order(cls):
        # Lower burden is preferable; policy keys invert this rank.
        return ("unknown", "low", "medium", "high")


class Reversibility(_Ranked):
    UNKNOWN = "unknown"
    IRREVERSIBLE = "irreversible"
    DIFFICULT = "difficult"
    REVERSIBLE = "reversible"
    SAFE = "safe"

    @classmethod
    def _order(cls):
        return ("unknown", "irreversible", "difficult", "reversible", "safe")


class WorkStatus(str, Enum):
    ACTIONABLE = "actionable"
    DUE = "due"
    BLOCKED = "blocked"
    SNOOZED = "snoozed"
    DECLINED = "declined"
    COMPLETED = "completed"


class Eligibility(str, Enum):
    URGENT_PROTECTION = "urgent_protection"
    ASSESSED = "assessed"
    POTENTIAL_VALIDATION = "potential_validation"
    NEEDS_ASSESSMENT = "needs_assessment"
    INELIGIBLE = "ineligible"


@dataclass(frozen=True, kw_only=True)
class _MutableMetadata:
    version: int = 0
    created_at: str | None = None
    created_by: str | None = None
    updated_at: str | None = None
    updated_by: str | None = None


@dataclass(frozen=True)
class SourceNamespace:
    backend_id: str
    profile: str

    def __post_init__(self):
        object.__setattr__(self, "backend_id", _text(self.backend_id, "backend_id", 500, exact=True))
        object.__setattr__(self, "profile", _text(self.profile, "profile", 100, exact=True))

    @property
    def canonical_id(self) -> str:
        return _canonical_id("namespace", {"backend_id": self.backend_id, "profile": self.profile})

    def to_dict(self) -> dict[str, Any]:
        return {"backend_id": self.backend_id, "profile": self.profile}

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "SourceNamespace":
        return cls(value["backend_id"], value["profile"])


@dataclass(frozen=True)
class SourceProjectRef(_MutableMetadata):
    namespace: SourceNamespace
    source_id: str
    kind: str

    def __post_init__(self):
        _validate_mutable(self)
        if not isinstance(self.namespace, SourceNamespace):
            raise OrganizationError("namespace must be a SourceNamespace")
        object.__setattr__(self, "source_id", _text(self.source_id, "source_id", 500, exact=True))
        object.__setattr__(self, "kind", _text(self.kind, "kind", 100, exact=True))

    @property
    def canonical_id(self) -> str:
        return _canonical_id(
            "source-project",
            {"namespace": self.namespace.to_dict(), "source_id": self.source_id, "kind": self.kind},
        )

    def to_dict(self) -> dict[str, Any]:
        return _mutable_dict(self, {"namespace": self.namespace.to_dict()})

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "SourceProjectRef":
        return cls(
            SourceNamespace.from_dict(value["namespace"]),
            value["source_id"],
            value["kind"],
            version=value.get("version", 0),
            created_at=value.get("created_at"),
            created_by=value.get("created_by"),
            updated_at=value.get("updated_at"),
            updated_by=value.get("updated_by"),
        )


@dataclass(frozen=True)
class SourceSessionRef(_MutableMetadata):
    namespace: SourceNamespace
    persisted_session_id: str
    lineage_root_id: str
    resolved_tip_id: str | None = None

    def __post_init__(self):
        _validate_mutable(self)
        if not isinstance(self.namespace, SourceNamespace):
            raise OrganizationError("namespace must be a SourceNamespace")
        object.__setattr__(self, "persisted_session_id", _text(self.persisted_session_id, "persisted_session_id", 500, exact=True))
        object.__setattr__(self, "lineage_root_id", _text(self.lineage_root_id, "lineage_root_id", 500, exact=True))
        object.__setattr__(self, "resolved_tip_id", _optional_text(self.resolved_tip_id, "resolved_tip_id", 500, exact=True))

    @property
    def canonical_id(self) -> str:
        # The current tip is a refreshable projection, not logical identity.
        return _canonical_id(
            "source-session",
            {
                "namespace": self.namespace.to_dict(),
                "persisted_session_id": self.persisted_session_id,
                "lineage_root_id": self.lineage_root_id,
            },
        )

    def to_dict(self) -> dict[str, Any]:
        return _mutable_dict(self, {"namespace": self.namespace.to_dict()})

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "SourceSessionRef":
        return cls(
            SourceNamespace.from_dict(value["namespace"]),
            value["persisted_session_id"],
            value["lineage_root_id"],
            value.get("resolved_tip_id"),
            version=value.get("version", 0),
            created_at=value.get("created_at"),
            created_by=value.get("created_by"),
            updated_at=value.get("updated_at"),
            updated_by=value.get("updated_by"),
        )

@dataclass(frozen=True)
class Capture:
    id: str
    source_session: SourceSessionRef | None
    title_at_capture: str
    captured_at: str
    verified_deep_link: str | None = None
    created_by: str | None = None

    def __post_init__(self):
        object.__setattr__(self, "id", _text(self.id, "capture id", 200))
        if self.source_session is not None and not isinstance(self.source_session, SourceSessionRef):
            raise OrganizationError("source_session must be a SourceSessionRef")
        object.__setattr__(self, "title_at_capture", _text(self.title_at_capture, "title_at_capture", 1_000, exact=True))
        object.__setattr__(self, "captured_at", _timestamp(self.captured_at, "captured_at"))
        object.__setattr__(self, "verified_deep_link", _optional_text(self.verified_deep_link, "verified_deep_link", 4_000))
        object.__setattr__(self, "created_by", _optional_text(self.created_by, "created_by", 500))

    @property
    def canonical_id(self) -> str:
        return _canonical_id("capture", {"id": self.id})

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "source_session": self.source_session.to_dict() if self.source_session else None,
            "title_at_capture": self.title_at_capture,
            "captured_at": self.captured_at,
            "verified_deep_link": self.verified_deep_link,
            "created_by": self.created_by,
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "Capture":
        source = value.get("source_session")
        return cls(
            value["id"], SourceSessionRef.from_dict(source) if source else None,
            value["title_at_capture"], value["captured_at"], value.get("verified_deep_link"),
            value.get("created_by"),
        )


@dataclass(frozen=True)
class Topic(_MutableMetadata):
    id: str = ""
    collection: str = ""
    name: str = ""
    objective: str = ""
    primary_project: SourceProjectRef | None = None
    lifecycle: str = "active"
    primary_business_project_id: str | None = None

    def __post_init__(self):
        _validate_mutable(self)
        object.__setattr__(self, "id", _text(self.id, "topic id", 200))
        object.__setattr__(self, "collection", _text(self.collection, "collection", 200))
        object.__setattr__(self, "name", _text(self.name, "name", 500))
        object.__setattr__(self, "objective", _text(self.objective, "objective", 4_000))
        if self.primary_project is not None and not isinstance(self.primary_project, SourceProjectRef):
            raise OrganizationError("primary_project must be a SourceProjectRef")
        object.__setattr__(
            self,
            "primary_business_project_id",
            _optional_text(
                self.primary_business_project_id,
                "primary_business_project_id",
                200,
            ),
        )
        if self.lifecycle not in {"active", "completed", "archived"}:
            raise OrganizationError("invalid topic lifecycle")

    @property
    def canonical_id(self):
        return _canonical_id("topic", {"id": self.id})

    def to_dict(self):
        return _mutable_dict(self, {"primary_project": self.primary_project.to_dict() if self.primary_project else None})

    @classmethod
    def from_dict(cls, value):
        data = dict(value)
        project = data.get("primary_project")
        data["primary_project"] = SourceProjectRef.from_dict(project) if project else None
        return cls(**data)


@dataclass(frozen=True)
class BusinessProject(_MutableMetadata):
    id: str = ""
    collection: str = ""
    name: str = ""
    objective: str = ""
    lifecycle: str = "active"

    def __post_init__(self):
        _validate_mutable(self)
        object.__setattr__(self, "id", _text(self.id, "business project id", 200))
        object.__setattr__(self, "collection", _text(self.collection, "collection", 200))
        object.__setattr__(self, "name", _text(self.name, "name", 500))
        object.__setattr__(self, "objective", _text(self.objective, "objective", 4_000))
        if self.lifecycle not in {"active", "completed", "archived"}:
            raise OrganizationError("invalid business project lifecycle")

    @property
    def canonical_id(self):
        return _canonical_id("business-project", {"id": self.id})

    def to_dict(self):
        return _mutable_dict(self)

    @classmethod
    def from_dict(cls, value):
        return cls(**value)


@dataclass(frozen=True)
class WorkBinding(_MutableMetadata):
    id: str = ""
    source_namespace: SourceNamespace | None = None
    work_kind: str = ""
    source_work_id: str = ""
    primary_topic_id: str | None = None
    primary_session: SourceSessionRef | None = None
    related_sessions: tuple[SourceSessionRef, ...] = ()
    related_topic_ids: tuple[str, ...] = ()
    source_projects: tuple[SourceProjectRef, ...] = ()
    attributed_by: str = ""
    primary_business_project_id: str | None = None
    related_business_project_ids: tuple[str, ...] = ()

    def __post_init__(self):
        _validate_mutable(self)
        object.__setattr__(self, "id", _text(self.id, "binding id", 200))
        if not isinstance(self.source_namespace, SourceNamespace):
            raise OrganizationError("source_namespace must be a SourceNamespace")
        object.__setattr__(self, "work_kind", _text(self.work_kind, "work_kind", 100, exact=True))
        object.__setattr__(self, "source_work_id", _text(self.source_work_id, "source_work_id", 500, exact=True))
        object.__setattr__(self, "primary_topic_id", _optional_text(self.primary_topic_id, "primary_topic_id", 200))
        if self.primary_session is not None and not isinstance(self.primary_session, SourceSessionRef):
            raise OrganizationError("primary_session must be a SourceSessionRef")
        sessions = tuple(self.related_sessions)
        projects = tuple(self.source_projects)
        if any(not isinstance(value, SourceSessionRef) for value in sessions):
            raise OrganizationError("related_sessions must contain SourceSessionRef values")
        if any(not isinstance(value, SourceProjectRef) for value in projects):
            raise OrganizationError("source_projects must contain SourceProjectRef values")
        object.__setattr__(self, "related_sessions", _dedupe_refs(sessions))
        object.__setattr__(self, "source_projects", _dedupe_refs(projects))
        object.__setattr__(self, "related_topic_ids", tuple(sorted(set(_tuple_text(self.related_topic_ids, "related_topic_ids")))))
        object.__setattr__(self, "attributed_by", _text(self.attributed_by, "attributed_by", 500))
        object.__setattr__(
            self,
            "primary_business_project_id",
            _optional_text(
                self.primary_business_project_id,
                "primary_business_project_id",
                200,
            ),
        )
        object.__setattr__(
            self,
            "related_business_project_ids",
            tuple(
                sorted(
                    set(
                        _tuple_text(
                            self.related_business_project_ids,
                            "related_business_project_ids",
                        )
                    )
                )
            ),
        )

    @property
    def canonical_id(self):
        return _canonical_id(
            "work-binding",
            {
                "namespace": self.source_namespace.to_dict(),
                "work_kind": self.work_kind,
                "source_work_id": self.source_work_id,
            },
        )

    def to_dict(self):
        return _mutable_dict(self, {
            "source_namespace": self.source_namespace.to_dict(),
            "primary_session": self.primary_session.to_dict() if self.primary_session else None,
            "related_sessions": [value.to_dict() for value in self.related_sessions],
            "related_topic_ids": list(self.related_topic_ids),
            "source_projects": [value.to_dict() for value in self.source_projects],
            "related_business_project_ids": list(self.related_business_project_ids),
        })

    @classmethod
    def from_dict(cls, value):
        data = dict(value)
        data["source_namespace"] = SourceNamespace.from_dict(data["source_namespace"])
        data["primary_session"] = SourceSessionRef.from_dict(data["primary_session"]) if data.get("primary_session") else None
        data["related_sessions"] = tuple(SourceSessionRef.from_dict(item) for item in data.get("related_sessions", ()))
        data["related_topic_ids"] = tuple(data.get("related_topic_ids", ()))
        data["source_projects"] = tuple(SourceProjectRef.from_dict(item) for item in data.get("source_projects", ()))
        data["related_business_project_ids"] = tuple(
            data.get("related_business_project_ids", ())
        )
        return cls(**data)


@dataclass(frozen=True)
class OutcomeAssessment(_MutableMetadata):
    id: str = ""
    outcome_id: str = ""
    action_id: str = ""
    objective: str = ""
    time_horizon: str = ""
    benefit: Benefit = Benefit.UNKNOWN
    confidence: Confidence = Confidence.UNKNOWN
    cost_of_delay: CostOfDelay = CostOfDelay.UNKNOWN
    dependency_unblocking: DependencyUnblocking = DependencyUnblocking.UNKNOWN
    burden: Burden = Burden.UNKNOWN
    reversibility: Reversibility = Reversibility.UNKNOWN
    evidence: tuple[str, ...] = ()
    author: str = ""
    assessed_at: str = ""
    policy_version: str = POLICY_VERSION
    next_action_refs: tuple[str, ...] = ()
    potential: bool = False

    def __post_init__(self):
        _validate_mutable(self)
        for name in ("id", "outcome_id", "action_id"):
            object.__setattr__(self, name, _text(getattr(self, name), name, 500))
        object.__setattr__(self, "objective", _text(self.objective, "objective", 4_000))
        object.__setattr__(self, "time_horizon", _text(self.time_horizon, "time_horizon", 1_000))
        for name, kind in (
            ("benefit", Benefit), ("confidence", Confidence), ("cost_of_delay", CostOfDelay),
            ("dependency_unblocking", DependencyUnblocking), ("burden", Burden),
            ("reversibility", Reversibility),
        ):
            object.__setattr__(self, name, _enum_value(getattr(self, name), kind, name))
        object.__setattr__(self, "evidence", _tuple_text(self.evidence, "evidence"))
        object.__setattr__(self, "author", _text(self.author, "author", 500))
        object.__setattr__(self, "assessed_at", _timestamp(self.assessed_at, "assessed_at"))
        if self.policy_version != POLICY_VERSION:
            raise OrganizationError(f"policy_version must be {POLICY_VERSION}")
        object.__setattr__(self, "next_action_refs", tuple(sorted(set(_tuple_text(self.next_action_refs, "next_action_refs")))))
        if type(self.potential) is not bool:
            raise OrganizationError("potential must be boolean")
        requires_validation = self.potential or (
            self.benefit is Benefit.HIGH
            and self.confidence is Confidence.LOW
        )
        if requires_validation and not self.next_action_refs:
            raise OrganizationError("potential assessments require a bounded validation next action")

    @property
    def canonical_id(self):
        # The intended outcome owns the benefit claim.  Action splitting must
        # not create multiple independently rankable assessments for it.
        return _canonical_id("outcome-assessment", {"outcome_id": self.outcome_id})

    def to_dict(self):
        return _mutable_dict(self, {
            "benefit": self.benefit.value,
            "confidence": self.confidence.value,
            "cost_of_delay": self.cost_of_delay.value,
            "dependency_unblocking": self.dependency_unblocking.value,
            "burden": self.burden.value,
            "reversibility": self.reversibility.value,
            "evidence": list(self.evidence),
            "next_action_refs": list(self.next_action_refs),
        })

    @classmethod
    def from_dict(cls, value):
        data = dict(value)
        data["evidence"] = tuple(data.get("evidence", ()))
        data["next_action_refs"] = tuple(data.get("next_action_refs", ()))
        return cls(**data)


@dataclass(frozen=True)
class PriorityOverride(_MutableMetadata):
    id: str = ""
    target_id: str = ""
    mode: str = ""
    label: str = ""
    actor: str = ""
    reason: str = ""
    expires_at: str | None = None
    review_id: str | None = None
    review_at: str | None = None

    def __post_init__(self):
        _validate_mutable(self)
        for name, maximum in (("id", 200), ("target_id", 1_000), ("label", 500), ("actor", 500), ("reason", 4_000)):
            object.__setattr__(self, name, _text(getattr(self, name), name, maximum))
        if self.mode not in {"pin_review", "set_priority"}:
            raise OrganizationError("invalid priority override mode")
        object.__setattr__(self, "expires_at", _timestamp(self.expires_at, "expires_at") if self.expires_at else None)
        object.__setattr__(self, "review_at", _timestamp(self.review_at, "review_at") if self.review_at else None)
        object.__setattr__(self, "review_id", _optional_text(self.review_id, "review_id", 500))
        if self.mode == "pin_review" and not (self.review_id and self.review_at):
            raise OrganizationError("pin_review overrides require review_id scope and review_at expiry")
        if self.mode == "set_priority" and not (self.expires_at or self.review_at):
            raise OrganizationError("set_priority overrides require expiry metadata")

    @property
    def canonical_id(self):
        return _canonical_id("priority-override", {"id": self.id})

    def active_at(self, now: datetime, *, review_id: str | None = None) -> bool:
        if not isinstance(now, datetime) or now.tzinfo is None:
            raise OrganizationError("now must be a timezone-aware datetime")
        now = now.astimezone(timezone.utc)
        if self.expires_at and _as_datetime(self.expires_at) <= now:
            return False
        if self.review_at and _as_datetime(self.review_at) <= now:
            return False
        if self.mode == "pin_review" and self.review_id != review_id:
            return False
        return True

    def to_dict(self):
        return _mutable_dict(self)

    @classmethod
    def from_dict(cls, value):
        return cls(**value)


def _validate_mutable(value: _MutableMetadata) -> None:
    if type(value.version) is not int or value.version < 0:
        raise OrganizationError("version must be a non-negative integer")
    for name in ("created_at", "updated_at"):
        current = getattr(value, name)
        if current is not None:
            object.__setattr__(value, name, _timestamp(current, name))
    for name in ("created_by", "updated_by"):
        object.__setattr__(value, name, _optional_text(getattr(value, name), name, 500))


def _mutable_dict(value: _MutableMetadata, overrides: Mapping[str, Any] | None = None) -> dict[str, Any]:
    result = {field.name: getattr(value, field.name) for field in fields(value)}
    if overrides:
        result.update(overrides)
    return result


def _dedupe_refs(values: Sequence[Any]) -> tuple[Any, ...]:
    unique = _dedupe_canonical(values)
    return tuple(unique[key] for key in sorted(unique))


def _dedupe_canonical(values: Iterable[Any]) -> dict[str, Any]:
    unique: dict[str, Any] = {}
    for value in values:
        canonical_id = value.canonical_id
        existing = unique.get(canonical_id)
        if existing is not None and existing != value:
            raise OrganizationError(f"conflicting duplicate canonical_id: {canonical_id}")
        unique[canonical_id] = value
    return unique


def _as_datetime(value: str) -> datetime:
    return datetime.fromisoformat(value).astimezone(timezone.utc)


@dataclass(frozen=True)
class PriorityCandidate:
    canonical_id: str
    group_id: str
    status: WorkStatus
    assessment: OutcomeAssessment | None = None
    urgent_verified: bool = False
    override: PriorityOverride | None = None
    source_links: tuple[str, ...] = ()

    def __post_init__(self):
        object.__setattr__(self, "canonical_id", _text(self.canonical_id, "canonical_id", 2_000))
        object.__setattr__(self, "group_id", _text(self.group_id, "group_id", 2_000))
        object.__setattr__(self, "status", _enum_value(self.status, WorkStatus, "status"))
        if self.assessment is not None and not isinstance(self.assessment, OutcomeAssessment):
            raise OrganizationError("assessment must be an OutcomeAssessment")
        if self.assessment is not None and self.assessment.action_id != self.canonical_id:
            raise OrganizationError("assessment action_id must match candidate canonical_id")
        if type(self.urgent_verified) is not bool:
            raise OrganizationError("urgent_verified must be boolean")
        if self.override is not None:
            if not isinstance(self.override, PriorityOverride) or self.override.target_id != self.canonical_id:
                raise OrganizationError("override must target this candidate")
        object.__setattr__(self, "source_links", tuple(sorted(set(_tuple_text(self.source_links, "source_links")))))


@dataclass(frozen=True)
class RankingExplanation:
    canonical_id: str
    eligibility: Eligibility
    why_here: str
    next_step: str
    trade_off: str
    assessed_at: str | None
    evidence: tuple[str, ...]


@dataclass(frozen=True)
class RankedPartitions:
    urgent_protection: tuple[PriorityCandidate, ...]
    assessed: tuple[PriorityCandidate, ...]
    potential_validation: tuple[PriorityCandidate, ...]
    needs_assessment: tuple[PriorityCandidate, ...]
    ineligible: tuple[PriorityCandidate, ...]
    explanations: tuple[RankingExplanation, ...]


@dataclass(frozen=True)
class RankedGroup:
    group_id: str
    highest_action: PriorityCandidate
    eligibility: Eligibility
    eligible_action_count: int
    explanation: RankingExplanation


_INELIGIBLE = {WorkStatus.SNOOZED, WorkStatus.DECLINED, WorkStatus.COMPLETED, WorkStatus.BLOCKED}


def _eligibility(item: PriorityCandidate) -> Eligibility:
    if item.urgent_verified:
        return Eligibility.URGENT_PROTECTION
    if item.status in _INELIGIBLE:
        return Eligibility.INELIGIBLE
    assessment = item.assessment
    if assessment is None:
        return Eligibility.NEEDS_ASSESSMENT
    dimensions = (
        assessment.benefit, assessment.confidence, assessment.cost_of_delay,
        assessment.dependency_unblocking, assessment.burden, assessment.reversibility,
    )
    if any(value.value == "unknown" for value in dimensions):
        return Eligibility.NEEDS_ASSESSMENT
    if assessment.potential or (
        assessment.benefit is Benefit.HIGH
        and assessment.confidence is Confidence.LOW
    ):
        return Eligibility.POTENTIAL_VALIDATION
    return Eligibility.ASSESSED


def _priority_key(
    item: PriorityCandidate, now: datetime, review_id: str | None = None
) -> tuple[Any, ...]:
    assessment = item.assessment
    override_rank = int(bool(item.override and item.override.active_at(now, review_id=review_id)))
    if assessment is None:
        return (-override_rank, 0, 0, 0, 0, 999, 0, item.canonical_id)
    return (
        -override_rank,
        -assessment.benefit.rank,
        -assessment.cost_of_delay.rank,
        -assessment.confidence.rank,
        -assessment.dependency_unblocking.rank,
        assessment.burden.rank,
        -assessment.reversibility.rank,
        item.canonical_id,
    )


def _outcome_signature(assessment: OutcomeAssessment) -> tuple[Any, ...]:
    """Compare one benefit claim independently of split action wrappers."""
    return (
        assessment.outcome_id,
        assessment.objective,
        assessment.time_horizon,
        assessment.benefit,
        assessment.confidence,
        assessment.cost_of_delay,
        assessment.dependency_unblocking,
        assessment.burden,
        assessment.reversibility,
        assessment.evidence,
        assessment.author,
        assessment.assessed_at,
        assessment.policy_version,
        assessment.potential,
    )


def _dedupe_candidates(items: Iterable[PriorityCandidate]) -> dict[str, PriorityCandidate]:
    by_action = _dedupe_canonical(items)
    by_outcome: dict[str, PriorityCandidate] = {}
    without_assessment: dict[str, PriorityCandidate] = {}
    for canonical_id, item in by_action.items():
        if item.assessment is None:
            without_assessment[canonical_id] = item
            continue
        outcome_id = item.assessment.outcome_id
        existing = by_outcome.get(outcome_id)
        if existing is not None:
            assert existing.assessment is not None
            if (
                existing.group_id != item.group_id
                or existing.status != item.status
                or existing.urgent_verified != item.urgent_verified
                or existing.override is not None
                or item.override is not None
                or _outcome_signature(existing.assessment)
                != _outcome_signature(item.assessment)
            ):
                raise OrganizationError(f"conflicting duplicate outcome_id: {outcome_id}")
            if item.canonical_id < existing.canonical_id:
                by_outcome[outcome_id] = item
        else:
            by_outcome[outcome_id] = item
    result = dict(without_assessment)
    result.update({item.canonical_id: item for item in by_outcome.values()})
    return result


def _explain(
    item: PriorityCandidate,
    eligibility: Eligibility,
    now: datetime,
    review_id: str | None,
) -> RankingExplanation:
    assessment = item.assessment
    active_override = bool(
        item.override and item.override.active_at(now, review_id=review_id)
    )
    if eligibility is Eligibility.URGENT_PROTECTION:
        why_here = "Verified urgent protection is separate from benefit ranking."
        next_step = "Review the verified urgent condition and linked source evidence."
        trade_off = "Urgency does not assert assessed business benefit."
    elif eligibility is Eligibility.INELIGIBLE:
        why_here = f"Not rankable while status is {item.status.value}."
        next_step = "Resolve the status before reconsidering priority."
        trade_off = "An advisory override cannot revive ineligible work."
    elif assessment is None or eligibility is Eligibility.NEEDS_ASSESSMENT:
        why_here = "Needs assessment because policy dimensions are missing or unknown."
        next_step = (
            assessment.next_action_refs[0]
            if assessment and assessment.next_action_refs
            else "Complete the outcome assessment."
        )
        trade_off = "Unknown is not treated as low and receives no inferred score."
    else:
        why_here = (
            f"{eligibility.value}: benefit {assessment.benefit.value}, delay "
            f"{assessment.cost_of_delay.value}, confidence {assessment.confidence.value}"
            + ("; active human override" if active_override else "")
            + "."
        )
        next_step = (
            assessment.next_action_refs[0]
            if assessment.next_action_refs
            else "Review the assessed action."
        )
        trade_off = (
            f"Burden {assessment.burden.value}; dependency unblocking "
            f"{assessment.dependency_unblocking.value}; reversibility "
            f"{assessment.reversibility.value}."
        )
    return RankingExplanation(
        canonical_id=item.canonical_id,
        eligibility=eligibility,
        why_here=why_here,
        next_step=next_step,
        trade_off=trade_off,
        assessed_at=assessment.assessed_at if assessment else None,
        evidence=assessment.evidence if assessment else item.source_links,
    )


def partition_and_rank(
    items: Iterable[PriorityCandidate], *, now: datetime, review_id: str | None = None
) -> RankedPartitions:
    """Apply policy-v1 without I/O, model calls, writes, or hidden weights."""
    if not isinstance(now, datetime) or now.tzinfo is None:
        raise OrganizationError("now must be a timezone-aware datetime")
    now = now.astimezone(timezone.utc)
    unique = _dedupe_candidates(items)
    buckets: dict[Eligibility, list[PriorityCandidate]] = {kind: [] for kind in Eligibility}
    for item in unique.values():
        buckets[_eligibility(item)].append(item)
    for kind, bucket in buckets.items():
        if kind in {Eligibility.URGENT_PROTECTION, Eligibility.INELIGIBLE}:
            bucket.sort(key=lambda item: item.canonical_id)
        elif kind is Eligibility.NEEDS_ASSESSMENT:
            bucket.sort(
                key=lambda item: (
                    -int(bool(item.override and item.override.active_at(now, review_id=review_id))),
                    item.canonical_id,
                )
            )
        else:
            bucket.sort(key=lambda item: _priority_key(item, now, review_id))
    ordered = tuple(item for kind in Eligibility for item in buckets[kind])
    return RankedPartitions(
        urgent_protection=tuple(buckets[Eligibility.URGENT_PROTECTION]),
        assessed=tuple(buckets[Eligibility.ASSESSED]),
        potential_validation=tuple(buckets[Eligibility.POTENTIAL_VALIDATION]),
        needs_assessment=tuple(buckets[Eligibility.NEEDS_ASSESSMENT]),
        ineligible=tuple(buckets[Eligibility.INELIGIBLE]),
        explanations=tuple(
            _explain(item, _eligibility(item), now, review_id) for item in ordered
        ),
    )


def rank_groups(
    items: Iterable[PriorityCandidate], *, now: datetime, review_id: str | None = None
) -> tuple[RankedGroup, ...]:
    """Rank each group only by its best unique eligible action; never sum."""
    partitions = partition_and_rank(items, now=now, review_id=review_id)
    ordered_sections = (
        (Eligibility.URGENT_PROTECTION, partitions.urgent_protection),
        (Eligibility.ASSESSED, partitions.assessed),
        (Eligibility.POTENTIAL_VALIDATION, partitions.potential_validation),
        (Eligibility.NEEDS_ASSESSMENT, partitions.needs_assessment),
    )
    per_group: dict[str, list[tuple[Eligibility, PriorityCandidate]]] = {}
    for eligibility, candidates in ordered_sections:
        for item in candidates:
            per_group.setdefault(item.group_id, []).append((eligibility, item))
    section_rank = {kind: index for index, (kind, _) in enumerate(ordered_sections)}
    groups = [
        RankedGroup(
            group_id=group_id,
            highest_action=values[0][1],
            eligibility=values[0][0],
            eligible_action_count=len(values),
            explanation=_explain(values[0][1], values[0][0], now, review_id),
        )
        for group_id, values in per_group.items()
    ]
    groups.sort(key=lambda group: (
        section_rank[group.eligibility],
        (group.highest_action.canonical_id,)
        if group.eligibility is Eligibility.URGENT_PROTECTION
        else _priority_key(group.highest_action, now.astimezone(timezone.utc), review_id),
        group.group_id,
    ))
    return tuple(groups)


_RECORD_TYPES: dict[str, type[Any]] = {
    "namespace": SourceNamespace,
    "source_project": SourceProjectRef,
    "source_session": SourceSessionRef,
    "capture": Capture,
    "topic": Topic,
    "business_project": BusinessProject,
    "work_binding": WorkBinding,
    "outcome_assessment": OutcomeAssessment,
    "priority_override": PriorityOverride,
}
_MUTABLE_TYPES = {
    "source_project", "source_session", "topic", "business_project",
    "work_binding", "outcome_assessment", "priority_override",
}
T = TypeVar("T")


class OrganizationStore:
    """Dedicated SQLite registry beneath one exact Hermes profile home."""

    def __init__(
        self,
        path: Path | None = None,
        profile: str | None = None,
        *,
        profile_home: Path | None = None,
        clock: Callable[[], datetime] | None = None,
    ):
        if path is not None and profile_home is not None:
            raise OrganizationError("pass path or profile_home, not both")
        home = Path(profile_home) if profile_home is not None else get_hermes_home()
        self.path = Path(path) if path is not None else home / "organization.db"
        inferred = home.name if home.parent.name == "profiles" else "default"
        self.profile = _text(
            profile if profile is not None else inferred, "profile", 100, exact=True
        )
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()
        self.path.chmod(0o600)

    def _now(self) -> str:
        value = self.clock()
        if not isinstance(value, datetime) or value.tzinfo is None:
            raise OrganizationError("clock must return a timezone-aware datetime")
        return value.astimezone(timezone.utc).isoformat()

    def _connect(self) -> sqlite3.Connection:
        absolute = Path(os.path.abspath(os.fspath(self.path)))
        if absolute.parent.resolve(strict=True) != absolute.parent:
            raise OrganizationError("organization database parent is not a safe canonical directory")
        try:
            info = os.lstat(absolute)
        except FileNotFoundError:
            info = None
        if info is not None and (
            stat.S_ISLNK(info.st_mode)
            or not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
        ):
            raise OrganizationError("organization database is not a safe regular file")
        db = sqlite3.connect(
            f"{absolute.as_uri()}?nofollow=1",
            uri=True,
            timeout=15,
            isolation_level=None,
        )
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=15000")
        return db

    @classmethod
    def list_existing(
        cls,
        path: Path,
        *,
        profile: str,
        record_types: Iterable[str] | None = None,
    ) -> list[Any] | None:
        """Read records from an existing store without creating or migrating it.

        ``None`` means the profile has no organization database.  The file is
        opened read-only with SQLite's no-follow flag and its inode is held and
        revalidated for the whole read, so a caller cannot be redirected to a
        different profile store by a symlink or replacement race.
        """
        profile = _text(profile, "profile", 100, exact=True)
        absolute = Path(os.path.abspath(os.fspath(path)))
        requested = None if record_types is None else tuple(record_types)
        if requested is not None:
            if not requested or any(value not in _RECORD_TYPES for value in requested):
                raise OrganizationError("invalid organization record type")
            requested = tuple(dict.fromkeys(requested))

        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(absolute, flags)
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise OrganizationError("organization database is not a safe regular file") from exc

        db = None
        try:
            opened = os.fstat(fd)
            current = os.lstat(absolute)
            if (
                not stat.S_ISREG(opened.st_mode)
                or stat.S_ISLNK(current.st_mode)
                or (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino)
                or absolute.resolve(strict=True) != absolute
            ):
                raise OrganizationError(
                    "organization database is not a safe canonical regular file"
                )
            db = sqlite3.connect(
                f"{absolute.as_uri()}?mode=ro&nofollow=1", uri=True, timeout=15
            )
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA query_only=ON")
            db.execute("PRAGMA foreign_keys=ON")
            meta = {
                row["key"]: row["value"]
                for row in db.execute("SELECT key,value FROM organization_meta")
            }
            if meta.get("owner_profile") != profile:
                raise OrganizationError("organization store belongs to a different profile")
            try:
                schema_version = int(meta.get("schema_version", ""))
            except (TypeError, ValueError):
                raise OrganizationError("invalid organization schema version") from None
            if schema_version != SCHEMA_VERSION:
                raise OrganizationError("unsupported organization schema version")

            if requested is None:
                rows = db.execute(
                    "SELECT * FROM organization_records ORDER BY record_type,local_id"
                ).fetchall()
            else:
                placeholders = ",".join("?" for _ in requested)
                rows = db.execute(
                    "SELECT * FROM organization_records "
                    f"WHERE record_type IN ({placeholders}) ORDER BY record_type,local_id",
                    requested,
                ).fetchall()
            current = os.lstat(absolute)
            if (
                stat.S_ISLNK(current.st_mode)
                or (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino)
            ):
                raise OrganizationError("organization database changed during read")
            return [cls._decode(row) for row in rows]
        except sqlite3.Error as exc:
            raise OrganizationError("organization database could not be read safely") from exc
        finally:
            if db is not None:
                db.close()
            os.close(fd)

    @contextmanager
    def _tx(self, *, write: bool = True) -> Iterator[sqlite3.Connection]:
        db = self._connect()
        try:
            db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def _initialize(self) -> None:
        migrations = {
            1: (
                """CREATE TABLE IF NOT EXISTS organization_records (
                    canonical_id TEXT PRIMARY KEY,
                    record_type TEXT NOT NULL,
                    local_id TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    created_by TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    updated_by TEXT NOT NULL,
                    UNIQUE(record_type, local_id)
                )""",
                """CREATE TABLE IF NOT EXISTS organization_audit (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    canonical_id TEXT NOT NULL,
                    record_type TEXT NOT NULL,
                    operation TEXT NOT NULL,
                    actor TEXT NOT NULL,
                    occurred_at TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    payload_json TEXT NOT NULL
                )""",
                """CREATE INDEX IF NOT EXISTS idx_organization_audit_record
                    ON organization_audit(canonical_id, sequence)""",
            ),
            2: (
                """CREATE TABLE IF NOT EXISTS organization_idempotency (
                    actor TEXT NOT NULL,
                    idempotency_key TEXT NOT NULL,
                    operation TEXT NOT NULL,
                    request_json TEXT NOT NULL,
                    record_type TEXT NOT NULL,
                    response_json TEXT NOT NULL,
                    PRIMARY KEY(actor, idempotency_key)
                )""",
            ),
        }
        try:
            with self._tx() as db:
                meta_exists = db.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_meta'"
                ).fetchone()
                if meta_exists:
                    owner_row = db.execute(
                        "SELECT value FROM organization_meta WHERE key='owner_profile'"
                    ).fetchone()
                    if owner_row is not None and owner_row[0] != self.profile:
                        raise OrganizationError(
                            "organization store belongs to a different profile"
                        )
                else:
                    db.execute(
                        "CREATE TABLE organization_meta "
                        "(key TEXT PRIMARY KEY, value TEXT NOT NULL)"
                    )

                row = db.execute(
                    "SELECT value FROM organization_meta WHERE key='schema_version'"
                ).fetchone()
                try:
                    current = int(row[0]) if row else 0
                except (TypeError, ValueError):
                    raise OrganizationError("invalid organization schema version") from None
                if current > SCHEMA_VERSION:
                    raise OrganizationError("organization store uses a newer schema")
                for version in range(current + 1, SCHEMA_VERSION + 1):
                    for statement in migrations[version]:
                        db.execute(statement)
                    db.execute(
                        "INSERT OR REPLACE INTO organization_meta(key,value) "
                        "VALUES('schema_version',?)",
                        (str(version),),
                    )
                db.execute(
                    "INSERT OR IGNORE INTO organization_meta(key,value) "
                    "VALUES('owner_profile',?)",
                    (self.profile,),
                )
                owner = db.execute(
                    "SELECT value FROM organization_meta WHERE key='owner_profile'"
                ).fetchone()[0]
                if owner != self.profile:
                    raise OrganizationError(
                        "organization store belongs to a different profile"
                    )
        except sqlite3.Error as exc:
            raise OrganizationError(f"organization migration failed: {exc}") from None

    @staticmethod
    def _local_id(record: Any) -> str:
        if isinstance(record, (SourceNamespace, SourceProjectRef, SourceSessionRef)):
            return record.canonical_id
        return record.id

    @staticmethod
    def _idempotency_replay(
        db: sqlite3.Connection,
        *,
        actor: str,
        operation: str,
        key: str,
        request: Mapping[str, Any],
        record_type: str,
    ) -> Any | None:
        key = _text(key, "idempotency_key", 200, exact=True)
        request_json = canonical_json(request)
        row = db.execute(
            "SELECT * FROM organization_idempotency WHERE actor=? AND idempotency_key=?",
            (actor, key),
        ).fetchone()
        if row is None:
            return None
        if (
            row["operation"] != operation
            or row["request_json"] != request_json
            or row["record_type"] != record_type
        ):
            raise OrganizationError("idempotency key reused with different request")
        try:
            return _RECORD_TYPES[record_type].from_dict(json.loads(row["response_json"]))
        except (KeyError, TypeError, json.JSONDecodeError) as exc:
            raise OrganizationError("invalid organization idempotency receipt") from exc

    @staticmethod
    def _idempotency_remember(
        db: sqlite3.Connection,
        *,
        actor: str,
        operation: str,
        key: str,
        request: Mapping[str, Any],
        record_type: str,
        record: Any,
    ) -> None:
        db.execute(
            "INSERT INTO organization_idempotency VALUES(?,?,?,?,?,?)",
            (
                actor,
                _text(key, "idempotency_key", 200, exact=True),
                operation,
                canonical_json(request),
                record_type,
                canonical_json(record.to_dict()),
            ),
        )

    def _create(
        self,
        record_type: str,
        record: T,
        actor: str,
        *,
        idempotent: bool = False,
        idempotency_request: tuple[str, str, Mapping[str, Any]] | None = None,
    ) -> T | tuple[T, bool]:
        actor = _text(actor, "actor", 500)
        now = self._now()
        if record_type in _MUTABLE_TYPES:
            record = replace(
                record, version=1, created_at=now, created_by=actor, updated_at=now, updated_by=actor
            )
        elif isinstance(record, Capture):
            record = replace(record, created_by=actor)
        payload = canonical_json(record.to_dict())
        canonical_id = getattr(record, "canonical_id")
        with self._tx() as db:
            if idempotency_request is not None:
                operation, key, request = idempotency_request
                replay = self._idempotency_replay(
                    db, actor=actor, operation=operation, key=key,
                    request=request, record_type=record_type,
                )
                if replay is not None:
                    return replay, True
            existing = db.execute(
                "SELECT * FROM organization_records WHERE canonical_id=?", (canonical_id,)
            ).fetchone()
            if existing:
                found = self._decode(existing)
                if idempotent and canonical_json(found.to_dict()) == payload:
                    return found
                raise OrganizationError(f"{record_type} already exists")
            audited_identity = db.execute(
                "SELECT 1 FROM organization_audit WHERE canonical_id=? LIMIT 1",
                (canonical_id,),
            ).fetchone()
            if audited_identity:
                raise OrganizationError(
                    f"{record_type} identity already exists in audit history"
                )
            local_collision = db.execute(
                "SELECT canonical_id FROM organization_records "
                "WHERE record_type=? AND local_id=?",
                (record_type, self._local_id(record)),
            ).fetchone()
            if local_collision:
                raise OrganizationError(f"{record_type} local id already exists")
            version = record.version if record_type in _MUTABLE_TYPES else 1
            try:
                db.execute(
                    "INSERT INTO organization_records VALUES(?,?,?,?,?,?,?,?,?)",
                    (canonical_id, record_type, self._local_id(record), payload, version,
                     now, actor, now, actor),
                )
            except sqlite3.IntegrityError:
                raise OrganizationError(f"{record_type} identity already exists") from None
            db.execute(
                "INSERT INTO organization_audit(canonical_id,record_type,operation,actor,occurred_at,version,payload_json) "
                "VALUES(?,?,?,?,?,?,?)",
                (canonical_id, record_type, "create", actor, now, version, payload),
            )
            if idempotency_request is not None:
                self._idempotency_remember(
                    db, actor=actor, operation=operation, key=key, request=request,
                    record_type=record_type, record=record,
                )
        return (record, False) if idempotency_request is not None else record

    def _get(self, record_type: str, local_id: str) -> Any:
        local_id = _text(local_id, "id", 2_000)
        with self._tx(write=False) as db:
            row = db.execute(
                "SELECT * FROM organization_records WHERE record_type=? AND local_id=?",
                (record_type, local_id),
            ).fetchone()
        if row is None:
            raise OrganizationError(f"{record_type} not found")
        return self._decode(row)

    def _update(
        self,
        record_type: str,
        record: T,
        expected_version: int,
        actor: str,
        *,
        idempotency_request: tuple[str, str, Mapping[str, Any]] | None = None,
    ) -> T | tuple[T, bool]:
        if type(expected_version) is not int:
            raise OrganizationError("expected_version must be an integer")
        actor = _text(actor, "actor", 500)
        with self._tx() as db:
            if idempotency_request is not None:
                operation, key, request = idempotency_request
                replay = self._idempotency_replay(
                    db, actor=actor, operation=operation, key=key,
                    request=request, record_type=record_type,
                )
                if replay is not None:
                    return replay, True
            row = db.execute(
                "SELECT * FROM organization_records WHERE record_type=? AND local_id=?",
                (record_type, self._local_id(record)),
            ).fetchone()
            if row is None:
                raise OrganizationError(f"{record_type} not found")
            if row["version"] != expected_version:
                raise OrganizationError("stale organization version; refresh before updating")
            current = self._decode(row)
            if record.canonical_id != current.canonical_id:
                raise OrganizationError("canonical organization identity cannot change")
            now = max(
                (self._now(), current.created_at, current.updated_at),
                key=_as_datetime,
            )
            updated = replace(
                record,
                version=expected_version + 1,
                created_at=current.created_at,
                created_by=current.created_by,
                updated_at=now,
                updated_by=actor,
            )
            if isinstance(updated, PriorityOverride) and updated.actor != current.actor:
                raise OrganizationError("priority override attribution cannot change")
            payload = canonical_json(updated.to_dict())
            changed = db.execute(
                "UPDATE organization_records SET payload_json=?,version=?,updated_at=?,updated_by=? "
                "WHERE canonical_id=? AND version=?",
                (payload, updated.version, now, actor, current.canonical_id, expected_version),
            ).rowcount
            if changed != 1:
                raise OrganizationError("stale organization version; refresh before updating")
            db.execute(
                "INSERT INTO organization_audit(canonical_id,record_type,operation,actor,occurred_at,version,payload_json) "
                "VALUES(?,?,?,?,?,?,?)",
                (current.canonical_id, record_type, "update", actor, now, updated.version, payload),
            )
            if idempotency_request is not None:
                self._idempotency_remember(
                    db, actor=actor, operation=operation, key=key, request=request,
                    record_type=record_type, record=updated,
                )
        return (updated, False) if idempotency_request is not None else updated

    def _delete(
        self,
        record_type: str,
        local_id: str,
        expected_version: int,
        actor: str,
        *,
        idempotency_request: tuple[str, str, Mapping[str, Any]] | None = None,
    ) -> Any:
        if type(expected_version) is not int:
            raise OrganizationError("expected_version must be an integer")
        local_id = _text(local_id, "id", 2_000)
        actor = _text(actor, "actor", 500)
        with self._tx() as db:
            if idempotency_request is not None:
                operation, key, request = idempotency_request
                replay = self._idempotency_replay(
                    db, actor=actor, operation=operation, key=key,
                    request=request, record_type=record_type,
                )
                if replay is not None:
                    return replay, True
            row = db.execute(
                "SELECT * FROM organization_records WHERE record_type=? AND local_id=?",
                (record_type, local_id),
            ).fetchone()
            if row is None:
                raise OrganizationError(f"{record_type} not found")
            if row["version"] != expected_version:
                raise OrganizationError("stale organization version; refresh before updating")
            current = self._decode(row)
            now = max(
                (self._now(), current.created_at, current.updated_at),
                key=_as_datetime,
            )
            deleted = replace(
                current,
                version=expected_version + 1,
                created_at=current.created_at,
                created_by=current.created_by,
                updated_at=now,
                updated_by=actor,
            )
            payload = canonical_json(deleted.to_dict())
            changed = db.execute(
                "DELETE FROM organization_records WHERE canonical_id=? AND version=?",
                (row["canonical_id"], expected_version),
            ).rowcount
            if changed != 1:
                raise OrganizationError("stale organization version; refresh before updating")
            db.execute(
                "INSERT INTO organization_audit(canonical_id,record_type,operation,actor,occurred_at,version,payload_json) "
                "VALUES(?,?,?,?,?,?,?)",
                (
                    row["canonical_id"], record_type, "delete", actor, now,
                    deleted.version, payload,
                ),
            )
            if idempotency_request is not None:
                self._idempotency_remember(
                    db, actor=actor, operation=operation, key=key, request=request,
                    record_type=record_type, record=deleted,
                )
        return (deleted, False) if idempotency_request is not None else deleted

    @staticmethod
    def _decode(row: Mapping[str, Any]) -> Any:
        record_type = row["record_type"]
        try:
            kind = _RECORD_TYPES[record_type]
            return kind.from_dict(json.loads(row["payload_json"]))
        except (KeyError, TypeError, json.JSONDecodeError) as exc:
            raise OrganizationError(f"invalid stored {record_type} record: {exc}") from None

    def register_namespace(self, value: SourceNamespace, *, actor: str) -> SourceNamespace:
        return self._create("namespace", value, actor, idempotent=True)

    def get_namespace(self, canonical_id: str) -> SourceNamespace:
        return self._get("namespace", canonical_id)

    def create_source_project(self, value: SourceProjectRef, *, actor: str) -> SourceProjectRef:
        return self._create("source_project", value, actor)

    def get_source_project(self, canonical_id: str) -> SourceProjectRef:
        return self._get("source_project", canonical_id)

    def update_source_project(
        self, value: SourceProjectRef, *, expected_version: int, actor: str
    ) -> SourceProjectRef:
        return self._update("source_project", value, expected_version, actor)

    def delete_source_project(
        self, canonical_id: str, *, expected_version: int, actor: str
    ) -> None:
        self._delete("source_project", canonical_id, expected_version, actor)

    def create_source_session(self, value: SourceSessionRef, *, actor: str) -> SourceSessionRef:
        return self._create("source_session", value, actor)

    def get_source_session(self, canonical_id: str) -> SourceSessionRef:
        return self._get("source_session", canonical_id)

    def update_source_session(
        self, value: SourceSessionRef, *, expected_version: int, actor: str
    ) -> SourceSessionRef:
        return self._update("source_session", value, expected_version, actor)

    def delete_source_session(
        self, canonical_id: str, *, expected_version: int, actor: str
    ) -> None:
        self._delete("source_session", canonical_id, expected_version, actor)

    def create_capture(self, value: Capture, *, actor: str) -> Capture:
        return self._create("capture", value, actor)

    def get_capture(self, record_id: str) -> Capture:
        return self._get("capture", record_id)

    def create_topic(self, value: Topic, *, actor: str) -> Topic:
        return self._create("topic", value, actor)

    def get_topic(self, record_id: str) -> Topic:
        return self._get("topic", record_id)

    def update_topic(self, value: Topic, *, expected_version: int, actor: str) -> Topic:
        return self._update("topic", value, expected_version, actor)

    def create_business_project(self, value: BusinessProject, *, actor: str) -> BusinessProject:
        return self._create("business_project", value, actor)

    def get_business_project(self, record_id: str) -> BusinessProject:
        return self._get("business_project", record_id)

    def update_business_project(self, value: BusinessProject, *, expected_version: int, actor: str) -> BusinessProject:
        return self._update("business_project", value, expected_version, actor)

    def create_work_binding(self, value: WorkBinding, *, actor: str) -> WorkBinding:
        return self._create("work_binding", value, actor)

    def get_work_binding(self, record_id: str) -> WorkBinding:
        return self._get("work_binding", record_id)

    def update_work_binding(self, value: WorkBinding, *, expected_version: int, actor: str) -> WorkBinding:
        return self._update("work_binding", value, expected_version, actor)

    def create_outcome_assessment(self, value: OutcomeAssessment, *, actor: str) -> OutcomeAssessment:
        return self._create("outcome_assessment", value, actor)

    def get_outcome_assessment(self, record_id: str) -> OutcomeAssessment:
        return self._get("outcome_assessment", record_id)

    def update_outcome_assessment(self, value: OutcomeAssessment, *, expected_version: int, actor: str) -> OutcomeAssessment:
        return self._update("outcome_assessment", value, expected_version, actor)

    def create_priority_override(self, value: PriorityOverride, *, actor: str) -> PriorityOverride:
        if value.actor != actor:
            raise OrganizationError("priority override actor must match authenticated actor")
        return self._create("priority_override", value, actor)

    def get_priority_override(self, record_id: str) -> PriorityOverride:
        return self._get("priority_override", record_id)

    def update_priority_override(self, value: PriorityOverride, *, expected_version: int, actor: str) -> PriorityOverride:
        if value.actor != actor:
            raise OrganizationError("priority override actor must match authenticated actor")
        return self._update("priority_override", value, expected_version, actor)

    def owner_mutation(
        self,
        operation: str,
        value: (
            Topic
            | BusinessProject
            | SourceProjectRef
            | SourceSessionRef
            | Capture
            | WorkBinding
            | PriorityOverride
        ),
        *,
        expected_version: int,
        idempotency_key: str,
        request: Mapping[str, Any],
        actor: str,
    ) -> tuple[
        Topic
        | BusinessProject
        | SourceProjectRef
        | SourceSessionRef
        | Capture
        | WorkBinding
        | PriorityOverride,
        bool,
    ]:
        """Atomically apply one owner RPC mutation and its replay receipt."""
        record_types = {
            Topic: "topic",
            BusinessProject: "business_project",
            SourceProjectRef: "source_project",
            SourceSessionRef: "source_session",
            Capture: "capture",
            WorkBinding: "work_binding",
            PriorityOverride: "priority_override",
        }
        record_type = record_types[type(value)]
        if isinstance(value, PriorityOverride) and value.actor != actor:
            raise OrganizationError("priority override actor must match authenticated actor")
        receipt = (operation, idempotency_key, request)
        if isinstance(value, Capture) and expected_version != 0:
            raise OrganizationError("expected_version must be 0 for immutable capture")
        if expected_version == 0:
            result = self._create(
                record_type, value, actor, idempotency_request=receipt
            )
        else:
            result = self._update(
                record_type,
                value,
                expected_version,
                actor,
                idempotency_request=receipt,
            )
        assert isinstance(result, tuple)
        return result

    def owner_remove(
        self,
        operation: str,
        record_type: str,
        record_id: str,
        *,
        expected_version: int,
        idempotency_key: str,
        request: Mapping[str, Any],
        actor: str,
    ) -> tuple[SourceProjectRef | SourceSessionRef | WorkBinding | PriorityOverride, bool]:
        if record_type not in {
            "source_project",
            "source_session",
            "work_binding",
            "priority_override",
        }:
            raise OrganizationError("invalid removable organization record type")
        result = self._delete(
            record_type,
            record_id,
            expected_version,
            actor,
            idempotency_request=(operation, idempotency_key, request),
        )
        assert isinstance(result, tuple)
        return result

    def restore_recommended(
        self, record_id: str, *, expected_version: int, actor: str
    ) -> PriorityOverride:
        """Remove an override while preserving its attributed audit history."""
        return self._delete("priority_override", record_id, expected_version, actor)

    def audit_events(self, canonical_id: str) -> list[dict[str, Any]]:
        canonical_id = _text(canonical_id, "canonical_id", 2_000)
        with self._tx(write=False) as db:
            rows = db.execute(
                "SELECT operation,actor,occurred_at,version,payload_json FROM organization_audit "
                "WHERE canonical_id=? ORDER BY sequence", (canonical_id,),
            ).fetchall()
        return [
            {
                "operation": row["operation"], "actor": row["actor"],
                "occurred_at": row["occurred_at"], "version": row["version"],
                "payload": json.loads(row["payload_json"]),
            }
            for row in rows
        ]

    def export_json(self) -> str:
        """Return a deterministic, backup-friendly snapshot with no DB internals."""
        with self._tx(write=False) as db:
            records = [
                {
                    "canonical_id": row["canonical_id"], "record_type": row["record_type"],
                    "local_id": row["local_id"], "payload": json.loads(row["payload_json"]),
                    "version": row["version"], "created_at": row["created_at"],
                    "created_by": row["created_by"], "updated_at": row["updated_at"],
                    "updated_by": row["updated_by"],
                }
                for row in db.execute("SELECT * FROM organization_records ORDER BY canonical_id")
            ]
            audit = [
                {
                    "canonical_id": row["canonical_id"], "record_type": row["record_type"],
                    "operation": row["operation"], "actor": row["actor"],
                    "occurred_at": row["occurred_at"], "version": row["version"],
                    "payload": json.loads(row["payload_json"]),
                }
                for row in db.execute("SELECT * FROM organization_audit ORDER BY sequence")
            ]
        return canonical_json({
            "format": "hermes-organization-v1", "owner_profile": self.profile,
            "schema_version": SCHEMA_VERSION, "records": records, "audit": audit,
        })

    def restore_json(self, snapshot: str) -> None:
        """Restore into an empty matching-profile store, validating every record."""
        try:
            data = json.loads(snapshot)
        except (TypeError, json.JSONDecodeError):
            raise OrganizationError("invalid organization snapshot JSON") from None
        if not isinstance(data, dict) or set(data) != {
            "format", "owner_profile", "schema_version", "records", "audit"
        }:
            raise OrganizationError("invalid organization snapshot shape")
        if (
            data["format"] != "hermes-organization-v1"
            or type(data["schema_version"]) is not int
            or data["schema_version"] != SCHEMA_VERSION
        ):
            raise OrganizationError("unsupported organization snapshot version")
        if data["owner_profile"] != self.profile:
            raise OrganizationError("snapshot belongs to a different profile")
        if not isinstance(data["records"], list) or not isinstance(data["audit"], list):
            raise OrganizationError("invalid organization snapshot collections")
        canonical_json(data)

        record_keys = {
            "canonical_id", "record_type", "local_id", "payload", "version",
            "created_at", "created_by", "updated_at", "updated_by",
        }
        audit_keys = {
            "canonical_id", "record_type", "operation", "actor", "occurred_at",
            "version", "payload",
        }

        def decode(record_type: Any, payload_value: Any, label: str) -> tuple[Any, str]:
            if (
                not isinstance(record_type, str)
                or record_type not in _RECORD_TYPES
                or not isinstance(payload_value, dict)
            ):
                raise OrganizationError(f"invalid snapshot {label}")
            try:
                record_value = _RECORD_TYPES[record_type].from_dict(payload_value)
            except OrganizationError:
                raise
            except (KeyError, TypeError, ValueError):
                raise OrganizationError(f"invalid snapshot {label}") from None
            return record_value, canonical_json(record_value.to_dict())

        validated: list[tuple[dict[str, Any], Any, str]] = []
        record_state: dict[str, tuple[str, int, str, str, str]] = {}
        local_keys: set[tuple[str, str]] = set()
        for entry in data["records"]:
            if not isinstance(entry, dict) or set(entry) != record_keys:
                raise OrganizationError("invalid snapshot record")
            record, payload = decode(entry["record_type"], entry["payload"], "record")
            version = entry["version"]
            created_at = _timestamp(entry["created_at"], "created_at")
            updated_at = _timestamp(entry["updated_at"], "updated_at")
            created_by = _text(entry["created_by"], "created_by", 500)
            updated_by = _text(entry["updated_by"], "updated_by", 500)
            if (
                entry["canonical_id"] != record.canonical_id
                or entry["local_id"] != self._local_id(record)
                or type(version) is not int
                or version < 1
                or created_at != entry["created_at"]
                or updated_at != entry["updated_at"]
                or created_by != entry["created_by"]
                or updated_by != entry["updated_by"]
                or _as_datetime(created_at) > _as_datetime(updated_at)
            ):
                raise OrganizationError("snapshot record identity/version mismatch")
            if entry["record_type"] in _MUTABLE_TYPES and (
                record.version != version
                or record.created_at != created_at
                or record.created_by != created_by
                or record.updated_at != updated_at
                or record.updated_by != updated_by
            ):
                raise OrganizationError("snapshot record metadata mismatch")
            if (
                isinstance(record, PriorityOverride)
                and record.actor != record.created_by
            ):
                raise OrganizationError("snapshot priority override attribution mismatch")
            if entry["record_type"] not in _MUTABLE_TYPES:
                if (
                    version != 1
                    or created_at != updated_at
                    or created_by != updated_by
                    or (
                        isinstance(record, Capture)
                        and record.created_by != created_by
                    )
                ):
                    raise OrganizationError("snapshot immutable record metadata mismatch")
            canonical_id = entry["canonical_id"]
            local_key = (entry["record_type"], entry["local_id"])
            if canonical_id in record_state or local_key in local_keys:
                raise OrganizationError("duplicate snapshot record identity")
            record_state[canonical_id] = (
                entry["record_type"], version, payload, updated_at, updated_by
            )
            local_keys.add(local_key)
            validated.append((entry, record, payload))

        validated_audit: list[tuple[dict[str, Any], str]] = []
        history: dict[str, tuple[str, int, str, bool, str, str]] = {}
        creation_metadata: dict[str, tuple[str | None, str | None]] = {}
        for event in data["audit"]:
            if not isinstance(event, dict) or set(event) != audit_keys:
                raise OrganizationError("invalid snapshot audit event")
            operation = event["operation"]
            if not isinstance(operation, str) or operation not in {
                "create", "update", "delete"
            }:
                raise OrganizationError("invalid snapshot audit operation")
            record, payload = decode(event["record_type"], event["payload"], "audit event")
            actor = _text(event["actor"], "actor", 500)
            occurred_at = _timestamp(event["occurred_at"], "occurred_at")
            version = event["version"]
            if (
                event["canonical_id"] != record.canonical_id
                or actor != event["actor"]
                or occurred_at != event["occurred_at"]
                or type(version) is not int
                or version < 1
            ):
                raise OrganizationError("snapshot audit identity/version mismatch")
            mutable = event["record_type"] in _MUTABLE_TYPES
            if mutable and (
                record.version != version
                or record.updated_at != occurred_at
                or record.updated_by != actor
                or record.created_at is None
                or _as_datetime(record.created_at) > _as_datetime(occurred_at)
            ):
                raise OrganizationError("snapshot audit payload metadata mismatch")
            if (
                isinstance(record, PriorityOverride)
                and record.actor != record.created_by
            ):
                raise OrganizationError("snapshot priority override attribution mismatch")
            if not mutable and (operation != "create" or version != 1):
                raise OrganizationError("invalid immutable snapshot audit history")

            previous = history.get(event["canonical_id"])
            if operation == "create":
                if previous is not None or version != 1:
                    raise OrganizationError("inconsistent snapshot audit history")
                if mutable and (
                    record.created_at != occurred_at or record.created_by != actor
                ):
                    raise OrganizationError("snapshot audit create metadata mismatch")
                creation_metadata[event["canonical_id"]] = (
                    record.created_at if mutable else occurred_at,
                    record.created_by if mutable else actor,
                )
            else:
                if previous is None or not previous[3] or version != previous[1] + 1:
                    raise OrganizationError("inconsistent snapshot audit history")
                if previous[0] != event["record_type"]:
                    raise OrganizationError("inconsistent snapshot audit record type")
                if _as_datetime(previous[4]) > _as_datetime(occurred_at):
                    raise OrganizationError("snapshot audit timestamps moved backward")
                if mutable and creation_metadata[event["canonical_id"]] != (
                    record.created_at,
                    record.created_by,
                ):
                    raise OrganizationError("snapshot audit creation metadata changed")
            history[event["canonical_id"]] = (
                event["record_type"], version, payload, operation != "delete",
                occurred_at, actor,
            )
            validated_audit.append((event, payload))

        active_history = {
            canonical_id: (record_type, version, payload, occurred_at, actor)
            for canonical_id, (
                record_type, version, payload, active, occurred_at, actor
            ) in history.items()
            if active
        }
        if active_history != record_state:
            raise OrganizationError("snapshot records do not match audit history")

        with self._tx() as db:
            if (
                db.execute("SELECT 1 FROM organization_records LIMIT 1").fetchone()
                or db.execute("SELECT 1 FROM organization_audit LIMIT 1").fetchone()
            ):
                raise OrganizationError("restore target must be empty")
            try:
                for entry, _record, payload in validated:
                    db.execute(
                        "INSERT INTO organization_records VALUES(?,?,?,?,?,?,?,?,?)",
                        (entry["canonical_id"], entry["record_type"], entry["local_id"],
                         payload, entry["version"], entry["created_at"],
                         entry["created_by"], entry["updated_at"], entry["updated_by"]),
                    )
                for event, payload in validated_audit:
                    db.execute(
                        "INSERT INTO organization_audit(canonical_id,record_type,operation,actor,occurred_at,version,payload_json) "
                        "VALUES(?,?,?,?,?,?,?)",
                        (event["canonical_id"], event["record_type"], event["operation"],
                         event["actor"], event["occurred_at"], event["version"], payload),
                    )
            except sqlite3.IntegrityError:
                raise OrganizationError("snapshot contains conflicting identities") from None
