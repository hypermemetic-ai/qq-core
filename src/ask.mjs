// One-shot hop. llm.stream on a fresh session; trimmed text or empty.
// Not a product. Callers name the verb (note, brief, review, rundown).

import { randomUUID } from "node:crypto";

function userMessage(content) {
  const blocks = Array.isArray(content) && content.length > 0
    ? content
    : [{ type: "text", text: content == null ? "" : String(content) }];
  return {
    id: randomUUID(),
    role: "user",
    content: blocks,
    source: { kind: "plugin", plugin: "qq-core", form: "notice" },
  };
}

function userContent({ user, content } = {}) {
  if (Array.isArray(content) && content.length > 0) return content;
  return [{ type: "text", text: user == null ? "" : String(user) }];
}

/**
 * Stream once. Fresh sessionId each call. Empty string on miss/failure.
 * DSH GenerateOptions has no cacheRetention field; none is sent.
 * `content` (blocks) wins over `user` (text) when both are present.
 */
export async function oneShot(llm, binding, { system, user, content, signal } = {}) {
  if (!llm || typeof llm.stream !== "function") return "";
  if (!binding?.provider || !binding?.model) return "";
  const request = {
    provider: binding.provider,
    model: binding.model,
    ...(binding.effort ? { reasoningEffort: binding.effort } : {}),
    system,
    messages: [userMessage(userContent({ user, content }))],
    sessionId: `session-${randomUUID()}`,
    ...(signal ? { signal } : {}),
  };
  let text = "";
  try {
    for await (const chunk of llm.stream(request)) {
      if (chunk?.type === "text-delta") text += chunk.text ?? "";
    }
  } catch {
    return "";
  }
  return text.trim();
}

export const internals = Object.freeze({
  userMessage,
  userContent,
});
