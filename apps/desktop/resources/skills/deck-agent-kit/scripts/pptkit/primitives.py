# -*- coding: utf-8 -*-
"""绘制零件库：一个函数只画一种零件，几何全部由调用方（版式层）给定。

原则：
  · 文字是文字、形状是形状、图片是图片 —— 绝不压平
  · 中文字体必须同时设 latin + ea + cs，否则中文回退主题默认字体
  · 形状自带阴影一律关掉（默认阴影是"业余感"的主要来源）
  · 装饰克制：每个元素都要答得出"为什么在这"

平台中立：只依赖 python-pptx。
"""
from __future__ import annotations

from typing import Any, Sequence

from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Inches, Pt

from .tokens import DesignSystem

try:  # 虚线枚举在不同版本里名字不同
    from pptx.enum.dml import MSO_LINE_DASH_STYLE as DASH
except Exception:  # pragma: no cover
    from pptx.enum.dml import MSO_LINE as DASH  # type: ignore

#: 中文单行可容纳字数（近似）：宽度英寸 × 72 ÷ 字号
def chars_per_line(width_in: float, size_pt: float) -> int:
    return max(1, int(width_in * 72 / (size_pt * 1.02)))


def rgb(hexstr: str) -> RGBColor:
    return RGBColor.from_string(str(hexstr).lstrip("#").upper())


# --------------------------------------------------------------------- 文字
def set_run(run, *, size=None, color=None, bold=None, font=None, italic=None) -> None:
    """设置一个 run 的字体属性（含 CJK 的 ea/cs typeface）。"""
    f = run.font
    if size is not None:
        f.size = Pt(size)
    if color is not None:
        f.color.rgb = rgb(color)
    if bold is not None:
        f.bold = bold
    if italic is not None:
        f.italic = italic
    if font:
        f.name = font                       # latin
        rPr = run._r.get_or_add_rPr()
        for tag in ("a:ea", "a:cs"):        # 东亚 + 复杂文种
            el = rPr.find(qn(tag))
            if el is None:
                el = rPr.makeelement(qn(tag), {})
                rPr.insert_element_before(
                    el, "a:sym", "a:hlinkClick", "a:hlinkMouseOver", "a:rtl", "a:extLst"
                )
            el.set("typeface", font)


def text(slide, x, y, w, h, runs, tokens: DesignSystem, *,
         size=None, color=None, bold=False, align=PP_ALIGN.LEFT,
         anchor=MSO_ANCHOR.TOP, line_spacing=1.3, space_after=0.0, font=None):
    """画一个文本框。

    ``runs`` 可为：``str`` / ``list[str]``（每项一段）/ ``list[dict]``
    （``{"t": 文本, "size":, "color":, "bold":, "space_before":}``）。
    """
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = box.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = anchor

    size = size if size is not None else tokens.body
    color = color if color is not None else tokens.text
    font = font or tokens.font_body

    if isinstance(runs, str):
        paras: list[Any] = [runs]
    else:
        paras = list(runs or [])
    if not paras:
        paras = [""]

    for i, raw in enumerate(paras):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.line_spacing = line_spacing
        spec = raw if isinstance(raw, dict) else {"t": raw}
        p.space_after = Pt(spec.get("space_after", space_after))
        if "space_before" in spec:
            p.space_before = Pt(spec["space_before"])
        run = p.add_run()
        run.text = str(spec.get("t", ""))
        set_run(run,
                size=spec.get("size", size),
                color=spec.get("color", color),
                bold=spec.get("bold", bold),
                font=spec.get("font", font))
    return box


# --------------------------------------------------------------------- 形状
def rect(slide, x, y, w, h, *, fill=None, line=None, radius=None, dash=False,
         shape=MSO_SHAPE.ROUNDED_RECTANGLE, line_w=0.75):
    """画一个矩形/圆角矩形。``fill``/``line`` 为 hex 或 None。"""
    if radius is None:
        shape = MSO_SHAPE.RECTANGLE if shape is MSO_SHAPE.ROUNDED_RECTANGLE else shape
    sh = slide.shapes.add_shape(shape, Inches(x), Inches(y), Inches(w), Inches(h))
    if shape is MSO_SHAPE.ROUNDED_RECTANGLE and radius is not None:
        try:
            sh.adjustments[0] = max(0.0, min(0.5, radius / min(w, h)))
        except Exception:
            pass
    if fill:
        sh.fill.solid()
        sh.fill.fore_color.rgb = rgb(fill)
    else:
        sh.fill.background()
    if line:
        sh.line.fill.solid()
        sh.line.fill.fore_color.rgb = rgb(line)
        sh.line.width = Pt(line_w)
        if dash:
            sh.line.dash_style = DASH.DASH
    else:
        sh.line.fill.background()
    sh.shadow.inherit = False
    sh.text_frame.word_wrap = True
    return sh


