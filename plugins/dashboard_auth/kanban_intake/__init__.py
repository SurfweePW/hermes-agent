"""Scoped service credential for HOFFEE Companion Kanban intake."""
from __future__ import annotations

import hmac
import logging
import math
import os
from collections import Counter
from typing import Optional

from hermes_cli.dashboard_auth import DashboardAuthProvider, Session, TokenPrincipal
from plugins.dashboard_auth._shared import NonInteractiveMixin, SkipRegistration, register_provider

logger = logging.getLogger(__name__)
_TAG = "dashboard-auth-kanban-intake"

ENV_NAME = "HERMES_DASHBOARD_KANBAN_INTAKE_SECRET"
ROUTE_PATH = "/api/plugins/kanban/companion-intake"
SCOPE = "kanban:hoffee:create_get"
_MIN_SECRET_CHARS = 43  # token_urlsafe(32): at least 256 random bits
_MIN_DISTINCT_CHARS = 16
_MIN_SHANNON_BITS = 128.0

LAST_SKIP_REASON = ""


def _shannon_bits(value: str) -> float:
    if not value:
        return 0.0
    n = len(value)
    per_char = -sum((count / n) * math.log2(count / n) for count in Counter(value).values())
    return per_char * n


def assess_secret_strength(secret: str) -> Optional[str]:
    """Return a rejection reason unless the secret meets the fail-closed strength floor."""
    if not secret:
        return "secret is empty"
    if len(secret) < _MIN_SECRET_CHARS:
        return f"secret too short: {len(secret)} chars (need >= {_MIN_SECRET_CHARS})"
    distinct = len(set(secret))
    if distinct < _MIN_DISTINCT_CHARS:
        return f"secret has only {distinct} distinct characters (need >= {_MIN_DISTINCT_CHARS})"
    bits = _shannon_bits(secret)
    if bits < _MIN_SHANNON_BITS:
        return f"secret entropy too low: {bits:.0f} bits (need >= {_MIN_SHANNON_BITS:.0f})"
    return None


class KanbanIntakeSecretProvider(NonInteractiveMixin, DashboardAuthProvider):
    """Token-only provider granting exactly the HOFFEE create/get scope."""

    name = "kanban-intake-secret"
    display_name = "HOFFEE Companion Kanban intake"
    supports_token = True
    supports_session = False
    _NOT_INTERACTIVE = "KanbanIntakeSecretProvider is a non-interactive service credential."
    _NO_START_LOGIN = "KanbanIntakeSecretProvider has no login flow."

    def __init__(self, *, secret: str) -> None:
        reason = assess_secret_strength(secret)
        if reason is not None:
            raise ValueError(f"Kanban intake secret rejected: {reason}")
        self._secret = secret

    def verify_token(self, *, token: str) -> Optional[TokenPrincipal]:
        if token and hmac.compare_digest(token.encode("utf-8"), self._secret.encode("utf-8")):
            return TokenPrincipal(
                principal="hoffee-companion",
                provider=self.name,
                scopes=(SCOPE,),
            )
        return None

    def verify_session(self, *, access_token: str) -> Optional[Session]:
        return None

    def refresh_session(self, *, refresh_token: str) -> Session:
        raise NotImplementedError(self._NOT_INTERACTIVE)

    def revoke_session(self, *, refresh_token: str) -> None:
        return None


def _settings() -> dict[str, str]:
    secret = os.environ.get(ENV_NAME, "").strip()
    if not secret:
        raise SkipRegistration(
            f"{ENV_NAME} is not set; HOFFEE Companion intake token auth stays disabled."
        )
    reason = assess_secret_strength(secret)
    if reason is not None:
        raise SkipRegistration(
            f"{ENV_NAME} rejected — {reason}; HOFFEE Companion intake stays disabled (fail-closed).",
            level="warning",
        )
    return {"secret": secret}


def register(ctx) -> None:
    """Register provider and its one exact token-authable route, or fail closed."""
    global LAST_SKIP_REASON
    LAST_SKIP_REASON = ""
    kwargs, LAST_SKIP_REASON = register_provider(
        ctx, logger, _TAG, KanbanIntakeSecretProvider, _settings
    )
    if kwargs is None:
        return
    try:
        from hermes_cli.dashboard_auth.token_auth import register_token_route

        register_token_route(ROUTE_PATH)
    except Exception as exc:  # noqa: BLE001
        logger.warning("%s: could not register token route %s: %s", _TAG, ROUTE_PATH, exc)
        return
    logger.info("%s: registered scope=%s route=%s", _TAG, SCOPE, ROUTE_PATH)