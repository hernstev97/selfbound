import { describe, expect, test } from 'vitest';
import {
  bearerToken,
  ERR,
  handleMcpHttp,
  INSTRUCTIONS,
  LEGACY_VERSIONS,
  unauthorizedResponse,
  type McpHttpResponse,
} from '../../../convex/lib/mcp/protocol';
import { TOOLS } from '../../../convex/lib/mcp/tools';
import { fakeDeps, post, type FakeCall } from './fake';

const body = (r: McpHttpResponse) => JSON.parse(r.body ?? 'null');
const call = (name: string, args?: unknown, id: number | string = 1, headers: Record<string, string> = {}) =>
  post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, { 'mcp-protocol-version': '2025-11-25', ...headers });

describe('legacy lifecycle (initialize)', () => {
  test.each(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'])('initialize with %s adopts the version', async (v) => {
    const r = await handleMcpHttp(
      post({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
      fakeDeps(),
    );
    expect(r.status).toBe(200);
    expect(r.headers['Content-Type']).toBe('application/json');
    expect(r.headers['Mcp-Session-Id']).toBeUndefined();
    expect(body(r)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: v,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'xlr8', title: 'XLR8', version: '0.0.0-test' },
        instructions: INSTRUCTIONS,
      },
    });
  });

  test('unknown version: the server answers with its newest legacy version', async () => {
    for (const v of ['1999-01-01', '2030-01-01', '2026-07-28']) {
      const r = await handleMcpHttp(post({ jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocolVersion: v } }), fakeDeps());
      expect(body(r).result.protocolVersion).toBe(LEGACY_VERSIONS[0]);
    }
  });

  test('initialize without protocolVersion: -32602', async () => {
    const r = await handleMcpHttp(post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), fakeDeps());
    expect(body(r).error.code).toBe(ERR.INVALID_PARAMS);
  });

  test('notifications/initialized and other notifications: 202 without body', async () => {
    for (const method of ['notifications/initialized', 'notifications/cancelled', 'notifications/roots/list_changed']) {
      const r = await handleMcpHttp(post({ jsonrpc: '2.0', method }), fakeDeps());
      expect(r).toEqual({ status: 202, headers: {}, body: null });
    }
  });

  test('client responses: 202', async () => {
    const r = await handleMcpHttp(post({ jsonrpc: '2.0', id: 5, result: {} }), fakeDeps());
    expect(r.status).toBe(202);
  });

  test('ping', async () => {
    const r = await handleMcpHttp(post({ jsonrpc: '2.0', id: 7, method: 'ping' }), fakeDeps());
    expect(body(r)).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
  });

  test('tools/list returns all tools with schema and annotations', async () => {
    const r = await handleMcpHttp(post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), fakeDeps());
    const tools = body(r).result.tools;
    expect(tools.map((t: { name: string }) => t.name)).toEqual([
      'search_issues',
      'list_issues',
      'get_issue',
      'create_issues',
      'update_issue',
      'set_status',
      'move_issues',
      'add_comment',
      'get_current_sprint',
      'list_teams',
      'list_projects',
      'list_labels',
      'list_statuses',
      'search_articles',
      'list_articles',
      'get_article',
      'create_article',
      'update_article',
    ]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(typeof t.description).toBe('string');
      expect(typeof t.annotations.readOnlyHint).toBe('boolean');
    }
  });
});

