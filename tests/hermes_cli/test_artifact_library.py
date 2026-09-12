from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat
from concurrent.futures import ThreadPoolExecutor

import pytest

from hermes_cli.artifact_library import (
    ArtifactLibrary,
    ArtifactSecurityError,
    ArtifactUnavailable,
    classify_preview,
)


def library(
    tmp_path: Path,
    *collections: tuple[str, str, Path],
    **limits,
) -> ArtifactLibrary:
    home = tmp_path / "profile"
    configured = [
        {"id": ident, "name": name, "root": str(root)}
        for ident, name, root in collections
    ]
    return ArtifactLibrary(home, profile="test-profile", collections=configured, **limits)


def test_no_configured_collections_means_no_home_or_hermes_scan(tmp_path, monkeypatch):
    secret = tmp_path / ".hermes" / "config.yaml"
    secret.parent.mkdir()
    secret.write_text("token: secret", encoding="utf-8")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    store = ArtifactLibrary(tmp_path / "profile", profile="test-profile", collections=[])

    assert store.list_collections() == []
    assert store.scan() == []


def test_scan_has_profile_collection_metadata_and_stable_distinct_ids(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir(); b.mkdir()
    (a / "report.md").write_text("one", encoding="utf-8")
    (b / "report.md").write_text("two", encoding="utf-8")
    store = library(tmp_path, ("atlas", "Atlas operations", a), ("hoffee", "HOFFEE", b))

    first = store.scan()
    second = store.scan()

    assert first == second
    assert [item["collection"]["id"] for item in first] == ["atlas", "hoffee"]
    assert all(item["profile"] == "test-profile" for item in first)
    assert first[0]["artifact_id"] != first[1]["artifact_id"]
    assert all("root" not in json.dumps(item) for item in first)


@pytest.mark.parametrize("directory", ["objects", ".staging"])
def test_scan_allows_retained_storage_names_in_collection_paths(tmp_path, directory):
    root = tmp_path / "root"
    nested = root / directory / "reports"
    nested.mkdir(parents=True)
    (nested / "evidence.txt").write_bytes(b"legitimate source")
    store = library(tmp_path, ("safe", "Safe", root))

    [item] = store.scan()

    assert item["relative_path"] == f"{directory}/reports/evidence.txt"
    assert item["sha256"] == hashlib.sha256(b"legitimate source").hexdigest()


def test_missing_configured_root_stays_in_inventory_without_scanning_elsewhere(tmp_path):
    missing = tmp_path / "not-mounted"
    store = library(tmp_path, ("remote", "Remote outputs", missing))
    assert store.list_collections() == [{
        "id": "remote", "name": "Remote outputs", "owner": "test-profile",
        "availability": "unavailable",
    }]
    assert store.scan() == []


@pytest.mark.parametrize("relative", ["../secret.txt", "x/../../secret.txt", "/etc/passwd", "", "."])
def test_traversal_and_non_file_paths_are_rejected(tmp_path, relative):
    root = tmp_path / "root"; root.mkdir()
    store = library(tmp_path, ("safe", "Safe", root))
    with pytest.raises(ArtifactSecurityError):
        store.open_source("safe", relative)


def test_symlink_escape_is_rejected_for_open_and_ingest(tmp_path):
    root = tmp_path / "root"; root.mkdir()
    outside = tmp_path / "outside.txt"; outside.write_bytes(b"secret")
    (root / "escape.txt").symlink_to(outside)
    store = library(tmp_path, ("safe", "Safe", root))

    with pytest.raises(ArtifactSecurityError):
        store.open_source("safe", "escape.txt")
    with pytest.raises(ArtifactSecurityError):
        store.pin_reviewed("safe", "escape.txt", provenance={"decision_id": "d1"})

    nested = root / "nested"
    nested.symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ArtifactSecurityError):
        store.open_source("safe", "nested/outside.txt")


def test_open_fails_closed_when_secure_nofollow_is_unavailable(tmp_path):
    root = tmp_path / "root"; root.mkdir()
    (root / "ordinary.txt").write_bytes(b"not safe without no-follow")

    with pytest.raises(ArtifactSecurityError, match="secure no-follow"):
        ArtifactLibrary._open_regular_under(
            root, "ordinary.txt", nofollow_flag=None
        )


