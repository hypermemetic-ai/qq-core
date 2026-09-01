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
services. DSH `sessionQuery` remains authoritative for session metadata,
semantic conversation documents, titles, and bounded context windows. Full-text
retrieval comes only from the separate `qq-session-index` service provided by
the optional `@hypermemetic-ai/qq-index` sibling. qq-core has no static sibling
package import and never calls legacy session-query full-text search.

For each search invocation, 1–5 normalized literal clues are sent in exactly one
`search-batch-v1` operation. qq-core obtains workspace tokens only through the
injected service's canonical `deriveWorkspaceScopeToken`. It binds every fused
contribution to the corresponding ranked source pointer, authorizes current
session metadata, and then performs one authoritative semantic-document scan
per authorized candidate session. That scan applies the conversation type,
current/shadowed surface, and time/as-of filters; qq-core selects the requested
sequence numbers in memory and rechecks type, surface, time, and literal text.
At most 500 evidence pointers are accepted and at most four unique sessions are
scanned concurrently. Complete message bodies are discarded after each scan;
only fixed-size snippets and presentation metadata may enter cursor state.

The entire search has an independent 15-second wall-clock deadline, including
readiness, daemon search, metadata authorization, semantic materialization, and
title reads. It composes with caller cancellation and races downstream work, so
a stale-ready implementation that ignores abort cannot leave the tool pending.
A deadline failure has code `SESSION_HISTORY_SEARCH_TIMEOUT`, is marked
retryable, and does not fall back to another search provider.

Pagination tokens are random, opaque, scoped to one adapter/authorized turn,
and consumed on first use (including mismatch). A continuation performs one
fail-closed batch operation but pages the frozen verified candidate set, so a
changing index cannot reorder or inject candidates into an existing cursor.
Context remains one `readEvent` window with a raw-event bound of 50 per side.

### Injected interface prerequisite

The sibling must provide `qq-session-index` with these methods:

```text
status() / ready()
searchBatch(SearchBatchV1, { signal })
deriveWorkspaceScopeToken(workspaceId)
```

`ready()` must return exactly `true` before search. Missing, disabled, unready,
malformed, failing, stale, or nonresponsive services fail closed; there is no FTS fallback.
`workspace: current` authorizes only the caller's exact cwd. `workspace: all`
uses registered operator workspaces plus the caller cwd. The protocol accepts
at most 16 authorization scope tokens, so a larger distinct authorized catalog
fails closed rather than silently narrowing or splitting snapshots.

### Host and daemon deployment

`bin/qq` links the canonical sibling checkout `qq-index` only when its package
identity is exactly `@hypermemetic-ai/qq-index`; `QQ_DSH_HAVE_INDEX` gates the optional `qq-index` plugin.
A missing or identity-mismatched sibling remains disabled and does not prevent
qq-core from booting. The sibling package provides the independent
`qq-session-index` capability; it is injected at runtime and never imported by
qq-core.

When the sibling and `XDG_RUNTIME_DIR` exist, [`host.patch.yml`](host.patch.yml)
configures the client socket at:

```text
${XDG_RUNTIME_DIR}/qq-index/session-index.sock
```

The sibling's `qq-session-indexd.service` must be installed, started, and healthy
before search can become ready. Deploy from a clean retained worktree or built
artifact; do not overwrite a dirty primary checkout. Establish the owner-only
runtime directory and socket first, verify the daemon and socket without using
`/find-session`, then point/restart `qq.service` on the clean qq-core deployment
and inspect readiness logs. A missing daemon/socket produces a closed,
retryable search path, never legacy FTS.
