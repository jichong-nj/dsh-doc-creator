// lib/engine.js —— 文档创作 LLM 引擎
//
// 职责（见 CONTRACTS.md 第 E 节）：
//   · 构建高质量简体中文提示词（模板骨架、参考文档摘录、联网资料、红线要求、共享对话上下文）；
//   · 调用注入的 callModel，并按 <OUTLINE>/<DOCUMENT>/<REPORT> 标签协议解析模型输出；
//   · 对模型输出做宽容解析与归一化，保证上层（service）拿到的数据结构稳定；
//   · 不发起联网检索：service 负责调用注入的 search 并传入 sources，
//     引擎只提供确定性的 planSearchQueries 并把已组装的资料注入提示词。
//
// 设计约束：
//   · 本模块不读写磁盘、不直接访问网络 / DSH ctx；callModel / search / logger 都由 createEngine 注入；
//   · createEngine 无状态、可重复创建（service 每次生成都会新建实例以绑定项目模型）；
//   · 不使用随机数，提示词构建是确定性的；
//   · 所有面向用户的错误信息均为简体中文。

/* ───────────────────────── 常量与预算 ───────────────────────── */

const LIMITS = Object.freeze({
	referencePerDoc: 6000, // 单条参考文档摘录上限（字符）
	referenceTotal: 16000, // 参考文档摘录总量上限（字符）
	sourceTotal: 6000, // 联网资料注入总量上限（字符）
	sourceMaxItems: 12, // 最多保留 / 注入的联网资料条数
	conversationMessages: 30, // 对话上下文最多条数
	conversationChars: 12000, // 对话上下文最多字符数
	outlineMinSections: 2, // 归一化后大纲最少节数
	outlineMaxSections: 20, // 归一化后大纲最多节数
	outlineMaxPoints: 8, // 每节最多要点数
	reviseDocumentChars: 30000, // 对话调整时注入的当前成文上限
	checkDocumentChars: 40000, // 红线自检时注入的正文上限
});

const MAX_TOKENS = Object.freeze({
	outline: 4000,
	documentShort: 5000,
	documentStandard: 9000,
	documentDetailed: 14000,
	revise: 9000,
	check: 3000,
});

const TEMPERATURE = Object.freeze({
	outline: 0.7,
	document: 0.6,
	revise: 0.5,
	check: 0.2,
});

// 与 lib/templates.js 的 styleLabels() 保持一致的兜底中文标签（引擎不 import 其它模块）
const AUDIENCE_LABELS = Object.freeze({
	general: "通用读者",
	management: "管理层",
	technical: "技术读者",
	client: "客户/外部",
});
const TONE_LABELS = Object.freeze({
	formal: "正式严谨",
	professional: "专业清晰",
	friendly: "友好易懂",
});
const LENGTH_LABELS = Object.freeze({
	short: "简短（约 800–1200 字）",
	standard: "标准（约 2000–3500 字）",
	detailed: "详尽（约 4500–7000 字）",
});

const LENGTH_MAX_TOKENS = Object.freeze({
	short: MAX_TOKENS.documentShort,
	standard: MAX_TOKENS.documentStandard,
	detailed: MAX_TOKENS.documentDetailed,
});

const TAG_NAMES = ["OUTLINE", "DOCUMENT", "REPORT"];

/* ───────────────────────── 通用小工具 ───────────────────────── */

/** 把任意值转成干净的文本：数组用「；」连接，对象忽略，去掉零宽字符与回车差异。 */
function cleanText(value) {
	if (value == null) return "";
	if (Array.isArray(value)) {
		return value
			.map((item) => cleanText(item))
			.filter(Boolean)
			.join("；");
	}
	if (typeof value === "object") return "";
	return String(value)
		.replace(/\u200b|\ufeff/g, "")
		.replace(/\r\n?/g, "\n")
		.trim();
}

/** 单行文本：把内部连续空白折叠成一个空格。 */
function cleanLine(value) {
	return cleanText(value).replace(/\s+/g, " ").trim();
}

/** 截断到指定长度（不附加省略号）。 */
function clip(value, max) {
	const text = String(value ?? "");
	return text.length > max ? text.slice(0, max) : text;
}

/** 提取错误信息，保证给用户看的文案不是空字符串。 */
function errorMessage(error) {
	const message = cleanLine(error?.message ?? error);
	return message || "未知错误";
}

/** 判断两个文本在忽略空白差异后是否相同。 */
function sameText(left, right) {
	const normalize = (value) => cleanText(value).replace(/\s+/g, " ");
	return normalize(left) === normalize(right);
}

/* ───────────────────────── JSON 宽容解析 ───────────────────────── */

/**
 * 去掉 JSON 文本中的尾随逗号（跳过字符串内的逗号）。
 * 例如 {"a":1,} -> {"a":1}；[{"a":1},] -> [{"a":1}]。
 */
function stripTrailingCommas(source) {
	let output = "";
	let inString = false;
	let escaped = false;
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (inString) {
			output += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			output += char;
			continue;
		}
		if (char === ",") {
			let next = index + 1;
			while (next < source.length && /\s/.test(source[next])) next++;
			if (source[next] === "}" || source[next] === "]") continue; // 丢弃尾随逗号
		}
		output += char;
	}
	return output;
}

/** 对一段候选 JSON 文本做宽容解析，失败返回 undefined。 */
function parseJsonLoose(candidate) {
	if (typeof candidate !== "string") return undefined;
	const cleaned = candidate.replace(/^\ufeff/, "").replace(/[\u2028\u2029]/g, " ");
	const attempts = [cleaned, stripTrailingCommas(cleaned), cleaned.replace(/,\s*$/, "")];
	for (const attempt of attempts) {
		if (!attempt) continue;
		try {
			return JSON.parse(attempt);
		} catch {
			// 尝试下一种修复方式
		}
	}
	return undefined;
}

