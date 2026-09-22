#!/usr/bin/env node
// RPC 模式验收：界面退化为一行状态，/agents 返回文字列表。会调用真实模型。
// 用法：node test/e2e/rpc.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "extensions", "subagents", "index.ts");
const cwd = mkdtempSync(join(tmpdir(), "pisub-rpc-"));
const pi = spawn("pi", ["--mode", "rpc", "-e", EXT], { cwd, env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" } });
const events = [];
let buf = "";
pi.stdout.on("data", (d) => {
	buf += d;
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		try {
			events.push(JSON.parse(line));
		} catch {
			// 非 JSON 行忽略。
		}
	}
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (cmd) => pi.stdin.write(`${JSON.stringify(cmd)}\n`);
const until = async (pred, ms, what) => {
	const deadline = Date.now() + ms;
	while (!events.some(pred)) {
		if (Date.now() > deadline) throw new Error(`等待${what}超时`);
		await sleep(200);
	}
};
let failures = 0;
const check = (name, ok, detail = "") => {
	console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? `\n       ${detail}` : ""}`);
	if (!ok) failures++;
};
const status = (e) => e.type === "extension_ui_request" && e.method === "setStatus" && e.statusKey === "pi-subagents";
try {
	send({ id: "p1", type: "prompt", message: "用 agent 工具在后台派一个 general-purpose 子 agent（run_in_background 设为 true），任务原文「用 bash 执行 sleep 8，然后报告 done」。派出后只回复：已派出。" });
	await until((e) => status(e) && /1 个运行中/.test(e.statusText ?? ""), 120_000, "运行中状态");
	check("RPC 模式用一行状态显示运行中的 subagent", true);
	send({ id: "p2", type: "prompt", message: "/agents" });
	await until((e) => e.type === "extension_ui_request" && e.method === "notify" && /general-purpose/.test(e.message ?? ""), 30_000, "/agents 的文字列表");
	check("/agents 返回文字列表", true);
	await until((e) => status(e) && !e.statusText, 120_000, "状态清除");
	check("agent 结束后状态清除", true);
} catch (err) {
	check("场景执行", false, err.message);
} finally {
	pi.kill();
	rmSync(cwd, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} 项未通过` : "\n全部通过");
process.exit(failures ? 1 : 0);
