#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createSessionHistoryAdapter, internals } from "../src/session-history.mjs";

const CALLER = "session-00000000-0000-4000-8000-000000000001";
const IDS = Array.from({ length: 12 }, (_, index) => (
  `session-00000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`
));
const BASE_TIME = Date.parse("2026-08-30T12:00:00.000Z");
assert.equal(internals.DEFAULT_SEARCH_TIMEOUT_MS, 15_000);

function event(seq, type, text, time = BASE_TIME + seq) {
  if (type === "user/message") {
    return { seq, type, time, data: { content: [{ type: "text", text }] } };
  }
  if (type === "assistant/message") {
    return { seq, type, time, data: { message: { content: [{ type: "text", text }] } } };
  }
  return { seq, type, time, data: { content: [{ type: "text", text }] } };
}

function fixtureCandidate({
  sessionId,
  workspace = "/work",
  live = false,
  persisted = true,
  createdAt = BASE_TIME - 1000,
  evidence,
  score = 0.05,
  title = "",
  logicalEventCount = 0,
}) {
  return {
    sessionId, workspace, live, persisted, createdAt, evidence, score, title, logicalEventCount,
  };
}

function makeHarness(candidates, options = {}) {
  let legacyCalls = 0;
  let searchCalls = 0;
  let verifyCalls = 0;
  let activeReads = 0;
  let peakReads = 0;
  const requests = [];
  const searchOptions = [];
  const verifyOptions = [];
  const tokenWorkspaces = [];
  const eventFilterCalls = [];
  const eventReadCalls = [];
  const events = new Map();
  const records = new Map();
  const titles = new Map();
  for (const candidate of candidates) {
    records.set(candidate.sessionId, {
      header: {
        id: candidate.sessionId,
        cwd: candidate.workspace,
        createdAt: candidate.createdAt,
      },
      live: candidate.live,
      persisted: candidate.persisted,
    });
    if (candidate.title) titles.set(candidate.sessionId, candidate.title);
    for (const evidence of candidate.evidence) {
      events.set(`${candidate.sessionId}:${evidence.seq}`, {
        ...event(evidence.seq, evidence.type, evidence.text, evidence.time),
        surface: evidence.surface,
        text: evidence.text,
        sessionId: candidate.sessionId,
      });
    }
    for (let seq = 0; seq < candidate.logicalEventCount; seq += 1) {
      const key = `${candidate.sessionId}:${seq}`;
      if (events.has(key)) continue;
      const text = `generated large-session filler event ${seq}`;
      events.set(key, {
        ...event(seq, seq % 2 ? "assistant/message" : "user/message", text, BASE_TIME + seq),
        surface: seq % 3 ? "current" : "shadowed",
        text,
        sessionId: candidate.sessionId,
      });
    }
  }

  const sessionQuery = {
    async searchSessions() {
      legacyCalls += 1;
      throw new Error("LEGACY SEARCH MUST NEVER RUN");
    },
    async filterSessions(filters, signal) {
      signal?.throwIfAborted?.();
      assert.equal(filters.length, 1);
      assert.equal(filters[0].kind, "id");
      if (options.failMetadata) throw new Error("metadata unavailable");
      return filters[0].values.flatMap((id) => records.has(id) ? [structuredClone(records.get(id))] : []);
    },
    async filterEvents(sessionId, filters) {
      eventFilterCalls.push({ sessionId, filters: structuredClone(filters) });
      activeReads += 1;
      peakReads = Math.max(peakReads, activeReads);
      try {
        if (options.filterNeverSettles) return new Promise(() => {});
        if (options.readDelay) await delay(options.readDelay);
        if (options.failFilter) throw new Error("semantic scan unavailable");
        let documents = [...events.entries()]
          .filter(([key]) => key.startsWith(`${sessionId}:`))
          .map(([, value]) => structuredClone(value))
          .sort((left, right) => left.seq - right.seq);
        for (const filter of filters) {
          if (filter.kind === "seq") {
            documents = documents.filter(({ seq }) => seq >= filter.from && seq <= filter.to);
          } else if (filter.kind === "time") {
            documents = documents.filter(({ time }) => (
              (filter.from === undefined || time >= filter.from)
              && (filter.to === undefined || time <= filter.to)
            ));
          } else if (filter.kind === "type") {
            documents = documents.filter(({ type }) => filter.values.includes(type));
          } else if (filter.kind === "surface") {
            documents = documents.filter(({ surface }) => filter.values.includes(surface));
          } else {
            assert.fail(`unexpected event filter ${filter.kind}`);
          }
        }
        return options.transformFilteredDocuments
          ? options.transformFilteredDocuments(documents, sessionId)
          : documents;
      } finally {
        activeReads -= 1;
      }
    },
    async readEvent(request, signal) {
      eventReadCalls.push(structuredClone(request));
      signal?.throwIfAborted?.();
      if (options.readDelay) await delay(options.readDelay);
      signal?.throwIfAborted?.();
      const target = events.get(`${request.sessionId}:${request.seq}`);
      if (!target) return undefined;
      const sessionEvents = [...events.entries()]
        .filter(([key]) => key.startsWith(`${request.sessionId}:`))
        .map(([, value]) => value)
        .sort((left, right) => left.seq - right.seq);
      const selected = sessionEvents.filter(({ seq }) => (
        seq >= request.seq - request.before && seq <= request.seq + request.after
      ));
      return {
        header: structuredClone(records.get(request.sessionId)?.header),
        target: stripDocument(target),
        events: selected.map(stripDocument),
        startSeq: selected.at(0)?.seq ?? request.seq,
        endSeq: selected.at(-1)?.seq ?? request.seq,
      };
    },
    async readTitleSnapshots(ids, signal) {
      signal?.throwIfAborted?.();
      return ids.map((sessionId) => ({
        sessionId,
        status: "fulfilled",
        value: {
          header: structuredClone(records.get(sessionId)?.header),
          ...(titles.has(sessionId) ? { title: { title: titles.get(sessionId) } } : {}),
        },
      }));
    },
  };

  const index = options.index ?? {
    ready() { return options.ready ?? true; },
    deriveWorkspaceScopeToken(workspaceId) {
      tokenWorkspaces.push(workspaceId);
      return `w${createHash("sha256").update(workspaceId).digest("hex").slice(0, 63)}`;
    },
    async searchBatch(request, operation) {
      searchCalls += 1;
      requests.push(structuredClone(request));
      searchOptions.push(operation);
      operation?.signal?.throwIfAborted?.();
      if (options.failSearch) throw new Error("durable index failed");
      if (options.searchNeverSettles) await new Promise(() => {});
      if (options.searchWaitForAbort) {
        await new Promise((resolve, reject) => {
          operation.signal.addEventListener("abort", () => reject(operation.signal.reason), { once: true });
        });
      }
      if (options.malformedResponse) return { bad: true };
      const response = responseFor(candidates, request.literals.length);
      return options.transformResponse ? options.transformResponse(response) : response;
    },
    async verifyDshSearchCandidates(argument) {
      verifyCalls += 1;
      verifyOptions.push(argument);
      argument.signal?.throwIfAborted?.();
      if (options.failVerify) throw new Error("verification failed");
      if (options.malformedVerify) return { verifiedCandidates: "bad", verifiedEvidence: [] };
      const verifiedEvidence = [];
      const pointers = [];
      for (const source of argument.searchResponse.sources) {
        for (const hit of source.ranked) pointers.push({ source, hit });
      }
      let cursor = 0;
      const workers = Array.from(
        { length: Math.min(argument.maxConcurrency, pointers.length) },
        async () => {
          while (cursor < pointers.length) {
            argument.signal?.throwIfAborted?.();
            const { source, hit } = pointers[cursor++];
            const pointer = hit.evidence;
            const documents = await argument.sessionQuery.filterEvents(pointer.sessionId, [{
              kind: "seq", from: Number(pointer.seq), to: Number(pointer.seq),
            }]);
            argument.signal?.throwIfAborted?.();
            const document = documents[0];
            if (!document || document.type !== pointer.eventType || document.surface !== pointer.surface) continue;
            if (!document.text.toLowerCase().includes(argument.literals[source.queryOrdinal].toLowerCase())) continue;
            verifiedEvidence.push({
              queryOrdinal: source.queryOrdinal,
              sessionId: pointer.sessionId,
              seq: pointer.seq,
              documentKey: pointer.documentKey,
              eventType: pointer.eventType,
              surface: pointer.surface,
            });
          }
        },
      );
      await Promise.all(workers);
      const verifiedIds = new Set(verifiedEvidence.map(({ sessionId }) => sessionId));
      return {
        verifiedCandidates: argument.searchResponse.fused.filter(({ sessionId }) => verifiedIds.has(sessionId)),
        verifiedEvidence,
      };
    },
  };

  const adapter = createSessionHistoryAdapter(sessionQuery, index, {
    aliasFor: (id) => id === candidates[0]?.sessionId ? "12" : "",
    listAuthorizedWorkspaceIds: options.listAuthorizedWorkspaceIds ?? (() => ["/work", "/other"]),
    ...(options.searchTimeoutMs === undefined ? {} : { searchTimeoutMs: options.searchTimeoutMs }),
  });
  return {
    adapter,
    index,
    sessionQuery,
    get legacyCalls() { return legacyCalls; },
    get searchCalls() { return searchCalls; },
    get verifyCalls() { return verifyCalls; },
    get peakReads() { return peakReads; },
    requests,
    searchOptions,
    verifyOptions,
    tokenWorkspaces,
    eventFilterCalls,
    eventReadCalls,
  };
}

