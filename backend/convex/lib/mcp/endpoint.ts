// The MCP endpoint POST /mcp without Convex: check the key, dispatch tool calls to the backend
// functions, turn errors into responses. convex/http.ts plugs in the real functions
// (runQuery/runMutation), tests plug in fakes.
//
// Flow of a tool call:
//   read tool:  countCall (mutation, rate limit only) → read (query, cacheable)
//   write tool: call (one mutation: count, idempotency, operation)
// Errors are counted too: a discarded write call and a call that already fails argument
// validation are counted afterwards with countFailedCall.
// If the key is revoked between sign-in and tool call: 401 as for an unknown key, not a
// tool error.
//
// Two kinds of sign-in:
//   Agent key "selfbound_…" (Claude Code, Codex, other agents): errors → 401 WITHOUT
//     WWW-Authenticate, so these clients never start an OAuth flow.
//   Access token "selfbound_at_…" (connectors in claude.ai and ChatGPT): errors, missing or foreign
//     bearer → 401 WITH WWW-Authenticate (starts the sign-in), but only when OAuth is enabled
//     (`challenge` set). Otherwise like an agent key.

import { ANY_PREFIX, KEY_PREFIX, LEGACY_KEY_PREFIX } from '../keys';
import { ACCESS_FORMAT } from '../oauth/core';
import {
  bearerToken,
  handleMcpHttp,
  oauthUnauthorizedResponse,
  ToolError,
  unauthorizedResponse,
  type McpHttpRequest,
  type McpHttpResponse,
} from './protocol';
import { TOOLS, type ToolName } from './tools';

/**
 * Key format of `agents.create`: "selfbound_" + 32 bytes base64url. Anything else costs no lookup.
 * Keys issued before the rename start with the old prefix and stay valid.
 */
export const KEY_FORMAT = new RegExp(`^${ANY_PREFIX}_[A-Za-z0-9_-]{43}$`);

export interface McpBackend {
  sha256(text: string): Promise<string>;
  /** Calendar day (Europe/Berlin) for read tools, e.g. "completed today". */
  today(): string;
  /** Hash of a key or access token → agent; `now` checks a token's expiry. */
  authenticate(keyHash: string, now: number): Promise<{ agentId: string; name: string }>;
  countCall(keyHash: string): Promise<unknown>;
  read(keyHash: string, tool: ToolName, args: unknown, today: string): Promise<unknown>;
  call(keyHash: string, tool: ToolName, args: unknown): Promise<{ value: unknown }>;
  countFailedCall(keyHash: string): Promise<unknown>;
  log?(error: unknown, tool: string): void;
  /** Only with OAuth enabled: value for WWW-Authenticate (lib/oauth/core.ts wwwAuthenticate). */
  challenge?(error?: 'invalid_token'): string;
  /** Allowed `Origin` headers (see McpDeps.allowedOrigins). */
  allowedOrigins?: readonly string[];
}

export const isReadTool = (name: string) => TOOLS.find((t) => t.name === name)?.annotations?.readOnlyHint === true;

/** Business error data from a runMutation/runQuery error (ConvexError), else null. */
export function errorData(error: unknown): ({ code: string; message: string } & Record<string, unknown>) | null {
  let data = (error as { data?: unknown } | null)?.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (data && typeof data === 'object' && typeof (data as { code?: unknown }).code === 'string') {
    return data as { code: string; message: string } & Record<string, unknown>;
  }
  return null;
}

/** Convex retried a mutation several times because of concurrent writes and then gave up. */
function isWriteConflict(error: unknown) {
  return error instanceof Error && /changed while this mutation was being run/i.test(error.message);
}

/**
 * Retries a mutation that failed on write conflicts (many concurrent writes to the same
 * document). Safe because every mutation is a transaction: failed means nothing was written.
 * Matters most for GitHub, which does not retry failed deliveries on its own.
 */
export async function retryOnConflict<T>(run: () => Promise<T>, attempts = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts || !isWriteConflict(error)) throw error;
      await new Promise((r) => setTimeout(r, Math.random() * 100 * 2 ** attempt));
    }
  }
}

function toolError(data: Record<string, unknown>) {
  const { code, message, ...rest } = data as { code: string; message: string };
  return new ToolError(`${code}: ${message}`, Object.keys(rest).length ? rest : undefined);
}

/** Handles a request to POST /mcp. */
export async function mcpEndpoint(
  req: McpHttpRequest,
  backend: McpBackend,
  serverVersion: string,
): Promise<McpHttpResponse> {
  const key = bearerToken(req.headers);
  const isAccessToken = key !== undefined && ACCESS_FORMAT.test(key) && backend.challenge !== undefined;
  const isKey = key !== undefined && !isAccessToken && (key.startsWith(KEY_PREFIX) || key.startsWith(LEGACY_KEY_PREFIX));
  // Agent key (or OAuth off): plain 401. Otherwise 401 with a sign-in challenge.
  const unauthorized = () =>
    isKey || !backend.challenge
      ? unauthorizedResponse(undefined, req.body)
      : oauthUnauthorizedResponse(backend.challenge(key === undefined ? undefined : 'invalid_token'), req.body);
  if (!key || (isKey && !KEY_FORMAT.test(key)) || (!isKey && !isAccessToken)) return unauthorized();
  const keyHash = await backend.sha256(key);
  let agent: { agentId: string; name: string };
  try {
    agent = await backend.authenticate(keyHash, Date.now());
  } catch (error) {
    if (errorData(error)?.code === 'access_denied') return unauthorized();
    throw error;
  }
  let revoked = false;
  const countFailed = async () => {
    try {
      await retryOnConflict(() => backend.countFailedCall(keyHash));
    } catch (error) {
      backend.log?.(error, 'countFailedCall');
    }
  };
  const response = await handleMcpHttp(req, {
    agent: { id: agent.agentId, name: agent.name },
    serverVersion,
    async callTool(name, args) {
      if (isReadTool(name)) {
        try {
          await retryOnConflict(() => backend.countCall(keyHash));
          return await backend.read(keyHash, name, args, backend.today());
        } catch (error) {
          const data = errorData(error);
          if (!data) throw error;
          if (data.code === 'access_denied') revoked = true;
          throw toolError(data); // already counted (or over the limit)
        }
      }
      try {
        return (await retryOnConflict(() => backend.call(keyHash, name, args))).value;
      } catch (error) {
        const data = errorData(error);
        if (!data) throw error;
        if (data.code === 'access_denied') revoked = true;
        // Count discarded write calls anyway (not on rate limit or revocation).
        else if (data.code !== 'rate_limited') await countFailed();
        throw toolError(data);
      }
    },
    onRejectedCall: countFailed,
    onError: (error, tool) => backend.log?.(error, tool),
    ...(backend.allowedOrigins ? { allowedOrigins: backend.allowedOrigins } : {}),
  });
  return revoked ? unauthorized() : response;
}
