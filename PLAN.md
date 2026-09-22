# pi-subagents 开发计划与验收标准

为 pi 提供与 Claude Code 语义一致的 subagent。
标准一律向 Claude Code 靠拢，Claude Code 的行为以官方文档 `sub-agents` 与 `permission-modes` 两页为准（2026-09-22 抓取）。
同时借鉴社区里验证过的做法。

## 1. 目标与范围

### 本期做

- subagent 定义文件：格式、作用域、优先级与 Claude Code 一致。
- 内置 agent：`general-purpose`、`Explore`、`Plan`。
- `agent` 工具：前台、后台、并行、嵌套、深度上限、并发上限。
- `send_message` 工具：恢复已结束的 subagent，或者给运行中的 subagent 追加指令。
- `task_stop` 工具：停止运行中的 subagent。
- fork：子 agent 继承整个对话，复用父会话的提示词缓存。
- `/subtask <任务>`：由用户直接发起 fork。
- 子 agent 的独立记录文件，恢复会话后仍可继续。
- 结果回传：最终报告、注入扫描、subagent 标记头、截断、token 入账。
- 界面：
  - 输入框下方的 subagent 面板，嵌套时显示成树。
  - 打开某个 subagent 的记录并直接和它对话。
  - 停止、清除。
- 生命周期：取消、超时、退出时有序收尾。
- 权限：继承主会话。pi 目前没有权限系统，所以子 agent 与主会话一样全部放行；主会话已加载的扩展（例如 coding-standards）在子 agent 里同样生效。

### 本期不做

- 权限模式（`permissionMode`）、权限规则、auto 分类器：后续单独做权限包，届时 subagent 接入。
- MCP 与 `mcpServers` 字段：pi 没有 MCP，后续单独做。
- `isolation: worktree`：放第二期。
- `memory` 字段：放第二期。
- `--agent` 让整个主会话以某个 agent 身份运行，以及 `initialPrompt` 字段：放第二期。
- 定义文件里的 `hooks` 字段：pi 的钩子就是扩展，没有对应物，读到时忽略并提示。
- agent teams、跨会话消息。

## 2. 前置结论（已实测，排除了全部阻碍）

探针在本机 pi 0.86.1 到 0.87.0、openai-codex provider 上运行，脚本留在会话 scratchpad。
开发与测试以 0.87.0 为准，开发依赖锁定这个版本。

1. 扩展里用 SDK 新建进程内会话可行：子会话有独立的上下文、工具和模型，父会话的记录不受影响。
2. 空子会话通过 `DefaultResourceLoader` 的 `systemPrompt` 覆盖系统提示词，实测生效；项目的 AGENTS.md 照常作为项目上下文附加。
3. 用父会话条目建的子会话会沿用父会话的系统提示词，因为 pi 把系统提示词作为条目保存在会话里；fork 利用这一点。
4. 子会话要调用 `session.bindExtensions({ mode: "print" })` 才会触发扩展的 `session_start`。绑定后 coding-standards 照常注入规范、拦下写入，子 agent 按规则修正了代码。
5. 用 `extensionsOverride` 过滤掉本扩展，就不会递归加载；`agent` 工具改用 `extensionFactories` 闭包注入子会话，嵌套的子 agent 共享同一份注册表，两层树实测正确。
6. 后台子 agent 与主 agent 同时运行互不阻塞。
7. 面板用 `setWidget` 的 `belowEditor` 组件实现，打开记录用 `ctx.ui.custom` 浮层加 `Input` 组件实现。
   - 子 agent 空闲时发 `prompt()`，运行中时发 `steer()`，主 agent 运行中也能对话。
   - 对话时子 agent 保留完整上下文。
8. fork 缓存：前缀逐字节一致时，openai-codex 实测缓存读取约 97%。
   - 把子会话的 `agent.sessionId` 设成父会话 id，11 次试验里 10 次命中。
   - 命中是服务商尽力而为，无法保证。
   - 不能把父会话 id 传给 `SessionManager.inMemory`，否则子会话 dispose 时会清理父会话的 websocket 资源。
9. 子会话必须 dispose，否则 websocket 让 `pi -p` 一直不退出。
10. 会话头部支持 `parentSession` 字段，可以标出子会话的来源。
11. faux provider 能在同一进程里同时驱动主会话和子会话，零 token，一次测试 33ms（`test/spike-faux.test.ts`）。
12. `AgentSession.dispose()` 不会触发扩展的 `session_shutdown`，这个事件只由 pi 的运行时层发出；子会话收尾必须先自己发出这个事件（带超时），再 dispose。
13. 主会话里 coding-standards 与 pi-goal 的可变状态都在工厂函数闭包里，扩展模块被父子会话共用时不会串状态；本包同样只在闭包里保存状态。

仍需在开发中确认、但不构成阻碍的点，都列在第 6 节「风险与待确认」。

## 3. 行为规格（对齐 Claude Code）

### 3.1 定义文件

- 格式：Markdown，YAML frontmatter 加正文，正文是 agent 的系统提示词。
- 作用域与优先级，同名时高者覆盖低者：
  1. `--agents` 启动参数传入的 JSON，只对本次会话有效。
  2. 项目：从当前目录向上直到仓库根，每一级的 `.pi/agents/`，离当前目录近的优先。
  3. 用户：`~/.pi/agent/agents/`。
  4. 内置：本包自带。
- 目录递归扫描，子目录不影响名字，名字只来自 `name` 字段。
- 跳过规则与 Claude Code 一致：
  - 没有 `name`：当作文档，静默跳过。
  - 开头的 `---` 不在第一行：当作没有 frontmatter，静默跳过。
  - `name` 以 `-` 开头或含 `:`：跳过并记诊断。
  - 有 `name` 没有 `description`：跳过并记诊断。
  - YAML 解析失败：跳过并记诊断。
- 诊断信息在启动时以一条 warning 通知显示，`-p` 下写到 stderr。
- 所有 agent 的 description 合计超过约 15000 token（按字符数估算）时给出警告，仍然全部加载。

字段支持：

