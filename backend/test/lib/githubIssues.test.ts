import { describe, expect, test } from 'vitest';
import { describeGithubError, retryAtOf } from '../../convex/lib/githubApi';
import {
  advanceCursor,
  closingRefs,
  firstPath,
  issueKey,
  issueMarkdown,
  mapComment,
  mapIssue,
  mapPull,
  pathOf,
  type GithubCursor,
} from '../../convex/lib/githubIssues';

// Import from GitHub Issues: mapping of REST responses and closing keywords. Made-up data.

const REPO = 'acme/app';

describe('mapIssue', () => {
  test('maps an open issue with labels', () => {
    const issue = mapIssue(REPO, {
      number: 3,
      title: 'Search is slow',
      body: 'Steps…',
      state: 'open',
      state_reason: null,
      labels: [{ name: 'bug', color: 'D73A4A' }, { name: 'Bug' }, 'help wanted', { name: ' ' }],
      user: { login: 'octocat' },
      html_url: 'https://github.com/acme/app/issues/3',
      created_at: '2026-10-01T10:00:00Z',
      closed_at: null,
    });
    expect(issue).toEqual({
      repo: REPO,
      number: 3,
      title: 'Search is slow',
      body: 'Steps…',
      state: 'open',
      labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'help wanted' }],
      author: 'octocat',
      url: 'https://github.com/acme/app/issues/3',
      createdAt: Date.parse('2026-10-01T10:00:00Z'),
    });
  });

  test('closed issues carry their reason and closing time', () => {
    const base = { number: 4, title: 't', state: 'closed', closed_at: '2026-10-02T08:00:00Z', created_at: '2026-10-01T08:00:00Z' };
    expect(mapIssue(REPO, { ...base, state_reason: 'completed' })).toMatchObject({ state: 'completed', closedAt: Date.parse('2026-10-02T08:00:00Z') });
    expect(mapIssue(REPO, { ...base, state_reason: 'not_planned' })?.state).toBe('not_planned');
    expect(mapIssue(REPO, { ...base, state_reason: 'duplicate' })?.state).toBe('duplicate');
    // Older issues have no reason: closed counts as completed.
    expect(mapIssue(REPO, { ...base, state_reason: null })?.state).toBe('completed');
  });

  test('pull requests and broken entries are not issues', () => {
    expect(mapIssue(REPO, { number: 5, title: 'PR', state: 'open', pull_request: { url: 'x' } })).toBeNull();
    expect(mapIssue(REPO, { title: 'no number' })).toBeNull();
    expect(mapIssue(REPO, null)).toBeNull();
  });

  test('missing author becomes ghost (deleted GitHub accounts)', () => {
    expect(mapIssue(REPO, { number: 1, title: 't', state: 'open', user: null })?.author).toBe('ghost');
  });
});

describe('mapComment', () => {
  test('reads the issue number from issue_url', () => {
    expect(
      mapComment(REPO, {
        id: 9001,
        issue_url: 'https://api.github.com/repos/acme/app/issues/3',
        body: 'Me too',
        user: { login: 'anna' },
        created_at: '2026-10-01T11:00:00Z',
        updated_at: '2026-10-01T12:00:00Z',
      }),
    ).toEqual({
      id: '9001',
      repo: REPO,
      number: 3,
      body: 'Me too',
      author: 'anna',
      createdAt: Date.parse('2026-10-01T11:00:00Z'),
      updatedAt: Date.parse('2026-10-01T12:00:00Z'),
    });
    expect(mapComment(REPO, { id: 1, issue_url: 'https://api.github.com/repos/acme/app/pulls/3' })).toBeNull();
  });
});

describe('closingRefs', () => {
  test('keywords with #n, owner/repo#n and issue URLs', () => {
    expect(closingRefs('Fixes #12', REPO)).toEqual([{ repo: REPO, number: 12 }]);
    expect(closingRefs('closes: acme/lib#3', REPO)).toEqual([{ repo: 'acme/lib', number: 3 }]);
    expect(closingRefs('Resolved https://github.com/acme/app/issues/4.', REPO)).toEqual([{ repo: REPO, number: 4 }]);
    expect(closingRefs('fix ACME/APP#5', REPO)).toEqual([{ repo: REPO, number: 5 }]);
  });

  test('lists and several keywords', () => {
    expect(closingRefs('Fixes #1, #2 and #3\n\nAlso closes #2', REPO).map((r) => r.number)).toEqual([1, 2, 3]);
  });

  test('mentions without a keyword, code and other words do not count', () => {
    expect(closingRefs('See #7', REPO)).toEqual([]);
    expect(closingRefs('`Fixes #8`\n```\ncloses #9\n```', REPO)).toEqual([]);
    expect(closingRefs('prefixes #10', REPO)).toEqual([]);
    expect(closingRefs('Fixes #11abc', REPO)).toEqual([]);
    expect(closingRefs('Fixes https://github.com/acme/app/pull/12', REPO)).toEqual([]);
  });
});

