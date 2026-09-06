from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
import os
import socket
import subprocess
import sys
import threading

import pytest

from hermes_cli.companion_work_store import WorkError, WorkStore

PAYLOAD = dict(title='Test preparation brief', brief='Synthetic test data, never production.',
               evidence=['fixture:source'], next_action='Prepare an internal draft only',
               owner='hoffeecmo', execution_ref='kanban:hoffee:test-task')


def proposed(store, source='test-source'):
    c = store.upsert(source, PAYLOAD)['item']
    return store.propose(c['id'], c['version'])['item']


def decide(store, card, action='approve_preparation', key='decision-1', **kw):
    return store.decide(card['id'], card['version'], card['revision'], action, key,
                        human_identity='test-login:pawel', **kw)


def test_real_reopen_two_clients_and_exact_preparation_scope(tmp_path):
    path = tmp_path / 'companion-work.db'
    cmo = WorkStore(path, 'hoffeecmo')
    card = proposed(cmo)
    browser = WorkStore(path, 'hoffeecmo')
    assert browser.get(card['id'])['item'] == card
    result = decide(browser, card)
    reopened = WorkStore(path, 'hoffeecmo')
    assert reopened.list(preparation=True)['items'] == [result['item']]
    assert result['item']['approval'] == dict(revision=1, scope='preparation_only', decision_id=result['decision']['id'])
    assert reopened.get(card['id'])['decisions'] == [result['decision']]
    assert not list(tmp_path.glob('*ledger*'))
    assert path.stat().st_mode & 0o777 == 0o600


def test_source_dedupe_revision_invalidates_approval_and_stale_write(tmp_path):
    store = WorkStore(tmp_path / 'inbox.db', 'hoffeecmo')
    card = proposed(store)
    approved = decide(store, card)['item']
    assert store.upsert('test-source', PAYLOAD)['item'] == approved
    with pytest.raises(WorkError, match='stale'):
        store.upsert('test-source', dict(PAYLOAD, brief='Revised'), card['version'])
    revised = store.upsert('test-source', dict(PAYLOAD, brief='Revised'), approved['version'])['item']
    assert revised['id'] == card['id']
    assert revised['revision'] == 2
    assert revised['state'] == 'ideas'
    assert revised['approval'] is None
    assert store.list(preparation=True) == {'items': []}
    p = store.propose(revised['id'], revised['version'])['item']
    with pytest.raises(WorkError, match='revision'):
        store.decide(p['id'], p['version'], 1, 'approve_preparation', 'stale-revision', human_identity='test')
    assert len(store.get(p['id'])['decisions']) == 1


def test_duplicate_decision_exact_retry_and_conflicting_key(tmp_path):
    store = WorkStore(tmp_path / 'inbox.db', 'hoffeecmo')
    card = proposed(store)
    first = decide(store, card)
    assert decide(store, card) == first
    with pytest.raises(WorkError, match='idempotency'):
        decide(store, card, action='decline')
    with pytest.raises(WorkError, match='stale'):
        decide(store, card, key='another-click')
    assert len(store.get(card['id'])['decisions']) == 1


def test_independent_concurrent_humans_cannot_double_decide(tmp_path):
    path = tmp_path / 'inbox.db'
    card = proposed(WorkStore(path, 'hoffeecmo'))
    barrier = threading.Barrier(2)

    def click(action):
        store = WorkStore(path, 'hoffeecmo')
        barrier.wait(timeout=5)
        try:
            return decide(store, card, action=action, key=action)
        except WorkError as exc:
            return exc.code

    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(click, ['approve_preparation', 'decline']))
    assert sum(isinstance(r, dict) for r in results) == 1
    assert 4409 in results
    assert len(WorkStore(path, 'hoffeecmo').get(card['id'])['decisions']) == 1


def test_independent_concurrent_source_dedupe(tmp_path):
    path = tmp_path / 'inbox.db'
    barrier = threading.Barrier(2)

    def submit(_):
        store = WorkStore(path, 'hoffeecmo')
        barrier.wait(timeout=5)
        return store.upsert('same-source', PAYLOAD)['item']

    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(submit, range(2)))
    assert results[0] == results[1]
    assert len(WorkStore(path, 'hoffeecmo').list()['items']) == 1


