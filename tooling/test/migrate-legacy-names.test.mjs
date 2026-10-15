// tooling/migrate-legacy-names.mjs against a fake Convex CLI and a temporary home. Never touches production.
// legacy-xlr8: the script migrates the old names, so every old name in this file is deliberate.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { convexEnv, localPaths, main, migrateConvexEnv, migrateLocalFiles, parseArgs, parseNames, planConfigFiles, planEnv, twinOf, vercelInstructions } from '../migrate-legacy-names.mjs';

const SECRET = 'sk_live_never_print_me';

/** In-memory Convex deployment behind the same runner interface as the real CLI. Records every call. */
function fakeConvex(initial) {
  const store = new Map(Object.entries(initial));
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const [group, action] = args;
    if (group !== 'env') return { status: 1, stdout: '' };
    if (action === 'list') return { status: 0, stdout: `${[...store.keys()].join('\n')}\n` };
    if (action === 'get') return store.has(args[2]) ? { status: 0, stdout: `${store.get(args[2])}\n` } : { status: 1, stdout: '' };
    if (action === 'set') {
      assert.equal(args[3], '--');
      store.set(args[2], args[4]);
      return { status: 0, stdout: '' };
    }
    if (action === 'remove') {
      store.delete(args[2]);
      return { status: 0, stdout: '' };
    }
    return { status: 1, stdout: '' };
  };
  return { store, calls, run, writes: () => calls.filter((c) => c[1] === 'set' || c[1] === 'remove') };
}

const collector = () => {
  const lines = [];
  return { lines, log: (l) => lines.push(l), text: () => lines.join('\n') };
};

describe('planEnv', () => {
  it('sorts old variables into copy, same, differs, empty', () => {
    const names = ['XLR8_A', 'XLR8_B', 'SELFBOUND_B', 'XLR8_C', 'SELFBOUND_C', 'XLR8_D', 'OTHER'];
    const values = new Map([['XLR8_A', '1'], ['XLR8_B', '2'], ['SELFBOUND_B', '2'], ['XLR8_C', '3'], ['SELFBOUND_C', 'x'], ['XLR8_D', '']]);
    const plan = planEnv(names, values);
    assert.deepEqual(plan.entries.map((e) => [e.old, e.state]), [['XLR8_A', 'copy'], ['XLR8_B', 'same'], ['XLR8_C', 'differs'], ['XLR8_D', 'empty']]);
    assert.deepEqual(plan.toCopy, ['XLR8_A']);
    assert.deepEqual(plan.toRemove, ['XLR8_B']);
    assert.deepEqual(plan.missingTwins, ['XLR8_A', 'XLR8_D']);
  });
  it('maps names and parses the CLI list', () => {
    assert.equal(twinOf('XLR8_OWNER_IDS'), 'SELFBOUND_OWNER_IDS');
    assert.equal(twinOf('CLERK_JWT_ISSUER_DOMAIN'), undefined);
    assert.deepEqual(parseNames('A\n  B_2 \n\nnot a name\n'), ['A', 'B_2']);
  });
});

