import { httpRouter } from 'convex/server';
import { internal } from './_generated/api';
import { httpAction, type ActionCtx } from './_generated/server';
import { healthStatus } from './health';
import { dayInZone } from './lib/dates';
import { resolveMediaLocation } from './githubPr';
import { githubHeaders, verifySignature } from './lib/github';
import { MEDIA_PATH } from './lib/githubMedia';
import { sha256Hex } from './lib/keys';
import { checkLogo } from './lib/logo';
import { mcpEndpoint, retryOnConflict } from './lib/mcp/endpoint';
import { fromFetchRequest, toFetchResponse } from './lib/mcp/protocol';
import { oauthConfig, wwwAuthenticate, type OAuthConfig } from './lib/oauth/core';
import * as oauth from './lib/oauth/http';
import { reduceGithubPayload } from './ops/github';
import { IMAGE_PATH } from './shared/constants';
import { EMBED_MEDIA_PATH, ID_PATTERN } from './shared/embeds';
import { plain } from './ops/mcp';

// HTTP endpoints (Convex site URL, locally port+1):
//   POST /mcp          MCP for agents (bearer key) and connectors (OAuth access token)
//   GET  /.well-known/oauth-protected-resource[/mcp], /.well-known/oauth-authorization-server
//   POST /oauth/register, GET /oauth/authorize, POST /oauth/token, POST /oauth/revoke
//                      OAuth for connectors (lib/oauth/http.ts); only with SELFBOUND_APP_URL, else 404
//   POST /github       GitHub webhook (HMAC signature with GITHUB_WEBHOOK_SECRET)
//   GET  /ghmedia/<key>/<i>  image or video from a PR (private repo): 302 to a fresh GitHub URL
//   GET  /logo/<id>    team logo with a strict Content-Security-Policy
//   GET  /img/<token>  image from a description or comment (the token is the access control)
//   GET  /embed/<provider>/<id>/<slot>  stored thumbnail of a video card
//   GET  /health       status without data
// All other /.well-known/* return 404.

const SERVER_VERSION = '0.1.0';

const http = httpRouter();

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// ---------------------------------------------------------------- MCP

// Flow and error handling live in lib/mcp/endpoint.ts (tested there without Convex).
const mcp = httpAction(async (ctx, request) => {
  const cfg = oauthConfig();
  const response = await mcpEndpoint(
    await fromFetchRequest(request),
    {
      sha256: sha256Hex,
      today: async () => dayInZone(Date.now(), await ctx.runQuery(internal.instance.timeZone, {})),
      authenticate: (keyHash, now) => ctx.runQuery(internal.agents.authenticate, { keyHash, now }),
      countCall: (keyHash) => ctx.runMutation(internal.mcp.countCall, { keyHash }),
      read: (keyHash, tool, args, today) => ctx.runQuery(internal.mcp.read, { keyHash, tool, args: plain(args), today }),
      call: (keyHash, tool, args) => ctx.runMutation(internal.mcp.call, { keyHash, tool, args: plain(args) }),
      upload: (keyHash, args) => ctx.runAction(internal.mcp.uploadImage, { keyHash, args: plain(args) }),
      countFailedCall: (keyHash) => ctx.runMutation(internal.mcp.countFailedCall, { keyHash }),
      log: (error, tool) => console.error(`MCP tool ${tool} failed:`, error),
      ...(cfg ? { challenge: (error?: 'invalid_token') => wwwAuthenticate(cfg, error) } : {}),
      // In case the claude.ai or ChatGPT servers send an Origin header.
      allowedOrigins: ['https://claude.ai', 'https://claude.com', 'https://chatgpt.com'],
    },
    SERVER_VERSION,
  );
  return toFetchResponse(response);
});

http.route({ path: '/mcp', method: 'POST', handler: mcp });
for (const method of ['GET', 'DELETE'] as const) {
  http.route({
    path: '/mcp',
    method,
    handler: httpAction(async () => new Response(null, { status: 405, headers: { Allow: 'POST' } })),
  });
}

// ---------------------------------------------------------------- OAuth for connectors

/** Endpoint only with OAuth enabled (SELFBOUND_APP_URL set), else 404. */
const withOAuth = (handler: (ctx: ActionCtx, request: Request, cfg: OAuthConfig) => Promise<Response>) =>
  httpAction(async (ctx, request) => {
    const cfg = oauthConfig();
    return cfg ? await handler(ctx, request, cfg) : oauth.notFound();
  });

