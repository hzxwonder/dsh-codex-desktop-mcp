import { parseArgs, parseEnv } from 'node:util';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createWorker } from './worker.js';
import metadata from '../package.json' with { type: 'json' };
import { normalizeBaseUrl, parseProviderSettings } from './provider.js';

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
const apiKey = process.env.DEEPSEEK_API_KEY ?? stored.DEEPSEEK_API_KEY;
if (apiKey !== undefined) process.env.DEEPSEEK_API_KEY = apiKey;
process.env.DEEPSEEK_BASE_URL = normalizeBaseUrl(process.env.DEEPSEEK_BASE_URL ?? provider.baseUrl);

const worker = createWorker({ home });
const instructions = await readFile(new URL('../config/routing.md', import.meta.url), 'utf8');
const server = new McpServer({ name: 'dsh-mcp', version: metadata.version }, { instructions });
server.registerTool('delegate_to_deepseek', {
  title: 'Delegate a bounded task to DeepSeek Harness',
  description: 'Run one bounded task with DeepSeek Flash. Supply the absolute project_root from active Codex context or explicit user authorization. Use read-only for analysis. Select workspace-write explicitly for edits. Supply complete context and acceptance criteria. Pause other writers. Review the actual files and check the result. A completed status does not mean task acceptance.',
  inputSchema: {
    project_root: z.string().min(1).describe('Required absolute project directory from Codex context or explicit user authorization. This is the caller directory grant, not an independently verified workspace ACL.'),
    task: z.string().trim().min(1).max(65536).describe('Self-contained task, allowed files, constraints, acceptance criteria and requested verification.'),
    cwd: z.string().min(1).default('.').describe('Directory relative to project_root, or an absolute directory within project_root.'),
    permission_mode: z.enum(['read-only', 'workspace-write']).default('read-only'),
    session_id: z.string().min(1).max(256).optional().describe('Previously returned DSH session ID for scoped revision in the same cwd.'),
    timeout_seconds: z.number().int().min(1).max(900).default(300),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
}, async (input, extra) => {
  try {
    const result = await worker.delegate(input, { signal: extra.signal });
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
      isError: result.status !== 'completed',
    };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
});
await server.connect(new StdioServerTransport());

// The SDK stdio transport does not close itself on stdin EOF.
const shutdown = () => {
  void server.close().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
};
process.stdin.once('end', shutdown);
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