def test_non_regular_file_is_rejected_without_blocking(tmp_path):
    root = tmp_path / "root"; root.mkdir()
    fifo = root / "pipe"
    os.mkfifo(fifo)
    store = library(tmp_path, ("safe", "Safe", root))
    with pytest.raises(ArtifactSecurityError):
        store.open_source("safe", "pipe")


def test_replacement_race_cannot_redirect_final_open(tmp_path, monkeypatch):
    import hermes_cli.artifact_library as module

    root = tmp_path / "root"; root.mkdir()
    victim = root / "report.txt"; victim.write_bytes(b"review me")
    outside = tmp_path / "outside.txt"; outside.write_bytes(b"secret")
    store = library(tmp_path, ("safe", "Safe", root))
    real_open = module.os.open
    replaced = False

    def racing_open(path, flags, *args, **kwargs):
        nonlocal replaced
        if path == "report.txt" and not replaced:
            replaced = True
            victim.unlink()
            victim.symlink_to(outside)
        return real_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(module.os, "open", racing_open)
    with pytest.raises(ArtifactSecurityError):
        store.open_source("safe", "report.txt")


def test_overwrite_retains_reviewed_versions_and_latest_is_explicit(tmp_path):
    root = tmp_path / "root"; root.mkdir()
    source = root / "result.md"; source.write_bytes(b"version one")
    store = library(tmp_path, ("safe", "Safe", root))
    one = store.pin_reviewed("safe", "result.md", provenance={"decision_id": "decision-1"})
    source.write_bytes(b"version two")
    two = store.pin_reviewed("safe", "result.md", provenance={"decision_id": "decision-2"})

    assert one["artifact_id"] == two["artifact_id"]
    assert one["version_id"] != two["version_id"]
    with store.open_version(one["artifact_id"], one["version_id"]) as opened:
        assert opened.read() == b"version one"
        assert opened.metadata["version_id"] == one["version_id"]
    with store.open_latest(one["artifact_id"]) as opened:
        assert opened.read() == b"version two"
        assert opened.metadata["version_id"] != one["version_id"]


def test_reviewed_relationships_are_explicit_durable_and_backward_compatible(tmp_path):
    root = tmp_path / "root"; root.mkdir()
    (root / "evidence.md").write_bytes(b"reviewed evidence")
    store = library(tmp_path, ("safe", "Safe", root))
    relationships = {
        "projects": [{"id": "project-1", "title": "Project one", "backend_namespace": "test-backend", "profile": "test-profile"}],
        "topics": [{"id": "topic-1", "title": "Topic one", "backend_namespace": "test-backend", "profile": "test-profile"}],
        "sessions": [
            {"id": "session-1", "title": "Source", "relationship": "primary", "backend_namespace": "test-backend", "profile": "test-profile"},
            {"id": "session-2", "relationship": "related", "backend_namespace": "test-backend", "profile": "test-profile"},
        ],
    }

    pinned = store.pin_reviewed(
        "safe",
        "evidence.md",
        provenance={"decision": "approved"},
        relationships=relationships,
    )
    assert pinned["relationships"] == relationships
    restarted = library(tmp_path, ("safe", "Safe", root))
    assert restarted.list_versions(pinned["artifact_id"])[0]["relationships"] == relationships

    manifest_path = restarted.storage_root / pinned["retained_manifest"]
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest.pop("relationships")
    manifest.pop("status")
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    legacy = library(tmp_path, ("safe", "Safe", root)).list_versions(pinned["artifact_id"])[0]
    assert legacy["relationships"] == {"projects": [], "topics": [], "sessions": []}
    assert legacy["status"] == "reviewed"


@pytest.mark.parametrize(
    "relationships",
    [
        {"projects": [{"id": "../project"}]},
        {"topics": [{"id": "topic", "url": "file:///etc/passwd"}]},
        {"sessions": [{"id": "session", "relationship": "invented"}]},
        {"unknown": [{"id": "value"}]},
    ],
)
def test_reviewed_relationships_reject_paths_and_unknown_shapes(tmp_path, relationships):
    root = tmp_path / "root"; root.mkdir()
    (root / "evidence.txt").write_bytes(b"evidence")
    store = library(tmp_path, ("safe", "Safe", root))
    with pytest.raises(ValueError, match="relationship"):
        store.pin_reviewed(
            "safe", "evidence.txt", provenance={"decision": "approved"},
            relationships=relationships,
        )


