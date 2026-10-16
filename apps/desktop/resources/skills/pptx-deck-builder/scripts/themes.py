#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""读取 slidep 引擎自带的「主题契约库」（30 套 .DESIGN.md）。

为什么需要它：这 30 套是**随引擎分发的参考资料**，不是可运行的模板——
  ① 引擎 bundle 里 0 处引用 resources/themes（引擎自己不消费它们）；
  ② CLI 没有 `template search` 命令（包内 README 写了，但二进制里没有）。
所以只能手动翻阅。本脚本把「翻阅 + 抄色值」这一步自动化。

只用标准库（不需要 pyyaml / Pillow）。

子命令：
  dir                          打印主题库绝对路径
  list                         列出 30 套（编号 / 名称 / 主色 / 分类）
  search <关键词>               按文件名 + frontmatter 检索
  show   <编号|关键词> [节名]    打印完整契约；给节名则只打该节
  palette <编号|关键词>         输出可直接粘进 .slide「主题区」的常量块

路径覆盖：THEMES_DIR=<主题库绝对路径>，或 SLIDEP_ENGINE / SLIDEP_NODE_ROOT
"""
import glob
import os
import re
import sys
import unicodedata

# ── 定位主题库 ──────────────────────────────────────────────────────────


def find_themes_dir():
    d = os.environ.get("THEMES_DIR")
    if d:
        if os.path.isdir(d):
            return d
        sys.exit("[themes] THEMES_DIR 不存在：%s" % d)

    cands = []
    eng = os.environ.get("SLIDEP_ENGINE")
    if eng:
        cands.append(os.path.join(os.path.dirname(eng), "resources", "themes"))

    roots = []
    nr = os.environ.get("SLIDEP_NODE_ROOT")
    if nr:
        roots.append(nr)
    home = os.path.expanduser("~")
    roots += sorted(glob.glob(os.path.join(home, ".workbuddy", "binaries", "node", "versions", "*")))
    roots += ["C:/Program Files/nodejs", "/usr/local", "/usr"]

    for r in roots:
        for sub in ("lib/node_modules", "node_modules"):
            cands.append(os.path.join(r, sub, "@tencent", "slidep", "dist", "resources", "themes"))

    for c in cands:
        if os.path.isdir(c) and glob.glob(os.path.join(c, "*.DESIGN.md")):
            return os.path.normpath(c)
    return None


# ── 读文件与解析 frontmatter ────────────────────────────────────────────


def read_text(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def frontmatter_lines(text):
    """取首个 --- 到第二个 --- 之间的行。"""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return []
    out = []
    for ln in lines[1:]:
        if ln.strip() == "---":
            break
        out.append(ln)
    return out


def fm_field(fm, key):
    """取顶层 `key: value`。支持行内值与 YAML 块标量（`key: |` + 缩进块）。"""
    pat = re.compile(r"^" + re.escape(key) + r":\s*(.*?)\s*$")
    for i, ln in enumerate(fm):
        m = pat.match(ln)
        if not m:
            continue
        v = m.group(1)
        if v in ("|", ">", "|-", ">-", "|+", ">+"):
            parts = []
            for nxt in fm[i + 1:]:
                if re.match(r"^\s{2,}\S", nxt):
                    parts.append(nxt.strip())
                elif not nxt.strip():
                    continue
                else:
                    break
            return " ".join(parts)
        v = re.sub(r"\s+#.*$", "", v).strip()
        return v.strip('"').strip("'")
    return None


def _color_of_key(fm, key):
    pat = re.compile(r"^\s{2}" + re.escape(key) + r":\s*\"(#[0-9A-Fa-f]{6})\"")
    for ln in fm:
        m = pat.match(ln)
        if m:
            return m.group(1).upper()
    return None


def get_color(fm, *keys, **kw):
    """按优先级取色。keys 全不命中时，按 prefix 泛化匹配（如 prefix='primary'）。"""
    for k in keys:
        v = _color_of_key(fm, k)
        if v:
            return v
    for pre in kw.get("prefixes", ()):
        pat = re.compile(r"^\s{2}(" + re.escape(pre) + r"[A-Za-z0-9_-]*):\s*\"(#[0-9A-Fa-f]{6})\"")
        for ln in fm:
            m = pat.match(ln)
            if m:
                return m.group(2).upper()
    return None


def get_font(fm, role):
    """取 typography.<role>.fontFamily 的原始值（保留完整 fallback 链）。"""
    cur = None
    for ln in fm:
        if re.match(r"^\S", ln):          # 顶层键 → 离开 typography 块
            cur = None
            continue
        m = re.match(r"^  ([A-Za-z_-]+):\s*$", ln)
        if m:
            cur = m.group(1)
            continue
        if cur == role:
            m2 = re.match(r"^    fontFamily:\s*(.+?)\s*$", ln)
            if m2:
                return m2.group(1).strip()
    return None


def first_family(v):
    if not v:
        return ""
    v = v.lstrip("'\"")
    return v.split('"')[0].split(",")[0].strip()


GENERIC_FAMILIES = ("sans-serif", "serif", "monospace", "system-ui", "cursive", "fantasy")


def normalize_font_stack(v):
    """把契约里的字体栈整理成可直接用的 JS 字面量内容。

    - 去掉 YAML 行尾注释（`# 🟢` 之类会漏进字体名）
    - 逐项去引号后重新统一加双引号
    - **在通用族之前补入本机常见字体**：契约里的首选字体（思源/MiSans/PingFang/字魂…）
      本机多半没装，pptx 又不嵌字体 → 不补兜底就等于把字形交给运气。
    返回 (栈字符串, 补入的兜底列表)。
    """
    if not v:
        return None, []
    v = re.sub(r"\s+#.*$", "", v).strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
        v = v[1:-1]
    fams = [f.strip().strip('"').strip("'") for f in v.split(",")]
    fams = [f for f in fams if f]
    if not fams:
        return None, []

    generic = [f for f in fams if f.lower() in GENERIC_FAMILIES]
    body = [f for f in fams if f.lower() not in GENERIC_FAMILIES]
    if not generic:
        generic = ["sans-serif"]

    if generic[0].lower() == "serif":
        fallbacks = ["SimSun", "Noto Serif SC", "Microsoft YaHei"]
    else:
        fallbacks = ["Microsoft YaHei", "Noto Sans SC"]

    added = []
    for fb in fallbacks:
        if fb not in body:
            body.append(fb)
            added.append(fb)

    stack = body + [generic[0]]
    return ", ".join('"%s"' % f for f in stack), added


# ── 中文列宽 ────────────────────────────────────────────────────────────


def dwidth(s):
    w = 0
    for ch in s:
        w += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
    return w


def pad(s, n):
    return s + " " * max(0, n - dwidth(s))


def dcut(s, n):
    out = []
    w = 0
    for ch in s:
        cw = 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
        if w + cw > n:
            break
        out.append(ch)
        w += cw
    return "".join(out)


# ── 颜色工具 ────────────────────────────────────────────────────────────


def hex2rgb(h):
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def luminance(h):
    r, g, b = hex2rgb(h)
    return (2126 * r + 7152 * g + 722 * b) // 10000


def lighten(h, pct=35):
    r, g, b = hex2rgb(h)
    f = lambda v: (v * (100 - pct) + 255 * pct) // 100
    return "#%02X%02X%02X" % (f(r), f(g), f(b))


def mix(a, b, pct):
    """把 a 朝 b 靠 pct%（用于按背景色派生出带同色调的卡片色）。"""
    ra, ga, ba = hex2rgb(a)
    rb, gb, bb = hex2rgb(b)
    f = lambda x, y: (x * (100 - pct) + y * pct) // 100
    return "#%02X%02X%02X" % (f(ra, rb), f(ga, gb), f(ba, bb))


def hue(h):
    import colorsys
    r, g, b = hex2rgb(h)
    hh, _, _ = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)
    return hh * 360.0


def hue_gap(a, b):
    d = abs(hue(a) - hue(b)) % 360.0
    return d if d <= 180 else 360 - d


# ── 主题集合 ────────────────────────────────────────────────────────────


class Theme(object):
    def __init__(self, path):
        self.path = path
        self.file = os.path.basename(path)
        self.name = self.file[:-len(".DESIGN.md")] if self.file.endswith(".DESIGN.md") else self.file
        text = read_text(path)
        self.fm = frontmatter_lines(text)
        self.fm_text = "\n".join(self.fm)
        self.meta_name = fm_field(self.fm, "name") or self.name
        self.description = fm_field(self.fm, "description") or ""
        self.audience = fm_field(self.fm, "audience") or ""

    @property
    def primary(self):
        v = get_color(self.fm, "primary", "primary-deep", "primary-ink", "secondary",
                      "accent", prefixes=("primary", "accent", "secondary"))
        if v:
            return v
        # 兜底：有些契约刻意不用彩色强调色（如 Editorial Portfolio 只有暖米+炭灰），
        # 此时用最深的中性色当"品牌色"——它就是画面上最重的那个色。
        v = get_color(self.fm, "on-surface", "surface-contrast", "on-contrast",
                      "surface-deep", prefixes=("surface", "on-"))
        if v:
            return v
        m = re.search(r'"(#[0-9A-Fa-f]{6})"', self.fm_text)
        return m.group(1).upper() if m else None

    @property
    def category(self):
        """只按名称判定（frontmatter 正文里会顺带提到别的题材，扫描全文必然误命中）。"""
        t = "%s %s" % (self.meta_name or "", self.name)
        if re.search(r"财务", t):
            return "财务分析"
        if re.search(r"汇报|答辩|基金|研发计划|科研|文献|工作型|目录页|乡村|三农|非遗|党建|政务|学术", t):
            return "政企学术"
        if re.search(r"作品集|portfolio|摄影|designer|art show|editorial|海报|reels|创意|液态玻璃|作品", t, re.I):
            return "创意设计"
        return "未分类"

    def palette(self):
        fm = self.fm
        bg = get_color(fm, "surface", "surface-light", "surface-card-white", "surface-paper",
                       "bg-paper", "bg-primary", "bg", "bg-ivory", "background", "base",
                       prefixes=("surface", "bg"))
        ink = get_color(fm, "on-surface", "on-paper", "on-contrast", "on-bg-primary",
                        "text", "foreground", prefixes=("on-surface", "on-", "text"))
        card = get_color(fm, "surface-muted", "surface-alt", "surface-card", "surface-light",
                         "bg-alt-light", "surface-paper", prefixes=("surface", "bg"))
        accent = get_color(fm, "primary", "primary-deep", "primary-ink", "secondary", "accent",
                           prefixes=("primary", "accent", "secondary"))
        if not accent:
            accent = get_color(fm, "on-surface", "surface-contrast", "on-contrast",
                               prefixes=("surface", "on-"))
        # 渐变第二端必须与主色同色系：契约里的 accent 往往是"行内强调点缀色"
        # （如乡村振兴那套的纯红 #DE0000，标注"切勿大面积使用"），拿它做渐变会翻车。
        accent2 = get_color(fm, "primary-light", "primary-soft", "primary-pale",
                            "primary-deep", "primary-darkest", prefixes=("primary",))
        dim = get_color(fm, "on-surface-secondary", "muted", "on-surface-tertiary", "on-surface-muted",
                        prefixes=("on-surface", "muted", "divider"))

        if not bg:
            bg = "#FFFFFF" if (ink and luminance(ink) < 128) else "#111111"
        if not ink:
            ink = "#1A1A1A" if luminance(bg) > 140 else "#F2F2F2"
        if not card:
            # 按背景色朝文字色偏 8% 派生，保留原色调（比硬编码灰更贴合主题）
            card = mix(bg, ink, 8)
        if not accent:
            accent = "#2F6BE4"
        if not accent2 or accent2 == accent:
            accent2 = lighten(accent)
        if not dim:
            dim = mix(ink, bg, 45)

        font_cn, added_cn = normalize_font_stack(get_font(fm, "body"))
        font_num, added_num = normalize_font_stack(get_font(fm, "display"))
        if not font_cn:
            font_cn = '"Microsoft YaHei", "Noto Sans SC", sans-serif'
        if not font_num:
            font_num = font_cn

        lum = luminance(bg)
        if lum > 140:
            tone = "浅色基调"
            mask = ("linear-gradient(90deg, rgba(18,20,24,0.94) 0%, rgba(18,20,24,0.72) 48%,"
                    " rgba(18,20,24,0.12) 86%)")
            onimg = "#FFFFFF"
            line = "rgba(18,20,24,0.12)"
        else:
            tone = "深色基调"
            r, g, b = hex2rgb(bg)
            mask = ("linear-gradient(90deg, rgba(%(c)s,0.97) 0%%, rgba(%(c)s,0.82) 34%%,"
                    " rgba(%(c)s,0.34) 64%%, rgba(%(c)s,0.58) 100%%)" % {"c": "%d,%d,%d" % (r, g, b)})
            onimg = "#F7F8FA"
            line = "rgba(%d,%d,%d,0.16)" % hex2rgb(ink)

        return dict(bg=bg, ink=ink, card=card, accent=accent, accent2=accent2, dim=dim,
                    font_cn=font_cn, font_num=font_num, added_cn=added_cn, added_num=added_num,
                    mask=mask, onimg=onimg, line=line, tone=tone, lum=lum,
                    emphasis=get_color(fm, "accent", "accent-deep", "accent-warm", prefixes=("accent",)))


# ── 解析选择器 ──────────────────────────────────────────────────────────


def load_all(themes_dir):
    return [Theme(p) for p in sorted(glob.glob(os.path.join(themes_dir, "*.DESIGN.md")),
                                     key=lambda p: os.path.basename(p))]


def resolve(themes, sel):
    if not sel:
        sys.exit("用法：需要 <编号|关键词>")
    if sel.isdigit():
        i = int(sel)
        if 1 <= i <= len(themes):
            return themes[i - 1]
        sys.exit("[themes] 编号超出范围：%s（共 %d 套）" % (sel, len(themes)))
    low = sel.lower()
    hits = [t for t in themes
            if low in t.name.lower() or low in t.fm_text.lower()]
    if not hits:
        sys.exit("[themes] 没有匹配「%s」的主题。先跑 list 看全表。" % sel)
    if len(hits) > 1:
        print("[themes] 「%s」命中 %d 套，请说得更具体或用编号：" % (sel, len(hits)), file=sys.stderr)
        for t in hits:
            print("  %s" % t.name, file=sys.stderr)
        sys.exit(1)
    return hits[0]


# ── 子命令 ──────────────────────────────────────────────────────────────


def cmd_dir(themes_dir, themes, args):
    print(themes_dir)
    print("# 共 %d 套" % len(themes), file=sys.stderr)


def cmd_list(themes_dir, themes, args):
    print("主题库：%s" % themes_dir)
    print("共 %d 套" % len(themes))
    print()
    print(pad("编号", 5) + pad("名称", 50) + pad("主色", 10) + "分类")
    print("─" * 78)
    for i, t in enumerate(themes, 1):
        print(pad(str(i), 5) + pad(dcut(t.name, 48), 50) + pad(t.primary or "—", 10) + t.category)
    print()
    print("分类只按名称判定（启发式，仅供筛选）。「未分类」= 名称里没有明确题材词，")
    print("多为英文命名或从真实 PPT 反向抽取的契约 —— 用 show <编号> 看 description 确认。")
    print("下一步：show <编号>  |  palette <编号>")


def cmd_search(themes_dir, themes, args):
    if not args:
        sys.exit("用法：search <关键词>")
    kw = args[0].lower()
    found = 0
    for i, t in enumerate(themes, 1):
        if kw in t.name.lower() or kw in t.fm_text.lower() or kw in t.file.lower():
            found += 1
            print("[%d] %s" % (i, t.name))
            if t.description:
                print("      %s" % dcut(t.description, 200))
            print()
    if not found:
        print("没有命中「%s」。" % args[0])
        print("提示：这 30 套的题材覆盖是「作品集/创意设计」「政企汇报/答辩」「财务分析」——")
        print("      游戏娱乐类没有现成答案，需自配（见 references/theme-presets.md）。")


def cmd_show(themes_dir, themes, args):
    if not args:
        sys.exit("用法：show <编号|关键词> [colors|typography|grid|canvas]")
    t = resolve(themes, args[0])
    sec = args[1] if len(args) > 1 else None
    if not sec:
        print(read_text(t.path), end="")
        return
    out = []
    inside = False
    for ln in t.fm:
        if re.match(r"^" + re.escape(sec) + r":\s*$", ln):
            inside = True
            out.append(ln)
            continue
        if inside:
            if re.match(r"^\S", ln):
                break
            out.append(ln)
    if not out:
        sys.exit("[themes] 该文件没有 `%s:` 节" % sec)
    print("\n".join(out))
    print()
    print("# （只输出了 %s 节；完整契约去掉第 2 个参数即可）" % sec)


def cmd_palette(themes_dir, themes, args):
    if not args:
        sys.exit("用法：palette <编号|关键词>")
    t = resolve(themes, args[0])
    p = t.palette()
    w = 71
    bar = "// " + "═" * w
    print(bar)
    print("// 主题区 · 取自引擎自带主题契约库")
    print("//   来源：%s" % t.meta_name)
    print("//   文件：themes/%s" % t.file)
    print("//   基调：%s（背景感知亮度 %d/255）" % (p["tone"], p["lum"]))
    print("// 映射：surface→BG  on-surface→INK  surface-muted→CARD  primary→ACCENT")
    print("//       body→FONT_CN  display→FONT_NUM（大字号展示用）")
    print("// ⚠ 字体：栈首仍是契约原意（可能是本机没装的思源 / MiSans / PingFang / 字魂）；")
    print("//   已在通用族之前补入本机常见字体兜底（见文末 added 行）。lint 度量与字体无关")
    print("//   （实测），但 pptx 不嵌字体 → 换机打开必然被替换，所以兜底不能省。")
    print(bar)
    print("const FONT_CN  = '%s';" % p["font_cn"])
    print("const FONT_NUM = '%s';" % p["font_num"])
    print("const BG     = '%s';   // 主色：页面背景" % p["bg"])
    print("const INK    = '%s';   // 文本色" % p["ink"])
    print("const CARD   = '%s';   // 辅色：卡片底 / 次级块" % p["card"])
    print("const ACCENT = '%s';   // 强调色：≤10%%，只用于焦点元素" % p["accent"])
    print("// 以下为中性辅助，不计入 4 色池")
    print("const DIM    = '%s';   // 次级文字" % p["dim"])
    print("const ONIMG  = '%s';   // 图上文字色" % p["onimg"])
    print("const LINE   = '%s';" % p["line"])
    print("const GRAD   = 'linear-gradient(135deg, %s 0%%, %s 100%%)';" % (p["accent"], p["accent2"]))
    print("const MASK   = '%s';" % p["mask"])
    print()
    print("// 色池自检（规范：4 个 hex 上限，主色≤60% / 辅色≤30% / 强调≤10%）")
    print("//   BG %s · INK %s · CARD %s · ACCENT %s" % (p["bg"], p["ink"], p["card"], p["accent"]))
    em = p.get("emphasis")
    if em and em != p["accent"] and hue_gap(em, p["accent"]) > 40:
        print("//   该契约另有 accent=%s —— 与主色不同色系，语义是「行内强调点缀」" % em)
        print("//   （序号 / 关键数字），通常标注了『切勿大面积使用』。要用它，")
        print("//   就当作第 5 个色单独管，别塞进 GRAD。")
    if p["added_cn"] or p["added_num"]:
        print("//   added：FONT_CN +[%s] / FONT_NUM +[%s]"
              % (", ".join(p["added_cn"]) or "无", ", ".join(p["added_num"]) or "无"))
    print("//   字体首选：%s" % first_family(p["font_cn"]))


COMMANDS = {
    "dir": cmd_dir,
    "list": cmd_list,
    "ls": cmd_list,
    "search": cmd_search,
    "show": cmd_show,
    "cat": cmd_show,
    "palette": cmd_palette,
    "pal": cmd_palette,
}


def main():
    argv = sys.argv[1:]
    cmd = argv[0] if argv else "list"
    if cmd in ("-h", "--help", "help"):
        print(__doc__)
        return 0
    if cmd not in COMMANDS:
        sys.exit("[themes] 未知子命令：%s。可用：dir | list | search | show | palette" % cmd)

    themes_dir = find_themes_dir()
    if not themes_dir:
        sys.exit("[themes] 找不到主题库（@tencent/slidep/dist/resources/themes）。\n"
                 "  修法：装好 slidep 引擎，或设 THEMES_DIR=<主题库绝对路径>。\n"
                 "  详见 references/theme-library.md")
    themes = load_all(themes_dir)
    if not themes:
        sys.exit("[themes] 目录里没有 *.DESIGN.md：%s" % themes_dir)
    return COMMANDS[cmd](themes_dir, themes, argv[1:]) or 0


if __name__ == "__main__":
    sys.exit(main())