def test_closed_declines_stay_closed_and_changes_require_revision(tmp_path):
    store = WorkStore(tmp_path / 'inbox.db', 'hoffeecmo')
    card = proposed(store)
    declined = decide(store, card, action='decline')['item']
    assert store.upsert('test-source', PAYLOAD)['item'] == declined
    with pytest.raises(WorkError, match='closed'):
        store.upsert('test-source', dict(PAYLOAD, brief='Try reopening'), declined['version'])
    with pytest.raises(WorkError):
        store.propose(declined['id'], declined['version'])
    card = proposed(store, 'other-source')
    changes = decide(store, card, action='request_changes', key='changes', reason='Add evidence')['item']
    with pytest.raises(WorkError, match='revised'):
        store.propose(changes['id'], changes['version'])
    revised = store.upsert('other-source', dict(PAYLOAD, evidence=['fixture:new']), changes['version'])['item']
    assert store.propose(revised['id'], revised['version'])['item']['state'] == 'needs_me'


def test_snooze_due_and_digest_receipts_survive_reopen(tmp_path):
    now = [datetime(2026, 9, 5, tzinfo=timezone.utc)]
    path = tmp_path / 'inbox.db'
    store = WorkStore(path, 'hoffeecmo', clock=lambda: now[0])
    card = proposed(store)
    consumer = 'daily-cmo'
    receipt = [{'id': card['id'], 'attention_key': card['attention_key']}]
    assert store.digest(consumer)['items'] == [card]
    assert store.digest_ack(consumer, receipt) == {'acknowledged': 1}
    assert store.digest_ack(consumer, receipt) == {'acknowledged': 0}
    snoozed = decide(store, card, action='snooze', snoozed_until=(now[0] + timedelta(days=1)).isoformat())['item']
    assert not snoozed['attention_due']
    assert store.propose(snoozed['id'], snoozed['version'])['item'] == snoozed
    assert store.list(include_snoozed=False)['items'] == []
    with pytest.raises(WorkError, match='now'):
        decide(store, snoozed, key='premature')
    store = WorkStore(path, 'hoffeecmo', clock=lambda: now[0])
    assert store.digest(consumer)['items'] == []
    now[0] += timedelta(days=1)
    due = store.digest(consumer)['items'][0]
    assert due['attention_due']
    assert due['attention_key'] != card['attention_key']
    with pytest.raises(WorkError, match='stale'):
        store.digest_ack(consumer, receipt)
    store.digest_ack(consumer, [{'id': due['id'], 'attention_key': due['attention_key']}])
    assert WorkStore(path, 'hoffeecmo', clock=lambda: now[0]).digest(consumer)['items'] == []
    assert len(store.digest('other-consumer')['items']) == 1


def test_comment_durable_idempotent_no_approval_or_version_mutation(tmp_path):
    store = WorkStore(tmp_path / 'inbox.db', 'hoffeecmo')
    card = proposed(store)
    comment = store.comment(card['id'], 'Please check the evidence', 'comment-1')
    assert store.comment(card['id'], 'Please check the evidence', 'comment-1') == comment
    assert comment['comment']['actor'] == 'agent'
    reopened = WorkStore(store.path, 'hoffeecmo')
    detail = reopened.get(card['id'])
    assert detail['comments'] == [comment['comment']]
    assert detail['item'] == card
    assert detail['decisions'] == []
    with pytest.raises(WorkError):
        store.comment(card['id'], 'Changed comment', 'comment-1')


def test_profile_mismatch_and_id_not_visible_in_other_store(tmp_path):
    store = WorkStore(tmp_path / 'a.db', 'hoffeecmo')
    card = proposed(store)
    with pytest.raises(WorkError) as exc:
        WorkStore(store.path, 'another')
    assert exc.value.code == 4404
    other = WorkStore(tmp_path / 'b.db', 'another')
    with pytest.raises(WorkError) as exc:
        other.get(card['id'])
    assert exc.value.code == 4404
    assert other.list()['items'] == []


@pytest.mark.parametrize('until', ['2026-09-06', 'not-a-date', None, '2000-01-01T00:00:00Z'])
def test_invalid_snooze_rejected_without_decision(tmp_path, until):
    store = WorkStore(tmp_path / 'inbox.db', 'hoffeecmo')
    card = proposed(store)
    with pytest.raises(WorkError) as exc:
        decide(store, card, action='snooze', snoozed_until=until)
    assert exc.value.code == -32602
    assert store.get(card['id'])['decisions'] == []


