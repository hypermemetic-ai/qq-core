// qq-owned scratch-directory manager.
//
// Organizational workspace ownership only: one private direct child per
// session id, bound by an owner-only versioned marker. Not an OS sandbox
// and not a project catalog. The session service uses this for Home Agent
// cwd and cleanup; T-134 later owns Home routes and UI.

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const MARKER_SCHEMA = "qq.scratch/v1";
export const MARKER_NAME = ".qq-scratch.json";
export const STAGING_PREFIX = ".qq-scratch-create.";
export const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY_MODE = 0o700;
const MARKER_MODE = 0o600;

function bindFs(overrides = {}) {
  return {
    chmodSync,
    closeSync,
    fchmodSync,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeSync,
    ...overrides,
  };
}

function scratchError(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function contained(root, candidate) {
  const rel = relative(root, candidate);
  if (!rel || rel === ".") return true;
  if (isAbsolute(rel)) return false;
  return !rel.split(sep).includes("..");
}

function isDirectChild(root, candidate) {
  const rel = relative(root, candidate);
  if (!rel || rel === "." || isAbsolute(rel)) return false;
  const segments = rel.split(sep);
  return !segments.includes("..") && segments.length === 1;
}

function homeDir(env = process.env) {
  const home = typeof env.HOME === "string" && env.HOME.startsWith("/")
    ? env.HOME
    : homedir();
  if (!home || !isAbsolute(home)) {
    throw scratchError("qq: HOME must be an absolute path", "invalid-root");
  }
  return home;
}

/** Production consumer default: ~/.local/state/qq/scratch. */
export function defaultScratchRoot(env = process.env) {
  const stateHome = typeof env.XDG_STATE_HOME === "string" && env.XDG_STATE_HOME.startsWith("/")
    ? env.XDG_STATE_HOME
    : join(homeDir(env), ".local", "state");
  return join(stateHome, "qq", "scratch");
}

/** Accept only the exact lowercase canonical `session-<uuid>` spelling. */
export function normalizeSessionId(value) {
  if (typeof value !== "string" || value.includes("\0") || value.includes("/") || value.includes(sep)) {
    throw scratchError("qq: scratch session id is invalid", "invalid-id");
  }
  if (!SESSION_ID.test(value)) {
    throw scratchError("qq: scratch session id is invalid", "invalid-id");
  }
  return value;
}

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function permissionMode(info) {
  return info.mode & 0o777;
}

function isInspectError(error) {
  const code = error?.code;
  return typeof code === "string" && code.startsWith("E") && code !== "ENOENT";
}

function lstatOrNull(io, path) {
  try {
    return io.lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function openNoFollow(io, path, flags, mode) {
  return io.openSync(path, flags | NOFOLLOW, mode);
}

function inspectRoot(io, root) {
  const segments = root.split(sep).filter(Boolean);
  let current = "/";
  let info = null;
  for (const segment of segments) {
    current = join(current, segment);
    info = lstatOrNull(io, current);
    if (!info) return { kind: "missing" };
    if (info.isSymbolicLink()) return { kind: "symlink" };
    if (!info.isDirectory()) return { kind: "not-directory" };
  }
  return { kind: "directory", info };
}

function lstatRootComponent(io, path) {
  try {
    return lstatOrNull(io, path);
  } catch (error) {
    throw scratchError("qq: scratch root is not a usable directory", "unsafe-root", { cause: error });
  }
}

function ensureRoot(io, root) {
  const segments = root.split(sep).filter(Boolean);
  let current = "/";
  for (const segment of segments) {
    const next = join(current, segment);
    let info = lstatRootComponent(io, next);
    if (!info) {
      try {
        io.mkdirSync(next, { recursive: false, mode: DIRECTORY_MODE });
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw scratchError("qq: scratch root is not a usable directory", "unsafe-root", { cause: error });
        }
      }
      if (next === root) {
        try {
          io.chmodSync(next, DIRECTORY_MODE);
        } catch {
          // Best-effort on a just-created root; inspect still fail-closes.
        }
      }
      info = lstatRootComponent(io, next);
    }
    if (!info || info.isSymbolicLink() || !info.isDirectory()) {
      throw scratchError("qq: scratch root is not a usable directory", "unsafe-root");
    }
    current = next;
  }
  return current;
}

function readMarker(io, directory, expectedId) {
  const markerPath = join(directory, MARKER_NAME);
  let listed;
  try {
    listed = lstatOrNull(io, markerPath);
  } catch (error) {
    return { ok: false, reason: "error", error };
  }
  if (!listed) return { ok: false, reason: "unmarked" };
  if (listed.isSymbolicLink() || !listed.isFile() || permissionMode(listed) !== MARKER_MODE) {
    return { ok: false, reason: "malformed" };
  }
  let descriptor;
  try {
    descriptor = openNoFollow(io, markerPath, constants.O_RDONLY);
    const info = io.fstatSync(descriptor);
    if (!info.isFile() || permissionMode(info) !== MARKER_MODE) return { ok: false, reason: "malformed" };
    const raw = io.readFileSync(descriptor);
    let parsed;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "malformed" };
    }
    if (parsed.schema !== MARKER_SCHEMA || typeof parsed.sessionId !== "string") {
      return { ok: false, reason: "malformed" };
    }
    if (!SESSION_ID.test(parsed.sessionId) || parsed.sessionId !== expectedId) {
      return { ok: false, reason: "mismatch" };
    }
    return {
      ok: true,
      marker: Object.freeze({ schema: MARKER_SCHEMA, sessionId: parsed.sessionId }),
    };
  } catch (error) {
    if (isInspectError(error)) return { ok: false, reason: "error", error };
    return { ok: false, reason: "malformed" };
  } finally {
    if (descriptor !== undefined) {
      try {
        io.closeSync(descriptor);
      } catch {
        // Close is best-effort after inspect.
      }
    }
  }
}

