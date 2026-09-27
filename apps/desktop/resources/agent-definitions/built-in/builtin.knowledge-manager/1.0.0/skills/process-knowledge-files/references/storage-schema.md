# 本地存储契约

- `original-files/`: 原始输入，只由用户文件操作修改。
- `standardized-files/<sourceId>/document.md`: 解析后的规范化完整正文。
- `standardized-files/<sourceId>/manifest.json`: 全文页区间、切片区间、章节和哈希清单。
- `standardized-files/<sourceId>/chunks/`: 与数据库切片对应的 Markdown 中间文件。
- `knowledge/knowledge-index.json`: 文档摘要、关键词和标签索引。
- `knowledge/wiki/`: Wiki 页面及离线索引。
- `graph-visualization/knowledge-graph.json`: 图谱投影数据。
- `graph-visualization/knowledge-graph.html`: 离线图谱可视化。
- SQLite: 切片、向量、图谱、溯源和处理状态的权威数据。

文件身份使用 MD5 作为处理标记，同时保留 SHA-256 版本校验。源文件移出后停用对应来源，保留历史知识记录但禁止检索命中。

`standardized-files/` 不属于原始输入范围，不得被文件同步器再次知识化，也不进入全文、向量、图谱或 Wiki 的普通检索候选集；它只供按文件整文读取和溯源。
