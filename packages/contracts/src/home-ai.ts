import { z } from 'zod';
import { cnAlias } from './cn-alias.js';

// 原始 enum 供输出 schema 与 record 键使用（服务端产出恒为英文，无需容错）
export const homeAiStageSchema = z.enum(['needs','marketing','design','quote','review','order','split','schedule','production','quality','logistics','install','service','behavior','economic']);
// 模型入参变体：中文容错（精确优先+包含兜底），防「报价」「拆单」这类中文导致续跑失败
const homeAiStageArgSchema = z.preprocess(cnAlias({
  '需求': 'needs', '营销': 'marketing', '获客': 'marketing', '设计': 'design',
  '报价': 'quote', '预算': 'quote', '核价': 'quote', '评审': 'review', '审单': 'review', '审核': 'review',
  '订单': 'order', '下单': 'order', '拆单': 'split', '拆分': 'split', '排产': 'schedule', '排程': 'schedule',
  '生产': 'production', '制造': 'production', '质量': 'quality', '质检': 'quality', '物流': 'logistics',
  '运输': 'logistics', '安装': 'install', '售后': 'service', '维保': 'service', '行为': 'behavior',
  '经济': 'economic', '效益': 'economic',
}), homeAiStageSchema);
// 原始 answerId enum：供 homeAiSessionViewSchema 的 record 键与 nextQuestion.id 使用
export const homeAiAnswerSchema = z.enum(['role','mission','handoff','workflow','capability','kpi','idea','success','constraints','materials']);
// 模型入参变体：中文容错，防「职责」「指标」这类中文
const homeAiAnswerArgSchema = z.preprocess(cnAlias({
  '角色': 'role', '职责': 'role', '使命': 'mission', '初心': 'mission', '愿景': 'mission',
  '交接': 'handoff', '流程': 'workflow', '工作流': 'workflow', '能力': 'capability', '技能水平': 'capability',
  '指标': 'kpi', '绩效': 'kpi', '考核': 'kpi', '点子': 'idea', '想法': 'idea',
  '成效': 'success', '效果': 'success', '成功标准': 'success', '约束': 'constraints', '限制': 'constraints',
  '材料': 'materials', '素材': 'materials', '资料': 'materials',
}), homeAiAnswerSchema);
const homeAiCheckSchema = z.enum(['data','rules','review','access','evidence']);
// checks/notes 的键也可能被模型写成中文（「数据」「规则」…），整条 record 先归一化键再校验
const homeAiRecordKeyAlias = cnAlias({
  '数据': 'data', '数据质量': 'data', '规则': 'rules', '规则匹配': 'rules',
  '评审': 'review', '审单': 'review', '复核': 'review', '权限': 'access', '可得性': 'access', '证据': 'evidence', '依据': 'evidence',
});
const homeAiRecordNormalize = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [String(homeAiRecordKeyAlias(k)), val]))
  : v);
