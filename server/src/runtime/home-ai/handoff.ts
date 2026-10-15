import type { Pool } from 'pg';
import { CHECKS, assessment } from './interview.js';
import { STAGES } from './catalog.js';
import { sceneReport } from './domain.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const numberKeys = ['volume','before','after','coverage','hourly','cash','cost','setup'];
export const withheldDiagnosis = { kind: 'home_ai_handoff', version: 1, sessions: [], references: [],
  hint: '诊断原文仅供诊断智能体与用户查看；需要进一步分析时请委派诊断智能体。' };

/** Construct sharing data from typed enums/numbers, never model-authored prose. */
export async function buildDiagnosticHandoff(pool: Pool, scope: {identityId:string;conversationId:string;stepId:string}) {
  const calls = (await pool.query(`SELECT tool_name,arguments,result FROM runtime_tool_calls
    WHERE step_id=$1 AND status='completed' ORDER BY created_at,id`, [scope.stepId])).rows;
  const ids = [...new Set(calls.flatMap(call => {
    if (!call.tool_name.startsWith('home_ai_')) return [];
    const id = call.result?.sessionId ?? call.arguments?.sessionId;
    return typeof id === 'string' && uuid.test(id) ? [id] : [];
  }))];
  const rows = ids.length ? (await pool.query(`SELECT id,revision,state FROM home_ai_sessions
    WHERE identity_id=$1 AND conversation_id=$2 AND id=ANY($3::uuid[]) ORDER BY created_at,id`,
  [scope.identityId,scope.conversationId,ids])).rows : [];
  const sessions = rows.map(row => ({ sessionId: row.id, revision: row.revision,
    profileConfirmed: row.state.profileConfirmed === true,
    scenes: STAGES.filter(stage => Object.hasOwn(row.state.scenes, stage.id)).map(stage => {
      const a = assessment(structuredClone(row.state),stage.id);
      const r = sceneReport(row.state,stage.id);
      return { stageId: stage.id, grade: ['S','A','B','I','C','D'].includes(r.grade) ? r.grade : 'I',
        accepted: r.accepted === true, canConfirm: r.canConfirm === true,
        checks: Object.fromEntries(CHECKS.map(check => [check.id,
          ['yes','no','unknown'].includes(a.checks[check.id]) ? a.checks[check.id] : 'unknown'])),
        numbers: Object.fromEntries(numberKeys.map(key => [key,
          typeof a.numbers[key] === 'number' && Number.isFinite(a.numbers[key]) ? a.numbers[key] : null])),
        source: a.source === 'measured' ? 'measured' : 'estimate' };
    }) }));
  // References are opaque source identifiers, not document titles or excerpts.
  const references = calls.filter(call => call.tool_name === 'weknora_search').flatMap(call =>
    (Array.isArray(call.result?.items) ? call.result.items : []).flatMap((item: Record<string,unknown>) =>
      typeof item.knowledgeBaseId === 'string' && uuid.test(item.knowledgeBaseId)
        ? [{ knowledgeBaseId: item.knowledgeBaseId,
          ...(typeof item.upstreamId === 'string' && uuid.test(item.upstreamId) ? {upstreamId:item.upstreamId} : {}),
          ...(typeof item.documentId === 'string' && uuid.test(item.documentId) ? {documentId:item.documentId} : {}) }]
        : []));
  return { ...withheldDiagnosis, sessions, references: [...new Map(references.map(ref => [JSON.stringify(ref),ref])).values()] };
}
