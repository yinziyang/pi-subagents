// subagent 的编排：派生、前台与后台运行、完成通知、续聊、停止、退出收尾。
//
// 生命周期：
//   1. spawn 解析定义、模型、工具，登记到注册表，创建子会话。
//   2. 前台：等运行结束后返回报告；后台：立即返回，运行结束后把报告作为通知送给发起方。
//   3. 子 agent 自己派出了后台子 agent 时，它在结束前会等这些结果回来，把通知作为下一轮输入继续处理，与 Claude Code 交互模式一致。
//   4. 每次运行结束就关闭子会话；续聊时从记录文件重新打开，所以重启 pi 之后也能续聊。
// 所有后台任务都登记在 tasks 里，shutdown 是它们统一的等待入口，可以重复调用。

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentSessionEvent, type ExtensionFactory, loadSkills, type ModelRuntime, type SettingsManager, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { type AgentDefinition, resolveTools } from "./definitions.ts";
import { buildForkEntries, type ForkEntry, forkDirective } from "./fork.ts";
import { AgentRegistry, type AgentRecord, MAIN_ID } from "./registry.ts";
import { addUsage, apiErrorMessage, formatReport, type RunOutcome, type UsageTotals } from "./report.ts";
import { type ChildHandle, createChild, type RunResult } from "./runner.ts";

/** 本包提供给模型的工具名。 */
export const TOOL_AGENT = "agent";
export const TOOL_SEND = "send_message";
export const TOOL_STOP = "task_stop";
export const OWN_TOOLS = [TOOL_AGENT, TOOL_SEND, TOOL_STOP];

/** 主会话没有启用时也提供给子 agent 的只读工具，对齐 Claude Code「子 agent 可以拿到主会话没有的 Glob 与 Grep」。 */
const EXTRA_READ_TOOLS = ["read", "grep", "find", "ls"];

/** 模型对象，沿用 pi 的类型，编排层只透传不解读。 */
type Model = NonNullable<Parameters<typeof createChild>[0]["model"]>;
type ThinkingLevel = NonNullable<Parameters<typeof createChild>[0]["thinkingLevel"]>;

/** 发起调用的一方（主会话或某个子 agent）在调用时刻的状态。 */
export interface Caller {
	/** MAIN_ID 或子 agent 的 ID。 */
	id: string;
	cwd: string;
	model: Model;
	thinkingLevel: ThinkingLevel;
	activeTools: string[];
	signal?: AbortSignal;
	/** 调用方当前分支的条目，fork 用。 */
	branch?: () => ForkEntry[];
	/** 调用方的会话 ID，fork 的请求沿用它以提高缓存命中。 */
	sessionId?: string;
	/** 通过 agent 工具发起时的工具调用 ID。 */
	toolCallId?: string;
}

/** agent 工具的参数。 */
export interface SpawnParams {
	description: string;
	prompt: string;
	subagent_type?: string;
	run_in_background?: boolean;
	model?: string;
	name?: string;
}

/** 工具调用的返回：给模型的文字、计入主会话的用量、界面用的细节。 */
export interface ToolReply {
	text: string;
	isError?: boolean;
	usage?: UsageTotals;
	agentId?: string;
}

export interface OrchestratorDeps {
	agentDir: string;
	env: Record<string, string | undefined>;
	getRuntime: () => Promise<ModelRuntime>;
	/** 主会话的 ID 与记录文件，子 agent 的记录放在以主会话 ID 命名的目录下。 */
	mainSession: () => { id: string; file?: string };
	/** 判断扩展路径是否是本包自己。 */
	isSelfExtension: (extensionPath: string) => boolean;
	/**
	 * 注入子会话的扩展：注册 agent、send_message、task_stop 工具。
	 * canNest 为 false 时不注册 agent；isFork 为 true 时总是注册 agent，保证工具定义与主会话一致，但禁止再派生 fork，到达深度上限时调用报错。
	 */
	childExtension: (agentId: string, canNest: boolean, isFork: boolean) => ExtensionFactory;
	/** 把通知送进主会话。 */
	notifyMain: (text: string, details: NotificationDetails) => void;
	/** 给用户看的提示，例如模型解析失败时的替换说明。 */
	warn: (message: string) => void;
	/** fork 模式是否开启。 */
	forkMode: () => boolean;
	settingsManager?: SettingsManager;
	/** 注册表变化时通知界面与持久化。 */
	onRecordChange?: (record: AgentRecord) => void;
}

