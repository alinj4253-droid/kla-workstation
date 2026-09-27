import { z } from 'zod';

export const rpcSuccessSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    ok: z.literal(true),
    requestId: z.string(),
    data: dataSchema,
  });

export const rpcFailureSchema = z.object({
  ok: z.literal(false),
  requestId: z.string(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.unknown()).optional(),
  }),
});

export const idempotencyKeySchema = z.string().min(1).max(128);

export const byProjectIdSchema = z.object({
  projectId: z.string().min(1).max(64),
});

export const byRunIdSchema = z.object({
  runId: z.string().min(1).max(64),
});

export const byFileIdSchema = z.object({
  fileId: z.string().min(1).max(64),
});

export const byAgentProfileId = z.object({
  agentProfileId: z.string().min(1).max(64),
});

export const byKnowledgeJobId = z.object({
  knowledgeJobId: z.string().min(1).max(64),
});

export const bySecretRef = z.object({
  secretRef: z.string().min(1).max(64),
});

export const httpsUrlSchema = z.string().url().refine((url) => url.startsWith('https://'), {
  message: '只允许 HTTPS 协议',
});

export const globalSearchInputSchema = z.object({
  query: z.string().min(1).max(200),
  scope: z.enum(['all', 'projects', 'messages', 'files', 'knowledge']).optional(),
});

export const versionInfoSchema = z.object({
  version: z.string(),
  electronVersion: z.string(),
  nodeVersion: z.string(),
  platform: z.string(),
});

export const studioWorkspaceStatusSchema = z.object({
  initialized: z.boolean(),
  workspaceId: z.string().optional(),
  schemaVersion: z.number().optional(),
  locked: z.boolean().optional(),
});

export const initializeStudioInputSchema = z.object({
  rootPath: z.string().min(1),
});

export const validateStudioInputSchema = z.object({
  rootPath: z.string().min(1),
});

export const migrateStudioInputSchema = z.object({
  rootPath: z.string().min(1),
  targetVersion: z.number(),
});

export const studioValidationReportSchema = z.object({
  valid: z.boolean(),
  schemaVersion: z.number().optional(),
  errors: z.array(z.string()).optional(),
});

export const studioMigrationResultSchema = z.object({
  success: z.boolean(),
  fromVersion: z.number(),
  toVersion: z.number(),
  migrationsRun: z.array(z.string()),
});

export const projectListInputSchema = z.object({
  status: z.enum(['active', 'reviewing', 'archived']).optional(),
  limit: z.number().int().positive().max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

export const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  summary: z.string().optional(),
  lastActiveAt: z.string(),
  createdAt: z.string(),
});

export const projectDetailSchema = projectSummarySchema.extend({
  leaderInstanceId: z.string().optional(),
  workspaceRelPath: z.string().optional(),
  sharedKnowledgeEnabled: z.boolean(),
  members: z.array(z.object({
    instanceId: z.string(),
    agentName: z.string(),
    role: z.enum(['leader', 'teammate']),
  })).optional(),
});

export const createProjectInputSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  content: z.object({
    schemaVersion: z.literal(1),
    text: z.string(),
    mentions: z.array(z.object({
      target: z.object({
        scope: z.enum(['profile', 'instance']),
        id: z.string(),
      }),
      label: z.string(),
      start: z.number().int().min(0),
      end: z.number().int().min(0),
    })),
    stagedUploadIds: z.array(z.string()),
    replyToMessageId: z.string().optional(),
  }),
  templateId: z.string().optional(),
  requestedAgentProfileIds: z.array(z.string()).max(9),
  customName: z.string().trim().min(1).max(40).optional(),
  autoStart: z.boolean().optional(),
});

export const planHomeRequestInputSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
});

export const renameProjectInputSchema = z.object({
  projectId: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
});

export const draftScopeInputSchema = z.object({
  scope: z.enum(['home', 'project']),
  scopeId: z.string().optional(),
});

export const draftDtoSchema = z.object({
  scope: z.string(),
  scopeId: z.string(),
  contentJson: z.string().nullable(),
  updatedAt: z.string(),
});

export const updateDraftInputSchema = z.object({
  scope: z.enum(['home', 'project']),
  scopeId: z.string().optional(),
  contentJson: z.string(),
});

