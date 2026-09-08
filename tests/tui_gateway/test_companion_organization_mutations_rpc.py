"""Owner authorization and mutation contracts for Companion organization RPCs."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import sqlite3
from types import SimpleNamespace

import pytest

from hermes_cli.dashboard_auth.ws_tickets import OwnerAuthorizationLease
from hermes_cli.companion_organization import OrganizationStore
from tui_gateway import companion_organization_mutations, companion_topics, server
from tui_gateway.transport import Transport, bind_transport, reset_transport

NOW = datetime(2026, 9, 8, 10, tzinfo=timezone.utc)


class OwnerTransport(Transport):
    def __init__(self, authorization):
        self.companion_owner_authorization = authorization

    def write(self, obj: dict) -> bool:
        del obj
        return True

    def close(self) -> None:
        pass


@pytest.fixture()
def mutation_context(tmp_path: Path, monkeypatch):
    home = tmp_path / "atlas"
    home.mkdir()
    authorization = OwnerAuthorizationLease("stub:owner", float("inf"))
    monkeypatch.setattr(
        companion_organization_mutations,
        "_require_owner",
        lambda value: "stub:owner"
        if value is authorization
        else (_ for _ in ()).throw(
            companion_organization_mutations.CompanionOrganizationMutationError(
                "authenticated dashboard owner required", 4403
            )
        ),
    )
    monkeypatch.setattr(
        companion_organization_mutations,
        "_profile",
        lambda _server, raw: ("atlas", home)
        if raw in (None, "atlas")
        else (_ for _ in ()).throw(
            companion_topics.CompanionTopicsError("topics profile unavailable", 4403)
        ),
    )
    monkeypatch.setattr(
        companion_organization_mutations,
        "_owner_authorized_profiles",
        lambda _server: frozenset({"atlas"}),
    )
    monkeypatch.setattr(
        companion_organization_mutations,
        "_backend_namespace",
        lambda _server, **_kwargs: "mutation-test-backend",
    )
    monkeypatch.setattr(
        companion_organization_mutations,
        "_launch_home",
        lambda: tmp_path,
    )
    monkeypatch.setattr(
        companion_organization_mutations,
        "_store",
        lambda path, profile: OrganizationStore(path=path, profile=profile, clock=lambda: NOW),
    )
    return SimpleNamespace(home=home, authorization=authorization)


def rpc(ctx, method: str, params: dict, *, authorization=...):
    auth = ctx.authorization if authorization is ... else authorization
    token = bind_transport(OwnerTransport(auth) if auth is not None else None)
    try:
        return server._methods[method](method, params)
    finally:
        reset_transport(token)


def topic_params(**overrides):
    value = {
        "profile": "atlas",
        "id": "topic-1",
        "collection": "hoffee",
        "name": "Conversion",
        "objective": "Improve qualified demand",
        "lifecycle": "active",
        "expected_version": 0,
        "idempotency_key": "topic-create-1",
    }
    value.update(overrides)
    return value


def namespace(profile="atlas", backend_id="mutation-test-backend"):
    return {"backend_id": backend_id, "profile": profile}


def session(profile="atlas", backend_id="mutation-test-backend"):
    return {
        "namespace": namespace(profile, backend_id),
        "persisted_session_id": "session-1",
        "lineage_root_id": "root-1",
        "resolved_tip_id": "tip-1",
    }


def project(profile="atlas", backend_id="mutation-test-backend"):
    return {
        "namespace": namespace(profile, backend_id),
        "source_id": "project-1",
        "kind": "desktop_project",
    }


def test_methods_capabilities_and_owner_gate(mutation_context):
    expected = {
        "companion.topics.create",
        "companion.topics.update",
        "companion.topics.set_lifecycle",
        "companion.bindings.upsert",
        "companion.bindings.remove",
        "companion.priorities.override_set",
        "companion.priorities.restore_recommended",
    }
    assert expected <= set(server._methods)
    capability = server._methods["companion.organization.capabilities"]("cap", {})["result"]
    assert set(capability["mutation_methods"]) == expected
    assert capability["owner_authorization"] is True
    denied = rpc(
        mutation_context,
        "companion.topics.create",
        topic_params(),
        authorization=None,
    )
    assert denied["error"]["code"] == 4403
    assert not (mutation_context.home / "organization.db").exists()


def test_topic_create_update_lifecycle_are_versioned_audited_and_replay_safe(
    mutation_context,
):
    created = rpc(mutation_context, "companion.topics.create", topic_params())["result"]
    replay = rpc(mutation_context, "companion.topics.create", topic_params())["result"]
    assert created["record"]["version"] == 1
    assert replay == {**created, "idempotent": True}

    updated_params = topic_params(
        name="Conversion improvements",
        objective="Increase qualified demand",
        expected_version=1,
        idempotency_key="topic-update-1",
    )
    updated = rpc(mutation_context, "companion.topics.update", updated_params)["result"]
    assert updated["record"]["version"] == 2
    assert updated["record"]["name"] == "Conversion improvements"

    lifecycle = rpc(
        mutation_context,
        "companion.topics.set_lifecycle",
        {
            "profile": "atlas",
            "id": "topic-1",
            "lifecycle": "archived",
            "expected_version": 2,
            "idempotency_key": "topic-lifecycle-1",
        },
    )["result"]
    assert lifecycle["record"]["version"] == 3
    assert lifecycle["record"]["lifecycle"] == "archived"

    store = OrganizationStore(path=mutation_context.home / "organization.db", profile="atlas")
    events = store.audit_events(lifecycle["record"]["canonical_id"])
    assert [event["operation"] for event in events] == ["create", "update", "update"]
    assert all(event["actor"] == "stub:owner" for event in events)


def test_stale_version_and_changed_idempotency_payload_are_rejected(mutation_context):
    rpc(mutation_context, "companion.topics.create", topic_params())
    stale = rpc(
        mutation_context,
        "companion.topics.update",
        topic_params(expected_version=0, idempotency_key="stale-update"),
    )
    assert stale["error"]["code"] == 4090
    conflict = rpc(
        mutation_context,
        "companion.topics.create",
        topic_params(name="Different", idempotency_key="topic-create-1"),
    )
    assert conflict["error"]["code"] == 4090


@pytest.mark.parametrize(
    ("method", "params"),
    (
        ("companion.topics.update", topic_params(id="missing-topic")),
        (
            "companion.business_projects.update",
            {
                "profile": "atlas",
                "id": "missing-project",
                "collection": "hoffee",
                "name": "Missing",
                "objective": "Must not be created by update",
                "expected_version": 0,
                "idempotency_key": "missing-project-update",
            },
        ),
    ),
)
def test_update_methods_never_create_missing_records(mutation_context, method, params):
    response = rpc(mutation_context, method, params)
    assert response["error"]["code"] == 4090


def test_binding_upsert_remove_supports_schema_relationships_and_replay(mutation_context):
    rpc(mutation_context, "companion.topics.create", topic_params())
    params = {
        "profile": "atlas",
        "id": "binding-1",
        "source_namespace": namespace(),
        "work_kind": "card",
        "source_work_id": "card-1",
        "primary_topic_id": "topic-1",
        "primary_session": session(),
        "related_sessions": [session()],
        "related_topic_ids": [],
        "source_projects": [project()],
        "attributed_by": "stub:owner",
        "expected_version": 0,
        "idempotency_key": "binding-upsert-1",
    }
    created = rpc(mutation_context, "companion.bindings.upsert", params)["result"]
    assert created["record"]["version"] == 1
    assert created["record"]["primary_session"]["persisted_session_id"] == "session-1"
    assert rpc(mutation_context, "companion.bindings.upsert", params)["result"]["idempotent"] is True

    removed_params = {
        "profile": "atlas",
        "id": "binding-1",
        "expected_version": 1,
        "idempotency_key": "binding-remove-1",
    }
    removed = rpc(mutation_context, "companion.bindings.remove", removed_params)["result"]
    assert removed["record"]["version"] == 2
    assert removed["removed"] is True
    assert rpc(mutation_context, "companion.bindings.remove", removed_params)["result"]["idempotent"] is True


def test_binding_rejects_non_array_business_project_relationships(mutation_context):
    rpc(mutation_context, "companion.topics.create", topic_params())
    response = rpc(
        mutation_context,
        "companion.bindings.upsert",
        {
            "profile": "atlas",
            "id": "binding-invalid-business-list",
            "source_namespace": namespace(),
            "work_kind": "card",
            "source_work_id": "card-invalid-business-list",
            "primary_topic_id": "topic-1",
            "related_business_project_ids": "",
            "expected_version": 0,
            "idempotency_key": "binding-invalid-business-list",
        },
    )
    assert response["error"]["code"] == -32602


def test_cross_profile_and_cross_backend_references_fail_closed(mutation_context):
    rpc(mutation_context, "companion.topics.create", topic_params())
    base = {
        "profile": "atlas",
        "id": "binding-foreign",
        "source_namespace": namespace(),
        "work_kind": "card",
        "source_work_id": "card-foreign",
        "primary_topic_id": "topic-1",
        "primary_session": None,
        "related_sessions": [],
        "related_topic_ids": [],
        "source_projects": [],
        "attributed_by": "stub:owner",
        "expected_version": 0,
        "idempotency_key": "binding-foreign-1",
    }
    for field, value in (
        ("source_namespace", namespace(profile="foreign")),
        ("primary_session", session(backend_id="foreign-backend")),
        ("source_projects", [project(profile="foreign")]),
    ):
        response = rpc(
            mutation_context,
            "companion.bindings.upsert",
            {**base, field: value, "idempotency_key": f"foreign-{field}"},
        )
        assert response["error"]["code"] == 4403
        assert "foreign" not in response["error"]["message"]


def test_priority_override_set_and_restore_is_owner_attributed_and_reversible(
    mutation_context,
):
    params = {
        "profile": "atlas",
        "id": "override-1",
        "target_id": "card-1",
        "mode": "set_priority",
        "label": "Do first",
        "reason": "Material deadline",
        "expires_at": (NOW + timedelta(days=1)).isoformat(),
        "review_id": None,
        "review_at": None,
        "expected_version": 0,
        "idempotency_key": "override-set-1",
    }
    created = rpc(
        mutation_context, "companion.priorities.override_set", params
    )["result"]
    assert created["record"]["actor"] == "stub:owner"
    assert created["record"]["version"] == 1

    restore_params = {
        "profile": "atlas",
        "id": "override-1",
        "expected_version": 1,
        "idempotency_key": "override-restore-1",
    }
    restored = rpc(
        mutation_context, "companion.priorities.restore_recommended", restore_params
    )["result"]
    assert restored["restored"] is True
    assert restored["record"]["version"] == 2
    assert rpc(
        mutation_context, "companion.priorities.restore_recommended", restore_params
    )["result"]["idempotent"] is True


def test_unauthorized_profile_is_denied_before_store_creation(mutation_context):
    response = rpc(
        mutation_context,
        "companion.topics.create",
        topic_params(profile="other", idempotency_key="other-profile"),
    )
    assert response["error"]["code"] == 4403
    assert not (mutation_context.home / "organization.db").exists()


def test_mutation_store_rejects_symlink_database_path(mutation_context, tmp_path):
    target = tmp_path / "outside.db"
    target.write_bytes(b"not sqlite")
    (mutation_context.home / "organization.db").symlink_to(target)
    response = rpc(
        mutation_context,
        "companion.topics.create",
        topic_params(idempotency_key="path-safety"),
    )
    assert response["error"]["code"] == 5065
    assert target.read_bytes() == b"not sqlite"


def test_mutation_store_rejects_hardlinked_database_path(mutation_context, tmp_path):
    target = tmp_path / "outside-hardlink.db"
    with sqlite3.connect(target) as db:
        db.execute("CREATE TABLE unrelated(value TEXT)")
        db.execute("INSERT INTO unrelated VALUES('preserve me')")
    before = target.read_bytes()
    (mutation_context.home / "organization.db").hardlink_to(target)
    response = rpc(
        mutation_context,
        "companion.topics.create",
        topic_params(idempotency_key="hardlink-path-safety"),
    )
    assert response["error"]["code"] == 5065
    assert target.read_bytes() == before


def test_business_source_capture_and_explicit_business_associations(mutation_context):
    capability = server._methods["companion.organization.capabilities"]("cap", {})[
        "result"
    ]
    record_methods = {
        "companion.business_projects.create",
        "companion.business_projects.update",
        "companion.business_projects.set_lifecycle",
        "companion.source_projects.upsert",
        "companion.source_projects.create",
        "companion.source_projects.update",
        "companion.source_projects.remove",
        "companion.source_sessions.upsert",
        "companion.source_sessions.create",
        "companion.source_sessions.update",
        "companion.source_sessions.remove",
        "companion.captures.create",
    }
    assert set(capability["record_mutation_methods"]) == record_methods
    assert record_methods <= set(server._methods)

    business = rpc(
        mutation_context,
        "companion.business_projects.create",
        {
            "profile": "atlas",
            "id": "business-1",
            "collection": "hoffee",
            "name": "Launch",
            "objective": "Ship the launch",
            "expected_version": 0,
            "idempotency_key": "business-create-1",
        },
    )["result"]
    assert business["record"]["version"] == 1

    source = rpc(
        mutation_context,
        "companion.source_projects.upsert",
        {
            "profile": "atlas",
            **project(),
            "expected_version": 0,
            "idempotency_key": "source-project-1",
        },
    )["result"]
    assert source["record"]["source_id"] == "project-1"

    capture = rpc(
        mutation_context,
        "companion.captures.create",
        {
            "profile": "atlas",
            "id": "capture-1",
            "source_session": session(),
            "title_at_capture": "Exact historical title",
            "captured_at": NOW.isoformat(),
            "created_by": "client:spoofed",
            "expected_version": 0,
            "idempotency_key": "capture-create-1",
        },
    )["result"]
    assert capture["record"]["created_by"] == "stub:owner"

    topic = rpc(
        mutation_context,
        "companion.topics.create",
        topic_params(
            primary_project=project(),
            primary_business_project_id="business-1",
        ),
    )["result"]["record"]
    assert topic["primary_project"]["source_id"] == "project-1"
    assert topic["primary_business_project_id"] == "business-1"

    binding = rpc(
        mutation_context,
        "companion.bindings.upsert",
        {
            "profile": "atlas",
            "id": "binding-business",
            "source_namespace": namespace(),
            "work_kind": "card",
            "source_work_id": "card-business",
            "primary_topic_id": "topic-1",
            "primary_session": None,
            "related_sessions": [],
            "related_topic_ids": [],
            "source_projects": [project()],
            "primary_business_project_id": "business-1",
            "related_business_project_ids": ["business-1"],
            "attributed_by": "client:spoofed",
            "expected_version": 0,
            "idempotency_key": "binding-business-1",
        },
    )["result"]["record"]
    assert binding["attributed_by"] == "stub:owner"
    assert binding["source_projects"][0]["source_id"] == "project-1"
    assert binding["primary_business_project_id"] == "business-1"


SOURCE_REFERENCE_METHODS = {
    "companion.source_projects.create",
    "companion.source_projects.update",
    "companion.source_projects.remove",
    "companion.source_sessions.create",
    "companion.source_sessions.update",
    "companion.source_sessions.remove",
}


def source_params(kind: str, **overrides):
    value = {
        "profile": "atlas",
        **(project() if kind == "project" else session()),
        "expected_version": 0,
        "idempotency_key": f"source-{kind}-create",
    }
    value.update(overrides)
    return value


def test_explicit_source_reference_methods_are_registered_and_owner_only(
    mutation_context,
):
    capability = server._methods["companion.organization.capabilities"]("cap", {})[
        "result"
    ]
    assert SOURCE_REFERENCE_METHODS <= set(capability["record_mutation_methods"])
    assert SOURCE_REFERENCE_METHODS <= set(server._methods)

    denied = rpc(
        mutation_context,
        "companion.source_projects.create",
        source_params("project"),
        authorization=None,
    )
    assert denied["error"]["code"] == 4403
    assert not (mutation_context.home / "organization.db").exists()


@pytest.mark.parametrize("kind", ("project", "session"))
def test_source_reference_create_update_remove_is_versioned_audited_and_replay_safe(
    mutation_context, kind
):
    stem = f"companion.source_{kind}s"
    created_params = source_params(kind)
    created = rpc(mutation_context, f"{stem}.create", created_params)["result"]
    assert created["record"]["version"] == 1
    assert created["record"]["created_by"] == "stub:owner"
    assert created["record"]["updated_by"] == "stub:owner"
    assert rpc(mutation_context, f"{stem}.create", created_params)["result"] == {
        **created,
        "idempotent": True,
    }

    changes = (
        {"resolved_tip_id": "tip-2"}
        if kind == "session"
        else {}
    )
    updated_params = source_params(
        kind,
        **changes,
        expected_version=1,
        idempotency_key=f"source-{kind}-update",
    )
    updated = rpc(mutation_context, f"{stem}.update", updated_params)["result"]
    assert updated["record"]["version"] == 2
    assert updated["record"]["updated_by"] == "stub:owner"
    assert rpc(mutation_context, f"{stem}.update", updated_params)["result"] == {
        **updated,
        "idempotent": True,
    }

    remove_params = source_params(
        kind,
        expected_version=2,
        idempotency_key=f"source-{kind}-remove",
    )
    removed = rpc(mutation_context, f"{stem}.remove", remove_params)["result"]
    assert removed["removed"] is True
    assert removed["record"]["version"] == 3
    assert removed["record"]["updated_by"] == "stub:owner"
    assert rpc(mutation_context, f"{stem}.remove", remove_params)["result"] == {
        **removed,
        "idempotent": True,
    }

    store = OrganizationStore(
        path=mutation_context.home / "organization.db", profile="atlas"
    )
    events = store.audit_events(created["record"]["canonical_id"])
    assert [event["operation"] for event in events] == ["create", "update", "delete"]
    assert [event["version"] for event in events] == [1, 2, 3]
    assert all(event["actor"] == "stub:owner" for event in events)

    recreated = rpc(
        mutation_context,
        f"{stem}.create",
        source_params(kind, idempotency_key=f"source-{kind}-recreate"),
    )
    assert recreated["error"]["code"] == 4090


@pytest.mark.parametrize("kind", ("project", "session"))
@pytest.mark.parametrize("action,expected_version", (("create", 1), ("update", 0), ("remove", 0)))
def test_source_reference_mutations_enforce_operation_versions(
    mutation_context, kind, action, expected_version
):
    response = rpc(
        mutation_context,
        f"companion.source_{kind}s.{action}",
        source_params(
            kind,
            expected_version=expected_version,
            idempotency_key=f"bad-{kind}-{action}",
        ),
    )
    assert response["error"]["code"] == 4090
    assert not (mutation_context.home / "organization.db").exists()


@pytest.mark.parametrize("kind", ("project", "session"))
@pytest.mark.parametrize(
    "scope",
    ({"profile": "foreign"}, {"backend_id": "foreign-backend"}),
)
def test_source_reference_mutations_fail_closed_for_foreign_namespaces(
    mutation_context, kind, scope
):
    reference = project(**scope) if kind == "project" else session(**scope)
    response = rpc(
        mutation_context,
        f"companion.source_{kind}s.create",
        {
            "profile": "atlas",
            **reference,
            "expected_version": 0,
            "idempotency_key": f"foreign-{kind}-{next(iter(scope))}",
        },
    )
    assert response["error"]["code"] == 4403
    assert "foreign" not in response["error"]["message"]
    assert not (mutation_context.home / "organization.db").exists()
