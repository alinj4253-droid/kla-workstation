#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
html_report.py — 自包含 HTML 分析报告生成器

把结构化结果（JSON）渲染成一份可独立分发的 HTML 报告：
    · matplotlib 图表渲染为 PNG 后 base64 内嵌，单文件无外部依赖
    · 涨红跌绿（中国股市/财务习惯），符合国内业务语境
    · 明暗双主题，明暗由 --theme 指定，配色变量集中在 THEMES
    · KPI 卡片 / 图表 / 表格 / 提示块 四类构件

输入 JSON 结构:
{
  "title": "报告标题",
  "subtitle": "副标题（数据范围、规模等）",
  "tags": ["标签1", "标签2"],
  "theme": "light",
  "kpis": [
    {"label": "总销售额", "value": "¥2,372,265.58", "sub": "含退款冲抵", "highlight": true}
  ],
  "sections": [
    {
      "heading": "月度销售趋势",
      "lead": "本节说明文字",
      "charts": [
        {"type": "line", "title": "月度销售额",
         "categories": ["2025-01", "2025-02"],
         "series": [{"name": "销售额", "data": [118307.69, 92981.86]}]},
        {"type": "bar", "palette": "updown", "title": "环比增减",
         "categories": ["2025-02"], "series": [{"name": "环比", "data": [-25325.83]}]}
      ],
      "tables": [
        {"title": "明细", "headers": ["月份", "销售额"],
         "rows": [["2025-01", "118,307.69"]], "align_right": [1]}
      ],
      "notes": [
        {"level": "ok", "html": "校验通过：..."},
        {"level": "warn", "html": "注意：..."}
      ]
    }
  ],
  "footer": "页脚文字"
}

用法:
    python html_report.py result.json --out report.html --theme light

