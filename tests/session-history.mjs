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
      const response = responseFor(candidates, request.literals.length);
      options.mutateResponse?.(response, request, searchCalls);
      return response;
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
            const snippet = document.text.replaceAll(/\s+/g, " ").trim();
            if (!snippet.toLowerCase().includes(argument.literals[source.queryOrdinal].toLowerCase())) continue;
            verifiedEvidence.push({
              queryOrdinal: source.queryOrdinal,
              sessionId: pointer.sessionId,
              seq: pointer.seq,
              documentKey: pointer.documentKey,
              eventType: pointer.eventType,
              surface: pointer.surface,
              eventTimeUnixMs: document.time,
              snippet,
            });
          }
        },
      );
      await Promise.all(workers);
      const verifiedKeys = new Set(verifiedEvidence.map((item) => JSON.stringify([
        item.sessionId, item.queryOrdinal, item.seq, item.documentKey,
      ])));
      const verifiedCandidates = argument.searchResponse.fused.flatMap((candidate) => (
        candidate.contributions.every((contribution) => verifiedKeys.has(JSON.stringify([
          candidate.sessionId,
          contribution.queryOrdinal,
          contribution.seq,
          contribution.documentKey,
        ])))
          ? [{
              ...candidate,
              ...(titles.has(candidate.sessionId) ? { title: titles.get(candidate.sessionId) } : {}),
            }]
          : []
      ));
      const retained = new Set(verifiedCandidates.map(({ sessionId }) => sessionId));
      return {
        verifiedCandidates,
        verifiedEvidence: verifiedEvidence.filter(({ sessionId }) => retained.has(sessionId)),
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
  assert.equal(harness.requests[0].perSourceDepth, 15);
  assert.equal(harness.requests[0].finalLimit, 15);
  assert.deepEqual(harness.requests[0].filters.eventTypeAllowList, ["user/message", "assistant/message"]);
  assert.deepEqual(harness.requests[0].filters.surfaceAllowList, ["current", "shadowed"]);
  assert.deepEqual(harness.tokenWorkspaces, ["/work"]);
  assert.equal(harness.verifyOptions[0].maxConcurrency, internals.MAX_VERIFICATION_CONCURRENCY);
  assert.equal(harness.verifyOptions[0].maxCandidates, count);
  assert.equal(harness.verifyOptions[0].signal, undefined);
  assert.equal(harness.peakReads <= internals.MAX_VERIFICATION_CONCURRENCY, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].matchedQueryCount, count);
  assert.equal(result.results[0].title, "Durable result");
  assert.equal(result.results[0].alias, "12");
  assert.equal(result.diagnostics.strategyVersion, internals.SEARCH_STRATEGY_VERSION);
  assert.equal(result.diagnostics.rungsExecuted, 1);
  assert.equal(result.diagnostics.rungDepth, 15);
  assert.equal(result.diagnostics.maxCandidates, count);
  assert.deepEqual(result.diagnostics.counts, {
    sourceHits: count,
    fusedCandidates: 1,
    verifiedCandidates: 1,
    authorizedCandidates: 1,
    uniqueSessions: 1,
    coordinates: count,
  });
  for (const value of Object.values(result.diagnostics.timingsMs)) {
    assert.equal(Number.isFinite(value) && value >= 0, true);
  }
  const serializedDiagnostics = JSON.stringify(result.diagnostics);
  assert.equal(serializedDiagnostics.includes(queries[0]), false);
  assert.equal(serializedDiagnostics.includes(candidate.sessionId), false);
  assert.equal(serializedDiagnostics.includes("/work"), false);
  assert.deepEqual(result.results[0].evidence.map(({ role }) => role),
    queries.map((_, index) => index % 2 ? "assistant" : "user"));
}

// Legacy durable rows use raw UUID identities. Validate every row first, then
// omit noncanonical identities before exact verification without renumbering the
// canonical source/fused ranks or changing contribution coordinates.
{
  const legacyId = "00000000-0000-4000-8000-000000000099";
  const candidates = [
    fixtureCandidate({ sessionId: legacyId, evidence: [evidence(0, 1, "legacy clue")] }),
    fixtureCandidate({ sessionId: IDS[1], evidence: [evidence(0, 2, "legacy clue")] }),
  ];
  const harness = makeHarness(candidates);
  const result = await harness.adapter.search({ action: "search", queries: ["legacy clue"] }, execution());
  const verifiedResponse = harness.verifyOptions[0].searchResponse;
  assert.deepEqual(verifiedResponse.sources[0].ranked.map(({ sessionId }) => sessionId), [IDS[1]]);
  assert.deepEqual(verifiedResponse.sources[0].ranked.map(({ rank }) => rank), [2]);
  assert.deepEqual(verifiedResponse.fused.map(({ sessionId }) => sessionId), [IDS[1]]);
  assert.deepEqual(verifiedResponse.fused.map(({ rank }) => rank), [2]);
  assert.deepEqual(verifiedResponse.fused[0].contributions.map((item) => ({
    queryOrdinal: item.queryOrdinal,
    sourceRank: item.sourceRank,
    contribution: item.contribution,
    documentKey: item.documentKey,
    seq: item.seq,
  })), [{
    queryOrdinal: 0,
    sourceRank: 2,
    contribution: 1 / 62,
    documentKey: `${IDS[1]}:2:0`,
    seq: "2",
  }]);
  assert.equal(JSON.stringify(verifiedResponse).includes(legacyId), false);
  assert.deepEqual(result.results.map(({ sessionId }) => sessionId), [IDS[1]]);
  assert.equal(result.results[0].evidence[0].sourceRank, 2);
  assert.equal(harness.legacyCalls, 0);
}

