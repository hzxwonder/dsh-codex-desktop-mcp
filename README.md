# dsh-mcp

让 Codex 保持当前 GPT 模型、Provider 和账号登录，通过 MCP 把边界明确的任务交给 **DeepSeek Harness + DeepSeek Flash**。Codex 主代理负责拆分任务、审查修改和最终验收。

本项目使用官方 `headless --json` 接口，不依赖 DSH Web 内部接口。当前固定使用 `@deepseek-ai/dsh@0.2.2-rc.1`，模型为 `deepseek-flash`。DSH 仍处于 developer preview，升级时需要重新检查兼容性。

## 运行方式

```text
用户电脑上的 Codex
    ↓ MCP stdio
用户电脑上的 dsh-mcp
    ↓ 启动本地子进程
用户电脑上的 DeepSeek Harness
    ├─ 读写本次授权的项目
    └─ 请求 DeepSeek 官方 API 或自定义 Base URL
```

安装 MCP 时，npm 会自动下载完整的 Harness 依赖。不需要用户另行全局安装 `dsh`，也不会安装桌面 App 或下载模型权重。

你使用自己的 DeepSeek API Key，模型费用由对应 API 服务收取。本项目只提供软件，不提供远程任务执行服务。若使用自定义 Base URL，该服务会收到你的密钥和任务数据。

依赖的磁盘占用较大。开发环境的 `node_modules` 曾约为 922 MB，具体占用因平台、依赖布局和缓存而异。

## 环境要求

