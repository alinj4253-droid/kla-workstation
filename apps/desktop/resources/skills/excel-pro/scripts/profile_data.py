#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
profile_data.py — Excel 多表结构画像与质量探查

一次性输出全部 sheet 的行列规模、字段类型、缺失分布、重复行、
枚举取值域、数值越界嫌疑、日期范围，用于分析前的快速诊断。

用法:
    python profile_data.py <文件.xlsx> [选项]

选项:
    --out <path.json>   将结构化结果写入 JSON（便于后续程序消费）
    --md  <path.md>     将摘要写入 Markdown（便于直接贴进报告）
    --max-enum <n>      枚举取值域展示上限，默认 30（超过则只显示前 n 个）
    --sheet <name>      仅分析指定 sheet（可重复传入）

依赖:
    pandas>=1.3, openpyxl>=3.0
    安装: pip install pandas openpyxl

示例:
    python profile_data.py sales.xlsx --out profile.json --md profile.md
    python profile_data.py sales.xlsx --sheet 订单明细
"""

import argparse
import json
import sys
import warnings
from datetime import datetime
from pathlib import Path

try:
    import pandas as pd
except ImportError:
    sys.exit("缺少依赖: pandas。请执行  pip install pandas openpyxl")

# pandas 3.x 对无法推断格式的列会逐元素告警，抑制该噪音（我们自行做形态判断）
warnings.filterwarnings("ignore", message=".*Could not infer format.*")

# Windows 控制台默认 GBK，中文输出易乱码，统一切到 UTF-8
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass


# ---------------------------------------------------------------- 工具函数
def is_blank(v) -> bool:
    """判断单元格是否为空：None、空串、纯空白 都算空"""
    if v is None:
        return True
    if isinstance(v, float) and pd.isna(v):
        return True
    if isinstance(v, str) and v.strip() == "":
        return True
    return False


def safe_num(v):
    """尽力转数值；失败返回 None（用于识别'文本混入数值列'）"""
    if is_blank(v):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).strip().replace(",", "").replace("，", ""))
    except (ValueError, TypeError):
        return None


def classify_column(series: pd.Series) -> dict:
    """判断列的数据形态：数值型 / 日期型 / 文本型 / 数值混文本"""
    non_null = series.dropna()
    if len(non_null) == 0:
        return {"kind": "空列", "type": str(series.dtype)}

    n_num = sum(1 for v in non_null if safe_num(v) is not None)
    ratio_num = n_num / len(non_null)

    # 先做日期「形态」前置判断：只有在样本确实像日期时才尝试解析，
    # 避免对纯文本列逐元素解析（慢且产生大量告警）
    ratio_date = 0.0
    if pd.api.types.is_datetime64_any_dtype(series):
        ratio_date = 1.0
    elif not pd.api.types.is_numeric_dtype(series):
        try:
            sample = non_null.astype(str).head(30)
            hit = sample.str.match(
                r"^\d{4}[-/]\d{1,2}([-/]\d{1,2})?([ T]\d{1,2}:\d{2}(:\d{2})?)?$"
            ).mean()
            if hit >= 0.8:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    sample_dt = pd.to_datetime(non_null.head(30), errors="coerce")
                ratio_date = sample_dt.notna().mean()
        except Exception:
            ratio_date = 0.0

    if pd.api.types.is_datetime64_any_dtype(series):
        kind = "日期型"
    elif ratio_num >= 0.999:
        kind = "数值型"
    elif 0 < ratio_num < 0.999:
        kind = "数值混入文本"          # ← 高危：会让整列 dtype 退化为 object
    elif ratio_date >= 0.999:
        kind = "日期型（文本存储）"     # ← 需统一为 datetime
    else:
        kind = "文本型"
    return {"kind": kind, "type": str(series.dtype)}


def profile_sheet(df: pd.DataFrame, name: str, max_enum: int = 30) -> dict:
    """对单个 sheet 做完整画像"""
    n_rows, n_cols = df.shape
    info = {
        "name": name,
        "rows": int(n_rows),
        "cols": int(n_cols),
        "columns": [],
        "duplicate_rows": int(df.duplicated().sum()),
        "issues": [],
    }

    for col in df.columns:
        s = df[col]
        blank_mask = s.map(is_blank)
        n_blank = int(blank_mask.sum())
        valid = s[~blank_mask]
        ctype = classify_column(s)

        col_info = {
            "name": str(col),
            "dtype": str(s.dtype),
            "kind": ctype["kind"],
            "n_blank": n_blank,
            "blank_pct": round(n_blank / n_rows * 100, 2) if n_rows else 0.0,
            "n_unique": int(valid.nunique()),
        }

        # 枚举取值域：低基数列给出全部取值，便于识别非法值
        if 0 < col_info["n_unique"] <= max_enum:
            vals = sorted(valid.unique().tolist(), key=lambda x: str(x))
            col_info["enum"] = [str(v) for v in vals]
        # 形态提示
        if ctype["kind"] == "数值混入文本":
            bad = valid[[safe_num(v) is None for v in valid]]
            col_info["non_numeric_samples"] = [str(v) for v in bad.unique().tolist()[:5]]
            info["issues"].append(
                f"字段「{col}」混入 {len(bad)} 个非数值文本（如 {col_info['non_numeric_samples'][:3]}），"
                f"建议清洗后再参与计算")
        if ctype["kind"] == "日期型（文本存储）":
            info["issues"].append(f"字段「{col}」日期以文本存储，建议统一转为 datetime 类型")
        if n_blank > 0 and n_blank / n_rows > 0.5:
            info["issues"].append(f"字段「{col}」缺失率高达 {col_info['blank_pct']}%，慎用")

        if pd.api.types.is_numeric_dtype(s) and ctype["kind"] == "数值型":
            nn = valid
            if len(nn):
                col_info["min"] = float(nn.min())
                col_info["max"] = float(nn.max())
                col_info["mean"] = round(float(nn.mean()), 4)
                n_neg = int((nn < 0).sum())
                n_zero = int((nn == 0).sum())
                if n_neg:
                    col_info["n_negative"] = n_neg
                if n_zero:
                    col_info["n_zero"] = n_zero
        elif ctype["kind"] in ("日期型", "日期型（文本存储）"):
            # 文本存储的日期需先转换再取区间，否则按字符串比较会失真
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                dts = pd.to_datetime(valid, errors="coerce").dropna()
            if len(dts):
                col_info["date_min"] = str(dts.min())
                col_info["date_max"] = str(dts.max())
        info["columns"].append(col_info)

    if info["duplicate_rows"]:
        info["issues"].append(f"存在 {info['duplicate_rows']} 行完全重复记录")
    return info


# ---------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser(
        description="Excel 多表结构画像与质量探查",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("xlsx", help="待分析的文件路径（.xlsx/.xlsm）")
    ap.add_argument("--out", help="结构化结果输出 JSON 路径")
    ap.add_argument("--md", help="摘要输出 Markdown 路径")
    ap.add_argument("--max-enum", type=int, default=30, help="枚举取值域展示上限（默认 30）")
    ap.add_argument("--sheet", action="append", help="仅分析指定 sheet，可重复传入")
    args = ap.parse_args()

    path = Path(args.xlsx)
    if not path.exists():
        sys.exit(f"文件不存在: {path}")

    xl = pd.ExcelFile(path)
    targets = args.sheet if args.sheet else xl.sheet_names

    result = {
        "source_file": str(path.resolve()),
        "file_size": path.stat().st_size,
        "profiled_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "sheet_names": list(xl.sheet_names),
        "sheets": [],
    }
    total_rows = 0

    lines = [f"# 数据画像报告", "",
             f"- 源文件：`{path.name}`（{path.stat().st_size:,} 字节）",
             f"- 分析时间：{result['profiled_at']}",
             f"- 表数量：{len(xl.sheet_names)}", ""]

    for sn in targets:
        if sn not in xl.sheet_names:
            print(f"⚠ 跳过不存在的 sheet: {sn}")
            continue
        df = pd.read_excel(path, sheet_name=sn)
        info = profile_sheet(df, sn, args.max_enum)
        result["sheets"].append(info)
        total_rows += info["rows"]

        print("=" * 72)
        print(f"【{sn}】 {info['rows']} 行 × {info['cols']} 列"
              f"{'  ★ 全行重复 ' + str(info['duplicate_rows']) + ' 行' if info['duplicate_rows'] else ''}")
        print("-" * 72)
        for c in info["columns"]:
            extra = ""
            if "enum" in c:
                show = c["enum"][:12]
                extra = "  枚举=" + ", ".join(show) + (" ..." if len(c["enum"]) > 12 else "")
            elif "min" in c:
                extra = f"  [{c['min']:g}, {c['max']:g}] 均值{c['mean']:g}"
                if c.get("n_negative"):
                    extra += f" 负值{c['n_negative']}"
                if c.get("n_zero"):
                    extra += f" 零值{c['n_zero']}"
            elif "date_min" in c:
                extra = f"  {c['date_min']} ~ {c['date_max']}"
            blank = f"  空{c['n_blank']}({c['blank_pct']}%)" if c["n_blank"] else ""
            print(f"  {c['name']:<20} {c['kind']:<14}{blank}{extra}")
        if info["issues"]:
            print("  ⚠ 提示:")
            for it in info["issues"]:
                print(f"     - {it}")

        lines += [f"## {sn}", "",
                  f"规模：**{info['rows']:,} 行 × {info['cols']} 列**"
                  + (f"　｜　全行重复 **{info['duplicate_rows']}** 行" if info["duplicate_rows"] else ""),
                  "",
                  "| 字段 | 形态 | 空值 | 空值占比 | 唯一值 | 取值范围 / 枚举 |",
                  "|---|---|---|---|---|---|"]
        for c in info["columns"]:
            if "enum" in c:
                rng = ", ".join(c["enum"][:8]) + (" ..." if len(c["enum"]) > 8 else "")
            elif "min" in c:
                rng = f"{c['min']:g} ~ {c['max']:g}"
            elif "date_min" in c:
                rng = f"{c['date_min']} ~ {c['date_max']}"
            else:
                rng = ""
            lines.append(f"| {c['name']} | {c['kind']} | {c['n_blank']} | "
                         f"{c['blank_pct']}% | {c['n_unique']} | {rng} |")
        if info["issues"]:
            lines += ["", "**提示：**", ""] + [f"- {it}" for it in info["issues"]]
        lines.append("")

    result["total_rows"] = total_rows
    print("=" * 72)
    print(f"合计 {len(result['sheets'])} 张表，{total_rows:,} 行数据")

    if args.out:
        Path(args.out).write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"✔ JSON 已写入: {args.out}")
    if args.md:
        Path(args.md).write_text("\n".join(lines), encoding="utf-8")
        print(f"✔ Markdown 已写入: {args.md}")


if __name__ == "__main__":
    main()
