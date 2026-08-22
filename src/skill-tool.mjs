const SKILL_TOOL = "skill";

function modelInvocable(skill) {
  return skill?.invocation?.modelInvocable !== false;
}

function skillsOf(ctx) {
  return ctx?.get?.("skills", false) ?? ctx?.skills ?? null;
}

function agentsOf(ctx) {
  return ctx?.get?.("agents", false) ?? ctx?.agents ?? null;
}

function cwdOf(agent) {
  return agent?.session?.header?.cwd;
}

function scopedTools(agent) {
  return agent?.ctx?.tools
    ?? agent?.ctx?.get?.("tools", false)
    ?? null;
}

/**
 * Hide DSH's generic `skill` tool when the session catalog has no
 * model-invocable skills. Upstream `@deepseek-ai/dsh-tool-skill` still
 * registers the schema on an empty catalog; Grok then invents names.
 * `tools.restrict({ deny: ["skill"] })` is the supported hide, but
 * `systemPrompt.assemble` collects schemas before `agent/pre-step`, so this
 * also strips `skill` from the current assembly. Grok inherits those DSH
 * names unchanged.
 */
export function attachSkillToolVisibility(ctx) {
  const states = new Map();
  const offs = [];

  function show(agent) {
    const current = states.get(agent);
    current?.dispose?.();
    states.delete(agent);
  }

  function hide(agent) {
    const current = states.get(agent) ?? {};
    if (!current.dispose) {
      const tools = scopedTools(agent);
      if (tools && typeof tools.restrict === "function") {
        try {
          current.dispose = tools.restrict({ deny: [SKILL_TOOL] }) ?? (() => {});
        } catch {
          current.dispose = undefined;
        }
      }
    }
    states.set(agent, { ...current, hidden: true });
  }

  async function sync(agent, signal) {
    if (!agent) return;
    const skills = skillsOf(ctx);
    if (!skills || typeof skills.snapshot !== "function") return;
    let snapshot;
    try {
      snapshot = await skills.snapshot({
        cwd: cwdOf(agent),
        signal,
        scope: agent,
      });
    } catch {
      return;
    }
    if (signal?.aborted) return;
    if (!snapshot || snapshot.complete === false) return;
    const visible = (snapshot.skills ?? []).some(modelInvocable);
    if (visible) show(agent);
    else hide(agent);
  }

  async function syncLive(signal) {
    const agents = agentsOf(ctx);
    const list = typeof agents?.list === "function" ? agents.list() : [];
    await Promise.all(list.map((agent) => sync(agent, signal)));
  }

  function attach() {
    if (typeof ctx.on !== "function") {
      void syncLive();
      return;
    }
    offs.push(ctx.on("agent/created", ({ agent }) => {
      void sync(agent);
    }));
    offs.push(ctx.on("agent/disposed", ({ agent }) => {
      show(agent);
    }));
    offs.push(ctx.on("skills/change", () => {
      void syncLive();
    }));
    offs.push(ctx.on("system-prompt/assemble", async (assembly, context, next) => {
      const agent = context?.agent ?? context?.scope;
      await sync(agent, context?.signal);
      const result = await next();
      if (states.get(agent)?.hidden !== true) return result;
      const tools = (result.tools ?? []).filter((tool) => tool?.name !== SKILL_TOOL);
      if (tools.length === (result.tools ?? []).length) return result;
      return { ...result, tools };
    }));
    void syncLive();
  }

  attach();

  const dispose = () => {
    for (const off of offs) {
      try { off?.(); } catch {}
    }
    offs.length = 0;
    for (const state of states.values()) {
      try { state.dispose?.(); } catch {}
    }
    states.clear();
  };

  if (typeof ctx.effect === "function") {
    ctx.effect(() => dispose, "qq: skill-tool visibility");
  }

  return dispose;
}

export const internals = Object.freeze({
  SKILL_TOOL,
  modelInvocable,
});
