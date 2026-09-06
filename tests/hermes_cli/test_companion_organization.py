from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json
import sqlite3
from typing import cast

import pytest

import hermes_cli.companion_organization as organization

from hermes_cli.companion_organization import (
    Benefit,
    Burden,
    Capture,
    Confidence,
    CostOfDelay,
    DependencyUnblocking,
    Eligibility,
    OrganizationError,
    OrganizationStore,
    OutcomeAssessment,
    PriorityOverride,
    Reversibility,
    SourceNamespace,
    SourceProjectRef,
    SourceSessionRef,
    Topic,
    BusinessProject,
    WorkBinding,
    WorkStatus,
    PriorityCandidate,
    canonical_json,
    partition_and_rank,
    rank_groups,
)

NOW = datetime(2026, 9, 6, 12, tzinfo=timezone.utc)


def namespace(backend="mac-mini", profile="atlas"):
    return SourceNamespace(backend_id=backend, profile=profile)


def assessment(
    action_id: str,
    *,
    outcome_id: str | None = None,
    benefit=Benefit.HIGH,
    confidence=Confidence.HIGH,
    delay=CostOfDelay.HIGH,
    dependency=DependencyUnblocking.MEDIUM,
    burden=Burden.MEDIUM,
    reversibility=Reversibility.SAFE,
    evidence=("evidence:v1",),
    potential=False,
):
    return OutcomeAssessment(
        id=f"assessment-{action_id}",
        outcome_id=outcome_id or f"outcome-{action_id}",
        action_id=action_id,
        objective="Increase qualified demand",
        time_horizon="this quarter",
        benefit=benefit,
        confidence=confidence,
        cost_of_delay=delay,
        dependency_unblocking=dependency,
        burden=burden,
        reversibility=reversibility,
        evidence=evidence,
        author="agent:atlas",
        assessed_at=NOW.isoformat(),
        next_action_refs=(action_id,),
        potential=potential,
    )


def candidate(action_id: str, *, group="topic:a", status=WorkStatus.ACTIONABLE, **kw):
    return PriorityCandidate(
        canonical_id=action_id,
        group_id=group,
        status=status,
        assessment=kw.pop("assessment", assessment(action_id)),
        **kw,
    )


def test_namespace_identity_never_merges_equal_titles_paths_or_source_ids():
    first = SourceProjectRef(namespace("backend-a", "atlas"), "same-id", "desktop_project")
    second = SourceProjectRef(namespace("backend-b", "atlas"), "same-id", "desktop_project")
    third = SourceProjectRef(namespace("backend-a", "hoffee"), "same-id", "desktop_project")

    assert len({first.canonical_id, second.canonical_id, third.canonical_id}) == 3
    assert first.canonical_id == SourceProjectRef(
        namespace("backend-a", "atlas"), "same-id", "desktop_project"
    ).canonical_id
    assert "A project title" not in first.canonical_id

    spaced = SourceProjectRef(namespace(" backend-a ", "atlas"), "same-id", "desktop_project")
    assert spaced.canonical_id != first.canonical_id
    assert spaced.namespace.backend_id == " backend-a "


def test_canonical_identity_is_independent_of_ranking_policy_version(monkeypatch):
    source = SourceSessionRef(namespace(), "session-1", "root-1", "tip-1")
    canonical_id = source.canonical_id
    monkeypatch.setattr(organization, "POLICY_VERSION", "policy-v999")
    assert source.canonical_id == canonical_id


def test_capture_keeps_exact_historical_title_when_source_tip_and_title_change(tmp_path):
    store = OrganizationStore(profile_home=tmp_path, profile="atlas", clock=lambda: NOW)
    original = SourceSessionRef(namespace(), "session-1", "lineage-1", "tip-1")
    capture = Capture(
        id="capture-1",
        source_session=original,
        title_at_capture="  Exact Title — v1  ",
        captured_at=NOW.isoformat(),
        verified_deep_link=None,
    )
    stored = store.create_capture(capture, actor="agent:atlas")

    renamed = SourceSessionRef(namespace(), "session-1", "lineage-1", "tip-2")
    assert renamed.canonical_id == original.canonical_id
    assert store.get_capture(stored.id).title_at_capture == "  Exact Title — v1  "
    assert store.get_capture(stored.id).source_session.resolved_tip_id == "tip-1"


def test_mutable_records_use_optimistic_versions_and_auditable_metadata(tmp_path):
    store = OrganizationStore(profile_home=tmp_path, profile="atlas", clock=lambda: NOW)
    topic = store.create_topic(
        Topic(id="topic-1", collection="hoffee", name="Conversion", objective="Improve conversion"),
        actor="human:pawel",
    )
    assert topic.version == 1
    assert topic.created_by == topic.updated_by == "human:pawel"
    assert topic.created_at == topic.updated_at == NOW.isoformat()

    updated = store.update_topic(
        replace(topic, name="Conversion improvements"), expected_version=1, actor="human:pawel"
    )
    assert updated.version == 2
    with pytest.raises(OrganizationError, match="stale"):
        store.update_topic(replace(topic, name="Lost update"), expected_version=1, actor="agent:atlas")

    events = store.audit_events(topic.canonical_id)
    assert [(event["operation"], event["actor"]) for event in events] == [
        ("create", "human:pawel"),
        ("update", "human:pawel"),
    ]


