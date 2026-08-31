#!/usr/bin/env node
import assert from "node:assert/strict";

import { applyConversationEvent, projectConversation } from "../src/conversation.mjs";

const relay = {
  id: "relay-message-1",
  role: "user",
  content: [{ type: "text", text: "Investigate the delegated incident." }],
  source: { kind: "plugin", plugin: "qq-relay", form: "relay" },
};
const inserted = {
  type: "agent/inbox/spliced",
  seq: 1,
  time: 1_000,
  data: { target: "next-step", start: 0, inserted: [relay] },
};
const removed = {
  type: "agent/inbox/spliced",
  seq: 3,
  time: 1_010,
  data: { target: "next-step", start: 0, removedCount: 1 },
};
const durable = {
  type: "user/message",
  seq: 5,
  time: 361_000,
  data: relay,
  surfaceOp: "append",
};

let view = { nodes: [], pending: [] };
view = applyConversationEvent(view, inserted);
assert.equal(view.nodes.length, 1, "relay assignment renders on inbox admission");
assert.equal(view.nodes[0].kind, "context");
assert.equal(view.nodes[0].queued, true);
assert.equal(view.nodes[0].content[0].text, "Investigate the delegated incident.");
view = applyConversationEvent(view, { type: "turn/start", seq: 2, time: 1_005, data: { turn: 1 } });
view = applyConversationEvent(view, removed);
assert.equal(view.nodes.length, 1, "claimed relay assignment stays visible before step/start");
view = applyConversationEvent(view, durable);
assert.equal(view.nodes.length, 1, "durable relay event upgrades rather than duplicates admission");
assert.equal(view.nodes[0].queued, false);
assert.equal(view.nodes[0].durable, true);
assert.equal(view.nodes[0].seq, 5);

const folded = projectConversation([inserted, { type: "turn/start", seq: 2, time: 1_005, data: { turn: 1 } }, removed, durable]);
assert.equal(folded.nodes.length, 1);
assert.equal(folded.nodes[0].durable, true);

const direct = applyConversationEvent({ nodes: [], pending: [] }, {
  ...inserted,
  data: { ...inserted.data, inserted: [{ ...relay, source: { kind: "user" } }] },
});
assert.equal(direct.nodes.length, 0, "direct prompts retain the existing pending-admission path");

console.log("session admission responsiveness: ok");
