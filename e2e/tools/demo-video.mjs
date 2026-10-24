#!/usr/bin/env node
// Demo video for README, landing page and release post: keyboard, an agent creating an issue over MCP,
// the inbox and the pull requests page, in the light and the dark theme, on the sample data only.
// Usage: node e2e/tools/demo-video.mjs [--out <dir>] [--only light|dark] [--shots] [--reseed]
// Needs the local app on the sample data (`node tooling/local.mjs --seed small --app dev`, add
// `--port <n>` for a second backend); URL and token come from app/.env.local, which that script writes.
// Output: <out>/demo-<scheme>.webm (raw, 1280x800). Compress it with the pr-media skill's compress.sh.
// With --shots the script also saves a PNG per scene (stills for the README and the social image).
//
// The agent's call is a real MCP request with the seeded local key `Claude Code` (no account, no network
// beyond 127.0.0.1). Key caps and captions are drawn into the page by this script for the recording; the
// product itself is untouched. The agent adds one issue, so record each theme on a fresh seeded backend (the
// counts in the video then match). `--reseed` resets the seed in place, which can hit the per-call operation limit.
import { mkdirSync, readFileSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fromE2e = createRequire(join(root, 'e2e', 'package.json'));
const { chromium } = fromE2e('@playwright/test');
const { ConvexHttpClient } = fromE2e('convex/browser');
const fromBackend = createRequire(join(root, 'backend', 'package.json'));

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const out = opt('out', '/tmp/selfbound-demo');
const schemes = opt('only') ? [opt('only')] : ['light', 'dark'];
const shots = argv.includes('--shots');
const reseedFirst = argv.includes('--reseed');
const base = (opt('app', 'http://127.0.0.1:5412')).replace(/\/$/, '');
mkdirSync(out, { recursive: true });

const env = readFileSync(join(root, 'app', '.env.local'), 'utf8');
const convexUrl = /^VITE_CONVEX_URL=(.*)$/m.exec(env)[1].trim();
const token = /^VITE_DEV_TOKEN=(.*)$/m.exec(env)[1].trim();
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(convexUrl)) throw new Error(`Refusing a non-local backend: ${convexUrl}`);
const mcpUrl = `http://127.0.0.1:${Number(new URL(convexUrl).port) + 1}/mcp`;
// Seeded, local-only key of the sample agent (backend/data/generate.ts).
const agentKey = 'selfbound_seed_claudecode_local_only_0000000000000000';

