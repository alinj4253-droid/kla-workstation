import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { projects } from './projects';

export const agentDefinitions = sqliteTable('agent_definitions', {
  id: text('id').notNull(),
  version: text('version').notNull(),
  kind: text('kind', { enum: ['built-in', 'custom'] }).notNull(),
  manifestRelPath: text('manifest_rel_path').notNull(),
  checksum: text('checksum').notNull(),
  frameworkEntry: text('framework_entry'),
  maxPermissionsJson: text('max_permissions_json'),
  modelRequirementsJson: text('model_requirements_json'),
  isBuiltin: integer('is_builtin', { mode: 'boolean' }).notNull(),
  installedAt: text('installed_at').notNull(),
}, (table) => ({
  pk: uniqueIndex('pk_agent_definitions').on(table.id, table.version),
}));

export const agentProfiles = sqliteTable('agent_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  definitionId: text('definition_id').notNull(),
  definitionVersion: text('definition_version').notNull(),
  runtimeMode: text('runtime_mode', { enum: ['native-model', 'external-cli'] }).notNull(),
  modelProfileId: text('model_profile_id'),
  cliConnectionId: text('cli_connection_id'),
  overridesJson: text('overrides_json'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  delegatable: integer('delegatable', { mode: 'boolean' }).notNull().default(true),
  isSystemDefault: integer('is_system_default', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const cliConnections = sqliteTable('cli_connections', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  adapterType: text('adapter_type').notNull(),
  executablePath: text('executable_path').notNull(),
  argsJson: text('args_json'),
  strategyId: text('strategy_id'),
  detectedVersion: text('detected_version'),
  authMode: text('auth_mode'),
  secretRefsJson: text('secret_refs_json'),
  trustTier: text('trust_tier', { enum: ['full', 'restricted', 'experimental'] }).notNull().default('restricted'),
  status: text('status', { enum: ['unknown', 'compatible', 'incompatible', 'experimental'] }).notNull().default('unknown'),
  capabilitiesJson: text('capabilities_json'),
  lastCheckedAt: text('last_checked_at'),
}, (table) => [
  uniqueIndex('idx_cli_connections_exec').on(table.executablePath, table.strategyId),
]);

export const projectAgentInstances = sqliteTable('project_agent_instances', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  agentProfileId: text('agent_profile_id').notNull(),
  definitionId: text('definition_id'),
  definitionVersion: text('definition_version'),
  role: text('role', { enum: ['leader', 'teammate'] }).notNull(),
  runtimeMode: text('runtime_mode', { enum: ['native-model', 'external-cli'] }).notNull(),
  modelProfileId: text('model_profile_id'),
  cliConnectionId: text('cli_connection_id'),
  identityRelPath: text('identity_rel_path'),
  memoryRelPath: text('memory_rel_path'),
  effectivePermissionsJson: text('effective_permissions_json'),
  ordinal: integer('ordinal').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_project_agent_instances_ordinal').on(table.projectId, table.ordinal),
]);

export const externalAgentSessions = sqliteTable('external_agent_sessions', {
  id: text('id').primaryKey(),
  agentInstanceId: text('agent_instance_id').notNull(),
  cliConnectionId: text('cli_connection_id').notNull(),
  externalSessionId: text('external_session_id').notNull(),
  status: text('status', { enum: ['active', 'idle', 'closed', 'error'] }).notNull().default('active'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const skills = sqliteTable('skills', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  promptMd: text('prompt_md'),
  requiredCapabilitiesJson: text('required_capabilities_json'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  isBuiltin: integer('is_builtin', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_skills_name').on(table.name),
]);

export const agentSkills = sqliteTable('agent_skills', {
  agentDefinitionId: text('agent_definition_id').notNull(),
  agentDefinitionVersion: text('agent_definition_version').notNull(),
  skillId: text('skill_id').notNull().references(() => skills.id),
  ordinal: integer('ordinal').notNull(),
}, (table) => [
  uniqueIndex('idx_agent_skills').on(table.agentDefinitionId, table.agentDefinitionVersion, table.skillId),
]);
