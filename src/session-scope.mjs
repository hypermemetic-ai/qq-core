// qq-owned durable session-scope registry.
//
// Exact canonical session IDs map to immutable explicit metadata sufficient
// to recover {scope:"home", context:"scratch", cwd} after the scratch tree
// is deleted. Schema/version and exact cwd/id validation fail closed. A
// Home record is valid only when cwd is the exact expected child
// join(canonicalScratchRoot, sessionId). This is not a DSH SessionStore
// header and not a project catalog.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export const SCOPE_SCHEMA = "qq.session-scope/v1";
export const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

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

function scopeError(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function homeDir(env = process.env) {
  const home = typeof env.HOME === "string" && env.HOME.startsWith("/")
    ? env.HOME
    : homedir();
  if (!home || !isAbsolute(home)) {
    throw scopeError("qq: HOME must be an absolute path", "invalid-root");
  }
  return home;
}

/** Production consumer default: ~/.local/state/qq/session-scope.json. */
export function defaultScopeFile(env = process.env) {
  const stateHome = typeof env.XDG_STATE_HOME === "string" && env.XDG_STATE_HOME.startsWith("/")
    ? env.XDG_STATE_HOME
    : join(homeDir(env), ".local", "state");
  return join(stateHome, "qq", "session-scope.json");
}

function canonicalSessionId(value) {
  if (typeof value !== "string" || value.includes("\0") || value.includes("/") || value.includes(sep)) {
    return undefined;
  }
  if (!SESSION_ID.test(value)) return undefined;
  return value;
}

function canonicalScratchRoot(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) {
    return undefined;
  }
  const resolved = resolve(value);
  if (resolved !== value || dirname(resolved) === resolved) return undefined;
  return resolved;
}

function expectedHomeCwd(scratchRoot, id) {
  const root = canonicalScratchRoot(scratchRoot);
  const sessionId = canonicalSessionId(id);
  if (!root || !sessionId) return undefined;
  return join(root, sessionId);
}

function canonicalCwd(id, value, scratchRoot) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) return undefined;
  const resolved = resolve(value);
  if (resolved !== value) return undefined;
  const expected = expectedHomeCwd(scratchRoot, id);
  if (!expected || resolved !== expected) return undefined;
  return resolved;
}

function freezeRecord(id, cwd) {
  return Object.freeze({
    id,
    scope: "home",
    context: "scratch",
    cwd,
  });
}

function parseRecord(id, value, scratchRoot) {
  const canonicalId = canonicalSessionId(id);
  if (!canonicalId) return { ok: false, reason: "invalid-id" };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "malformed", id: canonicalId };
  }
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.includes("scope") || !keys.includes("context") || !keys.includes("cwd")) {
    return { ok: false, reason: "malformed", id: canonicalId };
  }
  if (value.scope !== "home" || value.context !== "scratch") {
    return { ok: false, reason: "mismatch", id: canonicalId };
  }
  const cwd = canonicalCwd(canonicalId, value.cwd, scratchRoot);
  if (!cwd) return { ok: false, reason: "mismatch", id: canonicalId };
  return { ok: true, record: freezeRecord(canonicalId, cwd) };
}

function emptyState() {
  return { records: new Map(), protectedEntries: new Map(), corrupt: false };
}

function parseStore(parsed, scratchRoot) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...emptyState(), corrupt: true };
  }
  if (parsed.schema !== SCOPE_SCHEMA) {
    return { ...emptyState(), corrupt: true };
  }
  if (!parsed.sessions || typeof parsed.sessions !== "object" || Array.isArray(parsed.sessions)) {
    return { ...emptyState(), corrupt: true };
  }
  const records = new Map();
  const protectedEntries = new Map();
  for (const [id, value] of Object.entries(parsed.sessions)) {
    const parsedRecord = parseRecord(id, value, scratchRoot);
    if (parsedRecord.ok) {
      records.set(parsedRecord.record.id, parsedRecord.record);
    } else if (parsedRecord.id) {
      protectedEntries.set(parsedRecord.id, value);
    }
  }
  return { records, protectedEntries, corrupt: false };
}