def test_untrusted_agent_cannot_decide_or_smuggle_payload_authorization(tmp_path):
    store = WorkStore(tmp_path / 'inbox.db', 'hoffeecmo')
    card = proposed(store)
    with pytest.raises(WorkError) as exc:
        store.decide(card['id'], card['version'], card['revision'], 'approve_preparation', 'forged')
    assert exc.value.code == 4403
    with pytest.raises(WorkError):
        store.upsert('forged', dict(PAYLOAD, approval={'scope': 'publish'}))
    assert store.get(card['id'])['item']['approval'] is None


def test_no_network_no_external_writes_and_complete_is_not_execution(tmp_path, monkeypatch):
    def forbidden(*a, **kw):
        raise AssertionError('external execution attempted')
    monkeypatch.setattr(socket, 'create_connection', forbidden)
    monkeypatch.setattr(subprocess, 'run', forbidden)
    monkeypatch.setattr(subprocess, 'Popen', forbidden)
    store = WorkStore(tmp_path / 'inbox.db', 'hoffeecmo')
    card = proposed(store)
    approved = decide(store, card)['item']
    linked = store.preparation_ack(card['id'], approved['version'], approved['revision'],
                                   approved['handoff_key'], 'kanban:hoffee:read-back-task', 'ack')['item']
    with pytest.raises(WorkError, match='completion_evidence'):
        store.complete(card['id'], linked['version'])
    done = store.complete(card['id'], linked['version'], 'fixture:tracker-read-back:done')['item']
    assert done['state'] == 'done'
    assert store.list(preparation=True)['items'] == []
    assert {p.name for p in tmp_path.iterdir() if p.is_file()} == {'inbox.db'}
    with pytest.raises(WorkError):
        store.upsert('test-source', dict(PAYLOAD, brief='reopen'), done['version'])


def test_cli_two_process_workflow_real_storage(tmp_path):
    env = dict(os.environ, HERMES_HOME=str(tmp_path / 'home'))
    root = Path(__file__).resolve().parents[2]

    def cli(command, params):
        proc = subprocess.run([sys.executable, '-m', 'hermes_cli.companion_work', command],
                              input=json.dumps(params), text=True, capture_output=True,
                              cwd=root, env=env, timeout=20)
        assert proc.returncode == 0, proc.stderr
        return json.loads(proc.stdout)

    card = cli('upsert', {'source_key': 'test-source', 'payload': PAYLOAD})['item']
    card = cli('propose', {'id': card['id'], 'expected_version': card['version']})['item']
    assert cli('get', {'id': card['id']})['item'] == card
    assert cli('list', {})['items'] == [card]
    assert cli('preparation', {})['items'] == []
    forged = subprocess.run([sys.executable, '-m', 'hermes_cli.companion_work', 'decide'],
                            input='{}', text=True, capture_output=True, cwd=root, env=env, timeout=20)
    assert forged.returncode != 0


def test_evidence_refresh_does_not_cancel_snooze(tmp_path):
    now = [datetime(2026, 9, 5, tzinfo=timezone.utc)]
    path = tmp_path / 'inbox.db'
    store = WorkStore(path, 'hoffeecmo', clock=lambda: now[0])
    c = proposed(store)
    c = decide(store, c, action='snooze', snoozed_until='2026-09-07T00:00:00Z')['item']
    c = store.upsert(c['source_key'], dict(PAYLOAD, evidence=['fixture:new-filename']), c['version'])['item']
    assert c['snoozed_until'] == '2026-09-07T00:00:00+00:00'
    assert c['state'] == 'needs_me'
    store = WorkStore(path, 'hoffeecmo', clock=lambda: now[0])
    assert store.digest('daily')['items'] == []
    now[0] += timedelta(days=2)
    assert store.digest('daily')['items'][0]['id'] == c['id']


def test_digest_local_day_dedupes_revisions_and_reminds_tomorrow(tmp_path):
    now = [datetime(2026, 9, 5, 21, 59, tzinfo=timezone.utc)]
    store = WorkStore(tmp_path / 'inbox.db', 'hoffeecmo', clock=lambda: now[0], timezone_name='Europe/Warsaw')
    c = proposed(store)
    store.digest_ack('daily', [{'id': c['id'], 'attention_key': c['attention_key']}])
    c = store.upsert(c['source_key'], dict(PAYLOAD, brief='Update'), c['version'])['item']
    c = store.propose(c['id'], c['version'])['item']
    assert store.digest('daily')['items'] == []
    now[0] += timedelta(minutes=2)
    assert len(store.digest('daily')['items']) == 1
    receipt = [{'id': c['id'], 'attention_key': c['attention_key']}]
    with pytest.raises(WorkError, match='stale'):
        store.digest_ack('daily', receipt)


