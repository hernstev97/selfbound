// Sample PRs for the local test data: six PRs on six issues, one per group of the pull requests
// page (ready, checks failing, running, blocked, draft, merged), with description, checks, comments and
// reviews, as a fetch from GitHub would store them. No real repo, no real people; images as data:
// SVGs so nothing loads from the network.
//
// Runs with Node type stripping (scripts/seed.ts): only imports with a file extension, only `import type`.

import type { PrCheck, PrDetail, PrItem, PrState } from '../convex/shared/pullRequests.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface SamplePullRequest {
  issueSeqs: number[];
  closes: boolean;
  pr: { repo: string; number: number; title: string; url: string; state: PrState; branch: string; author: string; updatedAt: number; mergedAt?: number; headSha: string };
  detail: Omit<PrDetail, 'fetchedAt' | 'error'>;
  items: PrItem[];
}

const REPO = 'acme/orbit-app';
const person = (login: string, bot = false) => ({ login, bot, url: `https://github.com/${login}` });
const alex = person('alex-example');
const rabbit = person('coderabbitai[bot]', true);
const vercel = person('vercel[bot]', true);
const mira = person('mira-review');

const svg = (label: string, color: string) =>
  `data:image/svg+xml;base64,${Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300"><rect width="640" height="300" rx="16" fill="${color}"/><text x="320" y="160" font-family="sans-serif" font-size="28" fill="#fff" text-anchor="middle">${label}</text></svg>`,
  ).toString('base64')}`;

function check(key: string, name: string, state: PrCheck['state'], at: number, extra: Partial<PrCheck> = {}): PrCheck {
  return { key, name, source: 'check', app: 'GitHub Actions', state, url: `https://github.com/${REPO}/actions/runs/1/job/${key.split(':')[1]}`, startedAt: at - 4 * MIN, ...(state === 'pending' ? {} : { completedAt: at }), ...extra };
}

