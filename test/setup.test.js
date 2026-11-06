import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEnv } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { installCodex } from '../src/setup.js';

const apiKey = 'sk-installer-test-not-a-real-credential';
const replacementKey = 'sk-installer-test-must-not-replace-existing';

async function profile(t) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-mcp-profile-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const codexHome = join(base, 'custom codex home');
  const skillsHome = join(base, 'user skills');
  return {
    base, codexHome, skillsHome, home: join(base, 'private home'),
    configPath: join(codexHome, 'config.toml'),
    skillPath: join(skillsHome, 'deepseek-worker', 'SKILL.md'),
    agentsPath: join(codexHome, 'AGENTS.md'),
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

test('global setup preserves model settings, other servers and user instructions while protecting credentials', async (t) => {
  const paths = await profile(t);
  const unrelated = '# Keep this exact spacing.\nmodel = "chosen-model"  # not a DSH setting\nmodel_provider = "company"\n\n[model_providers.company]\nname = "Company provider"\nbase_url = "https://example.invalid/v1"\n\n[mcp_servers.other]\ncommand = "/usr/bin/other"\nargs = ["--keep", "two words"]\n';
  const prose = '# Personal instructions\n\nKeep user rules and whitespace.  \n';
  await mkdir(paths.codexHome);
  await writeFile(paths.configPath, unrelated);
  await writeFile(paths.agentsPath, prose);

  await installCodex({ ...paths, apiKey });

  const configText = await readFile(paths.configPath, 'utf8');
  assert(configText.includes(unrelated), 'unrelated configuration must remain byte-for-byte intact');
  const config = parse(configText);
  assert.equal(config.model, 'chosen-model');
  assert.equal(config.model_provider, 'company');
  assert.deepEqual(config.mcp_servers.other, parse(unrelated).mcp_servers.other);
  assert(config.mcp_servers.dsh.tool_timeout_sec > 900);
  assert.equal(await readFile(paths.agentsPath, 'utf8'), prose);
  const skill = await readFile(paths.skillPath, 'utf8');
  for (const text of [configText, skill, prose]) assert(!text.includes(apiKey));
  const keyPath = join(paths.home, '.env');
  assert.equal(parseEnv(await readFile(keyPath, 'utf8')).DEEPSEEK_API_KEY, apiKey);
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(paths.home, 'settings.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(paths.home)).mode & 0o777, 0o700);
});

test('repeated global setup preserves the saved key and does not duplicate managed configuration', async (t) => {
  const paths = await profile(t);
  await installCodex({ ...paths, apiKey });
  const files = [paths.configPath, paths.skillPath, join(paths.home, '.env'), join(paths.home, 'settings.json')];
  const before = await Promise.all(files.map((path) => readFile(path, 'utf8')));
  await installCodex({ ...paths, apiKey: replacementKey });
  const after = await Promise.all(files.map((path) => readFile(path, 'utf8')));
  assert.deepEqual(after, before);
  assert.equal(parseEnv(after[2]).DEEPSEEK_API_KEY, apiKey);
  for (const text of after) assert(!text.includes(replacementKey));
  await absent(paths.agentsPath);
});

test('invalid global TOML fails before credentials or skills are created', async (t) => {
  const paths = await profile(t);
  const invalid = 'model = "keep me"\n[mcp_servers\ncommand = "broken"\n';
  await mkdir(paths.codexHome);
  await writeFile(paths.configPath, invalid);
  await assert.rejects(installCodex({ ...paths, apiKey }));
  assert.equal(await readFile(paths.configPath, 'utf8'), invalid);
  await noInstallation(paths, { config: false });
});

test('an unowned global dsh server remains unchanged after a setup conflict', async (t) => {
  const paths = await profile(t);
  const original = '# User server\n[mcp_servers.dsh]\ncommand = "/custom/dsh"\nargs = ["--user-option"]\n';
  await mkdir(paths.codexHome);
  await writeFile(paths.configPath, original);
  await assert.rejects(installCodex({ ...paths, apiKey }));
  assert.equal(await readFile(paths.configPath, 'utf8'), original);
  await noInstallation(paths, { config: false });
});

test('a different user skill remains unchanged and blocks all installation writes', async (t) => {
  const paths = await profile(t);
  const original = '---\nname: deepseek-worker\n---\n\nUser-authored instructions.\n';
  await mkdir(join(paths.skillsHome, 'deepseek-worker'), { recursive: true });
  await writeFile(paths.skillPath, original);
  await assert.rejects(installCodex({ ...paths, apiKey }));
  assert.equal(await readFile(paths.skillPath, 'utf8'), original);
  await noInstallation(paths, { skill: false });
});

test('a symlink credential file cannot redirect global setup writes', async (t) => {
  const paths = await profile(t);
  const target = join(paths.base, 'unrelated.env');
  const original = 'DEEPSEEK_API_KEY=sk-symlink-target-not-a-real-credential\nUNRELATED=keep\n';
  await writeFile(target, original, { mode: 0o640 });
  const targetMode = (await stat(target)).mode;
  await mkdir(paths.home, { mode: 0o700 });
  const keyPath = join(paths.home, '.env');
  await symlink(target, keyPath);
  await assert.rejects(installCodex({ ...paths, apiKey }));
  assert((await lstat(keyPath)).isSymbolicLink());
  assert.equal(await readFile(target, 'utf8'), original);
  assert.equal((await stat(target)).mode, targetMode);
  await absent(join(paths.home, 'settings.json'));
  await absent(paths.configPath);
  await absent(paths.skillPath);
});
