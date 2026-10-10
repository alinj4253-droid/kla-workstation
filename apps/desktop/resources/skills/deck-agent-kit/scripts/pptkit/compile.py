# -*- coding: utf-8 -*-
"""编译：页面语义 spec → 原生可编辑 .pptx。

这一步是"模具"的核心：同一份语义，任何机器、任何次数，产出的 pptx 结构与坐标一致。
"""
from __future__ import annotations

import os
from typing import Any

from pptx import Presentation
from pptx.util import Inches

from . import layout as layout_mod
from . import schema
from .cn import normalize
from .tokens import H, W, from_dict


def _normalize_deep(obj: Any) -> Any:
    """递归归一化所有字符串：全角标点（在写入前统一做，不是事后修补）。"""
    if isinstance(obj, str):
        return normalize(obj)
    if isinstance(obj, dict):
        return {k: _normalize_deep(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_normalize_deep(v) for v in obj]
    return obj


def build(deck: dict, out_path: str, *, strict: bool = True) -> dict:
    """把 deck spec 编译成 pptx，返回编译报告。"""
    if strict:
        schema.assert_valid(deck)
    deck = _normalize_deep(deck)

    errs = schema.validate(deck)
    if errs and strict:
        raise ValueError("spec 不合契约：\n  - " + "\n  - ".join(errs))

    tokens = from_dict(deck.get("design_system"))
    prs = Presentation()
    prs.slide_width = Inches(W)
    prs.slide_height = Inches(H)
    blank = prs.slide_layouts[6]

    pages = deck["pages"]
    total = len(pages)
    recent: list[str] = []
    report: dict = {"deck": deck.get("title", ""), "design_system": tokens.id,
                    "pages": []}

    for i, page in enumerate(pages, start=1):
        slide = prs.slides.add_slide(blank)
        lay = layout_mod.pick_layout(page, recent)
        recent.append(lay)
        layout_mod.render_page(slide, page, tokens, layout=lay, page_no=i,
                               total=total, deck_title=deck.get("title"))
        report["pages"].append({
            "page_id": page.get("page_id"),
            "no": i,
            "layout": lay,
            "page_job": page.get("page_job"),
            "shapes": len(slide.shapes),
        })

    out_dir = os.path.dirname(os.path.abspath(out_path))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    prs.save(out_path)
    report["out"] = os.path.abspath(out_path)
    report["bytes"] = os.path.getsize(out_path)
    return report
