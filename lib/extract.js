/**
 * 参考文档文本抽取。
 *
 * 支持格式：
 *   - 纯文本类：.txt .md .markdown .json .csv（UTF-8 直读，自动去 BOM）
 *   - Word：.docx（jszip 解包 + fast-xml-parser，按文档顺序输出段落与表格）
 *   - PowerPoint：.pptx（优先按 presentation.xml 的 sldIdLst 顺序，回退 slideN 数字序）
 *   - PDF：.pdf（调用 poppler 的 pdftotext 子进程，20 秒超时）
 *   - 网页：.html .htm（去标签、去脚本样式、解码常用实体）
 *
 * 统一输出：{ text, chars, truncated, method }。
 * 文本上限 400000 字符，超出截断并在尾部追加 `[内容过长，已截断]` 标记。
 *
 * 所有失败都抛中文 Error，消息可直接展示给用户；本模块不访问网络、不依赖宿主 ctx。
 *
 * @module lib/extract
 */

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";

/** 输出文本上限（字符数）。 */
export const MAX_TEXT_CHARS = 400000;

/** 超长截断标记（固定文案，客户端与测试依赖）。 */
export const TRUNCATION_MARKER = "\n\n[内容过长，已截断]";

/** PDF 解析超时（毫秒）。 */
const PDF_TIMEOUT_MS = 20000;

/** 直接按 UTF-8 读取的扩展名。 */
const TEXT_EXTS = new Set(["txt", "text", "md", "markdown", "json", "csv"]);

/** 支持提示里列出的格式（用于错误消息）。 */
const SUPPORTED_HINT = ".docx、.pdf、.pptx、.txt、.md、.markdown、.json、.csv、.html";

/** preserveOrder 解析器：保留 XML 节点顺序（docx 段落/表格、pptx 文本框都依赖顺序）。 */
const orderedParser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@_",
	preserveOrder: true,
	trimValues: false,
	parseTagValue: false,
	parseAttributeValue: false,
	allowBooleanAttributes: true,
});

/** 普通解析器：只读少量结构（presentation.xml / rels），属性保留前缀。 */
const flatParser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@_",
	parseTagValue: false,
	parseAttributeValue: false,
	trimValues: true,
});

/**
 * 取文件名扩展名（小写，不含点）。
 * @param {string} filename 文件名或路径
 * @returns {string} 扩展名；无扩展名返回空串
 */
function extensionOf(filename) {
	if (typeof filename !== "string") return "";
	const base = filename.split(/[\\/]/).pop() ?? "";
	const match = /\.([A-Za-z0-9]+)$/.exec(base);
	return match ? match[1].toLowerCase() : "";
}

/**
 * 把读取文件错误翻译成可展示的中文错误。
 * @param {string} label 展示用文件名
 * @param {NodeJS.ErrnoException|unknown} error 原始错误
 * @returns {Error} 中文错误
 */
function fileReadError(label, error) {
	const code = error && typeof error === "object" ? error.code : "";
	if (code === "ENOENT") return new Error(`读取文件失败：${label} 不存在或已被删除`);
	if (code === "EACCES" || code === "EPERM") return new Error(`读取文件失败：${label} 没有读取权限`);
	if (code === "EISDIR") return new Error(`读取文件失败：${label} 是目录，不是文件`);
	return new Error(`读取文件失败：${label}（${error?.message ?? "未知错误"}）`);
}

/**
 * 读取文件为 Buffer，失败抛中文错误。
 * @param {string} filePath 文件路径
 * @param {string} label 展示用文件名
 * @returns {Promise<Buffer>}
 */
async function readFileBuffer(filePath, label) {
	try {
		return await readFile(filePath);
	} catch (error) {
		throw fileReadError(label, error);
	}
}

/**
 * 读取文件为 UTF-8 字符串，失败抛中文错误。
 * @param {string} filePath 文件路径
 * @param {string} label 展示用文件名
 * @returns {Promise<string>}
 */
async function readFileUtf8(filePath, label) {
	try {
		return await readFile(filePath, "utf8");
	} catch (error) {
		throw fileReadError(label, error);
	}
}

