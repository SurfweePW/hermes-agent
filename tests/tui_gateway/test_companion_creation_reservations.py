from __future__ import annotations

import logging
import threading

import pytest

from tui_gateway import server


class _Lease:
    enabled = True
    released = False
    track_liveness = True

    def __init__(self, lease_id: str, session_id: str = "provisional-key") -> None:
        self.lease_id = lease_id
        self.session_id = session_id
        self.calls = 0

    def release(self) -> None:
        self.calls += 1
        self.released = True


def _track(lease: _Lease, *, runtime_id: str = "runtime") -> bool:
    return server._track_creation_reservation(
        lease,
        session_key=lease.session_id,
        live_session_id=runtime_id,
    )


@pytest.fixture(autouse=True)
def _clear_creation_reservations():
    with server._lifecycle_reservation_lock:
        server._inflight_creation_reservations.clear()
    yield
    with server._lifecycle_reservation_lock:
        server._inflight_creation_reservations.clear()


def test_strict_claim_uses_target_config_and_tracks_real_lease(monkeypatch):
    target_config = {"max_concurrent_sessions": 7}
    lease = _Lease("strict")
    observed = {}

    def _acquire(**kwargs):
        observed.update(kwargs)
        return lease, None

    monkeypatch.setattr("hermes_cli.active_sessions.try_acquire_active_session", _acquire)
    monkeypatch.setattr(server, "_load_cfg", lambda: pytest.fail("global config must not be used"))

    claimed, refusal = server._claim_active_session_slot(
        "provisional-key", live_session_id="creation-id",
        profile_home="/target/profile", config=target_config, strict_reservation=True,
    )

    assert claimed is lease and refusal is None
    assert observed == {
        "session_id": "provisional-key",
        "surface": "companion",
        "config": target_config,
        "registry_home": "/target/profile",
        "metadata": {"live_session_id": "creation-id"},
        "track_liveness": True,
        "persist_prune_on_refusal": False,
    }
    assert server._own_live_lease_ids() == {lease.lease_id}


def test_orphan_sweep_vouches_for_inflight_creation_lease(monkeypatch):
    lease = _Lease("inflight")
    monkeypatch.setattr(server, "_sessions", {})
    assert _track(lease)
    observed = []
    monkeypatch.setattr(
        "hermes_cli.active_sessions.release_orphaned_leases",
        lambda lease_ids: observed.append(lease_ids) or 0,
    )

    server._reclaim_orphaned_leases()

    assert observed == [{lease.lease_id}]


def test_retained_reservation_blocks_local_key_reuse(monkeypatch):
    lease = _Lease("retained")
    lease.session_id = "provisional-key"
    monkeypatch.setattr(server, "_sessions", {})
    assert _track(lease)
    assert server._retain_creation_reservation(lease)
    monkeypatch.setattr(
        "hermes_cli.active_sessions.try_acquire_active_session",
        lambda **_kwargs: pytest.fail("blocked reuse must not reach the registry"),
    )

    claimed, refusal = server._claim_active_session_slot(
        "provisional-key", live_session_id="retry", config={}, strict_reservation=True,
    )

    assert claimed is None
    assert refusal == server._SESSION_OWNERSHIP_UNAVAILABLE


def test_transfer_installs_exact_tracked_lease_without_snapshot_gap(monkeypatch):
    lease = _Lease("tracked")
    session = {"active_session_lease": None, "session_key": lease.session_id}
    monkeypatch.setattr(server, "_sessions", {"runtime": session})
    assert _track(lease)

    entered = threading.Event()
    proceed = threading.Event()
    original_lock = server._sessions_lock

    class _BlockingSessionsLock:
        def __enter__(self):
            entered.set()
            assert proceed.wait(timeout=5)
            original_lock.acquire()
            return self

        def __exit__(self, *_args):
            original_lock.release()

    monkeypatch.setattr(server, "_sessions_lock", _BlockingSessionsLock())
    transferred = []
    thread = threading.Thread(
        target=lambda: transferred.append(
            server._transfer_creation_reservation(lease, sid="runtime", session=session)
        )
    )
    thread.start()
    assert entered.wait(timeout=5)

    snapshots = []
    snapshot_thread = threading.Thread(target=lambda: snapshots.append(server._own_live_lease_ids()))
    snapshot_thread.start()
    proceed.set()
    thread.join(timeout=5)
    snapshot_thread.join(timeout=5)

    assert transferred == [True]
    assert session["active_session_lease"] is lease
    assert snapshots == [{lease.lease_id}]
    assert not server._untrack_creation_reservation(lease)


