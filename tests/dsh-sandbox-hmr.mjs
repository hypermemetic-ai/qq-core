import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { patch, patchSandboxSource } from "../dsh/apply-pinned-patches.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toolchainRoot = join(packageRoot, "dsh", "node_modules");
const deepseekRoot = join(toolchainRoot, "@deepseek-ai");
const packageFile = (name, file = "lib/index.js") => join(deepseekRoot, name, file);
const importPackage = (name) => import(pathToFileURL(packageFile(name)).href);

const sandboxManifest = JSON.parse(readFileSync(packageFile("dsh-sandbox", "package.json"), "utf8"));
assert.equal(sandboxManifest.name, patch.package);
assert.equal(sandboxManifest.version, patch.version);
const patchedSource = readFileSync(packageFile("dsh-sandbox"), "utf8");
assert.equal(patchSandboxSource(patchedSource).changed, false, "installed canonical patch must be idempotent");
assert.throws(
  () => patchSandboxSource(`${patchedSource}\n// drift`),
  /refusing to patch .* unexpected .* sha256/,
  "unknown package source must fail closed",
);

const pins = JSON.parse(readFileSync(join(packageRoot, "dsh", "pins.json"), "utf8"));
assert.deepEqual(pins.dsh.patches, [{
  package: patch.package,
  version: patch.version,
  file: patch.file,
  originalSha256: patch.originalSha256,
  patchedSha256: patch.patchedSha256,
  purpose: "Treat equal or narrower requested sandbox modes as the standing policy without approval",
}]);
const toolchainPackage = JSON.parse(readFileSync(join(packageRoot, "dsh", "package.json"), "utf8"));
assert.equal(toolchainPackage.scripts.postinstall, "node apply-pinned-patches.mjs");

const { approveEscalation } = await importPackage("dsh-sandbox");
let approvalCalls = 0;
const noApproval = {
  approver: { async request() { approvalCalls += 1; return "allowed-once"; } },
  agent: {}, callId: "call-equal", toolName: "bash",
};
const request = (requestedMode, effectiveMode) => ({
  requestedMode,
  effectiveMode,
  justification: "exercise the exact centralized sandbox contract",
  subject: "command",
});
for (const [requestedMode, effectiveMode] of [
  ["read-only", "read-only"],
  ["workspace-write", "workspace-write"],
  ["danger-full-access", "danger-full-access"],
  ["read-only", "workspace-write"],
  ["read-only", "danger-full-access"],
  ["workspace-write", "danger-full-access"],
]) {
  assert.equal(await approveEscalation(request(requestedMode, effectiveMode), noApproval), effectiveMode);
}
assert.equal(approvalCalls, 0, "equal and narrower requests must not ask for approval");

const widerRequests = [];
const allowWider = {
  approver: { async request(value) { widerRequests.push(value); return "allowed-once"; } },
  agent: {}, callId: "call-wider", toolName: "bash",
};
for (const [requestedMode, effectiveMode] of [
  ["workspace-write", "read-only"],
  ["danger-full-access", "read-only"],
  ["danger-full-access", "workspace-write"],
]) {
  assert.equal(await approveEscalation(request(requestedMode, effectiveMode), allowWider), requestedMode);
}
assert.equal(widerRequests.length, 3, "every strictly wider request must use approval");

let rejectionCalls = 0;
await assert.rejects(
  approveEscalation(request("danger-full-access", "workspace-write"), {
    approver: { async request() { rejectionCalls += 1; return "rejected"; } },
    agent: {}, callId: "call-rejected", toolName: "bash",
  }),
  /the user rejected escalating this command/,
);
assert.equal(rejectionCalls, 1);

const { apply: applyBash } = await importPackage("dsh-tool-bash");
function bashFixture(standingMode, approvalOutcome) {
  let definition;
  let shellRuns = 0;
  let approvals = 0;
  const policy = Object.freeze({ mode: standingMode, workspaceRoot: packageRoot });
  const ctx = {
    shell: {
      sandboxMode: "workspace-write",
      resolve: (value) => value,
      async run(value) {
        shellRuns += 1;
        return {
          exitCode: 0, signal: null, timedOut: false, aborted: false,
          timeoutMs: value.timeoutMs ?? 1_000,
          stdout: { text: "ok", truncated: false },
          stderr: { text: "", truncated: false },
          sandbox: { mode: value.sandboxPolicy.mode, denied: false },
        };
      },
    },
    shellEnv: { collect: () => ({}) },
    systemPrompt: { section: () => undefined },
    tools: { register(value) { definition = value; } },
    get(name) {
      if (name === "sandboxPolicy") return { resolve: () => policy };
      if (name === "approval" && approvalOutcome !== undefined) {
        return { async request() { approvals += 1; return approvalOutcome; } };
      }
      return undefined;
    },
  };
  applyBash(ctx, { enableRunInBackground: false });
  return {
    definition,
    get shellRuns() { return shellRuns; },
    get approvals() { return approvals; },
  };
}

