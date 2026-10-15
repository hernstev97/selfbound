// Names for the Selfbound tools: environment variables and the per-user directories.
// legacy-xlr8: the product used to be called XLR8; the old names are still read as a fallback (one warning per
// process and name, never the value) until a follow-up removes them. See tooling/migrate-legacy-names.mjs.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const warned = new Set();
const defaultWarn = (message) => console.warn(message);

/**
 * Like envVar(), with both full names. For variables that do not follow the SELFBOUND_/XLR8_ pattern (legacy-xlr8)
 * (VITE_SELFBOUND_TEST and friends). A defined (even empty) new name wins.
 */
export function envVarPair(name, legacyName, env = process.env, warn = defaultWarn) {
  const current = env[name];
  if (current !== undefined) return current;
  const legacy = env[legacyName];
  if (legacy !== undefined && !warned.has(legacyName)) {
    warned.add(legacyName);
    warn(`${legacyName} is deprecated, set ${name} instead.`);
  }
  return legacy;
}

/** SELFBOUND_<name>, else the old XLR8_<name> (legacy-xlr8, removed by a follow-up). Pass the name without prefix: envVar('OWNER_IDS'). */
export const envVar = (name, env = process.env, warn = defaultWarn) => envVarPair(`SELFBOUND_${name}`, `XLR8_${name}`, env, warn);

/** For tests: forget which warnings were already printed. */
export function resetEnvWarnings() {
  warned.clear();
  warnedDirs.clear();
}

// ---- Per-user directories -------------------------------------------------------------------------

const warnedDirs = new Set();

/**
 * Where a kind of per-user directory lives. `suffix` extends the app name (`-perf` gives selfbound-perf).
 * @param {'config'|'data'|'state'|'cache'} kind
 */
function xdgBase(kind, env, home) {
  const [variable, fallback] = {
    config: ['XDG_CONFIG_HOME', '.config'],
    data: ['XDG_DATA_HOME', join('.local', 'share')],
    state: ['XDG_STATE_HOME', join('.local', 'state')],
    cache: ['XDG_CACHE_HOME', '.cache'],
  }[kind];
  return env[variable] || join(home, fallback);
}

/** New and old directory of a kind, plus the one to use (the old one only if it alone exists). */
export function resolveDir(kind, { suffix = '', env = process.env, home = homedir(), exists = existsSync, warn = defaultWarn } = {}) {
  const base = xdgBase(kind, env, home);
  const current = join(base, `selfbound${suffix}`);
  // legacy-xlr8: the old directory is used while it is the only one that exists
  const legacy = join(base, `xlr8${suffix}`);
  if (exists(current) || !exists(legacy)) return current;
  if (!warnedDirs.has(legacy)) {
    warnedDirs.add(legacy);
    warn(`${legacy} is deprecated, move it to ${current} (node tooling/migrate-legacy-names.mjs).`);
  }
  return legacy;
}

export const configDir = (options) => resolveDir('config', options);
export const dataDir = (options) => resolveDir('data', options);
export const stateDir = (options) => resolveDir('state', options);
export const cacheDir = (options) => resolveDir('cache', options);

/**
 * A file in the config directory. Looks per file: the new directory wins, the old one is the fallback
 * for a file that only exists there (a half-migrated directory still works). Returns the new path if
 * neither exists, so errors and hints name the right place.
 */
export function configFile(name, { env = process.env, home = homedir(), exists = existsSync, warn = defaultWarn } = {}) {
  const base = xdgBase('config', env, home);
  const current = join(base, 'selfbound', name);
  // legacy-xlr8: the old directory is read for files that were not migrated yet
  const legacy = join(base, 'xlr8', name);
  if (exists(current) || !exists(legacy)) return current;
  if (!warnedDirs.has(legacy)) {
    warnedDirs.add(legacy);
    warn(`${legacy} is deprecated, move it to ${current} (node tooling/migrate-legacy-names.mjs).`);
  }
  return legacy;
}
