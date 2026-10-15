// OAuth 2.1 for MCP connectors (claude.ai, ChatGPT): pure logic, no Convex, no storage.
// Metadata (RFC 9728, RFC 8414), registration (RFC 7591), authorization with PKCE S256,
// `iss` in every response to the client (RFC 9207), resource indicators (RFC 8707).
//
// Flow, endpoints and security model: docs/architecture/mcp.md, section "OAuth".
// The endpoints live in lib/oauth/http.ts, the database side in ops/oauth.ts.

import { ANY_PREFIX, base64url } from '../keys';
import { envVar } from '../legacyEnv';

export const SCOPE = 'selfbound';
// legacy-xlr8: scope of connectors authorized before the rename; still accepted and advertised
export const LEGACY_SCOPE = 'xlr8';

/**
 * Scope in a token response. The scope is not stored per grant (there is only one, everything an
 * agent may do), so it follows the request: a client that asks for the legacy scope only keeps
 * seeing it. A client registered before the rename (client id `xlr8-…`) that names no scope (the
 * code and refresh grants usually do not) keeps seeing it too; everyone else gets `selfbound`.
 */
export function issuedScope(requested: string | undefined, clientId?: string): string {
  const scopes = (requested ?? '').split(/\s+/).filter(Boolean);
  if (scopes.includes(SCOPE)) return SCOPE;
  if (scopes.includes(LEGACY_SCOPE)) return LEGACY_SCOPE;
  // legacy-xlr8: the client id prefix of connectors registered before the rename
  return !scopes.length && clientId?.startsWith('xlr8-') ? LEGACY_SCOPE : SCOPE;
}
export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
/** An already redeemed refresh token stays valid this long (retries, several devices). */
export const REFRESH_GRACE_MS = 60_000;
export const CODE_TTL_MS = 5 * 60_000;
export const REQUEST_TTL_MS = 15 * 60_000;
/** How long Selfbound accepts new connectors after "Connect connector". */
export const ARM_TTL_MS = 15 * 60_000;

// Secret prefixes for everything newly issued. Agent keys are "selfbound_" + 43 characters, these
// carry 3 more: they cannot be mistaken for each other.
export const ACCESS_PREFIX = 'selfbound_at_';
export const REFRESH_PREFIX = 'selfbound_rt_';
export const CODE_PREFIX = 'selfbound_ac_';
export const SECRET_PREFIX = 'selfbound_cs_';
// Secrets issued before the rename stay valid, so the formats accept the old prefix too.
export const ACCESS_FORMAT = new RegExp(`^${ANY_PREFIX}_at_[A-Za-z0-9_-]{43}$`);
export const REFRESH_FORMAT = new RegExp(`^${ANY_PREFIX}_rt_[A-Za-z0-9_-]{43}$`);
export const CODE_FORMAT = new RegExp(`^${ANY_PREFIX}_ac_[A-Za-z0-9_-]{43}$`);
export const SECRET_FORMAT = new RegExp(`^${ANY_PREFIX}_cs_[A-Za-z0-9_-]{43}$`);

const CHALLENGE_FORMAT = /^[A-Za-z0-9_-]{43,128}$/;
const VERIFIER_FORMAT = /^[A-Za-z0-9._~-]{43,128}$/;
const MAX_STATE = 1024;
const MAX_URI = 512;
const MAX_URIS = 5;
const MAX_CLIENT_NAME = 100;

export type OAuthApp = 'claude' | 'chatgpt';
export type AuthMethod = 'none' | 'client_secret_basic' | 'client_secret_post';
export const AUTH_METHODS: readonly AuthMethod[] = ['none', 'client_secret_basic', 'client_secret_post'];

/**
 * Which app a client is follows from its redirect URIs alone (never from the freely chosen
 * client_name). /oauth/register rejects any other redirect URI.
 * Sources: https://claude.com/docs/connectors/building/authentication,
 *          https://developers.openai.com/apps-sdk/build/auth
 */
export const APPS: Record<OAuthApp, { name: string; redirects: readonly RegExp[] }> = {
  claude: {
    name: 'Claude',
    redirects: [/^https:\/\/claude\.ai\/api\/mcp\/auth_callback$/, /^https:\/\/claude\.com\/api\/mcp\/auth_callback$/],
  },
  chatgpt: {
    name: 'ChatGPT',
    redirects: [
      /^https:\/\/chatgpt\.com\/connector_platform_oauth_redirect$/,
      /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/,
    ],
  },
};

export function appForRedirect(uri: string): OAuthApp | null {
  for (const app of Object.keys(APPS) as OAuthApp[]) if (APPS[app].redirects.some((re) => re.test(uri))) return app;
  return null;
}

/** All URIs must belong to the same app, otherwise null. */
export function appForRedirects(uris: readonly string[]): OAuthApp | null {
  const apps = new Set(uris.map(appForRedirect));
  return apps.size === 1 && !apps.has(null) ? [...apps][0]! : null;
}

