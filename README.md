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
