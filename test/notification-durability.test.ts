// 分别覆盖主响应中及其他扩展收尾期间到达的通知，避免安全落盘后丢掉原有自动处理行为。

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { call, isGeneralPurpose, lastToolResult, makeHarness, notifications, resultText, text, waitFor } from "./harness.ts";

for (const phase of ["response", "agent_end"] as const) {
	test(`TUI 在 ${phase} 期间安全提交的后台通知仍触发一次处理`, { timeout: 15_000 }, async () => {
		const barrier = Promise.withResolvers<void>();
		let submitted = false;
		let handled = 0;
		const finishChild = async () => {
			barrier.resolve();
			await waitFor(() => submitted, 5000, "主会话忙时提交后台通知");
		};
		const h = await makeHarness({
			ui: true,
			onSendMessage: (message) => { if (message.customType === "pi-subagents-notification") submitted = true; },
			extraExtensions: phase === "agent_end" ? [(pi: ExtensionAPI) => pi.on("agent_end", finishChild)] : [],
			route: async (req) => {
				if (isGeneralPurpose(req)) {
					await barrier.promise;
					return text("收尾前的后台报告");
				}
				if (req.last?.role === "custom" || req.lastUser.includes("[自动通知]")) {
					handled++;
					return text("已处理后台报告");
				}
				if (lastToolResult(req)?.toolName === "agent") {
					if (phase === "response") await finishChild();
					return text("本轮原本直接结束");
				}
				return call("agent", { description: "完成通知续跑测试", prompt: "回报结果", run_in_background: true });
			},
		});
		try {
			await h.prompt("派出后台任务");
			assert.equal(submitted, true);
			assert.equal(handled, 1, "报告处理不能遗漏或重复触发模型");
			assert.equal(notifications(h.session).length, 1);
			assert.match(resultText(notifications(h.session)[0]), /收尾前的后台报告/);
			assert.equal(h.session.getLastAssistantText(), "已处理后台报告");
		} finally {
			barrier.resolve();
			await h.close();
		}
	});
}
