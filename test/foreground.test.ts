import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { call, fauxAssistantMessage, fauxText, isGeneralPurpose, isMain, lastToolResult, makeHarness, resultText, text } from "./harness.ts";

const fg = (prompt: string, extra: Record<string, unknown> = {}) => call("agent", { description: "测试任务", prompt, run_in_background: false, ...extra });

test("前台：返回子 agent 最后一条文字并加标记头，中间过程不进主会话，用量计入工具结果", async () => {
	const h = await makeHarness({
		route: (req) => {
			if (isGeneralPurpose(req)) {
				if (lastToolResult(req)) return text("child-report：找到了");
				return call("ls", { path: "." });
			}
			if (lastToolResult(req)) return text("main-final");
			return fg("列出目录后报告");
		},
	});
	try {
		await h.prompt("开始");
		const msgs = h.session.messages as any[];
		const toolResults = msgs.filter((m) => m.role === "toolResult");
		assert.equal(toolResults.length, 1, "主会话只多出一次工具结果");
		const body = resultText(toolResults[0]);
		assert.match(body, /^以下是 subagent「general-purpose」，agent ID：[0-9a-f]{16} 的最终报告/);
		assert.match(body, /<subagent_report>\nchild-report：找到了\n<\/subagent_report>/);
		assert.match(body, /工具调用 1 次/);
		assert.ok(!msgs.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes('"ls"')), "子 agent 的工具调用不在主会话里");
		assert.equal(toolResults[0].isError, false);
		assert.ok(toolResults[0].usage, "工具结果带子 agent 的用量");

		const childReqs = h.requests.filter(isGeneralPurpose);
		assert.equal(childReqs.length, 2);
		assert.ok(!childReqs[0].system.includes("You are an expert coding assistant operating inside pi"), "子 agent 用自己的系统提示词");
		assert.equal(childReqs[0].lastUser, "列出目录后报告");
		assert.ok(!childReqs[0].messages.some((m: any) => m.role === "user" && resultText(m) === "开始"), "子 agent 看不到主会话历史");

		const id = /agent ID：([0-9a-f]{16})/.exec(body)?.[1] as string;
		const { readdirSync } = await import("node:fs");
		const dir = `${h.agentDir}/subagent-sessions/${h.session.sessionManager.getSessionId()}`;
		const file = readdirSync(dir).find((f) => f.endsWith(`_${id}.jsonl`)) as string;
		const childAssistants = readFileSync(`${dir}/${file}`, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "message" && e.message.role === "assistant");
		const sum = (k: string) => childAssistants.reduce((n, e) => n + (e.message.usage?.[k] ?? 0), 0);
		assert.equal(childAssistants.length, 2);
		assert.equal(toolResults[0].usage.input, sum("input"), "工具结果的用量等于子 agent 各轮之和");
		assert.equal(toolResults[0].usage.output, sum("output"));
	} finally {
		await h.close();
	}
});

