#!/usr/bin/env node
// Runs Selfbound entirely locally, without an account and without the cloud:
//   1. local Convex (anonymous) for backend/ on 127.0.0.1:<port> (default 13410, HTTP actions <port+1>)
//   2. local test sign-in (tooling/dev-auth.mjs) and test switches
//   3. optionally synthetic test data (--seed small|large)
//   4. optionally the app: --app dev (Vite dev server 5412) or --app preview (production build 5402)
//
// Usage:  node tooling/local.mjs [--port 13410] [--seed small|large] [--app dev|preview|none] [--reset]
//         [--dir <backend folder>] [--no-env] [--pid-file <file>] [--app-url <url>]
// Stop with Ctrl+C. With --no-wait the script exits after setup and the backend keeps running
// (for tests; stop it via the printed process group or --pid-file).
//
// --dir: separate folder for a second, independent backend (e.g. e2e/.backend for the Playwright
//        tests). It is created and symlinks backend/convex etc.; data and .env.local are separate.
// --no-env: do not write app/.env.local (the tests pass URL and token via the environment).
// --app-url: app address for the OAuth consent page (XLR8_APP_URL; enables connectors).
//            Default: Vite dev server or preview, depending on --app (otherwise 5412).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}
const flag = (name) => argv.includes(`--${name}`);
const backendDir = opt('dir', 'backend');
if (backendDir !== 'backend') {
  // Second instance: own folder with links to the code, own data.
  const target = join(root, backendDir);
  mkdirSync(target, { recursive: true });
  for (const entry of ['convex', 'node_modules', 'package.json', 'tsconfig.json', 'scripts', 'data']) {
    const link = join(target, entry);
    if (!existsSync(link)) symlinkSync(relative(target, join(root, 'backend', entry)), link);
  }
}
process.env.XLR8_BACKEND_DIR = backendDir;
const { runConvex } = await import('./convex.mjs');
const { DEV_OWNER_ID, devJwksDataUri, devToken } = await import('./dev-auth.mjs');
const port = Number(opt('port', process.env.XLR8_CONVEX_PORT ?? '13410'));
const sitePort = port + 1;
const seedSet = opt('seed', 'none');
const appMode = opt('app', 'none');
const appUrl = opt('app-url', `http://127.0.0.1:${appMode === 'preview' ? 5402 : 5412}`);
const children = [];

const log = (msg) => console.log(`\x1b[36m▸\x1b[0m ${msg}`);

