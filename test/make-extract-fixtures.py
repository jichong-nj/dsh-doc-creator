#!/usr/bin/env python3
"""生成 backend-core 的文本抽取测试样例（test/fixtures/）。

产物（全部以 extract- 前缀命名，避免与其他模块的 fixture 冲突）：
  extract-docx.docx           段落 + 表格，验证 docx 抽取顺序与表格分隔
  extract-pptx.pptx           三页幻灯片，验证按 presentation.xml 的 sldIdLst 顺序抽取
  extract-pptx-reordered.pptx 在上一份基础上把 sldIdLst 调换为 [3, 1, 2]，验证顺序优先于文件名
  extract-pdf.pdf             手写最小 PDF（纯 ASCII），验证 pdftotext 子进程路径

依赖：python-docx、python-pptx（测试环境已安装）。不联网、可重复执行（覆盖写入）。

用法：python3 test/make-extract-fixtures.py
"""

from __future__ import annotations

import re
import sys
import zipfile
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent / "fixtures"

DOCX_NAME = "extract-docx.docx"
PPTX_NAME = "extract-pptx.pptx"
PPTX_REORDERED_NAME = "extract-pptx-reordered.pptx"
PDF_NAME = "extract-pdf.pdf"

DOCX_PARAGRAPHS = [
    "这是 Word 测试文档第一段，用于验证段落抽取。",
    "第二段包含关键术语：文档创作插件（doc-creator）。",
]
DOCX_TABLE = [
    ["指标", "目标", "说明"],
    ["字数", "2000", "正文总字数"],
    ["周期", "2 周", "从立项到验收"],
]
DOCX_AFTER_TABLE = "表格之后的段落：请保持与表格的先后顺序。"

PPTX_SLIDES = [
    ("第一部分", "背景与目标：验证幻灯片顺序抽取。"),
    ("第二部分", "方案概述：文本来自不同幻灯片。"),
    ("第三部分", "实施计划：第三页应被识别为第三段。"),
]

PDF_LINES = [
    "Doc Creator PDF fixture",
    "Second line for extraction test.",
]


def make_docx(path: Path) -> None:
    """段落 + 2 行 3 列表格 + 段落。"""
    from docx import Document

    document = Document()
    for paragraph in DOCX_PARAGRAPHS:
        document.add_paragraph(paragraph)
    table = document.add_table(rows=len(DOCX_TABLE), cols=len(DOCX_TABLE[0]))
    for row_index, row in enumerate(DOCX_TABLE):
        for col_index, value in enumerate(row):
            table.cell(row_index, col_index).text = value
    document.add_paragraph(DOCX_AFTER_TABLE)
    document.save(str(path))


def make_pptx(path: Path) -> None:
    """三页空白版式幻灯片，每页两个文本框（标题 + 正文）。"""
    from pptx import Presentation
    from pptx.util import Inches

    presentation = Presentation()
    blank_layout = presentation.slide_layouts[6]
    for index, (title, body) in enumerate(PPTX_SLIDES):
        slide = presentation.slides.add_slide(blank_layout)
        title_box = slide.shapes.add_textbox(Inches(0.6), Inches(1.0), Inches(8.0), Inches(1.0))
        title_box.text_frame.text = title
        body_box = slide.shapes.add_textbox(Inches(0.6), Inches(2.2), Inches(8.0), Inches(1.5))
        body_box.text_frame.text = body
        # 保证页面上至少有一个非空段落，便于断言页码顺序
        assert slide.shapes, index
    presentation.save(str(path))


def reorder_pptx(source: Path, target: Path, order: list[int]) -> None:
    """改写 presentation.xml 中 sldIdLst 的子元素顺序（order 为 0 起的原顺序下标）。"""
    pattern = re.compile(r"(<p:sldIdLst[^>]*>)(.*?)(</p:sldIdLst>)", re.DOTALL)
    item_pattern = re.compile(r"<p:sldId\b[^>]*/>")
    with zipfile.ZipFile(source, "r") as zin:
        entries = {name: zin.read(name) for name in zin.namelist()}
    xml = entries["ppt/presentation.xml"].decode("utf-8")
    match = pattern.search(xml)
    if not match:
        raise RuntimeError("presentation.xml 中未找到 p:sldIdLst")
    items = item_pattern.findall(match.group(2))
    if len(items) != len(order):
        raise RuntimeError(f"sldId 数量 {len(items)} 与调换顺序长度 {len(order)} 不一致")
    new_inner = "".join(items[index] for index in order)
    xml = xml[: match.start(2)] + new_inner + xml[match.end(2) :]
    entries["ppt/presentation.xml"] = xml.encode("utf-8")
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zout:
        for name, data in entries.items():
            zout.writestr(name, data)


def build_pdf_bytes(lines: list[str]) -> bytes:
    """手写最小合法 PDF（Helvetica、纯 ASCII，含正确 xref 偏移）。"""
    content = ["BT", "/F1 14 Tf", "72 720 Td"]
    for index, line in enumerate(lines):
        escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        if index > 0:
            content.append("0 -24 Td")
        content.append(f"({escaped}) Tj")
    content.append("ET")
    stream = "\n".join(content).encode("latin-1")

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets: list[int] = []
    for index, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{index} 0 obj\n".encode("ascii") + body + b"\nendobj\n"
    xref_offset = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode("ascii")
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode("ascii")
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_offset}\n%%EOF\n"
    ).encode("ascii")
    return bytes(out)


def main() -> int:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    try:
        import docx  # noqa: F401
        import pptx  # noqa: F401
    except ImportError as error:  # pragma: no cover - 环境缺依赖时给出明确提示
        print(f"缺少依赖：{error}（需要 python-docx 与 python-pptx）", file=sys.stderr)
        return 1

    make_docx(FIXTURES / DOCX_NAME)
    make_pptx(FIXTURES / PPTX_NAME)
    reorder_pptx(FIXTURES / PPTX_NAME, FIXTURES / PPTX_REORDERED_NAME, [2, 0, 1])
    (FIXTURES / PDF_NAME).write_bytes(build_pdf_bytes(PDF_LINES))

    for name in (DOCX_NAME, PPTX_NAME, PPTX_REORDERED_NAME, PDF_NAME):
        path = FIXTURES / name
        print(f"generated {path} ({path.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
