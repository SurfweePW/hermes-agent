"""Security and behavior contract for Companion Library RPCs."""
from __future__ import annotations

import base64
import json
import mimetypes
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from hermes_cli.dashboard_auth.ws_tickets import OwnerAuthorizationLease
from tui_gateway import companion_library, server
from tui_gateway.transport import Transport, bind_transport, reset_transport


class OwnerTransport(Transport):
    def __init__(self, authorization: OwnerAuthorizationLease):
        self.companion_owner_authorization = authorization

    def write(self, obj: dict) -> bool:
        del obj
        return True

    def close(self) -> None:
        pass


@pytest.fixture()
def library_context(tmp_path: Path, monkeypatch):
    home = tmp_path / "atlas-home"
    root = tmp_path / "approved-output"
    home.mkdir()
    root.mkdir()
    monkeypatch.setattr(companion_library, "_launch_home", lambda: home)
    monkeypatch.setattr(companion_library, "_owner_identity", lambda value: value)
    monkeypatch.setattr(server, "_current_profile_name", lambda: "atlas")
    monkeypatch.setenv("GATEWAY_RELAY_ID", "library-test-backend")

    def configure(collections=None, *, limits=None):
        value = collections if collections is not None else {
            "docs": {"name": "Documents", "root": str(root)},
        }
        profile_policy = {"collections": value}
        if limits is not None:
            profile_policy["limits"] = limits
        (home / "config.yaml").write_text(
            yaml.safe_dump(
                {
                    "companion_library": {
                        "profiles": {"atlas": profile_policy}
                    }
                }
            ),
            encoding="utf-8",
        )

    configure()
    authorization = OwnerAuthorizationLease("stub:owner", float("inf"))
    return SimpleNamespace(
        home=home,
        root=root,
        configure=configure,
        authorization=authorization,
    )


def call(ctx, operation: str, **params):
    return companion_library.execute(
        server, operation, params, owner_authorization=ctx.authorization
    )


def rpc_call(ctx, operation: str, **params):
    transport = OwnerTransport(ctx.authorization)
    token = bind_transport(transport)
    try:
        return server._methods[f"companion.library.{operation}"]("library-rpc", params)
    finally:
        reset_transport(token)


def test_methods_and_capability_negotiation_are_registered(library_context):
    assert {
        "companion.library.capabilities",
        "companion.library.list",
        "companion.library.get",
        "companion.library.preview",
        "companion.library.download",
        "companion.library.pin_reviewed",
    } <= set(server._methods)
    capability = server._methods["companion.library.capabilities"]("id", {})["result"]
    assert capability == {
        "version": 1,
        "max_page_size": companion_library.MAX_PAGE_SIZE,
        "max_chunk_size": companion_library.MAX_CHUNK_SIZE,
        "download_transport": "authenticated_json_rpc_base64_chunks",
        "transfer_consistency": "signed_immutable_descriptor",
        "html_preview": "sanitized_static_document",
        "relationship_filters": ["collection", "project", "topic", "session", "status"],
        "evidence_pin": "explicit_owner_reviewed_latest",
    }
    token = bind_transport(OwnerTransport(library_context.authorization))
    try:
        aggregate = server._methods["companion.capabilities"]("id", {})["result"]
    finally:
        reset_transport(token)
    assert aggregate["companion.library"]["version"] == 1

    token = bind_transport(None)
    try:
        denied = server._methods["companion.capabilities"]("denied", {})
    finally:
        reset_transport(token)
    assert denied["error"] == {
        "code": 4403,
        "message": "authenticated dashboard owner required",
    }


