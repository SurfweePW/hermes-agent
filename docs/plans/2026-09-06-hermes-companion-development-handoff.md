# Hermes Companion — Final Product Specification and Development Handoff

**Prepared for:** Pawel Weber and the development team
**Version:** 1.0 · 2026-09-06
**Status:** Final recommended product contract for implementation. Not a deployment or test-pass certificate.
**Goal:** Give Pawel one private, cross-device place to prioritize business work, make bounded decisions, inspect deliverables, and find the projects and sessions already used in Hermes Desktop.
**Architecture:** Extend the narrow Companion client over the existing authenticated Hermes gateway. Reuse profile-local decision, project and session authorities; add only the missing organization metadata, read projections, prioritization and curated artefact access.
**Stack:** Existing React/TypeScript/Vite Companion and `@hermes/shared` transport; existing Python gateway and SQLite-backed stores. Existing Capacitor packaging is optional after browser acceptance. No Studio or Remotion runtime dependency.

> **Handoff rule:** This document supersedes the earlier Studio/Companion direction attachment and the intermediate product-direction manual where they differ. It is self-contained; development must not reconstruct requirements from chat. For Hermes-led implementation, load the subagent-driven-development skill before delegating work; verify each slice against this contract before proceeding. Do not commit, deploy or modify live services merely because this specification exists.

---

## 1. Final decision

**Build a narrow standalone Hermes Companion. Keep Hermes Desktop and Telegram as the conversation tools. Do not adopt Studio as the host for this release.**

Companion is a decision, work-discovery and deliverable-access client—not another agent runtime, chat product or project-management system.

Its promise:

> Open one private link on your phone or Mac. See what deserves your attention, understand why, make a precise decision, inspect the result, and find the original Desktop project or conversation without searching through unrelated chats.

### Locked decisions

| Area | Decision |
|---|---|
| Host | Standalone Companion, extending existing code |
| Primary destinations | Needs Me · Work · Library |
| Default work lens | Topic; Session and Project remain equally accessible alternatives |
| Desktop continuity | Required: discover persisted Desktop projects and sessions independently of proposals, tasks or files |
| Prioritization | Explainable Recommended ordering by evidence-adjusted business benefit, not message volume or task count |
| Conversation ownership | Existing Hermes session authority; no second transcript database or new composer |
| Preparation decisions | Existing profile-local WorkStore |
| Execution status | Existing task system; HOFFEE retains its `hoffee` Kanban board |
| External actions | Separate existing exact-action approval/operator policy; preparation consent never substitutes |
| Files | Curated authenticated index, safe previews and original downloads |
| Access | Private Tailscale HTTPS plus authenticated owner authorization |
| Distribution | Responsive browser first; reuse optional thin shells without a second UI |
| Notifications | Existing Telegram channel, canonical links and quiet digests |
| External session tools | Verified connector or explicit capture only; automatic Codex import is not a release requirement |

### Why Companion, not Studio

Both routes require custom founder-decision governance, topic/session/project relationships, business prioritization and protected evidence access. Companion already has the direct gateway client and decision contract. Studio would add another application/server and identity/runtime integration boundary without eliminating those requirements.

Studio's broader document workspace is the strongest capability sacrificed. Compensate with curated discovery, standard previews and original downloads—not a universal editor. This is an integration-scope decision, not a measured performance/cost claim or a licensing rejection. The user clarified non-commercial intent; no commercial quote or vendor contact is a prerequisite.

Reopen the host decision only if concrete implementation evidence establishes a required workflow that the narrow client cannot reasonably deliver. Do not run competing host pilots during this release.

## 2. Release scope and boundaries

### Required in the initial accepted release

- Owner sign-in and authorized cross-profile reads with explicit source coverage.
- Needs Me with revision-bound preparation decisions, comments, change requests, snooze and decline.
- Durable Topics and optional Project bindings, with independent grouping and filtering.
- Recommended ordering with explanations, evidence, overrides and stable review focus.
- **Work → Projects and Work → Sessions directories containing eligible source records even when they have no linked work.**
- Read-only session detail/history, with original source identity preserved.
- Verified projection of preparation handoff and execution progress.
- Library covering explicitly agreed canonical output collections, including evidence version retention.
- Real Android and Mac acceptance, including loss of connection and background recovery.
- Existing server work continues when the phone disconnects.

### Not part of this release

- New chat composer, mobile terminal, agent runtime, workflow designer, editable Kanban clone or administration console.
- Creating, deleting, renaming or resuming source sessions/projects from Companion. Read-only source browsing does not change Desktop's active project or session.
- Automatic scraping/import of arbitrary external conversation histories.
- Public sharing links, vendor cloud relay, new native push platform or full-text transcript indexing.
- Universal filesystem browsing, document editing or mandatory office conversion.
- Approve topic/project, bulk consent, generic Publish/Buy/Trade, or authorization inferred from chat comments.
- Ranking-triggered execution, automatic task claiming or changes to other agents' business priorities.

Existing broader Companion functionality is not to be deleted blindly. Preserve it while implementing the selected navigation; retire or hide superseded entry points only after regression checks. Preparation decisions must remain distinct from existing runtime tool approvals.

## 3. Literal user journey

1. On Android or Mac, connect to Tailscale and open Companion's private HTTPS address.
2. Authenticate as Pawel; network connectivity or an agent token alone does not authorize decisions.
3. Land on Needs Me, grouped by Topic and sorted Recommended.
4. Open the first relevant group, read Why here, inspect its question and exact evidence.
5. Comment, request changes, approve preparation, snooze or decline; wait for server confirmation.
6. Stay within the selected topic while reviewing related asks.
7. Open Work for truthful progress, or switch to Projects/Sessions to find work started on Desktop—even if it has no approval card.
8. Open a source session read-only, inspect its history and linked work, or open the original client where a verified link is supported.
9. Find finished outputs in the topic/project/session's Files section or global Library; preview or download the original.
10. Continue from the same canonical records on another device. Final external actions use their separate existing approval process.

