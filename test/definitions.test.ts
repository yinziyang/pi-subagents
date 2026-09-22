import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DESCRIPTION_TOKEN_WARN, loadAgents, parseAgentFile, parseCliAgents, projectAgentDirs, renderAgentRoster, resolveTools } from "../extensions/subagents/definitions.ts";

const BUILTIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "agents");
const md = (fm: string, body = "正文") => `---\n${fm}\n---\n${body}\n`;
const write = (path: string, content: string) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
};

test("tools 的逗号字符串与 YAML 列表结果相同，省略表示继承", () => {
	const a = parseAgentFile(md("name: a\ndescription: d\ntools: Read, Grep, Bash"), "a.md", "user").agent;
	const b = parseAgentFile(md("name: b\ndescription: d\ntools:\n  - Read\n  - Grep\n  - Bash"), "b.md", "user").agent;
	assert.deepEqual(a?.tools, ["Read", "Grep", "Bash"]);
	assert.deepEqual(b?.tools, a?.tools);
	assert.equal(parseAgentFile(md("name: c\ndescription: d"), "c.md", "user").agent?.tools, undefined);
	assert.deepEqual(parseAgentFile(md("name: d\ndescription: d\ntools: Agent(worker, researcher), Read"), "d.md", "user").agent?.tools, ["Agent(worker, researcher)", "Read"], "括号里的逗号不切分");
});

test("resolveTools 换算 Claude Code 工具名，disallowedTools 带说明符时移除整个工具", () => {
	const available = ["read", "bash", "edit", "write", "grep", "find", "ls", "agent"];
	assert.deepEqual(resolveTools({ tools: ["Read", "Glob", "Bash(git *)"] }, available), { tools: ["read", "bash", "find"] });
	assert.deepEqual(resolveTools({ disallowedTools: ["Bash(git push *)", "Write"] }, available), { tools: ["read", "edit", "grep", "find", "ls", "agent"] });
	assert.deepEqual(resolveTools({ tools: ["Task", "read"] }, available), { tools: ["read", "agent"] }, "Task 是 Agent 的旧名");
	const r = resolveTools({ tools: ["WebFetch", "NotebookEdit"] }, available);
	assert.ok("error" in r && /WebFetch、NotebookEdit/.test(r.error), "一个都解析不到时报错并列出条目");
	assert.deepEqual(resolveTools({ tools: ["read", "WebFetch"] }, available), { tools: ["read"] }, "部分无效时忽略无效项");
});

test("跳过规则逐条对齐 Claude Code", () => {
	const noName = parseAgentFile(md("description: 只是文档"), "doc.md", "user");
	assert.equal(noName.agent, undefined);
	assert.equal(noName.diagnostic, undefined, "缺 name 静默跳过");

	const notFirstLine = parseAgentFile(`说明\n${md("name: x\ndescription: d")}`, "x.md", "user");
	assert.equal(notFirstLine.agent, undefined);
	assert.equal(notFirstLine.diagnostic, undefined, "--- 不在首行静默跳过");

	for (const bad of ["-dash", "plugin:reviewer"]) {
		const r = parseAgentFile(md(`name: "${bad}"\ndescription: d`), "bad.md", "user");
		assert.equal(r.agent, undefined);
		assert.match(r.diagnostic?.message ?? "", /不能以 - 开头/);
	}

	const noDesc = parseAgentFile(md("name: nodesc"), "nodesc.md", "user");
	assert.equal(noDesc.agent, undefined);
	assert.match(noDesc.diagnostic?.message ?? "", /缺少 description/);

	const badYaml = parseAgentFile(md("name: y\ndescription: d\ntools: [read, bash"), "y.md", "user");
	assert.equal(badYaml.agent, undefined);
	assert.match(badYaml.diagnostic?.message ?? "", /不是合法的 YAML/);
});

test("字段解析：取值不对的字段忽略并记诊断，定义照常加载", () => {
	const r = parseAgentFile(md("name: f\ndescription: d\nmaxTurns: 0\neffort: huge\ncolor: black\nmodel: openai/gpt-x\nbackground: true\nomitAgentsMd: true\nskills: a, b"), "f.md", "user");
	assert.equal(r.agent?.maxTurns, undefined);
	assert.equal(r.agent?.effort, undefined);
	assert.equal(r.agent?.color, undefined);
	assert.equal(r.agent?.model, "openai/gpt-x");
	assert.equal(r.agent?.background, true);
	assert.equal(r.agent?.omitContextFiles, true, "omitAgentsMd 与 omitClaudeMd 等价");
	assert.deepEqual(r.agent?.skills, ["a", "b"]);
	assert.equal(r.notes.length, 3);
	assert.equal(parseAgentFile(md("name: g\ndescription: d\nomitClaudeMd: true\nmaxTurns: 5\neffort: high"), "g.md", "user").agent?.maxTurns, 5);
});

test("oneShot 只对内置定义生效", () => {
	const fm = md("name: o\ndescription: d\noneShot: true");
	assert.equal(parseAgentFile(fm, "o.md", "builtin").agent?.oneShot, true);
	assert.equal(parseAgentFile(fm, "o.md", "user").agent?.oneShot, false);
});

