// Loads the synthetic datasets into the LOCAL backend.
// Called by tooling/local.mjs (--seed small|large, --reset forces a reload)
// or directly: node backend/scripts/seed.ts [small|large] [--force]
//
// Runs with Node type stripping: only imports with a file extension, only `import type` for types.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../convex/_generated/api.js';
import type { Id } from '../convex/_generated/dataModel.d.ts';
import { KEY_PREFIX_LENGTH } from '../convex/lib/keys.ts';
import type { OWNER_KIND } from '../convex/shared/constants.ts';
import { DATASETS, generateDataset, NOW, type DatasetName, type GenActor } from '../data/generate.ts';
import { SAMPLE_ENABLED, SAMPLE_MODELS } from '../data/models.ts';
import { samplePullRequests } from '../data/pullRequests.ts';

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const ISSUES_PER_CALL = 100;
const LINKS_PER_CALL = 500;

export type SeedClient = Pick<ConvexHttpClient, 'query' | 'mutation'>;
type Actor = { kind: typeof OWNER_KIND | 'agent' | 'system'; agentId?: Id<'agents'> };

const LOCAL_URL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/;

/** URL from backend/.env.local, only if the deployment is anonymous/local. */
export function localConvexUrl(): string {
  const env = readFileSync(join(backendDir, '.env.local'), 'utf8');
  const deployment = /^CONVEX_DEPLOYMENT=(.*)$/m.exec(env)?.[1]?.trim() ?? '';
  if (!/^(anonymous|local):/.test(deployment)) throw new Error(`Not a local deployment: ${deployment}`);
  const url = /^CONVEX_URL=(.*)$/m.exec(env)?.[1]?.trim() ?? '';
  if (!LOCAL_URL.test(url)) throw new Error(`Not a local URL: ${url}`);
  return url;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Convex limits writes (locally e.g. 4 MiB/s, quickly reached on CI runners). On
 * "TooManyWrites" or overload, wait briefly and send the same mutation again. The seed
 * mutations allow this: a rejected call has written nothing.
 */
function retrying(client: SeedClient): SeedClient['mutation'] {
  return (async (ref: unknown, args: unknown) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await (client.mutation as (r: unknown, a: unknown) => Promise<unknown>)(ref, args);
      } catch (error) {
        const text = String((error as Error)?.message ?? error);
        if (attempt >= 8 || !/TooManyWrites|Too many writes|overloaded|OptimisticConcurrency/i.test(text)) throw error;
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
  }) as SeedClient['mutation'];
}

/**
 * Entry point for tooling/local.mjs. Refuses any non-local URL. Skips if the same
 * dataset is already complete (unless `force`).
 */
export async function seedLocal(client: ConvexHttpClient, set: DatasetName, opts: { force?: boolean } = {}) {
  if (!LOCAL_URL.test(client.url)) throw new Error(`Test data goes only into the local backend, not to ${client.url}.`);
  if (!(set in DATASETS)) throw new Error(`Unknown dataset "${set}" (allowed: ${Object.keys(DATASETS).join(', ')}).`);
  return await seedWith(client, set, opts, (msg) => process.stdout.write(msg));
}

