import { z } from 'zod';
import { serviceInputSchema } from './knowledge-api.js';

export const uploadNameCheckSchema = serviceInputSchema.extend({
  collection: z.string().trim().min(1).max(200),
  knowledgeBaseId: z.string().uuid().optional(),
  names: z.array(z.string().min(1).max(255).refine(name => !/[\\/\u0000-\u001f]/.test(name))).min(1).max(200),
});
export const uploadNameCheckResultSchema = z.object({ conflicts: z.array(z.string()) });
export type UploadNameCheck = z.infer<typeof uploadNameCheckSchema>;
export type UploadNameCheckResult = z.infer<typeof uploadNameCheckResultSchema>;

/** Compatibility with the upstream slice stem; never use this to resolve doc IDs. */
export function uploadSliceNameKey(name: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem.endsWith('_后处理') ? stem.slice(0, -4) : stem;
}
