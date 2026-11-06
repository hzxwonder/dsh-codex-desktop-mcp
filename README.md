# dsh-mcp

[dsh-mcp](https://github.com/hzxwonder/dsh-mcp) lets Codex delegate bounded tasks through MCP to DeepSeek Harness (DSH).
DSH uses `deepseek-official` and `deepseek-flash`.
Codex keeps its current GPT model, provider, and account.
The main Codex agent reviews the result and owns task acceptance.

This project uses the official DSH `headless --json` interface.
It does not use a third-party bridge or private DSH web interfaces.
DSH remains a developer preview.
This release pins DSH `0.2.2-rc.1`, the npm `latest` version checked on 2026-11-06.

## Requirements

- macOS or Linux.
- Node.js 24.9.0 or later.
- npm.
- Codex with MCP support.
- A separate DeepSeek API key.
- Git for the source installation route.

Create an API key at the [DeepSeek API platform](https://platform.deepseek.com/api_keys).
DeepSeek API usage has separate billing.
Your ChatGPT account and DSH GUI login do not replace the API key.

npm installs the pinned DSH version automatically as a local dependency.
An npx installation can store that dependency in the npm cache.
You do not need a global npm installation of DSH or Codex.
You do not need a DSH desktop installation or local model weights.

Dependencies require substantial disk space.
The development `node_modules` directory measured about 922 MB.
Installed size varies with the platform, npm cache, and dependency layout.
This measurement is not a universal size requirement.

## Install once for Codex

Setup installs the MCP server and user skill globally for Codex.
Switch projects without running setup again.
Codex supplies the authorized absolute `project_root` in every tool call.
Installation does not select or permanently bind a project.

### npm route: pending publication

**The npm package and MCP Registry entry are not published.**
This source prepares package version `0.3.0`.
Use the source route below now.
Use this command only after publication:

```sh
npx --yes --package @hzxwonder/dsh-mcp@0.3.0 dsh-mcp setup
```

Setup opens a local browser form with these fields:

| Field | Environment variable | Meaning |
| --- | --- | --- |
| API Key | `DEEPSEEK_API_KEY` | Required secret. The form uses a password field. |
| Base URL | `DEEPSEEK_BASE_URL` | Optional. Default: `https://api.deepseek.com/anthropic`. |

The form uses a temporary, token-protected server on `127.0.0.1`.
It is not a public website or remote MCP server.
For terminal prompts instead, use:

```sh
npx --yes --package @hzxwonder/dsh-mcp@0.3.0 dsh-mcp setup --terminal
```

The terminal fallback hides the API key.
It also prompts for the Base URL.
Never put an API key in command arguments, URLs, task text, or project configuration.
Setup keeps an existing private key unchanged.
To replace that key, edit the private `.env` file.

DSH uses the Messages protocol at `/v1/messages`.
A custom Base URL must support that protocol.
The OpenAI API base URL and chat-completions-only endpoints are not compatible.
A custom provider receives your API key and task data.
Use only a provider that you trust.

### Source route: available now

1. Clone the public repository.

   ```sh
   git clone https://github.com/hzxwonder/dsh-mcp.git
   ```

2. Enter the installation directory.

   ```sh
   cd dsh-mcp
   ```

3. Install the pinned dependencies.

   ```sh
   npm ci
   ```

4. Configure Codex once.

   ```sh
   npm run setup
   ```

5. Enter the provider settings in the local browser form.
6. Open your project in Codex.
7. Trust the project only if you trust its code and configuration.
8. Start a new Codex session.
9. Check that Codex lists `delegate_to_deepseek`.

Codex may add a server prefix to the tool name.
Setup does not require manual TOML edits or a project path.
Use `npm run setup -- --help` for CLI help.
Append `--terminal` for terminal prompts.
Use this command for a different private home:

```sh
npm run setup -- --home /absolute/path/to/private/dsh-home
```

### Generated files

Setup uses `~/.dsh-mcp` as the default private home.

| Path | Purpose |
| --- | --- |
| `~/.dsh-mcp/.env` | Stores the API key outside projects. |
| `~/.dsh-mcp/settings.json` | Stores the Base URL outside projects. |
| `~/.codex/config.toml` | Registers the user-global `[mcp_servers.dsh]` server. |
| `~/.agents/skills/deepseek-worker/SKILL.md` | Supplies the user skill for delegation. |

If you set `CODEX_HOME`, setup uses `$CODEX_HOME/config.toml` instead.
A custom `--home` changes the private-home path.
Setup sets the private directory mode to `0700` and both settings files to `0600`.
The MCP configuration contains absolute Node, package server, and private-home paths.
It sets `startup_timeout_sec = 20` and `tool_timeout_sec = 960`.
It contains no API key or project root.

DSH rejects network routing variables in `.env` files.
The bridge passes the saved Base URL through the process environment.
Do not add `DEEPSEEK_BASE_URL` or other network routing variables to the private `.env` file.

Setup preserves unrelated configuration and existing rules.
It refuses an existing global `dsh` server that it does not own.
It reports a conflict if a different skill already exists at the target path.
It does not overwrite that skill.
Repeated setup does not duplicate managed content.
Setup does not write project configuration, project skills, or any `AGENTS.md` file.
It does not rewrite `~/.codex/AGENTS.md`.
It does not change login, default model, or provider settings.

An npx setup can record absolute package paths inside the npm cache.
Repeat setup after cache cleanup, installation moves, or changes to the Node executable path.
The generated absolute paths do not follow those changes automatically.
[examples/codex.toml](examples/codex.toml) shows a manual npx configuration.
Setup remains the recommended installation method.

### Upgrade from project-bound source configuration

An old project `.codex/config.toml` can shadow the new global server.
Remove only the old managed `dsh` block from that project configuration, if present.
Preserve unrelated project settings and user data.
Remove obsolete managed delegation instructions that require a startup-fixed root.
Preserve unrelated rules in project skills and `AGENTS.md`.
The installer does not scan or change all repositories.
It does not automatically migrate old project configuration.
An existing unowned global `dsh` server causes a safe conflict instead of an overwrite.

### Client forms and local execution

The MCP Registry contains metadata.
npm supplies the package downloads.
The local stdio process executes tools and accesses files on your workstation.
A remote cloud MCP server cannot directly change arbitrary projects on your workstation.

Clients that support `server.json` input metadata can render the two provider fields.
Support depends on the client.
Codex supports custom MCP environment configuration.
An arbitrary Registry-generated Codex popup or one-click storefront installation remains unverified.
No MCPB desktop bundle forms part of this installation route.

This TOML fragment documents environment variables for clients with their own configuration forms:

```toml
[mcp_servers.dsh.env]
DEEPSEEK_API_KEY = "<API_KEY_PLACEHOLDER>"
DEEPSEEK_BASE_URL = "https://api.deepseek.com/anthropic"
```

The key value is a documentation placeholder, not a working credential.
Do not save a real key in project TOML.
Use setup's private `.env` or the client's protected environment settings.
The runtime accepts the same environment variables from either route.

## Use the tool

The user skill and MCP initialization instructions guide automatic delegation of worthwhile, bounded, low-risk tasks.
They do not require a per-project `AGENTS.md` section.
They cannot guarantee automatic tool invocation.
Existing project, user, or global routing rules can prevent automatic delegation.
Automatic delegation does not disable Codex tool approval prompts.

For an explicit request, tell Codex:

> Use $deepseek-worker for a bounded documentation task. Limit edits to README.md. Review the result before acceptance.

For an initial read-only check, tell Codex:

> Call delegate_to_deepseek with my active project's absolute project_root and read-only permission. Ask it to reply DSH_MCP_SMOKE_OK without reading files or running tools.

The main agent must check the returned status and answer.
A `completed` status does not prove task acceptance.
Use a disposable project for the first write task.

### Select the project for each call

Codex must supply `project_root` in every `delegate_to_deepseek` call.
Codex selects the exact absolute root from its active project context or explicit user authorization.
Codex must not guess the root when that context is unavailable.
The server does not discover the root from `process.cwd()`, HOME, installation paths, or session history.
Do not use your home directory or `/` as a default grant.

The call's `project_root` is the trusted caller's directory grant.
It is not proof that the directory equals the native Codex workspace.
The server does not independently check a Codex workspace ACL.
Do not assume Codex automatically exposes its workspace to this server.

Optional `cwd` selects a directory inside that call's root.
The same server can handle different projects in successive calls.
Supply complete context, file scope, constraints, and acceptance criteria.
Permit only one writer in a workspace at a time.
Review actual changes before acceptance.
Require unresolved questions in the worker's final answer instead of live dialogue.

## Calls and results

`delegate_to_deepseek` runs one synchronous task.
Each server instance permits one active task.
It rejects overlapping calls instead of queuing them.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `project_root` | Required | Absolute, authorized project directory for this call. |
| `task` | Required | Complete task, file scope, constraints, and acceptance criteria. Maximum: 65,536 characters. |
| `cwd` | `.` | Directory within this call's canonical `project_root`. |
| `permission_mode` | `read-only` | Use `workspace-write` explicitly for edits. |
| `session_id` | None | Resume a returned DSH session with the same project grant and actual `cwd`. |
| `timeout_seconds` | `300` | Integer from 1 to 900 seconds. |

The server canonicalizes `project_root` and checks that it is a directory for each call.
It resolves real paths for `cwd` and rejects escapes through parent paths or symbolic links.
The client tool timeout must exceed the worker timeout and cleanup time.

The call returns only the final answer, status, session identifier, diagnostics, and Git change information.
It does not stream intermediate DSH events to Codex.
It does not support live bidirectional questions, MCP elicitation, or approval responses.

For unresolved decisions, the worker must stop and report its question in the final answer.
Codex resolves the question before another tool call.
Codex then supplies `session_id`, the same project grant, the same actual `cwd`, and explicit continuation instructions.
Do not assume a session can resume in a different project.
This sequence is not real-time dialogue.

The server uses `--approval-policy never`.
DSH denies operations that require approval.
The policy does not approve them automatically.
The server offers no full-access mode or extra writable-directory parameter.
It disables settings edits, plugin management, and recursive delegation tools.

The result appears as `structuredContent` and matching JSON text.

- `status`: `completed`, `failed`, `timed_out`, `cancelled`, or `output_limit`.
- `session_id`, `answer`, `reason`: the session, final answer, and termination reason.
- `exit_code`, `signal`, `diagnostics`: process results and the final 32 KiB of standard error.
- `project_root`, `cwd`, `model`, `permission_mode`: the canonical project root and actual execution settings.
- `changed_files`, `git_root`, `change_warning`: Git change information and its limits.

`completed` requires exit code zero and a DSH final reason of `completed`.
It means that the Harness turn completed, not that the task met its acceptance criteria.
The main agent must review actual files and applicable check results.

## Safety and limits

- The per-call project root restricts task directories, not all file reads.
- DSH can read other accessible files.
- `read-only` restricts writes but does not isolate reads.
- `workspace-write` permits writes to `cwd`, required DSH state, and platform-defined temporary directories.
- Shell tools do not provide a container for malicious code.
- Use this tool only with trusted projects.
- Use a real container or a separate account when you need stronger isolation.

The file list in `task` is an instruction, not a file-level access control list (ACL).
The server does not prevent or undo edits outside that list.
The main agent must review actual changes.

Keep all writers to the same workspace serial, including Codex, editors, other agents, and other MCP instances.
The server's serial limit covers only its own instance.
For parallel tasks, prepare separate worktrees and supply their respective per-call project roots.
Do not change shared Git metadata concurrently.

Git change reports compare status and file fingerprints before and after the task.
Paths are relative to `git_root`.
Reports can detect further edits to already changed files.
Reports exclude ignored files and do not provide complete internal submodule diffs.
They cannot attribute changes from concurrent writers.
A missing repository or a failed Git check produces a warning.
A `null` change report does not mean that no files changed.
The report supports review but does not replace an audit.

Timeout, cancellation, client disconnection, or termination triggers POSIX process-group cleanup.
The server first sends SIGTERM and then uses SIGKILL if necessary.
It waits for exit before returning.
Normal exit also triggers cleanup of descendants in the same process group.
Processes that detach from that group escape this guarantee.
Partial writes can remain after any failure or interruption.
The server does not roll back, commit, merge, or create worktrees.

The server stops tasks whose total NDJSON standard output exceeds 8 MiB.
It returns `output_limit` instead of reporting success from truncated output.

DSH stores sessions and task content persistently in its private home.
Treat that directory and diagnostic output as sensitive data.
Do not include secrets in tasks.
The MCP server reserves standard output for protocol messages.

DSH remains a developer preview.
Review official CLI and NDJSON contracts before dependency upgrades.
Do not replace fixed versions with unversioned `latest` dependencies.

## Verification scope

Run the automated checks with `npm test`.
The repository uses local subprocesses and local HTTP fixtures for regression checks.

Real DSH integration checks used a local Messages SSE fixture.
Those checks covered file writes, read-only denial, and session continuation.
Missing-key checks covered credential failure handling.
Setup smoke checks covered hidden key input and the generated MCP configuration.
The generated server loaded its key from the private file during a local DSH call.
One global MCP connection used real DSH to change files in two separate projects.
Missing or relative project roots made no provider request.
Browser and terminal setup checks used isolated user profiles without project binding.
These checks do not prove real DeepSeek service behavior.
Online DeepSeek generation and Codex App loading remain unverified.

## Publisher procedure

Publication remains pending.
The publisher needs npm rights for the `@hzxwonder` scope.
The unscoped `dsh-mcp` name belongs to another package.
If the authorized scope changes, update every package reference before publication.

1. Authorize the npm account in the browser.

   ```sh
   npm login
   ```

2. Check the package contents, pinned dependencies, and `server.json` metadata.
3. Run the release checks.
4. Publish the npm artifact with public access.

   ```sh
   npm publish --access public
   ```

5. Check the published npm artifact before Registry publication.

   ```sh
   npm view @hzxwonder/dsh-mcp@0.3.0 version
   npx --yes --package @hzxwonder/dsh-mcp@0.3.0 dsh-mcp --help
   ```

6. Install the official `mcp-publisher` tool from the Registry quickstart.
7. Authenticate with the GitHub account that owns the Registry namespace.

   ```sh
   mcp-publisher login github
   ```

8. Publish the metadata only after the npm check succeeds.

   ```sh
   mcp-publisher publish
   ```

The Registry identity is `io.github.hzxwonder/dsh-mcp`.
The Registry metadata must reference the published npm package and version.
These commands do not create npm scope rights.
They do not replace browser authorization or GitHub namespace verification.
Remove the pending notice only after actual publication.

## Official references

- [DeepSeek Harness repository and safety guidance](https://github.com/deepseek-ai/deepseek-harness)
- [DSH CLI options](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md)
- [DSH headless credentials and NDJSON contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)
- [Codex MCP configuration](https://developers.openai.com/codex/mcp/)
- [Codex project configuration](https://developers.openai.com/codex/config-basic/)
- [Codex skills](https://developers.openai.com/codex/skills/)
- [Official MCP Registry quickstart](https://modelcontextprotocol.io/registry/quickstart)
- [Official MCP Registry schema](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json)
- [npm npx documentation](https://docs.npmjs.com/cli/v11/commands/npx)
- [npm login documentation](https://docs.npmjs.com/cli/v11/commands/npm-login)
- [npm publish documentation](https://docs.npmjs.com/cli/v11/commands/npm-publish)
