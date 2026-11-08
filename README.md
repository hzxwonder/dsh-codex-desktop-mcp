# dsh-codex-desktop-mcp

让 Codex 保持当前 GPT 模型、Provider 和账号登录，通过 MCP 把边界明确的任务交给**本机完整的 DeepSeek Harness（DSH）**。DSH 使用 setup 中选择的协议、API 服务和模型；Codex 主代理负责选择思考强度、读取工作器结果、审查修改和最终验收。

## 快速开始：终端 setup

> 本文对应 **0.8.1**，提供完整模块委派、双 session 并行、原 session 续接与会话内嵌进度卡片。

需要 macOS 或 Linux、Node.js **24.9.0 或更高版本**、npm，以及支持 MCP 的 Codex 客户端。准备好所选 API 服务的密钥；ChatGPT 登录、订阅额度和 DSH GUI 登录不能替代它。

在终端运行：

```sh
npx --yes --package @hzxwonder/dsh-codex-desktop-mcp@0.8.1 dsh-codex-desktop-mcp setup
```

默认全程在终端完成，不启动浏览器。首次配置按以下顺序输入：

1. **协议**：默认 Chat Completions，另外可选 OpenAI Responses 或 Anthropic Messages。
2. **Base URL**：先显示该协议的默认根地址，可按你的服务修改。
3. **API Key**：隐藏输入，不回显，也不进入命令参数或项目配置。
4. **模型**：携带刚输入的凭据向远端获取当前账号可见的模型列表，再由你选择一个模型。

| 协议与请求路径 | 默认 Base URL |
| --- | --- |
| Chat Completions · `POST /chat/completions` | `https://api.deepseek.com/v1` |
| OpenAI Responses（Codex / OpenAI）· `POST /responses` | `https://api.openai.com/v1` |
| Anthropic Messages · `POST /v1/messages` | `https://api.anthropic.com` |

Chat Completions 和 Responses 的路径相对于表中的 Base URL；例如 OpenAI Responses 实际请求为 `https://api.openai.com/v1/responses`。**Codex / OpenAI Responses 不是 Anthropic `/v1/messages`**。Base URL 填服务根地址，不填完整推理路径。选择 OpenAI 官方服务时必须选它实际提供的模型，不会静默换成 DeepSeek Flash。

接下来显示**协议、Base URL、掩码 API Key、模型**四项摘要。确认后，终端用进度提示执行一次真实、极小的模型推理；这一步可能产生少量 API 费用，不是只检查密钥是否已保存。只有该请求成功后才显示：

```text
✅ Connection successful!
```

失败会显示错误并返回可编辑摘要；可以修改协议、URL、密钥或模型后重测，不必从头安装。之后要换服务、轮换密钥或改模型，**再次运行同一条 setup 命令**即可：有已保存设置时先显示掩码摘要，再选择要修改的项。不要通过项目 TOML 或任务文本传密钥。

**全局安装一次，不选择或绑定项目，也不需要逐项目配置。** MCP 和完整 Harness 都在本机运行，不使用作者提供的执行服务。每次委派时，Codex 必须传入当前授权项目的绝对路径 `project_root`，并主动选择当前模型支持的 `thinking_effort`。

### 远端模型发现与推理测试是两件事

- Chat Completions / Responses 使用 Bearer 凭据访问模型列表 `/models`；Anthropic 原生接口使用 `x-api-key`、`anthropic-version` 访问 `/v1/models`，并读取分页结果。必须使用与你的协议和服务对应的列表入口。
- 旧 DeepSeek Messages 入口使用官方特殊列表地址 `https://api.deepseek.com/models` 和 `x-api-key`，仅限精确的 DeepSeek 官方来源；不会把这一规则套用到任意代理域名，也不会为获取列表把凭据发送到其他来源。
- 代理或兼容服务可能只开放推理、不开放模型列表，或限制当前密钥可见的模型。空列表、鉴权失败和不合法的返回体都不是发现成功，更不是连接成功。
- 如果无法发现模型，终端会明确报告失败，并提供**手动输入模型 ID**的选择；不会把本地静态模型表冒充远端发现结果。手动输入后仍必须通过真实推理测试。
- 列表可见不保证该模型支持所选协议、工具调用或某档思考强度。setup 的极小推理测试也不是完整 DSH 工具链验收。
- 自定义地址不能含用户名、密码、查询参数或片段。只使用可信服务：它会收到你的密钥和任务数据。模型列表请求拒绝重定向，不把密钥转发到其他来源；模型费用由所选 API 服务收取。

