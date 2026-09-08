"""Security and behavior contract for Companion Topics RPCs."""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from hermes_cli.dashboard_auth.ws_tickets import OwnerAuthorizationLease
from hermes_cli.companion_organization import (
    Benefit,
    BusinessProject,
    Burden,
    Confidence,
    CostOfDelay,
    DependencyUnblocking,
    OrganizationStore,
    OutcomeAssessment,
    PriorityOverride,
    Reversibility,
    SourceNamespace,
    SourceProjectRef,
    SourceSessionRef,
    Topic,
    WorkBinding,
)
from tui_gateway import companion_priorities, companion_topics, server
from tui_gateway.transport import Transport, bind_transport, reset_transport

NOW = datetime(2026, 9, 6, 12, tzinfo=timezone.utc)


class OwnerTransport(Transport):
    def __init__(self, authorization):
        self.companion_owner_authorization = authorization

    def write(self, obj: dict) -> bool:
        del obj
        return True

    def close(self) -> None:
        pass


@pytest.fixture()
def topics_context(tmp_path: Path, monkeypatch):
    from tui_gateway import companion_library

    home = tmp_path / "atlas"
    home.mkdir()
    authorization = OwnerAuthorizationLease("stub:owner", float("inf"))
    monkeypatch.setattr(
        companion_library,
        "_owner_identity",
        lambda identity: identity if identity == "stub:owner" else None,
    )
    monkeypatch.setattr(
        companion_topics,
        "_require_owner",
        lambda value: "stub:owner"
        if value is authorization
        else (_ for _ in ()).throw(
            companion_topics.CompanionTopicsError(
                "authenticated dashboard owner required", 4403
            )
        ),
    )
    monkeypatch.setattr(
        companion_topics,
        "_profile",
        lambda _server, raw: (
            ("atlas", home)
            if raw in (None, "atlas")
            else (_ for _ in ()).throw(
                companion_topics.CompanionTopicsError(
                    "topics profile unavailable", 4403
                )
            )
        ),
    )
    monkeypatch.setattr(
        companion_topics,
        "_owner_authorized_profiles",
        lambda _server: frozenset({"atlas"}),
    )
    monkeypatch.setenv("GATEWAY_RELAY_ID", "topics-test-backend")
    return SimpleNamespace(home=home, authorization=authorization)


def call(ctx, operation: str, **params):
    return companion_topics.execute(
        server, operation, params, owner_authorization=ctx.authorization
    )


def rpc_call(ctx, operation: str, **params):
    token = bind_transport(OwnerTransport(ctx.authorization))
    try:
        return server._methods[f"companion.topics.{operation}"]("topics-rpc", params)
    finally:
        reset_transport(token)


def seed(ctx, count: int = 3):
    store = OrganizationStore(
        profile_home=ctx.home, profile="atlas", clock=lambda: NOW
    )
    namespace = SourceNamespace("topics-test-backend", "atlas")
    project = SourceProjectRef(namespace, "project-1", "desktop_project")
    session = SourceSessionRef(namespace, "session-1", "root-1", "tip-1")
    topics = []
    for index in range(count):
        topics.append(
            store.create_topic(
                Topic(
                    id=f"topic-{index}",
                    collection="hoffee" if index < count - 1 else "investments",
                    name=f"Topic {index}",
                    objective=f"Outcome objective {index}",
                    lifecycle="archived" if index == count - 1 else "active",
                    primary_project=project if index == 0 else None,
                ),
                actor="human:owner",
            )
        )
    binding = store.create_work_binding(
        WorkBinding(
            id="binding-1",
            source_namespace=namespace,
            work_kind="card",
            source_work_id="card-1",
            primary_topic_id=topics[0].id,
            primary_session=session,
            related_sessions=(session,),
            source_projects=(project,),
            attributed_by="agent:atlas",
        ),
        actor="agent:atlas",
    )
    store.create_outcome_assessment(
        OutcomeAssessment(
            id="assessment-1",
            outcome_id=topics[0].id,
            action_id=binding.source_work_id,
            objective=topics[0].objective,
            time_horizon="this quarter",
            benefit=Benefit.HIGH,
            confidence=Confidence.HIGH,
            cost_of_delay=CostOfDelay.MEDIUM,
            dependency_unblocking=DependencyUnblocking.MEDIUM,
            burden=Burden.LOW,
            reversibility=Reversibility.SAFE,
            evidence=("artifact:v1",),
            author="agent:atlas",
            assessed_at=NOW.isoformat(),
            next_action_refs=("card-1:review",),
        ),
        actor="agent:atlas",
    )
    return topics


