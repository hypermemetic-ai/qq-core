// qq-owned snapshot of live root-operator chairs.
//
// Host restart disposes every DSH Agent. Persistence still has the jsonl, but
// list() is live-only, so a chair that was open at SIGTERM must be resumed.
// This sidecar is the set to restore — not history, not subagents.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export const LIVE_CHAIRS_SCHEMA = "qq.live-chairs/v1";
export const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const BASENAME = ".qq-live-chairs.json";
const SCOPES = new Set(["project", "home", "projects"]);

function bindFs(overrides = {}) {
  return {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
    ...overrides,
  };
}

function homeDir(env = process.env) {
  const home = typeof env.HOME === "string" && env.HOME.startsWith("/")
    ? env.HOME
    : homedir();
  if (!home || !isAbsolute(home)) {
    throw new Error("qq: HOME must be an absolute path when DSH_HOME is unset");
  }
  return home;
}

function besideDshHome(env, basename) {
  const dshHome = env.DSH_HOME?.trim();
  if (dshHome) {
    if (!isAbsolute(dshHome)) throw new Error("qq: DSH_HOME must be an absolute path");
    return join(dirname(dshHome), basename);
  }
  return join(homeDir(env), basename);
}

/** Default live-chair snapshot: a dotfile beside DSH_HOME. */
export function defaultLiveChairsFile(env = process.env, config = {}) {
  if (config.liveChairsFile !== undefined) {
    if (typeof config.liveChairsFile !== "string" || config.liveChairsFile.length === 0 || !isAbsolute(config.liveChairsFile)) {
      throw new Error("qq: liveChairsFile must be an absolute path");
    }
    return config.liveChairsFile;
  }
  return besideDshHome(env, BASENAME);
}

function canonicalSessionId(value) {
  if (typeof value !== "string" || value.includes("\0") || value.includes("/")) return undefined;
  if (!SESSION_ID.test(value)) return undefined;
  return value;
}

function canonicalCwd(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) return undefined;
  return value;
}

export function parseChair(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "malformed" };
  }
  const id = canonicalSessionId(value.id);
  const cwd = canonicalCwd(value.cwd);
  const scope = value.scope;
  if (!id || !cwd || !SCOPES.has(scope)) return { ok: false, reason: "malformed" };
  if (scope === "home" && value.context !== "scratch") return { ok: false, reason: "malformed" };
  if (scope === "projects" && value.context !== "projects") return { ok: false, reason: "malformed" };
  if (scope === "project" && (value.context !== undefined && value.context !== "project")) {
    return { ok: false, reason: "malformed" };
  }
  const record = { id, cwd, scope };
  if (scope === "home") record.context = "scratch";
  else if (scope === "projects") record.context = "projects";
  else record.context = "project";
  if (scope === "project" && typeof value.project === "string" && value.project.length > 0) {
    record.project = value.project;
  }
  return { ok: true, record: Object.freeze(record) };
}

function serialize(sessions) {
  return `${JSON.stringify({
    schema: LIVE_CHAIRS_SCHEMA,
    sessions,
  }, null, 2)}\n`;
}

function parseStore(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { sessions: [], corrupt: true };
  }
  if (payload.schema !== LIVE_CHAIRS_SCHEMA) return { sessions: [], corrupt: true };
  if (!Array.isArray(payload.sessions)) return { sessions: [], corrupt: true };
  const seen = new Set();
  const sessions = [];
  for (const entry of payload.sessions) {
    const parsed = parseChair(entry);
    if (!parsed.ok) continue;
    if (seen.has(parsed.record.id)) continue;
    seen.add(parsed.record.id);
    sessions.push(parsed.record);
  }
  return { sessions: Object.freeze(sessions), corrupt: false };
}

export function createLiveChairStore(options = {}) {
  const io = bindFs(options.fs ?? {});
  const file = options.file === null || options.file === undefined
    ? undefined
    : options.file;
  if (file !== undefined && (typeof file !== "string" || !isAbsolute(file))) {
    throw new Error("qq: liveChairsFile must be an absolute path");
  }

  function readState() {
    if (!file || !io.existsSync(file)) return { sessions: Object.freeze([]), corrupt: false };
    let raw;
    try {
      raw = io.readFileSync(file, "utf8");
    } catch {
      return { sessions: Object.freeze([]), corrupt: true };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { sessions: Object.freeze([]), corrupt: true };
    }
    return parseStore(parsed);
  }

  function persist(sessions) {
    if (!file) return;
    const directory = dirname(file);
    io.mkdirSync(directory, { recursive: true, mode: DIR_MODE });
    try { io.chmodSync(directory, DIR_MODE); } catch {}
    const temporary = `${file}.${process.pid}.tmp`;
    io.writeFileSync(temporary, serialize(sessions), { mode: FILE_MODE });
    try { io.chmodSync(temporary, FILE_MODE); } catch {}
    io.renameSync(temporary, file);
    try { io.chmodSync(file, FILE_MODE); } catch {}
  }

  let memory = file ? readState() : { sessions: Object.freeze([]), corrupt: false };

  const store = {
    file,
    get corrupt() {
      return memory.corrupt === true;
    },
    list() {
      return memory.sessions;
    },
    replace(entries = []) {
      const seen = new Set();
      const sessions = [];
      for (const entry of entries) {
        const parsed = parseChair(entry);
        if (!parsed.ok) continue;
        if (seen.has(parsed.record.id)) continue;
        seen.add(parsed.record.id);
        sessions.push(parsed.record);
      }
      const frozen = Object.freeze(sessions);
      persist(frozen);
      memory = { sessions: frozen, corrupt: false };
      return frozen;
    },
    reload() {
      memory = file ? readState() : memory;
      return store;
    },
  };

  return Object.freeze(store);
}

export const internals = Object.freeze({
  FILE_MODE,
  DIR_MODE,
  BASENAME,
  parseStore,
});
