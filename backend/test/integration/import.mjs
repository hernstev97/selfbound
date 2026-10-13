// Import integration test: synthetic Linear snapshot → normalization → staging.jsonl →
// `push` (importer:stage + importer:process) against the real local backend, twice in a
// row. Expected: same counts, no duplicates.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readZip } from '../../../tooling/backup/snapshot.mjs';
import { normalize, snapshotCounts, stagingRows } from '../../../tooling/linear-import/normalize.ts';
import { runPush } from '../../../tooling/linear-import/push.ts';
import { syntheticLinearData } from '../../../tooling/linear-import/synthetic.ts';

const TABLES = [
  'teams',
  'labelGroups',
  'labels',
  'projects',
  'sprints',
  'sprintItems',
  'issues',
  'issueBodies',
  'identifierAliases',
  'comments',
  'relations',
  'history',
  'pullRequests',
  'issuePullRequests',
  'linearLinks',
  'importStaging',
  'importConflicts',
];

async function exportTables(backend, work, name) {
  const zip = join(work, `${name}.zip`);
  await backend.convex(['export', '--path', zip]);
  const entries = readZip(readFileSync(zip));
  const out = {};
  for (const table of TABLES) {
    const buf = entries.get(`${table}/documents.jsonl`);
    out[table] = buf
      ? buf
          .toString('utf8')
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l))
      : [];
  }
  return out;
}

const countsOf = (tables) => Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
const seenOf = (result) => Object.fromEntries(Object.entries(result.counts).map(([k, c]) => [k, c.seen]));

export async function importSuite(backend, log) {
  // Outside the repo, like a real fetch.
  const work = mkdtempSync(join(tmpdir(), 'xlr8-import-test-'));
  try {
    const run = 'synthetic-2026-10-09T00-00-00Z';
    const snapshot = normalize(syntheticLinearData(), { run, fetchedAt: Date.UTC(2026, 9, 9) });
    const expected = snapshotCounts(snapshot);
    writeFileSync(join(work, 'staging.jsonl'), stagingRows(snapshot).map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(join(work, 'summary.json'), JSON.stringify({ run, counts: expected, notes: snapshot.notes }, null, 2));
    log(`Import: synthetic snapshot with ${expected.issues} issues, ${expected.comments} comments, ${expected.relations} relations, ${expected.pullRequests} PR attachments, ${expected.sprints} cycles`);

    const quiet = () => {};
    const first = await runPush({ path: work, yes: true, backendDir: backend.dir, print: quiet });
    assert.equal(first.status, 'done');
    const afterFirst = await exportTables(backend, work, 'first-run');
    const second = await runPush({ path: work, yes: true, backendDir: backend.dir, print: quiet });
    assert.equal(second.status, 'done');
    const afterSecond = await exportTables(backend, work, 'second-run');

    // Same counts
    assert.deepEqual(seenOf(second), seenOf(first), 'both runs read the same records');
    assert.equal(seenOf(first).issue, expected.issues);
    assert.equal(first.counts.issue.created, expected.issues);
    for (const [step, c] of Object.entries(second.counts)) {
      assert.equal(c.created + c.updated, 0, `second run: ${step} has ${c.created} created, ${c.updated} updated`);
    }
    // No duplicates: tables after the second run as large as after the first
    const sizes = countsOf(afterSecond);
    const { importStaging: _s1, ...firstSizes } = countsOf(afterFirst);
    const { importStaging: _s2, ...secondSizes } = sizes;
    assert.deepEqual(secondSizes, firstSizes, 'second run must not create anything');
    assert.equal(sizes.importStaging, 0, 'staging is empty after the run');
    assert.equal(sizes.issues, expected.issues);
    assert.equal(sizes.relations, expected.relations);
    assert.equal(sizes.comments, expected.comments + 1, 'comments + one "Attachments from Linear" comment');
    // Uniqueness
    const unique = (rows, key) => new Set(rows.map(key)).size === rows.length;
    assert.ok(unique(afterSecond.issues, (i) => `${i.teamId}|${i.number}`), 'identifiers unique');
    assert.ok(unique(afterSecond.issues, (i) => i.seq), 'seq unique');
    assert.ok(unique(afterSecond.linearLinks, (l) => `${l.kind}|${l.linearId}`), 'linearLinks unique');
    assert.ok(unique(afterSecond.pullRequests, (p) => `${p.repo}#${p.number}`), 'PRs unique');
    assert.ok(unique(afterSecond.issuePullRequests, (l) => `${l.issueId}|${l.prId}`), 'PR links unique');
    // One PR on two issues: one PR, two links
    const lab10 = afterSecond.pullRequests.filter((p) => p.repo === 'acme/lab' && p.number === 10);
    assert.equal(lab10.length, 1);
    assert.equal(afterSecond.issuePullRequests.filter((l) => l.prId === lab10[0]._id).length, 2);
    // Identifiers stay, seq follows the creation date, old identifiers are aliases
    const teams = new Map(afterSecond.teams.map((t) => [t._id, t.key]));
    const ids = afterSecond.issues.map((i) => `${teams.get(i.teamId)}-${i.number}`);
    for (const team of ['CODE', 'APIX', 'TOOL']) assert.ok(ids.includes(`${team}-1`), `${team}-1 missing`);
    assert.ok(!ids.includes('CODE-31'), 'issue from the Linear trash must not be imported');
    const byCreated = [...afterSecond.issues].sort((a, b) => a.createdAt - b.createdAt);
    assert.ok(byCreated.every((issue, i) => i === 0 || issue.seq > byCreated[i - 1].seq), 'seq follows the creation date');
    assert.deepEqual(afterSecond.identifierAliases.map((a) => a.key).sort(), ['AALT-9', 'COLD-1', 'COLD-2', 'COLD-3']);
    // Cycles: closed Linear sprints, "imported" entries with an end
    assert.ok(afterSecond.sprints.every((s) => s.state === 'closed' && s.source === 'linear'));
    assert.ok(afterSecond.sprintItems.every((e) => e.kind === 'imported' && e.removedAt !== undefined && e.outcome));
    assert.ok(afterSecond.issues.every((i) => i.sprintId === undefined));
    // Actor import
    assert.ok(afterSecond.history.every((h) => h.actor.kind === 'import'));
    assert.ok(afterSecond.comments.every((c) => c.author.kind === 'import' && c.authorName));
    log(
      `Import: two runs, same counts (${Object.entries(seenOf(second))
        .map(([k, n]) => `${k} ${n}`)
        .join(', ')}), second run creates nothing, no duplicates`,
    );
    return { first, second, sizes };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
