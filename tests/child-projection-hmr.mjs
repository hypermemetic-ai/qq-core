#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CHILD_PROJECTION, createQqService } from "../src/session.mjs";

const PARENT_ID = "session-10000000-0000-4000-8000-000000000001";
const CHILD_ID = "session-20000000-0000-4000-8000-000000000002";

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "qq-core-child-projection-"));
  const projectsRoot = join(root, "projects");
  const cwd = join(projectsRoot, "qq-core");
  mkdirSync(cwd, { recursive: true });

  const listeners = new Map();
  let scopedEffects = [];
  const store = new Map();
  const headers = new Map();
  const services = new Map();

  function on(type, listener) {
    let set = listeners.get(type);
    if (!set) {
      set = new Set();
      listeners.set(type, set);
    }
    set.add(listener);
    let active = true;
    const off = () => {
      if (!active) return;
      active = false;
      set.delete(listener);
      if (set.size === 0) listeners.delete(type);
    };
    scopedEffects.push(off);
    return off;
  }

  function emit(type, ...args) {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(...args);
  }

  function makeAgent(id, meta, { trapHistory = false } = {}) {
    const history = [];
    let forbidIteration = false;
    const events = trapHistory
      ? new Proxy(history, {
          get(target, property, receiver) {
            if (forbidIteration && property === Symbol.iterator) {
              throw new Error("full child history replayed");
            }
            return Reflect.get(target, property, receiver);
          },
        })
      : history;
    const session = {
      id,
      header: { id, createdAt: 1, ...meta },
      events,
      seq: 0,
    };
    const agent = {
      status: "idle",
      session,
      inbox: { nextTurn: [], nextStep: [] },
      cancel() {},
      async whenIdle() {},
    };
    return {
      agent,
      history,
      forbidHistoryIteration() { forbidIteration = true; },
    };
  }

  const parent = makeAgent(PARENT_ID, { cwd }).agent;
  store.set(PARENT_ID, parent);
  headers.set(PARENT_ID, { ...parent.session.header });

  const agents = {
    get(id) { return store.get(id); },
    list() { return [...store.values()]; },
    async create() { throw new Error("unexpected create"); },
    async resume() { throw new Error("unexpected resume"); },
  };
  services.set("agents", agents);
  services.set("sessions", { async flush(session) { headers.set(session.id, { ...session.header }); } });
  services.set("sessionPersistence", { async list() { return [...headers.values()]; } });
  services.set("loader", { async await() {} });

  const ctx = {
    get(name) { return services.get(name); },
    on,
    effect(factory) {
      const off = factory();
      if (typeof off === "function") scopedEffects.push(off);
      return off;
    },
    logger: { warn() {} },
  };
  const config = {
    sessionId: PARENT_ID,
    cwd,
    projectsRoot,
    provider: "fixture-provider",
    model: "fixture-model",
    aliasFile: join(root, "state", "aliases.json"),
    liveChairsFile: join(root, "state", "chairs.json"),
    scratchRoot: join(root, "scratch"),
    scopeFile: join(root, "state", "scopes.json"),
    now: () => 1,
    rng: () => 0,
  };
  let service = createQqService(ctx, config);
  services.set("qq-core", service);

  function addChild(id = CHILD_ID) {
    const child = makeAgent(id, {
      cwd,
      origin: "subagent",
      parentSession: PARENT_ID,
    }, { trapHistory: true });
    child.agent.status = "running";
    store.set(id, child.agent);
    headers.set(id, { ...child.agent.session.header });
    emit("agent/created", { agent: child.agent });
    return child;
  }

  function append(child, type, data) {
    const event = {
      type,
      data,
      seq: child.agent.session.seq,
      time: child.agent.session.seq + 10,
      surfaceOp: "append",
    };
    child.history.push(event);
    child.agent.session.seq += 1;
    emit("session/event", child.agent.session, event);
    return event;
  }

  function reload() {
    for (const off of scopedEffects.splice(0).reverse()) off();
    service = createQqService(ctx, config);
    services.set("qq-core", service);
    return service;
  }

  function disposeChild(child) {
    if (store.get(child.agent.session.id) === child.agent) store.delete(child.agent.session.id);
    emit("agent/disposed", { agent: child.agent });
  }

  return {
    root,
    get service() { return service; },
    addChild,
    append,
    reload,
    disposeChild,
    emit,
    listenerCount(type) { return listeners.get(type)?.size ?? 0; },
    cleanup() {
      for (const off of scopedEffects.splice(0).reverse()) off();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const fixture = makeFixture();
try {
  // Settle boot before creating the child: its first projection must be seeded
  // by the live creation event, not by a page or SSE observer.
  await fixture.service.read(PARENT_ID);
  const child = fixture.addChild();
  assert.ok(child.agent[CHILD_PROJECTION], "live child creation retains an Agent-owned projection");

  fixture.append(child, "turn/start", { turn: 1 });
  for (let index = 0; index < 32; index += 1) {
    fixture.append(child, "user/message", {
      id: `message-${index}`,
      role: "user",
      content: [{ type: "text", text: `delegated event ${index}` }],
      source: { kind: "user" },
    });
  }
  assert.equal(child.agent[CHILD_PROJECTION].seq, 33, "unobserved child stays incrementally current");
  assert.equal(child.agent[CHILD_PROJECTION].snapshot.turnStatus.openTurn, 1);
  assert.equal(child.agent[CHILD_PROJECTION].conversation.nodes.length, 32);
  await assert.rejects(
    fixture.service.prompt(CHILD_ID, "not authorized"),
    (error) => error?.status === 403 && error?.code === "child-observe-only",
  );
  assert.equal(fixture.listenerCount("session/event"), 1);

  // Any rebuild, recency scan, or other full-history walk now fails
  // deterministically. Reapply and both bootstrap paths must use the retained
  // fold instead.
  const retainedBeforeReload = child.agent[CHILD_PROJECTION];
  child.forbidHistoryIteration();
  fixture.reload();
  assert.equal(
    child.agent[CHILD_PROJECTION],
    retainedBeforeReload,
    "HMR adopts the exact retained incremental projection",
  );
  assert.equal(fixture.listenerCount("session/event"), 1, "HMR replaces rather than duplicates the event listener");

  const page = await fixture.service.read(CHILD_ID);
  assert.equal(page.origin, "subagent");
  assert.equal(page.parent, PARENT_ID);
  assert.equal(page.conversation.nodes.length, 32);

  const bootstrap = await new Promise((resolve, reject) => {
    let stop;
    const timeout = setTimeout(() => reject(new Error("child bootstrap did not settle")), 1_000);
    stop = fixture.service.observe(CHILD_ID, (error, snapshot) => {
      if (error) {
        clearTimeout(timeout);
        stop?.();
        reject(error);
        return;
      }
      clearTimeout(timeout);
      stop?.();
      resolve(snapshot);
    }, { intervalMs: 60_000 });
  });
  assert.equal(bootstrap.conversation.nodes.length, 32);
  assert.equal(bootstrap.origin, "subagent");

  fixture.append(child, "user/message", {
    id: "message-after-hmr",
    role: "user",
    content: [{ type: "text", text: "continued after HMR" }],
    source: { kind: "user" },
  });
  assert.equal(child.agent[CHILD_PROJECTION].seq, 34);
  const continued = await fixture.service.read(CHILD_ID);
  assert.equal(continued.conversation.nodes.length, 33, "post-HMR event applies exactly once");
  assert.equal(
    continued.conversation.nodes.filter((node) => node.messageId === "message-after-hmr").length,
    1,
  );

  // Actual Agent death releases the retained fold. A delayed event from that
  // generation cannot contaminate a replacement with the same id.
  const oldSession = child.agent.session;
  const replacement = fixture.addChild();
  const stale = { type: "turn/start", seq: 34, time: 99, data: { turn: 2 } };
  child.history.push(stale);
  fixture.emit("session/event", oldSession, stale);
  assert.equal(replacement.agent[CHILD_PROJECTION].seq, 0, "stale generation event is ignored");
  fixture.disposeChild(child);
  assert.equal(child.agent[CHILD_PROJECTION], undefined, "disposed child projection is released");
  assert.equal(
    replacement.agent[CHILD_PROJECTION].seq,
    0,
    "late old-generation disposal preserves the replacement projection",
  );
  assert.equal((await fixture.service.read(CHILD_ID)).conversation.nodes.length, 0);
} finally {
  fixture.cleanup();
}

console.log("qq-core retained child projection across HMR: ok");
