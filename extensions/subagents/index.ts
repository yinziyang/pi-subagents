// pi-subagents：为 pi 提供与 Claude Code 语义一致的 subagent。
// 本文件是组合根：装配编排器，注册工具、参数与事件，不承载编排规则。

import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadAgents } from "./definitions.ts";
import { type NotificationDetails, Orchestrator } from "./orchestrator.ts";
import { persistKey, RECORD_ENTRY, restoreRecords, toEntryData } from "./persistence.ts";
import { AgentRegistry, type AgentRecord, limitsFromEnv, MAIN_ID } from "./registry.ts";
import { parentRuntime } from "./runner.ts";
import { registerSubagentTools } from "./tools.ts";
import { AgentNavigator } from "./ui/navigator.ts";
import { AgentPanel } from "./ui/panel.ts";
import { isVisible, navigatorOrder, rowParts } from "./ui/rows.ts";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = resolve(EXT_DIR, "..", "..", "agents");

/** 后台 subagent 完成通知的消息类型。 */
export const NOTIFY_TYPE = "pi-subagents-notification";

/**
 * -p 模式下主 agent 结束时等待后台 subagent 的上限，默认 30 分钟。
 * 由环境变量 PI_SUBAGENT_PRINT_WAIT_MS 覆盖，单位毫秒；超时后中止剩余的 subagent。
 */
const DEFAULT_PRINT_WAIT_MS = 30 * 60_000;

/** 同一时刻完成的多个 subagent 的通知在这段时间内合并成一条，避免一次触发多轮。 */
const NOTIFY_BATCH_MS = 150;

/** subagent 成功完成后，底栏提示「/agents 查看」的时长，与 Claude Code 一致。 */
const HINT_MS = 30_000;

const WIDGET_KEY = "pi-subagents";

/** 广播给其他扩展的事件名，经 pi.events 发出。 */
export const EVENT_START = "subagent:start";
export const EVENT_STOP = "subagent:stop";

/** subagent:start 与 subagent:stop 的载荷。 */
export interface SubagentEvent {
	agentId: string;
	type: string;
	name?: string;
	/** 父 agent 的 ID，主会话为 "main"。 */
	parentId: string;
	status: AgentRecord["status"];
	background: boolean;
	fork: boolean;
}