| 字段 | 本期 | 说明 |
|---|---|---|
| `name`、`description` | 支持 | 必填 |
| `tools` | 支持 | 逗号分隔字符串或 YAML 列表；省略时继承全部可用工具；全部无法解析时启动失败，错误里列出无效条目 |
| `disallowedTools` | 支持 | 从继承或指定的列表里移除；`Bash(git push *)` 这类带说明符的条目移除整个工具 |
| `model` | 支持 | `inherit`、`provider/modelId`、pi 能解析的模型名 |
| `maxTurns` | 支持 | 到达上限后返回部分结果并标明，可用 `send_message` 继续 |
| `skills` | 支持 | 启动时注入完整 skill 内容；找不到的跳过并记诊断 |
| `background` | 支持 | 为 `true` 时总在后台运行 |
| `omitClaudeMd` | 支持 | 同时接受别名 `omitAgentsMd`；为 `true` 时不加载 AGENTS.md、CLAUDE.md 等上下文文件，也不注入 coding-standards 的常驻规范 |
| `effort` | 支持 | 映射到 pi 的 thinking level；`xhigh`、`max` 映射到模型支持的最高档 |
| `color` | 支持 | 面板与记录里的颜色，取值同 Claude Code |
| `permissionMode` | 忽略 | 权限包实现后接入；本期读到时不报错 |
| `mcpServers`、`hooks`、`memory`、`isolation`、`initialPrompt`、`experimental` | 忽略 | 读到时记一条诊断，说明本期不支持 |

### 3.2 内置 agent

| 名字 | 工具 | 上下文文件 | 模型 | 可恢复 |
|---|---|---|---|---|
| `general-purpose` | 全部可用工具 | 加载 | 继承 | 是 |
| `Explore` | 只读：`read`、`grep`、`find`、`ls`，以及 `bash` | 不加载 | 继承 | 否，一次性 |
| `Plan` | 同 Explore | 不加载 | 继承 | 否，一次性 |

- 用户或项目里同名的定义覆盖内置定义，并使用它自己的 `model`。
- Explore 与 Plan 的只读限制靠工具列表实现。它们保留 `bash` 是对齐 Claude Code「允许只读命令」；在权限包实现之前，bash 的只读性只由提示词约束。

### 3.3 `agent` 工具

参数：

- `description`：3 到 5 个词的任务简述，显示在面板上。
- `prompt`：交给子 agent 的完整任务。
- `subagent_type`：agent 名字。
  - 省略时用 `general-purpose`。
  - fork 模式开启时可以传 `fork`。
- `run_in_background`：是否后台运行。fork 模式开启时不提供这个参数，与 Claude Code 一致。
- `model`：这次调用单独指定的模型，可选。
- `name`：给子 agent 起名，可选，之后可以按名字发消息。

工具描述里列出所有可用 agent 的名字与 description，会话开始和 `/reload` 时重建。

模型解析顺序，与 Claude Code 一致：

1. 调用参数里的 `model`。
2. 定义里的 `model`，`inherit` 表示用主会话的模型。
3. 环境变量 `PI_SUBAGENT_MODEL`。
4. 主会话的模型。

解析不到时退回主会话的模型，交互模式下给出提示，写明请求的模型和实际使用的模型。

thinking level：继承主会话，定义里的 `effort` 优先。

### 3.4 前台与后台

- 前台：`agent` 工具等子 agent 完成后返回结果，执行过程通过工具的进度更新实时显示。
- 后台：`agent` 工具立即返回 agent ID 和名字；子 agent 完成后，结果以一条「自动通知」消息送回主会话。
  - 主会话空闲时，这条消息会触发新一轮。
  - 主会话运行中时，作为追加消息排队。
  - 消息标明是自动事件，不是用户发的。
- 选择前台还是后台，按下面第一条成立的规则决定：
  1. 环境变量 `PI_SUBAGENT_DISABLE_BACKGROUND=1`：前台。
  2. fork 模式开启：后台，模型不能要求前台。
  3. 定义里 `background: true`：后台。
  4. 按调用参数 `run_in_background` 决定，默认后台。
- fork 模式：
  - 交互模式默认开启，`-p` 与 RPC 默认关闭。
  - 用 `PI_FORK_SUBAGENT=1` 或 `0` 强制开关。
- 通知的送达：
  - 主会话空闲：`pi.sendMessage` 带 `triggerTurn` 立即开始新一轮。
  - 主会话运行中：以 `deliverAs: "followUp"` 排队。
  - 同一时刻完成的多个 agent，在 150ms 内合并成一条通知。
- `-p` 模式下主 agent 结束时如果还有后台子 agent 在运行，就在 `agent_end` 里等它们结束，再把通知作为追加消息送回主会话，结果不会丢。
  - 等待有上界，默认 30 分钟，环境变量 `PI_SUBAGENT_PRINT_WAIT_MS` 可改；超时后中止剩余子 agent，通知里写明超时。
  - 这是相对 Claude Code 明确做出的取舍。
  - 原因是 pi 的 `-p` 在 `agent_settled` 之后就会拆掉会话。

### 3.5 嵌套与并发

- 深度：
  - 默认最多 3 层，环境变量 `PI_SUBAGENT_MAX_DEPTH` 可改，设为 1 就不能嵌套。
  - 到达上限的子 agent 拿不到 `agent` 工具。
  - fork 在任何深度都保留 `agent` 工具，保证工具定义与父会话一致以命中缓存，调用时返回错误，不会真的派生。
- 并发：
  - 同时运行的 subagent 默认最多 20 个，环境变量 `PI_SUBAGENT_MAX_CONCURRENT` 可改。
  - 超过时 `agent` 工具报错 `Concurrent subagent limit reached`，并提示不要重试。
  - `/subtask` 和恢复运行的 subagent 占用名额，但不受上限阻挡，与 Claude Code 一致。
- 交互模式下，派出了后台子 agent 的子 agent，会等这些子 agent 的结果回来再结束自己。

### 3.6 子 agent 启动时的上下文

普通 subagent：

