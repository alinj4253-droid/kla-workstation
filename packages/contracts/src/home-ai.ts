import { z } from 'zod';

export const homeAiStageSchema = z.enum(['needs','marketing','design','quote','review','order','split','schedule','production','quality','logistics','install','service','behavior','economic']);
export const homeAiAnswerSchema = z.enum(['role','mission','handoff','workflow','capability','kpi','idea','success','constraints','materials']);
export const homeAiCheckSchema = z.enum(['data','rules','review','access','evidence']);
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
  home_ai_interview_update: z.object({ ...revision, answerId: homeAiAnswerSchema, answer: z.string().trim().min(1).max(10000) }).strict(),
  home_ai_opportunity_discover: z.object(session).strict(),
  home_ai_conditions_update: z.object({ ...revision, stageId: homeAiStageSchema,
    checks: z.record(homeAiCheckSchema, z.enum(['yes','no','unknown'])).default({}),
    notes: z.record(homeAiCheckSchema, z.string().max(10000)).default({}),
    reportEdits: homeAiReportEditsSchema.optional(),
  }).strict(),
  home_ai_value_estimate: z.object({ ...revision, stageId: homeAiStageSchema, numbers: homeAiNumbersSchema,
    source: z.enum(['estimate','measured']).optional(), targetHours: numeric.optional(),
  }).strict(),
  home_ai_report_build: z.object({ ...session, stageId: homeAiStageSchema }).strict(),
  home_ai_materials_add: z.object({ ...revision, fileId: z.string().uuid() }).strict(),
};
export type HomeAiToolCode = keyof typeof homeAiToolArguments;
// Confirmation is a human HTTP action, deliberately absent from the model tool catalog.
export const homeAiConfirmationSchema = z.object({ expectedRevision: z.number().int().nonnegative(),
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
export const homeAiInstallResponseSchema = z.object({ agentId: z.string().uuid(), installed: z.boolean() });
