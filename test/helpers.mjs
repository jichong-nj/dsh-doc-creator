// test/helpers.mjs — Lead 的离线测试工具：脚本化假模型 / 假联网 / 临时目录 / 任务等待。
// 只被 Lead 的 test-service / test-api / test-model 使用。

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** 创建测试用临时数据目录，返回 { dir, cleanup }。 */
export async function makeTempDir(prefix = "doc-creator-test-") {
	const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
	return {
		dir,
		async cleanup() {
			await rm(dir, { recursive: true, force: true }).catch(() => undefined);
		},
	};
}

/**
 * 脚本化假模型：queue 里每个元素是字符串（模型输出）、Error（抛错）或
 * (request) => string|Promise<string> 函数。
 * 每次 callModel 消耗一个元素；队列耗尽后返回一个兜底 REPORT。
 */
export function createMockModel({ queue = [] } = {}) {
	const model = {
		queue,
		calls: [],
		push(...items) {
			queue.push(...items);
			return model;
		},
		async callModel(request) {
			model.calls.push(request);
			const next = queue.shift();
			if (next instanceof Error) throw next;
			if (typeof next === "function") return { text: await next(request), usage: { inputTokens: 1, outputTokens: 1 } };
			if (typeof next === "string") return { text: next, usage: { inputTokens: 1, outputTokens: 1 } };
			return { text: "<REPORT>[]</REPORT>", usage: { inputTokens: 0, outputTokens: 0 } };
		},
		async listModels() {
			return {
				selection: { provider: "mock", model: "mock-1" },
				providers: [{ provider: "mock", name: "Mock", models: [{ id: "mock-1", name: "Mock 1" }] }],
			};
		},
	};
	return model;
}

/**
 * 假联网：responses 可以是数组（按调用顺序消费，元素为 [{title,url,snippet}] 或 Error）
 * 或一个函数（query => 数组/Error）。
 */
export function createMockSearch({ responses = [] } = {}) {
	const search = {
		responses,
		calls: [],
		push(...items) {
			responses.push(...items);
			return search;
		},
		async search({ query, maxResults = 6 }) {
			search.calls.push({ query, maxResults });
			const next = typeof responses[0] === "function" ? responses[0] : responses.shift();
			if (next instanceof Error) throw next;
			const sources = typeof next === "function" ? await next(query) : next;
			return { sources: (sources ?? []).slice(0, maxResults) };
		},
	};
	return search;
}

/** 轮询等待 job 结束（done/error），超时抛错。 */
export async function waitForJob(jobs, jobId, { timeoutMs = 15000, intervalMs = 10 } = {}) {
	const started = Date.now();
	for (;;) {
		const job = jobs.get(jobId);
		if (job === null) throw new Error(`job ${jobId} disappeared`);
		if (job.status === "done" || job.status === "error") return job;
		if (Date.now() - started > timeoutMs) throw new Error(`job ${jobId} timeout after ${timeoutMs}ms (status=${job.status})`);
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

/** 断言辅助：失败抛 Error，成功打印 PASS。 */
let passCount = 0;
export function check(condition, label) {
	if (!condition) throw new Error(`FAIL: ${label}`);
	passCount += 1;
	console.log(`PASS ${label}`);
}
export function checkEqual(actual, expected, label) {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
	}
	passCount += 1;
	console.log(`PASS ${label}`);
}
export function checkMatch(value, pattern, label) {
	if (!pattern.test(String(value))) throw new Error(`FAIL: ${label} (value=${JSON.stringify(value)})`);
	passCount += 1;
	console.log(`PASS ${label}`);
}
export function summary(name) {
	console.log(`\n${name}: ${passCount} checks passed`);
}

// ── 可复用的假模型输出 ───────────────────────────────────────────────────

export const OUTLINE_TEXT = `<OUTLINE>{"title":"测试文档","sections":[{"heading":"一、背景与目标","points":["说明项目背景","明确目标与边界"],"notes":"开头简明扼要"},{"heading":"二、实施路径","points":["分阶段推进","关键里程碑"],"notes":""}]}</OUTLINE>`;

export const OUTLINE_TEXT_2 = `已按你的要求新增「风险与应对」章节，并压缩了背景部分。\n<OUTLINE>{"title":"测试文档","sections":[{"heading":"一、背景与目标","points":["说明项目背景","明确目标"],"notes":""},{"heading":"二、实施路径","points":["分阶段推进","关键里程碑"],"notes":""},{"heading":"三、风险与应对","points":["识别主要风险","给出应对措施"],"notes":""}]}</OUTLINE>`;

export const DOCUMENT_TEXT = `<DOCUMENT>
# 测试文档

## 一、背景与目标
本段说明项目背景与目标，内容用于端到端测试。

## 二、实施路径
分阶段推进，设置关键里程碑。

</DOCUMENT>`;

export const DOCUMENT_TEXT_2 = `已扩充背景段落。\n<DOCUMENT>
# 测试文档

## 一、背景与目标
扩充后的背景与目标段落，包含更多细节。

## 二、实施路径
分阶段推进，设置关键里程碑。

## 三、风险与应对
识别主要风险并给出应对措施。

</DOCUMENT>`;

export const REPORT_TEXT = `<REPORT>[{"label":"全文使用简体中文","status":"pass","note":"全文中文。"},{"label":"不得编造数据","status":"risk","note":"第二段缺少数据来源，建议标注（待核实）。"}]</REPORT>`;

export const DISCUSSION_TEXT = "这版大纲结构清晰；建议在第二节补充量化指标，暂不需要修改版本。";

/** 常见异步错误对象。 */
export function errorWithCode(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}
