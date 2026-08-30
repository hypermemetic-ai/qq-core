const TEXT_LIMIT = 32_768;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asText(value) {
  return typeof value === "string" ? value : "";
}

function sourceKind(message) {
  return typeof message?.source?.kind === "string" ? message.source.kind : "unknown";
}

function directHuman(message) {
  return sourceKind(message) === "user";
}

function messageText(message) {
  return asArray(message?.content)
    .filter((block) => block?.type === "text")
    .map((block) => asText(block.text))
    .join("");
}

function editableMessage(message) {
  const blocks = asArray(message?.content);
  return blocks.length > 0 && blocks.every((block) => block?.type === "text");
}

function clientCorrelation(message) {
  const clientMessageId = message?.source?.clientMessageId;
  return typeof clientMessageId === "string" ? { clientMessageId } : {};
}

function normalizedAssistantBlock(block) {
  if (!block || typeof block !== "object") return undefined;
  if (block.type === "text") {
    const text = asText(block.text);
    return text.trim() ? { type: "text", text } : undefined;
  }
  if (block.type === "reasoning") {
    const text = asText(block.text);
    // Provider replay signatures and encrypted reasoning are deliberately not a
    // display fallback. Only provider-returned readable text reaches the view.
    return text.trim() ? { type: "reasoning", text } : undefined;
  }
  if (block.type === "image") {
    return { type: "image", attachment: block.attachment ?? null };
  }
  return undefined;
}

function normalizedAssistantBlocks(blocks) {
  return asArray(blocks).map(normalizedAssistantBlock).filter(Boolean);
}

function replaceRange(event) {
  const op = event?.surfaceOp;
  if (!op || typeof op !== "object" || op.op !== "replace") return null;
  const start = Number(op.start);
  const end = Number(op.end);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  return { start, end };
}

function nodeTouchesRange(node, start, end) {
  if (!node || typeof node !== "object") return false;
  for (const seq of [node.seq, node.resultSeq, node.finalSeq, node.checkpointSeq]) {
    if (Number.isSafeInteger(seq) && seq >= start && seq <= end) return true;
  }
  return false;
}

export function dropReplacedNodes(nodes, start, end) {
  return asArray(nodes).filter((node) => !nodeTouchesRange(node, start, end));
}

export function pendingFromInbox(inbox, nodes) {
  const pendingState = inbox && (Array.isArray(inbox.nextTurn) || Array.isArray(inbox.nextStep))
    ? inboxSnapshot(inbox)
    : {
        "next-turn": asArray(inbox?.["next-turn"]),
        "next-step": asArray(inbox?.["next-step"]),
      };
  const visibleIds = new Set();
  for (const node of asArray(nodes)) {
    if ((node?.kind === "user" || node?.kind === "steering") && node.messageId) {
      visibleIds.add(String(node.messageId));
    }
  }
  const pending = [];
  for (const target of ["next-step", "next-turn"]) {
    for (const entry of pendingState[target]) {
      const message = entry?.message ?? entry;
      if (!directHuman(message)) continue;
      const id = String(message?.id ?? "");
      if (id && visibleIds.has(id)) continue;
      pending.push({
        id,
        target,
        placement: target === "next-step" ? "steering" : "queued",
        message,
        ...clientCorrelation(message),
        text: messageText(message).slice(0, TEXT_LIMIT),
        editable: editableMessage(message),
      });
    }
  }
  return pending;
}

/**
 * Apply one `assistant/chunk` onto a conversation view. Matches the fold's
 * streaming node. Returns null when the event is not a chunk.
 */
export function applyAssistantChunk(conversation, event) {
  if (!conversation || typeof conversation !== "object" || event?.type !== "assistant/chunk") {
    return null;
  }
  const data = event.data ?? {};
  const chunk = data.chunk ?? {};
  const turn = Number(data.turn ?? 0);
  const step = Number(data.step ?? 0);
  const nodes = Array.isArray(conversation.nodes) ? conversation.nodes.slice() : [];
  const pending = Array.isArray(conversation.pending) ? conversation.pending : [];
  const tail = nodes.at(-1);
  const live = tail?.kind === "assistant"
    && tail.status === "streaming"
    && Number(tail.turn) === turn
    && Number(tail.step) === step;
  const blocks = live && Array.isArray(tail.blocks)
    ? tail.blocks.map((block) => (block && typeof block === "object" ? { ...block } : block))
    : [];
  if (chunk.type === "block-start") {
    if (chunk.blockType === "text" || chunk.blockType === "reasoning") {
      blocks[chunk.index] = { type: chunk.blockType, text: "" };
    }
  } else if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
    const type = chunk.type === "text-delta" ? "text" : "reasoning";
    const previous = blocks[chunk.index];
    blocks[chunk.index] = {
      type,
      text: (previous?.type === type ? asText(previous.text) : "") + asText(chunk.text),
    };
  } else if (chunk.type === "block-end") {
    blocks[chunk.index] = chunk.block;
  }
  const visible = blocks.map(normalizedAssistantBlock).filter(Boolean);
  if (visible.length === 0) {
    if (live) nodes.pop();
    return { nodes, pending };
  }
  const next = {
    kind: "assistant",
    key: `assistant:${turn}:${step}`,
    seq: live ? tail.seq : event.seq,
    time: live ? tail.time : event.time,
    turn,
    step,
    status: "streaming",
    blocks: visible,
  };
  if (live) nodes[nodes.length - 1] = next;
  else nodes.push(next);
  return { nodes, pending };
}

