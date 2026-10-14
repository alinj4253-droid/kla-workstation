#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cross_validate.py — 数据溯源校验与双路径对账

核心用途：让交付的每个数字都能回答「来自哪张表、哪几行、什么计算式」。
本脚本刻意使用 openpyxl 逐单元格读取原始值，作为独立于 pandas 的第二条计算路径，
与主分析脚本（通常基于 pandas）的结果对账。

三大能力:
    1. 源文件指纹      —— SHA256/MD5/大小/修改时间，证明分析过程只读、可复现
    2. 独立重算        —— 指定列的逐格求和 / 计数（可带排除条件）
    3. 双向勾稽对账    —— 明细表 vs 汇总表按多列分组键逐组合比对

用法:
    # 1) 仅取指纹 + 全部表行数
    python cross_validate.py data.xlsx

    # 2) 独立重算：销售额合计（排除已取消/已退款），并计数
    python cross_validate.py data.xlsx --sheet 订单明细_A \
        --sum 销售额_元 --sum 成本_元 --count \
        --filter-col 订单状态 --filter-exclude 已取消,已退款

    # 3) 双向勾稽：明细按 订单日期+大区 聚合 vs 汇总表按月+大区
    python cross_validate.py data.xlsx \
        --reconcile-detail 订单明细_A --reconcile-d-keys 订单日期,大区 \
        --reconcile-d-value 销售额_元 \
        --reconcile-summary 月度销售汇总 --reconcile-s-keys 月份,大区 \
        --reconcile-s-value 销售额_元

