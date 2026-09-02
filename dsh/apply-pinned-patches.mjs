import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const VERSION = "0.1.0-rc.7";
const SANDBOX_PACKAGE = "@deepseek-ai/dsh-sandbox";
const SANDBOX_ORIGINAL_SHA256 = "63ee2a10873a336162acd9a0d7da7f5f3dc59d072456a0b5271da277565e324f";
const ORIGINAL_TABLE = `const WIDER_MODES = {
\t"read-only": ["workspace-write", "danger-full-access"],
\t"workspace-write": ["danger-full-access"]
};`;
const PATCHED_TABLE = `const WIDER_MODES = {
\t"read-only": ["workspace-write", "danger-full-access"],
\t"workspace-write": ["danger-full-access"],
\t"danger-full-access": []
};`;
const ORIGINAL_GUARD = '\tif (!(WIDER_MODES[effectiveMode] ?? []).includes(mode)) throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call\'s current "${effectiveMode}" mode`);';
const PATCHED_GUARD = '\tif (!Object.hasOwn(WIDER_MODES, mode) || !Object.hasOwn(WIDER_MODES, effectiveMode)) throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call\'s current "${effectiveMode}" mode`);\n'
  + "\t// Redundant stale-schema arguments cannot widen the standing policy.\n"
  + "\tif (mode === effectiveMode || WIDER_MODES[mode].includes(effectiveMode)) return effectiveMode;\n"
  + ORIGINAL_GUARD;