旧 `0.4` 私有设置若没有协议和模型字段，迁移时保留原有 **Anthropic Messages + `deepseek-flash`** 行为，不会因新默认值而改成 Chat Completions。需要切换时在 setup 摘要中显式修改。

命令入口为 `dsh-codex-desktop-mcp`，也提供 `dsh-mcp` 兼容别名。已有安装继续使用配置键 `dsh`、私有目录 `~/.dsh-mcp` 与原管理标记；setup 会核对旧包模板后更新注册，保留凭据、个人规则和已有会话。

## 让 Codex 委派任务

安装器安装用户级 `deepseek-worker` skill，并在全局 `AGENTS.md` 写入由 `<!-- BEGIN dsh-mcp -->` / `<!-- END dsh-mcp -->` 标记的委派规则区块。区块外的用户文本与权限保留，重复安装幂等，因此不必逐项目配置；安装器不修改项目的 `AGENTS.md`。MCP 初始化时也提供委派说明。可以直接描述需求：

> 为端口解析模块补充边界测试。只修改现有测试文件，不改变生产代码。请按任务选择 DeepSeek 思考强度，读取会话结果后审查 diff 并运行相关测试。

需要明确指定时：

> $deepseek-worker 把这个独立测试任务交给 DeepSeek。你选择合适的思考强度，并负责读取结果、审查实际修改和最终验收。

以委派收益划分工作：Codex 直接完成可立即可靠输出、无需探索的小任务（如明显修改、极短标准示例、已有命令即可完成的处理），也负责创意、审美、研究方向、论文与重要写作、复杂耦合实现、高风险决策、发布与验收。

DSH 负责目标与验收清楚、需要一定阅读、思考或局部探索，且委派具有明确收益的任务，例如理解一个小模块、处理多种边界条件、排查范围受控的非关键缺陷。混合任务由 Codex 确定关键方向，再委派适合的部分；不按“代码/文档”或文件数量机械分配。

Codex 为 DSH 构建自包含的任务契约：目标、已知事实、文件范围、允许探索和决定的内容、验收用例、最终回执。影响结果的需求缺口应先报告，由 Codex 解决后在同一 DSH 会话续接。

同一范围、同一验收标准下的代码、测试与说明可以合并为一次委派，避免按文件拆成多次调用。Codex 保留决策与验收，DSH 返回文件路径及简短检查证据；已有检查仍有效时不重复执行。

复杂研究或产品任务中，Codex 先确定科学协议、架构和接口，再识别可独立验收的工程交付。整体复杂不表示所有实现都必须由 Codex 完成；适合的委派单位是规划器及其队列/测试、统计模块及其测试或批次运行器等完整模块。只读审查适用于审查问题，不替代可行的实现委派。

### 并行任务

同一 MCP 服务最多同时运行两个 DSH session。独立写入任务使用隔离的项目副本，各自指定授权工作区内不同的 `project_root`，并各自创建进度卡。`delegate_parallel_to_deepseek` 接受 `tasks` 数组，恰好两个任务，每项参数与单任务工具相同；服务端在一次调用内并发执行，按输入顺序返回带 `index`、`isError` 和独立 `result` 的结果。一个任务失败时仍保留另一项结果。支持并行工具调用的客户端也可以使用 `Promise.allSettled` 同时提交两个单任务调用。Codex 逐项验收后集成。相同项目根目录、祖先/后代目录或同一 Git 仓库的写入域不能重叠，读者也不能与该域的写者同时运行；同一 session 不能同时续接。两个只读 session 可以共享工作区。

