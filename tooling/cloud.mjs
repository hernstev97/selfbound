#!/usr/bin/env node
// Convex CLI against your production deployment (convexDeployment, tooling/instance.mjs), with the
// deploy key from ~/.config/selfbound/convex-deploy-key (override the path with
// SELFBOUND_CONVEX_DEPLOY_KEY_FILE). The key is never printed. A key for any other deployment is refused.
//
// Usage:  node tooling/cloud.mjs <convex arguments…>
//   e.g.  node tooling/cloud.mjs env list
//         node tooling/cloud.mjs deploy
//
// The CLI runs with its own HOME, so it does not see other Convex logins from ~/.convex, and
// without the local variables from backend/.env.local.

import { spawn } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireInstance } from './instance.mjs';
import { configFile, envVar } from './lib/env.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = join(root, 'backend');
/** Path of the production deploy key file. */
export const deployKeyFile = (env = process.env) => envVar('CONVEX_DEPLOY_KEY_FILE', env) || configFile('convex-deploy-key', { env });

/** Name of the production deployment (exits with a hint if it is not configured). */
export function prodDeployment() {
  return requireInstance(['convexDeployment']).convexDeployment;
}

/**
 * Reads the deploy key and checks it: the file is not readable by others and the key belongs to the
 * production deployment `expected`. Returns `{ key }` or `{ problem, message }`; never prints the key.
 * @returns {{ key: string } | { problem: 'missing' | 'open' | 'mismatch', message: string }}
 */
export function readDeployKey(keyFile, expected) {
  // One handle for check and read: the file cannot be swapped in between.
  let fd;
  try {
    fd = openSync(keyFile, 'r');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { problem: 'missing', message: `No deploy key at ${keyFile}. Create a production deploy key in the Convex dashboard and save it there with mode 600 (docs/self-hosting.md, section "2. Convex"), or point SELFBOUND_CONVEX_DEPLOY_KEY_FILE to it.` };
  }
  let key;
  try {
    const mode = fstatSync(fd).mode & 0o777;
    if (mode & 0o077) return { problem: 'open', message: `${keyFile} is readable by others (mode ${mode.toString(8)}). Run: chmod 600 ${keyFile}` };
    key = readFileSync(fd, 'utf8').trim();
  } finally {
    closeSync(fd);
  }
  if (deployKeyDeployment(key) !== expected) return { problem: 'mismatch', message: `The key in ${keyFile} does not belong to the production deployment ${expected}.` };
  return { key };
}

/** Deployment name of a production deploy key ("prod:<name>|…"), else undefined. */
export const deployKeyDeployment = (key) => /^prod:([a-z0-9-]+)\|./.exec(key)?.[1];

function deployKey() {
  const result = readDeployKey(deployKeyFile(), prodDeployment());
  if ('key' in result) return result.key;
  console.error(`Aborted: ${result.message}`);
  process.exit(2);
}

export function runCloud(args, options = {}) {
  const home = join(backendDir, '.convex-cloud-home');
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, CONVEX_DEPLOY_KEY: deployKey() };
  for (const key of Object.keys(env)) {
    if (key === 'CONVEX_DEPLOYMENT' || key === 'CONVEX_URL' || key.startsWith('CONVEX_SELF_HOSTED_')) delete env[key];
  }
  return spawn(join(backendDir, 'node_modules', '.bin', 'convex'), args, {
    cwd: backendDir,
    env,
    stdio: options.stdio ?? 'inherit',
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const child = runCloud(process.argv.slice(2));
  child.on('exit', (code) => process.exit(code ?? 0));
}
