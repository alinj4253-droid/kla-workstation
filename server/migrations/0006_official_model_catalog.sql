-- 0006: 官方模型目录（base_url 与 is_official，upsert 官方渠道）
ALTER TABLE models ADD COLUMN IF NOT EXISTS base_url text;
ALTER TABLE models ADD COLUMN IF NOT EXISTS is_official boolean NOT NULL DEFAULT false;
INSERT INTO models (id, name, provider, base_url, is_official, capabilities) VALUES
  ('deepseek-v4-flash', 'DeepSeek V4 Flash', 'deepseek', 'https://zhenze-huhehaote.cmecloud.cn/v1', true, '{"thinking":false,"streaming":true,"context":128000}'),
  ('deepseek-chat', 'DeepSeek Chat', 'deepseek', 'https://api.deepseek.com/v1', true, '{"thinking":false,"streaming":true,"context":64000}'),
  ('deepseek-reasoner', 'DeepSeek Reasoner', 'deepseek', 'https://api.deepseek.com/v1', true, '{"thinking":true,"streaming":true,"context":64000}'),
  ('zhipu/glm-5.3-flash', 'GLM 5.3 Flash', 'zhipu', 'https://moma.cmecloud.cn/v1', true, '{"vision":true,"thinking":false,"streaming":true,"context":128000}'),
  ('glm-4-air', 'GLM 4 Air', 'zhipu', 'https://open.bigmodel.cn/api/paas/v4', true, '{"thinking":false,"streaming":true,"context":128000}'),
  ('qwen-plus', 'Qwen Plus', 'qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1', true, '{"thinking":true,"streaming":true,"context":128000}'),
  ('qwen-turbo', 'Qwen Turbo', 'qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1', true, '{"thinking":false,"streaming":true,"context":128000}'),
  ('gpt-4o', 'GPT-4o', 'openai', 'https://api.openai.com/v1', true, '{"vision":true,"streaming":true,"context":128000}'),
  ('claude-3-5-sonnet', 'Claude 3.5 Sonnet', 'anthropic', 'https://api.anthropic.com/v1', true, '{"vision":true,"thinking":true,"streaming":true,"context":200000}')
ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, provider=EXCLUDED.provider, base_url=EXCLUDED.base_url, is_official=true, capabilities=EXCLUDED.capabilities;
