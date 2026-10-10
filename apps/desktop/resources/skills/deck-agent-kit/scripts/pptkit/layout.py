# -*- coding: utf-8 -*-
"""版式库：把「页面语义」翻译成「几何」，再交给零件库落笔。

两种职责分开：
  · ``pick_layout(page)``   —— 版式选型（块类型组合 → 版式），含全局多样性约束
  · ``render_page(...)``    —— 分派到具体版式函数，算出坐标

版式是确定性函数：同一份语义 spec，任何机器、任何次数，算出的坐标一致。
"""
from __future__ import annotations

from typing import Any

from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Inches

from .tokens import H, W, DesignSystem
from . import primitives as P

# ------------------------------------------------------------------ 版式选型

#: 连续多少页同版式即视为重复
REPEAT_LIMIT = 3


def pick_layout(page: dict, recent: list[str] | None = None) -> str:
    """按块类型组合选版式；若会构成连续重复，则换一个候选。"""
    kind = page.get("kind", "content")
    if kind == "cover":
        return "cover"
    if kind == "section":
        return "section"
    if kind == "closing":
        return "statement"

    types = [b.get("type") for b in page.get("blocks", [])]
    if types.count("compare") or (types.count("card") == 2 and "chart" not in types
                                  and _has_pair(page)):
        base = "two_col"
    elif "chart" in types:
        base = "chart_concl"
    elif "steps" in types:
        base = "steps"
    elif "table" in types:
        base = "table"
    elif "kpi" in types and types.count("kpi") <= 2:
        base = "kpi_focus"
    elif "image_slot" in types or _image_led(page):
        base = "image_led"
    elif types.count("card") >= 2:
        base = "cards"
    elif "bullets" in types and len(types) == 1:
        base = "statement" if _short(page) else "cards"
    else:
        base = "cards"

    recent = recent or []
    if len(recent) >= REPEAT_LIMIT - 1 and all(r == base for r in recent[-(REPEAT_LIMIT - 1):]):
        base = _alternate(base)
    return base


def _has_pair(page) -> bool:
    cards = [b for b in page.get("blocks", []) if b.get("type") == "card"]
    return len(cards) == 2


def _image_led(page) -> bool:
    """无图位但内容里有照片类意图时，也走图主导版式。"""
    for b in page.get("blocks", []):
        if b.get("type") == "image_slot":
            return True
    return False


def _short(page) -> bool:
    blocks = page.get("blocks", [])
    if len(blocks) != 1:
        return False
    b = blocks[0]
    txt = str(b.get("text") or b.get("body") or "")
    return b.get("type") == "bullets" and len(txt) < 60 and len(b.get("items") or []) <= 1


_ALT = {"cards": "steps", "steps": "cards", "two_col": "cards",
        "chart_concl": "kpi_focus", "kpi_focus": "chart_concl",
        "image_led": "cards", "table": "cards", "statement": "cards"}
_REVERSE = {"steps": "cards", "cards": "steps"}


def _alternate(base: str) -> str:
    """换版式打破节奏——换的是**图表/结构形态**，不是换个颜色了事。"""
    return _ALT.get(base, "cards")


# ------------------------------------------------------------------ 渲染

def render_page(slide, page: dict, tokens: DesignSystem, *, layout: str,
                page_no: int, total: int, deck_title: str | None = None) -> None:
    fn = _RENDERERS.get(layout, _r_cards)
    fn(slide, page, tokens, page_no=page_no, total=total, deck_title=deck_title)


def _blocks(page, *types):
    return [b for b in page.get("blocks", []) if b.get("type") in types]


def _first(page, *types):
    got = _blocks(page, *types)
    return got[0] if got else None


def _concl(slide, page, tokens, y=None):
    c = _first(page, "concl")
    if not c:
        return 0.0
    y = y if y is not None else tokens.content_bottom - 0.56
    return P.concl_bar(slide, tokens.content_x, y, tokens.content_w, tokens,
                       text_=c.get("text", ""))


# ---------------------------------------------------------------- 各版式实现
def _r_cover(slide, page, tokens, *, page_no, total, deck_title=None):
    P.rect(slide, 0, 0, W, H, fill=tokens.primary, shape=P.MSO_SHAPE.RECTANGLE)
    P.rect(slide, 0, H - 2.5, W, 2.5, fill=tokens.primary, shape=P.MSO_SHAPE.RECTANGLE)
    P.rect(slide, tokens.margin, 2.32, 1.5, 0.075, fill=tokens.accent,
           shape=P.MSO_SHAPE.RECTANGLE)
    P.text(slide, tokens.margin, 2.60, 9.6, 1.5, page.get("title", ""), tokens,
           size=54, color="#F4F4F2", bold=True, line_spacing=1.05)
    sub = _first(page, "lead", "bullets")
    if sub:
        body = sub.get("text") or "\n".join(sub.get("items") or [])
        P.text(slide, tokens.margin, 4.22, 8.4, 0.9, body, tokens, size=tokens.subtitle,
               color="#C9CED6", line_spacing=1.45)
    meta = page.get("meta") or []
    if meta:
        P.text(slide, tokens.margin, H - 1.05, 8.0, 0.4, [" · ".join(meta)], tokens,
               size=tokens.note, color="#9DB2CB")


