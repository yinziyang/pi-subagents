// fork：由主会话当前分支的条目构造子 agent 的初始记录，全部是纯函数。
//
// fork 继承到发起时为止的整个对话，系统提示词随条目一起带过来。
// 通过 agent 工具发起时，那条助手消息里的每个工具调用都必须有结果，否则模型服务会拒绝请求，所以逐个补上占位结果。
// 前缀与主会话逐字节一致时，服务端才可能复用主会话的提示词缓存，所以这里只追加、不改写已有条目。
// 例外是 Anthropic 接口：历史里带签名的 thinking 块绑定原会话，fork 后会被拒绝，只能剥离。

/** 条目里本模块用到的最小结构，与 pi 的 SessionEntry 兼容。 */
export interface ForkEntry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	message?: { role?: string; content?: unknown; [k: string]: unknown };
	[k: string]: unknown;
}

export interface ForkOptions {
	/** 通过 agent 工具发起时的工具调用 ID；由 /subtask 发起时不传。 */
	toolCallId?: string;
	/** 生成新条目 ID。 */
	newId: () => string;
	now: () => number;
	/** 主会话模型走 Anthropic 接口时为 true。 */
	stripSignedThinking: boolean;
}

/** fork 指令：告诉子 agent 它继承了上面的对话，只做这一件事并给出最终报告。 */
export function forkDirective(task: string): string {
	return [
		"你是从上面这段对话 fork 出来的子 agent，继承了到此为止的全部上下文。",
		"主会话会继续做它自己的事，只能看到你的最终报告，看不到你的中间过程。",
		"只完成下面这项任务，不要接着做对话里其他未完成的事；完成后给出简洁的最终报告。",
		"",
		`任务：${task}`,
	].join("\n");
}

/**
 * 构造 fork 的初始条目，fork 指令不在其中，由调用方作为第一次运行的输入发出。
 * 由 agent 工具发起时截止到含这次调用的助手消息，给它的每个工具调用补一条占位结果；由 /subtask 发起时取整个分支。
 * 找不到那条助手消息时返回 undefined，调用方应报错而不是用残缺的历史继续。
 */
export function buildForkEntries(branch: readonly ForkEntry[], opts: ForkOptions): ForkEntry[] | undefined {
	let entries: ForkEntry[];
	let pendingCalls: Array<{ id: string; name: string }> = [];
	if (opts.toolCallId) {
		const idx = branch.findIndex((e) => e.type === "message" && e.message?.role === "assistant" && toolCallsOf(e.message.content).some((c) => c.id === opts.toolCallId));
		if (idx < 0) return undefined;
		const calls = toolCallsOf(branch[idx].message?.content);
		const callIds = new Set(calls.map((c) => c.id));
		// 同一条助手消息里执行得比 fork 快的并行调用已经有了结果，紧跟在它后面，这些结果原样带上。
		let end = idx + 1;
		while (end < branch.length && branch[end].type === "message" && branch[end].message?.role === "toolResult" && callIds.has(String(branch[end].message?.toolCallId))) end++;
		entries = branch.slice(0, end).map((e) => ({ ...e }));
		const answered = new Set(branch.slice(idx + 1, end).map((e) => String(e.message?.toolCallId)));
		pendingCalls = calls.filter((c) => !answered.has(c.id));
	} else {
		entries = branch.map((e) => ({ ...e }));
	}
	if (opts.stripSignedThinking) entries = entries.map(stripThinking);

	let parentId = entries.length ? entries[entries.length - 1].id : null;
	const append = (message: ForkEntry["message"]) => {
		const id = opts.newId();
		entries.push({ type: "message", id, parentId, timestamp: new Date(opts.now()).toISOString(), message });
		parentId = id;
	};
	for (const c of pendingCalls) {
		const text = c.id === opts.toolCallId ? "已 fork 出一个子 agent 来执行这项任务，你就是那个子 agent。" : "这个工具调用在 fork 时还没有结果，fork 里不会再执行它。";
		append({ role: "toolResult", toolCallId: c.id, toolName: c.name, content: [{ type: "text", text }], details: {}, isError: false, timestamp: opts.now() });
	}
	return entries;
}

function toolCallsOf(content: unknown): Array<{ id: string; name: string }> {
	if (!Array.isArray(content)) return [];
	return content.filter((b) => b && typeof b === "object" && b.type === "toolCall" && typeof b.id === "string").map((b) => ({ id: b.id as string, name: String(b.name) }));
}

/** 剥离助手消息里带签名的 thinking 块；没有可剥离的内容时原样返回同一个对象。 */
function stripThinking(e: ForkEntry): ForkEntry {
	const m = e.message;
	if (e.type !== "message" || m?.role !== "assistant" || !Array.isArray(m.content)) return e;
	const kept = m.content.filter((b) => !(b && typeof b === "object" && (b.type === "thinking" || b.type === "redacted_thinking") && (b.thinkingSignature || b.signature || b.type === "redacted_thinking")));
	if (kept.length === m.content.length) return e;
	return { ...e, message: { ...m, content: kept } };
}