const homeAiYesNoUnknown = z.preprocess(cnAlias({
  '是': 'yes', '成立': 'yes', '已确认': 'yes', '有': 'yes',
  '否': 'no', '不成立': 'no', '没有': 'no', '未确认': 'no',
  '未知': 'unknown', '不确定': 'unknown', '不清楚': 'unknown', '待定': 'unknown',
}), z.enum(['yes','no','unknown']));
const homeAiSourceSchema = z.preprocess(cnAlias({
  '估计': 'estimate', '估算': 'estimate', '预估': 'estimate',
  '实测': 'measured', '实际测量': 'measured', '实际': 'measured',
}), z.enum(['estimate','measured']));
const session = { sessionId: z.string().uuid() };
const revision = { ...session, expectedRevision: z.number().int().nonnegative() };
const numeric = z.union([z.number().finite().min(0).max(1e9), z.literal('')]);
export const homeAiNumbersSchema = z.object({
  volume: numeric.optional(), before: numeric.optional(), after: numeric.optional(),
  coverage: z.union([z.number().min(0).max(100), z.literal('')]).optional(), hourly: numeric.optional(),
  cash: z.union([z.number().min(0).max(100), z.literal('')]).optional(), cost: numeric.optional(), setup: numeric.optional(),
}).strict();
export const homeAiReportEditsSchema = z.object(Object.fromEntries(
  ['customTitle','action','goal','conditions','form','route','metric','trial'].map(key => [key, z.string().max(10000).optional()]),
)).strict();
export const homeAiToolArguments = {
  home_ai_session_open: z.object({ sessionId: z.string().uuid().optional() }).strict(),
  home_ai_interview_update: z.object({ ...revision, answerId: homeAiAnswerArgSchema, answer: z.string().trim().min(1).max(10000) }).strict(),
  home_ai_opportunity_discover: z.object(session).strict(),
  home_ai_conditions_update: z.object({ ...revision, stageId: homeAiStageArgSchema,
    checks: z.preprocess(homeAiRecordNormalize, z.record(homeAiCheckSchema, homeAiYesNoUnknown)).default({}),
    notes: z.preprocess(homeAiRecordNormalize, z.record(homeAiCheckSchema, z.string().max(10000))).default({}),
    reportEdits: homeAiReportEditsSchema.optional(),
  }).strict(),
  home_ai_value_estimate: z.object({ ...revision, stageId: homeAiStageArgSchema, numbers: homeAiNumbersSchema,
    source: homeAiSourceSchema.optional(), targetHours: numeric.optional(),
  }).strict(),
  home_ai_report_build: z.object({ ...session, stageId: homeAiStageArgSchema }).strict(),
  home_ai_materials_add: z.object({ ...revision, fileId: z.string().uuid() }).strict(),
};
export type HomeAiToolCode = keyof typeof homeAiToolArguments;
// Confirmation is a human HTTP action, deliberately absent from the model tool catalog.
export const homeAiConfirmationSchema = z.object({ expectedRevision: z.number().int().nonnegative(),
  expectedBindingVersion: z.number().int().nonnegative().optional(),
  kind: z.enum(['profile','report']), stageId: homeAiStageSchema.optional(),
}).strict().refine(input => input.kind !== 'report' || Boolean(input.stageId), '确认报告时必须选择场景');
export const homeAiSessionViewSchema = z.object({
  sessionId: z.string().uuid(), revision: z.number().int().nonnegative(), profileConfirmed: z.boolean(),
  answers: z.record(homeAiAnswerSchema, z.string()),
  candidates: z.array(z.object({ id: homeAiStageSchema, name: z.string(), title: z.string(), match: z.number() })),
  documents: z.array(z.object({ id: z.string(), name: z.string(), chunks: z.number().int().nonnegative() })),
  scenes: z.array(z.object({ stageId: homeAiStageSchema, checks: z.record(z.string()), notes: z.record(z.string()),
    numbers: homeAiNumbersSchema, source: z.enum(['estimate','measured']), grade: z.string(), reason: z.string(),
    accepted: z.boolean(), canConfirm: z.boolean(), markdown: z.string(),
  })), nextQuestion: z.object({ id: homeAiAnswerSchema, text: z.string(), hint: z.string() }).nullable(),
});
export type HomeAiSessionView = z.infer<typeof homeAiSessionViewSchema>;
export const homeAiSessionSummarySchema = z.object({
  sessionId: z.string().uuid(), roleName: z.string().max(60), revision: z.number().int().nonnegative(),
  profileConfirmed: z.boolean(), createdAt: z.string(), updatedAt: z.string(),
}).strict();
export const homeAiCurrentSchema = z.object({
  status: z.enum(['active','empty','selection_required']), bindingVersion: z.number().int().nonnegative(),
  session: homeAiSessionViewSchema.nullable(), sessions: z.array(homeAiSessionSummarySchema),
}).strict();
export type HomeAiCurrent = z.infer<typeof homeAiCurrentSchema>;
export const homeAiCurrentOperationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), expectedBindingVersion: z.number().int().nonnegative(), roleName: z.string().trim().min(1).max(60).optional() }).strict(),
  z.object({ action: z.literal('activate'), expectedBindingVersion: z.number().int().nonnegative(), sessionId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('rename'), expectedBindingVersion: z.number().int().nonnegative(), sessionId: z.string().uuid(), roleName: z.string().trim().min(1).max(60) }).strict(),
]);
export type HomeAiCurrentOperation = z.infer<typeof homeAiCurrentOperationSchema>;
export const homeAiInstallResponseSchema = z.object({ agentId: z.string().uuid(), installed: z.boolean() });
