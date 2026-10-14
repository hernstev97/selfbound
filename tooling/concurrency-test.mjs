#!/usr/bin/env node
// Concurrency test against a LOCAL backend.
//
//   node tooling/concurrency-test.mjs [--port 13480] [--rounds 12] [--report <file.md>]
//
// Working at the same time:
//   - 20 UI clients (ConvexClient over WebSocket, local token from tooling/dev-auth.mjs)
//   - 5 MCP agents (HTTP with real keys created via agents.create)
//   - GitHub webhooks with valid signatures, every delivery several times and in parallel
// They change the same and different fields, create with duplicate requestIds, comment, drop
// connections and send changes the server deliberately rejects (test switch). Afterwards the
// script reads the final state via `convex export` and checks:
//   1. Every confirmed change is in the history, no rejected one is.
//   2. Per field, the final state holds the last confirmed write.
//   3. No duplicate issues or comments per requestId.
//   4. No duplicate PRs or PR links.
//   5. Every GitHub delivery takes effect exactly once.
//   6. Issue numbers are contiguous and unique, seq is unique.
//   7. Rejected changes leave nothing behind.
// Exit code 0 only if all checks pass. Synthetic data only.

import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readZip } from './backup/snapshot.mjs';
import { devToken } from './dev-auth.mjs';
import { convexCli } from './temp-backend.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const FIELDS = ['title', 'estimate', 'dueDate', 'priority', 'labelIds'];
/** Fields with a guaranteed new value per write: every confirmed write must be in the history. */
const UNIQUE_FIELDS = new Set(['title', 'estimate', 'dueDate']);
const STATUSES = ['todo', 'in_progress', 'in_review', 'backlog'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errorCode = (error) => error?.data?.code ?? (typeof error?.data === 'string' ? JSON.parse(error.data).code : undefined);

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function jsonl(entries, table) {
  const buf = entries.get(`${table}/documents.jsonl`);
  if (!buf) return [];
  return buf
    .toString('utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/**
 * Runs the test. `backendDir`: directory for the Convex CLI (env set, export).
 * Returns { ok, checks, stats }.
 */
export async function runConcurrencyTest({
  url,
  siteUrl,
  backendDir,
  token = devToken(),
  uiClients = 20,
  agentCount = 5,
  rounds = 12,
  log = (msg) => console.log(msg),
}) {
  const { ConvexClient, ConvexHttpClient } = await import('convex/browser');
  const { api } = await import('../backend/convex/_generated/api.js');
  const started = Date.now();
  const secret = `cc-${randomBytes(12).toString('hex')}`;
  await convexCli(backendDir, ['env', 'set', 'GITHUB_WEBHOOK_SECRET', secret]);

  const admin = new ConvexHttpClient(url);
  admin.setAuth(token);
  await admin.mutation(api.admin.setRejectWrites, { value: false });

  // ---------------------------------------------------------------- Setup (owner)
  const tag = randomBytes(2).toString('hex').toUpperCase().replace(/[^A-Z]/g, 'X');
  const teamKey = `CC${tag.replace(/\d/g, 'Q')}`.slice(0, 6);
  log(`Setup: team ${teamKey}, ${uiClients} UI clients, ${agentCount} agents, ${rounds} rounds …`);
  const { teamId } = await admin.mutation(api.teams.create, { key: teamKey, name: `Concurrency ${tag}` });
  const labels = [];
  for (const name of ['CC-A', 'CC-B', 'CC-C']) labels.push((await admin.mutation(api.labels.create, { name, hue: 120, teamId })).labelId);
  const sharedCount = 8;
  const base = await admin.mutation(api.issues.create, {
    issues: Array.from({ length: sharedCount + uiClients + agentCount }, (_, i) => ({
      teamId,
      title: i < sharedCount ? `Shared ${i + 1}` : `Own ${i + 1}`,
      status: 'todo',
    })),
  });
  const shared = base.issues.slice(0, sharedCount);
  const ownUi = base.issues.slice(sharedCount, sharedCount + uiClients);
  const ownAgent = base.issues.slice(sharedCount + uiClients);
  const keys = [];
  for (let j = 0; j < agentCount; j++) keys.push(await admin.action(api.agents.create, { name: `Concurrency ${tag} ${j + 1}` }));

  // Log of all write attempts and their results
  const writes = []; // { who, issueId, field, value, requestId, confirmed, changed, error, seqInClient }
  const creates = []; // { requestId, owner, expectedCount, responses: [ids] }
  const commentsSent = []; // { requestId, owner, responses: [commentId] }
  const deliveries = new Map(); // deliveryId → { responses: [] }
  const rejected = []; // requestIds the server should reject
  const aborted = []; // requestIds with a dropped connection
  const today = new Date().toISOString().slice(0, 10);

  // ---------------------------------------------------------------- UI clients
  const clients = Array.from({ length: uiClients }, () => {
    // logger: false: rejected changes (phase 2) are intended and should not flood the output.
    const c = new ConvexClient(url, { unsavedChangesWarning: false, logger: false });
    c.setAuth(async () => token);
    return c;
  });

  async function uiWorker(i) {
    const client = clients[i];
    for (let r = 0; r < rounds; r++) {
      const n = i * rounds + r;
      // 1. shared issue, changing field (race with other clients and agents)
      const issue = shared[(i + r) % sharedCount];
      const field = FIELDS[(i * 7 + r) % FIELDS.length];
      const value =
        field === 'title'
          ? `G-u${i}-r${r}`
          : field === 'estimate'
            ? n % 1000
            : field === 'dueDate'
              ? addDays('2027-01-01', n)
              : field === 'priority'
                ? (i + r) % 5
                : labels.filter((_, b) => ((i + r) >> b) & 1);
      const requestId = `cc-${tag}-ui${i}-r${r}`;
      const entry = { who: `ui${i}`, issueId: issue.id, field, value, requestId, order: r };
      try {
        const res = await client.mutation(api.issues.update, { ids: [issue.id], patch: { [field]: value }, requestId });
        Object.assign(entry, { confirmed: true, changed: res.changed });
      } catch (error) {
        Object.assign(entry, { confirmed: false, error: errorCode(error) ?? String(error) });
      }
      writes.push(entry);

      // 2. own issue (this client only): the last title must win
      const own = { who: `ui${i}`, issueId: ownUi[i].id, field: 'title', value: `E-u${i}-r${r}`, requestId: `cc-${tag}-own${i}-r${r}`, order: r };
      try {
        const res = await client.mutation(api.issues.update, { ids: [own.issueId], patch: { title: own.value }, requestId: own.requestId });
        Object.assign(own, { confirmed: true, changed: res.changed });
      } catch (error) {
        Object.assign(own, { confirmed: false, error: errorCode(error) ?? String(error) });
      }
      writes.push(own);

      // 3. comment, the same requestId twice at the same time
      if (r % 3 === 0) {
        const c = { requestId: `cc-${tag}-uc${i}-${r}`, owner: 'owner', responses: [] };
        const args = { issueId: shared[(i + r + 1) % sharedCount].id, body: `Comment u${i} r${r}`, requestId: c.requestId };
        const results = await Promise.allSettled([client.mutation(api.comments.add, args), clients[(i + 1) % uiClients].mutation(api.comments.add, args)]);
        for (const x of results) c.responses.push(x.status === 'fulfilled' ? x.value.commentId : `Error: ${errorCode(x.reason)}`);
        commentsSent.push(c);
      }
      // 4. Create: the same requestId from ALL clients at the same time (same actor, the owner)
      if (r % 4 === 0) {
        const requestId = `cc-${tag}-shared-create-${r}`;
        let record = creates.find((x) => x.requestId === requestId);
        if (!record) creates.push((record = { requestId, owner: 'owner', expectedCount: 1, responses: [] }));
        try {
          const res = await client.mutation(api.issues.create, { issues: [{ teamId, title: `Created together ${r}` }], requestId });
          record.responses.push(res.issues.map((x) => x.id).join(','));
        } catch (error) {
          record.responses.push(`Error: ${errorCode(error) ?? error}`);
        }
      }
      // 5. dropped connection: send a create, disconnect immediately, then retry via the main client
      if (r === 1 && i % 4 === 0) {
        const requestId = `cc-${tag}-abort-${i}`;
        const args = { issues: [{ teamId, title: `After disconnect ${i}` }], requestId };
        const temp = new ConvexClient(url, { unsavedChangesWarning: false, logger: false });
        temp.setAuth(async () => token);
        temp.mutation(api.issues.create, args).catch(() => undefined);
        await sleep(5 + (i % 3) * 10);
        await temp.close();
        const record = { requestId, owner: 'owner', expectedCount: 1, responses: [] };
        const res = await client.mutation(api.issues.create, args);
        record.responses.push(res.issues.map((x) => x.id).join(','));
        creates.push(record);
        aborted.push(requestId);
      }
    }
  }

  // ---------------------------------------------------------------- MCP agents
  function mcp(key) {
    let id = 0;
    const rpc = async (method, params) => {
      const response = await fetch(`${siteUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${key}`,
          'MCP-Protocol-Version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      });
      if (response.status !== 200) throw new Error(`MCP ${method}: HTTP ${response.status}`);
      return await response.json();
    };
    const call = async (name, args) => {
      const body = await rpc('tools/call', { name, arguments: args });
      const result = body.result;
      if (!result) throw new Error(`MCP ${name}: ${JSON.stringify(body.error)}`);
      return result.isError ? { ok: false, error: result.content[0].text } : { ok: true, value: result.structuredContent };
    };
    return { rpc, call };
  }

  async function agentWorker(j) {
    const agent = mcp(keys[j].key);
    await agent.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'concurrency-test', version: '1' } });
    const identifierOf = async (issueId) => (await agent.call('get_issue', { id: issueId })).value;
    for (let r = 0; r < rounds; r++) {
      // 1. shared issue: title, every second round with an expected value (compare-and-set)
      const issue = shared[(j * 3 + r) % sharedCount];
      const before = await identifierOf(issue.id);
      const requestId = `cc-${tag}-ag${j}-u${r}`;
      const args = { requestId, identifier: before.identifier, title: `G-a${j}-r${r}`, ...(r % 2 ? { expected: { title: before.title } } : {}) };
      const res = await agent.call('update_issue', args);
      writes.push({
        who: `ag${j}`,
        issueId: issue.id,
        field: 'title',
        value: args.title,
        requestId,
        order: r,
        confirmed: res.ok,
        changed: res.ok && res.value.changed.includes('title') ? 1 : 0,
        conflict: res.ok && res.value.conflicts.length > 0,
        error: res.ok ? undefined : res.error,
      });
      // 2. Create: the same requestId twice at the same time, then once more
      const createId = `cc-${tag}-ag${j}-c${r}`;
      const createArgs = { requestId: createId, issues: [{ team: teamKey, title: `Agent ${j} round ${r} a` }, { team: teamKey, title: `Agent ${j} round ${r} b` }] };
      const record = { requestId: createId, owner: keys[j].agentId, expectedCount: 2, responses: [] };
      const pair = await Promise.all([agent.call('create_issues', createArgs), agent.call('create_issues', createArgs)]);
      const third = await agent.call('create_issues', createArgs);
      for (const x of [...pair, third]) record.responses.push(x.ok ? x.value.created.map((c) => c.identifier).join(',') : `Error: ${x.error}`);
      creates.push(record);
      // 3. comment twice at the same time
      if (r % 2 === 0) {
        const c = { requestId: `cc-${tag}-ag${j}-k${r}`, owner: keys[j].agentId, responses: [] };
        const cargs = { requestId: c.requestId, identifier: before.identifier, body: `Agent ${j}: progress ${r}` };
        const two = await Promise.all([agent.call('add_comment', cargs), agent.call('add_comment', cargs)]);
        for (const x of two) c.responses.push(x.ok ? x.value.commentId : `Error: ${x.error}`);
        commentsSent.push(c);
      }
      // 4. status of the own issue
      const ownIssue = await identifierOf(ownAgent[j].id);
      const status = STATUSES[r % STATUSES.length];
      const st = await agent.call('set_status', { identifiers: [ownIssue.identifier], status });
      writes.push({
        who: `ag${j}`,
        issueId: ownAgent[j].id,
        field: 'status',
        value: status,
        requestId: undefined,
        order: r,
        confirmed: st.ok,
        changed: st.ok ? st.value.changed : 0,
        error: st.ok ? undefined : st.error,
      });
    }
  }

  // ---------------------------------------------------------------- GitHub
  const prCount = 6;
  const prBase = Number.parseInt(randomBytes(2).toString('hex'), 16) * 10;
  const ownIdentifier = (k) => `${teamKey}-${sharedCount + k + 1}`; // numbers of the UI clients' own issues
  function prPayload(k, action, merged) {
    const number = prBase + k;
    return {
      action,
      number,
      repository: { full_name: 'acme/concurrency' },
      pull_request: {
        number,
        title: action === 'edited' ? `PR ${k} (see ${ownIdentifier(k + 2)})` : `PR ${k}`,
        body: `Fixes ${ownIdentifier(k + 1)}`,
        state: action === 'closed' ? 'closed' : 'open',
        draft: false,
        merged,
        merged_at: merged ? new Date().toISOString() : null,
        updated_at: new Date(Date.now() + (action === 'closed' ? 60_000 : action === 'edited' ? 30_000 : 0)).toISOString(),
        html_url: `https://github.com/acme/concurrency/pull/${number}`,
        head: { ref: `cc/${ownIdentifier(k).toLowerCase()}-work` },
        user: { login: 'octocat' },
      },
    };
  }
  async function deliver(event, payload, deliveryId) {
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const response = await fetch(`${siteUrl}/github`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': deliveryId, 'X-Hub-Signature-256': signature },
      body,
    });
    const record = deliveries.get(deliveryId) ?? { responses: [], prNumber: payload.number, action: payload.action };
    record.responses.push(response.status === 200 ? await response.json() : { status: response.status });
    deliveries.set(deliveryId, record);
  }
  async function githubWorker() {
    const jobs = [];
    for (let k = 0; k < prCount; k++) {
      const events = [
        [`cc-${tag}-pr${k}-open`, prPayload(k, 'opened', false)],
        [`cc-${tag}-pr${k}-edit`, prPayload(k, 'edited', false)],
        ...(k % 2 === 0 ? [[`cc-${tag}-pr${k}-merge`, prPayload(k, 'closed', true)]] : []),
      ];
      // Every delivery three times at once, all events of a PR at once as well.
      for (const [id, payload] of events) for (let x = 0; x < 3; x++) jobs.push(deliver('pull_request', payload, id));
    }
    await Promise.all(jobs);
    // GitHub redelivers once more later
    for (let k = 0; k < prCount; k++) await deliver('pull_request', prPayload(k, 'opened', false), `cc-${tag}-pr${k}-open`);
    // A wrong signature is rejected
    const bad = await fetch(`${siteUrl}/github`, {
      method: 'POST',
      headers: { 'X-GitHub-Event': 'pull_request', 'X-GitHub-Delivery': `cc-${tag}-bad`, 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) },
      body: JSON.stringify(prPayload(0, 'opened', false)),
    });
    deliveries.set(`cc-${tag}-bad`, { responses: [{ status: bad.status }], bad: true });
  }

  // ---------------------------------------------------------------- Run
  log('Phase 1: concurrent changes, creates, comments, webhooks …');
  const phase1 = Date.now();
  await Promise.all([
    ...Array.from({ length: uiClients }, (_, i) => uiWorker(i)),
    ...Array.from({ length: agentCount }, (_, j) => agentWorker(j)),
    githubWorker(),
  ]);
  const phase1Ms = Date.now() - phase1;

  log('Phase 2: server rejects writes (test switch) …');
  await admin.mutation(api.admin.setRejectWrites, { value: true });
  const rejectResults = await Promise.allSettled(
    clients.map((client, i) => {
      const requestId = `cc-${tag}-rej${i}`;
      rejected.push({ requestId, issueId: ownUi[i].id });
      return client.mutation(api.issues.update, { ids: [ownUi[i].id], patch: { title: `REJECTED ${i}` }, requestId });
    }),
  );
  await admin.mutation(api.admin.setRejectWrites, { value: false });
  for (const client of clients) await client.close();

  // ---------------------------------------------------------------- Read the final state
  log('Reading the final state (convex export) …');
  const work = mkdtempSync(join(tmpdir(), 'selfbound-concurrency-'));
  const zip = join(work, 'export.zip');
  await convexCli(backendDir, ['export', '--path', zip]);
  const entries = readZip(readFileSync(zip));
  rmSync(work, { recursive: true, force: true });
  const issues = jsonl(entries, 'issues');
  const history = jsonl(entries, 'history').sort((a, b) => a._creationTime - b._creationTime);
  const comments = jsonl(entries, 'comments');
  const pullRequests = jsonl(entries, 'pullRequests');
  const links = jsonl(entries, 'issuePullRequests');
  const githubRows = jsonl(entries, 'githubDeliveries');
  const counters = jsonl(entries, 'counters');
  const issueById = new Map(issues.map((x) => [x._id, x]));
  const historyByRequest = new Map();
  for (const h of history) {
    if (!h.requestId) continue;
    const list = historyByRequest.get(h.requestId) ?? [];
    list.push(h);
    historyByRequest.set(h.requestId, list);
  }
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const sameSet = (a, b) => same([...(a ?? [])].sort(), [...(b ?? [])].sort());

  // ---------------------------------------------------------------- Checks
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  // 1. confirmed changes in the history
  const confirmed = writes.filter((w) => w.confirmed && w.requestId);
  const missing = [];
  let changedCount = 0;
  let noopCount = 0;
  for (const w of confirmed) {
    const rows = (historyByRequest.get(w.requestId) ?? []).filter((h) => h.issueId === w.issueId && h.field === w.field);
    if (w.changed) {
      changedCount++;
      const match = rows.some((h) => (w.field === 'labelIds' ? sameSet(h.to, w.value) : same(h.to, w.value)));
      if (!match) missing.push(`${w.who} ${w.requestId} ${w.field}`);
    } else {
      noopCount++;
      if (rows.length) missing.push(`${w.who} ${w.requestId}: reported as unchanged but is in the history`);
      // Fields with a unique value always change, unless an expected value did not match (agent conflict).
      if (UNIQUE_FIELDS.has(w.field) && !w.conflict) missing.push(`${w.who} ${w.requestId}: unique value without a change`);
    }
  }
  const unconfirmed = writes.filter((w) => !w.confirmed);
  const conflicts = writes.filter((w) => w.conflict).length;
  check(
    'Every confirmed change is in the history',
    missing.length === 0 && unconfirmed.length === 0,
    `${confirmed.length} confirmed writes with requestId (${changedCount} changes, ${noopCount} without a change, ${conflicts} of them correctly not written because the expected value had changed meanwhile); ${unconfirmed.length} failed unexpectedly${missing.length ? `; missing: ${missing.slice(0, 5).join('; ')}` : ''}`,
  );

  // 2. final state = last write per field; per client the later write wins
  const fieldsTouched = new Map();
  for (const w of writes) fieldsTouched.set(`${w.issueId}|${w.field}`, [...(fieldsTouched.get(`${w.issueId}|${w.field}`) ?? []), w]);
  const wrong = [];
  for (const [key, list] of fieldsTouched) {
    const [issueId, field] = key.split('|');
    // Status: the history records the status id (`stateId`); the status type follows it.
    const historyField = field === 'status' ? 'stateId' : field;
    const last = history.filter((h) => h.issueId === issueId && h.field === historyField).at(-1);
    const doc = issueById.get(issueId);
    if (!doc) {
      wrong.push(`${key}: issue missing`);
      continue;
    }
    if (!last) {
      // Only writes without a change (same value as before): the final state is exactly that value.
      const allNoop = list.every((w) => w.confirmed && !w.changed);
      const value = list[0].value;
      const ok = allNoop && (field === 'labelIds' ? sameSet(doc[field], value) : same(doc[field], value));
      if (!ok) wrong.push(`${key}: no history`);
      continue;
    }
    const ok = field === 'labelIds' ? sameSet(doc[field], last.to) : same(doc[historyField], last.to);
    if (!ok) wrong.push(`${key}: final state ${JSON.stringify(doc[field])} ≠ last history row ${JSON.stringify(last.to)}`);
  }
  for (let i = 0; i < uiClients; i++) {
    const lastOwn = writes.filter((w) => w.issueId === ownUi[i].id && w.confirmed).sort((a, b) => a.order - b.order).at(-1);
    const doc = issueById.get(ownUi[i].id);
    if (lastOwn && doc.title !== lastOwn.value) wrong.push(`own issue ui${i}: ${doc.title} instead of ${lastOwn.value}`);
  }
  check(
    'Per field, the last confirmed write wins',
    wrong.length === 0,
    `${fieldsTouched.size} fields on ${new Set(writes.map((w) => w.issueId)).size} issues checked; the last history row matches the final state; ${uiClients} own issues carry the last confirmed title${wrong.length ? `; mismatches: ${wrong.slice(0, 5).join('; ')}` : ''}`,
  );

  // 3. duplicate requestIds
  const dupProblems = [];
  for (const c of creates) {
    const rows = history.filter((h) => h.field === 'created' && h.requestId === c.requestId);
    const owners = new Set(rows.map((h) => (h.actor.kind === 'agent' ? h.actor.agentId : h.actor.kind)));
    if (rows.length !== c.expectedCount) dupProblems.push(`${c.requestId}: ${rows.length} instead of ${c.expectedCount} issues`);
    if (owners.size > 1) dupProblems.push(`${c.requestId}: several actors`);
    if (new Set(c.responses).size !== 1 || c.responses[0].startsWith('Error')) dupProblems.push(`${c.requestId}: responses ${c.responses.join(' | ')}`);
  }
  for (const c of commentsSent) {
    const rows = history.filter((h) => h.field === 'comment' && h.requestId === c.requestId);
    if (rows.length !== 1) dupProblems.push(`${c.requestId}: ${rows.length} comments`);
    if (new Set(c.responses).size !== 1 || String(c.responses[0]).startsWith('Error')) dupProblems.push(`${c.requestId}: responses ${c.responses.join(' | ')}`);
  }
  const sendCount = creates.reduce((a, c) => a + c.responses.length, 0);
  check(
    'No duplicate issues or comments per requestId',
    dupProblems.length === 0,
    `${creates.length} create requestIds with ${sendCount} calls (up to ${uiClients} at once, ${aborted.length} retried after a dropped connection), ${commentsSent.length} comment requestIds with 2 concurrent calls each${dupProblems.length ? `; problems: ${dupProblems.slice(0, 5).join('; ')}` : ''}`,
  );

  // 4. PRs and PR links
  const ours = pullRequests.filter((p) => p.repo === 'acme/concurrency' && p.number >= prBase && p.number < prBase + prCount);
  const prKeys = new Set(ours.map((p) => `${p.repo}#${p.number}`));
  const ourLinks = links.filter((l) => ours.some((p) => p._id === l.prId));
  const linkKeys = new Set(ourLinks.map((l) => `${l.issueId}|${l.prId}`));
  check(
    'No duplicate PRs or PR links',
    ours.length === prCount && prKeys.size === prCount && linkKeys.size === ourLinks.length && ourLinks.length === prCount * 3,
    `${ours.length} PRs (expected ${prCount}), ${ourLinks.length} links (expected ${prCount * 3}: branch, "Fixes", title), duplicates: ${ourLinks.length - linkKeys.size}`,
  );

  // 5. every delivery takes effect exactly once
  const deliveryProblems = [];
  let deliveryCalls = 0;
  for (const [id, d] of deliveries) {
    deliveryCalls += d.responses.length;
    if (d.bad) {
      if (d.responses[0].status !== 401) deliveryProblems.push(`${id}: wrong signature not rejected`);
      if (githubRows.some((g) => g.deliveryId === id)) deliveryProblems.push(`${id}: stored despite a wrong signature`);
      continue;
    }
    const effective = d.responses.filter((r) => r.duplicate === false).length;
    const rows = githubRows.filter((g) => g.deliveryId === id).length;
    if (effective !== 1 || rows !== 1) deliveryProblems.push(`${id}: ${effective}× effective, ${rows} rows`);
  }
  const closedExpected = [];
  for (let k = 0; k < prCount; k += 2) closedExpected.push(ownIdentifier(k), ownIdentifier(k + 1));
  const testIssues = issues.filter((x) => x.teamId === teamId);
  const byIdentifier = new Map(testIssues.map((x) => [`${teamKey}-${x.number}`, x]));
  for (const identifier of closedExpected) {
    const issue = byIdentifier.get(identifier);
    const statusRows = history.filter((h) => h.issueId === issue?._id && h.field === 'stateId' && h.actor.kind === 'github');
    if (issue?.status !== 'done' || statusRows.length !== 1) deliveryProblems.push(`${identifier}: status ${issue?.status}, ${statusRows.length} status rows from GitHub`);
  }
  for (const l of ourLinks) {
    const rows = history.filter((h) => h.issueId === l.issueId && h.field === 'pull_request' && h.to?.pr === `acme/concurrency#${ours.find((p) => p._id === l.prId).number}`);
    if (rows.length !== 1) deliveryProblems.push(`link ${l.issueId}: ${rows.length} history rows`);
  }
  check(
    'Every GitHub delivery takes effect exactly once',
    deliveryProblems.length === 0,
    `${deliveries.size - 1} deliveries with ${deliveryCalls - 1} calls (3× at once each, "opened" once more later), ${closedExpected.length} issues completed by merge (exactly one status row each), wrong signature → 401${deliveryProblems.length ? `; problems: ${deliveryProblems.slice(0, 5).join('; ')}` : ''}`,
  );

  // 6. numbers
  const numbers = testIssues.map((x) => x.number).sort((a, b) => a - b);
  const contiguous = numbers.every((n, i) => n === i + 1);
  const counter = counters.find((c) => c.name === `team:${teamId}`)?.value;
  const seqs = issues.map((x) => x.seq);
  const seqUnique = new Set(seqs).size === seqs.length;
  const bucketsOk = issues.every((x) => x.bucket === Math.floor(x.seq / 64));
  const seqCounter = counters.find((c) => c.name === 'seq')?.value;
  check(
    'Issue numbers contiguous and unique',
    contiguous && counter === numbers.length && seqUnique && bucketsOk && seqCounter === Math.max(...seqs),
    `${teamKey}: ${numbers.length} issues numbered 1 to ${numbers.at(-1)}, counter ${counter}; seq unique across all ${issues.length} issues (${seqUnique ? 'yes' : 'no'}), buckets correct (${bucketsOk ? 'yes' : 'no'})`,
  );

  // 7. a rejected save leaves nothing behind
  const rejectedOk = rejectResults.every((x) => x.status === 'rejected' && errorCode(x.reason) === 'rejected');
  const leaked = rejected.filter((x) => historyByRequest.has(x.requestId) || issueById.get(x.issueId)?.title.startsWith('REJECTED'));
  check(
    'Rejected changes leave nothing behind',
    rejectedOk && leaked.length === 0,
    `${rejected.length} changes while "server rejects writes" was on: all returned the error "rejected" (${rejectedOk ? 'yes' : 'no'}), none in the history or final state (${leaked.length} found)`,
  );

  const stats = {
    team: teamKey,
    uiClients,
    agents: agentCount,
    rounds,
    writes: writes.length,
    statusWrites: writes.filter((w) => w.field === 'status').length,
    creates: sendCount,
    comments: commentsSent.reduce((a, c) => a + c.responses.length, 0),
    deliveries: deliveryCalls,
    issuesInTeam: testIssues.length,
    phase1Ms,
    totalMs: Date.now() - started,
  };
  return { ok: checks.every((c) => c.ok), checks, stats };
}

