import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual, parseArgs, promisify } from 'node:util';
import { parse } from 'smol-toml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execFileAsync = promisify(execFile);
const requiredTool = 'delegate_to_deepseek';
const reloadHint = 'This checks a new MCP connection, not the running Codex Desktop connection. If dsh is absent there, fully quit and reopen Codex, then start a new chat and inspect its MCP status. No client was restarted.';
const authHint = 'Auth unsupported is normal for a local stdio MCP server; it does not report the worker API key status. No model/API request was made.';
const rootHint = 'Each delegation still needs an absolute project_root and explicit thinking_effort; registration does not choose a workspace.';


async function executablePath(command, env, cwd = process.cwd()) {
  const candidates = isAbsolute(command) || command.includes('/') || command.includes('\\')
    ? [resolve(cwd, command)]
    : (env.PATH || '').split(delimiter).filter(Boolean).map((directory) => resolve(cwd, directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* Try the next PATH entry. */ }
  }
  return null;
}

function pathHint(path) {
  return /(?:^|[/\\])(?:_npx|node_modules)(?:[/\\]|$)/.test(path)
    ? 'The registered package/cache path is stale or incomplete. Rerun dsh-codex-desktop-mcp setup from the current installed version to replace the old cached path.'
    : 'Rerun dsh-codex-desktop-mcp setup from an existing installation to refresh the absolute executable and server script paths.';
}

// Report only diagnostic categories, never arbitrary child output, config values, or prompts.
function startupDetail(error, stderr = '') {
  const text = `${error?.code || ''} ${error?.message || ''}\n${stderr}`;
  const codes = [...new Set(text.match(/\b(?:ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_DLOPEN_FAILED|ERR_UNKNOWN_FILE_EXTENSION|ERR_INVALID_ARG_TYPE|ERR_ACCESS_DENIED|ERR_INVALID_PACKAGE_CONFIG|MODULE_NOT_FOUND|ENOENT|EACCES|ENOTDIR|SyntaxError|ReferenceError|TypeError)\b/g) || [])];
  if (codes.length) return codes.slice(0, 5).join(', ');
  if (/timed?\s*out|timeout|abort/i.test(text)) return 'startup/discovery timed out';
  if (/connection closed|EPIPE/i.test(text)) return 'connection closed during startup/discovery';
  if (/JSON|Unexpected token/i.test(text)) return 'invalid MCP JSON output';
  return 'server startup or MCP protocol error';
}

