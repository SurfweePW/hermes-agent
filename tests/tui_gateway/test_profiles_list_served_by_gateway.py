"""Contract tests for static gateway routing on ``profiles.list`` rows."""

from pathlib import Path
from types import SimpleNamespace

import pytest

from hermes_cli import profiles as profiles_mod
import tui_gateway.server as server
from tui_gateway.companion_sessions import _owner_authorized_profiles


def test_profiles_list_marks_every_installed_profile_without_filtering(monkeypatch, tmp_path):
    monkeypatch.delenv("GATEWAY_MULTIPLEX_PROFILES", raising=False)
    installed = [
        SimpleNamespace(
            name=name,
            path=tmp_path / name,
            is_default=name == "default",
            model=None,
            provider=None,
            description=None,
            display_name=None,
            skill_count=0,
        )
        for name in ("default", "atlas", "offline")
    ]
    for profile in installed:
        Path(profile.path).mkdir()

    calls = []
    monkeypatch.setattr(profiles_mod, "list_profiles", lambda: installed)
    monkeypatch.setattr(
        profiles_mod,
        "profiles_to_serve",
        lambda *, multiplex, profile_allowlist: (
            calls.append((multiplex, profile_allowlist))
            or [("default", installed[0].path), ("atlas", installed[1].path)]
        ),
    )
    monkeypatch.setattr(
        server,
        "_load_cfg",
        lambda: {
            "gateway": {
                "multiplex_profiles": True,
                "multiplex_profile_allowlist": ["atlas"],
            }
        },
    )

    response = server._methods["profiles.list"](
        "roster", {"include_sessions": False}
    )

    assert "error" not in response
    assert calls == [(True, ["atlas"])]
    assert {
        row["name"]: row["served_by_gateway"]
        for row in response["result"]["profiles"]
    } == {"default": True, "atlas": True, "offline": False}


def test_broken_served_profile_policy_still_lists_every_profile(monkeypatch, tmp_path):
    """A malformed gateway policy must not take the roster down for every client."""
    monkeypatch.delenv("GATEWAY_MULTIPLEX_PROFILES", raising=False)
    installed = [
        SimpleNamespace(
            name=name,
            path=tmp_path / name,
            is_default=name == "default",
            model=None,
            provider=None,
            description=None,
            display_name=None,
            skill_count=0,
        )
        for name in ("default", "atlas")
    ]
    for profile in installed:
        Path(profile.path).mkdir()

    monkeypatch.setattr(profiles_mod, "list_profiles", lambda: installed)
    monkeypatch.setattr(
        server,
        "_load_cfg",
        lambda: {"gateway": {"multiplex_profiles": "not-a-bool"}},
    )

    response = server._methods["profiles.list"](
        "roster", {"include_sessions": False}
    )

    assert "error" not in response
    rows = response["result"]["profiles"]
    assert [row["name"] for row in rows] == ["default", "atlas"]
    assert all(row["served_by_gateway"] is False for row in rows)


def test_served_profiles_use_gateway_env_and_allowlist_normalization(monkeypatch):
    calls = []
    monkeypatch.setenv("GATEWAY_MULTIPLEX_PROFILES", "true")
    monkeypatch.setattr(
        server,
        "_load_cfg",
        lambda: {
            "gateway": {
                "multiplex_profiles": False,
                "multiplex_profile_allowlist": [
                    " Atlas ", "atlas", "default", "bad/name", 7,
                ],
            }
        },
    )
    monkeypatch.setattr(
        profiles_mod,
        "profiles_to_serve",
        lambda *, multiplex, profile_allowlist: (
            calls.append((multiplex, profile_allowlist))
            or [("default", Path("/tmp/default")), ("atlas", Path("/tmp/atlas"))]
        ),
    )

    assert _owner_authorized_profiles(server) == frozenset({"default", "atlas"})
    assert calls == [(True, ["atlas"])]


def test_transient_profile_enumeration_error_is_not_policy_fallback(monkeypatch):
    monkeypatch.delenv("GATEWAY_MULTIPLEX_PROFILES", raising=False)
    monkeypatch.setattr(server, "_load_cfg", lambda: {})

    def boom(*, multiplex, profile_allowlist):
        raise RuntimeError("transient filesystem hiccup")

    monkeypatch.setattr(profiles_mod, "profiles_to_serve", boom)

    with pytest.raises(RuntimeError, match="transient filesystem hiccup"):
        _owner_authorized_profiles(server)


def test_transient_config_read_error_is_not_policy_fallback(monkeypatch):
    def boom():
        raise OSError("transient config read hiccup")

    monkeypatch.setattr(server, "_load_cfg", boom)

    with pytest.raises(OSError, match="transient config read hiccup"):
        _owner_authorized_profiles(server)