for (const [standingMode, requestedMode] of [
  ["workspace-write", "workspace-write"],
  ["danger-full-access", "workspace-write"],
  ["danger-full-access", "danger-full-access"],
]) {
  const fixture = bashFixture(standingMode);
  const args = JSON.parse(JSON.stringify({
    command: "printf ok",
    description: "Print a harmless test marker",
    sandbox_permissions: requestedMode,
    justification: "stale schema supplied a redundant sandbox argument",
  }));
  const result = await fixture.definition.execute(args, {
    callId: `call-${standingMode}-${requestedMode}`,
    signal: new AbortController().signal,
  });
  assert.equal(result.kind, "foreground");
  assert.equal(result.sandbox.mode, standingMode, "non-widening bash call must retain standing policy");
  assert.equal(fixture.shellRuns, 1, "equal/narrower bash command must execute");
  assert.equal(fixture.approvals, 0, "equal/narrower bash command must not ask approval");
  const required = fixture.definition.parameters.required ?? [];
  assert.ok(fixture.definition.parameters.properties.sandbox_permissions);
  assert.ok(fixture.definition.parameters.properties.justification);
  assert.equal(required.includes("sandbox_permissions"), false);
  assert.equal(required.includes("justification"), false);
}

const rejected = bashFixture("workspace-write", "rejected");
await assert.rejects(
  rejected.definition.execute({
    command: "printf should-not-run",
    description: "Prove rejected command stays blocked",
    sandbox_permissions: "danger-full-access",
    justification: "this strictly wider test request must be rejected",
  }, {
    agent: { session: {} },
    callId: "call-bash-rejected",
    signal: new AbortController().signal,
  }),
  /the user rejected escalating this command/,
);
assert.equal(rejected.approvals, 1);
assert.equal(rejected.shellRuns, 0, "approval rejection must block command execution");

for (const family of ["dsh-tool-bash", "dsh-tool-pwsh", "dsh-tool-fs"]) {
  const source = readFileSync(packageFile(family), "utf8");
  assert.match(source, /import \{[^\n]*approveEscalation[^\n]*\} from "@deepseek-ai\/dsh-sandbox";/,
    `${family} must consume the canonical shared helper`);
  for (const field of ["sandbox_permissions", "justification"]) {
    const starts = [...source.matchAll(new RegExp(`\\b${field}: \\{`, "g"))].map((match) => match.index);
    assert.ok(starts.length > 0, `${family} must expose optional ${field}`);
    for (const start of starts) {
      const nextProperty = source.indexOf("\n\t\t\t\t}", start);
      const declaration = source.slice(start, nextProperty < 0 ? source.length : nextProperty + 6);
      assert.doesNotMatch(declaration, /required:\s*true/, `${family}.${field} must not be required`);
    }
  }
}

// Capture an already-issued old-schema call before HMR. Its redundant fields
// remain harmless when the result continuation reaches the tolerant executor.
const staleInFlightBash = bashFixture("workspace-write");
const staleInFlightArgs = JSON.parse(JSON.stringify({
  command: "printf stale-ok",
  description: "Execute an issued pre-HMR command",
  sandbox_permissions: "workspace-write",
  justification: "the old issued request redundantly repeated standing policy",
}));

const { Context } = await importPackage("cordis");
const { SystemPrompt } = await importPackage("dsh-system-prompt");
const { ToolRuntime, defineTool } = await importPackage("dsh-tools");
const ctx = new Context();
new SystemPrompt(ctx, {});
new ToolRuntime(ctx, { mode: "native" });
const defineGate = (description, withEscalation) => defineTool({
  name: "hmr_gate",
  description,
  parameters: {
    command: { type: "string", required: true },
    ...(withEscalation ? {
      sandbox_permissions: { type: "string", enum: ["workspace-write", "danger-full-access"] },
      justification: { type: "string" },
    } : {}),
  },
  output: {
    schema: { type: "string" },
    render: (_args, value) => [{ type: "text", text: value }],
  },
  execute: async () => "ok",
});
const disposeOld = ctx.tools.register(defineGate("old schema", false));
async function buildRequest(cause) {
  const assembly = await ctx.systemPrompt.assemble();
  return Object.freeze({ cause, tools: structuredClone(assembly.tools) });
}
const inFlight = await buildRequest("in-flight");
disposeOld();
ctx.tools.register(defineGate("reloaded schema", true));
for (const cause of ["operator", "relay", "tool-result"]) {
  const next = await buildRequest(cause);
  const gate = next.tools.find(({ name }) => name === "hmr_gate");
  assert.equal(gate.description, "reloaded schema", `${cause} continuation must use the live tool registry`);
  assert.deepEqual(gate.parameters.required, ["command"]);
  assert.ok(gate.parameters.properties.sandbox_permissions);
  assert.ok(gate.parameters.properties.justification);
}
assert.equal(inFlight.tools[0].description, "old schema", "HMR must not mutate an issued request");
assert.equal(inFlight.tools[0].parameters.properties.sandbox_permissions, undefined);
const staleResult = await staleInFlightBash.definition.execute(staleInFlightArgs, {
  callId: "call-issued-before-hmr",
  signal: new AbortController().signal,
});
assert.equal(staleResult.sandbox.mode, "workspace-write");
assert.equal(staleInFlightBash.shellRuns, 1, "issued pre-HMR equal-mode call must execute after reload");
assert.equal(staleInFlightBash.approvals, 0);

const loopSource = readFileSync(packageFile("dsh-agent-loop"), "utf8");
const preStep = loopSource.slice(loopSource.indexOf("async preStep("), loopSource.indexOf("async turn()"));
assert.match(preStep, /systemPrompt\.assemble\(assembleContextFor\(this, signal\)\)/,
  "each new operator/relay/tool-result step must assemble the current registry");
assert.match(loopSource, /buildRequest\(turn, step, assembly\.tools,/,
  "request construction must consume that step's live tool assembly");

console.log("qq-core pinned sandbox and live tool registry: ok");