def _r_section(slide, page, tokens, *, page_no, total, deck_title=None):
    P.rect(slide, 0, 0, W, H, fill=tokens.primary, shape=P.MSO_SHAPE.RECTANGLE)
    P.rect(slide, tokens.margin, H / 2 - 0.62, 0.075, 1.35, fill=tokens.accent,
           shape=P.MSO_SHAPE.RECTANGLE)
    P.text(slide, tokens.margin + 0.32, H / 2 - 0.72, 10.0, 0.68,
           page.get("title", ""), tokens, size=40, color="#F4F4F2", bold=True,
           line_spacing=1.05)
    P.text(slide, tokens.margin + 0.36, H / 2 + 0.02, 8.5, 0.4,
           page.get("page_job", ""), tokens, size=tokens.body, color="#9DB2CB")


def _r_statement(slide, page, tokens, *, page_no, total, deck_title=None):
    P.page_chrome(slide, tokens, title=page.get("title", ""),
                  kicker=page.get("kicker"), page_no=page_no, total=total,
                  deck_title=deck_title)
    b = _first(page, "bullets", "quote", "card")
    body = ""
    if b:
        body = b.get("text") or b.get("body") or "\n".join(b.get("items") or [])
    box_y = tokens.content_top + 0.6
    P.text(slide, tokens.content_x + 0.4, box_y, tokens.content_w - 0.8, 2.6, body,
           tokens, size=34, color=tokens.text, bold=True, line_spacing=1.35)
    src = (b or {}).get("source") if b else None
    if src:
        P.text(slide, tokens.content_x + 0.4, box_y + 2.7, tokens.content_w - 0.8, 0.3,
               f"— {src}", tokens, size=tokens.note, color=tokens.text_weak)
    _concl(slide, page, tokens)


def _r_cards(slide, page, tokens, *, page_no, total, deck_title=None):
    P.page_chrome(slide, tokens, title=page.get("title", ""),
                  kicker=page.get("kicker"), page_no=page_no, total=total,
                  deck_title=deck_title)
    top = tokens.content_top
    lead = _first(page, "lead")
    if lead:
        P.text(slide, tokens.content_x, top, tokens.content_w, 0.36,
               lead.get("text", ""), tokens, size=tokens.subtitle,
               color=tokens.text_weak)
        top += 0.52

    cards = _blocks(page, "card")
    bullets = _first(page, "bullets")
    has_concl = bool(_first(page, "concl"))
    bottom = tokens.content_bottom - (0.72 if has_concl else 0.0)

    if len(cards) == 1 and bullets:
        _card_block(slide, tokens, cards[0], tokens.content_x, top,
                    tokens.content_w * 0.62, bottom - top)
        P.text(slide, tokens.content_x + tokens.content_w * 0.66, top + 0.1,
               tokens.content_w * 0.34 - 0.1, bottom - top,
               [{"t": f"— {i}", "space_after": 5} for i in bullets.get("items", [])],
               tokens, size=tokens.body, color=tokens.text, line_spacing=1.45)
    elif cards:
        n = len(cards)
        cols = 2 if n == 2 else (3 if n <= 6 else 4)
        rows = (n + cols - 1) // cols
        gap = tokens.gap
        cw = (tokens.content_w - gap * (cols - 1)) / cols
        ch = (bottom - top - gap * (rows - 1)) / rows
        for i, c in enumerate(cards):
            r, col = divmod(i, cols)
            _card_block(slide, tokens, c, tokens.content_x + col * (cw + gap),
                        top + r * (ch + gap), cw, ch)
    elif bullets:
        P.text(slide, tokens.content_x, top, tokens.content_w, bottom - top,
               [{"t": f"— {i}", "space_after": 7} for i in bullets.get("items", [])],
               tokens, size=tokens.body + 1.5, color=tokens.text, line_spacing=1.5)
    _concl(slide, page, tokens)


def _card_block(slide, tokens, blk, x, y, w, h):
    P.card(slide, x, y, w, h, tokens,
           title=blk.get("title"), body=blk.get("body"),
           items=blk.get("items"), mark=bool(blk.get("mark")),
           index=blk.get("index"))


