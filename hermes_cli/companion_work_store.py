"""Durable, profile-local business decisions. Never an execution/permission engine.

Only the dashboard transport may supply a human identity to ``decide``. The
agent-facing CLI exposes no such operation. OS-level access to this database is
trusted, like the other profile stores; isolate agent containers accordingly.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

STATES = frozenset({'ideas', 'in_progress', 'needs_me', 'done', 'declined'})
ACTIONS = frozenset({'approve_preparation', 'request_changes', 'snooze', 'decline'})


class WorkError(ValueError):
    def __init__(self, message, code=4409):
        super().__init__(message)
        self.code = code


def text(value, name, maximum=20000):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise WorkError(f'{name} must be nonempty text (max {maximum})', -32602)
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


class WorkStore:
    def __init__(self, path: Path, profile: str, *, clock=None, timezone_name="UTC"):
        self.path = Path(path)
        self.profile = text(profile, 'profile', 100)
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        try:
            self.timezone = ZoneInfo(timezone_name)
        except (ZoneInfoNotFoundError, TypeError, ValueError):
            raise WorkError("invalid reminder timezone", -32602) from None
        self.path.parent.mkdir(parents=True, exist_ok=True)
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
            db.execute('''CREATE TABLE IF NOT EXISTS work_idempotency (
                kind TEXT NOT NULL, key TEXT NOT NULL, request TEXT NOT NULL,
                response TEXT NOT NULL, PRIMARY KEY(kind, key))''')
            db.execute('''CREATE TABLE IF NOT EXISTS work_digest_receipts (
                consumer TEXT NOT NULL, card_id TEXT NOT NULL, attention_key TEXT NOT NULL,
                PRIMARY KEY(consumer, card_id, attention_key))''')
        self.path.chmod(0o600)

    @contextmanager
    def _tx(self):
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
        status = ('completed' if row['state'] == 'done' and link else
                  'linked' if link else 'dispatch_pending' if authorized else 'not_authorized')
        return dict(json.loads(row['payload']), id=row['id'], profile=self.profile,
                    source_key=row['source_key'], state=row['state'], revision=row['revision'],
                    version=row['version'], created_at=row['created_at'], updated_at=row['updated_at'],
                    snoozed_until=row['snoozed_until'],
                    attention_due=(row['state'] == 'needs_me' and
                                   (not row['snoozed_until'] or row['snoozed_until'] <= self._now())),
                    preparation_status=status,
                    handoff_key=f"{self.profile}:{row['id']}:{approval['decision_id']}" if authorized else None,
                    execution_link=link, completion_evidence=row['completion_evidence'],
                    attention_key=f"{self.clock().astimezone(self.timezone).date()}:{row['revision']}:{row['attention_generation']}",
                    approval=json.loads(row['approval']) if row['approval'] else None)

    @staticmethod
    def _version(row, expected):
        if type(expected) is not int:
            raise WorkError('expected_version must be an integer', -32602)
        if row['version'] != expected:
            raise WorkError('stale work version; refresh before deciding')

    def get(self, card_id):
        with self._tx() as db:
            card = self._card(self._row(db, card_id))
            return {'item': card,
                    'comments': [dict(r) for r in db.execute('SELECT * FROM work_comments WHERE card_id=? ORDER BY created_at, rowid', (card_id,))],
                    'decisions': [dict(r) for r in db.execute('SELECT * FROM work_decisions WHERE card_id=? ORDER BY created_at, rowid', (card_id,))]}

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
                db.execute("UPDATE work_cards SET payload=?, revision=?, version=version+1, state=?, approval=NULL, execution_link=NULL, updated_at=? WHERE id=?",
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
        if not human_identity:
            raise WorkError('authenticated dashboard human login required', 4403)
        if not isinstance(action, str) or action not in ACTIONS or type(revision) is not int:
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
            if (type(revision) is not int or card['revision'] != revision or
                    card['state'] != 'in_progress' or not card['approval'] or
                    card['handoff_key'] != handoff_key):
                raise WorkError('preparation authorization changed; do not dispatch')
            if card['execution_link']:
                raise WorkError('preparation already linked')
            link = dict(execution_ref=execution_ref, acknowledged_at=self._now(), handoff_key=handoff_key)
            db.execute('UPDATE work_cards SET execution_link=?,version=version+1,updated_at=? WHERE id=?',
                       (canonical(link), self._now(), card_id))
            result = {'item': self._card(self._row(db, card_id))}
            self._remember(db, 'preparation', idempotency_key, request, result)
            return result

    def complete(self, card_id, expected_version, completion_evidence=None):
        with self._tx() as db:
            row = self._row(db, card_id)
            self._version(row, expected_version)
            card = self._card(row)
            if card['state'] != 'in_progress' or not card['approval'] or card['approval']['revision'] != card['revision']:
                raise WorkError('only approved preparation can be completed')
            if not card['execution_link']:
                raise WorkError('preparation must be linked to verified tracker evidence before completion')
            evidence = text(completion_evidence, 'completion_evidence', 20000)
            db.execute("UPDATE work_cards SET state='done',version=version+1,updated_at=?,completion_evidence=? WHERE id=?", (self._now(), evidence, card_id))
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
        with self._tx() as db:
            acknowledged = 0
            for item in items:
                if not isinstance(item, dict) or set(item) != {'id', 'attention_key'}:
                    raise WorkError('invalid receipt item', -32602)
                card = self._card(self._row(db, item['id']))
                if not card['attention_due'] or card['attention_key'] != item['attention_key']:
                    raise WorkError('stale digest attention key')
                acknowledged += db.execute('INSERT OR IGNORE INTO work_digest_receipts VALUES (?,?,?)',
                                           (consumer, card['id'], card['attention_key'].split(':', 1)[0])).rowcount
            return {'acknowledged': acknowledged}