function stripDocument(source) {
  const { surface: _surface, text: _text, sessionId: _sessionId, ...raw } = source;
  return structuredClone(raw);
}

function responseFor(candidates, queryCount) {
  const sources = Array.from({ length: queryCount }, (_, queryOrdinal) => {
    const ranked = candidates.flatMap((candidate) => {
      const evidence = candidate.evidence.find((item) => item.queryOrdinal === queryOrdinal);
      return evidence ? [{
        rank: 0,
        sessionId: candidate.sessionId,
        score: candidate.score,
        evidence: {
          sessionId: candidate.sessionId,
          documentKey: `${candidate.sessionId}:${evidence.seq}:${queryOrdinal}`,
          seq: String(evidence.seq),
          eventTimeUnixMs: evidence.time,
          eventType: evidence.type,
          surface: evidence.surface,
          snippet: evidence.text.slice(0, 80),
        },
      }] : [];
    }).map((hit, index) => ({ ...hit, rank: index + 1 }));
    return {
      queryOrdinal,
      truncated: false,
      truncationReason: "exhausted",
      rawPostingsScanned: ranked.length,
      ranked,
    };
  });
  const fused = candidates.map((candidate, index) => ({
    rank: index + 1,
    sessionId: candidate.sessionId,
    rrfScore: candidate.score,
    contributions: candidate.evidence.map((evidence) => {
      const ranked = sources[evidence.queryOrdinal].ranked;
      const hit = ranked.find((item) => item.sessionId === candidate.sessionId);
      return {
        queryOrdinal: evidence.queryOrdinal,
        sourceRank: hit.rank,
        contribution: 1 / (60 + hit.rank),
        documentKey: hit.evidence.documentKey,
        seq: hit.evidence.seq,
        snippet: hit.evidence.snippet,
      };
    }),
  }));
  return {
    type: "searchBatch",
    version: "search-batch-response-v1",
    snapshot: { generation: "1", sourceWatermark: "1", sourceLagMs: 0 },
    sources,
    fused,
    fusedTruncated: false,
  };
}

