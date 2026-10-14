// Walkthrough video of the app (P1, synthetic data "small", 1440×900) with a caption per step.
// Separate from the performance run: recording costs time itself; the video is for watching, not
// for measuring.
//
// Usage: node perf/record.ts [--out=<file.mp4>] [--reuse-data] [--skip-build] [--keep] [--encode-only]
// Output: raw files in /tmp/selfbound-media/ (walkthrough-desktop.webm, walkthrough-mobile.webm) and
// walkthrough.mp4 with captions (H.264), copied to --out if given. Needs ffmpeg and fontconfig.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { appBase, startStack } from './stack.ts';

const argv = process.argv.slice(2);
const args = new Set(argv);
const out = argv.find((a) => a.startsWith('--out='))?.slice(6);
const RAW = '/tmp/selfbound-media';
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const FPS = 25;

interface Caption {
  at: number;
  text: string;
}

function sh(cmd: string, cmdArgs: string[]) {
  return execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

/**
 * Find a font via fontconfig instead of hard-coding a path. fc-match always returns some
 * substitute; the first pattern whose family really matches wins.
 */
function font() {
  const wanted: [string, string][] = [['Inter:semibold', 'Inter'], ['Noto Sans:semibold', 'Noto Sans'], ['DejaVu Sans:bold', 'DejaVu Sans'], ['sans-serif:bold', '']];
  for (const [pattern, family] of wanted) {
    try {
      const [fam, file] = sh('fc-match', ['-f', '%{family}|%{file}', pattern]).split('|');
      if (file && (!family || fam.split(',').includes(family))) return file;
    } catch {
      // next pattern
    }
  }
  throw new Error('No font found (fc-match)');
}

function recorder(page: Page, captions: Caption[]) {
  const t0 = Date.now();
  const pause = (ms: number) => page.waitForTimeout(ms);
  return {
    pause,
    /** Point in the video where the walkthrough starts (loading is cut off) */
    now: () => (Date.now() - t0) / 1000,
    caption: (text: string) => captions.push({ at: (Date.now() - t0) / 1000, text }),
    key: async (k: string, wait = 450) => {
      await page.keyboard.press(k);
      await pause(wait);
    },
    type: async (text: string, wait = 350) => {
      await page.keyboard.type(text, { delay: 85 });
      await pause(wait);
    },
  };
}

async function desktopTour(captions: Caption[]) {
  const browser = await chromium.launch({ channel: 'chromium' });
  const dir = join(RAW, 'desktop');
  rmSync(dir, { recursive: true, force: true });
  const context = await browser.newContext({ viewport: DESKTOP, colorScheme: 'dark', recordVideo: { dir, size: DESKTOP } });
  const page = await context.newPage();
  const r = recorder(page, captions);
  await page.goto(`${appBase('P1')}/all?group=none&order=created`);
  await page.getByTestId('issue-row').first().waitFor();
  await page.waitForFunction(() => performance.getEntriesByName('selfbound-synced').length > 0, null, { timeout: 30_000 });
  await page.mouse.move(2, DESKTOP.height - 10);
  await r.pause(300);
  const start = r.now();

  r.caption('List: all issues, there instantly (synthetic test data)');
  await r.pause(2200);
  r.caption('J / K: move focus');
  for (let i = 0; i < 5; i++) await r.key('j', 170);
  await r.key('k', 170);
  await r.key('k', 500);
  r.caption('Space: peek with description, arrow down moves on');
  await r.key(' ', 1300);
  await r.key('ArrowDown', 1000);
  await r.key('Escape', 400);
  r.caption('S: change status ("prog", Enter), Ctrl Z undoes');
  await r.key('s', 400);
  await r.type('prog');
  await r.key('Enter', 900);
  await r.key('Control+z', 900);
  r.caption('F: filter "priority: high", clicking the chip removes it');
  await r.key('f', 400);
  await r.type('high');
  await r.key('Enter', 1100);
  await page.getByTestId('filter-chip-remove').click();
  await page.mouse.move(2, DESKTOP.height - 10);
  await r.pause(700);
  r.caption('Ctrl K: command menu, searchable');
  await r.key('Control+k', 500);
  await r.type('status', 700);
  await r.key('Escape', 400);
  r.caption('C: create an issue, Ctrl Enter saves, the row appears instantly');
  await r.key('c', 500);
  await r.type('Walkthrough: new issue from the video');
  await r.key('Control+Enter', 1600);
  r.caption('Enter: open the detail, write a comment, Ctrl Enter sends');
  await r.key('Enter', 900);
  await page.getByTestId('comment-input').click();
  await r.type('Looks good, adding it to the sprint.', 300);
  await r.key('Control+Enter', 1100);
  await r.key('Escape', 200);
  await r.key('Escape', 600);
  r.caption('G T: triage, then 1, "todo", Enter: accepted');
  await r.key('g', 120);
  await r.key('t', 900);
  await r.key('1', 500);
  await r.type('todo', 300);
  await r.key('Enter', 1100);
  r.caption('G S: current sprint');
  await r.key('g', 120);
  await r.key('s', 2200);
  await r.pause(400);
  const end = r.now();

  await context.close();
  await browser.close();
  const file = join(RAW, 'walkthrough-desktop.webm');
  renameSync((await page.video()!.path()), file);
  rmSync(dir, { recursive: true, force: true });
  return { file, start, end };
}

async function phoneTour(captions: Caption[]) {
  const browser = await chromium.launch({ channel: 'chromium' });
  const dir = join(RAW, 'mobile');
  rmSync(dir, { recursive: true, force: true });
  const context = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true, colorScheme: 'dark', recordVideo: { dir, size: PHONE } });
  const page = await context.newPage();
  const r = recorder(page, captions);
  await page.goto(`${appBase('P1')}/all`);
  await page.getByTestId('issue-row').first().waitFor();
  await page.waitForFunction(() => performance.getEntriesByName('selfbound-synced').length > 0, null, { timeout: 30_000 });
  await r.pause(300);
  const start = r.now();
  r.caption('Phone: one column, large rows');
  await r.pause(2000);
  await page.getByTestId('issue-row').nth(2).tap();
  await page.getByTestId('detail').waitFor();
  r.caption('Phone: full-screen detail');
  await r.pause(2200);
  await page.getByTestId('detail-back-mobile').tap();
  await r.pause(900);
  const end = r.now();
  await context.close();
  await browser.close();
  const file = join(RAW, 'walkthrough-mobile.webm');
  renameSync((await page.video()!.path()), file);
  rmSync(dir, { recursive: true, force: true });
  return { file, start, end };
}

