import { z } from 'zod';
import { identityDtoSchema, userDtoSchema } from './user.js';

export const meResponseSchema = z.object({
  user: userDtoSchema,
  identity: identityDtoSchema,
});

export type MeResponse = z.infer<typeof meResponseSchema>;

export const identityIdParamsSchema = z.object({
  identityId: z.string().min(1),
});

export type IdentityIdParams = z.infer<typeof identityIdParamsSchema>;

export const permissionsResponseSchema = z.object({
  identityId: z.string().min(1),
  roles: z.array(z.string().min(1)),
  permissions: z.array(z.string().min(1)),
});

export type PermissionsResponse = z.infer<typeof permissionsResponseSchema>;