并发限制与冲突检查只在当前服务进程内生效，不是文件系统 ACL 或跨进程锁。协调多个连接时仍应合计最多两个任务，不得通过新增服务连接规避限制。新卡片只隔离进度展示；纠正仍续接原 session 和相同根目录/cwd。一次纠正仍未通过验收后由 Codex 接管。

DSH 推理需要访问配置的模型 API。“不要联网”也约束该调用；“不要网页检索”仅限制检索，不能据此推断所有外部模型 API 均被禁止。工具或授权不可用时，Codex 简要说明后直接完成允许的工作。

规则指导模型选择，**不保证每次调用**，也不取消 Codex 的批准提示。项目和用户规则仍然优先。

路由规则的真实任务回归见 [evals/README.md](evals/README.md)。其中保留不指定分工的规划复现任务；每次变更后用新会话执行，检查实际实现委派、纠正、独立验收和并行证据。精确 token 数据不可用时，只报告代码归属、调用次数与耗时等代理指标。

### 会话内嵌进度卡片

`show_dsh_progress` 在会话内返回一张内嵌进度卡片，并给出 `progress_id`。Codex 在委派前调用它，再把 `progress_id` 传给 `delegate_to_deepseek`；新委派和用 `session_id` 续接都分别新建卡片，不复用旧卡片。

卡片注册 `ui://dsh/progress-v1.html`，MIME 为 `text/html;profile=mcp-app`，`preferredModelDisplayMode` 为 `inline`。卡片使用官方 MCP Apps SDK 调用 `read_dsh_progress`（`visibility: app`）刷新。日志和 `view_token` 只放在 UI 专用的 `_meta`，卡片创建与读取工具的 `content` 与 `structuredContent` 只含简短提示、任务标识和状态，不转发隐藏 thinking。模型不得调用 `read_dsh_progress`，也不得读取卡片页面或原始日志。

