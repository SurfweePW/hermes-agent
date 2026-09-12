# Adversarial review C2 — Companion creation process matrix (falsifiability audit)

Auditor: Atlas (independent adversarial pass, GLM-5.3)
Date: 2026-09-12
Repo state audited: `/Users/atlasweber/hermes-companion` at HEAD `f8166a7def` (clean tree)

## VERDICT: PASS WITH FINDINGS

The matrix is a real-process E2E gate with genuinely falsifiable core assertions: the
counters wrap product seams reached from product code, the two processes in test 1 do
actually race at the SQLite C-bind, and the crash tests' downstream status assertions
pin the durable-evidence boundary transitively. No BLOCKER found. The main weaknesses
are (1) a status allow-list that contradicts the spec's own receipt vocabulary and is
a flakiness/change-detector risk, (2) crash tests that infer process death from a
receive timeout rather than verifying it, and (3) coverage that samples only 2 of the
~20 §4.3 rows, with the fixture's third halt point (`create_entry`) never exercised.

### Note on audited state (read-only observation, no action taken)

The brief described both files as uncommitted/new-modified in a dirty worktree. The
actual tree is clean: both files are committed (`git status --porcelain` empty).
`tests/tui_gateway/test_companion_creation_process_matrix.py` was added in
`826ef4b72c` and touched by `f8166a7def` ("drop unused imports");
`tests/tui_gateway/fixtures/companion_stdio_gateway.py` is entirely new in
`826ef4b72c`. The audit below applies to the file contents at HEAD.

---

## Q1. Falsifiability — per test

### Test 1: `test_duplicate_create_from_two_processes_yields_one_session_and_one_dispatch`
(test_companion_creation_process_matrix.py:120-183)

**Do the two processes actually race? Yes.** Both clients are fully spawned and have
seen `gateway.ready` before either send (test_companion_transport_integration.py:56-60).
Each request runs in its own OS process against the same `HERMES_HOME` state.db. Both
start with `existing is None` (companion_session_create.py:641-651), so both enter
`_create_session_in_workspace` and both call `_creation_request_index`
(companion_session_create.py:337-351), which serializes on `BEGIN IMMEDIATE`
(hermes_state.py:797-803, companion_creation.py:807-847). Exactly one process wins the
INSERT (companion_creation.py:823-828); the loser gets `(existing, False)` and returns
`_replay_receipt` (companion_session_create.py:352-353). This is a real DB-level race,
nondeterministic in who wins, and every assertion is winner-agnostic. Not a rigged race.

Concrete defects that would fail it:
- Double-create (loser enters creation anyway): `create_entry == 1`
  (line 161) fails. The counter sits on the product seam
  `server._invoke_reserved_session_create` called from the product saga
  (companion_session_create.py:416), so it proves the product ran, not the harness.
- Double dispatch / double build: `agent_build == 1` (line 162) fails. The build
  counter wraps `server._make_agent`, reached via `_start_agent_build`
  (server.py:1056).
- Duplicate ordinary row: `len(rows) == 1` (line 163) fails.
- Loser fabricating a usable runtime handle: `len(runtimes) <= 1` (line 183) fails —
  the reconcile path hard-codes `runtime_session_id: None`
  (companion_creation.py:490), so a fabricated non-null id in the loser's receipt
  would produce 2 distinct ids.

Weak/vacuous spots:
- **`len(runtimes) <= 1` cannot fail on the *winner's* side** — if a defect dropped
  the winner's runtime id (both receipts null), the set is empty and the assertion
  passes. It only falsifies the loser fabricating a handle. MINOR / HIGH.
- `assert any(... == "admitted")` (line 181) and the `allowed` set (lines 167-174):
  see Q3 — flaky change-detector, spec-contradicting.

### Test 2: `test_crash_before_submit_entry_recovers_as_not_admitted_with_zero_dispatch`
(lines 186-233)

