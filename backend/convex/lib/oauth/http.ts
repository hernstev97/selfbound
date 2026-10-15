// OAuth endpoints for connectors, without Convex: convex/http.ts plugs in the real functions
// (runQuery/runMutation). Tokens, codes and client secrets exist in plain text only here; the
// database only receives their SHA-256 hashes. None of them is ever logged.
//
//   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728
//   GET  /.well-known/oauth-authorization-server       RFC 8414
//   POST /oauth/register                               RFC 7591 (only while armed)
//   GET  /oauth/authorize                              → consent page of the web app
//   POST /oauth/token                                  authorization_code (PKCE), refresh_token
//   POST /oauth/revoke                                 RFC 7009

import { generateSecret, randomId, sha256Hex } from '../keys';
import {
  ACCESS_PREFIX,
  ACCESS_TTL_MS,
  authorizationServerMetadata,
  checkAuthorize,
  checkRegistration,
  clientCredentials,
  CODE_FORMAT,
  CONSENT_PARAM,
  CONSENT_PATH,
  isVerifier,
  issuedScope,
  messagePage,
  PAGE_CSP,
  parseForm,
  pkceChallenge,
  protectedResourceMetadata,
  REFRESH_FORMAT,
  REFRESH_PREFIX,
  redirectWith,
  sameResource,
  SCOPE,
  SECRET_PREFIX,
  type AuthMethod,
  type OAuthApp,
  type OAuthConfig,
} from './core';

const MAX_BODY = 16 * 1024;

export interface OAuthClientInfo {
  clientId: string;
  app: OAuthApp;
  redirectUris: string[];
  authMethod: AuthMethod;
  secretHash?: string;
}

type Grant = { ok: true } | { ok: false; error: string; description: string };

export interface OAuthBackend {
  client(clientId: string): Promise<OAuthClientInfo | null>;
  register(args: OAuthClientInfo & { clientName: string }): Promise<{ ok: boolean }>;
  startRequest(args: {
    publicId: string;
    clientId: string;
    app: OAuthApp;
    redirectUri: string;
    redirectGiven: boolean;
    state?: string;
    codeChallenge: string;
    issuer: string;
  }): Promise<unknown>;
  exchangeCode(args: {
    clientId: string;
    codeHash: string;
    challenge: string;
    redirectUri?: string;
    accessHash: string;
    refreshHash: string;
  }): Promise<Grant>;
  refresh(args: { clientId: string; refreshHash: string; accessHash: string; newRefreshHash: string }): Promise<Grant>;
  revoke(args: { clientId: string; tokenHash: string }): Promise<unknown>;
}

// ---------------------------------------------------------------- Responses

export const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
  'Access-Control-Max-Age': '86400',
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...headers },
  });

const oauthError = (status: number, error: string, description: string, headers?: Record<string, string>) =>
  json(status, { error, error_description: description }, headers);

const page = (status: number, title: string, text: string) =>
  new Response(messagePage(title, text), {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': PAGE_CSP,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });

const redirect = (location: string) =>
  new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });

export const preflight = () => new Response(null, { status: 204, headers: CORS });

export const notFound = () => json(404, { error: 'not found' });

async function readBody(request: Request): Promise<string | null> {
  const text = await request.text();
  return text.length > MAX_BODY ? null : text;
}

// ---------------------------------------------------------------- Metadata

export const protectedResource = (cfg: OAuthConfig) => json(200, protectedResourceMetadata(cfg), { 'Cache-Control': 'public, max-age=300' });
export const authorizationServer = (cfg: OAuthConfig) =>
  json(200, authorizationServerMetadata(cfg), { 'Cache-Control': 'public, max-age=300' });

// ---------------------------------------------------------------- Registration

export async function register(request: Request, backend: OAuthBackend) {
  const body = await readBody(request);
  if (body === null) return oauthError(413, 'invalid_client_metadata', 'Too large.');
  let meta: unknown;
  try {
    meta = JSON.parse(body);
  } catch {
    return oauthError(400, 'invalid_client_metadata', 'Invalid JSON.');
  }
  const checked = checkRegistration(meta);
  if (!checked.ok) return oauthError(400, checked.error, checked.description);
  const { app, clientName, redirectUris, authMethod } = checked.value;
  const clientId = `selfbound-${app}-${randomId()}`;
  const secret = authMethod === 'none' ? null : await generateSecret(SECRET_PREFIX);
  const { ok } = await backend.register({
    clientId,
    app,
    clientName,
    redirectUris,
    authMethod,
    ...(secret ? { secretHash: secret.hash } : {}),
  });
  if (!ok) {
    return oauthError(
      400,
      'invalid_client_metadata',
      'Selfbound is not accepting new connectors right now. In Selfbound, press "Connect connector" under Settings → Agents, then restart the connection.',
    );
  }
  return json(201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    ...(secret ? { client_secret: secret.value, client_secret_expires_at: 0 } : {}),
    ...(clientName ? { client_name: clientName } : {}),
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: authMethod,
    scope: SCOPE,
  });
}

