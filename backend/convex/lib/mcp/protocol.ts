// MCP over Streamable HTTP, stateless and with JSON responses only (no SSE), as a Convex HTTP
// action requires.
//
// The server speaks both protocol generations ("dual-era"):
// - Legacy (2024-11-05 to 2025-11-25): handshake with `initialize`, then the
//   `MCP-Protocol-Version` header. We hand out no session id; every request stands on its
//   own, which the specification explicitly allows.
// - Modern (2026-07-28): no handshake; every request carries version and client capabilities
//   in `params._meta`, mirrored in the headers `MCP-Protocol-Version`, `Mcp-Method`,
//   `Mcp-Name`. `server/discover` is mandatory.
//
// The caller checks authentication (the agent's bearer key) beforehand; `handleMcpHttp` only
// receives the verified agent.
//
// Sources: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
//          https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
//          https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning

import { checkToolArguments, isToolName, TOOLS, type ToolArgs, type ToolDefinition, type ToolName } from './tools';

export const MODERN_VERSIONS = ['2026-07-28'] as const;
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const SUPPORTED_VERSIONS: readonly string[] = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

export const SERVER_NAME = 'selfbound';
export const INSTRUCTIONS = [
  'This Selfbound instance is a single-owner issue tracker.',
  'Use these tools to find, read and manage issues across its teams: search_issues and list_issues to find work, get_issue for details with comments, relations and pull requests, create_issues / update_issue / set_status / move_issues / add_comment to make changes, and get_current_sprint for the sprint that spans all teams.',
  'Identifiers look like "ACME-106" (team key + number). Teams are referenced by key, labels, projects and statuses by name; call list_teams, list_labels, list_projects or list_statuses to look up valid values. Each team has its own workflow statuses.',
  'There is a single user (the owner) and no assignee field: the "assigned" filter means all open issues outside triage in teams that are not dormant and not knowledge-only.',
  'Teams can also have a knowledge area (list_teams field `wiki`): pages in a tree with Markdown text, topics and sources. Use search_articles, list_articles and get_article to read it, create_article and update_article (`append` to add findings) to write; search first to avoid duplicates.',
  'Descriptions, comments and knowledge pages are Markdown. For an info panel start a quote with "> [!INFO] Optional title" (kinds INFO, NOTE, SUCCESS, WARNING, ERROR; the GitHub alert names TIP, IMPORTANT and CAUTION work too) and put the content on the following "> " lines. A ```chart code block with JSON is drawn as a data chart: {"type":"line|area|bar|heatmap|stat","title":…} with x/series, categories/series, rows/columns/values or items (area and bar take "stack":"stacked"|"percent"; bar takes "orientation":"horizontal").',
  'Always pass a fresh requestId to create_issues, add_comment, create_article and update_article; retrying with the same requestId is safe. Business errors come back as tool results with isError and a plain explanation.',
].join(' ');

// JSON-RPC and MCP error codes
export const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  HEADER_MISMATCH: -32020,
  UNSUPPORTED_VERSION: -32022,
} as const;
/** Application-defined code outside the reserved range (−32768 … −32000). */
export const ERR_UNAUTHORIZED = -31001;

export interface McpHttpRequest {
  method: string;
  headers: Headers | Record<string, string | string[] | undefined>;
  body: string;
}

export interface McpHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

export interface McpAgent {
  id: string;
  name: string;
}

export interface McpDeps {
  /** The already verified agent (bearer key). */
  agent: McpAgent;
  serverVersion: string;
  /**
   * Runs a tool with checked, normalized arguments. The return value goes to the agent as
   * JSON text and `structuredContent`. Throw business errors as `ToolError`; they appear as
   * a result with `isError: true`.
   */
  callTool<N extends ToolName>(name: N, args: ToolArgs[N], ctx: { agent: McpAgent }): Promise<unknown>;
  /** Allowed `Origin` headers (browsers). Without a list every request with `Origin` is rejected. */
  allowedOrigins?: readonly string[];
  /** For unexpected errors from `callTool` (logging). */
  onError?: (error: unknown, tool: string) => void;
  /**
   * A `tools/call` that already fails validation (unknown tool, invalid arguments) and so
   * never reaches `callTool`. For the rate limit: such calls count too.
   */
  onRejectedCall?: (tool: string) => Promise<void>;
  /** Tests only: a different tool list. */
  tools?: readonly ToolDefinition[];
}

