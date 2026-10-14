// The official MCP SDK client talks to our protocol layer over real HTTP.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { runMcpSmoke } from '../../../scripts/mcp-smoke';
import { fakeDeps, KEY, startServer, type FakeCall } from './fake';

const calls: FakeCall[] = [];
let server: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  server = await startServer(fakeDeps(calls));
});
afterAll(async () => {
  await server.close();
});

describe('MCP SDK client against handleMcpHttp', () => {
  test('smoke script: initialize, tools/list, read call', async () => {
    const result = await runMcpSmoke({ url: server.url, key: KEY });
    expect(result).toMatchObject({
      serverName: 'selfbound',
      serverVersion: '0.0.0-test',
      protocolVersion: '2025-11-25',
      instructions: true,
      call: { tool: 'list_teams', isError: false, structuredKeys: ['teams'] },
    });
    expect(result.tools).toHaveLength(19);
    expect(calls.at(-1)).toEqual({ name: 'list_teams', args: { includeDormant: true } });
  });

  test('business errors and invalid arguments arrive as isError', async () => {
    const client = new Client({ name: 'vitest', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } }),
    );
    const notFound = await client.callTool({ name: 'get_issue', arguments: { identifier: 'ACME-999' } });
    expect(notFound.isError).toBe(true);
    const invalid = await client.callTool({ name: 'list_issues', arguments: { limit: 1000 } });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid.content)).toContain('limit: must be <= 100');
    await expect(client.ping()).resolves.toBeDefined();
    await client.close();
  });

  test('wrong key: 401, the client does not start an OAuth flow', async () => {
    await expect(runMcpSmoke({ url: server.url, key: 'xlr8_wrong' })).rejects.toMatchObject({
      code: 401,
      message: expect.stringContaining('API key'),
    });
  });

  test('GET on the endpoint: 405 with Allow: POST', async () => {
    const r = await fetch(server.url, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'text/event-stream' } });
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('POST');
  });
});
