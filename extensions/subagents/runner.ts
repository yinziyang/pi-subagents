// 子 agent 会话的生命周期：创建、绑定扩展、运行一轮任务、收集结果、中止、收尾。
//
// 子会话与主会话在同一个进程里，用 pi 的 SDK 创建。几条不能破坏的约束：
//   - 模型运行时由调用方传入，通常复用主会话的，这样其他扩展注册的 provider 在子 agent 里也能用。
//   - 本扩展自身不能被子会话再次加载，否则会递归；子 agent 需要的工具由调用方通过 extensionFactories 以闭包注入。
//   - 必须先 bindExtensions，子会话里扩展的 session_start 才会触发。
//   - AgentSession.dispose() 不会触发 session_shutdown，收尾时要自己先发出这个事件（有超时），再 dispose，否则子会话里扩展的资源会泄漏、websocket 会让进程无法退出。
//   - close() 可以重复调用，只有第一次生效。

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type AgentSession,
	type AgentSessionEvent,
	CURRENT_SESSION_VERSION,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	type SessionEntry,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { countToolCalls, extractOutcome, type RunOutcome, sumUsage, type UsageTotals } from "./report.ts";

/** 子会话里写入的标记条目，其他扩展据此识别自己运行在 subagent 里。 */
export const CHILD_MARKER = "pi-subagents-child";

/** 标记条目的内容，是本包与其他扩展之间的约定。 */
export interface ChildMarker {
	/** 为 true 时不应注入常驻规范等上下文文件内容，对应定义里的 omitClaudeMd。 */
	omitContextFiles: boolean;
	/** 主会话的会话 ID。 */
	parentSessionId: string;
	agentId: string;
}

/** 给 dispose 前的 session_shutdown 留的时间上限；超时后直接 dispose，不能让收尾挂住。 */
const SHUTDOWN_TIMEOUT_MS = 5_000;

/** 子会话从哪里来。 */
export type ChildSource =
	/** 新建一个带记录文件的会话。 */
	| { kind: "new"; dir: string }
	/** 以主会话当前分支的条目为起点新建，用于 fork。 */
	| { kind: "fork"; dir: string; entries: readonly SessionEntry[] }
	/** 打开已有的记录文件，用于续聊。 */
	| { kind: "open"; path: string };

export interface ChildOptions {
	agentId: string;
	cwd: string;
	agentDir: string;
	runtime: ModelRuntime;
	model: NonNullable<Parameters<typeof createAgentSession>[0]>["model"];
	thinkingLevel?: NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"];
	/** 子 agent 可用的工具名。 */
	tools: string[];
	/** 替换 pi 默认系统提示词的定义正文；fork 与续聊时不传，沿用记录里保存的系统提示词。 */
	systemPrompt?: string;
	/** 追加在系统提示词后面的内容，例如预加载的 skill。 */
	appendSystemPrompt?: string[];
	omitContextFiles: boolean;
	source: ChildSource;
	parentSessionId: string;
	parentSessionFile?: string;
	/** 判断一个扩展是否是本包自己，这类扩展不加载进子会话。 */
	isSelfExtension: (extensionPath: string) => boolean;
	/** 注入子会话的内联扩展，例如 agent、send_message 工具。 */
	extensionFactories: ExtensionFactory[];
	/** fork 时把请求的会话 ID 设成主会话的，提高服务端复用提示词缓存的概率。 */
	routingSessionId?: string;
	/** 测试用；默认读取 agentDir 下的用户设置。 */
	settingsManager?: SettingsManager;
}

/** 一次运行的钩子。 */
export interface RunHooks {
	signal?: AbortSignal;
	/** 最多运行的轮数，到达后在这一轮结束时停止。 */
	maxTurns?: number;
	onEvent?: (event: AgentSessionEvent) => void;
}

/** 一次运行的结果，只统计这一次运行新增的消息。 */
export interface RunResult {
	outcome: RunOutcome;
	usage: UsageTotals;
	toolCalls: number;
	durationMs: number;
}

/** 一个活着的子会话。 */
export interface ChildHandle {
	readonly session: AgentSession;
	readonly transcriptPath?: string;
	/** 发送一条任务并等到这次运行结束。 */
	run(prompt: string, hooks?: RunHooks): Promise<RunResult>;
	/** 运行中追加指令，在当前一轮的工具调用结束后送达。 */
	steer(text: string): Promise<void>;
	abort(): Promise<void>;
	isStreaming(): boolean;
	/** 发出 session_shutdown 并 dispose，可以重复调用。 */
	close(): Promise<void>;
}

/** 取主会话的模型运行时；拿不到时新建一个，只能看到 auth.json 里配置的 provider。 */
export async function parentRuntime(modelRegistry: unknown): Promise<ModelRuntime> {
	// ModelRegistry 没有公开运行时，这里读它的私有字段；字段不存在时退回新建，功能不受影响，只是看不到其他扩展注册的 provider。
	const runtime = (modelRegistry as { runtime?: unknown } | undefined)?.runtime;
	if (runtime && typeof (runtime as ModelRuntime).streamSimple === "function") return runtime as ModelRuntime;
	return ModelRuntime.create();
}

