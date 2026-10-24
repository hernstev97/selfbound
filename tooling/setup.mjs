#!/usr/bin/env node
// Guided setup of your own Selfbound instance (Convex + Clerk + a static host): asks for the values,
// checks them, writes the instance settings, stores the deploy key, sets the Convex environment
// variables, makes your Clerk user the owner and deploys backend and web app.
// Safe to run again: every step reads what is there first and changes only what differs.
// Guide: docs/self-hosting.md and https://docs.selfbound.kiumu.app/start/self-hosting/setup-script/
//
// Usage:  node tooling/setup.mjs                    asks step by step
//         node tooling/setup.mjs --dry-run          shows what it would change, changes and deploys nothing
//         … --yes                                   no questions: keeps existing values, takes the defaults
//         … --only env,owner                        some steps only: tools, instance, key, env, owner,
//                                                   backend, web, push
//
// Secrets are read hidden and never printed: the Convex deploy key goes to
// ~/.config/selfbound/convex-deploy-key (mode 600, see tooling/cloud.mjs); the Clerk secret key is only
// used to look up your user id and is not stored anywhere.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { deployKeyDeployment, deployKeyFile, readDeployKey, runCloud } from './cloud.mjs';
import { instanceFile, loadInstance } from './instance.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const STEPS = ['tools', 'instance', 'key', 'env', 'owner', 'backend', 'web', 'push'];
const USER_AGENT = 'selfbound-setup';

// ---- Values: parse and check (pure, tested in tooling/test/setup.test.mjs) ------------------------