def test_clock_rollback_preserves_update_delete_and_restore_invariants(tmp_path):
    clock = [NOW]
    store = OrganizationStore(
        profile_home=tmp_path / "source", profile="atlas", clock=lambda: clock[0]
    )
    topic = store.create_topic(
        Topic("topic", "business", "Name", "Objective"), actor="human:pawel"
    )
    project = store.create_source_project(
        SourceProjectRef(namespace(), "project", "desktop_project"), actor="system:test"
    )

    clock[0] = NOW + timedelta(seconds=2)
    topic = store.update_topic(
        replace(topic, name="First update"), expected_version=1, actor="human:pawel"
    )
    clock[0] = NOW - timedelta(seconds=1)
    topic = store.update_topic(
        replace(topic, name="After rollback"), expected_version=2, actor="human:pawel"
    )
    store.delete_source_project(
        project.canonical_id, expected_version=1, actor="system:test"
    )

    assert topic.created_at == NOW.isoformat()
    assert topic.updated_at == (NOW + timedelta(seconds=2)).isoformat()
    topic_events = store.audit_events(topic.canonical_id)
    assert [event["occurred_at"] for event in topic_events] == [
        NOW.isoformat(),
        (NOW + timedelta(seconds=2)).isoformat(),
        (NOW + timedelta(seconds=2)).isoformat(),
    ]
    project_events = store.audit_events(project.canonical_id)
    assert project_events[-1]["occurred_at"] == NOW.isoformat()
    assert project_events[-1]["payload"]["created_at"] == NOW.isoformat()
    assert project_events[-1]["payload"]["updated_at"] == NOW.isoformat()

    snapshot = store.export_json()
    restored = OrganizationStore(profile_home=tmp_path / "restored", profile="atlas")
    restored.restore_json(snapshot)
    assert restored.export_json() == snapshot
    assert restored.get_topic(topic.id) == topic
    assert restored.audit_events(project.canonical_id) == project_events


def test_deleted_canonical_identity_cannot_be_recreated_or_break_restore(tmp_path):
    clock = [NOW]
    store = OrganizationStore(
        profile_home=tmp_path / "source", profile="atlas", clock=lambda: clock[0]
    )
    original = store.create_source_project(
        SourceProjectRef(namespace(), "project", "desktop_project"),
        actor="system:test",
    )
    clock[0] = NOW + timedelta(seconds=2)
    store.delete_source_project(
        original.canonical_id, expected_version=1, actor="system:test"
    )
    clock[0] = NOW - timedelta(seconds=1)

    with pytest.raises(OrganizationError, match="identity already exists"):
        store.create_source_project(
            SourceProjectRef(namespace(), "project", "desktop_project"),
            actor="system:test",
        )

    assert [
        (event["operation"], event["version"])
        for event in store.audit_events(original.canonical_id)
    ] == [("create", 1), ("delete", 2)]
    snapshot = store.export_json()
    restored = OrganizationStore(
        profile_home=tmp_path / "restored", profile="atlas"
    )
    restored.restore_json(snapshot)
    assert restored.export_json() == snapshot


def test_store_is_profile_local_stamped_private_and_additively_migrated(tmp_path):
    path = tmp_path / "organization.db"
    store = OrganizationStore(profile_home=tmp_path, profile="atlas")
    assert store.path == path
    assert path.stat().st_mode & 0o777 == 0o600
    with sqlite3.connect(path) as db:
        meta = dict(db.execute("SELECT key, value FROM organization_meta"))
    assert meta["owner_profile"] == "atlas"
    assert int(meta["schema_version"]) >= 1

    with pytest.raises(OrganizationError, match="different profile"):
        OrganizationStore(path=path, profile="other")

    # A future/unknown migration is never silently downgraded or overwritten.
    with sqlite3.connect(path) as db:
        db.execute("UPDATE organization_meta SET value='999' WHERE key='schema_version'")
    with pytest.raises(OrganizationError, match="newer schema"):
        OrganizationStore(path=path, profile="atlas")


