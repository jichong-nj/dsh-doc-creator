/**
 * lib/extract.js 离线测试（无测试框架，直接 node test/test-extract.mjs）。
 *
 * 覆盖：txt/md/markdown/json/csv 直读、docx 段落与表格顺序、pptx 幻灯片顺序
 * （sldIdLst 优先 + 数字序回退）、pdf（pdftotext 子进程 + 缺命令时的中文错误）、
 * html 去标签与实体解码、400k 截断、BOM/CRLF、空文件、损坏文件、不支持格式等边界。
 *
 * docx / pptx / pdf 二进制样例由 test/make-extract-fixtures.py 生成到 test/fixtures/；
 * 若样例缺失会在测试开始时自动调用 python3 生成（仅缺失时）。
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MAX_TEXT_CHARS, TRUNCATION_MARKER, extractText } from "../lib/extract.js";
import JSZip from "jszip";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.dirname(TEST_DIR);
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures");
const FIXTURE_SCRIPT = path.join(TEST_DIR, "make-extract-fixtures.py");

const DOCX_FIXTURE = path.join(FIXTURE_DIR, "extract-docx.docx");
const PPTX_FIXTURE = path.join(FIXTURE_DIR, "extract-pptx.pptx");
const PPTX_REORDERED_FIXTURE = path.join(FIXTURE_DIR, "extract-pptx-reordered.pptx");
const PDF_FIXTURE = path.join(FIXTURE_DIR, "extract-pdf.pdf");

/** 测试用例集合。 */
const tests = [];

/**
 * 注册测试用例；fn 接收临时工作目录。
 * @param {string} name 用例名
 * @param {(workDir: string) => Promise<void>} fn 用例函数
 */
function test(name, fn) {
	tests.push({ name, fn });
}

/**
 * 判断路径是否存在。
 * @param {string} target 路径
 * @returns {Promise<boolean>}
 */
async function exists(target) {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
}

/**
 * 确认二进制 fixture 存在；缺失时调用 python 脚本生成。
 * @returns {Promise<void>}
 */
async function ensureFixtures() {
	const required = [DOCX_FIXTURE, PPTX_FIXTURE, PPTX_REORDERED_FIXTURE, PDF_FIXTURE];
	const missing = [];
	for (const file of required) {
		if (!(await exists(file))) missing.push(file);
	}
	if (missing.length === 0) return;
	const result = spawnSync("python3", [FIXTURE_SCRIPT], { cwd: PACKAGE_DIR, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(
			`缺少测试样例且自动生成失败：请先运行 python3 test/make-extract-fixtures.py\n` +
				`${result.stderr || result.error?.message || ""}`,
		);
	}
	for (const file of required) {
		if (!(await exists(file))) throw new Error(`测试样例生成失败，缺少 ${file}`);
	}
}

/**
 * 检查系统是否可用的 pdftotext。
 * @returns {boolean}
 */
function hasPdftotext() {
	const result = spawnSync("pdftotext", ["-v"], { encoding: "utf8" });
	return !result.error;
}

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "doc-creator-extract-"));
const workDir = path.join(tmpRoot, "files");
await mkdir(workDir, { recursive: true });
await ensureFixtures();

/* 文本类样例 */
const TXT_PATH = path.join(workDir, "note.txt");
const MD_PATH = path.join(workDir, "guide.md");
const MARKDOWN_PATH = path.join(workDir, "readme.markdown");
const JSON_PATH = path.join(workDir, "data.json");
const CSV_PATH = path.join(workDir, "table.csv");
const EMPTY_PATH = path.join(workDir, "empty.txt");
const BOM_PATH = path.join(workDir, "bom.txt");
const HTML_PATH = path.join(workDir, "page.html");
const HTML_UPPER_PATH = path.join(workDir, "PAGE.HTML");
const BIG_PATH = path.join(workDir, "big.txt");
const EXACT_PATH = path.join(workDir, "exact.txt");
const OVER_PATH = path.join(workDir, "over.txt");
const XLSX_PATH = path.join(workDir, "sheet.xlsx");
const DOC_PATH = path.join(workDir, "legacy.doc");
const CORRUPT_DOCX_PATH = path.join(workDir, "broken.docx");
const CORRUPT_PPTX_PATH = path.join(workDir, "broken.pptx");
const NOEXT_PATH = path.join(workDir, "noext");
const PPTX_NO_PRESENTATION_PATH = path.join(workDir, "no-presentation.pptx");

