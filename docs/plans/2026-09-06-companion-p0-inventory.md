# Hermes Companion P0 — Sanitized Baseline Inventory

**Recorded:** 2026-09-06
**Scope:** Read-only inventory. No service, database, configuration, credential, project, or session was mutated.

## Development baseline

- Worktree: `hermes-companion-worktree`
- Branch: `feature/hermes-companion`
- HEAD: `3708537fa85bd27b9f131594460c20defa5cc049`
- Existing untracked inputs before implementation: `IDEA.md` and the final development handoff.
- Feature branch is intentionally historical and highly divergent from the locally cached `origin/main`: 17 commits feature-only and 7,902 commits main-only; merge base `2d92793045432be06eedde29ff64743ead6ed240`.
- `apps/companion` does not exist on the cached `origin/main`; the current product is carried by the feature-only commit series.
- Upstream fetch was attempted but GitHub returned HTTP 429. Divergence values therefore use the locally cached `origin/main` and are not claimed as current upstream truth.

## Runtime and route

- Private Tailscale HTTPS serve is enabled and proxies through a localhost-only reverse proxy.
- The Atlas dashboard is listening on localhost; the reverse proxy is listening on localhost separately.
- No public bind or firewall/router mutation was made.
- The primary source checkout is on `main`, has two local commits, and was 79 commits behind its cached upstream reference at inventory time. It must remain the rollback baseline; do not replace it with this historical feature branch.
- A separate managed source checkout exists at a detached revision. No source checkout was changed.

## Authentication boundary

- The default and Atlas launch configurations expose dashboard OAuth and basic-auth configuration blocks; Atlas has an explicit work-owner allowlist.
- Other profile-local configuration blocks are not treated as independent owner authorities. Cross-profile reads and decisions must remain governed by the launch profile's authenticated owner policy.
- Configuration values, identities, tokens, client secrets, and redirect URIs were not printed or copied.

## Profile-local source coverage

| Profile | Persisted sessions | Human-facing by current deny-list | Desktop-origin rows | Named Desktop projects |
|---|---:|---:|---:|---:|
| default | 859 | 859 | 3 | 0 |
| atlas | 1,440 | 1,374 | 70 | 3 |
| hoffee-marketing-os | 0 | 0 | 0 | 0 |
| hoffeecmo | 58 | 47 | 0 | 0 |
| hoffeeoperator | 9 | 4 | 0 | 0 |
| hoffeeresearch | 17 | 17 | 0 | 0 |
| maven | 51 | 51 | 1 | 0 |
| mentor | 51 | 51 | 0 | 0 |

Notes:

- Counts are direct profile-local SQLite counts. They are inventory evidence, not authorization to expose every row.
- The current human-facing count excludes only `tool` and `kanban`, matching the existing session-list deny-list. Additional visibility/origin rules remain an implementation requirement.
- Atlas is the only profile with named Desktop projects in this inventory.
- Desktop-origin metadata exists in default, Atlas, and Maven. Older or resumed records with unknown/non-Desktop origin must remain visible under All and must not be inferred as Desktop-origin.

## Library coverage gate

- No `companion_library` configuration is currently present in the inspected profiles.
- Canonical output-root membership, file types, maximum sizes, and retained-evidence policy therefore remain an explicit configuration/acceptance gate.
- Implementation may provide the secure config contract and empty/update-required states, but must not invent or scan roots before an authorized allowlist exists.

## Baseline verification

- Companion renderer: 27 files / 267 tests passed.
- Companion TypeScript typecheck, ESLint, and production web build passed.
- Prescribed Python anchor suites: 5 files / 104 tests passed using `scripts/run_tests.sh` with `/Users/atlasweber/hermes/venv/bin/python` as `HERMES_PYTHON`.
- Initial Python wrapper invocation without `HERMES_PYTHON` correctly stopped because the worktree and managed-install venvs did not contain pytest.

## Implementation constraints confirmed

1. Develop and package in the isolated feature worktree; do not deploy it wholesale over the live `main` checkout.
2. Use additive capability-negotiated RPCs and preserve legacy session/project methods.
3. Keep project/session browsing read-only and side-effect-free.
4. Preserve profile/source IDs; never merge by title or path.
5. Keep owner authorization server-derived and rechecked per privileged call.
6. Do not claim Library coverage or physical Android acceptance until those external gates are supplied and exercised.
