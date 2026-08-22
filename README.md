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