export const messagePageInputSchema = z.object({
  projectId: z.string().min(1).max(64),
  before: z.string().optional(),
  limit: z.number().int().positive().max(100).optional().default(50),
});

export const messageDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  senderType: z.enum(['user', 'agent', 'system']),
  senderId: z.string(),
  kind: z.enum(['text', 'artifact', 'system']),
  contentJson: z.string(),
  status: z.enum(['sending', 'sent', 'failed']),
  replyToId: z.string().nullable().optional(),
  createdAt: z.string(),
});

export const messagePageSchema = z.object({
  messages: z.array(messageDtoSchema),
  hasMore: z.boolean(),
  nextBefore: z.string().optional(),
});

export const sendMessageInputSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  projectId: z.string().min(1).max(64),
  content: z.object({
    schemaVersion: z.literal(1),
    text: z.string(),
    mentions: z.array(z.object({
      target: z.object({
        scope: z.enum(['profile', 'instance']),
        id: z.string(),
      }),
      label: z.string(),
      start: z.number().int().min(0),
      end: z.number().int().min(0),
    })),
    stagedUploadIds: z.array(z.string()),
    replyToMessageId: z.string().optional(),
  }),
});

export const workspaceListInputSchema = z.object({
  projectId: z.string().min(1).max(64),
  relativePath: z.string().optional(),
  filter: z.enum(['all', 'files', 'directories']).optional(),
  scopeType: z.enum(['project', 'shared']).optional(),
});

export const workspaceEntrySchema = z.object({
  name: z.string(),
  relativePath: z.string(),
  kind: z.enum(['file', 'directory']),
  size: z.number(),
  mimeType: z.string().nullable().optional(),
  modifiedAt: z.string(),
  fileId: z.string().optional(),
  currentVersionId: z.string().optional(),
  sha256: z.string().optional(),
  knowledgeStatus: z.string().optional(),
});

export const createFolderInputSchema = z.object({
  projectId: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  relativePath: z.string().optional(),
  scopeType: z.enum(['project', 'shared']).optional(),
});

export const renameFileInputSchema = z.object({
  projectId: z.string().min(1).max(64),
  relativePath: z.string().min(1),
  name: z.string().min(1).max(255),
  scopeType: z.enum(['project', 'shared']).optional(),
});

export const deleteFilesInputSchema = z.object({
  projectId: z.string().min(1).max(64),
  paths: z.array(z.string().min(1)).min(1).max(100),
  scopeType: z.enum(['project', 'shared']).optional(),
});

export const agentDefinitionSummarySchema = z.object({
  id: z.string(),
  version: z.string(),
  name: z.string(),
  kind: z.enum(['built-in', 'custom']),
  isBuiltin: z.boolean(),
});

export const agentProfileSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  definitionId: z.string(),
  runtimeMode: z.enum(['native-model', 'external-cli']),
  enabled: z.boolean(),
  delegatable: z.boolean(),
});

export const modelProviderDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  baseUrl: z.string().nullable().optional(),
  status: z.string(),
});

export const modelProfileDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  providerId: z.string(),
  modelId: z.string(),
  boundSlots: z.string().nullable().optional(),
  enabled: z.boolean(),
});

export const memoryListInputSchema = z.object({
  projectId: z.string().min(1).max(64),
  agentInstanceId: z.string(),
  scope: z.enum(['short-term', 'long-term']).optional(),
  status: z.enum(['active', 'expired', 'deleted']).optional(),
});

export const memoryRecordDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  agentInstanceId: z.string(),
  scope: z.enum(['short-term', 'long-term']),
  type: z.string(),
  content: z.string(),
  confidence: z.number(),
  status: z.enum(['active', 'expired', 'deleted']),
  expiresAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const channelSummarySchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  status: z.string(),
});

export const notificationDtoSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  body: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  readAt: z.string().nullable().optional(),
  createdAt: z.string(),
});

export const searchResultSchema = z.object({
  type: z.enum(['project', 'message', 'file', 'knowledge']),
  id: z.string(),
  title: z.string(),
  snippet: z.string().optional(),
  scopeId: z.string().optional(),
});
