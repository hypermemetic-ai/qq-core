import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export const FIND_SESSION_SKILL = "find-session";
export const SESSION_HISTORY_TOOL = "session_history";

const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONVERSATION_TYPES = Object.freeze(["user/message", "assistant/message"]);
// Surface policy is deliberately internal. Historical conversational clues may
// survive replacement/compaction, while raw-log-only documents never qualify.
const CONVERSATION_SURFACES = Object.freeze(["current", "shadowed"]);
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;
const MAX_SEARCH_QUERIES = 5;
const MULTI_QUERY_SOURCE_DEPTH = 100;
const RRF_K = 60;
const SEARCH_BATCH_VERSION = "search-batch-v1";
const SEARCH_BATCH_RESPONSE_VERSION = "search-batch-response-v1";
const MAX_BATCH_RESULTS = 100;
const MAX_AUTHORIZED_WORKSPACES = 16;
const MAX_VERIFICATION_POINTERS = 256;
const MAX_VERIFICATION_CONCURRENCY = 4;
const SEARCH_STRATEGY_VERSION = "progressive-depth-v1";
const MAX_SNIPPET_BYTES = 1_280;
const MAX_TITLE_CHARS = 256;
const MAX_TITLE_BYTES = 1_024;
const DEFAULT_CONTEXT_WINDOW = 3;
const MAX_CONTEXT_WINDOW = 12;
const CONTEXT_RAW_EVENT_BOUND = 50;
const MAX_CONTEXT_MESSAGE_CHARS = 900;
const MAX_CONTEXT_TEXT_CHARS = 11_000;
const MAX_CONTEXT_OUTPUT_BYTES = 16 * 1024;
const TRUNCATION_MARKER = " [truncated]";
const MAX_QUERY_CHARS = 500;
const MAX_SNIPPET_CHARS = 320;
const GRANT_ERROR = "session_history is not authorized for this agent turn";
const GESTURE = /(^|\s)\/find-session(?=\s|$)/u;
const SEARCH_KEYS = new Set([
  "action", "queries", "after", "before", "workspace", "limit", "cursor", "sessionScope",
]);
const CONTEXT_KEYS = new Set(["action", "sessionId", "seq", "before", "after"]);

export const FIND_SESSION_INSTRUCTIONS = [
  "Find prior DSH sessions without resuming or changing them.",
  "Use `session_history` with action `search` first. Pass `queries` as 1–5 distinctive literal DSH words or phrases. One exact search is an array of one; repeated normalized queries contribute once.",
  "Search is lexical. Two or more queries are fused with reciprocal-rank fusion, so use separate clues rather than Boolean syntax. The returned score is relative rank, not confidence.",
  "Search covers user/assistant conversation only. Tool calls, tool results, todos, errors, reasoning, and attachments are not available through this tool.",
  "Search defaults to other sessions. Use sessionScope `current` or `all` only when needed; the invoking user message and later events are excluded when the caller is in scope.",
  "Inspect promising matches with action `context` and a small before/after conversational-message count. The target is always focused; context is one bounded neighborhood read, never a raw transcript.",
  "Report the stable `sessionId` and concise evidence (matching seq/time/role and nearby text). Copy that `sessionId` directly into context. Treat transcripts as authoritative and read-only.",
].join("\n");

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function rejectUnknown(args, allowed, action) {
  const unexpected = Object.keys(args).find((name) => !allowed.has(name));
  if (unexpected) {
    throw new TypeError(`session_history ${action} does not accept ${unexpected}`);
  }
}

function normalizedLiteral(value) {
  return String(value ?? "").replaceAll(/\s+/g, " ").trim().toLowerCase();
}

function normalizeQueries(value) {
  if (!Array.isArray(value)) {
    throw new TypeError("session_history search requires a queries array");
  }
  const queries = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new TypeError("session_history queries entries must be strings");
    }
    const query = entry.replaceAll(/\s+/g, " ").trim();
    if (!query) continue;
    if (query.length > MAX_QUERY_CHARS) {
      throw new TypeError(`session_history literal query exceeds ${MAX_QUERY_CHARS} characters`);
    }
    const key = normalizedLiteral(query);
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
  }
  if (queries.length < 1 || queries.length > MAX_SEARCH_QUERIES) {
    throw new TypeError(`session_history queries must contain 1 to ${MAX_SEARCH_QUERIES} unique non-empty literals after normalization`);
  }
  return queries;
}

function pageLimit(value) {
  const limit = value ?? DEFAULT_SEARCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw new TypeError(`session_history limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}`);
  }
  return limit;
}

function windowSize(name, value) {
  const size = value ?? DEFAULT_CONTEXT_WINDOW;
  if (!Number.isInteger(size) || size < 0 || size > MAX_CONTEXT_WINDOW) {
    throw new TypeError(`session_history ${name} must be an integer between 0 and ${MAX_CONTEXT_WINDOW}`);
  }
  return size;
}

function timestamp(name, value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`session_history ${name} must be an ISO-8601 time or epoch milliseconds`);
  }
  return parsed;
}

function roleOf(type) {
  if (type === "user/message") return "user";
  if (type === "assistant/message") return "assistant";
  throw new Error(`session_history refused non-conversation event type ${String(type)}`);
}

function isoTime(value) {
  const parsed = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value ?? "");
}

function compactText(value, maxChars) {
  const text = String(value ?? "").replaceAll(/\s+/g, " ").trim();
  if (text.length <= maxChars) return { text, truncated: false };
  if (maxChars <= TRUNCATION_MARKER.length) {
    return { text: text.slice(0, Math.max(0, maxChars)), truncated: true };
  }
  return {
    text: `${text.slice(0, maxChars - TRUNCATION_MARKER.length).trimEnd()}${TRUNCATION_MARKER}`,
    truncated: true,
  };
}

function contextOutputBytes(result) {
  return Buffer.byteLength(JSON.stringify(result, null, 2), "utf8");
}

function truncationSource(event) {
  if (event.truncated === true && event.text.endsWith(TRUNCATION_MARKER)) {
    return event.text.slice(0, -TRUNCATION_MARKER.length).trimEnd();
  }
  return event.text;
}

function markedPrefix(codePoints, length) {
  const prefix = codePoints.slice(0, length).join("").trimEnd();
  return prefix ? `${prefix}${TRUNCATION_MARKER}` : TRUNCATION_MARKER.trimStart();
}