/** 通知消息的结构化细节。 */
export interface NotificationDetails {
	agents: Array<{ id: string; type: string; name?: string; status: AgentRecord["status"] }>;
}

interface LiveAgent {
	handle: ChildHandle;
	/** 当前运行结束时 resolve。 */
	done: Promise<void>;
}

/** 等待送达某个子 agent 的通知（它派出的后台子 agent 的报告）。 */
interface Inbox {
	messages: string[];
	/** 有新消息时唤醒等待方。 */
	wake?: () => void;
}

export class Orchestrator {
	readonly registry: AgentRegistry;
	private agents = new Map<string, AgentDefinition>();
	private readonly live = new Map<string, LiveAgent>();
	private readonly inboxes = new Map<string, Inbox>();
	/** 所有进行中的后台运行，shutdown 时等待它们。 */
	private readonly tasks = new Set<Promise<void>>();
	/** 每个后台运行的通知对象，决定父 agent 结束前要等谁。 */
	private readonly notifyTarget = new Map<string, string>();
	private closed = false;
	private readonly deps: OrchestratorDeps;

	constructor(registry: AgentRegistry, deps: OrchestratorDeps) {
		this.registry = registry;
		this.deps = deps;
	}

	setAgents(agents: Map<string, AgentDefinition>): void {
		this.agents = agents;
	}

	definitions(): AgentDefinition[] {
		return [...this.agents.values()];
	}

	/** agent 工具：派出一个 subagent。 */
	async spawn(params: SpawnParams, caller: Caller, onProgress?: (record: AgentRecord) => void): Promise<ToolReply> {
		if (this.closed) return { text: "会话正在关闭，不能再派出 subagent。", isError: true };
		const typeName = params.subagent_type?.trim() || "general-purpose";
		if (typeName === "fork") {
			if (!this.deps.forkMode()) return { text: "fork 模式没有开启，不能派出 fork。请改用具体的 subagent 类型。", isError: true };
			return this.spawnFork({ task: params.prompt, description: params.description, name: params.name }, caller);
		}
		const def = this.agents.get(typeName);
		if (!def) return { text: `没有名为「${typeName}」的 subagent。可用的有：${[...this.agents.keys()].join("、")}`, isError: true };
		const limit = this.registry.checkSpawn();
		if (limit) return { text: limit, isError: true };
		const depth = this.registry.depthOf(caller.id) + 1;
		const canNest = this.registry.canNest(depth);

		const available = unique([...caller.activeTools.filter((t) => !OWN_TOOLS.includes(t)), ...EXTRA_READ_TOOLS, ...(canNest ? [TOOL_AGENT] : []), TOOL_SEND, TOOL_STOP]);
		const resolved = resolveTools(def, available);
		if ("error" in resolved) return { text: `subagent「${def.name}」无法启动：${resolved.error}`, isError: true };

		const runtime = await this.deps.getRuntime();
		const { model, warning } = resolveModel(params.model ?? def.model, this.deps.env.PI_SUBAGENT_MODEL, caller.model, runtime, params.model === undefined && def.model === "inherit");
		if (warning) this.deps.warn(warning);
		const background = this.decideBackground(def, params);
		const id = randomBytes(8).toString("hex");
		const record = this.registry.add({
			id,
			name: params.name?.trim() || undefined,
			type: def.name,
			description: params.description,
			parentId: caller.id,
			background,
			fork: false,
			oneShot: def.oneShot,
			model: `${model.provider}/${model.id}`,
			modelOverride: params.model,
			tools: resolved.tools,
			color: def.color,
		});
		this.changed(record);

		let handle: ChildHandle;
		try {
			handle = await createChild({
				agentId: id,
				cwd: caller.cwd,
				agentDir: this.deps.agentDir,
				runtime,
				model,
				thinkingLevel: effortToThinking(def.effort) ?? caller.thinkingLevel,
				tools: resolved.tools,
				systemPrompt: def.systemPrompt || undefined,
				appendSystemPrompt: this.preloadSkills(def, caller.cwd),
				omitContextFiles: def.omitContextFiles === true,
				source: { kind: "new", dir: this.storageDir() },
				parentSessionId: this.deps.mainSession().id,
				parentSessionFile: this.deps.mainSession().file,
				isSelfExtension: this.deps.isSelfExtension,
				extensionFactories: [this.deps.childExtension(id, this.registry.canNest(record.depth), false)],
				settingsManager: this.deps.settingsManager,
			});
		} catch (err) {
			this.finish(record, "failed", `创建子会话失败：${errText(err)}`);
			return { text: `subagent「${def.name}」无法启动：${errText(err)}`, isError: true };
		}
		this.registry.update(id, { transcriptPath: handle.transcriptPath });

		if (!background) {
			const result = await this.runToEnd(record, handle, params.prompt, def.maxTurns, caller.signal, onProgress);
			return this.reply(record, def, result);
		}
		this.startBackground(record, handle, params.prompt, def.maxTurns, caller.id);
		return { text: backgroundStarted(record), agentId: id };
	}

