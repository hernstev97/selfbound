import { v } from 'convex/values';
import type { Id, TableNames } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { ownerMutation, ownerQuery } from './lib/auth';
import { setCounter, SEQ, SPRINT, teamCounter } from './lib/counters';
import { fail } from './lib/errors';
import { modelRefValidator, slimProviderValidator } from './lib/validators';
import { ensureTeamStates, stateFields } from './lib/workflow';
import { DAY_MS } from './lib/dates';
import { BODY_SEARCH_CHARS } from './ops/bodies';
import { openCreatedEntry } from './ops/inboxChanges';
import { createIssuesCore } from './ops/issues';
import { setPublicCard, updateRoadmapSettings } from './ops/roadmap';
import { createLabel, createLabelGroup, createProject, createTeam } from './ops/teams';
import { readOpsStatus, writeOpsStatus } from './ops/maintenance';
import { applyProvider, setModelEnabled } from './ops/models';
import { writeStatus } from './ops/githubPr';
import { prStatusOf } from './shared/pullRequests';
import schema, {
  actorValidator,
  prDetailDataValidator,
  prItemFields,
  prStateValidator,
  priorityValidator,
  projectStateValidator,
  relationTypeValidator,
  sprintItemKindValidator,
  sprintOutcomeValidator,
  sprintStateValidator,
  statusValidator,
} from './schema';
import { bucketOf, SPRINT_SOURCE } from './shared/constants';
import { stateForStatus } from './shared/workflow';
import { envVar } from './lib/legacyEnv';

// Load synthetic test data (called by backend/scripts/seed.ts).
// Guarded twice: only for the owner (ownerMutation) AND only if the deployment
// has SELFBOUND_ALLOW_SEED=1 set (local only).

function assertSeedAllowed() {
  if (envVar('ALLOW_SEED') !== '1') {
    fail('access_denied', 'Test data is not allowed on this backend (SELFBOUND_ALLOW_SEED is not set).');
  }
}

export const MAX_ISSUES_PER_CALL = 200;
const RESET_BATCH = 2000;
const TABLES = Object.keys(schema.tables) as TableNames[];

/** State of the last loaded dataset (null = none or incomplete). */
export const status = ownerQuery({
  args: {},
  handler: async (ctx) => {
    assertSeedAllowed();
    return (await readOpsStatus(ctx, 'seed'))?.value ?? null;
  },
});

/** Deletes ALL data in batches. Call until done = true. */
export const reset = ownerMutation({
  args: {},
  handler: async (ctx) => {
    assertSeedAllowed();
    // Convex limits per call: 4096 reads, 16 MiB read. Descriptions are up to 3 KB,
    // so at most 2000 documents per call (about 6 MiB).
    let budget = RESET_BATCH;
    let deleted = 0;
    for (const table of TABLES) {
      if (table === 'settings') continue;
      const rows = await ctx.db.query(table).take(budget);
      for (const row of rows) {
        if (table === 'teams') {
          const team = row as unknown as { logoId?: Id<'_storage'>; logoDarkId?: Id<'_storage'> };
          if (team.logoId) await ctx.storage.delete(team.logoId);
          if (team.logoDarkId) await ctx.storage.delete(team.logoDarkId);
        }
        await ctx.db.delete(row._id);
      }
      deleted += rows.length;
      budget -= rows.length;
      if (budget <= 0) return { done: false, deleted };
    }
    return { done: true, deleted };
  },
});

const sprintPayload = v.object({
  number: v.number(),
  name: v.string(),
  goal: v.string(),
  startDate: v.string(),
  endDate: v.string(),
  state: sprintStateValidator,
  capacity: v.optional(v.number()),
  startedAt: v.optional(v.number()),
  closedAt: v.optional(v.number()),
});