// ---------------------------------------------------------------- Authorization

export async function authorize(request: Request, cfg: OAuthConfig, backend: OAuthBackend) {
  const params = new URL(request.url).searchParams;
  const clientId = params.get('client_id') ?? '';
  const client = clientId.length > 0 && clientId.length <= 200 ? await backend.client(clientId) : null;
  if (!client) return page(400, 'Unknown client', 'This app is not registered with Selfbound. Set up the connection in the app again.');
  const checked = checkAuthorize(params, client, cfg);
  if (checked.kind === 'page') return page(400, checked.title, checked.text);
  if (checked.kind === 'error') {
    return redirect(
      redirectWith(checked.redirectUri, { error: checked.error, error_description: checked.description, state: checked.state }, cfg.issuer),
    );
  }
  const publicId = randomId(24);
  await backend.startRequest({
    publicId,
    clientId: client.clientId,
    app: client.app,
    redirectUri: checked.redirectUri,
    redirectGiven: checked.redirectGiven,
    ...(checked.state !== undefined ? { state: checked.state } : {}),
    codeChallenge: checked.codeChallenge,
    issuer: cfg.issuer,
  });
  return redirect(`${cfg.appUrl}${CONSENT_PATH}?${CONSENT_PARAM}=${encodeURIComponent(publicId)}`);
}

// ---------------------------------------------------------------- Token

/**
 * Client authentication. A non-constant-time hash comparison is fine here: it compares SHA-256
 * values of a 256-bit secret, so timing reveals nothing useful.
 */
async function authenticateClient(request: Request, form: Record<string, string>, backend: OAuthBackend) {
  const creds = clientCredentials(request.headers.get('authorization'), form);
  if (!creds?.clientId || creds.clientId.length > 200) return null;
  const client = await backend.client(creds.clientId);
  if (!client) return null;
  // Public clients have no secret; some still send Basic with an empty password.
  if (client.authMethod === 'none') return client;
  if (!creds.secret || !client.secretHash || (await sha256Hex(creds.secret)) !== client.secretHash) return null;
  return client;
}

const invalidClient = () =>
  oauthError(401, 'invalid_client', 'Client authentication failed.', { 'WWW-Authenticate': 'Basic realm="selfbound"' });

export async function token(request: Request, cfg: OAuthConfig, backend: OAuthBackend) {
  const body = await readBody(request);
  const form = body === null ? null : parseForm(body, request.headers.get('content-type'));
  if (!form) return oauthError(400, 'invalid_request', 'Unreadable body.');
  const client = await authenticateClient(request, form, backend);
  if (!client) return invalidClient();
  if (form.resource !== undefined && !sameResource(form.resource, cfg.resource)) {
    return oauthError(400, 'invalid_target', `Unknown resource, expected ${cfg.resource}.`);
  }
  const access = await generateSecret(ACCESS_PREFIX);
  const refresh = await generateSecret(REFRESH_PREFIX);
  let result: Grant;
  if (form.grant_type === 'authorization_code') {
    const code = form.code ?? '';
    if (!CODE_FORMAT.test(code)) return oauthError(400, 'invalid_grant', 'Invalid code.');
    // A wrong verifier invalidates the code (an empty challenge never matches).
    const challenge = isVerifier(form.code_verifier) ? await pkceChallenge(form.code_verifier) : '';
    result = await backend.exchangeCode({
      clientId: client.clientId,
      codeHash: await sha256Hex(code),
      challenge,
      ...(form.redirect_uri !== undefined ? { redirectUri: form.redirect_uri } : {}),
      accessHash: access.hash,
      refreshHash: refresh.hash,
    });
  } else if (form.grant_type === 'refresh_token') {
    const old = form.refresh_token ?? '';
    if (!REFRESH_FORMAT.test(old)) return oauthError(400, 'invalid_grant', 'Refresh token invalid or expired.');
    result = await backend.refresh({
      clientId: client.clientId,
      refreshHash: await sha256Hex(old),
      accessHash: access.hash,
      newRefreshHash: refresh.hash,
    });
  } else {
    return oauthError(400, 'unsupported_grant_type', 'Only authorization_code and refresh_token are supported.');
  }
  if (!result.ok) return oauthError(400, result.error, result.description);
  return json(
    200,
    {
      access_token: access.value,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_MS / 1000,
      refresh_token: refresh.value,
      scope: issuedScope(form.scope, client.clientId),
    },
    { Pragma: 'no-cache' },
  );
}

export async function revoke(request: Request, backend: OAuthBackend) {
  const body = await readBody(request);
  const form = body === null ? null : parseForm(body, request.headers.get('content-type'));
  if (!form) return oauthError(400, 'invalid_request', 'Unreadable body.');
  const client = await authenticateClient(request, form, backend);
  if (!client) return invalidClient();
  const value = form.token ?? '';
  // RFC 7009 2.2: the server answers 200 for unknown tokens too.
  if (value.length > 0 && value.length <= 200) await backend.revoke({ clientId: client.clientId, tokenHash: await sha256Hex(value) });
  return json(200, {});
}
