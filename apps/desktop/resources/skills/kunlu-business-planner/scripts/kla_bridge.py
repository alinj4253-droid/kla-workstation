"""Small, deterministic bridge used by the Electron local tool adapter.

The model never supplies Python source. It supplies a validated JSON request;
this bridge dispatches only to the packaged business-planner functions.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

from deviation_engine import analyze_h1_deviation, analyze_project_deviation, deviation_report
from goal_engine import decompose_company_goals
from metrics import build_metrics
from plan_engine import generate_all_plans, generate_company_plan, generate_department_plan
from ppt_engine import generate_company_ppt, generate_department_ppt


def dispatch(request: dict, output: Path) -> dict:
    action = request.get("action")
    args = request.get("args") or {}
    if action == "metrics":
        return {"kind": "metrics", "data": build_metrics()}
    if action == "goal_decompose":
        return {"kind": "goal_decompose", "data": decompose_company_goals(year=int(args.get("year", 2026)), half=str(args.get("half", "H2")))}
    if action == "deviation":
        scope = str(args.get("scope", "all"))
        report = deviation_report()
        data = {
            "all": report,
            "revenue": report["revenue_deviation"],
            "h1": analyze_h1_deviation(),
            "project": analyze_project_deviation(),
        }.get(scope, report)
        return {"kind": "deviation", "scope": scope, "data": data}
    if action == "plan":
        plan_type = str(args.get("type", "all"))
        year = int(args.get("year", 2026))
        if plan_type == "company":
            data = generate_company_plan(year=year)
        elif plan_type == "department":
            department = str(args.get("department") or "").strip()
            if not department:
                raise ValueError("部门规划需要 department")
            data = generate_department_plan(department)
        else:
            data = generate_all_plans()
        return {"kind": "plan", "type": plan_type, "data": data}
    if action == "ppt":
        plan_type = str(args.get("type", "company"))
        department = str(args.get("department") or "").strip()
        filename = str(args.get("fileName") or "鲲鹭科技三一规划.pptx")
        data = generate_department_ppt(department) if plan_type == "department" else generate_company_ppt()
        target = output / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return {"kind": "ppt", "type": plan_type, "department": department or None, "fileName": filename, "sizeBytes": len(data)}
    raise ValueError(f"未知经营规划操作: {action}")


def main() -> int:
    request_path = Path(sys.argv[1])
    request = json.loads(request_path.read_text(encoding="utf-8"))
    output = Path(request.get("output") or request_path.parent)
    output.mkdir(parents=True, exist_ok=True)
    try:
        result = dispatch(request, output)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:  # the adapter turns this into a failed tool receipt
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