/** Deployment name from a name or a Convex URL ("https://happy-otter-123.convex.cloud"), else undefined. */
export function normalizeDeployment(input) {
  const value = String(input ?? '').trim().replace(/^https?:\/\//, '').replace(/\.convex\.(cloud|site)\/?$/, '');
  return /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(value) ? value : undefined;
}

/** Origin of an https URL without path ("https://selfbound.example.com"), else undefined. */
export function normalizeAppUrl(input) {
  try {
    const url = new URL(String(input ?? '').trim());
    if (url.protocol !== 'https:' || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** The keys in `clerkPublishableKey`: one key, or "host=key,host2=key2" during a Clerk domain move. */
export const publishableKeys = (value) =>
  String(value ?? '')
    .split(',')
    // "host=pk_…": the key follows the first "=" (a key itself may end in base64 padding).
    .map((part) => part.trim())
    .map((part) => (part.startsWith('pk_') ? part : part.slice(part.indexOf('=') + 1).trim()))
    .filter(Boolean);

/** Clerk Frontend API URL (the token issuer) encoded in a publishable key: pk_live_ + base64("host$"). */
export function clerkIssuer(key) {
  const match = /^pk_(?:live|test)_([A-Za-z0-9+/=_-]+)$/.exec(String(key ?? '').trim());
  if (!match) return undefined;
  const host = Buffer.from(match[1], 'base64').toString('utf8').replace(/\$$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) ? `https://${host.toLowerCase()}` : undefined;
}

/** All issuers of a `clerkPublishableKey` value, or undefined if one key is not a valid publishable key. */
export function issuersOf(value) {
  const keys = publishableKeys(value);
  const issuers = keys.map(clerkIssuer);
  return keys.length && issuers.every(Boolean) ? [...new Set(issuers)] : undefined;
}

const list = (value) =>
  String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Compares the wanted Convex variables with the deployment's. `current` maps names to values.
 * legacy-xlr8: a SELFBOUND_ name also counts when only its old XLR8_ name is set (the backend reads it).
 * Status: `ok` same value, `set` missing, `differs` another value (only replaced after asking).
 * `contains`: list variables (issuers, owners) are fine when they contain every wanted entry.
 * @param {Map<string, string>} current
 * @param {{ name: string, value: string, contains?: boolean }[]} wanted
 */
export function planEnv(current, wanted) {
  return wanted.map(({ name, value, contains }) => {
    // legacy-xlr8: old variable name, read until the follow-up removes the fallback
    const legacyName = name.startsWith('SELFBOUND_') ? `XLR8_${name.slice('SELFBOUND_'.length)}` : undefined;
    const via = current.has(name) ? name : legacyName && current.has(legacyName) ? legacyName : undefined;
    const now = via ? current.get(via) : undefined;
    const same = now !== undefined && (contains ? list(value).every((v) => list(now).includes(v)) : now === value);
    const status = now === undefined || now === '' ? 'set' : same ? 'ok' : 'differs';
    return { name, value, current: now, via, status };
  });
}

/** Variables that must never be set in production (test data and test switches). */
// legacy-xlr8: the old names are checked too
export const FORBIDDEN_ENV = ['SELFBOUND_ALLOW_SEED', 'SELFBOUND_TEST_SWITCHES', 'XLR8_ALLOW_SEED', 'XLR8_TEST_SWITCHES'];

/** Owner entries whose issuer is none of `issuers`: the classic cause of an empty app after sign-in. */
export const foreignOwners = (ownerIds, issuers) => list(ownerIds).filter((id) => !issuers.some((issuer) => id.startsWith(`${issuer}|`)));

/** Users from Clerk's GET /v1/users, oldest first: the first user is the owner candidate. */
export function ownerCandidates(users) {
  return (Array.isArray(users) ? users : [])
    .filter((u) => typeof u?.id === 'string' && u.id.startsWith('user_'))
    .map((u) => {
      const primary = u.email_addresses?.find((e) => e.id === u.primary_email_address_id) ?? u.email_addresses?.[0];
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || '';
      return { id: u.id, email: primary?.email_address ?? '', name, createdAt: Number(u.created_at) || 0 };
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Fields of the instance file that change, as [field, from, to]. */
export function instanceChanges(before, after) {
  return Object.entries(after)
    .filter(([key, value]) => value !== undefined && JSON.stringify(before[key]) !== JSON.stringify(value))
    .map(([key, value]) => [key, before[key], value]);
}

// ---- Terminal --------------------------------------------------------------------------------------

/** Questions on the terminal. Hidden input for secrets; without a terminal, lines are read from stdin. */
export function terminal({ input = process.stdin, output = process.stdout } = {}) {
  let rl;
  let ended;
  const lines = () => {
    if (rl) return rl;
    rl = createInterface({ input, output, terminal: !!input.isTTY });
    ended = new Promise((_, reject) => rl.once('close', () => reject(new SetupError('Input ended before the setup was finished.'))));
    ended.catch(() => {});
    return rl;
  };
  // Input that ends (Ctrl+D, a short pipe) stops the setup instead of leaving a question open.
  const question = (text) => Promise.race([lines().question(text), ended]).then((answer) => answer.trim());
  return {
    async ask(text, fallback = '') {
      return (await question(`${text}${fallback ? ` [${fallback}]` : ''}: `)) || fallback;
    },
    async confirm(text, yes = true) {
      const answer = (await question(`${text} ${yes ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
      return answer ? answer.startsWith('y') || answer.startsWith('j') : yes;
    },
    async secret(text) {
      const r = lines();
      // Hide what is typed or pasted: echo nothing until Enter.
      const write = r._writeToOutput;
      output.write(`${text}: `);
      r._writeToOutput = (chunk) => (chunk.includes('\n') ? output.write('\n') : undefined);
      try {
        return await question('');
      } finally {
        r._writeToOutput = write;
      }
    },
    close: () => rl?.close(),
  };
}

// ---- Steps -----------------------------------------------------------------------------------------

const say = (ctx, text = '') => ctx.log(text);
const shownPath = (file) => (file.startsWith(`${root}/`) ? relative(root, file) : file);
const ok = (ctx, text) => ctx.log(`  ✓ ${text}`);
const todo = (ctx, text) => ctx.log(`  → ${text}`);
const warn = (ctx, text) => ctx.log(`  ! ${text}`);
const would = (ctx, text) => ctx.log(`  ${ctx.dryRun ? '(dry run) would ' : ''}${text}`);

/** Asks for a value until `check` accepts it; with --yes takes the current one (or fails). */
async function askValue(ctx, question, current, check, hint) {
  if (ctx.yes) {
    const value = check(current);
    if (value === undefined) throw new SetupError(`${question}: no valid value (${hint}). Run without --yes or set it in the instance file.`);
    return value;
  }
  for (;;) {
    const value = check(await ctx.io.ask(question, current ?? ''));
    if (value !== undefined) return value;
    warn(ctx, `Not valid: ${hint}.`);
  }
}

const confirm = (ctx, question, yes = true) => (ctx.yes ? Promise.resolve(yes) : ctx.io.confirm(question, yes));

export class SetupError extends Error {}

async function stepTools(ctx) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) warn(ctx, `Node.js ${process.versions.node}: Selfbound expects Node.js 24 (package.json → engines).`);
  else ok(ctx, `Node.js ${process.versions.node}`);
  if (!ctx.has('pnpm')) throw new SetupError('pnpm is missing. Run `corepack enable` (it provides the pinned version), then `pnpm install`.');
  if (!existsSync(join(root, 'backend', 'node_modules', '.bin', 'convex'))) throw new SetupError('Dependencies are missing. Run `pnpm install` first.');
  ok(ctx, 'pnpm and dependencies');
}

async function stepInstance(ctx) {
  const file = ctx.instanceFile;
  const before = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const now = ctx.instance;
  say(ctx, `  Settings file: ${shownPath(file)}`);
  const convexDeployment = await askValue(
    ctx,
    'Convex production deployment (name like happy-otter-123, or its URL)',
    now.convexDeployment,
    normalizeDeployment,
    'Convex dashboard → your project → Production; the name looks like happy-otter-123',
  );
  const appUrl = await askValue(ctx, 'Address of the app', now.appUrl, normalizeAppUrl, 'an https:// address without a path, e.g. https://selfbound.example.com');
  const clerkPublishableKey = await askValue(
    ctx,
    'Clerk publishable key (pk_live_… or pk_test_…)',
    now.clerkPublishableKey,
    (v) => (issuersOf(v) ? String(v).trim() : undefined),
    'Clerk dashboard → Configure → API keys; it starts with pk_live_ or pk_test_',
  );
  // --yes never decides the hosting: without a Vercel project in the settings it builds for another host.
  const vercel = now.vercelProject ? true : ctx.yes ? false : await ctx.io.confirm('Host the web app on Vercel (the repository ships a deploy script for it)?', true);
  const hosting = {};
  if (vercel) {
    hosting.vercelProject = await askValue(ctx, 'Vercel project name', now.vercelProject ?? 'selfbound', (v) => (/^[a-z0-9._-]{1,100}$/.test(String(v ?? '').trim()) ? String(v).trim() : undefined), 'lower-case letters, digits, . _ -');
    hosting.vercelScope = await askValue(ctx, 'Vercel team or account slug (vercel teams ls)', now.vercelScope, (v) => (/^[a-z0-9._-]{1,100}$/i.test(String(v ?? '').trim()) ? String(v).trim() : undefined), 'the slug shown by `vercel teams ls` or in the Vercel URL');
  }
  if (clerkPublishableKey.includes('pk_test_')) warn(ctx, 'A Clerk development instance (pk_test_) is fine to try Selfbound, use a production instance (pk_live_) for real use.');
  const after = { ...before, convexDeployment, appUrl, clerkPublishableKey, ...hosting };
  const changes = instanceChanges(before, after);
  if (!changes.length) ok(ctx, 'instance settings are complete');
  for (const [key, from, to] of changes) would(ctx, `${from === undefined ? 'set' : 'change'} ${key}: ${from === undefined ? '' : `${JSON.stringify(from)} → `}${JSON.stringify(to)}`);
  if (changes.length && !ctx.dryRun) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(after, null, 2)}\n`);
    ok(ctx, `saved ${shownPath(file)}`);
  }
  // Environment overrides still win over the file, as in the other tools.
  ctx.instance = { ...now, convexDeployment, appUrl, clerkPublishableKey, ...hosting };
}

async function stepKey(ctx) {
  const deployment = requireField(ctx, 'convexDeployment');
  const file = ctx.keyFile;
  const result = readDeployKey(file, deployment);
  if ('key' in result) {
    ctx.keyReady = true;
    return ok(ctx, `deploy key for ${deployment} in ${file}`);
  }
  warn(ctx, result.message);
  if (result.problem === 'open') throw new SetupError(`Fix the file mode first: chmod 600 ${file}`);
  if (result.problem === 'mismatch' && !(await confirm(ctx, 'Replace it with a key for this deployment?', false))) throw new SetupError('Keeping the existing key file. Point SELFBOUND_CONVEX_DEPLOY_KEY_FILE to another file or fix the deployment name.');
  if (ctx.dryRun) return would(ctx, `ask for the production deploy key and save it to ${file} (mode 600)`);
  if (ctx.yes) throw new SetupError(`No deploy key for ${deployment}. Run without --yes to paste one.`);
  say(ctx, '  Convex dashboard → your project → Production → Settings → Deploy keys → generate a production deploy key.');
  for (;;) {
    const key = await ctx.io.secret('Paste the production deploy key (input hidden)');
    if (deployKeyDeployment(key) === deployment) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, `${key}\n`, { mode: 0o600 });
      ctx.keyReady = true;
      return ok(ctx, `saved the deploy key to ${file} (mode 600)`);
    }
    warn(ctx, `That is not a production deploy key of ${deployment} (it starts with prod:${deployment}|).`);
  }
}

/** Current Convex variables: names, and the values of those the setup manages (never secrets). */
async function readEnv(ctx, names) {
  if (ctx.env) return ctx.env;
  if (!ctx.keyReady && !('key' in readDeployKey(ctx.keyFile, requireField(ctx, 'convexDeployment')))) return undefined;
  const listed = await ctx.convex(['env', 'list', '--names-only']);
  if (listed.code !== 0) throw new SetupError(`Could not read the Convex environment variables (convex env list, exit ${listed.code}). ${listed.stderr.trim().split('\n').at(-1) ?? ''}`);
  const env = new Map();
  for (const name of listed.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) env.set(name, '');
  for (const name of names.filter((n) => env.has(n))) {
    const got = await ctx.convex(['env', 'get', name]);
    if (got.code === 0) env.set(name, got.stdout.replace(/\n$/, ''));
  }
  ctx.env = env;
  return env;
}

/** Like readEnv(), but outside a dry run a missing deploy key stops the setup. */
async function envOrStop(ctx) {
  const env = await readEnv(ctx, MANAGED);
  if (!env && !ctx.dryRun) throw new SetupError('No valid deploy key, so the Convex variables cannot be read. Run the key step: node tooling/setup.mjs --only key');
  return env;
}

/** Sets one Convex variable; the value goes through stdin, so it never shows up in a process list. */
async function setEnv(ctx, name, value) {
  if (ctx.dryRun) return;
  const result = await ctx.convex(['env', 'set', name], value);
  if (result.code !== 0) throw new SetupError(`convex env set ${name} failed (exit ${result.code}).`);
  ctx.env?.set(name, value);
}

const MANAGED = ['CLERK_JWT_ISSUER_DOMAIN', 'SELFBOUND_DEV_JWKS', 'XLR8_DEV_JWKS', 'SELFBOUND_APP_URL', 'XLR8_APP_URL', 'SELFBOUND_OWNER_IDS', 'XLR8_OWNER_IDS'];

/** Applies a plan: missing values are set, other values only replaced after asking (--yes keeps them). */
async function applyPlan(ctx, plan, shown = (v) => v) {
  for (const item of plan) {
    if (item.status === 'ok') {
      ok(ctx, `${item.name} ${item.via && item.via !== item.name ? `(set under its old name ${item.via}) ` : ''}is ${shown(item.current, item.name)}`);
      continue;
    }
    if (item.status === 'differs') {
      warn(ctx, `${item.via} is ${shown(item.current, item.name)}, expected ${shown(item.value, item.name)}`);
      if (ctx.yes || !(await ctx.io.confirm(`  Replace ${item.via}?`, false))) {
        todo(ctx, `kept ${item.via}`);
        continue;
      }
    }
    would(ctx, `set ${item.name} = ${shown(item.value, item.name)}`);
    await setEnv(ctx, item.name, item.value);
    // auth.config.ts is evaluated when functions are pushed.
    if (item.name === 'CLERK_JWT_ISSUER_DOMAIN' && item.current) todo(ctx, 'takes effect with the next backend deploy (step "backend")');
  }
}

async function stepEnv(ctx) {
  const deployment = requireField(ctx, 'convexDeployment');
  const issuers = issuersOf(requireField(ctx, 'clerkPublishableKey'));
  await checkIssuer(ctx, issuers);
  const env = await envOrStop(ctx);
  const wanted = [
    { name: 'CLERK_JWT_ISSUER_DOMAIN', value: issuers.join(','), contains: true },
    { name: 'SELFBOUND_DEV_JWKS', value: 'none' },
    { name: 'SELFBOUND_APP_URL', value: requireField(ctx, 'appUrl') },
  ];
  if (!env) {
    for (const { name, value } of wanted) would(ctx, `set ${name} = ${value} (no deploy key yet, so the current values are unknown)`);
    return;
  }
  ok(ctx, `read the environment variables of ${deployment}`);
  await applyPlan(ctx, planEnv(env, wanted), (v, name) => (name === 'SELFBOUND_DEV_JWKS' && v !== 'none' ? `${String(v).slice(0, 24)}…` : v));
  for (const name of FORBIDDEN_ENV.filter((n) => env.has(n))) {
    warn(ctx, `${name} is set: it allows test data or test switches and must never be set in production.`);
    // --yes keeps it like any other existing value; removing it is a decision.
    if (!ctx.yes && (await ctx.io.confirm(`  Remove ${name}?`, true))) {
      would(ctx, `remove ${name}`);
      if (!ctx.dryRun && (await ctx.convex(['env', 'remove', name])).code !== 0) throw new SetupError(`convex env remove ${name} failed.`);
    }
  }
}

/** Does Clerk answer at the issuer? Catches a key of a deleted instance or DNS that is not active yet. */
async function checkIssuer(ctx, issuers) {
  for (const issuer of issuers) {
    try {
      const response = await ctx.fetch(`${issuer}/.well-known/openid-configuration`, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(10_000) });
      const body = response.ok ? await response.json() : {};
      if (body.issuer === issuer) ok(ctx, `Clerk answers at ${issuer}`);
      else warn(ctx, `Clerk does not answer as expected at ${issuer} (HTTP ${response.status}). For a production instance, check the DNS records in the Clerk dashboard → Domains.`);
    } catch {
      warn(ctx, `${issuer} is not reachable. For a production instance, the DNS records in the Clerk dashboard → Domains may not be active yet.`);
    }
  }
}

async function stepOwner(ctx) {
  const issuers = issuersOf(requireField(ctx, 'clerkPublishableKey'));
  const env = await envOrStop(ctx);
  const [plan] = planEnv(env ?? new Map(), [{ name: 'SELFBOUND_OWNER_IDS', value: '', contains: true }]);
  if (env && plan.current) {
    const foreign = foreignOwners(plan.current, issuers);
    ok(ctx, `${plan.via} has ${list(plan.current).length} owner${list(plan.current).length === 1 ? '' : 's'}: ${plan.current}`);
    if (foreign.length) warn(ctx, `${foreign.join(', ')} does not start with ${issuers.map((i) => `${i}|`).join(' or ')}: that account gets an empty app. Check the spelling of the issuer.`);
    return;
  }
  say(ctx, '  The owner is the Clerk user who may sign in. Everyone else is turned away, even with a Clerk account.');
  say(ctx, '  Create your user first: Clerk dashboard → Users → Create user (works with sign-ups restricted).');
  if (ctx.dryRun || ctx.yes) return would(ctx, `ask for your Clerk user and set SELFBOUND_OWNER_IDS = ${issuers[0]}|user_…`);
  const userId = await findOwner(ctx, issuers[0]);
  const value = `${issuers[0]}|${userId}`;
  would(ctx, `set SELFBOUND_OWNER_IDS = ${value}`);
  await setEnv(ctx, 'SELFBOUND_OWNER_IDS', value);
  todo(ctx, 'Now lock sign-ups: Clerk dashboard → Configure → Restrictions → Sign-up mode → Restricted.');
}

/** Do the secret key and the issuer belong to the same Clerk instance? Compares their signing key ids; undefined if unknown. */
async function sameClerkInstance(ctx, secret, issuer) {
  const kids = async (url, headers = {}) => {
    try {
      const response = await ctx.fetch(url, { headers: { ...headers, 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(10_000) });
      const keys = response.ok ? (await response.json())?.keys : undefined;
      return Array.isArray(keys) ? keys.map((k) => k.kid).filter(Boolean) : undefined;
    } catch {
      return undefined;
    }
  };
  const [own, public_] = await Promise.all([kids('https://api.clerk.com/v1/jwks', { authorization: `Bearer ${secret}` }), kids(`${issuer}/.well-known/jwks.json`)]);
  if (!own?.length || !public_?.length) return undefined;
  return own.some((kid) => public_.includes(kid));
}

/** The first Clerk user (via the Backend API and a secret key that is used once), or a pasted user id. */
async function findOwner(ctx, issuer) {
  for (;;) {
    const secret = await ctx.io.secret('Clerk secret key to find your user (sk_…, input hidden, not stored; Enter to type the user id instead)');
    if (!secret) break;
    if (!/^sk_(live|test)_\S+$/.test(secret)) {
      warn(ctx, 'That is not a Clerk secret key (sk_live_… or sk_test_…).');
      continue;
    }
    if ((await sameClerkInstance(ctx, secret, issuer)) === false) {
      warn(ctx, `That secret key belongs to another Clerk instance than ${issuer} (another application, or development instead of production).`);
      continue;
    }
    let users;
    try {
      const response = await ctx.fetch('https://api.clerk.com/v1/users?limit=10&order_by=%2Bcreated_at', {
        headers: { authorization: `Bearer ${secret}`, 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        warn(ctx, `Clerk refused the request (HTTP ${response.status}). Check the key (Clerk dashboard → Configure → API keys).`);
        continue;
      }
      users = ownerCandidates(await response.json());
    } catch (error) {
      warn(ctx, `Clerk is not reachable: ${error.message}`);
      continue;
    }
    if (!users.length) {
      warn(ctx, 'This Clerk instance has no users yet. Create yours in the Clerk dashboard → Users → Create user, then try again.');
      continue;
    }
    const label = (u) => [u.email, u.name].filter(Boolean).join(', ') || 'no e-mail address';
    if (users.length === 1) {
      if (await ctx.io.confirm(`  Make ${users[0].id} (${label(users[0])}) the owner?`, true)) return users[0].id;
      continue;
    }
    users.forEach((u, i) => say(ctx, `  ${i + 1}. ${u.id} (${label(u)})`));
    const pick = Number(await ctx.io.ask('  Which one is you? Number', '1'));
    if (users[pick - 1]) return users[pick - 1].id;
  }
  return await askValue(ctx, 'Your Clerk user id (Clerk dashboard → Users → your user)', undefined, (v) => (/^user_[A-Za-z0-9]+$/.test(String(v ?? '').trim()) ? String(v).trim() : undefined), 'it starts with user_');
}

async function stepBackend(ctx) {
  const deployment = requireField(ctx, 'convexDeployment');
  if (ctx.dryRun) would(ctx, `deploy the backend to ${deployment} (node tooling/cloud.mjs deploy)`);
  else if (!(await confirm(ctx, `Deploy the backend to ${deployment} now?`, true))) todo(ctx, 'skipped; later: node tooling/cloud.mjs deploy');
  else if ((await ctx.run('node', [join(root, 'tooling', 'cloud.mjs'), 'deploy'])) !== 0) throw new SetupError('The backend deploy failed, see the output above.');
  await checkHealth(ctx, deployment);
}

/** Reads /health: shows whether Clerk is configured and the local test sign-in is off. */
async function checkHealth(ctx, deployment) {
  const url = `https://${deployment}.convex.site/health`;
  try {
    const response = await ctx.fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(10_000) });
    const health = response.ok ? await response.json() : undefined;
    if (!health) return warn(ctx, `${url} answers HTTP ${response.status}: the backend is not deployed yet.`);
    const problems = [!health.ok && 'not ok', !health.clerk && 'Clerk not configured', health.devAuth && 'local test sign-in is on', health.local && 'local deployment'].filter(Boolean);
    if (problems.length) warn(ctx, `${url}: ${problems.join(', ')}`);
    else ok(ctx, `${url}: ok, Clerk configured, test sign-in off`);
  } catch {
    warn(ctx, `${url} is not reachable.`);
  }
}

async function stepWeb(ctx) {
  const vercel = !!ctx.instance.vercelProject;
  const script = join(root, 'tooling', 'deploy-web.mjs');
  if (vercel && !ctx.has('vercel')) warn(ctx, 'The Vercel CLI is missing: npm i -g vercel, then vercel login.');
  if (ctx.dryRun) would(ctx, vercel ? `build the app and deploy it to the Vercel project ${ctx.instance.vercelProject} (node tooling/deploy-web.mjs)` : 'build the app into deploy/web/ (node tooling/deploy-web.mjs --build)');
  else if (!(await confirm(ctx, vercel ? 'Build and deploy the web app to Vercel now?' : 'Build the web app into deploy/web/ now?', true))) todo(ctx, `skipped; later: node tooling/deploy-web.mjs${vercel ? '' : ' --build'}`);
  else {
    if (vercel && !ctx.has('vercel')) throw new SetupError('Install and log in to the Vercel CLI first.');
    if ((await ctx.run('node', vercel ? [script] : [script, '--build'])) !== 0) throw new SetupError('Building or deploying the web app failed, see the output above.');
    if (vercel) todo(ctx, `Add ${new URL(requireField(ctx, 'appUrl')).host} as a domain of the Vercel project (Vercel → Project → Settings → Domains), once.`);
    else todo(ctx, 'Upload deploy/web/ to your host and add the rewrites from docs/self-hosting.md ("Hosting elsewhere").');
  }
  const appUrl = requireField(ctx, 'appUrl');
  try {
    const response = await ctx.fetch(`${appUrl}/version.json`, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(10_000) });
    if (response.ok) ok(ctx, `${appUrl} serves the app`);
    else warn(ctx, `${appUrl}/version.json answers HTTP ${response.status}: the app is not reachable there yet (domain not added or DNS pending).`);
  } catch {
    warn(ctx, `${appUrl} is not reachable yet (domain not added or DNS pending).`);
  }
}

async function stepPush(ctx) {
  const env = await envOrStop(ctx);
  if (env?.has('VAPID_PUBLIC_KEY') && env.has('VAPID_PRIVATE_KEY')) return ok(ctx, 'push notifications are set up (VAPID keys exist)');
  if (ctx.dryRun) return would(ctx, 'offer to set up push notifications (node tooling/vapid.mjs)');
  if (!(await confirm(ctx, 'Set up push notifications (VAPID keys)?', false))) return todo(ctx, 'skipped; later: node tooling/vapid.mjs');
  if ((await ctx.run('node', [join(root, 'tooling', 'vapid.mjs')])) !== 0) throw new SetupError('Setting up the VAPID keys failed.');
}

function requireField(ctx, field) {
  const value = ctx.instance[field];
  if (!value) throw new SetupError(`${field} is not set. Run the instance step first: node tooling/setup.mjs --only instance`);
  return value;
}

function summary(ctx) {
  const { convexDeployment, appUrl } = ctx.instance;
  if (!convexDeployment || !appUrl) return;
  const mcp = `https://${convexDeployment}.convex.site/mcp`;
  say(ctx);
  say(ctx, ctx.dryRun ? 'Dry run: nothing was changed.' : 'Done.');
  say(ctx, `  App:        ${appUrl}  (sign in with your owner account)`);
  say(ctx, `  MCP:        ${mcp}`);
  say(ctx, '              Key-based clients (Claude Code, Codex): Settings → Agents → create a key, send it as "Authorization: Bearer <key>".');
  say(ctx, `              claude.ai and ChatGPT: Settings → Agents → Connect connector, then add ${mcp} as a custom connector.`);
  say(ctx, `  Health:     https://${convexDeployment}.convex.site/health`);
  say(ctx, '  Next:       docs/self-hosting.md ("Optional extras": GitHub, backups) and Settings → General → Time zone.');
}

const RUN = { tools: stepTools, instance: stepInstance, key: stepKey, env: stepEnv, owner: stepOwner, backend: stepBackend, web: stepWeb, push: stepPush };
const TITLES = { tools: 'Tools', instance: 'Instance settings', key: 'Convex deploy key', env: 'Convex environment variables', owner: 'Owner', backend: 'Backend', web: 'Web app', push: 'Push notifications (optional)' };

export function parseArgs(argv) {
  const options = { dryRun: false, yes: false, help: false, steps: STEPS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '-n') options.dryRun = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--only' || arg.startsWith('--only=')) {
      const value = arg.includes('=') ? arg.split('=')[1] : argv[++i];
      const steps = list(value);
      const unknown = steps.filter((s) => !STEPS.includes(s));
      if (!steps.length || unknown.length) throw new SetupError(`--only takes steps from: ${STEPS.join(', ')}${unknown.length ? ` (unknown: ${unknown.join(', ')})` : ''}`);
      options.steps = STEPS.filter((s) => steps.includes(s));
    } else throw new SetupError(`Unknown option ${arg}. See node tooling/setup.mjs --help`);
  }
  return options;
}

/**
 * Runs the setup. Everything with side effects comes in through `deps`, so tests can swap it:
 * io (ask, confirm, secret), convex(args, stdin) → { code, stdout, stderr }, run(cmd, args) → exit code,
 * fetch, has(command), log, env, instanceFile, keyFile.
 */
export async function setup(argv, deps = {}) {
  const options = parseArgs(argv);
  const log = deps.log ?? ((line) => console.log(line));
  if (options.help) {
    const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
    log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return 0;
  }
  const env = deps.env ?? process.env;
  const ctx = {
    ...options,
    log,
    io: deps.io,
    convex: deps.convex ?? cloudCli,
    run: deps.run ?? inherit,
    fetch: deps.fetch ?? globalThis.fetch,
    has: deps.has ?? onPath,
    instanceFile: deps.instanceFile ?? instanceFile(),
    keyFile: deps.keyFile ?? deployKeyFile(env),
    env: undefined,
    keyReady: false,
  };
  ctx.instance = loadInstance(env, ctx.instanceFile);
  if (options.dryRun) log('Dry run: nothing is written, set or deployed.');
  try {
    for (const [i, step] of options.steps.entries()) {
      log(`\n${i + 1}/${options.steps.length} ${TITLES[step]}`);
      await RUN[step](ctx);
    }
    summary(ctx);
    return 0;
  } catch (error) {
    if (!(error instanceof SetupError)) throw error;
    log(`\nStopped: ${error.message}`);
    log('Fix it and run node tooling/setup.mjs again; finished steps are skipped.');
    return 2;
  }
}

/** Convex CLI against production (tooling/cloud.mjs), output collected; `input` goes via stdin. */
function cloudCli(args, input) {
  return new Promise((resolve) => {
    const child = runCloud(args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(input ?? '');
    child.on('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function inherit(cmd, args) {
  return new Promise((resolve) => spawn(cmd, args, { cwd: root, stdio: 'inherit' }).on('exit', (code) => resolve(code ?? 1)));
}

const onPath = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const io = terminal();
  let code;
  try {
    code = await setup(process.argv.slice(2), { io });
  } catch (error) {
    if (!(error instanceof SetupError)) throw error;
    console.error(error.message);
    code = 2;
  } finally {
    io.close();
  }
  process.exit(code);
}
