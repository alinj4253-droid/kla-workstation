# -*- coding: utf-8 -*-
"""真渲染：pptx → PDF → 逐页 PNG。

为什么必须真渲染：HTML 预览自检**查不出"PPT 端漏画元素"**——只在另一端实现的装饰，
预览全绿而 pptx 里根本没有。唯一可靠方式是把它渲染成图，亲眼看。

渲染器自动探测（平台中立）：
  1. LibreOffice / soffice  —— Linux / macOS 首选
  2. WPS kwpsconvert.exe     —— Windows 侧可用（ppt2pdf）
  3. 都没有 → 明确报错并给出安装指引，**不假装成功**

PDF → PNG 用 pypdfium2（纯 Python 轮子，不依赖 poppler）。
"""
from __future__ import annotations

import glob
import os
import shutil
import subprocess
import sys

# ------------------------------------------------------------------ 渲染器探测


def find_renderer() -> tuple[str, str] | None:
    """返回 ``(kind, path)``：kind ∈ {'soffice','wps'}。"""
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if soffice:
        return ("soffice", soffice)
    if sys.platform.startswith("win"):
        roots = [
            os.path.expandvars(r"%LOCALAPPDATA%\Kingsoft\WPS Office"),
            os.path.expandvars(r"%PROGRAMFILES%\Kingsoft\WPS Office"),
            os.path.expandvars(r"%PROGRAMFILES(X86)%\Kingsoft\WPS Office"),
        ]
        cands: list[str] = []
        for r in roots:
            cands += glob.glob(os.path.join(r, "*", "office6", "kwpsconvert.exe"))
        if cands:
            def ver(p: str) -> tuple:
                part = p.replace("\\", "/").split("/")[-3]
                return tuple(int(x) if x.isdigit() else 0 for x in part.split("."))
            return ("wps", sorted(cands, key=ver)[-1])
    return None


def to_pdf(pptx_path: str, outdir: str) -> str:
    """把 pptx 渲染成 PDF。输出目录会被清空（见下方陷阱）。"""
    pptx_path = os.path.abspath(pptx_path)
    outdir = os.path.abspath(outdir)

    # ⚠ 陷阱：输出目录里若已有同名 PDF，WPS 不覆盖而是产出 "名字(1).pdf"，
    #   后续步骤仍按原名读旧 PDF → 渲染出来是上一版内容，自检全废。
    if os.path.isdir(outdir):
        shutil.rmtree(outdir)
    os.makedirs(outdir, exist_ok=True)

    found = find_renderer()
    if not found:
        raise RuntimeError(
            "未找到可用的 pptx 渲染器。请安装 LibreOffice（推荐，跨平台），"
            "或确保 Windows 侧已安装 WPS。"
        )
    kind, exe = found
    if kind == "soffice":
        cmd = [exe, "--headless", "--convert-to", "pdf", "--outdir", outdir, pptx_path]
    else:  # wps —— 路径必须绝对，相对路径会被解析到错误目录
        cmd = [exe, "ppt2pdf", pptx_path, "-o", outdir]

    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    pdfs = sorted(glob.glob(os.path.join(outdir, "*.pdf")))
    pdfs = [p for p in pdfs if "(1)" not in os.path.basename(p)] or pdfs
    if not pdfs:
        raise RuntimeError(
            f"渲染失败（{kind}）。stdout={proc.stdout[-400:]!r} stderr={proc.stderr[-400:]!r}"
        )
    return pdfs[0]


def to_pngs(pdf_path: str, outdir: str, *, scale: float = 2.0) -> list[str]:
    """PDF → 逐页 PNG（pypdfium2）。"""
    import pypdfium2 as pdfium

    os.makedirs(outdir, exist_ok=True)
    doc = pdfium.PdfDocument(pdf_path)
    outs: list[str] = []
    for i in range(len(doc)):
        page = doc[i]
        pil = page.render(scale=scale).to_pil()
        p = os.path.join(outdir, f"p{i + 1:02d}.png")
        pil.save(p)
        outs.append(p)
    return outs


def contact_sheet(pngs: list[str], out_path: str, *, cols: int = 4, gap: int = 12,
                  bg: str = "#E9E9E9", label: bool = True) -> str:
    """把全部页面拼成缩略图网格——`连续3页同节奏`和`视觉荒漠页`只能这样看出来。"""
    from PIL import Image, ImageDraw

    if not pngs:
        raise ValueError("没有可拼的页面图")
    thumbs = []
    tile_w = 480
    for p in pngs:
        im = Image.open(p).convert("RGB")
        h = int(im.height * tile_w / im.width)
        thumbs.append(im.resize((tile_w, h), Image.LANCZOS))
    tile_h = max(t.height for t in thumbs)
    rows = (len(thumbs) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tile_w + (cols + 1) * gap,
                              rows * (tile_h + (18 if label else 0)) + (rows + 1) * gap),
                      bg)
    draw = ImageDraw.Draw(sheet)
    for i, t in enumerate(thumbs):
        r, c = divmod(i, cols)
        x = gap + c * (tile_w + gap)
        y = gap + r * (tile_h + (18 if label else 0) + gap)
        sheet.paste(t, (x, y))
        if label:
            draw.text((x + 4, y + t.height + 3), f"P{i + 1:02d}", fill="#333333")
    sheet.save(out_path)
    return out_path


def render(pptx_path: str, outdir: str, *, scale: float = 2.0,
           sheet: bool = True) -> dict:
    """一步到位：pptx → PDF → PNG（+ 缩略图网格）。"""
    outdir = os.path.abspath(outdir)
    pdf = to_pdf(pptx_path, outdir)
    pngs = to_pngs(pdf, outdir, scale=scale)
    res = {"pdf": pdf, "pngs": pngs, "count": len(pngs)}
    if sheet and pngs:
        res["sheet"] = contact_sheet(pngs, os.path.join(outdir, "_sheet.png"))
    return res
