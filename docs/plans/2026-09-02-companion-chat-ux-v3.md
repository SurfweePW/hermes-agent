# Hermes Companion Chat UX v3 Implementation Plan

> **For Hermes:** Use subagent-driven development for the implementation, then independently review and exercise the packaged app.

**Goal:** Replace the broken dashboard-like chat and session layouts with a calm, ChatGPT-inspired conversation experience that preserves Hermes-specific approvals and attention states.

**Architecture:** Keep the current gateway/store contracts. Add a presentation-only message normalization layer and progressive-disclosure components, simplify the desktop shell to a two-column navigation/content layout, and make the conversation a centered readable stream with a sticky multiline composer. Do not hide user-authored content permanently; compact only known internal/system payloads and long messages behind accessible controls.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Testing Library, Electron/Capacitor shared renderer.

---

## Product rules derived from the benchmark

- Use a single centered reading column (~760–820 px) rather than stretching messages across the app.
- User messages are compact right-aligned bubbles; assistant messages use the page surface with strong typography, not a second card stack.
- Keep the composer visually anchored at the bottom, multiline, auto-growing, and clear about Enter vs Shift+Enter behavior.
- Do not duplicate the transcript in a permanent right rail. Activity is state/attention, not a second copy of messages.
- Normalize transport metadata before display: leading Telegram `[Name|numeric-id]`, raw local image paths, and `data:image/...;base64,...` must not appear as chat prose.
- Render `[CONTEXT COMPACTION — REFERENCE ONLY]...` as a collapsed neutral system disclosure by default: “Earlier context was summarized”, a short explanation, `Show details`; expanded content remains accessible and can be collapsed again.
- Collapse other very long user messages after a sensible visual threshold with `Show more` / `Show less`; assistant answers remain readable by default.
- Render common Markdown structure (paragraphs, lists, emphasis, inline/fenced code, links) rather than raw asterisks/backticks. Prefer a small explicit renderer over adding a broad dependency if current needs are bounded.
- Recent sessions are full-width list rows with title, two-line preview, relative/locale time, pin icon, and a separate Resume action; no nested full-width button grids.
- Quick task is a proper stacked composer card, not unstyled inline form controls.
- At widths below 1180 px, keep one content column; at phone widths preserve 48 px targets and avoid horizontal overflow.

## Task 1: Add message presentation and disclosure tests

**Files:**
- Create: `apps/companion/src/features/conversation/message-content.tsx`
- Create: `apps/companion/src/features/conversation/message-content.test.tsx`
- Modify: `apps/companion/src/features/conversation/conversation.test.tsx`

**Steps:**
1. Add failing tests for context-compaction collapsed default and immediate expand/collapse.
2. Add failing tests ensuring Telegram sender metadata, raw image paths, and base64 image payloads are not displayed as prose.
3. Add failing tests for Markdown paragraphs/lists/emphasis/code/links.
4. Add failing tests for long user message `Show more` / `Show less` and short-message no-toggle behavior.
5. Implement the smallest typed parser/presenter that passes without `dangerouslySetInnerHTML`.
6. Verify with the targeted Vitest files.

## Task 2: Rebuild the conversation surface

**Files:**
- Modify: `apps/companion/src/features/conversation/conversation.tsx`
- Modify: `apps/companion/src/styles/app.css`
- Modify: `apps/companion/src/styles/tokens.css` only if semantic tokens are needed.

**Steps:**
1. Write tests for multiline textarea submission: Enter sends, Shift+Enter creates a newline, working/disconnected disables send.
2. Replace the single-line input with a textarea and accessible keyboard behavior.
3. Use the new message presenter for stored and streaming content.
4. Center the transcript, keep assistant content unboxed, use restrained user bubbles, and anchor the composer without covering content.
5. Preserve approval, uncertain, streaming, stop, and reconnect states.
6. Verify desktop and mobile overflow behavior.

## Task 3: Remove transcript duplication and repair shell hierarchy

**Files:**
- Modify: `apps/companion/src/app.tsx`
- Modify or delete usage of: `apps/companion/src/features/attention/activity-rail.tsx`
- Modify: `apps/companion/src/styles/app.css`
- Test: `apps/companion/src/app.test.tsx`

**Steps:**
1. Add a regression test that the main conversation is not duplicated in a permanent Activity transcript.
2. Make the desktop shell two columns: stable left navigation + flexible main content.
3. Keep status/attention within Needs Me and inline conversation state, not a global decorative rail.
4. Reduce oversized marketing headings inside the work surface.
5. Verify navigation still reaches teammates, conversation, Needs Me, and search.

## Task 4: Repair recent sessions and quick task

**Files:**
- Modify: `apps/companion/src/features/roster/teammate-details.tsx`
- Modify: `apps/companion/src/app.tsx`
- Modify: `apps/companion/src/styles/app.css`
- Add/update focused component tests.

**Steps:**
1. Add a failing recent-session test covering long title, long preview, pin, Resume, and no overflow-prone nested controls.
2. Build a semantic session row with bounded line clamps and separate actions.
3. Add a failing quick-task form structure test.
4. Rebuild quick task as a clear card with label, target selector, multiline text area, and full-size send action.
5. Verify keyboard and narrow layouts.

## Task 5: Full verification and release

**Steps:**
1. Run focused component tests.
2. Run `npm test -- --run`.
3. Run `npm run typecheck` and `npm run build:web`.
4. Run a fixture UI at desktop and narrow widths; inspect conversation, collapsed context, expanded context, recent sessions, and quick task.
5. Inspect the final diff and run `git diff --check`.
6. Commit the verified change.
7. Package macOS as a new `v3` artifact, verify signature, architecture, archive, and installed bundle.
8. Deploy to MacBook Air with rollback and verify the installed app matches the v3 package.