describe('mapPull', () => {
  test('state, branch and closing references from title and body', () => {
    const pr = mapPull(REPO, {
      number: 20,
      title: 'Faster search (fixes #3)',
      body: 'Closes acme/lib#1',
      state: 'closed',
      merged_at: '2026-10-03T09:00:00Z',
      html_url: 'https://github.com/acme/app/pull/20',
      head: { ref: 'faster-search' },
      user: { login: 'octocat' },
      created_at: '2026-10-02T09:00:00Z',
      updated_at: '2026-10-03T09:00:00Z',
    });
    expect(pr).toMatchObject({
      number: 20,
      state: 'merged',
      branch: 'faster-search',
      author: 'octocat',
      mergedAt: Date.parse('2026-10-03T09:00:00Z'),
      closes: [
        { repo: REPO, number: 3 },
        { repo: 'acme/lib', number: 1 },
      ],
    });
    expect(mapPull(REPO, { number: 21, title: 'Draft', state: 'open', draft: true })?.state).toBe('draft');
  });
});

describe('helpers', () => {
  test('issueMarkdown appends the origin line', () => {
    const issue = { repo: REPO, number: 3, body: 'Text\n', author: 'octocat', url: 'https://github.com/acme/app/issues/3' };
    expect(issueMarkdown(issue)).toBe('Text\n\n---\n\nImported from [acme/app#3](https://github.com/acme/app/issues/3) on GitHub, opened by octocat.');
    expect(issueMarkdown({ ...issue, body: '' })).toBe('Imported from [acme/app#3](https://github.com/acme/app/issues/3) on GitHub, opened by octocat.');
  });

  test('issueKey ignores the case of the repo name', () => {
    expect(issueKey('Acme/App', 3)).toBe(issueKey('acme/app', 3));
  });

  test('retryAtOf prefers retry-after, then the reset time', () => {
    const now = Date.parse('2026-10-20T10:00:00Z');
    expect(retryAtOf(new Headers({ 'retry-after': '60', 'x-ratelimit-reset': '1' }), now)).toBe(now + 60_000);
    expect(retryAtOf(new Headers({ 'x-ratelimit-reset': String(now / 1000 + 300) }), now)).toBe(now + 300_000);
    expect(retryAtOf(new Headers(), now)).toBeUndefined();
  });

  test('a 403 with only retry-after is a (secondary) rate limit', () => {
    const call = { what: 'Read issues', permission: 'Issues' };
    expect(describeGithubError(403, call, 'You have triggered an abuse detection mechanism.', new Headers({ 'retry-after': '60' })).code).toBe('rate_limited');
    expect(describeGithubError(403, call, 'Resource not accessible by personal access token', new Headers()).code).toBe('forbidden');
  });
});

describe('cursor', () => {
  const c: GithubCursor = { teamId: 'team', repos: ['acme/app', 'acme/lib'], phase: 'issues', repo: 0, path: null, attempt: 2 };

  test('next page, next repo, next phase, end', () => {
    expect(advanceCursor(c, '/repos/acme/app/issues?page=2')).toMatchObject({ phase: 'issues', repo: 0, path: '/repos/acme/app/issues?page=2', attempt: 0 });
    expect(advanceCursor(c, null)).toMatchObject({ phase: 'issues', repo: 1, path: null });
    expect(advanceCursor({ ...c, repo: 1 }, null)).toMatchObject({ phase: 'pulls', repo: 0, path: null });
    expect(advanceCursor({ ...c, phase: 'pulls', repo: 1 }, null)).toMatchObject({ phase: 'comments', repo: 0 });
    expect(advanceCursor({ ...c, phase: 'comments', repo: 1 }, null)).toBeNull();
  });

  test('paths stay on api.github.com', () => {
    expect(firstPath('issues', 'acme/app')).toBe('/repos/acme/app/issues?state=all&sort=created&direction=asc&per_page=50');
    expect(pathOf('https://api.github.com/repos/acme/app/issues?page=2')).toBe('/repos/acme/app/issues?page=2');
    expect(pathOf('https://evil.example/repos')).toBeNull();
    expect(() => firstPath('issues', '../x')).toThrow();
  });
});
