import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
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
assert.deepEqual(
  catalog.projects.find(({ name }) => name === "qq-index"),
  {
    name: "qq-index",
    label: "qq-index",
    folders: [{ name: "qq-index", label: "qq-index", path: "qq-index" }],
  },
  "index project and chair must use the canonical repository path",
);
for (const retired of ["tasks", "dsh-relay", "dsh-dictation"]) {
  assert.equal(catalogText.includes(retired), false, `catalog still contains ${retired}`);
}

const launcher = read("bin/qq");
for (const sibling of ["qq-ui", "qq-index", "qq-dashboard", "qq-workflows", "qq-models", "qq-relay", "qq-dictation"]) {
  assert.match(launcher, new RegExp(`add_named_sibling ${sibling.replace("-", "\\-")}`));
}
assert.match(
  launcher,
  /add_named_sibling qq-index '@hypermemetic-ai\/qq-index' QQ_DSH_HAVE_INDEX/,
);
assert.match(launcher, /export .*QQ_DSH_HAVE_INDEX=0/);
assert.match(
  launcher,
  /add_named_sibling qq-dashboard '@hypermemetic-ai\/qq-dashboard' QQ_DSH_HAVE_DASHBOARD/,
);
assert.match(launcher, /export .*QQ_DSH_HAVE_DASHBOARD=0/);
assert.equal(launcher.match(/add_named_sibling qq-index/g)?.length, 1);
assert.equal(launcher.match(/add_named_sibling qq-dashboard/g)?.length, 1);
const managedPackages = launcher.slice(launcher.indexOf("const managed = new Set(["));
assert.match(managedPackages, /"@hypermemetic-ai\/qq-index"/);
assert.match(managedPackages, /"@hypermemetic-ai\/qq-dashboard"/);
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
assert.match(
  patch,
  /- id: qq-index\n\s+name: '@hypermemetic-ai\/qq-index'\n\s+disabled: !!js process\.env\.QQ_DSH_HAVE_INDEX !== '1'/,
);
assert.match(
  patch,
  /- id: qq-dashboard\n\s+name: '@hypermemetic-ai\/qq-dashboard'\n\s+disabled: !!js process\.env\.QQ_DSH_HAVE_DASHBOARD !== '1'\n\s+inject: \[qq-core\]/,
);
const hostOrder = ["qq-core", "qq-index", "qq-workflows", "qq-dashboard", "qq-ui"]
  .map((id) => patch.indexOf(`    - id: ${id}`));
assert.ok(
  hostOrder.every((offset, index) => offset >= 0 && (index === 0 || hostOrder[index - 1] < offset)),
  "host order must be core -> index -> workflows -> dashboard -> ui",
);
assert.doesNotMatch(patch, /- id: qq\n|name: '@hypermemetic-ai\/qq'|inject: \[qq, webServer\]/);
assert.doesNotMatch(patch, /qq-tasks|dsh-relay|dsh-dictation/);
assert.match(read("systemd/user/qq.service"), /WorkingDirectory=%h\/projects\/qq-core/);
assert.match(read("systemd/user/qq.service"), /ExecStart=%h\/projects\/qq-core\/bin\/qq/);
const readme = read("README.md");
assert.match(readme, /`@hypermemetic-ai\/qq-index`/);
assert.match(readme, /`QQ_DSH_HAVE_INDEX`.*optional `qq-index` plugin/);
assert.match(readme, /canonical sibling checkout `qq-index` only when its package identity is exactly/);
assert.match(readme, /package main `src\/plugin\.mjs` provides only the `qq-index` service with\n`\{ loadIndex, validateIndex \}`/);
assert.match(readme, /`@hypermemetic-ai\/qq-dashboard`/);
assert.match(readme, /`QQ_DSH_HAVE_DASHBOARD` gates the optional\n`qq-dashboard` plugin/);
assert.match(readme, /`src\/plugin\.mjs` requires `qq-core` and provides\nthe canonical `qq-dashboard` service/);
assert.match(readme, /Neither sibling has a compatibility alias/);
for (const source of readdirSync(join(packageRoot, "src")).filter((name) => name.endsWith(".mjs"))) {
  assert.doesNotMatch(
    read(`src/${source}`),
    /@hypermemetic-ai\/(?:qq-index|qq-dashboard)/,
  );
}

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
