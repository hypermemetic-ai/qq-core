#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
parts=$(cd -- "$root/.." && pwd -P)
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
node - "$scratch/core-only-state/profiles/qq/package.json" "$sim" <<'NODE'
const { readFileSync } = require("node:fs");
const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
const core = process.argv[3];
const deps = manifest.dependencies ?? {};
if (!["link:", "file:"].some((prefix) => deps["@hypermemetic-ai/qq-core"] === `${prefix}${core}`)) {
  throw new Error(`core profile link is wrong: ${deps["@hypermemetic-ai/qq-core"]}`);
}
for (const name of ["qq-ui", "qq-workflows", "qq-models", "qq-relay", "qq-dictation"]) {
  if (deps[`@hypermemetic-ai/${name}`] !== undefined) throw new Error(`core-only boot linked ${name}`);
}
for (const name of Object.keys(deps)) {
  if (name.includes("tasks") || name.includes("dsh-relay") || name.includes("dsh-dictation")) {
    throw new Error(`retired dependency survived: ${name}`);
  }
}
NODE
stop_host

for name in qq-ui qq-workflows qq-models qq-relay qq-dictation; do
  ln -s "$parts/$name" "$projects/$name"
done
boot all-parts
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
for (const name of ["qq-ui", "qq-workflows", "qq-models", "qq-relay", "qq-dictation"]) {
  const path = realpathSync(join(parts, name));
  const value = deps[`@hypermemetic-ai/${name}`];
  if (value !== `link:${path}` && value !== `file:${path}`) throw new Error(`${name} profile link is wrong: ${value}`);
}
const bundles = manifest.dsh?.profile?.bundles ?? [];
for (const name of ["@hypermemetic-ai/qq-models", "@hypermemetic-ai/qq-dictation"]) {
  if (!bundles.includes(name)) throw new Error(`bundle was not activated: ${name}`);
}
NODE
stop_host
printf 'qq-core host boot: ok\n'