function writeMarker(io, directory, sessionId) {
  const markerPath = join(directory, MARKER_NAME);
  const payload = `${JSON.stringify({ schema: MARKER_SCHEMA, sessionId })}\n`;
  let descriptor;
  try {
    descriptor = openNoFollow(
      io,
      markerPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      MARKER_MODE,
    );
    const info = io.fstatSync(descriptor);
    if (!info.isFile()) {
      throw scratchError("qq: scratch marker is unsafe", "unsafe");
    }
    io.writeSync(descriptor, payload);
    try {
      io.fchmodSync(descriptor, MARKER_MODE);
    } catch {
      io.chmodSync(markerPath, MARKER_MODE);
    }
  } finally {
    if (descriptor !== undefined) io.closeSync(descriptor);
  }
}

function inspectChild(io, root, sessionId) {
  const path = join(root, sessionId);
  if (!isDirectChild(root, path) || !contained(root, path)) {
    return { kind: "escape", path };
  }
  const info = lstatOrNull(io, path);
  if (!info) return { kind: "missing", path };
  if (info.isSymbolicLink()) return { kind: "symlink", path };
  if (!info.isDirectory()) return { kind: "not-directory", path };
  if (permissionMode(info) !== DIRECTORY_MODE) return { kind: "malformed", path };
  const marker = readMarker(io, path, sessionId);
  if (!marker.ok) return { kind: marker.reason, path, error: marker.error };
  return { kind: "ready", path, marker: marker.marker, info };
}

function unsafeChild(inspection, action) {
  const reason = inspection.kind;
  const code = reason === "mismatch" ? "mismatch" : "unsafe";
  return scratchError(`qq: scratch ${action} refused (${reason})`, code, {
    path: inspection.path,
    reason,
  });
}

function removeStaging(io, staging) {
  try {
    io.rmSync(staging, { recursive: true, force: true });
  } catch {
    // Staging never publishes; leftover names are not session ids.
  }
}