def test_missing_latest_is_unavailable_and_never_substitutes_reviewed_version(tmp_path):
    root = tmp_path / "root"; root.mkdir()
    source = root / "result.pdf"; source.write_bytes(b"%PDF-retained")
    store = library(tmp_path, ("safe", "Safe", root))
    reviewed = store.pin_reviewed("safe", "result.pdf", provenance={"decision_id": "d1"})
    source.unlink()

    detail = store.get_artifact(reviewed["artifact_id"])
    assert detail["latest"]["availability"] == "unavailable"
    with pytest.raises(ArtifactUnavailable) as exc:
        store.open_latest(reviewed["artifact_id"])
    assert exc.value.code == "unavailable"
    with store.open_version(reviewed["artifact_id"], reviewed["version_id"]) as opened:
        assert opened.read() == b"%PDF-retained"
    # Restart while the entire configured source is gone: retained evidence
    # remains available and latest is still explicitly unavailable.
    root.rename(tmp_path / "moved-root")
    reopened = library(tmp_path, ("safe", "Safe", root))
    assert reopened.get_artifact(reviewed["artifact_id"])["latest"]["availability"] == "unavailable"
    with reopened.open_version(reviewed["artifact_id"], reviewed["version_id"]) as opened:
        assert opened.read() == b"%PDF-retained"


def test_preview_policy_is_static_sandboxed_and_unsupported_is_honest():
    html = classify_preview("page.html", "text/html", b"<!doctype html><p>safe</p>")
    assert html["kind"] == "html"
    assert html["sandbox"] == ""
    assert html["scripts"] is False
    assert html["network"] is False
    assert html["app_origin"] is False
    assert "default-src 'none'" in html["content_security_policy"]
    unsupported = classify_preview("sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    assert unsupported == {"kind": "unsupported", "preview_available": False,
                           "message": "Preview unavailable—download original"}


def test_html_preview_returns_sanitized_inert_document_and_download_stays_original(tmp_path):
    root = tmp_path / "root"; root.mkdir()
    original = b"""<!doctype html><html><head>
        <script src="https://evil.example/x.js">alert(1)</script>
        <style>@import 'https://evil.example/x.css';</style>
        <base href="https://evil.example/">
        </head><body onload="steal()">
        <form action="https://evil.example/collect"><input name="secret"></form>
        <a href="https://evil.example/" onclick="steal()">safe label</a>
        <img src="https://evil.example/pixel" onerror="steal()">
        <iframe srcdoc="<script>steal()</script>"></iframe>
        <object data="https://evil.example/o"></object>
        <embed src="https://evil.example/e">
        <p style="background:url(https://evil.example/css)" formaction="/steal">kept text</p>
        </body></html>"""
    (root / "active.html").write_bytes(original)
    store = library(tmp_path, ("safe", "Safe", root))
    artifact_id = store.scan()[0]["artifact_id"]

    with store.open_html_preview(artifact_id) as opened:
        preview = opened.read()
        assert opened.metadata["mime_type"] == "text/html; charset=utf-8"
        assert opened.metadata["sandbox"] == ""
        assert opened.metadata["scripts"] is False
        assert opened.metadata["network"] is False
        assert opened.metadata["app_origin"] is False

    lowered = preview.lower()
    assert b"default-src 'none'" in lowered
    assert b"base-uri 'none'" in lowered
    assert b"form-action 'none'" in lowered
    for forbidden in (
        b"<script", b"<style", b"<form", b"<input", b"<iframe",
        b"<object", b"<embed", b"<img", b" href=", b" src=", b" action=",
        b"onclick", b"onload", b"onerror", b" style=", b"srcdoc",
    ):
        assert forbidden not in lowered
    assert b"safe label" in preview
    assert b"kept text" in preview

    with store.download(artifact_id) as opened:
        assert opened.read() == original


