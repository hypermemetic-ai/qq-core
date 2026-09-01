import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE = "@deepseek-ai/dsh-sandbox";
const VERSION = "0.1.0-rc.7";
const ORIGINAL_SHA256 = "63ee2a10873a336162acd9a0d7da7f5f3dc59d072456a0b5271da277565e324f";
const ORIGINAL = '\tif (!(WIDER_MODES[effectiveMode] ?? []).includes(mode)) throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call\'s current "${effectiveMode}" mode`);';
const PATCHED = "\t// Redundant stale-schema arguments cannot widen the standing policy.\n\tif (mode === effectiveMode || (WIDER_MODES[mode] ?? []).includes(effectiveMode)) return effectiveMode;\n" + ORIGINAL;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export const patch = Object.freeze({
  package: PACKAGE,
  version: VERSION,
  file: "lib/index.js",
  originalSha256: ORIGINAL_SHA256,
  patchedSha256: "a3228d460eb0b36354d4e2d33d17a266c4671e59f4ae5afd6a47020a4d975958",
});

export function patchSandboxSource(source) {
  const digest = sha256(source);
  if (digest === patch.patchedSha256) return { changed: false, source };
  if (digest !== patch.originalSha256) {
    throw new Error(`qq-dsh-toolchain: refusing to patch ${PACKAGE}: unexpected ${patch.file} sha256 ${digest}`);
  }
  const first = source.indexOf(ORIGINAL);
  if (first < 0 || source.indexOf(ORIGINAL, first + ORIGINAL.length) >= 0) {
    throw new Error(`qq-dsh-toolchain: refusing to patch ${PACKAGE}: expected one canonical approveEscalation guard`);
  }
  const patched = source.slice(0, first) + PATCHED + source.slice(first + ORIGINAL.length);
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