### Actors and topology

| Actor | Role and requirement |
|---|---|
| Pawel | Required authenticated reviewer |
| Mac mini Hermes gateway/runtime | Required server-side execution and data access for the initial topology |
| Android/Mac browser | Required clients; no worker runs on the phone |
| Hermes Desktop | Existing project/session creation and conversation surface |
| Domain agent | Proposes/revises work within its existing authority |
| WorkStore and execution board | Separate decision and execution authorities |
| Curated file service | Makes approved output roots usable on mobile |
| Tailscale and owner authentication | Network reachability and separate application authorization |
| Telegram | Initial notification channel, not a substitute authorization ledger |
| Native Companion shell | Optional distribution convenience after browser acceptance |
| Codex/other tools | Optional source connectors or explicit captures |

**A Desktop window is not the data server.** Desktop connected to the Mac mini creates records on that connected backend. Those records must remain discoverable after the Desktop app closes. Work saved only to a different/offline Mac-local backend cannot appear magically: that backend must be explicitly connected and authorized, or its records explicitly migrated/imported. Show this boundary during onboarding.

The initial operational target is Pawel's authorized Mac mini profiles. Inventory the actual Desktop backend targets before implementation acceptance. If any required Desktop records live elsewhere, mark coverage incomplete until that source is connected or an explicit migration is approved; do not silently shrink the requirement. Do not merge databases or auto-copy credentials to solve topology.

## 4. Navigation and screen contracts

```text
Needs Me                    Work                         Library
  Topic / Session / Project   Topics | Projects | Sessions  Search + filters
  Recommended order           All work and source records  Preview / download
  Decisions + true blockers   Progress + read-only history Version + provenance
```

Use a concise mobile navigation bar and a desktop sidebar. Lists and detail content scroll independently where side-by-side. Opening a row opens its detail directly. Keep internal tool payloads and compaction records collapsed, expandable and outside the primary reading flow. Keyboard navigation, visible focus, labelled controls, touch usability and back navigation are release requirements.

### 4.1 Needs Me

Contains only due, unresolved decisions and genuine human-input blockers from authorized sources. It is not a feed of every session or agent message.

Every preparation card shows:

- The exact question and recommendation.
- Intended business benefit and Why here.
- What will be prepared, expected output and explicit exclusions.
- Evidence, confidence, cost, deadline and material risk where applicable.
- Owner, revision, server-confirmed status and freshness.
- **Approve preparation · Request changes · Snooze · Decline**, plus discussion.

Comments do not authorize work. Human-input blockers use input-specific controls or a link to the supported source workflow; do not disguise them as preparation approvals. Runtime permission requests and external-action approvals are different types, with different authority and explicit labels.

Verified urgent incidents/obligations appear separately from normal opportunity ordering. An agent-written Urgent label is insufficient.

### 4.2 Work → Topics

A topic is a durable subject/outcome such as Conversion improvements, Marketplace integration or Website translations. It is not a session, profile, folder or permission group.

Topic detail has **Overview · Needs Me · Work · Files · Sources**. Show objective, next useful action and verified status. Preserve selected focus after actions. Put safe filter/focus state in the URL.

Capture rules:

- Reuse an explicit topic binding when available.
- First capture from a focused session may seed a topic from its exact title; generic/mixed sessions require a meaningful suggested name rather than title-similarity merging.
- One primary topic per decision/task; related-topic references are allowed without copying the record.
- One session may contribute to several topics; several sessions may continue one topic.
- Preserve exact title-at-capture separately from current source title.
- Metadata corrections are auditable and do not change approval scope, task authority or access.
- No automatic topic is required merely to list a Desktop session or empty project.

A topic may have one primary business Project or none. Multiple Desktop workspace references may be related to a topic; they do not create multiple copies of it.

### 4.3 Work → Projects — source directory, not only a grouping

**Required behavior:** Show eligible persisted Desktop project records whether or not they have sessions, topics, proposals, tasks or files. Do not derive this list solely from WorkStore or project-associated decision cards.

Distinguish:

1. **Desktop project:** an authoritative, profile-local named multi-folder workspace. Preserve its source ID and current name.
2. **Business project:** optional Companion organization metadata for an initiative not represented by a Desktop workspace. This has a separate identity and visible type.
3. **Discovered repository:** a derived repository grouping returned by the existing project-tree service. Label it as such; do not pretend it is a user-created project or automatically promote it.

Prefer binding topics to an existing appropriate Desktop project rather than creating an equivalent business-project copy. Equal names or paths are not a cross-profile/source identity match.

Project row: name, type, source/backend/profile, last available activity, freshness, known session count and unique linked asks/work count. Unknown counts remain unknown; zero is used only after a complete authorized query.

Project detail: **Overview · Sessions · Topics · Needs Me · Work · Files**. Show authoritative session membership separately from topic/business organization links. An empty project says **No sessions yet**; absence of proposals says **No linked work yet**. Neither is an error.

Consume the same backend project-membership projection as Desktop. Existing workspace folder/git grouping belongs to that service; do not reimplement it in Companion or infer membership from a project name. If memberships change in Desktop, refresh the source projection while preserving historical provenance and explicit business bindings.

Source project names, archive state and membership remain read-only here. Companion organizational binding/pinning actions are explicitly separate and must not call source project activation or mutation methods.

### 4.4 Work → Sessions — source directory, not only captured provenance

**Required behavior:** List all eligible persisted human-facing Hermes sessions on configured authorized sources, including Desktop-started sessions with no topic, project, decision, task or deliverable.