function execution({ cwd = "/work", sessionId = CALLER, asOf = BASE_TIME + 10_000, signal } = {}) {
  return {
    agent: { session: { id: sessionId, header: { cwd } } },
    asOf,
    signal,
  };
}

function evidence(queryOrdinal, seq, text, overrides = {}) {
  return {
    queryOrdinal,
    seq,
    text,
    type: overrides.type ?? "user/message",
    surface: overrides.surface ?? "current",
    time: overrides.time ?? BASE_TIME + seq,
  };
}

// Reproduction/cutover: every cardinality is one batch and never legacy search.
for (let count = 1; count <= 5; count += 1) {
  const queries = Array.from({ length: count }, (_, index) => `literal ${index}`);
  const candidate = fixtureCandidate({
    sessionId: IDS[0],
    live: true,
    title: "Durable result",
    evidence: queries.map((query, index) => evidence(index, index, `Prefix ${query} suffix`, {
      type: index % 2 ? "assistant/message" : "user/message",
      surface: index % 2 ? "shadowed" : "current",
    })),
  });
  const harness = makeHarness([candidate]);
  const result = await harness.adapter.search({ action: "search", queries }, execution());
  assert.equal(harness.searchCalls, 1, `${count} literals must use one batch`);
  assert.equal(harness.verifyCalls, 0, "qq-core must not invoke coordinate-oriented verification");
  assert.equal(harness.legacyCalls, 0);
  assert.deepEqual(harness.requests[0].literals, queries);
  assert.equal(harness.requests[0].version, "search-batch-v1");
  assert.equal(harness.requests[0].perSourceDepth, 100);
  assert.equal(harness.requests[0].finalLimit, 100);
  assert.deepEqual(harness.requests[0].filters.eventTypeAllowList, ["user/message", "assistant/message"]);
  assert.deepEqual(harness.requests[0].filters.surfaceAllowList, ["current", "shadowed"]);
  assert.deepEqual(harness.tokenWorkspaces, ["/work"]);
  assert.equal(harness.eventFilterCalls.length, 1, "one candidate session has one semantic scan");
  assert.equal(harness.eventReadCalls.length, 0, "search never performs detached coordinate reads");
  assert.equal(harness.peakReads <= internals.MAX_VERIFICATION_CONCURRENCY, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].matchedQueryCount, count);
  assert.equal(result.results[0].title, "Durable result");
  assert.equal(result.results[0].alias, "12");
  assert.deepEqual(result.results[0].evidence.map(({ role }) => role),
    queries.map((_, index) => index % 2 ? "assistant" : "user"));
}