- 系统提示词：定义正文，加上 pi 附加的环境信息（工作目录）。不含 pi 的主系统提示词。
- 任务消息：`prompt` 参数。
- 上下文文件：与主会话加载的一致，包括 AGENTS.md 和 coding-standards 注入的规范。`omitClaudeMd`、Explore、Plan 除外。
- 预加载的 skill：`skills` 字段列出的 skill 的完整内容。
- 同级名册：列出 `main` 和本会话里所有已命名的 agent。只有子 agent 拥有 `send_message` 工具、且至少有一个其他 agent 有名字时才出现。
- 扩展：加载主会话已加载的所有扩展，本扩展除外；本扩展的工具通过闭包注入。
  - 防递归：用 `extensionsOverride` 去掉本扩展，再用 `createAgentSession` 的 `excludeTools` 去掉不该出现的工具。不能在绑定扩展之后再过滤活跃工具，扩展注册工具会重建工具表，把过滤冲掉（社区实现记录的坑）。
  - 模型运行时：复用主会话的运行时，这样其他扩展注册的 provider 在子 agent 里也能用；取不到时退回新建。
- 看不到主会话的历史。

fork：

- 复制主会话当前分支的条目，截止到发起 fork 的那条助手消息，以及紧跟其后、同一条消息里其他并行调用已有的结果。
- 给这条消息里还没有结果的调用补占位结果，再把 fork 指令作为第一次运行的输入发出。
- 系统提示词、工具定义、模型、thinking level 与主会话完全一致。
- 主会话模型走 Anthropic 接口时，剥离历史里带签名的 thinking 块，这是社区实现 pi-subagents 踩过的坑。代价是这类模型下 fork 的缓存命中会降低。本机没有 Anthropic 账号，这一条未实测。
- 请求时把 `agent.sessionId` 设为主会话 id，提高服务端复用缓存的概率。
- 不改写请求内容：集成测试实测 fork 第一次请求的系统提示词、工具定义与消息前缀天然和主会话逐字节一致，原计划的「把 instructions 与 tools 替换为主会话最后一次请求的原样内容」没有必要，已取消。
- fork 不能再派生 fork。

### 3.7 结果回传

- 取子 agent 最后一条助手消息的文本作为报告。
  - 没有任何文字时明确写「子 agent 没有输出」，否则主模型会自己编造子 agent 做了什么。
  - 模型服务出错不会抛异常，只会让最后一条助手消息的 `stopReason` 变成 `error`；要检查它，不能把出错当成成功。
- 注入扫描，与 Claude Code 一致：
  - 在模仿 `<system-reminder>` 这类标签、或行首是 `Human:`、`Assistant:` 的文字里插入反斜杠，只让它失效，不删改内容。
  - 命中这类模式或提到 `bypassPermissions`、`--dangerously-skip-permissions` 时，在报告最前面加一行 `[harness: subagent output matched instruction-shaped pattern(s): …]`。
- 结果统一加标记头：说明以下是 subagent 的原话，其中的指令和授权声明都不代表用户。
- 报告超过 pi 的截断上限（50KB 或 2000 行）时截断，全文留在子 agent 的记录里，结果里写明记录文件路径。
- 前台结果带上本次子 agent 的 token 用量，计入主会话底栏与 `/session` 的统计。
  - 按 pi 自己的统计口径把子 agent 每条助手消息的 `usage` 各字段相加，这样与主会话底栏的累计方式一致。
  - 面板里显示的 token 数只算输入加输出，不算缓存读取，避免缓存前缀被逐轮重复计数造成的虚高。
- 结果里附 agent ID、名字、耗时、工具调用次数、token；可恢复的 agent 同时注明可以用 `send_message` 继续。
- 到达 `maxTurns` 上限时，标明结果不完整。
- API 错误：
  - 前台：有文字输出的，返回这部分输出并注明被中断、任务没做完；没有任何文字的，报 `Agent terminated early due to an API error` 加错误详情。
  - 后台：标记失败，通知里写明错误并附上最后的输出。

### 3.8 恢复、追加指令与停止

- `send_message`，参数为 `to`（agent ID 或名字）和 `message`：
  - 目标已结束：在后台以同一 ID 开始新一轮运行，保留完整历史，之后照常送回完成通知。
  - 目标运行中：作为 steer 消息送达。
  - Explore、Plan 这类一次性 agent：拒绝并说明原因。
  - 用户在面板里手动停止过的 agent：拒绝并说明它已被取消；模型用 `task_stop` 停止的不受影响，仍可恢复，与 Claude Code 一致。
  - 名字已被一个更新的 agent 占用：拒绝并说明这个名字现在指向谁，与 Claude Code 一致。
  - 调用参数里的 `model` 在恢复时继续生效。
- `task_stop`，参数为 agent ID 或名字：中止运行中的 subagent，保留已经产生的输出。
- 恢复主会话（`pi --session`、`/resume`）后，之前的 subagent 仍可以用 `send_message` 继续。

### 3.9 记录持久化

- 每个子 agent 的记录写在 `~/.pi/agent/subagent-sessions/<主会话 id>/<时间戳>_<agentId>.jsonl`，文件名沿用 pi 自己的会话命名；会话头部的 `parentSession` 指向主会话记录。
- 主会话里用自定义条目记录每个 agent 的 ID、名字、类型、记录路径、状态、调用时指定的模型，随分支保存，`/tree` 切换后按分支还原。
- 主会话压缩不影响子 agent 记录。
- 子 agent 按 pi 自己的规则自动压缩上下文。
- 清理：不自动删除；在 README 里说明目录位置，由用户自行清理。
  - 这是相对 Claude Code「30 天自动清理」的取舍。
  - pi 自己的会话也不自动清理，保持一致。

### 3.10 界面

- 面板位于输入框正下方：
  - 有 subagent 时显示，第一行是 `main`，之后每个 subagent 一行。
  - 每行内容：图标、名字、状态、模型、工具调用次数、token、耗时。
  - 嵌套的缩进成树，还有后代的行标出 `(+N)`。
  - 成功完成的行立即移除，底栏提示 `/agents 查看 subagent` 30 秒。
  - 失败或被停止的行保留 30 秒。
- 打开面板：`/agents` 命令，或快捷键 `ctrl+alt+a`（不与 pi 的保留键冲突）。
- 面板导航与记录视图都用非浮层的 `ctx.ui.custom`，暂时替换输入框区域，关闭后恢复。
  - 不用浮层的原因：社区实现 @gotgenes/pi-subagents 记录过，普通模式下浮层会被合成进终端滚动历史，一次追加超过约 7 行时边框残片会永久留在历史里。
  - Claude Code 的记录视图同样占据输入区，行为一致。
