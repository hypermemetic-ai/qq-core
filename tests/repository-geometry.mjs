import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listProjectCatalog } from "../src/session.mjs";

const packageRoot = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const read = (path) => readFileSync(join(packageRoot, path), "utf8");
const pkg = JSON.parse(read("package.json"));
assert.equal(pkg.name, "@hypermemetic-ai/qq-core");
assert.match(read("README.md"), /^# `@hypermemetic-ai\/qq-core`$/m);

const plugin = read("src/plugin.mjs");
assert.match(plugin, /export const name = "qq-core";/);
assert.match(plugin, /export const provide = "qq-core";/);
assert.match(plugin, /ctx\.provide\("qq-core", service\);/);
assert.match(plugin, /ctx\.provide\("qq-core-aliases", Object\.freeze\(\{/);
assert.doesNotMatch(plugin, /ctx\.provide\("qq(?:-aliases)?"/);

const ask = read("src/ask.mjs");
assert.match(ask, /source: \{ kind: "plugin", plugin: "qq-core", form: "notice" \}/);
assert.match(read("src/session-history.mjs"), /provider: "qq-core"/);
assert.match(read("src/session.mjs"), /Symbol\.for\("@hypermemetic-ai\/qq-core\/agent-handle"\)/);
assert.match(read("src/session.mjs"), /Symbol\.for\("@hypermemetic-ai\/qq-core\/delegate-create-guard"\)/);
assert.match(read("src/session-persistence.mjs"), /Symbol\.for\("@hypermemetic-ai\/qq-core\/session-persistence-guard"\)/);

const catalog = JSON.parse(read("project-catalog.json"));
assert.equal(catalog.projects.some(({ name }) => name === "qq"), false, "qq must not be a catalog group");
const catalogText = JSON.stringify(catalog);
for (const retired of ["tasks", "dsh-relay", "dsh-dictation"]) {
  assert.equal(catalogText.includes(retired), false, `catalog still contains ${retired}`);
}

const launcher = read("bin/qq");
for (const sibling of ["qq-ui", "qq-workflows", "qq-models", "qq-relay", "qq-dictation"]) {
  assert.match(launcher, new RegExp(`add_named_sibling ${sibling.replace("-", "\\-")}`));
}
assert.doesNotMatch(launcher, /qq-\\\*|qq-tasks|dsh-relay|dsh-dictation/);
assert.match(launcher, /\["@hypermemetic-ai\/qq-core", corePath\]/);
assert.doesNotMatch(launcher, /@hypermemetic-ai\/qq["/]/);
assert.match(launcher, /plugin --profile qq add "\$root"/);
assert.match(launcher, /hmr_roots=\("\$root"/);
assert.match(launcher, /QQ_DSH_CWD=\$\{QQ_DSH_CWD:-\$root\}/);
assert.doesNotMatch(launcher, /"\$root\/core"|"\$root"\/qq-\*/);

const patch = read("host.patch.yml");
assert.match(patch, /- id: qq-core\n\s+name: '@hypermemetic-ai\/qq-core'/);
assert.match(patch, /inject: \[qq-core, webServer\]/);
assert.doesNotMatch(patch, /- id: qq\n|name: '@hypermemetic-ai\/qq'|inject: \[qq, webServer\]/);
assert.doesNotMatch(patch, /qq-tasks|dsh-relay|dsh-dictation/);
assert.match(read("systemd/user/qq.service"), /WorkingDirectory=%h\/projects\/qq-core/);
assert.match(read("systemd/user/qq.service"), /ExecStart=%h\/projects\/qq-core\/bin\/qq/);

const scratch = mkdtempSync(join(tmpdir(), "qq-core-catalog-"));
try {
  for (const name of ["deciq", "deciq-logic", "qq-core", "qq-ui", "qq-relay", "image-finder"]) {
    mkdirSync(join(scratch, name));
  }
  const projects = listProjectCatalog(scratch, {
    projects: [{
      name: "deciq",
      label: "deciq",
      folders: [
        { name: "core", path: "deciq" },
        { name: "logic", path: "deciq-logic" },
      ],
    }],
  });
  assert.deepEqual(projects.map(({ name }) => name), ["deciq", "image-finder", "qq-core", "qq-relay", "qq-ui"]);
  const grouped = projects.find(({ name }) => name === "deciq");
  assert.equal(grouped.grouped, true);
  assert.equal(grouped.folders.length, 2);
  for (const name of ["image-finder", "qq-core", "qq-relay", "qq-ui"]) {
    const project = projects.find((candidate) => candidate.name === name);
    assert.equal(project.grouped, false);
    assert.equal(project.cwd, realpathSync(join(scratch, name)));
    assert.equal(project.folders[0].cwd, project.cwd);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log("qq-core repository geometry: ok");
