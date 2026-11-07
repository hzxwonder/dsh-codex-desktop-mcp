import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorker } from '../src/worker.js';
import { buildProviderRuntime } from '../src/provider.js';
import { providerFixture, sendInference } from './fixtures/provider.js';

const apiKey = 'sk-native-runtime-fixture-not-a-real-key';
const configurations = [
  { protocol: 'chat-completions', model: 'deepseek-flash', thinking_effort: 'max' },
  { protocol: 'responses', model: 'gpt-5.4', thinking_effort: 'high' },
  { protocol: 'anthropic', model: 'claude-sonnet-4-5', thinking_effort: 'low' },
];

for (const configuration of configurations) {
  test(`real local DSH persists a selected-model ${configuration.protocol} stream with explicit supported effort`, { timeout: 30000 }, async (t) => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-native-protocol-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const root = join(base, 'project');
    await mkdir(root);
    const answer = `Native ${configuration.protocol} answer.`;
    const fixture = await providerFixture(t, (request, res) => sendInference(res, configuration.protocol, configuration.model, answer));
    const baseUrl = fixture.baseUrl + (configuration.protocol === 'anthropic' ? '' : '/v1');
    const providerRuntime = buildProviderRuntime({ ...configuration, baseUrl }, apiKey);
    const worker = createWorker({ home: join(base, 'home'), providerRuntime });
    const result = await worker.delegate({
      project_root: root, task: 'Reply with a short answer without using tools or reading files.',
      thinking_effort: configuration.thinking_effort, timeout_seconds: 20,
    });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.answer, answer);
    assert.equal(result.output_source, 'session');
    assert.equal(result.model, configuration.model);
    assert.equal(result.protocol, configuration.protocol);
    assert.equal(result.thinking_effort, configuration.thinking_effort);
    assert(result.session_id);
    assert(result.session_file);
    const workerRequests = fixture.requests.filter((request) => Array.isArray(request.body?.tools) && request.body.tools.length > 0);
    assert.equal(workerRequests.length, 1);
    const request = workerRequests[0];
    assert.equal(request.body.model, configuration.model);
    assert.equal(request.body.stream, true);
    assert(Array.isArray(request.body.tools) && request.body.tools.length > 0, 'the real Harness, not a model-only substitute, supplies its tools');
    if (configuration.protocol === 'chat-completions') {
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
      assert.deepEqual(request.body.thinking, { type: 'enabled' });
      assert.equal(request.body.reasoning_effort, 'max');
      assert.equal(request.body.store, undefined);
      assert.equal(request.body.max_completion_tokens, undefined);
    } else if (configuration.protocol === 'responses') {
      assert.equal(request.url, '/v1/responses');
      assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
      assert.equal(request.body.reasoning.effort, 'high');
      assert(Array.isArray(request.body.input));
      assert.equal(request.body.messages, undefined);
    } else {
      assert.equal(new URL(request.url, fixture.baseUrl).pathname, '/v1/messages');
      assert.equal(request.headers['x-api-key'], apiKey);
      assert.equal(request.headers['anthropic-version'], '2023-06-01');
      assert.equal(request.body.thinking.type, 'enabled');
      assert.equal(request.body.thinking.budget_tokens, 2048);
      assert.equal(request.body.reasoning_effort, undefined);
    }
    const other = join(base, 'other-project');
    await mkdir(other);
    const requestsBeforeRefusal = fixture.requests.length;
    const refused = await worker.delegate({
      project_root: other, task: 'Continue.', session_id: result.session_id,
      thinking_effort: configuration.thinking_effort,
    });
    assert.equal(refused.status, 'failed');
    assert.equal(refused.answer, '');
    assert.equal(fixture.requests.length, requestsBeforeRefusal, 'cross-project resume is refused before model I/O');
  });
}

test('unknown model metadata offers only explicit off and retains functional native compaction', { timeout: 30000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-native-effort-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const fixture = await providerFixture(t, (request, res) => sendInference(res, 'responses', 'account-private-model', 'Private model answer.'));
  const runtime = buildProviderRuntime({ protocol: 'responses', model: 'account-private-model', baseUrl: fixture.baseUrl + '/v1' }, apiKey);
  const worker = createWorker({ home: join(base, 'home'), providerRuntime: runtime });
  await assert.rejects(worker.delegate({ project_root: base, task: 'Read.', thinking_effort: 'low' }), /must be one of: off/);
  await assert.rejects(worker.delegate({ project_root: base, task: 'Read.' }), /thinking_effort.*required/);
  assert.equal(fixture.requests.length, 0);
  const result = await worker.delegate({ project_root: base, task: 'Reply briefly without using tools.', thinking_effort: 'off', timeout_seconds: 20 });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.answer, 'Private model answer.');
  assert.equal(result.model, 'account-private-model');
  const workerRequests = fixture.requests.filter((request) => Array.isArray(request.body?.tools) && request.body.tools.length > 0);
  assert.equal(workerRequests.length, 1);
  assert.equal(workerRequests[0].body.model, 'account-private-model');
  assert.equal(workerRequests[0].body.reasoning, undefined);
});

test('worker redacts the launch credential from native process errors and diagnostics', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-native-redaction-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const runtime = buildProviderRuntime({ model: 'deepseek-flash' }, apiKey);
  const command = [process.execPath, '--input-type=module', '-e', `
    process.stdin.resume();
    console.error(process.env.DEEPSEEK_API_KEY);
    console.log(JSON.stringify({ type: 'error', message: process.env.DEEPSEEK_API_KEY }));
    process.exitCode = 1;
  `, '--'];
  const worker = createWorker({ home: join(base, 'home'), providerRuntime: runtime, command });
  const result = await worker.delegate({ project_root: base, task: 'Report.', thinking_effort: 'off' });
  assert.equal(result.status, 'failed');
  assert(!JSON.stringify(result).includes(apiKey));
  assert.match(result.diagnostics, /REDACTED/);
  assert.match(result.reason.message, /REDACTED/);
});
