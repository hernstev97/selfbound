// Settings: teams and logos, projects, labels, agent keys, recurrences, ops.
// A separate module (`@selfbound/core/app/admin`), loaded only from the settings chunk so the start
// bundle does not grow. Every change shows errors as a toast with the server's reason; metadata
// (teams, projects, labels) changes optimistically in `meta.get`.
import type { OptimisticLocalStore } from 'convex/browser';
import { api } from '@selfbound/backend/api';
import { imageTokens, LIMITS } from '@selfbound/backend/constants';
import type { Id } from '@selfbound/backend/dataModel';
import type { LabelDoc, LabelGroupDoc, Meta, ProjectDoc, StateDoc, StateId, TeamDoc, TeamId } from '../types.ts';
import type { StateType } from '@selfbound/backend/shared/workflow';
import type { App } from './index.ts';
import { errorMessage } from './toasts.ts';
import { t, tc } from '../i18n.ts';

export type LogoVariant = 'light' | 'dark';
export type ProjectState = ProjectDoc['state'];

/** Hues to choose from (OKLCH hue). */
export const HUES = [25, 45, 85, 140, 160, 195, 220, 250, 275, 300, 330, 0];

/** Colors for statuses. */
export const STATE_COLORS = ['#bec2c8', '#95a2b3', '#e2e2e2', '#f2c94c', '#f1bf00', '#f2994a', '#ff7236', '#eb5757', '#4cb782', '#26b5ce', '#5e6ad2', '#bb87fc'];

/** Project state names, translated on read. */
export const PROJECT_STATE_LABEL: Record<ProjectState, string> = {
  get planned() {
    return t('Planned');
  },
  get active() {
    return t('Active');
  },
  get paused() {
    return t('Paused');
  },
  get done() {
    return tc('project', 'Done');
  },
  get canceled() {
    return t('Canceled');
  },
};

/** Site URL for HTTP endpoints (MCP): set via VITE_CONVEX_SITE_URL, else derived from the Convex URL. */
export function siteUrl(convexUrl: string, explicit?: string) {
  if (explicit) return explicit.replace(/\/$/, '');
  try {
    const url = new URL(convexUrl);
    if (url.hostname.endsWith('.convex.cloud')) return `${url.protocol}//${url.hostname.replace(/\.convex\.cloud$/, '.convex.site')}`;
    if (url.port) return `${url.protocol}//${url.hostname}:${Number(url.port) + 1}`;
    return url.origin;
  } catch {
    return convexUrl;
  }
}

/** Ready-made command for Claude Code. */
export function mcpCommand(site: string, key: string) {
  return `claude mcp add --transport http selfbound ${site}/mcp --header "Authorization: Bearer ${key}"`;
}

/** Precheck in the browser (the server does the real check). */
export function precheckLogo(file: { name: string; type: string; size: number }): string | null {
  const type = file.type || (file.name.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : file.name.toLowerCase().endsWith('.png') ? 'image/png' : '');
  if (type !== 'image/svg+xml' && type !== 'image/png') return t('Only SVG and PNG are allowed.');
  if (file.size > LIMITS.logoMaxBytes) return t('The logo is too large (at most {size} KB).', { size: LIMITS.logoMaxBytes / 1024 });
  if (file.size === 0) return t('The file is empty.');
  return null;
}

type MetaPatch = (meta: Meta) => Meta;

export class Admin {
  constructor(private app: App) {}

  get store() {
    return this.app.store;
  }

