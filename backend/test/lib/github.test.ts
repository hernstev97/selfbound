import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  analyzePullRequestEvent,
  branchIdentifiers,
  closingIdentifiers,
  githubHeaders,
  signBody,
  stripCode,
  textIdentifiers,
  verifySignature,
  type PullRequestAnalysis,
} from '../../convex/lib/github';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/github/${name}`, import.meta.url), 'utf8');
const KNOWN = { teams: ['KIU', 'xlr', 'BOX'], aliases: ['OLD-7'] };

function prPayload(change: (p: any) => void = () => {}) {
  const p = JSON.parse(fixture('pull_request.opened.json'));
  change(p);
  return p;
}

function analyze(change: (p: any) => void = () => {}) {
  const result = analyzePullRequestEvent('pull_request', prPayload(change), KNOWN);
  expect(result.kind).toBe('pull_request');
  return result as PullRequestAnalysis;
}

describe('verifySignature', () => {
  const secret = 'synthetic-test-secret';
  const body = fixture('pull_request.opened.json');

  test('valid signature', async () => {
    const header = await signBody(secret, body);
    expect(header).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(await verifySignature(secret, body, header)).toBe(true);
    // also as bytes and with upper-case hex digits
    expect(await verifySignature(secret, new TextEncoder().encode(body), header.toUpperCase().replace('SHA256', 'sha256'))).toBe(
      true,
    );
  });

  test('known value from the GitHub docs', async () => {
    // https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries#testing-the-webhook-payload-validation
    expect(
      await verifySignature(
        "It's a Secret to Everybody",
        'Hello, World!',
        'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
      ),
    ).toBe(true);
  });

  test('wrong signature, wrong secret, different body', async () => {
    const header = await signBody(secret, body);
    const flipped = header.slice(0, -1) + (header.endsWith('0') ? '1' : '0');
    expect(await verifySignature(secret, body, flipped)).toBe(false);
    expect(await verifySignature('other-secret', body, header)).toBe(false);
    expect(await verifySignature(secret, body + ' ', header)).toBe(false);
    expect(await verifySignature(secret, body.replace('"opened"', '"closed"'), header)).toBe(false);
  });

  test('missing or malformed header, empty secret', async () => {
    const header = await signBody(secret, body);
    expect(await verifySignature(secret, body, undefined)).toBe(false);
    expect(await verifySignature(secret, body, null)).toBe(false);
    expect(await verifySignature(secret, body, '')).toBe(false);
    expect(await verifySignature(secret, body, header.replace('sha256=', 'sha1='))).toBe(false);
    expect(await verifySignature(secret, body, header.slice(0, -2))).toBe(false);
    expect(await verifySignature(secret, body, 'sha256=' + 'z'.repeat(64))).toBe(false);
    expect(await verifySignature('', body, header)).toBe(false);
  });
});

describe('identifiers', () => {
  test('branch name formats', () => {
    expect(branchIdentifiers('octocat/kiu-106-title-slug', KNOWN)).toEqual(['KIU-106']);
    expect(branchIdentifiers('kiu-106', KNOWN)).toEqual(['KIU-106']);
    expect(branchIdentifiers('feature/KIU-106-x', KNOWN)).toEqual(['KIU-106']);
    expect(branchIdentifiers('xlr-3-and-kiu-4', KNOWN)).toEqual(['XLR-3', 'KIU-4']);
    expect(branchIdentifiers('fix/old-7-alias', KNOWN)).toEqual(['OLD-7']);
  });

  test('unknown keys, wrong boundaries and zero do not count', () => {
    expect(branchIdentifiers('release/v1-2', KNOWN)).toEqual([]);
    expect(branchIdentifiers('abc-12-foo', KNOWN)).toEqual([]);
    expect(branchIdentifiers('xkiu-106', KNOWN)).toEqual([]);
    expect(branchIdentifiers('kiu-106a', KNOWN)).toEqual([]);
    expect(branchIdentifiers('kiu-0', KNOWN)).toEqual([]);
    expect(branchIdentifiers('old-8', KNOWN)).toEqual([]); // only OLD-7 is an alias
    expect(branchIdentifiers('main', KNOWN)).toEqual([]);
  });

  test('text without code and comments', () => {
    const text = 'See KIU-1 and (kiu-2).\n```ts\nKIU-3\n```\n`KIU-4` ``KIU-5`` <!-- KIU-6 -->\n~~~\nKIU-7\n~~~\nKIU-8.';
    expect(textIdentifiers(text, KNOWN)).toEqual(['KIU-1', 'KIU-2', 'KIU-8']);
    expect(textIdentifiers('```\nKIU-9 without closing fence', KNOWN)).toEqual([]);
    expect(textIdentifiers(null, KNOWN)).toEqual([]);
    expect(stripCode('a `b` c')).toBe('a   c');
  });

  test('single magic words, with colon, any case', () => {
    for (const word of ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved']) {
      expect(closingIdentifiers(`${word} KIU-1`, KNOWN)).toEqual(['KIU-1']);
      expect(closingIdentifiers(`${word.toUpperCase()}: kiu-2`, KNOWN)).toEqual(['KIU-2']);
    }
    expect(closingIdentifiers('Fixes:KIU-3', KNOWN)).toEqual(['KIU-3']);
    expect(closingIdentifiers('Fixes https://linear.app/acme/issue/KIU-4/title-slug', KNOWN)).toEqual(['KIU-4']);
  });

  test('lists after a magic word', () => {
    expect(closingIdentifiers('Fixes KIU-1, KIU-2 and KIU-3', KNOWN)).toEqual(['KIU-1', 'KIU-2', 'KIU-3']);
    expect(closingIdentifiers('closes KIU-1, KIU-2, and XLR-3 & BOX-4', KNOWN)).toEqual([
      'KIU-1',
      'KIU-2',
      'XLR-3',
      'BOX-4',
    ]);
    // an unknown key in the list is skipped, the list continues
    expect(closingIdentifiers('Fixes ABC-1, KIU-2', KNOWN)).toEqual(['KIU-2']);
    // the list ends at the first non-separator
    expect(closingIdentifiers('Fixes KIU-1 see KIU-2', KNOWN)).toEqual(['KIU-1']);
  });

  test('not magic words: prefix, word parts, code', () => {
    expect(closingIdentifiers('Prefix KIU-1', KNOWN)).toEqual([]);
    expect(closingIdentifiers('hotfixes KIU-1', KNOWN)).toEqual([]);
    expect(closingIdentifiers('closesKIU-1', KNOWN)).toEqual([]);
    expect(closingIdentifiers('Fixed bug, see KIU-1', KNOWN)).toEqual([]);
    expect(closingIdentifiers('`Fixes KIU-1`', KNOWN)).toEqual([]);
    expect(closingIdentifiers('```\nFixes KIU-1\n```', KNOWN)).toEqual([]);
    expect(closingIdentifiers('Refs KIU-1', KNOWN)).toEqual([]);
  });
});

