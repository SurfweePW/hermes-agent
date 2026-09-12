# P5-W1 — real WorkStore schema/revision/decision proof

Scope: read-only inspection of the profile-local `companion-work.db`, followed by mutation only in an isolated pytest database. No migration or write was performed against the profile store; no tracker, deployment, or external action was invoked.

## Real read-only schema capture

Source inspected through SQLite `mode=ro&nofollow=1` with `PRAGMA query_only=ON`.
The production proof deliberately avoids the immutable URI option so live WAL state is visible:

`/Users/atlasweber/.hermes/profiles/atlas/companion-work.db`

The source was a canonical regular file with mode `0600`. Capture fingerprints:

- database SHA-256: `56f6f93c877b8f93fe971f0eeeaa3e0ccc4d1bc4e55f6763925bbeb2feb975db`
- canonical JSON `sqlite_master` snapshot SHA-256: `633fb54dcc47595106a3b853ed9d05a72941c92bbbae94e917fe0fde7f461406`
- SQLite `user_version`: `0`; SQLite catalog `schema_version`: `12`

Observed tables:

- `inbox_meta`
- `work_cards`
- `work_comments`
- `work_decisions`
- `work_digest_batches`
- `work_digest_receipts`
- `work_idempotency`
- `work_revisions`
- `work_tracker_status_events`

Observed `work_cards` columns, in storage order:

`id`, `source_key`, `payload`, `state`, `revision`, `version`, `created_at`, `updated_at`, `snoozed_until`, `approval`, `attention_generation`, `changes_revision`, `execution_link`, `completion_evidence`, `tracker_evidence`.

The real store contained one `inbox_meta` row and zero card, revision, decision, comment, tracker, digest, and idempotency rows. Therefore a live revision/decision mutation could not be proven there without manufacturing production data, which was explicitly avoided.

## Deterministic isolated proof

`tests/hermes_cli/test_companion_work_p5_w1.py` does not let `WorkStore` create the schema that the same test purports to verify. It creates independent SQLite fixtures for the frozen `83707a164f`, `4303881843`, and current persistence contracts, including historical decision and handoff receipts.

`test_frozen_real_schema_is_read_without_creation_or_migration` proves that:

1. the frozen table/column contract and seeded revision are present before production code opens the database;
2. `companion_work_store_readonly.existing_card_ids` reads the seeded card;
3. the complete catalog, column metadata, and all table rows are exactly equal before and after those reads;
4. querying a missing store returns `None` and does not create a file.

`test_existing_lookup_observes_committed_card_still_in_wal` keeps a read transaction open, commits a new card into WAL, proves a normal read-only SQLite connection sees it, and proves `existing_card_ids` sees the same card. The production reader uses `mode=ro&nofollow=1`, not `immutable=1`.

The remaining corruption tests prove exact supported table/index signatures, historical receipt compatibility, revision/decision/idempotency relations, lifecycle counters, legacy and tracker completion variants, and consistent `WorkError(4404)` mapping without modifying the inspected database.

`test_two_concurrent_clients_persist_one_revision_bound_decision` starts two independent calls through the production `companion_work.execute` server boundary at the same barrier with version `11` and revision `7`. Store resolution and owner-lease validation are isolated so the test exercises no real profile or login. It proves that:

1. exactly one click commits and exactly one is rejected with `4409`;
2. the committed preparation decision has a server-generated ID and remains bound to revision `7`;
3. only a fresh `execute("get", ...)` server read establishes confirmation and binds `approval.decision_id` to the persisted decision;
4. an exact retry with the winning idempotency key returns the original response;
5. raw read-only SQL finds one decision, one unchanged revision row, card version `12`, and one decision-idempotency row.

## Verification

```sh
scripts/run_tests.sh tests/hermes_cli/test_companion_work_p5_w1.py \
  tests/hermes_cli/test_companion_work.py \
  tests/tui_gateway/test_companion_attention.py
```

Observed result: `152 passed, 0 failed`. `git diff --check` also passed.
