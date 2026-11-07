import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_BASE_URL, DEFAULT_PROTOCOL, PROTOCOLS, normalizeBaseUrl, parseProviderSettings,
  resolveProviderSettings, discoverModels, testConnection, buildProviderRuntime,
} from '../src/provider.js';
import { providerFixture, sendInference } from './fixtures/provider.js';

const key = 'sk-local-provider-fixture-not-a-real-key';

test('fresh defaults use Chat Completions while old private settings retain Messages', () => {
  assert.equal(DEFAULT_PROTOCOL, 'chat-completions');
  assert.equal(DEFAULT_BASE_URL, 'https://api.deepseek.com/v1');
  assert.deepEqual(resolveProviderSettings(), { protocol: DEFAULT_PROTOCOL, baseUrl: DEFAULT_BASE_URL, model: 'deepseek-flash' });
  assert.deepEqual(resolveProviderSettings({}, { legacy: true }), { protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash' });
  assert.equal(resolveProviderSettings({ baseUrl: 'https://old.example/messages' }, { legacy: true }).protocol, 'anthropic');
  assert.equal(resolveProviderSettings({ protocol: 'responses' }, { legacy: true }).baseUrl, 'https://api.openai.com/v1');
  assert.deepEqual(PROTOCOLS.map(({ api }) => api), ['openai-completions', 'openai-responses', 'anthropic-messages']);
});

test('URL and JSON parsing reject injection without changing read-only settings data', () => {
  assert.equal(normalizeBaseUrl(' '), DEFAULT_BASE_URL);
  assert.equal(normalizeBaseUrl(' https://provider.example/custom/v1/// '), 'https://provider.example/custom/v1');
  for (const value of ['file:///tmp/api', 'relative/path', 'https://user:secret@provider.example', 'https://provider.example?key=secret', 'https://provider.example#fragment', 'https://provider.example\n/hidden', 'https://provider.example/\u001b[31m', 'https://provider.example/\u202e']) {
    assert.throws(() => normalizeBaseUrl(value), /Base URL/);
  }
  for (const text of ['null', '[]', 'false', '{']) assert.throws(() => parseProviderSettings(text), /settings.json/);
  assert.deepEqual(parseProviderSettings(''), {});
  const original = { protocol: 'responses', model: 'private-model', baseUrl: 'https://provider.example/v1/', unrelated: { enabled: true } };
  assert.deepEqual(resolveProviderSettings(original), { protocol: 'responses', model: 'private-model', baseUrl: 'https://provider.example/v1' });
  assert.equal(original.baseUrl, 'https://provider.example/v1/');
  assert.deepEqual(parseProviderSettings(JSON.stringify(original)), original);
  assert.throws(() => resolveProviderSettings({ protocol: 'messages' }), /Protocol/);
  assert.throws(() => resolveProviderSettings({ baseUrl: 42 }), /Base URL/);
  assert.throws(() => resolveProviderSettings({ model: 'unsafe\u001b[31m' }), /Model ID/);
});

for (const protocol of ['chat-completions', 'responses']) {
  test(`${protocol} discovers the actual credential-visible IDs with bearer authentication`, async (t) => {
    const fixture = await providerFixture(t, (request, res) => {
      assert.equal(request.url, '/private/v1/models');
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.authorization, `Bearer ${key}`);
      assert.equal(request.headers['x-api-key'], undefined);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'account-only-model', name: '\u001b[31mPrivate\u001b[0m\nmodel\u202e' }, { id: 'second-model' }, { id: 'account-only-model', name: 'Private model' }] }));
    });
    assert.deepEqual(await discoverModels({ protocol, baseUrl: fixture.baseUrl + '/private/v1', apiKey: key }), [
      { id: 'account-only-model', name: 'Private model' }, { id: 'second-model' },
    ]);
    assert.equal(fixture.requests.length, 1);
  });
}

test('native Anthropic discovery authenticates every page and uses only same-endpoint cursors', async (t) => {
  const fixture = await providerFixture(t, (request, res) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    assert.equal(url.pathname, '/tenant/v1/models');
    assert.equal(request.headers['x-api-key'], key);
    assert.equal(request.headers['anthropic-version'], '2023-06-01');
    assert.equal(request.headers.authorization, undefined);
    res.setHeader('content-type', 'application/json');
    if (!url.searchParams.has('after_id')) {
      res.end(JSON.stringify({ data: [{ id: 'first', display_name: '\u001b[31mFirst\u001b[0m\n' }], has_more: true, last_id: 'first' }));
    } else {
      assert.equal(url.searchParams.get('after_id'), 'first');
      res.end(JSON.stringify({ data: [{ id: 'second', display_name: 'Second' }], has_more: false, last_id: 'second' }));
    }
  });
  assert.deepEqual(await discoverModels({ protocol: 'anthropic', baseUrl: fixture.baseUrl + '/tenant', apiKey: key }), [
    { id: 'first', name: 'First' }, { id: 'second', name: 'Second' },
  ]);
  assert.equal(fixture.requests.length, 2);
});