def test_all_registered_reads_use_bound_owner_authorization(library_context):
    ctx = library_context
    payload = b"RPC route coverage\n"
    (ctx.root / "rpc-route.txt").write_bytes(payload)

    listed = rpc_call(ctx, "list", type="text")["result"]
    artifact_id = listed["items"][0]["artifact_id"]
    assert rpc_call(ctx, "get", artifact_id=artifact_id)["result"]["artifact_id"] == artifact_id
    preview = rpc_call(ctx, "preview", artifact_id=artifact_id, latest=True)["result"]
    download = rpc_call(ctx, "download", artifact_id=artifact_id, latest=True)["result"]
    assert base64.b64decode(preview["data_base64"]) == payload
    assert base64.b64decode(download["data_base64"]) == payload

    for operation, params in (
        ("list", {}),
        ("get", {"artifact_id": artifact_id}),
        ("preview", {"artifact_id": artifact_id, "latest": True}),
        ("download", {"artifact_id": artifact_id, "latest": True}),
    ):
        token = bind_transport(None)
        try:
            denied = server._methods[f"companion.library.{operation}"]("denied", params)
        finally:
            reset_transport(token)
        assert denied["error"]["code"] == 4403


def test_missing_config_is_authenticated_complete_empty_and_does_not_create_storage(
    library_context,
):
    ctx = library_context
    (ctx.home / "config.yaml").unlink()

    result = call(ctx, "list")

    assert result["items"] == []
    assert result["collections"] == []
    assert result["total"] == 0
    assert result["coverage"]["status"] == "unconfigured"
    assert result["coverage"]["configured"] is False
    assert result["warnings"]
    assert not (ctx.home / "retained-artifacts").exists()


def test_explicit_empty_allowlist_scans_nothing_and_does_not_create_storage(
    library_context,
):
    ctx = library_context
    ctx.configure([])

    result = call(ctx, "list")

    assert result["items"] == []
    assert result["collections"] == []
    assert result["total"] == 0
    assert result["coverage"] == {
        "configured": False,
        "status": "unconfigured",
        "collections": {},
    }
    assert result["warnings"] == [
        "No Companion Library collections are configured for this profile; no roots were scanned."
    ]
    assert not (ctx.home / "retained-artifacts").exists()


def test_every_read_requires_live_owner_authorization(library_context, monkeypatch):
    ctx = library_context
    (ctx.root / "private.txt").write_text("private", encoding="utf-8")
    with pytest.raises(companion_library.CompanionLibraryError) as denied:
        companion_library.execute(server, "list", {}, owner_authorization=None)
    assert denied.value.code == 4403

    monkeypatch.setattr(companion_library, "_owner_identity", lambda _value: None)
    with pytest.raises(companion_library.CompanionLibraryError) as revoked:
        call(ctx, "list")
    assert revoked.value.code == 4403


def test_cross_profile_is_denied_before_profile_resolution(library_context, monkeypatch):
    ctx = library_context
    resolved = []
    monkeypatch.setattr(
        companion_library,
        "_resolve_profile_home",
        lambda *_args: resolved.append(True) or ctx.home,
    )

    with pytest.raises(companion_library.CompanionLibraryError) as denied:
        call(ctx, "list", profile="other")

    assert denied.value.code == 4403
    assert resolved == []


def test_malformed_config_fails_closed_without_disclosing_parser_or_path(library_context):
    ctx = library_context
    (ctx.home / "config.yaml").write_text("companion_library: [\n", encoding="utf-8")

    with pytest.raises(companion_library.CompanionLibraryError) as denied:
        call(ctx, "list")

    assert denied.value.code == 4403
    assert str(ctx.home) not in str(denied.value)
    assert "companion_library" not in str(denied.value)
    assert list(ctx.home.glob("config.yaml.corrupt.*.bak")) == []


def test_profile_resource_limits_are_passed_to_artifact_library(library_context):
    ctx = library_context
    limits = {
        "max_file_size": 1024,
        "max_scan_bytes": 2048,
        "max_scan_files": 30,
        "max_scan_depth": 4,
        "max_retained_items": 20,
        "max_retained_bytes": 4096,
        "max_html_preview_size": 512,
    }
    ctx.configure(limits=limits)

    library, _collections = companion_library._authorized_library(server, "atlas")

    assert library is not None
    assert {key: getattr(library, key) for key in limits} == limits