// An all-legacy response is a valid empty search, not a protocol failure, and no
// raw UUID reaches the verifier even though the full daemon response was valid.
{
  const legacyId = "00000000-0000-4000-8000-000000000098";
  const harness = makeHarness([
    fixtureCandidate({ sessionId: legacyId, evidence: [evidence(0, 1, "legacy only")] }),
  ]);
  const result = await harness.adapter.search({ action: "search", queries: ["legacy only"] }, execution());
  assert.deepEqual(result.results, []);
  assert.deepEqual(harness.verifyOptions[0].searchResponse.sources[0].ranked, []);
  assert.deepEqual(harness.verifyOptions[0].searchResponse.fused, []);
  assert.equal(harness.verifyCalls, 1);
  assert.equal(harness.legacyCalls, 0);
}

// A nominally canonical fused row supported only by an omitted legacy pointer is
// omitted too; identity filtering must not manufacture usable fused evidence.
{
  const harness = makeHarness([
    fixtureCandidate({
      sessionId: "00000000-0000-4000-8000-000000000096",
      evidence: [evidence(0, 1, "legacy pointer")],
    }),
  ], {
    mutateResponse(response) {
      response.fused[0].sessionId = IDS[2];
    },
  });
  const result = await harness.adapter.search({ action: "search", queries: ["legacy pointer"] }, execution());
  assert.deepEqual(result.results, []);
  assert.deepEqual(harness.verifyOptions[0].searchResponse.sources[0].ranked, []);
  assert.deepEqual(harness.verifyOptions[0].searchResponse.fused, []);
}

// Identity filtering is strictly second-stage: malformed non-ID fields on both
// canonical and legacy source/fused rows still fail closed before verification.
for (const [identity, sessionId] of [
  ["legacy", "00000000-0000-4000-8000-000000000097"],
  ["canonical", IDS[2]],
]) {
  for (const [row, mutateResponse, expected] of [
    ["source", (response) => {
      response.sources[0].ranked[0].evidence.eventType = "tool/result";
    }, /ranked evidence/u],
    ["fused", (response) => {
      response.fused[0].contributions[0].sourceRank = 0;
    }, /fused contributions/u],
  ]) {
    const label = `${identity} ${row}`;
    const harness = makeHarness([
      fixtureCandidate({ sessionId, evidence: [evidence(0, 1, "malformed identity")] }),
    ], { mutateResponse });
    await assert.rejects(
      harness.adapter.search({ action: "search", queries: ["malformed identity"] }, execution()),
      expected,
      label,
    );
    assert.equal(harness.verifyCalls, 0, `${label} must fail before verification`);
    assert.equal(harness.legacyCalls, 0);
  }
}

// Truncation flags and reasons are one closed semantic pair; contradictory
// combinations cannot suppress or force progressive expansion.
for (const [truncated, truncationReason] of [
  [false, "source-depth"],
  [true, "exhausted"],
]) {
  const harness = makeHarness([
    fixtureCandidate({ sessionId: IDS[2], evidence: [evidence(0, 1, "truncation pair")] }),
  ], {
    mutateResponse(response) {
      response.sources[0].truncated = truncated;
      response.sources[0].truncationReason = truncationReason;
    },
  });
  await assert.rejects(
    harness.adapter.search({ action: "search", queries: ["truncation pair"] }, execution()),
    /source results/u,
  );
  assert.equal(harness.verifyCalls, 0);
}

