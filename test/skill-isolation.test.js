import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorker } from '../src/worker.js';
import { buildProviderRuntime } from '../src/provider.js';
import { installCodex } from '../src/setup.js';
import { providerFixture, sendInference } from './fixtures/provider.js';

const key = 'sk-skill-isolation-fixture';
async function baseFor(t) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-skill-isolation-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}
async function skill(path, name, description) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nFixture instructions.\n`);
}

test('native DSH discovers its own skills and excludes the supervisor catalog', { timeout: 30000 }, async (t) => {
  const base = await baseFor(t);
  const root = join(base, 'project');
  const home = join(base, 'worker-home');
  await skill(join(root, '.agents/skills/deepseek-worker'), 'deepseek-worker', 'FORBIDDEN_SUPERVISOR_CATALOG');
  await skill(join(root, '.dsh/skills/project-helper'), 'project-helper', 'ALLOWED_PROJECT_SKILL');
  await skill(join(home, 'skills/worker-helper'), 'worker-helper', 'ALLOWED_WORKER_SKILL');
  const fixture = await providerFixture(t, (_request, res) => sendInference(res, 'chat-completions', 'deepseek-flash', 'Ready.'));
  const providerRuntime = buildProviderRuntime({ protocol: 'chat-completions', model: 'deepseek-flash', baseUrl: fixture.baseUrl + '/v1' }, key);
  const worker = createWorker({ home, providerRuntime });
  const result = await worker.delegate({ project_root: root, task: 'Reply Ready without tools.', thinking_effort: 'low' });
  assert.equal(result.status, 'completed');
  // A live MCP server may still have the previous worker module in memory.
  const wrapper = join(base, 'previous-worker.mjs');
  const bin = new URL('./lib/bin.js', import.meta.resolve('@deepseek-ai/dsh/package.json')).href;
  await writeFile(wrapper, `delete process.env.DSH_MCP_SKILL_DIRS;\nconst { runCli } = await import(${JSON.stringify(bin)});\nawait runCli();\n`);
  const previousWorker = createWorker({ home, providerRuntime, command: [process.execPath, wrapper] });
  assert.equal((await previousWorker.delegate({ project_root: root, task: 'Reply Ready without tools.', thinking_effort: 'low' })).status, 'completed');
  const requests = JSON.stringify(fixture.requests.map(({ body }) => body));
  assert.equal(requests.includes('FORBIDDEN_SUPERVISOR_CATALOG'), false);
  assert.equal(requests.includes('ALLOWED_PROJECT_SKILL'), true);
  assert.equal(requests.includes('ALLOWED_WORKER_SKILL'), true);
});

test('default installation keeps supervisor instructions in the Codex skill directory', async (t) => {
  const base = await baseFor(t);
  const codexHome = join(base, 'codex');
  const result = await installCodex({ home: join(base, 'worker'), codexHome, legacySkillsHome: join(base, 'shared/skills'), apiKey: key });
  assert.equal(result.skillPath, join(codexHome, 'skills/deepseek-worker/SKILL.md'));
});

test('owned shared skill migrates without removing companion user files', async (t) => {
  const base = await baseFor(t);
  const codexHome = join(base, 'codex');
  const legacySkillsHome = join(base, 'shared/skills');
  const home = join(base, 'worker');
  await installCodex({ home, codexHome, skillsHome: legacySkillsHome, apiKey: key });
  const oldPath = join(legacySkillsHome, 'deepseek-worker/SKILL.md');
  const oldText = await readFile(oldPath, 'utf8');
  await chmod(oldPath, 0o640);
  const companion = join(legacySkillsHome, 'deepseek-worker/personal-notes.txt');
  await writeFile(companion, 'keep');
  const result = await installCodex({ home, codexHome, legacySkillsHome });
  assert.equal(await readFile(result.skillPath, 'utf8'), oldText);
  assert.equal((await stat(result.skillPath)).mode & 0o777, 0o640);
  await assert.rejects(readFile(oldPath), { code: 'ENOENT' });
  assert.equal(await readFile(companion, 'utf8'), 'keep');
  await installCodex({ home, codexHome, legacySkillsHome });
});

test('customized shared skill prevents migration before any user files change', async (t) => {
  const base = await baseFor(t);
  const codexHome = join(base, 'codex');
  const legacySkillsHome = join(base, 'shared/skills');
  const home = join(base, 'worker');
  await installCodex({ home, codexHome, skillsHome: legacySkillsHome, apiKey: key });
  const oldPath = join(legacySkillsHome, 'deepseek-worker/SKILL.md');
  const customized = (await readFile(oldPath, 'utf8')) + '\nCustom user instructions.\n';
  await writeFile(oldPath, customized);
  const before = await readFile(join(codexHome, 'config.toml'), 'utf8');
  await assert.rejects(installCodex({ home, codexHome, legacySkillsHome }), /shared.*skill|Back up/i);
  assert.equal(await readFile(oldPath, 'utf8'), customized);
  assert.equal(await readFile(join(codexHome, 'config.toml'), 'utf8'), before);
  await assert.rejects(stat(join(codexHome, 'skills')), { code: 'ENOENT' });
});

test('a shared skill without an owned registration is preserved', async (t) => {
  const base = await baseFor(t);
  const codexHome = join(base, 'codex');
  const legacySkillsHome = join(base, 'shared/skills');
  const path = join(legacySkillsHome, 'deepseek-worker');
  await skill(path, 'deepseek-worker', 'User-owned skill');
  const before = await readFile(join(path, 'SKILL.md'), 'utf8');
  await assert.rejects(installCodex({ home: join(base, 'worker'), codexHome, legacySkillsHome, apiKey: key }), /shared.*skill/);
  assert.equal(await readFile(join(path, 'SKILL.md'), 'utf8'), before);
  await assert.rejects(stat(codexHome), { code: 'ENOENT' });
});
