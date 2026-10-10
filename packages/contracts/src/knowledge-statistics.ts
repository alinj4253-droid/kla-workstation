import { z } from 'zod';
export const knowledgeStatisticsSchema = z.object({
  collections: z.array(z.object({ collection: z.string(), fileCount: z.number().int().nonnegative(), chunkCount: z.number().int().nonnegative(), sourceNames: z.array(z.string()) })),
  unclassifiedCount: z.number().int().nonnegative(),
});
export type KnowledgeStatistics = z.infer<typeof knowledgeStatisticsSchema>;
