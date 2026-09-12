# Independent re-audit — Hermes Companion durable session creation (frozen tree)

You are the independent auditor. Read-only: **do not modify, format, stage or commit any file.** Your job is to
verify or refute the claim that the four defects below are closed, and to look for anything the fixes broke.

## Frozen candidate (audit this exact tree)

- Repository: `/Users/atlasweber/hermes-companion` (branch `feature/hermes-companion`)
- Frozen commit: **`a542da9f5b9566c1a3e9eea118489635792a0aba`** (`git rev-parse HEAD` must print this)
- Working tree must be clean (`git status --short` empty). If HEAD differs from the SHA above, stop and say so.

## Design contract (authoritative)

- `docs/plans/companion-mobile-evidence/p4-current-design-v2.md` — especially §1.4 (receipt fields), §1.5 (error
  codes), §3.1–§3.3 (reservation, binding, dispatch order), §4.3 (crash/recovery rows, incl. rows 246–265).
- Prior audit record: `docs/plans/companion-mobile-evidence/sol-audit-2026-09-12/` (first audit, verdict FAIL).
- Crash-boundary coverage record: `docs/plans/companion-mobile-evidence/r5-2026-09-12/`.

## The four defects to verify

1. **D1 (high)** — the durable request index was bound before session capacity was reserved, so a refused
   reservation left an already-created operation. Fixed in commit `9e3a63cdaf`
   (`tui_gateway/companion_session_create.py`).
2. **D2 (high, product-blocking)** — the mobile client never entered durable session creation; a "new
   conversation" used `session.create` plus a `"Bot Chat"` title lookup instead of `companion.sessions.create` /
   `companion.sessions.continue` with `companion.sessions.reconcile` on reconnect. Implemented in commit
   `c40324de9b` (merged by `a542da9f5b`), scope `apps/companion/src/**`.
3. **D3 (medium)** — the degraded receipt carried `null` where §1.4 requires strings (`backend_namespace`,
   `profile`, `client_request_id`). Fixed in commit `03c0e34260` (`tui_gateway/companion_creation.py`).
4. **D4 (high, found during the R5 coverage audit)** — reconciliation never settled a *dead* creator whose turn
   pair was already committed while the coordinator was still `preparing` (design §4.3, row 254): the row stayed
   unsettled, i.e. `recovery_required` forever. Fixed in commit `1db6b98b4a`
   (`tui_gateway/companion_creation.py`), with a real-process regression test in
   `tests/tui_gateway/test_companion_creation_process_matrix.py`.

## What to deliver

- `RE-AUDIT_VERDICT: PASS` or `RE-AUDIT_VERDICT: FAIL` as its own line, near the top of your final answer.
- For each defect D1–D4: **closed / not closed / partially closed**, with the exact `file:line` evidence you read,
  and the command you ran plus its observed result. A fix you cannot demonstrate is "not verified", not "closed".
- New defects you find (severity + `file:line` + the concrete failure scenario).
- Regressions: re-check the first audit's confirmed items (4090 conflict, capacity refusal 4091, storage 5072,
  unknown outcome 5066, 60 s recovery window, reaper 600 s) against the current tree.
- Honesty check on the new tests: do they prove behaviour, or are they change-detectors / vacuous? Do the process
  tests exercise real processes (no mocked psutil) and would they fail on the pre-fix code?
- What remains unverifiable from this machine (e.g. on-device Android behaviour).

## Gates to run yourself (report exact commands and observed numbers)

- `scripts/run_tests.sh tests/tui_gateway/test_companion_creation_process_matrix.py`
- `scripts/run_tests.sh tests/tui_gateway/`
- In `apps/companion`: `npx vitest run`, `npx tsc -p . --noEmit`, `npx eslint src/ -f json`
- Report observed counts, not expectations. The claimed baseline before these fixes: 486/0 for the 11-file gate,
  574 JS tests.

## Rules

- Quote `file:line` for every claim. Never trust a commit message or a report file as evidence of behaviour.
- No edits, no commits, no formatting, no `git checkout`. Read and run tests only.
- If you cannot verify something, write "NOT VERIFIED" and say what would be needed.