def hline(slide, x, y, w, color, width_pt=0.75):
    """一条细横线（用矩形画，比 connector 稳）。"""
    return rect(slide, x, y, w, 0.012, fill=color, shape=MSO_SHAPE.RECTANGLE)


def vline(slide, x, y, h, color, width_pt=0.75):
    return rect(slide, x, y, 0.012, h, fill=color, shape=MSO_SHAPE.RECTANGLE)


def arrow_right(slide, x, y, size, color):
    """步骤带之间的方向箭头（右向）。

    ⚠ 坑：ISOSCELES_TRIANGLE 默认尖朝上，必须 rotation=90 才是右向箭头；
    曾因漏旋转导致 PPT 端只有一个向上的小三角（HTML 端却是右箭头）——两端不一致的经典来源。
    """
    s = min(size, 0.26)
    sh = rect(slide, x, y, s, s, fill=color, shape=MSO_SHAPE.ISOSCELES_TRIANGLE)
    sh.rotation = 90
    return sh


# --------------------------------------------------------------------- 零件
def chip(slide, x, y, label, tokens: DesignSystem, *, fill=None, color=None):
    """胶囊标签（章节锚点 / 分区标识）。"""
    fill = fill or tokens.primary
    color = color or "#F4F4F2"
    w = 0.17 + len(label) * tokens.chip / 72 * 1.25
    h = 0.30
    rect(slide, x, y, w, h, fill=fill, radius=0.15, shape=MSO_SHAPE.ROUNDED_RECTANGLE)
    text(slide, x, y + 0.055, w, h - 0.11, label, tokens, size=tokens.chip,
         color=color, bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE,
         line_spacing=1.0)
    return w


def page_chrome(slide, tokens: DesignSystem, *, title, kicker=None,
                page_no=None, total=None, deck_title=None):
    """页头 + 页脚：章节锚点 / 标题 / 细线 / 右下页码。"""
    y = 0.42
    if kicker:
        chip(slide, tokens.content_x, y, kicker, tokens, fill=tokens.accent)
        y += 0.46
    text(slide, tokens.content_x, y, tokens.content_w - 1.6, 0.52, title, tokens,
         size=tokens.title, color=tokens.text, bold=True, line_spacing=1.05)
    hline(slide, tokens.content_x, 1.42, tokens.content_w, tokens.line)
    if deck_title:
        text(slide, tokens.content_x, 1.44, tokens.content_w - 1.6, 0.22, deck_title,
             tokens, size=tokens.note, color=tokens.text_weak)
    if page_no is not None:
        label = f"{page_no:02d}" + (f" / {total:02d}" if total else "")
        text(slide, tokens.content_x + tokens.content_w - 1.5, 6.94, 1.5, 0.24,
             label, tokens, size=tokens.page_no, color=tokens.text_weak,
             align=PP_ALIGN.RIGHT)


def card(slide, x, y, w, h, tokens: DesignSystem, *, title=None, body=None,
         items=None, mark=False, index=None, pad=0.26):
    """圆角卡片：标题 + 正文 + 条目。``mark=True`` 时用主色骨架条。"""
    rect(slide, x, y, w, h, fill=tokens.card, line=tokens.line, radius=tokens.radius)
    if mark:
        rect(slide, x, y, 0.055, h, fill=tokens.accent, shape=MSO_SHAPE.RECTANGLE)
    cy = y + pad * 0.72
    if index or title:
        head = f"{index}  {title}" if index else title
        text(slide, x + pad, cy, w - 2 * pad, 0.32, head, tokens,
             size=tokens.card_title, color=tokens.text, bold=True, line_spacing=1.1)
        cy += 0.40
    if body:
        n = 1
        box = text(slide, x + pad, cy, w - 2 * pad, h - (cy - y) - pad * 0.6, body,
                   tokens, size=tokens.body, color=tokens.text_weak, line_spacing=1.42)
        cy += 0.22 * n + 0.30 * (1 + body.count("\n"))
    if items:
        lines = []
        for it in items:
            lines.append({"t": f"— {it}", "space_after": 3.5, "color": tokens.text})
        text(slide, x + pad, cy, w - 2 * pad, h - (cy - y) - pad * 0.5, lines, tokens,
             size=tokens.body, line_spacing=1.38)
    return


