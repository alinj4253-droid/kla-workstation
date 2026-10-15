# -*- coding: utf-8 -*-
"""
PPT 生成引擎
参考 2024/2025 三一规划体例，输出规范可编辑的 PPTX
统一风格：深蓝科技感 + 卡片式布局
"""
import os, io
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn

from goal_engine import decompose_company_goals
from deviation_engine import deviation_report
from plan_engine import generate_company_plan, generate_department_plan

# ============ 配色方案 ============
COLORS = {
    "primary": RGBColor(0x1F, 0x4E, 0x79),      # 深蓝
    "accent": RGBColor(0x2E, 0x75, 0xB6),       # 科技蓝
    "highlight": RGBColor(0xED, 0x7D, 0x31),    # 橙黄强调
    "light_blue": RGBColor(0xD6, 0xE4, 0xF0),   # 浅蓝
    "bg": RGBColor(0xF5, 0xF7, 0xFA),           # 页面背景
    "card_bg": RGBColor(0xFF, 0xFF, 0xFF),      # 卡片白
    "dark_text": RGBColor(0x33, 0x33, 0x33),
    "gray_text": RGBColor(0x66, 0x66, 0x66),
    "white": RGBColor(0xFF, 0xFF, 0xFF),
    "green": RGBColor(0x2E, 0xCC, 0x71),
    "red": RGBColor(0xE7, 0x4C, 0x3C),
}

FONT = "微软雅黑"
SLIDE_W = Inches(13.333)
SLIDE_H = Inches(7.5)


# ============ 基础绘制能力 ============
def set_bg(slide, color=COLORS["bg"]):
    """设置页面背景"""
    bg = slide.background
    fill = bg.fill
    fill.solid()
    fill.fore_color.rgb = color


def add_rect(slide, left, top, width, height, fill_color=None, line_color=None, line_width=None):
    """添加矩形"""
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, left, top, width, height)
    if fill_color:
        shape.fill.solid()
        shape.fill.fore_color.rgb = fill_color
    else:
        shape.fill.background()
    if line_color:
        shape.line.color.rgb = line_color
        if line_width:
            shape.line.width = line_width
    else:
        shape.line.fill.background()
    return shape


def add_rounded_rect(slide, left, top, width, height, fill_color=None, line_color=None):
    """添加圆角矩形（卡片）"""
    shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, left, top, width, height)
    if fill_color:
        shape.fill.solid()
        shape.fill.fore_color.rgb = fill_color
    else:
        shape.fill.background()
    if line_color:
        shape.line.color.rgb = line_color
    else:
        shape.line.fill.background()
    # 圆角半径
    shape.adjustments[0] = 0.05
    return shape


def add_text(slide, left, top, width, height, text, font_size=14, bold=False,
             color=COLORS["dark_text"], align=PP_ALIGN.LEFT, font_name=FONT,
             anchor=MSO_ANCHOR.TOP, line_spacing=1.2):
    """添加文本框"""
    txBox = slide.shapes.add_textbox(left, top, width, height)
    tf = txBox.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    p = tf.paragraphs[0]
    p.alignment = align
    p.line_spacing = line_spacing
    run = p.add_run()
    run.text = text
    run.font.size = Pt(font_size)
    run.font.bold = bold
    run.font.color.rgb = color
    run.font.name = font_name
    return txBox


def add_multi_text(slide, left, top, width, height, lines, font_size=14,
                   color=COLORS["dark_text"], align=PP_ALIGN.LEFT, line_spacing=1.4):
    """添加多行文本"""
    txBox = slide.shapes.add_textbox(left, top, width, height)
    tf = txBox.text_frame
    tf.word_wrap = True
    for i, line in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.line_spacing = line_spacing
        run = p.add_run()
        run.text = line
        run.font.size = Pt(font_size)
        run.font.color.rgb = color
        run.font.name = FONT
    return txBox


def add_title_bar(slide, title, subtitle=None):
    """添加页面标题栏（左侧色块 + 标题）"""
    # 顶部装饰条
    add_rect(slide, Inches(0), Inches(0), SLIDE_W, Inches(0.08), COLORS["primary"])
    # 左侧色块
    add_rect(slide, Inches(0.5), Inches(0.35), Inches(0.12), Inches(0.5), COLORS["accent"])
    add_text(slide, Inches(0.75), Inches(0.3), Inches(11), Inches(0.6),
             title, font_size=28, bold=True, color=COLORS["primary"])
    if subtitle:
        add_text(slide, Inches(0.75), Inches(0.85), Inches(11), Inches(0.4),
                 subtitle, font_size=13, color=COLORS["gray_text"])


