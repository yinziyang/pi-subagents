import assert from "node:assert/strict";
import { test } from "node:test";
import { call, fauxAssistantMessage, fauxText, isGeneralPurpose, isMain, lastToolResult, makeHarness, notifications, resultText, text, waitFor } from "./harness.ts";

const bg = (prompt: string, extra: Record<string, unknown> = {}) => call("agent", { description: "后台任务", prompt, ...extra });
const toolCall = (name: string, args: Record<string, unknown>, id: string) => ({ type: "toolCall", id, name, arguments: args }) as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isNotification = (m: any) => m?.role === "custom" || (m?.role === "user" && JSON.stringify(m.content).includes("[自动通知]"));

test("后台（交互模式）：立即返回 agent ID，完成后通知送回主会话，主会话空闲时触发新一轮", async () => {
	let release: (() => void) | undefined;
	const h = await makeHarness({
		ui: true,
		route: async (req) => {
			if (isGeneralPurpose(req)) {
				await new Promise<void>((r) => (release = r));
				return text("bg-report");
			}
			if (isNotification(req.last)) return text("收到通知后的回复");
			if (lastToolResult(req)) return text("先回复用户，等通知");
			return bg("后台做事");
		},
	});
	try {
		await h.prompt("开始");
		const tr = (h.session.messages as any[]).find((m) => m.role === "toolResult");
		assert.match(resultText(tr), /^已在后台启动 subagent「general-purpose」，agent ID：[0-9a-f]{16}/);
		assert.equal(notifications(h.session).length, 0, "子 agent 还没结束");
		await waitFor(() => !!release, 5_000, "子 agent 开始");
		release?.();
		await waitFor(() => notifications(h.session).length === 1, 5_000, "通知");
		await waitFor(() => h.requests.some((r) => isMain(r) && isNotification(r.last)), 5_000, "通知触发新一轮");
		const note = notifications(h.session)[0];
		assert.match(resultText(note), /^\[自动通知\] 这不是用户发来的消息/);
		assert.match(resultText(note), /<subagent_report>\nbg-report\n<\/subagent_report>/);
		assert.equal(note.details.agents[0].status, "completed");
		await h.session.agent.waitForIdle();
	} finally {
		await h.close();
	}
});

test("后台：主会话运行中时完成，通知排到本轮结束后送达，不打断当前一轮", async () => {
	const h = await makeHarness({
		ui: true,
		route: async (req) => {
			if (isGeneralPurpose(req)) return text("fast-report");
			if (isNotification(req.last)) return text("处理通知");
			if (lastToolResult(req)?.toolName === "agent") {
				// 子 agent 在主会话这一轮的后续工具执行期间就会完成。
				await sleep(300);
				return fauxAssistantMessage(toolCall("ls", { path: "." }, "ls1"), { stopReason: "toolUse" });
			}
			if (lastToolResult(req)?.toolName === "ls") return text("本轮结束");
			return bg("很快的任务");
		},
	});
	try {
		await h.prompt("开始");
		await waitFor(() => notifications(h.session).length === 1, 5_000, "通知");
		await h.session.agent.waitForIdle();
		const roles = (h.session.messages as any[]).map((m) => (m.role === "custom" ? "notify" : m.role === "assistant" ? `assistant:${resultText(m) || "tool"}` : m.role));
		const end = roles.indexOf("assistant:本轮结束");
		const notify = roles.indexOf("notify");
		assert.ok(end >= 0 && notify > end, `通知在本轮结束之后：${roles.join(" > ")}`);
	} finally {
		await h.close();
	}
});

test("并行：一轮里发起 3 个后台调用，3 个子 agent 同时运行，通知合并送达", async () => {
	let inFlight = 0;
	let peak = 0;
	const h = await makeHarness({
		ui: true,
		route: async (req) => {
			if (isGeneralPurpose(req)) {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await sleep(100);
				inFlight--;
				return text(`report-${req.lastUser}`);
			}
			if (isNotification(req.last)) return text("全部收到");
			if (lastToolResult(req)) return text("已派出");
			return fauxAssistantMessage(["a", "b", "c"].map((p, i) => toolCall("agent", { description: `任务${p}`, prompt: p }, `c${i}`)), { stopReason: "toolUse" });
		},
	});
	try {
		await h.prompt("开始");
		await waitFor(() => notifications(h.session).reduce((n, m) => n + m.details.agents.length, 0) === 3, 5_000, "3 个通知");
		assert.equal(peak, 3, "3 个子 agent 同时在请求模型");
		const all = notifications(h.session).map(resultText).join("\n");
		for (const p of ["a", "b", "c"]) assert.match(all, new RegExp(`report-${p}`));
		assert.ok(notifications(h.session).length < 3, "同时完成的通知被合并");
		await h.session.agent.waitForIdle();
	} finally {
		await h.close();
	}
});

