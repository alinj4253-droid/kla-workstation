import { z } from 'zod';

export const DEFAULT_AGENT_MODEL_ID = 'zhipu/glm-5.3-flash';
export const DEFAULT_AGENT_MODEL_NAME = 'GLM 5.3 Flash';

export const executionLocationSchema = z.enum(['server', 'local']);
export type ExecutionLocation = z.infer<typeof executionLocationSchema>;
export const agentDefinitionInputSchema = z.object({
  name: z.string().trim().min(1).max(80), role: z.string().trim().min(1).max(8000),
  modelId: z.string().max(200).nullable().optional(), executionLocation: executionLocationSchema.default('server'),
  modelKeyId: z.string().uuid().nullable().optional(),
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
  { code: 'knowledge_ocr', name: 'PDF OCR', description: '识别当前身份成果中的 PDF 文本', location: 'server' },
  { code: 'web_search', name: '博查网页搜索', description: '检索公开网页并返回标题、链接和摘要', location: 'server' },
  { code: 'memory_recall', name: '短期记忆使用', description: '使用本群聊、本智能体的短期记忆；长期记忆暂不应用', location: 'server' },
  { code: 'artifact_write', name: '成果文件保存', description: '保存真实文件并返回可预览、下载的成果编号', location: 'server' },
  { code: 'artifact_compose', name: '成果文件合并', description: '按顺序合并当前群聊的文本成果，无需将全部正文重新放进模型回复', location: 'server' },
  { code: 'artifact_read', name: '成果文件读取', description: '读取当前身份的既有成果继续协作', location: 'server' },
  { code: 'file_read', name: '群聊附件读取', description: '按文件编号读取当前群聊上传的文本附件；二进制返回元数据', location: 'server' },
  { code: 'local_file_fetch', name: '共享文件下载', description: '将当前群聊的附件或成果按编号下载到本机任务 input，返回本机路径供后续本地工具使用', location: 'local' },
  { code: 'local_file_publish', name: '本地成果发布', description: '将用户批准的本地文件作为群聊成果上传，供其他设备按成果编号取用；CLI 生成的文件需显式发布', location: 'local' },
  { code: 'local_read', name: '本地 read', description: '读取设备上当前系统用户可访问的文件', location: 'local' },
  { code: 'local_list', name: '本地目录查看', description: '列出本地目录中的文件', location: 'local' },
  { code: 'local_write', name: '本地 write', description: '写入文件，默认保存至任务临时目录并回传成果副本', location: 'local' },
  { code: 'local_code', name: '代码编写', description: '保存代码文件并回传可交付副本', location: 'local' },
  { code: 'local_bat', name: '本地 BAT 执行', description: '以当前系统用户权限执行 BAT，支持超时和取消', location: 'local' },
  { code: 'local_cli', name: '本地 CLI 执行', description: '运行本地命令行程序及参数，支持超时和取消', location: 'local' },
  { code: 'local_ppt_doctor', name: 'PPT 环境检查', description: '检查本地 Python、PPT 生成依赖、中文字体和真实渲染器，返回 full/partial/blocked', location: 'local' },
  { code: 'local_ppt_build', name: 'PPT 生成与质检', description: '将语义页面 JSON 编译成可编辑 PPTX，强制校验和质检，默认真实渲染 PDF 和缩略图并回传成果。仅在用户确认大纲后调用', location: 'local' },
  { code: 'local_ppt_inspect', name: 'PPT 内容读取', description: '读取本地 PPTX 的页数、文本、表格和备注，用于材料分析和改稿', location: 'local' },
  { code: 'local_ppt_render', name: 'PPT 真实渲染', description: '将本地 PPTX 经过结构质检后真实渲染成 PDF 和缩略图，不覆盖原文件', location: 'local' },
  { code: 'local_route_matrix', name: '路线距离矩阵', description: '调用高德 Web 服务批量计算点位间行车距离/时间矩阵（缺失段按 Haversine 估算），或逐段拉取过路费矩阵', location: 'local' },
  { code: 'local_route_optimize', name: '路线顺序优化', description: '固定起终点 TSP 优化：多初始解+2-opt+Or-opt+节点交换+ILS，支持里程/时间/成本三种策略；矩阵缺省时自动调用高德获取；优化不劣于原始顺序', location: 'local' },
  { code: 'local_route_replan', name: '线路拆分重排', description: '把一组点位重新拆分为多条线路：均衡分配或 K-means 聚类+边界交换，再逐线最近邻+2-opt 排序并汇总里程', location: 'local' },
  { code: 'local_route_map', name: '路线对比地图', description: '生成优化前后路线对比的 HTML 地图（高德 JS API，单窗/双窗切换、双窗联动），作为成果文件交付', location: 'local' },
] as const;
export type RuntimeSkillCode = typeof runtimeSkillCatalog[number]['code'];
export const runtimeSkillBundles = [
  { code: 'knowledge_research', name: '知识资料处理', description: '检索并读取当前身份已授权的知识内容，识别 PDF 成果', tools: ['knowledge_search', 'knowledge_read', 'knowledge_ocr'] },
  { code: 'web_research', name: '网页资料检索', description: '通过博查检索公开网页', tools: ['web_search'] },
  { code: 'memory_context', name: '短期记忆', description: '读取当前群聊和智能体的短期记忆', tools: ['memory_recall'] },
  { code: 'artifact_management', name: '成果管理', description: '读取附件和保存群聊成果文件', tools: ['artifact_read', 'artifact_write', 'artifact_compose', 'file_read'] },
  { code: 'local_files', name: '本地文件处理', description: '查看、读取、下载共享文件、写入文件并发布群聊成果', tools: ['local_list', 'local_read', 'local_write', 'local_file_fetch', 'local_file_publish'] },
  { code: 'local_development', name: '本地代码开发', description: '编写代码并执行本地命令', tools: ['local_code', 'local_cli', 'local_bat'] },
  { code: 'ppt_assistant', name: 'PPT 制作与改稿', description: 'deck-agent-kit 1.0：环境检查 → 材料读取 → 大纲确认 → 语义编译 → 质量门禁 → 真实渲染 → 成果交付；本地执行', tools: ['local_ppt_doctor', 'local_ppt_build', 'local_ppt_inspect', 'local_ppt_render'] },
  { code: 'route_planning', name: '路线规划', description: 'route-agent-kit 1.0：高德距离/时间/过路费矩阵 → 固定起终点 TSP 优化（里程/时间/成本三策略）→ 多线路拆分重排 → 优化前后地图对比；本地执行', tools: ['local_route_matrix', 'local_route_optimize', 'local_route_replan', 'local_route_map'] },
] as const satisfies ReadonlyArray<{ code: string; name: string; description: string; tools: readonly RuntimeSkillCode[] }>;
export type RuntimeSkillBundleCode = typeof runtimeSkillBundles[number]['code'];
export const toolArguments = {
  knowledge_search: z.object({ query: z.string().min(1), topK: z.number().int().min(1).max(20).default(5) }),
  knowledge_read: z.object({ knowledgeBaseId: z.string().uuid(), docId: z.union([z.string(), z.number()]), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(20) }),
  knowledge_ocr: z.object({ artifactId: z.string().uuid(), maxPages: z.number().int().min(1).max(20).default(5) }),
  web_search: z.object({ query: z.string().trim().min(1).max(1000), count: z.number().int().min(1).max(20).default(5), freshness: z.string().max(50).default('noLimit'), include: z.array(z.string().min(1)).max(20).optional(), exclude: z.array(z.string().min(1)).max(20).optional() }),
  memory_recall: z.object({ query: z.string().min(1) }),
  artifact_write: z.object({ fileName: z.string().min(1).max(255).refine(s => !/[\\/]/.test(s), '仅使用文件名'), content: z.string().max(1_000_000), mimeType: z.string().max(100).default('text/plain') }),
  artifact_compose: z.object({ fileName: z.string().min(1).max(255).refine(s => !/[\\/]/.test(s), '仅使用文件名'), artifactIds: z.array(z.string().uuid()).min(1).max(32), prefix: z.string().max(100_000).default(''), separator: z.string().max(10_000).default('\n'), suffix: z.string().max(100_000).default(''), mimeType: z.string().max(100).default('text/plain') }),
  artifact_read: z.object({ artifactId: z.string().uuid() }),
  file_read: z.object({ fileId: z.string().uuid(), offset: z.number().int().min(0).default(0), maxChars: z.number().int().min(1).max(100000).default(20000) }),
  local_file_fetch: z.object({ fileId: z.string().uuid().optional(), artifactId: z.string().uuid().optional() }).refine(input => Boolean(input.fileId) !== Boolean(input.artifactId), '选择 fileId 或 artifactId 之一'),
  local_file_publish: z.object({ path: z.string().min(1), fileName: z.string().min(1).max(255).optional() }),
  local_read: z.object({ path: z.string().min(1), offset: z.number().int().min(0).default(0), maxChars: z.number().int().min(1).max(100000).default(20000) }),
  local_list: z.object({ path: z.string().min(1) }),
  local_write: z.object({ fileName: z.string().min(1).max(255), content: z.string().max(1_000_000), path: z.string().optional() }),
  local_code: z.object({ fileName: z.string().min(1).max(255), content: z.string().max(1_000_000), path: z.string().optional() }),
  local_bat: z.object({ script: z.string().min(1).max(100000), cwd: z.string().optional(), timeoutMs: z.number().int().min(1000).max(300000).default(60000) }),
  local_cli: z.object({ executable: z.string().min(1), args: z.array(z.string()).max(100).default([]), cwd: z.string().optional(), timeoutMs: z.number().int().min(1000).max(300000).default(60000) }),
  local_ppt_doctor: z.object({}),
  local_ppt_build: z.object({ specJson: z.string().min(2).max(1_000_000), fileName: z.string().min(1).max(200).regex(/^[^\\/:*?"<>|\x00-\x1f]+\.pptx$/i).default('演示文稿.pptx'), render: z.boolean().default(true) }),
  local_ppt_inspect: z.object({ path: z.string().min(1).optional(), documentId: z.string().min(1).max(500).optional() }).refine(a => Boolean(a.path) !== Boolean(a.documentId), '选择 path 或 documentId 之一'),
  local_ppt_render: z.object({ path: z.string().min(1).optional(), documentId: z.string().min(1).max(500).optional() }).refine(a => Boolean(a.path) !== Boolean(a.documentId), '选择 path 或 documentId 之一'),
  local_route_matrix: z.object({
    points: z.array(z.object({ name: z.string().max(100).optional(), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })).min(2).max(200),
    coordSystem: z.enum(['gcj02', 'wgs84']).default('gcj02'),
    kind: z.enum(['distance', 'toll']).default('distance'),
  }),
  local_route_optimize: z.object({
    routeName: z.string().min(1).max(200).default('未命名线路'),
    points: z.array(z.object({ name: z.string().max(100).optional(), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })).min(2).max(200),
    coordSystem: z.enum(['gcj02', 'wgs84']).default('gcj02'),
    strategy: z.enum(['mileage', 'time', 'cost']).default('mileage'),
    distanceMatrix: z.array(z.array(z.number())).optional(),
    timeMatrix: z.array(z.array(z.number())).optional(),
    tollMatrix: z.array(z.array(z.number())).optional(),
  }),
  local_route_replan: z.object({
    points: z.array(z.object({ name: z.string().max(100).optional(), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })).min(2).max(300),
    numRoutes: z.number().int().min(2).max(10),
    algorithm: z.enum(['balanced', 'kmeans']).default('balanced'),
    coordSystem: z.enum(['gcj02', 'wgs84']).default('gcj02'),
  }),
  local_route_map: z.object({
    routeName: z.string().min(1).max(200).default('路线对比'),
    points: z.array(z.object({ name: z.string().max(100).optional(), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })).min(2).max(200),
    coordSystem: z.enum(['gcj02', 'wgs84']).default('gcj02'),
    optimizedOrder: z.array(z.number().int().min(0)).min(2).max(200),
    originalOrder: z.array(z.number().int().min(0)).max(200).optional(),
    strategy: z.string().max(20).optional(),
    distanceKm: z.number().optional(),
    savedPercent: z.number().optional(),
  }),
};
export const localToolCodes = runtimeSkillCatalog.filter(tool => tool.location === 'local').map(tool => tool.code);
export const deviceRegistrationSchema = z.object({ installationId: z.string().uuid(), name: z.string().min(1).max(100), platform: z.string().max(50), capabilities: z.array(z.string().refine(code => localToolCodes.includes(code as typeof localToolCodes[number]))).max(localToolCodes.length) });
export const localArtifactSchema = z.object({
  fileName: z.string().min(1).max(255).refine(s => !/[\\/\x00-\x1f]/.test(s)),
  content: z.string().max(24_000_000), contentEncoding: z.enum(['utf8', 'base64']).default('utf8'),
  mimeType: z.string().max(100).default('text/plain'), checksum: z.string().regex(/^[a-f0-9]{64}$/),
});
export const toolReceiptSchema = z.object({
  receiptId: z.string().uuid(), status: z.enum(['completed','failed']), result: z.record(z.unknown()),
  approval: z.object({ approved: z.boolean(), decidedAt: z.string().datetime() }),
  artifact: localArtifactSchema.optional(),
  artifacts: z.array(localArtifactSchema).max(6).optional(),
});