def test_all_contracts_round_trip_with_deterministic_export_restore(tmp_path):
    store = OrganizationStore(profile_home=tmp_path / "source", profile="atlas", clock=lambda: NOW)
    ns = store.register_namespace(namespace(), actor="system:test")
    source_project = SourceProjectRef(ns, "desktop-project-1", "desktop_project")
    source_session = SourceSessionRef(ns, "session-1", "root-1", "tip-2")
    topic = store.create_topic(
        Topic(
            id="topic-1",
            collection="hoffee",
            name="Marketplace",
            objective="Validate marketplace demand",
            primary_project=source_project,
        ),
        actor="human:pawel",
    )
    business = store.create_business_project(
        BusinessProject("business-1", "hoffee", "New channel", "Test a new sales channel"),
        actor="human:pawel",
    )
    capture = store.create_capture(
        Capture("capture-1", source_session, "Marketplace notes", NOW.isoformat()),
        actor="agent:atlas",
    )
    binding = store.create_work_binding(
        WorkBinding(
            id="binding-1",
            source_namespace=ns,
            work_kind="card",
            source_work_id="card-1",
            primary_topic_id=topic.id,
            primary_session=source_session,
            related_sessions=(source_session,),
            related_topic_ids=(topic.id,),
            source_projects=(source_project,),
            attributed_by="agent:atlas",
        ),
        actor="agent:atlas",
    )
    outcome = store.create_outcome_assessment(assessment("card-1"), actor="agent:atlas")
    override = store.create_priority_override(
        PriorityOverride(
            id="override-1",
            target_id="card-1",
            mode="set_priority",
            label="Founder focus",
            actor="human:pawel",
            reason="Current launch focus",
            created_at=NOW.isoformat(),
            expires_at=(NOW + timedelta(days=7)).isoformat(),
        ),
        actor="human:pawel",
    )

    exported = store.export_json()
    assert exported == canonical_json(json.loads(exported))
    restored = OrganizationStore(profile_home=tmp_path / "restored", profile="atlas")
    restored.restore_json(exported)
    assert restored.export_json() == exported
    assert restored.get_topic(topic.id) == topic
    assert restored.get_business_project(business.id) == business
    assert restored.get_capture(capture.id) == capture
    assert restored.get_work_binding(binding.id) == binding
    assert restored.get_outcome_assessment(outcome.id) == outcome
    assert restored.get_priority_override(override.id) == override


def test_policy_v1_stable_order_uses_explicit_qualitative_dimensions():
    items = [
        candidate("action-z", assessment=assessment("action-z", benefit=Benefit.MEDIUM)),
        candidate("action-medium-confidence", assessment=assessment("action-medium-confidence", confidence=Confidence.MEDIUM)),
        candidate("action-high-burden", assessment=assessment("action-high-burden", burden=Burden.HIGH)),
        candidate("action-a"),
    ]
    ranked = partition_and_rank(reversed(items), now=NOW)
    assert [item.canonical_id for item in ranked.assessed] == [
        "action-a",
        "action-high-burden",
        "action-medium-confidence",
        "action-z",
    ]
    assert partition_and_rank(items, now=NOW) == ranked


def test_high_benefit_low_confidence_is_always_bounded_validation():
    hypothesis = assessment(
        "hypothesis",
        benefit=Benefit.HIGH,
        confidence=Confidence.LOW,
        potential=False,
    )
    result = partition_and_rank(
        [candidate("hypothesis", assessment=hypothesis)], now=NOW
    )

    assert result.assessed == ()
    assert [item.canonical_id for item in result.potential_validation] == [
        "hypothesis"
    ]

    with pytest.raises(OrganizationError, match="bounded validation next action"):
        replace(hypothesis, next_action_refs=())


def test_policy_v1_compares_cost_of_delay_before_confidence():
    confidence_first = candidate(
        "confidence-first",
        assessment=assessment(
            "confidence-first",
            benefit=Benefit.MEDIUM,
            confidence=Confidence.HIGH,
            delay=CostOfDelay.LOW,
        ),
    )
    delay_first = candidate(
        "delay-first",
        assessment=assessment(
            "delay-first",
            benefit=Benefit.MEDIUM,
            confidence=Confidence.LOW,
            delay=CostOfDelay.CRITICAL,
        ),
    )

    ranked = partition_and_rank([delay_first, confidence_first], now=NOW)
    assert [item.canonical_id for item in ranked.assessed] == [
        "delay-first",
        "confidence-first",
    ]


