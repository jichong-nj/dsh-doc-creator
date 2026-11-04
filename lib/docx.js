/**
 * @file dsh-doc-creator 的 Word（.docx）导出引擎。
 *
 * 设计要点：
 * 1. 纯 JS 生成 OOXML（不依赖 Office、不依赖原生模块），用 jszip 打包，Node ≥ 24 ESM 环境可直接运行。
 * 2. Markdown 解析（GFM 子集）与 OOXML 渲染分离：`parseMarkdown` 产出与 Word 无关的 Block 数组，
 *    便于测试与将来复用；渲染层只负责把 Block 转成 WordprocessingML。
 * 3. 中文字档排版优先：正文宋体 11pt、1.5 倍行距；标题黑体 18/15/13pt；A4 页面、1 英寸页边距；
 *    页脚居中「第 X 页 / 共 Y 页」域；可选封面与静态目录（1. / 1.1 编号）。
 * 4. 所有文本都做 XML 转义并剔除 XML 1.0 非法控制字符，避免生成损坏的 docx。
 *
 * 对外导出（见 CONTRACTS.md §D）：
 * - {@link parseMarkdown}
 * - {@link buildDocxBuffer}
 * - {@link buildDocx}
 */

import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

/* ============================================================================
 * 一、常量
 * ========================================================================== */

/** WordprocessingML 主命名空间。 */
const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
/** Office 文档关系命名空间（用于页脚引用等 r:id）。 */
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
/** OPC 包关系命名空间。 */
const NS_PACKAGE_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

/** XML 声明头（UTF-8）。 */
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** OOXML 关系类型。 */
const REL_TYPES = Object.freeze({
  officeDocument: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  coreProperties: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
  extendedProperties: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties",
  styles: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles",
  settings: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings",
  numbering: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering",
  footer: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer",
});

/** word/_rels/document.xml.rels 中使用的固定关系 Id（页脚引用需要与 sectPr 一致）。 */
const REL_IDS = Object.freeze({
  styles: "rId1",
  settings: "rId2",
  numbering: "rId3",
  footer: "rId4",
  footerFirst: "rId5",
});

/** A4 页面与页边距（单位：twips，1 inch = 1440 twips）。 */
const PAGE_LAYOUT = Object.freeze({
  width: 11906,
  height: 16838,
  marginTop: 1440,
  marginRight: 1440,
  marginBottom: 1440,
  marginLeft: 1440,
  header: 851,
  footer: 992,
});

/** 正文可用宽度（twips），用于表格列宽均分。 */
const BODY_WIDTH = PAGE_LAYOUT.width - PAGE_LAYOUT.marginLeft - PAGE_LAYOUT.marginRight;

/** 字体约定：正文宋体 + Times New Roman，标题黑体 + Arial，代码 Consolas。 */
const FONT_BODY_EAST_ASIA = "宋体";
const FONT_BODY_LATIN = "Times New Roman";
const FONT_HEADING_EAST_ASIA = "黑体";
const FONT_HEADING_LATIN = "Arial";
const FONT_CODE = "Consolas";

/** 正文 11pt（OOXML 半磅单位 → 22）。 */
const BODY_SIZE = 22;
/** 1.5 倍行距（240 × 1.5 = 360）。 */
const BODY_LINE = 360;

/* ============================================================================
 * 二、通用工具
 * ========================================================================== */

/** XML 1.0 非法控制字符（不含 \t \n \r）。 */
const ILLEGAL_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
/** 孤立代理项（会破坏 UTF-8 / XML 序列化）。 */
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * 归一化任意输入文本：字符串化、去 BOM、统一换行、剔除非法字符与孤立代理项。
 * @param {unknown} value 原始值
 * @returns {string} 可安全写入 XML 的文本
 */
function normalizeSource(value) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n?/g, "\n");
  return text.replace(ILLEGAL_XML_CHARS, "").replace(LONE_SURROGATES, "");
}

/**
 * 转义 XML 文本 / 属性值。
 * @param {unknown} value 原始值
 * @returns {string} 转义后的安全文本
 */
function escapeXml(value) {
  return normalizeSource(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** escapeXml 的短别名，语义上用于属性值。 */
const attr = escapeXml;

/**
 * 判断是否为普通对象（排除 null / 数组 / Date）。
 * @param {unknown} value 待判断值
 * @returns {boolean} 是否为普通对象
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * 取第一个非空字符串。
 * @param {...unknown} values 候选值
 * @returns {string} 第一个非空字符串（去首尾空白），否则空串
 */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * 把可选日期值解析为 Date。
 * @param {unknown} value Date / 时间戳 / ISO 字符串
 * @returns {Date|null} 合法 Date 或 null
 */
function parseDateValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }
  if (typeof value === "string" && value.trim()) {
    const fromString = new Date(value);
    return Number.isNaN(fromString.getTime()) ? null : fromString;
  }
  return null;
}

/**
 * 格式化为 W3CDTF（core.xml 的 dcterms 时间）。
 * @param {Date} date 日期
 * @returns {string} 形如 2026-11-04T01:02:03Z
 */
