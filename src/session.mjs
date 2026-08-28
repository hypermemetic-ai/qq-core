import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentSurface } from "./agent-surface.mjs";
import { makeAgentRow, orderAgents } from "./agent-catalog.mjs";
import { createAliasBook, defaultAliasFile, defaultLegacyAliasFile } from "./alias.mjs";
import { applyConversationEvent, deriveToolEventViews, projectConversation } from "./conversation.mjs";
import { createProjectFileService } from "./files.mjs";
import { createLiveChairStore, defaultLiveChairsFile } from "./live-chairs.mjs";
import { guardSessionPersistence } from "./session-persistence.mjs";
import { createScratchManager, defaultScratchRoot } from "./scratch.mjs";
import { createSessionScopeStore, defaultScopeFile } from "./session-scope.mjs";

const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_OBSERVE_MS = 100;
const RUNNING_CLEAR = "clear is unavailable while this session is running";
const RUNNING_CLOSE = "close is unavailable while this session is running";
const INACTIVE = "DSH session is not active";
const NOT_FOUND = "DSH session not found";
const CHILD_ORIGIN = "subagent";
const PROJECTS_ALIAS = "projects";
// AgentHandles are DSH-owned capabilities. Keep the capability on the live
// Agent so a qq fiber replacement can rebuild its index without owning or
// disposing the Agent itself.
export const AGENT_HANDLE = Symbol.for("@hypermemetic-ai/qq-core/agent-handle");
const CORDIS_ORIGINAL = Symbol.for("cordis.original");
const DELEGATE_CREATE_GUARD = Symbol.for("@hypermemetic-ai/qq-core/delegate-create-guard");

export function adoptAgentHandle(handle) {
  const owner = handle && typeof handle.dispose === "function" ? handle : undefined;
  const agent = owner?.agent ?? (handle?.session ? handle : undefined);
  if (!owner || !SESSION_ID.test(agent?.session?.id)) return handle;
  try {
    Object.defineProperty(agent, AGENT_HANDLE, {
      value: owner,
      configurable: true,
    });
  } catch {
    // Non-extensible Agents still close through the live handle map.
  }
  return handle;
}

function unwrapAgents(value) {
  const original = value?.[CORDIS_ORIGINAL];
  return original ?? value;
}

function wrapDelegateAgentCreate(value, transform) {
  const agents = unwrapAgents(value);
  if (!agents || typeof agents.create !== "function") return;
  const installed = agents[DELEGATE_CREATE_GUARD];
  if (installed?.wrapped === agents.create) {
    installed.transform = transform;
    return;
  }

  const original = agents.create;
  const state = { transform };
  const wrapped = function wrappedDelegateCreate(options, ...rest) {
    return Reflect.apply(original, this, [state.transform(options), ...rest]);
  };
  agents.create = wrapped;
  Object.defineProperty(agents, DELEGATE_CREATE_GUARD, {
    value: Object.assign(state, { wrapped }),
    configurable: true,
  });
}

/**
 * DSH binds Agent create/resume lifecycle to the accessing fiber. Plugin HMR
 * unloads that fiber and would abort in-flight turns. Operator chairs must
 * outlive a qq plugin replacement, so create/resume through the host root.
 * Close remains the handle stored on the live Agent.
 */
