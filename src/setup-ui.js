import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

function page({ baseUrl, hasSavedKey, csrf, error = '', saved = false }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeepSeek MCP settings</title><style>
body{font:16px/1.5 system-ui,sans-serif;background:#f4f6f8;color:#17212b;margin:0;padding:48px 20px}
main{max-width:540px;margin:auto;background:white;padding:32px;border:1px solid #d9e0e7;border-radius:12px}
h1{font-size:24px;margin-top:0}label{display:block;font-weight:600;margin-top:24px}
input{box-sizing:border-box;width:100%;font:inherit;padding:10px;border:1px solid #9aa9b8;border-radius:6px;margin-top:6px}
small{display:block;color:#4e6071;margin-top:6px}code{overflow-wrap:anywhere}button{font:inherit;background:#165bc4;color:white;border:0;padding:11px 18px;border-radius:6px;margin-top:28px;cursor:pointer}
.error{color:#a21818}.scope{background:#f1f4f7;padding:12px;border-radius:6px}
</style></head><body><main><h1>DeepSeek MCP settings</h1>
${saved ? '<p>Settings saved. You can close this tab.</p><p>Start a new Codex session in any project.</p>' : `
<p>These settings apply to the local DeepSeek Harness worker.</p>
<p class="scope">Codex supplies the project directory for each task. Setup does not bind this server to a project.</p>
${error ? `<p class="error" role="alert">${escape(error)}</p>` : ''}
<form method="post" autocomplete="off">
<input type="hidden" name="csrf" value="${csrf}">
<label for="apiKey">API Key</label><input id="apiKey" name="apiKey" type="password" autocomplete="new-password" ${hasSavedKey ? 'disabled placeholder="An existing key will be used"' : 'required'}>
<small>The key stays in your private settings file. Setup keeps an existing key unchanged.</small>
<label for="baseUrl">Base URL (optional)</label><input id="baseUrl" name="baseUrl" type="url" value="${escape(baseUrl)}">
<small>Use a Messages API root. Leave empty to use https://api.deepseek.com/anthropic.</small>
<small>A custom endpoint receives your API key and task data.</small>
<button type="submit">Save and configure Codex</button></form>`}
</main></body></html>`;
}

export async function createSetupForm({ baseUrl, hasSavedKey = false, onSubmit }) {
  const path = `/${randomBytes(32).toString('hex')}`;
  const csrf = randomBytes(32).toString('hex');
  let origin;
  let submitting = false;
  let closing = false;
  let timer;
  let accept;
  let reject;
  const completed = new Promise((resolve, fail) => { accept = resolve; reject = fail; });
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (request.headers.host !== new URL(origin).host || request.url !== path) {
      response.writeHead(404).end('Not found.');
      return;
    }
    const render = (options, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(page({ baseUrl, hasSavedKey, csrf, ...options }));
    };
    if (request.method === 'GET') { render({}); return; }
    if (request.method !== 'POST') { response.writeHead(405).end('Use GET or POST.'); return; }
    if (request.headers.origin && ![origin, 'null'].includes(request.headers.origin)) {
      response.writeHead(403).end('Invalid origin.'); return;
    }
    if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
      response.writeHead(415).end('Use the setup form.'); return;
    }
    if (submitting || closing) { response.writeHead(409).end('Setup is already saving.'); return; }
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 16384) { response.writeHead(413).end('Settings are too large.'); return; }
        chunks.push(chunk);
      }
      const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      // A separate form token also protects webviews with a null or missing Origin.
      if (fields.get('csrf') !== csrf) { response.writeHead(403).end('Invalid form token.'); return; }
      submitting = true;
      const result = await onSubmit({ apiKey: fields.get('apiKey')?.trim() || undefined, baseUrl: fields.get('baseUrl') });
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(page({ baseUrl, hasSavedKey, saved: true }), () => finish(null, result));
    } catch (error) {
      submitting = false;
      render({ error: error.message }, 400);
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise((resolve, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  function finish(error, result) {
    if (closing) return;
    closing = true;
    clearTimeout(timer);
    server.close(() => error ? reject(error) : accept(result));
    if (error) server.closeAllConnections();
    else server.closeIdleConnections();
  }
  timer = setTimeout(() => finish(new Error('Setup form expired. Run setup again.')), 600000);
  return { url: origin + path, completed, close: () => finish(new Error('Setup cancelled.')) };
}

export function openSetupBrowser(url) {
  return new Promise((resolve) => {
    const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', shell: false });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}
