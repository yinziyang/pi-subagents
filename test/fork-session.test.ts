import assert from "node:assert/strict";
import { test } from "node:test";
import { call, isMain, lastToolResult, makeHarness, notifications, resultText, text, waitFor } from "./harness.ts";

const FORK_MARK = "fork 出来的子 agent";
const isFork = (req: any) => JSON.stringify(req.messages).includes(FORK_MARK);
const isNote = (m: any) => m?.role === "custom" || JSON.stringify(m?.content ?? "").includes("[自动通知]");
const systemMsg = (req: any) => JSON.stringify(req.messages.find((m: any) => m.role === "system"));

test("fork：继承整个对话，系统提示词与工具定义和主会话逐字节一致，结果以通知送回", async () => {
	const h = await makeHarness({
		ui: true,
		env: { PI_FORK_SUBAGENT: "1" },
		route: (req) => {
			if (isFork(req)) return text(JSON.stringify(req.messages).includes("BLUE-42") ? "fork 看到了暗号 BLUE-42" : "fork 没看到暗号");
			if (isNote(req.last)) return text("收到 fork 的结果");
			if (lastToolResult(req)) return text("已派出 fork");
			return call("agent", { description: "说暗号", prompt: "说出前面提到的暗号", subagent_type: "fork" });
		},
	});
	try {
		await h.prompt("暗号是 BLUE-42。请 fork 一个子 agent 说出暗号。");
		await waitFor(() => notifications(h.session).length === 1, 5_000, "fork 的通知");
		assert.match(resultText(notifications(h.session)[0]), /fork 看到了暗号 BLUE-42/);
		const mainReq = h.requests.find((r) => isMain(r) && !isFork(r)) as any;
		const forkReq = h.requests.find(isFork) as any;
		assert.equal(systemMsg(forkReq), systemMsg(mainReq), "系统提示词与工具定义逐字节一致");
		const prefix = mainReq.messages.map((m: any) => JSON.stringify(m));
		assert.deepEqual(forkReq.messages.slice(0, prefix.length).map((m: any) => JSON.stringify(m)), prefix, "fork 的请求以主会话那次请求的全部消息为前缀");
		const placeholder = forkReq.messages.find((m: any) => m.role === "toolResult");
		assert.match(resultText(placeholder), /你就是那个子 agent/);
		await h.session.agent.waitForIdle();
	} finally {
		await h.close();
	}
});

test("fork 内再派生 fork 报错，不会创建新的子会话", async () => {
	const h = await makeHarness({
		ui: true,
		env: { PI_FORK_SUBAGENT: "1" },
		route: (req) => {
			if (isFork(req)) {
				const tr = lastToolResult(req);
				if (tr?.toolName === "agent" && tr.toolCallId !== "outer") return text(`内层调用的结果：${resultText(tr)}`);
				if (JSON.stringify(req.messages).includes("内层调用的结果")) return text("结束");
				return call("agent", { description: "再 fork", prompt: "再来一次", subagent_type: "fork" });
			}
			if (isNote(req.last)) return text("好");
			if (lastToolResult(req)) return text("已派出");
			return call("agent", { description: "fork", prompt: "尝试再 fork", subagent_type: "fork" });
		},
	});
	try {
		await h.prompt("开始");
		await waitFor(() => notifications(h.session).length === 1, 5_000, "fork 的通知");
		assert.match(resultText(notifications(h.session)[0]), /fork 不能再派生 fork/);
		const { readdirSync } = await import("node:fs");
		const dir = `${h.agentDir}/subagent-sessions/${h.session.sessionManager.getSessionId()}`;
		assert.equal(readdirSync(dir).length, 1, "只有最初那一个 fork");
		await h.session.agent.waitForIdle();
	} finally {
		await h.close();
	}
});

test("fork 模式关闭时 agent 工具不接受 fork 类型", async () => {
	const h = await makeHarness({
		route: (req) => (lastToolResult(req) ? text("完成") : call("agent", { description: "fork", prompt: "x", subagent_type: "fork", run_in_background: false })),
	});
	try {
		await h.prompt("开始");
		const tr = (h.session.messages as any[]).find((m) => m.role === "toolResult");
		assert.equal(tr.isError, true);
		assert.match(resultText(tr), /fork 模式没有开启/);
	} finally {
		await h.close();
	}
});

test("/subtask：用户直接 fork 当前对话，继承上下文，结果送回主会话", async () => {
	const h = await makeHarness({
		ui: true,
		route: (req) => {
			if (isFork(req)) return text(JSON.stringify(req.messages).includes("BLUE-42") ? "subtask 看到了 BLUE-42" : "没看到");
			if (isNote(req.last)) return text("收到 subtask 的结果");
			return text("记住了");
		},
	});
	try {
		await h.prompt("暗号是 BLUE-42，记住它。");
		await h.session.prompt("/subtask 说出暗号");
		await waitFor(() => notifications(h.session).length === 1, 5_000, "subtask 的通知");
		assert.match(resultText(notifications(h.session)[0]), /subtask 看到了 BLUE-42/);
		await h.session.agent.waitForIdle();
	} finally {
		await h.close();
	}
});