/**
 * 文本归一化：去 BOM、统一换行、剔除控制字符、压缩多余空行并去首尾空白。
 * @param {string} raw 原始文本
 * @returns {string} 归一化文本
 */
function normalizeText(raw) {
	return String(raw ?? "")
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
		.replace(/\u0000/g, "")
		.replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * 按上限截断文本。
 * @param {string} text 归一化后的文本
 * @returns {{text: string, truncated: boolean}} 截断结果
 */
function capText(text) {
	if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
	let cut = MAX_TEXT_CHARS;
	// 避免把代理对（emoji 等）切成半个字符
	const lastCode = text.charCodeAt(cut - 1);
	if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut -= 1;
	return { text: text.slice(0, cut) + TRUNCATION_MARKER, truncated: true };
}

/* ────────────────────────── XML 顺序遍历工具 ────────────────────────── */

/**
 * 读取 preserveOrder 节点数组的直接子节点值。
 * @param {Array<object>} nodes preserveOrder 节点数组
 * @param {string} tag 目标标签名
 * @returns {Array<Array<object>>} 每个匹配标签的子节点数组（直接子节点）
 */
function directTags(nodes, tag) {
	const result = [];
	if (!Array.isArray(nodes)) return result;
	for (const node of nodes) {
		if (!node || typeof node !== "object") continue;
		const value = node[tag];
		if (Array.isArray(value)) result.push(value);
	}
	return result;
}

/** 取标签节点的子节点数组；不存在时返回空数组。 */
function childrenOf(node, tag) {
	const value = node && typeof node === "object" ? node[tag] : undefined;
	return Array.isArray(value) ? value : [];
}

/** 取 preserveOrder 节点数组里第一个指定标签的子节点数组。 */
function firstTag(nodes, tag) {
	if (!Array.isArray(nodes)) return [];
	for (const node of nodes) {
		if (!node || typeof node !== "object") continue;
		const value = node[tag];
		if (Array.isArray(value)) return value;
	}
	return [];
}

/**
 * 递归按顺序收集指定标签的子节点数组。
 * @param {Array<object>} nodes preserveOrder 节点数组
 * @param {string} tag 标签名
 * @param {Array<Array<object>>} [out] 输出累加器
 * @returns {Array<Array<object>>}
 */
function collectTags(nodes, tag, out = []) {
	if (!Array.isArray(nodes)) return out;
	for (const node of nodes) {
		if (!node || typeof node !== "object") continue;
		for (const key of Object.keys(node)) {
			if (key === ":@") continue;
			const value = node[key];
			if (!Array.isArray(value)) continue;
			if (key === tag) out.push(value);
			else collectTags(value, tag, out);
		}
	}
	return out;
}

/**
 * 提取 preserveOrder 节点下的全部文本（#text 直接拼接，忽略属性）。
 * @param {Array<object>} nodes 节点数组
 * @returns {string}
 */
function rawTextOf(nodes) {
	let out = "";
	if (!Array.isArray(nodes)) return out;
	for (const node of nodes) {
		if (!node || typeof node !== "object") continue;
		for (const key of Object.keys(node)) {
			if (key === ":@") continue;
			const value = node[key];
			if (key === "#text") out += String(value ?? "");
			else if (Array.isArray(value)) out += rawTextOf(value);
		}
	}
	return out;
}

/* ────────────────────────────── DOCX ────────────────────────────── */

/**
 * 提取单个 Word 段落的纯文本（含制表符与换行）。
 * @param {Array<object>} nodes w:p 的子节点数组
 * @returns {string}
 */
function paragraphText(nodes) {
	const parts = [];
	const walk = (list) => {
		if (!Array.isArray(list)) return;
		for (const node of list) {
			if (!node || typeof node !== "object") continue;
			for (const key of Object.keys(node)) {
				if (key === ":@") continue;
				const value = node[key];
				if (!Array.isArray(value)) continue;
				switch (key) {
					case "w:t":
						parts.push(rawTextOf(value));
						break;
					case "w:tab":
						parts.push("\t");
						break;
					case "w:br":
					case "w:cr":
						parts.push("\n");
						break;
					case "w:delText":
					case "w:instrText":
					case "w:drawing":
					case "w:pict":
					case "w:object":
						// 删除修订、域代码、图片对象都不属于正文，跳过
						break;
					case "#text":
						break;
					default:
						walk(value);
				}
			}
		}
	};
	walk(nodes);
	return parts.join("").replace(/\s+$/, "").replace(/^\s+/, "");
}

/**
 * 提取 Word 表格文本：单元格以 `\t` 分隔、行以 `\n` 分隔。
 * @param {Array<object>} tableNodes w:tbl 的子节点数组
 * @returns {string}
 */
function tableText(tableNodes) {
	let rows = directTags(tableNodes, "w:tr");
	if (rows.length === 0) rows = collectTags(tableNodes, "w:tr");
	const lines = [];
	for (const row of rows) {
		let cells = directTags(row, "w:tc");
		if (cells.length === 0) cells = collectTags(row, "w:tc");
		const cellTexts = cells.map((cell) => {
			const paragraphs = collectTags(cell, "w:p").map((item) => paragraphText(item));
			const nonEmpty = paragraphs.filter((item) => item.trim() !== "");
			return nonEmpty.join(" ").replace(/\s+/g, " ").trim();
		});
		const line = cellTexts.join("\t").replace(/\t+$/g, "");
		if (line.trim() !== "") lines.push(line);
	}
	return lines.join("\n");
}

/**
 * 解析 .docx 正文，按文档顺序输出段落与表格。
 * @param {string} filePath 文件路径
 * @param {string} label 展示用文件名
 * @returns {Promise<string>}
 */
async function extractDocx(filePath, label) {
	const buffer = await readFileBuffer(filePath, label);
	let zip;
	try {
		zip = await JSZip.loadAsync(buffer);
	} catch {
		throw new Error(`Word 文档解析失败：${label} 可能已损坏或不是有效的 .docx 文件`);
	}
	const entry = zip.file("word/document.xml");
	if (!entry) {
		throw new Error(`Word 文档解析失败：${label} 缺少 word/document.xml，可能不是有效的 .docx 文件`);
	}
	let xml;
	try {
		xml = await entry.async("string");
	} catch {
		throw new Error(`Word 文档解析失败：${label} 的正文无法读取（文件可能已损坏）`);
	}
	let parsed;
	try {
		parsed = orderedParser.parse(xml);
	} catch {
		throw new Error(`Word 文档解析失败：${label} 的正文 XML 无法解析（文件可能已损坏）`);
	}
	const documentNodes = firstTag(parsed, "w:document");
	const bodyNodes = firstTag(documentNodes, "w:body");
	const blocks = [];
	const walkBlocks = (nodes) => {
		if (!Array.isArray(nodes)) return;
		for (const node of nodes) {
			if (!node || typeof node !== "object") continue;
			for (const key of Object.keys(node)) {
				if (key === ":@") continue;
				const value = node[key];
				if (!Array.isArray(value)) continue;
				if (key === "w:p") {
					blocks.push(paragraphText(value));
				} else if (key === "w:tbl") {
					blocks.push(tableText(value));
				} else if (
					key === "w:sdt" ||
					key === "w:sdtContent" ||
					key === "w:customXml" ||
					key === "w:ins" ||
					key === "w:smartTag" ||
					key === "w:body"
				) {
					walkBlocks(value);
				}
			}
		}
	};
	walkBlocks(bodyNodes);
	return blocks
		.map((block) => block.replace(/[ \t]+$/gm, ""))
		.filter((block) => block.trim() !== "")
		.join("\n");
}

/* ────────────────────────────── PPTX ────────────────────────────── */

/**
 * 把 rels 里的 Target 解析为 zip 内绝对路径。
 * @param {string} target Relationship 的 Target 属性
 * @returns {string|null} zip 内路径；非法时返回 null
 */
function resolveZipTarget(target) {
	const raw = String(target ?? "").trim();
	if (!raw) return null;
	if (raw.startsWith("/")) return raw.replace(/^\/+/, "");
	const combined = raw.startsWith("ppt/") ? raw : path.posix.join("ppt", raw);
	const normalized = path.posix.normalize(combined);
	if (normalized.startsWith("..")) return null;
	return normalized;
}

/**
 * 读取 presentation.xml.rels，得到 rId → 幻灯片文件路径。
 * @param {JSZip} zip 已打开的 pptx
 * @returns {Promise<Map<string, string>>}
 */
async function readPresentationRels(zip) {
	const map = new Map();
	const entry = zip.file("ppt/_rels/presentation.xml.rels");
	if (!entry) return map;
	try {
		const parsed = flatParser.parse(await entry.async("string"));
		let relationships = parsed?.Relationships?.Relationship;
		if (!Array.isArray(relationships)) relationships = relationships ? [relationships] : [];
		for (const relationship of relationships) {
			const id = relationship?.["@_Id"];
			const target = resolveZipTarget(relationship?.["@_Target"]);
			if (typeof id === "string" && target) map.set(id, target);
		}
	} catch {
		// rels 损坏时退回数字序
	}
	return map;
}

/**
 * 计算幻灯片读取顺序：优先 presentation.xml 的 sldIdLst，缺失部分回退数字序。
 * @param {JSZip} zip 已打开的 pptx
 * @returns {Promise<string[]>} zip 内幻灯片路径数组
 */
async function resolveSlideOrder(zip) {
	const numeric = Object.keys(zip.files)
		.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name) && !zip.files[name].dir)
		.sort((a, b) => {
			const na = Number(/slide(\d+)\.xml$/.exec(a)?.[1] ?? 0);
			const nb = Number(/slide(\d+)\.xml$/.exec(b)?.[1] ?? 0);
			return na - nb;
		});
	const ordered = [];
	const entry = zip.file("ppt/presentation.xml");
	if (entry) {
		try {
			const parsed = flatParser.parse(await entry.async("string"));
			// 根节点在 XML 里是 <p:presentation>；容忍去掉命名空间前缀的变体
			const presentation = parsed?.["p:presentation"] ?? parsed?.presentation;
			const sldIdLst = presentation?.["p:sldIdLst"];
			let sldIds = sldIdLst?.["p:sldId"];
			if (!Array.isArray(sldIds)) sldIds = sldIds ? [sldIds] : [];
			const rels = await readPresentationRels(zip);
			for (const sldId of sldIds) {
				const rid = sldId?.["@_r:id"];
				const target = typeof rid === "string" ? rels.get(rid) : null;
				if (target && zip.file(target) && !ordered.includes(target)) ordered.push(target);
			}
		} catch {
			// presentation.xml 损坏时退回数字序
		}
	}
	for (const slidePath of numeric) {
		if (!ordered.includes(slidePath)) ordered.push(slidePath);
	}
	return ordered;
}