export function applyUserMessage(conversation, event) {
  if (!conversation || typeof conversation !== "object" || event?.type !== "user/message") {
    return null;
  }
  const nodes = Array.isArray(conversation.nodes) ? conversation.nodes.slice() : [];
  const pending = Array.isArray(conversation.pending) ? conversation.pending : [];
  const message = event.data ?? {};
  const range = replaceRange(event);
  if (range) {
    const nextNodes = dropReplacedNodes(nodes, range.start, range.end);
    const source = message?.source;
    if (source?.kind === "plugin" && source?.plugin === "compact") {
      return { nodes: nextNodes, pending };
    }
    nextNodes.push(directHuman(message)
      ? {
          kind: "user",
          key: `user:${event.seq}`,
          seq: event.seq,
          time: event.time,
          messageId: String(message?.id ?? ""),
          content: asArray(message?.content),
          ...clientCorrelation(message),
        }
      : {
          kind: "context",
          key: `context:${event.seq}`,
          seq: event.seq,
          time: event.time,
          source: source ?? { kind: "unknown" },
          content: asArray(message?.content),
        });
    return { nodes: nextNodes, pending };
  }
  if (event.surfaceOp !== "append") return { nodes, pending };
  if (!directHuman(message)) {
    nodes.push({
      kind: "context",
      key: `context:${event.seq}`,
      seq: event.seq,
      time: event.time,
      source: message?.source ?? { kind: "unknown" },
      content: asArray(message?.content),
    });
    return { nodes, pending };
  }
  const id = String(message?.id ?? "");
  const index = id
    ? nodes.findLastIndex((node) => node?.messageId === id && (node.kind === "user" || node.kind === "steering"))
    : -1;
  if (index >= 0) {
    const existing = nodes[index];
    nodes[index] = {
      ...existing,
      seq: event.seq,
      time: event.time,
      content: asArray(message?.content),
      ...clientCorrelation(message),
      claimed: false,
      durable: true,
    };
    return { nodes, pending };
  }
  nodes.push({
    kind: "user",
    key: `user:${event.seq}`,
    seq: event.seq,
    time: event.time,
    messageId: id,
    content: asArray(message?.content),
    ...clientCorrelation(message),
  });
  return { nodes, pending };
}

export function applyAssistantSeal(conversation, event) {
  if (!conversation || typeof conversation !== "object" || event?.type !== "assistant/message") {
    return null;
  }
  const nodes = Array.isArray(conversation.nodes) ? conversation.nodes.slice() : [];
  const pending = Array.isArray(conversation.pending) ? conversation.pending : [];
  if (event.surfaceOp !== "append") return { nodes, pending };
  const data = event.data ?? {};
  const turn = Number(data.turn ?? 0);
  const step = Number(data.step ?? 0);
  const tail = nodes.at(-1);
  const live = tail?.kind === "assistant"
    && Number(tail.turn) === turn
    && Number(tail.step) === step;
  const blocks = normalizedAssistantBlocks(asArray(data.message?.content));
  const next = {
    kind: "assistant",
    key: `assistant:${turn}:${step}`,
    seq: live ? tail.seq : event.seq,
    time: live ? tail.time : event.time,
    turn,
    step,
    status: "settled",
    blocks,
    finalSeq: event.seq,
    finalTime: event.time,
  };
  if (live) nodes[nodes.length - 1] = next;
  else nodes.push(next);
  return { nodes, pending };
}

const TRANSCRIPT_NEUTRAL = new Set(["turn/start", "step/start", "step/end"]);

function viewNodes(conversation) {
  return {
    nodes: Array.isArray(conversation.nodes) ? conversation.nodes.slice() : [],
    pending: Array.isArray(conversation.pending) ? conversation.pending : [],
  };
}

function findToolIndex(nodes, callId) {
  const id = String(callId ?? "");
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (nodes[index]?.kind === "tool" && nodes[index].callId === id) return index;
  }
  return -1;
}

