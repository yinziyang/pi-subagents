import assert from "node:assert/strict";
import { test } from "node:test";
import { DialogQueue, forwardDialogs } from "../extensions/subagents/ui/forward.ts";

/** 一个记录调用的主会话 UI：select 挂起到测试手动答复或信号撤销。 */
function fakeMain() {
	const open: Array<{ title: string; answer: (v: string | undefined) => void }> = [];
	const ui: any = {
		select: (title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
			new Promise<string | undefined>((resolve) => {
				open.push({ title, answer: resolve });
				opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			}),
		confirm: async (title: string) => title.includes("yes"),
		setStatus: () => assert.fail("子 agent 不能改主会话的状态栏"),
	};
	return { ui, open };
}

test("多个子 agent 同时弹框时排队，一次只显示一个，标题带上来源", async () => {
	const main = fakeMain();
	const queue = new DialogQueue();
	const a = forwardDialogs("worker", () => main.ui, queue, new AbortController().signal);
	const b = forwardDialogs("Explore", () => main.ui, queue, new AbortController().signal);
	const ra = a.select("第一个", ["x"]);
	const rb = b.select("第二个", ["y"]);
	await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(main.open.map((o) => o.title), ["[subagent worker] 第一个"], "第二个还在排队");
	main.open[0].answer("x");
	assert.equal(await ra, "x");
	await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(main.open.map((o) => o.title), ["[subagent worker] 第一个", "[subagent Explore] 第二个"]);
	main.open[1].answer("y");
	assert.equal(await rb, "y");
	a.setStatus("k", "v");
	assert.equal(await a.confirm("yes?", "m"), true);
});

test("子会话关闭时撤掉它正在显示与排队中的对话框，按取消处理，不影响其他子 agent", async () => {
	const main = fakeMain();
	const queue = new DialogQueue();
	const closedA = new AbortController();
	const a = forwardDialogs("a", () => main.ui, queue, closedA.signal);
	const b = forwardDialogs("b", () => main.ui, queue, new AbortController().signal);
	const showing = a.select("正在显示", ["x"]);
	const queuedA = a.select("排队中", ["x"]);
	const queuedB = b.select("b 的", ["y"]);
	await new Promise((r) => setTimeout(r, 10));
	closedA.abort();
	assert.equal(await showing, undefined);
	assert.equal(await queuedA, undefined);
	await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(main.open.map((o) => o.title), ["[subagent a] 正在显示", "[subagent b] b 的"], "a 排队中的那个没有显示出来");
	main.open[1].answer("y");
	assert.equal(await queuedB, "y");
});

test("主会话已经没有界面时按取消处理；主会话的对话框出错也按取消处理，不阻塞后面的请求", async () => {
	const queue = new DialogQueue();
	const gone = forwardDialogs("x", () => undefined, queue, new AbortController().signal);
	assert.equal(await gone.select("t", ["a"]), undefined);
	assert.equal(await gone.confirm("t", "m"), false);
	const broken = forwardDialogs("y", () => ({ select: async () => { throw new Error("tui gone"); }, confirm: async () => true }) as any, queue, new AbortController().signal);
	assert.equal(await broken.select("t", ["a"]), undefined);
	assert.equal(await broken.confirm("t", "m"), true);
});
