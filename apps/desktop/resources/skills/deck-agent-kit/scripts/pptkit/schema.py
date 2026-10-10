# -*- coding: utf-8 -*-
"""页面语义契约（Single Source of Truth）。

核心约束：**语言模型只填语义，一个坐标、字号、颜色都不填。** 几何由布局引擎算。

本模块做两件事：
  1. 定义 deck / page / block 的结构与取值域
  2. ``validate()`` —— 生成即刻校验，填错就打回，不等编译才发现
"""
from __future__ import annotations

from typing import Any

#: 支持的块类型 → 说明（布局引擎按块类型组合选版式）
BLOCK_TYPES: dict[str, str] = {
    "lead":       "导语/一句话结论（页头下的一行）",
    "card":       "卡片：title + body（可 items 列表），可 mark 强调",
    "bullets":    "条目组：items（每项完整句）",
    "kpi":        "英雄数字：value + unit + label + note",
    "steps":      "流程步骤带：items（顺序即展示顺序）",
    "chart":      "柱状图：data=[{label,value,hot?}] + note",
    "compare":    "两列对比：left{title,items} / right{title,items}",
    "matrix":     "覆盖矩阵：rows=[...] cols=[...] dots=[{r,c,filled}]",
    "image_slot": "配图位：label + hint（无真实素材时的虚线占位）",
    "concl":      "底部结论条：text（全宽）",
    "quote":      "引语：text + source",
    "table":      "表格：header=[...] rows=[[...]]",
}

#: 版式 id → 说明（布局引擎内部的版式函数名）
LAYOUTS: dict[str, str] = {
    "cover":       "封面",
    "section":     "章节分隔页",
    "statement":   "单句大陈述页",
    "kpi_focus":   "英雄数字页",
    "cards":       "卡片网格（2~4 卡）",
    "two_col":     "两列对比",
    "steps":       "流程步骤带",
    "chart_concl": "图表 + 结论",
    "image_led":   "图主导（配图位占 35~45%）",
    "table":       "表格页",
}

#: 页面角色（影响版式选取与留白）
PAGE_KINDS = ("cover", "section", "content", "closing")


def validate(deck: dict[str, Any]) -> list[str]:
    """校验 deck spec，返回错误清单（空 = 通过）。不抛异常，便于一次性报全。"""
    errs: list[str] = []

    if not isinstance(deck, dict):
        return ["deck 必须是对象"]

    if not str(deck.get("title", "")).strip():
        errs.append("缺少 deck.title")

    ds = deck.get("design_system")
    if ds is None:
        errs.append("缺少 design_system（可为预设 id 字符串，或含 preset 的对象）")
    elif not isinstance(ds, (str, dict)):
        errs.append("design_system 必须是字符串或对象")

    pages = deck.get("pages")
    if not isinstance(pages, list) or not pages:
        errs.append("缺少 pages（非空数组）")
        return errs

    seen_ids: set[str] = set()
    for i, page in enumerate(pages):
        p = f"pages[{i}]"
        if not isinstance(page, dict):
            errs.append(f"{p} 必须是对象")
            continue

        pid = page.get("page_id")
        if not pid:
            errs.append(f"{p} 缺少 page_id")
        elif pid in seen_ids:
            errs.append(f"{p} page_id 重复：{pid}")
        else:
            seen_ids.add(pid)

        if not str(page.get("page_job", "")).strip():
            errs.append(f"{p} 缺少 page_job（这页要干什么，一句话）")

        kind = page.get("kind", "content")
        if kind not in PAGE_KINDS:
            errs.append(f"{p} kind 非法：{kind!r}，可选 {PAGE_KINDS}")

        blocks = page.get("blocks")
        if kind == "section":
            pass  # 章节页可无块
        elif not isinstance(blocks, list) or not blocks:
            errs.append(f"{p} 缺少 blocks（kind={kind} 时非空）")
            continue

        for j, blk in enumerate(blocks or []):
            b = f"{p}.blocks[{j}]"
            if not isinstance(blk, dict):
                errs.append(f"{b} 必须是对象")
                continue
            bt = blk.get("type")
            if bt not in BLOCK_TYPES:
                errs.append(f"{b} 未知块类型 {bt!r}，可选 {sorted(BLOCK_TYPES)}")
                continue

            if bt == "card" and not str(blk.get("title", "")).strip():
                errs.append(f"{b} card 缺少 title")
            if bt in ("bullets", "steps") and not blk.get("items"):
                errs.append(f"{b} {bt} 缺少 items")
            if bt == "kpi" and blk.get("value") in (None, ""):
                errs.append(f"{b} kpi 缺少 value")
            if bt == "chart" and not blk.get("data"):
                errs.append(f"{b} chart 缺少 data")
            if bt == "compare" and not (blk.get("left") and blk.get("right")):
                errs.append(f"{b} compare 需要 left 与 right")
            if bt == "concl" and not str(blk.get("text", "")).strip():
                errs.append(f"{b} concl 缺少 text")
            if bt == "quote" and not str(blk.get("text", "")).strip():
                errs.append(f"{b} quote 缺少 text")
            if bt == "table" and not (blk.get("header") and blk.get("rows")):
                errs.append(f"{b} table 需要 header 与 rows")

            # 禁坐标 / 字号 / 颜色进入语义层——这是契约的第一号红线
            banned = ["x", "y", "w", "h", "top", "width", "height",
                      "font_size", "size", "color", "fill"]
            if bt != "compare":
                # compare.left / compare.right 是语义分组名（左列/右列），不是几何
                banned += ["left", "right"]
            for f in banned:
                if f in blk:
                    errs.append(f"{b} 不允许携带几何/样式字段 {f!r}"
                                "（语义层只描述内容，几何由布局引擎算）")

            # 数据严谨：带 data 的块必须能追溯来源或标注为假设
            if bt == "chart":
                for k, d in enumerate(blk.get("data") or []):
                    if not isinstance(d, dict) or "value" not in d:
                        errs.append(f"{b}.data[{k}] 需要 value")
            if bt == "kpi" and blk.get("source") is None and blk.get("assumption") is None:
                # 不强制报错，但提示（由门禁决定是否阻断）
                pass

    if not any(p.get("kind") == "cover" for p in pages if isinstance(p, dict)):
        errs.append("缺少封面页（kind='cover'）")

    return errs


def assert_valid(deck: dict[str, Any]) -> None:
    errs = validate(deck)
    if errs:
        raise ValueError("deck spec 不合契约：\n  - " + "\n  - ".join(errs))
