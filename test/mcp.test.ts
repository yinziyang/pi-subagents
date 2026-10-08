import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { builtinMcpExtensions } from "../extensions/subagents/mcp.ts";
import { call, isGeneralPurpose, isMain, lastToolResult, makeHarness, resultText, text, waitFor } from "./harness.ts";

// MCP 用 pi 内置的实现与真实的 stdio 探针服务（test/e2e/mcp-probe-server.mjs，不联网）。
// 主会话由测试按 CLI 的方式加上内置扩展；子会话靠 pi-subagents 自己注入，这正是被测的行为。
const PROBE = join(dirname(fileURLToPath(import.meta.url)), "e2e", "mcp-probe-server.mjs");

const server = (name: string, log: string, extra: Record<string, unknown> = {}) => ({ command: process.execPath, args: [PROBE], env: { PROBE_NAME: name, PROBE_LOG: log }, ...extra });

/** 探针日志里的启动与退出事件。 */
function probeEvents(log: string): Array<{ event: string; name: string; pid: number }> {
	try {
		return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

const allExited = (log: string) => {
	const ev = probeEvents(log);
	return ev.filter((e) => e.event === "start").every((s) => ev.some((e) => e.event === "exit" && e.pid === s.pid));
};

const logPath = (tag: string) => join(tmpdir(), `pisub-probe-${process.pid}-${tag}.log`);

/** 带 mcp.json 的测试环境：probe 服务 direct 暴露，主会话加载内置 MCP。 */
function mcpHarness(opts: Parameters<typeof makeHarness>[0] & { log: string }) {
	return makeHarness({
		...opts,
		extraExtensions: [...builtinMcpExtensions(), ...(opts.extraExtensions ?? [])],
		mcpConfig: { mcpServers: { probe: server("probe", opts.log, { exposure: "direct" }) } },
	});
}

const toolResults = (msgs: any[], name: string) => msgs.filter((m) => m.role === "toolResult" && m.toolName === name);
const agentReport = (msgs: any[]) => resultText(toolResults(msgs, "agent")[0]);

test("内置 MCP：主会话与 general-purpose 子 agent 都能直接调用 mcp.json 里的服务，子会话自己起服务进程，结束即退出", async () => {
	const log = logPath("a");
	const h = await mcpHarness({
		log,
		route: (req) => {
			if (isGeneralPurpose(req)) {
				const r = lastToolResult(req);
				return r ? text(`child-saw ${resultText(r)}`) : call("mcp__probe__whoami", {});
			}
			const r = lastToolResult(req);
			if (!r) return call("mcp__probe__whoami", {});
			if (r.toolName === "mcp__probe__whoami") return call("agent", { description: "问服务", prompt: "调用 probe 的 whoami", run_in_background: false });
			return text("done");
		},
	});
	let childPid = 0;
	try {
		await h.prompt("开始");
		const mainSaw = resultText(toolResults(h.session.messages, "mcp__probe__whoami")[0]);
		assert.match(mainSaw, /^I am probe, pid \d+/);
		const childSaw = /child-saw I am probe, pid (\d+)/.exec(agentReport(h.session.messages));
		assert.ok(childSaw, `子 agent 调到了 probe：${agentReport(h.session.messages)}`);
		childPid = Number(childSaw[1]);
		assert.notEqual(childPid, Number(/pid (\d+)/.exec(mainSaw)?.[1]), "子会话连的是自己起的服务进程");
		await waitFor(() => probeEvents(log).some((e) => e.event === "exit" && e.pid === childPid), 5_000, "子会话的服务进程随子会话退出");
	} finally {
		await h.close();
	}
	await waitFor(() => allExited(log), 5_000, "所有服务进程都退出");
});

test("mcpServers：内联服务只给定义它的子 agent；tools 只写 read 时声明的服务照样可用；主会话调不到内联服务", async () => {
	const log = logPath("b");
	const inline = JSON.stringify(server("inl", log));
	const browser = `---\nname: browser\ndescription: 用 MCP 测试\ntools: read\nmcpServers:\n  - probe\n  - inl: ${inline}\n---\n你是 browser 子 agent。`;
	const isBrowser = (req: { system: string }) => req.system.includes("你是 browser 子 agent");
	const h = await mcpHarness({
		log,
		agents: { "browser.md": browser },
		route: (req) => {
			if (isBrowser(req)) {
				const r = lastToolResult(req);
				if (!r) return call("mcp__inl__whoami", {});
				if (r.toolName === "mcp__inl__whoami") return call("mcp__probe__whoami", {});
				const all = req.messages.filter((m: any) => m.role === "toolResult").map((m: any) => `${m.toolName}=${resultText(m)}`);
				return text(`child-saw ${all.join(" | ")}`);
			}
			const r = lastToolResult(req);
			if (!r) return call("agent", { description: "浏览器测试", prompt: "调用两个服务", subagent_type: "browser", run_in_background: false });
			if (r.toolName === "agent") return call("mcp__inl__whoami", {});
			return text("done");
		},
	});
	try {
		await h.prompt("开始");
		const report = agentReport(h.session.messages);
		assert.match(report, /mcp__inl__whoami=I am inl, pid \d+/, `内联服务可用：${report}`);
		assert.match(report, /mcp__probe__whoami=I am probe, pid \d+/, `引用的服务可用：${report}`);
		const mainInl = toolResults(h.session.messages, "mcp__inl__whoami")[0];
		assert.ok(mainInl?.isError, `主会话调不到内联服务：${resultText(mainInl)}`);
	} finally {
		await h.close();
	}
	await waitFor(() => allExited(log), 5_000, "所有服务进程都退出");
	assert.equal(probeEvents(log).filter((e) => e.name === "inl" && e.event === "start").length, 1, "内联服务只在子会话里启动一次");
});

test("disallowedTools 写 mcp__probe__* 时子 agent 拿不到该服务的工具", async () => {
	const log = logPath("c");
	const def = "---\nname: noprobe\ndescription: 不许用 probe\ndisallowedTools: mcp__probe__*\n---\n你是 noprobe 子 agent。";
	const h = await mcpHarness({
		log,
		agents: { "noprobe.md": def },
		route: (req) => {
			if (req.system.includes("你是 noprobe 子 agent")) {
				const r = lastToolResult(req);
				return r ? text(`child-error=${Boolean(r.isError)} ${resultText(r)}`) : call("mcp__probe__whoami", {});
			}
			return lastToolResult(req) ? text("done") : call("agent", { description: "试调", prompt: "调用 probe", subagent_type: "noprobe", run_in_background: false });
		},
	});
	try {
		await h.prompt("开始");
		assert.match(agentReport(h.session.messages), /child-error=true/);
	} finally {
		await h.close();
	}
});

test("主会话关掉 MCP（设置里 -builtin:mcp）时子会话也不加载，内联服务提示没有启动", async () => {
	const log = logPath("d");
	const notes: string[] = [];
	const def = `---\nname: browser\ndescription: 用 MCP 测试\nmcpServers:\n  - inl: ${JSON.stringify(server("inl", log))}\n---\n你是 browser 子 agent。`;
	const h = await mcpHarness({
		log,
		ui: true,
		notes,
		settings: { extensions: ["-builtin:mcp"] },
		agents: { "browser.md": def },
		route: (req) => {
			if (req.system.includes("你是 browser 子 agent")) {
				const r = lastToolResult(req);
				return r ? text(`child-error=${Boolean(r.isError)}`) : call("mcp__probe__whoami", {});
			}
			return lastToolResult(req) ? text("done") : call("agent", { description: "试调", prompt: "调用 probe", subagent_type: "browser", run_in_background: false });
		},
	});
	try {
		await h.prompt("开始");
		assert.match(agentReport(h.session.messages), /child-error=true/);
		assert.match(notes.join("\n"), /主会话关闭了 MCP，subagent「browser」的内联 MCP 服务 inl 没有启动/);
	} finally {
		await h.close();
	}
	assert.equal(probeEvents(log).length, 0, "没有任何服务进程被拉起");
});

// 一个会弹确认框的扩展工具，用来验证子 agent 里的对话框转到主会话；与 MCP 无关。
const ASK_EXTENSION = `
export default function (pi) {
	pi.registerTool({
		name: "ask_probe",
		label: "ask_probe",
		description: "弹框确认后返回结果",
		parameters: { type: "object", properties: {} },
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const answer = await ctx.ui.select("probe wants to run echo", ["Allow once", "Deny"]);
			return { content: [{ type: "text", text: JSON.stringify({ hasUI: ctx.hasUI, answer: answer ?? null }) }], details: {} };
		},
	});
}
`;

test("对话框转发：子 agent 里扩展弹出的确认框显示在主会话，标明来源，答复回到子 agent", async () => {
	const asked: Array<{ title: string; options: string[] }> = [];
	const h = await makeHarness({
		ui: true,
		extensionFiles: { "ask.ts": ASK_EXTENSION },
		select: async (title, options) => {
			asked.push({ title, options });
			return "Allow once";
		},
		route: (req) => {
			if (isGeneralPurpose(req)) {
				const r = lastToolResult(req);
				return r ? text(`child-saw ${resultText(r)}`) : call("ask_probe", {});
			}
			return lastToolResult(req) ? text("done") : call("agent", { description: "要审批", prompt: "调用需要审批的工具", run_in_background: false });
		},
	});
	try {
		await h.prompt("开始");
		assert.deepEqual(asked, [{ title: "[subagent general-purpose] probe wants to run echo", options: ["Allow once", "Deny"] }]);
		const childSaw = JSON.parse(/child-saw (\{.*\})/.exec(agentReport(h.session.messages))?.[1] ?? "{}");
		assert.equal(childSaw.hasUI, true);
		assert.equal(childSaw.answer, "Allow once");
	} finally {
		await h.close();
	}
});

test("对话框转发：主会话没有界面（-p）时子 agent 也没有界面，需要确认的操作按拒绝处理", async () => {
	const h = await makeHarness({
		extensionFiles: { "ask.ts": ASK_EXTENSION },
		route: (req) => {
			if (isGeneralPurpose(req)) {
				const r = lastToolResult(req);
				return r ? text(`child-saw ${resultText(r)}`) : call("ask_probe", {});
			}
			if (!isMain(req)) return text("?");
			return lastToolResult(req) ? text("done") : call("agent", { description: "要审批", prompt: "调用需要审批的工具", run_in_background: false });
		},
	});
	try {
		await h.prompt("开始");
		const childSaw = JSON.parse(/child-saw (\{.*\})/.exec(agentReport(h.session.messages))?.[1] ?? "{}");
		assert.equal(childSaw.hasUI, false);
		assert.equal(childSaw.answer, null);
	} finally {
		await h.close();
	}
});
