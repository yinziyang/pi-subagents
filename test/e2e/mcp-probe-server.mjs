#!/usr/bin/env node
// 测试用的极简 MCP stdio 服务：按行收发 JSON-RPC，提供 whoami 与 echo 两个工具。
// 启动与退出时往 PROBE_LOG 追加一行，用来统计每个 pi 会话各拉起了几个服务进程、退出时有没有残留。
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const name = process.env.PROBE_NAME ?? "probe";
const log = (event) => {
	if (process.env.PROBE_LOG) appendFileSync(process.env.PROBE_LOG, `${JSON.stringify({ event, name, pid: process.pid, ppid: process.ppid, at: Date.now() })}\n`);
};
log("start");
process.on("exit", () => log("exit"));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0));

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const tools = [
	{ name: "whoami", description: `返回 ${name} 服务的名字与进程号。`, inputSchema: { type: "object", properties: {} } },
	{ name: "echo", description: "原样返回 text，并附上服务名与进程号。", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
];

createInterface({ input: process.stdin }).on("line", (line) => {
	let req;
	try {
		req = JSON.parse(line);
	} catch {
		return;
	}
	if (req.id === undefined) return;
	switch (req.method) {
		case "initialize":
			return send({ id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name, version: "1.0.0" } } });
		case "ping":
			return send({ id: req.id, result: {} });
		case "tools/list":
			return send({ id: req.id, result: { tools } });
		case "tools/call": {
			const args = req.params?.arguments ?? {};
			const text = req.params?.name === "echo" ? `${name}#${process.pid} echo: ${args.text}` : `I am ${name}, pid ${process.pid}`;
			return send({ id: req.id, result: { content: [{ type: "text", text }] } });
		}
		default:
			return send({ id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } });
	}
});
process.stdin.on("end", () => process.exit(0));
