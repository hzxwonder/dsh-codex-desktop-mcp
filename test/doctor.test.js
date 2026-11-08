import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inspectRegistration } from '../src/doctor.js';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const serverModule = import.meta.resolve('@modelcontextprotocol/sdk/server/index.js');
const transportModule = import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js');
const typesModule = import.meta.resolve('@modelcontextprotocol/sdk/types.js');

async function profile(t) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-doctor-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const codexHome = join(base, 'isolated codex');
  await mkdir(codexHome);
  return { base, codexHome, configPath: join(codexHome, 'config.toml') };
}

async function registration(paths, { command = process.execPath, args = [], enabled = true, env = {}, cwd } = {}) {
  await writeFile(paths.configPath, [
    '[mcp_servers.dsh]', `command = ${JSON.stringify(command)}`,
    `args = ${JSON.stringify(args)}`, `enabled = ${enabled}`,
    ...(cwd ? [`cwd = ${JSON.stringify(cwd)}`] : []),
    '[mcp_servers.dsh.env]',
    ...Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`), '',
  ].join('\n'));
}

async function sdkFixture(paths, { tool = 'delegate_to_deepseek', paginated = false } = {}) {
  const script = join(paths.base, 'actual MCP fixture.mjs');
  const called = join(paths.base, 'unexpected-tool-call');
  await writeFile(script, `
import { writeFile } from 'node:fs/promises';
import { Server } from ${JSON.stringify(serverModule)};
import { StdioServerTransport } from ${JSON.stringify(transportModule)};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(typesModule)};
const server = new Server({ name: 'doctor-isolated-fixture', version: '1.2.3' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  if (${paginated} && !request.params?.cursor) return { tools: [{ name: 'other_tool', inputSchema: { type: 'object' } }], nextCursor: 'second' };
  return { tools: [{ name: ${JSON.stringify(tool)}, inputSchema: { type: 'object' } }] };
});
server.setRequestHandler(CallToolRequestSchema, async () => {
  await writeFile(${JSON.stringify(called)}, 'Doctor must never invoke a tool.');
  throw new Error('Unexpected tools/call');
});
await server.connect(new StdioServerTransport());
`);
  return { script, called };
}

const inspect = (paths, options = {}) => inspectRegistration({ configPath: paths.configPath, checkCodexCli: false, ...options });

test('missing Codex config and missing dsh entry are registration failures', async (t) => {
  const paths = await profile(t);
  const missing = await inspect(paths);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /config.toml does not exist/);
  await writeFile(paths.configPath, '[mcp_servers.other]\ncommand = "keep-me"\n');
  const result = await inspect(paths);
  assert.equal(result.ok, false);
  assert.match(result.error, /No mcp_servers.dsh entry/);
  assert.deepEqual(result.tools, []);
});

test('disabled registration does not launch its executable', async (t) => {
  const paths = await profile(t);
  const script = join(paths.base, 'must-not-run.mjs');
  const marker = join(paths.base, 'started');
  await writeFile(script, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'started');`);
  await registration(paths, { args: [script], enabled: false });
  const result = await inspect(paths);
  assert.equal(result.ok, false);
  assert.match(result.error, /disabled/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('missing and non-executable commands give path guidance', async (t) => {
  const paths = await profile(t);
  const command = join(paths.base, 'missing-node');
  await registration(paths, { command });
  assert.match((await inspect(paths)).error, /executable is missing or not executable/);
  await writeFile(command, '#!/bin/sh\nexit 1\n');
  await chmod(command, 0o600);
  const result = await inspect(paths);
  assert.equal(result.ok, false);
  assert(result.hints.some((hint) => hint.includes('absolute executable')));
});

test('removed npm cache and missing source scripts are identified before startup', async (t) => {
  const paths = await profile(t);
  const cached = join(paths.base, '.npm', '_npx', 'removed', 'node_modules', '@hzxwonder', 'dsh-mcp', 'src', 'server.js');
  await registration(paths, { args: [cached] });
  const stale = await inspect(paths);
  assert.equal(stale.ok, false);
  assert.match(stale.error, /server script is missing/);
  assert(stale.hints.some((hint) => hint.includes('cache path is stale')));
  await registration(paths, { args: [join(paths.base, 'moved-checkout', 'src', 'server.js')] });
  assert.match((await inspect(paths)).error, /source checkout or package cache/);
});

test('missing working directory is distinct from a missing executable', async (t) => {
  const paths = await profile(t);
  await registration(paths, { cwd: join(paths.base, 'removed-workspace') });
  const result = await inspect(paths);
  assert.equal(result.ok, false);
  assert.match(result.error, /working directory is missing/);
});

test('broken startup reports a diagnostic category without child logs or environment values', async (t) => {
  const paths = await profile(t);
  const script = join(paths.base, 'broken.mjs');
  const secret = 'sk-doctor-secret-must-stay-private';
  const privateEnv = 'private-non-key-environment-value';
  const prompt = 'private prompt text must not be returned';
  await writeFile(script, `console.error('Error: ERR_MODULE_NOT_FOUND', process.env.PRIVATE_KEY, process.env.PRIVATE_VALUE, ${JSON.stringify(prompt)}); process.exit(1);`);
  await registration(paths, { args: [script], env: { PRIVATE_KEY: secret, PRIVATE_VALUE: privateEnv } });
  const result = await inspect(paths);
  assert.equal(result.ok, false);
  assert.match(result.error, /ERR_MODULE_NOT_FOUND/);
  const json = JSON.stringify(result);
  for (const value of [secret, privateEnv, prompt]) assert(!json.includes(value));
  assert(result.hints.some((hint) => hint.includes('package dependencies')));
});

test('a live process without an MCP handshake times out and is closed', async (t) => {
  const paths = await profile(t);
  const script = join(paths.base, 'hung.mjs');
  await writeFile(script, 'process.stdin.resume(); setInterval(() => {}, 1000);\n');
  await registration(paths, { args: [script] });
  const result = await inspect(paths, { timeoutMs: 250 });
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/);
});

test('actual SDK initialize and tools/list succeed without invoking a model or tool', async (t) => {
  const paths = await profile(t);
  const { script, called } = await sdkFixture(paths);
  await registration(paths, { args: [script], env: { DEEPSEEK_API_KEY: 'deliberately-not-a-working-credential' } });
  const before = await readFile(paths.configPath, 'utf8');
  const result = await inspect(paths);
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.equal(result.serverVersion, '1.2.3');
  assert.deepEqual(result.tools, ['delegate_to_deepseek']);
  assert.equal(result.codexCli, null);
  assert(result.hints.some((hint) => hint.includes('not the running Codex Desktop connection')));
  assert(result.hints.some((hint) => hint.includes('Auth unsupported is normal')));
  assert.equal(await readFile(paths.configPath, 'utf8'), before);
  await assert.rejects(readFile(called), { code: 'ENOENT' });
});

test('tools discovery follows real MCP pagination', async (t) => {
  const paths = await profile(t);
  const { script } = await sdkFixture(paths, { paginated: true });
  await registration(paths, { args: [script] });
  const result = await inspect(paths);
  assert.equal(result.ok, true);
  assert.deepEqual(result.tools, ['delegate_to_deepseek', 'other_tool']);
});

test('a healthy unrelated MCP server does not count as dsh', async (t) => {
  const paths = await profile(t);
  const { script } = await sdkFixture(paths, { tool: 'unrelated_tool' });
  await registration(paths, { args: [script] });
  const result = await inspect(paths);
  assert.equal(result.ok, false);
  assert.equal(result.serverVersion, '1.2.3');
  assert.match(result.error, /did not expose delegate_to_deepseek/);
  assert.deepEqual(result.tools, ['unrelated_tool']);
});

async function doctorProcess(paths, args = []) {
  return execFileAsync(process.execPath, [cliPath, 'doctor', ...args],
    { cwd: paths.base, env: { HOME: paths.base, CODEX_HOME: paths.codexHome, PATH: '' }, timeout: 15000 });
}

test('doctor JSON follows CODEX_HOME and treats absent global CLI as optional', async (t) => {
  const paths = await profile(t);
  const { script } = await sdkFixture(paths);
  await registration(paths, { args: [script] });
  const { stdout, stderr } = await doctorProcess(paths, ['--json']);
  const result = JSON.parse(stdout);
  assert.equal(stderr, '');
  assert.equal(result.ok, true);
  assert.equal(result.configPath, paths.configPath);
  assert.deepEqual(result.codexCli, { available: false, ok: null, enabled: null, error: null });
});

test('doctor supports an explicit Codex home and explains its non-UI health scope', async (t) => {
  const paths = await profile(t);
  const { script } = await sdkFixture(paths);
  await registration(paths, { args: [script] });
  const { stdout } = await doctorProcess(paths, ['--codex-home', paths.codexHome]);
  assert(stdout.includes(paths.configPath));
  assert.match(stdout, /initialize \+ tools\/list succeeded/);
  assert.match(stdout, /delegate_to_deepseek/);
  assert.match(stdout, /fully quit and reopen Codex/);
  assert.match(stdout, /project_root/);
  assert.match(stdout, /does not report the worker API key status/);
});

test('doctor exits unsuccessfully for a different registered DSH home', async (t) => {
  const paths = await profile(t);
  const { script } = await sdkFixture(paths);
  await registration(paths, { args: [script, '--dsh-home', join(paths.base, 'registered-home')] });
  await assert.rejects(doctorProcess(paths, ['--home', join(paths.base, 'different-home'), '--json']), (error) => {
    assert.equal(error.code, 1);
    const result = JSON.parse(error.stdout);
    assert.equal(result.ok, false);
    assert.match(result.error, /registered --dsh-home differs/);
    return true;
  });
});

test('doctor help does not require a configuration or start a server', async (t) => {
  const paths = await profile(t);
  const { stdout } = await doctorProcess(paths, ['--help']);
  assert.match(stdout, /Usage: dsh-codex-desktop-mcp doctor/);
  assert.match(stdout, /does not inspect or restart/);
});

test('Codex tool filters cannot silently hide the required delegation tool', async (t) => {
  const paths = await profile(t);
  const { script } = await sdkFixture(paths);
  for (const filter of ['disabled_tools = ["delegate_to_deepseek"]', 'enabled_tools = ["other_tool"]']) {
    await writeFile(paths.configPath, `[mcp_servers.dsh]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([script])}\n${filter}\n`);
    const result = await inspect(paths);
    assert.equal(result.ok, false);
    assert.match(result.error, /tool filters hide delegate_to_deepseek/);
  }
});

test('invalid TOML is reported without returning the private source excerpt', async (t) => {
  const paths = await profile(t);
  const secret = 'sk-private-config-parser-excerpt';
  await writeFile(paths.configPath, `[mcp_servers.dsh]\ncommand = "${secret}\n`);
  const result = await inspect(paths);
  assert.equal(result.ok, false);
  assert.match(result.error, /TOML syntax/);
  assert(!JSON.stringify(result).includes(secret));
});

