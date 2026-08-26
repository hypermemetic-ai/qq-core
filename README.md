# `@hypermemetic-ai/qq`

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
budget, and the serialized result has a 16 KiB ceiling, with explicit target,
boundary, and truncation markers.

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

The product qq is this service plus whichever sibling qq plugins are present
on disk (`qq-ui`, `qq-relay`, `qq-workflows`, later tasks/wiki/dictation the
same way). qq expects them and loads even when any is absent: missing `qq-ui`
means no HTTP console, missing `qq-relay` means no mailbox, missing
`qq-workflows` means no `/workflows`. The session service itself still loads.

`core/host.patch.yml` is the attach recipe — webserver, model, `compact-basic`
`auto: false`, plugin ids, injects — not a second product. `bin/qq` applies it
as a `--patch` overlay over the pinned `dsh-base` bundle and binds each sibling
whose tree is on disk. `@hypermemetic-ai/qq` does **not** npm-depend on
`qq-ui`/`qq-relay`/`qq-workflows`; the start script binds them.

## Plugin lifecycle

The host enables DSH/Cordis hot module replacement over the linked workspace.
Changing one plugin disposes and reapplies that plugin fiber; it must not
restart the host or dispose DSH Agents. qq and qq-workflows create Agents
through the host root so a plugin replacement does not cancel in-flight
turns. An in-flight tool from a torn-down plugin may error; the turn continues.

Every sibling follows the same contract:

- declare required coeffects with `inject`; use `ctx.inject` or a dynamic
  `ctx.get(name, false)` for optional services that may be replaced;
- register routes, tools, listeners, timers, and background work through
  `ctx.effect`, returning the complete inverse operation;
- abort plugin-local asynchronous work on disposal; keep durable truth in the
  owning store and rebuild projections after reattachment;
- never import another qq sibling to communicate. Provide a named service and
  consume it through Cordis;
- keep capabilities that outlive a plugin fiber on the DSH-owned object that
  owns their lifetime. qq stores its closeable AgentHandle on the live Agent;
- treat the browser as a separate client: phone capture remains on the phone
  and rebinds to a replacement dictation fiber.

qq-ui opts into live assets. Current HTML, CSS, and browser JavaScript re-read
from the linked tree with `no-store`; the service worker bypasses its cache for
those current asset paths. UI changes therefore require a page reload, not a
host restart or another asset-version bump.

Run from anywhere in the repository:

```bash
export QWEN_TOKEN_PLAN_API_KEY='...'
bin/qq
```

The launcher uses DSH profile `qq`, defaults `DSH_HOME` to
`${XDG_STATE_HOME:-$HOME/.local/state}/qq` (honoring `QQ_DSH_HOME` then
`DSH_HOME`), and stores the default resume id in `$DSH_HOME/qq.session`.
Ordinary operator sessions live at an immediate child of `projectsRoot`
(production default `${HOME}/projects`; override with `QQ_PROJECTS_ROOT`).
Boot cwd must equal one of those project roots. The console serves
`http://127.0.0.1:3082/qq` and redirects onto `/qq/project/:name`.