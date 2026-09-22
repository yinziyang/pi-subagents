// 与 pi-mcp-adapter 的对接，只经 pi.events 上的公开事件，两个包之间没有代码依赖。
//
// 用到适配器的运行时注册事件（pi-mcp-adapter:runtime-register:v1），在子会话里把内联服务注册给子会话自己的适配器实例。
// 每个会话的事件总线是独立的，所以注册只对这个子 agent 可见，子会话关闭时适配器随之断开这些服务。
// 监听方同步写回 result，事件发出后当场就能读到结果；没装适配器时没有人写，result 保持为空。

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { InlineMcpServer } from "./definitions.ts";

/** pi-mcp-adapter 注册的代理工具名；子 agent 用它调用内联服务的工具。 */
export const MCP_TOOL = "mcp";

const MCP_RUNTIME_REGISTER_EVENT = "pi-mcp-adapter:runtime-register:v1";

/** 运行时注册的请求体，字段由适配器定义。 */
interface RegisterRequest {
	version: 1;
	name: string;
	definition: Record<string, unknown>;
	result?: { ok: true } | { ok: false; error: Error };
}

/**
 * 子会话的内联扩展：session_start 时把内联服务逐个注册给子会话的适配器。
 * 注册失败（重名、没装适配器）通过 onError 报告，其余服务照常注册。
 * 必须等 session_start：这时子会话的扩展都已加载，适配器的监听已经挂上。
 */
export function inlineServersExtension(servers: readonly InlineMcpServer[], onError: (message: string) => void): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.on("session_start", () => {
			for (const server of servers) {
				const request: RegisterRequest = { version: 1, name: server.name, definition: structuredClone(server.config) };
				pi.events.emit(MCP_RUNTIME_REGISTER_EVENT, request);
				const result = request.result;
				if (!result) onError(`内联 MCP 服务「${server.name}」没有注册成功：没有安装 pi-mcp-adapter`);
				else if (!result.ok) onError(`内联 MCP 服务「${server.name}」没有注册成功：${result.error.message}`);
			}
		});
	};
}
