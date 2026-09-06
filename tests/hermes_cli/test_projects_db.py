"""Tests for the per-profile Projects store (hermes_cli/projects_db)."""

from __future__ import annotations

import os
import sqlite3

import pytest

from hermes_cli import projects_db as pdb


@pytest.fixture
def conn(tmp_path):
    c = pdb.connect(db_path=tmp_path / "projects.db")
    try:
        yield c
    finally:
        c.close()


def test_connect_readonly_missing_db_does_not_create_source(tmp_path):
    path = tmp_path / "missing-profile" / "projects.db"

    with pdb.connect_readonly(path) as read_conn:
        assert read_conn is None

    assert not path.exists()
    assert not path.parent.exists()


def test_connect_readonly_preserves_existing_source(tmp_path):
    path = tmp_path / "projects.db"
    write_conn = pdb.connect(path)
    project_id = pdb.create_project(write_conn, name="Existing")
    write_conn.close()
    before_bytes = path.read_bytes()
    before_mtime = path.stat().st_mtime_ns

    with pdb.connect_readonly(path) as read_conn:
        assert read_conn is not None
        project = pdb.get_project(read_conn, project_id)
        assert project is not None
        assert project.name == "Existing"
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            pdb.create_project(read_conn, name="Must not persist")

    assert path.read_bytes() == before_bytes
    assert path.stat().st_mtime_ns == before_mtime


def test_connect_readonly_rejects_database_symlink(tmp_path):
    outside = tmp_path / "outside.db"
    conn = pdb.connect(outside)
    pdb.create_project(conn, name="Outside secret")
    conn.close()
    source = tmp_path / "profile" / "projects.db"
    source.parent.mkdir()
    source.symlink_to(outside)

    with pytest.raises(ValueError, match="safe regular file"):
        with pdb.connect_readonly(source):
            pass


def test_connect_readonly_detects_source_replacement_race(tmp_path, monkeypatch):
    source = tmp_path / "projects.db"
    conn = pdb.connect(source)
    pdb.create_project(conn, name="Original")
    conn.close()
    outside = tmp_path / "outside.db"
    conn = pdb.connect(outside)
    pdb.create_project(conn, name="Outside secret")
    conn.close()
    real_connect = pdb.sqlite3.connect

    def replace_then_connect(*args, **kwargs):
        source.unlink()
        source.symlink_to(outside)
        return real_connect(*args, **kwargs)

    monkeypatch.setattr(pdb.sqlite3, "connect", replace_then_connect)
    with pytest.raises(ValueError, match="changed while it was opened|opened safely"):
        with pdb.connect_readonly(source):
            pass



def test_discovery_policy_change_clears_only_discovered_rows(conn):
    project_id = pdb.create_project(conn, name="Explicit", folders=["/www/explicit"])
    pdb.record_discovered_repos(
        conn, [("/www/scanned", "scanned")], policy_key="policy-a"
    )

    assert pdb.reconcile_discovered_repos_policy(conn, "policy-b") is True
    assert pdb.list_discovered_repos(conn) == []
    assert pdb.get_project(conn, project_id) is not None
    assert pdb.get_discovery_policy_key(conn) == "policy-b"






def test_create_get_list(conn):
    pid = pdb.create_project(conn, name="Hermes Agent", folders=["/tmp/hermes"])
    proj = pdb.get_project(conn, pid)

    assert proj is not None
    assert proj.slug == "hermes-agent"
    assert proj.name == "Hermes Agent"
    # First folder becomes primary.
    assert proj.primary_path == "/tmp/hermes"
    assert [f.path for f in proj.folders] == ["/tmp/hermes"]
    assert proj.folders[0].is_primary is True

    # Lookup by slug too.
    assert pdb.get_project(conn, "hermes-agent").id == pid
    assert len(pdb.list_projects(conn)) == 1












def test_project_for_path_skips_archived(conn):
    pid = pdb.create_project(conn, name="P", folders=["/www/app"])
    pdb.archive_project(conn, pid)

    assert pdb.project_for_path(conn, "/www/app/src") is None
    # Archived hidden from the default list but visible with include_archived.
    assert pdb.list_projects(conn) == []
    assert len(pdb.list_projects(conn, include_archived=True)) == 1

    pdb.restore_project(conn, pid)
    assert pdb.project_for_path(conn, "/www/app/src").id == pid


def test_create_dedups_by_primary_path(conn):
    pid = pdb.create_project(conn, name="GeoTrace", folders=["/www/geotrace"])

    # Same folder again (any name): refused, existing project named in error.
    with pytest.raises(ValueError, match="already belongs to project 'geotrace'"):
        pdb.create_project(conn, name="GeoTrace", folders=["/www/geotrace"])
    with pytest.raises(ValueError, match="already belongs"):
        pdb.create_project(conn, name="Other Name", primary_path="/www/geotrace")

    # Trailing-separator spelling of the same folder is still a duplicate.
    with pytest.raises(ValueError, match="already belongs"):
        pdb.create_project(conn, name="GeoTrace", primary_path="/www/geotrace/")

    # Deliberate duplicates stay possible.
    dup = pdb.create_project(
        conn, name="GeoTrace", folders=["/www/geotrace"], allow_duplicate_path=True
    )
    assert dup != pid
    assert len(pdb.list_projects(conn)) == 2


def test_create_dedup_ignores_archived_and_other_paths(conn):
    pid = pdb.create_project(conn, name="App", folders=["/www/app"])
    pdb.archive_project(conn, pid)

    # Archived project no longer blocks the path.
    fresh = pdb.create_project(conn, name="App", folders=["/www/app"])
    assert fresh != pid

    # Different folder is never a collision; folder-less projects don't match.
    pdb.create_project(conn, name="Elsewhere", folders=["/www/other"])
    pdb.create_project(conn, name="No Folder")


def test_find_by_primary_path(conn):
    pid = pdb.create_project(conn, name="App", folders=["/www/app"])

    assert pdb.find_by_primary_path(conn, "/www/app").id == pid
    assert pdb.find_by_primary_path(conn, "/www/app/").id == pid
    assert pdb.find_by_primary_path(conn, "/www/nope") is None
    assert pdb.find_by_primary_path(conn, "") is None






def test_per_profile_isolation(tmp_path):
    # Two distinct DB paths stand in for two profiles' HERMES_HOME.
    a = pdb.connect(db_path=tmp_path / "a" / "projects.db")
    b = pdb.connect(db_path=tmp_path / "b" / "projects.db")
    try:
        pdb.create_project(a, name="Only In A", folders=["/a"])
        pdb.record_discovered_repos(a, [("/a/scanned", "scanned")])

        assert [p.slug for p in pdb.list_projects(a)] == ["only-in-a"]
        assert pdb.list_projects(b) == []
        assert [row["root"] for row in pdb.list_discovered_repos(a)] == [
            "/a/scanned"
        ]
        assert pdb.list_discovered_repos(b) == []
    finally:
        a.close()
        b.close()