**Concrete defect that would fail it:** a dead creator with a claimed pair and
phase `dispatching` must reconcile to `not_admitted` (§4.3 row "C dispatching, before
entering submit"; the settle happens in `_reconcile_creation_recovery`
companion_creation.py:560-573 via `settle_turn(..., "not_admitted")`). If recovery
misclassified (e.g. returned `recovery_required`, `interrupted_outcome_unknown`, or
`claimed`), line 220 fails. If recovery re-dispatched (agent_build increments), lines
210/233 fail. If the retry created a second row, line 229 fails. If a prewarm build
happened before admission (§10 R8 "no prewarm before admit"), line 210 fails.

**Boundary accuracy:** the halt fires inside the `_counted_submit_prompt` wrapper
(fixture lines 103-106) — i.e. at the entry of the registered `prompt.submit`, before
the product handler body runs. At that moment the durable state is phase=`dispatching`
(CAS'd at companion_session_create.py:456-463 before the submit call at 480) with the
pair still `claimed`. That is exactly §4.3 row "C dispatching, before entering
submit" (pair still claimed → dead: not_admitted). Genuine boundary. Two caveats:
- The test cannot distinguish this row from "Inside submit before admit" — the
  `submit_entry` counter fires under both interpretations, and both rows prescribe
  `not_admitted` on death. The test name ("before submit entry") is also a misnomer:
  the process dies AT submit entry (the event is recorded before `os._exit`). MINOR / HIGH.
- **Death is not verified as death.** `receive` raises `AssertionError` both on
  timeout ("timed out waiting for JSON-RPC frame", test_companion_transport_integration.py:102)
  and on detected exit (line 92-94). The tests use bare `pytest.raises(AssertionError)`
  (lines 200-203, 254-255) and never assert the process returncode, the "halt
  submit_entry" event line (fixture line 85 records it), or `_unreachable_call`'s
  captured message. A hang rather than a hard exit would still pass this half, be
  caught only 60s later by the downstream status assertions (a hung creator is
  "alive" → receipt would say `claimed`/`preparing`, failing line 220). So the
  boundary is proven, but only transitively and slowly. MINOR / HIGH.

Weak spot: the retry half (lines 224-229) is **partially vacuous** —
`if isinstance(retried, dict):` silently skips all assertions when the retry returns
an error envelope instead of a receipt. Per §1.4 a bound operation must return a
receipt (not_found only when no binding exists), so a regression making replay error
out (e.g. 5006) would pass vacuously as long as row count is unchanged. MINOR / HIGH.

### Test 3: `test_crash_after_admission_recovers_as_unknown_outcome` (lines 236-275)

**Concrete defect that would fail it — and this is the strongest test in the file:**
the halt fires inside the `_counted_make_agent` wrapper (fixture lines 114-117).
`agent_build` is only reachable after the durable admission: `prompt.submit` does
`admit_turn` (methods_prompt.py:971-977) *before* `_start_agent_build`
(methods_prompt.py:1014) → `server._make_agent` (server.py:1056). Therefore:
- If a build-before-admit ordering defect existed (admission not committed first),
  the halt would fire with the pair only `claimed`, reconcile would settle
  `not_admitted` (companion_creation.py:560-569), and the asserted
  `interrupted_outcome_unknown` (line 271) would fail. This test positively proves
  the §4.3 "Admitted, before build/thread" ordering, not just the outcome.
- `row_state == "present"` (line 273) falsifies row-loss/mis-observation defects.
- `submit_entry == 1` (line 262) falsifies a submit that was never entered or
  entered twice.

Caveats:
- The halt sits at build *entry* inside the build thread (server.py:1056 within
  `_build`, thread started at server.py:1076-1079), i.e. on the line between
  "Admitted, before build/thread" (§4.3) and "Build/thread started, before running
  write". Both rows prescribe `interrupted_outcome_unknown` on death, so the test
  proves the shared evidence class but cannot pin the individual row. MINOR / HIGH.
- Same unverified-death issue as test 2. MINOR / HIGH.
- Missing: no assertion that `receipt["runtime_session_id"] is None` (a dead creator
  must not be handed a runtime handle per §1.4), and no post-reconcile assertion that
  `submit_entry`/`agent_build` counts stayed at 1 — i.e. reconcile itself did not
  re-enter submit ("Recovery only observes/settles", §4.4). MINOR / MEDIUM.

### Test 4: `test_same_request_id_with_a_different_payload_is_refused` (lines 278-321)

**Concrete defect that would fail it:** payload conflict on an existing request key
must raise 4090 (§1.5 "immutable request conflict"; enforced at
companion_creation.py:138-141 via `hmac.compare_digest` on the digest). If the
product adopted the second payload, replayed, or created a new binding, then either
line 315 fails (no 4090), lines 318-319 fail (receipt shows adoption), or the final
invariants fail: rows unchanged (line 320) and `agent_build` count unchanged
(line 321) falsify any re-dispatch under the stolen key.

Caveats:
- The `else` branch (lines 316-319) is author-observed defensiveness: per the
  product path it is unreachable (the digest check always raises 4090 first), and its
  `operation_status != "admitted"` check would let an adoption that returned
  `running`/`completed` slip — only the row/agent_build invariants would catch that.
  NIT / MEDIUM.
- `first["result"]["operation_status"] == "admitted"` (line 294) has the same
  flakiness as test 1's allow-list (see Q3). MAJOR (shared) / MEDIUM.

---

## Q2. Launcher contamination

**Env-unset behaviour: clean pass-through.** With `HERMES_COMPANION_TEST_EVENTS_FILE`
unset, `_record` returns before opening anything (fixture lines 73-75). With
`HERMES_COMPANION_TEST_HALT_AT` unset, `_halt_if` is `None == "create_entry"` →
False (lines 83-86). The wrappers then call the captured originals with unchanged
signatures: `_counted_invoke_reserved_session_create(reserved, *, rid=None)` matches
the product call `server._invoke_reserved_session_create(reserved, rid=None)`
(companion_session_create.py:416); `_counted_submit_prompt(rid, params)` matches
`server._methods["prompt.submit"](None, {...})` (companion_session_create.py:480);
`_counted_make_agent(*args, **kwargs)` is transparent. The launcher is a test-only
child process; no production module is modified, so production behaviour is unaffected.

**Do the counters prove the product ran? Yes.** All three wrap module attributes that
the product saga resolves dynamically:
- `server._invoke_reserved_session_create` — called from the saga
  (companion_session_create.py:416).
- `server._methods["prompt.submit"]` — the saga dispatches through the method table
  (companion_session_create.py:480; registered via methods_companion_sessions.py:39).
- `server._make_agent` — split-module bodies are rebound onto server's globals
  (method_ctx.py:62-69, 100-127), so `_make_agent_in_context`
  (methods_session_create.py:296) and `_start_agent_build` (server.py:1056) resolve
  the patched attribute, not a stale import. This is the correct seam.
Chaining is also correct: `_agent_factory` is captured *after* the earlier
persistence wrapper is installed (fixture line 111 vs line 62), so the counted
wrapper wraps the persistent-synthetic wrapper; no earlier seam is bypassed.

**`os._exit` inside `submit_entry`/`agent_build` — is it the design's boundary?**
Mostly yes. §10 explicitly names exactly these counters ("external append-only test
counters for create entry, submit entry and fake-agent invocation") and requires
"crash at boundaries with actual process termination"; `os._exit(9)` is a real hard
exit (correctly skipping atexit, which is what a crash does). Durable state at each
halt matches §4.3 rows as analyzed in Q1 (`dispatching`/claimed for submit_entry;
`dispatching`/admitted for agent_build). Residual gaps:
- `HALT_AT=create_entry` is implemented (fixture lines 92-98) but **never used by
  any test**. The halt would land between the `preparing` CAS
  (companion_session_create.py:406-413) and the trusted create (line 416) — i.e.
  §4.3 "C preparing, before/during trusted create". That row (and everything
  earlier in the table) is unexercised despite the fixture advertising the point.
  MINOR / HIGH.
- The fixture stubs `_schedule_startup_orphan_sweep` (fixture line 126), so crash
  recovery is exercised only through the reconcile RPC; a production restart also
  runs the orphan sweep (session_reaper.py:373-381). The tests never show the sweep
  cannot disturb a crashed creation's durable state. MINOR / MEDIUM (the sweep is
  runtime/TTL-oriented, so risk is low, but it is an untested divergence between
  the test launcher and production startup).

**Could the wrappers mask a defect?** One theoretical hole: any code path that holds
a *direct* import-time reference to the original `_make_agent` (rather than resolving
`server._make_agent`) would build without being counted. `compute_host.py:314` uses
`server._make_agent` (counted); but `agent_callbacks.py:367` and `model_switch.py:278`
call a bare `_make_agent` whose binding I did not verify — if those are direct
`from ... import` references they are uncounted build paths. Neither is on the
create-saga path these tests exercise, so no current assertion is fooled. NIT / LOW.

---

## Q3. Assertions vs spec

**Behaviour-contract assertions (keep):**
- `create_entry == 1`, `agent_build == 1`, `len(rows) == 1` — §4.4 uniqueness
  (test file lines 161-163).
- `stored_session_id == rows[0]` — §1.4 "a bound operation always exposes its
  immutable reserved stored_session_id" (line 179).
- Test 2's `not_admitted` + `runtime_session_id is None` + rows unchanged — §4.3
  dispatching-death row and §1.4 runtime-handle rule (lines 220-221, 229).
- Test 3's `interrupted_outcome_unknown` + `row_state == "present"` — §4.3
  "Admitted, before build/thread: death ⇒ interrupted_outcome_unknown"
  (lines 271-273).
- Test 4's 4090 — §1.5 immutable request conflict (line 315).

**Change detectors / spec contradictions:**
- **MAJOR / MEDIUM-HIGH: the `allowed` set
  `{preparing, admitted, failed, recovery_required, not_admitted, not_found}`
  (lines 167-174) excludes `claimed`, `running`, and `completed` — all of which the
  spec explicitly defines as legal receipt statuses (§1.4: "`admitted`, `running`,
  `completed` ... come from the existing turn record"; `claimed` is in the status
  vocabulary at p4-current-design-v2.md:97-99). Both receipts are projected from a
  live turn: the winner's receipt is built after `prompt.submit` returns
  (companion_session_create.py:487-519), and the turn's `mark_running`
  (companion_turns.py:1796-1804, executed in the run thread started at
  methods_prompt.py:1015-1022) races the saga's observation. If `running` commits
  first, the winner's receipt says `running` → the test fails on healthy code.
  Likewise a delayed loser replay can legitimately observe `claimed`
  (phase preparing/prepared with an exact claimed pair — permitted by
  companion_creation.py:371-372) or even `completed` (0.6s turn done, index closed
  turn_record). This set encodes the author's observed common-case timing, not the
  contract, and is a flakiness source.
- Same class: `assert any(... == "admitted")` (line 181) and test 4's
  `== "admitted"` (line 294) assert a specific point in a spec-defined race window
  (admitted vs running). MEDIUM-HIGH flake risk on loaded CI.
- `not_found` in the allowed set is dead vocabulary: with the index bound, neither
  receipt path can return `not_found` (`_creation_not_found_receipt` only when the
  index is absent, companion_creation.py:212-213). Harmless, but signals the set was
  not derived from the reachable status space. NIT / MEDIUM.

---

## Q4. Missing coverage (this file + existing transport gate)

The transport gate (test_companion_transport_integration.py:229-373) covers
continuation flows only (MC-09/11/12/13). For creation, this matrix exercises only
two §4.3 rows end-to-end. Specifically untested in scope:

- **"C preparing, before/during trusted create"** — `HALT_AT=create_entry` exists in
  the fixture but no test uses it. Cheapest high-value addition.
- **"Reservation acquired, before C bind" / "C binding commit ambiguous"** — no halt
  point between the slot claim and the C insert (or none exists at all given the
  implementation binds C *before* claiming capacity — companion_session_create.py:337
  vs 354 — which itself sits in tension with §3.2 "Reserve real capacity before
  binding"; a process-level test of that ordering is absent).
- **"T preparation transaction interrupted" / "T pair committed, C still
  preparing" / "C prepared, before dispatch gate"** — no halt points; only the
  in-process suites (test_companion_session_continuity per design R5) touch these,
  outside this file's scope.
- **"Running or tool side effects, before settlement" for create** — MC-13 kills
  after admission for a *continuation*, never for a creation mid-run.
- **"T terminal, before C close"** (reconciler closes C/turn_record) — untested.
- **§4.4 "Competing delivery processes release their unused reservations"** — test 1
  proves the loser never enters creation, but nothing verifies lease/registry state
  after the race (moot under the current bind-before-reserve ordering, which is
  itself the spec divergence noted above).
- **§4.4 legacy-submit fence** ("a generic `prompt.submit` with no matching bound
  claim must refuse while the active lineage slot belongs to this creation") — no
  generic-submit race test in either file.
- **§4.4 "recovery ... no second creation/send"** — test 3 does not assert counters
  stay flat after its reconcile call (test 2 does; test 3 should too).

---

## Findings summary

| # | Severity | Confidence | Finding |
|---|----------|------------|---------|
| 1 | MAJOR | HIGH (mechanism) / MEDIUM (manifestation rate) | Test 1's `allowed` status set and tests 1/4's exact-`admitted` assertions exclude spec-legal statuses (`claimed`, `running`, `completed`) reachable by a genuine thread race (`mark_running` vs receipt projection); spec-contradicting change detector, flake risk. Lines 167-181, 294. |
| 2 | MINOR | HIGH | Crash tests never verify death: bare `pytest.raises(AssertionError)` conflates timeout with exit; "halt <point>" events and returncode are recorded but never asserted (lines 200-203, 254-255; fixture line 85). |
| 3 | MINOR | HIGH | `HALT_AT=create_entry` implemented but unused — §4.3 preparing/trusted-create rows untested despite advertised capability (fixture lines 92-98). |
| 4 | MINOR | HIGH | Test 2's retry half is partially vacuous: error envelopes skip all assertions (`if isinstance(retried, dict)`, lines 224-229). |
| 5 | MINOR | MEDIUM | Test 3 lacks `runtime_session_id is None` and post-reconcile counter-flatness assertions (reconcile must never re-enter submit). |
| 6 | MINOR | MEDIUM | Test 2's halt point cannot distinguish §4.3 rows "dispatching, before submit" vs "inside submit before admit" (identical durable evidence); test name says "before submit entry" but death occurs at the recorded entry. |
| 7 | MINOR | MEDIUM | Fixture stubs the startup orphan sweep, so production-restart recovery paths never run in these tests (fixture line 126). |
| 8 | MINOR | HIGH | Test 1's `len(runtimes) <= 1` cannot catch a missing winner runtime id (vacuous on the null-null case). |
| 9 | NIT | MEDIUM | Test 4's else-branch is unreachable per the product path and its `!= "admitted"` check would admit `running`/`completed` adoption statuses. |
| 10 | NIT | LOW | Uncounted `_make_agent` import bindings may exist in agent_callbacks.py:367 / model_switch.py:278 (not on the tested path). |
| 11 | NIT | HIGH | `import os` in the test file (line 12) is unused — despite f8166a7's stated purpose being to drop unused imports. |

## What I could not verify

- **I did not run the test suite** (CPU-busy constraint in the brief); all
  behavioural claims are from code reading, including the flakiness mechanism in
  finding 1 — the race window is proven structurally, its hit rate is not measured.
- `_CreationDirectoryGuard.open()` internals (companion_projects.py:414-415) —
  whether the workspace hold serializes the two processes beyond the C-bind; I
  read its invocation but not its lock implementation.
- The import bindings behind `agent_callbacks.py:367` and `model_switch.py:278`
  (finding 10).
- Whether `probe_pid_liveness` classifies the os._exit'd child as dead in the
  reconcile process — reasoning says yes (child reaped by `close()`'s wait), not
  empirically checked.
- The brief's "dirty worktree" premise: the tree is clean at `f8166a7def`; if the
  author intended uncommitted variants of these files, they were committed before
  this audit ran.
