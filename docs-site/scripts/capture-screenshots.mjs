#!/usr/bin/env node
// Screenshots of the app for the docs site (docs-site/src/assets/screenshots/), light and dark.
//
// Starts nothing itself. It expects the app running locally on the synthetic sample data, e.g.:
//   node tooling/local.mjs --seed small --reset --app dev      (fresh seed, app on 127.0.0.1:5412)
// then, in a second shell:
//   node docs-site/scripts/capture-screenshots.mjs [app-url] [--only list,board,...] [--out <dir>]
//
// app-url defaults to SELFBOUND_APP_URL or http://127.0.0.1:5412. The script adds a few knowledge pages
// to team ORB (once) through the local backend; URL and token come from SELFBOUND_CONVEX_URL /
// SELFBOUND_TOKEN or else from app/.env.local, which tooling/local.mjs writes. Only use it against a local
// backend with sample data: whatever the app shows ends up in the public docs.
//
// Viewport 1440x900 at 2x, PNGs reduced to a palette with sharp (a docs-site dependency).
// The themes shot switches the appearance (stored on the server) and resets it to Selfbound afterwards;
// the inbox shot marks its first entry read, so start from a fresh seed for identical counts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envVar } from '../../tooling/lib/env.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Playwright and Convex come from the e2e package, sharp from the docs site.
const fromE2e = createRequire(join(root, 'e2e', 'package.json'));
const { chromium, devices } = fromE2e('@playwright/test');
const { ConvexHttpClient } = fromE2e('convex/browser');
const { anyApi } = fromE2e('convex/server');
const sharp = createRequire(join(root, 'docs-site', 'package.json'))('sharp');

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const base = (argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')) ?? envVar('APP_URL') ?? 'http://127.0.0.1:5412').replace(/\/$/, '');
const out = opt('out') ?? join(root, 'docs-site', 'src', 'assets', 'screenshots');
const only = opt('only')?.split(',');
mkdirSync(out, { recursive: true });

const DEFAULT_LOOK = { dark: 'selfbound', light: 'selfbound', sans: 'inter', mono: 'system', overrides: [] };

function backend() {
  const env = existsSync(join(root, 'app', '.env.local')) ? readFileSync(join(root, 'app', '.env.local'), 'utf8') : '';
  const url = envVar('CONVEX_URL') ?? /^VITE_CONVEX_URL=(.*)$/m.exec(env)?.[1]?.trim();
  const token = envVar('TOKEN') ?? /^VITE_DEV_TOKEN=(.*)$/m.exec(env)?.[1]?.trim();
  if (!url || !token) throw new Error('No local backend: set SELFBOUND_CONVEX_URL and SELFBOUND_TOKEN or run tooling/local.mjs first.');
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) throw new Error(`Refusing a non-local backend: ${url}`);
  const client = new ConvexHttpClient(url);
  client.setAuth(token);
  return client;
}

