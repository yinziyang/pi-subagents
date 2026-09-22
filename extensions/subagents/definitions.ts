// subagent 定义：解析定义文件、扫描各作用域、按优先级合并，行为对齐 Claude Code。
//
// 作用域优先级从高到低：--agents 启动参数、项目（.pi/agents，离 cwd 近者优先）、用户（~/.pi/agent/agents）、内置。
// 同名时高优先级覆盖低优先级。
// 跳过规则与 Claude Code 一致：没有 name 或 frontmatter 不在首行时当作文档静默跳过，其余格式问题跳过并记诊断。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentSource = "cli" | "project" | "user" | "builtin";

/** 一个 subagent 的完整定义。字段语义对齐 Claude Code 的 frontmatter。 */
export interface AgentDefinition {
	name: string;
	description: string;
	/** 定义正文，作为子 agent 的系统提示词。 */
	systemPrompt: string;
	/** 允许的工具，未设置表示继承全部可用工具；条目保留原样，启动时再解析成 pi 的工具名。 */
	tools?: string[];
	/** 从继承或指定列表里移除的工具，条目保留原样。 */
	disallowedTools?: string[];
	/** `inherit`、`provider/modelId` 或 pi 能解析的模型名；未设置等同 inherit。 */
	model?: string;
	/** 最大轮数，到达后返回部分结果。 */
	maxTurns?: number;
	/** 启动时预加载完整内容的 skill 名字。 */
	skills?: string[];
	/** 为 true 时总在后台运行。 */
	background?: boolean;
	/** 为 true 时不加载 AGENTS.md、CLAUDE.md 等上下文文件，也不注入常驻规范。 */
	omitContextFiles?: boolean;
	/** Claude Code 的 effort 取值，启动时映射到 pi 的 thinking level。 */
	effort?: Effort;
	color?: AgentColor;
	/** 一次性 agent 不返回可续聊的 ID，只有内置的 Explore、Plan 是一次性的。 */
	oneShot: boolean;
	source: AgentSource;
	/** 定义所在文件；来自 --agents 参数的没有文件。 */
	filePath?: string;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type AgentColor = "red" | "blue" | "green" | "yellow" | "purple" | "orange" | "pink" | "cyan";

/** 加载过程中发现的问题，启动时展示给用户。 */
export interface Diagnostic {
	path: string;
	message: string;
}

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const COLORS: readonly AgentColor[] = ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"];

/** Claude Code 支持、本期不支持的字段；读到时记诊断，定义照常加载。 */
const UNSUPPORTED_FIELDS = ["mcpServers", "hooks", "memory", "isolation", "initialPrompt", "experimental"];

/**
 * 所有 agent 的 description 合计超过这个估算 token 数时给出警告，与 Claude Code 的阈值一致。
 * 超过后仍然全部加载，警告只提醒描述写得太长、会挤占每一轮的上下文。
 */
export const DESCRIPTION_TOKEN_WARN = 15_000;

/** 解析一个定义文件的结果：成功时有 agent，被跳过时可能带一条诊断。 */
export interface ParseResult {
	agent?: AgentDefinition;
	diagnostic?: Diagnostic;
	/** 定义可用，但含有本期不支持的字段。 */
	notes: Diagnostic[];
}

/** 解析一个 Markdown 定义文件。 */
export function parseAgentFile(content: string, filePath: string, source: AgentSource): ParseResult {
	let frontmatter: Record<string, unknown>;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content));
	} catch (err) {
		return { diagnostic: { path: filePath, message: `frontmatter 不是合法的 YAML，已跳过：${firstLine(err)}` }, notes: [] };
	}
	if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
		return { diagnostic: { path: filePath, message: "frontmatter 必须是键值对，已跳过" }, notes: [] };
	}
	return buildDefinition(frontmatter, body, source, filePath);
}

/**
 * 解析 --agents 启动参数传入的 JSON，格式与 Claude Code 相同：以名字为键，值里用 prompt 字段写系统提示词。
 * JSON 本身无法解析时整体报一条诊断。
 */
export function parseCliAgents(json: string): { agents: AgentDefinition[]; diagnostics: Diagnostic[] } {
	const where = "--agents";
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (err) {
		return { agents: [], diagnostics: [{ path: where, message: `不是合法的 JSON：${firstLine(err)}` }] };
	}
	if (!isRecord(parsed)) return { agents: [], diagnostics: [{ path: where, message: "必须是以 agent 名字为键的对象" }] };
	const agents: AgentDefinition[] = [];
	const diagnostics: Diagnostic[] = [];
	for (const [name, value] of Object.entries(parsed)) {
		if (!isRecord(value)) {
			diagnostics.push({ path: `${where}.${name}`, message: "定义必须是对象，已跳过" });
			continue;
		}
		const { prompt, ...fields } = value;
		const r = buildDefinition({ ...fields, name }, typeof prompt === "string" ? prompt : "", "cli", undefined, `${where}.${name}`);
		if (r.agent) agents.push(r.agent);
		if (r.diagnostic) diagnostics.push(r.diagnostic);
		diagnostics.push(...r.notes);
	}
	return { agents, diagnostics };
}

