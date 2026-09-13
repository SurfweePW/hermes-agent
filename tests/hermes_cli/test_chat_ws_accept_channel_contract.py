"""Behaviour contract for the /api/pub and /api/events WebSocket gates.

Both endpoints hand the accepted socket to a sidecar. Every rejection must
complete the WebSocket handshake BEFORE the policy close frame: closing an
un-accepted socket surfaces to clients as a bare HTTP 403 handshake failure, so
the client never learns the close code and reports the wrong recovery path
("not authorised" instead of "unknown channel" / "no admission ticket").
"""

from __future__ import annotations

from typing import Any, Optional

import pytest

import hermes_cli.web_routers.chat_ws as _chat_ws


class _QueryParams:
    def __init__(self, query: dict[str, str]) -> None:
        self._query = query

    def get(self, key: str, default: str = "") -> str:
        return self._query.get(key, default)


class _RecordingSocket:
    """Minimal WebSocket stand-in that records the handshake sequence."""

    def __init__(self, query: dict[str, str]) -> None:
        self.query_params = _QueryParams(query)
        self.events: list[tuple[str, Optional[int]]] = []

    async def accept(self) -> None:
        self.events.append(("accept", None))

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.events.append(("close", code))


@pytest.fixture
def sidecar_gates_open(monkeypatch: pytest.MonkeyPatch) -> None:
    """Isolate the channel gate from the auth/allow gates in front of it."""

    async def _allowed(_ws: Any) -> bool:
        return True

    monkeypatch.setattr(_chat_ws, "_close_unless_sidecar_allowed", _allowed)


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["", "with space", "../escape", "a" * 200])
async def test_invalid_channel_accepts_before_the_policy_close(
    sidecar_gates_open: None, channel: str
) -> None:
    ws: Any = _RecordingSocket({"channel": channel})

    assert await _chat_ws._accept_channel_ws(ws) is None
    assert ws.events == [("accept", None), ("close", 4400)]


@pytest.mark.asyncio
async def test_valid_channel_accepts_once_and_is_returned(sidecar_gates_open: None) -> None:
    ws: Any = _RecordingSocket({"channel": "abc-123"})

    assert await _chat_ws._accept_channel_ws(ws) == "abc-123"
    assert ws.events == [("accept", None)]


@pytest.mark.asyncio
async def test_unauthenticated_channel_socket_still_reports_close_code_4401(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression: an unauthenticated peer used to get a bare 403 handshake
    failure, so the Companion showed a generic network error instead of the
    "session expired" recovery it now gets from the explicit close code."""

    monkeypatch.setattr(_chat_ws, "_ws_auth_ok", lambda _ws: False)
    ws: Any = _RecordingSocket({"channel": "abc-123"})

    assert await _chat_ws._accept_channel_ws(ws) is None
    assert ws.events == [("accept", None), ("close", 4401)]