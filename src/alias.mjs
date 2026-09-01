// Public session alias book owned by qq.
//
// Locked contract (operator, T-66 deck + T-74 ownership):
// - Published deck:  1 2 3 4 9 10 12 20 40 80   (written-list order only)
// - Strange overflow: 6 7 8 11 30                (exactly these, checked
//   against the live spoken set before dealing)
// - Past that: integers > 100, spoken-distinct from live aliases, never a
//   neighbor of one. Pronunciation convenience is no longer the goal.
// - Issuance is farthest-first among free names (not live, not still warm);
//   ties break at random so live aliases spread out.
// - Warm = the last WARM_COUNT issued aliases. A departed session's alias is
//   reusable only after enough later issues rotate past it.
// - A session keeps its alias until it leaves; restart does not re-deal.
// - The map is persisted beside DSH_HOME (config.aliasFile overrides).
// - Schema qq.alias/v1. Missing new file + leftover .qq-relay-aliases.json
//   migrates once onto the new path and is never written again.

import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

export const ALIAS_SCHEMA = "qq.alias/v1";
export const LEGACY_ALIAS_SCHEMA = "qq.relay-alias/v1";
export const PUBLISHED = Object.freeze(["1", "2", "3", "4", "9", "10", "12", "20", "40", "80"]);
export const STRANGE = Object.freeze(["6", "7", "8", "11", "30"]);
export const RESERVED = Object.freeze(["projects"]);
export const WARM_COUNT = 3;
const OVERFLOW_START = 101;
const OVERFLOW_LIMIT = 10_000;
const NEW_BASENAME = ".qq-aliases.json";
const LEGACY_BASENAME = ".qq-relay-aliases.json";

const UNITS = Object.freeze([
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
]);
const TENS = Object.freeze([
  "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
]);
const PLACEHOLDERS = new Set(["hundred", "thousand"]);

