// Environment for performance runs and the walkthrough video: its own local Convex (anonymous,
// no account), two production builds of the app (P1 direct, P2 through the latency proxy),
// vite preview and the proxies for the "remote" profile.
//
// Fixed ports (only these, so parallel runs of other tools do not interfere):
//   Convex 13520 (HTTP actions/MCP 13521), vite preview 5522,
//   proxy Convex 13590 → 13520, proxy page 5592 → 5522.
//
// The Convex address is baked into the build (VITE_CONVEX_URL), hence two builds:
// perf/.dist/p1 talks to 13520 directly, perf/.dist/p2 to the proxy 13590.
// vite preview serves only one of them at a time; usePreview() switches.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@selfbound/backend/api';
import { envVar } from '../tooling/lib/env.mjs';
import { startProxy, type ProxyHandle } from './latency-proxy.ts';

export const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, '..');

// Other ports (e.g. parallel worktrees) via the environment:
//   SELFBOUND_PERF_CONVEX_PORT (HTTP actions one higher), SELFBOUND_PERF_PREVIEW_PORT,
//   SELFBOUND_PERF_PROXY_CONVEX_PORT, SELFBOUND_PERF_PROXY_PAGE_PORT.
// `name` without prefix; the old XLR8_ prefix (legacy-xlr8) still works (tooling/lib/env.mjs).
const envPort = (name: string, fallback: number) => Number(envVar(name) || fallback);
const convexPort = envPort('PERF_CONVEX_PORT', 13520);
export const PORTS = {
  convex: convexPort,
  site: convexPort + 1,
  preview: envPort('PERF_PREVIEW_PORT', 5522),
  proxyConvex: envPort('PERF_PROXY_CONVEX_PORT', 13590),
  proxyPage: envPort('PERF_PROXY_PAGE_PORT', 5592),
} as const;
export const DELAY_MS = 50;
export type Profile = 'P1' | 'P2';
export type Dataset = 'small' | 'large';
export const CPU_RATE: Record<Profile, number> = { P1: 1, P2: 4 };

const BACKEND_DIR = 'perf/.backend';
const backendPidFile = join(root, BACKEND_DIR, 'pid');
const distDir = (profile: Profile) => join(here, '.dist', profile.toLowerCase());

export const convexUrl = (profile: Profile) => `http://127.0.0.1:${profile === 'P1' ? PORTS.convex : PORTS.proxyConvex}`;
export const appBase = (profile: Profile) => `http://127.0.0.1:${profile === 'P1' ? PORTS.preview : PORTS.proxyPage}`;

const log = (msg: string) => console.log(`\x1b[36m▸\x1b[0m ${msg}`);

async function reachable(url: string) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

/** Who listens on the port? (Linux: ss and /proc; otherwise null) */
export function portOwner(port: number): { pid: number; cwd: string; cmd: string } | null {
  const r = spawnSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' });
  const pid = Number(/pid=(\d+)/.exec(r.stdout ?? '')?.[1]);
  if (!pid) return null;
  const read = (f: () => string) => {
    try {
      return f();
    } catch {
      return '?';
    }
  };
  return { pid, cwd: read(() => readlinkSync(`/proc/${pid}/cwd`)), cmd: read(() => readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').slice(0, 160)) };
}

function describeOwner(port: number) {
  const o = portOwner(port);
  return o ? `PID ${o.pid}, folder ${o.cwd}, ${o.cmd}` : 'unknown process';
}

// ---------- Only one performance run at a time ----------
//
// Two runs at the same time distort each other, even on separate ports; parallel worktrees sharing
// ports and backends used to be the most common cause of aborted runs. The lock is machine-wide,
// for run.ts, mobile.ts and record.ts.
const LOCK = join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'selfbound-perf.lock');

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(LOCK, JSON.stringify({ pid: process.pid, dir: root, cmd: process.argv.slice(1).join(' '), started: new Date().toISOString() }), { flag: 'wx' });
      process.on('exit', releaseLock);
      return;
    } catch {
      let held: { pid: number; dir: string; cmd: string; started: string } | null = null;
      try {
        held = JSON.parse(readFileSync(LOCK, 'utf8'));
      } catch {}
      if (held && held.pid !== process.pid && alive(held.pid)) {
        throw new Error(`A performance run is already in progress (PID ${held.pid} since ${held.started}, ${held.dir}: ${held.cmd}). Two at once distort both results. Wait until it finishes; lock: ${LOCK}`);
      }
      rmSync(LOCK, { force: true }); // stale
    }
  }
  throw new Error(`Could not create the lock ${LOCK}`);
}

function releaseLock() {
  try {
    if (JSON.parse(readFileSync(LOCK, 'utf8')).pid === process.pid) rmSync(LOCK, { force: true });
  } catch {}
}