async function inspectCodexCli(entry, configPath, timeoutMs) {
  const command = await executablePath('codex', getDefaultEnvironment());
  if (!command) return { available: false, ok: null, enabled: null, error: null };
  try {
    const { stdout } = await execFileAsync(command, ['mcp', 'get', 'dsh', '--json'], {
      env: { ...process.env, CODEX_HOME: dirname(configPath) },
      timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    const effective = JSON.parse(stdout);
    const transport = effective.transport;
    const matches = effective.enabled !== false && transport?.type === 'stdio'
      && transport.command === entry.command
      && JSON.stringify(transport.args || []) === JSON.stringify(entry.args || [])
      && (transport.cwd || null) === (entry.cwd || null)
      && isDeepStrictEqual(transport.env || {}, entry.env || {})
      && isDeepStrictEqual(transport.env_vars || [], entry.env_vars || [])
      && !effective.disabled_tools?.includes(requiredTool)
      && (!effective.enabled_tools || effective.enabled_tools.includes(requiredTool));
    return {
      available: true, ok: matches, enabled: effective.enabled !== false,
      error: matches ? null : 'The Codex CLI effective dsh entry is disabled or differs from this stdio registration.',
    };
  } catch (error) {
    return { available: true, ok: false, enabled: null, error: `Codex CLI could not read the effective dsh registration (${startupDetail(error)}).` };
  }
}

export async function inspectRegistration({
  configPath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'),
  timeoutMs = 12000,
  checkCodexCli = true,
} = {}) {
  const result = {
    ok: false, configPath: resolve(configPath), serverVersion: null, tools: [],
    codexCli: null, error: null, hints: [authHint, rootHint],
  };
  let client;
  let transport;
  let stderr = '';
  try {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Provide a positive timeoutMs.');
    let config;
    try {
      config = parse(await readFile(result.configPath, 'utf8'));
    } catch (error) {
      throw new Error(error.code === 'ENOENT'
        ? 'Codex config.toml does not exist. Run dsh-codex-desktop-mcp setup for this CODEX_HOME.'
        : 'Codex config.toml cannot be read or parsed. Check its permissions and TOML syntax.');
    }
    const entry = config.mcp_servers?.dsh;
    if (!entry || typeof entry !== 'object') throw new Error('No mcp_servers.dsh entry exists. Run dsh-codex-desktop-mcp setup for this CODEX_HOME.');
    if (entry.enabled === false) throw new Error('The dsh MCP entry is disabled. Enable mcp_servers.dsh in the selected Codex config.');
    if ((entry.disabled_tools !== undefined && (!Array.isArray(entry.disabled_tools) || entry.disabled_tools.some((name) => typeof name !== 'string')))
      || (entry.enabled_tools !== undefined && (!Array.isArray(entry.enabled_tools) || entry.enabled_tools.some((name) => typeof name !== 'string')))) {
      throw new Error('The dsh MCP enabled_tools and disabled_tools must be arrays of tool names.');
    }
    if (entry.disabled_tools?.includes(requiredTool) || (entry.enabled_tools && !entry.enabled_tools.includes(requiredTool))) {
      throw new Error('Codex tool filters hide delegate_to_deepseek. Remove it from disabled_tools and include it in enabled_tools, if configured.');
    }
    if (typeof entry.command !== 'string' || !entry.command.trim() || entry.url) {
      throw new Error('The dsh MCP entry must use a local stdio command. Rerun dsh-codex-desktop-mcp setup.');
    }
    if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== 'string'))) {
      throw new Error('The dsh MCP command args must be an array of strings. Rerun dsh-codex-desktop-mcp setup.');
    }
    if (entry.env !== undefined && (!entry.env || typeof entry.env !== 'object' || Array.isArray(entry.env)
      || Object.values(entry.env).some((value) => typeof value !== 'string'))) {
      throw new Error('The dsh MCP env entries must be strings. Check the Codex config.');
    }
    if (entry.env_vars !== undefined && (!Array.isArray(entry.env_vars) || entry.env_vars.some((name) => typeof name !== 'string'))) {
      throw new Error('The dsh MCP env_vars must be an array of variable names. Check the Codex config.');
    }
    if (entry.cwd !== undefined && (typeof entry.cwd !== 'string' || !isAbsolute(entry.cwd))) {
      throw new Error('The dsh MCP cwd must be an absolute directory path. Rerun dsh-codex-desktop-mcp setup.');
    }
    const cwd = entry.cwd || process.cwd();
    try {
      if (!(await stat(cwd)).isDirectory()) throw new Error();
    } catch {
      throw new Error('The dsh MCP working directory is missing or inaccessible. Fix cwd or rerun setup.');
    }
    const env = { ...getDefaultEnvironment() };
    for (const name of entry.env_vars || []) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    Object.assign(env, entry.env || {});
    const command = await executablePath(entry.command, env, cwd);
    if (!command) {
      result.hints.push(pathHint(entry.command));
      throw new Error('The registered dsh executable is missing or not executable. Check its absolute path and the client PATH.');
    }
    if (/^node(?:js)?(?:\.exe)?$/.test(basename(command))) {
      const args = entry.args || [];
      if (!args.some((arg) => ['-e', '--eval', '-p', '--print'].includes(arg))) {
        const script = args.find((arg) => !arg.startsWith('-') && /\.[cm]?js$/.test(arg));
        if (script) {
          try {
            const path = resolve(cwd, script);
            await access(path, constants.R_OK);
            if (!(await stat(path)).isFile()) throw new Error();
          } catch {
            result.hints.push(pathHint(script));
            throw new Error('The registered dsh server script is missing or unreadable. Its source checkout or package cache may have moved.');
          }
        }
      }
    }
    if (checkCodexCli) result.codexCli = await inspectCodexCli(entry, result.configPath, timeoutMs);
    client = new Client({ name: 'dsh-mcp-doctor', version: '1' });
    transport = new StdioClientTransport({ command, args: entry.args || [], cwd, env, stderr: 'pipe' });
    transport.stderr.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += chunk.toString().slice(0, 8192 - stderr.length);
    });
    const signal = AbortSignal.timeout(timeoutMs);
    await client.connect(transport, { signal, timeout: timeoutMs });
    const version = client.getServerVersion()?.version;
    result.serverVersion = typeof version === 'string' && /^[\w.+-]{1,100}$/.test(version) ? version : null;
    const names = new Set();
    const cursors = new Set();
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { signal, timeout: timeoutMs });
      for (const tool of page.tools) {
        if (/^[\w.-]{1,128}$/.test(tool.name)) names.add(tool.name);
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('MCP tools/list repeated a pagination cursor.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    result.tools = [...names].sort();
    if (!names.has(requiredTool)) throw new Error('The MCP server initialized but did not expose delegate_to_deepseek. Rerun setup using the current dsh-codex-desktop-mcp package.');
    if (result.codexCli?.ok === false) throw new Error(result.codexCli.error);
    result.ok = true;
    result.hints.push(reloadHint);
    if (result.codexCli?.available === false) result.hints.push('The global codex CLI is not installed or not on PATH. This does not prevent a healthy SDK/Desktop stdio installation.');
  } catch (error) {
    result.error = client
      ? `MCP initialize/tools discovery failed (${startupDetail(error, stderr)}).`
      : error.message;
    if (client && /did not expose|pagination cursor|Codex CLI/.test(error.message)) result.error = error.message;
    result.hints.push('After correcting registration/startup errors, rerun dsh-codex-desktop-mcp doctor. A saved config file alone does not prove Codex loaded the server.');
    if (client) result.hints.push('Check the registered package dependencies and runtime version; if its npm cache was removed, rerun dsh-codex-desktop-mcp setup from the current package.');
  } finally {
    if (transport) await transport.close().catch(() => {});
    if (client) await client.close().catch(() => {});
  }
  return result;
}