def test_profile_scan_byte_limit_is_enforced_through_rpc(library_context):
    ctx = library_context
    (ctx.root / "one.txt").write_bytes(b"abc")
    (ctx.root / "two.txt").write_bytes(b"def")
    ctx.configure(limits={"max_scan_bytes": 5})

    denied = rpc_call(ctx, "list")

    assert denied["error"] == {"code": 4504, "message": "artifact unavailable"}
    assert str(ctx.root) not in json.dumps(denied)


@pytest.mark.parametrize(
    "limits",
    [
        [],
        {"profile_home": 1},
        {"clock": 1},
        {"unknown_limit": 1},
        {"max_scan_bytes": True},
        {"max_scan_bytes": 1.5},
        {"max_scan_bytes": "1024"},
        {"max_scan_bytes": 0},
        {"max_scan_bytes": -1},
    ],
)
def test_invalid_resource_limit_policy_fails_closed_without_path_disclosure(
    library_context, limits,
):
    ctx = library_context
    ctx.configure(limits=limits)

    denied = rpc_call(ctx, "list")

    assert denied["error"] == {
        "code": 4403,
        "message": "library authorization unavailable",
    }
    assert str(ctx.home) not in json.dumps(denied)
    assert str(ctx.root) not in json.dumps(denied)


@pytest.mark.parametrize("limit_name", sorted(companion_library.LIBRARY_LIMIT_CEILINGS))
def test_resource_limit_policy_rejects_values_above_documented_ceiling(
    library_context, limit_name,
):
    ctx = library_context
    ctx.configure(
        limits={limit_name: companion_library.LIBRARY_LIMIT_CEILINGS[limit_name] + 1}
    )

    denied = rpc_call(ctx, "list")

    assert denied["error"] == {
        "code": 4403,
        "message": "library authorization unavailable",
    }
    assert str(ctx.home) not in json.dumps(denied)


def test_list_search_filter_detail_and_retained_versions_are_profile_namespaced(
    library_context, monkeypatch,
):
    ctx = library_context
    # Python delegates MIME registration to the host OS. Make this contract
    # test deterministic on minimal macOS MIME databases where .md is absent.
    monkeypatch.setitem(mimetypes.types_map, ".md", "text/markdown")
    report = ctx.root / "quarterly-report.md"
    report.write_text("# Q1\n", encoding="utf-8")
    initial = call(ctx, "list", search="quarterly", type="markdown", limit=1)
    item = initial["items"][0]
    assert call(ctx, "list", search="data/cmo/quarterly-report.md")["items"] == [item]
    assert initial["coverage"]["status"] == "complete"
    assert initial["profile"] == "atlas"
    assert initial["backend_namespace"] == "library-test-backend"
    assert initial["total"] == 1
    assert item["collection"]["id"] == "docs"
    assert item["preview"]["kind"] == "markdown"

    library = companion_library._authorized_library(server, "atlas")[0]
    assert library is not None
    pinned_one = library.pin_reviewed(
        "docs", "quarterly-report.md", provenance={"decision_id": "d1"}
    )
    report.write_text("# Q2\n", encoding="utf-8")
    pinned_two = library.pin_reviewed(
        "docs", "quarterly-report.md", provenance={"decision_id": "d2"}
    )

    detail = call(ctx, "get", artifact_id=item["artifact_id"])
    assert detail["artifact_id"] == item["artifact_id"]
    assert {version["version_id"] for version in detail["versions"]} == {
        pinned_one["version_id"],
        pinned_two["version_id"],
    }
    assert detail["latest"]["sha256"] != pinned_one["sha256"]
    encoded = json.dumps({"list": initial, "detail": detail})
    assert str(ctx.root) not in encoded
    assert "token=" not in encoded.lower()
    assert '"url"' not in encoded