const oauthBackend = (ctx: ActionCtx): oauth.OAuthBackend => ({
  client: (clientId) => ctx.runQuery(internal.oauth.client, { clientId }),
  register: (args) => ctx.runMutation(internal.oauth.register, args),
  startRequest: (args) => ctx.runMutation(internal.oauth.startRequest, args),
  exchangeCode: (args) => retryOnConflict(() => ctx.runMutation(internal.oauth.exchangeCode, args)),
  refresh: (args) => retryOnConflict(() => ctx.runMutation(internal.oauth.refresh, args)),
  revoke: (args) => ctx.runMutation(internal.oauth.revoke, args),
});

const OAUTH_ROUTES: [string, 'GET' | 'POST', (ctx: ActionCtx, request: Request, cfg: OAuthConfig) => Promise<Response>][] = [
  ['/.well-known/oauth-protected-resource', 'GET', async (_ctx, _request, cfg) => oauth.protectedResource(cfg)],
  ['/.well-known/oauth-protected-resource/mcp', 'GET', async (_ctx, _request, cfg) => oauth.protectedResource(cfg)],
  ['/.well-known/oauth-authorization-server', 'GET', async (_ctx, _request, cfg) => oauth.authorizationServer(cfg)],
  ['/oauth/register', 'POST', async (ctx, request) => await oauth.register(request, oauthBackend(ctx))],
  ['/oauth/authorize', 'GET', async (ctx, request, cfg) => await oauth.authorize(request, cfg, oauthBackend(ctx))],
  ['/oauth/token', 'POST', async (ctx, request, cfg) => await oauth.token(request, cfg, oauthBackend(ctx))],
  ['/oauth/revoke', 'POST', async (ctx, request) => await oauth.revoke(request, oauthBackend(ctx))],
];
for (const [path, method, handler] of OAUTH_ROUTES) {
  http.route({ path, method, handler: withOAuth(handler) });
  if (method === 'POST' || path.startsWith('/.well-known/')) {
    http.route({ path, method: 'OPTIONS', handler: withOAuth(async () => oauth.preflight()) });
  }
}

// Everything else under /.well-known/ (e.g. openid-configuration): 404.
const notFound = httpAction(async () => json(404, { error: 'not found' }));
http.route({ pathPrefix: '/.well-known/', method: 'GET', handler: notFound });

// ---------------------------------------------------------------- GitHub

http.route({
  path: '/github',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const raw = await request.text();
    const { event, deliveryId, signature } = githubHeaders(request.headers);
    const secret = process.env.GITHUB_WEBHOOK_SECRET ?? '';
    // During a secret rotation the old secret stays valid until all repos are switched (docs/operations.md).
    const previous = process.env.GITHUB_WEBHOOK_SECRET_PREVIOUS ?? '';
    if (!secret) console.error('GITHUB_WEBHOOK_SECRET is not set: all webhook deliveries are rejected.');
    const valid =
      (await verifySignature(secret, raw, signature)) || (previous !== '' && (await verifySignature(previous, raw, signature)));
    if (!valid) return json(401, { error: 'invalid signature' });
    if (event === 'ping') return json(200, { ok: true, pong: true });
    if (!deliveryId) return json(400, { error: 'X-GitHub-Delivery header missing' });
    let payload: unknown;
    try {
      // GitHub can also send a form (payload=…); the signature covers the raw text.
      const type = request.headers.get('content-type') ?? '';
      payload = type.includes('application/x-www-form-urlencoded')
        ? JSON.parse(new URLSearchParams(raw).get('payload') ?? '')
        : JSON.parse(raw);
    } catch {
      return json(400, { error: 'body is not JSON' });
    }
    const reduced = reduceGithubPayload(event, payload);
    const result = await retryOnConflict(() =>
      ctx.runMutation(internal.github.applyDelivery, { deliveryId, event, payload: reduced }),
    );
    return json(200, { ok: true, ...result });
  }),
});

/**
 * GET /ghmedia/<mediaKey>/<index>: media from a PR description or comment. The key (32 random
 * bytes, per PR) protects it like /img does; the original URL is only known to the backend.
 * Response: 302 to a fresh, directly loadable GitHub URL (no bytes pass through Convex), cached
 * privately for at most 60 s. Unknown or error → 404 without details.
 */