- Default to all eligible human-facing sessions; provide an **Origin: Desktop** filter.
- Display current title, source/backend/profile, first/last activity where available, verified status or Status unknown, project membership and linked work.
- Preserve raw origin metadata. Do not classify an older or resumed record as definitely Desktop-created from title or use of the GUI alone. Unknown origin stays visible under All, with an explicit label.
- Separate created-in origin from later-opened-in surface if both are captured. A Desktop-only origin filter must explain legacy records with unknown origin rather than silently claim complete historical classification.
- A newly persisted zero-message session is eligible. A local unsent draft with no backend identity is not yet a saved session; say so rather than inventing a record.
- Defaults follow existing hidden/archive/internal-source visibility rules. Provide explicit Archived and authorized hidden-session views with clear labelling; hidden means excluded from shared lists, not globally public. Kanban/tool worker sessions do not flood the human conversation directory.
- Pagination/search must reach older records beyond recency caps. No arbitrary fixed limit may be presented as a complete directory.

Session detail: **Overview · History · Linked work · Files**. Read-only history must work for a persisted session after runtime restart and while another client is using it, without loading an agent, resuming execution, injecting a message, touching the system prompt or changing active Desktop state.

Show human/assistant content as the primary reading flow; internal events are collapsed and identified. Do not expose secrets, hidden reasoning or protected tool payloads merely because a database row exists. Use a reviewed safe presentation projection; attachments use authorized artefact access, never arbitrary local paths. Reading history does not automatically ingest every mentioned file into Library.

**Open original** is offered only for a verified client route on that device. On Android, the read-only view is the complete fallback; no Mac-only deep link is required to understand the session. Unsupported original links show the source reference and explain that continuation takes place in the existing conversation client. No fake success, blank new session or silently resumed agent.

### 4.5 Grouping, directories and filters

These are three different operations:

- **Directory:** selects the entity population—Topics, Projects or Sessions, including empty/unlinked records.
- **Grouping:** presents matching decision/task/file records by Topic, Session or Project without creating records.
- **Filtering:** narrows the selected population or linked records.

In Needs Me, Work's linked-item views and Library, support **Group by: Topic | Session | Project**. Use independent Collection, Project, Topic, Session and Status filters; Sessions additionally has origin/source visibility controls, Library type/date.

Filter logic: AND across dimensions, OR within a multi-select dimension. Show chips and Clear filters. Switching grouping preserves explicit filters; empty intersections say No matching items. Unfiltered directory navigation must not inherit an invisible Needs Me filter that hides unlinked projects/sessions.

Keep directory context and linked-work filters visibly distinct. A work-status filter intentionally excludes entities without matching work and is labelled; clearing it restores the complete eligible directory.

Each item has a primary originating session plus optional related sessions. Session grouping counts it once under the primary source; a session filter can match primary or related references and labels related matches. For Project grouping, use the primary topic's explicit project binding; if absent, a verified primary-source project binding may be used with its origin labelled. If several source projects are equally valid, use No primary project until explicitly assigned, not an arbitrary winner. Related links never inflate global counts.

Keep **No source session**, **No project** and **Unassigned topic** groups visible where applicable. Business collections, profiles and source backends are separate dimensions; moving a topic never grants access.

### 4.6 Library

Initial collections: Atlas operations, HOFFEE, NewHomeRated, Investments and shared deliverables. Actual profile/root membership must be explicitly configured and inventoried.

Provide title/metadata search, type/date filters, topic/session/project links, Markdown/image/PDF previews, sandboxed static HTML viewing and authenticated original downloads. Unsupported formats say **Preview unavailable—download original**. Office editing/conversion and universal full-text indexing are not prerequisites.

Files linked to reviewed decisions open the pinned reviewed version by default; Latest is an explicitly different version. Original downloads preserve meaningful filenames. On Android test the actual browser's Download/Open/Share behavior and background return.

## 5. Recommended ordering — business value first

**Needs Me and actionable Work default to Recommended. Library defaults to Recent. Projects/Sessions directories default to Recent activity so unlinked Desktop records remain easy to find; they also offer Recommended, where entities without assessed actions remain in a visible Unassessed/no linked action section.**

Available alternate sorts: Deadline and Recent for actionable work, and Name/Recent for source directories. Sorting, grouping and filtering remain independent.

### Assessment contract

Assess a distinct intended outcome—not every subtask as if it independently earns the entire benefit. Store objective/time horizon, expected benefit, supporting evidence, confidence, implementation cost/effort, Pawel attention, cost of delay/deadline, dependencies, downside/reversibility, author, timestamp and policy version.

Benefit can mean contribution profit, retention, qualified demand, useful capacity, strategic enablement or material loss prevention. Do not equate revenue to profit, add incompatible units or invent percentage/euro forecasts. Numeric claims need a baseline, units, assumptions and cited evidence; otherwise use qualitative bands or Unknown.

### Deterministic policy v1

1. Surface verified urgent protection/obligation alerts separately. They do not grant permission.
2. Select eligible next actions: due unresolved asks in Needs Me; actionable next steps in Work. Snoozed/declined/completed records cannot be promoted back into the queue by ranking.
3. Partition ordinary work into assessed actionable opportunities, Potential requiring bounded validation, and Needs assessment. Unknown is not Low. All sections stay discoverable.
4. For assessed actions use evidence-adjusted benefit bands High, Medium, Low against the relevant business objective. Inside a band compare verified cost of delay, confidence, dependency-unblocking value, lower remaining resource/attention burden, then safer reversibility. Stable canonical identity is the final tie-breaker.
5. A high-upside but low-confidence hypothesis gets a bounded validation next step; do not portray the eventual launch benefit as already demonstrated or approved.
6. Rank a visible Topic/Session/Project group by its highest-ranked eligible action in the filtered result. Never sum task scores. Splitting tasks or adding source links must not improve rank.
7. Across incomparable businesses use labelled business sections, ordered by Pawel's explicit business focus where available; otherwise stable names. Do not manufacture a universal financial score. Explain that recommendations are relative to each business objective.
8. Permit **Pin for this review**, **Set priority with reason** and **Restore recommended**. Persistent overrides record actor/reason/review-or-expiry data, remain visually labelled, and cannot bypass eligibility or hide urgent alerts. Review pins are separate from Desktop's source pin state.