- 面板组件限高，不超过视口的三分之一；没有运行中的 agent 时停止定时刷新。
- 面板里的按键与 Claude Code 一致：
  - `↑` `↓` 选择。
  - `Enter` 打开记录并可以发消息。
  - `x` 停止运行中的，或清除已结束的。
  - `Esc` 回到输入框。
- 记录视图：实时滚动显示子 agent 的消息、工具调用与结果，底部是输入框。
  - 子 agent 空闲时，输入的内容作为新一轮发送；运行中时作为 steer 发送。
  - 被手动停止过的 agent，在这里输入可以恢复它，之后模型也能再用 `send_message` 恢复它。
- RPC 模式下 `custom()` 不可用：面板退回 `setStatus` 的一行摘要，`/agents` 输出文字列表。
- `-p` 模式不显示任何界面。

### 3.11 生命周期

- 前台调用的 `signal` 被中止时（用户按 Esc），中止对应子 agent 及它的后代。
- `session_shutdown`：
  - 先停止发送通知，再中止所有运行中的子 agent，最多等 5 秒。
  - 然后对每个子会话先发出 `session_shutdown`（最多等 5 秒），再 dispose，保证子会话里的扩展能释放资源、进程能退出。
  - 本包的后台任务都登记在注册表里，这一步就是它们统一的等待入口，重复调用安全。
- 子 agent 里的异常不能拖垮主会话：统一捕获，转成失败结果。
- `/new`、`/resume` 切换会话时，旧会话的子 agent 全部收尾，不带到新会话。

### 3.12 与其他扩展的配合

- `pi.events` 广播 `subagent:start` 与 `subagent:stop`，载荷是 agent ID、类型、父 agent，对应 Claude Code 的 SubagentStart 与 SubagentStop。
- coding-standards 在子 agent 里照常生效：规范注入、写入检查、读时规则。
  - 它的收尾检查（`agent_end` 的 check-go 等）应该只在主会话运行，对齐 Claude Code「Stop hook 只在主会话结束时触发」。
  - 为此 coding-standards 需要一处小改：通过本包写在子会话里的标记识别子会话并跳过收尾检查。
  - 这一改动单独提交，单独验收。
- pi-goal 在子会话里保持无效：子会话里没有目标记录，它什么也不做。验收时确认这一点。

## 4. 架构

档位：M。
预计生产代码 1500 到 2000 行，另有测试。
不引入新的第三方依赖，只用 pi 自带的 `typebox` 和 pi-tui。

目录：

```
pi-subagents/
  package.json            pi 清单：extensions、测试脚本
  README.md
  agents/                 内置 agent 定义：general-purpose.md、Explore.md、Plan.md
  extensions/subagents/
    index.ts              组合根：注册工具、命令、快捷键、事件，装配各模块
    definitions.ts        解析 frontmatter、扫描作用域、合并优先级、字段校验，纯函数
    registry.ts           运行中与已结束 agent 的状态、父子树、名字解析、深度与并发计数
    runner.ts             创建子会话、绑定扩展、运行、收集结果与用量、中止、dispose
    fork.ts               由父会话条目构造 fork 的初始条目与请求前缀，纯函数
    report.ts             取最终报告、注入扫描、标记头、截断、错误分类，纯函数
    persistence.ts        主会话自定义条目的读写与还原，纯函数加薄 I/O
    ui/panel.ts           面板组件
    ui/transcript.ts      记录视图组件
  test/                   单元测试与集成测试
```

本次引入的抽象及理由：

- `runner.ts` 接收一个「创建模型运行时」的参数，而不是在内部直接调用 `ModelRuntime.create()`。
  - 理由：测试隔离。真实模型需要网络和账号，集成测试要换成 pi-ai 的 faux provider 覆盖错误、中止、并发分支。
  - 属于「反过度设计」第 2 步的测试隔离。
- 其余模块都是具体函数和具体类型，没有接口，没有工厂。
- 纯逻辑模块（definitions、fork、report、registry）不引用 pi 的 SDK 类型，只用本包自己的类型；SDK 类型只出现在 runner、index 和 ui 里。

## 5. 开发阶段与验收

每个阶段结束时：

- `npm test` 全部通过。
- 跑本阶段列出的验收场景，结果写进本文件末尾的「验收记录」。
- 未通过的项先修；修不了的，写明原因再进入下一阶段。

验收手段分五类，每个验收项注明用哪一类：

- 【单测】`node --test`，纯函数与注册表逻辑，不调用模型。
- 【集成】node 测试里用 SDK 加 faux provider 建主会话，并以 `extensionFactories` 加载本扩展，脚本化模型回复，零成本、可重复。
- 【E2E】真实 pi `-p`，用 `< /dev/null`，事后用报告脚本解析主会话与子 agent 的 jsonl 记录，只看产物，不看模型怎么说。
- 【RPC】`pi --mode rpc` 加脚本驱动，覆盖排队、中止、并发时序。
- 【TUI】tmux 里跑真实交互会话，`send-keys` 操作，`capture-pane` 截屏比对文字。

### P0 调研与测试基建

内容：

- 细读社区实现，记录采纳与不采纳的做法：
  - npm `pi-subagents`
  - `@gotgenes/pi-subagents`
  - pi 官方示例 `examples/extensions/subagent`
- 搭 faux provider 的集成测试基建：
  - 一个测试辅助函数，建好带本扩展的主会话。
  - 主会话与子会话共用同一个 faux 运行时，可以按顺序脚本化各自的回复。
- E2E 脚本 `test/e2e/e2e.mjs`：在临时项目里跑真实 `pi -p`，解析主会话 jsonl 与对应的子 agent 记录，逐条断言。

验收：

1. 【文档】本文件附录列出社区实现的对照表：每条采纳或不采纳的做法都写明理由。
2. 【集成】主会话脚本化回复 `agent` 调用，子会话脚本化回复 `done`，主会话收到的工具结果含 `done`。这证明 faux 能同时驱动父子会话。
   - 如果 faux 做不到，记录原因，改用真实模型的 E2E，本条标为「降级」。
3. 【E2E】报告脚本能正确解析一份手工构造的样例记录。

