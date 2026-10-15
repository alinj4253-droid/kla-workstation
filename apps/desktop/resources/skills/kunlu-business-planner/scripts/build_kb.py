"""
将 7 份源文档解析为结构化知识库 JSON
源文档目录通过环境变量 KUNLU_SOURCE_DIR 指定，默认取脚本上级目录
输出到 scripts/data/knowledge_base.json 与 metrics.json
"""
import os, json, sys
sys.stdout.reconfigure(encoding='utf-8')
from pptx import Presentation
import openpyxl

BASE = os.environ.get("KUNLU_SOURCE_DIR", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
os.makedirs(OUT_DIR, exist_ok=True)


def pptx_text(path):
    prs = Presentation(path)
    pages = []
    for i, slide in enumerate(prs.slides, 1):
        texts = []
        for shape in slide.shapes:
            if shape.has_text_frame:
                t = shape.text_frame.text.strip()
                if t:
                    texts.append(t)
            if shape.has_table:
                for row in shape.table.rows:
                    texts.append(" | ".join(c.text.strip() for c in row.cells))
        if texts:
            pages.append({"page": i, "text": "\n".join(texts)})
    return pages


def xlsx_sheets(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    sheets = []
    for ws in wb.worksheets:
        rows = []
        for row in ws.iter_rows():
            vals = [{"cell": c.coordinate, "value": c.value} for c in row if c.value is not None]
            if vals:
                rows.append(vals)
        sheets.append({"name": ws.title, "rows": rows})
    return sheets


kb = {"documents": []}

# 1. 2024 规划
kb["documents"].append({
    "id": "plan_2024",
    "type": "annual_plan",
    "year": 2024,
    "title": "2024年鲲鹭物联三一规划",
    "pages": pptx_text(os.path.join(BASE, "2024年鲲鹭物联三一规划.pptx")),
})

# 2. 2025 规划
kb["documents"].append({
    "id": "plan_2025",
    "type": "annual_plan",
    "year": 2025,
    "title": "2025年-鲲鹭物联三一规划",
    "pages": pptx_text(os.path.join(BASE, "2025年-鲲鹭物联三一规划.pptx")),
})

# 3. 垂类大模型方案
kb["documents"].append({
    "id": "plan_llm",
    "type": "solution",
    "title": "鲲擎垂类大模型构建方案",
    "pages": pptx_text(os.path.join(BASE, "垂类大模型构建方案汇报19.pptx")),
})

# 4. 1~6月工作汇报
kb["documents"].append({
    "id": "report_h1_2026",
    "type": "work_report",
    "period": "2026 H1",
    "title": "鲲鹭科技1-6月工作汇报",
    "pages": pptx_text(os.path.join(BASE, "【鲲鹭科技】-1~6月工作汇报7.22.pptx")),
})

# 5. 事业1部业绩
kb["documents"].append({
    "id": "bu1_2026",
    "type": "performance",
    "department": "事业一部",
    "year": 2026,
    "sheets": xlsx_sheets(os.path.join(BASE, "事业1部-26年业绩.xlsx")),
})

# 6. 事业2部业绩
kb["documents"].append({
    "id": "bu2_2026",
    "type": "performance",
    "department": "事业二部",
    "year": 2026,
    "sheets": xlsx_sheets(os.path.join(BASE, "事业2部-26年业绩.xlsx")),
})

# 7. 研究院业绩
kb["documents"].append({
    "id": "ri_2026",
    "type": "performance",
    "department": "研究院",
    "year": 2026,
    "sheets": xlsx_sheets(os.path.join(BASE, "研究院承包-26年业绩.xlsx")),
})

out = os.path.join(OUT_DIR, "knowledge_base.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(kb, f, ensure_ascii=False, indent=2)
print("knowledge base saved:", os.path.getsize(out), "bytes")
