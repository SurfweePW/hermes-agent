"""Agent-safe work inbox commands and shared RPC application boundary.

Run ``python -m hermes_cli.companion_work --help``. JSON input is a file or
stdin; no secrets, fabricated records, or production adapters are required.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from hermes_cli.companion_work_store import (
    WorkError, WorkStore, anchored_store_path)

DECISION_AUTH_REASON = ('Owner sign-in required: use an authorized dashboard session and a fresh '
                        'single-use ticket. Shared tokens and agent/internal clients cannot decide.')
FIELDS = {
    'capabilities': set(),
    'list': {'states', 'include_snoozed'},
    'get': {'id'},
    'upsert': {'source_key', 'payload', 'expected_version'},
    'propose': {'id', 'expected_version'},
    'comment': {'id', 'text', 'idempotency_key'},
    'decide': {'id', 'expected_version', 'revision', 'action', 'idempotency_key', 'reason', 'snoozed_until'},
    'complete': {'id', 'expected_version', 'completion_evidence'},
    'preparation.list': set(),
    'preparation.ack': {'id', 'expected_version', 'revision', 'handoff_key', 'execution_ref', 'idempotency_key'},
    'digest': {'consumer'},
    'digest.ack': {'consumer', 'items', 'batch_id'},
}


def resolve_store(profile=None):
    from hermes_constants import get_hermes_home, mkdir_under_hermes_home
    from hermes_cli.profiles import (
        get_active_profile_name,
        get_profile_dir,
        profile_exists,
        validate_profile_name,
    )

    current = get_active_profile_name() or 'default'
    home = get_hermes_home()
    selected = current if profile is None else profile
    if not isinstance(selected, str):
        raise WorkError('invalid profile', -32602)
    try:
        validate_profile_name(selected)
    except ValueError as exc:
        raise WorkError(str(exc), -32602) from exc
    # A custom deployment root is the current default profile and has no named
    # profile registry entry. Preserve that current-home path, but require every
    # named selection to be live according to the canonical tombstone-aware check.
    if not (selected == current == 'custom') and not profile_exists(selected):
        raise WorkError('profile unavailable', 4404)
    if selected != current:
        home = get_profile_dir(selected)
    # Store construction is deliberately non-creating. Only this profile-aware
    # boundary may materialize a custom/default home after validation above.
    mkdir_under_hermes_home(home)
    # Fail closed on redirect attacks at the production entry point: a
    # symlinked store file or profile directory must not relocate business
    # decisions outside the Hermes home. Only profile-derived paths reach
    # here, so the anchor invariant holds for every store this creates.
    anchored_store_path(Path(home) / 'companion-work.db')
    from hermes_cli.config import load_config_path_readonly

    config = load_config_path_readonly(Path(home) / 'config.yaml')
    timezone_name = (config or {}).get('timezone') or 'UTC'
    return WorkStore(Path(home) / 'companion-work.db', selected, timezone_name=timezone_name)


def owner_identity(human_identity):
    """Authorization is distinct from ticket authentication, and server-owned.

    The dashboard launch profile controls its owner policy across profiles.
    Multiuser providers are denied unless explicitly allowlisted. The built-in
    basic provider has exactly one configured username and is single-owner.
    """
    if not isinstance(human_identity, str) or not human_identity:
        return None
    try:
        from hermes_constants import get_hermes_home

        from hermes_cli.config import load_config_path_readonly

        # Authorization policy must be read from the file, not a cache: the
        # last-known-good cache would leave a stale owner authorized after
        # config.yaml is corrupted, and a malformed write must not create a
        # corrupt-file backup from an authorization path.
        config = load_config_path_readonly(
            Path(get_hermes_home()) / 'config.yaml', fail_closed=True
        )
        dashboard = (config or {}).get('dashboard', {})
        owners = dashboard.get('work_owner_identities')
        if owners is not None:
            return human_identity if isinstance(owners, list) and human_identity in owners else None
        username = dashboard.get('basic_auth', {}).get('username')
        return human_identity if username and human_identity == f'basic:{username}' else None
    except (OSError, ValueError, AttributeError):
        return None  # malformed policy must never elevate an authenticated peer


def execute(operation, params, *, owner_authorization=None):
    if operation not in FIELDS:
        raise WorkError('unknown work operation', -32601)
    if not isinstance(params, dict) or set(params) - (FIELDS[operation] | {'profile'}):
        raise WorkError('unexpected work parameters (identity is server-derived)', -32602)
    from hermes_cli.dashboard_auth.ws_tickets import leased_human_identity
    human_identity = leased_human_identity(owner_authorization)
    # Both checks are deliberately repeated on every call: the server lease
    # can expire while a socket remains open, and the owner allowlist can be
    # revoked without waiting for that lease to end.
    owner = owner_identity(human_identity)
    if operation == 'capabilities':
        return {
            'can_decide': bool(owner),
            'reason': None if owner else DECISION_AUTH_REASON,
            'notifications': {
                'delivery_mode': 'external_receipt_only',
                'batch_receipts': True,
                'card_receipts': True,
                'os_notifications': 'unsupported',
                'grants_authority': False,
            },
        }
    if operation == 'decide' and not owner:
        raise WorkError(DECISION_AUTH_REASON, 4403)
    store = resolve_store(params.get('profile'))
    p = {k: v for k, v in params.items() if k != 'profile'}
    try:
        if operation == 'get':
            return store.get(p['id'])
        if operation == 'list':
            return store.list(**p)
        if operation == 'upsert':
            return store.upsert(**p)
        if operation == 'propose':
            return store.propose(p['id'], p['expected_version'])
        if operation == 'comment':
            return store.comment(p['id'], p['text'], p['idempotency_key'], human_identity=human_identity)
        if operation == 'decide':
            p['card_id'] = p.pop('id')
            return store.decide(**p, human_identity=owner)
        if operation == 'complete':
            return store.complete(p['id'], p['expected_version'], p.get('completion_evidence'))
        if operation == 'preparation.ack':
            p['card_id'] = p.pop('id')
            return store.preparation_ack(**p)
        if operation == 'preparation.list':
            return store.list(preparation=True)
        if operation == 'digest':
            return store.digest(p['consumer'])
        if operation == 'digest.ack':
            return store.digest_ack(p['consumer'], p['items'], p.get('batch_id'))
    except (KeyError, TypeError) as exc:
        raise WorkError('missing or invalid work parameters', -32602) from exc


def main(argv=None):
    parser = argparse.ArgumentParser(description='Durable preparation-only Companion inbox (agent-safe; no decision command).')
    parser.add_argument('--profile', help='Existing profile ID; defaults to active HERMES_HOME profile')
    parser.add_argument('command', choices=['upsert', 'propose', 'comment', 'list', 'get', 'preparation', 'preparation-ack', 'complete', 'digest', 'digest-ack'])
    parser.add_argument('--json', default='-', metavar='FILE', help='RPC parameter object from FILE, or stdin (-); list/preparation default to {}')
    args = parser.parse_args(argv)
    try:
        if args.json == '-':
            raw = '' if sys.stdin.isatty() else sys.stdin.read()
        else:
            raw = Path(args.json).read_text(encoding='utf-8')
        params = json.loads(raw) if raw.strip() else {}
        if args.profile is not None:
            if not isinstance(params, dict):
                raise WorkError('JSON must be an object', -32602)
            params['profile'] = args.profile
        operation = {'preparation': 'preparation.list', 'preparation-ack': 'preparation.ack', 'digest-ack': 'digest.ack'}.get(args.command, args.command)
        result = execute(operation, params)  # deliberately no human capability
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (WorkError, OSError, json.JSONDecodeError) as exc:
        print(json.dumps({'error': {'code': getattr(exc, 'code', -32602), 'message': str(exc)}}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
