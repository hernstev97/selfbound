// Setup script: value checks, the plan for Convex variables, and whole runs against fake Convex and Clerk.
// No real accounts: the Convex CLI, the network and the terminal are stubs.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { clerkIssuer, foreignOwners, instanceChanges, issuersOf, normalizeAppUrl, normalizeDeployment, ownerCandidates, parseArgs, planEnv, setup } from '../setup.mjs';

const ISSUER = 'https://clerk.selfbound.example.com';
// Clerk writes the keys without base64 padding.
const pk = (kind, host) => `pk_${kind}_${Buffer.from(`${host}$`).toString('base64').replace(/=+$/, '')}`;
const PK = pk('live', 'clerk.selfbound.example.com');
const PK_DEV = pk('test', 'happy-cat-12.clerk.accounts.dev');
const DEPLOYMENT = 'happy-otter-123';
const KEY = `prod:${DEPLOYMENT}|fake-key-for-tests`;

describe('values', () => {
  it('takes a deployment name or its URL', () => {
    assert.equal(normalizeDeployment('happy-otter-123'), DEPLOYMENT);
    assert.equal(normalizeDeployment(' https://happy-otter-123.convex.cloud/ '), DEPLOYMENT);
    assert.equal(normalizeDeployment('https://happy-otter-123.convex.site'), DEPLOYMENT);
    for (const bad of ['', 'Happy Otter', 'otter', 'https://example.com/x']) assert.equal(normalizeDeployment(bad), undefined, bad);
  });
  it('takes an https origin as app address', () => {
    assert.equal(normalizeAppUrl('https://selfbound.example.com/'), 'https://selfbound.example.com');
    for (const bad of ['http://selfbound.example.com', 'https://selfbound.example.com/app', 'selfbound.example.com', 'https://x.example/?a=1']) assert.equal(normalizeAppUrl(bad), undefined, bad);
  });
  it('reads the issuer out of a publishable key, also from a host list', () => {
    assert.equal(clerkIssuer(PK), ISSUER);
    assert.equal(clerkIssuer(PK_DEV), 'https://happy-cat-12.clerk.accounts.dev');
    assert.equal(clerkIssuer(`${PK}==`), ISSUER, 'with padding');
    assert.equal(clerkIssuer('pk_live_REPLACE_ME'), undefined);
    assert.equal(clerkIssuer('sk_live_abc'), undefined);
    assert.deepEqual(issuersOf(`a.example=${PK},b.example=${PK_DEV}`), [ISSUER, 'https://happy-cat-12.clerk.accounts.dev']);
    assert.equal(issuersOf(`${PK},pk_live_nope`), undefined);
  });
  it('finds owner entries of another issuer', () => {
    assert.deepEqual(foreignOwners(`${ISSUER}|user_1, ${ISSUER}/|user_2`, [ISSUER]), [`${ISSUER}/|user_2`]);
  });
  it('lists Clerk users oldest first with their primary address', () => {
    const users = ownerCandidates([
      { id: 'user_b', created_at: 20, primary_email_address_id: 'e2', email_addresses: [{ id: 'e1', email_address: 'other@example.com' }, { id: 'e2', email_address: 'b@example.com' }] },
      { id: 'user_a', created_at: 10, first_name: 'Ada', email_addresses: [] },
      { id: 'not-a-user' },
    ]);
    assert.deepEqual(users.map((u) => [u.id, u.email, u.name]), [['user_a', '', 'Ada'], ['user_b', 'b@example.com', '']]);
  });
  it('reports only fields that change', () => {
    assert.deepEqual(instanceChanges({ appUrl: 'https://a.example', mcpHosts: [] }, { appUrl: 'https://a.example', mcpHosts: [], convexDeployment: DEPLOYMENT }), [['convexDeployment', undefined, DEPLOYMENT]]);
  });
  it('parses the options', () => {
    assert.deepEqual(parseArgs(['--dry-run', '--only', 'owner,env']).steps, ['env', 'owner']);
    assert.throws(() => parseArgs(['--only', 'everything']), /--only takes steps/);
    assert.throws(() => parseArgs(['--force']), /Unknown option/);
  });
});

