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

For each search invocation, 1–5 normalized literal clues enter a deterministic
page-limit-tied depth ladder. The default five-result page starts at depth/final
limit 15 instead of 100 and expands to 45 then 100 only when exact verified,
authorized results cannot fill the requested page and the daemon reports more
candidates. qq-core obtains workspace tokens only through the injected service's
canonical `deriveWorkspaceScopeToken`; each rung remains one `search-batch-v1`
snapshot and verification is bounded to the fused contributions returned for
that rung, with an absolute maximum of 256 coordinates and concurrency 4.

`verifyDshSearchCandidates` exact-verifies every fused contribution. When the
pinned DSH batch API is available, it groups coordinates and calls
`readEventDocumentSnapshots` once, which lists persistence once and observes,
projects, and title-folds each unique session once. The helper returns only
bounded authoritative event time/snippet/title facts. qq-core strictly validates
those facts, independently requires every fused contribution, rechecks current
session metadata and authorization, and formats them without duplicate event or
title reads. Search results include redacted coarse phase durations and counts;
they never include literals, snippets, workspace tokens, or unauthorized IDs in
diagnostics. Context remains one separate `readEvent` window with a raw-event
bound of 50 per side.

Pagination tokens are random, opaque, scoped to one adapter/authorized turn,
and consumed on first use (including mismatch). A continuation performs one
fail-closed batch operation but pages the frozen verified candidate set, so a
changing index cannot reorder or inject candidates into an existing cursor.
Each adapter retains at most 32 one-use cursors, evicting the oldest before that
cap; cursor state retains only fixed-size verified snippets and metadata, never
full message bodies.

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
there is no FTS fallback. Every retained candidate must have all fused
contributions represented in bounded `verifiedEvidence`. Evidence carries a
required safe-integer `eventTimeUnixMs` and normalized non-empty `snippet`
(maximum 320 UTF-16 code units and 1280 UTF-8 bytes). A verified candidate may
carry a plain non-empty `title` (maximum 256 code units and 1024 bytes). qq-core
rejects malformed verification output and repeats contribution completeness as
defense in depth.

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

1. install the pinned rc.7 DSH patch so `sessionQuery.readEventDocumentSnapshots`
   is present; this is a Node-only query-service backport and changes no Rust,
   wire protocol, database schema, or indexed data;
2. land a qq-index version that feature-detects that method, retains its bounded
   exact-read fallback during rollout, and mounts both canonical helpers on
   `qq-session-index`;
3. activate qq-core and the already-indexed qq-index sibling together. A running
   host that loaded the pre-patch DSH class requires one controlled host restart;
   the index daemon and database do not require restart or rebuild;
4. wait for `qq-session-index.ready()` and its source phase to remain live, then
   run one bounded `/find-session` replay and inspect generation, rung, phase
   durations, counts, result shape, and end-to-end latency. Any missing
   prerequisite produces a closed search, not a call to legacy FTS.

Focused QA is `node tests/session-history.mjs`; it is also part of `npm test`.
