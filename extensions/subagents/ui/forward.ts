// 把子 agent 里扩展弹出的对话框转到主会话，对应 Claude Code「后台 subagent 的权限请求在主会话里确认」。
//
// 子会话原本绑定的是 pi 的空 UI：扩展看到 hasUI 为 false，需要确认的操作一律按拒绝处理。
// 例如 pi-mcp-adapter 的 approveTools 在子 agent 里会直接报「需要交互式会话」。
// 这里给子会话一个只转发对话框的 UI：
//   - select、confirm、input、editor 转给主会话，标题前加上是哪个 subagent 发起的。
//   - 状态栏、组件、主题切换、编辑器等界面操作一律不做，子 agent 不能改动主会话的界面。
// 不变量：
//   - 多个子 agent 同时请求时排队，一次只显示一个对话框。
//   - 子会话关闭时，它排队中和正在显示的对话框都撤掉，按取消处理，不能留下一个没人等的对话框。

import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";

/** 所有子 agent 共享的对话框队列，保证主会话上同一时刻只有一个转发来的对话框。 */
export class DialogQueue {
	private tail: Promise<unknown> = Promise.resolve();

	/** 排到队尾执行 run；排队期间 signal 触发时直接返回 fallback，不再显示。 */
	enqueue<T>(run: () => Promise<T>, fallback: T, signal: AbortSignal): Promise<T> {
		const next = this.tail.then(() => (signal.aborted ? fallback : run().catch(() => fallback)));
		this.tail = next.catch(() => undefined);
		return next;
	}
}

/**
 * 为一个子会话创建转发对话框的 UI。
 * main 在每次弹框时取主会话当前的 UI，主会话已经没有可交互的界面时返回 undefined，这时按取消处理。
 * closed 在子会话关闭时触发。
 */
export function forwardDialogs(label: string, main: () => ExtensionUIContext | undefined, queue: DialogQueue, closed: AbortSignal): ExtensionUIContext {
	const withSignal = (opts?: ExtensionUIDialogOptions): ExtensionUIDialogOptions => ({ ...opts, signal: opts?.signal ? AbortSignal.any([opts.signal, closed]) : closed });
	const title = (t: string) => `[subagent ${label}] ${t}`;
	const forward = <T>(fallback: T, run: (ui: ExtensionUIContext) => Promise<T>, signal: AbortSignal): Promise<T> =>
		queue.enqueue(
			async () => {
				const ui = main();
				return ui ? run(ui) : fallback;
			},
			fallback,
			signal,
		);
	const noop = () => {};
	return {
		select: (t, options, opts) => {
			const o = withSignal(opts);
			return forward(undefined, (ui) => ui.select(title(t), options, o), o.signal as AbortSignal);
		},
		confirm: (t, message, opts) => {
			const o = withSignal(opts);
			return forward(false, (ui) => ui.confirm(title(t), message, o), o.signal as AbortSignal);
		},
		input: (t, placeholder, opts) => {
			const o = withSignal(opts);
			return forward(undefined, (ui) => ui.input(title(t), placeholder, o), o.signal as AbortSignal);
		},
		// editor 不接受取消信号，子会话关闭后只能等用户自己关掉；排队中的会被撤掉。
		editor: (t, prefill) => forward(undefined, (ui) => ui.editor(title(t), prefill), closed),
		notify: noop,
		onTerminalInput: () => noop,
		setStatus: noop,
		setWorkingMessage: noop,
		setWorkingVisible: noop,
		setWorkingIndicator: noop,
		setHiddenThinkingLabel: noop,
		setWidget: noop,
		setFooter: noop,
		setHeader: noop,
		setTitle: noop,
		custom: async () => undefined as never,
		pasteToEditor: noop,
		setEditorText: noop,
		getEditorText: () => "",
		addAutocompleteProvider: noop,
		setEditorComponent: noop,
		getEditorComponent: () => undefined,
		// 子会话绑定 UI 时 pi 会展开复制这个对象，getter 只在那一刻取一次主会话的主题。
		get theme() {
			return main()?.theme as ExtensionUIContext["theme"];
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "subagent 不能切换主题" }),
		getToolsExpanded: () => false,
		setToolsExpanded: noop,
	};
}