	/**
	 * 派出一个 fork：继承调用方到此为止的整个对话，系统提示词、工具、模型与调用方一致，总在后台运行。
	 * fromUser 为 true 表示用户用 /subtask 发起，不受并发上限阻挡，与 Claude Code 一致。
	 */
	async spawnFork(p: { task: string; description: string; name?: string }, caller: Caller, fromUser = false): Promise<ToolReply> {
		if (this.closed) return { text: "会话正在关闭，不能再派出 fork。", isError: true };
		if (this.registry.get(caller.id)?.fork) return { text: "fork 不能再派生 fork。需要委派时请改用具体的 subagent 类型。", isError: true };
		if (!fromUser) {
			const limit = this.registry.checkSpawn();
			if (limit) return { text: limit, isError: true };
		}
		const branch = caller.branch?.();
		const entries = branch && buildForkEntries(branch, { toolCallId: caller.toolCallId, newId: () => randomBytes(4).toString("hex"), now: Date.now, stripSignedThinking: caller.model.api === "anthropic-messages" });
		if (!entries) return { text: "找不到发起 fork 的那条消息，无法构造 fork 的上下文。", isError: true };
		const runtime = await this.deps.getRuntime();
		const id = randomBytes(8).toString("hex");
		const record = this.registry.add({
			id,
			name: p.name?.trim() || undefined,
			type: "fork",
			description: p.description,
			parentId: caller.id,
			background: true,
			fork: true,
			oneShot: false,
			model: `${caller.model.provider}/${caller.model.id}`,
			tools: caller.activeTools,
		});
		this.changed(record);
		let handle: ChildHandle;
		try {
			handle = await createChild({
				agentId: id,
				cwd: caller.cwd,
				agentDir: this.deps.agentDir,
				runtime,
				model: caller.model,
				thinkingLevel: caller.thinkingLevel,
				tools: caller.activeTools,
				omitContextFiles: false,
				source: { kind: "fork", dir: this.storageDir(), entries: entries as never },
				parentSessionId: this.deps.mainSession().id,
				parentSessionFile: this.deps.mainSession().file,
				isSelfExtension: this.deps.isSelfExtension,
				extensionFactories: [this.deps.childExtension(id, this.registry.canNest(record.depth), true)],
				routingSessionId: caller.sessionId,
				settingsManager: this.deps.settingsManager,
			});
		} catch (err) {
			this.finish(record, "failed", `创建 fork 失败：${errText(err)}`);
			return { text: `fork 无法启动：${errText(err)}`, isError: true };
		}
		this.registry.update(id, { transcriptPath: handle.transcriptPath });
		this.startBackground(record, handle, forkDirective(p.task), undefined, caller.id);
		return { text: backgroundStarted(record), agentId: id };
	}

