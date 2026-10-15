#!/usr/bin/env node
// Convex CLI against your production deployment (convexDeployment, tooling/instance.mjs), with the
// deploy key from ~/.config/xlr8/convex-deploy-key (override the path with
// XLR8_CONVEX_DEPLOY_KEY_FILE). The key is never printed. A key for any other deployment is refused.
//
// Usage:  node tooling/cloud.mjs <convex arguments…>
//   e.g.  node tooling/cloud.mjs env list
//         node tooling/cloud.mjs deploy
//
// The CLI runs with its own HOME, so it does not see other Convex logins from ~/.convex, and
// without the local variables from backend/.env.local.

import { spawn } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireInstance } from './instance.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = join(root, 'backend');
const keyFile = process.env.XLR8_CONVEX_DEPLOY_KEY_FILE || join(homedir(), '.config', 'xlr8', 'convex-deploy-key');

/** Name of the production deployment (exits with a hint if it is not configured). */
export function prodDeployment() {
  return requireInstance(['convexDeployment']).convexDeployment;
}

function deployKey() {
  const expected = prodDeployment();
  // One handle for check and read: the file cannot be swapped in between.
  const fd = openSync(keyFile, 'r');
  let key;
  try {
    const mode = fstatSync(fd).mode & 0o777;
    if (mode & 0o077) {
      console.error(`Aborted: ${keyFile} is readable by others (mode ${mode.toString(8)}). Run: chmod 600 ${keyFile}`);
      process.exit(2);
    }
    key = readFileSync(fd, 'utf8').trim();
  } finally {
    closeSync(fd);
  }
  const name = /^prod:([a-z0-9-]+)\|/.exec(key)?.[1];
  if (name !== expected) {
    console.error(`Aborted: the key does not belong to the production deployment ${expected}.`);
    process.exit(2);
  }
  return key;
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
