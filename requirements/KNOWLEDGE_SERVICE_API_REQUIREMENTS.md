# 知识服务 API 补充需求

## 1. 现有 4090 服务映射

KLA 服务端代理以下内部服务：Whisper `POST /asr`、BGE-M3 `POST /v1/embeddings`、PaddleOCR-VL `POST /v1/chat/completions`、知识服务 `GET /health`、`POST /v1/slice`、`/v1/ocr`、`/v1/ingest`、`/v1/search`、`/v1/polish`、`/v1/polish/file`。前端不得直接访问 `183.232.248.74` 或 Qdrant。

## 2. KLA 业务 API

基础路径 `/api/v1`，全部接口从 session/JWT 获取当前身份。

### 知识库

- `GET /knowledge-bases?scopeType=&projectId=`：返回当前身份可访问的知识库及统计。
- `POST /knowledge-bases`：创建知识库。请求 `{name,description,scopeType,projectId}`；服务端校验企业/项目/个人权限。
- `GET /knowledge-bases/:id`：详情与权限摘要。
- `PATCH /knowledge-bases/:id`：修改名称、说明。
- `DELETE /knowledge-bases/:id`：软删除，存在处理任务时拒绝或先取消。

### 原始文件

- `POST /knowledge-bases/:id/sources`：multipart `files[]`，返回 source 和 job 列表，支持幂等 hash。
- `GET /knowledge-bases/:id/sources?page=&pageSize=&status=&q=`：分页列表。
- `GET /knowledge-sources/:sourceId`：文件元数据、版本和处理状态。
- `GET /knowledge-sources/:sourceId/preview`：返回短期签名 URL 或标准化 HTML。
- `DELETE /knowledge-sources/:sourceId`：删除文件、切片和索引引用。

### 切片与处理

- `GET /knowledge-bases/:id/chunks?page=&pageSize=&sourceId=&q=`：分页返回 `title/content/page/section/startOffset/endOffset/status`。
- `GET /knowledge-chunks/:chunkId`：返回完整切片正文和来源定位。
- `POST /knowledge-bases/:id/process`：启动待处理文件；返回 job IDs。
- `GET /knowledge-jobs/:jobId`：返回 `status/progress/stage/errorMessage`。
- `POST /knowledge-jobs/:jobId/retry`：仅 failed 任务可重试。
- `POST /knowledge-jobs/:jobId/cancel`：取消尚未完成任务。

### 检索与全文读取

`POST /knowledge/search` 请求 `{query,knowledgeBaseIds[],mode,topK}`，服务端过滤 ready 状态后代理 8120 `/v1/search`。`POST /knowledge/read` 请求 `{sourceId,offset?,page?,section?,maxChars?}`，用于完整文件按段/页读取，返回连续正文和定位信息。

## 3. 统一响应与错误码

成功响应 `{data,requestId}`；失败响应 `{error:{code,message,requestId}}`。建议错误码：`KB_NOT_FOUND`、`KB_FORBIDDEN`、`SOURCE_UNSUPPORTED`、`SOURCE_DUPLICATE`、`JOB_NOT_READY`、`JOB_FAILED`、`PREVIEW_EXPIRED`、`SEARCH_UNAVAILABLE`。

## 4. 异步与安全

默认轮询任务状态；可选 `GET /knowledge-jobs/:id/events` SSE。所有上传限制大小、MIME 和扩展名双重校验，文件名做安全清洗，预览 URL 短期有效。`X-API-Key` 仅由服务端注入给知识服务，客户端不可见。

## 5. 兼容和幂等

上传以 `identityId + knowledgeBaseId + sha256` 幂等；重复上传返回既有 source。远程 ingest 使用 collection 映射表，失败重试不得产生重复 collection point。所有接口支持 `Idempotency-Key`。

## 6. 后续扩展

支持版本回滚、知识库导出、访问审计、按页全文读取、视频关键帧 OCR、细粒度成员授权和检索引用反馈。