describe('analyzePullRequestEvent', () => {
  test('opened: branch closes, magic word list closes, mention only links', () => {
    const r = analyze();
    expect(r).toMatchObject({
      action: 'opened',
      repo: 'acme/xlr8',
      number: 42,
      title: 'KIU-106: Search field on the home page',
      url: 'https://github.com/acme/xlr8/pull/42',
      state: 'open',
      branch: 'octocat/kiu-106-search-field-on-home',
      author: 'octocat',
      merged: false,
    });
    expect(r.mergedAt).toBeUndefined();
    expect(r.updatedAt).toBe(Date.parse('2026-10-08T08:00:05Z'));
    expect(r.links).toEqual([
      { identifier: 'KIU-106', via: 'branch', closes: true },
      { identifier: 'KIU-107', via: 'body', closes: true },
      { identifier: 'KIU-108', via: 'body', closes: true },
      { identifier: 'KIU-109', via: 'body', closes: true },
      { identifier: 'KIU-110', via: 'body', closes: false },
    ]);
  });

  test('identifier only in the title without magic word: link, do not close', () => {
    const r = analyze((p) => {
      p.pull_request.head.ref = 'octocat/search-field';
      p.pull_request.body = null;
    });
    expect(r.links).toEqual([{ identifier: 'KIU-106', via: 'title', closes: false }]);
  });

  test('magic word in the title closes', () => {
    const r = analyze((p) => {
      p.pull_request.head.ref = 'octocat/search-field';
      p.pull_request.title = 'Fixes KIU-200: crash';
      p.pull_request.body = '';
    });
    expect(r.links).toEqual([{ identifier: 'KIU-200', via: 'title', closes: true }]);
  });

  test('title mention closed by a magic word in the body', () => {
    const r = analyze((p) => {
      p.pull_request.head.ref = 'octocat/search-field';
      p.pull_request.title = 'KIU-300 cleanup';
      p.pull_request.body = 'Resolves KIU-300';
    });
    expect(r.links).toEqual([{ identifier: 'KIU-300', via: 'title', closes: true }]);
  });

  test('Draft, ready_for_review, edited, reopened', () => {
    expect(analyze((p) => (p.pull_request.draft = true)).state).toBe('draft');
    expect(analyze((p) => (p.action = 'ready_for_review')).action).toBe('ready_for_review');
    expect(analyze((p) => (p.action = 'edited')).links.length).toBe(5);
    expect(analyze((p) => (p.action = 'reopened')).state).toBe('open');
  });

  test('closed with merged=true: merged, mergedAt', () => {
    const r = analyze((p) => {
      p.action = 'closed';
      p.pull_request.state = 'closed';
      p.pull_request.merged = true;
      p.pull_request.merged_at = '2026-10-08T09:30:00Z';
      p.pull_request.closed_at = '2026-10-08T09:30:00Z';
    });
    expect(r.state).toBe('merged');
    expect(r.merged).toBe(true);
    expect(r.mergedAt).toBe(Date.parse('2026-10-08T09:30:00Z'));
  });

  test('closed without merge: closed, nothing is marked done', () => {
    const r = analyze((p) => {
      p.action = 'closed';
      p.pull_request.state = 'closed';
      p.pull_request.merged = false;
      p.pull_request.closed_at = '2026-10-08T09:30:00Z';
    });
    expect(r.state).toBe('closed');
    expect(r.merged).toBe(false);
    expect(r.mergedAt).toBeUndefined();
  });

  test('synchronize and other actions are ignored', () => {
    for (const action of ['synchronize', 'labeled', 'assigned', 'review_requested']) {
      const r = analyzePullRequestEvent('pull_request', prPayload((p) => (p.action = action)), KNOWN);
      expect(r.kind).toBe('ignored');
    }
  });

  test('ping and other events', () => {
    expect(analyzePullRequestEvent('ping', JSON.parse(fixture('ping.json')), KNOWN)).toEqual({
      kind: 'ping',
      hookId: 500000001,
      zen: 'Keep it logically awesome.',
    });
    expect(analyzePullRequestEvent('push', {}, KNOWN).kind).toBe('ignored');
    expect(analyzePullRequestEvent('issues', {}, KNOWN).kind).toBe('ignored');
  });

  test('malformed payloads are ignored instead of throwing', () => {
    expect(analyzePullRequestEvent('pull_request', null, KNOWN).kind).toBe('ignored');
    expect(analyzePullRequestEvent('pull_request', { action: 'opened' }, KNOWN).kind).toBe('ignored');
    expect(
      analyzePullRequestEvent('pull_request', { action: 'opened', pull_request: {}, repository: {} }, KNOWN).kind,
    ).toBe('ignored');
  });

  test('reading headers', () => {
    expect(
      githubHeaders({ 'X-GitHub-Event': 'ping', 'X-GitHub-Delivery': 'abc', 'X-Hub-Signature-256': 'sha256=00' }),
    ).toEqual({ event: 'ping', deliveryId: 'abc', signature: 'sha256=00' });
    const h = new Headers({ 'x-github-event': 'pull_request' });
    expect(githubHeaders(h)).toEqual({ event: 'pull_request', deliveryId: '', signature: undefined });
  });
});