function number(n) {
  const value = Number(n);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Spoken root words of an integer alias; placeholders (hundred/thousand) are not identity. */
export function rootTokens(alias) {
  const value = number(alias);
  if (value === null) return [];
  const words = [];
  const push = (part) => {
    if (part >= 1000) {
      words.push(UNITS[Math.floor(part / 1000)], "thousand");
      push(part % 1000);
    } else if (part >= 100) {
      words.push(UNITS[Math.floor(part / 100)], "hundred");
      if (part % 100) push(part % 100);
    } else if (part >= 20) {
      words.push(TENS[Math.floor(part / 10)]);
      if (part % 10) words.push(UNITS[part % 10]);
    } else if (part > 0) {
      words.push(UNITS[part]);
    }
  };
  push(value);
  return words.filter((word) => !PLACEHOLDERS.has(word));
}

/** True when the alias's spoken roots collide with any live alias's roots. */
export function sharesRootWithLive(alias, liveAliases) {
  const own = new Set(rootTokens(alias));
  return liveAliases.some((live) => rootTokens(live).some((word) => own.has(word)));
}

/** True when the candidate integer is adjacent to any live alias integer. */
export function isNeighborOfLive(alias, liveAliases) {
  const value = number(alias);
  return liveAliases.some((live) => {
    const other = number(live);
    return other !== null && Math.abs(value - other) === 1;
  });
}

/**
 * Pick the free name farthest from the live board; ties break at random.
 * With no live aliases every candidate is equidistant, so the pick is random.
 */
export function farthestFirst(candidates, liveAliases, rng = Math.random) {
  const live = liveAliases.map(number).filter((value) => value !== null);
  const score = (candidate) => {
    const value = number(candidate);
    return live.length === 0
      ? 0
      : Math.min(...live.map((other) => Math.abs(value - other)));
  };
  let best = -Infinity;
  for (const candidate of candidates) best = Math.max(best, score(candidate));
  const tied = candidates.filter((candidate) => score(candidate) === best);
  return tied[Math.min(tied.length - 1, Math.floor(rng() * tied.length))];
}

/** Prefer a spoken-distinct overflow alias, but never sacrifice availability for pronunciation. */
export function overflowCandidate(liveAliases, forbidden = new Set()) {
  let fallback = null;
  for (let candidate = OVERFLOW_START; candidate <= OVERFLOW_LIMIT; candidate += 1) {
    const alias = String(candidate);
    if (forbidden.has(alias)) continue;
    fallback ??= alias;
    if (isNeighborOfLive(alias, liveAliases)) continue;
    if (sharesRootWithLive(alias, liveAliases)) continue;
    return alias;
  }
  if (fallback !== null) return fallback;
  throw new Error("qq: alias capacity exhausted");
}

function homeDir(env = process.env) {
  const home = env.HOME || homedir();
  if (!home || !isAbsolute(home)) {
    throw new Error("qq: HOME must be an absolute path when DSH_HOME is unset");
  }
  return home;
}

function besideDshHome(env, basename) {
  const dshHome = env.DSH_HOME?.trim();
  if (dshHome) {
    if (!isAbsolute(dshHome)) throw new Error("qq: DSH_HOME must be an absolute path");
    return join(dirname(dshHome), basename);
  }
  return join(homeDir(env), basename);
}

/** Default alias map location: a dotfile beside DSH_HOME. */
export function defaultAliasFile(env = process.env, config = {}) {
  if (config.aliasFile !== undefined) {
    if (typeof config.aliasFile !== "string" || config.aliasFile.length === 0 || !isAbsolute(config.aliasFile)) {
      throw new Error("qq: aliasFile must be an absolute path");
    }
    return config.aliasFile;
  }
  return besideDshHome(env, NEW_BASENAME);
}

/** Pre-T-74 relay-owned map. Read once, never written again. */
export function defaultLegacyAliasFile(env = process.env) {
  return besideDshHome(env, LEGACY_BASENAME);
}

function siblingLegacyFile(filePath) {
  if (!filePath) return undefined;
  return join(dirname(filePath), LEGACY_BASENAME);
}

function validateEntry(entry) {
  return entry && typeof entry.alias === "string" && typeof entry.session === "string" &&
    Number.isSafeInteger(entry.issuedAt) && (entry.goneAt === null || Number.isSafeInteger(entry.goneAt));
}

function parseAliasStore(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`qq: alias store ${filePath} is malformed`, { cause: error });
  }
  if (
    (parsed?.schema !== ALIAS_SCHEMA && parsed?.schema !== LEGACY_ALIAS_SCHEMA) ||
    !Array.isArray(parsed.entries) ||
    !parsed.entries.every(validateEntry)
  ) {
    throw new Error(`qq: alias store ${filePath} is malformed`);
  }
  return parsed.entries;
}

/**
 * One persistent alias book. `liveIds` names the loaded sessions; entries for
 * sessions that left are marked gone, and the book deals to live sessions
 * without an entry. A returning session keeps its entry unless another live
 * session was dealt the same alias in the meantime.
 *
 * `filePath` may be omitted for an in-memory book (unit tests without DSH_HOME).
 */
