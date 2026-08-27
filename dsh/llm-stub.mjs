#!/usr/bin/env node
// Deterministic localhost OpenAI-compatible stub for isolated DSH qq host
// proofs. It supplies no model semantics; explicit proof prompts drive the
// pinned DSH base bundle's native coding tools and skill-tool visibility.
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const [endpointPath, requestsPath] = process.argv.slice(2);
if (!requestsPath) throw new Error("usage: llm-stub.mjs <endpoint.txt> <requests.jsonl>");

let requestNumber = 0;
const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    requestNumber += 1;
    const body = Buffer.concat(chunks).toString("utf8");
    appendFileSync(requestsPath, `${JSON.stringify({ request: requestNumber, url: request.url, body: JSON.parse(body) })}\n`, { mode: 0o600 });
    const parsed = JSON.parse(body);
    if (
      process.env.QQ_LLM_STUB_REJECT_DEVELOPER === "1" &&
      parsed.messages?.some((message) => message?.role === "developer")
    ) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: { code: "invalid_request_error", message: "developer role is unsupported" },
      }));
      return;
    }
    const textOf = (content) => Array.isArray(content)
      ? content.map((part) => part?.text ?? "").join("\n")
      : String(content ?? "");
    const skillProbe = parsed.messages?.some(
      (message) => message?.role === "user" && textOf(message.content).includes("QQ_DSH_SKILL_PROBE"),
    ) === true;
    const nativeToolProbe = !skillProbe && parsed.messages?.some(
      (message) => message?.role === "user" && textOf(message.content).includes("QQ_DSH_NATIVE_TOOL_PROBE"),
    ) === true;
    const completedNativeToolCalls = parsed.messages?.filter(
      (message) => message?.role === "tool" && String(message?.tool_call_id).startsWith("call_qq_native_"),
    ) ?? [];
    const completedSkillCalls = parsed.messages?.filter(
      (message) => message?.role === "tool" && String(message?.tool_call_id).startsWith("call_qq_skill_"),
    ) ?? [];
    const advertisedNames = parsed.tools?.map((tool) => tool?.function?.name ?? tool?.name) ?? [];
    const responseDelayMs = nativeToolProbe || skillProbe ? 20 : requestNumber === 1 ? 750 : 3_500;
    setTimeout(() => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const base = {
        id: `chatcmpl-qq-dsh-${requestNumber}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: parsed.model ?? "deepseek-v4-pro-0813",
      };
      const writeToolCall = (id, name, args) => {
        response.write(`data: ${JSON.stringify({
          ...base,
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [{
                index: 0,
                id,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              }],
            },
            finish_reason: null,
          }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      };
      const writeText = (content) => {
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      };
      if (nativeToolProbe && completedNativeToolCalls.length < 5) {
        const calls = [
          ["write", { file_path: ".qq-tool-proof", content: "alpha\n" }],
          ["read", { file_path: ".qq-tool-proof" }],
          ["edit", { file_path: ".qq-tool-proof", old_string: "alpha", new_string: "beta" }],
          ["grep", { pattern: "beta", path: ".qq-tool-proof" }],
          ["bash", { command: "test \"$(cat .qq-tool-proof)\" = beta && pwd", description: "Verify edited file and repository directory" }],
        ];
        const index = completedNativeToolCalls.length;
        const [toolName, args] = calls[index];
        writeToolCall(`call_qq_native_${index}`, toolName, args);
      } else if (skillProbe && !advertisedNames.includes("skill")) {
        writeText("QQ_DSH_SKILL_PROBE_MISSING_TOOL");
      } else if (skillProbe && completedSkillCalls.length < 1) {
        writeToolCall("call_qq_skill_0", "skill", { name: "qq-proof" });
      } else {
        const content = nativeToolProbe
          ? "QQ_DSH_NATIVE_TOOL_PROBE_COMPLETE"
          : skillProbe
            ? "QQ_DSH_SKILL_PROBE_COMPLETE"
            : "receipt probe step complete";
        writeText(content);
      }
      response.end("data: [DONE]\n\n");
    }, responseDelayMs);
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("localhost LLM stub has no TCP address");
  writeFileSync(endpointPath, `http://127.0.0.1:${address.port}\n`, { mode: 0o600 });
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
