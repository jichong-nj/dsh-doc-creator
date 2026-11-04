/**
 * 文档创作插件的本地持久化层（store）。
 *
 * 职责边界：
 *   - 只负责「按约定目录布局读写文件」，不理解业务语义、不调用 LLM、不联网；
 *   - 所有外部传入的 projectId / refId / version 一律先校验，防止路径穿越；
 *   - 所有 JSON / 文本写入均为「同目录临时文件 + rename」原子写，避免进程中断留下半截文件；
 *   - index.json 保存项目摘要（Summary），由 Project 派生，供列表页快速渲染。
 *
 * 目录布局（详见 CONTRACTS.md）：
 *   <dataDir>/index.json
 *   <dataDir>/projects/<projectId>/meta.json | conversation.json
 *   <dataDir>/projects/<projectId>/refs/<refId>/source<.ext> | text.txt
 *   <dataDir>/projects/<projectId>/outlines/<version>.json
 *   <dataDir>/projects/<projectId>/documents/<version>.md | <version>.docx
 *   <dataDir>/tmp/<random>/
 *
 * @module lib/store
 */

import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** projectId / refId 的唯一合法格式：小写字母或数字开头，只含小写字母、数字、短横线，长度 1–65。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,64}$/;

/** 大纲 / 成文版本号合法区间（闭区间）。 */
const MIN_VERSION = 1;
const MAX_VERSION = 9999;

/** 成文文件允许的扩展名（与契约一致）。 */
const DOCUMENT_EXTS = new Set(["md", "docx"]);

/** 项目阶段合法值。 */
const STAGES = new Set(["setup", "outline", "document"]);

/**
 * 校验并返回 id。
 * 非法 id 会直接抛错（消息可直接展示给用户），调用方无需再做二次判断。
 * @param {unknown} id 待校验的 id
 * @param {string} [label="ID"] 出错信息里使用的字段名
 * @returns {string} 原样返回合法 id
 */
export function assertId(id, label = "ID") {
	if (typeof id !== "string" || !ID_PATTERN.test(id)) {
		const shown = typeof id === "string" ? id.slice(0, 40) : String(id);
		throw new Error(`非法${label}：${shown}（只允许小写字母、数字和短横线，长度 1–65）`);
	}
	return id;
}

/**
 * 校验版本号：必须是 1–9999 的整数。
 * @param {unknown} version 版本号
 * @returns {number} 合法版本号
 */
function assertVersion(version) {
	const value = typeof version === "string" && /^\d+$/.test(version) ? Number(version) : version;
	if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_VERSION || value > MAX_VERSION) {
		throw new Error(`非法版本号：${String(version)}（必须是 1–${MAX_VERSION} 的整数）`);
	}
	return value;
}

/**
 * 生成随机短 token（用于临时文件名）。
 * @param {number} [bytes=6] 随机字节数
 * @returns {string} 十六进制字符串
 */
function randomToken(bytes = 6) {
	return randomBytes(bytes).toString("hex");
}

/**
 * 原子写文件：先写同目录 `.<rand>.tmp`，再 rename 覆盖目标。
 * rename 在同一文件系统内是原子操作，可避免读到半截文件。
 * @param {string} filePath 目标绝对路径
 * @param {string|Uint8Array} data 写入内容
 */
async function atomicWrite(filePath, data) {
	const dir = path.dirname(filePath);
	await mkdir(dir, { recursive: true });
	const tmpPath = path.join(dir, `.${process.pid}-${randomToken(4)}.tmp`);
	try {
		await writeFile(tmpPath, data);
		await rename(tmpPath, filePath);
	} catch (error) {
		await rm(tmpPath, { force: true }).catch(() => {});
		throw error;
	}
}

/**
 * 原子写 JSON（缩进固定 1 空格，便于人工排查）。
 * @param {string} filePath 目标路径
 * @param {unknown} value 可 JSON 序列化的值
 */
async function atomicWriteJson(filePath, value) {
	await atomicWrite(filePath, JSON.stringify(value, null, 1));
}

