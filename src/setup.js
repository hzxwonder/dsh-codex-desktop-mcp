import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rm, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs, parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { parse } from 'smol-toml';
import { parseProviderSettings, resolveProviderSettings } from './provider.js';
import { runTerminalSetup } from './setup-terminal.js';
import { inspectRegistration } from './doctor.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const defaultHome = join(homedir(), '.dsh-mcp');

async function inspect(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function readExisting(path) {
  const info = await inspect(path);
  if (!info) return { text: '', mode: null };
  if (!info.isFile()) throw new Error(`Expected a regular file, not a symlink or directory: ${path}`);
  return { text: await readFile(path, 'utf8'), mode: info.mode & 0o777 };
}

async function checkDirectory(path) {
  const info = await inspect(path);
  if (info && !info.isDirectory()) throw new Error(`Expected a directory, not a symlink or file: ${path}`);
}

function managedBlock(text, begin, end, body) {
  const marker = (value) => [...text.matchAll(new RegExp(`^${value}\\r?$`, 'gm'))];
  const starts = marker(begin);
  const ends = marker(end);
  if (starts.length !== ends.length || starts.length > 1 || (starts[0] && starts[0].index >= ends[0].index)) {
    throw new Error(`Repair the incomplete or duplicate managed block: ${begin}`);
  }
  const block = `${begin}\n${body.trimEnd()}\n${end}\n`;
  if (!starts.length) {
    return { text: text + (text && !text.endsWith('\n') ? '\n' : '') + (text ? '\n' : '') + block, previous: null };
  }
  const previous = text.slice(starts[0].index + starts[0][0].length, ends[0].index);
  let after = ends[0].index + ends[0][0].length;
  if (text[after] === '\n') after++;
  return { text: text.slice(0, starts[0].index) + block + text.slice(after), previous };
}

function parseConfig(text) {
  try { return parse(text); }
  catch { throw new Error('Codex config.toml is not valid TOML. Repair this file before setup.'); }
}

function updateCredential(text, requestedKey) {
  const before = parseEnv(text);
  const key = (requestedKey ?? before.DEEPSEEK_API_KEY)?.trim();
  if (!key || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(key)) {
    throw new Error('API Key 必须是非空的单行文本。');
  }
  if (before.DEEPSEEK_API_KEY === key) return text;
  if (/[\r\n]/.test(before.DEEPSEEK_API_KEY ?? '')) {
    throw new Error('旧凭据格式无法安全更新。请先备份私有 .env 文件，现有内容未改变。');
  }
  let replaced = false;
  let next = text.replace(/^[\uFEFF \t]*(?:export[ \t]+)?DEEPSEEK_API_KEY[ \t]*=.*(?:\r?\n|$)/gm, () => {
    if (replaced) return '';
    replaced = true;
    return `DEEPSEEK_API_KEY=${JSON.stringify(key)}\n`;
  });
  if (!replaced) next += `${next && !next.endsWith('\n') ? '\n' : ''}DEEPSEEK_API_KEY=${JSON.stringify(key)}\n`;
  if (!isDeepStrictEqual({ ...parseEnv(next) }, { ...before, DEEPSEEK_API_KEY: key })) {
    throw new Error('无法在保留其他凭据配置的同时安全更新 API Key，现有内容未改变。');
  }
  return next;
}

async function matchesPreviousBundledSkill(server, skillText) {
  const script = server?.args?.[0];
  if (typeof script !== 'string' || !isAbsolute(script)) return false;
  const previousRoot = dirname(dirname(script));
  if (script !== join(previousRoot, 'src', 'server.js')) return false;
  try {
    const [currentPackage, previousPackage, previousSkill, scriptInfo] = await Promise.all([
      readExisting(join(packageRoot, 'package.json')),
      readExisting(join(previousRoot, 'package.json')),
      readExisting(join(previousRoot, '.agents', 'skills', 'deepseek-worker', 'SKILL.md')),
      inspect(script),
    ]);
    const name = JSON.parse(currentPackage.text).name;
    const previousName = JSON.parse(previousPackage.text).name;
    const compatible = previousName === name || (name === '@hzxwonder/dsh-codex-desktop-mcp'
      && previousName === '@hzxwonder/dsh-mcp');
    return typeof name === 'string' && name.length > 0
      && compatible
      && scriptInfo?.isFile() === true
      && previousSkill.mode !== null && previousSkill.text === skillText;
  } catch {
    return false;
  }
}

async function atomicWrite(path, text, mode) {
  const temp = join(dirname(path), `.dsh-mcp-${randomUUID()}.tmp`);
  try {
    const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    try { await file.writeFile(text, 'utf8'); }
    finally { await file.close(); }
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

export async function installCodex({
  home = defaultHome,
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
  skillsHome,
  legacySkillsHome = join(homedir(), '.agents', 'skills'),
  apiKey, baseUrl, protocol, model,
}) {
  if (process.platform === 'win32') throw new Error('Setup requires macOS or Linux.');
  home = resolve(home);
  codexHome = resolve(codexHome);
  const migrateSharedSkill = skillsHome === undefined;
  skillsHome = resolve(skillsHome ?? join(codexHome, 'skills'));
  legacySkillsHome = resolve(legacySkillsHome);
  const legacyDirectory = join(legacySkillsHome, 'deepseek-worker');
  const legacyPath = join(legacyDirectory, 'SKILL.md');
  const migrateLegacy = migrateSharedSkill && legacySkillsHome !== skillsHome;
  const configPath = join(codexHome, 'config.toml');
  const agentsPath = join(codexHome, 'AGENTS.md');
  const skillDirectory = join(skillsHome, 'deepseek-worker');
  const skillPath = join(skillDirectory, 'SKILL.md');
  const keyPath = join(home, '.env');
  const providerPath = join(home, 'settings.json');
  const directories = [codexHome, dirname(skillsHome), skillsHome, skillDirectory, home];
  for (const directory of directories) await checkDirectory(directory);
  if (migrateLegacy) {
    for (const directory of [dirname(legacySkillsHome), legacySkillsHome, legacyDirectory]) await checkDirectory(directory);
  }
  const [config, skill, credentials, provider, bundledSkill, agents, routing] = await Promise.all([
    readExisting(configPath), readExisting(skillPath), readExisting(keyPath), readExisting(providerPath),
    readFile(join(packageRoot, '.agents', 'skills', 'deepseek-worker', 'SKILL.md'), 'utf8'),
    readExisting(agentsPath), readFile(join(packageRoot, 'config', 'agents.md'), 'utf8'),
  ]);
  const parsed = parseConfig(config.text);
  const args = [join(packageRoot, 'src', 'server.js'), '--dsh-home', home];
  const entry = [
    '[mcp_servers.dsh]', `command = ${JSON.stringify(process.execPath)}`, `args = ${JSON.stringify(args)}`,
    'enabled = true',
    'startup_timeout_sec = 20', 'tool_timeout_sec = 960',
  ].join('\n');
  const { text: nextConfig, previous } = managedBlock(config.text, '# BEGIN dsh-mcp', '# END dsh-mcp', entry);
  const previousServer = previous === null ? undefined : parseConfig(previous).mcp_servers?.dsh;
  const ownsServer = parsed.mcp_servers?.dsh && previousServer
    && isDeepStrictEqual(parsed.mcp_servers.dsh, previousServer);
  const legacy = migrateLegacy ? await readExisting(legacyPath) : { text: '', mode: null };
  if (parsed.mcp_servers?.dsh && !ownsServer) {
    throw new Error('Codex already defines mcp_servers.dsh outside this installer’s managed block. Preserve or rename that server before setup.');
  }
  if (skill.mode !== null && skill.text !== bundledSkill
    && !(ownsServer && await matchesPreviousBundledSkill(previousServer, skill.text))) {
    throw new Error('A different deepseek-worker skill already exists and cannot be safely upgraded. Back up or rename that skill before setup; existing files were not changed.');
  }
  if (legacy.mode !== null && !(ownsServer && (legacy.text === bundledSkill
    || await matchesPreviousBundledSkill(previousServer, legacy.text)))) {
    throw new Error('The shared deepseek-worker skill cannot be safely migrated. Back up or rename that skill before setup; existing files were not changed.');
  }
  parseConfig(nextConfig);
  const { text: nextAgents } = managedBlock(agents.text, '<!-- BEGIN dsh-mcp -->', '<!-- END dsh-mcp -->', routing);
  const providerSettings = parseProviderSettings(provider.text);
  const previousProvider = resolveProviderSettings(providerSettings, { legacy: !providerSettings.protocol && typeof providerSettings.baseUrl === 'string' });
  const selected = resolveProviderSettings({
    ...previousProvider,
    ...(protocol === undefined ? {} : { protocol }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(model === undefined ? {} : { model }),
  });
  const nextProvider = JSON.stringify({ ...providerSettings, ...selected }, null, 2) + '\n';
  const nextCredentials = updateCredential(credentials.text, apiKey);

  // Check all user-file conflicts before creating credentials or Codex files.
  for (const directory of directories) await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  if (nextCredentials !== credentials.text) await atomicWrite(keyPath, nextCredentials, 0o600);
  else await chmod(keyPath, 0o600);
  if (nextProvider !== provider.text) await atomicWrite(providerPath, nextProvider, 0o600);
  else await chmod(providerPath, 0o600);
  if (nextConfig !== config.text) await atomicWrite(configPath, nextConfig, config.mode ?? 0o644);
  if (skill.text !== bundledSkill || skill.mode === null) await atomicWrite(skillPath, bundledSkill, skill.mode ?? legacy.mode ?? 0o644);
  if (nextAgents !== agents.text) await atomicWrite(agentsPath, nextAgents, agents.mode ?? 0o644);
  if (legacy.mode !== null) {
    await rm(legacyPath);
    try { await rmdir(legacyDirectory); }
    catch (error) { if (error.code !== 'ENOTEMPTY') throw error; }
  }
  return { home, configPath, skillPath, agentsPath };
}

export async function runSetup() {
  const { values } = parseArgs({ options: {
    home: { type: 'string', default: defaultHome },
    help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('用法: dsh-codex-desktop-mcp setup [--home /private/dsh-home]');
    console.log('纯终端配置：协议 → Base URL → API Key → 探测并选择模型。');
    console.log('再次运行可逐项修改现有配置；连接测试通过后才保存并注册 MCP。');
    console.log('诊断 Codex 注册和工具握手: dsh-codex-desktop-mcp doctor');
    return;
  }
  if (!process.stdin.isTTY) throw new Error('配置向导需要交互式终端。请在终端运行 dsh-codex-desktop-mcp setup。');
  const home = resolve(values.home);
  await checkDirectory(home);
  const credentials = await readExisting(join(home, '.env'));
  const saved = await readExisting(join(home, 'settings.json'));
  const rawSettings = parseProviderSettings(saved.text);
  const existing = saved.mode !== null || Boolean(parseEnv(credentials.text).DEEPSEEK_API_KEY);
  const initial = existing ? rawSettings : {
    ...(process.env.DSH_MCP_PROTOCOL ? { protocol: process.env.DSH_MCP_PROTOCOL } : {}),
    ...(process.env.DEEPSEEK_BASE_URL ? { baseUrl: process.env.DEEPSEEK_BASE_URL } : {}),
    ...(process.env.DSH_MCP_MODEL ? { model: process.env.DSH_MCP_MODEL } : {}),
  };
  const settings = resolveProviderSettings(initial, { legacy: existing && !rawSettings.protocol && typeof rawSettings.baseUrl === 'string' });
  const apiKey = parseEnv(credentials.text).DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY || '';
  const chosen = await runTerminalSetup({ settings, apiKey, existing });
  const result = await installCodex({ home, ...chosen.settings, apiKey: chosen.apiKey });
  console.log(`Codex 配置: ${result.configPath}`);
  console.log(`用户 skill: ${result.skillPath}`);
  console.log(`全局委派规则: ${result.agentsPath}`);
  console.log(`私有 API Key 文件: ${join(result.home, '.env')}`);
  console.log(`私有服务配置: ${join(result.home, 'settings.json')}`);
  console.log('正在检查 MCP 注册和工具握手...');
  const health = await inspectRegistration({ configPath: result.configPath });
  if (!health.ok) {
    console.error('API 连接通过，配置也已保存，但 MCP 加载检查失败。');
    for (const hint of health.hints ?? []) console.error(hint);
    if (health.error) console.error(health.error);
    throw new Error('请运行 dsh-codex-desktop-mcp doctor 查看注册路径和启动状态；不能据此认为 Codex 已显示该工具。');
  }
  console.log(`MCP 握手成功，工具: ${health.tools.join(', ')}`);
  console.log('如果已打开的 Codex 仍未显示，请完整退出并重新打开 Codex Desktop，而不只是新开标签。');
  console.log('确认 Codex 与安装器使用同一主机、用户和 CODEX_HOME。Auth unsupported 对本地 stdio 是正常状态。');
}


if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runSetup().catch((error) => { console.error(`Setup failed: ${error.message}`); process.exitCode = 1; });
}
