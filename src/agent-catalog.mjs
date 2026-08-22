/** Live DSH agent catalog rows for the host CLI and JSON API. */

const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parentIdOf(agent) {
  const header = agent?.session?.header ?? {};
  const parent = header.parentSession ?? header.parentId ?? header.parent ?? header.parent_session;
  return typeof parent === "string" && SESSION_ID.test(parent) ? parent : "";
}

export function formatIdleFor(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

export function agentLabel(agent, alias = "") {
  const header = agent?.session?.header ?? {};
  if (typeof header.label === "string" && header.label.trim()) return header.label.trim();
  if (typeof alias === "string" && alias.trim()) return alias.trim();
  const cwd = header.cwd;
  if (typeof cwd === "string" && cwd.trim()) {
    const parts = cwd.split("/").filter(Boolean);
    return parts.at(-1) || cwd;
  }
  return String(agent?.session?.id ?? "");
}

export function agentStatusOf(agent) {
  return agent?.status === "running" ? "running" : "idle";
}

/**
 * One catalog row. `statusSince` is { status, at } from agent/status.
 * Idle time falls back to last session event when no status mark exists.
 */
export function makeAgentRow(agent, options = {}) {
  const now = options.now ?? Date.now();
  const id = String(agent?.session?.id ?? "");
  const alias = options.alias ?? "";
  const status = agentStatusOf(agent);
  const recency = options.recency ?? { latest: 0, createdAt: 0 };
  const marked = options.statusSince;
  let since;
  if (marked && marked.status === status && Number.isFinite(marked.at)) since = marked.at;
  else if (status === "idle") since = recency.latest || recency.createdAt || now;
  else since = now;
  const idleForMs = status === "idle" ? Math.max(0, now - since) : 0;
  const header = agent?.session?.header ?? {};
  return {
    id,
    alias,
    label: agentLabel(agent, alias),
    status,
    idle_for: status === "idle" ? formatIdleFor(idleForMs) : "",
    idle_for_ms: idleForMs,
    parent: parentIdOf(agent),
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    origin: typeof header.origin === "string" ? header.origin : "",
    live: true,
    createdAt: recency.createdAt || 0,
    depth: 0,
  };
}

/** Pre-order the live forest. Unknown parents become roots. */
export function orderAgents(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const ids = new Set(list.map((row) => row.id));
  const byParent = new Map();
  for (const row of list) {
    const parent = row.parent && ids.has(row.parent) ? row.parent : "";
    const siblings = byParent.get(parent) ?? [];
    siblings.push(row);
    byParent.set(parent, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
      return left.id.localeCompare(right.id);
    });
  }
  const out = [];
  const walk = (parent, depth) => {
    for (const row of byParent.get(parent) ?? []) {
      out.push({ ...row, depth, parent: row.parent && ids.has(row.parent) ? row.parent : "" });
      walk(row.id, depth + 1);
    }
  };
  walk("", 0);
  return out;
}

const COLUMNS = Object.freeze([
  { key: "id", header: "ID" },
  { key: "alias", header: "ALIAS" },
  { key: "label", header: "LABEL" },
  { key: "status", header: "STATUS" },
  { key: "idle_for", header: "IDLE_FOR" },
  { key: "parent", header: "PARENT" },
]);

export function renderAgentTable(rows, options = {}) {
  const tree = options.tree === true;
  const ranked = tree ? orderAgents(rows) : orderAgents(rows).slice().sort((left, right) => {
    const leftAlias = left.alias || left.id;
    const rightAlias = right.alias || right.id;
    const leftNumber = Number(left.alias);
    const rightNumber = Number(right.alias);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && left.alias && right.alias) {
      return leftNumber - rightNumber;
    }
    return leftAlias.localeCompare(rightAlias) || left.id.localeCompare(right.id);
  });
  if (ranked.length === 0) return "no agents\n";
  const cells = ranked.map((row) => {
    const id = tree ? `${"  ".repeat(row.depth ?? 0)}${row.id}` : row.id;
    return {
      id,
      alias: row.alias || "",
      label: row.label || "",
      status: row.status || "",
      idle_for: row.idle_for || "",
      parent: row.parent || "",
    };
  });
  const widths = COLUMNS.map((column) => Math.max(
    column.header.length,
    ...cells.map((cell) => String(cell[column.key]).length),
  ));
  const format = (values) => values
    .map((value, index) => String(value).padEnd(widths[index], " "))
    .join("  ")
    .trimEnd();
  const lines = [format(COLUMNS.map((column) => column.header))];
  for (const cell of cells) lines.push(format(COLUMNS.map((column) => cell[column.key])));
  return `${lines.join("\n")}\n`;
}

export const internals = Object.freeze({ SESSION_ID, COLUMNS });