test('Anthropic roots already ending in v1 do not duplicate the discovery version', async (t) => {
  const fixture = await providerFixture(t, (request, res) => {
    assert.equal(request.url, '/v1/models');
    res.end('{"data":[]}');
  });
  assert.deepEqual(await discoverModels({ protocol: 'anthropic', baseUrl: fixture.baseUrl + '/v1', apiKey: key }), []);
});

test('official DeepSeek Messages discovery uses only the same-origin official models endpoint', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response('{"data":[{"id":"credential-visible-deepseek-model"}]}');
  });
  assert.deepEqual(await discoverModels({ protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: key }), [{ id: 'credential-visible-deepseek-model' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/models');
  assert.equal(calls[0].options.headers['x-api-key'], key);
  assert.equal(calls[0].options.redirect, 'manual');
});

test('unavailable or forbidden listings never turn into a local catalog and cannot echo credentials', async (t) => {
  for (const status of [401, 403, 404, 500]) {
    const fixture = await providerFixture(t, (request, res) => res.writeHead(status).end(JSON.stringify({ error: key + '\u001b[31m' })));
    await assert.rejects(discoverModels({ baseUrl: fixture.baseUrl, apiKey: key }), (error) => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert(!error.message.includes(key));
      assert(!error.message.includes('\u001b'));
      return true;
    });
    assert.equal(fixture.requests.length, 1);
  }
});

test('discovery rejects redirects without sending credentials to the target', async (t) => {
  const target = await providerFixture(t, (request, res) => res.end('{"data":[]}'));
  const source = await providerFixture(t, (request, res) => res.writeHead(307, { location: target.baseUrl + '/models' }).end());
  await assert.rejects(discoverModels({ baseUrl: source.baseUrl, apiKey: key }), /redirect/);
  assert.equal(target.requests.length, 0);
});

test('discovery rejects malformed bodies, terminal-control IDs and repeated pagination', async (t) => {
  for (const body of ['not-json', '{}', '{"data":[{}]}', '{"data":[{"id":"unsafe\\u001b[31m"}]}']) {
    const fixture = await providerFixture(t, (request, res) => res.end(body));
    await assert.rejects(discoverModels({ baseUrl: fixture.baseUrl, apiKey: key }), /Model discovery|Model ID/);
  }
  const loop = await providerFixture(t, (request, res) => res.end('{"data":[{"id":"same"}],"has_more":true,"last_id":"same"}'));
  await assert.rejects(discoverModels({ protocol: 'anthropic', baseUrl: loop.baseUrl, apiKey: key }), /pagination/);
  assert.equal(loop.requests.length, 2);
});

