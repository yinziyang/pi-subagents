#!/usr/bin/env node
// 真实 pi 的端到端验收：每个场景在临时项目里跑一次 `pi -p`，再解析主会话与子 agent 的记录文件逐条断言。
// 只看产物，不看模型怎么说。会调用真实模型、消耗 token。
//
// 用法：node test/e2e/e2e.mjs [场景名 ...]，不带参数跑全部；PI_E2E_KEEP=1 时保留临时目录。

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "extensions", "subagents", "index.ts");
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const PI_DEFAULT = "You are an expert coding assistant operating inside pi";

// ---------- 记录解析 ----------

const readJsonl = (file) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** 找到 cwd 下最新的主会话记录。 */
function latestMainSession(cwd) {
	const real = realpathSync(cwd);
	const root = join(AGENT_DIR, "sessions");
	let best;
	for (const d of readdirSync(root)) {
		const dir = join(root, d);
		if (!statSync(dir).isDirectory()) continue;
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".jsonl")) continue;
			const p = join(dir, f);
			const mtime = statSync(p).mtimeMs;
			if (best && mtime <= best.mtime) continue;
			const header = JSON.parse(readFileSync(p, "utf8").split("\n")[0]);
			if (header.cwd === real || header.cwd === cwd) best = { path: p, mtime, id: header.id };
		}
	}
	return best;
}

const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join(""));

/** 解析一次运行：主会话的 agent 调用与结果，以及每个子 agent 的记录。 */
function inspect(cwd) {
	const main = latestMainSession(cwd);
	if (!main) throw new Error(`找不到 ${cwd} 的主会话记录`);
	const entries = readJsonl(main.path);
	const messages = entries.filter((e) => e.type === "message").map((e) => e.message);
	const calls = [];
	for (const m of messages) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const b of m.content) if (b.type === "toolCall" && b.name === "agent") calls.push({ id: b.id, args: b.arguments });
	}
	const results = messages.filter((m) => m.role === "toolResult" && m.toolName === "agent");
	for (const c of calls) c.result = results.find((r) => r.toolCallId === c.id);
	const notifications = entries.filter((e) => e.type === "custom_message" && e.customType === "pi-subagents-notification");
	const childDir = join(AGENT_DIR, "subagent-sessions", main.id);
	const children = existsSync(childDir)
		? readdirSync(childDir).filter((f) => f.endsWith(".jsonl")).map((f) => {
				const ce = readJsonl(join(childDir, f));
				const cm = ce.filter((e) => e.type === "message").map((e) => e.message);
				const system = cm.find((m) => m.role === "system");
				const assistants = cm.filter((m) => m.role === "assistant");
				const usage = assistants.reduce((u, m) => ({ input: u.input + (m.usage?.input ?? 0), output: u.output + (m.usage?.output ?? 0) }), { input: 0, output: 0 });
				const toolCalls = assistants.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === "toolCall") : []));
				const marker = ce.find((e) => e.type === "custom" && e.customType === "pi-subagents-child")?.data;
				return { file: join(childDir, f), header: ce[0], marker, system: JSON.stringify(system ?? {}), sections: Object.keys(system?.sections ?? {}), messages: cm, entries: ce, toolCalls, usage, finalText: textOf(assistants[assistants.length - 1]) };
			})
		: [];
	const finalText = textOf(messages.filter((m) => m.role === "assistant").pop());
	return { main, entries, messages, calls, notifications, children, finalText };
}

// ---------- 运行与断言 ----------

function makeProject(files = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pisub-e2e-"));
	spawnSync("git", ["init", "-q"], { cwd: dir });
	for (const [p, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, p)), { recursive: true });
		writeFileSync(join(dir, p), content);
	}
	return dir;
}

