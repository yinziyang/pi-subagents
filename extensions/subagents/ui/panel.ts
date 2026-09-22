// 输入框下方的 subagent 面板：第一行是 main，之后按父子树缩进列出 subagent。
// 高度不超过终端的三分之一；没有要显示的行时不占位置。

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentRecord, AgentRegistry } from "../registry.ts";
import { panelRows, rowParts } from "./rows.ts";

type TuiLike = { terminal: { rows: number }; requestRender: () => void };
type Color = Parameters<Theme["fg"]>[0];

/** 定义里的 color 取值映射到主题颜色；主题只有少数几种强调色，相近的合并。 */
export function colorOf(r: AgentRecord): Color {
	switch (r.color) {
		case "red":
			return "error";
		case "green":
			return "success";
		case "yellow":
		case "orange":
			return "warning";
		default:
			return "accent";
	}
}

/** 状态图标的颜色。 */
export function statusColor(r: AgentRecord): Color {
	return r.status === "running" ? "accent" : r.status === "completed" ? "success" : r.status === "failed" ? "error" : "warning";
}

export class AgentPanel implements Component {
	private readonly tui: TuiLike;
	private readonly theme: Theme;
	private readonly registry: AgentRegistry;
	private readonly dismissed: ReadonlySet<string>;

	constructor(tui: TuiLike, theme: Theme, registry: AgentRegistry, dismissed: ReadonlySet<string>) {
		this.tui = tui;
		this.theme = theme;
		this.registry = registry;
		this.dismissed = dismissed;
	}

	render(width: number): string[] {
		const now = Date.now();
		const rows = panelRows(this.registry.list(), now, this.dismissed);
		if (!rows.length) return [];
		const t = this.theme;
		const max = Math.max(3, Math.floor(this.tui.terminal.rows / 3));
		const lines = [truncateToWidth(`${t.fg("muted", "main")}${t.fg("dim", "  ·  /agents 查看 · Ctrl+Alt+A 打开面板")}`, width)];
		for (const row of rows) {
			const p = rowParts(row.record, now, row.runningBelow);
			const indent = row.depth ? `${"  ".repeat(row.depth - 1)}└ ` : "";
			const line = `${t.fg("dim", indent)}${t.fg(statusColor(row.record), p.icon)} ${t.fg(colorOf(row.record), p.title)} ${t.fg("muted", `${p.status} · ${p.stats}`)} ${t.fg("dim", p.activity)}`;
			lines.push(truncateToWidth(line, width));
		}
		if (lines.length > max) {
			const hidden = lines.length - (max - 1);
			return [...lines.slice(0, max - 1), truncateToWidth(t.fg("dim", `  … 还有 ${hidden} 个，/agents 查看全部`), width)];
		}
		return lines;
	}

	invalidate(): void {}
}