function buildDefinition(fm: Record<string, unknown>, body: string, source: AgentSource, filePath: string | undefined, where = filePath ?? source): ParseResult {
	const notes: Diagnostic[] = [];
	const name = fm.name;
	// 没有 name 的文件当作放在 agents 目录旁边的文档，Claude Code 同样静默跳过。
	if (name === undefined || name === null || name === "") return { notes };
	if (typeof name !== "string") return { diagnostic: { path: where, message: "name 必须是字符串，已跳过" }, notes };
	if (name.startsWith("-") || name.includes(":")) {
		return { diagnostic: { path: where, message: `name「${name}」不能以 - 开头，也不能包含 :，已跳过` }, notes };
	}
	if (typeof fm.description !== "string" || !fm.description.trim()) {
		return { diagnostic: { path: where, message: `agent「${name}」缺少 description，已跳过` }, notes };
	}
	const agent: AgentDefinition = { name, description: fm.description.trim(), systemPrompt: body.trim(), oneShot: false, source, filePath };

	const tools = parseToolList(fm.tools);
	if (tools === "invalid") notes.push({ path: where, message: `agent「${name}」的 tools 格式不对，已按继承全部工具处理` });
	else if (tools) agent.tools = tools;
	const disallowed = parseToolList(fm.disallowedTools);
	if (disallowed === "invalid") notes.push({ path: where, message: `agent「${name}」的 disallowedTools 格式不对，已忽略` });
	else if (disallowed) agent.disallowedTools = disallowed;

	if (typeof fm.model === "string" && fm.model.trim()) agent.model = fm.model.trim();
	if (fm.maxTurns !== undefined) {
		if (Number.isInteger(fm.maxTurns) && (fm.maxTurns as number) > 0) agent.maxTurns = fm.maxTurns as number;
		else notes.push({ path: where, message: `agent「${name}」的 maxTurns 必须是正整数，已忽略` });
	}
	const skills = parseToolList(fm.skills);
	if (skills === "invalid") notes.push({ path: where, message: `agent「${name}」的 skills 格式不对，已忽略` });
	else if (skills) agent.skills = skills;
	if (fm.background === true) agent.background = true;
	// omitAgentsMd 是本包为 AGENTS.md 迁移加的别名，与 omitClaudeMd 等价。
	if (fm.omitClaudeMd === true || fm.omitAgentsMd === true) agent.omitContextFiles = true;
	if (fm.effort !== undefined) {
		if (EFFORTS.includes(fm.effort as Effort)) agent.effort = fm.effort as Effort;
		else notes.push({ path: where, message: `agent「${name}」的 effort 取值不对，应为 ${EFFORTS.join("、")}，已忽略` });
	}
	if (fm.color !== undefined) {
		if (COLORS.includes(fm.color as AgentColor)) agent.color = fm.color as AgentColor;
		else notes.push({ path: where, message: `agent「${name}」的 color 取值不对，应为 ${COLORS.join("、")}，已忽略` });
	}
	// 一次性标记只对内置定义生效，用户定义与 Claude Code 一样总是可续聊。
	if (source === "builtin" && fm.oneShot === true) agent.oneShot = true;
	const unsupported = UNSUPPORTED_FIELDS.filter((f) => fm[f] !== undefined);
	if (unsupported.length) notes.push({ path: where, message: `agent「${name}」的 ${unsupported.join("、")} 字段本期不支持，已忽略` });
	return { agent, notes };
}

/** 工具、skill 列表接受逗号分隔的字符串或字符串数组；未设置返回 undefined。 */
function parseToolList(value: unknown): string[] | undefined | "invalid" {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return splitList(value);
	if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.map((v) => v.trim()).filter(Boolean);
	return "invalid";
}