/** drawtext filter: one text file per caption (no escaping problems with quotes). */
function subtitles(captions: Caption[], start: number, end: number, fontFile: string, name: string, size: number) {
  return captions
    .map((c, i) => {
      const from = c.at - start;
      const to = (captions[i + 1]?.at ?? end) - start;
      const textFile = join(RAW, `${name}-${i}.txt`);
      writeFileSync(textFile, c.text);
      return `drawtext=fontfile='${fontFile}':textfile='${textFile}':fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.72:boxborderw=14:x=(w-text_w)/2:y=h-text_h-40:enable='between(t,${from.toFixed(2)},${to.toFixed(2)})'`;
    })
    .join(',');
}

async function main() {
  mkdirSync(RAW, { recursive: true });
  const plan = join(RAW, 'walkthrough.json');
  // --encode-only: only redo captions and encoding, from the raw videos of the last run
  if (!args.has('--encode-only')) {
    const fresh = !args.has('--reuse-data');
    const stack = await startStack({ pin: false, build: !args.has('--skip-build'), keep: args.has('--keep'), fresh });
    try {
      await stack.seed('small', fresh);
      await stack.usePreview('P1');
      const desktopCaptions: Caption[] = [];
      const phoneCaptions: Caption[] = [];
      const desktop = await desktopTour(desktopCaptions);
      const phone = await phoneTour(phoneCaptions);
      writeFileSync(plan, JSON.stringify({ desktop: { ...desktop, captions: desktopCaptions }, phone: { ...phone, captions: phoneCaptions } }, null, 2));
    } finally {
      await stack.stop();
    }
  }
  encode(JSON.parse(readFileSync(plan, 'utf8')) as Plan);
}

interface Segment {
  file: string;
  start: number;
  end: number;
  captions: Caption[];
}
interface Plan {
  desktop: Segment;
  phone: Segment;
}

function encode({ desktop, phone }: Plan) {
  const fontFile = font();
  const combined = join(RAW, 'walkthrough.mp4');
  const d = desktop.end - desktop.start;
  const p = phone.end - phone.start;
  // Phone part: scaled to 900 px height, centred on a dark background in 1440×900
  const filter = [
    `[0:v]fps=${FPS},trim=start=${desktop.start.toFixed(2)}:duration=${d.toFixed(2)},setpts=PTS-STARTPTS,setsar=1,${subtitles(desktop.captions, desktop.start, desktop.end, fontFile, 'desktop', 30)}[a]`,
    `[1:v]fps=${FPS},trim=start=${phone.start.toFixed(2)}:duration=${p.toFixed(2)},setpts=PTS-STARTPTS,scale=-2:${DESKTOP.height},pad=${DESKTOP.width}:${DESKTOP.height}:(ow-iw)/2:0:color=0x101012,setsar=1,${subtitles(phone.captions, phone.start, phone.end, fontFile, 'mobile', 30)}[b]`,
    '[a][b]concat=n=2:v=1:a=0,format=yuv420p[v]',
  ].join(';');
  sh('ffmpeg', ['-y', '-loglevel', 'warning', '-i', desktop.file, '-i', phone.file, '-filter_complex', filter, '-map', '[v]', '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', '-r', String(FPS), combined]);
  console.log(`Video: ${combined} (${(d + p).toFixed(1)} s, font ${fontFile})`);
  if (out) {
    copyFileSync(combined, resolve(out));
    console.log(`Copied to ${resolve(out)}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 2;
}
