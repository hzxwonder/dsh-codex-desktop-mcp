import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEnv } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { installProject } from '../src/setup.js';

const apiKey = 'sk-installer-test-not-a-real-credential';
const replacementKey = 'sk-installer-test-must-not-replace-existing';

async function project(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-mcp-setup-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const base = await realpath(temporary);
  const workspaceRoot = join(base, 'project with spaces');
  const home = join(base, 'private home');
  await mkdir(workspaceRoot);
  return {
    base,
    workspaceRoot,
    home,
    configPath: join(workspaceRoot, '.codex', 'config.toml'),
    skillPath: join(workspaceRoot, '.agents', 'skills', 'deepseek-worker', 'SKILL.md'),
    agentsPath: join(workspaceRoot, 'AGENTS.md'),
  };
}

async function absent(path) {
  await assert.rejects(lstat(path), { code: 'ENOENT' });
}

async function noInstallation(paths, { config = true, skill = true } = {}) {
  await absent(paths.home);
  await absent(paths.agentsPath);
  if (config) await absent(paths.configPath);
  if (skill) await absent(paths.skillPath);
}

test('setup preserves unrelated configuration and prose while installing a private, project-bound server', async (t) => {
  const paths = await project(t);
  const unrelated = '# Keep this exact spacing and comment.\nmodel = "chosen-model"  # not a DSH setting\nmodel_provider = "company"\n\n[model_providers.company]\nname = "Company provider"\nbase_url = "https://example.invalid/v1"\n\n[mcp_servers.other]\ncommand = "/usr/bin/other"\nargs = ["--keep", "two words"]\n';
  const prose = '# Project instructions\n\nKeep the user\'s prose and whitespace.  \n\n';
  await mkdir(join(paths.workspaceRoot, '.codex'));
  await writeFile(paths.configPath, unrelated);
  await writeFile(paths.agentsPath, prose);
  const alias = join(paths.base, 'project alias');
  await symlink(paths.workspaceRoot, alias);

  await installProject({ workspaceRoot: alias, home: paths.home, apiKey });

  const configText = await readFile(paths.configPath, 'utf8');
  assert.ok(configText.includes(unrelated), 'unrelated TOML must remain byte-for-byte intact');
  const config = parse(configText);
  assert.equal(config.model, 'chosen-model');
  assert.equal(config.model_provider, 'company');
  assert.deepEqual(config.mcp_servers.other, parse(unrelated).mcp_servers.other);
  const server = config.mcp_servers.dsh;
  assert.equal(server.args[server.args.indexOf('--workspace-root') + 1], paths.workspaceRoot);
  assert.equal(server.args[server.args.indexOf('--dsh-home') + 1], paths.home);
  assert.ok(server.tool_timeout_sec > 900, 'the client timeout must exceed the maximum worker timeout');

  const agents = await readFile(paths.agentsPath, 'utf8');
  const skill = await readFile(paths.skillPath, 'utf8');
  assert.ok(agents.startsWith(prose), 'existing project instructions must remain intact');
  for (const [name, text] of [['config', configText], ['AGENTS', agents], ['skill', skill]]) {
    assert.ok(!text.includes(apiKey), `${name} must not contain the API key`);
  }
  const credentialsPath = join(paths.home, '.env');
  assert.equal(parseEnv(await readFile(credentialsPath, 'utf8')).DEEPSEEK_API_KEY, apiKey);
  assert.equal((await stat(credentialsPath)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.home)).mode & 0o777, 0o700);
});

test('repeated setup leaves managed files identical and preserves the saved key', async (t) => {
  const paths = await project(t);
  await installProject({ workspaceRoot: paths.workspaceRoot, home: paths.home, apiKey });
  const files = [paths.configPath, paths.agentsPath, paths.skillPath, join(paths.home, '.env')];
  const before = await Promise.all(files.map((path) => readFile(path, 'utf8')));

  await installProject({ workspaceRoot: paths.workspaceRoot, home: paths.home, apiKey: replacementKey });

  const after = await Promise.all(files.map((path) => readFile(path, 'utf8')));
  assert.deepEqual(after, before, 'reinstall must not duplicate routing/config or replace credentials');
  assert.equal(parseEnv(after[3]).DEEPSEEK_API_KEY, apiKey);
  for (const text of after) assert.ok(!text.includes(replacementKey));
  assert.deepEqual(Object.keys(parse(after[0]).mcp_servers), ['dsh']);
});

test('invalid TOML is rejected before creating credentials or project instructions', async (t) => {
  const paths = await project(t);
  const invalid = 'model = "keep me"\n[mcp_servers\ncommand = "broken"\n';
  await mkdir(join(paths.workspaceRoot, '.codex'));
  await writeFile(paths.configPath, invalid);

  await assert.rejects(installProject({ workspaceRoot: paths.workspaceRoot, home: paths.home, apiKey }));

  assert.equal(await readFile(paths.configPath, 'utf8'), invalid);
  await noInstallation(paths, { config: false });
});

test('an unowned dsh server is rejected without changing user configuration or adding installation files', async (t) => {
  const paths = await project(t);
  const original = '# User-owned server\n[mcp_servers.dsh]\ncommand = "/custom/dsh"\nargs = ["--user-option"]\n';
  await mkdir(join(paths.workspaceRoot, '.codex'));
  await writeFile(paths.configPath, original);

  await assert.rejects(installProject({ workspaceRoot: paths.workspaceRoot, home: paths.home, apiKey }));

  assert.equal(await readFile(paths.configPath, 'utf8'), original);
  await noInstallation(paths, { config: false });
});

test('a different preexisting worker skill is rejected before config, AGENTS or credential writes', async (t) => {
  const paths = await project(t);
  const original = '---\nname: deepseek-worker\n---\n\nUser-authored worker instructions.\n';
  await mkdir(join(paths.workspaceRoot, '.agents', 'skills', 'deepseek-worker'), { recursive: true });
  await writeFile(paths.skillPath, original);

  await assert.rejects(installProject({ workspaceRoot: paths.workspaceRoot, home: paths.home, apiKey }));

  assert.equal(await readFile(paths.skillPath, 'utf8'), original);
  await noInstallation(paths, { skill: false });
});

test('a symlink credential file is rejected without reading through or overwriting its target', async (t) => {
  const paths = await project(t);
  const target = join(paths.base, 'unrelated.env');
  const original = 'DEEPSEEK_API_KEY=sk-symlink-target-not-a-real-credential\nUNRELATED=keep\n';
  await writeFile(target, original, { mode: 0o640 });
  const targetMode = (await stat(target)).mode;
  await mkdir(paths.home, { mode: 0o700 });
  const credentialsPath = join(paths.home, '.env');
  await symlink(target, credentialsPath);

  await assert.rejects(installProject({ workspaceRoot: paths.workspaceRoot, home: paths.home, apiKey }));

  assert.ok((await lstat(credentialsPath)).isSymbolicLink());
  assert.equal(await readFile(target, 'utf8'), original);
  assert.equal((await stat(target)).mode, targetMode);
  await absent(paths.configPath);
  await absent(paths.agentsPath);
  await absent(paths.skillPath);
});
