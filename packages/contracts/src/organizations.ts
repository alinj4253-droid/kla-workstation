import { z } from 'zod';
import { emailSchema, phoneSchema } from './auth.js';

export const organizationStatusSchema = z.enum(['active', 'suspended', 'disabled']);

export type OrganizationStatus = z.infer<typeof organizationStatusSchema>;

export const organizationDtoSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  shortName: z.string().nullable(),
  businessLicenseNo: z.string(),
  status: organizationStatusSchema,
  ownerIdentityId: z.string().min(1),
});

export type OrganizationDto = z.infer<typeof organizationDtoSchema>;

export const createOrganizationRequestSchema = z.object({
  name: z.string().min(2).max(100),
  shortName: z.string().min(1).max(30).optional(),
  businessLicenseNo: z.string().min(1).max(64),
});

export type CreateOrganizationRequest = z.infer<typeof createOrganizationRequestSchema>;

export const roleDtoSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  key: z.string().min(1),
  name: z.string(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
  status: organizationStatusSchema,
});

export type RoleDto = z.infer<typeof roleDtoSchema>;

export const membershipStatusSchema = z.enum(['pending', 'active', 'suspended', 'removed']);

export type MembershipStatus = z.infer<typeof membershipStatusSchema>;

export const membershipDtoSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  userId: z.string().min(1),
  identityId: z.string().min(1),
  roleKeys: z.array(z.string().min(1)),
  status: membershipStatusSchema,
  joinedAt: z.string().datetime().nullable(),
});

export type MembershipDto = z.infer<typeof membershipDtoSchema>;

export const createInvitationRequestSchema = z
  .object({
    inviteeEmail: emailSchema.optional(),
    inviteePhone: phoneSchema.optional(),
    roleKey: z.string().min(1),
  })
  .refine((value) => Boolean(value.inviteeEmail ?? value.inviteePhone), {
    message: 'inviteeEmail 与 inviteePhone 至少提供一个',
    path: ['inviteeEmail'],
  });

export type CreateInvitationRequest = z.infer<typeof createInvitationRequestSchema>;

export const invitationStatusSchema = z.enum(['pending', 'accepted', 'revoked', 'expired']);

export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

export const invitationDtoSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  roleKey: z.string().min(1),
  status: invitationStatusSchema,
  expiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export type InvitationDto = z.infer<typeof invitationDtoSchema>;

export const acceptInvitationRequestSchema = z.object({
  token: z.string().min(1),
});

export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>;