def test_methods_and_capability_are_registered(topics_context):
    assert {
        "companion.topics.capabilities",
        "companion.topics.list",
        "companion.topics.get",
    } <= set(server._methods)
    capability = server._methods["companion.topics.capabilities"]("id", {})[
        "result"
    ]
    assert capability["read_only"] is True
    assert capability["pagination"] == "signed_snapshot_cursor"
    token = bind_transport(OwnerTransport(topics_context.authorization))
    try:
        aggregate = server._methods["companion.capabilities"]("id", {})["result"]
    finally:
        reset_transport(token)
    assert aggregate["companion.topics"]["version"] == 1

    token = bind_transport(None)
    try:
        denied = server._methods["companion.capabilities"]("denied", {})
    finally:
        reset_transport(token)
    assert denied["error"] == {
        "code": 4403,
        "message": "authenticated dashboard owner required",
    }


def test_missing_database_is_truthful_empty_and_never_created(topics_context):
    result = call(topics_context, "list")
    assert result["items"] == []
    assert result["total"] == 0
    assert result["coverage"]["status"] == "unconfigured"
    assert result["coverage"]["configured"] is False
    assert result["warnings"]
    assert not (topics_context.home / "organization.db").exists()


def test_owner_is_checked_before_profile_or_database_probe(topics_context, monkeypatch):
    probed = []
    monkeypatch.setattr(
        companion_topics,
        "_profile",
        lambda *_args: probed.append(True),
    )
    with pytest.raises(companion_topics.CompanionTopicsError) as denied:
        companion_topics.execute(server, "list", {}, owner_authorization=None)
    assert denied.value.code == 4403
    assert probed == []


def test_owner_error_is_translated_to_topics_taxonomy(monkeypatch):
    from tui_gateway import companion_library

    monkeypatch.setattr(
        companion_library,
        "_require_owner",
        lambda _authorization: (_ for _ in ()).throw(
            companion_library.CompanionLibraryError("library-only error", 4403)
        ),
    )

    with pytest.raises(companion_topics.CompanionTopicsError) as denied:
        companion_topics._require_owner(None)

    assert denied.value.code == 4403
    assert str(denied.value) == "authenticated dashboard owner required"


def test_rpc_uses_bound_owner_authorization(topics_context):
    seed(topics_context, 1)
    assert rpc_call(topics_context, "list")["result"]["total"] == 1
    token = bind_transport(None)
    try:
        denied = server._methods["companion.topics.list"]("denied", {})
    finally:
        reset_transport(token)
    assert denied["error"]["code"] == 4403


def test_query_filters_apply_before_pagination_across_complete_population(
    topics_context,
):
    seed(topics_context, 7)
    first = call(
        topics_context,
        "list",
        query="outcome objective",
        collection="hoffee",
        lifecycle="active",
        sort="name",
        limit=2,
    )
    gathered = list(first["items"])
    cursor = first["next_cursor"]
    while cursor:
        page = call(
            topics_context,
            "list",
            query="outcome objective",
            collection="hoffee",
            lifecycle="active",
            sort="name",
            limit=2,
            cursor=cursor,
        )
        gathered.extend(page["items"])
        cursor = page["next_cursor"]
    assert [item["name"] for item in gathered] == [f"Topic {i}" for i in range(6)]
    assert first["total"] == 6
    assert first["coverage"]["status"] == "complete"


def test_signed_cursor_fails_closed_on_tamper_and_filter_mismatch(topics_context):
    seed(topics_context, 3)
    first = call(topics_context, "list", limit=1)
    cursor = first["next_cursor"]
    assert cursor
    replacement = "A" if cursor[-1] != "A" else "B"
    with pytest.raises(companion_topics.CompanionTopicsError) as tampered:
        call(topics_context, "list", limit=1, cursor=cursor[:-1] + replacement)
    assert tampered.value.code == 4006
    with pytest.raises(companion_topics.CompanionTopicsError) as mismatch:
        call(topics_context, "list", limit=1, lifecycle="active", cursor=cursor)
    assert mismatch.value.code == 4006


