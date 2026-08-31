#!/usr/bin/env node
import assert from "node:assert/strict";

import { applyTurnEnd } from "../src/conversation.mjs";

const projected = applyTurnEnd({ nodes: [], pending: [] }, {
  type: "turn/end",
  seq: 7,
  time: 123,
  data: {
    turn: 2,
    reason: {
      kind: "error",
      error: {
        code: "PROVIDER",
        message: "Responses failed (http_status=503, provider_code=server_error, request_id=req_safe): temporary Bearer secret-value",
      },
    },
  },
});
const failure = projected.nodes[0];
assert.equal(failure.kind, "turn-error");
assert.equal(failure.code, "PROVIDER");
assert.match(failure.detail, /http_status=503/);
assert.match(failure.detail, /provider_code=server_error/);
assert.match(failure.detail, /request_id=req_safe/);
assert.doesNotMatch(failure.detail, /secret-value/);
assert.match(failure.detail, /Bearer \[redacted\]/);

const internal = applyTurnEnd({ nodes: [], pending: [] }, {
  type: "turn/end",
  seq: 8,
  data: { turn: 3, reason: { kind: "error", error: { code: "INTERNAL", message: "private implementation detail" } } },
});
assert.equal(internal.nodes[0].detail, "", "non-provider internals remain hidden");

console.log("conversation provider failure projection: ok");
