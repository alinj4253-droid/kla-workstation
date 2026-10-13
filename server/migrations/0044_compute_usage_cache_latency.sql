-- 用量明细补采上游缓存 token 与耗时口径
-- compute_usage 此前只落 input/output tokens 与本地失败时延；成功记录的耗时与缓存
-- 来自 Sub2API 计费明细（cache_creation_tokens / cache_read_tokens / duration_ms），补列透传。

ALTER TABLE compute_usage
  ADD COLUMN IF NOT EXISTS cache_creation_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_read_tokens bigint NOT NULL DEFAULT 0;