Use a shared benefit/confidence rubric with examples against configured business objectives. Development must encode ordered enums for delay/confidence/dependency/burden/reversibility, handle Unknown explicitly and version the rubric; agents supply structured assessments, not hidden arbitrary weights. No model call on render. Objective thresholds need Pawel/domain evidence; until supplied, show qualitative/provisional coverage, not fake calibrated ROI.

Every recommended group/action explains **Why here**, benefit, confidence, next step and main trade-off, with assessed-at and evidence links. Ageing thresholds/review cadence are configured settings, not secret environment variables.

Freeze the list during an open review. Material updates offer **Updated priorities available**; apply on refresh. Urgent alerts can surface without changing selected focus. Rank changes are advisory metadata only and never create/revoke approval, claim a task or write externally.

## 6. Data authority and identity contracts

### One authority per fact

| Fact | Authority |
|---|---|
| Proposal revision, comments, preparation decisions, snooze | Profile-local WorkStore |
| Desktop project identity/name/folders/archive | Existing profile-local `projects.db` service |
| Persisted session/history/lineage/source metadata | Existing profile-local SessionDB and gateway projections |
| Desktop project-session membership | Existing authoritative backend project-tree resolver |
| Business topics/projects and explicit links | One durable organization metadata registry; reference source identities, do not mirror source authority |
| Outcome assessment and override | Versioned advisory metadata, separate from consent payload |
| Task owner/lifecycle/result | Existing execution tracker |
| Exact external-action consent | Existing domain approval ledger/operator policy |
| File bytes and retained reviewed versions | Canonical artefact storage |
| File discovery metadata | Rebuildable curated index, not an access authority |
| Notification delivery | Receipt only, never decision state |

### Logical records to implement

These are proposed contracts, not claims that schemas or methods already exist. Extend established services where possible. Do not introduce a second general project/session manager.

| Record | Required contract |
|---|---|
| Source namespace | Stable configured backend identity plus exact profile; connection URLs are not durable identity or credentials |
| SourceProjectRef | Namespace, original project ID, kind; current name/archive/membership are source projections |
| SourceSessionRef | Namespace, persisted session ID, lineage/root reference and resolved current tip; live runtime ID is optional transient data |
| Capture | Stable capture ID, source ref where known, exact title-at-capture, captured-at, optional verified deep link |
| Topic | Stable ID, collection, name/objective, optional primary project ref, lifecycle and version |
| BusinessProject | Stable organization ID, collection, name/objective, distinct from SourceProjectRef |
| WorkBinding | Namespace plus canonical card/task/artefact ID, primary topic/source, related references, attribution and version |
| OutcomeAssessment | Stable outcome ID, structured inputs, evidence versions, author/time/policy and next-action references |
| PriorityOverride | Target ref, mode, actor/reason, created-at and expiry/review metadata |
| ArtefactVersion | Stable artefact/version IDs, owner/collection, safe root-relative locator, type/size/fingerprint, retained bytes reference and links |

All cross-source keys and routes preserve backend + profile + source ID. Within a single gateway, existing WorkStore requests continue using exact profile/card ID. Never coalesce equal titles or IDs from different namespaces. Local capture IDs for unknown external sources must be visibly local, not invented provider session IDs.

Compaction/continuation may change a resolved session tip. Keep captures bound to their original source plus explicit lineage so repeated listing does not create duplicate logical conversations. Never substitute a transient runtime session ID for a persisted ID.

Source rename updates the directory's current label while historical capture titles remain unchanged. Archive/deletion of source records does not delete proposals, topics, decisions or retained evidence. Show an archived/unavailable source reference; distinguish unavailable, not found and forbidden without leaking unauthorized metadata. Only a complete successful listing may reconcile absence; a timeout or missing page must not tombstone records.

Organization metadata is durable, version-checked and auditable. Cross-profile topic links never bypass the target's access policy; unauthorized titles/counts must not leak through joins, search, ranking or error messages.

## 7. Gateway and synchronization requirements

Reuse existing authenticated transport and profile routing. Do not add new always-on model tools for capabilities served by the client/gateway. Keep per-conversation prompts/toolsets/history stable.

### Verified current interfaces and their limits

| Existing surface | What the inspected source establishes | Required integration work |
|---|---|---|
| `projects.list`, `projects.get` | Profile-local named project reads exist | Validate auth, empty projects and archived coverage; use authoritative list as directory base |
| `projects.tree` | Backend project/repo/lane overview with preview sessions | Reuse membership; response is bounded and can mix discovered repositories with named projects |
| `projects.project_sessions` | Hydrated project drill-in | Current implementation has a session cap and excludes discovery-only tier; empty/discovered detail must not be misrepresented as missing |
| `session.list` | Human-facing persisted sessions, current title, source, timestamps, optional resolved ID | Normal list is recency-capped, has no cursor/completeness envelope, and archive flags are not uniformly handled across paths |
| `session.history` | History read through an existing runtime-session lookup | Not sufficient by itself for side-effect-free browsing of arbitrary persisted records |
| `session.resume` | Existing conversation-resume surface | Do not use as a browse-only substitute |
| Companion `WorkGateway` | Capabilities/list/detail/decision/comment with versioned requests | Retain contract and validators; add organization/evidence projections without weakening it |

