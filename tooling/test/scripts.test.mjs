// Shell scripts with stubbed systemctl/systemd-run, and the production build environment.
// legacy-xlr8: the old unit and variable names in this file test the clean-up and fallbacks and are deliberate.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { BLANKED_ENV, productionEnv } from '../deploy-web.mjs';
import { DEV_AUDIENCE, DEV_ISSUER, DEV_OWNER_ID } from '../dev-auth.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Folder with stub programs that append their arguments to <dir>/calls.log. */
function stubs(...names) {
  const dir = mkdtempSync(join(tmpdir(), 'selfbound-stubs-'));
  for (const name of names) {
    const body = name === 'systemctl' ? 'if [ "$2" = is-system-running ]; then echo running; fi' : '';
    writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${dir}/calls.log"\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return { dir, calls: () => (existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8') : '') };
}

describe('perf/idle/install.sh', () => {
  const setup = () => {
    const home = mkdtempSync(join(tmpdir(), 'selfbound-install-'));
    const units = join(home, '.config', 'systemd', 'user');
    mkdirSync(units, { recursive: true });
    // Worktree of main already present: nothing is fetched.
    mkdirSync(join(home, '.cache', 'selfbound-perf', 'main'), { recursive: true });
    writeFileSync(join(home, '.cache', 'selfbound-perf', 'main', '.git'), 'gitdir: x');
    const s = stubs('systemctl');
    const run = (...args) =>
      spawnSync('sh', [join(root, 'perf', 'idle', 'install.sh'), ...args], {
        env: { PATH: `${s.dir}:${process.env.PATH}`, HOME: home, XDG_CONFIG_HOME: '', XDG_CACHE_HOME: '', XDG_STATE_HOME: '' },
        encoding: 'utf8',
      });
    return { home, units, s, run };
  };

  it('installs the new units and replaces the old ones, saying so', () => {
    const { units, s, run } = setup();
    // legacy-xlr8: units of the old name
    writeFileSync(join(units, 'xlr8-perf-idle.timer'), '[Timer]');
    writeFileSync(join(units, 'xlr8-perf-idle.service'), '[Service]');
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(units, 'selfbound-perf-idle.timer')));
    assert.match(readFileSync(join(units, 'selfbound-perf-idle.service'), 'utf8'), /ExecStart=.*perf\/idle\.ts run/);
    assert.ok(!existsSync(join(units, 'xlr8-perf-idle.timer')));
    assert.ok(!existsSync(join(units, 'xlr8-perf-idle.service')));
    assert.match(r.stdout, /Removed old unit xlr8-perf-idle\.timer/);
    assert.match(r.stdout, /Installed selfbound-perf-idle\.timer/);
    assert.match(s.calls(), /systemctl --user disable --now xlr8-perf-idle\.timer/);
    assert.match(s.calls(), /systemctl --user enable --now selfbound-perf-idle\.timer/);
  });

  it('works without old units and --remove cleans up both names', () => {
    const { units, run } = setup();
    assert.equal(run().status, 0);
    assert.ok(!run().stdout.includes('Removed old unit'));
    writeFileSync(join(units, 'xlr8-perf-idle.timer'), '');
    const r = run('--remove');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(join(units, 'selfbound-perf-idle.timer')));
    assert.ok(!existsSync(join(units, 'xlr8-perf-idle.timer')));
  });
});

describe('tooling/quiet.sh', () => {
  const cpus = (env) => {
    const s = stubs('systemctl', 'systemd-run');
    const r = spawnSync('sh', [join(root, 'tooling', 'quiet.sh'), 'true'], { env: { PATH: `${s.dir}:${process.env.PATH}`, ...env }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return /AllowedCPUs=(\S+)/.exec(s.calls())?.[1];
  };
  it('reads the new variable names', () => {
    assert.equal(cpus({ SELFBOUND_QUIET_CPUS: '2-3' }), '2-3');
  });
  // legacy-xlr8: old names still work, the new one wins
  it('still reads the old names and prefers the new ones', () => {
    assert.equal(cpus({ XLR8_QUIET_CPUS: '1-2' }), '1-2');
    assert.equal(cpus({ XLR8_LEISE_CPUS: '0-1' }), '0-1');
    assert.equal(cpus({ XLR8_QUIET_CPUS: '1-2', SELFBOUND_QUIET_CPUS: '3-4' }), '3-4');
  });
});

describe('deploy-web build environment', () => {
  it('uses the Selfbound names and blanks the test variables under both names', () => {
    const env = productionEnv({ convexDeployment: 'happy-otter-123', appUrl: 'https://selfbound.example.com', clerkPublishableKey: 'pk_live_x' });
    assert.equal(env.SELFBOUND_PUBLIC_URL, 'https://selfbound.example.com');
    assert.equal(env.VITE_SELFBOUND_BRANCH_PREFIX, '');
    assert.equal(env.VITE_CONVEX_URL, 'https://happy-otter-123.convex.cloud');
    assert.deepEqual(Object.keys(env).filter((k) => /XLR8/i.test(k)), []);
    assert.deepEqual(Object.keys(BLANKED_ENV).sort(), ['VITE_DEV_TOKEN', 'VITE_SELFBOUND_TEST', 'VITE_XLR8_TEST']);
    assert.ok(Object.values(BLANKED_ENV).every((v) => v === ''));
  });
});

describe('dev sign-in', () => {
  it('uses the Selfbound issuer and audience', () => {
    assert.equal(DEV_ISSUER, 'https://dev.selfbound.local');
    assert.equal(DEV_AUDIENCE, 'selfbound-dev');
    assert.equal(DEV_OWNER_ID, 'https://dev.selfbound.local|owner');
  });
});
