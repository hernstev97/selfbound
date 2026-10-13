import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { DAY_MS } from '../lib/dates';
import { fail, notFound } from '../lib/errors';
import {
  ACCESS_TTL_MS,
  APPS,
  ARM_TTL_MS,
  CODE_TTL_MS,
  REFRESH_GRACE_MS,
  REFRESH_TTL_MS,
  REQUEST_TTL_MS,
  type AuthMethod,
  type OAuthApp,
} from '../lib/oauth/core';
import { readOpsStatus, writeOpsStatus } from './maintenance';
import { checkName } from './validate';

// OAuth for connectors, database side (flow in lib/oauth/http.ts, pure checks in
// lib/oauth/core.ts). Only hashes arrive here, never tokens, codes or client secrets.
//
// Arming: registering new clients and approving requests only works during the 15 minutes
// after "Connect connector" (Settings → Agents). The first approval disarms again, so a
// planted consent link leads nowhere.
//
// Revocation paths (code or refresh token used twice) RETURN an error instead of throwing:
// a thrown error would roll back the mutation including the revocation.

const ARMED = 'oauthArmed';
/** Unapproved clients: at most this many (oldest are dropped), deleted after 1 h. */
const MAX_UNAPPROVED = 20;
const UNAPPROVED_KEEP_MS = 60 * 60_000;
/** Redeemed refresh tokens are kept this long so that later reuse is detected. */
const ROTATED_KEEP_MS = DAY_MS;

export type RevokedReason = NonNullable<Doc<'agents'>['revokedReason']>;
export type GrantResult = { ok: true } | { ok: false; error: 'invalid_grant'; description: string };

const SUGGESTED_NAME: Record<OAuthApp, string> = { claude: 'claude.ai', chatgpt: 'ChatGPT' };

const invalidGrant = (description: string): GrantResult => ({ ok: false, error: 'invalid_grant', description });

// ---------------------------------------------------------------- Arming

/** Until when XLR8 accepts new connectors (timestamp, may be in the past), else null. */
export async function armedUntil(ctx: QueryCtx): Promise<number | null> {
  const until = ((await readOpsStatus(ctx, ARMED))?.value as { until?: unknown } | undefined)?.until;
  return typeof until === 'number' && until > 0 ? until : null;
}

export async function isArmed(ctx: QueryCtx, now: number) {
  return ((await armedUntil(ctx)) ?? 0) > now;
}

export async function arm(ctx: MutationCtx, on: boolean, now: number) {
  const until = on ? now + ARM_TTL_MS : 0;
  await writeOpsStatus(ctx, ARMED, { until }, now);
  return { armedUntil: on ? until : null };
}

// ---------------------------------------------------------------- Clients

export async function findClient(ctx: QueryCtx, clientId: string) {
  return await ctx.db
    .query('oauthClients')
    .withIndex('by_client', (q) => q.eq('clientId', clientId))
    .unique();
}

export async function registerClient(
  ctx: MutationCtx,
  args: { clientId: string; app: OAuthApp; clientName: string; redirectUris: string[]; authMethod: AuthMethod; secretHash?: string },
  now: number,
): Promise<{ ok: boolean }> {
  if (!(await isArmed(ctx, now))) return { ok: false };
  const unapproved = await ctx.db
    .query('oauthClients')
    .withIndex('by_approved_created', (q) => q.eq('approvedAt', undefined))
    .take(MAX_UNAPPROVED + 5);
  for (const old of unapproved.slice(0, Math.max(0, unapproved.length - MAX_UNAPPROVED + 1))) {
    await ctx.db.delete('oauthClients', old._id);
  }
  await ctx.db.insert('oauthClients', { ...args, createdAt: now });
  return { ok: true };
}

// ---------------------------------------------------------------- Requests

async function requestByPublicId(ctx: QueryCtx, publicId: string) {
  return await ctx.db
    .query('oauthRequests')
    .withIndex('by_public', (q) => q.eq('publicId', publicId))
    .unique();
}

/** New request; an open request of the same client is dropped (at most one per client). */
export async function startRequest(
  ctx: MutationCtx,
  args: {
    publicId: string;
    clientId: string;
    app: OAuthApp;
    redirectUri: string;
    redirectGiven: boolean;
    state?: string;
    codeChallenge: string;
    issuer?: string;
  },
  now: number,
) {
  const open = await ctx.db
    .query('oauthRequests')
    .withIndex('by_client_status', (q) => q.eq('clientId', args.clientId).eq('status', 'pending'))
    .take(10);
  for (const r of open) await ctx.db.delete('oauthRequests', r._id);
  await ctx.db.insert('oauthRequests', { ...args, createdAt: now, expiresAt: now + REQUEST_TTL_MS, status: 'pending' });
}

