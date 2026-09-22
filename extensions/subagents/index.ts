// pi-subagents：为 pi 提供与 Claude Code 语义一致的 subagent。
// 本文件是组合根：装配编排器，注册工具、参数与事件，不承载编排规则。

import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadAgents } from "./definitions.ts";
import { Orchestrator } from "./orchestrator.ts";
import { AgentRegistry, limitsFromEnv, MAIN_ID } from "./registry.ts";
import { parentRuntime } from "./runner.ts";
import { registerSubagentTools } from "./tools.ts";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = resolve(EXT_DIR, "..", "..", "agents");

/** 后台 subagent 完成通知的消息类型。 */
export const NOTIFY_TYPE = "pi-subagents-notification";

/**
 * -p 模式下主 agent 结束时等待后台 subagent 的上限，默认 30 分钟。
 * 由环境变量 PI_SUBAGENT_PRINT_WAIT_MS 覆盖，单位毫秒；超时后中止剩余的 subagent。
 */
const DEFAULT_PRINT_WAIT_MS = 30 * 60_000;

export default function subagents(pi: ExtensionAPI) {
	const env = process.env;
	let ctxRef: ExtensionContext | undefined;
	let orch: Orchestrator | undefined;

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
			childExtension: (agentId, canNest) => (childPi) => registerSubagentTools(childPi, o, { callerId: agentId, canNest, forkMode: forkMode() }),
			notifyMain: (text, details) => {
				if (o.isClosed()) return;
				pi.sendMessage({ customType: NOTIFY_TYPE, content: text, display: true, details }, { deliverAs: "followUp", triggerTurn: true });
			},
			warn,
			forkMode,
		});
		return o;
	};

	pi.on("session_start", async (_event, ctx) => {
		// 会话被替换（/new、/resume）时，上一个会话的 subagent 全部收尾，不带到新会话。
		await orch?.shutdown();
		ctxRef = ctx;
		orch = createOrchestrator(ctx);
		const cliJson = pi.getFlag("agents");
		const loaded = loadAgents({ cwd: ctx.cwd, agentDir: getAgentDir(), builtinDir: BUILTIN_DIR, cliJson: typeof cliJson === "string" ? cliJson : undefined });
		orch.setAgents(loaded.agents);
		for (const d of loaded.diagnostics) warn(`${d.path}：${d.message}`);
		if (loaded.warning) warn(loaded.warning);
		registerSubagentTools(pi, orch, { callerId: MAIN_ID, canNest: true, forkMode: forkMode() });
	});

	// -p 模式在 agent_settled 之后就拆掉会话，所以要在 agent_end 里等主会话的后台 subagent 结束，结果才不会丢。
	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.hasUI || !orch?.hasRunningForMain()) return;
		const wait = Number(env.PI_SUBAGENT_PRINT_WAIT_MS);
		const done = await orch.waitForMainTasks(Number.isFinite(wait) && wait > 0 ? wait : DEFAULT_PRINT_WAIT_MS);
		if (!done) warn("等待后台 subagent 超时，剩余的已被中止");
	});

	pi.on("session_shutdown", async () => {
		await orch?.shutdown();
	});
}
