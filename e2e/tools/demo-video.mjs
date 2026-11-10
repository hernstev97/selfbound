#!/usr/bin/env node
// Short product video (about 28 s, no sound) for README, landing page and release post: what Selfbound is
// for, told in a few captions, while a mouse pointer and the keyboard use the app on the sample data.
// Usage: node e2e/tools/demo-video.mjs [--out <dir>] [--only light|dark] [--app <url>] [--shots]
// Needs the local app on a freshly seeded backend (`node tooling/local.mjs --seed small --reset --app dev`,
// add `--port <n>` for a second backend); URL and token come from app/.env.local, which that script writes.
// The agent scene adds one issue, so seed again before the second theme, or the counts differ.
//
// Output per theme: <out>/demo-<scheme>.mp4, a near-lossless master (1920 x 1200, 30 fps, BT.709);
// compress it with the pr-media skill's compress.sh. With --shots a PNG per scene is saved as well.
//
// The app runs scaled into a window on a backdrop; captions, title cards, the pointer, key caps and the
// agent's terminal are drawn into the page by this script, the product itself is untouched. The agent's call
// is a real MCP request with the seeded local key `Claude Code` (no network beyond 127.0.0.1). Frames come
// from the Chrome DevTools screencast, which is sharper than Playwright's video recording.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { chromium } = createRequire(join(root, 'e2e', 'package.json'))('@playwright/test');
const fromBackend = createRequire(join(root, 'backend', 'package.json'));

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
// Without --out a fresh private directory, never a fixed path in the shared temp folder.
const out = opt('out') ?? mkdtempSync(join(tmpdir(), 'selfbound-demo-'));
const schemes = opt('only') ? [opt('only')] : ['light', 'dark'];
const base = opt('app', 'http://127.0.0.1:5412').replace(/\/$/, '');
const shots = argv.includes('--shots');
mkdirSync(out, { recursive: true });

const env = readFileSync(join(root, 'app', '.env.local'), 'utf8');
const convexUrl = /^VITE_CONVEX_URL=(.*)$/m.exec(env)[1].trim();
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(convexUrl)) throw new Error(`Refusing a non-local backend: ${convexUrl}`);
const mcpUrl = `http://127.0.0.1:${Number(new URL(convexUrl).port) + 1}/mcp`;
// Seeded, local-only key of the sample agent (backend/data/generate.ts).
const agentKey = 'selfbound_seed_claudecode_local_only_0000000000000000';
const AGENT_TITLE = 'Retry failed webhook deliveries with backoff';

// Viewport in CSS px; frames at 4/3 device pixels give 1920 x 1200.
const W = 1440;
const H = 900;
const DPR = 4 / 3;
// The app window on the backdrop: room for the caption above it.
const TOP = 104;
const SCALE = (H - TOP - 34) / H;
const LEFT = Math.round((W - W * SCALE) / 2);

