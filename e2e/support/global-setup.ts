// Starts for the e2e run: a local backend (13470, fresh "small" seed), a test build of the app and
// vite preview (5472). None of it touches app/.env.local or the development backend.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_PORT, BACKEND_PORT, PUBLIC_URL, root, state } from './env.ts';

async function reachable(url: string) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

export default async function globalSetup() {
  const backend = spawnSync(
    'node',
    ['tooling/local.mjs', '--port', String(BACKEND_PORT), '--seed', 'small', '--reset', '--no-wait', '--no-env', '--dir', 'e2e/.backend', '--pid-file', join(root, 'e2e/.backend/pid'), '--app-url', `http://127.0.0.1:${APP_PORT}`],
    { cwd: root, stdio: 'inherit' },
  );
  if (backend.status !== 0) throw new Error('Could not start the e2e backend');

  const { devToken } = (await import(join(root, 'tooling/dev-auth.mjs'))) as { devToken: () => string };
  const token = devToken();
  // Fixed build settings regardless of the caller's environment: a sample public URL (absolute
  // og:* tags) and no branch prefix (suggested branch names like `orb-12-title`).
  const env = { ...process.env, VITE_CONVEX_URL: `http://127.0.0.1:${BACKEND_PORT}`, VITE_DEV_TOKEN: token, VITE_XLR8_TEST: '1', XLR8_PUBLIC_URL: PUBLIC_URL, VITE_XLR8_BRANCH_PREFIX: '' };
  writeFileSync(state('token'), token);

  if (process.env.E2E_SKIP_BUILD !== '1' || !existsSync(join(root, 'e2e/.dist/index.html'))) {
    const app = spawnSync('pnpm', ['--filter', '@selfbound/app', 'exec', 'vite', 'build', '--outDir', '../e2e/.dist', '--emptyOutDir'], { cwd: root, env, stdio: 'inherit' });
    // The welcome page (welcome.html) as a separate build into the same output
    const build = app.status === 0 ? spawnSync('pnpm', ['--filter', '@selfbound/app', 'exec', 'vite', 'build', '-c', 'vite.welcome.config.ts', '--outDir', '../e2e/.dist'], { cwd: root, env, stdio: 'inherit' }) : app;
    if (build.status !== 0) throw new Error('Test build of the app failed');
  }

  if (!(await reachable(`http://127.0.0.1:${APP_PORT}/`))) {
    const preview = spawn('pnpm', ['--filter', '@selfbound/app', 'exec', 'vite', 'preview', '--outDir', '../e2e/.dist', '--host', '127.0.0.1', '--port', String(APP_PORT), '--strictPort'], {
      cwd: root,
      env,
      stdio: 'ignore',
      detached: true,
    });
    preview.unref();
    writeFileSync(state('preview.pid'), String(preview.pid));
    const start = Date.now();
    while (!(await reachable(`http://127.0.0.1:${APP_PORT}/`))) {
      if (Date.now() - start > 30_000) throw new Error('vite preview did not come up');
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}
