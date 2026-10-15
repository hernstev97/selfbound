// Names for the tools: environment variables and per-user folders, with the XLR8 fallback.
// legacy-xlr8: this whole file tests the fallback, so every old name in it is deliberate.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { cacheDir, configDir, configFile, dataDir, envVar, envVarPair, resetEnvWarnings, stateDir } from '../lib/env.mjs';

const home = () => mkdtempSync(join(tmpdir(), 'selfbound-env-'));
const mkdirs = (...dirs) => dirs.forEach((d) => mkdirSync(d, { recursive: true }));

beforeEach(() => resetEnvWarnings());

describe('envVar', () => {
  it('prefers SELFBOUND_ and does not warn then', () => {
    const warnings = [];
    assert.equal(envVar('OWNER_IDS', { SELFBOUND_OWNER_IDS: 'new', XLR8_OWNER_IDS: 'old' }, (m) => warnings.push(m)), 'new');
    assert.deepEqual(warnings, []);
  });
  // legacy-xlr8: the fallback and its warning
  it('falls back to the old name and warns once per variable, without the value', () => {
    const warnings = [];
    const warn = (m) => warnings.push(m);
    const env = { XLR8_OWNER_IDS: 'secret-value', XLR8_APP_URL: 'x' };
    assert.equal(envVar('OWNER_IDS', env, warn), 'secret-value');
    assert.equal(envVar('OWNER_IDS', env, warn), 'secret-value');
    assert.equal(envVar('APP_URL', env, warn), 'x');
    assert.deepEqual(warnings, ['XLR8_OWNER_IDS is deprecated, set SELFBOUND_OWNER_IDS instead.', 'XLR8_APP_URL is deprecated, set SELFBOUND_APP_URL instead.']);
    assert.ok(!warnings.join().includes('secret-value'));
  });
  it('is undefined when neither is set; an empty new value still wins', () => {
    assert.equal(envVar('NOPE', {}), undefined);
    assert.equal(envVar('X', { SELFBOUND_X: '', XLR8_X: 'old' }), '');
  });
  it('handles full names that do not follow the prefix pattern', () => {
    const warnings = [];
    // legacy-xlr8: old Vite variable
    assert.equal(envVarPair('VITE_SELFBOUND_TEST', 'VITE_XLR8_TEST', { VITE_XLR8_TEST: '1' }, (m) => warnings.push(m)), '1');
    assert.deepEqual(warnings, ['VITE_XLR8_TEST is deprecated, set VITE_SELFBOUND_TEST instead.']);
    assert.equal(envVarPair('VITE_SELFBOUND_TEST', 'VITE_XLR8_TEST', { VITE_SELFBOUND_TEST: '0', VITE_XLR8_TEST: '1' }), '0');
  });
});

describe('folders', () => {
  it('use the new folder by default, honoring XDG_*', () => {
    const h = home();
    assert.equal(configDir({ env: {}, home: h }), join(h, '.config', 'selfbound'));
    assert.equal(dataDir({ env: {}, home: h }), join(h, '.local', 'share', 'selfbound'));
    assert.equal(stateDir({ env: {}, home: h, suffix: '-perf' }), join(h, '.local', 'state', 'selfbound-perf'));
    assert.equal(cacheDir({ env: {}, home: h, suffix: '-perf' }), join(h, '.cache', 'selfbound-perf'));
    assert.equal(configDir({ env: { XDG_CONFIG_HOME: '/x/cfg' }, home: h }), '/x/cfg/selfbound');
    assert.equal(dataDir({ env: { XDG_DATA_HOME: '/x/data' }, home: h }), '/x/data/selfbound');
    assert.equal(stateDir({ env: { XDG_STATE_HOME: '/x/state' }, home: h, suffix: '-perf' }), '/x/state/selfbound-perf');
    assert.equal(cacheDir({ env: { XDG_CACHE_HOME: '/x/cache' }, home: h, suffix: '-perf' }), '/x/cache/selfbound-perf');
  });
  // legacy-xlr8: the old folder as a fallback
  it('fall back to the old folder, with a warning, only while it is the only one', () => {
    const h = home();
    mkdirs(join(h, '.config', 'xlr8'), join(h, '.local', 'state', 'xlr8-perf'));
    const warnings = [];
    const warn = (m) => warnings.push(m);
    assert.equal(configDir({ env: {}, home: h, warn }), join(h, '.config', 'xlr8'));
    assert.equal(configDir({ env: {}, home: h, warn }), join(h, '.config', 'xlr8'));
    assert.equal(stateDir({ env: {}, home: h, warn, suffix: '-perf' }), join(h, '.local', 'state', 'xlr8-perf'));
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /deprecated/);
    mkdirs(join(h, '.config', 'selfbound'));
    assert.equal(configDir({ env: {}, home: h, warn }), join(h, '.config', 'selfbound'));
  });
  it('configFile decides per file, so a half-migrated folder still works', () => {
    const h = home();
    mkdirs(join(h, '.config', 'xlr8'), join(h, '.config', 'selfbound'));
    writeFileSync(join(h, '.config', 'xlr8', 'convex-deploy-key'), 'k');
    writeFileSync(join(h, '.config', 'xlr8', 'instance.json'), '{}');
    writeFileSync(join(h, '.config', 'selfbound', 'instance.json'), '{}');
    const warn = () => undefined;
    assert.equal(configFile('instance.json', { env: {}, home: h, warn }), join(h, '.config', 'selfbound', 'instance.json'));
    assert.equal(configFile('convex-deploy-key', { env: {}, home: h, warn }), join(h, '.config', 'xlr8', 'convex-deploy-key'));
    // Neither exists: the new path, so hints name the right place.
    assert.equal(configFile('linear-api-key', { env: {}, home: h, warn }), join(h, '.config', 'selfbound', 'linear-api-key'));
  });
});
