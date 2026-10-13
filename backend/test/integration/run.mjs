#!/usr/bin/env node
// Integration tests against a real, fresh local backend (port 13490/13491).
//
//   pnpm --filter @xlr8/backend test:integration
//
// Starts a temporary anonymous backend (tooling/temp-backend.mjs) and runs:
//   1. Import: synthetic Linear snapshot twice → same counts, no duplicates
//   1b. Linear files: scan, download (simulated), upload, rewrite twice → the second run changes nothing
//   2. MCP: official SDK client against POST /mcp (smoke, idempotency, revocation → 401)
//   2b. OAuth: SDK client signs in like claude.ai as a connector (DCR, PKCE, refresh, revocation)
//   3. Concurrency: 20 clients, 5 agents, webhooks (smaller variant)
// then stops the backend. Exit code 0 only if everything passes.

import { randomBytes } from 'node:crypto';
import { runConcurrencyTest } from '../../../tooling/concurrency-test.mjs';
import { startTempBackend } from '../../../tooling/temp-backend.mjs';
import { importSuite } from './import.mjs';
import { linearFilesSuite } from './linear-files.mjs';
import { mcpSuite } from './mcp.mjs';
import { oauthSuite } from './oauth.mjs';

const port = Number(process.env.XLR8_INTEGRATION_PORT ?? 13490);
const log = (msg) => console.log(`\x1b[36m▸\x1b[0m ${msg}`);

async function main() {
  const started = Date.now();
  const backend = await startTempBackend({
    port,
    env: { GITHUB_WEBHOOK_SECRET: `integration-${randomBytes(8).toString('hex')}` },
    log,
  });
  const stop = () => backend.stop();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop().finally(() => process.exit(130)));
  const results = [];
  try {
    for (const [name, suite] of [
      ['Import', () => importSuite(backend, log)],
      ['Linear files', () => linearFilesSuite(backend, log)],
      ['MCP', () => mcpSuite(backend, log)],
      ['OAuth', () => oauthSuite(backend, log)],
      [
        'Concurrency',
        async () => {
          const result = await runConcurrencyTest({
            url: backend.url,
            siteUrl: backend.siteUrl,
            backendDir: backend.dir,
            token: backend.token,
            rounds: 6,
            log,
          });
          for (const c of result.checks) log(`${c.ok ? '✔' : '✖'} ${c.name}: ${c.detail}`);
          if (!result.ok) throw new Error('Concurrency test failed');
        },
      ],
    ]) {
      const t0 = Date.now();
      try {
        await suite();
        results.push({ name, ok: true, ms: Date.now() - t0 });
      } catch (error) {
        console.error(error);
        results.push({ name, ok: false, ms: Date.now() - t0 });
      }
    }
  } finally {
    await stop();
  }
  console.log('');
  for (const r of results) console.log(`${r.ok ? '✔' : '✖'} ${r.name} (${(r.ms / 1000).toFixed(1)} s)`);
  console.log(`Total ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return results.every((r) => r.ok) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