/** Base data: teams, label groups, labels, projects, agents (hash only), sprints, recurrences. */
export const insertBase = ownerMutation({
  args: {
    teams: v.array(v.object({ key: v.string(), name: v.string(), hue: v.number(), dormant: v.boolean(), order: v.number() })),
    labelGroups: v.array(v.object({ name: v.string(), exclusive: v.boolean(), hue: v.number() })),
    labels: v.array(v.object({ name: v.string(), hue: v.number(), group: v.optional(v.string()), teamKey: v.optional(v.string()) })),
    projects: v.array(v.object({ teamKey: v.string(), name: v.string(), state: projectStateValidator, order: v.number() })),
    agents: v.array(v.object({ name: v.string(), keyHash: v.string(), keyPrefix: v.string() })),
    sprints: v.array(sprintPayload),
    recurrences: v.array(
      v.object({
        teamKey: v.string(),
        title: v.string(),
        description: v.string(),
        priority: priorityValidator,
        labels: v.array(v.string()),
        cadence: v.union(v.literal('weekly'), v.literal('monthly')),
        weekday: v.optional(v.number()),
        monthDay: v.optional(v.number()),
        nextDate: v.string(),
      }),
    ),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    assertSeedAllowed();
    if (await ctx.db.query('teams').first()) fail('invalid', 'There is already data. Call seed.reset first.');
    const teams: { key: string; id: Id<'teams'> }[] = [];
    for (const team of args.teams) teams.push({ key: team.key, id: await ctx.db.insert('teams', { ...team, updatedAt: args.now }) });
    for (const team of teams) await ensureTeamStates(ctx, team.id, args.now);
    const teamId = (key: string) => teams.find((t) => t.key === key)!.id;
    const groups: { name: string; id: Id<'labelGroups'> }[] = [];
    for (const group of args.labelGroups) groups.push({ name: group.name, id: await ctx.db.insert('labelGroups', group) });
    const labels: { name: string; id: Id<'labels'> }[] = [];
    for (const { group, teamKey, ...label } of args.labels) {
      const groupId = group ? groups.find((g) => g.name === group)!.id : undefined;
      labels.push({
        name: label.name,
        id: await ctx.db.insert('labels', { ...label, ...(groupId ? { groupId } : {}), ...(teamKey ? { teamId: teamId(teamKey) } : {}) }),
      });
    }
    const projects: { name: string; id: Id<'projects'> }[] = [];
    for (const { teamKey, ...project } of args.projects) {
      projects.push({
        name: project.name,
        id: await ctx.db.insert('projects', { ...project, teamId: teamId(teamKey), updatedAt: args.now }),
      });
    }
    const agents: { name: string; id: Id<'agents'> }[] = [];
    for (const agent of args.agents) {
      agents.push({ name: agent.name, id: await ctx.db.insert('agents', { ...agent, createdAt: args.now - 60 * 86_400_000 }) });
    }
    const sprints: { number: number; id: Id<'sprints'> }[] = [];
    for (const sprint of args.sprints) {
      sprints.push({
        number: sprint.number,
        id: await ctx.db.insert('sprints', { ...sprint, source: SPRINT_SOURCE, updatedAt: sprint.closedAt ?? sprint.startedAt ?? args.now }),
      });
    }
    for (const { teamKey, labels: names, ...r } of args.recurrences) {
      await ctx.db.insert('recurrences', {
        ...r,
        teamId: teamId(teamKey),
        labelIds: names.map((n) => labels.find((l) => l.name === n)!.id),
        active: true,
        createdAt: args.now,
      });
    }
    return { teams, labels, projects, agents, sprints };
  },
});

const seedActor = actorValidator;

