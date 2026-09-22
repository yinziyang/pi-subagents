import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isSelfExtensionPath } from "../extensions/subagents/runner.ts";

/** 在 root 下建一个包：package.json 的 name 与 extensions/subagents/index.ts。 */
function makePackage(root: string, name: string): string {
	const entry = join(root, "extensions", "subagents", "index.ts");
	mkdirSync(join(root, "extensions", "subagents"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name }));
	writeFileSync(entry, "export default () => {};\n");
	return entry;
}

test("本包自身：经符号链接的路径、另一份同名副本都认作本包，其他包不算", () => {
	const dir = mkdtempSync(join(tmpdir(), "pisub-self-"));
	const self = makePackage(join(dir, "dev"), "pi-subagents");
	const selfDir = join(dir, "dev", "extensions", "subagents");
	symlinkSync(join(dir, "dev"), join(dir, "link"));
	const copy = makePackage(join(dir, "installed"), "pi-subagents");
	const other = makePackage(join(dir, "goal"), "pi-goal");
	mkdirSync(join(dir, "loose"));
	writeFileSync(join(dir, "loose", "x.ts"), "");

	assert.equal(isSelfExtensionPath(self, selfDir), true);
	assert.equal(isSelfExtensionPath(join(dir, "link", "extensions", "subagents", "index.ts"), selfDir), true, "经符号链接加载的同一份");
	assert.equal(isSelfExtensionPath(copy, selfDir), true, "另一份安装的副本");
	assert.equal(isSelfExtensionPath(join(dir, "installed"), selfDir), true, "以包目录登记的副本");
	assert.equal(isSelfExtensionPath(other, selfDir), false);
	assert.equal(isSelfExtensionPath(join(dir, "loose", "x.ts"), selfDir), false, "不在任何包里的扩展");
	assert.equal(isSelfExtensionPath(join(dir, "missing.ts"), selfDir), false, "不存在的路径");
	assert.equal(isSelfExtensionPath("<inline:1>", selfDir), false, "extensionFactories 注入的扩展，即使当前目录在本包里");
});
