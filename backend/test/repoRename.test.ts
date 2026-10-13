import { describe, expect, test } from 'vitest';
import { internal } from '../convex/_generated/api';
import { renameIn } from '../convex/repoRename';
import { setup } from './helpers';

describe('Rename a GitHub repository in stored references (repoRename)', () => {
  test('renameIn rewrites exact names, PR refs and GitHub URLs, nothing else', () => {
    const input = {
      repo: 'acme/xlr8',
      pr: 'Acme/XLR8#51',
      url: 'https://github.com/acme/xlr8/pull/51',
      raw: 'https://raw.githubusercontent.com/acme/xlr8/main/a.png',
      api: 'https://api.github.com/repos/acme/xlr8/pulls/51',
      other: 'https://github.com/acme/xlr8-public/pull/1',
      prefix: 'acme/xlr8-tools',
      list: ['acme/xlr8', 3],
    };
    const { value, changed } = renameIn(input, 'acme/xlr8', 'acme/xlr8-archive');
    expect(changed).toBe(true);
    expect(value).toEqual({
      repo: 'acme/xlr8-archive',
      pr: 'acme/xlr8-archive#51',
      url: 'https://github.com/acme/xlr8-archive/pull/51',
      raw: 'https://raw.githubusercontent.com/acme/xlr8-archive/main/a.png',
      api: 'https://api.github.com/repos/acme/xlr8-archive/pulls/51',
      other: 'https://github.com/acme/xlr8-public/pull/1',
      prefix: 'acme/xlr8-tools',
      list: ['acme/xlr8-archive', 3],
    });
    expect(renameIn({ repo: 'acme/other' }, 'acme/xlr8', 'acme/x').changed).toBe(false);
  });

  test('dry run changes nothing, apply moves the pull requests of that repository only', async () => {
    const { t } = setup();
    const ids = await t.run(async (ctx) => {
      const pr = (repo: string, number: number) =>
        ctx.db.insert('pullRequests', { repo, number, title: 'PR', url: `https://github.com/${repo}/pull/${number}`, state: 'open', branch: 'b', updatedAt: 0 });
      return { mine: await pr('acme/xlr8', 51), other: await pr('acme/xlr8-public', 1) };
    });
    const run = async (apply: boolean) => {
      let args: Record<string, unknown> = { from: 'acme/xlr8', to: 'acme/xlr8-archive', apply };
      let changed = 0;
      for (;;) {
        const out = await t.mutation(internal.repoRename.step, args as never);
        changed += out.changed;
        if (!out.next) return changed;
        args = { ...args, ...out.next };
      }
    };
    expect(await run(false)).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(ids.mine)))?.repo).toBe('acme/xlr8');
    expect(await run(true)).toBe(1);
    const mine = await t.run((ctx) => ctx.db.get(ids.mine));
    expect(mine?.repo).toBe('acme/xlr8-archive');
    expect(mine?.url).toBe('https://github.com/acme/xlr8-archive/pull/51');
    expect((await t.run((ctx) => ctx.db.get(ids.other)))?.repo).toBe('acme/xlr8-public');
  });
});