/** Business error of a tool: becomes `isError: true` with a plain message. */
export class ToolError extends Error {
  readonly data?: unknown;
  constructor(message: string, data?: unknown) {
    super(message);
    this.name = 'ToolError';
    this.data = data;
  }
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Cache hints, mandatory on `server/discover` and `tools/list` since 2026-07-28
 * (`CacheableResult`: `ttlMs` integer ≥ 0, `cacheScope` "public" or "private"). Both results
 * are the same for all agents and only change with a deploy: public, and short so that new
 * tools show up soon after a rollout.
 * Source: https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching
 */
export const CACHE_HINTS = { ttlMs: 60_000, cacheScope: 'public' } as const;

type Id = string | number;
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function headerGetter(headers: McpHttpRequest['headers']) {
  if (headers instanceof Headers) return (name: string) => headers.get(name) ?? undefined;
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) lower.set(k.toLowerCase(), Array.isArray(v) ? v.join(', ') : v);
  }
  return (name: string) => lower.get(name.toLowerCase());
}

function json(status: number, payload: unknown, extra: Record<string, string> = {}): McpHttpResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
    body: JSON.stringify(payload),
  };
}

function rpcError(status: number, id: Id | null, code: number, message: string, data?: unknown): McpHttpResponse {
  const error: Json = { code, message };
  if (data !== undefined) error.data = data;
  return json(status, { jsonrpc: '2.0', id, error });
}

/**
 * 401 without `WWW-Authenticate` (agent keys): clients then report the error instead of
 * starting an OAuth flow.
 */
export function unauthorizedResponse(message = 'Missing, invalid or revoked API key.', rawBody?: string): McpHttpResponse {
  let id: Id | null = null;
  try {
    const parsed: unknown = rawBody ? JSON.parse(rawBody) : undefined;
    if (isObj(parsed) && (typeof parsed.id === 'string' || typeof parsed.id === 'number')) id = parsed.id;
  } catch {
    // body does not matter
  }
  return rpcError(401, id, ERR_UNAUTHORIZED, message);
}

/**
 * 401 for connectors (OAuth): with `WWW-Authenticate: Bearer resource_metadata=…`, which makes
 * claude.ai and ChatGPT start the sign-in or refresh their token.
 */
export function oauthUnauthorizedResponse(wwwAuthenticate: string, rawBody?: string): McpHttpResponse {
  const response = unauthorizedResponse('Missing, invalid or expired access token.', rawBody);
  return { ...response, headers: { ...response.headers, 'WWW-Authenticate': wwwAuthenticate } };
}

/** Reads the bearer key from `Authorization`, else `undefined`. */
export function bearerToken(headers: McpHttpRequest['headers']): string | undefined {
  const value = headerGetter(headers)('authorization');
  const match = value ? /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(value) : null;
  return match?.[1];
}

/** For the Convex HTTP action: `Request` → `McpHttpRequest`. */
export async function fromFetchRequest(request: Request): Promise<McpHttpRequest> {
  return { method: request.method, headers: request.headers, body: request.method === 'POST' ? await request.text() : '' };
}

/** For the Convex HTTP action: `McpHttpResponse` → `Response`. */
export function toFetchResponse(response: McpHttpResponse): Response {
  return new Response(response.body, { status: response.status, headers: response.headers });
}

