import type { FunctionArgs } from 'convex/server';
import { convexTest } from 'convex-test';
import { expect } from 'vitest';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';
import { dayInZone, DEFAULT_TIME_ZONE } from '../convex/lib/dates';
import { auditSprints } from '../convex/ops/sprints';
import type { Status } from '../convex/shared/constants';
import { stateForStatus } from '../convex/shared/workflow';

/** Calendar day in Europe/Berlin, the zone every test instance has unless a test sets another. */
export const berlinDay = (ms: number) => dayInZone(ms, DEFAULT_TIME_ZONE);

export const modules = import.meta.glob('../convex/**/*.*s');

const ISSUER = 'https://dev.selfbound.local';
export const OWNER = { issuer: ISSUER, subject: 'owner', tokenIdentifier: `${ISSUER}|owner` };
export const STRANGER = { issuer: ISSUER, subject: 'mallory', tokenIdentifier: `${ISSUER}|mallory` };

/** Address of the app with the OAuth consent page, when `setup({ oauth: true })`. */
export const APP_URL = 'http://127.0.0.1:5412';

export function setup(env: { testSwitches?: boolean; allowSeed?: boolean; cloudUrl?: string; oauth?: boolean } = {}) {
  process.env.SELFBOUND_OWNER_IDS = OWNER.tokenIdentifier;
  process.env.SELFBOUND_TEST_SWITCHES = env.testSwitches === false ? '0' : '1';
  process.env.SELFBOUND_ALLOW_SEED = env.allowSeed === false ? '0' : '1';
  // As in a local deployment (Convex sets both variables itself). The local test
  // sign-in (issuer dev.selfbound.local) only works when CONVEX_CLOUD_URL is local.
  process.env.CONVEX_CLOUD_URL = env.cloudUrl ?? 'http://127.0.0.1:3210';
  process.env.CONVEX_SITE_URL = 'http://127.0.0.1:3211';
  // OAuth for connectors only on request (otherwise the behaviour without OAuth applies).
  if (env.oauth) process.env.SELFBOUND_APP_URL = APP_URL;
  else delete process.env.SELFBOUND_APP_URL;
  delete process.env.SELFBOUND_PUBLIC_SITE_URL;
  // transactionLimits: enforce the real Convex limits per function (reads, writes, documents).
  const t = convexTest({ schema, modules, transactionLimits: true });
  const owner = t.withIdentity(OWNER);
  return {
    t,
    owner,
    stranger: t.withIdentity(STRANGER),
  };
}

export type T = ReturnType<typeof setup>['t'];
export type Client = ReturnType<typeof setup>['owner'];

/** Expects a ConvexError with this code. */
export async function expectCode(promise: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  expect(error, `expected error ${code}`).toBeDefined();
  expect((error as { data?: { code?: string } }).data?.code, String(error)).toBe(code);
  return (error as { data: Record<string, unknown> }).data;
}

/** Two teams, a single-choice label group, labels, projects. */
export async function fixture(owner: Client) {
  const { teamId: orb } = await owner.mutation(api.teams.create, { key: 'ORB', name: 'Orbit' });
  const { teamId: nova } = await owner.mutation(api.teams.create, { key: 'nova', name: 'Nova' });
  const { groupId: type } = await owner.mutation(api.labelGroups.create, { name: 'Type', exclusive: true });
  const { groupId: area } = await owner.mutation(api.labelGroups.create, { name: 'Area', exclusive: false });
  const bug = (await owner.mutation(api.labels.create, { name: 'Bug', hue: 20, groupId: type })).labelId;
  const feature = (await owner.mutation(api.labels.create, { name: 'Feature', hue: 260, groupId: type })).labelId;
  const design = (await owner.mutation(api.labels.create, { name: 'Design', hue: 300, groupId: area })).labelId;
  const docs = (await owner.mutation(api.labels.create, { name: 'Docs', hue: 90, groupId: area })).labelId;
  const orbOnly = (await owner.mutation(api.labels.create, { name: 'Release', hue: 45, teamId: orb })).labelId;
  const { projectId: orbProject } = await owner.mutation(api.projects.create, { teamId: orb, name: 'Orbit · Search' });
  const { projectId: novaProject } = await owner.mutation(api.projects.create, { teamId: nova, name: 'Nova · Sync' });
  return { orb, nova, type, area, bug, feature, design, docs, orbOnly, orbProject, novaProject };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function createOne(
  owner: Client,
  teamId: Id<'teams'>,
  extra: Partial<FunctionArgs<typeof api.issues.create>['issues'][number]> = {},
) {
  const result = await owner.mutation(api.issues.create, { issues: [{ teamId, title: 'Test issue', ...extra }] });
  return result.issues[0];
}

export async function getIssue(t: T, id: Id<'issues'>) {
  return await t.run(async (ctx) => (await ctx.db.get('issues', id))!);
}

/** A team's state for a legacy status key (the default states). */
export async function stateId(t: T, teamId: Id<'teams'>, status: Status) {
  return await t.run(async (ctx) => {
    const states = await ctx.db
      .query('workflowStates')
      .withIndex('by_team', (q) => q.eq('teamId', teamId))
      .collect();
    return stateForStatus(states, status)!._id;
  });
}

export async function historyOf(t: T, id: Id<'issues'>) {
  return await t.run(async (ctx) =>
    await ctx.db
      .query('history')
      .withIndex('by_issue', (q) => q.eq('issueId', id))
      .collect(),
  );
}

/** The sprint invariant must hold after every operation. */
export async function expectSprintInvariant(t: T) {
  const result = await t.run(async (ctx) => await auditSprints(ctx));
  expect(result.problems).toEqual([]);
  return result;
}
