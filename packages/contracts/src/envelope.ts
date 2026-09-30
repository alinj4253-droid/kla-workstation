import { z } from 'zod';

export const requestIdMetaSchema = z.object({
  requestId: z.string().min(1),
});

export const apiErrorDetailSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean(),
});

export const apiErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: apiErrorDetailSchema,
  meta: requestIdMetaSchema.optional(),
});

export function apiOkEnvelopeSchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    ok: z.literal(true),
    data,
    meta: requestIdMetaSchema.optional(),
  });
}

export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;

export type ApiOkEnvelope<T> = z.infer<ReturnType<typeof apiOkEnvelopeSchema<z.ZodType<T>>>>;

export type ApiEnvelope<T> = ApiOkEnvelope<T> | ApiErrorEnvelope;

export type ApiResult<T> = ApiEnvelope<T>;

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

export const pageMetaSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  total: z.number().int().min(0),
});

export type PageMeta = z.infer<typeof pageMetaSchema>;

export function pagedDataSchema<T extends z.ZodTypeAny>(items: T) {
  return z.object({
    items: z.array(items),
    page: pageMetaSchema,
  });
}

export type PagedData<T> = {
  items: T[];
  page: PageMeta;
};
