#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createAgentSurface, internals } from "../src/agent-surface.mjs";

const inherited = new Map([
  ["bash", { name: "bash" }],
  ["write", { name: "write" }],
  ["edit", { name: "edit" }],
  ["skill", { name: "skill" }],
  ["job_list", { name: "job_list" }],
]);

function makeHarness({ skills = [] } = {}) {
  const rootListeners = new Map();
  const agents = [];
  const effects = [];
  const skillService = {
    async snapshot() { return { complete: true, skills }; },
  };
  const root = {
    get(name) {
      if (name === "agents") return { list: () => agents };
      if (name === "skills") return skillService;
      return undefined;
    },
    on(type, listener) {
      const entries = rootListeners.get(type) ?? [];
      entries.push(listener);
      rootListeners.set(type, entries);
      return () => entries.splice(entries.indexOf(listener), 1);
    },
    effect(factory) {
      const release = factory();
      assert.equal(typeof release, "function", "Cordis effect factory must return a disposer");
      effects.push(release);
      return release;
    },
  };

  function makeAgent({ projects = false, rejectEmptyAllow = false } = {}) {
    const local = new Map();
    const restrictions = [];
    const guards = [];
    const listeners = new Map();
    let runtimeSuppressions = 0;
    const active = new Set();
    const tools = {
      get restrictableNames() { return new Set(inherited.keys()); },
      restrict(filter) {
        if (rejectEmptyAllow && Array.isArray(filter.allow) && filter.allow.length === 0) {
          throw new Error("empty allow rejected");
        }
        const effect = { filter, active: true };
        restrictions.push(effect);
        active.add(effect);
        return () => {
          effect.active = false;
          active.delete(effect);
        };
      },
      guard(fn) {
        guards.push(fn);
        return () => guards.splice(guards.indexOf(fn), 1);
      },
      register(definition) {
        local.set(definition.name, definition);
        return () => local.delete(definition.name);
      },
      get(name, scope) {
        if (scope && local.has(name)) return local.get(name);
        let visible = inherited.get(name);
        for (const { filter } of active) {
          if (filter.allow && !filter.allow.includes(name)) visible = undefined;
          if (filter.deny?.includes(name)) visible = undefined;
        }
        return visible;
      },
      schemas() { return [...inherited.values()]; },
    };
    const systemPrompt = {
      suppressRuntimeContext() {
        runtimeSuppressions += 1;
        return () => { runtimeSuppressions -= 1; };
      },
    };
    const agentCtx = {
      tools,
      systemPrompt,
      get(name) {
        if (name === "tools") return tools;
        if (name === "systemPrompt") return systemPrompt;
        return undefined;
      },
      on(type, listener, options) {
        const entries = listeners.get(type) ?? [];
        const entry = { listener, options };
        entries.push(entry);
        listeners.set(type, entries);
        return () => entries.splice(entries.indexOf(entry), 1);
      },
    };
    const agent = {
      ctx: agentCtx,
      session: { id: `session-${agents.length}`, header: { cwd: projects ? "/projects" : "/work" } },
    };
    agents.push(agent);

    async function waterfall(type, payload, terminal) {
      const entries = [...(listeners.get(type) ?? [])];
      // Cordis prepend listeners are outermost and therefore run after inner
      // middleware has modified the result returned by next().
      entries.sort((a, b) => Number(Boolean(b.options?.prepend)) - Number(Boolean(a.options?.prepend)));
      let next = terminal;
      for (const { listener } of entries.reverse()) {
        const inner = next;
        next = type === "system-prompt/assemble"
          ? () => listener({}, payload, inner)
          : () => listener(payload, inner);
      }
      return next();
    }

    return {
      agent,
      agentCtx,
      tools,
      restrictions,
      guards,
      listeners,
      local,
      get runtimeSuppressed() { return runtimeSuppressions > 0; },
      waterfall,
    };
  }

  function dispose() {
    for (const release of effects.splice(0).reverse()) {
      try { release(); } catch {}
    }
  }

  return { root, agents, makeAgent, rootListeners, dispose };
}

const prompt = { source: { kind: "user" }, content: [{ type: "text", text: "hello" }] };
const nativeInstructions = { source: { kind: "agent-instructions" }, content: [] };
const pluginInstructions = { source: { kind: "plugin", plugin: "agent-instructions" }, content: [] };

{
  const harness = makeHarness();
  createAgentSurface(harness.root);
  const fixture = harness.makeAgent();
  for (const listener of harness.rootListeners.get("agent/created") ?? []) {
    listener({ agent: fixture.agent });
  }
  assert.deepEqual(fixture.restrictions.at(-1).filter, { allow: [] });
  assert.equal(fixture.runtimeSuppressed, true);
  for (const listener of harness.rootListeners.get("agent/disposed") ?? []) {
    listener({ agent: fixture.agent });
  }
  assert.equal(fixture.restrictions.at(-1).active, false);
  assert.equal(fixture.runtimeSuppressed, false);
}

