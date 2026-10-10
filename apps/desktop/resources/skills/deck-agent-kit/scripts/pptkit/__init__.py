# -*- coding: utf-8 -*-
"""pptkit — 从页面语义到原生可编辑 PPTX 的确定性引擎。

设计前提（写死在架构里，不可偏离）：
  1. **单一真源 = 页面语义 spec**。LLM 只产语义，坐标由本引擎算。
  2. **PPTX 是唯一产物真源**。预览由该 pptx 反向渲染，禁止第二套渲染分支。
  3. **交付前真渲染自检**，不通过不给导出。

典型用法::

    python -m pptkit build examples/deck.sample.json -o out.pptx --render
"""
from .tokens import DesignSystem, PRESETS, get as get_design
from . import schema
from . import cn

__version__ = "1.0.0"
__all__ = ["DesignSystem", "PRESETS", "get_design", "schema", "cn", "__version__"]