def test_preview_classification_for_supported_types():
    assert classify_preview("README.md", None, b"# Read me\n")["kind"] == "markdown"
    assert classify_preview("README.md", "application/octet-stream", b"# Read me\n")["kind"] == "markdown"
    assert classify_preview("report.json", "application/json", b'{"status":"ready"}\n')["kind"] == "text"
    assert classify_preview("notes.txt", None, b"plain text\n")["kind"] == "text"
    assert classify_preview("photo.png", None, b"\x89PNG\r\n\x1a\nrest")["kind"] == "image"
    assert classify_preview("document.pdf", None, b"%PDF-1.7\n")["kind"] == "pdf"
    assert classify_preview("active.svg", "image/svg+xml", b"<svg/>")["kind"] == "unsupported"


def test_retained_bytes_are_authoritative_and_index_is_rebuildable(tmp_path):
    root = tmp_path / "root"; root.mkdir()
    (root / "a.txt").write_bytes(b"authoritative")
    store = library(tmp_path, ("safe", "Safe", root))
    item = store.pin_reviewed("safe", "a.txt", provenance={"source": "fixture"})
    store.index_path.write_text('{"corrupt": true}', encoding="utf-8")

    rebuilt = store.rebuild_index()
    assert rebuilt["artifacts"][0]["versions"][0]["sha256"] == hashlib.sha256(b"authoritative").hexdigest()
    with store.open_version(item["artifact_id"], item["version_id"]) as opened:
        assert opened.read() == b"authoritative"


def test_private_storage_symlink_is_rejected_without_chmodding_target(tmp_path):
    home = tmp_path / "profile"; home.mkdir()
    target = tmp_path / "outside"; target.mkdir(mode=0o755)
    (home / "retained-artifacts").symlink_to(target, target_is_directory=True)

    with pytest.raises(ArtifactSecurityError, match="not a real directory"):
        ArtifactLibrary(home, profile="test-profile", collections=[])
    assert stat.S_IMODE(target.stat().st_mode) == 0o755


def test_manifest_cannot_redirect_retained_object_lookup(tmp_path):
    root = tmp_path / "root"; root.mkdir()
    (root / "evidence.txt").write_bytes(b"reviewed")
    store = library(tmp_path, ("safe", "Safe", root))
    item = store.pin_reviewed("safe", "evidence.txt", provenance={"source": "fixture"})
    manifest_path = store.storage_root / item["retained_manifest"]
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["retained_object"] = "index.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    assert store.list_versions(item["artifact_id"]) == []


def test_over_nested_manifest_is_ignored_without_hiding_valid_versions(tmp_path):
    root = tmp_path / "root"; root.mkdir()
    (root / "tampered.txt").write_bytes(b"tampered manifest")
    (root / "valid.txt").write_bytes(b"valid manifest")
    store = library(tmp_path, ("safe", "Safe", root))
    tampered = store.pin_reviewed("safe", "tampered.txt", provenance="nest-here")
    valid = store.pin_reviewed("safe", "valid.txt", provenance={"source": "fixture"})

    manifest_path = store.storage_root / tampered["retained_manifest"]
    raw = manifest_path.read_text(encoding="utf-8")
    marker = '"provenance":"nest-here"'
    assert marker in raw
    nested = "[" * 2_000 + "null" + "]" * 2_000
    manifest_path.write_text(
        raw.replace(marker, f'"provenance":{nested}'),
        encoding="utf-8",
    )

    restarted = library(tmp_path, ("safe", "Safe", root))
    assert restarted.list_versions(tampered["artifact_id"]) == []
    assert [item["version_id"] for item in restarted.list_versions(valid["artifact_id"])] == [
        valid["version_id"]
    ]


def test_deterministic_export_and_private_permissions(tmp_path):
    root = tmp_path / "root"; root.mkdir()
    (root / "z.md").write_bytes(b"z")
    (root / "a.md").write_bytes(b"a")
    store = library(tmp_path, ("safe", "Safe", root))
    z = store.pin_reviewed("safe", "z.md", provenance={"b": 2, "a": 1})
    store.pin_reviewed("safe", "a.md", provenance={"source": "fixture"})

    one = store.export_metadata()
    two = store.export_metadata()
    assert one == two
    assert json.dumps(one, sort_keys=True, separators=(",", ":")) == json.dumps(two, sort_keys=True, separators=(",", ":"))
    assert "token=" not in json.dumps(one)
    assert stat.S_IMODE(store.storage_root.stat().st_mode) == 0o700
    assert stat.S_IMODE(store.index_path.stat().st_mode) == 0o600
    manifest = store.storage_root / z["retained_manifest"]
    payload = store.storage_root / z["retained_object"]
    assert stat.S_IMODE(manifest.stat().st_mode) == 0o600
    assert stat.S_IMODE(payload.stat().st_mode) == 0o600


