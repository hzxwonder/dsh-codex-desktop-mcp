import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { progressResourceUri } from './progress-cards.js';

export function registerProgressUi(server, cards) {
  server.registerResource('dsh-progress', progressResourceUri, {}, async () => ({
    contents: [{
      uri: progressResourceUri,
      mimeType: 'text/html;profile=mcp-app',
      text: await readFile(new URL('./progress-card.html', import.meta.url), 'utf8'),
      _meta: { ui: { prefersBorder: true }, 'openai/ui': { availableDisplayModes: ['inline'] } },
    }],
  }));
  const outputSchema = { progress_id: z.string(), status: z.string() };
  server.registerTool('show_dsh_progress', {
    title: 'DSH 执行进度',
    description: 'Show an inline progress card in this conversation before delegation. Pass the returned progress_id to delegate_to_deepseek. Do not open a sidebar or browser. Logs are UI-only; if the host cannot render cards, continue with final results.',
    inputSchema: {}, outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: {
      ui: { resourceUri: progressResourceUri },
      'openai/outputTemplate': progressResourceUri,
      'openai/ui': { preferredModelDisplayMode: 'inline' },
    },
  }, async () => {
    const { progress_id, view_token } = cards.open();
    return {
      content: [{ type: 'text', text: 'DSH 进度卡片已准备。' }],
      structuredContent: { progress_id, status: 'waiting' },
      _meta: { dshProgress: { progress_id, view_token } },
    };
  });
  server.registerTool('read_dsh_progress', {
    title: 'Refresh DSH progress card',
    description: 'UI-only progress refresh. Not available to the model.',
    inputSchema: {
      progress_id: z.string().uuid(), view_token: z.string().length(64), after_seq: z.number().int().min(0).default(0),
    }, outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private', 'openai/widgetAccessible': true },
  }, async ({ progress_id, view_token, after_seq }) => {
    try {
      const progress = cards.read(progress_id, view_token, after_seq);
      return {
        content: [], structuredContent: { progress_id, status: progress.status },
        _meta: { dshProgress: progress },
      };
    } catch {
      return { isError: true, content: [{ type: 'text', text: 'Progress card expired or access denied.' }] };
    }
  });
}
