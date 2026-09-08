"""Owner-only Needs Me projection using organization priority policy."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from hermes_cli.companion_organization import (
    BusinessProject,
    OrganizationError,
    OrganizationStore,
    OutcomeAssessment,
    PriorityCandidate,
    PriorityOverride,
    Topic,
    WorkBinding,
    WorkStatus,
    partition_and_rank,
    rank_groups,
)
from hermes_cli.companion_work_store import WorkError, WorkStore
from tui_gateway.companion_projects import _backend_namespace
from tui_gateway.companion_topics import (
    _owner_authorized_profiles,
    _profile,
    _require_owner,
    _source_authorized,
)


class CompanionPrioritiesError(Exception):
    def __init__(self, message: str, code: int):
        super().__init__(message)
        self.code = code


def _validate(params: Any) -> dict[str, Any]:
    if not isinstance(params, dict) or set(params) - {"profile", "review_id", "group_by"}:
        raise CompanionPrioritiesError("unexpected Needs Me parameters", -32602)
    review_id = params.get("review_id")
    if review_id is not None and (
        not isinstance(review_id, str)
        or not review_id
        or review_id != review_id.strip()
        or len(review_id) > 500
    ):
        raise CompanionPrioritiesError("invalid review_id", -32602)
    group_by = params.get("group_by", "topic")
    if group_by not in {"topic", "session", "project"}:
        raise CompanionPrioritiesError("invalid group_by", -32602)
    return {**params, "group_by": group_by}


def _read_organization(home: Path, profile: str) -> list[Any] | None:
    try:
        return OrganizationStore.list_existing(
            home / "organization.db",
            profile=profile,
            record_types=(
                "topic", "business_project", "work_binding", "outcome_assessment",
                "priority_override",
            ),
        )
    except OrganizationError as exc:
        raise CompanionPrioritiesError("Needs Me organization source unavailable", 5065) from exc


def _read_work(home: Path, profile: str) -> list[dict[str, Any]]:
    path = home / "companion-work.db"
    if not path.exists():
        return []
    try:
        return WorkStore(path, profile).list(
            states=["needs_me"], include_snoozed=False
        )["items"]
    except (OSError, WorkError) as exc:
        raise CompanionPrioritiesError("Needs Me work source unavailable", 5065) from exc


def _latest(values):
    return max(
        values,
        key=lambda value: (str(value.updated_at or value.created_at or ""), value.canonical_id),
        default=None,
    )


def _assessment_for(
    binding: WorkBinding | None, assessments: list[OutcomeAssessment]
) -> OutcomeAssessment | None:
    if binding is None:
        return None
    keys = {binding.source_work_id, binding.id, binding.canonical_id}
    return _latest(value for value in assessments if value.action_id in keys)


def _override_for(
    binding: WorkBinding | None,
    assessment: OutcomeAssessment | None,
    overrides: list[PriorityOverride],
    fallback_target_id: str,
) -> PriorityOverride | None:
    keys = {fallback_target_id}
    if assessment:
        keys.add(assessment.action_id)
    if binding is not None:
        keys.update((binding.source_work_id, binding.id, binding.canonical_id))
    return _latest(value for value in overrides if value.target_id in keys)


def _assessment(value: OutcomeAssessment | None) -> dict[str, Any] | None:
    if value is None:
        return None
    return {
        "id": value.id,
        "outcome_id": value.outcome_id,
        "action_id": value.action_id,
        "objective": value.objective,
        "time_horizon": value.time_horizon,
        "benefit": value.benefit.value,
        "confidence": value.confidence.value,
        "cost_of_delay": value.cost_of_delay.value,
        "dependency_unblocking": value.dependency_unblocking.value,
        "burden": value.burden.value,
        "reversibility": value.reversibility.value,
        "evidence": list(value.evidence),
        "author": value.author,
        "assessed_at": value.assessed_at,
        "policy_version": value.policy_version,
        "next_action_refs": list(value.next_action_refs),
        "potential": value.potential,
    }


def _override(value: PriorityOverride | None, now: datetime, review_id: str | None):
    if value is None:
        return None
    return {
        "id": value.id,
        "version": value.version,
        "mode": value.mode,
        "label": value.label,
        "actor": value.actor,
        "reason": value.reason,
        "expires_at": value.expires_at,
        "review_id": value.review_id,
        "review_at": value.review_at,
        "active": value.active_at(now, review_id=review_id),
    }


def _group_for(
    binding: WorkBinding | None,
    topics: Mapping[str, Topic],
    group_by: str,
    backend: str,
    authorized_profiles: frozenset[str],
    business_projects: Mapping[str, BusinessProject] | None = None,
):
    topic = topics.get(binding.primary_topic_id) if binding and binding.primary_topic_id else None
    if group_by == "topic":
        return (
            f"topic:{topic.id}" if topic else "topic:__unassigned__",
            {"kind": "topic", "id": topic.id if topic else "__unassigned__",
             "name": topic.name if topic else "Unassigned topic",
             "collection": topic.collection if topic else None,
             "objective": topic.objective if topic else None},
        )
    if group_by == "session":
        session = binding.primary_session if binding else None
        if session is not None and not _source_authorized(
            session.namespace, backend, authorized_profiles
        ):
            session = None
        return (
            f"session:{session.canonical_id}" if session else "session:__none__",
            {"kind": "session", "id": session.canonical_id if session else "__none__",
             "name": session.persisted_session_id if session else "No source session",
             "collection": None, "objective": None},
        )
    business_projects = business_projects or {}
    business_project_id = binding.primary_business_project_id if binding else None
    if business_project_id is None and topic is not None:
        business_project_id = topic.primary_business_project_id
    if business_project_id is None and binding and len(binding.related_business_project_ids) == 1:
        business_project_id = binding.related_business_project_ids[0]
    business_project = business_projects.get(business_project_id) if business_project_id else None
    if business_project is not None:
        return (
            f"project:{business_project.canonical_id}",
            {"kind": "project", "id": business_project.canonical_id,
             "name": business_project.name, "collection": business_project.collection,
             "objective": business_project.objective},
        )
    project = topic.primary_project if topic else None
    if project is not None and not _source_authorized(
        project.namespace, backend, authorized_profiles
    ):
        project = None
    authorized_source_projects = (
        [
            value
            for value in binding.source_projects
            if _source_authorized(value.namespace, backend, authorized_profiles)
        ]
        if binding
        else []
    )
    if project is None and len(authorized_source_projects) == 1:
        project = authorized_source_projects[0]
    return (
        f"project:{project.canonical_id}" if project else "project:__none__",
        {"kind": "project", "id": project.canonical_id if project else "__none__",
         "name": project.source_id if project else "No project",
         "collection": None, "objective": None},
    )


def _nested_refs_authorized(
    binding: WorkBinding,
    topics: Mapping[str, Topic],
    backend: str,
    authorized_profiles: frozenset[str],
) -> bool:
    topic = (
        topics.get(binding.primary_topic_id) if binding.primary_topic_id else None
    )
    namespaces = [project.namespace for project in binding.source_projects]
    if binding.primary_session is not None:
        namespaces.append(binding.primary_session.namespace)
    if topic is not None and topic.primary_project is not None:
        namespaces.append(topic.primary_project.namespace)
    return all(
        _source_authorized(namespace, backend, authorized_profiles)
        for namespace in namespaces
    )


def execute(
    server,
    params: Any,
    *,
    owner_authorization: Any = None,
) -> dict[str, Any]:
    params = _validate(params)
    try:
        _require_owner(owner_authorization)
    except Exception as exc:
        raise CompanionPrioritiesError(
            "authenticated dashboard owner required", 4403
        ) from exc

    try:
        profile, home = _profile(server, params.get("profile"))
        from tui_gateway.companion_library import _launch_home

        backend = _backend_namespace(server, installation_home=_launch_home())
        authorized_profiles = _owner_authorized_profiles(server)
    except Exception as exc:
        raise CompanionPrioritiesError("Needs Me profile unavailable", 4403) from exc
    if profile not in authorized_profiles:
        raise CompanionPrioritiesError("Needs Me profile unavailable", 4403)

    records = _read_organization(home, profile)
    work_items = _read_work(home, profile)
    records = records or []
    topics = {value.id: value for value in records if isinstance(value, Topic)}
    business_projects = {
        value.id: value for value in records if isinstance(value, BusinessProject)
    }
    bindings = [
        value
        for value in records
        if isinstance(value, WorkBinding)
        and _source_authorized(value.source_namespace, backend, authorized_profiles)
        and getattr(value.source_namespace, "profile", None) == profile
    ]
    nested_authorization_filtered = any(
        not _nested_refs_authorized(
            value, topics, backend, authorized_profiles
        )
        for value in bindings
    )
    assessments = [value for value in records if isinstance(value, OutcomeAssessment)]
    overrides = [value for value in records if isinstance(value, PriorityOverride)]
    binding_by_work: dict[str, WorkBinding] = {}
    for binding in sorted(
        bindings,
        key=lambda value: (
            value.primary_topic_id is None,
            value.canonical_id,
        ),
    ):
        binding_by_work.setdefault(binding.source_work_id, binding)

    now = datetime.now(timezone.utc)
    review_id = params.get("review_id")
    group_by = params["group_by"]
    candidates: list[PriorityCandidate] = []
    cards_by_candidate: dict[str, dict[str, Any]] = {}
    metadata: dict[str, tuple[OutcomeAssessment | None, PriorityOverride | None]] = {}
    group_views: dict[str, dict[str, Any]] = {}
    for card in work_items:
        if not card.get("attention_due"):
            continue
        binding = binding_by_work.get(card["id"])
        assessment = _assessment_for(binding, assessments)
        fallback_candidate_id = (
            binding.source_work_id
            if binding is not None
            else f"{backend}:{profile}:work:{card['id']}"
        )
        override = _override_for(
            binding, assessment, overrides, fallback_candidate_id
        )
        candidate_id = (
            assessment.action_id
            if assessment is not None
            else override.target_id
            if override is not None
            else fallback_candidate_id
        )
        group_id, group_view = _group_for(
            binding, topics, group_by, backend, authorized_profiles, business_projects
        )
        group_views[group_id] = group_view
        candidate = PriorityCandidate(
            canonical_id=candidate_id,
            group_id=group_id,
            status=WorkStatus.DUE,
            assessment=assessment,
            override=override,
            source_links=tuple(card.get("evidence", ())),
        )
        candidates.append(candidate)
        cards_by_candidate[candidate_id] = card
        metadata[candidate_id] = (assessment, override)

    partitions = partition_and_rank(candidates, now=now, review_id=review_id)
    explanations = {value.canonical_id: value for value in partitions.explanations}
    ordered_candidates = (
        *partitions.urgent_protection,
        *partitions.assessed,
        *partitions.potential_validation,
        *partitions.needs_assessment,
    )
    candidates_by_group: dict[str, list[PriorityCandidate]] = {}
    for candidate in ordered_candidates:
        candidates_by_group.setdefault(candidate.group_id, []).append(candidate)

    groups = []
    for ranked in rank_groups(candidates, now=now, review_id=review_id):
        group_items = []
        for candidate in candidates_by_group[ranked.group_id]:
            card = cards_by_candidate[candidate.canonical_id]
            assessment, override = metadata[candidate.canonical_id]
            explanation = explanations[candidate.canonical_id]
            group_items.append({
                "profile": profile,
                "work_id": card["id"],
                "candidate_id": candidate.canonical_id,
                "eligibility": explanation.eligibility.value,
                "why_here": explanation.why_here,
                "next_step": explanation.next_step,
                "trade_off": explanation.trade_off,
                "assessed_at": explanation.assessed_at,
                "evidence": list(explanation.evidence),
                "assessment": _assessment(assessment),
                "override": _override(override, now, review_id),
            })
        groups.append({
            "id": ranked.group_id,
            "group": group_views[ranked.group_id],
            "eligibility": ranked.eligibility.value,
            "eligible_action_count": ranked.eligible_action_count,
            "why_here": ranked.explanation.why_here,
            "items": group_items,
        })

    return {
        "profile": profile,
        "backend_namespace": backend,
        "sort": "recommended",
        "policy_version": "policy-v1",
        "review_id": review_id,
        "group_by": group_by,
        "groups": groups,
        "as_of": now.isoformat().replace("+00:00", "Z"),
        "coverage": {
            "work": "complete",
            "organization": "complete" if records else "unconfigured",
            "authorization_filtered": nested_authorization_filtered
            or len(bindings)
            != len([value for value in records if isinstance(value, WorkBinding)]),
        },
    }