/**
 * 提取单个文本框段落的文本。
 * @param {Array<object>} nodes a:p 的子节点数组
 * @returns {string}
 */
function slideParagraphText(nodes) {
	const parts = [];
	const walk = (list) => {
		if (!Array.isArray(list)) return;
		for (const node of list) {
			if (!node || typeof node !== "object") continue;
			for (const key of Object.keys(node)) {
				if (key === ":@") continue;
				const value = node[key];
				if (!Array.isArray(value)) continue;
				if (key === "a:t") parts.push(rawTextOf(value));
				else if (key === "a:br") parts.push("\n");
				else if (key === "a:tab") parts.push("\t");
				else if (key === "a:endParaRPr") continue;
				else walk(value);
			}
		}
	};
	walk(nodes);
	return parts.join("").trim();
}

/**
 * 解析 .pptx 文本，一页一段、页间以空行分隔。
 * @param {string} filePath 文件路径
 * @param {string} label 展示用文件名
 * @returns {Promise<string>}
 */
async function extractPptx(filePath, label) {
	const buffer = await readFileBuffer(filePath, label);
	let zip;
	try {
		zip = await JSZip.loadAsync(buffer);
	} catch {
		throw new Error(`PowerPoint 解析失败：${label} 可能已损坏或不是有效的 .pptx 文件`);
	}
	const slidePaths = await resolveSlideOrder(zip);
	if (slidePaths.length === 0) {
		throw new Error(`PowerPoint 解析失败：${label} 中没有找到幻灯片（可能不是有效的 .pptx 文件）`);
	}
	const pages = [];
	for (const slidePath of slidePaths) {
		const entry = zip.file(slidePath);
		if (!entry) continue;
		let parsed;
		try {
			parsed = orderedParser.parse(await entry.async("string"));
		} catch {
			continue;
		}
		const paragraphs = collectTags(parsed, "a:p")
			.map((paragraph) => slideParagraphText(paragraph))
			.filter((paragraph) => paragraph !== "");
		if (paragraphs.length > 0) pages.push(paragraphs.join("\n"));
	}
	return pages.join("\n\n");
}

