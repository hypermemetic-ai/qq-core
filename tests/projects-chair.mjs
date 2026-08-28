import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createQqService } from "../src/session.mjs";

const BOOT_ID = "session-10000000-0000-4000-8000-000000000001";
const OLD_PROJECTS_ID = "session-20000000-0000-4000-8000-000000000002";
const STALE_PROJECTS_ID = "session-30000000-0000-4000-8000-000000000003";

function makeFixture({ liveProjects = true, staleProjects = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "qq-core-projects-chair-"));
  const projectsRoot = join(root, "projects");
  const bootCwd = join(projectsRoot, "qq-core");
  mkdirSync(bootCwd, { recursive: true });

  const headers = new Map();
  const store = new Map();
  const setupRecords = [];
  let createFailure;
  let createCalls = 0;
  let resumeCalls = 0;

  function header(id, cwd) {
    return { id, cwd, createdAt: Date.now() };
  }

  function makeAgent(id, cwd, setup) {
    const restricted = [];
    const guards = [];
    const tools = {
      restrict(rule) { restricted.push(...(rule?.deny ?? [])); },
      guard(fn) { guards.push(fn); },
    };
    const agentCtx = {
      tools,
      get(name) { return name === "tools" ? tools : undefined; },
      on() {},
    };
    setup?.(agentCtx);
    if (setup) setupRecords.push({ id, restricted, guards });
    return {
      status: "idle",
      ctx: agentCtx,
      session: {
        id,
        header: header(id, cwd),
        events: [],
        seq: 0,
      },
      cancel() {},
      async whenIdle() {},
    };
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
      const agent = makeAgent(options.sessionId, options.meta.cwd, options.setup);
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

  return {
    root,
    service,
    agents,
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

function assertProjectsFence(fixture, id) {
  const setup = fixture.setupRecords.find((record) => record.id === id);
  assert.ok(setup, `missing setup record for ${id}`);
  assert.deepEqual(new Set(setup.restricted), new Set(["bash", "write", "edit"]));
  assert.equal(setup.guards.length, 1);
  for (const name of ["bash", "write", "edit"]) {
    assert.match(setup.guards[0]({ name }), /does not write the filesystem/);
  }
  assert.equal(setup.guards[0]({ name: "read" }), undefined);
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

const clearId = await replacement("/clear", "replace");
const newId = await replacement("/new", "create");
assert.notEqual(newId, clearId, "/new and /clear must each mint a fresh session id");

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