def test_mismatched_transfer_and_rollback_cannot_touch_other_lease(monkeypatch):
    tracked = _Lease("same-id")
    imposter = _Lease("same-id")
    runtime_lease = _Lease("runtime")
    session = {"active_session_lease": runtime_lease}
    monkeypatch.setattr(server, "_sessions", {"runtime": session})
    assert _track(tracked)

    assert not server._transfer_creation_reservation(imposter, sid="runtime", session=session)
    assert server._rollback_creation_reservation(imposter) == server._SESSION_OWNERSHIP_UNAVAILABLE
    assert session["active_session_lease"] is runtime_lease
    assert tracked.calls == imposter.calls == runtime_lease.calls == 0
    assert server._own_live_lease_ids() == {tracked.lease_id, runtime_lease.lease_id}


def test_retained_or_wrong_target_reservation_cannot_transfer(monkeypatch):
    lease = _Lease("tracked")
    intended = {"active_session_lease": None, "session_key": lease.session_id}
    wrong = {"active_session_lease": None, "session_key": lease.session_id}
    monkeypatch.setattr(
        server,
        "_sessions",
        {"intended-runtime": intended, "wrong-runtime": wrong},
    )
    assert _track(lease, runtime_id="intended-runtime")

    assert not server._transfer_creation_reservation(
        lease, sid="wrong-runtime", session=wrong
    )
    assert server._retain_creation_reservation(lease)
    assert not server._transfer_creation_reservation(
        lease, sid="intended-runtime", session=intended
    )

    assert intended["active_session_lease"] is None
    assert wrong["active_session_lease"] is None
    assert server._own_live_lease_ids() == {lease.lease_id}


def test_transfer_rejects_runtime_already_occupied_by_same_lease(monkeypatch):
    lease = _Lease("tracked")
    occupied = {"active_session_lease": lease, "session_key": lease.session_id}
    monkeypatch.setattr(server, "_sessions", {"runtime": occupied})
    assert _track(lease)

    assert not server._transfer_creation_reservation(
        lease, sid="runtime", session=occupied
    )

    assert occupied["active_session_lease"] is lease
    assert server._own_live_lease_ids() == {lease.lease_id}


def test_rollback_success_untracks_exact_lease(monkeypatch):
    lease = _Lease("rollback")
    monkeypatch.setattr(server, "_sessions", {})
    assert _track(lease)

    assert server._rollback_creation_reservation(lease) is None

    assert lease.calls == 1
    assert server._own_live_lease_ids() == set()


def test_rollback_three_failures_retains_reference_and_sanitizes_log(monkeypatch, caplog):
    secret = "raw-registry-error-secret"

    class _FailingLease(_Lease):
        def release(self) -> None:
            self.calls += 1
            raise OSError(secret)

    lease = _FailingLease("retained")
    monkeypatch.setattr(server, "_sessions", {})
    monkeypatch.setattr(server.time, "sleep", lambda *_args: None)
    assert _track(lease)
    caplog.set_level(logging.WARNING)

    assert server._rollback_creation_reservation(lease) == server._SESSION_OWNERSHIP_UNAVAILABLE

    assert lease.calls == 3
    assert server._own_live_lease_ids() == {lease.lease_id}
    assert secret not in caplog.text


def test_later_lifecycle_sweep_retries_exact_retained_release(monkeypatch):
    class _RetryableLease(_Lease):
        failing = True

        def release(self) -> None:
            self.calls += 1
            if self.failing:
                raise OSError("temporary")
            self.released = True

    lease = _RetryableLease("retained")
    monkeypatch.setattr(server, "_sessions", {})
    monkeypatch.setattr(server.time, "sleep", lambda *_args: None)
    monkeypatch.setattr("hermes_cli.active_sessions.release_orphaned_leases", lambda _ids: 0)
    assert _track(lease)
    assert server._rollback_creation_reservation(lease) == server._SESSION_OWNERSHIP_UNAVAILABLE
    lease.failing = False

    server._reclaim_orphaned_leases()

    assert lease.calls == 4
    assert server._own_live_lease_ids() == set()