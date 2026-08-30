# `@hypermemetic-ai/qq-core`

Presentation-neutral DSH session service and daily host. This is a private ESM package; its root package entry is [`src/plugin.mjs`](src/plugin.mjs).

## Established command

The root package declares one lifecycle task:

```sh
npm test
```

It runs, in order, [`tests/repository-geometry.mjs`](tests/repository-geometry.mjs), [`tests/agent-surface.mjs`](tests/agent-surface.mjs), [`tests/projects-chair.mjs`](tests/projects-chair.mjs), and [`tests/host-boot.sh`](tests/host-boot.sh). No root `start` or other run script is declared in [`package.json`](package.json).

## Repository map

- **Package surface:** [`package.json`](package.json) is authoritative for exports. [`src/plugin.mjs`](src/plugin.mjs) is the root export; [`src/session.mjs`](src/session.mjs) is also exported and is the source module with the strongest relative-module fan-in and recent change activity. Other supported subpaths are defined explicitly in the export map.
- **Implementation:** exported and internal ESM modules live under [`src/`](src/plugin.mjs). [`src/agent-surface.mjs`](src/agent-surface.mjs) is another comparatively connected module; session persistence and history are kept in separate modules.
- **Command and host surface:** executables are under [`bin/`](bin/qq), while host configuration and service material are represented by [`host.patch.yml`](host.patch.yml), [`project-catalog.json`](project-catalog.json), and [`systemd/user/qq.service`](systemd/user/qq.service).
- **DSH subtree:** [`dsh/package.json`](dsh/package.json) marks a distinct package boundary; begin with its [`dsh/README.md`](dsh/README.md).
- **Verification:** the root test script is the canonical list of repository checks. Run the complete command even when using a filename-aligned test during development.

## Change routing

| Change | Start with | Nearest named check |
| --- | --- | --- |
| Public entry or export geometry | [`package.json`](package.json), [`src/plugin.mjs`](src/plugin.mjs) | [`tests/repository-geometry.mjs`](tests/repository-geometry.mjs) |
| Session code | [`src/session.mjs`](src/session.mjs), then the relevant exported module from the package export map | No session-specific test is identified by the tracked filenames; run `npm test` |
| Agent surface | [`src/agent-surface.mjs`](src/agent-surface.mjs) | [`tests/agent-surface.mjs`](tests/agent-surface.mjs) |
| Host boot or activation material | [`host.patch.yml`](host.patch.yml), [`bin/qq-host-activate`](bin/qq-host-activate), [`systemd/user/qq.service`](systemd/user/qq.service) | [`tests/host-boot.sh`](tests/host-boot.sh) |
| Project/chair catalog area | [`project-catalog.json`](project-catalog.json), [`src/live-chairs.mjs`](src/live-chairs.mjs), [`src/agent-catalog.mjs`](src/agent-catalog.mjs) | [`tests/projects-chair.mjs`](tests/projects-chair.mjs) |

Filename alignment is a routing aid, not proof of test coverage. Preserve the ESM module boundary and the explicit export map, and finish every change with the full root test command.
