#!/usr/bin/env node
// Runs the Convex CLI only against an anonymous local backend.
//
// Otherwise the CLI reads the cloud token from ~/.convex/config.json and sends it along with
// requests to Convex, even in anonymous mode. So every Convex process gets its own HOME in
// <backend dir>/.convex-home, which has no token. Only the downloaded backend binaries are linked.
//
// Usage: node tooling/convex.mjs <convex arguments…>
//   other backend directory: SELFBOUND_BACKEND_DIR=e2e/.backend node tooling/convex.mjs …
//   e.g. node tooling/convex.mjs dev --local-cloud-port 13410 --local-site-port 13411

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, symlinkSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envVar } from './lib/env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// SELFBOUND_BACKEND_DIR selects the backend directory (default backend/).
const backendDir = resolve(root, envVar('BACKEND_DIR') ?? 'backend');
const realHome = homedir();
const fakeHome = join(backendDir, '.convex-home');
const tokenFile = join(realHome, '.convex', 'config.json');

function hashOf(file) {
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'missing';
}

function linkCache(name) {
  const source = join(realHome, '.cache', 'convex', name);
  const target = join(fakeHome, '.cache', 'convex', name);
  if (!existsSync(source)) return;
  try {
    lstatSync(target);
  } catch {
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(source, target);
  }
}

// Guard: .env.local may only point to an anonymous or local deployment.
export function assertLocalDeployment() {
  const envFile = join(backendDir, '.env.local');
  if (!existsSync(envFile)) return;
  const line = readFileSync(envFile, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('CONVEX_DEPLOYMENT='));
  if (!line) return;
  const value = line.slice('CONVEX_DEPLOYMENT='.length).split('#')[0].trim();
  if (!/^(anonymous|local):/.test(value)) {
    console.error(`Aborted: ${envFile} points to "${value}". Only anonymous:… or local:… are allowed.`);
    process.exit(2);
  }
}

export function convexEnv() {
  mkdirSync(fakeHome, { recursive: true });
  linkCache('binaries');
  mkdirSync(join(fakeHome, 'tmp'), { recursive: true });
  const env = {
    ...process.env,
    HOME: fakeHome,
    CONVEX_TMPDIR: join(fakeHome, 'tmp'),
    CONVEX_AGENT_MODE: 'anonymous',
  };
  for (const key of Object.keys(env)) {
    if (
      key === 'CONVEX_DEPLOYMENT' ||
      key === 'CONVEX_DEPLOY_KEY' ||
      key === 'CONVEX_OVERRIDE_ACCESS_TOKEN' ||
      key.startsWith('CONVEX_SELF_HOSTED_')
    ) {
      delete env[key];
    }
  }
  return env;
}

export function runConvex(args, options = {}) {
  assertLocalDeployment();
  const before = hashOf(tokenFile);
  const child = spawn(join(backendDir, 'node_modules', '.bin', 'convex'), args, {
    cwd: backendDir,
    env: convexEnv(),
    stdio: options.stdio ?? 'inherit',
    // Own process group: so the backend and the CLI can be stopped reliably.
    detached: options.detached ?? false,
  });
  child.on('exit', () => {
    if (hashOf(tokenFile) !== before) {
      console.error('Warning: ~/.convex/config.json changed during the run.');
    }
  });
  return child;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const child = runConvex(process.argv.slice(2));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code) => process.exit(code ?? 0));
}
