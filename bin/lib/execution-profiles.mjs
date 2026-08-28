import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { ROLE_NAMES } from "./roles.mjs";

export const POLICY_SCHEMA = "qq.execution-profiles/v1";
export const PROFILE_LIST_SCHEMA = "qq.profile-list/v1";
export const CONTEXT_WINDOW_CEILING = 200_000;
export const SERVICE_NAMES = Object.freeze(["scribe", "qa"]);
export const GROK_PROVIDERS = new Set(["xai-auth"]);
export const EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const EFFORT_ORDER = Object.freeze([...EFFORTS]);
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const BINDING = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/;

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

export function configHome(env = process.env) {
  if (env.XDG_CONFIG_HOME) {
    if (!isAbsolute(env.XDG_CONFIG_HOME)) throw new Error("XDG_CONFIG_HOME must be absolute");
    return resolve(env.XDG_CONFIG_HOME);
  }
  const home = env.HOME || homedir();
  if (!isAbsolute(home)) throw new Error("HOME must be absolute");
  return join(resolve(home), ".config");
}

export function executionProfilesPath(env = process.env) {
  return join(configHome(env), "qq", "execution-profiles.json");
}

export function agentModelsPath(env = process.env) {
  const root = env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), ".pi", "agent");
  if (!isAbsolute(root)) throw new Error("PI_CODING_AGENT_DIR must be absolute");
  return join(resolve(root), "models.json");
}

function validateProfile(value, label) {
  if (!exactKeys(value, ["provider", "model", "effort"])) throw new Error(`${label} must contain exactly provider, model, and effort`);
  if (typeof value.provider !== "string" || !BINDING.test(value.provider)) throw new Error(`${label}.provider is malformed`);
  if (value.provider === "xai") throw new Error(`${label}.provider xai is disabled; use xai-auth`);
  if (typeof value.model !== "string" || !BINDING.test(value.model)) throw new Error(`${label}.model is malformed`);
  if (typeof value.effort !== "string" || !EFFORTS.has(value.effort)) throw new Error(`${label}.effort is unsupported`);
  return Object.freeze({ provider: value.provider, model: value.model, effort: value.effort });
}

export function validateExecutionPolicy(value) {
  if (!exactKeys(value, ["schema", "contextWindowCeiling", "roles", ...SERVICE_NAMES])) throw new Error("execution-profile policy has an invalid top-level shape");
  if (value.schema !== POLICY_SCHEMA) throw new Error(`execution-profile policy schema must be ${POLICY_SCHEMA}`);
  if (value.contextWindowCeiling !== CONTEXT_WINDOW_CEILING) throw new Error(`contextWindowCeiling must be ${CONTEXT_WINDOW_CEILING}`);
  if (value.roles === null || typeof value.roles !== "object" || Array.isArray(value.roles)
    || JSON.stringify(Object.keys(value.roles).sort()) !== JSON.stringify([...ROLE_NAMES].sort())) {
    throw new Error(`execution-profile policy role map must contain exactly: ${ROLE_NAMES.join(", ")}`);
  }
  const roles = {};
  for (const [roleName, role] of Object.entries(value.roles)) {
    if (!NAME.test(roleName)) throw new Error(`execution-profile role name is malformed: ${roleName}`);
    if (!exactKeys(role, ["default", "profiles"])) throw new Error(`execution-profile role ${roleName} has an invalid shape`);
    if (typeof role.default !== "string" || !NAME.test(role.default)) throw new Error(`execution-profile role ${roleName} has an invalid default`);
    if (role.profiles === null || typeof role.profiles !== "object" || Array.isArray(role.profiles) || Object.keys(role.profiles).length === 0) {
      throw new Error(`execution-profile role ${roleName} must contain profiles`);
    }
    const profiles = {};
    for (const [profileName, profile] of Object.entries(role.profiles)) {
      if (!NAME.test(profileName)) throw new Error(`execution-profile name is malformed: ${profileName}`);
      profiles[profileName] = validateProfile(profile, `${roleName}.${profileName}`);
    }
    if (!profiles[role.default]) throw new Error(`execution-profile role ${roleName} default does not name a profile`);
    roles[roleName] = Object.freeze({ default: role.default, profiles: Object.freeze(profiles) });
  }
  return Object.freeze({
    schema: POLICY_SCHEMA,
    contextWindowCeiling: CONTEXT_WINDOW_CEILING,
    roles: Object.freeze(roles),
    scribe: validateProfile(value.scribe, "scribe"),
    qa: validateProfile(value.qa, "qa"),
  });
}