- macOS 或 Linux。
- Node.js **24.9.0 或更高版本**。
- npm。
- 支持 MCP 的 Codex 客户端。
- [DeepSeek API Key](https://platform.deepseek.com/api_keys)，或兼容 Messages API 的服务凭据。

ChatGPT 账号登录、订阅额度和 DSH GUI 登录不能替代 API Key。

## 快速安装

### npm 安装

包页面：[npm · @hzxwonder/dsh-mcp](https://www.npmjs.com/package/@hzxwonder/dsh-mcp)。以下命令固定使用 `0.3.0`，避免自动升级改变执行行为。

```sh
npx --yes --package @hzxwonder/dsh-mcp@0.3.0 dsh-mcp setup
```

安装器会打开本机浏览器表单，只填写两个配置项：

| 配置项 | 说明 |
| --- | --- |
| API Key | 必填，密码输入框，不会进入命令参数或项目配置。 |
| Base URL | 可选，留空使用 `https://api.deepseek.com/anthropic`。 |

保存后，在 Codex 中新建会话，确认工具列表出现 `delegate_to_deepseek`。客户端可能为工具名添加服务器前缀。

**只安装一次，不需要选择或绑定项目。** 切换项目后不需要重新安装。每次委派时，由 Codex 根据当前上下文传入项目的绝对路径 `project_root`。

没有图形浏览器时，使用终端输入：

```sh
npx --yes --package @hzxwonder/dsh-mcp@0.3.0 dsh-mcp setup --terminal
```

终端不会回显 API Key。不要把真实密钥写进命令参数、URL、任务文本、skill 或项目配置。

### 从源码安装

```sh
git clone https://github.com/hzxwonder/dsh-mcp.git
cd dsh-mcp
npm ci
npm run setup
```

终端方式：

```sh
npm run setup -- --terminal
```

自定义私有状态目录：

```sh
npm run setup -- --home /absolute/path/to/private/dsh-home
```

安装器会复用已经保存的密钥，不会覆盖它。需要更换密钥时，编辑私有 `.env` 文件，再启动新的 MCP 会话。

### Base URL 的协议要求

DSH 使用 **Messages API**，请求路径为 `/v1/messages`。默认根地址是：

```text
https://api.deepseek.com/anthropic
```

只支持 OpenAI Chat Completions 的代理地址不能直接使用。自定义地址必须支持 Messages 协议，并且不能包含用户名、密码、查询参数或片段。请只使用可信的 API 服务。

## 安装器修改哪些文件

| 文件 | 用途 |
| --- | --- |
| `~/.codex/config.toml` | 注册用户级 MCP 服务器 `dsh`。 |
| `~/.agents/skills/deepseek-worker/SKILL.md` | 安装用户级委派 skill。 |
| `~/.dsh-mcp/.env` | 保存 API Key。 |
| `~/.dsh-mcp/settings.json` | 保存 Base URL。 |

如果设置了 `CODEX_HOME`，Codex 配置写入 `$CODEX_HOME/config.toml`。`--home` 只改变 DSH 的私有状态目录。

私有目录权限为 `0700`，密钥和设置文件权限为 `0600`。MCP 配置中不包含密钥或固定项目路径。

DSH 不允许在 `.env` 中设置网络路由变量。**不要把 `DEEPSEEK_BASE_URL` 写进私有 `.env`。** 桥接器会读取 `settings.json`，再通过进程环境把地址传给 DSH。

安装器保留其他模型、Provider、MCP 和登录配置，不修改任何 `AGENTS.md`，也不向项目中写配置或 skill。

已有同名但不归安装器管理的 `dsh` 配置，或已有不同内容的同名 skill 时，安装器会报告冲突，不会覆盖。

npx 安装可能把服务路径记录为 npm 缓存中的绝对路径。清理缓存、移动安装目录或更换 Node 可执行文件后，需要重新运行 `setup`。

## 如何让 Codex 自动委派

安装器会安装用户级 `deepseek-worker` skill。MCP 初始化时也会提供委派说明，不需要为每个项目追加 `AGENTS.md`。

普通任务可以直接描述需求。例如：

> 为端口解析模块补充边界测试。只修改现有测试文件，不改变生产代码。完成后审查 diff 并运行相关测试。

Codex 会根据规则判断是否值得委派：

- 适合：边界清晰的简单实现、独立测试、文档、样板代码和机械修改。
- 不适合：架构、安全、鉴权、支付、数据库迁移、根因不明的问题，以及涉及秘密的任务。
- 极小任务直接完成，避免委派成本超过实现成本。

这些规则指导模型选择，**不保证每次调用**，也不会取消 Codex 的工具批准提示。现有项目或用户规则可能限制委派。

需要明确指定时，可以使用：

> $deepseek-worker 把这个独立测试任务交给 DeepSeek。你负责审查实际修改和最终验收。

## 项目路径由谁提供

安装和启动 MCP 时不配置项目根目录。每次调用必须由 Codex 提供绝对路径：

```json
{
  "project_root": "/absolute/path/to/current-project",
  "task": "补充指定模块的边界测试。只修改对应测试文件，复用现有测试框架，不提交 Git。报告精确验证命令和结果。",
  "cwd": ".",
  "permission_mode": "workspace-write",
  "timeout_seconds": 300
}
```

Codex 从当前项目上下文或用户的明确授权中取得路径。服务不会从自身工作目录、HOME、安装目录或之前的调用猜测路径。

缺少路径、使用相对路径、目录不存在或路径不是目录时，调用会失败，不会启动工作器。

`project_root` 是调用方对本次任务的目录授权，**不是服务端独立核实过的 Codex 工作区 ACL**。不要默认授权 HOME 或 `/`。

## 工具参数与返回值

`delegate_to_deepseek` 同步执行一个任务。一个服务器实例最多同时运行一个任务，包括不同项目的任务。重叠调用会立即报错，不会在后台排队。

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `project_root` | 必填 | 本次授权的项目绝对路径。 |
| `task` | 必填 | 完整目标、上下文、允许修改的文件、限制和验收标准，最多 65536 字符。 |
| `cwd` | `.` | 相对 `project_root` 的目录，或其中的绝对目录。 |
| `permission_mode` | `read-only` | 确需编辑时显式选择 `workspace-write`。 |
| `session_id` | 无 | 续接已有 DSH 会话。 |
| `timeout_seconds` | `300` | 整数，范围 1–900 秒。 |

服务会解析真实路径，拒绝 `cwd` 通过 `..` 或符号链接逃出本次根目录。客户端工具超时应长于工作器超时和清理时间，安装器设为 960 秒。

结果同时放入 `structuredContent` 和文本 JSON，包含：

- `status`、`exit_code`、`signal`：执行状态和进程结果。
- `session_id`、`answer`、`reason`：会话、最终答案和终止原因。
- `project_root`、`cwd`、`model`、`permission_mode`：实际执行设置。
- `changed_files`、`git_root`、`change_warning`：Git 文件变化和报告限制。
- `diagnostics`：最后 32 KiB 标准错误输出。

只有进程退出码为 0，且 DSH 的最终原因是 `completed`，服务才会报告完成。**这只表示代理回合结束，不代表通过任务验收。** 主代理仍需审查实际文件和验证结果。

## DeepSeek 需要 Codex 决策时

当前调用只返回最终结果，不实时转发 DSH 的中间事件，也不支持调用途中的双向问答或批准响应。

协作流程为：

1. DeepSeek 停止任务，在最终答案中说明待决问题。
2. Codex 在已有授权内决策，必要时向用户询问。
3. Codex 用返回的 `session_id`、相同 `project_root` 和相同实际 `cwd` 发起续接。

这是多轮会话续接，不是实时对话。`--approval-policy never` 会拒绝需要人工批准的操作，不是自动批准。

## 安全边界与限制

- 工作区限制不是读取隔离。DSH 仍能读取其他可访问文件，shell 工具也不是恶意代码容器。
- `workspace-write` 可以写入 `cwd`、必要的 DSH 状态和平台定义的临时目录。敏感任务应使用容器或独立账户。
- 任务中的文件名单是行为约束，不是强制文件级 ACL。服务不会自动撤销越界编辑。
- 同一工作区不能有并发写入者，包括主代理、编辑器、其他代理和其他 MCP 实例。需要并发时，先准备独立 worktree。
- Git 变化报告比较任务前后的状态和内容指纹，不包含忽略文件，也不提供完整的子模块内部 diff。它不能归因外部并发修改。
- `changed_files: null` 表示报告不可用，不表示没有修改。始终检查 `change_warning` 和实际 diff。
- 超时、取消、客户端断开或进程终止时，服务清理 POSIX 进程组。自行脱离该组的后代进程不在保证内。
- 服务会等待工作器退出，但退出不是回滚。失败或中断后可能留下部分修改。
- NDJSON 标准输出超过 8 MiB 时，服务终止任务并报告 `output_limit`，不会截断后冒报成功。
- DSH 会持久化会话和任务内容。请按敏感数据保护私有目录与诊断输出，不要在任务中放入秘密。
- 服务不自动提交、发布、合并、回滚或创建 worktree，也不提供 full-access 参数。

## 从旧的项目绑定配置升级

旧项目中的 `.codex/config.toml` 可能覆盖新全局配置。只移除其中旧的受管理 `dsh` 区块，保留其他配置。

同时检查旧项目 skill 和 `AGENTS.md` 中固定安装目录的委派规则，只移除过时的受管理部分。安装器不会扫描或批量修改所有仓库。

已有手动配置的全局 `dsh` 服务器时，需要先处理同名冲突，再运行安装器。

## 分发状态

npm 用于下载程序包，MCP Registry 用于发布发现与安装元数据。两者都不负责在云端执行本机任务。

`@hzxwonder/dsh-mcp@0.3.0` 已公开发布到 npm，普通安装用户不需要登录 npm。

官方 MCP Registry 条目尚未登记。npm 发布不会自动让包进入各个客户端的商店。

当前仓库提供 `server.json`，包含两个 Provider 环境配置项。支持该元数据的客户端可以生成输入界面，但不能据此保证 Codex 原生商店会自动显示相同填写框。

注册信息中的 `isSecret` 是给客户端的处理提示，不等于所有客户端都会加密保存配置。推荐使用安装器的私有设置文件，或客户端提供的受保护凭据存储。

手动配置示例见 [examples/codex.toml](examples/codex.toml)。不要把真实密钥提交到项目 TOML。

## 验证

```sh
npm test
```

现有检查覆盖全局配置保留、凭据权限、重复安装、冲突保护、表单安全、路径校验、跨项目执行、超时与进程清理。

使用真实 DSH 与本地 Messages SSE 协议桩验证了文件写入、只读拒写、会话续接和私有设置加载。同一个全局 MCP 连接成功修改了两个独立项目。缺失或相对项目路径不会发起模型请求。

浏览器和终端安装验证使用隔离的临时用户配置，没有修改真实用户的全局配置。

本地协议验证不等于真实 DeepSeek 在线生成验证。Codex App 内加载和模型自动选择工具仍需在实际客户端中检查。

## 官方参考

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [DSH Headless 凭据和 NDJSON 接口](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)
- [Codex MCP 配置](https://developers.openai.com/codex/mcp/)
- [Codex skills](https://developers.openai.com/codex/skills/)
- [MCP Registry 发布说明](https://modelcontextprotocol.io/registry/quickstart)
- [npm 发布说明](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages)