export function applyToolCall(conversation, event, toolViews) {
  if (!conversation || typeof conversation !== "object" || event?.type !== "tool/call") {
    return null;
  }
  const { nodes, pending } = viewNodes(conversation);
  const data = event.data ?? {};
  const callId = String(data.callId ?? "");
  if (findToolIndex(nodes, callId) >= 0) return { nodes, pending };
  const view = eventView(toolViews, event);
  const callView = view?.for === "call" ? view.view : data.callView;
  nodes.push({
    kind: "tool",
    key: `tool:${callId || event.seq}`,
    seq: event.seq,
    time: event.time,
    turn: data.turn,
    step: data.step,
    callId,
    name: asText(data.name) || "unknown",
    arguments: asText(data.arguments),
    argumentSummary: argumentSummary(data.arguments),
    callView: callView ?? null,
    resultView: null,
    status: "running",
    expanded: false,
    content: [],
  });
  return { nodes, pending };
}

export function applyToolResult(conversation, event, toolViews) {
  if (!conversation || typeof conversation !== "object" || event?.type !== "tool/result") {
    return null;
  }
  const { nodes, pending } = viewNodes(conversation);
  const range = replaceRange(event);
  if (event.surfaceOp && event.surfaceOp !== "append" && !range) return { nodes, pending };
  const data = event.data ?? {};
  const callId = resultCallId(event);
  const block = resultBlock(event);
  let index = findToolIndex(nodes, callId);
  if (index < 0) {
    nodes.push({
      kind: "tool",
      key: `tool:${callId || event.seq}`,
      seq: event.seq,
      time: event.time,
      turn: data.turn,
      step: data.step,
      callId,
      name: "unknown",
      arguments: "",
      argumentSummary: "",
      callView: null,
      resultView: null,
      status: "running",
      expanded: false,
      content: [],
    });
    index = nodes.length - 1;
  }
  const view = eventView(toolViews, event);
  const resultView = view?.for === "result" ? view.view : data.resultView;
  const content = asArray(block?.content);
  const explicitError = block?.isError === true || Boolean(data.error);
  const code = safeFailureCode(data.error?.code);
  const interrupted = code === "ABORTED_BEFORE_DISPATCH" || code === "INTERRUPTED"
    || String(data.error?.code ?? "").toLowerCase() === "interrupted";
  const node = nodes[index];
  nodes[index] = {
    ...node,
    resultSeq: event.seq,
    resultTime: event.time,
    resultView: resultView ?? null,
    content,
    error: data.error ?? null,
    isError: explicitError,
    status: interrupted ? "stopped" : explicitError || terminalFailed(resultView) ? "error" : "success",
    hasMedia: hasMedia(content),
    // Completed tools all keep the same compact transcript footprint. The UI
    // chooses an inline reveal or the full-screen reader when the card is used.
    expanded: false,
  };
  return { nodes, pending };
}

export function applyCommandRun(conversation, event) {
  if (!conversation || typeof conversation !== "object" || event?.type !== "command/run") {
    return null;
  }
  const { nodes, pending } = viewNodes(conversation);
  const data = event.data ?? {};
  const commandId = String(data.commandId ?? `seq-${event.seq}`);
  nodes.push({
    kind: "command",
    key: `command:${commandId}`,
    seq: event.seq,
    time: event.time,
    commandId,
    name: asText(data.name) || "command",
    args: typeof data.args === "string" ? data.args : "",
    status: "running",
    outcome: null,
  });
  return { nodes, pending };
}

export function applyCommandDone(conversation, event) {
  if (!conversation || typeof conversation !== "object" || event?.type !== "command/done") {
    return null;
  }
  const { nodes, pending } = viewNodes(conversation);
  const data = event.data ?? {};
  const commandId = String(data.commandId ?? "");
  let index = -1;
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    if (nodes[i]?.kind === "command" && nodes[i].commandId === commandId) {
      index = i;
      break;
    }
  }
  if (index < 0) {
    nodes.push({
      kind: "command",
      key: `command:${commandId || event.seq}`,
      seq: event.seq,
      time: event.time,
      commandId,
      name: "command",
      args: "",
      status: "running",
      outcome: null,
    });
    index = nodes.length - 1;
  }
  const node = nodes[index];
  nodes[index] = {
    ...node,
    status: data.kind === "error" ? "error" : "success",
    outcome: {
      kind: data.kind === "error" ? "error" : "success",
      ...(typeof data.text === "string" ? { text: data.text } : {}),
      ...(Number.isSafeInteger(data.sourceEventSeq) ? { sourceEventSeq: data.sourceEventSeq } : {}),
    },
    doneSeq: event.seq,
  };
  return { nodes, pending };
}