### P1 定义与加载

内容：`definitions.ts`、内置 agent 文件、`--agents` 参数、启动诊断、工具描述里的 agent 列表。

验收：

1. 【单测】frontmatter 解析：
   - `tools` 的逗号字符串与 YAML 列表两种写法结果相同。
   - `disallowedTools: Bash(git push *)` 移除整个 `bash`。
   - 空 `tools` 表示继承。
2. 【单测】跳过规则逐条各一个用例：
   - 缺 `name` 静默跳过。
   - `---` 不在首行静默跳过。
   - `name` 含 `:` 跳过并有诊断。
   - 缺 `description` 跳过并有诊断。
   - YAML 错误跳过并有诊断。
3. 【单测】优先级：
   - `--agents` 胜过项目，项目胜过用户，用户胜过内置。
   - 嵌套项目目录里，离 cwd 近的胜出。
   - 同名覆盖内置 `Explore` 后，使用覆盖者的 `model`。
4. 【单测】不支持的字段（`hooks`、`mcpServers` 等）产生诊断，但 agent 照常加载。
5. 【单测】description 合计超过阈值时产生警告，全部 agent 仍然加载。
6. 【E2E】在临时项目里放 `.pi/agents/reviewer.md`，运行 `pi -p "列出你能调用的 subagent 类型，只列名字"`：输出包含 `reviewer`、`general-purpose`、`Explore`、`Plan`。
7. 【E2E】`pi -p --agents '{"tmp-agent":{"description":"测试","prompt":"只回复 TMP"}}' "用 tmp-agent 执行任意任务，原样返回它的回复"`：最终输出含 `TMP`。
8. 【TUI】放一个缺 `description` 的定义文件后启动 pi：启动时出现一条 warning，写明文件路径与原因。

### P2 前台执行核心

内容：`runner.ts`、`report.ts`、前台 `agent` 工具、模型解析、上下文组装、扩展继承、token 入账、进度显示、中止。

验收：

1. 【单测】`report.ts`：
   - 注入扫描：`<system-reminder>` 被插入反斜杠。
   - 行首 `Human:` 被插入反斜杠。
   - 提到 `bypassPermissions` 时加标记行，原文不变。
   - 正常文本原样通过。
   - 超长报告截断后注明记录路径。
2. 【单测】模型解析四级顺序，各一个用例；解析失败退回主会话模型并产生提示。
3. 【集成】前台调用返回子会话最后一条助手文本，外面包着标记头；主会话里只多出这一次工具调用和结果，子会话的中间过程不进主会话。
4. 【集成】子会话脚本化成 API 错误：
   - 有部分文字：结果是部分文字加「被中断」说明。
   - 没有文字：报 `Agent terminated early due to an API error`。
5. 【集成】`maxTurns: 2` 的 agent，脚本让它连续调用工具：第 2 轮后停止，结果标明不完整，并提示可以继续。
6. 【集成】前台运行中中止主会话的工具调用：子会话收到中止并结束，注册表里的状态是 stopped，没有遗留的运行中任务。
7. 【E2E】上下文隔离：
   - 主会话先说「暗号是 BLUE-42」。
   - 再让它用 `general-purpose` 问子 agent 暗号是什么，并原样返回。
   - 子 agent 记录里没有 `BLUE-42`，它的回答表明不知道。
8. 【E2E】系统提示词与上下文文件：
   - 临时项目里放 AGENTS.md，写入标记 `PROJ-MARK`。
   - 自定义 agent 的正文写入标记 `AGENT-MARK`。
   - 用报告脚本读子 agent 第一次请求的系统提示词（本包在记录里留一份请求摘要）：同时含 `AGENT-MARK` 与 `PROJ-MARK`，不含 pi 默认开头 `You are an expert coding assistant operating inside pi`。
9. 【E2E】`omitClaudeMd: true` 与 `Explore`：同一项目里，子 agent 的系统提示词不含 `PROJ-MARK`，也不含 coding-standards 的常驻规范。
10. 【E2E】扩展继承：
    - 让子 agent 新建一个带英文注释的 `demo.go`。
    - 子 agent 记录里出现 `[coding-standards] 已拦下本次 write`。
    - 最终文件里的注释是中文。
11. 【E2E】工具限制：`tools: read` 的 agent 被要求写文件时，记录里没有任何 write 或 edit 调用，最终报告说明做不到。
12. 【E2E】token 入账：主会话 jsonl 里那次 `agent` 工具结果带 `usage`，数值等于子 agent 记录里各轮用量之和。
13. 【TUI】前台运行时，工具卡片实时显示子 agent 的当前动作与工具次数，完成后折叠成一行摘要。

### P3 后台、并行、嵌套、上限

内容：后台运行与完成通知、fork 模式开关、并行调度、深度与并发上限、嵌套等待、`-p` 下等待后台完成。

验收：

1. 【单测】注册表：
   - 深度计数：第 3 层拿不到 `agent` 工具。
   - `PI_SUBAGENT_MAX_DEPTH=1` 时第 1 层就拿不到。
   - 并发计数：满 20 时拒绝，并返回规定的错误文字。
   - 恢复和 `/subtask` 占名额，但不被上限阻挡。
2. 【单测】前台与后台的选择规则，四条规则各一个用例，外加 fork 模式开启时去掉 `run_in_background` 参数。
3. 【集成】后台调用立即返回 agent ID；子会话完成后，主会话收到一条自动通知消息，标明是自动事件，含报告与标记头；主会话空闲时这条消息触发了新一轮。
4. 【集成】主会话运行中后台子 agent 完成：通知作为追加消息在当前一轮结束后送达，没有打断当前一轮。
5. 【集成】并行：一轮里发起 3 个后台调用，3 个子会话同时处于运行状态（记录各自开始时间，彼此重叠），3 条通知都送达。
6. 【集成】嵌套等待：子 agent A 派出后台子 agent B，A 在 B 的结果回来之后才结束，主会话只收到 A 的报告。
7. 【E2E】`-p` 后台：`pi -p` 里让模型后台派一个 `sleep 5` 的子 agent，然后直接结束。进程在子 agent 完成、通知送达、主会话处理完通知之后才退出，最终输出里提到子 agent 的结果。
8. 【E2E】深度：`PI_SUBAGENT_MAX_DEPTH=2` 时让子 agent 一层层往下派，记录里只有 2 层子 agent，第 2 层没有 `agent` 工具。
9. 【RPC】并发上限：`PI_SUBAGENT_MAX_CONCURRENT=2`，一轮里发起 3 个后台调用：第 3 个工具结果是 `Concurrent subagent limit reached`，前 2 个正常完成。

