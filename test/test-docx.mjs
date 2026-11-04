/**
 * @file docx 引擎离线测试（无测试框架，node test/test-docx.mjs）。
 *
 * 覆盖范围：
 * 1. parseMarkdown：全部块类型、两级列表嵌套、表格对齐/转义、分页注释、标题结尾井号；
 * 2. buildDocxBuffer：必需 OOXML 部件齐全、全部 XML 良构、关键文本/样式/编号/表格/页脚/A4 版面断言；
 * 3. buildDocx：落盘到临时目录、返回统计信息，`unzip -t` 通过；
 * 4. 若本机有 python-docx，则用子进程加载产物并校验段落/标题/表格数量（不可用时仅警告）。
 *
 * 全部离线、写入临时目录并在结束时清理，不触碰 ~/.dsh。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parseMarkdown, buildDocxBuffer, buildDocx } from "../lib/docx.js";

/* ============================================================================
 * 测试脚手架
 * ========================================================================== */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PATH = path.join(HERE, "fixtures", "docx-sample.md");

/** 打开 docx 时要求的必需部件。 */
const REQUIRED_PARTS = [
  "[Content_Types].xml",
  "_rels/.rels",
  "docProps/core.xml",
  "docProps/app.xml",
  "word/document.xml",
  "word/styles.xml",
  "word/settings.xml",
  "word/numbering.xml",
  "word/footer1.xml",
  "word/_rels/document.xml.rels",
];

let passCount = 0;
const failures = [];

/**
 * 记录一项同步断言。
 * @param {string} name 断言名称
 * @param {() => void} fn 断言函数（抛错即失败）
 */