test("嵌套等待：子 agent A 派出后台子 agent B，A 等 B 的结果回来才结束，主会话只收到 A 的报告", async () => {
	const h = await makeHarness({
		agents: { "lead.md": "---\nname: lead\ndescription: 负责分派\n---\nLEAD-MARK\n" },
		route: async (req) => {
			if (req.system.includes("LEAD-MARK")) {
				if (isNotification(req.last) || JSON.stringify(req.last?.content ?? "").includes("[自动通知]")) return text("A-final：已汇总 B 的结果");
				if (lastToolResult(req)) return text("dispatched");
				return bg("B 的任务");
			}
			if (isGeneralPurpose(req)) {
				await sleep(100);
				return text("B-result");
			}
			if (lastToolResult(req)) return text("main-final");
			return call("agent", { description: "分派", prompt: "去分派", subagent_type: "lead", run_in_background: false });
		},
	});
	try {
		await h.prompt("开始");
		const tr = (h.session.messages as any[]).find((m) => m.role === "toolResult");
		const body = resultText(tr);
		assert.match(body, /subagent「lead」/);
		assert.match(body, /A-final：已汇总 B 的结果/);
		assert.equal(notifications(h.session).length, 0, "B 的通知没有送到主会话");
		const leadSawB = h.requests.some((r) => r.system.includes("LEAD-MARK") && JSON.stringify(r.messages).includes("B-result"));
		assert.ok(leadSawB, "A 在下一轮输入里看到了 B 的报告");
	} finally {
		await h.close();
	}
});

test("-p 模式：主 agent 结束时还有后台子 agent 在跑，就等它结束，把通知送回并继续处理", async () => {
	const h = await makeHarness({
		route: async (req) => {
			if (isGeneralPurpose(req)) {
				await sleep(200);
				return text("slow-report");
			}
			if (isNotification(req.last)) return text("根据通知给出最终答复");
			if (lastToolResult(req)) return text("先结束这一轮");
			return bg("慢任务");
		},
	});
	try {
		await h.prompt("开始");
		await h.session.agent.waitForIdle();
		assert.equal(notifications(h.session).length, 1, "等到了后台结果");
		const last = (h.session.messages as any[]).filter((m) => m.role === "assistant").pop();
		assert.equal(resultText(last), "根据通知给出最终答复");
	} finally {
		await h.close();
	}
});

test("前后台的选择：禁用后台的环境变量、定义里的 background、fork 模式", async () => {
	const results: string[] = [];
	const route = (req: any) => {
		if (isGeneralPurpose(req) || req.system.includes("BG-MARK")) return text("ok");
		if (isNotification(req.last)) return text("n");
		const tr = lastToolResult(req);
		if (tr) {
			results.push(resultText(tr));
			return text("done");
		}
		return req.lastUser === "定义里要求后台" ? call("agent", { description: "x", prompt: "p", subagent_type: "bg-agent", run_in_background: false }) : call("agent", { description: "x", prompt: "p", run_in_background: true });
	};
	const agents = { "bg.md": "---\nname: bg-agent\ndescription: 总在后台\nbackground: true\n---\nBG-MARK\n" };

	const h1 = await makeHarness({ route, agents, env: { PI_SUBAGENT_DISABLE_BACKGROUND: "1" } });
	try {
		await h1.prompt("要求后台");
		assert.match(results.pop() as string, /^以下是 subagent/, "禁用后台时即使要求后台也在前台运行");
	} finally {
		await h1.close();
	}
	const h2 = await makeHarness({ route, agents });
	try {
		await h2.prompt("定义里要求后台");
		await h2.session.agent.waitForIdle();
		assert.ok(results.some((r) => /^已在后台启动 subagent「bg-agent」/.test(r)), "定义里 background: true 时忽略 run_in_background: false");
	} finally {
		await h2.close();
	}
	const h3 = await makeHarness({ route, agents, env: { PI_FORK_SUBAGENT: "1" } });
	try {
		const tool = h3.session.getAllTools?.().find((t: any) => t.name === "agent") ?? (h3.session as any).agent.state.tools.find((t: any) => t.name === "agent");
		assert.ok(tool, "agent 工具已注册");
		assert.equal(JSON.stringify(tool.parameters).includes("run_in_background"), false, "fork 模式下没有 run_in_background 参数");
	} finally {
		await h3.close();
	}
});

test("界面回调抛异常不影响 agent：后台 agent 仍然报告为成功完成", async () => {
	const h = await makeHarness({
		ui: true,
		brokenUi: true,
		route: (req) => {
			if (isGeneralPurpose(req)) return text("fine-report");
			if (isNotification(req.last)) return text("收到");
			if (lastToolResult(req)) return text("已派出");
			return bg("任务");
		},
	});
	try {
		await h.prompt("开始");
		await waitFor(() => notifications(h.session).length === 1, 5_000, "通知");
		assert.match(resultText(notifications(h.session)[0]), /fine-report/);
		assert.equal(notifications(h.session)[0].details.agents[0].status, "completed");
		await h.session.agent.waitForIdle();
	} finally {
		await h.close();
	}
});
