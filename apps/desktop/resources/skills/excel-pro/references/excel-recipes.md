# pandas / openpyxl 高频操作速查

面向 Excel 数据处理脚本编写的实用片段。所有片段均可直接复制使用。

---

## 一、读取

### 读取所有 sheet 并画像

```python
import pandas as pd

xl = pd.ExcelFile(path)
print(xl.sheet_names)

for sn in xl.sheet_names:
    df = pd.read_excel(path, sheet_name=sn)
    print(sn, df.shape, list(df.columns))
```

### 类型陷阱（最常见的坑）

`pd.read_excel` **按列推断 dtype**，混入一个文本值就会让整列退化为 `object`：

```python
# 单价列出现一个 "约899元" → 整列 object，sum() 变成字符串拼接或报错
df = pd.read_excel(path)
print(df["单价_元"].dtype)   # object ← 危险信号

# 处理方式一：读入后强制转换，无法转换的置为 NaN 并单独统计
df["单价_元"] = pd.to_numeric(df["单价_元"], errors="coerce")
n_bad = df["单价_元"].isna().sum() - df["单价_元"].isna().sum()  # 转换后新增的空值

# 处理方式二：用 converters 指定（在读取阶段就控制）
df = pd.read_excel(path, converters={"单价_元": lambda v: pd.to_numeric(v, errors="coerce")})
```

### 日期列

```python
df = pd.read_excel(path, parse_dates=["订单日期"])

# 若日期以文本存储，读取后再转换
df["订单日期"] = pd.to_datetime(df["订单日期"], errors="coerce")
# 转换失败的行会被置为 NaT，需检查
n_fail = df["订单日期"].isna().sum()
```

### 空值的两种形态

```python
# NaN（真空）与 ''（空串）语义不同，需分别处理
na_cnt = df["列"].isna().sum()                          # 真空
blank_cnt = (df["列"].astype(str).str.strip() == "").sum()  # 含空串
```

### 大文件

```python
# 只读部分行（探查阶段）
df = pd.read_excel(path, nrows=1000)

# 只读需要的列
df = pd.read_excel(path, usecols=["订单编号", "销售额_元"])

# .xls 旧格式需要 xlrd（pandas 2.0+ 已不支持 xlrd 读 xlsx，反之亦然）
# pip install xlrd   # 仅用于 .xls
```

---

## 二、清洗

### 统一去除首尾空格

```python
# 注意：不要对数值列做 str 操作，否则会把数字转成字符串
str_cols = df.select_dtypes(include="object").columns
df[str_cols] = df[str_cols].apply(lambda s: s.str.strip())
```

### 安全数值转换

```python
def to_num(v):
    """None / 空串 / 文本 → None；数值 → float"""
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).strip().replace(",", "").replace("，", ""))
    except (ValueError, TypeError):
        return None
```

### 识别数值列混入文本

```python
for col in df.select_dtypes(include="object").columns:
    valid = df[col].dropna()
    if len(valid) == 0:
        continue
    ratio = valid.map(lambda v: to_num(v) is not None).mean()
    if 0 < ratio < 1:
        bad = valid[[to_num(v) is None for v in valid]].unique()[:5]
        print(f"★ {col} 混入文本（可转数值比例 {ratio:.2%}）样本：{bad}")
```

### 枚举值归一化

```python
# 统一大小写、去空格、同义词映射 —— 避免分组被错误拆分
df["设备类型"] = df["设备类型"].str.strip().str.upper()

alias = {"苹果": "IOS", "安卓": "ANDROID", "笔记本电脑": "WINDOWS"}
df["设备类型"] = df["设备类型"].replace(alias)
```

### 去重

```python
df = df.drop_duplicates()                          # 全行重复
df = df.drop_duplicates(subset=["订单编号"])        # 按主键
```

---

## 三、分组聚合

```python
# 基础分组
g = df.groupby("月份", as_index=False).agg(
    销售额=("销售额_元", "sum"),
    订单数=("订单编号", "count"),
    客单价=("销售额_元", "mean"),
)

# 多列分组
g = df.groupby(["月份", "大区"], as_index=False)["销售额_元"].sum()

# 带条件筛选后再聚合
valid = df[~df["订单状态"].isin(["已取消", "已退款"])]
total = valid["销售额_元"].sum()

# 各分组占比
g["占比"] = g["销售额"] / g["销售额"].sum()

# 环比
g = g.sort_values("月份")
g["环比"] = g["销售额"].pct_change()
g["环比额"] = g["销售额"].diff()
```

### 透视表

```python
pt = df.pivot_table(index="设备类型", columns="事件类型",
                    values="事件编号", aggfunc="count", fill_value=0)
```

### 交叉表

```python
ct = pd.crosstab(df["事件类型"], df["设备类型"])
```

---

## 四、写回 Excel

```python
with pd.ExcelWriter(out_path, engine="openpyxl") as w:
    summary.to_excel(w, sheet_name="汇总", index=False)
    detail.to_excel(w, sheet_name="明细", index=False)
```

### 带格式（表头加粗、列宽、冻结）

