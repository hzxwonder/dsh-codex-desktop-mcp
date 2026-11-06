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
- npm and Git.
- Codex with MCP support.
- A separate DeepSeek API key.

Create an API key at the [DeepSeek API platform](https://platform.deepseek.com/api_keys).

You do not need a global Codex CLI or a global DSH installation.
DeepSeek API usage has separate billing.
Your ChatGPT account and DSH GUI login do not replace the API key.
`package-lock.json` fixes the dependency versions.

## Install for a project

1. Clone the public repository.

   ```sh
   git clone https://github.com/hzxwonder/dsh-mcp.git
   ```

2. Enter the installation directory.

   ```sh
   cd dsh-mcp
   ```

3. Install the dependencies.

   ```sh
   npm ci
   ```

4. Configure your target project.

   ```sh
   npm run setup -- /absolute/path/to/your-project
   ```

5. Enter your DeepSeek API key at the hidden prompt.
6. Open the target project in Codex.
7. Trust the project only if you trust its code and configuration.
8. Start a new Codex session.
9. Check that Codex lists `delegate_to_deepseek`.

Codex may add a server prefix to the tool name.
Codex ignores project `.codex/config.toml` until you trust the project.
Setup does not require manual TOML edits.

Without a project argument, setup prompts for the project path.
Use `npm run setup -- --help` for CLI help.
Use this command for a different private home:

```sh
npm run setup -- /absolute/path/to/your-project --home /absolute/path/to/private/dsh-home
```

Setup skips the key prompt when `DEEPSEEK_API_KEY` or the private home's `.env` supplies a key.
Do not put keys in shell arguments, project configuration, skills, or task text.
An existing private-home key takes precedence over a supplied replacement during repeated setup.

### Generated files

Setup uses `~/.dsh-mcp` as the default private home.
The table uses `<project>` for the absolute target project path.

| Path | Purpose |
| --- | --- |
| `~/.dsh-mcp/.env` | Stores `DEEPSEEK_API_KEY` outside the project. |
| `<project>/.codex/config.toml` | Registers `[mcp_servers.dsh]` for this project. |
| `<project>/.agents/skills/deepseek-worker/SKILL.md` | Supplies delegation instructions. |
| `<project>/AGENTS.md` | Contains a managed delegation section. |

A custom `--home` changes the private-home path.
Setup sets the private directory mode to `0700` and the key file mode to `0600`.
The MCP configuration contains absolute Node, server, project, and private-home paths.
It sets `startup_timeout_sec = 20` and `tool_timeout_sec = 960`.
It contains no API key.

Setup preserves unrelated configuration and existing rules.
It refuses an existing `dsh` server that it does not own.
It reports a conflict if a different skill already exists at the target path.
It does not overwrite that skill.
Repeated setup does not duplicate managed content.
Setup does not edit `~/.codex/AGENTS.md` or `~/.codex/config.toml`.
It does not change login, default model, or provider settings.

Repeat setup after you move this installation or change the Node executable path.
The generated absolute paths do not follow those changes automatically.
[examples/codex.toml](examples/codex.toml) shows the project configuration format.
Setup remains the recommended installation method.

## Use the tool

Setup installs instructions for automatic delegation of worthwhile, bounded, low-risk tasks.
Those instructions guide Codex decisions.
They cannot guarantee automatic tool invocation.
Project and user restrictions take precedence.
Automatic delegation does not disable Codex tool approval prompts.

For an explicit request, tell Codex:

> Use $deepseek-worker for a bounded documentation task. Limit edits to README.md. Review the result before acceptance.

For an initial read-only check, tell Codex:

> Call delegate_to_deepseek with read-only permission. Ask it to reply DSH_MCP_SMOKE_OK without reading files or running tools.

The main agent must check the returned status and answer.
A `completed` status does not prove task acceptance.
Use a disposable project for the first write task.

### Optional user-wide routing

Project setup normally supplies the necessary routing rules.
For user-wide routing, append this snippet to `~/.codex/AGENTS.md`.
Do not replace unrelated rules.
If another routing rule conflicts, replace only that routing rule.

```markdown
## Optional DeepSeek routing

- Preserve the current GPT model, provider, and account.
- Follow project and user restrictions first.
- Consider DeepSeek for worthwhile, bounded, low-risk tasks.
- Check that the MCP workspace root exactly matches the current project root.
- Do not delegate when you cannot check that match.
- Exclude secrets, security decisions, architecture, and unknown-root-cause problems.
- Supply complete context, file scope, constraints, and acceptance criteria.
- Permit only one writer in the workspace at a time.
- Review actual changes before acceptance.
- Treat `completed` as Harness turn completion, not task acceptance.
- Require the worker to stop and report unresolved questions in its final answer.
- Resume with the returned session_id and the same cwd after resolving those questions.
```

## Calls and results

`delegate_to_deepseek` runs one synchronous task.
Each server instance permits one active task.
It rejects overlapping calls instead of queuing them.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `task` | Required | Complete task, file scope, constraints, and acceptance criteria. Maximum: 65,536 characters. |
| `cwd` | `.` | Directory within the configured workspace root. |
| `permission_mode` | `read-only` | Use `workspace-write` explicitly for edits. |
| `session_id` | None | Resume a returned DSH session with the same `cwd`. |
| `timeout_seconds` | `300` | Integer from 1 to 900 seconds. |

The server resolves real paths for `cwd` and rejects escapes through parent paths or symbolic links.
The client tool timeout must exceed the worker timeout and cleanup time.

The call returns only the final answer, status, session identifier, diagnostics, and Git change information.
It does not stream intermediate DSH events to Codex.
It does not support live bidirectional questions, MCP elicitation, or approval responses.

For unresolved decisions, the worker must stop and report its question in the final answer.
Codex resolves the question before another tool call.
Codex then sends the returned `session_id`, the same `cwd`, and explicit continuation instructions.
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
- `cwd`, `model`, `permission_mode`: the actual execution settings.
- `changed_files`, `git_root`, `change_warning`: Git change information and its limits.

`completed` requires exit code zero and a DSH final reason of `completed`.
It means that the Harness turn completed, not that the task met its acceptance criteria.
The main agent must review actual files and applicable check results.

## Safety and limits

- The workspace root restricts task directories, not all file reads.
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
For parallel tasks, prepare separate worktrees and separate MCP roots first.
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
These checks do not prove real DeepSeek service behavior.
Online DeepSeek generation and Codex App loading remain unverified.

## Official references

- [DeepSeek Harness repository and safety guidance](https://github.com/deepseek-ai/deepseek-harness)
- [DSH CLI options](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md)
- [DSH headless credentials and NDJSON contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)
- [Codex MCP configuration](https://developers.openai.com/codex/mcp/)
- [Codex project configuration](https://developers.openai.com/codex/config-basic/)
- [Codex skills](https://developers.openai.com/codex/skills/)