### Required read contract

Provide additive, capability-negotiated persisted browsing through existing services. Final method names are implementation choices, but these semantics are mandatory:

- List named projects with an honest completeness boundary; fetch project detail without requiring a session.
- List/search eligible persisted sessions with bounded cursor pagination, stable ordering, authorized filters and explicit archive/hidden behavior.
- Read persisted history by canonical source identity with pagination and a safe user-facing projection, without runtime activation.
- Return accurate per-source availability and freshness. Each listing needs equivalent fields to `items`, `next_cursor`, `has_more`, `snapshot/as_of`, `coverage` and `warnings`; a total is optional and only present if exact for the authorized filtered population.
- Cursor traversal under concurrent inserts/renames must not silently duplicate/drop existing records. Prefer a stable snapshot or documented keyset semantics with a refresh boundary; clients deduplicate canonical identities.
- Extend existing project membership resolution for complete drill-in rather than computing a competing tree client-side.
- Unsupported old backend returns **Backend update required for complete browsing**, not an empty directory. Partial recency fallback may be shown only with a visible coverage warning and cannot satisfy full release acceptance.

### Refresh behavior

- Initial fetch after sign-in; refresh on foreground/reconnect and explicit refresh.
- Reuse existing change events where available; otherwise bounded polling while visible, configurable and paused in background. No per-render filesystem scan or model call.
- Target: new persisted Desktop records appear within 30 seconds while Companion is foreground and the source is healthy; explicit refresh shows the latest committed data on a successful response. This is a proposed acceptance target, not a measured current result.
- Directory refresh may update data but must not steal focus or reorder an active Recommended review.
- Mark last successful sync and per-source failures. A failed profile cannot turn an all-business total into a complete zero.
- Keep sensitive response caches owner/source scoped. On logout or authorization loss, remove accessible cached sensitive views and drafts according to the reviewed client policy; do not leave stale content visible behind a sign-in overlay.

## 8. Decision, execution and failure semantics

Preserve the existing WorkStore action contract, optimistic version checks and idempotency. Client validation or a displayed actor name never grants authority.

| User action/event | Required effect | Forbidden implication |
|---|---|---|
| Approve preparation | Revision-bound server decision for the stated preparation scope; idempotent handoff eligible | Publish, purchase, trade, claim worker is running |
| Request changes | Current proposal awaits revision; prior discussion/evidence retained | Silently edit an approved scope |
| Comment | Durable discussion, clearly attributed | Consent or automatic state transition |
| Snooze | Hide due ask until selected time | Cancel a running task or approve anything |
| Decline | Close the question; regenerated material must not resurrect it | Delete evidence/history or imply task cancellation |
| Open project/session/history | Authorized read only | Activate project, resume agent, insert message or change prompt |
| Rename/group/pin topic | Organizational/advisory metadata change | Source mutation, expanded access or execution authority |
| Phone disconnects | Unrelated server work continues | Implicit approval, cancellation or rerun |

### Truthful progress labels

The existing WorkCard `in_progress` state begins at preparation approval. Never display it alone as evidence of running work.

- **Approved — task linking pending:** durable approval, no verified task link.
- **Linked — awaiting triage:** destination task linked, not yet started.
- **Preparing:** execution tracker confirms active work.
- **Prepared:** completion and result evidence are available.
- **Blocked / Status unavailable:** tracker-backed blocker or last known state with freshness, not invented progress.

Prepared is not Published. A finished preparation task is not proof of achieved business benefit.

After a decision timeout, fetch the canonical card/receipt before retrying. Retry only the same request with its original idempotency key; changed payload/revision requires a new review. Never queue offline approvals for later silent submission. Unsent comments may be retained locally with an explicit unsent label and privacy controls.

One verified logical task per approved handoff requires destination atomic idempotency plus reconciliation. A created-but-unacknowledged task remains visible for reconciliation; do not create another task to hide an uncertain result. Proposal revision/revocation is not cancellation of already-started work; no universal Stop/Undo without a verified tracker contract.

## 9. Security and evidence boundaries

- Private HTTPS over Tailscale is necessary, not sufficient. Enforce authenticated owner/source/profile authorization on every read and mutation, including downloads, history, WebSocket calls and cross-profile joins.
- Agent/server tokens cannot decide; owner credentials are not exposed to agents. Owner authentication is separate from model-provider OAuth.
- Server parses sensitive policy fail-closed, including after malformed config or revocation on an already-open connection. A client route, pin or local cached capability cannot grant permission.
- WorkStore currently trusts OS-level database access. Do not advertise isolation from an agent that can write the same database/read owner credentials. Stronger claims require real process/filesystem credential isolation and a security acceptance test.
- Artefact roots are explicit allowlists. Resolve symlinks/canonical paths before enforcing boundaries; prevent traversal and check the actual opened object/version, including replacement races.
- No mounting the full home directory, `.hermes`, configuration or credentials. History attachment references are not authorization for arbitrary file reads.
- Downloads remain authenticated; no bearer tokens in shareable URLs, logs or copied provenance links.
- HTML is untrusted: use sandboxed static rendering without app-origin privileges, unsafe scripts or unrestricted network access. Office/macros and other active formats do not execute in the application.
- Retain immutable reviewed evidence or an equivalent retained version. A hash without retained bytes does not satisfy replay/restore. Changed bytes behind one filename cannot inherit old consent.
- If files move/disappear, show an unavailable mapping. Never silently open a different latest report under an old approval.
- Backups/restore cover source references, organization metadata, decisions and retained evidence together in isolated storage; do not overwrite live data during tests.
- External publication, sending on Pawel's behalf, spend and financial transactions retain existing human gates/red lines. This specification grants none of them.

