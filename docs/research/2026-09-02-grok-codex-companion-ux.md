# Grok Bot + Codex UX synthesis for Hermes Companion

**Date:** 2026-09-02  
**Scope:** interaction mechanics, not visual imitation

## Recommendation

Keep Hermes visually distinct and borrow the shared operating model:

1. **Durable teammates and sessions** — agent identity, role, latest outcome, timestamp, explicit attention state.
2. **One-click navigation** — the whole session row opens the conversation; secondary actions remain isolated.
3. **Independent panes** — sidebar roster and transcript own separate scroll positions; the composer stays anchored.
4. **Progressive disclosure** — clean conversational result first, technical details on demand.
5. **Actionable attention** — distinguish approval/question/working/completed/failed rather than one generic activity dot.
6. **Deterministic responsive modes** — multi-pane desktop, one surface at a time on narrow windows, no horizontal overflow.

## Implemented in UX v4

- Full viewport shell with page scrolling disabled on desktop.
- Independently scrolling teammate rail and content area.
- Conversation route gives the transcript its own scroll owner and keeps the composer fixed.
- Automatic follow only while the reader remains near the bottom; a visible **Latest** control appears after scrolling upward.
- The whole session row opens that session; no separate **Resume** action.
- Pin/Unpin is a separate control and does not open the session.
- Conversation header shows the active session title and provides direct back navigation to its session list.
- Newly created/resolved Bot Chat is refreshed into the visible session list.
- Removed the inert Search navigation item rather than advertising a non-working control.
- Narrow mode collapses to one content surface plus bottom navigation, with no horizontal document overflow.

## Next high-value product increments

These need deliberate gateway/state work and are not simulated in the UI:

1. **Per-session draft and transcript-position preservation.** Switching sessions should return the user to the same reading point and draft.
2. **Small status vocabulary.** Map backend events to `Working`, `Needs input`, `Ready`, `Blocked`, and `Failed`; show the reason in the row preview.
3. **Compact progress row above the composer.** Current phase, elapsed time, pause/stop, and steer; detailed milestones remain expandable in-thread.
4. **Activity/Needs Me as an inbox.** Unread, running, approval-needed, and failed items with stable ordering while the user interacts.
5. **Queued follow-ups and mid-run steering.** Editable/cancellable follow-ups without inventing unsupported backend behavior.
6. **Global search only when real.** Search agents, sessions, messages, files, and links; deep-link to the exact transcript position.
7. **Optional task inspector.** Plan, sources, artifacts, commands, and last-turn evidence in a collapsible pane—not mixed into normal chat.

## What not to copy

- Short recent-chat lists that hide older sessions behind a separate history surface.
- Blind auto-scroll while the user is reading history.
- Hover-revealed side panels that collide with content or scrollbars.
- Generic spinners when the real state is awaiting approval.
- Raw tool traces as ordinary chat messages.
- Dense composer toolbars before the underlying capabilities exist.
- Ambiguous approval prompts without target, scope, consequence, and reversibility.

## Evidence

### Grok / Grok Bot

- Grok release notes: https://grok.com/release-notes
- Message and collaborate: https://docs.x.ai/grok-bot/chat-and-collaboration
- Create and manage Bots: https://docs.x.ai/grok-bot/bots
- Settings and notifications: https://docs.x.ai/grok-bot/settings-and-notifications
- Approvals, security, and privacy: https://docs.x.ai/grok-bot/approvals-security-and-privacy
- Grok Bot for iOS: https://docs.x.ai/grok-bot/mobile

### OpenAI Codex / current ChatGPT desktop work mode

- Product transition/current model: https://openai.com/index/chatgpt-for-your-most-ambitious-work/
- Original Codex app interaction model: https://openai.com/index/introducing-the-codex-app/
- Projects and chats: https://learn.chatgpt.com/codex/projects
- Long-running work and Goal mode: https://learn.chatgpt.com/codex/long-running-work
- Notifications and Activity: https://learn.chatgpt.com/codex/notifications
- Worktrees and Handoff: https://developers.openai.com/codex/app/worktrees
- Review pane: https://developers.openai.com/codex/app/review
- Desktop commands: https://developers.openai.com/codex/app/commands
- App-server lifecycle/events/approvals: https://developers.openai.com/codex/app-server