@pytest.mark.parametrize(
    ("winner_dimensions", "loser_dimensions"),
    [
        (
            dict(
                benefit=Benefit.HIGH,
                delay=CostOfDelay.LOW,
                confidence=Confidence.MEDIUM,
                dependency=DependencyUnblocking.NONE,
                burden=Burden.HIGH,
                reversibility=Reversibility.IRREVERSIBLE,
            ),
            dict(
                benefit=Benefit.MEDIUM,
                delay=CostOfDelay.CRITICAL,
                confidence=Confidence.HIGH,
                dependency=DependencyUnblocking.HIGH,
                burden=Burden.LOW,
                reversibility=Reversibility.SAFE,
            ),
        ),
        (
            dict(
                benefit=Benefit.MEDIUM,
                delay=CostOfDelay.CRITICAL,
                confidence=Confidence.LOW,
                dependency=DependencyUnblocking.NONE,
                burden=Burden.HIGH,
                reversibility=Reversibility.IRREVERSIBLE,
            ),
            dict(
                benefit=Benefit.MEDIUM,
                delay=CostOfDelay.HIGH,
                confidence=Confidence.HIGH,
                dependency=DependencyUnblocking.HIGH,
                burden=Burden.LOW,
                reversibility=Reversibility.SAFE,
            ),
        ),
        (
            dict(
                confidence=Confidence.HIGH,
                dependency=DependencyUnblocking.NONE,
                burden=Burden.HIGH,
                reversibility=Reversibility.IRREVERSIBLE,
            ),
            dict(
                confidence=Confidence.MEDIUM,
                dependency=DependencyUnblocking.HIGH,
                burden=Burden.LOW,
                reversibility=Reversibility.SAFE,
            ),
        ),
        (
            dict(
                dependency=DependencyUnblocking.HIGH,
                burden=Burden.HIGH,
                reversibility=Reversibility.IRREVERSIBLE,
            ),
            dict(
                dependency=DependencyUnblocking.MEDIUM,
                burden=Burden.LOW,
                reversibility=Reversibility.SAFE,
            ),
        ),
        (
            dict(burden=Burden.LOW, reversibility=Reversibility.IRREVERSIBLE),
            dict(burden=Burden.MEDIUM, reversibility=Reversibility.SAFE),
        ),
        (
            dict(reversibility=Reversibility.SAFE),
            dict(reversibility=Reversibility.DIFFICULT),
        ),
    ],
)
def test_policy_v1_uses_each_dimension_in_final_lexicographic_order(
    winner_dimensions, loser_dimensions
):
    winner = candidate(
        "winner", assessment=assessment("winner", **winner_dimensions)
    )
    loser = candidate("loser", assessment=assessment("loser", **loser_dimensions))

    ranked = partition_and_rank([loser, winner], now=NOW)
    assert [item.canonical_id for item in ranked.assessed] == ["winner", "loser"]


def test_conflicting_duplicate_candidate_identity_is_rejected_and_identicals_dedupe():
    original = candidate("same")
    conflicting = replace(
        original,
        assessment=assessment("same", confidence=Confidence.LOW),
    )

    assert partition_and_rank([original, original], now=NOW).assessed == (original,)
    for values in ([original, conflicting], [conflicting, original]):
        with pytest.raises(OrganizationError, match="conflicting duplicate canonical_id"):
            partition_and_rank(values, now=NOW)


def test_candidate_validates_status_scalars_and_assessment_action_identity():
    with pytest.raises(OrganizationError, match="invalid status"):
        candidate("action", status=cast(WorkStatus, True))
    with pytest.raises(OrganizationError, match="action_id must match"):
        candidate("action", assessment=assessment("other-action"))
    with pytest.raises(OrganizationError, match="potential must be boolean"):
        replace(assessment("action"), potential=1)


def test_unknown_potential_and_ineligible_are_distinct_and_never_promoted():
    unknown = assessment(
        "unknown",
        benefit=Benefit.UNKNOWN,
        confidence=Confidence.UNKNOWN,
        delay=CostOfDelay.UNKNOWN,
        dependency=DependencyUnblocking.UNKNOWN,
        burden=Burden.UNKNOWN,
        reversibility=Reversibility.UNKNOWN,
    )
    potential = assessment("validate", confidence=Confidence.LOW, potential=True)
    items = [
        candidate("unknown", assessment=unknown),
        candidate("validate", assessment=potential),
        candidate("missing", assessment=None),
        candidate("snoozed", status=WorkStatus.SNOOZED),
        candidate("declined", status=WorkStatus.DECLINED),
        candidate("completed", status=WorkStatus.COMPLETED),
    ]
    result = partition_and_rank(items, now=NOW)
    assert [item.canonical_id for item in result.potential_validation] == ["validate"]
    assert [item.canonical_id for item in result.needs_assessment] == ["missing", "unknown"]
    assert {item.canonical_id for item in result.ineligible} == {
        "snoozed",
        "declined",
        "completed",
    }
    assert result.assessed == ()


def test_potential_with_unknown_dimensions_still_needs_assessment():
    incomplete = assessment(
        "incomplete-validation", potential=True, burden=Burden.UNKNOWN
    )
    result = partition_and_rank(
        [candidate("incomplete-validation", assessment=incomplete)], now=NOW
    )
    assert result.potential_validation == ()
    assert [item.canonical_id for item in result.needs_assessment] == [
        "incomplete-validation"
    ]