卡片只展示任务开始、公开文本、工具调用、工具结果与任务结束；执行引擎的步骤和回合状态仅用于内部处理。外层聊天的滚动位置由宿主控制，卡片更新不会新增聊天消息。目前所用 MCP Apps 接口没有独立的聊天滚动方法；[ChatGPT 的滚动选项](https://developers.openai.com/plugins/reference)绑定在发送后续消息的接口上。卡片保持仅在 UI 中更新进度。

若当前客户端不支持卡片，或 `show_dsh_progress` 未加载，继续正常委派并在最终报告中给出结果，不自动打开侧边栏或浏览器作为降级。`get_dsh_monitor` 仅为兼容保留，只有用户明确要求外部监视页时才调用。

进度卡片按内存保存，最多 20 张；每张保留最近 200 条事件，每条最多 8,000 字符；任务结束后停止轮询。

已在本机 Codex App 验证卡片在聊天正文显示并动态完成。上下文验收使用真实 Codex 后端和本地模拟模型：模型请求不含 UI 专用随机标记，进度读取工具不出现在模型工具列表中。客户端仍需支持 MCP Apps。

### Codex 必须主动选择思考强度

每次调用（包括用 `session_id` 续接）都必须显式传入 `thinking_effort`，没有默认值。以下是桥接器支持表达的档位，**实际可用值以当前所选模型对应的 MCP 工具 schema 为准**，不保证每个模型都有四档：

| 候选值 | 在当前模型支持时的选择依据 |
| --- | --- |
| `low` | 边界明确、思考负担较低的受控任务。 |
| `high` | 边界明确，但需要推理的实现或测试任务。 |
| `off` | 明确决定不使用思考；非推理模型按工具 schema 选择。 |
| `max` | 额外推理成本有明确理由时才选择。 |

Codex 不得静默补齐缺失值，不接受 `medium` 或 `xhigh` 等别名，也不得把不支持的档位静默降为另一档。这是真实的 DSH `agent-default-model.config.reasoningEffort` 配置，不是任务中的提示词。续接时也必须重新选择，不依赖旧会话的设置。未知模型没有可核实的能力元数据时，工具只暴露 `off`；这是元数据限制，不表示该模型一定没有推理能力。不要从模型列表或名称推断它支持任意档位。

远端标准模型列表通常不包含上下文长度、输出上限或推理能力。已知模型复用本机适配器目录的元数据；未知 ID 暂按纯文本、32,768 token 上下文和 4,096 token 输出上限配置，并保留 DSH 原生上下文压缩。这些是本地配置假设，不是服务能力保证；若服务实际上限更低，请求仍可能被拒绝。API 请求始终使用你显式选择的 Base URL，不因命中模型元数据而换服务。

### 最小调用示例

下例假设当前模型的工具 schema 包含 `high`；否则应显式选择 schema 允许的档位。委派前先调用 `show_dsh_progress`，并把返回的 `progress_id` 一并传入。

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

只有进程退出码为 0、DSH 最终原因为 `completed`，且成功读取的对应回合也已持久化完成，服务才报告完成。**这只表示代理回合结束，不代表任务通过验收。** Codex 检查状态、最终 `answer`、实际 diff 并执行验收；失败时读取终止原因；原始 stderr 诊断仅保留在 UI 元数据中，模型可见的 `diagnostics` 为空。工作器声称运行了检查，不等于主代理亲自运行了检查。

### 未决问题与续接

Codex 不会实时收到中间事件；用户可在支持的客户端通过内嵌进度卡片查看进度，客户端不支持卡片或 `show_dsh_progress` 未加载时只收到最终结果。不支持途中的双向问答、交互审批、模型日志查询或单独浏览任意会话的工具，中间日志也不会进入 `delegate_to_deepseek` 结果。

1. DeepSeek 停止任务，在最终文本中报告未决问题。
2. Codex 读取结果，在已有授权内决策，必要时询问用户。
3. 上次调用返回后，Codex 用返回的 `session_id`、相同 `project_root` 和相同实际 `cwd` 续接。
4. 新调用仍须显式选择 `thinking_effort`，并提供完整续接指令和权限。

每轮新建的 `progress_id` 仅标识进度卡片；相关任务继续传入原 `session_id`。可用返回的相同会话标识与文件、递增的 `turn` 和 `assistant_seq`，以及保留的对话约定共同验收 resume。

这是多轮会话续接，不是实时对话。`--approval-policy never` 拒绝需要人工批准的操作，不是自动批准。

## 本地依赖与配置

npm 自动下载**真实、完整的本地 Harness 依赖**。不需要另行全局安装 `dsh`，不会安装桌面 App 或下载模型权重。npm 主流程不需要克隆源码，也不要求 Git 作为安装步骤。任务本身需要的工具仍须在本机可用。

```text
本机 Codex → MCP stdio → 本机 dsh-codex-desktop-mcp → 本机 DSH 子进程 → 配置的 API 服务
```

本项目不提供远程执行服务。依赖占用较大，具体磁盘占用取决于平台、依赖布局和缓存。

本地 Harness 依赖固定为 `@deepseek-ai/dsh@0.2.2-rc.1`，**模型与协议来自你的设置，不固定为 `deepseek-flash`**。DSH 仍处于 developer preview，升级时需要检查兼容性。实际任务使用官方 `headless --json` 和持久化/查询库，不以简化的 API 脚本代替完整 Harness，也不依赖 DSH Web 内部接口。

| 文件 | 用途 |
| --- | --- |
| `~/.codex/config.toml` | 注册用户级 MCP 服务器 `dsh`。 |
| `~/.codex/skills/deepseek-worker/SKILL.md` | 安装用户级委派 skill（默认路径；设置 `CODEX_HOME` 时改为 `$CODEX_HOME/skills`）。 |
| `~/.codex/AGENTS.md` | 写入全局受管理委派规则区块，保留其他用户内容与权限；重复安装不重复。 |
| `~/.dsh-mcp/.env` | 保存 API Key。 |
| `~/.dsh-mcp/settings.json` | 保存协议、Base URL、模型；不保存 API Key。 |

设置 `CODEX_HOME` 时，Codex 配置写入 `$CODEX_HOME/config.toml`，全局规则写入 `$CODEX_HOME/AGENTS.md`。`--home` 只改变 DSH 私有状态目录。私有目录权限为 `0700`，密钥和设置文件为 `0600`。MCP 配置不包含密钥或固定项目路径。

Codex 的委派 skill 位于 `$CODEX_HOME/skills/deepseek-worker/SKILL.md`（默认 `~/.codex/skills/deepseek-worker/SKILL.md`）。安装器仅在拥有现有注册且旧 skill 未被修改时迁移 `~/.agents/skills/deepseek-worker`。已定制或冲突的旧 skill 会在任何写入前停止安装，旧目录中的其他用户文件保留。

DSH 工作器只自动发现 `<project_root>/.dsh/skills` 和 `<dsh-home>/skills`（默认 `~/.dsh-mcp/skills`），不自动扫描 `.agents/skills` 或 Codex skill 目录。这是技能发现范围，不是文件读取权限边界。DSH 可按需加载自身安装的 skill（如 ponytail、asd-ste100），npm 包不包含本地用户 skill。

网络路由设置保存在 `settings.json`，不写入 DSH 私有 `.env`。桥接器读取设置后，为本次 DSH 子进程构造协议、模型和网络配置。不要把真实密钥放进项目配置、命令参数、URL、日志或截图。

安装器保留其他模型、Provider、MCP 和登录配置，保留全局 `AGENTS.md` 中受管理区块外的用户内容，也不向项目写入配置或 skill。更换密钥直接再次运行 setup，在摘要中选择修改 API Key，输入新密钥并重新测试；不需要手改私有文件。

### 更新与冲突保护

更新已安装配置仍使用同一条全局 setup 命令，不需要逐项目操作：

```sh
npx --yes --package @hzxwonder/dsh-codex-desktop-mcp@0.8.1 dsh-codex-desktop-mcp setup
```

安装器可以更新归它管理且未被修改的旧 skill 模板。若 skill 已定制，或缺少可核对的旧模板引用，安装器保留现有文件并报告冲突。先备份，再手动合并或处理冲突，不要直接覆盖定制内容。同名但不归安装器管理的 `dsh` 配置也不会被覆盖。

全局 `AGENTS.md` 中若出现不完整或重复的受管理标记，或 `AGENTS.md` 是符号链接，安装器会在任何写入前报告冲突并保留全部用户文件。正常重复安装只替换唯一的受管理区块，不会重复叠加。

npx 安装可能把服务路径记录为 npm 缓存中的绝对路径。清理缓存、移动安装目录或更换 Node 后，应重新运行 setup。

### 已保存配置，但 Codex 看不到 dsh？

把以下四层分开检查，不能用其中一层的成功替代另一层：

| 层次 | 能证明什么 | 不能证明什么 |
| --- | --- | --- |
| 凭据模型列表 | 服务返回该凭据可见的模型 | 推理成功、模型完整能力 |
| setup 真实推理测试 | 所选协议、地址、凭据和模型能完成极小请求 | MCP 已注册或 Codex App 已加载 |
| MCP 注册与 stdio 握手 | 配置可读、服务器能初始化并列出工具 | 当前 App 会话已经连接 |
| Codex 当前会话工具列表 | 该会话实际提供 `delegate_to_deepseek`（可能带服务器前缀） | 委派任务已通过验收 |

用同一用户、同一主机和同一个 `CODEX_HOME` 运行：

```sh
npx --yes --package @hzxwonder/dsh-codex-desktop-mcp@0.8.1 dsh-codex-desktop-mcp doctor
```

`doctor` 打印生效配置的位置，检查 stdio 初始化及工具目录。它不发送付费模型请求，也不读取 Desktop 的项目选择记录来推断当前会话的位置。分享输出前仍应检查本机路径等隐私，不附上 `.env`、私有登录文件、完整日志或原始任务。

若诊断通过，但本地 Codex 仍不显示 `dsh`：

1. 核对 `doctor` 返回的 `serverVersion`。旧 npx 缓存中的服务器不会因为下载了新源码就自动更新。运行你要使用的版本的 setup，更新注册路径。
2. 检查当前项目的 `.codex/config.toml` 是否覆盖用户级 `dsh` 配置。不要删除其他 Provider 或登录配置。
3. 保存工作，完整退出并重新打开 Codex。建立新会话，再检查 `/mcp` 或客户端的 MCP 状态界面。只刷新旧会话不能保证重新加载服务器。
4. 核对安装器与本地 Codex 是否使用同一用户和 `CODEX_HOME`。若仍缺失，检查本地客户端日志中 `server=dsh` 的启动状态及错误。

独立握手成功与 Desktop 实际加载是两项检查。Desktop 日志中的 `hostId=local server=dsh status=ready` 表示本地客户端报告服务器就绪；只有当前会话的工具目录才能证明该会话提供了工具。不能仅凭 `Cancelled` 就归因于 API Key 错误。

stdio MCP 不需要浏览器登录；客户端显示不支持 OAuth / Auth，通常只是此传输不提供该认证方式，不是推理密钥校验结果。

旧项目的 `.codex/config.toml` 可能覆盖新全局配置。只移除旧的受管理 `dsh` 区块，保留其他内容。对旧项目 skill 或 `AGENTS.md` 中的固定路径规则也只移除过时受管理部分。安装器不扫描或批量修改所有仓库。

## 参数参考

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `project_root` | 必填 | 本次授权的项目绝对路径。 |
| `thinking_effort` | 必填 | 从当前模型工具 schema 允许的 `off`、`low`、`high`、`max` 子集中显式选择；续接也必填。 |
| `task` | 必填 | 完整目标、上下文、允许修改的文件、限制和验收标准，最多 65536 字符。 |
| `cwd` | `.` | 根目录内的相对目录或绝对目录。 |
| `permission_mode` | `read-only` | 确需编辑时显式选择 `workspace-write`。 |
| `session_id` | 无 | 续接对应 DSH 会话。 |
| `progress_id` | 无 | `show_dsh_progress` 返回的卡片标识；每次新委派或续接都应新建卡片，日志仍只在 UI 中。 |
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
git clone https://github.com/hzxwonder/dsh-codex-desktop-mcp.git
cd dsh-codex-desktop-mcp
npm ci
npm run setup
```

`npm run setup` 同样默认使用终端。自定义私有目录使用 `npm run setup -- --home /absolute/path/to/private/dsh-home`；源码诊断命令为 `node src/cli.js doctor`。

开发检查命令为 `npm test`。协议场景运行完整 DSH，写入持久化会话并读取最终输出，但使用本地模拟 API；这不代表三家生产服务或任意代理都已通过验证。本次实际 TTY 检查覆盖隐藏密钥、失败后修改、三种协议配置及再次配置。源码验证、npm 发布、Registry 登记和 Codex 当前会话可见性是不同状态。

## 分发与参考

包页面：[npm · @hzxwonder/dsh-codex-desktop-mcp](https://www.npmjs.com/package/@hzxwonder/dsh-codex-desktop-mcp)。普通安装用户不需要登录 npm。

官方 MCP Registry 条目尚未登记。npm 发布不自动进入客户端商店。`server.json` 是分发元数据，不保证 Codex 原生商店提供与终端 setup 相同的输入流程；`isSecret` 只是客户端处理提示，不保证加密存储。

手动配置见 [examples/codex.toml](examples/codex.toml)。优先使用安装器私有文件或客户端受保护凭据存储，不把真实密钥提交到 TOML。

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [DSH Headless 凭据和 NDJSON 接口](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)
- [Codex MCP 配置](https://developers.openai.com/codex/mcp/)
- [Codex skills](https://developers.openai.com/codex/skills/)
- [MCP Registry 发布说明](https://modelcontextprotocol.io/registry/quickstart)
