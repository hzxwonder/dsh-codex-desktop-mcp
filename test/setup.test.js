import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEnv } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { installCodex } from '../src/setup.js';

const apiKey = 'sk-installer-test-not-a-real-credential';
const replacementKey = 'sk-installer-test-explicit-rotation';
const agentsBegin = '<!-- BEGIN dsh-mcp -->';
const agentsEnd = '<!-- END dsh-mcp -->';

function occurrences(text, marker) {
  return text.split(marker).length - 1;
}

function assertSingleManagedAgentsBlock(text) {
  assert.equal(occurrences(text, agentsBegin), 1, 'AGENTS must contain exactly one BEGIN marker');
  assert.equal(occurrences(text, agentsEnd), 1, 'AGENTS must contain exactly one END marker');
  assert.ok(text.indexOf(agentsBegin) < text.indexOf(agentsEnd), 'BEGIN must precede END');
}

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

async function previousInstallation(t, { source = false } = {}) {
  const paths = await profile(t);
  const previousRoot = source
    ? join(paths.base, 'previous source checkout')
    : join(paths.base, '.npm', '_npx', 'previous', 'node_modules', '@hzxwonder', 'dsh-mcp');
  const previousScript = join(previousRoot, 'src', 'server.js');
  const previousSkillPath = join(previousRoot, '.agents', 'skills', 'deepseek-worker', 'SKILL.md');
  const oldSkill = '---\nname: deepseek-worker\ndescription: Previous packaged worker instructions.\n---\n\nDelegate a bounded task with the previous contract.\n';
  const unrelated = 'model = "personal-model"\nmodel_provider = "personal-provider"\n\n[model_providers.personal-provider]\nname = "Personal provider"\nbase_url = "https://personal.example/v1"\n\n[mcp_servers.other]\ncommand = "/keep/other-server"\n';
  const serverEntry = [
    '[mcp_servers.dsh]', `command = ${JSON.stringify(process.execPath)}`,
    `args = ${JSON.stringify([previousScript, '--dsh-home', paths.home])}`,
    'startup_timeout_sec = 20', 'tool_timeout_sec = 960',
  ].join('\n');
  await Promise.all([
    mkdir(join(previousRoot, 'src'), { recursive: true }),
    mkdir(join(previousRoot, '.agents', 'skills', 'deepseek-worker'), { recursive: true }),
    mkdir(join(paths.skillsHome, 'deepseek-worker'), { recursive: true }),
    mkdir(paths.codexHome), mkdir(paths.home),
  ]);
  const packageName = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).name;
  const authPath = join(paths.codexHome, 'auth.json');
  await Promise.all([
    writeFile(join(previousRoot, 'package.json'), JSON.stringify({ name: packageName, version: '0.3.0' })),
    writeFile(previousScript, 'export {};\n'),
    writeFile(previousSkillPath, oldSkill),
    writeFile(paths.skillPath, oldSkill, { mode: 0o640 }),
    writeFile(paths.configPath, `${unrelated}\n# BEGIN dsh-mcp\n${serverEntry}\n# END dsh-mcp\n`),
    writeFile(paths.agentsPath, '# Personal rules\n\nKeep these instructions.\n'),
    writeFile(authPath, '{"login":"personal-login-preserved"}\n'),
    writeFile(join(paths.home, '.env'), `UNRELATED=keep\nDEEPSEEK_API_KEY=${apiKey}\n`, { mode: 0o640 }),
    writeFile(join(paths.home, 'settings.json'), '{"baseUrl":"https://saved.example/v1","custom":{"keep":true}}\n', { mode: 0o640 }),
  ]);
  return { ...paths, previousRoot, previousScript, previousSkillPath, oldSkill, unrelated, serverEntry, authPath };
}

test('a managed previous npm installation upgrades its untouched skill without replacing personal settings or credentials', async (t) => {
  const paths = await previousInstallation(t);
  const keyPath = join(paths.home, '.env');
  const keyBefore = await readFile(keyPath, 'utf8');
  const agentsBefore = await readFile(paths.agentsPath, 'utf8');
  const authBefore = await readFile(paths.authPath, 'utf8');
  await installCodex(paths);
  const configText = await readFile(paths.configPath, 'utf8');
  assert(configText.includes(paths.unrelated));
  const server = parse(configText).mcp_servers.dsh;
  assert.notEqual(server.args[0], paths.previousScript);
  assert.deepEqual(server.args.slice(1), ['--dsh-home', paths.home]);
  const upgradedSkill = await readFile(paths.skillPath, 'utf8');
  assert.notEqual(upgradedSkill, paths.oldSkill);
  assert.equal((await stat(paths.skillPath)).mode & 0o777, 0o640);
  assert.equal(await readFile(keyPath, 'utf8'), keyBefore);
  const agentsText = await readFile(paths.agentsPath, 'utf8');
  assert.ok(agentsText.startsWith(agentsBefore), 'original user AGENTS text must be preserved');
  assertSingleManagedAgentsBlock(agentsText);
  assert.equal(await readFile(paths.authPath, 'utf8'), authBefore);
  assert.deepEqual(JSON.parse(await readFile(join(paths.home, 'settings.json'), 'utf8')), {
    baseUrl: 'https://saved.example/v1', custom: { keep: true }, protocol: 'anthropic', model: 'deepseek-flash',
  });
  await installCodex(paths);
  assert.equal(await readFile(paths.configPath, 'utf8'), configText);
  assert.equal(await readFile(paths.skillPath, 'utf8'), upgradedSkill);
  assert.equal(await readFile(paths.agentsPath, 'utf8'), agentsText, 'repeated setup must not duplicate the managed AGENTS block');
});