def add_footer(slide, page_no, total):
    """页脚"""
    add_text(slide, Inches(0.5), Inches(7.1), Inches(8), Inches(0.3),
             "鲲鹭科技 · 经营规划智能体", font_size=9, color=COLORS["gray_text"])
    add_text(slide, Inches(11.5), Inches(7.1), Inches(1.3), Inches(0.3),
             f"{page_no} / {total}", font_size=9, color=COLORS["gray_text"], align=PP_ALIGN.RIGHT)


def add_card(slide, left, top, width, height, title, content_lines, accent_color=COLORS["accent"]):
    """添加卡片：顶部色条 + 标题 + 内容"""
    add_rounded_rect(slide, left, top, width, height, COLORS["card_bg"], COLORS["light_blue"])
    add_rect(slide, left, top, width, Inches(0.06), accent_color)
    add_text(slide, left + Inches(0.2), top + Inches(0.15), width - Inches(0.4), Inches(0.4),
             title, font_size=15, bold=True, color=accent_color)
    add_multi_text(slide, left + Inches(0.2), top + Inches(0.6), width - Inches(0.4),
                   height - Inches(0.7), content_lines, font_size=12, color=COLORS["dark_text"])


# ============ 页面生成 ============
def slide_cover(prs, title, subtitle):
    """封面页"""
    slide = prs.slides.add_slide(prs.slide_layouts[6])  # 空白
    # 深色背景
    bg = slide.background
    bg.fill.solid()
    bg.fill.fore_color.rgb = COLORS["primary"]
    # 装饰色块
    add_rect(slide, Inches(0), Inches(3.0), SLIDE_W, Inches(0.04), COLORS["accent"])
    add_rounded_rect(slide, Inches(1), Inches(1.8), Inches(1.2), Inches(0.5), COLORS["accent"])
    add_text(slide, Inches(1), Inches(1.8), Inches(1.2), Inches(0.5),
             "KUNLU", font_size=16, bold=True, color=COLORS["white"],
             align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    # 主标题
    add_text(slide, Inches(1), Inches(3.4), Inches(11), Inches(1.2),
             title, font_size=44, bold=True, color=COLORS["white"])
    # 副标题
    add_text(slide, Inches(1), Inches(4.6), Inches(11), Inches(0.6),
             subtitle, font_size=20, color=COLORS["light_blue"])
    # 底部信息
    add_text(slide, Inches(1), Inches(6.5), Inches(11), Inches(0.4),
             "鲲鹭科技 · 经营规划智能体  |  2026", font_size=12, color=COLORS["light_blue"])


def slide_toc(prs, sections):
    """目录页"""
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    set_bg(slide)
    add_title_bar(slide, "目录", "Catalogue")
    # 两列目录卡片
    n = len(sections)
    cols = 2
    rows = (n + cols - 1) // cols
    card_w = Inches(5.8)
    card_h = Inches(1.3)
    start_x = Inches(0.7)
    start_y = Inches(1.6)
    gap_x = Inches(0.3)
    gap_y = Inches(0.25)
    for i, (num, name, desc) in enumerate(sections):
        col = i % cols
        row = i // cols
        left = start_x + col * (card_w + gap_x)
        top = start_y + row * (card_h + gap_y)
        add_rounded_rect(slide, left, top, card_w, card_h, COLORS["card_bg"], COLORS["light_blue"])
        # 序号圆
        num_shape = slide.shapes.add_shape(MSO_SHAPE.OVAL, left + Inches(0.2), top + Inches(0.35),
                                           Inches(0.6), Inches(0.6))
        num_shape.fill.solid()
        num_shape.fill.fore_color.rgb = COLORS["accent"]
        num_shape.line.fill.background()
        tf = num_shape.text_frame
        tf.vertical_anchor = MSO_ANCHOR.MIDDLE
        p = tf.paragraphs[0]
        p.alignment = PP_ALIGN.CENTER
        r = p.add_run()
        r.text = num
        r.font.size = Pt(20)
        r.font.bold = True
        r.font.color.rgb = COLORS["white"]
        r.font.name = FONT
        add_text(slide, left + Inches(1.0), top + Inches(0.25), card_w - Inches(1.2), Inches(0.4),
                 name, font_size=18, bold=True, color=COLORS["primary"])
        add_text(slide, left + Inches(1.0), top + Inches(0.7), card_w - Inches(1.2), Inches(0.5),
                 desc, font_size=11, color=COLORS["gray_text"])


def slide_company_overview(prs, plan, total_pages):
    """公司目标总览页"""
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    set_bg(slide)
    add_title_bar(slide, "公司整体目标", "2026 下半年")
    goals = plan["sections"][3]["content"]["company_goals"]["company_goals"]
    fin = plan["sections"][3]["content"]["financial_target"]
    # 财务目标卡片
    add_card(slide, Inches(0.5), Inches(1.5), Inches(12.3), Inches(1.0),
             "财务总目标", [f"营收 {fin['revenue_wan']} 万元  |  利润 {fin['profit_wan']} 万元"],
             accent_color=COLORS["highlight"])
    # 6 大目标卡片（3x2）
    card_w = Inches(3.95)
    card_h = Inches(2.3)
    start_x = Inches(0.5)
    start_y = Inches(2.7)
    gap = Inches(0.2)
    for i, g in enumerate(goals):
        col = i % 3
        row = i // 3
        left = start_x + col * (card_w + gap)
        top = start_y + row * (card_h + gap)
        depts = "、".join(g["owning_departments"])
        add_card(slide, left, top, card_w, card_h,
                 f"{g['no']}. {g['area']}",
                 [g["target"], f"", f"承接部门：{depts}"],
                 accent_color=COLORS["accent"])
    add_footer(slide, 3, total_pages)


def slide_goal_decompose(prs, tree, total_pages):
    """目标拆解详情页（分部门）"""
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    set_bg(slide)
    add_title_bar(slide, "目标拆解：公司 → 部门 → KPI", "承接关系与关键指标")
    goals = tree["company_goals"]
    # 左列：公司目标；右列：部门承接
    y = Inches(1.5)
    for g in goals:
        dept_text = " / ".join([f"{sg['department']}: {sg['decomposed_target'][:30]}" for sg in g["sub_goals"]])
        add_card(slide, Inches(0.5), y, Inches(12.3), Inches(0.85),
                 f"{g['no']}. {g['area']}",
                 [f"公司目标：{g['target']}"],
                 accent_color=COLORS["accent"])
        # 部门承接子卡
        sub_y = y + Inches(0.95)
        for sg in g["sub_goals"]:
            add_rounded_rect(slide, Inches(0.8), sub_y, Inches(12.0), Inches(0.55),
                             COLORS["light_blue"], None)
            add_text(slide, Inches(1.0), sub_y + Inches(0.1), Inches(2.5), Inches(0.4),
                     sg["department"], font_size=13, bold=True, color=COLORS["primary"])
            add_text(slide, Inches(3.5), sub_y + Inches(0.1), Inches(9.3), Inches(0.4),
                     sg["decomposed_target"], font_size=11, color=COLORS["dark_text"])
            sub_y += Inches(0.6)
        y = sub_y + Inches(0.1)
        if y > Inches(6.8):
            break
    add_footer(slide, 4, total_pages)


def slide_deviation(prs, dev, total_pages):
    """偏差分析页"""
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    set_bg(slide)
    add_title_bar(slide, "经营偏差分析", "根因与对策")
    deviations = dev["h1_deviation"]["deviations"]
    card_w = Inches(6.0)
    card_h = Inches(2.5)
    start_x = Inches(0.5)
    start_y = Inches(1.5)
    gap = Inches(0.25)
    for i, d in enumerate(deviations[:6]):
        col = i % 2
        row = i // 2
        left = start_x + col * (card_w + gap)
        top = start_y + row * (card_h + gap)
        root = "；".join(d["root_cause"][:2])
        if len(d["root_cause"]) > 2:
            root += " 等"
        add_card(slide, left, top, card_w, card_h,
                 f"{d['area']}：{d['issue']}",
                 [f"根因：{root}", f"", f"对策：{d['action']}"],
                 accent_color=COLORS["red"])
    add_footer(slide, 5, total_pages)


def slide_project_status(prs, dev, total_pages):
    """重点项目进度页"""
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    set_bg(slide)
    add_title_bar(slide, "重点项目进度跟踪", "金牌云检 / 线项目 / 鲲擎")
    projects = dev["project_deviation"]
    y = Inches(1.5)
    for p in projects:
        status_color = COLORS["green"] if "超前" in p["status"] or "按计划" in p["status"] else (
            COLORS["highlight"] if "进行" in p["status"] else COLORS["red"])
        add_rounded_rect(slide, Inches(0.5), y, Inches(12.3), Inches(1.1),
                         COLORS["card_bg"], COLORS["light_blue"])
        # 状态标签
        tag = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(0.7), y + Inches(0.15),
                                     Inches(1.5), Inches(0.35))
        tag.fill.solid()
        tag.fill.fore_color.rgb = status_color
        tag.line.fill.background()
        tf = tag.text_frame
        tf.vertical_anchor = MSO_ANCHOR.MIDDLE
        tag_p = tf.paragraphs[0]
        tag_p.alignment = PP_ALIGN.CENTER
        tag_r = tag_p.add_run()
        tag_r.text = p["status"]
        tag_r.font.size = Pt(11)
        tag_r.font.bold = True
        tag_r.font.color.rgb = COLORS["white"]
        tag_r.font.name = FONT
        add_text(slide, Inches(2.4), y + Inches(0.12), Inches(10), Inches(0.35),
                 p["project"], font_size=15, bold=True, color=COLORS["primary"])
        add_text(slide, Inches(0.7), y + Inches(0.5), Inches(5.8), Inches(0.5),
                 f"目标：{p['target']}", font_size=11, color=COLORS["gray_text"])
        add_text(slide, Inches(6.7), y + Inches(0.5), Inches(6.0), Inches(0.5),
                 f"实际：{p['actual']}", font_size=11, color=COLORS["gray_text"])
        y += Inches(1.2)
    add_footer(slide, 6, total_pages)