def test_replaced_configured_root_ancestor_cannot_expose_outside_bytes(tmp_path):
    base = tmp_path / "base"
    root = base / "root"
    root.mkdir(parents=True)
    (root / "evidence.txt").write_bytes(b"allowed")
    store = library(tmp_path, ("safe", "Safe", root))

    original = tmp_path / "original-base"
    base.rename(original)
    outside = tmp_path / "outside"
    (outside / "root").mkdir(parents=True)
    (outside / "root" / "evidence.txt").write_bytes(b"outside-secret")
    base.symlink_to(outside, target_is_directory=True)

    with pytest.raises(ArtifactSecurityError):
        store.open_source("safe", "evidence.txt")
    assert store.scan() == []
    assert store.list_collections()[0]["availability"] == "unavailable"


def test_replaced_real_root_inode_is_unavailable_to_inventory_and_scan(tmp_path):
    root = tmp_path / "root"; root.mkdir()
    (root / "allowed.txt").write_bytes(b"allowed")
    store = library(tmp_path, ("safe", "Safe", root))
    root.rename(tmp_path / "old-root")
    root.mkdir()
    (root / "outside.txt").write_bytes(b"replacement")

    assert store.list_collections()[0]["availability"] == "unavailable"
    assert store.scan() == []


def test_symlink_configured_root_is_inventoried_as_rejected_not_followed(tmp_path):
    outside = tmp_path / "outside"; outside.mkdir()
    (outside / "secret.txt").write_bytes(b"secret")
    root = tmp_path / "linked-root"
    root.symlink_to(outside, target_is_directory=True)

    store = library(tmp_path, ("safe", "Safe", root))

    assert store.list_collections()[0]["availability"] == "unavailable"
    assert store.scan() == []


def test_same_byte_pin_is_idempotent_and_safe_under_concurrency(tmp_path):
    root = tmp_path / "root"; root.mkdir()
    (root / "same.txt").write_bytes(b"same bytes")
    store = library(tmp_path, ("safe", "Safe", root))

    def pin(number):
        return store.pin_reviewed(
            "safe", "same.txt", provenance={"attempt": number}
        )

    with ThreadPoolExecutor(max_workers=4) as executor:
        pinned = list(executor.map(pin, range(4)))

    assert len({item["version_id"] for item in pinned}) == 1
    assert len(store.list_versions(pinned[0]["artifact_id"])) == 1


def test_pin_recovers_after_object_commit_but_index_publish_failure(tmp_path, monkeypatch):
    root = tmp_path / "root"; root.mkdir()
    (root / "crash.txt").write_bytes(b"durable")
    store = library(tmp_path, ("safe", "Safe", root))
    real_rebuild = store.rebuild_index
    calls = 0

    def fail_once():
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OSError("simulated crash boundary")
        return real_rebuild()

    monkeypatch.setattr(store, "rebuild_index", fail_once)
    with pytest.raises(OSError, match="crash boundary"):
        store.pin_reviewed("safe", "crash.txt", provenance={"attempt": 1})

    recovered = store.pin_reviewed("safe", "crash.txt", provenance={"attempt": 2})
    assert calls == 2
    persisted = json.loads(store.index_path.read_text(encoding="utf-8"))
    assert persisted["artifacts"][0]["versions"][0]["version_id"] == recovered["version_id"]


def test_idempotent_pin_verifies_existing_retained_object(tmp_path):
    root = tmp_path / "root"; root.mkdir()
    (root / "evidence.txt").write_bytes(b"original")
    store = library(tmp_path, ("safe", "Safe", root))
    pinned = store.pin_reviewed("safe", "evidence.txt", provenance={"attempt": 1})
    (store.storage_root / pinned["retained_object"]).write_bytes(b"tampered")

    with pytest.raises(ArtifactSecurityError, match="identity collision"):
        store.pin_reviewed("safe", "evidence.txt", provenance={"attempt": 2})