/** Up to 200 issues with description, comments, history and sprint entries. */
export const insertIssues = ownerMutation({
  args: {
    issues: v.array(
      v.object({
        seq: v.number(),
        teamId: v.id('teams'),
        number: v.number(),
        title: v.string(),
        status: statusValidator,
        priority: priorityValidator,
        labelIds: v.array(v.id('labels')),
        projectId: v.optional(v.id('projects')),
        estimate: v.optional(v.number()),
        dueDate: v.optional(v.string()),
        sprintId: v.optional(v.id('sprints')),
        rank: v.string(),
        createdBy: seedActor,
        reviewedAt: v.optional(v.number()),
        readAt: v.optional(v.number()),
        createdAt: v.number(),
        updatedAt: v.number(),
        startedAt: v.optional(v.number()),
        completedAt: v.optional(v.number()),
        canceledAt: v.optional(v.number()),
        deletedAt: v.optional(v.number()),
        description: v.string(),
        comments: v.array(v.object({ author: seedActor, body: v.string(), createdAt: v.number() })),
        sprintItems: v.array(
          v.object({
            sprintId: v.id('sprints'),
            kind: sprintItemKindValidator,
            carriedFrom: v.optional(v.id('sprints')),
            addedAt: v.number(),
            addedBy: seedActor,
            removedAt: v.optional(v.number()),
            outcome: v.optional(sprintOutcomeValidator),
          }),
        ),
        history: v.array(
          v.object({ field: v.string(), from: v.optional(v.any()), to: v.optional(v.any()), actor: seedActor, at: v.number() }),
        ),
      }),
    ),
  },
  handler: async (ctx, args) => {
    assertSeedAllowed();
    if (args.issues.length > MAX_ISSUES_PER_CALL) fail('invalid', `At most ${MAX_ISSUES_PER_CALL} issues per call.`);
    for (const { description, comments, sprintItems, history, ...issue } of args.issues) {
      const state = stateForStatus(await ensureTeamStates(ctx, issue.teamId, issue.createdAt), issue.status);
      if (!state) fail('invalid', `No state for "${issue.status}".`);
      const issueId = await ctx.db.insert('issues', { ...issue, ...stateFields(state), bucket: bucketOf(issue.seq) });
      await ctx.db.insert('issueBodies', {
        issueId,
        markdown: description,
        version: 1,
        updatedAt: issue.createdAt,
        updatedBy: issue.createdBy,
      });
      await ctx.db.insert('bodySearch', { issueId, text: description.slice(0, BODY_SEARCH_CHARS) });
      for (const comment of comments) await ctx.db.insert('comments', { issueId, ...comment });
      for (const item of sprintItems) await ctx.db.insert('sprintItems', { issueId, ...item });
      for (const row of history) await ctx.db.insert('history', { issueId, ...row });
      // Inbox: issues without `reviewedAt` start in it; a recent agent comment on an issue the owner
      // already reviewed shows up as a change, so the inbox has both kinds of entries.
      if (issue.deletedAt === undefined) {
        const lastAgentComment = [...comments].reverse().find((c) => c.author.kind === 'agent' && c.createdAt > Date.now() - 3 * DAY_MS);
        if (issue.reviewedAt === undefined) await openCreatedEntry(ctx, issue.createdBy, issueId, issue.createdAt, issue.readAt);
        else if (lastAgentComment) {
          const at = lastAgentComment.createdAt;
          const change = { field: 'comment', actor: lastAgentComment.author, at, value: lastAgentComment.body.slice(0, 120) };
          await ctx.db.insert('inboxEntries', { issueId, kind: 'changed', actor: change.actor, changes: [change], createdAt: at, updatedAt: at });
        }
      }
    }
    return { inserted: args.issues.length };
  },
});

async function bySeq(ctx: MutationCtx, seq: number) {
  const issue = await ctx.db
    .query('issues')
    .withIndex('by_seq', (q) => q.eq('seq', seq))
    .unique();
  if (!issue) fail('not_found', `Issue with seq ${seq} is missing.`);
  return issue;
}

/** Links by seq: parent, relations, old identifiers. */
export const insertLinks = ownerMutation({
  args: {
    parents: v.array(v.object({ seq: v.number(), parentSeq: v.number() })),
    relations: v.array(
      v.object({ fromSeq: v.number(), toSeq: v.number(), type: relationTypeValidator, createdAt: v.number(), createdBy: seedActor }),
    ),
    aliases: v.array(v.object({ key: v.string(), seq: v.number() })),
  },
  handler: async (ctx, args) => {
    assertSeedAllowed();
    for (const { seq, parentSeq } of args.parents) {
      const issue = await bySeq(ctx, seq);
      await ctx.db.patch('issues', issue._id, { parentId: (await bySeq(ctx, parentSeq))._id });
    }
    for (const { fromSeq, toSeq, ...relation } of args.relations) {
      await ctx.db.insert('relations', { ...relation, fromId: (await bySeq(ctx, fromSeq))._id, toId: (await bySeq(ctx, toSeq))._id });
    }
    for (const alias of args.aliases) {
      await ctx.db.insert('identifierAliases', { key: alias.key, issueId: (await bySeq(ctx, alias.seq))._id });
    }
    return { parents: args.parents.length, relations: args.relations.length, aliases: args.aliases.length };
  },
});

