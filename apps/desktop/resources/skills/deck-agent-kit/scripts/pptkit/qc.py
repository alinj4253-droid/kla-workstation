# -*- coding: utf-8 -*-
"""质检门禁：交付前必须全过，不通过不给导出。

四类断言（对应能力规格 §7.4）：
  1. 标点零残留（遍历每个 <a:t>）
  2. 字号下限
  3. 页码连续性
  4. **元素完整性（漏画检查）** —— 以 pptx 实际绘制内容为准，与 spec 该画的内容做集合比对

任何一类发现阻断级问题，``ok=False``。
"""
from __future__ import annotations

from typing import Any

from pptx import Presentation

from .cn import halfwidth_hits
from .tokens import DesignSystem, from_dict

#: 字号下限（pt）：卡内正文 / 小注 / 胶囊。页脚等品牌标记允许 8pt+
FLOOR_BODY = 11.5
FLOOR_NOTE = 10.5
FLOOR_CHIP = 10.0
#: 允许小于下限的例外角色（页脚、来源行、页码、表格小字）
EXEMPT_HINTS = ("来源", "页码", "备注")


def _shape_texts(shape) -> list[str]:
    out: list[str] = []
    if shape.has_text_frame:
        for p in shape.text_frame.paragraphs:
            for r in p.runs:
                if r.text:
                    out.append(r.text)
    if getattr(shape, "has_table", False) and shape.has_table:
        for row in shape.table.rows:
            for cell in row.cells:
                if cell.text:
                    out.append(cell.text)
    return out


def _run_sizes(shape) -> list[tuple[str, float]]:
    out: list[tuple[str, float]] = []
    if shape.has_text_frame:
        for p in shape.text_frame.paragraphs:
            for r in p.runs:
                if r.text and r.font.size is not None:
                    out.append((r.text, r.font.size.pt))
    if getattr(shape, "has_table", False) and shape.has_table:
        for row in shape.table.rows:
            for cell in row.cells:
                for p in cell.text_frame.paragraphs:
                    for r in p.runs:
                        if r.text and r.font.size is not None:
                            out.append((r.text, r.font.size.pt))
    return out


def _block_strings(blk: dict) -> list[str]:
    """从 spec 的块里抽出"必须出现在页面上"的字符串。"""
    out: list[str] = []

    def add(v):
        if isinstance(v, str) and v.strip():
            out.append(v.strip())
        elif isinstance(v, (int, float)):
            out.append(str(v))

    for key in ("title", "text", "body", "value", "unit", "hint"):
        add(blk.get(key))
    for key in ("items",):
        for it in blk.get(key) or []:
            if isinstance(it, dict):
                add(it.get("title"))
                add(it.get("body"))
            else:
                add(it)
    for d in blk.get("data") or []:
        add(d.get("label"))
    for side in ("left", "right"):
        s = blk.get(side)
        if isinstance(s, dict):
            add(s.get("title"))
            for it in s.get("items") or []:
                add(it)
    if blk.get("type") == "table":
        for h in blk.get("header") or []:
            add(h)
        for row in blk.get("rows") or []:
            for c in row:
                add(c)
    return out


def inspect(pptx_path: str, deck: dict | None = None,
            tokens: DesignSystem | None = None) -> dict:
    """对 pptx 跑全套断言，返回质检报告。"""
    if tokens is None and deck is not None:
        tokens = from_dict(deck.get("design_system"))
    if tokens is None:
        tokens = from_dict("modern-tech")

    prs = Presentation(pptx_path)
    findings: list[dict] = []
    page_texts: list[str] = []

    for i, slide in enumerate(prs.slides, start=1):
        joined: list[str] = []
        for shape in slide.shapes:
            for t in _shape_texts(shape):
                joined.append(t)
                hits = halfwidth_hits(t)
                if hits:
                    findings.append({
                        "level": "block", "page": i, "rule": "标点半角残留",
                        "detail": f"{hits} in {t!r}",
                    })
            for txt, sz in _run_sizes(shape):
                low = FLOOR_CHIP
                if len(txt) > 40:
                    low = FLOOR_BODY
                elif len(txt) > 14:
                    low = FLOOR_NOTE
                if sz + 0.01 < low and not any(h in txt for h in EXEMPT_HINTS):
                    findings.append({
                        "level": "warn", "page": i, "rule": "字号偏小",
                        "detail": f"{sz}pt < {low}pt: {txt[:24]!r}",
                    })
        page_texts.append("\n".join(joined))

    # 页码连续性（封面/深色章节页不算）
    if deck:
        for i, page in enumerate(deck.get("pages", []), start=1):
            if page.get("kind") in ("cover", "section"):
                continue
            if i - 1 < len(page_texts) and f"{i:02d}" not in page_texts[i - 1]:
                findings.append({"level": "warn", "page": i, "rule": "页码缺失",
                                 "detail": f"第 {i} 页未见页码 {i:02d}"})

    # 元素完整性（漏画检查）——最关键的一条
    if deck:
        for i, page in enumerate(deck.get("pages", []), start=1):
            if i - 1 >= len(page_texts):
                break
            haystack = page_texts[i - 1].replace(" ", "")
            for j, blk in enumerate(page.get("blocks", [])):
                for s in _block_strings(blk):
                    needle = s.replace(" ", "")
                    if needle and needle not in haystack:
                        findings.append({
                            "level": "block", "page": i, "rule": "疑似漏画",
                            "detail": f"blocks[{j}]({blk.get('type')}) 的内容未出现在页面上：{s[:30]!r}",
                        })
        # 页数一致性
        if len(prs.slides) != len(deck.get("pages", [])):
            findings.append({
                "level": "block", "page": 0, "rule": "页数不一致",
                "detail": f"pptx {len(prs.slides)} 页 vs spec {len(deck['pages'])} 页",
            })

    blocked = [f for f in findings if f["level"] == "block"]
    return {
        "pptx": pptx_path,
        "pages": len(prs.slides),
        "ok": not blocked,
        "blocked": len(blocked),
        "warnings": len(findings) - len(blocked),
        "findings": findings,
    }