def test_file_scan_and_preview_resource_limits_are_enforced(tmp_path):
    root = tmp_path / "root"; root.mkdir()
    (root / "large.txt").write_bytes(b"12345")
    limited = library(tmp_path, ("safe", "Safe", root), max_file_size=4)
    with pytest.raises(ArtifactUnavailable, match="size limit"):
        limited.open_source("safe", "large.txt")
    with pytest.raises(ArtifactUnavailable, match="size limit"):
        limited.scan()

    (root / "large.txt").unlink()
    (root / "a.txt").write_bytes(b"aaa")
    (root / "b.txt").write_bytes(b"bbb")
    count_limited = library(tmp_path, ("safe", "Safe", root), max_scan_files=1)
    with pytest.raises(ArtifactUnavailable, match="file-count"):
        count_limited.scan()
    byte_limited = library(tmp_path, ("safe", "Safe", root), max_scan_bytes=5)
    with pytest.raises(ArtifactUnavailable, match="byte limit"):
        byte_limited.scan()

    html_root = tmp_path / "html-root"; html_root.mkdir()
    (html_root / "page.html").write_bytes(b"<!doctype html><p>&</p>")
    preview_limited = library(
        tmp_path, ("html", "HTML", html_root), max_html_preview_size=64
    )
    artifact_id = preview_limited.scan()[0]["artifact_id"]
    with pytest.raises(ArtifactUnavailable, match="preview exceeds"):
        preview_limited.open_html_preview(artifact_id)


def test_scan_depth_limit_prunes_deeper_files(tmp_path):
    root = tmp_path / "root"; root.mkdir()
    (root / "top.txt").write_bytes(b"top")
    nested = root / "one" / "two"
    nested.mkdir(parents=True)
    (nested / "deep.txt").write_bytes(b"deep")
    store = library(tmp_path, ("safe", "Safe", root), max_scan_depth=1)
    assert [item["relative_path"] for item in store.scan()] == ["top.txt"]


@pytest.mark.parametrize(
    ("filename", "mime_type", "content"),
    [
        ("fake.pdf", "application/pdf", b"not a pdf"),
        ("fake.png", "image/png", b"not a png"),
        ("fake.html", "text/html", b"plain text only"),
        ("fake.txt", "text/plain", b"text\x00binary"),
        ("real.pdf.exe", "application/pdf", b"%PDF-1.7"),
        ("real.pdf", "text/plain", b"%PDF-1.7"),
    ],
)
def test_preview_rejects_suffix_signature_or_type_mismatch(filename, mime_type, content):
    assert classify_preview(filename, mime_type, content) == {
        "kind": "unsupported",
        "preview_available": False,
        "message": "Preview unavailable—download original",
    }


def test_text_preview_validates_the_entire_bounded_file(tmp_path):
    root = tmp_path / "root"; root.mkdir()
    (root / "prefix.txt").write_bytes(b"a" * 5000 + b"\x00binary")
    (root / "too-large.txt").write_bytes(b"plain text")
    store = library(
        tmp_path, ("safe", "Safe", root), max_html_preview_size=6000
    )
    previews = {item["filename"]: item["preview"] for item in store.scan()}
    assert previews["prefix.txt"]["preview_available"] is False

    limited = library(
        tmp_path, ("safe", "Safe", root), max_html_preview_size=5
    )
    limited_previews = {item["filename"]: item["preview"] for item in limited.scan()}
    assert limited_previews["too-large.txt"]["preview_available"] is False


def test_growing_file_is_rejected_during_bounded_read(tmp_path, monkeypatch):
    import hermes_cli.artifact_library as module

    root = tmp_path / "root"; root.mkdir()
    source = root / "growing.txt"
    source.write_bytes(b"start")
    store = library(tmp_path, ("safe", "Safe", root), max_file_size=16)
    real_fstat = module.os.fstat
    regular_fstats = 0

    def racing_fstat(fd):
        nonlocal regular_fstats
        result = real_fstat(fd)
        if stat.S_ISREG(result.st_mode):
            regular_fstats += 1
            if regular_fstats == 2:
                with source.open("ab") as handle:
                    handle.write(b"-growth")
        return result

    monkeypatch.setattr(module.os, "fstat", racing_fstat)
    with pytest.raises(ArtifactUnavailable, match="changed"):
        store.open_source("safe", "growing.txt")


