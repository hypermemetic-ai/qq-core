// One-shot hop. llm.stream on a fresh session; trimmed text or empty.
// Not a product. Callers name the verb (note, brief, review, rundown).

import { randomUUID } from "node:crypto";

function userMessage(text) {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "qq", form: "notice" },
  };
}

/**
 * Stream once. Fresh sessionId each call. Empty string on miss/failure.
 * DSH GenerateOptions has no cacheRetention field; none is sent.
 */
export async function oneShot(llm, binding, { system, user, signal } = {}) {
  if (!llm || typeof llm.stream !== "function") return "";
  if (!binding?.provider || !binding?.model) return "";
  const request = {
    provider: binding.provider,
    model: binding.model,
    ...(binding.effort ? { reasoningEffort: binding.effort } : {}),
    system,
    messages: [userMessage(user)],
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
});