await writeFile(TXT_PATH, "第一行\r\n第二行\n第三行：文档创作插件\n");
await writeFile(MD_PATH, "# 使用指南\n\n## 快速开始\n\n第一步：创建项目。\n\n- 条目一\n- 条目二\n");
await writeFile(MARKDOWN_PATH, "Markdown 扩展名测试\n\n正文段落。\n");
await writeFile(JSON_PATH, JSON.stringify({ name: "文档创作", count: 2 }, null, 2));
await writeFile(CSV_PATH, "列一,列二\n甲,乙\n丙,丁\n");
await writeFile(EMPTY_PATH, "");
await writeFile(BOM_PATH, "\uFEFF开头文本，无 BOM 残留。\n");
await writeFile(
	HTML_PATH,
	[
		"<!DOCTYPE html>",
		"<html><head><title>页面标题</title>",
		"<style>.foo { color: red; }</style>",
		"<script>function hack() { alert('xss'); }</script></head>",
		"<body>",
		"<h1>产品说明</h1>",
		"<p>第一段 &amp; 特殊字符：&lt;tag&gt; &quot;引号&quot;。</p>",
		"<p>实体测试：&#20013;&#x6587; 不换行&nbsp;空格。</p>",
		"<table><tr><td>单元格 A</td><td>单元格 B</td></tr></table>",
		"<!-- 注释不应出现 -->",
		"<ul><li>列表项一</li><li>列表项二</li></ul>",
		"</body></html>",
	].join("\n"),
);
await writeFile(HTML_UPPER_PATH, "<html><body><p>大写扩展名也能识别。</p></body></html>");
await writeFile(BIG_PATH, "这是一段用于测试超长截断的中文文本。\n".repeat(25000));
await writeFile(EXACT_PATH, "a".repeat(MAX_TEXT_CHARS));
await writeFile(OVER_PATH, "b".repeat(MAX_TEXT_CHARS + 1));
await writeFile(XLSX_PATH, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
await writeFile(DOC_PATH, Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
await writeFile(CORRUPT_DOCX_PATH, "这不是一个 zip 文件");
await writeFile(CORRUPT_PPTX_PATH, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));
await writeFile(NOEXT_PATH, "没有扩展名");

// 由正常 pptx 去掉 presentation.xml，触发「按 slideN 数字序」回退分支
{
	const source = await readFile(PPTX_FIXTURE);
	const zip = await JSZip.loadAsync(source);
	zip.remove("ppt/presentation.xml");
	await writeFile(PPTX_NO_PRESENTATION_PATH, await zip.generateAsync({ type: "nodebuffer" }));
}

test("纯文本类：txt / md / markdown / json / csv 直接读取", async () => {
	const cases = [
		[TXT_PATH, "note.txt", "第三行：文档创作插件"],
		[MD_PATH, "guide.md", "## 快速开始"],
		[MARKDOWN_PATH, "readme.markdown", "正文段落。"],
		[JSON_PATH, "data.json", '"name": "文档创作"'],
		[CSV_PATH, "table.csv", "甲,乙"],
	];
	for (const [filePath, name, expected] of cases) {
		const result = await extractText({ filePath, name });
		assert.equal(result.method, "text", `${name} 的 method 应为 text`);
		assert.ok(result.text.includes(expected), `${name} 应包含 ${expected}`);
		assert.equal(result.chars, result.text.length);
		assert.equal(result.truncated, false);
	}
});

test("文本归一化：CRLF 转 LF、去 BOM、空文件返回空文本", async () => {
	const txt = await extractText({ filePath: TXT_PATH, name: "note.txt" });
	assert.equal(txt.text.includes("\r"), false, "CRLF 应被归一化为 LF");
	assert.ok(txt.text.startsWith("第一行\n第二行\n"));

	const bom = await extractText({ filePath: BOM_PATH, name: "bom.txt" });
	assert.ok(bom.text.startsWith("开头文本"), "应去掉 BOM");
	assert.equal(bom.text.includes("\uFEFF"), false);

	const empty = await extractText({ filePath: EMPTY_PATH, name: "empty.txt" });
	assert.equal(empty.text, "");
	assert.equal(empty.chars, 0);
	assert.equal(empty.truncated, false);
	assert.equal(empty.method, "text");
});

test("未提供 name 时从文件路径推断扩展名", async () => {
	const result = await extractText({ filePath: TXT_PATH });
	assert.equal(result.method, "text");
	assert.ok(result.text.includes("第一行"));
	// name 无扩展名时回退使用 filePath 的扩展名
	const fallback = await extractText({ filePath: MD_PATH, name: "guide" });
	assert.equal(fallback.method, "text");
	assert.ok(fallback.text.includes("使用指南"));
});

test("HTML：去脚本/样式/标签、解码实体、表格用制表符分隔", async () => {
	const result = await extractText({ filePath: HTML_PATH, name: "page.html" });
	assert.equal(result.method, "html");
	assert.ok(result.text.includes("产品说明"));
	assert.ok(result.text.includes("第一段 & 特殊字符：<tag> \"引号\"。"), "命名实体应被解码");
	assert.ok(result.text.includes("实体测试：中文 不换行 空格。"), "数字实体与 nbsp 应被解码");
	assert.ok(result.text.includes("单元格 A\t单元格 B"), "td/th 之间应以制表符分隔");
	assert.ok(result.text.includes("列表项一"));
	assert.equal(result.text.includes("function hack"), false, "脚本内容不应出现");
	assert.equal(result.text.includes("color: red"), false, "样式内容不应出现");
	assert.equal(result.text.includes("注释不应出现"), false, "注释不应出现");
	assert.equal(result.text.includes("<p>"), false, "标签应被去除");
	assert.equal(result.chars, result.text.length);
});

test("HTML：大写扩展名同样识别", async () => {
	const result = await extractText({ filePath: HTML_UPPER_PATH, name: "PAGE.HTML" });
	assert.equal(result.method, "html");
	assert.ok(result.text.includes("大写扩展名也能识别。"));
});

test("DOCX：段落与表格按文档顺序抽取，表格单元格以制表符分隔", async () => {
	const result = await extractText({ filePath: DOCX_FIXTURE, name: "extract-docx.docx" });
	assert.equal(result.method, "docx");
	assert.equal(result.truncated, false);
	for (const text of [
		"这是 Word 测试文档第一段",
		"第二段包含关键术语：文档创作插件",
		"表格之后的段落：请保持与表格的先后顺序。",
	]) {
		assert.ok(result.text.includes(text), `docx 文本缺少：${text}`);
	}
	assert.ok(result.text.includes("指标\t目标\t说明"), "表头应以制表符连接");
	assert.ok(result.text.includes("周期\t2 周\t从立项到验收"), "表格行内容应保留");
	const tableIndex = result.text.indexOf("指标\t目标\t说明");
	assert.ok(result.text.indexOf("这是 Word 测试文档第一段") < tableIndex, "段落应在表格之前");
	assert.ok(result.text.indexOf("表格之后的段落") > tableIndex, "表格之后的段落顺序应正确");
	assert.equal(result.text.includes("<w:"), false, "不应输出 XML 标记");
	assert.equal(result.chars, result.text.length);
});

test("PPTX：按 presentation.xml 的 sldIdLst 顺序、页间空行分隔", async () => {
	const result = await extractText({ filePath: PPTX_FIXTURE, name: "extract-pptx.pptx" });
	assert.equal(result.method, "pptx");
	assert.ok(result.text.includes("第一部分"));
	assert.ok(result.text.includes("第二部分"));
	assert.ok(result.text.includes("第三部分"));
	assert.ok(result.text.includes("\n\n"), "页与页之间应以空行分隔");
	assert.ok(!result.text.includes("<a:"), "不应输出 XML 标记");
	const order = ["第一部分", "第二部分", "第三部分"].map((item) => result.text.indexOf(item));
	assert.ok(order[0] < order[1] && order[1] < order[2], "应按幻灯片顺序输出");
});

test("PPTX：sldIdLst 被调换后仍按视觉顺序输出（而非文件名顺序）", async () => {
	const result = await extractText({ filePath: PPTX_REORDERED_FIXTURE, name: "extract-pptx-reordered.pptx" });
	assert.equal(result.method, "pptx");
	const indexThird = result.text.indexOf("第三部分");
	const indexFirst = result.text.indexOf("第一部分");
	const indexSecond = result.text.indexOf("第二部分");
	assert.ok(indexThird >= 0 && indexFirst >= 0 && indexSecond >= 0);
	assert.ok(indexThird < indexFirst, "调换后第三页应先出现");
	assert.ok(indexFirst < indexSecond);
});

test("PPTX：presentation.xml 缺失时回退 slideN 数字序", async () => {
	const result = await extractText({ filePath: PPTX_NO_PRESENTATION_PATH, name: "no-presentation.pptx" });
	assert.equal(result.method, "pptx");
	const order = ["第一部分", "第二部分", "第三部分"].map((item) => result.text.indexOf(item));
	assert.ok(order.every((index) => index >= 0));
	assert.ok(order[0] < order[1] && order[1] < order[2], "回退分支应按 slide1/2/3 数字序");
});

test("PDF：pdftotext 子进程抽取（环境无 pdftotext 时跳过）", async () => {
	if (!hasPdftotext()) {
		console.log("SKIP PDF 解析（本机未安装 pdftotext）");
		return;
	}
	const result = await extractText({ filePath: PDF_FIXTURE, name: "extract-pdf.pdf" });
	assert.equal(result.method, "pdf");
	assert.ok(result.text.includes("Doc Creator PDF fixture"));
	assert.ok(result.text.includes("Second line for extraction test."));
	assert.equal(result.chars, result.text.length);
});

test("PDF：pdftotext 不存在时抛出可读中文错误", async () => {
	if (!hasPdftotext() || process.platform === "win32") {
		console.log("SKIP 缺失 pdftotext 的错误分支（平台或环境不适用）");
		return;
	}
	const extractUrl = pathToFileURL(path.join(PACKAGE_DIR, "lib", "extract.js")).href;
	const script = [
		`import { extractText } from ${JSON.stringify(extractUrl)};`,
		"try {",
		`  await extractText({ filePath: ${JSON.stringify(PDF_FIXTURE)}, name: "extract-pdf.pdf" });`,
		'  console.log("UNEXPECTED_OK");',
		"} catch (error) {",
		'  console.log("CAUGHT:" + error.message);',
		"}",
	].join("\n");
	const child = await new Promise((resolve, reject) => {
		const proc = spawn(process.execPath, ["--input-type=module", "-e", script], {
			env: { ...process.env, PATH: "/nonexistent-doc-creator-path" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (chunk) => (stdout += chunk));
		proc.stderr.on("data", (chunk) => (stderr += chunk));
		proc.on("error", reject);
		proc.on("close", (code) => resolve({ code, stdout, stderr }));
	});
	assert.equal(child.code, 0, `子进程应正常结束：${child.stderr}`);
	assert.ok(child.stdout.includes("CAUGHT:"), `应捕获错误，实际输出：${child.stdout}`);
	assert.ok(child.stdout.includes("未找到 pdftotext"), "错误消息应提示缺少 pdftotext");
	assert.ok(child.stdout.includes("poppler-utils"), "错误消息应给出安装提示");
});

test("超长文本：超过 400000 字符截断并追加标记", async () => {
	assert.equal(MAX_TEXT_CHARS, 400000);
	assert.equal(TRUNCATION_MARKER, "\n\n[内容过长，已截断]");
	const result = await extractText({ filePath: BIG_PATH, name: "big.txt" });
	assert.equal(result.truncated, true);
	assert.ok(result.text.endsWith(TRUNCATION_MARKER), "截断文本应以标记结尾");
	assert.ok(result.text.length > MAX_TEXT_CHARS, "截断后的文本应包含上限内容 + 标记");
	assert.ok(result.text.length <= MAX_TEXT_CHARS + TRUNCATION_MARKER.length);
	assert.equal(result.chars, result.text.length);
});

test("截断边界：恰好 400000 字符不截断，多 1 个字符即截断", async () => {
	const exact = await extractText({ filePath: EXACT_PATH, name: "exact.txt" });
	assert.equal(exact.truncated, false);
	assert.equal(exact.text.length, MAX_TEXT_CHARS);
	assert.equal(exact.text.endsWith("a"), true);

	const over = await extractText({ filePath: OVER_PATH, name: "over.txt" });
	assert.equal(over.truncated, true);
	assert.ok(over.text.endsWith(TRUNCATION_MARKER));
});

test("不支持的格式：.xlsx、.doc、无扩展名给出中文提示", async () => {
	await assert.rejects(
		() => extractText({ filePath: XLSX_PATH, name: "sheet.xlsx" }),
		(error) => error instanceof Error && /不支持的文件格式/.test(error.message) && /xlsx/.test(error.message),
	);
	await assert.rejects(
		() => extractText({ filePath: DOC_PATH, name: "legacy.doc" }),
		(error) => error instanceof Error && /暂不支持 \.doc/.test(error.message) && /另存为 \.docx 或 PDF/.test(error.message),
	);
	await assert.rejects(
		() => extractText({ filePath: NOEXT_PATH }),
		(error) => error instanceof Error && /缺少扩展名/.test(error.message),
	);
});

test("缺失文件：各类格式都给出「不存在」的中文错误", async () => {
	for (const [filePath, name] of [
		[path.join(workDir, "missing.txt"), "missing.txt"],
		[path.join(workDir, "missing.docx"), "missing.docx"],
		[path.join(workDir, "missing.pptx"), "missing.pptx"],
		[path.join(workDir, "missing.pdf"), "missing.pdf"],
	]) {
		await assert.rejects(
			() => extractText({ filePath, name }),
			(error) => error instanceof Error && error.message.includes("不存在"),
			`${name} 应提示文件不存在`,
		);
	}
	await assert.rejects(() => extractText({}), /缺少文件路径/);
	await assert.rejects(() => extractText(), /缺少文件路径/);
});

test("损坏文件：docx / pptx 抛「解析失败」而不是底层异常", async () => {
	await assert.rejects(
		() => extractText({ filePath: CORRUPT_DOCX_PATH, name: "broken.docx" }),
		(error) => error instanceof Error && /Word 文档解析失败/.test(error.message) && /损坏/.test(error.message),
	);
	await assert.rejects(
		() => extractText({ filePath: CORRUPT_PPTX_PATH, name: "broken.pptx" }),
		(error) => error instanceof Error && /PowerPoint 解析失败/.test(error.message),
	);
});

test("未知扩展名：.html 之外的网页类文件按不支持处理", async () => {
	await assert.rejects(
		() => extractText({ filePath: XLSX_PATH, name: "sheet.xml.txt.bak" }),
		/TXT|不支持/,
	);
});

let failures = 0;
for (const item of tests) {
	try {
		await item.fn(workDir);
		console.log(`PASS ${item.name}`);
	} catch (error) {
		failures += 1;
		console.error(`FAIL ${item.name}`);
		console.error(error?.stack ?? error);
	}
}
await rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${tests.length - failures}/${tests.length} extract tests passed`);
if (failures > 0) process.exit(1);
console.log("ALL EXTRACT TESTS PASS");