def test_cursor_is_bounded_and_bound_to_exact_profile_and_filters(library_context):
    ctx = library_context
    for name in ("a.txt", "b.txt", "c.txt"):
        (ctx.root / name).write_text(name, encoding="utf-8")
    first = call(ctx, "list", type="text", limit=2)
    assert first["has_more"] is True
    second = call(ctx, "list", type="text", limit=2, cursor=first["next_cursor"])
    assert len(first["items"] + second["items"]) == 3
    assert second["as_of"] == first["as_of"]

    with pytest.raises(companion_library.CompanionLibraryError) as mismatch:
        call(ctx, "list", search="different", cursor=first["next_cursor"])
    assert mismatch.value.code == 4006


def test_relationship_status_filters_apply_before_pagination(library_context, monkeypatch):
    ctx = library_context
    for name in ("one.txt", "two.txt", "three.txt"):
        (ctx.root / name).write_text(name, encoding="utf-8")
    library = companion_library._authorized_library(server, "atlas")[0]
    assert library is not None
    monkeypatch.setattr(companion_library, "_relationship_exists", lambda *_args, **_kwargs: True)
    linked = library.pin_reviewed(
        "docs", "one.txt", provenance={"decision": "approved"},
        relationships={
            "projects": [{"id": "project-1", "title": "Project one", "backend_namespace": "library-test-backend", "profile": "atlas"}],
            "topics": [{"id": "topic-1", "backend_namespace": "library-test-backend", "profile": "atlas"}],
            "sessions": [
                {"id": "session-1", "relationship": "primary", "backend_namespace": "library-test-backend", "profile": "atlas"},
                {"id": "session-2", "relationship": "related", "backend_namespace": "library-test-backend", "profile": "atlas"},
            ],
        },
    )

    result = call(
        ctx, "list", project=["missing", "project-1"], topic="topic-1",
        session="session-2", status="reviewed", limit=1,
    )
    assert result["total"] == 1
    assert result["has_more"] is False
    [item] = result["items"]
    assert item["version_id"] == linked["version_id"]
    assert item["reviewed"] is True
    assert item["status"] == "reviewed"
    assert {link["kind"] for link in item["related_links"]} == {
        "project", "topic", "session",
    }

    live = call(ctx, "list", status="live")
    assert {item["filename"] for item in live["items"]} == {"two.txt", "three.txt"}


def test_relationship_resolution_forwards_the_current_owner_lease(
    library_context, monkeypatch,
):
    ctx = library_context
    relationship = {
        "id": "entity-1",
        "backend_namespace": "library-test-backend",
        "profile": "atlas",
    }
    observed = []

    def project_execute(_server, operation, params, *, owner_authorization=None):
        observed.append(("project", operation, params, owner_authorization))
        return {"profile": "atlas", "backend_namespace": "library-test-backend", "id": "entity-1"}

    def topic_execute(_server, operation, params, *, owner_authorization=None):
        observed.append(("topic", operation, params, owner_authorization))
        return {"profile": "atlas", "backend_namespace": "library-test-backend", "id": "entity-1"}

    def session_history(_server, params, *, owner_authorization=None):
        observed.append(("session", "get", params, owner_authorization))
        return {
            "profile": "atlas",
            "backend_namespace": "library-test-backend",
            "identity": {"original_id": "entity-1", "resolved_tip_id": "entity-1"},
        }

    monkeypatch.setattr("tui_gateway.companion_projects.execute", project_execute)
    monkeypatch.setattr("tui_gateway.companion_topics.execute", topic_execute)
    monkeypatch.setattr("tui_gateway.companion_sessions.session_history", session_history)

    assert companion_library._relationship_exists(server, "projects", relationship, profile="atlas", backend="library-test-backend", owner_authorization=ctx.authorization)
    assert companion_library._relationship_exists(server, "topics", relationship, profile="atlas", backend="library-test-backend", owner_authorization=ctx.authorization)
    assert companion_library._relationship_exists(server, "sessions", relationship, profile="atlas", backend="library-test-backend", owner_authorization=ctx.authorization)
    assert [entry[3] for entry in observed] == [ctx.authorization] * 3

    observed.clear()
    (ctx.root / "linked-evidence.txt").write_text("reviewed", encoding="utf-8")
    [item] = call(ctx, "list")['items']
    preview = call(ctx, "preview", artifact_id=item["artifact_id"], latest=True)
    relationships = {
        "projects": [relationship],
        "topics": [relationship],
        "sessions": [{**relationship, "relationship": "primary"}],
    }
    pinned = call(
        ctx,
        "pin_reviewed",
        artifact_id=item["artifact_id"],
        reviewed_descriptor=preview["descriptor"],
        provenance={"review": "linked safe preview"},
        relationships=relationships,
    )

    assert pinned["version"]["relationships"] == relationships
    assert [entry[0] for entry in observed] == ["project", "topic", "session"]
    assert [entry[3] for entry in observed] == [ctx.authorization] * 3


