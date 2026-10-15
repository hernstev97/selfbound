#!/usr/bin/env node
// Moves stored legacy names in the Convex data to the Selfbound names, page by page
// (backend/convex/legacyNames.ts): actor kind 'steven' → 'owner', theme 'xlr8' → 'selfbound',
// sprint source 'xlr8' → 'selfbound'. Idempotent; changes only those values.
//
// Usage: node tooling/migrate-legacy-data.mjs [--prod]              dry run (default): counts, writes nothing
//        node tooling/migrate-legacy-data.mjs [--prod] --apply      change data
//        node tooling/migrate-legacy-data.mjs [--prod] --verify     check that no legacy value is left (exit 1 if one is)
//   --dry-run is accepted and is the default. --apply with --verify applies, then verifies.
//   Without --prod it runs against the local backend (tooling/convex.mjs), with --prod against production
//   (tooling/cloud.mjs). Prints counts per table only, never content.
//
// Order for production: deploy the code first (it accepts both names), then run this, then verify.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const flags = new Set(process.argv.slice(2));
const known = new Set(['--dry-run', '--apply', '--verify', '--prod']);
const unknown = [...flags].filter((f) => !known.has(f));
if (unknown.length > 0 || (flags.has('--apply') && flags.has('--dry-run'))) {
  console.error(`usage: node tooling/migrate-legacy-data.mjs [--dry-run | --apply] [--verify] [--prod]${unknown.length ? `  (unknown: ${unknown.join(' ')})` : ''}`);
  process.exit(2);
}
const apply = flags.has('--apply');
const verifyOnly = flags.has('--verify') && !apply;
const verifyAfter = flags.has('--verify');
const wrapper = join(import.meta.dirname, flags.has('--prod') ? 'cloud.mjs' : 'convex.mjs');
const target = flags.has('--prod') ? 'production' : 'local backend';

function run(fn, args) {
  const r = spawnSync(process.execPath, [wrapper, 'run', fn, JSON.stringify(args)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) process.exit(r.status ?? 1);
  const out = r.stdout.trim();
  try {
    return JSON.parse(out);
  } catch {
    return JSON.parse(out.slice(out.indexOf('{')));
  }
}

/** Runs `fn` over all tables and sums `field` per table. */
function sweep(fn, extra, field) {
  const totals = {};
  let args = { ...extra };
  for (;;) {
    const out = run(fn, args);
    const t = (totals[out.table] ??= { scanned: 0, legacy: 0, written: 0 });
    t.scanned += out.scanned;
    t.legacy += out[field];
    t.written += out.written ?? 0;
    if (!out.next) return totals;
    args = { ...extra, ...out.next };
  }
}

const pad = (s) => String(s).padEnd(18);
function print(title, totals, columns) {
  console.log(title);
  for (const [table, t] of Object.entries(totals)) {
    console.log(`  ${pad(table)}${columns.map(([label, key]) => `${label} ${String(t[key]).padStart(7)}`).join('   ')}`);
  }
}

let status = 0;
if (!verifyOnly) {
  const totals = sweep('legacyNames:step', { apply }, 'legacy');
  const found = Object.values(totals).reduce((n, t) => n + t.legacy, 0);
  const written = Object.values(totals).reduce((n, t) => n + t.written, 0);
  print(`${apply ? 'Migrated' : 'Dry run'} on the ${target} (documents with a legacy value, documents written):`, totals, [
    ['scanned', 'scanned'],
    ['legacy', 'legacy'],
    ['written', 'written'],
  ]);
  console.log(apply ? `${written} documents changed.` : `${found} documents would change. Nothing changed. Run again with --apply.`);
}
if (verifyOnly || verifyAfter) {
  const totals = sweep('legacyNames:verify', {}, 'remaining');
  const remaining = Object.values(totals).reduce((n, t) => n + t.legacy, 0);
  print(`Verify on the ${target} (documents still holding a legacy value):`, totals, [
    ['scanned', 'scanned'],
    ['remaining', 'legacy'],
  ]);
  console.log(remaining === 0 ? 'OK: no legacy value left.' : `NOT OK: ${remaining} documents still hold a legacy value.`);
  if (remaining > 0) status = 1;
}
process.exit(status);
