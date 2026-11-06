import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { installProject } from '../src/setup.js';

test('MCP disconnect stops an in-flight real DSH process, not just the bridge', { timeout: 30000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-mcp-disconnect-'));
  const root = join(base, 'workspace');
  await mkdir(root);
  let requestSeen;
  const request = new Promise((resolve) => { requestSeen = resolve; });
  const endpoint = createServer((req, res) => {
    req.resume();
    requestSeen({ closed: new Promise((resolve) => res.once('close', resolve)), apiKey: req.headers['x-api-key'] });
    // Keep inference pending until disconnect kills the actual Harness process.
  });
  await new Promise((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'disconnect-regression', version: '1' });
  t.after(async () => {
    await client.close();
    endpoint.closeAllConnections();
    await new Promise((resolve) => endpoint.close(resolve));
    await rm(base, { recursive: true, force: true });
  });
  await installProject({
    workspaceRoot: root, home: join(base, 'home'),
    apiKey: 'sk-local-disconnect-fixture', baseUrl: `http://127.0.0.1:${endpoint.address().port}`,
  });
  const env = { ...process.env };
  delete env.DEEPSEEK_API_KEY;
  delete env.DEEPSEEK_BASE_URL;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.js', import.meta.url)), '--workspace-root', root, '--dsh-home', join(base, 'home')],
    env,
    stderr: 'pipe',
  });
  transport.stderr.on('data', () => {});
  await client.connect(transport);
  const pending = client.callTool({ name: 'delegate_to_deepseek', arguments: { task: 'Wait for an answer.', timeout_seconds: 900 } })
    .then(() => 'unexpected response', () => 'connection closed');
  const { closed, apiKey } = await request;
  assert.equal(apiKey, 'sk-local-disconnect-fixture');
  await client.close();
  await closed;
  assert.equal(await pending, 'connection closed');
});