/**
 * 读取并解析 JSON；文件缺失或内容损坏时返回 fallback（不抛错）。
 * @template T
 * @param {string} filePath 文件路径
 * @param {T} fallback 兜底值
 * @returns {Promise<T>} 解析结果或兜底值
 */
async function readJsonOr(filePath, fallback) {
	try {
		const raw = await readFile(filePath, "utf8");
		const parsed = JSON.parse(raw);
		return parsed ?? fallback;
	} catch {
		return fallback;
	}
}

/** 空索引。 */
function emptyIndex() {
	return { projects: {} };
}

/**
 * 把磁盘上的 index.json 归一化：缺字段/损坏都退化为空索引。
 * @param {unknown} value 原始解析结果
 * @returns {{projects: Record<string, object>}} 归一化索引
 */
function normalizeIndex(value) {
	if (!value || typeof value !== "object") return emptyIndex();
	const projects = value.projects;
	if (!projects || typeof projects !== "object" || Array.isArray(projects)) return emptyIndex();
	const normalized = {};
	for (const [id, summary] of Object.entries(projects)) {
		if (summary && typeof summary === "object" && !Array.isArray(summary)) normalized[id] = summary;
	}
	return { projects: normalized };
}

/**
 * 数字兜底转换。
 * @param {unknown} value 原始值
 * @param {number} [fallback=0] 兜底值
 * @returns {number}
 */