	/** send_message 工具：给运行中的 agent 追加指令，或恢复已结束的 agent。 */
	async sendMessage(to: string, message: string, caller: Caller, fromUser = false): Promise<ToolReply> {
		if (this.closed) return { text: "会话正在关闭，不能再发送消息。", isError: true };
		const found = this.registry.resolve(to, caller.id);
		if ("error" in found) return { text: found.error, isError: true };
		const record = found.record;
		if (record.oneShot) return { text: `subagent「${record.type}」是一次性的，不能续聊。需要继续时请派出 general-purpose 或自定义 agent。`, isError: true };
		if (record.cancelledByUser && !fromUser) return { text: `agent ${record.id} 已被用户手动停止，不能自动恢复。`, isError: true };
		const live = this.live.get(record.id);
		if (live?.handle.isStreaming()) {
			await live.handle.steer(message);
			return { text: `消息已送达运行中的 agent ${record.name ?? record.id}，它会在当前这一轮的工具调用结束后读到。` };
		}
		if (live) await live.done;
		if (!record.transcriptPath) return { text: `agent ${record.id} 没有记录文件，无法恢复。`, isError: true };

		const def = this.agents.get(record.type);
		const runtime = await this.deps.getRuntime();
		const { model } = resolveModel(record.modelOverride ?? def?.model, this.deps.env.PI_SUBAGENT_MODEL, caller.model, runtime, record.modelOverride === undefined && def?.model === "inherit");
		let handle: ChildHandle;
		try {
			handle = await createChild({
				agentId: record.id,
				cwd: caller.cwd,
				agentDir: this.deps.agentDir,
				runtime,
				model,
				thinkingLevel: effortToThinking(def?.effort) ?? caller.thinkingLevel,
				tools: record.tools,
				omitContextFiles: def?.omitContextFiles === true,
				source: { kind: "open", path: record.transcriptPath },
				parentSessionId: this.deps.mainSession().id,
				isSelfExtension: this.deps.isSelfExtension,
				extensionFactories: [this.deps.childExtension(record.id, this.registry.canNest(record.depth), record.fork)],
				settingsManager: this.deps.settingsManager,
			});
		} catch (err) {
			return { text: `无法恢复 agent ${record.id}：${errText(err)}`, isError: true };
		}
		this.registry.update(record.id, { status: "running", endedAt: undefined, cancelledByUser: fromUser ? false : record.cancelledByUser, background: true });
		this.changed(record);
		this.startBackground(record, handle, message, def?.maxTurns, caller.id);
		return { text: `agent ${record.name ?? record.id} 已在后台恢复运行，保留了之前的完整上下文。完成后结果会以通知送回。` };
	}

	/** task_stop 工具与界面的停止：中止运行中的 agent 及其后代。 */
	async stop(to: string, caller: Caller, byUser = false): Promise<ToolReply> {
		const found = this.registry.resolve(to, caller.id);
		if ("error" in found) return { text: found.error, isError: true };
		const record = found.record;
		if (record.status !== "running") return { text: `agent ${record.id} 当前没有在运行（状态：${record.status}）。` };
		for (const r of [record, ...this.registry.descendants(record.id)]) {
			if (r.status !== "running") continue;
			this.registry.update(r.id, { cancelledByUser: byUser || r.cancelledByUser });
			await this.live.get(r.id)?.handle.abort();
		}
		return { text: `已停止 agent ${record.name ?? record.id}，它已经产生的输出保留在记录里。` };
	}

	/** 主会话里是否还有后台 agent 在运行，-p 模式据此决定是否等待。 */
	hasRunningForMain(): boolean {
		for (const [id, target] of this.notifyTarget) if (target === MAIN_ID && this.registry.get(id)?.status === "running") return true;
		return false;
	}

