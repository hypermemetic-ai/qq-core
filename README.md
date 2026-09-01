# `@hypermemetic-ai/qq-core`

Private ESM package for a presentation-neutral DSH session service and daily host. The default package entry is [`src/plugin.mjs`](src/plugin.mjs); the declared package surface and task definitions live in [`package.json`](package.json).

## Run the established check

```sh
npm test
```

This is the only root package script. It runs the tracked Node test programs and [`tests/host-boot.sh`](tests/host-boot.sh). No root install, start, or run script is declared.

## Major boundaries

- **Package API:** the default export path is [`src/plugin.mjs`](src/plugin.mjs). Explicit subpath exports include [`src/session.mjs`](src/session.mjs), [`src/conversation.mjs`](src/conversation.mjs), and [`src/session-history.mjs`](src/session-history.mjs); consult [`package.json`](package.json) for the complete export map.
- **Session core:** [`src/session.mjs`](src/session.mjs) is the most frequently changed source file in the supplied history. It and [`src/conversation.mjs`](src/conversation.mjs) also have the highest relative-module fan-in, so changes there deserve an early impact review.
- **Internal source:** modules such as [`src/agent-surface.mjs`](src/agent-surface.mjs), [`src/session-persistence.mjs`](src/session-persistence.mjs), and [`src/live-chairs.mjs`](src/live-chairs.mjs) are tracked under `src/` but are not declared package subpath exports.
- **Host and DSH assets:** the package file set includes [`bin/qq`](bin/qq), [`dsh/`](dsh/README.md), [`systemd/user/qq.service`](systemd/user/qq.service), [`host.patch.yml`](host.patch.yml), and [`project-catalog.json`](project-catalog.json). Start with [`dsh/README.md`](dsh/README.md) for the repository's existing DSH-specific documentation.

## Route a change

| Change area | Start with | Nearest named test invoked by `npm test` |
| --- | --- | --- |
| Package entry or export shape | [`package.json`](package.json), [`src/plugin.mjs`](src/plugin.mjs) | [`tests/repository-geometry.mjs`](tests/repository-geometry.mjs) |
| Session or conversation code | [`src/session.mjs`](src/session.mjs), [`src/conversation.mjs`](src/conversation.mjs) | [`tests/conversation-failure.mjs`](tests/conversation-failure.mjs) |
| Session history | [`src/session-history.mjs`](src/session-history.mjs) | [`tests/session-history.mjs`](tests/session-history.mjs) |
| Agent surface | [`src/agent-surface.mjs`](src/agent-surface.mjs) | [`tests/agent-surface.mjs`](tests/agent-surface.mjs) |
| Host or project configuration | [`host.patch.yml`](host.patch.yml), [`project-catalog.json`](project-catalog.json), [`bin/qq`](bin/qq) | [`tests/host-boot.sh`](tests/host-boot.sh), [`tests/projects-chair.mjs`](tests/projects-chair.mjs) |

Test filenames are routing hints, not proof of coverage; run the full `npm test` command. For the tracked web QA notes, see [`WEB_QA.md`](WEB_QA.md).

## Durable `/find-session` index

`/find-session` is a user-turn-scoped, read-only adapter over two injected
services. DSH `sessionQuery` remains the authority for session metadata, exact
events, titles, and bounded context windows. Full-text retrieval comes only
from the separate `qq-session-index` service provided by the optional
`@hypermemetic-ai/qq-index` sibling. qq-core has no static sibling-package
import and never calls the legacy `sessionQuery.searchSessions` method.

For each search invocation, 1–5 normalized literal clues are sent in exactly
one `search-batch-v1` operation. qq-core obtains workspace tokens only through
the injected service's canonical `deriveWorkspaceScopeToken`, then calls its
abort-aware `verifyDshSearchCandidates` with a fixed maximum of 500 evidence
pointers and concurrency 4. Before presenting anything, qq-core rechecks the
session header, session/current/other policy, event time/as-of boundary, role,
surface, text, and snippets through bounded authoritative DSH reads. Context is
still one existing `readEvent` window with a raw-event bound of 50 per side.

Pagination tokens are random, opaque, scoped to one adapter/authorized turn,
and consumed on first use (including mismatch). A continuation performs one
fail-closed batch operation but pages the frozen verified candidate set, so a
changing index cannot reorder or inject candidates into an existing cursor.
Cursor state retains only fixed-size verified snippets and metadata, never full message bodies.

### Injected interface prerequisite

The sibling must provide `qq-session-index` with these methods:

```text
status() / ready()
searchBatch(SearchBatchV1, { signal })
deriveWorkspaceScopeToken(workspaceId)
verifyDshSearchCandidates({
  searchResponse, sessionQuery, literals,
  eventTypeAllowList, surfaceAllowList,
  maxConcurrency, maxCandidates, signal
})
```

`ready()` must return exactly `true` before search. Missing, disabled, unready,
malformed, or failing services and failed exact verification all fail closed;
there is no FTS fallback. The helper's verification result must contain bounded
`verifiedCandidates` and `verifiedEvidence` arrays in the documented
qq-index DSH-source shape.

`workspace: current` authorizes only the caller's exact cwd. `workspace: all`
uses the operator project catalog plus the caller cwd and projects root.
Unregistered immediate children discovered for project navigation are not
search authorization entries. The `search-batch-v1` protocol currently accepts
at most 16 authorization scope tokens, so a larger distinct authorized catalog
fails closed rather than silently narrowing or splitting into multiple snapshots.

### Host and daemon deployment

`bin/qq` links the canonical sibling checkout `qq-index` only when its package
identity is exactly `@hypermemetic-ai/qq-index`; `QQ_DSH_HAVE_INDEX` gates the optional `qq-index` plugin.
A missing or identity-mismatched sibling remains disabled and does not prevent
qq-core from booting. The sibling package main `src/plugin.mjs` retains the
legacy `qq-index` README service and additionally provides the independent
`qq-session-index` capability; neither service is imported by qq-core.

When both the sibling and `XDG_RUNTIME_DIR` exist, [`host.patch.yml`](host.patch.yml)
enables the production runtime at:

```text
${XDG_RUNTIME_DIR}/qq-index/session-index.sock
```

The sibling's `qq-session-indexd` user unit must be installed, enabled, and
healthy before search can become ready. Its runtime directory and socket must
be owner-only. If `XDG_RUNTIME_DIR` is unavailable the capability remains inert
instead of making host startup unsafe. The DSH SQLite query plugin is retained
for authoritative exact reads and retains `openAt: first-search` because other
authorized host consumers (including qq-workflows research evidence) still use
its FTS API. The cutover is local to qq-core `/find-session`, whose adapter never
calls that API. This route remains fail closed on qq-index errors or absence.

Deployment order:

1. land a qq-index version that mounts both canonical helpers on
   `qq-session-index` and install/build its Rust daemon;
2. install and start the sibling's `qq-session-indexd.service` so the private
   socket exists at the path above;
3. restart/reload qq-core and wait for `qq-session-index.ready()` to become
   true after source catch-up;
4. exercise `/find-session`; any missing prerequisite produces a closed search,
   not a call to legacy FTS.

Focused QA is `node tests/session-history.mjs`; it is also part of `npm test`.
