// lib/model.js — 真实模型能力适配：把 DSH 的 ctx.llm / ctx.web 包装成本插件引擎
// 需要的 callModel / search，并负责解析"用哪个 provider/model"。
//
// 解析优先级：
//   1. 项目显式选择 project.model（仍要求该 provider 已注册）
//   2. 环境变量 DOC_CREATOR_PROVIDER + DOC_CREATOR_MODEL
//   3. DSH 的默认模型 ctx.agentDefaultModel.currentSelection()
//   4. 第一个已注册 provider 的第一个模型
//
// 服务可能晚于插件挂载（ctx.inject 子作用域），因此这里全部用 getter 读取，
// 每次调用都拿当下最新的服务实例。

import { AppError } from "./errors.js";

const CALL_TIMEOUT_MS = 4 * 60 * 1000; // 单次模型调用上限（文档生成可能较慢）
const MODEL_INFO_TTL_MS = 5 * 60 * 1000;

/** 把错误消息压成一行，便于展示。 */
function oneLine(error) {
	const message = typeof error?.message === "string" ? error.message : String(error);
	return message.replace(/\s+/g, " ").trim().slice(0, 500);
}

/**
 * @param {{
 *   getLlm: () => any,
 *   getDefault: () => any,
 *   logger?: { warn?: (message: string) => void },
 * }} deps
 */
export function createModelService({ getLlm, getDefault, logger }) {
	/** @type {Map<string, { at: number, info: any }>} */
	const modelInfoCache = new Map();

	function llmService() {
		const llm = getLlm();
		if (llm === null || llm === undefined) {
			throw new AppError("model-unavailable", "模型服务未就绪：DSH 的 LLM 服务尚未加载，暂时无法生成内容。");
		}
		return llm;
	}

	async function listProviderModels(llm, provider) {
		try {
			const models = await llm.listModels(provider);
			return Array.isArray(models) ? models : [];
		} catch (error) {
			logger?.warn?.(`[doc-creator] listModels(${provider}) failed: ${oneLine(error)}`);
			return [];
		}
	}

	async function resolveModelInfo(llm, provider, model) {
		const key = `${provider}\u0000${model}`;
		const cached = modelInfoCache.get(key);
		if (cached !== undefined && Date.now() - cached.at < MODEL_INFO_TTL_MS) return cached.info;
		try {
			const info = await llm.resolveModelInfo(provider, model);
			modelInfoCache.set(key, { at: Date.now(), info });
			return info;
		} catch {
			return null;
		}
	}

	function readEnvSelection() {
		const provider = process.env.DOC_CREATOR_PROVIDER?.trim();
		const model = process.env.DOC_CREATOR_MODEL?.trim();
		return provider !== undefined && provider !== "" && model !== undefined && model !== "" ? { provider, model } : null;
	}

	function readDefaultSelection() {
		try {
			const selection = getDefault()?.currentSelection?.();
			if (selection !== null && typeof selection === "object" && typeof selection.provider === "string" && typeof selection.model === "string") {
				return { provider: selection.provider, model: selection.model };
			}
		} catch (error) {
			logger?.warn?.(`[doc-creator] agentDefaultModel failed: ${oneLine(error)}`);
		}
		return null;
	}

	/**
	 * 解析本次调用使用的模型路由。
	 * @param {{ provider?: string, model?: string } | null} [preferred]
	 * @returns {Promise<{ provider: string, model: string }>}
	 */
	async function resolveSelection(preferred = null) {
		const llm = llmService();
		const providers = llm.listProviders();
		if (!Array.isArray(providers) || providers.length === 0) {
			throw new AppError("model-unavailable", "没有已注册的模型提供方，无法生成内容。请先在 DSH 设置中配置模型。");
		}
		const ids = new Set(providers.map((entry) => entry.id));
		const candidates = [];
		if (preferred !== null && preferred !== undefined && typeof preferred.provider === "string" && ids.has(preferred.provider) && typeof preferred.model === "string") {
			candidates.push({ provider: preferred.provider, model: preferred.model });
		}
		const env = readEnvSelection();
		if (env !== null && ids.has(env.provider)) candidates.push(env);
		const fallback = readDefaultSelection();
		if (fallback !== null && ids.has(fallback.provider)) candidates.push(fallback);

		for (const candidate of candidates) {
			const models = await listProviderModels(llm, candidate.provider);
			if (models.length === 0) return candidate; // 目录为空时按"路由可接受未列出模型"处理
			if (models.some((entry) => entry.id === candidate.model)) return candidate;
			// 模型已下架：优先留在同一 provider 的目录首选模型，而不是切到别的 provider
			logger?.warn?.(`[doc-creator] 模型 ${candidate.provider}/${candidate.model} 不在目录中，改用 ${models[0].id}`);
			return { provider: candidate.provider, model: models[0].id };
		}

		for (const provider of providers) {
			const models = await listProviderModels(llm, provider.id);
			if (models.length > 0) return { provider: provider.id, model: models[0].id };
		}
		throw new AppError("model-unavailable", "没有可用模型：已注册的提供方没有返回任何模型。");
	}

	/** 组装 llm.stream 需要的消息：assistant 历史消息补齐稳定 id / source。 */
	function toRequestMessages(messages, selection) {
		const stamp = Date.now().toString(36);
		return messages.map((message, index) => {
			const text = typeof message.content === "string" ? message.content : String(message.content ?? "");
			if (message.role === "assistant") {
				return {
					id: `doc-creator-${stamp}-${index}`,
					role: "assistant",
					source: { kind: "model", provider: selection.provider, model: selection.model },
					content: [{ type: "text", text }],
				};
			}
			return { role: "user", content: [{ type: "text", text }] };
		});
	}

	/** 单次流式调用并收集正文；失败抛错。 */
	async function streamOnce(options) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error("模型调用超时")), CALL_TIMEOUT_MS);
		const signals = [controller.signal];
		if (options.signal instanceof AbortSignal) signals.push(options.signal);
		const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
		let text = "";
		let finish = null;
		let usage = null;
		try {
			const stream = llmService().stream({ ...options, signal });
			for await (const chunk of stream) {
				if (chunk.type === "text-delta") text += chunk.text;
				else if (chunk.type === "usage") usage = chunk.usage;
				else if (chunk.type === "finish") finish = chunk;
			}
		} finally {
			clearTimeout(timer);
		}
		const reason = finish?.reason ?? null;
		if (reason !== null && reason.kind !== "stop" && reason.kind !== "max-tokens") {
			const failure = reason.failure ?? {};
			const code = typeof failure.code === "string" ? failure.code : "";
			const detail = typeof failure.message === "string" && failure.message !== ""
				? failure.message
				: `未知错误（finish: ${JSON.stringify(finish).slice(0, 300)}）`;
			throw new AppError("model-call-failed", `模型调用失败${code !== "" ? `（${code}）` : ""}：${detail}`);
		}
		if (text.trim() === "") {
			throw new AppError("model-call-failed", "模型返回了空内容，请重试。");
		}
		return { text, usage };
	}

	/**
	 * 调用模型并返回完整文本。
	 * @param {{
	 *   system: string,
	 *   messages: Array<{ role: "user"|"assistant", content: string }>,
	 *   maxTokens?: number,
	 *   temperature?: number,
	 *   signal?: AbortSignal,
	 *   preferred?: { provider: string, model: string } | null,
	 * }} request
	 */
	async function callModel({ system, messages, maxTokens, temperature, signal, preferred = null }) {
		const llm = llmService();
		const selection = await resolveSelection(preferred);
		const info = await resolveModelInfo(llm, selection.provider, selection.model);
		let tokens = maxTokens;
		if (Number.isFinite(tokens) && info !== null && Number.isFinite(info.defaultMaxTokens) && info.defaultMaxTokens > 0) {
			tokens = Math.min(tokens, info.defaultMaxTokens);
		}
		const options = {
			provider: selection.provider,
			model: selection.model,
			system,
			messages: toRequestMessages(messages, selection),
			signal,
		};
		if (Number.isFinite(tokens) && tokens > 0) options.maxTokens = Math.round(tokens);
		if (Number.isFinite(temperature)) options.temperature = temperature;

		let lastError = null;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			if (signal?.aborted) throw new AppError("model-call-failed", "模型调用已取消。");
			try {
				const { text, usage } = await streamOnce(options);
				return { text, usage, selection };
			} catch (error) {
				if (error instanceof AppError && error.code === "model-call-failed" && /已取消|abort|cancel/i.test(error.message)) throw error;
				lastError = error;
				logger?.warn?.(`[doc-creator] 模型调用第 ${attempt + 1} 次失败：${oneLine(error)}`);
				if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1200));
			}
		}
		const message = lastError instanceof AppError ? lastError.message : `模型调用失败：${oneLine(lastError)}`;
		throw new AppError("model-call-failed", message, { cause: lastError });
	}

	/** 列出可选模型（供 UI 下拉）。服务缺失时返回空目录而不是抛错。 */
	async function listModels() {
		const llm = getLlm();
		if (llm === null || llm === undefined) return { selection: null, providers: [] };
		let selection = null;
		try {
			selection = await resolveSelection(null);
		} catch {
			selection = readDefaultSelection();
		}
		const providers = [];
		try {
			for (const provider of llm.listProviders()) {
				const models = await listProviderModels(llm, provider.id);
				providers.push({
					provider: provider.id,
					name: provider.name ?? provider.id,
					models: models.map((model) => ({ id: model.id, name: model.name ?? model.id })),
				});
			}
		} catch (error) {
			logger?.warn?.(`[doc-creator] listModels failed: ${oneLine(error)}`);
		}
		return { selection, providers };
	}

	return { resolveSelection, callModel, listModels };
}