function toNumber(value, fallback = 0) {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 取数组中对象元素的个数。
 * @param {unknown} value 候选数组
 * @returns {number}
 */
function countOf(value) {
	return Array.isArray(value) ? value.length : 0;
}

/**
 * 把 index.json 里可能残缺的 Summary 归一化，避免前端拿到 undefined。
 * @param {object} raw 原始摘要
 * @returns {object} 归一化摘要
 */
function normalizeSummary(raw) {
	const stage = STAGES.has(raw.stage) ? raw.stage : "setup";
	return {
		id: typeof raw.id === "string" ? raw.id : "",
		name: typeof raw.name === "string" ? raw.name : "",
		createdAt: toNumber(raw.createdAt),
		updatedAt: toNumber(raw.updatedAt),
		stage,
		templateId: typeof raw.templateId === "string" ? raw.templateId : "free",
		refsCount: toNumber(raw.refsCount),
		outlineCount: toNumber(raw.outlineCount),
		outlineActive: toNumber(raw.outlineActive),
		confirmed: typeof raw.confirmed === "number" ? raw.confirmed : null,
		documentCount: toNumber(raw.documentCount),
		documentActive: typeof raw.documentActive === "number" ? raw.documentActive : null,
		lastMessageAt: toNumber(raw.lastMessageAt),
	};
}

/**
 * 从 Project 派生 Summary（严格按 CONTRACTS.md 的 Summary 结构）。
 * @param {object} project Project 对象
 * @param {number} lastMessageAt 会话最后消息时间（0 表示无消息）
 * @returns {object} Summary
 */
function deriveSummary(project, lastMessageAt) {
	const outline = project && typeof project.outline === "object" && project.outline ? project.outline : {};
	const document = project && typeof project.document === "object" && project.document ? project.document : {};
	const outlineVersions = Array.isArray(outline.versions) ? outline.versions : [];
	const confirmed = typeof outline.confirmed === "number" ? outline.confirmed : null;
	const stage = outlineVersions.length === 0 ? "setup" : confirmed === null ? "outline" : "document";
	return {
		id: String(project.id ?? ""),
		name: typeof project.name === "string" ? project.name : "",
		createdAt: toNumber(project.createdAt),
		updatedAt: toNumber(project.updatedAt),
		stage,
		templateId: typeof project.templateId === "string" ? project.templateId : "free",
		refsCount: countOf(project.refs),
		outlineCount: outlineVersions.length,
		outlineActive: toNumber(outline.active),
		confirmed,
		documentCount: countOf(document.versions),
		documentActive: typeof document.active === "number" ? document.active : null,
		lastMessageAt: toNumber(lastMessageAt),
	};
}

/**
 * 从会话消息数组里取最后活动时间：优先最大 `at`，退化为数组末项的 `at`。
 * @param {Array<object>} messages 消息数组
 * @returns {number} 毫秒时间戳（无消息为 0）
 */
function lastMessageAtOf(messages) {
	if (!Array.isArray(messages) || messages.length === 0) return 0;
	let latest = 0;
	for (const message of messages) {
		if (message && typeof message === "object") latest = Math.max(latest, toNumber(message.at));
	}
	return latest;
}

/**
 * 校验并清洗参考文件名，保留扩展名、去掉目录成分。
 * 输出形如 `source.docx`，保证写入路径始终落在 refs/<refId>/ 下。
 * @param {string} filename 原始文件名
 * @returns {string} 磁盘文件名
 */
function sanitizeRefFilename(filename) {
	const raw = typeof filename === "string" ? filename : "";
	const base = raw.split(/[\\/]/).pop() ?? "";
	const match = /\.([a-zA-Z0-9]{1,10})$/.exec(base);
	const ext = match ? match[1].toLowerCase() : "";
	return ext ? `source.${ext}` : "source";
}

/**
 * 创建 store 实例。
 *
 * @param {string} dataDir 数据根目录（如 ~/.dsh/data/doc-creator）
 * @returns {object} store 实例
 */
export function createStore(dataDir) {
	if (typeof dataDir !== "string" || dataDir.trim() === "") {
		throw new Error("createStore 需要有效的 dataDir");
	}
	const root = path.resolve(dataDir);
	const projectsRoot = path.join(root, "projects");
	const tmpRoot = path.join(root, "tmp");
	const indexPath = path.join(root, "index.json");

	/**
	 * 项目目录绝对路径。
	 * @param {string} id projectId
	 * @returns {string}
	 */
	function projectDir(id) {
		return path.join(projectsRoot, assertId(id, "项目 ID"));
	}

	/**
	 * 参考文档目录绝对路径。
	 * @param {string} id projectId
	 * @param {string} refId refId
	 * @returns {string}
	 */
	function refDir(id, refId) {
		return path.join(projectDir(id), "refs", assertId(refId, "参考文档 ID"));
	}

	/**
	 * 参考文档原始文件路径（保留上传文件扩展名，文件名统一为 source<.ext>）。
	 * @param {string} id projectId
	 * @param {string} refId refId
	 * @param {string} filename 原始文件名（用于取扩展名）
	 * @returns {string}
	 */
	function refSourcePath(id, refId, filename) {
		return path.join(refDir(id, refId), sanitizeRefFilename(filename));
	}

	/**
	 * 大纲版本文件路径。
	 * @param {string} id projectId
	 * @param {number} version 版本号（1–9999）
	 * @returns {string}
	 */
	function outlinePath(id, version) {
		return path.join(projectDir(id), "outlines", `${assertVersion(version)}.json`);
	}

	/**
	 * 成文版本文件路径。
	 * @param {string} id projectId
	 * @param {number} version 版本号（1–9999）
	 * @param {"md"|"docx"} ext 扩展名
	 * @returns {string}
	 */
	function documentPath(id, version, ext) {
		const normalizedExt = typeof ext === "string" ? ext.replace(/^\./, "").toLowerCase() : "";
		if (!DOCUMENT_EXTS.has(normalizedExt)) {
			throw new Error(`非法成文格式：${String(ext)}（只支持 md / docx）`);
		}
		return path.join(projectDir(id), "documents", `${assertVersion(version)}.${normalizedExt}`);
	}

	/**
	 * 确保数据目录结构存在（幂等）。
	 * @returns {Promise<{dataDir: string, projectsRoot: string, tmpRoot: string}>}
	 */
	async function ensureDirs() {
		await mkdir(root, { recursive: true });
		await mkdir(projectsRoot, { recursive: true });
		await mkdir(tmpRoot, { recursive: true });
		return { dataDir: root, projectsRoot, tmpRoot };
	}

	/**
	 * 读取索引。文件缺失或损坏时返回空索引。
	 * @returns {Promise<{projects: Record<string, object>}>}
	 */
	async function loadIndex() {
		const parsed = await readJsonOr(indexPath, null);
		const index = normalizeIndex(parsed);
		return index;
	}

	/**
	 * 原子写入索引。
	 * @param {{projects?: Record<string, object>}} index 索引对象
	 * @returns {Promise<void>}
	 */
	async function saveIndex(index) {
		await atomicWriteJson(indexPath, normalizeIndex(index));
	}

	/**
	 * 读取项目 meta.json。
	 * @param {string} id projectId
	 * @returns {Promise<object|null>} 项目对象；缺失或损坏返回 null
	 */
	async function readProject(id) {
		const dir = projectDir(id);
		const parsed = await readJsonOr(path.join(dir, "meta.json"), null);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed;
	}

	/**
	 * 列出全部项目摘要（updatedAt 降序；时间相同时按 id 升序保证稳定）。
	 * @returns {Promise<object[]>} Summary 数组
	 */
	async function listProjects() {
		const index = await loadIndex();
		const summaries = Object.values(index.projects).map(normalizeSummary);
		summaries.sort((a, b) => {
			if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
			if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});
		return summaries;
	}

	/**
	 * 读取会话（两阶段共享同一份消息数组）。
	 * @param {string} id projectId
	 * @returns {Promise<{messages: object[]}>} 会话对象；缺失或损坏返回空会话
	 */
	async function readConversation(id) {
		const dir = projectDir(id);
		const parsed = await readJsonOr(path.join(dir, "conversation.json"), null);
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.messages)) return { messages: [] };
		return { ...parsed, messages: parsed.messages.filter((item) => item && typeof item === "object") };
	}

	/**
	 * 原子写入项目 meta.json，并同步 index.json 中的 Summary。
	 * @param {object} project Project 对象（须含合法 id）
	 * @returns {Promise<object>} 写入后的 Summary
	 */
	async function writeProject(project) {
		if (!project || typeof project !== "object" || Array.isArray(project)) {
			throw new Error("writeProject 需要完整的项目对象");
		}
		const id = assertId(project.id, "项目 ID");
		const conversation = await readConversation(id);
		const summary = deriveSummary(project, lastMessageAtOf(conversation.messages));
		await ensureDirs();
		await atomicWriteJson(path.join(projectDir(id), "meta.json"), project);
		const index = await loadIndex();
		index.projects[id] = summary;
		await saveIndex(index);
		return summary;
	}

	/**
	 * 删除项目目录并从索引移除（幂等：不存在时不报错）。
	 * @param {string} id projectId
	 * @returns {Promise<boolean>} 索引中原本是否存在该项目
	 */
	async function deleteProject(id) {
		const dir = projectDir(id);
		await rm(dir, { recursive: true, force: true });
		const index = await loadIndex();
		const existed = Object.hasOwn(index.projects, id);
		if (existed) {
			delete index.projects[id];
			await saveIndex(index);
		}
		return existed;
	}

	/**
	 * 原子写入参考文档抽取出的纯文本。
	 * @param {string} id projectId
	 * @param {string} refId refId
	 * @param {string} text 纯文本
	 * @returns {Promise<string>} 写入路径
	 */
	async function writeRefText(id, refId, text) {
		const filePath = path.join(refDir(id, refId), "text.txt");
		await atomicWrite(filePath, typeof text === "string" ? text : String(text ?? ""));
		return filePath;
	}

	/**
	 * 读取参考文档纯文本。
	 * @param {string} id projectId
	 * @param {string} refId refId
	 * @returns {Promise<string|null>} 文本；不存在返回 null
	 */
	async function readRefText(id, refId) {
		try {
			return await readFile(path.join(refDir(id, refId), "text.txt"), "utf8");
		} catch {
			return null;
		}
	}

	/**
	 * 原子写入会话，并刷新索引中该项目的 lastMessageAt。
	 * @param {string} id projectId
	 * @param {{messages?: object[]}} conversation 会话对象
	 * @returns {Promise<{messages: object[]}>} 实际写入的会话
	 */
	async function writeConversation(id, conversation) {
		const projectId = assertId(id, "项目 ID");
		const messages = Array.isArray(conversation?.messages)
			? conversation.messages.filter((item) => item && typeof item === "object")
			: [];
		const payload = { messages };
		await atomicWriteJson(path.join(projectDir(projectId), "conversation.json"), payload);
		const project = await readProject(projectId);
		if (project) {
			const index = await loadIndex();
			index.projects[projectId] = deriveSummary(project, lastMessageAtOf(messages));
			await saveIndex(index);
		}
		return payload;
	}

	/**
	 * 原子写入大纲版本文件。
	 * @param {string} id projectId
	 * @param {number} version 版本号（1–9999）
	 * @param {object} outline 大纲对象
	 * @returns {Promise<string>} 写入路径
	 */
	async function writeOutline(id, version, outline) {
		const filePath = outlinePath(id, version);
		await atomicWriteJson(filePath, outline);
		return filePath;
	}

	/**
	 * 读取大纲版本文件。
	 * @param {string} id projectId
	 * @param {number} version 版本号（1–9999）
	 * @returns {Promise<object|null>} 大纲对象；缺失或损坏返回 null
	 */
	async function readOutline(id, version) {
		const parsed = await readJsonOr(outlinePath(id, version), null);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed;
	}

	/**
	 * 原子写入成文文件（Markdown 字符串或 Word 字节）。
	 * @param {string} id projectId
	 * @param {number} version 版本号
	 * @param {"md"|"docx"} ext 扩展名
	 * @param {string|Uint8Array} data 文件内容
	 * @returns {Promise<string>} 写入路径
	 */
	async function writeDocumentFile(id, version, ext, data) {
		const filePath = documentPath(id, version, ext);
		let payload = data;
		if (payload instanceof ArrayBuffer) payload = new Uint8Array(payload);
		if (typeof payload !== "string" && !(payload instanceof Uint8Array)) {
			throw new Error("writeDocumentFile 的 data 必须是字符串或 Uint8Array");
		}
		await atomicWrite(filePath, payload);
		return filePath;
	}

	/**
	 * 读取成文文件。
	 * @param {string} id projectId
	 * @param {number} version 版本号
	 * @param {"md"|"docx"} ext 扩展名
	 * @returns {Promise<Buffer|null>} 文件内容；不存在返回 null
	 */
	async function readDocumentFile(id, version, ext) {
		try {
			return await readFile(documentPath(id, version, ext));
		} catch {
			return null;
		}
	}

	/**
	 * 创建新的上传中转目录（mkdtemp，调用方负责用完后删除）。
	 * @returns {Promise<string>} 新目录绝对路径
	 */
	async function tmpDir() {
		await mkdir(tmpRoot, { recursive: true });
		return mkdtemp(path.join(tmpRoot, "upload-"));
	}

	return {
		dataDir: root,
		projectsRoot,
		ensureDirs,
		loadIndex,
		saveIndex,
		listProjects,
		readProject,
		writeProject,
		deleteProject,
		projectDir,
		refDir,
		refSourcePath,
		writeRefText,
		readRefText,
		readConversation,
		writeConversation,
		outlinePath,
		writeOutline,
		readOutline,
		documentPath,
		writeDocumentFile,
		readDocumentFile,
		tmpDir,
		assertId,
		genId,
	};
}

/**
 * 生成新 id：`<prefix>-<base36 时间戳>-<8 位十六进制随机>`，形如 `doc-m1a2b3c4-9f0e1a2b`。
 * 随机部分取 4 字节（8 位 hex）：同毫秒批量生成时碰撞概率远低于 4 位 hex（65536 空间）。
 * @param {string} prefix 语义前缀（如 doc / ref / msg / job）
 * @returns {string} 新 id
 */
export function genId(prefix) {
	const safePrefix =
		String(prefix ?? "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 16) || "id";
	const timestamp = Date.now().toString(36);
	return `${safePrefix}-${timestamp}-${randomToken(4)}`;
}