const SESSION_QUERY_PACKAGE = "@deepseek-ai/dsh-session-query";
const SESSION_QUERY_ORIGINAL_SHA256 = "07d7e970d62cc041e246b3a43c0f21b0fd564a296814ff1df37d535c03b7d76f";
const SESSION_QUERY_CONFIG_ANCHOR = "const SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY = 4;";
const SESSION_QUERY_CONFIG_PATCH = `${SESSION_QUERY_CONFIG_ANCHOR}\nconst SESSION_QUERY_EVENT_DOCUMENT_SNAPSHOT_MAX_COORDINATES = 256;`;
const SESSION_QUERY_METHOD_ANCHOR = `\t/**
\t* List lightweight raw-log event records for one logical session.`;
const SESSION_QUERY_METHOD_PATCH = `\t/**
\t* Read bounded exact semantic documents and titles from one observation per session.
\t* @param requests - grouped session ids and exact event sequence numbers.
\t* @param signal - optional cancellation shared by all source reads.
\t* @returns one fulfilled or rejected result per unique requested session.
\t*/
\tasync readEventDocumentSnapshots(requests, signal) {
\t\tconst requested = materializeEventDocumentSnapshotRequests(requests);
\t\treturn this._corpus.projectMany([...requested.keys()], (source) => {
\t\t\tconst seqs = requested.get(source.header.id);
\t\t\tconst documents = buildSelectedSessionEventSearchDocuments(source.header.id, source.events, seqs);
\t\t\tconst title = foldSessionTitle(source.events);
\t\t\treturn {
\t\t\t\tsession: structuredClone(source.header),
\t\t\t\tdocuments,
\t\t\t\t...title === void 0 ? {} : { title }
\t\t\t};
\t\t}, signal);
\t}
${SESSION_QUERY_METHOD_ANCHOR}`;
const SESSION_QUERY_END_ANCHOR = `};
//#endregion
export { SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY, SESSION_QUERY_READ_WINDOW_MAX, SessionQueryEngine, SessionQueryEngine as default, SessionQueryError, SessionSearchCursor, assertSessionHeadersCompatible, buildSessionEventRecords, buildSessionEventSearchDocuments, compileSessionTextFilter, extractSessionEventText, filterSessionEventDocuments, filterSessionResults, materializeSessionEventResultFilters, materializeSessionResultFilters };`;
const SESSION_QUERY_END_PATCH = `};
function buildSelectedSessionEventSearchDocuments(sessionId, events, seqs) {
\tconst surfaceBySeq = classifySurface(events);
\tconst documents = [];
\tfor (const event of events) {
\t\tif (!seqs.has(event.seq)) continue;
\t\tconst text = extractSessionEventText(event);
\t\tif (text.length === 0) continue;
\t\tdocuments.push({
\t\t\tsessionId,
\t\t\tseq: event.seq,
\t\t\ttype: event.type,
\t\t\ttime: event.time,
\t\t\tsurface: surfaceBySeq.get(event.seq) ?? "log-only",
\t\t\ttext
\t\t});
\t}
\treturn documents;
}
function materializeEventDocumentSnapshotRequests(requests) {
\tif (requests.length > SESSION_QUERY_EVENT_DOCUMENT_SNAPSHOT_MAX_COORDINATES) throw new SessionQueryError(\`event document snapshot requests may contain at most \${SESSION_QUERY_EVENT_DOCUMENT_SNAPSHOT_MAX_COORDINATES} session groups\`, "SESSION_QUERY_INVALID_LIMIT");
\tconst grouped = /* @__PURE__ */ new Map();
\tlet coordinateCount = 0;
\tfor (const request of requests) {
\t\tif (request.seqs.length === 0) throw new SessionQueryError("event document snapshot sequence groups must not be empty", "SESSION_QUERY_INVALID_FILTER");
\t\tlet seqs = grouped.get(request.sessionId);
\t\tif (seqs === void 0) {
\t\t\tseqs = /* @__PURE__ */ new Set();
\t\t\tgrouped.set(request.sessionId, seqs);
\t\t}
\t\tfor (const seq of request.seqs) {
\t\t\tif (!Number.isSafeInteger(seq) || seq < 0) throw new SessionQueryError("event document snapshot sequences must be non-negative safe integers", "SESSION_QUERY_INVALID_FILTER");
\t\t\tif (seqs.has(seq)) continue;
\t\t\tseqs.add(seq);
\t\t\tcoordinateCount += 1;
\t\t\tif (coordinateCount > SESSION_QUERY_EVENT_DOCUMENT_SNAPSHOT_MAX_COORDINATES) throw new SessionQueryError(\`event document snapshots may contain at most \${SESSION_QUERY_EVENT_DOCUMENT_SNAPSHOT_MAX_COORDINATES} unique coordinates\`, "SESSION_QUERY_INVALID_LIMIT");
\t\t}
\t}
\treturn grouped;
}
//#endregion
export { SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY, SESSION_QUERY_EVENT_DOCUMENT_SNAPSHOT_MAX_COORDINATES, SESSION_QUERY_READ_WINDOW_MAX, SessionQueryEngine, SessionQueryEngine as default, SessionQueryError, SessionSearchCursor, assertSessionHeadersCompatible, buildSessionEventRecords, buildSessionEventSearchDocuments, compileSessionTextFilter, extractSessionEventText, filterSessionEventDocuments, filterSessionResults, materializeSessionEventResultFilters, materializeSessionResultFilters };`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function replaceExactly(value, original, replacement, packageName, description) {
  const first = value.indexOf(original);
  if (first < 0 || value.indexOf(original, first + original.length) >= 0) {
    throw new Error(`qq-dsh-toolchain: refusing to patch ${packageName}: expected one canonical ${description}`);
  }
  return value.slice(0, first) + replacement + value.slice(first + original.length);
}

export const patch = Object.freeze({
  package: SANDBOX_PACKAGE,
  version: VERSION,
  file: "lib/index.js",
  originalSha256: SANDBOX_ORIGINAL_SHA256,
  patchedSha256: "6ba9df009c4f02066dc78ea2abdeffdfeb37c5eef3292298fdad7d00629d39c3",
});