/** For the consent page. No clock (query): the page compares the expiry itself. */
export async function requestView(ctx: QueryCtx, publicId: string) {
  const r = await requestByPublicId(ctx, publicId);
  if (!r) return { state: 'unknown' as const };
  const client = await findClient(ctx, r.clientId);
  return {
    state: r.status === 'failed' ? ('redeemed' as const) : r.status,
    app: r.app,
    appName: APPS[r.app].name,
    clientName: client?.clientName ?? '',
    clientKnown: client !== null,
    redirectHost: new URL(r.redirectUri).host,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    armedUntil: await armedUntil(ctx),
    suggestedName: SUGGESTED_NAME[r.app],
  };
}

/** Approval by the owner: attach the code (hash only) to the request, then disarm. */
export async function approveRequest(ctx: MutationCtx, args: { publicId: string; name: string; codeHash: string }, now: number) {
  const r = (await requestByPublicId(ctx, args.publicId)) ?? notFound('The request');
  if (r.status !== 'pending') fail('conflict', 'This request has already been handled.');
  if (r.expiresAt <= now) fail('invalid', 'The request has expired. Restart the connection in the app.');
  if (!(await findClient(ctx, r.clientId))) notFound('The client');
  if (!(await isArmed(ctx, now))) {
    fail('access_denied', 'XLR8 is not accepting new connectors right now. First press "Connect connector" under Settings → Agents.');
  }
  const name = checkName(args.name, 'The connector', 60);
  await ctx.db.patch('oauthRequests', r._id, { status: 'approved', name, codeHash: args.codeHash, codeExpiresAt: now + CODE_TTL_MS });
  await arm(ctx, false, now);
  return { redirectUri: r.redirectUri, state: r.state, issuer: r.issuer };
}

export async function denyRequest(ctx: MutationCtx, args: { publicId: string }) {
  const r = (await requestByPublicId(ctx, args.publicId)) ?? notFound('The request');
  if (r.status !== 'pending') fail('conflict', 'This request has already been handled.');
  await ctx.db.patch('oauthRequests', r._id, { status: 'denied' });
  return { redirectUri: r.redirectUri, state: r.state, issuer: r.issuer };
}

// ---------------------------------------------------------------- Token

async function issueTokens(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  clientId: string,
  hashes: { accessHash: string; refreshHash: string },
  now: number,
) {
  await ctx.db.insert('oauthTokens', { hash: hashes.accessHash, kind: 'access', agentId, clientId, expiresAt: now + ACCESS_TTL_MS });
  await ctx.db.insert('oauthTokens', { hash: hashes.refreshHash, kind: 'refresh', agentId, clientId, expiresAt: now + REFRESH_TTL_MS });
}

/**
 * Redeems a code (authorization_code): only here is the connector created as an agent,
 * together with its tokens. Redeeming the same code a second time means it was intercepted:
 * the connector is then revoked.
 */
export async function redeemCode(
  ctx: MutationCtx,
  args: { clientId: string; codeHash: string; challenge: string; redirectUri?: string; accessHash: string; refreshHash: string },
  now: number,
): Promise<GrantResult> {
  const r = await ctx.db
    .query('oauthRequests')
    .withIndex('by_code', (q) => q.eq('codeHash', args.codeHash))
    .unique();
  if (!r) return invalidGrant('Invalid code.');
  if (r.status === 'redeemed') {
    if (r.agentId) await revokeConnector(ctx, r.agentId, 'code_reuse', now);
    return invalidGrant('Code already used, the connection has been revoked.');
  }
  if (r.status !== 'approved') return invalidGrant('Invalid code.');
  // redirect_uri must match; it may only be missing if it was also missing at /authorize (RFC 6749 4.1.3).
  const redirectOk = r.redirectGiven
    ? args.redirectUri === r.redirectUri
    : args.redirectUri === undefined || args.redirectUri === r.redirectUri;
  const client = await findClient(ctx, r.clientId);
  if (r.clientId !== args.clientId || (r.codeExpiresAt ?? 0) <= now || !redirectOk || args.challenge !== r.codeChallenge || !client) {
    await ctx.db.patch('oauthRequests', r._id, { status: 'failed', codeHash: undefined });
    return invalidGrant('Code does not match (client, redirect, PKCE or expired).');
  }
  const agentId = await ctx.db.insert('agents', {
    name: r.name ?? APPS[r.app].name,
    connector: { app: r.app, clientId: r.clientId },
    createdAt: now,
  });
  await issueTokens(ctx, agentId, r.clientId, args, now);
  await ctx.db.patch('oauthRequests', r._id, { status: 'redeemed', agentId });
  if (client.approvedAt === undefined) await ctx.db.patch('oauthClients', client._id, { approvedAt: now });
  return { ok: true };
}

