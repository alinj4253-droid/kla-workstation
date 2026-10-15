"""
业务指标提取：从知识库中提取关键经营指标，供偏差分析和规划生成使用
"""
import json, os

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")


def load_kb():
    with open(os.path.join(DATA_DIR, "knowledge_base.json"), "r", encoding="utf-8") as f:
        return json.load(f)


def cell(rows, r_idx, c_idx):
    """取第 r_idx 行第 c_idx 列的值（0-based）"""
    if r_idx < len(rows) and c_idx < len(rows[r_idx]):
        return rows[r_idx][c_idx].get("value")
    return None


def extract_bu1(kb):
    """事业一部 2026 业绩"""
    doc = next(d for d in kb["documents"] if d["id"] == "bu1_2026")
    rows = doc["sheets"][0]["rows"]
    # 关键项目行（从原表结构提取）
    items = []
    for r in rows:
        # 每行是 [{cell, value}, ...]，取 B 列(项目名)
        b_val = None
        for c in r:
            if c["cell"].startswith("B"):
                b_val = c["value"]
        if b_val and str(b_val) not in ("项目", "小计", "项目名称"):
            items.append(str(b_val))
    # 小计行：找到含"小计"的行
    subtotal_row = None
    for r in rows:
        vals = [c["value"] for c in r]
        if any(v == "小计" for v in vals):
            subtotal_row = r
            break
    return {
        "department": "事业一部",
        "projects": items,
        "subtotal": {c["cell"]: c["value"] for c in subtotal_row} if subtotal_row else {},
        "tax_total": 3.05,
        "summary": "待签约481.57万 / 已回款446.25万 / 预计回款408.22万 / 合同确收422.57万 / 报表收入394.01万"
    }


def extract_bu2(kb):
    """事业二部 2026 业绩"""
    doc = next(d for d in kb["documents"] if d["id"] == "bu2_2026")
    sheets = {s["name"]: s["rows"] for s in doc["sheets"]}
    # 外部项目汇总
    ext_rows = sheets.get("外部", [])
    ext_summary = {}
    for r in ext_rows:
        for c in r:
            if c["cell"] in ("E9", "F9", "C9", "I5", "I6", "I7", "I8", "J7", "J8"):
                ext_summary[c["cell"]] = c["value"]
    # 云检
    yj_rows = sheets.get("26年-云检", [])
    yj_total = {}
    for r in yj_rows:
        for c in r:
            if c["cell"] in ("B15", "C15", "G15", "H15"):
                yj_total[c["cell"]] = c["value"]
    # 鲲擎
    kq_rows = sheets.get("鲲擎", [])
    kq_total = {}
    for r in kq_rows:
        for c in r:
            if c["cell"] in ("G10", "I10", "G11"):
                kq_total[c["cell"]] = c["value"]
    # 季度明细
    q_rows = sheets.get("26季度数据明细表", [])
    quarter = {}
    for r in q_rows:
        for c in r:
            if c["cell"] in ("G6", "H6", "G10", "H10"):
                quarter[c["cell"]] = c["value"]
    return {
        "department": "事业二部",
        "external": {"revenue_untaxed": ext_summary.get("E9"), "cost_untaxed": ext_summary.get("F9"),
                     "gross_profit": ext_summary.get("C9"), "receivables": ext_summary.get("I5"),
                     "confirmed_revenue": ext_summary.get("I6")},
        "yunjian": {"units_signed": yj_total.get("B15"), "amount_signed": yj_total.get("C15"),
                    "confirmed_amount": yj_total.get("G15"), "report_revenue": yj_total.get("H15")},
        "kunqing": {"software_total": kq_total.get("G10"), "ri_fee": kq_total.get("I10")},
        "quarter": {"confirmed_total": quarter.get("G6"), "confirmed_target": quarter.get("H6"),
                    "receivables_total": quarter.get("G10"), "receivables_target": quarter.get("H10")},
        "tax_total": 0.51
    }


def extract_ri(kb):
    """研究院 2026 业绩"""
    doc = next(d for d in kb["documents"] if d["id"] == "ri_2026")
    rows = doc["sheets"][0]["rows"]
    data = {}
    for r in rows:
        for c in r:
            data[c["cell"]] = c["value"]
    return {
        "department": "研究院",
        "confirmed_revenue": data.get("G5"),  # 合计确收
        "receivables": data.get("G8"),  # 合计回款
        "external_revenue": data.get("G3"),
        "policy_subsidy": data.get("G4")
    }


def extract_2026_plan_from_text():
    """用户提供的 2026 规划文字"""
    return {
        "year": 2026,
        "reform": "经营重大改革，改为承包制；上半年拆分事业一部、二部、三部；7月评定承包制失败，重新制定下半年目标",
        "H2_goals": [
            {"no": 1, "area": "云检产品研发", "target": "迭代（算法自主可控）、云检行业拓展：视觉检测项目其他行业案例1项"},
            {"no": 2, "area": "鲲擎体系开发", "target": "一个家居行业垂类模型，人工智能服务平台（token服务、智能应用服务）"},
            {"no": 3, "area": "国家项目", "target": "金牌线项目验收"},
            {"no": 4, "area": "项目申报", "target": "市级以上项目1项"},
            {"no": 5, "area": "标杆型客户项目", "target": "龙头客户（行业前十）服务案例1项"},
            {"no": 6, "area": "财务", "target": "营收1000万，利润50万"}
        ]
    }


def build_metrics():
    kb = load_kb()
    return {
        "bu1": extract_bu1(kb),
        "bu2": extract_bu2(kb),
        "ri": extract_ri(kb),
        "plan_2026": extract_2026_plan_from_text(),
        "company_h1_2026": {
            "headcount": {"start": 43, "end": 30, "hired": 3, "left": 16},
            "departments_hc": {"事业一部": 12, "事业二部": 7, "研究院": 2, "公共": 9},
            "key_events": [
                "马来西亚金牌全球数智工厂验收，7月回款28.5万",
                "金牌线项目：已确认工信验收标准，首笔50%补贴600万可不退回；已收9家供应商合同1550万",
                "云检金牌封边检655万、上下面合计197.4万在执行",
                "鲲擎平台已定义产品方向，沉淀智能体应用，进入市场验证",
                "协商离职11人，2人零成本劝退，节约解聘成本11万",
                "承包制上半年未达标，7月评定失败"
            ]
        }
    }


if __name__ == "__main__":
    m = build_metrics()
    out = os.path.join(DATA_DIR, "metrics.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=2)
    print("metrics saved:", os.path.getsize(out), "bytes")
    print(json.dumps(m, ensure_ascii=False, indent=2)[:2000])
