"""
规划生成引擎
功能：输出公司整体三一规划 + 各部门规划
参考 2024/2025 规划体例：经营回顾、市场洞察、战略路径、三一规划
"""
import json, os
from metrics import build_metrics
from goal_engine import decompose_company_goals
from deviation_engine import deviation_report

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")


def load_metrics():
    p = os.path.join(DATA_DIR, "metrics.json")
    if os.path.exists(p):
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    return build_metrics()


def generate_company_plan(year=2026):
    """生成公司整体三一规划"""
    m = load_metrics()
    plan = m["plan_2026"]
    goals = decompose_company_goals(year=year, half="H2")
    dev = deviation_report()

    return {
        "title": f"鲲鹭科技{year}年三一规划",
        "year": year,
        "sections": [
            {
                "name": "经营回顾",
                "content": {
                    "h1_summary": dev["h1_deviation"]["overall"],
                    "key_events": m["company_h1_2026"]["key_events"],
                    "headcount": m["company_h1_2026"]["headcount"],
                    "deviations": dev["h1_deviation"]["deviations"]
                }
            },
            {
                "name": "市场洞察",
                "content": {
                    "industry": "泛家居产业数字化+AI视觉检测+垂类大模型",
                    "core_products": ["云检（封边检/上下面检）", "鲲擎（家居垂类大模型+AI服务平台）", "1+N平台"],
                    "market_focus": "定制家居、板材制造、饰面纸制造；金牌供应链优质客户；徐工、上海飞机等外部龙头"
                }
            },
            {
                "name": "战略路径",
                "content": {
                    "positioning": "聚焦云检产品市场拓展+鲲擎垂类大模型构建，跑通产品商业模式，构建泛家居产业AI生态",
                    "reform": plan["reform"],
                    "strategy": "承包制纠偏→重定下半年目标→聚焦云检迭代+鲲擎体系+金牌线验收+标杆客户"
                }
            },
            {
                "name": "三一规划",
                "content": {
                    "company_goals": goals,
                    "financial_target": {"revenue_wan": 1000, "profit_wan": 50},
                    "key_initiatives": [
                        "云检产品迭代（算法自主可控）+其他行业视觉检测案例1项",
                        "鲲擎体系：家居垂类模型+AI服务平台（Token服务/智能应用服务）",
                        "金牌线项目国家级验收",
                        "市级以上项目申报1项",
                        "行业前十龙头客户标杆案例1项"
                    ]
                }
            }
        ]
    }


def generate_department_plan(department):
    """生成部门规划"""
    m = load_metrics()
    goals = decompose_company_goals(half="H2")

    # 从公司目标树中提取该部门承接的目标
    dept_goals = []
    for g in goals["company_goals"]:
        for sg in g["sub_goals"]:
            if sg["department"] == department:
                dept_goals.append({
                    "area": g["area"],
                    "company_target": g["target"],
                    "dept_target": sg["decomposed_target"],
                    "kpi": sg["kpi"]
                })

    # 部门业绩数据
    perf = {}
    if department == "事业一部":
        perf = m["bu1"]
    elif department == "事业二部":
        perf = m["bu2"]
    elif department == "研究院":
        perf = m["ri"]

    return {
        "department": department,
        "year": 2026,
        "承接的公司目标": dept_goals,
        "业绩基线": perf,
        "关键举措": _dept_actions(department, m),
        "风险与对策": _dept_risks(department)
    }


def _dept_actions(department, metrics):
    if department == "事业一部":
        return [
            "金牌海外数智工厂（马来/泰国/北美）交付与验收",
            "金牌SRM系列项目收尾与回款",
            "开拓外部市场，降低金牌订单依赖",
            "团队AI转型，提升人效"
        ]
    if department == "事业二部":
        return [
            "云检产品迭代（算法自主可控），签约≥150台",
            "金牌线项目国家级验收（补齐10家供应商2500万）",
            "外部龙头客户拓展（徐工/上海飞机/上海电气）",
            "鲲擎智能体在集团体系内推广"
        ]
    if department == "研究院":
        return [
            "交付家居行业垂类模型+AI服务平台（Token服务/智能应用服务）",
            "落地厦门市政集团智能体项目",
            "市级以上项目申报1项，筹备'揭榜挂帅'",
            "鲲擎产品平台成型，验证Token收费模式"
        ]
    return []


def _dept_risks(department):
    if department == "事业一部":
        return [{"risk": "金牌订单持续下滑", "mitigation": "开拓外部客户，扩充外部项目储备"}]
    if department == "事业二部":
        return [
            {"risk": "金牌云检进度顺延（打点器+预算）", "mitigation": "加急验证打点器，协调金牌预算"},
            {"risk": "B端长回款导致现金流压力", "mitigation": "拉长考核周期，豁免亏损终止条款"}
        ]
    if department == "研究院":
        return [{"risk": "鲲擎Token收费模式验证不确定", "mitigation": "先在集团体系内推广，沉淀用户池"}]
    return []


def generate_all_plans():
    """生成公司+全部部门规划"""
    return {
        "company_plan": generate_company_plan(),
        "department_plans": [
            generate_department_plan("事业一部"),
            generate_department_plan("事业二部"),
            generate_department_plan("研究院")
        ]
    }


if __name__ == "__main__":
    p = generate_all_plans()
    print(json.dumps(p, ensure_ascii=False, indent=2)[:3000])