export function hostAgents(ctx) {
  const host = ctx?.root && typeof ctx.root.get === "function" ? ctx.root : ctx;
  const agents = typeof host.get === "function" ? host.get("agents") : undefined;
  if (agents) return agents;
  return typeof ctx?.get === "function" ? ctx.get("agents") : undefined;
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function userMessage(text) {
  return freeze({
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  });
}

function selectionSetup(selection) {
  return (agentCtx) => {
    let assembled;
    agentCtx.on(
      "system-prompt/assemble",
      async (_assembly, _context, next) => {
        const selected = selection.current;
        const result = await next();
        assembled = selected;
        if (!selected) return result;
        return {
          ...result,
          variables: {
            ...result.variables,
            provider: selected.provider,
            model: selected.model,
          },
        };
      },
    );
    agentCtx.on("agent/request", async (_payload, next) => {
      const result = await next();
      if (!assembled) return result;
      const { reasoningEffort: _inherited, ...withoutInherited } = result;
      return {
        ...withoutInherited,
        provider: assembled.provider,
        model: assembled.model,
        ...(assembled.reasoningEffort
          ? { reasoningEffort: assembled.reasoningEffort }
          : {}),
      };
    });
  };
}

function composeSetup(surface, setup) {
  return (agentCtx) => {
    surface?.setup(agentCtx);
    return setup?.(agentCtx);
  };
}

function homeSetup(selection, surface) {
  return composeSetup(surface, selectionSetup(selection));
}

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

async function waitForIdle(agent, currentAgent = () => agent) {
  // Cordis may hand a caller a traced service view whose scalar properties are
  // snapshots. Re-read the registry's exact live Agent while wake/cancel
  // converges; DSH remains the lifecycle authority.
  while (currentAgent().status !== "idle") {
    await currentAgent().whenIdle();
    if (currentAgent().status !== "idle") {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function canonicalPath(value, label) {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new Error(`qq: ${label} must be an absolute path`);
  }
  try {
    return realpathSync(value);
  } catch (error) {
    throw new Error(`qq: ${label} is not a resolvable directory`, { cause: error });
  }
}

function contained(root, candidate) {
  const rel = relative(root, candidate);
  if (!rel || rel === ".") return true;
  if (isAbsolute(rel)) return false;
  return !rel.split(sep).includes("..");
}

function isImmediateChild(root, candidate) {
  const rel = relative(root, candidate);
  if (!rel || rel === "." || isAbsolute(rel)) return false;
  const segments = rel.split(sep);
  return !segments.includes("..") && segments.length === 1;
}

function registrationName(value, label) {
  const name = String(value ?? "");
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(name)) {
    throw new Error(`qq: ${label} must be a lowercase route name`);
  }
  return name;
}

function configuredCatalog(root, registration) {
  if (registration === undefined || registration === null) return undefined;
  const config = Array.isArray(registration)
    ? { projects: registration }
    : registration;
  if (!config || typeof config !== "object" || !Array.isArray(config.projects)) {
    throw new Error("qq: projectCatalog must contain a projects array");
  }
  if (config.root !== undefined) {
    if (typeof config.root !== "string" || !config.root.startsWith("/")) {
      throw new Error("qq: projectCatalog.root must be an absolute path");
    }
    let registeredRoot;
    try {
      registeredRoot = realpathSync(config.root);
    } catch {
      // A root-scoped production catalog must not interfere with an alternate
      // projectsRoot when the ordinary operator root is absent there.
      return undefined;
    }
    if (registeredRoot !== root) return undefined;
  }
  return config.projects;
}

function hiddenRootPath(root, candidate) {
  const rel = relative(root, candidate);
  if (!rel || rel === "." || isAbsolute(rel)) return false;
  const segments = rel.split(sep).filter((segment) => segment && segment !== ".." && segment !== ".");
  return segments.some((segment) => segment.startsWith("."));
}

function listRegisteredProjects(root, registrations) {
  const projects = [];
  const projectNames = new Set();
  const registeredCwds = new Map();
  for (const registration of registrations) {
    if (!registration || typeof registration !== "object") {
      throw new Error("qq: each project registration must be an object");
    }
    const name = registrationName(registration.name, "project name");
    if (projectNames.has(name)) throw new Error(`qq: duplicate project registration ${name}`);
    projectNames.add(name);
    const label = String(registration.label ?? name).trim();
    if (!label) throw new Error(`qq: project ${name} must have a label`);
    const configuredFolders = Array.isArray(registration.folders) ? registration.folders : [];
    if (configuredFolders.length === 0) {
      throw new Error(`qq: project ${name} must register at least one folder`);
    }
    const folders = [];
    const folderNames = new Set();
    for (const registrationFolder of configuredFolders) {
      if (!registrationFolder || typeof registrationFolder !== "object") {
        throw new Error(`qq: project ${name} has an invalid folder registration`);
      }
      const folderName = registrationName(registrationFolder.name, `folder name in ${name}`);
      if (folderNames.has(folderName)) throw new Error(`qq: duplicate folder ${folderName} in project ${name}`);
      folderNames.add(folderName);
      const folderLabel = String(registrationFolder.label ?? folderName).trim();
      if (!folderLabel) throw new Error(`qq: folder ${folderName} in ${name} must have a label`);
      const path = String(registrationFolder.path ?? "");
      if (!path || path.includes("\0")) {
        throw new Error(`qq: folder ${folderName} in ${name} must have a path`);
      }
      const listed = isAbsolute(path) ? resolve(path) : resolve(root, path);
      if (!contained(root, listed) || listed === root) {
        throw new Error(`qq: registered folder ${folderName} escapes projectsRoot`);
      }
      if (hiddenRootPath(root, listed)) continue;
      let cwd;
      try {
        cwd = realpathSync(listed);
      } catch {
        // Registrations may describe optional plugins that are not installed.
        continue;
      }
      if (!contained(root, cwd)) {
        throw new Error(`qq: registered folder ${folderName} escapes projectsRoot`);
      }
      if (hiddenRootPath(root, cwd)) continue;
      let info;
      try {
        info = lstatSync(cwd);
      } catch {
        continue;
      }
      if (!info.isDirectory()) continue;
      const owner = registeredCwds.get(cwd);
      if (owner) {
        throw new Error(`qq: project folder ${cwd} is registered by both ${owner} and ${name}`);
      }
      registeredCwds.set(cwd, name);
      folders.push({ name: folderName, label: folderLabel, cwd });
    }
    if (folders.length === 0) continue;
    let projectCwd;
    if (typeof registration.path === "string" && registration.path.trim().length > 0) {
      const regPath = registration.path.trim();
      if (regPath.includes("\0")) {
        throw new Error(`qq: project ${name} has an invalid path`);
      }
      const listed = isAbsolute(regPath) ? resolve(regPath) : resolve(root, regPath);
      if (!contained(root, listed) || listed === root) {
        throw new Error(`qq: registered project ${name} escapes projectsRoot`);
      }
      if (hiddenRootPath(root, listed)) continue;
      let cwd;
      try {
        cwd = realpathSync(listed);
      } catch {
        continue;
      }
      if (!contained(root, cwd) || cwd === root) {
        throw new Error(`qq: registered project ${name} escapes projectsRoot`);
      }
      if (hiddenRootPath(root, cwd)) continue;
      let info;
      try {
        info = lstatSync(cwd);
      } catch {
        continue;
      }
      if (!info.isDirectory()) continue;
      projectCwd = cwd;
    } else {
      projectCwd = folders[0].cwd;
    }
    projects.push({
      name,
      label,
      cwd: projectCwd,
      folders,
      grouped: configuredFolders.length > 1,
    });
  }
  projects.sort((left, right) => left.label.localeCompare(right.label) || left.name.localeCompare(right.name));
  return projects;
}

/** Package-local operator catalog; re-read on every list. */
export function defaultProjectCatalogFile() {
  return join(dirname(fileURLToPath(import.meta.url)), "../project-catalog.json");
}

/**
 * Load the operator project registration from disk. `root` that is not absolute
 * is resolved under HOME (production default `projects` → `${HOME}/projects`).
 */
export function readProjectCatalogFile(path, env = process.env) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error("qq: catalogFile must be an absolute path");
  }
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error("qq: catalogFile is not readable", { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("qq: catalogFile is not valid JSON", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("qq: catalogFile must be an object");
  }
  if (!Array.isArray(parsed.projects)) {
    throw new Error("qq: projectCatalog must contain a projects array");
  }
  const home = typeof env.HOME === "string" && env.HOME.startsWith("/")
    ? env.HOME
    : homedir();
  let root = parsed.root;
  if (root === undefined || root === null || root === "") {
    root = join(home, "projects");
  } else if (typeof root !== "string") {
    throw new Error("qq: projectCatalog.root must be an absolute path");
  } else if (!root.startsWith("/")) {
    root = join(home, root);
  }
  return { root, projects: parsed.projects };
}

function loadProjectRegistration(config, env = process.env) {
  if (config.projectCatalog !== undefined) return config.projectCatalog;
  if (config.catalogFile === null) return undefined;
  if (config.catalogFile === undefined && config.projectsRoot !== undefined) {
    let customRoot;
    try {
      customRoot = resolveProjectsRoot(config.projectsRoot, env);
    } catch {
      return undefined;
    }
    let defaultRoot;
    try {
      defaultRoot = resolveProjectsRoot(undefined, env);
    } catch {
      return undefined;
    }
    if (customRoot !== defaultRoot) return undefined;
  }
  const file = config.catalogFile === undefined
    ? defaultProjectCatalogFile()
    : config.catalogFile;
  if (typeof file !== "string" || !file) return undefined;
  try {
    const parsed = readProjectCatalogFile(file, env);
    return config.catalogFile === undefined ? { ...parsed, implicit: true } : parsed;
  } catch (error) {
    if (config.catalogFile === undefined && error?.cause?.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Resolve the configured projects root; production default is ${HOME}/projects. */
export function resolveProjectsRoot(value, env = process.env) {
  const home = typeof env.HOME === "string" && env.HOME.startsWith("/")
    ? env.HOME
    : homedir();
  const raw = value === undefined || value === null
    ? join(home, "projects")
    : value;
  if (typeof raw !== "string" || !raw.startsWith("/")) {
    throw new Error("qq: projectsRoot must be an absolute path");
  }
  return canonicalPath(raw, "projectsRoot");
}

/**
 * Logical operator projects. With an explicit catalog (inline or a catalog
 * file re-read on every list), each project can own several registered
 * folders. Without one, visible immediate directories are treated as
 * one-folder projects. Symlinks may never leave projectsRoot.
 */
function listImmediateChildProjects(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    throw new Error("qq: projectsRoot is not a readable directory", { cause: error });
  }
  const projects = [];
  const seen = new Set();
  for (const entry of entries) {
    const name = entry.name;
    if (!name || name.startsWith(".")) continue;
    const listed = join(root, name);
    let info;
    try {
      info = lstatSync(listed);
    } catch {
      continue;
    }
    if (!info.isDirectory() && !info.isSymbolicLink()) continue;
    let cwd;
    try {
      cwd = realpathSync(listed);
    } catch {
      continue;
    }
    if (!isImmediateChild(root, cwd)) continue;
    const key = `${name}\0${cwd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    projects.push({
      name,
      label: name,
      cwd,
      folders: [{ name, label: name, cwd }],
      grouped: false,
    });
  }
  return projects;
}

export function listProjectCatalog(projectsRoot, registration) {
  const root = canonicalPath(projectsRoot, "projectsRoot");
  const registrations = configuredCatalog(root, registration);
  let registered = [];
  if (registrations) {
    try {
      registered = listRegisteredProjects(root, registrations);
    } catch (error) {
      if (!registration?.implicit) throw error;
    }
  }
  const claimed = new Set(registered.flatMap((project) =>
    (project.folders ?? [project]).map((folder) => folder.cwd),
  ));
  const discovered = listImmediateChildProjects(root).filter((project) => !claimed.has(project.cwd));
  const projects = [...registered, ...discovered];
  projects.sort((left, right) => left.name.localeCompare(right.name) || left.cwd.localeCompare(right.cwd));
  return projects;
}

export function isRootOperatorAgent(agent) {
  const session = agent?.session;
  if (!SESSION_ID.test(session?.id)) return false;
  const header = session.header ?? {};
  if (header.parentSession) return false;
  if (header.origin === "subagent") return false;
  const id = String(session.id);
  const parent = header.parentId ?? header.parent ?? header.parent_session;
  if (parent) return false;
  if (typeof id === "string" && id.includes("/")) return false;
  return true;
}

export function sessionRecency(session, fallbackCreatedAt = 0) {
  const events = Array.isArray(session?.events) ? session.events : [];
  let latest = 0;
  for (const event of events) {
    const time = event?.time;
    const value = typeof time === "number" ? time : Date.parse(time ?? "");
    if (Number.isFinite(value) && value > latest) latest = value;
  }
  const createdAt = Number.isFinite(session?.header?.createdAt)
    ? session.header.createdAt
    : (Number.isFinite(session?.createdAt) ? session.createdAt : fallbackCreatedAt);
  return { latest, createdAt: createdAt || 0, id: String(session?.id ?? "") };
}

export function compareSessionRecency(left, right) {
  if (right.latest !== left.latest) return right.latest - left.latest;
  if (right.createdAt !== left.createdAt) return right.createdAt - left.createdAt;
  return left.id.localeCompare(right.id);
}

function slashName(line) {
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(String(line ?? ""));
  return match ? match[1] : "";
}

async function isUserInvocableSkill(ctx, agent, name) {
  if (!name) return false;
  let skills;
  try { skills = ctx.get("skills", false); } catch { return false; }
  if (!skills || typeof skills.get !== "function") return false;
  try {
    const skill = await skills.get(name, {
      cwd: agent?.session?.header?.cwd,
      scope: agent,
    });
    return skill?.name === name && skill?.invocation?.userInvocable === true;
  } catch {
    // Skill discovery failure does not turn an unknown slash command into a
    // talking prompt. The ordinary command path retains its existing error.
    return false;
  }
}

/** Compact change token for one catalog + session snapshot. */
export function snapshotFingerprint(snapshot) {
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const last = events.at(-1);
  const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
  const pending = Array.isArray(snapshot?.conversation?.pending)
    ? snapshot.conversation.pending
    : [];
  return JSON.stringify([
    snapshot?.id,
    snapshot?.project,
    snapshot?.scope,
    snapshot?.context,
    snapshot?.agentStatus,
    events.length,
    last?.seq,
    last?.type,
    last?.data?.reason?.kind,
    pending.map((item) => [item.id, item.target, item.text]),
    sessions.map((session) => [session.id, session.createdAt, session.alias, session.project, session.scope]),
    snapshot?.alias,
  ]);
}

/**
 * Notify `listener(error, snapshot)` on the first snapshot and later changes.
 * Returns a disposer. Presentation-neutral: no HTML or transport.
 */
export function observeSnapshot(load, listener, options = {}) {
  if (typeof load !== "function" || typeof listener !== "function") {
    throw new Error("qq: observe requires load and listener functions");
  }
  const intervalMs = options.intervalMs ?? DEFAULT_OBSERVE_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error("qq: observe intervalMs must be a positive integer");
  }
  let cancelled = false;
  let timer;
  let fingerprint = options.fingerprint;
  const tick = async () => {
    if (cancelled) return;
    try {
      const snapshot = await load();
      const next = snapshotFingerprint(snapshot);
      if (next !== fingerprint) {
        fingerprint = next;
        try { listener(null, snapshot); } catch {}
      }
    } catch (error) {
      try { listener(error); } catch {}
    }
    if (cancelled) return;
    timer = setTimeout(tick, intervalMs);
    timer.unref?.();
  };
  void tick();
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

/** Add `observe()` over a list/read backend. Used by fixtures and tests. */
export function attachObserve(backend, options = {}) {
  if (!backend || typeof backend.read !== "function" || typeof backend.list !== "function") {
    throw new Error("qq: attachObserve requires list and read");
  }
  if (typeof backend.observe === "function") return backend;
  return Object.freeze({
    ...backend,
    observe(sessionId, listener, extra = {}) {
      return observeSnapshot(async () => {
        const snapshot = await backend.read(sessionId);
        const available = snapshot?.scope === "home" && typeof backend.listHome === "function"
          ? await backend.listHome()
          : snapshot?.scope === "projects"
            ? [{
                id: snapshot.id,
                createdAt: snapshot.createdAt ?? 0,
                scope: "projects",
                context: "projects",
                ...(snapshot.alias ? { alias: snapshot.alias } : {}),
              }]
            : typeof backend.list === "function"
              ? await backend.list(snapshot?.project, snapshot?.folder ?? "")
              : [];
        if (snapshot?.id && !available.some((session) => session.id === snapshot.id)) {
          available.unshift({
            id: snapshot.id,
            createdAt: 0,
            ...(snapshot.scope ? { scope: snapshot.scope } : {}),
            ...(snapshot.context ? { context: snapshot.context } : {}),
            ...(snapshot.project ? { project: snapshot.project } : {}),
            ...(snapshot.folder ? { folder: snapshot.folder } : {}),
          });
        }
        return { ...snapshot, sessions: available };
      }, listener, { ...options, ...extra });
    },
  });
}

/**
 * Adapt configured DSH Agent/Session services to a presentation-neutral API.
 * Live DSH Agents are the active catalog. Persistence keeps durable history
 * after close and identifies inactive ids. A qq-owned live-chair sidecar
 * restores root-operator sessions that were open at last shutdown.
 */
export function createQqService(ctx, config) {
  const defaultSessionId = String(config.sessionId ?? "");
  if (!SESSION_ID.test(defaultSessionId)) {
    throw new Error("qq: sessionId must be session-<UUID>");
  }
  if (typeof config.cwd !== "string" || !config.cwd.startsWith("/")) {
    throw new Error("qq: cwd must be an absolute path");
  }
  const provider = String(config.provider ?? "");
  const model = String(config.model ?? "");
  if (!provider || !model) {
    throw new Error("qq: provider and model must be selected explicitly");
  }
  const selectedModel = Object.freeze({
    provider,
    model,
    ...(config.reasoningEffort ? { reasoningEffort: String(config.reasoningEffort) } : {}),
  });

  const projectsRoot = resolveProjectsRoot(config.projectsRoot);
  const projects = listProjectCatalog(projectsRoot, loadProjectRegistration(config));
  if (projects.length === 0) {
    throw new Error("qq: projectsRoot has no operator projects");
  }
  const bootCwd = canonicalPath(config.cwd, "cwd");
  let bootProject;
  for (const project of projects) {
    const folder = (project.folders ?? [project]).find((entry) => samePath(entry.cwd, bootCwd));
    if (folder) {
      bootProject = { ...project, cwd: folder.cwd, folder };
      break;
    }
  }
  if (!bootProject) {
    for (const project of projects) {
      if (project.cwd && samePath(project.cwd, bootCwd)) {
        bootProject = { ...project, cwd: project.cwd, folder: undefined };
        break;
      }
    }
  }
  if (!bootProject) {
    throw new Error("qq: cwd must equal one project root or registered folder");
  }
  const persistKeys = ["aliasFile", "liveChairsFile", "scratchRoot", "scopeFile"];
  const missingPersist = persistKeys.filter((key) => config[key] === undefined);
  if (missingPersist.length > 0 && missingPersist.length < persistKeys.length) {
    throw new Error(
      `qq: aliasFile, liveChairsFile, scratchRoot, and scopeFile must all be set together (missing ${missingPersist.join(", ")})`,
    );
  }
  const defaultProject = bootProject.name;
  const scratch = createScratchManager({
    root: config.scratchRoot ?? defaultScratchRoot(),
    ...(config.scratchFs ? { fs: config.scratchFs } : {}),
  });
  const scopes = createSessionScopeStore({
    scratchRoot: scratch.root,
    file: config.scopeFile === null
      ? undefined
      : (config.scopeFile ?? defaultScopeFile()),
    ...(config.scopeFs ? { fs: config.scopeFs } : {}),
  });

  const agents = hostAgents(ctx);
  const sessions = ctx.get("sessions");
  const persistence = guardSessionPersistence(ctx.get("sessionPersistence"));
  if (!agents || !sessions || !persistence) {
    throw new Error("qq: required DSH services are unavailable");
  }
  const surface = createAgentSurface(ctx);

  const agentPromises = new Map();
  const handles = new Map();
  const unpublished = new Set();
  const statusSince = new Map();
  const projections = new Map();
  const sessionObservers = new Map();
  const directUserMessageObservers = new Set();
  const defaultCreatedAt = Date.now();

  function notifyDirectUserMessage(event) {
    for (const observer of [...directUserMessageObservers]) {
      try { observer(event); } catch { /* admission must not depend on an optional policy consumer */ }
    }
  }
  const clock = typeof config.now === "function" ? config.now : Date.now;
  const aliasFile = config.aliasFile !== undefined || envHasDshHome()
    ? defaultAliasFile(process.env, config)
    : undefined;
  const book = createAliasBook(aliasFile, {
    now: config.now,
    rng: config.rng,
    legacyFile: aliasFile ? defaultLegacyAliasFile(process.env) : undefined,
  });
  const liveChairsFile = config.liveChairsFile !== undefined
    ? config.liveChairsFile
    : (envHasDshHome() ? defaultLiveChairsFile(process.env, config) : null);
  const chairs = createLiveChairStore({
    file: liveChairsFile,
    ...(config.liveChairsFs ? { fs: config.liveChairsFs } : {}),
  });
  const plannedChairs = chairs.list();
  let restoreDone = false;
  if (chairs.corrupt) {
    ctx.logger?.warn?.("qq: live chair snapshot is corrupt", { file: liveChairsFile });
  }

  function envHasDshHome() {
    return typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.trim().length > 0;
  }

  function catalog() {
    return listProjectCatalog(projectsRoot, loadProjectRegistration(config));
  }

  const projectFiles = createProjectFileService(projectsRoot, catalog, {
    ...(config.readableFileLimit !== undefined ? { readableLimit: config.readableFileLimit } : {}),
    ...(config.openFileLimit !== undefined ? { openLimit: config.openFileLimit } : {}),
  });

  function projectByName(name) {
    const project = catalog().find((entry) => entry.name === name);
    if (!project) throw httpError(404, "qq: project not found");
    return project;
  }

  function projectForCwd(cwd) {
    if (typeof cwd !== "string" || !cwd.startsWith("/")) return undefined;
    let canonical = cwd;
    try {
      canonical = realpathSync(cwd);
    } catch {
      canonical = resolve(cwd);
    }
    for (const project of catalog()) {
      const folder = (project.folders ?? [project]).find((entry) => samePath(entry.cwd, canonical));
      if (folder) return { ...project, cwd: folder.cwd, folder };
    }
    for (const project of catalog()) {
      if (project.cwd && samePath(project.cwd, canonical)) {
        return { ...project, cwd: project.cwd, folder: undefined };
      }
    }
    return undefined;
  }

  function agentCwd(agent) {
    const cwd = agent?.session?.header?.cwd;
    return typeof cwd === "string" ? cwd : undefined;
  }

  function canonicalCwd(cwd) {
    if (typeof cwd !== "string" || !cwd.startsWith("/")) return undefined;
    try {
      return realpathSync(cwd);
    } catch {
      return resolve(cwd);
    }
  }

  function samePath(left, right) {
    const a = canonicalCwd(left);
    const b = canonicalCwd(right);
    return Boolean(a && b && a === b);
  }

  function gitRootForDelegate(cwd) {
    if (samePath(cwd, projectsRoot)) return bootProject.cwd;
    return canonicalCwd(cwd);
  }

  wrapDelegateAgentCreate(agents, (options = {}) => {
    const meta = options.meta;
    const child = meta?.origin === CHILD_ORIGIN
      || (meta?.parentSession !== undefined && meta?.parentSession !== null);
    const transformed = child && samePath(meta?.cwd, projectsRoot)
      ? { ...options, meta: { ...meta, cwd: gitRootForDelegate(projectsRoot) } }
      : options;
    return {
      ...transformed,
      setup: composeSetup(surface, transformed.setup),
    };
  });

  function homeWorkspace(sessionId) {
    if (!SESSION_ID.test(sessionId)) return undefined;
    try {
      return scratch.verify(sessionId);
    } catch {
      return undefined;
    }
  }

  function classifyWorkspace(agent) {
    const id = agent?.session?.id;
    if (!SESSION_ID.test(id)) return undefined;
    const cwd = agentCwd(agent);
    if (samePath(cwd, projectsRoot)) {
      return { scope: "projects", context: "projects", cwd: projectsRoot };
    }
    const project = projectForCwd(cwd);
    if (project) {
      return { scope: "project", context: "project", project, cwd: project.cwd };
    }
    const home = homeWorkspace(id);
    if (!home || !samePath(cwd, home.path)) return undefined;
    const record = scopes.get(id);
    if (record && samePath(record.cwd, home.path)) {
      return { scope: "home", context: "scratch", cwd: home.path };
    }
    if (unpublished.has(id)) {
      return { scope: "home", context: "scratch", cwd: home.path };
    }
    return undefined;
  }

  function classifyAgent(agent) {
    if (!isRootOperatorAgent(agent)) return undefined;
    return classifyWorkspace(agent);
  }

  function parentSessionOf(agent) {
    const header = agent?.session?.header ?? {};
    const parent = header.parentSession ?? header.parentId ?? header.parent ?? header.parent_session;
    return SESSION_ID.test(String(parent ?? "")) ? String(parent) : undefined;
  }

  function childRelationship(agent) {
    if (agent?.session?.header?.origin !== CHILD_ORIGIN) return undefined;
    const parentId = parentSessionOf(agent);
    if (!parentId) return undefined;
    const parent = agents.get(parentId);
    const parentWorkspace = classifyAgent(parent);
    if (!parentWorkspace || isUnpublished(parentId)) return undefined;
    const workspace = classifyWorkspace(agent) ?? parentWorkspace;
    return {
      parent: parentId,
      workspace: {
        ...workspace,
        cwd: agentCwd(agent) ?? workspace.cwd,
      },
    };
  }

  function classifyVisibleAgent(agent) {
    const chair = classifyAgent(agent);
    if (chair) return { ...chair, kind: "chair" };
    const child = childRelationship(agent);
    if (!child) return undefined;
    return { ...child.workspace, kind: "child", parent: child.parent };
  }

  function isUnpublished(sessionId) {
    return unpublished.has(sessionId);
  }

  function liveAgents() {
    const listed = typeof agents.list === "function"
      ? agents.list()
      : [agents.get(defaultSessionId)].filter(Boolean);
    return listed.filter((agent) => SESSION_ID.test(agent?.session?.id));
  }

  function liveRootAgents() {
    return liveAgents().filter((agent) => {
      const id = agent.session?.id;
      if (isUnpublished(id)) return false;
      return Boolean(classifyAgent(agent));
    });
  }

  function liveProjectAgents() {
    return liveRootAgents().filter((agent) => classifyAgent(agent)?.scope === "project");
  }

  function liveHomeAgents() {
    return liveRootAgents().filter((agent) => classifyAgent(agent)?.scope === "home");
  }

  function liveProjectsAgents() {
    return liveRootAgents().filter((agent) => classifyAgent(agent)?.scope === "projects");
  }

  function scratchCleanupError(sessionId, path, cause, action = "cleanup") {
    const error = httpError(500, `qq: home session ${action} failed`, cause?.code ?? "scratch-cleanup");
    error.sessionId = sessionId;
    if (path) error.path = path;
    if (cause) error.cause = cause;
    return error;
  }

  function liveSessionIds() {
    return liveAgents()
      .filter((agent) => !isUnpublished(agent.session?.id))
      .map((agent) => agent.session.id);
  }

  function rememberHandle(handle) {
    adoptAgentHandle(handle);
    const owner = handle && typeof handle.dispose === "function" ? handle : undefined;
    const sessionId = owner?.agent?.session?.id;
    if (SESSION_ID.test(sessionId)) handles.set(sessionId, owner);
    return handle;
  }

  const wrappedCreates = new WeakSet();
  function wrapAgentCreate(target) {
    if (!target || wrappedCreates.has(target)) return;
    if (typeof target.create === "function") {
      const create = target.create.bind(target);
      target.create = async (options) => rememberHandle(await create(options));
    }
    if (typeof target.resume === "function") {
      const resume = target.resume.bind(target);
      target.resume = async (options) => rememberHandle(await resume(options));
    }
    wrappedCreates.add(target);
  }
  wrapAgentCreate(agents);

  for (const agent of liveAgents()) {
    const handle = agent?.[AGENT_HANDLE];
    if (handle && typeof handle.dispose === "function") handles.set(agent.session.id, handle);
  }

  function syncLive(extraId) {
    const ids = liveSessionIds();
    if (SESSION_ID.test(extraId) && !isUnpublished(extraId) && !ids.includes(extraId)) {
      ids.push(extraId);
    }
    for (const agent of liveProjectsAgents()) {
      book.pin(agent.session.id, PROJECTS_ALIAS);
    }
    const extra = SESSION_ID.test(extraId) ? agents.get(extraId) : undefined;
    if (extra && classifyAgent(extra)?.scope === "projects") {
      book.pin(extraId, PROJECTS_ALIAS);
    }
    book.sync(ids);
  }

  function chairSnapshotRow(agent) {
    const classified = classifyAgent(agent);
    const id = agent?.session?.id;
    if (!classified || !SESSION_ID.test(id) || isUnpublished(id)) return undefined;
    const row = {
      id,
      cwd: classified.cwd,
      scope: classified.scope,
      context: classified.context,
    };
    if (classified.scope === "project" && classified.project?.name) {
      row.project = classified.project.name;
    }
    return row;
  }

  function persistLiveChairs() {
    try {
      const rows = [];
      for (const agent of liveRootAgents()) {
        const row = chairSnapshotRow(agent);
        if (row) rows.push(row);
      }
      chairs.replace(rows);
    } catch (error) {
      ctx.logger?.warn?.("qq: live chair persist failed", {
        file: liveChairsFile,
        message: String(error?.message ?? error),
      });
    }
  }

  function liveAlias(sessionId) {
    if (!SESSION_ID.test(sessionId) || isUnpublished(sessionId) || !agents.get(sessionId)) return undefined;
    syncLive(sessionId);
    return book.aliasFor(sessionId);
  }

  function resolveAlias(address) {
    syncLive();
    const live = liveAgents().filter((agent) => !isUnpublished(agent.session?.id));
    const exact = live.find((agent) => agent.session.id === address);
    if (exact) return exact.session.id;
    return live.find((agent) => book.aliasFor(agent.session.id) === address)?.session.id;
  }

  function rememberStatus(agent, status = agent?.status, at = clock()) {
    const sessionId = agent?.session?.id;
    if (!SESSION_ID.test(sessionId)) return;
    const value = status === "running" ? "running" : "idle";
    statusSince.set(sessionId, { status: value, at });
  }

  if (typeof ctx.on === "function") {
    ctx.on("agent/created", ({ agent }) => {
      const sessionId = agent?.session?.id;
      if (!SESSION_ID.test(sessionId) || isUnpublished(sessionId)) return;
      const handle = agent?.[AGENT_HANDLE];
      if (handle && typeof handle.dispose === "function") handles.set(sessionId, handle);
      rememberStatus(agent);
      syncLive(sessionId);
      const relationship = childRelationship(agent);
      if (relationship) rebuildAndNotify(relationship.parent);
    });
    ctx.on("agent/status", ({ agent, status }) => {
      rememberStatus(agent, status);
      const relationship = childRelationship(agent);
      if (relationship && observersFor(relationship.parent)) rebuildAndNotify(relationship.parent);
    });
    ctx.on("agent/disposed", (event = {}) => {
      const agent = event.agent;
      const sessionId = agent?.session?.id;
      const relationship = childRelationship(agent);
      if (SESSION_ID.test(sessionId)) {
        statusSince.delete(sessionId);
        projections.delete(sessionId);
      }
      if (relationship) rebuildAndNotify(relationship.parent);
      // Host shutdown disposes every Agent. That is not operator close — do
      // not persist an empty live-chair set here or restore will always be empty.
      syncLive();
    });
  }
  if (typeof ctx.effect === "function") {
    ctx.effect(() => () => book.close(), "qq: alias book");
  }
  syncLive();

  async function persistedHeaders() {
    return (await persistence.list()).filter((header) => SESSION_ID.test(header?.id));
  }

  function requireLiveAgent(sessionId) {
    if (!SESSION_ID.test(sessionId)) throw httpError(404, NOT_FOUND);
    if (isUnpublished(sessionId)) return undefined;
    const live = agents.get(sessionId);
    if (live && classifyVisibleAgent(live)) return live;
    return undefined;
  }

  async function rejectInactive(sessionId) {
    if (isUnpublished(sessionId)) throw httpError(404, NOT_FOUND);
    const headers = await persistedHeaders();
    if (headers.some((header) => header.id === sessionId)) {
      throw httpError(404, INACTIVE, "inactive");
    }
    throw httpError(404, NOT_FOUND);
  }

  async function liveAgent(sessionId) {
    const live = requireLiveAgent(sessionId);
    if (live) return live;
    await rejectInactive(sessionId);
  }

  async function liveChairAgent(sessionId) {
    const agent = await liveAgent(sessionId);
    if (!classifyAgent(agent)) {
      throw httpError(403, "qq: child sessions are observe-only", "child-observe-only");
    }
    return agent;
  }

  function createdAtFor(agent) {
    return agent.session.header?.createdAt
      ?? (agent.session.id === defaultSessionId ? defaultCreatedAt : 0);
  }

  function rowFor(agent) {
    const classified = classifyVisibleAgent(agent);
    const recency = sessionRecency(agent.session, createdAtFor(agent));
    const alias = book.aliasFor(agent.session.id);
    if (classified?.kind === "child") {
      return {
        id: agent.session.id,
        createdAt: recency.createdAt,
        latestEventAt: recency.latest,
        cwd: classified.cwd,
        scope: classified.scope,
        context: classified.context,
        origin: CHILD_ORIGIN,
        parent: classified.parent,
        ...(alias ? { alias } : {}),
      };
    }
    if (classified?.scope === "home") {
      return {
        id: agent.session.id,
        createdAt: recency.createdAt,
        latestEventAt: recency.latest,
        cwd: classified.cwd,
        scope: "home",
        context: "scratch",
        ...(alias ? { alias } : {}),
      };
    }
    if (classified?.scope === "projects") {
      return {
        id: agent.session.id,
        createdAt: recency.createdAt,
        latestEventAt: recency.latest,
        cwd: classified.cwd,
        scope: "projects",
        context: "projects",
        ...(alias ? { alias } : {}),
      };
    }
    const project = classified?.project;
    return {
      id: agent.session.id,
      createdAt: recency.createdAt,
      latestEventAt: recency.latest,
      cwd: classified?.cwd ?? project?.cwd ?? agentCwd(agent),
      scope: "project",
      context: "project",
      project: project?.name,
      projectLabel: project?.label,
      ...(project?.grouped && project?.folder?.name ? {
        folder: project.folder.name,
        folderLabel: project.folder.label ?? project.folder.name,
      } : {}),
      ...(alias ? { alias } : {}),
    };
  }

  function childRowsFor(agent) {
    if (!classifyAgent(agent)) return [];
    const parentId = agent.session.id;
    return liveAgents()
      .filter((candidate) => !isUnpublished(candidate?.session?.id))
      .map((candidate) => ({ candidate, relationship: childRelationship(candidate) }))
      .filter(({ relationship }) => relationship?.parent === parentId)
      .map(({ candidate }) => {
        const alias = book.aliasFor(candidate.session.id);
        return {
          id: candidate.session.id,
          ...(alias ? { alias } : {}),
          status: candidate.status === "running" ? "running" : "idle",
        };
      })
      .sort((left, right) => String(left.alias ?? left.id).localeCompare(String(right.alias ?? right.id)));
  }

  function relationshipFields(agent) {
    const classified = classifyVisibleAgent(agent);
    if (classified?.kind === "child") {
      const parentAlias = book.aliasFor(classified.parent);
      return {
        origin: CHILD_ORIGIN,
        parent: classified.parent,
        ...(parentAlias ? { parentAlias } : {}),
        children: [],
      };
    }
    return { children: childRowsFor(agent) };
  }

  function stampIdentity(agent, snapshot) {
    const row = rowFor(agent);
    const relationship = relationshipFields(agent);
    const next = {
      ...snapshot,
      ...relationship,
      cwd: row.cwd,
      scope: row.scope,
      context: row.context,
      agentStatus: agent?.status ?? snapshot?.agentStatus,
    };
    if (relationship.origin !== CHILD_ORIGIN) {
      delete next.origin;
      delete next.parent;
      delete next.parentAlias;
    }
    if (row.project) {
      next.project = row.project;
      next.projectLabel = row.projectLabel;
    } else {
      delete next.project;
      delete next.projectLabel;
    }
    if (row.folder) {
      next.folder = row.folder;
      next.folderLabel = row.folderLabel;
    } else {
      delete next.folder;
      delete next.folderLabel;
    }
    return next;
  }

  async function resumeChair(sessionId, header) {
    const cwd = header?.cwd;
    const setup = homeSetup({ current: selectedModel }, surface);
    const handle = rememberHandle(await agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: selectedModel.provider, model: selectedModel.model },
      setup,
    }));
    await ctx.get("loader")?.await();
    syncLive(sessionId);
    return handle.agent ?? handle;
  }

  function restoreSkipReason(planned, header) {
    if (!header) return "missing-persistence";
    const cwd = header.cwd;
    if (typeof cwd !== "string") return "missing-cwd";
    const isProjects = samePath(cwd, projectsRoot);
    const project = projectForCwd(cwd);
    if (planned.scope === "project" && !project) return "missing-project";
    if (planned.scope === "projects" && !isProjects) return "missing-cwd";
    if (planned.scope === "home") {
      const home = homeWorkspace(planned.id);
      if (!home || !samePath(cwd, home.path)) return "missing-cwd";
      return undefined;
    }
    if (!isProjects && !project) return "missing-project";
    return undefined;
  }

  async function restorePlannedChairs() {
    if (restoreDone) return;
    restoreDone = true;
    if (!chairs.corrupt) {
      try {
        const headers = await persistedHeaders();
        const byId = new Map(headers.map((header) => [header.id, header]));
        for (const planned of plannedChairs) {
          if (requireLiveAgent(planned.id)) continue;
          const header = byId.get(planned.id);
          if (restoreSkipReason(planned, header)) continue;
          try {
            await resumeChair(planned.id, header);
          } catch (error) {
            ctx.logger?.warn?.("qq: live chair restore failed", {
              sessionId: planned.id,
              message: String(error?.message ?? error),
            });
          }
        }
      } catch (error) {
        ctx.logger?.warn?.("qq: live chair restore failed", {
          message: String(error?.message ?? error),
        });
      }
    }
    persistLiveChairs();
  }

  async function ensureBootSession() {
    if (requireLiveAgent(defaultSessionId)) {
      syncLive(defaultSessionId);
    } else {
      await ctx.get("loader")?.await();
      if (requireLiveAgent(defaultSessionId)) {
        syncLive(defaultSessionId);
      } else {
        const headers = await persistedHeaders();
        const persisted = headers.find((header) => header.id === defaultSessionId);
        const setup = homeSetup({ current: selectedModel }, surface);
        const options = {
          agentOptions: { provider: selectedModel.provider, model: selectedModel.model },
          setup,
        };
        const persistCwd = typeof persisted?.cwd === "string" ? persisted.cwd : undefined;
        const persistProject = persistCwd ? projectForCwd(persistCwd) : undefined;
        const handle = rememberHandle(persisted && persistProject
          ? await agents.resume({ resumeSessionId: defaultSessionId, ...options })
          : await agents.create({
              sessionId: defaultSessionId,
              meta: { cwd: bootProject.cwd },
              ...options,
            }));
        if (!persisted || !persistProject) {
          await sessions.flush(handle.agent.session);
        }
        syncLive(handle.agent.session.id);
      }
    }
    await restorePlannedChairs();
  }

  async function reconcileHomeScratch() {
    await ctx.get("loader")?.await();
    if (scopes.corrupt) {
      ctx.logger?.warn?.("qq: scratch reconcile skipped", {
        code: "corrupt-scope",
        message: "qq: session-scope registry is corrupt",
      });
      return;
    }
    const liveIds = new Set(liveHomeAgents().map((agent) => agent.session.id));
    for (const id of scopes.protectedIds()) liveIds.add(id);
    try {
      const result = scratch.reconcile([...liveIds]);
      for (const row of result.errors ?? []) {
        ctx.logger?.warn?.("qq: scratch reconcile failed", {
          sessionId: row.name,
          path: row.path,
          code: row.error?.code,
          message: String(row.error?.message ?? row.error),
        });
      }
    } catch (error) {
      ctx.logger?.warn?.("qq: scratch reconcile failed", {
        code: error?.code,
        message: String(error?.message ?? error),
      });
    }
  }

  const boot = ensureBootSession().then(() => reconcileHomeScratch());

  function sortRows(rows) {
    rows.sort((left, right) => compareSessionRecency(
      { latest: left.latestEventAt, createdAt: left.createdAt, id: left.id },
      { latest: right.latestEventAt, createdAt: right.createdAt, id: right.id },
    ));
    return rows;
  }

  async function list(projectName, folderName) {
    await boot;
    syncLive();
    const wanted = projectName === undefined || projectName === null || projectName === ""
      ? undefined
      : projectByName(String(projectName));
    const folderSpecified = !(folderName === undefined || folderName === null);
    const wantedFolder = folderSpecified && folderName !== ""
      ? String(folderName)
      : undefined;
    if (wantedFolder) {
      if (!wanted) throw httpError(404, "qq: project not found");
      if (!(wanted.folders ?? []).some((folder) => folder.name === wantedFolder)) {
        throw httpError(404, "qq: project folder not found");
      }
    }
    const rows = liveProjectAgents()
      .map((agent) => rowFor(agent))
      .filter((row) => {
        if (!row.project) return false;
        if (wanted && row.project !== wanted.name) return false;
        if (!folderSpecified) return true;
        if (wantedFolder) return row.folder === wantedFolder;
        return !row.folder;
      });
    return sortRows(rows);
  }

  async function listHome() {
    await boot;
    syncLive();
    return sortRows(liveHomeAgents().map((agent) => rowFor(agent)));
  }

  async function latestHome() {
    const rows = await listHome();
    return rows[0] ?? null;
  }

  function turnStatusFromEvents(events) {
    let openTurn;
    let lastEnd;
    const list = Array.isArray(events) ? events : [];
    for (const event of list) {
      if (event?.type === "turn/start") openTurn = event.data?.turn;
      if (event?.type === "turn/end") {
        if (openTurn === event.data?.turn) openTurn = undefined;
        lastEnd = event.data?.reason;
      }
    }
    return { openTurn, lastEnd };
  }

  function applyTurnStatus(status, event) {
    if (event?.type === "turn/start") {
      return { openTurn: event.data?.turn, lastEnd: status?.lastEnd };
    }
    if (event?.type === "turn/end") {
      return {
        openTurn: status?.openTurn === event.data?.turn ? undefined : status?.openTurn,
        lastEnd: event.data?.reason,
      };
    }
    return status ?? {};
  }

  function toolViewsFor(event, agent, conversation) {
    if (event?.type !== "tool/call" && event?.type !== "tool/result") return undefined;
    try {
      const tools = ctx.get("tools", false);
      if (!tools) return undefined;
      const window = [event];
      if (event.type === "tool/result") {
        const callId = String(
          event.data?.message?.source?.callId
          ?? event.data?.callId
          ?? "",
        );
        const nodes = Array.isArray(conversation?.nodes) ? conversation.nodes : [];
        for (let index = nodes.length - 1; index >= 0; index -= 1) {
          const node = nodes[index];
          if (node?.kind !== "tool" || node.callId !== callId) continue;
          window.unshift({
            type: "tool/call",
            seq: node.seq,
            data: { callId, name: node.name, arguments: node.arguments },
          });
          break;
        }
      }
      return deriveToolEventViews(window, tools, agent, (error, item) => {
        ctx.logger?.warn?.(`qq: tool presenter failed at seq ${String(item?.seq)}: ${String(error)}`);
      });
    } catch {
      return undefined;
    }
  }

  function decorateSnapshot(agent, conversation, events) {
    const row = rowFor(agent);
    const alias = liveAlias(agent.session.id);
    const relationship = relationshipFields(agent);
    const chair = relationship.origin !== CHILD_ORIGIN;
    return {
      id: agent.session.id,
      events,
      conversation,
      turnStatus: turnStatusFromEvents(events),
      canMutatePending: Boolean(
        chair
        && agent.inbox
        && typeof agent.inbox.replace === "function"
        && typeof agent.inbox.remove === "function"
      ),
      agentStatus: agent.status,
      cwd: row.cwd,
      scope: row.scope,
      context: row.context,
      createdAt: row.createdAt,
      ...relationship,
      ...(row.project ? { project: row.project, projectLabel: row.projectLabel } : {}),
      ...(row.folder ? { folder: row.folder, folderLabel: row.folderLabel } : {}),
      ...(alias ? { alias } : {}),
    };
  }

  function projectionSeq(agent, events = agent?.session?.events) {
    if (Number.isSafeInteger(agent?.session?.seq)) return agent.session.seq;
    const lastSeq = Array.isArray(events) ? events.at(-1)?.seq : undefined;
    if (Number.isSafeInteger(lastSeq)) return lastSeq + 1;
    return Array.isArray(events) ? events.length : 0;
  }

  function rememberProjection(agent, conversation, events, snapshot) {
    const sessionId = agent.session.id;
    projections.set(sessionId, {
      agent,
      seq: projectionSeq(agent, events),
      conversation,
      events,
      snapshot,
    });
    return snapshot;
  }

  async function read(sessionId) {
    await boot;
    const agent = await liveAgent(sessionId);
    const cached = projections.get(sessionId);
    const liveSeq = projectionSeq(agent);
    if (cached && cached.agent === agent && cached.seq === liveSeq && cached.snapshot) {
      const snapshot = stampIdentity(agent, cached.snapshot);
      cached.snapshot = snapshot;
      return snapshot;
    }
    const events = agent.session.events;
    let toolViews;
    try {
      const tools = ctx.get("tools", false);
      toolViews = deriveToolEventViews(events, tools, agent, (error, event) => {
        ctx.logger?.warn?.(`qq: tool presenter failed at seq ${String(event?.seq)}: ${String(error)}`);
      });
    } catch {
      // Tool presentation is optional. Raw call/result content remains complete.
    }
    const conversation = projectConversation(events, {
      seedLength: agent.session.header?.seedLength,
      inbox: agent.inbox,
      toolViews,
    });
    return rememberProjection(agent, conversation, events, decorateSnapshot(agent, conversation, events));
  }

  async function inspect(sessionId) {
    await boot;
    if (!SESSION_ID.test(sessionId)) throw httpError(404, NOT_FOUND);
    if (isUnpublished(sessionId)) throw httpError(404, NOT_FOUND);
    const live = requireLiveAgent(sessionId);
    if (live) {
      const row = rowFor(live);
      return { id: live.session.id, live: true, ...row };
    }
    const headers = await persistedHeaders();
    const persisted = headers.find((header) => header.id === sessionId);
    if (persisted) {
      if (samePath(persisted.cwd, projectsRoot)) {
        return {
          id: sessionId,
          live: false,
          createdAt: persisted.createdAt,
          cwd: projectsRoot,
          scope: "projects",
          context: "projects",
        };
      }
      const project = projectForCwd(persisted.cwd);
      if (project) {
        return {
          id: sessionId,
          live: false,
          createdAt: persisted.createdAt,
          cwd: persisted.cwd,
          scope: "project",
          context: "project",
          project: project.name,
          projectLabel: project.label,
          ...(project.grouped && project.folder?.name ? {
            folder: project.folder.name,
            folderLabel: project.folder.label ?? project.folder.name,
          } : {}),
        };
      }
      const record = scopes.get(sessionId);
      if (record) {
        return {
          id: sessionId,
          live: false,
          createdAt: persisted.createdAt,
          cwd: record.cwd,
          scope: "home",
          context: "scratch",
        };
      }
      return {
        id: sessionId,
        live: false,
        createdAt: persisted.createdAt,
        cwd: persisted.cwd,
        project: undefined,
      };
    }
    throw httpError(404, NOT_FOUND);
  }

  async function view(sessionId) {
    const snapshot = await read(sessionId);
    const available = snapshot.scope === "home"
      ? await listHome()
      : snapshot.scope === "projects"
        ? [{
            id: snapshot.id,
            createdAt: snapshot.createdAt,
            cwd: snapshot.cwd,
            scope: "projects",
            context: "projects",
            ...(snapshot.alias ? { alias: snapshot.alias } : {}),
          }]
        : await list(snapshot.project, snapshot.folder ?? "");
    const next = { ...snapshot, sessions: available };
    const cached = projections.get(sessionId);
    if (cached) cached.snapshot = next;
    return next;
  }

  async function createAt(projectName, folderCwd) {
    await boot;
    const project = projectByName(projectName ?? defaultProject);
    const cwd = folderCwd && (project.folders ?? [project]).some((folder) => folder.cwd === folderCwd)
      ? folderCwd
      : project.cwd;
    await ctx.get("loader")?.await();
    const sessionId = `session-${randomUUID()}`;
    const setup = homeSetup({ current: selectedModel }, surface);
    const handle = rememberHandle(await agents.create({
      sessionId,
      meta: { cwd },
      agentOptions: { provider: selectedModel.provider, model: selectedModel.model },
      setup,
    }));
    await sessions.flush(handle.agent.session);
    const createdId = handle.agent.session.id;
    syncLive(createdId);
    persistLiveChairs();
    const alias = book.aliasFor(createdId);
    const folder = (project.folders ?? []).find((entry) => entry.cwd === cwd);
    return {
      id: createdId,
      scope: "project",
      context: "project",
      project: project.name,
      cwd,
      ...(project.grouped && folder?.name ? {
        folder: folder.name,
        folderLabel: folder.label ?? folder.name,
      } : {}),
      ...(alias ? { alias } : {}),
    };
  }

  async function createHome() {
    await boot;
    await ctx.get("loader")?.await();
    const sessionId = `session-${randomUUID()}`;
    unpublished.add(sessionId);
    let cwd;
    let handle;
    try {
      cwd = scratch.create(sessionId);
      scratch.verify(sessionId);
      const setup = homeSetup({ current: selectedModel }, surface);
      handle = rememberHandle(await agents.create({
        sessionId,
        meta: { cwd },
        agentOptions: { provider: selectedModel.provider, model: selectedModel.model },
        setup,
      }));
      await sessions.flush(handle.agent.session);
      scopes.put(sessionId, { cwd });
    } catch (error) {
      if (handle) {
        try {
          await disposeLive(handle.agent.session.id);
        } catch (disposeError) {
          throw scratchCleanupError(sessionId, cwd, disposeError, "create");
        }
      }
      if (cwd) {
        try {
          scratch.delete(sessionId);
        } catch (cleanupError) {
          throw scratchCleanupError(sessionId, cwd, cleanupError, "create");
        }
      }
      throw error;
    }
    unpublished.delete(sessionId);
    const createdId = handle.agent.session.id;
    syncLive(createdId);
    persistLiveChairs();
    const alias = book.aliasFor(createdId);
    return {
      id: createdId,
      scope: "home",
      context: "scratch",
      cwd,
      ...(alias ? { alias } : {}),
    };
  }

  function projectsRow(agent) {
    const id = agent.session.id;
    const alias = book.aliasFor(id);
    return {
      id,
      scope: "projects",
      context: "projects",
      cwd: projectsRoot,
      ...(alias ? { alias } : {}),
    };
  }

  async function mintProjects() {
    await ctx.get("loader")?.await();
    const sessionId = `session-${randomUUID()}`;
    let handle;
    try {
      handle = rememberHandle(await agents.create({
        sessionId,
        meta: { cwd: projectsRoot },
        agentOptions: { provider: selectedModel.provider, model: selectedModel.model },
        setup: homeSetup({ current: selectedModel }, surface),
      }));
      await sessions.flush(handle.agent.session);
    } catch (error) {
      const createdId = handle?.agent?.session?.id ?? sessionId;
      if (agents.get(createdId)) {
        try { await disposeLive(createdId); } catch {}
      }
      throw error;
    }
    const agent = handle.agent;
    syncLive(agent.session.id);
    // During replacement both Projects Agents are briefly live. Explicitly
    // transfer the unique reserved alias to the freshly minted chair rather
    // than relying on registry iteration order.
    book.pin(agent.session.id, PROJECTS_ALIAS);
    persistLiveChairs();
    return projectsRow(agent);
  }

  async function createProjects() {
    await boot;
    await ctx.get("loader")?.await();
    const live = liveProjectsAgents()[0];
    if (live) {
      syncLive(live.session.id);
      book.pin(live.session.id, PROJECTS_ALIAS);
      persistLiveChairs();
      return projectsRow(live);
    }
    // Host restart restoration is driven by live-chairs. An absent reserved
    // chair always starts a fresh conversation; /resume is the explicit way
    // to reopen a historical Projects session.
    return mintProjects();
  }

  function liveDescendants(sessionId) {
    const descendants = [];
    for (const agent of liveAgents()) {
      const candidateId = agent.session?.id;
      if (!SESSION_ID.test(candidateId) || candidateId === sessionId) continue;
      let current = agent;
      let depth = 0;
      const seen = new Set([candidateId]);
      while (current) {
        const parentId = parentSessionOf(current);
        if (!parentId || seen.has(parentId)) break;
        depth += 1;
        if (parentId === sessionId) {
          descendants.push({ id: candidateId, depth });
          break;
        }
        seen.add(parentId);
        current = agents.get(parentId);
      }
    }
    descendants.sort((left, right) => right.depth - left.depth || left.id.localeCompare(right.id));
    return descendants;
  }

  async function disposeDescendants(sessionId) {
    for (const descendant of liveDescendants(sessionId)) {
      if (agents.get(descendant.id)) await disposeLive(descendant.id);
    }
  }

  async function disposeLive(sessionId) {
    const agent = agents.get(sessionId);
    const handle = handles.get(sessionId) ?? agent?.[AGENT_HANDLE];
    try {
      if (handle && typeof handle.dispose === "function") {
        await handle.dispose();
      } else if (agent) {
        try { agent.cancel?.({ kind: "disposed" }); } catch { /* idle cancel is fine */ }
        try { await agent.whenIdle?.(); } catch { /* already quiet */ }
        const registry = unwrapAgents(agents);
        const entry = registry?.store?.get?.(sessionId);
        if (entry && typeof registry.detachEntered === "function") {
          registry.detachEntered(entry);
        } else if (typeof registry?.store?.delete === "function") {
          registry.store.delete(sessionId);
        } else {
          throw httpError(409, "qq: session is not closeable");
        }
      } else {
        throw httpError(409, "qq: session is not closeable");
      }
    } catch (error) {
      if (agents.get(sessionId)) {
        throw error?.status ? error : httpError(409, error instanceof Error ? error.message : String(error));
      }
    }
    handles.delete(sessionId);
    agentPromises.delete(sessionId);
    try { delete agent?.[AGENT_HANDLE]; } catch {}
    syncLive();
    persistLiveChairs();
  }

  async function reopen(sessionId) {
    await boot;
    if (!SESSION_ID.test(sessionId)) throw httpError(404, NOT_FOUND);
    const existing = requireLiveAgent(sessionId);
    if (existing) return rowFor(existing);
    const headers = await persistedHeaders();
    const header = headers.find((h) => h.id === sessionId);
    if (!header) throw httpError(404, NOT_FOUND);
    const agent = await resumeChair(sessionId, header);
    persistLiveChairs();
    return rowFor(agent);
  }

  async function closeProject(sessionId, project) {
    const folderName = project?.grouped ? (project.folder?.name ?? "") : "";
    const remainingBefore = await list(project?.name, folderName);
    await disposeLive(sessionId);
    const remaining = remainingBefore.filter((row) => row.id !== sessionId);
    const next = remaining[0];
    return {
      id: next?.id ?? null,
      closed: sessionId,
      scope: "project",
      context: "project",
      project: project?.name ?? defaultProject,
      ...(project?.grouped && project.folder?.name ? { folder: project.folder.name } : {}),
    };
  }

  async function closeHome(sessionId, classified) {
    const remainingBefore = await listHome();
    await disposeLive(sessionId);
    try {
      scratch.delete(sessionId);
    } catch (error) {
      throw scratchCleanupError(sessionId, classified.cwd, error, "delete");
    }
    const remaining = remainingBefore.filter((row) => row.id !== sessionId);
    const next = remaining[0];
    return {
      id: next?.id ?? null,
      closed: sessionId,
      scope: "home",
      context: "scratch",
    };
  }

  async function close(sessionId) {
    await boot;
    if (isUnpublished(sessionId)) {
      if (!SESSION_ID.test(sessionId)) throw httpError(404, NOT_FOUND);
      const agent = agents.get(sessionId);
      if (!agent) throw httpError(404, NOT_FOUND);
      if (agent.status === "running") throw httpError(409, RUNNING_CLOSE);
      const classified = classifyAgent(agent);
      if (classified?.scope !== "home") throw httpError(404, NOT_FOUND);
      await disposeDescendants(sessionId);
      return closeHome(sessionId, classified);
    }
    const agent = await liveAgent(sessionId);
    const child = childRelationship(agent);
    if (child) {
      const parent = agents.get(child.parent);
      const parentRow = parent ? rowFor(parent) : undefined;
      await disposeLive(sessionId);
      return {
        id: child.parent,
        closed: sessionId,
        ...(parentRow?.scope ? { scope: parentRow.scope } : {}),
        ...(parentRow?.context ? { context: parentRow.context } : {}),
        ...(parentRow?.project ? { project: parentRow.project } : {}),
        ...(parentRow?.folder ? { folder: parentRow.folder } : {}),
      };
    }
    if (agent.status === "running") throw httpError(409, RUNNING_CLOSE);
    const classified = classifyAgent(agent);
    if (classified) await disposeDescendants(sessionId);
    if (classified?.scope === "home") return closeHome(sessionId, classified);
    if (classified?.scope === "projects") {
      await disposeLive(sessionId);
      return {
        id: null,
        closed: sessionId,
        scope: "projects",
        context: "projects",
      };
    }
    return closeProject(sessionId, classified?.project);
  }

  async function replaceProject(sessionId, project) {
    const created = await createAt(project.name, project.cwd);
    try {
      await disposeDescendants(sessionId);
      await disposeLive(sessionId);
    } catch (error) {
      try { await disposeLive(created.id); } catch {}
      throw error;
    }
    return {
      id: created.id,
      scope: "project",
      context: "project",
      project: project.name,
      cwd: project.cwd,
      closed: sessionId,
      ...(created.folder ? { folder: created.folder, folderLabel: created.folderLabel } : {}),
      ...(created.alias ? { alias: created.alias } : {}),
    };
  }

  async function replaceHome(sessionId) {
    const classified = classifyAgent(agents.get(sessionId));
    const created = await createHome();
    await disposeDescendants(sessionId);
    await disposeLive(sessionId);
    try {
      scratch.delete(sessionId);
    } catch (error) {
      throw scratchCleanupError(sessionId, classified?.cwd, error, "delete");
    }
    return {
      id: created.id,
      scope: "home",
      context: "scratch",
      cwd: created.cwd,
      closed: sessionId,
      ...(created.alias ? { alias: created.alias } : {}),
    };
  }

  async function replaceProjects(sessionId) {
    let created;
    try {
      created = await mintProjects();
    } catch (error) {
      // Agent creation can fail after DSH has emitted lifecycle events. Make
      // the old chair's reserved identity explicit before surfacing failure.
      if (agents.get(sessionId)) {
        syncLive(sessionId);
        book.pin(sessionId, PROJECTS_ALIAS);
        persistLiveChairs();
      }
      throw error;
    }
    try {
      await disposeDescendants(sessionId);
      await disposeLive(sessionId);
    } catch (error) {
      // Keep replacement transactional if closing the old chair fails: remove
      // the new chair and return the reserved alias to the still-live old one.
      try { await disposeLive(created.id); } catch {}
      const old = agents.get(sessionId);
      if (old) {
        syncLive(sessionId);
        book.pin(sessionId, PROJECTS_ALIAS);
        persistLiveChairs();
      }
      throw error;
    }
    return { ...created, closed: sessionId };
  }

  async function replace(sessionId) {
    await boot;
    const agent = await liveAgent(sessionId);
    if (agent.status === "running") throw httpError(409, RUNNING_CLEAR);
    const classified = classifyAgent(agent);
    if (classified?.scope === "home") return replaceHome(sessionId);
    if (classified?.scope === "projects") return replaceProjects(sessionId);
    if (!classified?.project) throw httpError(404, "qq: project not found");
    return replaceProject(sessionId, classified.project);
  }

  function observersFor(sessionId) {
    return sessionObservers.get(sessionId);
  }

  function notifySession(sessionId, snapshot) {
    const listeners = observersFor(sessionId);
    if (!listeners) return;
    for (const listener of listeners) {
      try { listener(null, snapshot); } catch {}
    }
  }

  function notifySessionError(sessionId, error) {
    const listeners = observersFor(sessionId);
    if (!listeners) return;
    for (const listener of listeners) {
      try { listener(error); } catch {}
    }
  }

  const rebuilds = new Map();

  function rebuildAndNotify(sessionId) {
    if (!observersFor(sessionId)) {
      projections.delete(sessionId);
      return;
    }
    if (rebuilds.has(sessionId)) {
      rebuilds.set(sessionId, true);
      return;
    }
    rebuilds.set(sessionId, false);
    const run = () => view(sessionId).then(
      (snapshot) => {
        if (rebuilds.get(sessionId) === true) {
          rebuilds.set(sessionId, false);
          return run();
        }
        rebuilds.delete(sessionId);
        notifySession(sessionId, snapshot);
      },
      (error) => {
        rebuilds.delete(sessionId);
        notifySessionError(sessionId, error);
      },
    );
    void run();
  }

  if (typeof ctx.on === "function") {
    ctx.on("session/event", (session, event) => {
      const sessionId = session?.id;
      if (!SESSION_ID.test(sessionId)) return;
      const cached = projections.get(sessionId);
      if (cached && Number.isSafeInteger(event?.seq) && event.seq < cached.seq) return;
      if (cached && cached.seq === event.seq) {
        const agent = agents.get(sessionId) ?? cached.agent;
        const toolViews = toolViewsFor(event, agent, cached.conversation);
        const conversation = applyConversationEvent(cached.conversation, event, agent?.inbox, toolViews);
        if (conversation) {
          const events = event.type === "assistant/chunk"
            ? cached.events
            : (agent?.session?.events ?? cached.events);
          const snapshot = stampIdentity(agent, {
            ...cached.snapshot,
            conversation,
            events,
            turnStatus: applyTurnStatus(cached.snapshot.turnStatus, event),
            agentStatus: agent?.status ?? cached.snapshot.agentStatus,
          });
          projections.set(sessionId, {
            agent,
            seq: event.seq + 1,
            conversation,
            events,
            snapshot,
          });
          notifySession(sessionId, snapshot);
          return;
        }
      }
      rebuildAndNotify(sessionId);
    });
    ctx.on("agent/status", ({ agent }) => {
      const sessionId = agent?.session?.id;
      if (!SESSION_ID.test(sessionId) || !observersFor(sessionId)) return;
      const cached = projections.get(sessionId);
      if (cached) {
        const snapshot = stampIdentity(agent, { ...cached.snapshot, agentStatus: agent.status });
        cached.snapshot = snapshot;
        notifySession(sessionId, snapshot);
        return;
      }
      rebuildAndNotify(sessionId);
    });
  }

  return Object.freeze({
    defaultSessionId,
    defaultProject,
    defaultFolder: bootProject.grouped ? bootProject.folder?.name : undefined,
    projectsRoot,
    gitRootForDelegate,
    onDirectUserMessage(observer) {
      if (typeof observer !== "function") throw new TypeError("qq: direct-user observer must be a function");
      directUserMessageObservers.add(observer);
      return () => directUserMessageObservers.delete(observer);
    },
    listProjects: () => catalog(),
    listProjectFiles: projectFiles.listProjectFiles,
    readProjectFile: projectFiles.readProjectFile,
    openProjectFile: projectFiles.openProjectFile,
    list,
    listHome,
    latestHome,
    read,
    inspect,
    listAgents() {
      syncLive();
      const rows = liveAgents()
        .filter((agent) => !isUnpublished(agent.session?.id))
        .map((agent) => {
          const id = agent.session.id;
          const alias = book.aliasFor(id) || "";
          const recency = sessionRecency(agent.session, createdAtFor(agent));
          return makeAgentRow(agent, {
            now: clock(),
            alias,
            recency,
            statusSince: statusSince.get(id),
          });
        });
      return orderAgents(rows);
    },
    inspectAgent(sessionId) {
      if (!SESSION_ID.test(sessionId) || isUnpublished(sessionId)) throw httpError(404, NOT_FOUND);
      const agent = agents.get(sessionId);
      if (!agent) throw httpError(404, NOT_FOUND);
      const alias = book.aliasFor(sessionId) || "";
      const recency = sessionRecency(agent.session, createdAtFor(agent));
      return makeAgentRow(agent, {
        now: clock(),
        alias,
        recency,
        statusSince: statusSince.get(sessionId),
      });
    },
    alias: liveAlias,
    resolve: resolveAlias,
    surface,
    async create(projectName, folderName) {
      const project = projectByName(projectName ?? defaultProject);
      let folderCwd;
      if (folderName !== undefined && folderName !== null && folderName !== "") {
        const folder = (project.folders ?? []).find((entry) => entry.name === String(folderName));
        if (!folder) throw httpError(404, "qq: project folder not found");
        folderCwd = folder.cwd;
      }
      return createAt(project.name, folderCwd);
    },
    createHome,
    createProjects,
    replace,
    clear: replace,
    reopen,
    resume: reopen,
    scratchRoot: scratch.root,
    async prompt(sessionId, text) {
      await boot;
      const agent = await liveChairAgent(sessionId);
      const line = String(text ?? "");
      let userSkillPrompt = false;
      if (line.startsWith("/")) {
        const name = slashName(line);
        if (name === "new") {
          const classified = classifyAgent(agent);
          const created = classified?.scope === "home"
            ? await createHome()
            : classified?.scope === "projects"
              ? await replace(sessionId)
              : await createAt(classified?.project?.name, classified?.cwd);
          return { kind: "navigate", action: "create", ...created };
        }
        if (name === "clear") {
          const replaced = await replace(sessionId);
          return { kind: "navigate", action: "replace", ...replaced };
        }
        if (name === "close") {
          const closed = await close(sessionId);
          return { kind: "navigate", action: "close", ...closed };
        }
        if (name === "reopen" || name === "resume") {
          const target = line.split(/\s+/)[1] || sessionId;
          const targetId = resolveAlias(target) || target;
          const reopened = await reopen(targetId);
          return { kind: "navigate", action: "reopen", ...reopened };
        }
        userSkillPrompt = await isUserInvocableSkill(ctx, agent, name);
        if (!userSkillPrompt) {
          const commands = ctx.get("commands", false);
          if (!commands || typeof commands.execute !== "function") {
            throw httpError(503, "qq: slash commands require ctx.commands");
          }
          const parsed = typeof commands.parseCommand === "function"
            ? commands.parseCommand(line)
            : /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line);
          if (!parsed) {
            throw httpError(400, "qq: unknown slash command");
          }
          const commandName = parsed.name ?? parsed[1];
          const execution = await commands.execute(agent, line, new AbortController().signal);
          if (!execution) {
            throw httpError(400, `qq: unknown slash command /${commandName}`);
          }
          await sessions.flush(agent.session);
          const result = execution.result;
          if (result?.kind === "error") {
            throw httpError(400, result.text || `qq: /${commandName} failed`);
          }
          return typeof result?.text === "string" ? result.text : "";
        }
      }
      const finder = ctx.get("image-finder", false);
      const workflows = ctx.get("qq-workflows", false);
      const inFind = Boolean(
        (finder && typeof finder.inFindMode === "function" && finder.inFindMode(sessionId)) ||
        (workflows?.workflows?.selected?.(sessionId) === "find"),
      );
      if (finder && inFind && !userSkillPrompt) {
        if (typeof finder.handlePrompt !== "function") {
          throw httpError(503, "image-finder: find mode is unavailable");
        }
        const result = await finder.handlePrompt({ agent, rawInput: line });
        await sessions.flush(agent.session);
        if (result?.kind === "error") {
          throw httpError(400, result.text || "qq: find failed");
        }
        return typeof result?.text === "string" ? result.text : "";
      }
      const message = userMessage(line);
      const mode = agent.status === "running" ? "steer" : "followup";
      const directUserTime = clock();
      notifyDirectUserMessage({ kind: "admitted", agent, message, mode, time: directUserTime });
      try {
        if (mode === "steer") agent.steer(message);
        else agent.followup(message);
      } catch (error) {
        notifyDirectUserMessage({ kind: "revoked", agent, message, mode });
        throw error;
      }
      // followup()/steer() durably append their inbox splice synchronously. Flush
      // that admission and return; the Agent owns later claim and turn progress.
      await sessions.flush(agent.session);
      return { kind: "accepted", mode, messageId: message.id };
    },
    async editPending(sessionId, messageId, text) {
      await boot;
      const agent = await liveChairAgent(sessionId);
      const inbox = agent.inbox;
      if (!inbox || typeof inbox.replace !== "function") {
        throw httpError(501, "qq: pending message editing is unavailable");
      }
      const id = String(messageId ?? "");
      const message = [...(inbox.nextTurn ?? []), ...(inbox.nextStep ?? [])]
        .find((candidate) => String(candidate?.id ?? "") === id);
      if (!message) throw httpError(409, "qq: pending message is no longer available");
      const nextText = String(text ?? "");
      if (!nextText.trim()) throw httpError(422, "Pending message must not be empty");
      if (nextText.length > 32_768) throw httpError(413, "Pending message exceeds 32,768 characters");
      const replacement = freeze({ ...message, content: [{ type: "text", text: nextText }] });
      if (!inbox.replace(message.id, replacement)) {
        throw httpError(409, "qq: pending message is no longer available");
      }
      notifyDirectUserMessage({ kind: "updated", agent, message: replacement, previous: message, time: clock() });
      await sessions.flush(agent.session);
      return { accepted: true, messageId: replacement.id };
    },
    async removePending(sessionId, messageId) {
      await boot;
      const agent = await liveChairAgent(sessionId);
      const inbox = agent.inbox;
      if (!inbox || typeof inbox.remove !== "function") {
        throw httpError(501, "qq: pending message removal is unavailable");
      }
      const id = String(messageId ?? "");
      const message = [...(inbox.nextTurn ?? []), ...(inbox.nextStep ?? [])]
        .find((candidate) => String(candidate?.id ?? "") === id);
      if (!message || !inbox.remove(id)) {
        throw httpError(409, "qq: pending message is no longer available");
      }
      notifyDirectUserMessage({ kind: "removed", agent, message });
      await sessions.flush(agent.session);
      return { accepted: true };
    },
    async interrupt(sessionId) {
      await boot;
      const finder = ctx.get("image-finder", false);
      const abortedFind = typeof finder?.abortCompile === "function"
        ? Boolean(finder.abortCompile(sessionId))
        : false;
      const agent = await liveChairAgent(sessionId);
      const wasRunning = agent.status === "running";
      agent.cancel({ kind: "user" }, { keepInbox: true });
      // Cancellation follows the DSH Host admission contract: return after the
      // signal is accepted. The loop owns turn settlement and its checkpoint.
      return wasRunning || abortedFind;
    },
    close,
    observe(sessionId, listener, options = {}) {
      if (typeof listener !== "function") {
        throw new Error("qq: observe requires a listener");
      }
      if (typeof ctx.on !== "function") {
        return observeSnapshot(() => view(sessionId), listener, options);
      }
      const intervalMs = options.intervalMs ?? DEFAULT_OBSERVE_MS;
      if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
        throw new Error("qq: observe intervalMs must be a positive integer");
      }
      let listeners = sessionObservers.get(sessionId);
      if (!listeners) {
        listeners = new Set();
        sessionObservers.set(sessionId, listeners);
      }
      listeners.add(listener);
      let cancelled = false;
      let timer;
      let cheapFp;
      void view(sessionId).then(
        (snapshot) => {
          if (cancelled || !listeners.has(listener)) return;
          cheapFp = `${snapshot.agentStatus ?? ""}:${projections.get(sessionId)?.seq ?? ""}`;
          try { listener(null, snapshot); } catch {}
        },
        (error) => {
          if (cancelled || !listeners.has(listener)) return;
          try { listener(error); } catch {}
        },
      );
      const tick = async () => {
        if (cancelled) return;
        try {
          await boot;
          if (cancelled) return;
          const agent = requireLiveAgent(sessionId);
          const liveSeq = projectionSeq(agent);
          const fp = `${agent?.status ?? ""}:${liveSeq}`;
          const cached = projections.get(sessionId);
          const current = Boolean(cached && cached.seq === liveSeq && cached.snapshot?.agentStatus === agent.status);
          if (fp !== cheapFp && !current) {
            cheapFp = fp;
            const snapshot = await view(sessionId);
            if (!cancelled && listeners.has(listener)) {
              try { listener(null, snapshot); } catch {}
            }
          } else {
            cheapFp = fp;
          }
        } catch (error) {
          if (!cancelled && listeners.has(listener)) {
            try { listener(error); } catch {}
          }
        }
        if (cancelled) return;
        timer = setTimeout(tick, intervalMs);
        timer.unref?.();
      };
      void tick();
      return () => {
        cancelled = true;
        clearTimeout(timer);
        listeners.delete(listener);
        if (listeners.size === 0) sessionObservers.delete(sessionId);
      };
    },
  });
}

export const internals = Object.freeze({
  DEFAULT_OBSERVE_MS,
  SESSION_ID,
  INACTIVE,
  NOT_FOUND,
  RUNNING_CLEAR,
  RUNNING_CLOSE,
  httpError,
  selectionSetup,
  userMessage,
  waitForIdle,
  canonicalPath,
  contained,
  isImmediateChild,
  hostAgents,
  adoptAgentHandle,
  unwrapAgents,
});