## 10. Operating policy to reduce overload

Agents continue routine already-authorized work; do not require a card for every research step. Needs Me is reserved for genuine judgment, new gated scope, missing input or a material blocker.

One independently actionable decision per card; related material is bundled under its topic. Stable semantic source keys prevent regenerated reports becoming duplicate questions. Revised proposals explain what changed. Declined questions remain closed; genuinely new circumstances get a linked successor.

Outputs go to Library without automatically creating an approval request. Notification digests group by topic and preserve originating session titles. Reuse an agreed cadence; configuring a new external delivery schedule is a separate authorized operation. Verify batch and per-card receipts—per-card receipts alone do not enforce one digest batch per day.

Browsing a Desktop session does not create tasks, topics or notifications. Capture/linking is an explicit workflow. No retroactive model scan of all histories is needed merely to populate directories.

## 11. Simple user manual

These workflows describe the target product, not a claim that the screens are already deployed.

### A. Decide what matters today

1. Open Needs Me with **Sort: Recommended**.
2. Check any verified urgent alert, then the first relevant business/topic.
3. Read **Why here**, confidence and the next action.
4. Open its card and evidence; make one precise decision.
5. Continue in the same topic. Pin it for this review if useful.

**Result:** you prioritize business benefit without bouncing between unrelated conversations. Work with missing evidence remains visible in Needs assessment.

### B. Find a project created on Desktop

1. Open **Work → Projects**.
2. Select the correct source/profile or search the project name.
3. Open the row; choose **Sessions**, **Topics**, **Work** or **Files**.
4. An empty project shows No sessions yet; you do not need to create a proposal to make it visible.
5. If it is absent, clear filters and check source coverage/last sync. A project saved to an unconnected local backend needs that source connected, not a duplicate project.

**Result:** the same authoritative Desktop project, not a renamed Companion copy. Merely opening it does not change Desktop's active workspace.

### C. Find a session started on Desktop

1. Open **Work → Sessions**.
2. Use **Origin: Desktop**, source/profile or title search. Use All if an older session's origin is unknown.
3. Open the session, including one with no linked work.
4. Read **History**, then inspect **Linked work** or **Files** where present.
5. Use **Open original** only where supported; otherwise continue later in Hermes Desktop using the displayed reference.

**Result:** readable persisted conversation context on the phone. Opening it does not start/resume an agent or create another conversation.

### D. Start new work

1. Describe the desired outcome and constraints to Atlas/the responsible agent in the existing conversation tool.
2. The saved session appears in Companion without needing a card.
3. The agent performs already-authorized work or creates a bounded proposal if judgment/approval is needed.
4. Captured work links to the appropriate topic and original session.

**Result:** one conversation authority, one decision identity, no compulsory project/topic bureaucracy before starting.

### E. Approve preparation

1. Open the card and read the exact scope and exclusions.
2. Inspect evidence and the change summary if revised.
3. Choose **Approve preparation**.
4. Wait for server confirmation; check whether the task is linking, in triage or actually preparing.

**Result:** permission for stated preparation only. No publication, Shopify mutation, purchase or financial transaction.

### F. Discuss, change, postpone or decline

- Write a comment for discussion; it is not consent.
- Choose **Request changes** if the current proposal must be revised; review its new revision again.
- Choose **Snooze** and a time to defer an unresolved ask.
- Choose **Decline** to close the question, optionally with a reason.

**Result:** prior history is retained; snooze/decline are not fictitious cancellation controls for already-running tasks.

### G. Focus on one subject or change perspective

1. Open **Work → Topics → Conversion improvements**.
2. Review its Needs Me, progress and Files without leaving the topic.
3. Use Sources to identify contributing sessions.
4. Switch linked-item **Group by** to Session or Project when that is how you remember the work.
5. Check active filter chips; clear them to broaden the view.

**Result:** the same decisions/tasks/files from different angles, without duplicate counts or approvals.

### H. Find, download and share a result

1. Open Files in the relevant topic/project/session, or global Library.
2. Search/filter; open the preview or **Download original**.
3. For decision evidence, confirm the reviewed version; Latest is separate.
4. Use Android's own Open/Share action for the downloaded file.

**Result:** no Mac path copying. Sharing is your action, not authorization for an agent to send files.

### I. Continue on another device or recover connectivity

1. Open the same Companion link on the other device and sign in.
2. Follow the topic/card/session URL to the same canonical record.
3. After a connection failure, let server state refresh before retrying a decision.
4. If the outcome is uncertain, wait for reconciliation; do not duplicate the proposal/task.

**Result:** same server-confirmed decision/history. Local comment drafts and review preferences are not promised to synchronize automatically.

### J. Authorize a final external action

1. Inspect the prepared result.
2. Follow the existing exact-action approval workflow when available.
3. Review actual payload, destination, timing and permitted scope.
4. Approve through its authenticated human gate; the authorized operator verifies the external result.

**Result:** preparation consent never becomes publish/spend authority. No generic trade capability is introduced.

## 12. Engineering entry points and implementation order

### Inspected baseline

Source inspection was against `feature/hermes-companion`, HEAD `3708537fa8`. `git status --short` showed untracked `IDEA.md` before this document was written. No product code, live database, credentials or deployment was changed during this finalization. Recheck live runtime/client provenance before implementation/deployment; do not deploy this historical branch wholesale over a newer runtime.

Existing source locations (line anchors are navigation aids, not stable API promises):

