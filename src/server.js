import { parseArgs, parseEnv } from 'node:util';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createWorker } from './worker.js';
import { createMonitor } from './monitor.js';
import { createProgressCards } from './progress-cards.js';
import { registerProgressUi } from './progress-ui.js';
import metadata from '../package.json' with { type: 'json' };
import { buildProviderRuntime, resolveProviderSettings, parseProviderSettings } from './provider.js';

const { values } = parseArgs({ options: {
  'dsh-home': { type: 'string', default: join(homedir(), '.dsh-mcp') },
  help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('Usage: node src/server.js [--dsh-home /private/dsh-home]');
  process.exit(0);
}
if (process.platform === 'win32') throw new Error('This bridge requires POSIX process groups (macOS/Linux)');
const home = resolve(values['dsh-home']);
let stored = {};
try { stored = parseEnv(await readFile(join(home, '.env'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
let provider = {};
try { provider = parseProviderSettings(await readFile(join(home, 'settings.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const apiKey = process.env.DEEPSEEK_API_KEY?.trim() || stored.DEEPSEEK_API_KEY?.trim() || undefined;
const savedProvider = resolveProviderSettings(provider, { legacy: !!provider.baseUrl && !provider.protocol });
const protocol = process.env.DSH_MCP_PROTOCOL || savedProvider.protocol;
const providerRuntime = buildProviderRuntime({
  protocol,
  baseUrl: process.env.DEEPSEEK_BASE_URL ?? (protocol === savedProvider.protocol ? savedProvider.baseUrl : undefined),
  model: process.env.DSH_MCP_MODEL || savedProvider.model,
}, apiKey);

const worker = createWorker({ home, providerRuntime });
const monitor = createMonitor({ secret: apiKey });
const cards = createProgressCards({ secret: apiKey });
const instructions = await readFile(new URL('../config/routing.md', import.meta.url), 'utf8');
const server = new McpServer({ name: 'dsh-mcp', version: metadata.version }, { instructions });
server.registerTool('delegate_to_deepseek', {
  title: 'Delegate a bounded task to DeepSeek Harness',
  description: 'Execute bounded work that benefits from local investigation, reasoning or implementation choices. Codex retains instant edits, creative/aesthetic/important/complex/high-risk work and review. Supply a clear acceptance contract. Show an inline card first. Continue related work with session_id; a fresh progress_id is only a new card.',
  inputSchema: {
    project_root: z.string().min(1).describe('Required absolute project directory from Codex context or explicit user authorization. This is the caller directory grant, not an independently verified workspace ACL.'),
    task: z.string().trim().min(1).max(65536).describe('Goal, known facts, allowed files, local choices permitted, concrete acceptance checks, and a concise final receipt with files/results/questions.'),
    thinking_effort: z.enum(providerRuntime.thinkingEfforts).describe('Required model-supported DSH reasoning effort. Choose explicitly for every call and resume; unsupported levels are rejected, never silently clamped.'),
    cwd: z.string().min(1).default('.').describe('Directory relative to project_root, or an absolute directory within project_root.'),
    permission_mode: z.enum(['read-only', 'workspace-write']).default('read-only'),
    session_id: z.string().min(1).max(256).optional().describe('Previously returned DSH session ID for scoped revision in the same cwd.'),
    progress_id: z.string().uuid().optional().describe('Progress card returned by show_dsh_progress for this delegation. Logs remain UI-only.'),
    timeout_seconds: z.number().int().min(1).max(900).default(300),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
}, async (input, extra) => {
  let progress;
  try {
    if (input.progress_id) progress = cards.attach(input.progress_id);
    const result = await worker.delegate(input, {
      signal: extra.signal, onEvent(event) { monitor.publish(event); progress?.publish(event); },
    });
    progress?.finish(result.status);
    const modelResult = { ...result, diagnostics: '' };
    return {
      content: [{ type: 'text', text: JSON.stringify(modelResult) }],
      structuredContent: modelResult,
      _meta: { dshDiagnostics: result.diagnostics },
      isError: result.status !== 'completed',
    };
  } catch (error) {
    progress?.finish(extra.signal?.aborted ? 'cancelled' : 'failed');
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
});
registerProgressUi(server, cards);
server.registerTool('get_dsh_monitor', {
  title: 'Open DSH live progress',
  description: 'Get a legacy local monitor URL only when the user explicitly requests an external monitor. Do not call this automatically and never automatically open a sidebar or browser. Prefer show_dsh_progress for an inline conversation card.',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const result = { url: await monitor.start(), audience: 'user', scope: 'current MCP server', retention: 'current run, last 200 events, memory only' };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: `Progress monitor unavailable: ${error.message}. Delegation is still available.` }] };
  }
});
await server.connect(new StdioServerTransport());

// The SDK stdio transport does not close itself on stdin EOF.
const shutdown = () => {
  void Promise.all([server.close(), monitor.close()]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
};
process.stdin.once('end', shutdown);
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
