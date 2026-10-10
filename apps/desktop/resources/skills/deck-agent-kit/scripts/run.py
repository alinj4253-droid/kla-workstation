#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""一键入口 —— 宿主只需要认这一个文件，不必知道包结构。

用法::

    python scripts/run.py                     # 不带参数 = 环境自检（装上先跑这个）
    python scripts/run.py doctor              # 环境自检：能做什么、缺什么、怎么补
    python scripts/run.py check  spec.json    # 校验语义契约
    python scripts/run.py build  spec.json -o out.pptx
    python scripts/run.py qc     out.pptx --spec spec.json
    python scripts/run.py render out.pptx -o outdir
    python scripts/run.py all    spec.json -o out.pptx   # 编译→质检→渲染 一条龙
    python scripts/run.py layouts             # 列出块类型与版式

退出码：0 成功｜1 契约不合规｜2 质检有阻断级问题｜3 环境不可运行。
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pptkit.cli import main  # noqa: E402

if __name__ == "__main__":
    argv = sys.argv[1:]
    if not argv:
        # 装上先自检：把"我能不能干活"作为默认动作，而不是让用户猜
        argv = ["doctor"]
    raise SystemExit(main(argv))