function runPi(cwd, prompt, { args = [], env = {}, timeoutMs = 600_000 } = {}) {
	const r = spawnSync("pi", ["-p", "-e", EXT, ...args, prompt], { cwd, env: { ...process.env, ...env }, input: "", encoding: "utf8", timeout: timeoutMs });
	return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: r.error?.code === "ETIMEDOUT" };
}

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? `\n       ${detail}` : ""}`);
	if (!ok) failures++;
}

const md = (fm, body) => `---\n${fm}\n---\n${body}\n`;

// ---------- 场景 ----------

const scenarios = {
	/** P2-7：子 agent 看不到主会话历史。 */
	isolation() {
		const cwd = makeProject();
		runPi(cwd, "记住：暗号是 BLUE-42。现在用 agent 工具派一个 general-purpose 子 agent（run_in_background 设为 false），任务原文是「你知道暗号吗？知道就说出来，不知道就回答不知道。不要调用工具。」。然后把它的回答原样告诉我。");
		const r = inspect(cwd);
		const child = r.children[0];
		check("派出了 1 个子 agent", r.children.length === 1, `实际 ${r.children.length}`);
		check("子 agent 的记录里没有暗号", child && !JSON.stringify(child.messages).includes("BLUE-42"));
		return cwd;
	},

	/** P2-8、P2-9：系统提示词用定义正文，附加项目 AGENTS.md；omitClaudeMd 与 Explore 不附加。 */
	systemPrompt() {
		const cwd = makeProject({
			"AGENTS.md": "项目规范 PROJ-MARK：回复尽量简短。\n",
			".pi/agents/marked.md": md("name: marked\ndescription: 测试系统提示词\ntools: read", "AGENT-MARK：只回复 done，不调用工具。"),
			".pi/agents/bare.md": md("name: bare\ndescription: 不带上下文文件\ntools: read\nomitClaudeMd: true", "BARE-MARK：只回复 done，不调用工具。"),
		});
		runPi(cwd, "依次用 agent 工具调用 marked、bare、Explore 三个 subagent，都设 run_in_background 为 false，任务都是「只回复 done，不要调用任何工具」。三个都返回后只回复 ok。");
		const r = inspect(cwd);
		const find = (mark) => r.children.find((c) => c.system.includes(mark));
		const marked = find("AGENT-MARK");
		const bare = find("BARE-MARK");
		const explore = r.children.find((c) => c.system.includes("只读的代码探索 agent"));
		check("marked：系统提示词含定义正文与项目 AGENTS.md", marked && marked.system.includes("PROJ-MARK"));
		check("marked：不含 pi 默认系统提示词开头", marked && !marked.system.includes(PI_DEFAULT));
		check("bare（omitClaudeMd）：不含项目 AGENTS.md 与常驻规范", bare && !bare.system.includes("PROJ-MARK") && !bare.sections.includes("coding-standards"), bare ? `sections=${bare.sections}` : "没有找到 bare");
		check("Explore：不含项目 AGENTS.md 与常驻规范", explore && !explore.system.includes("PROJ-MARK") && !explore.sections.includes("coding-standards"), explore ? `sections=${explore.sections}` : "没有找到 Explore");
		return cwd;
	},

	/** P2-10：主会话的扩展在子 agent 里照常生效（coding-standards 拦下不合规的写入）。 */
	extensions() {
		const cwd = makeProject();
		runPi(cwd, "用 agent 工具派一个 general-purpose 子 agent（run_in_background 设为 false），任务是「用 write 工具新建 demo.go：package main，外加一个函数 func Add(a, b int) int { return a + b }，函数上方写英文注释 // Add adds two numbers.。按工具反馈修正直到写入成功，然后报告最终文件内容。」。完成后只回复 ok。");
		const r = inspect(cwd);
		const child = r.children[0];
		const blocked = child && JSON.stringify(child.messages).includes("[coding-standards]");
		check("子 agent 记录里出现 coding-standards 的反馈", blocked);
		const file = join(cwd, "demo.go");
		const content = existsSync(file) ? readFileSync(file, "utf8") : "";
		check("最终文件的注释是中文", /\/\/.*[一-龥]/.test(content), content.slice(0, 200));
		return cwd;
	},

	/** P2-11：tools 限制生效。 */
	tools() {
		const cwd = makeProject({ ".pi/agents/reader.md": md("name: reader\ndescription: 只能读\ntools: read", "你只能读文件。") });
		runPi(cwd, "用 agent 工具调用 reader（run_in_background 设为 false），任务是「新建文件 out.txt，内容写 hello。做不到就说明原因。」。然后原样转述它的回答。");
		const r = inspect(cwd);
		const child = r.children[0];
		const names = child ? child.toolCalls.map((t) => t.name) : [];
		check("reader 没有任何 write、edit、bash 调用", child && !names.some((n) => ["write", "edit", "bash"].includes(n)), `调用了 ${names.join(",")}`);
		check("没有生成 out.txt", !existsSync(join(cwd, "out.txt")));
		return cwd;
	},

	/** P2-12：前台工具结果的用量等于子 agent 各轮用量之和。 */
	usage() {
		const cwd = makeProject();
		runPi(cwd, "用 agent 工具派一个 general-purpose 子 agent（run_in_background 设为 false），任务是「用 ls 看一下当前目录，然后回复你看到了什么」。完成后只回复 ok。");
		const r = inspect(cwd);
		const call = r.calls[0];
		const child = r.children[0];
		check("工具结果带 usage", !!call?.result?.usage);
		check("usage.input 等于子 agent 各轮之和", call?.result?.usage?.input === child?.usage.input, `${call?.result?.usage?.input} vs ${child?.usage.input}`);
		check("usage.output 等于子 agent 各轮之和", call?.result?.usage?.output === child?.usage.output, `${call?.result?.usage?.output} vs ${child?.usage.output}`);
		return cwd;
	},

	/** P3-7：-p 模式等后台子 agent 完成、送回通知、主会话处理完通知才退出。 */
	printWait() {
		const cwd = makeProject();
		const started = Date.now();
		const out = runPi(cwd, "用 agent 工具在后台（run_in_background 设为 true）派一个 general-purpose 子 agent，任务是「用 bash 执行 sleep 5 && echo SLOW-DONE-31，然后报告输出」。派出后你这一轮直接结束，只回复「已派出」。之后收到它的结果通知时，把它报告里的输出原样告诉我。");
		const r = inspect(cwd);
		check("进程正常退出", out.code === 0, `code=${out.code} ${out.stderr.slice(-300)}`);
		check("耗时覆盖了子 agent 的 sleep 5", Date.now() - started > 5_000);
		check("主会话收到 1 条通知", r.notifications.length === 1, `实际 ${r.notifications.length}`);
		check("最终回复提到子 agent 的结果", /SLOW-DONE-31/.test(r.finalText), r.finalText.slice(0, 200));
		return cwd;
	},

	/** P3-8：深度上限。 */
	depth() {
		const cwd = makeProject();
		runPi(cwd, "用 agent 工具派一个 general-purpose 子 agent（run_in_background 设为 false），任务原文是「如果你有 agent 工具，就用它再派一个 general-purpose 子 agent（run_in_background 设为 false），把这段任务原文原样交给它；如果你没有 agent 工具，就回复 LEAF 和你所在的层数说明」。完成后只回复 ok。", { env: { PI_SUBAGENT_MAX_DEPTH: "2" } });
		const r = inspect(cwd);
		check("一共只有 2 层子 agent", r.children.length === 2, `实际 ${r.children.length}`);
		const second = r.children.find((c) => !c.toolCalls.some((t) => t.name === "agent"));
		check("第 2 层没有调用 agent", !!second);
		check("第 2 层拿不到 agent 工具", second && !second.messages.some((m) => m.role === "system" && JSON.stringify(m).includes('"name":"agent"')));
		return cwd;
	},

	/** P4-7、P4-8：重启 pi 后恢复会话，仍能用 send_message 续聊；子 agent 记录不出现在 pi 自己的会话目录里。 */
	resumeAcrossRestart() {
		const cwd = makeProject();
		runPi(cwd, "用 agent 工具派一个 general-purpose 子 agent，name 设为 keeper，run_in_background 设为 false，任务原文是「记住数字 7。只回复：记住了。不要调用工具。」。完成后只回复 ok。");
		const first = inspect(cwd);
		const child = first.children[0];
		const before = child ? child.messages.filter((m) => m.role === "assistant").length : 0;
		const out = runPi(cwd, "用 send_message 发给 keeper，消息是「我让你记住的数字是几？只回复数字。」。收到它的结果通知后，把它的回答原样告诉我。", { args: ["--session", first.main.path] });
		const second = inspect(cwd);
		const again = second.children.find((c) => c.file === child?.file);
		check("第二次运行正常退出", out.code === 0, out.stderr.slice(-300));
		check("续聊写回同一个子 agent 记录", second.children.length === 1 && !!again, `子 agent 数 ${second.children.length}`);
		check("子 agent 多了一轮回复", again && again.messages.filter((m) => m.role === "assistant").length > before);
		check("最终回复里有数字 7", /7/.test(second.finalText), second.finalText.slice(0, 200));
		const sessionsDir = join(AGENT_DIR, "sessions");
		const leaked = readdirSync(sessionsDir).some((d) => statSync(join(sessionsDir, d)).isDirectory() && readdirSync(join(sessionsDir, d)).some((f) => child && f.includes(child.header.id)));
		check("子 agent 记录不在 pi 的会话目录里（/resume 列表看不到）", !leaked);
		return cwd;
	},
};

// ---------- 入口 ----------

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(scenarios);
for (const name of names) {
	const fn = scenarios[name];
	if (!fn) {
		console.log(`未知场景 ${name}，可选：${Object.keys(scenarios).join("、")}`);
		failures++;
		continue;
	}
	console.log(`▶ ${name}`);
	let cwd;
	try {
		cwd = fn();
	} catch (err) {
		check("场景执行", false, err instanceof Error ? err.stack : String(err));
	}
	if (cwd && !process.env.PI_E2E_KEEP) rmSync(cwd, { recursive: true, force: true });
	else if (cwd) console.log(`  保留目录：${cwd}`);
}
console.log(failures ? `\n${failures} 项未通过` : "\n全部通过");
process.exit(failures ? 1 : 0);