def test_cursor_fails_closed_when_authorized_profile_scope_changes(
    topics_context, monkeypatch
):
    seed(topics_context, 3)
    first = call(topics_context, "list", limit=1)
    monkeypatch.setattr(
        companion_topics,
        "_owner_authorized_profiles",
        lambda _server: frozenset({"atlas", "other"}),
    )

    with pytest.raises(companion_topics.CompanionTopicsError) as denied:
        call(topics_context, "list", limit=1, cursor=first["next_cursor"])

    assert denied.value.code == 4006


def test_detail_has_structured_tabs_and_truthful_unavailable_coverage(topics_context):
    topics = seed(topics_context, 2)
    detail = call(topics_context, "get", id=topics[0].id)
    assert detail["tabs"] == ["overview", "needs_me", "work", "files", "sources"]
    assert detail["overview"]["objective"] == "Outcome objective 0"
    assert detail["overview"]["verified_status"] == {
        "value": "active",
        "verified": True,
        "authority": "organization.topic.lifecycle",
        "observed_at": NOW.isoformat(),
    }
    assert detail["overview"]["next_useful_action"]["references"] == [
        "card-1:review"
    ]
    assert detail["needs_me"]["items"] is None
    assert detail["needs_me"]["coverage"]["status"] == "unavailable"
    assert detail["files"]["items"] is None
    assert "count" not in detail["needs_me"]
    assert detail["work"]["coverage"]["status"] == "partial"
    assert detail["work"]["items"][0]["source_status"]["availability"] == "unknown"
    assert {item["kind"] for item in detail["sources"]["items"]} == {
        "namespace",
        "project",
        "session",
    }
    assert "count" not in detail["sources"]


def test_profile_policy_denies_before_target_resolution(monkeypatch, tmp_path):
    from hermes_cli import profiles
    from tui_gateway import companion_library, companion_projects

    fake_server = SimpleNamespace(_current_profile_name=lambda: "atlas", _load_cfg=lambda: {
        "gateway": {
            "multiplex_profiles": True,
            "multiplex_profile_allowlist": ["atlas"],
        }
    })
    monkeypatch.setattr(
        profiles,
        "profiles_to_serve",
        lambda **_kwargs: [("atlas", tmp_path / "atlas")],
    )
    monkeypatch.setattr(
        companion_library,
        "_profile",
        lambda _server, raw: "atlas" if raw is None else raw,
    )
    resolved = []
    monkeypatch.setattr(
        companion_projects,
        "_resolve_profile",
        lambda *_args: resolved.append(True),
    )

    with pytest.raises(companion_topics.CompanionTopicsError) as denied:
        companion_topics._profile(fake_server, "foreign")

    assert denied.value.code == 4403
    assert str(denied.value) == "topics profile unavailable"
    assert resolved == []


def test_malformed_profile_policy_fails_closed_without_resolution(monkeypatch):
    from tui_gateway import companion_library, companion_projects

    fake_server = SimpleNamespace(
        _current_profile_name=lambda: "atlas",
        _load_cfg=lambda: {"gateway": {"multiplex_profiles": "yes"}},
    )
    monkeypatch.setattr(companion_library, "_profile", lambda _server, raw: raw)
    resolved = []
    monkeypatch.setattr(
        companion_projects,
        "_resolve_profile",
        lambda *_args: resolved.append(True),
    )

    with pytest.raises(companion_topics.CompanionTopicsError) as denied:
        companion_topics._profile(fake_server, "atlas")

    assert denied.value.code == 4403
    assert str(denied.value) == "topics profile unavailable"
    assert resolved == []


