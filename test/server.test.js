import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { installCodex } from '../src/setup.js';
import { providerFixture, sendInference } from './fixtures/provider.js';

test('MCP disconnect stops an in-flight real DSH process, not just the bridge', { timeout: 30000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-mcp-disconnect-'));
  const root = join(base, 'workspace');
  await mkdir(root);
  let requestCount = 0;
  let requestSeen;
  const request = new Promise((resolve) => { requestSeen = resolve; });
  const endpoint = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requestCount++;
    requestSeen({
      closed: new Promise((resolve) => res.once('close', resolve)),
      apiKey: req.headers.authorization, body: JSON.parse(body), path: req.url,
    });
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
  await installCodex({
    home: join(base, 'home'), codexHome: join(base, 'codex'), skillsHome: join(base, 'skills'),
    apiKey: 'sk-local-disconnect-fixture', protocol: 'chat-completions', model: 'deepseek-flash', baseUrl: `http://127.0.0.1:${endpoint.address().port}/v1`,
  });
  const env = { ...process.env };
  delete env.DEEPSEEK_API_KEY;
  delete env.DEEPSEEK_BASE_URL;
  delete env.DSH_MCP_PROTOCOL;
  delete env.DSH_MCP_MODEL;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.js', import.meta.url)), '--dsh-home', join(base, 'home')],
    env,
    stderr: 'pipe',
  });
  transport.stderr.on('data', () => {});
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools[0].name, 'delegate_to_deepseek');
  assert.equal(requestCount, 0, 'server startup and tool discovery must never make provider requests');
  const pending = client.callTool({ name: 'delegate_to_deepseek', arguments: { project_root: root, task: 'Wait for an answer.', thinking_effort: 'low', timeout_seconds: 900 } })
    .then(() => 'unexpected response', () => 'connection closed');
  const { closed, apiKey, body, path } = await request;
  assert.equal(path, '/v1/chat/completions');
  assert.equal(body.model, 'deepseek-flash');
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.thinking.type, 'enabled');
  assert.equal(body.max_completion_tokens, undefined);
  assert.equal(apiKey, 'Bearer sk-local-disconnect-fixture');
  await client.close();
  await closed;
  assert.equal(await pending, 'connection closed');
});

test('MCP monitor shows live progress while delegation returns only its durable final result', { timeout: 30000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-mcp-progress-'));
  const client = new Client({ name: 'progress-regression', version: '1' });
  t.after(async () => { await client.close(); await rm(base, { recursive: true, force: true }); });
  let release;
  let blocked = true;
  let requestSeen;
  const seen = new Promise((resolve) => { requestSeen = resolve; });
  const fixture = await providerFixture(t, (request, res) => {
    const respond = () => sendInference(res, 'chat-completions', 'deepseek-flash', 'Verified final answer.');
    if (!blocked || !request.body?.tools?.length) { respond(); return; }
    release = () => { blocked = false; respond(); };
    requestSeen();
  });
  const home = join(base, 'home');
  await installCodex({
    home, codexHome: join(base, 'codex'), skillsHome: join(base, 'skills'),
    apiKey: 'sk-progress-fixture', protocol: 'chat-completions', model: 'deepseek-flash', baseUrl: fixture.baseUrl + '/v1',
  });
  const env = { ...process.env };
  for (const key of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DSH_MCP_PROTOCOL', 'DSH_MCP_MODEL']) delete env[key];
  const transport = new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL('../src/server.js', import.meta.url)), '--dsh-home', home], env, stderr: 'pipe',
  });
  transport.stderr.on('data', () => {});
  await client.connect(transport);
  const opened = await client.callTool({ name: 'get_dsh_monitor', arguments: {} });
  const url = new URL(opened.structuredContent.url);
  assert.equal(opened.structuredContent.events, undefined);
  let finished = false;
  const pending = client.callTool({ name: 'delegate_to_deepseek', arguments: {
    project_root: base, task: 'Reply briefly without using tools.', thinking_effort: 'low',
  } }).then((result) => { finished = true; return result; });
  await seen;
  const snapshot = await (await fetch(new URL('/events', url), {
    headers: { Authorization: `Bearer ${url.hash.slice(1)}` },
  })).json();
  assert.equal(finished, false, 'progress must be visible before the provider finishes');
  assert(snapshot.events.some(({ type }) => type === 'run_start'));
  assert(snapshot.events.some(({ type }) => type === 'status'));
  release();
  const result = await pending;
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.answer, 'Verified final answer.');
  assert.equal(result.structuredContent.output_source, 'session');
  assert.equal(result.structuredContent.diagnostics, '');
  assert(!JSON.stringify(result).includes('run_start'));
  await client.close();
  await assert.rejects(fetch(url));
});
