import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs, parseEnv } from 'node:util';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { parse } from 'smol-toml';
import { DEFAULT_BASE_URL, normalizeBaseUrl, parseProviderSettings } from './provider.js';
import { createSetupForm, openSetupBrowser } from './setup-ui.js';

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
    return typeof name === 'string' && name.length > 0
      && JSON.parse(previousPackage.text).name === name
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
  skillsHome = join(homedir(), '.agents', 'skills'),
  apiKey, baseUrl,
}) {
  if (process.platform === 'win32') throw new Error('Setup requires macOS or Linux.');
  home = resolve(home);
  codexHome = resolve(codexHome);
  skillsHome = resolve(skillsHome);
  const configPath = join(codexHome, 'config.toml');
  const skillDirectory = join(skillsHome, 'deepseek-worker');
  const skillPath = join(skillDirectory, 'SKILL.md');
  const keyPath = join(home, '.env');
  const providerPath = join(home, 'settings.json');
  const directories = [codexHome, dirname(skillsHome), skillsHome, skillDirectory, home];
  for (const directory of directories) await checkDirectory(directory);
  const [config, skill, credentials, provider, bundledSkill] = await Promise.all([
    readExisting(configPath), readExisting(skillPath), readExisting(keyPath), readExisting(providerPath),
    readFile(join(packageRoot, '.agents', 'skills', 'deepseek-worker', 'SKILL.md'), 'utf8'),
  ]);
  const parsed = parseConfig(config.text);
  const args = [join(packageRoot, 'src', 'server.js'), '--dsh-home', home];
  const entry = [
    '[mcp_servers.dsh]', `command = ${JSON.stringify(process.execPath)}`, `args = ${JSON.stringify(args)}`,
    'startup_timeout_sec = 20', 'tool_timeout_sec = 960',
  ].join('\n');
  const { text: nextConfig, previous } = managedBlock(config.text, '# BEGIN dsh-mcp', '# END dsh-mcp', entry);
  const previousServer = previous === null ? undefined : parseConfig(previous).mcp_servers?.dsh;
  const ownsServer = parsed.mcp_servers?.dsh && previousServer
    && isDeepStrictEqual(parsed.mcp_servers.dsh, previousServer);
  if (parsed.mcp_servers?.dsh && !ownsServer) {
    throw new Error('Codex already defines mcp_servers.dsh outside this installer’s managed block. Preserve or rename that server before setup.');
  }
  if (skill.mode !== null && skill.text !== bundledSkill
    && !(ownsServer && await matchesPreviousBundledSkill(previousServer, skill.text))) {
    throw new Error('A different deepseek-worker skill already exists and cannot be safely upgraded. Back up or rename that skill before setup; existing files were not changed.');
  }
  parseConfig(nextConfig);
  const existingKey = parseEnv(credentials.text).DEEPSEEK_API_KEY;
  const providerSettings = parseProviderSettings(provider.text);
  const providerUrl = normalizeBaseUrl(baseUrl ?? providerSettings.baseUrl ?? DEFAULT_BASE_URL);
  const nextProvider = JSON.stringify({ ...providerSettings, baseUrl: providerUrl }, null, 2) + '\n';
  let nextCredentials = credentials.text;
  if (!existingKey) {
    const key = apiKey?.trim();
    if (!key || /[\r\n\0]/.test(key)) throw new Error('Provide one nonempty DeepSeek API key without line breaks.');
    nextCredentials += `${nextCredentials && !nextCredentials.endsWith('\n') ? '\n' : ''}DEEPSEEK_API_KEY=${JSON.stringify(key)}\n`;
    if (parseEnv(nextCredentials).DEEPSEEK_API_KEY !== key) throw new Error('The API key cannot be stored as a dotenv value.');
  }

  // Check all user-file conflicts before creating credentials or Codex files.
  for (const directory of directories) await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  if (nextCredentials !== credentials.text) await atomicWrite(keyPath, nextCredentials, 0o600);
  else await chmod(keyPath, 0o600);
  if (nextProvider !== provider.text) await atomicWrite(providerPath, nextProvider, 0o600);
  else await chmod(providerPath, 0o600);
  if (nextConfig !== config.text) await atomicWrite(configPath, nextConfig, config.mode ?? 0o644);
  if (skill.text !== bundledSkill || skill.mode === null) await atomicWrite(skillPath, bundledSkill, skill.mode ?? 0o644);
  return { home, configPath, skillPath };
}

function question(prompt, hidden = false) {
  if (!process.stdin.isTTY) throw new Error('Use a terminal for prompts, or supply DEEPSEEK_API_KEY in the environment.');
  const output = hidden ? new Writable({ write(_chunk, _encoding, callback) { callback(); } }) : process.stdout;
  const input = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  if (hidden) process.stdout.write(prompt);
  return new Promise((accept, reject) => {
    input.once('SIGINT', () => { input.close(); reject(new Error('Setup cancelled.')); });
    input.once('close', () => reject(new Error('Setup input closed.')));
    input.question(hidden ? '' : prompt, (answer) => {
      accept(answer);
      input.close();
      if (hidden) process.stdout.write('\n');
    });
  });
}

export async function runSetup() {
  const { values } = parseArgs({ options: {
    home: { type: 'string', default: defaultHome },
    terminal: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('Usage: dsh-mcp setup [--home /private/dsh-home] [--terminal]');
    console.log('Setup opens a local form for API Key and Base URL.');
    console.log('Use --terminal for terminal prompts. Secrets never enter command arguments.');
    console.log('Setup installs user-wide Codex MCP settings and a skill. Codex supplies each project path at call time.');
    return;
  }
  const home = resolve(values.home);
  await checkDirectory(home);
  const credentials = await readExisting(join(home, '.env'));
  const provider = parseProviderSettings((await readExisting(join(home, 'settings.json'))).text);
  const stored = parseEnv(credentials.text);
  let apiKey = process.env.DEEPSEEK_API_KEY;
  let baseUrl = process.env.DEEPSEEK_BASE_URL ?? provider.baseUrl ?? DEFAULT_BASE_URL;
  let result;
  if (values.terminal) {
    if (!stored.DEEPSEEK_API_KEY && !apiKey) apiKey = await question('DeepSeek API key (hidden): ', true);
    if (process.stdin.isTTY && !process.env.DEEPSEEK_BASE_URL) {
      baseUrl = (await question(`Base URL [${baseUrl}]: `)).trim() || baseUrl;
    }
    result = await installCodex({ home, apiKey, baseUrl });
  } else {
    const form = await createSetupForm({
      baseUrl, hasSavedKey: Boolean(stored.DEEPSEEK_API_KEY || apiKey),
      onSubmit: (input) => installCodex({ home, apiKey: apiKey || input.apiKey, baseUrl: input.baseUrl }),
    });
    const cancel = () => form.close();
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      console.log(`Setup form: ${form.url}`);
      if (!await openSetupBrowser(form.url)) console.log('Open the local URL in your browser to continue.');
      result = await form.completed;
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
  }
  console.log(`MCP configuration: ${result.configPath}`);
  console.log(`Skill: ${result.skillPath}`);
  console.log(`Private API key file: ${join(result.home, '.env')}`);
  console.log(`Private provider settings: ${join(result.home, 'settings.json')}`);
  console.log('Start a new Codex session. Codex supplies the active project_root with every delegated task.');
  console.log('Use normal task prompts. Codex can select eligible DeepSeek tasks without an explicit tool request.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runSetup().catch((error) => { console.error(`Setup failed: ${error.message}`); process.exitCode = 1; });
}