function serialize(records, protectedEntries) {
  const sessions = {};
  const ids = [...new Set([...records.keys(), ...protectedEntries.keys()])].sort();
  for (const id of ids) {
    const record = records.get(id);
    if (record) {
      sessions[id] = {
        scope: record.scope,
        context: record.context,
        cwd: record.cwd,
      };
      continue;
    }
    sessions[id] = protectedEntries.get(id);
  }
  return `${JSON.stringify({ schema: SCOPE_SCHEMA, sessions })}\n`;
}

/**
 * One durable Home-scope registry. `file` may be omitted for an in-memory
 * store (unit tests). Production passes the owner-only path under qq state.
 * `scratchRoot` is the T-139 manager root; a Home record is valid only when
 * cwd is the exact expected child join(scratchRoot, sessionId).
 */
export function createSessionScopeStore(options = {}) {
  if (options !== undefined && (options === null || typeof options !== "object")) {
    throw scopeError("qq: session-scope options must be an object", "invalid-root");
  }
  const file = options.file;
  if (file !== undefined && (typeof file !== "string" || !file.startsWith("/") || file.includes("\0"))) {
    throw scopeError("qq: session-scope file must be an absolute path", "invalid-root");
  }
  const scratchRoot = canonicalScratchRoot(options.scratchRoot);
  if (!scratchRoot) {
    throw scopeError("qq: session-scope scratchRoot must be an absolute path", "invalid-root");
  }
  const io = bindFs(options.fs ?? {});

  function readState() {
    if (!file) return emptyState();
    let raw;
    try {
      if (!io.existsSync(file)) return emptyState();
      raw = io.readFileSync(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return emptyState();
      return { ...emptyState(), corrupt: true, error };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ...emptyState(), corrupt: true };
    }
    return parseStore(parsed, scratchRoot);
  }

  function persist(records, protectedEntries) {
    if (!file) return;
    const directory = dirname(file);
    io.mkdirSync(directory, { recursive: true, mode: DIR_MODE });
    try { io.chmodSync(directory, DIR_MODE); } catch {}
    const temporary = `${file}.${process.pid}.tmp`;
    io.writeFileSync(temporary, serialize(records, protectedEntries), { mode: FILE_MODE });
    try { io.chmodSync(temporary, FILE_MODE); } catch {}
    io.renameSync(temporary, file);
    try { io.chmodSync(file, FILE_MODE); } catch {}
  }

  let memory = emptyState();
  if (!file) {
    // In-memory store starts empty.
  } else {
    memory = readState();
  }

  const store = {
    file,
    scratchRoot,
    get corrupt() {
      return memory.corrupt === true;
    },
    get(sessionId) {
      if (memory.corrupt) return undefined;
      const id = canonicalSessionId(sessionId);
      if (!id) return undefined;
      return memory.records.get(id);
    },
    inspect(sessionId) {
      if (memory.corrupt) return Object.freeze({ ok: false, reason: "corrupt" });
      const id = canonicalSessionId(sessionId);
      if (!id) return Object.freeze({ ok: false, reason: "invalid-id" });
      const record = memory.records.get(id);
      if (record) return Object.freeze({ ok: true, record });
      if (memory.protectedEntries.has(id)) return Object.freeze({ ok: false, reason: "invalid" });
      return Object.freeze({ ok: false, reason: "missing" });
    },
    ids() {
      if (memory.corrupt) return [];
      return [...memory.records.keys()];
    },
    protectedIds() {
      if (memory.corrupt) return [];
      return [...memory.protectedEntries.keys()];
    },
    put(sessionId, input = {}) {
      if (memory.corrupt) {
        throw scopeError("qq: session-scope registry is corrupt", "corrupt");
      }
      const parsed = parseRecord(sessionId, {
        scope: input.scope ?? "home",
        context: input.context ?? "scratch",
        cwd: input.cwd,
      }, scratchRoot);
      if (!parsed.ok) {
        throw scopeError(
          `qq: session-scope record is invalid (${parsed.reason ?? "malformed"})`,
          parsed.reason ?? "malformed",
        );
      }
      const next = new Map(memory.records);
      next.set(parsed.record.id, parsed.record);
      const nextProtected = new Map(memory.protectedEntries);
      nextProtected.delete(parsed.record.id);
      persist(next, nextProtected);
      memory = {
        records: next,
        protectedEntries: nextProtected,
        corrupt: false,
      };
      return parsed.record;
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
  canonicalSessionId,
  canonicalScratchRoot,
  expectedHomeCwd,
  canonicalCwd,
  parseRecord,
  parseStore,
});