/**
 * @param {{ getWeb: () => any, logger?: { warn?: (message: string) => void } }} deps
 */
export function createSearchService({ getWeb, logger }) {
	/**
	 * 联网检索，归一化为 [{ title, url, snippet }]。
	 * @param {{ query: string, maxResults?: number, signal?: AbortSignal }} request
	 */
	async function search({ query, maxResults = 6, signal }) {
		const web = getWeb();
		if (web === null || web === undefined) {
			throw new AppError("search-unavailable", "联网服务未就绪（ctx.web 未加载），已跳过联网检索。");
		}
		let result;
		try {
			result = await web.search({ query, maxResults, ...(signal === undefined ? {} : { signal }) });
		} catch (error) {
			throw new AppError("search-failed", `联网检索失败（${query}）：${oneLine(error)}`, { cause: error });
		}
		const sources = Array.isArray(result?.sources) ? result.sources : [];
		return {
			sources: sources
				.map((source) => ({
					title: typeof source?.title === "string" && source.title !== "" ? source.title : String(source?.url ?? "未命名来源"),
					url: typeof source?.url === "string" ? source.url : "",
					snippet: typeof source?.snippet === "string" ? source.snippet : "",
				}))
				.filter((source) => source.url !== ""),
			answer: typeof result?.content === "string" ? result.content : undefined,
		};
	}

	return { search };
}