def test_verified_urgent_alerts_are_separate_and_override_cannot_hide_or_revive(tmp_path):
    active_override = PriorityOverride(
        id="pin-1",
        target_id="declined",
        mode="pin_review",
        label="Review pin",
        actor="human:pawel",
        reason="Look again",
        created_at=NOW.isoformat(),
        review_id="weekly-1",
        review_at=(NOW + timedelta(hours=1)).isoformat(),
    )
    urgent = candidate("urgent", urgent_verified=True)
    declined = candidate("declined", status=WorkStatus.DECLINED, override=active_override)
    ordinary = candidate("ordinary")

    result = partition_and_rank([declined, ordinary, urgent], now=NOW)
    assert [item.canonical_id for item in result.urgent_protection] == ["urgent"]
    assert [item.canonical_id for item in result.assessed] == ["ordinary"]
    assert [item.canonical_id for item in result.ineligible] == ["declined"]
    assert result.ineligible[0].override.label == "Review pin"


@pytest.mark.parametrize("status", list(WorkStatus))
def test_verified_urgent_alert_remains_visible_regardless_of_lifecycle_status(status):
    urgent = candidate(f"urgent-{status.value}", status=status, urgent_verified=True)

    result = partition_and_rank([urgent], now=NOW)

    assert result.urgent_protection == (urgent,)
    assert result.ineligible == ()
    assert result.explanations[0].eligibility is Eligibility.URGENT_PROTECTION
    assert rank_groups([urgent], now=NOW)[0].highest_action == urgent


@pytest.mark.parametrize(
    "status",
    [
        WorkStatus.SNOOZED,
        WorkStatus.DECLINED,
        WorkStatus.COMPLETED,
        WorkStatus.BLOCKED,
    ],
)
def test_unverified_urgency_cannot_bypass_lifecycle_gates(status):
    item = candidate(f"unverified-{status.value}", status=status, urgent_verified=False)

    result = partition_and_rank([item], now=NOW)

    assert result.urgent_protection == ()
    assert result.ineligible == (item,)


def test_expired_override_is_advisory_and_pins_only_reorder_same_eligible_partition():
    expired = PriorityOverride(
        "old", "b", "set_priority", "Old", "human:pawel", "Expired focus",
        created_at=NOW.isoformat(), expires_at=(NOW - timedelta(seconds=1)).isoformat()
    )
    active = replace(expired, id="new", target_id="c", expires_at=(NOW + timedelta(days=1)).isoformat())
    ranked = partition_and_rank(
        [candidate("a"), candidate("b", override=expired), candidate("c", override=active)], now=NOW
    )
    assert [item.canonical_id for item in ranked.assessed] == ["c", "a", "b"]


def test_review_pin_is_scoped_to_matching_review_and_never_perpetually_active():
    pin = PriorityOverride(
        "pin", "b", "pin_review", "Review", "human:pawel", "Review focus",
        created_at=NOW.isoformat(), review_id="weekly-1",
        review_at=(NOW + timedelta(hours=1)).isoformat(),
    )
    items = [candidate("a"), candidate("b", override=pin)]

    assert [item.canonical_id for item in partition_and_rank(
        items, now=NOW, review_id="weekly-1"
    ).assessed] == ["b", "a"]
    assert [item.canonical_id for item in partition_and_rank(
        items, now=NOW, review_id="weekly-2"
    ).assessed] == ["a", "b"]
    assert not pin.active_at(datetime(2100, 1, 1, tzinfo=timezone.utc))
    with pytest.raises(OrganizationError, match="timezone-aware"):
        pin.active_at(datetime(2026, 9, 6, 12))


def test_override_modes_require_their_own_expiry_or_review_scope():
    with pytest.raises(OrganizationError, match="pin_review.*review_id"):
        PriorityOverride(
            "pin", "a", "pin_review", "Review", "human:pawel", "Focus",
            expires_at=(NOW + timedelta(days=1)).isoformat()
        )
    with pytest.raises(OrganizationError, match="review_at"):
        PriorityOverride(
            "pin", "a", "pin_review", "Review", "human:pawel", "Focus",
            review_id="weekly-1"
        )
    with pytest.raises(OrganizationError, match="set_priority.*expiry"):
        PriorityOverride(
            "priority", "a", "set_priority", "Focus", "human:pawel", "Focus",
            review_id="weekly-1"
        )


