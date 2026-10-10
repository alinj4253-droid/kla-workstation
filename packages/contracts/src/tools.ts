import { z } from 'zod';

// 工具类计费项契约（docs/DESIGN_BOCHA_SEARCH_INTEGRATION.md §6）。
// 搜索结果属于外部内容：服务端只做字段裁剪透传，不注入内容；
// summary 由服务端固定置 true，不对客户端暴露；计费（扣点）发生在服务端 Tool Gateway。

/** 时间过滤：noLimit / oneDay / oneWeek / oneMonth / oneYear 或 YYYY-MM-DD[..YYYY-MM-DD]。 */
export const toolSearchFreshnessSchema = z.union([
  z.enum(['noLimit', 'oneDay', 'oneWeek', 'oneMonth', 'oneYear']),
  z.string().regex(/^\d{4}-\d{2}-\d{2}(\.\.\d{4}-\d{2}-\d{2})?$/, '日期格式应为 YYYY-MM-DD 或 YYYY-MM-DD..YYYY-MM-DD'),
]);

export const toolSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(400),
  freshness: toolSearchFreshnessSchema.optional(),
  /** 结果条数：1..20（服务端默认 5，与旧版口径一致） */
  count: z.number().int().min(1).max(20).optional(),
});
export type ToolSearchRequest = z.infer<typeof toolSearchRequestSchema>;

export const toolSearchResultSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  snippet: z.string(),
  summary: z.string().optional(),
  siteName: z.string().optional(),
  siteIcon: z.string().optional(),
  datePublished: z.string().optional(),
});
export type ToolSearchResult = z.infer<typeof toolSearchResultSchema>;

export const toolSearchResponseSchema = z.object({
  /** 计费项 ID（如 bocha-web-search），客户端据此展示"每次约 N 点" */
  toolId: z.string().min(1),
  items: z.array(toolSearchResultSchema).max(20),
  totalEstimated: z.number().int().min(0).nullable(),
});
export type ToolSearchResponse = z.infer<typeof toolSearchResponseSchema>;