export function applyTurnEnd(conversation, event) {
  if (!conversation || typeof conversation !== "object" || event?.type !== "turn/end") {
    return null;
  }
  const { nodes, pending } = viewNodes(conversation);
  const data = event.data ?? {};
  const reason = data.reason ?? {};
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node?.kind === "tool" && node.turn === data.turn && node.status === "running") {
      nodes[index] = {
        ...node,
        status: "stopped",
        isError: true,
        error: { name: "Interrupted", code: reason.kind === "aborted" ? "interrupted" : "missing-result" },
        expanded: false,
      };
      continue;
    }
    if (node?.kind === "assistant" && node.turn === data.turn && node.status === "streaming") {
      nodes[index] = { ...node, status: "interrupted", finalSeq: event.seq };
    }
  }
  if (reason.kind === "error") {
    nodes.push({
      kind: "turn-error",
      key: `turn-error:${event.seq}`,
      seq: event.seq,
      time: event.time,
      turn: data.turn,
      code: safeFailureCode(reason.error?.code),
    });
  } else if (["aborted", "interrupted", "blocked", "max-tokens"].includes(reason.kind)) {
    nodes.push({
      kind: "turn-status",
      key: `turn-status:${event.seq}`,
      seq: event.seq,
      time: event.time,
      turn: data.turn,
      status: reason.kind,
    });
  }
  return { nodes, pending };
}

function applyFallbackAppend(conversation, event) {
  const { nodes, pending } = viewNodes(conversation);
  const data = event.data ?? {};
  nodes.push({
    kind: "fallback",
    key: `fallback:${event.seq}`,
    seq: event.seq,
    time: event.time,
    eventType: String(event.type ?? "unknown"),
    summary: typeof data.summary === "string" ? data.summary.slice(0, 500) : "",
  });
  return { nodes, pending };
}

/**
 * Apply one session event onto a conversation view. Returns null only when the
 * arguments are not a conversation/event pair. Unknown events stay identity so
 * the live session never refolds the log on the hot path.
 */
export function applyConversationEvent(conversation, event, inbox, toolViews) {
  if (!conversation || typeof conversation !== "object" || !event || typeof event !== "object") {
    return null;
  }
  let next;
  switch (event.type) {
    case "assistant/chunk":
      next = applyAssistantChunk(conversation, event);
      break;
    case "user/message":
      next = applyUserMessage(conversation, event);
      break;
    case "assistant/message":
      next = applyAssistantSeal(conversation, event);
      break;
    case "tool/call":
      next = applyToolCall(conversation, event, toolViews);
      break;
    case "tool/result":
      next = applyToolResult(conversation, event, toolViews);
      break;
    case "command/run":
      next = applyCommandRun(conversation, event);
      break;
    case "command/done":
      next = applyCommandDone(conversation, event);
      break;
    case "turn/end":
      next = applyTurnEnd(conversation, event);
      break;
    case "agent/inbox/spliced":
      next = {
        nodes: Array.isArray(conversation.nodes) ? conversation.nodes : [],
        pending: conversation.pending,
      };
      break;
    default:
      next = TRANSCRIPT_NEUTRAL.has(event.type) || event.surfaceOp !== "append"
        ? conversation
        : applyFallbackAppend(conversation, event);
  }
  if (!next) return null;
  if (inbox !== undefined) return { nodes: next.nodes, pending: pendingFromInbox(inbox, next.nodes) };
  return next;
}

function eventView(toolViews, event) {
  const supplied = toolViews instanceof Map
    ? toolViews.get(event.seq)
    : toolViews?.[event.seq] ?? toolViews?.[String(event.seq)];
  return supplied ?? event?.view;
}

function resultBlock(event) {
  const blocks = asArray(event?.data?.message?.content);
  return blocks.find((block) => block?.type === "tool-result");
}

function resultCallId(event) {
  return String(
    event?.data?.message?.source?.callId
      ?? resultBlock(event)?.toolCallId
      ?? event?.data?.callId
      ?? "",
  );
}

function terminalFailed(view) {
  return view?.card === "terminal"
    && ((Number.isFinite(view.exitCode) && view.exitCode !== 0)
      || (typeof view.signal === "string" && view.signal.length > 0));
}

function hasMedia(blocks) {
  for (const block of asArray(blocks)) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "image" || block.type === "audio" || block.type === "video") return true;
    if (block.type === "tool-result" && hasMedia(block.content)) return true;
  }
  return false;
}

function argumentSummary(raw) {
  const text = asText(raw).trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const preferred = ["command", "path", "file", "query", "pattern", "url", "task", "id"];
      for (const key of preferred) {
        const value = parsed[key];
        if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim().slice(0, 180);
        if (typeof value === "number" || typeof value === "boolean") return `${key}: ${value}`;
      }
      const first = Object.entries(parsed).find(([, value]) =>
        typeof value === "string" || typeof value === "number" || typeof value === "boolean");
      if (first) return `${first[0]}: ${String(first[1]).replace(/\s+/g, " ").slice(0, 150)}`;
      if (Object.keys(parsed).length === 0) return "";
    }
    return JSON.stringify(parsed).replace(/\s+/g, " ").slice(0, 180);
  } catch {
    return text.replace(/\s+/g, " ").slice(0, 180);
  }
}