/** The actual run, without the URL check (also used by tests with convex-test). */
export async function seedWith(
  client: SeedClient,
  set: DatasetName,
  opts: { force?: boolean } = {},
  log: (msg: string) => void = () => {},
) {
  const mutate = retrying(client);
  const { count } = DATASETS[set];
  const existing = (await client.query(api.seed.status, {})) as { set: string; count: number } | null;
  if (existing && existing.set === set && existing.count === count && !opts.force) {
    log(`${set}: already present (${count} issues), skipped.\n`);
    return { skipped: true, count };
  }
  const started = Date.now();
  for (;;) {
    const { done } = await mutate(api.seed.reset, {});
    if (done) break;
  }

  const data = generateDataset(set);
  const base = await mutate(api.seed.insertBase, {
    teams: data.teams.map(({ estimates: _e, ...team }) => team),
    labelGroups: data.labelGroups,
    labels: data.labels,
    projects: data.projects,
    agents: data.agents.map((a) => ({ name: a.name, keyHash: sha256(a.key), keyPrefix: a.key.slice(0, KEY_PREFIX_LENGTH) })),
    sprints: data.sprints,
    recurrences: data.recurrences,
    now: NOW,
  });
  await mutate(api.seed.insertModels, { providers: SAMPLE_MODELS, enable: SAMPLE_ENABLED });
  const teamId = new Map(base.teams.map((t) => [t.key, t.id]));
  const labelId = new Map(base.labels.map((l) => [l.name, l.id]));
  const projectId = new Map(base.projects.map((p) => [p.name, p.id]));
  const agentId = base.agents.map((a) => a.id);
  const sprintId = new Map(base.sprints.map((s) => [s.number, s.id]));
  const actor = (a: GenActor): Actor => (a.kind === 'agent' ? { kind: 'agent', agentId: agentId[a.agent] } : { kind: a.kind });

  for (let i = 0; i < data.issues.length; i += ISSUES_PER_CALL) {
    const chunk = data.issues.slice(i, i + ISSUES_PER_CALL).map((issue) => {
      const { teamKey, labels, project, parentSeq: _p, sprint, createdBy, comments, sprintItems, history, ...rest } = issue;
      return {
        ...rest,
        teamId: teamId.get(teamKey)!,
        labelIds: labels.map((n) => labelId.get(n)!),
        ...(project ? { projectId: projectId.get(project)! } : {}),
        ...(sprint ? { sprintId: sprintId.get(sprint)! } : {}),
        createdBy: actor(createdBy),
        comments: comments.map((c) => ({ ...c, author: actor(c.author) })),
        sprintItems: sprintItems.map(({ sprint: number, carriedFrom, addedBy, ...item }) => ({
          ...item,
          sprintId: sprintId.get(number)!,
          ...(carriedFrom ? { carriedFrom: sprintId.get(carriedFrom)! } : {}),
          addedBy: actor(addedBy),
        })),
        history: history.map((h) => ({ ...h, actor: actor(h.actor) })),
      };
    });
    await mutate(api.seed.insertIssues, { issues: chunk });
    log(`\r${set}: ${Math.min(i + ISSUES_PER_CALL, data.issues.length)}/${data.issues.length} issues`);
  }

  const parents = data.issues.filter((i) => i.parentSeq !== undefined).map((i) => ({ seq: i.seq, parentSeq: i.parentSeq! }));
  const relations = data.relations.map((r) => ({ ...r, createdBy: actor(r.createdBy) }));
  for (let i = 0; i < Math.max(parents.length, relations.length, 1); i += LINKS_PER_CALL) {
    await mutate(api.seed.insertLinks, {
      parents: parents.slice(i, i + LINKS_PER_CALL),
      relations: relations.slice(i, i + LINKS_PER_CALL),
      aliases: i === 0 ? data.aliases : [],
    });
  }

  // Sample PRs with times relative to now (not NOW), so "20 min ago" looks right.
  const prNow = Date.now();
  await mutate(api.seed.insertPullRequests, { prs: samplePullRequests(data.issues, prNow), fetchedAt: prNow });

  const maxNumber = new Map<string, number>();
  for (const issue of data.issues) maxNumber.set(issue.teamKey, Math.max(maxNumber.get(issue.teamKey) ?? 0, issue.number));
  await mutate(api.seed.finish, {
    set,
    count: data.issues.length,
    teamNumbers: [...maxNumber].map(([key, number]) => ({ teamId: teamId.get(key)!, number })),
    sprintNumber: Math.max(...data.sprints.map((s) => s.number)),
  });
  log(`\n${set}: done in ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
  return { skipped: false, count: data.issues.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const set = (args.find((a) => !a.startsWith('--')) ?? 'small') as DatasetName;
  const { devToken } = await import('../../tooling/dev-auth.mjs');
  const client = new ConvexHttpClient(localConvexUrl());
  client.setAuth(devToken());
  await seedLocal(client, set, { force: args.includes('--force') });
}
