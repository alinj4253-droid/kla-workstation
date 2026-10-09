import { z } from 'zod';

export const executionLocationSchema = z.enum(['server', 'local']);
export type ExecutionLocation = z.infer<typeof executionLocationSchema>;
export const agentDefinitionInputSchema = z.object({
  name: z.string().trim().min(1).max(80), role: z.string().trim().min(1).max(8000),
  modelId: z.string().max(200).nullable().optional(), executionLocation: executionLocationSchema.default('server'),
  deviceId: z.string().uuid().nullable().optional(), enabled: z.boolean().default(true),
});
export const agentDefinitionPatchSchema = agentDefinitionInputSchema.partial();
export const taskPlanSchema = z.object({ tasks: z.array(z.object({
  title: z.string().min(1).max(200), instruction: z.string().min(1).max(12000),
  agentId: z.string().uuid(), dependsOn: z.array(z.number().int().min(1)).default([]),
})).min(1).max(16) });
export type TaskPlan = z.infer<typeof taskPlanSchema>;
export const runtimeSkillCatalog = [
  { code: 'knowledge_search', name: '知识检索', description: '检索当前身份已授权的知识库', location: 'server' },
  { code: 'knowledge_read', name: '知识全文读取', description: '读取已授权知识文档与切片', location: 'server' },
  { code: 'memory_recall', name: '短期记忆使用', description: '使用本群聊、本智能体的短期记忆；长期记忆暂不应用', location: 'server' },
  { code: 'artifact_write', name: '成果文件保存', description: '保存真实文件并返回可预览、下载的成果编号', location: 'server' },
  { code: 'artifact_read', name: '成果文件读取', description: '读取当前身份的既有成果继续协作', location: 'server' },
  { code: 'local_read', name: '本地 read', description: '读取设备上当前系统用户可访问的文件', location: 'local' },
  { code: 'local_list', name: '本地目录查看', description: '列出本地目录中的文件', location: 'local' },
  { code: 'local_write', name: '本地 write', description: '写入文件，默认保存至任务临时目录并回传成果副本', location: 'local' },
  { code: 'local_code', name: '代码编写', description: '保存代码文件并回传可交付副本', location: 'local' },
  { code: 'local_bat', name: '本地 BAT 执行', description: '以当前系统用户权限执行 BAT，支持超时和取消', location: 'local' },
  { code: 'local_cli', name: '本地 CLI 执行', description: '运行本地命令行程序及参数，支持超时和取消', location: 'local' },
] as const;
export type RuntimeSkillCode = typeof runtimeSkillCatalog[number]['code'];
export const toolArguments = {
  knowledge_search: z.object({ serviceInstanceId: z.string().min(1), query: z.string().min(1), topK: z.number().int().min(1).max(20).default(5) }),
  knowledge_read: z.object({ serviceInstanceId: z.string().min(1), docId: z.union([z.string(), z.number()]), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(20) }),
  memory_recall: z.object({ query: z.string().min(1) }),
  artifact_write: z.object({ fileName: z.string().min(1).max(255).refine(s => !/[\\/]/.test(s), '仅使用文件名'), content: z.string().max(1_000_000), mimeType: z.string().max(100).default('text/plain') }),
  artifact_read: z.object({ artifactId: z.string().uuid() }),
  local_read: z.object({ path: z.string().min(1), offset: z.number().int().min(0).default(0), maxChars: z.number().int().min(1).max(100000).default(20000) }),
  local_list: z.object({ path: z.string().min(1) }),
  local_write: z.object({ fileName: z.string().min(1).max(255), content: z.string().max(1_000_000), path: z.string().optional() }),
  local_code: z.object({ fileName: z.string().min(1).max(255), content: z.string().max(1_000_000), path: z.string().optional() }),
  local_bat: z.object({ script: z.string().min(1).max(100000), cwd: z.string().optional(), timeoutMs: z.number().int().min(1000).max(300000).default(60000) }),
  local_cli: z.object({ executable: z.string().min(1), args: z.array(z.string()).max(100).default([]), cwd: z.string().optional(), timeoutMs: z.number().int().min(1000).max(300000).default(60000) }),
};
export const deviceRegistrationSchema = z.object({ installationId: z.string().uuid(), name: z.string().min(1).max(100), platform: z.string().max(50), capabilities: z.array(z.enum(['local_read','local_list','local_write','local_code','local_bat','local_cli'])).max(6) });
export const toolReceiptSchema = z.object({
  receiptId: z.string().uuid(), status: z.enum(['completed','failed']), result: z.record(z.unknown()),
  artifact: z.object({ fileName: z.string().min(1).max(255).refine(s => !/[\\/]/.test(s)), content: z.string().max(1_000_000), mimeType: z.string().max(100).default('text/plain'), checksum: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
});
