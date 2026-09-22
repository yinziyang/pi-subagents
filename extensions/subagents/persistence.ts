// agent 记录在主会话里的持久化：状态变化时写一条自定义条目，恢复会话或切换分支时按当前分支还原。
//
// 条目随分支走，所以 /tree 切到另一条分支后，只看得到那条分支上派出过的 agent。
// 只在状态、记录文件路径这类关键字段变化时写入，工具调用计数这类频繁变化不写，避免会话文件膨胀。

import type { AgentRecord } from "./registry.ts";

/** 主会话里自定义条目的 customType。 */
export const RECORD_ENTRY = "pi-subagents-record";

/** 条目里本模块用到的最小结构，与 pi 的 SessionEntry 兼容。 */
export interface EntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

/** 决定一条记录的变化是否值得写入：新记录、状态变化、记录文件路径变化、名字变化。 */
export function persistKey(r: AgentRecord): string {
	return [r.status, r.transcriptPath ?? "", r.name ?? "", r.cancelledByUser ? 1 : 0].join("\u0000");
}

/** 写入条目的内容：记录的完整快照，去掉只在界面上用的易变字段。 */
export function toEntryData(r: AgentRecord): AgentRecord {
	const { activity: _activity, ...rest } = r;
	return rest;
}

/**
 * 从当前分支的条目还原 agent 记录，同一个 ID 取最后一条。
 * 格式不对的条目直接忽略：它们可能来自旧版本或被手工改过，不能让恢复会话失败。
 */
export function restoreRecords(entries: readonly EntryLike[]): AgentRecord[] {
	const byId = new Map<string, AgentRecord>();
	for (const e of entries) {
		if (e.type !== "custom" || e.customType !== RECORD_ENTRY || !isRecord(e.data)) continue;
		byId.delete(e.data.id);
		byId.set(e.data.id, e.data);
	}
	return [...byId.values()];
}

function isRecord(d: unknown): d is AgentRecord {
	if (!d || typeof d !== "object") return false;
	const r = d as Record<string, unknown>;
	return typeof r.id === "string" && typeof r.type === "string" && typeof r.parentId === "string" && typeof r.status === "string" && Array.isArray(r.tools) && typeof r.usage === "object" && r.usage !== null;
}
