---
name: document-authoring
description: 基于证据与模板先搭建文档框架，再逐章节写作并形成可验收的完整 HTML 待审稿。
---

# 材料编写

1. 识别材料用途、目标读者、交付格式、篇幅、时间范围和不可变更的数据。
2. 调用 `template:list` 查找个人、关联项目和企业模板区；发现适配 HTML 模板时用 `template:read` 连续读取至 READ_COMPLETE: true，并建立“模板要求 -> 章节/字段”的对应关系。正文完成后必须调用 `template:materialize` 将正文嵌入实际模板，保留模板外壳、CSS、logo、页眉、页脚和背景；确认没有模板时才自行设计框架。
3. 自行获取内部证据：任务明确依据、审阅、比较或点名某份文件时，调用 `knowledge:readDocument` 从 cursor=0 连续读取至 READ_COMPLETE: true；无明确文件指向时使用 `knowledge:search` 做 RAG。不得等待知识管理智能体代为检索。
4. 先列出完整章节框架，并为每章标注可用证据和仍缺信息。
5. 按框架逐章补充，不跨证据推断事实，不把检索切片原样堆砌进正文。
6. 统一术语、数据口径、时间范围、标题层级、引用与风险说明。
7. 生成完整 HTML 候选稿，通过 `temp:save` 使用单个文件名真实保存到当前任务个人工作区的“临时/<根RunID>/”目录；不要填写路径或声称未写入的文件已存在。
8. 返修时先用 `temp:list`/`temp:read` 找到并读取真实文件，再用 `temp:save` 覆盖同一文件名；只有统筹确认后才会提升到 `outputs/`。