def slide_department_plan(prs, dp, total_pages, page_no):
    """部门规划页"""
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    set_bg(slide)
    add_title_bar(slide, f"{dp['department']} 规划", "2026 年承接目标与关键举措")
    # 承接目标
    goals = dp["承接的公司目标"]
    add_text(slide, Inches(0.5), Inches(1.4), Inches(6), Inches(0.4),
             "承接的公司目标", font_size=16, bold=True, color=COLORS["primary"])
    y = Inches(1.85)
    for g in goals:
        add_rounded_rect(slide, Inches(0.5), y, Inches(6.0), Inches(0.55),
                         COLORS["light_blue"], None)
        add_text(slide, Inches(0.7), y + Inches(0.1), Inches(1.8), Inches(0.4),
                 g["area"], font_size=12, bold=True, color=COLORS["primary"])
        add_text(slide, Inches(2.5), y + Inches(0.1), Inches(4.0), Inches(0.4),
                 g["dept_target"][:50], font_size=10, color=COLORS["dark_text"])
        y += Inches(0.6)
    # 关键举措
    add_text(slide, Inches(7.0), Inches(1.4), Inches(5.8), Inches(0.4),
             "关键举措", font_size=16, bold=True, color=COLORS["primary"])
    y2 = Inches(1.85)
    for a in dp["关键举措"]:
        add_rounded_rect(slide, Inches(7.0), y2, Inches(5.8), Inches(0.7),
                         COLORS["card_bg"], COLORS["accent"])
        add_text(slide, Inches(7.2), y2 + Inches(0.15), Inches(5.5), Inches(0.5),
                 f"• {a}", font_size=12, color=COLORS["dark_text"], anchor=MSO_ANCHOR.MIDDLE)
        y2 += Inches(0.75)
    # 风险对策
    add_text(slide, Inches(0.5), Inches(5.2), Inches(12.3), Inches(0.4),
             "风险与对策", font_size=16, bold=True, color=COLORS["primary"])
    y3 = Inches(5.65)
    for r in dp["风险与对策"]:
        add_rounded_rect(slide, Inches(0.5), y3, Inches(12.3), Inches(0.6),
                         COLORS["card_bg"], COLORS["red"])
        add_text(slide, Inches(0.7), y3 + Inches(0.1), Inches(11.9), Inches(0.4),
                 f"风险：{r['risk']}    →    对策：{r['mitigation']}",
                 font_size=11, color=COLORS["dark_text"], anchor=MSO_ANCHOR.MIDDLE)
        y3 += Inches(0.65)
    add_footer(slide, page_no, total_pages)


