import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { DEFAULT_BASE_URL, normalizeBaseUrl } from '../src/provider.js';
import { installProject } from '../src/setup.js';
import { createSetupForm } from '../src/setup-ui.js';

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-provider-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, 'project');
  await mkdir(workspaceRoot);
  return { workspaceRoot, home: join(root, 'private') };
}

async function absent(path) {
  await assert.rejects(lstat(path), { code: 'ENOENT' });
}

test('provider URLs preserve the Messages root and reject credential or URL injection', () => {
  assert.equal(normalizeBaseUrl(' '), DEFAULT_BASE_URL);
  assert.equal(normalizeBaseUrl(' https://provider.example/messages/v1/// '), 'https://provider.example/messages/v1');
  for (const value of ['file:///tmp/api', 'relative/path', 'https://user:secret@provider.example', 'https://provider.example?key=secret', 'https://provider.example#fragment', 'https://provider.example\n/hidden']) {
    assert.throws(() => normalizeBaseUrl(value), /Base URL/);
  }
});

test('setup preserves the saved key while changing the private provider endpoint', async (t) => {
  const paths = await project(t);
  const apiKey = 'sk-provider-test-not-a-real-key';
  await installProject({ ...paths, apiKey, baseUrl: 'https://first.example/messages/' });
  await installProject({ ...paths, apiKey: 'sk-ignored-replacement', baseUrl: 'https://second.example/v1/' });
  const settings = parseEnv(await readFile(join(paths.home, '.env'), 'utf8'));
  assert.equal(settings.DEEPSEEK_API_KEY, apiKey);
  assert.equal(JSON.parse(await readFile(join(paths.home, 'settings.json'), 'utf8')).baseUrl, 'https://second.example/v1');
  assert.equal(settings.DEEPSEEK_BASE_URL, undefined);
  assert(!String(await readFile(join(paths.workspaceRoot, '.codex', 'config.toml'))).includes(apiKey));
});

test('the setup form rejects cross-origin writes and invalid endpoints before saving settings', async (t) => {
  const paths = await project(t);
  const form = await createSetupForm({
    workspaceRoot: paths.workspaceRoot, baseUrl: DEFAULT_BASE_URL,
    onSubmit: (input) => installProject({ ...paths, ...input }),
  });
  form.completed.catch(() => {});
  t.after(() => form.close());
  const origin = new URL(form.url).origin;
  const apiKey = 'sk-browser-form-not-a-real-key';
  const body = new URLSearchParams({ apiKey, baseUrl: 'https://provider.example/messages' });
  for (const options of [{ url: origin + '/wrong-token', origin }, { url: form.url, origin: 'https://untrusted.example' }]) {
    const response = await fetch(options.url, { method: 'POST', headers: { Origin: options.origin }, body });
    assert([403, 404].includes(response.status));
    await response.text();
    await absent(paths.home);
    await absent(join(paths.workspaceRoot, '.codex'));
  }
  const forged = await fetch(form.url, { method: 'POST', headers: { Origin: origin }, body });
  assert.equal(forged.status, 403);
  await forged.text();
  await absent(paths.home);
  const formHtml = await (await fetch(form.url)).text();
  const csrf = /name="csrf" value="([a-f0-9]+)"/.exec(formHtml)?.[1];
  body.set('csrf', csrf);
  const invalid = await fetch(form.url, {
    method: 'POST', headers: { Origin: origin },
    body: new URLSearchParams({ apiKey, csrf, baseUrl: 'https://provider.example?credential=secret' }),
  });
  assert.equal(invalid.status, 400);
  assert(!(await invalid.text()).includes(apiKey));
  await absent(paths.home);
  const saved = await fetch(form.url, { method: 'POST', headers: { Origin: 'null' }, body });
  assert.equal(saved.status, 200);
  assert(!(await saved.text()).includes(apiKey));
  await form.completed;
  const settings = parseEnv(await readFile(join(paths.home, '.env'), 'utf8'));
  assert.equal(settings.DEEPSEEK_API_KEY, apiKey);
  assert.equal(JSON.parse(await readFile(join(paths.home, 'settings.json'), 'utf8')).baseUrl, 'https://provider.example/messages');
  assert.equal(settings.DEEPSEEK_BASE_URL, undefined);
});