def test_group_rank_uses_highest_unique_eligible_action_without_summing_or_link_inflation():
    best = candidate("best", group="topic-b")
    weaker = candidate(
        "weaker",
        group="topic-a",
        assessment=assessment("weaker", benefit=Benefit.MEDIUM),
        source_links=("session:1",),
    )
    split_same_outcome = candidate(
        "split",
        group="topic-a",
        assessment=assessment("split", outcome_id="outcome-weaker", benefit=Benefit.MEDIUM),
        source_links=("session:1", "session:2", "session:3"),
    )
    duplicated_link = replace(weaker, source_links=("session:1", "session:2", "session:2"))

    baseline = rank_groups([best, weaker], now=NOW)
    inflated = rank_groups([split_same_outcome, best, weaker], now=NOW)
    assert [group.group_id for group in baseline] == ["topic-b", "topic-a"]
    assert [group.group_id for group in inflated] == ["topic-b", "topic-a"]
    assert inflated[1].highest_action.canonical_id == "split"
    assert inflated[1].eligible_action_count == 1
    assert duplicated_link.source_links == ("session:1", "session:2")
    with pytest.raises(OrganizationError, match="conflicting duplicate canonical_id"):
        rank_groups([duplicated_link, weaker], now=NOW)

    favorable_split = replace(
        split_same_outcome,
        assessment=assessment(
            "split", outcome_id="outcome-weaker", benefit=Benefit.HIGH,
            burden=Burden.LOW,
        ),
    )
    with pytest.raises(OrganizationError, match="conflicting duplicate outcome_id"):
        rank_groups([weaker, favorable_split], now=NOW)

    for field, value in (
        ("status", WorkStatus.DUE),
        ("urgent_verified", True),
    ):
        conflicting = replace(split_same_outcome, **{field: value})
        for values in ([weaker, conflicting], [conflicting, weaker]):
            with pytest.raises(OrganizationError, match="conflicting duplicate outcome_id"):
                rank_groups(values, now=NOW)


def test_ranking_outputs_include_evidence_linked_explanations():
    assessed = candidate("action")
    missing = candidate("missing", assessment=None, source_links=("session:1",))
    partitions = partition_and_rank([missing, assessed], now=NOW)
    explanations = {item.canonical_id: item for item in partitions.explanations}

    assert explanations["action"].eligibility is Eligibility.ASSESSED
    assert "benefit high" in explanations["action"].why_here
    assert explanations["action"].next_step == "action"
    assert explanations["action"].assessed_at == NOW.isoformat()
    assert explanations["action"].evidence == ("evidence:v1",)
    assert explanations["missing"].evidence == ("session:1",)
    assert rank_groups([assessed], now=NOW)[0].explanation == explanations["action"]


def test_source_refs_are_durable_versioned_and_audited(tmp_path):
    store = OrganizationStore(profile_home=tmp_path, profile="atlas", clock=lambda: NOW)
    project = store.create_source_project(
        SourceProjectRef(namespace(), "project-1", "desktop_project"), actor="system:test"
    )
    session = store.create_source_session(
        SourceSessionRef(namespace(), "session-1", "root-1", "tip-1"), actor="system:test"
    )
    assert project.version == session.version == 1
    assert store.get_source_project(project.canonical_id) == project

    refreshed = store.update_source_session(
        replace(session, resolved_tip_id="tip-2"),
        expected_version=1,
        actor="system:refresh",
    )
    assert refreshed.version == 2
    assert refreshed.canonical_id == session.canonical_id
    assert [event["operation"] for event in store.audit_events(session.canonical_id)] == [
        "create", "update"
    ]
    store.delete_source_project(
        project.canonical_id, expected_version=1, actor="system:refresh"
    )
    with pytest.raises(OrganizationError, match="not found"):
        store.get_source_project(project.canonical_id)
    assert [event["operation"] for event in store.audit_events(project.canonical_id)] == [
        "create", "delete"
    ]
    snapshot = store.export_json()
    restored = OrganizationStore(
        profile_home=tmp_path / "restored", profile="atlas", clock=lambda: NOW
    )
    restored.restore_json(snapshot)
    assert restored.export_json() == snapshot
    assert restored.get_source_session(session.canonical_id) == refreshed
    assert restored.audit_events(project.canonical_id)[-1]["payload"]["version"] == 2


def test_outcome_identity_prevents_duplicate_benefit_attribution(tmp_path):
    store = OrganizationStore(profile_home=tmp_path, profile="atlas", clock=lambda: NOW)
    first = assessment("action-1", outcome_id="shared-outcome")
    split = assessment("action-2", outcome_id="shared-outcome")
    stored = store.create_outcome_assessment(first, actor="agent:atlas")

    assert stored.canonical_id == split.canonical_id
    with pytest.raises(OrganizationError, match="already exists"):
        store.create_outcome_assessment(split, actor="agent:atlas")


def test_restore_recommended_deactivates_override_with_audit(tmp_path):
    store = OrganizationStore(profile_home=tmp_path, profile="atlas", clock=lambda: NOW)
    override = store.create_priority_override(
        PriorityOverride(
            "override", "action", "set_priority", "Focus", "human:pawel", "Launch",
            expires_at=(NOW + timedelta(days=1)).isoformat()
        ),
        actor="human:pawel",
    )

    removed = store.restore_recommended(
        override.id, expected_version=1, actor="human:pawel"
    )
    assert removed.version == 2
    assert removed.updated_at == NOW.isoformat()
    assert removed.updated_by == "human:pawel"
    with pytest.raises(OrganizationError, match="not found"):
        store.get_priority_override(override.id)
    events = store.audit_events(override.canonical_id)
    assert [event["operation"] for event in events] == [
        "create", "delete"
    ]
    assert events[-1]["version"] == events[-1]["payload"]["version"] == 2

    reopened = OrganizationStore(
        profile_home=tmp_path, profile="atlas", clock=lambda: NOW
    )
    assert reopened.audit_events(override.canonical_id) == events
    with pytest.raises(OrganizationError, match="not found"):
        reopened.get_priority_override(override.id)