  /** Change optimistically in meta.get. */
  #meta(fn: MetaPatch) {
    return (store: OptimisticLocalStore) => {
      const meta = store.getQuery(api.meta.get, {});
      if (meta) store.setQuery(api.meta.get, {}, fn(meta as unknown as Meta) as never);
    };
  }

  async #run<T>(what: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      this.app.toasts.error(what, error);
      return null;
    }
  }

  // ---------------------------------------------------------------- Teams

  createTeam(args: { key: string; name: string; hue?: number }) {
    return this.#run(t('Team not created'), () => this.store.call(api.teams.create, args));
  }

  /** Like createTeam, but returns the server's reason instead of showing a toast (for the dialog). */
  async createTeamChecked(args: { key: string; name: string; hue?: number; wiki?: 'on' | 'only' }): Promise<{ teamId: string; key: string } | { error: string }> {
    try {
      return await this.store.call(api.teams.create, args);
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  /** `wiki`: 'on' = wiki, null = none (only without pages). */
  updateTeam(teamId: TeamId, patch: { key?: string; name?: string; hue?: number; dormant?: boolean; wiki?: 'on' | 'only' | null }) {
    const now = Date.now();
    const local = { ...patch, ...(patch.wiki === null ? { wiki: undefined } : {}) };
    return this.#run(
      t('Team not updated'),
      () => this.store.call(api.teams.update, { teamId, ...patch }, this.#meta((m) => ({ ...m, teams: m.teams.map((t) => (t._id === teamId ? ({ ...t, ...local, updatedAt: now } as TeamDoc) : t)) }))),
    );
  }

  /** Move a team one place up/down. */
  moveTeam(teamId: TeamId, delta: -1 | 1) {
    const teams = [...(this.store.meta.get()?.teams ?? [])];
    const i = teams.findIndex((t) => t._id === teamId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= teams.length) return;
    [teams[i], teams[j]] = [teams[j], teams[i]];
    const ids = teams.map((t) => t._id);
    return this.#run(
      t('Order not saved'),
      () => this.store.call(api.teams.reorder, { teamIds: ids }, this.#meta((m) => ({ ...m, teams: ids.map((id, order) => ({ ...m.teams.find((t) => t._id === id)!, order })) }))),
    );
  }

  /**
   * Upload a logo: get an upload URL, upload the file, have it checked and set.
   * Returns null on success, else the reason (shown at the field).
   */
  async uploadLogo(teamId: TeamId, file: File, variant: LogoVariant): Promise<string | null> {
    const pre = precheckLogo(file);
    if (pre) return pre;
    try {
      const url = await this.store.call(api.teams.generateLogoUploadUrl, {});
      const type = file.type || (file.name.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/png');
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': type }, body: file });
      if (!response.ok) return t('Upload failed ({status}).', { status: response.status });
      const { storageId } = (await response.json()) as { storageId: Id<'_storage'> };
      await this.store.act(api.teams.setLogo, { teamId, storageId, variant });
      return null;
    } catch (error) {
      return errorMessage(error);
    }
  }

  // ---------------------------------------------------------------- Time zone

  /** Instance time zone (IANA name); the server checks it and answers with the canonical spelling. */
  setTimeZone(timeZone: string) {
    return this.#run(t('Time zone not saved'), () => this.store.call(api.instance.setTimeZone, { timeZone }, this.#meta((m) => ({ ...m, timeZone }))));
  }

  // ---------------------------------------------------------------- Profile

  /** Display name of the owner; empty or null clears it (the UI then says "You"). */
  setProfileName(name: string | null) {
    const clean = name?.replace(/\s+/g, ' ').trim() || null;
    return this.#run(t('Name not saved'), () => this.store.call(api.profile.setName, { name: clean }, this.#meta((m) => ({ ...m, owner: { name: clean, avatarUrl: m.owner?.avatarUrl ?? null } }))));
  }

  /**
   * Uploads the cropped profile picture: upload URL, POST, files.register (type and size are
   * checked there), then profile.setAvatar. Returns null on success, else the reason.
   */
  async uploadAvatar(picture: Blob): Promise<string | null> {
    if (picture.size === 0) return t('The file is empty.');
    if (picture.size > LIMITS.avatarMaxBytes) return t('The picture is too large (at most {size} KB).', { size: LIMITS.avatarMaxBytes / 1024 });
    try {
      const url = await this.store.call(api.files.generateUploadUrl, {});
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': picture.type }, body: picture });
      if (!response.ok) return t('Upload failed ({status}).', { status: response.status });
      const { storageId } = (await response.json()) as { storageId: Id<'_storage'> };
      const registered = await this.store.act(api.files.register, { storageId });
      const [token] = imageTokens(registered.url);
      if (!token) return t('Upload failed ({status}).', { status: 500 });
      await this.store.call(api.profile.setAvatar, { token });
      return null;
    } catch (error) {
      return errorMessage(error);
    }
  }

  removeAvatar() {
    return this.#run(t('Picture not removed'), () => this.store.call(api.profile.removeAvatar, {}, this.#meta((m) => ({ ...m, owner: { name: m.owner?.name ?? null, avatarUrl: null } }))));
  }

  removeLogo(teamId: TeamId, variant: LogoVariant) {
    const field = variant === 'dark' ? 'logoDarkUrl' : 'logoUrl';
    return this.#run(t('Logo not removed'), () => this.store.call(api.teams.removeLogo, { teamId, variant }, this.#meta((m) => ({ ...m, teams: m.teams.map((t) => (t._id === teamId ? { ...t, [field]: null } : t)) }))));
  }

  // ---------------------------------------------------------------- Statuses per team

  createState(args: { teamId: TeamId; name: string; type: StateType; color?: string }) {
    return this.#run(t('Status not created'), () => this.store.call(api.workflowStates.create, args));
  }

  updateState(stateId: StateId, patch: { name?: string; color?: string | null; description?: string | null }) {
    const now = Date.now();
    return this.#run(
      t('Status not updated'),
      () =>
        this.store.call(
          api.workflowStates.update,
          { stateId, ...patch },
          this.#meta((m) => ({
            ...m,
            workflowStates: m.workflowStates.map((s) => {
              if (s._id !== stateId) return s;
              const next = { ...s, updatedAt: now } as Record<string, unknown>;
              for (const [k, v] of Object.entries(patch)) if (v === null) delete next[k];
              else if (v !== undefined) next[k] = v;
              return next as unknown as StateDoc;
            }),
          })),
        ),
    );
  }

  /** Move a status one place up/down within its type. */
  moveState(stateId: StateId, delta: -1 | 1) {
    const meta = this.store.meta.get();
    const state = meta?.workflowStates.find((s) => s._id === stateId);
    if (!meta || !state) return;
    const peers = meta.workflowStates.filter((s) => s.teamId === state.teamId && s.type === state.type && s.archivedAt === undefined).sort((a, b) => a.position - b.position);
    const i = peers.findIndex((s) => s._id === stateId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= peers.length) return;
    [peers[i], peers[j]] = [peers[j], peers[i]];
    const ids = peers.map((s) => s._id);
    return this.#run(
      t('Order not saved'),
      () =>
        this.store.call(
          api.workflowStates.reorder,
          { teamId: state.teamId, stateIds: ids },
          this.#meta((m) => ({ ...m, workflowStates: m.workflowStates.map((s) => (ids.includes(s._id) ? { ...s, position: ids.indexOf(s._id) } : s)) })),
        ),
    );
  }

  archiveState(stateId: StateId, moveTo?: StateId) {
    return this.#run(t('Status not archived'), () => this.store.call(api.workflowStates.archive, { stateId, ...(moveTo ? { moveTo } : {}) }));
  }

  restoreState(stateId: StateId) {
    return this.#run(t('Status not restored'), () => this.store.call(api.workflowStates.restore, { stateId }));
  }

  /** Default status, fixed order, exceptions (optimistic on the team). */
  setWorkflow(teamId: TeamId, patch: { strict?: boolean; exceptions?: { from: StateId; to: StateId }[]; defaultStateId?: StateId | null }) {
    return this.#run(
      t('Workflow not saved'),
      () =>
        this.store.call(
          api.workflowStates.setWorkflow,
          { teamId, ...patch },
          this.#meta((m) => ({
            ...m,
            teams: m.teams.map((t) => {
              if (t._id !== teamId) return t;
              const workflow = { strict: false, exceptions: [] as { from: StateId; to: StateId }[], ...t.workflow } as NonNullable<TeamDoc['workflow']>;
              if (patch.strict !== undefined) workflow.strict = patch.strict;
              if (patch.exceptions !== undefined) workflow.exceptions = patch.exceptions;
              if (patch.defaultStateId === null) delete workflow.defaultStateId;
              else if (patch.defaultStateId !== undefined) workflow.defaultStateId = patch.defaultStateId;
              return { ...t, workflow } as TeamDoc;
            }),
          })),
        ),
    );
  }

  // ---------------------------------------------------------------- Projects

  createProject(teamId: TeamId, name: string, state: ProjectState = 'active') {
    return this.#run(t('Project not created'), () => this.store.call(api.projects.create, { teamId, name, state }));
  }

  updateProject(projectId: ProjectDoc['_id'], patch: { name?: string; state?: ProjectState }) {
    return this.#run(t('Project not updated'), () => this.store.call(api.projects.update, { projectId, ...patch }, this.#meta((m) => ({ ...m, projects: m.projects.map((p) => (p._id === projectId ? { ...p, ...patch } : p)) }))));
  }

  // ---------------------------------------------------------------- Labels

  createLabel(args: { name: string; hue: number; groupId?: LabelGroupDoc['_id'] }) {
    return this.#run(t('Label not created'), () => this.store.call(api.labels.create, args));
  }

  updateLabel(labelId: LabelDoc['_id'], patch: { name?: string; hue?: number; groupId?: LabelGroupDoc['_id'] | null; archived?: boolean }) {
    return this.#run(
      t('Label not updated'),
      () =>
        this.store.call(
          api.labels.update,
          { labelId, ...patch },
          this.#meta((m) => ({
            ...m,
            labels: m.labels.map((l) => {
              if (l._id !== labelId) return l;
              const next = { ...l, ...patch } as Record<string, unknown>;
              if (patch.groupId === null) delete next.groupId;
              return next as unknown as LabelDoc;
            }),
          })),
        ),
    );
  }

  createGroup(args: { name: string; exclusive: boolean; hue?: number }) {
    return this.#run(t('Group not created'), () => this.store.call(api.labelGroups.create, args));
  }

  updateGroup(groupId: LabelGroupDoc['_id'], patch: { name?: string; exclusive?: boolean; hue?: number }) {
    return this.#run(t('Group not updated'), () => this.store.call(api.labelGroups.update, { groupId, ...patch }, this.#meta((m) => ({ ...m, labelGroups: m.labelGroups.map((g) => (g._id === groupId ? { ...g, ...patch } : g)) }))));
  }

  // ---------------------------------------------------------------- Agents

  /** New key; it appears only in this response. */
  createAgent(name: string) {
    return this.#run(t('Key not created'), () => this.store.act(api.agents.create, { name }));
  }

  revokeAgent(agentId: Id<'agents'>) {
    return this.#run(t('Not revoked'), () => this.store.call(api.agents.revoke, { agentId }));
  }

  /** "Connect connector": accept new connectors (claude.ai, ChatGPT) for 15 minutes. */
  armConnectors(on: boolean) {
    return this.#run(t('Not switched'), () => this.store.call(api.oauth.arm, { on }));
  }

  // ---------------------------------------------------------------- Recurrences

  createRecurrence(args: {
    teamId: TeamId;
    title: string;
    description?: string;
    priority?: 0 | 1 | 2 | 3 | 4;
    labelIds?: LabelDoc['_id'][];
    cadence: 'weekly' | 'monthly';
    weekday?: number;
    monthDay?: number;
  }) {
    return this.#run(t('Recurrence not created'), () => this.store.call(api.recurrences.create, args));
  }

  setRecurrenceActive(recurrenceId: Id<'recurrences'>, active: boolean) {
    return this.#run(active ? t('Not resumed') : t('Not paused'), () =>
      this.store.call(api.recurrences.update, { recurrenceId, active }, (store) => {
        const list = store.getQuery(api.recurrences.list, {});
        if (list) store.setQuery(api.recurrences.list, {}, list.map((r) => (r._id === recurrenceId ? { ...r, active } : r)));
      }),
    );
  }

  removeRecurrence(recurrenceId: Id<'recurrences'>) {
    return this.#run(t('Recurrence not deleted'), () =>
      this.store.call(api.recurrences.remove, { recurrenceId }, (store) => {
        const list = store.getQuery(api.recurrences.list, {});
        if (list) store.setQuery(api.recurrences.list, {}, list.filter((r) => r._id !== recurrenceId));
      }),
    );
  }
}
