// /agents 与快捷键打开的导航：先列出本会话的 subagent，选中后进入记录视图，可以直接给它发消息。
//
// 用非浮层的 ctx.ui.custom 暂时替换输入框区域：浮层在普通模式下会被合成进终端滚动历史，残片会永久留下。
// 记录视图读取子 agent 的记录文件；文件按条目追加写入，每秒按大小变化重读一次，运行中的 agent 也能看到进展。
// 按键对齐 Claude Code 的面板：↑↓ 选择、Enter 打开、x 停止运行中的或清除已结束的、Esc 返回。

import { readFileSync, statSync } from "node:fs";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentRecord, AgentRegistry } from "../registry.ts";
import { colorOf, statusColor } from "./panel.ts";
import { navigatorOrder, rowParts, type TranscriptLine, transcriptLines } from "./rows.ts";

type TuiLike = { terminal: { rows: number }; requestRender: () => void };

export interface NavigatorDeps {
	registry: AgentRegistry;
	dismissed: Set<string>;
	/** 停止运行中的 agent，由用户发起。 */
	stop: (id: string) => Promise<string>;
	/** 用户在记录视图里给 agent 发消息：运行中时追加指令，已结束时恢复运行。 */
	send: (id: string, text: string) => Promise<string>;
	/** 打开时直接进入这个 agent 的记录视图。 */
	initialId?: string;
}

const KIND_COLOR: Record<TranscriptLine["kind"], Parameters<Theme["fg"]>[0]> = { user: "accent", assistant: "text", tool: "muted", result: "dim", error: "error", notice: "warning" };

export class AgentNavigator implements Component, Focusable {
	private readonly tui: TuiLike;
	private readonly theme: Theme;
	private readonly deps: NavigatorDeps;
	private readonly done: () => void;
	private readonly input = new Input({ prompt: "› ", placeholder: "给这个 agent 发消息，Enter 发送，Esc 返回列表" });
	private mode: "list" | "view" = "list";
	private selected = 0;
	private viewId: string | undefined;
	private notice = "";
	private cache: { path: string; size: number; lines: TranscriptLine[] } | undefined;
	private _focused = false;

	constructor(tui: TuiLike, theme: Theme, deps: NavigatorDeps, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.deps = deps;
		this.done = done;
		this.input.onSubmit = (text) => void this.submit(text);
		if (deps.initialId && deps.registry.get(deps.initialId)) this.open(deps.initialId);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && this.mode === "view";
	}

	handleInput(data: string): void {
		if (this.mode === "list") this.handleList(data);
		else if (matchesKey(data, "escape")) {
			this.mode = "list";
			this.notice = "";
			this.input.focused = false;
		} else this.input.handleInput(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const height = Math.max(8, this.tui.terminal.rows - 6);
		const lines = this.mode === "list" ? this.renderList(width, height) : this.renderView(width, height);
		return lines.map((l) => truncateToWidth(l, width));
	}

	invalidate(): void {
		this.input.invalidate();
		this.cache = undefined;
	}

	private agents(): AgentRecord[] {
		return navigatorOrder(this.deps.registry.list(), this.deps.dismissed);
	}

	private handleList(data: string): void {
		const list = this.agents();
		if (matchesKey(data, "escape")) return this.done();
		if (!list.length) return;
		this.selected = Math.min(this.selected, list.length - 1);
		if (matchesKey(data, "up")) this.selected = (this.selected - 1 + list.length) % list.length;
		else if (matchesKey(data, "down")) this.selected = (this.selected + 1) % list.length;
		else if (matchesKey(data, "enter") || matchesKey(data, "return")) this.open(list[this.selected].id);
		else if (data === "x") {
			const r = list[this.selected];
			if (r.status === "running") void this.deps.stop(r.id).then((msg) => this.show(msg));
			else {
				this.deps.dismissed.add(r.id);
				this.show(`已清除 ${r.name ?? r.id}`);
			}
		}
	}

	private open(id: string): void {
		this.viewId = id;
		this.mode = "view";
		this.notice = "";
		this.input.setValue("");
		this.input.focused = this._focused;
	}

	private async submit(text: string): Promise<void> {
		const msg = text.trim();
		if (!msg || !this.viewId) return;
		this.input.setValue("");
		this.show("发送中…");
		this.show(await this.deps.send(this.viewId, msg));
	}

	private show(message: string): void {
		this.notice = message;
		this.tui.requestRender();
	}

	private renderList(width: number, height: number): string[] {
		const t = this.theme;
		const list = this.agents();
		const out = [t.fg("accent", t.bold("subagents")) + t.fg("dim", "  ↑↓ 选择 · Enter 打开记录 · x 停止或清除 · Esc 返回"), t.fg("borderMuted", "─".repeat(Math.max(1, width)))];
		if (!list.length) out.push(t.fg("muted", "本会话还没有派出过 subagent。"));
		const now = Date.now();
		const start = Math.max(0, Math.min(this.selected - (height - 4), list.length - (height - 3)));
		list.slice(start, start + height - 3).forEach((r, i) => {
			const p = rowParts(r, now);
			const mark = start + i === this.selected ? t.fg("accent", "▶ ") : "  ";
			out.push(`${mark}${t.fg(statusColor(r), p.icon)} ${t.fg(colorOf(r), p.title)} ${t.fg("muted", `${p.status} · ${p.stats}`)} ${t.fg("dim", p.activity)}`);
		});
		if (this.notice) out.push(t.fg("warning", this.notice));
		return out;
	}

	private renderView(width: number, height: number): string[] {
		const t = this.theme;
		const r = this.viewId ? this.deps.registry.get(this.viewId) : undefined;
		if (!r) return [t.fg("error", "这个 agent 已经不在本会话里了。按 Esc 返回。")];
		const p = rowParts(r, Date.now());
		const head = `${t.fg(statusColor(r), p.icon)} ${t.fg(colorOf(r), t.bold(p.title))} ${t.fg("muted", `${p.status} · ${p.stats} · ${r.model}`)}`;
		const body: string[] = [];
		for (const line of this.transcript(r)) for (const w of wrapTextWithAnsi(t.fg(KIND_COLOR[line.kind], line.text), Math.max(10, width - 2))) body.push(` ${w}`);
		const room = Math.max(1, height - 5);
		const shown = body.length > room ? [t.fg("dim", ` …（前面还有 ${body.length - room} 行）`), ...body.slice(-(room - 1))] : body;
		if (!shown.length) shown.push(t.fg("dim", " （还没有记录）"));
		const rule = t.fg("borderMuted", "─".repeat(Math.max(1, width)));
		return [head, rule, ...shown, rule, ...this.input.render(width), t.fg("dim", this.notice || "Esc 返回列表")];
	}

	/** 读取记录文件；大小没变时用缓存，文件还没写出时返回空。 */
	private transcript(r: AgentRecord): TranscriptLine[] {
		const path = r.transcriptPath;
		if (!path) return [];
		let size: number;
		try {
			size = statSync(path).size;
		} catch {
			// pi 在子 agent 第一次回复后才写出记录文件，此前文件不存在。
			return [];
		}
		if (this.cache?.path === path && this.cache.size === size) return this.cache.lines;
		const entries = [];
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				entries.push(JSON.parse(line));
			} catch {
				// 最后一行可能正在写入，跳过不完整的行。
			}
		}
		const lines = transcriptLines(entries);
		this.cache = { path, size, lines };
		return lines;
	}
}
