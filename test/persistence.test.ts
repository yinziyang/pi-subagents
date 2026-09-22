import assert from "node:assert/strict";
import { test } from "node:test";
import { persistKey, RECORD_ENTRY, restoreRecords, toEntryData } from "../extensions/subagents/persistence.ts";
import type { AgentRecord } from "../extensions/subagents/registry.ts";
import { emptyUsage } from "../extensions/subagents/report.ts";

const rec = (over: Partial<AgentRecord> = {}): AgentRecord => ({ id: "a1", type: "general-purpose", description: "d", parentId: "main", depth: 1, status: "running", background: false, fork: false, oneShot: false, cancelledByUser: false, model: "faux/m", tools: ["read"], startedAt: 1, toolCalls: 0, usage: emptyUsage(), ...over });
const entry = (data: unknown) => ({ type: "custom", customType: RECORD_ENTRY, data });

test("restoreRecords：同一 ID 取最后一条，保持首次出现后的顺序", () => {
	const out = restoreRecords([entry(rec({ id: "a1" })), entry(rec({ id: "a2" })), entry(rec({ id: "a1", status: "completed" }))]);
	assert.deepEqual(out.map((r) => [r.id, r.status]), [["a2", "running"], ["a1", "completed"]]);
});

test("restoreRecords 忽略其他扩展的条目与格式不对的数据", () => {
	const out = restoreRecords([{ type: "custom", customType: "other", data: rec() }, entry({ id: "x" }), entry(null), { type: "message" }]);
	assert.deepEqual(out, []);
});

test("persistKey 只在关键字段变化时改变；toEntryData 去掉易变的 activity", () => {
	const a = rec({ activity: "read a.ts", toolCalls: 3 });
	assert.equal(persistKey(a), persistKey({ ...a, toolCalls: 9, activity: "ls" }));
	assert.notEqual(persistKey(a), persistKey({ ...a, status: "completed" }));
	assert.notEqual(persistKey(a), persistKey({ ...a, transcriptPath: "/x.jsonl" }));
	assert.equal("activity" in toEntryData(a), false);
});
