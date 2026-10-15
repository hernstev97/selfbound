#!/usr/bin/env node
// Builds the landing page (site/) and uploads it to Vercel as a static site. Separate from the app:
// its own Vercel project (siteVercelProject), no Convex, no Clerk.
// Settings (tooling/instance.mjs): vercelScope, siteVercelProject, siteUrl (optional).
//
// Usage:  node tooling/deploy-site.mjs            build + preview deployment (prints the preview URL)
//         node tooling/deploy-site.mjs --prod     build + production deployment (to the project's domains)
//         node tooling/deploy-site.mjs --build    build only (into deploy/site/), upload nothing
//
// Whether search engines may list the page is the `listed` switch in site/site.config.json
// (SELFBOUND_SITE_LISTED=1 overrides it for one build). The same switch loads Vercel Web Analytics and Speed
// Insights. The imprint details come from ~/.config/selfbound/site-legal.json (tooling/site-legal.mjs); a
// production build fails without them. Upload directory deploy/site/ (gitignored; .vercel/ keeps the
// project link).

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireInstance } from './instance.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'deploy', 'site');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    console.error(`Aborted: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

function main() {
  const buildOnly = process.argv.includes('--build');
  const instance = requireInstance(buildOnly ? [] : ['vercelScope', 'siteVercelProject']);
  const prod = process.argv.includes('--prod');
  run('pnpm', ['--filter', '@selfbound/site', 'build'], {
    env: { ...process.env, ...(instance.siteUrl ? { SELFBOUND_SITE_URL: instance.siteUrl } : {}), ...(prod ? { SELFBOUND_SITE_REQUIRE_LEGAL: '1' } : {}) },
  });

  mkdirSync(out, { recursive: true });
  for (const entry of readdirSync(out)) if (entry !== '.vercel') rmSync(join(out, entry), { recursive: true, force: true });
  cpSync(join(root, 'site', 'dist'), out, { recursive: true });
  console.log(`Built into ${out}`);
  if (buildOnly) return;

  if (!existsSync(join(out, '.vercel', 'project.json'))) {
    run('vercel', ['link', '--yes', '--project', instance.siteVercelProject, '--scope', instance.vercelScope], { cwd: out });
    // `vercel link` inside a Git checkout connects the repository; Git pushes would then try to build the
    // whole repo on Vercel and fail. The site is only ever uploaded from here.
    run('vercel', ['git', 'disconnect', '--yes', '--scope', instance.vercelScope], { cwd: out });
  }
  run('vercel', ['deploy', ...(prod ? ['--prod'] : []), '--yes', '--scope', instance.vercelScope], { cwd: out });
}

main();