### P4 恢复、追加指令、停止、持久化

内容：`send_message`、`task_stop`、记录文件、主会话条目、恢复会话后的还原、`/tree` 分支还原、名字冲突校验。

验收：

1. 【单测】`persistence.ts`：
   - 由条目还原 agent 列表。
   - 分支切换后只看到当前分支上的 agent。
   - 格式不对的条目被忽略。
2. 【单测】名字解析：
   - 同名新 agent 出现后，旧名字的发送被拒绝，错误里写明现在指向谁。
   - 用 ID 仍然能找到旧 agent。
3. 【集成】对已结束的 agent `send_message`：同一 ID 开始新一轮，历史完整（新请求里包含旧的消息），完成后送回通知。
4. 【集成】对运行中的 agent `send_message`：作为 steer 送达，子会话在下一轮前收到。
5. 【集成】对 `Explore` 发消息：拒绝，说明它是一次性的。
6. 【集成】`task_stop` 运行中的 agent：状态变为 stopped，已有输出保留；之后模型仍可以用 `send_message` 恢复它。用户在面板里手动停止的，模型的 `send_message` 被拒绝（P6 验收）。
7. 【E2E】跨重启恢复：
   - 第一次 `pi -p` 让 `general-purpose` 记住「数字是 7」并返回 agent ID。
   - 第二次 `pi -p --session <同一会话>` 让模型用 `send_message` 问这个 agent 数字是几。
   - 回答是 7，子 agent 记录文件是同一个，并且多了一轮。
8. 【E2E】记录文件位于 `~/.pi/agent/subagent-sessions/<主会话 id>/<时间戳>_<id>.jsonl`，头部 `parentSession` 指向主会话记录；`pi` 的 `/resume` 列表里不会出现子 agent 的记录。
9. 【TUI】主会话 `/compact` 之后，`/agents` 仍能打开之前的子 agent 记录，内容完整。

### P5 fork 与提示词缓存

内容：`fork.ts`、`agent` 工具的 `fork` 类型、`/subtask` 命令、请求前缀对齐、禁止再次 fork。

验收：

1. 【单测】`fork.ts`：
   - 构造的条目等于父分支截止到发起调用的助手消息。
   - 补了一条占位工具结果，并追加了 fork 指令。
   - 不含之后的条目。
2. 【集成】fork 子会话第一次请求的 instructions 与 tools，与主会话最后一次请求逐字节相等（在 `before_provider_request` 里比对）。
3. 【集成】fork 内调用 `agent`：工具存在，调用返回错误，没有新的子会话被创建。
4. 【E2E】继承上下文：主会话先说「暗号是 BLUE-42」，再 `/subtask 说出暗号`；fork 的回复含 `BLUE-42`。
5. 【E2E】缓存：
   - 主会话积累到约 10k token 后发起 5 次 fork。
   - 报告脚本输出每次 fork 第一次请求的 `cacheRead / (input + cacheRead)`。
   - 至少 4 次大于 80%。
   - 同时输出主会话连续两轮之间的命中率作为基线，写进验收记录。
6. 【TUI】`/subtask` 立即返回，fork 出现在面板里，主会话可以继续输入；fork 完成后结果作为消息出现在主会话。

### P6 界面

内容：面板组件、记录视图、`/agents`、快捷键、`x` 停止与清除、30 秒保留与底栏提示、RPC 下的退化显示。

验收全部在【TUI】里完成，终端 170 列乘 48 行，另在 100 列下复查不溢出：

1. 派出 2 个后台 agent，其中一个再派 1 个：
   - 面板第一行是 `main`，下面是 2 个子 agent，被嵌套的那个缩进在父节点下。
   - 父节点标出 `(+1)`。
   - 状态、工具次数、token 随执行实时变化（间隔 2 秒截两次屏，数字不同）。
2. `ctrl+alt+a` 与 `/agents` 都能打开面板；`↑` `↓` 移动选中行；`Esc` 回到输入框，之后键入的文字进入主输入框。
3. `Enter` 打开记录视图：
   - 能看到任务、工具调用与结果、回复。
   - 输入「再回复一次 hello」并回车后，记录里出现这条消息和子 agent 的回复 `hello`。
   - 主 agent 正在运行时重复这一步，同样成功，主 agent 不受影响。
4. 对运行中的 agent 按 `x`：它变为 stopped，行保留约 30 秒后消失。
5. 成功完成的 agent 行立即移除，底栏出现 `/agents 查看 subagent` 提示，约 30 秒后消失。
6. 含中文、emoji 的行在窄终端下不错位、不溢出（按显示宽度截断）。
7. 【RPC】面板退化为 `setStatus` 的一行摘要；`/agents` 返回文字列表。

### P7 收尾：生命周期、协作、文档、安装

内容：退出收尾、`pi.events` 广播、coding-standards 的子会话识别（单独提交）、README、安装到 `~/.pi/agent/packages/`。

验收：

1. 【集成】`session_shutdown` 时有 3 个运行中的子 agent：5 秒内全部中止并 dispose，注册表为空；第二次调用 shutdown 不报错。
2. 【TUI】有运行中的后台子 agent 时 `/quit`：进程在 5 秒内退出，没有残留的 pi 进程（`pgrep -f pi` 确认）。
3. 【E2E】`pi -p` 跑完包含子 agent 的任务后进程正常退出，退出码为 0。
4. 【集成】另一个测试扩展监听 `subagent:start` 与 `subagent:stop`，收到的次数、agent ID、父子关系与实际一致。
5. 【E2E】coding-standards 的收尾检查只在主会话运行：
   - 子 agent 写了不能编译的 Go 文件。
   - 子 agent 记录里没有 check-go 的收尾反馈。
   - 主会话结束时出现了这条反馈。
