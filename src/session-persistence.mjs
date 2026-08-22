// Guard DSH session persistence against leftover project-dir backups.
//
// A directory named `<encoded-cwd>.bak` is not a project. DSH still walks it
// during list(), then assertStoredIdentity fatals because the header cwd
// names the live project path, not the .bak spelling.

export function isBackupProjectDir(dir) {
  const name = String(dir ?? "").split("/").pop() ?? "";
  return name.endsWith(".bak");
}

/** Mutate the live persistence instance so every list walks skip `.bak` dirs. */
export function guardSessionPersistence(persistence) {
  if (!persistence || typeof persistence.listProjectDirs !== "function") return persistence;
  const original = persistence.listProjectDirs;
  if (original[GUARDED]) return persistence;
  async function listProjectDirs(signal) {
    const dirs = await original.call(persistence, signal);
    return (dirs ?? []).filter((dir) => !isBackupProjectDir(dir));
  }
  listProjectDirs[GUARDED] = true;
  persistence.listProjectDirs = listProjectDirs;
  return persistence;
}

const GUARDED = Symbol.for("@hypermemetic-ai/qq/session-persistence-guard");