/** `issues`: the generated issues (seq, teamKey, status); matching ones are picked. */
export function samplePullRequests(issues: { seq: number; teamKey: string; status: string }[], now: number): SamplePullRequest[] {
  const pick = (status: string, skip: number[] = []) => issues.find((i) => i.teamKey === 'ORB' && i.status === status && !skip.includes(i.seq))?.seq ?? issues.find((i) => !skip.includes(i.seq))!.seq;
  const first = pick('in_progress');
  const second = pick('in_review', [first]);
  const third = pick('in_review', [first, second]);
  const fourth = pick('todo', [first, second, third]);
  const fifth = pick('in_progress', [first, second, third, fourth]);
  const sixth = pick('in_progress', [first, second, third, fourth, fifth]);
  const base = { mergeMethods: ['merge', 'squash', 'rebase'] as PrDetail['mergeMethods'], deleteBranchOnMerge: false, requestedReviewers: [], labels: [] };

  return [
    {
      issueSeqs: [first],
      closes: true,
      pr: { repo: REPO, number: 128, title: 'Team cards: show sprint progress', url: `https://github.com/${REPO}/pull/128`, state: 'open', branch: 'orb-1-team-cards', author: alex.login, updatedAt: now - 20 * MIN, headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' },
      detail: {
        ...base,
        bodyHtml: `<h2>What</h2><ul><li>Team cards show done and open items in the current sprint.</li><li>The count no longer jumps when an issue moves to another team.</li></ul><h2>Screenshots</h2><p><img src="${svg('Team card, dark', '#3b3f6b')}" alt="Team card dark"></p><p><a href="${svg('Team card, light', '#8a93d8')}"><img src="${svg('Team card, light', '#8a93d8')}" alt="Team card light"></a></p><h2>Checks</h2><ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" checked disabled> Vitest green</li><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled> e2e on a phone</li></ul><pre><code>pnpm test</code></pre>`,
        author: alex,
        createdAt: now - 26 * HOUR,
        baseRef: 'main',
        headRef: 'orb-1-team-cards',
        headRepo: REPO,
        headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        draft: false,
        mergeState: 'unstable',
        additions: 214,
        deletions: 37,
        changedFiles: 9,
        commits: 4,
        labels: [{ name: 'feature', color: 'a2eeef' }],
        requestedReviewers: [mira],
        headBranchDeletable: true,
        checks: [
          check('check:9001', 'CI / check', 'failure', now - 18 * MIN, { summary: '2 tests failed' }),
          check('check:9002', 'CI / e2e', 'pending', now - 15 * MIN),
          check('check:9003', 'CI / typecheck', 'success', now - 19 * MIN),
          { key: 'status:Vercel', name: 'Vercel', source: 'status', app: 'Vercel', state: 'success', url: 'https://vercel.com/acme', summary: 'Preview ready', completedAt: now - 17 * MIN },
        ],
      },
      items: [
        { key: 'comment:501', kind: 'comment', author: vercel, html: '<p>The preview is ready: <a href="https://vercel.com/acme">orbit-app-git-team-cards.vercel.app</a></p>', createdAt: now - 25 * HOUR, url: `https://github.com/${REPO}/pull/128#issuecomment-501` },
        {
          key: 'review:601',
          kind: 'review',
          author: rabbit,
          reviewState: 'commented',
          html: `<h2>Walkthrough</h2><p>The team cards now read their numbers from the sprint. ${'The counter is updated whenever an issue is added or removed. '.repeat(30)}</p><details><summary>Comments (2)</summary><p>See the line comments.</p></details>`,
          createdAt: now - 24 * HOUR,
          url: `https://github.com/${REPO}/pull/128#pullrequestreview-601`,
        },
        { key: 'review_comment:701', kind: 'review_comment', author: rabbit, html: '<p>This misses the case where the issue no longer has a sprint.</p>', createdAt: now - 24 * HOUR, url: `https://github.com/${REPO}/pull/128#discussion_r701`, path: 'core/src/app/teamStats.ts', line: 42 },
        { key: 'review_comment:702', kind: 'review_comment', author: alex, html: '<p>Fixed in 3f2a1c0.</p>', createdAt: now - 3 * HOUR, url: `https://github.com/${REPO}/pull/128#discussion_r702`, path: 'core/src/app/teamStats.ts', line: 42, replyTo: 'review_comment:701' },
        { key: 'comment:502', kind: 'comment', author: mira, html: '<p>Looks good. Could you attach a light mode screenshot too?</p>', createdAt: now - 2 * HOUR, url: `https://github.com/${REPO}/pull/128#issuecomment-502` },
      ],
    },
    {
      issueSeqs: [first],
      closes: false,
      pr: { repo: REPO, number: 121, title: 'Team cards: scaffold', url: `https://github.com/${REPO}/pull/121`, state: 'merged', branch: 'orb-1-scaffold', author: alex.login, updatedAt: now - 3 * 24 * HOUR, mergedAt: now - 3 * 24 * HOUR, headSha: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c' },
      detail: {
        ...base,
        bodyHtml: '<p>First step: cards without numbers, only name and logo.</p>',
        author: alex,
        mergedBy: alex,
        createdAt: now - 4 * 24 * HOUR,
        closedAt: now - 3 * 24 * HOUR,
        baseRef: 'main',
        headRef: 'orb-1-scaffold',
        headRepo: REPO,
        headSha: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c',
        draft: false,
        mergeState: 'unknown',
        additions: 88,
        deletions: 4,
        changedFiles: 3,
        commits: 1,
        headBranchDeletable: false,
        checks: [check('check:8001', 'CI / check', 'success', now - 3 * 24 * HOUR - HOUR)],
      },
      items: [{ key: 'review:602', kind: 'review', author: mira, reviewState: 'approved', html: '', createdAt: now - 3 * 24 * HOUR - 2 * HOUR, url: `https://github.com/${REPO}/pull/121#pullrequestreview-602` }],
    },
    {
      issueSeqs: [second],
      closes: true,
      pr: { repo: REPO, number: 130, title: 'Search: find identifiers without a hyphen', url: `https://github.com/${REPO}/pull/130`, state: 'open', branch: 'orb-2-search', author: alex.login, updatedAt: now - 50 * MIN, headSha: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00' },
      detail: {
        ...base,
        bodyHtml: '<p>"orb12" now finds ORB-12. Fixes ORB-2.</p>',
        author: alex,
        createdAt: now - 5 * HOUR,
        baseRef: 'main',
        headRef: 'orb-2-search',
        headRepo: REPO,
        headSha: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00',
        draft: false,
        mergeState: 'dirty',
        additions: 31,
        deletions: 12,
        changedFiles: 2,
        commits: 2,
        headBranchDeletable: true,
        checks: [check('check:9101', 'CI / check', 'success', now - 55 * MIN)],
      },
      items: [{ key: 'review:603', kind: 'review', author: mira, reviewState: 'changes_requested', html: '<p>Please add a test for identifiers with digits in the team key.</p>', createdAt: now - 4 * HOUR, url: `https://github.com/${REPO}/pull/130#pullrequestreview-603` }],
    },
    {
      // Ready to merge, linked to two issues.
      issueSeqs: [third, fourth],
      closes: true,
      pr: { repo: REPO, number: 131, title: 'Board: drag cards between columns', url: `https://github.com/${REPO}/pull/131`, state: 'open', branch: 'orb-3-board-drag', author: alex.login, updatedAt: now - 35 * MIN, headSha: 'b0a7d5c3e1f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0' },
      detail: {
        ...base,
        bodyHtml: '<p>Cards move between columns by drag and drop; the status follows the column.</p>',
        author: alex,
        createdAt: now - 2 * 24 * HOUR,
        baseRef: 'main',
        headRef: 'orb-3-board-drag',
        headRepo: REPO,
        headSha: 'b0a7d5c3e1f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0',
        draft: false,
        mergeState: 'clean',
        additions: 162,
        deletions: 41,
        changedFiles: 6,
        commits: 3,
        headBranchDeletable: true,
        checks: [
          check('check:9201', 'CI / check', 'success', now - 40 * MIN),
          check('check:9202', 'CI / e2e', 'success', now - 38 * MIN),
          { key: 'status:Vercel', name: 'Vercel', source: 'status', app: 'Vercel', state: 'success', url: 'https://vercel.com/acme', summary: 'Preview ready', completedAt: now - 39 * MIN },
        ],
      },
      items: [{ key: 'review:604', kind: 'review', author: mira, reviewState: 'approved', html: '<p>Works well on the phone too.</p>', createdAt: now - 36 * MIN, url: `https://github.com/${REPO}/pull/131#pullrequestreview-604` }],
    },
    {
      // Checks still running.
      issueSeqs: [fifth],
      closes: true,
      pr: { repo: REPO, number: 132, title: 'Inbox: group changes from the same agent', url: `https://github.com/${REPO}/pull/132`, state: 'open', branch: 'orb-5-inbox-groups', author: alex.login, updatedAt: now - 6 * MIN, headSha: 'd1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0' },
      detail: {
        ...base,
        bodyHtml: '<p>Several changes by one agent within ten minutes become one inbox entry.</p>',
        author: alex,
        createdAt: now - 3 * HOUR,
        baseRef: 'main',
        headRef: 'orb-5-inbox-groups',
        headRepo: REPO,
        headSha: 'd1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0',
        draft: false,
        mergeState: 'unstable',
        additions: 74,
        deletions: 18,
        changedFiles: 4,
        commits: 2,
        headBranchDeletable: true,
        checks: [check('check:9301', 'CI / check', 'pending', now - 2 * MIN), check('check:9302', 'CI / typecheck', 'success', now - 4 * MIN)],
      },
      items: [],
    },
    {
      // Draft: work in progress, whatever the checks say.
      issueSeqs: [sixth],
      closes: false,
      pr: { repo: REPO, number: 126, title: 'Sync: retry failed buckets', url: `https://github.com/${REPO}/pull/126`, state: 'draft', branch: 'orb-6-sync-retry', author: alex.login, updatedAt: now - 5 * HOUR, headSha: 'e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0' },
      detail: {
        ...base,
        bodyHtml: '<p>Not ready yet: the retry still needs a backoff.</p>',
        author: alex,
        createdAt: now - 30 * HOUR,
        baseRef: 'main',
        headRef: 'orb-6-sync-retry',
        headRepo: REPO,
        headSha: 'e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0',
        draft: true,
        mergeState: 'draft',
        additions: 25,
        deletions: 3,
        changedFiles: 2,
        commits: 1,
        headBranchDeletable: true,
        checks: [check('check:9401', 'CI / check', 'failure', now - 5 * HOUR)],
      },
      items: [],
    },
  ];
}