def kpi(slide, x, y, w, h, tokens: DesignSystem, *, value, unit=None, label=None,
        note=None, source=None, mark=False):
    """英雄数字卡：大数字只代表一个数，字号落差拉满。"""
    rect(slide, x, y, w, h, fill=tokens.card, line=tokens.line, radius=tokens.radius)
    if mark:
        rect(slide, x, y, w, 0.06, fill=tokens.accent, shape=MSO_SHAPE.RECTANGLE)
    size = min(tokens.hero, w * 72 / max(2.2, len(str(value)) * 0.62))
    runs = [{"t": str(value), "size": size, "bold": True, "color": tokens.accent}]
    if unit:
        runs.append({"t": unit, "size": tokens.subtitle, "color": tokens.text})
    text(slide, x + 0.24, y + 0.28, w - 0.48, h * 0.5, runs, tokens,
         align=PP_ALIGN.LEFT, line_spacing=1.0)
    cy = y + 0.28 + size / 72 * 1.15
    if label:
        text(slide, x + 0.24, cy, w - 0.48, 0.6, label, tokens,
             size=tokens.body, color=tokens.text, bold=True, line_spacing=1.25)
    tail = [t for t in (note, f"来源：{source}" if source else None) if t]
    if tail:
        text(slide, x + 0.24, y + h - 0.68, w - 0.48, 0.5, tail, tokens,
             size=tokens.note, color=tokens.text_weak, line_spacing=1.25)


def bar_chart(slide, x, y, w, h, tokens: DesignSystem, *, data, note=None,
              value_fmt="{:.0f}"):
    """柱状图（形状绘制，原生可编辑）。``data=[{label, value, hot?}]``。"""
    base_y = y + h - 0.52
    plot_h = h - 0.90
    vals = [float(d.get("value", 0)) for d in data] or [1.0]
    vmax = max(vals) or 1.0
    n = len(data)
    slot = w / n
    bw = min(slot * 0.46, 0.72)
    for i, d in enumerate(data):
        v = float(d.get("value", 0))
        bh = max(0.06, plot_h * (v / vmax))
        cx = x + slot * i + (slot - bw) / 2
        col = tokens.accent if d.get("hot") else tokens.neutrals[2]
        rect(slide, cx, base_y - bh, bw, bh, fill=col,
             shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.06)
        text(slide, x + slot * i, base_y - bh - 0.30, slot, 0.26,
             value_fmt.format(v), tokens, size=tokens.note,
             color=tokens.text, bold=True, align=PP_ALIGN.CENTER, line_spacing=1.0)
        text(slide, x + slot * i, base_y + 0.06, slot, 0.34, str(d.get("label", "")),
             tokens, size=tokens.note, color=tokens.text_weak,
             align=PP_ALIGN.CENTER, line_spacing=1.15)
    hline(slide, x, base_y, w, tokens.neutrals[3])
    if note:
        text(slide, x, y + h - 0.30, w, 0.26, note, tokens,
             size=tokens.note, color=tokens.text_weak)


def steps_band(slide, x, y, w, h, tokens: DesignSystem, *, items, numbered=True):
    """横向流程步骤带（图形化的流程，不允许用文字卡横排代替）。"""
    n = max(1, len(items))
    arrow_w = 0.20
    gap = 0.12
    cw = (w - (n - 1) * (arrow_w + gap * 2)) / n
    for i, it in enumerate(items):
        title = it.get("title", "") if isinstance(it, dict) else str(it)
        body = it.get("body", "") if isinstance(it, dict) else None
        cx = x + i * (cw + arrow_w + gap * 2)
        rect(slide, cx, y, cw, h, fill=tokens.card, line=tokens.line,
             radius=tokens.radius)
        rect(slide, cx, y, cw, 0.05, fill=tokens.accent if i == 0 else tokens.primary,
             shape=MSO_SHAPE.RECTANGLE)
        cy = y + 0.22
        if numbered:
            text(slide, cx + 0.18, cy, 0.5, 0.26, f"{i + 1:02d}", tokens,
                 size=tokens.body, color=tokens.accent, bold=True, line_spacing=1.0)
            cy += 0.30
        text(slide, cx + 0.18, cy, cw - 0.36, 0.5, title, tokens,
             size=tokens.card_title, color=tokens.text, bold=True, line_spacing=1.15)
        if body:
            text(slide, cx + 0.18, cy + 0.48, cw - 0.36, h - (cy - y) - 0.62, body,
                 tokens, size=tokens.body, color=tokens.text_weak, line_spacing=1.38)
        if i < n - 1:
            ax = cx + cw + gap
            arrow_right(slide, ax, y + h / 2 - 0.10, 0.20, tokens.neutrals[2])