test("前台：子 agent 的记录写在 subagent-sessions/<主会话 ID>/ 下，头部 parentSession 指向主会话", async () => {
	const h = await makeHarness({
		route: (req) => (isGeneralPurpose(req) ? text("ok") : lastToolResult(req) ? text("done") : fg("做点事")),
	});
	try {
		await h.prompt("开始");
		const body = resultText((h.session.messages as any[]).find((m) => m.role === "toolResult"));
		const id = /agent ID：([0-9a-f]{16})/.exec(body)?.[1] as string;
		const mainId = h.session.sessionManager.getSessionId();
		const { readdirSync } = await import("node:fs");
		const dir = `${h.agentDir}/subagent-sessions/${mainId}`;
		const file = readdirSync(dir).find((f) => f.endsWith(`_${id}.jsonl`));
		assert.ok(file, "记录文件以 agent ID 命名");
		const lines = readFileSync(`${dir}/${file}`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		assert.equal(lines[0].type, "session");
		assert.equal(lines[0].parentSession, h.session.sessionManager.getSessionFile());
		assert.ok(lines.some((l) => l.type === "custom" && l.customType === "pi-subagents-child" && l.data.agentId === id), "子会话里写了标记条目");
		assert.ok(existsSync(h.session.sessionManager.getSessionFile()));
	} finally {
		await h.close();
	}
});

test("前台 API 错误：有部分文字时返回部分输出并说明中断；没有文字时调用失败", async () => {
	let mode: "partial" | "empty" = "partial";
	const h = await makeHarness({
		route: (req) => {
			if (isGeneralPurpose(req)) {
				if (mode === "partial") {
					if (lastToolResult(req)) return fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded_error" });
					return fauxAssistantMessage([fauxText("查到一半"), { type: "toolCall", id: "t1", name: "ls", arguments: { path: "." } } as any], { stopReason: "toolUse" });
				}
				return fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded_error" });
			}
			if (lastToolResult(req)) return text("main-final");
			return fg("会出错的任务");
		},
	});
	try {
		await h.prompt("开始");
		let tr = (h.session.messages as any[]).filter((m) => m.role === "toolResult").pop();
		assert.equal(tr.isError, false);
		assert.match(resultText(tr), /因模型服务错误中断（overloaded_error）/);
		assert.match(resultText(tr), /查到一半/);

		mode = "empty";
		await h.prompt("再来");
		tr = (h.session.messages as any[]).filter((m) => m.role === "toolResult").pop();
		assert.equal(tr.isError, true);
		assert.match(resultText(tr), /^Agent terminated early due to an API error: overloaded_error/);
	} finally {
		await h.close();
	}
});

test("maxTurns：到达上限时在这一轮结束后停止，结果标明不完整并提示可以继续", async () => {
	const h = await makeHarness({
		agents: { "looper.md": "---\nname: looper\ndescription: 一直调用工具\nmaxTurns: 2\n---\nLOOPER-MARK\n" },
		route: (req) => {
			if (req.system.includes("LOOPER-MARK")) return fauxAssistantMessage([fauxText(`第 ${req.messages.filter((m: any) => m.role === "assistant").length + 1} 轮`), { type: "toolCall", id: `t${req.messages.length}`, name: "ls", arguments: { path: "." } } as any], { stopReason: "toolUse" });
			if (lastToolResult(req)) return text("main-final");
			return fg("循环", { subagent_type: "looper" });
		},
	});
	try {
		await h.prompt("开始");
		const looperCalls = h.requests.filter((r) => r.system.includes("LOOPER-MARK")).length;
		assert.equal(looperCalls, 2, "第 2 轮之后不再请求模型");
		const body = resultText((h.session.messages as any[]).find((m) => m.role === "toolResult"));
		assert.match(body, /到达了 maxTurns 轮数上限/);
		assert.match(body, /第 2 轮/);
		assert.match(body, /用 send_message 发给/);
	} finally {
		await h.close();
	}
});

test("前台中止：主会话中止时子 agent 一并结束，状态为 stopped，没有遗留的运行中任务", async () => {
	let childWaiting = false;
	const h = await makeHarness({
		route: async (req) => {
			if (isGeneralPurpose(req)) {
				// 子 agent 卡在请求里，直到收到中止信号，模拟真实 provider 响应中止。
				childWaiting = true;
				await new Promise<void>((r) => req.signal?.addEventListener("abort", () => r(), { once: true }));
				return fauxAssistantMessage([], { stopReason: "aborted", errorMessage: "aborted" });
			}
			if (lastToolResult(req)) return text("main-final");
			return fg("很慢的任务");
		},
	});
	try {
		const run = h.session.prompt("开始");
		while (!childWaiting) await new Promise((r) => setTimeout(r, 10));
		await h.session.abort();
		await run.catch(() => undefined);
		await h.session.agent.waitForIdle();
		const tr = (h.session.messages as any[]).find((m) => m.role === "toolResult");
		assert.ok(tr, "中止后工具结果仍然写回");
		assert.match(resultText(tr), /子 agent 被中止/);
		assert.equal(h.requests.filter((r) => lastToolResult(r) && isMain(r)).length, 0, "主会话被中止，不再继续请求模型");
	} finally {
		await h.close();
	}
});