describe('planEnv', () => {
  const wanted = [
    { name: 'CLERK_JWT_ISSUER_DOMAIN', value: ISSUER, contains: true },
    { name: 'SELFBOUND_DEV_JWKS', value: 'none' },
    { name: 'SELFBOUND_APP_URL', value: 'https://selfbound.example.com' },
  ];
  const status = (current) => planEnv(new Map(Object.entries(current)), wanted).map((p) => `${p.name}:${p.status}:${p.via ?? '-'}`);
  it('sets what is missing and keeps what matches', () => {
    assert.deepEqual(status({ SELFBOUND_DEV_JWKS: 'none' }), ['CLERK_JWT_ISSUER_DOMAIN:set:-', 'SELFBOUND_DEV_JWKS:ok:SELFBOUND_DEV_JWKS', 'SELFBOUND_APP_URL:set:-']);
  });
  it('accepts an issuer list that contains the wanted issuer (Clerk domain move)', () => {
    assert.equal(status({ CLERK_JWT_ISSUER_DOMAIN: `https://clerk.old.example,${ISSUER}` })[0], 'CLERK_JWT_ISSUER_DOMAIN:ok:CLERK_JWT_ISSUER_DOMAIN');
    assert.equal(status({ CLERK_JWT_ISSUER_DOMAIN: 'https://clerk.old.example' })[0], 'CLERK_JWT_ISSUER_DOMAIN:differs:CLERK_JWT_ISSUER_DOMAIN');
  });
  // legacy-xlr8: the old variable names count as set
  it('counts a value under the old XLR8_ name, the new name wins', () => {
    assert.equal(status({ XLR8_APP_URL: 'https://selfbound.example.com' })[2], 'SELFBOUND_APP_URL:ok:XLR8_APP_URL');
    assert.equal(status({ XLR8_APP_URL: 'https://old.example', SELFBOUND_APP_URL: 'https://selfbound.example.com' })[2], 'SELFBOUND_APP_URL:ok:SELFBOUND_APP_URL');
  });
});

/** A fake production deployment: env variables in a Map, every CLI call recorded. */
function fakeConvex(initial = {}) {
  const env = new Map(Object.entries(initial));
  const calls = [];
  const convex = async (args, input) => {
    calls.push([...args, ...(input === undefined ? [] : [`<stdin:${input}>`])]);
    const [cmd, sub, name] = args;
    if (cmd !== 'env') return { code: 1, stdout: '', stderr: 'unexpected' };
    if (sub === 'list') return { code: 0, stdout: [...env.keys()].map((k) => `${k}\n`).join(''), stderr: '' };
    if (sub === 'get') return env.has(name) ? { code: 0, stdout: `${env.get(name)}\n`, stderr: '' } : { code: 1, stdout: '', stderr: 'not found' };
    if (sub === 'set') return env.set(name, input), { code: 0, stdout: '', stderr: '' };
    if (sub === 'remove') return env.delete(name), { code: 0, stdout: '', stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { env, calls, convex, writes: () => calls.filter(([, sub]) => sub === 'set' || sub === 'remove') };
}

/** Network stub: Clerk's discovery, Clerk's user list, /health and the app. */
function fakeFetch({ users = [{ id: 'user_owner1', created_at: 1, primary_email_address_id: 'e', email_addresses: [{ id: 'e', email_address: 'me@example.com' }] }] } = {}) {
  const seen = [];
  const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
  const fetch = async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers ?? {} });
    if (url === `${ISSUER}/.well-known/openid-configuration`) return json({ issuer: ISSUER });
    if (url === `${ISSUER}/.well-known/jwks.json`) return json({ keys: [{ kid: 'ins_this' }] });
    if (url === 'https://api.clerk.com/v1/jwks') return json({ keys: [{ kid: init.headers.authorization === 'Bearer sk_live_other' ? 'ins_other' : 'ins_this' }] });
    if (String(url).startsWith('https://api.clerk.com/v1/users')) return init.headers.authorization === 'Bearer sk_live_fake' ? json(users) : json(OTHER_USERS);
    if (url === `https://${DEPLOYMENT}.convex.site/health`) return json({ ok: true, clerk: true, devAuth: false, local: false });
    if (url === 'https://selfbound.example.com/version.json') return json({ version: 'x' });
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch, seen };
}

/** Terminal stub: answers in order; secrets come from their own list. */
function fakeIo({ answers = [], secrets = [], confirms = [] } = {}) {
  const asked = [];
  // A step that asks again and again would hang the test: stop it.
  const note = (q) => {
    asked.push(q);
    if (asked.length > 50) throw new Error(`asked too often, last: ${q}`);
  };
  return {
    asked,
    io: {
      ask: async (q, fallback) => (note(q), answers.length ? answers.shift() || fallback : fallback),
      confirm: async (q, yes) => (note(q), confirms.length ? confirms.shift() : yes),
      secret: async (q) => (note(q), secrets.shift() ?? ''),
    },
  };
}

function workspace({ instance, key = KEY } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'selfbound-setup-'));
  const instanceFile = join(dir, 'instance.json');
  const keyFile = join(dir, 'config', 'convex-deploy-key');
  if (instance) writeFileSync(instanceFile, JSON.stringify(instance));
  if (key) {
    mkdirSync(join(dir, 'config'));
    writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
  }
  return { dir, instanceFile, keyFile };
}