| Path | Responsibility |
|---|---|
| `apps/companion/package.json:10` | Actual test/typecheck/lint/build scripts and installed stack |
| `apps/companion/src/gateway/companion-client.ts:1` | Existing shared gateway client integration |
| `apps/companion/src/gateway/types.ts:21` | Explicit live versus stored session IDs; existing list types |
| `apps/companion/src/gateway/work-types.ts:1` | Work states, actions, preparation scope and response validation |
| `apps/companion/src/features/work/work-inbox.tsx` | Existing decision presentation; extend after reading current implementation |
| `apps/companion/src/features/work/work-store.ts` | Existing decision UI state |
| `apps/companion/src/state/companion-store.ts` | Existing client state; avoid expanding into a monolith |
| `hermes_cli/companion_work_store.py` | Existing durable preparation-decision contract |
| `hermes_cli/projects_db.py:1` | Per-profile named projects and documented folder membership semantics |
| `tui_gateway/server.py:12713` | Existing `projects.list` and adjacent project methods |
| `tui_gateway/server.py:13221` | Calls the authoritative project-tree builder |
| `tui_gateway/methods_config.py:117` | Project overview and bounded drill-in handlers |
| `tui_gateway/methods_session.py:164` | Recency-capped persisted session listing |
| `tui_gateway/methods_session.py:2746` | Current runtime-session-bound history read |
| `apps/desktop/src/store/projects.ts:35` | Desktop consumes gateway project authorities; UI stores are caches |
| `apps/desktop/src/app/session/hooks/use-prompt-actions/submit.ts:563` | Desktop source parameter on an existing submission path; not proof of all legacy origins |

Read applicable `AGENTS.md` and exact neighboring implementation before editing. Prefer feature-owned state/actions, existing shared transport, and small read adapters. Do not copy Desktop Electron/store dependencies into the web client. New gateway capabilities are additive and session-surface aware; no cache-breaking core tool expansion.

### Sequenced work packages

Each package is a vertical deliverable, not a time estimate. Split implementation into small test-first steps: reproduce the missing behavior, run the failing behavior test, make the minimum change, rerun targeted tests, then exercise the real integrated path. Code examples and final new file names belong in the package's implementation PR after tracing current symbols; do not guess APIs from this product contract.

| Package | Dependencies | Implementation focus | Exit evidence |
|---|---|---|---|
| P0 — Baseline and contracts | None | Inventory actual Desktop source/profile topology and output roots; verify live branch/capabilities/auth boundary; record gaps | Source coverage inventory, sanitized fixtures, agreed target matrix, no live mutation |
| P1 — Complete persisted source reads | P0 | Extend existing session/project read services with pagination/completeness, safe persisted history and visibility rules; preserve authoritative memberships | Older/empty/unlinked records reachable, restart-safe read, no runtime/project activation |
| P2 — Organization and bindings | P0 | Durable topic/business-project/source bindings, canonical identities, capture titles, corrections, migration and export/restore | Rename/lineage/cross-profile/duplicate-title invariants; no copied source authority |
| P3 — Work directories and navigation | P1, P2 | Projects/Sessions/Topics directories, read-only detail/history, filters, safe URLs, partial/error/empty states | Desktop-created records visible without linked cards on both clients |
| P4 — Decision/evidence loop | P0, P2 | Retain WorkStore semantics; versioned evidence service; truthful triage/execution projection; per-card revision and retry handling | One complete HOFFEE preparation loop, two clients, exact evidence, one task, restart recovery |
| P5 — Prioritization | P2, P3, P4 | Structured assessment/rubric, deterministic sorter, explanations, overrides, focus-safe refresh | Benefit/eligibility/anti-inflation/stability fixtures and no ranking side effects |
| P6 — Library and coverage | P3, P4 | Explicit root inventory, safe previews/downloads, cross-business discovery and retained evidence restore | Every inventoried category tested; access/traversal/unsafe-content failures denied |
| P7 — Operational acceptance | P3–P6 | Physical Android/Mac workflows, topology loss, background recovery, notification receipts, migration/rollback rehearsal | Acceptance matrix evidence, operator manual, known limits, no unverified Done claims |

P1 and P2 may run independently after P0. Do not postpone source directories until after a card-only MVP and call the user's Desktop requirement delivered. P4 may begin independently of completed directory UI once its contracts exist. Ordinary backend-independent work continues while waiting for phone-specific acceptance.

### Test commands and ownership

Use existing suites as anchors; add behavior coverage in the owning suites/new focused tests, not source-text assertions.

