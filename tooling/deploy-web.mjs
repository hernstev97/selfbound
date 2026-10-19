#!/usr/bin/env node
// Builds the web app for production and uploads it to Vercel as a static site.
// Instance values (Convex deployment, app URL, Clerk key, Vercel project, extra hosts) come from
// deploy/instance.json, ~/.config/selfbound/instance.json or SELFBOUND_* environment variables (tooling/instance.mjs).
//
// Usage:  node tooling/deploy-web.mjs            build + production deploy
//         node tooling/deploy-web.mjs --build    build only (into deploy/web/), upload nothing
//
// Every value here is public (it ends up in the browser anyway); the frontend has no secrets.
// A guard aborts if the local test token ends up in the build.
//
// Upload directory deploy/web/ (gitignored except .vercelignore; .vercel/ holds the project link).
// Its vercel.json is generated: the generic base deploy/vercel.base.json plus, in front of the base
// rules, a redirect from each redirectHost to appUrl and a rewrite from each mcpHost to the Convex
// HTTP actions (see docs/architecture/mcp.md).

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireInstance } from './instance.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'deploy', 'web');
export const VERCEL_BASE_FILE = join(root, 'deploy', 'vercel.base.json');

/** Build-time environment of the production app. */
// Variables the build must not inherit from the shell: local test token and test mode, under both names.
// legacy-xlr8: the old test variable is cleared too, so a stale one in the shell cannot switch test mode on
export const BLANKED_ENV = { VITE_DEV_TOKEN: '', VITE_SELFBOUND_TEST: '', VITE_XLR8_TEST: '' };

export function productionEnv(instance) {
  return {
    VITE_CONVEX_URL: `https://${instance.convexDeployment}.convex.cloud`,
    VITE_CONVEX_SITE_URL: `https://${instance.convexDeployment}.convex.site`,
    // Clerk production instance. During a domain change this may be a list `host=key,…`
    // (app/src/publishableKey.ts).
    VITE_CLERK_PUBLISHABLE_KEY: instance.clerkPublishableKey,
    // Public address of the app, used by the build for absolute URLs (og tags).
    SELFBOUND_PUBLIC_URL: instance.appUrl,
    // Optional prefix for suggested git branch names (instance field branchPrefix); empty = none.
    VITE_SELFBOUND_BRANCH_PREFIX: instance.branchPrefix ?? '',
    // Source link in the app and on the sign-in page (instance field sourceUrl); empty = upstream repository.
    SELFBOUND_SOURCE_URL: instance.sourceUrl ?? '',
  };
}

/**
 * Final vercel.json: host redirects before the base redirects, MCP rewrites before the base rewrites
 * (before the cookie rewrite of `/`, otherwise `/` on an MCP host would serve the welcome page).
 * A redirect from `/:path*` does not match `/`, hence the separate rule for `/`.
 */
export function vercelConfig(base, instance) {
  const config = structuredClone(base);
  const redirects = [];
  if (instance.redirectHosts.length) {
    const has = [{ type: 'host', value: { inc: instance.redirectHosts } }];
    redirects.push(
      { source: '/', has, destination: `${instance.appUrl}/`, permanent: false },
      { source: '/:path*', has, destination: `${instance.appUrl}/:path*`, permanent: false },
    );
  }
  const rewrites = instance.mcpHosts.map((host) => ({
    source: '/:path*',
    has: [{ type: 'host', value: host }],
    destination: `https://${instance.convexDeployment}.convex.site/:path*`,
  }));
  config.redirects = [...redirects, ...(base.redirects ?? [])];
  config.rewrites = [...rewrites, ...(base.rewrites ?? [])];
  return config;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    console.error(`Aborted: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

function filesIn(dir) {
  return readdirSync(dir, { recursive: true })
    .map((f) => join(dir, String(f)))
    .filter((f) => statSync(f).isFile());
}

function main() {
  const buildOnly = process.argv.includes('--build');
  // A build-only run uploads nothing, so it needs no Vercel settings.
  const instance = requireInstance(['convexDeployment', 'appUrl', 'clerkPublishableKey', ...(buildOnly ? [] : ['vercelProject', 'vercelScope'])]);
  const production = productionEnv(instance);

  // 1. Build. Set VITE_DEV_TOKEN empty: the process environment wins over app/.env.local.
  const dist = join(root, 'app', 'dist');
  run('pnpm', ['--filter', '@selfbound/app', 'build'], { env: { ...process.env, ...production, ...BLANKED_ENV } });

  // 2. Guard: no local test token, no local address, the right production deployment.
  const bundle = filesIn(dist).filter((f) => f.endsWith('.js')).map((f) => readFileSync(f, 'utf8')).join('\n');
  const problems = [];
  if (/eyJhbGciOiJSUzI1Ni/.test(bundle)) problems.push('local test token (JWT) in the build');
  if (/127\.0\.0\.1:134\d\d/.test(bundle)) problems.push('local Convex address in the build');
  if (!bundle.includes(production.VITE_CONVEX_URL)) problems.push('production URL missing from the build');
  if (!existsSync(join(dist, 'welcome.html'))) problems.push('welcome page (welcome.html) missing from the build');
  else {
    // The welcome page loads only its own entry: no app chunks, no Clerk (that only comes on /sign-in).
    const entry = readFileSync(join(dist, 'welcome.html'), 'utf8').match(/src="\/(assets\/welcome-[\w-]+\.js)"/)?.[1];
    const code = entry ? readFileSync(join(dist, entry), 'utf8') : '';
    if (!entry || /(?:^|[;\n}])\s*import\s*[^()]*?from\s*["']\.\/(?:start|index|clerk)/.test(code)) problems.push('welcome page loads app or Clerk chunks at start');
  }
  if (problems.length) {
    console.error(`Aborted, nothing uploaded: ${problems.join(', ')}`);
    process.exit(2);
  }

  // 3. Copy into deploy/web/ (.vercel/ and .vercelignore stay), write vercel.json.
  for (const entry of readdirSync(out)) {
    if (!['.vercel', '.vercelignore'].includes(entry)) rmSync(join(out, entry), { recursive: true, force: true });
  }
  cpSync(dist, out, { recursive: true });
  // The app is deployed as app.html: if an index.html existed at `/`, Vercel would always serve it,
  // and the welcome/app switch (vercel.json, cookie selfbound_signed_in) would never apply.
  renameSync(join(out, 'index.html'), join(out, 'app.html'));
  const base = JSON.parse(readFileSync(VERCEL_BASE_FILE, 'utf8'));
  writeFileSync(join(out, 'vercel.json'), `${JSON.stringify(vercelConfig(base, instance), null, 2)}\n`);
  console.log(`Built into ${out}`);

  if (buildOnly) return;

  // 4. Upload (static, no build on Vercel).
  if (!existsSync(join(out, '.vercel', 'project.json'))) {
    run('vercel', ['link', '--yes', '--project', instance.vercelProject, '--scope', instance.vercelScope], { cwd: out });
  }
  run('vercel', ['deploy', '--prod', '--yes', '--scope', instance.vercelScope], { cwd: out });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
