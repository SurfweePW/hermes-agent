"""Focused tests for the HOFFEE Companion Kanban intake credential."""
from __future__ import annotations

import secrets
from unittest.mock import MagicMock

import pytest

from hermes_cli.dashboard_auth import TokenPrincipal, assert_protocol_compliance
from hermes_cli.dashboard_auth import token_auth
from plugins.dashboard_auth import kanban_intake


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    monkeypatch.delenv(kanban_intake.ENV_NAME, raising=False)
    token_auth.clear_token_routes()
    yield
    token_auth.clear_token_routes()


def _secret() -> str:
    return secrets.token_urlsafe(32)


def test_provider_is_token_only_scoped_and_constant_match():
    assert_protocol_compliance(kanban_intake.KanbanIntakeSecretProvider)
    secret = _secret()
    provider = kanban_intake.KanbanIntakeSecretProvider(secret=secret)

    principal = provider.verify_token(token=secret)
    assert isinstance(principal, TokenPrincipal)
    assert principal.principal == "hoffee-companion"
    assert principal.provider == "kanban-intake-secret"
    assert principal.scopes == ("kanban:hoffee:create_get",)
    assert provider.supports_session is False
    assert provider.verify_token(token=secret + "x") is None


def test_provider_rejects_weak_secret():
    with pytest.raises(ValueError, match="rejected"):
        kanban_intake.KanbanIntakeSecretProvider(secret="weak")


def test_register_fails_closed_without_or_with_weak_secret(monkeypatch):
    ctx = MagicMock()
    kanban_intake.register(ctx)
    ctx.register_dashboard_auth_provider.assert_not_called()
    assert not token_auth.is_token_route(kanban_intake.ROUTE_PATH)

    monkeypatch.setenv(kanban_intake.ENV_NAME, "x" * 80)
    kanban_intake.register(ctx)
    ctx.register_dashboard_auth_provider.assert_not_called()
    assert not token_auth.is_token_route(kanban_intake.ROUTE_PATH)


def test_registers_exact_route_with_strong_env_secret(monkeypatch):
    secret = _secret()
    monkeypatch.setenv(kanban_intake.ENV_NAME, secret)
    ctx = MagicMock()

    kanban_intake.register(ctx)

    ctx.register_dashboard_auth_provider.assert_called_once()
    provider = ctx.register_dashboard_auth_provider.call_args.args[0]
    assert provider.verify_token(token=secret) is not None
    assert token_auth.is_token_route("/api/plugins/kanban/companion-intake")
    assert not token_auth.is_token_route("/api/plugins/kanban/companion-intake/")
    assert not token_auth.is_token_route("/api/plugins/kanban/tasks")
