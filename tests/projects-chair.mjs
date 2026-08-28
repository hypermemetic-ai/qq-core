import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createQqService } from "../src/session.mjs";

const packageRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

function siblingProject(name) {
  const envName = `QQ_${name.replace(/^qq-/, "").toUpperCase().replaceAll("-", "_")}_ROOT`;
  const configured = process.env[envName];
  const candidates = [configured, join(dirname(packageRoot), name)];
  try {
    const origin = execFileSync("git", ["-C", packageRoot, "remote", "get-url", "origin"], {
      encoding: "utf8",
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
const { createLandStore } = await import(pathToFileURL(join(workflowsRoot, "src/land-store.mjs")));

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

  function header(id, cwd) {
    return { id, cwd, createdAt: Date.now() };
  }

  function makeAgent(id, metaOrCwd, setup) {
    const meta = typeof metaOrCwd === "string" ? { cwd: metaOrCwd } : metaOrCwd;
    const restrictions = [];
    const guards = [];
    const listeners = [];
    const inherited = new Map([["bash", { name: "bash", async execute() {} }]]);
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
        return undefined;
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
  const ctx = {
    get(name) { return services.get(name); },
    logger: { warn() {} },
  };
  const files = {
    alias: join(root, "state", "aliases.json"),
    chairs: join(root, "state", "live-chairs.json"),
    scopes: join(root, "state", "scopes.json"),
    scratch: join(root, "scratch"),
  };
  const service = createQqService(ctx, {
    sessionId: BOOT_ID,
    cwd: bootCwd,
    projectsRoot,
    provider: "fake-provider",
    model: "fake-model",
    aliasFile: files.alias,
    liveChairsFile: files.chairs,
    scratchRoot: files.scratch,
    scopeFile: files.scopes,
    rng: () => 0,
    now: () => 1,
  });
  services.set("qq", service);

  return {
    root,
    service,
    agents,
    ctx,
    setService(name, value) { services.set(name, value); },
    files,
    setupRecords,
    get createCalls() { return createCalls; },
    get resumeCalls() { return resumeCalls; },
    failNextCreate(error = new Error("fake: create failed")) { createFailure = error; },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
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
    activeFilters(setup).some((filter) => Array.isArray(filter.allow) && filter.allow.length === 0),
    true,
    "delegated agent is missing qq-core's empty default allow-list",
  );
  for (const guard of setup.guards) {
    for (const name of ["bash", "write", "edit"]) {
      assert.doesNotMatch(guard({ name, agent: setup.agent }) ?? "", /does not write the filesystem/);
    }
  }
}

function assertProjectsFence(fixture, id) {
  const setup = fixture.setupRecords.find((record) => record.id === id);
  assert.ok(setup, `missing setup record for ${id}`);
  assert.deepEqual(activeFilters(setup), [{ allow: [] }]);
  assert.equal(setup.guards.length, 1);
  for (const name of ["bash", "write", "edit"]) {
    assert.match(guardReason(setup, name), /does not write the filesystem/);
  }
  assert.match(guardReason(setup, "read"), /does not allow that inherited tool/);
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
    assertProjectsFence(fixture, result.id);
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

    assertProjectsFence(fixture, projects.id);
    assertDefaultSurface(fixture, ORIGIN_CHILD_ID);
    assertDefaultSurface(fixture, PARENT_CHILD_ID);
    assertDefaultSurface(fixture, PROJECT_CHILD_ID);
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
      store: createLandStore(join(fixture.root, "land")),
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
        adoption = await land.adoptImplementer(child, info);
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
    assert.equal(
      execFileSync("git", ["-C", childCwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(),
      childCwd,
    );
    assert.ok(statSync(join(childCwd, ".git")).isDirectory(), "capsule must own an internal .git directory");
    assert.equal(adoption?.status, "ok", adoption?.reason);
    assert.doesNotMatch(adoption?.reason ?? "", /not a git worktree/i);
    assert.equal(adoption?.owned, true);
    assert.deepEqual(land.ownedChildren(), [delegated.child]);
    assert.equal(realpathSync(land.bySession(delegated.child).worktree), childCwd);
    assertProjectsFence(fixture, projects.id);
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
    assertProjectsFence(fixture, created.id);
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
    assertProjectsFence(fixture, STALE_PROJECTS_ID);
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
    await assert.rejects(
      fixture.service.prompt(OLD_PROJECTS_ID, "/clear"),
      (error) => error?.status === 409 && /clear is unavailable while this session is running/.test(error.message),
    );
    assert.equal(fixture.createCalls, beforeCreates);
    assert.deepEqual(projectsAgents(fixture).map((agent) => agent.session.id), [OLD_PROJECTS_ID]);
    assert.deepEqual(persistedProjectsRows(fixture).map((row) => row.id), [OLD_PROJECTS_ID]);
    assert.equal(projectsAliasHolder(fixture), OLD_PROJECTS_ID);
  } finally {
    fixture.cleanup();
  }
}

console.log("qq-core reserved Projects chair: ok");