test("不支持的字段产生诊断，但 agent 照常加载", () => {
	const r = parseAgentFile(md("name: h\ndescription: d\nhooks: {}\nmcpServers: [slack]\npermissionMode: plan"), "h.md", "user");
	assert.ok(r.agent);
	assert.equal(r.notes.length, 1);
	assert.match(r.notes[0].message, /mcpServers、hooks 字段本期不支持/);
	assert.doesNotMatch(r.notes[0].message, /permissionMode/, "permissionMode 静默忽略");
});

test("parseCliAgents 读 prompt 字段作系统提示词，JSON 错误整体报诊断", () => {
	const r = parseCliAgents(JSON.stringify({ "code-reviewer": { description: "审查", prompt: "你是审查者", tools: ["Read", "Grep"], model: "inherit" } }));
	assert.equal(r.agents[0].name, "code-reviewer");
	assert.equal(r.agents[0].systemPrompt, "你是审查者");
	assert.equal(r.agents[0].source, "cli");
	assert.deepEqual(r.agents[0].tools, ["Read", "Grep"]);
	assert.match(parseCliAgents("{oops").diagnostics[0].message, /不是合法的 JSON/);
	assert.match(parseCliAgents(JSON.stringify({ x: { prompt: "p" } })).diagnostics[0].message, /缺少 description/);
});

test("优先级：--agents > 项目（近者优先）> 用户 > 内置，覆盖内置 Explore 后用覆盖者的 model", () => {
	const root = mkdtempSync(join(tmpdir(), "pisub-def-"));
	const agentDir = join(root, "agentdir");
	const repo = join(root, "repo");
	const cwd = join(repo, "pkg", "sub");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(cwd, { recursive: true });
	write(join(agentDir, "agents", "shared.md"), md("name: shared\ndescription: 用户"));
	write(join(agentDir, "agents", "Explore.md"), md("name: Explore\ndescription: 我的 Explore\nmodel: openai/cheap"));
	write(join(repo, ".pi", "agents", "shared.md"), md("name: shared\ndescription: 仓库根"));
	write(join(repo, ".pi", "agents", "deep", "only-root.md"), md("name: only-root\ndescription: 子目录也会被扫描"));
	write(join(repo, "pkg", ".pi", "agents", "shared.md"), md("name: shared\ndescription: 更近的项目目录"));
	write(join(repo, "pkg", ".pi", "agents", "cli-wins.md"), md("name: cli-wins\ndescription: 项目"));

	const loaded = loadAgents({ cwd, agentDir, builtinDir: BUILTIN_DIR, cliJson: JSON.stringify({ "cli-wins": { description: "参数", prompt: "p" } }) });
	assert.equal(loaded.agents.get("shared")?.description, "更近的项目目录");
	assert.equal(loaded.agents.get("only-root")?.source, "project");
	assert.equal(loaded.agents.get("cli-wins")?.source, "cli");
	assert.equal(loaded.agents.get("Explore")?.model, "openai/cheap");
	assert.equal(loaded.agents.get("Explore")?.oneShot, false, "用户覆盖的 Explore 不再是一次性的");
	assert.equal(loaded.agents.get("Plan")?.oneShot, true);
	assert.equal(loaded.agents.get("general-purpose")?.source, "builtin");
	assert.deepEqual(projectAgentDirs(cwd), [join(repo, "pkg", ".pi", "agents"), join(repo, ".pi", "agents")]);
	assert.deepEqual(loaded.diagnostics, []);
});

test("不在 git 仓库里时只看 cwd 这一级", () => {
	const root = mkdtempSync(join(tmpdir(), "pisub-norepo-"));
	const cwd = join(root, "a");
	write(join(root, ".pi", "agents", "up.md"), md("name: up\ndescription: 上一级"));
	mkdirSync(cwd, { recursive: true });
	assert.deepEqual(projectAgentDirs(cwd), []);
});

test("同一目录树里重名时只取一个并记诊断", () => {
	const root = mkdtempSync(join(tmpdir(), "pisub-dup-"));
	write(join(root, "agents", "a.md"), md("name: dup\ndescription: 一"));
	write(join(root, "agents", "b", "a.md"), md("name: dup\ndescription: 二"));
	const loaded = loadAgents({ cwd: root, agentDir: root, builtinDir: join(root, "none") });
	assert.equal(loaded.agents.get("dup")?.description, "一");
	assert.match(loaded.diagnostics[0].message, /已有名为「dup」/);
});

test("description 合计超过阈值时警告，仍全部加载", () => {
	const root = mkdtempSync(join(tmpdir(), "pisub-big-"));
	const long = "描述".repeat(DESCRIPTION_TOKEN_WARN / 2 + 10);
	write(join(root, "agents", "big.md"), md(`name: big\ndescription: ${long}`));
	const loaded = loadAgents({ cwd: root, agentDir: root, builtinDir: BUILTIN_DIR });
	assert.match(loaded.warning ?? "", /超过 15000/);
	assert.ok(loaded.agents.has("big"));
	assert.equal(loadAgents({ cwd: root, agentDir: join(root, "x"), builtinDir: BUILTIN_DIR }).warning, undefined);
});

test("renderAgentRoster 列出名字、描述与工具", () => {
	const loaded = loadAgents({ cwd: tmpdir(), agentDir: join(tmpdir(), "none-agentdir"), builtinDir: BUILTIN_DIR });
	const roster = renderAgentRoster(loaded.agents.values());
	assert.match(roster, /^- general-purpose: .*\(Tools: All tools\)$/m);
	assert.match(roster, /^- Explore: .*\(Tools: read, grep, find, ls, bash\)$/m);
});