async function reachable(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

async function waitFor(check, label, timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${label} did not come up (${timeoutMs / 1000} s)`);
}

function stopAll() {
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopAll();
    process.exit(0);
  });
}

// Transient errors of a freshly started backend (503, OCC conflict, connection) are retried a
// few times; anything else aborts immediately.
async function convexSync(args) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await convexSyncOnce(args);
    } catch (error) {
      const text = String(error?.message ?? error);
      if (attempt >= 5 || !/503|OptimisticConcurrency|ECONNREFUSED|ECONNRESET|fetch failed/i.test(text)) throw error;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

function convexSyncOnce(args) {
  return new Promise((resolve, reject) => {
    let out = '';
    const child = runConvex(args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`convex ${args.join(' ')}: ${out}`))));
  });
}

export function localUrl() {
  return `http://127.0.0.1:${port}`;
}

async function main() {
  const url = localUrl();
  if (await reachable(`${url}/version`)) {
    log(`Convex is already running on ${url}.`);
  } else {
    log(`Starting local Convex (anonymous) on ${url} …`);
    const convex = runConvex(
      ['dev', '--local-cloud-port', String(port), '--local-site-port', String(sitePort), '--tail-logs', 'disable'],
      {
        // In background mode write to a log file, otherwise the backend keeps the output open.
        stdio: flag('no-wait')
          ? ['ignore', openSync(join(root, backendDir, '.convex-local.log'), 'a'), openSync(join(root, backendDir, '.convex-local.log'), 'a')]
          : ['ignore', 'inherit', 'inherit'],
        detached: true,
      },
    );
    children.push(convex);
    const pidFile = opt('pid-file', null);
    if (pidFile) writeFileSync(pidFile, String(convex.pid));
    await waitFor(() => reachable(`${url}/version`), 'Convex');
  }
  const envFile = join(root, backendDir, '.env.local');
  await waitFor(async () => existsSync(envFile) && /^CONVEX_URL=/m.test(readFileSync(envFile, 'utf8')), '.env.local');

  // Environment variables for the local backend only.
  const wanted = {
    XLR8_DEV_JWKS: devJwksDataUri(),
    CLERK_JWT_ISSUER_DOMAIN: 'none',
    XLR8_OWNER_IDS: DEV_OWNER_ID,
    XLR8_ALLOW_SEED: '1',
    XLR8_TEST_SWITCHES: '1',
    XLR8_APP_URL: appUrl,
  };
  const current = await convexSync(['env', 'list']);
  let changed = false;
  for (const [key, value] of Object.entries(wanted)) {
    if (!current.includes(`${key}=${value}`)) {
      await convexSync(['env', 'set', key, value]);
      changed = true;
    }
  }
  const { ConvexHttpClient } = await import('convex/browser');
  const { api } = await import('../backend/convex/_generated/api.js');
  const token = devToken();
  const client = new ConvexHttpClient(url);
  client.setAuth(token);
  if (changed) {
    // auth.config.ts is evaluated on upload: trigger a new upload.
    const authFile = join(root, backendDir, 'convex', 'auth.config.ts');
    const now = new Date();
    utimesSync(authFile, now, now);
  }
  await waitFor(async () => {
    try {
      await client.query(api.health.whoami, {});
      return true;
    } catch {
      return false;
    }
  }, 'Sign-in to the local backend');
  log('Local sign-in works.');
  // An existing backend may still run old code until the CLI has uploaded the new one.
  // Continue only once the current functions exist.
  await waitFor(async () => {
    try {
      await client.query(api.meta.counter, {});
      if (seedSet !== 'none') await client.query(api.seed.status, {});
      return true;
    } catch {
      return false;
    }
  }, 'Current backend functions');

  if (!flag('no-env')) {
    writeFileSync(
      join(root, 'app', '.env.local'),
      `# Written by tooling/local.mjs. Local only.\nVITE_CONVEX_URL=${url}\nVITE_DEV_TOKEN=${token}\n`,
    );
  }

  if (seedSet !== 'none') {
    log(`Seeding test data "${seedSet}" …`);
    const { seedLocal } = await import('../backend/scripts/seed.ts');
    await seedLocal(client, seedSet, { force: flag('reset') });
  }

  if (appMode === 'dev' || appMode === 'preview') {
    if (appMode === 'preview') {
      log('Building the app …');
      const r = spawnSync('pnpm', ['--filter', '@selfbound/app', 'build'], { cwd: root, stdio: 'inherit' });
      if (r.status !== 0) throw new Error('Build failed');
    }
    const appPort = appMode === 'dev' ? 5412 : 5402;
    if (!(await reachable(`http://127.0.0.1:${appPort}/`))) {
      const child = spawn('pnpm', ['--filter', '@selfbound/app', appMode], { cwd: root, stdio: 'ignore', detached: true });
      child.unref();
      children.push(child);
      await waitFor(() => reachable(`http://127.0.0.1:${appPort}/`), 'App');
    }
    log(`App: http://127.0.0.1:${appPort}/`);
  }

  if (flag('no-wait')) {
    for (const child of children) child.unref();
    log(`Keeps running in the background. Stop: kill -- -${children.map((c) => c.pid).join(' -')}`);
    process.exit(0);
  }
  if (children.length === 0) return;
  log('Stop with Ctrl+C.');
  await new Promise(() => {});
}

main().catch((error) => {
  console.error(error);
  stopAll();
  process.exit(1);
});