for (const scenario of [
  {
    name: 'a user-edited previously installed skill',
    change: (paths) => writeFile(paths.skillPath, `${paths.oldSkill}\nMy customized worker rules.\n`),
  },
  {
    name: 'a missing previous npm cache',
    change: (paths) => rm(paths.previousRoot, { recursive: true }),
  },
  {
    name: 'a source checkout whose previous template no longer exists',
    source: true,
    change: (paths) => rm(paths.previousSkillPath),
  },
  {
    name: 'a previous script belonging to a different package',
    change: (paths) => writeFile(join(paths.previousRoot, 'package.json'), '{"name":"another-package"}\n'),
  },
  {
    name: 'an unrecognizable previous server script reference',
    change: async (paths) => writeFile(paths.configPath, (await readFile(paths.configPath, 'utf8'))
      .replace(JSON.stringify(paths.previousScript), JSON.stringify(join(paths.previousRoot, 'other.js')))),
  },
  {
    name: 'an unowned dsh section with an unrelated managed block',
    change: (paths) => writeFile(paths.configPath,
      `${paths.unrelated}\n# BEGIN dsh-mcp\n[mcp_servers.marker_only]\ncommand = "/keep/marker-server"\n# END dsh-mcp\n\n${paths.serverEntry}\n`),
  },
]) {
  test(`${scenario.name} preserves all user files and blocks partial setup writes`, async (t) => {
    const paths = await previousInstallation(t, scenario);
    await scenario.change(paths);
    const keyPath = join(paths.home, '.env');
    await writeFile(keyPath, 'UNRELATED=keep-without-a-saved-api-key\n');
    const files = [paths.configPath, paths.skillPath, keyPath, join(paths.home, 'settings.json'), paths.agentsPath, paths.authPath];
    const snapshot = () => Promise.all(files.map(async (path) => ({
      text: await readFile(path, 'utf8'), mode: (await stat(path)).mode,
    })));
    const before = await snapshot();
    await assert.rejects(installCodex({
      ...paths, apiKey: replacementKey, baseUrl: 'https://must-not-be-written.example/v1',
    }), /[Bb]ack up|[Pp]reserve or rename/);
    assert.deepEqual(await snapshot(), before);
  });
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
  const agentsText = await readFile(paths.agentsPath, 'utf8');
  assert.ok(agentsText.startsWith(prose), 'user AGENTS text and whitespace must remain intact before the managed block');
  assertSingleManagedAgentsBlock(agentsText);
  const skill = await readFile(paths.skillPath, 'utf8');
  for (const text of [configText, skill, agentsText]) assert(!text.includes(apiKey));
  const keyPath = join(paths.home, '.env');
  assert.equal(parseEnv(await readFile(keyPath, 'utf8')).DEEPSEEK_API_KEY, apiKey);
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(paths.home, 'settings.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(paths.home)).mode & 0o777, 0o700);
});

test('repeated global setup preserves the saved key and does not duplicate managed configuration', async (t) => {
  const paths = await profile(t);
  await installCodex({ ...paths, apiKey });
  const files = [paths.configPath, paths.skillPath, join(paths.home, '.env'), join(paths.home, 'settings.json'), paths.agentsPath];
  const before = await Promise.all(files.map((path) => readFile(path, 'utf8')));
  assertSingleManagedAgentsBlock(before[4]);
  await installCodex(paths);
  const after = await Promise.all(files.map((path) => readFile(path, 'utf8')));
  assert.deepEqual(after, before);
  assert.equal(parseEnv(after[2]).DEEPSEEK_API_KEY, apiKey);
  for (const text of after) assert(!text.includes(replacementKey));
});

