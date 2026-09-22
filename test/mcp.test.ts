import assert from "node:assert/strict";
import { test } from "node:test";
import { call, isGeneralPurpose, isMain, lastToolResult, makeHarness, resultText, text } from "./harness.ts";

// 模拟 pi-mcp-adapter 的公开面：mcp 代理工具与运行时注册事件。
// 已配置的服务只有 configured；mcp 工具返回本会话能看到的服务，ask 为 true 时像 approveTools 一样弹框确认。
const FAKE_ADAPTER = `
export default function (pi) {
	const runtime = [];
	pi.events.on("pi-mcp-adapter:runtime-register:v1", (req) => {
		if (req.result !== undefined) return;
		if (req.name === "configured" || runtime.includes(req.name)) {
			req.result = { ok: false, error: new Error('MCP server "' + req.name + '" is already registered') };
			return;
		}
		runtime.push(req.name);
		req.result = { ok: true, registration: { dispose: async () => {} } };
	});
	pi.registerTool({
		name: "mcp",
		label: "mcp",
		description: "fake mcp",
		parameters: { type: "object", properties: { ask: { type: "boolean" } } },
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const answer = params.ask ? await ctx.ui.select("MCP: probe wants to run echo", ["Allow once", "Deny"]) : undefined;
			return { content: [{ type: "text", text: JSON.stringify({ servers: ["configured", ...runtime], hasUI: ctx.hasUI, answer: answer ?? null }) }], details: {} };
		},
	});
}
`;

const BROWSER = `---
name: browser
description: 用浏览器测试
tools: read
mcpServers:
  - configured
  - missing
  - playwright:
      type: stdio
      command: npx
      args: ["-y", "@playwright/mcp@latest"]
  - configured:
      command: dup
---
你是 browser 子 agent。`;

const isBrowser = (req: { system: string }) => req.system.includes("你是 browser 子 agent");
const mcpResults = (msgs: any[]) => msgs.filter((m) => m.role === "toolResult" && m.toolName === "mcp").map((m) => JSON.parse(resultText(m)));

test("mcpServers：内联服务只注册进子 agent，主会话看不到；tools 没写 mcp 也能用；与已配置的服务重名时提示", async () => {
	const notes: string[] = [];
	const h = await makeHarness({
		ui: true,
		notes,
		extensionFiles: { "fake-mcp.ts": FAKE_ADAPTER },
		agents: { "browser.md": BROWSER },
		route: (req) => {
			if (isBrowser(req)) {
				const r = lastToolResult(req);
				if (r) return text(`child-saw ${resultText(r)}`);
				return call("mcp", {});
			}
			const r = lastToolResult(req);
			if (!r) return call("mcp", {});
			if (r.toolName === "mcp") return call("agent", { description: "浏览器测试", prompt: "看看有哪些服务", subagent_type: "browser", run_in_background: false });
			return text("done");
		},
	});
	try {
		await h.prompt("开始");
		const mainSaw = mcpResults(h.session.messages)[0];
		assert.deepEqual(mainSaw.servers, ["configured"], "主会话看不到内联服务");
		const report = resultText((h.session.messages as any[]).find((m) => m.role === "toolResult" && m.toolName === "agent"));
		const childSaw = JSON.parse(/child-saw (\{.*\})/.exec(report)?.[1] ?? "{}");
		// tools 只写了 read：子 agent 的 mcp 调用能拿到结果，说明 mcp 工具被自动加上了。
		assert.deepEqual(childSaw.servers, ["configured", "playwright"], "子 agent 看到继承的服务加上自己的内联服务");
		const all = notes.join("\n");
		assert.match(all, /内联 MCP 服务「configured」没有注册成功：MCP server "configured" is already registered/);
	} finally {
		await h.close();
	}
});

test("mcpServers：没有 mcp 工具（没装 pi-mcp-adapter）时提示并照常启动", async () => {
	const notes: string[] = [];
	const h = await makeHarness({
		ui: true,
		notes,
		agents: { "browser.md": BROWSER },
		route: (req) => (isBrowser(req) ? text("child-ok") : lastToolResult(req) ? text("done") : call("agent", { description: "浏览器测试", prompt: "做事", subagent_type: "browser", run_in_background: false })),
	});
	try {
		await h.prompt("开始");
		assert.match(notes.join("\n"), /定义了 mcpServers，但当前没有 mcp 工具（需要安装 pi-mcp-adapter），已忽略/);
		assert.doesNotMatch(notes.join("\n"), /没有注册成功/, "没有 mcp 工具时不再尝试注册内联服务，只提示一次");
		assert.match(resultText((h.session.messages as any[]).find((m) => m.role === "toolResult")), /child-ok/);
	} finally {
		await h.close();
	}
});

test("对话框转发：子 agent 里扩展弹出的确认框显示在主会话，标明来源，答复回到子 agent", async () => {
	const asked: Array<{ title: string; options: string[] }> = [];
	const h = await makeHarness({
		ui: true,
		extensionFiles: { "fake-mcp.ts": FAKE_ADAPTER },
		select: async (title, options) => {
			asked.push({ title, options });
			return "Allow once";
		},
		route: (req) => {
			if (isGeneralPurpose(req)) {
				const r = lastToolResult(req);
				return r ? text(`child-saw ${resultText(r)}`) : call("mcp", { ask: true });
			}
			return lastToolResult(req) ? text("done") : call("agent", { description: "要审批", prompt: "调用需要审批的工具", run_in_background: false });
		},
	});
	try {
		await h.prompt("开始");
		assert.deepEqual(asked, [{ title: "[subagent general-purpose] MCP: probe wants to run echo", options: ["Allow once", "Deny"] }]);
		const report = resultText((h.session.messages as any[]).find((m) => m.role === "toolResult"));
		const childSaw = JSON.parse(/child-saw (\{.*\})/.exec(report)?.[1] ?? "{}");
		assert.equal(childSaw.hasUI, true);
		assert.equal(childSaw.answer, "Allow once");
	} finally {
		await h.close();
	}
});

test("对话框转发：主会话没有界面（-p）时子 agent 也没有界面，需要确认的操作按拒绝处理", async () => {
	const h = await makeHarness({
		extensionFiles: { "fake-mcp.ts": FAKE_ADAPTER },
		route: (req) => {
			if (isGeneralPurpose(req)) {
				const r = lastToolResult(req);
				return r ? text(`child-saw ${resultText(r)}`) : call("mcp", { ask: true });
			}
			if (!isMain(req)) return text("?");
			return lastToolResult(req) ? text("done") : call("agent", { description: "要审批", prompt: "调用需要审批的工具", run_in_background: false });
		},
	});
	try {
		await h.prompt("开始");
		const report = resultText((h.session.messages as any[]).find((m) => m.role === "toolResult"));
		const childSaw = JSON.parse(/child-saw (\{.*\})/.exec(report)?.[1] ?? "{}");
		assert.equal(childSaw.hasUI, false);
		assert.equal(childSaw.answer, null);
	} finally {
		await h.close();
	}
});