{
  const harness = makeHarness();
  const surface = createAgentSurface(harness.root);
  const fixture = harness.makeAgent();
  surface.setup(fixture.agentCtx);
  surface.apply(fixture.agent);

  assert.deepEqual(fixture.restrictions.at(-1).filter, { allow: [] });
  assert.equal(fixture.runtimeSuppressed, true);
  assert.equal(fixture.guards.length, 1);
  assert.equal(fixture.guards[0]({ name: "bash", agent: fixture.agent }), internals.DENIED_REASON);

  const localDispose = fixture.tools.register({ name: "workflow_local" });
  assert.equal(fixture.guards[0]({ name: "workflow_local", agent: fixture.agent }), undefined);

  const assembled = await fixture.waterfall(
    "system-prompt/assemble",
    { agent: fixture.agent },
    async () => ({
      tools: [
        { name: "bash" },
        { name: "job_list" },
        { name: "workflow_local" },
      ],
      sections: [
        { name: "deployment:persona", content: "persona" },
        { name: "tool:bash", content: "bash sermon" },
        { name: "tool:jobs", content: "jobs sermon" },
        { name: "workflow:persona", content: "complete", complete: true },
        { name: "tool:workflow_local", content: "local guidance" },
      ],
      variables: {},
    }),
  );
  assert.deepEqual(assembled.tools.map(({ name }) => name), ["workflow_local"]);
  assert.deepEqual(assembled.sections.map(({ name }) => name), [
    "deployment:persona",
    "workflow:persona",
    "tool:workflow_local",
  ]);

  const stepped = await fixture.waterfall(
    "agent/pre-step",
    { agent: fixture.agent, messages: [prompt] },
    async () => ({ kind: "enter", messages: [prompt, nativeInstructions, pluginInstructions] }),
  );
  assert.deepEqual(stepped.messages, [prompt]);
  assert.equal(fixture.listeners.get("agent/pre-step")[0].options.prepend, true);

  surface.allow(fixture.agent, ["bash"]);
  assert.equal(fixture.restrictions.at(-2).active, false, "old allow mask was lifted");
  assert.deepEqual(fixture.restrictions.at(-1).filter, { allow: ["bash"] });
  assert.equal(fixture.guards[0]({ name: "bash", agent: fixture.agent }), undefined);
  const allowed = await fixture.waterfall(
    "system-prompt/assemble",
    { agent: fixture.agent },
    async () => ({
      tools: [{ name: "bash" }, { name: "write" }],
      sections: [{ name: "tool:bash" }, { name: "tool:write" }],
      variables: {},
    }),
  );
  assert.deepEqual(allowed.tools.map(({ name }) => name), ["bash"]);
  assert.deepEqual(allowed.sections.map(({ name }) => name), ["tool:bash"]);
  localDispose();
}

{
  const harness = makeHarness();
  const surface = createAgentSurface(harness.root);
  const fixture = harness.makeAgent();
  surface.setup(fixture.agentCtx);
  surface.apply(fixture.agent);
  const release = fixture.tools.register({ name: "bash", local: true });
  try {
    assert.equal(fixture.guards[0]({ name: "bash", agent: fixture.agent }), undefined);
    const assembled = await fixture.waterfall(
      "system-prompt/assemble",
      { agent: fixture.agent },
      async () => ({ tools: [{ name: "bash" }], sections: [{ name: "tool:bash" }] }),
    );
    assert.deepEqual(assembled.tools.map(({ name }) => name), ["bash"]);
    assert.deepEqual(assembled.sections.map(({ name }) => name), ["tool:bash"]);
  } finally {
    release();
  }
}

{
  const harness = makeHarness();
  const surface = createAgentSurface(harness.root);
  const fixture = harness.makeAgent();
  surface.setup(fixture.agentCtx);
  surface.apply(fixture.agent);
  surface.allow(fixture.agent, ["skill"]);
  const assembled = await fixture.waterfall(
    "system-prompt/assemble",
    { agent: fixture.agent },
    async () => ({ tools: [{ name: "skill" }], sections: [{ name: "tool:skill" }] }),
  );
  assert.deepEqual(assembled.tools, [], "empty catalog fences allow-listed skill");
  assert.deepEqual(assembled.sections, []);
  assert.equal(fixture.guards[0]({ name: "skill", agent: fixture.agent }), internals.SKILL_REASON);
}

{
  const harness = makeHarness({ skills: [{ name: "visible", invocation: { modelInvocable: true } }] });
  const surface = createAgentSurface(harness.root);
  const fixture = harness.makeAgent();
  surface.setup(fixture.agentCtx);
  surface.apply(fixture.agent);
  surface.allow(fixture.agent, ["skill"]);
  const assembled = await fixture.waterfall(
    "system-prompt/assemble",
    { agent: fixture.agent },
    async () => ({ tools: [{ name: "skill" }], sections: [{ name: "tool:skill" }] }),
  );
  assert.deepEqual(assembled.tools.map(({ name }) => name), ["skill"]);
  assert.deepEqual(assembled.sections.map(({ name }) => name), ["tool:skill"]);
}