async function waitFor(check: () => Promise<boolean>, label: string, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${label} did not come up (${timeoutMs / 1000} s)`);
}

function killGroup(pid: number) {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already stopped
    }
  }
}

/**
 * Separate cores: browser (this process and its children) on 0–7, backend and vite preview on
 * 8–15. Only on machines with at least 16 threads.
 */
export function pinning(enabled: boolean) {
  const can = enabled && os.cpus().length >= 16 && spawnSync('taskset', ['-V']).status === 0;
  if (can) spawnSync('taskset', ['-a', '-pc', '0-7', String(process.pid)], { stdio: 'ignore' });
  return {
    active: can,
    /** Command for helper processes, with taskset onto the other cores if active */
    wrap: (cmd: string, args: string[]): [string, string[]] => (can ? ['taskset', ['-c', '8-15', cmd, ...args]] : [cmd, args]),
  };
}

export async function devToken(): Promise<string> {
  const { devToken } = (await import(join(root, 'tooling/dev-auth.mjs'))) as { devToken: () => string };
  return devToken();
}

export interface Stack {
  token: string;
  /** Browser on 0–7, helpers on 8–15 */
  pinned: boolean;
  client: ConvexHttpClient;
  /**
   * Provide a data set. `fresh`: start the backend new and empty, then seed.
   * Otherwise seed only if a different data set is loaded.
   */
  seed(set: Dataset, fresh: boolean): Promise<void>;
  /** Start vite preview with the build for this profile (switches if needed) */
  usePreview(profile: Profile): Promise<void>;
  /** Proxies for P2 on/off */
  proxies(on: boolean): Promise<void>;
  stop(): Promise<void>;
}

export interface StackOptions {
  pin: boolean;
  build: boolean;
  /** Keep the backend running after the run (for several runs in a row) */
  keep: boolean;
  /** Start the backend without old data (a running performance backend is stopped) */
  fresh: boolean;
}

export async function startStack(opts: StackOptions): Promise<Stack> {
  acquireLock();
  const pin = pinning(opts.pin);
  if (pin.active) log('Cores separated: browser 0–7, backend and preview 8–15.');
  const token = await devToken();

  // 1. Backend (own folder, own data; app/.env.local stays untouched)
  async function startBackend(fresh: boolean) {
    if (fresh) {
      // Completely new instead of emptying tables: after deleting 10,000 issues, seeding again
      // occasionally hits Convex limits, and no leftovers can distort anything.
      stopBackend();
      await waitFor(async () => !(await reachable(`${convexUrl('P1')}/version`)), 'Old backend to stop', 20_000).catch(() => {
        throw new Error(`Port ${PORTS.convex} is in use, but not by this run's backend (${describeOwner(PORTS.convex)}). Wait for the other run or set other ports (SELFBOUND_PERF_CONVEX_PORT etc., perf/README.md).`);
      });
      for (const entry of ['.convex', '.env.local']) rmSync(join(root, BACKEND_DIR, entry), { recursive: true, force: true });
      // If anything still listens on the ports afterwards (even a process that is not Convex), the
      // backend would not come up and the run would hang until local.mjs times out.
      for (const port of [PORTS.convex, PORTS.site]) {
        if (portOwner(port)) throw new Error(`Port ${port} is in use (${describeOwner(port)}). Wait for the other run or set other ports (SELFBOUND_PERF_CONVEX_PORT etc., perf/README.md).`);
      }
    } else {
      // Reuse only if the backend on the port comes from this folder. Otherwise the run would seed
      // its data into another worktree's backend (tooling/local.mjs accepts any).
      const owner = portOwner(PORTS.convex);
      if (owner && !owner.cwd.startsWith(join(root, BACKEND_DIR))) {
        throw new Error(`A foreign backend runs on port ${PORTS.convex} (${describeOwner(PORTS.convex)}).`);
      }
    }
    const [cmd, args] = pin.wrap('node', ['tooling/local.mjs', '--port', String(PORTS.convex), '--no-wait', '--no-env', '--dir', BACKEND_DIR, '--pid-file', backendPidFile]);
    // A fresh backend occasionally fails on the first upload (the environment changes meanwhile,
    // "BadAdminKey"). Try once more from scratch.
    for (let attempt = 1; ; attempt++) {
      const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
      if (r.status === 0) return;
      if (attempt === 2) throw new Error('Could not start the local backend for the run (two attempts, log: perf/.backend/.convex-local.log)');
      log('Backend start failed, second attempt with an empty backend …');
      stopBackend();
      await waitFor(async () => !(await reachable(`${convexUrl('P1')}/version`)), 'Old backend to stop', 20_000).catch(() => {});
      for (const entry of ['.convex', '.env.local']) rmSync(join(root, BACKEND_DIR, entry), { recursive: true, force: true });
    }
  }
  await startBackend(opts.fresh);
  const client = new ConvexHttpClient(convexUrl('P1'));
  client.setAuth(token);

  // 2. Builds
  for (const profile of ['P1', 'P2'] as const) {
    if (!opts.build && existsSync(join(distDir(profile), 'index.html'))) continue;
    log(`Building the app for ${profile} (Convex ${convexUrl(profile)}) …`);
    const env = { ...process.env, VITE_CONVEX_URL: convexUrl(profile), VITE_DEV_TOKEN: token, VITE_SELFBOUND_TEST: '1' };
    const out = `../perf/.dist/${profile.toLowerCase()}`;
    const b = spawnSync('pnpm', ['--filter', '@selfbound/app', 'exec', 'vite', 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'warn'], { cwd: root, env, stdio: 'inherit' });
    if (b.status !== 0) throw new Error(`Build for ${profile} failed`);
  }

  let preview: ChildProcess | null = null;
  let previewProfile: Profile | null = null;
  let seeded: Dataset | null = null;
  let proxyHandles: ProxyHandle[] = [];

  async function stopPreview() {
    if (!preview?.pid) return;
    killGroup(preview.pid);
    preview = null;
    previewProfile = null;
    await waitFor(async () => !(await reachable(`http://127.0.0.1:${PORTS.preview}/`)), 'vite preview to stop', 10_000).catch(() => {});
  }

  const stack: Stack = {
    token,
    pinned: pin.active,
    client,
    async seed(set, fresh) {
      if (fresh && seeded !== null) await startBackend(true);
      seeded = set;
      log(`Test data "${set}"${fresh ? ' into a fresh backend' : ''} …`);
      const [c, a] = pin.wrap('node', ['tooling/local.mjs', '--port', String(PORTS.convex), '--seed', set, '--no-wait', '--no-env', '--dir', BACKEND_DIR, '--pid-file', backendPidFile]);
      const s = spawnSync(c, a, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
      // Do not print the progress "large: 100/10000 Issues" line by line
      const lines = (s.stdout ?? '').split(/\r|\n/).filter((l) => l.trim() && !/^\w+: \d+\/\d+ issues$/i.test(l.trim()));
      if (lines.length) console.log(lines.join('\n'));
      if (s.status !== 0) throw new Error(`Seeding ${set} failed`);
    },
    async usePreview(profile) {
      if (previewProfile === profile) return;
      await stopPreview();
      if (await reachable(`http://127.0.0.1:${PORTS.preview}/`)) throw new Error(`Port ${PORTS.preview} is already in use`);
      const [c, a] = pin.wrap('pnpm', ['--filter', '@selfbound/app', 'exec', 'vite', 'preview', '--outDir', `../perf/.dist/${profile.toLowerCase()}`, '--host', '127.0.0.1', '--port', String(PORTS.preview), '--strictPort']);
      preview = spawn(c, a, { cwd: root, stdio: 'ignore', detached: true });
      previewProfile = profile;
      writeFileSync(join(here, '.dist', 'preview.pid'), String(preview.pid));
      await waitFor(() => reachable(`http://127.0.0.1:${PORTS.preview}/`), 'vite preview', 30_000);
    },
    async proxies(on) {
      if (on && proxyHandles.length === 0) {
        proxyHandles = await Promise.all([startProxy(PORTS.proxyConvex, PORTS.convex, DELAY_MS), startProxy(PORTS.proxyPage, PORTS.preview, DELAY_MS)]);
      } else if (!on && proxyHandles.length) {
        await Promise.all(proxyHandles.map((p) => p.close()));
        proxyHandles = [];
      }
    },
    async stop() {
      await stack.proxies(false);
      await stopPreview();
      rmSync(join(here, '.dist', 'preview.pid'), { force: true });
      if (!opts.keep) stopBackend();
    },
  };
  mkdirSync(join(here, '.dist'), { recursive: true });
  return stack;
}

/**
 * Stops the backend of an earlier run (--keep, aborted run): via the PID file and, if that is
 * missing or stale, via the port, if the process there comes from this folder's perf/.backend.
 * Foreign backends stay untouched.
 */
export function stopBackend() {
  if (existsSync(backendPidFile)) {
    killGroup(Number(readFileSync(backendPidFile, 'utf8')));
    rmSync(backendPidFile, { force: true });
  }
  const owner = portOwner(PORTS.convex);
  if (owner && owner.cwd.startsWith(join(root, BACKEND_DIR))) killGroup(owner.pid);
}

/** A real agent over MCP (HTTP action on port 13521), one key per run. */
export function mcpAgent(client: ConvexHttpClient, name: string) {
  let key: Promise<string> | null = null;
  return async (tool: string, args: Record<string, unknown>) => {
    key ??= client.action(api.agents.create, { name }).then((r) => r.key);
    const response = await fetch(`http://127.0.0.1:${PORTS.site}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${await key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
    });
    const body = (await response.json()) as { result?: { isError?: boolean }; error?: unknown };
    if (!response.ok || body.error || body.result?.isError) throw new Error(`MCP ${tool}: ${response.status} ${JSON.stringify(body)}`);
    return body.result;
  };
}