function publish(io, root, sessionId) {
  const dest = join(root, sessionId);
  const staging = join(root, `${STAGING_PREFIX}${process.pid}.${randomBytes(8).toString("hex")}`);
  if (!isDirectChild(root, staging) || !isDirectChild(root, dest)) {
    throw scratchError("qq: scratch path escapes the configured root", "escape");
  }
  try {
    io.mkdirSync(staging, { recursive: false, mode: DIRECTORY_MODE });
    io.chmodSync(staging, DIRECTORY_MODE);
    const stagingInfo = io.lstatSync(staging);
    if (stagingInfo.isSymbolicLink() || !stagingInfo.isDirectory()) {
      throw scratchError("qq: scratch staging is unsafe", "unsafe");
    }
    writeMarker(io, staging, sessionId);
    if (readMarker(io, staging, sessionId).ok !== true) {
      throw scratchError("qq: scratch marker write failed", "unsafe");
    }
    io.renameSync(staging, dest);
  } catch (error) {
    removeStaging(io, staging);
    const again = inspectChild(io, root, sessionId);
    if (again.kind === "ready") return again;
    if (again.kind !== "missing") throw unsafeChild(again, "create");
    if (error?.code === "invalid-id" || error?.code === "unsafe" || error?.code === "mismatch" || error?.code === "escape") {
      throw error;
    }
    throw scratchError("qq: scratch create failed", "create-failed", { cause: error, path: dest });
  }
  const published = inspectChild(io, root, sessionId);
  if (published.kind !== "ready") throw unsafeChild(published, "create");
  return published;
}

function liveIdSet(source) {
  const raw = typeof source === "function" ? source() : source;
  if (raw == null) return new Set();
  if (typeof raw === "string") {
    throw scratchError("qq: scratch reconcile requires live session ids", "invalid-live");
  }
  const values = raw instanceof Set
    ? [...raw]
    : Array.isArray(raw)
      ? raw
      : typeof raw[Symbol.iterator] === "function"
        ? [...raw]
        : null;
  if (!values) {
    throw scratchError("qq: scratch reconcile requires live session ids", "invalid-live");
  }
  const ids = new Set();
  for (const value of values) {
    try {
      ids.add(normalizeSessionId(value));
    } catch {
      // Foreign live ids cannot name a managed child.
    }
  }
  return ids;
}

function preserve(name, path, reason) {
  return Object.freeze({ name, path, reason });
}

function inspectFailed(name, path, cause) {
  return Object.freeze({
    name,
    path,
    error: scratchError("qq: scratch reconcile could not inspect child", "inspect-failed", { cause }),
  });
}

/**
 * Create a scratch manager bounded to one configured root.
 * `fs` may replace node:fs methods in tests; production omits it.
 */
