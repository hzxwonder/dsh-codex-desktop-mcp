import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';

export const PROTOCOLS = Object.freeze([
  { id: 'chat-completions', label: 'OpenAI Chat Completions — POST /chat/completions', defaultBaseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions' },
  { id: 'responses', label: 'OpenAI Responses (Codex) — POST /responses', defaultBaseUrl: 'https://api.openai.com/v1', api: 'openai-responses' },
  { id: 'anthropic', label: 'Anthropic Messages — POST /v1/messages', defaultBaseUrl: 'https://api.anthropic.com', api: 'anthropic-messages' },
]);
export const DEFAULT_PROTOCOL = 'chat-completions';
export const DEFAULT_BASE_URL = PROTOCOLS[0].defaultBaseUrl;
const LEGACY_BASE_URL = 'https://api.deepseek.com/anthropic';
const EFFORTS = ['off', 'low', 'high', 'max'];
const CONTROLS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const preferredProviders = ['deepseek', 'openai', 'anthropic'];
const catalog = [...preferredProviders, ...getBuiltinProviders().filter((provider) => !preferredProviders.includes(provider))]
  .flatMap((provider) => getBuiltinModels(provider));

export function normalizeBaseUrl(value = DEFAULT_BASE_URL, fallback = DEFAULT_BASE_URL) {
  if (typeof value !== 'string' || CONTROLS.test(value)) {
    throw new Error('Base URL must be one HTTP or HTTPS URL without control characters.');
  }
  let url;
  try { url = new URL(value.trim() || fallback); }
  catch { throw new Error('Base URL must be an absolute HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL must use HTTP or HTTPS without credentials, a query, or a fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

export function parseProviderSettings(text) {
  if (!text) return {};
  let settings;
  try { settings = JSON.parse(text); }
  catch { throw new Error('The private settings.json file is not valid JSON.'); }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('The private settings.json file must contain an object.');
  }
  return settings;
}

function modelId(value) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 512 || CONTROLS.test(value)) {
    throw new Error('Model ID must be nonempty, at most 512 characters, and contain no control characters or surrounding whitespace.');
  }
  return value;
}

export function resolveProviderSettings(input = {}, { legacy = false } = {}) {
  const protocol = input.protocol ?? (legacy ? 'anthropic' : DEFAULT_PROTOCOL);
  const definition = PROTOCOLS.find((item) => item.id === protocol);
  if (!definition) throw new Error('Protocol must be chat-completions, responses, or anthropic.');
  const fallback = legacy && input.protocol == null ? LEGACY_BASE_URL : definition.defaultBaseUrl;
  return {
    protocol,
    baseUrl: normalizeBaseUrl(input.baseUrl ?? fallback, fallback),
    model: modelId(input.model ?? 'deepseek-flash'),
  };
}

function requireApiKey(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || CONTROLS.test(apiKey)) {
    throw new Error('A nonempty API key without control characters is required.');
  }
}