function enforceContextCeiling(result, targetSeq, messages) {
  if (contextOutputBytes(result) <= MAX_CONTEXT_OUTPUT_BYTES) return;
  result.truncated = true;
  const candidates = [...messages].sort((left, right) => (
    (left.seq === targetSeq ? 1 : 0) - (right.seq === targetSeq ? 1 : 0)
    || Math.abs(right.seq - targetSeq) - Math.abs(left.seq - targetSeq)
  ));
  for (const event of candidates) {
    if (contextOutputBytes(result) <= MAX_CONTEXT_OUTPUT_BYTES) break;
    const codePoints = Array.from(truncationSource(event));
    if (codePoints.length === 0) continue;
    event.truncated = true;
    event.text = markedPrefix(codePoints, 0);
    if (contextOutputBytes(result) > MAX_CONTEXT_OUTPUT_BYTES) continue;

    // Restore as much of this message as the exact serialized UTF-8 budget
    // permits. Code-point slicing keeps surrogate pairs and JSON valid.
    let low = 0;
    let high = codePoints.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      event.text = markedPrefix(codePoints, middle);
      if (contextOutputBytes(result) <= MAX_CONTEXT_OUTPUT_BYTES) low = middle;
      else high = middle - 1;
    }
    event.text = markedPrefix(codePoints, low);
  }
  if (contextOutputBytes(result) > MAX_CONTEXT_OUTPUT_BYTES) {
    throw new Error("session_history could not satisfy its fixed context output ceiling");
  }
}

function conversationText(event) {
  let content;
  if (event?.type === "user/message") content = event.data?.content;
  else if (event?.type === "assistant/message") content = event.data?.message?.content;
  else return "";
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function headerId(hit) {
  return hit?.header?.id ?? hit?.session?.id ?? hit?.id;
}

function requireQueryService(sessionQuery) {
  if (!sessionQuery || typeof sessionQuery !== "object") {
    throw new Error("session_history is unavailable: ctx.sessionQuery is not mounted");
  }
  return sessionQuery;
}

function requireIndexService(service) {
  if (!service || typeof service !== "object" || Array.isArray(service)) {
    throw new Error("session_history search is unavailable: qq-session-index is not mounted");
  }
  for (const method of [
    "ready", "searchBatch", "deriveWorkspaceScopeToken", "verifyDshSearchCandidates",
  ]) {
    if (typeof service[method] !== "function") {
      throw new Error(`session_history search is unavailable: qq-session-index.${method} is not mounted`);
    }
  }
  let ready;
  try { ready = service.ready(); } catch (error) {
    throw new Error("session_history search is unavailable: qq-session-index readiness failed", { cause: error });
  }
  if (ready !== true) {
    throw new Error("session_history search is unavailable: qq-session-index is not ready");
  }
  return service;
}

function stableIdCompare(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Deterministic standard reciprocal-rank fusion. Each source entry is one
 * lightweight session hit with a one-based sourceRank. Query sources are equally
 * weighted and each contributes at most once to a session.
 */
function reciprocalRankFuse(sources) {
  const candidates = new Map();
  for (let queryIndex = 0; queryIndex < sources.length; queryIndex += 1) {
    const contributed = new Set();
    for (const entry of sources[queryIndex] ?? []) {
      const sessionId = headerId(entry.hit);
      if (!sessionId || contributed.has(sessionId)) continue;
      contributed.add(sessionId);
      let candidate = candidates.get(sessionId);
      if (!candidate) {
        candidate = {
          sessionId,
          hit: entry.hit,
          score: 0,
          bestSourceRank: Number.POSITIVE_INFINITY,
          strongestTime: Number.NEGATIVE_INFINITY,
          evidence: [],
        };
        candidates.set(sessionId, candidate);
      }
      const sourceRank = entry.sourceRank;
      const numericTime = typeof entry.document.time === "number"
        ? entry.document.time
        : Date.parse(String(entry.document.time ?? ""));
      candidate.score += 1 / (RRF_K + sourceRank);
      candidate.bestSourceRank = Math.min(candidate.bestSourceRank, sourceRank);
      if (Number.isFinite(numericTime)) candidate.strongestTime = Math.max(candidate.strongestTime, numericTime);
      candidate.evidence.push({
        queryIndex,
        sourceRank,
        document: entry.document,
        record: entry.record ?? entry.hit?.bestMatch,
        query: entry.query,
      });
    }
  }
  return [...candidates.values()].sort((left, right) => (
    right.score - left.score
    || left.bestSourceRank - right.bestSourceRank
    || right.strongestTime - left.strongestTime
    || stableIdCompare(left.sessionId, right.sessionId)
  ));
}

function searchScope(value) {
  const scope = value ?? "other";
  if (!new Set(["other", "all", "current"]).has(scope)) {
    throw new TypeError('session_history sessionScope must be "other", "all", or "current"');
  }
  return scope;
}

function requestCursor(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value) {
    throw new TypeError("session_history cursor must be a non-empty opaque string");
  }
  return value;
}

function searchPlan(args, exec) {
  rejectUnknown(args, SEARCH_KEYS, "search");
  const queries = normalizeQueries(args.queries);
  const limit = pageLimit(args.limit);
  const after = timestamp("after", args.after);
  const explicitBefore = timestamp("before", args.before);
  const workspace = args.workspace ?? "current";
  if (workspace !== "current" && workspace !== "all") {
    throw new TypeError('session_history workspace must be "current" or "all"');
  }
  const sessionScope = searchScope(args.sessionScope);
  const callerId = exec.agent?.session?.id;
  const cwd = exec.agent?.session?.header?.cwd;
  if (workspace === "current" && (typeof cwd !== "string" || !cwd)) {
    throw new Error("session_history cannot determine the calling workspace");
  }
  if ((sessionScope === "other" || sessionScope === "current") && (typeof callerId !== "string" || !callerId)) {
    throw new Error("session_history cannot determine the calling session");
  }

  let before = explicitBefore;
  let asOf;
  if (sessionScope !== "other") {
    asOf = timestamp("invoking direct-user time", exec.asOf ?? exec.invokingMessageTime);
    if (asOf === undefined) {
      throw new Error("session_history cannot include the caller without an invoking direct-user as-of boundary");
    }
    // DSH's event-time range is inclusive. Millisecond event times are integer,
    // so one less than the invoking instant is the exact exclusive upper bound.
    const exclusiveUpper = Math.ceil(asOf) - 1;
    before = before === undefined ? exclusiveUpper : Math.min(before, exclusiveUpper);
  }
  if (after !== undefined && before !== undefined && after > before) {
    throw new TypeError("session_history after must not be later than the effective before/as-of bound");
  }

  const sessionFilters = [];
  if (workspace === "current") sessionFilters.push({ kind: "cwd", values: [cwd] });
  if (sessionScope === "current") sessionFilters.push({ kind: "id", values: [callerId] });
  const eventFilters = [];
  if (after !== undefined || before !== undefined) {
    eventFilters.push({
      kind: "time",
      ...(after === undefined ? {} : { from: after }),
      ...(before === undefined ? {} : { to: before }),
    });
  }
  eventFilters.push({ kind: "type", values: CONVERSATION_TYPES });
  eventFilters.push({ kind: "surface", values: CONVERSATION_SURFACES });

  return {
    queries,
    limit,
    after,
    before,
    explicitBefore,
    workspace,
    sessionScope,
    callerId,
    cwd,
    asOf,
    cursor: requestCursor(args.cursor),
    sessionFilters,
    eventFilters,
  };
}

function workspaceIdsFor(plan, listAuthorizedWorkspaceIds) {
  if (plan.workspace === "current") return [plan.cwd];
  if (typeof listAuthorizedWorkspaceIds !== "function") {
    throw new Error("session_history cannot enumerate the authorized all-workspaces scope");
  }
  const listed = listAuthorizedWorkspaceIds();
  if (!Array.isArray(listed)) {
    throw new Error("session_history authorized workspace resolver returned a malformed result");
  }
  const workspaceIds = [];
  const seen = new Set();
  for (const value of [plan.cwd, ...listed]) {
    if (typeof value !== "string" || !value || value.includes("\0") || seen.has(value)) continue;
    seen.add(value);
    workspaceIds.push(value);
  }
  if (workspaceIds.length < 1 || workspaceIds.length > MAX_AUTHORIZED_WORKSPACES) {
    throw new Error(
      `session_history all-workspaces scope must contain 1 to ${MAX_AUTHORIZED_WORKSPACES} authorized workspaces`,
    );
  }
  return workspaceIds;
}

function searchDepthLadder(limit) {
  const first = Math.min(MULTI_QUERY_SOURCE_DEPTH, Math.max(8, limit * 3));
  const second = Math.min(MULTI_QUERY_SOURCE_DEPTH, Math.max(32, first * 3));
  return [...new Set([first, second, MULTI_QUERY_SOURCE_DEPTH])];
}

function searchBatchRequest(plan, workspaceIds, scopeTokens, depth) {
  const filters = {
    authorizedScopeTokens: scopeTokens,
    workspaceIds,
    surfaceAllowList: CONVERSATION_SURFACES,
    eventTypeAllowList: CONVERSATION_TYPES,
    ...(plan.sessionScope === "current" ? { includeSessionIds: [plan.callerId] } : {}),
    ...(plan.sessionScope === "other" ? { excludeSessionIds: [plan.callerId] } : {}),
    ...(plan.after === undefined ? {} : { notBeforeEventTimeUnixMs: plan.after }),
    ...(plan.before === undefined ? {} : { notAfterEventTimeUnixMs: plan.before }),
  };
  return {
    version: SEARCH_BATCH_VERSION,
    literals: plan.queries,
    perSourceDepth: depth,
    finalLimit: Math.min(MAX_BATCH_RESULTS, Math.max(depth, plan.limit * 2)),
    filters,
  };
}

function elapsedMilliseconds(startedAt) {
  return Math.round((performance.now() - startedAt) * 1_000) / 1_000;
}

function candidateSetTruncated(response) {
  return response.fusedTruncated || response.sources.some(({ truncated }) => truncated);
}

function verificationBudget(response) {
  const contributions = response.fused.reduce((total, candidate) => (
    total + candidate.contributions.length
  ), 0);
  return Math.max(1, Math.min(MAX_VERIFICATION_POINTERS, contributions));
}

function searchCounts(response, verificationCandidates, authorizedCandidates) {
  const coordinates = new Set();
  for (const candidate of response.fused) {
    for (const contribution of candidate.contributions) {
      coordinates.add(`${candidate.sessionId}\0${contribution.seq}`);
    }
  }
  return {
    sourceHits: response.sources.reduce((total, source) => total + source.ranked.length, 0),
    fusedCandidates: response.fused.length,
    verifiedCandidates: verificationCandidates,
    authorizedCandidates,
    uniqueSessions: new Set(response.fused.map(({ sessionId }) => sessionId)).size,
    coordinates: coordinates.size,
  };
}

function canonicalSequence(value) {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)
    && Number.isSafeInteger(Number(value));
}

