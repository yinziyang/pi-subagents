// P0 spike：确认 faux provider 能在同一进程里同时驱动主会话与子会话。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const systemText = (messages: any[]) => {
	const sys = messages.find((m) => m.role === "system");
	return sys ? JSON.stringify({ content: sys.content, sections: sys.sections }) : "";
};

test("faux 同时驱动父子会话", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pisub-spike-"));
	const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	runtime.registerNativeProvider(faux.provider);
	const model = runtime.getModel("faux", "m") ?? faux.getModel();

	const route = (context: any) => {
		const msgs = context.messages;
		if (systemText(msgs).includes("CHILD-MARK")) return fauxAssistantMessage(fauxText("child-done"));
		const last = msgs[msgs.length - 1];
		if (last?.role === "toolResult") return fauxAssistantMessage(fauxText(`parent-final: ${JSON.stringify(last.content)}`));
		return fauxAssistantMessage(fauxToolCall("spawn", {}), { stopReason: "toolUse" });
	};
	faux.setResponses(Array.from({ length: 10 }, () => route));

	const newSession = async (extensionFactories: any[], systemPrompt?: string) => {
		const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, noSkills: true, noContextFiles: true, systemPrompt, extensionFactories } as any);
		await loader.reload();
		const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model, resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }) } as any);
		await (session as any).bindExtensions({ mode: "print" });
		return session;
	};

	const parent = await newSession([
		(pi: ExtensionAPI) => {
			pi.registerTool({
				name: "spawn",
				label: "spawn",
				description: "spawn child",
				parameters: Type.Object({}),
				async execute() {
					const child = await newSession([], "CHILD-MARK");
					await child.prompt("do it");
					const last = [...(child.messages as any[])].reverse().find((m) => m.role === "assistant");
					child.dispose();
					return { content: [{ type: "text", text: last.content[0].text }], details: {} };
				},
			} as any);
		},
	]);
	await parent.prompt("go");
	const final = [...(parent.messages as any[])].reverse().find((m) => m.role === "assistant");
	parent.dispose();
	assert.match(JSON.stringify(final.content), /parent-final: .*child-done/);
	assert.equal(faux.state.callCount, 3);
});
