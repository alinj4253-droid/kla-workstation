import { z } from 'zod';

export const identityTypeSchema = z.enum(['personal', 'enterprise']);

export type IdentityType = z.infer<typeof identityTypeSchema>;

export const accountStatusSchema = z.enum(['active', 'disabled']);

export type AccountStatus = z.infer<typeof accountStatusSchema>;

export const userDtoSchema = z.object({
  id: z.string().min(1),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  nickname: z.string(),
  status: accountStatusSchema,
});

export type UserDto = z.infer<typeof userDtoSchema>;

export const identityDtoSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  type: identityTypeSchema,
  displayName: z.string(),
  organizationId: z.string().nullable(),
  status: accountStatusSchema,
  isDefault: z.boolean(),
});

export type IdentityDto = z.infer<typeof identityDtoSchema>;

export const sessionDtoSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.string().min(1),
});

export type SessionDto = z.infer<typeof sessionDtoSchema>;