export async function runDoctor() {
  const { values } = parseArgs({
    options: {
      home: { type: 'string' }, 'codex-home': { type: 'string' },
      json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log('Usage: dsh-codex-desktop-mcp doctor [--codex-home PATH] [--home PATH] [--json]\n\nCheck the registered stdio command with MCP initialize and tools/list, without an inference request.\nDefaults to $CODEX_HOME/config.toml or ~/.codex/config.toml. --home checks the registered --dsh-home.\nThis does not inspect or restart the running Codex Desktop connection.');
    return;
  }
  const configPath = join(resolve(values['codex-home'] || process.env.CODEX_HOME || join(homedir(), '.codex')), 'config.toml');
  const result = await inspectRegistration({ configPath });
  if (values.home && result.ok) {
    const entry = parse(await readFile(configPath, 'utf8')).mcp_servers.dsh;
    const index = (entry.args || []).indexOf('--dsh-home');
    if (index < 0 || !entry.args[index + 1] || resolve(entry.cwd || process.cwd(), entry.args[index + 1]) !== resolve(values.home)) {
      result.ok = false;
      result.error = 'The registered --dsh-home differs from --home. Rerun setup with the intended --home and --codex-home.';
    }
  }
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Codex config: ${result.configPath}`);
    console.log(`MCP registration: ${result.ok ? 'healthy (initialize + tools/list succeeded)' : 'unhealthy'}`);
    if (result.serverVersion) console.log(`Server version: ${result.serverVersion}`);
    console.log(`Tools: ${result.tools.join(', ') || '(none discovered)'}`);
    if (result.codexCli) console.log(`Codex CLI effective config: ${!result.codexCli.available ? 'not installed (optional)' : result.codexCli.ok ? 'matches' : 'failed'}`);
    if (result.error) console.log(`Error: ${result.error}`);
    for (const hint of result.hints) console.log(`- ${hint}`);
  }
  if (!result.ok) process.exitCode = 1;
  return result;
}
