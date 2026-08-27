---
type: Runtime skills guide
title: Model-visible repository skills
description: Discovery, prompt exposure, and maintenance contracts for the repository's Mermaid, OKF migration, and OpenWiki connector skills, including the legacy connector duplicate.
tags: [runtime, skills, openwiki]
openwiki:
  roles: [runtime, repository]
  change_kinds: [tool-visibility, prompt-composition]
  source_paths: [src/skill-tool.mjs, extensions/execution-profiles.ts, skills/mermaid-diagrams/SKILL.md, skills/migrate-wiki-to-okf/SKILL.md, skills/write-connector/SKILL.md]
  symbols: [attachSkillToolVisibility, composeSystemPrompt]
  test_paths: [tests/test-qq-skill-tool.mjs, tests/test-execution-profiles.mjs, tests/test-qq-host-live.sh]
  validation_commands: [node tests/test-qq-skill-tool.mjs]
---

# Model-visible repository skills

Skills are task-specific prose contracts supplied by the host runtime. This repository contributes three canonical `SKILL.md` files under `skills/`; `extensions/execution-profiles.ts` consumes the host-provided discovery result when composing an activated role prompt.

## Discovery and prompt exposure

At `before_agent_start`, the execution-profile extension composes the selected role prompt from `event.systemPromptOptions`. Skills are visible only when:

1. the selected tool list contains `read`;
2. the host supplied the skill in `options.skills`; and
3. `disableModelInvocation` is false.

For each visible skill, the extension XML-escapes and emits its `name`, `description`, and absolute `filePath` inside `<available_skills>`. The prompt tells the model to read a matching skill on demand and resolve relative references against the skill file's directory. Without `read`, no skill catalog is emitted. Discovery, metadata parsing, ordering, and deduplication belong to the upstream Pi/OpenWiki host; this extension does not scan `skills/` itself.

## Daily DSH visibility guard

The daily host has a separate DSH-native guard in `src/skill-tool.mjs#attachSkillToolVisibility`. For each live agent it snapshots skills using that agent's cwd and scope. If the complete catalog contains no model-invocable skill, it applies the supported `tools.restrict({ deny: ["skill"] })` and also removes `skill` from the current `system-prompt/assemble` result because schema collection occurs before the normal pre-step hook. A real model-invocable skill restores the tool; skills with `invocation.modelInvocable: false` do not.

The guard reacts to agent creation/disposal and `skills/change`, ignores incomplete or failed snapshots rather than hiding on uncertain evidence, and reverses every restriction and listener on plugin disposal. Grok needs no adapter-specific filter because [`qq-models`](model-connectors.md) preserves DSH tool names.

Change `src/skill-tool.mjs` with `src/plugin.mjs` registration. Run `node tests/test-qq-skill-tool.mjs`; use `tests/test-qq-host-live.sh` only when proving visibility against the exact pinned DSH bundle.

## Canonical skills

### `mermaid-diagrams`

`skills/mermaid-diagrams/SKILL.md` governs when and how generated wiki pages use Mermaid:

- choose sequence diagrams for cross-component calls, state diagrams for lifecycles, ER diagrams for data models, and flowcharts for branching decisions;
- ground every participant, state, edge, and entity in inspected source;
- include diagrams for nontrivial flows where they clarify the page, not as decoration;
- add a one-line caption, keep labels short, and obey syntax restrictions around reserved words, punctuation, aliases, and identifiers;
- on update, preserve accurate diagrams, update stale ones, and repair degraded text fences using the recorded parser error.

The invariant is stronger than syntactic validity: a rendering diagram that invents or retains stale behavior is still a defect. Validation is the consuming OpenWiki runtime's Mermaid parser plus evidence review.

### `migrate-wiki-to-okf`

`skills/migrate-wiki-to-okf/SKILL.md` defines a metadata-only migration:

1. recursively inventory every wiki directory, including the root;
2. plan one assignment for every directory;
3. spawn exactly one subagent per directory, batching only for concurrency;
4. limit that subagent to Markdown files directly in its directory;
5. reconcile every planned directory and return missed corrections to the same scope.

Each subagent preserves document bodies, skips compliant files, edits only leading YAML, never adds `timestamp` or unlisted fields, and never edits `index.md`. It reports checked, changed, and uncertain files. The isolation boundary—exactly one subagent per directory, with no recursive write scope—is the key concurrency invariant.

### `write-connector`

`skills/write-connector/SKILL.md` is canonical for adding a built-in OpenWiki connector. It requires changes to connector types and registry, a source module under `src/connectors/sources/`, tests, and a `ConnectorRuntime` exposing `id`, `displayName`, `description`, `backend`, `requiredEnv`, `supportsAgenticDiscovery`, and `ingest()`.

Operational contracts:

- raw JSON/manifests: `~/.openwiki/connectors/<id>/raw/<run-id>/`;
- cursor/runtime state: `~/.openwiki/connectors/<id>/state.json`;
- non-secret configuration: `~/.openwiki/connectors/<id>/config.json`;
- secrets: `~/.openwiki/.env`, referenced only by environment-variable name;
- deterministic credentialed ingestion, with resumable stream cursors, object identity/edit/hash metadata, pagination state, and citation provenance as appropriate;
- connector IDs and paths must confine all access beneath the connector root;
- MCP wrappers are read-only and may call only configured, allowlisted read/dump operations;
- manifests cannot instantiate arbitrary commands or endpoints without reviewed built-in code.

Secret values must never be read for display, printed, logged, returned, hardcoded, or persisted in config, raw data, state, tests, or logs. Completion reports changed files, required environment-variable names, config, provider scopes, and the canonical ingestion command `openwiki personal --update`.

## Legacy duplicate

`skills/write-connector.md` is a legacy, non-`SKILL.md` duplicate of the connector instructions. It lacks canonical YAML discovery metadata and currently tells users to run `openwiki --update`, while the canonical skill says `openwiki personal --update`. Treat the directory-based `skills/write-connector/SKILL.md` as authoritative. Any substantive connector-contract edit must either synchronize the legacy file in the same change or deliberately retire it; do not allow two quietly divergent operational contracts.

## Invariants and limits

- Skill prose advises the model; it does not itself enforce filesystem confinement, secret handling, subagent isolation, or Mermaid validity. Implementations and the consuming runtime must enforce those boundaries.
- Skill inclusion is activation-time prompt composition, not eager loading of every skill body. The model receives metadata and a path, then reads only a matching skill.
- Skill names, descriptions, and locations are XML-escaped before interpolation, but skill file content is later read as repository instructions and remains subject to normal evidence and trust review.
- No focused local test validates the three skill files or legacy synchronization. `tests/test-execution-profiles.mjs` exercises profile composition generally but has no skill-specific assertions.

## Change seams and validation

- Add or revise canonical skills in a directory-level `SKILL.md` with `name` and `description` front matter; keep descriptions specific enough for task matching.
- Change visibility or serialization only in `composeSystemPrompt` in `extensions/execution-profiles.ts`; retain the `read` gate, model-invocation opt-out, XML escaping, and relative-path guidance.
- Changes to connector commands or contracts must resolve the legacy duplicate explicitly.
- Review skill prose against the source/runtime it describes, then validate through the consuming OpenWiki/Pi runtime: confirm discovery metadata, prompt catalog visibility with and without `read`, on-demand file loading, Mermaid parsing, and the resulting workflow behavior. Profile-related integration context is documented in [Profiles and activation](profiles-and-activation.md); broader checks belong in [Testing and validation](../testing/validation.md).
