"""P5-W1 persistence proof against a frozen, independently-created WorkStore schema."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import sqlite3
import threading

import pytest

from hermes_cli import companion_work
from hermes_cli.companion_work_store import WorkError, WorkStore
from hermes_cli.companion_work_store_readonly import existing_card_ids, _stored_json
from hermes_cli.dashboard_auth import ws_tickets


PROFILE = "atlas"
CARD_ID = "p5-w1-card"
PAYLOAD = {
    "title": "Campaign review",
    "brief": "Review the retained campaign draft.",
    "evidence": ["artifact:campaign-draft:v7"],
    "next_action": "Choose preparation disposition.",
    "owner": "Pawel",
}
PAYLOAD_JSON = json.dumps(PAYLOAD, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
CREATED_AT = "2026-09-10T08:00:00+00:00"

# This DDL is deliberately not imported from WorkStore. It is a frozen copy of
# the profile-local schema observed read-only for P5-W1, so opening the fixture
# with production code cannot silently redefine what the test considers valid.
FROZEN_SCHEMA = (
    "CREATE TABLE inbox_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    """CREATE TABLE work_cards (
        id TEXT PRIMARY KEY, source_key TEXT UNIQUE NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL, revision INTEGER NOT NULL, version INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, snoozed_until TEXT,
        approval TEXT, attention_generation INTEGER NOT NULL DEFAULT 0,
        changes_revision INTEGER, execution_link TEXT, completion_evidence TEXT,
        tracker_evidence TEXT)""",
    """CREATE TABLE work_revisions (
        card_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(card_id, revision))""",
    """CREATE TABLE work_comments (
        id TEXT PRIMARY KEY, card_id TEXT NOT NULL, revision INTEGER NOT NULL,
        actor TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL)""",
    """CREATE TABLE work_decisions (
        id TEXT PRIMARY KEY, card_id TEXT NOT NULL, revision INTEGER NOT NULL,
        action TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL,
        snoozed_until TEXT, created_at TEXT NOT NULL, scope TEXT NOT NULL)""",
    """CREATE TABLE work_tracker_status_events (
        id TEXT PRIMARY KEY, card_id TEXT NOT NULL, revision INTEGER NOT NULL,
        handoff_key TEXT NOT NULL, execution_ref TEXT, tracker_evidence TEXT NOT NULL,
        created_at TEXT NOT NULL)""",
    """CREATE TABLE work_idempotency (
        kind TEXT NOT NULL, key TEXT NOT NULL, request TEXT NOT NULL,
        response TEXT NOT NULL, PRIMARY KEY(kind, key))""",
    """CREATE TABLE work_digest_receipts (
        consumer TEXT NOT NULL, card_id TEXT NOT NULL, attention_key TEXT NOT NULL,
        PRIMARY KEY(consumer, card_id, attention_key))""",
    """CREATE TABLE work_digest_batches (
        consumer TEXT NOT NULL, local_date TEXT NOT NULL, batch_id TEXT UNIQUE NOT NULL,
        items TEXT NOT NULL, created_at TEXT NOT NULL, acknowledged_at TEXT,
        PRIMARY KEY(consumer, local_date))""",
)

LEGACY_WORK_CARDS_DDL = """CREATE TABLE work_cards (
    id TEXT PRIMARY KEY, source_key TEXT UNIQUE NOT NULL, payload TEXT NOT NULL,
    state TEXT NOT NULL, revision INTEGER NOT NULL, version INTEGER NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, snoozed_until TEXT,
    approval TEXT, attention_generation INTEGER NOT NULL DEFAULT 0,
    changes_revision INTEGER, execution_link TEXT, completion_evidence TEXT)"""

FROZEN_83707A164F_SCHEMA = tuple(
    LEGACY_WORK_CARDS_DDL if statement.startswith("CREATE TABLE work_cards") else statement
    for statement in FROZEN_SCHEMA
    if not statement.startswith((
        "CREATE TABLE work_tracker_status_events", "CREATE TABLE work_digest_batches",
    ))
)
FROZEN_4303881843_SCHEMA = tuple(
    statement for statement in FROZEN_SCHEMA
    if not statement.startswith("CREATE TABLE work_digest_batches")
)


def _create_frozen_store(
    path, *, schema=FROZEN_SCHEMA, extra_ddl=(), card_values=None,
) -> None:
    """Create a historical database without executing WorkStore initialization."""
    with sqlite3.connect(path) as db:
        for statement in (*schema, *extra_ddl):
            db.execute(statement)
        db.execute("INSERT INTO inbox_meta VALUES ('profile', ?)", (PROFILE,))
        db.execute(
            """INSERT INTO work_cards
               (id,source_key,payload,state,revision,version,created_at,updated_at)
               VALUES (?,?,?,'needs_me',7,8,?,?)""",
            card_values or (
                CARD_ID, "p5-w1:campaign", PAYLOAD_JSON, CREATED_AT, CREATED_AT
            ),
        )
        db.executemany(
            "INSERT INTO work_revisions VALUES (?,?,?,?)",
            ((CARD_ID, revision, PAYLOAD_JSON, CREATED_AT) for revision in range(1, 8)),
        )
        db.execute(
            "UPDATE work_cards SET attention_generation=1 WHERE id=?", (CARD_ID,)
        )


def _create_historical_receipt_store(path, contract="83707a164f") -> None:
    """Write prior-release rows and receipts without invoking WorkStore mutations."""
    if contract not in {"83707a164f", "4303881843"}:
        raise AssertionError(f"unsupported fixture contract: {contract}")
    decision_id = "historical-decision"
    handoff_key = f"{PROFILE}:{CARD_ID}:{decision_id}"
    approval = {
        "revision": 1, "scope": "preparation_only", "decision_id": decision_id,
    }
    link = {
        "execution_ref": "tracker:historical", "acknowledged_at": CREATED_AT,
        "handoff_key": handoff_key,
    }
    decision = {
        "id": decision_id, "card_id": CARD_ID, "revision": 1,
        "action": "approve_preparation", "actor": "owner:historical", "reason": "",
        "snoozed_until": None, "created_at": CREATED_AT,
        "scope": "preparation_only",
    }
    base_item = {
        **PAYLOAD, "id": CARD_ID, "profile": PROFILE,
        "source_key": "historical:receipt", "state": "in_progress", "revision": 1,
        "created_at": CREATED_AT, "updated_at": CREATED_AT, "snoozed_until": None,
        "attention_due": False, "handoff_key": handoff_key,
        "completion_evidence": None, "attention_key": "2026-09-10:1:1",
        "approval": approval,
    }
    if contract == "4303881843":
        base_item.update({
            "tracker_evidence": None,
            "handoff_reconciliation_required": False,
            "publication_status": "not_authorized",
        })
    decision_request = {
        "id": CARD_ID, "expected_version": 2, "revision": 1,
        "action": "approve_preparation", "reason": "", "snoozed_until": None,
        "actor": "owner:historical",
    }
    preparation_request = {
        "id": CARD_ID, "expected_version": 3, "revision": 1,
        "handoff_key": handoff_key, "execution_ref": "tracker:historical",
    }
    decision_response = {
        "item": {
            **base_item, "version": 3,
            "preparation_status": (
                "dispatch_pending" if contract == "83707a164f"
                else "approved_task_linking_pending"
            ),
            "execution_link": None,
        },
        "decision": decision,
    }
    preparation_response = {
        "item": {
            **base_item, "version": 4,
            "preparation_status": (
                "linked" if contract == "83707a164f" else "linked_awaiting_triage"
            ),
            "execution_link": link,
        },
    }
    schema = (
        FROZEN_83707A164F_SCHEMA if contract == "83707a164f"
        else FROZEN_4303881843_SCHEMA
    )
    with sqlite3.connect(path) as db:
        for statement in schema:
            db.execute(statement)
        db.execute("INSERT INTO inbox_meta VALUES ('profile', ?)", (PROFILE,))
        db.execute(
            """INSERT INTO work_cards
               (id,source_key,payload,state,revision,version,created_at,updated_at,
                approval,attention_generation,execution_link)
               VALUES (?,?,?,'in_progress',1,4,?,?,?,1,?)""",
            (
                CARD_ID, "historical:receipt", PAYLOAD_JSON, CREATED_AT, CREATED_AT,
                json.dumps(approval, sort_keys=True, separators=(",", ":")),
                json.dumps(link, sort_keys=True, separators=(",", ":")),
            ),
        )
        db.execute(
            "INSERT INTO work_revisions VALUES (?,?,?,?)",
            (CARD_ID, 1, PAYLOAD_JSON, CREATED_AT),
        )
        db.execute(
            """INSERT INTO work_decisions
               VALUES (:id,:card_id,:revision,:action,:actor,:reason,:snoozed_until,
                       :created_at,:scope)""",
            decision,
        )
        db.executemany(
            "INSERT INTO work_idempotency VALUES (?,?,?,?)",
            (
                (
                    "decision", "historical-decision-key",
                    json.dumps(decision_request, sort_keys=True, separators=(",", ":")),
                    json.dumps(decision_response, sort_keys=True, separators=(",", ":")),
                ),
                (
                    "preparation", "historical-handoff-key",
                    json.dumps(preparation_request, sort_keys=True, separators=(",", ":")),
                    json.dumps(preparation_response, sort_keys=True, separators=(",", ":")),
                ),
            ),
        )


def _read_only_contents(path):
    """Capture schema and every table row through a live read-only handle."""
    with sqlite3.connect(f"{path.as_uri()}?mode=ro&nofollow=1", uri=True) as db:
        db.execute("PRAGMA query_only=ON")
        catalog = tuple(
            db.execute(
                "SELECT type,name,tbl_name,sql FROM sqlite_master "
                "WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
            )
        )
        rows = {
            name: tuple(db.execute(f'SELECT * FROM "{name}" ORDER BY rowid'))
            for kind, name, _table, _sql in catalog
            if kind == "table"
        }
        columns = {
            name: tuple(db.execute(f'PRAGMA table_info("{name}")'))
            for kind, name, _table, _sql in catalog
            if kind == "table"
        }
        return catalog, columns, rows


def _card_from_fresh_client(path):
    return WorkStore(path, PROFILE).get(CARD_ID)["item"]


def _decide_after_barrier(card, barrier, key):
    barrier.wait(timeout=5)
    try:
        return companion_work.execute(
            "decide",
            {
                "id": card["id"],
                "expected_version": card["version"],
                "revision": card["revision"],
                "action": "approve_preparation",
                "idempotency_key": key,
            },
            owner_authorization=f"owner:{key}",
        )
    except WorkError as exc:
        return exc.code


def test_frozen_real_schema_is_read_without_creation_or_migration(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = tmp_path / "companion-work.db"
    _create_frozen_store(path)
    before_bytes = path.read_bytes()
    before_contents = _read_only_contents(path)
    _catalog, _columns, rows = before_contents
    assert rows["inbox_meta"] == (("profile", PROFILE),)
    assert rows["work_revisions"] == tuple(
        (CARD_ID, revision, PAYLOAD_JSON, CREATED_AT) for revision in range(1, 8)
    )
    assert rows["work_decisions"] == ()

    assert existing_card_ids(path, PROFILE, [CARD_ID, "absent"]) == {CARD_ID}
    assert _read_only_contents(path) == before_contents
    assert path.read_bytes() == before_bytes

    missing = tmp_path / "missing-work.db"
    assert existing_card_ids(missing, PROFILE, [CARD_ID]) is None
    assert not missing.exists()


def test_existing_lookup_observes_committed_card_still_in_wal(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = tmp_path / "companion-work.db"
    store = WorkStore(path, PROFILE)
    store.upsert("wal:baseline", PAYLOAD)

    with sqlite3.connect(path) as reader:
        assert reader.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
        reader.execute("PRAGMA wal_autocheckpoint=0")
        reader.execute("BEGIN")
        reader.execute("SELECT COUNT(*) FROM work_cards").fetchone()

        card = store.upsert(
            "wal:visible", {**PAYLOAD, "title": "Visible in WAL"}
        )["item"]
        assert path.with_name(f"{path.name}-wal").exists()
        with sqlite3.connect(f"{path.as_uri()}?mode=ro&nofollow=1", uri=True) as db:
            assert db.execute(
                "SELECT id FROM work_cards WHERE id=?", (card["id"],)
            ).fetchone() == (card["id"],)

        assert existing_card_ids(path, PROFILE, [card["id"]]) == {card["id"]}


@pytest.mark.parametrize("stored", [None, "{", "NaN", " {\"ok\":true}"])
def test_stored_json_maps_decode_encode_and_noncanonical_failures(stored):
    with pytest.raises(WorkError) as invalid:
        _stored_json(stored, "fixture")
    assert invalid.value.code == 4404


def test_two_concurrent_clients_persist_one_revision_bound_decision(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = tmp_path / "companion-work.db"
    _create_frozen_store(path)
    monkeypatch.setattr(
        companion_work, "resolve_store", lambda profile=None: WorkStore(path, PROFILE)
    )
    monkeypatch.setattr(companion_work, "owner_identity", lambda identity: identity)
    monkeypatch.setattr(
        ws_tickets, "leased_human_identity", lambda authorization: authorization
    )
    card = _card_from_fresh_client(path)
    assert (card["revision"], card["version"], card["state"]) == (7, 8, "needs_me")

    barrier = threading.Barrier(2)
    keys = ("p5-w1:first-click", "p5-w1:second-click")
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(lambda key: _decide_after_barrier(card, barrier, key), keys)
        )

    accepted = next(result for result in results if isinstance(result, dict))
    assert sorted(result for result in results if isinstance(result, int)) == [4409]
    decision = accepted["decision"]
    assert decision["id"] not in keys
    assert decision["revision"] == card["revision"]
    assert decision["scope"] == "preparation_only"

    # Only a new authoritative read is confirmation; the mutation response alone
    # is not used to establish the persisted card/decision relationship.
    readback = companion_work.execute("get", {"id": CARD_ID})
    assert readback["decisions"] == [decision]
    assert readback["item"]["revision"] == 7
    assert readback["item"]["version"] == 9
    assert readback["item"]["approval"] == {
        "revision": 7,
        "scope": "preparation_only",
        "decision_id": decision["id"],
    }

    winning_key = keys[results.index(accepted)]
    replay = companion_work.execute(
        "decide",
        {
            "id": card["id"],
            "expected_version": card["version"],
            "revision": card["revision"],
            "action": "approve_preparation",
            "idempotency_key": winning_key,
        },
        owner_authorization=f"owner:{winning_key}",
    )
    assert replay == accepted

    with sqlite3.connect(f"{path.as_uri()}?mode=ro&nofollow=1", uri=True) as db:
        db.execute("PRAGMA query_only=ON")
        persisted_decisions = db.execute(
            "SELECT id,card_id,revision,action,actor,scope FROM work_decisions"
        ).fetchall()
        persisted_card = db.execute(
            "SELECT revision,version,approval FROM work_cards WHERE id=?", (CARD_ID,)
        ).fetchone()
        persisted_revisions = db.execute(
            "SELECT revision,payload FROM work_revisions WHERE card_id=?", (CARD_ID,)
        ).fetchall()
        idempotency_count = db.execute(
            "SELECT COUNT(*) FROM work_idempotency WHERE kind='decision'"
        ).fetchone()[0]

    assert persisted_decisions == [
        (
            decision["id"],
            CARD_ID,
            7,
            "approve_preparation",
            decision["actor"],
            "preparation_only",
        )
    ]
    assert persisted_card[:2] == (7, 9)
    assert json.loads(persisted_card[2])["decision_id"] == decision["id"]
    assert persisted_revisions == [
        (revision, PAYLOAD_JSON) for revision in range(1, 8)
    ]
    assert idempotency_count == 1


def test_existing_lookup_rejects_missing_schema_revision_and_approval_relation(
    tmp_path, monkeypatch,
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))

    missing_table = tmp_path / "missing-table.db"
    schema_without_decisions = tuple(
        statement for statement in FROZEN_SCHEMA
        if "CREATE TABLE work_decisions" not in statement
    )
    _create_frozen_store(missing_table, schema=schema_without_decisions)
    with pytest.raises(WorkError) as missing:
        existing_card_ids(missing_table, PROFILE, [CARD_ID])
    assert missing.value.code == 4404

    wrong_revision = tmp_path / "wrong-revision.db"
    _create_frozen_store(wrong_revision)
    with sqlite3.connect(wrong_revision) as db:
        db.execute(
            "UPDATE work_revisions SET payload=? WHERE card_id=? AND revision=7",
            (json.dumps({**PAYLOAD, "brief": "different"}), CARD_ID),
        )
    with pytest.raises(WorkError) as revision:
        existing_card_ids(wrong_revision, PROFILE, [CARD_ID])
    assert revision.value.code == 4404

    relation = tmp_path / "wrong-approval.db"
    store = WorkStore(relation, PROFILE)
    card = store.upsert("approval-relation", PAYLOAD)["item"]
    card = store.propose(card["id"], card["version"])["item"]
    approved = store.decide(
        card["id"], card["version"], card["revision"], "approve_preparation",
        "approval-relation", human_identity="owner:p5-w1",
    )["item"]
    with sqlite3.connect(relation) as db:
        decision_id = approved["approval"]["decision_id"]
        db.execute(
            "UPDATE work_decisions SET action='decline' WHERE id=?", (decision_id,)
        )
    with pytest.raises(WorkError) as approval:
        existing_card_ids(relation, PROFILE, [card["id"]])
    assert approval.value.code == 4404


@pytest.mark.parametrize(
    ("variant", "schema"),
    [
        ("83707a164f", FROZEN_83707A164F_SCHEMA),
        ("4303881843", FROZEN_4303881843_SCHEMA),
        ("current", FROZEN_SCHEMA),
    ],
)
def test_existing_lookup_supports_each_exact_store_schema_without_side_effects(
    tmp_path, monkeypatch, variant, schema,
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = tmp_path / f"{variant}.db"
    _create_frozen_store(path, schema=schema)
    before = path.read_bytes()
    assert existing_card_ids(path, PROFILE, [CARD_ID]) == {CARD_ID}
    assert path.read_bytes() == before


@pytest.mark.parametrize("contract", ["83707a164f", "4303881843"])
def test_historical_decision_and_handoff_receipts_are_accepted_byte_identically(
    tmp_path, monkeypatch, contract,
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = tmp_path / f"historical-receipts-{contract}.db"
    _create_historical_receipt_store(path, contract)
    before = path.read_bytes()

    assert existing_card_ids(path, PROFILE, [CARD_ID]) == {CARD_ID}
    assert path.read_bytes() == before


@pytest.mark.parametrize("receipt_key", ["historical-decision-key", "historical-handoff-key"])
def test_historical_receipt_envelopes_still_reject_malformed_snapshots(
    tmp_path, monkeypatch, receipt_key,
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = tmp_path / f"malformed-{receipt_key}.db"
    _create_historical_receipt_store(path)
    with sqlite3.connect(path) as db:
        response = json.loads(db.execute(
            "SELECT response FROM work_idempotency WHERE key=?", (receipt_key,)
        ).fetchone()[0])
        response["item"].pop("completion_evidence")
        db.execute(
            "UPDATE work_idempotency SET response=? WHERE key=?",
            (json.dumps(response, sort_keys=True, separators=(",", ":")), receipt_key),
        )

    before = path.read_bytes()
    with pytest.raises(WorkError) as malformed:
        existing_card_ids(path, PROFILE, [CARD_ID])
    assert malformed.value.code == 4404
    assert path.read_bytes() == before


@pytest.mark.parametrize("missing_table", ["work_comments", "work_digest_receipts"])
def test_existing_lookup_rejects_frozen_schema_missing_common_ancillary_table(
    tmp_path, monkeypatch, missing_table,
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = tmp_path / f"missing-{missing_table}.db"
    deficient_schema = tuple(
        statement for statement in FROZEN_SCHEMA
        if not statement.startswith(f"CREATE TABLE {missing_table}")
    )
    _create_frozen_store(path, schema=deficient_schema)
    before = path.read_bytes()

    with pytest.raises(WorkError) as missing:
        existing_card_ids(path, PROFILE, [CARD_ID])
    assert missing.value.code == 4404
    assert path.read_bytes() == before


@pytest.mark.parametrize(
    ("table_name", "old", "new"),
    [
        ("work_comments", "actor TEXT NOT NULL", "actor TEXT"),
        ("work_digest_receipts", "attention_key TEXT NOT NULL", "attention_key TEXT"),
        ("work_digest_batches", "batch_id TEXT UNIQUE NOT NULL", "batch_id TEXT NOT NULL"),
    ],
)
def test_existing_lookup_rejects_malformed_ancillary_table_and_index_contract(
    tmp_path, monkeypatch, table_name, old, new,
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = tmp_path / f"malformed-{table_name}.db"
    deficient_schema = tuple(
        statement.replace(old, new)
        if statement.startswith(f"CREATE TABLE {table_name}") else statement
        for statement in FROZEN_SCHEMA
    )
    _create_frozen_store(path, schema=deficient_schema)
    before = path.read_bytes()

    with pytest.raises(WorkError) as malformed:
        existing_card_ids(path, PROFILE, [CARD_ID])
    assert malformed.value.code == 4404
    assert path.read_bytes() == before


@pytest.mark.parametrize(
    ("assignment", "value"),
    [("version", 6), ("attention_generation", 8), ("changes_revision", 7)],
)
def test_existing_lookup_rejects_unreachable_lifecycle_counters(
    tmp_path, monkeypatch, assignment, value,
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = tmp_path / f"counter-{assignment}.db"
    _create_frozen_store(path)
    with sqlite3.connect(path) as db:
        db.execute(f"UPDATE work_cards SET {assignment}=? WHERE id=?", (value, CARD_ID))
    with pytest.raises(WorkError) as corrupt:
        existing_card_ids(path, PROFILE, [CARD_ID])
    assert corrupt.value.code == 4404


@pytest.mark.parametrize(
    "legacy_evidence",
    ['"verified result"', '[]', '["artifact:result"]', '{"looks":"structured"}', 'null', '123'],
)
def test_json_looking_legacy_completion_is_proved_by_history_not_json_shape(
    tmp_path, monkeypatch, legacy_evidence,
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = tmp_path / "legacy-completion.db"
    store = WorkStore(path, PROFILE)
    card = store.upsert("legacy-completion", PAYLOAD)["item"]
    card = store.propose(card["id"], card["version"])["item"]
    card = store.decide(
        card["id"], card["version"], card["revision"], "approve_preparation",
        "legacy-approval", human_identity="owner:p5-w1",
    )["item"]
    card = store.preparation_ack(
        card["id"], card["version"], card["revision"], card["handoff_key"],
        "tracker:legacy", "legacy-link",
    )["item"]
    with sqlite3.connect(path) as db:
        db.execute(
            "UPDATE work_cards SET state='done',version=version+1,completion_evidence=? "
            "WHERE id=?", (legacy_evidence, card["id"]),
        )
    assert existing_card_ids(path, PROFILE, [card["id"]]) == {card["id"]}


def test_structured_completion_cannot_fall_back_to_legacy_when_snapshot_is_missing(
    tmp_path, monkeypatch,
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = tmp_path / "broken-structured-completion.db"
    store = WorkStore(path, PROFILE)
    card = store.upsert("structured-completion", PAYLOAD)["item"]
    card = store.propose(card["id"], card["version"])["item"]
    card = store.decide(
        card["id"], card["version"], card["revision"], "approve_preparation",
        "structured-approval", human_identity="owner:p5-w1",
    )["item"]
    card = store.preparation_ack(
        card["id"], card["version"], card["revision"], card["handoff_key"],
        "tracker:structured", "structured-link",
    )["item"]
    card = store.preparation_status_update(
        card["id"], card["version"], card["revision"], card["handoff_key"], {
            "state": "prepared", "execution_ref": "tracker:structured",
            "observed_at": "2026-09-10T08:05:00+00:00",
            "evidence": ["tracker read-back"], "result_evidence": ["artifact:result"],
        }, "structured-status",
    )["item"]
    done = store.complete(card["id"], card["version"], "verified")["item"]
    with sqlite3.connect(path) as db:
        db.execute("UPDATE work_cards SET tracker_evidence=NULL WHERE id=?", (done["id"],))
    with pytest.raises(WorkError) as corrupt:
        existing_card_ids(path, PROFILE, [done["id"]])
    assert corrupt.value.code == 4404


@pytest.mark.parametrize(
    "extra_ddl",
    [
        "CREATE UNIQUE INDEX extra_card_state ON work_cards(state)",
        "CREATE UNIQUE INDEX partial_card_source ON work_cards(source_key) "
        "WHERE state='needs_me'",
    ],
)
def test_existing_lookup_rejects_extra_and_partial_unique_indexes(
    tmp_path, monkeypatch, extra_ddl,
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = tmp_path / "extra-index.db"
    _create_frozen_store(path, extra_ddl=(extra_ddl,))
    with pytest.raises(WorkError) as corrupt:
        existing_card_ids(path, PROFILE, [CARD_ID])
    assert corrupt.value.code == 4404


def test_existing_lookup_rejects_unique_constraint_with_wrong_index_origin(
    tmp_path, monkeypatch,
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = tmp_path / "wrong-index-origin.db"
    cards_without_unique = FROZEN_SCHEMA[1].replace(
        "source_key TEXT UNIQUE NOT NULL", "source_key TEXT NOT NULL"
    )
    schema = (FROZEN_SCHEMA[0], cards_without_unique, *FROZEN_SCHEMA[2:])
    _create_frozen_store(
        path,
        schema=schema,
        extra_ddl=("CREATE UNIQUE INDEX source_key_unique ON work_cards(source_key)",),
    )
    with pytest.raises(WorkError) as corrupt:
        existing_card_ids(path, PROFILE, [CARD_ID])
    assert corrupt.value.code == 4404


def test_existing_lookup_rejects_fabricated_second_preparation_receipt(
    tmp_path, monkeypatch,
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = tmp_path / "fabricated-second-preparation.db"
    store = WorkStore(path, PROFILE)
    card = store.upsert("fabricated-second-preparation", PAYLOAD)["item"]
    card = store.propose(card["id"], card["version"])["item"]
    card = store.decide(
        card["id"], card["version"], card["revision"], "approve_preparation",
        "fabricated-second-decision", human_identity="owner:p5-w1",
    )["item"]
    linked = store.preparation_ack(
        card["id"], card["version"], card["revision"], card["handoff_key"],
        "tracker:real", "fabricated-second-real-ack",
    )["item"]
    assert linked["version"] == 4

    forged_item = dict(linked, version=5)
    request = {
        "id": linked["id"], "expected_version": 4, "revision": linked["revision"],
        "handoff_key": linked["handoff_key"], "execution_ref": "tracker:real",
    }
    with sqlite3.connect(path) as db:
        db.execute(
            "INSERT INTO work_idempotency VALUES ('preparation',?,?,?)",
            (
                "fabricated-second-ack",
                json.dumps(request, sort_keys=True, separators=(",", ":")),
                json.dumps({"item": forged_item}, sort_keys=True, separators=(",", ":")),
            ),
        )
        db.execute(
            "UPDATE work_cards SET version=5 WHERE id=?",
            (linked["id"],),
        )

    with pytest.raises(WorkError) as corrupt:
        existing_card_ids(path, PROFILE, [linked["id"]])
    assert corrupt.value.code == 4404


@pytest.mark.parametrize(
    ("forged_expected_version", "forged_version", "durable_version", "revise_first"),
    [(100, 101, 4, False), (3, 4, 5, True)],
)
def test_existing_lookup_rejects_decision_receipt_outside_exact_version_timeline(
    tmp_path, monkeypatch, forged_expected_version, forged_version, durable_version,
    revise_first,
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    now = [datetime(2026, 9, 10, 8, tzinfo=timezone.utc)]
    path = tmp_path / f"forged-decision-{forged_expected_version}.db"
    store = WorkStore(path, PROFILE, clock=lambda: now[0])
    card = store.upsert("forged-decision-version", PAYLOAD)["item"]
    card = store.propose(card["id"], card["version"])["item"]
    first = store.decide(
        card["id"], card["version"], card["revision"], "snooze",
        "real-snooze", snoozed_until=(now[0] + timedelta(hours=1)).isoformat(),
        human_identity="owner:p5-w1",
    )
    card = first["item"]
    if revise_first:
        card = store.upsert(
            card["source_key"], {**PAYLOAD, "brief": "Revised while snoozed."},
            card["version"],
        )["item"]

    forged_until = (now[0] + timedelta(hours=2)).isoformat()
    forged_decision = {
        "id": f"forged-decision-{forged_expected_version}", "card_id": card["id"],
        "revision": card["revision"], "action": "snooze", "actor": "owner:p5-w1",
        "reason": "", "snoozed_until": forged_until,
        "created_at": now[0].isoformat(), "scope": "none",
    }
    forged_request = {
        "id": card["id"], "expected_version": forged_expected_version,
        "revision": card["revision"], "action": "snooze", "reason": "",
        "snoozed_until": forged_until, "actor": "owner:p5-w1",
    }
    forged_item = {
        **card, "version": forged_version, "snoozed_until": forged_until,
        "attention_due": False,
        "attention_key": f"2026-09-10:{card['revision']}:3",
    }
    forged_response = {"item": forged_item, "decision": forged_decision}
    encoded_request = json.dumps(forged_request, sort_keys=True, separators=(",", ":"))
    encoded_response = json.dumps(forged_response, sort_keys=True, separators=(",", ":"))
    with sqlite3.connect(path) as db:
        db.execute(
            "INSERT INTO work_decisions VALUES (:id,:card_id,:revision,:action,:actor,"
            ":reason,:snoozed_until,:created_at,:scope)", forged_decision,
        )
        db.execute(
            "INSERT INTO work_idempotency VALUES ('decision','forged-second-snooze',?,?)",
            (encoded_request, encoded_response),
        )
        db.execute(
            "UPDATE work_cards SET version=?,attention_generation=3,snoozed_until=? "
            "WHERE id=?", (durable_version, forged_until, card["id"]),
        )

    with pytest.raises(WorkError) as corrupt:
        existing_card_ids(path, PROFILE, [card["id"]])
    assert corrupt.value.code == 4404
    with sqlite3.connect(path) as db:
        assert db.execute(
            "SELECT request,response FROM work_idempotency "
            "WHERE kind='decision' AND key='forged-second-snooze'"
        ).fetchone() == (encoded_request, encoded_response)
        assert db.execute(
            "SELECT id FROM work_decisions WHERE id=?", (forged_decision["id"],)
        ).fetchone() == (forged_decision["id"],)


def test_existing_lookup_accepts_exact_repeated_snooze_decision_timeline(
    tmp_path, monkeypatch,
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    now = [datetime(2026, 9, 10, 8, tzinfo=timezone.utc)]
    path = tmp_path / "repeated-snooze.db"
    store = WorkStore(path, PROFILE, clock=lambda: now[0])
    card = store.upsert("repeated-snooze", PAYLOAD)["item"]
    card = store.propose(card["id"], card["version"])["item"]
    card = store.decide(
        card["id"], card["version"], card["revision"], "snooze", "snooze-one",
        snoozed_until=(now[0] + timedelta(hours=1)).isoformat(),
        human_identity="owner:p5-w1",
    )["item"]
    now[0] += timedelta(hours=1)
    card = store.decide(
        card["id"], card["version"], card["revision"], "snooze", "snooze-two",
        snoozed_until=(now[0] + timedelta(hours=1)).isoformat(),
        human_identity="owner:p5-w1",
    )["item"]

    assert (card["version"], card["attention_key"]) == (4, "2026-09-10:1:3")
    assert existing_card_ids(path, PROFILE, [card["id"]]) == {card["id"]}


@pytest.mark.parametrize(
    "attention_key", ["2026-09-10:1", "2026-09-10:2:1", "2026-09-10:1:2"],
)
def test_existing_lookup_rejects_invalid_decision_attention_coordinates(
    tmp_path, monkeypatch, attention_key,
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = tmp_path / "invalid-decision-attention.db"
    store = WorkStore(path, PROFILE)
    card = store.upsert("invalid-decision-attention", PAYLOAD)["item"]
    card = store.propose(card["id"], card["version"])["item"]
    decided = store.decide(
        card["id"], card["version"], card["revision"], "decline",
        "attention-decision", human_identity="owner:p5-w1",
    )["item"]
    with sqlite3.connect(path) as db:
        response = json.loads(db.execute(
            "SELECT response FROM work_idempotency "
            "WHERE kind='decision' AND key='attention-decision'"
        ).fetchone()[0])
        response["item"]["attention_key"] = attention_key
        db.execute(
            "UPDATE work_idempotency SET response=? "
            "WHERE kind='decision' AND key='attention-decision'",
            (json.dumps(response, sort_keys=True, separators=(",", ":")),),
        )

    with pytest.raises(WorkError) as corrupt:
        existing_card_ids(path, PROFILE, [decided["id"]])
    assert corrupt.value.code == 4404


@pytest.mark.parametrize("corruption", ["decision_actor", "fake_receipt", "preparation", "status"])
def test_existing_lookup_requires_exact_transition_receipts_and_effects(
    tmp_path, monkeypatch, corruption,
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = tmp_path / f"receipt-{corruption}.db"
    store = WorkStore(path, PROFILE)
    card = store.upsert(f"receipt:{corruption}", PAYLOAD)["item"]
    card = store.propose(card["id"], card["version"])["item"]
    approved = store.decide(
        card["id"], card["version"], card["revision"], "approve_preparation",
        "decision-receipt", human_identity="owner:p5-w1",
    )
    card = approved["item"]
    linked = store.preparation_ack(
        card["id"], card["version"], card["revision"], card["handoff_key"],
        "tracker:receipt", "preparation-receipt",
    )["item"]
    status = store.preparation_status_update(
        linked["id"], linked["version"], linked["revision"], linked["handoff_key"],
        {
            "state": "preparing", "execution_ref": "tracker:receipt",
            "observed_at": "2026-09-10T08:10:00+00:00",
            "evidence": ["tracker read-back"],
        },
        "status-receipt",
    )["item"]

    with sqlite3.connect(path) as db:
        if corruption == "decision_actor":
            db.execute(
                "UPDATE work_decisions SET actor='attacker' WHERE id=?",
                (approved["decision"]["id"],),
            )
        else:
            key = {
                "fake_receipt": "decision-receipt",
                "preparation": "preparation-receipt",
                "status": "status-receipt",
            }[corruption]
            response = json.loads(db.execute(
                "SELECT response FROM work_idempotency WHERE key=?", (key,)
            ).fetchone()[0])
            if corruption == "fake_receipt":
                response["forged"] = True
            elif corruption == "preparation":
                response["item"]["execution_link"]["execution_ref"] = "tracker:forged"
            else:
                response["item"]["tracker_evidence"]["state"] = "prepared"
            db.execute(
                "UPDATE work_idempotency SET response=? WHERE key=?",
                (json.dumps(response, sort_keys=True, separators=(",", ":")), key),
            )

    with pytest.raises(WorkError) as corrupt:
        existing_card_ids(path, PROFILE, [status["id"]])
    assert corrupt.value.code == 4404


@pytest.mark.parametrize("corruption", ["nan_payload", "text_revision", "real_counter"])
def test_existing_lookup_maps_stored_nan_and_wrong_scalar_types_to_4404(
    tmp_path, monkeypatch, corruption,
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = tmp_path / f"stored-type-{corruption}.db"
    _create_frozen_store(path)
    with sqlite3.connect(path) as db:
        if corruption == "nan_payload":
            invalid = PAYLOAD_JSON.replace('"Campaign review"', "NaN")
            db.execute("UPDATE work_cards SET payload=? WHERE id=?", (invalid, CARD_ID))
            db.execute(
                "UPDATE work_revisions SET payload=? WHERE card_id=? AND revision=7",
                (invalid, CARD_ID),
            )
        elif corruption == "text_revision":
            db.execute("UPDATE work_cards SET revision='wrong' WHERE id=?", (CARD_ID,))
        else:
            db.execute(
                "UPDATE work_cards SET attention_generation=1.5 WHERE id=?", (CARD_ID,)
            )
    with pytest.raises(WorkError) as corrupt:
        existing_card_ids(path, PROFILE, [CARD_ID])
    assert corrupt.value.code == 4404