def slide_strategy(prs, plan, total_pages):
    """战略路径页"""
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    set_bg(slide)
    add_title_bar(slide, "战略路径", "定位与改革")
    content = plan["sections"][2]["content"]
    # 定位
    add_card(slide, Inches(0.5), Inches(1.5), Inches(12.3), Inches(1.3),
             "战略定位", [content["positioning"]], accent_color=COLORS["accent"])
    # 改革
    add_card(slide, Inches(0.5), Inches(3.0), Inches(6.0), Inches(1.8),
             "2026 经营改革", [content["reform"]], accent_color=COLORS["highlight"])
    # 策略
    add_card(slide, Inches(6.8), Inches(3.0), Inches(6.0), Inches(1.8),
             "下半年策略", [content["strategy"]], accent_color=COLORS["primary"])
    add_footer(slide, 7, total_pages)


def slide_market(prs, plan, total_pages):
    """市场洞察页"""
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    set_bg(slide)
    add_title_bar(slide, "市场洞察", "行业与产品")
    content = plan["sections"][1]["content"]
    add_card(slide, Inches(0.5), Inches(1.5), Inches(12.3), Inches(1.0),
             "行业方向", [content["industry"]], accent_color=COLORS["accent"])
    # 核心产品
    products = content["core_products"]
    add_text(slide, Inches(0.5), Inches(2.8), Inches(12), Inches(0.4),
             "核心产品矩阵", font_size=16, bold=True, color=COLORS["primary"])
    card_w = Inches(3.95)
    for i, p in enumerate(products):
        left = Inches(0.5) + i * (card_w + Inches(0.2))
        add_rounded_rect(slide, left, Inches(3.3), card_w, Inches(1.5),
                         COLORS["card_bg"], COLORS["accent"])
        add_text(slide, left + Inches(0.3), Inches(3.5), card_w - Inches(0.6), Inches(1.1),
                 p, font_size=14, bold=True, color=COLORS["accent"],
                 align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    add_card(slide, Inches(0.5), Inches(5.1), Inches(12.3), Inches(1.3),
             "市场聚焦", [content["market_focus"]], accent_color=COLORS["highlight"])
    add_footer(slide, 8, total_pages)


# ============ 对外生成函数 ============
def generate_company_ppt() -> bytes:
    """生成公司整体三一规划 PPT，返回 PPTX 字节"""
    prs = Presentation()
    prs.slide_width = SLIDE_W
    prs.slide_height = SLIDE_H

    plan = generate_company_plan(2026)
    tree = decompose_company_goals(2026, "H2")
    dev = deviation_report()

    # 封面 + 目录 + 总览 + 拆解 + 偏差 + 项目 + 战略 + 市场 = 8页
    total = 8
    slide_cover(prs, "鲲鹭科技 2026 年三一规划", "经营回顾 · 市场洞察 · 战略路径 · 三一规划")
    sections = [
        ("01", "经营回顾", "2026 H1 业绩与偏差"),
        ("02", "市场洞察", "行业与产品矩阵"),
        ("03", "战略路径", "定位与改革"),
        ("04", "三一规划", "公司目标与部门承接"),
    ]
    slide_toc(prs, sections)
    slide_market(prs, plan, total)
    slide_strategy(prs, plan, total)
    slide_company_overview(prs, plan, total)
    slide_goal_decompose(prs, tree, total)
    slide_deviation(prs, dev, total)
    slide_project_status(prs, dev, total)

    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue()


def generate_department_ppt(department: str) -> bytes:
    """生成部门规划 PPT，返回 PPTX 字节"""
    prs = Presentation()
    prs.slide_width = SLIDE_W
    prs.slide_height = SLIDE_H

    dp = generate_department_plan(department)
    total = 3
    slide_cover(prs, f"{dp['department']} 2026 年规划", "承接目标 · 关键举措 · 风险对策")
    slide_department_plan(prs, dp, total, 2)
    # 业绩数据页
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    set_bg(slide)
    add_title_bar(slide, f"{dp['department']} 业绩基线", "2026 年数据")
    import json
    data_str = json.dumps(dp["业绩基线"], ensure_ascii=False, indent=2)
    # 分页显示
    lines = data_str.split("\n")[:60]
    add_multi_text(slide, Inches(0.5), Inches(1.4), Inches(12.3), Inches(5.5),
                   lines, font_size=10, color=COLORS["dark_text"], line_spacing=1.1)
    add_footer(slide, 3, total)

    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue()
