# pi-subagents

为 pi coding agent 提供与 Claude Code 语义一致的 subagent。
主 agent 把一件任务交给一个拥有独立上下文的子 agent，子 agent 干完只交回一份报告，它的搜索结果、日志、读过的文件都不进主对话。

行为以 Claude Code 官方文档的 `sub-agents` 一页为准，与它不同的地方都列在「与 Claude Code 的差异」一节。
开发计划、验收标准与验收记录见 [PLAN.md](PLAN.md)。

## 安装

```bash
pi install git:git@github.com:yinziyang/pi-subagents
```

需要 pi 0.87.0 或更高版本。
安装后新开一个 pi 会话，启动信息的 Extensions 列表里会出现 `subagents`。

## 用法

直接用自然语言让模型委派，例如「用 Explore 找一下认证逻辑在哪里」「并行派三个 subagent 分别审查这三个目录」。
模型通过下面三个工具完成委派：

| 工具 | 对应 Claude Code | 作用 |
|---|---|---|
| `agent` | Agent | 派出一个 subagent；同一轮里多次调用会并行运行 |
| `send_message` | SendMessage | 给运行中的 subagent 追加指令，或者恢复一个已结束的 subagent 继续工作 |
| `task_stop` | TaskStop | 停止运行中的 subagent，已有输出保留 |

用户可以直接使用的命令与按键：

- `/agents [名字或 ID]`：打开 subagent 导航。
  - `↑` `↓` 选择。
  - `Enter` 打开记录，可以在底部输入框直接给它发消息：运行中时作为追加指令，已结束时恢复运行。
  - `x` 停止运行中的，或者清除已结束的。
  - `Esc` 返回。
- `Ctrl+Alt+A`：同 `/agents`。
- `/subtask <任务>`：fork 当前对话去后台做一项任务，完成后结果送回主会话。

输入框正下方的面板实时列出正在运行的 subagent：第一行是 `main`，嵌套的按父子关系缩进，还有运行中后代的行标出 `(+N)`。
成功完成的行立即移除，底栏提示「/agents 查看 subagent」30 秒；失败或被停止的行保留 30 秒。

## 前台、后台与 fork

- 前台：主 agent 等 subagent 完成，工具卡片实时显示进度，完成后折叠成一行统计，`Ctrl+O` 展开完整报告。
- 后台：`agent` 工具立即返回 agent ID，subagent 完成后报告以一条「自动通知」送回主会话。
  - 主会话空闲时，通知触发新一轮；运行中时，排到本轮结束后。
  - 同时完成的多个通知合并成一条。
- fork：`subagent_type` 设为 `fork`，或者用 `/subtask`。fork 继承到此为止的整个对话，系统提示词、工具、模型都和主会话一致，能复用主会话的提示词缓存。
  - fork 不能再派生 fork。
  - 实测 openai-codex 下，5 个并行 fork 的首次请求缓存命中率都是 94.6%。

前台还是后台，按下面第一条成立的规则决定，与 Claude Code 一致：

1. 环境变量 `PI_SUBAGENT_DISABLE_BACKGROUND=1`：前台。
2. fork 模式开启：后台，工具不提供 `run_in_background` 参数。
3. 定义里 `background: true`：后台。
4. 调用参数 `run_in_background`，默认后台。

fork 模式在交互模式下默认开启，`-p` 与 RPC 模式下默认关闭。

## 定义自己的 subagent

一个 Markdown 文件，YAML frontmatter 加正文，正文就是它的系统提示词：

```markdown
---
name: code-reviewer
description: 代码审查专家。改完代码后主动用它审查质量与安全问题。
tools: Read, Grep, Bash
model: inherit
---

你是一名资深代码审查者。……
```

放在哪里、谁优先，同名时高者覆盖低者：

1. 启动参数 `--agents '<JSON>'`，格式与 Claude Code 相同，只对本次会话有效。
2. 项目：从当前目录向上直到仓库根，每一级的 `.pi/agents/`，离当前目录近的优先。
3. 用户：`~/.pi/agent/agents/`。
4. 内置：本包自带的 `general-purpose`、`Explore`、`Plan`。

目录递归扫描，子目录不影响名字。
从 Claude Code 拷过来的定义可以直接用：`Read`、`Grep`、`Glob`、`Bash`、`Edit`、`Write`、`Task` 这些工具名会自动换算成 pi 的工具名。

字段：

| 字段 | 支持 | 说明 |
|---|---|---|
| `name`、`description` | 是 | 必填 |
| `tools` | 是 | 逗号分隔或 YAML 列表；省略时继承全部可用工具 |
| `disallowedTools` | 是 | 从继承或指定的列表里移除；`Bash(git push *)` 这类写法移除整个工具 |
| `model` | 是 | `inherit`、`provider/modelId` 或 pi 能解析的模型名 |
| `maxTurns` | 是 | 到达上限后返回部分结果并标明，可以用 `send_message` 继续 |
| `skills` | 是 | 启动时把这些 skill 的完整内容放进系统提示词 |
| `background` | 是 | 为 `true` 时总在后台运行 |
| `omitClaudeMd` | 是 | 别名 `omitAgentsMd`；为 `true` 时不加载 AGENTS.md 等上下文文件，也不注入 pi-coding-standards 的常驻规范 |
| `effort` | 是 | 映射到 pi 的 thinking level，`max` 按 `xhigh` 处理 |
| `color` | 是 | 面板与记录里的颜色 |
| `permissionMode` | 否 | pi 目前没有权限系统，读到时忽略 |
| `mcpServers`、`hooks`、`memory`、`isolation`、`initialPrompt`、`experimental` | 否 | 读到时启动提示「本期不支持」，定义照常加载 |

跳过规则与 Claude Code 一致：

