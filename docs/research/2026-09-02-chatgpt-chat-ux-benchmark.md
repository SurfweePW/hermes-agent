# ChatGPT-informed chat UX benchmark for Hermes Companion

Date: 2026-09-02

## Verified product patterns

Primary source: OpenAI ChatGPT Release Notes
<https://help.openai.com/en/articles/6825453-chatgpt-release-notes-2026-05-17-OpenAI>

- Long conversations are progressively loaded rather than forcing the full transcript into the initial view.
- Conversations longer than five responses can expose a table of contents for scanning and jumping.
- Large pastes above 5,000 characters are converted into attachments to keep the composer clean.
- Conversation-only selection is intentionally supported so copying does not capture surrounding application chrome.
- Files stay attached to messages and are available through the composer/library rather than appearing as raw transport payloads.
- Connection interruptions are expressed as a clear state that can recover, not as repeated transcript content.

Secondary observation: current ChatGPT desktop/web layouts use a narrow centered transcript, compact right-aligned user surfaces, unboxed assistant responses, a persistent bottom composer, and progressive disclosure for long prompts/tool detail. Community reports confirm the expected contract for collapsed long messages: content remains immediately expandable and editable; collapsing is a presentation choice, never content loss.

## Translation to Companion

### Adopt

1. Centered 760–820 px reading column.
2. User bubble / unboxed assistant response distinction.
3. Multiline bottom composer with clear keyboard behavior.
4. Collapse known internal context-compaction payloads to a one-line system event with immediate expansion.
5. Hide transport metadata and represent attachments as attachment objects/chips.
6. Full history/session navigation in a dedicated list; do not duplicate messages in a permanent right rail.
7. Progressive disclosure for long user prompts and system/tool detail.
8. Preserve full assistant answers unless the user explicitly collapses them.

### Keep Hermes-specific

- Named teammates and canonical Bot Chat.
- Needs Me as an explicit approvals/questions/results inbox.
- Inline approval cards and honest connection/recovery state.
- Profile-specific recent sessions and pinning.

### Reject

- Raw Markdown punctuation as final rendering.
- Raw `[Name|id]`, local cache paths, or base64 payloads in prose.
- Three-column dashboard layout for the primary conversation.
- Activity rail that repeats the transcript.
- Oversized marketing headings inside routine work screens.
- Nested full-width buttons that squeeze session copy into a narrow column.