export function createAliasBook(filePath, options = {}) {
  const rng = options.rng ?? Math.random;
  const now = options.now ?? Date.now;
  const migrateFrom = options.migrateFrom;
  const legacyFile = options.legacyFile;

  function load() {
    if (filePath && existsSync(filePath)) return parseAliasStore(filePath);
    const candidates = [];
    if (migrateFrom) candidates.push(migrateFrom);
    if (legacyFile && legacyFile !== filePath) candidates.push(legacyFile);
    const sibling = siblingLegacyFile(filePath);
    if (sibling && sibling !== filePath && sibling !== legacyFile) candidates.push(sibling);
    for (const legacyPath of candidates) {
      if (!legacyPath || !existsSync(legacyPath)) continue;
      const entries = parseAliasStore(legacyPath);
      return { entries, migrated: true };
    }
    return [];
  }

  const loaded = load();
  let entries = Array.isArray(loaded) ? loaded : loaded.entries;
  let dirty = Boolean(loaded?.migrated);

  const book = {
    filePath,
    entries() { return entries.map((entry) => ({ ...entry })); },

    aliasFor(sessionId) {
      return entries.find((entry) => entry.session === sessionId)?.alias;
    },

    sync(liveIds) {
      const live = new Set(liveIds);
      for (const entry of entries) {
        if (!live.has(entry.session) && entry.goneAt === null) {
          entry.goneAt = now();
          dirty = true;
        }
      }
      for (const sessionId of liveIds) {
        if (!entries.some((entry) => entry.session === sessionId)) continue;
        // Returning session: keep its alias when nothing else took it.
        const entry = entries.find((item) => item.session === sessionId);
        const holder = entries.find((item) =>
          item.session !== sessionId && item.alias === entry.alias && item.goneAt === null);
        if (!holder) {
          if (entry.goneAt !== null) {
            entry.goneAt = null;
            dirty = true;
          }
          continue;
        }
        entry.alias = book.deal(live);
        entry.goneAt = null;
        dirty = true;
      }
      for (const sessionId of liveIds) {
        if (entries.some((entry) => entry.session === sessionId)) continue;
        entries.push({ alias: book.deal(live), session: sessionId, issuedAt: now(), goneAt: null });
        dirty = true;
      }
      if (dirty) book.persist();
    },

    /**
     * Aliases that must not be re-dealt yet: the last WARM_COUNT issues and
     * the last WARM_COUNT departures. A just-died session's alias stays warm
     * even when its issuance was ages ago.
     */
    warm() {
      const issued = entries.slice().sort((left, right) => right.issuedAt - left.issuedAt);
      const departed = entries
        .filter((entry) => entry.goneAt !== null)
        .sort((left, right) => right.goneAt - left.goneAt);
      const warmAliases = new Set();
      for (const entry of [...issued.slice(0, WARM_COUNT), ...departed.slice(0, WARM_COUNT)]) {
        warmAliases.add(entry.alias);
      }
      return warmAliases;
    },

    /** Pin a reserved alias. Numeric deal never issues these names. */
    pin(sessionId, alias) {
      if (!RESERVED.includes(alias)) {
        throw new Error(`qq: ${alias} is not a reserved alias`);
      }
      const holders = entries.filter((entry) => entry.alias === alias && entry.session !== sessionId);
      for (const holder of holders) {
        const live = entries
          .filter((entry) => entry.goneAt === null && entry.session !== holder.session)
          .map((entry) => entry.session);
        holder.alias = book.deal(live);
        dirty = true;
      }
      const existing = entries.find((entry) => entry.session === sessionId);
      if (existing) {
        if (existing.alias !== alias || existing.goneAt !== null) {
          existing.alias = alias;
          existing.goneAt = null;
          dirty = true;
        }
      } else {
        entries.push({ alias, session: sessionId, issuedAt: now(), goneAt: null });
        dirty = true;
      }
      if (dirty) book.persist();
      return alias;
    },

    /** Choose one free name for a new live session. */
    deal(liveIds = []) {
      const liveSet = new Set(liveIds);
      const liveAliases = entries
        .filter((entry) => liveSet.has(entry.session) || entry.goneAt === null)
        .map((entry) => entry.alias);
      const warmSet = book.warm();
      const reserved = new Set(RESERVED);
      const freeIn = (deck) => deck.filter((alias) =>
        !liveAliases.includes(alias) && !warmSet.has(alias) && !reserved.has(alias));
      const published = freeIn(PUBLISHED);
      if (published.length > 0) return farthestFirst(published, liveAliases, rng);
      const strange = freeIn(STRANGE);
      if (strange.length > 0) return farthestFirst(strange, liveAliases, rng);
      const forbidden = new Set([...liveAliases, ...warmSet, ...RESERVED]);
      return overflowCandidate(liveAliases, forbidden);
    },

    persist() {
      if (!dirty || !filePath) return;
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      const temporary = `${filePath}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ schema: ALIAS_SCHEMA, entries }, null, 2)}\n`, {
        mode: 0o600,
      });
      renameSync(temporary, filePath);
      dirty = false;
    },

    close() {
      book.persist();
    },
  };

  if (dirty) book.persist();
  return book;
}
