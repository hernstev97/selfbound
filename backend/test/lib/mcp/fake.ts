// Fake tools and a small Node HTTP server for the MCP tests.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  bearerToken,
  handleMcpHttp,
  ToolError,
  unauthorizedResponse,
  type McpDeps,
  type McpHttpRequest,
} from '../../../convex/lib/mcp/protocol';

export const AGENT = { id: 'agent_1', name: 'Test agent' };
export const KEY = 'xlr8_synthetic_test_key';

export interface FakeCall {
  name: string;
  args: unknown;
}

export function fakeDeps(calls: FakeCall[] = []): McpDeps {
  return {
    agent: AGENT,
    serverVersion: '0.0.0-test',
    async callTool(name, args) {
      calls.push({ name, args });
      switch (name) {
        case 'list_teams':
          return { teams: [{ key: 'ACME', name: 'Acme', dormant: false }] };
        case 'get_issue':
          throw new ToolError('Issue ACME-999 not found.', { identifier: 'ACME-999' });
        case 'search_issues':
          throw new Error('Database exploded (must not reach the agent)');
        case 'get_current_sprint':
          return null;
        default:
          return { ok: true, name };
      }
    },
  };
}

export function post(body: unknown, headers: Record<string, string> = {}): McpHttpRequest {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

/** Starts a local HTTP server (127.0.0.1, free port) that serves the MCP endpoint at /mcp. */
export async function startServer(deps: McpDeps): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const request: McpHttpRequest = { method: req.method ?? 'GET', headers: req.headers, body };
    const response =
      bearerToken(request.headers) === KEY ? await handleMcpHttp(request, deps) : unauthorizedResponse(undefined, body);
    res.writeHead(response.status, response.headers);
    res.end(response.body ?? undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    server,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