describe('tools/call', () => {
  test('ok: text as JSON plus structuredContent, arguments normalized', async () => {
    const calls: FakeCall[] = [];
    const r = await handleMcpHttp(call('list_teams', {}), fakeDeps(calls));
    expect(r.status).toBe(200);
    const result = body(r).result;
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ teams: [{ key: 'ACME', name: 'Acme', dormant: false }] });
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect(calls).toEqual([{ name: 'list_teams', args: { includeDormant: true } }]);
  });

  test('without arguments, {} applies', async () => {
    const calls: FakeCall[] = [];
    const r = await handleMcpHttp(
      post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_current_sprint' } }),
      fakeDeps(calls),
    );
    expect(body(r).result.structuredContent).toEqual({ result: null });
    expect(calls).toEqual([{ name: 'get_current_sprint', args: {} }]);
  });

  test('business error: isError with a plain message', async () => {
    const r = await handleMcpHttp(call('get_issue', { identifier: 'acme-999' }), fakeDeps());
    const result = body(r).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Issue ACME-999 not found.');
  });

  test('unexpected error: isError without internal details', async () => {
    const errors: unknown[] = [];
    const deps = { ...fakeDeps(), onError: (e: unknown) => errors.push(e) };
    const r = await handleMcpHttp(call('search_issues', { q: 'x' }), deps);
    const result = body(r).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('exploded');
    expect(errors).toHaveLength(1);
  });

  test('invalid arguments: isError with all errors, the tool is not called', async () => {
    const calls: FakeCall[] = [];
    const r = await handleMcpHttp(call('list_issues', { limit: 500, filter: 'mine', colour: 'red' }), fakeDeps(calls));
    const result = body(r).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('limit: must be <= 100');
    expect(result.content[0].text).toContain('filter: "mine" is not one of');
    expect(result.content[0].text).toContain('colour: unknown field');
    expect(calls).toEqual([]);
  });

  test('unknown tool, missing name, arguments not an object: -32602', async () => {
    for (const params of [{ name: 'delete_everything' }, {}, { name: 'list_teams', arguments: [1] }]) {
      const r = await handleMcpHttp(post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params }), fakeDeps());
      expect(r.status).toBe(200);
      expect(body(r).error.code).toBe(ERR.INVALID_PARAMS);
    }
  });
});

describe('transport and JSON-RPC errors', () => {
  test('GET, DELETE and other methods: 405 with Allow: POST', async () => {
    for (const method of ['GET', 'DELETE', 'PUT', 'OPTIONS']) {
      const r = await handleMcpHttp({ method, headers: { accept: 'text/event-stream' }, body: '' }, fakeDeps());
      expect(r.status).toBe(405);
      expect(r.headers.Allow).toBe('POST');
      expect(r.body).toBeNull();
    }
  });

  test('broken JSON: -32700', async () => {
    const r = await handleMcpHttp(post('{"jsonrpc": "2.0", "id": 1,'), fakeDeps());
    expect(r.status).toBe(400);
    expect(body(r)).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: ERR.PARSE } });
  });

  test('batch arrays are rejected', async () => {
    const r = await handleMcpHttp(post([{ jsonrpc: '2.0', id: 1, method: 'ping' }]), fakeDeps());
    expect(r.status).toBe(400);
    expect(body(r).error.code).toBe(ERR.INVALID_REQUEST);
  });

  test('not JSON-RPC 2.0, broken id or method: -32600', async () => {
    for (const m of [{ id: 1, method: 'ping' }, { jsonrpc: '1.0', id: 1, method: 'ping' }, '"text"', { jsonrpc: '2.0', id: null, method: 'ping' }, { jsonrpc: '2.0', id: 1, method: 5 }]) {
      const r = await handleMcpHttp(post(m), fakeDeps());
      expect(r.status).toBe(400);
      expect(body(r).error.code).toBe(ERR.INVALID_REQUEST);
    }
  });

  test('params not an object: -32602', async () => {
    const r = await handleMcpHttp(post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: [1] }), fakeDeps());
    expect(body(r).error.code).toBe(ERR.INVALID_PARAMS);
  });

  test('unknown method: -32601', async () => {
    const r = await handleMcpHttp(post({ jsonrpc: '2.0', id: 9, method: 'resources/list' }), fakeDeps());
    expect(r.status).toBe(200);
    expect(body(r)).toMatchObject({ id: 9, error: { code: ERR.METHOD_NOT_FOUND } });
  });

  test('Content-Type and Accept are handled leniently', async () => {
    const r = await handleMcpHttp(
      { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) },
      fakeDeps(),
    );
    expect(r.status).toBe(200);
    expect(r.headers['Content-Type']).toBe('application/json');
  });

  test('unknown protocol version in the header: 400', async () => {
    const r = await handleMcpHttp(
      post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-protocol-version': '1999-01-01' }),
      fakeDeps(),
    );
    expect(r.status).toBe(400);
    expect(body(r).error.code).toBe(ERR.UNSUPPORTED_VERSION);
  });

  test('without the header a legacy version applies (2025-03-26)', async () => {
    const r = await handleMcpHttp(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), fakeDeps());
    expect(r.status).toBe(200);
  });

  test('Origin: allowed values only', async () => {
    const msg = { jsonrpc: '2.0', id: 1, method: 'ping' };
    expect((await handleMcpHttp(post(msg, { origin: 'https://evil.example' }), fakeDeps())).status).toBe(403);
    const deps = { ...fakeDeps(), allowedOrigins: ['https://xlr8.example.com'] };
    expect((await handleMcpHttp(post(msg, { origin: 'https://xlr8.example.com' }), deps)).status).toBe(200);
  });

  test('401 without WWW-Authenticate, with the id from the body', () => {
    const r = unauthorizedResponse(undefined, JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'initialize' }));
    expect(r.status).toBe(401);
    expect(Object.keys(r.headers).map((h) => h.toLowerCase())).not.toContain('www-authenticate');
    expect(body(r)).toMatchObject({ jsonrpc: '2.0', id: 42, error: { message: expect.stringContaining('API key') } });
    expect(body(unauthorizedResponse('nope', 'not json')).id).toBeNull();
  });

  test('bearerToken', () => {
    expect(bearerToken({ Authorization: 'Bearer xlr8_abc' })).toBe('xlr8_abc');
    expect(bearerToken({ authorization: 'bearer   xlr8_abc ' })).toBe('xlr8_abc');
    expect(bearerToken(new Headers({ authorization: 'Bearer xlr8_x' }))).toBe('xlr8_x');
    expect(bearerToken({ authorization: 'Basic abc' })).toBeUndefined();
    expect(bearerToken({})).toBeUndefined();
  });
});