export function createScratchManager(options = {}) {
  if (typeof options === "string") options = { root: options };
  if (!options || typeof options !== "object") {
    throw scratchError("qq: scratch root must be an absolute path", "invalid-root");
  }
  const rawRoot = options.root;
  if (typeof rawRoot !== "string" || !rawRoot.startsWith("/") || rawRoot.includes("\0")) {
    throw scratchError("qq: scratch root must be an absolute path", "invalid-root");
  }
  const root = resolve(rawRoot);
  if (root !== resolve(root) || dirname(root) === root) {
    throw scratchError("qq: scratch root must be an absolute path", "invalid-root");
  }
  const io = bindFs(options.fs ?? {});

  function readyRoot() {
    return ensureRoot(io, root);
  }

  function create(sessionId) {
    const id = normalizeSessionId(sessionId);
    const currentRoot = readyRoot();
    const existing = inspectChild(io, currentRoot, id);
    if (existing.kind === "ready") return existing.path;
    if (existing.kind !== "missing") throw unsafeChild(existing, "create");
    return publish(io, currentRoot, id).path;
  }

  function verify(sessionId) {
    const id = normalizeSessionId(sessionId);
    const currentRoot = readyRoot();
    const existing = inspectChild(io, currentRoot, id);
    if (existing.kind !== "ready") {
      if (existing.kind === "missing") {
        throw scratchError("qq: scratch workspace not found", "not-found", { path: existing.path });
      }
      throw unsafeChild(existing, "verify");
    }
    return Object.freeze({
      sessionId: id,
      path: existing.path,
      marker: existing.marker,
    });
  }

  function remove(sessionId) {
    const id = normalizeSessionId(sessionId);
    const currentRoot = readyRoot();
    const existing = inspectChild(io, currentRoot, id);
    if (existing.kind === "missing") {
      return Object.freeze({ sessionId: id, path: existing.path, missing: true });
    }
    if (existing.kind !== "ready") throw unsafeChild(existing, "delete");
    try {
      io.rmSync(existing.path, { recursive: true, force: false });
    } catch (error) {
      throw scratchError("qq: scratch delete failed", "delete-failed", {
        cause: error,
        path: existing.path,
      });
    }
    const leftover = inspectChild(io, currentRoot, id);
    if (leftover.kind !== "missing") {
      throw scratchError("qq: scratch delete failed", "delete-failed", { path: existing.path });
    }
    return Object.freeze({ sessionId: id, path: existing.path, missing: false });
  }

  function reconcile(liveOwnedSessionIds) {
    let live;
    try {
      live = liveIdSet(liveOwnedSessionIds);
    } catch (error) {
      throw scratchError("qq: scratch reconcile requires live session ids", "invalid-live", { cause: error });
    }
    const currentRoot = readyRoot();
    let entries;
    try {
      entries = [...io.readdirSync(currentRoot, { withFileTypes: true })];
    } catch (error) {
      throw scratchError("qq: scratch root is not a readable directory", "unsafe-root", { cause: error });
    }
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));
    const deleted = [];
    const preserved = [];
    const errors = [];
    for (const entry of entries) {
      const name = entry.name;
      if (!name || name === "." || name === "..") continue;
      const path = join(currentRoot, name);
      if (!isDirectChild(currentRoot, path)) {
        preserved.push(preserve(name, path, "unrelated"));
        continue;
      }
      let info;
      try {
        info = io.lstatSync(path);
      } catch (error) {
        errors.push(inspectFailed(name, path, error));
        continue;
      }
      if (info.isSymbolicLink()) {
        preserved.push(preserve(name, path, "symlink"));
        continue;
      }
      if (!info.isDirectory()) {
        preserved.push(preserve(name, path, "unrelated"));
        continue;
      }
      let id;
      try {
        id = normalizeSessionId(name);
      } catch {
        preserved.push(preserve(name, path, "unrelated"));
        continue;
      }
      if (permissionMode(info) !== DIRECTORY_MODE) {
        preserved.push(preserve(name, path, "malformed"));
        continue;
      }
      const marker = readMarker(io, path, id);
      if (!marker.ok) {
        if (marker.reason === "error") {
          errors.push(inspectFailed(name, path, marker.error));
          continue;
        }
        preserved.push(preserve(name, path, marker.reason === "mismatch" ? "malformed" : marker.reason));
        continue;
      }
      if (live.has(id)) {
        preserved.push(preserve(name, path, "live"));
        continue;
      }
      try {
        io.rmSync(path, { recursive: true, force: false });
        const leftover = lstatOrNull(io, path);
        if (leftover) throw scratchError("qq: scratch delete failed", "delete-failed", { path });
        deleted.push(Object.freeze({ sessionId: id, path }));
      } catch (error) {
        errors.push(Object.freeze({
          name,
          path,
          error: scratchError("qq: scratch orphan delete failed", "delete-failed", { cause: error, path }),
        }));
      }
    }
    return Object.freeze({
      deleted: Object.freeze(deleted),
      preserved: Object.freeze(preserved),
      errors: Object.freeze(errors),
    });
  }

  return Object.freeze({
    root,
    create,
    verify,
    delete: remove,
    reconcile,
  });
}

export const internals = Object.freeze({
  DIRECTORY_MODE,
  MARKER_MODE,
  contained,
  isDirectChild,
  inspectRoot,
  inspectChild,
  readMarker,
  liveIdSet,
});