// ---------------------------------------------------------------- Configuration

export interface OAuthConfig {
  /** Issuer and base of all endpoints, without path and without trailing slash. */
  issuer: string;
  /** The protected resource: exactly the URL the owner enters in claude.ai and ChatGPT. */
  resource: string;
  /** Web app that hosts the consent page (/oauth/consent). */
  appUrl: string;
}

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The address from SELFBOUND_PUBLIC_SITE_URL (a custom address in front of Convex), else CONVEX_SITE_URL. */
function oauthBase(env: Record<string, string | undefined>): string | null {
  return originOf(envVar('PUBLIC_SITE_URL', env)) ?? originOf(env.CONVEX_SITE_URL);
}

/**
 * OAuth is on as soon as SELFBOUND_APP_URL is set. The base is SELFBOUND_PUBLIC_SITE_URL (a custom
 * address, e.g. https://mcp.selfbound.example.com rewriting to Convex), else CONVEX_SITE_URL. The
 * issuer must be fixed: it never comes from the request.
 */
export function oauthConfig(env: Record<string, string | undefined> = process.env): OAuthConfig | null {
  const appUrl = originOf(envVar('APP_URL', env));
  const base = oauthBase(env);
  if (!appUrl || !base) return null;
  return { issuer: base, resource: `${base}/mcp`, appUrl };
}

/** Consent page of the web app. The app also still accepts the old path /oauth/freigabe?anfrage=…. */
export const CONSENT_PATH = '/oauth/consent';
/** Query parameter on the consent page that carries the request's public id. */
export const CONSENT_PARAM = 'request';

// ---------------------------------------------------------------- Metadata