/** 从 start 处的括号开始做字符串感知的配对扫描，返回闭合括号下标（失败 -1）。 */
function matchBracketEnd(source, start) {
	const stack = [];
	let inString = false;
	let escaped = false;
	for (let index = start; index < source.length; index++) {
		const char = source[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{" || char === "[") {
			stack.push(char);
			continue;
		}
		if (char === "}" || char === "]") {
			const open = stack.pop();
			if (!open) return -1; // 多余的闭合括号
			if ((open === "{" && char !== "}") || (open === "[" && char !== "]")) return -1;
			if (stack.length === 0) return index;
		}
	}
	return -1;
}

/** 扫描文本中第一个可解析的 JSON 值（对象或数组），失败返回 null。 */
function scanJson(value) {
	const source = String(value ?? "");
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (char !== "{" && char !== "[") continue;
		const end = matchBracketEnd(source, index);
		if (end < 0) continue;
		const parsed = parseJsonLoose(source.slice(index, end + 1));
		if (parsed !== undefined) return { value: parsed, start: index, end: end + 1 };
	}
	return null;
}

/**
 * 从任意文本中抓取第一个可解析 JSON 值（对象或数组）。
 * 支持 ```json 围栏、前后说明文字、字符串内括号 / 花括号、尾随逗号。
 * @param {string} text
 * @returns {any|null}
 */
export function extractJson(text) {
	const found = scanJson(text);
	return found ? found.value : null;
}

/* ───────────────────────── 标签协议解析 ───────────────────────── */

/** 定位一个标签块：返回 { present, content, index }；缺少闭合标签时取到文本末尾。 */
function findTag(text, name) {
	const source = String(text ?? "");
	const pattern = new RegExp(`<\\s*${name}\\s*>([\\s\\S]*?)(?:<\\s*/\\s*${name}\\s*>|$)`, "i");
	const match = pattern.exec(source);
	if (!match) return { present: false, content: "", index: -1 };
	return { present: true, content: match[1] ?? "", index: match.index };
}

/** 去掉整段被 Markdown 代码围栏包裹的外壳（最多剥 3 层）。 */
function stripCodeFence(value) {
	let text = String(value ?? "").trim();
	const pattern = /^(```|~~~)[ \t]*[a-zA-Z0-9_-]*[ \t]*\n([\s\S]*?)\n?\1[ \t]*$/;
	let guard = 0;
	while (guard < 3 && pattern.test(text)) {
		text = text.replace(pattern, "$2").trim();
		guard++;
	}
	return text;
}

/** 去掉残留的 <DOCUMENT> / </DOCUMENT> 标签。 */
function stripDocumentTags(value) {
	return String(value ?? "")
		.replace(/^\s*<\s*DOCUMENT\s*>/i, "")
		.replace(/<\s*\/\s*DOCUMENT\s*>\s*$/i, "")
		.trim();
}

/** 把任意输入归一化成「像大纲的对象」；不像则返回 null。 */
function coerceOutlineRaw(value) {
	if (Array.isArray(value)) {
		const hasSectionShape = value.some(
			(item) => item && typeof item === "object" && (item.heading || item.title || item.name || item.section),
		);
		return hasSectionShape ? { title: "", sections: value } : null;
	}
	if (!value || typeof value !== "object") return null;
	if (Array.isArray(value.sections)) return value;
	if (Array.isArray(value.chapters)) return value;
	if (Array.isArray(value.outline)) return { title: value.title ?? value.name, sections: value.outline };
	return null;
}

/** 从 JSON 回退结果中提取大纲 / 成文 / 自检报告，返回是否提取到了任何内容。 */
function applyFallbackJson(json, result) {
	let produced = false;
	if (json == null) return produced;

	if (Array.isArray(json)) {
		if (json.some((item) => item && typeof item === "object" && (item.status !== undefined || item.label !== undefined))) {
			if (!result.report) {
				result.report = json;
				produced = true;
			}
			return produced;
		}
		const outline = coerceOutlineRaw(json);
		if (outline && !result.outline) {
			result.outline = outline;
			produced = true;
		}
		return produced;
	}

	if (typeof json !== "object") return produced;

	let outlineCandidate = coerceOutlineRaw(json.outline);
	if (!outlineCandidate && (Array.isArray(json.sections) || Array.isArray(json.chapters))) {
		outlineCandidate = coerceOutlineRaw(json);
	}
	if (!outlineCandidate && Array.isArray(json.outline)) {
		outlineCandidate = coerceOutlineRaw({ title: json.title, sections: json.outline });
	}
	if (outlineCandidate && !result.outline) {
		result.outline = outlineCandidate;
		produced = true;
	}

	let documentText = "";
	if (typeof json.markdown === "string") documentText = json.markdown;
	else if (typeof json.document === "string") documentText = json.document;
	else if (json.document && typeof json.document === "object" && typeof json.document.markdown === "string") {
		documentText = json.document.markdown;
	}
	if (documentText.trim() && !result.document) {
		result.document = documentText.trim();
		produced = true;
	}

	const reportList = [json.report, json.reports, json.items].find((item) => Array.isArray(item));
	if (reportList && !result.report) {
		result.report = reportList;
		produced = true;
	}
	return produced;
}

/**
 * 解析模型输出的「回复 + 可选工件」。
 * @param {string} text
 * @returns {{ reply: string, outline?: object, document?: string, report?: any[] }}
 */
export function parseArtifact(text) {
	const raw = typeof text === "string" ? text : String(text ?? "");
	const result = { reply: "" };
	const blocks = {};
	let firstTagIndex = -1;
	for (const name of TAG_NAMES) {
		const block = findTag(raw, name);
		blocks[name] = block;
		if (block.present && (firstTagIndex < 0 || block.index < firstTagIndex)) firstTagIndex = block.index;
	}

	result.reply = (firstTagIndex >= 0 ? raw.slice(0, firstTagIndex) : raw).trim();

	if (blocks.OUTLINE.present) {
		const candidate = coerceOutlineRaw(extractJson(blocks.OUTLINE.content));
		if (candidate) result.outline = candidate;
	}
	if (blocks.DOCUMENT.present) {
		const document = stripDocumentTags(stripCodeFence(blocks.DOCUMENT.content)).trim();
		if (document) result.document = document;
	}
	if (blocks.REPORT.present) {
		const parsed = extractJson(blocks.REPORT.content);
		if (Array.isArray(parsed)) result.report = parsed;
		else if (parsed && Array.isArray(parsed.report)) result.report = parsed.report;
		else if (parsed && Array.isArray(parsed.items)) result.report = parsed.items;
	}

	// 完全没有标签时的 JSON 回退：支持 {reply, outline|markdown}、裸大纲对象、裸报告数组等。
	if (firstTagIndex < 0) {
		const found = scanJson(raw);
		if (found) {
			const produced = applyFallbackJson(found.value, result);
			if (produced) {
				const jsonReply = found.value && typeof found.value.reply === "string" ? found.value.reply.trim() : "";
				const prose = raw.slice(0, found.start).trim();
				if (jsonReply) result.reply = jsonReply;
				else if (prose) result.reply = prose;
			}
		}
	}

	return result;
}

/* ───────────────────────── 归一化 ───────────────────────── */

/** 文档标题兜底：项目名 → 主题前 30 字 → 固定占位。 */
function fallbackDocumentTitle(project) {
	const name = cleanLine(project?.name);
	if (name) return name;
	const topic = cleanLine(project?.topic);
	if (topic) return clip(topic, 30);
	return "未命名文档";
}

/** 章节标题归一化：去 Markdown 标题标记 / 粗体外壳 / 列表符号，压缩空白。 */
function cleanHeading(value) {
	return clip(
		cleanLine(value)
			.replace(/^#{1,6}\s*/, "")
			.replace(/^\*\*(.+?)\*\*$/, "$1")
			.replace(/^[-*+•·]\s+/, "")
			.trim(),
		100,
	).trim();
}

/** 要点归一化：数组 / 多行字符串都接受，去列表与编号前缀，去重，最多 8 条。 */
function normalizePoints(value) {
	let list = [];
	if (Array.isArray(value)) list = value;
	else if (typeof value === "string") list = value.split(/\n+/);
	else if (value != null) list = [value];
	const points = [];
	for (const item of list) {
		const text = cleanLine(item)
			.replace(/^[-*+•·]\s+/, "")
			.replace(/^(?:[（(]\d+[）)]|\d+[.、)])\s*/, "")
			.trim();
		if (!text || points.includes(text)) continue;
		points.push(clip(text, 200));
		if (points.length >= LIMITS.outlineMaxPoints) break;
	}
	return points;
}

/** 用模板骨架 / 通用章节把不足 2 节的大纲补齐（不编造实质内容，只补结构）。 */
function padOutlineSections(sections, template) {
	const output = sections.slice();
	const skeleton = Array.isArray(template?.sections) ? template.sections : [];
	for (const item of skeleton) {
		if (output.length >= LIMITS.outlineMinSections) break;
		const heading = cleanHeading(item?.heading);
		if (!heading || output.some((section) => section.heading === heading)) continue;
		const hint = cleanText(item?.hint);
		const section = { heading, points: [] };
		if (hint) section.notes = hint;
		output.push(section);
	}
	const genericHeadings = ["文档概述", "主要内容", "总结与建议"];
	for (const heading of genericHeadings) {
		if (output.length >= LIMITS.outlineMinSections) break;
		if (output.some((section) => section.heading === heading)) continue;
		output.push({ heading, points: [] });
	}
	return output;
}

/**
 * 大纲归一化：title 兜底项目名；heading 去空；points 为去重短句（≤8）；notes 可选；至少 2 节。
 * @param {any} raw 模型返回的大纲对象（或章节数组）
 * @param {{ project?: object, template?: object }} context
 * @returns {{ title: string, sections: Array<{ heading: string, points: string[], notes?: string }> }}
 */
export function normalizeOutline(raw, { project, template } = {}) {
	const candidate = coerceOutlineRaw(raw) || {};
	const title = cleanLine(candidate.title ?? candidate.name) || fallbackDocumentTitle(project);
	const rawSections = Array.isArray(candidate.sections) ? candidate.sections : [];
	const sections = [];
	for (const item of rawSections) {
		if (!item) continue;
		const source = typeof item === "string" ? { heading: item } : item;
		const heading = cleanHeading(source.heading ?? source.title ?? source.name ?? source.section);
		if (!heading) continue;
		const points = normalizePoints(source.points ?? source.bullets ?? source.items ?? source.content);
		const notes = cleanText(source.notes ?? source.note ?? source.hint);
		const section = { heading, points };
		if (notes) section.notes = notes;
		sections.push(section);
		if (sections.length >= LIMITS.outlineMaxSections) break;
	}
	const finalSections = sections.length >= LIMITS.outlineMinSections ? sections : padOutlineSections(sections, template);
	return { title: clip(title, 120), sections: finalSections };
}

/**
 * 成文归一化：去残留标签 / 代码围栏 / 连续空行；确保第一行是「# 标题」；返回 markdown 与标题。
 * @param {string} text
 * @param {{ title?: string, project?: object }} options
 * @returns {{ markdown: string, title: string }}
 */
export function normalizeDocumentMarkdown(text, { title, project } = {}) {
	const docTitle = cleanLine(title) || fallbackDocumentTitle(project);
	let markdown = String(text ?? "").replace(/\r\n?/g, "\n");
	markdown = stripDocumentTags(markdown);
	markdown = stripCodeFence(markdown);
	markdown = stripDocumentTags(markdown);
	markdown = markdown.replace(/\n{3,}/g, "\n\n").trim();
	const firstLine =
		markdown
			.split("\n")
			.map((line) => line.trim())
			.find(Boolean) || "";
	if (!/^#{1,6}\s+\S/.test(firstLine)) {
		markdown = markdown ? `# ${docTitle}\n\n${markdown}` : `# ${docTitle}`;
	}
	return { markdown, title: docTitle };
}

/** 红线文本提取：接受字符串数组或 { text } 对象数组。 */
function redlineTexts(redlines) {
	return (Array.isArray(redlines) ? redlines : [])
		.map((item) => cleanLine(typeof item === "string" ? item : (item?.text ?? item?.content ?? item?.label)))
		.filter(Boolean);
}

/** 自检状态归一化：pass / risk / unknown。 */
function normalizeStatus(value) {
	if (typeof value === "boolean") return value ? "pass" : "risk";
	const text = cleanLine(value).toLowerCase();
	if (!text) return "unknown";
	const exact = {
		pass: "pass",
		passed: "pass",
		ok: "pass",
		true: "pass",
		通过: "pass",
		合规: "pass",
		符合: "pass",
		满足: "pass",
		合格: "pass",
		无风险: "pass",
		是: "pass",
		risk: "risk",
		fail: "risk",
		failed: "risk",
		false: "risk",
		风险: "risk",
		违反: "risk",
		违规: "risk",
		不通过: "risk",
		不符合: "risk",
		不合格: "risk",
		失败: "risk",
		否: "risk",
		unknown: "unknown",
		未知: "unknown",
		不确定: "unknown",
		无法判断: "unknown",
		待核实: "unknown",
		"n/a": "unknown",
		na: "unknown",
		"-": "unknown",
	};
	if (exact[text]) return exact[text];
	if (/风险|违反|违规|不通过|不符合|不合格/.test(text)) return "risk";
	if (/未知|不确定|无法判断|无法确认/.test(text)) return "unknown";
	if (/通过|合规|符合|满足|合格/.test(text)) return "pass";
	return "unknown";
}

/** 判定结果的兜底说明。 */
function defaultStatusNote(status) {
	if (status === "pass") return "未发现与该红线冲突的内容。";
	if (status === "risk") return "疑似违反该红线，请人工复核。";
	return "模型未能给出明确判定，请人工复核。";
}

/**
 * 红线自检结果归一化：按红线列表逐条对齐，label 缺失用红线原文，status 三值化，note 必为字符串。
 * @param {any} rawItems 模型返回的数组
 * @param {Array<string|object>} redlines
 * @returns {Array<{ label: string, status: "pass"|"risk"|"unknown", note: string }>}
 */
export function normalizeReport(rawItems, redlines = []) {
	const texts = redlineTexts(redlines);
	const items = Array.isArray(rawItems) ? rawItems : [];
	const report = [];
	for (let index = 0; index < texts.length; index++) {
		const item = items[index] && typeof items[index] === "object" ? items[index] : {};
		const label = cleanLine(item.label ?? item.redline ?? item.text ?? item.name) || texts[index];
		const status = normalizeStatus(item.status ?? item.result ?? item.verdict ?? item.pass);
		const note = cleanLine(item.note ?? item.reason ?? item.detail ?? item.comment ?? item.notes) || defaultStatusNote(status);
		report.push({ label, status, note });
	}
	return report;
}

/* ───────────────────────── 提示词素材构建 ───────────────────────── */

/** 风格解析：project.style 优先，其次模板默认值，最后兜底。 */
function resolveStyle(project, template) {
	const style = project?.style || {};
	const defaults = template?.defaults || {};
	const choose = (labels, key, fallback) =>
		labels[style[key]] ? style[key] : labels[defaults[key]] ? defaults[key] : fallback;
	return {
		audience: choose(AUDIENCE_LABELS, "audience", "general"),
		tone: choose(TONE_LABELS, "tone", "professional"),
		length: choose(LENGTH_LABELS, "length", "standard"),
	};
}

/** 风格中文描述行。 */
function describeStyle(project, template) {
	const style = resolveStyle(project, template);
	return `读者：${AUDIENCE_LABELS[style.audience]}；语气：${TONE_LABELS[style.tone]}；篇幅：${LENGTH_LABELS[style.length]}`;
}

/** 模板骨架（heading —— hint 列表）；自由发挥时给设计指引。 */
function buildTemplateSkeleton(template) {
	const sections = Array.isArray(template?.sections) ? template.sections : [];
	if (!sections.length) {
		return "（本模板为自由发挥，无固定章节骨架：请根据主题自行设计 6–10 个逻辑清晰的章节）";
	}
	return sections
		.map((section, index) => {
			const heading = cleanHeading(section?.heading) || `第 ${index + 1} 节`;
			const hint = cleanLine(section?.hint);
			return `${index + 1}. ${heading}${hint ? ` —— 写作提示：${hint}` : ""}`;
		})
		.join("\n");
}

/** 模板描述块；asReference 用于成文 / 对话阶段（已确认大纲优先）。 */
function describeTemplate(template, { asReference = false } = {}) {
	const name = cleanLine(template?.name) || "自由发挥";
	const description = cleanLine(template?.description);
	const skeleton = buildTemplateSkeleton(template);
	if (asReference) {
		return `【模板参考骨架：${name}】（用于把握文体与模块；若与已确认大纲冲突，以已确认大纲为准）\n${skeleton}`;
	}
	return `【模板】${name}${description ? `：${description}` : ""}\n【模板骨架】\n${skeleton}`;
}

/** 主题与补充要求块。 */
function buildTopicBlock(project) {
	const topic = cleanText(project?.topic);
	return topic || "（用户未填写主题，请根据文档名称合理推断写作范围）";
}

/**
 * 参考文档摘录：每条【参考文档 i：name】；单条 ≤6000 字、总量 ≤16000 字，超出截断并注明。
 * @returns {string}
 */
function buildReferencesBlock(references) {
	const list = Array.isArray(references) ? references : [];
	const parts = [];
	let used = 0;
	let omitted = false;
	for (const reference of list) {
		const name = cleanLine(reference?.name ?? reference?.title ?? reference?.filename) || `参考文档 ${parts.length + 1}`;
		const text = cleanText(reference?.text ?? reference?.content);
		if (!text) continue;
		if (used >= LIMITS.referenceTotal) {
			omitted = true;
			break;
		}
		const budget = Math.min(LIMITS.referencePerDoc, LIMITS.referenceTotal - used);
		let excerpt = clip(text, budget);
		if (excerpt.length < text.length) excerpt += "\n（此文档摘录因长度限制被截断）";
		used += excerpt.length;
		parts.push(`【参考文档 ${parts.length + 1}：${name}】\n${excerpt}`);
	}
	if (!parts.length) {
		return "（未提供参考文档或参考文档无可用文本，请仅基于写作主题与公开常识撰写，不要编造具体数据、机构或引用）";
	}
	if (omitted) parts.push("（其余参考文档因总长度限制未纳入，请以上述摘录为准）");
	if (used >= LIMITS.referenceTotal) parts.push("（参考文档总摘录已达上限）");
	return parts.join("\n\n");
}

/**
 * 联网资料块：[n] 标题 — URL + 摘要；注入总量 ≤6000 字。
 * @returns {{ text: string, listed: number }}
 */
function buildSourcesBlock(sources) {
	const list = Array.isArray(sources) ? sources : [];
	const entries = [];
	let used = 0;
	let listed = 0;
	for (let index = 0; index < list.length; index++) {
		const source = list[index];
		const number = index + 1;
		const title = cleanLine(source?.title) || `资料 ${number}`;
		const url = cleanLine(source?.url);
		const snippet = clip(cleanLine(source?.snippet), 260);
		const entry = `[${number}] ${title}${url ? ` — ${url}` : ""}${snippet ? `\n摘要：${snippet}` : ""}`;
		if (used + entry.length + 2 > LIMITS.sourceTotal) break;
		entries.push(entry);
		used += entry.length + 2;
		listed++;
	}
	if (!listed) return { text: "（未提供联网资料，请勿编造引用或链接）", listed: 0 };
	if (listed < list.length) entries.push(`（其余 ${list.length - listed} 条资料因长度限制未列出）`);
	return { text: entries.join("\n\n"), listed };
}

/** 红线要求块：「必须遵守，违反即返工」。 */
function buildRedlinesBlock(redlines) {
	const texts = redlineTexts(redlines);
	if (!texts.length) {
		return "（未设置额外红线；仍需保证事实准确、结构完整、不编造数据与引用）";
	}
	return texts.map((text, index) => `${index + 1}. ${text}`).join("\n");
}

/**
 * 共享对话上下文：最近 ≤30 条、≤12000 字，超出时从最早的消息开始省略。
 * @param {object} project
 * @param {{ excludeText?: string }} options excludeText 与最后一条用户消息相同时丢弃（避免本轮指令重复出现）
 * @returns {string}
 */
function buildConversationBlock(project, { excludeText = "" } = {}) {
	const raw = Array.isArray(project?.conversation?.messages) ? project.conversation.messages : [];
	const usable = [];
	for (const message of raw) {
		if (!message || message.error) continue;
		const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : null;
		if (!role) continue;
		const content = cleanText(message.content);
		if (!content) continue;
		usable.push({ role, content });
	}
	if (excludeText && usable.length) {
		const last = usable[usable.length - 1];
		if (last.role === "user" && sameText(last.content, excludeText)) usable.pop();
	}
	if (!usable.length) return "【共享对话上下文】（大纲与成文阶段共用；暂无历史对话）";

	let window = usable.slice(-LIMITS.conversationMessages);
	let truncated = window.length < usable.length;
	const kept = [];
	let chars = 0;
	for (let index = window.length - 1; index >= 0; index--) {
		const item = window[index];
		const content = item.content.length > LIMITS.conversationChars ? `${clip(item.content, LIMITS.conversationChars)}…（已截断）` : item.content;
		if (content.length !== item.content.length) truncated = true;
		if (kept.length && chars + content.length > LIMITS.conversationChars) {
			truncated = true;
			break;
		}
		kept.unshift({ role: item.role, content });
		chars += content.length;
	}
	const header = `【共享对话上下文】（大纲与成文阶段共用，最近 ${kept.length} 条${truncated ? "，较早内容已省略" : ""}）`;
	const body = kept.map((item) => `${item.role === "assistant" ? "助手" : "用户"}：${item.content}`).join("\n\n");
	return `${header}\n${body}`;
}

/** 大纲纯文本视图（用于成文 / 对话 / 自检提示词）。 */
function buildOutlineText(outline) {
	const title = cleanLine(outline?.title) || "（未命名）";
	const lines = [`标题：${title}`];
	const sections = Array.isArray(outline?.sections) ? outline.sections : [];
	sections.forEach((section, index) => {
		lines.push(`${index + 1}. ${cleanLine(section?.heading) || `第 ${index + 1} 节`}`);
		for (const point of Array.isArray(section?.points) ? section.points : []) {
			const text = cleanLine(point);
			if (text) lines.push(`   - ${text}`);
		}
		const notes = cleanLine(section?.notes);
		if (notes) lines.push(`   写作提示：${notes}`);
	});
	return lines.join("\n");
}

/** 从 Markdown 中取第一个一级标题文本（用于对话调整时兜底文档标题）。 */
function extractMarkdownTitle(markdown) {
	const match = /^\s*#\s+(.+)$/m.exec(String(markdown ?? ""));
	return match ? cleanLine(match[1]) : "";
}

/* ───────────────────────── 系统提示词 ───────────────────────── */

const OUTLINE_SYSTEM_PROMPT = [
	"你是一位资深中文文档撰写专家，擅长为方案、报告、PRD、技术设计、研究报告、会议纪要、操作手册等各类中文文档设计结构严谨、层次清晰、可以直接指导写作的大纲。",
	"你始终使用简体中文，只输出用户要求的标签内容，不输出多余解释。",
	"",
	"【输出协议】",
	"只输出一个 <OUTLINE> 标签；标签内是且仅是一个合法 JSON 对象（不要代码围栏、不要注释、不要标签之外的文字）：",
	'<OUTLINE>{"title":"文档标题","sections":[{"heading":"一、章节标题","points":["要点 1","要点 2"],"notes":"可选的写作提示"}]}</OUTLINE>',
	"",
	"【大纲质量要求】",
	"1. 章节数量 6–10 节；若用户提供了模板骨架，优先沿用其章节标题与顺序，可按主题合并、拆分或微调，但不得遗漏核心模块。",
	"2. 每节 2–5 个要点；要点是 15–40 字的完整短句，写清「这一节写什么、为什么写」，禁止「待补充」「略」之类占位。",
	"3. 章节之间逻辑递进：背景 → 目标/范围 → 核心内容 → 实施/计划 → 风险/保障 → 总结，可按实际文体调整。",
	"4. 章节标题使用中文序号（一、二、三…），标题精炼（≤20 字），避免重复与空泛（如「其他事项」）。",
	"5. 如主题适合，可在开头增加一节「概览」或「内容摘要」（可选），用 2–3 个要点交代全文脉络。",
	"6. notes 可选，用于写该节的写作角度、必须覆盖的内容或数据要求，不要复述要点。",
	"7. 不得编造参考文档与联网资料中不存在的数据、机构名、人名、政策文号或引用；不确定的信息不要写进要点。",
	"8. 红线要求是硬约束，逐条对照检查后再输出；任何一条被违反都视为不合格输出。",
].join("\n");

const DOCUMENT_SYSTEM_PROMPT = [
	"你是一位资深中文文档撰写专家，擅长把大纲扩写成结构完整、内容具体、可直接交付的中文文档。",
	"你始终使用简体中文，只输出用户要求的标签内容，不输出任何解释性文字。",
	"",
	"【输出协议】",
	"只输出一个 <DOCUMENT> 标签；标签内是完整的 Markdown 全文，不要用代码围栏包裹，不要在标签前后输出文字：",
	"<DOCUMENT>",
	"# 文档标题",
	"",
	"## 一、章节标题",
	"正文……",
	"</DOCUMENT>",
	"",
	"【硬性要求】",
	"1. 第一行必须是「# 文档标题」，与用户给出的文档标题一致。",
	"2. 必须严格按已确认大纲的章节标题、顺序与数量输出；每节以「## 章节标题」开头，标题文字与大纲逐字一致（包括中文序号）。",
	"3. 每节正文 2–5 段，围绕该节要点展开：先给结论或定义，再写具体做法、机制、流程、示例或依据，最后说明风险与注意事项；禁止空话、口号与同义反复。",
	"4. 不得编造数据、统计数字、人名、机构名、政策文号或引用链接；确需具体数据但无可靠来源时，写「（待核实）」。",
	"5. 有联网资料时，在对应句末用 [n] 标注来源，并在文末添加「## 参考资料」一节，按「[n] 标题 — URL」逐条列出；不得引用未列出的来源。",
	"6. 有参考文档时，基于其中的事实与表述写作，但不得大段照抄；参考文档与用户要求冲突时，以用户要求与红线为准。",
	"7. 红线要求是硬约束，任何一条被违反都视为不合格输出。",
].join("\n");

const REVISE_SYSTEM_PROMPT = [
	"你是一位资深中文文档撰写专家，正在与用户进行多轮对话，帮助其在「大纲」或「成文」阶段迭代文档。",
	"你需要结合共享对话上下文理解用户的指代（如「第 3 节」「上一版」「再短一点」「刚才说的那个」），保持全文风格、术语与结构一致。",
	"你始终使用简体中文，严格按下面的判断规则与输出协议回复。",
	"",
	"【判断规则】",
	"1. 用户明确要求修改、调整、重写、增删内容或改变语气 → 先输出 1–3 句简短回复说明改了什么，再输出完整的新版本工件（不是 diff、不是片段、不是「同上」）。",
	"2. 用户只是提问、讨论、确认、索要解释或闲聊 → 只输出文字回复，绝对不要输出 <OUTLINE> 或 <DOCUMENT> 标签。",
	"3. 用户的最新要求与红线冲突时，在回复中说明冲突并给出符合红线的替代做法，不输出违反红线的版本。",
	"",
	"【输出协议】",
	"- 大纲阶段的新版本：<OUTLINE>{JSON}</OUTLINE>，JSON 结构与生成大纲时一致，必须是完整可替换当前版本的大纲。",
	"- 成文阶段的新版本：<DOCUMENT>Markdown 全文</DOCUMENT>，必须是完整全文，并保持已确认大纲的章节标题与顺序。",
	"- 不要在标签内使用代码围栏包裹整个文档，不要在标签之外输出第二份内容。",
].join("\n");

const CHECK_SYSTEM_PROMPT = [
	"你是一名严格、客观的中文文档红线审查员。你的任务是逐条判断文档是否违反了用户红线，而不是修改文档。",
	"你只做判定，不编造问题；不确定时判 unknown，而不是为了凑数判 risk。",
	"你始终使用简体中文，只输出要求的标签内容。",
	"",
	"【判定标准】",
	"- pass：文档明确满足该红线，未发现相反证据；",
	"- risk：文档存在违反或疑似违反该红线的内容，note 必须指出具体位置（章节名或原句摘录）并给出修改建议；",
	"- unknown：信息不足、无法判断（例如文档未涉及该红线要求的主题）。",
	"",
	"【输出协议】",
	"只输出一个 <REPORT> 标签，标签内是 JSON 数组，顺序与红线列表一致，每条红线一条记录，不得遗漏：",
	'<REPORT>[{"label":"红线原文","status":"pass|risk|unknown","note":"简洁判定依据"}]</REPORT>',
	"note 使用简体中文，控制在 80 字以内，不要输出标签之外的任何文字。",
].join("\n");

/* ───────────────────────── 用户提示词构建 ───────────────────────── */

function buildOutlinePrompt({ project, template, referencesBlock, sourcesBlock, redlinesBlock, conversationBlock }) {
	const lines = [
		"【任务】为下面的文档项目设计一份高质量中文大纲。",
		"",
		`【文档名称】${fallbackDocumentTitle(project)}`,
		`【写作主题与要求】\n${buildTopicBlock(project)}`,
		`【风格要求】${describeStyle(project, template)}`,
		"",
		describeTemplate(template),
		"",
		`【参考文档摘录】\n${referencesBlock}`,
		"",
		`【联网资料】\n${sourcesBlock}`,
		"",
		`【红线要求】（必须遵守，违反即返工）\n${redlinesBlock}`,
		"",
		conversationBlock,
		"",
		"【输出要求】（必须严格遵守）",
		"1. 只输出一个 <OUTLINE> 标签；标签内是且仅是一个合法 JSON 对象，不要输出任何解释、前后缀或代码围栏。",
		'2. JSON 结构：{"title":"文档标题","sections":[{"heading":"一、章节标题","points":["要点一","要点二"],"notes":"可选写作提示"}]}',
		`3. 章节 6–10 节${template && template.id !== "free" ? "，优先沿用模板骨架的章节标题与顺序" : ""}；每节 2–5 个要点；要点为 15–40 字短句，说明该节要写什么。`,
		"4. 章节标题使用中文序号（一、二、三…），标题精炼、不重复；整体逻辑递进，覆盖背景、目标、核心内容、实施与风险等必要模块。",
		"5. 联网资料只用于保证大纲要点与公开事实一致；不要在 JSON 中写引用编号，不要编造资料中不存在的数据、机构、人名或政策文号。",
		"6. 用户红线是硬约束，逐条对照检查后再输出。",
	];
	return lines.join("\n");
}

function buildDocumentPrompt({ project, template, outline, referencesBlock, sourcesBlock, redlinesBlock, conversationBlock }) {
	const title = cleanLine(outline?.title) || fallbackDocumentTitle(project);
	const styleLabel = LENGTH_LABELS[resolveStyle(project, template).length];
	const lines = [
		"【任务】严格依据已确认大纲，撰写完整的中文文档正文（Markdown 格式）。",
		"",
		`【文档标题】${title}`,
		`【写作主题与要求】\n${buildTopicBlock(project)}`,
		`【风格要求】${describeStyle(project, template)}`,
		"",
		describeTemplate(template, { asReference: true }),
		"",
		"【已确认大纲】（必须严格遵循其章节标题、顺序与数量，不得增删合并或改写标题）",
		buildOutlineText(outline),
		"",
		`【参考文档摘录】\n${referencesBlock}`,
		"",
		`【联网资料】\n${sourcesBlock}`,
		"",
		`【红线要求】（必须遵守，违反即返工）\n${redlinesBlock}`,
		"",
		conversationBlock,
		"",
		"【输出要求】（必须严格遵守）",
		"1. 只输出一个 <DOCUMENT> 标签；标签内是完整 Markdown 全文，不要用代码围栏包裹，不要输出标签之外的任何文字。",
		`2. 第一行必须是「# ${title}」。`,
		"3. 每节以「## 章节标题」开头，标题文字与大纲中的 heading 逐字一致（包括中文序号），章节数量与顺序不得改变。",
		"4. 每节正文 2–5 段：先给结论或定义，再写具体做法、机制、流程、示例或依据，最后说明风险与注意事项；禁止空话、口号和同义反复。",
		`5. 篇幅目标：${styleLabel}；内容不足以支撑时宁可写得更具体，也不要注水。`,
		"6. 不得编造数据、统计数字、人名、机构名、政策文号或引用链接；确需具体数据但无可靠来源时，写「（待核实）」。",
		'7. 有联网资料时，在对应句末用 [n] 标注来源，并在文末添加「## 参考资料」一节，按「[n] 标题 — URL」逐条列出；不得引用未列出的来源。',
		"8. 有参考文档时，基于其中的事实与表述写作，但不得大段照抄；参考文档与用户要求冲突时，以用户要求与红线为准。",
		"9. 全文使用简体中文，术语前后一致；只有在确实提升可读性时才使用表格或列表。",
	];
	return lines.join("\n");
}

function buildRevisePrompt({
	project,
	template,
	phase,
	outline,
	document,
	referencesBlock,
	sourcesBlock,
	redlinesBlock,
	conversationBlock,
	instruction,
}) {
	const isDocumentPhase = phase === "document";
	const phaseLabel = isDocumentPhase ? "成文阶段" : "大纲阶段";
	const lines = [
		`【任务】当前处于「${phaseLabel}」，用户希望在现有版本基础上调整文档。请结合共享对话上下文理解用户的指代，给出调整结果。`,
		"",
		`【文档名称】${fallbackDocumentTitle(project)}`,
		`【写作主题与要求】\n${buildTopicBlock(project)}`,
		`【风格要求】${describeStyle(project, template)}`,
		"",
		describeTemplate(template),
		"",
		`【参考文档摘录】\n${referencesBlock}`,
		"",
		`【联网资料】\n${sourcesBlock}`,
		"",
		`【红线要求】（必须遵守，违反即返工）\n${redlinesBlock}`,
		"",
	];
	if (outline && Array.isArray(outline.sections) && outline.sections.length) {
		lines.push(`【当前大纲】\n${buildOutlineText(outline)}`);
	} else {
		lines.push("【当前大纲】\n（暂无）");
	}
	lines.push("");
	if (isDocumentPhase) {
		if (document) {
			const clipped = clip(document, LIMITS.reviseDocumentChars);
			const truncated = clipped.length < document.length;
			lines.push(`【当前成文】（Markdown 格式${truncated ? "，过长已截断" : ""}）\n${clipped}`);
			if (truncated) lines.push("（以上为当前成文的前半部分，已因长度限制截断；如需修改局部，请以章节标题指代。）");
		} else {
			lines.push("【当前成文】\n（暂无，请依据已确认大纲生成完整新版本）");
		}
		lines.push("");
	}
	lines.push(
		conversationBlock,
		"",
		`【用户最新要求】\n${instruction}`,
		"",
		"【输出要求】（必须严格遵守）",
		"1. 先输出 1–3 句简体中文回复，说明你做了什么调整；若只是回答问题，则直接给出回答。",
		isDocumentPhase
			? "2. 若用户明确要求修改成文：在回复后紧接着输出完整新版本 <DOCUMENT># 标题 …全文…</DOCUMENT>，保持已确认大纲的章节标题与顺序，不得增删章节。"
			: "2. 若用户明确要求修改大纲：在回复后紧接着输出完整新版本 <OUTLINE>{\"title\":\"…\",\"sections\":[…]} </OUTLINE>，未被要求修改的章节也要完整保留。",
		"3. 新版本必须是完整内容，不能是 diff、片段或「同上」；不输出第二份重复内容。",
		"4. 若用户只是提问、讨论、确认或要求解释：只输出文字回复，不要输出任何标签或 JSON。",
		isDocumentPhase
			? "5. 涉及具体数据、引用时不得编造，无法确认处标注「（待核实）」；有联网资料时保留 [n] 标注与文末「## 参考资料」。"
			: "5. 大纲要点必须具体、可执行，不编造资料中不存在的数据、机构名或引用。",
		"6. 红线要求必须遵守；用户要求与红线冲突时，说明冲突并给出符合红线的替代方案。",
	);
	return lines.join("\n");
}

function buildCheckPrompt({ project, redlines, outline, markdown }) {
	const lines = [
		"【任务】对下面的文档做红线合规自检：逐条判断文档是否违反用户红线。",
		"",
		"【红线要求】",
		redlines.map((text, index) => `${index + 1}. ${text}`).join("\n"),
		"",
	];
	if (outline && Array.isArray(outline.sections) && outline.sections.length) {
		lines.push("【文档大纲】", buildOutlineText(outline), "");
	}
	const body = cleanText(markdown) || "（未提供正文）";
	const clipped = clip(body, LIMITS.checkDocumentChars);
	const truncated = clipped.length < body.length;
	lines.push(`【文档正文（Markdown）】\n${clipped}${truncated ? "\n（正文过长，已截断，仅审查以上部分）" : ""}`, "");
	lines.push(
		"【判定标准】",
		"- pass：文档明确满足该红线，未发现违反迹象；",
		"- risk：文档存在违反或疑似违反该红线的内容，note 必须指出具体位置（章节名或原句摘录）并给出修改建议；",
		"- unknown：信息不足或无法判断，不要为了凑数判 risk；不得编造问题。",
		"",
		"【输出要求】只输出一个 <REPORT> 标签，标签内是 JSON 数组，顺序与红线列表一致，每条红线一条记录：",
		'<REPORT>[{"label":"红线原文","status":"pass|risk|unknown","note":"简洁判定依据"}]</REPORT>',
		"note 使用简体中文，控制在 80 字以内；不要输出标签之外的任何文字。",
	);
	return lines.join("\n");
}

/* ───────────────────────── 检索资料辅助 ─────────────────────────
 * 联网检索由 service 层编排（见 CONTRACTS.md 派生约定）：service 先调 planSearchQueries()
 * 生成查询、自行调用注入的 search 并持久化 project.sources，再把 sources 传给 generateOutline /
 * generateDocument / revise。引擎只在提示词里消费已组装好的 sources，不再自行发起检索。 */

/** 把任意来源数组归一化为 Source（去重、限量）；字段缺失时用占位，不抛错。 */
function normalizeSourceList(sources) {
	if (!Array.isArray(sources)) return [];
	const output = [];
	const seen = new Set();
	for (const source of sources) {
		if (!source) continue;
		const title = cleanLine(source.title ?? source.name);
		const url = cleanLine(source.url ?? source.link ?? source.href);
		const snippet = clip(cleanText(source.snippet ?? source.content ?? source.description), 1200);
		if (!title && !url && !snippet) continue;
		const key = url ? url.toLowerCase().replace(/\/+$/, "") : title.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		const item = {
			id: cleanLine(source.id) || `src-${output.length + 1}`,
			title: title || url,
			url,
			snippet,
		};
		const addedAt = Number(source.addedAt);
		if (Number.isFinite(addedAt) && addedAt > 0) item.addedAt = addedAt;
		output.push(item);
		if (output.length >= LIMITS.sourceMaxItems) break;
	}
	return output;
}

/**
 * 依据项目主题 / 名称 / 模板规划 2–4 条确定性中文检索查询。
 * @param {{ project?: object, template?: object }} input
 * @returns {string[]}
 */
function planSearchQueries({ project, template } = {}) {
	const name = cleanLine(project?.name);
	const topic = cleanLine(project?.topic);
	const subject = clip(name || topic || "文档主题", 40);
	const topicHint = topic && topic !== subject ? clip(topic, 60) : "";
	const templateName = clip(cleanLine(template?.name).replace(/[/、|]+/g, " "), 20);
	const isFree = !template || template.id === "free";
	const queries = [];
	const push = (candidate) => {
		const query = clip(cleanLine(candidate).replace(/[。；，,.\s]+$/, ""), 60);
		if (!query || queries.includes(query) || queries.length >= 4) return;
		queries.push(query);
	};
	push(`${subject} 背景 现状 关键信息`);
	push(`${topicHint || subject} 最新进展 趋势 数据`);
	push(`${subject} 数据 统计 案例 分析`);
	if (!isFree && templateName) push(`${templateName} ${subject} 要点 规范`);
	if (queries.length < 2) push(`${subject} 常见问题 注意事项`);
	return queries.slice(0, 4);
}

/* ───────────────────────── 引擎工厂 ───────────────────────── */

/**
 * 创建文档创作引擎。
 * @param {{
 *   callModel: (args: { system: string, messages: Array<{role:"user"|"assistant",content:string}>, maxTokens?: number, temperature?: number, signal?: AbortSignal }) => Promise<{text: string, usage?: object}>,
 *   search?: (args: { query: string, maxResults?: number, signal?: AbortSignal }) => Promise<{ sources: Array<{title: string, url: string, snippet: string}> }>,
 *   logger?: { warn?: Function } | Function,
 *   now?: () => number,
 * }} deps
 */
export function createEngine({ callModel, search, logger, now = Date.now } = {}) {
	if (typeof callModel !== "function") {
		throw new TypeError("createEngine 需要注入 callModel 函数");
	}
	// search / now 只为兼容契约签名而保留：联网检索由 service 编排，引擎内部不发起 search，
	// 也不依赖真实时钟（提示词与归一化均为确定性逻辑）。
	void search;
	void now;

	function logWarn(message) {
		try {
			if (typeof logger === "function") logger(message);
			else if (logger && typeof logger.warn === "function") logger.warn(message);
		} catch {
			// 日志失败不影响生成流程
		}
	}

	function updateJob(job, progress, message) {
		try {
			if (job && typeof job.update === "function") job.update(progress, message);
		} catch {
			// 进度回调失败不影响生成流程
		}
	}

	/** 调用模型并校验返回文本，返回非空字符串。 */
	async function invokeModel({ system, user, maxTokens, temperature, signal }) {
		const payload = {
			system,
			messages: [{ role: "user", content: user }],
			maxTokens,
			temperature,
		};
		if (signal !== undefined) payload.signal = signal;
		const response = await callModel(payload);
		const text = typeof response === "string" ? response : (response?.text ?? "");
		if (typeof text !== "string" || !text.trim()) {
			throw new Error("模型未返回有效内容，请稍后重试");
		}
		return text;
	}

	/** 从模型文本中提取可当作大纲的原始对象。 */
	function pickOutlineCandidate(artifact, text) {
		const fromArtifact = coerceOutlineRaw(artifact?.outline);
		if (fromArtifact) return fromArtifact;
		return coerceOutlineRaw(extractJson(text));
	}

	function defaultReviseReply(produced, phase) {
		if (produced) return phase === "document" ? "已根据你的要求更新成文。" : "已根据你的要求更新大纲。";
		return "我已理解你的说明。如需修改，请直接告诉我要调整的章节或内容。";
	}

	/** 从模型文本中提取自检报告数组（标签 / JSON 数组 / 围栏 JSON 均可）。 */
	function parseReportItems(text) {
		const artifact = parseArtifact(text);
		if (Array.isArray(artifact.report)) return artifact.report;
		const found = scanJson(text);
		if (found) {
			if (Array.isArray(found.value)) return found.value;
			if (found.value && Array.isArray(found.value.report)) return found.value.report;
			if (found.value && Array.isArray(found.value.items)) return found.value.items;
		}
		return [];
	}

	async function generateOutline({ project, template, references = [], sources, job, signal } = {}) {
		const warnings = [];
		const referenceList = Array.isArray(references) ? references : [];
		const effectiveSources = normalizeSourceList(sources ?? project?.sources ?? []);

		// service 已负责 5 读取参考 / 12 联网检索，这里从 30 接续，避免进度回退
		// 联网检索由 service 完成；这里只提示"启用了联网但本次没有资料"的非致命情况
		if (project?.webSearch?.enabled && effectiveSources.length === 0) {
			warnings.push("未获取到联网资料，已基于参考文档与写作主题生成大纲");
		}

		const referencesBlock = buildReferencesBlock(referenceList);
		const sourceBlock = buildSourcesBlock(effectiveSources);
		updateJob(job, 30, "生成大纲");
		const text = await invokeModel({
			system: OUTLINE_SYSTEM_PROMPT,
			user: buildOutlinePrompt({
				project,
				template,
				referencesBlock,
				sourcesBlock: sourceBlock.text,
				redlinesBlock: buildRedlinesBlock(project?.redlines),
				conversationBlock: buildConversationBlock(project),
			}),
			maxTokens: MAX_TOKENS.outline,
			temperature: TEMPERATURE.outline,
			signal,
		});

		updateJob(job, 80, "解析与校验大纲");
		const artifact = parseArtifact(text);
		const rawOutline = pickOutlineCandidate(artifact, text);
		if (!rawOutline) {
			throw new Error("模型未返回可解析的大纲内容，请重试或调整写作要求");
		}
		const outline = normalizeOutline(rawOutline, { project, template });
		if (outline.sections.length < LIMITS.outlineMinSections) {
			throw new Error("模型返回的大纲结构不完整，请重试");
		}
		updateJob(job, 90, "大纲已就绪");
		return { outline, warnings };
	}

	async function generateDocument({ project, template, outline, references = [], sources, job, signal } = {}) {
		const warnings = [];
		const rawOutline = coerceOutlineRaw(outline);
		if (!rawOutline) throw new Error("缺少已确认的大纲，无法生成成文");
		const outlineNorm = normalizeOutline(rawOutline, { project, template });
		if (outlineNorm.sections.length < LIMITS.outlineMinSections) {
			throw new Error("大纲内容不完整，无法生成成文");
		}
		const referenceList = Array.isArray(references) ? references : [];
		const effectiveSources = normalizeSourceList(sources ?? project?.sources ?? []);
		const style = resolveStyle(project, template);
		const maxTokens = LENGTH_MAX_TOKENS[style.length] || MAX_TOKENS.documentStandard;

		updateJob(job, 5, "整理大纲与资料");
		const referencesBlock = buildReferencesBlock(referenceList);
		const sourceBlock = buildSourcesBlock(effectiveSources);
		updateJob(job, 15, "撰写正文");
		const text = await invokeModel({
			system: DOCUMENT_SYSTEM_PROMPT,
			user: buildDocumentPrompt({
				project,
				template,
				outline: outlineNorm,
				referencesBlock,
				sourcesBlock: sourceBlock.text,
				redlinesBlock: buildRedlinesBlock(project?.redlines),
				conversationBlock: buildConversationBlock(project),
			}),
			maxTokens,
			temperature: TEMPERATURE.document,
			signal,
		});

		updateJob(job, 60, "解析成文");
		const artifact = parseArtifact(text);
		const tagged = findTag(text, "DOCUMENT");
		let documentText = artifact.document;
		if (documentText == null && tagged.present) {
			throw new Error("模型返回的成文内容为空，请重试");
		}
		// 宽容回退：没有 DOCUMENT 标签时，把标签前文本 / 整段内容当作 Markdown
		if (documentText == null) documentText = artifact.reply || text;
		const normalized = normalizeDocumentMarkdown(documentText, { title: outlineNorm.title, project });
		return { markdown: normalized.markdown, title: normalized.title, warnings };
	}

	async function revise({ project, template, phase = "outline", outline, document, references = [], sources, message, job, signal } = {}) {
		const warnings = [];
		const instruction = cleanText(message);
		if (!instruction) throw new Error("请先输入需要调整的内容");
		const phaseName = phase === "document" ? "document" : "outline";
		const rawOutline = coerceOutlineRaw(outline);
		const outlineNorm = rawOutline ? normalizeOutline(rawOutline, { project, template }) : null;
		const currentDocument = cleanText(document);
		const referenceList = Array.isArray(references) ? references : [];
		const effectiveSources = normalizeSourceList(sources ?? project?.sources ?? []);

		updateJob(job, 20, phaseName === "document" ? "理解成文调整要求" : "理解大纲调整要求");
		const referencesBlock = buildReferencesBlock(referenceList);
		const sourceBlock = buildSourcesBlock(effectiveSources);
		const text = await invokeModel({
			system: REVISE_SYSTEM_PROMPT,
			user: buildRevisePrompt({
				project,
				template,
				phase: phaseName,
				outline: outlineNorm,
				document: currentDocument,
				referencesBlock,
				sourcesBlock: sourceBlock.text,
				redlinesBlock: buildRedlinesBlock(project?.redlines),
				conversationBlock: buildConversationBlock(project, { excludeText: instruction }),
				instruction,
			}),
			maxTokens: MAX_TOKENS.revise,
			temperature: TEMPERATURE.revise,
			signal,
		});

		updateJob(job, 60, "解析调整结果");
		const artifact = parseArtifact(text);
		const result = { reply: "", warnings };

		if (phaseName === "outline") {
			const candidate = coerceOutlineRaw(artifact.outline);
			if (candidate) {
				const next = normalizeOutline(candidate, { project, template });
				if (next.sections.length >= LIMITS.outlineMinSections) result.outline = next;
				else warnings.push("模型返回的大纲结构不完整，已忽略本次新版本");
			}
			if (artifact.document) warnings.push("当前处于大纲阶段，已忽略模型返回的成文内容");
		} else {
			const taggedDocument = findTag(text, "DOCUMENT");
			const markdown = artifact.document;
			if (markdown == null && taggedDocument.present) {
				warnings.push("模型返回的成文内容为空，已忽略本次修改");
			}
			if (typeof markdown === "string" && markdown.trim()) {
				const title = outlineNorm?.title || extractMarkdownTitle(currentDocument) || fallbackDocumentTitle(project);
				const normalized = normalizeDocumentMarkdown(markdown, { title, project });
				if (normalized.markdown.trim()) result.markdown = normalized.markdown;
			}
			if (artifact.outline && result.markdown == null) {
				warnings.push("当前处于成文阶段，已忽略模型返回的大纲内容");
			}
		}

		result.reply = cleanText(artifact.reply) || defaultReviseReply(result.outline != null || result.markdown != null, phaseName);
		return result;
	}

	async function checkRedlines({ project, redlines, outline, markdown, job, signal } = {}) {
		const list = redlineTexts(redlines ?? project?.redlines ?? []);
		if (!list.length) return { report: [] };

		updateJob(job, 80, "红线自检");
		const rawOutline = coerceOutlineRaw(outline);
		const outlineNorm = rawOutline ? normalizeOutline(rawOutline, { project }) : null;
		let text;
		try {
			text = await invokeModel({
				system: CHECK_SYSTEM_PROMPT,
				user: buildCheckPrompt({ project, redlines: list, outline: outlineNorm, markdown }),
				maxTokens: MAX_TOKENS.check,
				temperature: TEMPERATURE.check,
				signal,
			});
		} catch (error) {
			if (signal?.aborted || error?.name === "AbortError") throw error;
			const message = errorMessage(error);
			logWarn(`红线自检失败：${message}`);
			updateJob(job, 84, "自检调用失败，已标记为待人工复核");
			return { report: normalizeReport([], list) };
		}
		updateJob(job, 86, "汇总自检结果");
		return { report: normalizeReport(parseReportItems(text), list) };
	}

	return {
		planSearchQueries: ({ project, template } = {}) => planSearchQueries({ project, template }),
		generateOutline,
		generateDocument,
		revise,
		checkRedlines,
	};
}
