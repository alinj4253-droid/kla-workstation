# -*- coding: utf-8 -*-
"""环境自检：这个宿主能不能跑本引擎、缺什么、怎么补。

设计意图：**能力包必须能自己报告"我做不到什么"**，而不是等出错才暴露。
装上本包的任何智能体，第一件事就应该是跑 ``doctor``，并把结论原样告诉用户。

判定三档：
  · ``full``     —— 生成 + 质检 + 真渲染 全可用
  · ``partial``  —— 能生成 pptx 与质检，但**无法真渲染**（视觉自检降级）
  · ``blocked``  —— 缺关键依赖，连生成都做不了
"""
from __future__ import annotations

import glob
import importlib.util
import os
import platform
import shutil
import sys

#: 依赖模块 → pip 包名
DEPS = {
    "pptx": "python-pptx",
    "PIL": "Pillow",
    "pypdfium2": "pypdfium2",
}

FONT_DIRS = [
    "C:/Windows/Fonts",
    "/usr/share/fonts",
    "/usr/local/share/fonts",
    os.path.expanduser("~/.fonts"),
    os.path.expanduser("~/.local/share/fonts"),
    "/Library/Fonts",
    "/System/Library/Fonts",
    "/System/Library/Fonts/Supplemental",
]

#: 中文字体候选（标题/正文要能区分家族；都没有则 pptx 里会回退主题字体）
FONT_FILES = {
    "微软雅黑": ["msyh.ttc", "msyhbd.ttc", "msyh.ttf", "msyhl.ttc"],
    "思源黑体": ["SourceHanSansSC-Regular.otf", "SourceHanSansSC-Bold.otf",
                "SourceHanSansSC-Regular.ttc", "SourceHanSansCN-Regular.otf",
                "NotoSansCJKsc-Regular.otf", "NotoSansCJK-Regular.ttc",
                "NotoSansSC-Regular.otf"],
    "黑体/Heiti": ["simhei.ttf", "Heiti.ttc"],
    "宋体": ["simsun.ttc"],
}


def check_deps() -> dict:
    out = {}
    for mod, pkg in DEPS.items():
        out[mod] = importlib.util.find_spec(mod) is not None
    return out


def check_renderer() -> dict | None:
    """探测 pptx → PDF 的渲染器。"""
    exe = shutil.which("soffice") or shutil.which("libreoffice")
    if exe:
        return {"kind": "soffice", "path": exe}
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
            return {"kind": "wps", "path": sorted(cands, key=ver)[-1]}
    return None


def check_fonts() -> dict:
    out = {}
    for name, files in FONT_FILES.items():
        hit = None
        for d in FONT_DIRS:
            if not os.path.isdir(d):
                continue
            for f in files:
                p = os.path.join(d, f)
                if os.path.exists(p):
                    hit = p
                    break
            if hit:
                break
        if not hit:  # 兜底：递归浅扫一层
            for d in FONT_DIRS:
                if not os.path.isdir(d):
                    continue
                for f in files:
                    m = glob.glob(os.path.join(d, "**", f), recursive=True)
                    if m:
                        hit = m[0]
                        break
                if hit:
                    break
        out[name] = hit
    return out


def diagnose() -> dict:
    deps = check_deps()
    missing = [DEPS[m] for m, ok in deps.items() if not ok]
    renderer = check_renderer()
    fonts = check_fonts()

    cjk_ok = any(v for k, v in fonts.items() if k in ("微软雅黑", "思源黑体"))
    build_ok = not missing
    qc_ok = build_ok              # 质检只读 pptx，不需要渲染器
    render_ok = build_ok and renderer is not None

    blockers: list[str] = []
    actions: list[str] = []
    notes: list[str] = []

    if missing:
        blockers.append(f"缺少 Python 依赖：{', '.join(missing)}")
        actions.append("安装依赖：pip install " + " ".join(missing))
    if build_ok and not renderer:
        blockers.append("未找到 pptx 渲染器（LibreOffice 的 soffice，或 Windows 上的 WPS）")
        actions.append("装 LibreOffice（跨平台，推荐）：https://www.libreoffice.org/download/ "
                       "或确保 Windows 侧已安装 WPS")
        notes.append("缺渲染器时：仍可生成 pptx 与跑结构质检，"
                     "但**无法做视觉自检**——交付前必须由用户在 PowerPoint/WPS 里打开确认。")
    if build_ok and not cjk_ok:
        notes.append("未检测到中文字体（微软雅黑/思源黑体）。pptx 里会写死字体名，"
                     "在缺该字体的机器上打开会回退、整体重排。"
                     "服务端建议装思源黑体（开源可商用）。")

    if not build_ok:
        level, verdict = "blocked", "无法运行：先装齐上面的依赖"
    elif not render_ok:
        level, verdict = "partial", "可以生成与质检，但不能真渲染（视觉自检降级）"
    else:
        level, verdict = "full", "可以完整运行：生成 + 质检 + 真渲染"

    return {
        "os": f"{platform.system()} {platform.release()}",
        "python": sys.version.split()[0],
        "python_path": sys.executable,
        "deps": deps,
        "renderer": renderer,
        "fonts": fonts,
        "capabilities": {"generate": build_ok, "qc": qc_ok, "render": render_ok,
                         "cjk_font": cjk_ok},
        "blockers": blockers,
        "actions": actions,
        "notes": notes,
        "level": level,
        "verdict": verdict,
    }


def format_report(r: dict) -> str:
    """人类可读的自检报告（智能体应把它原样转述给用户）。"""
    L = []
    L.append("=== PPT 引擎环境自检 ===")
    L.append(f"系统：{r['os']}｜Python {r['python']}")
    L.append(f"解释器：{r['python_path']}")
    L.append("")
    L.append("依赖：" + "，".join(
        f"{m}{'✓' if ok else '✗'}" for m, ok in r["deps"].items()))
    rd = r["renderer"]
    L.append("渲染器：" + (f"{rd['kind']} → {rd['path']}" if rd else "✗ 未找到"))
    fs = "，".join(f"{k}{'✓' if v else '✗'}" for k, v in r["fonts"].items())
    L.append(f"字体：{fs}")
    L.append("")
    cap = r["capabilities"]
    L.append("能力判定：")
    L.append(f"  · 生成 pptx      {'可用' if cap['generate'] else '不可用'}")
    L.append(f"  · 结构质检       {'可用' if cap['qc'] else '不可用'}")
    L.append(f"  · 真渲染自检     {'可用' if cap['render'] else '不可用'}")
    L.append("")
    L.append(f"档位：{r['level']}")
    L.append(f"结论：{r['verdict']}")
    if r["blockers"]:
        L.append("")
        L.append("缺口：")
        for b in r["blockers"]:
            L.append(f"  ✗ {b}")
    if r["actions"]:
        L.append("")
        L.append("补救建议：")
        for a in r["actions"]:
            L.append(f"  → {a}")
    if r["notes"]:
        L.append("")
        L.append("注意：")
        for n in r["notes"]:
            L.append(f"  · {n}")
    return "\n".join(L)
