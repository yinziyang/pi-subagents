// 本会话里所有 subagent 的状态：父子树、名字解析、深度与并发计数。
//
// 这里只保存可序列化的数据，不持有会话对象；运行中的会话由 runner 管理。
// 深度从 1 开始计：主会话直接派出的是第 1 层。
// 名字解析对齐 Claude Code：同一个发送方用名字找到过某个 agent 后，名字若被更新的 agent 占用，再按名字发送会被拒绝，防止送错对象。

import type { UsageTotals } from "./report.ts";
import { emptyUsage } from "./report.ts";

export type AgentStatus = "running" | "completed" | "failed" | "stopped";

/** 主会话在树里的 ID。 */
export const MAIN_ID = "main";

/** 一个 subagent 的记录。 */
export interface AgentRecord {
	id: string;
	/** 调用时起的名字，可按名字发消息。 */
	name?: string;
	/** agent 定义名，fork 为 "fork"。 */
	type: string;
	description: string;
	/** 父 agent 的 ID，主会话为 MAIN_ID。 */
	parentId: string;
	depth: number;
	status: AgentStatus;
	background: boolean;
	fork: boolean;
	/** 一次性 agent 不能续聊。 */
	oneShot: boolean;
	/** 用户手动停止过，模型不能再自动恢复它，直到用户自己在记录视图里发消息。 */
	cancelledByUser: boolean;
	/** 实际使用的模型，provider/modelId。 */
	model: string;
	/** 调用参数里单独指定的模型，续聊时继续生效。 */
	modelOverride?: string;
	/** 子 agent 实际拿到的工具，续聊时照原样恢复。 */
	tools: string[];
	transcriptPath?: string;
	startedAt: number;
	endedAt?: number;
	toolCalls: number;
	usage: UsageTotals;
	/** 最近一次动作的简述，面板显示用。 */
	activity?: string;
	/** 最终报告或失败原因的摘要。 */
	summary?: string;
	color?: string;
}

/** 新建记录时需要提供的字段。 */
export type NewAgent = Omit<AgentRecord, "status" | "cancelledByUser" | "startedAt" | "toolCalls" | "usage" | "depth"> & { startedAt?: number };

/** 深度与并发上限。 */
export interface Limits {
	maxDepth: number;
	maxConcurrent: number;
}

/** 读取环境变量里的上限，非法值退回默认；默认值与 Claude Code 一致。 */
export function limitsFromEnv(env: Record<string, string | undefined>): Limits {
	return {
		maxDepth: positiveInt(env.PI_SUBAGENT_MAX_DEPTH, 3),
		maxConcurrent: positiveInt(env.PI_SUBAGENT_MAX_CONCURRENT, 20),
	};
}

/** 并发上限的报错，措辞与 Claude Code 一致。 */
export const CONCURRENT_LIMIT_ERROR = "Concurrent subagent limit reached. Do not retry now: wait for a running subagent to finish before spawning another.";

export class AgentRegistry {
	private readonly agents = new Map<string, AgentRecord>();
	/** 名字到最新占用它的 agent。 */
	private readonly byName = new Map<string, string>();
	/** 「发送方 + 名字」上次解析到的 agent，用于发现名字被新 agent 占用。 */
	private readonly nameBindings = new Map<string, string>();
	private readonly listeners = new Set<() => void>();
	private readonly limits: Limits;

	constructor(limits: Limits) {
		this.limits = limits;
	}

	/** 订阅任何变化，返回取消订阅的函数。 */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** 父 agent 的深度；主会话为 0。 */
	depthOf(parentId: string): number {
		return parentId === MAIN_ID ? 0 : (this.agents.get(parentId)?.depth ?? 0);
	}

	/** 某一层的 agent 还能不能派出子 agent：深度未到上限才能拿到 agent 工具。 */
	canNest(depth: number): boolean {
		return depth < this.limits.maxDepth;
	}

	runningCount(): number {
		let n = 0;
		for (const a of this.agents.values()) if (a.status === "running") n++;
		return n;
	}

	/** 新派出一个 agent 前检查并发上限；/subtask 与续聊不经过这里，与 Claude Code 一致。 */
	checkSpawn(): string | undefined {
		return this.runningCount() >= this.limits.maxConcurrent ? CONCURRENT_LIMIT_ERROR : undefined;
	}

