// lib/index.js — 文档创作插件入口（cordis host plugin）。
// 提供：/doc-creator/api HTTP 路由；大纲/成文/对话由插件内部的 LLM 引擎完成
// （复用 DSH 的 ctx.llm 与默认模型选择，联网复用 ctx.web）。
//
// 可选服务全部用 ctx.inject 子作用域挂接：即使 LLM / 联网服务晚到或缺失，
// 插件本身仍能挂载并展示 UI（生成类接口返回"模型服务未就绪"）。

import os from "node:os";
import path from "node:path";
import { registerRoutes } from "./api.js";
import { createJobs } from "./jobs.js";
import { createModelService, createSearchService } from "./model.js";
import { createService } from "./service.js";
import { createStore } from "./store.js";

const name = "doc-creator";
const inject = ["webServer"];

function apply(ctx) {
	const dataDir = process.env.DOC_CREATOR_DATA ?? path.join(os.homedir(), ".dsh", "data", "doc-creator");
	const store = createStore(dataDir);
	const jobs = createJobs();
	/** 运行时服务引用：ctx.inject 子作用域到达/离开时更新。 */
	const services = { llm: null, agentDefaultModel: null, web: null };

	const modelService = createModelService({
		getLlm: () => services.llm,
		getDefault: () => services.agentDefaultModel,
		logger: ctx.logger,
	});
	const searchService = createSearchService({ getWeb: () => services.web, logger: ctx.logger });
	const service = createService({
		store,
		jobs,
		getModel: () => (services.llm === null ? null : modelService),
		getSearch: () => (services.web === null ? null : searchService),
		logger: ctx.logger,
	});

	ctx.effect(() => {
		const dispose = registerRoutes(ctx, { service, store, jobs, logger: ctx.logger });
		store.ensureDirs().then(
			() => ctx.logger?.info?.(`[doc-creator] data dir ready: ${dataDir}`),
			(error) => ctx.logger?.warn?.(`[doc-creator] init failed: ${error?.stack ?? error}`),
		);
		return () => dispose?.();
	}, "doc-creator: api routes");

	ctx.inject(["llm"], (child) => {
		child.effect(() => {
			services.llm = child.llm;
			ctx.logger?.info?.("[doc-creator] llm service mounted");
			return () => {
				services.llm = null;
			};
		}, "doc-creator: llm");
	});

	ctx.inject(["agentDefaultModel"], (child) => {
		child.effect(() => {
			services.agentDefaultModel = child.agentDefaultModel;
			return () => {
				services.agentDefaultModel = null;
			};
		}, "doc-creator: default model");
	});

	ctx.inject(["web"], (child) => {
		child.effect(() => {
			services.web = child.web;
			ctx.logger?.info?.("[doc-creator] web (search) service mounted");
			return () => {
				services.web = null;
			};
		}, "doc-creator: web");
	});
}

export { apply, inject, name };