// Workspace/session/as-of filters are sent to the durable service and rechecked
// against authoritative metadata/event reads before results are exposed.
{
  const candidates = [
    fixtureCandidate({ sessionId: CALLER, evidence: [evidence(0, 1, "policy clue")] }),
    fixtureCandidate({ sessionId: IDS[1], evidence: [evidence(0, 2, "policy clue")] }),
    fixtureCandidate({ sessionId: IDS[2], workspace: "/evil", evidence: [evidence(0, 3, "policy clue")] }),
  ];
  const other = makeHarness(candidates);
  const result = await other.adapter.search({ action: "search", queries: ["policy clue"] }, execution());
  assert.deepEqual(other.requests[0].filters.excludeSessionIds, [CALLER]);
  assert.deepEqual(other.requests[0].filters.workspaceIds, ["/work"]);
  assert.deepEqual(result.results.map(({ sessionId }) => sessionId), [IDS[1]]);
  assert.deepEqual(other.eventFilterCalls.map(({ sessionId }) => sessionId), [IDS[1]],
    "unauthorized and excluded sessions must not be scanned");

  const current = makeHarness(candidates);
  const currentResult = await current.adapter.search({
    action: "search", queries: ["policy clue"], sessionScope: "current",
  }, execution({ asOf: BASE_TIME + 2 }));
  assert.deepEqual(current.requests[0].filters.includeSessionIds, [CALLER]);
  assert.equal(current.requests[0].filters.notAfterEventTimeUnixMs, BASE_TIME + 1);
  assert.deepEqual(currentResult.results.map(({ sessionId }) => sessionId), [CALLER]);
  assert.deepEqual(current.eventFilterCalls.map(({ sessionId }) => sessionId), [CALLER]);

  const all = makeHarness(candidates);
  const allResult = await all.adapter.search({
    action: "search", queries: ["policy clue"], workspace: "all", sessionScope: "all",
    after: new Date(BASE_TIME).toISOString(), before: new Date(BASE_TIME + 100).toISOString(),
  }, execution({ asOf: BASE_TIME + 50 }));
  assert.deepEqual(all.requests[0].filters.workspaceIds, ["/work", "/other"]);
  assert.equal(all.requests[0].filters.notBeforeEventTimeUnixMs, BASE_TIME);
  assert.equal(all.requests[0].filters.notAfterEventTimeUnixMs, BASE_TIME + 49);
  assert.equal("includeSessionIds" in all.requests[0].filters, false);
  assert.equal("excludeSessionIds" in all.requests[0].filters, false);
  assert.deepEqual(allResult.results.map(({ sessionId }) => sessionId), [CALLER, IDS[1]]);
  for (const { filters } of all.eventFilterCalls) {
    assert.deepEqual(filters, [
      { kind: "time", from: BASE_TIME, to: BASE_TIME + 49 },
      { kind: "type", values: ["user/message", "assistant/message"] },
      { kind: "surface", values: ["current", "shadowed"] },
    ]);
  }
}