- Python: `scripts/run_tests.sh tests/hermes_cli/test_companion_work.py tests/hermes_cli/test_projects_db.py tests/tui_gateway/test_projects_rpc.py tests/tui_gateway/test_project_tree.py tests/tui_gateway/test_companion_attention.py`
- Add the new persisted-browsing/organization/security tests to the runner invocation when created. Existing suites alone cannot prove new contracts.
- From `apps/companion`: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build:web`.
- Run relevant Desktop regression tests if shared gateway/project/session behavior changes, plus applicable broader repository checks.
- Use temporary `HERMES_HOME` and isolated fixture files/accounts for integration/security/restore tests. Never test against private production profiles or publish/spend as a side effect.

Expected outcome is a clean exit and behavior evidence, not a fixed test count. A flaky retry is a defect to investigate. These commands are prescribed for implementation; they were not run as application validation during documentation finalization.

## 13. Acceptance matrix — required before calling the release done

All rows require recorded real test output or device evidence. A mock, screenshot, code path, commit or generated video alone does not prove end-to-end acceptance.

| ID | Scenario | Pass condition / forbidden outcome |
|---|---|---|
| AC-01 | Create a named Desktop project with no session | Appears in Projects; opens as empty; no proposal required; no duplicate project |
| AC-02 | Start/persist a Desktop session with no work card | Appears in Sessions with correct namespace/title and membership; no topic/task manufactured |
| AC-03 | Persist a zero-message session; leave another as local draft | Saved record appears; unpersisted draft is not falsely listed as saved |
| AC-04 | Close Desktop and restart gateway | Projects/saved history still browse; no agent activation needed |
| AC-05 | Same names/IDs across profiles/backends | Distinct canonical records and correct authorization; no title-based merge |
| AC-06 | More sessions than legacy recency/drill-in caps | All eligible records reachable through complete pagination/search; honest has-more/count semantics |
| AC-07 | Concurrent insertion/rename during paging | Defined snapshot/keyset behavior, no silent loss/duplication of pre-existing eligible records |
| AC-08 | Hidden, archived, internal and unknown-origin records | Visibility filters honoured; archived/authorized hidden views explicit; unknown origin not erased; worker noise excluded |
| AC-09 | Rename or compact a source session | Current title/tip refresh; capture title/identity/history preserved; no duplicate logical conversation |
| AC-10 | Change Desktop project membership | Same authoritative resolver result; no frontend folder/title heuristic; business bindings remain explicit |
| AC-11 | Empty named project versus discovered repo | Types remain distinct; empty detail not misreported as missing; repository not promoted automatically |
| AC-12 | Source/backend offline or old protocol | Per-source incomplete/update-required state; no false complete zero or disappearance tombstones |
| AC-13 | Browse persisted history during live work | Safe read only; zero prompt/message mutations, resume calls, project activation or worker starts |
| AC-14 | Unsupported original link on Android | Full read-only fallback; no fake success or new blank session |
| AC-15 | New source record under healthy foreground connection | Visible within proposed 30-second target; explicit refresh returns latest committed state |
| AC-16 | Group/filter combinations and unlinked directories | AND/OR semantics, chips, direct URL and clear behavior; unlinked records visible by default |
| AC-17 | Related session/topic/project links | Unique global counts, primary grouping, related labels; no copied decision/task/permission |
| AC-18 | Recommend high supported benefit versus easy trivial task | Supported material benefit wins within same objective; explanation cites assessment |
| AC-19 | Missing/low-confidence/blocked assessments | Unknown visible, Potential gets validation, blocked next step not presented executable |
| AC-20 | Split tasks or add source links | Group rank/counts do not inflate; no double-attributed outcome benefit |
| AC-21 | Snoozed/closed items, urgency, overrides | No eligibility bypass; evidence-based urgent section; overrides attributed and reversible |
| AC-22 | New assessment during open review | Offer refresh, preserve selected group; no per-render model calls or rank-triggered writes |
| AC-23 | Two clients decide same/newer revision | Version/revision checks hold; stale request rejected, canonical state consistent |
| AC-24 | Timeout/retry/restart across task handoff | One verified logical task or explicit reconciliation state, never duplicate execution |
| AC-25 | Approval and tracker lifecycle | Linking/triage/preparing/prepared truthfully distinct; no implied publication |
| AC-26 | Request changes, snooze, decline, regenerated report | Correct durable state/history; no resurrection or consent-by-comment |
| AC-27 | Owner logout/revocation/wrong profile/agent token | Read/write/download denial as applicable, including open connections and cached views; no metadata leak |
| AC-28 | Traversal/symlink/replacement race/unsafe HTML | Access outside authorized roots and application-origin script privilege denied |
| AC-29 | Reviewed file overwritten/moved | Retained exact reviewed bytes remain available or explicit unavailable state; never substitute Latest |
| AC-30 | Every agreed Library collection/type/large file | Discovery without Mac paths; safe preview or honest fallback; authenticated original download |
| AC-31 | Physical Android open/download/share/background | Real device works or documented supported fallback; UI location and auth recover correctly |
| AC-32 | Phone disconnects during unrelated server work | Work continues; no implicit approval/cancel/retry; uncertain decisions reconcile |
| AC-33 | Isolated backup/restore rehearsal | Decisions, bindings, source references and retained evidence consistent after restore |
| AC-34 | Duplicate/new-card notification attempts | Verified batch/card receipts; no duplicate asks from report churn; no notification grants authority |
| AC-35 | New and existing Desktop entry paths after changes | No regression in source creation/resume/grouping; no changed conversation caching semantics |
| AC-36 | Entire acceptance run | Zero unauthorized external messages, publication, spending or financial transactions |

## 14. Release gate, known unknowns and delivery packet

The host/product direction is settled. Remaining questions are implementation evidence gates—not reasons to restart the product debate:

- Which exact backends/profiles contain the Desktop records that must be visible?
- Which gateway/client revisions and owner-auth capabilities are actually deployed?
- Which canonical output roots/file types/sizes constitute complete business coverage?
- Which supported deep links and safe persisted-history projection can be verified?
- Which business objectives/evidence justify assessment bands and any explicit business focus?

P0 records these from source/runtime inventory; ask Pawel only where his authorization or business judgment is genuinely needed. Do not invent missing provider routes, local paths, live status or benefit estimates.

The development delivery packet must include the implementation revision, source coverage inventory, migration/rollback procedure, acceptance matrix with evidence links, actual supported browser/file limits, known unresolved defects and updated manual. Preserve current services/data until replacements and restore checks pass. A partial backend or one passing phone screenshot is not release completion.

A short Remotion walkthrough is optional after accepted screens/workflows exist. It must depict the actual implementation or clearly labelled prototype; it is neither a dependency nor acceptance evidence. No video is included with this specification.

### Documentation verification versus product verification

This handoff is grounded in the prior direction/manual and the repository interfaces inspected during finalization. It does not claim live project/session enumeration, production auth audit, new application test execution, Android acceptance or deployed source directories. Those are explicit delivery gates above.

**Final instruction to development:** Build the narrow Companion around canonical decisions, valuable next actions, usable files and the actual Desktop source records. Projects and Sessions must be first-class browsable directories even without captured work. Preserve conversation and execution authority; never make a second copy of the user's working system merely to display it on a phone.
