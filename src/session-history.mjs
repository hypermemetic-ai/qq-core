export const FIND_SESSION_SKILL = "find-session";
export const SESSION_HISTORY_TOOL = "session_history";

const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONVERSATION_TYPES = Object.freeze(["user/message", "assistant/message"]);
// Include replaced/compacted conversation so historical clues remain findable;
// raw-log-only events are never part of QQ's conversation-discovery surface.
const CONVERSATION_SURFACES = Object.freeze(["current", "shadowed"]);
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;
const DEFAULT_CONTEXT_WINDOW = 3;
const MAX_CONTEXT_WINDOW = 12;
const MAX_CONTEXT_MESSAGE_CHARS = 900;
const MAX_CONTEXT_TEXT_CHARS = 11_000;
const MAX_CONTEXT_OUTPUT_CHARS = 16_384;
const MAX_QUERY_CHARS = 500;
const MAX_SNIPPET_CHARS = 320;
const GRANT_ERROR = "session_history is not authorized for this agent turn";
const GESTURE = /(^|\s)\/find-session(?=\s|$)/u;

export const FIND_SESSION_INSTRUCTIONS = [
  "Find prior DSH sessions without resuming or changing them.",
  "Use `session_history` with action `search` first. Search is lexical: try multiple distinctive literal words or exact phrases rather than a broad description. Narrow with event time and current/all-workspace filters when useful.",
  "Search covers user/assistant conversation only. Tool calls, tool results, todos, errors, reasoning, and attachments are not available through this tool.",
  "Inspect promising matches with action `context` and a small before/after conversational-message count. The target is always focused; context is bounded and never a raw transcript.",
  "Report the stable `sessionId` and concise evidence (matching seq/time/role and nearby text). Copy that `sessionId` directly into context. Treat transcripts as authoritative and read-only.",
].join("\n");

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function literalQuery(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("session_history search requires a non-empty literal query");
  }
  const query = value.replaceAll(/\s+/g, " ").trim();
  if (query.length > MAX_QUERY_CHARS) {
    throw new TypeError(`session_history literal query exceeds ${MAX_QUERY_CHARS} characters`);
  }
  return query;
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

function rejectGenericControls(args) {
  for (const name of ["eventTypes", "event_types", "surface", "surfaces", "detail"]) {
    if (Object.hasOwn(args, name)) {
      throw new TypeError(`session_history ${name} is not available: QQ searches conversation messages only`);
    }
  }
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
  const marker = " [truncated]";
  if (maxChars <= marker.length) {
    return { text: text.slice(0, Math.max(0, maxChars)), truncated: true };
  }
  return {
    text: `${text.slice(0, maxChars - marker.length).trimEnd()}${marker}`,
    truncated: true,
  };
}