// Regression for the measured baseline (5 verifier scans + 5 materializer
// reads): many coordinates in one large logical session now cause one scan.
{
  const clues = ["alpha clue", "bravo clue", "charlie clue", "delta clue", "echo clue"];
  const candidate = fixtureCandidate({
    sessionId: IDS[2],
    evidence: clues.map((text, queryOrdinal) => evidence(queryOrdinal, queryOrdinal + 1, text)),
    logicalEventCount: 50_000,
  });
  const harness = makeHarness([candidate]);
  const result = await harness.adapter.search({ action: "search", queries: clues }, execution());
  assert.equal(result.results.length, 1);
  assert.equal(harness.eventFilterCalls.length, 1, "authoritative work is O(unique sessions)");
  assert.deepEqual(harness.eventFilterCalls[0], {
    sessionId: IDS[2],
    filters: [
      { kind: "type", values: ["user/message", "assistant/message"] },
      { kind: "surface", values: ["current", "shadowed"] },
    ],
  });
  assert.equal(harness.eventReadCalls.length, 0);
  assert.equal(harness.verifyCalls, 0);
}

// Distinct sessions are each scanned once, with at most four complete semantic
// document arrays resident concurrently.
{
  const candidates = Array.from({ length: 6 }, (_, index) => fixtureCandidate({
    sessionId: IDS[index],
    evidence: [evidence(0, index + 1, `bounded scan clue ${index}`)],
  }));
  const harness = makeHarness(candidates, { readDelay: 10 });
  const result = await harness.adapter.search({
    action: "search", queries: ["bounded scan clue"], limit: 6,
  }, execution());
  assert.equal(result.results.length, 6);
  assert.equal(harness.eventFilterCalls.length, 6);
  assert.equal(new Set(harness.eventFilterCalls.map(({ sessionId }) => sessionId)).size, 6);
  assert.equal(harness.peakReads, internals.MAX_VERIFICATION_CONCURRENCY);
  assert.equal(harness.eventReadCalls.length, 0);
}

// Missing/stale and type/surface/text mismatches all fail closed. The complete
// candidate is omitted rather than retaining a partial fused score.
for (const [mode, transformFilteredDocuments] of [
  ["missing", () => []],
  ["stale-seq", (documents) => documents.map((document) => ({ ...document, seq: document.seq + 1 }))],
  ["type", (documents) => documents.map((document) => ({ ...document, type: "tool/result" }))],
  ["surface", (documents) => documents.map((document) => ({ ...document, surface: "raw" }))],
  ["text", (documents) => documents.map((document) => ({ ...document, text: "authoritative replacement" }))],
]) {
  const stale = fixtureCandidate({ sessionId: IDS[3], evidence: [evidence(0, 4, "fresh literal")] });
  const harness = makeHarness([stale], { transformFilteredDocuments });
  const result = await harness.adapter.search({ action: "search", queries: ["fresh literal"] }, execution());
  assert.deepEqual(result.results, [], `${mode} evidence must be omitted`);
  assert.equal(harness.eventFilterCalls.length, 1);
  assert.equal(harness.legacyCalls, 0);
}

