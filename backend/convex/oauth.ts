import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation, internalQuery } from './_generated/server';
import { ownerAction, ownerQuery, ownerWriteMutation } from './lib/auth';
import { fail } from './lib/errors';
import { generateSecret } from './lib/keys';
import { CODE_PREFIX, oauthConfig, redirectWith } from './lib/oauth/core';
import { assertWritable } from './lib/testSwitches';
import { assertOwner } from './ops/agents';
import * as ops from './ops/oauth';
import { oauthAppValidator } from './schema';

// OAuth for connectors (claude.ai, ChatGPT): consent page and arming for the owner, internal
// functions for the endpoints in convex/http.ts (lib/oauth/http.ts).

/**
 * Public id of the consent request. `request` is the current argument name; `anfrage` is the
 * legacy name sent by app builds from before the rename (German for "request").
 */
const requestArgs = { request: v.optional(v.string()), anfrage: v.optional(v.string()) };
const requestIdOf = (args: { request?: string; anfrage?: string }) =>
  args.request ?? args.anfrage ?? fail('invalid', 'The request id is missing.');

/** Consent page: details of the request (unknown → state 'unknown'). */
export const request = ownerQuery({
  args: requestArgs,
  handler: async (ctx, args) => await ops.requestView(ctx, requestIdOf(args)),
});

/**
 * The owner approves or denies. Returns the URL the browser follows back to the app (with
 * code or error, `state` and `iss`). Built from the stored, checked redirect URI, never from
 * anything the page sends. The code appears only in this response.
 */
export const decide = ownerAction({
  args: { ...requestArgs, approve: v.boolean(), name: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ redirect: string }> => {
    assertOwner(ctx.actor, 'approve connectors');
    const requestId = requestIdOf(args);
    const cfg = oauthConfig() ?? fail('invalid', 'OAuth is not enabled on this backend (XLR8_APP_URL is not set).');
    if (!args.approve) {
      const { redirectUri, state } = await ctx.runMutation(internal.oauth.deny, { request: requestId });
      return {
        redirect: redirectWith(redirectUri, { error: 'access_denied', error_description: 'The owner denied access.', state }, cfg.issuer),
      };
    }
    const code = await generateSecret(CODE_PREFIX);
    const { redirectUri, state } = await ctx.runMutation(internal.oauth.approve, {
      request: requestId,
      name: args.name ?? '',
      codeHash: code.hash,
    });
    return { redirect: redirectWith(redirectUri, { code: code.value, state }, cfg.issuer) };
  },
});

/** "Connect connector": accept new connectors for 15 minutes (or switch off right away). */
export const arm = ownerWriteMutation({
  args: { on: v.boolean() },
  handler: async (ctx, args) => {
    assertOwner(ctx.actor, 'connect connectors');
    return await ops.arm(ctx, args.on, Date.now());
  },
});

// ---------------------------------------------------------------- internal (HTTP endpoints)

export const approve = internalMutation({
  args: { request: v.string(), name: v.string(), codeHash: v.string() },
  handler: async (ctx, args) => {
    await assertWritable(ctx);
    return await ops.approveRequest(ctx, { publicId: args.request, name: args.name, codeHash: args.codeHash }, Date.now());
  },
});

export const deny = internalMutation({
  args: { request: v.string() },
  handler: async (ctx, args) => await ops.denyRequest(ctx, { publicId: args.request }),
});

export const client = internalQuery({
  args: { clientId: v.string() },
  handler: async (ctx, args) => {
    const c = await ops.findClient(ctx, args.clientId);
    if (!c) return null;
    return {
      clientId: c.clientId,
      app: c.app,
      redirectUris: c.redirectUris,
      authMethod: c.authMethod,
      ...(c.secretHash !== undefined ? { secretHash: c.secretHash } : {}),
    };
  },
});

export const register = internalMutation({
  args: {
    clientId: v.string(),
    app: oauthAppValidator,
    clientName: v.string(),
    redirectUris: v.array(v.string()),
    authMethod: v.union(v.literal('none'), v.literal('client_secret_basic'), v.literal('client_secret_post')),
    secretHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => await ops.registerClient(ctx, args, Date.now()),
});

export const startRequest = internalMutation({
  args: {
    publicId: v.string(),
    clientId: v.string(),
    app: oauthAppValidator,
    redirectUri: v.string(),
    redirectGiven: v.boolean(),
    state: v.optional(v.string()),
    codeChallenge: v.string(),
    issuer: v.optional(v.string()),
  },
  handler: async (ctx, args) => await ops.startRequest(ctx, args, Date.now()),
});

export const exchangeCode = internalMutation({
  args: {
    clientId: v.string(),
    codeHash: v.string(),
    challenge: v.string(),
    redirectUri: v.optional(v.string()),
    accessHash: v.string(),
    refreshHash: v.string(),
  },
  handler: async (ctx, args) => await ops.redeemCode(ctx, args, Date.now()),
});

export const refresh = internalMutation({
  args: { clientId: v.string(), refreshHash: v.string(), accessHash: v.string(), newRefreshHash: v.string() },
  handler: async (ctx, args) => await ops.rotateRefresh(ctx, args, Date.now()),
});

export const revoke = internalMutation({
  args: { clientId: v.string(), tokenHash: v.string() },
  handler: async (ctx, args) => await ops.revokeByToken(ctx, args, Date.now()),
});

/** Cron: expired tokens, old requests, never approved clients. */
export const cleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const result = await ops.cleanupOAuth(ctx, Date.now());
    if (result.more) await ctx.scheduler.runAfter(0, internal.oauth.cleanup, {});
    return result;
  },
});
