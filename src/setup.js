import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { parse } from 'smol-toml';

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
  if (!starts.length) return text + (text && !text.endsWith('\n') ? '\n' : '') + (text ? '\n' : '') + block;
  let after = ends[0].index + ends[0][0].length;
  if (text[after] === '\n') after++;
  return text.slice(0, starts[0].index) + block + text.slice(after);
}

function parseConfig(text) {
  try { return parse(text); }
  catch { throw new Error('Project .codex/config.toml is not valid TOML. Repair this file before setup.'); }
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

export async function installProject({ workspaceRoot, home = defaultHome, apiKey }) {
  if (process.platform === 'win32') throw new Error('Setup requires macOS or Linux.');
  const root = await realpath(workspaceRoot);
  if (!(await lstat(root)).isDirectory()) throw new Error('The project path must be a directory.');
  home = resolve(home);
  const configPath = join(root, '.codex', 'config.toml');
  const skillDirectory = join(root, '.agents', 'skills', 'deepseek-worker');
  const skillPath = join(skillDirectory, 'SKILL.md');
  const agentsPath = join(root, 'AGENTS.md');
  const keyPath = join(home, '.env');
  const directories = [join(root, '.codex'), join(root, '.agents'), join(root, '.agents', 'skills'), skillDirectory, home];
  for (const directory of directories) await checkDirectory(directory);
  const [config, agents, skill, credentials, bundledSkill, routing] = await Promise.all([
    readExisting(configPath), readExisting(agentsPath), readExisting(skillPath), readExisting(keyPath),
    readFile(join(packageRoot, '.agents', 'skills', 'deepseek-worker', 'SKILL.md'), 'utf8'),
    readFile(join(packageRoot, 'config', 'routing.md'), 'utf8'),
  ]);
  const parsed = parseConfig(config.text);
  if (parsed.mcp_servers?.dsh && !/^# BEGIN dsh-mcp\r?$/m.test(config.text)) {
    throw new Error('This project already defines mcp_servers.dsh. Preserve or rename that server before setup.');
  }
  if (skill.mode !== null && skill.text !== bundledSkill) {
    throw new Error('This project has a different deepseek-worker skill. Preserve or rename that skill before setup.');
  }
  const command = JSON.stringify(process.execPath);
  const args = [join(packageRoot, 'src', 'server.js'), '--workspace-root', root, '--dsh-home', home];
  const entry = [
    '[mcp_servers.dsh]', `command = ${command}`, `args = ${JSON.stringify(args)}`,
    'startup_timeout_sec = 20', 'tool_timeout_sec = 960',
  ].join('\n');
  const nextConfig = managedBlock(config.text, '# BEGIN dsh-mcp', '# END dsh-mcp', entry);
  parseConfig(nextConfig);
  const nextAgents = managedBlock(agents.text, '<!-- BEGIN dsh-mcp -->', '<!-- END dsh-mcp -->', routing);
  const existingKey = parseEnv(credentials.text).DEEPSEEK_API_KEY;
  let nextCredentials = credentials.text;
  if (!existingKey) {
    const key = apiKey?.trim();
    if (!key || /[\r\n\0]/.test(key)) throw new Error('Provide one nonempty DeepSeek API key without line breaks.');
    nextCredentials += `${nextCredentials && !nextCredentials.endsWith('\n') ? '\n' : ''}DEEPSEEK_API_KEY=${JSON.stringify(key)}\n`;
    if (parseEnv(nextCredentials).DEEPSEEK_API_KEY !== key) throw new Error('The API key cannot be stored as a dotenv value.');
  }

  // Check all user-file conflicts before creating credentials or project files.
  for (const directory of directories) await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  if (nextCredentials !== credentials.text) await atomicWrite(keyPath, nextCredentials, 0o600);
  else await chmod(keyPath, 0o600);
  if (nextConfig !== config.text) await atomicWrite(configPath, nextConfig, config.mode ?? 0o644);
  if (nextAgents !== agents.text) await atomicWrite(agentsPath, nextAgents, agents.mode ?? 0o644);
  if (skill.mode === null) await atomicWrite(skillPath, bundledSkill, 0o644);
  return { workspaceRoot: root, home, configPath, skillPath, agentsPath };
}

function question(prompt, hidden = false) {
  if (!process.stdin.isTTY) throw new Error('Use a terminal for prompts, or supply a project path and DEEPSEEK_API_KEY in the environment.');
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

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    home: { type: 'string', default: defaultHome }, help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('Usage: npm run setup -- /absolute/project [--home /private/dsh-home]');
    console.log('Setup installs project MCP settings, a skill, and automatic delegation rules.');
    console.log('Setup stores the API key outside the project and does not change global Codex settings.');
    return;
  }
  if (positionals.length > 1) throw new Error('Provide exactly one project path.');
  const workspaceRoot = positionals[0] || (await question('Project directory: ')).trim();
  if (!workspaceRoot) throw new Error('A project path is required.');
  const home = resolve(values.home);
  await checkDirectory(home);
  const credentials = await readExisting(join(home, '.env'));
  let apiKey = process.env.DEEPSEEK_API_KEY;
  if (!parseEnv(credentials.text).DEEPSEEK_API_KEY && !apiKey) {
    apiKey = await question('DeepSeek API key (hidden): ', true);
  }
  const result = await installProject({ workspaceRoot, home, apiKey });
  console.log(`Project: ${result.workspaceRoot}`);
  console.log(`MCP configuration: ${result.configPath}`);
  console.log(`Skill: ${result.skillPath}`);
  console.log(`Delegation rules: ${result.agentsPath}`);
  console.log(`Private API key file: ${join(result.home, '.env')}`);
  console.log('Trust this project in Codex. Start a new Codex session in this project.');
  console.log('Use normal task prompts. Codex can select eligible DeepSeek tasks without an explicit tool request.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`Setup failed: ${error.message}`); process.exitCode = 1; });
}