/** Sample knowledge pages in ORB, so the wiki shot has a tree and a page with text. */
async function prepareWiki(client) {
  const meta = await client.query(anyApi.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB');
  if (!team.wiki) await client.mutation(anyApi.teams.update, { teamId: team._id, wiki: 'on' });
  const existing = await client.query(anyApi.wiki.list, { teamId: team._id });
  const find = (title) => (Array.isArray(existing) ? existing : (existing.articles ?? [])).find((a) => a.title === title);
  const create = async (title, markdown, parentId) =>
    find(title)?._id ?? (await client.mutation(anyApi.wiki.create, { teamId: team._id, title, markdown, ...(parentId ? { parentId } : {}) })).articleId;

  const guide = await create('Release process', RELEASE_MD);
  await create('Release checklist', 'Steps before a release: changelog, smoke test, tag.', guide);
  await create('Rollback', 'How to go back to the previous build within five minutes.', guide);
  await create('Architecture overview', 'Data flow from the store to the list.');
  await create('Onboarding', 'First week: setup, conventions, the keyboard map.');
  return guide;
}

const RELEASE_MD = `Orbit ships every second Friday, at the end of a sprint. This page is the short version; the details are in the subpages.

## Before the release

1. All issues of the sprint are *Done* or moved to the next sprint.
2. The changelog lists every user-facing change.
3. A smoke test on the preview build passes (sign-in, list, create, search).

## Release day

- Tag the build: \`git tag v2.14.0\`
- Watch the error rate for an hour.
- Post the changelog in the team channel.

> If something looks wrong, roll back first and investigate afterwards.

\`\`\`sh
pnpm build && pnpm deploy --channel stable
\`\`\`
`;

// Native date inputs follow the system locale, not the context locale.
const browser = await chromium.launch({ args: ['--lang=en-US'], env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', LANGUAGE: 'en_US' } });
const errors = [];
// Phone pages: no mouse moves (a pointer would show hover states a phone never has).
const touch = new WeakSet();

async function newPage(scheme, opts = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: 'reduce',
    locale: 'en-US',
    timezoneId: 'UTC',
    // The service worker would cache the dev build between runs.
    serviceWorkers: 'block',
    ...opts,
  });
  const page = await context.newPage();
  if (opts.hasTouch) touch.add(page);
  page.on('pageerror', (e) => errors.push(e.message));
  return page;
}

/** Opens a path and waits until the data is live and fonts are in. */
async function ready(page, path, selector = '[data-testid="issue-row"], [data-testid="issue-card"], [data-testid="empty-state"], [data-testid="detail"]') {
  await page.goto(base + path);
  await page.waitForSelector(selector, { timeout: 20_000 });
  await page
    .waitForFunction(() => window.__selfbound?.app?.store.sync.get().phase === 'live', null, { timeout: 10_000 })
    .catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await idle(page);
}

/** Mouse out of the way (hover moves the focus in lists), then a short pause for late renders. */
async function idle(page, ms = 500) {
  const { width, height } = page.viewportSize();
  if (!touch.has(page)) await page.mouse.move(width - 1, height - 1);
  await page.waitForTimeout(ms);
}

const press = async (page, ...keys) => {
  for (const key of keys) await page.keyboard.press(key);
};

// Each shot: schemes to take (default both), the steps, page options. `run` may return { clip } or { buffer }.
const shots = {
  list: { run: (p) => ready(p, '/team/ORB') },
  board: { run: (p) => ready(p, '/team/ORB?layout=board') },
  issue: {
    run: async (p) => {
      // Short description, parent, comments and history: everything fits on one screen.
      await ready(p, '/issue/ORB-83', '[data-testid="detail"]');
      await idle(p, 800);
    },
  },
  'command-menu': {
    run: async (p) => {
      await ready(p, '/team/ORB');
      await press(p, 'Control+k');
      await idle(p, 300);
    },
  },
  'create-issue': {
    run: async (p) => {
      await ready(p, '/team/ORB');
      await press(p, 'c');
      await p.keyboard.type('Show sprint progress on team cards');
      await idle(p, 300);
    },
  },
  peek: {
    schemes: ['light'],
    run: async (p) => {
      await ready(p, '/team/ORB');
      await press(p, 'j', 'j', 'j', ' ');
      // The peek fades in its description; wait for the end.
      await idle(p, 2000);
    },
  },
  'split-view': {
    run: async (p) => {
      await ready(p, '/team/ORB');
      await press(p, 'j', 'j', 'Shift+Space');
      await p.waitForSelector('[data-testid="split-detail"] [data-testid="detail-key"]');
      await idle(p, 1000);
    },
  },
  triage: { schemes: ['light'], run: (p) => ready(p, '/triage') },
  inbox: {
    schemes: ['light'],
    run: async (p) => {
      await ready(p, '/inbox');
      await p.getByTestId('issue-row').first().click();
      await p.waitForSelector('[data-testid="split-detail"] [data-testid="detail-key"]');
      await idle(p, 1000);
    },
  },
  sprint: { run: (p) => ready(p, '/sprint') },
  'sprint-plan': { schemes: ['light'], run: (p) => ready(p, '/sprint/plan', '[data-testid="issue-row"], [data-testid="plan-create"]') },
  projects: { schemes: ['light'], run: (p) => ready(p, '/team/ORB/projects', '[data-testid="projects-page"]') },
  // One project's issues (the projects page itself is short with the sample data).
  project: {
    schemes: ['light'],
    run: async (p) => {
      await ready(p, '/team/ORB/projects', '[data-testid="projects-page"]');
      await p.getByText('Orbit · Export').first().click();
      await p.waitForSelector('[data-testid="issue-row"]');
      await idle(p, 800);
    },
  },
  knowledge: {
    run: async (p, { article }) => {
      await ready(p, `/wiki/${article}`, '[data-testid="article"]');
      const row = p.locator(`[data-testid="wiki-row"][data-id="${article}"]`);
      if ((await row.getAttribute('aria-expanded')) !== 'true') await row.getByTestId('wiki-toggle').click();
      await idle(p);
    },
  },
  pr: {
    run: async (p) => {
      await ready(p, '/pr/acme/orbit-app/128', '[data-testid="pr-unconfigured"], [data-testid="pr-error"], h1');
      // Without GITHUB_TOKEN the local backend shows a setup hint a configured instance does not have.
      await p.addStyleTag({ content: '[data-testid="pr-unconfigured"] { display: none !important; }' });
      await idle(p);
    },
  },
  shortcuts: {
    schemes: ['dark'],
    run: async (p) => {
      await ready(p, '/team/ORB');
      await press(p, '?');
      await idle(p, 300);
    },
  },
  filter: {
    schemes: ['light'],
    run: async (p) => {
      await ready(p, '/team/ORB');
      await press(p, 'f');
      await idle(p, 300);
    },
  },
  'settings-appearance': {
    run: async (p) => {
      await ready(p, '/settings/appearance', '[data-testid="theme-picker-dark"]');
    },
  },
  themes: {
    schemes: ['dark'],
    run: async (p, { client }) => {
      await client.mutation(anyApi.appearance.save, { ...DEFAULT_LOOK, dark: 'catppuccin-mocha' });
      try {
        await ready(p, '/team/ORB');
        await p.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-panel').trim() === '#1e1e2e', null, { timeout: 15_000 });
        await idle(p, 500);
        return { buffer: await p.screenshot() };
      } finally {
        await client.mutation(anyApi.appearance.save, DEFAULT_LOOK);
      }
    },
  },
  'settings-agents': { schemes: ['light'], run: (p) => ready(p, '/settings/agents', '[data-testid="agent-row"]') },
  'settings-language': { schemes: ['light'], run: (p) => ready(p, '/settings/general', '[data-testid="settings-locale"]') },
  'mobile-list': {
    schemes: ['light'],
    page: () => {
      const { defaultBrowserType: _, ...iphone } = devices['iPhone 13'];
      return { ...iphone, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 };
    },
    run: async (p) => {
      await ready(p, '/team/ORB');
      await idle(p, 1500);
    },
  },
};

/** Palette PNG (libimagequant via sharp): a fraction of the size. No dithering: it leaves patterns on soft fades. */
async function save(buffer, file) {
  const png = await sharp(buffer).png({ palette: true, quality: 100, dither: 0, effort: 10, compressionLevel: 9 }).toBuffer();
  writeFileSync(join(out, file), png);
  return png.length;
}

const client = backend();
const article = await prepareWiki(client);
// Earlier runs might have left a theme behind.
await client.mutation(anyApi.appearance.save, DEFAULT_LOOK);

for (const [name, shot] of Object.entries(shots)) {
  if (only && !only.includes(name)) continue;
  for (const scheme of shot.schemes ?? ['light', 'dark']) {
    const page = await newPage(scheme, shot.page?.() ?? {});
    try {
      const result = await shot.run(page, { client, article });
      const buffer = result?.buffer ?? (await page.screenshot({ ...(result?.clip ? { clip: result.clip } : {}) }));
      const file = `${name}-${scheme}.png`;
      const size = await save(buffer, file);
      console.log(`${file}  ${Math.round(size / 1024)} KB`);
    } catch (error) {
      console.error(`${name}-${scheme}: ${error.message}`);
      process.exitCode = 1;
    } finally {
      await page.context().close();
    }
  }
}
await browser.close();
if (errors.length) console.log(`Browser errors:\n${[...new Set(errors)].join('\n')}`);