/** Sample PRs (data/pullRequests.ts) with their stored GitHub state, without GitHub. */
export const insertPullRequests = ownerMutation({
  args: {
    prs: v.array(
      v.object({
        issueSeqs: v.array(v.number()),
        closes: v.boolean(),
        pr: v.object({
          repo: v.string(),
          number: v.number(),
          title: v.string(),
          url: v.string(),
          state: prStateValidator,
          branch: v.string(),
          author: v.string(),
          updatedAt: v.number(),
          mergedAt: v.optional(v.number()),
          headSha: v.string(),
        }),
        detail: prDetailDataValidator,
        items: v.array(v.object(prItemFields)),
      }),
    ),
    fetchedAt: v.number(),
  },
  handler: async (ctx, args) => {
    assertSeedAllowed();
    for (const { issueSeqs, closes, pr, detail, items } of args.prs) {
      const prId = await ctx.db.insert('pullRequests', pr);
      for (const seq of issueSeqs) {
        await ctx.db.insert('issuePullRequests', { issueId: (await bySeq(ctx, seq))._id, prId, via: 'branch', closes });
      }
      const reviews = new Map<string, 'approved' | 'changes_requested'>();
      for (const item of items) {
        if (item.reviewState === 'approved' || item.reviewState === 'changes_requested') reviews.set(item.author.login, item.reviewState);
      }
      const decisions = [...reviews.values()];
      const review = decisions.includes('changes_requested') ? 'changes_requested' : decisions.includes('approved') ? 'approved' : undefined;
      await ctx.db.insert('pullRequestDetails', {
        prId,
        media: [],
        fetchedAt: args.fetchedAt,
        data: detail,
        summary: { comments: items.filter((i) => i.kind !== 'review').length, ...(review ? { review } : {}) },
      });
      await writeStatus(ctx, prId, prStatusOf(detail, review));
      for (const item of items) await ctx.db.insert('pullRequestItems', { prId, ...item });
    }
    return { prs: args.prs.length };
  },
});

/** A small models catalog (data/models.ts) with some models enabled, so local work needs no models.dev. */
export const insertModels = ownerMutation({
  args: { providers: v.array(slimProviderValidator), enable: v.array(modelRefValidator) },
  handler: async (ctx, args) => {
    assertSeedAllowed();
    const now = Date.now();
    for (const p of args.providers) await applyProvider(ctx, p, now);
    for (const m of args.enable) await setModelEnabled(ctx, ctx.actor, { ...m, enabled: true });
    return { providers: args.providers.length };
  },
});

/** Sets the counters and marks the dataset complete. Only then does the client see new buckets. */
export const finish = ownerMutation({
  args: {
    set: v.string(),
    count: v.number(),
    teamNumbers: v.array(v.object({ teamId: v.id('teams'), number: v.number() })),
    sprintNumber: v.number(),
  },
  handler: async (ctx, args) => {
    assertSeedAllowed();
    await setCounter(ctx, SEQ, args.count - 1, true);
    await setCounter(ctx, SPRINT, args.sprintNumber, true);
    for (const { teamId, number } of args.teamNumbers) await setCounter(ctx, teamCounter(teamId), number, true);
    await writeOpsStatus(ctx, 'seed', { set: args.set, count: args.count, finishedAt: Date.now() });
    return { ok: true };
  },
});

// ---------------------------------------------------------------- Roadmap sample (SELF-113)

/** Category, title, status, days ago started / completed, public card (title, summary, image index). */
type DemoIssue = [project: number, category: number, title: string, status: 'done' | 'in_review' | 'in_progress' | 'todo' | 'backlog', started: number | null, completed: number | null, card?: [title: string | null, summary: string, image?: number]];