describe('modern protocol (2026-07-28, no handshake)', () => {
  const V = '2026-07-28';
  const meta = { 'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': {} };
  const modern = (method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    post(
      { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { ...meta, ...((params._meta as object) ?? {}) } } },
      { 'mcp-protocol-version': V, 'mcp-method': method, ...headers },
    );

  test('server/discover', async () => {
    const r = await handleMcpHttp(modern('server/discover'), fakeDeps());
    expect(r.status).toBe(200);
    expect(body(r).result).toEqual({
      resultType: 'complete',
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: { listChanged: false } },
      instructions: INSTRUCTIONS,
      ttlMs: 60_000,
      cacheScope: 'public',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'xlr8', version: '0.0.0-test' } },
    });
  });

  test('tools/list and tools/call with resultType', async () => {
    const list = body(await handleMcpHttp(modern('tools/list'), fakeDeps())).result;
    expect(list.resultType).toBe('complete');
    expect(list.tools).toHaveLength(TOOLS.length);
    const r = await handleMcpHttp(modern('tools/call', { name: 'list_teams', arguments: {} }, { 'mcp-name': 'list_teams' }), fakeDeps());
    expect(body(r).result).toMatchObject({ resultType: 'complete', structuredContent: { teams: expect.any(Array) } });
  });

  // Contract test: required result fields per schema 2026-07-28
  // (https://modelcontextprotocol.io/specification/2026-07-28/schema). A client that does not
  // find them rejects the whole response (this happened with `tools/list`).
  describe('contract: required fields per method', () => {
    type Kind = 'string' | 'array' | 'object' | 'nonNegInteger' | 'cacheScope';
    // Result: resultType. CacheableResult (server/discover, tools/list) also ttlMs, cacheScope.
    const CACHEABLE: Record<string, Kind> = { resultType: 'string', ttlMs: 'nonNegInteger', cacheScope: 'cacheScope' };
    const CONTRACT: { method: string; params?: Record<string, unknown>; headers?: Record<string, string>; required: Record<string, Kind> }[] = [
      { method: 'server/discover', required: { ...CACHEABLE, supportedVersions: 'array', capabilities: 'object' } },
      { method: 'tools/list', required: { ...CACHEABLE, tools: 'array' } },
      {
        method: 'tools/call',
        params: { name: 'list_teams', arguments: {} },
        headers: { 'mcp-name': 'list_teams' },
        required: { resultType: 'string', content: 'array' },
      },
      { method: 'tools/call', params: { name: 'get_issue', arguments: { identifier: 'ACME-999' } }, headers: { 'mcp-name': 'get_issue' }, required: { resultType: 'string', content: 'array' } },
      { method: 'ping', required: { resultType: 'string' } },
    ];
    const matches = (kind: Kind, v: unknown) => {
      switch (kind) {
        case 'string':
          return typeof v === 'string';
        case 'array':
          return Array.isArray(v);
        case 'object':
          return typeof v === 'object' && v !== null && !Array.isArray(v);
        case 'nonNegInteger':
          return Number.isInteger(v) && (v as number) >= 0;
        case 'cacheScope':
          return v === 'public' || v === 'private';
      }
    };

    test.each(CONTRACT)('$method ($params.name) returns all required fields', async ({ method, params, headers, required }) => {
      const r = await handleMcpHttp(modern(method, params, headers), fakeDeps());
      expect(r.status).toBe(200);
      const result = body(r).result;
      for (const [field, kind] of Object.entries(required)) {
        expect(matches(kind, result[field]), `${method}: required field ${field} (${kind}) is missing or has the wrong type: ${JSON.stringify(result[field])}`).toBe(true);
      }
      expect(result.resultType).toBe('complete');
    });

    test('cache hints only where required (not on ping and tools/call)', async () => {
      for (const { method, params, headers } of CONTRACT.filter((c) => !('ttlMs' in c.required))) {
        const result = body(await handleMcpHttp(modern(method, params, headers), fakeDeps())).result;
        expect(result.ttlMs).toBeUndefined();
        expect(result.cacheScope).toBeUndefined();
      }
    });

    test('tools/list: every tool has name and inputSchema', async () => {
      const { tools } = body(await handleMcpHttp(modern('tools/list'), fakeDeps())).result;
      for (const t of tools) {
        expect(typeof t.name).toBe('string');
        expect(t.inputSchema).toMatchObject({ type: 'object' });
      }
    });
  });

  test('Mcp-Name also base64-encoded', async () => {
    const encoded = `=?base64?${btoa('list_teams')}?=`;
    const r = await handleMcpHttp(modern('tools/call', { name: 'list_teams' }, { 'mcp-name': encoded }), fakeDeps());
    expect(r.status).toBe(200);
  });

  test('headers do not match the body: 400 HeaderMismatch', async () => {
    const cases = [
      modern('tools/list', {}, { 'mcp-protocol-version': '2025-11-25' }),
      modern('tools/list', {}, { 'mcp-method': 'tools/call' }),
      post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } }, { 'mcp-protocol-version': V }),
      modern('tools/call', { name: 'list_teams' }, { 'mcp-name': 'get_issue' }),
      modern('tools/call', { name: 'list_teams' }),
    ];
    for (const req of cases) {
      const r = await handleMcpHttp(req, fakeDeps());
      expect(r.status).toBe(400);
      expect(body(r).error.code).toBe(ERR.HEADER_MISMATCH);
    }
  });

  test('unsupported version: 400 with list', async () => {
    const r = await handleMcpHttp(
      post(
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } } },
        { 'mcp-protocol-version': '2099-01-01', 'mcp-method': 'tools/list' },
      ),
      fakeDeps(),
    );
    expect(r.status).toBe(400);
    expect(body(r).error).toMatchObject({
      code: ERR.UNSUPPORTED_VERSION,
      data: { supported: expect.arrayContaining(['2026-07-28', '2025-11-25']), requested: '2099-01-01' },
    });
  });

  test('missing clientCapabilities: 400 -32602', async () => {
    const r = await handleMcpHttp(
      post(
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': V } } },
        { 'mcp-protocol-version': V, 'mcp-method': 'tools/list' },
      ),
      fakeDeps(),
    );
    expect(r.status).toBe(400);
    expect(body(r).error.code).toBe(ERR.INVALID_PARAMS);
  });

  test('modern header without _meta: 400 -32602 (instead of silently legacy)', async () => {
    const r = await handleMcpHttp(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-protocol-version': V }), fakeDeps());
    expect(r.status).toBe(400);
    expect(body(r).error.code).toBe(ERR.INVALID_PARAMS);
  });

  test('unknown method: 404 -32601', async () => {
    const r = await handleMcpHttp(modern('resources/list'), fakeDeps());
    expect(r.status).toBe(404);
    expect(body(r).error.code).toBe(ERR.METHOD_NOT_FOUND);
  });
});
