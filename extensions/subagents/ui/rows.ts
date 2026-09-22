// 界面的纯逻辑：面板显示哪些行、每行写什么、记录视图的内容，不依赖终端。
//
// 面板行的去留对齐 Claude Code：
//   - 运行中的一直显示。
//   - 成功完成的立即移除，由底栏提示「/agents 查看」30 秒。
//   - 失败或被停止的保留 30 秒，用户可以提前清除。
// 被隐藏的 agent 如果还有要显示的后代，照样显示，好让树的路径完整。

import { type AgentRecord, MAIN_ID } from "../registry.ts";
import { displayTokens, formatDuration, formatTokens } from "../report.ts";

/** 失败或被停止的行在面板上保留的时间，与 Claude Code 一致。 */
export const LINGER_MS = 30_000;

/** 面板上的一行。 */
export interface PanelRow {
	record: AgentRecord;
	depth: number;
	/** 仍在运行的后代数量，显示为 (+N)。 */
	runningBelow: number;
}

/** 某条记录此刻是否应该出现在面板上。 */
export function isVisible(r: AgentRecord, now: number, dismissed: ReadonlySet<string>): boolean {
	if (dismissed.has(r.id)) return false;
	if (r.status === "running") return true;
	if (r.status === "completed") return false;
	return r.endedAt !== undefined && now - r.endedAt < LINGER_MS;
}

/** 按父子树深度优先排出面板行。 */
export function panelRows(records: readonly AgentRecord[], now: number, dismissed: ReadonlySet<string>): PanelRow[] {
	const byParent = new Map<string, AgentRecord[]>();
	for (const r of records) {
		const list = byParent.get(r.parentId) ?? [];
		list.push(r);
		byParent.set(r.parentId, list);
	}
	const runningBelow = (id: string): number => (byParent.get(id) ?? []).reduce((n, c) => n + (c.status === "running" ? 1 : 0) + runningBelow(c.id), 0);
	const hasVisible = (r: AgentRecord): boolean => isVisible(r, now, dismissed) || (byParent.get(r.id) ?? []).some(hasVisible);
	const rows: PanelRow[] = [];
	const walk = (parentId: string, depth: number) => {
		for (const r of byParent.get(parentId) ?? []) {
			if (!hasVisible(r)) continue;
			rows.push({ record: r, depth, runningBelow: runningBelow(r.id) });
			walk(r.id, depth + 1);
		}
	};
	walk(MAIN_ID, 0);
	return rows;
}

const STATUS_TEXT: Record<AgentRecord["status"], string> = { running: "运行中", completed: "已完成", failed: "失败", stopped: "已停止" };
const STATUS_ICON: Record<AgentRecord["status"], string> = { running: "●", completed: "✓", failed: "✗", stopped: "■" };

/** 面板或列表一行的纯文本部分：图标、名字、状态、统计与最近动作，由调用方上色与截断。 */
export function rowParts(r: AgentRecord, now: number, runningBelow = 0): { icon: string; title: string; status: string; stats: string; activity: string } {
	const title = `${r.name ?? r.type}${r.name ? `（${r.type}）` : ""}${runningBelow ? ` (+${runningBelow})` : ""}`;
	const elapsed = formatDuration((r.endedAt ?? now) - r.startedAt);
	const stats = [`${r.toolCalls} 次工具`, `${formatTokens(displayTokens(r.usage))} token`, elapsed].join(" · ");
	const activity = r.status === "running" ? (r.activity ?? r.description) : (r.summary ?? r.description);
	return { icon: STATUS_ICON[r.status], title, status: STATUS_TEXT[r.status], stats, activity };
}

/** 记录视图里的一行及其语义，由调用方上色。 */
export interface TranscriptLine {
	kind: "user" | "assistant" | "tool" | "result" | "error" | "notice";
	text: string;
}

/**
 * 把子 agent 的会话条目整理成记录视图的行。
 * 只展示对话本身：用户消息、助手文字、工具调用与结果摘要；系统提示词与内部标记条目不展示。
 */
export function transcriptLines(entries: readonly { type: string; customType?: string; content?: unknown; message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean; stopReason?: string; errorMessage?: string } }[]): TranscriptLine[] {
	const out: TranscriptLine[] = [];
	for (const e of entries) {
		if (e.type === "custom_message" && e.customType === "pi-subagents-notification") {
			out.push({ kind: "notice", text: `✉ ${firstLine(textOf(e.content))}` });
			continue;
		}
		const m = e.type === "message" ? e.message : undefined;
		if (!m) continue;
		if (m.role === "user") {
			const t = textOf(m.content);
			if (t) out.push({ kind: t.startsWith("[自动通知]") ? "notice" : "user", text: `› ${t}` });
		} else if (m.role === "assistant") {
			const t = textOf(m.content);
			if (t) out.push({ kind: "assistant", text: t });
			if (Array.isArray(m.content)) {
				for (const b of m.content) if (b && typeof b === "object" && (b as { type?: string }).type === "toolCall") out.push({ kind: "tool", text: `⚙ ${(b as { name?: string }).name} ${briefArgs((b as { arguments?: unknown }).arguments)}`.trimEnd() });
			}
			if (m.stopReason === "error") out.push({ kind: "error", text: `✗ 模型服务错误：${m.errorMessage ?? "未知错误"}` });
			if (m.stopReason === "aborted") out.push({ kind: "error", text: "■ 已中止" });
		} else if (m.role === "toolResult") {
			const t = firstLine(textOf(m.content));
			out.push({ kind: m.isError ? "error" : "result", text: `  ↳ ${m.isError ? "失败" : "完成"}${t ? `：${t}` : ""}` });
		}
	}
	return out;
}

/** 把 agent 列表排成导航顺序：运行中的在前，其余按开始时间倒序。 */
export function navigatorOrder(records: readonly AgentRecord[], dismissed: ReadonlySet<string>): AgentRecord[] {
	const visible = records.filter((r) => !dismissed.has(r.id));
	return [...visible.filter((r) => r.status === "running"), ...visible.filter((r) => r.status !== "running").sort((a, b) => b.startedAt - a.startedAt)];
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
		.join("")
		.trim();
}

function firstLine(text: string, max = 120): string {
	const line = text.split("\n").find((l) => l.trim()) ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function briefArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	const v = a.command ?? a.path ?? a.pattern ?? a.description ?? a.to ?? Object.values(a)[0];
	return typeof v === "string" ? firstLine(v, 80) : "";
}
