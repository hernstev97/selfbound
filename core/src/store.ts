// Data layer "buckets in memory" (backend contract: docs/architecture/backend.md).
//
// - Subscriptions: meta.get (metadata), meta.counter (highest seq → number of buckets),
//   issues.bucket per bucket (64 issues), inbox.list (open inbox entries, merged into their
//   issue as `issue.inbox`), sprints.items for the active sprint, agents.list.
// - All issues live frozen in a Map. Convex resends the whole bucket on every change; unchanged
//   issues keep their old object (compared over ALL fields) and only real changes are reported.
//   Otherwise 64 rows would repaint instead of one.
// - Every change is optimistic: Convex optimistic updates on the affected buckets or the detail
//   subscription; if the server rejects, Convex rolls them back and the value jumps back.
// - New issues only know their seq and bucket after the server responds. Until then they are
//   pending entries (`pending`) in a separate list that `all()` includes.
// - An IndexedDB mirror provides the last state immediately on start.

import type { ConvexClient, OptimisticLocalStore } from 'convex/browser';
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';
import { api } from '@selfbound/backend/api';
import { BUCKET_SIZE, CLOSED_STATUSES, LIMITS, type Status } from '@selfbound/backend/constants';
import { t, tc, tn } from './i18n.ts';
import { Mirror } from './idb.ts';
import { statusOfState, TYPE_OF_STATUS } from '@selfbound/backend/shared/workflow';
import { workflowsOf, type Workflows } from './workflow.ts';
import { DEFAULT_TIME_ZONE, setTimeZone } from './format.ts';
import { haystackOf } from './haystack.ts';
import { unread } from './inbox.ts';
import { Slice } from './observable.ts';
import { OWNER_KIND } from './types.ts';
import type {
  AgentInfo,
  CommentDoc,
  DetailDoc,
  Issue,
  InboxEntry,
  IssueDoc,
  IssueId,
  IssuePatch,
  Meta,
  NewIssue,
  RelationType,
  SprintItemKind,
  SyncState,
  TeamDoc,
} from './types.ts';

type ChangeListener = (ids: ReadonlySet<IssueId>) => void;

/** Derived fields that do not come from the server. */
const DERIVED = new Set(['key', 'pending', 'inbox']);
/** After this long without a connection the app shows "Offline", also during start. */
const OFFLINE_AFTER = 3000;

/** Equality for JSON-like values (numbers, strings, arrays, plain objects). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

/**
 * Did the server document change? Compares ALL fields of both sides generically, so new schema
 * fields are detected without changes here.
 */
export function sameIssue(current: Issue, doc: IssueDoc): boolean {
  const a = current as unknown as Record<string, unknown>;
  const b = doc as unknown as Record<string, unknown>;
  for (const key in b) if (!DERIVED.has(key) && !sameValue(a[key], b[key])) return false;
  for (const key in a) if (!DERIVED.has(key) && !(key in b) && a[key] !== undefined) return false;
  return true;
}

export interface SaveTiming {
  n: number;
  ids: number;
  start: number;
  confirmed?: number;
  painted?: number;
  failed?: boolean;
}

/** Measurement and test hooks (only in development, with ?perf=1 or in a test build). */
export interface DebugHooks {
  saves: SaveTiming[];
  [key: string]: unknown;
}

declare global {
  var __selfbound: DebugHooks | undefined;
}

/** Old key → current key of every renamed team. A key some team holds now is never mapped. */
export function renamedKeys(teams: readonly { key: string; previousKeys?: string[] }[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const team of teams) for (const old of team.previousKeys ?? []) map.set(old, team.key);
  for (const team of teams) map.delete(team.key);
  return map;
}

function omitRead({ readAt: _, ...entry }: InboxEntry): InboxEntry {
  return entry;
}

/** Splits into chunks the server accepts in one call (LIMITS.bulkUpdateMax). */
function chunks<T>(items: T[], size = LIMITS.bulkUpdateMax): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function afterNextPaint(cb: () => void) {
  if (typeof requestAnimationFrame === 'undefined') return void setTimeout(cb, 0);
  requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => cb();
    channel.port2.postMessage(null);
  });
}

interface DetailEntry {
  data: DetailDoc | null | undefined;
  unsub: () => void;
  listeners: Set<() => void>;
  used: number;
}

export interface StoreOptions {
  /** Name of the IndexedDB mirror (per backend address) */
  cacheName: string;
  hooks?: DebugHooks | null;
  /** How many detail subscriptions without listeners stay in memory */
  detailCache?: number;
}

export interface SearchHit {
  id: IssueId;
  identifier: string;
  title: string;
  status: Issue['status'];
  teamId: Issue['teamId'];
  match: 'title' | 'description' | 'comment';
  snippet?: string;
}

let tempSeq = 0;

interface TeamCounts {
  todo: number;
  started: number;
  sprints: Map<string, { issues: number; done: number }>;
}

export class IssueStore {
  readonly issues = new Map<IssueId, Issue>();
  readonly meta = new Slice<Meta | null>(null);
  readonly sync = new Slice<SyncState>({ phase: 'empty', pending: 0, connected: false, offline: false, visible: false, text: '' });
  /** Increases on every real change to the set of issues. */
  readonly version = new Slice(0);
  /** Kind of entries in the active sprint: planned / added later */
  readonly sprintKinds = new Slice<ReadonlyMap<IssueId, SprintItemKind>>(new Map());
  /** Names for the activity feed by actor: agent ID → name, and OWNER_KIND → the owner's display name (once set) */
  readonly agents = new Slice<ReadonlyMap<string, string>>(new Map());
  readonly maxSeq = new Slice(-1);

  #teams = new Map<string, TeamDoc>();
  /** Open inbox entries by issue; an issue picks its entry up when it arrives (#enrich) */
  #entries = new Map<IssueId, InboxEntry>();
  #inboxFromServer = false;
  /** Entries that vanished in this session (removed): when, for closing their notifications */
  #entryGone = new Map<IssueId, number>();
  /** Entries removed by the owner, so "Undo" can show them again before the server answers */
  #removed = new Map<IssueId, InboxEntry>();
  // Sidebar counters, updated on every change instead of counting over all issues
  #inbox = 0;
  #snoozed = 0;
  #triage = new Map<string, number>();
  /** Per team: unstarted, started, and per sprint its issues (without canceled ones) and how many are done */
  #teamCounts = new Map<string, TeamCounts>();
  /** Sub-issues per parent (confirmed issues only; childrenOf adds pending ones) */
  #children = new Map<IssueId, Set<IssueId>>();
  #byKey = new Map<string, IssueId>();
  /** Team keys from before a rename (upper case) → the current key */
  #renamedKeys: ReadonlyMap<string, string> = new Map();
  #bucketIds = new Map<number, Set<IssueId>>();
  #bucketSubs = new Map<number, () => void>();
  #liveBuckets = new Set<number>();
  #changed = new Set<IssueId>();
  #flushScheduled = false;
  #listeners = new Set<ChangeListener>();
  #all: Issue[] | null = null;
  #metaFromServer = false;
  #counterFromServer = false;
  #mirror: Mirror;
  #unsubs: (() => void)[] = [];
  #pendingWrites = 0;
  #pendingSince = 0;
  #syncTimer: ReturnType<typeof setTimeout> | null = null;
  #saveSeq = 0;
  #details = new Map<IssueId, DetailEntry>();
  #detailCache: number;
  #hooks: DebugHooks | null;
  #sprintSub: { sprintId: string; unsub: () => void } | null = null;
  #agentsSub: (() => void) | null = null;
  #agentNames: ReadonlyMap<string, string> = new Map();
  #ownerName: string | null = null;
  #zoneOffered = false;