const DEMO_CATEGORIES: [string, number][] = [
  ['Figuren', 25],
  ['Orte', 150],
  ['Gegner', 0],
  ['Fähigkeiten', 285],
  ['Klang und Grafik', 210],
  ['Technik', 245],
];

const DEMO_PROJECTS: { name: string; state: 'done' | 'active' | 'planned'; period: string; hue: number; description: string; readyWhen: string }[] = [
  { name: 'Etappe 1 · Erster Funke', state: 'done', period: '2026-Q2', hue: 45, description: 'Ein spielbarer Lauf vom Start bis zum ersten Wächter.', readyWhen: 'Ein Lauf lässt sich gewinnen und verlieren.' },
  { name: 'Etappe 2 · Die Gießerei', state: 'active', period: '2026-Q4', hue: 25, description: 'Der zweite Kreis mit neuen Gegnern und der Schmiede.', readyWhen: 'Drei Builds tragen bis zum zweiten Wächter.' },
  { name: 'Etappe 3 · Unter Asche', state: 'planned', period: '2027-Q1', hue: 15, description: 'Tiefer in die Asche: Fallen, Nebel und ein neuer Held.', readyWhen: 'Alle drei Kreise sind spielbar.' },
  { name: 'Etappe 4 · Glutkern', state: 'planned', period: '2027-Q2', hue: 5, description: 'Das Herz der Welt und das Ende der Geschichte.', readyWhen: 'Der Endkampf ist fertig vertont.' },
];

// Sample texts for a fictional game; public cards are written for players.
const DEMO_ISSUES: DemoIssue[] = [
  [0, 0, 'Held: Grundbewegung und Ausweichrolle', 'done', 210, 180, ['Die Glutritterin', 'Die erste Heldin: schnell, mit einer Rolle, die Funken hinterlässt.', 0]],
  [0, 1, 'Erster Kreis: Raster und Übergänge', 'done', 205, 170, ['Der erste Kreis', 'Schmiedehallen voller Funken und alter Maschinen.', 1]],
  [0, 2, 'Wächter 1: Phasen und Angriffe', 'done', 190, 150, ['Der Hammerwächter', 'Ein Koloss aus Eisen, der den Weg zur Gießerei bewacht.', 2]],
  [0, 3, 'Segen: erste zwölf Effekte', 'done', 185, 160, ['Zwölf Segen', 'Kleine Gaben der Glut, die jeden Lauf anders machen.']],
  [0, 5, 'Speicherstand zwischen den Läufen', 'done', 175, 140],
  [0, 4, 'Musik: Thema des ersten Kreises', 'done', 170, 135, [null, 'Das Thema des ersten Kreises, mit Amboss und Chor.']],
  [0, 2, 'Fehler: Wächter bleibt in Phase 2 hängen', 'done', 150, 147],
  [1, 0, 'Zweite Figur: der Aschemönch', 'in_progress', 40, null, ['Der Aschemönch', 'Langsam, aber jeder Schlag lässt Asche regnen.', 3]],
  [1, 1, 'Zweiter Kreis: die Gießerei', 'in_review', 55, null, ['Die Gießerei', 'Flüsse aus flüssigem Kupfer und Brücken, die sich bewegen.', 4]],
  [1, 2, 'Gegner: Schlackenläufer', 'done', 70, 30, ['Schlackenläufer', 'Flinke Gegner, die in Rudeln angreifen.']],
  [1, 2, 'Gegner: Tiegelwächter', 'in_progress', 20, null],
  [1, 3, 'Schmiede: Waffen verbessern', 'in_progress', 35, null, ['Die Schmiede', 'Zwischen den Läufen Waffen härten, umschmieden und benennen.', 5]],
  [1, 3, 'Segen: Kombinationen anzeigen', 'todo', null, null, ['Segen kombinieren', 'Zeigt, welche Segen sich gegenseitig verstärken.']],
  [1, 4, 'Grafik: Hitzeflimmern im zweiten Kreis', 'done', 60, 25],
  [1, 5, 'Steuerung mit dem Gamepad', 'in_review', 30, null, ['Gamepad', 'Volle Unterstützung für Controller, frei belegbar.']],
  [1, 5, 'Ladezeiten unter zwei Sekunden', 'todo', null, null],
  [1, 2, 'Wächter 2: Spoiler-Phase (intern)', 'todo', null, null],
  [2, 1, 'Dritter Kreis: Aschefelder', 'todo', null, null, ['Die Aschefelder', 'Nebel, Glutnester und Wege, die nur einmal halten.', 1]],
  [2, 0, 'Dritte Figur: Entwurf', 'backlog', null, null, ['Eine dritte Figur', 'Noch geheim, aber sie kommt mit einer Kette.']],
  [2, 2, 'Fallen: Glutspalten', 'todo', null, null],
  [2, 4, 'Klang: Wind und Asche', 'backlog', null, null, [null, 'Ein neuer Klangteppich für die Aschefelder.']],
  [2, 3, 'Fluch-System (Entwurf)', 'backlog', null, null],
  [3, 2, 'Endkampf: Der Glutkern', 'backlog', null, null, ['Der Glutkern', 'Das Herz der Welt wartet am Ende des letzten Kreises.', 2]],
  [3, 4, 'Vertonung der Erzählerin', 'backlog', null, null],
  [3, 5, 'Erfolge und Statistiken', 'backlog', null, null, ['Erfolge', 'Ziele für Sammler und eine Statistik über alle Läufe.']],
];

