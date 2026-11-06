# dsh-mcp

让 Codex 保持当前 GPT 模型、Provider 和账号登录，通过 MCP 把边界明确的任务交给 **DeepSeek Harness + DeepSeek Flash**。Codex 主代理负责选择思考强度、读取工作器结果、审查修改和最终验收。

## 快速开始：npx 安装一次

需要 macOS 或 Linux、Node.js **24.9.0 或更高版本**、npm，以及支持 MCP 的 Codex 客户端。准备好 [DeepSeek API Key](https://platform.deepseek.com/api_keys)，或兼容 Messages API 的服务凭据。

安装命令固定使用 `0.4.0`。此版本要求每次显式选择思考强度，并从持久化 session 返回最终结果。

```sh
npx --yes --package @hzxwonder/dsh-mcp@0.4.0 dsh-mcp setup
```

安装器打开本机浏览器表单，只填写两个配置项：

| 配置项 | 说明 |
| --- | --- |
| API Key | 必填，密码输入框，不会进入命令参数或项目配置。 |
| Base URL | 可选，留空使用 `https://api.deepseek.com/anthropic`。 |

保存后，在 Codex 中新建会话，确认工具列表出现 `delegate_to_deepseek`。客户端可能为工具名添加服务器前缀。

**全局安装一次，不选择或绑定项目，也不需要逐项目配置。** 每次委派时，Codex 必须传入当前授权项目的绝对路径 `project_root`，并主动选择 `thinking_effort`。

没有图形浏览器时，使用终端输入：

```sh
npx --yes --package @hzxwonder/dsh-mcp@0.4.0 dsh-mcp setup --terminal
```

终端不会回显 API Key。不要把真实密钥写进命令参数、URL、任务文本、skill 或项目配置。ChatGPT 登录、订阅额度和 DSH GUI 登录不能替代 API Key。

### Base URL 必须支持 Messages

DSH 使用 **Messages API**，请求路径为 `/v1/messages`。默认根地址是 `https://api.deepseek.com/anthropic`。只支持 OpenAI Chat Completions 的地址不能直接使用。

自定义地址不能包含用户名、密码、查询参数或片段。请只使用可信服务：该服务会收到你的密钥和任务数据。模型费用由对应 API 服务收取。

## 让 Codex 委派任务

安装器安装用户级 `deepseek-worker` skill，MCP 初始化时也提供委派说明，不修改项目的 `AGENTS.md`。可以直接描述需求：

> 为端口解析模块补充边界测试。只修改现有测试文件，不改变生产代码。请按任务选择 DeepSeek 思考强度，读取会话结果后审查 diff 并运行相关测试。

需要明确指定时：

> $deepseek-worker 把这个独立测试任务交给 DeepSeek。你选择合适的思考强度，并负责读取结果、审查实际修改和最终验收。

适合委派边界清晰的简单实现、独立测试、文档和机械修改。极小任务应直接完成。不委派架构、安全、鉴权、支付、数据库迁移、根因不明的问题或涉及秘密的任务。

规则指导模型选择，**不保证每次调用**，也不取消 Codex 的批准提示。项目和用户规则仍然优先。

### Codex 必须主动选择思考强度

每次调用（包括用 `session_id` 续接）都必须显式传入 `thinking_effort`，没有默认值：

| 值 | 选择依据 |
| --- | --- |
| `low` | 机械修改、简单文档或明确的样板任务。 |
| `high` | 边界明确，但需要推理的实现或测试任务。 |
| `off` | 明确决定不使用思考时才选择。 |
| `max` | 额外推理成本有明确理由时才选择。 |

Codex 不得静默补齐缺失值。只接受 `off`、`low`、`high`、`max`，不接受 `medium` 或 `xhigh` 等别名。这是真实的 DSH `agent-default-model.config.reasoningEffort` 配置，不是任务中的提示词。续接时也必须重新选择，不依赖旧会话的设置。

### 最小调用示例

```json
{
  "project_root": "/absolute/path/to/current-project",
  "thinking_effort": "high",
  "task": "补充指定模块的边界测试。只修改对应测试文件，复用现有测试框架，不提交 Git，不再委派。遇到未决问题停止并报告。报告精确验证命令和结果。",
  "cwd": ".",
  "permission_mode": "workspace-write",
  "timeout_seconds": 300
}
```

Codex 从当前项目上下文或用户明确授权中取得路径。服务不会从自身工作目录、HOME、安装目录或上次调用猜测项目。缺少路径、相对路径、目录不存在或不是目录时，调用失败，不启动工作器。

`project_root` 是调用方对本次目录的授权，**不是服务端独立核实过的 Codex 工作区 ACL**。不要默认授权 HOME 或 `/`。

## 工作器结束后，读取什么结果

`delegate_to_deepseek` 同步执行一个任务。DSH 进程停止后，MCP 读取对应的持久化会话，核对会话 ID 和保存的实际工作目录。`answer` 来自**当前最新持久化回合中最后一条已提交的 assistant 文本**，不是 stdout 的替代摘要。

结果放在 `structuredContent` 和文本 JSON 中。Codex 必须先读取以下字段，再审查实际修改：

- `answer`、`output_source: "session"`：会话中的最终文本及来源。
- `session_id`、`session_file`、`assistant_seq`、`turn`：对应会话和文本的位置元数据。
- `status`、`exit_code`、`signal`、`reason`、`diagnostics`：进程状态、终止原因和诊断。
- `terminal_reason`、`session_output_error`：持久化回合的结束原因和读取失败说明。
- `project_root`、`cwd`、`model`、`thinking_effort`、`permission_mode`：实际执行设置。
- `changed_files`、`git_root`、`change_warning`：Git 变化报告及限制。

隐藏思考、工具调用和工具结果都不是最终答案。若最新回合没有已提交的 assistant 文本，`answer` 为空且 `assistant_seq` 为 `null`，不能取上一回合的成功答案。读取的回合必须与本次进程的 `turn_start` 一致：续接若在新回合开始前失败，不会返回旧文本。会话缺失、校验失败、不可读或身份/目录不匹配会明确报错，不回退到 stdout。

读取使用 DSH 官方的只读存储接口，支持压缩会话。官方接口可能忽略未完成的物理尾帧，只返回已验证的持久化前缀。读取需要重放会话历史，大会话的读取成本会增加。

只有进程退出码为 0、DSH 最终原因为 `completed`，且成功读取的对应回合也已持久化完成，服务才报告完成。**这只表示代理回合结束，不代表任务通过验收。** Codex 必须检查 `answer`、`reason`、`terminal_reason`、`session_output_error` 和 `diagnostics`，再审查实际 diff 并执行验收。工作器声称运行了检查，不等于主代理亲自运行了检查。

### 未决问题与续接

当前调用不实时转发中间事件，不支持途中的双向问答、批准响应或单独浏览任意会话的工具。

1. DeepSeek 停止任务，在最终文本中报告未决问题。
2. Codex 读取结果，在已有授权内决策，必要时询问用户。
3. 上次调用返回后，Codex 用返回的 `session_id`、相同 `project_root` 和相同实际 `cwd` 续接。
4. 新调用仍须显式选择 `thinking_effort`，并提供完整续接指令和权限。

这是多轮会话续接，不是实时对话。`--approval-policy never` 拒绝需要人工批准的操作，不是自动批准。

## 本地依赖与配置

npm 自动下载**真实、完整的本地 Harness 依赖**。不需要另行全局安装 `dsh`，不会安装桌面 App 或下载模型权重。npm 主流程不需要克隆源码，也不要求 Git 作为安装步骤。任务本身需要的工具仍须在本机可用。

```text
本机 Codex → MCP stdio → 本机 dsh-mcp → 本机 DSH 子进程 → 配置的 API 服务
```

本项目不提供远程执行服务。依赖占用较大，具体磁盘占用取决于平台、依赖布局和缓存。

固定使用 `@deepseek-ai/dsh@0.2.2-rc.1` 和 `deepseek-flash`。DSH 仍处于 developer preview，升级时需要检查兼容性。使用官方 `headless --json` 和持久化/查询库，不依赖 DSH Web 内部接口。

| 文件 | 用途 |
| --- | --- |
| `~/.codex/config.toml` | 注册用户级 MCP 服务器 `dsh`。 |
| `~/.agents/skills/deepseek-worker/SKILL.md` | 安装用户级委派 skill。 |
| `~/.dsh-mcp/.env` | 保存 API Key。 |
| `~/.dsh-mcp/settings.json` | 保存 Base URL。 |

设置 `CODEX_HOME` 时，Codex 配置写入 `$CODEX_HOME/config.toml`。`--home` 只改变 DSH 私有状态目录。私有目录权限为 `0700`，密钥和设置文件为 `0600`。MCP 配置不包含密钥或固定项目路径。

**不要把 `DEEPSEEK_BASE_URL` 写进私有 `.env`。** DSH 不允许在那里设置网络路由变量。桥接器从 `settings.json` 读取地址，再通过进程环境传入。

安装器复用已保存的密钥，不覆盖它。更换密钥时，编辑私有 `.env` 后启动新的 MCP 会话。安装器保留其他模型、Provider、MCP 和登录配置，不向项目写入配置或 skill。

### 更新与冲突保护

更新已安装配置仍使用同一条全局 setup 命令，不需要逐项目操作：

```sh
npx --yes --package @hzxwonder/dsh-mcp@0.4.0 dsh-mcp setup
```

安装器可以更新归它管理且未被修改的旧 skill 模板。若 skill 已定制，或缺少可核对的旧模板引用，安装器保留现有文件并报告冲突。先备份，再手动合并或处理冲突，不要直接覆盖定制内容。同名但不归安装器管理的 `dsh` 配置也不会被覆盖。

npx 安装可能把服务路径记录为 npm 缓存中的绝对路径。清理缓存、移动安装目录或更换 Node 后，应重新运行 setup。

旧项目的 `.codex/config.toml` 可能覆盖新全局配置。只移除旧的受管理 `dsh` 区块，保留其他内容。对旧项目 skill 或 `AGENTS.md` 中的固定路径规则也只移除过时受管理部分。安装器不扫描或批量修改所有仓库。

## 参数参考

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `project_root` | 必填 | 本次授权的项目绝对路径。 |
| `thinking_effort` | 必填 | `off`、`low`、`high` 或 `max`。续接也必填。 |
| `task` | 必填 | 完整目标、上下文、允许修改的文件、限制和验收标准，最多 65536 字符。 |
| `cwd` | `.` | 根目录内的相对目录或绝对目录。 |
| `permission_mode` | `read-only` | 确需编辑时显式选择 `workspace-write`。 |
| `session_id` | 无 | 续接对应 DSH 会话。 |
| `timeout_seconds` | `300` | 整数，范围 1–900 秒。 |

服务解析真实路径，拒绝 `cwd` 通过 `..` 或符号链接逃出本次根目录。一个服务器实例最多运行一个任务，包括跨项目任务。重叠调用立即报错，不后台排队。客户端超时应长于工作器超时和清理时间，安装器设为 960 秒。

## 安全边界

- 工作区限制不是读取隔离。DSH 可以读取其他可访问文件，shell 工具不是恶意代码容器。
- `workspace-write` 可以写入 `cwd`、必要 DSH 状态和平台定义的临时目录。敏感任务应使用容器或独立账户。
- 任务文件名单是行为约束，不是强制文件级 ACL。服务不自动撤销越界编辑。
- 同一工作区不能有并发写入者，包括主代理、编辑器、其他代理和 MCP 实例。并行任务应先准备独立 worktree，不并发修改共享 Git 元数据。
- Git 报告比较前后状态和内容指纹，不包含忽略文件或完整子模块内部 diff，也不能归因外部并发修改。
- `changed_files: null` 表示报告不可用，不表示没有修改。检查 `change_warning` 和实际 diff。
- 超时、取消、客户端断开或终止时，服务清理 POSIX 进程组。自行脱离该组的后代不在保证内。
- 服务等待工作器退出，但不回滚。失败或中断后先检查部分修改，不自动 reset、clean 或重试覆盖用户修改。
- NDJSON stdout 超过 8 MiB 时，服务终止任务并报告 `output_limit`，不会截断后冒报成功。
- DSH 持久化会话和任务内容。保护私有目录与诊断输出，不在任务中放秘密，也不公开隐藏思考。
- 工作器不得递归委派。服务不自动提交、发布、合并、回滚或创建 worktree，不提供 full-access 参数。

## 高级：源码安装与开发

普通 npm 用户不需要此流程。需要修改桥接器源码时：

```sh
git clone https://github.com/hzxwonder/dsh-mcp.git
cd dsh-mcp
npm ci
npm run setup
```

终端安装使用 `npm run setup -- --terminal`。自定义私有目录使用 `npm run setup -- --home /absolute/path/to/private/dsh-home`。

开发检查命令为 `npm test`，当前 44 项检查全部通过。另用真实 DSH 和本地 Messages 协议桩核对了四档 effort 的实际请求、同会话续接和压缩 session 最终文本读取；从已发布的 `0.3.0` 配置升级也已验证。真实 DeepSeek 在线推理、Codex App 加载和模型自动选择工具仍需在实际环境中检查。

公开分发验收也已通过：从 npm 安装 `0.4.0`，完成真实 `0.3.0 → 0.4.0` 配置升级，确认密钥和 Base URL 保持不变，并通过安装后的 Harness 核对 effort 与 session 输出链路。验证使用隔离的临时用户配置和本地协议桩，不产生真实模型费用。

## 分发与参考

包页面：[npm · @hzxwonder/dsh-mcp](https://www.npmjs.com/package/@hzxwonder/dsh-mcp)。普通安装用户不需要登录 npm。

官方 MCP Registry 条目尚未登记。npm 发布不自动进入客户端商店。`server.json` 提供两个 Provider 输入项，但不保证 Codex 原生商店显示相同表单。`isSecret` 只是客户端处理提示，不保证加密存储。

手动配置见 [examples/codex.toml](examples/codex.toml)。优先使用安装器私有文件或客户端受保护凭据存储，不把真实密钥提交到 TOML。

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [DSH Headless 凭据和 NDJSON 接口](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)
- [Codex MCP 配置](https://developers.openai.com/codex/mcp/)
- [Codex skills](https://developers.openai.com/codex/skills/)
- [MCP Registry 发布说明](https://modelcontextprotocol.io/registry/quickstart)
