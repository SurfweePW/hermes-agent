"""Immutable owner/request coordinator binding for Companion creation."""
from __future__ import annotations

import hashlib
import json
import multiprocessing
from pathlib import Path

import pytest

from hermes_state import SessionDB
from tui_gateway import companion_creation, companion_sessions


OWNER = "basic:owner"
REQUEST_ID = "71a83cca-207f-4e39-8217-67ea2da77f23"
BACKEND = "companion-test-backend"
PROFILE = "atlas"
DIGEST = "a" * 64


def _bind_creation(db: SessionDB, **changes):
    values = {
        "owner": OWNER,
        "client_request_id": REQUEST_ID,
        "payload_digest": DIGEST,
        "backend": BACKEND,
        "profile": PROFILE,
        "stored_id": "stored-created",
        "project_id": None,
        "operation_id": "b" * 48,
        "creator_pid": 123,
        "creator_started": 456,
        "creator_token": "1" * 48,
        "bound_at": "2026-09-10T10:00:00Z",
    }
    values.update(changes)
    return companion_creation._creation_request_index(db, **values)


def _bind_creation_in_process(db_path: str, stored_id: str, output) -> None:
    db = SessionDB(Path(db_path))
    try:
        index, inserted = _bind_creation(
            db,
            stored_id=stored_id,
            operation_id=("c" if stored_id.endswith("one") else "d") * 48,
            creator_pid=101 if stored_id.endswith("one") else 202,
            creator_started=301 if stored_id.endswith("one") else 302,
            creator_token=("2" if stored_id.endswith("one") else "3") * 48,
        )
        output.put((inserted, index))
    finally:
        db.close()