async function safeRegularFile(path, label, options = {}) {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (options.optional && error?.code === "ENOENT") return undefined;
    throw new Error(`${label} is unavailable at ${path}`);
  }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o022) !== 0) {
    throw new Error(`${label} is unsafe at ${path}`);
  }
  return readFile(path, "utf8");
}

export async function readExecutionPolicy(path = executionProfilesPath()) {
  const source = await safeRegularFile(path, "execution-profile policy");
  let value;
  try { value = JSON.parse(source); }
  catch { throw new Error(`execution-profile policy is malformed at ${path}`); }
  let migrated = false;
  if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "openwiki")) {
    delete value.openwiki;
    migrated = true;
  }
  if (exactKeys(value, ["schema", "contextWindowCeiling", "roles", "compactor", "qa"])) {
    value.scribe = value.compactor;
    delete value.compactor;
    migrated = true;
  }
  if (migrated) await writeExecutionPolicy(value, path);
  return validateExecutionPolicy(value);
}

async function atomicPrivateWrite(path, source) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(source, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function writeExecutionPolicy(value, path = executionProfilesPath()) {
  const policy = validateExecutionPolicy(value);
  await atomicPrivateWrite(path, `${JSON.stringify(policy, null, 2)}\n`);
  return policy;
}

export async function updateRoleDefault(roleName, profileName, path = executionProfilesPath()) {
  const policy = await readExecutionPolicy(path);
  const role = policy.roles[roleName];
  if (!role) throw new Error(`unknown execution-profile role: ${roleName}`);
  if (!role.profiles[profileName]) throw new Error(`unknown ${roleName} execution profile: ${profileName}`);
  const next = JSON.parse(JSON.stringify(policy));
  const previous = next.roles[roleName].default;
  next.roles[roleName].default = profileName;
  await writeExecutionPolicy(next, path);
  return { previous, current: profileName };
}

export function listedProfiles(role) {
  return Object.entries(role.profiles).sort(([leftName, left], [rightName, right]) => {
    const byModel = left.model.localeCompare(right.model);
    if (byModel) return byModel;
    const byEffort = EFFORT_ORDER.indexOf(left.effort) - EFFORT_ORDER.indexOf(right.effort);
    if (byEffort) return byEffort;
    return leftName.localeCompare(rightName);
  });
}

function listedProfile(name, profile) {
  return { name, provider: profile.provider, model: profile.model, effort: profile.effort };
}

export function profileListDocument(policy, roleName) {
  const roleNames = roleName === undefined ? ROLE_NAMES : [roleName];
  const roles = [];
  const services = [];
  for (const name of roleNames) {
    if (SERVICE_NAMES.includes(name)) {
      services.push(listedProfile(name, policy[name]));
      continue;
    }
    const role = policy.roles[name];
    if (!role) throw new Error(`unknown execution-profile role: ${name}`);
    roles.push({
      name,
      default: role.default,
      profiles: listedProfiles(role).map(([profileName, profile]) => listedProfile(profileName, profile)),
    });
  }
  if (roleName === undefined) {
    for (const name of SERVICE_NAMES) services.push(listedProfile(name, policy[name]));
  }
  return { schema: PROFILE_LIST_SCHEMA, roles, services };
}

export function profileFor(policy, roleName, profileName) {
  const role = policy.roles[roleName];
  if (!role) throw new Error(`unknown execution-profile role: ${roleName}`);
  const selected = profileName || role.default;
  const profile = role.profiles[selected];
  if (!profile) throw new Error(`unknown ${roleName} execution profile: ${selected}`);
  return { name: selected, profile, isDefault: selected === role.default };
}

export function uniqueBindings(policy) {
  const found = new Map();
  const add = (profile) => {
    found.set(`${profile.provider}\0${profile.model}`, { provider: profile.provider, model: profile.model });
  };
  for (const role of Object.values(policy.roles)) {
    for (const profile of Object.values(role.profiles)) add(profile);
  }
  for (const name of SERVICE_NAMES) add(policy[name]);
  return [...found.values()];
}

export function parseTokenCount(value) {
  const match = /^([0-9]+(?:\.[0-9]+)?)(K|M)?$/.exec(value);
  if (!match) return undefined;
  const multiplier = match[2] === "M" ? 1_000_000 : match[2] === "K" ? 1_000 : 1;
  return Math.round(Number(match[1]) * multiplier);
}

export function parseModelList(source) {
  const models = new Map();
  for (const line of source.split("\n").slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 3) continue;
    const contextWindow = parseTokenCount(columns[2]);
    if (!contextWindow) continue;
    models.set(`${columns[0]}\0${columns[1]}`, { provider: columns[0], model: columns[1], contextWindow });
  }
  return models;
}