def _r_two_col(slide, page, tokens, *, page_no, total, deck_title=None):
    P.page_chrome(slide, tokens, title=page.get("title", ""),
                  kicker=page.get("kicker"), page_no=page_no, total=total,
                  deck_title=deck_title)
    top = tokens.content_top
    bottom = tokens.content_bottom - (0.72 if _first(page, "concl") else 0.0)
    cmp_blk = _first(page, "compare")
    gap = 0.36
    cw = (tokens.content_w - gap) / 2
    if cmp_blk:
        sides = [cmp_blk.get("left", {}), cmp_blk.get("right", {})]
    else:
        cs = _blocks(page, "card")[:2]
        sides = [{"title": c.get("title"), "items": c.get("items"),
                  "body": c.get("body")} for c in cs]
    for i, side in enumerate(sides):
        x = tokens.content_x + i * (cw + gap)
        P.rect(slide, x, top, cw, bottom - top, fill=tokens.card, line=tokens.line,
               radius=tokens.radius)
        P.rect(slide, x, top, cw, 0.06,
               fill=tokens.primary if i == 0 else tokens.accent,
               shape=P.MSO_SHAPE.RECTANGLE)
        P.text(slide, x + 0.28, top + 0.30, cw - 0.56, 0.4, side.get("title", ""),
               tokens, size=tokens.card_title, color=tokens.text, bold=True)
        cy = top + 0.84
        lines = []
        if side.get("body"):
            lines.append({"t": side["body"], "space_after": 6, "color": tokens.text_weak})
        for it in side.get("items", []):
            lines.append({"t": f"— {it}", "space_after": 5, "color": tokens.text})
        P.text(slide, x + 0.28, cy, cw - 0.56, bottom - cy - 0.2, lines, tokens,
               size=tokens.body, line_spacing=1.42)
    P.vline(slide, tokens.content_x + cw + gap / 2, top + 0.2, bottom - top - 0.4,
            tokens.line)
    _concl(slide, page, tokens)


def _r_steps(slide, page, tokens, *, page_no, total, deck_title=None):
    P.page_chrome(slide, tokens, title=page.get("title", ""),
                  kicker=page.get("kicker"), page_no=page_no, total=total,
                  deck_title=deck_title)
    top = tokens.content_top
    lead = _first(page, "lead")
    if lead:
        P.text(slide, tokens.content_x, top, tokens.content_w, 0.36, lead.get("text", ""),
               tokens, size=tokens.subtitle, color=tokens.text_weak)
        top += 0.5
    st = _first(page, "steps")
    has_concl = bool(_first(page, "concl"))
    bottom = tokens.content_bottom - (0.72 if has_concl else 0.0)
    items = (st or {}).get("items", [])
    if items:
        bh = min(bottom - top, max(1.9, bottom - top - (1.1 if len(items) <= 4 else 0.4)))
        P.steps_band(slide, tokens.content_x, top, tokens.content_w, bh, tokens,
                     items=items, numbered=bool(st.get("numbered", True)))
        top += bh + 0.24
    chart = _first(page, "chart")
    if chart and top < bottom - 0.8:
        P.bar_chart(slide, tokens.content_x, top, tokens.content_w, bottom - top,
                    tokens, data=chart.get("data", []), note=chart.get("note"))
    _concl(slide, page, tokens)


def _r_kpi_focus(slide, page, tokens, *, page_no, total, deck_title=None):
    P.page_chrome(slide, tokens, title=page.get("title", ""),
                  kicker=page.get("kicker"), page_no=page_no, total=total,
                  deck_title=deck_title)
    top = tokens.content_top
    kpis = _blocks(page, "kpi")
    has_concl = bool(_first(page, "concl"))
    bottom = tokens.content_bottom - (0.72 if has_concl else 0.0)
    lead = _first(page, "lead")
    if lead:
        P.text(slide, tokens.content_x, top, tokens.content_w * 0.8, 0.4,
               lead.get("text", ""), tokens, size=tokens.subtitle,
               color=tokens.text_weak)
        top += 0.56
    n = len(kpis)
    gap = tokens.gap
    cw = (tokens.content_w - gap * (n - 1)) / n
    ch = min(bottom - top, 2.7) if n > 1 else min(bottom - top, 3.0)
    for i, k in enumerate(kpis):
        P.kpi(slide, tokens.content_x + i * (cw + gap), top, cw, ch, tokens,
              value=k.get("value"), unit=k.get("unit"), label=k.get("label"),
              note=k.get("note"), source=k.get("source"), mark=bool(k.get("mark")))
    cy = top + ch + 0.26
    chart = _first(page, "chart")
    if chart and cy < bottom - 0.9:
        P.bar_chart(slide, tokens.content_x, cy, tokens.content_w, bottom - cy, tokens,
                    data=chart.get("data", []), note=chart.get("note"))
    elif _blocks(page, "card") and cy < bottom - 0.7:
        cs = _blocks(page, "card")[:3]
        cw2 = (tokens.content_w - gap * (len(cs) - 1)) / len(cs)
        for i, c in enumerate(cs):
            P.card(slide, tokens.content_x + i * (cw2 + gap), cy, cw2, bottom - cy,
                   tokens, title=c.get("title"), body=c.get("body"), items=c.get("items"))
    _concl(slide, page, tokens)