/** RFC 9728. Claude only uses the first entry of authorization_servers. */
export function protectedResourceMetadata(cfg: OAuthConfig) {
  return {
    resource: cfg.resource,
    authorization_servers: [cfg.issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: [SCOPE, LEGACY_SCOPE],
    resource_name: 'Selfbound',
  };
}

/**
 * RFC 8414. `issuer` is exactly the entry in authorization_servers (ChatGPT checks this), and
 * `iss` is in every response to the client: then ChatGPT uses its fixed redirect URI.
 * No CIMD (client_id_metadata_document_supported is absent): both apps then register via DCR.
 */
export function authorizationServerMetadata(cfg: OAuthConfig) {
  const o = cfg.issuer;
  return {
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/oauth/token`,
    registration_endpoint: `${o}/oauth/register`,
    revocation_endpoint: `${o}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: AUTH_METHODS,
    revocation_endpoint_auth_methods_supported: AUTH_METHODS,
    scopes_supported: [SCOPE, LEGACY_SCOPE, 'offline_access'],
    authorization_response_iss_parameter_supported: true,
  };
}

export const resourceMetadataUrl = (cfg: OAuthConfig) => `${cfg.issuer}/.well-known/oauth-protected-resource/mcp`;

/** Header for a 401 on /mcp: starts the sign-in flow in claude.ai and ChatGPT. */
export function wwwAuthenticate(cfg: OAuthConfig, error?: 'invalid_token') {
  return `Bearer resource_metadata="${resourceMetadataUrl(cfg)}", scope="${SCOPE}"${error ? `, error="${error}"` : ''}`;
}

/** Compares resource URIs ignoring trailing slashes. */
export const sameResource = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

// ---------------------------------------------------------------- Registration (RFC 7591)

export type Check<T> = { ok: true; value: T } | { ok: false; error: string; description: string };

export interface Registration {
  app: OAuthApp;
  clientName: string;
  redirectUris: string[];
  authMethod: AuthMethod;
}

export function checkRegistration(meta: unknown): Check<Registration> {
  const bad = (error: string, description: string) => ({ ok: false as const, error, description });
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return bad('invalid_client_metadata', 'Not a JSON object.');
  const m = meta as Record<string, unknown>;
  const uris = m.redirect_uris;
  if (
    !Array.isArray(uris) ||
    uris.length === 0 ||
    uris.length > MAX_URIS ||
    uris.some((u) => typeof u !== 'string' || u.length > MAX_URI)
  ) {
    return bad('invalid_redirect_uri', 'redirect_uris is missing or invalid.');
  }
  const app = appForRedirects(uris as string[]);
  if (!app) return bad('invalid_redirect_uri', 'Only claude.ai and chatgpt.com are allowed as redirect targets.');
  const grants = m.grant_types ?? ['authorization_code', 'refresh_token'];
  if (!Array.isArray(grants) || grants.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
    return bad('invalid_client_metadata', 'grant_types not supported.');
  }
  const responses = m.response_types ?? ['code'];
  if (!Array.isArray(responses) || responses.some((r) => r !== 'code')) {
    return bad('invalid_client_metadata', 'response_types not supported.');
  }
  // RFC 7591 2: client_secret_basic is the default.
  const method = m.token_endpoint_auth_method ?? 'client_secret_basic';
  if (typeof method !== 'string' || !(AUTH_METHODS as readonly string[]).includes(method)) {
    return bad('invalid_client_metadata', 'token_endpoint_auth_method not supported.');
  }
  const clientName = typeof m.client_name === 'string' ? m.client_name.trim().slice(0, MAX_CLIENT_NAME) : '';
  return { ok: true, value: { app, clientName, redirectUris: uris as string[], authMethod: method as AuthMethod } };
}

// ---------------------------------------------------------------- Authorization

export type AuthorizeCheck =
  | { kind: 'page'; title: string; text: string }
  | { kind: 'error'; redirectUri: string; state?: string; error: string; description: string }
  | { kind: 'ok'; redirectUri: string; redirectGiven: boolean; state?: string; codeChallenge: string };

/**
 * Checks a request to /oauth/authorize for a known client. Errors go back to the client by
 * redirect only once the redirect URI is established; before that they are shown as a page
 * (anything else would be an open redirect).
 */
export function checkAuthorize(
  params: URLSearchParams,
  client: { redirectUris: readonly string[] },
  cfg: OAuthConfig,
): AuthorizeCheck {
  let redirectUri = params.get('redirect_uri');
  const redirectGiven = redirectUri !== null;
  if (!redirectGiven && client.redirectUris.length === 1) redirectUri = client.redirectUris[0]!;
  if (redirectUri === null || !client.redirectUris.includes(redirectUri)) {
    return { kind: 'page', title: 'Invalid redirect', text: 'redirect_uri does not match the registered client.' };
  }
  const rawState = params.get('state');
  const state = rawState === null ? undefined : rawState;
  const fail = (error: string, description: string): AuthorizeCheck => ({ kind: 'error', redirectUri, state, error, description });
  if (rawState !== null && rawState.length > MAX_STATE) return fail('invalid_request', 'state is too long.');
  if (params.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported.');
  const challenge = params.get('code_challenge') ?? '';
  if (!CHALLENGE_FORMAT.test(challenge) || params.get('code_challenge_method') !== 'S256') {
    return fail('invalid_request', 'PKCE with S256 is required.');
  }
  if (params.getAll('resource').some((r) => !sameResource(r, cfg.resource))) {
    return fail('invalid_target', `Unknown resource, expected ${cfg.resource}.`);
  }
  // scope: there is only "selfbound" (everything an agent may do; legacy-xlr8: "xlr8" is its old name).
  // Other values such as offline_access are ignored.
  return { kind: 'ok', redirectUri, redirectGiven, state, codeChallenge: challenge };
}

/** Redirect URL back to the client, always with `iss` (RFC 9207). */
export function redirectWith(uri: string, params: Record<string, string | undefined>, issuer: string) {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  url.searchParams.set('iss', issuer);
  return url.toString();
}

// ---------------------------------------------------------------- Token endpoint

export const isVerifier = (v: string | undefined): v is string => typeof v === 'string' && VERIFIER_FORMAT.test(v);

/** PKCE S256 (RFC 7636 4.2): base64url(SHA-256(verifier)). */
export async function pkceChallenge(verifier: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Form body (application/x-www-form-urlencoded, as OAuth requires) or JSON; first value per key wins. */
export function parseForm(body: string, contentType: string | null): Record<string, string> | null {
  if ((contentType ?? '').toLowerCase().includes('application/json')) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
      return out;
    } catch {
      return null;
    }
  }
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) if (!(k in out)) out[k] = v;
  return out;
}

/**
 * Client authentication at the token endpoint: HTTP Basic (client_secret_basic, values
 * URL-encoded per RFC 6749 2.3.1) or form fields. null = malformed Basic header.
 */
export function clientCredentials(
  authorization: string | null,
  form: Record<string, string>,
): { clientId?: string; secret?: string; basic: boolean } | null {
  if (authorization && /^Basic\s/i.test(authorization)) {
    try {
      const decoded = atob(authorization.slice(6).trim());
      const i = decoded.indexOf(':');
      if (i < 0) return null;
      return {
        clientId: decodeURIComponent(decoded.slice(0, i).replace(/\+/g, ' ')),
        secret: decodeURIComponent(decoded.slice(i + 1).replace(/\+/g, ' ')),
        basic: true,
      };
    } catch {
      return null;
    }
  }
  return { clientId: form.client_id, secret: form.client_secret, basic: false };
}

// ---------------------------------------------------------------- Responses

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);

export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Plain error page without scripts (only when no redirect back to the client is possible). */
export function messagePage(title: string, text: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}@media (prefers-color-scheme:dark){body{background:#161616;color:#eee}}</style></head><body><h1>${esc(title)}</h1><p>${esc(text)}</p></body></html>`;
}