def test_creation_binding_uses_shared_key_and_exact_privacy_minimal_v4_schema(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    index, inserted = _bind_creation(db)
    raw = db.get_meta(companion_sessions._continuity_v3_key(OWNER, REQUEST_ID))

    assert inserted is True
    assert json.loads(raw) == index
    assert set(index) == {
        "v",
        "operation_kind",
        "payload_sha256",
        "operation_id",
        "backend_namespace",
        "target_profile",
        "requested_id",
        "project_id",
        "creator_pid",
        "creator_started",
        "creator_token",
        "creator_epoch",
        "phase",
        "bound_at",
        "phase_at",
        "closed_outcome",
    }
    assert index == {
        "v": 4,
        "operation_kind": "create",
        "payload_sha256": DIGEST,
        "operation_id": "b" * 48,
        "backend_namespace": BACKEND,
        "target_profile": PROFILE,
        "requested_id": "stored-created",
        "project_id": None,
        "creator_pid": 123,
        "creator_started": 456,
        "creator_token": "1" * 48,
        "creator_epoch": 1,
        "phase": "bound",
        "bound_at": "2026-09-10T10:00:00Z",
        "phase_at": "2026-09-10T10:00:00Z",
        "closed_outcome": None,
    }
    assert OWNER not in raw
    assert REQUEST_ID not in raw
    db.close()


def test_identical_creation_replay_returns_winner_without_adopting_new_creator(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    winner, inserted = _bind_creation(db)
    replay, replay_inserted = _bind_creation(
        db,
        operation_id="c" * 48,
        stored_id="unused-loser-reservation",
        creator_pid=999,
        creator_started=1000,
        creator_token="4" * 48,
        bound_at="2026-09-10T10:01:00Z",
    )

    assert inserted is True
    assert replay_inserted is False
    assert replay == winner
    assert replay["requested_id"] == "stored-created"
    assert replay["creator_token"] == "1" * 48
    db.close()


def test_independent_creators_racing_same_request_observe_one_binding(tmp_path):
    db_path = tmp_path / "state.db"
    SessionDB(db_path).close()
    context = multiprocessing.get_context("spawn")
    output = context.Queue()
    creators = [
        context.Process(
            target=_bind_creation_in_process,
            args=(str(db_path), stored_id, output),
        )
        for stored_id in ("reserved-one", "reserved-two")
    ]

    for creator in creators:
        creator.start()
    for creator in creators:
        creator.join(10)
        assert creator.exitcode == 0

    results = [output.get(timeout=5), output.get(timeout=5)]
    assert sorted(inserted for inserted, _index in results) == [False, True]
    assert results[0][1] == results[1][1]
    db = SessionDB(db_path)
    rows = db._conn.execute(
        "SELECT value FROM state_meta WHERE key LIKE 'companion_continuity_v3:%'"
    ).fetchall()
    assert len(rows) == 1
    assert json.loads(rows[0]["value"]) == results[0][1]
    db.close()


@pytest.mark.parametrize(
    "change",
    [
        {"payload_digest": "d" * 64},
        {"backend": "different-backend"},
        {"profile": "coder"},
        {"project_id": "project-1"},
    ],
)
def test_creation_reuse_with_changed_payload_or_scope_conflicts(tmp_path, change):
    db = SessionDB(tmp_path / "state.db")
    _bind_creation(db)

    with pytest.raises(companion_sessions.CompanionSessionsError) as raised:
        _bind_creation(db, **change)

    assert raised.value.code == 4090
    db.close()


def test_creation_and_continuation_share_one_operation_kind_namespace(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    _bind_creation(db)

    with pytest.raises(companion_sessions.CompanionSessionsError) as raised:
        companion_sessions._request_index(
            db,
            owner=OWNER,
            client_request_id=REQUEST_ID,
            payload_digest=DIGEST,
            backend=BACKEND,
            profile=PROFILE,
            stored_id="stored-created",
        )

    assert raised.value.code == 4090
    db.close()


def test_continuation_and_creation_share_one_operation_kind_namespace(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    companion_sessions._request_index(
        db,
        owner=OWNER,
        client_request_id=REQUEST_ID,
        payload_digest=DIGEST,
        backend=BACKEND,
        profile=PROFILE,
        stored_id="stored-continued",
    )

    with pytest.raises(companion_sessions.CompanionSessionsError) as raised:
        _bind_creation(db)

    assert raised.value.code == 4090
    assert "another operation kind" in str(raised.value)
    db.close()


def test_shared_creation_kind_conflict_precedes_legacy_continuation_receipt(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    _bind_creation(db)
    db.set_meta(
        companion_sessions._continuity_receipt_key(OWNER, REQUEST_ID),
        json.dumps({"v": 2, "state": "claimed", "payload_sha256": DIGEST}),
    )

    with pytest.raises(companion_sessions.CompanionSessionsError) as raised:
        companion_sessions._request_index(
            db,
            owner=OWNER,
            client_request_id=REQUEST_ID,
            payload_digest=DIGEST,
            backend=BACKEND,
            profile=PROFILE,
            stored_id="stored-created",
        )

    assert raised.value.code == 4090
    assert "another operation kind" in str(raised.value)
    db.close()


def test_shared_continuation_kind_conflict_precedes_legacy_continuation_receipt(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    companion_sessions._request_index(
        db,
        owner=OWNER,
        client_request_id=REQUEST_ID,
        payload_digest=DIGEST,
        backend=BACKEND,
        profile=PROFILE,
        stored_id="stored-continued",
    )
    db.set_meta(
        companion_sessions._continuity_receipt_key(OWNER, REQUEST_ID),
        json.dumps({"v": 2, "state": "claimed", "payload_sha256": DIGEST}),
    )

    with pytest.raises(companion_sessions.CompanionSessionsError) as raised:
        _bind_creation(db)

    assert raised.value.code == 4090
    assert "another operation kind" in str(raised.value)
    db.close()


def test_legacy_continuation_receipt_alone_conflicts_with_creation(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    shared_key = companion_sessions._continuity_v3_key(OWNER, REQUEST_ID)
    db.set_meta(
        companion_sessions._continuity_receipt_key(OWNER, REQUEST_ID),
        json.dumps({"v": 2, "state": "claimed", "payload_sha256": DIGEST}),
    )

    with pytest.raises(companion_sessions.CompanionSessionsError) as raised:
        _bind_creation(db)

    assert raised.value.code == 4090
    assert "legacy continuation" in str(raised.value)
    assert db.get_meta(shared_key) is None
    db.close()


def test_new_continuation_records_kind_but_legacy_v3_without_kind_remains_readable(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    current, inserted = companion_sessions._request_index(
        db,
        owner=OWNER,
        client_request_id=REQUEST_ID,
        payload_digest=DIGEST,
        backend=BACKEND,
        profile=PROFILE,
        stored_id="stored-continued",
    )
    assert inserted is True
    assert current["operation_kind"] == "continue"

    legacy_request = "legacy-v3-request"
    legacy = {
        "v": 3,
        "payload_sha256": DIGEST,
        "operation_id": "e" * 48,
        "backend_namespace": BACKEND,
        "target_profile": PROFILE,
        "requested_id": "stored-legacy",
    }
    db.set_meta(
        companion_sessions._continuity_v3_key(OWNER, legacy_request),
        json.dumps(legacy, sort_keys=True, separators=(",", ":")),
    )
    replay, replay_inserted = companion_sessions._request_index(
        db,
        owner=OWNER,
        client_request_id=legacy_request,
        payload_digest=DIGEST,
        backend=BACKEND,
        profile=PROFILE,
        stored_id="stored-legacy",
    )
    assert replay_inserted is False
    assert replay == legacy
    db.close()


def test_creation_digest_binds_protocol_raw_and_sanitized_text_exactly():
    expected = hashlib.sha256(
        json.dumps(
            ["p4.create.v1", BACKEND, PROFILE, None, " raw text ", "raw text"],
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()

    assert companion_creation._creation_payload_digest(
        BACKEND, PROFILE, None, " raw text ", "raw text"
    ) == expected
    assert companion_creation._creation_payload_digest(
        BACKEND, PROFILE, "project-1", " raw text ", "raw text"
    ) != expected


def test_malformed_existing_creation_index_fails_closed(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    index, _ = _bind_creation(db)
    index["plaintext_prompt"] = "must never be adopted"
    db.set_meta(
        companion_sessions._continuity_v3_key(OWNER, REQUEST_ID),
        json.dumps(index, sort_keys=True, separators=(",", ":")),
    )

    with pytest.raises(companion_sessions.CompanionSessionsError) as raised:
        _bind_creation(db)

    assert raised.value.code == 5006
    db.close()


def _valid_creation_index() -> dict:
    return {
        "v": 4,
        "operation_kind": "create",
        "payload_sha256": DIGEST,
        "operation_id": "b" * 48,
        "backend_namespace": BACKEND,
        "target_profile": PROFILE,
        "requested_id": "stored-created",
        "project_id": None,
        "creator_pid": 123,
        "creator_started": 456,
        "creator_token": "1" * 48,
        "creator_epoch": 1,
        "phase": "bound",
        "bound_at": "2026-09-10T10:00:00Z",
        "phase_at": "2026-09-10T10:00:00Z",
        "closed_outcome": None,
    }


@pytest.mark.parametrize(
    ("field", "invalid"),
    [
        ("operation_id", "not-a-48-byte-lowercase-hex-id"),
        ("backend_namespace", f" {BACKEND}"),
        ("backend_namespace", f"back\u0085end"),
        ("target_profile", f"{PROFILE} "),
        ("requested_id", " stored-created"),
        ("requested_id", "stored\u0080created"),
        ("project_id", "project-1 "),
        ("project_id", "project\u009f1"),
        ("creator_pid", True),
        ("creator_pid", (1 << 63)),
        ("creator_started", 0),
        ("creator_token", "g" * 48),
        ("phase", []),
        ("bound_at", "2026-09-10 10:00:00Z"),
        ("phase_at", "2026-09-10T09:59:59Z"),
        ("closed_outcome", {}),
    ],
)
def test_creation_index_parser_rejects_noncanonical_field_values(field, invalid):
    index = _valid_creation_index()
    index[field] = invalid

    with pytest.raises(companion_sessions.CompanionSessionsError) as raised:
        companion_sessions._parse_request_index(json.dumps(index))

    assert raised.value.code == 5006


@pytest.mark.parametrize(
    ("argument", "invalid"),
    [
        ("backend", "é" * 2049),
        ("backend", "backend\ud800"),
        ("profile", "Atlas"),
        ("profile", "a" * 65),
        ("stored_id", "会" * 171),
        ("stored_id", "stored\ud800"),
        ("project_id", "会" * 171),
        ("project_id", "project\ud800"),
    ],
)
@pytest.mark.parametrize("existing_binding", [False, True])
def test_creation_binding_rejects_noncanonical_v4_text_before_insert_or_adoption(
    tmp_path, argument, invalid, existing_binding
):
    db = SessionDB(tmp_path / "state.db")
    if existing_binding:
        _bind_creation(db)

    with pytest.raises(companion_sessions.CompanionSessionsError) as raised:
        _bind_creation(db, **{argument: invalid})

    assert raised.value.code == 5006
    rows = db._conn.execute(
        "SELECT value FROM state_meta WHERE key LIKE 'companion_continuity_v3:%'"
    ).fetchall()
    assert len(rows) == (1 if existing_binding else 0)
    db.close()


@pytest.mark.parametrize("profile", ["hermes", "test", "tmp", "root", "sudo"])
@pytest.mark.parametrize("existing_binding", [False, True])
def test_creation_binding_rejects_reserved_profiles_before_insert_or_adoption(
    tmp_path, profile, existing_binding
):
    from hermes_cli.profiles import validate_profile_name

    with pytest.raises(ValueError):
        validate_profile_name(profile)

    db = SessionDB(tmp_path / "state.db")
    key = companion_sessions._continuity_v3_key(OWNER, REQUEST_ID)
    raw = None
    if existing_binding:
        invalid = {**_valid_creation_index(), "target_profile": profile}
        raw = json.dumps(invalid, sort_keys=True, separators=(",", ":"))
        db.set_meta(key, raw)
    conn = db._conn
    assert conn is not None
    before = conn.total_changes

    with pytest.raises(companion_sessions.CompanionSessionsError) as raised:
        # A valid proposal must also refuse to adopt a pre-existing invalid v4 binding.
        _bind_creation(db, profile=PROFILE if existing_binding else profile)

    assert raised.value.code == 5006
    assert conn.total_changes == before
    assert db.get_meta(key) == (raw if existing_binding else None)
    db.close()


@pytest.mark.parametrize("profile", ["default", "atlas", "coder-2", "work_tmp"])
def test_creation_binding_accepts_profiles_allowed_by_canonical_validator(
    tmp_path, profile
):
    from hermes_cli.profiles import validate_profile_name

    validate_profile_name(profile)
    db = SessionDB(tmp_path / "state.db")

    index, inserted = _bind_creation(db, profile=profile)

    assert inserted is True
    assert index["target_profile"] == profile
    db.close()


@pytest.mark.parametrize(
    "raw",
    [
        b'{"v":3}',
        '{"v":3,"v":3,"payload_sha256":"' + DIGEST + '"}',
        '{"v":NaN}',
    ],
)
def test_request_index_parser_rejects_non_text_duplicate_and_nonfinite_json(raw):
    with pytest.raises(companion_sessions.CompanionSessionsError) as raised:
        companion_sessions._parse_request_index(raw)

    assert raised.value.code == 5006


def test_request_index_parser_translates_deep_json_recursion_to_domain_error():
    raw = "[" * 2_000 + "]" * 2_000

    with pytest.raises(companion_sessions.CompanionSessionsError) as raised:
        companion_sessions._parse_request_index(raw)

    assert raised.value.code == 5006
    assert str(raised.value) == "session request index is invalid"


@pytest.mark.parametrize(
    ("field", "invalid"),
    [
        ("operation_id", "f" * 47),
        ("backend_namespace", f"{BACKEND} "),
        ("target_profile", f" {PROFILE}"),
        ("requested_id", "stored-continued "),
    ],
)
def test_continuation_index_parser_rejects_noncanonical_field_values(field, invalid):
    index = {
        "v": 3,
        "operation_kind": "continue",
        "payload_sha256": DIGEST,
        "operation_id": "e" * 48,
        "backend_namespace": BACKEND,
        "target_profile": PROFILE,
        "requested_id": "stored-continued",
    }
    index[field] = invalid

    with pytest.raises(companion_sessions.CompanionSessionsError) as raised:
        companion_sessions._parse_request_index(json.dumps(index))

    assert raised.value.code == 5006
