# -*- coding: utf-8 -*-
"""pptkit 命令行入口。

    python -m pptkit check  spec.json              只校验语义契约
    python -m pptkit build  spec.json -o out.pptx  编译（默认带契约校验）
    python -m pptkit qc     out.pptx [--spec spec.json]   交付前质量门禁
    python -m pptkit render out.pptx -o dir        真渲染成 PDF + PNG + 缩略图网格
    python -m pptkit all    spec.json -o out.pptx  编译 → 质检 → 渲染，一条龙
    python -m pptkit layouts                       列出支持的版式与块类型
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from . import compile as compile_mod
from . import layout as layout_mod
from . import qc as qc_mod
from . import render as render_mod
from . import schema


def _load(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _emit(obj) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pptkit", description="页面语义 → 原生可编辑 PPTX")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_check = sub.add_parser("check", help="校验 spec 契约")
    p_check.add_argument("spec")

    p_build = sub.add_parser("build", help="编译 spec → pptx")
    p_build.add_argument("spec")
    p_build.add_argument("-o", "--out", required=True)
    p_build.add_argument("--loose", action="store_true", help="不阻断（仅告警）")

    p_qc = sub.add_parser("qc", help="质量门禁")
    p_qc.add_argument("pptx")
    p_qc.add_argument("--spec", default=None)

    p_r = sub.add_parser("render", help="真渲染")
    p_r.add_argument("pptx")
    p_r.add_argument("-o", "--outdir", default=None)
    p_r.add_argument("--scale", type=float, default=2.0)

    p_all = sub.add_parser("all", help="编译 → 质检 → 渲染")
    p_all.add_argument("spec")
    p_all.add_argument("-o", "--out", required=True)
    p_all.add_argument("--outdir", default=None)

    sub.add_parser("layouts", help="列出支持的版式与块类型")
    sub.add_parser("doctor", help="环境自检：本机能不能跑、缺什么、怎么补")

    args = ap.parse_args(argv)

    if args.cmd == "doctor":
        from .doctor import diagnose, format_report
        rep = diagnose()
        print(format_report(rep))
        return 0 if rep["level"] != "blocked" else 3

    if args.cmd == "layouts":
        _emit({"block_types": schema.BLOCK_TYPES, "layouts": schema.LAYOUTS})
        return 0

    if args.cmd == "check":
        deck = _load(args.spec)
        errs = schema.validate(deck)
        _emit({"ok": not errs, "errors": errs})
        return 0 if not errs else 1

    if args.cmd == "build":
        deck = _load(args.spec)
        if args.loose:
            for e in schema.validate(deck):
                print(f"[warn] {e}", file=sys.stderr)
        rep = compile_mod.build(deck, args.out, strict=not args.loose)
        _emit(rep)
        return 0

    if args.cmd == "qc":
        deck = _load(args.spec) if args.spec else None
        rep = qc_mod.inspect(args.pptx, deck)
        _emit(rep)
        return 0 if rep["ok"] else 2

    if args.cmd == "render":
        outdir = args.outdir or os.path.splitext(args.pptx)[0] + "_render"
        _emit(render_mod.render(args.pptx, outdir, scale=args.scale))
        return 0

    if args.cmd == "all":
        deck = _load(args.spec)
        rep = compile_mod.build(deck, args.out)
        _emit(rep)
        q = qc_mod.inspect(args.out, deck)
        print("--- 质检 ---")
        _emit(q)
        if not q["ok"]:
            print("❌ 质检未通过，停止渲染。", file=sys.stderr)
            return 2
        outdir = args.outdir or os.path.splitext(args.out)[0] + "_render"
        r = render_mod.render(args.out, outdir)
        print(f"渲染 {r['count']} 页 → {outdir}")
        print(f"缩略图网格：{r.get('sheet')}")
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
