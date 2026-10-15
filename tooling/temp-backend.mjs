// Fresh, temporary local backend for integration tests (anonymous, no account).
//
// Like tooling/backup/verify-restore.mjs: a copy of backend/convex in a temporary folder,
// node_modules as a symlink, its own HOME (tooling/convex.mjs). So backend/.env.local and a
// running development backend stay untouched.
//
//   const backend = await startTempBackend({ port: 13490, env: { GITHUB_WEBHOOK_SECRET: '…' } });
//   … backend.url (port), backend.siteUrl (port+1, HTTP endpoints), backend.convex(['run', …])
//   await backend.stop();

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_OWNER_ID, devJwksDataUri, devToken } from './dev-auth.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const convexWrapper = join(root, 'tooling', 'convex.mjs');

async function reachable(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

async function waitFor(check, label, timeoutMs = 240_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${label}: timed out after ${timeoutMs / 1000} s`);
}

/**
 * Runs the Convex CLI for a backend directory (via tooling/convex.mjs, local only).
 * On a fresh start `env set` collides with the first function upload by `convex dev`
 * (503, OptimisticConcurrencyControlFailure, especially on slow CI runners): retry those.
 */
export async function convexCli(dir, args, options = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await convexCliOnce(dir, args, options);
    } catch (error) {
      const transient = args[0] === 'env' && /503|OptimisticConcurrency/i.test(String(error?.message ?? error));
      if (!transient || attempt >= 5) throw error;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

function convexCliOnce(dir, args, { input } = {}) {
  return new Promise((resolvePromise, reject) => {
    let out = '';
    const child = spawn(process.execPath, [convexWrapper, ...args], {
      env: { ...process.env, SELFBOUND_BACKEND_DIR: dir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.stdin.end(input ?? '');
    child.on('exit', (code) =>
      code === 0 ? resolvePromise(out) : reject(new Error(`convex ${args.join(' ')} (exit ${code}):\n${out}`)),
    );
  });
}

/**
 * Starts a fresh backend. Sets up the local sign-in (like tooling/local.mjs), test switches,
 * seeding permission and additional variables from `env`.
 */
export async function startTempBackend({ port, env = {}, log = () => {} }) {
  const url = `http://127.0.0.1:${port}`;
  const siteUrl = `http://127.0.0.1:${port + 1}`;
  if (await reachable(`${url}/version`)) throw new Error(`Port ${port} is in use; the test needs a fresh backend.`);
  const dir = mkdtempSync(join(tmpdir(), 'selfbound-test-backend-'));
  cpSync(join(root, 'backend', 'convex'), join(dir, 'convex'), { recursive: true });
  cpSync(join(root, 'backend', 'package.json'), join(dir, 'package.json'));
  symlinkSync(join(root, 'backend', 'node_modules'), join(dir, 'node_modules'), 'dir');
  writeFileSync(join(dir, 'README.txt'), 'Temporary backend for integration tests (tooling/temp-backend.mjs). Safe to delete.\n');
  const logFile = join(dir, 'convex-dev.log');
  const fd = openSync(logFile, 'a');
  log(`Starting fresh backend on ${url} (temporary: ${dir}) …`);
  const child = spawn(
    process.execPath,
    [convexWrapper, 'dev', '--local-cloud-port', String(port), '--local-site-port', String(port + 1), '--tail-logs', 'disable', '--typecheck', 'disable'],
    { env: { ...process.env, SELFBOUND_BACKEND_DIR: dir }, stdio: ['ignore', fd, fd], detached: true },
  );
  let stopped = false;
  const stop = async ({ keep = false } = {}) => {
    if (stopped) return;
    stopped = true;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    // Wait until the port is free, then clean up.
    await waitFor(async () => !(await reachable(`${url}/version`)), 'Stopping the backend', 30_000).catch(() => undefined);
    if (!keep) rmSync(dir, { recursive: true, force: true });
  };
  try {
    await waitFor(() => reachable(`${url}/version`), 'Backend');
    await waitFor(() => existsSync(join(dir, '.env.local')), '.env.local');
    const wanted = {
      SELFBOUND_DEV_JWKS: devJwksDataUri(),
      CLERK_JWT_ISSUER_DOMAIN: 'none',
      SELFBOUND_OWNER_IDS: DEV_OWNER_ID,
      SELFBOUND_ALLOW_SEED: '1',
      SELFBOUND_TEST_SWITCHES: '1',
      // OAuth for connectors on; the tests never open the consent page.
      SELFBOUND_APP_URL: 'http://127.0.0.1:1',
      ...env,
    };
    for (const [key, value] of Object.entries(wanted)) await convexCli(dir, ['env', 'set', key, value]);
    // auth.config.ts is evaluated on upload: trigger a new upload.
    const authFile = join(dir, 'convex', 'auth.config.ts');
    utimesSync(authFile, new Date(), new Date());
    const token = devToken();
    const { ConvexHttpClient } = await import('convex/browser');
    const { api } = await import('../backend/convex/_generated/api.js');
    const client = new ConvexHttpClient(url);
    client.setAuth(token);
    await waitFor(async () => {
      try {
        await client.query(api.health.whoami, {});
        return true;
      } catch {
        return false;
      }
    }, 'Sign-in to the test backend');
    await waitFor(() => reachable(`${siteUrl}/health`), 'HTTP endpoints');
    log('Test backend ready.');
    return {
      url,
      siteUrl,
      dir,
      token,
      logFile,
      convex: (args, options) => convexCli(dir, args, options),
      stop,
      log: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''),
    };
  } catch (error) {
    const tail = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').slice(-30).join('\n') : '';
    await stop();
    throw new Error(`${error instanceof Error ? error.message : error}\n--- convex dev ---\n${tail}`);
  }
}