async function reseed() {
  const { seedLocal } = await import(pathToFileURL(join(root, 'backend', 'scripts', 'seed.ts')).href);
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(token);
  // A reset right after a large one can run into the per-call operation limit; the next call continues.
  for (let attempt = 1; ; attempt++) {
    try {
      await seedLocal(client, 'small', { force: true });
      break;
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  process.stdout.write('\n');
}

async function agentCreatesIssue(attempt = 1) {
  try {
    await createIssueOnce();
  } catch (error) {
    if (attempt >= 3) throw error;
    await new Promise((r) => setTimeout(r, 1500));
    await agentCreatesIssue(attempt + 1);
  }
}

async function createIssueOnce() {
  const { Client } = fromBackend('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = fromBackend('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'claude-code', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${agentKey}` } } }));
  try {
    const result = await client.callTool({
      name: 'create_issues',
      arguments: {
        requestId: `demo-${Date.now()}`,
        issues: [
          {
            team: 'ORB',
            title: 'Retry failed webhook deliveries with backoff',
            description: 'Deliveries that fail with a 5xx are dropped today. Retry them up to five times with exponential backoff and log the last error.',
            status: 'todo',
            priority: 'high',
            labels: ['Feature'],
          },
        ],
      },
    });
    if (result.isError) throw new Error(`create_issues failed: ${JSON.stringify(result.content)}`);
  } finally {
    await client.close();
  }
}

// Drawn into the page for the recording only: pressed keys at the bottom, a caption on top.
const OVERLAY = `
const init = () => {
  const css = document.createElement('style');
  css.textContent = \`
    #demo-keys { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); display: flex; gap: 6px; align-items: center;
      z-index: 99999; pointer-events: none; opacity: 0; transition: opacity .12s; font: 600 15px/1 Inter, system-ui, sans-serif; }
    #demo-keys.on { opacity: 1; }
    #demo-keys kbd { min-width: 34px; padding: 9px 11px; border-radius: 8px; text-align: center; font: inherit;
      background: #17171c; color: #f4f4f6; box-shadow: 0 2px 0 #000, 0 8px 24px rgba(0,0,0,.28); border: 1px solid #3a3a44; }
    #demo-keys span { color: #17171c; background: #f4f4f6; padding: 9px 12px; border-radius: 8px; font-weight: 500; box-shadow: 0 8px 24px rgba(0,0,0,.28); }
    #demo-cap { position: fixed; right: 24px; bottom: 22px; z-index: 99999; pointer-events: none; opacity: 0; transition: opacity .2s;
      padding: 10px 14px; border-radius: 10px; background: #17171c; color: #f4f4f6; border: 1px solid #3a3a44; box-shadow: 0 8px 24px rgba(0,0,0,.28);
      font: 500 15px/1.3 Inter, system-ui, sans-serif; }
    #demo-cap code { font: 600 14px ui-monospace, SFMono-Regular, monospace; color: #9ecbff; }
    #demo-cap.on { opacity: 1; }
  \`;
  document.head.append(css);
  const keys = document.createElement('div'); keys.id = 'demo-keys';
  const cap = document.createElement('div'); cap.id = 'demo-cap';
  document.body.append(keys, cap);
  let t;
  window.__keys = (parts, label) => {
    keys.replaceChildren(...parts.map((p) => Object.assign(document.createElement('kbd'), { textContent: p })));
    if (label) keys.append(Object.assign(document.createElement('span'), { textContent: label }));
    keys.classList.add('on'); clearTimeout(t); t = setTimeout(() => keys.classList.remove('on'), 1100);
  };
  window.__cap = (html) => { cap.innerHTML = html || ''; cap.classList.toggle('on', !!html); };
};
if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
`;

const KEYNAME = { Control: 'Ctrl', Backspace: '⌫', Enter: '↵', Escape: 'Esc' };

async function run(scheme) {
  if (reseedFirst) await reseed();
  const dir = join(out, `raw-${scheme}`);
  mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: scheme,
    locale: 'en-US',
    timezoneId: 'Europe/Berlin',
    recordVideo: { dir, size: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();
  const wait = (ms) => page.waitForTimeout(ms);
  const still = async (name) => { if (shots) await page.screenshot({ path: join(out, `${name}-${scheme}.png`) }); };
  // Press a key or chord ("Control+k", "g i" as two presses) and show it.
  async function press(chord, label, after = 650) {
    const steps = chord.split(' ');
    const parts = steps.flatMap((s) => s.split('+')).map((k) => KEYNAME[k] ?? k.toUpperCase());
    await page.evaluate(([p, l]) => window.__keys(p, l), [parts, label]);
    for (const s of steps) { await page.keyboard.press(s); await wait(90); }
    await wait(after);
  }
  const caption = (html) => page.evaluate((h) => window.__cap(h), html);

  await page.addInitScript(OVERLAY);
  await page.goto(`${base}/team/ORB`);
  await page.waitForSelector('[data-testid="issue-row"]', { timeout: 30000 });
  await page.mouse.move(1270, 790);
  await wait(900);

  // 1. Keyboard: move, set a status, open the command menu.
  await press('j', 'move', 350);
  await press('j', undefined, 350);
  await press('j', undefined, 350);
  await press('s', 'status', 700);
  await still('status');
  await page.keyboard.type('review', { delay: 60 });
  await wait(400);
  await page.keyboard.press('Enter');
  await wait(700);
  await press('Control+k', 'command menu', 700);
  await page.keyboard.type('sprint', { delay: 70 });
  await wait(700);
  await still('command');
  await page.keyboard.press('Escape');
  await wait(400);

  // 2. An agent creates an issue over MCP; the inbox counts up without a reload.
  await caption('<code>Claude Code</code> → <code>create_issues</code> over MCP');
  await wait(1100);
  await agentCreatesIssue();
  await wait(1400);
  await caption('');
  await press('g i', 'inbox', 900);
  await page.keyboard.press('Home');
  await wait(300);
  await still('inbox');
  await press('Enter', 'open', 1200);
  await page.waitForSelector('[data-testid="split-detail"]', { timeout: 10000 }).catch(() => {});
  await wait(600);
  await still('inbox-open');
  await press('Backspace', 'remove', 900);

  // 3. Pull requests.
  await press('g p', 'pull requests', 1000);
  await page.waitForSelector('[data-testid="pull-row"]', { timeout: 10000 });
  await press('j', undefined, 450);
  await press('j', undefined, 450);
  await still('pulls');
  await press('Enter', 'open', 1700);
  await still('pull-open');

  await wait(600);

  const video = page.video();
  await context.close();
  await browser.close();
  const raw = await video.path();
  renameSync(raw, join(out, `demo-${scheme}.webm`));
  console.log(`demo-${scheme}.webm in ${out}`);
}

for (const scheme of schemes) await run(scheme);
