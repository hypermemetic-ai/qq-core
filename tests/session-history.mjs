#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createSessionHistoryAdapter, internals } from "../src/session-history.mjs";

const CALLER = "session-00000000-0000-4000-8000-000000000001";
const IDS = Array.from({ length: 12 }, (_, index) => (
  `session-00000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`
));
const BASE_TIME = Date.parse("2026-08-30T12:00:00.000Z");

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
}) {
  return { sessionId, workspace, live, persisted, createdAt, evidence, score, title };
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
      assert.deepEqual(filters, [{ kind: "seq", from: filters[0].from, to: filters[0].to }]);
      activeReads += 1;
      peakReads = Math.max(peakReads, activeReads);
      try {
        if (options.readDelay) await delay(options.readDelay);
        const found = events.get(`${sessionId}:${filters[0].from}`);
        return found ? [structuredClone(found)] : [];
      } finally {
        activeReads -= 1;
      }
    },
    async readEvent(request, signal) {
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
      if (options.searchWaitForAbort) {
        await new Promise((resolve, reject) => {
          operation.signal.addEventListener("abort", () => reject(operation.signal.reason), { once: true });
        });
      }
      if (options.malformedResponse) return { bad: true };
      return responseFor(candidates, request.literals.length);
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
  assert.equal(harness.verifyCalls, 1);
  assert.equal(harness.legacyCalls, 0);
  assert.deepEqual(harness.requests[0].literals, queries);
  assert.equal(harness.requests[0].version, "search-batch-v1");
  assert.equal(harness.requests[0].perSourceDepth, 100);
  assert.equal(harness.requests[0].finalLimit, 100);
  assert.deepEqual(harness.requests[0].filters.eventTypeAllowList, ["user/message", "assistant/message"]);
  assert.deepEqual(harness.requests[0].filters.surfaceAllowList, ["current", "shadowed"]);
  assert.deepEqual(harness.tokenWorkspaces, ["/work"]);
  assert.equal(harness.verifyOptions[0].maxConcurrency, internals.MAX_VERIFICATION_CONCURRENCY);
  assert.equal(harness.verifyOptions[0].maxCandidates, internals.MAX_VERIFICATION_POINTERS);
  assert.equal(harness.verifyOptions[0].signal, undefined);
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

  const current = makeHarness(candidates);
  const currentResult = await current.adapter.search({
    action: "search", queries: ["policy clue"], sessionScope: "current",
  }, execution({ asOf: BASE_TIME + 2 }));
  assert.deepEqual(current.requests[0].filters.includeSessionIds, [CALLER]);
  assert.equal(current.requests[0].filters.notAfterEventTimeUnixMs, BASE_TIME + 1);
  assert.deepEqual(currentResult.results.map(({ sessionId }) => sessionId), [CALLER]);

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
}

// A stale event whose authoritative time/text changed is omitted even when both
// the index response and a malformed verifier claim it is valid.
{
  const stale = fixtureCandidate({ sessionId: IDS[3], evidence: [evidence(0, 4, "fresh literal")] });
  const harness = makeHarness([stale]);
  const original = harness.sessionQuery.readEvent;
  harness.sessionQuery.readEvent = async (...args) => {
    const observed = await original(...args);
    observed.target.data.content[0].text = "authoritative replacement";
    return observed;
  };
  const result = await harness.adapter.search({ action: "search", queries: ["fresh literal"] }, execution());
  assert.deepEqual(result.results, []);
  assert.equal(harness.legacyCalls, 0);
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
  assert.equal(harness.verifyCalls, 1, "frozen continuations must not re-verify changing membership");
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
  const missing = createSessionHistoryAdapter(base.sessionQuery, undefined);
  await assert.rejects(missing.search({ action: "search", queries: ["closed"] }, execution()), /not mounted/u);

  for (const index of [
    {},
    { ready: () => false, searchBatch() {}, deriveWorkspaceScopeToken() {}, verifyDshSearchCandidates() {} },
    { ready: () => { throw new Error("bad status"); }, searchBatch() {}, deriveWorkspaceScopeToken() {}, verifyDshSearchCandidates() {} },
  ]) {
    const adapter = createSessionHistoryAdapter(base.sessionQuery, index);
    await assert.rejects(adapter.search({ action: "search", queries: ["closed"] }, execution()), /unavailable|not mounted|not ready/u);
  }
  for (const mode of ["failSearch", "malformedResponse", "failVerify", "malformedVerify", "failMetadata"]) {
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

// Abort is forwarded to search and helper operations and prevents legacy work.
{
  const candidate = fixtureCandidate({ sessionId: IDS[10], evidence: [evidence(0, 1, "abort clue")] });
  const searchAbort = makeHarness([candidate], { searchWaitForAbort: true });
  const controller = new AbortController();
  const pending = searchAbort.adapter.search(
    { action: "search", queries: ["abort clue"] },
    execution({ signal: controller.signal }),
  );
  controller.abort(new Error("operator cancelled"));
  await assert.rejects(pending, /operator cancelled/u);
  assert.equal(searchAbort.searchOptions[0].signal, controller.signal);
  assert.equal(searchAbort.legacyCalls, 0);

  const verifyAbort = makeHarness([candidate], { readDelay: 20 });
  const verificationController = new AbortController();
  const verifying = verifyAbort.adapter.search(
    { action: "search", queries: ["abort clue"] },
    execution({ signal: verificationController.signal }),
  );
  await delay(1);
  verificationController.abort(new Error("verification cancelled"));
  await assert.rejects(verifying, /verification cancelled/u);
  assert.equal(verifyAbort.verifyOptions[0].signal, verificationController.signal);
  assert.equal(verifyAbort.legacyCalls, 0);
}

console.log("qq-core durable session history: ok");

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