const OTHER_USERS = [{ id: 'user_stranger', created_at: 1, email_addresses: [] }];
const COMPLETE = { convexDeployment: DEPLOYMENT, appUrl: 'https://selfbound.example.com', clerkPublishableKey: PK, vercelProject: 'selfbound', vercelScope: 'jane' };

async function run(argv, { ws, convex, fetch, io, ran = [] }) {
  const lines = [];
  const code = await setup(argv, {
    io: io.io,
    convex: convex.convex,
    fetch: fetch.fetch,
    run: async (cmd, args) => (ran.push([cmd, ...args].join(' ')), 0),
    has: () => true,
    log: (l) => lines.push(l),
    env: {},
    instanceFile: ws.instanceFile,
    keyFile: ws.keyFile,
  });
  return { code, out: lines.join('\n'), ran };
}

describe('setup run', () => {
  it('dry run asks, checks and shows the plan, but writes, sets and deploys nothing', async () => {
    const ws = workspace({ key: null });
    const convex = fakeConvex();
    const fetch = fakeFetch();
    const io = fakeIo({ answers: [`https://${DEPLOYMENT}.convex.cloud`, 'https://selfbound.example.com/', PK, 'selfbound', 'jane'] });
    const { code, out, ran } = await run(['--dry-run', '--only', 'instance,key,env,owner,backend,web'], { ws, convex, fetch, io });
    assert.equal(code, 0, out);
    assert.ok(!existsSync(ws.instanceFile), 'instance file written');
    assert.ok(!existsSync(ws.keyFile), 'key file written');
    assert.deepEqual(convex.calls, []);
    assert.deepEqual(ran, []);
    assert.match(out, /\(dry run\) would set convexDeployment: "happy-otter-123"/);
    assert.match(out, /\(dry run\) would set CLERK_JWT_ISSUER_DOMAIN = https:\/\/clerk\.selfbound\.example\.com/);
    assert.match(out, /\(dry run\) would deploy the backend/);
    assert.match(out, /Dry run: nothing was changed/);
  });

  it('sets up a fresh instance, then a second run changes nothing', async () => {
    const ws = workspace({ instance: { ...COMPLETE, mcpHosts: [] } });
    const convex = fakeConvex();
    const fetch = fakeFetch();
    const first = await run([], { ws, convex, fetch, io: fakeIo({ secrets: ['sk_live_fake'], confirms: [true, true, true, true, false] }) });
    assert.equal(first.code, 0, first.out);
    assert.deepEqual(Object.fromEntries(convex.env), {
      CLERK_JWT_ISSUER_DOMAIN: ISSUER,
      SELFBOUND_DEV_JWKS: 'none',
      SELFBOUND_APP_URL: 'https://selfbound.example.com',
      SELFBOUND_OWNER_IDS: `${ISSUER}|user_owner1`,
    });
    assert.ok(first.ran.some((c) => c.endsWith('tooling/cloud.mjs deploy')), first.ran.join('\n'));
    assert.ok(first.ran.some((c) => c.endsWith('tooling/deploy-web.mjs')), first.ran.join('\n'));
    assert.match(first.out, /Sign-up mode → Restricted/);
    // The secret key goes only to Clerk, with a generic user agent, and is never printed.
    const clerk = fetch.seen.find((r) => r.url.startsWith('https://api.clerk.com/'));
    assert.equal(clerk.headers['user-agent'], 'selfbound-setup');
    assert.ok(!first.out.includes('sk_live_fake'));
    assert.ok(!first.out.includes('fake-key-for-tests'));

    const before = convex.writes().length;
    const second = await run(['--yes'], { ws, convex, fetch, io: fakeIo() });
    assert.equal(second.code, 0, second.out);
    assert.equal(convex.writes().length, before, 'second run set variables');
    assert.match(second.out, /SELFBOUND_OWNER_IDS has 1 owner/);
  });

  it('keeps a different existing value unless you agree, and never with --yes', async () => {
    const ws = workspace({ instance: COMPLETE });
    const convex = fakeConvex({ CLERK_JWT_ISSUER_DOMAIN: 'https://clerk.other.example', SELFBOUND_DEV_JWKS: 'none', SELFBOUND_APP_URL: 'https://selfbound.example.com', SELFBOUND_OWNER_IDS: `${ISSUER}|user_x` });
    const kept = await run(['--yes', '--only', 'env'], { ws, convex, fetch: fakeFetch(), io: fakeIo() });
    assert.equal(kept.code, 0, kept.out);
    assert.equal(convex.env.get('CLERK_JWT_ISSUER_DOMAIN'), 'https://clerk.other.example');
    assert.match(kept.out, /kept CLERK_JWT_ISSUER_DOMAIN/);
    const replaced = await run(['--only', 'env'], { ws, convex, fetch: fakeFetch(), io: fakeIo({ confirms: [true] }) });
    assert.equal(replaced.code, 0, replaced.out);
    assert.equal(convex.env.get('CLERK_JWT_ISSUER_DOMAIN'), ISSUER);
  });

  it('offers to remove test switches (--yes only warns) and warns about owners of another issuer', async () => {
    const ws = workspace({ instance: COMPLETE });
    const convex = fakeConvex({ CLERK_JWT_ISSUER_DOMAIN: ISSUER, SELFBOUND_DEV_JWKS: 'none', SELFBOUND_APP_URL: 'https://selfbound.example.com', SELFBOUND_ALLOW_SEED: '1', SELFBOUND_OWNER_IDS: 'https://clerk.selfbound.example.com/|user_x' });
    const warned = await run(['--yes', '--only', 'env,owner'], { ws, convex, fetch: fakeFetch(), io: fakeIo() });
    assert.equal(warned.code, 0, warned.out);
    assert.ok(convex.env.has('SELFBOUND_ALLOW_SEED'));
    assert.match(warned.out, /SELFBOUND_ALLOW_SEED is set/);
    assert.match(warned.out, /does not start with https:\/\/clerk\.selfbound\.example\.com\|/);
    const removed = await run(['--only', 'env'], { ws, convex, fetch: fakeFetch(), io: fakeIo({ confirms: [true] }) });
    assert.equal(removed.code, 0, removed.out);
    assert.ok(!convex.env.has('SELFBOUND_ALLOW_SEED'));
  });

  it('refuses a Clerk secret key of another instance', async () => {
    const ws = workspace({ instance: COMPLETE });
    const convex = fakeConvex({ CLERK_JWT_ISSUER_DOMAIN: ISSUER });
    const { code, out } = await run(['--only', 'owner'], { ws, convex, fetch: fakeFetch(), io: fakeIo({ secrets: ['sk_live_other', 'sk_live_fake'] }) });
    assert.equal(code, 0, out);
    assert.match(out, /belongs to another Clerk instance/);
    assert.equal(convex.env.get('SELFBOUND_OWNER_IDS'), `${ISSUER}|user_owner1`);
  });

  it('lets you pick among several Clerk users or type the user id', async () => {
    const ws = workspace({ instance: COMPLETE });
    const users = [
      { id: 'user_second', created_at: 2, email_addresses: [] },
      { id: 'user_first', created_at: 1, email_addresses: [] },
    ];
    const picked = fakeConvex({ CLERK_JWT_ISSUER_DOMAIN: ISSUER });
    const one = await run(['--only', 'owner'], { ws, convex: picked, fetch: fakeFetch({ users }), io: fakeIo({ secrets: ['sk_live_fake'], answers: ['2'] }) });
    assert.equal(one.code, 0, one.out);
    assert.equal(picked.env.get('SELFBOUND_OWNER_IDS'), `${ISSUER}|user_second`);
    assert.match(one.out, /1\. user_first/);

    const typed = fakeConvex();
    const two = await run(['--only', 'owner'], { ws, convex: typed, fetch: fakeFetch(), io: fakeIo({ secrets: [''], answers: ['nope', 'user_typed1'] }) });
    assert.equal(two.code, 0, two.out);
    assert.equal(typed.env.get('SELFBOUND_OWNER_IDS'), `${ISSUER}|user_typed1`);
    assert.match(two.out, /Not valid: it starts with user_/);
  });

  it('stores a pasted deploy key with mode 600 and refuses one of another deployment', async () => {
    const ws = workspace({ instance: COMPLETE, key: null });
    const { code, out } = await run(['--only', 'key'], { ws, convex: fakeConvex(), fetch: fakeFetch(), io: fakeIo({ secrets: ['prod:other-deploy-1|x', KEY] }) });
    assert.equal(code, 0, out);
    assert.match(out, /not a production deploy key of happy-otter-123/);
    assert.equal(readFileSync(ws.keyFile, 'utf8').trim(), KEY);
    assert.equal(statSync(ws.keyFile).mode & 0o777, 0o600);
    assert.ok(!out.includes('fake-key-for-tests'));
  });

  it('refuses a deploy key file that others can read', async () => {
    const ws = workspace({ instance: COMPLETE });
    chmodSync(ws.keyFile, 0o644);
    const { code, out } = await run(['--only', 'key'], { ws, convex: fakeConvex(), fetch: fakeFetch(), io: fakeIo() });
    assert.equal(code, 2);
    assert.match(out, /readable by others \(mode 644\)/);
  });

  it('stops with a hint when a value is missing in --yes mode', async () => {
    const ws = workspace({ instance: { appUrl: 'https://selfbound.example.com' } });
    const { code, out } = await run(['--yes', '--only', 'instance'], { ws, convex: fakeConvex(), fetch: fakeFetch(), io: fakeIo() });
    assert.equal(code, 2);
    assert.match(out, /Stopped: Convex production deployment .*no valid value/);
  });
});
