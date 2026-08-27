---
title: Core host quickstart
---

# Core host quickstart

Start from `/home/qqp/projects/qq-core` with `bin/qq`. Core discovers only named
sibling repositories that are present. The HTTP console is supplied by
`qq-ui`, relay by `qq-relay`, voice input by `qq-dictation`, workflow delegation
by `qq-workflows`, and model connectors by `qq-models`.

Select a project to create a session whose cwd and `workspace-write` root are
that repository root. Runtime state remains under the existing `qq` profile
paths until a separate state migration.
