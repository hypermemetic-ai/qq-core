# `@hypermemetic-ai/qq-core`

Presentation-neutral Cordis service over DSH Agents and sessions. This package
owns list, read, create, prompt/steer admission, pending-inbox mutation,
interrupt, status/change observation, the deterministic conversation
projection, the live session number book, and bounded project file access. It
contains no HTML, routes, CSS, htmx, or browser assumptions.

`listProjectFiles()` returns one canonical directory level at a time, rooted in
the configured project catalog. `readProjectFile()` admits at most 512 KiB of
recognized UTF-8 Markdown, text, or code. `openProjectFile()` bounds safe binary
responses at 32 MiB. All three resolve canonical paths inside the selected
project and refuse symlink escape; absolute roots never cross the service API.

`createScratchManager()` owns one private direct child under a configured
scratch root (production default `~/.local/state/qq/scratch`). Each child is
mode `0700`, bound by an owner-only `qq.scratch/v1` marker. The session service
uses that manager for Home sessions (`scope: "home"`, `context: "scratch"`):
create, list, most-recent, close, replace/clear, and restart reconciliation
against live owned Home root Agents only. Home never registers a project.
Project sessions keep the registered-root catalog and never delete scratch.
A qq-owned `qq.session-scope/v1` sidecar (production default
`~/.local/state/qq/session-scope.json`) stores immutable Home metadata so scope
survives scratch deletion; DSH session headers stay on the supported field set.
A Home record is valid only when `cwd` is the exact expected child
`join(scratchRoot, sessionId)`; wrong-parent entries are protected, never
classified as Home, and never authorize deletion.
T-134 later owns Home routes and UI.

The qq plugin hides DSH's generic `skill` tool when a session catalog has no
model-invocable skills, and restores it when a real skill appears. Grok
inherits those DSH names unchanged.

## Session-history discovery

QQ exposes historical discovery only through the authentic direct-user gesture
`/find-session ...`. `find-session` is a user-invocable, model-disabled runtime
skill, so it is absent from the model skill catalog. The gesture enters the
Agent as an ordinary direct-user prompt rather than an unknown slash command.
QQ's `/new`, `/clear`, `/close`, and `/resume`/`/reopen` built-ins retain
priority; recognized user skills pass through, and all other slash commands
retain their existing dispatch.

For the exact claimed prompt and turn, QQ registers one agent-scoped read-only
`session_history` tool with `search` and `context` actions. Both actions expose
only `user/message` and visible text blocks from `assistant/message`. Tool
calls/results, todos, errors, reasoning, attachments, and raw transcripts are
never query controls or output. QQ's message-surface policy is internal:
`current` and `shadowed` conversation documents are eligible while `log-only`
documents are not.

`search` requires `queries: string[]`. Whitespace-normalized, case-insensitive
duplicates contribute once, and 1–5 unique non-empty literals are accepted. An
exact search is an array of one. There is no singular `query`, clues/weights,
Boolean mode, match mode, per-query filter, generic event type, or surface
control. Optional controls are event-time `after`/`before`, `workspace`
(`current` or `all`), `sessionScope` (`other`, `all`, or `current`), a 1–20 page
limit, and an opaque cursor. `/find-session` defaults to `other`. `current`
applies the caller session-id filter. `other` removes the caller and consumes at
most the one additional upstream slot needed to retain the requested eligible
count. When `all` or `current` includes the caller, QQ applies an exclusive
as-of bound at the admitted direct-user gesture, taking the earlier bound when
an explicit `before` is also present, so the request/tool turn cannot match
itself.

One query preserves DSH's source order and upstream exhaustive cursor. For 2–5
queries, QQ makes one fixed top-100 `searchSessions` call per normalized query
(the caller-slot continuation above is the only exception), with identical
workspace, time, message-type, and internal-surface filters. It does not retry
or exhaust source streams. The bounded union is fused with standard reciprocal
rank fusion:

```
score(session) = sum(1 / (60 + sourceRank))
```

There are no learned or custom weights. Ties use best source rank, strongest
matching-message time, then stable session id. Results contain identity,
optional title/live alias, cwd, creation time, live/persisted availability,
`score` (relative rank, never confidence), `matchedQueryCount`, and compact
per-query evidence. DSH headers are fused before enrichment. Exact visible-text
verification and `readTitleSnapshots` are performed only for the final output
page (at most 20 sessions); QQ never title-folds the up-to-500 candidate union.
Multi-query pages slice one frozen grant-local candidate set through
request-bound opaque cursors. Cursors are cleared with the grant, and
`candidateSetTruncated` reports any source with results beyond depth 100.

`context` accepts a stable session id, focused message seq, and 0–12 preceding
and following **conversational-message** counts. It always includes the focused
message. Exactly one upstream `readEvent` obtains at most 50 raw events on each
requested side. QQ filters only that bounded result to visible conversation and
then slices message counts; it never scans a semantic session and never issues
sequential event reads. `boundaries` reports whether each requested count was
reached and distinguishes a session edge from the fixed raw-event bound. Each
message has a 900-character cap, aggregate visible text has an 11,000-character
budget, and the serialized UTF-8 result has a 16 KiB byte ceiling, with explicit
target, boundary, and truncation markers.

Authorization is checked before prompt assembly and again at execution. Relay,
plugin, transcript, or model text cannot grant access. A next-step steering
claim remains trusted across DSH's adjacent next-step/next-turn claim splices.
The registration and every fused cursor are revoked on turn end, rejection,
error, cancellation/idle, agent disposal, or plugin/HMR disposal.