依赖: matplotlib>=3.5
"""

import argparse
import base64
import io
import json
import sys
from pathlib import Path

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib import rcParams
except ImportError:
    sys.exit("缺少依赖: matplotlib。请执行  pip install matplotlib")

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

# 中文字体：不设置会导致中文与负号显示为方块
rcParams["font.sans-serif"] = ["Microsoft YaHei", "PingFang SC", "SimHei",
                               "Noto Sans CJK SC", "WenQuanYi Zen Hei", "sans-serif"]
rcParams["axes.unicode_minus"] = False
rcParams["figure.dpi"] = 150

# ---------------------------------------------------------------- 主题
THEMES = {
    "light": {
        "bg": "#F4F6FA", "card": "#FFFFFF", "ink": "#1B2430", "sub": "#5B6879",
        "line": "#E3E8EF", "grid": "#E9EEF5",
        "up": "#D93B3B", "down": "#1E9E5A",          # 涨红跌绿
        "accent": "#2F6BFF", "accent2": "#7A5AF8", "accent3": "#12B76A",
        "note_info": ("#F1F6FF", "#C8DAFB", "#2B4C8C"),
        "note_warn": ("#FFF6E5", "#F0DBA8", "#8A6200"),
        "note_ok":   ("#EAF7EF", "#B9E3CB", "#146B41"),
        "note_risk": ("#FDECEC", "#F5C6C6", "#8C2F26"),
    },
    "dark": {
        "bg": "#0F1218", "card": "#181D26", "ink": "#E8EDF5", "sub": "#98A2B3",
        "line": "#2A303C", "grid": "#232936",
        "up": "#FF5C5C", "down": "#22C55E",
        "accent": "#4C8DFF", "accent2": "#9B7BFF", "accent3": "#2DD4A7",
        "note_info": ("#16223A", "#2A4A7A", "#A8C6F5"),
        "note_warn": ("#33280F", "#5C4A1A", "#F0D28A"),
        "note_ok":   ("#10291C", "#1E4D33", "#8FE0B4"),
        "note_risk": ("#2E1516", "#5C2A2A", "#F5A8A8"),
    },
}


def b64png(fig) -> str:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", facecolor=fig.get_facecolor())
    plt.close(fig)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


# ---------------------------------------------------------------- 图表
def make_chart(spec: dict, th: dict) -> str:
    ctype = spec.get("type", "line")
    cats = spec.get("categories", [])
    series = spec.get("series", [])
    title = spec.get("title", "")
    palette = spec.get("palette", "auto")
    ylabel = spec.get("ylabel", "")
    fmt = spec.get("format", "")
    w = spec.get("width", 11)
    h = spec.get("height", 4.2)

    fig, ax = plt.subplots(figsize=(w, h))
    fig.patch.set_facecolor(th["card"])
    ax.set_facecolor(th["card"])
    ink, sub, grid = th["ink"], th["sub"], th["grid"]

    if ctype == "line":
        for i, s in enumerate(series):
            color = [th["accent"], th["accent2"], th["accent3"]][i % 3]
            ax.plot(cats, s["data"], color=color, lw=2.2, marker="o", ms=4.5,
                    label=s.get("name", ""), zorder=3)
        if len(series) > 1:
            ax.legend(fontsize=9, frameon=False, labelcolor=sub)

    elif ctype == "hbar":
        vals = series[0]["data"] if series else []
        y = range(len(cats))[::-1]
        y = list(y)
        colors = [th["accent"], th["accent2"], th["accent3"], th["accent"]][:len(cats)]
        ax.barh(y, vals, color=colors, height=0.62, zorder=3)
        for yi, v in zip(y, vals):
            ax.text(v, yi, f"  {v:,.0f}", va="center", fontsize=9.5,
                    color=ink, fontweight="bold")
        ax.set_yticks(y)
        ax.set_yticklabels(cats, fontsize=10, color=ink)
        mx = max(vals) if vals else 1
        ax.set_xlim(0, mx * 1.22)

    else:  # bar
        vals = series[0]["data"] if series else []
        if palette == "updown":
            colors = [th["up"] if v >= 0 else th["down"] for v in vals]
        else:
            colors = [th["accent"]] * len(vals)
        ax.bar(cats, vals, color=colors, width=0.62, zorder=3)
        ax.axhline(0, color=sub, lw=1)
        for x, v in zip(cats, vals):
            ax.annotate(f"{v:,.0f}", (x, v), textcoords="offset points",
                        xytext=(0, 5 if v >= 0 else -14), ha="center",
                        fontsize=8.5, color=ink, fontweight="bold")

    ax.set_title(title, fontsize=13, color=ink, pad=12, fontweight="bold")
    if ylabel:
        ax.set_ylabel(ylabel, fontsize=10, color=sub)
    ax.tick_params(axis="x", rotation=spec.get("rotation", 0),
                   labelsize=8.5, colors=sub)
    ax.tick_params(axis="y", labelsize=9, colors=sub)
    ax.grid(axis="y" if ctype != "hbar" else "x", color=grid, lw=0.8, zorder=0)
    for s in ["top", "right"]:
        ax.spines[s].set_visible(False)
    for s in ["left", "bottom"]:
        ax.spines[s].set_color(grid)
    if fmt == "k":
        ax.yaxis.set_major_formatter(lambda x, p: f"{x/1000:.0f}k")
    return b64png(fig)


# ---------------------------------------------------------------- HTML
def render(data: dict, theme: str) -> str:
    th = THEMES.get(theme, THEMES["light"])
    t = data.get("title", "分析报告")
    sub = data.get("subtitle", "")
    tags = data.get("tags", [])
    kpis = data.get("kpis", [])
    sections = data.get("sections", [])
    footer = data.get("footer", "")

    def esc(s):
        return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))

    # KPI 卡片
    kpi_html = ""
    if kpis:
        kpi_html = '<div class="grid g4">' + "".join(
            f'<div class="metric{" hl" if k.get("highlight") else ""}">'
            f'<div class="ml">{esc(k.get("label",""))}</div>'
            f'<div class="mv">{esc(k.get("value",""))}</div>'
            f'<div class="ms">{esc(k.get("sub",""))}</div></div>'
            for k in kpis) + "</div>"

    # 章节
    sec_html = []
    for i, s in enumerate(sections, 1):
        block = [f'<h2><span class="no">{i:02d}</span>{esc(s.get("heading",""))}</h2>']
        if s.get("lead"):
            block.append(f'<p class="lead">{esc(s["lead"])}</p>')

        for k in s.get("kpis", []):
            block.append(f'<div class="grid g3"><div class="metric{" hl" if k.get("highlight") else ""}">'
                         f'<div class="ml">{esc(k.get("label",""))}</div>'
                         f'<div class="mv">{esc(k.get("value",""))}</div>'
                         f'<div class="ms">{esc(k.get("sub",""))}</div></div></div>')

        for ch in s.get("charts", []):
            img = make_chart(ch, th)
            block.append(f'<div class="panel"><img src="{img}" alt="{esc(ch.get("title",""))}"></div>')

        for tb in s.get("tables", []):
            ar = set(tb.get("align_right", []))
            # 不使用 f-string 内嵌引号/转义，兼容 Python 3.8+
            sty_right = ' style="text-align:right"'
            head = "".join(
                "<th" + (sty_right if j in ar else "") + ">" + esc(h) + "</th>"
                for j, h in enumerate(tb.get("headers", [])))
            body = ""
            raw = tb.get("raw_html", False)
            for row in tb.get("rows", []):
                tds = ""
                for j, c in enumerate(row):
                    if j in ar:
                        tds += '<td class="num">' + esc(c) + "</td>"
                    else:
                        tds += "<td>" + (c if raw else esc(c)) + "</td>"
                body += "<tr>" + tds + "</tr>"
            if tb.get("title"):
                block.append('<h3 class="sub-h">' + esc(tb["title"]) + "</h3>")
            block.append("<table><thead><tr>" + head + "</tr></thead><tbody>"
                         + body + "</tbody></table>")

        for n in s.get("notes", []):
            bg, bd, fg = th.get(f"note_{n.get('level','info')}", th["note_info"])
            block.append(f'<div class="notes" style="background:{bg};border-color:{bd};color:{fg}">'
                         f'{n.get("html","")}</div>')
        sec_html.append("\n".join(block))

    tag_html = "".join(f"<span>{esc(x)}</span>" for x in tags)

    # 预先算好条件片段，避免在 f-string 内嵌套同类引号（兼容 Python 3.8+）
    sub_block = ("<p>" + esc(sub) + "</p>") if sub else ""
    tags_block = ('<div class="tags">' + tag_html + "</div>") if tags else ""
    foot_block = ('<div class="foot">' + esc(footer) + "</div>") if footer else ""
    sections_block = "\n".join(sec_html)

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{esc(t)}</title>
<style>
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:{th['bg']}; color:{th['ink']};
         font-family:"Microsoft YaHei","PingFang SC","Segoe UI",system-ui,sans-serif;
         font-size:14px; line-height:1.7; -webkit-font-smoothing:antialiased; }}
  .wrap {{ max-width:1140px; margin:0 auto; padding:34px 26px 70px; }}
  .hero {{ background:linear-gradient(135deg,{th['accent']} 0%,{th['accent2']} 100%);
          border-radius:18px; padding:30px 34px; color:#fff;
          box-shadow:0 10px 30px rgba(47,107,255,.22); }}
  .hero h1 {{ margin:0 0 6px; font-size:25px; letter-spacing:.4px; }}
  .hero p {{ margin:0; opacity:.93; font-size:13.5px; }}
  .hero .tags {{ margin-top:14px; display:flex; gap:8px; flex-wrap:wrap; }}
  .hero .tags span {{ background:rgba(255,255,255,.2); border:1px solid rgba(255,255,255,.3);
                     border-radius:20px; padding:3px 12px; font-size:12px; }}
  h2 {{ font-size:18px; margin:42px 0 6px; padding-left:12px;
       border-left:4px solid {th['accent']}; color:{th['ink']}; }}
  h2 .no {{ color:{th['accent']}; font-weight:800; margin-right:6px; }}
  h3.sub-h {{ font-size:15px; margin:22px 0 8px; color:{th['ink']}; }}
  .lead {{ color:{th['sub']}; font-size:13px; margin:0 0 18px 16px; }}
  .grid {{ display:grid; gap:14px; }}
  .g4 {{ grid-template-columns:repeat(4,1fr); }}
  .g3 {{ grid-template-columns:repeat(3,1fr); }}
  .metric {{ background:{th['card']}; border:1px solid {th['line']}; border-radius:14px;
            padding:18px 18px 16px; box-shadow:0 2px 10px rgba(20,40,80,.04); }}
  .metric.hl {{ border-color:{th['accent']}; }}
  .ml {{ font-size:12.5px; color:{th['sub']}; }}
  .mv {{ font-size:25px; font-weight:800; margin:6px 0 2px;
        font-variant-numeric:tabular-nums; }}
  .ms {{ font-size:11.5px; color:{th['sub']}; opacity:.85; }}
  .panel {{ background:{th['card']}; border:1px solid {th['line']}; border-radius:14px;
           padding:6px 4px 10px; margin-top:14px; box-shadow:0 2px 10px rgba(20,40,80,.04); }}
  .panel img {{ width:100%; display:block; }}
  table {{ width:100%; border-collapse:collapse; background:{th['card']};
          border-radius:14px; overflow:hidden; border:1px solid {th['line']};
          font-size:13px; margin-top:12px; }}
  thead th {{ background:{th['bg']}; text-align:left; padding:11px 14px;
             font-weight:700; font-size:12.5px; white-space:nowrap; color:{th['ink']}; }}
  tbody td {{ padding:10px 14px; border-top:1px solid {th['line']}; vertical-align:top; }}
  .num {{ text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }}
  .notes {{ border:1px solid; border-radius:12px; padding:14px 18px; font-size:13px;
           margin-top:14px; }}
  .foot {{ margin-top:46px; padding-top:18px; border-top:1px solid {th['line']};
          color:{th['sub']}; font-size:12px; text-align:center; }}
  @media (max-width:860px) {{
    .g4,.g3 {{ grid-template-columns:repeat(2,1fr); }}
  }}
</style>
</head>
<body>
<div class="wrap">
  <div class="hero">
    <h1>{esc(t)}</h1>
    {sub_block}
    {tags_block}
  </div>
  {kpi_html}
  {sections_block}
  {foot_block}
</div>
</body>
</html>"""


def main():
    ap = argparse.ArgumentParser(description="自包含 HTML 分析报告生成器")
    ap.add_argument("json", help="输入 JSON 路径")
    ap.add_argument("--out", default="report.html", help="输出 HTML 路径")
    ap.add_argument("--theme", default=None, choices=["light", "dark"],
                    help="主题，默认读取 JSON 的 theme 字段，否则 light")
    args = ap.parse_args()

    src = Path(args.json)
    if not src.exists():
        sys.exit(f"文件不存在: {src}")
    data = json.loads(src.read_text(encoding="utf-8"))
    theme = args.theme or data.get("theme", "light")
    html = render(data, theme)

    out = Path(args.out)
    out.write_text(html, encoding="utf-8")
    print(f"✔ 报告已生成: {out.resolve()}")
    print(f"  主题: {theme}　大小: {len(html.encode()) / 1024:.1f} KB")
    print(f"  章节: {len(data.get('sections', []))} 个　KPI 卡片: {len(data.get('kpis', []))} 个")


if __name__ == "__main__":
    main()