def test_open_source_closes_descriptor_when_metadata_read_fails(tmp_path, monkeypatch):
    root = tmp_path / "root"; root.mkdir()
    source = root / "evidence.txt"
    source.write_bytes(b"evidence")
    store = library(tmp_path, ("safe", "Safe", root))
    handle = source.open("rb")

    monkeypatch.setattr(store, "_open_regular_at", lambda *_args, **_kwargs: handle)

    def fail_metadata(*_args, **_kwargs):
        raise ArtifactUnavailable("simulated read failure")

    monkeypatch.setattr(store, "_live_metadata", fail_metadata)
    with pytest.raises(ArtifactUnavailable, match="simulated read failure"):
        store.open_source("safe", "evidence.txt")
    assert handle.closed


def test_persisted_export_is_identical_after_restart(tmp_path):
    root = tmp_path / "root"; root.mkdir()
    (root / "evidence.md").write_bytes(b"# Evidence\n")
    store = library(tmp_path, ("safe", "Safe", root))
    store.pin_reviewed("safe", "evidence.md", provenance={"decision": "approved"})
    expected = store.index_path.read_bytes()

    restarted = library(tmp_path, ("safe", "Safe", root))
    restarted.export_metadata()
    assert restarted.index_path.read_bytes() == expected


def test_replaced_retained_root_cannot_redirect_any_storage_operation(tmp_path):
    root = tmp_path / "root"; root.mkdir()
    (root / "evidence.txt").write_bytes(b"immutable evidence")
    store = library(tmp_path, ("safe", "Safe", root))
    pinned = store.pin_reviewed(
        "safe", "evidence.txt", provenance={"decision": "approved"}
    )

    displaced = tmp_path / "displaced-retained"
    store.storage_root.rename(displaced)
    outside = tmp_path / "outside-retained"; outside.mkdir()
    store.storage_root.symlink_to(outside, target_is_directory=True)

    with pytest.raises(ArtifactSecurityError):
        store.pin_reviewed(
            "safe", "evidence.txt", provenance={"decision": "second"}
        )
    with pytest.raises(ArtifactSecurityError):
        store.rebuild_index()
    with pytest.raises(ArtifactSecurityError):
        store.open_version(pinned["artifact_id"], pinned["version_id"])
    assert list(outside.iterdir()) == []
    assert (displaced / pinned["retained_object"]).read_bytes() == b"immutable evidence"


@pytest.mark.parametrize("directory", ["objects", ".staging"])
def test_replaced_retained_storage_child_is_denied(tmp_path, directory):
    root = tmp_path / "root"; root.mkdir()
    (root / "evidence.txt").write_bytes(b"immutable evidence")
    store = library(tmp_path, ("safe", "Safe", root))

    retained_child = store.storage_root / directory
    retained_child.rename(store.storage_root / f"displaced-{directory}")
    retained_child.mkdir(mode=0o700)

    with pytest.raises(ArtifactSecurityError, match="directory was replaced"):
        store.pin_reviewed(
            "safe", "evidence.txt", provenance={"decision": "approved"}
        )


@pytest.mark.parametrize(
    ("provenance", "title", "message"),
    [
        ({"note": "💣" * 20_000}, None, "byte limit"),
        ({"nested": [[[[[[[[["too deep"]]]]]]]]]}, None, "depth limit"),
        ({"items": list(range(300))}, None, "item-count limit"),
        ({"ok": True}, "💣" * 2_000, "metadata limit"),
    ],
)
def test_pin_rejects_oversized_or_structurally_unbounded_metadata(
    tmp_path, provenance, title, message
):
    root = tmp_path / "root"; root.mkdir()
    (root / "evidence.txt").write_bytes(b"evidence")
    store = library(tmp_path, ("safe", "Safe", root))

    with pytest.raises(ValueError, match=message):
        store.pin_reviewed(
            "safe", "evidence.txt", provenance=provenance, title=title
        )
    assert list(store.staging_root.iterdir()) == []
    assert list(store.objects_root.iterdir()) == []


def test_collection_metadata_is_bounded_by_encoded_bytes(tmp_path):
    root = tmp_path / "root"; root.mkdir()
    with pytest.raises(ValueError, match="collection name"):
        ArtifactLibrary(
            tmp_path / "profile",
            profile="test-profile",
            collections=[{
                "id": "safe",
                "name": "💣" * 2_000,
                "root": str(root),
                "owner": "test-profile",
            }],
        )