/** Decodes `=?base64?…?=` from `Mcp-Name`/`Mcp-Param-*`. */
function decodeHeaderValue(value: string): string | undefined {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(value);
  if (!m) return value;
  try {
    const bytes = Uint8Array.from(atob(m[1]!), (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function toolResultFromValue(value: unknown): Json {
  const structured = isObj(value) ? value : { result: value ?? null };
  return { content: [{ type: 'text', text: JSON.stringify(value ?? null) }], structuredContent: structured };
}

function toolErrorResult(message: string, data?: unknown): Json {
  const text = data === undefined ? message : `${message}\n${JSON.stringify(data)}`;
  return { content: [{ type: 'text', text }], isError: true };
}

async function callTool(params: Json, deps: McpDeps): Promise<{ result?: Json; error?: [number, string] }> {
  const name = params.name;
  const rejected = async () => {
    try {
      await deps.onRejectedCall?.(typeof name === 'string' ? name : '');
    } catch (error) {
      deps.onError?.(error, typeof name === 'string' ? name : '');
    }
  };
  if (typeof name !== 'string' || name === '') {
    await rejected();
    return { error: [ERR.INVALID_PARAMS, 'params.name must be a tool name'] };
  }
  const tools = deps.tools ?? TOOLS;
  if (!isToolName(name) || !tools.some((t) => t.name === name)) {
    await rejected();
    return { error: [ERR.INVALID_PARAMS, `Unknown tool: ${name}. Call tools/list for the available tools.`] };
  }
  const args = params.arguments;
  if (args !== undefined && args !== null && !isObj(args)) {
    await rejected();
    return { error: [ERR.INVALID_PARAMS, 'params.arguments must be an object'] };
  }
  const checked = checkToolArguments(name, args ?? {});
  if (!checked.ok) {
    await rejected();
    // Per the specification invalid arguments are a tool error, so the model can correct itself.
    return { result: toolErrorResult(`Invalid arguments for ${name}:\n- ${checked.errors.join('\n- ')}`) };
  }
  try {
    const value = await deps.callTool(name, checked.value, { agent: deps.agent });
    return { result: toolResultFromValue(value) };
  } catch (error) {
    if (error instanceof ToolError) return { result: toolErrorResult(error.message, error.data) };
    deps.onError?.(error, name);
    return {
      result: toolErrorResult(
        `Internal error in ${name}. The change was not applied or was rolled back; retrying with the same requestId is safe.`,
      ),
    };
  }
}

function initializeResult(version: string, deps: McpDeps): Json {
  return {
    protocolVersion: version,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, title: 'Selfbound', version: deps.serverVersion },
    instructions: INSTRUCTIONS,
  };
}

/**
 * Handles an HTTP request to the MCP endpoint.
 * Always answers with JSON or without a body (202/405), never with SSE.
 */
export async function handleMcpHttp(request: McpHttpRequest, deps: McpDeps): Promise<McpHttpResponse> {
  const header = headerGetter(request.headers);

  if (request.method.toUpperCase() !== 'POST') {
    // GET (SSE stream) and DELETE (end session) are not supported here.
    return { status: 405, headers: { Allow: 'POST' }, body: null };
  }

  const origin = header('origin');
  if (origin !== undefined && !(deps.allowedOrigins ?? []).includes(origin)) {
    return rpcError(403, null, ERR.INVALID_REQUEST, `Origin not allowed: ${origin}`);
  }

  if (request.body.length > MAX_BODY_BYTES) {
    return rpcError(413, null, ERR.INVALID_REQUEST, `Request body too large (max ${MAX_BODY_BYTES} bytes)`);
  }

  // Content-Type and Accept are handled leniently on purpose: we always answer with
  // application/json, which every client understands per the specification.
  let message: unknown;
  try {
    message = JSON.parse(request.body);
  } catch {
    return rpcError(400, null, ERR.PARSE, 'Parse error: body is not valid JSON');
  }
  if (Array.isArray(message)) {
    return rpcError(400, null, ERR.INVALID_REQUEST, 'Batch requests are not supported; send one JSON-RPC message per POST');
  }
  if (!isObj(message) || message.jsonrpc !== '2.0') {
    return rpcError(400, null, ERR.INVALID_REQUEST, 'Invalid Request: expected a JSON-RPC 2.0 object');
  }

  const hasId = 'id' in message && message.id !== undefined;
  const method = message.method;

  // Client responses (to server requests, which never happen here): accept.
  if (method === undefined && hasId && ('result' in message || 'error' in message)) {
    return { status: 202, headers: {}, body: null };
  }
  if (typeof method !== 'string') {
    return rpcError(400, null, ERR.INVALID_REQUEST, 'Invalid Request: method must be a string');
  }
  // Notifications (no id): accept, nothing to do.
  if (!hasId) return { status: 202, headers: {}, body: null };

  const id = message.id;
  if (typeof id !== 'string' && !(typeof id === 'number' && Number.isFinite(id))) {
    return rpcError(400, null, ERR.INVALID_REQUEST, 'Invalid Request: id must be a string or number');
  }
  const params = message.params === undefined ? {} : message.params;
  if (!isObj(params)) return rpcError(400, id, ERR.INVALID_PARAMS, 'params must be an object');

  const meta = isObj(params._meta) ? params._meta : undefined;
  const modernVersion = meta?.['io.modelcontextprotocol/protocolVersion'];
  const headerVersion = header('mcp-protocol-version');

  // ---- Legacy-Handshake
  if (method === 'initialize') {
    const requested = params.protocolVersion;
    if (typeof requested !== 'string') {
      return rpcError(200, id, ERR.INVALID_PARAMS, 'initialize: params.protocolVersion must be a string');
    }
    const version = (LEGACY_VERSIONS as readonly string[]).includes(requested) ? requested : LEGACY_VERSIONS[0];
    return json(200, { jsonrpc: '2.0', id, result: initializeResult(version, deps) });
  }

  // ---- Modern: version per request
  if (modernVersion !== undefined) {
    if (typeof modernVersion !== 'string' || !(MODERN_VERSIONS as readonly string[]).includes(modernVersion)) {
      return rpcError(400, id, ERR.UNSUPPORTED_VERSION, 'Unsupported protocol version', {
        supported: SUPPORTED_VERSIONS,
        requested: modernVersion,
      });
    }
    if (headerVersion !== modernVersion) {
      return rpcError(
        400,
        id,
        ERR.HEADER_MISMATCH,
        `Header mismatch: MCP-Protocol-Version header ${JSON.stringify(headerVersion ?? null)} does not match body value ${JSON.stringify(modernVersion)}`,
      );
    }
    const headerMethod = header('mcp-method');
    if (headerMethod !== method) {
      return rpcError(
        400,
        id,
        ERR.HEADER_MISMATCH,
        `Header mismatch: Mcp-Method header ${JSON.stringify(headerMethod ?? null)} does not match body value ${JSON.stringify(method)}`,
      );
    }
    if (method === 'tools/call') {
      const rawName = header('mcp-name');
      const headerName = rawName === undefined ? undefined : decodeHeaderValue(rawName);
      if (headerName !== params.name) {
        return rpcError(
          400,
          id,
          ERR.HEADER_MISMATCH,
          `Header mismatch: Mcp-Name header ${JSON.stringify(headerName ?? null)} does not match body value ${JSON.stringify(params.name ?? null)}`,
        );
      }
    }
    if (!isObj(meta?.['io.modelcontextprotocol/clientCapabilities'])) {
      return rpcError(400, id, ERR.INVALID_PARAMS, 'params._meta["io.modelcontextprotocol/clientCapabilities"] is required');
    }
    const complete = (result: Json) =>
      json(200, {
        jsonrpc: '2.0',
        id,
        result: {
          resultType: 'complete',
          ...result,
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: deps.serverVersion } },
        },
      });
    switch (method) {
      case 'server/discover':
        return complete({
          supportedVersions: [...MODERN_VERSIONS],
          capabilities: { tools: { listChanged: false } },
          instructions: INSTRUCTIONS,
          ...CACHE_HINTS,
        });
      case 'ping':
        return complete({});
      case 'tools/list':
        return complete({ tools: deps.tools ?? TOOLS, ...CACHE_HINTS });
      case 'tools/call': {
        const outcome = await callTool(params, deps);
        if (outcome.error) return rpcError(200, id, outcome.error[0], outcome.error[1]);
        return complete(outcome.result!);
      }
      default:
        return rpcError(404, id, ERR.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  // ---- Legacy after the handshake
  if (headerVersion !== undefined && !(LEGACY_VERSIONS as readonly string[]).includes(headerVersion)) {
    if ((MODERN_VERSIONS as readonly string[]).includes(headerVersion)) {
      return rpcError(
        400,
        id,
        ERR.INVALID_PARAMS,
        `MCP-Protocol-Version ${headerVersion} requires params._meta["io.modelcontextprotocol/protocolVersion"]`,
      );
    }
    return rpcError(400, id, ERR.UNSUPPORTED_VERSION, 'Unsupported protocol version', {
      supported: SUPPORTED_VERSIONS,
      requested: headerVersion,
    });
  }
  // Without the header the specification assumes 2025-03-26. For the methods here all
  // legacy versions behave the same.
  switch (method) {
    case 'ping':
      return json(200, { jsonrpc: '2.0', id, result: {} });
    case 'tools/list':
      return json(200, { jsonrpc: '2.0', id, result: { tools: deps.tools ?? TOOLS } });
    case 'tools/call': {
      const outcome = await callTool(params, deps);
      if (outcome.error) return rpcError(200, id, outcome.error[0], outcome.error[1]);
      return json(200, { jsonrpc: '2.0', id, result: outcome.result });
    }
    default:
      return rpcError(200, id, ERR.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}
