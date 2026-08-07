---
name: graph-projection
description: 将本地图谱投影为固定的交互式 HTML 报告与 JSON 数据；知识管理智能体在知识处理完成、用户预览图谱或需要刷新图谱成果时使用。
---

# 图谱投影

## 固定输出

1. 从当前群聊或共享知识范围读取全部有效节点、关系及来源文件。
2. 将节点类型映射为分类，把摘要、关系数量和置信度映射为节点详情。
3. 将关系类型映射为可读标签，并根据置信度设置关系权重。
4. 输出 `graph-visualization/knowledge-graph.json`、`knowledge-graph.html` 和同目录的离线交互运行库。

## 模板约束

- `assets/knowledge-graph.template.html` 是官方固定模板，布局、视觉和交互以“擎洲光电审计报告知识图谱”为基准。
- 生成时只能注入官方固定的 ECharts 运行库并替换唯一的 `__KUNQING_GRAPH_DATA__` 数据占位符，不得让模型重写 HTML、CSS 或 JavaScript。
- 分类筛选、力导向布局、缩放、拖拽、节点聚焦、节点与关系详情必须保持可用。
- `assets/echarts.min.js` 必须内嵌到成果，同时在成果目录保留副本，确保应用内 `srcDoc`、系统浏览器、私有化部署和无网络环境都能直接预览。
- 后续模板升级只能通过官方资源版本更新，不能把一次任务的业务内容写回模板。