function boundedSignal(signal, milliseconds) {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readModelPage(response) {
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error('Model discovery refused a redirect; use the provider’s final Base URL.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    const detail = [401, 403].includes(response.status) ? ' Credentials were rejected or lack model-list permission.' : '';
    throw new Error(`Model discovery failed (HTTP ${response.status}).${detail}`);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) throw new Error('Model discovery returned an oversized response.');
    chunks.push(chunk);
  }
  let page;
  try { page = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Model discovery did not return a valid JSON model list.'); }
  if (!page || !Array.isArray(page.data)) throw new Error('Model discovery did not return a data array.');
  return page;
}

export async function discoverModels({ protocol, baseUrl, apiKey, signal }) {
  const settings = resolveProviderSettings({ protocol, baseUrl });
  requireApiKey(apiKey);
  const url = new URL(settings.baseUrl);
  const anthropic = settings.protocol === 'anthropic';
  // The official DSH Messages adapter lists DeepSeek models at /models on this same origin.
  const deepseek = anthropic && url.origin === 'https://api.deepseek.com';
  url.pathname = deepseek ? '/models' : `${url.pathname.replace(/\/+$/, '')}${anthropic && !url.pathname.endsWith('/v1') ? '/v1' : ''}/models`;
  const headers = anthropic ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${apiKey}` };
  const requestSignal = boundedSignal(signal, 15000);
  const models = new Map();
  const cursors = new Set();
  try {
    for (let count = 0; count < 100; count++) {
      const page = await readModelPage(await fetch(url, { headers, signal: requestSignal, redirect: 'manual' }));
      if (anthropic && !deepseek && page.has_more !== undefined && typeof page.has_more !== 'boolean') {
        throw new Error('Model discovery returned invalid pagination.');
      }
      for (const entry of page.data) {
        if (!entry || typeof entry !== 'object') throw new Error('Model discovery returned an invalid model entry.');
        const id = modelId(entry.id);
        const name = typeof (entry.display_name ?? entry.name) === 'string'
          ? stripVTControlCharacters(entry.display_name ?? entry.name).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').slice(0, 256).trim() : '';
        models.set(id, name ? { id, name } : { id });
      }
      if (!anthropic || deepseek || page.has_more !== true) return [...models.values()];
      const cursor = modelId(page.last_id);
      if (!page.data.length || cursors.has(cursor)) throw new Error('Model discovery returned invalid pagination.');
      cursors.add(cursor);
      url.searchParams.set('after_id', cursor);
    }
    throw new Error('Model discovery exceeded its pagination limit.');
  } catch (error) {
    if (requestSignal.aborted) throw new Error(signal?.aborted ? 'Model discovery cancelled.' : 'Model discovery timed out.');
    // Never relay provider bodies, fetch causes, URLs, or credential-bearing headers.
    if (/^(Model discovery|Model ID)/.test(error.message)) throw error;
    throw new Error('Model discovery could not reach the selected endpoint. Check the Base URL and network.');
  }
}

function describeRuntime(settings) {
  const definition = PROTOCOLS.find((item) => item.id === settings.protocol);
  const deepseekModel = catalog.find((item) => item.provider === 'deepseek' && item.id === settings.model);
  const direct = settings.protocol === 'anthropic' && deepseekModel !== undefined;
  const known = direct ? deepseekModel : catalog.find((item) => item.id === settings.model && item.api === definition.api);
  const thinkingEfforts = known?.reasoning ? EFFORTS.filter((effort) => {
    const wire = known.thinkingLevelMap?.[effort];
    return wire !== null && (effort !== 'max' || wire !== undefined);
  }) : ['off'];
  if (!thinkingEfforts.length) throw new Error('The selected model has no supported off, low, high, or max effort in the installed metadata.');
  const route = direct ? 'deepseek-official' : known?.provider ?? 'dsh-mcp';
  const reasoningEfforts = known?.reasoning ? Object.fromEntries(thinkingEfforts.map((effort) => [effort, known.thinkingLevelMap?.[effort] ?? (effort === 'off' ? null : effort)])) : false;
  const model = {
    id: settings.model,
    ...(known ? { name: known.name, contextWindow: known.contextWindow, input: known.input } : {}),
    reasoningEfforts,
  };
  const compat = !known && settings.protocol === 'chat-completions'
    ? { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens', supportsStrictMode: false } : undefined;
  const profile = {
    apiKeyEnv: 'DEEPSEEK_API_KEY', api: definition.api,
    baseURL: settings.protocol === 'anthropic' ? settings.baseUrl.replace(/\/v1$/, '') : settings.baseUrl,
    models: [model], defaultContextWindow: 32768, defaultMaxTokens: 4096,
    ...(compat ? { compat } : {}),
  };
  const directProfile = direct ? {
    apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: settings.baseUrl,
    models: [{ id: settings.model, name: known.name, contextWindow: known.contextWindow, inputModalities: known.input }],
  } : {};
  return { route, known, profile, directProfile, thinkingEfforts };
}

export function buildProviderRuntime(input, apiKey) {
  const settings = resolveProviderSettings(input);
  if (apiKey !== undefined) requireApiKey(apiKey);
  const { route, known, profile, directProfile, thinkingEfforts } = describeRuntime(settings);
  const contextWindow = known?.contextWindow ?? profile.defaultContextWindow;
  const headroomTokens = Math.max(1, Math.floor(contextWindow / 8));
  const compaction = contextWindow < 131072 ? { headroomTokens, maxTokens: Math.min(4096, headroomTokens) } : {};
  return {
    protocol: settings.protocol, model: settings.model, route, thinkingEfforts,
    env: {
      ...(apiKey === undefined ? {} : { DEEPSEEK_API_KEY: apiKey }),
      DEEPSEEK_BASE_URL: settings.baseUrl,
      DSH_MCP_PROTOCOL: settings.protocol, DSH_MCP_MODEL: settings.model, DSH_MCP_PROVIDER: route,
      DSH_MCP_PI_PLUGIN: !known?.reasoning && route !== 'deepseek-official' ? fileURLToPath(import.meta.url) : '@deepseek-ai/dsh-llm-pi-ai',
      DSH_MCP_PI_PROVIDERS: JSON.stringify(route === 'deepseek-official' ? {} : { [route]: profile }),
      DSH_MCP_DEEPSEEK_PROFILE: JSON.stringify(directProfile),
      DSH_MCP_COMPACTION_PROFILE: JSON.stringify(compaction),
    },
  };
}

function nativeModel(settings, route, known, profile) {
  return {
    ...known, id: settings.model, name: known?.name ?? settings.model, api: profile.api,
    provider: route, baseUrl: profile.baseURL, reasoning: known?.reasoning ?? false,
    input: known?.input ?? ['text'], contextWindow: known?.contextWindow ?? profile.defaultContextWindow,
    maxTokens: known?.maxTokens ?? profile.defaultMaxTokens,
    cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: known?.compat ?? profile.compat,
  };
}

function nativeApi(protocol) {
  return { 'chat-completions': openAICompletionsApi, responses: openAIResponsesApi, anthropic: anthropicMessagesApi }[protocol]();
}

// Pinned DSH hides the native adapter's valid off level for non-reasoning models.
// Advertise only that level; the unchanged native stream still receives explicit off.
export const name = 'dsh-mcp-off-only';
export const inject = ['llm'];
export async function apply(ctx) {
  const [{ PiAiAdapter }, { InMemoryCredentialStore, defaultProviderAuthContext }, { resolveRetryPolicy, resolveImageAttachmentAccess }] = await Promise.all([
    import('@deepseek-ai/dsh-llm-pi-ai'),
    import('@earendil-works/pi-ai'),
    import('@deepseek-ai/dsh-llm'),
  ]);
  const settings = resolveProviderSettings({
    protocol: process.env.DSH_MCP_PROTOCOL, baseUrl: process.env.DEEPSEEK_BASE_URL, model: process.env.DSH_MCP_MODEL,
  });
  const { route, known, profile, thinkingEfforts } = describeRuntime(settings);
  if (thinkingEfforts.length !== 1 || thinkingEfforts[0] !== 'off' || known?.reasoning) {
    throw new Error('The off-only adapter requires a model without selectable reasoning metadata.');
  }
  const descriptor = nativeModel(settings, route, known, profile);
  const resolveApiKey = async () => {
    const credentials = ctx.get('credentials');
    const apiKey = credentials ? (await credentials.resolve(profile.apiKeyEnv))?.value : process.env[profile.apiKeyEnv];
    requireApiKey(apiKey);
    return apiKey;
  };
  const piProvider = createProvider({
    id: route, baseUrl: profile.baseURL, models: [descriptor], api: nativeApi(settings.protocol),
    auth: { apiKey: { name: 'Configured API key', resolve: async () => ({ auth: { apiKey: await resolveApiKey() } }) } },
  });
  const resolved = {
    ...profile, provider: route, displayName: route, piProvider,
    streamIdleTimeoutMs: 300000, maxRequestImageBytes: 20 * 1024 * 1024, maxRequestImages: 50,
    imageOffloadCountQuantum: 10, requestImagePixelBudget: 4194304, requestImageMaxBytes: 4 * 1024 * 1024,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-mcp'),
    modelErrors: new Map(), configuredMaxTokens: new Map(),
  };
  const profiles = new Map([[route, resolved]]);
  const withOff = (model) => ({
    ...model, reasoning: { efforts: [{ id: 'off', name: 'Off', description: 'No explicit reasoning request; unknown providers retain their own defaults.' }] },
  });
  class OffOnlyAdapter extends PiAiAdapter {
    async resolveModel(...args) { return withOff(await super.resolveModel(...args)); }
    async prepareCall(...args) {
      const prepared = await super.prepareCall(...args);
      return { ...prepared, model: withOff(prepared.model) };
    }
  }
  ctx.llm.registerAdapter([route], new OffOnlyAdapter({
    profiles: () => profiles, resolveApiKey,
    auth: { credentials: new InMemoryCredentialStore(), authContext: defaultProviderAuthContext() },
    prepareHeaders: (request, headers) => ctx.waterfall('llm-pi-ai/request-headers', request, headers, () => headers),
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, (path) => ctx.get('fs')?.processPathFromHostPath(path), ref),
  }));
}

async function probeDirect(settings, apiKey, signal, directProfile) {
  const { DeepSeekAdapter, resolveAdapterOptions } = await import('@deepseek-ai/dsh-llm-deepseek');
  const { apiKeyEnv, ...configuration } = directProfile;
  const connection = resolveAdapterOptions({ ...configuration, reasoningEffort: 'off', maxTokens: 32, streamIdleTimeoutMs: 20000, retryPolicy: { mode: 'normal', maxRetries: 0 } });
  const adapter = new DeepSeekAdapter({
    options: () => connection,
    resolveAuth: async () => ({ headers: { 'x-api-key': apiKey } }),
    resolveUserId: () => 'dsh-mcp-connection-check',
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  });
  let content = false;
  let finished = false;
  for await (const event of adapter.stream({
    provider: 'deepseek-official', model: settings.model, reasoningEffort: 'off', maxTokens: 32, signal,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] }],
  })) {
    if (event.type === 'text-delta' && event.text?.trim()) content = true;
    if (event.type === 'finish') finished = ['stop', 'max-tokens'].includes(event.reason.kind);
  }
  if (!content || !finished) throw new Error('Connection test did not receive a completed model response.');
}

export async function testConnection({ protocol, baseUrl, model, apiKey, signal }) {
  const settings = resolveProviderSettings({ protocol, baseUrl, model });
  requireApiKey(apiKey);
  const requestSignal = boundedSignal(signal, 20000);
  const { route, known, profile, directProfile, thinkingEfforts } = describeRuntime(settings);
  try {
    if (route === 'deepseek-official') {
      await probeDirect(settings, apiKey, requestSignal, directProfile);
    } else {
      const descriptor = nativeModel(settings, route, known, profile);
      const api = nativeApi(settings.protocol);
      const models = createModels();
      models.setProvider(createProvider({
        id: route, baseUrl: profile.baseURL, models: [descriptor], api,
        auth: { apiKey: { name: 'Explicit setup key', resolve: async () => ({ auth: { apiKey } }) } },
      }));
      const response = await models.completeSimple(descriptor, {
        messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }],
      }, {
        apiKey, signal: requestSignal, reasoning: thinkingEfforts.includes('off') ? undefined : thinkingEfforts[0],
        maxTokens: 32, maxRetries: 0, timeoutMs: 20000, transport: 'sse',
        fetch: (url, options) => fetch(url, { ...options, redirect: 'error' }),
      });
      const hasOutput = response.content.some((part) =>
        part.type === 'text' && part.text?.trim() || part.type === 'thinking' && part.thinking?.trim())
        || response.usage?.output > 0;
      if (!['stop', 'length'].includes(response.stopReason) || !hasOutput) {
        throw new Error('Connection test did not receive a completed model response.');
      }
    }
    return settings;
  } catch {
    if (requestSignal.aborted) throw new Error(signal?.aborted ? 'Connection test cancelled.' : 'Connection test timed out.');
    throw new Error('Connection test failed: no valid inference response. Check protocol, Base URL, API key, model access, and billing.');
  }
}
