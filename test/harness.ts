// 集成测试辅助：用 faux provider 建一个加载了本扩展的主会话，主会话与所有子会话共用同一个 faux 运行时。
// 回复由 route 函数按请求内容决定，据系统提示词区分请求来自哪个会话。

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import subagents from "../extensions/subagents/index.ts";

export { fauxAssistantMessage, fauxText, fauxToolCall };

/** 一次模型请求，route 据此决定回复。 */
export interface Request {
	/** 系统消息序列化后的文本，用来区分会话。 */
	system: string;
	messages: any[];
	last: any;
	/** 最后一条用户消息的文字。 */
	lastUser: string;
	/** 这次请求的中止信号，模拟真实 provider 响应中止。 */
	signal?: AbortSignal;
}

export interface Harness {
	dir: string;
	cwd: string;
	agentDir: string;
	session: any;
	/** 所有请求，按到达顺序。 */
	requests: Request[];
	prompt(text: string): Promise<void>;
	close(): Promise<void>;
}

export interface HarnessOptions {
	route: (req: Request) => any;
	env?: Record<string, string>;
	/** 写进 cwd/.pi/agents/ 的定义文件，键为文件名。 */
	agents?: Record<string, string>;
}

const systemOf = (messages: any[]) => {
	const sys = messages.find((m) => m.role === "system");
	return sys ? JSON.stringify({ content: sys.content, sections: sys.sections }) : "";
};

const textOf = (m: any) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(""));

export async function makeHarness(opts: HarnessOptions): Promise<Harness> {
	const dir = mkdtempSync(join(tmpdir(), "pisub-it-"));
	const cwd = join(dir, "project");
	const agentDir = join(dir, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	// 关掉自动重试，模型出错的用例才不会等退避。
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
	for (const [file, content] of Object.entries(opts.agents ?? {})) {
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "agents", file), content);
	}

	const saved: Record<string, string | undefined> = {};
	const env = { PI_CODING_AGENT_DIR: agentDir, PI_FORK_SUBAGENT: "0", ...opts.env };
	for (const [k, v] of Object.entries(env)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}

	const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	runtime.registerNativeProvider(faux.provider);
	const model = runtime.getModel("faux", "m") ?? faux.getModel();
	const requests: Request[] = [];
	const step = (context: any, options: any) => {
		const messages = context.messages;
		const users = messages.filter((m: any) => m.role === "user");
		const req: Request = { system: systemOf(messages), messages, last: messages[messages.length - 1], lastUser: textOf(users[users.length - 1]), signal: options?.signal };
		requests.push(req);
		return opts.route(req);
	};
	faux.setResponses(Array.from({ length: 500 }, () => step));

	const loader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [subagents] });
	await loader.reload();
	const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, resourceLoader: loader, sessionManager: SessionManager.create(cwd, join(agentDir, "sessions")) });
	await session.bindExtensions({ mode: "print" });

	return {
		dir,
		cwd,
		agentDir,
		session,
		requests,
		async prompt(text) {
			await session.prompt(text);
			await session.agent.waitForIdle();
		},
		async close() {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		},
	};
}

/** 请求是否来自内置 general-purpose 子 agent。 */
export const isGeneralPurpose = (req: Request) => req.system.includes("委派任务的子 agent");
/** 请求是否来自主会话（pi 默认系统提示词）。 */
export const isMain = (req: Request) => req.system.includes("You are an expert coding assistant operating inside pi");

export const text = (t: string) => fauxAssistantMessage(fauxText(t));
export const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

/** 最后一条消息是不是某个工具的结果。 */
export const lastToolResult = (req: Request) => (req.last?.role === "toolResult" ? req.last : undefined);
export const resultText = (m: any) => textOf(m);
