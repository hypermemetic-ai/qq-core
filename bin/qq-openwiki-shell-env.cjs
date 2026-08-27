"use strict";

const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");

const originalSpawn = childProcess.spawn;
const SAFE_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];

childProcess.spawn = function spawnWithSafeOpenWikiEnv(command, args, options) {
  const argsAreArray = Array.isArray(args);
  const spawnOptions = argsAreArray ? options : args;
  if (spawnOptions?.shell === true && spawnOptions.env && Object.keys(spawnOptions.env).length === 0) {
    const env = {};
    for (const key of SAFE_ENV_KEYS) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const replacement = { ...spawnOptions, env };
    return argsAreArray
      ? originalSpawn.call(this, command, args, replacement)
      : originalSpawn.call(this, command, replacement);
  }
  return originalSpawn.apply(this, arguments);
};

syncBuiltinESMExports();