// Duplicate legacy fused identities are rejected before they can be omitted.
{
  const harness = makeHarness([
    fixtureCandidate({
      sessionId: "00000000-0000-4000-8000-000000000094",
      evidence: [evidence(0, 1, "duplicate legacy")],
    }),
    fixtureCandidate({
      sessionId: "00000000-0000-4000-8000-000000000095",
      evidence: [evidence(0, 2, "duplicate legacy")],
    }),
  ], {
    mutateResponse(response) {
      response.fused[1].sessionId = response.fused[0].sessionId;
    },
  });
  await assert.rejects(
    harness.adapter.search({ action: "search", queries: ["duplicate legacy"] }, execution()),
    /fused results/u,
  );
  assert.equal(harness.verifyCalls, 0);
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

// Search consumes the verifier's bounded authoritative facts once; core performs
// no duplicate event/title read and rejects malformed presentation facts.
{
  const candidate = fixtureCandidate({
    sessionId: IDS[3],
    title: "Verified title",
    evidence: [evidence(0, 4, "fresh literal")],
  });
  const harness = makeHarness([candidate]);
  harness.sessionQuery.readEvent = async () => { throw new Error("SEARCH MUST NOT REREAD EVENT"); };
  harness.sessionQuery.readTitleSnapshots = async () => { throw new Error("SEARCH MUST NOT REREAD TITLE"); };
  const result = await harness.adapter.search({ action: "search", queries: ["fresh literal"] }, execution());
  assert.equal(result.results[0].title, "Verified title");
  assert.equal(result.results[0].evidence[0].snippet, "fresh literal");
}
for (const mutate of [
  (verification) => { delete verification.verifiedEvidence[0].eventTimeUnixMs; },
  (verification) => { verification.verifiedEvidence[0].snippet = "x".repeat(321); },
  (verification) => { verification.verifiedCandidates[0].title = "x".repeat(257); },
]) {
  const candidate = fixtureCandidate({
    sessionId: IDS[3],
    title: "Verified title",
    evidence: [evidence(0, 4, "fresh literal")],
  });
  const harness = makeHarness([candidate]);
  const originalVerify = harness.index.verifyDshSearchCandidates;
  harness.index.verifyDshSearchCandidates = async (argument) => {
    const verification = await originalVerify(argument);
    mutate(verification);
    return verification;
  };
  await assert.rejects(
    harness.adapter.search({ action: "search", queries: ["fresh literal"] }, execution()),
    /verified evidence|verified candidates/u,
  );
}
{
  const candidate = fixtureCandidate({ sessionId: IDS[3], evidence: [evidence(0, 4, "fresh literal")] });
  const harness = makeHarness([candidate]);
  const originalVerify = harness.index.verifyDshSearchCandidates;
  harness.index.verifyDshSearchCandidates = async (argument) => {
    const verification = await originalVerify(argument);
    verification.verifiedEvidence = [];
    return verification;
  };
  const result = await harness.adapter.search({ action: "search", queries: ["fresh literal"] }, execution());
  assert.deepEqual(result.results, [], "partial verified candidates must fail closed");
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

// A truncated shallow rung expands only when verified authorized results cannot
// fill the requested page, then freezes the final verified rung for pagination.
{
  const candidates = [0, 1, 2].map((index) => fixtureCandidate({
    sessionId: IDS[5 + index],
    evidence: [evidence(0, index + 1, `ladder clue ${index}`)],
  }));
  const harness = makeHarness(candidates, {
    mutateResponse(response, request) {
      if (request.perSourceDepth !== 8) return;
      response.sources = response.sources.map((source) => ({
        ...source,
        ranked: source.ranked.slice(0, 1),
        truncated: true,
        truncationReason: "source-depth",
      }));
      response.fused = response.fused.slice(0, 1);
      response.fusedTruncated = true;
    },
  });
  const result = await harness.adapter.search({
    action: "search", queries: ["ladder clue"], limit: 2,
  }, execution());
  assert.deepEqual(harness.requests.map(({ perSourceDepth }) => perSourceDepth), [8, 32]);
  assert.deepEqual(harness.requests.map(({ finalLimit }) => finalLimit), [8, 32]);
  assert.deepEqual(harness.verifyOptions.map(({ maxCandidates }) => maxCandidates), [1, 3]);
  assert.equal(result.diagnostics.rungsExecuted, 2);
  assert.equal(result.diagnostics.rungDepth, 32);
  assert.equal(result.diagnostics.counts.authorizedCandidates, 3);
  assert.equal(result.results.length, 2);
  assert.match(result.nextCursor, /^qq-session-history:/u);
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

// Repeated searches within one scoped adapter retain only a fixed number of
// one-use cursors; the oldest token is evicted without disturbing the newest.
{
  const candidates = [0, 1].map((index) => fixtureCandidate({
    sessionId: IDS[5 + index],
    evidence: [evidence(0, index + 1, `cursor cap clue ${index}`)],
  }));
  const harness = makeHarness(candidates);
  const input = { action: "search", queries: ["cursor cap clue"], limit: 1 };
  const cursors = [];
  for (let index = 0; index <= internals.MAX_FUSED_CURSORS; index += 1) {
    const page = await harness.adapter.search(input, execution());
    cursors.push(page.nextCursor);
  }
  await assert.rejects(
    harness.adapter.search({ ...input, cursor: cursors[0] }, execution()),
    /cursor is invalid/u,
  );
  const newest = await harness.adapter.search({ ...input, cursor: cursors.at(-1) }, execution());
  assert.equal(newest.results[0].sessionId, IDS[6]);
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