/**
 * A sample team "Emberfall" (key EMB) with a roadmap: projects as stages with periods, categories,
 * issues with past start and completion times and public cards. For screenshots and tests, local only.
 * `images`: URLs of uploaded images (`files.register`) for the cover pictures. Does nothing if EMB exists.
 */
export const roadmapDemo = ownerMutation({
  args: { images: v.array(v.string()) },
  handler: async (ctx, args) => {
    assertSeedAllowed();
    const existing = await ctx.db
      .query('teams')
      .withIndex('by_key', (q) => q.eq('key', 'EMB'))
      .first();
    if (existing) return { teamId: existing._id, created: false };
    const now = Date.now();
    const { teamId } = await createTeam(ctx, ctx.actor, { key: 'EMB', name: 'Emberfall', hue: 35 });
    const { groupId } = await createLabelGroup(ctx, ctx.actor, { name: 'Kategorie', exclusive: true, hue: 30, teamId });
    const labels: Id<'labels'>[] = [];
    for (const [name, hue] of DEMO_CATEGORIES) labels.push((await createLabel(ctx, ctx.actor, { name, hue, groupId, teamId, position: labels.length + 1 })).labelId);
    const projects: Id<'projects'>[] = [];
    for (const p of DEMO_PROJECTS) projects.push((await createProject(ctx, ctx.actor, { teamId, ...p })).projectId);
    const { issues } = await createIssuesCore(ctx, ctx.actor, {
      issues: DEMO_ISSUES.map(([project, category, title, status, , , card]) => ({ teamId, title, status, projectId: projects[project], labelIds: [labels[category]!], public: !!card })),
    });
    for (const [i, { id }] of issues.entries()) {
      const [, , , status, started, completed, card] = DEMO_ISSUES[i]!;
      const startedAt = started === null ? undefined : now - started * DAY_MS;
      const completedAt = completed === null ? undefined : now - completed * DAY_MS;
      await ctx.db.patch('issues', id, { createdAt: (startedAt ?? now) - 7 * DAY_MS, startedAt, ...(status === 'done' ? { completedAt } : {}), updatedAt: completedAt ?? now });
      if (card) {
        const [title, summary, image] = card;
        await setPublicCard(ctx, ctx.actor, { id, title, summary, image: image !== undefined ? (args.images[image] ?? null) : null }, now);
      }
    }
    await updateRoadmapSettings(ctx, ctx.actor, { teamId, on: true, categoryGroupId: groupId, subtitle: 'Early Access · Fahrplan', accent: '#d9782f' });
    return { teamId, created: true };
  },
});