def test_pin_reviewed_is_bound_to_the_safe_previewed_live_fingerprint(library_context):
    ctx = library_context
    source = ctx.root / "review.txt"
    source.write_text("version one", encoding="utf-8")
    [item] = call(ctx, "list")['items']
    preview = call(ctx, "preview", artifact_id=item["artifact_id"], latest=True)

    pinned = call(
        ctx,
        "pin_reviewed",
        artifact_id=item["artifact_id"],
        reviewed_descriptor=preview["descriptor"],
        provenance={"review": "safe preview"},
    )
    assert pinned["version"]["sha256"] == preview["sha256"]

    source.write_text("version two", encoding="utf-8")
    with pytest.raises(companion_library.CompanionLibraryError) as stale:
        call(
            ctx,
            "pin_reviewed",
            artifact_id=item["artifact_id"],
            reviewed_descriptor=preview["descriptor"],
            provenance={"review": "stale preview"},
        )
    assert stale.value.code == 4090

    with pytest.raises(companion_library.CompanionLibraryError) as missing:
        call(
            ctx,
            "pin_reviewed",
            artifact_id=item["artifact_id"],
            provenance={"review": "no preview"},
        )
    assert missing.value.code == -32602


def test_cursor_snapshot_does_not_drop_item_when_earlier_source_disappears(library_context):
    ctx = library_context
    for name in ("a.txt", "b.txt", "c.txt"):
        (ctx.root / name).write_text(name, encoding="utf-8")
    first = call(ctx, "list", limit=1)
    first_name = first["items"][0]["filename"]
    (ctx.root / first_name).unlink()
    remaining = []
    cursor = first["next_cursor"]
    while cursor:
        page = call(ctx, "list", limit=1, cursor=cursor)
        remaining.extend(page["items"])
        cursor = page["next_cursor"]
    assert {first_name, *(item["filename"] for item in remaining)} == {
        "a.txt", "b.txt", "c.txt",
    }


@pytest.mark.parametrize(
    "params",
    [
        {"artifact_id": "../secret"},
        {"artifact_id": "art_../../secret"},
        {"artifact_id": "/etc/passwd"},
        {"artifact_id": "art_" + "g" * 64},
        {"artifact_id": "art_" + "a" * 64, "version_id": "../latest"},
    ],
)
def test_traversal_shaped_identifiers_are_rejected_before_lookup(library_context, params):
    with pytest.raises(companion_library.CompanionLibraryError) as invalid:
        call(library_context, "get", **params)
    assert invalid.value.code == -32602


