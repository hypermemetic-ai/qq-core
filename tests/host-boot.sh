#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
parts=$(cd -- "$root/.." && pwd -P)
# A per-repository git worktree is not beside the other QQ repositories. Match
# the JS fixtures: when origin is a local primary checkout, use its siblings.
if [[ ! -d $parts/qq-ui ]]; then
  origin=$(git -C "$root" remote get-url origin 2>/dev/null || true)
  if [[ $origin == /* && -d $origin ]]; then
    candidate=$(cd -- "$origin/.." && pwd -P)
    if [[ -d $candidate/qq-ui ]]; then parts=$candidate; fi
  fi
fi
scratch=$(mktemp -d "${TMPDIR:-/tmp}/qq-core-host-boot.XXXXXX")
projects="$scratch/projects"
sim="$projects/qq-core"
pid=
cleanup() {
  if [[ -n ${pid:-} ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT

mkdir -p "$sim/bin" "$scratch/home" "$scratch/config"
cp "$root/bin/qq" "$sim/bin/qq"
cp "$root/package.json" "$root/host.patch.yml" "$root/project-catalog.json" "$sim/"
ln -s "$root/src" "$sim/src"
mkdir -p "$sim/dsh"
cp "$root/dsh/package.json" "$root/dsh/package-lock.json" "$root/dsh/qq-dsh-model-compat.mjs" "$sim/dsh/"

port=$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
stop_host() {
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  pid=
}
boot() {
  local name=$1 state="$scratch/$1-state"
  env -u QQ_DSH_PROVIDER -u QQ_DSH_MODEL \
    HOME="$scratch/home" XDG_CONFIG_HOME="$scratch/config" DSH_HOME="$state" \
    npm_config_cache="$scratch/npm-cache" \
    DSH_TELEMETRY_DISABLED=1 \
    QQ_PORT="$port" QQ_PROJECTS_ROOT="$projects" QQ_DSH_CWD="$sim" \
    QQ_FIND_ROOT="$scratch/missing-image-finder" QQ_MEDIA_ROOT="$scratch/missing-media-box" \
    QQ_STS2_ROOT="$scratch/missing-sts2-companion" \
    QQ_DSH_SESSION_ID=session-63a11000-0000-4000-8000-0000000000aa \
    "$sim/bin/qq" >"$scratch/$name.out" 2>"$scratch/$name.err" &
  pid=$!
  for _ in {1..500}; do
    if ! kill -0 "$pid" 2>/dev/null; then cat "$scratch/$name.err" >&2; return 1; fi
    [[ -f $state/profiles/qq/package.json ]] && grep -Fq 'qq: deepseek-official/deepseek-v4-flash' "$scratch/$name.err" && break
    sleep 0.05
  done
  [[ -f $state/profiles/qq/package.json ]] || { cat "$scratch/$name.err" >&2; return 1; }
  grep -Fq 'qq: deepseek-official/deepseek-v4-flash' "$scratch/$name.err" || { cat "$scratch/$name.err" >&2; return 1; }
  sleep 0.5
  kill -0 "$pid"
}

boot core-only
host_env="$scratch/core-only.env"
tr '\0' '\n' <"/proc/$pid/environ" >"$host_env"
grep -Fxq 'QQ_DSH_HAVE_INDEX=0' "$host_env"
grep -Fxq 'QQ_DSH_HAVE_DASHBOARD=0' "$host_env"
grep -Fxq "QQ_DSH_HMR_ROOTS=$sim" "$host_env"
node - "$scratch/core-only-state/profiles/qq/package.json" "$sim" <<'NODE'
const { readFileSync } = require("node:fs");
const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
const core = process.argv[3];
const deps = manifest.dependencies ?? {};
if (!["link:", "file:"].some((prefix) => deps["@hypermemetic-ai/qq-core"] === `${prefix}${core}`)) {
  throw new Error(`core profile link is wrong: ${deps["@hypermemetic-ai/qq-core"]}`);
}
for (const name of ["qq-ui", "qq-index", "qq-dashboard", "qq-workflows", "qq-models", "qq-relay", "qq-dictation"]) {
  if (deps[`@hypermemetic-ai/${name}`] !== undefined) throw new Error(`core-only boot linked ${name}`);
}
for (const name of Object.keys(deps)) {
  if (name.includes("tasks") || name.includes("dsh-relay") || name.includes("dsh-dictation")) {
    throw new Error(`retired dependency survived: ${name}`);
  }
}
NODE
stop_host

mkdir -p "$projects/qq-wiki" "$projects/qq-dashboard"
cat >"$projects/qq-wiki/package.json" <<'JSON'
{
  "name": "@hypermemetic-ai/not-qq-index",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/plugin.mjs"
}
JSON
cat >"$projects/qq-dashboard/package.json" <<'JSON'
{
  "name": "@hypermemetic-ai/not-qq-dashboard",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/plugin.mjs"
}
JSON
boot identity-mismatch
host_env="$scratch/identity-mismatch.env"
tr '\0' '\n' <"/proc/$pid/environ" >"$host_env"
grep -Fxq 'QQ_DSH_HAVE_INDEX=0' "$host_env"
grep -Fxq 'QQ_DSH_HAVE_DASHBOARD=0' "$host_env"
grep -Fxq "QQ_DSH_HMR_ROOTS=$sim" "$host_env"
grep -Fq "qq: ignoring sibling $projects/qq-wiki with unexpected package identity" "$scratch/identity-mismatch.err"
grep -Fq "qq: ignoring sibling $projects/qq-dashboard with unexpected package identity" "$scratch/identity-mismatch.err"
node - "$scratch/identity-mismatch-state/profiles/qq/package.json" <<'NODE'
const { readFileSync } = require("node:fs");
const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const name of ["qq-index", "qq-dashboard"]) {
  if (manifest.dependencies?.[`@hypermemetic-ai/${name}`] !== undefined) {
    throw new Error(`identity-mismatched ${name} sibling was linked`);
  }
}
NODE
stop_host
rm -rf -- "$projects/qq-wiki" "$projects/qq-dashboard"

for name in qq-ui qq-workflows qq-models qq-relay qq-dictation; do
  ln -s "$parts/$name" "$projects/$name"
done
node - "$parts/qq-wiki/package.json" "$parts/qq-dashboard/package.json" <<'NODE'
const { readFileSync } = require("node:fs");
const index = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (index.name !== "@hypermemetic-ai/qq-index") throw new Error(`unexpected index package: ${index.name}`);
if (index.main !== "src/plugin.mjs") throw new Error(`unexpected index main: ${index.main}`);
const dashboard = JSON.parse(readFileSync(process.argv[3], "utf8"));
if (dashboard.name !== "@hypermemetic-ai/qq-dashboard") {
  throw new Error(`unexpected dashboard package: ${dashboard.name}`);
}
if (dashboard.main !== "src/plugin.mjs") throw new Error(`unexpected dashboard main: ${dashboard.main}`);
NODE
ln -s "$parts/qq-wiki" "$projects/qq-wiki"
ln -s "$parts/qq-dashboard" "$projects/qq-dashboard"
index_root=$(cd -- "$parts/qq-wiki" && pwd -P)
dashboard_root=$(cd -- "$parts/qq-dashboard" && pwd -P)
boot all-parts
host_env="$scratch/all-parts.env"
tr '\0' '\n' <"/proc/$pid/environ" >"$host_env"
grep -Fxq 'QQ_DSH_HAVE_INDEX=1' "$host_env"
grep -Fxq 'QQ_DSH_HAVE_DASHBOARD=1' "$host_env"
hmr_roots=$(sed -n 's/^QQ_DSH_HMR_ROOTS=//p' "$host_env")
for sibling_root in "$index_root" "$dashboard_root"; do
  case ":$hmr_roots:" in
    *":$sibling_root:"*) ;;
    *) echo "$sibling_root was not admitted to HMR roots: $hmr_roots" >&2; exit 1 ;;
  esac
done
for _ in {1..300}; do
  curl -fsSL --max-time 2 "http://127.0.0.1:$port/qq/" >"$scratch/page" 2>/dev/null && break
  sleep 0.05
done
grep -Fq '<!doctype html>' "$scratch/page" 2>/dev/null || {
  cat "$scratch/all-parts.err" >&2
  echo "all-parts HTTP console did not become ready" >&2
  exit 1
}
node - "$scratch/all-parts-state/profiles/qq/package.json" "$parts" "$sim" <<'NODE'
const { readFileSync, realpathSync } = require("node:fs");
const { join } = require("node:path");
const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
const parts = process.argv[3];
const deps = manifest.dependencies ?? {};
const core = process.argv[4];
if (!["link:", "file:"].some((prefix) => deps["@hypermemetic-ai/qq-core"] === `${prefix}${core}`)) {
  throw new Error(`core profile link is wrong: ${deps["@hypermemetic-ai/qq-core"]}`);
}
const siblings = [
  ["qq-ui", "@hypermemetic-ai/qq-ui"],
  ["qq-wiki", "@hypermemetic-ai/qq-index"],
  ["qq-dashboard", "@hypermemetic-ai/qq-dashboard"],
  ["qq-workflows", "@hypermemetic-ai/qq-workflows"],
  ["qq-models", "@hypermemetic-ai/qq-models"],
  ["qq-relay", "@hypermemetic-ai/qq-relay"],
  ["qq-dictation", "@hypermemetic-ai/qq-dictation"],
];
for (const [directory, packageName] of siblings) {
  const path = realpathSync(join(parts, directory));
  const value = deps[packageName];
  if (value !== `link:${path}` && value !== `file:${path}`) {
    throw new Error(`${packageName} profile link is wrong: ${value}`);
  }
}
const bundles = manifest.dsh?.profile?.bundles ?? [];
for (const name of ["@hypermemetic-ai/qq-models", "@hypermemetic-ai/qq-dictation"]) {
  if (!bundles.includes(name)) throw new Error(`bundle was not activated: ${name}`);
}
NODE
stop_host
printf 'qq-core host boot: ok\n'
