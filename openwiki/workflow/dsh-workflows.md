---
title: DSH workflows
---

# DSH workflows

`qq-workflows` owns architect/base selection, child delegation, QA phases, and
host-owned landing. A parent project session already has its repository root as
cwd. Delegation creates a self-contained shared clone with an internal `.git`;
clone failure refuses delegation and never falls back to `git worktree add`.

Capsule creation, merge, push, branch deletion, and cleanup remain behind the
workflow lifecycle. Architect and QA use ordinary in-repository Git inside their
cwd. Features requiring an external task archive refuse when none is supplied;
there is no task plugin.
