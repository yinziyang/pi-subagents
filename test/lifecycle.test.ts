import assert from "node:assert/strict";
import { test } from "node:test";
import { call, fauxAssistantMessage, isGeneralPurpose, lastToolResult, makeHarness, text, waitFor } from "./harness.ts";

const toolCall = (name: string, args: Record<string, unknown>, id: string) => ({ type: "toolCall", id, name, arguments: args }) as any;

test("pi.events 广播 subagent:start 与 subagent:stop，次数、ID 与父子关系与实际一致", async () => {
	const events: Array<{ name: string; data: any }> = [];
	const listener = (pi: any) => {
		pi.events.on("subagent:start", (data: any) => events.push({ name: "start", data }));
		pi.events.on("subagent:stop", (data: any) => events.push({ name: "stop", data }));
	};
	const h = await makeHarness({
		agents: { "lead.md": "---\nname: lead\ndescription: 分派\n---\nLEAD-MARK\n" },
		extraExtensions: [listener],
		route: (req) => {
			if (req.system.includes("LEAD-MARK")) return lastToolResult(req) ? text("lead-done") : call("agent", { description: "内层", prompt: "内层任务", run_in_background: false });
			if (isGeneralPurpose(req)) return text("inner-done");
			if (lastToolResult(req)) return text("完成");
			return call("agent", { description: "外层", prompt: "外层任务", subagent_type: "lead", run_in_background: false });
		},
	});
	try {
		await h.prompt("开始");
		assert.deepEqual(events.map((e) => `${e.name}:${e.data.type}`), ["start:lead", "start:general-purpose", "stop:general-purpose", "stop:lead"]);
		const lead = events[0].data;
		assert.equal(lead.parentId, "main");
		assert.equal(events[1].data.parentId, lead.agentId, "内层的父节点是 lead");
		assert.equal(events[3].data.status, "completed");
	} finally {
		await h.close();
	}
});

test("退出收尾：3 个运行中的 subagent 在上限内全部中止并关闭，重复收尾不报错", async () => {
	let started = 0;
	const h = await makeHarness({
		ui: true,
		route: async (req) => {
			if (isGeneralPurpose(req)) {
				started++;
				await new Promise<void>((r) => req.signal?.addEventListener("abort", () => r(), { once: true }));
				return fauxAssistantMessage([], { stopReason: "aborted", errorMessage: "aborted" });
			}
			if (lastToolResult(req)) return text("已派出");
			return fauxAssistantMessage(["a", "b", "c"].map((p, i) => toolCall("agent", { description: p, prompt: p }, `s${i}`)), { stopReason: "toolUse" });
		},
	});
	await h.prompt("开始");
	await waitFor(() => started === 3, 5_000, "3 个子 agent 开始");
	const t0 = Date.now();
	await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	const elapsed = Date.now() - t0;
	assert.ok(elapsed < 6_000, `收尾在上限内完成，实际 ${elapsed}ms`);
	await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	await h.close();
});