test('rule updates replace one managed AGENTS block in place while preserving surrounding user text and mode', async (t) => {
  const paths = await profile(t);
  const routing = await readFile(new URL('../config/agents.md', import.meta.url), 'utf8');
  const before = '# Personal rules before\n\nKeep this before the managed block.\n\n';
  const after = '\n## Personal rules after\n\nKeep this after the managed block.\n';
  const stale = `${before}${agentsBegin}\n## Stale DSH rules\n\nRemove this old block body.\n${agentsEnd}${after}`;
  await mkdir(paths.codexHome);
  await writeFile(paths.agentsPath, stale, { mode: 0o640 });

  await installCodex({ ...paths, apiKey });
  const installed = await readFile(paths.agentsPath, 'utf8');
  assert.ok(installed.startsWith(before), 'text before the managed block must be preserved');
  assert.ok(installed.includes('## Personal rules after'), 'text after the managed block must be preserved');
  assert.ok(installed.includes('Keep this after the managed block.'), 'tail user text must be preserved');
  assert.ok(!installed.includes('## Stale DSH rules'), 'stale managed body must be replaced');
  assert.ok(installed.includes(routing.trimEnd()), 'managed body must match the packaged rules');
  assertSingleManagedAgentsBlock(installed);
  assert.equal((await stat(paths.agentsPath)).mode & 0o777, 0o640, 'existing AGENTS permissions must be preserved');

  await installCodex(paths);
  assert.equal(await readFile(paths.agentsPath, 'utf8'), installed, 'repeated rule update must be idempotent');
});

for (const scenario of [
  {
    name: 'an incomplete managed AGENTS block',
    agents: '# Personal rules\n\n<!-- BEGIN dsh-mcp -->\n[stale without an end marker]\n',
  },
  {
    name: 'duplicate managed AGENTS blocks',
    agents: `# Personal rules\n\n${agentsBegin}\nfirst body\n${agentsEnd}\n\n${agentsBegin}\nsecond body\n${agentsEnd}\n`,
  },
]) {
  test(`${scenario.name} blocks all installation writes`, async (t) => {
    const paths = await profile(t);
    await mkdir(paths.codexHome);
    await writeFile(paths.agentsPath, scenario.agents, { mode: 0o640 });
    await assert.rejects(installCodex({ ...paths, apiKey }), /Repair the incomplete or duplicate managed block/);
    assert.equal(await readFile(paths.agentsPath, 'utf8'), scenario.agents);
    assert.equal((await stat(paths.agentsPath)).mode & 0o777, 0o640);
    await absent(paths.home);
    await absent(paths.configPath);
    await absent(paths.skillPath);
  });
}

test('a symlink AGENTS.md blocks all installation writes', async (t) => {
  const paths = await profile(t);
  const target = join(paths.base, 'personal-agents.md');
  const original = '# Personal rules\n\nKeep this symlink target untouched.\n';
  await writeFile(target, original, { mode: 0o640 });
  const targetMode = (await stat(target)).mode;
  await mkdir(paths.codexHome);
  await symlink(target, paths.agentsPath);

  await assert.rejects(installCodex({ ...paths, apiKey }), /Expected a regular file/);
  assert((await lstat(paths.agentsPath)).isSymbolicLink());
  assert.equal(await readFile(target, 'utf8'), original);
  assert.equal((await stat(target)).mode, targetMode);
  await absent(paths.home);
  await absent(paths.configPath);
  await absent(paths.skillPath);
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

test('explicit key rotation removes the old secret and preserves unrelated dotenv values', async (t) => {
  const paths = await profile(t);
  await installCodex({ ...paths, apiKey });
  const keyPath = join(paths.home, '.env');
  const prefix = '# Preserve this comment\r\nUNRELATED=\"keep value\"\r\n';
  const suffix = 'ANOTHER=value\r\n';
  await writeFile(keyPath, `${prefix}export DEEPSEEK_API_KEY=${JSON.stringify(apiKey)}\r\n${suffix}`);
  const configBefore = await readFile(paths.configPath, 'utf8');
  const providerBefore = await readFile(join(paths.home, 'settings.json'), 'utf8');
  await installCodex({ ...paths, apiKey: replacementKey });
  const rotated = await readFile(keyPath, 'utf8');
  assert.equal(parseEnv(rotated).DEEPSEEK_API_KEY, replacementKey);
  assert(!rotated.includes(apiKey));
  assert(rotated.startsWith(prefix));
  assert(rotated.endsWith(suffix));
  assert.equal(await readFile(paths.configPath, 'utf8'), configBefore);
  assert.equal(await readFile(join(paths.home, 'settings.json'), 'utf8'), providerBefore);
});

test('credential edits cannot corrupt an unrelated multiline dotenv value', async (t) => {
  const paths = await profile(t);
  await installCodex({ ...paths, apiKey });
  const keyPath = join(paths.home, '.env');
  const original = `UNRELATED="first
DEEPSEEK_API_KEY=inside-unrelated-value
last"
DEEPSEEK_API_KEY=${apiKey}
`;
  await writeFile(keyPath, original);
  const configBefore = await readFile(paths.configPath, 'utf8');
  const providerBefore = await readFile(join(paths.home, 'settings.json'), 'utf8');
  await assert.rejects(installCodex({ ...paths, apiKey: replacementKey }), /安全更新/);
  assert.equal(await readFile(keyPath, 'utf8'), original);
  assert.equal(await readFile(paths.configPath, 'utf8'), configBefore);
  assert.equal(await readFile(join(paths.home, 'settings.json'), 'utf8'), providerBefore);
});
