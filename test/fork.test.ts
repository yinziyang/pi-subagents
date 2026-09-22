import assert from "node:assert/strict";
import { test } from "node:test";
import { buildForkEntries, type ForkEntry, forkDirective } from "../extensions/subagents/fork.ts";

let n = 0;
const opts = (over = {}) => ({ newId: () => `n${++n}`, now: () => 1000, stripSignedThinking: false, ...over });
const msg = (id: string, parentId: string | null, message: ForkEntry["message"]): ForkEntry => ({ type: "message", id, parentId, timestamp: "t", message });
const branch: ForkEntry[] = [
	{ type: "session_info", id: "s0", parentId: null, timestamp: "t" },
	msg("u1", "s0", { role: "user", content: [{ type: "text", text: "你好" }] }),
	msg("a1", "u1", { role: "assistant", content: [{ type: "thinking", thinking: "", thinkingSignature: "sig" }, { type: "toolCall", id: "c1", name: "agent", arguments: {} }, { type: "toolCall", id: "c2", name: "ls", arguments: {} }] }),
	msg("r2", "a1", { role: "toolResult", toolCallId: "c2", toolName: "ls", content: [] }),
	msg("later", "r2", { role: "user", content: "之后的消息" }),
];

test("由 agent 工具发起：截止到含调用的助手消息，给未答的调用补占位结果", () => {
	const out = buildForkEntries(branch, opts({ toolCallId: "c1" })) as ForkEntry[];
	assert.deepEqual(out.slice(0, 4).map((e) => e.id), ["s0", "u1", "a1", "r2"], "原有条目与并行调用已有的结果原样保留，不含之后的条目");
	assert.equal(out[2].message, branch[2].message, "不改写原有消息，保证前缀一致");
	const added = out.slice(4);
	assert.deepEqual(added.map((e) => e.message?.role), ["toolResult"], "只给还没有结果的 c1 补占位");
	assert.equal(added[0].message?.toolCallId, "c1");
	assert.equal(added[0].parentId, "r2", "新条目接在原分支末尾");
	assert.ok(!out.some((e) => e.id === "later"));
});

test("由 /subtask 发起：原样取整个分支", () => {
	const out = buildForkEntries(branch, opts()) as ForkEntry[];
	assert.deepEqual(out.map((e) => e.id), branch.map((e) => e.id));
});

test("找不到发起调用的助手消息时返回 undefined", () => {
	assert.equal(buildForkEntries(branch, opts({ toolCallId: "missing" })), undefined);
});

test("Anthropic 接口时剥离带签名的 thinking，其余接口保留", () => {
	const stripped = buildForkEntries(branch, opts({ toolCallId: "c1", stripSignedThinking: true })) as ForkEntry[];
	assert.equal((stripped[2].message?.content as any[]).some((b) => b.type === "thinking"), false);
	const kept = buildForkEntries(branch, opts({ toolCallId: "c1" })) as ForkEntry[];
	assert.equal((kept[2].message?.content as any[])[0].type, "thinking");
});

test("forkDirective 说明继承上下文、只做这件事", () => {
	assert.match(forkDirective("x"), /fork 出来的子 agent/);
	assert.match(forkDirective("x"), /任务：x$/);
});
