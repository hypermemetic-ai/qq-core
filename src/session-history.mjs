import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

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

function containsLiteral(text, query) {
  return normalizedLiteral(text).includes(normalizedLiteral(query));
}

function matchingSnippet(text, query) {
  const normalized = String(text ?? "").replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= MAX_SNIPPET_CHARS) return normalized;
  const at = normalized.toLocaleLowerCase().indexOf(normalizedLiteral(query));
  const start = Math.max(0, (at < 0 ? 0 : at) - 80);
  const end = Math.min(normalized.length, start + MAX_SNIPPET_CHARS - 2);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`
    .slice(0, MAX_SNIPPET_CHARS);
}

async function readConversationDocument(sessionQuery, sessionId, record, signal) {
  if (!CONVERSATION_TYPES.includes(record?.type)
      || !CONVERSATION_SURFACES.includes(record?.surface)
      || !Number.isSafeInteger(record?.seq)) return undefined;
  if (typeof sessionQuery.readEvent !== "function") {
    throw new Error("session_history requires detached event reads to enforce conversation-only results");
  }
  const observation = await sessionQuery.readEvent({
    sessionId,
    seq: record.seq,
    before: 0,
    after: 0,
  }, signal);
  signal?.throwIfAborted?.();
  const event = observation?.target;
  if (event?.seq !== record.seq || event?.type !== record.type) return undefined;
  const text = conversationText(event);
  if (!text) return undefined;
  return {
    sessionId,
    seq: event.seq,
    time: event.time,
    type: event.type,
    text,
  };
}

function titleText(result) {
  if (result?.status !== "fulfilled") return "";
  const title = result.value?.title;
  if (typeof title === "string") return title.trim();
  return typeof title?.title === "string" ? title.title.trim() : "";
}

async function titlesFor(sessionQuery, ids, signal) {
  if (ids.length === 0 || typeof sessionQuery.readTitleSnapshots !== "function") return new Map();
  try {
    const settlements = await sessionQuery.readTitleSnapshots(ids, signal);
    const titles = new Map();
    for (const settlement of settlements ?? []) {
      const title = titleText(settlement);
      if (title) titles.set(settlement.sessionId, title);
    }
    return titles;
  } catch (error) {
    if (signal?.aborted) throw error;
    return new Map();
  }
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

function sourceRequest(plan, query, limit, cursor) {
  return {
    query,
    ...(plan.sessionFilters.length ? { sessionFilters: plan.sessionFilters } : {}),
    eventFilters: plan.eventFilters,
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  };
}

async function fetchScopedSource(sessionQuery, plan, query, limit, cursor, signal) {
  const first = await sessionQuery.searchSessions(sourceRequest(plan, query, limit, cursor), { signal });
  signal?.throwIfAborted?.();
  let nextCursor = first?.nextCursor;
  let hits = [...(first?.items ?? [])];
  let removedCaller = false;
  if (plan.sessionScope === "other") {
    removedCaller = hits.some((hit) => headerId(hit) === plan.callerId);
    hits = hits.filter((hit) => headerId(hit) !== plan.callerId);
  }

  // A grouped source can contain the caller only once. Consume exactly one
  // additional upstream item when necessary, preserving order and not skipping
  // any eligible result behind an excluded caller.
  if (removedCaller && hits.length < limit && nextCursor) {
    const needed = limit - hits.length;
    const continuation = await sessionQuery.searchSessions(
      sourceRequest(plan, query, needed, nextCursor),
      { signal },
    );
    signal?.throwIfAborted?.();
    hits.push(...(continuation?.items ?? []).filter((hit) => headerId(hit) !== plan.callerId));
    nextCursor = continuation?.nextCursor;
  }

  return {
    ranked: hits.slice(0, limit).map((hit, index) => ({ hit, sourceRank: index + 1, query })),
    nextCursor,
  };
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
    asOf: plan.asOf ?? null,
    limit: plan.limit,
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
 * Thin, read-only presentation adapter over DSH's public session-query service.
 * It owns only disposable fused-page cursor state, never transcript data.
 */
export function createSessionHistoryAdapter(sessionQuery, options = {}) {
  requireQueryService(sessionQuery);
  const aliasFor = typeof options.aliasFor === "function" ? options.aliasFor : () => "";
  const fusedCursors = new Map();
  let disposed = false;

  function assertLive() {
    if (disposed) throw new Error("session_history adapter is disposed");
  }

  function formatCandidate(candidate, titles) {
    const hit = candidate.hit;
    const id = candidate.sessionId;
    let alias = "";
    if (hit.live === true) {
      try { alias = String(aliasFor(id) ?? "").trim(); } catch { alias = ""; }
    }
    const title = titles.get(id) ?? "";
    return {
      sessionId: id,
      ...(alias ? { alias } : {}),
      ...(title ? { title } : {}),
      createdAt: isoTime(hit.header?.createdAt),
      cwd: hit.header?.cwd ?? null,
      live: hit.live === true,
      persisted: hit.persisted === true,
      score: candidate.score,
      matchedQueryCount: candidate.evidence.length,
      evidence: [...candidate.evidence]
        .sort((left, right) => left.queryIndex - right.queryIndex)
        .map(({ queryIndex, sourceRank, document, query }) => ({
          queryIndex,
          sourceRank,
          seq: document.seq,
          time: isoTime(document.time),
          role: roleOf(document.type),
          snippet: matchingSnippet(document.text, query),
        })),
    };
  }

  function lightweightSources(sourcePages, queries) {
    return sourcePages.map((page, queryIndex) => page.ranked.map((entry) => ({
      ...entry,
      query: queries[queryIndex],
      record: entry.hit?.bestMatch,
      document: {
        seq: entry.hit?.bestMatch?.seq,
        time: entry.hit?.bestMatch?.time,
        type: entry.hit?.bestMatch?.type,
        // This excerpt is retained only in the private, turn-scoped candidate
        // set. It is never returned without exact visible-text verification.
        text: String(entry.hit?.bestMatch?.snippet ?? ""),
      },
    })));
  }

  async function verifyCandidates(candidates, signal) {
    const verified = await Promise.all(candidates.map(async (candidate) => {
      const evidence = await Promise.all(candidate.evidence.map(async (item) => {
        const document = await readConversationDocument(
          sessionQuery,
          candidate.sessionId,
          item.record,
          signal,
        );
        if (!document || !containsLiteral(document.text, item.query)) return undefined;
        return { ...item, document };
      }));
      // Never expose a partial score whose lightweight ordering included hidden
      // assistant blocks. Keeping only fully verified candidates preserves the
      // frozen global RRF order and every contribution reported in `score`.
      if (evidence.some((item) => item === undefined)) return undefined;
      return { ...candidate, evidence };
    }));
    signal?.throwIfAborted?.();
    return verified.filter(Boolean);
  }

  async function fusedPage(plan, fingerprint, frozen, offset, signal) {
    const selected = frozen.candidates.slice(offset, offset + plan.limit);
    const candidates = await verifyCandidates(selected, signal);
    // Title folding can inspect complete persisted logs. It is therefore
    // deliberately bounded to this already-fused output page, never the
    // up-to-500 lightweight candidate union.
    const titles = await titlesFor(sessionQuery, candidates.map(({ sessionId }) => sessionId), signal);
    const results = candidates.map((candidate) => formatCandidate(candidate, titles));
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
      results,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  async function search(input, exec = {}) {
    assertLive();
    const args = requireObject(input, "session_history search input");
    const plan = searchPlan(args, exec);
    if (typeof sessionQuery.searchSessions !== "function") {
      throw new Error("session_history search is unavailable: full-text session search is not mounted");
    }

    if (plan.queries.length === 1) {
      const source = await fetchScopedSource(
        sessionQuery,
        plan,
        plan.queries[0],
        plan.limit,
        plan.cursor,
        exec.signal,
      );
      const candidates = reciprocalRankFuse(lightweightSources([source], plan.queries));
      const verified = await verifyCandidates(candidates, exec.signal);
      const titles = await titlesFor(
        sessionQuery,
        verified.map(({ sessionId }) => sessionId),
        exec.signal,
      );
      return {
        action: "search",
        queries: plan.queries,
        workspace: plan.workspace,
        sessionScope: plan.sessionScope,
        results: verified.map((candidate) => formatCandidate(candidate, titles)),
        ...(source.nextCursor ? { nextCursor: source.nextCursor } : {}),
      };
    }

    const fingerprint = searchFingerprint(plan);
    if (plan.cursor) {
      const continuation = fusedCursors.get(plan.cursor);
      fusedCursors.delete(plan.cursor);
      if (!continuation || continuation.fingerprint !== fingerprint) {
        throw new TypeError("session_history cursor is invalid for this fused search request or grant");
      }
      return fusedPage(plan, fingerprint, continuation.frozen, continuation.offset, exec.signal);
    }

    // Exactly one bounded top-depth source call per normalized query, except
    // for the single-item continuation required when `other` excludes a caller
    // that occupied one of those slots. There are no retries or stream drains.
    const sourcePages = await Promise.all(plan.queries.map((query) => fetchScopedSource(
      sessionQuery,
      plan,
      query,
      MULTI_QUERY_SOURCE_DEPTH,
      undefined,
      exec.signal,
    )));
    exec.signal?.throwIfAborted?.();
    const frozen = {
      candidateSetTruncated: sourcePages.some(({ nextCursor }) => Boolean(nextCursor)),
      candidates: reciprocalRankFuse(lightweightSources(sourcePages, plan.queries)),
    };
    return fusedPage(plan, fingerprint, frozen, 0, exec.signal);
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
    provider: "qq",
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
      state.adapter = createSessionHistoryAdapter(sessionQuery, {
        aliasFor: (id) => qq?.alias?.(id) ?? "",
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
    off.push(ctx.on("agent/error", ({ agent } = {}) => revoke(agent)));
    off.push(ctx.on("agent/status", ({ agent, status } = {}) => {
      if (status === "idle") revoke(agent);
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
  containsLiteral,
  containsGesture,
  directText,
  normalizeQueries,
  reciprocalRankFuse,
  toolDefinition,
});
