"""Read-only integrity proof for existing profile-local WorkStore databases.

This module validates frozen persistence contracts without creating, migrating,
or mutating the store it observes. WorkStore itself remains the mutation owner.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import json
import os
from pathlib import Path
import sqlite3
import stat

from hermes_cli.companion_work_store import (
    ACTIONS, DEFAULT_RECOMMENDED_ACTION, STATES, WorkError, anchored_store_path,
    canonical, integer, payload_checked, text, timestamp, tracker_evidence_checked,
)

_LEGACY_WORK_CARD_COLUMNS = (
    ('id', 'TEXT', 0, None, 1), ('source_key', 'TEXT', 1, None, 0),
    ('payload', 'TEXT', 1, None, 0), ('state', 'TEXT', 1, None, 0),
    ('revision', 'INTEGER', 1, None, 0), ('version', 'INTEGER', 1, None, 0),
    ('created_at', 'TEXT', 1, None, 0), ('updated_at', 'TEXT', 1, None, 0),
    ('snoozed_until', 'TEXT', 0, None, 0), ('approval', 'TEXT', 0, None, 0),
    ('attention_generation', 'INTEGER', 1, '0', 0),
    ('changes_revision', 'INTEGER', 0, None, 0),
    ('execution_link', 'TEXT', 0, None, 0),
    ('completion_evidence', 'TEXT', 0, None, 0),
)
_TRACKER_WORK_CARD_COLUMNS = _LEGACY_WORK_CARD_COLUMNS + (
    ('tracker_evidence', 'TEXT', 0, None, 0),
)
_COMMON_WORK_TABLE_SCHEMAS = {
    'inbox_meta': (
        ('key', 'TEXT', 0, None, 1), ('value', 'TEXT', 1, None, 0),
    ),
    'work_revisions': (
        ('card_id', 'TEXT', 1, None, 1), ('revision', 'INTEGER', 1, None, 2),
        ('payload', 'TEXT', 1, None, 0), ('created_at', 'TEXT', 1, None, 0),
    ),
    'work_comments': (
        ('id', 'TEXT', 0, None, 1), ('card_id', 'TEXT', 1, None, 0),
        ('revision', 'INTEGER', 1, None, 0), ('actor', 'TEXT', 1, None, 0),
        ('text', 'TEXT', 1, None, 0), ('created_at', 'TEXT', 1, None, 0),
    ),
    'work_decisions': (
        ('id', 'TEXT', 0, None, 1), ('card_id', 'TEXT', 1, None, 0),
        ('revision', 'INTEGER', 1, None, 0), ('action', 'TEXT', 1, None, 0),
        ('actor', 'TEXT', 1, None, 0), ('reason', 'TEXT', 1, None, 0),
        ('snoozed_until', 'TEXT', 0, None, 0), ('created_at', 'TEXT', 1, None, 0),
        ('scope', 'TEXT', 1, None, 0),
    ),
    'work_idempotency': (
        ('kind', 'TEXT', 1, None, 1), ('key', 'TEXT', 1, None, 2),
        ('request', 'TEXT', 1, None, 0), ('response', 'TEXT', 1, None, 0),
    ),
    'work_digest_receipts': (
        ('consumer', 'TEXT', 1, None, 1), ('card_id', 'TEXT', 1, None, 2),
        ('attention_key', 'TEXT', 1, None, 3),
    ),
}
_TRACKER_EVENT_TABLE_SCHEMA = (
    ('id', 'TEXT', 0, None, 1), ('card_id', 'TEXT', 1, None, 0),
    ('revision', 'INTEGER', 1, None, 0), ('handoff_key', 'TEXT', 1, None, 0),
    ('execution_ref', 'TEXT', 0, None, 0),
    ('tracker_evidence', 'TEXT', 1, None, 0), ('created_at', 'TEXT', 1, None, 0),
)
_DIGEST_BATCH_TABLE_SCHEMA = (
    ('consumer', 'TEXT', 1, None, 1), ('local_date', 'TEXT', 1, None, 2),
    ('batch_id', 'TEXT', 1, None, 0), ('items', 'TEXT', 1, None, 0),
    ('created_at', 'TEXT', 1, None, 0), ('acknowledged_at', 'TEXT', 0, None, 0),
)
_COMMON_WORK_INDEX_SIGNATURES = {
    'inbox_meta': frozenset({(1, 'pk', 0, ('key',))}),
    'work_cards': frozenset({
        (1, 'pk', 0, ('id',)), (1, 'u', 0, ('source_key',)),
    }),
    'work_revisions': frozenset({(1, 'pk', 0, ('card_id', 'revision'))}),
    'work_comments': frozenset({(1, 'pk', 0, ('id',))}),
    'work_decisions': frozenset({(1, 'pk', 0, ('id',))}),
    'work_idempotency': frozenset({(1, 'pk', 0, ('kind', 'key'))}),
    'work_digest_receipts': frozenset({
        (1, 'pk', 0, ('consumer', 'card_id', 'attention_key')),
    }),
}
_TRACKER_EVENT_INDEX_SIGNATURES = frozenset({(1, 'pk', 0, ('id',))})
_DIGEST_BATCH_INDEX_SIGNATURES = frozenset({
    (1, 'pk', 0, ('consumer', 'local_date')),
    (1, 'u', 0, ('batch_id',)),
})


@dataclass(frozen=True)
class ExistingWorkSchema:
    name: str
    tables: dict
    indexes: dict
    tracker_column: bool
    tracker_events: bool


def _schema_variant(name, cards, *, tracker_events=False, digest_batches=False):
    tables = dict(_COMMON_WORK_TABLE_SCHEMAS, work_cards=cards)
    indexes = dict(_COMMON_WORK_INDEX_SIGNATURES)
    if tracker_events:
        tables['work_tracker_status_events'] = _TRACKER_EVENT_TABLE_SCHEMA
        indexes['work_tracker_status_events'] = _TRACKER_EVENT_INDEX_SIGNATURES
    if digest_batches:
        tables['work_digest_batches'] = _DIGEST_BATCH_TABLE_SCHEMA
        indexes['work_digest_batches'] = _DIGEST_BATCH_INDEX_SIGNATURES
    return ExistingWorkSchema(
        name, tables, indexes, cards == _TRACKER_WORK_CARD_COLUMNS, tracker_events,
    )


_SUPPORTED_WORK_SCHEMAS = (
    _schema_variant('83707a164f', _LEGACY_WORK_CARD_COLUMNS),
    _schema_variant('4303881843', _TRACKER_WORK_CARD_COLUMNS, tracker_events=True),
    _schema_variant(
        'current', _TRACKER_WORK_CARD_COLUMNS,
        tracker_events=True, digest_batches=True,
    ),
)


@dataclass(frozen=True)
class ReceiptEnvelope:
    name: str
    item_fields: frozenset
    preparation_pending: str
    preparation_linked: str
    has_tracker_projection: bool
    has_publication_status: bool
    has_recommended_action: bool


_BASE_RECEIPT_ITEM_FIELDS = frozenset({
    'id', 'profile', 'source_key', 'state', 'revision', 'version',
    'created_at', 'updated_at', 'snoozed_until', 'attention_due',
    'preparation_status', 'handoff_key', 'execution_link',
    'completion_evidence', 'attention_key', 'approval',
})
_SUPPORTED_RECEIPT_ENVELOPES = (
    ReceiptEnvelope(
        '83707a164f', _BASE_RECEIPT_ITEM_FIELDS,
        'dispatch_pending', 'linked', False, False, False,
    ),
    ReceiptEnvelope(
        '4303881843', _BASE_RECEIPT_ITEM_FIELDS | frozenset({
            'tracker_evidence', 'handoff_reconciliation_required',
            'publication_status',
        }),
        'approved_task_linking_pending', 'linked_awaiting_triage', True, True, False,
    ),
    ReceiptEnvelope(
        'current', _BASE_RECEIPT_ITEM_FIELDS | frozenset({
            'tracker_evidence', 'handoff_reconciliation_required',
            'publication_status', 'recommended_action',
        }),
        'approved_task_linking_pending', 'linked_awaiting_triage', True, True, True,
    ),
)

def _stored_error(description):
    return WorkError(f'stored work {description} is invalid', 4404)


def _stored_json(value, description):
    try:
        result = json.loads(value)
        encoded = canonical(result)
    except (TypeError, ValueError) as exc:
        raise _stored_error(description) from exc
    if encoded != value:
        raise _stored_error(description)
    return result


def _attention_key_coordinates(value):
    if not isinstance(value, str):
        raise _stored_error('decision attention key')
    parts = value.split(':')
    if len(parts) != 3:
        raise _stored_error('decision attention key')
    local_date, revision_text, generation_text = parts
    try:
        parsed_date = datetime.strptime(local_date, '%Y-%m-%d').date()
        revision = int(revision_text)
        generation = int(generation_text)
    except (TypeError, ValueError) as exc:
        raise _stored_error('decision attention key') from exc
    if (str(parsed_date) != local_date or str(revision) != revision_text
            or str(generation) != generation_text or revision < 1 or generation < 0):
        raise _stored_error('decision attention key')
    return revision, generation


def _table_signature(db, table_name):
    if db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table_name,)
    ).fetchone() is None:
        return None
    return tuple(
        (row['name'], row['type'].upper(), row['notnull'], row['dflt_value'], row['pk'])
        for row in db.execute(f'PRAGMA table_info("{table_name}")')
    )


def _index_signatures(db, table_name):
    result = set()
    for index in db.execute(f'PRAGMA index_list("{table_name}")'):
        columns = tuple(
            row['name'] for row in db.execute(
                f'PRAGMA index_info("{index["name"]}")'
            )
        )
        result.add((index['unique'], index['origin'], index['partial'], columns))
    return frozenset(result)


def _validate_existing_store_schema(db):
    table_names = frozenset(
        row['name'] for row in db.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
    )
    for variant in _SUPPORTED_WORK_SCHEMAS:
        if table_names != frozenset(variant.tables):
            continue
        if any(
            _table_signature(db, table_name) != expected
            for table_name, expected in variant.tables.items()
        ):
            continue
        if any(
            _index_signatures(db, table_name) != expected
            for table_name, expected in variant.indexes.items()
        ):
            continue
        return variant
    raise _stored_error('schema')


def _transition_receipts(db, card_row, profile):
    card_id = card_row['id']
    receipts = {'decision': [], 'preparation': [], 'preparation_status': []}
    request_keys = {
        'decision': {
            'id', 'expected_version', 'revision', 'action', 'reason',
            'snoozed_until', 'actor',
        },
        'preparation': {
            'id', 'expected_version', 'revision', 'handoff_key', 'execution_ref',
        },
        'preparation_status': {
            'id', 'expected_version', 'revision', 'handoff_key', 'tracker_evidence',
        },
    }
    for receipt_row in db.execute(
        "SELECT kind,request,response FROM work_idempotency "
        "WHERE kind IN ('decision','preparation','preparation_status')"
    ):
        kind = receipt_row['kind']
        request = _stored_json(receipt_row['request'], 'idempotency request')
        response = _stored_json(receipt_row['response'], 'idempotency response')
        if not isinstance(request, dict) or not isinstance(response, dict):
            raise _stored_error('idempotency receipt')
        if request.get('id') != card_id:
            continue
        expected_version = request.get('expected_version')
        revision = request.get('revision')
        item = response.get('item')
        revision_row = db.execute(
            'SELECT payload FROM work_revisions WHERE card_id=? AND revision=?',
            (card_id, revision),
        ).fetchone()
        if (set(request) != request_keys[kind] or type(expected_version) is not int
                or type(revision) is not int or revision_row is None
                or not isinstance(item, dict) or item.get('id') != card_id
                or item.get('version') != expected_version + 1
                or item.get('revision') != revision):
            raise _stored_error('idempotency receipt')

        payload = _stored_json(revision_row['payload'], 'idempotency payload')
        envelope = next((
            candidate for candidate in _SUPPORTED_RECEIPT_ENVELOPES
            if set(item) == set(payload) | candidate.item_fields
        ), None)
        if (envelope is None
                or any(item.get(key) != value for key, value in payload.items())
                or item.get('profile') != profile
                or item.get('source_key') != card_row['source_key']
                or item.get('created_at') != card_row['created_at']
                or type(item.get('attention_due')) is not bool
                or (envelope.has_tracker_projection and
                    type(item.get('handoff_reconciliation_required')) is not bool)
                or (envelope.has_publication_status and
                    item.get('publication_status') != 'not_authorized')
                or (envelope.has_recommended_action and
                    item.get('recommended_action') != DEFAULT_RECOMMENDED_ACTION)):
            raise _stored_error('idempotency receipt')

        if kind == 'decision':
            decision = response.get('decision')
            persisted = db.execute(
                'SELECT * FROM work_decisions WHERE id=?',
                (decision.get('id') if isinstance(decision, dict) else None,),
            ).fetchone()
            expected_state = {
                'approve_preparation': 'in_progress', 'request_changes': 'ideas',
                'snooze': 'needs_me', 'decline': 'declined',
            }.get(request.get('action'))
            expected_approval = None
            expected_preparation_status = 'not_authorized'
            if request.get('action') == 'approve_preparation' and persisted is not None:
                expected_approval = {
                    'revision': revision, 'scope': 'preparation_only',
                    'decision_id': persisted['id'],
                }
                expected_preparation_status = envelope.preparation_pending
            if (set(response) != {'item', 'decision'} or persisted is None
                    or decision != dict(persisted)
                    or set(decision) != {
                        'id', 'card_id', 'revision', 'action', 'actor', 'reason',
                        'snoozed_until', 'created_at', 'scope',
                    }
                    or request.get('id') != decision['card_id']
                    or request.get('revision') != decision['revision']
                    or request.get('action') != decision['action']
                    or request.get('actor') != decision['actor']
                    or request.get('reason') != decision['reason']
                    or request.get('snoozed_until') != decision['snoozed_until']
                    or item.get('state') != expected_state
                    or item.get('snoozed_until') != request.get('snoozed_until')
                    or item.get('preparation_status') != expected_preparation_status
                    or item.get('approval') != expected_approval):
                raise _stored_error('idempotency receipt')
        elif kind == 'preparation':
            link = item.get('execution_link')
            if (set(response) != {'item'} or not isinstance(link, dict)
                    or set(link) != {'execution_ref', 'acknowledged_at', 'handoff_key'}
                    or link.get('execution_ref') != request.get('execution_ref')
                    or link.get('handoff_key') != request.get('handoff_key')
                    or item.get('state') != 'in_progress'
                    or item.get('handoff_key') != request.get('handoff_key')
                    or item.get('tracker_evidence') is not None
                    or item.get('preparation_status') != envelope.preparation_linked):
                raise _stored_error('idempotency receipt')
            timestamp(link['acknowledged_at'])
        else:
            if not envelope.has_tracker_projection:
                raise _stored_error('idempotency receipt')
            try:
                checked = tracker_evidence_checked(request.get('tracker_evidence'))
            except WorkError as exc:
                raise _stored_error('idempotency receipt') from exc
            stored_tracker = dict(
                checked, revision=revision, handoff_key=request.get('handoff_key')
            )
            if (set(response) != {'item'}
                    or request.get('tracker_evidence') != checked
                    or item.get('state') != 'in_progress'
                    or item.get('handoff_key') != request.get('handoff_key')
                    or item.get('tracker_evidence') != stored_tracker
                    or item.get('preparation_status') != checked['state']):
                raise _stored_error('idempotency receipt')
        receipts[kind].append((request, response))
    post_versions = [
        response['item']['version']
        for values in receipts.values() for _request, response in values
    ]
    if len(post_versions) != len(set(post_versions)):
        raise _stored_error('idempotency history')
    return receipts


def _validate_existing_card_history(db, row, profile, schema, approval, tracker):
    card_id = row['id']
    revision = row['revision']
    revisions = db.execute(
        'SELECT revision,payload,created_at FROM work_revisions '
        'WHERE card_id=? ORDER BY revision', (card_id,)
    ).fetchall()
    if [entry['revision'] for entry in revisions] != list(range(1, revision + 1)):
        raise _stored_error('revision history')
    for index, entry in enumerate(revisions):
        payload = _stored_json(entry['payload'], 'revision payload')
        try:
            payload_checked(payload)
            created_at = timestamp(entry['created_at'])
        except WorkError as exc:
            raise _stored_error('revision history') from exc
        if index == 0 and created_at != timestamp(row['created_at']):
            raise _stored_error('revision history')
    if revisions[-1]['payload'] != row['payload']:
        raise _stored_error('current revision payload')
    if timestamp(revisions[-1]['created_at']) > timestamp(row['updated_at']):
        raise _stored_error('revision history')

    decisions = db.execute(
        'SELECT rowid,* FROM work_decisions WHERE card_id=? ORDER BY rowid', (card_id,)
    ).fetchall()
    by_id = {}
    for decision in decisions:
        if (decision['id'] in by_id or not 1 <= decision['revision'] <= revision
                or decision['action'] not in ACTIONS
                or decision['scope'] != (
                    'preparation_only' if decision['action'] == 'approve_preparation' else 'none'
                )):
            raise _stored_error('decision history')
        try:
            text(decision['id'], 'decision id', 100)
            text(decision['actor'], 'decision actor', 20000)
            timestamp(decision['created_at'])
            if not isinstance(decision['reason'], str) or len(decision['reason']) > 20000:
                raise _stored_error('decision history')
            if decision['action'] == 'snooze':
                timestamp(decision['snoozed_until'])
            elif decision['snoozed_until'] is not None:
                raise _stored_error('decision history')
        except WorkError as exc:
            raise _stored_error('decision history') from exc
        by_id[decision['id']] = decision

    for decision_revision in range(1, revision + 1):
        history = [value for value in decisions if value['revision'] == decision_revision]
        terminal = [value for value in history if value['action'] != 'snooze']
        if len(terminal) > 1 or (terminal and history[-1]['id'] != terminal[0]['id']):
            raise _stored_error('decision history')

    current = [value for value in decisions if value['revision'] == revision]
    terminal = current[-1] if current and current[-1]['action'] != 'snooze' else None
    expected_terminal = {
        'ideas': 'request_changes', 'needs_me': None, 'declined': 'decline',
        'in_progress': 'approve_preparation', 'done': 'approve_preparation',
    }[row['state']]
    if ((terminal['action'] if terminal else None) != expected_terminal
            and not (row['state'] == 'ideas' and terminal is None)):
        raise _stored_error('lifecycle')
    if row['state'] != 'ideas' and row['changes_revision'] == revision:
        raise _stored_error('lifecycle')

    if approval is not None:
        decision = by_id.get(approval['decision_id'])
        if (decision is None or decision['card_id'] != card_id
                or decision['revision'] != revision
                or decision['action'] != 'approve_preparation'
                or decision['scope'] != 'preparation_only'
                or terminal is None or terminal['id'] != decision['id']):
            raise _stored_error('approval relation')

    receipts = _transition_receipts(db, row, profile)
    decision_receipts = {}
    for request, response in receipts['decision']:
        decision = response.get('decision')
        decision_id = decision.get('id') if isinstance(decision, dict) else None
        if decision_id in decision_receipts:
            raise _stored_error('decision idempotency history')
        decision_receipts[decision_id] = (request, response)
    if set(decision_receipts) != set(by_id):
        raise _stored_error('decision idempotency history')
    for request, response in receipts['decision']:
        decision = response.get('decision')
        if (not isinstance(decision, dict) or decision.get('id') not in by_id
                or request.get('action') != by_id[decision['id']]['action']
                or request.get('revision') != by_id[decision['id']]['revision']):
            raise _stored_error('decision idempotency history')

    snooze_count = sum(value['action'] == 'snooze' for value in decisions)
    proposal_count = row['attention_generation'] - snooze_count
    if (not 0 <= proposal_count <= revision
            or (row['state'] != 'ideas' and proposal_count == 0)):
        raise _stored_error('counters')

    # A decision receipt is a snapshot of one exact point in the card's
    # monotonic timeline. Its attention generation proves how many proposals
    # had happened by then (generation minus snoozes), while durable row order
    # proves the decision ordinal. Revisions and prior handoff receipts account
    # for every other legal version increment before that decision.
    snoozes_seen = 0
    previous_revision = None
    previous_proposals = 0
    previous_action = None
    for ordinal, decision in enumerate(decisions, start=1):
        request, response = decision_receipts[decision['id']]
        item = response['item']
        attention_revision, attention_generation = _attention_key_coordinates(
            item.get('attention_key')
        )
        snoozes_seen += int(decision['action'] == 'snooze')
        proposals_seen = attention_generation - snoozes_seen
        if (attention_revision != decision['revision']
                or not 1 <= proposals_seen <= proposal_count
                or attention_generation > row['attention_generation']
                or (previous_revision is not None
                    and decision['revision'] < previous_revision)):
            raise _stored_error('decision version history')
        if previous_revision is not None:
            revision_delta = decision['revision'] - previous_revision
            proposal_delta = proposals_seen - previous_proposals
            if (proposal_delta < 0 or proposal_delta > revision_delta
                    or (revision_delta == 0 and proposal_delta != 0)
                    or (revision_delta > 0 and previous_action == 'snooze'
                        and proposal_delta != 0)
                    or (revision_delta > 0 and previous_action != 'snooze'
                        and proposal_delta == 0)):
                raise _stored_error('decision version history')
        prior_handoff_transitions = sum(
            request_value['revision'] < decision['revision']
            for kind in ('preparation', 'preparation_status')
            for request_value, _response_value in receipts[kind]
        )
        exact_post_version = (
            decision['revision'] + proposals_seen + ordinal
            + prior_handoff_transitions
        )
        if (request['expected_version'] != exact_post_version - 1
                or item['version'] != exact_post_version
                or item['version'] > row['version']):
            raise _stored_error('decision version history')
        previous_revision = decision['revision']
        previous_proposals = proposals_seen
        previous_action = decision['action']

    # Reconstruct each approved handoff from the durable transition receipts.
    # preparation_ack can succeed only once before a revision clears its link;
    # status_unavailable may precede it, while all later status reads must retain
    # the exact acknowledged link. Version adjacency prevents fabricated
    # snapshots from being inserted at an otherwise plausible counter value.
    for receipt_revision in range(1, revision + 1):
        preparations = [
            value for value in receipts['preparation']
            if value[0]['revision'] == receipt_revision
        ]
        if len(preparations) > 1:
            raise _stored_error('preparation idempotency history')
        statuses = [
            value for value in receipts['preparation_status']
            if value[0]['revision'] == receipt_revision
        ]
        transitions = [
            ('preparation', request, response)
            for request, response in preparations
        ] + [
            ('preparation_status', request, response)
            for request, response in statuses
        ]
        if not transitions:
            continue

        revision_decisions = [
            value for value in decisions if value['revision'] == receipt_revision
        ]
        approved_decision = next((
            value for value in reversed(revision_decisions)
            if value['action'] == 'approve_preparation'
        ), None)
        approval_receipt = next((
            response for _request, response in receipts['decision']
            if response['decision']['id'] == (
                approved_decision['id'] if approved_decision is not None else None
            )
        ), None)
        if approved_decision is None or approval_receipt is None:
            raise _stored_error('preparation idempotency history')

        expected_version = approval_receipt['item']['version']
        acknowledged_link = None
        for kind, request, response in sorted(
            transitions, key=lambda value: value[2]['item']['version']
        ):
            item = response['item']
            expected_approval = {
                'revision': receipt_revision, 'scope': 'preparation_only',
                'decision_id': approved_decision['id'],
            }
            if (request['expected_version'] != expected_version
                    or item.get('approval') != expected_approval):
                raise _stored_error('preparation idempotency history')
            if kind == 'preparation':
                if acknowledged_link is not None:
                    raise _stored_error('preparation idempotency history')
                acknowledged_link = item['execution_link']
            else:
                evidence = request['tracker_evidence']
                item_link = item.get('execution_link')
                if acknowledged_link is None:
                    if (evidence['state'] != 'status_unavailable'
                            or evidence.get('execution_ref') is not None
                            or item_link is not None):
                        raise _stored_error('preparation idempotency history')
                elif (item_link != acknowledged_link
                        or evidence.get('execution_ref') != acknowledged_link['execution_ref']):
                    raise _stored_error('preparation idempotency history')
            expected_version = item['version']

        if receipt_revision == revision and preparations:
            durable_link = (
                _stored_json(row['execution_link'], 'execution link')
                if row['execution_link'] is not None else None
            )
            request, response = preparations[0]
            if (durable_link is None or response['item']['execution_link'] != durable_link
                    or request['handoff_key'] != durable_link['handoff_key']
                    or request['execution_ref'] != durable_link['execution_ref']):
                raise _stored_error('preparation idempotency history')

    expected_version = (
        revision + proposal_count + len(decisions)
        + len(receipts['preparation']) + len(receipts['preparation_status'])
        + int(row['state'] == 'done')
    )
    if row['version'] != expected_version:
        raise _stored_error('counters')
    changes = [
        value['revision'] for value in decisions if value['action'] == 'request_changes'
    ]
    if row['changes_revision'] != (max(changes) if changes else None):
        raise _stored_error('changes counter')

    current_status_receipts = [
        value for value in receipts['preparation_status']
        if value[0].get('revision') == revision
    ]
    events = []
    if schema.tracker_events:
        events = db.execute(
            'SELECT rowid,* FROM work_tracker_status_events '
            'WHERE card_id=? AND revision=? ORDER BY rowid', (card_id, revision)
        ).fetchall()
        for event in events:
            event_tracker = _stored_json(event['tracker_evidence'], 'tracker event')
            if (not isinstance(event_tracker, dict)
                    or event_tracker.get('revision') != revision
                    or event_tracker.get('handoff_key') != event['handoff_key']
                    or event_tracker.get('execution_ref') != event['execution_ref']):
                raise _stored_error('tracker event relation')
            timestamp(event['created_at'])
        if tracker is not None and (
                not events or events[-1]['tracker_evidence'] != row['tracker_evidence']):
            raise _stored_error('tracker event relation')
    return bool(current_status_receipts or events or tracker is not None)


def _validate_existing_card_row(db, row, profile, schema):
    card_id = text(row['id'], 'id', 100)
    profile = text(profile, 'profile', 100)
    text(row['source_key'], 'source_key', 500)
    payload = _stored_json(row['payload'], 'payload')
    try:
        payload_checked(payload)
    except WorkError as exc:
        raise _stored_error('payload') from exc
    if not isinstance(row['state'], str) or row['state'] not in STATES:
        raise WorkError('stored work state is invalid', 4404)

    revision = integer(row['revision'], 'stored revision')
    version = integer(row['version'], 'stored version')
    attention_generation = integer(
        row['attention_generation'], 'stored attention_generation'
    )
    if (revision is None or version is None or attention_generation is None
            or revision < 1 or version < 1 or attention_generation < 0):
        raise WorkError('stored work counters are invalid', 4404)
    changes_revision = integer(
        row['changes_revision'], 'stored changes_revision', optional=True
    )
    if changes_revision is not None and not 1 <= changes_revision <= revision:
        raise WorkError('stored changes_revision is invalid', 4404)

    timestamp(row['created_at'])
    timestamp(row['updated_at'])
    if row['snoozed_until'] is not None:
        timestamp(row['snoozed_until'])
        if row['state'] != 'needs_me':
            raise WorkError('stored work lifecycle is invalid', 4404)

    approval = None
    if row['approval'] is not None:
        approval = _stored_json(row['approval'], 'approval')
        if not isinstance(approval, dict) or set(approval) != {
            'revision', 'scope', 'decision_id'
        }:
            raise WorkError('stored work approval is invalid', 4404)
        approval_revision = integer(approval['revision'], 'stored approval revision')
        if (approval_revision != revision or approval['scope'] != 'preparation_only'):
            raise WorkError('stored work approval is invalid', 4404)
        text(approval['decision_id'], 'stored approval decision_id', 100)

    link = None
    if row['execution_link'] is not None:
        link = _stored_json(row['execution_link'], 'execution link')
        if not isinstance(link, dict) or set(link) != {
            'execution_ref', 'acknowledged_at', 'handoff_key'
        }:
            raise WorkError('stored execution link is invalid', 4404)
        text(link['execution_ref'], 'stored execution_ref', 2000)
        timestamp(link['acknowledged_at'])
        text(link['handoff_key'], 'stored handoff_key', 500)

    tracker = None
    tracker_handoff_key = None
    if row['tracker_evidence'] is not None:
        stored_tracker = _stored_json(row['tracker_evidence'], 'tracker evidence')
        if not isinstance(stored_tracker, dict):
            raise WorkError('stored tracker evidence is invalid', 4404)
        tracker = dict(stored_tracker)
        tracker_revision = integer(
            tracker.pop('revision', None), 'stored tracker revision'
        )
        if tracker_revision != revision:
            raise WorkError('stored tracker evidence is invalid', 4404)
        tracker_handoff_key = text(
            tracker.pop('handoff_key', None), 'stored tracker handoff_key', 500
        )
        tracker = tracker_evidence_checked(tracker)

    completion = None
    if row['completion_evidence'] is not None:
        completion = text(row['completion_evidence'], 'stored completion_evidence', 20000)

    structured_history = _validate_existing_card_history(
        db, row, profile, schema, approval, tracker
    )

    state = row['state']
    if state in {'ideas', 'needs_me', 'declined'}:
        if any(value is not None for value in (approval, link, tracker, completion)):
            raise WorkError('stored work lifecycle is invalid', 4404)
        return card_id

    if approval is None:
        raise WorkError('stored work lifecycle is invalid', 4404)
    handoff_key = f"{profile}:{card_id}:{approval['decision_id']}"
    if link is not None and link['handoff_key'] != handoff_key:
        raise WorkError('stored work lifecycle is invalid', 4404)

    if tracker is not None:
        execution_ref = tracker.get('execution_ref')
        if tracker_handoff_key != handoff_key:
            raise WorkError('stored work lifecycle is invalid', 4404)
        if tracker['state'] != 'status_unavailable' and link is None:
            raise WorkError('stored work lifecycle is invalid', 4404)
        if link is not None and execution_ref != link['execution_ref']:
            raise WorkError('stored work lifecycle is invalid', 4404)
        if link is None and execution_ref:
            raise WorkError('stored work lifecycle is invalid', 4404)

    if state == 'in_progress':
        if completion is not None:
            raise WorkError('stored work lifecycle is invalid', 4404)
        return card_id

    if link is None or completion is None:
        raise WorkError('stored work lifecycle is invalid', 4404)
    if tracker is not None and tracker['state'] != 'prepared':
        raise WorkError('stored work lifecycle is invalid', 4404)
    if structured_history:
        if tracker is None or tracker['state'] != 'prepared':
            raise WorkError('stored work lifecycle is invalid', 4404)
        if completion != canonical(tracker['result_evidence']):
            raise WorkError('stored work lifecycle is invalid', 4404)
    return card_id

def existing_card_ids(path: Path, profile: str, card_ids) -> set[str] | None:
    """Return matching IDs from an existing store without creating or migrating it."""
    profile = text(profile, 'profile', 100)
    requested = tuple(dict.fromkeys(text(value, 'id', 100) for value in card_ids))
    if not requested:
        return set()
    absolute = Path(os.path.abspath(os.fspath(anchored_store_path(Path(path)))))
    flags = os.O_RDONLY | getattr(os, 'O_CLOEXEC', 0) | getattr(os, 'O_NOFOLLOW', 0)
    try:
        fd = os.open(absolute, flags)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise WorkError('work store is not a safe regular file', 4404) from exc

    db = None
    try:
        opened = os.fstat(fd)
        current = os.lstat(absolute)
        if (not stat.S_ISREG(opened.st_mode) or stat.S_ISLNK(current.st_mode)
                or (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino)
                or absolute.resolve(strict=True) != absolute):
            raise WorkError('work store is not a safe canonical regular file', 4404)
        db = sqlite3.connect(
            f"{absolute.as_uri()}?mode=ro&nofollow=1", uri=True, timeout=15
        )
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA query_only=ON')
        db.execute('PRAGMA busy_timeout=15000')
        db.execute('BEGIN')
        schema = _validate_existing_store_schema(db)
        owner = db.execute(
            "SELECT value FROM inbox_meta WHERE key='profile'"
        ).fetchone()
        if owner is None or owner['value'] != profile:
            raise WorkError('store belongs to a different profile', 4404)
        placeholders = ','.join('?' for _ in requested)
        tracker_projection = (
            'tracker_evidence' if schema.tracker_column else 'NULL AS tracker_evidence'
        )
        rows = db.execute(
            f'''SELECT id,source_key,payload,state,revision,version,created_at,updated_at,
                       snoozed_until,approval,attention_generation,changes_revision,
                       execution_link,completion_evidence,{tracker_projection}
                FROM work_cards WHERE id IN ({placeholders})''', requested
        )
        matches = set()
        for row in rows:
            try:
                matches.add(_validate_existing_card_row(db, row, profile, schema))
            except WorkError as exc:
                if exc.code == 4404:
                    raise
                raise _stored_error('row') from exc
            except (TypeError, ValueError) as exc:
                raise _stored_error('row') from exc
        current = os.lstat(absolute)
        if (stat.S_ISLNK(current.st_mode)
                or (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino)):
            raise WorkError('work store changed during read', 4404)
        return matches
    except sqlite3.Error as exc:
        raise WorkError('work store could not be read safely', 4404) from exc
    finally:
        if db is not None:
            db.close()
        os.close(fd)
