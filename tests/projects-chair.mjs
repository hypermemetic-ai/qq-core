import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { projectConversation } from "../src/conversation.mjs";
import { createQqService, sessionRecency } from "../src/session.mjs";

const packageRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

function siblingProject(name) {
  const envName = `QQ_${name.replace(/^qq-/, "").toUpperCase().replaceAll("-", "_")}_ROOT`;
  const configured = process.env[envName];
  const candidates = [configured, join(dirname(packageRoot), name)];
  for (let cursor = packageRoot; dirname(cursor) !== cursor; cursor = dirname(cursor)) {
    if (basename(cursor) === ".qq-worktrees") {
      candidates.push(join(dirname(cursor), name));
      break;
    }
  }
  try {
    const origin = execFileSync("git", ["-C", packageRoot, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (origin.startsWith("/")) candidates.push(join(dirname(realpathSync(origin)), name));
  } catch {
    // The ordinary sibling layout remains authoritative when origin is remote.
  }
  const root = candidates.find((candidate) => candidate && existsSync(join(candidate, "package.json")));
  if (!root) throw new Error(`missing sibling project ${name}`);
  return realpathSync(root);
}

const workflowsRoot = siblingProject("qq-workflows");
const { createArchitect } = await import(pathToFileURL(join(workflowsRoot, "src/architect.mjs")));
const { createLand } = await import(pathToFileURL(join(workflowsRoot, "src/land.mjs")));
const { createDelegationStore } = await import(pathToFileURL(join(workflowsRoot, "src/delegation-store.mjs")));

const BOOT_ID = "session-10000000-0000-4000-8000-000000000001";
const OLD_PROJECTS_ID = "session-20000000-0000-4000-8000-000000000002";
const STALE_PROJECTS_ID = "session-30000000-0000-4000-8000-000000000003";
const ORIGIN_CHILD_ID = "session-40000000-0000-4000-8000-000000000004";
const PARENT_CHILD_ID = "session-50000000-0000-4000-8000-000000000005";
const PROJECT_CHILD_ID = "session-60000000-0000-4000-8000-000000000006";

function makeFixture({ liveProjects = true, staleProjects = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "qq-core-projects-chair-"));
  const projectsRoot = join(root, "projects");
  const bootCwd = join(projectsRoot, "qq-core");
  mkdirSync(bootCwd, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", bootCwd]);
  execFileSync("git", ["-C", bootCwd, "config", "user.name", "Projects Chair Test"]);
  execFileSync("git", ["-C", bootCwd, "config", "user.email", "projects-chair@test"]);
  execFileSync("git", ["-C", bootCwd, "config", "commit.gpgsign", "false"]);
  writeFileSync(join(bootCwd, "README.md"), "projects chair delegate fixture\n");
  execFileSync("git", ["-C", bootCwd, "add", "README.md"]);
  execFileSync("git", ["-C", bootCwd, "commit", "--quiet", "-m", "fixture"]);

  const headers = new Map();
  const store = new Map();
  const setupRecords = [];
  let createFailure;
  let createCalls = 0;
  let resumeCalls = 0;
  let rngCalls = 0;

  function header(id, cwd) {
    return { id, cwd, createdAt: Date.now() };
  }

  function makeAgent(id, metaOrCwd, setup) {
    const meta = typeof metaOrCwd === "string" ? { cwd: metaOrCwd } : metaOrCwd;
    const restrictions = [];
    const guards = [];
    const listeners = [];
    const inherited = new Map([
      ["bash", { name: "bash", async execute() {} }],
      ["write", { name: "write", async execute() {} }],
      ["edit", { name: "edit", async execute() {} }],
    ]);
    const local = new Map();
    const tools = {
      restrict(filter) {
        const effect = { filter, active: true };
        restrictions.push(effect);
        return () => { effect.active = false; };
      },
      guard(fn) {
        guards.push(fn);
        return () => guards.splice(guards.indexOf(fn), 1);
      },
      register(definition) {
        const previous = local.get(definition.name);
        local.set(definition.name, definition);
        return () => {
          if (previous) local.set(definition.name, previous);
          else local.delete(definition.name);
        };
      },
      get(name, scope) {
        if (scope && local.has(name)) return local.get(name);
        let definition = inherited.get(name);
        if (scope) {
          for (const { filter, active } of restrictions) {
            if (!active) continue;
            if (filter.allow && !filter.allow.includes(name)) definition = undefined;
            if (filter.deny?.includes(name)) definition = undefined;
          }
        }
        return definition;
      },
      schemas() { return [...inherited.values()]; },
    };
    const systemPrompt = {
      section() { return () => {}; },
      suppressRuntimeContext() {},
    };
    const agentCtx = {
      tools,
      systemPrompt,
      get(name) {
        if (name === "tools") return tools;
        if (name === "systemPrompt") return systemPrompt;
        if (name === "sandboxPolicy") {
          return {
            resolve({ session }) {
              const mode = session.events.findLast(({ type }) => type === "sandbox/mode")?.data?.mode;
              return { mode, workspaceRoot: session.header.cwd };
            },
          };
        }
        if (name === "shell") return { sandboxMode: "fixture" };
        if (name === "sandbox") return { confine: () => ({ enforcement: "full" }) };
        return ctx.get(name);
      },
      on(type, listener) {
        const record = { type, listener };
        listeners.push(record);
        return () => {
          const index = listeners.indexOf(record);
          if (index >= 0) listeners.splice(index, 1);
        };
      },
    };
    setup?.(agentCtx);
    const setupRecord = setup ? { id, restrictions, guards, agent: undefined } : undefined;
    const agent = {
      status: "idle",
      ctx: agentCtx,
      inbox: { nextTurn: [], nextStep: [] },
      session: {
        id,
        header: { ...header(id, meta.cwd), ...meta },
        events: [],
        seq: 0,
        append(type, data) {
          this.seq += 1;
          this.events.push({ type, data, seq: this.seq });
        },
      },
      cancel() {},
      followup(message) {
        agent.status = "running";
        agent.inbox.nextTurn.push(message);
      },
      async whenIdle() {},
    };
    if (setupRecord) {
      setupRecord.agent = agent;
      setupRecords.push(setupRecord);
    }
    return agent;
  }

  function addExisting(id, cwd) {
    const agent = makeAgent(id, cwd);
    store.set(id, agent);
    headers.set(id, { ...agent.session.header });
    return agent;
  }

  addExisting(BOOT_ID, bootCwd);
  if (liveProjects) addExisting(OLD_PROJECTS_ID, projectsRoot);
  if (staleProjects) headers.set(STALE_PROJECTS_ID, header(STALE_PROJECTS_ID, projectsRoot));

  function handleFor(agent) {
    return {
      agent,
      async dispose() { store.delete(agent.session.id); },
    };
  }

  const agents = {
    store,
    get(id) { return store.get(id); },
    list() { return [...store.values()]; },
    async create(options) {
      createCalls += 1;
      if (createFailure) {
        const error = createFailure;
        createFailure = undefined;
        throw error;
      }
      const agent = makeAgent(options.sessionId, options.meta, options.setup);
      store.set(agent.session.id, agent);
      return handleFor(agent);
    },
    async resume(options) {
      resumeCalls += 1;
      const persisted = headers.get(options.resumeSessionId);
      if (!persisted) throw new Error("fake: missing persisted session");
      const agent = makeAgent(persisted.id, persisted.cwd, options.setup);
      store.set(agent.session.id, agent);
      return handleFor(agent);
    },
  };

  const sessions = {
    async flush(session) { headers.set(session.id, { ...session.header }); },
  };
  const persistence = {
    async list() { return [...headers.values()]; },
  };
  const services = new Map([
    ["agents", agents],
    ["sessions", sessions],
    ["sessionPersistence", persistence],
    ["loader", { async await() {} }],
  ]);
  const effects = [];
  const ctxListeners = new Map();
  const ctx = {
    get(name) { return services.get(name); },
    logger: { warn() {} },
    on(type, listener) {
      let listeners = ctxListeners.get(type);
      if (!listeners) {
        listeners = new Set();
        ctxListeners.set(type, listeners);
      }
      listeners.add(listener);
      const release = () => {
        listeners.delete(listener);
        if (listeners.size === 0) ctxListeners.delete(type);
      };
      effects.push(release);
      return release;
    },
    effect(factory) {
      const release = factory();
      if (typeof release === "function") effects.push(release);
      return release;
    },
  };
  const files = {
    alias: join(root, "state", "aliases.json"),
    chairs: join(root, "state", "live-chairs.json"),
    scopes: join(root, "state", "scopes.json"),
    scratch: join(root, "scratch"),
  };
  const config = {
    sessionId: BOOT_ID,
    cwd: bootCwd,
    projectsRoot,
    provider: "fake-provider",
    model: "fake-model",
    aliasFile: files.alias,
    liveChairsFile: files.chairs,
    scratchRoot: files.scratch,
    scopeFile: files.scopes,
    rng: () => { rngCalls += 1; return 0; },
    now: () => 1,
  };
  let service = createQqService(ctx, config);
  services.set("qq-core", service);
  services.set("qq", service);

  function reload(factory = createQqService) {
    for (const release of effects.splice(0).reverse()) {
      try { release(); } catch {}
    }
    service = factory(ctx, config);
    services.set("qq-core", service);
    services.set("qq", service);
    return service;
  }

  return {
    root,
    get service() { return service; },
    agents,
    ctx,
    setService(name, value) { services.set(name, value); },
    emit(type, ...args) {
      for (const listener of [...(ctxListeners.get(type) ?? [])]) listener(...args);
    },
    files,
    setupRecords,
    reload,
    get createCalls() { return createCalls; },
    get resumeCalls() { return resumeCalls; },
    get rngCalls() { return rngCalls; },
    failNextCreate(error = new Error("fake: create failed")) { createFailure = error; },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

function countedEvents(source) {
  let reads = 0;
  const events = new Proxy(source, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^(0|[1-9][0-9]*)$/.test(property)) reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return {
    events,
    get reads() { return reads; },
  };
}

// Preserve the public pure helper's empty, fallback-created, invalid-time, and
// out-of-order maximum semantics while the live service uses its cached path.
{
  const session = {
    id: BOOT_ID,
    header: {},
    createdAt: 321,
    events: [
      { time: 40 },
      { time: "1970-01-01T00:00:00.090Z" },
      { time: Number.NaN },
      { time: 15 },
    ],
  };
  assert.deepEqual(sessionRecency(session, 123), { latest: 90, createdAt: 321, id: BOOT_ID });
  assert.deepEqual(
    sessionRecency({ id: BOOT_ID, header: {}, events: [] }, 123),
    { latest: 0, createdAt: 123, id: BOOT_ID },
  );
}

function projectsAgents(fixture) {
  return fixture.agents.list().filter((agent) => agent.session.header.cwd === fixture.service.projectsRoot);
}

function persistedProjectsRows(fixture) {
  const payload = JSON.parse(readFileSync(fixture.files.chairs, "utf8"));
  return payload.sessions.filter((row) => row.scope === "projects");
}

function projectsAliasHolder(fixture) {
  const payload = JSON.parse(readFileSync(fixture.files.alias, "utf8"));
  return payload.entries.find((entry) => entry.alias === "projects" && entry.goneAt === null)?.session;
}

function activeFilters(setup) {
  return setup.restrictions.filter(({ active }) => active).map(({ filter }) => filter);
}

function guardReason(setup, name) {
  for (const guard of setup.guards) {
    const reason = guard({ name, agent: setup.agent });
    if (reason !== undefined) return reason;
  }
  return undefined;
}

function assertDefaultSurface(fixture, id) {
  const setup = fixture.setupRecords.find((record) => record.id === id);
  assert.ok(setup, `missing setup record for ${id}`);
  assert.deepEqual(activeFilters(setup), [{ allow: [] }]);
  assert.equal(setup.guards.length, 1);
  assert.match(guardReason(setup, "bash"), /does not allow that inherited tool/);
}

function assertNotProjectsFenced(fixture, id) {
  const setup = fixture.setupRecords.find((record) => record.id === id);
  assert.ok(setup, `missing setup record for ${id}`);
  assert.equal(
    activeFilters(setup).some((filter) => Array.isArray(filter.allow)),
    true,
    "delegated agent is missing qq-core's allow-list",
  );
  for (const guard of setup.guards) {
    for (const name of ["bash", "write", "edit"]) {
      assert.doesNotMatch(guard({ name, agent: setup.agent }) ?? "", /does not write the filesystem/);
    }
  }
}

function assertProjectsDefaultSurface(fixture, id) {
  assertDefaultSurface(fixture, id);
  const setup = fixture.setupRecords.find((record) => record.id === id);
  for (const name of ["bash", "write", "edit"]) {
    assert.match(guardReason(setup, name), /does not allow that inherited tool/);
    assert.doesNotMatch(guardReason(setup, name), /does not write the filesystem/);
  }
}

async function replacement(command, action) {
  const fixture = makeFixture();
  try {
    await fixture.service.createProjects(); // settle boot and establish sidecars
    const beforeCreates = fixture.createCalls;
    const result = await fixture.service.prompt(OLD_PROJECTS_ID, command);
    assert.equal(result.kind, "navigate");
    assert.equal(result.action, action);
    assert.equal(result.closed, OLD_PROJECTS_ID);
    assert.notEqual(result.id, OLD_PROJECTS_ID);
    assert.equal(result.alias, "projects");
    assert.equal(fixture.createCalls, beforeCreates + 1);
    assert.equal(fixture.agents.get(OLD_PROJECTS_ID), undefined);
    assert.deepEqual(projectsAgents(fixture).map((agent) => agent.session.id), [result.id]);
    assert.deepEqual(persistedProjectsRows(fixture).map((row) => row.id), [result.id]);
    assert.equal(projectsAliasHolder(fixture), result.id);
    assertProjectsDefaultSurface(fixture, result.id);
    return result.id;
  } finally {
    fixture.cleanup();
  }
}

{
  const fixture = makeFixture({ liveProjects: false });
  try {
    const gitRoot = fixture.service.gitRootForDelegate(fixture.service.projectsRoot);
    assert.equal(fixture.service.gitRootForDelegate(join(fixture.root, ".")), fixture.root);
    assert.equal(
      gitRoot,
      fixture.service.listProjects().find((project) => project.name === fixture.service.defaultProject).cwd,
    );

    const projects = await fixture.service.createProjects();
    assert.equal(fixture.agents.get(projects.id).session.header.cwd, fixture.service.projectsRoot);

    const originChild = (await fixture.agents.create({
      sessionId: ORIGIN_CHILD_ID,
      meta: { cwd: fixture.service.projectsRoot, origin: "subagent" },
      setup() {},
    })).agent;
    assert.equal(originChild.session.header.cwd, gitRoot);
    assert.notEqual(originChild.session.header.cwd, fixture.service.projectsRoot);
    assert.equal(
      execFileSync("git", ["-C", originChild.session.header.cwd, "rev-parse", "--is-inside-work-tree"], {
        encoding: "utf8",
      }).trim(),
      "true",
    );

    const parentChild = (await fixture.agents.create({
      sessionId: PARENT_CHILD_ID,
      meta: { cwd: fixture.service.projectsRoot, parentSession: projects.id },
      setup() {},
    })).agent;
    assert.equal(parentChild.session.header.cwd, gitRoot);

    const projectChild = (await fixture.agents.create({
      sessionId: PROJECT_CHILD_ID,
      meta: { cwd: gitRoot, origin: "subagent", parentSession: projects.id },
      setup() {},
    })).agent;
    assert.equal(projectChild.session.header.cwd, gitRoot);

    assertProjectsDefaultSurface(fixture, projects.id);
    assertNotProjectsFenced(fixture, ORIGIN_CHILD_ID);
    assertNotProjectsFenced(fixture, PARENT_CHILD_ID);
    assertNotProjectsFenced(fixture, PROJECT_CHILD_ID);
  } finally {
    fixture.cleanup();
  }
}

{
  const fixture = makeFixture({ liveProjects: false });
  let architect;
  let land;
  let adoption;
  try {
    fixture.setService("qq-relay", {
      hang() {},
      clear() {},
      alias: () => "projects",
      async send() { return { status: "sent" }; },
    });
    land = createLand({
      ctx: fixture.ctx,
      store: createDelegationStore(join(fixture.root, "land")),
      agents: fixture.agents,
      tasks: { async archive(id) { return id; } },
      complete: async () => "land",
      github: {},
    });
    architect = createArchitect({
      ctx: fixture.ctx,
      cases: {
        open() {},
        ensure() {},
        load() { return { text: "# Implement\n\nDelegate from the projects chair.\n" }; },
        taskId() { return "projects-chair"; },
        consume() { return "projects-chair"; },
      },
      folder: { pending: () => undefined, decide: () => ({ action: "keep" }) },
      agents: fixture.agents,
      onInvokeChild: async (child, info) => {
        adoption = await (land.adoptImplementation ?? land.adoptImplementer).call(land, child, info);
        return adoption;
      },
    });

    const projects = await fixture.service.createProjects();
    const parent = fixture.agents.get(projects.id);
    architect.attach(parent);
    const delegated = await architect.delegate({ agent: parent });

    assert.equal(delegated.status, "ok", delegated.reason);
    const child = fixture.agents.get(delegated.child);
    assert.ok(child, "delegated implementer must remain live after Land adoption");
    const childCwd = realpathSync(child.session.header.cwd);
    const gitRoot = realpathSync(fixture.service.gitRootForDelegate(fixture.service.projectsRoot));
    assert.notEqual(childCwd, realpathSync(fixture.service.projectsRoot));
    assert.notEqual(childCwd, gitRoot, "delegate must use an isolated capsule, not the primary checkout");
    assert.equal(existsSync(join(childCwd, ".git")), false, "delegate workspace must not expose Git metadata");
    assert.equal(adoption?.status, "ok", adoption?.reason);
    assert.doesNotMatch(adoption?.reason ?? "", /not a git worktree/i);
    assert.equal(adoption?.owned, true);
    assert.deepEqual(land.ownedChildren(), [delegated.child]);
    const delegation = land.bySession(delegated.child);
    assert.equal(realpathSync(delegation.workspace), childCwd);
    const retainedWorktree = realpathSync(delegation.worktree);
    assert.notEqual(retainedWorktree, childCwd, "host Git capsule must stay outside the child workspace");
    assert.equal(
      execFileSync("git", ["-C", retainedWorktree, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(),
      retainedWorktree,
    );
    assertProjectsDefaultSurface(fixture, projects.id);
    assertNotProjectsFenced(fixture, delegated.child);
  } finally {
    await adoption?.rollback?.("projects-chair test cleanup");
    await architect?.dispose?.();
    await land?.dispose?.();
    fixture.cleanup();
  }
}

const clearId = await replacement("/clear", "replace");
const newId = await replacement("/new", "create");
assert.notEqual(newId, clearId, "/new and /clear must each mint a fresh session id");

{
  const fixture = makeFixture({ liveProjects: false });
  try {
    const project = await fixture.service.create();
    const home = await fixture.service.createHome();
    assertDefaultSurface(fixture, project.id);
    assertDefaultSurface(fixture, home.id);
    assert.equal(typeof fixture.service.surface.allow, "function");
    fixture.service.surface.allow(fixture.agents.get(project.id), ["bash"]);
    const projectSetup = fixture.setupRecords.find((record) => record.id === project.id);
    assert.deepEqual(activeFilters(projectSetup), [{ allow: ["bash"] }]);
  } finally {
    fixture.cleanup();
  }
}

{
  const fixture = makeFixture();
  try {
    const existing = await fixture.service.createProjects();
    const beforeCreates = fixture.createCalls;
    const ensured = await fixture.service.createProjects();
    assert.equal(existing.id, OLD_PROJECTS_ID);
    assert.equal(ensured.id, OLD_PROJECTS_ID);
    assert.equal(ensured.alias, "projects");
    assert.equal(fixture.createCalls, beforeCreates);
    assert.equal(fixture.resumeCalls, 0);
    assert.deepEqual(persistedProjectsRows(fixture).map((row) => row.id), [OLD_PROJECTS_ID]);
  } finally {
    fixture.cleanup();
  }
}

{
  const fixture = makeFixture({ liveProjects: false, staleProjects: true });
  try {
    const created = await fixture.service.createProjects();
    assert.notEqual(created.id, STALE_PROJECTS_ID);
    assert.equal(fixture.createCalls, 1);
    assert.equal(fixture.resumeCalls, 0, "ensure must not resume a stale Projects header");
    assert.deepEqual(projectsAgents(fixture).map((agent) => agent.session.id), [created.id]);
    assert.deepEqual(persistedProjectsRows(fixture).map((row) => row.id), [created.id]);
    assert.equal(projectsAliasHolder(fixture), created.id);
    assertProjectsDefaultSurface(fixture, created.id);
  } finally {
    fixture.cleanup();
  }
}

{
  const fixture = makeFixture({ liveProjects: false, staleProjects: true });
  try {
    const resumed = await fixture.service.resume(STALE_PROJECTS_ID);
    assert.equal(resumed.id, STALE_PROJECTS_ID);
    assert.equal(fixture.createCalls, 0);
    assert.equal(fixture.resumeCalls, 1);
    assert.equal(projectsAliasHolder(fixture), STALE_PROJECTS_ID);
    assertProjectsDefaultSurface(fixture, STALE_PROJECTS_ID);
  } finally {
    fixture.cleanup();
  }
}

{
  const fixture = makeFixture();
  try {
    await fixture.service.createProjects();
    fixture.failNextCreate();
    await assert.rejects(
      fixture.service.prompt(OLD_PROJECTS_ID, "/clear"),
      /fake: create failed/,
    );
    assert.equal(fixture.agents.get(OLD_PROJECTS_ID)?.status, "idle");
    assert.deepEqual(projectsAgents(fixture).map((agent) => agent.session.id), [OLD_PROJECTS_ID]);
    assert.deepEqual(persistedProjectsRows(fixture).map((row) => row.id), [OLD_PROJECTS_ID]);
    assert.equal(projectsAliasHolder(fixture), OLD_PROJECTS_ID);
  } finally {
    fixture.cleanup();
  }
}

{
  const fixture = makeFixture();
  try {
    await fixture.service.createProjects();
    fixture.agents.get(OLD_PROJECTS_ID).status = "running";
    const beforeCreates = fixture.createCalls;
    const cleared = await fixture.service.prompt(OLD_PROJECTS_ID, "/clear");
    assert.equal(cleared.action, "replace");
    assert.notEqual(cleared.id, OLD_PROJECTS_ID);
    assert.equal(fixture.createCalls, beforeCreates + 1);
    assert.equal(fixture.agents.get(OLD_PROJECTS_ID), undefined, "running chair detaches synchronously");
    assert.deepEqual(projectsAgents(fixture).map((agent) => agent.session.id), [cleared.id]);
    assert.equal(projectsAliasHolder(fixture), cleared.id);
  } finally {
    fixture.cleanup();
  }
}

{
  const fixture = makeFixture();
  try {
    await fixture.service.createProjects();
    fixture.agents.get(OLD_PROJECTS_ID).status = "running";
    const closed = await fixture.service.prompt(OLD_PROJECTS_ID, "/close");
    assert.equal(closed.action, "close");
    assert.equal(closed.closed, OLD_PROJECTS_ID);
    assert.equal(fixture.agents.get(OLD_PROJECTS_ID), undefined, "running chair closes synchronously");
  } finally {
    fixture.cleanup();
  }
}

{
  const fixture = makeFixture({ liveProjects: false });
  try {
    const projects = await fixture.service.createProjects();
    const createBeforeReload = fixture.agents.create;
    fixture.reload();
    assert.equal(
      fixture.agents.create,
      createBeforeReload,
      "HMR must reuse the delegate create wrapper instead of stacking setup()",
    );

    const reloaded = await fixture.service.createProjects();
    assert.equal(reloaded.id, projects.id);
    const projectsAgent = fixture.agents.get(projects.id);
    const allowed = fixture.service.surface.allow(projectsAgent, ["bash", "write", "edit"]);
    assert.deepEqual(allowed, ["bash", "write", "edit"]);
    const projectsSetup = fixture.setupRecords.find((record) => record.id === projects.id);
    assert.deepEqual(
      activeFilters(projectsSetup),
      [{ allow: ["bash", "write", "edit"] }],
      "Projects allow-list must replace the empty default after HMR",
    );
    for (const name of allowed) {
      const tool = projectsAgent.ctx.tools.get(name, projectsAgent);
      assert.equal(typeof tool?.execute, "function", `${name} must be visible on Projects`);
      assert.equal(guardReason(projectsSetup, name), undefined, `${name} must be executable on Projects`);
      await tool.execute();
    }

    const home = await fixture.service.createHome();
    fixture.service.surface.allow(fixture.agents.get(home.id), ["bash"]);
    const homeSetup = fixture.setupRecords.find((record) => record.id === home.id);
    assert.deepEqual(
      activeFilters(homeSetup),
      [{ allow: ["bash"] }],
      "surface.allow must unhide tools on agents created after qq-core HMR",
    );
  } finally {
    fixture.cleanup();
  }
}

{
  const fixture = makeFixture();
  try {
    const agent = fixture.agents.get(BOOT_ID);
    agent.session.header.createdAt = 1_234;
    const LARGE_EVENT_COUNT = 20_000;
    const source = Array.from({ length: LARGE_EVENT_COUNT }, (_, seq) => ({
      type: "test/event",
      seq,
      time: seq === 10 ? 900_000 : seq,
      data: {},
    }));
    const counted = countedEvents(source);
    agent.session.events = counted.events;
    agent.session.seq = LARGE_EVENT_COUNT;

    fixture.service.inspectAgent(BOOT_ID);
    assert.equal(counted.reads, LARGE_EVENT_COUNT, "first live recency read indexes the transcript once");
    const initial = await fixture.service.inspect(BOOT_ID);
    assert.equal(initial.createdAt, 1_234);
    assert.equal(initial.latestEventAt, 900_000);

    const afterInitialScan = counted.reads;
    for (let index = 0; index < 8; index += 1) {
      fixture.service.listAgents();
      fixture.service.inspectAgent(BOOT_ID);
      await fixture.service.list();
      const inspected = await fixture.service.inspect(BOOT_ID);
      assert.equal(inspected.latestEventAt, 900_000);
    }
    assert.equal(
      counted.reads,
      afterInitialScan,
      "repeated catalog, row, and inspect reads must not revisit the transcript",
    );

    // Warm the ordinary session snapshot once. Later cached snapshot identity
    // stamping calls rowFor(), but must not rescan recency.
    await fixture.service.read(BOOT_ID);
    const afterSnapshotWarm = counted.reads;
    for (let index = 0; index < 8; index += 1) await fixture.service.read(BOOT_ID);
    assert.equal(
      counted.reads,
      afterSnapshotWarm,
      "cached snapshot identity stamping must keep recency work bounded",
    );

    const newer = {
      type: "turn/start",
      seq: agent.session.seq,
      time: 1_000_000,
      data: { turn: 1 },
    };
    agent.session.events.push(newer);
    agent.session.seq += 1;
    const beforeNewer = counted.reads;
    fixture.emit("session/event", agent.session, newer);
    assert.equal(counted.reads - beforeNewer, 1, "one append visits only the new durable event");
    assert.equal((await fixture.service.inspect(BOOT_ID)).latestEventAt, 1_000_000);

    const olderOutOfOrder = {
      type: "turn/end",
      seq: agent.session.seq,
      time: 50,
      data: { turn: 1, reason: { kind: "done" } },
    };
    agent.session.events.push(olderOutOfOrder);
    agent.session.seq += 1;
    const beforeOlder = counted.reads;
    fixture.emit("session/event", agent.session, olderOutOfOrder);
    assert.equal(counted.reads - beforeOlder, 1, "out-of-order append remains constant work");
    assert.equal((await fixture.service.inspect(BOOT_ID)).latestEventAt, 1_000_000);

    const beforeHmr = counted.reads;
    const replacementModule = await import(`../src/session.mjs?recency-hmr=${Date.now()}`);
    fixture.reload(replacementModule.createQqService);
    assert.equal((await fixture.service.inspect(BOOT_ID)).latestEventAt, 1_000_000);
    assert.equal(
      counted.reads,
      beforeHmr,
      "a fresh qq-core module must adopt the Agent-owned recency index",
    );

    const oldAgent = agent;
    const replacementHandle = await fixture.agents.create({
      sessionId: BOOT_ID,
      meta: { cwd: oldAgent.session.header.cwd, createdAt: 7_654 },
      setup() {},
    });
    const replacement = replacementHandle.agent;
    const replacementCounted = countedEvents([{
      type: "test/event",
      seq: 0,
      time: 77,
      data: {},
    }]);
    replacement.session.events = replacementCounted.events;
    replacement.session.seq = 1;
    const replacementRow = await fixture.service.inspect(BOOT_ID);
    assert.equal(replacementRow.createdAt, 7_654);
    assert.equal(replacementRow.latestEventAt, 77);
    assert.equal(replacementCounted.reads, 1, "a replacement Agent gets its own generation index");

    fixture.emit("agent/disposed", { agent: oldAgent });
    const staleEvent = {
      type: "turn/start",
      seq: oldAgent.session.seq,
      time: 2_000_000,
      data: { turn: 2 },
    };
    oldAgent.session.events.push(staleEvent);
    oldAgent.session.seq += 1;
    fixture.emit("session/event", oldAgent.session, staleEvent);
    assert.equal(
      (await fixture.service.inspect(BOOT_ID)).latestEventAt,
      77,
      "a disposed generation's event cannot poison its same-id replacement",
    );
  } finally {
    fixture.cleanup();
  }
}

{
  const fixture = makeFixture();
  try {
    const beforeSecondProjects = fixture.rngCalls;
    const secondProjects = await fixture.agents.create({
      sessionId: STALE_PROJECTS_ID,
      meta: { cwd: fixture.service.projectsRoot },
      setup() {},
    });
    fixture.service.listAgents();
    assert.ok(
      fixture.rngCalls > beforeSecondProjects,
      "the multi-Projects transition must exercise reserved-alias re-dealing",
    );
    const stableRngCalls = fixture.rngCalls;
    for (let index = 0; index < 20; index += 1) {
      fixture.service.listAgents();
      await fixture.service.list();
    }
    assert.equal(
      fixture.rngCalls,
      stableRngCalls,
      "unchanged polling must not re-pin/re-deal the same live alias set",
    );

    await secondProjects.dispose();
    fixture.service.listAgents();
    assert.equal(projectsAliasHolder(fixture), OLD_PROJECTS_ID, "Projects pin follows the live-set transition");
    const afterDisposeRngCalls = fixture.rngCalls;
    for (let index = 0; index < 20; index += 1) fixture.service.listAgents();
    assert.equal(
      fixture.rngCalls,
      afterDisposeRngCalls,
      "the post-disposal live set also remains stable across polling",
    );
  } finally {
    fixture.cleanup();
  }
}

const CLIENT_MESSAGE_ID = "123e4567-e89b-42d3-a456-426614174000";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

{
  const fixture = makeFixture();
  try {
    await fixture.service.createProjects();
    const result = await fixture.service.prompt(OLD_PROJECTS_ID, "correlated prompt", {
      clientMessageId: CLIENT_MESSAGE_ID,
    });
    const message = fixture.agents.get(OLD_PROJECTS_ID).inbox.nextTurn.at(-1);
    assert.equal(result.kind, "accepted");
    assert.equal(result.mode, "followup");
    assert.equal(result.messageId, message.id);
    assert.match(message.id, UUID_PATTERN);
    assert.notEqual(message.id, CLIENT_MESSAGE_ID);
    assert.deepEqual(message.source, { kind: "user", clientMessageId: CLIENT_MESSAGE_ID });
  } finally {
    fixture.cleanup();
  }
}

{
  const fixture = makeFixture();
  try {
    await fixture.service.createProjects();
    const result = await fixture.service.prompt(OLD_PROJECTS_ID, "uncorrelated prompt");
    const message = fixture.agents.get(OLD_PROJECTS_ID).inbox.nextTurn.at(-1);
    assert.equal(result.messageId, message.id);
    assert.deepEqual(message.source, { kind: "user" });
    assert.equal(Object.hasOwn(message.source, "clientMessageId"), false);
  } finally {
    fixture.cleanup();
  }
}

{
  const fixture = makeFixture();
  try {
    await fixture.service.createProjects();
    for (const clientMessageId of [
      "",
      "not-a-uuid",
      42,
      null,
      "00000000-0000-0000-0000-000000000000",
      "123e4567-e89b-42d3-c456-426614174000",
    ]) {
      await assert.rejects(
        fixture.service.prompt(OLD_PROJECTS_ID, "rejected prompt", { clientMessageId }),
        (error) => error?.status === 400 && /clientMessageId must be a UUID/.test(error.message),
      );
    }
    assert.deepEqual(fixture.agents.get(OLD_PROJECTS_ID).inbox.nextTurn, []);
    assert.deepEqual(fixture.agents.get(OLD_PROJECTS_ID).inbox.nextStep, []);
  } finally {
    fixture.cleanup();
  }
}

function correlatedMessage(id, clientMessageId) {
  const correlation = arguments.length < 2 ? CLIENT_MESSAGE_ID : clientMessageId;
  return {
    id,
    role: "user",
    content: [{ type: "text", text: id }],
    source: {
      kind: "user",
      ...(correlation === undefined ? {} : { clientMessageId: correlation }),
    },
  };
}

function inboxProjection(target, message, state) {
  const events = [{
    type: "agent/inbox/spliced",
    seq: 1,
    time: 1,
    data: { target, start: 0, removedCount: 0, inserted: [message] },
  }];
  if (state === "pending") return projectConversation(events);
  events.push({
    type: "agent/inbox/spliced",
    seq: 2,
    time: 2,
    data: { target, start: 0, removedCount: 1, inserted: [] },
  });
  if (state === "claimed") return projectConversation(events);
  events.push({
    type: "user/message",
    seq: 3,
    time: 3,
    surfaceOp: "append",
    data: message,
  });
  return projectConversation(events);
}

for (const target of ["next-turn", "next-step"]) {
  const message = correlatedMessage(`authoritative-${target}`);
  const kind = target === "next-step" ? "steering" : "user";
  const placement = target === "next-step" ? "steering" : "queued";

  const pending = inboxProjection(target, message, "pending");
  assert.equal(pending.nodes.length, 0);
  assert.equal(pending.pending.length, 1);
  assert.equal(pending.pending[0].id, message.id);
  assert.equal(pending.pending[0].target, target);
  assert.equal(pending.pending[0].placement, placement);
  assert.equal(pending.pending[0].clientMessageId, CLIENT_MESSAGE_ID);

  const claimed = inboxProjection(target, message, "claimed");
  assert.equal(claimed.pending.length, 0);
  assert.equal(claimed.nodes.length, 1);
  assert.equal(claimed.nodes[0].kind, kind);
  assert.equal(claimed.nodes[0].messageId, message.id);
  assert.equal(claimed.nodes[0].clientMessageId, CLIENT_MESSAGE_ID);
  assert.equal(claimed.nodes[0].claimed, true);

  const durable = inboxProjection(target, message, "durable");
  assert.equal(durable.pending.length, 0);
  assert.equal(durable.nodes.length, 1);
  assert.equal(durable.nodes[0].kind, kind);
  assert.equal(durable.nodes[0].messageId, message.id);
  assert.equal(durable.nodes[0].clientMessageId, CLIENT_MESSAGE_ID);
  assert.equal(durable.nodes[0].claimed, false);
  assert.equal(durable.nodes[0].durable, true);
}

{
  const message = correlatedMessage("authoritative-without-correlation", undefined);
  const pending = inboxProjection("next-turn", message, "pending").pending[0];
  const claimed = inboxProjection("next-turn", message, "claimed").nodes[0];
  const durable = inboxProjection("next-turn", message, "durable").nodes[0];
  assert.equal(Object.hasOwn(pending, "clientMessageId"), false);
  assert.equal(Object.hasOwn(claimed, "clientMessageId"), false);
  assert.equal(Object.hasOwn(durable, "clientMessageId"), false);
}

console.log("qq-core reserved Projects chair: ok");
