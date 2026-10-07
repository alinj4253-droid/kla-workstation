import { z } from 'zod';

/** 成果文件：GET /artifacts/{id}、GET /conversations/{id}/artifacts。 */
export const artifactSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().nullable(),
  name: z.string(),
  mimeType: z.string(),
  content: z.string(),
  sizeBytes: z.number().int(),
  createdAt: z.string().datetime(),
});

export type Artifact = z.infer<typeof artifactSchema>;
