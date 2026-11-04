// test/test-model.mjs — 模型适配层离线测试：模型路由解析、callModel 组装/重试/错误、
// listModels、联网检索归一化。用假 ctx.llm / ctx.web，不联网。

import { check, checkEqual, summary } from "./helpers.mjs";
import { createModelService, createSearchService } from "../lib/model.js";

function fakeLlm({ providers = ["mock"], models = { mock: [{ provider: "mock", id: "mock-1", name: "Mock 1" }] }, chunks } = {}) {
	const calls = [];
	return {
		calls,
		listProviders: () => providers.map((id) => ({ id, name: `Provider ${id}` })),
		listModels: async (provider) => models[provider] ?? [],
		resolveModelInfo: async (provider, model) => ({ provider, model, id: model, name: model, defaultMaxTokens: 8192 }),
		stream(options) {
			calls.push(options);
			const queue = typeof chunks === "function" ? chunks(options, calls.length) : chunks;
			return (async function* streamChunks() {
				for (const chunk of queue ?? [{ type: "text-delta", text: "你好" }, { type: "finish", kind: "stop" }]) {
					if (chunk instanceof Error) throw chunk;
					yield chunk;
				}
			})();
		},
	};
}

// ── 模型路由解析 ────────────────────────────────────────────────────────────
{
	const llm = fakeLlm({ providers: ["alpha", "beta"], models: { alpha: [{ id: "a1", name: "A1" }, { id: "a2", name: "A2" }], beta: [{ id: "b1", name: "B1" }] } });
	const service = createModelService({ getLlm: () => llm, getDefault: () => ({ currentSelection: () => ({ provider: "beta", model: "b1" }) }) });
	checkEqual(await service.resolveSelection(null), { provider: "beta", model: "b1" }, "默认模型选择");
	checkEqual(await service.resolveSelection({ provider: "alpha", model: "a2" }), { provider: "alpha", model: "a2" }, "项目显式模型选择");
	// 不在目录中的模型回退到目录首选
	checkEqual(await service.resolveSelection({ provider: "alpha", model: "missing" }), { provider: "alpha", model: "a1" }, "目录外模型回退到首个模型");
	// 未注册的 provider 回退默认
	checkEqual(await service.resolveSelection({ provider: "ghost", model: "x" }), { provider: "beta", model: "b1" }, "未注册 provider 回退默认");

	const listed = await service.listModels();
	checkEqual(listed.providers.length, 2, "listModels 返回两个 provider");
	checkEqual(listed.selection, { provider: "beta", model: "b1" }, "listModels 附带默认选择");

	// 无默认服务 + 无候选 → 第一个 provider 第一个模型
	const noDefault = createModelService({ getLlm: () => llm, getDefault: () => undefined });
	checkEqual(await noDefault.resolveSelection(null), { provider: "alpha", model: "a1" }, "无默认时取首个 provider/模型");
}