function commandSpecializedSource(eventBySeq, seq) {
  if (!Number.isSafeInteger(seq) || seq < 0) return false;
  const source = eventBySeq.get(seq);
  if (!source) return false;
  if (String(source.type).startsWith("compaction/")) return true;
  return source.type === "user/message"
    && source.surfaceOp && typeof source.surfaceOp === "object"
    && source.data?.source?.kind === "plugin"
    && source.data?.source?.plugin === "compact";
}

function safeFailureCode(value) {
  return typeof value === "string" && /^[A-Z0-9_-]{1,80}$/.test(value) ? value : "";
}

function compactionText(blocks) {
  const text = asArray(blocks)
    .filter((block) => block?.type === "text")
    .map((block) => asText(block.text))
    .join("");
  return text.trim() ? text : "";
}

function inboxSnapshot(inbox) {
  return {
    "next-turn": asArray(inbox?.nextTurn),
    "next-step": asArray(inbox?.nextStep),
  };
}

/**
 * Derive the optional DSH tool presentation intents for one raw event window.
 * A throwing/missing presenter soft-falls to generic rendering, matching the
 * Host API contract. The session log remains the only durable authority.
 */
export function deriveToolEventViews(events, tools, scope, onError = () => {}) {
  if (!tools || typeof tools.get !== "function") return undefined;
  const calls = new Map();
  const views = {};
  for (const event of asArray(events)) {
    try {
      if (event?.type === "tool/call") {
        const raw = asText(event.data?.arguments);
        const args = JSON.parse(raw);
        const name = asText(event.data?.name);
        calls.set(String(event.data?.callId ?? ""), { name, args });
        const view = tools.get(name, scope)?.presentCall?.(args);
        if (view !== undefined) views[event.seq] = { for: "call", view };
        continue;
      }
      if (event?.type === "tool/result") {
        const call = calls.get(resultCallId(event));
        if (!call) continue;
        const result = resultBlock(event);
        const view = tools.get(call.name, scope)?.presentResult?.(call.args, {
          content: asArray(result?.content),
          isError: result?.isError === true,
          ...(event.data?.meta === undefined ? {} : { meta: event.data.meta }),
        });
        if (view !== undefined) views[event.seq] = { for: "result", view };
      }
    } catch (error) {
      try { onError(error, event); } catch {}
    }
  }
  return Object.keys(views).length > 0 ? views : undefined;
}

/**
 * Fold DSH events plus the live durable-inbox projection into one deterministic
 * conversation view. The rebuild remains the authority; live token growth may
 * apply `assistant/chunk` onto a cached fold. Events, message ids, and inbox
 * splices remain DSH-owned.
 */