async function agentCreatesIssue(attempt = 1) {
  const { Client } = fromBackend('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = fromBackend('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'claude-code', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${agentKey}` } } }));
    const result = await client.callTool({
      name: 'create_issues',
      arguments: {
        requestId: `demo-${Date.now()}`,
        issues: [
          {
            team: 'ORB',
            title: AGENT_TITLE,
            description: 'Deliveries that fail with a 5xx are dropped today. Retry them up to five times with exponential backoff and log the last error.',
            status: 'todo',
            priority: 'high',
            labels: ['Feature'],
          },
        ],
      },
    });
    if (result.isError) throw new Error(`create_issues failed: ${JSON.stringify(result.content)}`);
    const text = (result.content ?? []).map((c) => c.text ?? '').join(' ');
    return /\bORB-\d+\b/.exec(`${JSON.stringify(result.structuredContent ?? {})} ${text}`)?.[0];
  } catch (error) {
    // A freshly seeded backend sometimes answers the first request late.
    if (attempt >= 3) throw error;
    await new Promise((r) => setTimeout(r, 1500));
    return agentCreatesIssue(attempt + 1);
  } finally {
    await client.close().catch(() => {});
  }
}

// Everything drawn on top of the app. Runs in the page before the app starts.
function stage({ scheme, top, left, scale, logo }) {
  const dark = scheme === 'dark';
  const c = dark
    ? { bg: '#0b0b0f', glow: '#23234a', dot: '#24242c', text: '#f4f4f6', muted: '#9a9aaa', line: '#ffffff1f', shadow: '0 30px 90px -20px #000000d0' }
    : { bg: '#eceef3', glow: '#d9dcf5', dot: '#d3d6df', text: '#14141a', muted: '#5d5d6c', line: '#0000001a', shadow: '0 30px 80px -24px #1a1a3a55' };
  const css = `
    html { background: ${c.bg} radial-gradient(ellipse 70% 55% at 50% 0%, ${c.glow}, transparent 70%) !important; }
    html::before { content: ''; position: fixed; inset: 0; background-image: radial-gradient(circle at center, ${c.dot} 1.3px, transparent 1.5px);
      background-size: 22px 22px; mask-image: linear-gradient(to bottom, #000, transparent 85%); }
    body { position: fixed !important; left: ${left}px; top: ${top}px; width: 100vw; height: 100vh !important; transform: scale(${scale});
      transform-origin: 0 0; border-radius: 14px; overflow: hidden; box-shadow: ${c.shadow}, 0 0 0 1px ${c.line}; }
    .mk { position: fixed; z-index: 2147483000; pointer-events: none; font-family: 'Inter Variable', Inter, system-ui, sans-serif; }
    #mk-caption { left: 0; right: 0; top: 0; height: ${top}px; display: grid; place-items: center; text-align: center; color: ${c.text}; }
    #mk-caption > div { transition: opacity .32s ease, transform .32s ease; }
    #mk-caption.out > div { opacity: 0; transform: translateY(6px); }
    #mk-caption b { display: block; font-size: 31px; font-weight: 660; letter-spacing: -0.025em; line-height: 1.15; }
    #mk-caption span { display: block; margin-top: 5px; font-size: 17px; color: ${c.muted}; letter-spacing: -0.005em; }
    #mk-card { inset: 0; display: grid; place-items: center; text-align: center; color: ${c.text}; background: ${c.bg} radial-gradient(ellipse 70% 55% at 50% 0%, ${c.glow}, transparent 70%);
      transition: opacity .45s ease; }
    #mk-card.out { opacity: 0; }
    #mk-card .logo svg { width: 290px; height: auto; display: block; margin: 0 auto 34px; }
    #mk-card h1 { margin: 0; font-size: 50px; font-weight: 660; letter-spacing: -0.035em; line-height: 1.08; max-width: 900px; }
    #mk-card p { margin: 22px 0 0; font-size: 21px; color: ${c.muted}; }
    #mk-card p.url { margin-top: 30px; font: 600 24px ui-monospace, 'SF Mono', Menlo, monospace; color: ${c.text}; }
    #mk-keys { left: 50%; bottom: 58px; transform: translateX(-50%) translateY(6px); display: flex; gap: 7px; align-items: center; opacity: 0; transition: opacity .14s, transform .14s; }
    #mk-keys.on { opacity: 1; transform: translateX(-50%); }
    #mk-keys kbd { min-width: 40px; padding: 10px 12px; border-radius: 9px; text-align: center; font: 600 17px/1 'Inter Variable', Inter, sans-serif;
      background: #18181e; color: #f4f4f6; border: 1px solid #44444f; box-shadow: 0 3px 0 #000, 0 10px 30px #00000055; }
    #mk-keys span { padding: 10px 13px; border-radius: 9px; font: 500 16px/1 'Inter Variable', Inter, sans-serif; color: #18181e; background: #f4f4f6; box-shadow: 0 10px 30px #00000040; }
    #mk-agent { right: ${left + 34}px; bottom: 62px; width: 470px; border-radius: 12px; background: #121217f2; color: #e6e6ee; border: 1px solid #ffffff22;
      box-shadow: 0 24px 60px -10px #000000b0; font: 14px/1.55 ui-monospace, 'SF Mono', Menlo, monospace; overflow: hidden;
      opacity: 0; transform: translateY(14px); transition: opacity .3s ease, transform .3s ease; }
    #mk-agent.on { opacity: 1; transform: none; }
    #mk-agent header { display: flex; gap: 8px; align-items: center; padding: 9px 14px; border-bottom: 1px solid #ffffff18; font: 600 13px 'Inter Variable', Inter, sans-serif; color: #c9c9d6; }
    #mk-agent header i { width: 9px; height: 9px; border-radius: 50%; background: #d97757; }
    #mk-agent pre { margin: 0; padding: 12px 14px 14px; white-space: pre-wrap; font: inherit; }
    #mk-agent .k { color: #9ecbff; } #mk-agent .s { color: #b5e3a3; } #mk-agent .ok { color: #7ee0a1; } #mk-agent .d { color: #8a8a99; }
    #mk-cursor { left: 0; top: 0; width: 0; height: 0; opacity: 0; transition: opacity .2s; will-change: transform; }
    #mk-cursor.on { opacity: 1; }
    #mk-cursor svg { position: absolute; left: -3px; top: -2px; width: 30px; height: 30px; filter: drop-shadow(0 2px 3px #0000006b); transition: transform .08s; transform-origin: 3px 2px; }
    #mk-cursor .hand { display: none; left: -10px; top: -3px; transform-origin: 10px 3px; }
    #mk-cursor.pointer .arrow { display: none; } #mk-cursor.pointer .hand { display: block; }
    #mk-cursor.down svg { transform: scale(.86); }
    #mk-ring { width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; border: 3px solid #6c6cf0; opacity: 0; }
    #mk-ring.go { animation: mk-ring .5s ease-out; }
    @keyframes mk-ring { from { opacity: .85; transform: scale(.35); } to { opacity: 0; transform: scale(1.25); } }
  `;
  const ARROW = '<svg class="arrow" viewBox="0 0 24 24"><path d="M3.5 2.2 20 12.6l-7.3 1.3 4.4 7.6-2.9 1.6-4.4-7.7-5.6 4.9z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const HAND = '<svg class="hand" viewBox="0 0 24 24"><path d="M9.2 2.5c.9 0 1.6.7 1.6 1.6v6.1l.6-.1c.3-.8 1-1.3 1.8-1.2.7.1 1.2.5 1.4 1.1.4-.5 1-.8 1.7-.7.8.1 1.4.7 1.5 1.4.4-.3.9-.4 1.4-.3.9.2 1.4 1 1.4 1.9v4.4c0 3.3-2.6 5.8-5.9 5.8h-1.3c-2 0-3.8-1-4.9-2.6L4 14.3c-.5-.8-.3-1.8.5-2.3.7-.5 1.7-.3 2.2.4l.9 1.3V4.1c0-.9.7-1.6 1.6-1.6z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';

  const init = () => {
    const style = document.createElement('style');
    style.textContent = css;
    document.documentElement.append(style);
    const el = (id, html = '') => {
      const e = document.createElement('div');
      e.id = id;
      e.className = 'mk';
      e.innerHTML = html;
      document.documentElement.append(e);
      return e;
    };
    const caption = el('mk-caption', '<div></div>');
    const card = el('mk-card');
    const keys = el('mk-keys');
    const agent = el('mk-agent', '<header><i></i>Claude Code</header><pre></pre>');
    const ring = el('mk-ring');
    const cursor = el('mk-cursor', ARROW + HAND);
    caption.classList.add('out');

    addEventListener('mousemove', (e) => {
      cursor.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      cursor.classList.add('on');
      const target = document.elementFromPoint(e.clientX, e.clientY);
      cursor.classList.toggle('pointer', !!target && getComputedStyle(target).cursor === 'pointer');
    }, { capture: true, passive: true });
    addEventListener('mousedown', (e) => {
      cursor.classList.add('down');
      ring.style.left = `${e.clientX}px`;
      ring.style.top = `${e.clientY}px`;
      ring.classList.remove('go');
      void ring.offsetWidth;
      ring.classList.add('go');
    }, { capture: true, passive: true });
    addEventListener('mouseup', () => cursor.classList.remove('down'), { capture: true, passive: true });

    let keyTimer;
    window.__mk = {
      caption(title, sub) {
        const had = caption.firstChild.innerHTML !== '';
        caption.classList.add('out');
        setTimeout(() => {
          caption.firstChild.innerHTML = title ? `<b>${title}</b><span>${sub ?? ''}</span>` : '';
          if (title) caption.classList.remove('out');
        }, had ? 320 : 0);
      },
      card(html) {
        if (html) {
          card.innerHTML = `<div>${html.replace('{logo}', `<div class="logo">${logo}</div>`)}</div>`;
          card.classList.remove('out');
        } else card.classList.add('out');
      },
      keys(parts, label) {
        keys.replaceChildren(...parts.map((p) => Object.assign(document.createElement('kbd'), { textContent: p })));
        if (label) keys.append(Object.assign(document.createElement('span'), { textContent: label }));
        keys.classList.add('on');
        clearTimeout(keyTimer);
        keyTimer = setTimeout(() => keys.classList.remove('on'), 1000);
      },
      agent(html) {
        if (html === null) return agent.classList.remove('on');
        agent.querySelector('pre').innerHTML = html;
        agent.classList.add('on');
      },
    };
  };
  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
}

// Deterministic randomness, so both themes get the same pointer paths.
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYNAME = { Control: 'Ctrl', Backspace: '⌫', Enter: '↵', Escape: 'Esc' };

async function run(scheme) {
  const rand = random(85);
  const browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR, colorScheme: scheme, locale: 'en-US', timezoneId: 'Europe/Berlin' });
  const page = await context.newPage();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wait = (ms) => page.waitForTimeout(ms);
  const still = async (name) => { if (shots) await page.screenshot({ path: join(out, `${name}-${scheme}.png`) }); };
  const logo = readFileSync(join(root, 'app', 'public', 'brand', `selfbound-lockup-${scheme === 'dark' ? 'paper' : 'ink'}.svg`), 'utf8').replace(/ width="[^"]*" height="[^"]*"/, '');
  await page.addInitScript(stage, { scheme, top: TOP, left: LEFT, scale: SCALE, logo });
  const mk = (fn, ...args) => page.evaluate(([f, a]) => window.__mk[f](...a), [fn, args]);

  // Pointer: curved path, bell-shaped speed (minimum jerk), a small overshoot on long moves and a short
  // correction, slight tremor in the middle of the move. Real mouse events, so hover states show.
  let mouse = { x: W * 0.62, y: H * 0.78 };
  async function moveTo(x, y, pace = 1) {
    const from = { ...mouse };
    const dx = x - from.x;
    const dy = y - from.y;
    const d = Math.hypot(dx, dy);
    if (d < 1) return;
    const duration = (300 + 150 * Math.log2(d / 25 + 1)) * pace;
    const nx = -dy / d;
    const ny = dx / d;
    const bend = (rand() - 0.5) * Math.min(d * 0.32, 130);
    const over = d > 160 ? Math.min(14, d * 0.025) * (0.6 + rand() * 0.5) : 0;
    const to = { x: x + (dx / d) * over + nx * over * 0.3, y: y + (dy / d) * over + ny * over * 0.3 };
    const c1 = { x: from.x + dx * 0.28 + nx * bend, y: from.y + dy * 0.28 + ny * bend };
    const c2 = { x: from.x + dx * 0.78 + nx * bend * 0.35, y: from.y + dy * 0.78 + ny * bend * 0.35 };
    const steps = Math.max(10, Math.round(duration / 16));
    const start = Date.now();
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const s = t * t * t * (10 - 15 * t + 6 * t * t);
      const u = 1 - s;
      const tremor = Math.sin(Math.PI * t) * 0.7;
      const px = u * u * u * from.x + 3 * u * u * s * c1.x + 3 * u * s * s * c2.x + s * s * s * to.x + (rand() - 0.5) * tremor;
      const py = u * u * u * from.y + 3 * u * u * s * c1.y + 3 * u * s * s * c2.y + s * s * s * to.y + (rand() - 0.5) * tremor;
      await page.mouse.move(px, py);
      const lag = start + t * duration - Date.now();
      if (lag > 0) await sleep(lag);
    }
    if (over) {
      for (let i = 1; i <= 9; i++) {
        const t = i / 9;
        const s = t * t * (3 - 2 * t);
        await page.mouse.move(to.x + (x - to.x) * s, to.y + (y - to.y) * s);
        await sleep(17);
      }
    }
    mouse = { x, y };
  }
  async function point(locator, fx = 0.5, fy = 0.5, pace = 1) {
    const box = await locator.boundingBox();
    if (!box) throw new Error(`Not visible: ${locator}`);
    const x = box.x + box.width * fx + (rand() - 0.5) * Math.min(10, box.width * 0.1);
    const y = box.y + box.height * fy + (rand() - 0.5) * Math.min(4, box.height * 0.15);
    await moveTo(x, y, pace);
  }
  async function click(locator, fx, fy, pace) {
    await point(locator, fx, fy, pace);
    await sleep(110 + rand() * 120);
    await page.mouse.down();
    await sleep(75 + rand() * 40);
    await page.mouse.up();
  }
  // Press a key or chord ("Control+z") and show it.
  async function press(chord, label, after = 500) {
    const parts = chord.split('+').map((k) => KEYNAME[k] ?? k.toUpperCase());
    await mk('keys', parts, label);
    await page.keyboard.press(chord);
    await wait(after);
  }
  async function type(text, delay = 65) {
    for (const ch of text) {
      await page.keyboard.type(ch);
      await sleep(delay + rand() * 45);
    }
  }

  await page.goto(`${base}/team/ORB`);
  await page.waitForSelector('[data-testid="issue-row"]', { timeout: 30000 });
  await mk('card', '{logo}<h1>The issue tracker for solo developers and their AI agents.</h1>');
  await wait(1200);

  // Frames from the DevTools screencast, with their timestamps.
  const frames = [];
  const cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    frames.push({ t: metadata.timestamp, data });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 94, maxWidth: W * DPR, maxHeight: H * DPR, everyNthFrame: 1 });
  const began = Date.now();
  const at = (label) => console.log(`${((Date.now() - began) / 1000).toFixed(1).padStart(5)} s  ${label}`);

  // 0. Title.
  at('title');
  await page.mouse.move(mouse.x, mouse.y);
  await wait(1900);
  await mk('card', null);
  await mk('caption', 'Answers within a frame.', 'Lists, boards and issues open instantly, even with 10,000 issues.');
  await wait(250);

  // 1. Speed: list to board, open a card, back to the board.
  at('speed');
  await click(page.getByTestId('layout-toggle'));
  await page.waitForSelector('[data-testid="board"]');
  await wait(450);
  await still('board');
  await click(page.getByTestId('issue-card').nth(1), 0.35, 0.4);
  await page.waitForSelector('[data-testid="detail"]');
  await wait(750);
  await press('Escape', 'back', 300);
  await moveTo(W * 0.8, H * 0.7);

  // 2. Keyboard on the board: next card, move it to another column with a status, undo.
  at('keyboard');
  await mk('caption', 'Runs on the keyboard.', 'Every action has a key, and undo covers nearly everything.');
  await wait(350);
  await press('j', 'next', 300);
  await press('s', 'status', 400);
  await type('review');
  await wait(200);
  await press('Enter', undefined, 750);
  await still('status');
  await press('Control+z', 'undo', 700);

  // 3. An agent creates an issue over MCP; the toast and the inbox count follow without a reload.
  at('agent');
  await mk('caption', 'Your AI agents work in it over MCP.', 'Claude Code, Codex and other agents create and update issues.');
  await moveTo(W * 0.42, H * 0.5, 1.2);
  const call = `<span class="d">›</span> <span class="k">create_issues</span>\n  team: <span class="s">"ORB"</span>\n  title: <span class="s">"${AGENT_TITLE}"</span>\n  priority: <span class="s">"high"</span>`;
  for (let n = 1; n <= 4; n++) {
    await mk('agent', call.split('\n').slice(0, n).join('\n'));
    await sleep(230);
  }
  const created = (await agentCreatesIssue()) ?? 'the issue';
  await mk('agent', `${call}\n<span class="ok">✓ created ${created}</span>`);
  await wait(1300);
  await still('agent');

  // 4. Inbox: open what the agent created.
  at('inbox');
  await mk('caption', 'What they create waits in your inbox.', 'Look at it, keep it or clear it, then move on.');
  await mk('agent', null);
  await click(page.getByTestId('nav-inbox'), 0.3, 0.5);
  await page.waitForSelector(`text=${AGENT_TITLE}`);
  await wait(500);
  await click(page.locator('[data-testid="issue-row"]', { hasText: AGENT_TITLE }).first(), 0.4, 0.4);
  await wait(1100);
  await still('inbox');

  // 5. Pull requests.
  at('pulls');
  await mk('caption', 'Pull requests, right on the issue.', 'State, checks and reviews, live from GitHub.');
  await click(page.getByTestId('nav-pulls'), 0.35, 0.5);
  await page.waitForSelector('[data-testid="pull-row"]');
  await wait(300);
  await click(page.getByTestId('pull-row').nth(1), 0.4, 0.45);
  await wait(1500);
  await still('pulls');

  // 6. Closing card.
  at('end');
  await mk('caption', null);
  await mk('card', '{logo}<h1>Open source. Self-hosted.</h1><p>Your own Convex, Clerk and static host. AGPL-3.0.</p><p class="url">selfbound.kiumu.app</p>');
  await wait(2400);
  at('stop');
  // The screencast only sends changed frames; the last one lasts until here.
  const stopped = Date.now() / 1000;

  await cdp.send('Page.stopScreencast');
  await context.close();
  await browser.close();
  encode(frames, stopped, scheme);
}

/** Variable-rate screencast frames → constant 30 fps master, BT.709 like the pr-media skill. */
function encode(frames, stopped, scheme) {
  const dir = join(out, `frames-${scheme}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const lines = ['ffconcat version 1.0'];
  frames.forEach((f, i) => {
    const name = `${String(i).padStart(5, '0')}.jpg`;
    writeFileSync(join(dir, name), Buffer.from(f.data, 'base64'));
    const next = frames[i + 1]?.t ?? Math.max(stopped, f.t + 0.04);
    lines.push(`file '${name}'`, `duration ${(next - f.t).toFixed(4)}`);
  });
  lines.push(`file '${String(frames.length - 1).padStart(5, '0')}.jpg'`);
  writeFileSync(join(dir, 'frames.txt'), `${lines.join('\n')}\n`);
  const file = join(out, `demo-${scheme}.mp4`);
  const vf = 'fps=30,scale=1920:1200:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv444p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709';
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.txt'), '-an', '-vf', vf, '-fps_mode', 'cfr', '-r', '30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '12', file], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg failed');
  console.log(`${file} (${frames.length} frames)`);
}

for (const scheme of schemes) await run(scheme);