function check(name, fn) {
  try {
    fn();
    passCount += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

/**
 * 记录一项异步断言。
 * @param {string} name 断言名称
 * @param {() => Promise<void>} fn 断言函数
 */
async function checkAsync(name, fn) {
  try {
    await fn();
    passCount += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

/**
 * 输出警告（不计数、不影响退出码）。
 * @param {string} name 名称
 * @param {string} message 说明
 */
function warn(name, message) {
  console.log(`WARN ${name}: ${message}`);
}

/**
 * 统计 XML 中某个正则的匹配次数。
 * @param {string} xml 文本
 * @param {RegExp} pattern 正则（需带 g 标志）
 * @returns {number} 次数
 */
function countMatches(xml, pattern) {
  return (xml.match(pattern) || []).length;
}

/**
 * 解码 XML 文本节点中的实体。
 * @param {string} text 转义文本
 * @returns {string} 原文
 */
function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * 抽取 docx 部件的全部 `w:t` 文本（按出现顺序拼接）。
 * @param {string} xml document.xml 或 footer XML
 * @returns {string} 可见文本
 */
function extractText(xml) {
  const pieces = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((match) => decodeEntities(match[1]));
  return pieces.join("");
}

/**
 * 断言文本包含指定子串。
 * @param {string} haystack 文本
 * @param {string} needle 子串
 * @param {string} message 失败信息
 */
function assertContains(haystack, needle, message) {
  assert.ok(haystack.includes(needle), message || `缺少文本：${needle}`);
}

/* ============================================================================
 * python-docx 校验脚本（写入临时目录后由 python3 执行）
 * ========================================================================== */

const PYTHON_VERIFY_SCRIPT = `import json
import sys

from docx import Document

document = Document(sys.argv[1])
styles = {}
texts = []
for paragraph in document.paragraphs:
    texts.append(paragraph.text)
    try:
        name = paragraph.style.name
    except Exception:
        name = ""
    styles[name] = styles.get(name, 0) + 1

result = {
    "paragraphs": len(document.paragraphs),
    "tables": len(document.tables),
    "tableRows": [len(table.rows) for table in document.tables],
    "styles": styles,
    "joined": chr(10).join(texts),
}
print(json.dumps(result, ensure_ascii=False))
`;

/* ============================================================================
 * 主流程
 * ========================================================================== */

/**
 * 测试主入口。
 */
async function main() {
  const markdown = await fs.readFile(SAMPLE_PATH, "utf8");
  const title = "文档创作引擎验证报告";
  const subtitle = "技术验证样例（中文排版）";
  const meta = { author: "docx-engine", company: "DSH 团队", subject: "docx 导出验证" };

  /* ------------------------------------------------------------------ *
   * 1. parseMarkdown
   * ------------------------------------------------------------------ */
  const blocks = parseMarkdown(markdown);

  check("parseMarkdown 覆盖全部块类型", () => {
    const types = new Set(blocks.map((block) => block.type));
    for (const expected of ["heading", "paragraph", "list", "blockquote", "code", "table", "hr", "pagebreak"]) {
      assert.ok(types.has(expected), `缺少块类型：${expected}`);
    }
  });

  check("parseMarkdown 标题层级正确", () => {
    const headings = blocks.filter((block) => block.type === "heading");
    assert.equal(headings.length, 9, `标题数量应为 9，实际 ${headings.length}`);
    assert.deepEqual(
      headings.map((heading) => heading.level),
      [1, 2, 2, 3, 3, 4, 5, 6, 2],
      "标题层级序列不符",
    );
  });

  check("parseMarkdown 列表两级嵌套正确", () => {
    const bullet = blocks.find((block) => block.type === "list" && !block.ordered);
    assert.ok(bullet, "缺少无序列表");
    assert.ok(bullet.items.some((item) => item.level === 1), "无序列表缺少二级项");
    const ordered = blocks.find((block) => block.type === "list" && block.ordered);
    assert.ok(ordered, "缺少有序列表");
    assert.ok(
      ordered.items.some((item) => item.level === 1 && item.ordered),
      "有序列表缺少二级有序项",
    );
  });

  check("parseMarkdown 表格表头/对齐/转义正确", () => {
    const table = blocks.find((block) => block.type === "table");
    assert.ok(table, "缺少表格");
    assert.equal(table.headers.length, 3, "表格列数应为 3");
    assert.equal(table.rows.length, 4, "表格数据行应为 4");
    assert.deepEqual(table.alignments, ["left", "center", "right"], "表格对齐方式不符");
    assert.equal(table.rows[3][0], "转义 | 竖线", "转义竖线单元格解析错误");
  });

  check("parseMarkdown 引用/代码块/分隔线/分页正确", () => {
    const quote = blocks.find((block) => block.type === "blockquote");
    assert.ok(quote && quote.blocks.length >= 1, "引用块内容为空");
    const code = blocks.find((block) => block.type === "code");
    assert.ok(code, "缺少代码块");
    assert.equal(code.lang, "js", "代码块语言解析错误");
    assert.ok(code.code.includes("parseMarkdown"), "代码块内容丢失");
    assert.ok(blocks.some((block) => block.type === "hr"), "缺少分隔线");
    assert.equal(blocks.filter((block) => block.type === "pagebreak").length, 1, "分页块数量应为 1");
  });

  check("parseMarkdown 边界情况：空文本/结尾井号/分页变体/控制字符", () => {
    assert.deepEqual(parseMarkdown(""), [], "空 Markdown 应返回空数组");
    assert.deepEqual(parseMarkdown("\n\n   \n"), [], "纯空白 Markdown 应返回空数组");
    const edge = parseMarkdown("## 带井号结尾的标题 ##\n\n<!-- PAGE-BREAK -->\n\n\\pagebreak");
    assert.equal(edge[0].text, "带井号结尾的标题", "标题结尾井号未移除");
    assert.equal(edge.filter((block) => block.type === "pagebreak").length, 2, "分页变体未识别");
    const controlled = parseMarkdown("正文\u0001含控制字符\u0008结束");
    assert.equal(controlled[0].text, "正文含控制字符结束", "非法控制字符未剔除");
  });

  /* ------------------------------------------------------------------ *
   * 2. buildDocxBuffer + 部件/XML 校验
   * ------------------------------------------------------------------ */
  const buffer = await buildDocxBuffer({ markdown, title, subtitle, meta });

  check("buildDocxBuffer 返回非空 Uint8Array", () => {
    assert.ok(buffer instanceof Uint8Array, "返回值不是 Uint8Array");
    assert.ok(buffer.byteLength > 5000, `产物过小：${buffer.byteLength} 字节`);
  });

  const zip = await JSZip.loadAsync(buffer);
  const parts = {};
  for (const name of REQUIRED_PARTS) {
    const file = zip.file(name);
    assert.ok(file, `缺少部件：${name}`);
    parts[name] = await file.async("string");
  }
  const footer2File = zip.file("word/footer2.xml");
  const footer2Xml = footer2File ? await footer2File.async("string") : "";

  check("docx 包含全部必需 OOXML 部件", () => {
    for (const name of REQUIRED_PARTS) assert.ok(parts[name].length > 0, `部件为空：${name}`);
  });

  check("所有 XML 部件均为良构 XML", () => {
    for (const [name, content] of Object.entries(parts)) {
      const result = XMLValidator.validate(content);
      assert.equal(result, true, `${name} 不是良构 XML：${JSON.stringify(result)}`);
    }
  });

  const documentXml = parts["word/document.xml"];
  const stylesXml = parts["word/styles.xml"];
  const numberingXml = parts["word/numbering.xml"];
  const footerXml = parts["word/footer1.xml"];
  const settingsXml = parts["word/settings.xml"];
  const contentTypesXml = parts["[Content_Types].xml"];
  const documentRelsXml = parts["word/_rels/document.xml.rels"];
  const coreXml = parts["docProps/core.xml"];
  const appXml = parts["docProps/app.xml"];
  const visibleText = extractText(documentXml);

  check("document.xml 包含标题/正文/列表/代码/表格关键文本", () => {
    for (const expected of [
      title,
      "项目背景与目标",
      "统一对外文档格式",
      "支持版本对比",
      "解析 Markdown",
      "技术选型",
      "const blocks = parseMarkdown(markdown);",
      "风险与应对",
      "第 4 级标题用于验证标题层级样式",
      "https://example.com/doc-creator",
      "https://example.com/auto",
      "这是第二行，用于验证硬换行。",
    ]) {
      assertContains(visibleText, expected);
    }
  });

  check("封面与静态目录正确生成", () => {
    assertContains(visibleText, "由 DSH 文档创作生成", "缺少封面生成说明");
    assertContains(visibleText, "作者：docx-engine", "缺少封面作者行");
    assert.match(visibleText, /\d{4}年\d{1,2}月\d{1,2}日/, "缺少封面日期");
    assertContains(visibleText, "目录", "缺少目录标题");
    assertContains(visibleText, "1. 项目背景与目标", "目录一级编号错误");
    assertContains(visibleText, "1.1 一、项目背景", "目录二级编号错误");
    assertContains(visibleText, "1.3 三、风险与应对", "目录三级条目编号错误");
  });

  check("封面不显示页码（首页页脚留空）", () => {
    assertContains(documentXml, '<w:footerReference w:type="first" r:id="rId5"/>', "缺少首页页脚引用");
    assertContains(documentXml, "<w:titlePg/>", "缺少 titlePg（首页页脚不同）");
    assert.ok(footer2Xml.length > 0, "缺少首页页脚部件 word/footer2.xml");
    assert.ok(!footer2Xml.includes("PAGE"), "封面首页页脚不应包含 PAGE 域");
    assert.ok(!footer2Xml.includes("NUMPAGES"), "封面首页页脚不应包含 NUMPAGES 域");
  });

  check("分页符数量正确（封面 + 目录 + 显式分页）", () => {
    assert.equal(countMatches(documentXml, /<w:br w:type="page"\/>/g), 3, "分页符数量应为 3");
    assert.ok(countMatches(documentXml, /<w:br\/>/g) >= 1, "缺少段内硬换行");
  });

  check("A4 页面 / 1 英寸页边距 / 页脚引用正确", () => {
    assertContains(documentXml, '<w:pgSz w:w="11906" w:h="16838"/>');
    for (const margin of ["top", "right", "bottom", "left"]) {
      assertContains(documentXml, `w:${margin}="1440"`, `页边距 ${margin} 不是 1440`);
    }
    assertContains(documentXml, '<w:footerReference w:type="default" r:id="rId4"/>');
    assertContains(documentXml, 'w:line="360"', "正文 1.5 倍行距缺失");
    // 不启用行网格（docGrid type="lines"），避免 Word 把 1.5 倍行距按网格放大
    assert.ok(!documentXml.includes('w:type="lines"'), "不应启用 Word 行网格");
  });

  check("styles.xml 包含中文字体与所需样式", () => {
    for (const styleId of [
      "Heading1",
      "Heading2",
      "Heading3",
      "Title",
      "Subtitle",
      "Quote",
      "Code",
      "TableGrid",
      "ListParagraph",
      "Footer",
      "Normal",
    ]) {
      assertContains(stylesXml, `w:styleId="${styleId}"`, `缺少样式 ${styleId}`);
    }
    assertContains(stylesXml, 'w:eastAsia="宋体"', "缺少正文宋体 eastAsia 字体");
    assertContains(stylesXml, 'w:eastAsia="黑体"', "缺少标题黑体 eastAsia 字体");
    assertContains(stylesXml, 'w:sz w:val="36"', "Heading1 应为 18pt（36 半磅）");
    assertContains(stylesXml, 'w:sz w:val="30"', "Heading2 应为 15pt（30 半磅）");
    assertContains(stylesXml, 'w:sz w:val="26"', "Heading3 应为 13pt（26 半磅）");
    assertContains(stylesXml, 'w:sz w:val="22"', "正文应为 11pt（22 半磅）");
    assertContains(stylesXml, "<w:keepNext/>", "标题缺少 keepNext");
  });

  check("styles.xml 可被 fast-xml-parser 解析出样式列表", () => {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
    const parsed = parser.parse(stylesXml);
    const list = parsed["w:styles"]["w:style"];
    assert.ok(Array.isArray(list) && list.length >= 10, `样式数量不足：${Array.isArray(list) ? list.length : 0}`);
  });

  check("numbering.xml 含项目符号 + 十进制两级编号", () => {
    assertContains(numberingXml, '<w:numFmt w:val="bullet"/>');
    assertContains(numberingXml, '<w:numFmt w:val="decimal"/>');
    const abstractCount = countMatches(numberingXml, /<w:abstractNum w:abstractNumId="\d+">/g);
    assert.ok(abstractCount >= 3, `abstractNum 数量不足：${abstractCount}`);
    assert.equal(countMatches(numberingXml, /<w:lvl w:ilvl="0">/g), abstractCount, "一级编号定义数量不符");
    assert.equal(countMatches(numberingXml, /<w:lvl w:ilvl="1">/g), abstractCount, "二级编号定义数量不符");
    assert.ok(countMatches(numberingXml, /<w:startOverride w:val="1"\/>/g) >= 2, "有序列表缺少重开编号");
    const numCount = countMatches(numberingXml, /<w:num w:numId="\d+">/g);
    assert.ok(numCount >= 4, `num 数量不足：${numCount}`);
  });

  check("正文引用 numbering 的 numId / ilvl 正确", () => {
    const usedNumIds = [...new Set([...documentXml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((match) => match[1]))];
    assert.deepEqual(usedNumIds.sort(), ["1", "2", "3", "4"], `numId 使用不符：${usedNumIds.join(",")}`);
    assertContains(documentXml, '<w:ilvl w:val="0"/>');
    assertContains(documentXml, '<w:ilvl w:val="1"/>');
  });

  check("页脚包含 PAGE / NUMPAGES 域且居中", () => {
    assertContains(footerXml, 'w:instr=" PAGE  \\* MERGEFORMAT "');
    assertContains(footerXml, 'w:instr=" NUMPAGES  \\* MERGEFORMAT "');
    assertContains(footerXml, "第 ");
    assertContains(footerXml, " 页 / 共 ");
    assertContains(footerXml, '<w:jc w:val="center"/>');
    assertContains(footerXml, 'w:pStyle w:val="Footer"');
  });

  check("表格 XML：表头底纹/表头重复/边框/对齐/列宽", () => {
    assert.equal(countMatches(documentXml, /<w:tbl>/g), 1, "应只有 1 个表格");
    assert.equal(countMatches(documentXml, /<w:tr>/g), 5, "表格行数应为 5（表头 + 4 数据行）");
    assert.equal(countMatches(documentXml, /<w:tblHeader\/>/g), 1, "缺少表头重复标记");
    assertContains(documentXml, 'w:fill="D9E2F3"', "缺少表头底纹");
    assertContains(documentXml, 'w:jc w:val="right"', "缺少右对齐单元格");
    assertContains(documentXml, 'w:jc w:val="center"', "缺少居中单元格");
    assertContains(stylesXml, "<w:tblBorders>", "缺少表格边框样式");
    assertContains(documentXml, '<w:tblStyle w:val="TableGrid"/>');
  });

  check("行内样式：粗体 / 斜体 / 行内代码 / 链接", () => {
    assertContains(documentXml, "<w:b/>", "缺少粗体");
    assertContains(documentXml, "<w:i/>", "缺少斜体");
    assertContains(documentXml, 'w:ascii="Consolas"', "缺少行内代码等宽字体");
    assertContains(documentXml, 'w:color w:val="0563C1"', "缺少链接文字颜色");
    assertContains(documentXml, 'w:color w:val="808080"', "缺少链接 URL 灰色小字");
    assertContains(documentXml, '<w:u w:val="single"/>', "缺少链接下划线");
    assert.equal(visibleText.split("https://example.com/auto").length - 1, 1, "自动链接不应重复渲染 URL");
    assert.equal(visibleText.split("https://example.com/doc-creator").length - 1, 1, "普通链接 URL 应出现一次");
  });

  check("settings.xml / core.xml / app.xml / 关系 / 内容类型正确", () => {
    assertContains(settingsXml, 'w:eastAsia="zh-CN"', "缺少中文语言设置");
    assertContains(settingsXml, 'w:name="compatibilityMode"');
    assertContains(settingsXml, 'w:uri="http://schemas.microsoft.com/office/word"');
    assertContains(settingsXml, 'w:val="15"');
    assertContains(coreXml, `<dc:title>${title}</dc:title>`);
    assertContains(coreXml, "<dc:creator>docx-engine</dc:creator>");
    assertContains(appXml, "<Application>DSH Doc Creator</Application>");
    assertContains(appXml, "<Paragraphs>");
    assertContains(documentRelsXml, 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"');
    assertContains(documentRelsXml, 'Target="styles.xml"');
    assertContains(contentTypesXml, 'PartName="/word/footer1.xml"');
    assertContains(contentTypesXml, 'PartName="/word/numbering.xml"');
  });

  /* ------------------------------------------------------------------ *
   * 3. 可选参数 / 边界输入
   * ------------------------------------------------------------------ */
  await checkAsync("cover:false / toc:false 时不生成封面与目录", async () => {
    const minimal = await buildDocxBuffer({ markdown: "# 标题\n\n正文段落。", title: "标题", cover: false, toc: false });
    const minimalZip = await JSZip.loadAsync(minimal);
    const xml = await minimalZip.file("word/document.xml").async("string");
    const text = extractText(xml);
    assert.ok(!text.includes("由 DSH 文档创作生成"), "不应生成封面说明");
    assert.ok(!text.includes("目录"), "不应生成目录");
    assert.equal(countMatches(xml, /<w:br w:type="page"\/>/g), 0, "不应有分页符");
    assert.ok(!xml.includes("<w:titlePg/>"), "无封面时不应启用 titlePg");
    assert.ok(!xml.includes('w:type="first"'), "无封面时不应引用首页页脚");
    assertContains(xml, '<w:footerReference w:type="default" r:id="rId4"/>');
  });

  await checkAsync("空 Markdown 也能生成可打开的最小 docx", async () => {
    const empty = await buildDocxBuffer({ markdown: "" });
    assert.ok(empty.byteLength > 0, "空文档产物为空");
    const emptyZip = await JSZip.loadAsync(empty);
    for (const name of REQUIRED_PARTS) assert.ok(emptyZip.file(name), `空文档缺少部件：${name}`);
    const xml = await emptyZip.file("word/document.xml").async("string");
    assertContains(xml, "<w:sectPr>");
    assertContains(xml, "<w:p/>");
  });

  await checkAsync("XML 转义与非法控制字符处理", async () => {
    const dirty = '# 转义 <测试> & "引号"\n\n正文 <script>alert(1)</script> 与 A&B，含控制符 \u0001\u0002 结束。';
    const escaped = await buildDocxBuffer({ markdown: dirty, cover: false, toc: false });
    const escapedZip = await JSZip.loadAsync(escaped);
    const xml = await escapedZip.file("word/document.xml").async("string");
    assertContains(xml, "&lt;测试&gt;");
    assertContains(xml, "&amp;");
    assertContains(xml, "&quot;引号&quot;");
    assert.ok(!xml.includes("<script>"), "原始 <script> 未被转义");
    assert.ok(!xml.includes("\u0001") && !xml.includes("\u0002"), "非法控制字符未被剔除");
  });

  await checkAsync("buildDocx 缺少 outPath 时抛错", async () => {
    await assert.rejects(() => buildDocx({ markdown: "# 标题" }), /outPath/);
  });

  /* ------------------------------------------------------------------ *
   * 4. buildDocx 落盘 + unzip -t + python-docx
   * ------------------------------------------------------------------ */
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-docx-test-"));
  try {
    const outputPath = path.join(tempDir, "nested", "report.docx");
    const result = await buildDocx({ markdown, title, subtitle, meta, outPath: outputPath });
    const fileStat = await fs.stat(outputPath);

    check("buildDocx 写入文件并返回统计信息", () => {
      assert.equal(result.outPath, path.resolve(outputPath), "outPath 应为绝对路径");
      assert.equal(result.bytes, fileStat.size, "返回字节数与文件大小不一致");
      assert.ok(result.bytes > 5000, `产物过小：${result.bytes}`);
      assert.equal(result.headings, 9, `headings 统计应为 9，实际 ${result.headings}`);
      assert.ok(result.paragraphs > 20, `paragraphs 统计过小：${result.paragraphs}`);
      assert.ok(result.wordCount > 150, `wordCount 统计过小：${result.wordCount}`);
    });

    const unzip = spawnSync("unzip", ["-t", outputPath], { encoding: "utf8" });
    if (unzip.error && unzip.error.code === "ENOENT") {
      warn("unzip -t", "本机没有 unzip，跳过压缩包完整性检查");
    } else {
      check("unzip -t 校验压缩包完整性", () => {
        assert.equal(unzip.status, 0, `unzip -t 失败：${unzip.stderr || unzip.stdout}`);
        assertContains(unzip.stdout || "", "No errors detected");
      });
    }

    // python-docx 校验：不存在 python3 或 python-docx 时仅警告；存在时必须加载成功
    const pythonProbe = spawnSync("python3", ["-c", "import docx; print(docx.__version__)"], { encoding: "utf8" });
    const pythonAvailable = !pythonProbe.error && pythonProbe.status === 0;
    if (!pythonAvailable) {
      warn("python-docx 校验", "本机不可用 python3 或 python-docx，跳过产物加载校验");
    } else {
      const scriptPath = path.join(tempDir, "verify_docx.py");
      await fs.writeFile(scriptPath, PYTHON_VERIFY_SCRIPT, "utf8");
      const pythonRun = spawnSync("python3", [scriptPath, outputPath], { encoding: "utf8", timeout: 60000 });
      await checkAsync("python-docx 能加载产物并校验结构", async () => {
        assert.equal(pythonRun.status, 0, `python-docx 加载失败：${pythonRun.stderr || pythonRun.stdout}`);
        const data = JSON.parse(pythonRun.stdout.trim());
        assert.ok(data.paragraphs >= 30, `段落数过少：${data.paragraphs}`);
        assert.equal(data.tables, 1, `表格数量应为 1，实际 ${data.tables}`);
        assert.deepEqual(data.tableRows, [5], `表格行数不符：${JSON.stringify(data.tableRows)}`);
        assert.ok(data.styles["Heading 1"] >= 1, "缺少 Heading 1 段落");
        assert.ok(data.styles["Heading 2"] >= 1, "缺少 Heading 2 段落");
        assert.ok(data.styles["Heading 3"] >= 1, "缺少 Heading 3 段落");
        assert.ok(data.styles["Title"] >= 1, "缺少 Title 段落");
        assert.ok(data.styles["Subtitle"] >= 1, "缺少 Subtitle 段落");
        assert.ok(data.styles["Quote"] >= 1, "缺少 Quote 段落");
        assert.ok(data.styles["Code"] >= 1, "缺少 Code 段落");
        assert.ok(data.styles["List Paragraph"] >= 5, `ListParagraph 段落过少：${data.styles["List Paragraph"]}`);
        for (const expected of ["统一对外文档格式", "由 DSH 文档创作生成", "目录", "第 4 级标题用于验证标题层级样式"]) {
          assertContains(data.joined, expected, `python-docx 读取文本缺少：${expected}`);
        }
      });
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  /* ------------------------------------------------------------------ *
   * 汇总
   * ------------------------------------------------------------------ */
  console.log("");
  if (failures.length > 0) {
    console.error(`FAIL ${failures.length} 项失败 / ${passCount} 项通过`);
    for (const failure of failures) console.error(`  - ${failure.name}: ${failure.error.stack || failure.error.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS 全部 ${passCount} 项断言通过（docx 引擎）`);
  process.exitCode = 0;
}

main().catch((error) => {
  console.error("FAIL 测试执行异常:", error);
  process.exitCode = 1;
});