{
  const harness = makeHarness();
  const surface = createAgentSurface(harness.root);
  const fixture = harness.makeAgent({ projects: true });
  surface.setup(fixture.agentCtx, { projects: true });
  surface.apply(fixture.agent, { projects: true });
  surface.allow(fixture.agent, ["bash", "write", "edit"]);
  assert.deepEqual(fixture.restrictions.at(-1).filter, { allow: [] });
  for (const name of ["bash", "write", "edit"]) {
    assert.equal(fixture.guards[0]({ name, agent: fixture.agent }), internals.PROJECTS_WRITE_REASON);
  }
}

{
  const harness = makeHarness();
  const surface = createAgentSurface(harness.root);
  const fixture = harness.makeAgent({ rejectEmptyAllow: true });
  surface.setup(fixture.agentCtx);
  surface.apply(fixture.agent);
  assert.deepEqual(
    new Set(fixture.restrictions.at(-1).filter.deny),
    new Set(inherited.keys()),
    "fallback denies every currently restrictable inherited tool",
  );
  inherited.set("future_tool", { name: "future_tool" });
  try {
    const result = await fixture.waterfall(
      "system-prompt/assemble",
      { agent: fixture.agent },
      async () => ({ tools: [{ name: "future_tool" }], sections: [{ name: "tool:future_tool" }] }),
    );
    assert.deepEqual(result.tools, [], "assembly still default-denies tools added later");
    assert.deepEqual(result.sections, []);
    assert.equal(fixture.guards[0]({ name: "future_tool", agent: fixture.agent }), internals.DENIED_REASON);
  } finally {
    inherited.delete("future_tool");
  }
}

{
  const harness = makeHarness();
  const fixture = harness.makeAgent({ projects: true });
  const surface1 = createAgentSurface(harness.root);
  surface1.fenceProjects(fixture.agent);
  harness.dispose();
  const surface2 = createAgentSurface(harness.root);
  const effective = surface2.allow(fixture.agent, ["bash", "write", "edit"]);
  assert.deepEqual(effective, [], "reloaded surface must rehome the Projects fence");
  assert.deepEqual(
    fixture.restrictions.filter(({ active }) => active).map(({ filter }) => filter),
    [{ allow: [] }],
  );
  for (const name of ["bash", "write", "edit"]) {
    assert.equal(fixture.guards[0]({ name, agent: fixture.agent }), internals.PROJECTS_WRITE_REASON);
  }
}

{
  const harness = makeHarness();
  const fixture = harness.makeAgent({ projects: true });
  const surface1 = createAgentSurface(harness.root, {
    isProjects: (agent) => agent === fixture.agent,
  });
  surface1.apply(fixture.agent);
  harness.dispose();
  const surface2 = createAgentSurface(harness.root, {
    isProjects: (agent) => agent === fixture.agent,
  });
  surface2.allow(fixture.agent, ["bash", "write", "edit"]);
  assert.deepEqual(
    fixture.restrictions.filter(({ active }) => active).map(({ filter }) => filter),
    [{ allow: [] }],
  );
  for (const name of ["bash", "write", "edit"]) {
    assert.equal(fixture.guards[0]({ name, agent: fixture.agent }), internals.PROJECTS_WRITE_REASON);
  }
}

{
  const harness = makeHarness();
  const surface1 = createAgentSurface(harness.root);
  harness.dispose();
  const surface2 = createAgentSurface(harness.root);
  const fixture = harness.makeAgent();
  surface1.setup(fixture.agentCtx);
  surface1.apply(fixture.agent);
  assert.equal(fixture.restrictions.length, 0, "disposed surface must not install a stale empty mask");
  surface2.setup(fixture.agentCtx);
  surface2.apply(fixture.agent);
  surface2.allow(fixture.agent, ["bash"]);
  assert.deepEqual(
    fixture.restrictions.filter(({ active }) => active).map(({ filter }) => filter),
    [{ allow: ["bash"] }],
    "surface.allow must replace the current incarnation's empty mask after reload",
  );
  assert.equal(fixture.guards[0]({ name: "bash", agent: fixture.agent }), undefined);
}

{
  const lock = JSON.parse(readFileSync(new URL("../dsh/package-lock.json", import.meta.url), "utf8"));
  const dsh = lock.packages?.["node_modules/@deepseek-ai/dsh"]?.dependencies ?? {};
  for (const plugin of [
    "@deepseek-ai/dsh-tool-bash",
    "@deepseek-ai/dsh-tool-fs",
    "@deepseek-ai/dsh-tool-jobs",
    "@deepseek-ai/dsh-tool-skill",
  ]) {
    assert.equal(typeof dsh[plugin], "string", `pinned DSH bundle no longer loads ${plugin}`);
  }
  const patch = readFileSync(new URL("../host.patch.yml", import.meta.url), "utf8");
  for (const id of ["tool-bash", "tool-fs", "tool-jobs", "tool-skill"]) {
    assert.doesNotMatch(
      patch,
      new RegExp(String.raw`(?:^|\n)\s*- id: ${id}\s*(?:\n|$)`),
      `host.patch.yml must not replace or disable stock ${id}`,
    );
  }
}

console.log("qq-core agent surface: ok");
