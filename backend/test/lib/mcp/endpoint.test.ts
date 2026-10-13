import { describe, expect, test } from 'vitest';
import { KEY_FORMAT, mcpEndpoint, type McpBackend } from '../../../convex/lib/mcp/endpoint';
import { post } from './fake';

// POST /mcp without Convex: dispatch to count/read/write, errors → responses, including
// counting, the key format and a key revoked between sign-in and call (→ 401).

const KEY = `xlr8_${'A'.repeat(43)}`;
const denied = () => Object.assign(new Error('access_denied'), { data: { code: 'access_denied', message: 'revoked' } });

function backend(overrides: Partial<McpBackend> = {}) {
  const log: string[] = [];
  const b: McpBackend = {
    sha256: async (text) => `hash:${text}`,
    today: () => '2026-10-09',
    authenticate: async () => {
      log.push('authenticate');
      return { agentId: 'a1', name: 'Test' };
    },
    countCall: async () => log.push('countCall'),
    read: async (_hash, tool, _args, today) => {
      log.push(`read:${tool}:${today}`);
      return { teams: [] };
    },
    call: async (_hash, tool) => {
      log.push(`call:${tool}`);
      return { value: { ok: true } };
    },
    countFailedCall: async () => log.push('countFailedCall'),
    ...overrides,
  };
  return { b, log };
}

const toolCall = (name: string, args: unknown, key = KEY) =>
  post(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { authorization: `Bearer ${key}`, 'mcp-protocol-version': '2025-11-25' },
  );

