#!/usr/bin/env node
// Moves stored GitHub references of a renamed repository (backend/convex/repoRename.ts), page by page.
// Run it before another repository takes over the old name.
//
// Usage: node tooling/rename-github-repo.mjs --from owner/old --to owner/new            dry run, production
//        node tooling/rename-github-repo.mjs --from owner/old --to owner/new --apply    change data
//        add --local to run against the local backend (tooling/convex.mjs) instead of production
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const from = arg('--from');
const to = arg('--to');
const apply = process.argv.includes('--apply');
const wrapper = join(import.meta.dirname, process.argv.includes('--local') ? 'convex.mjs' : 'cloud.mjs');
if (!from || !to) {
  console.error('usage: node tooling/rename-github-repo.mjs --from owner/old --to owner/new [--apply] [--local]');
  process.exit(2);
}

const totals = {};
let args = { from, to, apply };
for (;;) {
  const r = spawnSync(process.execPath, [wrapper, 'run', 'repoRename:step', JSON.stringify(args)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) process.exit(r.status ?? 1);
  const out = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  const t = (totals[out.table] ??= { changed: 0, textLinks: 0 });
  t.changed += out.changed;
  t.textLinks += out.textLinks;
  if (!out.next) break;
  args = { from, to, apply, ...out.next };
}
console.log(`${apply ? 'Changed' : 'Would change (dry run)'}: ${from} → ${to}`);
for (const [table, t] of Object.entries(totals)) {
  console.log(`  ${table.padEnd(16)} ${t.changed} documents${t.textLinks ? `, ${t.textLinks} with links in text (left unchanged)` : ''}`);
}
if (!apply) console.log('Nothing changed. Run again with --apply.');