describe('migrateConvexEnv', () => {
  const start = () => ({ XLR8_OWNER_IDS: SECRET, XLR8_APP_URL: 'https://x.example', SELFBOUND_APP_URL: 'https://x.example', XLR8_MCP_KEY: 'pk', SELFBOUND_MCP_KEY: 'other', CLERK_JWT_ISSUER_DOMAIN: 'https://c.example' });

  it('dry run reads but changes nothing', async () => {
    const f = fakeConvex(start());
    const out = collector();
    const r = await migrateConvexEnv({ convex: convexEnv(f.run), apply: false, removeOld: false, log: out.log });
    assert.equal(r.ok, true);
    assert.deepEqual(f.writes(), []);
    assert.match(out.text(), /XLR8_OWNER_IDS -> SELFBOUND_OWNER_IDS: would set/);
    assert.match(out.text(), /XLR8_APP_URL -> SELFBOUND_APP_URL: already set, same value/);
    assert.match(out.text(), /XLR8_MCP_KEY -> SELFBOUND_MCP_KEY: already set with a different value, kept/);
  });

  it('copies only missing twins with the identical value and never prints values', async () => {
    const f = fakeConvex(start());
    const out = collector();
    const r = await migrateConvexEnv({ convex: convexEnv(f.run), apply: true, removeOld: false, log: out.log });
    assert.deepEqual(r.copied, ['SELFBOUND_OWNER_IDS']);
    assert.equal(f.store.get('SELFBOUND_OWNER_IDS'), SECRET);
    assert.equal(f.store.get('SELFBOUND_MCP_KEY'), 'other', 'an existing twin is never overwritten');
    assert.equal(f.store.get('XLR8_OWNER_IDS'), SECRET, 'old variables stay');
    assert.ok(!out.text().includes(SECRET));
    assert.ok(!out.text().includes('https://x.example'));
    assert.deepEqual(f.writes().map((c) => c[2]), ['SELFBOUND_OWNER_IDS']);
  });

  it('passes values that start with a dash safely and verifies what it set', async () => {
    const f = fakeConvex({ XLR8_X: '-----BEGIN KEY-----\nabc' });
    const r = await migrateConvexEnv({ convex: convexEnv(f.run), apply: true, removeOld: false, log: () => undefined });
    assert.equal(r.ok, true);
    assert.equal(f.store.get('SELFBOUND_X'), '-----BEGIN KEY-----\nabc');
  });

  it('is idempotent', async () => {
    const f = fakeConvex(start());
    const convex = convexEnv(f.run);
    await migrateConvexEnv({ convex, apply: true, removeOld: false, log: () => undefined });
    const before = f.writes().length;
    const r = await migrateConvexEnv({ convex, apply: true, removeOld: false, log: () => undefined });
    assert.deepEqual(r.copied, []);
    assert.equal(f.writes().length, before);
  });

  it('fails and takes the wrong twin back when setting does not stick', async () => {
    const f = fakeConvex({ XLR8_X: 'v' });
    const lying = async (args) => f.run(args[1] === 'set' ? [...args.slice(0, 4), 'truncated'] : args);
    const out = collector();
    const r = await migrateConvexEnv({ convex: convexEnv(lying), apply: true, removeOld: true, log: out.log });
    assert.equal(r.ok, false);
    // Only the twin it created is removed again; the old variable stays.
    assert.deepEqual(f.calls.filter((c) => c[1] === 'remove'), [['env', 'remove', 'SELFBOUND_X']]);
    assert.ok(!f.store.has('SELFBOUND_X'));
    assert.ok(f.store.has('XLR8_X'));
  });

  it('--remove-old removes only old variables with an equal twin', async () => {
    const f = fakeConvex({ XLR8_A: '1', SELFBOUND_A: '1', XLR8_B: '2', SELFBOUND_B: 'different' });
    const out = collector();
    const r = await migrateConvexEnv({ convex: convexEnv(f.run), apply: true, removeOld: true, log: out.log });
    assert.equal(r.ok, true);
    assert.deepEqual(r.removed, ['XLR8_A']);
    assert.ok(!f.store.has('XLR8_A'));
    assert.ok(f.store.has('XLR8_B'));
    assert.ok(f.store.has('SELFBOUND_B'));
    assert.match(out.text(), /kept because the values differ.*XLR8_B/);
  });

  it('--remove-old refuses and removes nothing when a twin is missing', async () => {
    const f = fakeConvex({ XLR8_A: '1', SELFBOUND_A: '1', XLR8_B: '' });
    const r = await migrateConvexEnv({ convex: convexEnv(f.run), apply: true, removeOld: true, log: () => undefined });
    assert.equal(r.ok, false);
    assert.deepEqual(r.refused, ['XLR8_B']);
    assert.deepEqual(f.writes(), []);
  });

  it('--remove-old --apply copies first, then removes in one run', async () => {
    const f = fakeConvex({ XLR8_A: '1' });
    const r = await migrateConvexEnv({ convex: convexEnv(f.run), apply: true, removeOld: true, log: () => undefined });
    assert.equal(r.ok, true);
    assert.deepEqual([...f.store.entries()], [['SELFBOUND_A', '1']]);
  });

  it('--remove-old as a dry run says what is missing and changes nothing', async () => {
    const f = fakeConvex({ XLR8_A: '1', XLR8_B: '2', SELFBOUND_B: '2' });
    const out = collector();
    const r = await migrateConvexEnv({ convex: convexEnv(f.run), apply: false, removeOld: true, log: out.log });
    assert.equal(r.ok, false);
    assert.deepEqual(f.writes(), []);
    assert.match(out.text(), /run with --apply first/);
  });

  it('does nothing without old variables', async () => {
    const f = fakeConvex({ CLERK_JWT_ISSUER_DOMAIN: 'x' });
    const out = collector();
    const r = await migrateConvexEnv({ convex: convexEnv(f.run), apply: true, removeOld: true, log: out.log });
    assert.equal(r.ok, true);
    assert.match(out.text(), /nothing to do/);
  });

  it('does not mistake unexpected list output for an empty deployment', async () => {
    const odd = async () => ({ status: 0, stdout: `XLR8_X=${SECRET}\n` });
    await assert.rejects(migrateConvexEnv({ convex: convexEnv(odd), apply: true, removeOld: false, log: () => undefined }), (error) => {
      assert.ok(!error.message.includes(SECRET));
      return true;
    });
  });

  it('reports a failing CLI without its output', async () => {
    const failing = async () => ({ status: 3, stdout: SECRET });
    await assert.rejects(migrateConvexEnv({ convex: convexEnv(failing), apply: true, removeOld: false, log: () => undefined }), (error) => {
      assert.match(error.message, /exit 3/);
      assert.ok(!error.message.includes(SECRET));
      return true;
    });
  });
});