function protocolSessionId(value) {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") >= 1
    && Buffer.byteLength(value, "utf8") <= 128;
}

function validateBatchResponse(response, queryCount) {
  requireObject(response, "qq-session-index search response");
  if (response.type !== "searchBatch" || response.version !== SEARCH_BATCH_RESPONSE_VERSION) {
    throw new Error("session_history refused a malformed qq-session-index search response version");
  }
  const snapshot = response.snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
      || !canonicalSequence(snapshot.generation) || !canonicalSequence(snapshot.sourceWatermark)
      || (snapshot.sourceLagMs !== null
        && (!Number.isSafeInteger(snapshot.sourceLagMs) || snapshot.sourceLagMs < 0))) {
    throw new Error("session_history refused a malformed qq-session-index search snapshot");
  }
  if (!Array.isArray(response.sources) || response.sources.length !== queryCount
      || !Array.isArray(response.fused) || response.fused.length > MAX_BATCH_RESULTS
      || typeof response.fusedTruncated !== "boolean") {
    throw new Error("session_history refused a malformed qq-session-index search response");
  }
  for (let index = 0; index < response.sources.length; index += 1) {
    const source = response.sources[index];
    if (!source || typeof source !== "object" || source.queryOrdinal !== index
        || !Array.isArray(source.ranked) || source.ranked.length > MULTI_QUERY_SOURCE_DEPTH
        || typeof source.truncated !== "boolean"
        || !["exhausted", "source-depth", "posting-budget"].includes(source.truncationReason)
        || !Number.isInteger(source.rawPostingsScanned)
        || source.rawPostingsScanned < 0 || source.rawPostingsScanned > 256) {
      throw new Error("session_history refused malformed qq-session-index source results");
    }
    const sourceIds = new Set();
    for (const [rank, hit] of source.ranked.entries()) {
      const pointer = hit?.evidence;
      if (!hit || typeof hit !== "object" || hit.rank !== rank + 1
          || !protocolSessionId(hit.sessionId) || sourceIds.has(hit.sessionId)
          || !Number.isFinite(hit.score) || !pointer || typeof pointer !== "object"
          || pointer.sessionId !== hit.sessionId || !pointer.documentKey
          || typeof pointer.documentKey !== "string" || !canonicalSequence(pointer.seq)
          || !Number.isSafeInteger(pointer.eventTimeUnixMs)
          || !CONVERSATION_TYPES.includes(pointer.eventType)
          || !CONVERSATION_SURFACES.includes(pointer.surface)
          || (pointer.snippet !== null && typeof pointer.snippet !== "string")) {
        throw new Error("session_history refused malformed qq-session-index ranked evidence");
      }
      sourceIds.add(hit.sessionId);
    }
  }
  const fusedIds = new Set();
  for (const [index, candidate] of response.fused.entries()) {
    if (!candidate || typeof candidate !== "object" || candidate.rank !== index + 1
        || !protocolSessionId(candidate.sessionId) || fusedIds.has(candidate.sessionId)
        || !Number.isFinite(candidate.rrfScore) || !Array.isArray(candidate.contributions)
        || candidate.contributions.length < 1
        || candidate.contributions.length > queryCount) {
      throw new Error("session_history refused malformed qq-session-index fused results");
    }
    fusedIds.add(candidate.sessionId);
    const ordinals = new Set();
    for (const contribution of candidate.contributions) {
      if (!contribution || typeof contribution !== "object"
          || !Number.isInteger(contribution.queryOrdinal)
          || contribution.queryOrdinal < 0 || contribution.queryOrdinal >= queryCount
          || ordinals.has(contribution.queryOrdinal)
          || !Number.isInteger(contribution.sourceRank) || contribution.sourceRank < 1
          || contribution.sourceRank > MULTI_QUERY_SOURCE_DEPTH
          || !Number.isFinite(contribution.contribution)
          || !contribution.documentKey || typeof contribution.documentKey !== "string"
          || !canonicalSequence(contribution.seq)
          || (contribution.snippet !== null && typeof contribution.snippet !== "string")) {
        throw new Error("session_history refused malformed qq-session-index fused contributions");
      }
      ordinals.add(contribution.queryOrdinal);
    }
  }

  // Validate the complete untrusted protocol response before applying the qq-core
  // identity boundary. Durable databases may contain legacy raw UUID sessions,
  // but exact DSH reads and authoritative metadata only accept canonical IDs.
  // Keep original ranks/contributions: filtering must not reinterpret the daemon
  // snapshot or allow an invalid field on an omitted row to escape validation.
  const canonicalEvidence = new Set();
  const sources = response.sources.map((source) => ({
    ...source,
    ranked: source.ranked.filter((hit) => {
      if (!SESSION_ID.test(hit.sessionId)) return false;
      canonicalEvidence.add(evidenceKey(
        hit.sessionId,
        source.queryOrdinal,
        hit.evidence.seq,
        hit.evidence.documentKey,
      ));
      return true;
    }),
  }));
  const fused = response.fused.filter((candidate) => (
    SESSION_ID.test(candidate.sessionId) && candidate.contributions.some((contribution) => (
      canonicalEvidence.has(evidenceKey(
        candidate.sessionId,
        contribution.queryOrdinal,
        contribution.seq,
        contribution.documentKey,
      ))
    ))
  ));
  return { ...response, sources, fused };
}

