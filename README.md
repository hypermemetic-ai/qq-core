# `@hypermemetic-ai/qq-core`

Presentation-neutral DSH session service and daily host. This is a private, ES-module package; its primary package entry point is [`src/plugin.mjs`](src/plugin.mjs).

## Run the established checks

The root package declares one repository task and no install or start script:

```sh
npm test
```

That command runs, in order:

- [`tests/repository-geometry.mjs`](tests/repository-geometry.mjs)
- [`tests/agent-surface.mjs`](tests/agent-surface.mjs)
- [`tests/projects-chair.mjs`](tests/projects-chair.mjs)
- [`tests/host-boot.sh`](tests/host-boot.sh)

## Repository map

- **Public module boundary:** [`src/plugin.mjs`](src/plugin.mjs) is the root export. The other declared subpath exports are [`session`](src/session.mjs), [`conversation`](src/conversation.mjs), [`files`](src/files.mjs), [`scratch`](src/scratch.mjs), [`session-scope`](src/session-scope.mjs), [`alias`](src/alias.mjs), [`ask`](src/ask.mjs), and [`session-history`](src/session-history.mjs). Treat [`package.json`](package.json) as authoritative for the published surface.
- **Session-oriented source:** Start with [`src/session.mjs`](src/session.mjs), then the exported conversation, history, and scope modules above. `session.mjs` has both the highest recent change activity and the highest relative-module fan-in in the evidence, so changes there deserve a full test run.
- **Agent-oriented internals:** [`src/agent-surface.mjs`](src/agent-surface.mjs) and [`src/agent-catalog.mjs`](src/agent-catalog.mjs) are the selective entry points; the directly named check is [`tests/agent-surface.mjs`](tests/agent-surface.mjs).
- **Host and command surfaces:** Host-facing files are separated among [`bin/`](bin/qq), [`dsh/`](dsh/README.md), [`systemd/user/qq.service`](systemd/user/qq.service), [`host.patch.yml`](host.patch.yml), and [`project-catalog.json`](project-catalog.json). The packet does not establish their runtime relationships, so follow the relevant file and validate with the complete test task rather than assuming one.

## Route a first change

| Change area | Start here | Relevant named check |
| --- | --- | --- |
| Package entry points or shipped-file geometry | [`package.json`](package.json), [`src/plugin.mjs`](src/plugin.mjs) | [`tests/repository-geometry.mjs`](tests/repository-geometry.mjs) |
| Session or conversation modules | [`src/session.mjs`](src/session.mjs), [`src/conversation.mjs`](src/conversation.mjs) | Run the complete `npm test` task; no dedicated session test is identified by the packet |
| Agent surface | [`src/agent-surface.mjs`](src/agent-surface.mjs) | [`tests/agent-surface.mjs`](tests/agent-surface.mjs) |
| Project/chair files | [`project-catalog.json`](project-catalog.json), [`src/live-chairs.mjs`](src/live-chairs.mjs) | [`tests/projects-chair.mjs`](tests/projects-chair.mjs) |
| Host boot or activation files | [`host.patch.yml`](host.patch.yml), [`bin/qq-host-activate`](bin/qq-host-activate), [`systemd/user/qq.service`](systemd/user/qq.service) | [`tests/host-boot.sh`](tests/host-boot.sh) |

For repository-specific detail already tracked, see [`dsh/README.md`](dsh/README.md) and [`WEB_QA.md`](WEB_QA.md).
