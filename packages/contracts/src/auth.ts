import { z } from 'zod';
import { identityDtoSchema, sessionDtoSchema, userDtoSchema } from './user.js';

export const emailSchema = z.string().email();
export const phoneSchema = z.string().min(5).max(32);
export const passwordSchema = z.string().min(8).max(72);
export const nicknameSchema = z.string().min(1).max(50);

export const registerRequestSchema = z
  .object({
    email: emailSchema.optional(),
    phone: phoneSchema.optional(),
    password: passwordSchema,
    nickname: nicknameSchema,
  })
  .refine((value) => Boolean(value.email ?? value.phone), {
    message: 'email 与 phone 至少提供一个',
    path: ['email'],
  });

export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  identifier: z.string().min(1),
  password: z.string().min(1),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});

export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const authSessionSchema = z.object({
  user: userDtoSchema,
  identity: identityDtoSchema,
  session: sessionDtoSchema,
});

export type AuthSession = z.infer<typeof authSessionSchema>;

export const registerResponseSchema = authSessionSchema;
export const loginResponseSchema = authSessionSchema;
export const refreshResponseSchema = sessionDtoSchema;
export const sessionsListResponseSchema = z.array(sessionDtoSchema);