def test_execution_reference_is_not_acknowledged_handoff(tmp_path):
    store = WorkStore(tmp_path / 'inbox.db', 'hoffeecmo')
    c = decide(store, proposed(store))['item']
    assert c['preparation_status'] == 'dispatch_pending'
    assert c['execution_link'] is None
    with pytest.raises(WorkError, match='linked'):
        store.complete(c['id'], c['version'])
    args = dict(card_id=c['id'], expected_version=c['version'], revision=c['revision'],
                handoff_key=c['handoff_key'], execution_ref='kanban:hoffee:verified-task', idempotency_key='ack-1')
    linked = store.preparation_ack(**args)
    assert linked['item']['preparation_status'] == 'linked'
    assert store.preparation_ack(**args) == linked
    with pytest.raises(WorkError, match='idempotency'):
        store.preparation_ack(**dict(args, execution_ref='kanban:other'))
    c = linked['item']
    revised = store.upsert(c['source_key'], dict(PAYLOAD, brief='Changed scope'), c['version'])['item']
    assert revised['approval'] is None
    assert revised['execution_link'] is None
    assert revised['preparation_status'] == 'not_authorized'
    with pytest.raises(WorkError):
        store.preparation_ack(**dict(args, expected_version=revised['version'], idempotency_key='late-ack'))


def test_invalid_json_types_are_parameter_errors(tmp_path):
    store = WorkStore(tmp_path / 'inbox.db', 'hoffeecmo')
    with pytest.raises(WorkError) as exc:
        store.list(states=[{}])
    assert exc.value.code == -32602
    c = proposed(store)
    with pytest.raises(WorkError) as exc:
        decide(store, c, action={})
    assert exc.value.code == -32602