The adapter delegates only to DSH's public `ctx.sessionQuery`. DSH owns the
live-preferred corpus, detached reads, FTS ranking, and pagination. QQ neither
scans nor writes transcript JSONL and has no embeddings or transcript store.
`core/host.patch.yml` restates DSH's `session-query-sqlite` backend with
`openAt: first-search`, a 50-event read-window maximum, and a dedicated derived
index at `$DSH_HOME/session-query/session-history.sqlite`. The index is
disposable; JSONL remains authoritative. Tests inject fake `sessionQuery`
services and use only disposable configuration homes.

`read()` projects the DSH event log and live durable inbox into `conversation`.
The projection is rebuilt from DSH authority on every read; it is not another
transcript store. Idle text uses `agent.followup`, busy text uses `agent.steer`,
and both return after the inbox splice is flushed instead of waiting for the
Agent to become idle. Pending edit/remove preserve DSH FIFO placement and
MessageIds through `agent.inbox`, while interrupt uses `keepInbox: true`.

Live sessions wear a short number (`1 2 3 4 9 10 12 20 40 80`, then strange,
then integers above 100). The book is schema `qq.alias/v1`, persisted at
`.qq-aliases.json` beside `DSH_HOME` (`aliasFile` overrides), mode `0600`,
written atomically. Tests must not inherit that live path: `aliasFile`,
`liveChairsFile`, `scratchRoot`, and `scopeFile` are all default (host) or
all explicit (fixture). Mixing them is an error. A leftover
`.qq-relay-aliases.json` is read once and migrated onto the new path.
`list` / `read` include `alias` only while the session is live. The UUID
stays the identity; the number is the face.

## Host recipe

`qq-core` is the daily host repository. It owns this presentation-neutral
service, `bin/qq`, `host.patch.yml`, the pinned DSH toolchain, the project
catalog, and host documentation. It is not an index or containing product.

The launcher always links this repository root, then links fixed sibling
repositories only when their package identities are exact:
`@hypermemetic-ai/qq-ui`, `@hypermemetic-ai/qq-index`,
`@hypermemetic-ai/qq-dashboard`, `@hypermemetic-ai/qq-workflows`,
`@hypermemetic-ai/qq-models`, `@hypermemetic-ai/qq-relay`, and
`@hypermemetic-ai/qq-dictation`. The
checkout-directory argument `qq-wiki` is temporary and is admitted only when
its identity is exactly `@hypermemetic-ai/qq-index`; it creates no runtime
compatibility name. The launcher also accepts the independent optional siblings
`@hypermemetic-ai/image-finder`,
`@hypermemetic-ai/media-box`, and `@hypermemetic-ai/sts2-companion`. Missing or
identity-mismatched siblings remove capabilities without preventing core from
booting. There is no wildcard `qq-*` scan.

HMR watches exactly the linked package roots, and the same roots are installed
in the persistent DSH profile. Plugins communicate through Cordis services,
never sibling imports. `QQ_DSH_HAVE_RELAY` gates the in-process `qq-relay`
plugin. `QQ_DSH_HAVE_INDEX` likewise gates the optional `qq-index` plugin; the
package main `src/plugin.mjs` provides only the `qq-index` service with
`{ loadIndex, validateIndex }`. `QQ_DSH_HAVE_DASHBOARD` gates the optional
`qq-dashboard` plugin, whose `src/plugin.mjs` requires `qq-core` and provides
the canonical `qq-dashboard` service. `qq-ui` may consume that service but
retains its own fallback when the dashboard sibling is absent. Neither sibling
has a compatibility alias.

### Agent tool surface

Stock QQ agents are model-toolless by default. `qq-core` owns one replaceable
allow-list for each agent and applies the empty list on create and resume. It
also removes matching `tool:*` prompt sections, standing agent-instructions,
and unsolicited runtime-context snapshots. DSH tool plugins—including jobs,
filesystem tools, and skill—remain loaded in the host; hiding their inherited
schemas does not unload or special-case those plugins. Agent-scoped tools
registered by a workflow or a turn-scoped grant remain available.

A plugin opts an agent into inherited tools through the existing Cordis
service. The `qq-core.surface.allow` method replaces core's effect; plugins do
not import a sibling module or stack another `tools.restrict()` mask:

```js
const qq = ctx.get("qq-core");
qq.surface.allow(agent, ["bash"]); // replaces qq-core's [] for this agent
```

The `skill` tool remains hidden unless that session's catalog contains a
model-invocable skill. Projects, home, and project chairs otherwise share the
same empty stock surface and can receive inherited tools through
`qq.surface.allow`. Workflow-specific chair allow-lists belong in the workflow
plugin; until it calls `qq.surface.allow`, its agents intentionally retain the
empty stock surface.

Every operator project is an immediate-child repository under `projectsRoot`.
Its `SessionHeader.cwd` is that repository root, so source files and the
repository's own `.git` are inside the existing `workspace-write` root.
Configured multi-repository groups remain in `project-catalog.json`; all other
immediate children are discovered as standalone projects. There is no `qq`
catalog group.

The default chair is `deepseek-official` / `deepseek-v4-flash`. Run from the
core repository:

```bash
export DEEPSEEK_API_KEY='...'
bin/qq
```

The runtime profile and state path still use `qq`; renaming `DSH_HOME` is a
separate migration. The console remains at `http://127.0.0.1:3082/qq`.