/* ────────────────────────────── PDF ────────────────────────────── */

/**
 * 调用 pdftotext 提取 PDF 文本。
 * @param {string} filePath PDF 路径
 * @param {string} label 展示用文件名
 * @returns {Promise<string>}
 */
function extractPdf(filePath, label) {
	return new Promise((resolve, reject) => {
		let child;
		try {
			child = spawn("pdftotext", ["-q", "-enc", "UTF-8", filePath, "-"], {
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch {
			reject(new Error(`PDF 解析失败：无法启动 pdftotext，请安装 poppler-utils 后重试`));
			return;
		}
		const stdoutChunks = [];
		const stderrChunks = [];
		let settled = false;
		let timedOut = false;
		const finish = (error, text) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve(text);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, PDF_TIMEOUT_MS);
		child.on("error", (error) => {
			if (error?.code === "ENOENT") {
				finish(
					new Error(
						`PDF 解析失败：未找到 pdftotext 命令，请先安装 poppler-utils，或将 PDF 另存为 .docx / .txt 后上传`,
					),
				);
			} else {
				finish(new Error(`PDF 解析失败：无法启动 pdftotext（${error?.message ?? "未知错误"}）`));
			}
		});
		child.stdout?.on("data", (chunk) => stdoutChunks.push(chunk));
		child.stderr?.on("data", (chunk) => stderrChunks.push(chunk));
		child.on("close", (code) => {
			if (timedOut) {
				finish(
					new Error(`PDF 解析失败：${label} 解析超时（超过 ${PDF_TIMEOUT_MS / 1000} 秒），请拆分或压缩后再试`),
				);
				return;
			}
			if (code !== 0) {
				const detail = Buffer.concat(stderrChunks).toString("utf8").trim().slice(0, 200);
				if (/encrypt|password/i.test(detail)) {
					finish(new Error(`PDF 解析失败：${label} 已加密，无法提取文本，请上传解密后的 PDF`));
				} else if (/syntax|trailer|damaged|corrupt/i.test(detail)) {
					finish(new Error(`PDF 解析失败：${label} 可能已损坏或不是有效的 PDF 文件`));
				} else {
					finish(
						new Error(
							`PDF 解析失败：${label}（pdftotext 退出码 ${code}${detail ? `：${detail}` : ""}）`,
						),
					);
				}
				return;
			}
			try {
				const text = Buffer.concat(stdoutChunks).toString("utf8").replace(/\f/g, "\n\n");
				finish(null, text);
			} catch (error) {
				finish(new Error(`PDF 解析失败：${label} 的文本编码无法识别（${error?.message ?? "未知错误"}）`));
			}
		});
	});
}

/* ────────────────────────────── HTML ────────────────────────────── */

/** 常用 HTML 实体表（小写键）。 */
const HTML_ENTITIES = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	ldquo: "“",
	rdquo: "”",
	lsquo: "‘",
	rsquo: "’",
	middot: "·",
	bull: "•",
	copy: "©",
	reg: "®",
	trade: "™",
	deg: "°",
	times: "×",
	divide: "÷",
	plusmn: "±",
	yen: "¥",
	euro: "€",
	pound: "£",
	sect: "§",
	para: "¶",
	laquo: "«",
	raquo: "»",
	micro: "µ",
	frac12: "½",
	sup2: "²",
	sup3: "³",
	alpha: "α",
	beta: "β",
	gamma: "γ",
	delta: "δ",
};

/**
 * 解码 HTML 实体（命名实体 + 十进制/十六进制数字实体）。
 * @param {string} text 含实体的文本
 * @returns {string}
 */
function decodeHtmlEntities(text) {
	return String(text).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
		if (body.startsWith("#x") || body.startsWith("#X")) {
			const code = Number.parseInt(body.slice(2), 16);
			return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
				? String.fromCodePoint(code)
				: match;
		}
		if (body.startsWith("#")) {
			const code = Number.parseInt(body.slice(1), 10);
			return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
				? String.fromCodePoint(code)
				: match;
		}
		const named = HTML_ENTITIES[body.toLowerCase()];
		return named === undefined ? match : named;
	});
}