// Authoritative time is locally rechecked even when an injected filter violates
// its own predicate, and ordinary scan failures omit the affected session.
{
  const candidate = fixtureCandidate({ sessionId: IDS[3], evidence: [evidence(0, 5, "time clue")] });
  const after = new Date(BASE_TIME).toISOString();
  const before = new Date(BASE_TIME + 10).toISOString();
  const badTime = makeHarness([candidate], {
    transformFilteredDocuments: (documents) => documents.map((document) => ({
      ...document, time: BASE_TIME + 11,
    })),
  });
  const timed = await badTime.adapter.search({
    action: "search", queries: ["time clue"], after, before,
  }, execution());
  assert.deepEqual(timed.results, []);

  const failed = makeHarness([candidate], { failFilter: true });
  const unavailable = await failed.adapter.search({
    action: "search", queries: ["time clue"],
  }, execution());
  assert.deepEqual(unavailable.results, []);
  assert.equal(failed.legacyCalls, 0);
}

// Search results and opaque continuation cursors retain fixed-size snippets, not
// complete message bodies from authoritative semantic scans.
{
  const forbiddenTail = "FULL_MESSAGE_BODY_MUST_NOT_BE_RETAINED";
  const candidates = [
    fixtureCandidate({
      sessionId: IDS[4],
      evidence: [evidence(0, 20, `retention clue ${"x".repeat(20_000)}${forbiddenTail}`)],
    }),
    fixtureCandidate({
      sessionId: IDS[5],
      evidence: [evidence(0, 21, "retention clue second result")],
    }),
  ];
  const harness = makeHarness(candidates);
  const first = await harness.adapter.search({
    action: "search", queries: ["retention clue"], limit: 1,
  }, execution());
  assert.equal(first.results[0].evidence[0].snippet.length <= 320, true);
  assert.equal(JSON.stringify(first).includes(forbiddenTail), false);
  assert.match(first.nextCursor, /^qq-session-history:/u);
  assert.equal(first.nextCursor.includes(forbiddenTail), false);
  const second = await harness.adapter.search({
    action: "search", queries: ["retention clue"], limit: 1, cursor: first.nextCursor,
  }, execution());
  assert.equal(JSON.stringify(second).includes(forbiddenTail), false);
  assert.equal(harness.eventReadCalls.length, 0);
}

// Context remains one bounded authoritative read; roles and non-conversation
// filtering come from the raw DSH observation, never the index snippet.
{
  const candidate = fixtureCandidate({
    sessionId: IDS[4],
    evidence: [
      evidence(0, 1, "before", { type: "user/message" }),
      evidence(0, 2, "tool noise", { type: "tool/result" }),
      evidence(0, 3, "authoritative target", { type: "assistant/message" }),
      evidence(0, 4, "after", { type: "user/message" }),
    ],
  });
  const harness = makeHarness([candidate]);
  const context = await harness.adapter.context({
    action: "context", sessionId: IDS[4], seq: 3, before: 1, after: 1,
  }, execution());
  assert.deepEqual(context.messages.map(({ role, text }) => [role, text]), [
    ["user", "before"], ["assistant", "authoritative target"], ["user", "after"],
  ]);
  assert.equal(context.rawEventBound.before, 50);
  assert.equal(context.rawEventBound.after, 50);
  assert.equal(harness.searchCalls, 0);
  assert.equal(harness.legacyCalls, 0);
}

// Complete pagination preserves the frozen durable order across all pages.
{
  const candidates = [0, 1, 2].map((index) => fixtureCandidate({
    sessionId: IDS[5 + index], evidence: [evidence(0, index + 1, `complete page clue ${index}`)],
  }));
  const harness = makeHarness(candidates);
  const input = { action: "search", queries: ["page clue"], limit: 1 };
  const first = await harness.adapter.search(input, execution());
  const second = await harness.adapter.search({ ...input, cursor: first.nextCursor }, execution());
  const third = await harness.adapter.search({ ...input, cursor: second.nextCursor }, execution());
  assert.deepEqual([
    first.results[0].sessionId, second.results[0].sessionId, third.results[0].sessionId,
  ], [IDS[5], IDS[6], IDS[7]]);
  assert.equal(third.nextCursor, undefined);
  assert.equal(harness.searchCalls, 3);
  assert.equal(harness.eventFilterCalls.length, 3, "initial materialization scans each unique session once");
  assert.equal(harness.verifyCalls, 0);
  assert.equal(harness.legacyCalls, 0);
}

