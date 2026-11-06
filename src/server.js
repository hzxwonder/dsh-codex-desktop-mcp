import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createWorker } from './worker.js';

const { values } = parseArgs({ options: {
  'workspace-root': { type: 'string' },
  'dsh-home': { type: 'string', default: fileURLToPath(new URL('../.dsh-mcp/home', import.meta.url)) },
  help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('Usage: node src/server.js --workspace-root /absolute/project [--dsh-home /private/dsh-home]');
  process.exit(0);
}
if (!values['workspace-root']) throw new Error('--workspace-root is required; implicit access to arbitrary directories is disabled');
if (process.platform === 'win32') throw new Error('This bridge requires POSIX process groups (macOS/Linux)');

const worker = await createWorker({
  workspaceRoot: values['workspace-root'], home: resolve(values['dsh-home']),
});
const server = new McpServer({ name: 'dsh-mcp', version: '0.1.0' });
server.registerTool('delegate_to_deepseek', {
  title: 'Delegate a bounded task to DeepSeek Harness',
  description: `Run one bounded task with DeepSeek Flash. The configured workspace root is ${worker.root}. Use read-only for analysis. Select workspace-write explicitly for edits. Supply complete context and acceptance criteria. Pause other writers. Review the actual files and check the result. A completed status does not mean task acceptance.`,
  inputSchema: {
    task: z.string().trim().min(1).max(65536).describe('Self-contained task, allowed files, constraints, acceptance criteria and requested verification.'),
    cwd: z.string().min(1).default('.').describe('Directory relative to the configured workspace root, or an absolute directory within it.'),
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