describe('MCP endpoint', () => {
  test('the key format is checked before any lookup', async () => {
    expect(KEY_FORMAT.test(KEY)).toBe(true);
    const { b, log } = backend();
    for (const key of ['xlr8_short', `xlr8_${'A'.repeat(44)}`, `sk_${'A'.repeat(43)}`, `xlr8_${'A'.repeat(42)}!`]) {
      const r = await mcpEndpoint(toolCall('list_teams', {}, key), b, 't');
      expect(r.status).toBe(401);
    }
    expect(log).toEqual([]);
  });

  test('read tool: count first, then query with the day; write tool: one mutation', async () => {
    const { b, log } = backend();
    expect((await mcpEndpoint(toolCall('list_teams', {}), b, 't')).status).toBe(200);
    expect((await mcpEndpoint(toolCall('add_comment', { requestId: 'req-12345678', identifier: 'ACME-1', body: 'x' }), b, 't')).status).toBe(200);
    expect(log).toEqual(['authenticate', 'countCall', 'read:list_teams:2026-10-09', 'authenticate', 'call:add_comment']);
  });

  test('invalid arguments and unknown tools are counted', async () => {
    const { b, log } = backend();
    const invalid = await mcpEndpoint(toolCall('list_issues', { limit: 9999 }), b, 't');
    expect(JSON.parse(invalid.body!).result.isError).toBe(true);
    const unknown = await mcpEndpoint(toolCall('drop_database', {}), b, 't');
    expect(JSON.parse(unknown.body!).error).toBeDefined();
    expect(log.filter((x) => x === 'countFailedCall')).toHaveLength(2);
  });

  test('revoked between sign-in and call → 401 instead of a tool error (read and write)', async () => {
    const write = backend({ call: async () => Promise.reject(denied()) });
    const w = await mcpEndpoint(toolCall('add_comment', { requestId: 'req-12345678', identifier: 'ACME-1', body: 'x' }), write.b, 't');
    expect(w.status).toBe(401);
    expect(write.log).not.toContain('countFailedCall');
    const read = backend({ read: async () => Promise.reject(denied()) });
    expect((await mcpEndpoint(toolCall('list_teams', {}), read.b, 't')).status).toBe(401);
    const count = backend({ countCall: async () => Promise.reject(denied()) });
    expect((await mcpEndpoint(toolCall('list_teams', {}), count.b, 't')).status).toBe(401);
  });

  test('business write error: tool error and counted afterwards; rate limit not counted', async () => {
    const failing = backend({
      call: async () => Promise.reject(Object.assign(new Error('x'), { data: { code: 'not_found', message: 'Issue missing' } })),
    });
    const r = await mcpEndpoint(toolCall('add_comment', { requestId: 'req-12345678', identifier: 'ACME-1', body: 'x' }), failing.b, 't');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body!).result).toMatchObject({ isError: true });
    expect(failing.log).toContain('countFailedCall');
    const limited = backend({
      call: async () => Promise.reject(Object.assign(new Error('x'), { data: { code: 'rate_limited', message: 'too many' } })),
    });
    await mcpEndpoint(toolCall('add_comment', { requestId: 'req-12345678', identifier: 'ACME-1', body: 'x' }), limited.b, 't');
    expect(limited.log).not.toContain('countFailedCall');
  });

  describe('OAuth (connectors)', () => {
    const ACCESS = `xlr8_at_${'B'.repeat(43)}`;
    const challenge = (error?: 'invalid_token') => `Bearer resource_metadata="https://x/.well-known/oauth-protected-resource/mcp"${error ? `, error="${error}"` : ''}`;
    const raw = (headers: Record<string, string> = {}) =>
      post({ jsonrpc: '2.0', id: 7, method: 'ping' }, { 'mcp-protocol-version': '2025-11-25', ...headers });

    test('without bearer or with a foreign token: 401 with WWW-Authenticate, no lookup', async () => {
      const { b, log } = backend({ challenge });
      const none = await mcpEndpoint(raw(), b, 't');
      expect(none.status).toBe(401);
      expect(none.headers['WWW-Authenticate']).toBe(challenge());
      expect(JSON.parse(none.body!)).toMatchObject({ id: 7, error: { message: expect.stringContaining('access token') } });
      const foreign = await mcpEndpoint(raw({ authorization: 'Bearer sk-whatever' }), b, 't');
      expect(foreign.headers['WWW-Authenticate']).toBe(challenge('invalid_token'));
      expect(log).toEqual([]);
    });

    test('agent keys keep the plain behaviour: 401 without WWW-Authenticate', async () => {
      const { b } = backend({ challenge, authenticate: async () => Promise.reject(denied()) });
      for (const key of ['xlr8_wrong', KEY]) {
        const r = await mcpEndpoint(toolCall('list_teams', {}, key), b, 't');
        expect(r.status).toBe(401);
        expect(r.headers['WWW-Authenticate']).toBeUndefined();
        expect(r.body).toContain('API key');
      }
    });

    test('access token: sign-in with time; invalid or revoked → invalid_token', async () => {
      const seen: unknown[] = [];
      const ok = backend({
        challenge,
        authenticate: async (hash, now) => {
          seen.push(hash, typeof now);
          return { agentId: 'c1', name: 'claude.ai' };
        },
      });
      expect((await mcpEndpoint(toolCall('list_teams', {}, ACCESS), ok.b, 't')).status).toBe(200);
      expect(seen).toEqual([`hash:${ACCESS}`, 'number']);
      const bad = backend({ challenge, authenticate: async () => Promise.reject(denied()) });
      const r = await mcpEndpoint(toolCall('list_teams', {}, ACCESS), bad.b, 't');
      expect(r.status).toBe(401);
      expect(r.headers['WWW-Authenticate']).toBe(challenge('invalid_token'));
      const revoked = backend({ challenge, countCall: async () => Promise.reject(denied()) });
      const late = await mcpEndpoint(toolCall('list_teams', {}, ACCESS), revoked.b, 't');
      expect(late.headers['WWW-Authenticate']).toBe(challenge('invalid_token'));
    });

    test('OAuth off (no challenge): plain 401, also for access tokens', async () => {
      const { b, log } = backend();
      for (const r of [await mcpEndpoint(raw(), b, 't'), await mcpEndpoint(toolCall('list_teams', {}, ACCESS), b, 't')]) {
        expect(r.status).toBe(401);
        expect(r.headers['WWW-Authenticate']).toBeUndefined();
      }
      expect(log).toEqual([]);
    });
  });
});