// Opaque one-use pagination: every valid invocation performs exactly one batch;
// replay, tamper, and request mismatch are rejected and mismatches consume tokens.
{
  const candidates = [0, 1, 2].map((index) => fixtureCandidate({
    sessionId: IDS[5 + index], evidence: [evidence(0, index + 1, `page clue ${index}`)],
  }));
  // Every candidate must match the same literal.
  for (const candidate of candidates) candidate.evidence[0].text += " page clue";
  const harness = makeHarness(candidates);
  const input = { action: "search", queries: ["page clue"], limit: 1 };
  const first = await harness.adapter.search(input, execution());
  assert.match(first.nextCursor, /^qq-session-history:/u);
  assert.equal(first.nextCursor.includes(IDS[5]), false);
  const second = await harness.adapter.search({ ...input, cursor: first.nextCursor }, execution());
  assert.equal(harness.searchCalls, 2);
  assert.notEqual(second.nextCursor, first.nextCursor);
  await assert.rejects(
    harness.adapter.search({ ...input, cursor: first.nextCursor }, execution()),
    /cursor is invalid/u,
  );
  await assert.rejects(
    harness.adapter.search({ ...input, cursor: `${second.nextCursor}tamper` }, execution()),
    /cursor is invalid/u,
  );
  await assert.rejects(
    harness.adapter.search({ ...input, queries: ["different"], cursor: second.nextCursor }, execution()),
    /cursor is invalid/u,
  );
  await assert.rejects(
    harness.adapter.search({ ...input, cursor: second.nextCursor }, execution()),
    /cursor is invalid/u,
  );
  assert.equal(harness.legacyCalls, 0);
}

// Missing, disabled/unready, malformed, and failing injected services all fail
// closed without consulting legacy full-text search.
{
  const candidate = fixtureCandidate({ sessionId: IDS[9], evidence: [evidence(0, 1, "closed clue")] });
  const base = makeHarness([candidate]);
  const missing = createSessionHistoryAdapter(base.sessionQuery, undefined, { searchTimeoutMs: 25 });
  await assert.rejects(
    missing.search({ action: "search", queries: ["closed"] }, execution()),
    (error) => /not mounted/u.test(error.message) && error.code !== "SESSION_HISTORY_SEARCH_TIMEOUT",
  );

  for (const index of [
    {},
    { ready: () => false, searchBatch() {}, deriveWorkspaceScopeToken() {} },
    { ready: () => { throw new Error("bad status"); }, searchBatch() {}, deriveWorkspaceScopeToken() {} },
  ]) {
    const adapter = createSessionHistoryAdapter(base.sessionQuery, index, { searchTimeoutMs: 25 });
    await assert.rejects(
      adapter.search({ action: "search", queries: ["closed"] }, execution()),
      (error) => /unavailable|not mounted|not ready/u.test(error.message)
        && error.code !== "SESSION_HISTORY_SEARCH_TIMEOUT",
    );
  }
  for (const mode of ["failSearch", "malformedResponse", "failMetadata"]) {
    const harness = makeHarness([candidate], { [mode]: true });
    await assert.rejects(harness.adapter.search({ action: "search", queries: ["closed clue"] }, execution()));
    assert.equal(harness.legacyCalls, 0, `${mode} must not fall back`);
  }

  const tooMany = makeHarness([candidate], {
    listAuthorizedWorkspaceIds: () => Array.from({ length: 17 }, (_, index) => `/w/${index}`),
  });
  await assert.rejects(tooMany.adapter.search({
    action: "search", queries: ["closed clue"], workspace: "all",
  }, execution()), /1 to 16/u);
  assert.equal(tooMany.searchCalls, 0);
}