	/** 等主会话发起的后台 agent 全部结束，最多等 timeoutMs；超时后中止剩余的。 */
	async waitForMainTasks(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.hasRunningForMain()) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				for (const [id, target] of this.notifyTarget) if (target === MAIN_ID) await this.live.get(id)?.handle.abort();
				await this.settleTasks(5_000);
				return false;
			}
			await Promise.race([...this.tasks, sleep(Math.min(remaining, 1_000))]);
		}
		return true;
	}

	/** 退出收尾：停止通知，中止所有运行中的 agent，等后台任务结束（有上限），关闭全部子会话。可以重复调用。 */
	async shutdown(): Promise<void> {
		this.closed = true;
		await Promise.all([...this.live.values()].map((l) => l.handle.abort().catch(() => undefined)));
		await this.settleTasks(5_000);
		await Promise.all([...this.live.values()].map((l) => l.handle.close()));
		this.live.clear();
	}

	/** 目前是否已经关闭；关闭后不再接受新请求。 */
	isClosed(): boolean {
		return this.closed;
	}

	private decideBackground(def: AgentDefinition, params: SpawnParams): boolean {
		if (this.deps.env.PI_SUBAGENT_DISABLE_BACKGROUND === "1") return false;
		if (this.deps.forkMode()) return true;
		if (def.background) return true;
		return params.run_in_background !== false;
	}

	private startBackground(record: AgentRecord, handle: ChildHandle, prompt: string, maxTurns: number | undefined, target: string): void {
		this.notifyTarget.set(record.id, target);
		const task = (async () => {
			const result = await this.runToEnd(record, handle, prompt, maxTurns, undefined);
			const def = this.agents.get(record.type);
			const text = def ? this.reply(record, def, result).text : formatReportFor(record, result);
			this.deliver(target, record, text);
		})()
			.catch((err) => {
				this.finish(record, "failed", errText(err));
				this.deliver(target, record, `后台 agent ${record.id} 异常结束：${errText(err)}`);
			})
			.finally(() => {
				this.tasks.delete(task);
				this.notifyTarget.delete(record.id);
				// 父 agent 可能在等这个任务，唤醒它重新检查。
				this.inboxes.get(target)?.wake?.();
			});
		this.tasks.add(task);
	}

	/**
	 * 运行到底：执行一轮任务；如果期间派出了后台子 agent，就等它们的通知，作为下一轮输入继续，直到没有待处理的通知。
	 * 结束后关闭子会话。
	 */
	private async runToEnd(record: AgentRecord, handle: ChildHandle, prompt: string, maxTurns: number | undefined, signal: AbortSignal | undefined, onProgress?: (record: AgentRecord) => void): Promise<RunResult> {
		const liveDone = deferred();
		this.live.set(record.id, { handle, done: liveDone.promise });
		const onEvent = (e: AgentSessionEvent) => this.track(record, e, onProgress);
		const total: RunResult = { outcome: { text: "", kind: "completed" }, usage: this.registry.get(record.id)?.usage ?? record.usage, toolCalls: 0, durationMs: 0 };
		const started = Date.now();
		try {
			let input: string | undefined = prompt;
			while (input !== undefined) {
				const r = await handle.run(input, { signal, maxTurns, onEvent });
				total.outcome = r.outcome;
				total.toolCalls += r.toolCalls;
				input = r.outcome.kind === "completed" && !signal?.aborted && !this.closed ? await this.nextInboxInput(record.id) : undefined;
			}
		} finally {
			total.durationMs = Date.now() - started;
			const status = total.outcome.kind === "completed" || total.outcome.kind === "maxTurns" ? "completed" : total.outcome.kind === "aborted" ? "stopped" : "failed";
			this.finish(record, status, summaryOf(total.outcome));
			this.live.delete(record.id);
			await handle.close();
			liveDone.resolve();
		}
		return total;
	}

	/** 等这个 agent 派出的后台 agent 的通知；没有在运行的、也没有待处理的通知时返回 undefined。 */
	private async nextInboxInput(agentId: string): Promise<string | undefined> {
		const inbox = this.inbox(agentId);
		for (;;) {
			if (inbox.messages.length) return inbox.messages.splice(0).join("\n\n---\n\n");
			const waiting = [...this.notifyTarget.entries()].some(([id, target]) => target === agentId && this.registry.get(id)?.status === "running");
			if (!waiting || this.closed) return undefined;
			await new Promise<void>((resolve) => (inbox.wake = resolve));
			inbox.wake = undefined;
		}
	}

	private deliver(target: string, record: AgentRecord, text: string): void {
		if (this.closed) return;
		const note = `[自动通知] 这不是用户发来的消息。后台 subagent 已结束：\n\n${text}`;
		if (target === MAIN_ID) {
			this.deps.notifyMain(note, { agents: [{ id: record.id, type: record.type, name: record.name, status: this.registry.get(record.id)?.status ?? record.status }] });
			return;
		}
		const inbox = this.inbox(target);
		inbox.messages.push(note);
		inbox.wake?.();
	}

	private inbox(id: string): Inbox {
		let box = this.inboxes.get(id);
		if (!box) this.inboxes.set(id, (box = { messages: [] }));
		return box;
	}

	private track(record: AgentRecord, e: AgentSessionEvent, onProgress?: (record: AgentRecord) => void): void {
		const r = this.registry.get(record.id);
		if (!r) return;
		if (e.type === "tool_execution_start") {
			r.toolCalls++;
			r.activity = `${e.toolName} ${briefArgs(e.args)}`.trim();
		} else if (e.type === "message_end" && e.message.role === "assistant") {
			addUsage(r.usage, (e.message as { usage?: unknown }).usage);
			const text = textOf((e.message as { content?: unknown }).content);
			if (text) r.activity = oneLine(text);
		} else return;
		this.registry.update(r.id, {});
		this.changed(r);
		onProgress?.(r);
	}

	private finish(record: AgentRecord, status: AgentRecord["status"], summary?: string): void {
		const r = this.registry.update(record.id, { status, endedAt: Date.now(), summary });
		if (r) this.changed(r);
	}

	private changed(record: AgentRecord): void {
		this.deps.onRecordChange?.(record);
	}

	private reply(record: AgentRecord, def: AgentDefinition, result: RunResult): ToolReply {
		const r = this.registry.get(record.id) ?? record;
		const apiError = apiErrorMessage(result.outcome);
		if (apiError) return { text: apiError, isError: true, usage: r.usage, agentId: r.id };
		const text = formatReport({
			agentType: def.name,
			agentId: r.id,
			name: r.name,
			outcome: result.outcome,
			durationMs: result.durationMs,
			toolCalls: r.toolCalls,
			usage: r.usage,
			transcriptPath: r.transcriptPath,
			resumable: !r.oneShot,
			background: r.background,
		});
		return { text, usage: r.usage, agentId: r.id };
	}

	private preloadSkills(def: AgentDefinition, cwd: string): string[] | undefined {
		if (!def.skills?.length) return undefined;
		const { skills } = loadSkills({ cwd, agentDir: this.deps.agentDir, skillPaths: [], includeDefaults: true });
		const out: string[] = [];
		for (const name of def.skills) {
			const skill = skills.find((s) => s.name === name && !s.disableModelInvocation);
			if (!skill) {
				this.deps.warn(`subagent「${def.name}」要预加载的 skill「${name}」不存在或不允许模型调用，已跳过`);
				continue;
			}
			try {
				out.push(`<skill name="${skill.name}" location="${skill.filePath}">\n${stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim()}\n</skill>`);
			} catch (err) {
				this.deps.warn(`读取 skill「${name}」失败，已跳过：${errText(err)}`);
			}
		}
		return out.length ? out : undefined;
	}

	private storageDir(): string {
		return join(this.deps.agentDir, "subagent-sessions", this.deps.mainSession().id);
	}

	private async settleTasks(ms: number): Promise<void> {
		if (!this.tasks.size) return;
		await Promise.race([Promise.allSettled([...this.tasks]), sleep(ms)]);
	}
}