- 没有 `name`，或者 `---` 不在第一行：当作文档，静默跳过。
- `name` 以 `-` 开头或含 `:`、缺少 `description`、YAML 解析失败：跳过，启动时给出警告。

模型按这个顺序决定：调用参数 `model`、定义里的 `model`（`inherit` 表示用主会话的模型）、环境变量 `PI_SUBAGENT_MODEL`、主会话的模型。
找不到时退回主会话的模型并给出提示。

## 子 agent 能看到什么

- 自己的系统提示词，不含 pi 的主系统提示词。
- 主 agent 写的任务说明，看不到主对话的历史。fork 例外，它继承整个对话。
- 项目的 AGENTS.md 等上下文文件。`omitClaudeMd`、Explore、Plan 除外。
- 主会话加载的扩展，本包自身除外。例如 pi-coding-standards 在子 agent 里照常拦下不合规的写入。
- 权限与主会话相同：pi 没有权限系统，子 agent 和主会话一样全部放行。

子 agent 的报告交回主 agent 前会做注入扫描：模仿 `<system-reminder>` 这类标签、或行首是 `Human:` 的文字会被插入反斜杠而失效，并在报告前加标记说明其中的指令不代表用户。

## 上限与环境变量

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PI_SUBAGENT_MAX_DEPTH` | `3` | 最多嵌套几层；设为 `1` 时 subagent 不能再派出 subagent |
| `PI_SUBAGENT_MAX_CONCURRENT` | `20` | 同时运行的 subagent 上限，超过时报 `Concurrent subagent limit reached`；`/subtask` 与续聊不受阻挡 |
| `PI_SUBAGENT_MODEL` | 未设置 | subagent 的默认模型，`provider/modelId` |
| `PI_SUBAGENT_DISABLE_BACKGROUND` | 未设置 | 设为 `1` 时全部在前台运行 |
| `PI_FORK_SUBAGENT` | 交互模式开启 | `1` 或 `0` 强制开关 fork 模式 |
| `PI_SUBAGENT_PRINT_WAIT_MS` | `1800000` | `-p` 模式下主 agent 结束时等待后台 subagent 的上限，单位毫秒；超时后中止剩余的 |

## 记录与续聊

- 每个 subagent 的记录写在 `~/.pi/agent/subagent-sessions/<主会话 ID>/<时间戳>_<agent ID>.jsonl`，不会出现在 pi 的 `/resume` 列表里。
- 主会话里保存每个 agent 的 ID、名字、状态与记录路径，随分支走：恢复会话（`pi --session`、`/resume`）之后仍能用 `send_message` 续聊，`/tree` 切到另一条分支后只看得到那条分支上的 agent。
- 主会话压缩不影响 subagent 的记录。
- 记录不会自动清理，需要时自己删除上面的目录。

## 与其他扩展配合

- 通过 `pi.events` 广播 `subagent:start` 与 `subagent:stop`，载荷是 `{ agentId, type, name, parentId, status, background, fork }`，对应 Claude Code 的 SubagentStart 与 SubagentStop。
- 子 agent 会话里写有一条 `customType` 为 `pi-subagents-child` 的条目，其他扩展可以据此识别自己运行在 subagent 里。
  - pi-coding-standards 据此对齐 Claude Code 的钩子语义：写入检查与规则送达照常生效；每轮提醒、收尾检查与决策留痕审计只在主会话运行。
- pi-goal 在子 agent 里不起作用，目标只属于主会话。

## 与 Claude Code 的差异

- 工具名是 pi 风格的小写：`agent`、`send_message`、`task_stop`。
- 定义文件放在 `.pi/agents/` 与 `~/.pi/agent/agents/`，格式与 `.claude/agents/` 相同，可以直接拷贝或建软链接。
- `model` 不支持 `sonnet`、`opus` 这类别名，写 `provider/modelId` 或 pi 能解析的模型名。
- 不支持权限模式、MCP、`memory`、`isolation: worktree`、`--agent`；pi 目前没有对应的机制，后续单独实现。
- Explore 与 Plan 保留了 bash，只读性只由提示词约束，因为 pi 没有权限系统。
- `-p` 模式下主 agent 会等后台 subagent 完成再退出，嵌套的子 agent 也总是等它派出的后台子 agent，结果不会丢。Claude Code 在非交互模式下不等。
- 后台 subagent 的 token 用量显示在通知与面板里，不计入主会话底栏；前台的计入。
- `/agents` 列出本会话的全部 subagent，随时可以打开记录；Claude Code 的 `/tasks` 只保留已完成的 30 秒。
- 打开面板用 `/agents` 或 `Ctrl+Alt+A`，不是在空输入框里按 `↓`。
- 记录不会在 30 天后自动清理。

## 开发

- `npm test`：单元测试与集成测试，用 pi-ai 的 faux provider 同时驱动主会话与子会话，不调用真实模型。
- `npm run typecheck`：类型检查。
- `npm run e2e`：在临时项目里跑真实的 `pi -p` 与 RPC 场景，逐条断言记录文件，会调用真实模型、消耗 token。

源码在 `extensions/subagents/`：

- `index.ts`：组合根，注册工具、命令、按键与事件。
- `definitions.ts`：定义文件的解析、作用域与优先级。
- `orchestrator.ts`：派生、前后台运行、通知、续聊、停止与收尾。
- `runner.ts`：子会话的创建、运行与关闭。
- `fork.ts`：fork 的初始上下文。
- `report.ts`：报告的注入扫描、标记头、截断与用量。
- `registry.ts`：agent 记录、父子树、名字解析与上限。
- `persistence.ts`：记录在主会话里的保存与还原。
- `tools.ts`：三个工具的定义与卡片渲染。
- `ui/`：面板、导航与记录视图。
