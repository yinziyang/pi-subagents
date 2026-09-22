import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentRegistry, CONCURRENT_LIMIT_ERROR, limitsFromEnv, MAIN_ID, type NewAgent } from "../extensions/subagents/registry.ts";

let seq = 0;
const spec = (over: Partial<NewAgent> = {}): NewAgent => ({ id: `a${++seq}`, type: "general-purpose", description: "d", parentId: MAIN_ID, background: false, fork: false, oneShot: false, model: "faux/m", tools: [], ...over });

test("limitsFromEnv：默认 3 层、20 个，非法值退回默认", () => {
	assert.deepEqual(limitsFromEnv({}), { maxDepth: 3, maxConcurrent: 20 });
	assert.deepEqual(limitsFromEnv({ PI_SUBAGENT_MAX_DEPTH: "1", PI_SUBAGENT_MAX_CONCURRENT: "2" }), { maxDepth: 1, maxConcurrent: 2 });
	assert.deepEqual(limitsFromEnv({ PI_SUBAGENT_MAX_DEPTH: "0", PI_SUBAGENT_MAX_CONCURRENT: "x" }), { maxDepth: 3, maxConcurrent: 20 });
});

test("深度：第 3 层拿不到 agent 工具；上限为 1 时第 1 层就拿不到", () => {
	const reg = new AgentRegistry({ maxDepth: 3, maxConcurrent: 20 });
	const l1 = reg.add(spec());
	const l2 = reg.add(spec({ parentId: l1.id }));
	const l3 = reg.add(spec({ parentId: l2.id }));
	assert.deepEqual([l1.depth, l2.depth, l3.depth], [1, 2, 3]);
	assert.equal(reg.canNest(l2.depth), true);
	assert.equal(reg.canNest(l3.depth), false);
	const flat = new AgentRegistry({ maxDepth: 1, maxConcurrent: 20 });
	assert.equal(flat.canNest(flat.add(spec()).depth), false);
});

test("并发：满额时拒绝并返回规定的错误，有 agent 结束后恢复", () => {
	const reg = new AgentRegistry({ maxDepth: 3, maxConcurrent: 2 });
	const a = reg.add(spec());
	reg.add(spec());
	assert.equal(reg.checkSpawn(), CONCURRENT_LIMIT_ERROR);
	assert.match(CONCURRENT_LIMIT_ERROR, /^Concurrent subagent limit reached/);
	reg.update(a.id, { status: "completed" });
	assert.equal(reg.checkSpawn(), undefined);
});

test("树：children、descendants、runningDescendants", () => {
	const reg = new AgentRegistry({ maxDepth: 3, maxConcurrent: 20 });
	const p = reg.add(spec());
	const c1 = reg.add(spec({ parentId: p.id }));
	const c2 = reg.add(spec({ parentId: p.id }));
	const g = reg.add(spec({ parentId: c1.id }));
	reg.update(c2.id, { status: "completed" });
	assert.deepEqual(reg.children(p.id).map((a) => a.id), [c1.id, c2.id]);
	assert.deepEqual(reg.descendants(p.id).map((a) => a.id), [c1.id, g.id, c2.id]);
	assert.equal(reg.runningDescendants(p.id), 2);
});

test("名字解析：同名新 agent 出现后，旧名字的发送被拒绝，用 ID 仍能找到旧 agent", () => {
	const reg = new AgentRegistry({ maxDepth: 3, maxConcurrent: 20 });
	const old = reg.add(spec({ name: "rev" }));
	const first = reg.resolve("rev", MAIN_ID);
	assert.ok("record" in first && first.record.id === old.id);
	const fresh = reg.add(spec({ name: "rev" }));
	const again = reg.resolve("rev", MAIN_ID);
	assert.ok("error" in again);
	assert.match(again.error, new RegExp(`现在指向另一个更新的 agent（ID：${fresh.id}）`));
	const byId = reg.resolve(old.id, MAIN_ID);
	assert.ok("record" in byId && byId.record.id === old.id);
	const other = reg.resolve("rev", "someone-else");
	assert.ok("record" in other && other.record.id === fresh.id, "没联系过这个名字的发送方直接拿到最新的");
	assert.ok("error" in reg.resolve("nobody", MAIN_ID));
});

test("restore 把运行中的记录恢复为 stopped；remove 不移除运行中的", () => {
	const reg = new AgentRegistry({ maxDepth: 3, maxConcurrent: 20 });
	const a = reg.add(spec());
	assert.equal(reg.remove(a.id), false);
	const copy = { ...a };
	const fresh = new AgentRegistry({ maxDepth: 3, maxConcurrent: 20 });
	fresh.restore(copy);
	assert.equal(fresh.get(a.id)?.status, "stopped");
	assert.equal(fresh.remove(a.id), true);
});

test("onChange 在变化时通知，监听器抛错不影响状态", () => {
	const reg = new AgentRegistry({ maxDepth: 3, maxConcurrent: 20 });
	let n = 0;
	reg.onChange(() => {
		n++;
		throw new Error("ui broken");
	});
	const a = reg.add(spec());
	reg.update(a.id, { activity: "read" });
	assert.equal(n, 2);
	assert.equal(reg.get(a.id)?.activity, "read");
});
