"""
目标拆解引擎
功能：将公司整体目标拆解为部门目标，再拆解为项目/任务级目标
支持：按年度/季度拆解，跟踪达成状态
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


def decompose_company_goals(year=2026, half="H2"):
    """
    公司目标 → 部门目标拆解
    返回层级化目标树
    """
    m = load_metrics()
    plan = m["plan_2026"]

    goals = plan["H2_goals"] if half == "H2" else plan.get("H1_goals", [])

    # 各部门承接映射
    dept_map = {
        "云检产品研发": ["事业二部"],
        "鲲擎体系开发": ["研究院", "事业二部"],
        "国家项目": ["事业二部"],
        "项目申报": ["研究院"],
        "标杆型客户项目": ["事业一部", "事业二部"],
        "财务": ["事业一部", "事业二部", "研究院"],
    }

    tree = {
        "company": "鲲鹭科技",
        "year": year,
        "period": half,
        "reform": plan["reform"],
        "company_goals": [],
    }

    for g in goals:
        node = {
            "no": g["no"],
            "area": g["area"],
            "target": g["target"],
            "owning_departments": dept_map.get(g["area"], []),
            "sub_goals": [],
        }
        # 拆解到部门
        for dept in dept_map.get(g["area"], []):
            node["sub_goals"].append({
                "department": dept,
                "decomposed_target": _decompose_to_dept(g, dept, m),
                "kpi": _dept_kpi(g, dept, m),
            })
        tree["company_goals"].append(node)

    return tree


def _decompose_to_dept(goal, dept, metrics):
    area = goal["area"]
    if area == "云检产品研发":
        if dept == "事业二部":
            return "完成云检产品迭代（算法自主可控），落地视觉检测其他行业案例1项，签约≥150台，确收≥87万"
    if area == "鲲擎体系开发":
        if dept == "研究院":
            return "交付1个家居行业垂类模型，搭建人工智能服务平台（Token服务+智能应用服务），落地厦门市政集团智能体项目"
        if dept == "事业二部":
            return "配合鲲擎智能体在集团体系内推广，沉淀智能体应用≥5个，验证Token收费模式"
    if area == "国家项目":
        if dept == "事业二部":
            return "完成金牌线项目国家级验收（10家供应商技改2500万，已完成9家1550万）"
    if area == "项目申报":
        if dept == "研究院":
            return "申报市级以上项目1项，筹备厦门市'揭榜挂帅'等补贴项目"
    if area == "标杆型客户项目":
        if dept == "事业一部":
            return "服务行业前十龙头客户案例1项（金牌/海外数智工厂方向）"
        if dept == "事业二部":
            return "服务行业前十龙头客户案例1项（徐工/上海飞机/上海电气方向）"
    if area == "财务":
        bu = metrics.get("bu1" if "一" in dept else "bu2" if "二" in dept else "ri", {})
        if dept == "事业一部":
            return f"支撑公司营收1000万、利润50万；本部门确收{bu.get('subtotal',{}).get('I26','394.01')}万"
        if dept == "事业二部":
            return f"支撑公司营收1000万、利润50万；本部门确收{bu.get('quarter',{}).get('G6','1489')}万"
        if dept == "研究院":
            return f"支撑公司利润50万；本部门确收{bu.get('confirmed_revenue','63.1')}万，政策补贴{bu.get('policy_subsidy','10')}万"
    return goal["target"]


def _dept_kpi(goal, dept, metrics):
    area = goal["area"]
    if area == "财务":
        return {"revenue_target_wan": 1000, "profit_target_wan": 50}
    if area == "云检产品研发":
        return {"units": 150, "confirmed_revenue_wan": 87}
    if area == "鲲擎体系开发":
        return {"agents": 5, "token_service": "上线"}
    return {}


def track_goal_status(goal_no, actual_value, target_value):
    """跟踪单个目标达成状态"""
    try:
        a = float(actual_value)
        t = float(target_value)
        rate = a / t if t else 0
        status = "达标" if rate >= 1 else ("进行中" if rate > 0 else "未启动")
        return {"goal_no": goal_no, "actual": a, "target": t, "completion_rate": round(rate * 100, 1), "status": status}
    except (TypeError, ValueError):
        return {"goal_no": goal_no, "actual": actual_value, "target": target_value, "status": "需人工评估"}


def quarter_decompose(annual_target_wan, q1=0.15, q2=0.25, q3=0.30, q4=0.30):
    """年度目标按季度拆解（默认权重可配）"""
    weights = {"Q1": q1, "Q2": q2, "Q3": q3, "Q4": q4}
    return {q: round(annual_target_wan * w, 2) for q, w in weights.items()}


if __name__ == "__main__":
    tree = decompose_company_goals()
    print(json.dumps(tree, ensure_ascii=False, indent=2)[:3000])
