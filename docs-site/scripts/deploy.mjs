#!/usr/bin/env node
// Builds the docs site and uploads it to Vercel as a static site (no build on Vercel, like
// tooling/deploy-web.mjs for the app).
//
// Usage:  node docs-site/scripts/deploy.mjs           build + preview deploy (prints the preview URL)
//         node docs-site/scripts/deploy.mjs --prod    build + production deploy
//         node docs-site/scripts/deploy.mjs --build   build only (into docs-site/.deploy/)
// Settings: XLR8_DOCS_VERCEL_PROJECT (default xlr8-docs), XLR8_DOCS_VERCEL_SCOPE (default: vercelScope
// from the instance settings, tooling/instance.mjs).
//
// vercel.json is generated so that `noindex` follows the single switch in launch.mjs.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadInstance } from '../../tooling/instance.mjs';
import { INDEXABLE } from '../launch.mjs';

const site = join(import.meta.dirname, '..');
const out = join(site, '.deploy');
const project = process.env.XLR8_DOCS_VERCEL_PROJECT || 'xlr8-docs';
const scope = process.env.XLR8_DOCS_VERCEL_SCOPE || loadInstance().vercelScope;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: site, stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    console.error(`Aborted: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

const config = {
  $schema: 'https://openapi.vercel.sh/vercel.json',
  // Astro writes /page/index.html and links with a trailing slash; one canonical form.
  trailingSlash: true,
  headers: [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
        ...(INDEXABLE ? [] : [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }]),
      ],
    },
    { source: '/_astro/(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
  ],
};

function main() {
  run('pnpm', ['--filter', '@xlr8/docs', 'build']);

  mkdirSync(out, { recursive: true });
  for (const entry of readdirSync(out)) if (entry !== '.vercel') rmSync(join(out, entry), { recursive: true, force: true });
  cpSync(join(site, 'dist'), out, { recursive: true });
  writeFileSync(join(out, 'vercel.json'), `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Built into ${out} (${INDEXABLE ? 'indexable' : 'noindex'})`);
  if (process.argv.includes('--build')) return;

  if (!scope) {
    console.error('Missing Vercel scope: set XLR8_DOCS_VERCEL_SCOPE or vercelScope in deploy/instance.json.');
    process.exit(2);
  }
  if (!existsSync(join(out, '.vercel', 'project.json'))) {
    run('vercel', ['link', '--yes', '--project', project, '--scope', scope], { cwd: out });
    // Linking inside the repo connects it to GitHub; pushes would then build without config and fail.
    run('vercel', ['git', 'disconnect', '--yes', '--scope', scope], { cwd: out });
  }
  run('vercel', ['deploy', '--yes', '--scope', scope, ...(process.argv.includes('--prod') ? ['--prod'] : [])], { cwd: out });
}

main();
