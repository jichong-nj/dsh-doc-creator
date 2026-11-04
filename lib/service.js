// lib/service.js — 业务编排层：项目/参考资料/大纲/成文/对话 + 任务调度 + 落盘。
//
// 职责边界：
//   - store（持久化）、templates（内置模板）、extract（参考文档抽文本）、docx（Word 导出）
//   - engine（提示词与解析）由这里按"本次请求的项目模型选择"创建实例
//   - 所有写操作串行化（同一进程内），生成期间不持锁，只在读-改-写落盘时加锁
//   - 错误统一 AppError（中文 message，code → HTTP 状态码）

import path from "node:path";
import { mkdir, copyFile, rm, stat } from "node:fs/promises";
import { createEngine } from "./engine.js";
import { AppError, toAppError } from "./errors.js";
import { extractText } from "./extract.js";
import { buildDocx } from "./docx.js";
import * as templates from "./templates.js";

const TARGET_WORDS = {
	short: { min: 800, max: 1200 },
	standard: { min: 2000, max: 3500 },
	detailed: { min: 4500, max: 7000 },
};
const MAX_REFERENCE_TEXT = 400000;
const MAX_PROJECT_NAME = 200;
const MAX_TOPIC = 8000;
const MAX_REDLINES = 40;
const MAX_REDLINE_LENGTH = 500;
const MAX_CHAT_MESSAGE = 8000;

const STYLE_ENUMS = {
	audience: ["general", "management", "technical", "client"],
	tone: ["formal", "professional", "friendly"],
	length: ["short", "standard", "detailed"],
};

function now() {
	return Date.now();
}

