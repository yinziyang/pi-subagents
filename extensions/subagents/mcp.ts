// 与 pi 内置 MCP 的对接：让子会话像主会话一样连上 MCP 服务，并支持定义里只给单个子 agent 用的内联服务。
//
// 为什么要自己注入：pi 的 CLI 把 MCP、codemode、tool_search 作为内置扩展加载，但用 SDK 创建的会话（子会话就是）不会自动带上它们。
// 注入时带上与 CLI 相同的 builtin、replaceable 标记，加载器就按 CLI 的规则处理：
//   - 设置里写了 `-builtin:mcp`、主会话用了 `--no-mcp` 时不加载。
//   - 装了自带 `/mcp` 的第三方 MCP 扩展时让位给它。
// 每个子会话各自连接服务、各自起 stdio 进程，子会话关闭时一并断开。
// 简化：不复用主会话已有的连接，服务进程多到成为负担时改为在主会话里代理调用。

import { createCodemodeExtension, createMcpExtension, createToolSearchExtension, type ExtensionAPI, type ExtensionFactory, type InlineExtension, type McpServerConfig } from "@earendil-works/pi-coding-agent";
import { type AgentDefinition, type InlineMcpServer, mcpPattern } from "./definitions.ts";

/** pi 内置 MCP 扩展的名字，`disabledBuiltinExtensions` 与设置里的 `-builtin:mcp` 用的就是它。 */
export const BUILTIN_MCP = "mcp";

/** 子会话要加载的内置扩展。每个子会话都要新建一份，内置扩展的工厂各自持有连接状态。 */
export function builtinMcpExtensions(): InlineExtension[] {
	return [
		{ name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
		{ name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
		{ name: BUILTIN_MCP, factory: createMcpExtension(), replaceable: true, builtin: true },
	];
}

/** 服务名在工具名里的写法：pi 把字母、数字、下划线以外的字符都换成下划线，见 pi 文档 mcp.md 的 Configuration rules。 */
function toolPrefix(server: string): string {
	return `mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}__`;
}

/**
 * 子会话工具白名单里要追加的 MCP 条目。
 * pi 的规则是：白名单里只要有一项以 `mcp__` 开头，就只保留匹配的 MCP 工具。
 * 从主会话继承的工具名恰好会带上这类条目，所以必须显式放开：
 *   - 定义没写 tools（继承全部）：`mcp__*`，主会话后连上的服务也能用。
 *   - 定义里声明的服务（引用或内联）：`mcp__<服务>__*`。
 *   - 声明了引用的服务时再加 codemode 与 tool_search，默认 codemode 暴露的服务要靠它们才调得到。内联服务默认 direct，不需要。
 */
export function mcpToolEntries(def: Pick<AgentDefinition, "tools" | "mcpServers">): string[] {
	const entries: string[] = [];
	if (def.tools === undefined) entries.push("mcp__*");
	const refs = def.mcpServers?.refs ?? [];
	for (const name of [...refs, ...(def.mcpServers?.inline.map((s) => s.name) ?? [])]) entries.push(`${toolPrefix(name)}*`);
	if (refs.length) entries.push("codemode", "tool_search");
	return entries;
}

/** 定义里 disallowedTools 的 MCP 条目，作为 excludeTools 交给子会话，模式同样生效。 */
export function mcpExcludes(def: Pick<AgentDefinition, "disallowedTools">): string[] {
	return (def.disallowedTools ?? []).map(mcpPattern).filter((p): p is string => p !== undefined);
}

/**
 * 子会话的内联扩展：加载时就把内联服务注册进子会话自己的 MCP，随会话启动一起连接。
 * 没写 exposure 的默认 direct，子 agent 像在 Claude Code 里一样直接看到这些工具。
 * 注册失败（配置不合法、与本扩展注册过的同名）通过 onError 报告，其余服务照常注册。
 * 与 mcp.json 同名时 pi 以 mcp.json 为准，不报错。
 */
export function inlineServersExtension(servers: readonly InlineMcpServer[], onError: (message: string) => void): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		for (const server of servers) {
			try {
				pi.registerMcpServer(server.name, { exposure: "direct", ...structuredClone(server.config) } as McpServerConfig);
			} catch (err) {
				onError(`内联 MCP 服务「${server.name}」没有注册成功：${err instanceof Error ? err.message : String(err)}`);
			}
		}
	};
}
