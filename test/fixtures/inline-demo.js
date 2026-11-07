import { writeFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createProgressCards } from '../../src/progress-cards.js';
import { registerProgressUi } from '../../src/progress-ui.js';

async function main() {
  const cards = createProgressCards();
const timers = new Set();
const server = new McpServer({ name: 'dsh-inline-demo', version: '0.7.0-dev.0' });
registerProgressUi(server, {
  ...cards,
  open() {
    const access = cards.open();
    const canary = access.view_token;
    if (process.env.INLINE_DEMO_CANARY_FILE) void writeFile(process.env.INLINE_DEMO_CANARY_FILE, canary, { mode: 0o600 });
    const run = cards.attach(access.progress_id);
    run.publish({ type: 'run_start', model: '本机进度演示', permission_mode: 'read-only' });
    const events = [
      { type: 'status', phase: 'step_start', step: 1 },
      { type: 'tool_call', tool: 'BFS 示例检查', input: { nodes: 6 } },
      { type: 'tool_result', status: 'completed', result: `界面专用校验标记：${canary}` },
      { type: 'run_end', status: 'completed' },
    ];
    events.forEach((event, index) => {
      const timer = setTimeout(() => { run.publish(event); timers.delete(timer); }, (index + 1) * 2000);
      timers.add(timer);
    });
    return access;
  },
});
await server.connect(new StdioServerTransport());
process.stdin.once('end', async () => {
  for (const timer of timers) clearTimeout(timer);
  await server.close();
});

}

if (process.argv.includes('--demo')) await main();
