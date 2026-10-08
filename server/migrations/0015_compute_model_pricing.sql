-- 0011: 模型广场费率与可用分组（B 组 §7.3）
-- 官方模型目录主体沿用 models 表（0006 已含 base_url / is_official / capabilities），
-- 费率与 Sub2API 可用分组由同步器写入本表，避免改动其他组共用的 models 表结构。
CREATE TABLE IF NOT EXISTS compute_model_pricing (
  model_id text PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
  input_price_per_mtok_usd numeric(20,8),
  output_price_per_mtok_usd numeric(20,8),
  available_groups jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);