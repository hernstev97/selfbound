// MCP integration test: the official MCP SDK client against the real local endpoint.
// initialize, tools/list, list_issues, create_issues twice with the same requestId → one issue,
// revoked key → 401 without OAuth challenge (key clients never start OAuth).

import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../convex/_generated/api.js';
import { runMcpSmoke } from '../../scripts/mcp-smoke.ts';

export async function mcpSuite(backend, log) {
  const admin = new ConvexHttpClient(backend.url);
  admin.setAuth(backend.token);
  const { teamId } = await admin.mutation(api.teams.create, { key: 'INT', name: 'Integration' });
  await admin.mutation(api.issues.create, { issues: [{ teamId, title: 'Existing', status: 'todo' }] });
  const { key, agentId } = await admin.action(api.agents.create, { name: 'Integration test' });
  const url = `${backend.siteUrl}/mcp`;

  // 1. Smoke script: initialize, tools/list, read calls
  const smoke = await runMcpSmoke({ url, key });
  assert.equal(smoke.serverName, 'selfbound');
  assert.equal(smoke.instructions, true);
  assert.equal(smoke.tools.length, 19);
  assert.deepEqual(smoke.call, { tool: 'list_teams', isError: false, textBytes: smoke.call.textBytes, structuredKeys: ['teams'] });
  const list = await runMcpSmoke({ url, key, tool: 'list_issues', args: { filter: 'assigned', team: 'INT' } });
  assert.equal(list.call.isError, false);
  // Statuses per team: names instead of fixed keys.
  const statuses = await runMcpSmoke({ url, key, tool: 'list_statuses', args: { team: 'INT' } });
  assert.equal(statuses.call.isError, false);
  log(`MCP: protocol ${smoke.protocolVersion}, ${smoke.tools.length} tools, list_teams and list_issues ok`);

  // 2. create_issues twice with the same requestId → exactly one issue
  const client = new Client({ name: 'selfbound-integration', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  const args = { requestId: 'integration-create-0001', issues: [{ team: 'INT', title: 'From the agent', priority: 'high' }] };
  const first = await client.callTool({ name: 'create_issues', arguments: args });
  const second = await client.callTool({ name: 'create_issues', arguments: args });
  assert.notEqual(first.isError, true, JSON.stringify(first.content));
  assert.deepEqual(second.structuredContent, first.structuredContent);
  assert.equal(first.structuredContent.created[0].identifier, 'INT-2');
  const listed = await client.callTool({ name: 'list_issues', arguments: { team: 'INT' } });
  assert.deepEqual(
    listed.structuredContent.issues.map((i) => i.identifier).sort(),
    ['INT-1', 'INT-2'],
    'a second call with the same requestId must not create a second issue',
  );
  const detail = await client.callTool({ name: 'get_issue', arguments: { identifier: 'int-2' } });
  assert.match(detail.structuredContent.createdBy, /Integration test/);
  assert.equal(detail.structuredContent.reviewedBySteven, false);
  await client.close();
  log('MCP: create_issues twice with the same requestId → one issue (INT-2)');

  // 3. Key clients never start OAuth: wrong key → 401 without WWW-Authenticate.
  //    Without a key (connectors), however, the challenge; OAuth is on in the test backend.
  const wrong = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer xlr8_wrong', 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('www-authenticate'), null);
  const anonymous = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get('www-authenticate') ?? '', /^Bearer resource_metadata="/);
  assert.equal((await fetch(`${backend.siteUrl}/.well-known/openid-configuration`)).status, 404);
  assert.equal((await fetch(url)).status, 405);
  assert.deepEqual(await (await fetch(`${backend.siteUrl}/health`)).json(), { ok: true, local: true, devAuth: true, devAuthConfigured: true, clerk: false, testSwitches: true, oauth: true, push: false });

  // 4. Revoked key → 401 (the SDK client reports the error, no OAuth)
  await admin.mutation(api.agents.revoke, { agentId });
  await assert.rejects(runMcpSmoke({ url, key }), (error) => error.code === 401);
  log('MCP: revoked key → 401 without OAuth challenge, GET → 405, /health ok');

  // 5. Logo: upload, meta.get returns /logo/<id> under the site URL, response with CSP.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#c33"/></svg>';
  const uploadUrl = await admin.mutation(api.teams.generateLogoUploadUrl, {});
  const { storageId } = await (await fetch(uploadUrl, { method: 'POST', headers: { 'Content-Type': 'image/svg+xml' }, body: svg })).json();
  await admin.action(api.teams.setLogo, { teamId, storageId, variant: 'light' });
  const team = (await admin.query(api.meta.get, {})).teams.find((x) => x._id === teamId);
  assert.equal(team.logoUrl, `${backend.siteUrl}/logo/${storageId}`);
  const logo = await fetch(team.logoUrl);
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get('content-type'), 'image/svg+xml');
  assert.equal(logo.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'");
  assert.equal(logo.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await logo.text(), svg);
  log('Logo: /logo/<id> with CSP and nosniff, URL from meta.get');
}