export function projectConversation(events, options = {}) {
  const sourceEvents = asArray(events);
  const nodes = [];
  const nodeIndex = new Map();
  const eventBySeq = new Map(sourceEvents.map((event) => [event?.seq, event]));
  const assistant = new Map();
  const tools = new Map();
  const commands = new Map();
  const retries = new Map();
  const compactions = new Map();
  const inbox = { "next-turn": [], "next-step": [] };
  const claimed = new Map();
  const seedLength = Number.isSafeInteger(options.seedLength) && options.seedLength > 0
    ? options.seedLength
    : 0;

  const addNode = (node) => {
    nodes.push(node);
    nodeIndex.set(node.key, node);
    return node;
  };
  const dropRange = (start, end) => {
    const kept = [];
    for (const node of nodes) {
      if (nodeTouchesRange(node, start, end)) {
        nodeIndex.delete(node.key);
        if (node.kind === "tool") tools.delete(String(node.callId ?? ""));
        if (node.kind === "assistant") assistant.delete(`${Number(node.turn ?? 0)}:${Number(node.step ?? 0)}`);
        if (node.kind === "command") commands.delete(String(node.commandId ?? ""));
        if (node.kind === "compaction") compactions.delete(String(node.compactionId ?? ""));
      } else {
        kept.push(node);
      }
    }
    nodes.length = 0;
    nodes.push(...kept);
  };
  const removeNode = (node) => {
    const at = nodes.indexOf(node);
    if (at >= 0) nodes.splice(at, 1);
    nodeIndex.delete(node.key);
  };
  const pushClaim = (message, target, event, turn) => {
    if (!directHuman(message)) return;
    const kind = target === "next-step" ? "steering" : "user";
    const node = addNode({
      kind,
      key: `claimed:${event.seq}:${String(message.id ?? "")}`,
      seq: event.seq,
      time: event.time,
      turn,
      messageId: String(message.id ?? ""),
      content: asArray(message.content),
      ...clientCorrelation(message),
      claimed: true,
    });
    const id = String(message.id ?? "");
    const entries = claimed.get(id) ?? [];
    entries.push({ target, node });
    claimed.set(id, entries);
  };
  const takeClaim = (messageId) => {
    const id = String(messageId ?? "");
    const entries = claimed.get(id);
    if (!entries?.length) return undefined;
    const entry = entries.shift();
    if (entries.length === 0) claimed.delete(id);
    return entry;
  };
  const resetUnclaimedSeedInbox = () => {
    inbox["next-turn"] = [];
    inbox["next-step"] = [];
    for (const entries of claimed.values()) {
      for (const entry of entries) removeNode(entry.node);
    }
    claimed.clear();
  };
  const ensureAssistant = (event) => {
    const turn = Number(event?.data?.turn ?? 0);
    const step = Number(event?.data?.step ?? 0);
    const id = `${turn}:${step}`;
    let state = assistant.get(id);
    if (!state) {
      state = { id, turn, step, blocks: [], node: undefined, sealed: false };
      assistant.set(id, state);
    }
    return state;
  };
  const publishAssistant = (state, event, status) => {
    const blocks = state.blocks.map(normalizedAssistantBlock).filter(Boolean);
    if (blocks.length === 0) {
      if (status === "settled" && state.node) {
        removeNode(state.node);
        state.node = undefined;
      }
      return;
    }
    if (!state.node) {
      state.node = addNode({
        kind: "assistant",
        key: `assistant:${state.id}`,
        seq: event.seq,
        time: event.time,
        turn: state.turn,
        step: state.step,
        status,
        blocks,
      });
      return;
    }
    state.node.blocks = blocks;
    state.node.status = status;
    if (status === "settled") {
      state.node.finalSeq = event.seq;
      state.node.finalTime = event.time;
    }
  };
  const compactionFor = (id, event, sourceCommandId) => {
    const key = String(id || `seq-${event.seq}`);
    let node = compactions.get(key);
    if (node) return node;
    const command = sourceCommandId === undefined ? undefined : commands.get(String(sourceCommandId));
    if (command) {
      command.kind = "compaction";
      command.key = `compaction:${key}`;
      command.compactionId = key;
      command.manual = true;
      command.status = "running";
      command.title = "Compacting context";
      node = command;
    } else {
      node = addNode({
        kind: "compaction",
        key: `compaction:${key}`,
        seq: event.seq,
        time: event.time,
        compactionId: key,
        manual: sourceCommandId !== undefined,
        status: "running",
        title: "Compacting context",
      });
    }
    compactions.set(key, node);
    return node;
  };

  let openTurn;
  for (let index = 0; index < sourceEvents.length; index += 1) {
    if (seedLength > 0 && index === seedLength) resetUnclaimedSeedInbox();
    const event = sourceEvents[index];
    if (!event || typeof event !== "object") continue;
    const data = event.data ?? {};

    switch (event.type) {
      case "turn/start":
        openTurn = data.turn;
        break;
      case "agent/inbox/spliced": {
        const target = data.target === "next-step" ? "next-step" : "next-turn";
        const list = inbox[target];
        const start = Number.isSafeInteger(data.start) ? Math.max(0, Math.min(data.start, list.length)) : 0;
        const count = Number.isSafeInteger(data.removedCount)
          ? Math.max(0, Math.min(data.removedCount, list.length - start))
          : 0;
        const removed = list.slice(start, start + count);
        if (data.outcome !== "canceled") {
          for (const item of removed) pushClaim(item.message, target, event, openTurn);
        }
        const inserted = asArray(data.inserted).map((message) => ({ message, insertedSeq: event.seq }));
        list.splice(start, count, ...inserted);
        break;
      }
      case "user/message": {
        const message = data;
        const compactSource = message?.source;
        const range = replaceRange(event);
        if (range) {
          dropRange(range.start, range.end);
          if (compactSource?.kind === "plugin" && compactSource?.plugin === "compact") {
            const node = compactionFor(compactSource.compactionId, event, compactSource.sourceCommandId);
            node.status = "completed";
            node.checkpointSeq = event.seq;
            break;
          }
          if (!directHuman(message)) {
            addNode({
              kind: "context",
              key: `context:${event.seq}`,
              seq: event.seq,
              time: event.time,
              source: message?.source ?? { kind: "unknown" },
              content: asArray(message?.content),
            });
            break;
          }
          addNode({
            kind: "user",
            key: `user:${event.seq}`,
            seq: event.seq,
            time: event.time,
            messageId: String(message?.id ?? ""),
            content: asArray(message?.content),
            ...clientCorrelation(message),
          });
          break;
        }
        if (event.surfaceOp !== "append") break;
        if (!directHuman(message)) {
          addNode({
            kind: "context",
            key: `context:${event.seq}`,
            seq: event.seq,
            time: event.time,
            source: message?.source ?? { kind: "unknown" },
            content: asArray(message?.content),
          });
          break;
        }
        const occurrence = takeClaim(message?.id);
        if (occurrence) {
          Object.assign(occurrence.node, {
            kind: occurrence.target === "next-step" ? "steering" : "user",
            seq: event.seq,
            time: event.time,
            turn: openTurn,
            content: asArray(message?.content),
            ...clientCorrelation(message),
            claimed: false,
            durable: true,
          });
          break;
        }
        addNode({
          kind: "user",
          key: `user:${event.seq}`,
          seq: event.seq,
          time: event.time,
          messageId: String(message?.id ?? ""),
          content: asArray(message?.content),
          ...clientCorrelation(message),
        });
        break;
      }
      case "assistant/chunk": {
        const state = ensureAssistant(event);
        const chunk = data.chunk ?? {};
        if (chunk.type === "block-start") {
          if (chunk.blockType === "text" || chunk.blockType === "reasoning") {
            state.blocks[chunk.index] = { type: chunk.blockType, text: "" };
          }
        } else if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
          const type = chunk.type === "text-delta" ? "text" : "reasoning";
          const previous = state.blocks[chunk.index];
          state.blocks[chunk.index] = {
            type,
            text: (previous?.type === type ? asText(previous.text) : "") + asText(chunk.text),
          };
        } else if (chunk.type === "block-end") {
          state.blocks[chunk.index] = chunk.block;
        }
        publishAssistant(state, event, "streaming");
        break;
      }
      case "assistant/message": {
        if (event.surfaceOp !== "append") break;
        const state = ensureAssistant(event);
        state.blocks = asArray(data.message?.content);
        state.sealed = true;
        publishAssistant(state, event, "settled");
        break;
      }
      case "tool/call": {
        const callId = String(data.callId ?? "");
        const view = eventView(options.toolViews, event);
        const callView = view?.for === "call" ? view.view : data.callView;
        let node = tools.get(callId);
        if (!node) {
          node = addNode({
            kind: "tool",
            key: `tool:${callId || event.seq}`,
            seq: event.seq,
            time: event.time,
            turn: data.turn,
            step: data.step,
            callId,
            name: asText(data.name) || "unknown",
            arguments: asText(data.arguments),
            argumentSummary: argumentSummary(data.arguments),
            callView: callView ?? null,
            resultView: null,
            status: "running",
            expanded: false,
            content: [],
          });
          tools.set(callId, node);
        }
        break;
      }
      case "tool/result": {
        const range = replaceRange(event);
        if (event.surfaceOp && event.surfaceOp !== "append" && !range) break;
        const callId = resultCallId(event);
        const block = resultBlock(event);
        let node = tools.get(callId);
        if (!node) {
          node = addNode({
            kind: "tool",
            key: `tool:${callId || event.seq}`,
            seq: event.seq,
            time: event.time,
            turn: data.turn,
            step: data.step,
            callId,
            name: "unknown",
            arguments: "",
            argumentSummary: "",
            callView: null,
            resultView: null,
            status: "running",
            expanded: false,
            content: [],
          });
          tools.set(callId, node);
        }
        const view = eventView(options.toolViews, event);
        const resultView = view?.for === "result" ? view.view : data.resultView;
        const content = asArray(block?.content);
        const explicitError = block?.isError === true || Boolean(data.error);
        const code = safeFailureCode(data.error?.code);
        const interrupted = code === "ABORTED_BEFORE_DISPATCH" || code === "INTERRUPTED"
          || String(data.error?.code ?? "").toLowerCase() === "interrupted";
        node.resultSeq = event.seq;
        node.resultTime = event.time;
        node.resultView = resultView ?? null;
        node.content = content;
        node.error = data.error ?? null;
        node.isError = explicitError;
        node.status = interrupted ? "stopped" : explicitError || terminalFailed(resultView) ? "error" : "success";
        node.hasMedia = hasMedia(content);
        node.expanded = false;
        break;
      }
      case "command/run": {
        const commandId = String(data.commandId ?? `seq-${event.seq}`);
        const node = addNode({
          kind: "command",
          key: `command:${commandId}`,
          seq: event.seq,
          time: event.time,
          commandId,
          name: asText(data.name) || "command",
          args: typeof data.args === "string" ? data.args : "",
          status: "running",
          outcome: null,
        });
        commands.set(commandId, node);
        break;
      }
      case "command/done": {
        const commandId = String(data.commandId ?? "");
        let node = commands.get(commandId);
        if (!node) {
          node = addNode({
            kind: "command",
            key: `command:${commandId || event.seq}`,
            seq: event.seq,
            time: event.time,
            commandId,
            name: "command",
            args: "",
            status: "running",
            outcome: null,
          });
          commands.set(commandId, node);
        }
        if (data.kind === "success" && commandSpecializedSource(eventBySeq, data.sourceEventSeq)) {
          if (node.kind === "command") removeNode(node);
          break;
        }
        node.status = data.kind === "error" ? "error" : "success";
        node.outcome = {
          kind: data.kind === "error" ? "error" : "success",
          ...(typeof data.text === "string" ? { text: data.text } : {}),
          ...(Number.isSafeInteger(data.sourceEventSeq) ? { sourceEventSeq: data.sourceEventSeq } : {}),
        };
        node.doneSeq = event.seq;
        break;
      }
      case "llm/retry": {
        const retryId = String(data.retryId ?? `seq-${event.seq}`);
        const state = assistant.get(`${Number(data.turn ?? 0)}:${Number(data.step ?? 0)}`);
        if (state?.node && state.node.status === "streaming") removeNode(state.node);
        if (state) assistant.delete(state.id);
        let node = retries.get(retryId);
        if (!node) {
          node = addNode({
            kind: "retry",
            key: `retry:${retryId}`,
            seq: event.seq,
            time: event.time,
            retryId,
            attempts: [],
          });
          retries.set(retryId, node);
        }
        node.attempts.push({
          retry: Number(data.retry ?? node.attempts.length + 1),
          maxRetries: Number.isFinite(data.maxRetries) ? data.maxRetries : null,
          mode: data.mode === "always" ? "always" : "normal",
          delayMs: Number.isFinite(data.delayMs) ? Math.max(0, data.delayMs) : 0,
          provider: asText(data.provider),
          code: safeFailureCode(data.failure?.code),
          state: "scheduled",
        });
        node.current = node.attempts.at(-1);
        break;
      }
      case "llm/retry-started": {
        const node = retries.get(String(data.retryId ?? ""));
        const attempt = node?.attempts.findLast((candidate) => candidate.retry === data.retry);
        if (attempt) attempt.state = "started";
        if (node) node.current = node.attempts.at(-1);
        break;
      }
      case "compaction/start": {
        const node = compactionFor(data.compactionId, event, data.sourceCommandId);
        node.status = "running";
        break;
      }
      case "compaction/summary": {
        const node = compactionFor(data.compactionId, event, data.sourceCommandId);
        node.summary = compactionText(data.summary);
        node.shadowedItemCount = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : null;
        node.shadowedTokenCount = Number.isSafeInteger(data.shadowedTokenCount) ? data.shadowedTokenCount : null;
        node.summarySeq = event.seq;
        break;
      }
      case "compaction/end": {
        const node = compactionFor(data.compactionId, event, data.sourceCommandId);
        node.status = typeof data.error === "string" && data.error ? "error" : "completed";
        node.endSeq = event.seq;
        break;
      }
      case "compaction/prune":
        addNode({
          kind: "compaction",
          key: `compaction:prune:${event.seq}`,
          seq: event.seq,
          time: event.time,
          status: "completed",
          title: "Context pruned",
          shadowedItemCount: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : null,
          shadowedTokenCount: Number.isSafeInteger(data.shadowedTokenCount) ? data.shadowedTokenCount : null,
        });
        break;
      case "turn/end": {
        if (openTurn === data.turn) openTurn = undefined;
        const reason = data.reason ?? {};
        for (const tool of tools.values()) {
          if (tool.turn !== data.turn || tool.status !== "running") continue;
          tool.status = "stopped";
          tool.isError = true;
          tool.error = { name: "Interrupted", code: reason.kind === "aborted" ? "interrupted" : "missing-result" };
          tool.expanded = false;
        }
        for (const state of assistant.values()) {
          if (state.turn !== data.turn || !state.node || state.node.status !== "streaming") continue;
          state.node.status = "interrupted";
          state.node.finalSeq = event.seq;
        }
        if (reason.kind === "error") {
          addNode({
            kind: "turn-error",
            key: `turn-error:${event.seq}`,
            seq: event.seq,
            time: event.time,
            turn: data.turn,
            code: safeFailureCode(reason.error?.code),
          });
        } else if (["aborted", "interrupted", "blocked", "max-tokens"].includes(reason.kind)) {
          addNode({
            kind: "turn-status",
            key: `turn-status:${event.seq}`,
            seq: event.seq,
            time: event.time,
            turn: data.turn,
            status: reason.kind,
          });
        }
        for (const retry of retries.values()) {
          const current = retry.current;
          if (current?.state === "scheduled") current.state = "cancelled";
        }
        break;
      }
      default:
        if (event.surfaceOp === "append") {
          addNode({
            kind: "fallback",
            key: `fallback:${event.seq}`,
            seq: event.seq,
            time: event.time,
            eventType: String(event.type ?? "unknown"),
            summary: typeof data.summary === "string" ? data.summary.slice(0, 500) : "",
          });
        }
        break;
    }
  }

  return { nodes, pending: pendingFromInbox(options.inbox ?? inbox, nodes) };
}

export const internals = Object.freeze({
  TEXT_LIMIT,
  argumentSummary,
  commandSpecializedSource,
  directHuman,
  hasMedia,
  normalizedAssistantBlocks,
  resultCallId,
  terminalFailed,
  applyAssistantChunk,
  applyAssistantSeal,
  applyConversationEvent,
  applyUserMessage,
  dropReplacedNodes,
  pendingFromInbox,
  replaceRange,
});
