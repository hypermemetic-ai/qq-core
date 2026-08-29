const SKILL_TOOL = "skill";
const DENIED_REASON = "this agent does not allow that inherited tool";
const SKILL_REASON = "this session has no model-invocable skills";

function serviceOf(ctx, name) {
  try {
    return ctx?.get?.(name, false) ?? ctx?.[name] ?? null;
  } catch {
    return ctx?.[name] ?? null;
  }
}

function toolsOf(holder) {
  return holder?.tools
    ?? serviceOf(holder, "tools")
    ?? holder?.ctx?.tools
    ?? serviceOf(holder?.ctx, "tools")
    ?? null;
}

function systemPromptOf(holder) {
  return holder?.systemPrompt
    ?? serviceOf(holder, "systemPrompt")
    ?? holder?.ctx?.systemPrompt
    ?? serviceOf(holder?.ctx, "systemPrompt")
    ?? null;
}

function modelInvocable(skill) {
  return skill?.invocation?.modelInvocable !== false;
}

function normalizeNames(names) {
  if (typeof names === "string" || names == null || typeof names[Symbol.iterator] !== "function") {
    throw new TypeError("qq-core.surface.allow(agent, names) requires an iterable of tool names");
  }
  const result = [];
  const seen = new Set();
  for (const value of names) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError("qq-core.surface.allow tool names must be non-empty strings");
    }
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function addNames(target, value) {
  if (typeof value === "function") {
    try { value = value(); } catch { return; }
  }
  if (value == null || typeof value[Symbol.iterator] !== "function") return;
  for (const item of value) {
    const name = typeof item === "string" ? item : item?.name;
    if (typeof name === "string" && name !== "run_code") target.add(name);
  }
}

/** Best-effort snapshot used only by the rc.7 empty-allow compatibility path. */
function inheritedNames(tools) {
  const names = new Set();
  try { addNames(names, tools?.restrictableNames); } catch {}
  try { addNames(names, tools?.schemas?.()); } catch {}
  return names;
}

function instructionMessage(message) {
  const source = message?.source && typeof message.source === "object"
    ? message.source
    : message;
  if (!source || typeof source !== "object") return false;
  if (source.kind === "agent-instructions") return true;
  return source.plugin === "agent-instructions";
}

function stripInstructionMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  const filtered = messages.filter((message) => !instructionMessage(message));
  return filtered.length === messages.length ? messages : filtered;
}

function toolSectionName(section) {
  const name = section?.name;
  return typeof name === "string" && name.startsWith("tool:")
    ? name.slice("tool:".length)
    : undefined;
}

function dispose(effect) {
  try { effect?.(); } catch {}
}

/**
 * Own the inherited DSH surface for every QQ agent. The allow-list is empty by
 * default and is replaced (never intersected) by {@link allow}.
 */
