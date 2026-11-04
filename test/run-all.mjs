// test/run-all.mjs — 依次运行 test/*.test? 约定为 test-*.mjs 的测试脚本。
// 每个脚本独立进程；任一失败则最终退出码非 0，并汇总失败列表。

import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const files = (await readdir(testDir))
	.filter((name) => /^test-.*\.mjs$/.test(name))
	.sort();

if (files.length === 0) {
	console.error("no test-*.mjs files found");
	process.exit(1);
}

const failures = [];
for (const file of files) {
	const started = Date.now();
	process.stdout.write(`\n━━━ node test/${file} ━━━\n`);
	const code = await new Promise((resolve) => {
		const child = spawn(process.execPath, [path.join(testDir, file)], { stdio: "inherit", cwd: path.dirname(testDir) });
		child.on("exit", (value, signal) => resolve(signal === null ? value : 1));
		child.on("error", () => resolve(1));
	});
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	if (code !== 0) failures.push(`${file} (exit ${code})`);
	console.log(`━━━ ${code === 0 ? "PASS" : "FAIL"} ${file} (${seconds}s) ━━━`);
}

console.log("");
if (failures.length > 0) {
	console.error(`FAILED: ${failures.length}/${files.length} 个测试文件失败`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log(`PASS: 全部 ${files.length} 个测试文件通过`);