describe('local files', () => {
  const setup = () => {
    const home = mkdtempSync(join(tmpdir(), 'selfbound-migrate-'));
    const old = join(home, '.config', 'xlr8');
    mkdirSync(join(old, 'sub'), { recursive: true });
    writeFileSync(join(old, 'convex-deploy-key'), 'KEY', { mode: 0o600 });
    chmodSync(join(old, 'convex-deploy-key'), 0o600);
    writeFileSync(join(old, 'instance.json'), '{"a":1}');
    chmodSync(join(old, 'instance.json'), 0o644);
    writeFileSync(join(old, 'sub', 'note.txt'), 'n');
    return { home, old, paths: localPaths({ env: {}, home }) };
  };
  const modeOf = (p) => lstatSync(p).mode & 0o777;

  it('plans nothing without an old folder', () => {
    const home = mkdtempSync(join(tmpdir(), 'selfbound-migrate-'));
    assert.deepEqual(planConfigFiles(localPaths({ env: {}, home })), []);
  });

  it('dry run copies nothing', () => {
    const { paths } = setup();
    const out = collector();
    migrateLocalFiles({ paths, apply: false, log: out.log });
    assert.ok(!existsSync(paths.configNew));
    assert.match(out.text(), /would copy convex-deploy-key \(mode 600\)/);
  });

  it('copies with the same modes, keeps the old folder and does not print contents', () => {
    const { paths, old } = setup();
    const out = collector();
    migrateLocalFiles({ paths, apply: true, log: out.log });
    assert.equal(readFileSync(join(paths.configNew, 'convex-deploy-key'), 'utf8'), 'KEY');
    assert.equal(modeOf(join(paths.configNew, 'convex-deploy-key')), 0o600);
    assert.equal(modeOf(join(paths.configNew, 'instance.json')), 0o644);
    assert.equal(readFileSync(join(paths.configNew, 'sub', 'note.txt'), 'utf8'), 'n');
    assert.ok(existsSync(join(old, 'convex-deploy-key')), 'the old folder is not touched');
    assert.ok(!out.text().includes('KEY'));
  });

  it('never overwrites and is idempotent', () => {
    const { paths } = setup();
    mkdirSync(paths.configNew, { recursive: true });
    writeFileSync(join(paths.configNew, 'instance.json'), '{"new":true}');
    const out = collector();
    migrateLocalFiles({ paths, apply: true, log: out.log });
    assert.equal(readFileSync(join(paths.configNew, 'instance.json'), 'utf8'), '{"new":true}');
    assert.match(out.text(), /instance\.json already exists/);
    const before = readdirSync(paths.configNew).sort();
    migrateLocalFiles({ paths, apply: true, log: () => undefined });
    assert.deepEqual(readdirSync(paths.configNew).sort(), before);
  });

  it('only reports data, restore, state and cache folders', () => {
    const { home, paths } = setup();
    mkdirSync(join(home, '.local', 'share', 'xlr8', 'backups'), { recursive: true });
    mkdirSync(join(home, 'xlr8-restore'));
    const out = collector();
    migrateLocalFiles({ paths, apply: true, log: out.log });
    assert.match(out.text(), /\.local\/share\/xlr8 exists .*mv .*\.local\/share\/selfbound/);
    assert.match(out.text(), /xlr8-restore exists/);
    assert.ok(existsSync(join(home, '.local', 'share', 'xlr8', 'backups')));
    assert.ok(!existsSync(join(home, '.local', 'share', 'selfbound')));
  });

  it('honors XDG_CONFIG_HOME', () => {
    const paths = localPaths({ env: { XDG_CONFIG_HOME: '/x/cfg' }, home: '/h' });
    assert.equal(paths.configOld, '/x/cfg/xlr8');
    assert.equal(paths.configNew, '/x/cfg/selfbound');
  });
});