export function contextWindowCeilingFor(policy, provider) {
  return GROK_PROVIDERS.has(provider) ? policy.contextWindowCeiling : undefined;
}

export async function installContextCeiling(policy, availableModels, path = agentModelsPath()) {
  let document = { providers: {} };
  const source = await safeRegularFile(path, "Pi models configuration", { optional: true });
  if (source !== undefined) {
    try { document = JSON.parse(source); }
    catch { throw new Error(`Pi models configuration is malformed at ${path}`); }
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) throw new Error(`Pi models configuration has an invalid shape at ${path}`);
  if (document.providers === undefined) document.providers = {};
  if (document.providers === null || typeof document.providers !== "object" || Array.isArray(document.providers)) throw new Error(`Pi models configuration providers are malformed at ${path}`);

  const changed = [];
  for (const binding of uniqueBindings(policy)) {
    const key = `${binding.provider}\0${binding.model}`;
    const available = availableModels.get(key);
    if (!available) throw new Error(`profile model is unavailable: ${binding.provider}/${binding.model}`);
    const ceiling = contextWindowCeilingFor(policy, binding.provider);
    if (ceiling !== undefined) {
      if (available.contextWindow <= ceiling) continue;
      const provider = document.providers[binding.provider] ??= {};
      if (provider === null || typeof provider !== "object" || Array.isArray(provider)) throw new Error(`Pi provider configuration is malformed: ${binding.provider}`);
      const overrides = provider.modelOverrides ??= {};
      if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) throw new Error(`Pi modelOverrides is malformed: ${binding.provider}`);
      const override = overrides[binding.model] ??= {};
      if (override === null || typeof override !== "object" || Array.isArray(override)) throw new Error(`Pi model override is malformed: ${binding.provider}/${binding.model}`);
      if (override.contextWindow !== ceiling) {
        override.contextWindow = ceiling;
        changed.push(`${binding.provider}/${binding.model}`);
      }
      continue;
    }

    const provider = document.providers[binding.provider];
    if (provider === undefined) continue;
    if (provider === null || typeof provider !== "object" || Array.isArray(provider)) throw new Error(`Pi provider configuration is malformed: ${binding.provider}`);
    const overrides = provider.modelOverrides;
    if (overrides === undefined) continue;
    if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) throw new Error(`Pi modelOverrides is malformed: ${binding.provider}`);
    const override = overrides[binding.model];
    if (override === undefined) continue;
    if (override === null || typeof override !== "object" || Array.isArray(override)) throw new Error(`Pi model override is malformed: ${binding.provider}/${binding.model}`);
    if (!("contextWindow" in override)) continue;
    delete override.contextWindow;
    if (Object.keys(override).length === 0) delete overrides[binding.model];
    if (Object.keys(overrides).length === 0) delete provider.modelOverrides;
    if (Object.keys(provider).length === 0) delete document.providers[binding.provider];
    changed.push(`${binding.provider}/${binding.model}`);
  }
  if (changed.length) await atomicPrivateWrite(path, `${JSON.stringify(document, null, 2)}\n`);
  return changed;
}