依赖: openpyxl>=3.0   （pip install openpyxl）
"""

import argparse
import hashlib
import json
import sys
from collections import defaultdict
from datetime import datetime, date
from pathlib import Path

try:
    from openpyxl import load_workbook
except ImportError:
    sys.exit("缺少依赖: openpyxl。请执行  pip install openpyxl")

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass


# ---------------------------------------------------------------- 基础工具
def file_fingerprint(path: Path) -> dict:
    """计算源文件指纹。用于证明分析全程只读、结论可复现。"""
    md5, sha = hashlib.md5(), hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            md5.update(chunk)
            sha.update(chunk)
    st = path.stat()
    return {
        "path": str(path.resolve()),
        "size_bytes": st.st_size,
        "mtime": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
        "md5": md5.hexdigest(),
        "sha256": sha.hexdigest(),
    }


def to_num(v):
    """安全转数值。None / 空串 / 文本 → None，避免脏数据导致脚本崩溃"""
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


def key_norm(v) -> str:
    """分组键归一化：日期取年月、文本去空格、数值统一格式。
    这是双路径对账能对上的关键——两表键的形态常常不一致。"""
    if v is None:
        return ""
    if isinstance(v, (datetime, date)):
        return f"{v.year:04d}-{v.month:02d}"
    if isinstance(v, str):
        s = v.strip()
        # 尝试识别 YYYY-MM 或 YYYY-MM-DD 形态，统一到 YYYY-MM
        if len(s) >= 7 and s[4] in "-/":
            try:
                y, m = int(s[:4]), int(s[5:7])
                return f"{y:04d}-{m:02d}"
            except ValueError:
                return s
        return s
    return str(v).strip()


def load_sheet(wb, name: str):
    """读取整表：返回 (表头列表, 数据行列表, 列名→索引)"""
    if name not in wb.sheetnames:
        sys.exit(f"sheet 不存在: {name}（可选: {wb.sheetnames}）")
    rows = list(wb[name].iter_rows(values_only=True))
    if not rows:
        sys.exit(f"sheet 为空: {name}")
    header = list(rows[0])
    idx = {str(h).strip(): i for i, h in enumerate(header) if h is not None}
    data = [r for r in rows[1:]
            if any(c is not None and str(c).strip() != "" for c in r)]
    return header, data, idx


# ---------------------------------------------------------------- 独立重算
def independent_recalc(path, sheet, sum_cols, do_count, filter_col, exclude_set):
    wb = load_workbook(path, read_only=True, data_only=True)
    header, data, idx = load_sheet(wb, sheet)

    totals = {c: 0.0 for c in (sum_cols or [])}
    n_used = n_excluded = 0
    n_nonnumeric = {c: 0 for c in (sum_cols or [])}

    ex_idx = idx.get(filter_col) if filter_col else None
    for r in data:
        if ex_idx is not None:
            val = r[ex_idx] if ex_idx < len(r) else None
            if val is not None and str(val).strip() in exclude_set:
                n_excluded += 1
                continue
        n_used += 1
        for c in (sum_cols or []):
            x = to_num(r[idx[c]]) if c in idx else None
            if x is None:
                # 空值不计入合计，但单独统计，避免「静默吞掉脏数据」
                if r[idx[c]] is not None and str(r[idx[c]]).strip() != "":
                    n_nonnumeric[c] += 1
                continue
            totals[c] += x

    wb.close()
    out = {
        "sheet": sheet,
        "rows_total": len(data),
        "rows_used": n_used,
        "rows_excluded": n_excluded,
        "sums": {k: round(v, 2) for k, v in totals.items()},
    }
    if do_count:
        out["count"] = n_used
    if any(n_nonnumeric.values()):
        out["non_numeric_cells"] = {k: v for k, v in n_nonnumeric.items() if v}

    print(f"\n【独立重算】sheet = {sheet}")
    print(f"  数据行 {len(data)} → 参与计算 {n_used} 行"
          + (f"，按「{filter_col}」排除 {n_excluded} 行（{','.join(sorted(exclude_set))}）"
             if n_excluded else ""))
    for k, v in out["sums"].items():
        print(f"  Σ {k} = {v:,.2f}")
    for k, v in out.get("non_numeric_cells", {}).items():
        print(f"  ⚠ 「{k}」有 {v} 个非数值单元格被跳过，请核查")
    return out


# ---------------------------------------------------------------- 双向勾稽
def reconcile(path, d_sheet, d_keys, d_value, s_sheet, s_keys, s_value):
    """明细表按多列键聚合，与汇总表逐组合比对。
    只报告「明细有汇总无」（真缺失）与「汇总有明细无」（凭空多出），
    绝不用维度笛卡尔积判定缺失——那会把「本就无业务」误判为缺行。"""
    wb = load_workbook(path, read_only=True, data_only=True)

    _, d_data, d_idx = load_sheet(wb, d_sheet)
    _, s_data, s_idx = load_sheet(wb, s_sheet)

    agg = defaultdict(float)
    for r in d_data:
        k = tuple(key_norm(r[d_idx[c]]) for c in d_keys)
        agg[k] += to_num(r[d_idx[d_value]]) or 0.0

    s_map = {}
    for r in s_data:
        k = tuple(key_norm(r[s_idx[c]]) for c in s_keys)
        s_map[k] = to_num(r[s_idx[s_value]]) or 0.0
    wb.close()

    all_keys = sorted(set(agg) | set(s_map), key=lambda t: tuple(str(x) for x in t))
    only_detail, only_summary, mismatches = [], [], []

    print(f"\n【双向勾稽】{d_sheet}({'+'.join(d_keys)} → {d_value}) "
          f"vs {s_sheet}({'+'.join(s_keys)} → {s_value})")
    print(f"  明细组合数 {len(agg)}　汇总组合数 {len(s_map)}　并集 {len(all_keys)}")
    print("-" * 78)
    print(f"  {'组合':<24}{'明细':>16}{'汇总':>16}{'差异':>14}")
    for k in all_keys:
        a, b = agg.get(k), s_map.get(k)
        label = " / ".join(k)
        if a is None:
            only_summary.append({"key": label, "summary": round(b, 2)})
            print(f"  {label:<24}{'—':>16}{b:>16,.2f}{'★汇总有明细无':>14}")
        elif b is None:
            only_detail.append({"key": label, "detail": round(a, 2)})
            print(f"  {label:<24}{a:>16,.2f}{'—':>16}{'★明细有汇总无':>14}")
        else:
            d = a - b
            flag = "" if abs(d) < 0.01 else "★"
            if abs(d) >= 0.01:
                mismatches.append({"key": label, "detail": round(a, 2),
                                   "summary": round(b, 2), "diff": round(d, 2)})
            if abs(d) >= 0.01:
                print(f"  {label:<24}{a:>16,.2f}{b:>16,.2f}{d:>14,.2f}{flag:>6}")
    print("-" * 78)
    td, ts = sum(agg.values()), sum(s_map.values())
    print(f"  {'合计':<24}{td:>16,.2f}{ts:>16,.2f}{td - ts:>14,.2f}")
    print(f"\n  真缺失（明细有汇总无）: {len(only_detail)} 个")
    print(f"  凭空多出（汇总有明细无）: {len(only_summary)} 个")
    print(f"  数值不一致: {len(mismatches)} 个")
    if not (only_detail or only_summary or mismatches):
        print("  ✓ 双向勾稽完全通过：两表同源，无缺失、无多出、无差异")

    return {"detail_sheet": d_sheet, "summary_sheet": s_sheet,
            "n_detail_keys": len(agg), "n_summary_keys": len(s_map),
            "total_detail": round(td, 2), "total_summary": round(ts, 2),
            "total_diff": round(td - ts, 2),
            "only_in_detail": only_detail, "only_in_summary": only_summary,
            "value_mismatches": mismatches}


# ---------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser(
        description="数据溯源校验与双路径对账",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("xlsx", help="源数据文件路径")
    ap.add_argument("--sheet", help="独立重算的目标 sheet")
    ap.add_argument("--sum", action="append", default=[], help="要求和的列，可重复")
    ap.add_argument("--count", action="store_true", help="输出参与计算的行数")
    ap.add_argument("--filter-col", help="排除条件所依据的列")
    ap.add_argument("--filter-exclude", default="", help="要排除的取值，逗号分隔")
    ap.add_argument("--reconcile-detail", help="勾稽用：明细表名")
    ap.add_argument("--reconcile-d-keys", help="勾稽用：明细分组键列，逗号分隔")
    ap.add_argument("--reconcile-d-value", help="勾稽用：明细数值列")
    ap.add_argument("--reconcile-summary", help="勾稽用：汇总表名")
    ap.add_argument("--reconcile-s-keys", help="勾稽用：汇总分组键列，逗号分隔")
    ap.add_argument("--reconcile-s-value", help="勾稽用：汇总数值列")
    ap.add_argument("--out", help="结果输出 JSON 路径")
    args = ap.parse_args()

    path = Path(args.xlsx)
    if not path.exists():
        sys.exit(f"文件不存在: {path}")

    report = {"validated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}

    # ---- 1. 指纹 ----
    fp = file_fingerprint(path)
    report["source_fingerprint"] = fp
    print("=" * 78)
    print("源文件指纹（证明全程只读、结论可复现）")
    print("=" * 78)
    for k, v in fp.items():
        print(f"  {k:12s}: {v}")

    # ---- 2. 各表行数独立计数 ----
    wb = load_workbook(path, read_only=True, data_only=True)
    rows_info, total = {}, 0
    print("\n" + "=" * 78)
    print("各表行数（openpyxl 独立计数）")
    print("=" * 78)
    for sn in wb.sheetnames:
        _, data, _ = load_sheet(wb, sn)
        rows_info[sn] = len(data)
        total += len(data)
        print(f"  {sn:14s} {len(data):>6} 行")
    print(f"  {'合计':14s} {total:>6} 行")
    wb.close()
    report["sheet_rows"] = rows_info
    report["total_rows"] = total

    # ---- 3. 独立重算 ----
    if args.sheet:
        excl = {x.strip() for x in args.filter_exclude.split(",") if x.strip()}
        report["independent_recalc"] = independent_recalc(
            path, args.sheet, args.sum, args.count, args.filter_col, excl)

    # ---- 4. 双向勾稽 ----
    if args.reconcile_detail and args.reconcile_summary:
        report["reconcile"] = reconcile(
            path,
            args.reconcile_detail,
            [c.strip() for c in args.reconcile_d_keys.split(",")],
            args.reconcile_d_value,
            args.reconcile_summary,
            [c.strip() for c in args.reconcile_s_keys.split(",")],
            args.reconcile_s_value)

    # ---- 5. 源文件哈希复验（确认整个过程未写入）----
    fp2 = file_fingerprint(path)
    same = fp2["sha256"] == fp["sha256"]
    report["source_unchanged"] = same
    print("\n" + "=" * 78)
    print(f"源文件哈希复验: {'✓ 未被修改' if same else '★ 已变化，请排查是否有写入操作'}")
    print("=" * 78)

    if args.out:
        Path(args.out).write_text(
            json.dumps(report, ensure_ascii=False, indent=2, default=str),
            encoding="utf-8")
        print(f"✔ 校验结果已写入: {args.out}")


if __name__ == "__main__":
    main()