@pytest.fixture
def work_transport(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from hermes_cli import web_server
    from hermes_cli.dashboard_auth import clear_providers, register_provider
    from hermes_cli.dashboard_auth.ws_tickets import _reset_for_tests
    from tests.hermes_cli.conftest_dashboard_auth import StubAuthProvider
    from tui_gateway import server
    home = tmp_path / 'home'
    home.mkdir()
    (home / 'config.yaml').write_text('dashboard:\n  work_owner_identities: [stub:stub-user-1]\n')
    monkeypatch.setenv('HERMES_HOME', str(home))
    monkeypatch.delenv('HERMES_PROFILE', raising=False)
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    monkeypatch.setattr(web_server, '_DASHBOARD_EMBEDDED_CHAT_ENABLED', True)
    monkeypatch.setattr(web_server.app.state, 'bound_host', 'work.example.test', raising=False)
    monkeypatch.setattr(web_server.app.state, 'bound_port', 443, raising=False)
    monkeypatch.setattr(web_server.app.state, 'auth_required', True, raising=False)
    # Only unrelated skin watcher disabled; real auth/dispatch/transport/store.
    monkeypatch.setattr(server, '_ensure_skin_watcher', lambda: None)
    clear_providers()
    _reset_for_tests()
    register_provider(StubAuthProvider())
    a = TestClient(web_server.app, base_url='https://work.example.test')
    b = TestClient(web_server.app, base_url='https://work.example.test')
    yield web_server, a, b
    a.close()
    b.close()
    clear_providers()
    _reset_for_tests()


def login_ticket(client):
    from urllib.parse import parse_qs, urlparse
    r = client.get('/auth/login?provider=stub', follow_redirects=False)
    assert r.status_code == 302
    state = parse_qs(urlparse(r.headers['location']).query)['state'][0]
    r = client.get('/auth/callback', params={'code': 'stub_code', 'state': state}, follow_redirects=False)
    assert r.status_code == 302
    r = client.post('/api/auth/ws-ticket')
    assert r.status_code == 200
    return r.json()['ticket']


def rpc(ws, method, params=None, error=None):
    ws.send_json({'jsonrpc': '2.0', 'id': 1, 'method': 'work.' + method, 'params': params or {}})
    while True:
        response = ws.receive_json()
        if response.get('id') == 1:
            break
    if error is not None:
        assert response['error']['code'] == error, response
        return response
    assert 'error' not in response, response
    return response['result']


def test_real_two_client_owner_login_rpc_revision_loop(work_transport):
    web, a, b = work_transport
    ta, tb = login_ticket(a), login_ticket(b)
    with a.websocket_connect('wss://work.example.test/api/ws?ticket=' + ta) as one, b.websocket_connect('wss://work.example.test/api/ws?ticket=' + tb) as two:
        assert rpc(one, 'capabilities')['can_decide'] is True
        c = rpc(one, 'upsert', {'source_key': 'semantic-campaign-key', 'payload': PAYLOAD})['item']
        c = rpc(one, 'propose', {'id': c['id'], 'expected_version': c['version']})['item']
        assert rpc(two, 'get', {'id': c['id']})['item'] == c
        d = dict(id=c['id'], expected_version=c['version'], revision=c['revision'], action='request_changes',
                 idempotency_key='changes-rpc', reason='Add evidence')
        rpc(two, 'decide', dict(d, actor='forged'), error=-32602)
        changed = rpc(two, 'decide', d)
        assert rpc(two, 'decide', d) == changed
        rpc(one, 'decide', dict(d, action='approve_preparation', idempotency_key='stale'), error=4409)
        c = changed['item']
        rpc(one, 'propose', {'id': c['id'], 'expected_version': c['version']}, error=4409)
        comment = rpc(two, 'comment', {'id': c['id'], 'text': 'Please add source context', 'idempotency_key': 'thread'})
        assert rpc(one, 'get', {'id': c['id']})['comments'] == [comment['comment']]
        c = rpc(one, 'upsert', {'source_key': c['source_key'], 'payload': dict(PAYLOAD, evidence=['fixture:revised']), 'expected_version': c['version']})['item']
        c = rpc(one, 'propose', {'id': c['id'], 'expected_version': c['version']})['item']
        assert rpc(two, 'get', {'id': c['id']})['item'] == c
        approved = rpc(two, 'decide', dict(id=c['id'], expected_version=c['version'], revision=c['revision'], action='approve_preparation', idempotency_key='approve-rpc'))
        assert approved['decision']['actor'] == 'stub:stub-user-1'
        assert approved['item']['preparation_status'] == 'dispatch_pending'
        assert rpc(one, 'get', {'id': c['id']})['item'] == approved['item']
        assert rpc(one, 'digest', {'consumer': 'daily'})['items'] == []
        rpc(two, 'get', {'id': c['id'], 'profile': '../other'}, error=-32602)
        rpc(two, 'get', {'id': c['id'], 'profile': 'missing-profile'}, error=4404)
    # Reconnect is a fresh ticket, never reuse the consumed admission ticket.
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect):
        with a.websocket_connect('wss://work.example.test/api/ws?ticket=' + ta):
            pass
    ticket = a.post('/api/auth/ws-ticket').json()['ticket']
    with a.websocket_connect('wss://work.example.test/api/ws?ticket=' + ticket) as reopened:
        assert len(rpc(reopened, 'get', {'id': c['id']})['decisions']) == 2


def test_real_shared_and_internal_transports_cannot_decide(work_transport, monkeypatch):
    web, a, _ = work_transport
    from hermes_cli.dashboard_auth.ws_tickets import internal_ws_credential
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect):
        with a.websocket_connect('wss://work.example.test/api/ws?token=' + web._SESSION_TOKEN):
            pass
    with a.websocket_connect('wss://work.example.test/api/ws?internal=' + internal_ws_credential()) as agent:
        assert rpc(agent, 'capabilities')['can_decide'] is False
        rpc(agent, 'decide', {}, error=4403)
        rpc(agent, 'capabilities', {'human_identity': 'owner'}, error=-32602)
    monkeypatch.setattr(web.app.state, 'auth_required', False)
    with a.websocket_connect('wss://work.example.test/api/ws?token=' + web._SESSION_TOKEN) as shared:
        assert rpc(shared, 'capabilities')['can_decide'] is False
        rpc(shared, 'decide', {}, error=4403)



