import { z } from 'zod';

/** GET /api/v1/models 返回的模型目录行（当前为数据库原始行 + configured 标记，TODO(M1): 归一为 camelCase）。 */
export const modelCatalogItemSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  provider: z.string(),
  base_url: z.string().nullable(),
  capabilities: z.record(z.unknown()).optional(),
  enabled: z.boolean(),
  is_official: z.boolean(),
  configured: z.boolean(),
});

export type ModelCatalogItem = z.infer<typeof modelCatalogItemSchema>;

/** POST /api/v1/models/{modelId}/test 的结果（测速结果本身以 ok:true 包裹）。 */
export const modelTestResultSchema = z.object({
  success: z.boolean(),
  latencyMs: z.number().optional(),
  reply: z.string().optional(),
  error: z.string().optional(),
});

export type ModelTestResult = z.infer<typeof modelTestResultSchema>;