export function createAgentSurface(ctx) {
  const byAgent = new WeakMap();
  const byContext = new WeakMap();
  const states = new Set();
  const rootEffects = [];
  let disposed = false;

  function effectiveNames(state) {
    return state.allow.filter((name) => name !== SKILL_TOOL || state.skillAvailable);
  }

  function isHardFenced(state, name) {
    return name === SKILL_TOOL && !state.skillAvailable;
  }

  function isScopeLocal(state, name, agent) {
    const tools = state.tools;
    if (!tools || typeof tools.get !== "function") return false;
    try {
      if (name === "run_code") return false;
      const scoped = tools.get(name, agent ?? state.agent);
      if (scoped === undefined || scoped === null) return false;
      // An allow mask removes every disallowed inherited definition. Anything
      // still visible under that name therefore belongs to this scope.
      if (state.restrictionMode === "allow") return true;
      // A deny fallback names only globals known when it was installed. Compare
      // definitions so a later global is not mistaken for a local registration.
      const global = tools.get(name);
      if (global !== undefined && global !== null) return global !== scoped;
      return !state.inherited.has(name);
    } catch {
      return false;
    }
  }

  function allowed(state, name, agent) {
    if (typeof name !== "string" || isHardFenced(state, name)) return false;
    if (state.effective.has(name)) return true;
    return isScopeLocal(state, name, agent);
  }

  function applyRestriction(state) {
    dispose(state.restriction);
    state.restriction = undefined;
    state.restrictionMode = undefined;
    const allow = effectiveNames(state);
    state.effective = new Set(allow);
    const tools = state.tools;
    if (!tools || typeof tools.restrict !== "function") return;

    try {
      const effect = tools.restrict({ allow: [...allow] });
      state.restriction = typeof effect === "function" ? effect : undefined;
      state.restrictionMode = "allow";
      return;
    } catch {
      // rc.7 accepts { allow: [] }. Keep a bounded fallback for another pinned
      // runtime: deny every inherited name known now, while assemble + guard
      // continue enforcing the empty list against tools registered later.
    }

    const denied = [...state.inherited].filter((name) => !state.effective.has(name));
    if (denied.length === 0) return;
    try {
      const effect = tools.restrict({ deny: denied });
      state.restriction = typeof effect === "function" ? effect : undefined;
      state.restrictionMode = "deny";
    } catch {
      // Assembly and execution guard remain default-deny even without a mask.
    }
  }

  async function syncSkill(state, signal) {
    if (state.skillSync) return state.skillSync;
    const generation = state.skillGeneration;
    const run = (async () => {
      const skills = serviceOf(ctx, "skills");
      let available = false;
      if (skills && typeof skills.snapshot === "function") {
        try {
          const snapshot = await skills.snapshot({
            cwd: state.agent?.session?.header?.cwd,
            signal,
            scope: state.agent,
          });
          if (
            signal?.aborted
            || generation !== state.skillGeneration
            || !snapshot
            || snapshot.complete === false
          ) return;
          available = (snapshot.skills ?? []).some(modelInvocable);
        } catch {
          return;
        }
      }
      if (generation !== state.skillGeneration || available === state.skillAvailable) return;
      state.skillAvailable = available;
      applyRestriction(state);
    })();
    state.skillSync = run;
    try {
      await run;
    } finally {
      if (state.skillSync === run) state.skillSync = undefined;
    }
  }

  function filterAssembly(state, result, agent) {
    if (!result || typeof result !== "object") return result;
    const tools = Array.isArray(result.tools)
      ? result.tools.filter((tool) => allowed(state, tool?.name, agent))
      : result.tools;
    const sections = Array.isArray(result.sections)
      ? result.sections.filter((section) => {
        if (section?.name === "deployment:persona") return true;
        const name = toolSectionName(section);
        return name === undefined || allowed(state, name, agent);
      })
      : result.sections;
    if (tools === result.tools && sections === result.sections) return result;
    return { ...result, tools, sections };
  }

  function install(agentCtx) {
    if (disposed) return undefined;
    if (!agentCtx || (typeof agentCtx !== "object" && typeof agentCtx !== "function")) return undefined;
    const existing = byContext.get(agentCtx);
    if (existing) return existing;

    let state;

    const tools = toolsOf(agentCtx);
    state = {
      agentCtx,
      tools,
      allow: [],
      effective: new Set(),
      inherited: inheritedNames(tools),
      skillAvailable: false,
      skillGeneration: 0,
      skillSync: undefined,
      restriction: undefined,
      restrictionMode: undefined,
      effects: [],
      agent: undefined,
    };
    byContext.set(agentCtx, state);
    states.add(state);

    const systemPrompt = systemPromptOf(agentCtx);
    if (typeof systemPrompt?.suppressRuntimeContext === "function") {
      try {
        const effect = systemPrompt.suppressRuntimeContext();
        if (typeof effect === "function") state.effects.push(effect);
      } catch {}
    }

    if (tools && typeof tools.guard === "function") {
      try {
        const effect = tools.guard((execution) => {
          const name = execution?.name;
          if (name === SKILL_TOOL && !state.skillAvailable) return SKILL_REASON;
          if (state.effective.has(name)) return undefined;
          if (isScopeLocal(state, name, execution?.agent)) return undefined;
          return DENIED_REASON;
        });
        if (typeof effect === "function") state.effects.push(effect);
      } catch {}
    }

    if (typeof agentCtx.on === "function") {
      try {
        const effect = agentCtx.on(
          "system-prompt/assemble",
          async (_assembly, context, next) => {
            await syncSkill(state, context?.signal);
            const result = await next();
            return filterAssembly(state, result, context?.agent ?? context?.scope ?? state.agent);
          },
        );
        if (typeof effect === "function") state.effects.push(effect);
      } catch {}
      try {
        const effect = agentCtx.on(
          "agent/pre-step",
          async (_event, next) => {
            const result = await next();
            if (!result || !Array.isArray(result.messages)) return result;
            const messages = stripInstructionMessages(result.messages);
            return messages === result.messages ? result : { ...result, messages };
          },
          { prepend: true },
        );
        if (typeof effect === "function") state.effects.push(effect);
      } catch {}
    }

    applyRestriction(state);
    return state;
  }

  function apply(agentOrCtx) {
    if (disposed) return undefined;
    if (!agentOrCtx || (typeof agentOrCtx !== "object" && typeof agentOrCtx !== "function")) return undefined;
    let state = byAgent.get(agentOrCtx) ?? byContext.get(agentOrCtx);
    if (!state) {
      if (agentOrCtx.ctx) {
        state = install(agentOrCtx.ctx);
        if (!state) return undefined;
        state.agent = agentOrCtx;
        byAgent.set(agentOrCtx, state);
      } else {
        state = install(agentOrCtx);
      }
    }
    return state;
  }

  function allow(agentOrCtx, names) {
    const state = byAgent.get(agentOrCtx) ?? byContext.get(agentOrCtx) ?? apply(agentOrCtx);
    if (!state) throw new TypeError("qq-core.surface.allow requires a live agent or agent context");
    state.allow = normalizeNames(names);
    applyRestriction(state);
    if (state.allow.includes(SKILL_TOOL)) void syncSkill(state);
    return [...state.effective];
  }

  function releaseState(state) {
    if (!state || !states.has(state)) return;
    if (state.agent) byAgent.delete(state.agent);
    byContext.delete(state.agentCtx);
    states.delete(state);
    dispose(state.restriction);
    state.restriction = undefined;
    for (const effect of state.effects.reverse()) dispose(effect);
    state.effects.length = 0;
  }

  function release(agent) {
    releaseState(byAgent.get(agent));
  }

  if (typeof ctx?.on === "function") {
    rootEffects.push(ctx.on("agent/created", ({ agent } = {}) => { apply(agent); }));
    rootEffects.push(ctx.on("agent/disposed", ({ agent } = {}) => { release(agent); }));
    rootEffects.push(ctx.on("skills/change", () => {
      for (const state of states) {
        state.skillGeneration += 1;
        state.skillSync = undefined;
        void syncSkill(state);
      }
    }));
  }

  const agents = serviceOf(ctx, "agents");
  if (typeof agents?.list === "function") {
    // Plugin unload drops plugin-fiber restrictions. Rehome live agents so the
    // current surface owns their one replaceable allow-list after HMR.
    for (const agent of agents.list()) apply(agent);
  }

  const surface = Object.freeze({ allow, apply, setup: install });
  if (typeof ctx?.effect === "function") {
    ctx.effect(() => () => {
      disposed = true;
      for (const effect of rootEffects.reverse()) dispose(effect);
      for (const state of [...states]) releaseState(state);
    }, "qq-core: default-deny agent surface");
  }
  return surface;
}

export const internals = Object.freeze({
  DENIED_REASON,
  SKILL_REASON,
  SKILL_TOOL,
  instructionMessage,
  stripInstructionMessages,
  toolSectionName,
});