/** 创建子会话并绑定扩展；失败时已创建的部分会被释放，再把错误抛给调用方。 */
export async function createChild(opts: ChildOptions): Promise<ChildHandle> {
	const loader = new DefaultResourceLoader({
		cwd: opts.cwd,
		agentDir: opts.agentDir,
		settingsManager: opts.settingsManager,
		noContextFiles: opts.omitContextFiles,
		noPromptTemplates: true,
		systemPrompt: opts.systemPrompt,
		appendSystemPrompt: opts.appendSystemPrompt,
		extensionFactories: opts.extensionFactories,
		extensionsOverride: (base) => ({ ...base, extensions: base.extensions.filter((e) => !opts.isSelfExtension(e.path)) }),
	});
	await loader.reload();

	const sessionManager = openSessionManager(opts);
	const { session } = await createAgentSession({
		cwd: opts.cwd,
		agentDir: opts.agentDir,
		modelRuntime: opts.runtime,
		model: opts.model,
		thinkingLevel: opts.thinkingLevel,
		tools: opts.tools,
		resourceLoader: loader,
		sessionManager,
		settingsManager: opts.settingsManager,
	});
	try {
		if (opts.source.kind !== "open") {
			const marker: ChildMarker = { omitContextFiles: opts.omitContextFiles, parentSessionId: opts.parentSessionId, agentId: opts.agentId };
			session.sessionManager.appendCustomEntry(CHILD_MARKER, marker);
		}
		await session.bindExtensions({ mode: "print" });
	} catch (err) {
		session.dispose();
		throw err;
	}
	if (opts.routingSessionId) (session.agent as { sessionId?: string }).sessionId = opts.routingSessionId;
	return wrap(session, sessionManager.getSessionFile());
}

function openSessionManager(opts: ChildOptions): SessionManager {
	const src = opts.source;
	if (src.kind === "open") return SessionManager.open(src.path);
	const newOptions = { id: opts.agentId, parentSession: opts.parentSessionFile };
	if (src.kind === "new") return SessionManager.create(opts.cwd, src.dir, newOptions);
	// fork：按 pi 自己 forkFrom 的格式写出会话头与分支条目，再打开这个文件。
	mkdirSync(src.dir, { recursive: true });
	const timestamp = new Date().toISOString();
	const file = join(src.dir, `${timestamp.replace(/[:.]/g, "-")}_${opts.agentId}.jsonl`);
	const header = { type: "session", version: CURRENT_SESSION_VERSION, id: opts.agentId, timestamp, cwd: opts.cwd, parentSession: opts.parentSessionFile };
	const lines = [header, ...src.entries].map((e) => JSON.stringify(e)).join("\n");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${lines}\n`, { flag: "wx" });
	return SessionManager.open(file);
}

function wrap(session: AgentSession, transcriptPath: string | undefined): ChildHandle {
	let closing: Promise<void> | undefined;
	// 当前这次运行的轮数上限与计数；finishTurn 在每一轮结束、模型还想继续时判断是否到达上限。
	let turnLimit: number | undefined;
	let turns = 0;
	let hitMaxTurns = false;
	// 本次运行期间是否收到过中止请求。
	// 后台运行没有中止信号，停止是直接调用 abort() 完成的。
	// 工具执行中被中止时 prompt() 会抛出普通错误，只看信号或消息的 stopReason 会把「被停止」误判成「失败」。
	let abortRequested = false;
	const previousFinishTurn = session.agent.finishTurn;
	session.agent.finishTurn = async (turn, signal) => {
		const decision = await previousFinishTurn?.(turn, signal);
		turns++;
		if (turnLimit !== undefined && turns >= turnLimit && turn.toolResults.length > 0 && decision?.action !== "end") {
			hitMaxTurns = true;
			return { action: "end" };
		}
		return decision;
	};

	return {
		session,
		transcriptPath,
		async run(prompt, hooks = {}) {
			const started = Date.now();
			const before = session.messages.length;
			turnLimit = hooks.maxTurns;
			turns = 0;
			hitMaxTurns = false;
			abortRequested = false;
			const unsubscribe = hooks.onEvent ? session.subscribe(hooks.onEvent) : undefined;
			const onAbort = () => void session.abort();
			hooks.signal?.addEventListener("abort", onAbort, { once: true });
			let thrown: unknown;
			try {
				if (hooks.signal?.aborted) throw new Error("aborted before start");
				await session.prompt(prompt);
			} catch (err) {
				thrown = err;
			} finally {
				hooks.signal?.removeEventListener("abort", onAbort);
				unsubscribe?.();
				turnLimit = undefined;
			}
			const messages = session.messages.slice(before);
			const aborted = hooks.signal?.aborted === true || abortRequested;
			let outcome = extractOutcome(messages, { aborted, hitMaxTurns });
			if (thrown && !aborted && outcome.kind === "completed") {
				outcome = { text: outcome.text, kind: "error", errorMessage: thrown instanceof Error ? thrown.message : String(thrown) };
			}
			return { outcome, usage: sumUsage(messages), toolCalls: countToolCalls(messages), durationMs: Date.now() - started };
		},
		async steer(text) {
			await session.steer(text);
		},
		async abort() {
			abortRequested = true;
			await session.abort();
		},
		isStreaming() {
			return session.isStreaming;
		},
		close() {
			closing ??= (async () => {
				try {
					await session.abort();
				} catch {
					// 会话可能已经空闲或已损坏，中止失败不影响后面的收尾。
				}
				await withTimeout(session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }), SHUTDOWN_TIMEOUT_MS);
				session.dispose();
			})();
			return closing;
		},
	};
}

/** 等待 p，最多等 ms 毫秒；超时或失败都正常返回，调用方继续收尾。 */
async function withTimeout(p: Promise<unknown>, ms: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([p.catch(() => undefined), new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
	} finally {
		clearTimeout(timer);
	}
}
