// Readable side of the data export: one Markdown file per issue and per knowledge page, plus an
// overview. English on purpose: the same text comes out of the app and of tooling/export (Node,
// no UI language). Pure functions over the exported tables.
import type { Doc } from '@selfbound/backend/dataModel';
import type { ExportTables } from './types.ts';

const PRIORITY = ['None', 'Urgent', 'High', 'Medium', 'Low'];
const RELATION: Record<string, [string, string]> = {
  blocks: ['Blocks', 'Blocked by'],
  related: ['Related to', 'Related to'],
  duplicate: ['Duplicate of', 'Duplicated by'],
};
const STATUS: Record<string, string> = {
  triage: 'Triage',
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
  canceled: 'Canceled',
  duplicate: 'Duplicate',
};
const STATE_TYPES = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'];
/** History field → readable name (fields not listed stay as stored). */
const FIELD: Record<string, string> = {
  stateId: 'status',
  labelIds: 'labels',
  projectId: 'project',
  sprintId: 'sprint',
  parentId: 'parent',
  dueDate: 'due date',
  snoozedUntil: 'snoozed until',
  teamId: 'team',
};
const IMAGE_RE = /(?:https?:\/\/[^\s()<>"']*)?\/img\/([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g;

type Any = Record<string, unknown>;

/** Lookups shared by all renderers, built once per export. */
export class ExportIndex {
  readonly teams = new Map<string, Doc<'teams'>>();
  readonly states = new Map<string, Doc<'workflowStates'>>();
  readonly issues = new Map<string, Doc<'issues'>>();
  readonly bodies = new Map<string, Doc<'issueBodies'>>();
  readonly articleBodies = new Map<string, Doc<'articleBodies'>>();
  readonly comments = new Map<string, Doc<'comments'>[]>();
  readonly history = new Map<string, Doc<'history'>[]>();
  readonly children = new Map<string, Doc<'issues'>[]>();
  readonly sources = new Map<string, Doc<'articleSources'>[]>();
  readonly prs = new Map<string, Doc<'pullRequests'>[]>();
  readonly relations = new Map<string, Doc<'relations'>[]>();
  readonly aliases = new Map<string, string[]>();
  /** Any id → display name (labels, projects, sprints, topics, states, teams, issues as identifiers). */
  readonly names = new Map<string, string>();
  readonly agents = new Map<string, string>();
  readonly ownerName: string;
  /** Image token → path of the file inside the ZIP. */
  readonly images = new Map<string, string>();

  readonly tables: ExportTables;

  // No parameter property: Node runs this file with type stripping only (tooling/export).
  constructor(tables: ExportTables) {
    this.tables = tables;
    for (const team of tables.teams) {
      this.teams.set(team._id, team);
      this.names.set(team._id, team.key);
    }
    for (const state of tables.workflowStates) {
      this.states.set(state._id, state);
      this.names.set(state._id, state.name);
    }
    for (const row of [...tables.labels, ...tables.labelGroups, ...tables.projects, ...tables.sprints, ...tables.wikiTopics]) this.names.set(row._id, row.name);
    for (const article of tables.articles) this.names.set(article._id, article.title);
    for (const issue of tables.issues) {
      this.issues.set(issue._id, issue);
      this.names.set(issue._id, this.identifier(issue));
      if (issue.parentId) push(this.children, issue.parentId, issue);
    }
    for (const body of tables.issueBodies) this.bodies.set(body.issueId, body);
    for (const body of tables.articleBodies) this.articleBodies.set(body.articleId, body);
    for (const comment of tables.comments) push(this.comments, comment.issueId, comment);
    for (const row of tables.history) push(this.history, row.issueId, row);
    for (const source of tables.articleSources) push(this.sources, source.articleId, source);
    const prById = new Map(tables.pullRequests.map((pr) => [pr._id, pr]));
    for (const link of tables.issuePullRequests) {
      const pr = prById.get(link.prId);
      if (pr) push(this.prs, link.issueId, pr);
    }
    for (const r of tables.relations) {
      push(this.relations, r.fromId, r);
      if (r.toId !== r.fromId) push(this.relations, r.toId, r);
    }
    for (const alias of tables.identifierAliases) push(this.aliases, alias.issueId, alias.key);
    for (const agent of tables.agents) this.agents.set(agent._id, agent.name);
    this.ownerName = tables.profile[0]?.name ?? 'Owner';
    for (const list of [this.comments, this.history]) for (const rows of list.values()) rows.sort((a, b) => at(a) - at(b));
    for (const rows of this.sources.values()) rows.sort((a, b) => a.order - b.order);
  }

  identifier(issue: Doc<'issues'>): string {
    return `${this.teams.get(issue.teamId)?.key ?? '?'}-${issue.number}`;
  }

  actor(actor: { kind: string; agentId?: string }, importedName?: string): string {
    switch (actor.kind) {
      case 'owner':
      case 'steven': // legacy-xlr8: old stored owner kind
        return this.ownerName;
      case 'agent':
        return `${(actor.agentId && this.agents.get(actor.agentId)) || 'Agent'} (agent)`;
      case 'github':
        return 'GitHub';
      case 'import':
        return importedName ? `${importedName} (import)` : 'Import';
      default:
        return 'System';
    }
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const at = (row: Any) => (typeof row.createdAt === 'number' ? row.createdAt : typeof row.at === 'number' ? row.at : 0);

/** UTC time, readable and sortable: 2026-10-19 14:05 UTC. */
export function time(ms: number | undefined): string {
  return ms === undefined ? '' : `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** A YAML value: strings and lists as JSON (valid YAML), numbers as they are. */
function yaml(value: unknown): string {
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
}

function frontmatter(fields: [string, unknown][]): string {
  const lines = fields.filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)).map(([k, v]) => `${k}: ${yaml(v)}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * File or folder name from a title that extracts on Windows, macOS and Linux: no path or reserved
 * characters, no leading or trailing dots, no device names (CON, NUL …), NFC, at most 80 characters.
 */
export function safeName(title: string): string {
  const name = title
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .replace(/[\s.]+$/, '');
  if (!name) return 'Untitled';
  return RESERVED.test(name) ? `${name}_` : name;
}

/** Makes a path unique among `taken` (case-insensitive, as on Windows and macOS): "Name (2).md". */
export function uniquePath(taken: Set<string>, folder: string, name: string, ext = '.md'): string {
  let candidate = name;
  for (let n = 2; taken.has(`${folder}/${candidate}${ext}`.toLowerCase()); n++) candidate = `${name} (${n})`;
  taken.add(`${folder}/${candidate}${ext}`.toLowerCase());
  return `${folder}/${candidate}${ext}`;
}

/** Relative link from one ZIP path to another. */
export function relativePath(from: string, to: string): string {
  const a = from.split('/').slice(0, -1);
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

/** Points image links at the exported files, so the Markdown works without the instance. */
function localImages(text: string, index: ExportIndex, path: string): string {
  if (!text.includes('/img/')) return text;
  return text.replace(IMAGE_RE, (match, token: string) => {
    const file = index.images.get(token);
    return file ? relativePath(path, file) : match;
  });
}

function short(value: string, max = 120): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A history value with ids replaced by names. */
function historyValue(field: string, value: unknown, index: ExportIndex): string {
  if (value === undefined || value === null || value === '') return '–';
  if (field === 'priority' && typeof value === 'number') return PRIORITY[value] ?? String(value);
  if (field === 'status' && typeof value === 'string') return STATUS[value] ?? value;
  if (typeof value === 'string') return short(index.names.get(value) ?? value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length ? value.map((v) => historyValue(field, v, index)).join(', ') : '–';
  const obj = value as Any;
  if (typeof obj.provider === 'string' && typeof obj.modelId === 'string') return `${obj.provider}/${obj.modelId}`;
  if (typeof obj.otherId === 'string' && typeof obj.type === 'string') {
    return `${RELATION[obj.type]?.[obj.direction === 'in' ? 1 : 0] ?? obj.type} ${index.names.get(obj.otherId) ?? 'an issue'}`;
  }
  if (typeof obj.identifier === 'string') return typeof obj.title === 'string' ? `${obj.identifier} ${short(obj.title, 80)}` : obj.identifier;
  return short(JSON.stringify(value));
}

/** Paths of all issue files, unique even for odd data (two issues with one number, a missing team). */
export function issuePaths(index: ExportIndex): Map<string, string> {
  const taken = new Set<string>();
  const paths = new Map<string, string>();
  for (const issue of [...index.tables.issues].sort((a, b) => a.seq - b.seq)) {
    const team = safeName(index.teams.get(issue.teamId)?.key ?? 'unknown');
    const folder = `markdown/${issue.deletedAt ? 'trash/' : ''}issues/${team}`;
    paths.set(issue._id, uniquePath(taken, folder, safeName(`${index.identifier(issue)} ${issue.title}`)));
  }
  return paths;
}

export function issueMarkdown(issue: Doc<'issues'>, index: ExportIndex, path: string): string {
  const id = index.identifier(issue);
  const state = issue.stateId ? index.states.get(issue.stateId) : undefined;
  const parent = issue.parentId ? index.issues.get(issue.parentId) : undefined;
  const out: string[] = [];
  out.push(
    frontmatter([
      ['id', id],
      ['title', issue.title],
      ['team', index.teams.get(issue.teamId)?.key],
      ['status', state?.name ?? STATUS[issue.status] ?? issue.status],
      ['priority', PRIORITY[issue.priority]],
      ['labels', issue.labelIds.map((l) => index.names.get(l) ?? l)],
      ['project', issue.projectId && index.names.get(issue.projectId)],
      ['sprint', issue.sprintId && index.names.get(issue.sprintId)],
      ['parent', parent && index.identifier(parent)],
      ['estimate', issue.estimate],
      ['due', issue.dueDate],
      ['snoozed_until', issue.snoozedUntil],
      ['model', issue.model && `${issue.model.provider}/${issue.model.modelId}${issue.model.effort ? ` (${issue.model.effort})` : ''}`],
      ['created', time(issue.createdAt)],
      ['created_by', index.actor(issue.createdBy)],
      ['updated', time(issue.updatedAt)],
      ['started', time(issue.startedAt)],
      ['completed', time(issue.completedAt)],
      ['canceled', time(issue.canceledAt)],
      ['deleted', time(issue.deletedAt)],
      ['previous_identifiers', index.aliases.get(issue._id) ?? []],
    ]),
  );
  out.push(`# ${id} ${issue.title}\n`);
  const body = index.bodies.get(issue._id)?.markdown.trim();
  if (body) out.push(`${localImages(body, index, path)}\n`);

  const relations: string[] = [];
  for (const r of index.relations.get(issue._id) ?? []) {
    const outgoing = r.fromId === issue._id;
    const other = index.issues.get(outgoing ? r.toId : r.fromId);
    const label = RELATION[r.type]?.[outgoing ? 0 : 1] ?? r.type;
    relations.push(`- ${label} ${other ? `${index.identifier(other)} ${other.title}` : '(deleted issue)'}`);
  }
  if (relations.length) out.push(`## Relations\n\n${relations.join('\n')}\n`);

  const children = index.children.get(issue._id) ?? [];
  if (children.length) out.push(`## Sub-issues\n\n${children.map((c) => `- ${index.identifier(c)} ${c.title}`).join('\n')}\n`);

  const prs = index.prs.get(issue._id) ?? [];
  if (prs.length) out.push(`## Pull requests\n\n${prs.map((pr) => `- [${pr.repo}#${pr.number} ${pr.title}](${pr.url}) (${pr.state})`).join('\n')}\n`);

  const comments = (index.comments.get(issue._id) ?? []).filter((c) => !c.deletedAt);
  if (comments.length) {
    out.push('## Comments\n');
    for (const c of comments) {
      out.push(`### ${index.actor(c.author, c.authorName)} · ${time(c.createdAt)}${c.editedAt ? ` (edited ${time(c.editedAt)})` : ''}\n\n${localImages(c.body.trim(), index, path)}\n`);
    }
  }

  const history = index.history.get(issue._id) ?? [];
  if (history.length) {
    const lines = history.map((h) => {
      const who = `${time(h.at)} · ${index.actor(h.actor)}`;
      if (h.field === 'created') return `- ${who} · created`;
      if (h.field === 'description') return `- ${who} · changed the description`;
      if (h.field === 'comment') return `- ${who} · ${h.to === undefined ? 'removed a comment' : 'commented'}`;
      if (h.from === undefined && h.to === undefined) return `- ${who} · ${h.field}`;
      return `- ${who} · ${FIELD[h.field] ?? h.field}: ${historyValue(h.field, h.from, index)} → ${historyValue(h.field, h.to, index)}`;
    });
    out.push(`## History\n\n${lines.join('\n')}\n`);
  }
  return out.join('\n');
}

/** Paths of all knowledge pages: folders follow the page tree, siblings with the same name get a number. */
export function articlePaths(index: ExportIndex): Map<string, string> {
  const paths = new Map<string, string>();
  const byId = new Map(index.tables.articles.map((a) => [a._id, a]));
  const taken = new Set<string>();
  const sorted = [...index.tables.articles].sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a._creationTime - b._creationTime));
  const visiting = new Set<string>();
  const resolve = (article: Doc<'articles'>): string => {
    const known = paths.get(article._id);
    if (known) return known;
    visiting.add(article._id);
    // A parent that is missing, or part of a cycle (the schema forbids both), makes the page a root.
    const parent = article.parentId && !visiting.has(article.parentId) ? byId.get(article.parentId) : undefined;
    const team = safeName(index.teams.get(article.teamId)?.key ?? 'unknown');
    const folder = parent ? resolve(parent).replace(/\.md$/, '') : `markdown/${article.deletedAt ? 'trash/' : ''}knowledge/${team}`;
    visiting.delete(article._id);
    const path = uniquePath(taken, folder, safeName(article.title));
    paths.set(article._id, path);
    return path;
  };
  for (const article of sorted) resolve(article);
  return paths;
}

export function articleMarkdown(article: Doc<'articles'>, index: ExportIndex, path: string): string {
  const out: string[] = [];
  const body = index.articleBodies.get(article._id);
  out.push(
    frontmatter([
      ['title', article.title],
      ['team', index.teams.get(article.teamId)?.key],
      ['parent', article.parentId && index.names.get(article.parentId)],
      ['project', article.projectId && index.names.get(article.projectId)],
      ['topics', article.topicIds.map((t) => index.names.get(t) ?? t)],
      ['created', time(article.createdAt)],
      ['created_by', index.actor(article.createdBy)],
      ['updated', time(Math.max(article.updatedAt, body?.updatedAt ?? 0))],
      ['updated_by', index.actor(body && body.updatedAt > article.updatedAt ? body.updatedBy : article.updatedBy)],
      ['deleted', time(article.deletedAt)],
    ]),
  );
  out.push(`# ${article.title}\n`);
  const text = body?.markdown.trim();
  if (text) out.push(`${localImages(text, index, path)}\n`);
  const sources = index.sources.get(article._id) ?? [];
  if (sources.length) {
    const lines = sources.map((s) => {
      const title = s.title ?? s.url ?? '';
      const head = s.url ? `[${title}](${s.url})` : title;
      const meta = [s.author, s.publishedAt, `accessed ${s.accessedAt}`].filter(Boolean).join(', ');
      return `- ${head} (${meta})${s.note ? `: ${s.note}` : ''}`;
    });
    out.push(`## Sources\n\n${lines.join('\n')}\n`);
  }
  return out.join('\n');
}

function table(head: string[], rows: string[][]): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}

/** Overview: what the export holds, teams with their statuses, projects and labels, sprints. */
export function readmeMarkdown(index: ExportIndex, info: { exportedAt: number; counts: Record<string, number>; files: number; missingFiles: number }): string {
  const { tables } = index;
  const out: string[] = [];
  out.push(`# Selfbound export\n\nExported ${time(info.exportedAt)}.\n`);
  out.push(
    [
      '- `json/`: every table as stored, one file per table (`json/manifest.json` names format and version). This is the complete copy.',
      '- `markdown/issues/<TEAM>/`: one file per issue with description, comments and history.',
      '- `markdown/knowledge/<TEAM>/`: one file per knowledge page; folders follow the page tree.',
      '- `markdown/trash/`: issues and pages in the trash.',
      '- `files/`: images from descriptions, comments and pages, team logos and the profile picture.',
      '',
    ].join('\n'),
  );
  const live = tables.issues.filter((i) => !i.deletedAt);
  out.push(
    table(
      ['What', 'Count'],
      [
        ['Teams', String(tables.teams.length)],
        ['Issues', `${live.length}${live.length < tables.issues.length ? ` (+${tables.issues.length - live.length} in the trash)` : ''}`],
        ['Comments', String(tables.comments.filter((c) => !c.deletedAt).length)],
        ['History entries', String(tables.history.length)],
        ['Knowledge pages', String(tables.articles.filter((a) => !a.deletedAt).length)],
        ['Projects', String(tables.projects.length)],
        ['Labels', String(tables.labels.length)],
        ['Sprints', String(tables.sprints.length)],
        ['Files', `${info.files}${info.missingFiles ? ` (${info.missingFiles} could not be read)` : ''}`],
      ],
    ) + '\n',
  );

  for (const team of [...tables.teams].sort((a, b) => a.order - b.order)) {
    out.push(`## ${team.key} ${team.name}${team.dormant ? ' (dormant)' : ''}\n`);
    const states = tables.workflowStates
      .filter((s) => s.teamId === team._id && !s.archivedAt)
      .sort((a, b) => STATE_TYPES.indexOf(a.type) - STATE_TYPES.indexOf(b.type) || a.position - b.position);
    if (states.length) out.push(`Statuses: ${states.map((s) => s.name).join(', ')}\n`);
    const projects = tables.projects.filter((p) => p.teamId === team._id).sort((a, b) => a.order - b.order);
    if (projects.length) out.push(`Projects: ${projects.map((p) => `${p.name} (${p.state})`).join(', ')}\n`);
    const labels = tables.labels.filter((l) => l.teamId === team._id && !l.archived);
    if (labels.length) out.push(`Team labels: ${labels.map((l) => l.name).join(', ')}\n`);
    const count = live.filter((i) => i.teamId === team._id).length;
    out.push(`${count} issues.\n`);
  }

  const workspaceLabels = tables.labels.filter((l) => !l.teamId && !l.archived);
  if (workspaceLabels.length) {
    const group = (l: Doc<'labels'>) => (l.groupId ? `${index.names.get(l.groupId)}: ` : '');
    out.push(`## Workspace labels\n\n${workspaceLabels.map((l) => `- ${group(l)}${l.name}`).join('\n')}\n`);
  }

  if (tables.sprints.length) {
    const rows = [...tables.sprints]
      .sort((a, b) => a.number - b.number)
      .map((s) => [String(s.number), s.name, `${s.startDate} – ${s.endDate}`, s.state, s.goal]);
    out.push(`## Sprints\n\n${table(['#', 'Name', 'Dates', 'State', 'Goal'], rows)}\n`);
  }

  if (tables.recurrences.length) {
    const rows = tables.recurrences.map((r) => [index.names.get(r.teamId) ?? '', r.title, r.cadence, r.active ? 'yes' : 'no', r.nextDate]);
    out.push(`## Recurring issues\n\n${table(['Team', 'Title', 'Cadence', 'Active', 'Next'], rows)}\n`);
  }
  return out.join('\n');
}
