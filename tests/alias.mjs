#!/usr/bin/env node
import assert from "node:assert/strict";

import { overflowCandidate } from "../src/alias.mjs";

const rootExhaustingLiveAliases = [
  "1", "2", "3", "4", "6", "7", "9", "11", "12", "30", "40", "80", "500", "800", "10000",
];
const forbidden = new Set(rootExhaustingLiveAliases);
const fallback = overflowCandidate(rootExhaustingLiveAliases, forbidden);

assert.equal(fallback, "101", "spoken-root exhaustion falls back to the first available numeric alias");
assert.equal(forbidden.has(fallback), false, "fallback remains numerically unique");
assert.equal(overflowCandidate([], new Set()), "101", "ordinary overflow preference remains unchanged");

console.log("alias allocation: ok");