6. 【E2E】pi-goal 在子会话里无效：`/goal` 进行中派出子 agent，子 agent 记录里没有任何 pi-goal 的消息或条目。
7. 【文档】README 写明：
   - 用法与定义文件格式。
   - 字段支持表。
   - 环境变量。
   - 与 Claude Code 的全部差异及理由。
   - 记录目录与清理方式。
8. 【安装】
   - `~/.pi/agent/settings.json` 的 `packages` 加入 `packages/pi-subagents`。
   - 新开 pi 会话，启动信息的 Extensions 列表里出现 subagents，没有诊断错误。

### 手测场景

每个阶段完成后，给你一组可以自己在 pi 里跑的提示词，一个场景一段，写明预期现象，和之前 coding-standards 的做法一样。

## 6. 风险与待确认

| 项 | 影响 | 应对 | 在哪个阶段确认 |
|---|---|---|---|
| faux provider 能否同时驱动父子会话 | 集成测试是否零成本 | 不行就用真实模型的 E2E 替代，并在验收记录里标为降级 | P0 |
| 后台子 agent 的 token 无法计入主会话底栏 | 统计不全 | 在完成通知与面板里显示，README 写明 | P3 |
| `agent.sessionId` 是未写进文档的字段 | 升级后缓存命中率可能下降 | 仅影响命中率，不影响正确性；验收记录里保留命中率基线 | P5 |
| 子会话继承的第三方扩展可能在无界面环境下出错 | 子 agent 异常 | 子会话绑定为 print 模式，扩展异常统一转成失败结果 | P2 |
| 同一进程内运行，死循环的子 agent 会拖慢主会话 | 卡顿 | `maxTurns`、中止、退出收尾兜底；需要强隔离的场景留到第二期用子进程方案 | P2 |
| 快捷键 `ctrl+alt+a` 在 tmux 里需要 `extended-keys` | tmux 用户按键无效 | `/agents` 始终可用，README 写明 tmux 配置 | P6 |

## 7. 第二期

- `isolation: worktree`：`git worktree add`，子 agent 的 cwd 指向工作树，没有改动时自动清理。
- 接入权限包：`permissionMode`、后台权限请求转到主会话（机制已实测可行）、按 Claude Code 规则继承。
- `memory` 字段。
- `--agent` 与 `initialPrompt`。
- 输入 `@agent-<名字>` 时的补全与强制委派。
- 输入框为空时按 `↓` 进入面板（要包一层编辑器，需要评估与其他扩展的冲突）。
- 需要强隔离的 agent 改用子进程运行。

## 附录：社区实现对照

2026-09-22 调研了三个实现：pi 官方示例 `examples/extensions/subagent`、`@gotgenes/pi-subagents` 21.7.5、`pi-subagents` 0.70.1。

| 做法 | 结论 | 理由 |
|---|---|---|
| 防递归用 `excludeTools` 和 `extensionsOverride`，不在绑定扩展后过滤工具 | 采纳 | 扩展注册工具会重建工具表，事后过滤会被冲掉 |
| dispose 前手动发出 `session_shutdown` 并设超时 | 采纳 | dispose 不发这个事件，子会话里扩展的资源会泄漏 |
| 子 agent 继承主会话里其他扩展注册的 provider | 采纳，改为复用主会话的运行时 | 否则扩展注册的模型在子 agent 里找不到；复用比逐个重放注册更完整 |
| `-p` 模式在 `agent_end` 等后台任务结束，带上界 | 采纳 | 不等会丢结果；有上界才符合优雅退出 |
| 检查 `stopReason: "error"`，空结果显式标出 | 采纳 | 出错不抛异常，空结果会让主模型编造 |
| 面板与记录视图不用浮层 | 采纳，已改方案 | 浮层残片会永久留在终端滚动历史里 |
| 面板限高、空闲时停止刷新 | 采纳 | 避免长时间运行时占满屏幕和空转 |
| 扩展里不保留模块级可变状态 | 采纳 | 扩展模块在父子会话之间共用，状态必须放在闭包里 |
| Anthropic 模型下 fork 剥离带签名的 thinking | 采纳 | 否则请求会被拒绝 |
| 同时完成的通知合并送达 | 采纳 | 避免一次触发多轮 |
| 用 faux provider 做无网络集成测试 | 采纳 | 已实测可行 |
| 通知统一在 `agent_settled` 发出 | 不采纳 | 本包没有「主动拉取结果」的工具，不存在重复送达的问题；`-p` 下 `agent_settled` 之后会话就被拆掉 |
| 续聊只在内存里、设保留窗口 | 不采纳 | 重启后无法续聊，Claude Code 支持重启后恢复 |
| 父会话历史序列化成文本再交给子 agent | 不采纳 | 丢掉工具调用结构，不如直接复制分支条目 |
| 后台任务放进子进程 | 不采纳 | 方案定为进程内，复杂度低得多；强隔离留到第二期 |
| 懒加载工具定义、看门狗、定时任务 | 不采纳 | 超出需求 |
| 轮数到上限后先要求收尾再给宽限轮数 | 不采纳 | Claude Code 的语义是到上限即停，返回部分结果并允许续聊 |

## 验收记录

### P0（2026-09-22）

- 通过：社区对照表见上一节。
- 通过：faux 同时驱动父子会话，`test/spike-faux.test.ts`。
- 通过：E2E 脚本 `test/e2e/e2e.mjs` 已完成，改用 Node 与包本身保持同一种语言。

### P1（2026-09-22）

- 通过：单测 1 到 5（`test/definitions.test.ts`）。
- 通过：E2E 6，临时项目里的 `reviewer` 与三个内置 agent 都被列出。
- 通过：E2E 7，`--agents` 定义的 agent 被调用并原样返回标记。
- 通过：TUI 8，缺 description 的定义在启动时显示警告，写明路径与原因。

### P2（2026-09-22）

- 通过：单测 1（`test/report.test.ts`）、单测 2（`test/definitions.test.ts` 的 resolveModel 用例；收尾自检时发现原先缺这个单测，已补上）。
- 通过：集成 3 到 6（`test/foreground.test.ts`）。
- 通过：E2E 7 到 12（`isolation`、`systemPrompt`、`extensions`、`tools`、`usage`）。
  - 首轮发现内置 Explore、Plan 附加了项目 AGENTS.md，已在定义里补上 `omitClaudeMd: true`。
  - `omitClaudeMd` 的 agent 仍被注入常驻规范，已按 3.12 改 coding-standards：读到子会话标记后，`omitClaudeMd` 时不注入常驻规范；子会话里不送每轮提醒、不做收尾检查与决策留痕审计。