def _r_chart_concl(slide, page, tokens, *, page_no, total, deck_title=None):
    P.page_chrome(slide, tokens, title=page.get("title", ""),
                  kicker=page.get("kicker"), page_no=page_no, total=total,
                  deck_title=deck_title)
    top = tokens.content_top
    lead = _first(page, "lead")
    if lead:
        P.text(slide, tokens.content_x, top, tokens.content_w, 0.36, lead.get("text", ""),
               tokens, size=tokens.subtitle, color=tokens.text_weak)
        top += 0.5
    has_concl = bool(_first(page, "concl"))
    bottom = tokens.content_bottom - (0.72 if has_concl else 0.0)
    chart = _first(page, "chart")
    cards = _blocks(page, "card")
    if cards:
        cw = tokens.content_w * 0.44
        P.bar_chart(slide, tokens.content_x, top, tokens.content_w - cw - 0.32,
                    bottom - top, tokens, data=(chart or {}).get("data", []),
                    note=(chart or {}).get("note"))
        P.card(slide, tokens.content_x + tokens.content_w - cw, top, cw, bottom - top,
               tokens, title=cards[0].get("title"), body=cards[0].get("body"),
               items=cards[0].get("items"), mark=True)
    else:
        P.bar_chart(slide, tokens.content_x, top, tokens.content_w, bottom - top,
                    tokens, data=(chart or {}).get("data", []),
                    note=(chart or {}).get("note"))
    _concl(slide, page, tokens)


def _r_image_led(slide, page, tokens, *, page_no, total, deck_title=None):
    P.page_chrome(slide, tokens, title=page.get("title", ""),
                  kicker=page.get("kicker"), page_no=page_no, total=total,
                  deck_title=deck_title)
    top = tokens.content_top
    has_concl = bool(_first(page, "concl"))
    bottom = tokens.content_bottom - (0.72 if has_concl else 0.0)
    slot = _first(page, "image_slot")
    left_side = True
    if slot and slot.get("side") == "left":
        left_side = True
    body_blk = _first(page, "bullets", "card")
    iw = tokens.content_w * 0.42
    ih = min(bottom - top, iw * 9 / 16)
    ix = tokens.content_x if left_side else tokens.content_x + tokens.content_w - iw
    tx = (tokens.content_x + iw + 0.34) if left_side else tokens.content_x
    tw = tokens.content_w - iw - 0.34
    P.image_slot(slide, ix, top + 0.1, iw, ih, tokens,
                 label=(slot or {}).get("label", "配图位"),
                 hint=(slot or {}).get("hint"))
    if body_blk:
        lines = []
        if body_blk.get("body"):
            lines.append({"t": body_blk["body"], "space_after": 7,
                          "color": tokens.text_weak})
        for it in body_blk.get("items", []):
            lines.append({"t": f"— {it}", "space_after": 6, "color": tokens.text})
        P.text(slide, tx, top + 0.16, tw, bottom - top - 0.2, lines, tokens,
               size=tokens.body + 0.5, line_spacing=1.5)
    _concl(slide, page, tokens)


def _r_table(slide, page, tokens, *, page_no, total, deck_title=None):
    P.page_chrome(slide, tokens, title=page.get("title", ""),
                  kicker=page.get("kicker"), page_no=page_no, total=total,
                  deck_title=deck_title)
    top = tokens.content_top
    tb = _first(page, "table")
    has_concl = bool(_first(page, "concl"))
    bottom = tokens.content_bottom - (0.72 if has_concl else 0.0)
    if tb:
        rows = tb.get("rows", [])
        h = min(bottom - top, 0.42 * (len(rows) + 1) + 0.12)
        P.table(slide, tokens.content_x, top, tokens.content_w, h, tokens,
                header=tb.get("header", []), rows=rows,
                col_ratios=tb.get("col_ratios"))
        note = tb.get("note")
        if note:
            P.text(slide, tokens.content_x, top + h + 0.14, tokens.content_w, 0.4, note,
                   tokens, size=tokens.note, color=tokens.text_weak, line_spacing=1.3)
    _concl(slide, page, tokens)


_RENDERERS = {
    "cover": _r_cover,
    "section": _r_section,
    "statement": _r_statement,
    "cards": _r_cards,
    "two_col": _r_two_col,
    "steps": _r_steps,
    "kpi_focus": _r_kpi_focus,
    "chart_concl": _r_chart_concl,
    "image_led": _r_image_led,
    "table": _r_table,
}
