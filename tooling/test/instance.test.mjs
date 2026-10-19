// Instance settings: new variable names first, old ones as a fallback.
// legacy-xlr8: the old names in this file test the fallback and are deliberate.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { instanceFile, loadInstance } from '../instance.mjs';
import { resetEnvWarnings } from '../lib/env.mjs';

const file = (json) => {
  const path = join(mkdtempSync(join(tmpdir(), 'selfbound-instance-')), 'instance.json');
  writeFileSync(path, JSON.stringify(json));
  return path;
};

beforeEach(() => resetEnvWarnings());

describe('loadInstance', () => {
  it('reads the file and lets SELFBOUND_* variables override it', () => {
    const path = file({ convexDeployment: 'from-file', appUrl: 'https://file.example/', mcpHosts: ['a.example'], branchPrefix: 'jane' });
    const instance = loadInstance({ SELFBOUND_APP_URL: 'https://env.example/', SELFBOUND_REDIRECT_HOSTS: 'x.example, y.example' }, path);
    assert.equal(instance.convexDeployment, 'from-file');
    assert.equal(instance.appUrl, 'https://env.example');
    assert.deepEqual(instance.mcpHosts, ['a.example']);
    assert.deepEqual(instance.redirectHosts, ['x.example', 'y.example']);
    assert.equal(instance.branchPrefix, 'jane');
  });
  it('reads sourceUrl from the file or SELFBOUND_SOURCE_URL, without an old name', () => {
    const path = file({ sourceUrl: 'https://git.example.org/fork' });
    assert.equal(loadInstance({}, path).sourceUrl, 'https://git.example.org/fork');
    assert.equal(loadInstance({ SELFBOUND_SOURCE_URL: 'https://env.example/fork' }, path).sourceUrl, 'https://env.example/fork');
    assert.equal(loadInstance({ XLR8_SOURCE_URL: 'https://old.example/fork' }, file({})).sourceUrl, undefined);
  });
  // legacy-xlr8: the old names keep working until the follow-up removes them
  it('still reads the old variable names, the new ones win', (t) => {
    t.mock.method(console, 'warn', () => undefined);
    const path = file({});
    const old = { XLR8_CONVEX_DEPLOYMENT: 'old-123', XLR8_SITE_URL: 'https://old.example/', XLR8_MCP_HOSTS: 'mcp.old.example', VITE_XLR8_BRANCH_PREFIX: 'old' };
    const instance = loadInstance(old, path);
    assert.equal(instance.convexDeployment, 'old-123');
    assert.equal(instance.siteUrl, 'https://old.example');
    assert.deepEqual(instance.mcpHosts, ['mcp.old.example']);
    assert.equal(instance.branchPrefix, 'old');
    const mixed = loadInstance({ ...old, SELFBOUND_CONVEX_DEPLOYMENT: 'new-123', VITE_SELFBOUND_BRANCH_PREFIX: 'new' }, path);
    assert.equal(mixed.convexDeployment, 'new-123');
    assert.equal(mixed.branchPrefix, 'new');
  });
});

describe('instanceFile', () => {
  it('prefers deploy/instance.json, then the user file, else the local path', () => {
    const local = instanceFile(() => true);
    assert.match(local, /deploy[\\/]instance\.json$/);
    assert.equal(instanceFile((p) => p === '/u/instance.json', () => '/u/instance.json'), '/u/instance.json');
    assert.equal(instanceFile(() => false, () => '/u/instance.json'), local);
  });
});