def test_download_is_explicit_authenticated_bounded_and_has_no_url_or_path_leak(
    library_context,
):
    ctx = library_context
    payload = b"0123456789"
    (ctx.root / "evidence.bin").write_bytes(payload)
    item = call(ctx, "list")["items"][0]

    first = call(
        ctx,
        "download",
        artifact_id=item["artifact_id"],
        latest=True,
        offset=0,
        chunk_size=4,
    )
    second = call(
        ctx,
        "download",
        artifact_id=item["artifact_id"],
        latest=True,
        offset=first["next_offset"],
        chunk_size=companion_library.MAX_CHUNK_SIZE,
        descriptor=first["descriptor"],
    )
    assert base64.b64decode(first["data_base64"]) + base64.b64decode(
        second["data_base64"]
    ) == payload
    assert first["offset"] == 0 and first["next_offset"] == 4
    assert first["eof"] is False and second["eof"] is True
    assert first["size"] == len(payload)
    encoded = json.dumps(first)
    assert str(ctx.root) not in encoded
    assert "token" not in encoded.lower()
    assert "url" not in encoded.lower()

    (ctx.root / "evidence.bin").write_bytes(b"abcdefghij")
    with pytest.raises(companion_library.CompanionLibraryError) as changed:
        call(
            ctx, "download", artifact_id=item["artifact_id"], latest=True,
            offset=first["next_offset"], chunk_size=4,
            descriptor=first["descriptor"],
        )
    assert changed.value.code == 4090

    with pytest.raises(companion_library.CompanionLibraryError):
        call(
            ctx,
            "download",
            artifact_id=item["artifact_id"],
            latest=True,
            chunk_size=companion_library.MAX_CHUNK_SIZE + 1,
        )


def test_live_dates_are_real_instants_and_offset_bounds_are_normalized(library_context):
    ctx = library_context
    source = ctx.root / "dated.txt"
    source.write_text("dated", encoding="utf-8")
    # 2024-01-01T12:00:00Z
    source.touch()
    import os
    os.utime(source, (1704110400, 1704110400))
    [item] = call(
        ctx, "list", date_from="2024-01-01T13:00:00+01:00",
        date_to="2024-01-01T07:00:00-05:00",
    )["items"]
    assert item["date"] == "2024-01-01T12:00:00Z"

def test_preview_uses_sanitized_html_and_never_returns_original_active_document(
    library_context,
):
    ctx = library_context
    original = (
        b'<!doctype html><body onload="steal()"><script>alert(1)</script>'
        b'<a href="https://evil.example/?token=secret">kept</a></body>'
    )
    (ctx.root / "unsafe.html").write_bytes(original)
    item = call(ctx, "list", type="html")["items"][0]

    preview = call(
        ctx,
        "preview",
        artifact_id=item["artifact_id"],
        latest=True,
        chunk_size=companion_library.MAX_CHUNK_SIZE,
    )
    rendered = base64.b64decode(preview["data_base64"])
    lowered = rendered.lower()
    assert preview["preview"]["kind"] == "html"
    assert preview["sandbox"] == ""
    assert preview["scripts"] is False
    assert preview["network"] is False
    assert b"default-src 'none'" in lowered
    assert b"<script" not in lowered
    assert b"onload" not in lowered
    assert b"href=" not in lowered
    assert b"token=secret" not in lowered
    assert b"kept" in rendered
    assert rendered != original


def test_unavailable_root_has_truthful_partial_coverage(library_context):
    ctx = library_context
    missing = ctx.root.parent / "not-mounted"
    ctx.configure({"remote": {"name": "Remote", "root": str(missing)}})

    result = call(ctx, "list")

    assert result["items"] == []
    assert "total" not in result
    assert result["collections"] == [
        {"id": "remote", "name": "Remote", "owner": "atlas", "availability": "unavailable"}
    ]
    assert result["coverage"]["status"] == "partial"
    assert result["coverage"]["collections"] == {"remote": "unavailable"}
    assert result["warnings"]


def test_replaced_root_reports_partial_instead_of_complete_zero(library_context):
    ctx = library_context
    (ctx.root / "allowed.txt").write_bytes(b"allowed")
    library, collections = companion_library._authorized_library(server, "atlas")
    assert library is not None
    profile, backend = "atlas", "library-test-backend"
    ctx.root.rename(ctx.root.parent / "old-approved-output")
    ctx.root.mkdir()
    (ctx.root / "replacement.txt").write_bytes(b"replacement")

    result = companion_library._list(
        server, profile, backend, library, collections, {},
        owner_authorization=ctx.authorization,
    )

    assert result["items"] == []
    assert "total" not in result
    assert result["coverage"]["status"] == "partial"
    assert result["coverage"]["collections"] == {"docs": "unavailable"}