function toW3CDTF(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * 格式化为中文日期（封面用），如「2026年11月4日」。
 * @param {Date} date 日期
 * @returns {string} 中文日期
 */
function formatChineseDate(date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * 统计一段纯文本的字数：CJK 字符按字计，拉丁/数字按词计。
 * @param {string} text 纯文本
 * @returns {number} 字数
 */
function countWords(text) {
  const source = normalizeSource(text);
  const cjk = source.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g);
  const latin = source.match(/[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*/g);
  return (cjk ? cjk.length : 0) + (latin ? latin.length : 0);
}

/**
 * 两段文本拼接时是否需要补一个空格（仅英文/数字边界补，避免中文出现多余空格）。
 * @param {string} left 左文本
 * @param {string} right 右文本
 * @returns {string} "" 或 " "
 */
function joinSeparator(left, right) {
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right) ? " " : "";
}

/* ============================================================================
 * 三、行内 Markdown 解析
 * ========================================================================== */

/** 可被反斜杠转义的字符集合。 */
const ESCAPABLE_CHARS = /[\\`*_{}[\]()#+\-.!|>~]/;

/**
 * 统计从 start 起连续相同字符的个数。
 * @param {string} text 源文本
 * @param {number} start 起始下标
 * @param {string} ch 目标字符
 * @returns {number} 连续个数
 */
function countCharRun(text, start, ch) {
  let count = 0;
  while (text[start + count] === ch) count += 1;
  return count;
}

/**
 * 查找长度 ≥ len 的定界符连续段。
 * @param {string} text 源文本
 * @param {number} from 起始下标
 * @param {string} ch 定界符字符
 * @param {number} len 需要的连续长度
 * @returns {number} 连续段起始下标，找不到返回 -1
 */
function findCharRun(text, from, ch, len) {
  let i = from;
  while (i <= text.length - len) {
    if (text[i] !== ch) {
      i += 1;
      continue;
    }
    const run = countCharRun(text, i, ch);
    if (run >= len) return i;
    i += run;
  }
  return -1;
}

/**
 * 查找单个定界符（跳过 ** / __ 这类双字符段，避免斜体误吞粗体）。
 * @param {string} text 源文本
 * @param {number} from 起始下标
 * @param {string} ch 定界符字符
 * @returns {number} 下标，找不到返回 -1
 */
function findSingleChar(text, from, ch) {
  let i = from;
  while (i < text.length) {
    if (text[i] !== ch) {
      i += 1;
      continue;
    }
    const run = countCharRun(text, i, ch);
    if (run >= 2) {
      i += run;
      continue;
    }
    return i;
  }
  return -1;
}

/**
 * 从 `[` 处尝试解析一个内联链接 `[文本](url)`。
 * @param {string} text 源文本
 * @param {number} start `[` 的下标
 * @returns {{label:string,url:string,end:number}|null} 解析结果；不是链接返回 null
 */
function matchLink(text, start) {
  let depth = 0;
  let i = start;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0 || text[i + 1] !== "(") return null;
  const labelEnd = i;
  let url = "";
  let parenDepth = 0;
  let j = labelEnd + 2;
  for (; j < text.length; j += 1) {
    const ch = text[j];
    if (ch === "\\" && j + 1 < text.length) {
      url += text[j + 1];
      j += 1;
      continue;
    }
    if (ch === "(") parenDepth += 1;
    if (ch === ")") {
      if (parenDepth === 0) break;
      parenDepth -= 1;
    }
    url += ch;
  }
  if (j >= text.length) return null;
  const label = text.slice(start + 1, labelEnd);
  if (!label.trim()) return null;
  // 兼容 [文本](url "title") 写法：只取 URL 本体
  const href = url.trim().replace(/^<|>$/g, "").split(/\s+/)[0] || "";
  return { label, url: href, end: j + 1 };
}

/**
 * 解析行内 Markdown 为渲染 token 数组。
 *
 * token 形态：
 * - `{ type: "text", text, bold, italic }`
 * - `{ type: "code", text, bold, italic }`
 * - `{ type: "link", url, children: Token[] }`
 *
 * 支持：`**粗体**` / `*斜体*` / `***粗斜体***` / `` `行内代码` `` / `[文本](url)` / `<https://…>` 自动链接
 * / 反斜杠转义。嵌套强调按递归处理。
 *
 * @param {string} markdown 行内 Markdown 文本
 * @returns {Array<object>} token 数组
 */
function parseInlineTokens(markdown) {
  return parseInlineSegment(normalizeSource(markdown), { bold: false, italic: false });
}

/**
 * parseInlineTokens 的递归实现。
 * @param {string} source 文本片段
 * @param {{bold:boolean,italic:boolean}} style 从外层继承的强调样式
 * @returns {Array<object>} token 数组
 */
function parseInlineSegment(source, style) {
  const tokens = [];
  let buffer = "";
  const flush = () => {
    if (!buffer) return;
    tokens.push({ type: "text", text: buffer, bold: style.bold, italic: style.italic });
    buffer = "";
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i];

    // 反斜杠转义
    if (ch === "\\" && i + 1 < source.length && ESCAPABLE_CHARS.test(source[i + 1])) {
      buffer += source[i + 1];
      i += 2;
      continue;
    }

    // 行内代码
    if (ch === "`") {
      const run = countCharRun(source, i, "`");
      const close = findCharRun(source, i + run, "`", run);
      if (close >= 0) {
        flush();
        tokens.push({
          type: "code",
          text: source.slice(i + run, close),
          bold: style.bold,
          italic: style.italic,
        });
        i = close + run;
        continue;
      }
    }

    // 强调：***粗斜体*** / **粗体** / *斜体*（_ 同理）
    if (ch === "*" || ch === "_") {
      const run = countCharRun(source, i, ch);
      if (run >= 3) {
        const close = findCharRun(source, i + 3, ch, 3);
        if (close >= 0) {
          flush();
          tokens.push(...parseInlineSegment(source.slice(i + 3, close), { bold: true, italic: true }));
          i = close + 3;
          continue;
        }
      }
      if (run >= 2) {
        const close = findCharRun(source, i + 2, ch, 2);
        if (close >= 0) {
          flush();
          tokens.push(...parseInlineSegment(source.slice(i + 2, close), { bold: true, italic: style.italic }));
          i = close + 2;
          continue;
        }
      } else {
        const close = findSingleChar(source, i + 1, ch);
        if (close >= 0) {
          flush();
          tokens.push(...parseInlineSegment(source.slice(i + 1, close), { bold: style.bold, italic: true }));
          i = close + 1;
          continue;
        }
      }
    }

    // 内联链接 [文本](url)
    if (ch === "[") {
      const link = matchLink(source, i);
      if (link) {
        flush();
        tokens.push({ type: "link", url: link.url, children: parseInlineSegment(link.label, style) });
        i = link.end;
        continue;
      }
    }

    // 自动链接 <https://…>
    if (ch === "<") {
      const autoLink = source.slice(i).match(/^<([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^<>\s]+|mailto:[^<>\s]+)>/);
      if (autoLink) {
        flush();
        tokens.push({
          type: "link",
          url: autoLink[1],
          children: [{ type: "text", text: autoLink[1], bold: style.bold, italic: style.italic }],
        });
        i += autoLink[0].length;
        continue;
      }
    }

    buffer += ch;
    i += 1;
  }

  flush();
  return tokens;
}

/**
 * 把行内 token 展平为纯文本（用于字数统计、目录文字）。
 * @param {Array<object>} tokens token 数组
 * @returns {string} 纯文本
 */
function flattenInlineText(tokens) {
  const parts = [];
  const walk = (list) => {
    for (const token of list) {
      if (token.type === "link") walk(token.children);
      else parts.push(token.text);
    }
  };
  walk(tokens);
  return parts.join("");
}

/**
 * 解析行内 Markdown 并返回纯文本。
 * @param {string} markdown 行内 Markdown
 * @returns {string} 纯文本
 */
function inlinePlainText(markdown) {
  return flattenInlineText(parseInlineTokens(markdown));
}

/* ============================================================================
 * 四、块级 Markdown 解析
 * ========================================================================== */

/** 分页注释的行匹配（`<!-- pagebreak -->`，容忍 `page-break` 与空白）。 */
const PAGEBREAK_PATTERN = /^(?:<!--\s*page-?break\s*-->|\\pagebreak|\\newpage)$/i;
/** 围栏代码块起始行。 */
const FENCE_PATTERN = /^(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
/** 分隔线（三个及以上的 - * _）。 */
const HR_PATTERN = /^([-*_])(?:\s*\1){2,}$/;
/** ATX 标题。 */
const HEADING_PATTERN = /^(#{1,6})(?:\s+|$)(.*)$/;
/** 列表项：无序 - * + 或有序 1. / 1)。 */
const LIST_ITEM_PATTERN = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
/** 引用行。 */
const QUOTE_PATTERN = /^>\s?/;
/** 表格单元格分隔线中的单个单元格。 */
const TABLE_SEPARATOR_CELL = /^:?-{3,}:?$/;

/**
 * 把整段 Markdown 按空行/块边界切成行数组（保留行首缩进，供列表与代码块判断）。
 * @param {string} markdown 原始 Markdown
 * @returns {string[]} 行数组
 */
function splitSourceLines(markdown) {
  return normalizeSource(markdown).split("\n");
}

/**
 * 判断该行是否是一个新块的起始（用于段落收集时提前结束）。
 * @param {string[]} lines 全部行
 * @param {number} index 当前行下标
 * @returns {boolean} 是否新块起始
 */
function isBlockStartLine(lines, index) {
  const line = lines[index];
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (PAGEBREAK_PATTERN.test(trimmed)) return true;
  if (FENCE_PATTERN.test(trimmed)) return true;
  if (HR_PATTERN.test(trimmed)) return true;
  if (HEADING_PATTERN.test(trimmed)) return true;
  if (QUOTE_PATTERN.test(trimmed)) return true;
  if (LIST_ITEM_PATTERN.test(line)) return true;
  return looksLikeTable(lines, index);
}

/**
 * 判断从 index 起是否为 GFM 表格（表头行 + 分隔行）。
 * @param {string[]} lines 全部行
 * @param {number} index 表头行下标
 * @returns {boolean} 是否表格
 */
function looksLikeTable(lines, index) {
  const header = lines[index];
  if (!header || !header.includes("|")) return false;
  const separator = lines[index + 1];
  if (!separator || !separator.includes("|")) return false;
  const headerCells = splitTableRow(header);
  const separatorCells = splitTableRow(separator);
  if (headerCells.length < 1 || headerCells.length !== separatorCells.length) return false;
  return separatorCells.every((cell) => TABLE_SEPARATOR_CELL.test(cell.trim()));
}

/**
 * 按未转义的 `|` 切分表格行（首尾竖线可省略）。
 * @param {string} line 表格行
 * @returns {string[]} 单元格文本数组
 */
function splitTableRow(line) {
  let source = normalizeSource(line).trim();
  if (source.startsWith("|")) source = source.slice(1);
  if (source.endsWith("|") && !source.endsWith("\\|")) source = source.slice(0, -1);
  const cells = [];
  let current = "";
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\\" && source[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

/**
 * 解析表格分隔行里的对齐方式。
 * @param {string} line 分隔行
 * @param {number} count 需要的列数
 * @returns {Array<"left"|"center"|"right">} 每列对齐方式
 */
function parseTableAlignments(line, count) {
  const cells = splitTableRow(line);
  const alignments = cells.map((cell) => {
    const trimmed = cell.trim();
    const left = trimmed.startsWith(":");
    const right = trimmed.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
  while (alignments.length < count) alignments.push("left");
  return alignments.slice(0, count);
}

/**
 * 解析列表项行。
 * @param {string} line 原始行
 * @returns {{ordered:boolean,level:number,text:string}|null} 解析结果
 */
function parseListItem(line) {
  const match = LIST_ITEM_PATTERN.exec(line);
  if (!match) return null;
  const indent = match[1].replace(/\t/g, "    ").length;
  return {
    ordered: /^\d/.test(match[2]),
    level: indent >= 2 ? 1 : 0, // 仅支持两级，更深的缩进按第二级处理
    text: match[3].trim(),
  };
}

/**
 * 去掉代码块内容的公共缩进，并裁掉首尾空行。
 * @param {string[]} lines 代码块原始行
 * @returns {string[]} 清理后的行
 */
function trimCodeLines(lines) {
  const result = lines.slice();
  while (result.length && !result[result.length - 1].trim()) result.pop();
  while (result.length && !result[0].trim()) result.shift();
  const indents = result
    .filter((line) => line.trim())
    .map((line) => (line.match(/^ */) || [""])[0].length);
  const common = indents.length ? Math.min(...indents) : 0;
  return result.map((line) => (common > 0 ? line.slice(common) : line));
}

/**
 * 解析 Markdown 为结构化块数组。
 *
 * 支持块类型：`heading`（1–6 级）、`paragraph`、`list`（无序/有序，最多两级嵌套）、
 * `blockquote`（内部递归解析）、`code`（围栏代码块）、`table`（GFM 表格）、`hr`、
 * `pagebreak`（`<!-- pagebreak -->`）。
 *
 * 段落中的行内元素（粗体/斜体/行内代码/链接）保留在原始文本里，由渲染层解析；
 * 段落内软换行按中英文规则拼接，行尾两个空格或反斜杠表示硬换行（`\\n`）。
 *
 * @param {string} markdown Markdown 文本
 * @returns {Array<object>} Block 数组
 */
export function parseMarkdown(markdown) {
  const lines = splitSourceLines(markdown);
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // 空行
    if (!trimmed) {
      i += 1;
      continue;
    }

    // 分页注释
    if (PAGEBREAK_PATTERN.test(trimmed)) {
      blocks.push({ type: "pagebreak" });
      i += 1;
      continue;
    }

    // 围栏代码块
    const fence = FENCE_PATTERN.exec(trimmed);
    if (fence) {
      const marker = fence[1][0];
      const fenceLength = fence[1].length;
      const codeLines = [];
      let j = i + 1;
      while (j < lines.length) {
        const candidate = lines[j].trim();
        const markerCount = countCharRun(candidate, 0, marker);
        const isClosingFence = markerCount >= fenceLength && candidate.slice(markerCount).trim() === "";
        if (isClosingFence) {
          j += 1;
          break;
        }
        codeLines.push(lines[j]);
        j += 1;
      }
      const cleaned = trimCodeLines(codeLines);
      blocks.push({ type: "code", lang: fence[2] || "", code: cleaned.join("\n") });
      i = j;
      continue;
    }

    // 分隔线
    if (HR_PATTERN.test(trimmed)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    // ATX 标题
    const heading = HEADING_PATTERN.exec(trimmed);
    if (heading) {
      const text = heading[2].replace(/\s+#+\s*$/, "").trim();
      blocks.push({ type: "heading", level: heading[1].length, text });
      i += 1;
      continue;
    }

    // 引用块：收集连续的 > 行后递归解析
    if (QUOTE_PATTERN.test(trimmed)) {
      const quoteLines = [];
      while (i < lines.length && QUOTE_PATTERN.test(lines[i].trim())) {
        quoteLines.push(lines[i].trim().replace(QUOTE_PATTERN, ""));
        i += 1;
      }
      blocks.push({ type: "blockquote", blocks: parseMarkdown(quoteLines.join("\n")) });
      continue;
    }

    // GFM 表格
    if (looksLikeTable(lines, i)) {
      const headers = splitTableRow(lines[i]);
      const alignments = parseTableAlignments(lines[i + 1], headers.length);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() && lines[j].includes("|")) {
        const cells = splitTableRow(lines[j]);
        while (cells.length < headers.length) cells.push("");
        rows.push(cells.slice(0, headers.length));
        j += 1;
      }
      blocks.push({ type: "table", headers, alignments, rows });
      i = j;
      continue;
    }

    // 列表
    const firstItem = parseListItem(raw);
    if (firstItem) {
      const items = [];
      let j = i;
      while (j < lines.length) {
        const line = lines[j];
        if (!line.trim()) break;
        const item = parseListItem(line);
        if (item) {
          // 顶层标记类型变化视为另一个列表；嵌套项允许混合类型
          if (item.level === 0 && item.ordered !== firstItem.ordered) break;
          items.push({ text: item.text, level: item.level, ordered: item.ordered });
          j += 1;
          continue;
        }
        // 缩进续行并入上一项
        if (items.length && /^\s{2,}\S/.test(line) && !isBlockStartLine(lines, j)) {
          const previous = items[items.length - 1];
          previous.text += joinSeparator(previous.text, line.trim()) + line.trim();
          j += 1;
          continue;
        }
        break;
      }
      blocks.push({ type: "list", ordered: firstItem.ordered, items });
      i = j;
      continue;
    }

    // 段落：一直收集到空行或下一个块起点
    const paragraphParts = [];
    let j = i;
    while (j < lines.length) {
      const line = lines[j];
      if (!line.trim()) break;
      if (j > i && isBlockStartLine(lines, j)) break;
      let text = line.trim();
      let hardBreak = false;
      if (/ {2,}$/.test(line) || /\\$/.test(text)) {
        hardBreak = true;
        text = text.replace(/\\$/, "").replace(/\s+$/, "");
      }
      paragraphParts.push({ text, hardBreak });
      j += 1;
    }
    if (paragraphParts.length) {
      let text = "";
      for (let k = 0; k < paragraphParts.length; k += 1) {
        if (k > 0) {
          text += paragraphParts[k - 1].hardBreak ? "\n" : joinSeparator(paragraphParts[k - 1].text, paragraphParts[k].text);
        }
        text += paragraphParts[k].text;
      }
      blocks.push({ type: "paragraph", text });
    }
    i = Math.max(j, i + 1);
  }

  return blocks;
}

/**
 * 去掉文档末尾的分页块，避免生成多余的空白页。
 * @param {Array<object>} blocks Block 数组
 * @returns {Array<object>} 处理后的 Block 数组
 */
function trimTrailingPageBreaks(blocks) {
  const result = blocks.slice();
  while (result.length && result[result.length - 1].type === "pagebreak") result.pop();
  return result;
}

/* ============================================================================
 * 五、统计（标题数 / 段落数 / 字数）
 * ========================================================================== */

/**
 * 遍历块（含引用块内部块）。
 * @param {Array<object>} blocks Block 数组
 * @param {(block: object) => void} visitor 访问函数
 */
function walkBlocks(blocks, visitor) {
  for (const block of blocks) {
    visitor(block);
    if (block.type === "blockquote") walkBlocks(block.blocks, visitor);
  }
}

/**
 * 统计文档结构信息。
 *
 * 统计口径：
 * - `headings`：标题块数量；
 * - `paragraphs`：正文段落 + 列表项 + 引用块内段落 + 代码块行 + 表格行 + 分隔线/分页块；
 * - `words`：CJK 字符数 + 拉丁词数（含标题、表格、代码块）；
 * - `chars`：纯文本字符数（用于 docProps/app.xml）。
 *
 * @param {Array<object>} blocks Block 数组
 * @returns {{headings:number,paragraphs:number,words:number,chars:number}} 统计结果
 */
function countStats(blocks) {
  let headings = 0;
  let paragraphs = 0;
  let words = 0;
  let chars = 0;

  const addText = (text) => {
    words += countWords(text);
    chars += normalizeSource(text).length;
  };

  walkBlocks(blocks, (block) => {
    switch (block.type) {
      case "heading":
        headings += 1;
        addText(inlinePlainText(block.text));
        break;
      case "paragraph":
        paragraphs += 1;
        addText(inlinePlainText(block.text));
        break;
      case "list":
        paragraphs += block.items.length;
        for (const item of block.items) addText(inlinePlainText(item.text));
        break;
      case "code":
        paragraphs += Math.max(block.code.split("\n").length, 1);
        addText(block.code);
        break;
      case "table":
        paragraphs += (block.headers.length ? 1 : 0) + block.rows.length;
        for (const cell of block.headers) addText(inlinePlainText(cell));
        for (const row of block.rows) for (const cell of row) addText(inlinePlainText(cell));
        break;
      case "hr":
      case "pagebreak":
        paragraphs += 1;
        break;
      case "blockquote":
        // 引用块自身不计段落，内部块递归统计
        break;
      default:
        break;
    }
  });

  return { headings, paragraphs, words, chars };
}

/**
 * 收集目录需要的标题（level ≤ 2）。
 * @param {Array<object>} blocks Block 数组
 * @returns {Array<object>} 标题块数组
 */
function collectTocHeadings(blocks) {
  const headings = [];
  walkBlocks(blocks, (block) => {
    if (block.type === "heading" && block.level <= 2) headings.push(block);
  });
  return headings;
}

/* ============================================================================
 * 六、编号规划（numbering.xml）
 * ========================================================================== */

/**
 * 计算列表块的编号形状：`顶层类型|嵌套类型`。
 * @param {object} block 列表块
 * @returns {string} `bullet|bullet` / `decimal|decimal` / `bullet|decimal` / `decimal|bullet`
 */
function listShapeKey(block) {
  const nested = block.items.find((item) => item.level === 1);
  const topType = block.ordered ? "decimal" : "bullet";
  const nestedType = nested ? (nested.ordered ? "decimal" : "bullet") : topType;
  return `${topType}|${nestedType}`;
}

/**
 * 为所有列表块分配 numId，并规划 abstractNum。
 *
 * 规则：
 * - 纯项目符号列表全部共享 numId 1（抽象定义 bullet|bullet）；
 * - 其余列表块各占一个 numId，并在 lvl 0/1 上加 startOverride，保证每个列表从 1 重新计数；
 * - 始终声明 bullet|bullet 与 decimal|decimal 两种两级编号，按需追加混合形状。
 *
 * @param {Array<object>} blocks Block 数组
 * @returns {{abstracts: Array<{id:number,key:string}>, nums: Array<{id:number,abstractId:number,restart:boolean}>, blockNumId: Map<object, number>}}
 */
function planNumbering(blocks) {
  const listBlocks = [];
  walkBlocks(blocks, (block) => {
    if (block.type === "list" && block.items.length) listBlocks.push(block);
  });

  const abstracts = [];
  const abstractIdByShape = new Map();
  const ensureAbstract = (shape) => {
    if (!abstractIdByShape.has(shape)) {
      const id = abstracts.length;
      abstracts.push({ id, key: shape });
      abstractIdByShape.set(shape, id);
    }
    return abstractIdByShape.get(shape);
  };

  ensureAbstract("bullet|bullet");
  ensureAbstract("decimal|decimal");

  const nums = [{ id: 1, abstractId: 0, restart: false }];
  const blockNumId = new Map();

  for (const block of listBlocks) {
    const shape = listShapeKey(block);
    if (shape === "bullet|bullet") {
      blockNumId.set(block, 1);
      continue;
    }
    const abstractId = ensureAbstract(shape);
    const numId = nums.length + 1;
    nums.push({ id: numId, abstractId, restart: true });
    blockNumId.set(block, numId);
  }

  return { abstracts, nums, blockNumId };
}

/* ============================================================================
 * 七、OOXML 行内 / 段落渲染
 * ========================================================================== */

/**
 * 生成 run 属性（`w:rPr`）子串。
 * @param {object} fmt 格式：{bold,italic,underline,color,size,code,eastAsia,ascii}
 * @returns {string} `<w:rPr>…</w:rPr>` 或空串
 */
function runPropsXml(fmt = {}) {
  const parts = [];
  if (fmt.code) {
    parts.push(
      `<w:rFonts w:ascii="${FONT_CODE}" w:hAnsi="${FONT_CODE}" w:eastAsia="${FONT_BODY_EAST_ASIA}" w:cs="${FONT_CODE}"/>`,
    );
  } else if (fmt.ascii || fmt.eastAsia) {
    const ascii = fmt.ascii || FONT_BODY_LATIN;
    const eastAsia = fmt.eastAsia || FONT_BODY_EAST_ASIA;
    parts.push(`<w:rFonts w:ascii="${attr(ascii)}" w:hAnsi="${attr(ascii)}" w:eastAsia="${attr(eastAsia)}" w:cs="${attr(ascii)}"/>`);
  }
  if (fmt.bold) parts.push("<w:b/><w:bCs/>");
  if (fmt.italic) parts.push("<w:i/><w:iCs/>");
  if (fmt.color) parts.push(`<w:color w:val="${attr(fmt.color)}"/>`);
  if (fmt.size) parts.push(`<w:sz w:val="${Number(fmt.size)}"/><w:szCs w:val="${Number(fmt.size)}"/>`);
  if (fmt.underline) parts.push('<w:u w:val="single"/>');
  return parts.length ? `<w:rPr>${parts.join("")}</w:rPr>` : "";
}

/**
 * 把纯文本转成若干 run；`\n` → `<w:br/>`，`\t` → `<w:tab/>`，并保留空格。
 * @param {string} text 文本
 * @param {string} rPrXml run 属性串
 * @returns {string} run XML
 */
function textRunsXml(text, rPrXml) {
  const source = normalizeSource(text);
  if (!source) return "";
  const chunks = source.split(/(\n|\t)/);
  let xml = "";
  for (const chunk of chunks) {
    if (chunk === "\n") xml += `<w:r>${rPrXml}<w:br/></w:r>`;
    else if (chunk === "\t") xml += `<w:r>${rPrXml}<w:tab/></w:r>`;
    else if (chunk) xml += `<w:r>${rPrXml}<w:t xml:space="preserve">${escapeXml(chunk)}</w:t></w:r>`;
  }
  return xml;
}

/**
 * 生成单个 run。
 * @param {string} text 文本
 * @param {object} [fmt] 格式
 * @returns {string} run XML
 */
function runXml(text, fmt) {
  return textRunsXml(text, runPropsXml(fmt));
}

/**
 * 把行内 token 渲染成 run 序列。链接渲染为「带颜色下划线的文字（灰色小字 URL）」。
 * @param {Array<object>} tokens token 数组
 * @param {object} [baseFmt] 基础格式
 * @returns {string} run XML
 */
function inlineRunsXml(tokens, baseFmt = {}) {
  let xml = "";
  for (const token of tokens) {
    if (token.type === "link") {
      const linkFmt = { ...baseFmt, color: "0563C1", underline: true };
      if (token.bold !== undefined) linkFmt.bold = Boolean(token.bold);
      if (token.italic !== undefined) linkFmt.italic = Boolean(token.italic);
      xml += inlineRunsXml(token.children, linkFmt);
      const linkText = flattenInlineText(token.children).trim();
      if (token.url && linkText !== token.url) {
        xml += runXml(` (${token.url})`, { ...baseFmt, color: "808080", size: 18 });
      }
      continue;
    }
    const fmt = { ...baseFmt };
    if (token.bold) fmt.bold = true;
    if (token.italic) fmt.italic = true;
    if (token.type === "code") fmt.code = true;
    xml += runXml(token.text, fmt);
  }
  return xml;
}

/**
 * 构建段落 XML。
 * @param {string} runsXml run 序列
 * @param {string} [pPrInner] `<w:pPr>` 内部 XML
 * @returns {string} 段落 XML
 */
function paragraphXml(runsXml, pPrInner = "") {
  const pPr = pPrInner ? `<w:pPr>${pPrInner}</w:pPr>` : "";
  return runsXml ? `<w:p>${pPr}${runsXml}</w:p>` : `<w:p>${pPr}</w:p>`;
}

/** 分页符段落。 */
function pageBreakXml() {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

/**
 * 渲染标题。
 * @param {{level:number,text:string}} block 标题块
 * @returns {string} 段落 XML
 */
function renderHeading(block) {
  const pPr = `<w:pStyle w:val="Heading${block.level}"/><w:keepNext/>`;
  return paragraphXml(inlineRunsXml(parseInlineTokens(block.text)), pPr);
}

/**
 * 渲染正文段落。
 * @param {{text:string}} block 段落块
 * @returns {string} 段落 XML
 */
function renderParagraph(block) {
  return paragraphXml(inlineRunsXml(parseInlineTokens(block.text)));
}

/**
 * 渲染列表块。
 * @param {object} block 列表块
 * @param {object} ctx 渲染上下文（含 numbering）
 * @returns {string} 段落 XML 拼接
 */
function renderList(block, ctx) {
  const numId = ctx.numbering.blockNumId.get(block) || 1;
  let xml = "";
  for (const item of block.items) {
    const ilvl = item.level > 0 ? 1 : 0;
    const pPr =
      `<w:pStyle w:val="ListParagraph"/>` +
      `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`;
    xml += paragraphXml(inlineRunsXml(parseInlineTokens(item.text)), pPr);
  }
  return xml;
}

/**
 * 渲染引用块（内部块递归渲染；段落使用 Quote 样式，嵌套层级增加缩进）。
 * @param {object} block 引用块
 * @param {object} ctx 渲染上下文
 * @param {number} depth 嵌套深度
 * @returns {string} XML 拼接
 */
function renderBlockquote(block, ctx, depth) {
  let xml = "";
  for (const child of block.blocks) {
    if (child.type === "paragraph") {
      const indent = 420 + depth * 420;
      const pPr = `<w:pStyle w:val="Quote"/><w:spacing w:before="120" w:after="120" w:line="320" w:lineRule="auto"/><w:ind w:left="${indent}" w:right="240"/>`;
      xml += paragraphXml(inlineRunsXml(parseInlineTokens(child.text)), pPr);
      continue;
    }
    if (child.type === "blockquote") {
      xml += renderBlockquote(child, ctx, depth + 1);
      continue;
    }
    if (child.type === "list") {
      xml += renderList(child, ctx);
      continue;
    }
    xml += renderBlocks([child], ctx, depth);
  }
  return xml;
}

/**
 * 渲染围栏代码块（整块放在一个段落的边框/底纹里，行间用换行符分隔）。
 * @param {{code:string}} block 代码块
 * @returns {string} 段落 XML
 */
function renderCodeBlock(block) {
  const pPr = '<w:pStyle w:val="Code"/>';
  const runs = textRunsXml(block.code, runPropsXml({ code: true, size: 20 }));
  return paragraphXml(runs, pPr);
}

/**
 * 渲染 GFM 表格（表头浅蓝底、加粗，全表格细边框，按列对齐）。
 * @param {{headers:string[],alignments:Array<string>,rows:string[][]}} block 表格块
 * @returns {string} 表格 XML
 */
function renderTable(block) {
  const columnCount = Math.max(block.headers.length, 1);
  const baseWidth = Math.floor(BODY_WIDTH / columnCount);
  const lastWidth = BODY_WIDTH - baseWidth * (columnCount - 1);
  const grid = Array.from({ length: columnCount }, (_, index) =>
    `<w:gridCol w:w="${index === columnCount - 1 ? lastWidth : baseWidth}"/>`,
  ).join("");

  const cellXml = (text, index, isHeader) => {
    const width = index === columnCount - 1 ? lastWidth : baseWidth;
    const align = block.alignments[index] || "left";
    const fill = isHeader ? '<w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/>' : "";
    const fmt = isHeader
      ? { bold: true, size: 20, eastAsia: FONT_HEADING_EAST_ASIA, ascii: FONT_HEADING_LATIN }
      : { size: 20, eastAsia: FONT_BODY_EAST_ASIA, ascii: FONT_BODY_LATIN };
    const pPr = `<w:spacing w:before="40" w:after="40" w:line="300" w:lineRule="auto"/><w:jc w:val="${align}"/>`;
    return (
      `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${fill}<w:vAlign w:val="center"/></w:tcPr>` +
      `${paragraphXml(inlineRunsXml(parseInlineTokens(text), fmt), pPr)}</w:tc>`
    );
  };

  const headerRow = `<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>${block.headers
    .map((cell, index) => cellXml(cell, index, true))
    .join("")}</w:tr>`;
  const bodyRows = block.rows
    .map(
      (row) =>
        `<w:tr><w:trPr><w:cantSplit/></w:trPr>${row.map((cell, index) => cellXml(cell, index, false)).join("")}</w:tr>`,
    )
    .join("");

  return (
    `<w:tbl>` +
    `<w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${BODY_WIDTH}" w:type="dxa"/><w:jc w:val="center"/>` +
    `<w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>` +
    `<w:tblGrid>${grid}</w:tblGrid>${headerRow}${bodyRows}</w:tbl>`
  );
}

/**
 * 渲染分隔线（空段落 + 下边框）。
 * @returns {string} 段落 XML
 */
function renderHorizontalRule() {
  return (
    '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr>' +
    '<w:spacing w:before="120" w:after="120" w:line="240" w:lineRule="auto"/></w:pPr></w:p>'
  );
}

/**
 * 渲染块数组。
 * @param {Array<object>} blocks Block 数组
 * @param {object} ctx 渲染上下文
 * @param {number} [depth] 引用块嵌套深度
 * @returns {string} XML 拼接
 */
function renderBlocks(blocks, ctx, depth = 0) {
  let xml = "";
  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        xml += renderHeading(block);
        break;
      case "paragraph":
        xml += renderParagraph(block);
        break;
      case "list":
        xml += renderList(block, ctx);
        break;
      case "blockquote":
        xml += renderBlockquote(block, ctx, depth);
        break;
      case "code":
        xml += renderCodeBlock(block);
        break;
      case "table":
        xml += renderTable(block);
        break;
      case "hr":
        xml += renderHorizontalRule();
        break;
      case "pagebreak":
        xml += pageBreakXml();
        break;
      default:
        break;
    }
  }
  return xml;
}

/* ============================================================================
 * 八、封面 / 目录 / 节属性
 * ========================================================================== */

/**
 * 渲染封面页（标题 26pt 居中、副标题、日期、生成说明，末尾分页）。
 * @param {{title:string,subtitle:string,metaInfo:object}} options 封面内容
 * @returns {string} XML 拼接
 */
function renderCover({ title, subtitle, metaInfo }) {
  const rows = [];

  rows.push(
    `<w:p><w:pPr><w:pStyle w:val="Title"/><w:spacing w:before="2800" w:after="200" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>` +
      `${inlineRunsXml(parseInlineTokens(title), { bold: true, size: 52, eastAsia: FONT_HEADING_EAST_ASIA, ascii: FONT_HEADING_LATIN })}</w:p>`,
  );

  if (subtitle) {
    rows.push(
      `<w:p><w:pPr><w:pStyle w:val="Subtitle"/><w:spacing w:before="0" w:after="360" w:line="300" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>` +
        `${runXml(subtitle, { size: 32, color: "595959", eastAsia: FONT_HEADING_EAST_ASIA, ascii: FONT_HEADING_LATIN })}</w:p>`,
    );
  }

  const infoLine = (text, before) =>
    `<w:p><w:pPr><w:spacing w:before="${before}" w:after="120" w:line="300" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>` +
    `${runXml(text, { size: 24, color: "595959", eastAsia: FONT_BODY_EAST_ASIA, ascii: FONT_BODY_LATIN })}</w:p>`;

  if (metaInfo.author) rows.push(infoLine(`作者：${metaInfo.author}`, 1200));
  if (metaInfo.company) rows.push(infoLine(`机构：${metaInfo.company}`, metaInfo.author ? 0 : 1200));
  rows.push(infoLine(metaInfo.displayDate, metaInfo.author || metaInfo.company ? 0 : 1200));
  rows.push(
    `<w:p><w:pPr><w:spacing w:before="800" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>` +
      `${runXml("由 DSH 文档创作生成", { size: 18, color: "A6A6A6", eastAsia: FONT_BODY_EAST_ASIA, ascii: FONT_BODY_LATIN })}</w:p>`,
  );
  rows.push(pageBreakXml());
  return rows.join("");
}

/**
 * 渲染静态目录（遍历 level ≤ 2 的标题，按 1. / 1.1 编号，末尾分页）。
 * @param {Array<object>} headings 标题块数组
 * @returns {string} XML 拼接
 */
function renderToc(headings) {
  const rows = [];
  rows.push(
    `<w:p><w:pPr><w:spacing w:before="240" w:after="360" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>` +
      `${runXml("目录", { bold: true, size: 32, eastAsia: FONT_HEADING_EAST_ASIA, ascii: FONT_HEADING_LATIN })}</w:p>`,
  );

  let level1 = 0;
  let level2 = 0;
  for (const heading of headings) {
    let label;
    if (heading.level === 1) {
      level1 += 1;
      level2 = 0;
      label = `${level1}. ${inlinePlainText(heading.text)}`;
    } else {
      if (level1 === 0) level1 = 1;
      level2 += 1;
      label = `${level1}.${level2} ${inlinePlainText(heading.text)}`;
    }
    const indent = heading.level === 1 ? 0 : 420;
    rows.push(
      `<w:p><w:pPr><w:spacing w:before="0" w:after="120" w:line="360" w:lineRule="auto"/><w:ind w:left="${indent}"/><w:jc w:val="left"/></w:pPr>` +
        `${runXml(label, { size: BODY_SIZE, eastAsia: FONT_BODY_EAST_ASIA, ascii: FONT_BODY_LATIN })}</w:p>`,
    );
  }

  rows.push(pageBreakXml());
  return rows.join("");
}

/**
 * 渲染节属性（A4、1 英寸页边距、页脚引用）。
 * 有封面时启用「首页页脚不同」，让封面不显示页码。
 * @param {boolean} hasCover 是否生成封面
 * @returns {string} `<w:sectPr>` XML
 */
function renderSectionProperties(hasCover) {
  return (
    `<w:sectPr>` +
    (hasCover ? `<w:footerReference w:type="first" r:id="${REL_IDS.footerFirst}"/>` : "") +
    `<w:footerReference w:type="default" r:id="${REL_IDS.footer}"/>` +
    `<w:pgSz w:w="${PAGE_LAYOUT.width}" w:h="${PAGE_LAYOUT.height}"/>` +
    `<w:pgMar w:top="${PAGE_LAYOUT.marginTop}" w:right="${PAGE_LAYOUT.marginRight}" w:bottom="${PAGE_LAYOUT.marginBottom}" w:left="${PAGE_LAYOUT.marginLeft}" w:header="${PAGE_LAYOUT.header}" w:footer="${PAGE_LAYOUT.footer}" w:gutter="0"/>` +
    `<w:cols w:space="425"/>` +
    (hasCover ? "<w:titlePg/>" : "") +
    `</w:sectPr>`
  );
}

/**
 * 组装 word/document.xml。
 * @param {object} options 渲染参数
 * @returns {string} document.xml 内容
 */
function buildDocumentXml({ blocks, title, subtitle, metaInfo, cover, toc, headings, numbering }) {
  const body = [];
  if (cover) body.push(renderCover({ title, subtitle, metaInfo }));
  if (toc) body.push(renderToc(headings));

  const ctx = { numbering };
  const contentXml = renderBlocks(blocks, ctx);
  if (contentXml) body.push(contentXml);
  // Word 要求 table 之后有段落收尾，避免表格贴住 sectPr
  if (contentXml.trimEnd().endsWith("</w:tbl>")) body.push("<w:p/>");
  if (!body.length) body.push("<w:p/>");
  body.push(renderSectionProperties(cover));

  return `${XML_DECL}<w:document xmlns:w="${NS_W}" xmlns:r="${NS_R}"><w:body>${body.join("")}</w:body></w:document>`;
}

/* ============================================================================
 * 九、其余 OOXML 部件
 * ========================================================================== */

/**
 * 构建 [Content_Types].xml。
 * @param {boolean} hasCover 是否生成封面（决定是否存在首页页脚部件）
 * @returns {string} XML 内容
 */
function buildContentTypesXml(hasCover) {
  const overrides = [
    ["/word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"],
    ["/word/styles.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"],
    ["/word/settings.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"],
    ["/word/numbering.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"],
    ["/word/footer1.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"],
    ["/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"],
    ["/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml"],
    ...(hasCover
      ? [["/word/footer2.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"]]
      : []),
  ];
  return (
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    overrides.map(([partName, contentType]) => `<Override PartName="${partName}" ContentType="${contentType}"/>`).join("") +
    `</Types>`
  );
}

/**
 * 构建 `_rels/.rels`（包级关系）。
 * @returns {string} XML 内容
 */
function buildRootRelsXml() {
  return (
    `${XML_DECL}<Relationships xmlns="${NS_PACKAGE_REL}">` +
    `<Relationship Id="rId1" Type="${REL_TYPES.officeDocument}" Target="word/document.xml"/>` +
    `<Relationship Id="rId2" Type="${REL_TYPES.coreProperties}" Target="docProps/core.xml"/>` +
    `<Relationship Id="rId3" Type="${REL_TYPES.extendedProperties}" Target="docProps/app.xml"/>` +
    `</Relationships>`
  );
}

/**
 * 构建 `word/_rels/document.xml.rels`（样式/设置/编号/页脚关系）。
 * @param {boolean} hasCover 是否生成封面（决定是否存在首页页脚关系）
 * @returns {string} XML 内容
 */
function buildDocumentRelsXml(hasCover) {
  const entries = [
    [REL_IDS.styles, REL_TYPES.styles, "styles.xml"],
    [REL_IDS.settings, REL_TYPES.settings, "settings.xml"],
    [REL_IDS.numbering, REL_TYPES.numbering, "numbering.xml"],
    [REL_IDS.footer, REL_TYPES.footer, "footer1.xml"],
  ];
  if (hasCover) entries.push([REL_IDS.footerFirst, REL_TYPES.footer, "footer2.xml"]);
  return (
    `${XML_DECL}<Relationships xmlns="${NS_PACKAGE_REL}">` +
    entries
      .map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`)
      .join("") +
    `</Relationships>`
  );
}

/**
 * 构建 `docProps/core.xml`（标题、作者、时间等元数据）。
 * @param {{title:string,subtitle:string,metaInfo:object}} options 参数
 * @returns {string} XML 内容
 */
function buildCoreXml({ title, subtitle, metaInfo }) {
  const author = metaInfo.author || "DSH 文档创作";
  return (
    `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    `<dc:subject>${escapeXml(subtitle || metaInfo.subject)}</dc:subject>` +
    `<dc:creator>${escapeXml(author)}</dc:creator>` +
    `<cp:lastModifiedBy>${escapeXml(author)}</cp:lastModifiedBy>` +
    (metaInfo.keywords ? `<cp:keywords>${escapeXml(metaInfo.keywords)}</cp:keywords>` : "") +
    (metaInfo.description ? `<dc:description>${escapeXml(metaInfo.description)}</dc:description>` : "") +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${metaInfo.createdIso}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${metaInfo.createdIso}</dcterms:modified>` +
    `</cp:coreProperties>`
  );
}

/**
 * 构建 `docProps/app.xml`（应用与统计信息）。
 * @param {{stats:object,metaInfo:object}} options 参数
 * @returns {string} XML 内容
 */
function buildAppXml({ stats, metaInfo }) {
  return (
    `${XML_DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
    `<Template>Normal.dotm</Template><TotalTime>0</TotalTime>` +
    `<Pages>1</Pages><Words>${stats.words}</Words><Characters>${stats.chars}</Characters>` +
    `<Application>DSH Doc Creator</Application><DocSecurity>0</DocSecurity><Lines>0</Lines>` +
    `<Paragraphs>${stats.paragraphs}</Paragraphs><ScaleCrop>false</ScaleCrop>` +
    `<Company>${escapeXml(metaInfo.company)}</Company><LinksUpToDate>false</LinksUpToDate>` +
    `<CharactersWithSpaces>${stats.chars}</CharactersWithSpaces><SharedDoc>false</SharedDoc>` +
    `<HyperlinksChanged>false</HyperlinksChanged><AppVersion>1.0</AppVersion>` +
    `</Properties>`
  );
}

/**
 * 构建 `word/settings.xml`。
 * @returns {string} XML 内容
 */
function buildSettingsXml() {
  return (
    `${XML_DECL}<w:settings xmlns:w="${NS_W}">` +
    `<w:zoom w:percent="100"/>` +
    `<w:defaultTabStop w:val="420"/>` +
    `<w:characterSpacingControl w:val="compressPunctuation"/>` +
    `<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>` +
    `<w:rsids><w:rsidRoot w:val="00A12345"/><w:rsid w:val="00A12345"/></w:rsids>` +
    `<w:themeFontLang w:val="en-US" w:eastAsia="zh-CN"/>` +
    `<w:decimalSymbol w:val="."/><w:listSeparator w:val=","/>` +
    `</w:settings>`
  );
}

/**
 * 构建 `word/footer1.xml`（居中「第 X 页 / 共 Y 页」PAGE / NUMPAGES 域）。
 * @returns {string} XML 内容
 */
function buildFooterXml() {
  return (
    `${XML_DECL}<w:ftr xmlns:w="${NS_W}" xmlns:r="${NS_R}">` +
    `<w:p><w:pPr><w:pStyle w:val="Footer"/><w:jc w:val="center"/></w:pPr>` +
    `<w:r><w:t xml:space="preserve">第 </w:t></w:r>` +
    `<w:fldSimple w:instr=" PAGE  \\* MERGEFORMAT "><w:r><w:t>1</w:t></w:r></w:fldSimple>` +
    `<w:r><w:t xml:space="preserve"> 页 / 共 </w:t></w:r>` +
    `<w:fldSimple w:instr=" NUMPAGES  \\* MERGEFORMAT "><w:r><w:t>1</w:t></w:r></w:fldSimple>` +
    `<w:r><w:t xml:space="preserve"> 页</w:t></w:r>` +
    `</w:p></w:ftr>`
  );
}

/**
 * 构建 `word/footer2.xml`（封面首页页脚：留空，不显示页码）。
 * @returns {string} XML 内容
 */
function buildFirstPageFooterXml() {
  return `${XML_DECL}<w:ftr xmlns:w="${NS_W}" xmlns:r="${NS_R}"><w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr></w:p></w:ftr>`;
}

/**
 * 构建 `word/styles.xml`。
 *
 * 包含：Normal、Title、Subtitle、Heading1–6、Quote、Code、ListParagraph、Footer、
 * TableNormal（默认表格样式）、TableGrid（细边框表格）。
 * 正文宋体 11pt / 行距 1.5；标题黑体 18/15/13pt（H4–H6 递减）。
 *
 * @returns {string} XML 内容
 */
function buildStylesXml() {
  const headingStyle = (level, size, before, after) =>
    `<w:style w:type="paragraph" w:styleId="Heading${level}">` +
    `<w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="${after}" w:line="240" w:lineRule="auto"/><w:jc w:val="left"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
    `<w:rPr><w:rFonts w:ascii="${FONT_HEADING_LATIN}" w:hAnsi="${FONT_HEADING_LATIN}" w:eastAsia="${FONT_HEADING_EAST_ASIA}" w:cs="${FONT_HEADING_LATIN}"/><w:b/><w:bCs/><w:color w:val="1F1F1F"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>` +
    `</w:style>`;

  return (
    `${XML_DECL}<w:styles xmlns:w="${NS_W}">` +
    `<w:docDefaults>` +
    `<w:rPrDefault><w:rPr><w:rFonts w:ascii="${FONT_BODY_LATIN}" w:hAnsi="${FONT_BODY_LATIN}" w:eastAsia="${FONT_BODY_EAST_ASIA}" w:cs="${FONT_BODY_LATIN}"/><w:kern w:val="2"/><w:sz w:val="${BODY_SIZE}"/><w:szCs w:val="${BODY_SIZE}"/><w:lang w:val="en-US" w:eastAsia="zh-CN" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:widowControl w:val="0"/><w:spacing w:before="0" w:after="120" w:line="${BODY_LINE}" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr></w:pPrDefault>` +
    `</w:docDefaults>` +

    // 正文
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:widowControl w:val="0"/><w:spacing w:before="0" w:after="120" w:line="${BODY_LINE}" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr>` +
    `<w:rPr><w:rFonts w:ascii="${FONT_BODY_LATIN}" w:hAnsi="${FONT_BODY_LATIN}" w:eastAsia="${FONT_BODY_EAST_ASIA}" w:cs="${FONT_BODY_LATIN}"/><w:sz w:val="${BODY_SIZE}"/><w:szCs w:val="${BODY_SIZE}"/></w:rPr>` +
    `</w:style>` +

    // 封面主标题 / 副标题
    `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:spacing w:before="0" w:after="240" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/><w:outlineLvl w:val="9"/></w:pPr>` +
    `<w:rPr><w:rFonts w:ascii="${FONT_HEADING_LATIN}" w:hAnsi="${FONT_HEADING_LATIN}" w:eastAsia="${FONT_HEADING_EAST_ASIA}" w:cs="${FONT_HEADING_LATIN}"/><w:b/><w:bCs/><w:color w:val="1F1F1F"/><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr>` +
    `</w:style>` +
    `<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:spacing w:before="0" w:after="240" w:line="300" w:lineRule="auto"/><w:jc w:val="center"/><w:outlineLvl w:val="9"/></w:pPr>` +
    `<w:rPr><w:rFonts w:ascii="${FONT_HEADING_LATIN}" w:hAnsi="${FONT_HEADING_LATIN}" w:eastAsia="${FONT_HEADING_EAST_ASIA}" w:cs="${FONT_HEADING_LATIN}"/><w:color w:val="595959"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>` +
    `</w:style>` +

    // 标题 1–6
    headingStyle(1, 36, 360, 200) +
    headingStyle(2, 30, 300, 160) +
    headingStyle(3, 26, 260, 140) +
    headingStyle(4, 24, 220, 120) +
    headingStyle(5, 22, 200, 100) +
    headingStyle(6, 22, 200, 100) +

    // 引用
    `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="C9D3DF"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/><w:spacing w:before="120" w:after="120" w:line="320" w:lineRule="auto"/><w:ind w:left="420" w:right="240"/></w:pPr>` +
    `<w:rPr><w:color w:val="404040"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr>` +
    `</w:style>` +

    // 代码块
    `<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="4" w:color="D0D7DE"/><w:left w:val="single" w:sz="4" w:space="4" w:color="D0D7DE"/><w:bottom w:val="single" w:sz="4" w:space="4" w:color="D0D7DE"/><w:right w:val="single" w:sz="4" w:space="4" w:color="D0D7DE"/></w:pBdr>` +
    `<w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/><w:spacing w:before="120" w:after="120" w:line="260" w:lineRule="auto"/><w:ind w:left="140" w:right="140"/><w:snapToGrid w:val="0"/><w:jc w:val="left"/></w:pPr>` +
    `<w:rPr><w:rFonts w:ascii="${FONT_CODE}" w:hAnsi="${FONT_CODE}" w:eastAsia="${FONT_BODY_EAST_ASIA}" w:cs="${FONT_CODE}"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:color w:val="24292F"/></w:rPr>` +
    `</w:style>` +

    // 列表段落（缩进由 numbering 提供）
    `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:spacing w:before="40" w:after="60" w:line="${BODY_LINE}" w:lineRule="auto"/></w:pPr>` +
    `<w:rPr><w:sz w:val="${BODY_SIZE}"/><w:szCs w:val="${BODY_SIZE}"/></w:rPr>` +
    `</w:style>` +

    // 页脚
    `<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>` +
    `<w:rPr><w:rFonts w:ascii="${FONT_BODY_LATIN}" w:hAnsi="${FONT_BODY_LATIN}" w:eastAsia="${FONT_BODY_EAST_ASIA}"/><w:color w:val="595959"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>` +
    `</w:style>` +

    // 表格基础样式 + 网格样式
    `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/>` +
    `<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `</w:style>` +
    `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:qFormat/>` +
    `<w:tblPr><w:tblBorders>` +
    `<w:top w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>` +
    `<w:insideH w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>` +
    `</w:tblBorders></w:tblPr>` +
    `</w:style>` +

    `</w:styles>`
  );
}

/* ============================================================================
 * 十、numbering.xml 构建
 * ========================================================================== */

/**
 * 生成单个编号级别定义。
 * @param {number} ilvl 级别（0/1）
 * @param {"bullet"|"decimal"} type 编号类型
 * @returns {string} `<w:lvl>` XML
 */
function numberingLevelXml(ilvl, type) {
  const isBullet = type === "bullet";
  const levelText = isBullet ? (ilvl === 0 ? "●" : "○") : ilvl === 0 ? "%1." : "（%2）";
  const indent = 720 + ilvl * 720;
  const fontXml = isBullet
    ? `<w:rFonts w:ascii="${FONT_BODY_EAST_ASIA}" w:hAnsi="${FONT_BODY_EAST_ASIA}" w:eastAsia="${FONT_BODY_EAST_ASIA}"/>`
    : `<w:rFonts w:ascii="${FONT_BODY_LATIN}" w:hAnsi="${FONT_BODY_LATIN}" w:eastAsia="${FONT_BODY_EAST_ASIA}"/>`;
  return (
    `<w:lvl w:ilvl="${ilvl}">` +
    `<w:start w:val="1"/>` +
    `<w:numFmt w:val="${isBullet ? "bullet" : "decimal"}"/>` +
    `<w:lvlText w:val="${attr(levelText)}"/>` +
    `<w:lvlJc w:val="left"/>` +
    `<w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr>` +
    `<w:rPr>${fontXml}<w:sz w:val="${BODY_SIZE}"/><w:szCs w:val="${BODY_SIZE}"/></w:rPr>` +
    `</w:lvl>`
  );
}

/**
 * 构建 `word/numbering.xml`（项目符号 + 十进制编号，两级）。
 * @param {{abstracts:Array<{id:number,key:string}>,nums:Array<{id:number,abstractId:number,restart:boolean}>}} plan 编号规划
 * @returns {string} XML 内容
 */
function buildNumberingXml(plan) {
  const abstractsXml = plan.abstracts
    .map((abstract) => {
      const [top, nested] = abstract.key.split("|");
      return (
        `<w:abstractNum w:abstractNumId="${abstract.id}">` +
        `<w:multiLevelType w:val="multilevel"/>` +
        numberingLevelXml(0, top) +
        numberingLevelXml(1, nested) +
        `</w:abstractNum>`
      );
    })
    .join("");
  const numsXml = plan.nums
    .map(
      (num) =>
        `<w:num w:numId="${num.id}"><w:abstractNumId w:val="${num.abstractId}"/>` +
        (num.restart
          ? `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride><w:lvlOverride w:ilvl="1"><w:startOverride w:val="1"/></w:lvlOverride>`
          : "") +
        `</w:num>`,
    )
    .join("");
  return `${XML_DECL}<w:numbering xmlns:w="${NS_W}">${abstractsXml}${numsXml}</w:numbering>`;
}

/* ============================================================================
 * 十一、对外接口
 * ========================================================================== */

/**
 * 解析文档元数据（作者、机构、日期等），同时给 core.xml / 封面提供格式化值。
 * @param {unknown} meta 用户传入的 meta 对象
 * @param {Date} now 当前时间（可注入，便于测试）
 * @returns {{author:string,company:string,subject:string,keywords:string,description:string,displayDate:string,createdIso:string}}
 */
function resolveDocumentMeta(meta, now) {
  const raw = isPlainObject(meta) ? meta : {};
  const created = parseDateValue(raw.created) || parseDateValue(raw.date) || now;
  return {
    author: firstString(raw.author, raw.creator),
    company: firstString(raw.company),
    subject: firstString(raw.subject),
    keywords: firstString(raw.keywords),
    description: firstString(raw.description),
    displayDate: firstString(raw.date, raw.displayDate) || formatChineseDate(created),
    createdIso: toW3CDTF(created),
  };
}

/**
 * 构建 .docx 二进制内容（不落盘）。
 *
 * @param {object} options 选项
 * @param {string} options.markdown 成文 Markdown（GFM 子集）
 * @param {string} [options.title] 文档标题（封面与 core.xml 使用）
 * @param {string} [options.subtitle] 副标题（仅封面使用）
 * @param {object} [options.meta] 元数据：{ author, company, subject, keywords, description, created, date }
 * @param {boolean} [options.cover] 是否生成封面（有 title/subtitle 时默认 true）
 * @param {boolean} [options.toc] 是否生成静态目录（有 level≤2 标题时默认 true）
 * @returns {Promise<Uint8Array>} .docx 文件字节
 */
export async function buildDocxBuffer(options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const markdown = typeof opts.markdown === "string" ? opts.markdown : "";
  const title = normalizeSource(opts.title).trim();
  const subtitle = normalizeSource(opts.subtitle).trim();
  const now = new Date();
  const metaInfo = resolveDocumentMeta(opts.meta, now);

  const blocks = trimTrailingPageBreaks(parseMarkdown(markdown));
  const stats = countStats(blocks);
  const headings = collectTocHeadings(blocks);
  const numbering = planNumbering(blocks);
  let firstAnyHeading = "";
  if (!title && !headings.length) {
    walkBlocks(blocks, (block) => {
      if (!firstAnyHeading && block.type === "heading") firstAnyHeading = inlinePlainText(block.text);
    });
  }
  const displayTitle = title || (headings[0] ? inlinePlainText(headings[0].text) : firstAnyHeading) || "未命名文档";
  const cover = opts.cover !== false && Boolean(title || subtitle);
  const toc = opts.toc !== false && headings.length > 0;

  const documentXml = buildDocumentXml({
    blocks,
    title: displayTitle,
    subtitle,
    metaInfo,
    cover,
    toc,
    headings,
    numbering,
  });

  const zip = new JSZip();
  zip.file("[Content_Types].xml", buildContentTypesXml(cover));
  zip.file("_rels/.rels", buildRootRelsXml());
  zip.file("docProps/core.xml", buildCoreXml({ title: displayTitle, subtitle, metaInfo }));
  zip.file("docProps/app.xml", buildAppXml({ stats, metaInfo }));
  zip.file("word/document.xml", documentXml);
  zip.file("word/styles.xml", buildStylesXml());
  zip.file("word/settings.xml", buildSettingsXml());
  zip.file("word/numbering.xml", buildNumberingXml(numbering));
  zip.file("word/footer1.xml", buildFooterXml());
  if (cover) zip.file("word/footer2.xml", buildFirstPageFooterXml());
  zip.file("word/_rels/document.xml.rels", buildDocumentRelsXml(cover));

  const result = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: "DOS",
  });
  return result instanceof Uint8Array ? result : new Uint8Array(result);
}

/**
 * 构建 .docx 并写入磁盘。
 *
 * @param {object} options 选项（在 buildDocxBuffer 的基础上增加 outPath）
 * @param {string} options.outPath 输出文件路径（目录不存在会自动创建）
 * @param {string} options.markdown 成文 Markdown
 * @param {string} [options.title] 文档标题
 * @param {string} [options.subtitle] 副标题
 * @param {object} [options.meta] 元数据
 * @param {boolean} [options.cover] 是否生成封面
 * @param {boolean} [options.toc] 是否生成目录
 * @returns {Promise<{outPath:string,bytes:number,headings:number,paragraphs:number,wordCount:number}>}
 *   outPath 为解析后的绝对路径；bytes 为文件字节数；其余为结构统计。
 */
export async function buildDocx(options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const { outPath } = opts;
  if (typeof outPath !== "string" || !outPath.trim()) {
    throw new Error("buildDocx 需要提供 outPath（输出 .docx 路径）");
  }

  const bytes = await buildDocxBuffer(opts);
  const absolutePath = path.resolve(outPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, bytes);

  const blocks = trimTrailingPageBreaks(parseMarkdown(typeof opts.markdown === "string" ? opts.markdown : ""));
  const stats = countStats(blocks);
  return {
    outPath: absolutePath,
    bytes: bytes.byteLength,
    headings: stats.headings,
    paragraphs: stats.paragraphs,
    wordCount: stats.words,
  };
}