test('discovery cancellation is bounded and reports no transport details', async (t) => {
  const fixture = await providerFixture(t, () => {});
  const controller = new AbortController();
  const pending = discoverModels({ baseUrl: fixture.baseUrl, apiKey: key, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});

test('runtime profiles preserve selected endpoint/model, keep keys out of profile JSON, and use native DeepSeek Chat metadata', () => {
  const runtime = buildProviderRuntime({ protocol: 'chat-completions', baseUrl: 'https://private.example/v1', model: 'deepseek-flash' }, key);
  assert.equal(runtime.route, 'deepseek');
  assert.equal(runtime.model, 'deepseek-flash');
  assert.deepEqual(runtime.thinkingEfforts, ['off', 'low', 'high', 'max']);
  const profile = JSON.parse(runtime.env.DSH_MCP_PI_PROVIDERS).deepseek;
  assert.equal(profile.api, 'openai-completions');
  assert.equal(profile.baseURL, 'https://private.example/v1');
  assert.equal(profile.apiKeyEnv, 'DEEPSEEK_API_KEY');
  assert.deepEqual(profile.models[0].reasoningEfforts, { off: null, low: 'low', high: 'high', max: 'max' });
  assert.equal(runtime.env.DEEPSEEK_API_KEY, key);
  assert(!runtime.env.DSH_MCP_PI_PROVIDERS.includes(key));
  assert(!runtime.env.DSH_MCP_DEEPSEEK_PROFILE.includes(key));
});

test('Responses and Anthropic effort sets use installed exact-model metadata, never guessed max', () => {
  const responses = buildProviderRuntime({ protocol: 'responses', model: 'gpt-5.4' }, key);
  assert.deepEqual(responses.thinkingEfforts, ['off', 'low', 'high']);
  assert.equal(JSON.parse(responses.env.DSH_MCP_PI_PROVIDERS).openai.models[0].reasoningEfforts.off, 'none');
  const anthropic = buildProviderRuntime({ protocol: 'anthropic', model: 'claude-sonnet-4-5' }, key);
  assert.equal(anthropic.route, 'anthropic');
  assert.deepEqual(anthropic.thinkingEfforts, ['off', 'low', 'high']);
  const unknown = buildProviderRuntime({ protocol: 'responses', model: 'account-private-model' }, key);
  assert.deepEqual(unknown.thinkingEfforts, ['off']);
  assert.equal(unknown.model, 'account-private-model');
  assert.equal(JSON.parse(unknown.env.DSH_MCP_PI_PROVIDERS)['dsh-mcp'].models[0].reasoningEfforts, false);
  const legacy = buildProviderRuntime(resolveProviderSettings({}, { legacy: true }), key);
  assert.equal(legacy.route, 'deepseek-official');
  assert.deepEqual(JSON.parse(legacy.env.DSH_MCP_PI_PROVIDERS), {});
  assert.equal(JSON.parse(legacy.env.DSH_MCP_DEEPSEEK_PROFILE).models[0].id, 'deepseek-flash');
});

for (const protocol of ['chat-completions', 'responses', 'anthropic']) {
  test(`${protocol} connection testing performs one native, model-only inference with the selected model`, async (t) => {
    const model = `private-${protocol}-model`;
    const fixture = await providerFixture(t, (request, res) => sendInference(res, protocol, model));
    const settings = { protocol, baseUrl: fixture.baseUrl + (protocol === 'anthropic' ? '' : '/v1'), model };
    assert.deepEqual(await testConnection({ ...settings, apiKey: key }), settings);
    assert.equal(fixture.requests.length, 1);
    const request = fixture.requests[0];
    assert.equal(request.method, 'POST');
    assert.equal(new URL(request.url, fixture.baseUrl).pathname, protocol === 'chat-completions' ? '/v1/chat/completions' : protocol === 'responses' ? '/v1/responses' : '/v1/messages');
    assert.equal(request.body.model, model);
    assert.equal(request.body.stream, true);
    assert.equal(request.body.tools, undefined);
    assert.equal(request.body.max_tokens ?? request.body.max_output_tokens, 32);
    assert.equal(request.headers[protocol === 'anthropic' ? 'x-api-key' : 'authorization'], protocol === 'anthropic' ? key : `Bearer ${key}`);
    const messages = request.body.messages ?? request.body.input;
    assert.equal(messages.length, 1);
    assert(!JSON.stringify(messages).includes('project_root'));
  });
}

test('Anthropic SDK derives an unversioned root without changing the saved or returned versioned URL', async (t) => {
  const fixture = await providerFixture(t, (request, res) => sendInference(res, 'anthropic', 'private-messages-model'));
  const settings = { protocol: 'anthropic', baseUrl: fixture.baseUrl + '/tenant/v1', model: 'private-messages-model' };
  const runtime = buildProviderRuntime(settings, key);
  assert.equal(runtime.env.DEEPSEEK_BASE_URL, settings.baseUrl);
  assert.equal(JSON.parse(runtime.env.DSH_MCP_PI_PROVIDERS)['dsh-mcp'].baseURL, fixture.baseUrl + '/tenant');
  assert.deepEqual(await testConnection({ ...settings, apiKey: key }), settings);
  assert.equal(new URL(fixture.requests[0].url, fixture.baseUrl).pathname, '/tenant/v1/messages');
});

test('DeepSeek Messages testing uses the official DSH adapter and actually decodes its stream', async (t) => {
  const fixture = await providerFixture(t, (request, res) => sendInference(res, 'anthropic', 'deepseek-flash'));
  await testConnection({ protocol: 'anthropic', baseUrl: fixture.baseUrl + '/anthropic', model: 'deepseek-flash', apiKey: key });
  assert.equal(fixture.requests.length, 1);
  const request = fixture.requests[0];
  assert.equal(request.url, '/anthropic/v1/messages');
  assert.deepEqual(request.body.thinking, { type: 'disabled' });
  assert.equal(request.body.max_tokens, 32);
  assert.equal(request.body.model, 'deepseek-flash');
});

test('a model list, empty stream, stream error or HTTP error is not a successful inference, and is never retried', async (t) => {
  for (const kind of ['list', 'empty', 'http-error', 'stream-error']) {
    const fixture = await providerFixture(t, (request, res) => {
      if (kind === 'list') res.end('{"data":[{"id":"private"}]}');
      else if (kind === 'empty') res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n');
      else if (kind === 'http-error') res.writeHead(429).end(JSON.stringify({ error: { message: key } }));
      else res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${JSON.stringify({ error: { message: key } })}\n\n`);
    });
    await assert.rejects(testConnection({ protocol: 'chat-completions', baseUrl: fixture.baseUrl, model: 'private', apiKey: key }), (error) => {
      assert.match(error.message, /Connection test failed/);
      assert(!error.message.includes(key));
      return true;
    });
    assert.equal(fixture.requests.length, 1);
  }
});

test('inference redirects cannot forward credentials or report success', async (t) => {
  const target = await providerFixture(t, (request, res) => sendInference(res, 'responses', 'private-model'));
  const source = await providerFixture(t, (request, res) => res.writeHead(307, { location: target.baseUrl + '/responses' }).end());
  await assert.rejects(testConnection({ protocol: 'responses', baseUrl: source.baseUrl, model: 'private-model', apiKey: key }), /Connection test failed/);
  assert.equal(target.requests.length, 0);
  assert.equal(source.requests.length, 1);
});
