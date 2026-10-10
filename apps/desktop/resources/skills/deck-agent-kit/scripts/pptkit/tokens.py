# -*- coding: utf-8 -*-
"""设计系统（Design System）：色板 / 字号阶梯 / 栅格。

铁律（来自能力规格 §5.2）：
  · 面积分级 底色 70% ｜ 主色 15~20%（只做骨架）｜ 点缀 5~8%
  · 禁纯黑纯白（#222222 / #F4F4F2）
  · 全部低饱和；灰阶给 3~5 阶
  · 字号只做 3~4 级，级差 ≥2 倍；最大字号只给数字
  · 卡内正文 ≥11.5pt、小注 ≥10.5pt、胶囊 ≥10pt
"""
from __future__ import annotations

from dataclasses import dataclass, field

#: 16:9 画布（英寸）
W, H = 13.333, 7.5


@dataclass(frozen=True)
class DesignSystem:
    id: str
    name: str
    bg: str            # 页面底色
    card: str          # 卡片底
    line: str          # 细线 / 描边
    primary: str       # 主色：只做骨架（页头条 / 结论条 / 英雄数字）
    accent: str        # 强调色：每页 ≤1 处
    text: str          # 标题与正文
    text_weak: str     # 次级灰
    neutrals: tuple = ("#E5E5E5", "#D8D8D8", "#CCCCCC", "#BCBCBC")
    font_title: str = "微软雅黑"
    font_body: str = "微软雅黑"

    # 字号阶梯（pt）——级差拉大，3~4 级
    hero: float = 54.0
    title: float = 30.0
    subtitle: float = 18.0
    card_title: float = 15.0
    body: float = 11.5
    note: float = 10.5
    chip: float = 10.0
    page_no: float = 10.0

    # 栅格（英寸）
    margin: float = 0.62
    gap: float = 0.24
    radius: float = 0.11

    def __post_init__(self):
        bad = []
        # 禁纯黑：主色/强调/文字都不用 #000000
        for k in ("primary", "accent", "text", "text_weak"):
            if getattr(self, k).upper() == "#000000":
                bad.append(f"{k} 用了纯黑 #000000（应用 #222222 一类）")
        # 正文不用纯白
        if self.text.upper() == "#FFFFFF":
            bad.append("text 用了纯白 #FFFFFF（应用 #F4F4F2 一类）")
        if len(self.neutrals) < 3:
            bad.append("灰阶少于 3 阶（应给 3~5 阶）")
        if self.body < 11.5:
            bad.append(f"正文 {self.body}pt 低于下限 11.5pt")
        if self.note < 10.5:
            bad.append(f"小注 {self.note}pt 低于下限 10.5pt")
        if self.chip < 10:
            bad.append(f"胶囊 {self.chip}pt 低于下限 10pt")
        if not (self.hero >= self.title * 1.6):
            bad.append("英雄数字与标题的字号落差不足")
        if bad:
            raise ValueError("设计系统不合规：" + "；".join(bad))

    # ---- 版面辅助 ----
    @property
    def content_x(self) -> float:
        return self.margin

    @property
    def content_w(self) -> float:
        return W - 2 * self.margin

    @property
    def content_top(self) -> float:
        """内容区上沿（页头之下）。"""
        return 1.62

    @property
    def content_bottom(self) -> float:
        """内容区下沿（页脚之上）。"""
        return 6.72

    @property
    def content_h(self) -> float:
        return self.content_bottom - self.content_top


# ---------------------------------------------------------------- 预设
MODERN_TECH = DesignSystem(
    id="modern-tech",
    name="现代科技（炭黑 + 青绿）",
    bg="#FFFFFF",
    card="#F6F7F9",
    line="#E5E7EB",
    primary="#1B1F27",
    accent="#00B8A9",
    text="#1B1F27",
    text_weak="#5A626E",
    neutrals=("#F0F1F3", "#E1E4E8", "#C9CED6", "#A8AEB8"),
)

CLASSIC_PRO = DesignSystem(
    id="classic-pro",
    name="经典专业（墨蓝 + 砖橙）",
    bg="#F7F7F5",
    card="#FFFFFF",
    line="#E3E1DC",
    primary="#2451B3",
    accent="#C25B3B",
    text="#1A1A1A",
    text_weak="#5C5C58",
    neutrals=("#EFEEEA", "#DCDAD4", "#C4C1B8", "#A5A29A"),
)

DEEP_PREMIUM = DesignSystem(
    id="deep-premium",
    name="深色高级（深海蓝 + 琥珀金）",
    bg="#0A2540",
    card="#123153",
    line="#1E4470",
    primary="#0A2540",
    accent="#FCA311",
    text="#F4F4F2",
    text_weak="#9DB2CB",
    neutrals=("#17385C", "#1E4470", "#2A5488", "#3E6BA0"),
)

PRESETS = {ds.id: ds for ds in (MODERN_TECH, CLASSIC_PRO, DEEP_PREMIUM)}


def get(design_id: str) -> DesignSystem:
    """按 id 取预设设计系统；未知 id 报错（不静默兜底）。"""
    if design_id not in PRESETS:
        raise KeyError(f"未知设计系统 {design_id!r}，可用：{sorted(PRESETS)}")
    return PRESETS[design_id]


def from_dict(d: dict) -> DesignSystem:
    """从 deck spec 里的 ``design_system`` 段构造（缺字段用预设兜底）。"""
    if isinstance(d, str):
        return get(d)
    d = dict(d or {})
    base = PRESETS.get(d.pop("preset", "modern-tech"), MODERN_TECH)
    allowed = {f for f in DesignSystem.__dataclass_fields__}
    kwargs = {k: v for k, v in d.items() if k in allowed}
    if "neutrals" in kwargs:
        kwargs["neutrals"] = tuple(kwargs["neutrals"])
    return DesignSystem(**{**{k: getattr(base, k) for k in allowed}, **kwargs})
