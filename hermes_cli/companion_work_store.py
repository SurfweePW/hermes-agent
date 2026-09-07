"""Durable, profile-local business decisions. Never an execution/permission engine.

Only the dashboard transport may supply a human identity to ``decide``. The
agent-facing CLI exposes no such operation. OS-level access to this database is
trusted, like the other profile stores; isolate agent containers accordingly.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from hermes_constants import mkdir_under_hermes_home

STATES = frozenset({'ideas', 'in_progress', 'needs_me', 'done', 'declined'})
ACTIONS = frozenset({'approve_preparation', 'request_changes', 'snooze', 'decline'})
TRACKER_STATES = frozenset({
    'linked_awaiting_triage', 'preparing', 'prepared', 'blocked', 'status_unavailable',
})
PREPARATION_STATUSES = frozenset({
    'not_authorized', 'approved_task_linking_pending', *TRACKER_STATES,
})


class WorkError(ValueError):
    def __init__(self, message, code=4409):
        super().__init__(message)
        self.code = code


def text(value, name, maximum=20000):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise WorkError(f'{name} must be nonempty text (max {maximum})', -32602)
    return value


def integer(value, name, *, optional=False):
    if optional and value is None:
        return None
    if type(value) is not int:
        raise WorkError(f'{name} must be an integer', -32602)
    return value


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.astimezone(timezone.utc).isoformat()
    except (AttributeError, TypeError, ValueError):
        raise WorkError('timestamp must be ISO-8601 with timezone', -32602) from None


def anchored_store_path(path: Path) -> Path:
    """Fail closed when *path* (or its parent) escapes the named profile via symlinks.

    The OS-level trust assumption covers legitimate profile-local state, not a
    profile directory that has been redirected out of the Hermes home: a
    symlinked store file or a symlinked profile directory would silently write
    business decisions to an attacker-chosen location.
    """
    from hermes_constants import get_default_hermes_root

    resolved = Path(path).resolve(strict=False)
    # A multiplex gateway may run with HERMES_HOME pinned to one named profile
    # while serving sibling profiles. Anchor all profile-local stores to the
    # canonical Hermes root, then retain the no-symlink checks below. Anchoring
    # to the process profile itself incorrectly rejects every legitimate sibling.
    home = Path(get_default_hermes_root())
    try:
        resolved.relative_to(home.resolve(strict=False))
    except ValueError as exc:
        raise WorkError('work store path escapes the Hermes home', 4404) from exc
    if Path(path).is_symlink() or Path(path).parent.is_symlink():
        raise WorkError('work store path must not be a symlink', 4404)
    return resolved


def payload_checked(value):
    fields = {'title', 'brief', 'evidence', 'next_action', 'owner', 'execution_ref'}
    if not isinstance(value, dict) or set(value) - fields:
        raise WorkError('invalid work payload fields', -32602)
    result = {k: text(value.get(k), k, 500 if k in {'title', 'owner'} else 20000)
              for k in ('title', 'brief', 'next_action', 'owner')}
    evidence = value.get('evidence')
    if not isinstance(evidence, list) or len(evidence) > 100:
        raise WorkError('evidence must be an array (max 100)', -32602)
    result['evidence'] = [text(v, 'evidence', 4000) for v in evidence]
    if 'execution_ref' in value:
        result['execution_ref'] = text(value['execution_ref'], 'execution_ref', 2000)
    return result


def tracker_evidence_checked(value):
    fields = {'state', 'execution_ref', 'observed_at', 'evidence', 'result_evidence', 'blocker'}
    if not isinstance(value, dict) or set(value) - fields:
        raise WorkError('tracker_evidence must be a structured object', -32602)
    state = value.get('state')
    if not isinstance(state, str) or state not in TRACKER_STATES:
        raise WorkError('invalid tracker_evidence state', -32602)
    result: dict[str, object] = {
        'state': state, 'observed_at': timestamp(value.get('observed_at')),
    }
    evidence = value.get('evidence')
    if not isinstance(evidence, list) or not evidence or len(evidence) > 100:
        raise WorkError('tracker_evidence evidence must be a nonempty array (max 100)', -32602)
    result['evidence'] = [text(entry, 'tracker evidence', 4000) for entry in evidence]
    if 'execution_ref' in value:
        result['execution_ref'] = text(value['execution_ref'], 'execution_ref', 2000)
    if state != 'status_unavailable' and 'execution_ref' not in result:
        raise WorkError('execution_ref is required for tracker status', -32602)
    if state == 'blocked':
        result['blocker'] = text(value.get('blocker'), 'blocker', 20000)
    elif 'blocker' in value:
        raise WorkError('blocker is only valid for blocked tracker status', -32602)
    if state == 'prepared':
        result_evidence = value.get('result_evidence')
        if not isinstance(result_evidence, list) or not result_evidence or len(result_evidence) > 100:
            raise WorkError('result_evidence must be a nonempty array (max 100)', -32602)
        result['result_evidence'] = [text(entry, 'result_evidence', 4000) for entry in result_evidence]
    elif 'result_evidence' in value:
        raise WorkError('result_evidence is only valid for prepared tracker status', -32602)
    return result


class WorkStore:
    def __init__(self, path: Path, profile: str, *, clock=None, timezone_name="UTC"):
        self.path = Path(path)
        self.profile = text(profile, 'profile', 100)
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        try:
            self.timezone = ZoneInfo(timezone_name)
        except (ZoneInfoNotFoundError, TypeError, ValueError):
            raise WorkError("invalid reminder timezone", -32602) from None
        self._ensure_profile_available()
        with self._tx() as db:
            db.execute('CREATE TABLE IF NOT EXISTS inbox_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
            db.execute("INSERT OR IGNORE INTO inbox_meta VALUES ('profile', ?)", (profile,))
            if db.execute("SELECT value FROM inbox_meta WHERE key='profile'").fetchone()[0] != profile:
                raise WorkError('store belongs to a different profile', 4404)
            db.execute('''CREATE TABLE IF NOT EXISTS work_cards (
                id TEXT PRIMARY KEY, source_key TEXT UNIQUE NOT NULL, payload TEXT NOT NULL,
                state TEXT NOT NULL, revision INTEGER NOT NULL, version INTEGER NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, snoozed_until TEXT,
                approval TEXT, attention_generation INTEGER NOT NULL DEFAULT 0,
                changes_revision INTEGER)''')
            if 'execution_link' not in {r[1] for r in db.execute('PRAGMA table_info(work_cards)')}:
                db.execute('ALTER TABLE work_cards ADD COLUMN execution_link TEXT')
            if 'completion_evidence' not in {r[1] for r in db.execute('PRAGMA table_info(work_cards)')}:
                db.execute('ALTER TABLE work_cards ADD COLUMN completion_evidence TEXT')
            if 'tracker_evidence' not in {r[1] for r in db.execute('PRAGMA table_info(work_cards)')}:
                db.execute('ALTER TABLE work_cards ADD COLUMN tracker_evidence TEXT')
            db.execute('''CREATE TABLE IF NOT EXISTS work_revisions (
                card_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
                created_at TEXT NOT NULL, PRIMARY KEY(card_id, revision))''')
            db.execute('''CREATE TABLE IF NOT EXISTS work_comments (
                id TEXT PRIMARY KEY, card_id TEXT NOT NULL, revision INTEGER NOT NULL,
                actor TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL)''')
            db.execute('''CREATE TABLE IF NOT EXISTS work_decisions (
                id TEXT PRIMARY KEY, card_id TEXT NOT NULL, revision INTEGER NOT NULL,
                action TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL,
                snoozed_until TEXT, created_at TEXT NOT NULL, scope TEXT NOT NULL)''')
            db.execute('''CREATE TABLE IF NOT EXISTS work_tracker_status_events (
                id TEXT PRIMARY KEY, card_id TEXT NOT NULL, revision INTEGER NOT NULL,
                handoff_key TEXT NOT NULL, execution_ref TEXT, tracker_evidence TEXT NOT NULL,
                created_at TEXT NOT NULL)''')
            # The first release stored only the latest tracker read-back on the
            # card. Preserve that evidence when opening such a database rather
            # than silently beginning its audit trail at the next update.
            for row in db.execute('''SELECT id,tracker_evidence FROM work_cards
                                     WHERE tracker_evidence IS NOT NULL'''):
                if db.execute('SELECT 1 FROM work_tracker_status_events WHERE card_id=? LIMIT 1',
                              (row['id'],)).fetchone():
                    continue
                try:
                    evidence = json.loads(row['tracker_evidence'])
                    revision = evidence['revision']
                    handoff_key = evidence['handoff_key']
                except (KeyError, TypeError, ValueError):
                    continue
                db.execute('''INSERT INTO work_tracker_status_events
                              VALUES (?,?,?,?,?,?,?)''',
                           (str(uuid4()), row['id'], revision, handoff_key,
                            evidence.get('execution_ref'), row['tracker_evidence'], self._now()))
            db.execute('''CREATE TABLE IF NOT EXISTS work_idempotency (
                kind TEXT NOT NULL, key TEXT NOT NULL, request TEXT NOT NULL,
                response TEXT NOT NULL, PRIMARY KEY(kind, key))''')
            db.execute('''CREATE TABLE IF NOT EXISTS work_digest_receipts (
                consumer TEXT NOT NULL, card_id TEXT NOT NULL, attention_key TEXT NOT NULL,
                PRIMARY KEY(consumer, card_id, attention_key))''')
        self.path.chmod(0o600)

    def _ensure_profile_available(self):
        try:
            mkdir_under_hermes_home(self.path.parent)
        except FileNotFoundError as exc:
            raise WorkError('profile unavailable', 4404) from exc

    @contextmanager
    def _tx(self):
        # Re-check for every operation so an already-open WorkStore cannot
        # continue writing after its named profile has been tombstoned.
        self._ensure_profile_available()
        db = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute('PRAGMA busy_timeout=15000')
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def _now(self):
        return self.clock().astimezone(timezone.utc).isoformat()

    def _row(self, db, card_id):
        row = db.execute('SELECT * FROM work_cards WHERE id=?', (text(card_id, 'id', 100),)).fetchone()
        if row is None:
            raise WorkError('work card not found', 4404)
        return row

    def _card(self, row):
        approval = json.loads(row['approval']) if row['approval'] else None
        authorized = approval and approval['revision'] == row['revision'] and approval['scope'] == 'preparation_only'
        link = json.loads(row['execution_link']) if row['execution_link'] and authorized else None
        tracker_evidence = json.loads(row['tracker_evidence']) if row['tracker_evidence'] and authorized else None
        handoff_key = (f"{self.profile}:{row['id']}:{approval['decision_id']}"
                       if authorized and approval else None)
        if tracker_evidence and (tracker_evidence.get('revision') != row['revision'] or
                                 tracker_evidence.get('handoff_key') != handoff_key):
            tracker_evidence = None
        status = ('not_authorized' if not authorized else
                  tracker_evidence['state'] if tracker_evidence else
                  'prepared' if row['state'] == 'done' and link and row['completion_evidence'] else
                  'linked_awaiting_triage' if link else 'approved_task_linking_pending')
        completion_evidence = row['completion_evidence']
        if completion_evidence:
            try:
                completion_evidence = json.loads(completion_evidence)
            except (TypeError, ValueError):
                pass
        return dict(json.loads(row['payload']), id=row['id'], profile=self.profile,
                    source_key=row['source_key'], state=row['state'], revision=row['revision'],
                    version=row['version'], created_at=row['created_at'], updated_at=row['updated_at'],
                    snoozed_until=row['snoozed_until'],
                    attention_due=(row['state'] == 'needs_me' and
                                   (not row['snoozed_until'] or row['snoozed_until'] <= self._now())),
                    preparation_status=status,
                    handoff_key=handoff_key, execution_link=link,
                    tracker_evidence=tracker_evidence,
                    handoff_reconciliation_required=(status == 'status_unavailable' and not link),
                    completion_evidence=completion_evidence,
                    publication_status='not_authorized',
                    attention_key=f"{self.clock().astimezone(self.timezone).date()}:{row['revision']}:{row['attention_generation']}",
                    approval=json.loads(row['approval']) if row['approval'] else None)

    @staticmethod
    def _version(row, expected):
        integer(expected, 'expected_version')
        if row['version'] != expected:
            raise WorkError('stale work version; refresh before deciding')

    def get(self, card_id):
        with self._tx() as db:
            card = self._card(self._row(db, card_id))
            return {'item': card,
                    'comments': [dict(r) for r in db.execute('SELECT * FROM work_comments WHERE card_id=? ORDER BY created_at, rowid', (card_id,))],
                    'decisions': [dict(r) for r in db.execute('SELECT * FROM work_decisions WHERE card_id=? ORDER BY created_at, rowid', (card_id,))],
                    'tracker_status_history': [json.loads(r['tracker_evidence']) for r in db.execute(
                        '''SELECT tracker_evidence FROM work_tracker_status_events
                           WHERE card_id=? ORDER BY rowid''', (card_id,))]}

    def list(self, states=None, include_snoozed=True, preparation=False):
        if states is not None and (not isinstance(states, list) or any(not isinstance(s, str) or s not in STATES for s in states)):
            raise WorkError('invalid states', -32602)
        if type(include_snoozed) is not bool:
            raise WorkError('include_snoozed must be boolean', -32602)
        with self._tx() as db:
            items = [self._card(r) for r in db.execute('SELECT * FROM work_cards ORDER BY updated_at DESC, id')]
        return {'items': [c for c in items if (states is None or c['state'] in states)
                          and (include_snoozed or not c['snoozed_until'] or c['snoozed_until'] <= self._now())
                          and (not preparation or (c['state'] == 'in_progress' and c['approval']
                               and c['approval']['revision'] == c['revision']
                               and c['approval']['scope'] == 'preparation_only'))]}

    def upsert(self, source_key, payload, expected_version=None):
        expected_version = integer(expected_version, 'expected_version', optional=True)
        source_key = text(source_key, 'source_key', 500)
        encoded = canonical(payload_checked(payload))
        now = self._now()
        with self._tx() as db:
            row = db.execute('SELECT * FROM work_cards WHERE source_key=?', (source_key,)).fetchone()
            if row:
                # Even a stale submitter may safely dedupe the identical payload.
                if row['payload'] == encoded:
                    return {'item': self._card(row)}
                self._version(row, expected_version)
                if row['state'] in {'done', 'declined'}:
                    raise WorkError('closed cards cannot be revised or reopened')
                card_id, revision = row['id'], row['revision'] + 1
                # Human snooze is independent of changing evidence. Keep the
                # pending decision so it resurfaces without an agent reproposal.
                state = 'needs_me' if row['state'] == 'needs_me' and row['snoozed_until'] else 'ideas'
                db.execute("""UPDATE work_cards SET payload=?, revision=?, version=version+1, state=?,
                              approval=NULL, execution_link=NULL, tracker_evidence=NULL,
                              completion_evidence=NULL, updated_at=? WHERE id=?""",
                           (encoded, revision, state, now, card_id))
            else:
                if expected_version is not None:
                    raise WorkError('cannot update missing source key', 4404)
                card_id, revision = str(uuid4()), 1
                db.execute("INSERT INTO work_cards (id,source_key,payload,state,revision,version,created_at,updated_at) VALUES (?,?,?,'ideas',1,1,?,?)",
                           (card_id, source_key, encoded, now, now))
            db.execute('INSERT INTO work_revisions VALUES (?,?,?,?)', (card_id, revision, encoded, now))
            return {'item': self._card(self._row(db, card_id))}

    def propose(self, card_id, expected_version):
        card_id = text(card_id, 'id', 100)
        expected_version = integer(expected_version, 'expected_version')
        with self._tx() as db:
            row = self._row(db, card_id)
            self._version(row, expected_version)
            if row['state'] == 'needs_me':
                return {'item': self._card(row)}
            if row['state'] != 'ideas' or row['changes_revision'] == row['revision']:
                raise WorkError('only new or revised ideas can be proposed')
            db.execute("UPDATE work_cards SET state='needs_me',version=version+1,attention_generation=attention_generation+1,updated_at=? WHERE id=?", (self._now(), card_id))
            return {'item': self._card(self._row(db, card_id))}

    @staticmethod
    def _replay(db, kind, key, request):
        text(key, 'idempotency_key', 200)
        row = db.execute('SELECT * FROM work_idempotency WHERE kind=? AND key=?', (kind, key)).fetchone()
        if row:
            if row['request'] != canonical(request):
                raise WorkError('idempotency key reused with different request')
            return json.loads(row['response'])

    @staticmethod
    def _remember(db, kind, key, request, response):
        db.execute('INSERT INTO work_idempotency VALUES (?,?,?,?)', (kind, key, canonical(request), canonical(response)))

    def comment(self, card_id, body, idempotency_key, *, human_identity=None):
        card_id = text(card_id, 'id', 100)
        actor = 'human' if human_identity else 'agent'
        request = {'id': card_id, 'text': text(body, 'text'), 'actor': actor}
        with self._tx() as db:
            replay = self._replay(db, 'comment', idempotency_key, request)
            if replay is not None:
                return replay
            row = self._row(db, card_id)
            comment = dict(id=str(uuid4()), card_id=card_id, revision=row['revision'], actor=actor,
                           text=body, created_at=self._now())
            db.execute('INSERT INTO work_comments VALUES (:id,:card_id,:revision,:actor,:text,:created_at)', comment)
            result = {'comment': comment}
            self._remember(db, 'comment', idempotency_key, request, result)
            return result

    def decide(self, card_id, expected_version, revision, action, idempotency_key,
               reason='', snoozed_until=None, *, human_identity=None):
        card_id = text(card_id, 'id', 100)
        expected_version = integer(expected_version, 'expected_version')
        revision = integer(revision, 'revision')
        if not human_identity:
            raise WorkError('authenticated dashboard human login required', 4403)
        if not isinstance(action, str) or action not in ACTIONS:
            raise WorkError('invalid decision action or revision', -32602)
        if not isinstance(reason, str) or len(reason) > 20000:
            raise WorkError('invalid reason', -32602)
        if action == 'snooze':
            snoozed_until = timestamp(snoozed_until)
        elif snoozed_until is not None:
            raise WorkError('snoozed_until is only valid for snooze', -32602)
        request = dict(id=card_id, expected_version=expected_version, revision=revision,
                       action=action, reason=reason, snoozed_until=snoozed_until, actor=human_identity)
        with self._tx() as db:
            replay = self._replay(db, 'decision', idempotency_key, request)
            if replay is not None:
                return replay
            row = self._row(db, card_id)
            self._version(row, expected_version)
            if row['revision'] != revision:
                raise WorkError('stale payload revision')
            if row['state'] != 'needs_me' or (row['snoozed_until'] and row['snoozed_until'] > self._now()):
                raise WorkError('card is not awaiting a decision now')
            if action == 'snooze' and snoozed_until <= self._now():
                raise WorkError('snooze date must be in the future', -32602)
            state = {'approve_preparation': 'in_progress', 'request_changes': 'ideas',
                     'snooze': 'needs_me', 'decline': 'declined'}[action]
            decision = dict(id=str(uuid4()), card_id=card_id, revision=revision, action=action,
                            actor=human_identity, reason=reason, snoozed_until=snoozed_until,
                            created_at=self._now(), scope='preparation_only' if action == 'approve_preparation' else 'none')
            approval = canonical(dict(revision=revision, scope='preparation_only', decision_id=decision['id'])) if action == 'approve_preparation' else None
            db.execute('INSERT INTO work_decisions VALUES (:id,:card_id,:revision,:action,:actor,:reason,:snoozed_until,:created_at,:scope)', decision)
            db.execute('''UPDATE work_cards SET state=?,version=version+1,approval=?,snoozed_until=?,updated_at=?,
                          attention_generation=attention_generation+?,changes_revision=? WHERE id=?''',
                       (state, approval, snoozed_until, self._now(), int(action == 'snooze'),
                        revision if action == 'request_changes' else row['changes_revision'], card_id))
            result = {'item': self._card(self._row(db, card_id)), 'decision': decision}
            self._remember(db, 'decision', idempotency_key, request, result)
            return result

    def preparation_ack(self, card_id, expected_version, revision, handoff_key,
                        execution_ref, idempotency_key):
        """Trusted adapter read-back receipt, not a tracker API or human approval.

        The adapter must find/create by handoff_key and read the real task back
        before calling. A payload's optional reference alone is not evidence.
        """
        card_id = text(card_id, 'id', 100)
        expected_version = integer(expected_version, 'expected_version')
        revision = integer(revision, 'revision')
        request = dict(id=card_id, expected_version=expected_version, revision=revision,
                       handoff_key=text(handoff_key, 'handoff_key', 500),
                       execution_ref=text(execution_ref, 'execution_ref', 2000))
        with self._tx() as db:
            replay = self._replay(db, 'preparation', idempotency_key, request)
            if replay is not None:
                return replay
            row = self._row(db, card_id)
            self._version(row, expected_version)
            card = self._card(row)
            if (card['revision'] != revision or card['state'] != 'in_progress' or
                    not card['approval'] or
                    card['handoff_key'] != handoff_key):
                raise WorkError('preparation authorization changed; do not dispatch')
            if card['execution_link']:
                raise WorkError('preparation already linked')
            link = dict(execution_ref=execution_ref, acknowledged_at=self._now(), handoff_key=handoff_key)
            db.execute('''UPDATE work_cards SET execution_link=?,tracker_evidence=NULL,
                          version=version+1,updated_at=? WHERE id=?''',
                       (canonical(link), self._now(), card_id))
            result = {'item': self._card(self._row(db, card_id))}
            self._remember(db, 'preparation', idempotency_key, request, result)
            return result

    def preparation_status_update(self, card_id, expected_version, revision, handoff_key,
                                  tracker_evidence, idempotency_key):
        """Record a trusted tracker read-back for the current approved handoff.

        ``status_unavailable`` without an execution reference represents an
        uncertain create/link result. Adapters must reconcile by handoff key;
        it is deliberately not projected as a new dispatch opportunity.
        """
        card_id = text(card_id, 'id', 100)
        expected_version = integer(expected_version, 'expected_version')
        revision = integer(revision, 'revision')
        handoff_key = text(handoff_key, 'handoff_key', 500)
        checked = tracker_evidence_checked(tracker_evidence)
        request = dict(id=card_id, expected_version=expected_version, revision=revision,
                       handoff_key=handoff_key,
                       tracker_evidence=checked)
        with self._tx() as db:
            replay = self._replay(db, 'preparation_status', idempotency_key, request)
            if replay is not None:
                return replay
            row = self._row(db, card_id)
            self._version(row, expected_version)
            card = self._card(row)
            if (card['revision'] != revision or card['state'] != 'in_progress' or
                    not card['approval'] or card['handoff_key'] != handoff_key):
                raise WorkError('preparation authorization changed; ignore stale tracker status')
            previous = card['tracker_evidence']
            if previous and checked['observed_at'] < previous['observed_at']:
                raise WorkError('older tracker evidence cannot replace a newer read-back')
            link = card['execution_link']
            execution_ref = checked.get('execution_ref')
            if checked['state'] != 'status_unavailable' and not link:
                raise WorkError('preparation must be linked before tracker status can advance')
            if link and execution_ref != link['execution_ref']:
                raise WorkError('tracker execution_ref does not match the verified handoff')
            if not link and execution_ref:
                raise WorkError('execution_ref must be acknowledged before tracker status can advance')

            stored = dict(checked, revision=revision, handoff_key=handoff_key)
            db.execute('''INSERT INTO work_tracker_status_events
                          VALUES (?,?,?,?,?,?,?)''',
                       (str(uuid4()), card_id, revision, handoff_key, execution_ref,
                        canonical(stored), self._now()))
            db.execute('''UPDATE work_cards SET tracker_evidence=?,version=version+1,
                          updated_at=? WHERE id=?''',
                       (canonical(stored), self._now(), card_id))
            result = {'item': self._card(self._row(db, card_id))}
            self._remember(db, 'preparation_status', idempotency_key, request, result)
            return result

    def complete(self, card_id, expected_version, completion_evidence=None):
        card_id = text(card_id, 'id', 100)
        expected_version = integer(expected_version, 'expected_version')
        with self._tx() as db:
            row = self._row(db, card_id)
            self._version(row, expected_version)
            card = self._card(row)
            if card['state'] != 'in_progress' or not card['approval'] or card['approval']['revision'] != card['revision']:
                raise WorkError('only approved preparation can be completed')
            if not card['execution_link']:
                raise WorkError('preparation must be linked to verified tracker evidence before completion')
            text(completion_evidence, 'completion_evidence', 20000)
            tracker = card['tracker_evidence']
            link = card['execution_link']
            if (not tracker or tracker.get('state') != 'prepared' or
                    tracker.get('revision') != card['revision'] or
                    tracker.get('handoff_key') != card['handoff_key'] or
                    tracker.get('execution_ref') != link['execution_ref'] or
                    not tracker.get('result_evidence')):
                raise WorkError('completion requires current structured tracker and verified result evidence')
            db.execute("""UPDATE work_cards SET state='done',version=version+1,updated_at=?,
                          completion_evidence=? WHERE id=?""",
                       (self._now(), canonical(tracker['result_evidence']), card_id))
            return {'item': self._card(self._row(db, card_id))}

    def digest(self, consumer):
        text(consumer, 'consumer', 200)
        with self._tx() as db:
            cards = [self._card(r) for r in db.execute("SELECT * FROM work_cards WHERE state='needs_me' ORDER BY updated_at, id")]
            items = [c for c in cards if c['attention_due'] and not db.execute(
                'SELECT 1 FROM work_digest_receipts WHERE consumer=? AND card_id=? AND attention_key=?',
                (consumer, c['id'], c['attention_key'].split(':', 1)[0])).fetchone()]
            return {'items': items}

    def digest_ack(self, consumer, items):
        text(consumer, 'consumer', 200)
        if not isinstance(items, list) or len(items) > 1000:
            raise WorkError('items must be an array (max 1000)', -32602)
        checked_items = []
        for item in items:
            if not isinstance(item, dict) or set(item) != {'id', 'attention_key'}:
                raise WorkError('invalid receipt item', -32602)
            checked_items.append({
                'id': text(item['id'], 'id', 100),
                'attention_key': text(item['attention_key'], 'attention_key', 200),
            })
        with self._tx() as db:
            acknowledged = 0
            for item in checked_items:
                card = self._card(self._row(db, item['id']))
                if not card['attention_due'] or card['attention_key'] != item['attention_key']:
                    raise WorkError('stale digest attention key')
                acknowledged += db.execute('INSERT OR IGNORE INTO work_digest_receipts VALUES (?,?,?)',
                                           (consumer, card['id'], card['attention_key'].split(':', 1)[0])).rowcount
            return {'acknowledged': acknowledged}
