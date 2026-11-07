import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskApiKey, runTerminalSetup } from '../src/setup-terminal.js';
import { resolveProviderSettings } from '../src/provider.js';
import { providerFixture, sendInference } from './fixtures/provider.js';

const oldKey = 'sk-read-only-model-list-key-1234';
const newKey = 'sk-inference-enabled-key-5678';

async function modelService(t) {
  return providerFixture(t, (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'first-model' }, { id: 'second-model' }] }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${newKey}`) {
      response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `${oldKey} cannot use inference`, type: 'permission_error' } }));
      return;
    }
    sendInference(response, 'chat-completions', request.body.model);
  });
}

function terminalIO(answers, output, check = () => {}) {
  return {
    async ask(_prompt, hidden) {
      assert(answers.length, 'the wizard asked for unexpected additional input');
      const answer = answers.shift();
      check(answer, hidden);
      return answer;
    },
    log(value) { output.push(String(value)); },
    progress(_label, operation) { return operation(AbortSignal.timeout(10000)); },
  };
}

test('credential summaries cannot expose full keys or terminal-control sequences', () => {
  for (const key of ['four', '********', '********abcd', oldKey, `sk-control-secret-\u001b[0m`, `sk-bidi-secret-\u202eabc`]) {
    const masked = maskApiKey(key);
    assert.notEqual(masked, key);
    assert(!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(masked));
  }
});

test('failed inference returns to editable summary and key replacement succeeds without losing the selected model', async (t) => {
  const fixture = await modelService(t);
  const output = [];
  const answers = ['1', '', oldKey, '2', '3', newKey, '6'];
  const result = await runTerminalSetup({
    settings: resolveProviderSettings({ baseUrl: fixture.baseUrl + '/v1' }),
    io: terminalIO(answers, output, (answer, hidden) => {
      if ([oldKey, newKey].includes(answer)) assert.equal(hidden, true);
    }),
  });
  assert.equal(result.apiKey, newKey);
  assert.equal(result.settings.model, 'second-model');
  assert.equal(result.settings.protocol, 'chat-completions');
  assert.equal(answers.length, 0);
  const inference = fixture.requests.filter((request) => request.method === 'POST');
  assert.equal(inference.length, 2);
  assert.equal(inference[0].headers.authorization, `Bearer ${oldKey}`);
  assert.equal(inference[1].headers.authorization, `Bearer ${newKey}`);
  assert(output.includes('✅ Connection successful!'));
  assert(!output.join('\n').includes(oldKey));
  assert(!output.join('\n').includes(newKey));
});

test('saved configuration opens at the summary and changes a key without retyping URL or redetecting models', async (t) => {
  const fixture = await modelService(t);
  const output = [];
  const answers = ['3', newKey, '6'];
  let inputs = 0;
  const result = await runTerminalSetup({
    settings: resolveProviderSettings({ baseUrl: fixture.baseUrl + '/v1', model: 'second-model' }),
    apiKey: oldKey, existing: true,
    io: terminalIO(answers, output, (answer, hidden) => {
      if (inputs++ === 0) assert.equal(fixture.requests.length, 0, 'opening saved settings must not generate paid inference');
      if (answer === newKey) assert.equal(hidden, true);
    }),
  });
  assert.equal(result.apiKey, newKey);
  assert.equal(result.settings.baseUrl, fixture.baseUrl + '/v1');
  assert.equal(result.settings.model, 'second-model');
  assert.equal(answers.length, 0);
  assert.equal(fixture.requests.filter((request) => request.method === 'GET').length, 0);
  assert.equal(fixture.requests.filter((request) => request.method === 'POST').length, 1);
  assert(!output.join('\n').includes(newKey));
});

test('switching protocol can validate its URL before the user has selected a model', async (t) => {
  const fixture = await providerFixture(t, (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'gpt-5.4' }] }));
    } else sendInference(response, 'responses', request.body.model);
  });
  const answers = ['2', fixture.baseUrl + '/v1', newKey, '1'];
  const output = [];
  const result = await runTerminalSetup({
    settings: resolveProviderSettings({}),
    io: terminalIO(answers, output),
  });
  assert.equal(answers.length, 0);
  assert.equal(result.settings.protocol, 'responses');
  assert.equal(result.settings.model, 'gpt-5.4');
  assert.equal(fixture.requests[0].url, '/v1/models');
  const inference = fixture.requests.find((request) => request.method === 'POST');
  assert.equal(new URL(inference.url, fixture.baseUrl).pathname, '/v1/responses');
  assert.equal(inference.body.model, 'gpt-5.4');
});