function evidenceKey(sessionId, queryOrdinal, seq, documentKey) {
  return JSON.stringify([sessionId, queryOrdinal, String(seq), documentKey]);
}

function boundedPresentationString(value, maxChars, maxBytes, { normalized = false } = {}) {
  if (typeof value !== "string" || value.length < 1 || value.length > maxChars
      || Buffer.byteLength(value, "utf8") > maxBytes) return false;
  return normalized ? value === value.replaceAll(/\s+/g, " ").trim() : value === value.trim();
}

function verifiedFusedCandidates(response, verification, plan) {
  requireObject(verification, "qq-session-index verification response");
  if (!Array.isArray(verification.verifiedCandidates)
      || verification.verifiedCandidates.length > MAX_BATCH_RESULTS
      || !Array.isArray(verification.verifiedEvidence)
      || verification.verifiedEvidence.length > MAX_VERIFICATION_POINTERS) {
    throw new Error("session_history refused a malformed qq-session-index verification response");
  }
  const responseIds = new Set(response.fused.map(({ sessionId }) => sessionId));
  const verifiedCandidates = new Map();
  for (const candidate of verification.verifiedCandidates) {
    if (!candidate || typeof candidate !== "object" || !SESSION_ID.test(candidate.sessionId)
        || !responseIds.has(candidate.sessionId) || verifiedCandidates.has(candidate.sessionId)
        || (candidate.title !== undefined
          && !boundedPresentationString(candidate.title, MAX_TITLE_CHARS, MAX_TITLE_BYTES))) {
      throw new Error("session_history refused malformed qq-session-index verified candidates");
    }
    verifiedCandidates.set(candidate.sessionId, candidate);
  }
  const evidence = new Map();
  for (const item of verification.verifiedEvidence) {
    if (!item || typeof item !== "object" || !SESSION_ID.test(item.sessionId)
        || !verifiedCandidates.has(item.sessionId)
        || !Number.isInteger(item.queryOrdinal) || item.queryOrdinal < 0
        || item.queryOrdinal >= plan.queries.length || typeof item.seq !== "string"
        || !/^(?:0|[1-9][0-9]*)$/u.test(item.seq)
        || !Number.isSafeInteger(Number(item.seq)) || typeof item.documentKey !== "string"
        || !item.documentKey || !CONVERSATION_TYPES.includes(item.eventType)
        || !CONVERSATION_SURFACES.includes(item.surface)
        || !Number.isSafeInteger(item.eventTimeUnixMs)
        || !boundedPresentationString(
          item.snippet,
          MAX_SNIPPET_CHARS,
          MAX_SNIPPET_BYTES,
          { normalized: true },
        )) {
      throw new Error("session_history refused malformed qq-session-index verified evidence");
    }
    const key = evidenceKey(item.sessionId, item.queryOrdinal, item.seq, item.documentKey);
    if (evidence.has(key)) {
      throw new Error("session_history refused duplicate qq-session-index verified evidence");
    }
    evidence.set(key, item);
  }

  const fusedIds = new Set();
  return response.fused.flatMap((candidate) => {
    if (!SESSION_ID.test(candidate.sessionId) || fusedIds.has(candidate.sessionId)) {
      throw new Error("session_history refused malformed qq-session-index fused session ids");
    }
    fusedIds.add(candidate.sessionId);
    const verifiedCandidate = verifiedCandidates.get(candidate.sessionId);
    if (!verifiedCandidate) return [];
    const queryOrdinals = new Set();
    const contributions = candidate.contributions.map((contribution) => {
      if (!contribution || typeof contribution !== "object"
          || !Number.isInteger(contribution.queryOrdinal)
          || contribution.queryOrdinal < 0 || contribution.queryOrdinal >= plan.queries.length
          || queryOrdinals.has(contribution.queryOrdinal)
          || !Number.isInteger(contribution.sourceRank) || contribution.sourceRank < 1
          || contribution.sourceRank > MULTI_QUERY_SOURCE_DEPTH
          || typeof contribution.seq !== "string"
          || !/^(?:0|[1-9][0-9]*)$/u.test(contribution.seq)
          || !Number.isSafeInteger(Number(contribution.seq))
          || typeof contribution.documentKey !== "string" || !contribution.documentKey) {
        throw new Error("session_history refused malformed qq-session-index fused contributions");
      }
      queryOrdinals.add(contribution.queryOrdinal);
      const verified = evidence.get(evidenceKey(
        candidate.sessionId,
        contribution.queryOrdinal,
        contribution.seq,
        contribution.documentKey,
      ));
      if (!verified
          || (plan.after !== undefined && verified.eventTimeUnixMs < plan.after)
          || (plan.before !== undefined && verified.eventTimeUnixMs > plan.before)) return undefined;
      return {
        queryIndex: contribution.queryOrdinal,
        sourceRank: contribution.sourceRank,
        document: {
          seq: Number(verified.seq),
          time: verified.eventTimeUnixMs,
          type: verified.eventType,
          snippet: verified.snippet,
        },
      };
    });
    // Every source contribution must remain exact-read authoritative in both the
    // verifier and this independently validated consumer.
    if (contributions.some((contribution) => contribution === undefined)) return [];
    return [{
      sessionId: candidate.sessionId,
      score: candidate.rrfScore,
      title: verifiedCandidate.title ?? "",
      evidence: contributions,
    }];
  });
}

