import { z } from 'zod';

/** Objects which may receive a hand-off or be mentioned at the start of a chat message. */
export const chatSubmitObjectSchema = z.object({
  type: z.enum(['user', 'agent', 'command']),
  id: z.string().min(1),
});
export type ChatSubmitObject = z.infer<typeof chatSubmitObjectSchema>;

export const displayMarkdownBlockSchema = z.object({ type: z.literal('markdown'), content: z.string() });
export const displayImageBlockSchema = z.object({
  type: z.literal('image'), asset_id: z.string().min(1), asset_kind: z.enum(['file', 'artifact']), mime_type: z.string().min(1),
  url: z.string().min(1).optional(), alt: z.string().optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
});
export const displayVideoBlockSchema = z.object({
  type: z.literal('video'), asset_id: z.string().min(1), asset_kind: z.enum(['file', 'artifact']), mime_type: z.string().min(1), url: z.string().min(1).optional(), poster_url: z.string().min(1).optional(), duration_ms: z.number().int().nonnegative().optional(),
});
export const displayAudioBlockSchema = z.object({
  type: z.literal('audio'), asset_id: z.string().min(1), asset_kind: z.enum(['file', 'artifact']), mime_type: z.string().min(1), url: z.string().min(1).optional(), duration_ms: z.number().int().nonnegative().optional(),
});
export const displayFileBlockSchema = z.object({
  type: z.literal('file'), artifact_id: z.string().uuid(), name: z.string().min(1), mime_type: z.string().min(1), size_bytes: z.number().int().nonnegative().optional(), open_mode: z.literal('right_drawer').default('right_drawer'),
});
export const displayBlockSchema = z.discriminatedUnion('type', [displayMarkdownBlockSchema, displayImageBlockSchema, displayVideoBlockSchema, displayAudioBlockSchema, displayFileBlockSchema]);
export type DisplayBlock = z.infer<typeof displayBlockSchema>;

export const resultArtifactSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1), mime_type: z.string().min(1), size_bytes: z.number().int().nonnegative().optional(), sha256: z.string().optional(), is_final: z.boolean().default(true), delivery_mode: z.literal('right_drawer').default('right_drawer'),
});
export const chatDeliverySchema = z.object({
  schema_version: z.literal('1.1'), message_id: z.string().min(1), conversation_id: z.string().min(1), run_id: z.string().min(1).nullable().optional(), step_id: z.string().min(1).nullable().optional(), reply_to_message_id: z.string().min(1).nullable().optional(),
  sender: chatSubmitObjectSchema,
  submit_object: z.array(chatSubmitObjectSchema),
  display_content: z.object({ blocks: z.array(displayBlockSchema).min(1) }),
  result: z.object({ artifacts: z.array(resultArtifactSchema) }).nullable(),
  delivery: z.object({ kind: z.enum(['final', 'handoff', 'status']), audience: z.enum(['user', 'agent', 'both']), idempotencyKey: z.string().min(1) }),
  created_at: z.string().datetime(),
});
export type ChatDeliveryEnvelope = z.infer<typeof chatDeliverySchema>;