// Fused score contributions must bind to the same source rank/document pointer;
// inconsistent daemon output fails closed before any transcript scan.
{
  const candidate = fixtureCandidate({ sessionId: IDS[9], evidence: [evidence(0, 1, "integrity clue")] });
  const harness = makeHarness([candidate], {
    transformResponse(response) {
      response.fused[0].contributions[0].documentKey = "inconsistent-document";
      return response;
    },
  });
  await assert.rejects(
    harness.adapter.search({ action: "search", queries: ["integrity clue"] }, execution()),
    /inconsistent .* contributions/u,
  );
  assert.equal(harness.eventFilterCalls.length, 0);
  assert.equal(harness.legacyCalls, 0);
}

// A stale-ready downstream stage that never resolves cannot keep search pending.
// The production ceiling is 15 seconds; this injected 25ms ceiling is deterministic.
{
  const candidate = fixtureCandidate({ sessionId: IDS[10], evidence: [evidence(0, 1, "timeout clue")] });
  const harness = makeHarness([candidate], { searchNeverSettles: true, searchTimeoutMs: 25 });
  const started = Date.now();
  let observed;
  await assert.rejects(
    harness.adapter.search({ action: "search", queries: ["timeout clue"] }, execution()),
    (error) => {
      observed = error;
      return true;
    },
  );
  assert.equal(observed.name, "SessionHistorySearchTimeoutError");
  assert.equal(observed.code, "SESSION_HISTORY_SEARCH_TIMEOUT");
  assert.equal(observed.retryable, true);
  assert.match(observed.message, /timed out after 25ms; retry/u);
  assert.equal(Date.now() - started < 500, true, "wall-clock guard must settle promptly");
  assert.equal(harness.searchOptions[0].signal.aborted, true);
  assert.equal(harness.legacyCalls, 0);

  const scanHang = makeHarness([candidate], { filterNeverSettles: true, searchTimeoutMs: 25 });
  let scanError;
  await assert.rejects(
    scanHang.adapter.search({ action: "search", queries: ["timeout clue"] }, execution()),
    (error) => {
      scanError = error;
      return true;
    },
  );
  assert.equal(scanError.code, "SESSION_HISTORY_SEARCH_TIMEOUT");
  assert.equal(scanError.retryable, true);
  assert.equal(scanHang.eventFilterCalls.length, 1);
  assert.equal(scanHang.eventReadCalls.length, 0);
}

// Abort is forwarded to search and helper operations and prevents legacy work.
{
  const candidate = fixtureCandidate({ sessionId: IDS[10], evidence: [evidence(0, 1, "abort clue")] });
  const searchAbort = makeHarness([candidate], { searchWaitForAbort: true });
  const controller = new AbortController();
  const pending = searchAbort.adapter.search(
    { action: "search", queries: ["abort clue"] },
    execution({ signal: controller.signal }),
  );
  await waitFor(() => searchAbort.searchCalls === 1);
  controller.abort(new Error("operator cancelled"));
  await assert.rejects(pending, /operator cancelled/u);
  assert.notEqual(searchAbort.searchOptions[0].signal, controller.signal);
  assert.equal(searchAbort.searchOptions[0].signal.aborted, true);
  assert.match(searchAbort.searchOptions[0].signal.reason.message, /operator cancelled/u);
  assert.equal(searchAbort.legacyCalls, 0);

  const scanAbort = makeHarness([candidate], { readDelay: 20 });
  const scanController = new AbortController();
  const scanning = scanAbort.adapter.search(
    { action: "search", queries: ["abort clue"] },
    execution({ signal: scanController.signal }),
  );
  await waitFor(() => scanAbort.eventFilterCalls.length === 1);
  scanController.abort(new Error("semantic scan cancelled"));
  await assert.rejects(scanning, /semantic scan cancelled/u);
  assert.equal(scanAbort.legacyCalls, 0);
}

console.log("qq-core durable session history: ok");

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("test condition did not become true promptly");
    await delay(1);
  }
}
