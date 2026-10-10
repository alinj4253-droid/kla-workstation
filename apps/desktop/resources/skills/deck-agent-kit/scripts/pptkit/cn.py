# -*- coding: utf-8 -*-
"""中文排版工具：全角标点归一化 + 半角残留断言。

规则：正式中文交付件的标点必须全角（，：；（））；数字/日期/百分比/页码里的符号不动。
括号必须**成对判定**——只按"邻字是否中文"判断时，数字开头的括号两侧都不是中文，
``(19/20 套)`` 会被渲染成 ``(19/20 套）``（左半角右全角）。

平台中立：仅依赖标准库。
"""
from __future__ import annotations

import re

_PUNCT_MAP = {",": "，", ":": "：", ";": "；"}
#: 交付前必须断言的残留半角标点
_HALF_KILL = re.compile(r"[(),:;]")


def _is_cjk(c: str) -> bool:
    return (("\u4e00" <= c <= "\u9fff")
            or ("\u3000" <= c <= "\u303f")
            or ("\uff00" <= c <= "\uffef"))


def normalize(text: str) -> str:
    """把中文语境里的半角标点转成全角；数字/英文语境的保留。"""
    if not text:
        return text
    chars = list(text)

    # 第一遍：括号成对判定——括号内含中文，或括号外侧贴中文，则左右一起转全角
    stack: list[int] = []
    for i, ch in enumerate(text):
        if ch == "(":
            stack.append(i)
        elif ch == ")" and stack:
            j = stack.pop()
            inner = text[j + 1:i]
            prev = text[j - 1] if j else ""
            nxt = text[i + 1] if i + 1 < len(text) else ""
            if any(_is_cjk(c) for c in inner) or _is_cjk(prev) or _is_cjk(nxt):
                chars[j] = "（"
                chars[i] = "）"

    # 第二遍：其余标点按邻字判定。⚠ 邻字必须查 chars（已转换串），
    # 否则 "）;" 里的分号会因邻字查原串而漏转
    out: list[str] = []
    for i, ch in enumerate(text):
        c = chars[i]
        if c in ("(", ")"):
            out.append(c)
            continue
        prev = chars[i - 1] if i else ""
        nxt = chars[i + 1] if i + 1 < len(chars) else ""
        out.append(_PUNCT_MAP[c] if c in _PUNCT_MAP and (_is_cjk(prev) or _is_cjk(nxt)) else c)
    return "".join(out)


def halfwidth_hits(text: str) -> list[tuple[int, str]]:
    """返回文本中残留的半角标点 ``(位置, 字符)``，用于交付前断言。"""
    return [(m.start(), m.group()) for m in _HALF_KILL.finditer(text or "")]


def assert_clean(text: str, where: str = "") -> None:
    """断言文本无半角标点残留，否则抛 ``AssertionError``。"""
    hits = halfwidth_hits(text)
    if hits:
        raise AssertionError(f"半角标点残留 {where}: {hits} in {text!r}")
