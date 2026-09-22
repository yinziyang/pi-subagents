import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord } from "../extensions/subagents/registry.ts";
import { emptyUsage } from "../extensions/subagents/report.ts";
import { isVisible, LINGER_MS, navigatorOrder, panelRows, rowParts, transcriptLines } from "../extensions/subagents/ui/rows.ts";

const rec = (id: string, over: Partial<AgentRecord> = {}): AgentRecord => ({ id, type: "general-purpose", description: `任务${id}`, parentId: "main", depth: 1, status: "running", background: true, fork: false, oneShot: false, cancelledByUser: false, model: "m", tools: [], startedAt: 0, toolCalls: 0, usage: emptyUsage(), ...over });

test("isVisible：运行中显示，成功完成立即隐藏，失败或停止保留 30 秒，清除后隐藏", () => {
	const none = new Set<string>();
	assert.equal(isVisible(rec("a"), 0, none), true);
	assert.equal(isVisible(rec("a", { status: "completed", endedAt: 0 }), 1, none), false);
	assert.equal(isVisible(rec("a", { status: "failed", endedAt: 0 }), LINGER_MS - 1, none), true);
	assert.equal(isVisible(rec("a", { status: "stopped", endedAt: 0 }), LINGER_MS, none), false);
	assert.equal(isVisible(rec("a"), 0, new Set(["a"])), false);
});

test("panelRows：按树深度优先排列，隐藏的父节点在有可见后代时仍显示，(+N) 统计运行中的后代", () => {
	const records = [rec("p", { status: "completed", endedAt: 0 }), rec("c1", { parentId: "p" }), rec("g", { parentId: "c1" }), rec("c2", { parentId: "p", status: "completed", endedAt: 0 }), rec("solo", { status: "completed", endedAt: 0 })];
	const rows = panelRows(records, 1, new Set());
	assert.deepEqual(rows.map((r) => [r.record.id, r.depth, r.runningBelow]), [["p", 0, 2], ["c1", 1, 1], ["g", 2, 0]]);
});

test("rowParts：有名字时显示名字与类型，运行中显示最近动作，结束后显示摘要", () => {
	const running = rowParts(rec("a", { name: "rev", activity: "read a.ts", toolCalls: 2, startedAt: 0 }), 65_000, 1);
	assert.equal(running.title, "rev（general-purpose） (+1)");
	assert.equal(running.stats, "2 次工具 · 0 token · 1m 5s");
	assert.equal(running.activity, "read a.ts");
	const done = rowParts(rec("a", { status: "failed", endedAt: 5_000, summary: "出错：overloaded" }), 99_000);
	assert.equal(done.status, "失败");
	assert.equal(done.activity, "出错：overloaded");
	assert.match(done.stats, /5s$/, "结束后耗时停止增长");
});

test("transcriptLines：用户、助手文字、工具调用与结果、错误、通知", () => {
	const lines = transcriptLines([
		{ type: "message", message: { role: "system", content: "系统提示词" } },
		{ type: "custom", customType: "pi-subagents-child" },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "找 bug" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "先看看" }, { type: "toolCall", name: "read", arguments: { path: "src/a.ts" } }] } },
		{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "\n文件内容第一行\n第二行" }] } },
		{ type: "message", message: { role: "toolResult", isError: true, content: [{ type: "text", text: "not found" }] } },
		{ type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "overloaded" } },
		{ type: "message", message: { role: "user", content: "[自动通知] 后台 subagent 已结束" } },
	]);
	assert.deepEqual(lines.map((l) => [l.kind, l.text]), [
		["user", "› 找 bug"],
		["assistant", "先看看"],
		["tool", "⚙ read src/a.ts"],
		["result", "  ↳ 完成：文件内容第一行"],
		["error", "  ↳ 失败：not found"],
		["error", "✗ 模型服务错误：overloaded"],
		["notice", "› [自动通知] 后台 subagent 已结束"],
	]);
});

test("navigatorOrder：运行中的在前，其余按开始时间倒序，清除过的不列", () => {
	const order = navigatorOrder([rec("old", { status: "completed", startedAt: 1 }), rec("run", { startedAt: 0 }), rec("new", { status: "failed", startedAt: 5 }), rec("gone", { status: "completed", startedAt: 9 })], new Set(["gone"]));
	assert.deepEqual(order.map((r) => r.id), ["run", "new", "old"]);
});