export const sessionQueryPatch = Object.freeze({
  package: SESSION_QUERY_PACKAGE,
  version: VERSION,
  file: "lib/index.js",
  originalSha256: SESSION_QUERY_ORIGINAL_SHA256,
  patchedSha256: "1cb32b032a6f0d0138640797081c37dbe5950cbd1fa963c4f294b28dfd4a3b4e",
});

export function patchSandboxSource(source) {
  const digest = sha256(source);
  if (digest === patch.patchedSha256) return { changed: false, source };
  if (digest !== patch.originalSha256) {
    throw new Error(`qq-dsh-toolchain: refusing to patch ${SANDBOX_PACKAGE}: unexpected ${patch.file} sha256 ${digest}`);
  }
  let patched = replaceExactly(source, ORIGINAL_TABLE, PATCHED_TABLE, SANDBOX_PACKAGE, "sandbox mode table");
  patched = replaceExactly(patched, ORIGINAL_GUARD, PATCHED_GUARD, SANDBOX_PACKAGE, "approveEscalation guard");
  const patchedDigest = sha256(patched);
  if (patchedDigest !== patch.patchedSha256) {
    throw new Error(`qq-dsh-toolchain: patched ${SANDBOX_PACKAGE} digest mismatch: ${patchedDigest}`);
  }
  return { changed: true, source: patched };
}

export function patchSessionQuerySource(source) {
  const digest = sha256(source);
  if (digest === sessionQueryPatch.patchedSha256) return { changed: false, source };
  if (digest !== sessionQueryPatch.originalSha256) {
    throw new Error(`qq-dsh-toolchain: refusing to patch ${SESSION_QUERY_PACKAGE}: unexpected ${sessionQueryPatch.file} sha256 ${digest}`);
  }
  let patched = replaceExactly(
    source,
    SESSION_QUERY_CONFIG_ANCHOR,
    SESSION_QUERY_CONFIG_PATCH,
    SESSION_QUERY_PACKAGE,
    "batch coordinate bound",
  );
  patched = replaceExactly(
    patched,
    SESSION_QUERY_METHOD_ANCHOR,
    SESSION_QUERY_METHOD_PATCH,
    SESSION_QUERY_PACKAGE,
    "event document batch method anchor",
  );
  patched = replaceExactly(
    patched,
    SESSION_QUERY_END_ANCHOR,
    SESSION_QUERY_END_PATCH,
    SESSION_QUERY_PACKAGE,
    "event document batch helper/export anchor",
  );
  const patchedDigest = sha256(patched);
  if (patchedDigest !== sessionQueryPatch.patchedSha256) {
    throw new Error(`qq-dsh-toolchain: patched ${SESSION_QUERY_PACKAGE} digest mismatch: ${patchedDigest}`);
  }
  return { changed: true, source: patched };
}

export function applyPinnedDshPatches(toolchainRoot = dirname(fileURLToPath(import.meta.url))) {
  let changed = false;
  for (const [descriptor, patchSource] of [
    [patch, patchSandboxSource],
    [sessionQueryPatch, patchSessionQuerySource],
  ]) {
    const packageRoot = join(toolchainRoot, "node_modules", ...descriptor.package.split("/"));
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    if (manifest.name !== descriptor.package || manifest.version !== descriptor.version) {
      throw new Error(`qq-dsh-toolchain: refusing to patch ${manifest.name ?? "unknown package"}@${manifest.version ?? "unknown version"}; expected ${descriptor.package}@${descriptor.version}`);
    }
    const target = join(packageRoot, descriptor.file);
    const result = patchSource(readFileSync(target, "utf8"));
    if (!result.changed) continue;
    const temporary = `${target}.qq-patch-${process.pid}`;
    writeFileSync(temporary, result.source, { mode: 0o644 });
    renameSync(temporary, target);
    changed = true;
  }
  return changed;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const changed = applyPinnedDshPatches();
  console.log(`qq-dsh-toolchain: ${changed ? "applied" : "verified"} pinned DSH patches`);
}