def test_restart_preserves_optimistic_versions_and_audit(tmp_path):
    first = OrganizationStore(profile_home=tmp_path, profile="atlas", clock=lambda: NOW)
    topic = first.create_topic(
        Topic("topic", "business", "Name", "Objective"), actor="human:pawel"
    )
    restarted = OrganizationStore(
        profile_home=tmp_path,
        profile="atlas",
        clock=lambda: NOW + timedelta(minutes=1),
    )
    updated = restarted.update_topic(
        replace(topic, name="Updated"), expected_version=1, actor="human:pawel"
    )
    assert updated.version == 2
    with pytest.raises(OrganizationError, match="stale"):
        restarted.update_topic(
            replace(topic, name="Stale"), expected_version=1, actor="human:pawel"
        )
    assert [event["version"] for event in restarted.audit_events(topic.canonical_id)] == [1, 2]


def test_local_identity_collision_uses_public_error_taxonomy(tmp_path):
    store = OrganizationStore(profile_home=tmp_path, profile="atlas", clock=lambda: NOW)
    first = WorkBinding(
        id="binding",
        source_namespace=namespace(),
        work_kind="card",
        source_work_id="card-1",
        primary_topic_id=None,
        attributed_by="agent:atlas",
    )
    second = replace(first, source_work_id="card-2")
    store.create_work_binding(first, actor="agent:atlas")
    with pytest.raises(OrganizationError, match="local id already exists"):
        store.create_work_binding(second, actor="agent:atlas")