// ── callModel 组装、参数钳制与返回 ─────────────────────────────────────────
{
	let chunkScript = [
		{ type: "text-delta", index: 0, text: "你" },
		{ type: "text-delta", index: 0, text: "好" },
		{ type: "finish", reason: { kind: "stop" } },
	];
	const llm = fakeLlm({ chunks: () => chunkScript });
	const service = createModelService({ getLlm: () => llm, getDefault: () => ({ currentSelection: () => ({ provider: "mock", model: "mock-1" }) }) });
	const result = await service.callModel({
		system: "系统提示",
		messages: [
			{ role: "user", content: "第一问" },
			{ role: "assistant", content: "第一答" },
			{ role: "user", content: "第二问" },
		],
		maxTokens: 99999,
	});
	checkEqual(result.text, "你好", "callModel 拼接 text-delta");
	checkEqual(result.selection, { provider: "mock", model: "mock-1" }, "callModel 返回模型选择");
	const request = llm.calls[0];
	checkEqual(request.provider, "mock", "请求 provider 正确");
	checkEqual(request.system, "系统提示", "system 透传");
	checkEqual(request.maxTokens, 8192, "maxTokens 被钳制到模型上限");
	checkEqual(request.messages.length, 3, "消息数量正确");
	checkEqual(request.messages[0].role, "user", "用户消息保持 user 角色");
	checkEqual(request.messages[1].role, "assistant", "assistant 历史消息保持 assistant 角色");
	check(typeof request.messages[1].id === "string" && request.messages[1].source.kind === "model", "assistant 历史消息补齐 id/source");
	checkEqual(request.messages[2].content[0].text, "第二问", "用户消息文本正确");
	check(request.signal instanceof AbortSignal, "请求带 AbortSignal");

	// 终端错误 → AppError
	chunkScript = [{ type: "text-delta", index: 0, text: "半" }, { type: "finish", reason: { kind: "error", failure: { code: "AUTH", message: "bad key" } } }];
	let caught = null;
	try {
		await service.callModel({ system: "s", messages: [{ role: "user", content: "x" }] });
	} catch (error) {
		caught = error;
	}
	checkEqual(caught?.code, "model-call-failed", "finish error 映射为 model-call-failed");
	check(caught.message.includes("AUTH"), "错误信息包含 provider 错误码");

	// 第一次抛错、第二次成功 → 自动重试一次
	let attempt = 0;
	const flakyLlm = fakeLlm({
		chunks: () => {
			attempt += 1;
			if (attempt === 1) return [new Error("network down")];
			return [{ type: "text-delta", index: 0, text: "重试成功" }, { type: "finish", reason: { kind: "stop" } }];
		},
	});
	const flaky = createModelService({ getLlm: () => flakyLlm, getDefault: () => ({ currentSelection: () => ({ provider: "mock", model: "mock-1" }) }) });
	const retried = await flaky.callModel({ system: "s", messages: [{ role: "user", content: "x" }] });
	checkEqual(retried.text, "重试成功", "瞬时失败自动重试成功");
	checkEqual(attempt, 2, "共尝试 2 次");

	// 空输出 → 报错
	const emptyLlm = fakeLlm({ chunks: [{ type: "text-delta", index: 0, text: "   " }, { type: "finish", reason: { kind: "stop" } }] });
	const empty = createModelService({ getLlm: () => emptyLlm, getDefault: () => ({ currentSelection: () => ({ provider: "mock", model: "mock-1" }) }) });
	let emptyCaught = null;
	try {
		await empty.callModel({ system: "s", messages: [{ role: "user", content: "x" }] });
	} catch (error) {
		emptyCaught = error;
	}
	checkEqual(emptyCaught?.message.includes("空内容"), true, "空输出报错");

	// LLM 服务缺失 → model-unavailable
	const unavailable = createModelService({ getLlm: () => undefined, getDefault: () => undefined });
	let unavailableCaught = null;
	try {
		await unavailable.resolveSelection(null);
	} catch (error) {
		unavailableCaught = error;
	}
	checkEqual(unavailableCaught?.code, "model-unavailable", "服务缺失时 model-unavailable");
}

// ── 联网检索归一化 ──────────────────────────────────────────────────────────
{
	const web = {
		calls: [],
		async search(request) {
			web.calls.push(request);
			return {
				sources: [
					{ title: "来源一", url: "https://example.com/a", snippet: "摘要一" },
					{ title: "", url: "https://example.com/b" },
					{ url: "" },
				],
			};
		},
	};
	const search = createSearchService({ getWeb: () => web });
	const result = await search.search({ query: "数据安全", maxResults: 3 });
	checkEqual(result.sources.length, 2, "检索结果过滤空 url");
	checkEqual(result.sources[0].title, "来源一", "检索结果 title 保留");
	checkEqual(result.sources[1].title, "https://example.com/b", "缺失 title 用 url 兜底");
	checkEqual(web.calls[0].query, "数据安全", "检索 query 透传");

	const failing = createSearchService({
		getWeb: () => ({
			async search() {
				throw new Error("timeout");
			},
		}),
	});
	let searchCaught = null;
	try {
		await failing.search({ query: "x" });
	} catch (error) {
		searchCaught = error;
	}
	checkEqual(searchCaught?.code, "search-failed", "检索失败映射 search-failed");

	const missing = createSearchService({ getWeb: () => undefined });
	let missingCaught = null;
	try {
		await missing.search({ query: "x" });
	} catch (error) {
		missingCaught = error;
	}
	checkEqual(missingCaught?.code, "search-unavailable", "联网服务缺失 search-unavailable");
}

console.log("\nALL MODEL TESTS PASSED");
summary("test-model");