export function formatReport(result, { url }) {
  const date = `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const s = result.stats;
  const lines = [
    '# Concurrency test report',
    '',
    `${date} · Result: **${result.ok ? 'passed' : 'FAILED'}**`,
    '',
    '## What this is about',
    '',
    'When you change something in the app while agents work over MCP and GitHub sends webhooks at the same time, no confirmed change may get lost, nothing may be created twice and nothing may take effect twice. This test creates such a situation on purpose, far denser than in daily use.',
    '',
    '## What happened at the same time',
    '',
    `Against a local test backend (${url}, made-up data only, team ${s.team}):`,
    '',
    `- **${s.uiClients} app windows** (separate connections, as in a browser) changed title, estimate, due date, priority and labels of 8 shared issues and one own issue each over ${s.rounds} rounds, commented with duplicated calls and created issues, partly with the same request id from all windows at once.`,
    `- **${s.agents} agents** over MCP with real keys changed the same issues (partly with an "expected old value"), created two issues per round with the same request three times, commented twice and set statuses.`,
    '- **GitHub** delivered 6 pull requests (opened, edited, some merged). Every delivery arrived three times at once, "opened" once more later, plus one with a wrong signature.',
    '- **Dropped connections:** some windows sent a "create" and disconnected immediately; then the same request came again.',
    '- **Server rejects writes:** at the end the test switch "server rejects writes" was on and every window tried one more change.',
    '',
    `In total ${s.writes} field changes (${s.statusWrites} of them status changes by agents), ${s.creates} create calls, ${s.comments} comment calls and ${s.deliveries} webhook calls in ${(s.phase1Ms / 1000).toFixed(1)} s. Afterwards the complete data set was exported and checked.`,
    '',
    '## Result',
    '',
    '| Check | Result | Numbers |',
    '|---|---|---|',
    ...result.checks.map((c) => `| ${c.name} | ${c.ok ? 'passed' : '**failed**'} | ${c.detail.replaceAll('|', '/')} |`),
    '',
    '## What this means',
    '',
    '- **Last write wins per field.** If two people change the same field at once, the one the server confirmed last applies. The other is not lost; it is in the issue history.',
    '- **Agents with an "expected value"** never overwrite something that changed meanwhile. They get a conflict notice instead.',
    '- **Sent twice does not mean created twice.** The same request id takes effect exactly once, even when it arrives from several windows at once or after a dropped connection.',
    '- **GitHub may redeliver.** Every delivery takes effect exactly once; a merged PR sets an issue to done exactly once.',
    '- **A rejected save** leaves no trace. The app gets an error back and can roll back its display.',
    '',
    '## Why the HTTP endpoints retry',
    '',
    'When very many writers change the same issue at once, Convex retries a mutation a few times and then gives up. App connections retry on their own, but the HTTP endpoints for MCP and GitHub returned an error, and GitHub does not redeliver a failed delivery by itself. Both endpoints therefore retry up to six times with a short random pause. This is safe because a failed mutation wrote nothing.',
    '',
    '## Reproduce',
    '',
    '```sh',
    'node tooling/local.mjs --port 13480 --seed small --no-wait',
    'node tooling/concurrency-test.mjs --port 13480 --report concurrency-report.md',
    '```',
    '',
    'A smaller version runs automatically in the integration test (`pnpm --filter @selfbound/backend test:integration`).',
    '',
  ];
  return lines.join('\n');
}

async function main(argv) {
  const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const port = Number(opt('port', '13480'));
  const url = `http://127.0.0.1:${port}`;
  const siteUrl = `http://127.0.0.1:${port + 1}`;
  const backendDir = resolve(opt('backend-dir', join(root, 'backend')));
  const result = await runConcurrencyTest({ url, siteUrl, backendDir, rounds: Number(opt('rounds', '12')) });
  console.log('');
  for (const c of result.checks) console.log(`${c.ok ? '✔' : '✖'} ${c.name}\n    ${c.detail}`);
  console.log('');
  console.log(result.ok ? 'All checks passed.' : 'At least one check FAILED.');
  const report = opt('report');
  if (report) {
    writeFileSync(resolve(root, report), formatReport(result, { url }));
    console.log(`Report: ${report}`);
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