```python
from openpyxl import load_workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

wb = load_workbook(out_path)
ws = wb["汇总"]

# 表头样式
for c in ws[1]:
    c.fill = PatternFill("solid", fgColor="2F6BFF")
    c.font = Font(color="FFFFFF", bold=True, size=10)
    c.alignment = Alignment(vertical="center", horizontal="center")

# 列宽
for i, w_ in enumerate([24, 16, 16, 60], 1):
    ws.column_dimensions[ws.cell(1, i).column_letter].width = w_

# 冻结首行
ws.freeze_panes = "A2"

# 自动换行
for row in ws.iter_rows(min_row=2):
    for c in row:
        c.alignment = Alignment(vertical="top", wrap_text=True)

wb.save(out_path)
```

---

## 五、openpyxl 独立校验路径（关键技巧）

做数据溯源校验时，**必须有第二条独立计算路径**。用 openpyxl 逐单元格读取原始值，
可以完全绕开 pandas 的类型推断与聚合逻辑，从而形成真正的交叉验证。

```python
from openpyxl import load_workbook

wb = load_workbook(path, read_only=True, data_only=True)
ws = wb["订单明细_A"]
rows = list(ws.iter_rows(values_only=True))

header = list(rows[0])
idx = {str(h).strip(): i for i, h in enumerate(header) if h is not None}

total = 0.0
n = 0
for r in rows[1:]:
    if r[idx["订单编号"]] is None or str(r[idx["订单编号"]]).strip() == "":
        continue                      # 跳过空行
    status = r[idx["订单状态"]]
    if status in ("已取消", "已退款"):
        continue                      # 口径：排除
    v = r[idx["销售额_元"]]
    if isinstance(v, (int, float)):
        total += float(v)
        n += 1

print(f"独立重算：{n} 行，合计 {total:,.2f}")
wb.close()
```

**要点**：
- `read_only=True` 提升大文件读取速度；`data_only=True` 读取公式的**计算结果**而非公式本身
  （若文件从未被 Excel 打开过，公式缓存可能为空，此时需注意）
- 用 `values_only=True` 取纯值元组，比 `cell()` 逐格访问快得多
- 独立路径要**故意采用与主脚本不同的实现方式**，否则失去交叉验证的意义

### 源文件指纹

证明"分析全程只读、结论可复现"，需要在开始与结束时各取一次哈希：

```python
import hashlib
from pathlib import Path

def fingerprint(path):
    md5, sha = hashlib.md5(), hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            md5.update(chunk); sha.update(chunk)
    return {"md5": md5.hexdigest(), "sha256": sha.hexdigest(),
            "size": Path(path).stat().st_size}

fp1 = fingerprint(path)
# ... 执行分析 ...
fp2 = fingerprint(path)
assert fp1["sha256"] == fp2["sha256"], "源文件被修改！"
```

---

## 六、中文与编码坑

### Windows 控制台输出乱码

```python
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
```

### matplotlib 中文显示为方块

```python
import matplotlib
matplotlib.use("Agg")          # 无界面环境必须设置，否则可能报错
from matplotlib import rcParams

rcParams["font.sans-serif"] = ["Microsoft YaHei", "PingFang SC", "SimHei",
                               "Noto Sans CJK SC", "WenQuanYi Zen Hei", "sans-serif"]
rcParams["axes.unicode_minus"] = False   # 否则负号显示为方块
```

（`Agg` 是**渲染后端**，`sans-serif` 是**字体族**，两者不同，不要混淆。）

### 检查可用中文字体

```python
import matplotlib.font_manager as fm
names = {f.name for f in fm.fontManager.ttflist}
for c in ["Microsoft YaHei", "SimHei", "PingFang SC", "Noto Sans CJK SC"]:
    print(c, c in names)
```

### CSV 编码

```python
df = pd.read_csv(path, encoding="utf-8-sig")      # 带 BOM 的 UTF-8（Excel 导出常见）
df = pd.read_csv(path, encoding="gbk")            # 中文 Windows 旧文件
df.to_csv(out, index=False, encoding="utf-8-sig") # 写出的 CSV 用 Excel 打开不乱码
```

### pandas 3.x 日期解析告警

对含大量文本的列调用 `pd.to_datetime` 会产生 `Could not infer format` 告警。
**正确做法是先做形态判断，只在样本确实像日期时才解析**：

```python
import warnings
warnings.filterwarnings("ignore", message=".*Could not infer format.*")

sample = col.dropna().astype(str).head(30)
hit = sample.str.match(
    r"^\d{4}[-/]\d{1,2}([-/]\d{1,2})?([ T]\d{1,2}:\d{2}(:\d{2})?)?$"
).mean()
if hit >= 0.8:
    dates = pd.to_datetime(col, errors="coerce")
```

---

## 七、Windows 路径

```python
from pathlib import Path

# 用原始字符串或正斜杠，避免反斜杠转义
path = r"D:\data\销售.xlsx"
path = Path("D:/data/销售.xlsx")     # 推荐：pathlib 自动处理

# 遍历目录下所有 Excel
for f in Path("D:/data").glob("*.xlsx"):
    print(f.name, f.stat().st_size)
```

---

## 八、性能提示

| 场景 | 建议 |
|---|---|
| 大文件探查 | `nrows=1000` 先看结构，再决定是否全量读 |
| 只需要部分列 | `usecols=[...]` 可显著提速 |
| 遍历 DataFrame 行 | 优先用向量化；必须遍历时用 `df.itertuples()`（比 `iterrows()` 快） |
| 逐单元格校验 | openpyxl `read_only=True` + `values_only=True` |
| 反复打印 | 拼接成列表最后 `"\n".join()` 一次性输出 |