def test_foreign_source_refs_are_omitted_and_coverage_is_partial(topics_context):
    ctx = topics_context
    store = OrganizationStore(profile_home=ctx.home, profile="atlas", clock=lambda: NOW)
    local = SourceNamespace("topics-test-backend", "atlas")
    foreign = SourceNamespace("foreign-backend-secret", "foreign-profile-secret")
    foreign_project = SourceProjectRef(
        foreign, "foreign-project-secret", "desktop_project"
    )
    foreign_session = SourceSessionRef(
        foreign,
        "foreign-session-secret",
        "foreign-root-secret",
        "foreign-tip-secret",
    )
    topic = store.create_topic(
        Topic(
            id="topic-filtered",
            collection="security",
            name="Filtered references",
            objective="Do not leak foreign references",
            lifecycle="active",
            primary_project=foreign_project,
        ),
        actor="human:owner",
    )
    store.create_work_binding(
        WorkBinding(
            id="binding-local-origin",
            source_namespace=local,
            work_kind="card",
            source_work_id="local-card",
            primary_topic_id=topic.id,
            primary_session=foreign_session,
            related_sessions=(foreign_session,),
            source_projects=(foreign_project,),
            attributed_by="agent:atlas",
        ),
        actor="agent:atlas",
    )
    store.create_work_binding(
        WorkBinding(
            id="foreign-binding-secret",
            source_namespace=foreign,
            work_kind="card",
            source_work_id="foreign-work-secret",
            primary_topic_id=topic.id,
            attributed_by="agent:foreign",
        ),
        actor="agent:foreign",
    )

    detail = call(ctx, "get", id=topic.id)
    listing = call(ctx, "list", query="Filtered references")
    encoded = json.dumps({"detail": detail, "listing": listing})

    for secret in (
        "foreign-backend-secret",
        "foreign-profile-secret",
        "foreign-project-secret",
        "foreign-session-secret",
        "foreign-root-secret",
        "foreign-tip-secret",
        "foreign-binding-secret",
        "foreign-work-secret",
    ):
        assert secret not in encoded
    assert detail["topic"]["primary_project"] is None
    assert detail["work"]["items"][0]["primary_session"] is None
    assert detail["work"]["items"][0]["related_sessions"] == []
    assert detail["work"]["items"][0]["source_projects"] == []
    assert detail["coverage"]["status"] == "partial"
    assert detail["coverage"]["authorization_filtered"] is True
    assert detail["sources"]["coverage"]["organization_references"] == "partial"
    assert listing["coverage"]["status"] == "partial"
    assert listing["items"][0]["linked_work"]["authorization_filtered"] is True
    assert any("omitted" in warning for warning in detail["warnings"])


def test_foreign_assessment_without_authorized_binding_is_omitted(topics_context):
    ctx = topics_context
    store = OrganizationStore(profile_home=ctx.home, profile="atlas", clock=lambda: NOW)
    local = SourceNamespace("topics-test-backend", "atlas")
    topic = store.create_topic(
        Topic(
            id="topic-assessment-filtered",
            collection="security",
            name="Filtered assessment",
            objective="Do not leak foreign assessments",
            lifecycle="active",
        ),
        actor="human:owner",
    )
    store.create_work_binding(
        WorkBinding(
            id="binding-authorized",
            source_namespace=local,
            work_kind="card",
            source_work_id="authorized-card",
            primary_topic_id=topic.id,
            attributed_by="agent:atlas",
        ),
        actor="agent:atlas",
    )
    store.create_outcome_assessment(
        OutcomeAssessment(
            id="foreign-assessment-secret",
            outcome_id=topic.id,
            action_id="foreign-action-secret",
            objective=topic.objective,
            time_horizon="this quarter",
            benefit=Benefit.HIGH,
            confidence=Confidence.HIGH,
            cost_of_delay=CostOfDelay.MEDIUM,
            dependency_unblocking=DependencyUnblocking.MEDIUM,
            burden=Burden.LOW,
            reversibility=Reversibility.SAFE,
            evidence=("foreign-evidence-secret",),
            author="agent:foreign",
            assessed_at=NOW.isoformat(),
            next_action_refs=("foreign-next-action-secret",),
        ),
        actor="agent:foreign",
    )

    detail = call(ctx, "get", id=topic.id)
    listing = call(ctx, "list", query="Filtered assessment")
    encoded = json.dumps({"detail": detail, "listing": listing})

    for secret in (
        "foreign-assessment-secret",
        "foreign-action-secret",
        "foreign-evidence-secret",
        "foreign-next-action-secret",
    ):
        assert secret not in encoded
    assert detail["overview"]["next_useful_action"]["availability"] == "unknown"
    assert detail["coverage"]["status"] == "partial"
    assert detail["coverage"]["authorization_filtered"] is True
    assert detail["topic"]["linked_work"]["authorization_filtered"] is True
    assert listing["coverage"]["status"] == "partial"
    assert listing["items"][0]["linked_work"]["authorization_filtered"] is True
    assert any("omitted" in warning for warning in detail["warnings"])
    assert any("omitted" in warning for warning in listing["warnings"])


def test_list_and_detail_do_not_modify_organization_database(topics_context):
    topics = seed(topics_context, 2)
    path = topics_context.home / "organization.db"
    before = path.read_bytes()
    before_stat = path.stat()
    call(topics_context, "list", limit=1)
    call(topics_context, "get", id=topics[0].id)
    after_stat = path.stat()
    assert path.read_bytes() == before
    assert after_stat.st_mtime_ns == before_stat.st_mtime_ns
    assert not Path(f"{path}-wal").exists()
    assert not Path(f"{path}-shm").exists()