def test_cross_profile_rejection_precedes_migration_and_makes_no_changes(tmp_path):
    path = tmp_path / "organization.db"
    with sqlite3.connect(path) as db:
        db.execute(
            "CREATE TABLE organization_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        )
        db.executemany(
            "INSERT INTO organization_meta VALUES(?, ?)",
            [("owner_profile", "atlas"), ("schema_version", "0")],
        )

    def state():
        with sqlite3.connect(path) as db:
            return (
                list(db.execute("SELECT type,name,sql FROM sqlite_master ORDER BY name")),
                list(db.execute("SELECT key,value FROM organization_meta ORDER BY key")),
            )

    before = state()
    with pytest.raises(OrganizationError, match="different profile"):
        OrganizationStore(path=path, profile="other")
    assert state() == before


def test_migration_statements_rollback_as_one_transaction(tmp_path):
    path = tmp_path / "organization.db"
    with sqlite3.connect(path) as db:
        db.execute(
            "CREATE TABLE organization_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        )
        db.executemany(
            "INSERT INTO organization_meta VALUES(?, ?)",
            [("owner_profile", "atlas"), ("schema_version", "0")],
        )
        db.execute("CREATE VIEW organization_audit AS SELECT 1 AS sequence")

    with pytest.raises(OrganizationError, match="migration failed"):
        OrganizationStore(path=path, profile="atlas")
    with sqlite3.connect(path) as db:
        assert db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_records'"
        ).fetchone() is None
        assert db.execute(
            "SELECT value FROM organization_meta WHERE key='schema_version'"
        ).fetchone()[0] == "0"


def test_reads_do_not_request_sqlite_write_reservations(tmp_path, monkeypatch):
    store = OrganizationStore(profile_home=tmp_path, profile="atlas", clock=lambda: NOW)
    topic = store.create_topic(
        Topic("topic", "business", "Name", "Objective"), actor="human:pawel"
    )
    original_connect = store._connect

    def fast_connect():
        db = original_connect()
        db.execute("PRAGMA busy_timeout=100")
        return db

    monkeypatch.setattr(store, "_connect", fast_connect)
    holder = sqlite3.connect(store.path, isolation_level=None)
    holder.execute("BEGIN IMMEDIATE")
    try:
        assert store.get_topic(topic.id) == topic
        assert len(store.audit_events(topic.canonical_id)) == 1
        assert json.loads(store.export_json())["records"][0]["local_id"] == topic.id
    finally:
        holder.rollback()
        holder.close()


def test_restore_rejects_inconsistent_envelopes_atomically(tmp_path):
    source = OrganizationStore(
        profile_home=tmp_path / "source", profile="atlas", clock=lambda: NOW
    )
    source.create_topic(
        Topic("topic", "business", "Name", "Objective"), actor="human:pawel"
    )
    original = json.loads(source.export_json())

    corruptions = []
    wrong_record_version = json.loads(json.dumps(original))
    wrong_record_version["records"][0]["version"] = 7
    corruptions.append(wrong_record_version)
    wrong_record_actor = json.loads(json.dumps(original))
    wrong_record_actor["records"][0]["updated_by"] = "agent:other"
    corruptions.append(wrong_record_actor)
    wrong_audit_payload = json.loads(json.dumps(original))
    wrong_audit_payload["audit"][0]["payload"]["version"] = 7
    corruptions.append(wrong_audit_payload)
    wrong_audit_operation = json.loads(json.dumps(original))
    wrong_audit_operation["audit"][0]["operation"] = "delete"
    corruptions.append(wrong_audit_operation)
    wrong_audit_created_by = json.loads(json.dumps(original))
    wrong_audit_created_by["audit"][0]["payload"]["created_by"] = "agent:other"
    wrong_audit_created_by["audit"][0]["payload"]["created_at"] = NOW.isoformat()
    wrong_audit_created_by["audit"][0]["payload"]["updated_at"] = NOW.isoformat()
    wrong_audit_created_by["audit"][0]["payload"]["updated_by"] = "human:pawel"
    corruptions.append(wrong_audit_created_by)
    extra_field = json.loads(json.dumps(original))
    extra_field["records"][0]["unexpected"] = True
    corruptions.append(extra_field)
    boolean_schema_version = json.loads(json.dumps(original))
    boolean_schema_version["schema_version"] = True
    corruptions.append(boolean_schema_version)

    for index, corrupted in enumerate(corruptions):
        target = OrganizationStore(
            profile_home=tmp_path / f"target-{index}", profile="atlas"
        )
        with pytest.raises(OrganizationError):
            target.restore_json(canonical_json(corrupted))
        exported = json.loads(target.export_json())
        assert exported["records"] == []
        assert exported["audit"] == []


def test_restore_rejects_immutable_record_envelope_metadata_mismatch(tmp_path):
    source = OrganizationStore(
        profile_home=tmp_path / "source", profile="atlas", clock=lambda: NOW
    )
    source.create_capture(
        Capture("capture", None, "Exact title", NOW.isoformat()), actor="agent:atlas"
    )
    corrupted = json.loads(source.export_json())
    corrupted["records"][0]["created_by"] = "agent:other"

    target = OrganizationStore(profile_home=tmp_path / "target", profile="atlas")
    with pytest.raises(OrganizationError, match="immutable record metadata"):
        target.restore_json(canonical_json(corrupted))
    assert json.loads(target.export_json())["records"] == []


def test_restore_rejects_forged_priority_override_attribution(tmp_path):
    source = OrganizationStore(
        profile_home=tmp_path / "source", profile="atlas", clock=lambda: NOW
    )
    source.create_priority_override(
        PriorityOverride(
            "override",
            "action",
            "set_priority",
            "Focus",
            "human:pawel",
            "Launch",
            expires_at=(NOW + timedelta(days=1)).isoformat(),
        ),
        actor="human:pawel",
    )
    corrupted = json.loads(source.export_json())
    corrupted["records"][0]["payload"]["actor"] = "human:forged"
    corrupted["audit"][0]["payload"]["actor"] = "human:forged"

    target = OrganizationStore(profile_home=tmp_path / "target", profile="atlas")
    with pytest.raises(OrganizationError, match="override attribution"):
        target.restore_json(canonical_json(corrupted))
    exported = json.loads(target.export_json())
    assert exported["records"] == []
    assert exported["audit"] == []


def test_restore_rejects_audit_only_target_instead_of_mixing_histories(tmp_path):
    source = OrganizationStore(
        profile_home=tmp_path / "source", profile="atlas", clock=lambda: NOW
    )
    source.create_topic(
        Topic("source-topic", "business", "Name", "Objective"), actor="human:pawel"
    )
    target = OrganizationStore(
        profile_home=tmp_path / "target", profile="atlas", clock=lambda: NOW
    )
    project = target.create_source_project(
        SourceProjectRef(namespace(), "project", "desktop_project"), actor="system:test"
    )
    target.delete_source_project(
        project.canonical_id, expected_version=1, actor="system:test"
    )

    with pytest.raises(OrganizationError, match="restore target must be empty"):
        target.restore_json(source.export_json())


def test_validation_rejects_noncanonical_or_unsafe_contract_values():
    with pytest.raises(OrganizationError):
        SourceNamespace("", "atlas")
    with pytest.raises(OrganizationError):
        SourceSessionRef(namespace(), "same", "same", "")
    with pytest.raises(OrganizationError):
        PriorityOverride("x", "y", "force", "label", "actor", "reason", NOW.isoformat())
    with pytest.raises(OrganizationError):
        assessment("x", evidence=("ok", float("nan")))