async function authoritativeRecords(sessionQuery, ids, signal) {
  if (ids.length === 0) return new Map();
  if (typeof sessionQuery.filterSessions !== "function") {
    throw new Error("session_history search requires authoritative session metadata filters");
  }
  const records = await sessionQuery.filterSessions([{ kind: "id", values: ids }], signal);
  signal?.throwIfAborted?.();
  if (!Array.isArray(records) || records.length > ids.length) {
    throw new Error("session_history refused malformed authoritative session metadata");
  }
  const allowed = new Set(ids);
  const byId = new Map();
  for (const record of records) {
    const id = record?.header?.id;
    if (!allowed.has(id) || byId.has(id) || typeof record.header?.cwd !== "string") {
      throw new Error("session_history refused malformed authoritative session metadata");
    }
    byId.set(id, record);
  }
  return byId;
}

function searchFingerprint(plan) {
  return JSON.stringify({
    queries: plan.queries.map(normalizedLiteral),
    after: plan.after ?? null,
    before: plan.before ?? null,
    workspace: plan.workspace,
    sessionScope: plan.sessionScope,
    callerId: plan.callerId ?? null,
    cwd: plan.cwd ?? null,
    authorizedWorkspaceIds: plan.authorizedWorkspaceIds ?? null,
    asOf: plan.asOf ?? null,
    limit: plan.limit,
    strategyVersion: SEARCH_STRATEGY_VERSION,
  });
}

function contextBoundary(requested, returned, rawCount, rawBound, edge) {
  if (returned >= requested) {
    return { requested, returned, reached: true };
  }
  const atSessionEdge = rawCount < rawBound;
  return {
    requested,
    returned,
    reached: false,
    reason: atSessionEdge ? edge : "raw-event-bound",
  };
}

/**
 * Thin, read-only presentation adapter over the injected durable session index
 * and DSH's authoritative exact-read service. It owns only disposable verified
 * fused-page cursor state, never an alternate transcript corpus.
 */
