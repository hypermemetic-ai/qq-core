# `@hypermemetic-ai/qq-core`

Presentation-neutral DSH session service and daily host. This is a private ECMAScript-module package.

## Test

The repository defines one top-level task:

```sh
npm test
```

It runs the repository geometry, agent surface, projects chair, and host boot checks in sequence. See [`package.json`](package.json) for the exact command.

## Repository map

- [`src/plugin.mjs`](src/plugin.mjs) is the package's main and default export entry point.
- The package also exports dedicated entry points for [`session`](src/session.mjs), [`conversation`](src/conversation.mjs), [`files`](src/files.mjs), [`scratch`](src/scratch.mjs), [`session-scope`](src/session-scope.mjs), [`alias`](src/alias.mjs), [`ask`](src/ask.mjs), and [`session-history`](src/session-history.mjs). Start with the export matching the surface you intend to change.
- [`bin/`](bin/qq), [`dsh/`](dsh/README.md), [`systemd/user/qq.service`](systemd/user/qq.service), [`host.patch.yml`](host.patch.yml), and [`project-catalog.json`](project-catalog.json) are the packaged command, DSH, service, host, and project-catalog boundaries. Inspect their contents before assuming runtime behavior.
- [`tests/`](tests/repository-geometry.mjs) contains the checks invoked by `npm test`.

## Change routing

| Change area | Start here | Relevant check |
| --- | --- | --- |
| Package entry points or repository shape | [`package.json`](package.json), [`src/plugin.mjs`](src/plugin.mjs) | [`tests/repository-geometry.mjs`](tests/repository-geometry.mjs) |
| Agent surface | [`src/agent-surface.mjs`](src/agent-surface.mjs) | [`tests/agent-surface.mjs`](tests/agent-surface.mjs) |
| Project catalog / chair paths | [`project-catalog.json`](project-catalog.json), [`src/live-chairs.mjs`](src/live-chairs.mjs) | [`tests/projects-chair.mjs`](tests/projects-chair.mjs) |
| Host paths | [`host.patch.yml`](host.patch.yml), [`systemd/user/qq.service`](systemd/user/qq.service), [`bin/qq-host-activate`](bin/qq-host-activate) | [`tests/host-boot.sh`](tests/host-boot.sh) |
| Session API | [`src/session.mjs`](src/session.mjs) | Run the full `npm test` task; no session-specific test command is declared. |

[`src/session.mjs`](src/session.mjs) has the highest change heat and relative-module fan-in in the supplied repository evidence, so treat session changes as broad-impact until the tests establish otherwise.

## More detail

- [`dsh/README.md`](dsh/README.md)
- [`WEB_QA.md`](WEB_QA.md)