@pytest.mark.parametrize("group_by", ["session", "project"])
def test_priority_groups_omit_cross_profile_nested_references(group_by):
    local = SourceNamespace("topics-test-backend", "atlas")
    foreign = SourceNamespace("topics-test-backend", "foreign-profile-secret")
    foreign_project = SourceProjectRef(
        foreign, "foreign-project-secret", "desktop_project"
    )
    foreign_session = SourceSessionRef(
        foreign,
        "foreign-session-secret",
        "foreign-root-secret",
        "foreign-tip-secret",
    )
    topic = Topic(
        id="topic",
        collection="security",
        name="Priority security",
        objective="Do not enumerate nested references",
        primary_project=foreign_project,
    )
    binding = WorkBinding(
        id="binding",
        source_namespace=local,
        work_kind="card",
        source_work_id="card",
        primary_topic_id=topic.id,
        primary_session=foreign_session,
        source_projects=(foreign_project,),
        attributed_by="agent:atlas",
    )

    group_id, group = companion_priorities._group_for(
        binding,
        {topic.id: topic},
        group_by,
        "topics-test-backend",
        frozenset({"atlas"}),
    )
    encoded = json.dumps({"id": group_id, "group": group})

    assert group_id in {"session:__none__", "project:__none__"}
    assert group["id"] == "__none__"
    assert "foreign-profile-secret" not in encoded
    assert "foreign-project-secret" not in encoded
    assert "foreign-session-secret" not in encoded


def test_priority_project_group_uses_only_authorized_nested_reference():
    local = SourceNamespace("topics-test-backend", "atlas")
    foreign = SourceNamespace("other-backend-secret", "atlas")
    authorized = SourceProjectRef(local, "local-project", "desktop_project")
    unauthorized = SourceProjectRef(
        foreign, "foreign-project-secret", "desktop_project"
    )
    topic = Topic(
        id="topic",
        collection="security",
        name="Priority",
        objective="Use the authorized project only",
        primary_project=unauthorized,
    )
    binding = WorkBinding(
        id="binding",
        source_namespace=local,
        work_kind="card",
        source_work_id="card",
        primary_topic_id=topic.id,
        source_projects=(unauthorized, authorized),
        attributed_by="agent:atlas",
    )

    group_id, group = companion_priorities._group_for(
        binding,
        {topic.id: topic},
        "project",
        "topics-test-backend",
        frozenset({"atlas"}),
    )

    assert group_id == f"project:{authorized.canonical_id}"
    assert group["id"] == authorized.canonical_id
    assert "foreign-project-secret" not in json.dumps(group)


def test_priority_projection_preserves_override_version_and_finds_unbound_target():
    override = PriorityOverride(
        id="override-unbound",
        target_id="topics-test-backend:atlas:work:card-unbound",
        mode="set_priority",
        label="Do first",
        actor="human:owner",
        reason="Deadline",
        expires_at="2099-01-01T00:00:00+00:00",
        version=3,
    )

    found = companion_priorities._override_for(
        None, None, [override], override.target_id
    )

    assert found is override
    assert companion_priorities._override(found, NOW, None)["version"] == 3


def test_priority_project_group_uses_explicit_business_project_assignment():
    namespace = SourceNamespace("topics-test-backend", "atlas")
    business = BusinessProject(
        id="business-1",
        collection="hoffee",
        name="Launch",
        objective="Ship the launch",
    )
    topic = Topic(
        id="topic",
        collection="hoffee",
        name="Conversion",
        objective="Improve demand",
        primary_business_project_id=business.id,
    )
    binding = WorkBinding(
        id="binding",
        source_namespace=namespace,
        work_kind="card",
        source_work_id="card",
        primary_topic_id=topic.id,
        attributed_by="human:owner",
    )

    group_id, group = companion_priorities._group_for(
        binding,
        {topic.id: topic},
        "project",
        "topics-test-backend",
        frozenset({"atlas"}),
        {business.id: business},
    )

    assert group_id == f"project:{business.canonical_id}"
    assert group == {
        "kind": "project",
        "id": business.canonical_id,
        "name": "Launch",
        "collection": "hoffee",
        "objective": "Ship the launch",
    }