/**
 * 从 HTML 中抽取可读文本：去注释/脚本/样式/标签，解码实体，压缩空白。
 * @param {string} html 原始 HTML
 * @returns {string}
 */
function extractHtml(html) {
	let text = String(html ?? "");
	text = text.replace(/<!--[\s\S]*?-->/g, " ");
	text = text.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, " ");
	text = text.replace(/<(script|style|noscript|template|svg|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
	text = text.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, " ");
	text = text.replace(/<\s*(br|hr)\b[^>]*>/gi, "\n");
	text = text.replace(/<\s*(td|th)\b[^>]*>/gi, "\t");
	text = text.replace(/<\s*\/\s*(td|th)\s*>/gi, "");
	text = text.replace(/<\s*\/?\s*li\b[^>]*>/gi, "\n");
	text = text.replace(
		/<\s*\/?\s*(p|div|section|article|header|footer|main|aside|nav|h[1-6]|ul|ol|dl|dt|dd|table|thead|tbody|tfoot|tr|blockquote|pre|form|fieldset|figure|figcaption|address)\b[^>]*>/gi,
		"\n",
	);
	text = text.replace(/<[^>]*>/g, " ");
	text = decodeHtmlEntities(text);
	return text
		.replace(/[ \u00a0]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/* ────────────────────────────── 主入口 ────────────────────────────── */

/**
 * 从参考文档中抽取纯文本。
 *
 * @param {{filePath: string, name?: string}} options filePath：磁盘路径；name：原始文件名（用于判断格式与报错展示）
 * @returns {Promise<{text: string, chars: number, truncated: boolean, method: "text"|"docx"|"pdf"|"pptx"|"html"}>}
 */
export async function extractText(options) {
	const { filePath, name } = options ?? {};
	if (typeof filePath !== "string" || filePath.trim() === "") {
		throw new Error("缺少文件路径，无法提取文本");
	}
	const label = typeof name === "string" && name.trim() !== "" ? name.trim() : path.basename(filePath);
	const ext = extensionOf(label) || extensionOf(filePath);
	if (!ext) {
		throw new Error(`无法识别文件格式：${label}（文件名缺少扩展名），请上传 ${SUPPORTED_HINT} 文件`);
	}
	// 统一做一次存在性检查：读取类错误与 PDF 子进程错误都能给出「不存在」这一致提示
	let fileInfo;
	try {
		fileInfo = await stat(filePath);
	} catch (error) {
		throw fileReadError(label, error);
	}
	if (fileInfo.isDirectory()) {
		throw new Error(`读取文件失败：${label} 是目录，不是文件`);
	}

	let method;
	let raw;
	if (TEXT_EXTS.has(ext)) {
		method = "text";
		raw = await readFileUtf8(filePath, label);
	} else if (ext === "docx") {
		method = "docx";
		raw = await extractDocx(filePath, label);
	} else if (ext === "pptx") {
		method = "pptx";
		raw = await extractPptx(filePath, label);
	} else if (ext === "pdf") {
		method = "pdf";
		raw = await extractPdf(filePath, label);
	} else if (ext === "html" || ext === "htm") {
		method = "html";
		raw = extractHtml(await readFileUtf8(filePath, label));
	} else if (ext === "doc") {
		throw new Error("暂不支持 .doc 旧格式，请另存为 .docx 或 PDF 后重新上传");
	} else {
		throw new Error(`不支持的文件格式：.${ext}（${label}），请上传 ${SUPPORTED_HINT} 文件`);
	}

	const normalized = normalizeText(raw);
	const capped = capText(normalized);
	return {
		text: capped.text,
		chars: capped.text.length,
		truncated: capped.truncated,
		method,
	};
}