export function createSessionHistoryAdapter(sessionQuery, qqSessionIndex, options = {}) {
  requireQueryService(sessionQuery);
  const aliasFor = typeof options.aliasFor === "function" ? options.aliasFor : () => "";
  const listAuthorizedWorkspaceIds = options.listAuthorizedWorkspaceIds;
  const fusedCursors = new Map();
  let disposed = false;

  function assertLive() {
    if (disposed) throw new Error("session_history adapter is disposed");
  }

  function formatCandidate(candidate) {
    const record = candidate.record;
    const id = candidate.sessionId;
    let alias = "";
    if (record.live === true) {
      try { alias = String(aliasFor(id) ?? "").trim(); } catch { alias = ""; }
    }
    return {
      sessionId: id,
      ...(alias ? { alias } : {}),
      ...(candidate.title ? { title: candidate.title } : {}),
      createdAt: isoTime(record.header?.createdAt),
      cwd: record.header?.cwd ?? null,
      live: record.live === true,
      persisted: record.persisted === true,
      score: candidate.score,
      matchedQueryCount: candidate.evidence.length,
      evidence: [...candidate.evidence]
        .sort((left, right) => left.queryIndex - right.queryIndex)
        .map(({ queryIndex, sourceRank, document }) => ({
          queryIndex,
          sourceRank,
          seq: document.seq,
          time: isoTime(document.time),
          role: roleOf(document.type),
          snippet: document.snippet,
        })),
    };
  }

  function fusedPage(plan, fingerprint, frozen, offset, totalStartedAt, diagnostics) {
    const formatStartedAt = performance.now();
    const selected = frozen.candidates.slice(offset, offset + plan.limit);
    const results = selected.map((candidate) => formatCandidate(candidate));
    const titleFormat = elapsedMilliseconds(formatStartedAt);
    const nextOffset = offset + selected.length;
    let nextCursor;
    if (nextOffset < frozen.candidates.length) {
      nextCursor = `qq-session-history:${randomUUID()}`;
      fusedCursors.set(nextCursor, { fingerprint, frozen, offset: nextOffset });
    }
    return {
      action: "search",
      queries: plan.queries,
      workspace: plan.workspace,
      sessionScope: plan.sessionScope,
      candidateSetTruncated: frozen.candidateSetTruncated,
      diagnostics: {
        ...diagnostics,
        timingsMs: {
          ...diagnostics.timingsMs,
          titleFormat,
          total: elapsedMilliseconds(totalStartedAt),
        },
      },
      results,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  async function search(input, exec = {}) {
    const totalStartedAt = performance.now();
    assertLive();
    const args = requireObject(input, "session_history search input");
    const plan = searchPlan(args, exec);
    const index = requireIndexService(qqSessionIndex);
    exec.signal?.throwIfAborted?.();

    const authorizedWorkspaceIds = workspaceIdsFor(plan, listAuthorizedWorkspaceIds);
    const scopeTokens = authorizedWorkspaceIds.map((workspaceId) => {
      const token = index.deriveWorkspaceScopeToken(workspaceId);
      if (typeof token !== "string" || !/^[a-z0-9]{1,64}$/u.test(token)) {
        throw new Error("session_history refused a malformed canonical workspace scope token");
      }
      return token;
    });
    if (new Set(scopeTokens).size !== scopeTokens.length) {
      throw new Error("session_history refused colliding canonical workspace scope tokens");
    }
    plan.authorizedWorkspaceIds = authorizedWorkspaceIds;
    const fingerprint = searchFingerprint(plan);

    if (plan.cursor) {
      const continuation = fusedCursors.get(plan.cursor);
      fusedCursors.delete(plan.cursor);
      if (!continuation || continuation.fingerprint !== fingerprint) {
        throw new TypeError("session_history cursor is invalid for this search request or grant");
      }
      // A valid continuation remains a search invocation: perform exactly one
      // fail-closed durable operation, while page membership/order stays frozen
      // to the previously verified snapshot carried only by this one-use token.
      const daemonStartedAt = performance.now();
      validateBatchResponse(await index.searchBatch(
        searchBatchRequest(plan, authorizedWorkspaceIds, scopeTokens, continuation.frozen.depth),
        { signal: exec.signal },
      ), plan.queries.length);
      const daemonSearch = elapsedMilliseconds(daemonStartedAt);
      exec.signal?.throwIfAborted?.();
      return fusedPage(plan, fingerprint, continuation.frozen, continuation.offset, totalStartedAt, {
        ...continuation.frozen.diagnostics,
        continuation: true,
        timingsMs: {
          daemonSearch,
          exactVerification: 0,
          metadataAuthorization: 0,
        },
      });
    }

    const depths = searchDepthLadder(plan.limit);
    let daemonSearch = 0;
    let exactVerification = 0;
    let metadataAuthorization = 0;
    let final;
    for (const [rungIndex, depth] of depths.entries()) {
      // Each rung covers all normalized literals in one immutable daemon snapshot.
      // Expansion happens only when verified authorized results cannot fill the page.
      const daemonStartedAt = performance.now();
      const request = searchBatchRequest(plan, authorizedWorkspaceIds, scopeTokens, depth);
      const response = validateBatchResponse(await index.searchBatch(
        request,
        { signal: exec.signal },
      ), plan.queries.length);
      daemonSearch += elapsedMilliseconds(daemonStartedAt);
      exec.signal?.throwIfAborted?.();

      const maxCandidates = verificationBudget(response);
      const verificationStartedAt = performance.now();
      const verification = await index.verifyDshSearchCandidates({
        searchResponse: response,
        sessionQuery,
        literals: plan.queries,
        eventTypeAllowList: CONVERSATION_TYPES,
        surfaceAllowList: CONVERSATION_SURFACES,
        maxConcurrency: MAX_VERIFICATION_CONCURRENCY,
        maxCandidates,
        signal: exec.signal,
      });
      exactVerification += elapsedMilliseconds(verificationStartedAt);
      exec.signal?.throwIfAborted?.();
      let candidates = verifiedFusedCandidates(response, verification, plan);
      const verifiedCount = candidates.length;

      // Bind every verified hit to current authoritative metadata before exposing
      // transcript-derived presentation facts.
      const metadataStartedAt = performance.now();
      const records = await authoritativeRecords(
        sessionQuery,
        candidates.map(({ sessionId }) => sessionId),
        exec.signal,
      );
      const authorized = new Set(authorizedWorkspaceIds);
      candidates = candidates.flatMap((candidate) => {
        const record = records.get(candidate.sessionId);
        if (!record || !authorized.has(record.header.cwd)) return [];
        if (plan.sessionScope === "current" && candidate.sessionId !== plan.callerId) return [];
        if (plan.sessionScope === "other" && candidate.sessionId === plan.callerId) return [];
        return [{ ...candidate, record }];
      });
      metadataAuthorization += elapsedMilliseconds(metadataStartedAt);
      exec.signal?.throwIfAborted?.();

      const truncated = candidateSetTruncated(response);
      final = {
        response,
        depth,
        candidates,
        truncated,
        diagnostics: {
          strategyVersion: SEARCH_STRATEGY_VERSION,
          continuation: false,
          rungsExecuted: rungIndex + 1,
          rungDepth: depth,
          finalLimit: request.finalLimit,
          maxCandidates,
          exactObservationMode: typeof sessionQuery.readEventDocumentSnapshots === "function"
            ? "batch"
            : "fallback",
          counts: searchCounts(response, verifiedCount, candidates.length),
          timingsMs: { daemonSearch, exactVerification, metadataAuthorization },
        },
      };
      if (candidates.length >= plan.limit || !truncated) break;
    }
    if (!final) throw new Error("session_history search depth ladder produced no rung");
    const frozen = {
      candidateSetTruncated: final.truncated,
      candidates: final.candidates,
      depth: final.depth,
      diagnostics: final.diagnostics,
    };
    return fusedPage(plan, fingerprint, frozen, 0, totalStartedAt, final.diagnostics);
  }

  async function context(input, exec = {}) {
    assertLive();
    const args = requireObject(input, "session_history context input");
    rejectUnknown(args, CONTEXT_KEYS, "context");
    const sessionId = String(args.sessionId ?? "");
    if (!SESSION_ID.test(sessionId)) {
      throw new TypeError("session_history context requires a valid session id");
    }
    const seq = args.seq;
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new TypeError("session_history context seq must be a non-negative safe integer");
    }
    const before = windowSize("before", args.before);
    const after = windowSize("after", args.after);
    if (typeof sessionQuery.readEvent !== "function") {
      throw new Error("session_history context requires bounded detached event reads");
    }

    const rawBefore = before > 0 ? CONTEXT_RAW_EVENT_BOUND : 0;
    const rawAfter = after > 0 ? CONTEXT_RAW_EVENT_BOUND : 0;
    // This is intentionally the only upstream content read. The raw result is
    // fixed-bounded before any conversational filtering or message-count slice.
    const observation = await sessionQuery.readEvent({
      sessionId,
      seq,
      before: rawBefore,
      after: rawAfter,
    }, exec.signal);
    exec.signal?.throwIfAborted?.();
    const targetEvent = observation?.target;
    const targetText = conversationText(targetEvent);
    if (targetEvent?.seq !== seq || !CONVERSATION_TYPES.includes(targetEvent?.type) || !targetText) {
      throw new Error(`session_history target ${sessionId}#${seq} is not a conversational message`);
    }

    const projected = (observation?.events ?? [])
      .map((event) => {
        const text = conversationText(event);
        if (!CONVERSATION_TYPES.includes(event?.type) || !text) return undefined;
        return { seq: event.seq, time: event.time, type: event.type, text };
      })
      .filter(Boolean)
      .sort((left, right) => left.seq - right.seq);
    const target = projected.find((document) => document.seq === seq);
    if (!target) {
      throw new Error(`session_history target ${sessionId}#${seq} is not a conversational message`);
    }
    const beforeCandidates = projected.filter((document) => document.seq < seq);
    const afterCandidates = projected.filter((document) => document.seq > seq);
    const selectedBefore = before === 0 ? [] : beforeCandidates.slice(-before);
    const selectedAfter = after === 0 ? [] : afterCandidates.slice(0, after);
    const selected = [...selectedBefore, target, ...selectedAfter];

    const targetCompact = compactText(target.text, MAX_CONTEXT_MESSAGE_CHARS);
    let remainingText = Math.max(0, MAX_CONTEXT_TEXT_CHARS - targetCompact.text.length);
    const neighbors = selected.filter((document) => document.seq !== seq);
    const allocations = new Map([[seq, targetCompact]]);
    const byDistance = [...neighbors].sort((left, right) => (
      Math.abs(left.seq - seq) - Math.abs(right.seq - seq) || left.seq - right.seq
    ));
    for (let index = 0; index < byDistance.length; index += 1) {
      const messagesLeft = byDistance.length - index;
      const fairCap = Math.max(1, Math.min(
        MAX_CONTEXT_MESSAGE_CHARS,
        Math.floor(remainingText / messagesLeft),
      ));
      const compact = compactText(byDistance[index].text, fairCap);
      allocations.set(byDistance[index].seq, compact);
      remainingText = Math.max(0, remainingText - compact.text.length);
    }
    const messages = selected.map((document) => {
      const compact = allocations.get(document.seq)
        ?? compactText(document.text, MAX_CONTEXT_MESSAGE_CHARS);
      return {
        seq: document.seq,
        time: isoTime(document.time),
        role: roleOf(document.type),
        text: compact.text,
        ...(compact.truncated ? { truncated: true } : {}),
        ...(document.seq === seq ? { target: true } : {}),
      };
    });

    const rawBeforeCount = seq - (observation?.startSeq ?? seq);
    const rawAfterCount = (observation?.endSeq ?? seq) - seq;
    const boundaries = {
      before: contextBoundary(before, selectedBefore.length, rawBeforeCount, rawBefore, "session-start"),
      after: contextBoundary(after, selectedAfter.length, rawAfterCount, rawAfter, "session-end"),
    };
    const rawBoundLimited = boundaries.before.reason === "raw-event-bound"
      || boundaries.after.reason === "raw-event-bound";
    const result = {
      action: "context",
      sessionId,
      targetSeq: seq,
      requested: { before, after },
      rawEventBound: { before: rawBefore, after: rawAfter },
      boundaries,
      messages,
      truncated: rawBoundLimited || messages.some((message) => message.truncated === true),
    };
    enforceContextCeiling(result, seq, messages);
    result.truncated = result.truncated || messages.some((message) => message.truncated === true);
    return result;
  }

  async function execute(input, exec = {}) {
    const args = requireObject(input, "session_history input");
    if (args.action === "search") return search(args, exec);
    if (args.action === "context") return context(args, exec);
    throw new TypeError('session_history action must be "search" or "context"');
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    fusedCursors.clear();
  }

  return Object.freeze({ search, context, execute, dispose });
}

function directText(message) {
  if (message?.source?.kind !== "user" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function containsGesture(message) {
  return GESTURE.test(directText(message));
}

function serviceOf(ctx, name) {
  try { return ctx?.get?.(name, false) ?? ctx?.[name] ?? null; } catch { return null; }
}

function toolsOf(agent) {
  return agent?.ctx?.tools ?? serviceOf(agent?.ctx, "tools");
}

function schemaOf(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
  };
}

function renderResult(_args, value) {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

function toolDefinition(invoke) {
  return {
    name: SESSION_HISTORY_TOOL,
    description: "Find prior user/assistant conversation with one or more literal queries, then inspect one bounded role-labeled message neighborhood. Tool activity, reasoning, and attachments are unavailable. This read-only tool exists only for the operator-authorized find-session turn.",
    parameters: {
      action: {
        type: "string",
        enum: ["search", "context"],
        required: true,
        description: "search for candidate sessions, or context to verify one matching conversation message.",
      },
      queries: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: MAX_SEARCH_QUERIES,
        description: "For search: required literal DSH words/phrases. One exact search is an array of one.",
      },
      after: {
        oneOf: [
          { type: "string", description: "For search: inclusive event-time lower bound in ISO-8601 form." },
          { type: "integer", description: `For context: following conversational messages, 0-${MAX_CONTEXT_WINDOW}.` },
        ],
      },
      before: {
        oneOf: [
          { type: "string", description: "For search: inclusive event-time upper bound in ISO-8601 form." },
          { type: "integer", description: `For context: preceding conversational messages, 0-${MAX_CONTEXT_WINDOW}.` },
        ],
      },
      workspace: {
        type: "string",
        enum: ["current", "all"],
        description: "For search: current workspace by default, or all workspaces.",
      },
      sessionScope: {
        type: "string",
        enum: ["other", "all", "current"],
        description: "For search: other sessions by default, all sessions, or only the caller session.",
      },
      limit: {
        type: "integer",
        description: `For search: page size, 1-${MAX_SEARCH_LIMIT}.`,
      },
      cursor: {
        type: "string",
        description: "For search: opaque nextCursor from the identical prior search in this turn.",
      },
      sessionId: {
        type: "string",
        description: "For context: stable session id from a search result.",
      },
      seq: {
        type: "integer",
        description: "For context: matching conversation-message sequence number.",
      },
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: renderResult,
    },
    async execute(args, exec) {
      return invoke(args, exec);
    },
    presentCall(args) {
      return {
        card: "generic",
        title: args.action === "context" ? "Inspect session-history context" : "Search session history",
        kind: "read",
        rawInput: args.action === "context"
          ? `${args.sessionId ?? ""}#${args.seq ?? ""}`
          : (Array.isArray(args.queries) ? args.queries.join(" | ") : ""),
      };
    },
  };
}

function skillDefinition() {
  return {
    name: FIND_SESSION_SKILL,
    description: "Find and verify a prior DSH session from clues about its user/assistant conversation or time.",
    content: FIND_SESSION_INSTRUCTIONS,
    source: "runtime",
    provider: "qq-core",
    invocation: { modelInvocable: false, userInvocable: true },
  };
}

/**
 * Register the user-only skill and the turn-scoped model tool policy. QQ's
 * direct-user admission callback is provenance; the inbox claim is timing; the
 * pre-step batch is final confirmation. All three must agree.
 */
export function attachSessionHistory(ctx, { qq } = {}) {
  const skills = serviceOf(ctx, "skills");
  if (!skills || typeof skills.register !== "function") return () => {};
  const off = [];
  const admissions = new WeakMap();
  const claims = new WeakMap();
  const active = new Map();
  let disposed = false;

  function admissionMap(agent, create = false) {
    let map = admissions.get(agent);
    if (!map && create) {
      map = new Map();
      admissions.set(agent, map);
    }
    return map;
  }

  function onDirectUserMessage(event = {}) {
    const agent = event.agent;
    const message = event.message;
    if (!agent || typeof message?.id !== "string") return;
    const map = admissionMap(agent, event.kind !== "removed");
    if (!map) return;
    if (event.kind === "removed" || event.kind === "revoked") {
      map.delete(message.id);
      return;
    }
    const text = directText(message);
    if (!text) {
      map.delete(message.id);
      return;
    }
    const prior = map.get(message.id);
    const time = Number.isFinite(event.time) ? event.time : prior?.time;
    map.set(message.id, { id: message.id, text, ...(time === undefined ? {} : { time }) });
  }

  function revoke(agent, expected) {
    const state = active.get(agent);
    if (!state || (expected && state !== expected)) return;
    active.delete(agent);
    state.revoked = true;
    try { state.adapter?.dispose?.(); } catch {}
    try { state.disposeTool?.(); } catch {}
  }

  function revokeClaimAndActive(agent) {
    claims.delete(agent);
    revoke(agent);
  }

  function revokeSession(session) {
    const agent = serviceOf(ctx, "agents")?.get?.(session?.id);
    if (agent) claims.delete(agent);
    for (const [candidate] of active) {
      if (candidate?.session === session || candidate?.session?.id === session?.id) revoke(candidate);
    }
  }

  function claimedMessages(session, event) {
    const data = event?.data;
    if (event?.type !== "agent/inbox/spliced" || !Number.isSafeInteger(data?.removedCount) || data.removedCount < 1) {
      return;
    }
    const agents = serviceOf(ctx, "agents");
    const agent = agents?.get?.(session?.id);
    if (!agent) return;
    const list = data.target === "next-turn" ? agent.inbox?.nextTurn : agent.inbox?.nextStep;
    if (!Array.isArray(list)) return;
    const removed = list.slice(data.start, data.start + data.removedCount);
    const admitted = admissionMap(agent);
    if (data.outcome === "canceled") {
      // Canceled removals never become a turn claim, but their authentic
      // admission provenance is still one-shot and must not be replayable.
      for (const message of removed) admitted?.delete(message?.id);
      return;
    }
    const trusted = [];
    for (const message of removed) {
      const record = admitted?.get(message?.id);
      if (!record) continue;
      admitted.delete(message.id);
      const text = directText(message);
      if (text === record.text && containsGesture(message)) trusted.push({ id: message.id, text, time: record.time });
    }

    const prior = claims.get(agent);
    const adjacentNextTurnCompanion = prior
      && prior.sourceTarget === "next-step"
      && data.target === "next-turn"
      && Number.isSafeInteger(prior.lastSeq)
      && event.seq === prior.lastSeq + 1;
    if (trusted.length > 0) {
      const messages = adjacentNextTurnCompanion ? [...prior.messages, ...trusted] : trusted;
      const times = messages.map(({ time }) => time).filter(Number.isFinite);
      claims.set(agent, {
        messages,
        sourceTarget: data.target,
        lastSeq: event.seq,
        ...(times.length ? { asOf: Math.min(...times) } : {}),
      });
    } else if (!adjacentNextTurnCompanion) {
      claims.delete(agent);
    }
  }

  function confirmedBy(event, state) {
    return state.claim.messages.some((record) => (event?.messages ?? []).some((message) => (
      message?.id === record.id
      && directText(message) === record.text
      && containsGesture(message)
    )));
  }

  async function executeAuthorized(state, args, exec = {}) {
    if (disposed || state.revoked || !state.confirmed || active.get(exec.agent) !== state || exec.agent !== state.agent) {
      throw new Error(GRANT_ERROR);
    }
    exec.signal?.throwIfAborted?.();
    if (!state.adapter) {
      const sessionQuery = requireQueryService(serviceOf(ctx, "sessionQuery"));
      const qqSessionIndex = serviceOf(ctx, "qq-session-index");
      state.adapter = createSessionHistoryAdapter(sessionQuery, qqSessionIndex, {
        aliasFor: (id) => qq?.alias?.(id) ?? "",
        listAuthorizedWorkspaceIds: qq?.listAuthorizedWorkspaceIds,
      });
    }
    return state.adapter.execute(args, { ...exec, asOf: state.claim.asOf });
  }

  async function onAssemble(_assembly, context, next) {
    const agent = context?.agent ?? context?.scope;
    const claim = agent && claims.get(agent);
    if (!claim || disposed) return next();
    claims.delete(agent);
    revoke(agent);
    const tools = toolsOf(agent);
    if (!tools || typeof tools.register !== "function") return next();
    const state = {
      agent,
      claim,
      confirmed: false,
      revoked: false,
      turn: undefined,
      disposeTool: undefined,
      adapter: undefined,
    };
    const definition = toolDefinition((args, exec) => executeAuthorized(state, args, exec));
    try {
      state.disposeTool = tools.register(definition);
      active.set(agent, state);
      const result = await next();
      if (context?.signal?.aborted || state.revoked || active.get(agent) !== state) {
        revoke(agent, state);
        return result;
      }
      const schemas = Array.isArray(result?.tools) ? result.tools : [];
      if (schemas.some((schema) => schema?.name === SESSION_HISTORY_TOOL)) return result;
      return { ...result, tools: [...schemas, schemaOf(definition)] };
    } catch (error) {
      revoke(agent, state);
      throw error;
    }
  }

  async function onPreStep(event, next) {
    const agent = event?.agent ?? event?.scope;
    const state = active.get(agent);
    if (!state || state.revoked) return next();
    if (!state.confirmed) {
      if (!confirmedBy(event, state)) {
        revoke(agent, state);
        return next();
      }
      state.confirmed = true;
      state.turn = event.turn;
    }
    try {
      const decision = await next();
      if (!decision || decision.kind === "reject" || event?.signal?.aborted) revoke(agent, state);
      return decision;
    } catch (error) {
      revoke(agent, state);
      throw error;
    }
  }

  const disposeSkill = skills.register(skillDefinition());
  off.push(typeof disposeSkill === "function" ? disposeSkill : () => {});
  if (typeof qq?.onDirectUserMessage === "function") {
    off.push(qq.onDirectUserMessage(onDirectUserMessage));
  }
  if (typeof ctx?.on === "function") {
    off.push(ctx.on("session/event", (session, event) => {
      claimedMessages(session, event);
      if (event?.type === "turn/end") revokeSession(session);
    }));
    off.push(ctx.on("system-prompt/assemble", onAssemble));
    off.push(ctx.on("agent/pre-step", onPreStep));
    off.push(ctx.on("agent/error", ({ agent } = {}) => revokeClaimAndActive(agent)));
    off.push(ctx.on("agent/status", ({ agent, status } = {}) => {
      if (status === "idle") revokeClaimAndActive(agent);
    }));
    off.push(ctx.on("agent/disposed", ({ agent } = {}) => {
      revoke(agent);
      admissions.delete(agent);
      claims.delete(agent);
    }));
  }

  let finished = false;
  const dispose = () => {
    if (finished) return;
    finished = true;
    disposed = true;
    for (const agent of [...active.keys()]) revoke(agent);
    for (const release of off.reverse()) {
      try { release?.(); } catch {}
    }
    off.length = 0;
  };
  if (typeof ctx?.effect === "function") {
    ctx.effect(() => dispose, "qq: scoped session history");
  }
  return dispose;
}

export const internals = Object.freeze({
  CONVERSATION_TYPES,
  CONVERSATION_SURFACES,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_QUERIES,
  MULTI_QUERY_SOURCE_DEPTH,
  RRF_K,
  MAX_AUTHORIZED_WORKSPACES,
  MAX_VERIFICATION_POINTERS,
  MAX_VERIFICATION_CONCURRENCY,
  SEARCH_STRATEGY_VERSION,
  MAX_SNIPPET_CHARS,
  MAX_SNIPPET_BYTES,
  MAX_TITLE_CHARS,
  MAX_TITLE_BYTES,
  DEFAULT_CONTEXT_WINDOW,
  MAX_CONTEXT_WINDOW,
  CONTEXT_RAW_EVENT_BOUND,
  MAX_CONTEXT_MESSAGE_CHARS,
  MAX_CONTEXT_TEXT_CHARS,
  MAX_CONTEXT_OUTPUT_BYTES,
  // Compatibility for tests/consumers of the initial implementation; the
  // ceiling is now measured in bytes despite the legacy property name.
  MAX_CONTEXT_OUTPUT_CHARS: MAX_CONTEXT_OUTPUT_BYTES,
  GESTURE,
  GRANT_ERROR,
  conversationText,
  containsGesture,
  directText,
  normalizeQueries,
  reciprocalRankFuse,
  toolDefinition,
});