def test_native_pkce_bearer_ticket_grants_human_not_shared_token(work_transport):
    import base64
    import hashlib
    from urllib.parse import urlparse, parse_qs
    web, browser, native = work_transport
    verifier = 'test-only-pkce-verifier-material-abcdefghijklmnopqrstuvwxyz'
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    r = browser.get('/auth/native/authorize', params=dict(provider='stub', code_challenge=challenge,
        code_challenge_method='S256', redirect_uri='http://127.0.0.1:49876/callback', state='native-state'), follow_redirects=False)
    assert r.status_code == 302
    q = parse_qs(urlparse(r.headers['location']).query)
    r = browser.get('/auth/callback', params={'code': q['code'][0], 'state': q['state'][0]}, follow_redirects=False)
    assert r.status_code == 302
    q = parse_qs(urlparse(r.headers['location']).query)
    assert q['state'] == ['native-state']
    r = native.post('/auth/native/token', json={'code': q['code'][0], 'code_verifier': verifier})
    assert r.status_code == 200
    access = r.json()['access_token']
    native.cookies.clear()
    ticket = native.post('/api/auth/ws-ticket', headers={'Authorization': 'Bearer ' + access})
    assert ticket.status_code == 200
    with native.websocket_connect('wss://work.example.test/api/ws?ticket=' + ticket.json()['ticket']) as ws:
        assert rpc(ws, 'capabilities')['can_decide'] is True
    rejected = native.post('/api/auth/ws-ticket', headers={'Authorization': 'Bearer invalid-test-token'}, follow_redirects=False)
    assert rejected.status_code == 401



def test_multiuser_owner_allowlist_fail_closed_and_policy_revocation(work_transport, monkeypatch):
    from hermes_cli.dashboard_auth import ws_tickets
    web, a, _ = work_transport
    clock = {'now': 1_000.0}
    monkeypatch.setattr(ws_tickets, 'monotonic', lambda: clock['now'])
    ticket = login_ticket(a)
    home = Path(os.environ['HERMES_HOME'])
    with a.websocket_connect('wss://work.example.test/api/ws?ticket=' + ticket) as ws:
        assert rpc(ws, 'capabilities')['can_decide'] is True
        (home / 'config.yaml').write_text('dashboard: {work_owner_identities: []}')
        assert rpc(ws, 'capabilities')['can_decide'] is False
        rpc(ws, 'decide', {}, error=4403)
        (home / 'config.yaml').write_text('dashboard: {}')
        assert rpc(ws, 'capabilities')['can_decide'] is False
        (home / 'config.yaml').write_text('dashboard: {work_owner_identities: "stub:stub-user-1"}')
        assert rpc(ws, 'capabilities')['can_decide'] is False
        (home / 'config.yaml').write_text('dashboard: {work_owner_identities: [stub:stub-user-1]}')
        assert rpc(ws, 'capabilities')['can_decide'] is True
        clock['now'] += ws_tickets.OWNER_AUTH_LEASE_SECONDS
        assert rpc(ws, 'capabilities')['can_decide'] is False
        rpc(ws, 'decide', {}, error=4403)


def test_basic_single_owner_policy(tmp_path, monkeypatch):
    from hermes_cli.companion_work import owner_identity
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    (tmp_path / 'config.yaml').write_text('dashboard: {basic_auth: {username: operator}}')
    assert owner_identity('basic:operator') == 'basic:operator'
    assert owner_identity('basic:another') is None
    assert owner_identity('oauth:operator') is None


def test_loopback_auth_opt_in_uses_existing_gate(work_transport, monkeypatch):
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect
    web, _, _ = work_transport
    home = Path(os.environ['HERMES_HOME'])
    assert web.should_require_auth('127.0.0.1') is False
    (home / 'config.yaml').write_text('dashboard:\n  require_auth_on_loopback: true\n  work_owner_identities: [stub:stub-user-1]\n')
    assert web.should_require_auth('127.0.0.1') is True
    assert web.should_require_auth('localhost', allow_public=True) is True
    assert web.should_require_auth('192.168.1.5') is True
    monkeypatch.setattr(web.app.state, 'bound_host', '127.0.0.1')
    monkeypatch.setattr(web.app.state, 'bound_port', 443)
    monkeypatch.setattr(web.app.state, 'auth_required', web.should_require_auth('127.0.0.1'))
    client = TestClient(web.app, base_url='https://127.0.0.1', client=('127.0.0.1', 50000))
    try:
        status = client.get('/api/status')
        assert status.status_code == 200
        assert status.json()['auth_required'] is True
        assert client.post('/api/auth/ws-ticket', follow_redirects=False).status_code == 401
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect('wss://127.0.0.1/api/ws?token=' + web._SESSION_TOKEN):
                pass
        ticket = login_ticket(client)
        with client.websocket_connect('wss://127.0.0.1/api/ws?ticket=' + ticket) as ws:
            assert rpc(ws, 'capabilities')['can_decide'] is True
    finally:
        client.close()
    (home / 'config.yaml').write_text('dashboard: {require_auth_on_loopback: "false"}')
    with pytest.raises(ValueError, match='boolean'):
        web.should_require_auth('127.0.0.1')