/**
 * Refresh with rotation and a short grace period: Claude shares one token between web,
 * desktop and phone and retries on errors. Whoever presents a redeemed refresh token after
 * the grace period has probably stolen it: the connector is then revoked.
 */
export async function rotateRefresh(
  ctx: MutationCtx,
  args: { clientId: string; refreshHash: string; accessHash: string; newRefreshHash: string },
  now: number,
): Promise<GrantResult> {
  const t = await ctx.db
    .query('oauthTokens')
    .withIndex('by_hash', (q) => q.eq('hash', args.refreshHash))
    .unique();
  if (!t || t.kind !== 'refresh' || t.expiresAt <= now || t.clientId !== args.clientId) {
    return invalidGrant('Refresh token invalid or expired.');
  }
  const agent = await ctx.db.get('agents', t.agentId);
  if (!agent || agent.revokedAt !== undefined) return invalidGrant('The connection has been revoked.');
  if (t.rotatedAt === undefined) {
    await ctx.db.patch('oauthTokens', t._id, { rotatedAt: now, expiresAt: Math.min(t.expiresAt, now + ROTATED_KEEP_MS) });
  } else if (now - t.rotatedAt > REFRESH_GRACE_MS) {
    await revokeConnector(ctx, agent._id, 'refresh_reuse', now);
    return invalidGrant('Refresh token already used, the connection has been revoked.');
  }
  await issueTokens(ctx, agent._id, t.clientId, { accessHash: args.accessHash, refreshHash: args.newRefreshHash }, now);
  return { ok: true };
}

/** RFC 7009: the app disconnects. Tokens of other clients or unknown tokens: do nothing. */
export async function revokeByToken(ctx: MutationCtx, args: { clientId: string; tokenHash: string }, now: number) {
  const t = await ctx.db
    .query('oauthTokens')
    .withIndex('by_hash', (q) => q.eq('hash', args.tokenHash))
    .unique();
  if (t && t.clientId === args.clientId) await revokeConnector(ctx, t.agentId, 'client', now);
}

/** Revokes a connector: permanent, deletes all tokens (takes effect immediately). */
export async function revokeConnector(ctx: MutationCtx, agentId: Id<'agents'>, reason: RevokedReason, now: number) {
  const agent = await ctx.db.get('agents', agentId);
  if (agent && agent.revokedAt === undefined) await ctx.db.patch('agents', agentId, { revokedAt: now, revokedReason: reason });
  const tokens = await ctx.db
    .query('oauthTokens')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .take(4000);
  for (const t of tokens) await ctx.db.delete('oauthTokens', t._id);
}

// ---------------------------------------------------------------- Cleanup

/** Expired tokens, old requests, never approved clients. `more` = something is left. */
export async function cleanupOAuth(ctx: MutationCtx, now: number, limit = 500) {
  const tokens = await ctx.db
    .query('oauthTokens')
    .withIndex('by_expires', (q) => q.lt('expiresAt', now))
    .take(limit);
  for (const row of tokens) await ctx.db.delete('oauthTokens', row._id);
  const requests = await ctx.db
    .query('oauthRequests')
    .withIndex('by_expires', (q) => q.lt('expiresAt', now - DAY_MS))
    .take(limit);
  for (const row of requests) await ctx.db.delete('oauthRequests', row._id);
  const clients = await ctx.db
    .query('oauthClients')
    .withIndex('by_approved_created', (q) => q.eq('approvedAt', undefined).lt('createdAt', now - UNAPPROVED_KEEP_MS))
    .take(limit);
  for (const row of clients) await ctx.db.delete('oauthClients', row._id);
  return {
    tokens: tokens.length,
    requests: requests.length,
    clients: clients.length,
    more: tokens.length === limit || requests.length === limit || clients.length === limit,
  };
}