/**
 * 按 Claude Code 的顺序解析子 agent 的模型：调用参数、定义里的 model、PI_SUBAGENT_MODEL、调用方的模型。
 * 定义写 inherit 时直接用调用方的模型，不再看环境变量。
 * 找不到时退回调用方的模型并给出说明。
 */
export function resolveModel(spec: string | undefined, envModel: string | undefined, fallback: Model, runtime: Pick<ModelRuntime, "getModel" | "getModels">, inheritExplicit = false): { model: Model; warning?: string } {
	const wanted = spec && spec !== "inherit" ? spec : inheritExplicit ? undefined : envModel?.trim() || undefined;
	if (!wanted || wanted === "inherit") return { model: fallback };
	const slash = wanted.indexOf("/");
	let found: Model | undefined;
	if (slash > 0) found = runtime.getModel(wanted.slice(0, slash), wanted.slice(slash + 1)) as Model | undefined;
	if (!found) {
		const all = runtime.getModels() as readonly Model[];
		const matches = all.filter((m) => m.id === wanted || m.name === wanted);
		found = matches.find((m) => m.provider === fallback.provider) ?? matches[0];
	}
	if (found) return { model: found };
	return { model: fallback, warning: `找不到模型「${wanted}」，subagent 改用 ${fallback.provider}/${fallback.id}` };
}

/** Claude Code 的 effort 映射到 pi 的 thinking level；max 映射到 pi 的最高档 xhigh，实际会按模型能力再截断。 */
export function effortToThinking(effort: AgentDefinition["effort"]): ThinkingLevel | undefined {
	if (!effort) return undefined;
	return (effort === "max" ? "xhigh" : effort) as ThinkingLevel;
}

function backgroundStarted(r: AgentRecord): string {
	const who = `subagent「${r.type}」${r.name ? `（名字：${r.name}）` : ""}，agent ID：${r.id}`;
	return `已在后台启动 ${who}。它完成后，结果会以一条自动通知送回。在收到通知之前，不要自己推测或编造它的结果，也不要重复派出同样的任务；可以继续做其他不依赖它的事。`;
}

function formatReportFor(record: AgentRecord, result: RunResult): string {
	return formatReport({ agentType: record.type, agentId: record.id, name: record.name, outcome: result.outcome, durationMs: result.durationMs, toolCalls: record.toolCalls, usage: record.usage, transcriptPath: record.transcriptPath, resumable: !record.oneShot, background: true });
}

function summaryOf(o: RunOutcome): string {
	if (o.kind === "error") return `出错：${o.errorMessage}`;
	return oneLine(o.text) || "（没有输出）";
}

function briefArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	const v = a.command ?? a.path ?? a.pattern ?? a.description ?? a.to ?? Object.values(a)[0];
	return typeof v === "string" ? oneLine(v, 60) : "";
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("");
}

function oneLine(text: string, max = 80): string {
	const s = text.replace(/\s+/g, " ").trim();
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
}