http.route({
  pathPrefix: MEDIA_PATH,
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    const m = /^([A-Za-z0-9_-]{20,64})\/(\d{1,4})$/.exec(new URL(request.url).pathname.slice(MEDIA_PATH.length));
    let location: Awaited<ReturnType<typeof resolveMediaLocation>> = null;
    if (m) {
      try {
        location = await resolveMediaLocation(ctx, m[1]!, Number(m[2]));
      } catch {
        location = null;
      }
    }
    if (!location) return json(404, { error: 'not found' });
    return new Response(null, {
      status: 302,
      headers: {
        Location: location.url,
        // browser cache only (private), and only while the target is surely still valid
        'Cache-Control': location.maxAge > 0 ? `private, max-age=${location.maxAge}` : 'private, no-store',
        'Referrer-Policy': 'no-referrer',
      },
    });
  }),
});

// ---------------------------------------------------------------- Logos

/**
 * GET /logo/<storageId>: serves a team logo. Only files a team uses as its logo, and only if
 * they (still) pass the logo check. The response forbids any active content (CSP without
 * scripts, no MIME sniffing) in case someone opens the URL directly instead of via <img>.
 * meta.get returns this URL instead of the storage URL.
 */
http.route({
  pathPrefix: '/logo/',
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    const raw = new URL(request.url).pathname.slice('/logo/'.length);
    const logo = raw && !raw.includes('/') ? await ctx.runQuery(internal.teams.logoFile, { storageId: raw }) : null;
    if (!logo) return json(404, { error: 'not found' });
    const blob = await ctx.storage.get(logo.storageId);
    if (!blob) return json(404, { error: 'not found' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const check = checkLogo(bytes, logo.contentType, { square: logo.square });
    if (!check.ok) return json(404, { error: 'not found' });
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': check.contentType,
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        'X-Content-Type-Options': 'nosniff',
        // A storageId always points to the same file (new logo = new id).
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        // Provider logos are drawn as CSS masks, which load in CORS mode. Public images either way.
        'Access-Control-Allow-Origin': '*',
      },
    });
  }),
});

// ---------------------------------------------------------------- Images

/**
 * GET /img/<token>: image from a description or comment. `<img>` cannot send an auth header;
 * the protection is the token (32 random bytes), known only to whoever may read the text.
 * Unknown token → 404. Content type from the check at upload, no MIME sniffing, no scripts,
 * no caching in shared caches (`private`).
 */
http.route({
  pathPrefix: IMAGE_PATH,
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    const token = new URL(request.url).pathname.slice(IMAGE_PATH.length);
    const file = await ctx.runQuery(internal.files.byToken, { token });
    if (!file) return json(404, { error: 'not found' });
    const blob = await ctx.storage.get(file.storageId);
    if (!blob) return json(404, { error: 'not found' });
    return new Response(blob, {
      status: 200,
      headers: {
        'Content-Type': file.contentType,
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
        'Referrer-Policy': 'no-referrer',
        // A token always points to the same file.
        'Cache-Control': 'private, max-age=31536000, immutable',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      },
    });
  }),
});

// ---------------------------------------------------------------- Embeds

/**
 * GET /embed/<provider>/<id>/<slot>: image of an embed card (a video thumbnail), stored
 * by the backend (embeds.resolve). Public content, so no token; only what the cache holds, and only
 * raster images that passed the check when stored. Same hardening as /img.
 */
http.route({
  pathPrefix: EMBED_MEDIA_PATH,
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    const m = /^(youtube|x)\/([A-Za-z0-9_-]{1,25})\/([a-z0-9]{1,8})$/.exec(new URL(request.url).pathname.slice(EMBED_MEDIA_PATH.length));
    const provider = m?.[1] as 'youtube' | 'x' | undefined;
    const file = m && ID_PATTERN[provider!].test(m[2]!) ? await ctx.runQuery(internal.embeds.mediaFile, { provider: provider!, id: m[2]!, slot: m[3]! }) : null;
    const blob = file ? await ctx.storage.get(file.storageId) : null;
    if (!file || !blob) return json(404, { error: 'not found' });
    return new Response(blob, {
      status: 200,
      headers: {
        'Content-Type': file.contentType,
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
        'Referrer-Policy': 'no-referrer',
        // A refresh may replace the file, so only one day (not immutable).
        'Cache-Control': 'public, max-age=86400',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      },
    });
  }),
});

// ---------------------------------------------------------------- Health

http.route({ path: '/health', method: 'GET', handler: httpAction(async () => json(200, healthStatus())) });

export default http;
