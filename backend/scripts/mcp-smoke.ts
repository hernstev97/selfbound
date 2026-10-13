// Smoke test for the XLR8 MCP endpoint with the official MCP SDK client.
//
// Flow: initialize → tools/list → one read call (default: list_teams).
// Prints only counts and names, no content from the data.
//
// Usage (Node 24, no build):
//   XLR8_MCP_KEY=xlr8_… node backend/scripts/mcp-smoke.ts --url http://127.0.0.1:13411/mcp
//   node backend/scripts/mcp-smoke.ts --url … --key-file ~/.config/xlr8/agent-key [--tool list_teams] [--args '{}']
//
// Never pass the key as an argument (it would show up in the process list).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface SmokeOptions {
  url: string;
  key: string;
  tool?: string;
  args?: Record<string, unknown>;
}

export interface SmokeResult {
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  instructions: boolean;
  tools: string[];
  call: { tool: string; isError: boolean; textBytes: number; structuredKeys: string[] };
}

export async function runMcpSmoke(options: SmokeOptions): Promise<SmokeResult> {
  const tool = options.tool ?? 'list_teams';
  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: { headers: { Authorization: `Bearer ${options.key}` } },
  });
  const client = new Client({ name: 'xlr8-mcp-smoke', version: '1.0.0' });
  await client.connect(transport);
  try {
    const info = client.getServerVersion();
    const listed = await client.listTools();
    const result = await client.callTool({ name: tool, arguments: options.args ?? {} });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content.map((c) => (c && typeof c === 'object' && 'text' in c ? String(c.text) : '')).join('');
    const structured = result.structuredContent;
    return {
      serverName: info?.name,
      serverVersion: info?.version,
      protocolVersion: transport.protocolVersion,
      instructions: Boolean(client.getInstructions()),
      tools: listed.tools.map((t) => t.name),
      call: {
        tool,
        isError: result.isError === true,
        textBytes: new TextEncoder().encode(text).length,
        structuredKeys: structured && typeof structured === 'object' ? Object.keys(structured) : [],
      },
    };
  } finally {
    await client.close();
  }
}

function option(argv: string[], name: string) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]) {
  const url = option(argv, 'url');
  const keyFile = option(argv, 'key-file')?.replace(/^~(?=\/)/, homedir());
  const key = keyFile ? readFileSync(keyFile, 'utf8').trim() : process.env.XLR8_MCP_KEY;
  if (!url || !key) {
    console.error('Usage: XLR8_MCP_KEY=… node backend/scripts/mcp-smoke.ts --url <MCP URL> [--tool name] [--args JSON]');
    console.error('       or --key-file <file> instead of XLR8_MCP_KEY');
    process.exit(2);
  }
  const rawArgs = option(argv, 'args');
  const result = await runMcpSmoke({ url, key, tool: option(argv, 'tool'), args: rawArgs ? JSON.parse(rawArgs) : {} });
  console.log(`Server:        ${result.serverName} ${result.serverVersion}`);
  console.log(`Protocol:      ${result.protocolVersion}`);
  console.log(`Instructions:  ${result.instructions ? 'yes' : 'no'}`);
  console.log(`Tools (${result.tools.length}):    ${result.tools.join(', ')}`);
  console.log(
    `Call:          ${result.call.tool} → ${result.call.isError ? 'ERROR (isError)' : 'ok'}, ${result.call.textBytes} bytes, fields: ${result.call.structuredKeys.join(', ') || '–'}`,
  );
  if (result.call.isError) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`MCP smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