function enforceContextCeiling(result, targetSeq, messages) {
  let overflow = JSON.stringify(result, null, 2).length - MAX_CONTEXT_OUTPUT_CHARS;
  if (overflow <= 0) return;
  const candidates = [...messages]
    .sort((left, right) => (
      (left.seq === targetSeq ? 1 : 0) - (right.seq === targetSeq ? 1 : 0)
      || Math.abs(right.seq - targetSeq) - Math.abs(left.seq - targetSeq)
    ));
  for (const event of candidates) {
    if (overflow <= 0) break;
    const reducible = Math.max(0, event.text.length - 1);
    if (reducible === 0) continue;
    const reduceBy = Math.min(reducible, overflow + 15);
    const compact = compactText(event.text, Math.max(1, event.text.length - reduceBy));
    event.text = compact.text;
    event.truncated = true;
    overflow = JSON.stringify(result, null, 2).length - MAX_CONTEXT_OUTPUT_CHARS;
  }
  result.truncated = true;
  if (JSON.stringify(result, null, 2).length > MAX_CONTEXT_OUTPUT_CHARS) {
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

function normalizedLiteral(value) {
  return String(value ?? "").replaceAll(/\s+/g, " ").trim().toLocaleLowerCase();
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
    surface: record.surface,
    text,
  };
}

async function strictSearchMatch(sessionQuery, hit, query, signal) {
  const sessionId = headerId(hit);
  const best = await readConversationDocument(sessionQuery, sessionId, hit.bestMatch, signal);
  if (best && containsLiteral(best.text, query)) return best;
  if (typeof sessionQuery.filterEvents !== "function") {
    throw new Error("session_history requires semantic filtering to enforce conversation-only search");
  }
  const candidates = await sessionQuery.filterEvents(sessionId, [
    { kind: "type", values: CONVERSATION_TYPES },
    { kind: "surface", values: CONVERSATION_SURFACES },
    { kind: "text", text: query },
  ]);
  for (const candidate of candidates ?? []) {
    if (candidate?.seq === hit.bestMatch?.seq) continue;
    const document = await readConversationDocument(sessionQuery, sessionId, candidate, signal);
    if (document && containsLiteral(document.text, query)) return document;
  }
  return undefined;
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

/**
 * Thin, read-only presentation adapter over DSH's public session-query service.
 * It owns no transcript state and never imports a DSH persistence or query
 * implementation.
 */
export function createSessionHistoryAdapter(sessionQuery, options = {}) {
  requireQueryService(sessionQuery);
  const aliasFor = typeof options.aliasFor === "function" ? options.aliasFor : () => "";

  async function search(input, exec = {}) {
    const args = requireObject(input, "session_history search input");
    const query = literalQuery(args.query);
    const limit = pageLimit(args.limit);
    const after = timestamp("after", args.after);
    const before = timestamp("before", args.before);
    if (after !== undefined && before !== undefined && after > before) {
      throw new TypeError("session_history after must not be later than before");
    }
    rejectGenericControls(args);
    const workspace = args.workspace ?? "current";
    if (workspace !== "current" && workspace !== "all") {
      throw new TypeError('session_history workspace must be "current" or "all"');
    }
    const cwd = exec.agent?.session?.header?.cwd;
    if (workspace === "current" && (typeof cwd !== "string" || !cwd)) {
      throw new Error("session_history cannot determine the calling workspace");
    }
    if (args.cursor !== undefined && (typeof args.cursor !== "string" || !args.cursor)) {
      throw new TypeError("session_history cursor must be a non-empty opaque string");
    }

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
    const request = {
      query,
      ...(workspace === "current" ? { sessionFilters: [{ kind: "cwd", values: [cwd] }] } : {}),
      ...(eventFilters.length === 0 ? {} : { eventFilters }),
      limit,
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
    };
    if (typeof sessionQuery.searchSessions !== "function") {
      throw new Error("session_history search is unavailable: full-text session search is not mounted");
    }
    const page = await sessionQuery.searchSessions(request, { signal: exec.signal });
    exec.signal?.throwIfAborted?.();
    const callerId = exec.agent?.session?.id;
    const verified = [];
    for (const hit of page?.items ?? []) {
      if (headerId(hit) === callerId) continue;
      const match = await strictSearchMatch(sessionQuery, hit, query, exec.signal);
      if (match) verified.push({ hit, match });
    }
    const titles = await titlesFor(
      sessionQuery,
      verified.map(({ hit }) => headerId(hit)).filter(Boolean),
      exec.signal,
    );
    const results = verified.map(({ hit, match }) => {
      const id = headerId(hit);
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
        match: {
          seq: match.seq,
          time: isoTime(match.time),
          role: roleOf(match.type),
          snippet: matchingSnippet(match.text, query),
        },
      };
    });
    return {
      action: "search",
      query,
      workspace,
      results,
      ...(page?.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  async function context(input, exec = {}) {
    const args = requireObject(input, "session_history context input");
    rejectGenericControls(args);
    const sessionId = args.sessionId ?? args.session_id;
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
      throw new TypeError("session_history context requires a valid sessionId");
    }
    const seq = args.seq;
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new TypeError("session_history seq must be a non-negative safe integer");
    }
    const before = windowSize("before", args.before);
    const after = windowSize("after", args.after);
    if (typeof sessionQuery.filterEvents !== "function") {
      throw new Error("session_history context is unavailable: semantic event filtering is not mounted");
    }

    const conversationFilters = [
      { kind: "type", values: CONVERSATION_TYPES },
      { kind: "surface", values: CONVERSATION_SURFACES },
    ];
    // The target is selected independently, but through the same forced
    // conversation predicates. A caller cannot use a tool/todo/error seq to
    // escape this product boundary.
    const targetDocuments = await sessionQuery.filterEvents(sessionId, [
      { kind: "seq", from: seq, to: seq },
      ...conversationFilters,
    ]);
    exec.signal?.throwIfAborted?.();
    const targetRecord = (targetDocuments ?? []).find((document) => document?.seq === seq);
    const target = targetRecord
      ? await readConversationDocument(sessionQuery, sessionId, targetRecord, exec.signal)
      : undefined;
    if (!target) {
      throw new Error(`session_history target ${sessionId}#${seq} is not a conversational message`);
    }

    const candidateRecords = before === 0 && after === 0
      ? []
      : await sessionQuery.filterEvents(sessionId, conversationFilters);
    exec.signal?.throwIfAborted?.();
    const projected = [];
    for (const record of candidateRecords ?? []) {
      if (!record || !Number.isSafeInteger(record.seq) || record.seq === seq) continue;
      const document = await readConversationDocument(sessionQuery, sessionId, record, exec.signal);
      if (document) projected.push(document);
    }
    const ordered = projected.sort((left, right) => left.seq - right.seq);
    const beforeCandidates = ordered.filter((document) => document.seq < seq);
    const afterCandidates = ordered.filter((document) => document.seq > seq);
    const selectedBefore = before === 0 ? [] : beforeCandidates.slice(-before);
    const selectedAfter = after === 0 ? [] : afterCandidates.slice(0, after);
    const selected = [...selectedBefore, target, ...selectedAfter];

    // Fixed caps only: callers choose message counts, never a byte/detail budget.
    // Reserve the target's full message allowance, then share the aggregate
    // budget fairly among nearest neighboring conversation messages.
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
    const result = {
      action: "context",
      sessionId,
      targetSeq: seq,
      requested: { before, after },
      omitted: {
        before: before > 0 && beforeCandidates.length > selectedBefore.length,
        after: after > 0 && afterCandidates.length > selectedAfter.length,
      },
      messages,
      truncated: false,
    };
    result.truncated = result.omitted.before
      || result.omitted.after
      || messages.some((message) => message.truncated === true);
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

  return Object.freeze({ search, context, execute });
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
    description: "Find prior user/assistant conversation by literal text, then inspect a bounded role-labeled message window. Tool activity, reasoning, and attachments are unavailable. This read-only tool exists only for the operator-authorized find-session turn.",
    parameters: {
      action: {
        type: "string",
        enum: ["search", "context"],
        required: true,
        description: "search for candidate sessions, or context to verify one matching conversation message.",
      },
      query: {
        type: "string",
        description: "For search: required distinctive literal words or phrase (not FTS syntax).",
      },
      after: {
        oneOf: [
          { type: "string", description: "For search: inclusive event-time lower bound in ISO-8601 form." },
          { type: "integer", description: `For context: following event window, 0-${MAX_CONTEXT_WINDOW}.` },
        ],
      },
      before: {
        oneOf: [
          { type: "string", description: "For search: inclusive event-time upper bound in ISO-8601 form." },
          { type: "integer", description: `For context: preceding event window, 0-${MAX_CONTEXT_WINDOW}.` },
        ],
      },
      workspace: {
        type: "string",
        enum: ["current", "all"],
        description: "For search: current workspace by default, or all workspaces.",
      },
      limit: {
        type: "integer",
        description: `For search: page size, 1-${MAX_SEARCH_LIMIT}.`,
      },
      cursor: {
        type: "string",
        description: "For search: opaque nextCursor from the identical prior search.",
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
        rawInput: args.action === "context" ? `${args.sessionId ?? ""}#${args.seq ?? ""}` : String(args.query ?? ""),
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
    map.set(message.id, { id: message.id, text });
  }

  function revoke(agent, expected) {
    const state = active.get(agent);
    if (!state || (expected && state !== expected)) return;
    active.delete(agent);
    state.revoked = true;
    try { state.disposeTool?.(); } catch {}
  }

  function revokeSession(session) {
    for (const [agent] of active) {
      if (agent?.session === session || agent?.session?.id === session?.id) revoke(agent);
    }
  }

  function claimedMessages(session, event) {
    const data = event?.data;
    if (event?.type !== "agent/inbox/spliced" || !Number.isSafeInteger(data?.removedCount) || data.removedCount < 1) {
      return;
    }
    if (data.outcome === "canceled") return;
    const agents = serviceOf(ctx, "agents");
    const agent = agents?.get?.(session?.id);
    if (!agent) return;
    const list = data.target === "next-turn" ? agent.inbox?.nextTurn : agent.inbox?.nextStep;
    if (!Array.isArray(list)) return;
    const removed = list.slice(data.start, data.start + data.removedCount);
    const admitted = admissionMap(agent);
    const trusted = [];
    for (const message of removed) {
      const record = admitted?.get(message?.id);
      if (!record) continue;
      admitted.delete(message.id);
      const text = directText(message);
      if (text === record.text && containsGesture(message)) trusted.push({ id: message.id, text });
    }
    if (trusted.length > 0) claims.set(agent, { messages: trusted });
    else claims.delete(agent);
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
    const sessionQuery = requireQueryService(serviceOf(ctx, "sessionQuery"));
    const adapter = createSessionHistoryAdapter(sessionQuery, {
      aliasFor: (id) => qq?.alias?.(id) ?? "",
    });
    return adapter.execute(args, exec);
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
  DEFAULT_CONTEXT_WINDOW,
  MAX_CONTEXT_WINDOW,
  MAX_CONTEXT_MESSAGE_CHARS,
  MAX_CONTEXT_TEXT_CHARS,
  MAX_CONTEXT_OUTPUT_CHARS,
  GESTURE,
  GRANT_ERROR,
  conversationText,
  containsLiteral,
  containsGesture,
  directText,
  toolDefinition,
});