describe('command line', () => {
  it('parses flags', () => {
    assert.deepEqual(parseArgs(['--apply', '--remove-old']), { apply: true, removeOld: true, convex: true, files: true, help: false, unknown: [] });
    assert.equal(parseArgs(['--no-convex']).convex, false);
    assert.deepEqual(parseArgs(['--wat']).unknown, ['--wat']);
  });

  it('prints help and rejects unknown arguments', async () => {
    const out = collector();
    assert.equal(await main(['--help'], { log: out.log }), 0);
    assert.match(out.text(), /Usage: node tooling\/migrate-legacy-names\.mjs/);
    assert.equal(await main(['--wat'], { log: collector().log }), 2);
  });

  it('runs end to end against the fake CLI and prints the manual checklist', async () => {
    const home = mkdtempSync(join(tmpdir(), 'selfbound-migrate-'));
    mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(join(home, '.config', 'systemd', 'user', 'xlr8-perf-idle.timer'), '');
    const f = fakeConvex({ XLR8_OWNER_IDS: SECRET });
    const out = collector();
    const code = await main(['--apply'], { run: f.run, env: {}, home, log: out.log });
    assert.equal(code, 0);
    assert.equal(f.store.get('SELFBOUND_OWNER_IDS'), SECRET);
    assert.ok(!out.text().includes(SECRET));
    assert.match(out.text(), /perf\/idle\/install\.sh/);
    assert.match(out.text(), /Clerk dashboard/);
    assert.match(out.text(), /vercel env ls/);
  });

  it('exits 1 when --remove-old refuses', async () => {
    const f = fakeConvex({ XLR8_A: '1' });
    const code = await main(['--remove-old'], { run: f.run, env: {}, home: mkdtempSync(join(tmpdir(), 'selfbound-migrate-')), log: () => undefined });
    assert.equal(code, 1);
    assert.deepEqual(f.writes(), []);
  });

  it('tells which Vercel variables to rename without calling Vercel', () => {
    const text = vercelInstructions().join('\n');
    assert.match(text, /vercel env rm VITE_XLR8_TEST production/);
    assert.match(text, /vercel env add SELFBOUND_PUBLIC_URL production/);
  });
});