- 通过：TUI 13，前台运行时卡片下方实时显示工具次数、token、耗时与当前命令，完成后折叠成一行统计。

### P3（2026-09-22）

- 通过：单测 1、2（`test/registry.test.ts`、`test/background.test.ts`）。
- 通过：集成 3 到 6（`test/background.test.ts`），并行时峰值并发实测为 3。
- 通过：E2E 7、8（`printWait`、`depth`）。
- 通过：9 并发上限，改用集成测试验收（`test/background.test.ts`），结果确定且不花 token。
  - 写这个用例时发现并修复一个竞态：检查并发上限与登记记录之间隔着一次 await，同一轮并行的调用会一起通过检查。

### P4（2026-09-22）

- 通过：单测 1、2（`test/persistence.test.ts`、`test/registry.test.ts`）。
- 通过：集成 3 到 6（`test/resume.test.ts`）。
- 通过：E2E 7、8（`resumeAcrossRestart`）。
- 通过：9 主会话压缩后续聊。真实会话太小，pi 拒绝压缩，改用集成测试调用 `compact()` 验收（`test/resume.test.ts`）。

### P5（2026-09-22）

- 通过：单测 1（`test/fork.test.ts`）。
  - 写测试时发现并修复一个问题：同一条助手消息里已经有结果的并行调用，结果条目在截断点之后，原先没被带进 fork，会导致 fork 历史里出现没有结果的调用。
- 通过：集成 2、3（`test/fork-session.test.ts`），系统提示词、工具定义与消息前缀逐字节一致。
- 通过：E2E 4、5（`forkCache`）。
  - 5 个并行 fork 都看到了主会话里的暗号。
  - fork 首次请求命中率：94.6%、94.6%、94.6%、94.6%、94.6%。
  - 主会话后续轮次命中率（基线）：93.1%、0.0%、95.6%、97.9%。
- 通过：TUI 6，`/subtask` 立即返回，fork 出现在面板里，继承上下文，结果送回主会话。

### P6（2026-09-22）

TUI 验收在 tmux 里用真实 pi 完成，终端 170×48 与 100×40 两种尺寸。

- 通过：1，面板第一行是 main，嵌套的缩进挂在父节点下并标出 `(+1)`，间隔截屏数字在变化。
- 通过：2，`/agents` 与 `Ctrl+Alt+A` 都能打开导航（tmux 里 `Ctrl+Alt+A` 也可用），`↑` `↓` 与 `Esc` 正常。
- 通过：3，记录视图显示任务、工具调用与结果、回复；在输入框发消息后，已完成的 agent 带着上下文恢复并回复。
- 通过：4，`x` 停止运行中的 agent，显示为「已停止」，该行约 30 秒后消失；之后模型用 `send_message` 恢复它被拒绝。
  - 首次验收发现并修复：工具执行期间被停止的 agent 被记成「失败」。原因是后台运行没有中止信号，`prompt()` 抛出的中止错误被当成模型出错。已补复现用例。
  - 顺带修复：用户手动停止的 agent，报告里不再提示可以续聊。
- 通过：5，成功完成的行立即移除，底栏出现「/agents 查看 subagent」。
- 通过：6，100 列终端下按显示宽度测量最宽一行正好 100 列，中文按显示宽度截断并加省略号。
- 通过：7 RPC（`test/e2e/rpc.mjs`），面板退化为一行状态，`/agents` 返回文字列表，agent 结束后状态清除。
- 另外修复：界面回调抛出的异常会传进后台任务，把成功的 agent 标成失败。编排器现在吞掉界面与持久化回调的异常，已补复现用例。

### P7（2026-09-22）

- 通过：1，退出收尾时 3 个运行中的 subagent 在上限内全部关闭，重复收尾不报错（`test/lifecycle.test.ts`）。
- 通过：2，有后台 agent 运行时 `/quit`，1 秒内退出，子 agent 里的 `sleep 300` 进程也被清理，没有残留。
- 通过：3，`pi -p` 跑完包含子 agent 的任务后退出码为 0（`printWait`）。
- 通过：4，`subagent:start` 与 `subagent:stop` 的次数、agent ID 与父子关系与实际一致（`test/lifecycle.test.ts`）。
- 通过：5，收尾检查的反馈只出现在主会话结束时，子 agent 记录里没有（`stopChecksMainOnly`）。
- 通过：6，`/goal` 进行中派出的子 agent 记录里没有任何 pi-goal 的消息或条目（`goalInertInChild`）。
- 通过：7，README 写明用法、定义格式、字段表、环境变量、与 Claude Code 的全部差异、记录目录与清理方式。
- 通过：8，`pi install ./packages/pi-subagents` 登记到 `~/.pi/agent/settings.json`。
- 补充（用户要求）：skill 可用性。
  - `skillsDiscovered`：general-purpose 与 Explore 的系统提示词里都列出了项目 skill，二者都主动读取了 skill 文件并答出其中的内容。
  - `skillsPreloaded`：定义里写 `skills:` 时，skill 全文在系统提示词里，子 agent 没有调用工具就答对了。
- 类型检查：`npm run typecheck` 通过，修复了一处 `finishTurn` 返回类型不匹配。

### 全量回归（2026-09-22）

- `npm test`：66 项全部通过。
- `npm run e2e`：13 个真实 pi 场景与 RPC 场景全部通过；fork 首次请求命中率 93.2%，主会话基线 91.5% 到 97.5%。
- 重构后再跑一次全量：`forkCache` 这一轮未通过，其余全部通过。
  - 单独重跑两次都通过，fork 首次请求命中率均为 94.7%；主会话自己的基线里同样偶尔出现 0%。
  - 结论：缓存命中由服务端尽力而为，这一项会偶发失败，失败时应重跑确认，不代表 fork 的前缀出了问题。前缀逐字节一致由集成测试 `test/fork-session.test.ts` 确定性地保证。
