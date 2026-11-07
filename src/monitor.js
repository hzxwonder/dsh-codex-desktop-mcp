import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// This projection is kept in memory and served to the user's browser only.
export function createMonitor({ secret } = {}) {
  const token = randomBytes(32).toString('hex');
  const events = [];
  let sequence = 0;
  let server;
  let starting;
  let origin;
  const clean = (value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return (secret ? text.replaceAll(secret, '[REDACTED]') : text).slice(0, 8000);
  };
  const publish = (event) => {
    let message;
    switch (event.type) {
      case 'run_start': events.length = 0; message = `Started · ${event.model} · ${event.permission_mode}`; break;
      case 'status':
        if (!['turn_start', 'step_start', 'step_end', 'turn_end'].includes(event.phase)) return;
        message = `${event.phase}${Number.isInteger(event.step) ? ` · step ${event.step}` : ''}`;
        break;
      case 'text': message = event.text; break;
      case 'tool_call': message = `${event.tool}\n${JSON.stringify(event.input, null, 2)}`; break;
      case 'tool_result': message = `${event.status}\n${event.result ?? ''}`; break;
      case 'run_end': message = `Finished · ${event.status}`; break;
      default: return; // Never forward thinking, prompts, session paths, or stderr.
    }
    if (typeof message !== 'string') return;
    events.push({ id: ++sequence, time: new Date().toISOString(), type: event.type, message: clean(message) });
    if (events.length > 200) events.shift();
  };
  return {
    publish,
    async start() {
      if (!starting) starting = (async () => {
        const html = await readFile(new URL('./monitor.html', import.meta.url), 'utf8');
        const nonce = randomBytes(16).toString('hex');
        server = createServer((req, res) => {
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Referrer-Policy', 'no-referrer');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'`);
          if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) {
            res.writeHead(403).end(); return;
          }
          if (req.method !== 'GET') { res.writeHead(405).end(); return; }
          if (req.url === '/') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(html.replaceAll('__NONCE__', nonce)); return;
          }
          if (req.url !== '/events') { res.writeHead(404).end(); return; }
          if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ events }));
        });
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        });
        origin = `http://127.0.0.1:${server.address().port}`;
        server.unref();
        return `${origin}/#${token}`;
      })().catch((error) => { starting = undefined; throw error; });
      return starting;
    },
    async close() {
      if (starting) await starting.catch(() => {});
      if (!server?.listening) return;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