  /** Pending issues (tmp ID → issue) */
  readonly #pending = new Map<IssueId, Issue>();
  /** Confirmed pending issues: tmp ID → real ID */
  readonly #resolved = new Map<IssueId, IssueId>();
  /** Waiting for the real ID */
  readonly #waiting = new Map<IssueId, Promise<IssueId>>();

  constructor(
    readonly client: ConvexClient,
    options: StoreOptions,
  ) {
    this.#mirror = new Mirror(options.cacheName);
    this.#hooks = options.hooks ?? null;
    this.#detailCache = options.detailCache ?? 16;
  }

  async start() {
    if (typeof performance !== 'undefined') performance.mark('selfbound-boot');
    this.#unsubs.push(
      this.client.onUpdate(api.meta.get, {}, (meta) => {
        if (meta) this.#applyMeta(meta as Meta, true);
      }),
      this.client.onUpdate(api.meta.counter, {}, (counter) => {
        if (counter) this.#applyCounter(counter.maxSeq, true);
      }),
      this.client.onUpdate(api.inbox.list, {}, (list) => {
        if (list) this.#applyInbox(list as InboxEntry[], true);
      }),
      // Newest bucket right with the first response (instead of after meta.counter): the list is
      // ready one round trip earlier. Only once; the bucket subscriptions take over afterwards.
      this.#watchHead(),
      this.client.subscribeToConnectionState((state) => this.#onConnection(state.isWebSocketConnected, state.connectionRetries)),
    );
    // The subscription reports changes only: read the initial state (the client connects before start).
    const state = this.client.connectionState();
    this.#onConnection(state.isWebSocketConnected, state.connectionRetries);
    const snapshot = await this.#mirror.read();
    if (!snapshot) return;
    if (snapshot.meta && !this.#metaFromServer) this.#applyMeta(snapshot.meta as Meta, false);
    if (snapshot.maxSeq !== null && !this.#counterFromServer) this.#applyCounter(snapshot.maxSeq, false);
    if (snapshot.inbox && !this.#inboxFromServer) this.#applyInbox(snapshot.inbox as InboxEntry[], false);
    for (const [bucket, docs] of Object.entries(snapshot.buckets)) {
      const b = Number(bucket);
      // Only buckets the server has not sent anything for yet.
      if (!this.#liveBuckets.has(b)) this.#ingest(b, docs as IssueDoc[], false);
    }
    if (this.sync.get().phase === 'empty' && this.issues.size > 0) {
      this.#updateSync({ phase: 'cache' });
      if (typeof performance !== 'undefined') performance.mark('selfbound-cache');
    }
  }

  stop() {
    for (const unsub of this.#unsubs) unsub();
    for (const unsub of this.#bucketSubs.values()) unsub();
    for (const entry of this.#details.values()) entry.unsub();
    this.#sprintSub?.unsub();
    this.#agentsSub?.();
    this.#unsubs = [];
    this.#bucketSubs.clear();
    this.#details.clear();
    if (this.#offlineTimer) clearTimeout(this.#offlineTimer);
    this.#offlineTimer = null;
    void this.#mirror.flush();
  }

  // ---------------------------------------------------------------- Reading

  /** All issues (including deleted and pending ones) as an array, rebuilt only after a change. */
  all(): Issue[] {
    if (!this.#all) {
      const out = [...this.issues.values()];
      for (const p of this.#pending.values()) out.push(p);
      this.#all = out;
    }
    return this.#all;
  }

  get(id: IssueId): Issue | undefined {
    return this.issues.get(id) ?? this.#pending.get(id) ?? (this.#resolved.has(id) ? this.issues.get(this.#resolved.get(id)!) : undefined);
  }

  /** Search text of an issue (for measurement hooks and tests). */
  haystack(id: IssueId): string | undefined {
    const issue = this.get(id);
    return issue ? haystackOf(issue) : undefined;
  }

  /** Issue by ID ("KIU-106", case-insensitive), also with a key the team had before a rename. */
  byKey(key: string): Issue | undefined {
    let id = this.#byKey.get(key.toLowerCase());
    if (!id && this.#renamedKeys.size) {
      const m = /^([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,6})$/.exec(key.trim());
      const current = m && this.#renamedKeys.get(m[1]!.toUpperCase());
      if (current) id = this.#byKey.get(`${current}-${Number(m[2])}`.toLowerCase());
    }
    return id ? this.issues.get(id) : undefined;
  }

  /** Team keys from before a rename → current key (for old links, bookmarks and saved views). */
  renamedKeys(): ReadonlyMap<string, string> {
    return this.#renamedKeys;
  }

  /** The current key for a key from before a rename; any other key unchanged. */
  currentTeamKey(key: string): string {
    return this.#renamedKeys.get(key.toUpperCase()) ?? key;
  }

  team(teamId: string): TeamDoc | undefined {
    return this.#teams.get(teamId);
  }

  teamKey(teamId: string) {
    return this.#teams.get(teamId)?.key ?? '???';
  }

  /** Real ID of a pending issue, once known. */
  resolvedId(id: IssueId): IssueId {
    return this.#resolved.get(id) ?? id;
  }

  isPending(id: IssueId) {
    return this.#pending.has(id);
  }

  /** Unread inbox entries, triage issues (per team) and snoozed issues (without deleted and pending ones). */
  counts(): { inbox: number; triage: number; triageByTeam: ReadonlyMap<string, number>; snoozed: number } {
    let triage = 0;
    for (const n of this.#triage.values()) triage += n;
    return { inbox: this.#inbox, triage, triageByTeam: this.#triage, snoozed: this.#snoozed };
  }

  /** A team's numbers for its sidebar card; `sprint` is the active sprint. */
  teamCounts(teamId: string, sprint: string | null): { todo: number; started: number; sprintIssues: number; sprintDone: number } {
    const c = this.#teamCounts.get(teamId);
    const s = sprint ? c?.sprints.get(sprint) : undefined;
    return { todo: c?.todo ?? 0, started: c?.started ?? 0, sprintIssues: s?.issues ?? 0, sprintDone: s?.done ?? 0 };
  }

  /** Sub-issues of an issue (including deleted and pending ones), without scanning all issues. */
  childrenOf(id: IssueId): Issue[] {
    const out: Issue[] = [];
    for (const child of this.#children.get(id) ?? []) {
      const issue = this.issues.get(child);
      if (issue) out.push(issue);
    }
    for (const p of this.#pending.values()) if (p.parentId === id) out.push(p);
    return out;
  }

  #count(issue: Issue | undefined, sign: 1 | -1) {
    if (issue?.parentId) {
      let set = this.#children.get(issue.parentId);
      if (sign > 0) {
        if (!set) this.#children.set(issue.parentId, (set = new Set()));
        set.add(issue._id);
      } else if (set) {
        set.delete(issue._id);
        if (set.size === 0) this.#children.delete(issue.parentId);
      }
    }
    if (!issue || issue.deletedAt !== undefined) return;
    if (unread(issue)) this.#inbox += sign;
    // Snoozed issues are hidden from the lists, so they stay out of the counts too.
    const snoozed = issue.snoozedUntil !== undefined;
    if (snoozed) this.#snoozed += sign;
    if (issue.status === 'triage' && !snoozed) {
      const next = (this.#triage.get(issue.teamId) ?? 0) + sign;
      if (next) this.#triage.set(issue.teamId, next);
      else this.#triage.delete(issue.teamId);
    }
    // By status type, not by name: every team has its own statuses.
    const type = TYPE_OF_STATUS[issue.status];
    let team = this.#teamCounts.get(issue.teamId);
    if (!team) this.#teamCounts.set(issue.teamId, (team = { todo: 0, started: 0, sprints: new Map() }));
    if (!snoozed && type === 'unstarted') team.todo += sign;
    else if (!snoozed && type === 'started') team.started += sign;
    if (issue.sprintId && type !== 'canceled') {
      let s = team.sprints.get(issue.sprintId);
      if (!s) team.sprints.set(issue.sprintId, (s = { issues: 0, done: 0 }));
      s.issues += sign;
      if (type === 'completed') s.done += sign;
      if (s.issues === 0) team.sprints.delete(issue.sprintId);
    }
  }

  onChange(listener: ChangeListener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // ---------------------------------------------------------------- Subscriptions

  #applyMeta(meta: Meta, fromServer: boolean) {
    if (fromServer) this.#metaFromServer = true;
    const teamsChanged = meta.teams.length !== this.#teams.size || meta.teams.some((t) => this.#teams.get(t._id)?.key !== t.key);
    this.#teams = new Map(meta.teams.map((t) => [t._id, t]));
    this.#renamedKeys = renamedKeys(meta.teams);
    if (teamsChanged) {
      // IDs depend on the team key: re-derive all issues.
      this.#byKey.clear();
      for (const [id, issue] of this.issues) {
        const next = this.#enrich(issue);
        this.issues.set(id, next);
        this.#byKey.set(next.key.toLowerCase(), id);
        this.#changed.add(id);
      }
      this.#scheduleFlush();
    }
    this.meta.set(meta);
    // Not saved yet (null): the server counts in its default zone. A cache from before the setting existed (missing): the device's.
    const zoneChanged = setTimeZone(meta.timeZone === undefined ? null : (meta.timeZone ?? DEFAULT_TIME_ZONE));
    if (zoneChanged && !teamsChanged && this.issues.size > 0) {
      // Labels like "Today" and the overdue marker depend on the day: rebuild them.
      for (const id of this.issues.keys()) this.#changed.add(id);
      this.#scheduleFlush();
    }
    // First sign-in: the browser's zone becomes the instance's. `ifUnset` keeps a stale cache or a
    // second device from overwriting a zone the owner has chosen. One attempt per session.
    if (fromServer && meta.timeZone === null && !meta.rejectWrites && !this.#zoneOffered) {
      this.#zoneOffered = true;
      const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (browserZone) void this.client.mutation(api.instance.setTimeZone, { timeZone: browserZone, ifUnset: true }).catch(() => {});
    }
    if ((meta.owner?.name ?? null) !== this.#ownerName) {
      this.#ownerName = meta.owner?.name ?? null;
      this.#publishNames();
    }
    if (fromServer) {
      this.#mirror.setMeta(meta);
      this.#watchSprint(meta);
    }
    this.#checkLive();
  }

  #applyCounter(maxSeq: number, fromServer: boolean) {
    if (fromServer) this.#counterFromServer = true;
    this.maxSeq.set(maxSeq);
    if (fromServer) this.#mirror.setMaxSeq(maxSeq);
    const wanted = maxSeq < 0 ? 0 : Math.floor(maxSeq / BUCKET_SIZE) + 1;
    // Newest buckets first: most views show new or recently changed issues at the top, so the
    // server's first response already fills the visible area and later buckets append below
    // instead of reshuffling the list from the top.
    for (let bucket = wanted - 1; bucket >= 0; bucket--) {
      if (this.#bucketSubs.has(bucket)) continue;
      this.#bucketSubs.set(bucket, this.#watchBucket(bucket));
    }
    if (fromServer && this.sync.get().phase === 'empty') this.#updateSync({ phase: 'syncing' });
    this.#checkLive();
  }

  /**
   * Subscribes to a bucket. If the query fails (say at the server's 1 s limit, when over a hundred
   * buckets run at once on start and the machine is busy), the result stays an error until
   * resubscribed: the bucket would never arrive and "Syncing" would stay forever. Hence resubscribe
   * after a short, growing pause.
   */
  #watchBucket(bucket: number): () => void {
    let unsub: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    const subscribe = () => {
      timer = null;
      let failed = false;
      const handle = this.client.onUpdate(
        api.issues.bucket,
        { bucket },
        (docs) => {
          failures = 0;
          this.#ingest(bucket, docs as IssueDoc[], true);
        },
        () => {
          failed = true;
          unsub?.();
          unsub = null;
          timer = setTimeout(subscribe, Math.min(5000, 250 * 2 ** failures++) * (0.5 + Math.random()));
        },
      );
      // The error can arrive during onUpdate already; then unsubscribe right away.
      if (failed) handle();
      else unsub = handle;
    };
    subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      timer = null;
      unsub?.();
      unsub = null;
    };
  }

  #watchHead(): () => void {
    let unsub: (() => void) | null = null;
    let done = false;
    unsub = this.client.onUpdate(api.issues.head, {}, (head) => {
      if (done || !head) return;
      done = true;
      if (!this.#counterFromServer) this.#applyCounter(head.maxSeq, true);
      for (const { bucket, docs } of head.buckets) if (!this.#liveBuckets.has(bucket)) this.#ingest(bucket, docs as IssueDoc[], false);
      queueMicrotask(() => unsub?.());
    });
    return () => unsub?.();
  }

  #watchSprint(meta: Meta) {
    const active = meta.sprints.find((s) => s.state === 'active');
    if (this.#sprintSub?.sprintId === active?._id) return;
    this.#sprintSub?.unsub();
    this.#sprintSub = null;
    if (!active) {
      this.#setSprintKinds(new Map());
      return;
    }
    const unsub = this.client.onUpdate(api.sprints.items, { sprintId: active._id }, (items) => {
      const next = new Map<IssueId, SprintItemKind>();
      for (const item of items ?? []) if (item.removedAt === null) next.set(item.issueId, item.kind);
      this.#setSprintKinds(next);
    });
    this.#sprintSub = { sprintId: active._id, unsub };
  }

  #setSprintKinds(next: Map<IssueId, SprintItemKind>) {
    const prev = this.sprintKinds.get();
    for (const [id, kind] of next) if (prev.get(id) !== kind) this.#changed.add(id);
    for (const id of prev.keys()) if (!next.has(id)) this.#changed.add(id);
    this.sprintKinds.set(next);
    this.#scheduleFlush();
  }

  /** Agent names for the activity feed (subscribed on demand). */
  watchAgents() {
    if (this.#agentsSub) return;
    this.#agentsSub = this.client.onUpdate(api.agents.list, {}, (list) => {
      this.#agentNames = new Map((list as AgentInfo[] | undefined)?.map((a) => [a._id, a.name]) ?? []);
      this.#publishNames();
    });
  }

  #publishNames() {
    this.agents.set(this.#ownerName ? new Map([...this.#agentNames, [OWNER_KIND, this.#ownerName]]) : this.#agentNames);
  }

  #enrich(doc: IssueDoc, pending = false): Issue {
    // Number 0: not known yet (created as pending or just moved to another team).
    const key = pending || doc.number <= 0 ? `${this.teamKey(doc.teamId)}-…` : `${this.teamKey(doc.teamId)}-${doc.number}`;
    // The document from the server (or the mirror) becomes the issue itself: only `key` is added.
    // No second copy of all 10,000 issues in memory (Convex holds the documents anyway).
    // Already frozen objects (re-derived after a team key change) are copied.
    const issue = (Object.isFrozen(doc) ? { ...doc } : doc) as Issue & { key: string };
    issue.key = key;
    if (pending) issue.pending = true;
    const entry = this.#entries.get(doc._id);
    if (entry) issue.inbox = entry;
    else if ('inbox' in issue) delete issue.inbox; // a copy of an issue that had one
    return Object.freeze(issue);
  }

  /** Has the inbox list arrived (from the server or the cache)? Before that, "no entry" means nothing. */
  inboxLoaded() {
    return this.#inboxFromServer || this.#entries.size > 0;
  }

  /** When the entry of an issue vanished in this session (removed), if it did. */
  entryGoneAt(id: IssueId): number | undefined {
    return this.#entryGone.get(id);
  }

  /**
   * The open inbox entries arrived. An issue whose entry is new, gone or different is replaced by a
   * copy with the new `inbox`, so views and counters follow through the normal change path.
   */
  #applyInbox(list: InboxEntry[], fromServer: boolean) {
    if (fromServer) {
      this.#inboxFromServer = true;
      this.#mirror.setInbox(list);
    }
    const next = new Map<IssueId, InboxEntry>();
    for (const entry of list) next.set(entry.issueId, entry);
    const now = Date.now();
    const touched = new Set<IssueId>();
    for (const [id, entry] of this.#entries) {
      if (!next.has(id)) {
        touched.add(id);
        if (fromServer) this.#entryGone.set(id, now);
        this.#removed.set(id, entry);
      }
    }
    for (const [id, entry] of next) {
      if (!sameValue(this.#entries.get(id), entry)) touched.add(id);
      this.#entryGone.delete(id);
      this.#removed.delete(id);
    }
    this.#entries = next;
    for (const id of touched) {
      const current = this.issues.get(id);
      if (!current) continue;
      const issue = this.#enrich(current);
      this.#count(current, -1);
      this.#count(issue, 1);
      this.issues.set(id, issue);
      this.#changed.add(id);
    }
    this.#scheduleFlush();
  }

  #ingest(bucket: number, docs: IssueDoc[], fromServer: boolean) {
    const previous = this.#bucketIds.get(bucket);
    const next = new Set<IssueId>();
    for (const doc of docs) {
      next.add(doc._id);
      const current = this.issues.get(doc._id);
      if (current && sameIssue(current, doc)) continue;
      const issue = this.#enrich(doc);
      if (current && current.key !== issue.key) this.#byKey.delete(current.key.toLowerCase());
      this.#count(current, -1);
      this.#count(issue, 1);
      this.issues.set(doc._id, issue);
      this.#byKey.set(issue.key.toLowerCase(), doc._id);
      this.#changed.add(doc._id);
    }
    if (previous) {
      for (const id of previous) {
        if (!next.has(id)) {
          const gone = this.issues.get(id);
          if (gone) this.#byKey.delete(gone.key.toLowerCase());
          this.#count(gone, -1);
          this.issues.delete(id);
          this.#changed.add(id);
        }
      }
    }
    this.#bucketIds.set(bucket, next);
    // Pending issues disappear exactly when the real one is there (no duplicate, no gap).
    for (const [tmp, real] of this.#resolved) {
      if (this.#pending.has(tmp) && this.issues.has(real)) {
        this.#pending.delete(tmp);
        this.#changed.add(tmp);
        this.#changed.add(real);
      }
    }
    if (fromServer) {
      this.#liveBuckets.add(bucket);
      this.#mirror.setBucket(bucket, docs);
      this.#checkLive();
    }
    this.#scheduleFlush();
  }

  #checkLive() {
    if (!this.#metaFromServer || !this.#counterFromServer || this.sync.get().phase === 'live') return;
    const maxSeq = this.maxSeq.get();
    const wanted = maxSeq < 0 ? 0 : Math.floor(maxSeq / BUCKET_SIZE) + 1;
    let live = 0;
    for (let b = 0; b < wanted; b++) if (this.#liveBuckets.has(b)) live++;
    if (live >= wanted) {
      this.#updateSync({ phase: 'live' });
      if (typeof performance !== 'undefined') performance.mark('selfbound-synced');
    }
  }

  // All bucket responses of one Convex transition arrive in the same task.
  // A microtask batches them so lists are recomputed only once.
  #scheduleFlush() {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    queueMicrotask(() => {
      this.#flushScheduled = false;
      if (this.#changed.size === 0) return;
      const changed = this.#changed;
      this.#changed = new Set();
      this.#all = null;
      this.version.set(this.version.get() + 1);
      for (const listener of this.#listeners) listener(changed);
    });
  }

  // ---------------------------------------------------------------- Sync indicator

  #offlineTimer: ReturnType<typeof setTimeout> | null = null;
  #offlineLong = false;
  /** Failed connection attempts: without them the network is only slow, not gone. */
  #retries = 0;

  /** Connection up or down. Without a connection the state is "offline" after OFFLINE_AFTER, also before the first response (start without network). */
  #onConnection(connected: boolean, retries = 0) {
    this.#retries = retries;
    if (connected) {
      if (this.#offlineTimer) clearTimeout(this.#offlineTimer);
      this.#offlineTimer = null;
      this.#offlineLong = false;
    } else if (!this.#offlineTimer && !this.#offlineLong) {
      this.#offlineTimer = setTimeout(() => {
        this.#offlineTimer = null;
        this.#offlineLong = true;
        this.#updateSync({});
      }, OFFLINE_AFTER);
    }
    this.#updateSync({ connected });
  }

  #updateSync(patch: Partial<SyncState>) {
    const next = { ...this.sync.get(), ...patch, pending: this.#pendingWrites };
    // Visible when writes are stalled (> 1 s pending) once there is data, and without a connection:
    // immediately while running, after OFFLINE_AFTER during start (cache or nothing at all yet).
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const stalled = this.#pendingWrites > 0 && now - this.#pendingSince > 1000;
    next.offline = !next.connected && (next.phase === 'live' || (this.#offlineLong && this.#retries > 0));
    next.visible = (next.phase !== 'empty' && stalled) || next.offline;
    next.text = next.connected ? t('Syncing ({count})', { count: next.pending }) : next.pending > 0 ? tn(next.pending, 'Offline · {count} pending', 'Offline · {count} pending') : tc('sync state', 'Offline');
    const prev = this.sync.get();
    if (prev.phase === next.phase && prev.pending === next.pending && prev.connected === next.connected && prev.offline === next.offline && prev.visible === next.visible) return;
    this.sync.set(next);
  }

  #trackPending(delta: number) {
    if (this.#pendingWrites === 0 && delta > 0) this.#pendingSince = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.#pendingWrites += delta;
    this.#updateSync({});
    if (this.#pendingWrites > 0 && !this.#syncTimer) {
      this.#syncTimer = setTimeout(() => {
        this.#syncTimer = null;
        this.#updateSync({});
      }, 1100);
    }
  }

  #writeGate: Promise<void> | null = null;

  /**
   * Sends changes only after this promise; if it rejects, they fail with its error before anything
   * is shown or sent. For the start from the cache (App.#gateWrites).
   */
  setWriteGate(gate: Promise<void> | null) {
    this.#writeGate = gate;
  }

  async #save<T>(ids: number, run: () => Promise<T>): Promise<T> {
    const timing: SaveTiming = { n: ++this.#saveSeq, ids, start: typeof performance !== 'undefined' ? performance.now() : 0 };
    this.#hooks?.saves.push(timing);
    this.#trackPending(1);
    try {
      if (this.#writeGate) await this.#writeGate;
      const result = await run();
      timing.confirmed = performance.now();
      if (this.#hooks) afterNextPaint(() => (timing.painted = performance.now()));
      return result;
    } catch (error) {
      timing.failed = true;
      throw error;
    } finally {
      this.#trackPending(-1);
    }
  }

  // ---------------------------------------------------------------- Optimistic changes

  /** Optimistic update on the buckets of the affected issues. `fn` returns the new document. */
  #optimisticBuckets(ids: Iterable<IssueId>, fn: (doc: IssueDoc) => IssueDoc) {
    const buckets = new Map<number, Set<IssueId>>();
    for (const id of ids) {
      const issue = this.issues.get(id);
      if (!issue) continue;
      let set = buckets.get(issue.bucket);
      if (!set) buckets.set(issue.bucket, (set = new Set()));
      set.add(id);
    }
    return (store: OptimisticLocalStore) => {
      for (const [bucket, set] of buckets) {
        const current = store.getQuery(api.issues.bucket, { bucket });
        if (!current) continue;
        store.setQuery(
          api.issues.bucket,
          { bucket },
          current.map((doc) => (set.has(doc._id) ? fn(doc) : doc)),
        );
      }
    };
  }

  /** Changes a pending issue locally (the server does not know it yet). */
  #patchPending(id: IssueId, fn: (doc: IssueDoc) => IssueDoc) {
    const current = this.#pending.get(id);
    if (!current) return;
    this.#pending.set(id, this.#enrich(fn(current), true));
    this.#changed.add(id);
    this.#scheduleFlush();
  }

  /** Splits IDs into confirmed and pending ones; pending ones follow after confirmation. */
  #split(ids: IssueId[]) {
    const real: IssueId[] = [];
    const later: Promise<IssueId>[] = [];
    for (const id of ids) {
      const resolved = this.#resolved.get(id);
      if (resolved && this.issues.has(resolved)) real.push(resolved);
      else if (this.#pending.has(id) || this.#waiting.has(id)) later.push(this.#waiting.get(id) ?? Promise.reject(new Error('unknown')));
      else real.push(id);
    }
    return { real, later };
  }

  /** Same patch for several issues, optionally with compare-and-set per issue. */
  async update(ids: IssueId[], patch: IssuePatch, expect?: IssuePatch[]) {
    const { real, later } = this.#split(ids);
    const now = Date.now();
    const workflows = workflowsOf(this.meta.get());
    const apply = (doc: IssueDoc) => applyPatch(doc, patch, now, workflows);
    for (const id of ids) if (this.#pending.has(id)) this.#patchPending(id, apply);
    const run = (targets: IssueId[], exp?: IssuePatch[]) =>
      this.#save(targets.length, () =>
        this.client.mutation(api.issues.update, { ids: targets, patch, ...(exp ? { expect: exp } : {}) }, { optimisticUpdate: this.#optimisticBuckets(targets, apply) }),
      );
    const results = [];
    if (real.length) results.push(run(real, expect && later.length === 0 ? expect : undefined));
    if (later.length) results.push(Promise.all(later).then((resolved) => run(resolved)));
    return (await Promise.all(results))[0];
  }

  /** Status of a pending issue: the chosen status, else the status type or the team's default. */
  #newState(item: NewIssue): { status: IssueDoc['status']; stateId?: IssueDoc['stateId'] } {
    const workflows = workflowsOf(this.meta.get());
    const chosen = item.stateId ? workflows.byId.get(item.stateId) : undefined;
    if (chosen) return { status: statusOfState(chosen), stateId: chosen._id };
    const state = workflows.forStatus(item.teamId, item.status ?? 'backlog');
    return { status: item.status ?? 'backlog', ...(state ? { stateId: state._id } : {}) };
  }

  /** One patch per issue, only if `expect` still holds (undo/redo). */
  revert(items: { id: IssueId; patch: IssuePatch; expect: IssuePatch }[]) {
    const now = Date.now();
    const byId = new Map(items.map((item) => [this.resolvedId(item.id), item.patch]));
    const resolved = items.map((item) => ({ ...item, id: this.resolvedId(item.id) }));
    return this.#save(items.length, () =>
      this.client.mutation(api.issues.revert, { items: resolved }, { optimisticUpdate: this.#optimisticBuckets(byId.keys(), (doc) => applyPatch(doc, byId.get(doc._id)!, now, workflowsOf(this.meta.get()))) }),
    );
  }

  /**
   * Creates issues. Visible immediately as pending entries ("saving").
   * `done` returns the real IDs once the server has confirmed AND the bucket has arrived.
   */
  create(items: NewIssue[]): { temps: IssueId[]; done: Promise<IssueId[]> } {
    const now = Date.now();
    const temps: IssueId[] = [];
    for (const item of items) {
      const n = ++tempSeq;
      const id = `tmp:${n}` as IssueId;
      const newState = this.#newState(item);
      const doc = {
        _id: id,
        _creationTime: now,
        seq: Number.MAX_SAFE_INTEGER - 1000 + n,
        bucket: -1,
        teamId: item.teamId,
        number: 0,
        title: item.title,
        ...newState,
        priority: CLOSED_STATUSES.includes(newState.status) ? 0 : (item.priority ?? 0),
        labelIds: item.labelIds ?? [],
        rank: `~${String(n).padStart(6, '0')}`,
        createdBy: { kind: OWNER_KIND },
        createdAt: now,
        updatedAt: now,
        ...(item.projectId ? { projectId: item.projectId } : {}),
        ...(item.estimate !== undefined ? { estimate: item.estimate } : {}),
        ...(item.dueDate ? { dueDate: item.dueDate } : {}),
        ...(item.parentId ? { parentId: item.parentId } : {}),
        ...(item.sprintId ? { sprintId: item.sprintId } : {}),
        ...(item.model ? { model: item.model } : {}),
      } as IssueDoc;
      this.#pending.set(id, this.#enrich(doc, true));
      this.#changed.add(id);
      temps.push(id);
    }
    this.#scheduleFlush();
    const done = this.#save(items.length, () => this.client.mutation(api.issues.create, { issues: items })).then(
      (result) => {
        result.issues.forEach((created, i) => this.#resolved.set(temps[i], created.id));
        // Bucket already there? Then swap right away, otherwise on the next bucket update.
        for (const tmp of temps) {
          const real = this.#resolved.get(tmp)!;
          if (this.issues.has(real) && this.#pending.delete(tmp)) {
            this.#changed.add(tmp);
            this.#changed.add(real);
          }
        }
        this.#scheduleFlush();
        return Promise.all(result.issues.map((created) => this.#arrival(created.id))).then(() => result.issues.map((c) => c.id));
      },
      (error) => {
        for (const tmp of temps) {
          this.#pending.delete(tmp);
          this.#changed.add(tmp);
        }
        this.#scheduleFlush();
        throw error;
      },
    );
    for (const [i, tmp] of temps.entries()) {
      const waiting = done.then((ids) => ids[i]);
      waiting.catch(() => {});
      this.#waiting.set(tmp, waiting);
    }
    return { temps, done };
  }

  /** Waits until an issue is in memory (after creating, the bucket arrives shortly after). */
  #arrival(id: IssueId): Promise<void> {
    if (this.issues.has(id)) return Promise.resolve();
    return new Promise((resolve) => {
      const stop = this.onChange(() => {
        if (this.issues.has(id)) {
          stop();
          resolve();
        }
      });
      // Safety stop: give up waiting after 10 s (the server has confirmed).
      setTimeout(() => {
        stop();
        resolve();
      }, 10_000);
    });
  }

  async #resolveAll(ids: IssueId[]): Promise<IssueId[]> {
    const { real, later } = this.#split(ids);
    return later.length ? [...real, ...(await Promise.all(later))] : real;
  }

  async remove(ids: IssueId[]) {
    const now = Date.now();
    for (const id of ids) if (this.#pending.has(id)) this.#patchPending(id, (doc) => ({ ...doc, deletedAt: now }));
    const targets = await this.#resolveAll(ids);
    return this.#save(targets.length, () =>
      this.client.mutation(api.issues.remove, { ids: targets }, { optimisticUpdate: this.#optimisticBuckets(targets, (doc) => ({ ...doc, deletedAt: now, updatedAt: now })) }),
    );
  }

  async restore(ids: IssueId[]) {
    const targets = await this.#resolveAll(ids);
    const now = Date.now();
    return this.#save(targets.length, () =>
      this.client.mutation(
        api.issues.restore,
        { ids: targets },
        {
          optimisticUpdate: this.#optimisticBuckets(targets, (doc) => {
            const { deletedAt: _, ...rest } = doc;
            return { ...rest, updatedAt: now } as IssueDoc;
          }),
        },
      ),
    );
  }

  /** Optimistic update of the open entries (`inbox.list`) in the Convex client. */
  #optimisticInbox(fn: (list: InboxEntry[]) => InboxEntry[]) {
    return (store: OptimisticLocalStore) => {
      const current = store.getQuery(api.inbox.list, {});
      if (current) store.setQuery(api.inbox.list, {}, fn(current as InboxEntry[]));
    };
  }

  /**
   * Removes inbox entries, at most 500 per call (server limit). Only the entry changes, never the
   * issue, so there is nothing to patch in the buckets.
   */
  async markReviewed(ids: IssueId[]) {
    const targets = (await this.#resolveAll(ids)).filter((id) => this.#entries.has(id));
    for (const id of targets) this.#removed.set(id, this.#entries.get(id)!);
    let reviewed = 0;
    for (const chunk of chunks(targets)) {
      const set = new Set(chunk);
      const result = await this.#save(chunk.length, () =>
        this.client.mutation(api.issues.markReviewed, { ids: chunk }, { optimisticUpdate: this.#optimisticInbox((list) => list.filter((e) => !set.has(e.issueId))) }),
      );
      reviewed += result.reviewed;
    }
    return { reviewed };
  }

  /** Undo of "remove from inbox": the entries are back. */
  async markUnreviewed(ids: IssueId[]) {
    const targets = (await this.#resolveAll(ids)).filter((id) => !this.#entries.has(id));
    let unreviewed = 0;
    for (const chunk of chunks(targets)) {
      const back = chunk.flatMap((id) => this.#removed.get(id) ?? []);
      const result = await this.#save(chunk.length, () =>
        this.client.mutation(api.issues.markUnreviewed, { ids: chunk }, { optimisticUpdate: this.#optimisticInbox((list) => [...back, ...list].sort((a, b) => b.updatedAt - a.updatedAt)) }),
      );
      unreviewed += result.unreviewed;
    }
    return { unreviewed };
  }

  /** Marks inbox entries read or unread again. */
  async markRead(ids: IssueId[], read: boolean) {
    const targets = (await this.#resolveAll(ids)).filter((id) => {
      const entry = this.#entries.get(id);
      return entry !== undefined && (entry.readAt !== undefined) !== read;
    });
    const now = Date.now();
    let changed = 0;
    for (const chunk of chunks(targets)) {
      const set = new Set(chunk);
      const result = await this.#save(chunk.length, () =>
        this.client.mutation(api.issues.markRead, { ids: chunk, read }, { optimisticUpdate: this.#optimisticInbox((list) => list.map((e) => (set.has(e.issueId) ? { ...omitRead(e), ...(read ? { readAt: now } : {}) } : e))) }),
      );
      changed += result.changed;
    }
    return { changed };
  }

  /**
   * New order: afterwards before, issue, after holds. Optimistic with a rank between the
   * neighbours (the server assigns the final one).
   */
  async reorder(id: IssueId, beforeId?: IssueId, afterId?: IssueId) {
    const target = this.resolvedId(id);
    const lo = beforeId ? this.issues.get(beforeId)?.rank : undefined;
    const hi = afterId ? this.issues.get(afterId)?.rank : undefined;
    const rank = rankBetweenLocal(lo, hi);
    return this.#save(1, () =>
      this.client.mutation(
        api.issues.reorder,
        { id: target, ...(beforeId ? { beforeId } : {}), ...(afterId ? { afterId } : {}) },
        { optimisticUpdate: this.#optimisticBuckets([target], (doc) => ({ ...doc, rank })) },
      ),
    );
  }

  /** Moves to another team; the server assigns the new number (until then "KIU-…"). */
  async moveTeam(ids: IssueId[], teamId: IssueDoc['teamId']) {
    const targets = await this.#resolveAll(ids);
    const now = Date.now();
    return this.#save(targets.length, () =>
      this.client.mutation(api.issues.moveTeam, { ids: targets, teamId }, { optimisticUpdate: this.#optimisticBuckets(targets, (doc) => (doc.teamId === teamId ? doc : { ...doc, teamId, number: 0, updatedAt: now })) }),
    );
  }

  addRelation(fromId: IssueId, toId: IssueId, type: RelationType, markDuplicate = false) {
    const now = Date.now();
    const other = this.issues.get(toId);
    return this.#save(1, () =>
      this.client.mutation(
        api.relations.add,
        { fromId, toId, type, ...(markDuplicate ? { markDuplicate } : {}) },
        {
          optimisticUpdate: (store) => {
            const detail = store.getQuery(api.issues.detail, { id: fromId });
            if (detail && other) {
              store.setQuery(api.issues.detail, { id: fromId }, {
                ...detail,
                relations: [
                  ...detail.relations,
                  { id: `pending-rel` as never, type, direction: 'out' as const, createdAt: now, other: { id: other._id, identifier: other.key, title: other.title, status: other.status, teamId: other.teamId, deleted: false } },
                ],
              });
            }
            if (markDuplicate) this.#optimisticBuckets([fromId], (doc) => applyPatch(doc, { status: 'duplicate' }, now, workflowsOf(this.meta.get())))(store);
          },
        },
      ),
    );
  }

  removeRelation(issueId: IssueId, relationId: string) {
    return this.#save(1, () =>
      this.client.mutation(
        api.relations.remove,
        { relationId: relationId as never },
        {
          optimisticUpdate: (store) => {
            const detail = store.getQuery(api.issues.detail, { id: issueId });
            if (detail) store.setQuery(api.issues.detail, { id: issueId }, { ...detail, relations: detail.relations.filter((r) => r.id !== relationId) });
          },
        },
      ),
    );
  }

  // ---------------------------------------------------------------- Description, comments

  /** New description based on `baseVersion`; if the server differs → ConvexError `conflict`. */
  setDescription(id: IssueId, markdown: string, baseVersion: number) {
    const target = this.resolvedId(id);
    const now = Date.now();
    return this.#save(1, () =>
      this.client.mutation(
        api.issues.setDescription,
        { id: target, markdown, baseVersion },
        {
          optimisticUpdate: (store) => {
            const detail = store.getQuery(api.issues.detail, { id: target });
            if (detail && detail.body.version === baseVersion) {
              store.setQuery(api.issues.detail, { id: target }, { ...detail, body: { ...detail.body, markdown, version: baseVersion + 1, updatedAt: now, updatedBy: { kind: OWNER_KIND } } });
            }
          },
        },
      ),
    );
  }

  addComment(issueId: IssueId, body: string) {
    const target = this.resolvedId(issueId);
    const now = Date.now();
    return this.#save(1, () =>
      this.client.mutation(
        api.comments.add,
        { issueId: target, body },
        {
          optimisticUpdate: (store) => {
            const detail = store.getQuery(api.issues.detail, { id: target });
            if (!detail) return;
            const comment = { _id: `pending-${now}`, _creationTime: now, issueId: target, body, author: { kind: OWNER_KIND }, createdAt: now, pending: true };
            store.setQuery(api.issues.detail, { id: target }, { ...detail, comments: [...detail.comments, comment as never] });
          },
        },
      ),
    );
  }

  editComment(issueId: IssueId, commentId: string, body: string) {
    const now = Date.now();
    return this.#save(1, () =>
      this.client.mutation(
        api.comments.edit,
        { commentId: commentId as never, body },
        {
          optimisticUpdate: (store) => {
            const detail = store.getQuery(api.issues.detail, { id: issueId });
            if (detail) store.setQuery(api.issues.detail, { id: issueId }, { ...detail, comments: detail.comments.map((c) => (c._id === commentId ? { ...c, body, editedAt: now } : c)) });
          },
        },
      ),
    );
  }

  removeComment(issueId: IssueId, commentId: string) {
    return this.#save(1, () =>
      this.client.mutation(
        api.comments.remove,
        { commentId: commentId as never },
        {
          optimisticUpdate: (store) => {
            const detail = store.getQuery(api.issues.detail, { id: issueId });
            if (detail) store.setQuery(api.issues.detail, { id: issueId }, { ...detail, comments: detail.comments.filter((c) => c._id !== commentId) });
          },
        },
      ),
    );
  }

  // ---------------------------------------------------------------- General (sprints, settings)

  /** Mutation with sync indicator and measurement hooks (optimistic update optional). */
  call<M extends FunctionReference<'mutation'>>(mutation: M, args: FunctionArgs<M>, optimisticUpdate?: (store: OptimisticLocalStore, args: FunctionArgs<M>) => void): Promise<FunctionReturnType<M>> {
    return this.#save(1, () => this.client.mutation(mutation, args, optimisticUpdate ? { optimisticUpdate } : undefined));
  }

  /** Action (generate keys, check a logo). */
  act<A extends FunctionReference<'action'>>(action: A, args: FunctionArgs<A>): Promise<FunctionReturnType<A>> {
    return this.#save(1, () => this.client.action(action, args));
  }

  /**
   * Subscription as a Slice (undefined = still loading). The same query with the same arguments
   * shares one subscription; `release` ends it when nobody listens anymore.
   */
  watch<Q extends FunctionReference<'query'>>(query: Q, args: FunctionArgs<Q>): { slice: Slice<FunctionReturnType<Q> | undefined>; release: () => void } {
    const key = `${getName(query)}:${JSON.stringify(args)}`;
    let entry = this.#watches.get(key);
    if (!entry) {
      const slice = new Slice<unknown>(undefined);
      const unsub = this.client.onUpdate(query, args, (value) => slice.set(value));
      entry = { slice, unsub, refs: 0 };
      this.#watches.set(key, entry);
    }
    entry.refs++;
    const current = entry;
    let released = false;
    return {
      slice: current.slice as Slice<FunctionReturnType<Q> | undefined>,
      release: () => {
        if (released) return;
        released = true;
        current.refs--;
        if (current.refs === 0) {
          current.unsub();
          this.#watches.delete(key);
        }
      },
    };
  }
  #watches = new Map<string, { slice: Slice<unknown>; unsub: () => void; refs: number }>();

  setRejectWrites(value: boolean) {
    return this.client.mutation(api.admin.setRejectWrites, { value });
  }

  // ---------------------------------------------------------------- Server search

  /** Full text (title, description, comments) via the search indexes. */
  async searchText(q: string, limit = 20): Promise<SearchHit[]> {
    return (await this.client.query(api.issues.search, { q, limit })) as SearchHit[];
  }

  /** Wiki pages (title and text) via the server. */
  async searchWiki(q: string, limit = 8) {
    return await this.client.query(api.wiki.search, { q, limit });
  }

  /** ID (also old ones) → document ID via the server. */
  async resolve(identifier: string): Promise<{ id: IssueId; identifier: string } | null> {
    return await this.client.query(api.issues.resolve, { identifier });
  }

  /** Reads once (e.g. the history on an undo conflict). */
  fetchDetail(id: IssueId): Promise<DetailDoc | null> {
    return this.client.query(api.issues.detail, { id }) as Promise<DetailDoc | null>;
  }

  // ---------------------------------------------------------------- Detail subscriptions

  /** Description, comments, history … of an issue (undefined = still loading, null = does not exist). */
  detail(id: IssueId): DetailDoc | null | undefined {
    const entry = this.#details.get(this.resolvedId(id));
    if (entry) entry.used = performance.now();
    return entry?.data;
  }

  watchDetail(rawId: IssueId, listener: () => void) {
    const id = this.resolvedId(rawId);
    if (this.#pending.has(id)) return () => {};
    let entry = this.#details.get(id);
    const created = !entry;
    if (!entry) {
      const fresh: DetailEntry = { data: undefined, unsub: () => {}, listeners: new Set(), used: 0 };
      fresh.unsub = this.client.onUpdate(api.issues.detail, { id }, (data) => {
        fresh.data = (data as DetailDoc | null) ?? null;
        for (const l of [...fresh.listeners]) l();
        if (fresh.data) for (const l of this.#detailListeners) l(fresh.data);
      });
      this.#details.set(id, fresh);
      entry = fresh;
    }
    entry.used = performance.now();
    entry.listeners.add(listener);
    // Evict only once the new entry has a timestamp and a listener, otherwise it would be the
    // oldest itself and be removed right away.
    if (created) this.#evictDetails();
    const current = entry;
    return () => {
      current.listeners.delete(listener);
      current.used = performance.now();
    };
  }

  #detailListeners = new Set<(doc: DetailDoc) => void>();

  /** Every arriving detail (also prefetched ones): e.g. to render the description in idle time. */
  onDetail(listener: (doc: DetailDoc) => void) {
    this.#detailListeners.add(listener);
    return () => this.#detailListeners.delete(listener);
  }

  prefetchDetail(id: IssueId) {
    const stop = this.watchDetail(id, () => {});
    stop();
  }

  #evictDetails() {
    if (this.#details.size <= this.#detailCache) return;
    const idle = [...this.#details].filter(([, e]) => e.listeners.size === 0).sort((a, b) => a[1].used - b[1].used);
    for (const [id, entry] of idle.slice(0, this.#details.size - this.#detailCache)) {
      entry.unsub();
      this.#details.delete(id);
    }
  }

  /** Tests only: how many detail subscriptions are running */
  get detailCount() {
    return this.#details.size;
  }

  clearCache() {
    return this.#mirror.clear();
  }
}

/**
 * Applies a patch locally (for the optimistic display). `null` removes the field. With `workflows`
 * the status type follows the status (and a status type alone becomes the team's status), as in
 * the backend.
 */
export function applyPatch(doc: IssueDoc, patch: IssuePatch, now: number, workflows?: Workflows): IssueDoc {
  const next = { ...doc } as Record<string, unknown>;
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[field];
    else next[field] = value;
  }
  if (workflows && patch.stateId) {
    const state = workflows.byId.get(patch.stateId);
    if (state) next.status = statusOfState(state);
  } else if (workflows && patch.status && !(doc.status === patch.status && doc.stateId)) {
    const state = workflows.forStatus(doc.teamId, patch.status);
    if (state) {
      next.stateId = state._id;
      next.status = statusOfState(state);
    }
  }
  // Moving to done/canceled/duplicate clears the priority, as in the backend.
  if (next.stateId !== doc.stateId && CLOSED_STATUSES.includes(next.status as Status)) {
    next.priority = 0;
    delete next.snoozedUntil;
  }
  next.updatedAt = now;
  return next as unknown as IssueDoc;
}

/** Rough local rank between two ranks (only for the optimistic display). */
export function rankBetweenLocal(lo?: string, hi?: string): string {
  const a = lo ?? '';
  if (!hi) return `${a}V`;
  if (a < hi) {
    // Common prefix plus a character in between, otherwise append.
    let i = 0;
    while (i < a.length && a[i] === hi[i]) i++;
    const ca = i < a.length ? a.charCodeAt(i) : 47;
    const cb = hi.charCodeAt(i);
    if (cb - ca > 1) return hi.slice(0, i) + String.fromCharCode(Math.floor((ca + cb) / 2));
    return `${a}V`;
  }
  return `${a}V`;
}

/** Name of a Convex function (for subscription keys). */
function getName(fn: unknown): string {
  return String((fn as Record<symbol, unknown>)[Symbol.for('functionName')] ?? fn);
}

export type { CommentDoc };
