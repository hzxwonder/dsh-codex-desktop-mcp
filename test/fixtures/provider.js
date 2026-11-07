import { createServer } from 'node:http';

export async function providerFixture(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      let text = '';
      for await (const chunk of req) text += chunk;
      const request = { method: req.method, url: req.url, headers: req.headers, body: text ? JSON.parse(text) : undefined };
      requests.push(request);
      await handler(request, res);
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

export function sendInference(res, protocol, model, text = 'OK') {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const event = (type, data) => res.write(`${type ? `event: ${type}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
  if (protocol === 'chat-completions') {
    const chunk = { id: 'chat-fixture', object: 'chat.completion.chunk', created: 1, model };
    event(null, { ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
    event(null, { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } });
    res.end('data: [DONE]\n\n');
  } else if (protocol === 'responses') {
    const response = { id: 'resp_fixture', object: 'response', created_at: 1, model, status: 'in_progress', output: [] };
    const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'in_progress', content: [] };
    const part = { type: 'output_text', text, annotations: [] };
    event('response.created', { type: 'response.created', response });
    event('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item });
    event('response.content_part.added', { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: '' } });
    event('response.output_text.delta', { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text });
    event('response.output_text.done', { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text });
    const completed = { ...item, status: 'completed', content: [part] };
    event('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: completed });
    event('response.completed', { type: 'response.completed', response: { ...response, status: 'completed', output: [completed], usage: { input_tokens: 8, output_tokens: 1, total_tokens: 9 } } });
    res.end();
  } else {
    event('message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 } } });
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    event('content_block_stop', { type: 'content_block_stop', index: 0 });
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
    event('message_stop', { type: 'message_stop' });
    res.end();
  }
}