/** 按顶层逗号切分，括号里的逗号不切，例如 `Agent(worker, researcher), Read`。 */
function splitList(text: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let current = "";
	for (const ch of text) {
		if (ch === "(") depth++;
		if (ch === ")") depth = Math.max(0, depth - 1);
		if (ch === "," && depth === 0) {
			out.push(current);
			current = "";
		} else current += ch;
	}
	out.push(current);
	return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Claude Code 工具名到 pi 工具名的对照。
 * 定义文件常常直接从 Claude Code 拷过来，写的是 Read、Grep 这类名字，这里统一换算。
 */
const CLAUDE_TOOL_ALIASES: Record<string, string[]> = {
	read: ["read"],
	grep: ["grep"],
	glob: ["find"],
	ls: ["ls"],
	bash: ["bash"],
	edit: ["edit"],
	multiedit: ["edit"],
	write: ["write"],
	agent: ["agent"],
	task: ["agent"],
	sendmessage: ["send_message"],
	taskstop: ["task_stop"],
};

/** 把工具条目换成候选的 pi 工具名：去掉 `Bash(git push *)` 这类说明符，按 Claude Code 名字换算，大小写不敏感。 */
function toolCandidates(entry: string): string[] {
	const bare = entry.replace(/\(.*\)\s*$/s, "").trim();
	const key = bare.toLowerCase();
	return CLAUDE_TOOL_ALIASES[key] ?? [key];
}

/**
 * 按定义里的 tools 与 disallowedTools 算出子 agent 实际拿到的工具。
 * available 是子 agent 可以继承的全部工具名。
 * 定义写了 tools 却一个都解析不到时返回错误，与 Claude Code「无法以零个工具启动」一致。
 */
export function resolveTools(def: Pick<AgentDefinition, "tools" | "disallowedTools">, available: readonly string[]): { tools: string[] } | { error: string } {
	const byLower = new Map(available.map((t) => [t.toLowerCase(), t]));
	const lookup = (entry: string) => toolCandidates(entry).map((c) => byLower.get(c)).filter((t): t is string => !!t);
	let tools: string[];
	if (def.tools) {
		const found = new Set<string>();
		const invalid: string[] = [];
		for (const entry of def.tools) {
			const hits = lookup(entry);
			if (hits.length) for (const h of hits) found.add(h);
			else invalid.push(entry);
		}
		if (found.size === 0) return { error: `tools 里没有一项能对应到可用工具：${invalid.join("、")}。可用工具：${available.join("、")}` };
		tools = available.filter((t) => found.has(t));
	} else {
		tools = [...available];
	}
	if (def.disallowedTools) {
		const removed = new Set(def.disallowedTools.flatMap(lookup));
		tools = tools.filter((t) => !removed.has(t));
	}
	return { tools };
}

/** 模型解析只用到的字段，与 pi 的 Model 兼容。 */
export interface ModelLike {
	provider: string;
	id: string;
	name?: string;
}

/** 可以按 provider 与 ID 查模型、也能列出全部模型的来源，与 pi 的 ModelRuntime 兼容。 */
export interface ModelSource<M> {
	getModel(provider: string, id: string): M | undefined;
	getModels(): readonly M[];
}

/**
 * 按 Claude Code 的顺序解析子 agent 的模型：调用参数、定义里的 model、PI_SUBAGENT_MODEL、调用方的模型。
 * 定义写 inherit 时直接用调用方的模型，不再看环境变量。
 * 找不到时退回调用方的模型并给出说明。
 */
export function resolveModel<M extends ModelLike>(spec: string | undefined, envModel: string | undefined, fallback: M, runtime: ModelSource<M>, inheritExplicit = false): { model: M; warning?: string } {
	const wanted = spec && spec !== "inherit" ? spec : inheritExplicit ? undefined : envModel?.trim() || undefined;
	if (!wanted || wanted === "inherit") return { model: fallback };
	const slash = wanted.indexOf("/");
	let found: M | undefined;
	if (slash > 0) found = runtime.getModel(wanted.slice(0, slash), wanted.slice(slash + 1));
	if (!found) {
		const all = runtime.getModels();
		const matches = all.filter((m) => m.id === wanted || m.name === wanted);
		found = matches.find((m) => m.provider === fallback.provider) ?? matches[0];
	}
	if (found) return { model: found };
	return { model: fallback, warning: `找不到模型「${wanted}」，subagent 改用 ${fallback.provider}/${fallback.id}` };
}

/** Claude Code 的 effort 映射到 pi 的 thinking level；max 映射到 pi 的最高档 xhigh，实际会按模型能力再截断。 */
export function effortToThinking(effort: Effort | undefined): Exclude<Effort, "max"> | undefined {
	if (!effort) return undefined;
	return effort === "max" ? "xhigh" : effort;
}

/** 各作用域的定义来源。 */
export interface AgentSources {
	cwd: string;
	/** pi 的全局配置目录，通常是 ~/.pi/agent。 */
	agentDir: string;
	/** 本包内置定义所在目录。 */
	builtinDir: string;
	/** --agents 启动参数的原始 JSON。 */
	cliJson?: string;
}

/** 合并后的全部 agent 与加载诊断。 */
export interface LoadedAgents {
	agents: Map<string, AgentDefinition>;
	diagnostics: Diagnostic[];
	/** description 合计超过阈值时的警告。 */
	warning?: string;
}

/** 扫描全部作用域并按优先级合并。 */
export function loadAgents(sources: AgentSources): LoadedAgents {
	const diagnostics: Diagnostic[] = [];
	const agents = new Map<string, AgentDefinition>();
	// 从低到高依次写入，后写入的覆盖先写入的。
	const put = (list: AgentDefinition[]) => {
		for (const a of list) agents.set(a.name, a);
	};
	put(scanDir(sources.builtinDir, "builtin", diagnostics));
	put(scanDir(join(sources.agentDir, "agents"), "user", diagnostics));
	// 项目目录从仓库根往 cwd 方向写入，离 cwd 近的最后写入、优先级最高。
	for (const dir of projectAgentDirs(sources.cwd).reverse()) put(scanDir(dir, "project", diagnostics));
	if (sources.cliJson) {
		const cli = parseCliAgents(sources.cliJson);
		diagnostics.push(...cli.diagnostics);
		put(cli.agents);
	}
	const tokens = [...agents.values()].reduce((n, a) => n + estimateTokens(a.description), 0);
	const warning = tokens > DESCRIPTION_TOKEN_WARN ? `所有 subagent 的 description 合计约 ${tokens} token，超过 ${DESCRIPTION_TOKEN_WARN}，会挤占每一轮的上下文，建议精简` : undefined;
	return { agents, diagnostics, warning };
}

/**
 * 从 cwd 向上直到仓库根，列出每一级存在的 .pi/agents 目录，离 cwd 近的在前。
 * 不在 git 仓库里时只看 cwd 这一级。
 */
export function projectAgentDirs(cwd: string): string[] {
	const dirs: string[] = [];
	const start = resolve(cwd);
	let dir = start;
	const root = findRepoRoot(start);
	for (;;) {
		const candidate = join(dir, ".pi", "agents");
		if (isDir(candidate)) dirs.push(candidate);
		if (!root || dir === root) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dirs;
}

function findRepoRoot(start: string): string | undefined {
	let dir = start;
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** 递归读取目录下的 .md 定义；同一目录树里重名时按路径排序先读到的为准。 */
function scanDir(dir: string, source: AgentSource, diagnostics: Diagnostic[]): AgentDefinition[] {
	if (!isDir(dir)) return [];
	const out: AgentDefinition[] = [];
	const seen = new Set<string>();
	for (const file of listMarkdown(dir)) {
		let content: string;
		try {
			content = readFileSync(file, "utf8");
		} catch (err) {
			diagnostics.push({ path: file, message: `无法读取：${firstLine(err)}` });
			continue;
		}
		const r = parseAgentFile(content, file, source);
		if (r.diagnostic) diagnostics.push(r.diagnostic);
		diagnostics.push(...r.notes);
		if (!r.agent) continue;
		if (seen.has(r.agent.name)) {
			diagnostics.push({ path: file, message: `同一目录下已有名为「${r.agent.name}」的 agent，本文件被忽略` });
			continue;
		}
		seen.add(r.agent.name);
		out.push(r.agent);
	}
	return out;
}

function listMarkdown(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		let names: string[];
		try {
			names = readdirSync(d).sort();
		} catch {
			// 目录在扫描过程中被删除或无权限时跳过这一支，不影响其他定义。
			return;
		}
		for (const n of names) {
			if (n.startsWith(".")) continue;
			const p = join(d, n);
			if (isDir(p)) walk(p);
			else if (n.endsWith(".md")) out.push(p);
		}
	};
	walk(dir);
	return out;
}

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** 粗略估算 token：ASCII 约 4 个字符一个 token，其余字符（中文等）按每字一个 token 计，宁可高估。 */
export function estimateTokens(text: string): number {
	let ascii = 0;
	let other = 0;
	for (const ch of text) {
		if (ch.charCodeAt(0) < 128) ascii++;
		else other++;
	}
	return Math.ceil(ascii / 4) + other;
}

/** 生成写进 agent 工具描述里的可用 agent 列表。 */
export function renderAgentRoster(agents: Iterable<AgentDefinition>): string {
	const lines: string[] = [];
	for (const a of agents) {
		const tools = a.tools ? a.tools.join(", ") : "All tools";
		lines.push(`- ${a.name}: ${a.description} (Tools: ${tools})`);
	}
	return lines.join("\n");
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function firstLine(err: unknown): string {
	return (err instanceof Error ? err.message : String(err)).split("\n")[0];
}