function todayLabel() {
	const date = new Date();
	return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 估算字数：CJK 逐字 + 拉丁词计数，忽略 Markdown 标记与代码块。 */
export function countWords(markdown) {
	const plain = String(markdown ?? "")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/[#>*_`~\-[\]()!|]/g, " ");
	const cjk = (plain.match(/[\u3400-\u9fff]/g) ?? []).length;
	const latin = (plain.match(/[A-Za-z0-9]+/g) ?? []).length;
	return cjk + latin;
}

/** 标题归一化：去掉编号/标点/空白后比较，用于大纲章节覆盖检查。 */
export function normalizeHeading(heading) {
	return String(heading ?? "")
		.replace(/^[\s（(]*[一二三四五六七八九十百]+[、.．)）]\s*/u, "")
		.replace(/^[\s（(]*\d+(?:\.\d+)*[、.．)）]?\s*/u, "")
		.replace(/[\s，,。.;；:：、！!？?"'“”‘’（）()【】\[\]《》<>·]/g, "")
		.toLowerCase();
}

/** 从 Markdown 提取标题文本。 */
function markdownHeadings(markdown) {
	const headings = [];
	for (const line of String(markdown ?? "").split("\n")) {
		const match = /^#{1,6}\s+(.+?)\s*$/.exec(line.trim());
		if (match !== null) headings.push(match[1]);
	}
	return headings;
}

/** 文件名净化（用于下载文件名，不动磁盘路径）。 */
export function safeFileName(name, fallback = "文档") {
	const cleaned = String(name ?? "")
		.replace(/[\\/:*?"<>|\r\n\t]/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
	return cleaned === "" ? fallback : cleaned;
}

/** 派生阶段：无大纲 → setup；大纲未确认 → outline；否则 document。 */
export function deriveStage(project) {
	const versions = project?.outline?.versions ?? [];
	if (versions.length === 0) return "setup";
	return project.outline.confirmed === null || project.outline.confirmed === undefined ? "outline" : "document";
}

function outlineChars(sections) {
	let length = 0;
	for (const section of sections ?? []) {
		length += String(section.heading ?? "").length;
		for (const point of section.points ?? []) length += String(point).length;
		if (section.notes) length += String(section.notes).length;
	}
	return length;
}

function trimText(value, max, fallback = "") {
	if (typeof value !== "string") return fallback;
	const text = value.trim();
	return text.length > max ? text.slice(0, max) : text;
}

/** 红线归一化：接受字符串数组或 {id,text,builtin} 数组。 */
function normalizeRedlines(input, current = []) {
	if (!Array.isArray(input)) throw new AppError("bad-request", "红线要求必须是数组");
	const seen = new Set();
	const list = [];
	for (const entry of input) {
		const raw = typeof entry === "string" ? entry : entry?.text;
		const text = trimText(raw, MAX_REDLINE_LENGTH);
		if (text === "") continue;
		const key = text.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		const source = typeof entry === "object" && entry !== null ? entry : {};
		const existing = current.find((item) => item.text === text);
		list.push({
			id: typeof source.id === "string" && source.id !== "" ? source.id : existing?.id ?? `rl-${now().toString(36)}-${list.length}`,
			text,
			builtin: source.builtin === true || existing?.builtin === true,
		});
		if (list.length >= MAX_REDLINES) break;
	}
	return list;
}

/** 校验风格选择。 */
function normalizeStyle(style, fallback) {
	const base = { ...(fallback ?? { audience: "general", tone: "formal", length: "standard" }) };
	if (typeof style !== "object" || style === null) return base;
	for (const [key, allowed] of Object.entries(STYLE_ENUMS)) {
		const value = style[key];
		if (typeof value === "string" && allowed.includes(value)) base[key] = value;
	}
	return base;
}

/** 模型选择归一化：null / {provider, model}。 */
function normalizeModel(model) {
	if (model === null || model === undefined) return null;
	if (typeof model !== "object" || typeof model.provider !== "string" || model.provider.trim() === "" || typeof model.model !== "string" || model.model.trim() === "") {
		throw new AppError("bad-request", "模型选择格式不正确");
	}
	return { provider: model.provider.trim(), model: model.model.trim() };
}

function newMessage(role, content, phase, extra = {}) {
	return {
		id: `msg-${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
		role,
		content,
		phase,
		at: now(),
		error: false,
		action: null,
		...extra,
	};
}

/**
 * @param {{
 *   store: ReturnType<typeof import("./store.js").createStore>,
 *   jobs: ReturnType<typeof import("./jobs.js").createJobs>,
 *   getModel: () => any,
 *   getSearch: () => any,
 *   logger?: { warn?: (message: string) => void, info?: (message: string) => void },
 * }} deps
 */
export function createService({ store, jobs, getModel, getSearch, logger }) {
	// 写操作串行化：避免 index.json 的读-改-写交错丢更新。
	let writeChain = Promise.resolve();

	/** @template T @param {() => Promise<T>} task @returns {Promise<T>} */
	function exclusive(task) {
		const run = writeChain.then(task, task);
		writeChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	function templateFor(project) {
		return templates.getTemplate(project.templateId) ?? templates.getTemplate(templates.FREE_TEMPLATE_ID);
	}

	async function projectOrThrow(projectId) {
		if (typeof projectId !== "string" || !/^[a-z0-9][a-z0-9-]{0,64}$/.test(projectId)) {
			throw new AppError("bad-request", "项目 id 格式不正确");
		}
		const project = await store.readProject(projectId);
		if (project === null) throw new AppError("not-found", "文档项目不存在或已被删除");
		return project;
	}

	/** 补齐老数据缺省字段，保证前端拿到稳定形状。 */
	function normalizeProject(project) {
		const fallbackTemplate = templates.getTemplate(templates.FREE_TEMPLATE_ID);
		project.templateId = templates.getTemplate(project.templateId) === null ? templates.FREE_TEMPLATE_ID : project.templateId;
		project.style = normalizeStyle(project.style, fallbackTemplate?.defaults);
		project.refs = Array.isArray(project.refs) ? project.refs : [];
		project.redlines = Array.isArray(project.redlines) ? project.redlines : templates.defaultRedlines();
		project.webSearch = {
			enabled: project.webSearch?.enabled === true,
			queries: Array.isArray(project.webSearch?.queries) ? project.webSearch.queries : [],
			lastSearchAt: project.webSearch?.lastSearchAt ?? null,
		};
		project.sources = Array.isArray(project.sources) ? project.sources : [];
		project.outline = project.outline ?? {};
		project.outline.versions = Array.isArray(project.outline.versions) ? project.outline.versions : [];
		project.outline.active = Number.isInteger(project.outline.active) ? project.outline.active : 0;
		project.outline.confirmed = Number.isInteger(project.outline.confirmed) ? project.outline.confirmed : null;
		project.document = project.document ?? {};
		project.document.versions = Array.isArray(project.document.versions) ? project.document.versions : [];
		project.document.active = Number.isInteger(project.document.active) ? project.document.active : 0;
		project.conversation = project.conversation ?? { messages: [] };
		project.conversation.messages = Array.isArray(project.conversation.messages) ? project.conversation.messages : [];
		project.warnings = Array.isArray(project.warnings) ? project.warnings : [];
		project.model = project.model ?? null;
		project.topic = typeof project.topic === "string" ? project.topic : "";
		project.name = typeof project.name === "string" && project.name.trim() !== "" ? project.name : "未命名文档";
		return project;
	}

	/** 给 API 返回的完整项目：附带 stage / activeJob / 各版本大纲正文。 */
	async function decorateProject(project) {
		normalizeProject(project);
		project.stage = deriveStage(project);
		project.activeJob = jobs.activeForProject(project.id);
		// 大纲版本内容很小，直接随项目返回，前端切版本不需要额外请求。
		for (const meta of project.outline.versions) {
			if (Array.isArray(meta.sections)) continue;
			const data = await store.readOutline(project.id, meta.version);
			meta.sections = Array.isArray(data?.sections) ? data.sections : [];
			if (typeof data?.title === "string" && data.title !== "") meta.title = data.title;
		}
		return project;
	}

	async function save(project) {
		project.updatedAt = now();
		await store.writeProject(normalizeProject(project));
		return project;
	}

	/** 读取可用参考文档正文（失败/错误的引用跳过）。 */
	async function readReferences(project) {
		const references = [];
		for (const ref of project.refs) {
			if (ref.status !== "ready") continue;
			const text = await store.readRefText(project.id, ref.id);
			if (typeof text === "string" && text.trim() !== "") references.push({ name: ref.name, text: text.slice(0, MAX_REFERENCE_TEXT) });
		}
		return references;
	}

	function modelOrThrow() {
		const model = getModel();
		if (model === null || model === undefined) {
			throw new AppError("model-unavailable", "模型服务未就绪：DSH 的 LLM 服务尚未加载，暂时无法生成内容。");
		}
		return model;
	}

	/** 每次操作创建独立引擎实例，绑定该项目的模型选择。 */
	function engineFor(project) {
		return createEngine({
			callModel: (request) => modelOrThrow().callModel({ ...request, preferred: project.model ?? null }),
			search: async (request) => {
				const search = getSearch();
				if (search === null || search === undefined) throw new AppError("search-unavailable", "联网服务未就绪");
				return search.search(request);
			},
			logger,
		});
	}

	/** 启动后台任务；同一项目已有运行中的任务时拒绝。 */
	function startJob({ kind, projectId, phase, run }) {
		const active = jobs.activeForProject(projectId);
		if (active !== null) throw new AppError("busy", "该项目已有生成任务在进行中，请等待完成后再试。");
		const job = jobs.create({ kind, projectId, phase });
		const view = { id: job.id, update: (progress, message) => jobs.update(job.id, { progress, message }) };
		(async () => {
			try {
				const result = await run(view);
				jobs.update(job.id, { status: "done", progress: 100, message: "已完成", result: result ?? null });
			} catch (error) {
				const appError = toAppError(error);
				logger?.warn?.(`[doc-creator] job ${job.id} failed: ${appError.stack ?? appError.message}`);
				jobs.update(job.id, { status: "error", message: "任务失败", error: appError.message });
			}
		})();
		return job.id;
	}

	// ── 模板 / 项目 ──────────────────────────────────────────────────────────

	function listTemplates() {
		return { templates: templates.listTemplates() };
	}

	function listProjects() {
		return store.listProjects().then((projects) => ({ projects }));
	}

	async function createProject({ name, templateId } = {}) {
		const template = templates.getTemplate(templateId) ?? templates.getTemplate(templates.FREE_TEMPLATE_ID);
		return exclusive(async () => {
			const stamp = now();
			const project = {
				id: store.genId("doc"),
				name: trimText(name, MAX_PROJECT_NAME) || "未命名文档",
				createdAt: stamp,
				updatedAt: stamp,
				templateId: template.id,
				topic: "",
				style: normalizeStyle(null, template.defaults),
				model: null,
				refs: [],
				redlines: templates.defaultRedlines(),
				webSearch: { enabled: false, queries: [], lastSearchAt: null },
				sources: [],
				outline: { active: 0, confirmed: null, versions: [] },
				document: { active: 0, versions: [] },
				conversation: { messages: [] },
				warnings: [],
			};
			await store.writeProject(project);
			return { project: await decorateProject(project) };
		});
	}

	async function getProject(projectId) {
		const project = await projectOrThrow(projectId);
		return { project: await decorateProject(project) };
	}

	async function updateProject({ projectId, patch } = {}) {
		if (typeof patch !== "object" || patch === null) throw new AppError("bad-request", "patch 必须是对象");
		return exclusive(async () => {
			const project = normalizeProject(await projectOrThrow(projectId));
			if (Object.hasOwn(patch, "name")) project.name = trimText(patch.name, MAX_PROJECT_NAME) || project.name;
			if (Object.hasOwn(patch, "topic")) project.topic = trimText(patch.topic, MAX_TOPIC);
			if (Object.hasOwn(patch, "templateId")) {
				const template = templates.getTemplate(patch.templateId);
				if (template === null) throw new AppError("bad-request", `未知模板：${String(patch.templateId)}`);
				project.templateId = template.id;
				if (typeof patch.style !== "object" || patch.style === null) {
					project.style = normalizeStyle(null, template.defaults);
				}
			}
			if (Object.hasOwn(patch, "style")) project.style = normalizeStyle(patch.style, project.style);
			if (Object.hasOwn(patch, "redlines")) project.redlines = normalizeRedlines(patch.redlines, project.redlines);
			if (Object.hasOwn(patch, "webSearch")) {
				if (typeof patch.webSearch === "boolean") project.webSearch.enabled = patch.webSearch;
				else if (typeof patch.webSearch === "object" && patch.webSearch !== null) {
					if (typeof patch.webSearch.enabled === "boolean") project.webSearch.enabled = patch.webSearch.enabled;
					if (Array.isArray(patch.webSearch.queries)) {
						project.webSearch.queries = patch.webSearch.queries.map((query) => trimText(query, 200)).filter((query) => query !== "").slice(0, 6);
					}
				}
			}
			if (Object.hasOwn(patch, "model")) project.model = normalizeModel(patch.model);
			await save(project);
			return { project: await decorateProject(project) };
		});
	}

	async function deleteProject({ projectId } = {}) {
		return exclusive(async () => {
			const project = await projectOrThrow(projectId);
			const active = jobs.activeForProject(project.id);
			if (active !== null) throw new AppError("busy", "该项目正在生成中，暂时不能删除。");
			await store.deleteProject(project.id);
			return { deleted: true };
		});
	}

	// ── 参考文档 ─────────────────────────────────────────────────────────────

	async function addReference({ projectId, tmpPath, name }) {
		const project = normalizeProject(await projectOrThrow(projectId));
		const cleanName = safeFileName(name, "参考文档");
		const ext = path.extname(cleanName).slice(1).toLowerCase() || "txt";
		const refId = store.genId("ref");
		const dir = store.refDir(project.id, refId);
		await mkdir(dir, { recursive: true });
		let size = 0;
		try {
			size = (await stat(tmpPath)).size;
		} catch {
			size = 0;
		}
		const target = store.refSourcePath(project.id, refId, `source.${ext}`);
		await copyFile(tmpPath, target);

		const ref = {
			id: refId,
			name: cleanName,
			size,
			ext,
			status: "processing",
			error: null,
			chars: 0,
			truncated: false,
			method: ext,
			addedAt: now(),
		};
		try {
			const extracted = await extractText({ filePath: target, name: cleanName });
			await store.writeRefText(project.id, refId, extracted.text);
			ref.status = "ready";
			ref.chars = extracted.chars;
			ref.truncated = extracted.truncated === true;
			ref.method = extracted.method ?? ext;
		} catch (error) {
			ref.status = "error";
			ref.error = toAppError(error).message;
			logger?.warn?.(`[doc-creator] extract failed for ${cleanName}: ${ref.error}`);
		}
		return exclusive(async () => {
			const latest = normalizeProject(await projectOrThrow(projectId));
			latest.refs.push(ref);
			await save(latest);
			return { project: await decorateProject(latest), ref };
		});
	}

	async function removeReference({ projectId, refId }) {
		return exclusive(async () => {
			const project = normalizeProject(await projectOrThrow(projectId));
			const index = project.refs.findIndex((ref) => ref.id === refId);
			if (index < 0) throw new AppError("not-found", "参考文档不存在");
			project.refs.splice(index, 1);
			await save(project);
			await rm(store.refDir(project.id, refId), { recursive: true, force: true }).catch(() => undefined);
			return { project: await decorateProject(project) };
		});
	}

	async function readReferencePreview({ projectId, refId, maxChars = 4000 }) {
		const project = normalizeProject(await projectOrThrow(projectId));
		const ref = project.refs.find((item) => item.id === refId);
		if (ref === undefined) throw new AppError("not-found", "参考文档不存在");
		const text = (await store.readRefText(project.id, refId)) ?? "";
		const limit = Math.max(200, Math.min(20000, Number.isFinite(maxChars) ? maxChars : 4000));
		return { name: ref.name, text: text.slice(0, limit), truncated: text.length > limit };
	}

	// ── 联网检索 ─────────────────────────────────────────────────────────────

	/**
	 * 生成前刷新联网资料；失败退化为 warning（不阻断生成）。返回 sources。
	 */
	async function refreshSources(project, template, engine, job) {
		if (project.webSearch.enabled !== true) return { sources: [], warnings: [], queries: [], searchedAt: null };
		const search = getSearch();
		if (search === null || search === undefined) {
			return { sources: project.sources, warnings: ["联网服务未就绪，本次未检索新资料。"], queries: [], searchedAt: null };
		}
		let queries = [];
		try {
			queries = engine.planSearchQueries({ project, template });
		} catch {
			queries = [];
		}
		if (queries.length === 0) {
			queries = [project.topic || project.name].map((query) => query.trim()).filter((query) => query !== "");
		}
		job.update(12, `正在联网检索：${queries.join(" / ")}`);
		const collected = [];
		const warnings = [];
		const seen = new Set();
		for (const query of queries) {
			try {
				const { sources } = await search.search({ query, maxResults: 6 });
				for (const source of sources) {
					if (source.url === "" || seen.has(source.url)) continue;
					seen.add(source.url);
					collected.push({ ...source, addedAt: now() });
					if (collected.length >= 12) break;
				}
			} catch (error) {
				warnings.push(`联网检索「${query}」失败：${toAppError(error).message}`);
			}
			if (collected.length >= 12) break;
		}
		let sources = [];
		if (collected.length > 0) {
			sources = collected.map((source, index) => ({
				id: `src-${index + 1}`,
				title: source.title,
				url: source.url,
				snippet: source.snippet ?? "",
				addedAt: source.addedAt ?? now(),
			}));
		} else if (project.sources.length > 0) {
			sources = project.sources;
			warnings.push("本次联网检索没有结果，沿用上次检索到的资料。");
		}
		return { sources, warnings, queries, searchedAt: now() };
	}

	// ── 大纲 ────────────────────────────────────────────────────────────────

	async function generateOutline({ projectId }) {
		const project = normalizeProject(await projectOrThrow(projectId));
		modelOrThrow();
		const template = templateFor(project);
		if (project.topic.trim() === "" && project.refs.filter((ref) => ref.status === "ready").length === 0) {
			throw new AppError("bad-request", "请先填写写作主题，或上传至少一份可解析的参考文档。");
		}
		return startJob({
			kind: "outline",
			projectId: project.id,
			phase: "大纲",
			run: async (job) => {
				const engine = engineFor(project);
				job.update(5, "读取参考文档…");
				const references = await readReferences(project);
				const searched = await refreshSources(project, template, engine, job);
				const sources = searched.sources;
				const warnings = searched.warnings;
				job.update(30, "正在生成大纲…");
				const result = await engine.generateOutline({ project, template, references, sources, job });
				const outline = result.outline;
				const warns = [...warnings, ...(result.warnings ?? [])];
				const version = Math.max(0, ...project.outline.versions.map((item) => item.version)) + 1;
				const createdAt = now();
				const data = {
					version,
					title: outline.title,
					sections: outline.sections,
					createdAt,
					model: project.model ?? null,
				};
				job.update(90, "保存大纲…");
				return exclusive(async () => {
					const latest = normalizeProject(await projectOrThrow(projectId));
					if (sources.length > 0) latest.sources = sources;
					if (searched.queries.length > 0) latest.webSearch.queries = searched.queries;
					if (searched.searchedAt !== null) latest.webSearch.lastSearchAt = searched.searchedAt;
					await store.writeOutline(latest.id, version, data);
					for (const meta of latest.outline.versions) if (meta.status === "confirmed") meta.status = "draft";
					latest.outline.versions.push({
						version,
						title: outline.title,
						sectionCount: outline.sections.length,
						chars: outlineChars(outline.sections),
						createdAt,
						changeNote: latest.outline.versions.length === 0 ? "初始生成" : "重新生成",
						status: "draft",
						sourceCount: latest.sources.length,
					});
					latest.outline.active = version;
					latest.outline.confirmed = null;
					latest.warnings = warns.slice(-10);
					await save(latest);
					return { outlineVersion: version, warnings: warns };
				});
			},
		});
	}

	async function confirmOutline({ projectId, version }) {
		return exclusive(async () => {
			const project = normalizeProject(await projectOrThrow(projectId));
			const target = project.outline.versions.find((item) => item.version === Number(version));
			if (target === undefined) throw new AppError("not-found", "该大纲版本不存在");
			for (const meta of project.outline.versions) meta.status = meta.version === target.version ? "confirmed" : "draft";
			project.outline.active = target.version;
			project.outline.confirmed = target.version;
			await save(project);
			return { project: await decorateProject(project) };
		});
	}

	// ── 成文 ────────────────────────────────────────────────────────────────

	/** 确定性校验：长度 / 章节覆盖 / 引用。 */
	function deterministicValidation(project, outline, markdown) {
		const report = [];
		const wordCount = countWords(markdown);
		const target = TARGET_WORDS[project.style.length] ?? TARGET_WORDS.standard;
		const lower = Math.round(target.min * 0.7);
		const upper = Math.round(target.max * 1.35);
		report.push({
			kind: "length",
			label: `篇幅（目标 ${target.min}–${target.max} 字）`,
			status: wordCount < lower || wordCount > upper ? "risk" : "pass",
			note: `实际约 ${wordCount} 字。`,
		});
		const headings = markdownHeadings(markdown).map(normalizeHeading);
		const missing = [];
		for (const section of outline.sections ?? []) {
			const wanted = normalizeHeading(section.heading);
			if (wanted === "") continue;
			if (!headings.some((heading) => heading === wanted || heading.includes(wanted) || wanted.includes(heading))) missing.push(section.heading);
		}
		report.push({
			kind: "section",
			label: "大纲章节覆盖",
			status: missing.length === 0 ? "pass" : "risk",
			note: missing.length === 0 ? "已确认大纲的章节均出现在成文中。" : `缺少章节：${missing.join("、")}`,
		});
		if ((project.sources ?? []).length > 0) {
			const hasCitation = /\[\d+\]/.test(markdown);
			const hasReferenceList = /参考(资料|文献)/.test(markdown);
			report.push({
				kind: "citation",
				label: "引用标注",
				status: hasCitation && hasReferenceList ? "pass" : "risk",
				note: hasCitation && hasReferenceList ? "已包含引用编号与参考资料小节。" : "使用联网资料时建议用 [n] 标注并在文末列出参考资料。",
			});
		}
		return report;
	}

	async function runRedlineCheck({ engine, project, outline, markdown, job }) {
		if ((project.redlines ?? []).length === 0) return [];
		try {
			job.update(78, "正在进行红线自检…");
			const result = await engine.checkRedlines({ project, redlines: project.redlines, outline, markdown, job });
			return (result.report ?? []).map((item) => ({
				kind: "redline",
				label: item.label,
				status: item.status,
				note: item.note ?? "",
			}));
		} catch (error) {
			logger?.warn?.(`[doc-creator] redline check failed: ${toAppError(error).message}`);
			return [
				{
					kind: "redline",
					label: "红线自检",
					status: "unknown",
					note: `自检失败：${toAppError(error).message}`,
				},
			];
		}
	}

	/** 把成文写盘（Markdown + Word），返回 {meta, warnings}。 */
	async function persistDocument({ project, outline, markdown, title, validation, warnings }) {
		const version = Math.max(0, ...project.document.versions.map((item) => item.version)) + 1;
		const createdAt = now();
		const format = ["md"];
		let docxWarning = null;
		await mkdir(path.dirname(store.documentPath(project.id, version, "md")), { recursive: true });
		await store.writeDocumentFile(project.id, version, "md", markdown);
		try {
			await buildDocx({
				markdown,
				title,
				subtitle: project.topic.trim() === "" ? undefined : project.topic.trim().slice(0, 120),
				meta: { date: todayLabel(), project: project.name, generator: "DSH 文档创作" },
				outPath: store.documentPath(project.id, version, "docx"),
			});
			format.push("docx");
		} catch (error) {
			docxWarning = `Word 导出失败：${toAppError(error).message}（可下载 Markdown）`;
			logger?.warn?.(`[doc-creator] docx build failed: ${docxWarning}`);
		}
		const meta = {
			version,
			outlineVersion: outline.version,
			title,
			wordCount: countWords(markdown),
			createdAt,
			format,
			model: project.model ?? null,
			validation,
		};
		const warns = [...warnings, ...(docxWarning === null ? [] : [docxWarning])];
		project.document.versions.push(meta);
		project.document.active = version;
		project.warnings = warns.slice(-10);
		return { version, meta, warnings: warns };
	}

	async function generateDocument({ projectId, outlineVersion }) {
		const project = normalizeProject(await projectOrThrow(projectId));
		modelOrThrow();
		const confirmed = Number.isInteger(outlineVersion) ? outlineVersion : project.outline.confirmed;
		if (!Number.isInteger(confirmed) || confirmed === null) throw new AppError("conflict", "请先确认大纲，再生成成文。");
		const versionMeta = project.outline.versions.find((item) => item.version === confirmed);
		if (versionMeta === undefined) throw new AppError("not-found", "已确认的大纲版本不存在，请重新确认大纲。");
		const template = templateFor(project);
		return startJob({
			kind: "document",
			projectId: project.id,
			phase: "成文",
			run: async (job) => {
				const engine = engineFor(project);
				job.update(5, "整理大纲与参考资料…");
				const outlineData = await store.readOutline(project.id, confirmed);
				if (outlineData === null) throw new AppError("not-found", "大纲文件缺失，请重新生成大纲。");
				const references = await readReferences(project);
				job.update(15, "正在撰写正文…");
				const result = await engine.generateDocument({
					project,
					template,
					outline: outlineData,
					references,
					sources: project.webSearch.enabled ? project.sources : [],
					job,
				});
				const markdown = result.markdown;
				job.update(75, "正在校验…");
				const validation = [...deterministicValidation(project, outlineData, markdown)];
				validation.push(...(await runRedlineCheck({ engine, project, outline: outlineData, markdown, job })));
				job.update(88, "排版并导出 Word…");
				return exclusive(async () => {
					const latest = normalizeProject(await projectOrThrow(projectId));
					const saved = await persistDocument({
						project: latest,
						outline: { ...outlineData, version: confirmed },
						markdown,
						title: result.title || outlineData.title || latest.name,
						validation,
						warnings: [...(result.warnings ?? [])],
					});
					await save(latest);
					return { documentVersion: saved.version, warnings: saved.warnings };
				});
			},
		});
	}

	// ── 对话调整（大纲 / 成文共享同一 conversation） ─────────────────────────

	async function chat({ projectId, message, phase }) {
		const text = trimText(message, MAX_CHAT_MESSAGE);
		if (text === "") throw new AppError("bad-request", "消息不能为空");
		if (phase !== "outline" && phase !== "document") throw new AppError("bad-request", "phase 必须是 outline 或 document");
		const project = normalizeProject(await projectOrThrow(projectId));
		modelOrThrow();
		if (phase === "document" && !Number.isInteger(project.outline.confirmed)) {
			throw new AppError("conflict", "请先确认大纲，再在成文阶段对话调整。");
		}
		const activeJob = jobs.activeForProject(project.id);
		if (activeJob !== null) throw new AppError("busy", "该项目已有生成任务在进行中，请等待完成后再试。");

		await exclusive(async () => {
			const latest = normalizeProject(await projectOrThrow(projectId));
			latest.conversation.messages.push(newMessage("user", text, phase));
			await save(latest);
		});

		const template = templateFor(project);
		return startJob({
			kind: "chat",
			projectId: project.id,
			phase: "对话",
			run: async (job) => {
				const engine = engineFor(project);
				const latest = normalizeProject(await projectOrThrow(projectId));
				const references = await readReferences(latest);
				const sources = latest.webSearch.enabled ? latest.sources : [];
				const outlineVersion = phase === "document" ? latest.outline.confirmed : latest.outline.active > 0 ? latest.outline.active : null;
				const outlineData = outlineVersion === null ? null : await store.readOutline(project.id, outlineVersion);
				let documentMarkdown = null;
				if (phase === "document") {
					const docVersion = latest.document.active > 0 ? latest.document.active : Math.max(0, ...latest.document.versions.map((item) => item.version));
					if (docVersion > 0) documentMarkdown = (await store.readDocumentFile(project.id, docVersion, "md"))?.toString("utf8") ?? null;
				}
				job.update(15, "AI 正在阅读上下文…");
				const result = await engine.revise({
					project: latest,
					template,
					phase,
					outline: outlineData,
					document: documentMarkdown,
					references,
					sources,
					message: text,
					job,
				});
				const reply = typeof result.reply === "string" && result.reply.trim() !== "" ? result.reply.trim() : "已按你的要求处理。";
				const warnings = [...(result.warnings ?? [])];
				let action = null;
				let outlineVersion2;
				let documentVersion;
				if (result.outline !== undefined && result.outline !== null) {
					job.update(70, "保存新大纲版本…");
					const saved = await exclusive(async () => {
						const current = normalizeProject(await projectOrThrow(projectId));
						const version = Math.max(0, ...current.outline.versions.map((item) => item.version)) + 1;
						const createdAt = now();
						const data = { version, title: result.outline.title, sections: result.outline.sections, createdAt, model: current.model ?? null };
						await store.writeOutline(current.id, version, data);
						for (const meta of current.outline.versions) if (meta.status === "confirmed") meta.status = "draft";
						current.outline.versions.push({
							version,
							title: result.outline.title,
							sectionCount: result.outline.sections.length,
							chars: outlineChars(result.outline.sections),
							createdAt,
							changeNote: "用户对话调整",
							status: "draft",
							sourceCount: current.sources.length,
						});
						current.outline.active = version;
						current.outline.confirmed = null;
						await save(current);
						return { version };
					});
					outlineVersion2 = saved.version;
					action = { kind: "outline", version: saved.version };
				}
				if (result.markdown !== undefined && result.markdown !== null) {
					job.update(72, "进行红线自检与排版…");
					const outlineForSave = outlineData ?? { version: 0, title: latest.name, sections: [] };
					const validation = [...deterministicValidation(latest, outlineForSave, result.markdown)];
					validation.push(...(await runRedlineCheck({ engine, project: latest, outline: outlineForSave, markdown: result.markdown, job })));
					const saved = await exclusive(async () => {
						const current = normalizeProject(await projectOrThrow(projectId));
						const persist = await persistDocument({
							project: current,
							outline: { ...outlineForSave, version: outlineForSave.version ?? 0 },
							markdown: result.markdown,
							title: outlineForSave.title || current.name,
							validation,
							warnings,
						});
						await save(current);
						return persist;
					});
					documentVersion = saved.version;
					action = { kind: "document", version: saved.version };
				}
				job.update(95, "整理对话回复…");
				await exclusive(async () => {
					const current = normalizeProject(await projectOrThrow(projectId));
					current.conversation.messages.push(newMessage("assistant", reply, phase, { action }));
					await save(current);
				});
				return { reply, outlineVersion: outlineVersion2, documentVersion, warnings };
			},
		});
	}

	// ── 读取 / 下载 ─────────────────────────────────────────────────────────

	async function getDocument({ projectId, version }) {
		const project = normalizeProject(await projectOrThrow(projectId));
		const target = Number.isInteger(version) ? version : project.document.active || Math.max(0, ...project.document.versions.map((item) => item.version));
		if (!Number.isInteger(target) || target <= 0) throw new AppError("not-found", "还没有生成成文");
		const meta = project.document.versions.find((item) => item.version === target);
		if (meta === undefined) throw new AppError("not-found", "成文版本不存在");
		const markdown = (await store.readDocumentFile(project.id, target, "md"))?.toString("utf8");
		if (markdown === undefined) throw new AppError("not-found", "成文文件缺失，请重新生成");
		return { markdown, meta };
	}

	async function getDownload({ projectId, version, ext }) {
		const project = normalizeProject(await projectOrThrow(projectId));
		const target = Number.isInteger(version) ? version : project.document.active;
		if (!Number.isInteger(target) || target <= 0) throw new AppError("not-found", "还没有可下载的成文");
		const meta = project.document.versions.find((item) => item.version === target);
		if (meta === undefined) throw new AppError("not-found", "成文版本不存在");
		if (ext !== "md" && ext !== "docx") throw new AppError("bad-request", "只支持下载 md 或 docx");
		const format = Array.isArray(meta.format) ? meta.format : ["md"];
		if (ext === "docx" && !format.includes("docx")) throw new AppError("not-found", "该版本没有 Word 文件，请下载 Markdown");
		const file = store.documentPath(project.id, target, ext);
		const title = safeFileName(meta.title || project.name, "文档");
		return {
			file,
			name: `${title}-v${target}.${ext}`,
			mime: ext === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "text/markdown; charset=utf-8",
		};
	}

	async function listModels() {
		const model = getModel();
		if (model === null || model === undefined) return { selection: null, providers: [] };
		return await model.listModels();
	}

	return {
		listTemplates,
		listProjects,
		createProject,
		getProject,
		updateProject,
		deleteProject,
		addReference,
		removeReference,
		readReferencePreview,
		generateOutline,
		confirmOutline,
		generateDocument,
		chat,
		getDocument,
		getDownload,
		listModels,
	};
}