def test_scan_entry_limit_counts_non_regular_entries(tmp_path):
    root = tmp_path / "root"; root.mkdir()
    outside = tmp_path / "outside.txt"; outside.write_bytes(b"outside")
    for number in range(6):
        (root / f"skip-{number}").symlink_to(outside)
    store = library(
        tmp_path, ("safe", "Safe", root), max_scan_files=5
    )

    with pytest.raises(ArtifactUnavailable, match="file-count"):
        store.scan()


def test_scan_reads_from_enumerated_root_when_root_is_replaced(tmp_path, monkeypatch):
    import hermes_cli.artifact_library as module

    root = tmp_path / "root"; root.mkdir()
    source = root / "report.txt"; source.write_bytes(b"anchored")
    store = library(tmp_path, ("safe", "Safe", root))
    real_stat = module.os.stat
    replaced = False

    def racing_stat(path, *args, **kwargs):
        nonlocal replaced
        result = real_stat(path, *args, **kwargs)
        if path == "report.txt" and kwargs.get("dir_fd") is not None and not replaced:
            replaced = True
            root.rename(tmp_path / "enumerated-root")
            root.mkdir()
            (root / "report.txt").write_bytes(b"replacement-secret")
        return result

    monkeypatch.setattr(module.os, "stat", racing_stat)

    [item] = store.scan()
    assert replaced
    assert item["sha256"] == hashlib.sha256(b"anchored").hexdigest()
    assert item["size"] == len(b"anchored")


def test_scan_rejects_nested_directory_symlink_replacement(tmp_path, monkeypatch):
    import hermes_cli.artifact_library as module

    root = tmp_path / "root"
    nested = root / "nested"
    nested.mkdir(parents=True)
    (nested / "report.txt").write_bytes(b"anchored")
    outside = tmp_path / "outside"; outside.mkdir()
    (outside / "report.txt").write_bytes(b"replacement-secret")
    store = library(tmp_path, ("safe", "Safe", root))
    real_stat = module.os.stat
    replaced = False

    def racing_stat(path, *args, **kwargs):
        nonlocal replaced
        result = real_stat(path, *args, **kwargs)
        if path == "report.txt" and kwargs.get("dir_fd") is not None and not replaced:
            replaced = True
            nested.rename(root / "enumerated-nested")
            nested.symlink_to(outside, target_is_directory=True)
        return result

    monkeypatch.setattr(module.os, "stat", racing_stat)

    with pytest.raises(ArtifactSecurityError):
        store.scan()
    assert replaced


def test_scan_rejects_regular_file_replacement_after_enumeration(tmp_path, monkeypatch):
    import hermes_cli.artifact_library as module

    root = tmp_path / "root"; root.mkdir()
    source = root / "report.txt"; source.write_bytes(b"enumerated")
    replacement = tmp_path / "replacement.txt"
    replacement.write_bytes(b"replacement")
    store = library(tmp_path, ("safe", "Safe", root))
    real_stat = module.os.stat
    replaced = False

    def racing_stat(path, *args, **kwargs):
        nonlocal replaced
        result = real_stat(path, *args, **kwargs)
        if path == "report.txt" and kwargs.get("dir_fd") is not None and not replaced:
            replaced = True
            os.replace(replacement, source)
        return result

    monkeypatch.setattr(module.os, "stat", racing_stat)

    with pytest.raises(ArtifactUnavailable, match="changed"):
        store.scan()
    assert replaced


def test_scan_aggregate_limit_uses_actual_opened_file_size(tmp_path, monkeypatch):
    import hermes_cli.artifact_library as module

    root = tmp_path / "root"; root.mkdir()
    (root / "a.txt").write_bytes(b"aa")
    growing = root / "b.txt"; growing.write_bytes(b"b")
    store = library(tmp_path, ("safe", "Safe", root), max_scan_bytes=3)
    real_stat = module.os.stat
    grown = False

    def racing_stat(path, *args, **kwargs):
        nonlocal grown
        result = real_stat(path, *args, **kwargs)
        if path == "b.txt" and kwargs.get("dir_fd") is not None and not grown:
            grown = True
            growing.write_bytes(b"bbbb")
        return result

    monkeypatch.setattr(module.os, "stat", racing_stat)

    with pytest.raises(ArtifactUnavailable, match="byte limit"):
        store.scan()
    assert grown
