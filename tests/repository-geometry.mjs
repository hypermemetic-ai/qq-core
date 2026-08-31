import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listCatalogWorkspaceIds, listProjectCatalog, listRegisteredProjectCatalog } from "../src/session.mjs";

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
assert.match(plugin, /ctx\.inject\(\["sessionQuery", "qq-session-index", "tools", "skills"\]/);
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
assert.match(patch, /- id: session-query-sqlite[\s\S]*?openAt: first-search/);
assert.doesNotMatch(patch, /openAt: never/);
assert.match(patch, /enabled: !!js process\.env\.QQ_DSH_HAVE_INDEX === '1' && !!process\.env\.XDG_RUNTIME_DIR/);
assert.match(patch, /qq-index\/session-index\.sock/);
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
assert.match(readme, /`QQ_DSH_HAVE_INDEX` gates the optional `qq-index` plugin/);
assert.match(readme, /canonical sibling checkout `qq-index` only when its package/);
assert.match(readme, /provides the independent\n`qq-session-index` capability/);
assert.match(readme, /deriveWorkspaceScopeToken/);
assert.match(readme, /verifyDshSearchCandidates/);
assert.match(readme, /\$\{XDG_RUNTIME_DIR\}\/qq-index\/session-index\.sock/);
assert.match(readme, /there is no FTS fallback/);
assert.match(readme, /at most 16 authorization scope/);
for (const source of readdirSync(join(packageRoot, "src")).filter((name) => name.endsWith(".mjs"))) {
  assert.doesNotMatch(
    read(`src/${source}`),
    /@hypermemetic-ai\/(?:qq-index|qq-dashboard)/,
  );
}
const historySource = read("src/session-history.mjs");
assert.doesNotMatch(historySource, /searchSessions/);
assert.match(historySource, /search-batch-v1/);
assert.match(historySource, /verifyDshSearchCandidates/);
assert.match(historySource, /listAuthorizedWorkspaceIds: qq\?\.listAuthorizedWorkspaceIds/);
assert.doesNotMatch(historySource, /qq\?\.listProjects/);

const scratch = mkdtempSync(join(tmpdir(), "qq-core-catalog-"));
try {
  const discoveredNames = [
    "qq-core", "qq-ui", "qq-relay", "image-finder",
    ...Array.from({ length: 13 }, (_, index) => `uncatalogued-${index}`),
  ];
  for (const name of ["deciq", "deciq-logic", ...discoveredNames]) {
    mkdirSync(join(scratch, name));
  }
  const registration = {
    projects: [{
      name: "deciq",
      label: "deciq",
      folders: [
        { name: "core", path: "deciq" },
        { name: "logic", path: "deciq-logic" },
      ],
    }],
  };
  const projects = listProjectCatalog(scratch, registration);
  assert.equal(projects.length, 18, "project listing must retain immediate-child discovery");
  assert.deepEqual(
    projects.map(({ name }) => name),
    ["deciq", ...discoveredNames].sort(),
  );
  const registered = listRegisteredProjectCatalog(scratch, registration);
  assert.deepEqual(registered.map(({ name }) => name), ["deciq"]);
  assert.deepEqual(
    registered[0].folders.map(({ cwd }) => cwd),
    [realpathSync(join(scratch, "deciq")), realpathSync(join(scratch, "deciq-logic"))],
  );
  assert.deepEqual(
    listCatalogWorkspaceIds(scratch, registration),
    [
      realpathSync(scratch),
      realpathSync(join(scratch, "deciq")),
      realpathSync(join(scratch, "deciq-logic")),
    ],
    "search authorization must exclude auto-discovered immediate children",
  );
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
