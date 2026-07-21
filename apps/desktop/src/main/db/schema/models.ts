import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const modelProviders = sqliteTable('model_providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  baseUrl: text('base_url'),
  authType: text('auth_type', { enum: ['api-key', 'oauth', 'none'] }).notNull().default('api-key'),
  secretRef: text('secret_ref'),
  configJson: text('config_json'),
  status: text('status', { enum: ['unknown', 'available', 'unavailable', 'error'] }).notNull().default('unknown'),
  lastCheckedAt: text('last_checked_at'),
}, (table) => [
  uniqueIndex('idx_model_providers_name').on(table.name),
]);

export const modelProfiles = sqliteTable('model_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  providerId: text('provider_id').notNull().references(() => modelProviders.id),
  modelId: text('model_id').notNull(),
  modelSlot: text('model_slot', { enum: ['reasoning', 'fast', 'embedding'] }),
  parametersJson: text('parameters_json'),
  declaredCapabilitiesJson: text('declared_capabilities_json'),
  verifiedCapabilitiesJson: text('verified_capabilities_json'),
  capabilityTestedAt: text('capability_tested_at'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
}, (table) => [
  uniqueIndex('idx_model_profiles_name').on(table.name),
  uniqueIndex('idx_model_profiles_provider_model').on(table.providerId, table.modelId),
]);

export const modelSlotBindings = sqliteTable('model_slot_bindings', {
  slot: text('slot', { enum: ['reasoning', 'fast', 'embedding'] }).primaryKey(),
  modelProfileId: text('model_profile_id').notNull().references(() => modelProfiles.id),
  updatedAt: text('updated_at').notNull(),
});
