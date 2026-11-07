import { parseArgs, parseEnv } from 'node:util';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createWorker } from './worker.js';
import { createMonitor } from './monitor.js';
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
const instructions = await readFile(new URL('../config/routing.md', import.meta.url), 'utf8');
const server = new McpServer({ name: 'dsh-mcp', version: metadata.version }, { instructions });
server.registerTool('delegate_to_deepseek', {
  title: 'Delegate a bounded task to DeepSeek Harness',
  description: 'Default executor for clear, low-risk, verifiable simple code (including BFS), tests, routine documents, and mechanical edits, even small tasks. Codex retains creative discussions, research, paper writing, complex design, high-risk work, and final review. Open get_dsh_monitor for user progress without reading logs. Supply the authorized absolute project_root, explicit thinking_effort, complete context and acceptance criteria. Use read-only unless edits need workspace-write. Pause other writers; review final artifacts and checks. Completion is not acceptance.',
  inputSchema: {
    project_root: z.string().min(1).describe('Required absolute project directory from Codex context or explicit user authorization. This is the caller directory grant, not an independently verified workspace ACL.'),
    task: z.string().trim().min(1).max(65536).describe('Self-contained task, allowed files, constraints, acceptance criteria and requested verification.'),
    thinking_effort: z.enum(providerRuntime.thinkingEfforts).describe('Required model-supported DSH reasoning effort. Choose explicitly for every call and resume; unsupported levels are rejected, never silently clamped.'),
    cwd: z.string().min(1).default('.').describe('Directory relative to project_root, or an absolute directory within project_root.'),
    permission_mode: z.enum(['read-only', 'workspace-write']).default('read-only'),
    session_id: z.string().min(1).max(256).optional().describe('Previously returned DSH session ID for scoped revision in the same cwd.'),
    timeout_seconds: z.number().int().min(1).max(900).default(300),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
}, async (input, extra) => {
  try {
    const result = await worker.delegate(input, { signal: extra.signal, onEvent: monitor.publish });
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
      isError: result.status !== 'completed',
    };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
});
server.registerTool('get_dsh_monitor', {
  title: 'Open DSH live progress',
  description: 'Get a local browser URL for user-only live progress before delegation. Open once in the Codex sidebar with open_in_codex browser, or give the user a clickable link. Do not fetch, read, screenshot, or poll this page as an agent. No logs enter this tool result. A monitor failure does not block delegation.',
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
