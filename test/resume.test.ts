import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { call, fauxAssistantMessage, isGeneralPurpose, lastToolResult, makeHarness, notifications, resultText, text, waitFor } from "./harness.ts";

const idOf = (s: string) => /agent ID：([0-9a-f]{16})/.exec(s)?.[1] as string;
const toolResults = (h: any, name: string) => (h.session.messages as any[]).filter((m) => m.role === "toolResult" && m.toolName === name);
const isNote = (m: any) => m?.role === "custom" || JSON.stringify(m?.content ?? "").includes("[自动通知]");

test("send_message 恢复已结束的 agent：同一 ID、同一记录文件，历史完整，完成后送回通知", async () => {
	let phase = 1;
	const h = await makeHarness({
		route: (req) => {
			if (isGeneralPurpose(req)) {
				if (JSON.stringify(req.messages).includes("数字是几")) return text(JSON.stringify(req.messages).includes("记住数字 7") ? "数字是 7" : "不知道");
				return text("记住了");
			}
			if (isNote(req.last)) return text("恢复后的结论");
			if (lastToolResult(req)) return text("本轮完成");
			return phase === 1 ? call("agent", { description: "记数字", prompt: "记住数字 7", name: "keeper", run_in_background: false }) : call("send_message", { to: "keeper", message: "数字是几？" });
		},
	});
	try {
		await h.prompt("第一轮");
		const id = idOf(resultText(toolResults(h, "agent")[0]));
		phase = 2;
		await h.prompt("第二轮");
		assert.match(resultText(toolResults(h, "send_message")[0]), /已在后台恢复运行/);
		assert.equal(notifications(h.session).length, 1);
		assert.match(resultText(notifications(h.session)[0]), /数字是 7/);
		assert.match(resultText(notifications(h.session)[0]), new RegExp(`agent ID：${id}`));
		const dir = `${h.agentDir}/subagent-sessions/${h.session.sessionManager.getSessionId()}`;
		assert.equal(readdirSync(dir).filter((f) => f.includes(id)).length, 1, "续聊写回同一个记录文件");
	} finally {
		await h.close();
	}
});

test("send_message 给运行中的 agent：作为 steer 送达，子 agent 在下一轮读到", async () => {
	let sent = false;
	const h = await makeHarness({
		ui: true,
		route: async (req) => {
			if (isGeneralPurpose(req)) {
				if (JSON.stringify(req.messages).includes("改做 B")) return text("已改做 B");
				await waitFor(() => sent, 5_000, "主会话发消息");
				return call("ls", { path: "." });
			}
			if (isNote(req.last)) return text("收到");
			const tr = lastToolResult(req);
			if (tr?.toolName === "agent") return call("send_message", { to: idOf(resultText(tr)), message: "改做 B" });
			if (tr?.toolName === "send_message") {
				sent = true;
				return text("已发");
			}
			return call("agent", { description: "做 A", prompt: "做 A" });
		},
	});
	try {
		await h.prompt("开始");
		assert.match(resultText(toolResults(h, "send_message")[0]), /消息已送达运行中的 agent/);
		await waitFor(() => notifications(h.session).length === 1, 5_000, "通知");
		assert.match(resultText(notifications(h.session)[0]), /已改做 B/);
		await h.session.agent.waitForIdle();
	} finally {
		await h.close();
	}
});

test("Explore 是一次性的：send_message 被拒绝", async () => {
	let phase = 1;
	const h = await makeHarness({
		route: (req) => {
			if (req.system.includes("只读的代码探索 agent")) return text("找到了");
			if (lastToolResult(req)) return text("完成");
			if (phase === 1) return call("agent", { description: "探索", prompt: "找东西", subagent_type: "Explore", name: "scout", run_in_background: false });
			return call("send_message", { to: "scout", message: "再找" });
		},
	});
	try {
		await h.prompt("一");
		assert.doesNotMatch(resultText(toolResults(h, "agent")[0]), /send_message 发给/, "一次性 agent 的报告不提示续聊");
		phase = 2;
		await h.prompt("二");
		const tr = toolResults(h, "send_message")[0];
		assert.equal(tr.isError, true);
		assert.match(resultText(tr), /是一次性的，不能续聊/);
	} finally {
		await h.close();
	}
});

test("task_stop：停止运行中的 agent，已有输出保留；之后模型仍可用 send_message 恢复它", async () => {
	let phase = 1;
	const h = await makeHarness({
		ui: true,
		route: async (req) => {
			if (isGeneralPurpose(req)) {
				if (JSON.stringify(req.messages).includes("继续吧")) return text("继续完成");
				await new Promise<void>((r) => req.signal?.addEventListener("abort", () => r(), { once: true }));
				return fauxAssistantMessage([], { stopReason: "aborted", errorMessage: "aborted" });
			}
			if (isNote(req.last)) return text("收到通知");
			const tr = lastToolResult(req);
			if (tr?.toolName === "agent") return call("task_stop", { to: "worker" });
			if (tr) return text("好");
			return phase === 1 ? call("agent", { description: "慢活", prompt: "慢慢做", name: "worker" }) : call("send_message", { to: "worker", message: "继续吧" });
		},
	});
	try {
		await h.prompt("开始");
		assert.match(resultText(toolResults(h, "task_stop")[0]), /已停止 agent worker/);
		await waitFor(() => notifications(h.session).length === 1, 5_000, "停止后的通知");
		assert.match(resultText(notifications(h.session)[0]), /子 agent 被中止/);
		assert.equal(notifications(h.session)[0].details.agents[0].status, "stopped");
		await h.session.agent.waitForIdle();
		phase = 2;
		await h.prompt("恢复它");
		assert.match(resultText(toolResults(h, "send_message")[0]), /已在后台恢复运行/);
		await waitFor(() => notifications(h.session).length === 2, 5_000, "恢复后的通知");
		assert.match(resultText(notifications(h.session)[1]), /继续完成/);
		await h.session.agent.waitForIdle();
	} finally {
		await h.close();
	}
});
