import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMonitor } from '../src/monitor.js';
import { request } from 'node:http';

async function monitorFor(t, options) {
  const monitor = createMonitor(options);
  t.after(() => monitor.close());
  const url = new URL(await monitor.start());
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
  const snapshot = async () => (await fetch(new URL('/events', url), { headers })).json();
  return { monitor, url, headers, snapshot };
}

test('monitor requires its local capability and rejects other origins, hosts, and writes', async (t) => {
  const { monitor, url, headers } = await monitorFor(t);
  assert.equal(await monitor.start(), url.href, 'opening twice reuses one monitor');
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert(!((await page.text()).includes(url.hash.slice(1))), 'static HTML must not contain the access token');
  assert.equal((await fetch(new URL('/events', url))).status, 401);
  assert.equal((await fetch(new URL('/events', url), { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(new URL('/events', url), { headers: { ...headers, Origin: 'https://other.example' } })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = request(new URL('/events', url), { headers: { ...headers, Host: 'other.example' } }, (res) => {
      res.resume(); resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await fetch(new URL('/events', url), { headers, method: 'POST' })).status, 405);
  assert.equal((await fetch(new URL('/missing', url), { headers })).status, 404);
});

test('user projection filters hidden material, redacts credentials, and resets between tasks', async (t) => {
  const secret = 'sk-monitor-fixture';
  const { monitor, snapshot } = await monitorFor(t, { secret });
  monitor.publish({ type: 'run_start', model: 'fixture', permission_mode: 'read-only' });
  monitor.publish({ type: 'thinking', text: 'private reasoning' });
  monitor.publish({ type: 'session', sessionId: 'private-session', cwd: '/private/path' });
  monitor.publish({ type: 'status', phase: secret });
  monitor.publish({ type: 'text', text: `<script>${secret}</script>` });
  monitor.publish({ type: 'tool_call', tool: 'shell', input: { command: secret } });
  monitor.publish({ type: 'tool_result', status: 'completed', result: secret });
  monitor.publish({ type: 'final', text: 'stdout is not a verified final answer' });
  monitor.publish({ type: 'run_end', status: 'completed' });
  const result = await snapshot();
  assert.deepEqual(result.events.map(({ type }) => type), ['run_start', 'text', 'tool_call', 'tool_result', 'run_end']);
  const serialized = JSON.stringify(result);
  for (const hidden of [secret, 'private reasoning', '/private/path', 'private-session', 'stdout is not']) assert(!serialized.includes(hidden));
  assert(serialized.includes('[REDACTED]'));
  const lastId = result.events.at(-1).id;
  monitor.publish({ type: 'run_start', model: 'next', permission_mode: 'workspace-write' });
  const next = await snapshot();
  assert.equal(next.events.length, 1);
  assert(next.events[0].id > lastId, 'browser can distinguish replacement runs');
});

test('structural lifecycle status events stay out while public text is preserved', async (t) => {
  const { monitor, snapshot } = await monitorFor(t);
  monitor.publish({ type: 'run_start', model: 'fixture', permission_mode: 'read-only' });
  for (const phase of ['turn_start', 'step_start', 'step_end', 'turn_end']) {
    monitor.publish({ type: 'status', phase, step: 3 });
  }
  monitor.publish({ type: 'text', text: 'literal turn_end and step3 stay' });
  monitor.publish({ type: 'run_end', status: 'completed' });
  const { events } = await snapshot();
  assert.deepEqual(events.map(({ type }) => type), ['run_start', 'text', 'run_end']);
  assert(events.some(({ type, message }) => type === 'text' && message === 'literal turn_end and step3 stay'));
  assert(!JSON.stringify(events).includes('step 3'));
});

test('progress retention and event size are bounded and close invalidates the URL', async (t) => {
  const { monitor, snapshot, url } = await monitorFor(t);
  for (let i = 0; i < 250; i++) monitor.publish({ type: 'text', text: 'x'.repeat(9000) });
  const { events } = await snapshot();
  assert.equal(events.length, 200);
  assert(events.every(({ message }) => message.length === 8000));
  assert.equal(events[0].id, 51);
  await monitor.close();
  await assert.rejects(fetch(url));
});
