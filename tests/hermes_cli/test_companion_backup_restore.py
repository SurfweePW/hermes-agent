from __future__ import annotations

from argparse import Namespace
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import zipfile

from hermes_cli.artifact_library import ArtifactLibrary
from hermes_cli.backup import run_backup, run_import
from hermes_cli.companion_organization import (
    Capture,
    OrganizationStore,
    SourceNamespace,
    SourceProjectRef,
    SourceSessionRef,
    Topic,
    WorkBinding,
)
from hermes_cli.companion_work_store import WorkStore


NOW = datetime(2026, 9, 6, 12, tzinfo=timezone.utc)
PROFILE = "ac33-profile"


def test_ac33_full_companion_state_survives_isolated_backup_restore(
    tmp_path: Path, monkeypatch
):
    source_home = tmp_path / "source-profile"
    restored_home = tmp_path / "restored-profile"
    fake_user_home = tmp_path / "fake-user"
    source_home.mkdir()
    fake_user_home.mkdir()
    (source_home / "config.yaml").write_text("timezone: UTC\n", encoding="utf-8")

    work = WorkStore(
        source_home / "companion-work.db", PROFILE, clock=lambda: NOW
    )
    card = work.upsert(
        "source:campaign-brief",
        {
            "title": "Review launch evidence",
            "brief": "Representative AC-33 preparation decision.",
            "evidence": ["artifact:launch-evidence"],
            "next_action": "Prepare the approved internal launch brief",
            "owner": "companion-owner",
            "execution_ref": "tracker:launch-brief",
        },
    )["item"]
    card = work.propose(card["id"], card["version"])["item"]
    decided = work.decide(
        card["id"],
        card["version"],
        card["revision"],
        "approve_preparation",
        "ac33-decision",
        reason="Evidence is sufficient for internal preparation.",
        human_identity="human:test-owner",
    )
    expected_work_detail = work.get(card["id"])

    organization = OrganizationStore(
        profile_home=source_home, profile=PROFILE, clock=lambda: NOW
    )
    namespace = organization.register_namespace(
        SourceNamespace("test-backend", PROFILE), actor="system:ac33"
    )
    source_project = organization.create_source_project(
        SourceProjectRef(namespace, "project-123", "desktop_project"),
        actor="system:ac33",
    )
    source_session = organization.create_source_session(
        SourceSessionRef(namespace, "session-123", "lineage-123", "tip-456"),
        actor="system:ac33",
    )
    topic = organization.create_topic(
        Topic(
            "topic-launch",
            "companion",
            "Launch readiness",
            "Prepare a launch backed by retained evidence",
            primary_project=source_project,
        ),
        actor="human:test-owner",
    )
    capture = organization.create_capture(
        Capture(
            "capture-launch",
            source_session,
            "Launch evidence review",
            NOW.isoformat(),
            "hermes://sessions/session-123",
        ),
        actor="agent:companion",
    )
    binding = organization.create_work_binding(
        WorkBinding(
            "binding-launch",
            namespace,
            "companion_card",
            card["id"],
            primary_topic_id=topic.id,
            primary_session=source_session,
            related_sessions=(source_session,),
            related_topic_ids=(topic.id,),
            source_projects=(source_project,),
            attributed_by="agent:companion",
        ),
        actor="agent:companion",
    )
    expected_organization = organization.export_json()

    source_files = tmp_path / "artifact-source"
    source_files.mkdir()
    evidence_bytes = b"AC-33 retained evidence\nexact reviewed bytes\n"
    (source_files / "launch-evidence.md").write_bytes(evidence_bytes)
    library = ArtifactLibrary(
        source_home,
        profile=PROFILE,
        collections=[
            {"id": "evidence", "name": "Reviewed evidence", "root": source_files}
        ],
        clock=lambda: NOW,
    )
    provenance = {
        "decision_id": decided["decision"]["id"],
        "work_card_id": card["id"],
        "binding_id": binding.id,
        "source_session_id": source_session.canonical_id,
    }
    relationships = {
        "projects": [
            {
                "id": source_project.canonical_id,
                "title": "Launch project",
                "backend_namespace": namespace.backend_id,
                "profile": PROFILE,
            }
        ],
        "topics": [
            {
                "id": topic.id,
                "title": topic.name,
                "backend_namespace": namespace.backend_id,
                "profile": PROFILE,
            }
        ],
        "sessions": [
            {
                "id": source_session.canonical_id,
                "title": capture.title_at_capture,
                "relationship": "primary",
                "backend_namespace": namespace.backend_id,
                "profile": PROFILE,
            }
        ],
    }
    pinned = library.pin_reviewed(
        "evidence",
        "launch-evidence.md",
        provenance=provenance,
        relationships=relationships,
        title="Approved launch evidence",
    )
    expected_hash = hashlib.sha256(evidence_bytes).hexdigest()
    assert pinned["sha256"] == expected_hash

    monkeypatch.setattr(Path, "home", lambda: fake_user_home)
    monkeypatch.setenv("HERMES_HOME", str(source_home))
    archive = tmp_path / "ac33-backup.zip"
    run_backup(Namespace(output=str(archive)))

    with zipfile.ZipFile(archive) as backup:
        names = set(backup.namelist())
    assert {
        "companion-work.db",
        "organization.db",
        f"retained-artifacts/{pinned['retained_manifest']}",
        f"retained-artifacts/{pinned['retained_object']}",
    } <= names

    import hermes_cli.gateway as gateway

    monkeypatch.setattr(gateway, "_is_service_running", lambda: True)
    monkeypatch.setenv("HERMES_HOME", str(restored_home))
    run_import(Namespace(zipfile=str(archive), force=True))

    restored_work = WorkStore(
        restored_home / "companion-work.db", PROFILE, clock=lambda: NOW
    )
    assert restored_work.get(card["id"]) == expected_work_detail
    assert restored_work.get(card["id"])["decisions"] == [decided["decision"]]

    restored_organization = OrganizationStore(
        profile_home=restored_home, profile=PROFILE, clock=lambda: NOW
    )
    assert restored_organization.export_json() == expected_organization
    assert restored_organization.get_source_project(source_project.canonical_id) == source_project
    assert restored_organization.get_source_session(source_session.canonical_id) == source_session
    assert restored_organization.get_topic(topic.id) == topic
    assert restored_organization.get_capture(capture.id) == capture
    assert restored_organization.get_work_binding(binding.id) == binding

    restored_library = ArtifactLibrary(
        restored_home, profile=PROFILE, collections=[], clock=lambda: NOW
    )
    [restored_version] = restored_library.list_versions(pinned["artifact_id"])
    assert restored_version == pinned
    assert restored_version["sha256"] == expected_hash
    assert restored_version["size"] == len(evidence_bytes)
    assert restored_version["provenance"] == provenance
    assert restored_version["relationships"] == relationships
    with restored_library.open_version(
        pinned["artifact_id"], pinned["version_id"]
    ) as opened:
        restored_bytes = opened.read()
        assert opened.metadata["provenance"] == provenance
    assert restored_bytes == evidence_bytes
    assert hashlib.sha256(restored_bytes).hexdigest() == expected_hash