def image_slot(slide, x, y, w, h, tokens: DesignSystem, *, label="配图位",
               hint=None):
    """虚线配图位（无真实素材时的兜底，尺寸必须是真实图片比例）。"""
    rect(slide, x, y, w, h, fill=None, line=tokens.neutrals[2], dash=True,
         radius=tokens.radius)
    rect(slide, x + w / 2 - 0.16, y + h / 2 - 0.34, 0.32, 0.32, fill=tokens.neutrals[1],
         shape=MSO_SHAPE.ISOSCELES_TRIANGLE)
    runs = [{"t": label, "bold": True, "color": tokens.text_weak}]
    if hint:
        runs.append({"t": f"建议内容：{hint}", "size": tokens.note,
                     "color": tokens.text_weak})
    text(slide, x + 0.2, y + h / 2 + 0.06, w - 0.4, h / 2 - 0.2, runs, tokens,
         size=tokens.body, align=PP_ALIGN.CENTER, line_spacing=1.3)


def concl_bar(slide, x, y, w, tokens: DesignSystem, *, text_):
    """全宽结论条（深色骨架元素，签名件，换肤时要保留）。"""
    h = 0.56
    rect(slide, x, y, w, h, fill=tokens.primary, radius=0.06,
         shape=MSO_SHAPE.ROUNDED_RECTANGLE)
    text(slide, x + 0.30, y + 0.10, w - 0.6, h - 0.2, text_, tokens,
         size=tokens.body + 0.5, color="#F4F4F2", bold=True,
         anchor=MSO_ANCHOR.MIDDLE, line_spacing=1.1)
    return h


def matrix(slide, x, y, w, h, tokens: DesignSystem, *, rows, cols, dots):
    """覆盖矩阵（行=玩家，列=环节，实心/空心点）。"""
    left = 2.3
    col_w = (w - left - 0.3) / max(1, len(cols))
    row_h = (h - 0.5) / max(1, len(rows))
    for j, c in enumerate(cols):
        text(slide, x + left + j * col_w, y, col_w, 0.34, c, tokens,
             size=tokens.note, color=tokens.text, bold=True,
             align=PP_ALIGN.CENTER, line_spacing=1.1)
    for i, r in enumerate(rows):
        ry = y + 0.44 + i * row_h
        text(slide, x + 0.06, ry, left - 0.16, row_h, r, tokens,
             size=tokens.body, color=tokens.text, anchor=MSO_ANCHOR.MIDDLE,
             line_spacing=1.15)
        hline(slide, x, ry + row_h - 0.03, w, tokens.line)
        for j in range(len(cols)):
            cx = x + left + j * col_w + col_w / 2
            filled = any(d.get("r") == i and d.get("c") == j and d.get("filled")
                         for d in dots)
            rect(slide, cx - 0.075, ry + row_h / 2 - 0.075, 0.15, 0.15,
                 fill=tokens.accent if filled else None,
                 line=None if filled else tokens.neutrals[2],
                 shape=MSO_SHAPE.OVAL)
    out = []
    return out


def table(slide, x, y, w, h, tokens: DesignSystem, *, header, rows, col_ratios=None):
    """干净表格（清掉 Office 默认主题样式再自设底色）。"""
    nr, nc = len(rows) + 1, len(header)
    gf = slide.shapes.add_table(nr, nc, Inches(x), Inches(y), Inches(w), Inches(h))
    tbl = gf.table
    # 清默认表样式
    tblPr = tbl._tbl.find(qn("a:tblPr"))
    if tblPr is not None:
        for el in tblPr.findall(qn("a:tableStyleId")):
            tblPr.remove(el)
        tblPr.set("firstRow", "0")
        tblPr.set("bandRow", "0")
    if col_ratios:
        total = float(sum(col_ratios))
        for j, r in enumerate(col_ratios):
            tbl.columns[j].width = Inches(w * r / total)
    for j, txt in enumerate(header):
        cell = tbl.cell(0, j)
        cell.fill.solid()
        cell.fill.fore_color.rgb = rgb(tokens.primary)
        cell.margin_left = cell.margin_right = Inches(0.08)
        tf = cell.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        p.line_spacing = 1.15
        run = p.add_run()
        run.text = str(txt)
        set_run(run, size=tokens.note, color="#F4F4F2", bold=True,
                font=tokens.font_body)
    for i, row in enumerate(rows):
        for j, txt in enumerate(row):
            cell = tbl.cell(i + 1, j)
            cell.fill.solid()
            cell.fill.fore_color.rgb = rgb(tokens.card if i % 2 == 0 else tokens.bg)
            cell.margin_left = cell.margin_right = Inches(0.08)
            tf = cell.text_frame
            tf.word_wrap = True
            p = tf.paragraphs[0]
            p.line_spacing = 1.2
            run = p.add_run()
            run.text = str(txt)
            set_run(run, size=tokens.note, color=tokens.text, font=tokens.font_body)
    return tbl
