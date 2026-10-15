"""
经营偏差分析引擎
功能：对比计划值与实际值，识别偏差并归因
支持：业绩偏差、进度偏差、人力偏差
"""
import json, os
from metrics import build_metrics

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")


def load_metrics():
    p = os.path.join(DATA_DIR, "metrics.json")
    if os.path.exists(p):
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    return build_metrics()


def analyze_revenue_deviation():
    """收入偏差分析：计划 vs 实际"""
    m = load_metrics()
    bu2 = m["bu2"]
    q = bu2["quarter"]
    results = []

    # 事业二部确收
    actual_confirmed = q.get("confirmed_total")
    target_confirmed = q.get("confirmed_target")
    if actual_confirmed and target_confirmed:
        diff = round(actual_confirmed - target_confirmed, 2)
        rate = round(diff / target_confirmed * 100, 1)
        results.append({
            "department": "事业二部",
            "metric": "确收(万元)",
            "target": target_confirmed,
            "actual": actual_confirmed,
            "deviation": diff,
            "deviation_rate": rate,
            "status": "超目标" if diff > 0 else "未达标",
            "attribution": "云检确收集中在Q4，外部项目确收分布不均"
        })

    # 事业二部回款
    actual_recv = q.get("receivables_total")
    target_recv = q.get("receivables_target")
    if actual_recv and target_recv:
        diff = round(actual_recv - target_recv, 2)
        rate = round(diff / target_recv * 100, 1)
        results.append({
            "department": "事业二部",
            "metric": "回款(万元)",
            "target": target_recv,
            "actual": actual_recv,
            "deviation": diff,
            "deviation_rate": rate,
            "status": "超目标" if diff > 0 else "未达标",
            "attribution": "B端长回款特性，部分项目验收滞后"
        })

    # 事业一部
    bu1 = m["bu1"]
    sub = bu1["subtotal"]
    results.append({
        "department": "事业一部",
        "metric": "报表收入(万元)",
        "target": None,
        "actual": sub.get("I26"),
        "deviation": None,
        "deviation_rate": None,
        "status": "上半年业绩未达标",
        "attribution": "金牌订单下滑，外部项目拓展薄弱，团队执行力偏弱"
    })

    # 研究院
    ri = m["ri"]
    results.append({
        "department": "研究院",
        "metric": "确收(万元)",
        "target": None,
        "actual": ri.get("confirmed_revenue"),
        "deviation": None,
        "deviation_rate": None,
        "status": "确收集中Q4",
        "attribution": "外部53.1万+政策补贴10万，确收集中在Q4"
    })

    return results


def analyze_h1_deviation():
    """2026上半年偏差分析（基于工作汇报）"""
    m = load_metrics()
    h1 = m["company_h1_2026"]
    return {
        "period": "2026 H1",
        "overall": "上半年业绩未达标，承包制失败",
        "deviations": [
            {
                "area": "业绩达成",
                "issue": "业绩未达标",
                "root_cause": ["团队执行力偏弱、工作效率不足", "金牌订单下滑", "外部项目拓展薄弱，客户储备不足"],
                "action": "开拓外部市场，降低对金牌依赖"
            },
            {
                "area": "产品研发",
                "issue": "AI转型滞后",
                "root_cause": ["团队AI转型滞后，未能快速跟进业务升级"],
                "action": "加快团队AI转型，落地AI业务尝试与应用"
            },
            {
                "area": "云检交付",
                "issue": "金牌云检多基地进度顺延",
                "root_cause": [
                    "成都：打点器需厦门先行验证，验证进度不达预期；金牌无预算导致供应商付款未如期进行",
                    "厦门：鲲鹭首笔对供应商付款较慢，采购进度顺延",
                    "泗阳：单机移机涉及人工增补及打点器验证"
                ],
                "action": "加急推进打点器验证，协调金牌预算与供应商付款"
            },
            {
                "area": "人员结构",
                "issue": "人员冗余",
                "root_cause": ["人员结构冗余"],
                "action": "持续优化团队配置、提升人效（已协商离职11人）"
            },
            {
                "area": "承包制",
                "issue": "承包制失败",
                "root_cause": ["考核周期不匹配B端长回款特性", "高额摊销挂账导致利润失真", "后台管理成本分摊压力"],
                "action": "豁免亏损100万终止条款、拉长考核周期至自然年/项目全周期、下调暂缓后台成本分摊"
            }
        ],
        "headcount_change": h1["headcount"]
    }


def analyze_project_deviation():
    """项目级偏差：金牌云检、线项目等重点项目"""
    return [
        {
            "project": "金牌云检-封边检",
            "target": "655万，三基地在用",
            "actual": "成都/厦门/泗阳均存在顺延",
            "status": "进度滞后",
            "attribution": "打点器验证进度不达预期+金牌预算问题"
        },
        {
            "project": "金牌-线项目",
            "target": "540万，国家级验收",
            "actual": "已确认工信验收标准，首笔50%补贴600万可不退回，已完成9家供应商合同1550万",
            "status": "进行中",
            "attribution": "需补齐至10家供应商技改2500万"
        },
        {
            "project": "马来西亚金牌全球数智工厂",
            "target": "95万，Q1-Q2完成上线",
            "actual": "已完成验收，7月回款28.5万",
            "status": "超前完成",
            "attribution": "项目执行顺利"
        },
        {
            "project": "鲲擎平台",
            "target": "产品方向定义+智能体应用沉淀",
            "actual": "已定义产品方向，沉淀若干智能体应用，进入市场验证",
            "status": "按计划",
            "attribution": "研究院全员AI转型成功"
        }
    ]


def deviation_report():
    """生成完整偏差分析报告"""
    return {
        "revenue_deviation": analyze_revenue_deviation(),
        "h1_deviation": analyze_h1_deviation(),
        "project_deviation": analyze_project_deviation()
    }


if __name__ == "__main__":
    r = deviation_report()
    print(json.dumps(r, ensure_ascii=False, indent=2)[:3000])
