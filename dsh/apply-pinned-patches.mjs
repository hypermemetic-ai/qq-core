import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE = "@deepseek-ai/dsh-sandbox";
const VERSION = "0.1.0-rc.7";
const ORIGINAL_SHA256 = "63ee2a10873a336162acd9a0d7da7f5f3dc59d072456a0b5271da277565e324f";
const ORIGINAL_TABLE = `const WIDER_MODES = {
\t"read-only": ["workspace-write", "danger-full-access"],
\t"workspace-write": ["danger-full-access"]
};`;
const PATCHED_TABLE = `const WIDER_MODES = {
\t"read-only": ["workspace-write", "danger-full-access"],
\t"workspace-write": ["danger-full-access"],
\t"danger-full-access": []
};`;
const ORIGINAL_GUARD = '\tif (!(WIDER_MODES[effectiveMode] ?? []).includes(mode)) throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call\'s current "${effectiveMode}" mode`);';
const PATCHED_GUARD = '\tif (!Object.hasOwn(WIDER_MODES, mode) || !Object.hasOwn(WIDER_MODES, effectiveMode)) throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call\'s current "${effectiveMode}" mode`);\n'
  + "\t// Redundant stale-schema arguments cannot widen the standing policy.\n"
  + "\tif (mode === effectiveMode || WIDER_MODES[mode].includes(effectiveMode)) return effectiveMode;\n"
  + ORIGINAL_GUARD;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export const patch = Object.freeze({
  package: PACKAGE,
  version: VERSION,
  file: "lib/index.js",
  originalSha256: ORIGINAL_SHA256,
  patchedSha256: "6ba9df009c4f02066dc78ea2abdeffdfeb37c5eef3292298fdad7d00629d39c3",
});

export function patchSandboxSource(source) {
  const digest = sha256(source);
  if (digest === patch.patchedSha256) return { changed: false, source };
  if (digest !== patch.originalSha256) {
    throw new Error(`qq-dsh-toolchain: refusing to patch ${PACKAGE}: unexpected ${patch.file} sha256 ${digest}`);
  }
  const replaceExactly = (value, original, replacement, description) => {
    const first = value.indexOf(original);
    if (first < 0 || value.indexOf(original, first + original.length) >= 0) {
      throw new Error(`qq-dsh-toolchain: refusing to patch ${PACKAGE}: expected one canonical ${description}`);
    }
    return value.slice(0, first) + replacement + value.slice(first + original.length);
  };
  let patched = replaceExactly(source, ORIGINAL_TABLE, PATCHED_TABLE, "sandbox mode table");
  patched = replaceExactly(patched, ORIGINAL_GUARD, PATCHED_GUARD, "approveEscalation guard");
  const patchedDigest = sha256(patched);
  if (patchedDigest !== patch.patchedSha256) {
    throw new Error(`qq-dsh-toolchain: patched ${PACKAGE} digest mismatch: ${patchedDigest}`);
  }
  return { changed: true, source: patched };
}

export function applyPinnedDshPatches(toolchainRoot = dirname(fileURLToPath(import.meta.url))) {
  const packageRoot = join(toolchainRoot, "node_modules", ...PACKAGE.split("/"));
  const manifestPath = join(packageRoot, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== PACKAGE || manifest.version !== VERSION) {
    throw new Error(`qq-dsh-toolchain: refusing to patch ${manifest.name ?? "unknown package"}@${manifest.version ?? "unknown version"}; expected ${PACKAGE}@${VERSION}`);
  }
  const target = join(packageRoot, patch.file);
  const result = patchSandboxSource(readFileSync(target, "utf8"));
  if (!result.changed) return false;
  const temporary = `${target}.qq-patch-${process.pid}`;
  writeFileSync(temporary, result.source, { mode: 0o644 });
  renameSync(temporary, target);
  return true;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const changed = applyPinnedDshPatches();
  console.log(`qq-dsh-toolchain: ${changed ? "applied" : "verified"} tolerant sandbox escalation patch`);
}
