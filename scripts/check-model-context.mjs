import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = await mkdtemp(join(tmpdir(), 'dsh-model-context-'));
const root = fileURLToPath(new URL('../', import.meta.url));
const home = base + '/codex';
await mkdir(home, { recursive: true });
const requests = [];
const names = [];
const collectNames = (tools) => {
  for (const tool of tools ?? []) {
    if (tool.name) names.push(tool.name);
    if (tool.tools) collectNames(tool.tools);
  }
};
const endpoint = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const parsed = JSON.parse(body);
  requests.push(body);
  collectNames(parsed.tools);
  const name = names.find((value) => value.endsWith('show_dsh_progress'));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const response = { id: `resp_${requests.length}`, object: 'response', created_at: 1, model: 'fixture-model', status: 'in_progress', output: [] };
  send('response.created', { response });
  let item;
  if (requests.length === 1 && name) {
    item = { id: 'fc_inline', type: 'function_call', call_id: 'call_inline', namespace: 'mcp__dsh_inline_demo', name, arguments: '' };
    send('response.output_item.added', { output_index: 0, item });
    send('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: '{}' });
    item = { ...item, arguments: '{}', status: 'completed' };
    send('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: '{}' });
  } else {
    item = { id: 'msg_done', type: 'message', role: 'assistant', status: 'in_progress', content: [] };
    send('response.output_item.added', { output_index: 0, item });
    const part = { type: 'output_text', text: 'done', annotations: [] };
    send('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: '' } });
    send('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: 'done' });
    send('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: 'done' });
    item = { ...item, status: 'completed', content: [part] };
  }
  send('response.output_item.done', { output_index: 0, item });
  send('response.completed', { response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 8, output_tokens: 1, total_tokens: 9 } } });
  res.end();
});
await new Promise((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
const node = process.execPath;
const canaryPath = base + '/ui-canary.txt';
await writeFile(home + '/config.toml', [
  'model = "fixture-model"', 'model_provider = "fixture"',
  '[model_providers.fixture]', 'name = "Local context isolation fixture"',
  `base_url = "http://127.0.0.1:${endpoint.address().port}/v1"`,
  'wire_api = "responses"', 'env_key = "DSH_CONTEXT_FIXTURE_KEY"',
  '[mcp_servers.dsh_inline_demo]', `command = ${JSON.stringify(node)}`,
  `args = ${JSON.stringify([root + 'test/fixtures/inline-demo.js', '--demo'])}`,
  '[mcp_servers.dsh_inline_demo.env]', `INLINE_DEMO_CANARY_FILE = ${JSON.stringify(canaryPath)}`,
].join('\n'));
const child = spawn('codex', ['exec', '--ephemeral', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', base,
  'Call show_dsh_progress once, then answer done. Do not read progress or files.'], {
  env: { ...process.env, CODEX_HOME: home, DSH_CONTEXT_FIXTURE_KEY: 'local-fixture-key' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });
const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
try {
  const exit = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(exit, 0, stderr.slice(-1000));
  assert(requests.length >= 2, 'Codex must make a model request after the card tool returns');
  const canary = (await readFile(canaryPath, 'utf8')).trim();
  assert(canary.length >= 48);
  assert(!requests.some((body) => body.includes(canary)), 'UI-only value entered the model request');
  assert(!names.some((name) => name.includes('read_dsh_progress')), 'App-only reader exposed to the model');
  assert(stdout.includes('show_dsh_progress'), 'The card tool was not executed');
  console.log(JSON.stringify({ modelRequests: requests.length, cardToolExecuted: true, uiOnlyCanaryInModelRequests: false, appOnlyReaderInModelTools: false }));
} catch (error) {
  console.error(JSON.stringify({ error: error.message, modelRequests: requests.length, toolNames: [...new Set(names)], toolEvents: stdout.split('\n').flatMap(line => { try { const item=JSON.parse(line).item; return item?.type==='mcp_tool_call' ? [{tool:item.tool,status:item.status,error:item.error}] : []; } catch { return []; } }) }));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  endpoint.closeAllConnections();
  await new Promise((resolve) => endpoint.close(resolve));
  await rm(base, { recursive: true, force: true });
}