	/** 登记一个开始运行的 agent。 */
	add(input: NewAgent): AgentRecord {
		const record: AgentRecord = { ...input, depth: this.depthOf(input.parentId) + 1, status: "running", cancelledByUser: false, startedAt: input.startedAt ?? Date.now(), toolCalls: 0, usage: emptyUsage() };
		this.agents.set(record.id, record);
		if (record.name) this.byName.set(record.name, record.id);
		this.emit();
		return record;
	}

	/** 从持久化记录恢复，不改变状态；运行中的记录恢复成 stopped，因为进程重启后它已经不在运行。 */
	restore(record: AgentRecord): void {
		const r = { ...record, status: record.status === "running" ? ("stopped" as const) : record.status };
		this.agents.set(r.id, r);
		if (r.name) this.byName.set(r.name, r.id);
	}

	get(id: string): AgentRecord | undefined {
		return this.agents.get(id);
	}

	update(id: string, patch: Partial<AgentRecord>): AgentRecord | undefined {
		const r = this.agents.get(id);
		if (!r) return undefined;
		Object.assign(r, patch);
		this.emit();
		return r;
	}

	/** 按插入顺序列出全部记录。 */
	list(): AgentRecord[] {
		return [...this.agents.values()];
	}

	children(parentId: string): AgentRecord[] {
		return this.list().filter((a) => a.parentId === parentId);
	}

	/** 某个 agent 的全部后代（不含自己）。 */
	descendants(id: string): AgentRecord[] {
		const out: AgentRecord[] = [];
		const walk = (pid: string) => {
			for (const c of this.children(pid)) {
				out.push(c);
				walk(c.id);
			}
		};
		walk(id);
		return out;
	}

	/** 某个 agent 仍在运行的后代数量，面板上显示为 (+N)。 */
	runningDescendants(id: string): number {
		return this.descendants(id).filter((a) => a.status === "running").length;
	}

	/**
	 * 解析 send_message 的目标。
	 * 先按 ID 找；按名字找时，若发送方之前用这个名字找到的是另一个 agent，拒绝并说明名字现在指向谁。
	 */
	resolve(to: string, senderId: string): { record: AgentRecord } | { error: string } {
		const byId = this.agents.get(to);
		if (byId) return { record: byId };
		const latest = this.byName.get(to);
		if (!latest) return { error: `找不到 ID 或名字为「${to}」的 agent。` };
		const key = `${senderId}\u0000${to}`;
		const previous = this.nameBindings.get(key);
		if (previous && previous !== latest) {
			return { error: `名字「${to}」现在指向另一个更新的 agent（ID：${latest}），不是你之前联系的那个（ID：${previous}）。要联系之前那个，请改用它的 ID；要联系新的，请用新 ID。` };
		}
		this.nameBindings.set(key, latest);
		return { record: this.agents.get(latest) as AgentRecord };
	}

	/**
	 * 切换分支后同步已结束的记录：不在新分支上的已结束记录移除，新分支上的记录还原。
	 * 运行中的记录保持不变，它们的运行不随分支切换而停止。
	 */
	syncFinished(records: readonly AgentRecord[]): void {
		const wanted = new Set(records.map((r) => r.id));
		for (const r of this.list()) if (r.status !== "running" && !wanted.has(r.id)) this.agents.delete(r.id);
		for (const r of records) if (this.agents.get(r.id)?.status !== "running") this.restore(r);
		this.byName.clear();
		for (const r of this.agents.values()) if (r.name) this.byName.set(r.name, r.id);
		this.emit();
	}

	/** 移除已结束的记录，面板清除行时使用；运行中的不移除。 */
	remove(id: string): boolean {
		const r = this.agents.get(id);
		if (!r || r.status === "running") return false;
		this.agents.delete(id);
		if (r.name && this.byName.get(r.name) === id) this.byName.delete(r.name);
		this.emit();
		return true;
	}

	clear(): void {
		this.agents.clear();
		this.byName.clear();
		this.nameBindings.clear();
		this.emit();
	}

	private emit(): void {
		for (const l of this.listeners) {
			try {
				l();
			} catch {
				// 界面刷新失败不能影响 agent 的状态流转。
			}
		}
	}
}

function positiveInt(value: string | undefined, fallback: number): number {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? n : fallback;
}