export default function subagents(pi: ExtensionAPI) {
	const env = process.env;
	let ctxRef: ExtensionContext | undefined;
	let orch: Orchestrator | undefined;
	let pending: Array<{ text: string; details: NotificationDetails }> = [];
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	/** 每个 agent 上次写入主会话时的关键字段，没变就不再写。 */
	const persisted = new Map<string, string>();
	/** 用户在面板里清除过的 agent，只影响显示。 */
	let dismissed = new Set<string>();
	let requestRender: (() => void) | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let hintTimer: ReturnType<typeof setTimeout> | undefined;
	const lastStatus = new Map<string, string>();

	/** 有运行中或还在保留期的行时每秒刷新一次，好让耗时与保留期到点消失；没有时停下。 */
	const ensureTicker = () => {
		const active = () => !!orch && orch.registry.list().some((r) => isVisible(r, Date.now(), dismissed));
		if (ticker || !active()) return;
		ticker = setInterval(() => {
			requestRender?.();
			if (!active()) {
				clearInterval(ticker);
				ticker = undefined;
			}
		}, 1_000);
		ticker.unref?.();
	};

	/** 界面跟随注册表变化：交互模式刷新面板，RPC 模式更新一行状态。 */
	const onRegistryChange = () => {
		const ctx = ctxRef;
		if (!ctx || !orch) return;
		if (ctx.mode === "tui") {
			requestRender?.();
			ensureTicker();
		} else if (ctx.mode === "rpc") {
			const running = orch.registry.list().filter((r) => r.status === "running").length;
			ctx.ui.setStatus(WIDGET_KEY, running ? `subagents：${running} 个运行中` : undefined);
		}
	};

	/**
	 * 状态变化时的旁路动作：
	 *   - 进入运行中（含续聊恢复）时广播 subagent:start，离开运行中时广播 subagent:stop，对应 Claude Code 的 SubagentStart、SubagentStop，供其他扩展订阅。
	 *   - 刚成功完成时在底栏提示可以用 /agents 查看，30 秒后消失。
	 */
	const onTransition = (record: AgentRecord) => {
		const before = lastStatus.get(record.id);
		const status = record.status;
		lastStatus.set(record.id, status);
		if (before === status) return;
		const payload: SubagentEvent = { agentId: record.id, type: record.type, name: record.name, parentId: record.parentId, status, background: record.background, fork: record.fork };
		if (status === "running") pi.events.emit(EVENT_START, payload);
		else if (before === "running") pi.events.emit(EVENT_STOP, payload);
		const ctx = ctxRef;
		if (before !== "running" || status !== "completed" || ctx?.mode !== "tui") return;
		ctx.ui.setStatus(WIDGET_KEY, "/agents 查看 subagent");
		clearTimeout(hintTimer);
		hintTimer = setTimeout(() => ctxRef?.ui.setStatus(WIDGET_KEY, undefined), HINT_MS);
		hintTimer.unref?.();
	};

	/** 把缓冲的通知作为一条消息送进主会话：空闲时立即开始新一轮，运行中时排到本轮结束后。 */
	const flushNotifications = () => {
		clearTimeout(flushTimer);
		flushTimer = undefined;
		const batch = pending.splice(0);
		if (!batch.length) return;
		const content = batch.map((b) => b.text).join("\n\n---\n\n");
		const details: NotificationDetails = { agents: batch.flatMap((b) => b.details.agents) };
		pi.sendMessage({ customType: NOTIFY_TYPE, content, display: true, details }, { deliverAs: "followUp", triggerTurn: true });
	};

	pi.registerFlag("agents", { description: "以 JSON 定义只在本次会话有效的 subagent，格式同 Claude Code 的 --agents", type: "string" });

	/** fork 模式：交互模式默认开启，-p 与 RPC 默认关闭；PI_FORK_SUBAGENT 可强制开关。 */
	const forkMode = (): boolean => {
		if (env.PI_FORK_SUBAGENT === "1") return true;
		if (env.PI_FORK_SUBAGENT === "0") return false;
		return ctxRef?.mode === "tui";
	};

	const warn = (message: string) => {
		if (ctxRef?.hasUI) ctxRef.ui.notify(`[subagents] ${message}`, "warning");
		else console.error(`[pi-subagents] ${message}`);
	};

	const createOrchestrator = (ctx: ExtensionContext): Orchestrator => {
		const o: Orchestrator = new Orchestrator(new AgentRegistry(limitsFromEnv(env)), {
			agentDir: getAgentDir(),
			env,
			getRuntime: () => parentRuntime(ctx.modelRegistry),
			mainSession: () => ({ id: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile() }),
			isSelfExtension: (p) => resolve(p).startsWith(EXT_DIR + sep),
			childExtension: (agentId, canNest, isFork) => (childPi) => registerSubagentTools(childPi, o, { callerId: agentId, canNest, forkMode: forkMode(), isFork }),
			notifyMain: (text, details) => {
				if (o.isClosed()) return;
				pending.push({ text, details });
				flushTimer ??= setTimeout(flushNotifications, NOTIFY_BATCH_MS);
			},
			warn,
			forkMode,
			onRecordChange: (record) => {
				onTransition(record);
				const key = persistKey(record);
				if (persisted.get(record.id) === key) return;
				persisted.set(record.id, key);
				try {
					pi.appendEntry(RECORD_ENTRY, toEntryData(record));
				} catch {
					// 会话已被替换或正在关闭时写入会失败；这时记录只影响恢复会话后的续聊，丢了不影响当前运行。
				}
			},
		});
		return o;
	};

	pi.on("session_start", async (_event, ctx) => {
		// 会话被替换（/new、/resume）时，上一个会话的 subagent 全部收尾，不带到新会话。
		await orch?.shutdown();
		ctxRef = ctx;
		orch = createOrchestrator(ctx);
		persisted.clear();
		lastStatus.clear();
		dismissed = new Set();
		for (const r of restoreRecords(ctx.sessionManager.getBranch())) {
			orch.registry.restore(r);
			persisted.set(r.id, persistKey(orch.registry.get(r.id) ?? r));
		}
		const cliJson = pi.getFlag("agents");
		const loaded = loadAgents({ cwd: ctx.cwd, agentDir: getAgentDir(), builtinDir: BUILTIN_DIR, cliJson: typeof cliJson === "string" ? cliJson : undefined });
		orch.setAgents(loaded.agents);
		for (const d of loaded.diagnostics) warn(`${d.path}：${d.message}`);
		if (loaded.warning) warn(loaded.warning);
		registerSubagentTools(pi, orch, { callerId: MAIN_ID, canNest: true, forkMode: forkMode() });
		orch.registry.onChange(onRegistryChange);
		if (ctx.mode === "tui") {
			const registry = orch.registry;
			ctx.ui.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					requestRender = () => tui.requestRender();
					return new AgentPanel(tui, theme, registry, dismissed);
				},
				{ placement: "belowEditor" },
			);
		}
	});

	const mainCaller = (ctx: ExtensionContext) => ({ id: MAIN_ID, cwd: ctx.cwd, model: ctx.model as NonNullable<ExtensionContext["model"]>, thinkingLevel: pi.getThinkingLevel(), activeTools: pi.getActiveTools() });

	/** 打开 subagent 导航；非交互模式下退回文字列表。 */
	const openNavigator = async (ctx: ExtensionContext, initial?: string) => {
		const o = orch;
		if (!o) return;
		if (ctx.mode !== "tui") {
			const now = Date.now();
			const list = navigatorOrder(o.registry.list(), dismissed).map((r) => {
				const p = rowParts(r, now);
				return `${p.icon} ${p.title} ${r.id} ${p.status} · ${p.stats} · ${p.activity}`;
			});
			const text = list.length ? list.join("\n") : "本会话还没有派出过 subagent。";
			if (ctx.hasUI) ctx.ui.notify(text, "info");
			else console.log(text);
			return;
		}
		const initialId = initial ? o.registry.list().find((r) => r.id === initial || r.name === initial)?.id : undefined;
		let unsubscribe: (() => void) | undefined;
		let refresh: ReturnType<typeof setInterval> | undefined;
		try {
			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				unsubscribe = o.registry.onChange(() => tui.requestRender());
				// 记录文件在子 agent 运行时持续追加，每秒重画一次好让记录视图跟上。
				refresh = setInterval(() => tui.requestRender(), 1_000);
				refresh.unref?.();
				return new AgentNavigator(tui, theme, {
					registry: o.registry,
					dismissed,
					initialId,
					stop: async (id) => (await o.stop(id, mainCaller(ctx), true)).text,
					send: async (id, text) => (await o.sendMessage(id, text, mainCaller(ctx), true)).text,
				}, () => done());
			});
		} finally {
			unsubscribe?.();
			clearInterval(refresh);
			requestRender?.();
		}
	};

	pi.registerCommand("agents", {
		description: "查看本会话的 subagent，打开某个 agent 的记录并直接给它发消息",
		handler: async (args, ctx) => openNavigator(ctx, args.trim() || undefined),
	});
	pi.registerShortcut("ctrl+alt+a", { description: "打开 subagent 面板", handler: async (ctx) => openNavigator(ctx) });

	// /subtask：用户直接 fork 当前对话去做一项任务，不受并发上限阻挡，与 Claude Code 一致。
	pi.registerCommand("subtask", {
		description: "fork 当前对话，在后台执行一项任务，完成后结果送回主会话",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!orch || !ctx.model) return;
			if (!task) {
				if (ctx.hasUI) ctx.ui.notify("用法：/subtask <任务>", "warning");
				return;
			}
			const reply = await orch.spawnFork({ task, description: task.slice(0, 40) }, { id: MAIN_ID, cwd: ctx.cwd, model: ctx.model, thinkingLevel: pi.getThinkingLevel(), activeTools: pi.getActiveTools(), branch: () => ctx.sessionManager.getBranch() as never, sessionId: ctx.sessionManager.getSessionId() }, true);
			if (ctx.hasUI) ctx.ui.notify(reply.text, reply.isError ? "error" : "info");
			else if (reply.isError) console.error(`[pi-subagents] ${reply.text}`);
		},
	});

	// /tree 切到另一条分支后，已结束的 agent 按那条分支还原；运行中的不受影响。
	pi.on("session_tree", (_event, ctx) => {
		orch?.registry.syncFinished(restoreRecords(ctx.sessionManager.getBranch()));
	});

	// -p 模式在 agent_settled 之后就拆掉会话，所以要在 agent_end 里等主会话的后台 subagent 结束，结果才不会丢。
	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.hasUI || !orch) return;
		if (orch.hasRunningForMain()) {
			const wait = Number(env.PI_SUBAGENT_PRINT_WAIT_MS);
			const done = await orch.waitForMainTasks(Number.isFinite(wait) && wait > 0 ? wait : DEFAULT_PRINT_WAIT_MS);
			if (!done) warn("等待后台 subagent 超时，剩余的已被中止");
		}
		// 必须在 agent_end 里当场送出，等定时器触发时 -p 的会话可能已经拆掉了。
		flushNotifications();
	});

	pi.on("session_shutdown", async () => {
		clearTimeout(flushTimer);
		flushTimer = undefined;
		pending = [];
		clearInterval(ticker);
		ticker = undefined;
		clearTimeout(hintTimer);
		requestRender = undefined;
		await orch?.shutdown();
	});
}
