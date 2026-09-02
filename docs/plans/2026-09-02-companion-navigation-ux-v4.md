# Hermes Companion Navigation UX v4 Implementation Plan

> **For Hermes:** Implement test-first, review independently, then package and deploy with rollback.

**Goal:** Make navigation and scrolling feel native: the teammate rail and active chat scroll independently, and a recent session opens with one click rather than a separate Resume action.

**Architecture:** Preserve all gateway/store contracts. Change only presentation and navigation wiring in the Companion renderer: bounded app shell, independently scrollable rail roster and chat transcript, direct session-row buttons, a compact profile/session hierarchy, and contextual conversation header.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Testing Library, Electron.

---

## Task 1: Independent scroll regions

- Modify `apps/companion/src/app.tsx` and `apps/companion/src/styles/app.css`.
- Add CSS contract tests proving the desktop shell is viewport-bounded, the rail roster scrolls independently, and conversation main content does not own transcript scrolling.
- Preserve page scrolling for Teammates, Needs Me, Search, Details, and Recovery.
- Preserve mobile safe-area behavior and verify no horizontal overflow.

## Task 2: Direct session opening

- Modify `apps/companion/src/features/roster/teammate-details.tsx`, its tests, and App wiring.
- Replace Resume with a large semantic session-open button; keep Pin as the only secondary action.
- Ensure clicking session content resumes the resolved session exactly once, while Pin does not open it.
- Simplify redundant Bot Chat/current conversation actions.

## Task 3: Orientation and conversation behavior

- Show the active session title in the conversation header when available.
- Add a clear route back to the selected teammate’s session list.
- Add follow-latest behavior that auto-scrolls during active conversation only when the reader is near the bottom; otherwise expose a Jump to latest control.
- Keep approval, streaming, stop, composer, and technical disclosures intact.

## Task 4: Research-driven polish

- Incorporate transferable interaction patterns from current Grok and Codex official/current materials without cloning brand styling.
- Prioritize thread-first navigation, compact hierarchy, visible status, direct action labels, and progressive disclosure.
- Remove exposed dead or redundant controls if they imply unsupported functionality.

## Task 5: Gate and deployment

- Run focused and full tests, typecheck, lint, web build, and diff checks.
- Exercise desktop and narrow fixture states, including independent scroll metrics and session click behavior.
- Independently review the diff.
- Package ARM64 macOS build, verify version/signature/architecture/checksum, install on MacBook Air with rollback, preserve app data, and verify the installed bundle and process.
